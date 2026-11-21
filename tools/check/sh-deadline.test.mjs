// The deadline of `probe`/`act` kills the PROCESS GROUP — not just the child.
//
// Why: `shProbe` starts `/bin/sh -c "node --test …"`, and `node --test` starts one more process
// with a real server per test file. A plain `child.kill("SIGKILL")` hits the shell; the
// grandchildren inherit stdout/stderr, keep the pipes open, `close` never comes — and the
// promise is never settled.
//
// So the promise is not "the command gets a signal" but: AFTER the deadline the run has ended
// AND no grandchild is still running. Both are measured here, the second through a unique
// marker in the grandchild's command line.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { probe } from "./lib/sh.mjs";

// A unique marker per run: `pgrep -f` searches for it, and nothing else on the system carries it.
const marker = `cbase-deadline-probe-${process.pid}`;

function runningStill(who = marker) {
  try {
    // pgrep exits with 1 when nothing matches — execFileSync then throws.
    const out = execFileSync("/usr/bin/pgrep", ["-f", who], { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("deadline: a grandchild that keeps stdout open still ends the run", async (t) => {
  // The shell starts a grandchild in the background (inherits stdout) and then sleeps itself. Exactly
  // the shape `node --test` produces. Killing only the shell would leave the grandchild — and so the
  // pipe — alive; the old body hung here until the caller's deadline.
  const script = `node -e 'process.title=${JSON.stringify(marker)}; setTimeout(()=>{}, 120000)' ${marker} & sleep 120`;
  const start = Date.now();
  const r = await probe("/bin/sh", ["-c", script], { timeout: 1500 });
  const duration = Date.now() - start;
  t.diagnostic(`measured: exit ${r.code} after ${duration} ms, deadline 1500 ms`);

  assert.equal(r.code, 124, "an expired deadline is exit 124, not the command's exit code");
  assert.equal(r.timedOut, true, "the caller must be able to tell a deadline from a real failure");
  // That the deadline hits the whole GROUP is proven by the next test without a clock: no grandchild survives (pgrep).
  assert.match(r.stderr, /deadline .* expired/, "the message must say the deadline took effect");
});

test("deadline: after the kill no grandchild is running", async (t) => {
  const script = `node -e 'setTimeout(()=>{}, 120000)' ${marker} & sleep 120`;
  await probe("/bin/sh", ["-c", script], { timeout: 1200 });
  // The kill is asynchronous; look briefly, not for long.
  await new Promise((r) => setTimeout(r, 400));
  const leftOver = runningStill();
  t.diagnostic(`measured: ${leftOver} processes with the marker after the deadline`);
  assert.equal(leftOver, 0, "the deadline must hit the whole group — a surviving grandchild keeps the pipe open");
});

test("without a deadline, and when ending in time, nothing changes", async () => {
  const fast = await probe("/bin/sh", ["-c", "echo hallo; exit 3"], { timeout: 20000 });
  assert.equal(fast.code, 3, "a command that ends before the deadline keeps its exit code");
  assert.equal(fast.timedOut, undefined, "without an expired deadline there is no deadline flag");
  assert.match(fast.stdout, /hallo/);

  const without = await probe("/bin/sh", ["-c", "echo without-deadline"]);
  assert.equal(without.code, 0);
  assert.match(without.stdout, /without-deadline/, "a run without a deadline runs unchanged");
});

// The flip side of the own process group, and the reason for the signal wiring in `sh.mjs`:
// an own group does NOT inherit the session's Ctrl-C. Without a holder the deadline fix would be
// a regression — an aborted deploy would let its test runs go on. Measured here with the REAL
// signal, not with the presence of a handler.
test("Ctrl-C takes the grandchildren along although they sit in their own group", async (t) => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");

  const shPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib/sh.mjs");
  const grandchildMarker = `cbase-deadline-signal-${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-deadline-"));
  const helper = path.join(dir, "helper.mjs");
  // The helper is a deploy in miniature: it starts a long run WITH a deadline and waits.
  fs.writeFileSync(
    helper,
    `import { probe } from ${JSON.stringify(shPath)};\n` +
      `console.log("STARTED");\n` +
      `await probe("/bin/sh", ["-c", "node -e 'setTimeout(()=>{},120000)' ${grandchildMarker} & sleep 120"], { timeout: 90000 });\n`,
  );

  const subprocess = spawn(process.execPath, [helper], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((ok, fail) => {
      const clock = setTimeout(() => fail(new Error("the helper did not report")), 20000);
      subprocess.stdout.on("data", (d) => {
        if (String(d).includes("STARTED")) {
          clearTimeout(clock);
          ok();
        }
      });
    });
    // Wait briefly until the grandchild really stands — otherwise the test measures the start, not the signal.
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(runningStill(grandchildMarker) > 0, "the grandchild is not running — the test measures nothing");

    subprocess.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 1200));
    const leftOver = runningStill(grandchildMarker);
    t.diagnostic(`measured: ${leftOver} grandchildren after SIGINT to the foreground`);
    assert.equal(leftOver, 0, "a Ctrl-C must take the own group along — otherwise the test run survives the abort");
  } finally {
    try {
      subprocess.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      for (const p of execFileSync("/usr/bin/pgrep", ["-f", grandchildMarker], { encoding: "utf8" }).trim().split("\n").filter(Boolean)) {
        try { process.kill(Number(p), "SIGKILL"); } catch { /* ignore */ }
      }
    } catch {
      /* nothing left */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
