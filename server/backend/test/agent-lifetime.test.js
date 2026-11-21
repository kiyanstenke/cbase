// Subagents outlive the turn — the main seam with the agent harness: real server, real cbase MCP server, real routes, only the
// providers are faked.
//
// What holds here: in the coding chat a subagent without an argument runs in the background, the turn returns at once, and the
// completion notice (`<task-notification>`, runs/completionNotice.js) arrives through the ONE wake path (runs/queue.js
// deliverUserPrompt, cause "agent") — while a turn runs at the next tool boundary for Claude, as the next turn for Codex; if
// the chat is idle, as its own turn. `/stop` takes only the foreground agents along, the usage is booked at once, deleting ends
// everything silently.
//
// Counter-tests (each shown red once):
//   - `hold: true` as the default again (runs/hooks.js runKindDefault) => "Lifetime" sees run_waiting instead of run_done;
//   - deliverUserPrompt starts with `doRun` instead of `startRun` => "Safety net" counts an unhandled rejection;
//   - closeAgents without `leaveAlive` (the run end closes all) => "/stop" sees the background agent die;
//   - usage booked only through the turn again => "Usage at once" finds no row;
//   - `k.silence()` on closing removed => both "Delete" tests see a completion notice after the delete;
//   - the channel hook accepts cause "agent" (channels/delivery.js) => "Channel" counts a delivery for the completion notice;
//   - the routes only through `agentsOf` instead of `coreWithAgent` => "Follow-up" does not reach the agent of an older core;
//   - headerBundle bundles cause "agent" => "Codex" sees two completion notices in ONE turn;
//   - no injection mid-turn (runs/queue.js) => "Claude" does not find the completion notice at the tool boundary;
//   - in reportBackground (runs/agents.js) the call `tickSet` removed => "Tick without turn" finds no tick after run_done (0
//     instead of 1) — the state stayed at the number of run_done; the comparison with the last report removed => the same test
//     counts a report without a change.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { runKindDefault, registerRunKind } from "../electron/server/runs/hooks.js";
import { CAUSES, pendingRunInputs } from "../electron/server/runs/state.js";
import { liveAgents, tickNow, tickCount } from "../electron/server/runs/agents.js";
import { FINISHED_RESULT_MAX, completionNotice, isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";

// The SSE stream of a chat — we wait for the event, without a deadline.
async function openStream(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const events = [];
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* Teilzeile */ } }
          }
        }
      }
    } catch { /* abort on closing */ }
  })();
  return {
    events,
    wait: (p, what) => waitForTruthy(() => events.find(p) || null, what),
    async shutdown() { ac.abort(); await pump; },
  };
}

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const notices = (log) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text));
const liveIn = async (base, chatId) => (await json(`${base}/api/runs/active`)).agents.filter((a) => a.chatId === chatId);
const readOrEmpty = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// The subagent reports usage, waits at gate "sub" and reports. An input with "{SHORT}" reports without a gate.
const SUB = `
    say({ type: "assistant", message: { id: "sub-1", usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "Zwischenstand" }] } });
    if (!text.includes("{SHORT}")) await gate("sub");
    say({ type: "assistant", message: { id: "sub-2", content: [{ type: "text", text: "Finding 42" }] } });
    finished();
    say({ type: "result", result: "Finding 42", session_id: "sub-session" });`;

// The main agent: turn 1 starts a subagent with the arguments from the input (JSON after "ARGS:") — without run_in_background
// if there is none. It writes a completion notice to a file and answers briefly.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    fs.writeFileSync(path.join(LOCATION, "notice-" + turn), text);
    if (fs.existsSync(path.join(LOCATION, "gate-notice"))) await gate("notice");
    say({ type: "assistant", message: { id: "main-m" + turn, content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const m = /ARGS:(\\{.*\\})/.exec(text);
  const args = m ? JSON.parse(m[1]) : { description: "Aside", prompt: "Look." };
  say({ type: "assistant", message: { id: "main-1-" + turn, content: [{ type: "tool_use", id: "toolu_bg" + turn, name: "mcp__cbase__cbase_agent", input: args }] } });
  let t = "";
  try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
  fs.writeFileSync(path.join(LOCATION, "result-" + turn), t);
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg" + turn, content: t }] } });
  say({ type: "assistant", message: { id: "main-2-" + turn, content: [{ type: "text", text: "Turn " + turn + " fertig" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

test("The completion notice carries all fields, truncated to 8,000 characters, and is marked as a system notice", () => {
  const lang = "x".repeat(FINISHED_RESULT_MAX + 500);
  const t = completionNotice({ status: "completed", agentId: "a1", description: "Part <A>", report: lang, outputFile: "/o/a1.output",
    totalTokens: 16, tokenKind: "only_output", totalToolUseCount: 2, totalDurationMs: 30 }, { toolUseId: "toolu_x" });
  assert.ok(isCompletionNotice(t));
  for (const f of ["task-id", "tool-use-id", "output-file", "status", "name", "summary", "result", "diagnostics", "usage", "note"]) {
    assert.match(t, new RegExp(`<${f}[ >]`), `field ${f} is missing`);
  }
  assert.match(t, /<summary>Agent "Part &lt;A&gt;" completed<\/summary>/, "foreign text is defused");
  // The name in its own element — read from the summary it was ambiguous (see below, error text).
  assert.match(t, /<name>Part &lt;A&gt;<\/name>/, "the name is in <name>, defused like the summary");
  assert.ok(!t.includes("x".repeat(FINISHED_RESULT_MAX + 1)), "the result is truncated");
  assert.match(t, /truncated — the full report is in the output file/);
  assert.match(t, /<total_tokens kind="min.">16<\/total_tokens>/, "lower bound for providers without an input side");
  const f = completionNotice({ status: "failed", agentId: "a2", error: "Exit 1\nmore", report: "" });
  assert.match(f, /<status>failed<\/status>/);
  assert.match(f, /<summary>Agent "a2" failed: Exit 1<\/summary>/);
  assert.match(f, /<recovery>/, "failed: recovery instead of diagnostics");
  const q = completionNotice({ status: "failed", agentId: "a3", description: "Checker", error: 'Werkzeug "Bash" failed: exit 2' });
  assert.match(q, /<name>Checker<\/name>/, "the name stays unambiguous even if the error text carries \"…\" failed");
  assert.ok(CAUSES.has("agent"), "the cause \"agent\" is in the cause list");
});

test("Lifetime: the turn ends while the subagent lives; then the completion notice comes as its own turn", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForLog }) => {
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      await stream.wait((e) => e.subtype === "connected", "stream stands");
      await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
      await gate.reached("sub");
      // The turn ends — or waits (old state: the coding chat held its turn open for the agent).
      const end = await stream.wait((e) => e.subtype === "run_done" || e.subtype === "run_waiting", "turn end or wait phase");
      assert.equal(end.subtype, "run_done", "the turn no longer holds the subagent");
      assert.match(readOrEmpty(path.join(root, "result-1")), /"started": true/, "without an argument: background, the call returns at once");
      assert.equal((await liveIn(base, chat.id)).length, 1, "the subagent lives on after run_done");

      gate.open("sub");
      const log = await waitForLog(chat.id, (l) => notices(l).length === 1 && l.some((m) => m.role === "assistant" && m.text === "Notice read"));
      const t = notices(log)[0].text;
      assert.equal(readOrEmpty(path.join(root, "notice-1")), t, "the own turn (a new process) got exactly the notice as input");
      const agentId = /<task-id>([^<]+)<\/task-id>/.exec(t)?.[1];
      assert.ok(agentId, t);
      assert.match(t, /<tool-use-id>toolu_bg1<\/tool-use-id>/, "the call block of the start");
      const output = /<output-file>([^<]+)<\/output-file>/.exec(t)?.[1];
      assert.ok(output && fs.readFileSync(output, "utf8").includes("Finding 42"), "the output file is readable");
      assert.match(t, /<status>completed<\/status>/);
      assert.match(t, /<summary>Agent "Aside" completed<\/summary>/);
      assert.match(t, /<result>Finding 42<\/result>/);
      assert.match(t, /<diagnostics>[^]*cbase_agent_send[^]*<\/diagnostics>/);
      assert.match(t, /<usage><total_tokens[^>]*>\d+<\/total_tokens><tool_uses>\d+<\/tool_uses><duration_ms>\d+<\/duration_ms><\/usage>/);
      assert.match(t, /system notice/);
      const ev = await stream.wait((e) => e.subtype === "user_message" && isCompletionNotice(e.text), "completion notice in the stream");
      assert.equal(ev.systemNotice, true, "the event says explicitly: system notice");
      // The addendum to the call block (turn over): it no longer says "running".
      assert.ok(log.some((m) => m.role === "tool_result" && JSON.parse(m.text).id === "toolu_bg1" && /Finding 42/.test(JSON.parse(m.text).result)),
        "the call block carries the report");
    } finally {
      await stream.shutdown();
    }
  }, { claude: fake });
});

// The display of living agents comes from the OWNER, not from the running turn. Counter-test: in the connection event
// (chats/routes.js) the source again only runBackground/runWaiting => `agents` empty after run_done.
test("Display: after run_done the connection event carries the living agent, the background event its life and its end", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForLog }) => {
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    let late = null;
    try {
      await stream.wait((e) => e.subtype === "connected", "stream stands");
      await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
      await gate.reached("sub");
      await stream.wait((e) => e.subtype === "run_done", "turn end");
      const [live] = await liveIn(base, chat.id);
      assert.ok(live?.agentId, "the subagent lives after run_done");
      // After run_done the server reports the survivor once more (the clients keep it beyond run_done).
      const afterEnd = () => stream.events.slice(stream.events.findIndex((e) => e.subtype === "run_done"));
      await waitForTruthy(() => afterEnd().find((e) => e.subtype === "background" && e.agents?.some((a) => a.agentId === live.agentId)) || null,
        "background with the survivor after run_done");
      // Reload: a second stream, opened AFTER run_done.
      late = await openStream(`${base}/api/chats/${chat.id}/stream`);
      const hallo = await late.wait((e) => e.subtype === "connected", "connected after run_done");
      assert.equal(hallo.running, false, "no turn is running");
      const row = (hallo.agents || []).find((a) => a.agentId === live.agentId);
      assert.ok(row, `the living agent is in the connection event: ${JSON.stringify(hallo.agents)}`);
      assert.equal(row.status, "running");
      assert.equal(row.toolUseId, "toolu_bg1", "with its call block (merge with the history)");

      gate.open("sub");
      // Its end without a turn: a background event without it — otherwise it would stand there as running forever.
      await late.wait((e) => e.subtype === "background" && Array.isArray(e.agents) && !e.agents.some((a) => a.agentId === live.agentId),
        "background without the finished agent");
      await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice read"));
    } finally {
      await late?.shutdown();
      await stream.shutdown();
    }
  }, { claude: fake });
});

test("Foreground: run_in_background false waits in the call for the report — no completion notice", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForQuiet }) => {
    const args = { description: "Front", prompt: "Look {SHORT}.", run_in_background: false };
    await post(`${base}/api/chats/${chat.id}/message`, { text: `Foreground ARGS:${JSON.stringify(args)}` });
    await waitForQuiet();
    const t = readOrEmpty(path.join(root, "result-1"));
    assert.match(t, /"status": "completed"/, t.slice(0, 300));
    assert.match(t, /Finding 42/, "the report came in the call");
    assert.deepEqual(notices(await json(`${base}/api/chats/${chat.id}/log`)), [], "no second way");
  }, { claude: fake });
});

// ── Done mid-turn ─────────────────────────────────────────────────────────────────────────────────
// Claude: the main agent holds its turn open at a tool (gate "main"). Like the real CLI (measured at 2.1.280) it takes a message
// that arrives on stdin meanwhile, at its next tool boundary, into the SAME turn — one result.
const fakeLimit = fakeClaude({
  sub: SUB,
  main: `
  const args = { description: "Aside", prompt: "Look." };
  say({ type: "assistant", message: { id: "g-1", content: [{ type: "tool_use", id: "toolu_g", name: "mcp__cbase__cbase_agent", input: args }] } });
  const t = textOf(await mcpCall("cbase_agent", args));
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_g", content: t }] } });
  say({ type: "assistant", message: { id: "g-2", content: [{ type: "tool_use", id: "toolu_wait", name: "Bash", input: { command: "sleep" } }] } });
  await gate("main");
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wait", content: "ok" }] } });
  const arrived = anTheLimit().filter((x) => x.startsWith("<task-notification>")).length;
  say({ type: "assistant", message: { id: "g-3", content: [{ type: "text", text: "At the boundary: " + arrived } ] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

test("Done mid-turn (Claude): the completion notice arrives at the next tool boundary, in the same turn", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForLog, waitForQuiet }) => {
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Go" });
    await gate.reached("sub");
    await gate.reached("main");
    gate.open("sub");
    // Given into the running process — the line stands although the turn still hangs at the tool. We wait for
    // "delivered OR queued": the old way (only at the result) turns red that way instead of hanging.
    await waitForTruthy(async () => (notices(await json(`${base}/api/chats/${chat.id}/log`)).length === 1
      || (pendingRunInputs.get(chat.id) || []).some((e) => e.cause === "agent") ? true : null), "notice delivered or queued");
    assert.equal(notices(await json(`${base}/api/chats/${chat.id}/log`)).length, 1, "given into the running process, not queued");
    assert.equal((await json(`${base}/api/runs/active`)).runs, 1, "the turn is still running");
    gate.open("main");
    await waitForQuiet();
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.ok(log.some((m) => m.role === "assistant" && m.text === "At the boundary: 1"), "the notice arrived in the same turn");
    assert.equal(log.filter((m) => m.role === "meta" && !JSON.parse(m.text).compacted).length, 1, "ONE turn, no second");
    assert.equal(notices(log).length, 1);
  }, { claude: fakeLimit });
});

// Codex: a turn is a process; cbaseInject declines as long as it runs. The first turn waits at gate "codex1".
const codexWithGate = `#!/usr/bin/env node
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
fs.appendFileSync(path.join(LOCATION, "codex-prompts.jsonl"), JSON.stringify(argv[argv.length - 1]) + "\\n");
(async () => {
  say({ type: "thread.started", thread_id: "codex-thread" });
  say({ type: "turn.started" });
  if (ri < 0) {
    fs.writeFileSync(path.join(LOCATION, "gates", "codex1.waiting"), "1");
    while (!fs.existsSync(path.join(LOCATION, "gates", "codex1"))) await new Promise((r) => setTimeout(r, 20));
  }
  say({ type: "item.completed", item: { id: "a", type: "agent_message", text: ri < 0 ? "Erster Turn" : "Folge-Turn" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

test("Done mid-turn (Codex): the completion notice waits and goes as the next turn — alone", async () => {
  await withAgentsServer(async ({ base, ws, root, gate, waitForTruthy: wait, waitForQuiet }) => {
    const chat = await post(`${base}/api/chats`, { workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex-Lauf" }) });
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Go" });
    await gate.reached("codex1");
    const r = await post(`${base}/api/chats/${chat.id}/agent`, { description: "Aside", prompt: "Look.", model: "claude::claude-haiku-4-5-20251001", callId: "toolu_codex_agent" });
    assert.equal(r.background, true, JSON.stringify(r));
    await gate.reached("sub");
    gate.open("sub");
    // Queued, not injected: the turn runs.
    await wait(() => (pendingRunInputs.get(chat.id) || []).some((e) => e.cause === "agent"), "completion notice queued");
    assert.deepEqual(notices(await json(`${base}/api/chats/${chat.id}/log`)), [], "not yet delivered: the turn is running");
    // A user message behind it is NOT bundled with it.
    await post(`${base}/api/chats/${chat.id}/message`, { text: "And another question" });
    gate.open("codex1");
    await waitForQuiet();
    const prompts = readJsonl(path.join(root, "codex-prompts.jsonl")); // only completed lines (jsonl.mjs)
    const followUp = prompts.slice(1);
    assert.equal(followUp.length, 2, `two follow-up turns: ${JSON.stringify(followUp).slice(0, 400)}`);
    assert.ok(isCompletionNotice(followUp[0]), "first the completion notice, as its own turn");
    assert.ok(!followUp[0].includes("And another question"), "not bundled with the user message");
    assert.equal(followUp[1], "And another question");
  }, { claude: fake, codex: codexWithGate });
});

// A queued completion notice is a SYSTEM NOTICE — the clients lack the trash can on it, and the server rejects a discard with
// 409: discarded, the main agent would never get the report. An ordinary input can still be discarded. COUNTER-TEST: in
// runs/queue.js cancelRunInput the line `if (systemNotice(queue[idx])) return { status: 409 };` removed => 200, and the
// follow-up turn gets no notice.
test("Queue: a queued completion notice cannot be discarded (409) and is delivered — a user input can", async () => {
  await withAgentsServer(async ({ base, ws, root, gate, waitForTruthy: wait, waitForQuiet }) => {
    const chat = await post(`${base}/api/chats`, { workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex-Lauf" }) });
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Go" });
    await gate.reached("codex1");
    const r = await post(`${base}/api/chats/${chat.id}/agent`, { description: "Aside", prompt: "Look.", model: "claude::claude-haiku-4-5-20251001", callId: "toolu_codex_agent" });
    assert.equal(r.background, true, JSON.stringify(r));
    await gate.reached("sub");
    gate.open("sub");
    const entry = await wait(() => (pendingRunInputs.get(chat.id) || []).find((e) => e.cause === "agent") || null, "completion notice queued");
    const user = await post(`${base}/api/chats/${chat.id}/message`, { text: "Discard" });
    assert.ok(user.entryId, JSON.stringify(user));
    // What the strip gets: the entry carries the marking explicitly.
    const queue = user.queue.find((q) => q.id === entry.id);
    assert.equal(queue?.systemNotice, true, JSON.stringify(user.queue));
    assert.equal(queue.controllable, false, "a system notice does not carry \"steer\" along");
    const del = (id) => fetch(`${base}/api/chats/${chat.id}/message/queue/${id}`, { method: "DELETE", headers: { Connection: "close" } });
    const denied = await del(entry.id);
    assert.equal(denied.status, 409, "a system notice cannot be discarded");
    const body = await denied.json();
    assert.match(body.error, /Systemmeldung/);
    assert.ok(body.queue.some((q) => q.id === entry.id), "the entry stays in the queue");
    assert.equal((await del(user.entryId)).status, 200, "a user input can still be discarded");
    assert.deepEqual((pendingRunInputs.get(chat.id) || []).map((e) => e.id), [entry.id], "only the system notice stays");
    gate.open("codex1");
    await waitForQuiet();
    const prompts = readJsonl(path.join(root, "codex-prompts.jsonl")); // only completed lines (jsonl.mjs)
    const followUp = prompts.slice(1);
    assert.equal(followUp.length, 1, `exactly one follow-up turn: ${JSON.stringify(followUp).slice(0, 400)}`);
    assert.ok(isCompletionNotice(followUp[0]), "the completion notice was delivered");
    assert.ok(!followUp.some((f) => f.includes("Discard")), "the discarded user input not");
  }, { claude: fake, codex: codexWithGate });
});

// A turn that THROWS while a background agent of an earlier turn lives. The finally reports the survivors, then `run_error`
// comes from the catcher (startRun) — and `run_error` empties the whole background state in web (backgroundAfter) and iOS
// (clearWaitState). Hence the server reports the survivors once more AFTER the error. COUNTER-TEST: in runs/do-run.js startRun
// the line `try { if (liveRows(chat.id).length) reportBackground(chat.id); } catch {}` removed => no `background` after
// `run_error` before the end of the agent => red. The sequence is checked only AFTER the end of the agent (its end event closes
// the window) — so the counter-test turns red instead of waiting for an event that never comes.
test("Error with survivors: after run_error the server reports the living background agent once more", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForQuiet }) => {
    let userTurns = 0; // the SECOND user turn throws (the preparation sees only the cause, not the text)
    registerRunKind(`test-survivors-${chat.id}`, (c, { cause }) => {
      if (cause === "user" && ++userTurns === 2) throw new Error("preparation broken");
      return runKindDefault(c);
    }, { detects: (c) => c.id === chat.id });
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      await stream.wait((e) => e.subtype === "connected", "stream stands");
      await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
      await gate.reached("sub");
      await stream.wait((e) => e.subtype === "run_done", "turn end");
      const [live] = await liveIn(base, chat.id);
      assert.ok(live?.agentId, "the subagent lives after run_done");
      await post(`${base}/api/chats/${chat.id}/message`, { text: "BROKEN" });
      await stream.wait((e) => e.subtype === "run_error", "run_error of the second turn");
      // Only now does the agent end — its end (a `background` without it) closes the window in which the re-report must
      // stand. That way the counter-test turns red instead of hanging.
      gate.open("sub");
      await stream.wait((e) => e.subtype === "user_message" && isCompletionNotice(e.text), "CompletionNotice");
      const from = stream.events.findIndex((e) => e.subtype === "run_error");
      const after = stream.events.slice(from + 1);
      const end = after.findIndex((e) => e.subtype === "background" && Array.isArray(e.agents) && !e.agents.some((a) => a.agentId === live.agentId));
      assert.ok(end >= 0, "the end of the agent came as background without it");
      const again = after.slice(0, end).find((e) => e.subtype === "background" && e.agents?.some((a) => a.agentId === live.agentId));
      assert.ok(again, `after run_error the server reports the survivor once more: ${JSON.stringify(after.slice(0, end + 1).map((e) => e.subtype))}`);
      assert.equal(again.agents.find((a) => a.agentId === live.agentId).status, "running");
    } finally {
      await stream.shutdown();
    }
    await waitForQuiet();
  }, { claude: fake });
});

// ── Safety net ──────────────────────────────────────────────────────────────────────────────────
// A run kind whose preparation throws at the completion notice (cause "agent" — so it sees it, not "user"): the completion
// notice turn starts through startRun, the error becomes an error row in the chat, the server lives on.
test("Safety net: a preparation that throws at the cause \"agent\" becomes run_error — no unhandled rejection", async () => {
  const rejections = [];
  const count = (e) => rejections.push(String(e?.message || e));
  process.on("unhandledRejection", count);
  try {
    await withAgentsServer(async ({ base, chat, gate, waitForQuiet }) => {
      const seen = [];
      registerRunKind(`test-safety-net-${chat.id}`, (c, { cause }) => {
        seen.push(cause);
        if (cause === "agent") throw new Error("Vorbereitung broken (Test)");
        return runKindDefault(c);
      }, { detects: (c) => c.id === chat.id });
      const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
      try {
        await stream.wait((e) => e.subtype === "connected", "stream stands");
        await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
        await gate.reached("sub");
        await stream.wait((e) => e.subtype === "run_done", "turn end");
        gate.open("sub");
        const error = await stream.wait((e) => e.subtype === "run_error", "error row of the completion notice turn");
        assert.match(error.stderr, /Vorbereitung broken/);
      } finally {
        await stream.shutdown();
      }
      await waitForQuiet();
      assert.deepEqual(seen, ["user", "agent"], "the completion notice comes with its own cause, not as \"user\"");
      assert.equal((await json(`${base}/api/health`)).ok, true, "the server lives");
    }, { claude: fake });
  } finally {
    process.off("unhandledRejection", count);
  }
  assert.deepEqual(rejections, [], "no unhandled rejection");
});

// ── /stop ───────────────────────────────────────────────────────────────────────────────────────
// The main agent starts a background agent (it asks for an approval) and then a foreground agent that waits at gate "vg" —
// the call holds the turn. `/stop` ends turn and foreground; the background agent lives, its card stays open, and after the
// approval it reports as its own turn.
const approval = (command) => `await mcpCall("cbase_permission_prompt", { tool_name: "Bash", input: { command: ${JSON.stringify(command)} } }, null)`;
const fakeStop = fakeClaude({
  sub: `
  if (text.includes("{CARD}")) {
    let d = null;
    try { d = JSON.parse((${approval("background")}).result.content[0].text); } catch {}
    say({ type: "assistant", message: { id: "sub-k", content: [{ type: "text", text: "Card: " + (d && d.behavior) }] } });
    finished();
    say({ type: "result", result: "Card: " + (d && d.behavior), session_id: "sub-session" });
    return;
  }
  await gate("vg");
  finished();
  say({ type: "result", result: "Foreground done", session_id: "sub-session" });`,
  main: `
  if (text.startsWith("<task-notification>")) {
    fs.writeFileSync(path.join(LOCATION, "notice-stop"), text);
    say({ type: "assistant", message: { id: "main-m", content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  for (const [id, args] of [["toolu_h", { description: "Background", prompt: "{CARD}" }], ["toolu_v", { description: "Foreground", prompt: "Wait.", run_in_background: false }]]) {
    say({ type: "assistant", message: { id: "main-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "FEHLER " + e.message; }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

test("/stop ends turn and foreground agents — the background agent lives, its card stays, it reports afterwards", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy: wait, waitForLog, waitForQuiet }) => {
    // Asking mode: under bypassPermissions no run is offered cbase_permission_prompt (the real CLI never asks there).
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ permissionMode: "default" }) });
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Two agents" });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "approval" && JSON.parse(m.text).input?.command === "background"));
    const rid = JSON.parse(log.find((m) => m.role === "approval").text).requestId;
    await gate.reached("vg");
    assert.equal((await liveIn(base, chat.id)).length, 2);

    await post(`${base}/api/chats/${chat.id}/stop`, {});
    await wait(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn ended");
    // The rows of all open cores of the chat (the query of open background work carries no description).
    const live = await wait(() => {
      const l = liveAgents().filter((a) => a.chatId === chat.id && a.status === "running");
      return l.every((a) => a.description === "Background") ? l : null;
    }, "foreground agent gone");
    const afterStop = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(live.map((a) => a.description), ["Background"],
      `the background agent lives on after /stop: ${JSON.stringify(afterStop.slice(-8).map((m) => [m.role, String(m.text).slice(0, 160)]))}`);
    assert.equal(afterStop.some((m) => m.role === "approval_ruling" && JSON.parse(m.text).requestId === rid), false, "its card is not rejected");

    const d = await post(`${base}/api/chats/${chat.id}/permission-decision`, { requestId: rid, behavior: "allow" });
    assert.equal(d.ok, true, "the card was still open after /stop");
    const notice = await wait(() => readOrEmpty(path.join(root, "notice-stop")) || null, "completion notice of the background agent");
    assert.match(notice, /<summary>Agent "Background" completed<\/summary>/);
    assert.match(notice, /Card: allow/);
    await waitForQuiet();
    const end = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(notices(end).length, 1, "exactly one completion notice — that of the background agent");
  }, { claude: fakeStop });
});

// ── Usage at once ───────────────────────────────────────────────────────────────────────────────
// The usage row of the agent stands while the completion notice turn still hangs at gate "notice" — so before any turn after
// its end is done.
const subRows = (chatId) => db.prepare("SELECT provider, input, output, billing, kind FROM usage_events WHERE chat_id = ? AND kind = 'sub'").all(chatId);
test("Usage at once: the row of the background agent stands without a turn after its end having finished", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForQuiet }) => {
    fs.writeFileSync(path.join(root, "gate-notice"), "1");
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
    await gate.reached("sub");
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn end");
    assert.deepEqual(subRows(chat.id), [], "before the end of the agent there is no row");
    gate.open("sub");
    await gate.reached("notice");
    const rows = subRows(chat.id);
    assert.equal(rows.length, 1, `exactly one row, booked at the end of the agent: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].provider, "claude");
    assert.ok(rows[0].input + rows[0].output > 0, JSON.stringify(rows[0]));
    gate.open("notice");
    await waitForQuiet();
    assert.equal(subRows(chat.id).length, 1, "and not a second time after the turn");
  }, { claude: fake });
});

// ── Delete ──────────────────────────────────────────────────────────────────────────────────────
const livePids = (root) => fs.readdirSync(path.join(root, "pids")).filter((n) => /^\d+$/.test(n)).map(Number).filter((pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
});
for (const what of ["Chat", "Workspace"]) {
  test(`Delete (${what}) ends the living background agent: no process, no completion notice, its usage stays booked`, async () => {
    await withAgentsServer(async ({ base, ws, chat, root, gate }) => {
      await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
      await gate.reached("sub");
      await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn end");
      assert.equal((await liveIn(base, chat.id)).length, 1);
      const url = what === "Chat" ? `${base}/api/chats/${chat.id}` : `${base}/api/workspaces/${ws.id}`;
      const res = await fetch(url, { method: "DELETE", headers: { Connection: "close" } });
      assert.equal(res.status, 200, await res.text());
      await waitForTruthy(() => (livePids(root).length === 0 ? true : null), "all fake processes ended");
      gate.open("sub"); // a survivor would now run on — there is none
      assert.deepEqual((await json(`${base}/api/runs/active`)).agents, []);
      assert.equal(pendingRunInputs.has(chat.id), false, "no completion notice queued");
      // Since the review of "providers and usage": silent means "no notice", not "no booking" — paid tokens of a deleted chat
      // are in the usage (row "deleted"), exactly once.
      assert.deepEqual(subRows(chat.id).map((z) => [z.input, z.output]), [[11, 5]], "its usage is booked, exactly once");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(chat.id).n, 0, "no row, no notice either");
    }, { claude: fake });
  });
}

// ── Channel cap ─────────────────────────────────────────────────────────────────────────────────
// A completion notice is no human participation: the counter of agent rounds of a channel (cap 8) stays put. The counter-test
// in the same test: a user message resets it.
test("Channel: a completion notice does not reset the cap counter — a user message does", async () => {
  await withAgentsServer(async ({ base, ws, chat, gate, waitForLog, waitForQuiet }) => {
    const other = await post(`${base}/api/chats`, { workspaceId: ws.id, provider: "claude", model: "claude-sonnet-5", permissionMode: "bypassPermissions" });
    const channel = store.createChannel({ id: `channel-${chat.id}`, workspaceId: ws.id, name: "Test", cap: 8 });
    store.addChannelParticipants(channel.id, { chatId: chat.id });
    store.addChannelParticipants(channel.id, { chatId: other.id });
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
    await gate.reached("sub");
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "turn end");
    store.updateChannel(channel.id, { agentsSinceHuman: 7 }); // seven agent rounds without the human
    gate.open("sub");
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice read"));
    await waitForQuiet();
    assert.equal(store.getChannel(channel.id).agentsSinceHuman, 7, "the completion notice does not count as human input");
    const short = JSON.stringify({ description: "Short", prompt: "{SHORT}", run_in_background: false });
    await post(`${base}/api/chats/${chat.id}/message`, { text: `One more ARGS:${short}` });
    await waitForQuiet();
    assert.equal(store.getChannel(channel.id).agentsSinceHuman, 0, "counter-test: the user message resets");
  }, { claude: fake });
});

// ── A later turn reaches the agent ──────────────────────────────────────────────────────────────
// The completion notice names cbase_agent_send: the core of a past turn stays open until a later turn ends — in the completion
// notice turn the main agent continues the same agent.
const fakeInquiry = fakeClaude({
  sub: `
    const counter = path.join(LOCATION, "sub-counter");
    const nr = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
    fs.writeFileSync(counter, String(nr));
    finished();
    say({ type: "result", result: "Answer " + nr + (arg("--resume") ? " (resumed)" : ""), session_id: "sub-session" });`,
  main: `
  if (text.startsWith("<task-notification>")) {
    const agentId = /<task-id>([^<]+)</.exec(text)[1];
    if (text.includes("Answer 1")) {
      let t = "";
      try { t = textOf(await mcpCall("cbase_agent_send", { agentId, message: "And further?" })); } catch (e) { t = "FEHLER " + e.message; }
      fs.writeFileSync(path.join(LOCATION, "send-result"), t);
    }
    finished();
    say({ type: "result", result: "ok", session_id: "main-session" });
    return;
  }
  const args = { description: "Aside", prompt: "Look." };
  say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_n", name: "mcp__cbase__cbase_agent", input: args }] } });
  const t = textOf(await mcpCall("cbase_agent", args));
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_n", content: t }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

test("Follow-up in the completion notice turn: cbase_agent_send reaches the agent of a past turn", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForTruthy: wait, waitForQuiet }) => {
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
    const t = await wait(() => readOrEmpty(path.join(root, "send-result")) || null, "result of the follow-up");
    assert.doesNotMatch(t, /FEHLER|Unknown subagent/, t);
    // In the background: the call returns at once, the answer arrives as a second completion notice.
    assert.match(t, /"resumed": true/, t);
    const agentId = JSON.parse(t).agentId;
    const log = await wait(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return l.filter((m) => m.role === "user" && m.text.includes(`<task-id>${agentId}</task-id>`)).length === 2 ? l : null;
    }, "second completion notice");
    const second = log.filter((m) => m.role === "user" && m.text.includes(`<task-id>${agentId}</task-id>`))[1].text;
    assert.match(second, /Answer 2 \(resumed\)/, "the same agent, with its session");
    await waitForQuiet();
  }, { claude: fakeInquiry });
});

// ── Tick without turn ─────────────────────────────────────────────────────────────────────────────────────────────
// The tick of the turn ends with the turn; the background agent that outlives it reported no number afterwards until it was
// done (web test stand: bar "≥0", no pace). Now the OWNER ticks. Without a clock: the knob stands at an hour, the test beats
// itself (tickNow, pattern wakeParkedNow) and waits for the event, never for a duration.
const fakeTick = fakeClaude({
  sub: `
    say({ type: "assistant", message: { id: "sub-t1", usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "First state" }] } });
    await gate("tick-a");
    say({ type: "assistant", message: { id: "sub-t2", usage: { input_tokens: 40, output_tokens: 20 }, content: [{ type: "text", text: "Second state" }] } });
    await gate("tick-b");
    finished();
    say({ type: "result", result: "Finding 42", session_id: "sub-session" });`,
  main: MAIN,
});

test("Tick without turn: after run_done the owner reports the growing tokens of a background agent — only on change, and it ends with it", async () => {
  const prior = process.env.CBASE_AGENT_TICK_MS;
  process.env.CBASE_AGENT_TICK_MS = String(3_600_000); // no beat by itself — only tickNow()
  try {
    await withAgentsServer(async ({ base, chat, gate, waitForLog }) => {
      const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
      try {
        await stream.wait((e) => e.subtype === "connected", "stream stands");
        await post(`${base}/api/chats/${chat.id}/message`, { text: "Start an agent" });
        await gate.reached("tick-a");
        await stream.wait((e) => e.subtype === "run_done", "turn end");
        const token = async () => ((await json(`${base}/api/chats/${chat.id}/agents`)).agents || []).find((a) => a.status === "running")?.tokens || 0;
        // What stood about it in the stream after run_done — the display of the clients.
        const afterEnd = () => stream.events.slice(stream.events.findIndex((e) => e.subtype === "run_done"));
        const reported = (n) => afterEnd().find((e) => e.subtype === "background" && e.agents?.some((a) => a.tokens === n)) || null;

        const t1 = await waitForTruthy(async () => (await token()) || null, "the server knows the first usage");
        // The synchronous statement first: without a tick the following would wait for an event that never comes (a hang instead of red).
        assert.equal(tickCount(), 1, "a tick stands as long as the agent lives without a turn");
        tickNow(); // the state of run_done may already carry it — then the beat reports nothing
        await waitForTruthy(() => reported(t1), "the first state stands in the stream after run_done");
        assert.equal(tickNow(), 0, "nothing changed => no report (two equal measuring points are worthless for a pace)");

        gate.open("tick-a");
        await gate.reached("tick-b");
        const t2 = await waitForTruthy(async () => { const n = await token(); return n > t1 ? n : null; }, "the server knows the second usage");
        const n = tickNow();
        console.log(`# tick without turn: ${t1} → ${t2} tokens, ${n} report(s) in the beat`);
        assert.equal(n, 1, "the beat reports the grown state — without a running turn");
        const ev = await waitForTruthy(() => reported(t2), "the second state stands in the stream");
        assert.deepEqual(ev.monitors, [], "without a turn: no monitor, no command, no alarm");
        assert.equal((await json(`${base}/api/runs/active`)).runs, 0, "and really no turn is running");

        gate.open("tick-b");
        await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice read"));
        assert.equal(tickCount(), 0, "the tick ends with the last agent without a turn");
      } finally {
        await stream.shutdown();
      }
    }, { claude: fakeTick });
  } finally {
    if (prior === undefined) delete process.env.CBASE_AGENT_TICK_MS;
    else process.env.CBASE_AGENT_TICK_MS = prior;
  }
});
