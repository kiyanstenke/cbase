// The gate's suites abort on SILENCE, not on duration.
//
// A suite that runs steadily but longer than a total deadline must not be aborted. The rule (lib/gate-plan.mjs `suiteDeadlines`):
// abort when no test result appears on the TAP stream for a while (lib/test-output.mjs `isTapResult`); the total duration only
// has an emergency cap.
//
// Measured on staged suites with small numbers (the real ones: 180 s / 1 h), through the same path as in check.mjs
// (`shProbe` with `stall: { ms, progress: isTapResult }`):
//   1. a suite that reports results steadily runs past the old total deadline — COUNTER-TEST: the same suite under the old
//      rule (only `timeout`) is aborted;
//   2. a suite that goes silent dies after the silence — with a message and WITHOUT a surviving grandchild;
//   3. a suite that writes but no results (comments, subtest headers) counts as silent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shProbe } from "./lib/sh.mjs";
import { isTapResult, valuesSuite } from "./lib/test-output.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stall-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fake(name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

// Steady: one result every 50 ms, 80 of them (≥ 4 s), then the totals.
const STEADY = fake(
  "steady.mjs",
  `let i = 0;
process.stdout.write("TAP version 13\\n");
const tick = setInterval(() => {
  i++;
  process.stdout.write("# Subtest: t" + i + "\\nok " + i + " - t" + i + "\\n  ---\\n  duration_ms: 50\\n  ...\\n");
  if (i === 80) { clearInterval(tick); process.stdout.write("1..80\\n# tests 80\\n# pass 80\\n# fail 0\\n# skipped 0\\n"); }
}, 50);
`,
);

const pgrep = (marker) => {
  try {
    return execFileSync("/usr/bin/pgrep", ["-f", marker], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
// The kill is asynchronous: look until nothing is left — at most 10 s, then what remains counts.
async function leftOverAfterKill(marker) {
  const until = Date.now() + 10_000;
  while (pgrep(marker) > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return pgrep(marker);
}

test("a suite that reports results steadily runs past the old total deadline", async (t) => {
  const start = Date.now();
  const r = await shProbe(`node ${JSON.stringify(STEADY)}`, { timeout: 120_000, stall: { ms: 3000, progress: isTapResult } });
  const duration = Date.now() - start;
  t.diagnostic(`measured: exit ${r.code} after ${duration} ms, silence 3000 ms`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stall, undefined);
  assert.equal(r.timedOut, undefined);
  assert.equal(valuesSuite("Backend", r.stdout, r.code).red, false);
  // COUNTER-TEST, the old rule: a total deadline below the runtime aborts the same steady suite.
  const old = await shProbe(`node ${JSON.stringify(STEADY)}`, { timeout: Math.max(500, Math.floor(duration / 2)) });
  assert.equal(old.timedOut, true, "the counter-test measures nothing: the old total deadline would have let the suite through");
  assert.equal(old.code, 124);
});

test("a suite that goes silent dies after the silence — with a message, no surviving grandchild", async (t) => {
  const marker = `cbase-stall-probe-${process.pid}`;
  // Like `node --test`: the shell starts a grandchild that inherits stdout, and the stream goes silent in the middle of a group.
  const script = `printf 'TAP version 13\\n# Subtest: erster\\nok 1 - erster\\n# Subtest: gruppe\\n    # Subtest: kind eins\\n    ok 1 - kind eins\\n'; `
    + `node -e 'setTimeout(()=>{}, 120000)' ${marker} & sleep 120`;
  try {
    const r = await shProbe(script, { timeout: 110_000, stall: { ms: 1000, progress: isTapResult } });
    t.diagnostic(`measured: exit ${r.code}, stall=${r.stall}`);
    assert.equal(r.code, 124);
    assert.equal(r.stall, true, "the silence must be reported as a stall, not as the total deadline");
    assert.equal(r.timedOut, undefined);
    assert.match(r.stderr, /stall: 1000 ms without progress — process group killed/);
    assert.equal(await leftOverAfterKill(marker), 0, "the silence must hit the whole group — a surviving grandchild keeps the pipe open");
    const u = valuesSuite("Backend", r.stdout, r.code, { abort: { kind: "stall", ms: 180_000 } });
    assert.equal(u.red, true);
    assert.equal(u.line, "Stall: 180 s without a test result — aborted after 1 reported tests; last reported: „kind eins“; open: „gruppe“");
  } finally {
    for (const p of (() => { try { return execFileSync("/usr/bin/pgrep", ["-f", marker], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } })()) {
      try { process.kill(Number(p), "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("output without a result is silence: comments and subtest headers do not hold up the deadline", async () => {
  const LOUD = fake(
    "loud.mjs",
    `setInterval(() => process.stdout.write("# Subtest: hangs\\n# still here\\n"), 50);\n`,
  );
  const r = await shProbe(`node ${JSON.stringify(LOUD)}`, { timeout: 110_000, stall: { ms: 1000, progress: isTapResult } });
  assert.equal(r.stall, true, "a suite that writes only comments held up the stall deadline");
  assert.match(r.stdout, /# still here/, "the fixture wrote nothing — then the guard measures nothing");
});
