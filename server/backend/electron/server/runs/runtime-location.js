// The runtime folder per project. A leaf: imports only node:*, app-state.js, the store facade and the leaf
// ./runtime-write.js (the writers in the runtime folder: WHOEVER WRITES into a path from here does so via
// `writeInRuntimeFolder`/`copyInRuntimeFolder`/`createFolderInRuntimeFolder` — the project container mounts the
// runtime folder rw, and a link there would lead every path writer of the backend outside).
//
// WHAT LIVES HERE. Every runtime file of a chat — scratch, MCP configurations (also the subagents'), attachments,
// the output location, the worktrees, Playwright configurations and profiles, a project's browser profile, the
// service logs, process group files and the CLIs' home — gets its path HERE. The path guard
// (server/backend/test/runtime-location.test.js) holds that: `DIRS.scratch`, `DIRS.attachments`, `DIRS.outputs` and
// the literals of the subfolder names stand in no other file, except for the named exception list there (the login
// store and the workspace browser profile stay flat).
//
// THE SWITCH: `locationFor({ projectId, converted })` returns for a converted project its folder
// `<data>/projects/<projectId>/`, otherwise the flat location `<data>/` — byte-identical: every flat path is built
// from exactly the parts it was always built from (`DIRS.scratch`, `DIRS.attachments`, `DIRS.outputs`,
// `<data>/playwright-…`). Converted means: the instance row carries `converted_at` (store/project-instances.js).
//
//   field              flat                                  converted project
//   scratch            DIRS.scratch                          <data>/projects/<p>/scratch
//   attachments        DIRS.attachments                      <data>/projects/<p>/attachments
//   outputs            DIRS.outputs                          <data>/projects/<p>/outputs
//   worktrees          DIRS.scratch/worktrees                <data>/projects/<p>/worktrees
//   copyWorktrees      —                                     <data>/projects/<p>/copy-worktrees   (per copy `<name>/`)
//   playwrightConfigs  <data>/playwright-configs             <data>/projects/<p>/playwright-configs
//   playwrightProfiles <data>/playwright-profiles            <data>/projects/<p>/playwright-profiles
//   browserProfiles    <data>/browser-profiles               <data>/projects/<p>/browser-profiles
//   serviceLogs        <data>/service-logs (<projId>_<svc>)  <data>/projects/<p>/service-logs (<instance>_<svc>)
//   processes          —                                     <data>/projects/<p>/processes
//   home               —                                     <data>/projects/<p>/home
//   setup              —                                     <data>/projects/<p>/setup   (the archives
//                                                            `archive-<id>.zip` of a ZIP source, see archiveFile)
//
// The names of the MCP files stay (`<chat>.mcp.json`, `<chat>.agent-<id>[.workflow].mcp.json`): the deploy
// recognises a workflow agent by this name (tools/check/lib/processes.mjs), not by the folder.
//
// WHO TAKES WHICH LOCATION. A turn fixes its location at its start and passes it on; a subagent core remembers the
// location under which it was opened (runs/agents.js) and cleans up exactly there at its end — a project switch in
// the middle of its life moves nothing from under its feet. Whoever needs a path without a turn (upload, channel
// delivery, display) asks `locationForChat` and gets the location of the CURRENT project.
//
// PROJECT SWITCH: `bringAlongChat(chat, { backgroundAlive })` at the start of a turn moves the chat's files from
// every other location to the current one — only if no background work of the chat is alive any more (it works with
// the old, absolute paths; the next turn then catches up). An open core at another location that still knows an
// agent, even a finished one, counts too (runs/agents.js coresElsewhereWithAgents, asked in do-run.js). When
// merging, the YOUNGER file wins, on a tie the target (an agent continued from the inventory writes to its old
// path). Returned is what moved, so that the caller names the old absolute paths in the history via a silent hint
// (runs/hints.js). The CLIs' transcripts are NOT part of it (runs/session-transfer.js). The worktrees never move:
// git knows them under their absolute path, and they belong to running work; when the chat is deleted, the closing
// path clears them (runs/agents.js cleanUpAgentsWorktrees — only in a project's runtime folder).
//
// THE COPY'S WORKTREES: the worktrees of the subagents and graph runs of a chat in its copy live under
// `<runtime>/copy-worktrees/<name>/` — NEXT TO `worktrees/`, never below it: projectbox/git-assignment.js assigns
// `worktrees/` to the main (the longest prefix wins, the assignment is the path), and the post-work of a dismantling
// would run in the main. `worktreeRoot(location, instance)` is the ONE place that chooses between the two. The
// closing path (chatTraces) never names the location: it is backed up and removed only by clearing away the copy
// (stacks/clearAway.js).
//
// READERS WITH FALLBACK: until the move, attachments and outputs lie at the old location — `attachmentFile`,
// `attachmentPath`, `outputFile`, `attachmentFolderToRead` and `foreignChatFolder` also search there (section below,
// with the consumers). A turn in the PROJECT CONTAINER does not see the old location: there the attachments are
// copied to the run's location (`copyAttachmentsTo` at the start of the turn, `fetchAttachmentAtLocation` in
// `/message`), the outputs are named by `deferralHint`.
//
// CLEANUP: `chatTraces(location, chatId)` is the ONE list of what a chat leaves behind at a location — the closing
// path (chats/erase.js) asks it for EVERY location (`allLocations()`: flat and every `<data>/projects/*`), because
// after the rows are deleted nobody knows which project the chat was in last; idempotent, and it catches leftovers
// of a project switch. `removeTrace` removes ONE trace with a fallback: a root-owned leftover (root in the project
// container on the idmapped home) throws EACCES/EPERM — then the passed `rootFallback` decides (chats/erase.js →
// projectbox/cleanUp.js, `docker exec -u root … rm -rf`), otherwise a warning is recorded. A trace at a project
// location WITH an instance row goes to the fallback FIRST — the running container mounts the location, and a
// recursive delete in the backend via path names would follow its links.
import fs from "node:fs";
import path from "node:path";
import { DIRS } from "../app-state.js";
import * as store from "../store.js";
// The writers in the runtime folder: a leaf without store so that the leaves browser-profiles.js and browsers.js can
// use it too. `PROJECTS` and `runtimeFolderOf` live there and are passed on from here.
import {
  PROJECTS, renameInRuntimeFolder, areaInRuntimeFolder, removeInRuntimeFolder, cloneWithoutReference, copyInRuntimeFolder,
  runtimeFolderOf, createFolderInRuntimeFolder,
} from "./runtime-write.js";

export { PROJECTS, runtimeFolderOf };
/** The main instance (store/project-instances.js): service logs are named `<instance>_<svc>.log`, by default the main's. */
const MAIN = "main";
// A copy's instance is named `copy-<name>` (projectbox/creation.js COPY_PREFIX, COPY_NAME — this leaf imports nothing
// from there; the guard runtime-location.test.js keeps both forms equal).
const COPY_PREFIX = "copy-";
const COPY_NAME = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/;

// A project id becomes a folder name — never something that leads out of `<data>/projects/`.
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const checkId = (projectId) => {
  const id = String(projectId);
  if (!VALID_ID.test(id)) throw new Error(`runtime folder: invalid project id "${id}"`);
  return id;
};

function flatLocation() {
  return Object.freeze({
    projectId: null,
    root: DIRS.data,
    scratch: DIRS.scratch,
    attachments: DIRS.attachments,
    outputs: DIRS.outputs,
    worktrees: path.join(DIRS.scratch, "worktrees"),
    copyWorktrees: null,
    playwrightConfigs: path.join(DIRS.data, "playwright-configs"),
    playwrightProfiles: path.join(DIRS.data, "playwright-profiles"),
    browserProfiles: path.join(DIRS.data, "browser-profiles"),
    serviceLogs: path.join(DIRS.data, "service-logs"),
    processes: null,
    home: null,
    setup: null,
  });
}

function projectLocation(projectId) {
  const id = checkId(projectId);
  const w = path.join(DIRS.data, PROJECTS, id);
  return Object.freeze({
    projectId: id,
    root: w,
    scratch: path.join(w, "scratch"),
    attachments: path.join(w, "attachments"),
    outputs: path.join(w, "outputs"),
    worktrees: path.join(w, "worktrees"),
    copyWorktrees: path.join(w, "copy-worktrees"),
    playwrightConfigs: path.join(w, "playwright-configs"),
    playwrightProfiles: path.join(w, "playwright-profiles"),
    browserProfiles: path.join(w, "browser-profiles"),
    serviceLogs: path.join(w, "service-logs"),
    processes: path.join(w, "processes"),
    home: path.join(w, "home"),
    setup: path.join(w, "setup"),
  });
}

/**
 * The location — pure. Converted and with a project: the project's runtime folder; otherwise the flat one.
 * @param {{ projectId?: string|null, converted?: boolean }} o
 */
export function locationFor({ projectId = null, converted = false } = {}) {
  return projectId && converted ? projectLocation(projectId) : flatLocation();
}

// Before initStore (unit tests without a database) and without the table there is no instance row — then the flat
// way, reported once. EVERY other read error throws: a `SQLITE_BUSY` after the busy_timeout means "unknown", not
// "not converted" — for a converted project the flat location would lie outside its mount.
let reported = false;
const withoutTable = (e) => /no such table/i.test(String(e?.message || ""));
function flatReported(reason) {
  if (!reported) { reported = true; console.warn(`[runtime-location] no instance row readable (${reason}) — flat location`); }
  return false;
}
function isConverted(projectId) {
  if (!projectId) return false;
  if (!store.instancesReadable()) return flatReported("store not opened");
  try { return store.converted(String(projectId)) === true; } catch (e) {
    if (withoutTable(e)) return flatReported(e.message);
    throw e;
  }
}

/** A project's location (id or null), by its instance row. */
export const locationForProject = (projectId) => locationFor({ projectId, converted: isConverted(projectId) });

const chatOf = (chat) => {
  if (chat && typeof chat === "object") return chat;
  try { return store.getChat(String(chat)); } catch { return null; }
};
const idOf = (chat) => String(chat && typeof chat === "object" ? chat.id : chat);

/** A chat's location (row or id) — that of its CURRENT project. Without a row (deleted) the flat one. */
export const locationForChat = (chat) => locationForProject(chatOf(chat)?.projectId || null);

/** Every location where files can lie: the flat one and every folder under `<data>/projects/`. */
export function allLocations() {
  const locations = [flatLocation()];
  let names = [];
  try { names = fs.readdirSync(path.join(DIRS.data, PROJECTS), { withFileTypes: true }); } catch { /* no project converted yet */ }
  for (const n of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (n.isDirectory() && VALID_ID.test(n.name)) locations.push(projectLocation(n.name));
  }
  return locations;
}

/**
 * Create a project's runtime folder BEFORE a run needs it (trap: a directory a run is to read must exist BEFORE the
 * run — `addDirs` only takes what exists). The flat location is created at server start (flatRuntimeFolder); for it
 * this function does nothing. Returns the location.
 */
export function createLocation(location) {
  if (location?.projectId) for (const d of [location.scratch, location.attachments, location.outputs]) fs.mkdirSync(d, { recursive: true });
  return location;
}

/** The folders the server creates at start for the flat location (server.js). */
export function flatRuntimeFolder() {
  const o = flatLocation();
  return [o.scratch, o.attachments, o.outputs];
}

// ── Paths per chat ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A chat's scratch folder (working folder of a chat without a workspace, runs/system-prompt.js resolveCwd). */
export const chatScratch = (chat, location = locationForChat(chat)) => path.join(location.scratch, idOf(chat));
/** The MCP configuration of the main run (Claude `--mcp-config`). */
export const mcpFile = (chat, location = locationForChat(chat)) => path.join(location.scratch, `${idOf(chat)}.mcp.json`);
/**
 * The MCP configuration of a subagent or workflow agent — the name is the deploy's process marker. An outer loop
 * run (`outerLoop` = `{ agentId, runId }`) is named `<chat>.outerloop-<agentId>-<runId>.mcp.json`: it does not match
 * tools/check/lib/processes.mjs WORKFLOW_AGENT_RE (the deploy waits for it), and the closing path catches it via
 * the prefix `<chat>.outerloop-` (chatTraces).
 */
export const agentMcpFileIn = (location, chatId, agentId, { workflowAgent = false, outerLoop = null } = {}) =>
  path.join(location.scratch, outerLoop
    ? `${chatId}.outerloop-${outerLoop.agentId}-${outerLoop.runId}.mcp.json`
    : `${chatId}.agent-${agentId}${workflowAgent ? ".workflow" : ""}.mcp.json`);
/** A chat's attachments. */
export const attachmentLocation = (chat, location = locationForChat(chat)) => path.join(location.attachments, idOf(chat));
/** A chat's output location (runs/outputs.js). */
export const outputLocationIn = (location, chatId) => path.join(location.outputs, String(chatId));
/**
 * The root of the worktrees (subagents `agent-<aid>`, graph runs `graph-<startId>`) of an instance: the main (or
 * without a value) `location.worktrees`; `copy-<name>` `<runtime>/copy-worktrees/<name>` — the copy container
 * creates them there, and git-assignment.js assigns them to the copy via this path. An instance outside the form and
 * a copy at the flat location THROW: no path next to the main.
 */
export function worktreeRoot(location, instance = MAIN) {
  const i = instance === undefined || instance === null || instance === "" ? MAIN : String(instance);
  if (i === MAIN) return location.worktrees;
  const name = i.startsWith(COPY_PREFIX) ? i.slice(COPY_PREFIX.length) : "";
  if (!COPY_NAME.test(name) || name === MAIN) throw new Error(`worktree root: no instance "${i}" — "${MAIN}" or "${COPY_PREFIX}<name>"`);
  if (!location.copyWorktrees) throw new Error(`worktree root: the instance "${i}" does not exist at the flat location — a copy has a runtime folder`);
  return path.join(location.copyWorktrees, name);
}
/**
 * Create the root of the worktrees (workflows/worktree.js): in the runtime folder without a link leading outside
 * (runs/runtime-write.js, `EOUTSIDE`) — a copy's root lies two levels below the anchor (`copy-worktrees/<name>`), and
 * a recursive `mkdirSync` would follow a link at `copy-worktrees` into a backend folder and create `<name>` there.
 * Otherwise (flat) the plain call. Returns the root.
 */
export function createWorktreeRoot(root) {
  if (!createFolderInRuntimeFolder(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}
/**
 * The archive of a ZIP source: `<runtime>/setup/archive-<id>.zip` — ONLY in the runtime folder of a converted project
 * (the flat location has no `setup`, there it throws: a ZIP source only exists in operations). `archiveId` is a UUID
 * (projectbox/setup/archive.js assigns it) — anything else throws, no name from a request becomes a path here.
 * `archiveIdFromName(name)` is the inverse for the restart hook of the project archives (it recognises an archive's
 * file by EXACTLY this name; every other name in the folder stays).
 */
const ARCHIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARCHIVE_NAME = /^archive-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.zip$/;
export const isArchiveId = (archiveId) => typeof archiveId === "string" && ARCHIVE_ID.test(archiveId);
export function archiveFile(location, archiveId) {
  if (!location?.setup) throw new Error("archive: only in the runtime folder of a converted project");
  if (!isArchiveId(archiveId)) throw new Error(`archive: invalid archive id "${String(archiveId).slice(0, 60)}"`);
  return path.join(location.setup, `archive-${archiveId}.zip`);
}
export const archiveIdFromName = (name) => ARCHIVE_NAME.exec(String(name || ""))?.[1] ?? null;
/** The root of the Playwright profiles of the chats and their subagents. */
export const playwrightProfileRoot = (location) => location.playwrightProfiles;
/** A project's browser profile ("Browser" tab at project level, devtools/routes.js). */
export const projectBrowserProfile = (projectId) => path.join(locationForProject(projectId).browserProfiles, `proj-${projectId}`);
/**
 * The profile of a chat's OWN browser: `chat-<id>` under the browser profiles of its chat's location — in its
 * project's runtime folder if it is converted (like projectBrowserProfile), otherwise flat. Cleaned up with the chat
 * (chatTraces, field `browserProfiles`).
 */
export const chatBrowserProfile = (chat) => path.join(locationForChat(chat).browserProfiles, `chat-${chat.id}`);
/**
 * After a project switch: the chat browser's profiles at the OTHER locations. bringAlongChat does not move them (a
 * running Chromium at the new location and merging files beneath it do not go together); the browser at the new
 * location starts with a fresh profile and reads the logins from there once. The old ones stay until the chat is
 * deleted (chatTraces).
 */
export const chatBrowserProfileElsewhere = (chat) => {
  const here = locationForChat(chat).root;
  return allLocations().filter((o) => o.root !== here).map((o) => path.join(o.browserProfiles, `chat-${chat.id}`)).filter((p) => fs.existsSync(p));
};
/**
 * A service's log file — flat `<projId>_<svc>.log`, in the runtime folder `<instance>_<svc>.log`. `instance` (a copy
 * writes its service logs under ITS name next to the main's) missing or empty ⇒ the main; flat there is no instance,
 * there it has no effect. An instance name becomes part of a file name: only what could also be a project id (no
 * `/`, no `..`), otherwise it throws.
 */
export function serviceLogFile(projectId, serviceId, instance = MAIN) {
  const location = locationForProject(projectId);
  if (!location.projectId) return path.join(location.serviceLogs, `${projectId}_${serviceId}.log`);
  const inst = String(instance || MAIN);
  if (!VALID_ID.test(inst)) throw new Error(`service log: invalid instance "${inst}"`);
  return path.join(location.serviceLogs, `${inst}_${serviceId}.log`);
}

// `runtimeFolderOf(path)` lives in runs/runtime-write.js and is passed on from here (import above). services.js (via
// initServices `logAnchor`) accesses every such file only via the descriptor, the writers there likewise.

/**
 * The Playwright configuration for a profile (h = headless, s = visible). It lies next to the profile root the
 * profile belongs to: a profile under `<w>/playwright-profiles/` has its configuration under
 * `<w>/playwright-configs/`; every other (also none) the flat one.
 */
export function playwrightConfigFile(userDataDir, headless) {
  const parent = userDataDir ? path.dirname(userDataDir) : "";
  const root = parent && path.basename(parent) === "playwright-profiles" ? path.join(path.dirname(parent), "playwright-configs") : flatLocation().playwrightConfigs;
  return path.join(root, `${path.basename(userDataDir || "default")}-${headless ? "h" : "s"}.json`);
}

// A chat's profile is named `chat-<id>`, a subagent's `chat-<id>-agent-<aid>` (browser-profiles.js chatProfileDir —
// the guard keeps both spellings equal).
const profileName = (chatId) => `chat-${chatId}`;

/**
 * What a chat leaves behind at ONE location — the one list for closing path and project switch. Only what exists
 * there.
 * @returns {{ field: string, name: string, path: string }[]}
 */
export function chatTraces(location, chatId) {
  const id = String(chatId);
  const out = [];
  const take = (field, name) => {
    const filePath = path.join(location[field], name);
    if (fs.existsSync(filePath)) out.push({ field, name, path: filePath });
  };
  const list = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
  take("scratch", id);
  take("scratch", `${id}.mcp.json`);
  take("scratch", `${id}.agents`); // legacy leftover
  for (const n of list(location.scratch)) if (n.startsWith(`${id}.agent-`) && n.endsWith(".mcp.json")) take("scratch", n);
  // Outer loop runs on this chat: their MCP file and their profile (`<chat>-outerloop-<agent>-<run>`, runs/agents.js).
  for (const n of list(location.scratch)) if (n.startsWith(`${id}.outerloop-`) && n.endsWith(".mcp.json")) take("scratch", n);
  take("attachments", id);
  take("outputs", id);
  const profile = profileName(id);
  take("browserProfiles", profile); // the chat's own browser (chatBrowserProfile)
  for (const n of list(location.playwrightProfiles)) if (n === profile || n.startsWith(`${profile}-agent-`) || n.startsWith(`${profile}-outerloop-`)) take("playwrightProfiles", n);
  for (const n of list(location.playwrightConfigs)) {
    if (!n.endsWith(".json")) continue;
    const stem = n.replace(/-[hs]\.json$/, "");
    // `<profile>-user`: the configuration of a user-browser MCP server that an earlier version wrote (no longer written, no profile of
    // its own; the data migration renamed the old `-user` files) — still collected so that deleting the chat also clears such a leftover.
    if (stem === profile || stem === `${profile}-user` || stem.startsWith(`${profile}-agent-`) || stem.startsWith(`${profile}-outerloop-`)) take("playwrightConfigs", n);
  }
  return out;
}

const PERMISSIONS = new Set(["EACCES", "EPERM"]);

// The seam `rm`: a test forces the root-owned leftover (EACCES) via it instead of via file modes — as root `chmod`
// has no effect, and a folder without write permission would leave the test's temp tree behind. Unset (the
// product): `fs.rmSync`. Returns the previous seam (for resetting in the finally).
let rmSeam = null;
export function setRmSeam(fn) {
  const old = rmSeam;
  rmSeam = typeof fn === "function" ? fn : null;
  return old;
}

// ── Remembered traces ──────────────────────────────────────────────────────────────────────────────────────────────
// A trace the fallback could not remove (the project container was stopped) is kept as `{ projectId, path }` in the
// app settings — durable, because after the chat is deleted nobody else knows of it. At most LANES_CAP entries
// (estimated, not measured: a handful of traces per deleted chat); beyond that nothing more is remembered, and the
// warning says so. If the list is unreadable, it counts as empty — the trace then stays, with a warning.
const LANES_KEY = "runtime.traces_catch_up";
export const LANES_CAP = 1000;
function readLanes() {
  const v = JSON.parse(store.getSetting(LANES_KEY, "[]") || "[]");
  return Array.isArray(v) ? v.filter((s) => s && typeof s.projectId === "string" && typeof s.path === "string") : [];
}
function rememberLane(projectId, filePath, warn) {
  const report = (w) => { try { warn(w); } catch { /* the warning must not break the path */ } };
  try {
    const list = readLanes();
    if (list.some((s) => s.projectId === projectId && s.path === filePath)) return;
    if (list.length >= LANES_CAP) {
      report(`[runtime-location] ${filePath} stays — ${LANES_CAP} traces are already remembered for catching up (cap, estimated)`);
      return;
    }
    list.push({ projectId: String(projectId), path: String(filePath) });
    store.setSetting(LANES_KEY, JSON.stringify(list));
  } catch (e) {
    report(`[runtime-location] ${filePath} stays — not remembered for catching up (${e?.message || e})`);
  }
}
function trackFallback(result, projectId, filePath, warn) {
  if (!result || typeof result.then !== "function") return;
  result.then((ok) => { if (ok === false) rememberLane(projectId, filePath, warn); }, () => rememberLane(projectId, filePath, warn));
}

/**
 * Catch up the remembered traces of ONE project — called when its main becomes ready (server.js). Every trace goes
 * through `removeTrace` once more (with an instance row, i.e. to the container); if it fails again, the fallback
 * remembers it again. Only paths in the runtime folder of THIS project. Returns the number of traces caught up.
 */
export function catchUpLanes(projectId, { rootFallback = null, warn = console.warn } = {}) {
  if (typeof rootFallback !== "function") return 0;
  let list;
  let location;
  try {
    list = readLanes();
    location = locationFor({ projectId, converted: true });
  } catch (e) {
    try { warn(`[runtime-location] remembered traces of ${projectId} not readable (${e?.message || e})`); } catch { /* see above */ }
    return 0;
  }
  const my = list.filter((s) => s.projectId === location.projectId);
  if (!my.length) return 0;
  try { store.setSetting(LANES_KEY, JSON.stringify(list.filter((s) => s.projectId !== location.projectId))); } catch (e) {
    try { warn(`[runtime-location] remembered traces of ${projectId} not caught up (${e?.message || e})`); } catch { /* see above */ }
    return 0;
  }
  let n = 0;
  for (const s of my) {
    const rel = path.relative(location.root, s.path);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    removeTrace(s.path, location, { rootFallback, warn });
    n++;
  }
  return n;
}

/**
 * Remove ONE trace. A root-owned leftover (EACCES/EPERM) goes to `rootFallback({ projectId, path })` — only at a
 * project location, because only there does root write (the project container). Otherwise and without a fallback a
 * warning.
 * At a project location WITH an instance row the trace goes to `rootFallback` FIRST — the runtime folder is mounted
 * at the same path in the running project container, and `fs.rmSync` with `recursive` is a rimraf over PATH NAMES:
 * if the container swaps a subfolder for a link between two steps, the backend deletes the link's target in its own
 * files. In the container `rm -rf` follows no link. No way (the fallback throws synchronously — without server
 * operations) or no instance row (no container mounts the location): the plain delete. If the instance row is
 * unreadable, the backend does NOT delete (a warning). Guard: server/backend/test/runtime-location.test.js.
 * A failed fallback (result `false` or rejection — e.g. the project container was stopped) remembers the trace
 * (`rememberLane`, durable in the app settings — a backend restart does not lose it), and `catchUpLanes` removes it
 * as soon as the project's main is ready again (server.js).
 * @returns {string|null} the warning, or null
 */
export function removeTrace(filePath, location, { rm = rmSeam || fs.rmSync, rootFallback = null, warn = console.warn } = {}) {
  // The fallback rules synchronously (if it throws, there is no way) and executes asynchronously: if execution fails, the trace is remembered.
  const fallback = () => trackFallback(rootFallback({ projectId: location.projectId, path: filePath }), location.projectId, filePath, warn);
  if (location?.projectId && typeof rootFallback === "function") {
    let withInstance = false;
    try { withInstance = store.projectInstancesOf(location.projectId).length > 0; } catch (e) {
      const w = `[runtime-location] ${filePath} stays — the instance of ${location.projectId} is not readable (${e?.message || e}), no delete in the backend`;
      try { warn(w); } catch { /* the warning must not break the path */ }
      return w;
    }
    if (withInstance) {
      try { fallback(); return null; } catch { /* no way — plain delete */ }
    }
  }
  try { rm(filePath, { recursive: true, force: true }); return null; } catch (e) {
    if (PERMISSIONS.has(e?.code) && location?.projectId && typeof rootFallback === "function") {
      try { fallback(); return null; } catch (e2) { e = e2; }
    }
    const w = `[runtime-location] ${filePath} not removed (${e?.code || e?.message || e})`;
    try { warn(w); } catch { /* the warning must not break the path */ }
    return w;
  }
}

/**
 * Remove everything of a chat at EVERY location (the closing path). Idempotent.
 * @returns {string[]} the warnings
 */
export function cleanUpChatRuntime(chatId, opts = {}) {
  const warnings = [];
  for (const location of allLocations()) {
    for (const s of chatTraces(location, chatId)) {
      const w = removeTrace(s.path, location, opts);
      if (w) warnings.push(w);
    }
  }
  return warnings;
}

// Rename, copy across volumes (EXDEV). An existing target (file) is replaced.
function rename(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, force: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// Put a trace at a new location: if the target is missing, rename (same volume); if it exists, merge — folders entry
// by entry, with two files the YOUNGER one wins (mtime), on a tie the target: mostly the target is younger (written
// after the switch), but a subagent continued from the inventory writes its output file to its OLD absolute path
// even after the move already took the first version along.
//
// If one side lies in a runtime folder, the move goes via moveWithoutReference (below) — otherwise (flat ↔ flat) as
// here.
function move(from, to) {
  if (areaInRuntimeFolder(from) || areaInRuntimeFolder(to)) { moveWithoutReference(from, to); return; }
  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    rename(from, to);
    return;
  }
  const a = fs.lstatSync(from);
  const b = fs.lstatSync(to);
  if (a.isDirectory() && b.isDirectory()) {
    for (const n of fs.readdirSync(from)) move(path.join(from, n), path.join(to, n));
    fs.rmSync(from, { recursive: true, force: true });
    return;
  }
  if (!a.isDirectory() && !b.isDirectory() && a.mtimeMs > b.mtimeMs) {
    rename(from, to);
    return;
  }
  fs.rmSync(from, { recursive: true, force: true });
}

// The move when one side lies in a runtime folder. The project container mounts it rw; via path names `mkdirSync`,
// `renameSync`, `cpSync` and `rmSync` would follow every link there, and `renameSync` would carry a link out of the
// runtime folder into the flat location — where the backend writes without a check and would follow it at the next
// attachment. So: if the source lies in the backend and the target is missing, renamed in one move with the target
// folder pinned in the area (the content including links may enter the runtime folder — every writer checks
// there). Otherwise COPIED without links (links, FIFOs and devices do not move along; the younger file wins as
// above, a link at the target falls), and only when every file has arrived does the source fall via pinned folders.
// An error leaves the source in place (the next turn catches up).
function moveWithoutReference(from, to) {
  if (!areaInRuntimeFolder(from)) {
    try { renameInRuntimeFolder(from, to); return; } catch (e) { if (e?.code !== "EEXIST" && e?.code !== "EXDEV") throw e; }
  }
  const r = cloneWithoutReference(from, to, {
    take: (q, z) => !z || z.isSymbolicLink() || !z.isFile() || q.mtimeMs > z.mtimeMs,
  });
  if (r.error.length) throw Object.assign(new Error(`not moved completely: ${r.error.join("; ")}`), { code: "EINCOMPLETE" });
  if (!removeInRuntimeFolder(from)) fs.rmSync(from, { recursive: true, force: true });
}

/**
 * Project switch: move the chat's files from every OTHER location to its current one — at the start of a turn.
 * Nothing to do ⇒ null. If background work of the chat is alive (`backgroundAlive()`), everything stays where it is
 * ⇒ `{ deferred: true, ... }` (the next turn catches up). Otherwise
 * `{ to, relocated: [{ field, from, to }], error }`. The CLIs' transcripts are moved by
 * runs/session-transfer.js, not by this function.
 */
export function bringAlongChat(chat, { backgroundAlive = () => false, location = locationForChat(chat) } = {}) {
  const id = idOf(chat);
  // Without the chat browser's profile (chatBrowserProfileElsewhere): it stays where it is.
  const foreign = allLocations().filter((o) => o.root !== location.root)
    .map((o) => ({ o, lanes: chatTraces(o, id).filter((s) => s.field !== "browserProfiles") })).filter((x) => x.lanes.length);
  if (!foreign.length) return null;
  if (backgroundAlive()) return { deferred: true, destination: location.root, from: foreign.map((x) => x.o.root), relocated: [], error: [] };
  const relocated = [];
  const error = [];
  for (const { lanes } of foreign) {
    for (const s of lanes) {
      const target = path.join(location[s.field], s.name);
      try { move(s.path, target); relocated.push({ field: s.field, from: s.path, destination: target }); } catch (e) {
        error.push(`${s.path}: ${e?.code || e?.message || e}`);
      }
    }
  }
  return { deferred: false, destination: location.root, relocated, error };
}

/**
 * The silent hint after a move: which old absolute paths (attachments, outputs, scratch) now lie elsewhere — the
 * completion notices (`outputFile`) and channel messages in the history still name the old ones. "" ⇒ nothing to say.
 */
export function relocationHint(result) {
  const visible = (result?.relocated || []).filter((u) => u.field === "attachments" || u.field === "outputs" || u.field === "scratch");
  if (!visible.length) return "";
  const rows = visible.map((u) => `- ${u.from} → ${u.destination}`);
  return [
    "This chat has switched projects; its files have moved to the runtime folder of the new project.",
    "Absolute paths in the history so far (e.g. the output file of a completion notice or the files of a channel message) that begin with one of the old paths now lie under the new one:",
    ...rows,
  ].join("\n");
}

/**
 * A stored absolute path after a move: if it no longer exists and lay under a chat folder (attachments, outputs) of
 * ANOTHER location, the path under the chat's current location — otherwise unchanged. For paths the server stored
 * itself (a dynamic workflow's script, dynworkflows/run.js).
 */
export function afterRelocation(chat, filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || fs.existsSync(filePath)) return filePath;
  const id = idOf(chat);
  const location = locationForChat(chat);
  for (const o of allLocations()) {
    if (o.root === location.root) continue;
    for (const field of ["attachments", "outputs"]) {
      const old = path.join(o[field], id);
      const rel = path.relative(old, filePath);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return path.join(location[field], id, rel);
    }
  }
  return filePath;
}

// ── Readers with fallback ──────────────────────────────────────────────────────────────────────────────────────────
// A chat's files only move to the location of its current project at the start of its next turn (bringAlongChat),
// and only if no background work is alive at the old location. Until then — after a project switch WITHOUT a turn
// or while the move is deferred — attachments and outputs lie at the OLD location, and a reader that only asks the
// current one does not see them. The readers here additionally search at every other location where the chat has
// traces. Without another location (no project ever converted) they return exactly what the reader saw before — no
// more file access than before as long as the file lies at the current location. Whoever WRITES writes to the
// current location (attachmentLocation, outputLocationIn).
// The consumers: engine transcript and image attachments of the turn (system-prompt.js, do-run.js), attachment GET
// (chats/routes.js), `/message` (runs/routes.js), the manual start of a workflow (workflows/routes.js), channel
// attachments and read roots (channels/messages.js), `--add-dir` (do-run.js), the task of an approval card
// (dynworkflows/approval.js).

// Search the path `rel` under the chat folder `field` (attachments | outputs): at the current location, otherwise at
// another.
function search(chat, field, rel, location, form) {
  const id = idOf(chat);
  const here = form(path.join(location[field], id), rel);
  if (fs.existsSync(here)) return here;
  for (const o of allLocations()) {
    if (o.root === location.root) continue;
    const there = form(path.join(o[field], id), rel);
    if (fs.existsSync(there)) return there;
  }
  return here;
}

/**
 * The path of the chat's attachment `file`: at the current location if it lies there or nowhere else; otherwise at
 * the other location where it lies. The form `${attachmentLocation}/${file}` is that of the engine transcript
 * (providers/transcript.js).
 */
export const attachmentFile = (chat, file, location = locationForChat(chat)) => search(chat, "attachments", file, location, (d, f) => `${d}/${f}`);

/**
 * The same in the form of the routes (`path.join(attachmentLocation, file)` — the form of GET, `/message` and the
 * manual workflow start; without another location byte-identical to it).
 */
export const attachmentPath = (chat, file, location = locationForChat(chat)) => search(chat, "attachments", file, location, path.join);

/**
 * A file in the chat's output location (`rel` relative to `<outputs>/<chatId>`, form `path.join`): at the current
 * location if it lies there or nowhere else; otherwise at the other location where it lies — e.g. the task behind
 * an approval card of a dynamic workflow.
 */
export const outputFile = (chat, rel, location = locationForChat(chat)) => search(chat, "outputs", rel, location, path.join);

/**
 * The chat's attachment folders for READING: the one at the current location first (even if it does not exist yet —
 * it is the one written to), followed by every existing one at another location. Without another location
 * `[attachmentLocation(chat)]`.
 * @returns {string[]}
 */
export function attachmentFolderToRead(chat, location = locationForChat(chat)) {
  const id = idOf(chat);
  const out = [attachmentLocation(chat, location)];
  for (const o of allLocations()) {
    if (o.root === location.root) continue;
    const d = path.join(o.attachments, id);
    if (fs.existsSync(d)) out.push(d);
  }
  return out;
}

/**
 * The chat's existing attachment and output folders at every OTHER location — for `--add-dir` of a run in the
 * backend's container while the move is deferred (runs/do-run.js). A project container does not see them (only its
 * own runtime folder is mounted); the turn COPIES the attachments there (copyAttachmentsTo, below), a hint names the
 * outputs.
 * @returns {string[]}
 */
export function foreignChatFolder(chat, location = locationForChat(chat)) {
  const id = idOf(chat);
  const out = [];
  for (const o of allLocations()) {
    if (o.root === location.root) continue;
    for (const field of ["attachments", "outputs"]) {
      const d = path.join(o[field], id);
      if (fs.existsSync(d)) out.push(d);
    }
  }
  return out;
}

// ── Attachments into the project container ─────────────────────────────────────────────────────────────────────────
// A turn in the project container sees ONLY its own runtime folder (projectbox/creation.js mountRules) —
// `foreignChatFolder` does not help there. If the move of the chat files is deferred (background work is alive at
// the old location), the attachments are COPIED to the run's location, not moved: they never change after upload,
// the old work keeps reading its paths, and the later merge (move) finds equal files with equal mtime — the target
// stays, the source falls. Outputs of living agents stay deferred (they are still being written); the silent hint
// names them.

// A file to its target via tmp + rename, timestamps along; an existing target stays (attachments are immutable).
// Target in the runtime folder: via the descriptor (runs/runtime-write.js) — the project container mounts it, a link
// there would otherwise redirect the copy into the backend's files. If the source lies in another runtime folder, it
// too is read without links. Otherwise the plain calls.
function copyFallsMissing(from, to) {
  const inLocation = copyInRuntimeFolder(from, to, { onlyIfMissing: true, times: true });
  if (inLocation) return inLocation === "copied";
  if (fs.existsSync(to)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.copy-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(from, tmp);
    const st = fs.statSync(from);
    fs.utimesSync(tmp, st.atime, st.mtime);
    fs.renameSync(tmp, to);
    return true;
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* leftover */ } throw e; }
}
function copyTreeFallsMissing(from, to) {
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyTreeFallsMissing(a, b);
    else if (e.isFile() && copyFallsMissing(a, b)) n++;
  }
  return n;
}

/**
 * Copy the chat's attachments from every OTHER location to `location` (what is missing there). Returns
 * `{ copied: [{ from, destination, files }], outputsElsewhere: string[], error: string[] }` — `outputsElsewhere` are the
 * chat's output folders at other locations (not readable in the container until the move has been caught up).
 * Without another location: nothing, no write access.
 */
export function copyAttachmentsTo(chat, { location = locationForChat(chat) } = {}) {
  const id = idOf(chat);
  const out = { copied: [], outputsElsewhere: [], error: [] };
  for (const o of allLocations()) {
    if (o.root === location.root) continue;
    const from = path.join(o.attachments, id);
    if (fs.existsSync(from)) {
      const destination = path.join(location.attachments, id);
      try {
        const files = copyTreeFallsMissing(from, destination);
        if (files) out.copied.push({ from, destination, files });
      } catch (e) { out.error.push(`${from}: ${e?.code || e?.message || e}`); }
    }
    const outputs = path.join(o.outputs, id);
    if (fs.existsSync(outputs)) out.outputsElsewhere.push(outputs);
  }
  return out;
}

/**
 * ONE attachment (`file`, with its text extract `<file>.txt` if there is one) to `location` if it only lies at
 * another location — for `/message` when the turn will run in the project container (runs/routes.js): the prompt
 * then names the path at the run's location. Returns the folder at the location
 * (`attachmentLocation(chat, location)`), or null if the file lies nowhere.
 */
export function fetchAttachmentAtLocation(chat, file, location = locationForChat(chat)) {
  const here = attachmentLocation(chat, location);
  if (fs.existsSync(path.join(here, file))) return here;
  const id = idOf(chat);
  for (const o of allLocations()) {
    if (o.root === location.root) continue;
    const there = path.join(o.attachments, id);
    if (!fs.existsSync(path.join(there, file))) continue;
    copyFallsMissing(path.join(there, file), path.join(here, file));
    if (fs.existsSync(path.join(there, `${file}.txt`))) copyFallsMissing(path.join(there, `${file}.txt`), path.join(here, `${file}.txt`));
    return here;
  }
  return null;
}

/** The silent hint for `copyAttachmentsTo` — "" ⇒ nothing to say. */
export function deferralHint(result) {
  const copied = result?.copied || [];
  const outputs = result?.outputsElsewhere || [];
  if (!copied.length && !outputs.length) return "";
  return [
    "This chat now runs in the project container; the move of its files is deferred because background work is still alive at the old location.",
    ...(copied.length ? [
      "Its attachments have been COPIED to the project's runtime folder — absolute paths in the history so far that begin with one of the old paths you read under the new one:",
      ...copied.map((k) => `- ${k.from} → ${k.destination}`),
    ] : []),
    ...(outputs.length ? [
      "The outputs (e.g. the output file of a completion notice) under these folders are NOT readable here until the move has been caught up (at the start of a later turn, when the background work ends):",
      ...outputs.map((d) => `- ${d}`),
    ] : []),
  ].join("\n");
}

/**
 * The output folder of the Playwright MCP: screenshots and recordings would otherwise land in the working folder —
 * in the project folder, i.e. in the project repo. Only for a profile in a project's runtime folder
 * (`<data>/projects/<p>/playwright-profiles/chat-<chatId>[-agent-<aid>]`): then
 * `<data>/projects/<p>/outputs/<chatId>/playwright` — the chat's output location, readable in every run
 * (`--add-dir`) and cleaned up with the chat (chatTraces). Otherwise null: the configuration of a chat that is not
 * converted stays byte-identical.
 */
export function playwrightOutputLocation(userDataDir) {
  if (!userDataDir || !DIRS?.data) return null;
  const parent = path.dirname(userDataDir);
  if (path.basename(parent) !== "playwright-profiles") return null;
  const root = path.dirname(parent);
  if (path.basename(path.dirname(root)) !== PROJECTS || path.dirname(path.dirname(root)) !== DIRS.data) return null;
  if (!VALID_ID.test(path.basename(root))) return null;
  const name = path.basename(userDataDir);
  if (!name.startsWith("chat-")) return null;
  const chatId = name.slice("chat-".length).split("-agent-")[0];
  if (!chatId) return null;
  return path.join(projectLocation(path.basename(root)).outputs, chatId, "playwright");
}
