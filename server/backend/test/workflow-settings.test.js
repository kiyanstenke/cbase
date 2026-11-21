// Workflow settings.
//
// Held here:
//   · the six run settings (normalization, partial patch with `null`, 400 for changed nonsense, never on the chat) and the
//     three node modes including reading of the legacy state;
//   · rules 1–4: who effectively checks, who proceeds at the check cap, who proceeds at the round cap of a cycle, how many
//     check rounds there are — at the graph library AND in a real run;
//   · rule 5 and the compaction BETWEEN two steps by the workflow's values (otherwise chat, otherwise global), not between
//     check rounds, not before an own /compact or /clear, once per visit; the same values for the loop engine (`compactAt`);
//   · `compaction` in the run view.
// Driven over the real HTTP routes with a fake CLI that answers by the prompt.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as ac from "../electron/server/autocompact.js";
import * as wf from "../electron/server/workflows.js";
import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { autocompactMax, autocompactPercent } from "../electron/server/runs/post-run.js";
import { compactionWaitRounds } from "../electron/server/workflows/driver.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
async function status(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  await res.text();
  return res.status;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an EVENT, without a deadline: under load a deadline measures the machine. If it hangs, the
// suite deadline is the emergency brake; every 30 s a line on stderr says what is being waited for.
async function waitFor(fn, what) {
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

// Fake CLI:
//  · Oneshot: "compacting the chat history" ⇒ summary; gate prompt ("work step is DONE") by CBASE_TEST_GATE:
//    "yes" = done at once, "never" = never done, "second" = the first verdict of the run "not
//    done", done afterwards; condition: NO-PLEASE ⇒ no, otherwise yes; everything else "Title".
//  · Turn: reports CBASE_TEST_CTX input tokens (sets the chat's `contextTokens` — so the compaction
//    becomes due without writing the database from outside) and answers "DONE: …".
//  · CBASE_TEST_COMPRESS_GATE (a file path): the summary logs "COMPRESS-START" and ends only
//    once the test creates this file — the window in which a human writes or skips thus stays open as
//    long as the test needs it, and hangs on no clock.
//  · CBASE_TEST_VERDICT_GATE: likewise for the completion verdict — it is logged ("VERDICT …") and
//    answers only once the file exists. CBASE_TEST_TURN_GATE: a turn with "HOLD-UNTIL-GATE" in the text answers only
//    once THIS file exists. CBASE_TEST_END_GATE: a process that had a turn with "HOLD-END" logs "END-WAITING" after
//    stdin closes and ends only once the file exists (the window AFTER the `result`, in which a message is no
//    longer injected but queued). CBASE_TEST_PIDLOG: one line "PID <pid> <text>" per turn.
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
    let result = "Title";
    if (/compacting the chat history/i.test(stdin)) {
      const gate = process.env.CBASE_TEST_COMPRESS_GATE || "";
      if (gate) {
        log("COMPRESS-START");
        const open = () => {
          if (!fs.existsSync(gate)) return void setTimeout(open, 30);
          log("COMPRESSED"); process.stdout.write(JSON.stringify({ result: "SUMMARY of the history" })); clearTimeout(guard); process.exit(0);
        };
        return open();
      }
      log("COMPRESSED"); result = "SUMMARY of the history";
    }
    else if (/work step is DONE/.test(stdin)) {
      log("VERDICT " + stdin.slice(0, 300));
      const mode = process.env.CBASE_TEST_GATE || "yes";
      let prior = 0;
      try { prior = (fs.readFileSync(process.env.CBASE_TEST_PROMPTS, "utf8").match(/^VERDICT /gm) || []).length; } catch {}
      const finished = mode === "yes" || (mode === "second" && prior > 1);
      result = finished ? '{"done": true, "note": ""}' : '{"done": false, "note": "something is still missing"}';
      const utor = process.env.CBASE_TEST_VERDICT_GATE || "";
      if (utor) {
        const open = () => {
          if (!fs.existsSync(utor)) return void setTimeout(open, 30);
          process.stdout.write(JSON.stringify({ result })); clearTimeout(guard); process.exit(0);
        };
        return open();
      }
    }
    else if (/condition/i.test(stdin)) result = /NO-PLEASE/.test(stdin) ? '{"yes": false, "note": "no"}' : '{"yes": true, "note": "yes"}';
    process.stdout.write(JSON.stringify({ result }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  let holdEnd = false;
  process.stdin.on("end", () => {
    const etor = process.env.CBASE_TEST_END_GATE || "";
    if (!holdEnd || !etor) return process.exit(0);
    log("END-WAITING");
    const t = setInterval(() => { if (fs.existsSync(etor)) { clearInterval(t); process.exit(0); } }, 30);
  });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    log("TURN " + text.slice(0, 1200));
    if (process.env.CBASE_TEST_PIDLOG) log("PID " + process.pid + " " + text.slice(0, 200));
    holdEnd = holdEnd || text.includes("HOLD-END");
    const out = "DONE: " + text.replace(/\\s+/g, " ").slice(0, 80);
    const ctx = Number(process.env.CBASE_TEST_CTX || 0);
    const respond = () => setTimeout(() => {
      say({ type: "assistant", message: { ...(ctx ? { usage: { input_tokens: ctx, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } : {}), content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "wfe-" + Math.random().toString(36).slice(2, 8) });
    }, 60);
    const ttor = process.env.CBASE_TEST_TURN_GATE || "";
    if (!ttor || !text.includes("HOLD-UNTIL-GATE")) return void respond();
    const t = setInterval(() => { if (fs.existsSync(ttor)) { clearInterval(t); respond(); } }, 30);
  });
}
`;

async function stopAllRuns(base) {
  try {
    const b = await json(`${base}/api/active-runs`);
    for (const it of b?.items || []) {
      if (it.chatId && (it.phase === "running" || it.phase === "waiting")) {
        await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
      }
    }
  } catch { /* server closed or never came up */ }
}
function killFakeChildren(bin) {
  let pids = [];
  try { pids = execFileSync("/usr/bin/pgrep", ["-f", bin], { encoding: "utf8" }).split("\n").map((x) => +x.trim()).filter(Boolean); }
  catch { return; }
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

async function withServer(fn, { gate = "yes", ctx = 0, compressGate = false, verdictGate = false, pidLog = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wfe-"));
  const bin = path.join(root, "fake-claude");
  const prompts = path.join(root, "prompts.log");
  const verdictGatePath = path.join(root, "verdict-gate");
  const turnGatePath = path.join(root, "turn-gate");
  const endGatePath = path.join(root, "end-gate");
  const KEYS = ["CLAUDE_BIN", "CBASE_TRIGGER_POLL", "CBASE_TEST_PROMPTS", "CBASE_TEST_GATE", "CBASE_TEST_CTX", "CBASE_TEST_COMPRESS_GATE", "CBASE_TEST_VERDICT_GATE", "CBASE_TEST_TURN_GATE", "CBASE_TEST_END_GATE", "CBASE_TEST_PIDLOG", "CBASE_RESTART_GRACE_MS"];
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server, base = "", finished = false;
  try {
    // No restart: it is not the subject here, and 2.5 s after the start it would take a run with a
    // verdict in flight for interrupted (see workflow-engine-e2e.test.js).
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(prompts, "");
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_PROMPTS = prompts;
    process.env.CBASE_TEST_GATE = gate;
    process.env.CBASE_TEST_CTX = String(ctx);
    const gateState = path.join(root, "compress-gate");
    if (compressGate) process.env.CBASE_TEST_COMPRESS_GATE = gateState; else delete process.env.CBASE_TEST_COMPRESS_GATE;
    if (verdictGate) process.env.CBASE_TEST_VERDICT_GATE = verdictGatePath; else delete process.env.CBASE_TEST_VERDICT_GATE;
    process.env.CBASE_TEST_TURN_GATE = turnGatePath;
    process.env.CBASE_TEST_END_GATE = endGatePath;
    if (pidLog) process.env.CBASE_TEST_PIDLOG = "1"; else delete process.env.CBASE_TEST_PIDLOG;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "WFE", path: wsPath }) });
    // Only WHOLE lines: the fake CLI writes while the test reads.
    await fn({
      base, ws, log: () => fs.readFileSync(prompts, "utf8").split("\n").slice(0, -1).filter(Boolean), openTheGate: () => fs.writeFileSync(gateState, ""),
      verdictOpen: () => fs.writeFileSync(verdictGatePath, ""), turnOpen: () => fs.writeFileSync(turnGatePath, ""),
      endOpen: () => fs.writeFileSync(endGatePath, ""),
    });
    finished = true;
  } finally {
    // After a passed test first quiet (a remainder that is still working belongs to the test), then stop open
    // runs, the connections, the server; finally hard whatever of THIS temp bin still lives
    // (a oneshot hangs on no stop route).
    for (const t of [verdictGatePath, turnGatePath, endGatePath]) { try { fs.writeFileSync(t, ""); } catch { /* folder already gone */ } }
    if (base && finished) await waitForQuiet(base);
    if (base) await stopAllRuns(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    killFakeChildren(bin);
    for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// `run` is sent exactly as the test gives it — `undefined` means: no `run` at all.
async function makeFlow(base, ws, name, graph, run) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
    method: "PUT", body: JSON.stringify({ graph, lock: { scope: "off", template: "" }, ...(run !== undefined ? { run } : {}) }),
  });
}
async function newChat(base, ws, fields = {}) {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "WFE-Chat", ...fields }) });
  return json(`${base}/api/chats/${chat.id}`);
}
// With input: it stands as a user message in the history. The step prompts themselves do NOT stand
// there (role "workflow") — without input the history before the second step would hold only ONE answer,
// and the compaction would report "too little history".
const start = (base, chatId, workflowId) =>
  json(`${base}/api/chats/${chatId}/workflow`, { method: "POST", body: JSON.stringify({ workflowId, input: "JOB" }) });
const runOf = (base, runId) => json(`${base}/api/workflow-runs/${runId}`);
const untilStatus = (base, runId, ...want) =>
  waitFor(async () => { const d = await runOf(base, runId); return want.includes(d.run.status) ? d : null; }, `run ${runId} in ${want.join("/")}`);
const gates = (d) => d.steps.filter((s) => s.kind === "gate");

// Chain: start → A → B → end. `a`/`b` add the node fields.
const chain = (a = {}, b = {}) => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "One", text: "STEP-ONE", x: 200, y: 0, ...a },
    { id: "n2", type: "instruction", title: "Two", text: "STEP-TWO", x: 400, y: 0, ...b },
    { id: "e0", type: "end", title: "End", x: 600, y: 0 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
});
// Cycle: instruction (cap 2) → condition (always "no") → back; "yes" leads to the end.
const cycle = (n1 = {}, c1 = {}) => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "Round", text: "WORK", maxVisits: 2, x: 200, y: 0, ...n1 },
    { id: "c1", type: "condition", title: "Finished?", text: "Done? (NO-PLEASE)", x: 400, y: 0, ...c1 },
    { id: "e1", type: "end", title: "End", x: 600, y: 0 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "e1", branch: "true" }, { from: "c1", to: "n1", branch: "false" }],
});

// ── Data: normalization and legacy state ────────────────────────────────────────────────────────

test("Run settings: six fields, defaults, nonsense falls back to the default, none of it onto the chat", () => {
  const empty = wf.normalizeRunSettings({});
  assert.equal(empty.autocompact, null, "default is the absence of a choice");
  assert.equal(empty.autocompactMax, null);
  assert.equal(empty.doneAll, true, "missing means ON");
  assert.equal(empty.doneRounds, wf.DONE_ROUNDS_DEFAULT);
  assert.equal(wf.DONE_ROUNDS_DEFAULT, 3);
  assert.equal(wf.DONE_ROUNDS_MAX, 10);
  assert.equal(empty.doneCapAuto, false, "at the check cap: question");
  assert.equal(empty.loopCapAuto, false, "at the round cap: question");

  const s = wf.normalizeRunSettings({ autocompact: 0, autocompactMax: 0, doneAll: false, doneRounds: 10, doneCapAuto: true, loopCapAuto: true });
  assert.equal(s.autocompact, 0, "0 means off and stays 0 — not default");
  assert.equal(s.autocompactMax, 0);
  assert.equal(s.doneAll, false);
  assert.equal(s.doneRounds, 10);
  assert.equal(s.doneCapAuto, true);
  assert.equal(s.loopCapAuto, true);
  assert.equal(wf.normalizeRunSettings({ autocompact: 60, autocompactMax: 50_000 }).autocompact, 60);
  assert.equal(wf.normalizeRunSettings({ autocompactMax: 50_000 }).autocompactMax, 50_000);

  for (const v of [63, "x", true, -1]) assert.equal(wf.normalizeRunSettings({ autocompact: v }).autocompact, null, `autocompact ${v}`);
  for (const v of [12_345, "x", true]) assert.equal(wf.normalizeRunSettings({ autocompactMax: v }).autocompactMax, null, `autocompactMax ${v}`);
  for (const v of [0, 11, 2.5, "x", true, null]) assert.equal(wf.normalizeRunSettings({ doneRounds: v }).doneRounds, 3, `doneRounds ${v}`);
  assert.equal(wf.normalizeRunSettings({ doneAll: "no" }).doneAll, true, "only a real false switches off");
  assert.equal(wf.normalizeRunSettings({ doneCapAuto: "yes", loopCapAuto: 1 }).doneCapAuto, false);
  assert.equal(wf.normalizeRunSettings({ loopCapAuto: 1 }).loopCapAuto, false);

  // None of the new fields ever lands on the chat.
  assert.deepEqual(wf.chatFieldsFromRun({ autocompact: 60, autocompactMax: 50_000, doneAll: false, doneRounds: 5, doneCapAuto: true, loopCapAuto: true }), {});
});

test("Node modes: the legacy state is read once, the output carries only the three new fields", () => {
  const g = wf.normalizeGraph({
    nodes: [
      { id: "a", type: "instruction", doneCheck: true },
      { id: "b", type: "instruction", doneCheck: false, capAuto: false },
      { id: "c", type: "instruction", capAuto: true },
      { id: "d", type: "instruction", doneMode: "off", doneCapMode: "ask", loopCapMode: "continue", doneCheck: true, capAuto: false },
      { id: "e", type: "instruction", doneMode: "maybe", doneCapMode: 3, loopCapMode: null },
      { id: "f", type: "condition" },
    ],
    edges: [],
  });
  const m = Object.fromEntries(g.nodes.map((n) => [n.id, [n.doneMode, n.doneCapMode, n.loopCapMode]]));
  assert.deepEqual(m.a, ["on", "inherit", "inherit"], "doneCheck: true ⇒ an");
  assert.deepEqual(m.b, ["inherit", "inherit", "inherit"], "doneCheck: false cannot be told from “never touched” in the legacy state ⇒ like the workflow");
  assert.deepEqual(m.c, ["inherit", "continue", "continue"], "capAuto applied to BOTH caps");
  assert.deepEqual(m.d, ["off", "ask", "continue"], "the new fields take precedence over the legacy state");
  assert.deepEqual(m.e, ["inherit", "inherit", "inherit"], "nonsense ⇒ like the workflow");
  assert.deepEqual(m.f, ["inherit", "inherit", "inherit"], "every node carries the three fields");
  for (const n of g.nodes) {
    assert.ok(!("doneCheck" in n) && !("capAuto" in n), `${n.id}: the old names drop out of the output`);
    assert.ok("doneText" in n, "the yardstick stays");
  }
  assert.deepEqual(wf.DONE_MODES, ["inherit", "on", "off"]);
  assert.deepEqual(wf.CAP_MODES, ["inherit", "ask", "continue"]);
  assert.deepEqual(wf.nodeModes({ capAuto: true, doneCheck: true }), { doneMode: "on", doneCapMode: "continue", loopCapMode: "continue" });
});

// ── Rules 1–3 at the library ────────────────────────────────────────────────────────────────

test("Rules 1–3: checks effectively, check cap proceed, round cap proceed — the node overrules the workflow", () => {
  const node = (type, extra = {}) => ({ id: "k", type, ...extra });
  // Regel 1
  assert.equal(wf.wantsDoneCheck(node("instruction"), {}), true, "default: check all");
  assert.equal(wf.wantsDoneCheck(node("parallel"), {}), true);
  assert.equal(wf.wantsDoneCheck(node("instruction"), { doneAll: false }), false);
  assert.equal(wf.wantsDoneCheck(node("instruction", { doneMode: "on" }), { doneAll: false }), true, "on beats workflow off");
  assert.equal(wf.wantsDoneCheck(node("instruction", { doneMode: "off" }), { doneAll: true }), false, "off beats workflow on");
  for (const t of ["review", "ask", "condition", "loop", "start", "trigger", "end"]) {
    assert.equal(wf.wantsDoneCheck(node(t, { doneMode: "on" }), {}), false, `${t} has no “done”`);
  }
  // Rule 2 — only the node itself
  assert.equal(wf.doneCapAuto(node("instruction"), {}), false);
  assert.equal(wf.doneCapAuto(node("instruction"), { doneCapAuto: true }), true);
  assert.equal(wf.doneCapAuto(node("instruction", { doneCapMode: "ask" }), { doneCapAuto: true }), false);
  assert.equal(wf.doneCapAuto(node("instruction", { doneCapMode: "continue" }), { doneCapAuto: false }), true);
  // Rule 3 — in a cycle
  const g = (a = {}, b = {}) => wf.normalizeGraph({
    nodes: [{ id: "a", type: "instruction", ...a }, { id: "b", type: "condition", ...b }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "a", branch: "false" }],
  });
  const auto = (graph, id, run) => wf.effectiveCap(graph, wf.nodeById(graph, id), 5, run).auto;
  assert.equal(auto(g(), "a", {}), false, "default: question");
  assert.equal(auto(g(), "a", { loopCapAuto: true }), true, "workflow “proceed” applies without a choice in the cycle");
  assert.equal(auto(g({}, { loopCapMode: "ask" }), "a", { loopCapAuto: true }), false, "“question” in the cycle breaks the workflow “proceed”");
  assert.equal(auto(g({}, { loopCapMode: "continue" }), "a", {}), true, "“proceed” in the cycle counts cycle-wide");
  assert.equal(auto(g({}, { loopCapMode: "continue", maxVisits: 3 }), "a", {}), true, "the giver passes on its choice");
  assert.equal(auto(g({ loopCapMode: "ask" }, { loopCapMode: "continue" }), "a", {}), false, "the node ITSELF overrules the cycle");
  assert.equal(auto(g({ loopCapMode: "continue" }, { loopCapMode: "ask" }), "a", {}), true);
  assert.equal(auto(g({}, { loopCapMode: "ask" }), "a", {}), false);
  assert.equal(auto(g({}, { capAuto: true }), "a", {}), true, "legacy state: the tick counts cycle-wide");
  // The number computes as before — the workflow does not change it.
  assert.equal(wf.effectiveCap(g({}, { maxVisits: 7 }), wf.nodeById(g({}, { maxVisits: 7 }), "a"), 5, { loopCapAuto: true }).cap, 7);
});

test("Editor hint: with “proceed” at the round cap the run does NOT ask", () => {
  const graph = { nodes: cycle().nodes.map((n) => (n.id === "n1" ? { ...n, maxVisits: 0 } : n)), edges: cycle().edges };
  const question = wf.checkGraph(graph).find((p) => /beginnt eine Runde/.test(p.text));
  assert.match(question.text, /fragt der Lauf nach 5 Runden nach/);
  const further = wf.checkGraph(graph, { run: { loopCapAuto: true } }).find((p) => /beginnt eine Runde/.test(p.text));
  assert.match(further.text, /verlässt der Lauf die Runde nach 5 Runden ohne Rückfrage/);
});

// ── Rule 5: compaction in the workflow (pure) ─────────────────────────────────────────────────────

test("Rule 5: workflow value, otherwise chat, otherwise global — “off” in the workflow overrules both", () => {
  assert.equal(ac.workflowShare(null, null, 60), 60, "default, default ⇒ global");
  assert.equal(ac.workflowShare(null, 70, 60), 70, "default ⇒ chat");
  assert.equal(ac.workflowShare(40, 70, 60), 40, "workflow wins");
  assert.equal(ac.workflowShare(0, 70, 60), 0, "workflow “off” overrules chat and global");
  assert.equal(ac.workflowShare(45, 70, 60), 70, "an invalid workflow value does not count");
  assert.equal(ac.workflowCap(null, null, 100_000), 100_000);
  assert.equal(ac.workflowCap(null, 50_000, 100_000), 50_000);
  assert.equal(ac.workflowCap(150_000, 50_000, 100_000), 150_000);
  assert.equal(ac.workflowCap(0, 50_000, 100_000), 0);
});

// ── Saving: partial patch, null, 400, limits ────────────────────────────────────────────────────

test("Saving: partial patch with explicit null, 400 for changed nonsense, limits from the workflow", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Saving", chain(), undefined);
    assert.equal(flow.run.doneAll, true, "a new workflow checks");
    assert.equal(flow.limits.doneRounds, 3);
    assert.equal(flow.limits.doneRoundsMax, 10);
    const url = `${base}/api/workspaces/${ws.id}/workflows/${flow.id}`;
    const put = (run) => json(url, { method: "PUT", body: JSON.stringify({ run }) });

    let r = await put({ autocompact: 60, autocompactMax: 100_000, doneRounds: 5, doneAll: false });
    assert.equal(r.run.autocompact, 60);
    assert.equal(r.run.autocompactMax, 100_000);
    assert.equal(r.limits.doneRounds, 5, "limits.doneRounds is the STORED number of this workflow");
    r = await put({ loopCapAuto: true });
    assert.equal(r.run.autocompact, 60, "a missing key means unchanged");
    assert.equal(r.run.doneRounds, 5);
    assert.equal(r.run.loopCapAuto, true);
    r = await put({ autocompact: null });
    assert.equal(r.run.autocompact, null, "an explicit null means back to default");
    assert.equal(r.run.autocompactMax, 100_000);
    r = await put({ autocompact: 0 });
    assert.equal(r.run.autocompact, 0, "0 is off, not default");

    for (const [field, value] of [["autocompact", 63], ["autocompact", "60"], ["autocompactMax", 12_345], ["autocompactMax", "x"],
      ["doneRounds", 0], ["doneRounds", 11], ["doneRounds", 2.5], ["doneRounds", "4"],
      ["doneAll", "yes"], ["doneCapAuto", 1], ["loopCapAuto", "true"]]) {
      assert.equal(await status(url, { method: "PUT", body: JSON.stringify({ run: { [field]: value } }) }), 400, `${field} = ${JSON.stringify(value)} must be rejected`);
    }
    // Sent back unchanged (the editor sends `run` on every save) is never a 400.
    const loaded = await json(url);
    assert.equal(await status(url, { method: "PUT", body: JSON.stringify({ name: "Renamed", run: loaded.run }) }), 200);
    assert.equal((await json(url)).run.autocompact, 0, "the rejected requests wrote nothing");
  });
});

// ── Rule 1 in a run ─────────────────────────────────────────────────────────────────────────────

test("Default: a workflow with run_settings = {} checks every work step", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Default", chain(), undefined);
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(done.run.status, "done", `${done.run.status}: ${done.run.note}`);
    assert.deepEqual(gates(done).map((g) => g.nodeId), ["n1", "n2"], "both work steps got a verdict");
  });
});

test("Node “off” beats workflow “on”, node “on” beats workflow “off”", async () => {
  await withServer(async ({ base, ws }) => {
    const out = await makeFlow(base, ws, "Node-off", chain({ doneMode: "off" }), {});
    const c1 = await newChat(base, ws);
    const r1 = await start(base, c1.id, out.id);
    const d1 = await untilStatus(base, r1.run.id, "done", "failed", "waiting");
    assert.equal(d1.run.status, "done");
    assert.deepEqual(gates(d1).map((g) => g.nodeId), ["n2"], "n1 opted out, n2 follows the workflow");

    const turnedOn = await makeFlow(base, ws, "Node-on", chain({ doneMode: "on" }), { doneAll: false });
    const c2 = await newChat(base, ws);
    const r2 = await start(base, c2.id, turnedOn.id);
    const d2 = await untilStatus(base, r2.run.id, "done", "failed", "waiting");
    assert.equal(d2.run.status, "done");
    assert.deepEqual(gates(d2).map((g) => g.nodeId), ["n1"], "only the node with “on” checks");
  });
});

// ── Rules 2 and 4 in a run ──────────────────────────────────────────────────────────────────────

test("Check rounds 2: “round 1/2” in the job, cap after two rounds, then question", async () => {
  await withServer(async ({ base, ws, log }) => {
    const flow = await makeFlow(base, ws, "Two-Rounds", chain({ doneMode: "on" }), { doneAll: false, doneRounds: 2 });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    const w = await untilStatus(base, r.run.id, "waiting", "done", "failed");
    assert.equal(w.run.status, "waiting", "at the check cap the run asks (default question)");
    assert.equal(w.run.nodeId, "n1");
    assert.deepEqual(gates(w).map((g) => [g.detail.round, g.detail.max]), [[1, 2], [2, 2]]);
    const turns = log().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.length, 2, "work + ONE rework");
    assert.match(turns[1], /Completion gate · round 1\/2/);
    assert.match(w.run.question, /nach 2 Runden/);
  }, { gate: "never" });
});

test("At the check cap: workflow “proceed” advances by itself — a node “question” breaks it", async () => {
  await withServer(async ({ base, ws, log }) => {
    const further = await makeFlow(base, ws, "Cap-proceed", chain({ doneMode: "on" }), { doneAll: false, doneCapAuto: true });
    const c1 = await newChat(base, ws);
    const r1 = await start(base, c1.id, further.id);
    const d1 = await untilStatus(base, r1.run.id, "done", "failed", "waiting");
    assert.equal(d1.run.status, "done", `expected without a question, was ${d1.run.status}: ${d1.run.note}`);
    assert.deepEqual(gates(d1).map((g) => g.detail.round), [1, 2, 3]);
    assert.equal(gates(d1).at(-1).detail.auto, true);
    assert.match(log().filter((l) => l.startsWith("TURN")).at(-1), /STEP-TWO/);

    const ask = await makeFlow(base, ws, "Cap-asks", chain({ doneMode: "on", doneCapMode: "ask" }), { doneAll: false, doneCapAuto: true });
    const c2 = await newChat(base, ws);
    const r2 = await start(base, c2.id, ask.id);
    const d2 = await untilStatus(base, r2.run.id, "waiting", "done", "failed");
    assert.equal(d2.run.status, "waiting", "the node says “question” — the workflow “proceed” does not apply here");
    assert.equal((await json(`${base}/api/chats/${c2.id}/workflow`)).run.pending, "done");
    await json(`${base}/api/chats/${c2.id}/workflow/cancel`, { method: "POST" });
  }, { gate: "never" });
});

// ── Rule 3 in a run ─────────────────────────────────────────────────────────────────────────────

test("At the round cap: workflow “proceed” leaves the cycle by itself — a node “question” in the cycle breaks it", async () => {
  await withServer(async ({ base, ws }) => {
    const further = await makeFlow(base, ws, "Cycle-proceed", cycle(), { doneAll: false, loopCapAuto: true });
    const c1 = await newChat(base, ws);
    const r1 = await start(base, c1.id, further.id);
    const d1 = await untilStatus(base, r1.run.id, "done", "failed", "waiting");
    assert.equal(d1.run.status, "done", `the run must leave the cycle by itself, was ${d1.run.status}: ${d1.run.note}`);
    const cap = d1.steps.find((s) => s.kind === "cap");
    assert.ok(cap, "the cap stands in the log");
    assert.equal(cap.detail.auto, true);

    // The cap stands at the condition, the instruction INHERITS it with the choice (the giver rule): its
    // cap breaks first, and there the giver's "question" must break the workflow "proceed".
    const ask = await makeFlow(base, ws, "Cycle-asks", cycle({ maxVisits: 0 }, { maxVisits: 2, loopCapMode: "ask" }), { doneAll: false, loopCapAuto: true });
    const c2 = await newChat(base, ws);
    const r2 = await start(base, c2.id, ask.id);
    const d2 = await untilStatus(base, r2.run.id, "waiting", "done", "failed");
    assert.equal(d2.run.status, "waiting");
    assert.equal((await json(`${base}/api/chats/${c2.id}/workflow`)).run.pending, "cap", "“question” at the condition applies to the whole cycle");
    await json(`${base}/api/chats/${c2.id}/workflow/cancel`, { method: "POST" });
  });
});

// ── Compaction between two steps ──────────────────────────────────────────────────

// Index of the first log line that matches (or -1).
const place = (rows, re, mark = 0) => { for (let i = mark; i < rows.length; i++) if (re.test(rows[i])) return i; return -1; };
const compactMarkers = (history) => history.filter((r) => r.role === "meta")
  .map((r) => { try { return JSON.parse(r.text); } catch { return {}; } }).filter((m) => m.compacted);

test("Compaction between two steps: due ⇒ marker {compacted, auto} BEFORE the second step; chat stays unchanged; compaction in the run view", async () => {
  await withServer(async ({ base, ws, log }) => {
    const flow = await makeFlow(base, ws, "Compacting", chain(), { doneAll: false, autocompactMax: 50_000 });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    assert.deepEqual(r.run.compaction, { percent: null, max: 50_000 }, "the workflow's OWN values in the run view");
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);

    const z = log();
    const one = place(z, /^TURN .*STEP-ONE/);
    const two = place(z, /^TURN .*STEP-TWO/);
    const compressed = place(z, /^COMPRESSED/);
    assert.ok(one >= 0 && two > one, "both steps ran");
    assert.ok(compressed > one && compressed < two, `compaction happens BETWEEN the steps (one ${one}, compressed ${compressed}, two ${two})`);
    assert.equal(place(z, /^COMPRESSED/, compressed + 1) < 0 || place(z, /^COMPRESSED/, compressed + 1) > two, true, "exactly once before the second step");

    const history = await json(`${base}/api/chats/${chat.id}/log`);
    const marker = compactMarkers(history)[0];
    assert.ok(marker, "the compaction stands as a marker in the history");
    assert.equal(marker.auto, true, "as an automatic compaction");
    // The step prompts do not stand in the history (role "workflow"), their ANSWERS do: the
    // marker stands between the answer of the first and that of the second step.
    const iMarker = history.findIndex((x) => x.role === "meta" && /"compacted":true/.test(x.text));
    const responses = history.map((x, i) => (x.role === "assistant" ? i : -1)).filter((i) => i >= 0);
    assert.equal(responses.length, 2, "two steps, two answers");
    assert.ok(responses[0] < iMarker && iMarker < responses[1], `the marker stands BEFORE the second step (${responses[0]} < ${iMarker} < ${responses[1]})`);
    const cmd = d.steps.find((s) => s.kind === "command" && s.detail?.auto === true);
    assert.ok(cmd, "the compaction stands in the run log");
    assert.equal(cmd.nodeId, "n2");
    assert.equal(cmd.detail.ok, true);

    const after = await json(`${base}/api/chats/${chat.id}`);
    assert.equal(after.autocompact, null, "the workflow value is NEVER written onto the chat");
    assert.equal(after.autocompactMax, null);
  }, { ctx: 60_000 });
});

test("Compaction: workflow “off” beats chat and global; “default” takes the chat, otherwise global", async () => {
  await withServer(async ({ base, ws, log }) => {
    // Chat and global would be due — the workflow says "off".
    await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ maxTokens: 50_000 }) });
    const out = await makeFlow(base, ws, "Off", chain(), { doneAll: false, autocompact: 0, autocompactMax: 0 });
    const c1 = await newChat(base, ws, { autocompactMax: 50_000 });
    const r1 = await start(base, c1.id, out.id);
    await untilStatus(base, r1.run.id, "done", "failed", "waiting");
    let z = log();
    let one = place(z, /^TURN .*STEP-ONE/), two = place(z, /^TURN .*STEP-TWO/);
    assert.ok(two > one && one >= 0);
    assert.equal(z.slice(one, two).some((l) => l.startsWith("COMPRESSED")), false, "“off” in the workflow: no compaction between the steps");
    // After the run the chat's choice applies again — whether the follow-up compaction then takes effect is
    // not the subject of this test; we count up to here.
    const soFar = z.length;

    // Default ⇒ chat: global off, the chat carries the cap.
    await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ maxTokens: 0 }) });
    const std = await makeFlow(base, ws, "Default-Chat", chain(), { doneAll: false });
    const c2 = await newChat(base, ws, { autocompactMax: 50_000 });
    const r2 = await start(base, c2.id, std.id);
    await untilStatus(base, r2.run.id, "done", "failed", "waiting");
    z = log();
    one = place(z, /^TURN .*STEP-ONE/, soFar); two = place(z, /^TURN .*STEP-TWO/, soFar);
    assert.ok(two > one && one >= 0);
    assert.equal(z.slice(one, two).filter((l) => l.startsWith("COMPRESSED")).length, 1, "default ⇒ the chat's cap applies");
    const soFar2 = z.length;

    // Default ⇒ global: chat without its own choice, global the cap.
    await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ maxTokens: 50_000 }) });
    const c3 = await newChat(base, ws);
    const r3 = await start(base, c3.id, std.id);
    await untilStatus(base, r3.run.id, "done", "failed", "waiting");
    z = log();
    one = place(z, /^TURN .*STEP-ONE/, soFar2); two = place(z, /^TURN .*STEP-TWO/, soFar2);
    assert.ok(two > one && one >= 0);
    assert.equal(z.slice(one, two).filter((l) => l.startsWith("COMPRESSED")).length, 1, "default without chat choice ⇒ global");
  }, { ctx: 60_000 });
});

test("Compaction: not between check rounds of the same step — only before the next", async () => {
  await withServer(async ({ base, ws, log }) => {
    const flow = await makeFlow(base, ws, "Check-rounds", chain({ doneMode: "on" }), { doneAll: false, autocompactMax: 50_000 });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const z = log();
    const one = place(z, /^TURN .*STEP-ONE/);
    const round = place(z, /^TURN .*Completion gate · round 1\/3/);
    const two = place(z, /^TURN .*STEP-TWO/);
    assert.ok(one >= 0 && round > one && two > round, `Order: work, rework, second step (${one}, ${round}, ${two})`);
    assert.equal(z.slice(one, round).some((l) => l.startsWith("COMPRESSED")), false, "NO compaction between work and check round");
    assert.equal(z.slice(round, two).filter((l) => l.startsWith("COMPRESSED")).length, 1, "before the next step it does");
  }, { ctx: 60_000, gate: "second" });
});

test("Compaction: not when the next step itself begins with /compact or /clear", async () => {
  await withServer(async ({ base, ws, log }) => {
    const withCompact = await makeFlow(base, ws, "Own-Compact", chain({}, { command: "/compact" }), { doneAll: false, autocompactMax: 50_000 });
    const c1 = await newChat(base, ws);
    const r1 = await start(base, c1.id, withCompact.id);
    const d1 = await untilStatus(base, r1.run.id, "done", "failed", "waiting");
    assert.equal(d1.run.status, "done", `${d1.run.status}: ${d1.run.note}`);
    let z = log();
    let one = place(z, /^TURN .*STEP-ONE/), two = place(z, /^TURN .*STEP-TWO/);
    assert.equal(z.slice(one, two).filter((l) => l.startsWith("COMPRESSED")).length, 1, "only the node's own /compact — not twice in a row");
    const markers = compactMarkers(await json(`${base}/api/chats/${c1.id}/log`));
    assert.equal(markers.length, 1);
    assert.ok(!markers[0].auto, "the start command compacted, not the rule");
    const soFar = z.length;

    const withClear = await makeFlow(base, ws, "Own-Clear", chain({}, { command: "/clear" }), { doneAll: false, autocompactMax: 50_000 });
    const c2 = await newChat(base, ws);
    const r2 = await start(base, c2.id, withClear.id);
    await untilStatus(base, r2.run.id, "done", "failed", "waiting");
    z = log();
    one = place(z, /^TURN .*STEP-ONE/, soFar); two = place(z, /^TURN .*STEP-TWO/, soFar);
    assert.ok(two > one && one >= 0);
    assert.equal(z.slice(one, two).some((l) => l.startsWith("COMPRESSED")), false, "no compaction before a /clear");
  }, { ctx: 60_000 });
});

test("Compaction: once per visit — re-entry after a command turn does not compact again", async () => {
  await withServer(async ({ base, ws, log }) => {
    // The start command is a free message: a turn of its own (which reports the context high again),
    // after that the driver enters the SAME visit of n2 a second time.
    const flow = await makeFlow(base, ws, "Command", chain({}, { command: "UPFRONT-COMMAND" }), { doneAll: false, autocompactMax: 50_000 });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const z = log();
    const one = place(z, /^TURN .*STEP-ONE/);
    const command = place(z, /^TURN .*UPFRONT-COMMAND/);
    const two = place(z, /^TURN .*STEP-TWO/);
    assert.ok(one >= 0 && command > one && two > command, `Order (${one}, ${command}, ${two})`);
    assert.equal(z.slice(one, command).filter((l) => l.startsWith("COMPRESSED")).length, 1, "compacted before the start command");
    assert.equal(z.slice(command, two).some((l) => l.startsWith("COMPRESSED")), false, "not once more after the command turn");
  }, { ctx: 60_000 });
});

// ── Compaction edge cases ────────

test("Compaction: not before the FIRST step — the conversation in which the workflow starts stays verbatim", async () => {
  await withServer(async ({ base, ws, log }) => {
    // A preliminary conversation with 60k context; no compaction globally and in the chat, so none after either.
    const chat = await newChat(base, ws);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "PRELIMINARY_TALK" }) });
    await waitFor(() => store.getChat(chat.id)?.contextTokens >= 50_000, "the preliminary conversation reports its context");
    // It is through when the server rests — `busy` would not see the title oneshot and the follow-up work.
    await waitForQuiet(base);
    const flow = await makeFlow(base, ws, "First-Step", chain(), { doneAll: false, autocompactMax: 50_000 });
    const r = await start(base, chat.id, flow.id);
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const z = log();
    const before = place(z, /^TURN .*PRELIMINARY_TALK/);
    const one = place(z, /^TURN .*STEP-ONE/);
    const two = place(z, /^TURN .*STEP-TWO/);
    assert.ok(before >= 0 && one > before && two > one, `Order (${before}, ${one}, ${two})`);
    assert.equal(z.slice(before, one).some((l) => l.startsWith("COMPRESSED")), false, "NO compaction before the first step");
    assert.equal(z.slice(one, two).filter((l) => l.startsWith("COMPRESSED")).length, 1, "between the first and the second it does");
  }, { ctx: 60_000 });
});

// The compaction between two steps belongs to the driver's open decision (state.js workflowDecides) — a turn from there
// would run into the middle of it, and at a switch without a marker the gate would take it as the switch's result (see the
// test "verdict window and /compact at a switch"). Since the compaction's finally goes through drainQueue, the message
// waits for the end of the decision and goes with the turn of step two — as in the verdict window.
test("Compaction: a message during the compaction is queued — it goes with the turn of the next step", async () => {
  await withServer(async ({ base, ws, log, openTheGate }) => {
    const flow = await makeFlow(base, ws, "Interjection", chain(), { doneAll: false, autocompactMax: 50_000 });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => log().some((l) => l.startsWith("COMPRESS-START")), "the compaction before step two is running");
    const m = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "INTERJECTION" }) });
    assert.equal(m.compacting, true, `the message arrived DURING the compaction (otherwise this test checks nothing): ${JSON.stringify(m)}`);
    openTheGate();
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const z = log();
    const compressed = place(z, /^COMPRESSED/);
    const call = place(z, /^TURN .*INTERJECTION/);
    const two = place(z, /^TURN .*STEP-TWO/);
    assert.ok(two > compressed, `the job of step two went out after the compaction (${compressed}, ${two})`);
    assert.ok(call > two, `and the interjection with its turn, not in the middle of the decision before (${two}, ${call})`);
    assert.ok(d.steps.some((s) => s.kind === "step" && s.nodeId === "n2"), "step two stands in the log");
  }, { ctx: 60_000, compressGate: true });
});

// `running` is not the only re-entry lock. During the completion verdict NO turn runs, but the run stands at "running". A
// message there must not start a turn of its own at once: the driver would advance to step two, see the chat busy and
// return, and the gate afterwards would take the answer to the message as the result of step two — the run would end
// "done" although its job never went out. The chat is therefore occupied in this window (runs/state.js workflowDecides): the
// message is queued and goes with the turn of the next step. The interim question holds at the gate until the driver has
// decided — in the broken state it would still be running exactly then, and the driver would come back to `running`.
test("Verdict without a turn: a message in the window of the completion verdict is queued — step two runs anyway", async () => {
  await withServer(async ({ base, ws, log, verdictOpen, turnOpen }) => {
    const flow = await makeFlow(base, ws, "Verdict-window", chain({ doneMode: "on" }), { doneAll: false });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => log().some((l) => l.startsWith("VERDICT ")), "the completion verdict about step one is running");
    const m = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "INTERIM-ASK HOLD-UNTIL-GATE" }) });
    assert.equal(m.queued, true, `in the verdict window the chat is occupied — queued, not started as a turn of its own: ${JSON.stringify(m)}`);
    verdictOpen();
    await waitFor(() => store.getWorkflowRun(chat.id)?.cursor?.at === "n2", "the driver has decided on step two");
    turnOpen();
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const z = log();
    const two = place(z, /^TURN .*STEP-TWO/);
    assert.ok(two >= 0, `the job of step two went out — in the broken state the interim question replaced it: ${JSON.stringify(z)}`);
    assert.ok(place(z, /^TURN .*INTERIM-ASK/) > two, "the interim question ran with the turn of step two, not before");
    assert.ok(d.steps.some((s) => s.kind === "step" && s.nodeId === "n2"), "step two stands in the log");
  }, { verdictGate: true });
});

// The end of the decision: if the gate judges the LAST step, there is no next turn that would take the queued message at
// its `result` — the run ends "done", and the message must then run by itself (auto-continue.js drainQueue at the end of
// the last decision). Without the drain it would lie there until the next one comes. Without a clock: either it runs, or
// everything stands still and it lies in the queue.
test("Verdict about the last step: the queued message runs after the end of the run", async () => {
  await withServer(async ({ base, ws, log, verdictOpen }) => {
    const flow = await makeFlow(base, ws, "Last-Verdict", chain({}, { doneMode: "on" }), { doneAll: false });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => log().some((l) => l.startsWith("VERDICT ")), "the completion verdict about step two is running");
    const m = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "LATER-CALL" }) });
    assert.equal(m.queued, true, `in the verdict window the chat is occupied — queued: ${JSON.stringify(m)}`);
    verdictOpen();
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const outcome = await waitFor(async () => {
      if (log().some((l) => /^TURN .*LATER-CALL/.test(l))) return "run";
      const { open } = await json(`${base}/api/runs/active`);
      return open.runs === 0 && open.oneshots === 0 && open.queue === 1 ? "left over" : null;
    }, "the queued message runs — or is left over");
    assert.equal(outcome, "run", "the message stayed in the queue after the end of the run");
    const z = log();
    assert.ok(place(z, /^TURN .*LATER-CALL/) > place(z, /^TURN .*STEP-TWO/), "the message ran after step two");
  }, { verdictGate: true });
});

// The same lock at WORK END. A message that arrives after the `result` of step one (stdin is already closed, the process is
// still ending) is queued and lies in the queue at work end. If workEnd took it as a follow-up run — in the same tick in
// which the gate (afterRun, synchronous) had already sent the driver on to step two — two doRun would run side by side in
// the same chat, two CLI processes. Now it waits until the decision falls and goes with the turn of step two — in the SAME
// process.
test("Work end in a workflow: a queued message starts no run next to the next step", async () => {
  await withServer(async ({ base, ws, log, endOpen }) => {
    const flow = await makeFlow(base, ws, "Work-end", chain({ text: "STEP-ONE HOLD-END" }), { doneAll: false });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => log().includes("END-WAITING"), "step one has answered, its process stands at the end gate");
    const m = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "STRAGGLER" }) });
    assert.equal(m.queued, true, `the turn was still running — queued: ${JSON.stringify(m)}`);
    endOpen();
    // First the two turns, then the verdict — in the broken state two runs shared the chat's run maps, and the run
    // did not reliably arrive at "done"; the claim should be red, not hang.
    const pid = (re) => (log().find((l) => l.startsWith("PID ") && re.test(l)) || "").split(" ")[1] || "";
    await waitFor(() => pid(/STEP-TWO/) && pid(/STRAGGLER/), "step two and the message ran");
    assert.equal(pid(/STRAGGLER/), pid(/STEP-TWO/), "the message ran as its own doRun NEXT TO step two — two CLI processes in the same chat");
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    assert.ok(d.steps.some((s) => s.kind === "step" && s.nodeId === "n2"), "step two stands in the log");
  }, { pidLog: true });
});

// The message from the verdict window is queued — but the driver then runs a native start command `/compact` at a SWITCH
// (a node without a compaction marker: condition, loop head, start, trigger). If the compaction's finally started the queue
// directly, without asking the open decision: the message would run as a turn into the middle of it, the driver would come
// back to `running` without asking the switch, and the gate would take the answer as its result — the run would advance
// without a branch to the FIRST exit ("STEP-YES"), although the switch would have said no. Now the queue drains through
// drainQueue: the message waits, the switch decides, and it goes with the turn of the No branch.
test("Verdict window and /compact at a switch: the switch decides, the message waits for the next step", async () => {
  await withServer(async ({ base, ws, log, verdictOpen }) => {
    const g = {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "One", text: "STEP-ONE", doneMode: "on", x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Switch", text: "Done? (NO-PLEASE)", command: "/compact", x: 400, y: 0 },
        { id: "n2", type: "instruction", title: "Yes", text: "STEP-YES", x: 600, y: 0 },
        { id: "n3", type: "instruction", title: "No", text: "STEP-NO", x: 600, y: 200 },
        { id: "e0", type: "end", title: "End", x: 800, y: 0 },
      ],
      edges: [
        { from: "s0", to: "n1" }, { from: "n1", to: "c1" },
        { from: "c1", to: "n2", branch: "true" }, { from: "c1", to: "n3", branch: "false" },
        { from: "n2", to: "e0" }, { from: "n3", to: "e0" },
      ],
    };
    const flow = await makeFlow(base, ws, "Switch-with-compaction", g, { doneAll: false });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => log().some((l) => l.startsWith("VERDICT ")), "the completion verdict about step one is running");
    const m = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "INTERIM_QUESTION" }) });
    assert.equal(m.queued, true, `in the verdict window the chat is occupied — queued: ${JSON.stringify(m)}`);
    verdictOpen();
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const z = log();
    assert.ok(z.some((l) => l.startsWith("COMPRESSED")), "the start command /compact of the switch ran (otherwise this test checks nothing)");
    const turnout = d.steps.filter((s) => s.kind === "decision" && s.nodeId === "c1");
    assert.equal(turnout.length, 1, `the switch decided exactly once — in the broken state never: ${JSON.stringify(d.steps.map((s) => [s.kind, s.nodeId]))}`);
    assert.equal(turnout[0].detail?.yes, false, "the switch said no");
    const no = place(z, /^TURN .*STEP-NO/);
    assert.ok(no >= 0, `the No branch ran: ${JSON.stringify(z)}`);
    assert.equal(place(z, /^TURN .*STEP-YES/), -1, "the Yes branch ran — advanced to the first exit without a decision");
    assert.ok(place(z, /^TURN .*INTERIM_QUESTION/) > no, "the message ran with the turn of the No branch, not in the middle of the decision");
  }, { verdictGate: true });
});

test("Compaction: “skip” during this time hits the displayed step, and the next one waits for the compaction", async () => {
  await withServer(async ({ base, ws, log, openTheGate }) => {
    const g = chain();
    g.nodes.splice(3, 0, { id: "n3", type: "instruction", title: "Three", text: "STEP-THREE", x: 500, y: 0 });
    g.edges = [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "e0" }];
    const flow = await makeFlow(base, ws, "Skipping", g, { doneAll: false, autocompactMax: 50_000 });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    await waitFor(() => log().some((l) => l.startsWith("COMPRESS-START")), "the compaction before step two is running");
    const view = (await json(`${base}/api/chats/${chat.id}/workflow`)).run;
    assert.equal(view.nodeId, "n2", "the run view shows the step being prepared — not the finished one");
    const s = await json(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" });
    assert.equal(s.ok, true);
    // The driver now stands at n3 and has marked it. Proven by COUNTED occasions
    // (test seam workflows/driver.js compactionWaitRounds): two rounds in which it saw the foreign
    // compaction and kept waiting — or the turn it started instead, then the claim below is
    // red instead of a hang.
    const rounds0 = compactionWaitRounds();
    await waitFor(() => (store.getWorkflowRun(chat.id)?.cursor?.compacted || {}).n3, "the driver stands at step three");
    await waitFor(() => compactionWaitRounds() >= rounds0 + 2 || log().some((l) => /^TURN .*STEP-THREE/.test(l)),
      "the driver waits twice for the compaction (or starts step three next to it)");
    assert.equal(log().some((l) => /^TURN .*STEP-THREE/.test(l)), false, "step three does NOT start next to the running compaction");
    openTheGate();
    const d = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.note}`);
    const z = log();
    assert.equal(z.some((l) => /^TURN .*STEP-TWO/.test(l)), false, "step two is skipped");
    assert.ok(place(z, /^TURN .*STEP-THREE/) > place(z, /^COMPRESSED/), "step three after the compaction");
    assert.ok(d.steps.some((s) => s.kind === "skip" && s.nodeId === "n2"), "n2 is skipped");
    const history = await json(`${base}/api/chats/${chat.id}/log`);
    const iMarker = history.findIndex((x) => x.role === "meta" && /"compacted":true/.test(x.text));
    // After skipping only step three ran — its answer is the last.
    const iThree = history.map((x, i) => (x.role === "assistant" ? i : -1)).filter((i) => i >= 0).pop();
    assert.ok(iMarker >= 0 && iThree > iMarker, `the marker stands BEFORE the answer of step three (${iMarker}, ${iThree})`);
    assert.ok(store.getChat(chat.id)?.claudeSessionId, "step three keeps its session — the compaction did not throw it away afterwards");
  }, { ctx: 60_000, compressGate: true });
});

test("Loop engine and follow-up read the same values: with an open run the workflow, afterwards the chat again", async () => {
  await withServer(async ({ base, ws }) => {
    // A run waiting at a question is OPEN — exactly then the workflow value applies.
    const flow = await makeFlow(base, ws, "Open", {
      nodes: [{ id: "s0", type: "start", title: "Start" }, { id: "a1", type: "ask", title: "Question", text: "Continue?" }, { id: "e0", type: "end", title: "End" }],
      edges: [{ from: "s0", to: "a1" }, { from: "a1", to: "e0" }],
    }, { autocompact: 40, autocompactMax: 100_000 });
    const chat = await newChat(base, ws, { autocompact: 70, autocompactMax: 50_000 });
    const r = await start(base, chat.id, flow.id);
    await untilStatus(base, r.run.id, "waiting");
    const open = store.getChat(chat.id);
    assert.equal(autocompactPercent(open), 40, "the share of the loop engine (compactAt) comes from the workflow");
    assert.equal(autocompactMax(open), 100_000);
    assert.deepEqual((await json(`${base}/api/chats/${chat.id}/workflow`)).run.compaction, { percent: 40, max: 100_000 });
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    await untilStatus(base, r.run.id, "cancelled");
    const toward = store.getChat(chat.id);
    assert.equal(autocompactPercent(toward), 70, "after the run the chat's choice applies again");
    assert.equal(autocompactMax(toward), 50_000);
    assert.equal(toward.autocompact, 70, "unchanged on the chat");
  });
});
