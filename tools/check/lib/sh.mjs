// Command execution with one hard distinction:
//
//   probe()  read-only/measuring — ALWAYS runs, also in a dry run. Measuring must not break anything.
//   act()    changing            — in a dry run only the command is shown, nothing is executed.
//
// Whoever PROCESSES the result of a command further must use probe(); act() returns empty output in a
// dry run, and no logic may build on that.
import { spawn } from "node:child_process";
import { REPO } from "../config-repo.mjs";
import * as log from "./log.mjs";

let dryRun = false;
export function setDryRun(v) {
  dryRun = !!v;
}
export function isDryRun() {
  return dryRun;
}

export class CommandError extends Error {
  constructor(cmd, code, stderr) {
    super(`${cmd} → exit ${code}${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`);
    this.code = code;
    this.stderr = stderr;
  }
}

function display(cmd, args) {
  return [cmd, ...args.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

// The running children WITH their own process group (see `exec`). They need a holder because a group of
// its own does NOT inherit a Ctrl-C of the session: the signal goes to the foreground group, and the
// grandchildren of a `node --test` would stand aside. Without it an aborted deploy would leave its test
// runs running.
const groups = new Set();
let signalsWired = false;
function wireSignals() {
  if (signalsWired) return;
  signalsWired = true;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      for (const pid of groups) {
        try {
          process.kill(-pid, sig);
        } catch {
          /* already gone */
        }
      }
      // First remove the listeners, THEN pass the signal on to ourselves — in this order: a
      // `process.kill(self)` with the listener still attached puts the signal into the loop, and the
      // listener would run again. After removal the default applies (terminate).
      // No `process.exit`: the caller should still be able to log its own abort.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

export function exec(cmd, args, opts = {}) {
  // `onLine(line)` sees every COMPLETE stdout line as soon as it arrives — for runs that last an hour
  // (XCUITest) and whose progress would otherwise only show at the end.
  //
  // `stall: { ms, progress }`: a second deadline that measures not the DURATION but the SILENCE. It runs from
  // the start and restarts at every complete stdout line for which `progress(line)` is true; when it elapses, the
  // group is killed as with `timeout` and the result carries `stall: true` (NOT `timedOut` — the caller must be
  // able to tell the two aborts apart and name them). `timeout` remains as the emergency cap on the total duration.
  // Reason: the total duration depends on width and load, but a hang shows up as silence.
  const { cwd = REPO, input = null, env = process.env, timeout = 0, echo = true, onLine = null, stall = null } = opts;
  const stillMs = stall && Number(stall.ms) > 0 ? Number(stall.ms) : 0;
  const isProgress = stillMs ? stall.progress || (() => true) : null;
  if (echo) log.cmdLine(display(cmd, args));
  // A deadline must hit the GRANDCHILDREN, not just the child.
  // `shProbe` starts `/bin/sh -c "node --test …"`, and `node --test` starts one more process with a real
  // server per test file. A `child.kill()` only hit the shell: the grandchildren inherited stdout/stderr,
  // kept the pipes open, `close` never came — and the deadline passed without effect.
  //
  // So: a run WITH a deadline gets a process group of its own, the deadline kills the GROUP, and the
  // promise resolves IMMEDIATELY — waiting for `close` would again mean waiting for a pipe that a
  // grandchild holds open. Without a deadline everything stays as before (no group of its own), so that a
  // Ctrl-C of the session still takes the children of a long deploy along. The stall deadline is a deadline like any other.
  const ownGroup = timeout > 0 || stillMs > 0;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: ownGroup });
    if (ownGroup && child.pid) {
      groups.add(child.pid);
      wireSignals();
    }
    let out = "";
    let err = "";
    let rest = "";
    let timer = null;
    let stillTimer = null;
    let finished = false;
    const end = (r) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (stillTimer) clearTimeout(stillTimer);
      if (child.pid) groups.delete(child.pid);
      resolve(r);
    };
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    if (timeout)
      timer = setTimeout(() => {
        killGroup();
        end({
          code: 124,
          stdout: out,
          stderr: `${err}\n[deadline ${timeout} ms expired — process group killed]`,
          timedOut: true,
        });
      }, timeout);
    const setStall = () => {
      if (!stillMs || finished) return;
      if (stillTimer) clearTimeout(stillTimer);
      stillTimer = setTimeout(() => {
        killGroup();
        end({
          code: 124,
          stdout: out,
          stderr: `${err}\n[stall: ${stillMs} ms without progress — process group killed]`,
          stall: true,
        });
      }, stillMs);
    };
    setStall();
    child.stdout.on("data", (d) => {
      out += d;
      log.trace(d);
      if (onLine || stillMs) {
        rest += d;
        const parts = rest.split("\n");
        rest = parts.pop();
        for (const z of parts) {
          if (onLine) onLine(z);
          if (stillMs && isProgress(z)) setStall();
        }
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
      log.trace(d);
    });
    child.on("error", (e) => end({ code: 127, stdout: "", stderr: String(e.message) }));
    child.on("close", (code) => {
      if (onLine && rest) onLine(rest);
      end({ code: code ?? 1, stdout: out, stderr: err });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Read-only: always runs. `check:true` throws on exit != 0.
export async function probe(cmd, args, opts = {}) {
  const r = await exec(cmd, args, { echo: false, ...opts });
  if (opts.check && r.code !== 0) throw new CommandError(display(cmd, args), r.code, r.stderr);
  return r;
}

// Changing: in a dry run only displayed.
export async function act(cmd, args, opts = {}) {
  if (dryRun) {
    log.cmdLine(`[dry run] ${display(cmd, args)}`);
    return { code: 0, stdout: "", stderr: "", skipped: true };
  }
  const r = await exec(cmd, args, opts);
  if (opts.check !== false && r.code !== 0) throw new CommandError(display(cmd, args), r.code, r.stderr);
  return r;
}

// Shell pipeline (only where really needed, e.g. globs for `node --test`).
export const shProbe = (script, opts) => probe("/bin/sh", ["-c", script], opts);

export async function httpJson(url, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  } catch (e) {
    return { status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export async function httpPost(url, body = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  } catch (e) {
    return { status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Waits until `fn()` returns true. Returns true/false, does not throw.
export async function waitFor(fn, { timeoutMs, everyMs = 2000, label = "" } = {}) {
  const until = Date.now() + timeoutMs;
  let first = true;
  while (Date.now() < until) {
    if (await fn()) return true;
    if (first && label) log.detail(`waiting for ${label} …`);
    first = false;
    await sleep(everyMs);
  }
  return false;
}
