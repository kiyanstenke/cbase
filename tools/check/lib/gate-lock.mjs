// Only one gate at a time — machine-wide, not per working tree.
//
// Several sessions work on this Mac at once, each in its own worktree, and each may run `./check`. Two full
// gates side by side mean two backend suites with ten real servers each plus a fake CLI on 14 cores — and then the
// verdicts fluctuate: a test that waits for its events gets them in a different order under double load. The formula
// for the parallelism cannot compensate: it measures the load at start, the second gate joins later. So the second
// gate waits until the first is done and says so in one line.
//
// The lock is a file with the pid of the holder. Three decisions, each from a trap:
//
//  - **Location `/tmp`, not `os.tmpdir()`.** `TMPDIR` is per user on macOS and comes from the environment — a session
//    that sets it differently would see a second, empty lock. `/tmp` exists exactly once per machine. Only where it
//    is missing does the choice fall back to `os.tmpdir()`.
//  - **A lock with a dead process is free.** An aborted gate (Ctrl-C, SIGKILL, crash) does not clean up — a lock that
//    then held forever would be worse than none. Dead means: `kill(pid, 0)` does not find it, OR another process
//    runs under that pid (the start time from `ps` differs). The second is no cosmetic flaw: macOS wraps pids after
//    99,999, and a suite spawns tens of thousands.
//  - **It is created atomically WITH content** (`link` of a fully written file, not `open wx` and then write).
//    Otherwise a second gate in the window between would see an empty file, take it for unreadable and thus free —
//    and clear the first gate's lock.
//
// What it does NOT do: two gates that clear the same DEAD lock at the same instant can both get through
// (microseconds lie between the second read and the delete). Without a kernel lock (Node has no flock) that is the
// limit; it only hits the case "dead gate AND two new ones at once". The pre-push hook (`check --quick`) never takes
// the lock: it runs no suites, and a five-second quick check should not wait behind eleven minutes of someone
// else's gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const LOCK = path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "cbase.gate.lock");
// How often a waiting gate looks again. No test depends on this number — the tests pass in their own
// `sleep`, which waits for an event instead of the clock.
export const CHECK_BACK_MS = 2000;

// Is the process alive? EPERM means "it exists, it just belongs to someone else" — so it is alive.
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// The start time of a process as `ps` prints it (one-second resolution). It turns "something runs under this
// pid" into "the SAME process runs under this pid". `null` if `ps` knows nothing or is missing — then the
// liveness check stands alone.
//
// ALWAYS with a fixed locale and time zone: `ps -o lstart=` prints the same start time differently per session —
// without LANG "Sun Sep 27 03:29:12 2026", with LANG=en_NZ.UTF-8 "Sun 27 Sep 03:29:12 2026", with TZ=UTC two hours
// earlier. A gate from the terminal (LANG set) and one from a desktop app (no LANG) would each take the other's
// lock for "reused", clear it and run side by side again.
const PS_ENVIRONMENT = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
export function startOf(pid) {
  try {
    const s = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: PS_ENVIRONMENT }).trim();
    return s || null;
  } catch {
    return null;
  }
}

/**
 * The pure decision about a read lock content: free or occupied, and why.
 * `raw` is the file content or `null` (no file). The second argument supplies `alive(pid)` and
 * `startOf(pid)` — faked in the test, the real ones in the gate.
 */
export function lockState(raw, { alive: aliveFn = alive, startOf: startFn = startOf } = {}) {
  if (raw == null) return { free: true, reason: "no" };
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    // Creation is atomic with content — an unreadable content cannot be a live holder.
    return { free: true, reason: "unreadable" };
  }
  const pid = Number(s?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { free: true, reason: "unreadable" };
  if (!aliveFn(pid)) return { free: true, reason: "tot", pid };
  if (s.start) {
    const now = startFn(pid);
    if (now && now !== s.start) return { free: true, reason: "reused", pid };
  }
  return { free: false, reason: "occupied", pid, since: s.since || null, who: s.who || "" };
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Create atomically: write a finished file beside it, then `link` — that fails with EEXIST if the lock
// already exists, and otherwise creates a file that is complete from the first byte.
function createOne(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}

// Delete a free (dead, unreadable) lock only if it is still the SAME one we read — if another gate has
// taken it meanwhile, it is theirs.
function cleanIfEqual(file, raw) {
  if (read(file) !== raw) return;
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

/**
 * Take the lock — and wait while a live gate holds it.
 *
 *   report(state)    once per new holder while waiting (the ONE line in the log)
 *   sleep()          between two looks; in the gate CHECK_BACK_MS, in the test an event
 *   who              is stored in the lock so the waiting line can say WHERE the other gate runs
 *
 * Result: `{ taken: true, waited, takenOver, release }` — or `{ taken: false, reason }` if no lock can be
 * created at all (no write permission, foreign owner of a dead lock in the sticky /tmp). Then the gate
 * continues WITHOUT a lock: a guard against load must not stop the gate itself, and the caller says so
 * in the table.
 */
export async function takeLock({
  file = LOCK,
  who = "",
  report = () => {},
  sleep = () => new Promise((r) => setTimeout(r, CHECK_BACK_MS)),
  check = { alive, startOf },
  me = { pid: process.pid, start: startOf(process.pid) },
} = {}) {
  const content = JSON.stringify({ pid: me.pid, start: me.start, since: new Date().toISOString(), who });
  const begin = Date.now();
  let reported = null;
  let waited = false;
  let takenOver = null;
  for (;;) {
    let raw;
    try {
      if (createOne(file, content)) break;
      raw = read(file);
    } catch (e) {
      return { taken: false, reason: `${path.basename(file)} cannot be created: ${e.code || e.message}` };
    }
    const z = lockState(raw, check);
    // The own pid with the same start time is a leftover of THIS process (a second check() in the same
    // run) — waiting for oneself would mean forever.
    const own = !z.free && z.pid === me.pid;
    if (z.free || own) {
      if (raw != null) {
        if (z.pid) takenOver = { pid: z.pid, reason: own ? "own" : z.reason };
        try {
          cleanIfEqual(file, raw);
        } catch (e) {
          return { taken: false, reason: `old lock of pid ${z.pid ?? "?"} cannot be cleared: ${e.code || e.message}` };
        }
      }
      continue;
    }
    waited = true;
    if (reported !== z.pid) {
      report(z);
      reported = z.pid;
    }
    await sleep(z);
  }
  let free = false;
  const release = () => {
    if (free) return;
    free = true;
    process.removeListener("exit", release);
    try {
      if (read(file) === content) fs.unlinkSync(file);
    } catch {
      /* already gone or no longer ours — both mean free */
    }
  };
  // An ordinary end (also a throw all the way up) releases; death by signal does not — that is what
  // "dead is free" is for.
  process.on("exit", release);
  return { taken: true, waited, waitTimeMs: waited ? Date.now() - begin : 0, takenOver, release, file };
}
