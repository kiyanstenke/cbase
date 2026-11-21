// The computation per editor action — independent of the wrapper. The wrapper: lsp/routes.js (mounted in
// devtools/code-route.js). The agents (`POST /api/lsp` in devtools/routes.js) compute in lsp/agents.js with THESE actions and the
// building blocks exported here (withDocument, rawCodeActions, applyCodeAction, formatDocument) — one computation, two wrappers.
//
// THE TARGET arrives complete from the caller (see the header of lsp/limit.js): `{ projectId, instance, root, base, area?, abs?,
// beforeWrite? }`; `abs` is the file of the request. Without a project `{ reason: "no_project", base }` (a file on the workspace
// level without a project).
//
// WHAT COMES BACK: the body of the response (200). Without a service the computation throws `LspNot` (200 `{ supported: false,
// reason }`), otherwise `LspError` (status + body); a server error (response with `error`, deadline, end) throws as it comes — the
// wrapper turns it into 409/502/504.
//
// `kind` (symbols, completion) stays the NUMBER from LSP (SymbolKind, CompletionItemKind); positions stay UTF-16. The agents get
// 1-based lines/columns and kinds as a word (lsp/agents.js).
//
// HOOKS, registered in server.js: `setFormatter` (lsp/formatter.js — the project's formatter before the server's),
// `setInterpreterMachine` (lsp/interpreter.js — the `interpreter` action), `setStatusAddition` (lsp/formatter.js — fields
// `formatter`/`interpreter` and `format` in `features` per language in `status`).
import crypto from "node:crypto";
import path from "node:path";
import { T } from "../i18n.js";
import { EDITOR_ACTIONS, SUFFIXES, LANGUAGES, SUGGESTION_COMMANDS } from "./contract.js";
import { LspNot, externalTarget, capabilitiesOf, runningSession, runningSessions, setClientPage, sessionFor, restart, statusOf, stopSession } from "./sessions.js";
import { LspError, diagnosticsOf, documentReconcile, closeDocument } from "./documents.js";
import { editForClient, inside, readExternal, readDisk, readDiskAgent, locationOf } from "./limit.js";
import { offsetOf, pathOfUri, positionOf, relativeUnder, uriOfPath, applyEdits, wordAt } from "./text.js";
import { markdownFreshness, wireMarkdown } from "./markdown.js";

// The Markdown server wants parsing and the files from the client (lsp/markdown.js) — registered before a session starts.
setClientPage("markdown", wireMarkdown);

const CODE_ACTION_HOLD_MS = 5 * 60_000;
const COMPLETION_CAP = 1000;
const SYMBOL_CAP = 1000;

let formatter = null;
/** `fn({ target, language, abs, text, range, session })` → `{ edits, formatter }` | null (then the server). */
export function setFormatter(fn) { formatter = typeof fn === "function" ? fn : null; }
let interpreterMachine = null;
/** `fn(target, body)` → `{ selected, effective, candidates }`. Without it `interpreter` answers 501. */
export function setInterpreterMachine(fn) { interpreterMachine = typeof fn === "function" ? fn : null; }
let statusAddition = null;
/** `fn(target, entry)` → additional fields of an entry of `status` (`formatter`, `interpreter`) or null. */
export function setStatusAddition(fn) { statusAddition = typeof fn === "function" ? fn : null; }

/** Language and languageId of a file — or null (syntax colors only). */
export function languageOf(file) {
  const kind = SUFFIXES[path.extname(String(file || "")).toLowerCase()];
  return kind ? { language: kind[0], languageId: kind[1] } : null;
}

const missing = (field) => new LspError(400, { error: T`${field} missing` });
function position(p) {
  if (!p || !Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0) throw missing("position");
  return { line: p.line, character: p.character };
}
function areaOf(r) {
  if (!r?.start || !r?.end) throw missing("range");
  return { start: position(r.start), end: position(r.end) };
}

// The session and the reconciled document of a request. Without `buffer` the state of the disk: `diskText`, which the caller
// has already read (lsp/agents.js — in a copy through its container), otherwise B reads itself (readDisk).
export async function withDocument(target, body) {
  if (target?.reason) throw new LspNot(target.reason);
  if (!target?.abs) throw missing("file");
  const kind = languageOf(target.abs);
  if (!kind) throw new LspNot("no_language");
  // Without a buffer the disk comes first: a missing file (404), a FIFO (400) or a copy (409) starts no language server.
  const disk = body?.buffer ? null : typeof body?.diskText === "string" ? body.diskText : readDisk(target, target.abs);
  const s = await sessionFor(target, kind.language);
  if (kind.language === "markdown") markdownFreshness(s);
  const d = body?.buffer
    ? documentReconcile(s, { abs: target.abs, buffer: String(body.buffer), version: body.version ?? null, text: body.text, languageId: kind.languageId })
    : documentReconcile(s, { abs: target.abs, text: disk, languageId: kind.languageId });
  return { s, d, kind };
}
const td = (d) => ({ uri: d.uri });

/**
 * Reconcile the session's documents with the disk — before every computation that can touch files OTHER than the request's:
 * `rename` and `code_action_apply` of the editor, `rename`, `code_action` and `format` of the agents. Otherwise a `disk` document
 * holds the text an agent last read (lease BUFFER_LEASE_MS, and after every rename the agents' write path opens every touched
 * file as `disk`); if the agent then changes the file with its own tools, the server would compute against the old text and B
 * would write back old text plus edits — the change would be silently gone. Reconciling uses `didChange` only where the disk
 * differs; a file that no longer exists is closed. `buffer`: also the documents of an editor buffer (only the agents' write path
 * — it writes to disk); the editor leaves buffers alone, they belong to it. In a copy B reads through its container
 * (lsp/limit.js readDiskAgent).
 */
export async function diskReconcile(s, target, { buffer = false } = {}) {
  for (const d of [...s.documents.values()]) {
    if (d.source !== "disk" && !buffer) continue;
    let text = null;
    try { text = await readDiskAgent(target, d.abs); } catch { text = null; }
    // An await lay in between: a document that has since been closed or replaced or (editor) belongs to a buffer stays.
    if (s.documents.get(d.uri) !== d || (!buffer && d.source !== "disk")) continue;
    if (text === null) { closeDocument(s, d.abs, null); continue; }
    if (d.source === "disk" && d.text === text) continue;
    documentReconcile(s, { abs: d.abs, text, languageId: d.languageId });
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function markdownOf(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(markdownOf).filter(Boolean).join("\n\n");
  if (typeof content === "object") {
    if (typeof content.kind === "string") return String(content.value ?? "");
    if (typeof content.language === "string") return `\`\`\`${content.language}\n${content.value ?? ""}\n\`\`\``;
    if (typeof content.value === "string") return content.value;
  }
  return "";
}
// Location | Location[] | LocationLink[] | null → [{ uri, range }]
function locationsOf2(r) {
  const list = Array.isArray(r) ? r : r ? [r] : [];
  return list.map((x) => (x?.targetUri ? { uri: x.targetUri, range: x.targetSelectionRange || x.targetRange } : x?.uri ? { uri: x.uri, range: x.range } : null)).filter((x) => x && x.range);
}
function locationsOf(s, target, r) {
  const seen = new Set();
  const out = [];
  for (const o of locationsOf2(r)) {
    const k = `${o.uri}#${o.range.start.line}:${o.range.start.character}-${o.range.end.line}:${o.range.end.character}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const l = locationOf(s, target, o.uri, o.range);
    if (l) out.push(l);
  }
  return out;
}
const diagnosticOf = (x) => ({
  range: x.range, severity: Number.isInteger(x.severity) ? x.severity : 1, message: String(x.message ?? ""),
  ...(x.source ? { source: String(x.source) } : {}),
  ...(typeof x.code === "string" || typeof x.code === "number" ? { code: x.code } : {}),
});
// `labelDetail`/`description` are `labelDetails` from LSP 3.17 (VS Code shows one dimmed behind the name, the other on the right
// of the row); `detail` is ONLY `detail` (VS Code unfolds the docs only if `documentation` or a `detail` ≠ name is there — the
// fallback to `labelDetails.detail` is computed by the agents themselves, lsp/agents.js). `resolve`: the identifier with which
// `completion_resolve` fetches detail, docs and additional edits later — only if the server can resolve
// (typescript-language-server delivers them only there). `additionalTextEdits`: e.g. the import of an auto-import — the editor
// applies them along with accepting; `command` only if the editor runs it itself (SUGGESTION_COMMANDS).
const additionOf = (eds) => (Array.isArray(eds) ? eds : [])
  .filter((e) => e?.range?.start && e?.range?.end && typeof e.newText === "string")
  .map((e) => ({ range: { start: e.range.start, end: e.range.end }, newText: e.newText }));
const commandOf = (c) => (c && typeof c === "object" && SUGGESTION_COMMANDS.includes(c.command) ? c.command : null);
function completionOf(it, resolve) {
  const addition = additionOf(it.additionalTextEdits);
  const command = commandOf(it.command);
  const te = it.textEdit;
  const range = te ? (te.range || te.insert || null) : null;
  const insertText = te?.newText ?? it.insertText;
  return {
    label: typeof it.label === "string" ? it.label : String(it.label ?? ""),
    ...(Number.isInteger(it.kind) ? { kind: it.kind } : {}),
    ...(it.detail ? { detail: String(it.detail) } : {}),
    ...(it.labelDetails?.detail ? { labelDetail: String(it.labelDetails.detail) } : {}),
    ...(it.labelDetails?.description ? { description: String(it.labelDetails.description) } : {}),
    ...(it.documentation ? { documentation: markdownOf(it.documentation) } : {}),
    ...(typeof insertText === "string" ? { insertText } : {}),
    ...(range ? { range } : {}),
    ...(it.sortText ? { sortText: String(it.sortText) } : {}),
    ...(it.filterText ? { filterText: String(it.filterText) } : {}),
    ...(it.insertTextFormat === 2 ? { snippet: true } : {}),
    ...(it.deprecated === true || (Array.isArray(it.tags) && it.tags.includes(1)) ? { deprecated: true } : {}),
    ...(addition.length ? { additionalTextEdits: addition } : {}),
    ...(command ? { command } : {}),
    ...(resolve ? { resolve } : {}),
  };
}
/** Does `pattern` (typed) fit into `text` as a subsequence, ignoring case? A SUPERSET of what the editor shows afterwards (VS Code
 *  `fuzzyScore` demands more) — so cutting a long list drops nothing the editor would have shown. */
export function matchesFuzzy(pattern, text) {
  const m = String(pattern).toLowerCase(), t = String(text).toLowerCase();
  let i = 0;
  for (let j = 0; i < m.length && j < t.length; j++) if (t[j] === m[i]) i++;
  return i === m.length;
}
// A parameter's docs sit on IT (VS Code shows them above the docs of the signature).
function signatureOf(sig) {
  const label = String(sig?.label ?? "");
  let fromIdx = 0;
  const parameters = (sig?.parameters || []).map((p) => {
    const docs = p?.documentation ? markdownOf(p.documentation) : "";
    const including = (x) => (docs ? { ...x, documentation: docs } : x);
    if (Array.isArray(p.label)) return including({ label: [p.label[0], p.label[1]] });
    const name = String(p.label ?? "");
    const i = name ? label.indexOf(name, fromIdx) : -1;
    if (i < 0) return including({ label: [0, 0] });
    fromIdx = i + name.length;
    return including({ label: [i, i + name.length] });
  });
  return { label, ...(sig?.documentation ? { documentation: markdownOf(sig.documentation) } : {}), parameters, ...(Number.isInteger(sig?.activeParameter) ? { activeParameter: sig.activeParameter } : {}) };
}
// Hierarchical (DocumentSymbol) stays; flat (SymbolInformation) is nested through `containerName`.
function layoutOf(r) {
  const list = Array.isArray(r) ? r : [];
  if (!list.length) return [];
  if (list[0]?.selectionRange) {
    const tree = (x) => ({
      name: String(x.name ?? ""), kind: x.kind, ...(x.detail ? { detail: String(x.detail) } : {}), range: x.range, selectionRange: x.selectionRange,
      ...(Array.isArray(x.children) && x.children.length ? { children: x.children.map(tree) } : {}),
    });
    return list.map(tree);
  }
  const root = [];
  const byName = new Map();
  for (const x of list) {
    const node = { name: String(x.name ?? ""), kind: x.kind, range: x.location?.range, selectionRange: x.location?.range };
    const parent = x.containerName ? byName.get(x.containerName) : null;
    if (parent) (parent.children ||= []).push(node); else root.push(node);
    if (!byName.has(node.name)) byName.set(node.name, node);
  }
  return root;
}

// ── Call hierarchy: `data` is the server's raw item, signed per session (the client returns it unchanged) ──
const KEY = crypto.randomBytes(32);
const signature = (s, j) => crypto.createHmac("sha256", KEY).update(`${s.key}\0${j}`).digest("base64url");
function pack(s, raw) { const j = Buffer.from(JSON.stringify(raw)).toString("base64url"); return `${j}.${signature(s, j)}`; }
function unpack(s, data) {
  const [j, sig] = String(data || "").split(".");
  const desired = j ? Buffer.from(signature(s, j)) : null;
  const actual = Buffer.from(String(sig || ""));
  if (!desired || desired.length !== actual.length || !crypto.timingSafeEqual(desired, actual)) {
    throw new LspError(409, { code: "STALE_ACTION", error: T("The call hierarchy item belongs to an earlier server state — open it again.") });
  }
  return JSON.parse(Buffer.from(j, "base64url").toString("utf8"));
}
function callElement(s, target, raw) {
  const location = locationOf(s, target, raw.uri, raw.range);
  if (!location) return null;
  return {
    name: String(raw.name ?? ""), kind: raw.kind, ...(raw.detail ? { detail: String(raw.detail) } : {}),
    file: location.file, range: raw.range, selectionRange: raw.selectionRange || raw.range, ...(location.external ? { external: location.external } : {}),
    data: pack(s, raw),
  };
}
async function calls(s, target, raw, direction) {
  const r = await s.v.request(direction === "outgoing" ? "callHierarchy/outgoingCalls" : "callHierarchy/incomingCalls", { item: raw });
  return (Array.isArray(r) ? r : []).map((c) => {
    const el = callElement(s, target, direction === "outgoing" ? c.to : c.from);
    return el ? { item: el, ranges: Array.isArray(c.fromRanges) ? c.fromRanges : [] } : null;
  }).filter(Boolean);
}

// ── Code actions: B keeps the raw ones for 5 min under an id ─────────────────────────────────────────────────────────────
function rememberAction(s, raw) {
  const id = crypto.randomBytes(9).toString("base64url");
  s.actions.set(id, { raw, at: Date.now() });
  return id;
}
const overlaps = (a, b) => !(a.end.line < b.start.line || (a.end.line === b.start.line && a.end.character < b.start.character)
  || b.end.line < a.start.line || (b.end.line === a.start.line && b.end.character < a.start.character));
const KINDS = { quickfix: "quickfix", refactor: "refactor", source: "source" };
/** The kinds `code_actions` filters by (`kinds`) — the second copy in the MCP (`cbase_lsp`/`_edit`) is bound by test/mcp-schema.test.js. */
export const CODE_ACTION_KINDS = Object.freeze(Object.keys(KINDS));

// Run a command and CAPTURE the server's `workspace/applyEdit` meanwhile (lsp/sessions.js wire) — one after another per session.
function withFang(s, fn) {
  const run = (s.fangChain || Promise.resolve()).then(async () => {
    s.fang = [];
    try { await fn(); return s.fang; } finally { s.fang = null; }
  });
  s.fangChain = run.catch(() => {});
  return run;
}
// The smallest ONE change that turns `alt` into `fresh` (common start and common end stay) — never in the middle of `\r\n`.
function oneChange(old, fresh) {
  let a = 0;
  while (a < old.length && a < fresh.length && old.charCodeAt(a) === fresh.charCodeAt(a)) a++;
  let e = 0;
  while (e < old.length - a && e < fresh.length - a && old.charCodeAt(old.length - 1 - e) === fresh.charCodeAt(fresh.length - 1 - e)) e++;
  if (a > 0 && old.charCodeAt(a - 1) === 13 && old.charCodeAt(a) === 10) a--;
  if (e > 0 && old.charCodeAt(old.length - e - 1) === 13 && old.charCodeAt(old.length - e) === 10) e--;
  return { range: { start: positionOf(old, a), end: positionOf(old, old.length - e) }, newText: fresh.slice(a, fresh.length - e) };
}
/**
 * Several WorkspaceEdits (the action's edit, then every captured `workspace/applyEdit`) into ONE. They apply IN SEQUENCE (LSP:
 * the client applies each before the next arrives — the second computes on the state after the first), so they must not simply
 * be concatenated per file and applied against the starting text. If only ONE edit hits a file, it stays; if several do, B
 * computes them in sequence on the text of the session's document (exactly the one the server knows) and returns ONE change per
 * file. If the session does not know the file, the starting text is unknown ⇒ 409, nothing. A resource operation (`kind`) stays
 * in `documentChanges` — lsp/limit.js checkEdit rejects it (403 OUTSIDE).
 */
function unite(s, edits) {
  const followUp = new Map(); // uri → [edits per WorkspaceEdit]
  const alongside = (uri, ed) => { if (!followUp.has(uri)) followUp.set(uri, []); followUp.get(uri).push(Array.isArray(ed) ? ed : []); };
  for (const e of edits) {
    if (!e) continue;
    if (Array.isArray(e.documentChanges)) {
      const byKey = new Map();
      for (const dc of e.documentChanges) {
        if (dc?.kind) return { documentChanges: [dc] };
        if (dc?.textDocument?.uri) { if (!byKey.has(dc.textDocument.uri)) byKey.set(dc.textDocument.uri, []); byKey.get(dc.textDocument.uri).push(...(dc.edits || [])); }
      }
      for (const [uri, ed] of byKey) alongside(uri, ed);
    } else {
      for (const [uri, ed] of Object.entries(e.changes || {})) alongside(uri, ed);
    }
  }
  const changes = {};
  for (const [uri, steps] of followUp) {
    const full = steps.filter((ed) => ed.length);
    if (full.length <= 1) { changes[uri] = full[0] || []; continue; }
    const base = s.documents.get(uri)?.text;
    if (typeof base !== "string") {
      throw new LspError(409, { code: "EDIT_FOLLOW_UP", error: T`The code action changes ${uri} in ${full.length} steps and the starting text is unknown — nothing applied.` });
    }
    let text = base;
    try { for (const ed of full) text = applyEdits(text, ed); }
    catch (e) { throw new LspError(409, { code: "EDIT_FOLLOW_UP", error: T`The steps of the code action on ${uri} do not fit together (${e?.message || e}) — nothing applied.` }); }
    changes[uri] = text === base ? [] : [oneChange(base, text)];
  }
  return { changes };
}
/** Resolve and apply a server's raw code action → the WorkspaceEdit (B writes nothing; see withFang). */
export async function applyCodeAction(s, raw) {
  const collecting = [];
  let command = null;
  if (typeof raw?.command === "string") command = raw;
  else {
    let current = raw;
    if (!current.edit && (s.caps?.codeActionProvider?.resolveProvider || s.registered.has("codeAction/resolve"))) {
      current = (await s.v.request("codeAction/resolve", raw)) || raw;
    }
    if (current.edit) collecting.push(current.edit);
    if (current.command && typeof current.command === "object") command = current.command;
  }
  if (command) {
    const caught = await withFang(s, () => s.v.request("workspace/executeCommand", { command: command.command, arguments: command.arguments || [] }));
    collecting.push(...caught);
  }
  return collecting.length === 1 ? collecting[0] : unite(s, collecting);
}

/** A server's raw code actions for `range` (with the diagnostics touching the range) — editor and agents. */
export async function rawCodeActions(s, d, range, kinds) {
  const only = Array.isArray(kinds) ? kinds.map((k) => KINDS[k]).filter(Boolean) : [];
  const diagnostics = (s.diagnostics.get(d.uri)?.items || []).filter((x) => x?.range && overlaps(x.range, range));
  const r = await s.v.request("textDocument/codeAction", { textDocument: td(d), range, context: { diagnostics, ...(only.length ? { only } : {}), triggerKind: 1 } });
  return Array.isArray(r) ? r : [];
}

/**
 * Formatting — editor and agents: first the project's formatter (`setFormatter`, lsp/formatter.js; in the project container),
 * otherwise the server's, otherwise `{ supported: false, reason: "missing" }`. → `{ edits, formatter }` (the edits against `d.text`).
 */
export async function formatDocument(target, s, d, kind, range, options = {}) {
  if (formatter) {
    const r = await formatter({ target, language: kind.language, abs: target.abs, text: d.text, range, session: s });
    if (r) return r;
  }
  const can = range ? Boolean(s.caps?.documentRangeFormattingProvider) : Boolean(s.caps?.documentFormattingProvider);
  if (!can) return { supported: false, reason: "missing" };
  const opt = { tabSize: Number.isInteger(options.tabSize) ? options.tabSize : 2, insertSpaces: options.insertSpaces !== false };
  const r = await s.v.request(range ? "textDocument/rangeFormatting" : "textDocument/formatting", { textDocument: td(d), ...(range ? { range } : {}), options: opt });
  return { edits: (Array.isArray(r) ? r : []).map((e) => ({ range: e.range, newText: String(e.newText ?? "") })), formatter: "server" };
}

// ── Editor ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const EDITOR = {
  async status(target, body) {
    if (target?.reason) return { languages: [] };
    let languages = LANGUAGES;
    if (body?.file) { const kind = languageOf(body.file); if (!kind) return { languages: [] }; languages = [kind.language]; }
    const list = statusOf(target, languages);
    if (statusAddition) for (const e of list) { try { Object.assign(e, statusAddition(target, e) || {}); } catch { /* without the addition */ } }
    return { languages: list };
  },
  async diagnostics(target, body) {
    const { s, d } = await withDocument(target, body);
    return { diagnostics: (await diagnosticsOf(s, d)).map(diagnosticOf) };
  },
  // `agent` (lsp/agents.js): an agent's list does not replace the editor's and is not resolvable.
  async completions(target, body, { agent = false } = {}) {
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    const trig = typeof body.trigger === "string" && body.trigger ? { triggerKind: 2, triggerCharacter: body.trigger } : { triggerKind: 1 };
    const r = await s.v.request("textDocument/completion", { textDocument: td(d), position: pos, context: trig });
    const items = Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : [];
    // Above the cap, filter by the typed word first (typescript-language-server returns ≈ 1,500 entries at the top of a file with
    // DOM, auto-imports last — merely cut off, a symbol from another file would never show). VS Code filters itself; the
    // subsequence here is a superset of that. What drops makes the list incomplete: the editor asks again while typing.
    const row = d.text.slice(offsetOf(d.text, { line: pos.line, character: 0 }), offsetOf(d.text, pos));
    const typed = /[\p{L}\p{N}_$]*$/u.exec(row)[0];
    const filtered = items.length > COMPLETION_CAP && typed ? items.filter((it) => matchesFuzzy(typed, it.filterText || it.label || "")) : items;
    const list = filtered.slice(0, COMPLETION_CAP);
    // Only the editor's LATEST list is resolvable (as in VS Code: the entry that is currently selected gets resolved).
    const canResolve = !agent && Boolean(s.caps?.completionProvider?.resolveProvider);
    const seq = canResolve ? (s.suggestionSeq = (s.suggestionSeq || 0) + 1) : 0;
    if (!agent) s.suggestions = canResolve ? { seq, uri: d.uri, items: list } : null;
    return { items: list.map((it, i) => completionOf(it, canResolve ? `${seq}:${i}` : null)), incomplete: Boolean(r?.isIncomplete) || list.length < items.length };
  },
  // `completionItem/resolve` for an entry of the latest list: `{ resolved: true, detail?, documentation?, additionalTextEdits?,
  // command? }`; an older list or an unknown entry ⇒ `{ resolved: false }` (empty is not "no docs").
  async completion_resolve(target, body) {
    const { s, d } = await withDocument(target, body);
    const m = /^(\d+):(\d+)$/.exec(String(body?.resolve ?? ""));
    const list = s.suggestions;
    if (!m || !list || list.seq !== Number(m[1]) || list.uri !== d.uri || !list.items[Number(m[2])]) return { resolved: false };
    const raw = list.items[Number(m[2])];
    const r = (await s.v.request("completionItem/resolve", raw)) || raw;
    const addition = additionOf(r.additionalTextEdits ?? raw.additionalTextEdits), command = commandOf(r.command ?? raw.command);
    return {
      resolved: true, ...(r.detail ? { detail: String(r.detail) } : {}), ...(r.documentation ? { documentation: markdownOf(r.documentation) } : {}),
      ...(addition.length ? { additionalTextEdits: addition } : {}), ...(command ? { command } : {}),
    };
  },
  // Semantic tokens (`textDocument/semanticTokens/full`): the server's legend and the raw numbers (relatively encoded, five per
  // token) — the editor computes position and color (web/src/lib/semantics.ts). Without the capability an empty legend and no
  // tokens; a response that does not consist of whole fives of non-negative integers yields no tokens (one shifted number would
  // color everything after it wrongly). If the client leaves before the response is there (`signal` — VS Code aborts on every
  // change), the server gets `$/cancelRequest`.
  async semantic_tokens(target, body, { signal = null } = {}) {
    const { s, d } = await withDocument(target, body);
    if (!capabilitiesOf(s).includes("semantic_tokens")) return { legend: { types: [], modifiers: [] }, data: [] };
    const legend = s.caps.semanticTokensProvider.legend;
    const r = await s.v.request("textDocument/semanticTokens/full", { textDocument: td(d) }, { signal });
    const intact = Array.isArray(r?.data) && r.data.length % 5 === 0 && r.data.every((x) => Number.isInteger(x) && x >= 0);
    return {
      legend: { types: (legend.tokenTypes || []).map(String), modifiers: (legend.tokenModifiers || []).map(String) },
      data: intact ? r.data : [],
    };
  },
  async hover(target, body) {
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    const r = await s.v.request("textDocument/hover", { textDocument: td(d), position: pos });
    const text = r ? markdownOf(r.contents) : "";
    return text ? { contents: text, ...(r.range ? { range: r.range } : {}) } : { contents: null };
  },
  // The trigger as in VS Code (B announces `contextSupport`): a trigger character (`trigger`), with open hints a re-query
  // (`retrigger` — with a character or as a content change), otherwise manual.
  async signature_help(target, body) {
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    const character = typeof body.trigger === "string" && body.trigger.length > 0 && body.trigger.length <= 4 ? body.trigger : null;
    const isRetrigger = body.retrigger === true;
    const context = character ? { triggerKind: 2, triggerCharacter: character, isRetrigger } : { triggerKind: isRetrigger ? 3 : 1, isRetrigger };
    const r = await s.v.request("textDocument/signatureHelp", { textDocument: td(d), position: pos, context });
    if (!r || !Array.isArray(r.signatures) || !r.signatures.length) return { signatures: [] };
    const active = Number.isInteger(r.activeSignature) ? r.activeSignature : 0;
    const sig = r.signatures[active];
    return { signatures: r.signatures.map(signatureOf), active, activeParameter: Number.isInteger(sig?.activeParameter) ? sig.activeParameter : Number.isInteger(r.activeParameter) ? r.activeParameter : 0 };
  },
  definition: (target, body) => locationsRequest(target, body, "textDocument/definition"),
  // The link at the position (VS Code: the editor's link provider, `documentLink` + `documentLink/resolve`) — ⌘-click follows it.
  // `{ link: null }` or `{ link: { range, target } }`, `target` one of: `{ kind: "file", location }` (file, position from
  // `#L<line>,<col>`), `{ kind: "folder", file }` (folder IN the instance — the editor shows it in the Explorer),
  // `{ kind: "web", url }` (http/https/mailto only).
  async link(target, body) {
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    if (!capabilitiesOf(s).includes("document_link")) return { link: null };
    return { link: await linkAt(s, target, d, pos) };
  },
  // The colors of the file (`textDocument/documentColor`, VS Code `ColorDetector`) — at most COLORS_CAP (VS Code
  // `editor.colorDecoratorsLimit`, default 500), channels 0…1 as in LSP.
  async colors(target, body, { signal = null } = {}) {
    const { s, d } = await withDocument(target, body);
    if (!capabilitiesOf(s).includes("document_color")) return { colors: [] };
    const r = await s.v.request("textDocument/documentColor", { textDocument: td(d) }, { signal });
    return { colors: colorsOf(r) };
  },
  // The notations of a color (`textDocument/colorPresentation`, VS Code `getColorPresentations` in the color picker) — the picker
  // shows the chosen one as its header, a click switches to the next, releasing writes it (`textEdit`, otherwise `label` over
  // `range`). `{ presentations: [{ label, textEdit?, additionalTextEdits? }] }`, at most COLOR_NOTATIONS_CAP; empty without the capability.
  async color_presentation(target, body) {
    const { s, d } = await withDocument(target, body);
    if (!capabilitiesOf(s).includes("document_color")) return { presentations: [] };
    const c = body?.color, rg = body?.range;
    if (!c || !["red", "green", "blue", "alpha"].every((k) => channel(c[k]))) throw missing("color");
    if (!areaIntact(rg)) throw missing("range");
    const r = await s.v.request("textDocument/colorPresentation", {
      textDocument: td(d), color: { red: c.red, green: c.green, blue: c.blue, alpha: c.alpha }, range: { start: rg.start, end: rg.end },
    });
    return { presentations: notationsOf(r) };
  },
  type_definition: (target, body) => locationsRequest(target, body, "textDocument/typeDefinition"),
  implementations: (target, body) => locationsRequest(target, body, "textDocument/implementation"),
  references: (target, body) => locationsRequest(target, body, "textDocument/references", { context: { includeDeclaration: true } }),
  async source_definition(target, body) {
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    if (!capabilitiesOf(s).includes("source_definition")) return { locations: [] };
    const r = await s.v.request("workspace/executeCommand", { command: "_typescript.goToSourceDefinition", arguments: [d.uri, pos] });
    return { locations: locationsOf(s, target, r) };
  },
  async call_hierarchy(target, body) {
    const direction = body.direction === "outgoing" ? "outgoing" : "incoming";
    if (body.item) {
      if (target?.reason) throw new LspNot(target.reason);
      const kind = languageOf(target?.abs);
      if (!kind) throw new LspNot("no_language");
      const s = await sessionFor(target, kind.language);
      const raw = unpack(s, body.item.data);
      return { calls: await calls(s, target, raw, direction) };
    }
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    const r = await s.v.request("textDocument/prepareCallHierarchy", { textDocument: td(d), position: pos });
    const raw = Array.isArray(r) && r.length ? r[0] : null;
    if (!raw) return { root: null, calls: [] };
    return { root: callElement(s, target, raw), calls: await calls(s, target, raw, direction) };
  },
  async highlights(target, body) {
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    const r = await s.v.request("textDocument/documentHighlight", { textDocument: td(d), position: pos });
    return { ranges: (Array.isArray(r) ? r : []).map((h) => h?.range).filter(Boolean) };
  },
  async outline(target, body) {
    const { s, d } = await withDocument(target, body);
    return { symbols: layoutOf(await s.v.request("textDocument/documentSymbol", { textDocument: td(d) })) };
  },
  async workspace_symbols(target, body) {
    if (target?.reason) return { symbols: [] };
    const query = String(body.query ?? "");
    const sessions = runningSessions(target).filter((s) => !body.language || s.language === body.language);
    const symbols = [];
    let clipped = false;
    for (const s of sessions) {
      let r;
      try { r = await s.v.request("workspace/symbol", { query }); } catch { continue; }
      for (const x of Array.isArray(r) ? r : []) {
        if (symbols.length >= SYMBOL_CAP) { clipped = true; break; }
        const range = x.location?.range || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        const loc = x.location?.uri ? locationOf(s, target, x.location.uri, range) : null;
        if (!loc) continue;
        symbols.push({ name: String(x.name ?? ""), kind: x.kind, ...(x.containerName ? { container: String(x.containerName) } : {}), location: loc });
      }
    }
    return { symbols, ...(clipped ? { truncated: true } : {}) };
  },
  async prepare_rename(target, body) {
    const pos = position(body.position);
    const { s, d } = await withDocument(target, body);
    const byWord = () => { const w = wordAt(d.text, pos); return w ? { range: w.range, placeholder: w.text } : { error: T("Nothing to rename here") }; };
    if (!s.caps?.renameProvider?.prepareProvider) return capabilitiesOf(s).includes("rename") ? byWord() : { error: T("This language server does not rename") };
    let r;
    try { r = await s.v.request("textDocument/prepareRename", { textDocument: td(d), position: pos }); }
    catch (e) { if (e?.code === "EDEADLINE" || e?.code === "EEND") throw e; return { error: String(e?.message || e) }; }
    if (!r) return { error: T("Nothing to rename here") };
    if (r.defaultBehavior) return byWord();
    const range = r.range || r;
    if (!range?.start) return byWord();
    const anf = offsetOf(d.text, range.start), end = offsetOf(d.text, range.end);
    return { range, placeholder: typeof r.placeholder === "string" ? r.placeholder : d.text.slice(anf, end) };
  },
  async rename(target, body) {
    const pos = position(body.position);
    const fresh = typeof body.newName === "string" ? body.newName.trim() : "";
    if (!fresh) throw missing("newName");
    const { s, d } = await withDocument(target, body);
    await diskReconcile(s, target);
    let r;
    try { r = await s.v.request("textDocument/rename", { textDocument: td(d), position: pos, newName: fresh }); }
    catch (e) { if (e?.code === "EDEADLINE" || e?.code === "EEND") throw e; throw new LspError(400, { error: String(e?.message || e) }); }
    return { edit: r ? editForClient(s, target, r) : { changes: [] } };
  },
  async code_actions(target, body) {
    const range = areaOf(body.range);
    const { s, d } = await withDocument(target, body);
    const actions = (await rawCodeActions(s, d, range, body.kinds)).map((a) => ({
      id: rememberAction(s, a), title: String(a.title ?? ""),
      ...(typeof a.kind === "string" ? { kind: a.kind } : {}), ...(a.isPreferred ? { preferred: true } : {}),
      ...(a.disabled?.reason ? { disabled: String(a.disabled.reason) } : {}),
    }));
    return { actions };
  },
  async code_action_apply(target, body) {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) throw missing("id");
    if (target?.reason) throw new LspNot(target.reason);
    const candidates = runningSessions(target);
    const s = candidates.find((x) => x.actions.has(id));
    const entry = s?.actions.get(id);
    if (!s || !entry || Date.now() - entry.at > CODE_ACTION_HOLD_MS) {
      throw new LspError(409, { code: "STALE_ACTION", error: T("The code action has expired — fetch the list again.") });
    }
    s.actions.delete(id);
    await diskReconcile(s, target);
    const edit = await applyCodeAction(s, entry.raw);
    return { edit: editForClient(s, target, edit) };
  },
  async format(target, body) {
    const range = body.range ? areaOf(body.range) : null;
    const { s, d, kind } = await withDocument(target, body);
    return await formatDocument(target, s, d, kind, range, body);
  },
  async read(target, body) {
    const e = target?.reason ? null : externalTarget(target, body.token);
    if (!e) throw new LspError(403, { code: "NOT_NAMED", error: T("No language server named this target (or the token expired).") });
    let text;
    try { text = await readExternal(e); } catch (f) { throw new LspError(f?.code === "ENOENT" ? 404 : 400, { error: String(f?.message || f) }); }
    return { path: e.abs, text, language: languageOf(e.abs)?.language ?? null };
  },
  async close(target, body) {
    if (target?.reason || !target?.abs) return { ok: true };
    const kind = languageOf(target.abs);
    const s = kind ? runningSession(target, kind.language) : null;
    if (s) closeDocument(s, target.abs, body.buffer ? String(body.buffer) : null);
    return { ok: true };
  },
  // Only the reconcile: didOpen/didChange with the buffer, starts the server like `diagnostics` — before a rename the editor uses
  // it to reconcile unsaved buffers the server does not know yet.
  async sync(target, body) {
    await withDocument(target, body);
    return { ok: true };
  },
  // The buttons of the status bar. On the workspace level only `file` determines the project (devtools/code-route.js lspTargetFor
  // — without a file `no_project`); if `language` is missing, the file's applies.
  async restart(target, body) {
    if (target?.reason) throw new LspNot(target.reason);
    const language = languageTheButtons(target, body);
    await restart(target, language);
    return { ok: true };
  },
  async stop(target, body) {
    if (target?.reason) throw new LspNot(target.reason);
    stopSession(target, languageTheButtons(target, body));
    return { ok: true };
  },
  async interpreter(target, body) {
    if (!interpreterMachine) throw new LspError(501, { error: T("Choosing the interpreter is not built yet.") });
    if (target?.reason) throw new LspNot(target.reason);
    return await interpreterMachine(target, body);
  },
};

function languageTheButtons(target, body) {
  if (body.language !== undefined && body.language !== null && body.language !== "") {
    if (!LANGUAGES.includes(body.language)) throw missing("language");
    return body.language;
  }
  const kind = target?.abs ? languageOf(target.abs) : null;
  if (!kind) throw missing("language");
  return kind.language;
}

async function locationsRequest(target, body, method, extra = {}) {
  const pos = position(body.position);
  const { s, d } = await withDocument(target, body);
  const r = await s.v.request(method, { textDocument: td(d), position: pos, ...extra });
  // NO fallback to the link — like VS Code, the definition of a Markdown file knows only anchors and references; a file link is
  // followed by ⌘-click through `link` (F12 reports "no definition" there).
  return { locations: locationsOf(s, target, r) };
}

const contains = (r, p) => {
  const before = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return Boolean(r?.start && r?.end) && before(r.start, p) && before(p, r.end);
};

/** VS Code `editor.colorDecoratorsLimit` (default 500): further colors of a file get no square. */
export const COLORS_CAP = 500;
const channel = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
/** The response of `textDocument/documentColor` → `[{ range, color: { red, green, blue, alpha } }]` — intact entries only, capped. */
export function colorsOf(r) {
  const out = [];
  for (const x of Array.isArray(r) ? r : []) {
    const c = x?.color, rg = x?.range;
    if (!rg?.start || !rg?.end || !c || !["red", "green", "blue", "alpha"].every((k) => channel(c[k]))) continue;
    out.push({ range: { start: rg.start, end: rg.end }, color: { red: c.red, green: c.green, blue: c.blue, alpha: c.alpha } });
    if (out.length >= COLORS_CAP) break;
  }
  return out;
}

const setIntact = (p) => Boolean(p) && Number.isInteger(p.line) && Number.isInteger(p.character) && p.line >= 0 && p.character >= 0;
const areaIntact = (r) => Boolean(r) && setIntact(r.start) && setIntact(r.end);
/** B passes on at most this many notations of a color (the CSS server delivers three: rgb, hex, hsl). */
export const COLOR_NOTATIONS_CAP = 16;
/** The response of `textDocument/colorPresentation` → `[{ label, textEdit?, additionalTextEdits? }]` — intact entries only, capped. */
export function notationsOf(r) {
  const out = [];
  for (const x of Array.isArray(r) ? r : []) {
    if (!x || typeof x.label !== "string" || !x.label) continue;
    const te = x.textEdit && areaIntact(x.textEdit.range) && typeof x.textEdit.newText === "string"
      ? { range: { start: x.textEdit.range.start, end: x.textEdit.range.end }, newText: x.textEdit.newText } : null;
    const addition = additionOf(x.additionalTextEdits).filter((e) => areaIntact(e.range));
    out.push({ label: x.label, ...(te ? { textEdit: te } : {}), ...(addition.length ? { additionalTextEdits: addition } : {}) });
    if (out.length >= COLOR_NOTATIONS_CAP) break;
  }
  return out;
}

const WEB = /^(https?:|mailto:)/i;
// A command target of the Markdown server (`command:<command>?<JSON of the arguments>`, documentLinks.ts `#createCommandUri`).
function commandTarget(target) {
  const m = /^command:([\w.]+)\?(.*)$/s.exec(target);
  if (!m) return null;
  let args;
  try { args = JSON.parse(decodeURIComponent(m[2])); } catch { return null; }
  return Array.isArray(args) ? { command: m[1], args } : null;
}
// A URI object from the JSON of a command (`vscode-uri` `toJSON`: `{ scheme, path, … }`) → absolute path or null.
const pathFromUriJson = (u) => (u && typeof u === "object" && u.scheme === "file" && typeof u.path === "string" ? (u.fsPath && typeof u.fsPath === "string" ? u.fsPath : decodeURIComponent(u.path)) : null);

/**
 * The link under the position, resolved the way VS Code opens it (documentLinks.ts `resolveDocumentLink`): a file (`file:` with
 * `#L<line>,<col>` or `command:vscodeMarkdownLanguageservice.open` with `selection`), a folder (`command:revealInExplorer`), a
 * web address. A file inside, or outside with a token (lsp/limit.js `locationOf`); a folder only inside (there is no tree
 * outside); any other scheme (`smb:`, `vscode:` …) opens nothing — like the chat (components/Markdown.tsx `LINK_TARGET`).
 */
async function linkAt(s, targetItem, d, pos) {
  let links;
  try { links = await s.v.request("textDocument/documentLink", { textDocument: td(d) }); } catch { return null; }
  const link = (Array.isArray(links) ? links : []).find((l) => contains(l?.range, pos));
  if (!link) return null;
  let target = typeof link.target === "string" ? link.target : null;
  if (!target && s.caps?.documentLinkProvider?.resolveProvider) {
    try { target = (await s.v.request("documentLink/resolve", link))?.target ?? null; } catch { target = null; }
  }
  if (typeof target !== "string") return null;
  const range = { start: link.range.start, end: link.range.end };
  const out = (t) => ({ range, target: t });
  if (WEB.test(target)) {
    try { const u = new URL(target); return out({ kind: "web", url: u.href }); } catch { return null; }
  }
  if (target.startsWith("file:")) {
    const [without, fragment = ""] = target.split("#");
    const m = /^L(\d+)(?:,(\d+))?/.exec(decodeURIComponent(fragment));
    const place = m ? { line: Math.max(0, Number(m[1]) - 1), character: Math.max(0, Number(m[2] || 1) - 1) } : { line: 0, character: 0 };
    if (!pathOfUri(without)) return null;
    const location = locationOf(s, targetItem, without, { start: place, end: place });
    return location ? out({ kind: "file", location }) : null;
  }
  const b = commandTarget(target);
  if (b?.command === "revealInExplorer") {
    const abs = typeof b.args[0] === "string" ? pathOfUri(b.args[0]) : pathFromUriJson(b.args[0]);
    const lex = abs ? inside(s, targetItem, abs) : null;
    const rel = lex && targetItem?.base ? relativeUnder(targetItem.base, lex) : null;
    return rel ? out({ kind: "folder", file: rel }) : null;
  }
  if (b?.command === "vscodeMarkdownLanguageservice.open") {
    const abs = pathFromUriJson(b.args[0]);
    const sel = b.args[1]?.selection;
    const place = sel?.start && Number.isInteger(sel.start.line) && Number.isInteger(sel.start.character) ? { line: sel.start.line, character: sel.start.character } : { line: 0, character: 0 };
    const location = abs ? locationOf(s, targetItem, uriOfPath(abs), { start: place, end: place }) : null;
    return location ? out({ kind: "file", location }) : null;
  }
  return null;
}

/** An editor action → body of the response; throws `LspNot`/`LspError` (see the header). `like`: `{ signal }` (the client left —
 *  lsp/routes.js) or `{ agent: true }` (lsp/agents.js). */
export async function editorAction(action, target, body = {}, like = {}) {
  if (!EDITOR_ACTIONS.includes(action) || !Object.hasOwn(EDITOR, action)) {
    throw new LspError(400, { code: "UNKNOWN_ACTION", error: T`Unknown action "${action}"` });
  }
  return await EDITOR[action](target, body || {}, like || {});
}
