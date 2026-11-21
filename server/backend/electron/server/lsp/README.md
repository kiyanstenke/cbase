# `lsp/` — The language service (editor navigation like VS Code)

**What lives here:** the core through which B talks to real language servers (LSP over stdio). B is their ONLY client: one
session per (project, instance, language), started on first use through `runtime/inProject.js` (`inProject` with the instance —
in the project container, otherwise in B), with no idle shutdown, ended at a lock, a stop and at server end. The editor gets
responses in the shape of `contract.js`; the agents get the same computation through `/api/lsp` in their own wrapper (1-based,
absolute paths, kinds as a word; MCP `cbase_lsp` reading, `cbase_lsp_edit` writing — also with the token of a copy IN the copy).

| File | What | Called by |
|---|---|---|
| `contract.js` | Leaf with no imports: languages, suffixes, states, reasons, capabilities, actions, error codes — the seam to the web (`web/test/lsp-binding.test.mjs`) | everything here, `web/` |
| `table.js` | which server per language (package, start script, settings like VS Code; the five packages pinned in `server/backend/Dockerfile`, `vscode-langservers-extracted` carries JSON, CSS/SCSS/Less and Markdown); test seams `setLspTable`, `CBASE_LSP_FAKE` | `sessions.js` |
| `markdown.js` | the client side of the Markdown server (like VS Code `markdown-language-features` client.ts): `markdown/parse` with markdown-it (front matter rule, linkify without fuzzyLink; buffer before disk), `markdown/fs/*` and the search INSIDE (a copy through its container, all suffixes in one pass), `markdown/fs/stat` also outside (existence and kind only — links out of the project do not count as missing), watchers and `markdownFreshness` (report changed files before every action; in a copy through the container's `stamp`, throttled and not awaited) | `actions.js` (`setClientPage`, `markdownFreshness`) |
| `connection.js` | JSON-RPC over stdio (Content-Length), requests with a deadline (the deadline timer keeps the event loop alive), abort, notifications; cap `MESSAGE_MAX` (64 MB) per message — beyond that a protocol error, the process is killed | `sessions.js` |
| `text.js` | UTF-16 positions ↔ offsets, applying edits, URI ↔ path | everything here |
| `documents.js` | open documents per session (the editor's buffer with a lease, the state of the disk for agents), didOpen/didChange/didClose, diagnostics push/pull for the version OF the request (if another window reconciles during the wait: the last report for this state, or empty) | `actions.js` |
| `sessions.js` | start (memory gate, start lock, stopped instance, restart gap 60 s), initialize with capabilities, the server's requests (configuration, capturing applyEdit, dynamic registration with options, …; a language's client side through `setClientPage`), status event `lsp/status`, end; external targets (token 30 min, index per session and path, cap `EXTERNAL_CAP`; editor only); `groupsInB` (the groups of the servers in B — the plan of a relocation excludes them) | `actions.js`, `server.js`, `projectbox/idle.js` (setter) |
| `limit.js` | what B reads from disk (`readDisk`, `readExternal` — descriptor, never blocking on the path; `readDiskAgent` — in a copy through its container) and where it writes (agents only: `writeForAgent` → `writeEverythingOrNothing` in B or `writeEverythingOrNothingCopy` through the container with a sha256 comparison); `checkEdit`: one location outside ⇒ 403 `OUTSIDE`, nothing applied | `actions.js`, `agents.js` |
| `actions.js` | `editorAction(action, target, body)` (B never writes; `sync` = the reconcile only), `languageOf`, the building blocks for `agents.js` (`withDocument`, `diskReconcile` — before rename/code_action the session's documents against the disk, `rawCodeActions`, `applyCodeAction` — several edits on one file in sequence into ONE change, `formatDocument`); hooks: `setFormatter`, `setInterpreterMachine`, `setStatusAddition` | `routes.js`, `agents.js`, `server.js` |
| `agents.js` | `agentAction(action, target, body)`: AGENT_READ and AGENT_CHANGE — read from disk, write all or nothing, caps with `truncated`, `code_action` through the `index` from `code_actions` at the same position | `devtools/routes.js` (`/api/lsp`) |
| `formatter.js` | the project's formatter: Prettier from `node_modules/.bin` upward, ruff before black from the interpreter's bin/ and the venvs of the file — run IN the instance; `statusAddition` (`formatter`, `interpreter`, `format` in `features` only if there is one) | `server.js` (setter) |
| `interpreter.js` | the Python interpreter per project: the choice in `lsp.python.<projectId>`, otherwise the shallowest `.venv`/`venv` down to depth 3 (synchronous in B, remembered for 60 s, with caps per folder and overall); action `interpreter` (candidates checked in the container, `set` only on the project level, a change ends the Python sessions) | `server.js` (setter), `formatter.js` |
| `run.js` | a short process in the instance (`inProject`, stdin through `kind-stdin.js`, deadline/output caps that are reported) | `formatter.js`, `interpreter.js` |
| `routes.js` | `lspEditorResponse(action, body, resolve)` → `{ status, body }` and `responseFromError(e)` — NOT a route in the registry: the route lives in `devtools/code-route.js` (`/lsp/*`, both levels) and `devtools/routes.js` (`/api/lsp`) | `devtools/` |
| `l10n/` | the German message bundles of the CSS, JSON and Markdown servers, verbatim from microsoft/vscode-loc; `provenance.json` holds their origin markers and sha256 | `table.js` (`l10nBundle`), the image |

**Terms.** *Target* — `{ projectId, instance, root, base, area?, abs?, beforeWrite? }`, computed by the caller
(`devtools/code-route.js:lspTargetFor`, `devtools/routes.js:lspAgentTarget`); `lsp/` never imports `runs/` (guard in
`test/import-direction.test.js`). *Base* — what `file` is relative to (editor: the root of the level; agent: `null`, absolute
paths). *Area* — the mount-point anchor of an instance where reading and writing happen (`runs/runtime-limit.js`). *External* — a
location outside the root, readable in the editor only through a token (`read`), never writable.

**Three typical questions.**
1. *Why does no server start?* `sessions.js:situationBefore` (stopped instance ⇒ `stopped`; lock, relocation, setup, layout ⇒
   `starting`/`off` through `setStartLock`, registered in `server.js`), then a missing package (`missing`), then the memory gate
   (`memory`).
2. *Why 403 OUTSIDE on a rename?* `limit.js:checkEdit` — a location of the WorkspaceEdit (also create/rename/delete) lies outside
   the instance; nothing is applied, not even the part inside.
3. *Why does it not format with Prettier/ruff?* `formatter.js:formatterCandidates` (where it searches) and `firstExecutable`
   (the CONTAINER decides what is executable); registered in `server.js` through `setFormatter`, `setStatusAddition`,
   `setInterpreterMachine` and `sessions.js:setInterpreterSupplier`. A failing formatter is a 400 with its message.

**What does NOT live here.** The routes themselves (`devtools/`), the instance and area computation (`runs/instance.js`,
`runs/runtime-limit.js`), the start in the container (`runtime/inProject.js`), the editor's writing (it writes through
`/files/write` — locked like every write path), the MCP tools (`mcp/tools/workspace.js`, a separate process — the action lists
there are bound by `test/mcp-schema.test.js`), the UI (`web/`). Tests: `test/lsp-core.test.js` (against `test/fake-lsp.mjs`),
`test/lsp-agents.test.js`, `test/lsp-formatter.test.js`, `test/lsp-markdown.test.js` (client side of the Markdown server, ⌘-click
on links, CSS table), `test/lsp-vu.test.js` (`link`, `colors`, language of the messages — `locale`, the German bundles in `l10n/`
with `provenance.json`), `test/lsp-vv.test.js` (Markdown in a copy, color notations), `test/lsp-vx.test.js` (the language switch
restarts the sessions at once — `shutdown`/`exit`, documents carried over, `lsp/diagnostic_refresh`),
`test/language-service-fifo.test.js`, `test/fence.test.js`, `test/fence-instance.test.js`, `test/files-in-copy.test.js`.
