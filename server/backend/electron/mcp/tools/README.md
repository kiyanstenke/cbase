# `mcp/tools/` — the tool groups of the cbase MCP server

**What lives here:** the tool array of the server cut into contiguous groups, one file per area: `export const <x>Tools = [ … ]`,
each entry `{ name, description, inputSchema, handler }`. `../catalog.js` spreads them back together into `TOOLS` in THIS order
(73 tools).

| File | Area | Tools |
|---|---|---|
| `projects.js` | Projects and project context | `cbase_projects_list`, `project_update/delete`, `chat_set_project`, `context_list/get/categories/create/dump/update/verify/delete` (there is deliberately no `cbase_project_create`: a human creates projects in the UI) |
| `artifacts.js` | Chat artifacts, folder context | `cbase_artifacts_list/read/write/delete`, `folder_context_list/read` |
| `services.js` | Ports, services, monitor, wakeup | `cbase_ports_list/running/free`, `service_add/update/delete/log/command_history/start/stop`, `monitor`, `monitor_stop`, `wakeup` |
| `agents.js` | Subagents, communication, question | `cbase_agent`, `agent_output/send/stop`, `agents_list`, `ask` |
| `workspace.js` | Variables, workspace context, LSP | `cbase_vars_list/get`, `workspace_context_search/update/add`, `lsp`, `lsp_edit` |
| `captures.js` | Recordings of the chat browser (the end of the turn shows them) | `cbase_screenshot`, `recording_start/stop` |
| `app.js` | App plumbing | `cbase_permission_prompt` (called by Claude Code via `--permission-prompt-tool`), `cbase_skill` |
| `dynworkflows.js` | Dynamic workflows | `cbase_dynamic_workflow_list/_save` (workspace library), `cbase_dynamic_workflow` (inputs 1:1 like Claude Code's Workflow tool; returns immediately, without opt-in with "waiting for approval" and a card in the chat), `cbase_dynamic_workflow_stop`, plus the messenger `StructuredOutput` (visible only with `CBASE_SCHEMA`). The description of `cbase_dynamic_workflow` ends with the size guideline (`sizesSet`, environment `CBASE_DYNWF_SIZE`) |
| `graphworkflows.js` | Graph workflows from the chat | `cbase_workflow_start` (starts ONLY on the announcement `/workflow:<shortname>`; checked in the route, not here), `cbase_workflow_status`, `cbase_workflow_stop` |
| `stacks.js` | Copies of a project and instance choice | `cbase_copy_stack`, `_list`, `_fetch`, `_remove`, `cbase_switch_instance`; offered only to a run in a RELOCATED project (`../visibility.js:lockedForInstance`) |
| `outerloop.js` | Outer loop | `cbase_chat_analysis` (history, search, call, notes on the observed chat; only with the marker `CBASE_OUTER_LOOP`) |
| `agenda.js` | The agenda per coding chat | `cbase_agenda` (read), `cbase_agenda_write` (only the main run of a coding chat), `cbase_agenda_maintain` (only the agenda keeper in its outer-loop run) |
| `timeline.js` | The timeline per project | `cbase_timeline` (read), `cbase_timeline_write` (enter, collect, dismiss, revise); only the timeline agent in its outer-loop run |
| `skills.js` | Writing skills | `cbase_skill_write` (create/change at once with history, erase only as a request); only the main run of a coding chat with the marker `CBASE_SKILL_WRITE` (`../offering.js`) |

**What does NOT live here:** the helpers (everything a group imports comes from `../lib.js`: `api`, `enc`, `qs`, `str`/`int`/`obj`,
`need*`, the scope checks, `timeText`/`parseSince`, text blocks); the sets and filter inputs (`../toolsets.js`); the catalog
(`../catalog.js`); visibility by depth, that of workflow agents and the messenger's name (`../visibility.js`); filtering and
JSON-RPC (`../cbase-mcp.js`). The groups do not know each other and never import the entry point.

**Rule: order = catalog.** The position of a tool in its group and of the group in the spread is `tools/list`, and therefore
the prompt prefix of every run (cache). Guard: `server/backend/test/mcp-catalog.test.js` against
`server/backend/test/fixtures/mcp-catalog.snapshot.txt` (by spawn, as the app starts the server). A tool moves only on purpose;
the snapshot follows, never the other way round. New groups go last so the prefix before them stays the same.

**The three most frequent questions:**
- Where does a new tool belong? → into the group whose area it carries, at the intended spot; then update the snapshot. If a
  subagent must not have it: `../visibility.js` (the table `VIEW_BY_DEPTH`).
- Why does a tool answer "not in scope"? → `../lib.js` (`assertInScope`, `serviceInScope` …): the server sees only the workspace of
  its chat (`CBASE_WORKSPACE_ID`/`CBASE_CHAT_ID` from `writeMcpConfig`).
- How does a handler report an image or an error without throwing? → markers on the result: `__content` (finished MCP blocks, see
  `captures.js`) and `__isError` (see `agents.js` via `lib.js:agentReport`); `../cbase-mcp.js:handle` evaluates both and does not
  pass them on.

**Descriptions are model text:** budget 1,500 characters each, first sentence 20–160 characters (it is the one-line catalog entry,
`../first-set.js`); guard `server/backend/test/mcp-description-length.test.js`. What a field means belongs on the field.
