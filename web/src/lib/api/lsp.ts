// The editor's language service (editor navigation styled like VS Code): the seam to the backend
// (`POST <apiBase>/lsp/<action>[?instance=…]`, server/backend/electron/server/lsp/). A leaf in lib/api: it imports only `./core.js`; it
// knows the buffers (lib/buffer.ts) only by their shape (`LspSource`).
//
// THE CONTRACT: the lists below mirror server/backend/electron/server/lsp/contract.js; web/test/lsp-binding.test.mjs pins every
// constant of the contract to its counterpart here (or to a named reason why the web does not need it), with built-in sabotage.
//
// THE RECONCILIATION: every request about a file carries `{ file, buffer, version }`; `text` only if the server has not yet received
// this state from THIS window (remembered per buffer: the file and version last sent out with text). If it does not know it anyway
// (lease expired, backend restarted) it answers `409 TEXT_MISSING`, and the same request goes out EXACTLY ONCE more with text. If a
// buffer's file changes (renamed, lib/buffer.ts `renameBuffer`, also into another project), the next call unregisters the old file with
// `close` (to ITS target) and registers the text under the new one. `lspClose` (via the buffer's `atClose`, components/code/lsp-core.ts)
// sends `close`.
//
// THE POSITIONS: `{ line, character }` 0-based, `character` in UTF-16 units, like CodeMirror offsets. The conversion lives ONCE here
// (`lspPosOf`, `lspOffsetOf`, `lspAreaOf`) over a line interface that CodeMirror's `Text` satisfies; it clamps like lib/buffer.ts
// `offsetOf` (the test keeps both equal).
import { api } from "./core.js";

// ── Contract (mirrored) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const LSP_LANGUAGES = ["ts", "python", "yaml", "json", "css", "markdown"] as const;
export type LspLanguage = (typeof LSP_LANGUAGES)[number];
/** File extension → [language, languageId]. What is missing has no server (syntax colors only). */
export const LSP_SUFFIXES: Readonly<Record<string, readonly [LspLanguage, string]>> = {
  ".ts": ["ts", "typescript"], ".mts": ["ts", "typescript"], ".cts": ["ts", "typescript"], ".tsx": ["ts", "typescriptreact"],
  ".js": ["ts", "javascript"], ".mjs": ["ts", "javascript"], ".cjs": ["ts", "javascript"], ".jsx": ["ts", "javascriptreact"],
  ".py": ["python", "python"], ".pyi": ["python", "python"],
  ".yml": ["yaml", "yaml"], ".yaml": ["yaml", "yaml"],
  ".json": ["json", "json"], ".jsonc": ["json", "jsonc"],
  ".css": ["css", "css"], ".scss": ["css", "scss"], ".less": ["css", "less"],
  ".md": ["markdown", "markdown"], ".mkd": ["markdown", "markdown"], ".mkdn": ["markdown", "markdown"], ".mdwn": ["markdown", "markdown"],
  ".mdown": ["markdown", "markdown"], ".markdown": ["markdown", "markdown"], ".markdn": ["markdown", "markdown"],
  ".mdtxt": ["markdown", "markdown"], ".mdtext": ["markdown", "markdown"], ".litcoffee": ["markdown", "markdown"],
  ".ron": ["markdown", "markdown"], ".ronn": ["markdown", "markdown"], ".workbook": ["markdown", "markdown"],
};
export const LSP_STATES = ["off", "starting", "ready", "memory", "stopped", "error", "missing"] as const;
export type LspState = (typeof LSP_STATES)[number];
export const LSP_REASONS = ["no_language", "no_project", "stopped", "memory", "error", "missing", "starting"] as const;
export type LspReason = (typeof LSP_REASONS)[number];
export const LSP_CAPABILITIES = [
  "completion", "hover", "signature_help", "definition", "type_definition", "source_definition", "implementation", "references",
  "call_hierarchy", "document_highlight", "document_symbol", "workspace_symbol", "rename", "quick_fix", "refactor",
  "source_action", "format", "semantic_tokens", "document_link", "document_color",
] as const;
export type LspCapability = (typeof LSP_CAPABILITIES)[number];
export const LSP_EDITOR_ACTIONS = [
  "status", "diagnostics", "completions", "hover", "signature_help",
  "definition", "type_definition", "source_definition", "implementations", "references", "call_hierarchy",
  "highlights", "outline", "workspace_symbols", "prepare_rename", "rename", "code_actions", "code_action_apply", "format",
  "read", "close", "sync", "restart", "stop", "interpreter", "completion_resolve", "semantic_tokens", "link", "colors",
  "color_presentation",
] as const;
export type LspAction = (typeof LSP_EDITOR_ACTIONS)[number];
export const LSP_FORMATTER = ["prettier", "ruff", "black", "server"] as const;
export const LSP_INTERPRETER_SOURCES = ["venv", "container", "chosen"] as const;
export const LSP_CODES = ["TEXT_MISSING", "OUTSIDE", "UNKNOWN_ACTION", "STALE_ACTION", "NOT_NAMED"] as const;
export type LspCode = (typeof LSP_CODES)[number];
export const LSP_STATUS_EVENT = "lsp/status";
/** The server wants new semantic tokens (`workspace/semanticTokens/refresh`); every view of this language fetches them anew. */
export const LSP_SEMANTICS_EVENT = "lsp/semantic_refresh";
/** The diagnostics must be asked again: the server restarted after a UI-language change (its messages now speak the new one) or sent
 *  `workspace/diagnostic/refresh`; every view of this language asks `diagnostics` again, without a click and without a key. */
export const LSP_DIAGNOSTIC_EVENT = "lsp/diagnostic_refresh";
/** Commands of a suggestion that the editor itself runs after accepting (like VS Code); any other does not cross the boundary. */
export const LSP_SUGGESTION_COMMANDS = ["editor.action.triggerSuggest", "editor.action.triggerParameterHints"] as const;
export type LspSuggestionCommand = (typeof LSP_SUGGESTION_COMMANDS)[number];
export const LSP_BUFFER_LEASE_MS = 10 * 60 * 1000;
export const LSP_DIAGNOSTICS_WAIT_MS = 2_000;
export const LSP_REQUEST_DEADLINE_MS = 15_000;

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────────────────
export type LspPos = { line: number; character: number };
export type LspRange = { start: LspPos; end: LspPos };
/** `file` relative to the root of the apiBase; a target outside the instance carries `external.token` (read only via `read`). */
export type LspLocation = { file: string; range: LspRange; external?: { token: string } };
export type LspTextEdit = { range: LspRange; newText: string };
export type LspWorkspaceEdit = { changes: { file: string; edits: LspTextEdit[] }[] };
/** 200 with `supported: false`: the file has (currently) no service; `reason` from LSP_REASONS. */
export type LspNotSupported = { supported: false; reason: LspReason; language?: string; state?: LspState };
/** The server's trigger characters (from its capabilities; VS Code reads them there, not from a fixed list): suggestions, parameter
 *  hints and their re-asking while they are open. Only a ready server reports them. */
export type LspTrigger = { completion: string[]; signature: string[]; signatureRetrigger: string[] };
export type LspLanguageStatus = {
  language: LspLanguage; state: LspState; features: LspCapability[]; triggers?: LspTrigger;
  version?: string; error?: string; interpreter?: string; formatter?: string;
};
export type LspDiagnostic = { range: LspRange; severity: 1 | 2 | 3 | 4; message: string; source?: string; code?: string | number };
/** `labelDetail`/`description`: LSP `labelDetails` (VS Code: dimmed after the name or right in the row); `resolve`: the identifier for
 *  `completion_resolve` (only if the server can resolve); `deprecated`: outdated (struck through); `additionalTextEdits`: further changes
 *  on accepting (the import of an auto-import, mostly only after resolving); `command`: an editor command afterwards. */
export type LspCompletion = {
  label: string; kind?: number | string; detail?: string; documentation?: string; insertText?: string; range?: LspRange;
  sortText?: string; filterText?: string; snippet?: boolean; labelDetail?: string; description?: string; deprecated?: boolean;
  additionalTextEdits?: LspTextEdit[]; command?: LspSuggestionCommand; resolve?: string;
};
/** A parameter: `label` = [from, to] in the signature text, its documentation. `activeParameter` on the signature takes precedence over the answer's. */
export type LspSignature = { label: string; documentation?: string; parameters: { label: [number, number]; documentation?: string }[]; activeParameter?: number };
export type LspSymbol = { name: string; kind: number | string; detail?: string; range: LspRange; selectionRange: LspRange; children?: LspSymbol[] };
export type LspCodeAction = { id: string; title: string; kind?: string; preferred?: boolean; disabled?: string | boolean };

/** An element of the call hierarchy; `data` is opaque and goes back unchanged (`call_hierarchy` with `item`). */
export type LspCallItem = {
  name: string; kind: number | string; detail?: string; file: string; range: LspRange; selectionRange: LspRange;
  external?: { token: string }; data: string;
};
/** A call: incoming = the caller with the call sites IN it, outgoing = the target with the sites in the caller (`ranges`). */
export type LspCall = { item: LspCallItem; ranges: LspRange[] };
/** Where a link leads (lsp/actions.js `link`): a file (inside or with a token), a folder of the instance, a web address. */
export type LspLinkTarget = { kind: "file"; location: LspLocation } | { kind: "folder"; file: string } | { kind: "web"; url: string };
/** One notation of a color: `label` is in the color picker's header; `textEdit` is written, else `label` over the color's range
 *  (VS Code `updateEditorModel`). */
export type LspColorNotation = { label: string; textEdit?: LspTextEdit; additionalTextEdits?: LspTextEdit[] };
/** A color in the text (`textDocument/documentColor`), channels 0…1. */
export type LspColor = { range: LspRange; color: { red: number; green: number; blue: number; alpha: number } };
/** The answer per action; any file action can give `{ supported: false }` instead of its answer. */
export type LspResponses = {
  status: { languages: LspLanguageStatus[] };
  diagnostics: { diagnostics: LspDiagnostic[] };
  completions: { items: LspCompletion[]; incomplete: boolean };
  hover: { contents: string | null; range?: LspRange };
  signature_help: { signatures: LspSignature[]; active?: number; activeParameter?: number };
  definition: { locations: LspLocation[] };
  type_definition: { locations: LspLocation[] };
  source_definition: { locations: LspLocation[] };
  implementations: { locations: LspLocation[] };
  references: { locations: LspLocation[] };
  call_hierarchy: { root?: LspCallItem | null; calls: LspCall[] };
  highlights: { ranges: LspRange[] };
  outline: { symbols: LspSymbol[] };
  workspace_symbols: { symbols: { name: string; kind: number | string; container?: string; location: LspLocation }[] };
  prepare_rename: { range: LspRange; placeholder: string } | { error: string };
  rename: { edit: LspWorkspaceEdit };
  code_actions: { actions: LspCodeAction[] };
  code_action_apply: { edit: LspWorkspaceEdit };
  format: { edits: LspTextEdit[]; formatter: string };
  read: { path: string; text: string; language: string };
  close: { ok: true };
  sync: { ok: true };
  restart: { ok: true };
  stop: { ok: true };
  interpreter: { selected: string | null; effective: string | null; candidates: { path: string; version?: string; source: string }[] };
  completion_resolve: { resolved: true; detail?: string; documentation?: string; additionalTextEdits?: LspTextEdit[]; command?: LspSuggestionCommand } | { resolved: false };
  /** The server's legend and the tokens relatively encoded, five numbers each (lib/semantics.ts `decodeSemantics`). */
  semantic_tokens: { legend: { types: string[]; modifiers: string[] }; data: number[] };
  link: { link: { range: LspRange; target: LspLinkTarget } | null };
  colors: { colors: LspColor[] };
  /** The notations of a color for the color picker (`textDocument/colorPresentation`). */
  color_presentation: { presentations: LspColorNotation[] };
};
export type LspResponse<A extends LspAction> = LspResponses[A] | LspNotSupported;

/** Where the file lives: route (project/workspace) and instance (`<projectId>/<instance>`, null = main); the same shape as the buffer. */
export type LspTarget = { readonly apiBase: string; readonly instance: string | null };
/** What a request about a file needs; a buffer (lib/buffer.ts) satisfies it. Everything is read BEFORE the first `await`. */
export type LspSource = { readonly target: LspTarget; readonly path: string; readonly buffer: string; readonly version: number; readonly text: string };

// ── Calculations ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Language and languageId of a file; null: no server. */
export function lspLanguageOf(path: string | null | undefined): { language: LspLanguage; languageId: string } | null {
  const p = String(path ?? "");
  const name = p.slice(p.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  if (i < 0) return null;
  const e = LSP_SUFFIXES[name.slice(i).toLowerCase()];
  return e ? { language: e[0], languageId: e[1] } : null;
}
export const isNotSupported = (r: unknown): r is LspNotSupported =>
  typeof r === "object" && r !== null && (r as { supported?: unknown }).supported === false;
/** The code of a thrown error (lib/api/core.ts puts the body's fields on the error); "" without. */
export function lspErrorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
}
export const LANGUAGE_NAMES: Readonly<Record<LspLanguage, string>> = { ts: "TypeScript", python: "Python", yaml: "YAML", json: "JSON", css: "CSS", markdown: "Markdown" };

/** The lines of a text; CodeMirror's `Text` satisfies this. */
export interface LspRows {
  readonly length: number;
  readonly lines: number;
  line(n: number): { from: number; to: number };
  lineAt(pos: number): { number: number; from: number };
}
/** Offset → position (0-based). An offset beyond the text clamps to the end. */
export function lspPosOf(doc: LspRows, offset: number): LspPos {
  const o = Math.max(0, Math.min(doc.length, Math.floor(offset)));
  const l = doc.lineAt(o);
  return { line: l.number - 1, character: o - l.from };
}
/** Position → offset: a line beyond the end is the end, a character beyond the line is its end (as LSP requires). */
export function lspOffsetOf(doc: LspRows, p: LspPos): number {
  const line = Math.max(0, Math.floor(Number(p?.line) || 0)), ch = Math.max(0, Math.floor(Number(p?.character) || 0));
  if (line >= doc.lines) return doc.length;
  const l = doc.line(line + 1);
  return Math.min(l.from + ch, l.to);
}
export function lspAreaOf(doc: LspRows, r: LspRange): { from: number; to: number } {
  const a = lspOffsetOf(doc, r.start), b = lspOffsetOf(doc, r.end);
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}
export const lspRangeOf = (doc: LspRows, from: number, to: number): LspRange => ({ start: lspPosOf(doc, from), end: lspPosOf(doc, to) });

/** LSP severity → name (1 error, 2 warning, 3 info, 4 hint). */
export function severityOf(s: unknown): "error" | "warning" | "info" | "hint" {
  return s === 1 ? "error" : s === 2 ? "warning" : s === 4 ? "hint" : "info";
}
const SYMBOL_KINDS = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface",
  "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event",
  "operator", "type parameter"];
/** LSP SymbolKind (number) → word; a word stays as it is. */
export const symbolKind = (k: unknown): string => (typeof k === "number" ? SYMBOL_KINDS[k] ?? "" : typeof k === "string" ? k : "");
const COMPLETION_KINDS = ["", "text", "method", "function", "constructor", "property", "variable", "class", "interface", "namespace", "property",
  "constant", "constant", "enum", "keyword", "text", "constant", "text", "variable", "text", "enum", "constant", "class", "event", "keyword",
  "type"];
/** LSP CompletionItemKind (number) → the kinds CodeMirror knows (icon in the list). */
export const completionKind = (k: unknown): string | undefined => (typeof k === "number" ? COMPLETION_KINDS[k] || undefined : typeof k === "string" ? k : undefined);

/** The outline flat (pre-order) for the bar: name, kind, line (1-based), depth. */
export function flatLayout(symbols: readonly LspSymbol[] | null | undefined, depth = 0): { name: string; kind: string; line: number; level: number }[] {
  const out: { name: string; kind: string; line: number; level: number }[] = [];
  for (const s of symbols ?? []) {
    const r = s?.selectionRange ?? s?.range;
    out.push({ name: String(s?.name ?? ""), kind: symbolKind(s?.kind), line: (Number(r?.start?.line) || 0) + 1, level: depth });
    if (Array.isArray(s?.children) && s.children.length) out.push(...flatLayout(s.children, depth + 1));
  }
  return out;
}

/** Does an `lsp/status` event concern this target? On the workspace level always (the server says only later which file); on a project
 *  route when project and instance match. The server names the instance as the identifier `<projectId>/<instance>` (lsp/sessions.js
 *  `identifierOf`; null without relocation), the web carries NO parameter for the main (lib/code-instance.ts), so `null` here means null,
 *  "main" or `<projectId>/main`. `kind`: the same check for another event with project and instance (LSP_SEMANTICS_EVENT, LSP_DIAGNOSTIC_EVENT). */
export function lspEventAffects(evt: { type?: unknown; projectId?: unknown; instance?: unknown }, target: LspTarget, kind: string = LSP_STATUS_EVENT): boolean {
  if (evt?.type !== kind) return false;
  const pid = /^\/api\/projects\/([^/?#]+)$/.exec(target.apiBase)?.[1];
  if (!pid) return true;
  const project = decodeURIComponent(pid);
  if (String(evt.projectId ?? "") !== project) return false;
  const inst = evt.instance == null ? "" : String(evt.instance);
  const name = inst.startsWith(`${project}/`) ? inst.slice(project.length + 1) : inst;
  if (!target.instance) return name === "" || name === "main";
  return inst === target.instance || name === target.instance.slice(target.instance.indexOf("/") + 1);
}

// ── Calls ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type LspTransport = <T = unknown>(url: string, opts?: RequestInit) => Promise<T>;
let transport: LspTransport = api;
/** Tests only: replace the way to the server (null = `api` again). */
export function setLspTransport(t: LspTransport | null): void { transport = t ?? api; }

export const lspPath = (target: LspTarget, action: LspAction): string =>
  `${target.apiBase}/lsp/${action}${target.instance ? `?instance=${encodeURIComponent(target.instance)}` : ""}`;
const post = <T,>(target: LspTarget, action: LspAction, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> =>
  transport<T>(lspPath(target, action), { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });

/** An action without file reconciliation (`status`, `workspace_symbols`, `restart`, `stop`, `read`, `interpreter`). */
export function lspCalls<A extends LspAction>(target: LspTarget, action: A, body: Record<string, unknown> = {}): Promise<LspResponse<A>> {
  return post<LspResponse<A>>(target, action, body);
}

/** What the server knows of which buffer: per `buffer` the file and the version last sent WITH text (and arrived). */
const KNOWN = new Map<string, { target: LspTarget; file: string; version: number }>();
/** Tests only. */
export function forgetLspReconcile(): void { KNOWN.clear(); UNREGISTRATION.clear(); }
const sameFile = (b: { target: LspTarget; file: string }, target: LspTarget, file: string): boolean =>
  b.file === file && b.target.apiBase === target.apiBase && (b.target.instance ?? null) === (target.instance ?? null);
/** Does the server know this buffer's current state (as far as this window knows)? */
export function lspKnowsStatus(q: LspSource): boolean {
  const b = KNOWN.get(q.buffer);
  return Boolean(b && sameFile(b, q.target, q.path) && b.version === q.version);
}

/** The unregistration per `buffer` that is currently in flight: only once it has arrived does the request go out with text. On a move
 *  between workspace and project level both land in the SAME session (same file, same `buffer`, server lsp/documents.js); if the
 *  `close` arrived last, the document and diagnostics were gone until the next 409. */
const UNREGISTRATION = new Map<string, Promise<void>>();
/** An action about a file with the buffer's reconciliation. Throws like `api` (error with `code`/`httpStatus`). `signal` aborts the
 *  request (⌘ hover); if it already arrived with text, the next one simply sends it again (KNOWN is not set then). */
export async function lspQuestion<A extends LspAction>(q: LspSource, action: A, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<LspResponse<A>> {
  const target = q.target, file = q.path, buffer = q.buffer, version = q.version, text = q.text; // one state, before any await
  const old = KNOWN.get(buffer);
  const equal = Boolean(old && sameFile(old, target, file));
  if (old && !equal) { // renamed (or moved to another project): unregister the old file, register the new one with text
    KNOWN.delete(buffer);
    const closing: Promise<void> = post(old.target, "close", { file: old.file, buffer }).then(() => {}, () => {}); // a failing close holds nothing up
    UNREGISTRATION.set(buffer, closing);
  }
  const open = UNREGISTRATION.get(buffer);
  if (open) { // first unregistered, then registered; a second question of the same buffer waits for it too
    await open;
    if (UNREGISTRATION.get(buffer) === open) UNREGISTRATION.delete(buffer);
  }
  const withText = !(equal && old && old.version === version);
  const send = async (t: boolean) => {
    const r = await post<LspResponse<A>>(target, action, { ...body, file, buffer, version, ...(t ? { text } : {}) }, signal);
    const now = KNOWN.get(buffer);
    if (t && (!now || !sameFile(now, target, file) || now.version <= version)) KNOWN.set(buffer, { target, file, version });
    return r;
  };
  try {
    return await send(withText);
  } catch (e) {
    if (withText || lspErrorCode(e) !== "TEXT_MISSING") throw e;
    KNOWN.delete(buffer);
    return send(true); // exactly once with text
  }
}

/** Unregister the buffer with the server (`close`), only if this window reported the buffer to it. */
export async function lspClose(q: Pick<LspSource, "buffer">): Promise<void> {
  const b = KNOWN.get(q.buffer);
  if (!b) return;
  KNOWN.delete(q.buffer);
  await post(b.target, "close", { file: b.file, buffer: q.buffer });
}
