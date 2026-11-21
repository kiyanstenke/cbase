// The state lock of the fake docker (fake-docker.mjs `withState`) survives a caller that kills it at ANY point.
//
// The product kills its docker child whenever a deadline or the output cap strikes (runtime/git-run.js → runtime/inProject.js
// `.kill`). The output cap strikes right after the exec's command ended — exactly when the fake passes on the last output and then
// deregisters the process under its state lock. A fake killed there with `mkdir` + write + `rm -r` could leave the lock folder WITHOUT
// its `holders` file (after the mkdir, or inside the recursive delete); `cleanOrphanedLock` cannot tell such a lock from a live one,
// and every later call spins on it forever. git-view-detail.test.js met it in the gate: the call after the cut diff of `large.txt`
// ran into its 20 s deadline (504 READ_TIME instead of 409 NO_MAIN_BRANCH), with the lock folder standing holder-less all along.
//
// The promise: at every point of the lock (`LOCK_DIE_POINTS`, the seam FAKE_DOCKER_DIE_AT ends the fake there with SIGKILL) what it
// leaves is either no lock or a lock that names its dead holder — and the next call runs.
// COUNTER-TEST: the old `withState` (mkdir, then write `holders`, then `rm -r`) with the seam at "built" right after the mkdir turns
// this red ("lock without holder"); with the seam at "handed-back" between unlinking `holders` and removing the folder, too.
// No time limit: a lock that is not released makes the next call hang, and the assertion before it already says why.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCK_DIE_POINTS, fakeDocker } from "./fake-docker.mjs";

test("a fake docker killed at any point of its state lock leaves no lock the next call cannot take", async (t) => {
  const fd = await fakeDocker();
  try {
    const env = { ...process.env, ...fd.env };
    const lock = path.join(fd.dir, "daemon", "host", "lock");
    assert.ok(LOCK_DIE_POINTS.length >= 4, `the seam names its points (${LOCK_DIE_POINTS.join(", ")})`);
    for (const point of LOCK_DIE_POINTS) {
      // `run` writes the daemon's state, so it takes the lock; the seam ends it at `point` of the first take.
      const child = spawn(fd.bin, ["run", "-d", "--name", `killed-${point}`, "cbase-projectbox:test"], { env: { ...env, FAKE_DOCKER_DIE_AT: point }, stdio: "ignore" });
      const [, signal] = await new Promise((resolve) => child.once("exit", (code, sig) => resolve([code, sig])));
      // The seam struck (otherwise this point was never walked and the rest proves nothing).
      assert.equal(signal, "SIGKILL", `${point}: the fake was not killed at the point`);
      if (fs.existsSync(lock)) {
        const holder = fs.existsSync(path.join(lock, "holders")) ? fs.readFileSync(path.join(lock, "holders"), "utf8") : null;
        assert.ok(holder, `${point}: lock without holder — cleanOrphanedLock cannot release it, every later call spins`);
        assert.ok(Number(holder) > 1, `${point}: holder "${holder}"`);
      }
      t.diagnostic(`${point}: lock left ${fs.existsSync(lock) ? "with its dead holder" : "none"}`);
      // The next call takes the lock and writes.
      execFileSync(fd.bin, ["run", "-d", "--name", `after-${point}`, "cbase-projectbox:test"], { env, stdio: "ignore" });
      assert.ok(Object.values(fd.state("host").container).some((c) => c.name === `after-${point}`), `${point}: the next call did not run`);
      assert.equal(fs.existsSync(lock), false, `${point}: the lock still stands after the next call`);
    }
  } finally {
    fd.cleanUp();
  }
});
