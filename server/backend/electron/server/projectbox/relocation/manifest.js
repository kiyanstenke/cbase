// The relocation's comparer. A pure leaf without imports.
//
// Step 4 measures every volume at the STOPPED source, step 14 the same volume at the target BEFORE the start (a Postgres changes its
// files at once) — both with the same program `cbase-manifest` (server/backend/cbase-manifest, in the backend image under
// /usr/local/bin and thus also in the project container and in every helper it is mounted into). This leaf reads the two outputs
// and says whether they are field-equal. Only an `equal: true` for EVERY volume releases the removal ("nothing is deleted before").
//
// Field-equal means: the same set of paths, and per path the same type, the same permissions (including setuid/setgid/sticky), owner,
// mtime to the nanosecond, the same xattrs (ACLs too, `system.posix_acl_*`) with the same value, for files size, sha256 and
// whether they have holes, for symlinks the target, for devices the numbers, for everything except directories the hardlink group.
// NOT compared are the size and blocks of a directory (they legitimately differ in a proper copy) — the program does not even write
// them, and a manifest that carried them is invalid here.
//
// Two rules, each from a failure of the first version:
//   - Size and count let 9 of 12 deliberate errors through (guard server/backend/test/relocation-manifest.test.js runs all twelve and
//     the counter-proof).
//   - A manifest without a closing line is INCOMPLETE, not empty (empty is not unknown): if the helper died in the middle of the run,
//     the rest would otherwise be "not present". Unknown or missing fields are invalid as well — a field a later version of the program
//     adds must be compared here explicitly, otherwise it would be silent.
//
// The result carries NO values: only paths, kinds and field names (for xattrs `xattr:<name>`). Hashes, permissions, owners and times
// stay in the manifests (files under ~/cbase/data/relocations/…, never mounted); the relocation report names only WHAT differs. The
// list of deviations is capped and says it is (`truncated`, `cap`).
//
// LINE BY LINE. A volume with 1 million entries has a manifest of ≈ 258 MB; read as ONE string and parsed into a map, desired and
// actual together sat at ≈ 1.7 GB heap — an OOM of the whole user backend, and from ≈ 2.08 million entries even `toString` throws at the
// string limit. So there is ONE reader that checks line by line (`reader`/`nextRow`/`closeReader`) and ONE comparison that runs as a
// merge over both manifests (`comparisonCore`) — driven synchronously over text (`readManifest`, `compareManifests`: tests, small
// sets) and asynchronously over streams (`checkManifestStream`, `compareManifestStreams`: the relocation, manifests as files in the
// relocation location). Only the previous path per side and the heads of the hardlink groups stay in memory (residual risk, named: a
// volume whose files are almost all hardlinks holds as many paths as entries).
//   The merge needs the program's order: depth first, per directory by the BYTES of the names (`names` in cbase-manifest).
//   `manifestKey` maps it — the bytes of the path (UTF-8, a surrogate \udcXX as the byte XX, like `surrogateescape`) with "/" as 0x00,
//   compared with Buffer.compare (a prefix comes before its extension, so the directory before its content). So the order is part of
//   validity: a path that does not come AFTER its predecessor is duplicate or moved — invalid. And the hardlink group (`hl`) must point
//   to an EARLIER entry (or itself) that is itself the head of its group (`hl` = own path) — the program writes the group at the
//   first occurrence. The deviations are in this order.
export const MANIFEST_PROGRAM = "/usr/local/bin/cbase-manifest";
export const MANIFEST_VERSION = 1;
export const DEVIATIONS_CAP = 100;

/**
 * The argv with which a helper (or the project container) calls the program: `python3` explicitly — a ro bind does not always carry
 * the execute bit along, and the way through stdin (`python3 - -- <root>`) reads the same arguments.
 */
export function manifestArgv(root) {
  if (typeof root !== "string" || !root.startsWith("/")) throw new TypeError("manifestArgv: root must be an absolute path");
  return ["python3", MANIFEST_PROGRAM, "--", root];
}

const TYPES = ["d", "f", "l", "p", "s", "c", "b"];
// The mandatory fields per type (besides p, type, mode, uid, gid, mtime, xattr). `hl` is mandatory EXACTLY with nlink > 1.
const PER_TYPE = {
  d: [],
  f: ["size", "sha256", "thin", "nlink"],
  l: ["target", "nlink"],
  p: ["nlink"],
  s: ["nlink"],
  c: ["device", "nlink"],
  b: ["device", "nlink"],
};
const COMMON = ["p", "type", "mode", "uid", "gid", "mtime", "xattr"];
// Order of the comparison = order in `fields` of the result; the xattrs come after, by name.
const COMPARISON = ["mode", "uid", "gid", "mtime", "size", "sha256", "thin", "target", "device", "nlink", "hl"];

const HEX64 = /^[0-9a-f]{64}$/;
const nat = (v) => Number.isSafeInteger(v) && v >= 0;
const FORM = {
  p: (v) => typeof v === "string" && validPath(v),
  type: (v) => TYPES.includes(v),
  mode: (v) => typeof v === "string" && /^[0-7]{4}$/.test(v),
  uid: nat,
  gid: nat,
  mtime: (v) => typeof v === "string" && /^-?\d+$/.test(v),
  xattr: (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, w]) => k.length > 0 && typeof w === "string" && HEX64.test(w)),
  size: nat,
  sha256: (v) => typeof v === "string" && HEX64.test(v),
  thin: (v) => typeof v === "boolean",
  target: (v) => typeof v === "string" && HEX64.test(v),
  device: (v) => typeof v === "string" && /^\d+:\d+$/.test(v),
  nlink: (v) => Number.isSafeInteger(v) && v >= 1,
  hl: (v) => typeof v === "string" && validPath(v) && v !== ".",
};

function validPath(p) {
  if (p === ".") return true;
  if (!p || p.includes("\0") || p.startsWith("/")) return false;
  return p.split("/").every((t) => t !== "" && t !== "." && t !== "..");
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKey = (o, ks) => Object.keys(o).length === ks.length && ks.every((k) => Object.hasOwn(o, k));

function invalid(error) {
  return { ok: false, error };
}

/**
 * The sort key of a path in the program's order (header, "LINE BY LINE"): the bytes of the path with "/" as 0x00; the root "." is
 * the empty key. Buffer.compare of two keys orders like cbase-manifest.
 */
export function manifestKey(p) {
  if (p === ".") return Buffer.alloc(0);
  let hasSurrogate = false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c >= 0xdc80 && c <= 0xdcff) { hasSurrogate = true; break; }
  }
  let b;
  if (!hasSurrogate) b = Buffer.from(p, "utf8");
  else {
    const parts = [];
    let run = "";
    for (const ch of p) {
      const c = ch.charCodeAt(0);
      if (ch.length === 1 && c >= 0xdc80 && c <= 0xdcff) {
        if (run) parts.push(Buffer.from(run, "utf8"));
        run = "";
        parts.push(Buffer.from([c - 0xdc00]));
      } else run += ch;
    }
    if (run) parts.push(Buffer.from(run, "utf8"));
    b = Buffer.concat(parts);
  }
  for (let i = 0; i < b.length; i++) if (b[i] === 0x2f) b[i] = 0;
  return b;
}

// ── The reader (ONE check for text and stream) ──────────────────────────────────────────────────────────────────────────

const reader = () => ({ seq: 0, count: 0, end: null, prior: null, headers: new Set(), error: null });

// A line (without line ending) → `{ e, k }` (an entry with its key), `null` (header; read on) or `{ error }`.
function nextRow(l, row) {
  l.seq++;
  const seq = l.seq;
  if (l.end) return { error: `line ${l.end.seq}: not an entry (line ${seq} follows it)` };
  let e;
  try { e = JSON.parse(row); } catch { e = undefined; }
  if (seq === 1) {
    if (!isObject(e) || !sameKey(e, ["cbase-manifest"])) return { error: "line 1: not a cbase-manifest header" };
    if (e["cbase-manifest"] !== MANIFEST_VERSION) return { error: `line 1: version ${JSON.stringify(e["cbase-manifest"])} instead of ${MANIFEST_VERSION}` };
    return null;
  }
  // The closing line: only the end of the stream says whether it really was the last.
  if (isObject(e) && sameKey(e, ["entries", "end"]) && e.end === true) {
    l.end = { seq, entries: e.entries };
    return null;
  }
  if (!isObject(e)) return { error: `line ${seq}: not an entry` };
  if (!FORM.type(e.type)) return { error: `line ${seq}: unknown type` };
  const required = [...COMMON, ...PER_TYPE[e.type]];
  for (const k of required) {
    if (!Object.hasOwn(e, k)) return { error: `line ${seq}: field “${k}” missing` };
    if (!FORM[k](e[k])) return { error: `line ${seq}: field “${k}” has no valid form` };
  }
  const withHl = e.type !== "d" && e.nlink > 1;
  for (const k of Object.keys(e)) {
    if (required.includes(k)) continue;
    if (k === "hl" && withHl) continue;
    return { error: `line ${seq}: field “${k}” does not belong to type ${e.type}` };
  }
  if (seq === 2 && (e.p !== "." || e.type !== "d")) return { error: "line 2: the root “.” (a directory) does not come first" };
  if (seq > 2 && e.p === ".") return { error: `line ${seq}: the root a second time` };
  const k = manifestKey(e.p);
  if (l.prior && Buffer.compare(k, l.prior) <= 0) return { error: `line ${seq}: path twice or not in the program's order` };
  if (withHl) {
    if (!Object.hasOwn(e, "hl")) return { error: `line ${seq}: field “hl” missing (nlink > 1)` };
    if (!FORM.hl(e.hl)) return { error: `line ${seq}: field “hl” has no valid form` };
    if (e.hl === e.p) l.headers.add(e.p);
    else if (!l.headers.has(e.hl)) return { error: `hardlink group of ${JSON.stringify(e.p)} points to no earlier entry` };
  }
  l.prior = k;
  l.count++;
  return { e, k };
}

// The end of the lines → `{ end: true }` or `{ error }`. `open`: the last line had no line ending.
function closeReader(l, { open = false } = {}) {
  if (open || l.seq === 0) return { error: "incomplete: no line ending at the end" };
  if (l.seq < 3) return { error: "incomplete: fewer than header, root and closing line" };
  if (!l.end) return { error: "incomplete: no closing line" };
  if (l.end.entries !== l.count) return { error: `incomplete: closing line names ${l.end.entries} entries, read ${l.count}` };
  return { end: true };
}

// Lines from a text: every call → `{ row, open? }` or null (no more).
function textLines(s) {
  let pos = 0;
  return () => {
    if (pos >= s.length) return null;
    const i = s.indexOf("\n", pos);
    if (i < 0) { const row = s.slice(pos); pos = s.length; return { row, open: true }; }
    const row = s.slice(pos, i);
    pos = i + 1;
    return { row };
  };
}

// Lines from a stream (buffer or text chunks, e.g. fs.createReadStream) — the same contract, asynchronous. Copies each chunk at
// most once (a position instead of repeated slice).
function streamRows(stream) {
  const it = stream[Symbol.asyncIterator]();
  const dec = new TextDecoder("utf-8");
  let buffer = "";
  let pos = 0;
  let finished = false;
  return async () => {
    for (;;) {
      const i = buffer.indexOf("\n", pos);
      if (i >= 0) { const row = buffer.slice(pos, i); pos = i + 1; return { row }; }
      if (finished) {
        if (pos < buffer.length) { const row = buffer.slice(pos); pos = buffer.length; return { row, open: true }; }
        return null;
      }
      const r = await it.next();
      buffer = buffer.slice(pos) + (r.done ? dec.decode() : typeof r.value === "string" ? r.value : dec.decode(r.value, { stream: true }));
      pos = 0;
      if (r.done) finished = true;
    }
  };
}

// A side as a source: every call → `{ e, k }`, `{ end: true }` or `{ error }` (afterwards only the same).
function textSource(x) {
  if (isObject(x) && !Buffer.isBuffer(x) && Object.hasOwn(x, "ok")) {
    // The result of readManifest: already checked, the map in the manifest's order.
    if (x.ok !== true) { const f = { error: x.error || "no manifest" }; return () => f; }
    const values = x.entries.values();
    return () => { const n = values.next(); return n.done ? { end: true } : { e: n.value, k: manifestKey(n.value.p) }; };
  }
  const s = Buffer.isBuffer(x) ? x.toString("utf8") : x;
  if (typeof s !== "string") { const f = { error: "not a text" }; return () => f; }
  const rows = textLines(s);
  const l = reader();
  let last = null;
  return () => {
    if (last) return last;
    for (;;) {
      const z = rows();
      const r = z === null ? closeReader(l) : z.open ? closeReader(l, { open: true }) : nextRow(l, z.row);
      if (r) { if (!r.e) last = r; return r; }
    }
  };
}

function streamSource(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") { const f = { error: "not a stream" }; return async () => f; }
  const rows = streamRows(stream);
  const l = reader();
  let last = null;
  return async () => {
    if (last) return last;
    for (;;) {
      const z = await rows();
      const r = z === null ? closeReader(l) : z.open ? closeReader(l, { open: true }) : nextRow(l, z.row);
      if (r) { if (!r.e) last = r; return r; }
    }
  };
}

/**
 * The output of cbase-manifest → `{ ok: true, version, entries: Map<path, entry> }` or `{ ok: false, error }`. `error` names line and
 * reason, never a value. Holds the whole manifest in memory — for large volumes `checkManifestStream`.
 */
export function readManifest(text) {
  const q = textSource(Buffer.isBuffer(text) || typeof text === "string" ? text : null);
  const entries = new Map();
  for (;;) {
    const r = q();
    if (r.error) return invalid(r.error);
    if (r.end) return { ok: true, version: MANIFEST_VERSION, entries };
    entries.set(r.e.p, r.e);
  }
}

/** Check a manifest as a stream without holding it → `{ ok: true, entries: <number> }` or `{ ok: false, error }`. */
export async function checkManifestStream(stream) {
  const q = streamSource(stream);
  let n = 0;
  for (;;) {
    const r = await q();
    if (r.error) return invalid(r.error);
    if (r.end) return { ok: true, entries: n };
    n++;
  }
}

function differences(a, b) {
  if (a.type !== b.type) return ["type"];
  const fields = [];
  for (const k of COMPARISON) {
    if (a[k] !== b[k]) fields.push(k);
  }
  const value = (o, n) => (Object.hasOwn(o, n) ? o[n] : undefined);
  const names = [...new Set([...Object.keys(a.xattr), ...Object.keys(b.xattr)])].sort();
  for (const n of names) {
    if (value(a.xattr, n) !== value(b.xattr, n)) fields.push(`xattr:${n}`);
  }
  return fields;
}

// The merge (header, "LINE BY LINE") as a generator: `yield "desired"`/`yield "actual"` asks for the next entry of a side
// (`{ e, k }` | `{ end }` | `{ error }`); driven synchronously (text) and asynchronously (streams) — ONE computation.
function* comparisonCore(cap) {
  const errorResult = (page, reason) => ({ equal: false, error: { page, reason }, count: null, deviations: [], truncated: 0, cap });
  const deviations = [];
  let total = 0;
  const remember = (x) => { total++; if (deviations.length < cap) deviations.push(x); };
  const count = { desired: 0, actual: 0, missing: 0, tooMany: 0, deviating: 0 };
  let a = yield "desired";
  let b = yield "actual";
  for (;;) {
    if (a.error) return errorResult("desired", a.error);
    if (b.error) return errorResult("actual", b.error);
    if (a.end && b.end) break;
    const c = a.end ? 1 : b.end ? -1 : Buffer.compare(a.k, b.k);
    if (c === 0) {
      count.desired++;
      count.actual++;
      const fields = differences(a.e, b.e);
      if (fields.length) { count.deviating++; remember({ path: a.e.p, kind: "field", fields }); }
      a = yield "desired";
      b = yield "actual";
    } else if (c < 0) {
      count.desired++;
      count.missing++;
      remember({ path: a.e.p, kind: "missing" });
      a = yield "desired";
    } else {
      count.actual++;
      count.tooMany++;
      remember({ path: b.e.p, kind: "tooMany" });
      b = yield "actual";
    }
  }
  return { equal: total === 0, error: null, count, deviations, truncated: Math.max(0, total - cap), cap };
}

function checkCap(cap) {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new TypeError("compareManifests: cap must be an integer ≥ 1");
}

/**
 * Desired (source, after stopping) against actual ("actual"; target, before the start) — text, buffer or the result of readManifest.
 * → { equal, error, count: { desired, actual, missing, tooMany, deviating }, deviations: [{ path, kind: "missing"|"tooMany"|"field",
 * fields? }], truncated, cap }. `equal` is true only if both manifests are valid and complete and nothing differs. The deviations are
 * in the program's order; the first `cap` are kept.
 */
export function compareManifests(desired, actual, { cap = DEVIATIONS_CAP } = {}) {
  checkCap(cap);
  const sources = { desired: textSource(desired), actual: textSource(actual) };
  const g = comparisonCore(cap);
  let r = g.next();
  while (!r.done) r = g.next(sources[r.value]());
  return r.value;
}

/** The same comparison over two streams (e.g. fs.createReadStream of the two manifest files) — without holding them. */
export async function compareManifestStreams(desired, actual, { cap = DEVIATIONS_CAP } = {}) {
  checkCap(cap);
  const sources = { desired: streamSource(desired), actual: streamSource(actual) };
  const g = comparisonCore(cap);
  let r = g.next();
  while (!r.done) r = g.next(await sources[r.value]());
  return r.value;
}

/** The result as lines for the check log and the report — without values, the cap explicit. */
export function comparisonRows(result, name = "Volume") {
  if (result.error) return [`${name}: no valid manifest (${result.error.page}): ${result.error.reason}`];
  const z = result.count;
  if (result.equal) return [`${name}: field-equal (${z.desired} entries)`];
  const out = [`${name}: DEVIATION — ${z.missing} missing, ${z.tooMany} too many, ${z.deviating} deviating (desired ${z.desired}, actual ${z.actual})`];
  for (const x of result.deviations) {
    out.push(`  ${x.kind === "field" ? "deviating" : x.kind}: ${JSON.stringify(x.path)}${x.fields ? ` (${x.fields.join(", ")})` : ""}`);
  }
  if (result.truncated > 0) out.push(`  … and ${result.truncated} more (cap ${result.cap} lines)`);
  return out;
}
