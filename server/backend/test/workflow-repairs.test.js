// Guards for the workflow repairs found in a bug hunt.
//
// Every test here has a COUNTER-TEST: the comment above it says what the state BEFORE the repair did and which claim turns
// red with it. A green test that never enters the breaking path proves nothing — so the path itself is driven everywhere
// (real HTTP routes, real driver, faked CLI), not the repaired function on its own.
//
// WHAT THIS FILE DOES NOT PIN (named instead of concealed): the WIRING of the arrival marker in the driver (the arrival
// test checks pure functions), two of the three log spots of the start-command fix (error and limit path of the start
// command), as well as the detail route and the fallback for deleted workflows. Whoever reverts there gets NO red test —
// that is a gap, not a proof.
//
// The fake CLI reads its behavior FRESH from a control file on EVERY call. Only so can a running test switch in the middle
// of a run (hang, then answer) without restarting the server.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
// The store is used directly to produce a state the route does not allow (a model that drops out of the
// catalog only AFTER saving). The same module as in the server.
import * as store from "../electron/server/store.js";
import * as wf from "../electron/server/workflows.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
async function statusOf(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an EVENT, without a deadline: a clock that turns a test red measures the machine under load. If it hangs, the
// suite deadline is the emergency brake — and every 30 s a line on stderr says what is being waited for.
async function waitFor(fn, what = String(fn).replace(/\s+/g, " ").slice(0, 220)) {
  const t0 = Date.now();
  let reported = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    const tick = Math.floor((Date.now() - t0) / 30_000);
    if (tick > reported) { reported = tick; process.stderr.write(`[waiting] for ${tick * 30} s: ${what}\n`); }
    await sleep(40);
  }
}

// ── Fake-CLI ───────────────────────────────────────────────────────────────────────────────────
// Turn (stream-json): answers "DONE: <prompt>" — or not at all (`hang`), or only once the gate
// file `turnGate` exists.
// Oneshot: verdict, list, compaction. Each of the three kinds has a GATE (`condGate`, `gateGate`,
// `compactGate`, each a file path, read at the start of the oneshot): the fake answers only once
// the test creates the file, and logs "ONESHOT-END <kind>" before. (Delays would let a test cancel
// DURING a verdict, but under load the verdict came too early or the damage only after the test's sleep.)
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const log = (s) => { try { fs.appendFileSync(process.env.RP_LOG, String(s).replace(/\\s+/g, " ").slice(0, 900) + "\\n"); } catch {} };
const ctl = () => { try { return JSON.parse(fs.readFileSync(process.env.RP_CTL, "utf8")); } catch { return {}; } };
const afterGate = (gate, further) => { const w = () => (!gate || fs.existsSync(gate) ? further() : setTimeout(w, 20)); w(); };
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    const c = ctl();
    log("ONESHOT " + stdin.slice(0, 300));
    let result = "Title";
    let kind = "", gate = "";
    if (/compacting the chat history/i.test(stdin)) { kind = "compaction"; gate = c.compactGate || ""; result = c.compactEmpty ? "" : "SUMMARY of the history"; }
    else if (/work step is DONE/.test(stdin)) { kind = "work step is DONE"; gate = c.gateGate || ""; result = c.gate === "never" ? '{"done": false, "note": "the report is missing"}' : '{"done": true, "note": ""}'; }
    else if (/condition/i.test(stdin)) { kind = "condition"; gate = c.condGate || ""; result = c.condYes === false ? '{"yes": false, "note": "NO"}' : '{"yes": true, "note": "YES"}'; }
    else if (/list|JSON array/i.test(stdin)) { result = c.list || '["Alpha", "Beta"]'; }
    afterGate(gate, () => { if (kind) log("ONESHOT-END " + kind); process.stdout.write(JSON.stringify({ result })); clearTimeout(guard); process.exit(0); });
  });
} else {
  log("ARGV " + argv.join(" "));
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const cc = msg.message && msg.message.content;
    const text = typeof cc === "string" ? cc : (Array.isArray(cc) ? cc.map((b) => b.text || "").join("") : "");
    log("TURN " + text);
    const c = ctl();
    if (c.hang) return;                       // never answer — the test stops this turn
    const out = "DONE: " + text.replace(/\\s+/g, " ").slice(0, 90);
    afterGate(c.turnGate || "", () => {
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "rep" });
    });
  });
}
`;

// Stop open runs — only after a failure: the run state is MODULE STATE, an open run would otherwise run into the
// next test. Nothing in it throws, the body's error stays THE error.
async function stopOpen(base) {
  try {
    for (const it of (await json(`${base}/api/active-runs`)).items || []) {
      if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* server already closed */ }
}

async function withServer(fn, ctlStart = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-rep-"));
  const bin = path.join(root, "fake-claude");
  const logFile = path.join(root, "prompts.log");
  const ctlFile = path.join(root, "ctl.json");
  const prev = {
    bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL,
    log: process.env.RP_LOG, ctl: process.env.RP_CTL, restartGrace: process.env.CBASE_RESTART_GRACE_MS,
  };
  let server, base = "", finished = false;
  const gates = [];
  try {
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(logFile, "");
    fs.writeFileSync(ctlFile, JSON.stringify(ctlStart));
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.RP_LOG = logFile;
    process.env.RP_CTL = ctlFile;
    // No restart: it is not the subject here, and 2.5 s after the start it would take a run whose verdict was
    // just in flight for interrupted and drive it a second time.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Repairs", path: wsPath }) });
    await fn({
      base, ws,
      // Only WHOLE lines: the fake CLI writes while the test reads — the rest behind the last
      // "\n" belongs to the writer (same reading as jsonl.mjs).
      lines: () => fs.readFileSync(logFile, "utf8").split("\n").slice(0, -1).filter(Boolean),
      control: (o) => fs.writeFileSync(ctlFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(ctlFile, "utf8")), ...o })),
      // A new, closed gate: `path` goes into the control file, `open()` creates the file.
      gate: () => { const filePath = path.join(root, `gate-${gates.length + 1}`); gates.push(filePath); return { path: filePath, open: () => fs.writeFileSync(filePath, "") }; },
    });
    finished = true;
  } finally {
    // Open every gate: a fake CLI still waiting on one would otherwise end only at its ripcord.
    for (const t of gates) { try { fs.writeFileSync(t, ""); } catch {} }
    // After a failure we do not wait for quiet: an intentionally hanging turn would otherwise hold the file
    // until the suite deadline, and a red test would become a hang without a line.
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll], ["RP_LOG", prev.log], ["RP_CTL", prev.ctl], ["CBASE_RESTART_GRACE_MS", prev.restartGrace]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // Cleanup must not tip a passed test: a child still writing causes ENOTEMPTY, which says
    // something about cleanup, not about the product.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// `run: { doneAll: false }`: "check all work steps" is on by default. Whoever tests the closing gate
// sets it on the node (`doneCheck: true`, legacy state ⇒ `doneMode: "on"`).
const makeFlow = async (base, ws, name, graph, extra = {}) => {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ graph, ...extra, run: { doneAll: false, ...(extra.run || {}) } }) });
};
const newChat = async (base, ws, title) => {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
};
const start = (base, chatId, workflowId, input = "") =>
  json(`${base}/api/chats/${chatId}/workflow`, { method: "POST", body: JSON.stringify({ workflowId, input }) });
const detail = (base, runId) => json(`${base}/api/workflow-runs/${runId}`);
const untilStatus = (base, runId, ...want) =>
  waitFor(async () => { const d = await detail(base, runId); return want.includes(d.run.status) ? d : null; }, `run ${runId} in ${want.join("/")}`);
const runOfTheChats = (base, chatId) => json(`${base}/api/chats/${chatId}/workflow`);

// ───────────────────────────────────────────────────────────────────────────────────────────────

// COUNTER-TEST: before the repair the run stayed at "running" after `/stop` with nobody driving it any more
// (`workflowRunFailed` read `abortedRuns`, which doRun had long cleared — the self-report was ALWAYS `false`, so the
// run ended as "failed"; with the marker set it would have been "cancelled"). Both claims below turn red with it:
// `pending === "stopped"` does not exist there, and the status check fails.
test("Stop halts the workflow instead of ending it — and the next message is a job, not a step result", async () => {
  await withServer(async ({ base, ws, lines, control }) => {
    const flow = await makeFlow(base, ws, "Stop", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "n1", type: "instruction", title: "First", text: "WORK ONE" },
        { id: "n2", type: "instruction", title: "Second", text: "WORK TWO" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e" }],
    });
    const chat = await newChat(base, ws, "Stop-Chat");
    control({ hang: true });
    const r = await start(base, chat.id, flow.id);

    // Wait until the turn is really running — otherwise the test stops into the void.
    await waitFor(() => lines().some((l) => /^TURN .*WORK ONE/.test(l)));
    await waitFor(async () => (await json(`${base}/api/runs/active`)).busy);
    control({ hang: false });
    await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });

    const halted = await waitFor(async () => {
      const v = await runOfTheChats(base, chat.id);
      return v.run?.status === "waiting" ? v.run : null;
    });
    assert.equal(halted.pending, "stopped", "the halt must stand as a waiting state of its own in the cursor");
    assert.match(halted.question, /gestoppt/, `the question does not name the reason: ${halted.question}`);

    // The step that ran is CLOSED — neither as success nor open.
    const d1 = await detail(base, r.run.id);
    const row = [...d1.steps].reverse().find((x) => x.kind === "step");
    assert.equal(row.detail.ok, false, "the step row stayed open or counted as success");
    assert.match(String(row.detail.error || ""), /stopped/i);

    // A foreign message now becomes a JOB for the same step: it creates a real turn. Before, it ran into
    // `workflowGateAfterRun`, counted as the result of "First" and drove the workflow to "done" without
    // anything having been worked.
    const prior = lines().filter((l) => l.startsWith("TURN")).length;
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please also check the footnotes" }) });
    await waitFor(() => lines().some((l) => /^TURN .*footnotes/.test(l)));
    assert.ok(lines().filter((l) => l.startsWith("TURN")).length > prior);

    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "done", `Status ${end.run.status}: ${end.run.note}`);
    assert.ok(lines().some((l) => /^TURN .*WORK TWO/.test(l)), "the second step never ran");
  });
});

// COUNTER-TEST: without the run-still-ours check the verdict wrote its cursor into the run even if the human had
// cancelled meanwhile — the `decision` row then stood BEHIND the `end` row of the same run. The order claim below is
// red there.
test("Cancelling during the switch verdict writes nothing more into the run", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "Switch", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "n1", type: "instruction", title: "Preparation", text: "WORK PREP" },
        { id: "c", type: "condition", title: "Switch", text: "Is the preparation usable?" },
        { id: "yes", type: "instruction", title: "Yes path", text: "WORK YES-WAY" },
        { id: "no", type: "instruction", title: "No path", text: "WORK NO-WAY" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "n1" }, { from: "n1", to: "c" },
        { from: "c", to: "yes", branch: "true" }, { from: "c", to: "no", branch: "false" },
        { from: "yes", to: "e" }, { from: "no", to: "e" },
      ],
    }, { run: {} });
    const chat = await newChat(base, ws, "Switch-Chat");
    const verdict = gate();
    control({ condGate: verdict.path });
    const r = await start(base, chat.id, flow.id);

    await waitFor(() => lines().some((l) => /^ONESHOT .*ONE condition in a workflow/.test(l)));
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    const aborted = await detail(base, r.run.id);
    assert.equal(aborted.run.status, "cancelled");

    // The verdict comes back only AFTER the cancel, and we check only once the server has processed it
    // (quiet counts running verdicts) — instead of sleeping and hoping the damage would be done by then.
    verdict.open();
    await waitFor(() => lines().includes("ONESHOT-END condition"));
    await waitForQuiet(base);
    const after = await detail(base, r.run.id);
    const kinds = after.steps.map((x) => x.kind);
    assert.equal(kinds[kinds.length - 1], "end", `writing continued after the end: ${kinds.join(" → ")}`);
    assert.equal(after.run.status, "cancelled");
    assert.ok(!lines().some((l) => /^TURN .*WORK (YES|NO)-WAY/.test(l)), "a branch still ran behind the cancel");
  });
});

// COUNTER-TEST: without the check after the verdict the "not done" branch started a further, PAID agent turn on a
// long-cancelled run. The turn count below is red there (2 instead of 1).
test("Cancelling during the closing gate starts no further turn", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "Gate", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "n1", type: "instruction", title: "Report", text: "WORK REPORT", doneCheck: true },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
    });
    const chat = await newChat(base, ws, "Gate-Chat");
    const verdict = gate();
    control({ gate: "never", gateGate: verdict.path });
    const r = await start(base, chat.id, flow.id);

    await waitFor(() => lines().some((l) => /^ONESHOT .*work step is DONE/.test(l)));
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    // The "not done" comes only after the cancel; a follow-up turn would stand in the log at the latest
    // once the server rests again (a running turn counts there).
    verdict.open();
    await waitFor(() => lines().includes("ONESHOT-END work step is DONE"));
    await waitForQuiet(base);
    const turns = lines().filter((l) => l.startsWith("TURN")).length;
    assert.equal(turns, 1, `a turn still ran after the cancel: ${lines().filter((l) => l.startsWith("TURN")).join(" | ")}`);
    const after = await detail(base, r.run.id);
    assert.equal(after.run.status, "cancelled");
  });
});

// COUNTER-TEST: if the branches of a parallel node did not join, `join` was null, the cursor jumped to `null` — and the
// run reported "done" although the switch behind it and the end never ran. The status claim below is red there ("done"
// instead of "failed").
test("Parallel without a join ends as a failure, not as “done”", async () => {
  await withServer(async ({ base, ws, lines }) => {
    const flow = await makeFlow(base, ws, "Parallel", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "p", type: "parallel", title: "Fan-out", text: "Two things at once" },
        { id: "a", type: "instruction", title: "Branch A", text: "WORK A" },
        { id: "b", type: "instruction", title: "Branch B", text: "WORK B" },
        { id: "c", type: "condition", title: "Switch", text: "Does the result fit?" },
        { id: "z", type: "instruction", title: "Afterwards", text: "WORK AFTER" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "p" }, { from: "p", to: "a" }, { from: "p", to: "b" },
        { from: "b", to: "c" }, { from: "c", to: "z", branch: "true" }, { from: "z", to: "e" },
      ],
    });
    const chat = await newChat(base, ws, "Parallel-Chat");
    const r = await start(base, chat.id, flow.id);
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "failed", `Status ${end.run.status}: ${end.run.note}`);
    assert.match(end.run.note, /führen nicht zusammen/, `Reason missing: ${end.run.note}`);
    assert.ok(!lines().some((l) => /^TURN .*WORK AFTER/.test(l)));

    // The same finding must stand in the EDITOR — otherwise it is repaired only when a run dies.
    const full = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`);
    assert.ok(full.problems.some((x) => x.level === "error" && /führen nicht zusammen/i.test(x.text)),
      `Editor hint missing: ${JSON.stringify(full.problems)}`);
  });
});

// COUNTER-TEST: a condition without text still went to the model — it judged nothing, and the run branched on a
// coin-flip result. There a ONESHOT with "condition" runs, so the second claim below is red.
test("A condition without text fails instead of being guessed", async () => {
  await withServer(async ({ base, ws, lines }) => {
    const flow = await makeFlow(base, ws, "Empty switch", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "n1", type: "instruction", title: "Preparation", text: "WORK PREP" },
        { id: "c", type: "condition", title: "Switch", text: "   " },
        { id: "yes", type: "instruction", title: "Yes", text: "WORK YES" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "c" }, { from: "c", to: "yes", branch: "true" }, { from: "yes", to: "e" }],
    });
    const chat = await newChat(base, ws, "Empty-Switch-Chat");
    const r = await start(base, chat.id, flow.id);
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "failed", `Status ${end.run.status}: ${end.run.note}`);
    assert.match(end.run.note, /keinen Text/, `Reason missing: ${end.run.note}`);
    assert.ok(!lines().some((l) => /^ONESHOT .*ONE condition in a workflow/.test(l)), "the model was asked anyway");
  });
});

// COUNTER-TEST: `moveTo` checked only the TOP frame. An edge from the body of the inner loop back to the OUTER one
// therefore entered it a second time: the frame stack grew without bound, every pass got a new visitKey (the round cap
// could never take effect), and the run burned all 60 steps on the same element. There the status is "failed" and the
// turn count double-digit — both claims below are red.
test("An edge back to an OUTER loop continues it instead of entering it again", async () => {
  await withServer(async ({ base, ws, lines }) => {
    const flow = await makeFlow(base, ws, "Nested", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "l1", type: "loop", title: "Per project", items: "Alpha\nBeta", maxIterations: 5 },
        { id: "l2", type: "loop", title: "Per file", items: "one\ntwo", maxIterations: 5 },
        { id: "arb", type: "instruction", title: "Work", text: "WORK ON {{element}}" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "l1" },
        { from: "l1", to: "l2", branch: "each" }, { from: "l1", to: "e", branch: "done" },
        { from: "l2", to: "arb", branch: "each" }, { from: "l2", to: "l1", branch: "done" },
        { from: "arb", to: "l1" },
      ],
    });
    const chat = await newChat(base, ws, "Nested-Chat");
    const r = await start(base, chat.id, flow.id);
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "done", `Status ${end.run.status}: ${end.run.note}`);
    const work = lines().filter((l) => /^TURN .*WORK ON /.test(l));
    assert.equal(work.length, 2, `exactly one turn per outer element expected, ran ${work.length}`);
  });
});

// COUNTER-TEST: a thrown start command ended the WHOLE run ("Command … failed"). A compaction is an optimization; its
// failure once destroyed seven steps of real work. There the run ends as "failed" and the third step never runs.
test("A failed start command does not end the run — it stands in the history and the run goes on", async () => {
  await withServer(async ({ base, ws, lines, control }) => {
    const flow = await makeFlow(base, ws, "Command", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "n1", type: "instruction", title: "One", text: "WORK ONE" },
        { id: "n2", type: "instruction", title: "Two", text: "WORK TWO", command: "/compact" },
        { id: "n3", type: "instruction", title: "Three", text: "WORK THREE" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "e" }],
    });
    const chat = await newChat(base, ws, "Command-Chat");
    control({ compactEmpty: true });
    // WITH input — otherwise `compactChatContext` bails out already at "too little history" and the
    // test proves only that SOME failure does not end the run, not the intended one.
    const r = await start(base, chat.id, flow.id, "Job for the run");
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "done", `Status ${end.run.status}: ${end.run.note}`);
    assert.ok(lines().some((l) => /^TURN .*WORK THREE/.test(l)), "the step behind the command never ran");
    assert.ok(lines().some((l) => /^ONESHOT .*compacting the chat history/i.test(l)),
      "the compaction was not even attempted — the test would miss the intended path");
    const command = end.steps.find((x) => x.kind === "command");
    assert.ok(command, "the failed command is missing in the history");
    assert.equal(command.detail.ok, false, "the failure does not stand in the row");
    assert.ok(command.durationMs > 0, "the duration is missing on the row");
  });
});

// COUNTER-TEST: a WAITING run of a deleted workflow was driven by nobody any more — it stayed at "waiting" forever and
// held its lock. The second start below kept getting 409 there.
test("A deleted workflow ends its waiting runs and releases the lock", async () => {
  await withServer(async ({ base, ws }) => {
    const graph = (question) => ({
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "ask", title: "Question", text: question },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }],
    });
    // Lock "project" WITHOUT a bound project: the shared subject is then the workspace — that is where
    // the folder lies in which two runs overwrite each other's files.
    const a = await makeFlow(base, ws, "First", graph("How to proceed?"), { lock: { scope: "project" } });
    const b = await makeFlow(base, ws, "Second", graph("And now?"), { lock: { scope: "project" } });
    const chatA = await newChat(base, ws, "A");
    const chatB = await newChat(base, ws, "B");

    const rA = await start(base, chatA.id, a.id);
    await waitFor(async () => (await detail(base, rA.run.id)).run.status === "waiting");

    const blocked = await statusOf(`${base}/api/chats/${chatB.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: b.id }) });
    assert.equal(blocked.status, 409, `the same workspace must serialize: ${JSON.stringify(blocked.body)}`);

    await json(`${base}/api/workspaces/${ws.id}/workflows/${a.id}`, { method: "DELETE" });
    const ended = await detail(base, rA.run.id);
    assert.equal(ended.run.status, "failed", "the waiting run stayed standing");
    assert.match(ended.run.note, /gelöscht/);

    const free = await statusOf(`${base}/api/chats/${chatB.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: b.id }) });
    // 202 = accepted and started (the run keeps working asynchronously).
    assert.equal(free.status, 202, `the lock was not released: ${JSON.stringify(free.body)}`);
    await json(`${base}/api/chats/${chatB.id}/workflow/cancel`, { method: "POST" });
  });
});

// COUNTER-TEST: `limit=10.5` went to SQLite as REAL and ended in "datatype mismatch" — a 500 for an input that deserves at
// most a 400. An unknown status silently returned an empty list, indistinguishable from "no runs".
test("The run list answers wrong parameters instead of guessing or crashing", async () => {
  await withServer(async ({ base }) => {
    const broken = await statusOf(`${base}/api/workflow-runs?limit=10.5`);
    assert.equal(broken.status, 400, `Answer was ${broken.status}: ${JSON.stringify(broken.body)}`);
    const status = await statusOf(`${base}/api/workflow-runs?status=anything`);
    assert.equal(status.status, 400);
    assert.match(String(status.body.error), /running/, "the allowed values are missing in the answer");
    const gut = await statusOf(`${base}/api/workflow-runs?limit=10&status=done`);
    assert.equal(gut.status, 200);
  });
});

// COUNTER-TEST: an invented model name was silently stored, landed on the CHAT at the start and went to the CLI as
// `--model` — the chat was permanently unusable afterwards, also outside the workflow. There the route answers 200.
test("Run settings with an unknown provider or model are rejected", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Settings", {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "e" }],
    });
    const put = (run) => statusOf(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run }) });
    assert.equal((await put({ provider: "invented" })).status, 400);
    assert.equal((await put({ provider: "claude", model: "claude-nonexistent-9" })).status, 400);
    assert.equal((await put({ permissionMode: "maybe" })).status, 400);
    // The same for the checking model of the closing gate: invented, it would go to the oneshot as `--model`,
    // and every gate of this workflow would fail with "verdict unusable".
    assert.equal((await put({ doneProvider: "invented" })).status, 400);
    assert.equal((await put({ doneProvider: "claude", doneModel: "claude-nonexistent-9" })).status, 400);
    const gut = await put({ provider: "claude", model: "claude-haiku-4-5-20251001", doneProvider: "claude", doneModel: "claude-opus-5" });
    assert.equal(gut.status, 200, `valid settings were rejected: ${JSON.stringify(gut.body)}`);
    const full = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`);
    assert.equal(full.run.model, "claude-haiku-4-5-20251001");
    assert.equal(full.run.doneModel, "claude-opus-5");
    assert.equal(full.run.doneProvider, "claude");
    // Saving WITHOUT the check fields leaves them (the editor sends `run` whole, iOS not at all).
    assert.equal((await put({ effort: "high" })).status, 200);
    assert.equal((await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`)).run.doneModel, "claude-opus-5");
  });
});

// COUNTER-TEST: these losses all happened SILENTLY — the editor showed one graph, the run got another. `checkGraph`
// knew none of them.
test("checkGraph names what is lost on saving", () => {
  const raw = {
    nodes: [
      { id: "s", type: "start", title: "Start" },
      { id: "n1", type: "instruction", title: "First", text: "x" },
      { id: "n1", type: "instruction", title: "Duplicate", text: "y" },
      { id: "n2", type: "instruction", title: "Long text", text: "z".repeat(9000) },
      { id: "e", type: "end", title: "End", command: "/clear" },
    ],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e" }, { from: "n2", to: "way" }],
  };
  const problems = wf.checkGraph(raw).map((p) => p.text).join(" | ");
  assert.match(problems, /dieselbe Kennung/i, `Duplicate not reported: ${problems}`);
  assert.match(problems, /abgeschnitten/i, `Truncation not reported: ${problems}`);
  assert.match(problems, /Startbefehl dort läuft nie/, `Command at the end not reported: ${problems}`);
  assert.match(problems, /zeigt ins Leere/i, `Edge into nothing not reported: ${problems}`);
  // And the normalization does what the hint says.
  assert.equal(wf.normalizeGraph(raw).nodes.find((n) => n.id === "e").command, "");
});

// COUNTER-TEST: `/clear please start over` silently dropped its rest, `/compact-now` ran as a compaction, and a command
// that consisted only of `{{answer}}` made the user's answer a harness command. The old test was
// `/^\/(clear|compact)\b/i` on the RENDERED text.
test("Harness commands are recognized only in the raw form — and only if nothing stands behind", () => {
  assert.equal(wf.isHarnessCommand("/clear"), true);
  assert.equal(wf.isHarnessCommand("  /compact  "), true);
  assert.equal(wf.isHarnessCommand("/clear please start over"), false);
  assert.equal(wf.isHarnessCommand("/compact-now"), false);
  assert.equal(wf.isHarnessCommand("{{answer}}"), false);
  assert.equal(wf.isHarnessCommand(""), false);
});

// COUNTER-TEST: cutting happened in the middle of a surrogate pair (an emoji exactly on the boundary left a lone half
// character that was stored and wandered into the prompt), and cutting was SILENT — a shortened job brief could not be
// told from a complete one.
test("Clipping cuts no character in two and says that it clipped", () => {
  const withEmoji = `${"a".repeat(9)}😀${"b".repeat(20)}`;
  const short = wf.clipWithAnnouncement(withEmoji, 10);
  assert.ok(!/[\uD800-\uDBFF]$/.test(short.split("\n")[0]), "half a surrogate pair remained");
  assert.match(short, /truncated: \d+ of \d+ characters/);
  assert.equal(wf.clipWithAnnouncement("short", 100), "short");
  assert.ok(wf.INPUT_MAX >= 16000, "the input of a run must not end at 4000 characters");
});

// ── Further repairs ──────────────────────

// COUNTER-TEST: three simultaneous clicks on "skip" all ran through the same gap between status check and `await`: an
// already skipped step still ran through completely afterwards, and two skip rows carried the node of their neighbor.
// Sequentially the same flow was clean — the claim below (exactly ONE step skipped) is red there.
test("Three simultaneous “skip” skip exactly one step", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "Chain", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        ...[1, 2, 3, 4].map((i) => ({ id: `n${i}`, type: "instruction", title: `Step ${i}`, text: `WORK ${i}` })),
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" }, { from: "n4", to: "e" }],
    });
    const chat = await newChat(base, ws, "Chain-Chat");
    // The first step holds at the gate until the three clicks are through — a fake delay would let step 1
    // finish under load before the first click arrived.
    const work = gate();
    control({ turnGate: work.path });
    const r = await start(base, chat.id, flow.id, "");
    await waitFor(() => lines().some((l) => /^TURN .*WORK 1/.test(l)));

    const responses = await Promise.all([0, 1, 2].map(() =>
      statusOf(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" })));
    work.open();
    const accepted = responses.filter((a) => a.body.ok === true).length;
    assert.equal(accepted, 1, `only one skip may take effect, accepted were ${accepted}`);

    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "done", `Status ${end.run.status}: ${end.run.note}`);
    const skips = end.steps.filter((x) => x.kind === "skip");
    assert.equal(skips.length, 1, `expected: one skip row, found ${skips.length}`);
    assert.equal(skips[0].nodeId, "n1", "the skip row carries the wrong node");
    // The skipped step must NOT have run after all.
    const rowsN1 = end.steps.filter((x) => x.kind === "step" && x.nodeId === "n1");
    assert.equal(rowsN1.length, 1, "the skipped step has more than one row");
    assert.equal(rowsN1[0].detail.ok, false, "the skipped step ran through after all");
  });
});

// COUNTER-TEST: two simultaneous cancels wrote two "end" rows into the same log and two end lines into the chat.
// Sequentially the second answered with ok=false — exactly that now holds simultaneously too.
test("Two simultaneous cancels write one end, not two", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "DoubleCancel", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "Work", text: "WORK LONG" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }],
    });
    const chat = await newChat(base, ws, "DoubleCancel-Chat");
    // The turn runs until cancelled: a gate this test never opens.
    control({ turnGate: gate().path });
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => lines().some((l) => /^TURN .*WORK LONG/.test(l)));

    const both = await Promise.all([0, 1].map(() =>
      statusOf(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" })));
    assert.equal(both.filter((a) => a.body.ok === true).length, 1, "both cancels were accepted");
    const after = await detail(base, r.run.id);
    assert.equal(after.run.status, "cancelled");
    assert.equal(after.steps.filter((x) => x.kind === "end").length, 1,
      `two end rows in the log: ${JSON.stringify(after.steps.map((x) => ({ k: x.kind, d: x.detail })))}`);
  });
});

// COUNTER-TEST: after a skip the bell "Review requested" stayed unresolved, after a cancel the agenda item
// "Request review" (stored German: "Review anfragen") stayed open too — for a run that no longer exists. An approval
// cleared both, the two other ways did not. It is an item of the chat's agenda (without the item the "never even
// created" claim is red).
test("Skipping and cancelling clear away the leftovers of a review", async () => {
  await withServer(async ({ base, ws }) => {
    const graph = {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "Work", text: "WORK" },
        { id: "rv", type: "review", title: "Acceptance", text: "Please check", notify: true },
        { id: "fix", type: "instruction", title: "Repair", text: "FIX" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "a" }, { from: "a", to: "rv" },
        { from: "rv", to: "e" }, { from: "rv", to: "fix", branch: "issues" }, { from: "fix", to: "rv" },
      ],
    };
    const flow = await makeFlow(base, ws, "Acceptance", graph);
    const openReviewBells = async () => {
      const ev = await json(`${base}/api/services/events?since=0`);
      const list = Array.isArray(ev) ? ev : (ev.events || []);
      return list.filter((x) => x.kind === "review" && !x.resolved);
    };
    const reviewPoints = async (chatId) =>
      (await json(`${base}/api/chats/${chatId}/agenda`)).agenda.steps.filter((x) => x.text === "Review anfragen");

    for (const way of ["skip", "cancel"]) {
      const chat = await newChat(base, ws, `Acceptance-${way}`);
      const r = await start(base, chat.id, flow.id);
      await waitFor(async () => (await runOfTheChats(base, chat.id)).run?.pending === "review");
      assert.ok((await openReviewBells()).length > 0, `${way}: the bell was never even set`);
      assert.deepEqual((await reviewPoints(chat.id)).map((x) => x.status), ["open"], `${way}: the item “Request review” was never even created`);
      await json(`${base}/api/chats/${chat.id}/workflow/${way}`, { method: "POST" });
      await waitFor(async () => (await detail(base, r.run.id)).run.status !== "waiting");
      // Cleaned up once the server rests — the status change alone does not say that bell and
      // agenda item have had their turn.
      await waitForQuiet(base);
      assert.equal((await openReviewBells()).length, 0, `${way}: the bell still asks for a review`);
      assert.deepEqual((await reviewPoints(chat.id)).map((x) => x.status), ["done"], `${way}: the item “Request review” stayed open`);
      if (way === "skip") await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" }).catch(() => {});
    }
  });
});

// COUNTER-TEST: during a verdict oneshot `/stop` reported "no running run" (ok=false), and the workflow then ran through
// completely — the stop was ineffective, and /api/runs/active claimed nothing was running. Both claims below are red there.
test("Stop also works during a verdict — and the verdict is visible", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "Verdict", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "Work", text: "WORK PREP" },
        { id: "c", type: "condition", title: "Switch", text: "Is this usable?" },
        { id: "t", type: "instruction", title: "Afterwards", text: "WORK AFTER" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "c" }, { from: "c", to: "t", branch: "true" }, { from: "t", to: "e" }],
    });
    const chat = await newChat(base, ws, "Verdict-Chat");
    const verdict = gate();
    control({ condGate: verdict.path });
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => lines().some((l) => /^ONESHOT .*ONE condition in a workflow/.test(l)));

    const active = await json(`${base}/api/runs/active`);
    assert.ok((active.verdicts | 0) > 0, `the running verdict is invisible: ${JSON.stringify(active)}`);

    const stop = await statusOf(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
    assert.equal(stop.body.ok, true, `the stop ran into the void: ${JSON.stringify(stop.body)}`);
    const halted = await waitFor(async () => {
      const v = await runOfTheChats(base, chat.id);
      return v.run?.status === "waiting" ? v.run : null;
    });
    assert.equal(halted.pending, "stopped");

    // And the returning verdict writes nothing more: the step behind the switch does not run.
    // It comes back only now, and we check once the server has processed it.
    verdict.open();
    await waitFor(() => lines().includes("ONESHOT-END condition"));
    await waitForQuiet(base);
    assert.ok(!lines().some((l) => /^TURN .*WORK AFTER/.test(l)), "the run kept running despite the stop");
    assert.equal((await detail(base, r.run.id)).run.status, "waiting");
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
  });
});

// COUNTER-TEST: `{{element}}` and `{{answer}}` do not exist yet at the start of a run — the template silently fell back
// to the workflow key or kept the marker literally. It was stored with 200, and nobody learned that it is ineffective.
test("A lock template with a marker unknown at the start is rejected", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Lock", {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "e" }],
    });
    const put = (lock) => statusOf(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ lock }) });
    assert.equal((await put({ scope: "custom", template: "ticket-{{element}}" })).status, 400);
    assert.equal((await put({ scope: "custom", template: "ticket-{{answer}}" })).status, 400);
    const gut = await put({ scope: "custom", template: "ticket-{{input}}" });
    assert.equal(gut.status, 200, `the input is known at the start: ${JSON.stringify(gut.body)}`);
    // …and it takes effect too: two runs with the SAME input exclude each other.
    const chatA = await newChat(base, ws, "Lock-A");
    const chatB = await newChat(base, ws, "Lock-B");
    await start(base, chatA.id, flow.id, "same-operation");
    const second = await statusOf(`${base}/api/chats/${chatB.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "same-operation" }) });
    assert.ok([409, 202].includes(second.status), `unexpected: ${second.status}`);
    if (second.status === 202) await json(`${base}/api/chats/${chatB.id}/workflow/cancel`, { method: "POST" });
  });
});

// COUNTER-TEST: after the end the run view kept showing "element 3/5" because it read the cursor's frame without looking
// at the status — a cancelled run looked as if it were still working on it, a regularly ended one showed `null`. The same
// view, two languages.
test("After the end no loop element stands in the run view any more", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "Loop", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "l", type: "loop", title: "Per item", items: "one\ntwo\nthree", maxIterations: 5 },
        { id: "b", type: "instruction", title: "Body", text: "WORK ON {{element}}" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "l" }, { from: "l", to: "b", branch: "each" }, { from: "l", to: "e", branch: "done" }, { from: "b", to: "l" }],
    });
    const chat = await newChat(base, ws, "Loop-Chat");
    // The body holds at the gate until cancelled — "in the middle of the loop" is thus a state, not a duration.
    control({ turnGate: gate().path });
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => lines().some((l) => /^TURN .*WORK ON one/.test(l)));
    const midway = await runOfTheChats(base, chat.id);
    assert.ok(midway.run.loop, "in the middle of the loop the element MUST stand");
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    await untilStatus(base, r.run.id, "cancelled", "failed", "done");
    const afterwards = await runOfTheChats(base, chat.id);
    assert.equal(afterwards.run.loop, null, `an element remained after the end: ${JSON.stringify(afterwards.run.loop)}`);
  });
});

// COUNTER-TEST: a 7,000-character answer ended in the follow-up prompt after 4,000 characters — without a word about it,
// and the history row carried the full text. The announcement below is missing there.
test("A too long answer is clipped — and says so in the follow-up prompt", async () => {
  await withServer(async ({ base, ws, lines }) => {
    const flow = await makeFlow(base, ws, "Long answer", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "ask", title: "Question", text: "What goes in?" },
        { id: "n", type: "instruction", title: "Afterwards", text: "USE [[{{answer}}]]" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "n" }, { from: "n", to: "e" }],
    });
    const chat = await newChat(base, ws, "Long-Answer-Chat");
    const r = await start(base, chat.id, flow.id);
    await waitFor(async () => (await detail(base, r.run.id)).run.status === "waiting");
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `${"x".repeat(6900)}END-MARKER` }) });
    // The prompt is read from the STEP ROW: the fake CLI's log file clips itself at 900 characters,
    // where the announcement at the end would never be seen (and the test green without a statement).
    const prompt = await waitFor(async () => {
      const d = await detail(base, r.run.id);
      return d.steps.find((x) => x.kind === "step" && x.nodeId === "n")?.detail?.prompt || null;
    });
    assert.ok(!prompt.includes("END-MARKER"), "the clipping never happened — test worthless");
    assert.match(prompt, /truncated: \d+ of \d+ characters omitted/, `no announcement in the prompt: …${prompt.slice(-200)}`);
    void lines;
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" }).catch(() => {});
  });
});

// ── Second round: repairs of the repairs ─────────────────────────────
//
// Three of these were REGRESSIONS introduced by the first repair round — they stand first, because they are the reason a
// guard against one's own build is needed, not only against the old state.

// COUNTER-TEST: `parallelPrompt` got the parameter `answer` — the caller did not pass it. An explicit `answer: undefined`
// overrides the value from the spread in the prompt build (`{ ...vars, answer }`), so `{{answer}}` has rendered EMPTY
// since. Before, there was no `answer` key, and `vars.answer` survived. The repair produced the very error it was meant
// to fix.
test("A parallel node sees the answer to a question — {{answer}} does not render empty", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Parallel after question", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "ask", title: "Question", text: "Which currency?" },
        { id: "p", type: "parallel", title: "Fan-out", text: "Check [[{{answer}}]]" },
        { id: "z1", type: "instruction", title: "A", text: "BRANCH A for {{answer}}" },
        { id: "z2", type: "instruction", title: "B", text: "BRANCH B" },
        { id: "j", type: "instruction", title: "Together", text: "TOGETHER" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "a" }, { from: "a", to: "p" },
        { from: "p", to: "z1" }, { from: "p", to: "z2" },
        { from: "z1", to: "j" }, { from: "z2", to: "j" }, { from: "j", to: "e" },
      ],
    });
    const chat = await newChat(base, ws, "Parallel-Answer-Chat");
    const r = await start(base, chat.id, flow.id);
    await waitFor(async () => (await detail(base, r.run.id)).run.status === "waiting");
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Swiss francs" }) });

    const prompt = await waitFor(async () => {
      const d = await detail(base, r.run.id);
      return d.steps.find((x) => x.kind === "step" && x.nodeId === "p")?.detail?.prompt || null;
    });
    assert.match(prompt, /\[\[Swiss francs\]\]/, `the node text did not see the answer: ${prompt.slice(0, 300)}`);
    assert.match(prompt, /BRANCH A for Swiss francs/, "the branch texts must see it too");
    assert.match(prompt, /User's answer to the last question: Swiss francs/, "the context block is missing");
    await untilStatus(base, r.run.id, "done", "failed", "cancelled");
  });
});

// COUNTER-TEST: the editor sends `run` back unchanged on EVERY save. A model disappears from the catalog as soon as a CLI
// version rises (the catalog stands in three places). The guard of round one checked EVERY value sent along — an existing
// workflow could then NEVER be saved again, not even to change something entirely different. A protection against typos
// had become a lockout.
test("A stored value does not lock the workflow out — only what CHANGES is rejected", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Inventory", {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n", type: "instruction", title: "One", text: "WORK" }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "n" }, { from: "n", to: "e" }],
    });
    const put = (body) => statusOf(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify(body) });

    // The case at hand can NOT be produced over the route — it rejects an unknown model, after all. It arises
    // over time: the model was valid when saved and later drops out of the catalog (a CLI version rises).
    // Exactly that is produced here past the store, otherwise the test would check only the convenient path.
    store.updateWorkflow(flow.id, { run: { provider: "claude", model: "claude-of-yesterday-3", permissionMode: "", effort: "", todos: false } });
    const loaded = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`);
    assert.equal(loaded.run.model, "claude-of-yesterday-3", "the test setup is wrong");

    // The editor sends back exactly what it loaded — and wants to change the NAME.
    const again = await put({ name: "Renamed", run: loaded.run });
    assert.equal(again.status, 200, `a stored value locks the workflow out: ${JSON.stringify(again.body)}`);
    assert.equal((await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`)).name, "Renamed");

    // Newly set nonsense stays a 400.
    assert.equal((await put({ run: { ...loaded.run, model: "claude-nonexistent-9" } })).status, 400);

    // The same for the lock template: it is validated only if it changes.
    const flow2 = await makeFlow(base, ws, "Stored-Lock", {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "e" }],
    }, { lock: { scope: "custom", template: "fixed" } });
    const put2 = (body) => statusOf(`${base}/api/workspaces/${ws.id}/workflows/${flow2.id}`, { method: "PUT", body: JSON.stringify(body) });
    assert.equal((await put2({ name: "Stored-Lock", lock: { scope: "custom", template: "fixed" } })).status, 200);
    assert.equal((await put2({ lock: { scope: "custom", template: "new-{{element}}" } })).status, 400);
  });
});

// COUNTER-TEST: the store holds the already NORMALIZED graph (`saveWorkflow` calls `wf.normalizeGraph` before saving).
// `checkGraph(w.graph)` therefore never sees a loss — the whole loss computation of round one was dead on the real path
// and visible only in the unit test. Exactly the rule: a green test that never enters the breaking path proves nothing.
test("The losses of a save stand in the RESPONSE of this save", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Losses" }) });
    const saved = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify({
        graph: {
          nodes: [
            { id: "s", type: "start", title: "Start" },
            { id: "n1", type: "instruction", title: "First", text: "x" },
            { id: "n1", type: "instruction", title: "Duplicate", text: "y" },
            { id: "n2", type: "instruction", title: "Long", text: "z".repeat(9000) },
            { id: "e", type: "end", title: "End", command: "/clear" },
          ],
          edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e" }, { from: "n2", to: "way" }],
        },
      }),
    });
    const texts = (saved.problems || []).map((p) => p.text).join(" | ");
    assert.match(texts, /dieselbe Kennung/i, `Duplicate not reported: ${texts}`);
    assert.match(texts, /abgeschnitten/i, `Truncation not reported: ${texts}`);
    assert.match(texts, /zeigt ins Leere/i, `Edge into nothing not reported: ${texts}`);
    assert.match(texts, /ist das Ende/i, `Command at the end node not reported: ${texts}`);
    // On mere LOADING the loss no longer stands there — it happened long ago. That is right, and
    // exactly why it must be said on saving.
    const loaded = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`);
    assert.ok(!(loaded.problems || []).some((p) => /abgeschnitten/i.test(p.text)),
      "on loading the loss can no longer be measured — it must not be claimed here");
  });
});

// COUNTER-TEST: a parallel node with ONE branch slipped through the check (`outs.length < 2`). If a condition stands
// behind it, the branch chain breaks off there, `join` stays null, the cursor jumps to `null` — and the run reports "done"
// although condition, branches and end never ran. The same error as the no-join case, just one edge narrower.
test("Parallel with ONE branch, with more behind it, fails visibly", async () => {
  await withServer(async ({ base, ws, lines }) => {
    const flow = await makeFlow(base, ws, "One branch", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "p", type: "parallel", title: "Fan-out", text: "One" },
        { id: "z", type: "instruction", title: "Branch", text: "WORK BRANCH" },
        { id: "c", type: "condition", title: "Switch", text: "Does that fit?" },
        { id: "afterwards", type: "instruction", title: "Afterwards", text: "WORK AFTER" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "p" }, { from: "p", to: "z" }, { from: "z", to: "c" },
        { from: "c", to: "afterwards", branch: "true" }, { from: "afterwards", to: "e" },
      ],
    });
    const chat = await newChat(base, ws, "One-Branch-Chat");
    const r = await start(base, chat.id, flow.id);
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "failed", `Status ${end.run.status}: ${end.run.note}`);
    assert.ok(!lines().some((l) => /^TURN .*WORK AFTER/.test(l)));
    const full = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`);
    assert.ok(full.problems.some((x) => x.level === "error" && /führen nicht zusammen/i.test(x.text)),
      `Editor hint missing: ${JSON.stringify(full.problems)}`);
  });
});

// COUNTER-TEST: during `compactChatContext` the chat stands in `compacting`, NOT in `running`. `cancelWorkflow` checks
// `running.has`, however — so it ends the run at once, without intent and without waiting. The only long `await` in the
// driver then returned and wrote cursor, log row and chat note into an ended run. Round one attached the run-still-ours
// check to all VERDICTS and overlooked exactly this spot — and the longer compaction deadline enlarged the window from two
// to up to seven minutes.
test("Cancelling during a /compact start command writes nothing more into the run", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "Compact-Cancel", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "n1", type: "instruction", title: "One", text: "WORK ONE" },
        { id: "n2", type: "instruction", title: "Two", text: "WORK TWO", command: "/compact" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e" }],
    });
    const chat = await newChat(base, ws, "Compact-Cancel-Chat");
    // The compaction hangs at the gate until the cancel is in — so it hits right in the middle.
    const compaction = gate();
    control({ compactGate: compaction.path });
    // WITH input: `compactChatContext` bails out with fewer than two history rows, WITHOUT calling the
    // CLI — the workflow prompt itself does not count as a user row. Without the input this test would
    // miss the path to be checked and still be green.
    const r = await start(base, chat.id, flow.id, "Job for the run");
    await waitFor(() => lines().some((l) => /^ONESHOT .*compacting the chat history/i.test(l)));

    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    assert.equal((await detail(base, r.run.id)).run.status, "cancelled");

    // The compaction returns only now; its damage would show at the latest once the server rests.
    compaction.open();
    await waitFor(() => lines().includes("ONESHOT-END compaction"));
    await waitForQuiet(base);
    const after = await detail(base, r.run.id);
    const kinds = after.steps.map((x) => x.kind);
    assert.equal(kinds[kinds.length - 1], "end", `writing continued after the end: ${kinds.join(" → ")}`);
    assert.equal(after.run.status, "cancelled");
    assert.ok(!lines().some((l) => /^TURN .*WORK TWO/.test(l)), "a step still ran behind the cancel");
  });
});

// COUNTER-TEST: a stop sets `waiting`, the "continue" after it `running` again — with the same step and the same node.
// To the run-still-ours check that looked like "nothing happened", and a verdict that was in flight during the stop still
// wrote afterwards. The generation counter in the cursor counts exactly these interruptions.
test("A verdict that survived the stop does not write after resuming either", async () => {
  await withServer(async ({ base, ws, lines, control, gate }) => {
    const flow = await makeFlow(base, ws, "Generation", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "Preparation", text: "WORK PREP" },
        { id: "c", type: "condition", title: "Switch", text: "Usable?" },
        { id: "yes", type: "instruction", title: "Yes path", text: "WORK YES-WAY" },
        { id: "no", type: "instruction", title: "No path", text: "WORK NO-WAY" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "a" }, { from: "a", to: "c" },
        { from: "c", to: "yes", branch: "true" }, { from: "c", to: "no", branch: "false" },
        { from: "yes", to: "e" }, { from: "no", to: "e" },
      ],
    });
    const chat = await newChat(base, ws, "Generation-Chat");
    // The first verdict comes back only once the run is `running` again AND the second is in flight — otherwise the
    // status comparison catches it already and the test checks nothing. Two gates: the order is set, not hoped for.
    // The two verdicts answer DIFFERENTLY — otherwise they cannot be told apart in the log, and the test would be
    // green even if the discarded verdict won. The first says NO, the second YES.
    const firstVerdict = gate();
    const secondVerdict = gate();
    control({ condGate: firstVerdict.path, condYes: false });
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => lines().some((l) => /^ONESHOT .*ONE condition in a workflow/.test(l)));

    // Stop while the verdict runs — the run halts at the switch.
    await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
    await waitFor(async () => (await runOfTheChats(base, chat.id)).run?.pending === "stopped");
    const genAfterHold = (await detail(base, r.run.id)).run;
    assert.equal(genAfterHold.status, "waiting");

    // Resume at once: status, step and cursor then stand exactly as before the stop — for a plain state
    // comparison the run is thus indistinguishable from "nothing happened". The second verdict waits at ITS gate
    // until the first is back and processed: if it were faster, the run would long have moved on when the first
    // returned — then the state comparison catches it already, and the test would prove nothing.
    control({ condYes: true, condGate: secondVerdict.path });
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "weiter" }) });
    await waitFor(() => lines().filter((l) => /^ONESHOT .*ONE condition in a workflow/.test(l)).length >= 2, "the second verdict is running");
    firstVerdict.open();
    await waitFor(() => lines().filter((l) => l === "ONESHOT-END condition").length === 1);
    // The old verdict is processed once only the second counts.
    await waitFor(async () => ((await json(`${base}/api/runs/active`)).verdicts | 0) === 1, "only the second verdict still open");
    secondVerdict.open();
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    await waitForQuiet(base);
    assert.equal(end.run.status, "done", `Status ${end.run.status}: ${end.run.note}`);
    // The OLD verdict must not have written a second decision into the log.
    const next = await detail(base, r.run.id);
    const decisions = next.steps.filter((x) => x.kind === "decision");
    assert.equal(decisions.length, 1, `two verdicts for one switch: ${JSON.stringify(decisions.map((x) => x.detail))}`);
    // THIS is the actual statement: the verdict AFTER resuming (YES) won, not the one from the
    // aborted operation (NO).
    assert.equal(decisions[0].detail.yes, true,
      "the discarded verdict determined the branch — the run went on on the wrong branch");
    assert.ok(lines().some((l) => /^TURN .*WORK YES-WAY/.test(l)),
      `the YES way did not run — status ${next.run.status} (${next.run.note}); log ${next.steps.map((x) => x.kind).join(" → ")}`);
    assert.ok(!lines().some((l) => /^TURN .*WORK NO-WAY/.test(l)), "the NO way ran although it was discarded");
    const kinds = next.steps.map((x) => x.kind);
    assert.equal(kinds[kinds.length - 1], "end", `writing continued after the end: ${kinds.join(" → ")}`);
  });
});

// COUNTER-TEST: before the halt a stopped run ended, and the queue was free afterwards. Since it WAITS, a queued
// message ran as a turn of its own past the workflow — the run stayed waiting forever and held its lock. A regression of
// the halt itself.
test("A queued message after the halt is the ANSWER, not a turn beside it", async () => {
  await withServer(async ({ base, ws, lines, control }) => {
    const flow = await makeFlow(base, ws, "Queue", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "n1", type: "instruction", title: "One", text: "WORK ONE" },
        { id: "n2", type: "instruction", title: "Two", text: "WORK TWO" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e" }],
    });
    const chat = await newChat(base, ws, "Queue-Chat");
    control({ hang: true });
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => lines().some((l) => /^TURN .*WORK ONE/.test(l)));
    await waitFor(async () => (await json(`${base}/api/runs/active`)).busy);

    // Queue a message WHILE the turn runs, then stop.
    const queued = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "weiter" }) });
    assert.equal(queued.queued, true, `the message was not queued: ${JSON.stringify(queued)}`);
    control({ hang: false });
    await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });

    // It must arrive as the ANSWER to the halt — the run goes on instead of staying waiting.
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "done", `Status ${end.run.status}: ${end.run.note}`);
    assert.ok(lines().some((l) => /^TURN .*WORK TWO/.test(l)), "the run stayed lying at the halt");
  });
});

// COUNTER-TEST: a /compact PARKED at the usage limit writes a row without `ok` and without `error`. The open-step-row
// check therefore took it for unfinished — the next `closeRunStep` adopted it and overwrote the parked mark with the
// result of another step.
test("A parked command row does not count as open and is not overwritten", () => {
  // A pure state question, hence without a server: the condition is "does the row have a completion?"
  const completed = (d) => ("ok" in d || "error" in d || d.limited === true);
  assert.equal(completed({ command: "/compact", native: true, limited: true }), true, "parked is a completion");
  assert.equal(completed({ command: "/compact", native: true }), false, "without a mark the row is open");
  assert.equal(completed({ ok: true, output: "x" }), true);
  assert.equal(completed({ ok: false, error: "skipped" }), true);
});

// The previous step's result goes into THREE judging prompts (condition, closing gate, loop list) and was SILENTLY cut at
// 6000 characters there. In a real run the review over the whole diff was 5,878 characters long — 122 under the cap — and
// the sentence the condition asks about ("verdict: findings present") stood at the very end. A conclusion always stands at
// the back; a silent cut therefore takes the answer first and leaves the report, and neither prompt nor run history say a
// word about it.
// BEFORE: `String(lastOutput || "…").slice(0, 6000)` — the prompt ended mid-sentence, the model judged a text whose end it
// took for the end.
test("A clipped step result tells the judging model that it was clipped", () => {
  const node = { id: "c1", type: "condition", text: "Is the result clean?" };
  const lang = "A".repeat(6100) + "\n\n### Verdict: findings present";
  assert.ok(lang.length > wf.RESULT_MAX, "the check text must lie above the cap");

  for (const [name, prompt] of [
    ["condition", wf.conditionPrompt({ node, lastOutput: lang, vars: {} })],
    ["closing gate", wf.donePrompt({ node: { id: "n1", type: "instruction", text: "Do something", doneText: "done?" }, lastOutput: lang, vars: {} })],
    ["loop list", wf.loopListPrompt({ node: { id: "l1", type: "loop", text: "List the packages" }, lastOutput: lang, vars: {} })],
  ]) {
    assert.match(prompt, /\[truncated: \d+ of \d+ characters omitted from the MIDDLE/, `${name}: the clipping must stand in the prompt`);
    // Second stage: the CONCLUSION stands at the back and must survive. Exactly that was lost before.
    assert.ok(prompt.includes("findings present"), `${name}: the conclusion at the END must be preserved`);
    assert.ok(prompt.includes("AAAA"), `${name}: the beginning must be preserved as well`);
  }

  // The opposite direction belongs to it: what FITS gets no announcement attached — otherwise every
  // prompt would carry a clipping that never happened.
  const short = "All green, no findings.";
  const tight = wf.conditionPrompt({ node, lastOutput: short, vars: {} });
  assert.ok(!tight.includes("truncated"), "a short result stays untouched");
  assert.ok(tight.includes(short));
});

// `capAuto` jumps to the exit of the cycle and writes its note into log and run row — but NOT into the prompt of the
// node that continues with it. In a real run the cap forwarded to "Review by maintainer", whose text begins with "The
// state is clean from the review agents' view", while the last verdict was "not clean" — the agent then wrote the human a
// test guide on a premise that did not hold.
// BEFORE: `wf.jumpTo(graph, cursor, exit)` carried nothing about the origin; no prompt builder knew the parameter.
// "Continue without asking" effectively meant "continue without notice".
test("A cap jump tells the target node that it came via the cap — and only ONCE", () => {
  const arrival = { kind: "cap", from: "Phase 3 — Review", rounds: 2, cap: 2, note: "Cap reached after 2 rounds — continuing without asking at “Review by maintainer”." };
  const base = { workflowName: "W", step: 6, total: 8, approx: true, vars: {}, loop: null };

  for (const [name, prompt] of [
    ["instruction", wf.instructionPrompt({ ...base, node: { id: "n", type: "instruction", title: "T", text: "The state is clean." }, arrival })],
    ["review", wf.reviewPrompt({ ...base, node: { id: "r", type: "review", title: "R", text: "The state is clean." }, arrival })],
    ["parallel", wf.parallelPrompt({ ...base, node: { id: "p", type: "parallel", title: "P", text: "The state is clean." }, branches: [{ label: "a", steps: [] }], arrival })],
  ]) {
    assert.match(prompt, /via a cap/, `${name}: the origin must stand in the prompt`);
    assert.match(prompt, /did NOT end cleanly/, `${name}: the node text must be explicitly qualified`);
    assert.ok(prompt.includes("Phase 3 — Review"), `${name}: the cycle whose cap took effect must be named`);
    assert.ok(prompt.includes("allowed: 2"), `${name}: round count and cap belong to it`);
    // The exit is named by NAME when known — not pointed at with "here": the marker is rendered at the
    // first node that builds a prompt, and that need not be the jump target.
    assert.ok(!/forwarded here/.test(prompt), `${name}: “here” may point at the wrong node`);
  }
  // Without an arrival every prompt stays character-identical to before — a hint that is always
  // there is no hint any more.
  const without = wf.instructionPrompt({ ...base, node: { id: "n", type: "instruction", title: "T", text: "The state is clean." } });
  assert.ok(!without.includes("via a cap"), "without a cap jump nothing may stand there");

  // With a TARGET the sentence names the exit; the closing gate is the second way of the same
  // tick and must get the same treatment.
  const withTarget = wf.arrivalSentence({ ...arrival, target: "Review by maintainer" });
  assert.match(withTarget, /at the exit .Review by maintainer./, "the exit must be named");
  const fromGate = wf.arrivalSentence({ kind: "done", from: "Phase 2", rounds: 3, cap: 3, note: "" });
  assert.match(fromGate, /completion criterion of .Phase 2. was still not considered met after 3 rounds/, "the closing gate needs its own sentence");
  assert.equal(wf.arrivalSentence(null), "", "without a marker no sentence");
  assert.equal(wf.arrivalSentence({ kind: "anything" }), "", "an unknown kind invents no sentence");

  // And it travels only ONE step: the driver clears it as soon as it was in the prompt.
  const cursor = { at: "r1", frames: [], visits: {}, vars: {}, arrival };
  const afterwards = wf.withoutArrival(cursor);
  assert.equal("arrival" in afterwards, false, "after rendering the marker must be gone");
  assert.equal(afterwards.at, "r1", "the rest of the cursor stays untouched");
  assert.equal(wf.withoutArrival({ at: "x" }).at, "x", "without a marker the cursor stays the same value");
});

// `renderText` replaces a KNOWN key without a value by "" — silently. Measured in a running turn: "… outside the scope of
// {{title}}" became "… outside the scope of \"", and the question to the HUMAN read "Issue:  —". Both in a workflow that
// was started by hand and therefore never saw a trigger event.
// BEFORE: `checkGraph` checked edges, duplicates and clippings — not markers. The editor stayed silent.
test("The editor names markers that nobody can fill without a trigger", () => {
  const withTrigger = {
    nodes: [
      { id: "t", type: "trigger", title: "GitLab", trigger: { account: "a", events: ["mr"], scope: "project", project: "p" } },
      { id: "n", type: "instruction", title: "Build {{title}}", text: "See {{url}}" },
    ],
    edges: [{ from: "t", to: "n" }],
  };
  const withoutTrigger = {
    nodes: [
      { id: "s", type: "start", title: "Start" },
      { id: "n", type: "instruction", title: "Build {{title}}", text: "See {{url}} — input: {{input}}" },
      { id: "e", type: "end", title: "End" },
    ],
    edges: [{ from: "s", to: "n" }, { from: "n", to: "e" }],
  };
  const texts = (g) => wf.checkGraph(g).map((p) => p.text).join("\n");

  const warning = texts(withoutTrigger);
  assert.match(warning, /\{\{title\}\}/, "the title placeholder must be named");
  assert.match(warning, /\{\{url\}\}/, "the URL placeholder must be named");
  assert.ok(!/\{\{input\}\}/.test(warning), "{{input}} is filled by the start itself — no warning");

  // With a trigger in the graph the marker is fillable: then the check stays silent, otherwise it would be
  // a false alarm in every correct trigger workflow.
  assert.ok(!/\{\{title\}\}/.test(texts(withTrigger)), "with a trigger there must be no warning");

  // And it looks into ALL text fields, not only `text`.
  assert.deepEqual(wf.deadMarkers({ title: "{{title}}", text: "", command: "", doneText: "" }), ["title"]);
  assert.deepEqual(wf.deadMarkers({ title: "", text: "", command: "/x {{url}}", doneText: "" }), ["url"]);
  assert.deepEqual(wf.deadMarkers({ title: "", text: "", command: "", doneText: "done when {{branch}}" }), ["branch"]);
  assert.deepEqual(wf.deadMarkers({ title: "", text: "{{input}} {{answer}} {{element}}", command: "", doneText: "" }), []);
});

// `reviewAnswerPrompt` clipped the presented request at 1,200 and the user's answer at 2,000 characters — both with `str`,
// hence SILENTLY. The request in the real run was about 5,000 characters long. Whoever writes a review attaches their
// condition at the end ("… otherwise it fits"), and exactly that dropped out without it being said anywhere.
// BEFORE: `str(question, 1200)` / `str(answer, 2000)` — cut at the back and kept silent.
test("Interpreting a review answer does not silently lose the end", () => {
  const node = { id: "r", type: "review", title: "Review" };
  const lang = "A".repeat(2500) + " BUT: the export is still missing.";
  const p = wf.reviewAnswerPrompt({ node, round: 1, question: "Please check.", answer: lang });
  assert.match(p, /\[truncated: \d+ of \d+ characters omitted from the MIDDLE/, "the clipping belongs in the prompt");
  assert.ok(p.includes("BUT: the export is still missing."), "the condition at the END decides the approval and must survive");

  const questionLang = "F".repeat(1500) + " LAST: also test the export.";
  const p2 = wf.reviewAnswerPrompt({ node, round: 1, question: questionLang, answer: "passt" });
  assert.ok(p2.includes("LAST: also test the export."), "the request keeps its end too");

  // What fits stays untouched — otherwise every interpretation would carry a clipping that never was.
  const short = wf.reviewAnswerPrompt({ node, round: 1, question: "Please check.", answer: "passt" });
  assert.ok(!short.includes("[truncated:"), "a short answer gets no announcement");
  // And the label no longer claims a clipping across the board that did not happen.
  assert.ok(!short.includes("(truncated)"), "the label must not invent a clipping");
});

// The native start command (/clear, /compact) was logged under the step number of the PREDECESSOR. Measured twice in a
// row: the /compact of "Phase 3" stood under step 1 while "Phase 3" was step 2. `run.step` deliberately stays put — a
// harness command is not a paid turn (see the comment in the driver).
// BEFORE: `step: run.step` at all three log spots of the native branch.
test("The start command stands under the number of the step it introduces", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Numbers", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "First", text: "WORK A" },
        { id: "b", type: "instruction", title: "Second", text: "WORK B", command: "/clear" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "e" }],
    });
    const chat = await newChat(base, ws, "Numbers-Chat");
    const r = await start(base, chat.id, flow.id, "go");
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "done", `Status ${end.run.status}: ${end.run.note}`);
    const cmd = end.steps.find((x) => x.kind === "command" && x.nodeId === "b");
    const step = end.steps.find((x) => x.kind === "step" && x.nodeId === "b");
    assert.ok(cmd, "the command row of “b” is missing");
    assert.ok(step, "the step row of “b” is missing");
    assert.equal(cmd.step, step.step,
      `command (step ${cmd.step}) and node (step ${step.step}) belong together — before, the command stood under the PREDECESSOR`);
    // And the counter itself did NOT move along: "a" and "b" stay two steps, not three.
    const steps = end.steps.filter((x) => x.kind === "step").map((x) => x.step);
    assert.deepEqual(steps, [1, 2], `the native command must not count a step of its own (seen: ${steps.join(",")})`);
  });
});

// The run list showed "9/8" — a step count above the total, which looks like a broken counter. The prompt had long told the
// agent "step 9/approx. 8": `workflowRunView` has always sent `approx`, `runHistoryView` (exactly the view the list draws
// its rows from) did not send it AT ALL — two places for the same row, one had the answer. The web could not show the tilde,
// even if it had wanted to.
// BEFORE: `runHistoryView` knew no `approx`; the field was missing in every row of GET /api/workflow-runs.
test("The run list says whether the total is estimated", async () => {
  await withServer(async ({ base, ws }) => {
    // Straight chain: the number is fixed.
    const currently = await makeFlow(base, ws, "Straight", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "One", text: "WORK A" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }],
    });
    // With a switch it is not — which branch runs, only the verdict knows.
    const crooked = await makeFlow(base, ws, "Crooked", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "One", text: "WORK A" },
        { id: "c", type: "condition", title: "Continue?", text: "Did A succeed?" },
        { id: "b", type: "instruction", title: "Two", text: "WORK B" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [{ from: "s", to: "a" }, { from: "a", to: "c" }, { from: "c", to: "b", branch: "true" }, { from: "c", to: "e", branch: "false" }, { from: "b", to: "e" }],
    });
    const chatG = await newChat(base, ws, "G");
    const chatK = await newChat(base, ws, "K");
    const rG = await start(base, chatG.id, currently.id, "go");
    await untilStatus(base, rG.run.id, "done", "failed", "cancelled");
    const rK = await start(base, chatK.id, crooked.id, "go");
    await untilStatus(base, rK.run.id, "done", "failed", "cancelled");

    const list = await json(`${base}/api/workflow-runs`);
    if (!list.runs.some((r) => r.id === rG.run.id)) {
      throw new Error(`List contains ${list.runs.length} runs: ${JSON.stringify(list.runs.map((r) => ({ id: r.id, ws: r.workspaceId })))} — looking for ${rG.run.id}`);
    }
    const rowG = list.runs.find((r) => r.id === rG.run.id);
    const rowK = list.runs.find((r) => r.id === rK.run.id);
    assert.ok(rowG && rowK, "both runs must stand in the list");
    assert.equal("approx" in rowG, true, "the field was missing in the list entirely — the view could never show it");
    assert.equal(rowG.approx, false, "a straight chain has a fixed step count");
    assert.equal(rowK.approx, true, "with a switch the step count is an estimate");
  });
});

// The arrival test above checks only the pure functions — the WIRING in the driver could be reverted completely without
// a test turning red. This one drives the real path. It also covers the finding that the exit of a cycle can be a SWITCH:
// it decides the further path and never got to see the marker (it passed it on to the node after next, where the sentence
// then said "here" about the wrong place).
test("The cap jump reaches the switch deciding behind it in a real run", async () => {
  await withServer(async ({ base, ws, control }) => {
    control({ condYes: false });
    const flow = await makeFlow(base, ws, "RoundLimit", {
      nodes: [
        { id: "s", type: "start", title: "Start" },
        { id: "a", type: "instruction", title: "Phase 3", text: "WORK A", maxVisits: 2, capAuto: true },
        { id: "c", type: "condition", title: "Clean?", text: "Is the state clean?" },
        { id: "d", type: "condition", title: "Exit", text: "Continue to the human?" },
        { id: "z", type: "instruction", title: "Afterwards", text: "WORK Z" },
        { id: "e", type: "end", title: "End" },
      ],
      edges: [
        { from: "s", to: "a" }, { from: "a", to: "c" },
        { from: "c", to: "a", branch: "false" }, { from: "c", to: "d", branch: "true" },
        { from: "d", to: "z", branch: "false" }, { from: "d", to: "e", branch: "true" },
        { from: "z", to: "e" },
      ],
    });
    const chat = await newChat(base, ws, "RoundLimit-Chat");
    const r = await start(base, chat.id, flow.id, "go");
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");

    const cap = end.steps.find((x) => x.kind === "cap");
    assert.ok(cap, "the round cap must have taken effect");
    assert.equal(cap.detail.auto, true, "capAuto was set — there must be no question");

    // The exit of the cycle here is the SWITCH "Exit". Exactly its verdict prompt must carry the origin —
    // it decides where things go on.
    const turnout = end.steps.filter((x) => x.kind === "decision" && x.nodeId === "d");
    assert.equal(turnout.length, 1, "the switch behind the cap must have judged exactly once");
    assert.match(turnout[0].detail.prompt, /via a cap/, "the switch's verdict prompt does not know the origin");
    assert.match(turnout[0].detail.prompt, /“Phase 3” has run 2 times/, "the cycle whose cap took effect must be named with its round count");
    assert.match(turnout[0].detail.prompt, /did NOT end cleanly/, "the premise must be explicitly qualified");
    // And the sentence does NOT point at the place where it is rendered: it names the exit. Otherwise it
    // would claim "here" about a node the jump never touched.
    assert.ok(!/forwarded here/.test(turnout[0].detail.prompt), "the sentence must not say “here”");

    // …and ONLY it. The node behind it works on the regular path again.
    const afterwards = end.steps.find((x) => x.kind === "step" && x.nodeId === "z");
    assert.ok(afterwards, "the node behind the switch is missing");
    assert.ok(!/via a cap/.test(afterwards.detail.prompt),
      `the marker must reach only ONE prompt — step order: ${end.steps.map((x) => `${x.kind}:${x.nodeId}@${x.step}`).join(" ")}`);
  });
});
