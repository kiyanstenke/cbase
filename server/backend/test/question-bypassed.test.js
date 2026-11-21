// A question card that closes without a choice must be KNOWN to the agent.
//
// The case: the agent asks cbase_ask; the user's queued message ("sort the agenda") goes into the SAME process at the `result`.
// It closes the card (runs/ask.js openAskOf — any message of the human afterwards), the UI shows "bypassed", no longer
// clickable. The agent got only the text and kept writing "the card is at the top of the chat".
//
// COUNTER-TEST: with the pre-fix state, both passes below are red — the input of the second turn carries no notice, the silent
// notice after dismissAsk is missing, the description of cbase_ask is silent.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// Without a deadline (no clock at which a test turns red); every 30 s stderr says what is waited for.
async function waitForLog(base, chatId, predicate) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const log = await json(`${base}/api/chats/${chatId}/log`);
    if (predicate(log)) return log;
    const sec = Math.floor((Date.now() - start) / 30_000);
    if (sec > reported) { reported = sec; console.error(`[waiting] for ${sec * 30} s: history ${chatId} — last ${JSON.stringify(log).slice(-400)}`); }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function shortWaitForQuiet(base) {
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const QUESTION = "Create the issue \"PUT sets status unchecked\" like this?";
const HINT = "Your question card is closed";
const belongs = (rows) => rows.find((r) => r.role === "assistant" && r.text.startsWith("BELONGS:"));
const pidOf = (text) => /pid=(\d+)/.exec(text)?.[1];
const provided = (rows) => rows.find((r) => r.role === "assistant" && r.text.startsWith("Question asked (201)"));

// The fake CLI reads stdin SERIALLY like the real one. "§ASK§" asks the question through the real route (like the MCP server);
// with "§WAIT§" it then holds at the gate (one file per chat) until the test has queued the second message — so that one goes
// into the same process at the `result`, as in the real case. Any other input comes back verbatim as "BELONGS: …".
function writeFake(bin, base, gate) {
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const BASE = ${JSON.stringify(base)};
const GATE = ${JSON.stringify(gate)};
const say = (text, chat) => {
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
  console.log(JSON.stringify({ type: "result", result: text, session_id: "s-" + chat }));
};
let chat = "";
const lines = [];
let busy = false;
const rl = readline.createInterface({ input: process.stdin });
async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const c = msg.message && msg.message.content;
  const text = typeof c === "string" ? c : (Array.isArray(c) && c[0] && c[0].text) || "";
  const m = /CHAT=([0-9a-f-]{36})/.exec(text);
  if (m) chat = m[1];
  if (text.includes("§ASK§")) {
    const res = await fetch(BASE + "/api/chats/" + chat + "/ask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: [{ header: "Issue", question: ${JSON.stringify(QUESTION)},
        options: [{ label: "Create as is (recommended)" }, { label: "Change first" }] }] }),
    });
    if (text.includes("§WAIT§")) while (!fs.existsSync(GATE + "/" + chat)) await new Promise((r) => setTimeout(r, 20));
    say("Question asked (" + res.status + ") pid=" + process.pid, chat);
    return;
  }
  say("BELONGS: pid=" + process.pid + " " + text, chat);
}
rl.on("line", (line) => { lines.push(line); pump(); });
async function pump() {
  if (busy) return;
  busy = true;
  while (lines.length) await handle(lines.shift());
  busy = false;
}
`);
  fs.chmodSync(bin, 0o755);
}

test("question bypassed: the agent learns it in the turn of the message — at the `result` in the same process and as a new run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ask-bypassed-"));
  const bin = path.join(root, "fake-claude");
  const gate = path.join(root, "gate");
  fs.mkdirSync(gate);
  const previousBin = process.env.CLAUDE_BIN;
  let server;
  let base = "";
  let ok = false;
  try {
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    writeFake(bin, base, gate);
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Ask-Bypassed", path: wsPath }) });
    const newChat = () => json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    const { openAskOf } = await import("../electron/server/runs/ask.js");
    const store = await import("../electron/server/store.js");

    // 1. The second message waits queued and goes into the same process at the `result` (injectNextRunInput).
    const a = await newChat();
    await json(`${base}/api/chats/${a.id}/message`, { method: "POST", body: JSON.stringify({ text: `§ASK§ §WAIT§ CHAT=${a.id} Review running.` }) });
    await waitForLog(base, a.id, (rows) => rows.some((r) => r.role === "ask"));
    const queued = await json(`${base}/api/chats/${a.id}/message`, { method: "POST", body: JSON.stringify({ text: "Can you sort the agenda, please?" }) });
    assert.equal(queued.queued, true, `the message must be queued while the turn runs: ${JSON.stringify(queued)}`);
    fs.writeFileSync(path.join(gate, a.id), "");
    let log = await waitForLog(base, a.id, (rows) => Boolean(belongs(rows)));
    let echo = belongs(log).text;
    assert.ok(echo.includes(HINT), `bypassed at the \`result\`: the input does not say the card is closed:\n${echo}`);
    assert.ok(echo.includes(`“${QUESTION}”`), `the notice does not name the question:\n${echo}`);
    assert.ok(echo.indexOf(HINT) < echo.indexOf("Can you sort the agenda, please?"), "the notice stands BEFORE the message");
    assert.match(echo, /<cbase-hint seq="1" source="question">/, "fenced like the silent notices");
    assert.equal(pidOf(echo), pidOf(provided(log).text), "same process: the message went in at the `result`");
    // The history shows what the human typed — the notice is not a row.
    assert.equal(log.filter((r) => r.role === "user").at(-1).text, "Can you sort the agenda, please?");
    assert.equal(openAskOf(a.id), null, "the message closed the card");
    await waitForQuiet(base);

    // 2. The card is open, the run is over; the next message starts a NEW run (deliverUserPrompt → doRun).
    const b = await newChat();
    await json(`${base}/api/chats/${b.id}/message`, { method: "POST", body: JSON.stringify({ text: `§ASK§ CHAT=${b.id} Review running.` }) });
    await waitForLog(base, b.id, (rows) => rows.some((r) => r.role === "assistant" && r.text.startsWith("Question asked (201)")));
    await waitForQuiet(base);
    assert.ok(openAskOf(b.id), "the card is open after the turn");
    await json(`${base}/api/chats/${b.id}/message`, { method: "POST", body: JSON.stringify({ text: "Do something else first." }) });
    log = await waitForLog(base, b.id, (rows) => Boolean(belongs(rows)));
    echo = belongs(log).text;
    assert.ok(echo.includes(HINT), `new run: the input does not say the card is closed:\n${echo}`);
    assert.ok(echo.includes(`“${QUESTION}”`), `the notice does not name the question:\n${echo}`);
    assert.notEqual(pidOf(echo), pidOf(provided(log).text), "a new run");
    await waitForQuiet(base);
    assert.deepEqual(store.openHints(b.id), [], "the silent notice is used up after the turn");

    // 3. Opposite direction: a CHOICE on the card is not a bypass — the following turn carries no notice.
    const c = await newChat();
    await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: `§ASK§ CHAT=${c.id} Review running.` }) });
    await waitForLog(base, c.id, (rows) => rows.some((r) => r.role === "assistant" && r.text.startsWith("Question asked (201)")));
    await waitForQuiet(base);
    const open = openAskOf(c.id);
    await json(`${base}/api/chats/${c.id}/ask-answer`, { method: "POST", body: JSON.stringify({ requestId: open.requestId, answers: [{ selected: ["Create as is (recommended)"] }] }) });
    log = await waitForLog(base, c.id, (rows) => Boolean(belongs(rows)));
    echo = belongs(log).text;
    assert.match(echo, /Selected: Create as is \(recommended\)/);
    assert.ok(!echo.includes(HINT), `a choice is not a bypass:\n${echo}`);
    await waitForQuiet(base);
    ok = true;
  } finally {
    if (base && !ok) await shortWaitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

test("question bypassed: rule, dismissed card and description say the same", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ask-rule-"));
  let server;
  let base = "";
  let ok = false;
  try {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Ask-Rule", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", permissionMode: "bypassPermissions" }) });
    const store = await import("../electron/server/store.js");
    const { dismissAsk, openAskOf, bypassedCard } = await import("../electron/server/runs/ask.js");
    const { completionNotice } = await import("../electron/server/runs/completionNotice.js");
    const card = (id) => store.addMessage(chat.id, "ask", JSON.stringify({ requestId: id, questions: [{ question: QUESTION, options: [{ label: "A" }, { label: "B" }] }] }));

    // The same rule as openAskOf: what closes the card after writing, bypassedCard predicts before.
    card("r-1");
    const notice = completionNotice({ agentId: "a-1", description: "On the side", status: "completed", report: "finished" }, { toolUseId: "toolu_x" });
    assert.equal(bypassedCard(chat.id, [{ display: notice }]), null, "a completion notice bypasses nothing");
    assert.equal(bypassedCard(chat.id, [{ display: "Do something else.", silent: true }]), null, "a silent entry writes no row");
    assert.equal(bypassedCard(chat.id, [{ display: "Do something else." }])?.requestId, "r-1");
    store.addMessage(chat.id, "user", "Do something else.");
    assert.equal(openAskOf(chat.id), null, "… and after writing it is closed");
    assert.equal(bypassedCard(chat.id, [{ display: "One more thing." }]), null, "a closed card is not reported twice");

    // /clear closes the card — in openAskOf as in listOpenAsks (SQL) and the clients. openAskOf once overlooked the row: the
    // first message after /clear got the "bypassed" notice for a card the UI showed as closed.
    const inList = () => store.listOpenAsks().some((a) => a.chatId === chat.id);
    card("r-c");
    assert.equal(openAskOf(chat.id)?.requestId, "r-c");
    assert.equal(inList(), true, "before /clear: open for listOpenAsks too");
    const { clearChatContext } = await import("../electron/server/runs/post-run.js");
    assert.equal(clearChatContext(store.getChat(chat.id)).ok, true);
    assert.equal(openAskOf(chat.id), null, "after /clear it is closed");
    assert.equal(inList(), false, "… for listOpenAsks as well");
    assert.equal(bypassedCard(chat.id, [{ display: "Start over." }]), null, "the first message after /clear bypasses nothing");

    // A card the server dismisses without a choice (workflow step skipped, archive, …) it reports silently.
    card("r-2");
    assert.equal(dismissAsk(chat.id, "skip"), "r-2");
    const hints = store.openHints(chat.id);
    assert.equal(hints.length, 1, `dismissAsk files a silent notice: ${JSON.stringify(hints)}`);
    assert.equal(hints[0].source, "question");
    assert.ok(hints[0].text.includes(HINT) && hints[0].text.includes("skipped") && hints[0].text.includes(`“${QUESTION}”`), hints[0].text);
    assert.equal(dismissAsk(chat.id, "skip"), null, "nothing without an open card");
    assert.equal(store.openHints(chat.id).length, 1, "… and no second notice");

    // The description side: tool description and return value say that another message closes the card.
    const { agentTools } = await import("../electron/mcp/tools/agents.js");
    const ask = agentTools.find((t) => t.name === "cbase_ask");
    assert.match(ask.description, /that closes the card/);
    assert.match(ask.description, /no longer clickable/);
    const source = fs.readFileSync(new URL("../electron/mcp/tools/agents.js", import.meta.url), "utf8");
    assert.match(source, /If they write something else instead, the card is closed by that and no longer clickable/);
    ok = true;
  } finally {
    if (base) await (ok ? waitForQuiet(base) : shortWaitForQuiet(base));
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
