// The ONE starter of the management git. A leaf under `runtime/`: imports only `./inProject.js` (itself only node:*) — the
// instance comes as an object from the caller, never from the store.
//
// "Everything in the container": after the relocation the project container can write hooks, `core.fsmonitor`, filters, merge
// drivers, `textconv` and `submodule.<n>.update=!cmd` in every code repo and in the project repo. A git of the backend in B
// would execute them in B. So EVERY management git of a converted project goes through here:
//
//   gitRun(null, cwd, args, { fallback })      WITHOUT an instance the result is EXACTLY `fallback()` — the calling file's
//                                               own starter, unchanged (the same argv, environment, cap and error shape).
//                                               Without `fallback` it THROWS (empty is not unknown: a caller without a
//                                               fallback is a build error, not "then somehow in B").
//   gitRun(inst, cwd, args, { timeout, stdin, env, maxBuffer })
//                                               WITH an instance via inProject (`git` with `{ cwd, env }`) as agent in the
//                                               project container, `GIT_TERMINAL_PROMPT=0`; the environment via inProject's
//                                               allowlist (only names in argv, the values in the docker child's environment).
//                                               → promise `{ code, signal, stdout, stderr, cap }` — does NOT throw on an
//                                               exit ≠ 0; the calling file reshapes the result into the shape of its fallback
//                                               (git.js, okf.js, projectbox/projectRepo.js).
//   commandRun(inst, cwd, cmd, args, opts)      the same for another command (the project repo's search in the container,
//                                               the git view's read bundle as `sh -c`) — only WITH an instance.
//   `stdin`: text/Buffer (written and closed) or a readable stream — piped via providers/kind-stdin.js streamIntoStdin (the
//   tar of a copy, never entirely in memory); if the start fails, it is destroyed.
//
// CAPS. `timeout` (default GIT_RUN_CAP_MS) and `maxBuffer` (default OUTPUT_CAP) are caps that report themselves: at the end
// `stderr` says that one hit, and `cap` says which ("deadline" | "output"). The deadline only counts from the release of the
// pause barrier: waiting for the thaw has its own cap. Ending goes through the in-project child's `.kill` — group kill in the
// container with escalation TERM → KILL (runtime/inProject.js); a killed `docker exec` alone would not end the git in the
// container.
// NO DEADLINE, ABORT, ROOT:
//   `withoutDeadline: true`   no timer — for content (clone, unpack, insert, code repos, creation commit, `du`, `rm -rf`) that
//                       must not have a time cap; a missing or 0 `timeout` stays the default of 120 s (a missing field is no
//                       statement). The output cap stays (a counting cap that reports itself).
//   `signal`            an AbortSignal: on abort TERM goes to the in-project child (group kill in the container with
//                       escalation); the result carries `aborted: true` and `code: null`. An already aborted signal starts
//                       nothing.
//   `asUser: "root"`    commandRun only: the command runs as root in the container (`-u root`, and so does its group kill) —
//                       only for the root steps after a path check in the container (root-owned data folders of inner
//                       containers); every caller is listed with a reason in
//                       server/backend/test/in-project-start-places.test.js. Default: agent.
//
// THE ACCESS. Network commands (pull, fetch, push) run entirely in the container, including all hooks. The workspace's stored
// git access goes along ONLY as environment (`accessAsEnvironment`), and ONLY IN LIST FORM `[{ host, access }]`: the
// configuration from the environment (`GIT_CONFIG_COUNT`) first empties the inherited helper list (`credential.helper=` — in
// B that is the helper of VS Code Remote Containers, in the project container the LFS helper of the agent shells), sets
// `credential.useHttpPath=false` and `http.followRedirects=false`, then per host `credential.https://<host[:port]>.helper` —
// a helper made of variable names WITH AN INDEX (`CBASE_GIT_USERNAME_<i>`/`CBASE_GIT_PASSWORD_<i>`), each token ONLY to its
// host. There is no hostless helper with a value: git fetches submodules `on-demand` during fetch and would otherwise offer
// the token to every submodule host that answers 401 — a foreign `.gitmodules` pointing to a prepared host would suffice. The
// host carries its port (`git.example.com:8443`): git compares it when matching, a helper without the port would never apply
// to `:8443`. Only `https`: an `http://` remote gets no access. The helper's text contains no value, and no value ever
// appears in an argv. Accepted deliberately: during a network command the access is readable for every process of the
// project as agent (`/proc/<pid>/environ`). The helper writes with `printf` and quotes instead of a bare `echo`: under dash
// `echo` interprets backslashes, and without quotes a token's spaces and asterisks would fall apart.
// THE REJECTION: a helper that gives the same wrong access to EVERY question makes git-lfs loop endlessly against an endpoint
// answering 401 (git-lfs asks again after every `git credential reject`, and the helper answers again). So every entry carries
// a MARKER `CBASE_GIT_REJECTED_<i>` — a fresh random path under `/tmp` of the place where git runs (the project container:
// every caller of accessAsEnvironment has an instance; without an instance the access goes in B via GIT_ASKPASS, git.js
// authEnv). The helper only answers `get`, and only while the marker is missing; `erase` creates it, `store` does nothing. The
// marker is empty, its path is no secret. git itself gets no worse: it calls `erase` only after a 401 with this access and
// then ends anyway. If the run fails, gitRun removes the markers in the container (`rm -f --`, errors do not count); a
// successful run created none, unless a part was rejected and the rest went through — then an empty file with a random name
// stays in the container's `/tmp`.
// EMPTY VALUES IN ARGV: the emptying itself (`GIT_CONFIG_VALUE_0=""`) goes as `-e GIT_CONFIG_VALUE_0=` in argv, not via the
// docker child's environment (commandRun → inProject `envEmpty`). Two reasons: whether the docker CLI passes an EMPTY value
// from its environment is not measured; and if B already carries the same empty value, the allowlist would drop the name (it
// transports only differences) — in the container GIT_CONFIG_VALUE_0 would be missing with GIT_CONFIG_COUNT=2, and git would
// abort. An empty value is no secret; the access values stay EXCLUSIVELY in the environment (`EMPTY_IN_ARGV` matches only
// `GIT_CONFIG_VALUE_<n>` with the value "").
//
// Guard: server/backend/test/projectbox-git.test.js; the start place is listed in
// server/backend/test/in-project-start-places.test.js.
import crypto from "node:crypto";

import { inProject } from "./inProject.js";
import { writeStdin, streamIntoStdin } from "../providers/kind-stdin.js";

export const GIT_RUN_CAP_MS = 120_000;
export const OUTPUT_CAP = 16 * 1024 * 1024;

// READING WITHOUT PROGRAMS FROM THE REPO. Measured with git 2.50.1 on a repo whose configuration points to scripts that write a
// marker (re-run in the guard server/backend/test/git-read-paths.test.js):
//   status                     core.fsmonitor AND the hook post-index-change (status writes the index opportunistically), plus
//                              the clean/process filter of a file with `filter=` whose stat data changed (same size ⇒ git
//                              reads the content; see below)
//   diff (working tree)        core.fsmonitor, diff.external, diff.<driver>.command (and the clean filter, see below)
//   diff --cached, ls-files,   core.fsmonitor
//   check-attr, check-ignore,
//   diff-tree (also -r -M)     core.fsmonitor
//   log -p, show               diff.<driver>.textconv
//   log, show (any form)       gpg.program, gpg.ssh.program, gpg.x509.program via `log.showSignature=true` on every signed
//                              commit — `-c log.showSignature=false` turns it off for all three programs
//   blame                      core.fsmonitor, diff.<driver>.textconv
//   rev-parse, rev-list, symbolic-ref, ls-tree, cat-file, stash list: nothing
// The read paths of the editor and the explorer (status, diff, diff content, timeline/log, show, ignored, blame) therefore
// carry `READ_TOGGLE` before exactly these subcommands and `--no-ext-diff`/`--no-textconv` after them — `readingArgs` computes
// it, ONE rule for the path in B (git.js gitInB) and in the project container (gitRun with an instance, the git view's read
// bundle). A writing subcommand (commit, add, checkout, merge, …) stays as it is: the user WANTS its hooks (pre-commit,
// post-checkout), as in VS Code — with an instance they run in the container. Without textconv and external diff a diff shows
// the content raw, like VS Code's diff editor (it reads the sides via `git show`/`cat-file` and compares itself). NOT turned
// off, as in VS Code (the git extension calls status and diff with filters): the clean/process filter that `git status` and
// `git diff` call for a changed file with `filter=` in the working tree — without it status would report every LFS file as
// changed (the index holds the pointer, the working tree the content), a wrong state. Without an instance it runs in B, with
// an instance in the project container. `config` reads none of this and stays unchanged. The file search calls no git.
export const READ_TOGGLE = Object.freeze(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false"]);
const READ_VALUES = READ_TOGGLE.filter((_, i) => i % 2 === 1);
const WITHOUT_DIFF_PROGRAM = Object.freeze(["--no-ext-diff", "--no-textconv"]);
const READ_ADDITION = Object.freeze({
  status: [], "ls-files": [], "check-attr": [], "check-ignore": [],
  blame: ["--no-textconv"], diff: WITHOUT_DIFF_PROGRAM, show: WITHOUT_DIFF_PROGRAM, log: WITHOUT_DIFF_PROGRAM, "diff-tree": WITHOUT_DIFF_PROGRAM,
  // `stash show -p` (the diff of a stash source) is a diff; the subcommand is one position further.
  "stash show": WITHOUT_DIFF_PROGRAM,
});
/** The arguments of a git call with the switches of the read paths (see above) — any other subcommand stays the same array.
 *  Global options before the subcommand (`-c k=v`, `-C dir`, `--literal-pathspecs` …) stay; if they already carry all
 *  switches (git.js WITHOUT_REPO_PROGRAMS), the prefix is not doubled, and neither is a switch the call already carries (the
 *  hardened diffs, git.js WITHOUT_PROGRAM). */
export function readingArgs(args) {
  if (!Array.isArray(args)) return args;
  let i = 0;
  while (i < args.length && typeof args[i] === "string" && args[i].startsWith("-")) i += args[i] === "-c" || args[i] === "-C" ? 2 : 1;
  const two = args[i] === "stash" && args[i + 1] === "show";
  const name = two ? "stash show" : args[i];
  const addition = typeof name === "string" && Object.hasOwn(READ_ADDITION, name) ? READ_ADDITION[name] : null;
  if (!addition) return args;
  const front = args.slice(0, i), end = i + (two ? 2 : 1), rest = args.slice(end);
  const alreadyThere = READ_VALUES.every((w) => front.includes(w));
  return [...(alreadyThere ? [] : READ_TOGGLE), ...front, ...args.slice(i, end), ...addition.filter((z) => !rest.includes(z)), ...rest];
}

/** The same switches for an `sh -c` bundle that calls git by name — the git overview (gitView/read.js READ_SCRIPT,
 *  gitView/detail.js HEADER_SCRIPT): a shell function `git` as the FIRST line of the script that prepends `READ_TOGGLE` to
 *  every call; also in `$(…)` and pipes, which inherit the function. The bundles only read (for-each-ref, rev-list, log
 *  without patch, status, merge-base, worktree list, config --get, reflog, diff); a switch before EVERY call changes no output
 *  there. `--no-ext-diff --no-textconv` are on the one diff of these bundles itself (detail.js DIFF_SCRIPT, `--numstat` in
 *  DETAIL_SCRIPT) — no other call has a patch. Measured (git 2.50.1, guard server/backend/test/git-read-paths.test.js): without
 *  the function the read calls `core.fsmonitor` (`status` per worktree; GIT_OPTIONAL_LOCKS=0 already keeps the hook
 *  `post-index-change` away there) and `gpg.program` (`log -1` at the merge base), the detail `gpg.program` (`log` of the
 *  commits ahead on a signed commit). */
export const READ_SH = `git() { command git ${READ_TOGGLE.map((w) => `'${w}'`).join(" ")} "$@"; }`;

// A host's helper from the environment: only variable names with an index, no value (see the header). git appends the action
// ("f get"). `get` only answers while the marker `CBASE_GIT_REJECTED_<i>` is missing (see the header, "THE REJECTION"; without
// a marker in the environment: always), `erase` creates it, `store` does nothing. POSIX sh, no value in argv.
export const gitHelper = (i) => `!f() { case "$1" in get) [ -n "$CBASE_GIT_REJECTED_${i}" ] && [ -e "$CBASE_GIT_REJECTED_${i}" ] || printf 'username=%s\\npassword=%s\\n' "$CBASE_GIT_USERNAME_${i}" "$CBASE_GIT_PASSWORD_${i}";; erase) [ -z "$CBASE_GIT_REJECTED_${i}" ] || : > "$CBASE_GIT_REJECTED_${i}";; esac; }; f`;
// The markers of an environment from accessAsEnvironment (see the header, "THE REJECTION") — the paths, nothing else.
export const MARKER_NAME = /^CBASE_GIT_REJECTED_\d+$/;
export const accessMarkers = (env) => Object.entries(env || {}).filter(([k, v]) => MARKER_NAME.test(k) && typeof v === "string" && v).map(([, v]) => v);

// A host of an access: `hostname[:port]`, lower-case (that is how accesses are stored, store/workspaces.js). Whatever does not
// match gets no helper — its text would otherwise end up in the key of a configuration.
export const HOST_WITH_PORT = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
const hostOf = (h) => {
  const x = String(h ?? "").trim().toLowerCase();
  return HOST_WITH_PORT.test(x) ? x : null;
};

/**
 * The environment of a network command in the container — ONLY in list form `[{ host, access: { username, secret } }]`. `{}`
 * if no entry carries a valid host and a user (then git asks nobody, as without access). Any form other than a list THROWS: a
 * helper without a host is a build error, not "then for every host" (see the header, "THE ACCESS"). `markersLocation`: the
 * `/tmp` of the place where git runs (see the header, "THE REJECTION").
 */
export function accessAsEnvironment(list, { markersLocation = "/tmp" } = {}) {
  if (list == null) return {};
  if (!Array.isArray(list)) throw new TypeError("accessAsEnvironment: list form [{ host, access }] only — there is no helper without a host");
  const entries = [];
  for (const e of list) {
    if (!e?.access?.username) continue;
    const host = hostOf(e.host);
    if (!host) { console.warn(`[git-run] access without a valid host (${JSON.stringify(String(e.host ?? "").slice(0, 80))}) — no helper`); continue; }
    if (entries.some((x) => x.host === host)) continue; // the same host once: the first wins
    entries.push({ host, access: e.access });
  }
  if (!entries.length) return {};
  const config = [["credential.helper", ""], ["credential.useHttpPath", "false"], ["http.followRedirects", "false"]];
  entries.forEach((e, i) => config.push([`credential.https://${e.host}.helper`, gitHelper(i)]));
  const env = { GIT_CONFIG_COUNT: String(config.length) };
  config.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  const run = crypto.randomBytes(12).toString("hex"); // fresh per call — an old marker never hits a new run
  const location = String(markersLocation || "/tmp").replace(/\/+$/, "") || "/tmp";
  entries.forEach((e, i) => {
    env[`CBASE_GIT_USERNAME_${i}`] = String(e.access.username);
    env[`CBASE_GIT_PASSWORD_${i}`] = String(e.access.secret || "");
    env[`CBASE_GIT_REJECTED_${i}`] = `${location}/cbase-git-rejected-${run}-${i}`;
  });
  return env;
}

// Is the project container down (stopped or gone)? The docker CLI's answer to an `exec` — ONE place for the pattern: the git
// view then wakes the instance (devtools/code-route.js), cleaning up a worktree enters its job into the post-work
// (runs/git-post-work.js). Plus the state in which the daemon rejects an `exec` although the container is not "stopped"
// (wording from moby daemon/exec.go): "Container <id> is restarting, wait until the container is running" (project containers
// run with `--restart unless-stopped`, a restart loop is possible).
// "is paused" does NOT mean "down" but "wait" — a paused container is frozen (code snapshot of a copy), it will continue
// shortly. Whoever reads "down" wakes (the git view via the recovery) or reports an error; both would be wrong for a pause —
// the waker would send `docker start` to a paused container. Hence the separate pattern CONTAINER_PAUSED; whoever means both
// (the worktree post-work: the job waits in both cases) asks both. A pause that cbase itself holds is never seen here:
// inProject waits at the barrier before (projectbox/docker.js).
export const CONTAINER_STANDS = /is not running|No such container|is restarting/i;
export const CONTAINER_PAUSED = /is paused/i;
/** A result of commandRun/gitRun that only says: the container was not running. */
export const containerStands = (r) => Boolean(r) && r.code !== 0 && CONTAINER_STANDS.test(String(r.stderr || ""));
/** A result that only says: the container is frozen (wait, do not wake). */
export const containerPaused = (r) => Boolean(r) && r.code !== 0 && CONTAINER_PAUSED.test(String(r.stderr || ""));

// Which environment names go along WITH AN EMPTY VALUE in argv (see the header): only `GIT_CONFIG_VALUE_<n>` with "".
export const EMPTY_IN_ARGV = /^GIT_CONFIG_VALUE_\d+$/;
/** Splits an environment: `{ env }` without the empty-valued names matching EMPTY_IN_ARGV, `envEmpty` = these names (for `-e NAME=`). */
export function emptyIntoTheArgv(env) {
  if (!env) return { env, envEmpty: [] };
  const rest = {};
  const envEmpty = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === "" && EMPTY_IN_ARGV.test(k)) envEmpty.push(k);
    else rest[k] = v;
  }
  return { env: rest, envEmpty };
}

// Test seam: how many deadlines of commandRun are running right now — a command at the pause barrier has none yet. That is
// how the guard proves "the deadline only begins on release" without a clock.
let runningDeadlines = 0;
export const runningCommandDeadlines = () => runningDeadlines;

// Which commands are running IN the container right now, per container (the name or id as containerOf returns it —
// `kind.inProject.container`). A command counts from the moment it begins in the container (without a barrier at the start,
// otherwise on release — a command at the barrier is not running yet) until its end. The freeze of a copy
// (stacks/freeze.js) uses this to wait BEFORE the `pause` of the main instance until no management git runs there any more
// (the barrier is already closed then; a new command waits for the release and does not count). Chosen over "stopping the
// deadline": a git that gets frozen would hold `index.lock` and half-written files — the snapshot would see them. The waiting
// itself has a cap at the caller.
// "Until its end" means until the QUIET of its kill control (runtime/inProject.js `kind.inProject.afterQuiet`), not until the
// docker CLI's `close`: after a kill (deadline, output cap) the CLI ends at once, the command in the container only with the
// escalation TERM → KILL. Otherwise it would no longer count, and `pause` would freeze it.
//   runningCommandsIn(container)  → count (also a test seam: a guard waits for it instead of a duration)
//   commandsPast(container)       → promise, fulfilled as soon as none runs there any more (at once if none runs);
//                                   `.abort()` on the return value takes the waiting back (the caller's cap)
//   waitingForCommands(container) → how many commandsPast are still waiting there (test seam)
const runningIn = new Map(); // container → count
const emptyWaiters = new Map(); // container → Set<fn>
export const runningCommandsIn = (container) => runningIn.get(String(container || "")) || 0;
export const waitingForCommands = (container) => emptyWaiters.get(String(container || ""))?.size || 0;
export function commandsPast(container) {
  const c = String(container || "");
  let detach = () => {};
  const p = new Promise((resolve) => {
    if (!runningCommandsIn(c)) { resolve(); return; }
    const fn = () => resolve();
    if (!emptyWaiters.has(c)) emptyWaiters.set(c, new Set());
    emptyWaiters.get(c).add(fn);
    detach = () => { emptyWaiters.get(c)?.delete(fn); resolve(); };
  });
  p.abort = () => detach();
  return p;
}
function commandBegins(container) {
  if (!container) return;
  runningIn.set(container, runningCommandsIn(container) + 1);
}
function commandEnds(container) {
  if (!container) return;
  const n = runningCommandsIn(container) - 1;
  if (n > 0) { runningIn.set(container, n); return; }
  runningIn.delete(container);
  const w = emptyWaiters.get(container);
  emptyWaiters.delete(container);
  for (const fn of w || []) fn();
}

/** A command in the instance's project container, evaluated — see the header. Only WITH an instance. `envAlways`: names that
 *  go along even without a difference from B (runtime/inProject.js). `withoutDeadline`, `signal`, `asUser`: see the header. */
export function commandRun(inst, cwd, cmd, args, { timeout, stdin, env: envRaw, maxBuffer, envAlways, withoutDeadline = false, signal = null, asUser } = {}) {
  if (!inst) return Promise.reject(new TypeError("commandRun: without an instance there is no project container"));
  if (asUser !== undefined && asUser !== "agent" && asUser !== "root") return Promise.reject(new TypeError(`commandRun: asUser is "agent" or "root", not ${JSON.stringify(asUser)}`));
  if (signal != null && typeof signal.aborted !== "boolean") return Promise.reject(new TypeError("commandRun: signal must be an AbortSignal"));
  const { env, envEmpty } = emptyIntoTheArgv(envRaw); // see the header, "EMPTY VALUES IN ARGV"
  // `withoutDeadline: true` means NO timer; a missing or 0 `timeout` stays the default.
  const deadline = withoutDeadline === true ? null : Number(timeout) > 0 ? Number(timeout) : GIT_RUN_CAP_MS;
  // An already aborted signal starts nothing ("cancel" before the start).
  if (signal?.aborted) {
    if (typeof stdin?.pipe === "function") stdin.destroy();
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: `${cmd} in project container ${inst.identifier || inst.projectId || "?"}: aborted before it began (runtime/git-run.js)`, cap: null, aborted: true });
  }
  const limit = Number(maxBuffer) > 0 ? Number(maxBuffer) : OUTPUT_CAP;
  const who = inst.identifier || inst.projectId || "?";
  return new Promise((resolve, reject) => {
    let kind;
    try {
      kind = inProject(inst, cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : undefined,
        ...(envAlways?.length ? { envAlways } : {}),
        ...(envEmpty.length ? { envEmpty } : {}),
        ...(asUser === "root" ? { asUser: "root" } : {}),
        stdio: [stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) { if (typeof stdin?.pipe === "function") stdin.destroy(); reject(e); return; } // without seam, container or ops marker: fail visibly (inProject throws)
    const out = []; const err = [];
    let set = 0;
    let cap = null;
    let aborted = false;
    let finished = false;
    const end = (reason) => {
      if (cap || aborted) return;
      cap = reason;
      try { kind.kill("SIGTERM"); } catch { /* already gone */ }
    };
    // The manual abort — TERM to the in-project child (group in the container with escalation), not a cap.
    const abort = () => {
      if (finished || cap || aborted) return;
      aborted = true;
      try { kind.kill("SIGTERM"); } catch { /* already gone */ }
    };
    signal?.addEventListener?.("abort", abort, { once: true });
    const take = (target) => (d) => {
      set += d.length;
      if (set > limit) { end("output"); return; }
      target.push(d);
    };
    kind.stdout?.on("data", take(out));
    kind.stderr?.on("data", take(err));
    // The deadline applies to the COMMAND: if the project container is frozen, the child waits at the pause barrier
    // (runtime/inProject.js, projectbox/docker.js dockerChildAfterThaw) — that waiting has its own cap with a message
    // (CBASE_PAUSE_CAP_MS), and the deadline only begins on release. Counted from the start, a git in a 30 s pause would end
    // as "cap reached" with no sign of the pause instead of delivering after the thaw.
    let tick = null;
    const location = String(kind.inProject?.container || "");
    let inContainer = false; // counts in runningCommandsIn, see there
    const deadlineStart = () => {
      if (finished || tick || inContainer) return;
      if (deadline !== null) { // without a deadline no timer — the command still counts as running
        tick = setTimeout(() => end("deadline"), deadline);
        tick.unref?.();
        runningDeadlines += 1;
      }
      inContainer = true;
      commandBegins(location);
    };
    if (kind.barrier && !kind.barrier.started && kind.barrier.go) kind.barrier.go.then((allowed) => { if (allowed) deadlineStart(); });
    else deadlineStart();
    const end2 = (code, sig, error) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener?.("abort", abort);
      if (tick) { clearTimeout(tick); runningDeadlines -= 1; }
      if (inContainer) {
        // Until the group in the container is provably gone (see runningCommandsIn above).
        const quiet = kind.inProject?.afterQuiet?.();
        if (quiet) quiet.then(() => commandEnds(location), () => commandEnds(location));
        else commandEnds(location);
      }
      let stderr = Buffer.concat(err).toString("utf8");
      if (error) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${error}`;
      if (cap === "deadline") stderr += `\n${cmd} in project container ${who}: cap of ${deadline / 1000} s reached — ended (runtime/git-run.js)`;
      if (cap === "output") stderr += `\n${cmd} in project container ${who}: output cap (${limit} bytes) reached — ended (runtime/git-run.js)`;
      if (aborted) stderr += `\n${cmd} in project container ${who}: aborted (runtime/git-run.js)`;
      resolve({ code: cap || aborted ? null : code, signal: sig || null, stdout: Buffer.concat(out).toString("utf8"), stderr, cap, ...(aborted ? { aborted: true } : {}) });
    };
    kind.once("error", (e) => end2(null, null, `docker: ${e?.message || e}`));
    kind.once("close", (code, sig) => end2(code, sig, null));
    // Via providers/kind-stdin.js (guard server/backend/test/stdin-epipe.test.js): if the child dies before it reads, the
    // EPIPE would otherwise be an unhandled exception in the server process.
    // A readable stream (the tar of a copy) goes through streamIntoStdin — never entirely in memory.
    if (typeof stdin?.pipe === "function") streamIntoStdin(kind, stdin);
    else if (stdin != null && kind.stdin) writeStdin(kind, stdin, { close: true });
  });
}

/** The ONE starter of the management git — see the header. `withoutDeadline`/`signal` as in commandRun; git never runs as
 *  root. `envAlways`: further names that go along even without a difference from B (`GIT_LFS_SKIP_SMUDGE` of the clone — B
 *  does not carry it, the project container's image does; a switch that must arrive must not depend on the allowlist). */
export function gitRun(inst, cwd, args, { timeout, stdin, env, maxBuffer, fallback, withoutDeadline, signal, envAlways } = {}) {
  if (!inst) {
    if (typeof fallback !== "function") throw new TypeError("gitRun without an instance: the calling file's own starter is missing (fallback)");
    return fallback();
  }
  // GIT_TERMINAL_PROMPT ALWAYS goes along: if B already carries 0, the value would not differ and the allowlist would drop it
  // — in the container it would be unset, and a git without access would prompt on the terminal.
  const always = ["GIT_TERMINAL_PROMPT", ...(Array.isArray(envAlways) ? envAlways.filter((k) => k !== "GIT_TERMINAL_PROMPT") : [])];
  const run = commandRun(inst, cwd, "git", args, { timeout, stdin, maxBuffer, env: { GIT_TERMINAL_PROMPT: "0", ...(env || {}) }, envAlways: always, ...(withoutDeadline ? { withoutDeadline: true } : {}), ...(signal ? { signal } : {}) });
  // The rejection markers (see the header, "THE REJECTION"): removed in the container after a failed run — errors do not count.
  const markers = accessMarkers(env);
  if (!markers.length) return run;
  return run.then(async (r) => {
    if (r.code !== 0) await commandRun(inst, "/", "rm", ["-f", "--", ...markers]).catch(() => null);
    return r;
  });
}

// ── Hosts and LFS ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Three building blocks on top of gitRun, the last two only WITH an instance (they read or fetch in the project container):
//   hostFromAddress(url)  the host of an address as the key of a helper — `host[:port]` lower-case (HOST_WITH_PORT) for
//                         https; for ssh/scp only the name: git-lfs derives https to THE SAME host from an ssh address, and
//                         an ssh port is not an https port. Everything else (http, file, relative, broken,
//                         `<helper>::<address>`): null — an access never goes there. `ext::sh -c x` looks like scp (`ext` as
//                         host); git reads `::` BEFORE the scp form as a remote helper (transport.c), so the same here.
//   networkHosts(inst, cwd, { submodule, lfs, front, signal })
//                         the hosts a repo talks to: every `remote.<n>.url`/`pushurl`/`lfsurl`/`lfspushurl` and `lfs.url`/
//                         `lfs.pushurl`, with `submodule: true` also `submodule.<n>.url` from the local configuration and
//                         from `.gitmodules`, with `lfs: true` also `lfs.url`/`lfs.pushurl` and `remote.<n>.lfsurl`/
//                         `lfspushurl` from `.lfsconfig` (the endpoints the repo brings along — git-lfs reads exactly these
//                         there). Relative addresses (`../x.git`) resolve against the remote — its host is already listed.
//                         The hosts are only the SELECTION of accesses (each token goes only to its host anyway,
//                         accessAsEnvironment), not a verdict: what could not be read is missing. No deadline.
//   lfsFetch(inst, cwd, { env, front, signal })
//                         `git lfs ls-files -n` first — a repo without an LFS file is done at once (`{ ok, fetched: false }`).
//                         A container without git-lfs is named (`withoutLfs: true`): `ok` if no file carries the attribute
//                         `filter=lfs` (`git ls-files -- ':(attr:filter=lfs)'`, git itself), otherwise not — pointers would
//                         stay —, then `git lfs pull` with `env` (the access in list form) and `GIT_LFS_SKIP_SMUDGE=0` (so
//                         the pull fetches even if the image default `=1` would hold it back), with NO deadline (content).
//                         Does not throw: `{ ok, fetched, code, stderr, withoutLfs?, aborted? }`.
// `front`: arguments before the subcommand (the hardening of the setup, projectbox/projectRepo.js — runtime/ never imports
// projectbox/).
/** The host of an address as the key of a helper (see above) — or null. */
export function hostFromAddress(url) {
  const s = String(url ?? "").trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol === "https:") return hostOf(u.host); // without the default port 443 (URL normalises, so does git)
    if (/^(ssh|git\+ssh|ssh\+git):$/i.test(u.protocol)) return hostOf(u.hostname);
    return null;
  }
  if (/^[a-z0-9][a-z0-9+.-]*::/i.test(s)) return null; // `<helper>::<address>` — a remote helper, not a host (see above)
  const m = s.match(/^(?:[^@/:]+@)?([^/:@[\]]+):(?!\/)/); // scp-like `[user@]host:path` (a local path has no "host:")
  return m ? hostOf(m[1]) : null;
}

/** The hosts a repo talks to (see above) — `["host[:port]"]`, without duplicates. Only WITH an instance. `lfs: true` also
 *  reads the LFS endpoints from `.lfsconfig` (the endpoint the repo itself brings along — a host other than its remote needs
 *  its own access). */
export async function networkHosts(inst, cwd, { submodule = false, lfs = false, front = [], signal = null } = {}) {
  const hosts = [];
  const read = async (args) => {
    const r = await gitRun(inst, cwd, [...front, "config", "-z", ...args], { withoutDeadline: true, ...(signal ? { signal } : {}) });
    if (r.code !== 0) return; // 1: no key (the normal case without submodules); anything else: no verdict
    for (const entry of String(r.stdout || "").split("\0")) {
      const i = entry.indexOf("\n"); // -z: "key\nvalue\0"
      const h = i < 0 ? null : hostFromAddress(entry.slice(i + 1));
      if (h && !hosts.includes(h)) hosts.push(h);
    }
  };
  await read(["--get-regexp", "^(remote\\..*\\.(url|pushurl|lfsurl|lfspushurl)|lfs\\.(url|pushurl))$"]);
  if (submodule) {
    await read(["--local", "--get-regexp", "^submodule\\..*\\.url$"]);
    await read(["--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.url$"]);
  }
  if (lfs) await read(["--file", ".lfsconfig", "--get-regexp", "^(lfs\\.(url|pushurl)|remote\\..*\\.(lfsurl|lfspushurl))$"]);
  return hosts;
}

/** Fetch a repo's LFS files (see above). Only WITH an instance; does not throw. */
export async function lfsFetch(inst, cwd, { env = {}, front = [], signal = null } = {}) {
  const including = { withoutDeadline: true, ...(signal ? { signal } : {}) };
  const ls = await gitRun(inst, cwd, [...front, "lfs", "ls-files", "-n"], including);
  if (ls.aborted) return { ok: false, fetched: false, code: null, stderr: ls.stderr, aborted: true };
  if (ls.code !== 0) {
    if (!/'lfs' is not a git command/.test(String(ls.stderr || ""))) return { ok: false, fetched: false, code: ls.code, stderr: ls.stderr };
    // Without git-lfs: does the repo carry LFS files at all? git itself reads the attribute `filter=lfs` (pathspec `attr:`).
    const attr = await gitRun(inst, cwd, [...front, "ls-files", "-z", "--", ":(attr:filter=lfs)"], including);
    if (attr.aborted) return { ok: false, fetched: false, code: null, stderr: attr.stderr, aborted: true };
    const withoutFiles = attr.code === 0 && !String(attr.stdout || "").length;
    return { ok: withoutFiles, fetched: false, code: withoutFiles ? 0 : ls.code, stderr: withoutFiles ? "" : ls.stderr, withoutLfs: true };
  }
  if (!String(ls.stdout || "").trim()) return { ok: true, fetched: false, code: 0, stderr: "" };
  const r = await gitRun(inst, cwd, [...front, "lfs", "pull"], { ...including, env: { ...env, GIT_LFS_SKIP_SMUDGE: "0" }, envAlways: ["GIT_LFS_SKIP_SMUDGE"] });
  return { ok: r.code === 0, fetched: r.code === 0, code: r.code, stderr: r.stderr, ...(r.aborted ? { aborted: true } : {}) };
}
