// The boundary of the language service — what B passes on to a client from a server's response, what it reads from disk and
// where it writes.
//
// THE TARGET of a request is computed by the caller (lsp/ never imports runs/ — devtools/code-route.js or devtools/routes.js):
//   `{ projectId, instance (object | null), root (project folder), base (root of the relative `file`: project or workspace
//      folder, null for agents), area? (real roots of the instance, runs/runtime-limit.js — only a relocated project),
//      beforeWrite? (setup lock) }`.
//
// INSIDE is a location below the project folder (lexically or after realpath — macOS reports /private/var for /var) or in the
// instance's area. Everything else is OUTSIDE:
//   - a location pointing outside (`lib.dom.d.ts`, the Python standard library) goes out with the absolute path and a token
//     (`external: { token }`, lsp/sessions.js rememberExternal, 30 min) — it is read ONLY through `read` with that token (B reads
//     only what the server itself named), in the project container through `head -c` with a cap and a deadline;
//   - a WorkspaceEdit with ONE location outside ⇒ 403 OUTSIDE, nothing at all is returned; creating/renaming/deleting files
//     (`documentChanges` with `kind`) counts as outside.
// READING from disk (agents without a buffer) only through the descriptor (O_NONBLOCK, a regular file only; in the area through
// runtime/real-path.js readInArea) — never `readFileSync` on a path of the project: a FIFO would stall the WHOLE backend
// (guard: server/backend/test/language-service-fifo.test.js). B never reads a COPY from its own disk (that would be the main
// instance): for an agent B reads and writes there through the copy's container (runtime/fileAccess.js — readDiskAgent,
// writeEverythingOrNothingCopy), never with a fallback to B.
// WRITING is all or nothing: first check every file and compute every new text, then ask the lock (`beforeWrite`), then write —
// in the area through the opened, checked parent folder (openFileWithoutReference: O_NOFOLLOW|O_NONBLOCK, truncated only after
// the check), in a copy with a sha256 comparison in the container (`expect`). Only the agents' path writes (lsp/agents.js); the
// editor gets the edit and applies it to its buffers.
import fs from "node:fs";
import path from "node:path";
import { T } from "../i18n.js";
import { inProject } from "../runtime/inProject.js";
import { realPath, inArea, readInArea, openFileWithoutReference } from "../runtime/real-path.js";
import * as access from "../runtime/fileAccess.js";
import { LspError } from "./documents.js";
import { rememberExternal } from "./sessions.js";
import { pathOfUri, relativeUnder, applyEdits } from "./text.js";

/** B reads at most this many bytes from a file for a client or an agent. */
export const READ_MAX = 8 * 1024 * 1024;
const EXTERN_DEADLINE_MS = 10_000;

const realOrNull = (p) => { try { return realPath(p); } catch { return null; } };
const isCopy = (inst) => Boolean(inst) && String(inst.instance || "main") !== "main";

/** The path as the client knows it — lexically below `root` (a realpath below the real root is converted). */
export function lexical(s, abs) {
  const a = path.resolve(String(abs));
  if (relativeUnder(s.root, a) !== null) return a;
  const rel = relativeUnder(s.rootReal, a);
  if (rel !== null) return path.join(s.root, ...rel.split("/"));
  return null;
}

/** Is `abs` inside (see the header)? → the lexical path below the project folder, in the area the real path — or null. */
export function inside(s, target, abs) {
  const lex = lexical(s, abs);
  if (lex) return lex;
  if (target?.area) { const e = realOrNull(abs); if (e && inArea(e, target.area)) return e; }
  return null;
}

/**
 * A server's Location → Location of the contract, or null (not a file URI). `range` stays as it is (UTF-16). Without `base` (an
 * agent) a location outside carries only `external: true` — an agent reads it with its own tools, a token would only pile up.
 */
export function locationOf(s, target, uri, range) {
  const abs = pathOfUri(uri);
  if (!abs || !range) return null;
  const lex = inside(s, target, abs);
  const rel = lex && target?.base ? relativeUnder(target.base, lex) : null;
  if (rel !== null) return { file: rel, range };
  if (lex && !target?.base) return { file: lex, range };
  if (!target?.base) return { file: abs, range, external: true };
  return { file: abs, range, external: { token: rememberExternal(s, abs) } };
}

// The changes of a WorkspaceEdit per file URI — throws OUTSIDE for a resource operation (see the header).
function changesOf(edit) {
  const byKey = new Map();
  const alongside = (uri, edits) => { if (!byKey.has(uri)) byKey.set(uri, []); byKey.get(uri).push(...(Array.isArray(edits) ? edits : [])); };
  if (edit && typeof edit === "object") {
    if (Array.isArray(edit.documentChanges)) {
      for (const dc of edit.documentChanges) {
        if (dc?.kind) throw outside(T`The language server wanted to ${dc.kind === "delete" ? T("delete##file") : dc.kind} a file — cbase only applies text edits, nothing applied.`);
        if (dc?.textDocument?.uri) alongside(dc.textDocument.uri, dc.edits);
      }
    } else if (edit.changes && typeof edit.changes === "object") {
      for (const [uri, edits] of Object.entries(edit.changes)) alongside(uri, edits);
    }
  }
  return byKey;
}
const outside = (error) => new LspError(403, { code: "OUTSIDE", error });
const textEdit = (e) => ({ range: e.range, newText: String(e.newText ?? "") });

/**
 * A server's WorkspaceEdit → `[{ abs, lex, edits }]` (header: everything inside, otherwise 403 OUTSIDE). `abs` is the server's
 * path, `lex` the one computed inside (lexical below the project folder, or the real path in the area).
 */
export function checkEdit(s, target, edit) {
  const out = [];
  const outside2 = [];
  for (const [uri, edits] of changesOf(edit)) {
    const abs = pathOfUri(uri);
    const lex = abs ? inside(s, target, abs) : null;
    if (!lex) { outside2.push(abs || uri); continue; }
    if (target?.base && relativeUnder(target.base, lex) === null) { outside2.push(abs); continue; }
    const existing = out.find((x) => x.lex === lex);
    const fresh = edits.filter((e) => e && e.range).map(textEdit);
    if (existing) existing.edits.push(...fresh); else out.push({ abs, lex, edits: fresh });
  }
  if (outside2.length) {
    throw outside(T`${outside2.length} location(s) of the edit lie outside the instance (${outside2.slice(0, 3).join(", ")}) — nothing applied.`);
  }
  return out.filter((x) => x.edits.length);
}

/** WorkspaceEdit of the contract: `{ changes: [{ file, edits }] }`, `file` relative to the base. */
export function editForClient(s, target, edit) {
  return { changes: checkEdit(s, target, edit).map((x) => ({ file: relativeUnder(target.base, x.lex), edits: x.edits })) };
}

// Reading through a non-blocking descriptor — a regular file only, with a cap.
function readWithoutBlock(abs) {
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)); } catch (e) { throw e; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(T("Not a regular file")), { code: "ENOFILE" });
    if (st.size > READ_MAX) throw Object.assign(new Error(T("File too large for the language service")), { code: "ETOOBIG" });
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

/** The text of a file of the instance from disk (agents, `source: "disk"`) — throws with the file system's code. */
export function readDisk(target, abs) {
  if (isCopy(target?.instance)) {
    throw new LspError(409, { error: T("In a copy the language service does not read files from B's disk (that is the main instance) — open the file in the copy's editor.") });
  }
  try {
    if (target?.area) return readInArea(abs, target.area, "utf8", { maxBytes: READ_MAX });
    return readWithoutBlock(abs);
  } catch (e) { throw readError(e); }
}
/**
 * The text of a file for an AGENT (no buffer): in a copy through its container (runtime/fileAccess.js read — follows links in
 * the container, opens no folder and no FIFO), otherwise readDisk. Throws like readDisk (readError).
 */
export async function readDiskAgent(target, abs) {
  if (!isCopy(target?.instance)) return readDisk(target, abs);
  let r;
  try { r = await access.read(target.instance, abs, { maxBytes: READ_MAX }); } catch (e) { throw readError(e); }
  if (r.kind !== "file") throw readError({ code: r.kind ? "ENOFILE" : "ENOENT" });
  if (r.tooBig) throw new LspError(400, { error: T("File too large for the language service") });
  return r.data.toString("utf8");
}

/** A read error as a response: missing file 404, not a regular file 400, a location outside 403. */
export function readError(e) {
  if (e instanceof LspError) return e;
  if (e?.code === "ENOENT") return new LspError(404, { error: T("File not found") });
  if (e?.code === "ENOFILE") return new LspError(400, { error: T("Not a regular file") });
  if (e?.code === "EOUTSIDE") return new LspError(403, { error: T`Language service: ${e.message}` });
  return new LspError(400, { error: String(e?.message || e) });
}

/** Read a named target outside (`read`) — in the project container through `head -c` (cap and deadline), otherwise in B. */
export async function readExternal(e) {
  const inst = e.inst || null;
  if (!inst) return readWithoutBlock(e.abs);
  return await new Promise((resolve, reject) => {
    let kind;
    try { kind = inProject(inst, "head", ["-c", String(READ_MAX), "--", e.abs], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (f) { reject(f); return; }
    const parts = [];
    let length = 0;
    let error = "";
    const tick = setTimeout(() => { try { kind.kill("SIGKILL"); } catch { /* gone */ } reject(Object.assign(new Error(T("Reading took too long")), { code: "EDEADLINE" })); }, EXTERN_DEADLINE_MS);
    tick.unref?.();
    kind.stdout.on("data", (c) => { length += c.length; if (length <= READ_MAX) parts.push(c); });
    kind.stderr.on("data", (c) => { error = (error + String(c)).slice(-400); });
    kind.on("error", (f) => { clearTimeout(tick); reject(f); });
    kind.on("close", (code) => {
      clearTimeout(tick);
      if (code === 0) resolve(Buffer.concat(parts).toString("utf8"));
      else reject(new Error(error.trim() || `head: Exit ${code}`));
    });
  });
}

/** Write the text of a file — in the area through the checked parent folder, otherwise through a non-blocking descriptor. */
function write(target, lex, text) {
  if (target?.area) {
    const fd = openFileWithoutReference(lex, target.area, { flags: fs.constants.O_WRONLY });
    try { fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, text, "utf8"); } finally { fs.closeSync(fd); }
    return;
  }
  const fd = fs.openSync(lex, fs.constants.O_WRONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(T("Not a regular file")), { code: "ENOFILE" });
    fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, text, "utf8");
  } finally { fs.closeSync(fd); }
}

/**
 * All or nothing (see the header): `plan` = `[{ lex, edits, text? }]` (`text` = the state the server computed against; without
 * it the disk counts). The computation ALWAYS runs on the text from disk; if it differs from `text` that is a 409 and nothing is
 * written — as in the copy (writeEverythingOrNothingCopy). Taking `text` as the old state without reading the disk would write
 * back stale text plus edits whenever an agent changed the file since its last language service request.
 * → `{ changed: [lex…] }` · `{ changed: [], locked }` (the lock answered) · throws before the first write with the reason.
 */
export function writeEverythingOrNothing(target, plan) {
  // A copy writes only through its container (writeEverythingOrNothingCopy) — this path would write into the main instance.
  if (isCopy(target?.instance)) throw new LspError(409, { error: T("In a copy B does not write to its own disk (that is the main instance).") });
  const finished = [];
  for (const p of plan) {
    let old;
    try { old = target?.area ? readInArea(p.lex, target.area, "utf8", { maxBytes: READ_MAX }) : readWithoutBlock(p.lex); }
    catch (e) { throw new LspError(409, { error: T`${p.lex}: not readable (${e?.code || e?.message || e}) — nothing written` }); }
    if (typeof p.text === "string" && p.text !== old) {
      throw new LspError(409, { error: T`${p.lex} changed since the language server computed — nothing written` });
    }
    let fresh;
    try { fresh = applyEdits(old, p.edits); } catch (e) { throw new LspError(400, { error: T`${p.lex}: ${e?.message || e} — nothing written` }); }
    finished.push({ lex: p.lex, fresh, old });
  }
  if (typeof target?.beforeWrite === "function") {
    const locked = target.beforeWrite(finished.map((f) => f.lex));
    if (locked) return { changed: [], locked };
  }
  const changed = [];
  for (const f of finished) {
    if (f.fresh === f.old) continue;
    try { write(target, f.lex, f.fresh); }
    catch (e) { throw new LspError(409, { error: T`Writing failed at ${f.lex} (${e?.code || e?.message || e})`, changed }); }
    changed.push(f.lex);
  }
  return { changed, texts: new Map(finished.map((f) => [f.lex, f.fresh])) };
}

/**
 * All or nothing IN A COPY: read every file through its container (with sha256), check it against the state the server computed
 * against (`text`, otherwise the disk counts), compute every new text, then ask the lock, then write — every file with `expect`
 * = sha256 of what was read (runtime/fileAccess.js: comparison in the container, no window between read and write in B).
 * → like writeEverythingOrNothing.
 */
export async function writeEverythingOrNothingCopy(target, plan) {
  const inst = target?.instance;
  if (!isCopy(inst)) throw new TypeError("writeEverythingOrNothingCopy: without a copy there is no copy container");
  const finished = [];
  for (const p of plan) {
    let r;
    try { r = await access.read(inst, p.lex, { maxBytes: READ_MAX }); } catch (e) {
      throw new LspError(409, { error: T`${p.lex}: not readable (${e?.code || e?.message || e}) — nothing written` });
    }
    if (r.kind !== "file" || r.tooBig) {
      const code = r.tooBig ? "ETOOBIG" : "ENOFILE";
      throw new LspError(409, { error: T`${p.lex}: not readable (${code}) — nothing written` });
    }
    const old = r.data.toString("utf8");
    if (typeof p.text === "string" && p.text !== old) {
      throw new LspError(409, { error: T`${p.lex} changed since the language server computed — nothing written` });
    }
    let fresh;
    try { fresh = applyEdits(old, p.edits); } catch (e) { throw new LspError(400, { error: T`${p.lex}: ${e?.message || e} — nothing written` }); }
    finished.push({ lex: p.lex, fresh, old, sha: r.sha256 });
  }
  if (typeof target?.beforeWrite === "function") {
    const locked = target.beforeWrite(finished.map((f) => f.lex));
    if (locked) return { changed: [], locked };
  }
  const changed = [];
  for (const f of finished) {
    if (f.fresh === f.old) continue;
    try { await access.write(inst, f.lex, Buffer.from(f.fresh, "utf8"), { expect: f.sha }); }
    catch (e) { throw new LspError(409, { error: T`Writing failed at ${f.lex} (${e?.code || e?.message || e})`, changed }); }
    changed.push(f.lex);
  }
  return { changed, texts: new Map(finished.map((f) => [f.lex, f.fresh])) };
}

/** An agent's write path: in a copy through its container, otherwise through the descriptor in B. */
export async function writeForAgent(target, plan) {
  return isCopy(target?.instance) ? await writeEverythingOrNothingCopy(target, plan) : writeEverythingOrNothing(target, plan);
}
