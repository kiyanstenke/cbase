// Round cap: a cycle in the graph ("review clean? -> no -> fix -> review ...") does not spin forever
// but stops after N rounds and ASKS. Both are checked: the engine's calculation rules (pure, no server)
// and the whole path over the real HTTP routes with a fake CLI.
//
// The most important case is at the very bottom: the body of a loop over three elements runs three
// times but is NOT a cycle; it must not trigger the cap even when the cap is 1 round.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as wf from "../electron/server/workflows.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an EVENT, without a deadline (a deadline would measure the machine under load). If it hangs,
// the suite deadline is the emergency stop; every 30 s a stderr line says what is being waited for.
async function waitFor(fn, what = String(fn).replace(/\s+/g, " ").slice(0, 200)) {
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
// After a failure: stop open runs instead of waiting for quiet. Never throws.
async function stopOpen(base) {
  try {
    for (const it of (await json(`${base}/api/active-runs`)).items || []) {
      if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* server already closed */ }
}

// Fake CLI: turns echo the prompt, oneshots answer condition, list AND the reading of a cap answer.
// Everything via MARKERS, not word heuristics (a plain word would hit inside other words).
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const log = (s) => { try { fs.appendFileSync(process.env.CBASE_TEST_PROMPTS, s.replace(/\\s+/g, " ") + "\\n"); } catch {} };
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    log("ONESHOT " + stdin.replace(/\\s+/g, " ").slice(0, 500));
    let result = "Title";
    // CAUTION: the prompts are told apart by their INTRODUCTORY SENTENCE, not by keywords. The condition
    // prompt contains the step's last output, which may quote the user's answer, so a keyword check
    // would wreck every condition.
    if (/You interpret ONE answer/.test(stdin)) {
      // Reading of a cap answer. BROKEN-PLEASE gives unusable output (the verdict fails).
      if (/BROKEN-PLEASE/.test(stdin)) result = "no idea, honestly";
      else if (/MORE-PLEASE/.test(stdin)) result = '{"continue": true, "rounds": 1, "note": "Marker MORE"}';
      else result = '{"continue": false, "rounds": 0, "note": "Marker END"}';
    }
    else if (/list|JSON array/i.test(stdin)) result = '["Alpha", "Beta", "Gamma"]';
    else if (/condition/i.test(stdin)) result = /JA-PLEASE/.test(stdin) ? '{"yes": true, "note": "Marker YES"}' : '{"yes": false, "note": "Marker NO"}';
    process.stdout.write(JSON.stringify({ result }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  log("ARGV " + argv.join(" "));
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    log("TURN " + text.replace(/\\s+/g, " ").slice(0, 600));
    const out = "ERLEDIGT: " + text.replace(/\\s+/g, " ").slice(0, 120);
    setTimeout(() => {
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "cap-e2e" });
    }, Number(process.env.CBASE_TEST_DELAY || 0));
  });
}
`;

async function withServer(fn, { delayMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  const bin = path.join(root, "fake-claude");
  const prompts = path.join(root, "prompts.log");
  const prev = {
    bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL,
    prompts: process.env.CBASE_TEST_PROMPTS, delay: process.env.CBASE_TEST_DELAY,
    restartGrace: process.env.CBASE_RESTART_GRACE_MS,
  };
  let server, base = "", finished = false;
  try {
    // No restart follow-up: it is not the subject here.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(prompts, "");
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_PROMPTS = prompts;
    process.env.CBASE_TEST_DELAY = String(delayMs);
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Cap", path: wsPath }) });
    // Only WHOLE lines: the fake CLI writes while the test reads.
    await fn({ base, ws, promptsOf: () => fs.readFileSync(prompts, "utf8").split("\n").slice(0, -1).filter(Boolean) });
    finished = true;
  } finally {
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll],
                          ["CBASE_TEST_PROMPTS", prev.prompts], ["CBASE_TEST_DELAY", prev.delay],
                          ["CBASE_RESTART_GRACE_MS", prev.restartGrace]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // A test must not fail because its temp directory does not go away: a child process still writing
    // causes ENOTEMPTY, which says something about the cleanup, not about the product. It is still not
    // hidden, otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}); test unaffected.`); }
  }
}

async function makeFlow(base, ws, name, graph, extra = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
    // `doneAll: false`: "check all work steps" is on by default; this is about the round cap, and the
    // fake CLI answers every verdict with "Title" (unusable).
    method: "PUT", body: JSON.stringify({ graph, lock: { scope: "off", template: "" }, ...extra, run: { doneAll: false, ...(extra.run || {}) } }),
  });
}
async function newChat(base, ws, title) {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}
const start = (base, chatId, workflowId, input = "") =>
  json(`${base}/api/chats/${chatId}/workflow`, { method: "POST", body: JSON.stringify({ workflowId, input }) });
const runOf = (base, runId) => json(`${base}/api/workflow-runs/${runId}`);
const untilStatus = (base, runId, ...want) =>
  waitFor(async () => { const d = await runOf(base, runId); return want.includes(d.run.status) ? d : null; });
const answer = (base, chatId, text) =>
  json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
// Wait until the run waits again AND hangs at the cap (not at a question node).
const untilCap = (base, chatId) =>
  waitFor(async () => {
    const d = await json(`${base}/api/chats/${chatId}/workflow`);
    return d.run?.status === "waiting" && d.run?.pending === "cap" ? d.run : null;
  });

// Cycle: instruction, condition ("no" via marker), back to the instruction. The head of the round is
// the instruction; the round count lives there.
const loop = (maxVisits) => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "Round", text: "WORK", ...(maxVisits ? { maxVisits } : {}), x: 200, y: 0 },
    { id: "c1", type: "condition", title: "Done?", text: "Is everything done? (NO-PLEASE)", x: 420, y: 0 },
    { id: "e1", type: "end", title: "End", x: 640, y: -80 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "e1", branch: "true" }, { from: "c1", to: "n1", branch: "false" }],
});

test("Cap calculation rules: counter per loop iteration, own number per step, reading of the answer", () => {
  // The node's own number beats the default, 0 means default, nonsense is capped.
  const g = wf.normalizeGraph({
    nodes: [
      { id: "a", type: "instruction", title: "A", maxVisits: 3 },
      { id: "b", type: "instruction", title: "B" },
      { id: "c", type: "instruction", title: "C", maxVisits: -5 },
      { id: "d", type: "instruction", title: "D", maxVisits: 5000 },
    ],
    edges: [],
  });
  const [a, b, c, d] = g.nodes;
  assert.equal(a.maxVisits, 3);
  assert.equal(b.maxVisits, 0, "without a value: 0 = default of the run");
  assert.equal(c.maxVisits, 0, "a negative number is no value");
  assert.equal(d.maxVisits, wf.MAX_VISITS_LIMIT, "hard upper limit");
  assert.equal(wf.visitCap(a, 5), 3);
  assert.equal(wf.visitCap(b, 5), 5);

  // Counting and cap.
  let cur = wf.initialCursor(g);
  assert.equal(wf.visitCount(cur, "a"), 0);
  cur = wf.countVisit(cur, "a");
  cur = wf.countVisit(cur, "a");
  assert.equal(wf.visitCount(cur, "a"), 2);
  assert.equal(wf.capReached(cur, a, 5), false, "2 of 3 rounds");
  cur = wf.countVisit(cur, "a");
  assert.equal(wf.capReached(cur, a, 5), true, "3 of 3 rounds: cap");
  // Granted rounds raise the cap for EXACTLY this step.
  const more = wf.grantVisits(cur, a, 2);
  assert.equal(wf.capReached(more, a, 5), false);
  assert.equal(wf.visitBudget(more, a, 5), 5);

  // The body of a loop is no cycle: every iteration has its own counter.
  const inLoop = (index) => ({ ...cur, frames: [{ node: "l1", items: ["x", "y", "z"], index, body: "a", exit: "" }] });
  let it0 = wf.countVisit(inLoop(0), "a");
  assert.equal(wf.visitCount(it0, "a"), 1, "first iteration");
  const it1 = wf.countVisit({ ...it0, frames: [{ ...it0.frames[0], index: 1 }] }, "a");
  assert.equal(wf.visitCount(it1, "a"), 1, "second iteration counts from scratch");
  assert.notEqual(wf.visitKey(inLoop(0), "a"), wf.visitKey(inLoop(1), "a"));

  // Reading of the answer: the parser decides only what is UNAMBIGUOUS.
  assert.equal(wf.capIntent("weiter"), "go");
  assert.equal(wf.capIntent("Ja, mach weiter — aber nur den Server-Fix"), "go");
  assert.equal(wf.capIntent("noch 2 Runden bitte"), "go");
  assert.equal(wf.capIntent("abschließen"), "stop");
  assert.equal(wf.capIntent("nein, das reicht"), "stop");
  assert.equal(wf.capIntent(""), "stop", "no answer does not mean continue");
  assert.equal(wf.capIntent("was meinst du dazu?"), "unclear");
  assert.equal(wf.capRounds("noch 3 Runden", 5), 3);
  assert.equal(wf.capRounds("weiter", 5), 5, "without a number the cap applies once more");

  // Cycle detection for the editor hint: the head of the round is the target of the back edge.
  const cycle = wf.normalizeGraph(loop(0));
  const info = wf.cycleInfo(cycle);
  assert.deepEqual([...info.heads], ["n1"]);
  assert.deepEqual([...info.nodes].sort(), ["c1", "n1"]);
  // The same pattern finds the hint (positive) and must not find it with an own number (negative).
  const roundHint = /beginnt eine Runde|starts a round/;
  const hint = wf.checkGraph(loop(0)).find((p) => roundHint.test(p.text));
  assert.ok(hint, "a cycle without its own number should be explained in the editor");
  assert.equal(hint.nodeId, "n1");
  assert.ok(!wf.checkGraph(loop(3)).some((p) => roundHint.test(p.text)), "no hint with an own number");
});

test("Cycle with cap 2: after two rounds the run stops and asks (instead of spinning on)", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Cap-cycle", loop(2));
    const chat = await newChat(base, ws, "Cap-chat");
    const r = await start(base, chat.id, flow.id);
    const held = await untilCap(base, chat.id);
    assert.ok(held, "the run should have waited at the cap");
    assert.equal(held.status, "waiting");
    assert.match(held.question, /Runden-Deckel|Round cap/i);
    assert.match(held.question, /Round["”]/, `the question does not name the step: ${held.question}`);
    assert.match(held.question, /2/, `the question does not name the numbers: ${held.question}`);

    // Exactly two rounds ran, not three.
    const turns = promptsOf().filter((l) => l.startsWith("TURN") && /WORK/.test(l));
    assert.equal(turns.length, 2, `expected 2 rounds, got ${turns.length}`);

    // The cap stands in the step log AND as a line in the chat (both clients render it).
    const d = await runOf(base, r.run.id);
    const capStep = d.steps.find((s) => s.kind === "cap");
    assert.ok(capStep, `no cap row: ${d.steps.map((s) => s.kind).join(",")}`);
    assert.equal(capStep.detail.rounds, 2);
    assert.equal(capStep.detail.cap, 2);
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const lines = (Array.isArray(log) ? log : log.messages || []).filter((m) => m.role === "workflow").map((m) => JSON.parse(m.text));
    assert.ok(lines.some((l) => l.kind === "cap" && !l.granted), "the cap line is missing in the history");

    // "abschließen" (finish) ends the run here, with a reason, not as an error.
    await answer(base, chat.id, "abschließen");
    const ended = await untilStatus(base, r.run.id, "cancelled", "done", "failed");
    assert.equal(ended.run.status, "cancelled", `status was ${ended.run.status}: ${ended.run.note}`);
    assert.match(ended.run.note, /Runden-Deckel|round cap/i, `reason missing: ${ended.run.note}`);
    // A round after the end would be a turn, which quiet counts too (instead of trusting the status alone).
    await waitForQuiet(base);
    assert.equal(promptsOf().filter((l) => l.startsWith("TURN") && /WORK/.test(l)).length, 2, "a round still ran after finish");
  });
});

test("continue grants exactly the next rounds, and the cap applies again afterwards", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Cap-continue", loop(1));
    const chat = await newChat(base, ws, "Continue-chat");
    const r = await start(base, chat.id, flow.id);
    const rounds = () => promptsOf().filter((l) => l.startsWith("TURN") && /WORK/.test(l)).length;

    await untilCap(base, chat.id);
    assert.equal(rounds(), 1);

    // Without a number the cap applies once more (here: 1 more round).
    await answer(base, chat.id, "weiter");
    await waitFor(async () => rounds() >= 2);
    const secondHold = await untilCap(base, chat.id);
    assert.ok(secondHold, "after the granted round the cap should have applied again");
    assert.equal(rounds(), 2, "continue let more than the granted round run");

    // With a number: exactly that many.
    await answer(base, chat.id, "noch 2 Runden");
    await waitFor(async () => rounds() >= 4);
    await untilCap(base, chat.id);
    assert.equal(rounds(), 4, `"noch 2" gave ${rounds()} instead of 4 rounds`);

    // The grant stands as its own line in the history (with the number).
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const granted = (Array.isArray(log) ? log : log.messages || [])
      .filter((m) => m.role === "workflow").map((m) => JSON.parse(m.text)).filter((l) => l.kind === "cap" && l.granted);
    assert.deepEqual(granted.map((l) => l.granted), [1, 2]);

    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
  });
});

test("An unclear answer is judged, and a failed verdict BRAKES (instead of running on)", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const rounds = (p) => p.filter((l) => l.startsWith("TURN") && /WORK/.test(l)).length;

    // 1) Unclear but readable: the verdict grants 1 round (marker MORE-PLEASE).
    const flowA = await makeFlow(base, ws, "Cap-verdict", loop(1));
    const chatA = await newChat(base, ws, "Verdict-chat");
    const rA = await start(base, chatA.id, flowA.id);
    await untilCap(base, chatA.id);
    await answer(base, chatA.id, "was hältst du davon? MORE-PLEASE");
    await waitFor(async () => rounds(promptsOf()) >= 2);
    assert.ok(await untilCap(base, chatA.id), "the stop is missing after the granted round");
    assert.equal(rounds(promptsOf()), 2, "the verdict granted more than one round");
    await json(`${base}/api/chats/${chatA.id}/workflow/cancel`, { method: "POST" });
    await runOf(base, rA.run.id);

    // 2) Unclear and unusable model output: when in doubt, stop.
    const flowB = await makeFlow(base, ws, "Cap-broken", loop(1));
    const chatB = await newChat(base, ws, "Broken-chat");
    const rB = await start(base, chatB.id, flowB.id);
    await untilCap(base, chatB.id);
    const prior = rounds(promptsOf());
    await answer(base, chatB.id, "hm, BROKEN-PLEASE, entscheide du");
    const ended = await untilStatus(base, rB.run.id, "cancelled", "done", "failed");
    assert.equal(ended.run.status, "cancelled", `status was ${ended.run.status}: ${ended.run.note}`);
    assert.match(ended.run.note, /nicht deutbar|Could not read/i, `reason missing: ${ended.run.note}`);
    await waitForQuiet(base);
    assert.equal(rounds(promptsOf()), prior, "a further round ran despite the unclear answer");
  });
});

test("Without an own number the default of the run applies, and skip leads past the cap", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    // Cycle with two steps, so that skip has a visible target.
    const flow = await makeFlow(base, ws, "Cap-default", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Round", text: "WORK", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Afterwards", text: "AFTERWARDS", x: 420, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n1" }],
    });
    const chat = await newChat(base, ws, "Default-chat");
    const r = await start(base, chat.id, flow.id);
    const held = await untilCap(base, chat.id);
    assert.ok(held, "the cap must apply even without an own number");
    const rounds = promptsOf().filter((l) => l.startsWith("TURN") && /WORK/.test(l)).length;
    assert.equal(rounds, wf.DEFAULT_MAX_VISITS, `default is ${wf.DEFAULT_MAX_VISITS} rounds, ran ${rounds}`);
    assert.equal(held.nodeTitle, "Round", "the cap must apply at the head of the round");

    // Skip answers the cap question: the step is left out and the flow continues behind it (the next
    // step runs); the run does not hang at the same cap again at once.
    const priorAfterwards = promptsOf().filter((l) => l.startsWith("TURN") && /AFTERWARDS/.test(l)).length;
    await json(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" });
    // The result IS checked (otherwise it slips through that after the jump the neighbour's equally high
    // cap asked at once instead of the step running).
    const ranReally = await waitFor(async () => promptsOf().filter((l) => l.startsWith("TURN") && /AFTERWARDS/.test(l)).length > priorAfterwards);
    assert.ok(ranReally, "after skipping the next step must REALLY run, not its cap ask");
    const afterwards = await json(`${base}/api/chats/${chat.id}/workflow`);
    assert.ok(["running", "waiting"].includes(afterwards.run.status), `run was ${afterwards.run.status}`);
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    await runOf(base, r.run.id);
  });
});

test("Exit of a cycle: the own cycle counts, not just any in the graph", () => {
  // Two SEPARATE cycles. The exit of n1 is "Onwards", not the foreign cycle around m1.
  const g = wf.normalizeGraph({
    nodes: [
      { id: "s0", type: "start", title: "Start" },
      { id: "n1", type: "instruction", title: "Round A" },
      { id: "c1", type: "condition", title: "Done A?" },
      { id: "w1", type: "instruction", title: "Onwards" },
      { id: "m1", type: "instruction", title: "Round B" },
      { id: "c2", type: "condition", title: "Done B?" },
    ],
    edges: [
      { from: "s0", to: "n1" }, { from: "n1", to: "c1" },
      { from: "c1", to: "n1", branch: "false" }, { from: "c1", to: "w1", branch: "true" },
      { from: "w1", to: "m1" }, { from: "m1", to: "c2" }, { from: "c2", to: "m1", branch: "false" },
    ],
  });
  assert.deepEqual([...wf.cycleGroup(g, "n1")].sort(), ["c1", "n1"]);
  assert.equal(wf.cycleExit(g, "n1"), "w1", "the exit is the yes path of the own condition");
  assert.equal(wf.cycleExit(g, "m1"), null, "the second cycle has no exit");
  assert.equal(wf.cycleExit(g, "w1"), "m1", "without a cycle the exit is simply the successor");
  // The old checkbox `capAuto` (legacy data, now two three-valued fields): only a real `true` becomes
  // "continue", at BOTH caps (it applied to both). The normalized output no longer carries the old name.
  const including = wf.normalizeGraph({ nodes: [{ id: "a", type: "instruction", capAuto: true }, { id: "b", type: "instruction", capAuto: "yes" }], edges: [] });
  assert.equal(including.nodes[0].loopCapMode, "continue");
  assert.equal(including.nodes[0].doneCapMode, "continue");
  assert.equal(including.nodes[1].loopCapMode, "inherit", "only a real true continues without asking");
  assert.equal(including.nodes[1].doneCapMode, "inherit");
  assert.ok(!("capAuto" in including.nodes[0]), "the old name drops out of the output");
});

test("Checkbox without asking: the run leaves the loop itself and keeps working behind it", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Cap-auto", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Round", text: "WORK", maxVisits: 2, capAuto: true, x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Done?", text: "Is everything done? (NO-PLEASE)", x: 420, y: 0 },
        { id: "w1", type: "instruction", title: "Afterwards", text: "COMPLETION", x: 640, y: -80 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "w1", branch: "true" }, { from: "c1", to: "n1", branch: "false" }],
    });
    const chat = await newChat(base, ws, "Auto-chat");
    const r = await start(base, chat.id, flow.id);
    const ended = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(ended.run.status, "done", `run ended as ${ended.run.status}: ${ended.run.note || ended.run.question}`);

    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.filter((l) => /WORK/.test(l)).length, 2, "exactly two rounds");
    assert.equal(turns.filter((l) => /COMPLETION/.test(l)).length, 1, "the step BEHIND the loop must have run");
    // Never waited, and the line says where it went.
    const capStep = ended.steps.find((s) => s.kind === "cap");
    assert.ok(capStep, `no cap row: ${ended.steps.map((s) => s.kind).join(",")}`);
    assert.equal(capStep.detail.auto, true);
    assert.equal(capStep.detail.exit, "Afterwards");
    assert.match(capStep.detail.note, /ohne Rückfrage|without asking/i);
    assert.ok(!ended.steps.some((s) => s.kind === "ask"), "there must not have been a question");
  });
});

test("Checkbox without exit: the run ends with a clear reason instead of silently spinning on", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    // Cycle without a yes path: the condition has only the back edge.
    const flow = await makeFlow(base, ws, "Cap-auto-dead-end", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Round", text: "WORK", maxVisits: 1, capAuto: true, x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Done?", text: "Is everything done? (NO-PLEASE)", x: 420, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "n1", branch: "false" }],
    });
    const chat = await newChat(base, ws, "Dead-end-chat");
    const r = await start(base, chat.id, flow.id);
    const ended = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    // Deliberately FAILED, not "done": the run never reached its end; as "done" it could be told from a
    // regular run in list, history and counters only by its note text. Ending visibly means failing visibly.
    assert.equal(ended.run.status, "failed", `status was ${ended.run.status}: ${ended.run.note}`);
    assert.match(ended.run.note, /keinen Ausgang|no exit/i, `reason missing: ${ended.run.note}`);
    await waitForQuiet(base);
    assert.equal(promptsOf().filter((l) => l.startsWith("TURN") && /WORK/.test(l)).length, 1);
  });
});

test("The body of a loop is no cycle: three elements run through completely despite cap 1", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Loop-with-cap", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "l1", type: "loop", title: "Per file", items: ["one.txt", "two.txt", "three.txt"], maxIterations: 20, x: 200, y: 0 },
        // Cap 1: ONE round per iteration, and that must not brake the loop.
        { id: "n1", type: "instruction", title: "Process", text: "Process {{element}}", maxVisits: 1, x: 420, y: -60 },
        { id: "n2", type: "instruction", title: "Conclusion", text: "SUMMARIZE", x: 420, y: 80 },
      ],
      edges: [{ from: "s0", to: "l1" }, { from: "l1", to: "n1", branch: "each" }, { from: "l1", to: "n2", branch: "done" }],
    });
    const chat = await newChat(base, ws, "Loop-chat");
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed", "cancelled", "waiting");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note || done.run.question}`);
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.length, 4, `expected 3 elements + conclusion, got ${turns.length}`);
    assert.match(turns[0], /Process one\.txt/);
    assert.match(turns[2], /Process three\.txt/);
    assert.ok(!done.steps.some((s) => s.kind === "cap"), "the cap braked an ordinary loop");
  });
});

test("Cap per cycle: default nodes inherit the largest set value, brakes stay, checkbox counts cycle-wide", () => {
  const g = wf.normalizeGraph({
    nodes: [
      { id: "a", type: "instruction", title: "A", maxVisits: 20, capAuto: true },
      { id: "b", type: "instruction", title: "B" },               // inherits 20 with the checkbox from A
      { id: "c", type: "instruction", title: "C", maxVisits: 2 }, // deliberate brake, stays 2
      { id: "x", type: "instruction", title: "X" },               // hangs off the cycle but does not lie on it
    ],
    edges: [
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" },
      { from: "a", to: "x" },
    ],
  });
  const eff = (id) => wf.effectiveCap(g, wf.nodeById(g, id), 5);
  assert.deepEqual([eff("b").cap, eff("b").auto, eff("b").from?.id], [20, true, "a"], "B must inherit cap AND checkbox from A");
  assert.deepEqual([eff("c").cap, eff("c").auto], [2, false], "the own small value stays as a brake");
  assert.deepEqual([eff("a").cap, eff("a").auto], [20, true]);
  assert.deepEqual([eff("x").cap, eff("x").from], [5, null], "off the cycle the default applies");

  // If NOBODY in the cycle carries a number, the default stays, but the checkbox counts cycle-wide.
  const g2 = wf.normalizeGraph({
    nodes: [{ id: "a", type: "instruction", capAuto: true }, { id: "b", type: "instruction" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
  });
  assert.equal(wf.effectiveCap(g2, wf.nodeById(g2, "b"), 5).auto, true, "the checkbox on A applies even when B comes up first");
  assert.equal(wf.effectiveCap(g2, wf.nodeById(g2, "b"), 5).cap, 5);

  // "continue" distributes to ALL cycle nodes; outside only to the node itself.
  const c0 = wf.initialCursor(g);
  const inCycle = wf.grantCycle(g, c0, wf.nodeById(g, "b"), 3);
  assert.deepEqual(["a", "b", "c", "x"].map((id) => wf.grantedVisits(inCycle, id)), [3, 3, 3, 0]);
  const outside = wf.grantCycle(g, c0, wf.nodeById(g, "x"), 2);
  assert.deepEqual(["a", "b", "c", "x"].map((id) => wf.grantedVisits(outside, id)), [0, 0, 0, 2]);
});

test("No question cascade: continue applies to the whole loop, not only the asking node", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    // Two work steps in the cycle, cap 2 ONLY on the first; the second inherits it. Otherwise after
    // "continue" the neighbour's equally high cap would ask at once (once per cycle node).
    const flow = await makeFlow(base, ws, "Cap-cycle-wide", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Round", text: "WORK", maxVisits: 2, x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Afterwards", text: "AFTERWARDS", x: 420, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n1" }],
    });
    const chat = await newChat(base, ws, "Cycle-wide-chat");
    await start(base, chat.id, flow.id);
    const count = (marker) => promptsOf().filter((l) => l.startsWith("TURN") && new RegExp(marker).test(l)).length;

    const hold1 = await untilCap(base, chat.id);
    assert.equal(count("WORK"), 2, "the cap must apply after 2 rounds");
    assert.equal(count("AFTERWARDS"), 2, "the neighbour inherits cap 2, not the default");
    assert.match(hold1.question, /ganze Schleife|whole loop/i, `the question does not say that the rounds apply to the cycle: ${hold1.question}`);

    await answer(base, chat.id, "weiter");
    // First wait for the NEW rounds: right after the answer the old stop may still be standing, and
    // untilCap would read it as the second.
    await waitFor(() => count("WORK") >= 4, "the two granted rounds run");
    const hold2 = await untilCap(base, chat.id);
    assert.equal(count("WORK"), 4, "continue must give 2 full rounds");
    assert.equal(count("AFTERWARDS"), 4, "the neighbour should have received its rounds too (cascade!)");
    assert.equal(hold2.nodeTitle, "Round", "the question comes at the head of the round again, not at the neighbour");

    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
  });
});

test("Inherited checkbox: the loop leaves itself even when the cap tears at the neighbour", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    // Cap AND checkbox sit on the condition, but the cap tears at the work step because it comes up
    // first in the round. Without inheriting, the run would ask here despite the checkbox.
    const flow = await makeFlow(base, ws, "Cap-inherit-auto", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Round", text: "WORK", x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Done?", text: "Done? (NO-PLEASE)", maxVisits: 2, capAuto: true, x: 420, y: 0 },
        { id: "n9", type: "instruction", title: "Conclusion", text: "COMPLETION", x: 640, y: -80 },
      ],
      edges: [
        { from: "s0", to: "n1" }, { from: "n1", to: "c1" },
        { from: "c1", to: "n9", branch: "true" }, { from: "c1", to: "n1", branch: "false" },
      ],
    });
    const chat = await newChat(base, ws, "Inherit-auto-chat");
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note || done.run.question}`);
    const count = (m) => promptsOf().filter((l) => l.startsWith("TURN") && new RegExp(m).test(l)).length;
    assert.equal(count("WORK"), 2, "the inherited cap 2 applies to the work step too");
    assert.equal(count("COMPLETION"), 1, "after the cap the run must leave the loop and run the conclusion");
    const cap = done.steps.find((s) => s.kind === "cap");
    assert.ok(cap?.detail?.auto, "the cap row must show the automatic continuation");
    assert.equal(cap.detail.from, "Done?", "the log names from whom the cap was inherited");
  });
});
