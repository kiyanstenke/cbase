// A foreground agent switches to the background after 240 s — main seam with the harness: real server, real cbase MCP
// server, real routes, only the providers are faked.
//
// What holds here: a foreground subagent (`run_in_background: false`) blocks its tool call for at most the deadline
// (default 240 s, below the ≈ 300 s abort of a waiting MCP request; the number is in the diagnostic line of
// native-agent.test.js). After that — or at once on the "Move to background" button — the call returns with "Continues
// in the background" plus agentId, the agent is an ordinary background agent from then on (survives `/stop` and the end
// of the turn, counts in `busy` and in the archive reason), and its end arrives as a completion notice. `wait_ms` has
// no effect any more and is not rejected.
//
// The deadline is COUNTED, not waited for: `foregroundDeadlinesNow()` lets every open deadline expire now (pattern
// `wakeParkedNow`). The subagent waits at its gate until the test releases it — the order is enforced.
//
// Counter-tests (each shown red once):
//   - `inForeground` in start() replaced by the old waiting without a deadline (`waitFor(rec, DEFAULT_WAIT_MS)`) =>
//     "Deadline" red: the seam finds no deadline, the call blocks until the agent ends and brings its report;
//   - the switch without `rec.background = true` => "Deadline" red: the row keeps carrying `foreground` (and `/stop`
//     would take it along);
//   - the route without the agentId check => "Button" red (200 instead of 400).
// Under the first counter-test "Button" and "send" HANG (the button finds no waiting call it could release) — so it is
// run with the pattern "^Deadline".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { foregroundDeadlinesNow } from "../electron/server/providers/agent-runtime.js";
import { liveAgents } from "../electron/server/runs/agents.js";
import { backgroundWork } from "../electron/server/runs/background.js";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";

// The subagent reports an interim state, waits at gate "sub" and reports. An input with "{SHORT}" reports without a gate.
const SUB = `
    say({ type: "assistant", message: { id: "sub-1", usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "Interim state" }] } });
    if (!text.includes("{SHORT}")) await gate("sub");
    say({ type: "assistant", message: { id: "sub-2", content: [{ type: "text", text: "Finding 42" }] } });
    finished();
    say({ type: "result", result: "Finding 42", session_id: "sub-session" });`;

// The main agent runs the calls from "OPS:[…]" in order (one tool block each, result to
// `result-<turn>-<i>`); `previous: true` inserts the agentId of the previous result. With "HOLD" in the input it then
// waits at gate "main" (the turn runs). It writes a completion notice to `notice-<turn>`.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    fs.writeFileSync(path.join(LOCATION, "notice-" + turn), text);
    say({ type: "assistant", message: { id: "main-m" + turn, content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const ops = JSON.parse(/OPS:(\\[.*\\])/.exec(text)[1]);
  let previous = "";
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const args = { ...op.args, ...(op.previous ? { agentId: previous } : {}) };
    const id = "toolu_v" + turn + "_" + i;
    say({ type: "assistant", message: { id: "main-" + turn + "-" + i, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall(op.w, args)); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    try { previous = JSON.parse(t).agentId || previous; } catch {}
    fs.writeFileSync(path.join(LOCATION, "result-" + turn + "-" + i), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  if (text.includes("HOLD")) await gate("main");
  say({ type: "assistant", message: { id: "main-e" + turn, content: [{ type: "text", text: "Turn " + turn + " done" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
// Status AND body — for the error cases of the route.
async function raw(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const notices = (log) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text));
const liveIn = async (base, chatId) => (await json(`${base}/api/runs/active`)).agents.filter((a) => a.chatId === chatId);
// The rows that web and iOS read (SSE `background`, runs/agents.js rows) — only there the `foreground` marker appears.
const rowsOf = (chatId) => liveAgents().filter((a) => a.chatId === chatId);
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops, hold = false) => `Go ${hold ? "HOLD " : ""}OPS:${JSON.stringify(ops)}`;
const FRONT = { w: "cbase_agent", args: { description: "Front", prompt: "Look.", run_in_background: false } };

test("Deadline: the foreground call returns with \"Continues in the background\"; the agent survives /stop, counts in busy and in the archive reason, its end is a completion notice", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog }) => {
    try {
      // An inventory call with `wait_ms` (formerly: "still running" after 1 ms) — it has no effect any more and is not rejected.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...FRONT, args: { ...FRONT.args, wait_ms: 1 } }], true) });
      await gate.reached("sub");
      const prior = rowsOf(chat.id);
      assert.equal(prior.length, 1, JSON.stringify(prior));
      assert.equal(prior[0].foreground, true, "the row of a foreground agent carries the marker (button in web and iOS)");
      assert.equal(read(root, "result-1-0"), "", "the call waits — wait_ms: 1 has no effect");

      assert.equal(foregroundDeadlinesNow(), 1, "exactly one open foreground deadline");
      await gate.reached("main");
      const t = read(root, "result-1-0");
      const agentId = prior[0].agentId;
      assert.match(t, new RegExp(`Continues in the background \\(agentId \\\\"${agentId}\\\\"\\)`), t.slice(0, 400));
      assert.match(t, /"intoTheBackground": "deadline"/);
      assert.match(t, /"status": "running"/, "the agent's report did NOT come in the call");
      // The row is built from the core on every report — the marker drops in the same move as the switch.
      assert.deepEqual(rowsOf(chat.id).map((a) => [a.agentId, a.foreground]), [[agentId, undefined]], "the marker drops with the switch");

      // /stop: the turn ends with its FOREGROUND agents — the switched one is none any more.
      await post(`${base}/api/chats/${chat.id}/stop`, {});
      await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "the turn is stopped");
      const active = await json(`${base}/api/runs/active`);
      assert.equal(active.busy, true, "a living background agent holds busy");
      assert.deepEqual((await liveIn(base, chat.id)).map((a) => a.agentId), [agentId], "it survives /stop");
      assert.deepEqual(backgroundWork(chat.id).map((a) => a.agentId), [agentId], "it counts in the archive reason");

      gate.open("sub");
      const log = await waitForLog(chat.id, (l) => notices(l).length === 1 && l.some((m) => m.role === "assistant" && m.text === "Notice read"));
      const notice = notices(log)[0].text;
      assert.match(notice, new RegExp(`<task-id>${agentId}</task-id>`));
      assert.match(notice, /<status>completed<\/status>/);
      assert.match(notice, /<result>Finding 42<\/result>/);
    } finally {
      gate.open("sub");
      gate.open("main");
    }
  }, { claude: fake });
});

test("Button \"Move to background\": at once, the waiting call returns, the chat is free; without agentId 400", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog }) => {
    try {
      assert.equal((await raw(`${base}/api/chats/${chat.id}/agent/background`, { agentId: "a-x" })).status, 409, "no agent without a core");
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([FRONT], true) });
      await gate.reached("sub");
      const [row] = rowsOf(chat.id);
      assert.equal(row?.foreground, true);
      for (const body of [{}, { agentId: "" }, { agentId: 7 }, { task_id: row.agentId }]) {
        const r = await raw(`${base}/api/chats/${chat.id}/agent/background`, body);
        assert.equal(r.status, 400, `${JSON.stringify(body)} ⇒ ${r.status}`);
      }
      const r = await raw(`${base}/api/chats/${chat.id}/agent/background`, { agentId: row.agentId });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, agentId: row.agentId, background: true });
      await gate.reached("main");
      const t = read(root, "result-1-0");
      assert.match(t, /Continues in the background/, t.slice(0, 400));
      assert.match(t, /"intoTheBackground": "human"/);
      assert.equal(foregroundDeadlinesNow(), 0, "with the button the deadline is gone");

      // The ordinary end of the turn lets it live.
      gate.open("main");
      await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "the turn is over");
      assert.equal((await liveIn(base, chat.id)).length, 1, "it survives the end of the turn");
      const unknown = await raw(`${base}/api/chats/${chat.id}/agent/background`, { agentId: "exists-not" });
      assert.deepEqual([unknown.status, unknown.body.ok], [200, false]);

      gate.open("sub");
      await waitForLog(chat.id, (l) => notices(l).length === 1 && l.some((m) => m.role === "assistant" && m.text === "Notice read"));
    } finally {
      gate.open("sub");
      gate.open("main");
    }
  }, { claude: fake });
});

// The continuation of a finished foreground agent ALWAYS runs in the background, as in Claude Code — the call returns
// at once (no deadline), the answer arrives as a completion notice under the same id. Counter-test: `inForeground`
// back in send => red.
test("cbase_agent_send to a finished foreground agent returns at once; the answer is a completion notice under the same id", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog }) => {
    try {
      const ops = [
        { w: "cbase_agent", args: { description: "Short", prompt: "Look {SHORT}.", run_in_background: false } },
        { w: "cbase_agent_send", args: { message: "Also check the tests.", run_in_background: false, wait_ms: 1 }, previous: true },
      ];
      await post(`${base}/api/chats/${chat.id}/message`, { text: job(ops, true) });
      // If send did wait (old rule), the main agent would never stand at the gate: then the deadline expires NOW — only after the
      // first call has returned, so only that of send — and the check below turns red instead of hanging.
      let deadlineOfSend = 0;
      await waitForTruthy(() => fs.existsSync(path.join(root, "gates", "main.waiting"))
        || (read(root, "result-1-0") && (deadlineOfSend += foregroundDeadlinesNow()) > 0));
      assert.equal(deadlineOfSend, 0, "send had no foreground deadline");
      await gate.reached("main");
      assert.match(read(root, "result-1-0"), /"status": "completed"/, "the short foreground agent reports in the call");
      const agentId = JSON.parse(read(root, "result-1-0")).agentId;
      const t = read(root, "result-1-1");
      assert.match(t, /"resumed": true/, t.slice(0, 400));
      assert.match(t, /"background": true/);
      assert.equal(foregroundDeadlinesNow(), 0, "no deadline: the call did not wait");
      gate.open("main");
      gate.open("sub");
      const log = await waitForLog(chat.id, (l) => notices(l).length === 1 && l.some((m) => m.role === "assistant" && m.text === "Notice read"));
      assert.match(notices(log)[0].text, new RegExp(`<task-id>${agentId}</task-id>`));
      assert.match(notices(log)[0].text, /<result>Finding 42<\/result>/);
    } finally {
      gate.open("sub");
      gate.open("main");
    }
  }, { claude: fake });
});
