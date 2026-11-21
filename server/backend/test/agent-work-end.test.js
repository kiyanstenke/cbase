// Background work that ends or survives WITHOUT a turn — with the agent harness: real server, real MCP server, real routes;
// only the providers are faked.
//
// A parked subagent survives the restart. The stored row carries its resumption time; the follow-up start
// (runs/agents.js reportOrphaned) picks it up again in a core without a turn (do-run.js coreWithoutTurn, agent-runtime.js
// pickUp), it counts as open background work and resumes at the alarm through its session — instead of being reported
// "orphaned".
// If a turn ends with living background work, the "end" hook, the goal gate and compaction do not judge yet (do-run.js
// workEnd). If the work becomes empty WITHOUT a turn (the human stops the last agent, orphans after a restart), the owner
// catches up the stored verdict (catchUpVerdict) — exactly once; if a completion notice wakes a turn instead, the end of
// that turn judges and nothing else.
//
// No clock: the reset is an hour away and is resolved through the seam wakeParkedNow; the fakes stand at gates (files);
// tests wait for events (rows, history, idle). The restart is the in-process one (restart({ withBackground: true })): the
// follow-up start is triggered here through fireHooks("restartGrace"), the start timer is switched off.
//
// Counter-proofs (which sabotage turns which test red):
//   - `setWithoutTurn(…)` removed from server.js => the parked-agent tests red (notice "orphaned", no resumption) and the
//     "human stops" test red ("end" 0);
//   - the park branch in agent-runtime.js pickUp removed => the parked-agent tests red (orphaned);
//   - `workEmpty(chatId)` removed from onFinish => "human stops" red ("end" 0 instead of 1);
//   - `store.dismissVerdict` removed from doRun => "completion notice wakes" red (the verdict stays).
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_EMBED_OFFLINE=1 \
//   CBASE_AGENT_STALL_MS=3600000 node --test server/backend/test/agent-work-end.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { observeHooks, fireHooks } from "../electron/server/runs/hooks.js";
import { parkWakeupCount, wakeParkedNow } from "../electron/server/runs/agents.js";

process.env.CBASE_AGENT_IDLE_MS = String(24 * 3_600_000);

// The main agent starts the agents from `<LOCATION>/job.json` in the background and ends; a turn that is a completion
// notice writes it back ("Delivered: …").
// The subagent: {LIMIT:x} fails at the usage limit (reset in `<LOCATION>/reset-seconds`), {GATE:x} stands at gate x; with
// --resume it reports and says whether it came as a resumption after the limit.
// Oneshots: the goal verdict answers "achieved" (no continuation), everything else with a title.
const FAKE = fakeClaude({
  sub: `
    const lim = (/\\{LIMIT:([a-z0-9]+)\\}/.exec(text) || [])[1] || "";
    const x = (/\\{GATE:([a-z0-9]+)\\}/.exec(text) || [])[1] || "";
    const r = arg("--resume");
    const session = r || ("sub-" + (lim || x || "f"));
    say({ type: "system", subtype: "init", session_id: session });
    const end = (t) => { finished(); say({ type: "result", result: t, session_id: session }); };
    if (r) return end("Report after reset | resumed=" + text.includes("usage limit has been reset") + " session=" + r);
    if (lim) {
      fs.appendFileSync(path.join(LOCATION, "limit-calls"), lim + "\\n");
      let s = 3600;
      try { s = Number(fs.readFileSync(path.join(LOCATION, "reset-seconds"), "utf8")) || 3600; } catch {}
      process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + s * 1000).toISOString() + "\\n");
      setTimeout(() => process.exit(1), 30);
      return;
    }
    if (x) { await gate(x); return end("Report " + x); }
    return end("Report");`,
  main: `
    if (!text.includes("<task-notification>")) {
      const jobs = JSON.parse(fs.readFileSync(path.join(LOCATION, "job.json"), "utf8"));
      let i = 0;
      for (const a of jobs) {
        const id = "toolu_bg_" + (++i);
        const input = { description: a.description, prompt: a.prompt, run_in_background: true };
        say({ type: "assistant", message: { id: "main-" + i, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input }] } });
        let t = "";
        try { t = textOf(await mcpCall("cbase_agent", input)); } catch (e) { t = "FEHLER " + e.message; }
        try { fs.writeFileSync(path.join(LOCATION, "id-" + a.description), JSON.parse(t).agentId); } catch {}
        say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
      }
      say({ type: "assistant", message: { id: "main-x", content: [{ type: "text", text: "Agents started" }] } });
      finished();
      say({ type: "result", result: "Agents started", session_id: "main-session" });
      return;
    }
    say({ type: "assistant", message: { id: "main-t" + turn, content: [{ type: "text", text: "Delivered: " + text.replace(/\\s+/g, " ").slice(0, 6000) }] } });
    finished();
    say({ type: "result", result: "ok", session_id: "main-session" });`,
  oneshot: `
    if (prompt.includes("achieved")) return respond('{"achieved": true, "note": "done"}');
    respond("Title");`,
});

// The limit windows would otherwise come from the developer's REAL account (model: agent-limit-parking.test.js).
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-work-end-account-"));
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

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (root, list) => fs.writeFileSync(path.join(root, "job.json"), JSON.stringify(list));
const delivered = (log) => log.filter((m) => m.role === "assistant" && m.text.startsWith("Delivered:")).map((m) => m.text).join("\n");
const hintSources = (chatId) => store.openHints(chatId).map((h) => h.source);
const turnPast = (base) => async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null);
const targetRows = (log) => log.filter((m) => m.role === "goal");

// Counts "end" per chat (once per firing: the first consumer, index 0).
function endCounter() {
  const n = new Map();
  observeHooks((info, payload) => {
    if (info.kind !== "end" || info.phase !== "start" || info.index !== 0) return;
    const id = payload?.chat?.id || "";
    n.set(id, (n.get(id) || 0) + 1);
  });
  return { count: (id) => n.get(id) || 0, stop: () => observeHooks(null) };
}

// Let a background agent park (reset in an hour) and wait until its "parked" row with a time stands.
async function park(ctx, name) {
  const { base, chat, root, waitForTruthy } = ctx;
  job(root, [{ description: name, prompt: `Work {LIMIT:${name}}.` }]);
  await post(`${base}/api/chats/${chat.id}/message`, { text: "Work with agents" });
  await waitForTruthy(turnPast(base), "turn 1 is over");
  const id = await waitForTruthy(() => read(root, `id-${name}`) || null, `agentId of ${name}`);
  const z = await waitForTruthy(() => { const b = store.readSubagent(chat.id, id); return b?.state === "parked" && b.parkedUntil > 0 ? b : null; }, "parked stored");
  return { id, z };
}

test("parked agent survives the restart — parked with reset, counts as open, no orphaned notice; woken it resumes and its completion notice arrives", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForTruthy, waitForLog } = ctx;
    const { id, z } = await park(ctx, "p");
    assert.ok(z.parkedUntil > Date.now() + 30 * 60_000, `resumption time stored: ${z.parkedUntil}`);
    assert.ok(z.resetsAt > 0, "reset time stored");

    await ctx.restart({ withBackground: true });
    const afterEnd = store.readSubagent(chat.id, id);
    assert.equal(afterEnd.state, "parked", "the end of the server run does not overwrite the stored state");
    assert.equal(parkWakeupCount(), 0, "the alarm of the old server run is gone");

    await fireHooks("restartGrace", {});
    const b = store.readSubagent(chat.id, id);
    assert.equal(b.state, "parked", `still parked after the follow-up start: ${b.state}`);
    assert.equal(b.parkedUntil, z.parkedUntil, "with the same resumption time");
    assert.ok(!hintSources(chat.id).includes("agent-orphaned"), `no orphaned notice: ${JSON.stringify(store.openHints(chat.id))}`);
    const active = await json(`${base}/api/runs/active`);
    assert.equal(active.busy, true, "a parked agent is open work — as before the restart");
    assert.equal(active.runs, 0, "no turn");
    const row = (active.agents || []).find((a) => a.agentId === id);
    assert.ok(row, `in the query for open background work: ${JSON.stringify(active.agents)}`);
    assert.equal(parkWakeupCount(), 1, "the alarm stands again");
    assert.equal(read(root, "limit-calls").trim().split("\n").length, 1, "no new call until the wake-up");

    assert.equal(wakeParkedNow(), 1);
    const log = await waitForLog(chat.id, (l) => delivered(l).includes('Agent "p" completed'));
    assert.match(delivered(log), /resumed=true session=sub-p/, "through the stored session, as a resumption after the limit");
    assert.match(delivered(log), new RegExp(`<task-id>${id}</task-id>`), "completion notice under the same agentId");
    await ctx.waitForIdle();
    assert.equal(store.readSubagent(chat.id, id).state, "finished");
    assert.equal(parkWakeupCount(), 0);
  }, { claude: FAKE }));
});

test("reset already over at the start => immediate resumption; stopped before the wake-up => no wake-up, row ended", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForTruthy, waitForLog } = ctx;
    job(root, [{ description: "v", prompt: "Work {LIMIT:v}." }, { description: "s", prompt: "Work {LIMIT:s}." }]);
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Work with agents" });
    await waitForTruthy(turnPast(base), "turn 1 is over");
    const V = await waitForTruthy(() => read(root, "id-v") || null, "agentId v");
    const S = await waitForTruthy(() => read(root, "id-s") || null, "agentId s");
    await waitForTruthy(() => [V, S].every((a) => store.readSubagent(chat.id, a)?.state === "parked"), "both parked");

    await ctx.restart({ withBackground: true });
    // V: the resumption time is already past at the start (the server stood longer than the reset).
    const { rows, chatId, ...imageV } = store.readSubagent(chat.id, V);
    store.rememberSubagent(chat.id, { ...imageV, parkedUntil: Date.now() - 60_000 });
    await fireHooks("restartGrace", {});
    assert.ok(!hintSources(chat.id).includes("agent-orphaned"), "neither of the two is orphaned");

    // S is stopped by the human before the wake-up: alarm gone, row ended, no second call.
    const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: S, from: "human" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const s = store.readSubagent(chat.id, S);
    assert.equal(s.state, "finished");
    assert.equal(s.status, "stopped");
    assert.equal(s.stoppedOf, "human");

    // V resumes without a seam — tests wait for its completion notice.
    const log = await waitForLog(chat.id, (l) => delivered(l).includes('Agent "v" completed'));
    assert.match(delivered(log), /resumed=true session=sub-v/);
    await ctx.waitForIdle();
    assert.equal(parkWakeupCount(), 0, "no alarm any more");
    assert.equal(wakeParkedNow(), 0);
    assert.ok(!delivered(await json(`${base}/api/chats/${chat.id}/log`)).includes('Agent "s"'), "S never resumes");
    assert.deepEqual(read(root, "limit-calls").trim().split("\n").sort(), ["s", "v"], "one call each before the restart, afterwards only V resumed");
    assert.equal(store.readSubagent(chat.id, V).state, "finished");
  }, { claude: FAKE }));
});

// Set a goal: the goal gate judges at the end of work (oneshot "achieved") and writes a goal row.
const withTarget = (chat) => store.updateChat(chat.id, { goal: "Deliver the finding", updatedAt: Date.now() });

test("the human stops the last background agent without a turn => the deferred verdict (\"end\" and goal gate) runs exactly once", async () => {
  const end = endCounter();
  try {
    await withoutAccount(() => withAgentsServer(async (ctx) => {
      const { base, chat, root, gate, waitForTruthy, waitForLog } = ctx;
      try {
        withTarget(chat);
        job(root, [{ description: "m", prompt: "Work {GATE:m}." }]);
        await post(`${base}/api/chats/${chat.id}/message`, { text: "Work with agents" });
        await waitForTruthy(turnPast(base), "turn 1 is over");
        await gate.reached("m");
        const M = read(root, "id-m");
        assert.equal(end.count(chat.id), 0, "with a living agent the turn end does not judge");
        assert.equal(store.verdictStands(chat.id), true, "the verdict is stored");
        assert.deepEqual(targetRows(await json(`${base}/api/chats/${chat.id}/log`)), []);

        const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: M, from: "human" });
        assert.equal(r.ok, true, JSON.stringify(r));
        // The transition runs in the microtask behind the stop — before the route's answer.
        assert.equal(end.count(chat.id), 1, "\"end\" caught up exactly once");
        assert.equal(store.verdictStands(chat.id), false, "taken");
        const log = await waitForLog(chat.id, (l) => targetRows(l).length >= 1);
        assert.equal(targetRows(log).length, 1, "the goal gate judged exactly once");
        assert.ok(hintSources(chat.id).includes("agent-stop"), "the stop stays a silent notice");
        await ctx.waitForIdle();
        assert.equal(end.count(chat.id), 1, "and never again afterwards");
        assert.equal(targetRows(await json(`${base}/api/chats/${chat.id}/log`)).length, 1);
      } finally {
        gate.open("m");
      }
    }, { claude: FAKE }));
  } finally {
    end.stop();
  }
});

test("after a restart with orphans the deferred verdict runs exactly once", async () => {
  const end = endCounter();
  try {
    await withoutAccount(() => withAgentsServer(async (ctx) => {
      const { base, chat, root, gate, waitForTruthy, waitForLog } = ctx;
      try {
        withTarget(chat);
        job(root, [{ description: "w", prompt: "Work {GATE:w}." }]);
        await post(`${base}/api/chats/${chat.id}/message`, { text: "Work with agents" });
        await waitForTruthy(turnPast(base), "turn 1 is over");
        await gate.reached("w");
        const W = read(root, "id-w");
        await waitForTruthy(() => store.readSubagent(chat.id, W)?.session === "sub-w" || store.readSubagent(chat.id, W)?.sessionId === "sub-w", "session stored");

        await ctx.restart({ withBackground: true });
        assert.equal(end.count(chat.id), 0, "the end of the server run does not judge — the work is interrupted, not done");
        assert.equal(store.verdictStands(chat.id), true);

        await fireHooks("restartGrace", {});
        assert.ok(hintSources(chat.id).includes("agent-orphaned"), "W is orphaned");
        assert.equal(end.count(chat.id), 1, "\"end\" caught up exactly once");
        const log = await waitForLog(chat.id, (l) => targetRows(l).length >= 1);
        assert.equal(targetRows(log).length, 1);
        await fireHooks("restartGrace", {});
        await ctx.waitForIdle();
        assert.equal(end.count(chat.id), 1, "a second follow-up start catches nothing up twice");
        assert.equal(targetRows(await json(`${base}/api/chats/${chat.id}/log`)).length, 1);
      } finally {
        gate.open("w");
      }
    }, { claude: FAKE }));
  } finally {
    end.stop();
  }
});

test("if a completion notice wakes a turn instead, its end judges — and nothing twice", async () => {
  const end = endCounter();
  try {
    await withoutAccount(() => withAgentsServer(async (ctx) => {
      const { base, chat, root, gate, waitForTruthy, waitForLog } = ctx;
      try {
        withTarget(chat);
        job(root, [{ description: "f", prompt: "Work {GATE:f}." }]);
        await post(`${base}/api/chats/${chat.id}/message`, { text: "Work with agents" });
        await waitForTruthy(turnPast(base), "turn 1 is over");
        await gate.reached("f");
        assert.equal(end.count(chat.id), 0);
        assert.equal(store.verdictStands(chat.id), true);

        gate.open("f");
        await waitForLog(chat.id, (l) => delivered(l).includes('Agent "f" completed'));
        const log = await waitForLog(chat.id, (l) => targetRows(l).length >= 1);
        await ctx.waitForIdle();
        assert.equal(end.count(chat.id), 1, "\"end\" exactly once — at the end of the completion-notice turn");
        assert.equal(targetRows(log).length, 1);
        assert.equal(store.verdictStands(chat.id), false, "the new turn discarded the deferred verdict");
        assert.equal(targetRows(await json(`${base}/api/chats/${chat.id}/log`)).length, 1);
      } finally {
        gate.open("f");
      }
    }, { claude: FAKE }));
  } finally {
    end.stop();
  }
});
