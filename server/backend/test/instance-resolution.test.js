// Table guard of the instance resolution: for a chat there is more than "the instance of the project" — its copy, and a child chat
// the one of its start. So that no place silently stays with the main instance (and a chat in its copy reads, writes or starts there
// in main), this holds:
//
// (A) TABLE. Every call of `instanceForProject(`, `instanceForLocation(`, `store.instanceFor(`, `store.projectInstance(` and
//     `runInstance(` under server/backend/electron/ is in TABLE — file, call, count, REASON ("why may this place stay with a fixed
//     instance?"). Red: a new place without an entry, a different count, an entry without a place (the list may only shrink), a
//     reason under 25 characters. Comments and strings do not count; neither do the definitions (`function instanceForProject(`,
//     `function runInstance(`). The resolution layer itself (runs/instance.js) is in the table with its three calls:
//     `instanceForChat` is the ONE place that decides "main or copy". The pattern of `instanceForLocation` stays in CALLS — a return
//     without an entry is red (D).
// (B) CONNECTIONS. The places that hang on `instanceOfChat`/`instanceForChat` (do-run, agents, runtime-limit, routes, messages,
//     devtools/routes, graph-start, dynworkflows/run, queue) and the setters in server.js carry their call — whoever takes one
//     back turns red.
// (C) RESOLUTION (pure, with the setters): main without a source; the copy of the chat; the copy of an EARLIER project rests; a
//     child chat in the instance of its start, never in the current one of its chat; the binding without a resolvable instance is
//     `locked` — never main; `instanceOfChat` then throws; a source that throws keeps throwing.
// (E) The tally agrees with the syntax tree — regex literals, templates and strings do not derail it: per file under electron/ and
//     per call the same value as a TypeScript CallExpression counter; a derailment of withoutComments turns red.
// (D) The built-in counter-test (sabotage in memory): one finding per rule of the table and per connection.
//
// Counter-test map (one sabotage each on the real tree, the whole file run): channels/messages.js resolves channelSituation via
// instanceForProject(chat.projectId) again => (A), (B), (D) red; runs/agents.js core without turn resolves via the location again
// => (A), (B), (D) red; runs/runtime-limit.js instanceOfTheChat via the project => (A), (B), (D) red; runs/instance.js binding
// without a row falls back to main => (C5) red, no project comparison => (C3) red, the project comparison in
// turnInstanceDifferent dropped => (C7) red; stacks/creation.js with a `instanceForProject(pid)` beside
// store.projectInstance(pid, instance) => (A), (D) red; a second `store.projectInstance(p, "main")` appended to
// projects/instance-fields.js => (A), (D) red ("2× in the code, the table says 1×"); removing the entry of a place that reads the
// row of ITS instance => (A), (D) red. The counter-tests of the graph-start.js connections stand in stacks-inset.test.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  CopyLocked, instanceForChat, instanceNameForChat, instanceOfChat, setInstanceSource, setCopySource,
  pinTurn, turnInstanceDifferent, releaseTurn, turnProjectSwitched, switchAfterTurn,
} from "../electron/server/runs/instance.js";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const ELECTRON = path.resolve(TESTDIR, "..", "electron");

// ── (A) The table ───────────────────────────────────────────────────────────────────────────────────────────────────────
const MAIN_PROJECT = "Project level, not chat level: git, OKF and freshness of a project run in its main (administration git) — the copy of a chat is seen by the ref space copy/…, not by this route";
const ROW_THIS_INSTANCE = "the row of THIS instance — name or identifier are known to the caller (the copy being cleared away or built); no instance of a chat is looked for here";
const LIFE_LOG_INSTANCE = "Life cycle of the instance (create, restore, recreate, server end): the instance comes as an argument, the default is main";
const RELOCATION_MAIN = "Relocation of a project into its main: relocatable projects have no copy (relocation and copy exclude each other)";
const SETUP_MAIN = "Setup of a new project: it belongs to the PROJECT, not to a chat, and works in main — a copy starts only after its end (NO_COPY_DURING_SETUP)";

export const TABLE = [
  { file: "server/devtools/routes.js", call: "store.projectInstance", count: 1, reason: "writeLockCopy: the row of THIS copy — the instance is already resolved (route, choice or chat); only its state is read (not `ready` => no write path, 409 COPY_NOT_READY), no instance is looked for" },
  { file: "server/devtools/routes.js", call: "instanceForProject", count: 4, reason: "targetInstance without token and without ?chat (UI, client, iOS): main as before — with a token the instance of the token applies (ctx.fence.instance), with ?chat the binding of the chat (instanceOfChat). Plus the two calls in selectedInstance: the EXPLICIT choice `?instance=<project>/<instance>` of the code tab, which belongs to no chat — the identifier is checked (this project), a copy without a row is 404 instead of falling back to main, with a token the token decides. Plus lspAgentTarget: /api/lsp WITHOUT token for a file under a project that names neither a token nor the runtime folder of an instance (B itself, the MCP server of a run in B) — main, as the in-process service did; with a token the token applies" },
  // Language service: the caller computes the instance (lsp/ does not know runs/).
  { file: "server/devtools/code-route.js", call: "instanceForProject", count: 1, reason: "lspTargetFor on the workspace level: a file under a project goes to the language server of ITS main — the code view of the workspace belongs to no chat, and a copy never lies under the project folder of B; the project level takes opts.instance (token, choice or chat)" },
  { file: "server/lsp/sessions.js", call: "store.projectInstance", count: 1, reason: "situationBefore: the row of THE instance that the target of the session names (computed by the caller) — only its state is read (stopped => `stopped`, not ready => `starting`), no instance is looked for" },
  { file: "server/projects/routes.js", call: "instanceForProject", count: 6, reason: MAIN_PROJECT },
  // Git overview: the instance stands in the route (`?instance=`) or the view names EVERY instance of the project (main and every
  // living copy, like the instances tree) — no chat, no instance of a chat is looked for. The small view in GET …/git takes the
  // instance that the route has already resolved (gitOptions) and asks nothing here.
  { file: "server/gitView/instance-choice.js", call: "store.projectInstance", count: 1, reason: "readyInstance: the row of the instance that the route names (`?instance=main|<copy>`) — only its state is read; not `ready` => 409, never woken" },
  { file: "server/gitView/instance-choice.js", call: "runInstance", count: 1, reason: "readyInstance: the run instance of the ready instance named in the route, for fetch, detail and diff — no chat" },
  { file: "server/gitView/overview.js", call: "store.projectInstance", count: 2, reason: "The large view names EVERY instance of the project — main and every living copy — with the state of its row; only what stands `ready` is read" },
  { file: "server/gitView/overview.js", call: "runInstance", count: 2, reason: "The large view: the run instance of every ready instance of the project for its reading, and the repos of main over the file system (repos.js, without waking) — no chat" },
  { file: "server/gitView/repos.js", call: "runInstance", count: 2, reason: "`repos` of the project lists: whether the project is converted (then the file system counts the project folder) — the number belongs to the project, not to a chat; plus repoChoice: the code repos of main over the file system, against which fetch, detail and diff check their `repo` — no chat" },
  { file: "server/timeline/references.js", call: "runInstance", count: 1, reason: "Links of the timeline: the origin remotes of the code repos of main over the file system (repos.js, without waking) — the timeline belongs to the project, not to a chat, and the remote address is the same in main and copy" },
  { file: "server/gitView/cache.js", call: "store.projectInstance", count: 1, reason: "Mark of a cached reading: creation and change time of the row of the instance that was read — a state change discards the entry, like the instances tree" },
  { file: "server/projects/scans.js", call: "instanceForProject", count: 1, reason: "Service detection: it belongs to the PROJECT, not to a chat, and reads the project folder in main — a copy has no service detection of its own (its services are those of main)" },
  { file: "server/projects/routes.js", call: "store.projectInstance", count: 2, reason: "Relocation display of an instance of the project (state `relocation`): the instance stands as an argument; plus the lock of the service start in a copy that is not `ready` (COPY_NOT_READY) — the instance is the explicitly chosen `?instance=` (serviceInstance, checked), none of a chat" },
  { file: "server/projects/instance-fields.js", call: "store.projectInstance", count: 1, reason: "Display of the services pill: the identifier `<project>/<instance>` comes from the resource row of EVERY instance of the project (identifierParts), not from a chat — no instance of a chat is looked for, only name, DNS, chat and state of this row are read" },
  { file: "server/projectbox/cleanUp.js", call: "store.instanceFor", count: 1, reason: "Name of the project container of MAIN for clean-up and deletion — a copy has its name from containerName" },
  { file: "server/projectbox/browser-network.js", call: "runInstance", count: 2, reason: "Agent scan: the root of the project (main) as the basis; the profile of a chat resolves the source setBrowserChatInstance (instanceNameForChat), its copy is looked up per instance" },
  { file: "server/projectbox/services.js", call: "runInstance", count: 1, reason: "Seam of the services: `instanceFor(projectId, instance)` gets the instance as an argument; without it main" },
  { file: "server/projectbox/services.js", call: "store.projectInstance", count: 1, reason: ROW_THIS_INSTANCE },
  { file: "server/projectbox/setup/procedure.js", call: "store.projectInstance", count: 8, reason: SETUP_MAIN },
  { file: "server/projectbox/setup/procedure.js", call: "runInstance", count: 5, reason: `${SETUP_MAIN}; plus unpacking a ZIP source (unpackSource) and cloning a git source (cloneSource) — each a server state OF THE SOURCE in main —, and reading the remote hints at the end of the setup (remoteHintsRead: the code repos of the project in main)` },
  // Uploading afterwards: the root of the project, no chat (an upload belongs to the human and the project; the copy of a chat has a
  // root of its own and gets no files afterwards).
  { file: "server/projectbox/setup/upload.js", call: "store.projectInstance", count: 2, reason: "Upload afterwards: the lock NOT_READY and the discarding ask the state of MAIN — the provision lies in the root of the project, in no copy" },
  { file: "server/projectbox/setup/upload.js", call: "runInstance", count: 7, reason: "Upload afterwards: begin, done, check, unpack, discard and the procedure work in the root of the project in main — an upload belongs to the PROJECT, not to a chat" },
  { file: "server/projectbox/setup/routes.js", call: "store.projectInstance", count: 2, reason: SETUP_MAIN },
  { file: "server/projectbox/setup/routes.js", call: "runInstance", count: 2, reason: SETUP_MAIN },
  { file: "server/projectbox/setup/status.js", call: "store.projectInstance", count: 1, reason: `${SETUP_MAIN}; here only the view (INTERRUPTED computes with the state of main)` },
  // The layout belongs to the PROJECT, not to a chat — read and checked in main (an open copy turns the layout into a pure view;
  // a copy has no layout of its own).
  { file: "server/projectbox/layout/read.js", call: "runInstance", count: 1, reason: "Layout of an existing project: level and check read the project folder in main — they belong to the project, not to a chat; an open copy switches the layout to view-only" },
  { file: "server/projectbox/layout/read.js", call: "store.projectInstance", count: 1, reason: "Layout of an existing project: the situation asks the state of main (not ready => view only) — no instance of a chat" },
  { file: "server/projectbox/layout/job.js", call: "runInstance", count: 1, reason: "Job of a layout: the quiet check asks the terminals in the project container through the container program in main — the job belongs to the project, not to a chat (a copy prevents it)" },
  { file: "server/projectbox/layout/job.js", call: "store.projectInstance", count: 1, reason: "Job of a layout: quiet is checked only when main is `ready` (otherwise `ready` checks later) — no instance of a chat" },
  { file: "server/projectbox/layout/procedure.js", call: "runInstance", count: 1, reason: "Execution of a layout: the rebuild belongs to the project and runs in main (an open copy prevents the job) — the context asks the instance of main, no chat" },
  { file: "server/projectbox/layout/procedure.js", call: "store.projectInstance", count: 4, reason: "Execution of a layout: the target state of main (before, stop, start up, way back) — the same row that the restore drives, no instance of a chat" },
  { file: "server/projectbox/layout/bringAlong.js", call: "store.projectInstance", count: 1, reason: "Execution of a layout, step 17: the target state of main loses the services that fall with an omitted path — no instance of a chat" },
  { file: "server/projectbox/layout/superseded.js", call: "runInstance", count: 3, reason: "Old containers of renamed stacks: inventory, state and removal belong to the project and run in the daemon of main (the superseded containers stand there) — no instance of a chat" },
  { file: "server/projectbox/git-assignment.js", call: "runInstance", count: 2, reason: "The project of the key: main for the roots of the project, and the copy whose worktree root carries the path — the instance stands in the PATH (copy-worktrees/<name>), not in a chat" },
  { file: "server/projectbox/instance.js", call: "store.projectInstance", count: 1, reason: LIFE_LOG_INSTANCE },
  // The actions on an instance name it in the route; stop and start read the row of THIS instance (life cycle), the preview link the
  // instance it points to.
  { file: "server/projectbox/instance-actions.js", call: "runInstance", count: 1, reason: "Actions on an instance: the instance stands in the route (`/instances/:instance/…`, instanceOf checks it) — no chat, no instance of a chat is looked for" },
  { file: "server/projectbox/instance-actions.js", call: "store.projectInstance", count: 1, reason: "The event of an action (reportAction) carries the row OF THE instance on which the action runs — named in the route, no chat" },
  { file: "server/projectbox/instance-stop.js", call: "store.projectInstance", count: 10, reason: `${LIFE_LOG_INSTANCE}; stop and start read the row of the named instance before and after every step` },
  // The tree names every instance of the project — main and every living copy — with its row; details only for the named, ready
  // instance (runInstance). No chat, no instance of a chat is looked for.
  { file: "server/projectbox/instances-tree.js", call: "store.projectInstance", count: 4, reason: "Instances tree: state of main and every living copy from its row — the tree shows ALL instances of the project, none of a chat; plus the creation time of the row against which the action (`action`) is held; plus the mark of the summary (`mark`: creation and change time of the row — a state change reads anew)" },
  { file: "server/projectbox/instances-tree.js", call: "runInstance", count: 1, reason: "Instances tree: containers and repos of every ready instance (summary at most 30 s old; the chosen `?open` fresh) — the instance stands in the name of the row, no chat" },
  // The progress of a copy that is coming into being (pill "Active runs" and tree) reads in the step "start" the stage from the
  // instance row of THIS copy (`copy-<name>` from its stack_copies row) — no chat, no instance is looked for.
  { file: "server/projectbox/copy-progress.js", call: "store.projectInstance", count: 1, reason: "Progress of a copy being built: the stage of the compose start stands in the instance row of THIS copy, named from its stack_copies row — only read, no instance of a chat" },
  // Fetching the VS Code server up front puts it only into the MAIN of a converted project (a copy does not mount
  // `.vscode-server`) — no chat, no instance of a chat is looked for.
  { file: "server/projectbox/vscode-upfront.js", call: "store.projectInstance", count: 1, reason: "Fetching the VS Code server up front: upfrontProject reads the state of MAIN (ready, converted) — a copy refuses it beforehand; in the tick and at atReady, never from a chat" },
  // The copy list carries `main` and per copy the state of its instance row — one list per project, no chat.
  { file: "server/stacks/routes.js", call: "store.projectInstance", count: 2, reason: "Copy list: `main` for GET …/stack-copies; delete preview: the state of the copy named in the route for GET …/state — project and copy stand in the route, no chat" },
  { file: "server/preview/links.js", call: "store.projectInstance", count: 1, reason: "stoppedTextOf: a preview link carries its instance itself (column `instance`) — only its state is read (stopped => 502), no chat" },
  { file: "server/projectbox/instances.js", call: "store.projectInstance", count: 3, reason: LIFE_LOG_INSTANCE },
  { file: "server/projectbox/run-instance.js", call: "store.projectInstance", count: 1, reason: "the source itself (runInstance): setInstanceSource in server.js — all resolution of the instance row goes through here" },
  { file: "server/projectbox/idle.js", call: "store.instanceFor", count: 1, reason: "rowOf: the row of the instance on which the lock judges — for main `instanceFor`; WHICH instance a chat has is told by chatInstance (connection setInstanceForChat)" },
  { file: "server/projectbox/idle.js", call: "store.projectInstance", count: 1, reason: "rowOf: the row of the copy on which the lock judges" },
  { file: "server/projectbox/names.js", call: "store.projectInstance", count: 2, reason: "hosts block per instance: the instance comes as an argument" },
  { file: "server/projectbox/network-targets.js", call: "runInstance", count: 1, reason: "Network target of an identifier `<project>/<instance>` from the name (parts.instance) — the instance stands in the name, not in the chat" },
  { file: "server/projectbox/recreate.js", call: "store.projectInstance", count: 8, reason: LIFE_LOG_INSTANCE }, // recreate continuation (copy being cleared away)
  { file: "server/projectbox/serverEnd.js", call: "store.projectInstance", count: 2, reason: LIFE_LOG_INSTANCE },
  { file: "server/projectbox/relocation/procedure.js", call: "store.projectInstance", count: 13, reason: RELOCATION_MAIN },
  { file: "server/projectbox/relocation/compose-in-b.js", call: "store.projectInstance", count: 1, reason: "composeInB: whether a project is converted is told by the row of its MAIN — containers in B never belong to a copy" },
  { file: "server/projectbox/relocation/data.js", call: "runInstance", count: 1, reason: RELOCATION_MAIN },
  { file: "server/projectbox/relocation/routes.js", call: "store.projectInstance", count: 1, reason: "withoutInstanceRow: a project without a row of its MAIN violates the invariant — a copy without main does not exist" },
  { file: "server/projectbox/relocation/collect.js", call: "store.projectInstance", count: 1, reason: RELOCATION_MAIN },
  { file: "server/projectbox/resumption.js", call: "store.projectInstance", count: 4, reason: LIFE_LOG_INSTANCE },
  { file: "server/projectbox/restore.js", call: "store.projectInstance", count: 7, reason: LIFE_LOG_INSTANCE },
  { file: "server/runs/agents.js", call: "instanceForProject", count: 1, reason: "Delete path of the worktrees of the subagents in the runtime folder `worktrees/` — main; the closing path never touches `copy-worktrees/`: the worktrees of a copy are cleared only by clearing the copy away" },
  { file: "server/runs/instance.js", call: "instanceForProject", count: 3, reason: "the resolution layer itself: instanceFromIdentifier (image of a subagent) and instanceForChat (main and copy) — the decision is made HERE, nowhere else" },
  { file: "server/runs/instance-switch.js", call: "store.projectInstance", count: 1, reason: "instanceChoice: the CHECK of a desired value of `chats.instance` — the instance is the named value (`copy-<name>`) in the named project; only whether its row lives is read (409 UNKNOWN_INSTANCE), no instance of a chat is looked for. Resolution happens afterwards through instanceOfChat" },
  { file: "server/runs/runtime-limit.js", call: "instanceForProject", count: 1, reason: "instanceOfTheRuntimeFolder: path in the runtime folder → project → main (B anchor of the boundary); the runtime folder is the same for main and copy and stays in B, the copy carries only it there as an anchor (anchorOfTheInstance)" },
  { file: "server/runs/system-prompt.js", call: "instanceForProject", count: 2, reason: "projectInContainer without an argument: the fallback for callers without a turn — do-run.js and agents.js always pass along the instance of the turn or of the core (instanceOfChat). Plus projectMemory of a subagent whose image carries NO instance (started and recorded before the relocation): if the project is converted NOW, B reads only across the boundaries of main — if the image carries the identifier of a copy, there is NO memory (a copy is never assumed here, main never read for a copy)" },
  { file: "server/server.js", call: "runInstance", count: 1, reason: "setInstanceSource(runInstance): the source of the resolution layer" },
  { file: "server/stacks/clearAway.js", call: "store.projectInstance", count: 5, reason: ROW_THIS_INSTANCE }, // livedAgain
  { file: "server/stacks/request.js", call: "runInstance", count: 1, reason: "read the copy refs of main (git in main): explicitly main" },
  { file: "server/stacks/request.js", call: "store.projectInstance", count: 1, reason: "the row of the TEMPLATE that the request names explicitly (`baseInstance`) — must be ready; the base is asked in it" },
  { file: "server/stacks/creation.js", call: "store.projectInstance", count: 1, reason: ROW_THIS_INSTANCE },
  { file: "server/stacks/build.js", call: "store.projectInstance", count: 4, reason: ROW_THIS_INSTANCE },
  { file: "server/stacks/freeze.js", call: "runInstance", count: 1, reason: "the follow-up work of main after thawing: explicitly main — a dismantling that hit the frozen main lies there" },
  { file: "server/stacks/freeze.js", call: "store.projectInstance", count: 4, reason: `${ROW_THIS_INSTANCE}; plus the row of the TEMPLATE that the copy row names explicitly (\`baseInstance\`): precondition "ready" and the instance in which its snapshot is read` },
  { file: "server/stacks/inset.js", call: "store.projectInstance", count: 1, reason: ROW_THIS_INSTANCE },
  { file: "server/stacks/remove.js", call: "store.projectInstance", count: 1, reason: ROW_THIS_INSTANCE },
  { file: "server/stacks/fetch.js", call: "store.projectInstance", count: 2, reason: ROW_THIS_INSTANCE },
  { file: "server/stacks/queue.js", call: "store.projectInstance", count: 3, reason: `${ROW_THIS_INSTANCE}; plus explicitly the row MAIN of the project — the queue waits until it is ready; and the row of the TEMPLATE that the copy row names (\`baseInstance\`) — a copy from a copy waits for it instead of for main` },
  { file: "server/stacks/dismantling.js", call: "store.projectInstance", count: 1, reason: ROW_THIS_INSTANCE },
  { file: "server/stacks/start.js", call: "store.projectInstance", count: 1, reason: ROW_THIS_INSTANCE },
  { file: "server/stacks/state.js", call: "store.projectInstance", count: 4, reason: `${ROW_THIS_INSTANCE}; plus explicitly the row MAIN of the project — mainInError: if it stands on "error", the sentence of a waiting copy names the way; likewise the row of the BASE of the copy (main or its template, baseStopped): if it is stopped, the sentence names the tab "Instances"` },
  { file: "server/toolchain/mcp-load.js", call: "instanceForProject", count: 1, reason: "\"Load tools\" of a project MCP server (coding MCP airlock): comes from the UI, no chat — the server runs in the namespace of main like its configuration; a RUN starts it through the airlock with the instance of its chat" },
  { file: "server/workflows/worktree.js", call: "instanceForProject", count: 1, reason: "instanceOf: the default (main) when the caller passes no instance; createGraphWorktree gets the instance of the run chat (instanceOfChat, graph-start.js) and notes it in info.identifier" },
];

const CALLS = [
  ["instanceForProject", /(?<![\w$.])(?<!function )instanceForProject\(/g],
  ["instanceForLocation", /(?<![\w$.])(?<!function )instanceForLocation\(/g],
  ["store.instanceFor", /(?<![\w$])store\.instanceFor\(/g],
  ["store.projectInstance", /(?<![\w$])store\.projectInstance\(/g],
  ["runInstance", /(?<![\w$.])(?<!function )runInstance\(/g],
];

// Source without comments; strings and templates become empty strings (their content does not count as code), regex literals become
// `/r/` (a regex literal with quotation marks, e.g. /[,\\"]/ in stacks/creation.js, would otherwise derail the state and swallow the
// rest of the file). A `/` begins a regex literal after `( , = : [ ! & | ? { } ;`, at the start and after return/typeof.
function withoutComments(src) {
  let o = "";
  let i = 0;
  let before = ""; // the last significant character of the code; a word as a whole for return/typeof
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; o += " "; continue; }
    if (c === "/" && (before === "" || "(,=:[!&|?{};".includes(before) || /(?:^|[^\w$.])(?:return|typeof)$/.test(o.trimEnd()))) {
      let j = i + 1;
      let kind = false;
      while (j < n && src[j] !== "\n" && (kind || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") kind = true;
        else if (src[j] === "]") kind = false;
        j++;
      }
      j++; // the closing /
      while (j < n && /[a-z]/.test(src[j])) j++; // Flags
      o += "/r/"; before = "r"; i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") j++; j++; }
      o += `${c}${c}`; before = c; i = j + 1; continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== "`") { if (src[j] === "\\") j++; j++; }
      o += "``"; before = "`"; i = j + 1; continue;
    }
    o += c; if (!/\s/.test(c)) before = c; i++;
  }
  return o;
}

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") files(p, out); } else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ELECTRON, p).split(path.sep).join("/");
const allSources = () => Object.fromEntries(files(ELECTRON).map((p) => [rel(p), fs.readFileSync(p, "utf8")]));

export function checkTable(sources, table = TABLE) {
  const findings = [];
  const counted = new Map(); // "file|call" → count
  for (const [file, src] of Object.entries(sources)) {
    if (file.includes("/store/")) continue; // the data layer itself: it DEFINES projectInstance/instanceFor
    const code = withoutComments(src);
    for (const [name, re] of CALLS) {
      const n = (code.match(re) || []).length;
      if (n) counted.set(`${file}|${name}`, n);
    }
  }
  const entries = new Map();
  for (const e of table) {
    const k = `${e.file}|${e.call}`;
    if (entries.has(k)) findings.push(`${k}: twice in the table`);
    entries.set(k, e);
    if (typeof e.reason !== "string" || e.reason.length < 25) findings.push(`${k}: the reason is missing or too short (at least 25 characters — why may this place stay with a fixed instance?)`);
    if (!counted.has(k)) findings.push(`${k}: is in the table, but 0× in the code — the entry falls (the list may only shrink)`);
  }
  for (const [k, n] of counted) {
    const e = entries.get(k);
    if (!e) findings.push(`${k}: ${n}× in the code, not in the table — a new place that resolves the instance without the chat: use instanceOfChat(chat, location) or enter it with a reason`);
    else if (e.count !== n) findings.push(`${k}: ${n}× in the code, the table says ${e.count}× — one place more or less: check the reason`);
  }
  return findings;
}

test("(A) every call of the instance resolution without a chat is in the table with a reason", () => {
  const b = checkTable(allSources());
  assert.deepEqual(b, []);
});

// ── (B) The connections ──────────────────────────────────────────────────────────────────────────────────────────────────
export const CONNECTIONS = [
  { file: "server/runs/do-run.js", pattern: "const instance = instanceOfChat(chat, runLocation);", purpose: "the instance of the turn: the copy of the chat" },
  { file: "server/runs/do-run.js", pattern: "instanceOfChat(chat, location)", purpose: "runAddDirs without an argument" },
  { file: "server/runs/do-run.js", pattern: "instance = instanceOfChat(chat, runLocation);", purpose: "the core without a turn (agentContextWithoutTurn)" },
  { file: "server/runs/agents.js", pattern: "instanceOfChat(chat, runLocation)", purpose: "the instance of the core when no turn passes it along" },
  { file: "server/runs/agents.js", pattern: "instanceOfChat(now)", purpose: "repoCandidates: the instance of the chat" },
  { file: "server/runs/runtime-limit.js", pattern: "instanceOfChat(chat)", purpose: "the boundary of a read path in the name of a chat" },
  { file: "server/runs/routes.js", pattern: "instanceOfChat(id, location2)", purpose: "attachments to the location of the run" },
  { file: "server/channels/messages.js", pattern: "instanceOfChat(chat)", purpose: "channelSituation without origin" },
  { file: "server/devtools/routes.js", pattern: "instanceOfChat(String(chatId), { projectId: ctx.proj.id })", purpose: "terminal of the chat bar and browser tab with ?chat" },
  // From a project network the token decides the instance, never the chat — the places that write into or read from an instance
  // take it from the fence. Whoever takes one back writes into main with the token of a copy.
  { file: "server/projectbox/fence.js", pattern: "ctx.fence = fenceContext(u.instance, view);", purpose: "ctx.fence carries identifier and instance of the token" },
  { file: "server/projectbox/fence.js", pattern: "chatReason: (chatId) => PARAMETER.chatInstance(s, chatId),", purpose: "a ?chat must lie in the instance of the token" },
  { file: "server/devtools/routes.js", pattern: "return ctx.fence.instance;", purpose: "the target instance of a token route is the one of the token" },
  { file: "server/devtools/routes.js", pattern: "ctx.fence.chatReason(String(chatId))", purpose: "a ?chat is checked against the instance of the token" },
  { file: "server/devtools/routes.js", pattern: "if (ctx.fence && instanceIsCopy(ctx.fence.instance))", purpose: "the language service gives the token of a copy nothing from main" },
  { file: "server/channels/messages.js", pattern: "const inst = instanceFromIdentifier(String(origin));", purpose: "channelSituation resolves the origin through the IDENTIFIER of the token" },
  { file: "server/channels/routes.js", pattern: "origin: ctx.fence?.identifier || null", purpose: "the channel files resolve in the instance of the token" },
  // The pin of a background start is first the instance of the STARTING TURN, only without it (or with a turn in another project)
  // the binding of the chat — and the repo check asks the same one.
  { file: "server/workflows/graph-start.js", pattern: "const inTurn = turnIdentifier(chat.id);", purpose: "the background start pins first the instance of the starting turn" },
  { file: "server/workflows/graph-start.js", pattern: "const where = instanceForChat(chat);", purpose: "without a turn instance the background start pins the binding of the chat" },
  { file: "server/workflows/graph-start.js", pattern: "pin: where.name !== \"main\" ? where.identifier : \"\"", purpose: "the pin from the binding (fallback without a turn instance)" },
  { file: "server/workflows/graph-start.js", pattern: "instance: pin,", purpose: "graph_starts.instance = the pin of the start" },
  { file: "server/workflows/graph-start.js", pattern: "graphWorktreeRepos(project, location ? location.instance() : instanceOfChat(chat))", purpose: "the repo check asks the instance in which the worktree is created (background: the one of the pin)" },
  { file: "server/workflows/graph-start.js", pattern: "const inst = instanceOfChat(runChat);", purpose: "the worktree of a run in the instance of the run chat (asked once, for root and creation)" },
  { file: "server/workflows/graph-start.js", pattern: "worktreeRoot(locationForProject(project.id), inst?.instance)", purpose: "the worktree root of the instance of the run chat — copy-worktrees/<name> in a copy" },
  { file: "server/server.js", pattern: "setGitWakeup((projectId, instance = MAIN) => {", purpose: "the git view of a copy chat wakes the copy (second argument), never main in its place" },
  { file: "server/server.js", pattern: "restoreInstance(projectId, instance, { reason: \"git view: container down\" })", purpose: "the waker of the git view restores the instance that asked" },
  { file: "server/server.js", pattern: "setCopyRepoSource((inst) => readSnapshot(copyLocation({ data: DIRS.data, projectId: inst.projectId, name: copyNameOf(inst.instance) })).repos", purpose: "the repos of a copy are those of its snapshot — no source, no fallback to main" },
  { file: "server/dynworkflows/run.js", pattern: "const instanceIdentifier = before?.instanceIdentifier || (turnIdentifier(chat.id) ?? instanceIdentifierOf(instanceOfChat(chat)));", purpose: "the core keeps the instance of the start (a resume that of its predecessor)" },
  { file: "server/dynworkflows/run.js", pattern: "store.createDynRun({ runId, taskId, chatId: chat.id, name, meta, scriptPath, outputPath, callId, args, resumeOf: before?.runId || \"\", budgetTotal: pot.total, instanceIdentifier });", purpose: "the identifier stands on the run (dyn_workflow_runs.instance_identifier)" },
  { file: "server/dynworkflows/run.js", pattern: "prior: row.budgetConsumed }), instanceIdentifier: identifierTheRow(row) });", purpose: "the restart opens the core in the instance of the start, not in the current one of the chat" },
  { file: "server/dynworkflows/run.js", pattern: "agentContextWithoutTurn(run2.chatId, run2.instanceIdentifier === undefined ? {} : { identifier: run2.instanceIdentifier })", purpose: "the core opens with it" },
  { file: "server/runs/queue.js", pattern: "if (turnInstanceDifferent(chatId)) return false;", purpose: "an input does not go into the process of another instance" },
  { file: "server/stacks/state.js", pattern: "copyTransition(prior, after, { returnPathAtServerEnd });", purpose: "move-in, wake call, move-out at the setter (the announcement of the way back goes along)" },
  { file: "server/projectbox/idle.js", pattern: "const i = instanceForChat(String(chatId ?? \"\"), String(projectId ?? \"\"));", purpose: "the lock asks the instance of the chat" },
  { file: "server/server.js", pattern: "setInstanceForChat(instanceNameForChat);", purpose: "lock and idle per identifier" },
  { file: "server/server.js", pattern: "setBrowserChatInstance(instanceNameForChat);", purpose: "the profiles of a chat belong to its instance" },
  { file: "server/server.js", pattern: "kind: copyKind", purpose: "the source of the child chats" },
  { file: "server/server.js", pattern: "copiesWakeRestartGrace();", purpose: "the lost wake call in the restart grace" },
];

export function checkConnections(sources, list = CONNECTIONS) {
  const findings = [];
  for (const a of list) {
    const src = sources[a.file];
    if (src === undefined) { findings.push(`${a.file}: file missing`); continue; }
    if (!withoutComments(src).includes(a.pattern.replace(/"[^"\\]*"/g, '""'))) findings.push(`${a.file}: "${a.pattern}" is missing (${a.purpose}) — the connection is taken back`);
  }
  return findings;
}

test("(B) the connections stand where the resolution needs them", () => {
  assert.deepEqual(checkConnections(allSources()), []);
});

// ── (C) The resolution ───────────────────────────────────────────────────────────────────────────────────────────────────
// The source plays the instance rows; the copy of a chat the copy source; child chats the child source.
const row = (projectId, instance) => ({ projectId, instance, identifier: `${projectId}/${instance}`, containerId: `c-${projectId}-${instance}` });
function including(sources, fn) {
  const { rows = {}, copies = {}, children = {} } = sources;
  setInstanceSource((pid, inst) => rows[`${pid}/${inst}`] || null);
  setCopySource((chatId) => copies[chatId] || null, { kind: (chatId) => children[chatId] || null });
  try { return fn(); } finally { setInstanceSource(null); setCopySource(null); }
}
const ROWS = { "p1/main": row("p1", "main"), "p1/copy-k1": row("p1", "copy-k1"), "p2/main": row("p2", "main") };

test("(C1) without copy and without source: main — instance as instanceForProject, null without relocation", () => {
  assert.deepEqual(instanceForChat({ id: "c", projectId: "p1" }, { projectId: "p1" }), { instance: null, identifier: null, name: "main", projectId: "p1", kind: "main", locked: false, notice: null });
  including({ rows: ROWS }, () => {
    const r = instanceForChat({ id: "c", projectId: "p1" }, { projectId: "p1" });
    assert.equal(r.instance, ROWS["p1/main"]);
    assert.equal(r.identifier, "p1/main");
    assert.equal(r.name, "main");
    assert.equal(instanceOfChat({ id: "c" }, { projectId: "p9" }), null, "a project without a row: no relocation");
    assert.equal(instanceOfChat({ id: "c", projectId: "p1" }), ROWS["p1/main"], "without location the project of the chat row counts");
    assert.equal(instanceOfChat("c", undefined), null, "an id without location and without project has no instance");
    assert.equal(instanceOfChat({ id: "c", projectId: "p1" }, {}), null, "a flat location (without projectId) has no instance");
  });
});

test("(C2) the copy of the chat in its project: row, identifier, name, kind", () => {
  including({ rows: ROWS, copies: { c: { projectId: "p1", instance: "copy-k1" } } }, () => {
    const r = instanceForChat({ id: "c", projectId: "p1" }, { projectId: "p1" });
    assert.equal(r.instance, ROWS["p1/copy-k1"]);
    assert.deepEqual([r.identifier, r.name, r.kind, r.locked, r.notice], ["p1/copy-k1", "copy-k1", "copy", false, null]);
    assert.equal(instanceNameForChat("c", "p1"), "copy-k1");
    assert.equal(instanceNameForChat("other", "p1"), "main");
    assert.equal(instanceOfChat("c", { projectId: "p1" }), ROWS["p1/copy-k1"]);
  });
});

test("(C3) the copy of an earlier project rests — in another project the chat runs in main, never in the copy of p1", () => {
  including({ rows: ROWS, copies: { c: { projectId: "p1", instance: "copy-k1" } } }, () => {
    const r = instanceForChat({ id: "c", projectId: "p2" }, { projectId: "p2" });
    assert.equal(r.name, "main");
    assert.equal(r.instance, ROWS["p2/main"]);
    assert.equal(instanceNameForChat("c", "p2"), "main");
    assert.equal(instanceNameForChat("c", null), "main", "without a project no copy");
  });
});

test("(C4) a child chat runs in the instance of its start — the copy in the pin, never the current one of its chat; without a pin in main", () => {
  including({ rows: ROWS, copies: { kind1: { projectId: "p1", instance: "copy-k1" } }, children: { kind1: { identifier: "" }, kind2: { identifier: "p1/copy-k1" }, kind3: { identifier: "p2/copy-k1" } } }, () => {
    assert.equal(instanceNameForChat("kind1", "p1"), "main", "a child started in main stays there, even if its chat has a copy");
    const r = instanceForChat("kind2", { projectId: "p1" });
    assert.deepEqual([r.name, r.kind, r.identifier], ["copy-k1", "kind", "p1/copy-k1"]);
    assert.equal(r.instance, ROWS["p1/copy-k1"]);
    assert.equal(instanceNameForChat("kind3", "p1"), "main", "a pin of another project does not apply here");
    assert.equal(instanceNameForChat("free", "p1"), "main", "no child, no copy");
  });
});

test("(C5) the binding names a copy without a row => locked with a message, instance null, NO fallback to main; instanceOfChat throws", () => {
  const withoutRow = { "p1/main": ROWS["p1/main"] };
  including({ rows: withoutRow, copies: { c: { projectId: "p1", instance: "copy-k1" } }, children: { kind: { identifier: "p1/copy-k1" } } }, () => {
    for (const chat of ["c", "kind"]) {
      const r = instanceForChat(chat, { projectId: "p1" });
      assert.equal(r.locked, true, chat);
      assert.equal(r.instance, null);
      assert.equal(r.identifier, "p1/copy-k1");
      assert.equal(r.name, "copy-k1");
      assert.ok(/nicht im Haupt|not in the main/.test(r.notice) && r.notice.includes("copy-k1"), r.notice);
      assert.throws(() => instanceOfChat(chat, { projectId: "p1" }), (e) => e instanceof CopyLocked && e.code === "COPY_LOCKED" && e.status === 409 && e.identifier === "p1/copy-k1");
    }
  });
});

// turnInstanceDifferent must not compare only within the OLD project — a project switch of the chat (PATCH, chats/routes.js →
// turnProjectSwitched with `toProject`) would stay "same", and an input in the waiting phase would go into the process of A although
// the chat stands in B. So the project of the chat row counts too; without the new project the mark applies.
test("(C7) turnInstanceDifferent recognizes the project switch of the chat (main and copy), a switch back is the same again, without an instance on the turn never", () => {
  const running = (chatId, identifier) => pinTurn(chatId, { projectId: identifier.slice(0, identifier.indexOf("/")), instance: ROWS[identifier] });
  const output = (chatId) => { releaseTurn(chatId); switchAfterTurn(chatId); };
  including({ rows: ROWS, copies: { ck: { projectId: "p1", instance: "copy-k1" } } }, () => {
    running("c", "p1/main");
    running("ck", "p1/copy-k1");
    try {
      assert.equal(turnInstanceDifferent("c"), false, "without a switch: same");
      assert.equal(turnInstanceDifferent("ck"), false, "the turn in the copy, the chat in the copy: same");
      turnProjectSwitched("c", { toProject: "p2" });
      turnProjectSwitched("ck", { toProject: "p2" });
      assert.equal(turnInstanceDifferent("c"), true, "project switch p1 → p2 (main): the input would go into the process of p1");
      assert.equal(turnInstanceDifferent("ck"), true, "project switch p1 → p2 from the copy: the input would go into the copy of p1");
      turnProjectSwitched("c", { toProject: "p1" });
      assert.equal(turnInstanceDifferent("c"), false, "back to p1: the same instance again");
      turnProjectSwitched("c", { toProject: null });
      assert.equal(turnInstanceDifferent("c"), true, "without a project: no longer the instance of the turn");
    } finally { output("c"); output("ck"); }
    // Without the new project (a caller that sets only the mark): closed — the mark alone means "different".
    running("c", "p1/main");
    try {
      turnProjectSwitched("c");
      assert.equal(turnInstanceDifferent("c"), true, "the mark `project` without a target counts as a switch");
    } finally { output("c"); }
    // A turn without an instance (no relocation, local) — never "different", even after a switch.
    pinTurn("g2", { projectId: "p9", instance: null });
    try {
      turnProjectSwitched("g2", { toProject: "p2" });
      assert.equal(turnInstanceDifferent("g2"), false);
    } finally { output("g2"); }
  });
});

test("(C6) a source that throws (database unreadable) keeps throwing — unreadable is not \"no copy\"", () => {
  setInstanceSource(() => null);
  setCopySource(() => { throw new Error("database is locked"); });
  try {
    assert.throws(() => instanceForChat({ id: "c", projectId: "p1" }, { projectId: "p1" }), /database is locked/);
    assert.throws(() => instanceNameForChat("c", "p1"), /database is locked/);
  } finally { setInstanceSource(null); setCopySource(null); }
});

// ── (E) Tally against the syntax tree ────────────────────────────────────────────────────────────────────────────────────────
function astTally(src) {
  const sf = ts.createSourceFile("x.js", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const z = {};
  const walk = (nd) => {
    if (ts.isCallExpression(nd)) {
      const t = nd.expression.getText(sf);
      if (CALLS.some(([name]) => name === t)) z[t] = (z[t] || 0) + 1;
    }
    ts.forEachChild(nd, walk);
  };
  walk(sf);
  return z;
}

test("(E) the cleaned tally per file equals the tally in the syntax tree — no state drift through regex literals, templates or strings", () => {
  const deviations = [];
  for (const [file, src] of Object.entries(allSources())) {
    if (file.includes("/store/")) continue;
    const code = withoutComments(src);
    const ast = astTally(src);
    for (const [name, re] of CALLS) {
      const n = (code.match(re) || []).length;
      if (n !== (ast[name] || 0)) deviations.push(`${file}: ${name} ${n}× in the cleaned text, ${ast[name] || 0}× in the syntax tree`);
    }
  }
  assert.deepEqual(deviations, []);
  // The trigger: a regex literal with quotation marks must not swallow the rest of the file.
  const probe = 'const e = /[,\\"]/.test(x);\nstore.projectInstance(pid, instanz);\nconst r = a / b; runInstance(p);';
  assert.equal((withoutComments(probe).match(/store\.projectInstance\(/g) || []).length, 1);
  assert.equal((withoutComments(probe).match(/runInstance\(/g) || []).length, 1, "the division is no regex literal");
});

// ── (D) The built-in counter-test ───────────────────────────────────────────────────────────────────────────────────────
const withReplacement = (q, file, from, to) => {
  assert.ok(q[file].includes(from), `${file}: "${from}" is not there — the sabotage hits nothing`);
  return { ...q, [file]: q[file].replace(from, to) };
};

test("(D) built-in counter-test: a place back, a new one without an entry, an entry without a place, a wrong count, a connection taken — one finding each", () => {
  const real = allSources();
  assert.deepEqual(checkTable(real), []);
  assert.deepEqual(checkConnections(real), []);

  // do-run.js resolves the instance of the turn through the project again: new place AND missing connection.
  const back = withReplacement(real, "server/runs/do-run.js", "const instance = instanceOfChat(chat, runLocation);", "const instance = instanceForProject(runLocation.projectId);");
  assert.ok(checkTable(back).some((b) => b.startsWith("server/runs/do-run.js|instanceForProject") && b.includes("not in the table")), checkTable(back).join("\n"));
  assert.ok(checkConnections(back).some((b) => b.startsWith("server/runs/do-run.js")));

  // A new place in a file without an entry, in one with an entry (other count), and per call kind.
  for (const [file, call] of [["server/channels/routes.js", "store.projectInstance(p, \"haupt\")"], ["server/runs/queue.js", "instanceForLocation(x)"], ["server/runs/agents.js", "runInstance(p)"], ["server/runs/do-run.js", "store.instanceFor(p)"], ["server/stacks/creation.js", "instanceForProject(p)"]]) {
    const fresh = { ...real, [file]: `${real[file]}\nfunction sabotage() { return ${call}; }\n` };
    assert.ok(checkTable(fresh).length > 0, `${file}: ${call} stays green`);
  }
  const more = { ...real, "server/runs/agents.js": `${real["server/runs/agents.js"]}\nconst x = instanceForProject(y);\n` };
  assert.ok(checkTable(more).some((b) => b.includes("the table says 1×")), checkTable(more).join("\n"));

  // An entry without a place, a reason too short, an entry twice.
  assert.ok(checkTable(real, [...TABLE, { file: "server/runs/queue.js", call: "runInstance", count: 1, reason: "a reason that is long enough to count" }]).some((b) => b.includes("0× in the code")));
  assert.ok(checkTable(real, TABLE.map((e, i) => (i === 0 ? { ...e, reason: "short" } : e))).some((b) => b.includes("too short")));
  assert.ok(checkTable(real, [...TABLE, TABLE[0]]).some((b) => b.includes("twice")));
  assert.ok(checkTable(real, TABLE.slice(1)).some((b) => b.includes("not in the table")), "a deleted entry stays green");

  // Comments and strings do not count.
  const still = { ...real, "server/runs/queue.js": `${real["server/runs/queue.js"]}\n// instanceForProject(x)\nconst t = "runInstance(y)";\n` };
  assert.deepEqual(checkTable(still), []);

  // Every connection: taking it back gives a finding.
  for (const a of CONNECTIONS) {
    const taken = { ...real, [a.file]: real[a.file].split(a.pattern).join("/* taken back */") };
    assert.ok(checkConnections(taken).some((b) => b.startsWith(a.file) && b.includes(a.pattern.slice(0, 20))), `connection "${a.pattern}" stays without a finding`);
  }
});
