// ONE gate per run state at a time: the guard against a duplicate completion verdict.
//
// Defect: under load two `workflowGateAfterRun` calls ran SIDE BY SIDE on the same run with the same
// prompt. The entry check (`run.status !== "running"`) is synchronous, the verdict behind it takes
// seconds, `runStillOur` only applies AFTER the verdict, and the first caller ends the run only after
// its own verdict. Under normal load the verdict is fast enough for the entry check to catch the
// second call, so the race showed only under load: two paid model calls, two verdicts, two possible ends.
//
// `workflowGateAfterRun` (workflows/gates.js) therefore holds one claim per chat, bound to the STATE of
// the run (id, status, step, cursor, generation), set BEFORE the verdict and released in `finally`; a
// second caller gets a console line and nothing else while the holder still owns the run. This file
// forces the races DETERMINISTICALLY instead of under load: a fake judge with adjustable duration, two
// calls in the same tick. The judge duration is NOT a condition of the race (both calls sit in the same
// synchronous section); it only keeps the holder visible long enough.
//
// Counter-test map: without the claim, test 1 is red at "judge calls 2" (the gate row stays at 1
// there too, because runStillOur catches the second call AFTER its verdict, but it was paid for). With
// a claim per CHAT only, test 4 is red: the successor run stays on "running" without a gate. The park
// path of the claim (parkJudge, auto-continue on) has no case here; the finally is path-independent.
// Test 4 steers its judges through APPROVAL FILES, not time (no clocks; the harness awaits ALL started
// gates in the finally, otherwise a still-running one writes into the deleted database).
// No server: real store in a temp directory, the gate straight from workflows/gates.js; the path from
// turn to gate (hook) belongs to the golden runs. The verdict runs sandboxed (runs/sandboxing.js: cwd
// DIRS.empty), so without startServer the harness sets DIRS itself with an empty temp folder and
// restores the previous state in the finally.
//
// This file imports NO other test file; `ripcord.mjs` is harness.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import * as wf from "../electron/server/workflows.js";
import { cancelWorkflow, workflowGateAfterRun } from "../electron/server/workflows/gates.js";
import { logRunStep, runStepStart } from "../electron/server/workflows/run-state.js";
import { RIPCORD } from "./ripcord.mjs";

// The fake judge: reads the prompt, answers "done". Each call leaves a line in the log file; the
// number of lines is the number of paid verdicts. Two modes:
//   ms   — waits a fixed time (tests 1-3: the duration is no condition, see header).
//   free — waits for an APPROVAL FILE `<dir>/<n>` (n = its number in the log file). The test decides
//          WHO finishes WHEN without a clock.
const fakeRichter = ({ ms = 0, free = "" } = {}) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
${RIPCORD}
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  let n = 0;
  try {
    fs.appendFileSync(process.env.CBASE_TEST_VERDICTS, stdin.slice(0, 200).replace(/\\s+/g, " ") + "\\n");
    n = fs.readFileSync(process.env.CBASE_TEST_VERDICTS, "utf8").split("\\n").filter(Boolean).length;
  } catch {}
  const responses = () => {
    process.stdout.write(JSON.stringify({ result: '{"done": true, "note": ""}' }));
    clearTimeout(guard);
    process.exit(0);
  };
  const free = ${JSON.stringify(free)};
  if (!free) return setTimeout(responses, ${ms});
  const marker = path.join(free, String(n));
  const wait = () => (fs.existsSync(marker) ? responses() : setTimeout(wait, 20));
  wait();
});
`;

const graph = {
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
    { id: "e0", type: "end", title: "End", x: 440, y: 0 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "e0" }],
};

const REAL_ERROR = console.error;
async function withRun(fn, { richterMs = 700, richterFree = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-claim-"));
  const bin = path.join(dir, "claude");
  const approvals = path.join(dir, "free");
  fs.mkdirSync(approvals);
  fs.writeFileSync(bin, fakeRichter(richterFree ? { free: approvals } : { ms: richterMs }));
  fs.chmodSync(bin, 0o755);
  const verdicts = path.join(dir, "verdicts.log");
  const prev = { bin: process.env.CLAUDE_BIN, verdicts: process.env.CBASE_TEST_VERDICTS, dirs: DIRS };
  fs.mkdirSync(path.join(dir, "empty"));
  setDirs({ ...(DIRS || {}), empty: path.join(dir, "empty") });
  process.env.CLAUDE_BIN = bin;
  process.env.CBASE_TEST_VERDICTS = verdicts;
  const consoleLog = [];
  console.error = (...a) => { consoleLog.push(a.map(String).join(" ")); };
  // All gates a test starts without awaiting them at once: at the end (even after a failure) all
  // judges are released and all gates awaited BEFORE the directory goes away; otherwise a still-running
  // gate writes into a deleted database ("attempt to write a readonly database").
  const open = [];
  const counted = () => { try { return fs.readFileSync(verdicts, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  try {
    fs.mkdirSync(path.join(dir, "data"));
    store.initStore(path.join(dir, "data"));
    const now = Date.now();
    const ws = store.createWorkspace({ id: "ws1", name: "W", path: dir, createdAt: now });
    const chat = store.createChat({ id: "chat-gate", workspaceId: ws.id, title: "Gate", createdAt: now, updatedAt: now });
    const flow = store.createWorkflow({ id: "wf1", workspaceId: ws.id, name: "Gate race", graph, createdAt: now, updatedAt: now });
    // A run standing on n1 whose turn has already RUN: exactly the situation in which the gate is called.
    const newRun = (id, input) => {
      const cursor = wf.advance(graph, wf.initialCursor(graph, input));
      assert.equal(cursor.at, "n1");
      const run = store.startWorkflowRun({ id, chatId: chat.id, workflowId: flow.id, workflowName: flow.name, input, cursor, workspaceId: ws.id });
      store.updateWorkflowRun(chat.id, { step: 1, nodeId: "n1", nodeTitle: "Work" });
      return run;
    };
    const run = newRun("run1", "go");
    const denied = () => consoleLog.filter((z) => /gate already running/.test(z));
    // Release judge no. n (richterFree only).
    const approve = (n) => fs.writeFileSync(path.join(approvals, String(n)), "");
    // Wait until the n-th judge has STARTED (its log line exists): a condition, not a clock. No deadline:
    // the emergency stop is the suite deadline, and every 30 s a stderr line names the situation.
    const untilRichter = async (n) => {
      const t0 = Date.now();
      let reported = 0;
      while (counted() < n) {
        const tick = Math.floor((Date.now() - t0) / 30_000);
        if (tick > reported) {
          reported = tick;
          process.stderr.write(`[waiting] for ${tick * 30} s: judge ${n} starting — judge ${counted()}, console ${JSON.stringify(consoleLog)}\n`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const gate = (text) => { const p = workflowGateAfterRun(chat, text); open.push(p); return p; };
    return await fn({ chat, run, newRun, verdicts: counted, console: consoleLog, denied, approve, untilRichter, gate });
  } finally {
    if (richterFree) for (let n = 1; n <= 12; n++) { try { fs.writeFileSync(path.join(approvals, String(n)), ""); } catch {} }
    await Promise.allSettled(open);
    console.error = REAL_ERROR;
    setDirs(prev.dirs);
    if (prev.bin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev.bin;
    if (prev.verdicts === undefined) delete process.env.CBASE_TEST_VERDICTS; else process.env.CBASE_TEST_VERDICTS = prev.verdicts;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (e) { console.warn("[workflow-gate-claim] cleanup:", e?.message || e); }
  }
}
const followUp = (runId) => store.listRunSteps(runId).map((s) => s.kind + (s.kind === "step" && s.detail?.ok === undefined ? "(open)" : "")).join(" → ");

test("two gates in the same tick on the same run: ONE paid verdict, ONE end; the second call gets nothing", async (t) => {
  await withRun(async ({ chat, run, verdicts, denied }) => {
    const t0 = Date.now();
    await Promise.all([
      workflowGateAfterRun(chat, "ERLEDIGT: the work"),
      workflowGateAfterRun(chat, "ERLEDIGT: the work"),
    ]);
    const steps = store.listRunSteps(run.id);
    const gates = steps.filter((s) => s.kind === "gate");
    t.diagnostic(`judge calls ${verdicts()}, gate rows ${gates.length}, rejected ${denied().length}, duration ${Date.now() - t0} ms, step sequence ${followUp(run.id)}`);
    // What tells the guarded state from the unguarded one: the judge and the console line. Rows, end and
    // status are invariants the unguarded state meets too (runStillOur after the verdict, finishWorkflow
    // is idempotent).
    assert.equal(verdicts(), 1, "the judge was paid more than once");
    assert.equal(denied().length, 1, `the second call does not say it is dropped: ${JSON.stringify(denied())}`);
    assert.match(denied()[0], new RegExp(chat.id));
    assert.equal(gates.length, 1, `expected one gate verdict, got ${gates.length}; step sequence ${followUp(run.id)}`);
    assert.equal(gates[0].detail?.done, true);
    assert.equal(steps.filter((s) => s.kind === "end").length, 1, "exactly ONE end");
    assert.equal(store.getWorkflowRun(chat.id)?.status, "done");
  });
});

test("the claim is free after the gate: a NEW run of the same chat is judged again", async (t) => {
  await withRun(async ({ chat, newRun, verdicts, denied }) => {
    await workflowGateAfterRun(chat, "ERLEDIGT: first run");
    assert.equal(store.getWorkflowRun(chat.id)?.status, "done");
    const run2 = newRun("run2", "again");
    await workflowGateAfterRun(chat, "ERLEDIGT: second run");
    const gates2 = store.listRunSteps(run2.id).filter((s) => s.kind === "gate");
    t.diagnostic(`second run: gate rows ${gates2.length}, judge calls total ${verdicts()}`);
    assert.equal(gates2.length, 1, "the second run got no verdict; the claim stayed stuck");
    assert.equal(verdicts(), 2);
    assert.equal(store.getWorkflowRun(chat.id)?.status, "done");
    assert.equal(denied().length, 0, "no call was rejected");
  }, { richterMs: 50 });
});

test("the claim is released on a throw in the gate too, BEHIND the paid verdict, not before the claim", async (t) => {
  await withRun(async ({ chat, verdicts, denied }) => {
    // The throw sits where it does not exist without a claim: only once the judge is paid (a log
    // line exists) does the chat throw on the next access to its id; that is `runStillOur(chat.id,
    // run)` after `await judgeNodeDone`, hence necessarily inside the try. (Counting accesses would
    // be no measurement: a harmless `chat.id` line BEFORE the claim would move the throw outside and
    // the test would stay silently green.)
    const broken = {
      get id() { if (verdicts() >= 1) throw new Error("throw in the gate (test)"); return chat.id; },
      workspaceId: chat.workspaceId,
    };
    await assert.rejects(() => workflowGateAfterRun(broken, "DONE"), /throw in the gate/);
    t.diagnostic(`judge calls before the throw ${verdicts()}`);
    assert.equal(verdicts(), 1, "the throw must lie BEHIND the verdict, otherwise the test does not measure the finally");
    assert.equal(store.getWorkflowRun(chat.id)?.status, "running", "the throw left the run open, as intended; the gate wrote nothing");
    // Same run, real object: if the claim still hung, this would be rejected.
    await workflowGateAfterRun(chat, "ERLEDIGT: afterwards");
    assert.equal(denied().length, 0, `the claim stayed stuck after the throw: ${JSON.stringify(denied())}`);
    assert.equal(verdicts(), 2);
    assert.equal(store.getWorkflowRun(chat.id)?.status, "done", `run did not end: ${JSON.stringify(store.getWorkflowRun(chat.id))}`);
  }, { richterMs: 50 });
});

// The case a claim per chat alone gets wrong: gate A hangs in the judge, the human cancels the run and
// starts a new one in the same chat, its turn ends, gate B calls. With a claim per chat B got nothing,
// A wrote nothing at runStillOur: run 2 stood on "running" without a gate, without a driver, with an
// open step row, and the only trace was a console line. The claim is therefore bound to the STATE: a
// holder whose run is no longer its own holds nothing. And when A returns while B is still judging, A
// must not clear B's claim (own marker); a third call C in exactly that window must be rejected.
// The judges wait for APPROVALS, not time: the test decides who finishes when.
test("an orphaned holder holds nothing: cancel + new run during the verdict; the successor gets its gate", async (t) => {
  await withRun(async ({ chat, run, newRun, verdicts, denied, approve, untilRichter, gate }) => {
    const gateA = gate("ERLEDIGT: run 1");
    await untilRichter(1); // A now hangs in the judge and stays there until we release it.
    assert.equal(store.getWorkflowRun(chat.id)?.status, "running");
    // The human cancels (no turn running, so finishWorkflow at once) and restarts.
    assert.equal(await cancelWorkflow(chat), true);
    assert.equal(store.getWorkflowRun(chat.id)?.status, "cancelled");
    const run2 = newRun("run2", "again");
    // Like driveWorkflow: open step row + runStepStart for the turn of run 2 ...
    const stepRow = logRunStep(run2, "step", { nodeId: "n1", nodeTitle: "Work", step: 1, detail: { type: "instruction", prompt: "DO THE WORK" } });
    runStepStart.set(chat.id, { rowId: stepRow, at: Date.now(), runId: run2.id });
    // ... whose turn ends while A still hangs: gate B.
    const gateB = gate("ERLEDIGT: run 2");
    await untilRichter(2); // B is judging; it was NOT rejected.
    assert.equal(denied().length, 0, `gate B was rejected although A is orphaned: ${JSON.stringify(denied())}`);
    // A returns, sees a foreign run, writes nothing ...
    approve(1);
    await gateA;
    assert.equal(store.getWorkflowRun(chat.id)?.status, "running", "A touched the foreign run 2");
    assert.equal(store.listRunSteps(run.id).filter((s) => s.kind === "gate").length, 0, "A wrote into the cancelled run 1");
    // ... and does NOT clear B's claim: a third call while B is judging is rejected. (With a finally
    // without marker C would get through and pay a third judge.)
    const gateC = gate("ERLEDIGT: run 2, once more");
    assert.equal(denied().length, 1, `C should have been rejected; B still holds the run: ${JSON.stringify(denied())}`);
    assert.equal(verdicts(), 2, "C paid a third judge");
    approve(2);
    await Promise.all([gateB, gateC]);
    const afterB = store.getWorkflowRun(chat.id);
    t.diagnostic(`after A/B/C: run 2 ${afterB?.status}, step sequence ${followUp(run2.id)}, run 1 ${followUp(run.id)}, judge calls ${verdicts()}, rejected ${denied().length}`);
    assert.equal(verdicts(), 2, "a third judge was paid");
    assert.equal(afterB?.status, "done", `run 2 stayed without a gate: ${followUp(run2.id)}`);
    assert.equal(store.listRunSteps(run2.id).filter((s) => s.kind === "gate").length, 1);
    assert.equal(runStepStart.has(chat.id), false, "the step row of run 2 stayed open");
    // And the claim is free: a third run is judged.
    newRun("run3", "third");
    const gateD = gate("ERLEDIGT: run 3");
    await untilRichter(3);
    approve(3);
    await gateD;
    assert.equal(denied().length, 1);
    assert.equal(store.getWorkflowRun(chat.id)?.status, "done");
  }, { richterFree: true });
});
