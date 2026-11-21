// Guard of ALL start places of the project containers. inProject.test.js holds the ONE start function and the main seams Claude,
// Codex and subagent; this file holds the remaining ways in which a run or a code view starts a process — Bash and BashOutput of the
// loop engine (providers/tool-runtime.js), its hooks (providers/hook-run.js), stdio MCP (providers/mcp-client.js), the monitor of the
// turn (runs/do-run.js → providers/monitor-runtime.js), terminal and debugger (devtools/code-route.js → terminal.js, debug.js) and
// the browser tab (devtools/routes.js → browsers.js).
//
// The promises, each with the way that breaks it:
//   (A) SOURCE CODE TABLE. Every call of `inProject(`/`inProjectCall(` under server/backend/electron/ is in START_PLACES — file,
//       name, first argument verbatim, count, origin of the instance. Red: a literal `null`/`undefined`/`false` as instance, a missing
//       place, a new place without an entry. The origin is pinned in EDGES: the places where the instance of the turn comes into being
//       and travels to the start place (object property `instance` verbatim, or a line). In addition, in the files of the start paths
//       (providers/**, terminal.js, debug.js, browsers.js, devtools/**): every other child process (`spawn`, `spawnSync`, `execFile`,
//       `exec…`, `fork`, `pty.spawn`) is in CHILDREN_ALLOWED with a reason, `node:child_process` is imported only with the names from
//       KIND_IMPORTS, `node-pty` only in terminal.js — a new child process past inProject is red, and so is an entry without a place
//       (the list may only shrink). Comments do not count (`views` blanks them out, strings and templates do not count as brackets).
//       The built-in sabotage (A2) shows every rule red, including the sabotage of all places at once to B.
//       Plus the NAMED EXCEPTIONS: terminal, debugger and browser tab of the workspace level (workspaces/routes.js) stay in B, even if
//       the workspace folder contains converted projects — EXCEPTIONS_WITHOUT_INSTANCE pins each of these calls verbatim without an
//       instance; red if it is missing or carries one.
//   (B) MAIN SEAM LOOP ENGINE: a chat on the fake preset endpoint (agent-harness.mjs) in a converted project (operating mark, fake
//       docker, instance row). The engine calls Bash (front and background), a PreToolUse hook runs before every Bash, the cbase MCP is
//       a stdio server, and a monitor watches permanently. Each of these processes stands as `docker exec … <container>
//       /usr/sbin/cbase-wrapper --pgid-file <processes>/… -- …` in the log, and each writes a mark "pid pgid": in the fake docker it is
//       leader of its OWN group (as in the container), a spawn in B would share the group of the server. The stop ends the group of the
//       monitor in the container.
//   (C) MAIN SEAM CODE ROUTES: `POST /api/projects/:id/terminal`, `/debug/launch` and `/browser/ensure` of a converted project start in
//       the project container (wrapper, pgid file under `processes/`); closing or stopping ends the group there. The browser is a fake
//       Chromium (CBASE_CHROMIUM) that writes its mark and ends.
//   (E) ADMINISTRATION GIT: every git start under server/backend/electron/ (a call whose first argument is the string "git" or
//       "git …") is in GIT_STARTER — the CURRENT starter of a file as a named fallback (reachable only through `fallback: () =>
//       <name>(`, so only without an instance; runtime/git-run.js gitRun). There is no open item any more: the worktree of a subagent
//       (providers/agent-runtime.js, with an instance through `gitOf` from runs/agents.js) and that of a graph workflow
//       (workflows/worktree.js) are converted, and (E1) is red for every entry that is not a fallback. Red: a new git start, a
//       fallback that is called other than through `fallback:`, an entry without a place (the list may only shrink). The way of the
//       instance to the starter stands in EDGES, the starter itself in START_PLACES. The built-in sabotage (E2) shows every rule red.
//   (D) THE SIMPLE SERVICE START: services.js `startSimple` goes through inProject — for a converted project `POST
//       /api/projects/:id/services/:sid/start` answers `mode: "simple"` 202, and the start command runs in the project container
//       (`docker exec -d … cbase-wrapper --pgid-file <processes>/… --log … --exit … -- sh -lc <start command>`, leader of its group);
//       without an instance row the same service starts in B as before (spawn, no exec). services.js is therefore in START_PATHS. Stop,
//       exit file, watcher and target are held by projectbox-services.test.js. Counter-test: services.js, server.js and
//       projects/routes.js with the 409 of the route restored => (D) red with "no docker exec -d with the wrapper".
//   (L) THE LFS ENVIRONMENT: every line of START_PLACES says `lfs` yes/no with `lfsReason`; yes means `withLfsEnvironment(<first
//       argument>, { … })` as options (runs/lfs-environment.js), no means none. Red: a line without a statement, a call against its
//       line, the environment of another instance, a `withLfsEnvironment(` beside the table, the environment centrally in
//       runtime/inProject.js (then the service detection would carry it) — (A2) shows every rule red. On the wire: (B) Bash, hook and
//       monitor of the loop engine carry the four `-e NAME`, the stdio MCP does not; (C) terminal, debugger, browser and the
//       administration git do not; (D) the service does not. Claude, Codex and the detection are held by
//       server/backend/test/lfs-access.test.js.
//   (F) ROOT IN THE CONTAINER: `commandRun(…, { asUser: "root" })` is in AS_ROOT per call with a reason (file, beginning of the
//       call); red: a root start without an entry, an `asUser` from a variable or in shorthand, a "root" outside a `commandRun(` call,
//       an entry without a place. (F2) shows every rule red (built-in sabotage).
//
// No clock: waiting is on marks that BOTH ways write (in the container and past it), then checked — a start past the wrapper turns
// red instead of hanging silently. The grace period of the escalation is 200 ms (it speeds up, decides nothing; see runtime/inProject.js).
//
// Counter-test map: all start places at once to B (`inProject(null, …)` or `inProjectCall(null, …)` at the nine places, `instance:
// null` at the edges, the monitor of the turn without `instance`) in a copy of the tree: inProject.test.js stays green, this file is
// red in (A1), (B) and (C); without the sabotage green. (A2) carries the same sabotage built in. The five start places without the
// `withLfsEnvironment` change => (A1) red (six calls "their line says yes" and the count 0 instead of 6), (A2) red (its sabotage is
// outdated) and (B) red ("-e CBASE_LFS_URL is missing" at Bash).
//
// The small helpers (withEnvironment, ops, containerStart, projectInOps) also stand in inProject.test.js — a test file never imports
// another (server/backend/test/README.md).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { WRAPPER_PATH, openEscalations } from "../electron/server/runtime/inProject.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const ELECTRON = path.resolve(TESTDIR, "..", "electron");

// ── (A) The tables ────────────────────────────────────────────────────────────────────────────
// Every start place: file (relative to server/backend/electron), name, first argument verbatim, count, origin — and the column "LFS
// environment": `lfs` yes/no and `lfsReason`. Yes means: the options of the call are `withLfsEnvironment(<the same instance>, { … })`
// (runs/lfs-environment.js — the four names with which a git in the shell of an agent fetches LFS files); no means: the call does not
// carry them. A line without a statement is red, so is a call that does something other than its line says, and every
// `withLfsEnvironment(` outside a yes line (see check, (1b)).
const LFS_IN_AGENT_SHELL = "a shell of the agent (\"LFS in agent shells\"): a git in it fetches LFS files with the stored access";
export const START_PLACES = [
  { file: "server/providers/connectors/claude.js", name: "inProject", first: "spec.instance || null",
    origin: "spec of the run: turn (do-run.js `const spec = {` instance) or subagent (agents.js `instance: agentInstance`)",
    lfs: true, lfsReason: `the Claude CLI of a turn or subagent — its Bash and its hooks inherit the environment; ${LFS_IN_AGENT_SHELL}` },
  { file: "server/providers/connectors/codex.js", name: "inProject", first: "spec.instance || null",
    origin: "wie claude.js",
    lfs: true, lfsReason: `Codex of a turn or subagent — its shell inherits it (the pinned version does not strip KEY/TOKEN/SECRET); ${LFS_IN_AGENT_SHELL}` },
  // The service detection of a converted project in the project container.
  { file: "server/providers/connectors/claude.js", name: "inProject", first: "instance",
    origin: "oneshot of the service detection: runOnceClaude({ instance }) ← providers/index.js runOnce (`...opt`) ← claude.js scanServices `runOnce(prompt, { … instance })` ← projects/scans.js `instanceForProject(pid)`",
    lfs: false, lfsReason: "the service detection is a oneshot with Read/Glob/Grep, no agent shell (not at runOnceClaude/runOnceCodex)" },
  { file: "server/providers/tool-runtime.js", name: "inProject", first: "ctx.instance || null", count: 2,
    origin: "Bash in front and in the background (BashOutput reads its buffer): toolCtx of the engine (engine.js `const toolCtx = {`)",
    lfs: true, lfsReason: `the Bash of the loop engine, in front and in the background; ${LFS_IN_AGENT_SHELL}` },
  // The hook run lives in hook-run.js, not in engine.js — ONE way for the hooks of the engine and the "SubagentStop" of the core
  // (runs/agents.js); the edges below carry both origins.
  { file: "server/providers/hook-run.js", name: "inProject", first: "instance",
    origin: "hooks: executeHook({ instance }) ← engine.js `spec.instance || null` (spec of the run, as claude.js) or fireAgentHook ← runs/agents.js `instance || null` (the instance of the core, SubagentStop)",
    lfs: true, lfsReason: `the hooks of the loop engine and the SubagentStop of the core — like the hooks of the Claude CLI, which inherit the environment; ${LFS_IN_AGENT_SHELL}` },
  { file: "server/providers/mcp-client.js", name: "inProject", first: "this.instance",
    origin: "stdio MCP: StdioClient ← makeClient ← connectMcpServers({ instance }) ← engine.js `spec.instance || null`",
    lfs: false, lfsReason: "a stdio MCP server is a tool server, no agent shell (not at the MCP client)" },
  { file: "server/providers/monitor-runtime.js", name: "inProject", first: "instance",
    origin: "monitor: createMonitorRuntime({ instance }) ← runs/monitors.js startMonitor({ instance }) ← do-run.js (turn instance, held at the start — the monitor lives on the chat afterwards)",
    lfs: true, lfsReason: `the monitor, a command that the agent starts; ${LFS_IN_AGENT_SHELL}` },
  { file: "server/terminal.js", name: "inProjectCall", first: "instance",
    origin: "terminal (pty): createTerminal({ instance }) ← code-route.js `inst` (tag chat:<id> => opts.instanceForChat, otherwise opts.instance) ← devtools/routes.js instanceForProject",
    lfs: false, lfsReason: "the terminal of the human (not for terminals — there `git lfs pull` asks the helper without an environment, it stays silent)" },
  { file: "server/debug.js", name: "inProject", first: "instance",
    origin: "debugger: debugLaunch({ instance }) ← code-route.js `inst` (= opts.instance || null) ← devtools/routes.js instanceForProject",
    lfs: false, lfsReason: "the debugger of the human, no agent shell" },
  { file: "server/browsers.js", name: "inProject", first: "instance",
    origin: "browser tab: launchUserBrowser({ instance }) ← ensureUserBrowser ← devtools/routes.js instanceForProject",
    lfs: false, lfsReason: "the Chromium of the browser tab, no git" },
  // The simple service start. services.js is a leaf without a store — the instance comes through its seam.
  { file: "server/services.js", name: "inProject", first: "target",
    origin: "simple service start: startSimple `const target = targetOf(projectId, instance)` ← setServicesSeam (server.js) ← projectbox/services.js servicesSeam `networkTarget(runInstance(projectId, instance))` (per instance, without one main)",
    lfs: false, lfsReason: "a service of the project (not for services)" },
  // The ONE starter of the administration git with its companions (read bundle `sh -c`, search of the project repo `node -e`).
  { file: "server/runtime/git-run.js", name: "inProject", first: "inst",
    origin: "commandRun/gitRun ← git.js instanceFrom(opts) (code-route.js gitOptions ← devtools/routes.js instanceForProject or workspaces/routes.js gitInstanceForWorkspace), okf.js ← projects/routes.js instanceForProject, projectbox/projectRepo.js `{ instance }` (relocation), stacks/code-snapshot.js `helperInstance` (the clone helper of a copy, projectbox/run-instance.js containerOf `helperId`), stacks/request.js `runInstance(pid, MAIN)` (the copy refs of main; the pre-check of the base)",
    lfs: false, lfsReason: "the administration git has its own access per host (accessAsEnvironment) and fetches LFS itself; not at gitRun" },
  // Editor navigation: the language server of a session and the reading of a named target outside.
  { file: "server/lsp/sessions.js", name: "inProject", first: "inst",
    origin: "language server: start(s) `const inst = s.instance` ← sessionFor(target) ← devtools/code-route.js lspTargetFor (opts.instance ← devtools/routes.js targetInstance/withSelectedInstance; workspace level instanceForProject) or devtools/routes.js lspAgentTarget (fence token, runtime folder, instanceForProject)",
    lfs: false, lfsReason: "a language server is an analysis tool of the editor, no agent shell and no git" },
  { file: "server/lsp/limit.js", name: "inProject", first: "inst",
    origin: "read of a named target: readExternal(e) `const inst = e.inst || null` ← lsp/sessions.js rememberExternal (the instance of the session that named the target)",
    lfs: false, lfsReason: "`head -c` reads a file that the language server named as target — no agent, no git" },
  // The formatter of the project and the check of the Python interpreters run IN the instance.
  { file: "server/lsp/run.js", name: "inProject", first: "inst",
    origin: "runInProject(inst, …) ← lsp/formatter.js projectFormatter/firstExecutable and lsp/interpreter.js checkInProject with `target.instance || null` ← the same target as the language server (devtools/code-route.js lspTargetFor or devtools/routes.js lspAgentTarget/lspCopyTarget)",
    lfs: false, lfsReason: "Prettier/ruff/black read stdin and write stdout, the interpreter check is a `sh -c` with `--version` — no agent shell, no git" },
];

// The ways of the instance to the start places. `row`: the wording stands exactly once. `anchor` (+ optional `after`: the anchor is
// the first one AFTER this wording): the object that the last `{` of the anchor opens carries the property `instance` on its top
// level — `short` (shorthand) or exactly the expression `value`.
export const EDGES = [
  { file: "server/runs/do-run.js", row: "const instance = instanceOfChat(chat, runLocation);", purpose: "the instance of the turn (fixed at the start of the turn)" },
  { file: "server/runs/do-run.js", anchor: "const spec = {", short: true, purpose: "spec of the turn → Claude, Codex, engine (Bash, hooks, stdio MCP)" },
  // The monitor belongs to the chat (runs/monitors.js) — the instance of the turn goes along at the start and stays on it.
  { file: "server/runs/do-run.js", anchor: "startMonitor(chat.id, inputArgs, {", short: true, purpose: "monitor: start with the instance of the turn" },
  { file: "server/runs/monitors.js", anchor: "createMonitorRuntime({", short: true, purpose: "monitor: runtime in the instance of its start" },
  { file: "server/runs/do-run.js", anchor: "openAgents(agentContext({", short: true, purpose: "subagent core of the turn" },
  { file: "server/runs/do-run.js", after: "function agentContext(", anchor: "return {", short: true, purpose: "context of the core" },
  { file: "server/runs/agents.js", row: "const instance = context.instance !== undefined ? context.instance : instanceOfChat(chat, runLocation);", purpose: "instance of the core (without a turn: from its location)" },
  { file: "server/runs/agents.js", anchor: "agentSpecFactory(context, {", short: true, purpose: "spec factory of the subagents" },
  { file: "server/runs/agents.js", after: "const agentInstance = ", anchor: "return {", value: "agentInstance", purpose: "spec of a subagent" },
  { file: "server/providers/engine.js", anchor: "const toolCtx = {", value: "spec.instance || null", purpose: "Bash of the engine" },
  { file: "server/providers/engine.js", row: "runBuiltinTool(name, args, { ...toolCtx, toolUseId: id })", purpose: "Bash gets the toolCtx" },
  { file: "server/providers/engine.js", anchor: "connectMcpServers(spec.mcpServers || {}, {", value: "spec.instance || null", purpose: "stdio MCP of the engine" },
  { file: "server/providers/engine.js", anchor: "executeHook(command, payload, {", value: "spec.instance || null", purpose: "hooks of the engine with effect (PreToolUse, PostToolUse, …)" },
  { file: "server/providers/engine.js", anchor: "fireAgentHook(event, payload, {", value: "spec.instance || null", purpose: "hooks of the engine without effect" },
  { file: "server/providers/hook-run.js", anchor: "executeHook(h.command, { hook_event_name: event, ...payload, cwd, session_id: sessionId }, {", short: true, purpose: "fireAgentHook passes the instance to the hook run" },
  { file: "server/runs/agents.js", anchor: 'fireAgentHook("SubagentStop", { agent: type, agent_id: String(rep.agentId || ""), ...content }, {', value: "instance || null", purpose: "SubagentStop of the core: the instance of the core" },
  { file: "server/providers/mcp-client.js", anchor: "makeClient(name, def, {", short: true, purpose: "stdio MCP: pool → client" },
  { file: "server/providers/mcp-client.js", row: "return new StdioClient(name, def, opts);", purpose: "stdio MCP: makeClient passes the options through" },
  { file: "server/providers/mcp-client.js", row: "this.instance = instance;", purpose: "stdio MCP: the client remembers it" },
  // The instance of the terminal stands ONCE before the lock (the lock asks it), then in the start.
  { file: "server/devtools/code-route.js", row: "try { inst = (chatFromTag && opts.instanceForChat ? opts.instanceForChat(chatFromTag) : opts.instance) || null; }", purpose: "terminal of a project: its instance (the tag chat:<id> of the chat bar takes the instance of the chat)" },
  { file: "server/devtools/code-route.js", anchor: "createTerminal({", value: "inst", purpose: "terminal of a project: start in the instance that the lock checked" },
  { file: "server/devtools/code-route.js", row: "const inst = opts.instance || null;", purpose: "debugger of a project: its instance (before the lock)" },
  { file: "server/devtools/code-route.js", anchor: "debugLaunch({", value: "inst", purpose: "debugger of a project" },
  { file: "server/devtools/routes.js", anchor: "codeRoute(proj.path, sub, m, req, res, url, {", value: "target", purpose: "code routes of a project (the target instance, see the two lines below)" },
  { file: "server/devtools/routes.js", row: 'try { target = targetInstance(ctx, url.searchParams.get("chat")); }', purpose: "the target instance of the project routes comes from targetInstance — never a value of its own" },
  { file: "server/devtools/routes.js", row: "try { target = withSelectedInstance(ctx, url, target); }", purpose: "the instance choice of the code tab (?instance=) — from selectedInstance, never a value of its own" },
  { file: "server/devtools/routes.js", row: "return chatId ? instanceOfChat(String(chatId), { projectId: ctx.proj.id }) : instanceForProject(ctx.proj.id);", purpose: "targetInstance without a fence — the copy of the chat, otherwise that of the project (main as before)" },
  // Scope, profile and instance of the own browser are computed by ONE function (devtools/user-browser.js userBrowserTarget) — for
  // the route and for the turn whose main agent operates it (there with the turn instance, only on a project).
  { file: "server/devtools/routes.js", anchor: "userBrowserTarget({", value: "inst", purpose: "browser tab of a project (with ?chat the instance of the chat)" },
  // The browser of a CHAT (chatBrowserTarget) — in the instance of the chat or of the turn, a workspace chat in B.
  { file: "server/runs/do-run.js", anchor: "userBrowserForRun(chat, {", short: true, purpose: "the browser of the chat for the main agent in the instance of the turn (the same as its CLI)" },
  { file: "server/devtools/user-browser.js", anchor: "target = chatBrowserTarget(chat, {", short: true, purpose: "the turn passes its instance to the browser of the chat" },
  { file: "server/devtools/user-browser.js", anchor: "ensureUserBrowser(chatBrowserTarget(chat, {", short: true, purpose: "the route of the chat with the instance of the chat" },
  { file: "server/devtools/user-browser.js", anchor: "const scope = userBrowserTarget({", value: "project ? instance : null", purpose: "project chat in the instance, workspace chat in B" },
  { file: "server/browsers.js", anchor: ".then(() => launchUserBrowser({", short: true, purpose: "browser tab: ensure → start (after the end of a session at the old location)" },
  // The instance of the service detection — resolved in projects/scans.js, through scanServices to runOnce, from there with `...opt`
  // to runOnceClaude (the same line passes `projectId`/`instance` to the start gate, providers/index.js).
  { file: "server/projects/scans.js", row: "instance = instanceForProject(pid);", purpose: "detection: the instance of the project (main; only in operation and converted)" },
  { file: "server/projects/scans.js", anchor: "scanServices({", short: true, purpose: "detection: scans.js → scanServices" },
  { file: "server/claude.js", after: "export async function scanServices(", anchor: "runOnce(prompt, {", short: true, purpose: "detection: scanServices → runOnce" },
  { file: "server/providers/index.js", row: "return connector.runOnce(prompt, { ...opt, provider: id, model, effort, atConsumption });", purpose: "runOnce passes `instance` with `...opt` to the connector" },
  // The seam of the services (services.js asks it per call, `targetOf`).
  { file: "server/server.js", row: "setServicesSeam(servicesSeam());", purpose: "services: the seam is set" },
  { file: "server/projectbox/services.js", row: "instanceFor: (projectId, instance) => networkTarget(runInstance(projectId, instance)),", purpose: "services: the instance of a project (operating mark AND relocation; per instance, without one main)" },
  // Administration git: code view of both levels, git.js, OKF, project repo.
  { file: "server/devtools/code-route.js", after: "function gitOptions(", anchor: "return {", value: "fromChat || opts.instance", purpose: "git of the code view of a project (with ?chat=<id> the instance of THIS chat — opts.instanceForChat —, otherwise that of the project)" },
  // Plus `workspaceId: ws.id` — the workspace of the git accesses (the instance edge stays the same). Plus `...creation` — upload
  // stamp and write lock of the setup, only in operation; no instance (the exception "terminal and debugger of the workspace level"
  // below checks the object at the anchor).
  { file: "server/workspaces/routes.js", row: "{ gitInstanceSource: gitInstanceForWorkspace, workspaceId: ws.id, ...creation }", purpose: "git of the workspace level: per repo the instance of its project" },
  { file: "server/git.js", row: "const instance = instanceFrom(opts, root);", purpose: "git.js: the instance of an action (the repo root)" },
  { file: "server/git.js", row: "const including = (o) => ({ ...(o || {}), instance });", purpose: "git.js: the bound starters of an action" },
  { file: "server/git.js", row: "const inst = instanceFrom(opts, e.root);", purpose: "git.js: the git view per repo" },
  // The instance stands there BEFORE the try (unreadable is not "no repo") or before the situation.
  { file: "server/git.js", row: "const itself = instanceFrom(opts, projectPath);", purpose: "git.js: the instance of the question for the repo of a project" },
  { file: "server/git.js", anchor: 'git(projectPath, ["rev-parse", "--show-toplevel"], {', value: "itself", purpose: "git.js: the question for the repo of a project" },
  { file: "server/git.js", row: "const inst = instanceFrom(opts, candidate);", purpose: "git.js: the instance of the root of an action (also for its situation)" },
  { file: "server/git.js", anchor: 'git(candidate, ["rev-parse", "--show-toplevel"], {', value: "inst", purpose: "git.js: the root of an action" },
  { file: "server/okf.js", row: 'await git(g.repoRoot, ["rev-parse", "--short", "HEAD"], opts.instance || null)', purpose: "OKF: set anchor" },
  { file: "server/okf.js", row: '"--", ...g.paths,\n      ], opts.instance || null);', purpose: "OKF: outdated?" },
  { file: "server/projects/routes.js", anchor: "staleInfoForList(proj.path, mine, {", value: "instanceForProject(pid)", purpose: "OKF: list" },
  { file: "server/projects/routes.js", anchor: "verifyAnchors(proj.path, b.codePaths, {", value: "instanceForProject(pid)", purpose: "OKF: create" },
  { file: "server/projects/routes.js", after: "const it = store.getProjectContext(pid, cxs[1]);", anchor: "staleInfo(proj.path, it, {", value: "instanceForProject(pid)", purpose: "OKF: read entry" },
  { file: "server/projects/routes.js", row: "const okfInstance = instanceForProject(pid);", purpose: "OKF: verify" },
  { file: "server/projects/routes.js", anchor: "before = await staleInfo(proj.path, it, {", value: "okfInstance", purpose: "OKF: verify (before)" },
  { file: "server/projects/routes.js", anchor: "verifyAnchors(proj.path, it.codePaths, {", value: "okfInstance", purpose: "OKF: verify (anchor)" },
  { file: "server/projects/routes.js", after: "const it = store.getProjectContext(pid, cid);", anchor: "staleInfo(proj.path, it, {", value: "instanceForProject(pid)", purpose: "OKF: entry (identifier)" },
  { file: "server/projects/routes.js", anchor: "verifyAnchors(proj.path, effPaths, {", value: "instanceForProject(pid)", purpose: "OKF: change" },
  { file: "server/projectbox/projectRepo.js", row: "const enclosing = await enclosingRepo(root, instance, withoutDeadline, harden);", purpose: "project repo: does the folder lie in a repo? (with `harden` from the setup)" },
  { file: "server/projectbox/projectRepo.js", anchor: "ownCommit(root, String(message || FIRST_COMMIT), {", short: true, purpose: "project repo: the first commit" },
  { file: "server/projectbox/projectRepo.js", row: "const { repos, unreadable } = await searchProject(root, { instance, withoutDeadline });", purpose: "project repo: the readability check in the container" },
  // The code snapshot of a copy — every git in the clone helper, never in B.
  { file: "server/stacks/code-snapshot.js", row: "const r = await createProjectRepo(root, { instance: helperInstance(projectId, helper), message: `Project repo created before copy ${name}` });", purpose: "the project repo of an emptily relocated folder, in the helper before the pause" },
  { file: "server/stacks/code-snapshot.js", row: "const helperInst = helperInstance(projectId, helper);", purpose: "the clone helper as instance (containerOf: helperId)" },
  { file: "server/stacks/code-snapshot.js", row: "const c = await commitProjectRepo(root, `State before copy ${name}`, { empty: true, instance: helperInst });", purpose: "the commit of the project repo in the helper" },
  { file: "server/stacks/code-snapshot.js", row: "list = await searchProject(root, { instance: helperInst });", purpose: "the repo list in the helper" },
  { file: "server/stacks/code-snapshot.js", row: 'const r = await commandRun(helperInst, abs, "sh", ["-c", SCRIPT,', purpose: "the read bundle per repo in the helper" },
  { file: "server/stacks/code-snapshot.js", row: 'const r = await commandRun(helperInst, root, "sh", ["-c", BEFORE_COPY,', purpose: "HEAD and base of the project repo BEFORE the snapshot commit, in the helper" },
  // The preparation of a copy — every git in the copy container (instance `copy-<name>`), never in B.
  { file: "server/stacks/build.js", row: "copy, inst: store.projectInstance(pid, instance), location, projectPath, snapshot, base: copy.base ?? null,", purpose: "the instance row of the copy travels into the preparation" },
  { file: "server/stacks/prepare.js", row: 'const res = await commandRun(inst, pathOf(r), "perl", ["-e", SET_UP], { ...opts(), stdin: text });', purpose: "set-up in the copy container" },
  { file: "server/stacks/prepare.js", row: 'const res = await commandRun(inst, pathOf(r), "perl", ["-e", CHECKOUT, a.text, a.required ? "1" : "0", a.state], { ...opts(), stdin: nul(r.open?.erase || []) });', purpose: "checkout with delete list in the copy container (arguments from checkoutArgs — in the project repo with a base the state before the snapshot commit)" },
  { file: "server/stacks/prepare.js", row: 'const res = await commandRun(inst, pathOf(r), "tar", [...TAR_UNPACK], { ...opts(), stdin: stream });', purpose: "the tar of the open work in the copy container" },
  { file: "server/stacks/prepare.js", row: 'const res = await commandRun(inst, pathOf(r), "perl", ["-e", POST_WORK, location.inside.layer(r.part), String(DELETE_CAP)], { ...opts(), stdin: input });', purpose: "the delete passes in the copy container (stdin: number, delete list, exceptions)" },
  // The refs `refs/heads/copy…` of every repo of main for the name choice — in main, never in B.
  { file: "server/stacks/request.js", row: "const inst = runInstance(pid, MAIN);", purpose: "the main instance of the request" },
  { file: "server/stacks/request.js", row: "try { ({ repos } = await searchProject(root, { instance: inst })); }", purpose: "the repo list in main" },
  { file: "server/stacks/request.js", row: "r = await gitRun(inst, location, [\"for-each-ref\", \"--format=%(refname)\", ...REF_CLEAN.map(([front]) => `${front}${REF_SPACE}`)], { timeout: REFS_CAP_MS });", purpose: "the copy refs per repo in main" },
  // The pre-check of the base — `rev-parse` per repo in main, with the same instance as the refs.
  { file: "server/stacks/request.js", row: "await baseInMain(base, { project, inst, repos });", purpose: "the main instance of the request travels into the pre-check of the base" },
  { file: "server/stacks/request.js", row: "r = await gitRun(inst, location, [\"rev-parse\", \"--verify\", \"--quiet\", \"--end-of-options\", `${ref}^{commit}`], { timeout: REFS_CAP_MS });", purpose: "does the repo know the base as a commit — in main, never in B" },
  // The worktrees of the subagents and of the graph workflows, with delete path and follow-up work.
  { file: "server/runs/agents.js", row: "const inst = (identifier || null) === instanceIdentifierOf(instance) ? instance : instanceFromIdentifier(identifier);", purpose: "subagent worktree: gitOf resolves the identifier (as the spec factory)" },
  { file: "server/runs/agents.js", row: "return inst ? gitInProject(inst) : null;", purpose: "subagent worktree: the git of the instance" },
  { file: "server/runs/agents.js", anchor: "projectRepos(proj.path, {", short: true, purpose: "subagent worktree: the repos of the project OF THE CORE with its instance" },
  { file: "server/runs/agents.js", row: "try { inst = instanceForProject(location.projectId); } catch (err) {", purpose: "delete path: the worktrees in the runtime folder of a converted project" },
  { file: "server/providers/agent-runtime.js", row: "const kg = gitOf(instance);", purpose: "subagent worktree: start (core instance)" },
  { file: "server/providers/agent-runtime.js", row: "const kg = gitOf(rec.instance);", purpose: "subagent worktree: teardown at the end (instance of its image)" },
  { file: "server/providers/agent-runtime.js", row: "try { kg = gitOf(rec.instance); } catch { return null; }", purpose: "subagent worktree: teardown at the end of the turn" },
  { file: "server/providers/agent-runtime.js", row: "const kg = rec.worktreeRepo ? gitOf(rec.instance) : null;", purpose: "subagent worktree: fresh worktree of a continuation" },
  { file: "server/workflows/worktree.js", row: "const inst = instance !== undefined ? instance : instanceOf(project?.id);", purpose: "graph worktree: create" },
  { file: "server/workflows/worktree.js", row: "const inst = instanceOfThe(info);", purpose: "graph worktree: check" },
  { file: "server/workflows/worktree.js", row: "try { inst = instanceOfThe(info); } catch (e) {", purpose: "graph worktree: remove" },
  { file: "server/workflows/worktree.js", row: "const info = { dir, branch: branchFor(startId), repos: [], own: [], ...(project?.id ? { projectId: String(project.id) } : {}) };", purpose: "graph worktree: info carries projectId (remove and check ask the instance with it)" },
];

// The files of the start paths: no child process may come into being here past inProject, except the named ones. services.js
// belongs to them (the simple service start). So does the wrapper `mcp/airlock.js` of the coding MCP airlock — it starts the real
// stdio server as a child. It is itself a child of the CLI and runs in the namespace of the run (with an instance in the project
// container, because the CLI starts there); its child inherits it. The entry holds that it stays at exactly this ONE start
// (counter-test: a second `spawn` in the wrapper => (A1) red).
const START_PATHS = (file) => /^server\/(providers\/|devtools\/)/.test(file) || ["server/terminal.js", "server/debug.js", "server/browsers.js", "server/services.js", "mcp/airlock.js"].includes(file);
export const KIND_IMPORTS = {
  "server/providers/agent-runtime.js": ["spawnSync"],
  "server/providers/connectors/claude.js": ["spawn"],
  "server/providers/connectors/codex.js": ["execFile", "spawn"],
  "server/services.js": ["execFile", "spawnSync"], // `spawn` is gone, the start goes through inProject
  "mcp/airlock.js": ["spawn"], // coding MCP airlock: the real stdio server as a child of the wrapper
};
// Child processes of the start paths that do NOT belong in the project container — each with a reason. `begin`: the call verbatim.
export const CHILDREN_ALLOWED = [
  { file: "server/providers/agent-runtime.js", begin: 'spawnSync("git", args,', reason: "administration git of the core (worktree of a subagent) WITHOUT an instance — the fallback gitInB; with an instance it goes through `gitOf` into the project container (GIT_STARTER)" },
  { file: "server/providers/connectors/claude.js", begin: "spawn(claudeBin(), args, { cwd, env })", reason: "oneshot runOnceClaude WITHOUT an instance: in B; with an instance — the service detection — through `inProject(instance, …)` (START_PLACES)" },
  { file: "server/providers/connectors/codex.js", begin: "spawn(codexBin(), args, { cwd, env: cleanCodexEnv() })", reason: "oneshot runOnceCodex: in B; with an instance rejected before anything starts (the Codex detection stays off)" },
  { file: "server/providers/connectors/codex.js", begin: 'execFile(codexBin(), ["login", "status"]', reason: "login status of the account (B)" },
  { file: "server/terminal.js", begin: "pty.spawn(call.program, call.args,", reason: "THE way with an instance: `docker exec -it` from inProjectCall" },
  { file: "server/terminal.js", begin: "pty.spawn(command, args || [],", reason: "without an instance: login console of the providers (account/routes.js), terminal in B" },
  { file: "server/terminal.js", begin: 'pty.spawn(program, ["-l"],', reason: "without an instance: terminal in B (workspace, not converted project)" },
  // The remaining child processes of services.js — none starts a service.
  { file: "server/services.js", begin: 'execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]', reason: "pidsOnPort: stop at the port in B; a converted project asks `lsof` in the container (pidsOnPortIn through docker exec)" },
  { file: "server/services.js", begin: 'execFile("docker", args, opts, cb)', reason: "localDocker: the docker of B without an operating mark and for not converted projects; a converted one goes through projectbox/docker.js" },
  { file: "server/services.js", begin: 'execFile("du", ["-sk", dir]', reason: "folder size of the resources: reads the project folder, B sees it at the same path" },
  { file: "server/services.js", begin: 'spawnSync(bash, ["-nc", c]', reason: "syntax check of the start command (bash -n, executes nothing)" },
  { file: "server/services.js", begin: 'spawnSync("ps", ["-o", "lstart=", "-p", String(pid)]', reason: "processStart: start time of a group in B without /proc (macOS, operating mark only in tests); reads, starts nothing" },
  { file: "server/services.js", begin: 'spawnSync(SYSCTL, ["-n", "kern.boottime"]', reason: "bootMarker: boot time of the Mac without /proc — the identity of a group with an ended leader; reads, starts nothing" },
  { file: "server/services.js", begin: 'execFile("ps", ["-A", "-o", "pid=,ppid="]', reason: "ownLine: the own process and its ancestors in B, which the stop at the port never hits; reads, starts nothing" },
  // Coding MCP airlock: no start of the backend — the wrapper is a child of the CLI, its child (the real server) runs in the
  // namespace of the CLI, with an instance thus in the project container; environment without CBASE_* (guard mcp-airlock.test.js).
  { file: "mcp/airlock.js", begin: "spawn(String(s.command), (s.args || []).map(String),", reason: "wrapper of the coding MCP airlock: the real stdio server as its child, in the namespace of the CLI (with an instance in the project container), without CBASE_*" },
];

// Named EXCEPTIONS: starts over the start paths that run in B even if their folder contains the folders of converted projects — the
// workspace level. Each line pins the call that gets NO instance: `anchor` (the object that its last `{` opens has no property
// `instance`) or `call` (the call verbatim, with the closing bracket: without an options argument `opts.instance` is null). Red: the
// wording does not stand exactly once (the exception has no place any more — the list may only shrink), or it carries an instance
// (then it is no exception, the line falls, and the place belongs in EDGES).
export const EXCEPTIONS_WITHOUT_INSTANCE = [
  { file: "server/workspaces/routes.js", anchor: "const b = await ensureUserBrowser(userBrowserTarget({",
    reason: "the browser tab of the workspace level stays in B: it reaches the projects through `<project>.cbase`" },
  // The call carries options — only the source of the git (`gitInstanceSource`), never `instance`.
  { file: "server/workspaces/routes.js", anchor: "codeRoute(ws.path, sub, m, req, res, url, {",
    reason: "terminal and debugger of the workspace level stay in B: into the namespace of a project leads `cbase-project <name> -- <command>`" },
  // The way of EVERY start without an instance (tool-runtime.js, claude.js, codex.js, … stay unchanged).
  { file: "server/runtime/inProject.js", call: "spawn(cmd, args, withGitWrapperFront(opts))",
    reason: "every start without an instance stays in B; in operation the git folder stands at the front of the PATH, a `git` on paths of converted projects goes through cbase-git into their project container" },
];

// ── (A) The reader ───────────────────────────────────────────────────────────────────────────────
// Two views of equal length (offsets agree): `code` without comments, `mask` additionally without the content of strings, template
// text and regex literals (expressions in `${…}` stay code). Only the mask counts brackets.
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_WORDS = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
export function views(src) {
  const n = src.length;
  const code = src.split("");
  const mask = src.split("");
  const empty = (arr, a, b) => { for (let k = a; k < b && k < n; k++) if (arr[k] !== "\n") arr[k] = " "; };
  let last = "", word = "", gap = false;
  const stringEnd = (i, q) => {
    for (let j = i + 1; j < n; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === q) return j + 1;
      if (src[j] === "\n") return j;
    }
    return n;
  };
  const regexEnd = (i) => {
    let kind = false;
    for (let j = i + 1; j < n; j++) {
      const c = src[j];
      if (c === "\\") { j++; continue; }
      if (c === "\n") return j;
      if (c === "[") kind = true;
      else if (c === "]") kind = false;
      else if (c === "/" && !kind) { j++; while (j < n && /[a-z]/i.test(src[j])) j++; return j; }
    }
    return n;
  };
  const template = (i) => {
    let beginning = i + 1;
    for (let j = i + 1; j < n; j++) {
      const c = src[j];
      if (c === "\\") { j++; continue; }
      if (c === "`") { empty(mask, beginning, j); return j + 1; }
      if (c === "$" && src[j + 1] === "{") { empty(mask, beginning, j); j = read(j + 2, true); beginning = j + 1; }
    }
    empty(mask, beginning, n);
    return n;
  };
  // Reads code from i; with `untilBracket` it ends at the unpaired `}` (end of a `${…}`) and returns its index.
  function read(i, untilBracket) {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === "/" && d === "/") { let e = src.indexOf("\n", i); if (e < 0) e = n; empty(code, i, e); empty(mask, i, e); i = e; continue; }
      if (c === "/" && d === "*") { let e = src.indexOf("*/", i + 2); e = e < 0 ? n : e + 2; empty(code, i, e); empty(mask, i, e); i = e; continue; }
      const fresh = () => { last = "a"; word = ""; gap = false; };
      if (c === '"' || c === "'") { const e = stringEnd(i, c); empty(mask, i + 1, e - 1); i = e; fresh(); continue; }
      if (c === "`") { i = template(i); fresh(); continue; }
      if (c === "/" && (REGEX_AFTER.has(last) || REGEX_WORDS.has(word))) { const e = regexEnd(i); empty(mask, i + 1, e - 1); i = e; fresh(); continue; }
      if (/\s/.test(c)) { gap = true; i++; continue; }
      if (untilBracket) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) return i; depth--; }
      }
      word = /[\w$]/.test(c) ? (!gap && /[\w$]/.test(last) ? word + c : c) : "";
      last = c; gap = false; i++;
    }
    return n;
  }
  read(0, false);
  return { code: code.join(""), mask: mask.join("") };
}

// The closing bracket to the opening one at i (in the mask).
function matching(mask, i) {
  let depth = 0;
  for (let j = i; j < mask.length; j++) {
    const c = mask[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return j; }
  }
  return -1;
}
// The parts between a and b, separated at commas of the top level — as [start, end) in offsets.
function parts(mask, a, b) {
  const out = [];
  let depth = 0, beginning = a;
  for (let j = a; j < b; j++) {
    const c = mask[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push([beginning, j]); beginning = j + 1; }
  }
  out.push([beginning, b]);
  return out;
}
const rowOf = (src, i) => src.slice(0, i).split("\n").length;
const narrow = (s) => s.replace(/\s+/g, " ").trim();
const occurrences = (text, what) => { let k = 0, i = -1; while ((i = text.indexOf(what, i + 1)) >= 0) k++; return k; };

// All calls of the names in a file: { name, first, row, text }.
function calls(view, src, names) {
  const re = new RegExp(`(?<![\\w$.])(${names.join("|")})\\s*\\(`, "g");
  const out = [];
  for (const m of view.mask.matchAll(re)) {
    if (/function\s*\*?\s*$/.test(view.mask.slice(Math.max(0, m.index - 20), m.index))) continue; // Definition
    const on = m.index + m[0].length - 1;
    const closed = matching(view.mask, on);
    const [[a, b]] = parts(view.mask, on + 1, closed < 0 ? view.mask.length : closed);
    out.push({ name: m[1], first: narrow(view.code.slice(a, b)), row: rowOf(src, m.index), text: narrow(view.code.slice(m.index, closed < 0 ? m.index + 200 : closed + 1)) });
  }
  return out;
}

// The object at the anchor of an edge and its property `instance`: { error } or { property: null | {short, value, a, b}, on, zu }.
function objectAtAnchor(view, edge) {
  let from = 0;
  if (edge.after) {
    if (occurrences(view.code, edge.after) !== 1) return { error: `"${edge.after}" appears ${occurrences(view.code, edge.after)}×, expected 1×` };
    from = view.code.indexOf(edge.after);
  } else if (occurrences(view.code, edge.anchor) !== 1) {
    return { error: `anchor "${edge.anchor}" appears ${occurrences(view.code, edge.anchor)}×, expected 1×` };
  }
  const i = view.code.indexOf(edge.anchor, from);
  if (i < 0) return { error: `anchor "${edge.anchor}" is missing` };
  const on = i + edge.anchor.lastIndexOf("{");
  const closeAt = matching(view.mask, on);
  if (closeAt < 0) return { error: `object at the anchor "${edge.anchor}" is not closed` };
  for (const [a, b] of parts(view.mask, on + 1, closeAt)) {
    const t = view.code.slice(a, b);
    const m = /^(\s*)instance\s*(?::\s*([\s\S]*?))?\s*$/.exec(t);
    if (m) return { property: { short: m[2] === undefined, value: m[2] === undefined ? null : narrow(m[2]), a: a + m[1].length, b }, on, closeAt };
  }
  return { property: null, on, closeAt };
}

const KIND_RE = /(?<![\w$.])(spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*\(|(?<![\w$.])pty\.spawn\s*\(/g;
const LITERAL = /^(null|undefined|false|0|""|''|void 0)$/;

/** Checks the sources ({ file: text }, relative to server/backend/electron) against the tables; returns the findings. */
export function check(sources) {
  const findings = [];
  const view = new Map();
  const viewOf = (d) => { if (!view.has(d)) view.set(d, views(sources[d])); return view.get(d); };

  // (1) Start places: every one found is in the table, every one of the table is found, none with a literal argument.
  const found = new Map();
  for (const [file, src] of Object.entries(sources)) {
    if (file === "server/runtime/inProject.js" || !src.includes("inProject")) continue;
    for (const a of calls(viewOf(file), src, ["inProject", "inProjectCall"])) {
      const key = `${file}|${a.name}|${a.first}`;
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(a);
      if (LITERAL.test(a.first)) findings.push(`${file}:${a.row}: ${a.name}(${a.first}, …) — literal instance, the start ALWAYS runs in B`);
    }
  }
  const known = new Set();
  for (const s of START_PLACES) {
    const key = `${s.file}|${s.name}|${s.first}`;
    known.add(key);
    const n = (found.get(key) || []).length;
    if (n !== (s.count ?? 1)) findings.push(`${s.file}: ${s.name}(${s.first}, …) appears ${n}×, expected ${s.count ?? 1}× (${s.origin})`);
  }
  for (const [key, list] of found) {
    if (known.has(key)) continue;
    for (const a of list) findings.push(`${key.split("|")[0]}:${a.row}: new start place ${a.name}(${a.first}, …) without an entry in START_PLACES`);
  }

  // (1b) The column "LFS environment". Every line says yes or no, with a reason; every call does what its line says — yes means
  // `withLfsEnvironment(<first argument of the start>, …)` as options, no means no `withLfsEnvironment(`.
  for (const s of START_PLACES) {
    if (typeof s.lfs !== "boolean" || typeof s.lfsReason !== "string" || s.lfsReason.length < 20) {
      findings.push(`${s.file}: ${s.name}(${s.first}, …) without a statement "LFS environment yes/no" with a reason (lfs, lfsReason)`);
      continue;
    }
    for (const a of found.get(`${s.file}|${s.name}|${s.first}`) || []) {
      const carries = a.text.includes("withLfsEnvironment(");
      if (carries !== s.lfs) {
        findings.push(`${s.file}:${a.row}: ${s.name}(${s.first}, …) ${carries ? "carries the LFS environment, its line says no" : "does not carry the LFS environment, its line says yes"} (${s.lfsReason})`);
      } else if (carries && !a.text.includes(`withLfsEnvironment(${s.first},`)) {
        findings.push(`${s.file}:${a.row}: ${s.name}(${s.first}, …) takes the LFS environment of ANOTHER instance than that of the start`);
      }
    }
  }
  // Every `withLfsEnvironment(` is in a yes line — none beside it (a start past the table, a prebuilt object) —, and the ONE start
  // function never carries the environment itself: otherwise it would carry every start place, also the service detection.
  const lfsDesired = START_PLACES.filter((s) => s.lfs === true).reduce((n, s) => n + (s.count ?? 1), 0);
  let lfsIs = 0;
  for (const [file, src] of Object.entries(sources)) {
    if (file === "server/runs/lfs-environment.js" || !src.includes("withLfsEnvironment")) continue;
    lfsIs += calls(viewOf(file), src, ["withLfsEnvironment"]).length;
  }
  if (lfsIs !== lfsDesired) findings.push(`withLfsEnvironment( appears ${lfsIs}× in the tree, expected ${lfsDesired}× (the yes lines of the column "LFS environment") — a call outside the table`);
  if (/lfs-environment|CBASE_LFS_|GIT_LFS_/.test(sources["server/runtime/inProject.js"] || "")) {
    findings.push("server/runtime/inProject.js: the LFS environment centrally in the start function — then it would carry every start place, also the service detection");
  }

  // (2) Edges: the way of the instance to the start place.
  for (const k of EDGES) {
    const src = sources[k.file];
    if (src === undefined) { findings.push(`${k.file}: Datei missing (Kante: ${k.purpose})`); continue; }
    const s = viewOf(k.file);
    if (k.row) {
      const n = occurrences(s.code, k.row);
      if (n !== 1) findings.push(`${k.file}: "${k.row}" appears ${n}×, expected 1× (${k.purpose})`);
      continue;
    }
    const o = objectAtAnchor(s, k);
    if (o.error) { findings.push(`${k.file}: ${o.error} (${k.purpose})`); continue; }
    const e = o.property;
    const desired = k.short ? "instance (shorthand)" : `instance: ${k.value}`;
    if (!e) findings.push(`${k.file}:${rowOf(src, o.on)}: at the anchor "${k.anchor}" ${desired} is missing — ${k.purpose} loses the instance`);
    else if (k.short ? !e.short : e.value !== k.value) findings.push(`${k.file}:${rowOf(src, e.a)}: at the anchor "${k.anchor}" stands instance${e.short ? "" : `: ${e.value}`}, expected ${desired} (${k.purpose})`);
  }

  // (2b) Named exceptions: exactly one place, no instance.
  for (const a of EXCEPTIONS_WITHOUT_INSTANCE) {
    const src = sources[a.file];
    if (src === undefined) { findings.push(`${a.file}: Datei missing (Ausnahme: ${a.reason})`); continue; }
    const s = viewOf(a.file);
    if (a.call) {
      const n = occurrences(s.code, a.call);
      if (n !== 1) findings.push(`${a.file}: exception "${a.call}" appears ${n}×, expected 1× — without a place (or with options) it is no named exception any more (${a.reason})`);
      continue;
    }
    const o = objectAtAnchor(s, { anchor: a.anchor });
    if (o.error) { findings.push(`${a.file}: exception ${o.error} (${a.reason})`); continue; }
    if (o.property) findings.push(`${a.file}:${rowOf(src, o.property.a)}: exception "${a.anchor}" carries an instance — then it is none; the line falls, the place belongs in EDGES (${a.reason})`);
  }

  // (3) Child processes of the start paths: only the named ones, imports only as named.
  const allowedSeen = new Map(CHILDREN_ALLOWED.map((e) => [e, 0]));
  for (const [file, src] of Object.entries(sources)) {
    if (!START_PATHS(file)) continue;
    const s = viewOf(file);
    const importRe = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
    const named = [];
    let gedeckt = 0;
    for (const m of s.code.matchAll(importRe)) { gedeckt++; named.push(...m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)); }
    const accesses = occurrences(s.code, "child_process");
    if (accesses > gedeckt) findings.push(`${file}: child_process ${accesses - gedeckt}× loaded other than with a named import (namespace, require, import())`);
    if (named.length || KIND_IMPORTS[file]) {
      const desired = [...(KIND_IMPORTS[file] || [])].sort().join(",");
      const actual = [...named].sort().join(",");
      if (desired !== actual) findings.push(`${file}: imports from node:child_process {${actual}}, expected {${desired}} (KIND_IMPORTS)`);
    }
    const pty = [...s.code.matchAll(/(?:require|import)\s*\(\s*["']node-pty["']|from\s*["']node-pty["']/g)].length;
    if (pty && !(file === "server/terminal.js" && pty === 1)) findings.push(`${file}: node-pty loaded ${pty}× — only terminal.js may (once)`);
    for (const m of s.mask.matchAll(KIND_RE)) {
      const on = m.index + m[0].length - 1;
      const closed = matching(s.mask, on);
      const text = narrow(s.code.slice(m.index, closed < 0 ? m.index + 200 : closed + 1));
      const e = CHILDREN_ALLOWED.find((x) => x.file === file && text.startsWith(narrow(x.begin)));
      if (e) allowedSeen.set(e, allowedSeen.get(e) + 1);
      else findings.push(`${file}:${rowOf(src, m.index)}: new child process past inProject: ${text.slice(0, 120)}`);
    }
  }
  for (const [e, n] of allowedSeen) {
    if (n !== 1) findings.push(`${e.file}: allowed child process "${e.begin}" appears ${n}×, expected 1× (CHILDREN_ALLOWED may only shrink)`);
  }
  return findings;
}

function allSources() {
  const out = {};
  const run = (folder) => {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(folder, e.name);
      if (e.isDirectory()) run(p);
      else if (e.name.endsWith(".js") || e.name.endsWith(".mjs") || e.name.endsWith(".cjs")) out[path.relative(ELECTRON, p)] = fs.readFileSync(p, "utf8");
    }
  };
  run(ELECTRON);
  return out;
}

test("(A1) every start place stands in the table with the origin of its instance, and no child process of the start paths goes past inProject", () => {
  const sources = allSources();
  const findings = check(sources);
  assert.deepEqual(findings, [], `\n${findings.join("\n")}`);
  // A measurement line instead of a number in the title (a number in the title ages silently).
  const n = START_PLACES.reduce((s, x) => s + (x.count ?? 1), 0);
  console.log(`# start places: ${n} at ${START_PLACES.length} locations, ${EDGES.length} edges, ${CHILDREN_ALLOWED.length} allowed child processes, ${EXCEPTIONS_WITHOUT_INSTANCE.length} named exceptions`);
});

// ── (A2) The built-in sabotage ────────────────────────────────────────────────────────────────
// Replaces the property `instance` at the anchor of an edge (fresh = null: remove with the comma) or the line.
function sabotageEdge(src, k, fresh) {
  if (k.row) return src.replace(k.row, fresh === null ? "" : `const instance = ${fresh};`);
  const o = objectAtAnchor(views(src), k);
  assert.ok(o.property, `sabotage of the edge ${k.file} "${k.anchor}": no property found`);
  const { a, b } = o.property;
  if (fresh !== null) return `${src.slice(0, a)}instance: ${fresh}${src.slice(b)}`;
  const end = src[b] === "," ? b + 1 : b;
  return src.slice(0, a) + src.slice(end);
}
const withReplacement = (sources, file, from, to) => {
  assert.ok(sources[file].includes(from), `sabotage outdated: "${from}" is missing in ${file}`);
  return { ...sources, [file]: sources[file].replace(from, to) };
};

test("(A2) built-in sabotage: literal null, missing and new place, lost edge, new child process — and all places at once to B", () => {
  const real = allSources();
  assert.deepEqual(check(real), []);
  const cases = [];
  for (const s of START_PLACES) {
    cases.push({ what: `${s.file}: ${s.name}(null, …)`, q: withReplacement(real, s.file, `${s.name}(${s.first},`, `${s.name}(null,`), hits: [s.file, "literal instance"] });
  }
  for (const k of EDGES) {
    cases.push({ what: `${k.file}: edge "${k.row || k.anchor}" to null`, q: { ...real, [k.file]: sabotageEdge(real[k.file], k, "null") }, hits: [k.file] });
    cases.push({ what: `${k.file}: edge "${k.row || k.anchor}" removed`, q: { ...real, [k.file]: sabotageEdge(real[k.file], k, null) }, hits: [k.file] });
  }
  cases.push({ what: "debug.js: start place replaced by spawn", q: withReplacement(real, "server/debug.js", 'inProject(instance, "node", args,', 'spawn("node", args,'), hits: ["server/debug.js", "new child process", "expected 1×"] });
  cases.push({ what: "debug.js: additional spawn", q: { ...real, "server/debug.js": `${real["server/debug.js"]}\nspawn("sh", ["-c", "true"]);\n` }, hits: ["new child process"] });
  cases.push({ what: "browsers.js: namespace import of child_process", q: { ...real, "server/browsers.js": `import * as kp from "node:child_process";\n${real["server/browsers.js"]}` }, hits: ["server/browsers.js", "child_process"] });
  cases.push({ what: "engine.js: spawn imported under another name", q: { ...real, "server/providers/engine.js": `import { spawn as s } from "node:child_process";\n${real["server/providers/engine.js"]}` }, hits: ["server/providers/engine.js", "KIND_IMPORTS"] });
  cases.push({ what: "codex.js: pty.spawn without an instance", q: { ...real, "server/providers/connectors/codex.js": `${real["server/providers/connectors/codex.js"]}\nconst x = () => pty.spawn("sh", []);\n` }, hits: ["new child process"] });
  cases.push({ what: "services.js: new start place without an entry", q: { ...real, "server/services.js": `${real["server/services.js"]}\nconst y = (inst) => inProject(inst, "sh", [], {});\n` }, hits: ["server/services.js", "new start place"] });
  cases.push({ what: "claude.js: a comment with spawn( does not count, nor does a string", q: { ...real, "server/providers/connectors/claude.js": `${real["server/providers/connectors/claude.js"]}\n// spawn("x")\nconst t = "spawn(y)";\n` }, hits: null });
  // The column "LFS environment" — a yes place without, a no place with, the environment of another instance, a call beside the
  // table, the environment centrally in the start function (then the detection would carry it).
  const CL = "server/providers/connectors/claude.js";
  cases.push({ what: "claude.js: the turn without the LFS environment", q: withReplacement(real, CL, "withLfsEnvironment(spec.instance || null, { cwd: spec.cwd, env: cleanClaudeEnv() })", "{ cwd: spec.cwd, env: cleanClaudeEnv() }"), hits: [CL, "does not carry the LFS environment", "expected"] });
  cases.push({ what: "claude.js: the detection with the LFS environment", q: withReplacement(real, CL, "{ cwd, env, envAlways: [...Object.keys(DETECTION_ENVIRONMENT), ...Object.keys(ONESHOT_ENVIRONMENT)] }", "withLfsEnvironment(instance, { cwd, env, envAlways: [...Object.keys(DETECTION_ENVIRONMENT), ...Object.keys(ONESHOT_ENVIRONMENT)] })"), hits: [CL, "its line says no"] });
  cases.push({ what: "tool-runtime.js: the LFS environment of another instance", q: withReplacement(real, "server/providers/tool-runtime.js", "withLfsEnvironment(ctx.instance || null, { cwd: ctx.cwd, env: ctx.env || process.env, detached: OWN_GROUP }));\n    let out", "withLfsEnvironment(null, { cwd: ctx.cwd, env: ctx.env || process.env, detached: OWN_GROUP }));\n    let out"), hits: ["server/providers/tool-runtime.js", "ANOTHER instance"] });
  cases.push({ what: "services.js: withLfsEnvironment beside the table", q: { ...real, "server/services.js": `${real["server/services.js"]}\nconst z = (inst) => withLfsEnvironment(inst, {});\n` }, hits: ["withLfsEnvironment( appears", "outside the table"] });
  cases.push({ what: "inProject.js: the LFS environment centrally", q: { ...real, "server/runtime/inProject.js": `import { lfsAgentEnvironment } from "../runs/lfs-environment.js";\n${real["server/runtime/inProject.js"]}` }, hits: ["server/runtime/inProject.js", "centrally"] });
  // The named exceptions: with an instance, without a place, with options.
  const WS = "server/workspaces/routes.js";
  cases.push({ what: "exception workspace browser carries an instance", q: withReplacement(real, WS, "const b = await ensureUserBrowser(userBrowserTarget({", "const b = await ensureUserBrowser(userBrowserTarget({ instance: null,"), hits: [WS, "carries an instance"] });
  cases.push({ what: "exception workspace browser without a place", q: withReplacement(real, WS, "const b = await ensureUserBrowser(userBrowserTarget({", "const b = await ensureWorkspaceBrowser(userBrowserTarget({"), hits: [WS, "exception", "appears 0×"] });
  // The call carries options (the source of the git) — an `instance` among them is red, a call without options too.
  cases.push({ what: "exception workspace terminal carries an instance", q: withReplacement(real, WS, "codeRoute(ws.path, sub, m, req, res, url, {", "codeRoute(ws.path, sub, m, req, res, url, { instance: null,"), hits: [WS, "carries an instance"] });
  cases.push({ what: "exception workspace terminal without a place", q: withReplacement(real, WS, "codeRoute(ws.path, sub, m, req, res, url, {", "codeRoute(ws.path, sub, m, req, res, url, ({"), hits: [WS, "exception", "appears 0×"] });

  // The sabotage of all places at once to B.
  let all = real;
  for (const s of START_PLACES) {
    const src = all[s.file];
    all = { ...all, [s.file]: src.split(`${s.name}(${s.first},`).join(`${s.name}(null,`) };
  }
  for (const k of EDGES.filter((x) => !x.row)) all = { ...all, [k.file]: sabotageEdge(all[k.file], k, k.anchor === "createMonitorRuntime({" || k.anchor === "startMonitor(chat.id, inputArgs, {" ? null : "null") };
  cases.push({ what: "all places to B", q: all, hits: [...new Set([...START_PLACES, ...EDGES.filter((x) => !x.row)].map((x) => x.file))] });

  for (const f of cases) {
    const b = check(f.q);
    if (f.hits === null) { assert.deepEqual(b, [], `${f.what}: wrongly red\n${b.join("\n")}`); continue; }
    assert.ok(b.length > 0, `${f.what}: stays green`);
    for (const t of f.hits) assert.ok(b.some((x) => x.includes(t)), `${f.what}: no finding with "${t}"\n${b.join("\n")}`);
  }
  // The sabotage hits EVERY start place and EVERY object edge with a finding of its own.
  const b = check(all);
  for (const s of START_PLACES) assert.ok(b.some((x) => x.startsWith(s.file) && x.includes(`${s.name}(null`)), `${s.file} is missing in the findings\n${b.join("\n")}`);
  for (const k of EDGES.filter((x) => !x.row)) assert.ok(b.some((x) => x.startsWith(k.file) && x.includes(k.anchor)), `edge ${k.file} "${k.anchor}" is missing in the findings\n${b.join("\n")}`);
  // A line without a statement "LFS environment" is red, one with "yes" without the call too — the table itself sabotaged,
  // restored in the finally (it is module state of this file).
  const serviceRow = START_PLACES.find((s) => s.file === "server/services.js");
  const prior = { lfs: serviceRow.lfs, lfsReason: serviceRow.lfsReason };
  try {
    delete serviceRow.lfs;
    const without = check(real);
    assert.ok(without.some((x) => x.startsWith("server/services.js") && x.includes("without a statement \"LFS environment yes/no\"")), `line without a statement stays green\n${without.join("\n")}`);
    serviceRow.lfs = true;
    const yes = check(real);
    assert.ok(yes.some((x) => x.startsWith("server/services.js") && x.includes("its line says yes")), `yes without a call stays green\n${yes.join("\n")}`);
    assert.ok(yes.some((x) => x.includes("withLfsEnvironment( appears")), `the count does not see the yes line without a call\n${yes.join("\n")}`);
  } finally {
    Object.assign(serviceRow, prior);
  }
  assert.deepEqual(check(real), [], "the table is not restored after the sabotage");
});

// ── (E) Administration git ─────────────────────────────────────────────────────────────────
// Every git start under server/backend/electron/: the function it stands in and what it is. `fallback`: the current starter of the
// file — reachable ONLY through `fallback: () => <function>(` (runtime/git-run.js gitRun calls it only without an instance).
// There are only fallbacks — a kind for a start that still ran in B is gone, (E1) checks it.
export const GIT_STARTER = [
  { file: "server/git.js", fn: "gitInB", kind: "fallback", reason: "code view without an instance: the starter from before the instance routing" },
  { file: "server/git.js", fn: "gitStdinInB", kind: "fallback", reason: "`git apply` without an instance: the starter from before the instance routing" },
  { file: "server/okf.js", fn: "gitInB", kind: "fallback", reason: "OKF anchor without an instance" },
  { file: "server/projectbox/projectRepo.js", fn: "gitInB", kind: "fallback", reason: "project repo without an instance" },
  { file: "server/projectbox/relocation/collect.js", fn: "gitInB", kind: "fallback", reason: "relocation plan (step 1): the project is not relocated yet, git runs in B as before; a converted one rejects the collection" },
  { file: "server/projectbox/relocation/data.js", fn: "gitInB", kind: "fallback", reason: "relocation BEFORE converting: `worktree move`/`repair` (the old location is in no project container; converted throws) and HEAD of the project repo created in this relocation" },
  { file: "server/providers/agent-runtime.js", fn: "gitInB", kind: "fallback", reason: "worktree of a subagent without an instance: the synchronous starter; with an instance `gitOf`" },
  { file: "server/workflows/worktree.js", fn: "gitInB", kind: "fallback", reason: "graph worktree without an instance; with an instance in the container or as a teardown job" },
];
const GIT_START_RE = /(?<![\w$])([A-Za-z_$][\w$.]*)\s*\(\s*(["'`])git(?:\2|\s)/g;
// Only calls that start a process (spawn…, exec…, fork, pexec, pty.spawn) — `new Error(\`git …\`)` is none.
const PROCESS_NAME = /(?:^|\.)(?:p?exec\w*|spawn\w*|fork)$/i;

// The functions of a file with their body: `function name(…) {…}` and `const name = (async) (…) => {…}`.
function functions(view) {
  const out = [];
  const re = /(?:(?<![\w$])function\s*\*?\s*([\w$]+)\s*\(|(?<![\w$])(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\()/g;
  for (const m of view.mask.matchAll(re)) {
    const on = m.index + m[0].length - 1;
    const closed = matching(view.mask, on);
    if (closed < 0) continue;
    const arrow = !m[1];
    const rest = view.mask.slice(closed + 1);
    const k = arrow ? /^\s*=>\s*\{/.exec(rest) : /^\s*\{/.exec(rest);
    if (!k) continue;
    const b = closed + 1 + k[0].length - 1;
    const e = matching(view.mask, b);
    if (e > 0) out.push({ name: m[1] || m[2], from: b, until: e });
  }
  return out;
}

/** Checks the git starts of the sources against GIT_STARTER; returns the findings. */
export function checkGit(sources) {
  const findings = [];
  const seen = new Map(GIT_STARTER.map((e) => [e, 0]));
  for (const [file, src] of Object.entries(sources)) {
    if (!/["'`]git["'`\s]/.test(src)) continue;
    const view = views(src);
    const fn = functions(view);
    for (const m of view.code.matchAll(GIT_START_RE)) {
      // Only code: the mask blanks out strings, the name of the call must stand there.
      if (view.mask.slice(m.index, m.index + m[1].length) !== m[1] || !PROCESS_NAME.test(m[1])) continue;
      const inside = fn.filter((f) => f.from < m.index && m.index < f.until).sort((a, b) => (a.until - a.from) - (b.until - b.from))[0];
      const e = inside && GIT_STARTER.find((x) => x.file === file && x.fn === inside.name);
      if (!e) { findings.push(`${file}:${rowOf(src, m.index)}: new git start past runtime/git-run.js (in ${inside ? inside.name : "no function"}): ${narrow(view.code.slice(m.index, m.index + 80))}`); continue; }
      seen.set(e, seen.get(e) + 1);
    }
    for (const e of GIT_STARTER.filter((x) => x.file === file && x.kind === "fallback")) {
      const all = [...view.mask.matchAll(new RegExp(`(?<![\\w$.])${e.fn}(?![\\w$])`, "g"))].length;
      const overFallback = [...view.mask.matchAll(new RegExp(`fallback:\\s*\\(\\)\\s*=>\\s*${e.fn}\\s*\\(`, "g"))].length;
      if (overFallback < 1) findings.push(`${file}: the fallback ${e.fn} is never called through \`fallback:\` (${e.reason})`);
      if (all - 1 !== overFallback) findings.push(`${file}: the fallback ${e.fn} appears ${all - 1 - overFallback}× other than through \`fallback: () => ${e.fn}(\` — there git would run in B even WITH an instance (${e.reason})`);
    }
  }
  for (const [e, n] of seen) {
    if (n !== 1) findings.push(`${e.file}: git start in ${e.fn} appears ${n}×, expected 1× (GIT_STARTER may only shrink; ${e.reason})`);
  }
  return findings;
}

test("(E1) administration git: every git start is the named fallback without an instance — no open item any more", () => {
  const findings = checkGit(allSources());
  assert.deepEqual(findings, [], `\n${findings.join("\n")}`);
  const open = GIT_STARTER.filter((e) => e.kind !== "fallback");
  assert.deepEqual(open.map((e) => `${e.file} ${e.fn} (${e.kind})`), [], "a git start that is no fallback without an instance would run in B with an instance");
  console.log(`# git starts: ${GIT_STARTER.length} fallbacks, ${open.length} open`);
});

test("(E2) built-in sabotage of the administration git: new start, direct fallback, missing entry", () => {
  const real = allSources();
  assert.deepEqual(checkGit(real), []);
  const G = "server/git.js";
  const cases = [
    { what: "git.js: git directly in B, past gitRun", q: withReplacement(real, G, "async function git(cwd, args, opts = {}) {", 'async function git(cwd, args, opts = {}) {\n  if (opts.fast) return pexec("git", args, { cwd });'), hits: [G, "new git start", "in git"] },
    { what: "git.js: the fallback called directly", q: withReplacement(real, G, "const gitModule = (...a) => git(...a);", "const gitModule = (...a) => gitInB(...a);"), hits: [G, "gitInB", "other than through"] },
    { what: "okf.js: the fallback without fallback", q: withReplacement(real, "server/okf.js", "{ fallback: () => gitInB(repoRoot, args) }", "{ noFallback: null }) || gitInB(repoRoot, args"), hits: ["server/okf.js", "never called through"] },
    { what: "projectRepo.js: fallback renamed", q: { ...real, "server/projectbox/projectRepo.js": real["server/projectbox/projectRepo.js"].split("gitInB").join("gitToday") }, hits: ["server/projectbox/projectRepo.js", "new git start", "appears 0×"] },
    { what: "worktree.js: the fallback starts no git any more, entry stays", q: withReplacement(real, "server/workflows/worktree.js", 'await pexec("git", args, {', "await gitRun(null, cwd, args, {"), hits: ["server/workflows/worktree.js", "appears 0×", "only shrink"] },
    // The two worktree starters — without the way through gitRun git would run in B even WITH an instance.
    { what: "agent-runtime.js: the fallback called directly", q: withReplacement(real, "server/providers/agent-runtime.js", "const git = (args, cwd) => gitRun(null, cwd, args, { fallback: () => gitInB(args, cwd) });", "const git = (args, cwd) => gitInB(args, cwd);"), hits: ["server/providers/agent-runtime.js", "gitInB", "never called through"] },
    { what: "worktree.js: with an instance in B", q: withReplacement(real, "server/workflows/worktree.js", "if (!inst) return gitRun(null, cwd, args, { fallback: () => gitInB(cwd, args) });", "return gitInB(cwd, args);"), hits: ["server/workflows/worktree.js", "gitInB", "never called through"] },
    { what: "agent-runtime.js: an open item returns", q: withReplacement(real, "server/providers/agent-runtime.js", "const gitInB = (args, cwd) => {", "const gitImmediately = (args, cwd) => {"), hits: ["server/providers/agent-runtime.js", "new git start", "appears 0×"] },
    { what: "exec with a command string", q: { ...real, "server/devtools/code-route.js": `${real["server/devtools/code-route.js"]}\nfunction fresh() { return execSync("git status"); }\n` }, hits: ["server/devtools/code-route.js", "new git start"] },
    { what: "a comment and a string do not count", q: { ...real, [G]: `${real[G]}\n// spawn("git", [])\nconst t = 'spawn("git", [])';\n` }, hits: null },
  ];
  for (const f of cases) {
    const b = checkGit(f.q);
    if (f.hits === null) { assert.deepEqual(b, [], `${f.what}: wrongly red\n${b.join("\n")}`); continue; }
    assert.ok(b.length > 0, `${f.what}: stays green`);
    for (const t of f.hits) assert.ok(b.some((x) => x.includes(t)), `${f.what}: no finding with "${t}"\n${b.join("\n")}`);
  }
});

// ── (F) root in the project container ──────────────────────────────────────────────────────────────────────────────────────────
// `commandRun(…, { asUser: "root" })` (runtime/git-run.js → inProject.js `-u root`, also the group kill) exists ONLY for root steps
// after a path check in the container (root-owned data folders of inner containers, omission). Every call stands here with file,
// beginning of the wording and reason; red: an `asUser` with a value other than the string "agent"/"root" (a variable, the shorthand
// — the guard would not see the value), a "root" outside a `commandRun(` call (a prebuilt options object), a root call without an
// entry, an entry without a place (the list grows only with a reason). The definitions in runtime/git-run.js and
// runtime/inProject.js do not count. Both callers drive the container program of the layout rebuild
// (projectbox/layout/rebuild-program.js), which checks every path BEFORE the effect relative to the root without a reference in a
// path part (`rm --one-file-system`, `lchown` to the root owners).
export const AS_ROOT = [
  // { file: "server/…", begin: "commandRun(inst, root, \"rm\"", reason: "…" },
  { file: "server/projectbox/cleanUp.js", begin: 'commandRun(inst, "/", process.execPath, ["-e", REBUILD_PROGRAM', reason: "layout rebuild step 11: an omitted path in the project folder that the agent must not delete (EACCES/EPERM — root-owned leftovers of inner containers), as root through `remove` with `asRoot`" },
  { file: "server/projectbox/layout/procedure.js", begin: 'commandRun(ctx.inst, "/", process.execPath, ["-e", REBUILD_PROGRAM', reason: "layout rebuild steps 10 and 12: moves that fail as agent with EACCES/EPERM, once more as root (parent folders get the owner of the root)" },
];
const USER_DEFINITIONS = new Set(["server/runtime/git-run.js", "server/runtime/inProject.js"]);
// The call `commandRun(` whose bracket encloses the place i — or null.
function enclosingRun(view, i) {
  let best = null;
  for (const m of view.mask.matchAll(/(?<![\w$.])commandRun\s*\(/g)) {
    if (m.index > i) break;
    const on = m.index + m[0].length - 1;
    const closed = matching(view.mask, on);
    if (closed > i) best = { from: m.index, until: closed };
  }
  return best;
}
/** Checks the `asUser` statements of the sources against AS_ROOT (or `table`); returns the findings. */
export function checkRoot(sources, table = AS_ROOT) {
  const findings = [];
  const seen = new Map(table.map((e) => [e, 0]));
  for (const [file, src] of Object.entries(sources)) {
    if (USER_DEFINITIONS.has(file) || !src.includes("asUser")) continue;
    const s = views(src);
    for (const m of s.mask.matchAll(/(?<![\w$.])asUser(?![\w$])(\s*:)?/g)) {
      const before = s.mask.slice(0, m.index).trimEnd().at(-1);
      const to = s.mask.slice(m.index + m[0].length).trimStart()[0];
      if (before !== "{" && before !== ",") continue; // not a property of an object literal
      if (!m[1] && to !== "," && to !== "}") continue;
      let value = null;
      if (m[1]) {
        const a = m.index + m[0].length;
        let depth = 0, j = a;
        for (; j < s.mask.length; j++) {
          const c = s.mask[j];
          if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; } else if (c === "," && depth === 0) break;
        }
        value = narrow(s.code.slice(a, j));
      }
      const row = rowOf(src, m.index);
      if (value === '"agent"' || value === "'agent'") continue;
      if (value !== '"root"' && value !== "'root'") {
        findings.push(`${file}:${row}: asUser ${value === null ? "in shorthand" : `: ${value}`} — as root only with the string "root" in the call (AS_ROOT)`);
        continue;
      }
      const run = enclosingRun(s, m.index);
      if (!run) { findings.push(`${file}:${row}: asUser: "root" outside a commandRun( call — the guard does not see the call (AS_ROOT)`); continue; }
      const text = narrow(s.code.slice(run.from, run.until + 1));
      const e = table.find((x) => x.file === file && text.startsWith(narrow(x.begin)));
      if (e) seen.set(e, seen.get(e) + 1);
      else findings.push(`${file}:${row}: new root start without an entry in AS_ROOT: ${text.slice(0, 120)}`);
    }
  }
  for (const [e, n] of seen) {
    if (n !== 1) findings.push(`${e.file}: root start "${e.begin}" appears ${n}×, expected 1× (AS_ROOT: ${e.reason})`);
  }
  return findings;
}

test("(F1) root in the project container: every start with user \"root\" stands in AS_ROOT with a reason", () => {
  const findings = checkRoot(allSources());
  assert.deepEqual(findings, [], `\n${findings.join("\n")}`);
  console.log(`# root starts: ${AS_ROOT.length}`);
});

test("(F2) built-in sabotage of the root guard: new root start, variable, shorthand, prebuilt object, entry without a place", () => {
  const real = allSources();
  assert.deepEqual(checkRoot(real), []);
  const D = "server/projectbox/cleanUp.js";
  assert.ok(real[D] !== undefined, `${D} is missing — the sabotage needs another file`);
  const enabled = (addition) => ({ ...real, [D]: `${real[D]}\n${addition}\n` });
  const ROOT = 'async function way(inst, p, signal) { return commandRun(inst, "/", "rm", ["-rf", "--", p], { asUser: "root", withoutDeadline: true, signal }); }';
  const entry = { file: D, begin: 'commandRun(inst, "/", "rm"', reason: "Sabotage" };
  // AS_ROOT is not empty — the replacement tables carry the real entries along.
  const withEntry = [...AS_ROOT, entry];
  const cases = [
    { what: "new root start without an entry", q: enabled(ROOT), hits: [D, "without an entry"] },
    { what: "root start with an entry", q: enabled(ROOT), table: withEntry, hits: null },
    { what: "asUser from a variable", q: enabled('const x = (inst, who) => commandRun(inst, "/", "true", [], { asUser: who });'), hits: [D, "asUser : who"] },
    { what: "asUser in shorthand", q: enabled('const y = (inst, asUser) => commandRun(inst, "/", "true", [], { withoutDeadline: true, asUser });'), hits: [D, "shorthand"] },
    { what: "prebuilt options object", q: enabled('const OPTS = { asUser: "root" };'), hits: [D, "outside"] },
    { what: "entry without a place", q: real, table: withEntry, hits: [D, "appears 0×"] },
    { what: "the real entries without their table", q: real, table: [], hits: ["server/projectbox/layout/procedure.js", "without an entry"] },
    { what: "asUser agent, a comment and a string do not count", q: enabled('// commandRun(inst, "/", "x", [], { asUser: "root" })\nconst t = \'{ asUser: "root" }\';\nconst z = (inst) => commandRun(inst, "/", "true", [], { asUser: "agent" });'), hits: null },
  ];
  for (const f of cases) {
    const b = checkRoot(f.q, f.table);
    if (f.hits === null) { assert.deepEqual(b, [], `${f.what}: wrongly red\n${b.join("\n")}`); continue; }
    assert.ok(b.length > 0, `${f.what}: stays green`);
    for (const t of f.hits) assert.ok(b.some((x) => x.includes(t)), `${f.what}: no finding with "${t}"\n${b.join("\n")}`);
  }
});

// ── (B)/(C) Main seams ──────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200" });
function containerStart(fd, name) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
// Operating mark, fake docker, a project with a running container and its instance row; the chat carries the project.
async function projectInOps(ctx, fd, chat) {
  const projPath = path.join(ctx.root, "workspace", "till");
  fs.mkdirSync(projPath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name: "Shop", path: projPath });
  const name = `cbase-p-${p.id}`;
  containerStart(fd, name);
  // With an IP like every created instance: browser tab and debugger connect there and do not even start without it (empty is not
  // unknown). In the fake docker "the container" runs locally, its loopback IS that of B — the DNAT of the real instance is the
  // identity here, so the IP is 127.0.0.1. Otherwise the debugger would never reach the inspector, and the program would stand at
  // its --inspect-brk forever. The rewriting itself is held by projectbox-network-paths-browser.test.js.
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name, ip: "127.0.0.1" });
  if (chat) await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  return { p, name, projPath, processes: path.join(ctx.dataRoot, "data", "projects", p.id, "processes") };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const command = (a) => a.args.slice(a.args.indexOf("--") + 1);
// The four names of the LFS environment (runs/lfs-environment.js) — at the exec exactly when `yes`, and ONLY as `-e NAME` before
// the wrapper; no value (no `NAME=…`, not the address of the route) stands anywhere in the argv.
const LFS_NAMES = ["CBASE_LFS_URL", "CBASE_LFS_PASS", "GIT_LFS_SKIP_SMUDGE", "GIT_LFS_SKIP_DOWNLOAD_ERRORS"];
function lfsAt(a, yes, what) {
  const header = a.args.slice(0, a.args.indexOf(WRAPPER_PATH));
  const names = header.flatMap((x, i) => (x === "-e" ? [header[i + 1]] : []));
  for (const n of LFS_NAMES) assert.equal(names.includes(n), yes, `${what}: -e ${n} ${yes ? "missing" : "stands in the exec"} (${header.join(" ").slice(0, 400)})`);
  for (const x of a.args) assert.ok(!/(?:CBASE_LFS_|GIT_LFS_)[A-Z_]*=/.test(x) && !x.includes("/lfs-access"), `${what}: a value of the LFS environment in the argv: ${x.slice(0, 120)}`);
}
// The mark "pid pgid" of a process, written atomically (tmp + mv) — `$$` is the shell itself.
const markerCommand = (root, name) => `echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${root}/${name}.tmp' && mv '${root}/${name}.tmp' '${root}/${name}.marker'`;
const markerExists = (root, name) => fs.existsSync(path.join(root, `${name}.marker`));
const readMarker = (root, name) => { const [pid, pgid] = fs.readFileSync(path.join(root, `${name}.marker`), "utf8").trim().split(/\s+/).map(Number); return { pid, pgid }; };

// The process `what` ran in the project container: an exec with the wrapper, the pgid file under `processes/`, and its mark shows it
// as leader of its own group. `who` finds its exec in the log.
function inContainer(fd, { name, processes, root }, what, marker, who) {
  const all = execCalls(fd);
  const a = all.find((x) => x.args.includes(name) && x.args.includes(WRAPPER_PATH) && who(command(x)));
  assert.ok(a, `${what}: no "docker exec … ${name} ${WRAPPER_PATH} …" in the log — ${what} ran past the instance (execs: ${JSON.stringify(all.map(command)).slice(0, 600)})`);
  const file = a.args[a.args.indexOf("--pgid-file") + 1];
  assert.equal(path.dirname(file), processes, `${what}: pgid file outside processes/`);
  assert.equal(a.args[1], "-i", `${what}: exec without -i`);
  assert.equal(a.args[a.args.indexOf("-u") + 1], "agent", `${what}: exec not as agent`);
  if (marker) {
    const m = readMarker(root, marker);
    assert.equal(m.pgid, m.pid, `${what}: not leader of its group (pid ${m.pid}, pgid ${m.pgid}) — a spawn in B shares the group of the server`);
  }
  return a;
}

test("(B) main seam loop engine: Bash, hook, stdio MCP and monitor of the turn start in the project container", async () => {
  const fd = await fakeDocker();
  const R = { root: null };
  let monitorArrived, monitorGateOn;
  const monitorArrival = new Promise((r) => { monitorArrived = r; });
  const monitorGate = new Promise((r) => { monitorGateOn = r; });
  const round = async (b) => {
    const ids = new Set((b.messages || []).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    if (ids.has("call_mon")) { monitorArrived(b); await monitorGate; return { text: "finished" }; }
    if (ids.has("call_bash")) {
      // cbase_monitor (the only monitor of the engine) — the same monitor runtime of the turn through the route /monitor.
      return { toolCalls: [{ id: "call_mon", name: "mcp__cbase__cbase_monitor", arguments: { command: `${markerCommand(R.root, "monitor")}; exec sleep 100000`, description: "Watch", persistent: true } }] };
    }
    return { toolCalls: [
      { id: "call_bash", name: "Bash", arguments: { command: `${markerCommand(R.root, "bash")}; echo BASH-OK` } },
    ] };
  };
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws, engine } = ctx;
      R.root = ctx.root;
      // Playwright MCP: a fake npx that ends at once (otherwise npx would fetch the package from the network).
      const npx = path.join(ctx.root, "npx");
      fs.writeFileSync(npx, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(npx, 0o755);
      await withEnvironment({ ...ops(fd), NPX_BIN: npx }, async () => {
        const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: engine.id, model: "m1", permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Start places" }) });
        const location = { ...(await projectInOps(ctx, fd, chat)), root: ctx.root };
        await json(`${base}/api/agent-hooks`, { method: "PUT", body: JSON.stringify({ hooks: [{ event: "PreToolUse", matcher: "Bash", command: `cat > /dev/null; ${markerCommand(ctx.root, "hook")}` }] }) });
        try {
          await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Go" }) });
          const request = await monitorArrival;
          const mon = request.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_mon");
          const monText = typeof mon.content === "string" ? mon.content : JSON.stringify(mon.content);
          assert.match(monText, /"taskId"/, monText);
          assert.match(monText, /"description": ?"Watch"/, monText);
          const bashResult = request.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_bash");
          assert.match(JSON.stringify(bashResult.content), /BASH-OK/, "Bash did not run");

          // The stdio MCP: connected before the first model request went out — through the container.
          assert.match(JSON.stringify(engine.requests[0]), /mcp__cbase__/, "the cbase MCP is not connected");
          // Bash, hook and monitor carry the four LFS names (only as `-e NAME`), the stdio MCP none (column `lfs`).
          lfsAt(inContainer(fd, location, "stdio-MCP (cbase)", null, (c) => c[0] === process.execPath && /cbase-mcp\.js$/.test(c[1] || "")), false, "stdio-MCP");
          lfsAt(inContainer(fd, location, "Bash", "bash", (c) => c[1] === "-c" && c[2].includes("bash.marker")), true, "Bash");
          lfsAt(inContainer(fd, location, "PreToolUse-Hook", "hook", (c) => c[1] === "-c" && c[2].includes("hook.marker")), true, "PreToolUse-Hook");
          // The monitor: its mark comes on BOTH ways — wait first, then check. (The engine rejects background Bash at the call —
          // mcp/detach-rule.js; the case dropped out here.)
          await waitForTruthy(() => markerExists(ctx.root, "monitor"), "mark of the monitor");
          lfsAt(inContainer(fd, location, "Monitor", "monitor", (c) => c[1] === "-c" && c[2].includes("monitor.marker")), true, "Monitor");
          const { pgid } = readMarker(ctx.root, "monitor");
          assert.ok(alive(-pgid), "the monitor lives");

          monitorGateOn();
          await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
          await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
          // The monitor belongs to the chat and survives the turn — it is ended through its stop.
          assert.ok(alive(-pgid), "the monitor survives the end of the turn");
          const taskId = JSON.parse(monText.match(/\{[\s\S]*\}/)[0]).taskId;
          await json(`${base}/api/chats/${chat.id}/monitor/stop`, { method: "POST", body: JSON.stringify({ taskId, from: "human" }) });
          await waitForTruthy(() => !alive(-pgid), "group of the monitor in the container ended");
          await waitForTruthy(() => openEscalations() === 0, "follow-up look of the escalation");
        } finally {
          monitorGateOn();
        }
      });
    }, { engine: { round } });
  } finally {
    fd.cleanUp();
  }
});

test("(C) main seam code routes: terminal, debugger and browser of a converted project start in the project container", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      // A fake Chromium: writes its mark and ends.
      const chromium = path.join(ctx.root, "chromium");
      fs.writeFileSync(chromium, `#!/bin/sh\n${markerCommand(ctx.root, "browser")}\necho "no Chromium" >&2\nexit 1\n`);
      fs.chmodSync(chromium, 0o755);
      // SHELL=/bin/sh: the login shell of the terminal without zsh first-time setup (HOME is a temp folder).
      await withEnvironment({ ...ops(fd), CBASE_CHROMIUM: chromium, SHELL: "/bin/sh" }, async () => {
        const location0 = await projectInOps(ctx, fd, null);
        const location = { ...location0, root: ctx.root };
        const { p, projPath } = location0;

        // Terminal: the login shell in the container; an input writes the mark (on both ways), then it is checked.
        const t = await json(`${base}/api/projects/${p.id}/terminal`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24 }) });
        assert.equal(t.available, true, JSON.stringify(t));
        await json(`${base}/api/terminal/${t.id}/input`, { method: "POST", body: JSON.stringify({ data: `${markerCommand(ctx.root, "terminal")}\r` }) });
        await waitForTruthy(() => markerExists(ctx.root, "terminal"), "mark of the terminal");
        const texec = inContainer(fd, location, "Terminal", null, (c) => c[0] === "/bin/sh" && c[1] === "-l");
        lfsAt(texec, false, "Terminal");
        assert.ok(texec.args.includes("-t"), "terminal without -t");
        assert.equal(texec.args[texec.args.indexOf("-w") + 1], projPath, "-w: the project folder");
        const tpgid = Number(fs.readFileSync(texec.args[texec.args.indexOf("--pgid-file") + 1], "utf8"));
        assert.ok(alive(-tpgid));
        await json(`${base}/api/terminal/${t.id}`, { method: "DELETE" });
        await waitForTruthy(() => !alive(-tpgid), "terminal group in the container ended");

        // Debugger: node --inspect-brk in the container; the program writes its mark as soon as the debugger lets it run.
        const prog = path.join(projPath, "prog.js");
        const marker = path.join(ctx.root, "debug.marker");
        fs.writeFileSync(prog, `const fs = require("node:fs"); const { execSync } = require("node:child_process");
const pgid = execSync("ps -o pgid= -p " + process.pid).toString().trim();
fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)}, process.pid + " " + pgid); fs.renameSync(${JSON.stringify(`${marker}.tmp`)}, ${JSON.stringify(marker)});
setInterval(() => {}, 1 << 30);
`);
        const d = await json(`${base}/api/projects/${p.id}/debug/launch`, { method: "POST", body: JSON.stringify({ file: prog }) });
        assert.equal(d.available, true, JSON.stringify(d));
        await waitForTruthy(() => markerExists(ctx.root, "debug"), "mark of the debug program");
        const dexec = inContainer(fd, location, "Debugger", "debug", (c) => c[0] === "node" && c.includes(prog));
        lfsAt(dexec, false, "Debugger");
        assert.equal(dexec.args[dexec.args.indexOf("-w") + 1], projPath);
        const { pgid: dpgid } = readMarker(ctx.root, "debug");
        assert.ok(alive(-dpgid));
        await json(`${base}/api/debug/${d.id}`, { method: "DELETE" });
        await waitForTruthy(() => !alive(-dpgid), "debug group in the container ended");

        // Browser tab: the fake Chromium ends — the route reports it after it wrote its mark.
        const b = await json(`${base}/api/projects/${p.id}/browser/ensure`, { method: "POST", body: "{}" });
        assert.match(String(b.error || ""), /Chromium ended/, JSON.stringify(b));
        assert.ok(markerExists(ctx.root, "browser"), "the Chromium did not run");
        lfsAt(inContainer(fd, location, "Browser", "browser", (c) => c[0] === chromium), false, "Browser");

        // The administration git (runtime/git-run.js) does not carry the LFS environment — the state of the git view of a repo.
        const gitPrior = execCalls(fd).length;
        assert.equal(spawnSync("git", ["init", "-q"], { cwd: projPath }).status, 0);
        await json(`${base}/api/projects/${p.id}/git`);
        const gitExecs = execCalls(fd).slice(gitPrior).filter((a) => a.args.includes(location0.name) && a.args.includes(WRAPPER_PATH) && /(^|\/)git$/.test(command(a)[0] || ""));
        assert.ok(gitExecs.length > 0, `the git view started no git in the project container (execs: ${JSON.stringify(execCalls(fd).slice(gitPrior).map(command)).slice(0, 600)})`);
        for (const a of gitExecs) lfsAt(a, false, `administration git ${command(a).slice(1, 3).join(" ")}`);

        await waitForTruthy(() => openEscalations() === 0, "follow-up look of the escalation");
      });
    });
  } finally {
    fd.cleanUp();
  }
});

// ── (D) The simple service start ──────────────────────────────────────────────────────────
test("(D) simple service start of a converted project: in the project container (exec -d with the wrapper, own group); without an instance row as before in B", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      // SHELL=/bin/sh: the login shell of the simple start without zsh first-time setup (HOME is a temp folder).
      await withEnvironment({ ...ops(fd), SHELL: "/bin/sh" }, async () => {
        const { p, name, processes } = await projectInOps(ctx, fd, null);
        // The service writes its mark and ends (exit 0) — no process stays.
        const service = await json(`${base}/api/project-services`, { method: "POST", body: JSON.stringify({ projectId: p.id, name: "web", startCommand: markerCommand(ctx.root, "service") }) });
        const start = async (mode) => {
          const r = await fetch(`${base}/api/projects/${p.id}/services/${service.id}/start`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ mode }) });
          return { status: r.status, body: await r.json() };
        };
        const execPrior = execCalls(fd).length;
        const inContainer = await start("simple");
        assert.equal(inContainer.status, 202, `${inContainer.status}: ${JSON.stringify(inContainer.body)}`);
        // First the mark (both ways write it), then the log — a start in B turns red instead of hanging silently.
        await waitForTruthy(() => markerExists(ctx.root, "service"), "mark of the service");
        const fresh = execCalls(fd).slice(execPrior).filter((a) => a.args[1] === "-d" && a.args.includes(WRAPPER_PATH));
        assert.equal(fresh.length, 1, "no docker exec -d with the wrapper — the simple start ran in B");
        assert.ok(fresh[0].args.includes(name), `not in the project container ${name}: ${fresh[0].args.join(" ")}`);
        assert.equal(path.dirname(fresh[0].args[fresh[0].args.indexOf("--pgid-file") + 1]), processes);
        assert.deepEqual(command(fresh[0]), ["sh", "-lc", service.startCommand]);
        lfsAt(fresh[0], false, "Service"); // a service does not carry the LFS environment
        const m = readMarker(ctx.root, "service");
        assert.equal(m.pgid, m.pid, `the service is not leader of its group (pid ${m.pid}, pgid ${m.pgid})`);
        // Without an instance row (not converted any more): as before — 202, the command runs in B, no exec.
        fs.rmSync(path.join(ctx.root, "service.marker"));
        store.changeProjectInstance(p.id, "main", { convertedAt: null });
        const execB = execCalls(fd).length;
        const free = await start("simple");
        assert.equal(free.status, 202, JSON.stringify(free.body));
        assert.equal(typeof free.body.pid, "number", "in B the answer names the pid of the child");
        await waitForTruthy(() => markerExists(ctx.root, "service"), "mark of the service in B");
        assert.equal(execCalls(fd).length, execB, "a docker exec without an instance row");
      });
    });
  } finally {
    fd.cleanUp();
  }
});
