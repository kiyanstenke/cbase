import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function raw(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  return { status: res.status, body: await res.json() };
}

// No deadline (no clock a test can go red on; the suite is the emergency brake). If the stream ends (unsubscribe in
// finally), the wait throws — the reported error stays the body's.
async function waitForSse(reader, predicate) {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((x) => x.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (predicate(event)) return event;
    }
  }
  throw new Error("SSE event not received");
}

// No deadline; every 30 s stderr says what is awaited, with the latest state of the log.
async function waitForLog(base, chatId, predicate) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const log = await json(`${base}/api/chats/${chatId}/log`);
    if (predicate(log)) return log;
    const sec = Math.floor((Date.now() - start) / 30_000);
    if (sec > reported) { reported = sec; console.error(`[waiting] for ${sec * 30} s: log ${chatId} — latest ${JSON.stringify(log).slice(0, 400)}`); }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

// After a failure only a few looks at quiet — the body's error stays the reported one, no hang.
async function shortWaitForQuiet(base) {
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// The agent asks a question with a choice card (cbase_ask), the run ENDS, and the user's
// choice reaches it as the next message. The fake CLI plays both: first the
// question (and a second attempt to be rejected), then the echo of the delivered answer.
test("ask card: question persisted, second question rejected, choice arrives as a message", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ask-"));
  const bin = path.join(root, "fake-claude");
  const previousBin = process.env.CLAUDE_BIN;
  let server;
  let base = "";
  // The two SSE readers sit OUTSIDE the try: `server.close()` waits for every open
  // connection, a failed assert would otherwise hang in finally instead of failing.
  let reader;
  let globalReader;
  let ok = false;
  try {
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: "Ask-Test", path: wsPath }),
    });
    await json(`${base}/api/workspaces/${ws.id}/skills`, {
      method: "POST",
      body: JSON.stringify({
        name: "ask-interview", area: "coding",
        description: "Asks questions via cbase_ask.",
        body: "# Interview\n\nPlace every question with `cbase_ask`.",
      }),
    });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
      }),
    });

    // The fake CLI only now knows base URL and chat id — so it is written after creation
    // (CLAUDE_BIN only has to exist at the first run).
    fs.writeFileSync(bin, `#!/usr/bin/env node
const readline = require("node:readline");
const BASE = ${JSON.stringify(base)};
const CHAT = ${JSON.stringify(chat.id)};
const post = async (body) => {
  const res = await fetch(BASE + "/api/chats/" + CHAT + "/ask", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const say = (text) => {
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
  console.log(JSON.stringify({ type: "result", result: text, session_id: "ask-session" }));
};
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.exitCode = 1; return; }
  if (msg.type !== "user") return;
  const text = (msg.message.content[0] && msg.message.content[0].text) || "";
  if (text.includes("[Answer to your question")) { say("HEARD: " + text.replace(/\\n/g, " | ")); return; }
  const question = {
    header: "Layout",
    question: "Monorepo or separate repos?",
    options: [
      { label: "Monorepo (recommended)", description: "One repo, shared tooling base." },
      { label: "Separate repos", description: "Independent release cycles." },
    ],
  };
  const first = await post({ questions: [question] });
  const second = await post({ questions: [question] });
  say("Question asked (" + first.status + "), second question: " + second.status);
});
`);
    fs.chmodSync(bin, 0o755);

    const stream = await fetch(`${base}/api/chats/${chat.id}/stream`);
    reader = stream.body.getReader();
    const askEvent = waitForSse(reader, (evt) => evt.subtype === "ask_request");
    const globalStream = await fetch(`${base}/api/events`);
    globalReader = globalStream.body.getReader();
    const finishedEvent = waitForSse(globalReader,
      (evt) => evt.type === "run" && evt.chatId === chat.id && evt.running === false);
    // If the test aborts before the `await`, the wait ends with an error on unsubscribe —
    // without a handler the test run would crash on it instead of reporting the REAL error.
    for (const p of [askEvent, finishedEvent]) p.catch(() => {});

    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "We are planning a new repo layout." }),
    });

    // 1. The question arrives live AND sits in the log (the card survives any reload).
    const ask = await askEvent;
    assert.equal(ask.questions.length, 1);
    assert.equal(ask.questions[0].header, "Layout");
    assert.equal(ask.questions[0].options.length, 2);
    assert.ok(ask.requestId);

    let log = await waitForLog(base, chat.id, (rows) => rows.some((r) => r.role === "ask"));
    const askRow = JSON.parse(log.find((r) => r.role === "ask").text);
    assert.equal(askRow.requestId, ask.requestId);
    assert.equal(askRow.questions[0].question, "Monorepo or separate repos?");

    // The card immediately creates a durable notice with navigation to the chat. The later
    // run end marks its generic push as suppressed, otherwise two banners would appear.
    const notices = (await json(`${base}/api/services/events?since=0`)).events || [];
    const questionNotice = notices.find((n) => n.kind === "question" && n.chatId === chat.id);
    assert.ok(questionNotice, `question notice missing: ${JSON.stringify(notices)}`);
    assert.equal(questionNotice.body, "Monorepo or separate repos?");
    assert.equal(questionNotice.workspaceId, ws.id);

    // 2. While the question is open, a second one is rejected (otherwise cards would pile up).
    log = await waitForLog(base, chat.id, (rows) => rows.some((r) => r.role === "assistant" && r.text.startsWith("Question asked")));
    assert.equal(log.find((r) => r.role === "assistant" && r.text.startsWith("Question asked")).text,
      "Question asked (201), second question: 409");

    // 3. The workspace skill reaches the run through the ONE path: its name sits in the MCP server's
    //    environment and is thus the listing of `cbase_skill`. Nothing is written to disk.
    const scratch = path.join(root, "data-root", "data", "scratch");
    const mcpCfg = JSON.parse(fs.readFileSync(path.join(scratch, `${chat.id}.mcp.json`), "utf8"));
    assert.deepEqual(JSON.parse(mcpCfg.mcpServers.cbase.env.CBASE_SKILLS), ["ask-interview"]);
    assert.equal(fs.existsSync(path.join(scratch, `${chat.id}.skills`)), false,
      "no skill directory is materialized");

    // 4. The run is over — the card stays open and answerable.
    await waitForQuiet(base);
    const finished = await finishedEvent;
    assert.equal(finished.answered, true);
    assert.equal(finished.push, false);

    // A chat with an open question shows in the header pill ("needs attention"), otherwise the
    // question would go unnoticed in an unopened chat.
    const pill = await json(`${base}/api/active-runs`);
    const waitingItem = pill.items.find((it) => it.kind === "ask" && it.chatId === chat.id);
    assert.ok(waitingItem, `open question missing in /api/active-runs: ${JSON.stringify(pill.items)}`);
    assert.equal(waitingItem.phase, "ask");
    assert.equal(waitingItem.question, "Monorepo or separate repos?");
    assert.equal(pill.counts.ask, 1);
    const answered = await json(`${base}/api/chats/${chat.id}/ask-answer`, {
      method: "POST",
      body: JSON.stringify({ requestId: ask.requestId, answers: [{ selected: ["Separate repos"], text: "because of the release cycles" }] }),
    });
    assert.equal(answered.ok, true);

    // 5. The answer is a user row in the log and reaches the agent as a prompt.
    log = await waitForLog(base, chat.id, (rows) => rows.some((r) => r.role === "assistant" && r.text.startsWith("HEARD:")));
    const answerRow = JSON.parse(log.find((r) => r.role === "ask_answer").text);
    assert.equal(answerRow.requestId, ask.requestId);
    assert.deepEqual(answerRow.answers[0].selected, ["Separate repos"]);
    assert.equal(log.filter((r) => r.role === "user").at(-1).text, "Separate repos — because of the release cycles");
    const echo = log.find((r) => r.role === "assistant" && r.text.startsWith("HEARD:")).text;
    assert.match(echo, /Selected: Separate repos/);
    assert.match(echo, /Own answer: because of the release cycles/);

    // 6. Answering twice is not possible — the card is done.
    const again = await raw(`${base}/api/chats/${chat.id}/ask-answer`, {
      method: "POST",
      body: JSON.stringify({ requestId: ask.requestId, answers: [{ selected: ["Monorepo (recommended)"] }] }),
    });
    assert.equal(again.status, 409);

    // And the pill is quiet again — the answered card needs no attention anymore.
    await waitForQuiet(base);
    const after = await json(`${base}/api/active-runs`);
    assert.equal(after.items.filter((it) => it.kind === "ask").length, 0);
    ok = true;
  } finally {
    for (const r of [reader, globalReader]) { try { await r?.cancel(); } catch { /* already closed */ } }
    if (base && !ok) await shortWaitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    // A test must not fail because its temp directory does not go away: a child process
    // still writing causes ENOTEMPTY, which says something about cleanup, not the product.
    // It is still not kept quiet — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// Broken calls must fail descriptively (the model should be able to correct them) — and without
// a running turn there is no card at all.
test("ask card: invalid calls and questions without a run are rejected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ask-invalid-"));
  let server;
  let base = "";
  let ok = false;
  try {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: "Ask-Invalid", path: wsPath }),
    });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", permissionMode: "bypassPermissions" }),
    });

    // Without a running turn: no card.
    const idle = await raw(`${base}/api/chats/${chat.id}/ask`, {
      method: "POST",
      body: JSON.stringify({ questions: [{ question: "And now?", options: [{ label: "A" }, { label: "B" }] }] }),
    });
    assert.equal(idle.status, 409);

    // Answer to a question never asked.
    const ghost = await raw(`${base}/api/chats/${chat.id}/ask-answer`, {
      method: "POST",
      body: JSON.stringify({ requestId: "exists-not", answers: [{ selected: ["A"] }] }),
    });
    assert.equal(ghost.status, 409);

    // Skills come exclusively from workspace/project; there is no global built-in catalog.
    const builtins = await raw(`${base}/api/builtin-skills`);
    assert.equal(builtins.status, 404);
    ok = true;
  } finally {
    if (base) await (ok ? waitForQuiet(base) : shortWaitForQuiet(base));
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    // A test must not fail because its temp directory does not go away: a child process
    // still writing causes ENOTEMPTY, which says something about cleanup, not the product.
    // It is still not kept quiet — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// A subagent's completion notice (role "user", starts with `<task-notification>`) does NOT close the card — the same rule as
// in the clients (chatBubbles.ts, buildTimeline). The server used to close it in `openAskOf` AND in `listOpenAsks`; the
// client showed it answerable, the answer got 409 and the pill dropped. The text comes from `completionNotice()` itself, so
// the test also pins the literal in store/chats.js to FINISHED_MARKER.
// Counter-test (each turns it red once): without `!isCompletionNotice(r.text)` in runs/ask.js, or without the `instr(…)`
// condition in store/chats.js, the card is closed after the completion notice.
test("ask card: a subagent's completion notice does not close it, a human message does", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ask-finished-"));
  let server;
  let base = "";
  let ok = false;
  try {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Ask-Finished", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", permissionMode: "bypassPermissions" }) });
    const store = await import("../electron/server/store.js");
    const { openAskOf } = await import("../electron/server/runs/ask.js");
    const { completionNotice, isCompletionNotice } = await import("../electron/server/runs/completionNotice.js");
    const openInList = () => store.listOpenAsks().some((a) => a.chatId === chat.id);

    store.addMessage(chat.id, "ask", JSON.stringify({ requestId: "r-finished", questions: [{ question: "A or B?", options: [{ label: "A" }, { label: "B" }] }] }));
    assert.equal(openAskOf(chat.id)?.requestId, "r-finished");
    assert.equal(openInList(), true);

    const notice = completionNotice({ agentId: "a-1", description: "On the side", status: "completed", report: "finished" }, { toolUseId: "toolu_x" });
    assert.equal(isCompletionNotice(notice), true);
    store.addMessage(chat.id, "user", notice);
    assert.equal(openAskOf(chat.id)?.requestId, "r-finished", "openAskOf: the completion notice does not close the card");
    assert.equal(openInList(), true, "listOpenAsks: the completion notice does not close the card (header pill)");

    store.addMessage(chat.id, "user", "Rather do something else.");
    assert.equal(openAskOf(chat.id), null, "a human message still closes it");
    assert.equal(openInList(), false);
    ok = true;
  } finally {
    if (base) await (ok ? waitForQuiet(base) : shortWaitForQuiet(base));
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
