// The fence table: pure data plus the pattern matching, no imports. The verdict lives in projectbox/fence.js.
//
// WHAT IT SAYS. Which request from a project network (with a valid token) goes through, and how far. One row per route
// family; the FIRST matching row wins; a request that matches no row is 403 (visible, never silent: "unknown"). Outside the
// project networks and without a token the table does not apply (every verdict there is "as today").
//
// ONE ROW
//   family    name of the family (messages, guard)
//   methods   the HTTP methods it applies to ("*" = all)
//   pattern   path in segments: `:name` binds EXACTLY ONE non-empty segment, a trailing `**` the whole rest (also nothing).
//             The query (`?…`) is not part of it.
//   rule      "allowed"   passes, after the parameter checks (below)
//             "filtered"  passes, then the response goes through the filter `filter` (fence.js FILTER): the body keeps its
//                         shape, the response carries the header `x-cbase-fenced: 1`
//             "rejected"  403 with `reason`
//   body      (optional) a check of the request body (fence.js BODY): the fence reads the body BEFORE the route for this and
//             passes it on unchanged
//   query     (optional) checks of single query parameters: `{ name: kind }`; if the parameter is absent nothing applies, if
//             it is set it is checked like a path parameter of that kind
//   enforce   (optional) `{ name: kind }`: the query parameter is set to the value of the instance (added if missing); a
//             DIFFERENT value is 403
//   onlyFromMain (optional) the sentence saying why the row does not work with the token of a COPY: 409. It applies after
//             the path parameters (a foreign project stays 403) and before the body check, whatever the body
//   mcp       true if an `api(` call under server/backend/electron/mcp/ hits this row. The seam guard
//             (server/backend/test/fence.test.js) holds both directions: every call has a row, every mcp row has a call
//   withoutMcp   (instead of `mcp`) the named reason of a row that no MCP tool calls
//   readInProject (only with `:chatInProject`, path or query) the reason why this PURE read row (GET only) may read a chat of
//             the whole project, not only one of the instance (server/backend/test/fence-instance.test.js (5) holds the list)
//
// THE PARAMETERS. The NAME of a path parameter is its check (fence.js PARAMETER): `:project` = the project of the instance,
// `:workspace` = its workspace, `:chat` = a chat of its project AND of this instance (the binding of the chat — main, copy,
// child pin — is the identifier of the token; this includes the child chats of its graph workflows and a chat from which a
// live run is pinned in it: fence.js chatInScope/chatInstance), `:chatInProject` = a chat of its project whatever the
// instance (pure read rows with `readInProject` only; writing checks the instance too), `:service` = a service of its
// project, `:channel` = a channel with a chat of its project, `:browser` = a browser of its project. All other names
// (`:entry`, `:slug`, `:key`, …) are FREE: they are in `FREE_PARAMETER`, and a name in neither list turns the guard red.
// Only as query or enforce: `instance` = the identifier "<projectId>/<instance>" of this instance (namespace of the port
// list; also the instance of log, start and stop of a service).
//
// In one sentence: a project chat sees its project and the workspace-wide things without a project reference; it writes only
// into its own project or into what its toolset may already do. Chats without a project are not visible; credentials apply
// as before to those of the own project.

export const FREE_PARAMETER = Object.freeze(["entry", "slug", "key", "start", "file", "capture", "element", "relation", "level", "name", "path"]);

const Z = (family, methods, pattern, rule, rest = {}) => Object.freeze({ family, methods: Object.freeze([].concat(methods)), pattern, rule, ...rest });
const MCP = { mcp: true };
// Reason of the four rows that the old read/send tools used to carry (chat list, read chat, runs, channel send): the routes
// stay for the UI, the rows for an agent with Bash.
const COMMUNICATION_OLD = "no MCP tool any more: chats, histories, runs and channels are read by cbase_agents_list via “chat-communication”, writing into a channel is cbase_agent_send via “chat-agent-send” — the row keeps its limit for a call made with Bash";
// The coding MCP airlock: the wrapper mcp/airlock.js calls the backend itself (no `api(` from mcp/lib.js), with the token of
// the instance for the fence and the run token for the route.
const AIRLOCK = "the wrapper of a coding MCP server (mcp/airlock.js): no MCP tool, but the path of every call to a coding MCP server; the route checks the run token and whether the server is in the chat's set NOW";

export const FENCE_TABLE = Object.freeze([
  // ── without data ───────────────────────────────────────────────────────────────────────────────
  Z("health", "GET", "/api/health", "allowed", { withoutMcp: "sign of life without data (like /api/health at the gateway)" }),
  Z("context-schema", "GET", "/api/project-context/schema", "allowed", MCP),

  // ── projects ───────────────────────────────────────────────────────────────────────────────────
  Z("projects", "GET", "/api/projects", "filtered", { filter: "projects", ...MCP }),
  Z("project-delete", "DELETE", "/api/projects/:project", "rejected", {
    reason: "only the human deletes the own project from its container (otherwise it would stop the container the caller runs in)", ...MCP }),
  Z("project-rename", "PATCH", "/api/projects/:project", "allowed", MCP),
  // Only Claude in B triggers the relocation (plan, start, state): from the project container it would pull the ground from
  // under the caller (step 3 creates exactly this container, the way back removes it). `**` also hits `/relocation` itself.
  Z("project-relocation", "*", "/api/projects/:project/relocation/**", "rejected", {
    reason: "only Claude in B triggers the relocation of a project, never a project container",
    withoutMcp: "no MCP tool calls the relocation — Claude calls the route in B (docker exec -u agent <B> curl …)" }),
  // Project creation: only the human sets up and uploads. Rejected from a project network, with a reason instead of the 403
  // "unknown". The rules do answer without the ops marker too, but from a project network they stay closed.
  Z("project-setup", "*", "/api/projects/:project/setup/**", "rejected", {
    reason: "only the human sets up a project — sources, conflict, retry, never a project container",
    withoutMcp: "project creation UI (web and iOS)" }),
  // The pieces of an archive (`POST …/archive`): `**` also hits `/archive` itself and the routes of the later archive
  // (`…/archive/check`, `…/archive/unpack`).
  Z("project-archive", "*", "/api/projects/:project/archive/**", "rejected", {
    reason: "only the human uploads an archive, never a project container",
    withoutMcp: "project creation UI (web and iOS)" }),
  // Uploading later: begin, finish, cancel, discard. `**` hits `/upload/begin` and `/upload/<operation>[/…]`. The pieces go
  // through `POST …/upload`, for which this table has NO row (rowFor returns null): from a project network the fence answers
  // 403 "… is not released from a project container (no row in the fence table)" there, without a reason of its
  // own; or they go through `…/archive` (row "project-archive").
  Z("project-upload", "*", "/api/projects/:project/upload/**", "rejected", {
    reason: "only the human uploads and applies afterwards, never a project container",
    withoutMcp: "project creation UI (web and iOS)" }),
  // The layout of an existing project (read, check; later adopt and job): `**` also hits `/layout` itself. Rejected from a
  // project network: an agent in the container would otherwise rearrange the ground it stands on.
  Z("project-layout", "*", "/api/projects/:project/layout/**", "rejected", {
    reason: "only the human changes the outline of a project, never a project container",
    withoutMcp: "layout UI in the project tab (web and iOS)" }),
  // Read and remove the old containers of renamed stacks: `**` also hits `/superseded` itself (the inventory). Rejected from a
  // project network: an agent in the container would otherwise delete the data of the old stack (final) without the human's
  // confirmation.
  Z("project-superseded", "*", "/api/projects/:project/superseded/**", "rejected", {
    reason: "only the human removes the old containers of a renamed stack, after the confirmation, never a project container",
    withoutMcp: "services page of the project (web and iOS)" }),
  Z("projectCreation", "*", "/api/projectCreation/**", "rejected", {
    reason: "the rules of project creation belong to the human's interface, never to a project container",
    withoutMcp: "project creation UI (web and iOS)" }),
  // The stored git access of the host for Git LFS in an agent shell. ALLOWED from the project network: the only way a stored
  // git access reaches a project container; "git-access" (VS Code in B) stays rejected. POST only, only the OWN project
  // (`:project`), copies included (no `onlyFromMain`: an agent in a copy fetches LFS files just the same); the route takes the
  // workspace from the project of the instance, never from the body (projectbox/lfs-access.js). The value is then readable
  // for the agent.
  Z("lfs-access", "POST", "/api/projects/:project/lfs-access", "allowed", {
    withoutMcp: "the git credential helper cbase-lfs-access (server/backend/) in the agent shells of the project container — no MCP tool" }),
  // The copies of the stack from a project network. Scope: the OWN project (`:project`), every copy of this project (every
  // agent of a coding chat fetches and clears away, also the copy it runs in itself — from it after the turn). CREATE: only
  // from the main instance (`onlyFromMain`: nothing is created from a copy ⇒ 409 with the token of a copy, whatever the chat)
  // and only for a chat of THIS instance (BODY copyForChat: a chat of another project or instance is 403; the route itself
  // also rejects a non-coding chat with 403, stacks/request.js). The TEMPLATE may be a ready copy (`baseInstance` in the body,
  // checked by the route, stacks/request.js templateOf), but creation still happens from the main instance; whether an agent
  // may also create from inside a copy is undecided. Every other method or subroute has no row ⇒ 403 (unknown).
  Z("project-copy-create", "POST", "/api/projects/:project/stack-copies", "allowed", {
    body: "copyForChat",
    onlyFromMain: "no copy is created from inside a copy — it is created from the main instance, as a template also from a ready copy (`baseInstance`); in the copy the agent only works, fetches and clears away",
    ...MCP }),
  Z("project-copies", "GET", "/api/projects/:project/stack-copies", "allowed", MCP),
  Z("project-copy", "GET", "/api/projects/:project/stack-copies/:name", "allowed", {
    withoutMcp: "the row of one copy (REST, acceptance in B) — the tool cbase_copy_stack_list reads the list with all rows" }),
  Z("project-copy-fetch", "POST", "/api/projects/:project/stack-copies/:name/fetch", "allowed", MCP),
  Z("project-copy-clear-away", "DELETE", "/api/projects/:project/stack-copies/:name", "allowed", MCP),
  // The delete preview belongs to the human's dialog: an agent clears away with cbase_copy_stack_remove and reads what lies in
  // the copy with git itself.
  Z("project-copy-status", "GET", "/api/projects/:project/stack-copies/:name/state", "rejected", {
    reason: "the delete preview of a copy is read by the human's delete dialog — from a project container git reads the state itself",
    withoutMcp: "delete dialog of the “Instances” tab (web and iOS)" }),
  // The actions on an instance (projectbox/instance-actions.js) belong to the human in the “Instances” tab: agents have no
  // tool for them, and a branch switch or a stack restart from inside the project container would move the ground under the
  // own run. One row per route, rejected with a reason (`:name` is the instance "main"/"copy-<name>": a free parameter, the
  // route checks it itself). The tree of the instances is read by the tab; agents have cbase_copy_stack_list, and every open
  // instance costs a `docker exec`: from a project container there would be no viewer for it.
  Z("project-instances", "GET", "/api/projects/:project/instances", "rejected", {
    reason: "the tree of the instances is read by the “Instances” tab — agents read their copies through cbase_copy_stack_list",
    withoutMcp: "UI of the “Instances” tab (web and iOS)" }),
  // The git overview, its fetch, the detail and the diff are read by the “Git” sub-item of a project (web and iOS): `**` hits
  // `/gitView` itself and every route below it. An agent reads git in its container itself; the fetch across all instances
  // belongs to the human.
  // Timeline per project: the path of the timeline agent (write: POST, its read tool: GET). It runs in the project container
  // of this project; WHO may write is checked by the route against the run marker (timeline/agent.js, 403 without a running
  // timeline-agent run on a chat of this project). Everything else under /timeline (list, switch, dismiss) belongs to the human.
  Z("project-timeline-agent", ["GET", "POST"], "/api/projects/:project/timeline/agent", "allowed", MCP),
  Z("project-timeline", "*", "/api/projects/:project/timeline/**", "rejected", {
    reason: "only the human reads and discards the timeline (“Timeline” tab, right chat bar) and the timeline agent through …/timeline/agent",
    withoutMcp: "UI Projects → Timeline and right chat rail (web and iOS)" }),
  Z("project-git-view", "*", "/api/projects/:project/gitView/**", "rejected", {
    reason: "the git overview is read by the “Git” sub-item of a project (web and iOS) — from a project container git reads the own branches itself",
    withoutMcp: "UI Projects → Git (web and iOS)" }),
  Z("project-instance-repos", "GET", "/api/projects/:project/instances/:name/repos", "rejected", {
    reason: "the repos of an instance are read by the “Instances” tab — from a project container git reads the own repos itself",
    withoutMcp: "UI of the “Instances” tab (web and iOS)" }),
  Z("project-instance-branch", "POST", "/api/projects/:project/instances/:name/branch", "rejected", {
    reason: "only the human switches the branch of an instance, in the “Instances” tab — it would move the code under running work",
    withoutMcp: "UI of the “Instances” tab (web and iOS)" }),
  Z("project-instance-dismiss", "POST", "/api/projects/:project/instances/:name/dismiss", "rejected", {
    reason: "only the human discards the files of an instance, in the branch-switch dialog",
    withoutMcp: "UI of the “Instances” tab (web and iOS)" }),
  Z("project-instance-stack-restart", "POST", "/api/projects/:project/instances/:name/stack-restart", "rejected", {
    reason: "only the human restarts the stack of an instance — from the project container it would replace the containers under the caller",
    withoutMcp: "UI of the “Instances” tab (web and iOS)" }),
  Z("project-instance-stop", "POST", "/api/projects/:project/instances/:name/stop", "rejected", {
    reason: "only the human stops an instance — from the project container an agent would stop the container under itself",
    withoutMcp: "UI of the “Instances” tab (web and iOS)" }),
  Z("project-instance-start", "POST", "/api/projects/:project/instances/:name/start", "rejected", {
    reason: "a stopped instance is started by the human or by a run at the lock — no way from a project container",
    withoutMcp: "UI of the “Instances” tab (web and iOS); a turn in the instance starts it at the lock itself" }),
  Z("project-instance-start-abort", "POST", "/api/projects/:project/instances/:name/start-abort", "rejected", {
    reason: "only the human cancels a start waiting for memory",
    withoutMcp: "UI of the “Instances” tab (web and iOS)" }),
  Z("project-context", ["GET", "POST"], "/api/projects/:project/context", "allowed", MCP),
  Z("project-context-categories", "GET", "/api/projects/:project/context/categories", "allowed", MCP),
  Z("project-context-throw", "POST", "/api/projects/:project/context/dump", "allowed", MCP),
  Z("project-context-slug", "GET", "/api/projects/:project/context/by-slug/:slug", "allowed", MCP),
  Z("project-context-entry", ["GET", "PUT", "DELETE"], "/api/projects/:project/context/:entry", "allowed", MCP),
  Z("project-context-check", "POST", "/api/projects/:project/context/:entry/verify", "allowed", MCP),
  // Log, start and stop of a service act from a project network only in the OWN instance: `instance` is set to its identifier
  // (added if missing; any other value, also empty, is 403). Otherwise a copy would start a service in the main instance via
  // `?instance=<project>/main` and vice versa.
  Z("project-service-log", "GET", "/api/projects/:project/services/:service/log", "allowed", { enforce: { instance: "instance" }, ...MCP }),
  Z("project-service-start", "POST", "/api/projects/:project/services/:service/start", "allowed", { enforce: { instance: "instance" }, ...MCP }),
  Z("project-service-stop", "POST", "/api/projects/:project/services/:service/stop", "allowed", { enforce: { instance: "instance" }, ...MCP }),
  Z("project-accesses", "GET", "/api/projects/:project/vars", "allowed", MCP),
  Z("project-access", "GET", "/api/projects/:project/vars/by-key/:key", "allowed", MCP),
  Z("workspace-accesses", "GET", "/api/workspaces/:workspace/vars/**", "rejected", {
    reason: "credentials apply from the project container as those of the own project do today (/api/projects/:id/vars)", ...MCP }),
  // The stored git access of the workspace goes only to cbase-project in B (git-assignment.js gitAccessResponse): from a
  // project network never, even with a token, explicitly BEFORE any broader workspace row.
  Z("git-access", "*", "/api/workspaces/:workspace/git-access", "rejected", {
    reason: "the stored git access goes only to cbase-project in B, never to a project container",
    withoutMcp: "access for VS Code in B (cbase-git → cbase-project --git-access)" }),
  Z("project-create", "POST", "/api/workspaces/:workspace/projects", "rejected", {
    reason: "writing goes only into the own project — a new project is created by the human",
    withoutMcp: "the human creates a project through the UI" }),

  // ── services and ports ─────────────────────────────────────────────────────────────────────────
  Z("services", "GET", "/api/project-services", "filtered", { filter: "services", ...MCP }),
  Z("service-create", "POST", "/api/project-services", "allowed", { body: "serviceOfTheProject", ...MCP }),
  Z("service", ["PATCH", "DELETE"], "/api/project-services/:service", "allowed", MCP),
  Z("service-commands", "GET", "/api/project-services/:service/command-history", "allowed", MCP),
  Z("ports", "GET", "/api/ports", "filtered", { filter: "ports", ...MCP }),
  // From a project network, port list and port choice ask only the namespace of THIS instance: `instance` is set to its
  // identifier (added if missing; any other value, also empty = B, is 403). Otherwise the backend would probe the ports of B
  // and all other instances for the container.
  Z("ports-running", "GET", "/api/ports/running", "filtered", { filter: "portsRunning", enforce: { instance: "instance" }, ...MCP }),
  Z("ports-free", "GET", "/api/ports/free", "filtered", { filter: "portsFree", enforce: { instance: "instance" }, ...MCP }),

  // ── workspace-wide, without a project reference ────────────────────────────────────────────────
  Z("workspaces", "GET", "/api/workspaces", "filtered", { filter: "workspaces", ...MCP }),
  Z("workspace-context", "GET", "/api/workspaces/:workspace/context", "allowed", MCP),
  Z("workspace-context-drop-in", "POST", "/api/workspaces/:workspace/context", "allowed", { body: "dropInWithoutForeignProject", ...MCP }),
  Z("workspace-context-entry", "PUT", "/api/workspaces/:workspace/context/:entry", "allowed", MCP),
  Z("effective-skills", "GET", "/api/workspaces/:workspace/effective-skills", "allowed", {
    enforce: { projectId: "project" }, withoutMcp: "slash picker of the composer; from the project network only the set of the own project" }),
  Z("effective-workflows", "GET", "/api/workspaces/:workspace/effective-workflows", "allowed", {
    enforce: { projectId: "project" }, withoutMcp: "workflow choice of the composer; from the project network only the set of the own project" }),
  // ── chats: only chats of the own project, with their graph children ────────────────────────────
  // `:chat` demands a chat of THIS instance (fence.js PARAMETER.chat = chatInstance): through the run routes of a chat
  // (subagent, monitor, wakeup, workflow, capture …) a token starts and controls only in its own instance. At the project
  // level (`:chatInProject`) only the pure read rows with `readInProject` remain.
  // "chats", "chat-history", "channel-send" and "active-runs" are called by no MCP tool any more (the tool pair goes through
  // "chat-communication" and "chat-agent-send"). They STAY with their limit (`withoutMcp: COMMUNICATION_OLD`): an agent with
  // Bash in the project container that calls one of them itself gets the same verdict as before — dropping them would have
  // turned "filtered/allowed" into a 403 without the spec deciding it.
  Z("chats", "GET", "/api/chats", "filtered", { filter: "chats", query: { workspaceId: "workspace" }, withoutMcp: COMMUNICATION_OLD }),
  Z("chat", "GET", "/api/chats/:chatInProject", "allowed", {
    readInProject: "the chat row from the database of B — the filtered list shows the same chats (`chats`); the MCP server reads workspace and project of its chat with it", ...MCP }),
  Z("chat-change", "PATCH", "/api/chats/:chat", "allowed", { body: "withoutProjectSwitch", ...MCP }),
  // cbase_switch_instance sets the binding of the OWN chat: `:chat` is a chat of the token's instance (or one with a live run
  // in it); an instance of another project is unknown to the route (instanceChoice).
  Z("chat-instance", "POST", "/api/chats/:chat/instance", "allowed", MCP),
  Z("chat-history", "GET", "/api/chats/:chatInProject/log", "allowed", {
    readInProject: "the history from the database of B — every chat of the project is readable, no file and no process of an instance", withoutMcp: COMMUNICATION_OLD }),
  Z("chat-agent", "POST", "/api/chats/:chat/agent", "allowed", MCP),
  // cbase_agent_send: the sender is the chat in the path (`:chat`, this instance). The body names the target (`to`): an own
  // subagent as before (the route checks its instance), `channel:<id>` like "channel-send" (the sender is a participant),
  // `chat:<id>` ANY chat of the workspace across project and instance borders (the route checks workspace and readability,
  // communication/target-chat.js) — BODY.agentSendInScope.
  Z("chat-agent-send", "POST", "/api/chats/:chat/agent/send", "allowed", { body: "agentSendInScope", ...MCP }),
  // The body: `from: "human"` (button of the UI) never from a project network — the same holds in "chat-agent-send"
  // (agentSendInScope); "stop all" (/agents/stop) has no row.
  Z("chat-agent-stop", "POST", "/api/chats/:chat/agent/stop", "allowed", { body: "stopNotFromHuman", ...MCP }),
  Z("chat-agent-output", "POST", "/api/chats/:chat/agent/output", "allowed", MCP),
  Z("chat-agents", "GET", "/api/chats/:chat/agents", "allowed", { withoutMcp: "cbase_agents_list reads the agent types through “chat-communication” (view start, same body: communication/read.js startView) — the route stays for test benches and tests" }),
  // cbase_agents_list: the reader is the chat in the path (`:chat`, this instance); the target is in the query. Overview, list,
  // search and read (`?chatId`, also tool outputs) go across project and instance borders within the workspace: the limit is
  // solely the predicate of the route (communication/visibility.js readableReason — same workspace, readable); `?projectId`
  // only filters. `?channelId` stays a channel with a chat of the project (the reader is a participant). The old row
  // "chat-history" stays at the project level.
  Z("chat-communication", "GET", "/api/chats/:chat/communication", "allowed", {
    query: { channelId: "channel" },
    ...MCP }),
  // cbase_chat_analysis: an outer-loop run WITH tools runs where its chat is, so in the project container — it reads only the
  // observed chat (`:chat`, this instance). Run, agent and chat are checked by the route (outerloop/analysis.js checkRunMarker,
  // else 403).
  Z("chat-outer-loop-analysis", "GET", "/api/chats/:chat/outer-loop/analysis", "allowed", MCP),
  Z("chat-question", "POST", "/api/chats/:chat/ask", "allowed", MCP),
  Z("chat-approval-request", "POST", "/api/chats/:chat/permission-request", "allowed", MCP),
  Z("chat-monitor", "POST", "/api/chats/:chat/monitor", "allowed", MCP),
  Z("chat-monitor-stop", "POST", "/api/chats/:chat/monitor/stop", "allowed", MCP),
  Z("chat-wakeup", "POST", "/api/chats/:chat/wakeup", "allowed", MCP),
  Z("chat-dyn-workflows", ["GET", "POST"], "/api/chats/:chat/dyn-workflows", "allowed", MCP),
  Z("chat-dyn-workflow-run", "POST", "/api/chats/:chat/dyn-workflows/run", "allowed", MCP),
  Z("chat-dyn-workflow-stop", "POST", "/api/chats/:chat/dyn-workflows/stop", "allowed", MCP),
  Z("chat-dyn-workflow-bote", "POST", "/api/chats/:chat/dyn-workflows/structured-output", "allowed", MCP),
  Z("chat-graph-workflows", "GET", "/api/chats/:chat/graph-workflows/**", "allowed", MCP),
  Z("chat-graph-start", "POST", "/api/chats/:chat/graph-workflows/start", "allowed", MCP),
  Z("chat-graph-stop", "POST", "/api/chats/:chat/graph-workflows/:start/stop", "allowed", MCP),
  Z("chat-captures", "POST", "/api/chats/:chat/captures/**", "allowed", MCP),
  Z("chat-artifacts", "GET", "/api/chats/:chat/artifacts/**", "allowed", { query: { chatId: "chatInProject" },
    readInProject: "?chatId reads the artifacts of a sibling chat in the folder (cbase_artifacts_read) — files under <data> of B, none of an instance", ...MCP }),
  Z("chat-artifacts-write", ["PUT", "DELETE"], "/api/chats/:chat/artifacts/**", "allowed", { query: { chatId: "chat" }, ...MCP }),
  Z("chat-folder-context", "GET", "/api/chats/:chat/folder-context/**", "allowed", MCP),
  // The agenda per coding chat: the reader or writer is the chat in the path (`:chat`, this instance). Reading goes like
  // "chat-communication" across project and instance borders within the workspace (`?chatId` of another chat, `?list`): the
  // limit is the predicate of the route (communication/visibility.js readableReason); writing only the OWN agenda, and only
  // the main agent (agenda/routes.js via communication/sender.js).
  Z("chat-agenda", "GET", "/api/chats/:chat/agenda", "allowed", MCP),
  Z("chat-agenda-write", "PUT", "/api/chats/:chat/agenda", "allowed", MCP),
  // The agenda's archive (entries, search): read like the agenda itself — `?chatId` of another chat by the same predicate.
  Z("chat-agenda-archive", "GET", "/api/chats/:chat/agenda/archive", "allowed", MCP),
  // The agenda keeper: the chat in the path is the observed one; who may write is checked by the route against the run marker
  // (agenda/upkeep.js, 403 without a running keeper run on this chat).
  Z("chat-agenda-maintain", "POST", "/api/chats/:chat/agenda/upkeep", "allowed", MCP),
  Z("chat-skill", "GET", "/api/chats/:chat/skills/:name", "allowed", MCP),
  // Writing skills: the chat in the path is the writer; ONLY the main agent of a coding chat and only with the toggle on
  // (toolchain/skill-routes.js via communication/sender.js). Which skills it may change is the set of its chat (chatSkills) —
  // from a project container the own project and the workspace coding skills that apply there.
  Z("chat-skill-write", "POST", "/api/chats/:chat/skill-write", "allowed", MCP),
  // Coding MCP airlock: start, list, call and JSON-RPC of a coding MCP server — the chat in the path is that of the run token
  // (toolchain/airlock-routes.js checks both); from a project container only the runs of this instance.
  Z("chat-mcp-airlock", ["GET", "POST"], "/api/chats/:chat/mcp-airlock/**", "allowed", { withoutMcp: AIRLOCK }),
  // The channel list of a chat (GET /api/chats/:id/channels[/:channel]).
  Z("chat-channels", "GET", "/api/chats/:chat/channels/**", "allowed", { withoutMcp: COMMUNICATION_OLD }),
  Z("channel-send", "POST", "/api/channels/:channel/messages", "allowed", { body: "senderOfTheProject", withoutMcp: COMMUNICATION_OLD }),
  Z("active-runs", "GET", "/api/active-runs", "filtered", { filter: "activeRuns", withoutMcp: COMMUNICATION_OLD }),

  // ── language service: only files under the project folder (after realpath) ─────────────────────
  Z("language-service", "POST", "/api/lsp", "allowed", { body: "fileInProject", ...MCP }),

  // ── what no MCP tool calls, but is regulated explicitly ────────────────────────────────────────
  Z("runs-counter", "GET", "/api/runs/active", "filtered", {
    filter: "runsCounter", withoutMcp: "busy status of the gateway and the deploy — open from outside the project networks as today" }),
  // The ops status names projects of the user (without an instance row, compose containers in B): only for Claude in B
  // (the operator's status check).
  Z("ops-status", "*", "/api/projectbox/ops-status", "rejected", {
    reason: "the operating state names the user's projects by name — only for Claude in B, never for a project container",
    withoutMcp: "status lines “Einrichtungen” and “Compose in B (umgestellt)” of the operator's status check (docker exec -u agent <B> curl …)" }),
  // The snapshot `desired` of all ready project containers — only the gateway calls it, before destroy.
  Z("desired-snapshot", "*", "/api/projectbox/desired-snapshot", "rejected", {
    reason: "the snapshot reads the inside of EVERY project container of the user — only for the gateway, never for a project container",
    withoutMcp: "gateway destroy (server/gateway/containers.js snapshotBeforeTheStop), before marker and stop script" }),
  Z("events", "*", "/api/events", "rejected", {
    reason: "the global event stream carries every chat and every project", withoutMcp: "stream of the UI" }),
  Z("tunnel", "*", "/api/tunnel", "rejected", {
    reason: "the port tunnel reached every loopback and docker-proxy port of B past the INPUT filter (tunnel.js)", withoutMcp: "port forwarding of the client" }),
  Z("browser-devtools", "*", "/api/browsers/:browser/devtools/**", "allowed", {
    withoutMcp: "DevTools frontend of the chat rail; only browsers of the own project (also the WS upgrade, browsers.js)" }),
]);

const segments = (path) => String(path || "").split("?")[0].split("/").filter((s, i) => i > 0 || s !== "");

/** Does `path` match `pattern`? → the bound parameters `{ name: value }` (decoded), else `null`. */
export function patternMatches(pattern, path) {
  const m = segments(pattern);
  const p = segments(path);
  const params = {};
  for (let i = 0; i < m.length; i++) {
    if (m[i] === "**" && i === m.length - 1) return params;
    if (i >= p.length) return null;
    if (m[i].startsWith(":")) {
      if (!p[i]) return null;
      let value;
      try { value = decodeURIComponent(p[i]); } catch { return null; }
      params[m[i].slice(1)] = value;
      continue;
    }
    if (m[i] !== p[i]) return null;
  }
  return p.length === m.length ? params : null;
}

/** The first row for method and path → `{ row, params }`, else `null` (unknown ⇒ 403). */
export function rowFor(method, path, table = FENCE_TABLE) {
  const m = String(method || "").toUpperCase();
  for (const row of table) {
    if (!row.methods.includes("*") && !row.methods.includes(m)) continue;
    const params = patternMatches(row.pattern, path);
    if (params) return { row, params };
  }
  return null;
}

/** The names of the path parameters of a pattern (for the guard). */
export const parameterOf = (pattern) => segments(pattern).filter((s) => s.startsWith(":")).map((s) => s.slice(1));
