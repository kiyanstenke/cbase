// The RUN of an outer-loop agent — through the real server, the real core (runs/agents.js, `own` + `outerLoop`) and the real
// cbase MCP server; only the providers are faked (agent-harness.mjs: fake Claude, fake preset endpoint of the loop engine):
//   (1) the summarizer without selection: `tools/list` of its MCP server = exactly `cbase_chat_analysis` (and it answers), the CLI
//       gets `--tools ""` (no built-ins), cwd = DIRS.empty (sandboxed, no instance), the marker `<agentId>:<runId>`; afterwards a
//       note + run row `finished` with watermark, tokens and session, booking in usage_events (`source outer_loop`, `agent_id`),
//       MCP file and profile gone; without anything new nothing starts (no row)
//   (2) cost at a third-party provider with a price: ONE computation with the usage tab (account/prices.js costFor); the frame of
//       the run is in the system prompt, the engine offers only the analysis tool. The engine's provider is the BUILT-IN OpenRouter
//       (agent-harness.mjs), which reports its amount per answer (`usage.cost`) — the reported amount beats the table (costFor
//       `reported`); without a report the catalog price estimates, with a report only it counts
//   (3) the gate parks => `parked` with the reset, the wakeup => the same run `finished` (attempts 2)
//   (4) chat deleted in the middle of the run => core quiet, no note, no row — also if the answer comes afterwards
//   (5) the set after fence and approval cut is in `set` (names, no token) — execution side = description side; external servers
//       are coding servers — marked => `approval`, deselected on the server => `locked`, hidden by the project => missing; in the
//       project container they stay (airlock), no access in the row
//   (6) aborting an agent in the middle of a run (the delete path calls outerloop/abort.js abortOuterLoop, the aborter from
//       server.js stops the core) => row `aborted`, core closed, no note — also if the answer comes afterwards; the session is in
//       the row already DURING the run, and the close path finds it (outerLoopSessionsOf)
//   (7) an agent without selection on the chat of a converted project: runtime folder (MCP file) and cwd stay in B, never in the
//       runtime folder of the project (which the project container mounts rw)
//   (8) a selected coding server comes as an airlock wrapper with the token role `outer_loop`; the airlock passes on only the
//       agent's selection without anything marked, the allowlist names the same, after the run the token expires
//   (9) account switch: parked at the credit gate, a NEWER measurement shows the gate free for every model => the gate wakeup
//       (wakeOuterLoopAtGate, on the sweeper's tick) continues the run before the reset; an older measurement, a full
//       model-scoped window and a run parked at the project lock do not wake / are not woken
//
// COUNTER-TESTS (which sabotage turns which test red):
//   outerloop/run.js `cwd: atProject ? resolveCwd(chat, { instance }) : DIRS.empty` -> `resolveCwd(chat, { instance })` => (1) red
//   (cwd is the workspace); outerloop/trigger.js outerLoopChatClosed without `outerLoopCoresSilence` => (4) red (the core lives on);
//   server.js without `setOuterLoopAborter(outerLoopAborter)` => (6) red (the core lives on);
//   outerloop/run.js `runtime: atProject && instance ? locationForChat(chat) : locationFor({})` -> `locationForChat(chat)` => (7) red;
//   outerloop/run.js parkState without `store.outerLoopRunSession` => (6) red (no session during the run);
//   a set that reads the servers of the old managing area, a file without a wrapper => (5) and (8) red;
//   outerloop/run.js wakeOuterLoopAtGate with `continue` instead of the gate question => (9) red.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-run.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { setUpManagerMcpServer, seedOldSchema } from "./managing-old-seed.mjs";
import { DIRS } from "../electron/server/app-state.js";
import { setStartGate } from "../electron/server/providers/index.js";
import { agentTraces } from "../electron/server/runs/agents.js";
import { costFor } from "../electron/server/account/prices.js";
import { FENCE_LOCKED } from "../electron/mcp/visibility.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { OUTER_LOOP_SELECTABLE } from "../electron/server/outerloop/catalog.js";
import { FRAME_IDENTIFIER_LINE } from "../electron/server/outerloop/input.js";
import { outerLoopSet, setRow } from "../electron/server/outerloop/set.js";
import { wakeOuterLoopAtGate, outerLoopCoreCount, outerLoopWakeParkedNow, startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { abortOuterLoop } from "../electron/server/outerloop/abort.js";
import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";

const ANALYSIS = "cbase_chat_analysis";
const MODEL = "claude-haiku-4-5-20251001";

// The outer-loop run in fake Claude: recognized by the frame (like a real model); it writes what it sees to ol-<pid>.json, really
// calls the analysis tool and answers with the note. Every other run (turn of the chat) ends like the default.
const OL_BODY = `
if (joined.includes(${JSON.stringify(FRAME_IDENTIFIER_LINE)})) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase;
  const tools = await mcpTools();
  const history = textOf(await mcpCall("cbase_chat_analysis", { action: "history" }));
  fs.writeFileSync(path.join(LOCATION, "ol-" + process.pid + ".json"), JSON.stringify({ tools, builtin: eingebauteTools(),
    toolsArg: argv.includes("--tools") ? arg("--tools") : null, cwd: process.cwd(), marker: (cfg.env || {}).CBASE_OUTER_LOOP || "",
    cfgPath, text, history, permissionPromptTool: argv.includes("--permission-prompt-tool") }));
  say({ type: "assistant", message: { id: "ol-1", usage: { input_tokens: 30, output_tokens: 7 }, content: [{ type: "text", text: "Note: the checkout is rebuilt." }] } });
  finished(); say({ type: "result", result: "Note: the checkout is rebuilt.", session_id: "ol-session" });
  return;
}
finished(); say({ type: "result", result: "finished", session_id: "main-session" });
`;

const run = (id) => store.outerLoopRun(id);
const isClosed = (id) => ["finished", "error", "aborted"].includes(run(id)?.state);

// Waits for the (held) engine request of the run OR for its end: a run that fails BEFORE its request (gate, spawn, set) is a red
// test with state and reason — not a silent hang until the suite deadline. `signal.arrived` is set by the engine round; `isClosed` asks
// the row, both without a clock.
async function waitForRequest(waitForTruthy, signal, runId) {
  const r = await waitForTruthy(() => (signal.arrived ? { arrived: true } : isClosed(runId) || !run(runId) ? { tooEarly: run(runId) } : null),
    "engine request of the outer-loop run (or its end)");
  assert.ok(r.arrived, `the run ended before its request: ${JSON.stringify(r.tooEarly)}`);
}

// An agent on the test chat: row "active" from 0 (the watermark of the first run then reads everything).
function activeAgent(ws, chat, fields) {
  const a = store.createOuterLoopAgent({ id: fields.id, workspaceId: ws.id, name: fields.name || "Reviewer", trigger: [{ kind: "quiet", minutes: 5 }], ...fields });
  store.setOuterLoopActive(a.id, chat.id, true, 0);
  return a;
}
const conversation = (chatId) => {
  store.addMessage(chatId, "user", "Please rebuild the checkout.", 1000);
  store.addMessage(chatId, "assistant", "The checkout is rebuilt.", 1001);
  return store.messageStats(chatId).lastId;
};

test("(1) the summarizer without selection: only the analysis tool, no built-ins, DIRS.empty — then note, row, booking, cleaned up", async () => {
  await withAgentsServer(async ({ chat, ws, root, waitForTruthy }) => {
    const summarizer = store.outerLoopSummarizer(ws.id);
    assert.ok(summarizer, "the workspace POST seeded it");
    // Without a model it is ineffective: no run, no row.
    const untilId = conversation(chat.id);
    store.setOuterLoopActive(summarizer.id, chat.id, true, 0);
    assert.equal((await startOuterLoopRun({ agent: summarizer, chat, trigger: "quiet" })).reason, "ineffective");
    store.changeOuterLoopAgent(summarizer.id, { provider: "claude", model: MODEL });

    const r = await startOuterLoopRun({ agent: summarizer, chat, trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    await waitForTruthy(() => isClosed(r.runId), "run finished");
    const l = run(r.runId);
    assert.equal(l.state, "finished", JSON.stringify(l));
    assert.equal(l.untilMessageId, untilId, "the watermark: the last row the run saw");
    assert.equal(l.trigger, "quiet");
    assert.deepEqual(l.set, { cbase: [ANALYSIS], builtin: [], extern: [], dropped: { fence: [], approval: [], locked: [], genus: [] } });
    assert.equal(l.input, 30);
    assert.equal(l.output, 7);
    assert.equal(l.cost, null, "subscription: no cost");
    assert.equal(l.provider, "claude");
    assert.equal(l.model, MODEL);
    assert.equal(l.sessionId, "ol-session", "the session of the run (the close path takes it along)");
    assert.equal(store.outerLoopLastNote(summarizer.id, chat.id)?.text, "Note: the checkout is rebuilt.");

    // What the run saw.
    const file = fs.readdirSync(root).find((n) => /^ol-\d+\.json$/.test(n));
    assert.ok(file, "the fake ran as an outer-loop run");
    const sah = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    assert.deepEqual(sah.tools, [ANALYSIS], "tools/list des echten MCP-Servers");
    assert.equal(sah.toolsArg, "", "--tools \"\": no built-ins");
    assert.deepEqual(sah.builtin, []);
    assert.equal(fs.realpathSync(sah.cwd), fs.realpathSync(DIRS.empty), "sandboxed: cwd is the empty folder");
    assert.equal(sah.marker, `${summarizer.id}:${r.runId}`, "the marker in the MCP server");
    assert.equal(sah.permissionPromptTool, false, "no permissionPromptTool");
    assert.match(sah.history, /checkout/, "the analysis tool answers from the observed chat");
    assert.match(sah.text, /<outer-loop-input/, "the input is fenced");
    assert.match(path.basename(sah.cfgPath), new RegExp(`^${chat.id}\\.outerloop-${summarizer.id}-${r.runId}\\.mcp\\.json$`));

    // Booking: through the core, with source and agent.
    const booking = db.prepare("SELECT provider, input, output, source, agent_id AS agentId FROM usage_events WHERE chat_id = ? AND source = 'outer_loop'").all(chat.id);
    assert.deepEqual(booking.map((b) => ({ ...b })), [{ provider: "claude", input: 30, output: 7, source: "outer_loop", agentId: summarizer.id }]);
    // Cleanup at the run end: MCP file and profile gone, no core open any more.
    await waitForTruthy(() => outerLoopCoreCount() === 0, "core closed");
    for (const p of agentTraces(chat.id, "x", { outerLoop: { agentId: summarizer.id, runId: r.runId } })) {
      await waitForTruthy(() => !fs.existsSync(p), `Spur fort: ${path.basename(p)}`);
    }
    // Nothing new above the watermark => no run, no row.
    const prior = store.outerLoopRunsOfAgent(summarizer.id, { limit: 50 }).items.length;
    assert.equal((await startOuterLoopRun({ agent: summarizer, chat, trigger: "quiet" })).reason, "nothing-new");
    assert.equal(store.outerLoopRunsOfAgent(summarizer.id, { limit: 50 }).items.length, prior);
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

test("(2) cost at OpenRouter: the reported amount, same computation as the tick; frame in the system prompt, only the analysis tool", async () => {
  await withAgentsServer(async ({ chat, ws, waitForTruthy, engine }) => {
    conversation(chat.id);
    const a = activeAgent(ws, chat, { id: "e0000000-0000-4000-8000-00000000000e", name: "Engine reviewer", provider: engine.id, model: engine.model });
    const r = await startOuterLoopRun({ agent: a, chat, trigger: "interval" });
    assert.equal(r.started, true, JSON.stringify(r));
    await waitForTruthy(() => isClosed(r.runId), "run finished");
    const l = run(r.runId);
    assert.equal(l.state, "finished", JSON.stringify(l));
    assert.equal(l.billing, "metered");
    assert.ok(l.input > 0 && l.output > 0);
    // The fake endpoint reports 0.00042 USD per answer (agent-harness.mjs HARNESS_KOSTEN): what is paid is the sum of the answers of
    // this run, and a price (deliberately absurd here: per token input × 1 + output × 2) then does not count.
    const responses = engine.requests.filter((b) => b.stream !== false).length;
    const reported = Math.round(responses * 0.00042 * 1e9) / 1e9;
    assert.ok(Math.abs(l.cost - reported) < 1e-9, `reported: ${l.cost} instead of ${reported} (${responses} answers)`);
    const absurd = { prompt: 1, completion: 2 };
    assert.ok(Math.abs(costFor({ model: engine.model, input: l.input, output: l.output, reported, prices: absurd }) - l.cost) < 1e-9, "the same computation");
    assert.notEqual(l.cost, l.input * 1 + l.output * 2, "the price does not count when an amount is reported");
    assert.equal(store.outerLoopLastNote(a.id, chat.id)?.text, "Engine-Befund 42");
    const request = engine.requests.find((b) => b.stream !== false);
    assert.ok(request, "the engine asked");
    const system = (request.messages || []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    assert.match(system, new RegExp(FRAME_IDENTIFIER_LINE), "the frame of the run");
    const offered = (request.tools || []).map((t) => t.function?.name || t.name);
    assert.ok(offered.some((n) => n.endsWith(ANALYSIS)), `the analysis tool: ${offered.join(", ")}`);
    for (const n of offered) assert.ok(n.endsWith(ANALYSIS) || !n.startsWith("mcp__"), `no other MCP tool: ${n}`);
    assert.equal(offered.some((n) => ["Read", "Write", "Bash", "Edit"].includes(n)), false, `no built-ins: ${offered.join(", ")}`);
  }, { engine: true });
});

test("(3) the gate parks => parked until the reset; the wakeup => the same run finished", async () => {
  await withAgentsServer(async ({ chat, ws, waitForTruthy }) => {
    conversation(chat.id);
    const a = activeAgent(ws, chat, { id: "f0000000-0000-4000-8000-00000000000f", provider: "claude", model: MODEL });
    let locked = true;
    const reset = Date.now() + 3_600_000;
    setStartGate(async (o) => (locked && o.purpose === "agent" ? { ok: false, window: { resetsAt: reset, label: "5-hour window" }, percent: 99 } : { ok: true }));
    const r = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
    assert.equal(r.reason, "parked", JSON.stringify(r));
    const p = run(r.runId);
    assert.equal(p.state, "parked");
    assert.equal(p.parkedUntil, reset, "until the reset of the window");
    assert.match(p.error, /5-hour window/);
    // A second trigger starts nothing second.
    assert.equal((await startOuterLoopRun({ agent: a, chat, trigger: "quiet" })).reason, "running");
    locked = false;
    assert.equal(outerLoopWakeParkedNow(), 1, "a wakeup was set");
    await waitForTruthy(() => isClosed(r.runId), "run finished");
    const l = run(r.runId);
    assert.equal(l.state, "finished", JSON.stringify(l));
    assert.equal(l.attempts, 2);
    assert.equal(store.outerLoopRunsOfAgent(a.id, { limit: 50 }).items.length, 1, "the same run, no second row");
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

// A measurement as fetchUsageLimits stores it (usage_cache_v1) — measured `at`; `fable` sets a model-scoped weekly window.
function seedMeasurement({ week, fable = null, at }) {
  const iso = new Date(at + 2 * 86_400_000).toISOString();
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: 3, resetsAt: iso }, sevenDay: { utilization: week, resetsAt: iso },
    limits: [
      { kind: "session", group: "session", percent: 3, resets_at: iso },
      { kind: "weekly_all", group: "weekly", percent: week, resets_at: iso },
      ...(fable == null ? [] : [{ kind: "weekly_scoped", group: "weekly", percent: fable, resets_at: iso, scope: { model: { id: null, display_name: "Fable" }, surface: null } }]),
    ],
    at,
  }));
}

test("(9) account switch: parked at the gate, a newer measurement shows the gate free for every model => the gate wakeup continues the run before the reset; project lock stays", async () => {
  await withAgentsServer(async ({ chat, ws, waitForTruthy }) => {
    conversation(chat.id);
    const a = activeAgent(ws, chat, { id: "f0000000-0000-4000-8000-000000000019", provider: "claude", model: MODEL });
    const b = activeAgent(ws, chat, { id: "f0000000-0000-4000-8000-00000000001a", name: "Project", provider: "claude", model: MODEL });
    const reset = Date.now() + 2 * 86_400_000;
    let verdict = { ok: false, window: { resetsAt: reset, label: "weekly" }, percent: 100 };
    setStartGate(async (o) => (o.purpose === "agent" ? verdict : { ok: true }));
    const beforeParking = Date.now() - 1;
    const r = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
    assert.equal(r.reason, "parked", JSON.stringify(r));
    assert.equal(run(r.runId).parkedUntil, reset, "precondition: parked until the reset of the old account");
    verdict = { ok: false, project: { kind: "wait" }, text: "Project container starting" };
    const rb = await startOuterLoopRun({ agent: b, chat, trigger: "quiet" });
    assert.equal(rb.reason, "parked", JSON.stringify(rb));

    verdict = { ok: true };
    seedMeasurement({ week: 0, at: beforeParking });
    assert.equal(wakeOuterLoopAtGate(), 0, "a measurement from BEFORE parking does not wake");
    seedMeasurement({ week: 0, fable: 100, at: Date.now() + 1 });
    assert.equal(wakeOuterLoopAtGate(), 0, "a full Fable weekly window: not free for every model");
    seedMeasurement({ week: 0, at: Date.now() + 2 });
    assert.equal(wakeOuterLoopAtGate(), 1, "the newer measurement wakes exactly the run at the credit gate");
    await waitForTruthy(() => isClosed(r.runId), "run finished");
    assert.equal(run(r.runId).state, "finished", JSON.stringify(run(r.runId)));
    assert.equal(run(rb.runId).state, "parked", "the run parked at the project lock stays with its wakeup");
    assert.equal(wakeOuterLoopAtGate(), 0, "nothing left at the gate");

    // Cleanup: finish the project-parked run through its wakeup.
    assert.equal(outerLoopWakeParkedNow(), 1);
    await waitForTruthy(() => isClosed(rb.runId), "project run finished");
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

test("(4) chat deleted in the middle of the run => core quiet, no note, no row — also if the answer comes afterwards", async () => {
  let release = null;
  const hold = new Promise((r) => { release = r; });
  const request = { arrived: false };
  await withAgentsServer(async ({ base, ws, waitForTruthy, waitForQuiet, engine }) => {
    const other = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: MODEL }) });
    conversation(other.id);
    const a = activeAgent(ws, other, { id: "d0000000-0000-4000-8000-00000000000d", provider: engine.id, model: engine.model });
    const r = await startOuterLoopRun({ agent: a, chat: other, trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    try {
      await waitForRequest(waitForTruthy, request, r.runId);
      assert.equal(outerLoopCoreCount(), 1);
      const d = await fetch(`${base}/api/chats/${other.id}`, { method: "DELETE", headers: { Connection: "close" } });
      assert.equal(d.status, 200);
      assert.equal(outerLoopCoreCount(), 0, "the core is quiet");
      assert.equal(run(r.runId), null, "the row fell with the chat");
      release();
      await waitForQuiet();
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outer_loop_notes WHERE chat_id = ?").get(other.id).n, 0, "no note");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outer_loop_runs WHERE chat_id = ?").get(other.id).n, 0, "no row");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE chat_id = ? AND source = 'outer_loop'").get(other.id).n, 0, "no booking");
    } finally { release(); }
  }, { engine: { round: async () => { request.arrived = true; await hold; return { text: "too late" }; } } });
});

test("(5) the set after fence and approval cut is in `set` — names, no token; external servers are coding servers of the airlock", async () => {
  await withAgentsServer(async ({ chat, ws, root }) => {
    // The selectable groups are the coding groups — the fence locks none of their tools; the cut stays (a new group could carry one
    // again), but affects none.
    assert.equal(OUTER_LOOP_SELECTABLE.some((t) => Object.hasOwn(FENCE_LOCKED, t)), false, "no selectable tool is fence-locked");
    const [one, two] = [OUTER_LOOP_SELECTABLE.at(-1), OUTER_LOOP_SELECTABLE[0]];
    const a = store.createOuterLoopAgent({ id: "c0000000-0000-4000-8000-00000000000c", workspaceId: ws.id, name: "Set", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: MODEL, tools: [one, two, "cbase_fact_search"], builtin: ["Read", "Task"] });
    const withoutToken = outerLoopSet(a, chat);
    assert.deepEqual(withoutToken.cbase, [two, one, ANALYSIS], "catalog order, a removed tool is missing, the analysis tool last");
    assert.deepEqual(withoutToken.builtin, ["Read"], "Task is not selectable");
    const withToken = outerLoopSet(a, chat, { withToken: true });
    assert.deepEqual(withToken.cbase, withoutToken.cbase);
    assert.deepEqual(setRow(withToken), { cbase: [two, one, ANALYSIS], builtin: ["Read"], extern: [], dropped: { fence: [], approval: [], locked: [], genus: [] } });

    // External servers are coding servers (coding -> MCP), the selection is `{ serverId: [tool] }`. A marked tool drops out under
    // `approval`, one deselected on the server under `locked`; a server that the project of the chat hides is missing entirely. In
    // the project container they stay (the file carries only the airlock wrapper) — and no header value is in the row.
    const at = Date.now();
    const srv = store.createMcpServer({ id: "teams-ol-5", workspaceId: ws.id, name: "teams", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer SECRET-OL" }, createdAt: at, updatedAt: at });
    store.updateMcpServer(srv.id, { choice: ["read", "send"], markers: ["send"], tools: [{ name: "read", description: "reads", writing: false, fresh: false }] });
    seedOldSchema(db); // a managing server of a store from before the teardown (the store no longer creates the table)
    setUpManagerMcpServer(db, { id: "mgr-ol-5", workspaceId: ws.id, key: "mgr", name: "Mgr", url: "http://127.0.0.1:9/mcp", token: "SECRET-MGR" });
    const withExternal = store.changeOuterLoopAgent(a.id, { mcp: { [srv.id]: ["read", "send", "erase"], "mgr-ol-5": ["x"] } });
    const inB = outerLoopSet(withExternal, chat);
    assert.deepEqual(inB.extern.map((x) => [x.server.key, x.tools]), [["teams", [{ name: "read", description: "reads", writing: false }]]], "the coding server, never the manager's");
    assert.deepEqual([inB.dropped.approval, inB.dropped.locked], [["mcp__teams__send"], ["mcp__teams__erase"]]);
    const inProject = outerLoopSet(withExternal, chat, { withToken: true });
    assert.deepEqual(inProject.extern.map((x) => x.server.key), ["teams"], "in the project container: included through the airlock");
    assert.equal(/SECRET/.test(JSON.stringify(setRow(inProject))), false, "no access in the row");
    const projectPath = path.join(root, "p-ol-5");
    fs.mkdirSync(projectPath, { recursive: true });
    store.addProject(ws.id, { id: "p-ol-5", name: "Without Teams", path: projectPath, createdAt: at });
    assert.deepEqual(outerLoopSet(withExternal, { ...chat, projectId: "p-ol-5" }).extern.map((x) => x.server.key), ["teams"], "counter-check: in the project as long as it does not hide it");
    store.setMcpServerAvailable("p-ol-5", srv.id, false);
    assert.deepEqual(outerLoopSet(withExternal, { ...chat, projectId: "p-ol-5" }).extern, [], "the project of the chat hides it");
  });
});

test("(6) an agent is aborted in the middle of a run (delete path) => row aborted, core quiet, no note — also if the answer comes afterwards", async () => {
  let release = null;
  const hold = new Promise((r) => { release = r; });
  const request = { arrived: false };
  await withAgentsServer(async ({ chat, ws, waitForTruthy, waitForQuiet, engine }) => {
    conversation(chat.id);
    const a = activeAgent(ws, chat, { id: "b0000000-0000-4000-8000-00000000000b", provider: engine.id, model: engine.model });
    const r = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    try {
      await waitForRequest(waitForTruthy, request, r.runId);
      assert.equal(outerLoopCoreCount(), 1);
      // The session is in the row AS SOON AS it is known — not only at the end (a run that aborts left its session behind, and the
      // close path of the chat did not find it because it reads only rows with a session).
      const session = run(r.runId).sessionId;
      assert.ok(session, "the session is in the row already during the run");
      // The path of the delete routes (agent, project, workspace — outerloop/routes.js and the routes of projects and workspaces).
      const b = abortOuterLoop({ agentIds: [a.id], reason: "deleted" });
      assert.deepEqual(b, { agentIds: [a.id], runs: 1 });
      assert.equal(run(r.runId).state, "aborted");
      assert.ok((store.outerLoopSessionsOf([chat.id]).get(chat.id) || []).includes(session), "the close path finds the session of the aborted run");
      assert.equal(outerLoopCoreCount(), 0, "the aborter from server.js stopped the core");
      release();
      await waitForQuiet();
      assert.equal(run(r.runId).state, "aborted", "a returning run writes nothing");
      assert.equal(store.outerLoopLastNote(a.id, chat.id) ?? null, null, "no note");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE source = 'outer_loop' AND agent_id = ?").get(a.id).n, 0, "no booking");
    } finally { release(); }
  }, { engine: { round: async () => { request.arrived = true; await hold; return { text: "too late" }; } } });
});

test("(7) an agent without selection on the chat of a CONVERTED project: runtime folder, MCP file and cwd stay in B (flat)", async () => {
  // Critical: without an instance the CLI reads its MCP file in B by path name — in the runtime folder of a converted project
  // (`<data>/projects/<id>/`, mounted rw in the project container) the container could replace it between writing and reading,
  // and a smuggled `command` would run in B. The run without selection takes the flat location.
  await withAgentsServer(async ({ base, chat, ws, root, dataRoot, waitForTruthy }) => {
    const projPath = path.join(root, "workspace", "till");
    const p = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: projPath }) });
    fs.mkdirSync(projPath, { recursive: true });
    store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now() });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
    conversation(chat.id);
    const a = activeAgent(ws, chat, { id: "a7000000-0000-4000-8000-000000000007", provider: "claude", model: MODEL });
    const r = await startOuterLoopRun({ agent: a, chat: store.getChat(chat.id), trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    await waitForTruthy(() => isClosed(r.runId), "run finished");
    assert.equal(run(r.runId).state, "finished", JSON.stringify(run(r.runId)));
    const file = fs.readdirSync(root).find((n) => /^ol-\d+\.json$/.test(n));
    assert.ok(file, "the fake ran as an outer-loop run");
    const sah = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    const projects = fs.realpathSync(path.join(dataRoot, "data")) + path.sep + "projects" + path.sep;
    const cfgLocation = fs.realpathSync(path.dirname(sah.cfgPath)) + path.sep;
    assert.equal(cfgLocation.startsWith(projects), false, `the MCP file is NOT in the runtime folder of the project: ${sah.cfgPath}`);
    assert.equal(fs.realpathSync(sah.cwd), fs.realpathSync(DIRS.empty), "cwd is the empty folder, not the project");
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

// An outer-loop run that reads the wrapper of its selected coding server and asks the airlock for the list — as the wrapper would
// at start (mcp/airlock.js), with the run token from the file.
const AIRLOCK_BODY = `
if (joined.includes(${JSON.stringify(FRAME_IDENTIFIER_LINE)})) {
  const servers = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers;
  const h = servers.external || null;
  let list = null;
  if (h) {
    const id = h.args[h.args.indexOf("--server") + 1];
    const r = await fetch(h.env.CBASE_BASE_URL + "/api/chats/" + h.env.CBASE_CHAT_ID + "/mcp-airlock/" + id + "/list", { method: "POST", headers: { "Content-Type": "application/json", "x-cbase-airlock": h.env.CBASE_AIRLOCK }, body: JSON.stringify({ tools: [{ name: "read" }, { name: "send" }, { name: "third" }] }) });
    list = { status: r.status, body: await r.json() };
  }
  fs.writeFileSync(path.join(LOCATION, "ol-airlock.json"), JSON.stringify({ names: Object.keys(servers), wrapper: h, list, allowed: arg("--allowedTools") }));
  finished(); say({ type: "result", result: "Note: airlock read.", session_id: "ol-airlock" });
  return;
}
finished(); say({ type: "result", result: "finished", session_id: "main-session" });
`;

test("(8) external coding servers through the airlock: wrapper with token role outer_loop, only the agent's selection, nothing marked; afterwards the token expires", async () => {
  await withAgentsServer(async ({ base, chat, ws, root, waitForTruthy }) => {
    conversation(chat.id);
    const at = Date.now();
    // "Subagents inherit" is off (default of a new server) — it does not apply to the outer loop, the agent's selection decides.
    const srv = store.createMcpServer({ id: "external-ol-8", workspaceId: ws.id, name: "external", transport: "stdio", command: process.execPath, args: ["-e", ""], createdAt: at, updatedAt: at });
    store.updateMcpServer(srv.id, { markers: ["send"] });
    const a = activeAgent(ws, chat, { id: "a8000000-0000-4000-8000-000000000008", name: "Airlock reader", provider: "claude", model: MODEL, mcp: { [srv.id]: ["read", "send"] } });
    const r = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    await waitForTruthy(() => isClosed(r.runId), "run finished");
    assert.equal(run(r.runId).state, "finished", JSON.stringify(run(r.runId)));
    assert.deepEqual(run(r.runId).set.extern, [{ key: "external", name: "external", tools: ["read"] }]);
    assert.deepEqual(run(r.runId).set.dropped.approval, ["mcp__external__send"]);
    const d = JSON.parse(fs.readFileSync(path.join(root, "ol-airlock.json"), "utf8"));
    assert.ok(d.wrapper, `no wrapper in the file: ${JSON.stringify(d.names)}`);
    assert.deepEqual(d.names.sort(), ["cbase", "external"], "the wrapper and the cbase server — no Playwright, no other server");
    assert.match(d.wrapper.args[0], /mcp[/\\]airlock\.js$/, "the wrapper, never the real server");
    assert.deepEqual([d.list.status, d.list.body.tools.map((t) => t.name)], [200, ["read"]], "only the selection, without the marked send");
    const allowed = String(d.allowed).split(",");
    assert.ok(allowed.includes("mcp__external__read") && !allowed.includes("mcp__external__send")
, d.allowed);
    // After the run: the token has expired.
    const after = await fetch(`${base}/api/chats/${chat.id}/mcp-airlock/${srv.id}/start`, { headers: { "x-cbase-airlock": d.wrapper.env.CBASE_AIRLOCK, Connection: "close" } });
    assert.equal(after.status, 401);
  }, { claude: fakeClaude({ main: AIRLOCK_BODY }) });
});
