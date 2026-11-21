// Guard: a subagent that ends IN THE MIDDLE of a turn books its consumption exactly once. Booking used to happen only in onFinish,
// which ran at stop (settle) BEFORE the running turn's counter was folded - the fold came afterwards, when nobody booked anymore.
// Codex reports a turn without `turn.completed` not at all; its consumption stands only in the rollout (connectors/codex.js
// `codexConsumptionSince`).
//
// Measured against the real server (in-process, agent-harness.mjs) with the real cbase MCP server; the fakes stand at gates, the
// tests wait for events (gate reached, process gone, quiet), never for a duration:
//   1. Claude, stopped by the human (`/agent/stop`): the counter is folded in settle => ONE row, cache separated, with agent_id,
//      and no second one after the process is gone.
//   2. Codex, stopped by the human: the turn ends without turn.completed, the connector reads it from the rollout AFTER settle has
//      already booked => atLateConsumption books it (providers/agent-runtime.js) - ONE row.
//   3. The core is closed (server end, agentsAtServerEnd -> close): the same fold => ONE row.
//   4. OpenRouter: the ONLY round of a run breaks off after the response head (user stop, network - here the fake router's cutoff,
//      agent-harness.mjs): the run carries 0 tokens, `costMissing` and the generation id. The id must be booked so the sweep can
//      ask for the computed amount later.
//   5. The same for an OpenRouter subagent.
//   6. A subagent of a DELETED chat (laid still) books anyway - "no report" is not "no booking".
//
// Counter-tests (each shown red once):
//   - the old state (agent-runtime.js: settle without `if (rec.inTurn && rec.billing !== "metered") counterFold(rec);` AND drive
//     without the late booking after settle) => (1), (2), (3) red - 0 rows instead of 1.
//   - settle without the fold only => (1) and (3) red at "booked as soon as ..." (the row would only come with the end of the
//     process via the late booking - without the check right after the stop this sabotage stayed green).
//   - drive without the late booking only => (2) red (0 instead of 1).
//   - providers/connectors/codex.js close without the branch `else if (sessionId && finalCode !== 0)` (rollout) => (2) red.
//   - runs/booking.js bookTurnRows with the old condition `if (u && (u.input || u.output))` => (4) red (0 rows instead of 1).
//   - runs/agents.js bookConsumption without `&& !(Array.isArray(u.generations) && u.generations.length)` => (5) red.
//   - runs/agents.js onFinish with the old `if (still) { live.delete(rec.agentId); return; }` => (6) red (0 instead of 1).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { runKindDefault, registerRunKind } from "../electron/server/runs/hooks.js";
import { catchUpAmounts } from "../electron/server/account/openrouter-inquiry.js";

// This test's Codex home (the connector looks for the rollout there, connectors/codex.js codexSessionRoots) - BEFORE the server.
const CODEX_SAVED = process.env.CODEX_HOME;
const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-abort-codex-"));
process.env.CODEX_HOME = CODEX_HOME;
process.on("exit", () => {
  if (CODEX_SAVED === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = CODEX_SAVED;
  try { fs.rmSync(CODEX_HOME, { recursive: true, force: true }); } catch {}
});

// The main agent runs the calls from "OPS:[...]" (as in agent-orphaned.test.js); `saveAs` stores the agentId under a name.
const MAIN = `
  if (text.includes("<task-notification>")) { finished(); say({ type: "result", result: "notification read", session_id: "main-session" }); return; }
  const ops = JSON.parse(/OPS:(\\[.*\\])/.exec(text)[1]);
  for (const op of ops) {
    const id = "toolu_" + op.tag;
    say({ type: "assistant", message: { id: "main-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: op.args }] } });
    let t = "";
    try { const m = await mcpCall(op.w, op.args); t = (m.result && m.result.isError ? "ERROR " : "") + textOf(m); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    if (op.saveAs) { try { fs.writeFileSync(path.join(LOCATION, "id-" + op.saveAs), JSON.parse(t).agentId); } catch {} }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// The subagent (Claude): reports ONE answer with consumption (input 11 fresh, read 100, write 20, output 5) and then stands at its
// gate - mid-turn, until a stop or the server end hits it. Its pid is in <LOCATION>/pid-<gate>.
const SUB = `
    const x = (/\\{GATE:([a-z0-9]+)\\}/.exec(text) || [])[1] || "f";
    const session = "sub-session-" + x;
    fs.writeFileSync(path.join(LOCATION, "pid-" + x), String(process.pid));
    say({ type: "system", subtype: "init", session_id: session });
    say({ type: "assistant", message: { id: "sub-msg-" + x, usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      content: [{ type: "text", text: "Interim " + x }] } });
    await gate(x);
    finished();
    say({ type: "result", result: "Finding " + x, session_id: session });`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

// Fake Codex: a turn that writes one model call into the rollout (input 300, of which 200 from cache, output 40) and then stands
// at the "codex" gate - without turn.completed. The rollout lies in THIS test's Codex home, as the CLI writes it.
const THREAD = "codex-abort-1";
const CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const thread = ${JSON.stringify(THREAD)};
(async () => {
  say({ type: "thread.started", thread_id: thread });
  say({ type: "turn.started" });
  const dir = path.join(${JSON.stringify(CODEX_HOME)}, "sessions", "2026", "10", "16");
  fs.mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 300, cached_input_tokens: 200, output_tokens: 40 };
  fs.appendFileSync(path.join(dir, "rollout-2026-10-16T00-00-00-" + thread + ".jsonl"),
    JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } } }) + "\\n");
  fs.writeFileSync(path.join(LOCATION, "pid-codex"), String(process.pid));
  fs.writeFileSync(path.join(LOCATION, "gates", "codex.waiting"), "1");
  await new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(path.join(LOCATION, "gates", "codex"))) { clearInterval(t); r(); } }, 20); });
  say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "Codex finding" } });
  say({ type: "turn.completed", usage: usage });
})();
`;

// Only THIS chat does not hold - the agent outlives its turn (as in agent-stop.test.js).
const withoutHold = (chatId) =>
  registerRunKind(`test-abort-without-hold-${chatId}`, (c) => ({ ...runKindDefault(c), hold: false }), { detects: (c) => c.id === chatId });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops) => `Go OPS:${JSON.stringify(ops)}`;
const START = (tag, prompt, further = {}) => ({ w: "cbase_agent", tag, args: { description: `Agent ${tag}`, prompt, run_in_background: true, ...further } });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

const dbModule = await import("../electron/server/store/db.js"); // `db` is a live binding - read only after initStore
const rowsOf = (agentId) => dbModule.db.prepare(`SELECT provider, billing, kind, source, input, output, cached, cache_read AS read,
  cache_write AS write FROM usage_events WHERE agent_id = ? ORDER BY id`).all(agentId).map((z) => ({ ...z }));

// Start a background agent; return once its process stands at the gate and the main agent's turn is over.
async function agentAtGate({ base, chat, root, gate, waitForTruthy }, tag, gateName, further = {}) {
  await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START(tag, `Work {GATE:${gateName}}.`, further), saveAs: tag }]) });
  await gate.reached(gateName);
  const agentId = await waitForTruthy(() => read(root, `id-${tag}`) || null, `agentId ${tag}`);
  await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn over");
  const pid = Number(await waitForTruthy(() => read(root, `pid-${gateName}`) || null, `pid ${gateName}`));
  return { agentId, pid };
}

// After the end: the process is gone (its turn has run to the end, including the late booking afterwards), the server quiet.
async function afterTheEnd({ waitForTruthy, waitForQuiet }, pid) {
  await waitForTruthy(() => (alive(pid) ? null : true), `process ${pid} gone`);
  await waitForQuiet();
}

test("(1) Claude, stopped by the human mid-turn => exactly one row (cache separated, agent_id), no second afterwards", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    withoutHold(chat.id);
    const { agentId, pid } = await agentAtGate(ctx, "a1", "a");
    assert.deepEqual(rowsOf(agentId), [], "nothing is booked before the stop (the turn is running)");

    const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId, from: "human" });
    assert.equal(r.ok, true, JSON.stringify(r));
    // Booked already WITH the answer (settle folds, onFinish books) - not only once the process has reacted to the signal.
    assert.equal(rowsOf(agentId).length, 1, "booked as soon as the stop is answered");
    await afterTheEnd(ctx, pid);

    assert.deepEqual(rowsOf(agentId), [
      { provider: "claude", billing: "subscription", kind: "sub", source: "", input: 11, output: 5, cached: 120, read: 100, write: 20 },
    ], "the stopped turn is booked exactly once");
  }, { claude: fake });
});

test("(2) Codex, stopped by the human mid-turn => the turn from the rollout, exactly one row", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    withoutHold(chat.id);
    const { agentId, pid } = await agentAtGate(ctx, "c1", "codex", { model: "codex::gpt-5.6-sol" });
    assert.deepEqual(rowsOf(agentId), [], "nothing is booked before the stop");

    const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId, from: "human" });
    assert.equal(r.ok, true, JSON.stringify(r));
    await afterTheEnd(ctx, pid);

    // Tally form: input fresh (300 - 200), read 200, Codex writes no cache.
    assert.deepEqual(rowsOf(agentId), [
      { provider: "codex", billing: "subscription", kind: "sub", source: "", input: 100, output: 40, cached: 200, read: 200, write: 0 },
    ], "the stopped Codex turn is booked exactly once");
  }, { claude: fake, codex: CODEX });
});

test("(3) the core is closed (server end) => exactly one row", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, restart } = ctx;
    withoutHold(chat.id);
    const { agentId, pid } = await agentAtGate(ctx, "s1", "s");
    assert.deepEqual(rowsOf(agentId), []);

    // The orderly end closes every core (agentsAtServerEnd -> close -> settle); the agent at the gate ends mid-turn.
    await restart({ withBackground: true });
    assert.equal(rowsOf(agentId).length, 1, "booked on close, not only after the process ends");
    await afterTheEnd(ctx, pid);

    assert.deepEqual(rowsOf(agentId), [
      { provider: "claude", billing: "subscription", kind: "sub", source: "", input: 11, output: 5, cached: 120, read: 100, write: 20 },
    ], "the closed turn is booked exactly once");
  }, { claude: fake });
});

// ── Gaps found on review ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// The fake OpenRouter (agent-harness.mjs cutoff): every streaming answer breaks off after its first chunk - with generation id,
// without usage chunk. The first chunk carries text, so the engine does not repeat the round (engine.js completeWithRetry, sawDelta).
const CUTOFF = { round: () => ({ text: "Part of the answer", cutoff: true }) };
const orRows = (where, ...values) => dbModule.db.prepare(`SELECT provider, billing, kind, input, output, cached, generation_id AS gen,
  cost_usd AS cost, cost_origin AS origin FROM usage_events WHERE ${where} ORDER BY id`).all(...values).map((z) => ({ ...z }));
const withoutId = (z) => ({ ...z, gen: /^gen-harness-\d+$/.test(z.gen) ? "<id>" : z.gen });
// The amount the fake router reports for every generation (agent-harness.mjs HARNESS_COST).
const HARNESS_AMOUNT = 0.00042;

test("(4) OpenRouter: the ONLY round of the main run breaks off after the response head => one row with the generation id, the sweep asks for the amount", async () => {
  await withAgentsServer(async ({ base, ws, waitForIdle, waitForQuiet }) => {
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "openrouter", model: "m1", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Cutoff" }) }); // no title call
    await post(`${base}/api/chats/${c.id}/message`, { text: "A long answer, please." });
    await waitForIdle();
    await waitForQuiet();
    const where = "chat_id = ? AND kind = 'main' AND source = ''";
    assert.deepEqual(orRows(where, c.id).map(withoutId), [
      { provider: "openrouter", billing: "metered", kind: "main", input: 0, output: 0, cached: 0, gen: "<id>", cost: null, origin: "" },
    ], "the aborted round stands there with its id - tokens 0, amount unknown");
    const run = await catchUpAmounts();
    assert.deepEqual({ inquired: run.inquired, retrievals: run.retrievals }, { inquired: 1, retrievals: 1 }, JSON.stringify(run));
    const [z] = orRows(where, c.id);
    assert.deepEqual([z.cost, z.origin], [HARNESS_AMOUNT, "inquired"], "the amount OpenRouter charged");
  }, { engine: CUTOFF });
});

test("(5) OpenRouter subagent: its ONLY round breaks off => one row with the generation id (agent_id), not nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForTruthy, waitForQuiet } = ctx;
    withoutHold(chat.id);
    await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("o1", "Work.", { model: "openrouter::m1" }), saveAs: "o1" }]) });
    const agentId = await waitForTruthy(() => read(root, "id-o1") || null, "agentId o1");
    // Its end (failed at the cutoff) - then what was to be booked is booked (settle -> onFinish, synchronous).
    await waitForTruthy(() => (dbModule.db.prepare("SELECT state FROM subagents WHERE agent_id = ?").get(agentId)?.state === "finished" ? true : null), "end of o1");
    await waitForQuiet();
    assert.deepEqual(orRows("agent_id = ?", agentId).map(withoutId), [
      { provider: "openrouter", billing: "metered", kind: "sub", input: 0, output: 0, cached: 0, gen: "<id>", cost: null, origin: "" },
    ], "the subagent's aborted round stands there with its id");
  }, { claude: fake, engine: CUTOFF });
});

test("(6) the chat is deleted while its subagent is mid-turn => the turn is booked anyway (on the old chatId), exactly once", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    withoutHold(chat.id);
    const { agentId, pid } = await agentAtGate(ctx, "d1", "d");
    assert.deepEqual(rowsOf(agentId), []);

    const r = await fetch(`${base}/api/chats/${chat.id}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(r.status, 200, await r.text());
    assert.equal(rowsOf(agentId).length, 1, "booked on closing the deleted chat");
    await afterTheEnd(ctx, pid);

    assert.deepEqual(rowsOf(agentId), [
      { provider: "claude", billing: "subscription", kind: "sub", source: "", input: 11, output: 5, cached: 120, read: 100, write: 20 },
    ], "exactly once");
    assert.equal(dbModule.db.prepare("SELECT chat_id FROM usage_events WHERE agent_id = ?").get(agentId).chat_id, chat.id, "on the deleted chat");
  }, { claude: fake });
});
