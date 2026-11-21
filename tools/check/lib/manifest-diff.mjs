// The manifest diff: the proof that moved code is byte-equal to its source.
//
// Why a tool of its own and not `diff`: the split moves line ranges from server.js and store.js into new files, and
// the new files carry a WRAPPER on top — header comment, imports, `export async function xRoutes(ctx) {`,
// `const { req, res, url, p, m } = ctx;`, `return NEXT;`, the closing brace, an `export { … };` line. A `diff` would see
// only differences; here every line must either equal its source, be a deviation named in the manifest, or be wrapper.
// Everything else is a violation — also renaming, reordering, reformatting.
//
// Why a linear run and no LCS: an LCS would wave a reordered or reformatted file through as "mostly equal" and turn the
// violation into a long difference. The linear run demands the source order line by line — exactly what "mechanical"
// means. After an error it resynchronizes only so far that the report can name several places; the verdict (`ok`) is
// fixed with the first error.
//
// Why the source comes from `git show <commit>:<path>` and not from the working tree: the working tree IS the target of
// the move — as soon as the first slice lies there, the moved lines are missing in it. The ranges hold for a committed
// state, and the sha256 of the blob makes every shift visible before a range is adopted blindly.
//
// Why the TARGET can also come from a commit (`targetStatus`): the split is finished and proven. Afterwards the code
// is developed further — and every such line would be a violation for the byte proof although it is intended. A manifest
// maintained with range splits and catch patterns would prove less with every slice. So the manifest carries
// `targetStatus.commit`: the proof holds for the tree of EXACTLY this commit and is read from `git show
// <targetStatus>:<path>` — the working tree may move afterwards. Without `targetStatus` the run reads the working tree
// (the form during the split). The line-count guard, the route guards and the import direction keep running against the
// working tree.
//
// The functions without git (`diffFile`, `areaConflicts`, `gaps`, `manifestOpen`) are pure — the test shows every
// counter-check red without a child process.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Multi-line export block at the end of the file: everything between these two lines is wrapper. A
// single-line `export { a, b };` is already covered by the pattern in the manifest.
const EXPORT_BLOCK_ON = /^export \{$/;
const EXPORT_BLOCK_TO = /^\};$/;
// This many consecutive lines must open the first range for the place to count as the anchor —
// a single `}` line would otherwise already occur in the header comment.
const ANCHOR_WIDTH = 4;
// After this many errors in one file the report is no report anymore, but noise.
const ERROR_CAP = 20;
// What may stand BEFORE the first range (import lines and header comment — nothing else): imports including
// the multi-line brace form, comments, blank lines. Any other line there is foreign code that would pass as "header".
const HEADER_PATTERN = [
  /^import\b/,
  /^export \{[^}]*\} from ["'][^"']+["'];$/, // re-export in the header (stays reachable under server.js)
  /^\} from ["'][^"']+["'];?$/,
  /^\s*[\w$]+(?:\s+as\s+[\w$]+)?(?:\s*,\s*[\w$]+(?:\s+as\s+[\w$]+)?)*\s*,?\s*$/, // names of a brace import line
  /^\/\//,
  /^\/\*/,
  /^\s*\*/,
  /^\s*$/,
  /^"use strict";$/,
  /^#!/, // shebang (mcp/cbase-mcp.js is also started directly)
];

const isInteger = (n) => Number.isInteger(n);

function areaCheck(b, place, max) {
  if (!Array.isArray(b) || b.length !== 2 || !isInteger(b[0]) || !isInteger(b[1])) {
    throw new Error(`${place}: area ${JSON.stringify(b)} is not an [a, b] of two integers`);
  }
  if (b[0] < 1 || b[1] < b[0]) throw new Error(`${place}: area [${b[0]}, ${b[1]}] — 1 ≤ a ≤ b violated`);
  if (max != null && b[1] > max) throw new Error(`${place}: area [${b[0]}, ${b[1]}] lies beyond the end of the source (${max} lines)`);
}

function patternCheck(list, place) {
  for (const s of list) {
    if (typeof s !== "string") throw new Error(`${place}: pattern ${JSON.stringify(s)} is not a string`);
    try { new RegExp(s); } catch (err) { throw new Error(`${place}: pattern ${JSON.stringify(s)} is not a valid regex — ${err.message}`); }
  }
}

// Reads and VALIDATES the manifest. A manifest with a typo in a field name would otherwise silently check
// nothing — and a guard that checks nothing cannot be told from a green one.
export function readManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const place = path.basename(file);
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!object(m.sources) || !Object.keys(m.sources).length) throw new Error(`${place}: field "sources" missing or empty`);
  if (!object(m.slices)) throw new Error(`${place}: field "slices" missing`);
  if (!Array.isArray(m.wrapperPattern)) throw new Error(`${place}: field "wrapperPattern" missing`);
  if (!Array.isArray(m.reverseImportsAllowed)) throw new Error(`${place}: field "reverseImportsAllowed" missing`);
  if (typeof m.complete !== "boolean") throw new Error(`${place}: field "complete" missing or not a boolean`);
  if (!object(m.files)) throw new Error(`${place}: field "files" missing`);
  patternCheck(m.wrapperPattern, `${place} wrapperPattern`);
  // Optional: the target from a commit instead of the working tree (see header). The full hash, as with the
  // sources — a prefix could one day mean two commits.
  if (m.targetStatus != null) {
    if (!object(m.targetStatus)) throw new Error(`${place}: "targetStatus" must be an object`);
    if (!/^[0-9a-f]{40}$/.test(m.targetStatus.commit || "")) throw new Error(`${place}: targetStatus.commit is not a full 40-character commit`);
    if (typeof m.targetStatus.reason !== "string" || !m.targetStatus.reason.trim()) throw new Error(`${place}: targetStatus.reason missing`);
  }

  for (const [name, q] of Object.entries(m.sources)) {
    const qwo = `${place} sources.${name}`;
    for (const k of ["path", "commit"]) {
      if (typeof q[k] !== "string" || !q[k].trim()) throw new Error(`${qwo}: "${k}" missing`);
    }
    // The full hash, not a prefix: a prefix could be copied from a spec without ever having been measured.
    if (!/^[0-9a-f]{64}$/.test(q.sha256 || "")) throw new Error(`${qwo}: "sha256" is not a full 64-character hash`);
    if (!isInteger(q.rows) || q.rows < 1) throw new Error(`${qwo}: "rows" missing or not a positive integer`);
    if (!Array.isArray(q.exempt)) throw new Error(`${qwo}: "exempt" missing (empty array if nothing is exempt)`);
    for (const b of q.exempt) areaCheck(b, `${qwo} exempt`, q.rows);
  }

  for (const [filePath, d] of Object.entries(m.files)) {
    const spot = `${place} files["${filePath}"]`;
    if (!object(d)) throw new Error(`${spot}: not an object`);
    if (!m.sources[d.source]) throw new Error(`${spot}: "source" ${JSON.stringify(d.source)} is none of the sources (${Object.keys(m.sources).join(", ")})`);
    if (!Array.isArray(d.areas) || !d.areas.length) throw new Error(`${spot}: "areas" missing or empty`);
    for (const b of d.areas) areaCheck(b, `${spot} areas`, m.sources[d.source].rows);
    for (const k of ["deviations", "addition", "additionPattern"]) {
      if (d[k] != null && !Array.isArray(d[k])) throw new Error(`${spot}: "${k}" must be an array`);
    }
    for (const a of d.deviations || []) {
      if (!object(a) || typeof a.source !== "string" || typeof a.fresh !== "string") {
        throw new Error(`${spot}: deviation ${JSON.stringify(a)} needs "source" and "fresh" as strings`);
      }
    }
    for (const z of d.addition || []) if (typeof z !== "string") throw new Error(`${spot}: addition ${JSON.stringify(z)} is not a string`);
    patternCheck(d.additionPattern || [], `${spot} additionPattern`);
  }
  return m;
}

// Lines of the source in the committed state. The hash is checked BEFORE splitting — the ranges in the
// manifest hold only for exactly this blob.
export function sourceLines(repo, source) {
  const blob = execFileSync("git", ["-C", repo, "show", `${source.commit}:${source.path}`], {
    // server.js is 1.27 MB — the default buffer (1 MB) would silently choke the child process.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sha = crypto.createHash("sha256").update(blob).digest("hex");
  if (sha !== source.sha256) {
    throw new Error(`source deviates — re-pin the manifest (${source.path}@${source.commit}: expected ${source.sha256.slice(0, 12)}…, measured ${sha.slice(0, 12)}…)`);
  }
  const lines = blob.toString("utf8").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  // The hash proves the content; the line count beside it is a second statement in the manifest that can
  // contradict — then the manifest does not agree with itself.
  if (lines.length !== source.rows) {
    throw new Error(`${source.path}@${source.commit}: manifest says ${source.rows} lines, the blob has ${lines.length}`);
  }
  return lines;
}

function regexes(list) {
  return (list || []).map((r) => (r instanceof RegExp ? new RegExp(r.source, r.flags.replace(/[gy]/g, "")) : new RegExp(r)));
}

// From the position in the concatenated expectation back to the source line — for the report. Without
// areas (in the test) the location stays empty.
function sourceLocation(j, areas) {
  if (!areas) return { area: null, sourceLine: null };
  let rest = j;
  for (let k = 0; k < areas.length; k++) {
    const [a, b] = areas[k];
    const n = b - a + 1;
    if (rest < n) return { area: k + 1, sourceLine: a + rest };
    rest -= n;
  }
  return { area: null, sourceLine: null };
}

// Pure comparison of a target file against the concatenated expectation of its areas.
//
//   actualLines      lines of the target file (without the empty line after the last newline)
//   expectedLines    concatenation of the ranges in the order of the target file
//   wrapperPattern   regexes (or strings) for wrapper lines, hold for every file
//   addition         byte-exact additional lines this file may carry
//   additionPattern  regexes for them
//   deviations       [{ source, fresh, sourceLine? }] — a source line that may read differently in the target file;
//                    with `sourceLine` it holds ONLY at this line of the source (a `  };` that may become `  });`
//                    would otherwise stand open at every place of the file)
//   areas            optional, only for the report (area index + source line per error)
//
// Precedence per line: equality (or a registered deviation) BEFORE wrapper. A `}` in the source is consumed as source,
// not as wrapper — otherwise the check would take the closing brace of a moved block for that of the route function, and
// the real wrapper brace would be "too much".
export function diffFile({ actualLines, expectedLines, wrapperPattern, addition, additionPattern, deviations, areas }) {
  const actual = actualLines || [];
  const expected = expectedLines || [];
  const wrapperRe = regexes(wrapperPattern);
  const additionRe = regexes(additionPattern);
  const additionSet = new Set(addition || []);
  const deviation = new Map();
  for (const a of deviations || []) {
    if (!deviation.has(a.source)) deviation.set(a.source, []);
    deviation.get(a.source).push({ fresh: a.fresh, sourceLine: a.sourceLine ?? null });
  }
  // `j` is the position in the expectation; without `areas` (pure tests) the source line is unknown, and a
  // deviation bound to a line then holds nowhere.
  const matches = (found, desired, j) => {
    if (found === desired) return true;
    const candidates = deviation.get(desired);
    if (!candidates) return false;
    const here = areas && j != null ? sourceLocation(j, areas).sourceLine : null;
    return candidates.some((k) => k.fresh === found && (k.sourceLine == null || k.sourceLine === here));
  };
  // Wrapper and addition hold ONLY at an area boundary (before the first area, between two areas, after the last).
  // A `return NEXT;` in the middle of the moved block would otherwise pass as "wrapper" and kill the route without a
  // guard seeing it. Without `areas` (pure tests) the whole expectation is ONE area. Whoever wants to put an addition
  // line in the middle of an area splits the area in the manifest at that place — then a boundary IS there, and it
  // stands in the manifest.
  const limits = new Set([0, expected.length]);
  if (areas) { let n = 0; for (const [a, b] of areas) { n += b - a + 1; limits.add(n); } }
  const isWrapper = (z, j) => limits.has(j) && (additionSet.has(z) || additionRe.some((r) => r.test(z)) || wrapperRe.some((r) => r.test(z)));
  const isHeader = (z) => HEADER_PATTERN.some((r) => r.test(z));

  const error = [];
  let wrapperRows = 0;
  let headerRows = 0;
  const report2 = (i, j, kind) => {
    const location = sourceLocation(j, areas);
    error.push({ row: i + 1, kind, actual: actual[i] ?? null, expected: expected[j] ?? null, ...location });
  };

  // Header: the anchor is the place where the first area begins. Everything before it (header comment, imports) is not
  // checked — it is new by definition. Wrapper lines before the anchor (the route header) count as wrapper, not as
  // header: the number in the report should say how much wrapper the file carries, wherever it stands.
  //
  // Why not simply the first line equal to the first expected line: an area often begins with a blank line or a
  // `// ──` separator (cut = line after the end of the previous statement), and that would also appear in the header
  // comment. So the first four expected lines must stand there (wrapper lines in between allowed). And why the anchor is
  // still not rigid: a defect in line 2 of the area would otherwise only mean "first area not found" — correct, but
  // worthless. Without a full hit the search takes the place with the longest initial hit, and the main run then names
  // the line and both versions.
  const width = Math.min(ANCHOR_WIDTH, expected.length);
  const anchorHits = (start) => {
    let a = start;
    let e = 0;
    while (e < width && a < actual.length) {
      if (matches(actual[a], expected[e], e)) { a++; e++; continue; }
      if (isWrapper(actual[a], e)) { a++; continue; }
      break;
    }
    return e;
  };
  let anchor = expected.length ? -1 : 0;
  let bestHits = 0;
  // The first full hit wins; among partial hits the longest, on a tie the first.
  for (let i = 0; i < actual.length && bestHits < width; i++) {
    if (!matches(actual[i], expected[0], 0)) continue;
    const t = anchorHits(i);
    if (t > bestHits) { bestHits = t; anchor = i; }
  }
  if (anchor < 0) {
    error.push({ row: 1, kind: "anchor", actual: null, expected: expected[0] ?? null, ...sourceLocation(0, areas) });
    return { ok: false, error, wrapperRows, headerRows };
  }
  // The header is CHECKED, not only counted: imports, comments, blank lines and wrapper (the route header) —
  // any other line is foreign code before the first area.
  for (let i = 0; i < anchor; i++) {
    if (isWrapper(actual[i], 0)) wrapperRows++;
    else if (isHeader(actual[i])) headerRows++;
    else error.push({ row: i + 1, kind: "header-foreign", actual: actual[i], expected: null, area: null, sourceLine: null });
  }

  // Main run. After an error it resynchronizes with one line of lookahead — not to heal the violation (the
  // verdict stands), but so the report also names the second and third place.
  let i = anchor;
  let j = 0;
  while (j < expected.length && i < actual.length) {
    if (matches(actual[i], expected[j], j)) { i++; j++; continue; }
    if (isWrapper(actual[i], j)) { wrapperRows++; i++; continue; }
    if (error.length >= ERROR_CAP) {
      error.push({ row: i + 1, kind: "aborted", actual: null, expected: null, area: null, sourceLine: null });
      return { ok: false, error, wrapperRows, headerRows };
    }
    if (i + 1 < actual.length && matches(actual[i + 1], expected[j], j)) { report2(i, j, "addition"); i++; continue; }
    if (j + 1 < expected.length && matches(actual[i], expected[j + 1], j + 1)) { report2(i, j, "missing"); j++; continue; }
    report2(i, j, "changed"); i++; j++;
  }
  // The expectation must be used up — a target file that stops before the end of its area has lost source lines.
  while (j < expected.length) { report2(i, j, "missing"); j++; if (error.length >= ERROR_CAP) break; }

  // End: after the last area only wrapper, blank lines and a multi-line `export {` … `};` block are allowed.
  let exportBlock = false;
  for (; i < actual.length; i++) {
    const z = actual[i];
    if (exportBlock) { wrapperRows++; if (EXPORT_BLOCK_TO.test(z)) exportBlock = false; continue; }
    if (EXPORT_BLOCK_ON.test(z)) { exportBlock = true; wrapperRows++; continue; }
    if (z.trim() === "") continue;
    if (isWrapper(z, expected.length)) { wrapperRows++; continue; }
    error.push({ row: i + 1, kind: "addition", actual: z, expected: null, area: null, sourceLine: null });
  }
  if (exportBlock) error.push({ row: actual.length, kind: "export-block-open", actual: null, expected: null, area: null, sourceLine: null });

  return { ok: !error.length, error, wrapperRows, headerRows };
}

// Overlaps: two areas (also of the same file) that claim the same source line. That is ALWAYS an error — a
// line that was moved twice lies twice in the tree. `files` in the form of the manifest: { [path]: { source, areas } }.
export function areaConflicts(files) {
  const bySource = new Map();
  for (const [filePath, d] of Object.entries(files || {})) {
    if (!bySource.has(d.source)) bySource.set(d.source, []);
    for (const [a, b] of d.areas || []) bySource.get(d.source).push({ path: filePath, a, b });
  }
  const out = [];
  for (const [source, list] of bySource) {
    list.sort((x, y) => x.a - y.a || x.b - y.b);
    // Checking only the neighbour is not enough when a long area covers several short ones — hence against the
    // furthest endpoint so far, not against the predecessor.
    let open = null;
    for (const e of list) {
      if (open && e.a <= open.b) {
        out.push({ source, files: [open.path, e.path], from: e.a, until: Math.min(open.b, e.b) });
      }
      if (!open || e.b > open.b) open = e;
    }
  }
  return out;
}

// Gaps: source lines except `exempt` that no file claims — as areas per source. Whether a gap is an error is
// decided by `complete` in the manifest; until then it is a number in the report (the split runs over weeks, and
// most of the time most of it is not yet moved).
export function gaps(sources, files) {
  const out = [];
  for (const [name, q] of Object.entries(sources || {})) {
    const occupied = new Uint8Array(q.rows + 1);
    for (const [a, b] of q.exempt || []) for (let z = a; z <= b && z <= q.rows; z++) occupied[z] = 1;
    for (const d of Object.values(files || {})) {
      if (d.source !== name) continue;
      for (const [a, b] of d.areas || []) for (let z = a; z <= b && z <= q.rows; z++) occupied[z] = 1;
    }
    let from = 0;
    for (let z = 1; z <= q.rows + 1; z++) {
      const free = z <= q.rows && !occupied[z];
      if (free && !from) from = z;
      if (!free && from) { out.push({ source: name, from, until: z - 1 }); from = 0; }
    }
  }
  return out;
}

// Open means: the check runs in `./check`. Only when every slice carries "done" may it leave the gate —
// before that a forgotten call could not be told from a passed one.
export function manifestOpen(manifest) {
  return Object.values(manifest?.slices || {}).some((v) => v === "open");
}

// The whole run: every target file against its source, plus overlaps and gaps across all.
export function manifestDiff(repo, manifestFile) {
  const manifest = readManifest(manifestFile);
  // All sources are loaded, also those not yet used by any file: the hash comparison is the check, and it should
  // turn red BEFORE the first slice, not only with it.
  const sources = {};
  for (const [name, q] of Object.entries(manifest.sources)) sources[name] = sourceLines(repo, q);

  const files = [];
  for (const [filePath, d] of Object.entries(manifest.files)) {
    const content = targetContent(repo, manifest.targetStatus, filePath);
    if (content == null) {
      files.push({ path: filePath, ok: false, error: [{ row: 0, kind: "file-missing", actual: null, expected: null, area: null, sourceLine: null }], wrapperRows: 0, headerRows: 0, rows: 0 });
      continue;
    }
    const actualLines = content.split("\n");
    if (actualLines.length && actualLines[actualLines.length - 1] === "") actualLines.pop();
    const src = sources[d.source];
    const expectedLines = [];
    for (const [a, b] of d.areas) for (let z = a; z <= b; z++) expectedLines.push(src[z - 1]);
    const r = diffFile({
      actualLines, expectedLines, areas: d.areas,
      wrapperPattern: manifest.wrapperPattern, addition: d.addition, additionPattern: d.additionPattern, deviations: d.deviations,
    });
    files.push({ path: filePath, source: d.source, ...r, rows: actualLines.length });
  }

  const overlaps = areaConflicts(manifest.files);
  const luck = gaps(manifest.sources, manifest.files);
  const ok = files.every((d) => d.ok) && !overlaps.length && (!manifest.complete || !luck.length);
  return { ok, files, overlaps, gaps: luck, complete: manifest.complete, open: manifestOpen(manifest), targetStatus: manifest.targetStatus?.commit || null };
}

// The content of a target file: from the working tree (without `targetStatus`) or from the commit. `null` means:
// the file does not exist there — in the commit `git show` reports that as an error with exit 128.
function targetContent(repo, targetStatus, filePath) {
  if (!targetStatus) {
    const abs = path.join(repo, filePath);
    return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  }
  try {
    return execFileSync("git", ["-C", repo, "show", `${targetStatus.commit}:${filePath}`], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
  } catch (e) {
    if (/does not exist|exists on disk, but not in/.test(String(e?.stderr || ""))) return null;
    throw e;
  }
}

// Lines for the console — what `check.mjs` prints. The wrapper count is part of the report: a file with 400
// wrapper lines is no moved file anymore, even if each single one passes the pattern.
export function report(result) {
  const out = [];
  const bad = result.files.filter((d) => !d.ok);
  const wrapper = result.files.reduce((s, d) => s + (d.wrapperRows || 0), 0);
  const header = result.files.reduce((s, d) => s + (d.headerRows || 0), 0);
  const gapsTxt = result.complete
    ? (result.gaps.length ? `${result.gaps.length} gap(s) — manifest says complete` : "no gap")
    : `${result.gaps.length} gap(s), only counted (manifest not complete)`;
  const state = result.targetStatus ? ` · target state ${result.targetStatus.slice(0, 7)} (frozen, not the working tree)` : "";
  out.push(`Manifest diff: ${result.files.length} file(s), ${bad.length} with errors · header ${header}, wrapper ${wrapper} line(s) · ${gapsTxt} · ${result.overlaps.length} overlap(s)${state}`);
  for (const u of result.overlaps) {
    out.push(`  Overlap ${u.source} ${u.from}–${u.until}: ${u.files[0]} and ${u.files[1]}`);
  }
  for (const d of bad) {
    out.push(`  ${d.path}: ${d.error.length} error(s)`);
    for (const f of d.error) {
      const location = f.sourceLine ? ` (Area ${f.area}, ${d.source} ${f.sourceLine})` : "";
      out.push(`    Line ${f.row}${location}: ${f.kind}`);
      if (f.actual != null) out.push(`      actual:   ${f.actual}`);
      if (f.expected != null) out.push(`      expected: ${f.expected}`);
    }
  }
  return out;
}
