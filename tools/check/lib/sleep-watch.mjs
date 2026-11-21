// Did the machine sleep while the suites ran? On macOS `kern.sleeptime` is the time of the last system sleep; a different value
// after the suites means it slept in between. Every deadline in the tests (child caps, waits, stall rules) kept running in wall time
// while the processes stood still, so the red rows that follow are about the sleep, not about the code (seen 21.11.2026: a Mac on
// battery slept for seven hours, each case of a test file took 15 min and three failed on "cap of 120 s reached" for a `df`).
// Other platforms: null — nothing measured, nothing claimed.
import { spawnSync } from "node:child_process";

export function lastSleep({ platform = process.platform, read = () => spawnSync("/usr/sbin/sysctl", ["-n", "kern.sleeptime"], { encoding: "utf8", timeout: 2000 }).stdout } = {}) {
  if (platform !== "darwin") return null;
  const m = /sec = (\d+)/.exec(String(read() || ""));
  return m ? Number(m[1]) : null;
}

/** true only when both readings exist and differ. */
export const sleptBetween = (before, after) => before != null && after != null && after !== before;

export const SLEPT_REASON = "the Mac slept while the suites ran (kern.sleeptime changed): deadlines in the tests ran on in wall time, "
  + "these results say nothing about the code — run the gate again with the machine awake (lid open, ideally on power)";
