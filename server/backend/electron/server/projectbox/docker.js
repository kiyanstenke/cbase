// The docker seam of the project containers. EVERY docker call to project containers goes through here — guard
// `server/backend/test/projectbox-ops.test.js` (an `execFile("docker"`/`spawn("docker"` outside this file is red, except the named
// exception list there).
//
// docker(args, { stdin, capMs, env, stdoutFile, maxBytes })  one call of the docker CLI against the daemon of the USER CONTAINER
//   (the inner Docker under Sysbox in which the project containers run).
//     args      array of strings — never a shell string; anything else throws a TypeError before a child starts.
//     stdin     string, Buffer or readable stream (e.g. `image load`); without it stdin is empty.
//     capMs     product cap in ms, default `DOCKER_CAP_MS` (estimated, see there); 0 = no cap. When reached, the docker CHILD is
//               ended and the call rejected with a message that says it was a cap (and whether it was the estimated default) — the
//               command IN the container may keep running (a killed `docker exec` does not end its process; whoever wants to stop
//               it needs the stop chain).
//     env       additional environment of the docker CHILD. Values for `docker exec` go along only as `-e NAME` without a value in
//               `args`: the command line is visible in `ps` of the user container, and the deploy writes oneshot lines into its log.
//     stdoutFile  stdout goes as a STREAM into this file (created new, 0600, O_NOFOLLOW, replaces an existing one) instead of being
//               collected in memory — for output that can be larger than a string (the manifest of a volume with millions of
//               entries). `stdout` in the result is then empty; the result comes only when the file is closed. If writing fails,
//               the child is ended and the call rejected.
//     maxBytes  cap of the collected output (stdout without stdoutFile, stderr always), default `outputCapBytes()`
//               (OUTPUT_CAP_BYTES, knob CBASE_DOCKER_OUTPUT_BYTES). Above it: SIGKILL to the child, DockerError with code
//               "OUTPUT"; the message names cap and knob.
//   Returns `{ code: 0, stdout, stderr }` (text, utf8). An exit ≠ 0 is a `DockerError` with `code`, `stdout`, `stderr`, `args` — the
//   message carries the first stderr row (e.g. "Pool overlaps with other one on this address space", which creation evaluates).
//   WITHOUT `projectboxOps()` (ops.js) NO child starts: the call is rejected with `code: "NO_OPS"`. This is the one place on which
//   the contract "no docker under projectbox/ without ops" hangs.
//
// dockerIn(container, args, opts)  docker IN the project container against its own daemon:
//   `docker exec -u agent <container> docker …args` — the same way as docker(), the same options.
// execIn(container, command, { user, …opts })  another command IN the project container: `docker exec -u <user|agent> <container>
//   …command` — like dockerIn behind the pause barrier; an "is paused" that arrives anyway is recognised by isPausedError (no exit
//   of the command).
//
// dockerKind(args, spawnOpts) / dockerProgram()  the LIVING docker child resp. the program path for the ONE start function
//   `runtime/inProject.js` (runs, bash, hooks, MCP, monitor, terminal, debug, browser): a chat turn is no call with a result but a
//   process with streams and signals. The same argument check, the same ops marker (`NO_OPS` without it), no cap — the lifetime
//   belongs to the run. server.js hands both as a seam to inProject.js (runtime/ is domain-free and never imports projectbox/).
//
// dockerStream(args, { row, end })  ONE long-lived docker child with a row callback — `docker events` of the observer
//   (projectbox/resumption.js). The same argument check, the same ops marker (without it it THROWS, `NO_OPS`, before a child
//   starts), no cap — the stream ends only with `stop()` or unexpectedly. `row(text)` per complete non-empty stdout line (a throw
//   there is logged, the stream keeps running); `end({ code, signal, stderr, stopped, error })` exactly once when the child is gone
//   (`stopped`: by `stop()`). → `{ kind, stop }`.
//
// THE MARKER "CBASE STOPS ITSELF". Every docker() call with `stop`, `rm`, `kill` or `restart` (also as `container <verb>`) notes
//   BEFORE the child starts each named container (name or id as passed) with the time — the observer reads from it that a `die` of
//   this container was cbase's own stop and triggers no restart (table of all stop places in the header of resumption.js, guard
//   server/backend/test/projectbox-stop-places.test.js). The marker sits HERE, not at the places: every stop goes through this seam,
//   so a new one is in without extra work. A stop past it (a human with `docker stop`, the OOM killer, the daemon) carries none.
//   selfStoppedSince(container)  the time of the OLDEST valid marker (name exact, id also as a prefix from 12 characters) or null.
//     The oldest, because a `die` belongs to cbase as soon as ANY marker is not younger than it: `stop` and the `rm` after it name
//     the same container, and the second marker must not move the first (otherwise the `die` of the `stop` would be "older than the
//     marker"). A second call therefore does not renew a marker.
//   forgetSelfStopped(container[], untilMs)  withdraws the markers of these containers that are not younger than `untilMs` — the
//     observer at the `start` of a container (a new life: a later `die` is real again).
//   expireSelfStopped(container[], nowMs)  withdraws the markers that a FAILED call set (exit ≠ 0, cap, spawn) and whose end lies
//     more than SELF_DEADLINE_MS back — the stop did not go through, and a later manual stop or a crash of the still RUNNING
//     container is real again. Not immediately on failure: after a cap abort the daemon keeps stopping, the late `die` still
//     belongs to cbase. The observer calls it on a running container (resumption.js livenessBegan). Clock seam
//     advanceSelfClock(ms) for the tests (this computation only).
//   Capped at SELF_CAP entries (the oldest drops, with a message): one entry per stopped container, also for removed ones — the
//   marker holds after a failed delete a container that cbase left standing on purpose.
//
// The binary is `CBASE_DOCKER_BIN` or `docker` (PATH), read at run time — the tests set it to the false docker
// (server/backend/test/fake-docker.mjs).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { projectboxOps } from "./ops.js";
import { ownKey } from "./own-labels.js";
import { serverEnds } from "../runs/server-end.js";
import { writeStdin, stdinOpen } from "../providers/kind-stdin.js";

// Default cap per call. Generous, because `run`/`image load` may take long on a loaded host; whoever needs longer (distribution of
// the image) passes an own cap.
// ESTIMATED, NOT MEASURED. None of the calls that run under this default today (`run -d` of the project box, `network
// create/inspect/ls/rm`, `volume create/rm`, `image inspect`, `inspect`, `ps`, `rm -f`, `logs`) was timed individually on the server.
// The nearest measured numbers: `docker system df` 12.1 s at load 0.89, `docker stop -t 30` with an inner container 11.5 s (`stop`
// has caps of its own), `docker rmi` with 19 layers 3.0 s, a cold inner dockerd up to `docker info` 13.7 s (runs under its own cap).
// 120 s is thus about ten times the longest measured single call — an assumption, no measurement. That is why the message of a call
// WITHOUT its own `capMs` says it was this estimated default (guard projectbox-ops.test.js): if it hits in operation, that is the
// occasion to measure the call and give it a cap of its own.
export const DOCKER_CAP_MS = 120_000;

// Cap of the collected OUTPUT per call: stdout (only without `stdoutFile` — that goes as a stream into the file) and stderr
// together. Without it a `docker inspect` over thousands of containers or a `logs` without end would collect the whole text in the
// memory of B. When exceeded: SIGKILL to the child and a DockerError `OUTPUT` whose message names the cap and the knob. ESTIMATED,
// NOT MEASURED: 64 MiB is a multiple of any output that a project-container path reads today (the largest `inspect` of a stack read
// is a few 100 KB); whoever needs more passes `maxBytes` or writes to a file. Knob CBASE_DOCKER_OUTPUT_BYTES (integer > 0), read
// at run time.
export const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;
export function outputCapBytes() {
  const raw = process.env.CBASE_DOCKER_OUTPUT_BYTES;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : OUTPUT_CAP_BYTES;
}

export class DockerError extends Error {
  constructor(message, { code, stdout = "", stderr = "", args = [] } = {}) {
    super(message);
    this.name = "DockerError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.args = args;
  }
}

const dockerBin = () => process.env.CBASE_DOCKER_BIN || "docker";
const firstRow = (s) => String(s || "").split("\n").map((z) => z.trim()).find(Boolean) || "";

// The clock seam of the caps (model: `advanceStallClock` in runs/agents.js): `advanceCap()` lets EVERY currently running cap expire
// at once, as if the clock had advanced to there — with the same message and the same abort. A test whose cap stands in the
// opposite direction (one hour) forces it exactly at the call that hangs, without betting that another call finishes before (a
// snapshot has TWO calls with the same cap: a small cap meant for `inspect` would already hit `ps` under load). The product never
// calls it; the test entry server/backend/test/agent-server-child.mjs hangs it on SIGWINCH. Returns the number of caps triggered.
const runningCaps = new Set();
export function advanceCap() {
  const now = [...runningCaps];
  for (const procedure of now) procedure();
  return now.length;
}

export function docker(args, { stdin, capMs, env, stdoutFile, maxBytes } = {}) {
  const preset = capMs === undefined;
  if (preset) capMs = DOCKER_CAP_MS;
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== "string")) {
    return Promise.reject(new TypeError("docker(): args must be a non-empty array of strings (never a shell string)"));
  }
  if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes > 0)) {
    return Promise.reject(new TypeError("docker(): maxBytes must be an integer > 0"));
  }
  const bytesDefault = maxBytes === undefined;
  const capBytes = bytesDefault ? outputCapBytes() : maxBytes;
  if (!projectboxOps()) {
    return Promise.reject(new DockerError("project containers exist only in server mode (CBASE_CONTAINER and CBASE_DIND)", { code: "NO_OPS", args }));
  }
  const newMarkers = rememberSelfStopped(args); // BEFORE the child — a `die` can be at the observer before this call ends (see header)
  return new Promise((res, rej) => {
    // A FAILED call (also the cap) binds the markers it newly set to its end — they then expire.
    const resolve = res;
    const reject = (e) => { selfStoppedFailed(newMarkers); rej(e); };
    let finished = false;
    let cap = null;
    let procedure = null;
    const out = [];
    const err = [];
    const subprocess = spawn(dockerBin(), args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    const end = (fn) => { if (finished) return; finished = true; if (cap) clearTimeout(cap); runningCaps.delete(procedure); fn(); };
    // The output cap (see OUTPUT_CAP_BYTES). → whether the chunk is collected.
    let counted = 0;
    const count = (b) => {
      if (finished) return false;
      counted += b.length;
      if (counted <= capBytes) return true;
      end(() => {
        if (stdin && typeof stdin.pipe === "function") { try { stdin.unpipe(subprocess.stdin); stdin.destroy(); } catch {} }
        try { subprocess.kill("SIGKILL"); } catch {}
        reject(new DockerError(`docker ${args[0]}: output above the cap of ${capBytes} bytes${bytesDefault ? " (seam default, estimated, not measured)" : ""} — aborted (knob CBASE_DOCKER_OUTPUT_BYTES, per call maxBytes)`, {
          code: "OUTPUT",
          stderr: Buffer.concat(err).toString("utf8").slice(0, 4096),
          args,
        }));
      });
      return false;
    };
    // stdoutFile: stdout as a stream into the file; `close` of the child additionally waits for the file to close.
    let sink = null;
    let sinkError = null;
    let sinkTo = Promise.resolve();
    if (stdoutFile !== undefined) {
      const f = fs.constants;
      sink = fs.createWriteStream(stdoutFile, { flags: f.O_WRONLY | f.O_CREAT | f.O_TRUNC | (f.O_NOFOLLOW || 0), mode: 0o600 });
      sinkTo = new Promise((r) => sink.once("close", r));
      sink.on("error", (e) => { sinkError = e; try { subprocess.kill("SIGKILL"); } catch {} });
      subprocess.stdout.pipe(sink);
    } else subprocess.stdout.on("data", (b) => { if (count(b)) out.push(b); });
    subprocess.stderr.on("data", (b) => { if (count(b)) err.push(b); });
    subprocess.on("error", (e) => { if (sink) sink.destroy(); end(() => reject(new DockerError(`docker could not be started (${dockerBin()}): ${e.message}`, { code: e.code || "SPAWN", args }))); });
    // `close`, not `exit`: only then is the output complete. The cap waits for neither.
    subprocess.on("close", (code, signal) => sinkTo.then(() => end(() => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (sinkError) return reject(new DockerError(`docker ${args[0]}: stdout not written to the file (${sinkError.code || sinkError.message})`, { code: sinkError.code || "SINK", stdout, stderr, args }));
      if (code === 0) return resolve({ code, stdout, stderr });
      const reason = firstRow(stderr) || (signal ? `killed by ${signal}` : `exit ${code}`);
      reject(new DockerError(`docker ${args[0]}: ${reason}`, { code: code ?? signal, stdout, stderr, args }));
    })));
    if (capMs > 0) {
      procedure = () => end(() => {
        // A source stream (`image load`) would stay attached and open after the death of the child.
        if (stdin && typeof stdin.pipe === "function") { try { stdin.unpipe(subprocess.stdin); stdin.destroy(); } catch {} }
        try { subprocess.kill("SIGKILL"); } catch {}
        reject(new DockerError(`docker ${args[0]}: cap of ${capMs} ms${preset ? " (seam default, estimated, not measured)" : ""} reached — aborted (a command in the container may keep running)`, {
          code: "CAP",
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          args,
        }));
      });
      cap = setTimeout(procedure, capMs);
      runningCaps.add(procedure);
    }
    // stdin through providers/kind-stdin.js (guard server/backend/test/stdin-epipe.test.js): a child that ends early closes stdin,
    // the EPIPE error lands at the guard of the helper instead of as an uncaughtException — the verdict comes through `close`.
    if (stdin !== undefined) {
      if (stdin && typeof stdin.pipe === "function") {
        // The stream way: `stdinOpen` registers the guard BEFORE `pipe` writes.
        if (stdinOpen(subprocess)) stdin.pipe(subprocess.stdin);
      } else {
        writeStdin(subprocess, stdin ?? "", { close: true });
      }
    }
  });
}

// dockerKind(args, spawnOpts) — the RAW docker child for starts that live over their runtime (runtime/inProject.js): the chat CLI,
//   bash, hooks, MCP, monitor in the project container. No cap and no collecting of output — the caller reads stdout/stderr itself,
//   as with `spawn`. The same ops check as docker(): without the marker it THROWS (`DockerError`, code "NO_OPS") before a child
//   starts. Returns: the ChildProcess.
export function dockerKind(args, spawnOpts = {}) {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== "string")) {
    throw new TypeError("dockerKind(): args must be a non-empty array of strings (never a shell string)");
  }
  if (!projectboxOps()) {
    throw new DockerError("project containers exist only in server mode (CBASE_CONTAINER and CBASE_DIND)", { code: "NO_OPS", args });
  }
  return spawn(dockerBin(), args, spawnOpts);
}

// dockerProgram() — the docker program for node-pty (terminal.js starts `docker exec -it …` itself in the pty). Throws without the
// ops marker like dockerKind.
export function dockerProgram() {
  if (!projectboxOps()) {
    throw new DockerError("project containers exist only in server mode (CBASE_CONTAINER and CBASE_DIND)", { code: "NO_OPS", args: [] });
  }
  return dockerBin();
}

// ── The stream and the marker "cbase stops itself" (see header) ─────────────────────────────────────────────────────

export function dockerStream(args, { row, end } = {}) {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== "string")) {
    throw new TypeError("dockerStream(): args must be a non-empty array of strings (never a shell string)");
  }
  if (!projectboxOps()) {
    throw new DockerError("project containers exist only in server mode (CBASE_CONTAINER and CBASE_DIND)", { code: "NO_OPS", args });
  }
  const subprocess = spawn(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
  let rest = "";
  let stopped = false;
  let finished = false;
  const err = [];
  let errLength = 0;
  const gib = (text) => {
    if (!text.trim() || typeof row !== "function") return;
    try { row(text); } catch (e) { console.error(`[projectbox] docker ${args[0]}: row not processed (${e?.message || e})`); }
  };
  subprocess.stdout.setEncoding("utf8");
  subprocess.stdout.on("data", (s) => {
    rest += s;
    for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) { const z = rest.slice(0, i); rest = rest.slice(i + 1); gib(z); }
  });
  subprocess.stderr.on("data", (b) => { if (errLength < 8192) { err.push(b); errLength += b.length; } });
  const end2 = (code, signal, error) => {
    if (finished) return;
    finished = true;
    if (rest) { const z = rest; rest = ""; gib(z); }
    if (typeof end !== "function") return;
    try { end({ code, signal, stderr: Buffer.concat(err).toString("utf8"), stopped, error }); }
    catch (e) { console.error(`[projectbox] docker ${args[0]}: end not processed (${e?.message || e})`); }
  };
  subprocess.on("error", (e) => end2(null, null, e));
  subprocess.on("close", (code, signal) => end2(code, signal, null));
  return {
    kind: subprocess,
    stop() {
      if (finished || stopped) return;
      stopped = true;
      try { subprocess.kill("SIGTERM"); } catch { /* gone */ }
    },
  };
}

export const SELF_CAP = 1000;
// ESTIMATED, NOT MEASURED: stop cap (30 s + margin for the daemon, which keeps stopping after a cap abort) with reserve.
export const SELF_DEADLINE_MS = 180_000;
const selfStopped = new Map(); // name or id (as passed) → { since (ms of the first marker since the last forgetting), failed, endAt }
let selfClockOffset = 0;
/** Clock seam (tests only): advances the computation of expireSelfStopped by `ms`. The product never calls it. */
export function advanceSelfClock(ms) { selfClockOffset += Number(ms) || 0; }
// `restart` today without a caller (its `die` is an own stop, its `start` a new life); the form `container <verb>` likewise — both
// stand here so that a new place in this form does not silently stay without a marker.
const WITH_VALUE_AT = { stop: new Set(["-t", "--time", "--timeout", "-s", "--signal"]), restart: new Set(["-t", "--time", "--timeout", "-s", "--signal"]), kill: new Set(["-s", "--signal"]), rm: new Set() };
const isId = (s) => s.length >= 12 && /^[0-9a-f]+$/i.test(s);
const hits = (key, who) => key === who || (isId(key) && isId(who) && (key.startsWith(who) || who.startsWith(key)));

// → the keys that THIS call newly set (an existing marker stays as it is).
function rememberSelfStopped(all) {
  const args = all[0] === "container" ? all.slice(1) : all;
  const withValue = Object.hasOwn(WITH_VALUE_AT, args[0]) ? WITH_VALUE_AT[args[0]] : null;
  const fresh = [];
  if (!withValue) return fresh;
  const now = Date.now();
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) { if (withValue.has(a)) i += 1; continue; }
    if (!selfStopped.has(a)) { selfStopped.set(a, { since: now, failed: false, endAt: null }); fresh.push(a); } // an existing marker stays as it is (see header)
  }
  while (selfStopped.size > SELF_CAP) {
    const oldest = selfStopped.keys().next().value;
    selfStopped.delete(oldest);
    console.warn(`[projectbox] marker “cbase stops itself”: cap of ${SELF_CAP} entries reached — the oldest (${String(oldest).slice(0, 12)}) drops`);
  }
  return fresh;
}

function selfStoppedFailed(key) {
  const now = Date.now();
  for (const k of key) {
    const m = selfStopped.get(k);
    if (m && !m.failed) { m.failed = true; m.endAt = now; }
  }
}

/** The time of the oldest valid "cbase stops itself" marker for this container (name or id) — or null (see header). */
export function selfStoppedSince(container) {
  const who = String(container || "");
  if (!who) return null;
  let since = null;
  for (const [k, m] of selfStopped) if (hits(k, who) && (since === null || m.since < since)) since = m.since;
  return since;
}

/** Withdraws the markers of these containers that are not younger than `untilMs` (a `start` — see header). → how many. */
export function forgetSelfStopped(container, untilMs = Infinity) {
  const list = (Array.isArray(container) ? container : [container]).map((c) => String(c || "")).filter(Boolean);
  let n = 0;
  for (const [k, m] of [...selfStopped]) {
    if (m.since <= untilMs && list.some((who) => hits(k, who))) { selfStopped.delete(k); n += 1; }
  }
  return n;
}

/** Withdraws the markers of these containers that a failed call set and whose end lies more than SELF_DEADLINE_MS back (see
 *  header). → how many. */
export function expireSelfStopped(container, nowMs = Date.now() + selfClockOffset) {
  const list = (Array.isArray(container) ? container : [container]).map((c) => String(c || "")).filter(Boolean);
  let n = 0;
  for (const [k, m] of [...selfStopped]) {
    if (m.failed && nowMs - m.endAt > SELF_DEADLINE_MS && list.some((who) => hits(k, who))) { selfStopped.delete(k); n += 1; }
  }
  return n;
}

export function dockerIn(container, args, opts) {
  if (typeof container !== "string" || !container || container.startsWith("-")) {
    return Promise.reject(new TypeError(`dockerIn(): not a container: ${container}`));
  }
  if (!Array.isArray(args)) return Promise.reject(new TypeError("dockerIn(): args must be an array"));
  return hinterBarrier(container, `docker ${args[0] || ""}`.trim(), () => docker(["exec", "-u", "agent", container, "docker", ...args], opts), opts);
}

// execIn(container, command, { user, ...opts })  a command IN the project container (`docker exec -u <user> <container> …command`,
//   default `agent`) — the same way as docker(), the same options, and the same pause barrier as dockerIn (a raw `docker(["exec",
//   …])` got "is paused" with exit 1 during the pause, and its callers read that as a verdict on the command — "dead", "group
//   empty"). Whoever still sees "is paused" (a pause that cbase does not hold, or the cap of the barrier) recognises it by
//   isPausedError — that is NO exit of the command but "unknown".
//   With `stdin` (the upfront fetch of the VS Code server streams the tarball into `tar` in the container) the call carries `-i` —
//   without `-i` `docker exec` attaches no stdin at all and the command would read empty. Without `stdin` the argv stays as before.
export function execIn(container, command, { user = "agent", ...opts } = {}) {
  if (typeof container !== "string" || !container || container.startsWith("-")) {
    return Promise.reject(new TypeError(`execIn(): not a container: ${container}`));
  }
  if (!Array.isArray(command) || !command.length) return Promise.reject(new TypeError("execIn(): command must be a non-empty array"));
  const withStdin = opts.stdin !== undefined ? ["-i"] : [];
  return hinterBarrier(container, String(command[0]), () => docker(["exec", ...withStdin, "-u", String(user), container, ...command], opts), opts);
}

// The barrier of ONE call (dockerIn, execIn): a frozen project container is "wait briefly", the call runs only after the thaw (cap
// with message). The race (see header "THE PAUSE BARRIER"): the exec started before pause() set the set and arrived at the daemon
// only after the pause — caught up once, only without a stream on stdin (that is consumed by then).
function hinterBarrier(container, purpose, run, opts) {
  if (isFrozen(container)) return waitForThaw(container, purpose).then(run);
  const again = opts?.stdin && typeof opts.stdin.pipe === "function" ? null : run;
  return run().catch((e) => {
    if (again && e instanceof DockerError && IS_PAUSED.test(String(e.stderr || "")) && isFrozen(container)) {
      return waitForThaw(container, purpose).then(again);
    }
    throw e;
  });
}

// ── THE PAUSE BARRIER ───────────────────────────────────────────────────────────────────────────────────────────────
// A main stands frozen (`docker pause`) for the code snapshot and phase 2 of the volume clone. A `docker exec` into a paused
// container is refused by the daemon ("Container <id> is paused, unpause the container before exec") — for every path that would mean
// "error", and a tool error would confuse the agent. Therefore:
//
// pause(container, opts) / thawOut(container, opts)  the ONLY places for `pause`/`unpause` of a single container (plus thawAll below,
//   over the label). `container` is the NAME as the container-of helper (run-instance.js) delivers it; pause reads id and names before
//   (`inspect`), and the set `frozen` knows the container under BOTH — inProject asks by name, dockerIn of the stop chain and the
//   restore by id. The set lives in MEMORY: after a restart of B it is empty, and the restart grace thaws every paused project
//   container (thawRestartGrace). It is entered BEFORE the `pause` (an exec that begins in that time waits), left only AFTER the
//   `unpause` including a check through `inspect .State.Paused`. If `pause` fails, the entry drops and the waiting ones run. A second
//   pause of the same container throws (`ALREADY_FROZEN`) — the pause belongs to ONE flow, its `finally` thaws.
//   `pause(container, { beforePause })`: `beforePause({ name, id })` runs AFTER the entry and BEFORE the `pause` (awaited) — the copy
//   freeze waits there for running administration git and reads the desired state; if it throws, there is no `pause`. Right before
//   the `pause`, pause asks serverEnds(): if the server ends, the entry drops and the call throws `SERVER_END` — the stop chain thaws
//   at that moment and stops, a `pause` afterwards would freeze a container.
//   thawOut of a container that is not (or no longer) paused is no error; one that is still paused after the `unpause` throws
//   `STILL_PAUSED` and stays in the set (the waiting ones keep waiting, up to their cap) — from there the guard thaws again (see "THE
//   THAW GUARD" below).
//   The marker in the journal of the copy is written by the caller (stacks/freeze.js) — this seam knows no copy.
// isFrozen(container)  the container (name, id or an id prefix from 12 characters) is in the set.
// isFrozen(container, { kill: true })  only if the `pause` is already on its way out: the group kills of a RUNNING start
//   (runtime/inProject.js) wait only at a container that really freezes. Between entry and `pause` `beforePause` runs — the copy
//   freeze waits there until no administration git runs in the main any more; a TERM that waited at the barrier for the thaw would wait
//   for itself (the git never ended, or only the docker CLI ended, and `pause` froze the git in the middle of writing). NEW STARTS wait
//   from the entry on as before.
// waitForThaw(container, purpose)  → Promise: fulfilled at once if it is not frozen; otherwise at the thaw. CAP: `CBASE_PAUSE_CAP_MS`
//   (default PAUSE_CAP_MS), read at run time; afterwards it is rejected with a DockerError `PAUSE_CAP` whose message says it was a
//   cap and for what. The cap hangs on the clock seam advanceCap() (above) like every cap of this file.
// The barrier sits in dockerIn and execIn (above) and — through the seam of runtime/inProject.js (server.js: `frozen`, `childAfterThaw`)
// — in every start in the project container: dockerChildAfterThaw starts instead of the docker child a shell that waits on a channel of
// its own (fd 3) for the thaw and replaces itself only then by `exec` through the docker CLI — the same pid, the same streams, the same
// arguments. The caller holds its ChildProcess at once as before.
// THE RACE that remains: a start that began BEFORE the entry and arrives at the daemon AFTER the `pause` gets "is paused". dockerIn
// catches it up once (above); an inProject child does not (its stdin may already be consumed) — the caller sees the error of the docker
// CLI. The window is the start time of the docker CLI; the copy freeze locks new runs beforehand (lock `freeze`).
// Guard: server/backend/test/projectbox-pause.test.js.
// Default cap: ESTIMATED, NOT MEASURED. The target of the pause is ≈ 30 s at a large project; five minutes is ten times that. If the cap
// hits in operation, that is the occasion to measure the pause.
export const PAUSE_CAP_MS = 300_000;
export function pauseCapMs() {
  const raw = process.env.CBASE_PAUSE_CAP_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : PAUSE_CAP_MS;
}
// The wording of the daemon (moby daemon/exec.js), ONE place in this file; runtime/git-run.js CONTAINER_PAUSED carries the same.
const IS_PAUSED = /is paused/i;
const NOT_PAUSED = /is not paused/i;
const MISSING = /No such (object|container)|not found/i;
/** An error that only says "the container is frozen": the daemon refused the exec with "is paused" (a pause that cbase does not
 *  hold), or waiting at the barrier reached its cap. NO exit of the command — whoever reads "dead" or "done" from it judges
 *  something that never ran. */
export const isPausedError = (e) => e instanceof DockerError && (e.code === "PAUSE_CAP" || IS_PAUSED.test(String(e.stderr || "")));

// container → entry { name, id, since, waiters: Set<fn> }; the same entry under name AND id.
const frozen = new Map();
const entryOf = (container) => {
  const c = String(container || "");
  if (!c) return null;
  const direct = frozen.get(c);
  if (direct) return direct;
  if (c.length >= 12 && /^[0-9a-f]+$/i.test(c)) {
    for (const e of frozen.values()) if (e.id && e.id.startsWith(c)) return e;
  }
  return null;
};
export const isFrozen = (container, { kill = false } = {}) => {
  const e = entryOf(container);
  return Boolean(e) && (!kill || e.pauseSent === true);
};
/** The frozen containers (names) — for the stop chain and tests. */
export const frozen2 = () => [...new Set([...frozen.values()].map((e) => e.name))];
/** How many starts are currently waiting for a thaw (test seam: a test waits for it instead of waiting out a duration). */
export const waitingForThaw = () => [...new Set(frozen.values())].reduce((n, e) => n + e.waiters.size, 0);

function approve(e) {
  for (const [k, v] of [...frozen]) if (v === e) frozen.delete(k);
  const w = rethawing.get(e); // a scheduled retry is done
  if (w) { clearTimeout(w.tick); w.tick = null; rethawing.delete(e); }
  for (const fn of [...e.waiters]) fn();
  e.waiters.clear();
}
const entryExists = (e) => [...frozen.values()].includes(e);

// A wait with a cap; `abort()` withdraws it (a child that ended before the thaw).
function wait(container, purpose) {
  const e = entryOf(container);
  if (!e) return { promise: Promise.resolve(), abort: () => {} };
  let detach = () => {};
  const promise = new Promise((resolve, reject) => {
    const capMs = pauseCapMs();
    let cap = null;
    let procedure = null;
    const finished = () => { clearTimeout(cap); runningCaps.delete(procedure); e.waiters.delete(on); };
    const on = () => { finished(); resolve(); };
    procedure = () => {
      finished();
      reject(new DockerError(`project container ${e.name} has been frozen for ${Date.now() - e.since} ms — cap of ${capMs} ms (CBASE_PAUSE_CAP_MS) reached, ${purpose || "the call"} aborted`, { code: "PAUSE_CAP", args: [] }));
    };
    detach = finished;
    e.waiters.add(on);
    cap = setTimeout(procedure, capMs);
    runningCaps.add(procedure);
  });
  return { promise, abort: () => detach() };
}
export const waitForThaw = (container, purpose) => wait(container, purpose).promise;

export async function pause(container, { beforePause = null, ...opts } = {}) {
  if (typeof container !== "string" || !container || container.startsWith("-")) throw new TypeError(`pause(): not a container: ${container}`);
  if (beforePause !== null && typeof beforePause !== "function") throw new TypeError("pause(): beforePause must be a function");
  if (entryOf(container)) throw new DockerError(`pause(): ${container} is already frozen`, { code: "ALREADY_FROZEN", args: [] });
  const view = (await docker(["inspect", "--type", "container", "-f", "{{.Id}} {{.Name}}", container], opts)).stdout.trim().split(/\s+/);
  const e = { name: container, id: view[0] || "", since: Date.now(), waiters: new Set() };
  if (entryOf(container)) throw new DockerError(`pause(): ${container} is already frozen`, { code: "ALREADY_FROZEN", args: [] });
  for (const k of new Set([container, e.id, String(view[1] || "").replace(/^\//, "")].filter(Boolean))) frozen.set(k, e);
  try {
    // The barrier is closed from here on (a new start waits), the container still runs. `beforePause` waits for what already runs in
    // the container (runtime/git-run.js commandsDone) and reads the desired state immediately before the pause — with the raw
    // docker(), not dockerIn: dockerIn would now wait at its own barrier. If it throws, the entry drops, the waiting ones run, and
    // there is no `pause`.
    if (beforePause) await beforePause({ name: container, id: e.id });
    // Right before the `pause` — if the server ends (the stop chain is thawing and stopping right now), this `pause` freezes nothing
    // any more: the entry drops (catch), the caller gets "server end".
    if (serverEnds()) throw new DockerError(`pause(): ${container} — server end, no pause`, { code: "SERVER_END", args: ["pause", container] });
    e.pauseSent = true; // from here on the group kills wait too (isFrozen with `kill`)
    await docker(["pause", container], opts);
  } catch (x) { approve(e); throw x; }
  return { id: e.id };
}

export async function thawOut(container, opts = {}) {
  if (typeof container !== "string" || !container || container.startsWith("-")) throw new TypeError(`thawOut(): not a container: ${container}`);
  const e = entryOf(container);
  try { return await thaw(container, e, opts); } catch (x) {
    // The entry stays — from here on the guard thaws again (see "THE THAW GUARD").
    if (e && entryExists(e)) rethawSchedule(e, x);
    throw x;
  }
}

async function thaw(container, e, opts) {
  const target = e?.id || container;
  let old = null;
  try { await docker(["unpause", target], opts); } catch (x) { old = x; }
  let paused;
  try { paused = (await docker(["inspect", "--type", "container", "-f", "{{.State.Paused}}", target], opts)).stdout.trim() === "true"; }
  catch (x) {
    if (!MISSING.test(`${x?.stderr || ""}\n${x?.message || ""}`)) throw old || x;
    paused = false; // gone: nothing frozen any more
  }
  if (paused) {
    throw new DockerError(`thawOut(): ${container} is still paused after the unpause${old ? ` (${old.message})` : ""}`, { code: "STILL_PAUSED", args: ["unpause", target] });
  }
  if (e) approve(e);
  return { wasPaused: !(old && NOT_PAUSED.test(String(old.stderr || old.message || ""))) };
}

// THE THAW GUARD. If thawOut of a registered container fails (STILL_PAUSED: still paused after the `unpause`; or `unpause` AND
//   `inspect` without a verdict — a hanging daemon), the entry stays and the waiting ones keep waiting. Without a guard nobody would thaw
//   afterwards: the restore refuses with FROZEN, the monitor skips, every start waits up to its cap — until the next start of B (the
//   restart grace thaws everything). So every failed thawOut of an entry schedules a retry in the rhythm RETHAW_MS (rising, then
//   constant), until it succeeds, the container is gone or another way thaws (approve withdraws the rhythm). An entry has at most ONE
//   scheduled retry. The caller stays owner of the pause: it sees the error as before; the guard replaces only the "nobody". What lies
//   before — a `pause` that fails at the cap but still takes effect at the daemon — stays the duty of the caller ("failure at any
//   place: thaw"); thawOut without an entry thaws there too.
// ESTIMATED, NOT MEASURED: 5 s, 15 s, then every minute — the pause itself aims at ≈ 30 s.
export const RETHAW_MS = Object.freeze([5_000, 15_000, 60_000]);
const rethawing = new Map(); // entry → { attempt, tick, run }
/** How many frozen containers wait for a retry of the thaw (test seam, like waitingForThaw). */
export const openRethaw = () => rethawing.size;
/** Clock seam like advanceCap: every scheduled retry runs AT ONCE. The product never calls it. → how many. */
export function advanceRethaw() {
  const now = [...rethawing.values()].filter((w) => w.tick);
  for (const w of now) w.run();
  return now.length;
}
function rethawSchedule(e, reason) {
  const old = rethawing.get(e);
  if (old?.tick) return;
  const attempt = old ? old.attempt + 1 : 0;
  const ms = RETHAW_MS[Math.min(attempt, RETHAW_MS.length - 1)];
  const w = { attempt, tick: null, run: null };
  w.run = () => {
    if (!w.tick) return;
    clearTimeout(w.tick);
    w.tick = null;
    if (!entryExists(e)) { if (rethawing.get(e) === w) rethawing.delete(e); return; }
    // If it succeeds, approve releases the entry with its guard; if it fails, thawOut has scheduled the next retry.
    thawOut(e.id || e.name).catch(() => {});
  };
  w.tick = setTimeout(w.run, ms);
  w.tick.unref?.();
  rethawing.set(e, w);
  console.error(`[projectbox] thaw of ${e.name} failed (${reason?.message || reason}) — retry ${attempt + 1} in ${ms / 1000} s`);
}

// thawAll({ reason, capMs }) — every OWN project container of the user container (label `cbase.project` ON the container, not inherited
//   from the image — onlyOwnProjectContainer) in state `paused` is thawed, WITHOUT a marker (only cbase pauses at level 2): the restart
//   grace (thawRestartGrace) and the stop chain at server end (with the cap of the snapshot). Calls: `ps`, for the hits `inspect` and
//   `image inspect`, then ONE `unpause` with all ids. Never throws; → { thawed: [id], error: [message] }.
//   The set of entries: an entry is released ONLY if `ps` succeeded AND its `pause` was already sent (`pauseSent`) AND its container
//   is no longer paused afterwards. If `ps` fails, nobody knows whether it is still paused — the entry stays, its waiting ones wait, and
//   the guard thaws again (rethawSchedule). An entry WITHOUT `pauseSent` belongs to a pause() that still stands in `beforePause` — it
//   stays with it (otherwise it would drop, and the `pause` afterwards would freeze a container nobody holds any more).
export async function thawAll({ reason = "", capMs } = {}) {
  const opts = capMs === undefined ? {} : { capMs };
  const thawed = [];
  const error = [];
  let ids = [];
  let psSucceeded = false;
  try {
    ids = (await docker(["ps", "-q", "--no-trunc", "--filter", "label=cbase.project", "--filter", "status=paused"], opts)).stdout
      .split(/\s+/).map((s) => s.trim()).filter(Boolean);
    psSucceeded = true;
  } catch (x) { error.push(`ps: ${x?.message || x}`); }
  if (ids.length) ids = await onlyOwnProjectContainer(ids, opts, error);
  if (ids.length) {
    try { await docker(["unpause", ...ids], opts); thawed.push(...ids); }
    catch (x) {
      // stdout names what is thawed; the rest stays in the set (its waiting ones wait up to their cap).
      const ok = new Set(String(x?.stdout || "").split(/\s+/).filter(Boolean));
      thawed.push(...ids.filter((id) => ok.has(id)));
      error.push(`unpause: ${x?.message || x}`);
    }
  }
  const stillFrozen = new Set(ids.filter((id) => !thawed.includes(id)));
  for (const e of new Set(frozen.values())) {
    if (!e.pauseSent) continue; // belongs to a pause() in beforePause (see above)
    if (!psSucceeded) { rethawSchedule(e, `${reason || "thaw"}: ps failed`); continue; }
    if (!stillFrozen.has(e.id)) approve(e);
  }
  if (thawed.length) console.log(`[projectbox] ${reason || "thaw"}: ${thawed.length} paused project container(s) thawed`);
  if (error.length) console.error(`[projectbox] ${reason || "thaw"}: ${error.join("; ")}`);
  return { thawed, error };
}

// onlyOwnProjectContainer(ids, opts, error) — of the ids (from a `ps --filter label=cbase.project`) only those whose `cbase.project` is
//   set ON the container (own-labels.js ownKey): a user container from an image with `LABEL cbase.project=…` inherits the label and
//   would otherwise hit every filter of the stop chain (stop, thaw). If the image is unknown (not readable, gone), the label alone
//   counts — a container of cbase must never be missing. If `inspect` fails altogether, all ids stay (label alone; the message goes to
//   `error`). The order stays. Never throws.
export async function onlyOwnProjectContainer(ids, opts = {}, error = []) {
  if (!ids.length) return [];
  const readJson = async (args, purpose) => {
    try { return JSON.parse((await docker(args, opts)).stdout || "[]"); }
    catch (x) {
      // Several targets, one gone: docker reports ≠ 0, stdout carries the others.
      try { const part = JSON.parse(String(x?.stdout || "")); if (Array.isArray(part) && part.length) return part; } catch { /* empty */ }
      error.push(`${purpose}: ${x?.message || x}`);
      return null;
    }
  };
  const info = await readJson(["inspect", "--type", "container", ...ids], "inspect");
  if (!Array.isArray(info)) return ids;
  const images = [...new Set(info.map((c) => c?.Image).filter(Boolean))];
  const image = new Map();
  const bInfo = images.length ? await readJson(["image", "inspect", ...images], "image inspect") : [];
  for (const b of Array.isArray(bInfo) ? bInfo : []) if (b?.Id) image.set(b.Id, b?.Config?.Labels || {});
  return ids.filter((id) => {
    const c = info.find((x) => typeof x?.Id === "string" && x.Id.startsWith(id));
    if (!c) return true; // not read: the label alone
    return ownKey(c?.Config?.Labels, image.has(c.Image) ? image.get(c.Image) : null).includes("cbase.project");
  });
}

// Receiver of the hook "restartGrace" "project-thaw" (server.js, the FIRST of its kind — before "project-restore"). Without the ops
// marker nothing. The promise counts as an open hook (the quiet of the server waits for it); it never throws.
export function thawRestartGrace() {
  if (!projectboxOps()) return undefined;
  return thawAll({ reason: "restart grace" });
}

// The shell of the barrier (see header): reads ONE line from fd 3 — "g" ⇒ exec of the docker CLI with the arguments, else the message
// behind it (the cap) on stderr and exit 125. A closed channel without a line (B is gone) ends likewise.
export const BARRIER_SCRIPT = 'read -r t m <&3 || t=; exec 3<&-; if [ "$t" = g ]; then exec "$@"; fi; printf \'%s\\n\' "${m:-project container frozen: the barrier got no answer}" >&2; exit 125';

const stdioFour = (stdio) => {
  if (stdio === undefined || stdio === null) return ["pipe", "pipe", "pipe", "pipe"];
  if (typeof stdio === "string") return [stdio, stdio, stdio, "pipe"];
  if (!Array.isArray(stdio) || stdio.length > 3) return null;
  return [0, 1, 2].map((i) => stdio[i] ?? "pipe").concat("pipe");
};

// dockerChildAfterThaw(container, args, spawnOpts) — like dockerKind, but for a frozen container only after the thaw (see header). Not
//   frozen (or a stdio form with more than three channels): exactly dockerKind. The child carries `barrier = { started, los, abort() }` —
//   `started` becomes true as soon as the "go" is written (from then on something can run in the container); `los` is a promise for
//   it (true at the go, false if it never comes: cap or aborted — a deadline that applies to the command begins only there,
//   runtime/git-run.js and the escalation in runtime/inProject.js); `abort()` before the go withdraws the wait (runtime/inProject.js
//   calls it at the kill).
export function dockerChildAfterThaw(container, args, spawnOpts = {}) {
  if (!isFrozen(container)) return dockerKind(args, spawnOpts);
  const stdio = stdioFour(spawnOpts.stdio);
  if (!stdio) return dockerKind(args, spawnOpts);
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== "string")) {
    throw new TypeError("dockerChildAfterThaw(): args must be a non-empty array of strings (never a shell string)");
  }
  if (!projectboxOps()) {
    throw new DockerError("project containers exist only in server mode (CBASE_CONTAINER and CBASE_DIND)", { code: "NO_OPS", args });
  }
  const subprocess = spawn("/bin/sh", ["-c", BARRIER_SCRIPT, "cbase-barrier", dockerBin(), ...args], { ...spawnOpts, stdio });
  const channel = subprocess.stdio[3];
  channel?.on("error", () => { /* the child is gone — its end is reported by `close` */ });
  const w = wait(container, `docker ${args[0] || ""}`.trim());
  let decided = false;
  let goReport = () => {};
  const go = new Promise((r) => { goReport = r; });
  const send = (row) => {
    if (decided) return;
    decided = true;
    if (row.startsWith("g")) subprocess.barrier.started = true;
    try { channel?.end(row); } catch { /* gone */ }
    goReport(row.startsWith("g"));
  };
  subprocess.barrier = {
    started: false,
    go,
    abort: () => { if (decided) return; decided = true; w.abort(); try { channel?.destroy(); } catch { /* gone */ } goReport(false); },
  };
  w.promise.then(() => send("g\n"), (e) => send(`d ${String(e?.message || e).replace(/\s+/g, " ")}\n`));
  subprocess.once("exit", () => subprocess.barrier.abort());
  return subprocess;
}
