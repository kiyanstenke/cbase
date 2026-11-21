// Orphans after a restart and the idle cleanup of the cores — with the agent harness: real server, real cbase MCP server,
// real routes, only the providers are faked.
//
// A background agent outlives its turn — a forced restart therefore hits it in the middle of its work. It is NOT continued:
// the follow-up start reports it to its chat as a silent hint "orphaned: <agent id>" (no turn, no queue), and the main agent
// continues it via cbase_agent_send over the stored session (Claude --resume, Codex `exec … resume`, the loop engine with its
// stored history). The inventory is in the database (store/subagents.js) — from it cbase_agent_send also takes up an agent
// whose core was closed after idling.
//
// "Hard" here means SIGKILL to the server PROCESS (withAgentsServer with `childProcess: true`, agent-server-child.mjs): a restart in the
// test process would run through the orderly end and keep the module state. No clock: the fakes wait at gates (files), events
// are waited for (database rows, history, quiet).
//
// Counter-tests (each shown red once):
//   - the registration `registerHook("restartGrace", reportOrphaned, …)` in server.js removed => "Registration" red;
//   - `orphanSubagent` no longer sets the state (only `updated_at`) => "Registration" red (reported twice: 4 instead of 2);
//   - the registration "subagents" in store.js removed => tools/check/tree-rules.test.mjs "(e) real tree" red;
//   - `idleNow` without `liveCount() === 0` => "Idle" red (the core of the living agent closes along);
//   - `ctl.send` without `fromInventory` => "Idle" red ("Unknown subagent").
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_EMBED_OFFLINE=1 \
//   node --test server/backend/test/agent-orphaned.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import * as store from "../electron/server/store.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { coreWithAgent, idleNow, idleCount } from "../electron/server/runs/agents.js";

// The idle deadline never expires by itself in the test — it is triggered through the seam idleNow.
process.env.CBASE_AGENT_IDLE_MS = String(24 * 3_600_000);

// The main agent runs the calls from "OPS:[…]" (pattern agent-readjust.test.js); `saveAs` stores the agentId under a name
// (`id-<name>`), `to` inserts it again — also after a restart. Every input is in `main-inputs`, a completion notice it only reads.
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "main-inputs"), JSON.stringify(text) + "\\n");
  if (text.includes("<task-notification>")) {
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const ops = JSON.parse(/OPS:(\\[.*\\])/.exec(text)[1]);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
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

// The subagent: {GATE:x} reports its session and waits at gate x (a crash hits it there); otherwise it reports at once —
// with --resume as a continuation including message and session.
const SUB = `
    const x = (/\\{GATE:([a-z0-9]+)\\}/.exec(text) || [])[1] || "";
    const session = arg("--resume") || ("sub-session-" + (x || "f"));
    say({ type: "system", subtype: "init", session_id: session });
    const end = (r) => { finished(); say({ type: "result", result: r, session_id: session }); };
    if (x && !arg("--resume")) { await gate(x); return end("Finding " + x); }
    return end("Finding" + (arg("--resume") ? " (resumed " + arg("--resume") + ": " + text + ")" : ""));`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

// Fake Codex: {GATE} holds the first turn; a continuation (`exec … resume <id>`) reports thread and message.
const CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const ri = argv.indexOf("resume");
const message = argv[argv.length - 1].split("[END SYSTEM-DEFAULTS]").pop().trim();
fs.appendFileSync(path.join(LOCATION, "codex-calls"), JSON.stringify({ resume: ri >= 0 ? argv[ri + 1] : "", message }) + "\\n");
(async () => {
  say({ type: "thread.started", thread_id: ri >= 0 ? argv[ri + 1] : "codex-thread-7" });
  say({ type: "turn.started" });
  if (message.includes("{GATE}")) {
    await new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(path.join(LOCATION, "gates", "codex"))) { clearInterval(t); r(); } }, 20); });
  }
  say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: ri >= 0 ? "Codex resumed: " + message : "Codex-Finding" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops) => `Go OPS:${JSON.stringify(ops)}`;
const noticesOf = (log, agentId) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(`<task-id>${agentId}</task-id>`));
const turnPast = (base) => async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null);
const result = (waitForTruthy, root, tag) => waitForTruthy(() => read(root, `result-${tag}`) || null, `result ${tag}`);
const idOf = (root, name) => read(root, `id-${name}`);
// main-inputs and codex-calls are written by the fakes (child processes) — only completed lines (jsonl.mjs).
const inputs = (root) => readJsonl(path.join(root, "main-inputs"));
const START = (tag, prompt, further = {}) => ({ w: "cbase_agent", tag, args: { description: `Agent ${tag}`, prompt, ...further } });
const SEND = (tag, to, message) => ({ w: "cbase_agent_send", tag, to, args: { message } });

// Reading the database of the server process.
const rowOf = (db, chatId, agentId) => db.prepare("SELECT * FROM subagents WHERE chat_id = ? AND agent_id = ?").get(chatId, agentId);
const hintsOf = (db, chatId) => db.prepare("SELECT source, text FROM chat_hints WHERE chat_id = ? ORDER BY id").all(chatId);

test("Claude: killed hard => exactly one \"orphaned\" hint per running agent, no turn, busy:false; send continues via the session; a second restart reports none twice", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog, waitForQuiet, crash, db: open }) => {
    let db = open();
    try {
      // Turn 1: two agents stay at the gate (V is continued, L stays lying), F is done before the crash.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("v1", "Work {GATE:v}."), saveAs: "V" },
        { ...START("l1", "Work {GATE:l}."), saveAs: "L" },
        { ...START("f1", "Short.", { run_in_background: false }), saveAs: "F" },
      ]) });
      await result(waitForTruthy, root, "f1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      const [V, L, F] = ["V", "L", "F"].map((n) => idOf(root, n));
      await gate.reached("v");
      await gate.reached("l");
      // Wait for the stored session (the init event), not for a duration.
      await waitForTruthy(() => rowOf(db, chat.id, V)?.session === "sub-session-v" && rowOf(db, chat.id, L)?.session === "sub-session-l"
        && rowOf(db, chat.id, F)?.state === "finished", "sessions stored");
      assert.equal(rowOf(db, chat.id, V).state, "running");
      const logPrior = await json(`${base}/api/chats/${chat.id}/log`);
      const inputsPrior = inputs(root).length;

      db.close();
      await crash();
      db = open();
      await waitForTruthy(() => hintsOf(db, chat.id).length >= 2, "hints of the orphans");
      const hints = hintsOf(db, chat.id);
      assert.deepEqual(hints.map((h) => h.source), ["agent-orphaned", "agent-orphaned"], JSON.stringify(hints).slice(0, 400));
      assert.deepEqual(hints.map((h) => h.text.split(" — ")[0]).sort(), [`orphaned: ${V}`, `orphaned: ${L}`].sort(), "exactly one per running agent");
      assert.ok(!hints.some((h) => h.text.includes(F)), "the finished agent is not orphaned");
      assert.equal(rowOf(db, chat.id, V).state, "orphaned");
      assert.equal(rowOf(db, chat.id, F).state, "finished");
      // No run start: nobody drives, no turn, no line in the history — checked after QUIET, not after the hints: a turn that the
      // follow-up start did start would then be through and would stand in the inputs and in the history.
      const active = await waitForQuiet();
      assert.equal(active.busy, false, JSON.stringify(active));
      assert.equal(active.runs, 0);
      assert.deepEqual(active.agents || [], []);
      assert.equal(inputs(root).length, inputsPrior, "the idle chat stays idle — no turn after the restart");
      assert.equal((await json(`${base}/api/chats/${chat.id}/log`)).length, logPrior.length, "no new line in the history");

      // Turn 2 carries the hints (fenced, once) and continues V; W stays at the gate for the second crash.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("v2", "V", "go on"), { ...START("w1", "Work {GATE:w}."), saveAs: "W" }]) });
      const v2 = await result(waitForTruthy, root, "v2");
      assert.doesNotMatch(v2, /FEHLER/, v2.slice(0, 300));
      assert.match(v2, /"resumed": true/);
      const log = await waitForLog(chat.id, (l) => noticesOf(l, V).length === 1);
      assert.match(noticesOf(log, V)[0].text, /<result>Finding \(resumed sub-session-v: go on\)<\/result>/,
        "continued via the stored session, completion notice under the same agentId");
      await waitForTruthy(turnPast(base), "the completion notice turn is over");
      const all = inputs(root);
      const turn2 = all[inputsPrior];
      assert.match(turn2, /^\[cbase system notice/, "the hint stands before the input, fenced");
      assert.equal(turn2.split(`orphaned: ${V}`).length - 1, 1, "exactly once");
      assert.ok(all.slice(inputsPrior + 1).every((t) => !t.includes("orphaned:")), "never again afterwards");
      assert.deepEqual(hintsOf(db, chat.id), [], "consumed");

      // Second crash: only W is newly orphaned — L (orphaned, never continued) and V (continued, done) are not.
      await gate.reached("w");
      const W = idOf(root, "W");
      await waitForTruthy(() => rowOf(db, chat.id, W)?.session === "sub-session-w", "session of W stored");
      db.close();
      await crash();
      db = open();
      await waitForTruthy(() => hintsOf(db, chat.id).length >= 1, "hint after the second restart");
      assert.deepEqual(hintsOf(db, chat.id).map((h) => h.text.split(" — ")[0]), [`orphaned: ${W}`]);
      assert.equal(rowOf(db, chat.id, L).state, "orphaned");
      assert.equal(rowOf(db, chat.id, V).state, "finished");
    } finally {
      try { db.close(); } catch {}
      for (const t of ["v", "l", "w"]) gate.open(t);
    }
  }, { claude: fake, childProcess: true });
});

test("Codex: killed hard => orphaned; send continues via the stored thread (exec … resume)", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForTruthy, waitForLog, crash, db: open }) => {
    let db = open();
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("c1", "Work {GATE}.", { model: "codex::gpt-5.6-sol" }), saveAs: "C" }]) });
      await result(waitForTruthy, root, "c1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      const C = idOf(root, "C");
      await waitForTruthy(() => rowOf(db, chat.id, C)?.session === "codex-thread-7", "thread stored");
      db.close();
      await crash();
      db = open();
      await waitForTruthy(() => hintsOf(db, chat.id).some((h) => h.text.startsWith(`orphaned: ${C}`)), "Hint");
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("c2", "C", "Codex weiter")]) });
      assert.match(await result(waitForTruthy, root, "c2"), /"resumed": true/);
      const log = await waitForLog(chat.id, (l) => noticesOf(l, C).length === 1);
      assert.match(noticesOf(log, C)[0].text, /<result>Codex resumed: Codex weiter<\/result>/);
      const calls = readJsonl(path.join(root, "codex-calls"));
      assert.deepEqual(calls.map((a) => a.resume), ["", "codex-thread-7"], "the continuation runs on the stored thread");
    } finally {
      try { db.close(); } catch {}
      fs.writeFileSync(path.join(root, "gates", "codex"), "open");
    }
  }, { claude: fake, codex: CODEX, childProcess: true });
});

// The loop engine has no real resume: its stored history is the session. {E-HOLD} first calls a tool and then holds its second
// model request until the crash tears it off; the continuation must carry both — the task AND the tool result from before the
// crash.
let engineHolds = null;
const engine = {
  round: async (b) => {
    const everything = JSON.stringify(b.messages || []);
    if (everything.includes("Engine weiter")) return { text: "Engine fortgesetzt" };
    if (everything.includes("{E-HOLD}") && !(b.messages || []).some((m) => m.role === "tool")) {
      return { toolCalls: [{ id: "call_v1", name: "Read", arguments: { file_path: "/exists/es/not-orphaned.txt" } }] };
    }
    if (everything.includes("{E-HOLD}")) await new Promise((r) => { engineHolds = r; });
    return { text: "Engine-Finding" };
  },
};

test("Engine: killed hard => orphaned; send continues with the stored history (task and tool result from before the crash)", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForTruthy, waitForLog, crash, db: open, engine: e }) => {
    let db = open();
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("e1", "Work {E-HOLD}.", { model: e.model }), saveAs: "E" }]) });
      await result(waitForTruthy, root, "e1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      const E = idOf(root, "E");
      await waitForTruthy(() => engineHolds !== null, "the second request holds");
      await waitForTruthy(() => db.prepare("SELECT count(*) n FROM subagent_history WHERE chat_id = ? AND agent_id = ? AND role = 'tool_result'").get(chat.id, E).n === 1
        && rowOf(db, chat.id, E)?.session, "history and session stored");
      db.close();
      await crash();
      db = open();
      await waitForTruthy(() => hintsOf(db, chat.id).some((h) => h.text.startsWith(`orphaned: ${E}`)), "Hint");
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("e2", "E", "Engine weiter")]) });
      assert.match(await result(waitForTruthy, root, "e2"), /"resumed": true/);
      const log = await waitForLog(chat.id, (l) => noticesOf(l, E).length === 1);
      assert.match(noticesOf(log, E)[0].text, /<result>Engine fortgesetzt<\/result>/);
      const gone = e.requests.filter((a) => JSON.stringify(a.messages || []).includes("Engine weiter")).pop();
      const history = JSON.stringify(gone.messages);
      assert.match(history, /\{E-HOLD\}/, "the task from before the crash is in the history of the continuation");
      assert.match(history, /not-orphaned\.txt/, "the tool from before the crash too");
    } finally {
      try { db.close(); } catch {}
      // The held request stays open: its socket is gone with the crash, a write on it would have no reader.
    }
  }, { claude: fake, engine, childProcess: true });
});

test("Registration: the restart hook reports every running agent exactly once, a finished one never (in-process, via fireHooks)", async () => {
  await withAgentsServer(async ({ chat }) => {
    const image = (agentId, state) => ({ agentId, name: agentId, provider: "claude", model: "", sessionId: `s-${agentId}`, state, description: "Part" });
    store.rememberSubagent(chat.id, image("alauf0001-1", "running"));
    store.rememberSubagent(chat.id, image("apark0001-2", "parked"));
    store.rememberSubagent(chat.id, image("afert0001-3", "finished"));
    await fireHooks("restartGrace", {});
    const texts = () => store.openHints(chat.id).map((h) => `${h.source}|${h.text.split(" — ")[0]}`);
    assert.deepEqual(texts(), ["agent-orphaned|orphaned: alauf0001-1", "agent-orphaned|orphaned: apark0001-2"]);
    await fireHooks("restartGrace", {});
    assert.equal(texts().length, 2, "a second restart reports none twice");
    assert.deepEqual(store.subagentsOf(chat.id).map((a) => a.state), ["orphaned", "orphaned", "finished"]);
    store.deleteHints(store.openHints(chat.id).map((h) => h.id));
  });
});

test("Idle: an inactive core is closed, one with a living agent never; send takes the agent from the inventory again or honestly says why not", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog }) => {
    try {
      // Core 1: A finishes fast, C stays at the gate and is stopped by the HUMAN.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("a1", "Short."), saveAs: "A" }, { ...START("c1", "Work {GATE:c}."), saveAs: "C" }]) });
      await result(waitForTruthy, root, "c1");
      const [A, C] = ["A", "C"].map((n) => idOf(root, n));
      await waitForLog(chat.id, (l) => noticesOf(l, A).length === 1);
      await gate.reached("c");
      await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: C, from: "human" });
      await waitForTruthy(turnPast(base), "the turns are over");
      assert.ok(idleCount() >= 1, "the idle deadline of the inactive core runs");

      // Core 3: B lives at the gate.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("b1", "Work {GATE:b}."), saveAs: "B" }]) });
      await result(waitForTruthy, root, "b1");
      await waitForTruthy(turnPast(base), "turn with B is over");
      await gate.reached("b");
      const B = idOf(root, "B");

      assert.ok(idleNow() >= 1, "at least one inactive core closed");
      assert.equal(coreWithAgent(chat.id, A), null, "the core of A is gone");
      assert.equal(coreWithAgent(chat.id, B)?.alive(B), true, "the core of the living B is never cleaned up");

      // An inventory without a session (it ended before its provider reported one).
      store.rememberSubagent(chat.id, { agentId: "aohne0000-9", name: "without", provider: "claude", model: "", sessionId: "", state: "finished", status: "failed" });
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        SEND("a2", "A", "go on please"),
        SEND("c2", "C", "further"),
        { w: "cbase_agent_send", tag: "o2", args: { agentId: "aohne0000-9", message: "further" } },
      ]) });
      const a2 = await result(waitForTruthy, root, "a2");
      assert.match(a2, /"resumed": true/, a2.slice(0, 300));
      assert.match(await result(waitForTruthy, root, "c2"), /^FEHLER [^]*stopped by the human/);
      assert.match(await result(waitForTruthy, root, "o2"), /^FEHLER [^]*can no longer be continued/);
      const log = await waitForLog(chat.id, (l) => noticesOf(l, A).length === 2);
      assert.match(noticesOf(log, A)[1].text, /<result>Finding \(resumed sub-session-f: go on please\)<\/result>/);
      await waitForTruthy(turnPast(base), "the completion notice turn is over");
      gate.open("b");
      await waitForLog(chat.id, (l) => noticesOf(l, B).length === 1);
    } finally {
      for (const t of ["b", "c"]) gate.open(t);
    }
  }, { claude: fake });
});
