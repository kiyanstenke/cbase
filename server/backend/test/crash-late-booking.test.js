// Guard: what a crash in the middle of work would have swallowed is booked afterwards by the restart from the session
// files (runs/lateBooking.js). A main turn books only at its end, a subagent at the end of each turn — if the process dies
// in between (OOM, deploy without idle), the usage existed only in memory. The CLIs write it down themselves, though:
// Claude per answer into the session file, Codex one token_count row per model call into the rollout.
//
// "Hard" means SIGKILL to the server PROCESS (withAgentsServer with `childProcess: true`, agent-server-child.mjs; afterwards it
// starts on the same data folder with an immediate restart). The fakes write their session files themselves — into a
// Claude home and a Codex home of THIS test (CLAUDE_CONFIG_DIR / CODEX_HOME of the server process,
// runs/session-location.js) — with timestamps like the CLIs. We wait for events (gates, database rows, the orphans'
// hints, quiet), never for a duration.
//
// Measured:
//   - A subagent (Claude) whose first turn was booked properly and which dies in its SECOND turn: exactly the second
//     turn is booked afterwards — from `booked_until`, not from its start (the first would otherwise stand twice),
//     de-duplicated by message.id (the CLI writes one row per content block with the same input; the output counts once,
//     the largest).
//   - A subagent (Codex) that dies in its first turn: the turn from the rollout, from its start.
//   - The interrupted main turn: from its session file (the active_runs row carries the session since the init event),
//     from `started_at`; the resumption books nothing twice.
//   - The late booking runs BEFORE "agent-orphaned": when the orphans' hints are there, the rows are booked.
// Also, in the test's own process, without a child:
//   - bookTurn clears the session of the active_runs row in the SAME step as the booking — a crash after that (in the
//     awaits before clearActiveRun: maybeAutoContinue, instance check) does not book the turn a second time; the row of a
//     retry (own `started_at`) keeps its session.
//   - The late booking runs synchronously BEFORE `listen` — not as a restart hook 2.5 s later, in which a new turn reset
//     `started_at` and left the crashed one unbooked for good. Measured with the restart grace switched off (24 h).
//   - A parked subagent whose resumption fails to come (orphaned) books the `open` of its image — exactly once.
//
// COUNTER-TESTS (each shown red once):
//   - server.js without the late-booking call before `listen` (the state with a restart hook) turns the restart-from-
//     session-files cases red (A: 1 row instead of 2, C and the main turn: 0 instead of 1).
//   - runs/lateBooking.js booking the subagents from `Number(a.startedAt)` instead of from `bookedUntil` turns it red
//     (the first turn of A twice: input 12).
//   - runs/lateBooking.js claudeConsumptionSince without de-duplication (every row counts) turns it red (input 22
//     instead of 11, output 12 instead of 7).
//   - runs/booking.js bookTurn without clearing the session (`store.setActiveRunSession(… { startedAt: runBegin })`) turns
//     the bookTurn test red (the row's session stays: 'b4-session' instead of '' — the restart booked the turn twice).
//   - server.js startServer without `try { lateBookingRestartGrace(); } catch …` before `listen` turns the
//     before-listen test red (0 rows instead of 1 — the restart comes in 24 h; the child test above likewise).
//   - runs/agents.js reportOrphaned without the call `bookOpenImage(a)` turns the orphan test red (0 rows instead of 1).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, freePort, json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { startServer } from "../electron/server/server.js";
import { bookTurn } from "../electron/server/runs/booking.js";
import { lateBookingRestartGrace } from "../electron/server/runs/lateBooking.js";
import { reportOrphaned } from "../electron/server/runs/agents.js";

// The homes of this test — BEFORE the server (the server process inherits the environment). Outside the harness's throwaway
// folder: the fake then writes no session files of its own (agent-harness.mjs); the bodies here write them with usage.
const SAVED_ENV = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
const CCD = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-crash-claude-"));
const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-crash-codex-"));
process.env.CLAUDE_CONFIG_DIR = CCD;
process.env.CODEX_HOME = CODEX_HOME;
process.on("exit", () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [CCD, CODEX_HOME]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// An answer into the session file, as the CLI writes it (type assistant, timestamp, message.id, message.usage).
const SESSION_ROW = `
  const sessionRow = (sid, id, usage) => {
    const file = path.join(${JSON.stringify(CCD)}, "projects", "crash-test", sid + ".jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), sessionId: sid, message: { id, role: "assistant", usage } }) + "\\n");
  };`;

// The main agent: on the FIRST turn the calls from "OPS:[…]" (model: agent-orphaned.test.js; `saveAs`/`to` store agentIds and
// use them), then an answer of its own into its session file and the gate "main" — the crash hits it there. Every later
// turn (the resumption after the restart) ends at once and reports no usage.
const MAIN = `${SESSION_ROW}
  if (text.includes("<task-notification>") || fs.existsSync(path.join(LOCATION, "main-1"))) {
    finished(); say({ type: "result", result: "further", session_id: "main-session" }); return;
  }
  fs.writeFileSync(path.join(LOCATION, "main-1"), "1");
  say({ type: "system", subtype: "init", session_id: "main-session" });
  const ops = JSON.parse(/OPS:(\\[.*\\])/.exec(text)[1]);
  for (const op of ops) {
    const args = { ...op.args };
    if (op.to) args.agentId = fs.readFileSync(path.join(LOCATION, "id-" + op.to), "utf8");
    const id = "toolu_" + op.tag;
    say({ type: "assistant", message: { id: "main-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: args }] } });
    let t = "";
    try { const m = await mcpCall(op.w, args); t = (m.result && m.result.isError ? "ERROR " : "") + textOf(m); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    if (op.saveAs) { try { fs.writeFileSync(path.join(LOCATION, "id-" + op.saveAs), JSON.parse(t).agentId); } catch {} }
    fs.writeFileSync(path.join(LOCATION, "result-" + op.tag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  sessionRow("main-session", "msg-h1", { input_tokens: 30, output_tokens: 9, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 });
  await gate("main");
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// Subagent A (Claude): the first turn answers briefly (stream AND session file, booked at its end); the continuation with
// {GATE:x} writes ONE answer in two rows (two content blocks, the same input, the output grows) and stands at the gate.
const SUB = `${SESSION_ROW}
    const x = (/\\{GATE:([a-z0-9]+)\\}/.exec(text) || [])[1] || "";
    const session = arg("--resume") || "sub-session-a";
    say({ type: "system", subtype: "init", session_id: session });
    if (!x) {
      const u = { input_tokens: 1, output_tokens: 2 };
      sessionRow(session, "msg-a1", u);
      say({ type: "assistant", message: { id: "msg-a1", usage: u, content: [{ type: "text", text: "short" }] } });
      finished();
      say({ type: "result", result: "finding short", session_id: session });
      return;
    }
    sessionRow(session, "msg-a2", { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
    sessionRow(session, "msg-a2", { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
    await gate(x);
    finished();
    say({ type: "result", result: "finding " + x, session_id: session });`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

// Fake Codex (subagent C): a turn with one model call in the rollout (input 300, of which 200 from cache, output 40), then the
// gate "codex" — without turn.completed; the crash hits it there.
const THREAD = "codex-crash-1";
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
  fs.writeFileSync(path.join(LOCATION, "gates", "codex.waiting"), "1");
  await new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(path.join(LOCATION, "gates", "codex"))) { clearInterval(t); r(); } }, 20); });
  say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "Codex finding" } });
  say({ type: "turn.completed", usage: usage });
})();
`;

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops) => `Go OPS:${JSON.stringify(ops)}`;

// Read access to the server process's database.
const rows = (db, where, ...values) => db.prepare(`SELECT provider, billing, kind, agent_id AS agentId, input, output, cached,
  cache_read AS read, cache_write AS write FROM usage_events WHERE ${where} ORDER BY id`).all(...values).map((z) => ({ ...z }));
const subagent = (db, chatId, agentId) => db.prepare("SELECT session, state, booked_until AS bookedUntil FROM subagents WHERE chat_id = ? AND agent_id = ?").get(chatId, agentId);
const runRow = (db, chatId) => db.prepare("SELECT session, provider FROM active_runs WHERE chat_id = ?").get(chatId);
const hints = (db, chatId) => db.prepare("SELECT source, text FROM chat_hints WHERE chat_id = ? ORDER BY id").all(chatId);
const subscription = (provider, kind, agentId, input, output, cached, read, write) =>
  ({ provider, billing: "subscription", kind, agentId, input, output, cached, read, write });

test("Crash in the middle of work ⇒ subagents (Claude from booked_until, de-duplicated; Codex from the rollout) and the main turn are booked afterwards, nothing twice", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForQuiet, crash, db: open }) => {
    let db = open();
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { w: "cbase_agent", tag: "a1", saveAs: "A", args: { description: "Agent A", prompt: "First, briefly.", run_in_background: false } },
        { w: "cbase_agent_send", tag: "a2", to: "A", args: { message: "Continue {GATE:a}." } },
        { w: "cbase_agent", tag: "c1", saveAs: "C", args: { description: "Agent C", prompt: "Work.", run_in_background: true, model: "codex::gpt-5.6-sol" } },
      ]) });
      await gate.reached("a");
      await gate.reached("codex");
      await gate.reached("main");
      const A = await waitForTruthy(() => read(root, "id-A") || null, "agentId A");
      const C = await waitForTruthy(() => read(root, "id-C") || null, "agentId C");
      assert.doesNotMatch(read(root, "result-a2"), /ERROR/, read(root, "result-a2").slice(0, 300));
      // The state before the crash, awaited in the database: A lives in its second turn with the first booked, C lives with its
      // thread, the main turn carries its session.
      await waitForTruthy(() => {
        const a = subagent(db, chat.id, A), c = subagent(db, chat.id, C), r = runRow(db, chat.id);
        return a?.state === "running" && a.session === "sub-session-a" && a.bookedUntil > 0
          && c?.state === "running" && c.session === THREAD && r?.session === "main-session" && r.provider === "claude";
      }, "state before the crash");
      assert.deepEqual(rows(db, "agent_id = ?", A), [subscription("claude", "sub", A, 1, 2, 0, 0, 0)], "the first turn of A is booked");
      assert.deepEqual(rows(db, "agent_id = ?", C), []);
      assert.deepEqual(rows(db, "chat_id = ? AND kind = 'main'", chat.id), [], "the main turn is still running");

      db.close();
      await crash();
      db = open();
      // The late booking runs before `listen`, hence before "agent-orphaned" — once both hints are there, it is booked.
      await waitForTruthy(() => (hints(db, chat.id).filter((h) => h.source === "agent-orphaned").length >= 2 ? true : null), "hints of the orphans");

      assert.deepEqual(rows(db, "agent_id = ?", A), [
        subscription("claude", "sub", A, 1, 2, 0, 0, 0),
        // Only the second turn (from booked_until), msg-a2 once: input 11, output the largest (7), read 100 + write 20.
        subscription("claude", "sub", A, 11, 7, 120, 100, 20),
      ], "A: the second turn booked afterwards, the first not again");
      // Codex in tally form: fresh input (300 − 200), read 200, no write.
      assert.deepEqual(rows(db, "agent_id = ?", C), [subscription("codex", "sub", C, 100, 40, 200, 200, 0)], "C: the turn from the rollout");
      assert.deepEqual(rows(db, "chat_id = ? AND kind = 'main'", chat.id), [subscription("claude", "main", "", 30, 9, 1050, 1000, 50)],
        "the interrupted main turn from its session file");

      // The resumption of the main turn (resume.js) runs through without booking anything twice.
      gate.open("main");
      await waitForQuiet();
      assert.equal(rows(db, "chat_id = ?", chat.id).length, 4, JSON.stringify(rows(db, "chat_id = ?", chat.id)));
      assert.equal(subagent(db, chat.id, A).state, "orphaned");
    } finally {
      try { db.close(); } catch {}
      for (const t of ["a", "codex", "main"]) gate.open(t);
    }
  }, { claude: fake, codex: CODEX, childProcess: true });
});

// ── In the test's own process (this process's database, see header) ─────────────────────────────────────────
const dbModule = await import("../electron/server/store/db.js"); // `db` is a live binding — read only after initStore
const here = (chatId) => dbModule.db.prepare(`SELECT provider, billing, kind, agent_id AS agentId, input, output, cached,
  cache_read AS read, cache_write AS write FROM usage_events WHERE chat_id = ? ORDER BY id`).all(chatId).map((z) => ({ ...z }));
const sessionOf = (chatId) => store.listActiveRuns().find((r) => r.chatId === chatId)?.session;
const tempFolder = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cbase-${name}-`));

test("Booking a turn clears its session in the same step — a crash before the row is cleared books nothing twice", () => {
  const root = tempFolder("b4");
  try {
    store.initStore(root);
    const T0 = Date.now() - 60_000;
    store.setActiveRun("b4", { prompt: "go", startedAt: T0 });
    store.setActiveRunSession("b4", { session: "b4-session", provider: "claude", model: "m" });
    bookTurn({ assignment: { chatId: "b4", secs: 3 }, res: { code: 0 }, tally: { main: { input: 5, output: 3, cached: 0 } }, providerId: "claude", model: "m", runBegin: T0 });
    assert.equal(sessionOf("b4"), "", "the row names no session any more");
    // The process dies HERE (before clearActiveRun in the finally of doRun) — the restart finds the row without a session.
    const r = lateBookingRestartGrace({ consumption: () => ({ input: 5, output: 3, cached: 0, cacheRead: 0, cacheWrite: 0, untilMs: T0 + 1000 }) });
    assert.deepEqual(r, { turns: 0, agents: 0 }, "nothing booked afterwards");
    assert.deepEqual(here("b4").map((z) => [z.kind, z.input, z.output]), [["main", 5, 3]], "exactly one row");

    // A retry (own `started_at`) has its own session — the previous one's booking does not touch it.
    store.setActiveRun("b4", { prompt: "go", startedAt: T0 + 5000 });
    store.setActiveRunSession("b4", { session: "b4-two", provider: "claude", model: "m" });
    bookTurn({ assignment: { chatId: "b4", secs: 1 }, res: { code: 1 }, tally: {}, providerId: "claude", model: "m", runBegin: T0 });
    assert.equal(sessionOf("b4"), "b4-two");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("The late booking runs BEFORE listen — booked before any path can start a turn (the restart never comes here)", async () => {
  const root = tempFolder("b5");
  const dataRoot = path.join(root, "data-root");
  const prior = { CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL };
  process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
  process.env.CBASE_TRIGGER_POLL = "0";
  let server = null;
  try {
    fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
    store.initStore(path.join(dataRoot, "data"));
    const T0 = Date.now() - 60_000;
    store.setActiveRun("b5", { prompt: "go", startedAt: T0 });
    store.setActiveRunSession("b5", { session: "b5-session", provider: "claude", model: "m" });
    // The session file of the crashed turn in this test's Claude home (CCD, see above) — an answer after its start.
    const file = path.join(CCD, "projects", "b5-test", "b5-session.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date(T0 + 1000).toISOString(), sessionId: "b5-session",
      message: { id: "msg-b5", role: "assistant", usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 40, cache_creation_input_tokens: 4 } } }) + "\n");

    server = await startServer({ port: await freePort(), dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    // The server is listening — a message could start a turn NOW. Already booked:
    assert.deepEqual(here("b5"), [subscription("claude", "main", "", 7, 2, 44, 40, 4)], "the crashed turn, booked before listen");
    assert.equal(sessionOf("b5"), "", "and its row names no session any more");
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A parked subagent that is not resumed (orphaned) books the `open` of its image — exactly once", () => {
  const root = tempFolder("b7");
  try {
    store.initStore(root);
    // Legacy row without a resume time (`parkedUntil` missing) ⇒ the resumption cannot be guessed, it becomes orphaned (reportOrphaned).
    store.rememberSubagent("b7-chat", { agentId: "b7-a", provider: "claude", model: "m", sessionId: "b7-s", state: "parked", billing: "subscription",
      open: { input: 4, output: 2, cached: 30, cacheRead: 20, cacheWrite: 10 } });
    reportOrphaned();
    assert.deepEqual(here("b7-chat"), [subscription("claude", "sub", "b7-a", 4, 2, 30, 20, 10)], "the turn before parking");
    reportOrphaned(); // a second start: orphaned is orphaned, nothing twice
    assert.equal(here("b7-chat").length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
