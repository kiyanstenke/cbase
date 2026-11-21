// Outer-loop triggers, through the real server, the real hook registry (runs/hooks.js fireHooks, wired up in server.js) and the
// real core; fake Claude or the fake engine from agent-harness.mjs. Tests wait on rows and events, never on a deadline; the clocks
// (quiet, tick) run through the test seams (outerLoopQuietNow, outerLoopTickNow(now), outerLoopRestartGrace):
//   (1) `end` (real turn) and `turnEnd` fire "after every run end" - only with news above the watermark
//   (2) self-wake guard: the outer loop writes into the observed chat whose turn then ends - no second run.
//       COUNTED, not waited for: the fake writes only in the first run, without the guard there would be exactly one more
//   (3) quiet: armed at run end; on expiry re-armed if a row arrived or the chat is running; otherwise one run
//   (4) quiet survives `ctx.restart()` (the post-start step re-arms the clock from the database)
//   (5) interval and (6) clock time via the tick with a set clock; a missed clock time runs once afterwards
//   (6b) a clock time without news is spent: a message afterwards only starts at the next clock time
//   (7) follow-up run: a trigger during an open run remembers a follow-up, no second row; it only runs if there is news since
//       the first run's state
//
// COUNTER-TESTS (each shown red, then restored):
//   outerloop/trigger.js `if (!selbst) starte(agent, chat, "run_end");` without the condition => (2) red (2 runs instead of 1);
//   outerloop/trigger.js quietExpired without the "not quiet => re-arm" branch => (3) red;
//   outerloop/run.js startOuterLoopRun without `afterRun.add(p)` => (7) red;
//   outerloop/trigger.js `const from = ... Math.max(base, seen)` -> `const from = base` => (6b) red.
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-trigger.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { readMessage } from "../electron/server/runs/message-marker.js";
import { FRAME_IDENTIFIER_LINE } from "../electron/server/outerloop/input.js";
import { outerLoopAfterRunMarker, startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { outerLoopRestartGrace, outerLoopQuietNow, outerLoopQuietStands, outerLoopTickNow } from "../electron/server/outerloop/trigger.js";
import { nextCronAtZone } from "../electron/server/cron.js";
import { timeZoneDefault } from "../electron/server/workspaces/timeZone.js";
import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";

const MODEL = "claude-haiku-4-5-20251001";

// Fake Claude: an outer-loop run (recognised by its frame) counts itself in ol-counter and writes ONLY in the first run, when the file
// ol-send exists, into the observed chat; a chat turn with "GATE" in its text stops at the "chat" gate.
const BODY = `
if (joined.includes(${JSON.stringify(FRAME_IDENTIFIER_LINE)})) {
  const env = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase.env || {};
  const counter = path.join(LOCATION, "ol-counter");
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(n));
  if (n === 1 && fs.existsSync(path.join(LOCATION, "ol-send"))) {
    const r = await mcpCall("cbase_agent_send", { to: "chat:" + env.CBASE_CHAT_ID, message: "Please add the tests." });
    fs.writeFileSync(path.join(LOCATION, "ol-sent.json"), JSON.stringify(r));
  }
  finished(); say({ type: "result", result: "Note " + n, session_id: "ol-" + n });
  return;
}
if (text.includes("GATE")) await gate("chat");
finished(); say({ type: "result", result: "finished", session_id: "main-session" });
`;

const runs = (agentId) => store.outerLoopRunsOfAgent(agentId, { limit: 100 }).items;
const open = (agentId) => runs(agentId).some((l) => l.state === "running" || l.state === "parked");
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });

function activeAgent(ws, chat, fields) {
  const a = store.createOuterLoopAgent({ workspaceId: ws.id, name: "Checker", provider: "claude", model: MODEL, ...fields });
  store.setOuterLoopActive(a.id, chat.id, true, 0);
  return a;
}
// Waits until the agent has `n` runs and none is open; returns them (newest first).
async function waitForRuns(waitForTruthy, agentId, n) {
  await waitForTruthy(() => runs(agentId).length >= n && !open(agentId), `${n} run(s) finished`);
  return runs(agentId);
}

test("(1) end (real turn) and turnEnd fire \"after every run end\" - only with news above the watermark", async () => {
  await withAgentsServer(async ({ base, chat, ws, waitForTruthy, waitForQuiet }) => {
    const a = activeAgent(ws, chat, { id: "a1000000-0000-4000-8000-000000000001", trigger: [{ kind: "run_end" }] });
    await send(base, chat.id, "Please rebuild the checkout.");
    let l = await waitForRuns(waitForTruthy, a.id, 1);
    assert.equal(l[0].trigger, "run_end");
    assert.equal(l[0].state, "finished", JSON.stringify(l[0]));
    await waitForQuiet();
    // No news: neither `end` nor `turnEnd` starts anything (the check runs synchronously before any await - no waiting needed).
    await fireHooks("end", { chat: store.getChat(chat.id) });
    await fireHooks("turnEnd", { chat: store.getChat(chat.id) });
    assert.equal(runs(a.id).length, 1, "no run without news");
    // News + turnEnd (the turn of a chat with open background work) => one run.
    store.addMessage(chat.id, "user", "And the tests?", Date.now());
    await fireHooks("turnEnd", { chat: store.getChat(chat.id) });
    l = await waitForRuns(waitForTruthy, a.id, 2);
    assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["run_end", "finished"], ["run_end", "finished"]]);
    assert.equal(l[0].fromMessageId, l[1].untilMessageId, "the second reads from the first one's watermark");
  }, { claude: fakeClaude({ main: BODY }) });
});

test("(2) self-wake guard: the outer loop writes into the observed chat whose turn ends - no second run", async () => {
  await withAgentsServer(async ({ base, chat, ws, root, waitForTruthy, waitForQuiet }) => {
    fs.writeFileSync(path.join(root, "ol-send"), "1");
    const a = activeAgent(ws, chat, { id: "a2000000-0000-4000-8000-000000000002", trigger: [{ kind: "run_end" }], tools: ["cbase_agent_send"] });
    await send(base, chat.id, "Please rebuild the checkout.");
    await waitForRuns(waitForTruthy, a.id, 1);
    // The card arrived and triggered a turn of the chat; after that everything is quiet.
    await waitForTruthy(() => store.listMessages(chat.id).some((m) => m.role === "user" && readMessage(m.text)?.kind === "outer_loop"), "card in chat");
    await waitForQuiet();
    const sent = JSON.parse(fs.readFileSync(path.join(root, "ol-sent.json"), "utf8"));
    assert.notEqual(sent.result?.isError, true, JSON.stringify(sent));
    const card = store.listMessages(chat.id).map((m) => (m.role === "user" ? readMessage(m.text) : null)).find((n) => n?.kind === "outer_loop");
    assert.equal(card.from, "Checker");
    assert.equal(card.address, `outerloop:${a.id}`);
    const rows = store.listMessages(chat.id);
    const i = rows.findIndex((m) => m.role === "user" && readMessage(m.text)?.kind === "outer_loop");
    assert.ok(rows.slice(i + 1).some((m) => m.role === "assistant"), "the chat answered the card (its turn ended)");
    assert.equal(Number(fs.readFileSync(path.join(root, "ol-counter"), "utf8")), 1, "exactly ONE outer-loop run (without the guard: two)");
    assert.equal(runs(a.id).length, 1);
  }, { claude: fakeClaude({ main: BODY }) });
});

test("(3) quiet: armed at run end; re-armed on a fresh row or a running chat; otherwise one run", async () => {
  await withAgentsServer(async ({ base, chat, ws, waitForTruthy, waitForQuiet, gate }) => {
    const a = activeAgent(ws, chat, { id: "a3000000-0000-4000-8000-000000000003", trigger: [{ kind: "quiet", minutes: 5 }] });
    await send(base, chat.id, "Please rebuild the checkout.");
    await waitForTruthy(() => outerLoopQuietStands(a.id, chat.id), "clock armed");
    await waitForQuiet();
    assert.equal(runs(a.id).length, 0, "quiet has not expired yet");
    // A new row since arming => re-arm, no run.
    store.addMessage(chat.id, "user", "one more thing", Date.now());
    outerLoopQuietNow();
    assert.equal(outerLoopQuietStands(a.id, chat.id), true, "re-armed");
    assert.equal(runs(a.id).length, 0);
    // The chat is running => re-arm, no run.
    await send(base, chat.id, "GATE - wait");
    await gate.reached("chat");
    outerLoopQuietNow();
    assert.equal(outerLoopQuietStands(a.id, chat.id), true);
    assert.equal(runs(a.id).length, 0, "no run while the chat is running");
    gate.open("chat");
    await waitForQuiet();
    // Quiet: the run starts.
    outerLoopQuietNow();
    assert.equal(outerLoopQuietStands(a.id, chat.id), false);
    const l = await waitForRuns(waitForTruthy, a.id, 1);
    assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["quiet", "finished"]]);
  }, { claude: fakeClaude({ main: BODY }) });
});

test("(4) quiet survives the restart: the post-start step re-arms the clock from the database", async () => {
  await withAgentsServer(async ({ base, chat, ws, waitForTruthy, restart }) => {
    const a = activeAgent(ws, chat, { id: "a4000000-0000-4000-8000-000000000004", trigger: [{ kind: "quiet", minutes: 5 }] });
    await send(base, chat.id, "Please rebuild the checkout.");
    await waitForTruthy(() => outerLoopQuietStands(a.id, chat.id), "clock armed");
    await restart();
    assert.equal(outerLoopQuietStands(a.id, chat.id), false, "clocks live in the process - gone with the server");
    outerLoopRestartGrace();
    assert.equal(outerLoopQuietStands(a.id, chat.id), true, "re-armed from the database");
    outerLoopQuietNow();
    const l = await waitForRuns(waitForTruthy, a.id, 1);
    assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["quiet", "finished"]]);
    // Nothing new afterwards: the post-start step arms no clock.
    outerLoopRestartGrace();
    assert.equal(outerLoopQuietStands(a.id, chat.id), false);
  }, { claude: fakeClaude({ main: BODY }) });
});

test("(5) interval via the tick: the first at once, the next only after the minutes - and only with news", async () => {
  await withAgentsServer(async ({ chat, ws, waitForTruthy }) => {
    store.addMessage(chat.id, "user", "Please rebuild the checkout.", 1000);
    const a = activeAgent(ws, chat, { id: "a5000000-0000-4000-8000-000000000005", trigger: [{ kind: "interval", minutes: 60 }] });
    const now = Date.now();
    assert.equal(outerLoopTickNow(now), 1);
    await waitForRuns(waitForTruthy, a.id, 1);
    assert.equal(outerLoopTickNow(now + 61 * 60_000), 0, "no run without news, even after the minutes");
    store.addMessage(chat.id, "user", "And the tests?", Date.now());
    assert.equal(outerLoopTickNow(now + 30 * 60_000), 0, "too early");
    assert.equal(outerLoopTickNow(now + 61 * 60_000), 1, "after the minutes");
    const l = await waitForRuns(waitForTruthy, a.id, 2);
    assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["interval", "finished"], ["interval", "finished"]]);
  }, { claude: fakeClaude({ main: BODY }) });
});

test("(6) clock time via the tick: not before the first clock time, a missed one runs once afterwards", async () => {
  await withAgentsServer(async ({ chat, ws, waitForTruthy }) => {
    store.addMessage(chat.id, "user", "Please rebuild the checkout.", 1000);
    const a = activeAgent(ws, chat, { id: "a6000000-0000-4000-8000-000000000006", trigger: [{ kind: "clockTime", times: ["03:00"] }] });
    const start = Number(store.outerLoopAgent(a.id).updatedAt);
    assert.equal(outerLoopTickNow(start), 0, "no clock time between creation and now");
    // Two days later: two 03:00 missed - ONE run.
    assert.equal(outerLoopTickNow(start + 50 * 3_600_000), 1);
    assert.equal(outerLoopTickNow(start + 50 * 3_600_000), 0, "the run is open - no second one");
    const l = await waitForRuns(waitForTruthy, a.id, 1);
    assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["clockTime", "finished"]]);
  }, { claude: fakeClaude({ main: BODY }) });
});

test("(6b) a clock time without news is spent: a message afterwards does NOT start at once, only at the next clock time", async () => {
  // The tick only sees chats with news: a clock time at which the chat had nothing new left no run row,
  // and the next new message hours later found it between the last clock-time start and now,
  // and ran at once. Computed with the same clock as the tick (cron.js nextCronAtZone, the workspace's time zone).
  await withAgentsServer(async ({ chat, ws, waitForTruthy }) => {
    const a = activeAgent(ws, chat, { id: "a6b00000-0000-4000-8000-00000000006b", trigger: [{ kind: "clockTime", times: ["03:00"] }] });
    const start = Number(store.outerLoopAgent(a.id).updatedAt);
    const tz = timeZoneDefault(ws.id);
    const s1 = nextCronAtZone("0 3 * * *", start, tz);
    const s2 = nextCronAtZone("0 3 * * *", s1, tz);
    assert.ok(s1 > start && s2 > s1, "two clock times after creation");
    assert.equal(outerLoopTickNow(start + 60_000), 0, "the tick runs before the clock time");
    assert.equal(outerLoopTickNow(s1 + 60_000), 0, "nothing new at the clock time - no run");
    store.addMessage(chat.id, "user", "Please rebuild the checkout.", s1 + 90_000);
    assert.equal(outerLoopTickNow(s1 + 120_000), 0, "the spent clock time starts nothing just because there is news now");
    assert.equal(runs(a.id).length, 0, "no row");
    assert.equal(outerLoopTickNow(s2 + 60_000), 1, "the next clock time with news runs");
    const l = await waitForRuns(waitForTruthy, a.id, 1);
    assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["clockTime", "finished"]]);
  }, { claude: fakeClaude({ main: BODY }) });
});

test("(7) follow-up run: a trigger during the run remembers a follow-up, no second row; afterwards only with news", async () => {
  // One gate per held engine request: the next request takes the first one, reports in and waits until the test opens it.
  const gates = [];
  const open = [];
  const hold = () => {
    let on;
    const p = new Promise((r) => { on = r; });
    const t = { p, arrived: false };
    gates.push(t);
    open.push(() => on());
    return { on, t };
  };
  // The held request OR the end of the run - a run that fails before it turns red with a reason, not a silent hang.
  const requested = async (waitForTruthy, h, runId) => {
    const w = await waitForTruthy(() => {
      const l = store.outerLoopRun(runId);
      return h.t.arrived ? { arrived: true } : !l || ["finished", "error", "aborted"].includes(l.state) ? { tooEarly: l } : null;
    }, "engine request of the outer-loop run (or its end)");
    assert.ok(w.arrived, `the run ended before its request: ${JSON.stringify(w.tooEarly)}`);
  };
  const releaseAll = () => { gates.length = 0; for (const f of open) f(); };
  await withAgentsServer(async ({ chat, ws, waitForTruthy, waitForQuiet, engine }) => {
    store.addMessage(chat.id, "user", "Please rebuild the checkout.", 1000);
    const a = activeAgent(ws, chat, { id: "a7000000-0000-4000-8000-000000000007", trigger: [{ kind: "quiet", minutes: 5 }], provider: engine.id, model: engine.model });
    const t1 = hold();
    try {
      const r1 = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
      assert.equal(r1.started, true, JSON.stringify(r1));
      await requested(waitForTruthy, t1, r1.runId);
      assert.equal((await startOuterLoopRun({ agent: a, chat, trigger: "quiet" })).reason, "running");
      assert.equal(outerLoopAfterRunMarker(a.id, chat.id), true);
      assert.equal(runs(a.id).length, 1, "no second row");
      store.addMessage(chat.id, "user", "And the tests?", Date.now());
      t1.on();
      let l = await waitForRuns(waitForTruthy, a.id, 2);
      assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["afterRun", "finished"], ["quiet", "finished"]]);
      assert.equal(l[0].fromMessageId, l[1].untilMessageId, "the follow-up reads from the first one's state");
      assert.equal(outerLoopAfterRunMarker(a.id, chat.id), false);
      // No news since the run's state: the marker falls with the end, no follow-up.
      store.addMessage(chat.id, "user", "One more point.", Date.now());
      const t3 = hold();
      const r3 = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
      assert.equal(r3.started, true, JSON.stringify(r3));
      await requested(waitForTruthy, t3, r3.runId);
      await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
      assert.equal(outerLoopAfterRunMarker(a.id, chat.id), true);
      t3.on();
      l = await waitForRuns(waitForTruthy, a.id, 3);
      await waitForQuiet();
      assert.equal(runs(a.id).length, 3, "no follow-up without news");
      assert.equal(outerLoopAfterRunMarker(a.id, chat.id), false);
    } finally {
      // After a failure: release every held request, otherwise the harness's quiet wait hangs on an open run.
      releaseAll();
    }
  }, { engine: { round: async () => { const t = gates.shift(); if (t) { t.arrived = true; await t.p; } return { text: "Note" }; } } });
});
