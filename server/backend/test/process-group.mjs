// Whether a process or a process group is alive - without zombies. A helper of the tests, not a test file (the gate's glob is
// `*.test.js`).
//
// WHY. `process.kill(-pgid, 0)` succeeds as long as the group has any member - even if the only one is a ZOMBIE (an ended
// process its parent has not reaped yet). In a container without `--init` nobody reaps the orphans of a detached service: a
// `waitForTruthy(() => !alive(-pgid))` waits forever there although the service ended long ago (measured on macOS with perl: child
// `setpgrp` + `exit`, parent sleeps => `kill(-g, 0)` true, `ps` shows `Z`). The same rule as `wrapperEnded` in
// projectbox-ops.test.js for single pids: alive means "exists and is not a zombie".
//
//   processAlive(pid)   `kill -0` succeeds (or EPERM) AND `ps -o stat= -p <pid>` does not start with Z.
//   groupAlive(pgid)    `ps -A -o pgid=,stat=` shows at least one member of the group that is not a zombie.
// Guard: projectbox-services.test.js "RP9-8" (a group made only of a zombie => groupAlive false, `kill(-G, 0)` true).
import { execFileSync } from "node:child_process";

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  try {
    return !/^Z/.test(execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch { return false; } // ps exits with 1 if the pid does not (or no longer) exist
}

export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  const list = execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const row of list.split("\n")) {
    const [g, stat] = row.trim().split(/\s+/);
    if (Number(g) === pgid && stat && !stat.startsWith("Z")) return true;
  }
  return false;
}
