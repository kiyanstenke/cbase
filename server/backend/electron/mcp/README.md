# `mcp/` — the cbase MCP server (stdio, JSON-RPC 2.0)

**What lives here:** the server through which every provider harness talks to cbase: Claude Code via `--mcp-config`, Codex via
`-c`, the loop engine via `server/providers/mcp-client.js`. It offers typed `cbase_*` tools instead of curl instructions and
talks to the local API on `127.0.0.1:7718`.

| File | Role |
|---|---|
| `cbase-mcp.js` | The entry point: filters the catalog to what the run is offered (`VISIBLE_TOOLS`, `TOOL_MAP`) and speaks JSON-RPC over stdio (`initialize`, `tools/list`, `tools/call`, markers `__content`/`__isError`). Started by PATH (`MCP_SCRIPT` in `server/app-state.js`), never imported |
| `offering.js` | WHAT a run is offered: `offeringNames(env)`, a pure function of the run environment. The server runs the same computation for the name list in the Codex prefix (`server/providers/connectors/codex-prefix.js`) and for a subagent's project focus: description side = execution side |
| `catalog.js` | The catalog: `TOOLS = [...projectTools, …]` by spread, and `CATALOG_NAMES`; a leaf without environment so the SERVER can read the names in catalog order too (`server/runs/agent-set.js`) |
| `tools/` | The tool groups, one file per area (see `tools/README.md`) |
| `lib.js` | Helpers: `api` (HTTP; an error goes to the model as text: `error` plus the lists `problems` and `formHints` of the answer), `resolve`/`needProject`/`needWorkspace`/`needChat`, the scope checks, time (`TIME_ZONE`, `timeText`, `parseSince`), the schema blocks `str`/`int`/`obj`, text blocks (`CONTEXT_FORM`, `CAPTURE_HINT`). A file of its own because the tool modules build their schemas at load time (inside the entry point that would be a TDZ in the import cycle) |
| `toolsets.js` | Names and environment: `ALWAYS`, `TOOLSETS` (currently empty), `TOOLSET` (from `CBASE_TOOLSET`), `AGENT_DEPTH` (from `CBASE_AGENT_DEPTH`), `TOOL_LIST` (from `CBASE_TOOLS`) |
| `first-set.js` | The ONE sentence boundary: `firstSentence(text)` and `catalogRow`. The first sentence of every description IS its short description; the loop engine shows it in the catalog of deferred tools (`server/providers/engine.js`), the length guard `server/backend/test/mcp-description-length.test.js` holds it to 20–160 characters and every description within the budget (1,500, named exceptions in `server/backend/test/fixtures/mcp-description-exceptions.json`). A leaf without imports, linear |
| `visibility.js` | Visibility by depth, a leaf without environment and imports, read by server, CLI block list and loop engine: `AGENT_DEPTH_MAX` = 3, the table `VIEW_BY_DEPTH` (`alwaysLocked` for EVERY subagent; `onlyAtTheLimit` for the `cbase_agent*` family), `lockedForDepth`, the lists for workflow agents, the outer loop, instances and the fence |
| `credentials-set.js` | The ONE sentence about the scope of the credentials (base block and `cbase_vars_*`) |
| `airlock.js`, `agenda-title-rule.js`, `bash-guard.js`, `cpu-saver.js`, `detach-rule.js`, `monitor-rule.js`, `wakeup-rule.js` | Text blocks and rules read by the server (airlock cards, the rules in the system prompt) |

**What does NOT live here:** who starts the server and with which environment (`server/toolchain/mcp-config.js:writeMcpConfig`);
the routes the tools call (`server/<folder>/routes.js`).

**Order is contract:** `tools/list` returns `TOOLS` in array order, and that order is the prompt prefix of every run (cache).
Guard: `server/backend/test/mcp-catalog.test.js` with `fixtures/mcp-catalog.snapshot.txt` (73 names). The snapshot is an alarm,
not a lock. It holds only NAMES; whether a description says what the server does is held by guards of their own (for example
`mcp-schema.test.js` binds the opt-in ways of `cbase_dynamic_workflow` to the one opt-in condition in
`server/dynworkflows/run.js`).

**Token and fence:** `lib.js:api` is the ONLY fetch place; with `CBASE_TOKEN` (set only in a project container) every request
carries the header `x-cbase-token`. If a response comes back with `x-cbase-fenced: 1` (the fence filtered), `api` notes it in the
async context of the tool call (`AsyncLocalStorage`, `withFenceMarker`: calls overlap), and `cbase-mcp.js` appends a second
text block (`FENCE_HINT`) after the result; the body stays as it is. AUXILIARY queries run OUTSIDE the marker
(`lib.js:auxQuery`): `resolve()` and the scope checks read filtered lists whose result is not in the answer. Every new `api(`
call needs a row in `server/projectbox/fence-table.js`; the seam guard in `server/backend/test/fence.test.js` reads the calls of
this folder.

**Descriptions may be functions:** a tool may carry `description`/`inputSchema` as a FUNCTION of the run environment
(`lib.js:runEnvironment`: depth, workflow marker, write permission, whether `cbase_agent` is in the set); `tools/list` evaluates it.

**The three most frequent questions:**
- Which tools does a run see? → `offering.js:offeringNames`, stages of which the first applying one counts: `TOOL_LIST` (explicit
  list from `CBASE_TOOLS`, plus `ALWAYS`; unreadable = EMPTY list, never a silent full catalog) > `TOOLSET` (named set from
  `CBASE_TOOLSET`; unknown name = no set) > full catalog. Then always the skill gate (`cbase_skill` only with non-empty
  `CBASE_SKILLS` or with `CBASE_SKILL_WRITE`) and, for `AGENT_DEPTH > 0`, minus `visibility.js:lockedForDepth` (no question, no
  wakeup/monitor at any depth; a subagent may delegate down to depth 2, at depth 3 `cbase_agent*` is missing); a workflow agent
  (`CBASE_WORKFLOW_AGENT`) instead of the depth minus `lockedForWorkflowAgent`; `StructuredOutput` comes only with a schema set
  and survives every one of these cuts. Further cuts: project state (`lockedForInstance`: the copy tools only for a run with an
  instance identifier), the fence (`lockedForFence`: with a token the tools whose route the fence ALWAYS rejects are missing),
  the outer loop (the analysis tool only with its marker). What a subagent gets at all is computed by the server
  (`server/runs/agent-set.js:agentToolset`) and handed over as an explicit list in `CBASE_TOOLS` from depth 2 on. `TOOL_MAP` knows
  only what is visible: a resumed run that remembers a foreign name hits "Unknown tool".
- How does a new tool get in? → into the matching group under `tools/` at EXACTLY the spot intended in the catalog; update the
  snapshot; if no subagent may have it, add it to `visibility.js:VIEW_BY_DEPTH.alwaysLocked` (or `onlyAtTheLimit`).
- Why does a tool answer as an error although the handler did not throw? → `cbase-mcp.js:handle`: the marker `__isError` on the
  result (`lib.js:agentReport` sets it for a failed subagent whose report the route returns with 201); `__content` passes finished
  MCP blocks such as images through 1:1.

**Who writes what is decided by the server too:** the tools that write on behalf of an agent (agent send, agenda, skills, watch,
timeline) set the sender markers AFTER the model's arguments (`ofProfile`/`workflowAgent`/`outerLoop`), and the server checks
them again (`server/communication/sender.js`).
