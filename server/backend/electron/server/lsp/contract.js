// The contract of the language service between backend and web, as ONE leaf with no imports. The backend (lsp/*,
// devtools/code-route.js for the editor, devtools/routes.js for the agents) computes with these lists, and the binding test
// web/test/lsp-binding.test.mjs holds the web (lib/api/lsp.ts) to them — changing a line here turns the suite red until the web
// has followed. Names across the boundary are English. Pattern: gitView/contract.js.

/** The languages with a server. Not Vue. `css` also covers SCSS and Less (one server, like VS Code `css-language-features`),
 *  `markdown` is VS Code's Markdown server (`markdown-language-features`; B is its client side, lsp/markdown.js). */
export const LANGUAGES = Object.freeze(["ts", "python", "yaml", "json", "css", "markdown"]);

/** File suffix → [language, languageId]. What is missing here has no server (syntax colors only). */
export const SUFFIXES = Object.freeze({
  ".ts": ["ts", "typescript"], ".mts": ["ts", "typescript"], ".cts": ["ts", "typescript"], ".tsx": ["ts", "typescriptreact"],
  ".js": ["ts", "javascript"], ".mjs": ["ts", "javascript"], ".cjs": ["ts", "javascript"], ".jsx": ["ts", "javascriptreact"],
  ".py": ["python", "python"], ".pyi": ["python", "python"],
  ".yml": ["yaml", "yaml"], ".yaml": ["yaml", "yaml"],
  ".json": ["json", "json"], ".jsonc": ["json", "jsonc"],
  ".css": ["css", "css"], ".scss": ["css", "scss"], ".less": ["css", "less"],
  // The suffixes of the `markdown` language in VS Code (extensions/markdown-basics/package.json `contributes.languages`).
  ".md": ["markdown", "markdown"], ".mkd": ["markdown", "markdown"], ".mkdn": ["markdown", "markdown"], ".mdwn": ["markdown", "markdown"],
  ".mdown": ["markdown", "markdown"], ".markdown": ["markdown", "markdown"], ".markdn": ["markdown", "markdown"],
  ".mdtxt": ["markdown", "markdown"], ".mdtext": ["markdown", "markdown"], ".litcoffee": ["markdown", "markdown"],
  ".ron": ["markdown", "markdown"], ".ronn": ["markdown", "markdown"], ".workbook": ["markdown", "markdown"],
});

/** State of a server per (instance, language). `off` = never used yet or ended; `memory` = the memory gate was closed, not
 *  started; `stopped` = the instance is stopped, nothing starts; `error` = start or run failed (reason in `error`);
 *  `missing` = the package is not installed (local server without the global packages). */
export const STATES = Object.freeze(["off", "starting", "ready", "memory", "stopped", "error", "missing"]);

/** Why a file has no language service — `{ supported: false, reason }`. */
export const REASONS = Object.freeze(["no_language", "no_project", "stopped", "memory", "error", "missing", "starting"]);

/** Capabilities, read from the server's `capabilities` (what is missing is not in the menu). `source_definition` only for
 *  TS/JS (command `_typescript.goToSourceDefinition`); `format` also when a project formatter applies. `document_link`
 *  (⌘-click on a link) and `document_color` (color squares). */
export const CAPABILITIES = Object.freeze([
  "completion", "hover", "signature_help", "definition", "type_definition", "source_definition", "implementation", "references",
  "call_hierarchy", "document_highlight", "document_symbol", "workspace_symbol", "rename", "quick_fix", "refactor",
  "source_action", "format", "semantic_tokens", "document_link", "document_color",
]);

/** Editor actions: `POST <apiBase>/lsp/<action>[?instance=<identifier>]` (apiBase = /api/projects/:id or
 *  /api/workspaces/:id). Body and response per action: lsp/actions.js. */
export const EDITOR_ACTIONS = Object.freeze([
  "status", "diagnostics", "completions", "hover", "signature_help",
  "definition", "type_definition", "source_definition", "implementations", "references", "call_hierarchy",
  "highlights", "outline", "workspace_symbols", "prepare_rename", "rename", "code_actions", "code_action_apply", "format",
  "read", "close", "sync", "restart", "stop", "interpreter", "completion_resolve", "semantic_tokens", "link", "colors",
  "color_presentation",
]);

/** Agent actions, reading (MCP `cbase_lsp`) and writing (MCP `cbase_lsp_edit`): `POST /api/lsp`. */
export const AGENT_READ = Object.freeze([
  "diagnostics", "definition", "type_definition", "implementations", "references", "call_hierarchy", "hover", "outline",
  "completions", "workspace_symbols", "code_actions",
]);
export const AGENT_CHANGE = Object.freeze(["rename", "format", "code_action"]);

/** Formatters that `format` reports: the project's in the container, or the server's. */
export const FORMATTER = Object.freeze(["prettier", "ruff", "black", "server"]);

/** Origin of an interpreter candidate. */
export const INTERPRETER_SOURCES = Object.freeze(["venv", "container", "chosen"]);

/** Error codes (HTTP 409/403/400) across the boundary. `TEXT_MISSING`: B does not know the state of this buffer — the client
 *  sends the same request again with `text`. `OUTSIDE`: a location of the edit lies outside the instance, everything discarded. */
export const CODES = Object.freeze(["TEXT_MISSING", "OUTSIDE", "UNKNOWN_ACTION", "STALE_ACTION", "NOT_NAMED"]);

/** Event on `/api/events` when a state changes: `{ type: "lsp/status", projectId, instance, language, state,
 *  error?, version?, interpreter? }`. */
export const STATUS_EVENT = "lsp/status";

/** Event on `/api/events` when a server sends `workspace/semanticTokens/refresh` (as vscode-languageclient handles it):
 *  `{ type: "lsp/semantic_refresh", projectId, instance, language }`; every view of that language refetches its tokens. */
export const SEMANTICS_EVENT = "lsp/semantic_refresh";

/** Event on `/api/events` when a server's diagnostics have to be asked again: after the restart on a change of the UI language
 *  (the messages now speak the new one) and when a server sends `workspace/diagnostic/refresh` —
 *  `{ type: "lsp/diagnostic_refresh", projectId, instance, language }`; every view of that language asks `diagnostics` again. */
export const DIAGNOSTIC_EVENT = "lsp/diagnostic_refresh";

/** Commands of a suggestion (`command` of a CompletionItem) that the editor runs ITSELF — as VS Code does after accepting: new
 *  suggestions (JSON/YAML after a key) or the parameter hints. No other command crosses the boundary. */
export const SUGGESTION_COMMANDS = Object.freeze(["editor.action.triggerSuggest", "editor.action.triggerParameterHints"]);

/** An open buffer without a request counts as closed after this time (B sends didClose; the server then reads the disk). */
export const BUFFER_LEASE_MS = 10 * 60 * 1000;
/** How long `diagnostics` waits for the diagnostics of the reported state before it returns the last known ones. */
export const DIAGNOSTICS_WAIT_MS = 2_000;
/** Deadline per request to a server; after that `{ error }` instead of a hang. */
export const REQUEST_DEADLINE_MS = 15_000;
