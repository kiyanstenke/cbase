// Gate test of the golden runs: re-records every scenario with the golden harness (golden-harness.mjs - real server,
// fake CLI, own child process per scenario) and compares the four files BYTE-EQUAL with the fixtures under
// server/backend/test/fixtures/golden/<scenario>/: sse.jsonl (streams), db.json (DB rows), spawn.json (every spawn of the
// fake CLI with argv and prompt bytes), hooks.jsonl (every firing of the hook register in call order - the order of the
// consumers).
//
// Red means: an event sequence, a DB row, a prompt byte or the hook order has changed - the message names scenario, file,
// the first deviating line and COLUMN with 80 characters of context in both versions (a prompt line in spawn.json has
// 12,000 characters; showing its head twice would say nothing). Whether the change is wanted is for the human to decide;
// then re-record:
//
//   CBASE_GOLDEN_RECORD=1 CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 node --test server/backend/test/golden-runs.test.js
//
// Re-recording OVERWRITES the fixtures in the tree and sets the statement "this is how the server behaves" to the new
// state - only with a sentence that says WHAT changed and why (snapshots are an alarm, not a lock; never re-record just to
// turn a red test green). The `git diff` of the fixtures is the reading aid: it shows exactly the lines the change in the
// server's behavior caused.
//
// Run time: the limit scenario takes ~5 s, schedule-limit ~2 s, the rest 1-2 s each; the diagnostic per scenario prints the
// seconds, a scenario over 20 s is marked SLOW (a finding, not red).
//
// Run (alone, with the gate deadlines as tools/check/targets/check.mjs):
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SCENARIOS } from "./golden-scenarios.mjs";
import { FILES, FIXTURES, kind, afterSpawnTally } from "./golden-harness.mjs";

const RECORD = process.env.CBASE_GOLDEN_RECORD === "1";
const SLOW_MS = 20_000;

// First deviating line of two texts - for a message that SHOWS the difference instead of "Buffer != Buffer": line, column of
// the first deviating character and a window of 80 characters before and after in both versions (short lines whole).
const SURROUNDINGS = 80;
function firstDeviation(fixture, fresh) {
  const a = fixture.split("\n");
  const b = fresh.split("\n");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined || b[i] === undefined) {
      const short = (s) => (s === undefined ? "<missing>" : s.length > 2 * SURROUNDINGS ? `${s.slice(0, 2 * SURROUNDINGS)} … (${s.length} chars)` : s);
      return `line ${i + 1} (fixture ${a.length} lines, new ${b.length}):\n    fixture: ${short(a[i])}\n    new:     ${short(b[i])}`;
    }
    let sp = 0;
    while (sp < a[i].length && sp < b[i].length && a[i][sp] === b[i][sp]) sp += 1;
    const window = (s) => {
      const from = Math.max(0, sp - SURROUNDINGS);
      const until = Math.min(s.length, sp + SURROUNDINGS);
      return `${from > 0 ? "…" : ""}${s.slice(from, until)}${until < s.length ? "…" : ""}`;
    };
    return `line ${i + 1}, column ${sp + 1} (fixture ${a.length} lines, new ${b.length}; line ${a[i].length} resp. ${b[i].length} chars):\n    fixture: ${window(a[i])}\n    new:     ${window(b[i])}`;
  }
  return `same lines, other bytes (fixture ${fixture.length} chars, new ${fresh.length})`;
}

test("fixtures and scenario table match: one folder per scenario, four files each", () => {
  if (RECORD) return;
  const folder = fs.readdirSync(FIXTURES).filter((n) => fs.statSync(path.join(FIXTURES, n)).isDirectory()).sort();
  assert.deepEqual(folder, SCENARIOS.map((s) => s.name).slice().sort(), "one fixture folder too many or too few under fixtures/golden");
  for (const sz of SCENARIOS) {
    assert.deepEqual(fs.readdirSync(path.join(FIXTURES, sz.name)).sort(), FILES.slice().sort(), `${sz.name}: files in the fixture folder`);
  }
});

const runtimes = [];

for (const sz of SCENARIOS) {
  test(`golden run "${sz.name}" (${sz.purpose}) is byte-equal to the fixture`, async (t) => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), `cbase-golden-${sz.name}-`));
    try {
      const { code, ms, stderr } = await kind(sz.name, target, { stderr: "pipe" });
      runtimes.push({ name: sz.name, ms });
      t.diagnostic(`${sz.name}: ${(ms / 1000).toFixed(1)} s${ms > SLOW_MS ? " - SLOW (over 20 s, a finding)" : ""}`);
      const error = stderr.split("\n").filter((z) => z.includes("[golden]") || z.includes("Error")).join("\n");
      assert.equal(code, 0, `${sz.name}: recording ended with exit ${code}\n${error || stderr}`);
      for (const file of FILES) {
        const newPath = path.join(target, sz.name, file);
        assert.ok(fs.existsSync(newPath), `${sz.name}/${file}: the recording did not write the file`);
        const fixturePath = path.join(FIXTURES, sz.name, file);
        if (RECORD) {
          fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
          fs.copyFileSync(newPath, fixturePath);
          t.diagnostic(`${sz.name}/${file}: fixture rewritten`);
          continue;
        }
        assert.ok(fs.existsSync(fixturePath), `${sz.name}/${file}: fixture missing - CBASE_GOLDEN_RECORD=1 records it`);
        const fixture = fs.readFileSync(fixturePath);
        const fresh = fs.readFileSync(newPath);
        if (!fixture.equals(fresh)) {
          assert.fail(`${sz.name}/${file} differs from the fixture - ${firstDeviation(fixture.toString("utf8"), fresh.toString("utf8"))}`);
        }
      }
    } finally {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (e) { console.warn(`cleanup of ${target} failed (${e.code || e.message})`); }
    }
  });
}

// The run time is a MEASUREMENT line, not a bound: a fixed total would be a statement about the machine (it varies with the
// parallelism and the runner). Whoever slows the runs sees it printed here; the suite does not turn red for it (test clock-counts).
test("run time of the golden runs - measurement line, not a bound", (t) => {
  const total = runtimes.reduce((n, l) => n + l.ms, 0);
  t.diagnostic(`total ${(total / 1000).toFixed(1)} s · ${runtimes.map((l) => `${l.name} ${(l.ms / 1000).toFixed(1)}`).join(" · ")}`);
  assert.equal(runtimes.length, SCENARIOS.length, "not every scenario reported a run time");
});

// The spawn order is the count of the server process at the spawn() call (golden-harness.mjs countSpawns), not the pid: a
// pid counter wrap (99,999 -> small pids) once ordered a wake-call chat before the two oneshots that trigger it. The count
// needs no heuristic. The cases below are the same situations: the pids say something different each time than the numbers,
// and the number wins. The golden runs above are the proof that the wrapper takes hold in the server (without it every
// pid would have no number, and afterSpawnTally would throw).
test("spawn order: by spawn number - neither the pid nor its wrap counts, a pid without a number throws", () => {
  const names = (list, tally) => afterSpawnTally(list, new Map(Object.entries(tally).map(([pid, seq]) => [Number(pid), seq]))).map((p) => p.n);
  assert.deepEqual(names([{ pid: 99_990, n: "categorization" }, { pid: 12, n: "wakeCall" }, { pid: 99_995, n: "extraction" }],
    { 99990: [1], 99995: [2], 12: [3] }), ["categorization", "extraction", "wakeCall"], "the wrap put the later spawn first");
  assert.deepEqual(names([{ pid: 4_990, n: "later" }, { pid: 5_000, n: "previous" }], { 4990: [2], 5000: [1] }), ["previous", "later"],
    "a smaller pid is no earlier spawn - the number decides");
  // The same pid twice (reissued): the k-th start line takes the k-th number.
  assert.deepEqual(names([{ pid: 7, n: "a" }, { pid: 9, n: "b" }, { pid: 7, n: "c" }], { 7: [1, 3], 9: [2] }), ["a", "b", "c"]);
  assert.deepEqual(names([], {}), []);
  assert.throws(() => names([{ pid: 42, n: "stray" }], {}), /pid 42 has no spawn number/, "a process without a number must not be sorted in silently");
});
