// The ONE start function of the project containers. A leaf: imports only node:* and the leaf real-path.js (reading the pgid
// file) — the instance comes as an object, the docker program through a setter.
//
//   inProject(null, cmd, args, opts)   is EXACTLY `spawn(cmd, args, opts)` — the same three arguments, the same object back.
//                                      Without an instance row (and without the ops marker) every start is unchanged. With
//                                      the ops marker the git folder is first in PATH (see "THE GIT FOLDER OF RUNS IN B"
//                                      below) — otherwise `opts` stays the same object.
//   inProject(inst, cmd, args, opts)   starts in the instance's project container:
//       docker exec -i [-t] -u agent [-w <cwd>] [-e NAME …] <container> /usr/sbin/cbase-wrapper
//              --pgid-file <runtime>/processes/<startId>.pgid -- cmd …args
//     The wrapper (server/backend/cbase-wrapper) makes the command the leader of its own process group, writes the group id
//     atomically into the pgid file and replaces itself with the command via exec (argv[0] stays `claude`/`codex`).
//
// THE ENVIRONMENT. B's full `process.env` NEVER goes along — the container has its own (image ENV and creation). What goes
// along is an allowlist: every name the caller changes or adds relative to `process.env` (`envAllowlist`), plus the named
// switches `ENV_TOGGLE` whenever the effective environment carries them — even empty (`CLAUDE_SECURESTORAGE_CONFIG_DIR` is
// emptied only in B; without `-e` the project container would carry its image's value). VALUES never appear on the command
// line: `-e NAME` without `=`, the value comes from the environment of the docker CHILD (the docker CLI reads it there; `ps`
// in the user container and the deploy log see only names). What the caller REMOVES (e.g. `ANTHROPIC_API_KEY` in
// cleanClaudeEnv) does not go along: B's environment does not reach the container anyway. A name containing `=` cannot be
// transported and is dropped (warning) — otherwise a value would end up in argv.
//
// THE CHILD. What comes back is the docker child itself (a ChildProcess: `pid` is ITS pid — runChildren, monitor lists, stdin,
// stdout, `close` as usual), with an overridden `.kill(sig)`:
//   1. the process group in the container: `docker exec -u agent <container> kill -<SIG> -- -<pgid>` (the id from the pgid
//      file);
//   2. then the original `kill` on the docker child.
// A killed `docker exec` does NOT end its process in the container (real docker and the fake alike) — without step 1 the CLI
// and its grandchildren would keep running. If the pgid file is not there yet (kill before the wrapper started), the group
// kill is CAUGHT UP: look again on a tick, one last look on the docker child's `close`, and above all a cap
// (`CBASE_IN_PROJECT_KILL_MS`, default 10 s) that reports itself. The child carries the marker `inProject`
// (`{ identifier, container, pgidFile }`) — `killProcessTree` (providers/monitor-runtime.js) asks for it, because
// `process.kill(-pid)` would only hit the docker child's group in B.
//
// THE ESCALATION. The caller escalates itself: stopRun (runs/state.js) sends TERM and after 3 s KILL — but only while
// `runChildren` still holds the same child. The docker child ends at once on TERM (the docker CLI dies, the command in the
// container does not), so that KILL would never come, and a CLI stuck in its TERM handler would stay in the container as an
// orphan. So the control escalates ITSELF, independent of the docker child's `close`: after a TERM to the group it checks
// after `CBASE_IN_PROJECT_ESCALATION_MS` (default 3 s, the same as stopRun; a cap that reports itself) with
// `kill -0 -- -<pgid>`, and if the group is still alive, `kill -KILL` follows. Only TERM (also `kill()` without a signal)
// escalates — the SIGHUP of a closed pty stays as it is. After the first read the pgid is kept IN MEMORY: a later KILL (from
// the caller or the escalation) reaches the group even after `close`, and the pgid file is only removed once the group is
// provably empty or got KILL (without any kill: on `close`). A kill to a group that is provably empty or got KILL is skipped.
//
// THE PTY. `inProjectCall(inst, cmd, args, { cwd, env, tty })` returns only the call (`program`, `args`, `env`, `container`,
// `pgidFile`) — terminal.js starts it in node-pty (`docker exec -it`) and ends it via `inProjectKill(call)` (the same control
// as on the child, without the original kill; the pty does that itself).
//
// THE SERVICE. `inProject(inst, cmd, args, { cwd, env, service: { log } })` starts DETACHED:
//   docker exec -d -u agent [-w <cwd>] [-e NAME …] <container> /usr/sbin/cbase-wrapper
//          --pgid-file <processes>/<id>.pgid --log <log> --exit <processes>/<id>.exit -- cmd …args
// The wrapper makes a child the leader of its own session (stdout/stderr to <log>), waits and writes the exit code to
// <id>.exit — a `-d` delivers no exit event, the docker child ends at once. So NO kill control hangs on the child here (a
// service outlives its exec caller; the pgid file belongs to the caller, services.js, which also cleans it up), and the child
// carries `inProject = { identifier, container, pgidFile, exitFile, log }`. Without an instance `service` is not meant to be
// used: the caller then passes its spawn options, and `inProject(null, …)` stays exactly `spawn`.
//
// THE SEAM (`setInProjectSeam`, set in server.js:startServer — the same pattern as setRunState):
//   kind(args, spawnOpts)    starts the docker CLI (projectbox/docker.js: throws without the ops marker)
//   program()                the docker program for the pty (projectbox/docker.js)
//   processLocation(inst)    `<runtime>/processes` of the project (runs/runtime-location.js) — the same path in the container
//   container(inst)          name or id of the project container (projectbox/run-instance.js containerOf)
// Unset, a start with an instance THROWS (empty is not unknown): an instance without a seam is a build error, not "then in B".
// Without an instance nobody needs the seam.
// THE PAUSE BARRIER — two more fields of the seam, both or neither:
//   frozen(container)                     is the container frozen right now (projectbox/docker.js isFrozen)?
//   childAfterThaw(container, args, opts) starts like `kind`, but only after the thaw (docker.js dockerChildAfterThaw): the
//                                         child is there at once (a waiting shell that replaces itself with the docker CLI
//                                         via `exec`), its command begins in the container only afterwards; after the cap it
//                                         ends with 125 and a message on stderr.
//   Without the two every start is the plain one (a paused container answers "is paused"). A kill BEFORE the release
//   (`kind.barrier.started` false) only ends the waiting shell: nothing ran in the container, there is no group to hit.
//   THE GROUP KILLS of a RUNNING start go the same way: TERM, KILL and the look-back `kill -0` to a frozen container start
//   behind the barrier and reach the group after the thaw. Sent raw, the TERM would get "is paused" and be lost, the look-back
//   would read exit 1 as "group empty" and end the escalation without KILL — after the thaw the turn would keep working in
//   the container unmanaged. If "is paused" arrives anyway (the race with the pause, or a pause cbase does not hold): frozen ⇒
//   caught up once behind the barrier; otherwise no verdict (never "group empty"). The escalation deadline only begins when
//   the TERM really goes out (on the barrier's release, or anew when caught up) — a process that could not see a TERM during
//   the pause gets the same grace after the thaw as otherwise.
//   For the group kills "frozen" means `frozen(container, { kill: true })` — only once the `pause` goes out. Between the
//   barrier's entry and the `pause` the container still runs (the pause waits there for running management git): a TERM that
//   waited at the barrier then would reach that git only after the thaw.
// THE QUIET: `kind.inProject.afterQuiet()` → promise, fulfilled as soon as the docker child is gone, no kill is waiting for the
//   pgid file and no escalation is pending — the group is then provably empty, got KILL, or there never was a kill (then the
//   command ended by itself). runtime/git-run.js counts a command until then: after a kill, the end of the docker CLI says
//   nothing about the command in the container.
//
// Test seam: `CBASE_WRAPPER` replaces the wrapper's path in the container (the fake docker maps the image path to
// server/backend/cbase-wrapper anyway, server/backend/test/fake-docker.mjs).
// ALWAYS ALONG: `envAlways: [NAME…]` puts names on the allowlist whenever the effective environment carries them — even if B
// already has the same value. Without it a switch B itself already carries (e.g. `GIT_TERMINAL_PROMPT=0`) would never arrive
// in the container (unset there): the allowlist otherwise transports only differences. Here too a value only goes as
// `-e NAME`.
// EMPTY VALUES: `envEmpty: [NAME…]` puts names with an EMPTY value into argv as `-e NAME=` instead of via the docker child's
// environment (runtime/git-run.js: emptying the inherited helper list, GIT_CONFIG_VALUE_0). An empty value is no secret —
// only empty values appear in argv this way, and a name that is not an identifier is dropped (warning). A name from
// `envEmpty` never also goes as `-e NAME`.
// THE USER: `asUser: "root"` starts as root (`-u root`) — and this start's group kill goes as root too (as agent it would not
// reach the root-owned group: "Operation not permitted"). Only "agent" (default) or "root"; anything else throws. The only
// caller is runtime/git-run.js commandRun; whoever asks for root there is listed with a reason in
// server/backend/test/in-project-start-places.test.js.
//
// Guard: server/backend/test/inProject.test.js.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realRoots, openFileWithoutReference } from "./real-path.js";

export const WRAPPER_PATH = "/usr/sbin/cbase-wrapper";
const wrapper = () => process.env.CBASE_WRAPPER || WRAPPER_PATH;

// The named switches: go along whenever the effective environment carries them — regardless of whether the caller changed
// them (B may already carry them itself, the container differently from its image).
export const ENV_TOGGLE = Object.freeze([
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY", // no auto memory of the CLI, in the project container either
  "CLAUDE_SECURESTORAGE_CONFIG_DIR", // B's setting (empty = ~/.claude) applies in the project container too
]);

// B's OWN package caches: the Dockerfile's backend stage points them at folders no project container mounts
// (projectbox/creation.js B_CACHE_FOLDER). They NEVER go into a project container — neither as a difference nor via
// `envAlways` or `envEmpty`: there the tools' defaults apply, i.e. the shared caches. npm reads `npm_config_*`
// case-insensitively, so the filter compares that way.
export const B_OWN_ENV = Object.freeze(["npm_config_cache", "UV_CACHE_DIR", "PIP_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH"]);
const B_OWN = new Set(B_OWN_ENV.map((k) => k.toLowerCase()));
const isBOwn = (k) => B_OWN.has(String(k).toLowerCase());

// THE GIT FOLDER OF RUNS IN B. Without an instance a start runs in B — and a `git` in it on a path of a converted project
// would bypass the project container (hooks, filters and `core.fsmonitor` of the repo in B). In production (the same rule as
// projectbox/ops.js projectboxOps — runtime/ never imports projectbox/; bound in inProject.test.js) the folder
// GIT_WRAPPER_FOLDER is therefore first in the PATH of every start WITHOUT an instance; its `git` is the wrapper
// /usr/bin/cbase-git (created in the Dockerfile's backend stage, with CBASE_GIT_BIN=/usr/bin/git against the loop): it sends
// git into the project container or calls B's git. Without the ops marker `opts` reaches spawn UNCHANGED (the same object).
// Test seam: CBASE_GIT_WRAPPER_FOLDER.
export const GIT_WRAPPER_FOLDER = "/usr/lib/cbase/git-path";
// The search path of a child WITHOUT PATH in its environment (libuv/libc `_PATH_DEFPATH`). An environment without PATH (a
// stdio MCP entry with its own `env`) gets it after the git folder — the folder alone would make every program found by name
// via this path fail with ENOENT (`python3 …`).
export const DEFAULT_SEARCH_PATH = "/usr/bin:/bin";
// Exported: the loop engine's file tools (providers/tool-runtime.js) check the real location without an instance only IN
// PRODUCTION — the same marker, not a copy.
export const opsMarker = () => process.env.CBASE_CONTAINER === "1" && process.env.CBASE_DIND === "1";
export function withGitWrapperFront(opts) {
  if (!opsMarker()) return opts;
  const folder = process.env.CBASE_GIT_WRAPPER_FOLDER || GIT_WRAPPER_FOLDER;
  const env = { ...(opts?.env || process.env) };
  const old = env.PATH;
  if (typeof old === "string" && old.split(path.delimiter)[0] === folder) return { ...opts, env };
  env.PATH = `${folder}${path.delimiter}${old || DEFAULT_SEARCH_PATH}`;
  return { ...opts, env };
}

/**
 * B's package caches that a child in B must INHERIT explicitly: the names from B_OWN_ENV that `env` carries — only in
 * production (the Dockerfile's backend stage sets them there), otherwise `[]`.
 * Consumer: connectors/codex.js — the Codex CLI passes a stdio MCP server only its standard names and `env_vars`; without
 * them an npx/uvx server of a Codex run in B would load from ~/.npm or ~/.cache/uv, the SHARED caches of the project
 * containers.
 */
export function bOwnInOps(env = process.env) {
  if (!opsMarker()) return [];
  return B_OWN_ENV.filter((k) => typeof env?.[k] === "string" && env[k] !== "");
}

// Cap of the caught-up group kill, read on every kill — tests change it.
export const IN_PROJECT_KILL_MS = 10_000;
const killCapMs = () => Number(process.env.CBASE_IN_PROJECT_KILL_MS) || IN_PROJECT_KILL_MS;
const KILL_TICK_MS = 50;
// Deadline of the escalation TERM → KILL (see the header, "THE ESCALATION") — the same as stopRun (runs/state.js), read on
// every TERM.
export const IN_PROJECT_ESCALATION_MS = 3_000;
const escalationMs = () => Number(process.env.CBASE_IN_PROJECT_ESCALATION_MS) || IN_PROJECT_ESCALATION_MS;
// The daemon's wording for an exec into a paused container (moby daemon/exec.go: "Container <id> is paused, unpause the
// container before exec") — the same as in projectbox/docker.js and runtime/git-run.js CONTAINER_PAUSED (this leaf never
// imports projectbox/). A group kill that gets it achieved nothing — and a look-back `kill -0` that gets it knows nothing
// about the group (see the header, "THE PAUSE BARRIER").
const IS_PAUSED = /is paused/i;

let seam = null;
export function setInProjectSeam(n) {
  if (n == null) { seam = null; return; }
  for (const f of ["kind", "program", "processLocation", "container"]) {
    if (typeof n[f] !== "function") throw new TypeError(`setInProjectSeam: ${f} is missing`);
  }
  if ((typeof n.frozen === "function") !== (typeof n.childAfterThaw === "function")) {
    throw new TypeError("setInProjectSeam: frozen and childAfterThaw only together");
  }
  seam = n;
}
const needSeam = () => {
  if (!seam) throw new Error("inProject: instance without a seam — server.js sets it at start (setInProjectSeam)");
  return seam;
};

/** The environment allowlist: `{ names, values }` — `names` for `-e NAME`, `values` for the docker child's environment. */
export function envAllowlist(env, always = []) {
  const base = process.env;
  const effective = env || base;
  const names = [];
  const take = (k) => {
    if (names.includes(k) || isBOwn(k)) return; // B's package caches never go into the project container
    if (!k || k.includes("=")) { console.warn(`[inProject] environment name "${k}" cannot be transported — dropped`); return; }
    names.push(k);
  };
  if (env && env !== base) {
    for (const [k, v] of Object.entries(env)) if (v !== undefined && base[k] !== v) take(k);
  }
  for (const k of ENV_TOGGLE) if (effective[k] !== undefined) take(k);
  for (const k of always || []) if (effective[k] !== undefined) take(k); // also without a difference from B (see the header)
  const values = {};
  for (const k of names) values[k] = String(effective[k]);
  return { names, values };
}

/** The call of a start in the project container, without starting it (for node-pty and tests). */
export function inProjectCall(inst, cmd, args = [], { cwd, env, tty = false, service = null, envAlways = [], envEmpty = [], asUser = "agent" } = {}) {
  const n = needSeam();
  if (!inst) throw new TypeError("inProjectCall: no instance");
  if (asUser !== "agent" && asUser !== "root") throw new TypeError(`inProject: asUser is "agent" or "root", not ${JSON.stringify(asUser)}`);
  // A service start needs its log file (the wrapper attaches stdout/stderr to it; without it the command would never run).
  if (service && !service.log) throw new TypeError("inProject: a service start needs service.log");
  const container = String(n.container(inst) || "");
  if (!container || container.startsWith("-")) throw new Error(`inProject: no container for ${inst.identifier || inst.projectId}`);
  const location = n.processLocation(inst);
  if (!location) throw new Error(`inProject: no runtime folder for ${inst.identifier || inst.projectId}`);
  // The wrapper creates no folders (the runtime folder belongs to the backend) — it must exist BEFORE the start.
  fs.mkdirSync(location, { recursive: true });
  const stem = path.join(location, crypto.randomUUID());
  const pgidFile = `${stem}.pgid`;
  const exitFile = service ? `${stem}.exit` : null;
  const empty = [];
  for (const k of envEmpty || []) {
    if (typeof k !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { console.warn(`[inProject] environment name "${k}" cannot be transported — dropped`); continue; }
    if (!empty.includes(k) && !isBOwn(k)) empty.push(k);
  }
  const white = envAllowlist(env, envAlways);
  const names = white.names.filter((k) => !empty.includes(k));
  const values = Object.fromEntries(names.map((k) => [k, white.values[k]]));
  const argv = [
    "exec", ...(service ? ["-d"] : ["-i", ...(tty ? ["-t"] : [])]), "-u", asUser,
    ...(cwd ? ["-w", String(cwd)] : []),
    ...names.flatMap((k) => ["-e", k]),
    ...empty.flatMap((k) => ["-e", `${k}=`]),
    container, wrapper(), "--pgid-file", pgidFile, ...(service ? ["--log", String(service.log), "--exit", exitFile] : []),
    "--", String(cmd), ...(args || []).map(String),
  ];
  return { program: n.program(), args: argv, env: { ...process.env, ...values }, container, pgidFile, identifier: inst.identifier || null, ...(asUser === "root" ? { asUser } : {}), ...(service ? { exitFile, log: String(service.log) } : {}) };
}

const signalName = (sig) => {
  if (typeof sig === "number") {
    const name = Object.entries(os.constants.signals).find(([, v]) => v === sig)?.[0];
    return name ? name.replace(/^SIG/, "") : String(sig);
  }
  return String(sig || "SIGTERM").replace(/^SIG/, "");
};

// The pgid file lives in `<runtime folder>/processes/`, which the project container mounts rw: a FIFO in its place would stall
// B's event loop with readFileSync (a kill waits for it on a tick until the cap), a symlink would make B read a file of B. So
// it is read only through the descriptor (real-path.js openFileWithoutReference): the folder `processes` within the runtime
// folder's area (the anchor — a mount point the container cannot replace; `processes` itself as a symlink does not count),
// the file O_NOFOLLOW|O_NONBLOCK and only as a regular file — otherwise "no pgid yet". Every caller has an instance.
const readPgid = (file) => {
  try {
    const location = path.dirname(path.resolve(file));
    const fd = openFileWithoutReference(file, realRoots([location], [path.dirname(location)]));
    let text;
    try { text = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
    const n = Number(text.trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch { return null; }
};

// Open catch-up kills (test seam: a test waits until none is open instead of waiting for a duration).
const catchingUp = new Set();
export const openCatchUpKills = () => catchingUp.size;
// Open escalations TERM → KILL (test seam as above): counted from the TERM to the group until the look-back ends — the group
// was empty, or the docker child of the KILL has closed (then the group HAS got it).
const escalating = new Set();
export const openEscalations = () => escalating.size;
// Group kills sent (test seam): counted AS SOON AS the kill's docker child is started — synchronously in `kill`, before the
// original kill. A test asks for the number right after the stop instead of waiting for a log entry that would never come
// if the group kill were missing (the failure would become a hang).
let sent = 0;
export const sentGroupsKills = () => sent;
// Open escalations whose deadline is already running (test seam): a TERM waiting at the barrier counts in openEscalations
// but not yet here — its deadline only begins on release.
export const runningEscalationDeadlines = () => [...escalating].filter((e) => e.tick).length;

// The kill control of ONE start: group kill now or caught up, escalation TERM → KILL, last look at the end, cleaning up the
// file. The seam is the one of the start (a later setInProjectSeam(null) of a test does not change it).
function killControl(call) {
  const n = needSeam();
  let waiting = null;     // { name, since, tick } — a kill before the pgid file exists
  let closed = false;        // the docker child (or the pty) is gone
  let pgid = null;       // read once, then in memory — the file may go, the group stays reachable
  let escalation = null; // { tick } — TERM sent, the look-back is pending
  let done = false;  // the group is provably empty or got KILL: no further group kill
  const knowPgid = () => pgid || (pgid = readPgid(call.pgidFile));
  const target = call.identifier || call.container;
  const groupsCall = (p, name) => ["exec", "-u", call.asUser === "root" ? "root" : "agent", call.container, "kill", `-${name}`, "--", `-${p}`];
  // A docker child for a group kill (or the look-back `-0`); `finished(code)` at the end (exit code, null on error or without
  // a verdict), `los()` every time the kill really goes to the daemon (at once, on the barrier's release, when caught up).
  // To a frozen container: behind the barrier; "is paused" ⇒ frozen: caught up once, otherwise `null` — never the daemon's
  // exit 1 as a verdict on the group (see the header, "THE PAUSE BARRIER").
  const start = (p, name, { finished = null, go = null, catchUp = true } = {}) => {
    const argv = groupsCall(p, name);
    const opts = { stdio: ["ignore", "ignore", "pipe"] };
    let k;
    try {
      k = n.frozen?.(call.container, { kill: true }) ? n.childAfterThaw(call.container, argv, opts) : n.kind(argv, opts);
    } catch (e) {
      console.warn(`[inProject] group kill ${name} to ${call.container} failed: ${e?.message || e}`);
      finished?.(null);
      return false;
    }
    if (name !== "0" && catchUp) sent += 1;
    if (k.barrier && !k.barrier.started) k.barrier.go?.then((allowed) => { if (allowed) go?.(); });
    else go?.();
    let err = "";
    k.stderr?.on("data", (d) => { if (err.length < 4096) err += d; });
    let once = false;
    const end = (code) => {
      if (once) return;
      once = true;
      if (code !== 0 && code !== null && IS_PAUSED.test(err)) {
        if (catchUp && n.frozen?.(call.container)) { start(p, name, { finished, go, catchUp: false }); return; }
        console.warn(`[inProject] group kill ${name} to ${call.container}: project container paused — no verdict on group ${p}`);
        finished?.(null);
        return;
      }
      finished?.(code);
    };
    k.on("error", (e) => { console.warn(`[inProject] group kill ${name} to ${call.container} failed: ${e?.message || e}`); end(null); });
    k.on("close", (code) => end(code));
    return true;
  };
  const removeFile = () => { try { fs.rmSync(call.pgidFile, { force: true }); } catch { /* does not matter */ } };
  // The file goes as soon as nothing depends on it any more: the docker child is gone, no kill waits for it, no look-back is
  // pending.
  const quietWaiters = new Set(); // see the header, "THE QUIET"
  const quiet = () => closed && !waiting && !escalation;
  const fileDone = () => {
    if (!quiet()) return;
    removeFile();
    for (const fn of [...quietWaiters]) fn();
    quietWaiters.clear();
  };
  const endEscalation = () => {
    if (!escalation) return;
    clearTimeout(escalation.tick);
    escalating.delete(escalation);
    escalation = null;
    fileDone();
  };
  // After the deadline: if the group is still alive (`kill -0`), it gets KILL. The look-back counts as open until the docker
  // child of the KILL has closed — a test waiting for zero open escalations then knows the group HAS it.
  // `gen`: the deadline the look-back belongs to — if it begins anew (the TERM was caught up), an older look-back no longer
  // counts (it could see the group before the caught-up TERM and send KILL without grace).
  const lookBack = (e, p, gen) => {
    if (escalation !== e || done || e.gen !== gen) return;
    start(p, "0", { finished: (code) => {
      if (escalation !== e || done || e.gen !== gen) return;
      // 1: no such group; null: no verdict (docker error, "is paused" without a barrier); otherwise a docker error
      if (code !== 0) { done = code === 1; endEscalation(); return; }
      console.warn(`[inProject] deadline of ${escalationMs()} ms after TERM reached: group ${p} in ${target} is alive — KILL ` +
        "(CBASE_IN_PROJECT_ESCALATION_MS)");
      done = true;
      if (!start(p, "KILL", { finished: () => { if (escalation === e) endEscalation(); } })) endEscalation();
    } });
  };
  // The escalation counts from the TERM on (openEscalations); its deadline only begins when the TERM goes out
  // (`deadlineFrom`) — and begins anew when it is caught up. If it never goes out (barrier cap, docker cannot start), it ends.
  const planeEscalation = (p) => {
    if (escalation || done) return null;
    const e = { tick: null, gen: 0 };
    escalation = e;
    escalating.add(e);
    return e;
  };
  const deadlineFrom = (e, p) => {
    if (escalation !== e || done) return;
    clearTimeout(e.tick);
    const gen = (e.gen = (e.gen || 0) + 1);
    e.tick = setTimeout(() => lookBack(e, p, gen), escalationMs());
    e.tick.unref?.(); // a test process ends anyway; the server lives on regardless
  };
  // A group kill to a known pgid — with its escalation (TERM) or the end of it (KILL).
  const hits = (p, name) => {
    if (done) return;
    if (name === "TERM") {
      const e = planeEscalation(p);
      start(p, name, e ? {
        go: () => deadlineFrom(e, p),
        finished: () => { if (escalation === e && !e.tick) endEscalation(); }, // the TERM never went out
      } : {});
      return;
    }
    start(p, name);
    if (name === "KILL") { done = true; endEscalation(); }
  };
  const endWait = () => {
    if (!waiting) return;
    clearInterval(waiting.tick);
    catchingUp.delete(waiting);
    waiting = null;
  };
  const checkBack = () => {
    if (!waiting) return true;
    const p = knowPgid();
    if (p) {
      const name = waiting.name;
      endWait();
      hits(p, name);
      fileDone();
      return true;
    }
    if (Date.now() - waiting.since >= killCapMs()) {
      console.warn(`[inProject] cap of ${killCapMs()} ms reached: no pgid file for ${target} — ` +
        `the group kill ${waiting.name} is skipped, a command in the project container may keep running`);
      endWait();
      fileDone(); // the quiet: after the cap nothing waits any more
      return true;
    }
    return false;
  };
  return {
    // The group of the started process in the container (from the pgid file, read once) — for a terminal that of the shell;
    // null while the wrapper has not written it yet. Read-only.
    pgid: () => knowPgid() || null,
    kill(sig) {
      const name = signalName(sig);
      const p = knowPgid();
      if (p) { hits(p, name); return; }
      // After the end without a pgid there is nothing left to hit: the start never got going or is finished (on `close`
      // without an open kill the file goes). A kill that came BEFORE the end keeps looking (see closed()).
      if (closed) return;
      if (waiting) { waiting.name = name; return; } // the last signal wins (TERM, then KILL)
      waiting = { name, since: Date.now(), tick: null };
      waiting.tick = setInterval(checkBack, KILL_TICK_MS);
      catchingUp.add(waiting);
    },
    // The docker child is gone: one last look; without an open kill and without a pending escalation the file is done.
    // With an open kill and without a file the tick keeps looking (a killed exec caller does not end the start in the
    // container — the wrapper may still write the file), up to the cap. A pending escalation continues: the end of the
    // docker child says nothing about the group.
    closed() {
      closed = true;
      if (waiting && !checkBack()) return;
      fileDone();
    },
    // see the header, "THE QUIET"
    afterQuiet() {
      if (quiet()) return Promise.resolve();
      return new Promise((resolve) => quietWaiters.add(resolve));
    },
  };
}

/** The group kill for a call someone else started (node-pty). Returns the control. */
export function inProjectKill(call) {
  needSeam();
  return killControl(call);
}

/**
 * Start in the project container of instance `inst` — without an instance exactly `spawn(cmd, args, opts)`.
 * @param {object|null} inst  the instance as it travels (mapped row of store/project-instances.js)
 */
export function inProject(inst, cmd, args, opts) {
  if (!inst) return spawn(cmd, args, withGitWrapperFront(opts));
  const { cwd, env, service, envAlways, envEmpty, asUser, ...rest } = opts || {};
  const call = inProjectCall(inst, cmd, args, { cwd, env, service, envAlways, envEmpty, ...(asUser !== undefined ? { asUser } : {}) });
  // The docker child runs in B: its cwd does not matter (the working folder goes as -w), its environment carries the values.
  // A frozen container ⇒ the same child, which only starts after the thaw (see the header, "THE PAUSE BARRIER").
  const kind = seam.frozen?.(call.container)
    ? seam.childAfterThaw(call.container, call.args, { ...rest, env: call.env })
    : seam.kind(call.args, { ...rest, env: call.env });
  // A detached service (see the header, "THE SERVICE") — no kill control, the child ends right after the start.
  if (service) {
    kind.inProject = { identifier: call.identifier, container: call.container, pgidFile: call.pgidFile, exitFile: call.exitFile, log: call.log };
    return kind;
  }
  const control = killControl(call);
  const original = kind.kill.bind(kind);
  kind.kill = (sig) => {
    // Before the barrier's release nothing ran in the container — only the waiting shell ends.
    if (kind.barrier && !kind.barrier.started) { kind.barrier.abort(); return original(sig); }
    control.kill(sig);
    return original(sig);
  };
  kind.once("close", () => control.closed());
  kind.inProject = { identifier: call.identifier, container: call.container, pgidFile: call.pgidFile, afterQuiet: () => control.afterQuiet() };
  return kind;
}
