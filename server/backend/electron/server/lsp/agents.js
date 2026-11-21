// The language service of the AGENTS — the computation behind `POST /api/lsp` (devtools/routes.js) and the MCP tools `cbase_lsp`
// (reading, AGENT_READ) and `cbase_lsp_edit` (writing, AGENT_CHANGE). The same computation as the editor (lsp/actions.js —
// editorAction and the exported building blocks), a different wrapper:
//
//   - NO BUFFER. An agent has none: B reads the file from disk (`source: "disk"`, lsp/limit.js readDiskAgent — in a COPY through
//     its container) and hands the text to the server.
//   - LINES AND COLUMNS 1-based (`line`, `column`; columns in UTF-16 units as in the editor), PATHS absolute. A location outside
//     the instance carries `external: true` (no token — an agent reads it with its file tools). Kinds (symbol, suggestion,
//     severity) as a WORD, not as the LSP number: a model does not know the tables.
//   - CAPS are reported: lists above their cap carry `truncated: true` (never a silent cut).
//   - READING: diagnostics, definition, type_definition, implementations, references, call_hierarchy (without `data` — one level;
//     to go deeper the agent asks at the position of a caller), hover, outline, completions (without docs), workspace_symbols
//     (opens the file so that the server of its project runs), code_actions (NUMBERED, `index` from 1, computed after the
//     diagnostics of the position).
//   - WRITING: rename, format, code_action (`index` from code_actions at the SAME position and with the same `kinds` — the list is
//     recomputed, not remembered). B writes to disk, ALL OR NOTHING (lsp/limit.js writeForAgent: a location outside ⇒ 403 OUTSIDE,
//     nothing written; the setup lock or a copy that is not ready, through `beforeWrite` ⇒ `{ changed: [], locked }`, the route
//     answers 409). Response `{ changed: [absolute paths] }` (format adds `formatter`, code_action adds `title`). Before a writing
//     action B reconciles EVERY document of the session with the disk (lsp/actions.js plattenReconcile with `buffer`) — that of an
//     unsaved editor buffer just like a `disk` document an agent read minutes ago and has since changed with its own tools
//     (otherwise B would write back the old text plus edits). The server then computes against the disk that is written to; if it
//     still changes before the write, lsp/limit.js answers 409 and writes nothing. The editor gets TEXT_MISSING on its next use
//     and sends its buffer again; a save by the human after that hits the 409 of the file write.
// Errors: `LspNot` (200 `{ supported: false, reason }`), `LspError` (status + body), server errors as in the editor (lsp/routes.js
// responseFromError).
import { T } from "../i18n.js";
import { AGENT_CHANGE, AGENT_READ } from "./contract.js";
import { LspError, diagnosticsOf, documentReconcile } from "./documents.js";
import { checkEdit, readDiskAgent, writeForAgent } from "./limit.js";
import { applyCodeAction, editorAction, formatDocument, withDocument, diskReconcile, rawCodeActions, languageOf } from "./actions.js";
import { isIdentifier, uriOfPath } from "./text.js";

/** At most this many entries per list to an agent (above that `truncated: true`). */
export const AGENT_CAP = Object.freeze({ diagnostics: 500, locations: 500, completions: 200, symbols: 1000, calls: 200 });

const SYMBOL_KIND = [null, "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface",
  "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum_member", "struct", "event", "operator", "type_parameter"];
const SUGGESTION_KIND = [null, "text", "method", "function", "constructor", "field", "variable", "class", "interface", "module", "property",
  "unit", "value", "enum", "keyword", "snippet", "color", "file", "reference", "folder", "enum_member", "constant", "struct", "event", "operator", "type_parameter"];
const SEVERITY = [null, "error", "warning", "info", "hint"];
const word = (table, k) => (Number.isInteger(k) && table[k]) || "other";

const missing = (field) => new LspError(400, { error: T`${field} missing` });

// 1-based (agent) ↔ 0-based (LSP).
function place(body, required = true) {
  const l = Number(body?.line), c = Number(body?.column);
  if (!Number.isInteger(l) || !Number.isInteger(c) || l < 1 || c < 1) {
    if (!required) return null;
    throw new LspError(400, { error: T("line and column (1-based) missing — this action needs a position") });
  }
  return { line: l - 1, character: c - 1 };
}
function areaOn(body) {
  const a = place(body);
  const el = Number(body?.endLine), ec = Number(body?.endColumn);
  const b = Number.isInteger(el) && Number.isInteger(ec) && el >= 1 && ec >= 1 ? { line: el - 1, character: ec - 1 } : a;
  return { start: a, end: b };
}
const pos = (p) => (p ? { line: p.line + 1, column: p.character + 1 } : null);
const ber = (r) => (r?.start ? { start: pos(r.start), end: pos(r.end || r.start) } : null);
const location = (l) => ({ file: l.file, range: ber(l.range), ...(l.external ? { external: true } : {}) });
function clipped(list, cap, field) {
  const l = Array.isArray(list) ? list : [];
  return l.length > cap ? { [field]: l.slice(0, cap), truncated: true } : { [field]: l };
}
const symbolTree = (x) => ({
  name: x.name, kind: word(SYMBOL_KIND, x.kind), ...(x.detail ? { detail: x.detail } : {}), range: ber(x.range), selectionRange: ber(x.selectionRange),
  ...(Array.isArray(x.children) && x.children.length ? { children: x.children.map(symbolTree) } : {}),
});
const callElement = (x) => (x ? {
  name: x.name, kind: word(SYMBOL_KIND, x.kind), ...(x.detail ? { detail: x.detail } : {}), file: x.file, range: ber(x.range), selectionRange: ber(x.selectionRange),
  ...(x.external ? { external: true } : {}),
} : null);
const count = (tree) => tree.reduce((n, x) => n + 1 + count(x.children || []), 0);

// Read the target's file and hand it to the server — the session starts on first use (lsp/sessions.js).
async function opened(target) {
  if (target?.reason) return withDocument(target, {});
  if (!target?.abs) throw missing("file");
  if (!languageOf(target.abs)) return withDocument(target, {});
  const text = await readDiskAgent(target, target.abs);
  return { text, ...(await withDocument(target, { diskText: text })) };
}

// Every document of the session to the state of the disk (header, WRITING).
const diskState = (s, target) => diskReconcile(s, target, { buffer: true });

// Write a server's WorkspaceEdit — all or nothing (lsp/limit.js); afterwards the server knows the new state.
async function writeEdit(s, target, edit) {
  const plan = checkEdit(s, target, edit).map((x) => {
    const d = s.documents.get(uriOfPath(x.abs)) || s.documents.get(uriOfPath(x.lex));
    return { lex: x.lex, edits: x.edits, ...(d && d.source === "disk" ? { text: d.text, doc: d } : {}) };
  });
  const w = await writeForAgent(target, plan.map(({ doc, ...p }) => p));
  if (w.locked) return { changed: [], locked: w.locked };
  for (const p of plan) {
    const fresh = w.texts?.get(p.lex);
    if (typeof fresh !== "string") continue;
    const kind = languageOf(p.lex);
    const abs = p.doc ? p.doc.abs : p.lex;
    if (kind && kind.language === s.language && (p.doc || w.changed.includes(p.lex))) {
      try { documentReconcile(s, { abs, text: fresh, languageId: p.doc?.languageId || kind.languageId }); } catch { /* next reconcile */ }
    }
  }
  return { changed: w.changed };
}

const READ = {
  async diagnostics(target) {
    const { s, d } = await opened(target);
    const list = (await diagnosticsOf(s, d)).map((x) => ({
      range: ber(x.range), severity: SEVERITY[x.severity] || "error", message: String(x.message ?? ""),
      ...(x.source ? { source: String(x.source) } : {}), ...(typeof x.code === "string" || typeof x.code === "number" ? { code: x.code } : {}),
    }));
    return clipped(list, AGENT_CAP.diagnostics, "diagnostics");
  },
  definition: (target, body) => locations(target, body, "definition"),
  type_definition: (target, body) => locations(target, body, "type_definition"),
  implementations: (target, body) => locations(target, body, "implementations"),
  references: (target, body) => locations(target, body, "references"),
  async hover(target, body) {
    const position = place(body);
    const { text } = await opened(target);
    const r = await editorAction("hover", target, { position, diskText: text });
    return r.contents ? { contents: r.contents, ...(r.range ? { range: ber(r.range) } : {}) } : { contents: null };
  },
  async outline(target) {
    const { text } = await opened(target);
    const r = await editorAction("outline", target, { diskText: text });
    const symbols = (r.symbols || []).map(symbolTree);
    return count(symbols) > AGENT_CAP.symbols ? { symbols: symbols.slice(0, AGENT_CAP.symbols), truncated: true } : { symbols };
  },
  async completions(target, body) {
    const position = place(body);
    const { text } = await opened(target);
    // `agent`: the list does not replace the editor's latest one (that is the resolvable one). `detail` falls back to
    // `labelDetails.detail` — the editor shows both separately, an agent reads only `detail`.
    const r = await editorAction("completions", target, { position, diskText: text }, { agent: true });
    const items = (r.items || []).map((it) => {
      const detail = it.detail || it.labelDetail;
      return { label: it.label, kind: word(SUGGESTION_KIND, it.kind), ...(detail ? { detail } : {}) };
    });
    const g = clipped(items, AGENT_CAP.completions, "items");
    return { ...g, incomplete: Boolean(r.incomplete) };
  },
  async call_hierarchy(target, body) {
    const position = place(body);
    const { text } = await opened(target);
    const direction = body.direction === "outgoing" ? "outgoing" : "incoming";
    const r = await editorAction("call_hierarchy", target, { position, direction, diskText: text });
    const calls = (r.calls || []).map((c) => ({ item: callElement(c.item), ranges: (c.ranges || []).map(ber) }));
    return { direction, root: callElement(r.root), ...clipped(calls, AGENT_CAP.calls, "calls") };
  },
  async workspace_symbols(target, body) {
    const query = typeof body.query === "string" ? body.query : "";
    const { kind } = await opened(target);
    const r = await editorAction("workspace_symbols", target, { query, language: kind.language });
    const symbols = (r.symbols || []).map((x) => ({ name: x.name, kind: word(SYMBOL_KIND, x.kind), ...(x.container ? { container: x.container } : {}), location: location(x.location) }));
    return { symbols, ...(r.truncated ? { truncated: true } : {}) };
  },
  async code_actions(target, body) {
    const range = areaOn(body);
    const { s, d } = await opened(target);
    await diagnosticsOf(s, d);
    const raw = await rawCodeActions(s, d, range, body.kinds);
    return {
      actions: raw.map((a, i) => ({
        index: i + 1, title: String(a.title ?? ""), ...(typeof a.kind === "string" ? { kind: a.kind } : {}),
        ...(a.isPreferred ? { preferred: true } : {}), ...(a.disabled?.reason ? { disabled: String(a.disabled.reason) } : {}),
      })),
    };
  },
};

async function locations(target, body, action) {
  const position = place(body);
  const { text } = await opened(target);
  const r = await editorAction(action, target, { position, diskText: text });
  return clipped((r.locations || []).map(location), AGENT_CAP.locations, "locations");
}

const CHANGE = {
  async rename(target, body) {
    const fresh = typeof body.newName === "string" ? body.newName.trim() : "";
    if (!fresh) throw missing("newName");
    if (!isIdentifier(fresh)) throw new LspError(400, { error: T`"${fresh}" is not an identifier — the language service only renames to identifiers` });
    const position = place(body);
    const { s, d } = await opened(target);
    await diskState(s, target);
    let r;
    try { r = await s.v.request("textDocument/rename", { textDocument: { uri: d.uri }, position, newName: fresh }); }
    catch (e) { if (e?.code === "EDEADLINE" || e?.code === "EEND") throw e; throw new LspError(400, { error: String(e?.message || e) }); }
    if (!r) throw new LspError(400, { error: T("No renameable symbol at this position") });
    return await writeEdit(s, target, r);
  },
  async format(target) {
    const { s, d, kind } = await opened(target);
    await diskState(s, target);
    const f = await formatDocument(target, s, d, kind, null);
    if (f.supported === false) return f;
    if (!f.edits.length) return { changed: [], formatter: f.formatter };
    const w = await writeEdit(s, target, { changes: { [d.uri]: f.edits } });
    return { ...w, formatter: f.formatter };
  },
  async code_action(target, body) {
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 1) throw new LspError(400, { error: T("index missing — the number from code_actions at the same position (from 1)") });
    const range = areaOn(body);
    const { s, d } = await opened(target);
    await diskState(s, target);
    await diagnosticsOf(s, d);
    const raw = await rawCodeActions(s, d, range, body.kinds);
    const a = raw[index - 1];
    if (!a) throw new LspError(400, { error: T`There are ${raw.length} code action(s) at this position — index ${index} does not exist; fetch code_actions again.` });
    if (a.disabled?.reason) throw new LspError(400, { error: T`"${a.title}" is not available here: ${a.disabled.reason}` });
    const edit = await applyCodeAction(s, a);
    const w = await writeEdit(s, target, edit);
    return { ...w, title: String(a.title ?? "") };
  },
};

/**
 * An agent action (see the header). `target` as in the editor, but `base` null and `abs` the file of the request (absolute).
 * `body`: `{ line?, column?, endLine?, endColumn?, newName?, query?, direction?, kinds?, index? }`.
 */
export async function agentAction(action, target, body = {}) {
  const b = body && typeof body === "object" ? body : {};
  if (AGENT_READ.includes(action) && Object.hasOwn(READ, action)) return await READ[action](target, b);
  if (AGENT_CHANGE.includes(action) && Object.hasOwn(CHANGE, action)) return await CHANGE[action](target, b);
  throw new LspError(400, { code: "UNKNOWN_ACTION", error: T`Unknown action "${action}" — reading: ${AGENT_READ.join(", ")}; writing: ${AGENT_CHANGE.join(", ")}` });
}
