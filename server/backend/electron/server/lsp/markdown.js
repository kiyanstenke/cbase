// Port of: microsoft/vscode extensions/markdown-language-features/src/client/client.ts (MIT)
// Port of: microsoft/vscode extensions/markdown-language-features/src/extensions/yamlPreamble/yamlPreamble.ts (MIT)
//
// The client side of the Markdown language server. VS Code starts `vscode-markdown-languageserver` and answers its requests to
// the client itself: PARSING (`markdown/parse` — the server has no parser, it gets the tokens from markdown-it) and access to the
// files of the workspace (`markdown/fs/*`, `markdown/findMarkdownFilesInWorkspace`, watchers). In cbase B is the only LSP client —
// so B answers them, here. Registered through `sessions.js:setClientPage` (from actions.js) so that sessions.js does not import
// this leaf.
//
// PARSING like VS Code's `MarkdownItEngine` (src/markdownEngine.ts): markdown-it with `html: true`, `linkify` (the default of
// `markdown.preview.linkify`) without `fuzzyLink`, `breaks`/`typographer` off; before that the `front_matter` rule (yamlPreamble.ts
// — front matter `---` … `---` in line 0 is ONE token, not a paragraph and not a heading). Only the fields the language service
// reads go out (`type`, `map`, `markup`, `content`, `info`, `children`). Without `text` the session's open document counts (the
// editor's buffer), otherwise the disk.
//
// THE FILES only INSIDE (lsp/limit.js `inside`: below the project folder or in the instance's area) — a link pointing outside is
// "not there" for the server (stat ⇒ undefined), B reads nothing there. In the main instance (and without an instance) B reads
// itself (readDisk: non-blocking descriptor, never a FIFO); in a COPY through its container (runtime/fileAccess.js — B's disk
// would hold the main instance). The search works like VS Code's `findFiles("**/*.{<suffixes>}", "**/node_modules/**")`, also
// skipping dot folders (the server excludes `**/.*` anyway) and with caps (MAX_VISITED files, MAX_HITS hits).
//
// FRESHNESS (instead of VS Code's watchers): `markdownFreshness(s)` before every editor action on a Markdown session determines
// which files read from disk have changed or are gone (`workspace/didChangeWatchedFiles`) and reports create/change/delete
// (`markdown/fs/watcher/onChange`) to the server's watchers (`markdown/fs/watcher/create`). In a COPY with ONE call in the
// container for all stamps (runtime/fileAccess.js `stamp`), at most every FRESH_COPY_MS and not awaited — the action does not
// wait for the container, the report follows it (like a watcher in VS Code, which also lags). What is read or watched in the
// copy gets its stamp at the next look (without a report).
//
// LINKS OUT OF THE PROJECT: VS Code knows the file outside (`stat` through the file system) — a link to it is not a "missing"
// link, a folder outside is a folder. `markdown/fs/stat` therefore also answers outside, but only with existence and kind (never
// with content): reading and folder listings stay inside (a server in the project container reads no foreign files through B —
// a named deviation: an anchor in a file outside is not resolved).
import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import * as access from "../runtime/fileAccess.js";
import { inside, readDisk } from "./limit.js";
import { MARKDOWN_SUFFIXES } from "./table.js";
import { pathOfUri, uriOfPath } from "./text.js";

export const MAX_VISITED = 50_000;
export const MAX_HITS = 5_000;
/** Freshness checks at most this many read files and watchers per call. */
export const FRESHNESS_CAP = 2_000;

// The access into a copy (runtime/fileAccess.js) — a test sets its own (`setMarkdownAccess`, guard lsp-vv.test.js: the same cores
// as in the container, against a folder).
let turn = access;
export function setMarkdownAccess(z) { turn = z || access; }
const isCopy = (inst) => Boolean(inst) && String(inst.instance || "main") !== "main";
/** The stamp of a file read or watched in the copy before the container has reported it. */
const OPEN = "?";
/** In a copy, look into the container for freshness at most this often. */
export const FRESH_COPY_MS = 2_000;
/** This many paths per call in the container (argv). */
const STAMP_PER_CALL = 500;

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The `front_matter` rule (yamlPreamble.ts): only in line 0 without indent, `---` up to the next `---` without indent. */
function preludeRule(state, startLine, endLine, silent) {
  if (startLine !== 0 || state.tShift[startLine] !== 0) return false;
  const row = (n) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  if (row(startLine).trimEnd() !== "---") return false;
  let n = startLine + 1;
  for (; n < endLine; n++) if (state.tShift[n] === 0 && row(n).trimEnd() === "---") break;
  if (n >= endLine) return false;
  if (silent) return true;
  const t = state.push("front_matter", "", 0);
  t.block = true;
  t.hidden = false;
  t.markup = "---";
  t.map = [startLine, n + 1];
  t.meta = { content: state.src.slice(state.bMarks[startLine + 1], state.bMarks[n]).replace(/\r?\n$/, "") };
  state.line = n + 1;
  return true;
}

let engine = null;
/** The one instance of markdown-it (as in VS Code: built once). */
export function mdEngine() {
  if (engine) return engine;
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });
  md.linkify.set({ fuzzyLink: false });
  md.block.ruler.before("fence", "front_matter", preludeRule, { alt: ["paragraph", "reference", "blockquote", "list"] });
  engine = md;
  return md;
}

const slim = (t) => ({
  type: t.type,
  ...(t.map ? { map: t.map } : {}),
  ...(t.markup ? { markup: t.markup } : {}),
  ...(t.content ? { content: t.content } : {}),
  ...(t.info ? { info: t.info } : {}),
  ...(Array.isArray(t.children) && t.children.length ? { children: t.children.map(slim) } : {}),
});

/** The tokens of a text in the shape the language service reads (see the header). */
export function tokensOf(text) {
  return mdEngine().parse(String(text ?? ""), {}).map(slim);
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The location of a URI inside — or null (not a file URI, outside). */
function locationOf(s, uri) {
  const abs = pathOfUri(uri);
  return abs ? inside(s, { area: s.area }, abs) : null;
}
const diskTarget = (s) => ({ instance: s.instance, area: s.area });

async function readBytes(s, lex) {
  if (isCopy(s.instance)) {
    const r = await turn.read(s.instance, lex);
    if (r.kind !== "file" || r.tooBig) throw Object.assign(new Error(`not readable: ${lex}`), { code: "ENOFILE" });
    rememberStatus(s, lex, OPEN);
    return Buffer.from(r.data);
  }
  const text = readDisk(diskTarget(s), lex);
  rememberStatus(s, lex);
  return Buffer.from(text, "utf8");
}

function stamp(lex) {
  try { const st = fs.statSync(lex); return `${st.isDirectory() ? "d" : "f"}:${st.size}:${st.mtimeMs}`; } catch { return null; }
}
function rememberStatus(s, lex, st = stamp(lex)) {
  const g = (s.mdRead ??= new Map());
  if (!g.has(lex) && g.size >= FRESHNESS_CAP) return;
  g.set(lex, st);
}

/** Existence and kind (`{ isDirectory }` or null) — a link counts as its target (like `stat` in VS Code). */
async function statOf(s, lex) {
  if (isCopy(s.instance)) {
    const st = await turn.stat(s.instance, lex);
    if (!st) return null;
    const kind = st.kind === "reference" ? st.target?.kind : st.kind;
    return kind ? { isDirectory: kind === "folder" } : null;
  }
  try { return { isDirectory: (await fs.promises.stat(lex)).isDirectory() }; } catch { return null; }
}

async function folderOf(s, lex) {
  if (isCopy(s.instance)) {
    const e = await turn.list(s.instance, lex);
    return e.map((x) => [String(x.name), { isDirectory: x.kind === "folder" }]);
  }
  const e = await fs.promises.readdir(lex, { withFileTypes: true });
  return e.map((x) => [x.name, { isDirectory: x.isDirectory() }]);
}

/** The Markdown files below `root` (B): without node_modules and dot folders, with caps (see the header). */
export function findMarkdown(root, suffixes = MARKDOWN_SUFFIXES) {
  const matches = new Set(suffixes.map((e) => `.${String(e).toLowerCase()}`));
  const hits = [];
  let visited = 0;
  const stack = [root];
  while (stack.length && hits.length < MAX_HITS) {
    const folder = stack.pop();
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(folder, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) stack.push(p); continue; }
      if (!e.isFile()) continue;
      if (++visited > MAX_VISITED) return hits;
      if (matches.has(path.extname(e.name).toLowerCase())) { hits.push(p); if (hits.length >= MAX_HITS) break; }
    }
  }
  return hits;
}

async function markdownFiles(s) {
  if (isCopy(s.instance)) {
    // In the copy ONE pass in the container over all suffixes.
    const r = await turn.glob(s.instance, s.root, { suffixes: [...MARKDOWN_SUFFIXES], skip: ["node_modules"], maxFiles: MAX_VISITED, maxHits: MAX_HITS });
    return r.hits.map((t) => t.p);
  }
  return findMarkdown(s.root);
}

// ── The server's requests ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The text for `markdown/parse` (see the header): the request's `text`, else the open document, else the disk (inside) — else null. */
export async function textToParse(s, p) {
  if (typeof p?.text === "string") return p.text;
  const uri = String(p?.uri ?? "");
  const open = s.documents?.get(uri);
  if (open && typeof open.text === "string") return open.text;
  const lex = locationOf(s, uri);
  if (!lex) return null;
  try { return (await readBytes(s, lex)).toString("utf8"); } catch { return null; }
}

/** The answers per method (`fn(s, params)`) — the ONE list that `wireMarkdown` registers (the guard checks it against the server's
 *  protocol). */
export const REQUESTS = Object.freeze({
  "markdown/parse": async (s, p) => { const text = await textToParse(s, p); return text === null ? [] : tokensOf(text); },
  "markdown/fs/readFile": async (s, p) => {
    const lex = locationOf(s, p?.uri);
    if (!lex) throw new Error("cbase only reads files inside the project");
    return Array.from(await readBytes(s, lex));
  },
  "markdown/fs/stat": async (s, p) => {
    const lex = locationOf(s, p?.uri);
    if (lex) return await statOf(s, lex);
    // Outside only existence and kind — a link out of the project is there (VS Code), nothing is read there.
    const abs = pathOfUri(String(p?.uri ?? ""));
    return abs ? await statOf(s, abs) : null;
  },
  "markdown/fs/readDirectory": async (s, p) => {
    const lex = locationOf(s, p?.uri);
    if (!lex) throw new Error("cbase only reads folders inside the project");
    return await folderOf(s, lex);
  },
  "markdown/findMarkdownFilesInWorkspace": async (s) => (await markdownFiles(s)).map((p) => uriOfPath(p)),
  "markdown/fs/watcher/create": (s, p) => {
    const lex = locationOf(s, p?.uri);
    const w = (s.mdObserver ??= new Map());
    if (lex && w.size < FRESHNESS_CAP) w.set(p.id, { uri: String(p.uri), lex, options: p.options || {}, status: isCopy(s.instance) ? OPEN : stamp(lex) });
    return null;
  },
  "markdown/fs/watcher/delete": (s, p) => { s.mdObserver?.delete(p?.id); return null; },
});

/** Registers the answers on the connection of a Markdown session (sessions.js `wire`, through `setClientPage`). */
export function wireMarkdown(s, v) {
  for (const [method, fn] of Object.entries(REQUESTS)) v.atRequest(method, (p) => fn(s, p));
}

/** Freshness (see the header) — before every editor action on a Markdown session. → how many reports went out (0 in a copy: the
 *  look into the container lags behind, `freshCopy`). */
export function markdownFreshness(s) {
  if (!s?.v) return 0;
  if (isCopy(s.instance)) {
    if (!s.mdFreshnessRunning && Date.now() - (s.mdFreshnessLast || 0) >= FRESH_COPY_MS) {
      s.mdFreshnessRunning = freshCopy(s).catch(() => 0).finally(() => { s.mdFreshnessRunning = null; s.mdFreshnessLast = Date.now(); });
    }
    return 0;
  }
  return reportFreshness(s, stamp);
}

/** Freshness of a copy: all stamps in calls of STAMP_PER_CALL paths each, then the same reports as in the main instance. */
export async function freshCopy(s) {
  const paths = [...new Set([...(s.mdRead?.keys() ?? []), ...[...(s.mdObserver?.values() ?? [])].map((w) => w.lex)])];
  if (!paths.length) return 0;
  const fresh = new Map();
  for (let i = 0; i < paths.length; i += STAMP_PER_CALL) {
    const part = paths.slice(i, i + STAMP_PER_CALL);
    const r = await turn.stamp(s.instance, part);
    part.forEach((p, j) => fresh.set(p, Array.isArray(r) ? r[j] ?? null : null));
  }
  if (!s.v) return 0;
  return reportFreshness(s, (lex) => fresh.get(lex), (lex) => fresh.has(lex));
}

/** The reports from the new stamps (`newFrom`); `knows` says for which paths there is a stamp. An OPEN stamp (read in the copy,
 *  not looked at yet) is only set — unless the file is already gone. */
function reportFreshness(s, newFrom, knows = () => true) {
  let n = 0;
  const changes = [];
  for (const [lex, old] of s.mdRead || []) {
    if (!knows(lex)) continue;
    const fresh = newFrom(lex);
    if (fresh === old) continue;
    if (fresh === null) s.mdRead.delete(lex); else s.mdRead.set(lex, fresh);
    if (old === OPEN && fresh !== null) continue;
    // The editor holds an open document — VS Code still reports the disk underneath (the server then takes the document).
    changes.push({ uri: uriOfPath(lex), type: fresh === null ? 3 : 2 });
  }
  if (changes.length) { s.v.note("workspace/didChangeWatchedFiles", { changes }); n += changes.length; }
  for (const [id, w] of s.mdObserver || []) {
    if (!knows(w.lex)) continue;
    const fresh = newFrom(w.lex);
    if (fresh === w.status) continue;
    const old = w.status;
    w.status = fresh;
    if (old === OPEN) continue;
    const kind = old === null ? "create" : fresh === null ? "delete" : "change";
    const ignored = kind === "create" ? w.options.ignoreCreate : kind === "change" ? w.options.ignoreChange : w.options.ignoreDelete;
    if (ignored) continue;
    s.v.request("markdown/fs/watcher/onChange", { id, uri: w.uri, kind }).catch(() => { /* the server left */ });
    n += 1;
  }
  return n;
}
