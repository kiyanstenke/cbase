// EVERY new process of a subagent asks the credit gate — not only the start, but also the resumption via cbase_agent_send
// (a finished, an orphaned, an agent picked up from the stored state) and handing in later after the end of a turn
// (providers/agent-runtime.js fahre). Before, "a resumption is no start" held: with the gate on and 100 % one could keep
// working through cbase_agent_send. A message to a RUNNING agent is no new process and does not ask the gate. The release
// ("Start anyway") is an argument of the SENDING turn, as with the start.
//
// Main seam as in agent-credit-gate.test.js (real server, real cbase MCP server, fake providers of the agent harness);
// the utilisation comes from the seeded `usage_cache_v1` (reset one hour ahead), without an account. The core checks
// handing in later itself (createAgentRuntime with a fake runChat): there an agent that accepts nothing in the middle of
// a turn can be produced without a provider, and the number of processes is the number of runChat calls.
//
// No clock: the fakes stand at gates, tests wait for events.
//
// Counter-proofs (which sabotage turns which test red):
//   - the gate question removed from send() => "resumption" red (the finished agent resumes, one process more);
//   - the route does not pass the release on (`overruled: false`) => "release" red (the resumption stays at the gate);
//   - the gate question removed from fahre() => "handing in later" red (a second runChat call).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";

const HAIKU = "claude-haiku-4-5-20251001";

// The main agent runs the calls from "OPS:[…]" (model: agent-readjust.test.js); `{w:"gate", x}` waits at gate x (the test
// switches the credit gate there). `saveAs` stores the agentId under a name, `to` inserts it again.
const MAIN = `
  if (text.includes("<task-notification>")) { // a silent notice (human stop) can stand in front
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const ops = JSON.parse(/OPS:(\\[.*\\])/.exec(text)[1]);
  for (const op of ops) {
    if (op.w === "gate") { await gate(op.x); continue; }
    const args = { ...op.args };
    if (op.to) args.agentId = fs.readFileSync(path.join(LOCATION, "id-" + op.to), "utf8");
    const id = "toolu_" + op.tag;
    say({ type: "assistant", message: { id: "main-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: args }] } });
    let t = "";
    try { const m = await mcpCall(op.w, args); t = (m.result && m.result.isError ? "FEHLER " : "") + textOf(m); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    if (op.saveAs) { try { fs.writeFileSync(path.join(LOCATION, "id-" + op.saveAs), JSON.parse(t).agentId); } catch {} }
    fs.writeFileSync(path.join(LOCATION, "result-" + op.tag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// The subagent: every PROCESS appends a line to "sub-processes" (the count of new processes). {GATE:x} stands at gate x on
// the first call; with --resume it reports at once as a resumption.
const SUB = `
    fs.appendFileSync(path.join(LOCATION, "sub-processes"), JSON.stringify(text) + "\\n");
    const x = (/\\{GATE:([a-z0-9]+)\\}/.exec(text) || [])[1] || "";
    const session = arg("--resume") || ("sub-session-" + (x || "f"));
    say({ type: "system", subtype: "init", session_id: session });
    const end = (r) => { finished(); say({ type: "result", result: r, session_id: session }); };
    if (x && !arg("--resume")) { await gate(x); return end("Report " + x); }
    return end("Report" + (arg("--resume") ? " (resumed: " + text + ")" : ""));`;

const claude = fakeClaude({ sub: SUB, main: MAIN });

// Without an account (model: agent-credit-gate.test.js): otherwise the utilisation would come from the developer's REAL account.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-resumption-gate-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleanup of ${root}: ${e.code || e.message}`); }
  }
}

// Session window 100 %, measured now, reset in one hour (field names as in fetchUsageLimits).
function seedFullSession() {
  const at = Date.now();
  const iso = new Date(at + 3_600_000).toISOString();
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: 100, resetsAt: iso },
    sevenDay: { utilization: 4, resetsAt: null },
    limits: [
      { kind: "session", group: "session", percent: 100, resets_at: iso },
      { kind: "weekly", group: "weekly", percent: 4, resets_at: null },
    ],
    at,
  }));
}

const withGateServer = (fn) => withoutAccount(() => withAgentsServer(async (ctx) => { seedFullSession(); await fn(ctx); }, { claude }));

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const gate = (base, on) => json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops) => `Go OPS:${JSON.stringify(ops)}`;
const result = (waitForTruthy, root, tag) => waitForTruthy(() => read(root, `result-${tag}`) || null, `result ${tag}`);
const idOf = (root, name) => read(root, `id-${name}`);
const processes = (root) => read(root, "sub-processes").split("\n").filter(Boolean).length;
const turnPast = (base) => async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null);
const noticesOf = (log, agentId) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(`<task-id>${agentId}</task-id>`));
const START = (tag, prompt, further = {}) => ({ w: "cbase_agent", tag, args: { description: `Agent ${tag}`, prompt, ...further } });
const SEND = (tag, to, message) => ({ w: "cbase_agent_send", tag, to, args: { message } });
const SEND_ID = (tag, agentId, message) => ({ w: "cbase_agent_send", tag, args: { agentId, message } });

const gateError = (t, what) => {
  assert.match(t, /^FEHLER /, `${what}: no tool error: ${t.slice(0, 300)}`);
  assert.match(t, /Guthaben-Gate|Credit gate/, `${what}: ${t.slice(0, 300)}`);
  // The same wording as at the start (runs/agents.js gateForAgent): state, threshold, "no subagent started".
  assert.match(t, /100 %/, `${what}: the reason does not name the state: ${t}`);
  assert.match(t, /99 %/, `${what}: the reason does not name the threshold: ${t}`);
  assert.match(t, /kein Subagent gestartet|no subagent started/, `${what}: not the wording of the start: ${t}`);
};

test("resumption: gate on, usage above the threshold => cbase_agent_send to a finished, an orphaned and a stored agent is rejected (wording of the start, no process); to a running one the message goes without the gate", async () => {
  await withGateServer(async ({ base, chat, root, gate: gateState, waitForTruthy, waitForLog, waitForIdle }) => {
    try {
      // Turn 1 with the gate off: F ends at once (finished, in the core), L stays at the gate (runs).
      await gate(base, false);
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("f1", "Short.", { run_in_background: false, model: `claude::${HAIKU}` }), saveAs: "F" },
        { ...START("l1", "Work {GATE:l}.", { model: `claude::${HAIKU}` }), saveAs: "L" },
      ]) });
      await result(waitForTruthy, root, "f1");
      await result(waitForTruthy, root, "l1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      await gateState.reached("l");
      const [F, L] = ["F", "L"].map((n) => idOf(root, n));
      // Two agents that no open core knows: one from the stored state (finished), one after a restart (orphaned) — both
      // with a session, so resumable (store/subagents.js; runs/agents.js fromStore -> pickUp).
      store.rememberSubagent(chat.id, { agentId: "abest0000-1", name: "best", provider: "claude", model: HAIKU, sessionId: "sess-best", state: "finished", status: "completed" });
      store.rememberSubagent(chat.id, { agentId: "averw0000-2", name: "verw", provider: "claude", model: HAIKU, sessionId: "sess-verw", state: "orphaned", status: "running" });
      const prior = processes(root);

      // Turn 2: passed its own gate (gate off while sending), then gate on — the resumptions ask it themselves.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { w: "gate", x: "t2" },
        SEND("f2", "F", "further"),
        SEND_ID("b2", "abest0000-1", "further"),
        SEND_ID("v2", "averw0000-2", "further"),
        SEND("l2", "L", "Addendum to the running one"),
      ]) });
      await gateState.reached("t2");
      await gate(base, true);
      gateState.open("t2");
      gateError(await result(waitForTruthy, root, "f2"), "finished");
      gateError(await result(waitForTruthy, root, "b2"), "stored");
      gateError(await result(waitForTruthy, root, "v2"), "orphaned");
      const l2 = await result(waitForTruthy, root, "l2");
      assert.doesNotMatch(l2, /^FEHLER/, `the message to the running agent hit the gate: ${l2.slice(0, 300)}`);
      assert.match(l2, /"delivered": true/, l2.slice(0, 300));
      await waitForTruthy(turnPast(base), "turn 2 is over");
      assert.equal(processes(root), prior, "a rejected resumption started a process after all");

      // L runs to the end (its report comes), no further process for the rejected ones.
      gateState.open("l");
      await waitForLog(chat.id, (l) => noticesOf(l, L).length >= 1);
      await waitForIdle();
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      assert.equal(noticesOf(log, F).length, 0, "the rejected finished agent reported");
      assert.equal(noticesOf(log, "abest0000-1").length + noticesOf(log, "averw0000-2").length, 0, "a rejected one reported");
    } finally {
      for (const t of ["t2", "l"]) gateState.open(t);
    }
  });
});

test("release: a turn under \"Start anyway\" resumes a finished agent even with the gate on — the release is an argument of the sending turn", async () => {
  await withGateServer(async ({ base, chat, root, waitForTruthy, waitForLog, waitForIdle }) => {
    await gate(base, false);
    await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("f1", "Short.", { run_in_background: false, model: `claude::${HAIKU}` }), saveAs: "F" }]) });
    await result(waitForTruthy, root, "f1");
    await waitForTruthy(turnPast(base), "turn 1 is over");
    const F = idOf(root, "F");
    const prior = processes(root);

    // Gate on: the turn itself stands at the gate; "Start anyway" releases EXACTLY it — and with it its resumption.
    await gate(base, true);
    await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("f2", "F", "further")]) });
    const row = await waitForTruthy(async () => (await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait, "gate row");
    assert.equal(row.reason, "credit", JSON.stringify(row));
    const now = await post(`${base}/api/chats/${chat.id}/auto-continue/now`, { anyway: true });
    assert.equal(now.ok, true, JSON.stringify(now));
    const f2 = await result(waitForTruthy, root, "f2");
    assert.doesNotMatch(f2, /^FEHLER/, `the release of the turn did not hold for the resumption: ${f2.slice(0, 300)}`);
    assert.match(f2, /"resumed": true/, f2.slice(0, 300));
    const log = await waitForLog(chat.id, (l) => noticesOf(l, F).length === 1);
    assert.match(noticesOf(log, F)[0].text, /<result>Report \(resumed: further\)<\/result>/);
    assert.equal(processes(root), prior + 1, "exactly one new process for the resumption");
    await waitForIdle();
  });
});

// The core: an agent that accepts nothing in the middle of a turn (its child has no `controlCbase` — like Codex) gets a
// message "after the end". Handing in later is a NEW process: if the gate stands, it does not start, the agent ends with
// the report of its turn, and what was handed in goes to the owner with the reason (onFinish `undelivered`).
function supplyLaterCore({ gateText }) {
  const asked = [];
  let calls = 0;
  let firstFree;
  const first = new Promise((r) => { firstFree = r; });
  let finished;
  const end = new Promise((r) => { finished = r; });
  const inputs = [];
  const rt = createAgentRuntime({
    chatId: "c-supply-later",
    cwd: process.cwd(),
    parentProvider: "codex",
    resolveRef: () => ({ connector: {}, providerId: "codex", model: "gpt-5.6-sol" }),
    buildSpec: (b) => { inputs.push(b.input); return {}; },
    runChat: async ({ onSpawn }) => {
      calls += 1;
      onSpawn({ kill() {} }); // no controlCbase: a message in the middle of a turn goes "after the end"
      if (calls === 1) await first;
      return { code: 0, sessionId: "s1", resultText: `Report ${calls}` };
    },
    startGate: (a) => { asked.push(a); return asked.length === 1 ? null : gateText; },
    onFinish: (rec, info) => finished(info),
  });
  return { rt, asked, inputs, calls: () => calls, firstFree: () => firstFree(), end };
}

test("handing in later: the new process after the end asks the gate — blocked => no second process, what was handed in goes to the owner with the reason; open => it runs, with the release of the sending turn", async () => {
  const REASON = "Credit gate: session is at 100 % (threshold 99 %) — no subagent started (codex).";
  const k = supplyLaterCore({ gateText: REASON });
  const a = await k.rt.start({ prompt: "Do something" });
  const r = await k.rt.send({ agentId: a.agentId, message: "supplied-later" }, { overruled: true });
  assert.equal(r.afterEnd, true, JSON.stringify(r));
  assert.equal(k.asked.length, 1, "the message to the running agent asked the gate");
  k.firstFree();
  const info = await k.end;
  assert.equal(k.calls(), 1, "a second process ran despite the gate");
  assert.equal(k.asked.length, 2, "handing in later did not ask the gate");
  assert.equal(k.asked[1].overruled, true, "the release of the sending turn is missing at the gate question");
  assert.equal(k.asked[1].provider, "codex");
  assert.equal(info.report.status, "completed", JSON.stringify(info.report).slice(0, 300));
  assert.match(info.report.report, /Report 1/);
  assert.deepEqual(info.undelivered, [{ kind: "message", overruled: true, text: "supplied-later", reason: REASON }]);
  k.rt.close();

  // Gate open: the same situation runs what was handed in as a resumption — nothing stays undelivered.
  const o = supplyLaterCore({ gateText: null });
  const b = await o.rt.start({ prompt: "Do something" });
  await o.rt.send({ agentId: b.agentId, message: "supplied-later" });
  o.firstFree();
  const info2 = await o.end;
  assert.equal(o.calls(), 2);
  assert.deepEqual(o.inputs, ["Do something", "supplied-later"]);
  assert.match(info2.report.report, /Report 2/);
  assert.deepEqual(info2.undelivered, []);
  o.rt.close();
});
