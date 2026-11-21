import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { headerBundle, startServer } from "../electron/server/server.js";
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

// Without a deadline: any fixed wait is still a clock the test can fail on under load. It turns red only if the stream ENDS
// without the event having come; if it hangs, the suite deadline is the emergency brake.
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

// After the last checked answer the run still writes its summary and removes itself from `active_runs`. If the data directory is
// deleted before that, SQLite reports "attempt to write a readonly database" — node:test charges this late activity to the test
// that just ended and fails the whole FILE. So let it drain first (waitForQuiet, quiet.mjs — no deadline), then clean up.

// Wait for an event — WITHOUT a deadline (no timers in tests). One line on stderr every 30 s, so a hang says what it waits for.
async function waitFor(fn, what, every = 30) {
  const begin = Date.now();
  let reported = begin;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - reported >= 30_000) {
      reported = Date.now();
      console.error(`[waiting] for ${Math.round((reported - begin) / 1000)} s: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

test("server queues messages during a run and persists the turn order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-server-queue-"));
  const bin = path.join(root, "fake-claude");
  // The FIRST turn ends on a signal from the test, not after a fixed time: under load it would otherwise be done before the second
  // message arrived, and that one would be started instead of queued.
  const gate = path.join(root, "gate-on");
  const previousBin = process.env.CLAUDE_BIN;
  let server;
  let base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const gate = ${JSON.stringify(gate)};
let turn = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.exitCode = 1; return; }
  if (msg.type !== "user") return;
  turn++;
  const n = turn;
  const responses = () => {
    const text = n === 1 ? "Answer one" : "Answer two";
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
    console.log(JSON.stringify({ type: "result", result: text, session_id: "queue-session" }));
  };
  if (n > 1) { setTimeout(responses, 20); return; }
  const wait = () => { if (fs.existsSync(gate)) setTimeout(responses, 20); else setTimeout(wait, 20); };
  wait();
});
`);
    fs.chmodSync(bin, 0o755);
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
      body: JSON.stringify({ name: "Queue test", path: wsPath }),
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
    const globalEvents = await fetch(`${base}/api/events`);
    const eventReader = globalEvents.body.getReader();
    const titleEvent = waitForSse(eventReader, (evt) => evt.type === "chat_title" && evt.chatId === chat.id);

    const first = await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "First message" }),
    });
    assert.equal(first.queued, false);
    assert.deepEqual(await titleEvent, { type: "chat_title", chatId: chat.id, title: "First message" });
    await eventReader.cancel();

    const second = await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Queued message" }),
    });
    assert.equal(second.queued, true);
    assert.equal(second.position, 1);
    fs.writeFileSync(gate, "go");

    const log = await waitFor(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return l.some((m) => m.role === "assistant" && m.text === "Answer two") ? l : null;
    }, "\"Answer two\" in the history");

    assert.deepEqual(
      log.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.text]),
      [
        ["user", "First message"],
        ["assistant", "Answer one"],
        ["user", "Queued message"],
        ["assistant", "Answer two"],
      ],
    );
    const updated = await json(`${base}/api/chats/${chat.id}`);
    assert.equal(updated.title, "First message");
    finished = true;
  } finally {
    // A held turn must not hold up the cleanup; wait for quiet only if the body passed.
    try { fs.writeFileSync(gate, "go"); } catch {}
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    // A test must not fail because its temp directory does not go away: a child process still writing causes ENOTEMPTY, which is a
    // statement about the cleanup, not about the product. It is not kept quiet either — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// ── Bundling the head ──────────────────────────────────────────────────────────────────
//
// All queued user messages go out together as one turn instead of one turn each. The cut is `headerBundle`; its two rules are not
// preferences but conditions — so they are checked here directly and not only through the server, where an event entry is hard to
// produce.
test("headerBundle takes only contiguous user entries from the head", () => {
  const e = (id, cause) => ({ id, cause, prompt: id, display: id });

  assert.deepEqual(headerBundle([]).map((x) => x.id), []);
  assert.deepEqual(headerBundle(undefined).map((x) => x.id), []);

  // The normal case: everything the user queued goes together.
  assert.deepEqual(
    headerBundle([e("a", "user"), e("b", "user"), e("c", "user")]).map((x) => x.id),
    ["a", "b", "c"],
  );
  // A missing cause is "user" — the same default as everywhere else.
  assert.deepEqual(headerBundle([e("a", undefined), e("b", "user")]).map((x) => x.id), ["a", "b"]);

  // An event carries its own tool set and goes ALONE, even if user entries lie behind it — otherwise it would get the tools of a
  // user turn.
  assert.deepEqual(
    headerBundle([e("ev", "event"), e("a", "user"), e("b", "user")]).map((x) => x.id),
    ["ev"],
  );
  assert.deepEqual(headerBundle([e("z", "schedule"), e("a", "user")]).map((x) => x.id), ["z"]);
  assert.deepEqual(headerBundle([e("k", "channel"), e("a", "user")]).map((x) => x.id), ["k"]);

  // And the bundle BREAKS OFF at a foreign cause instead of skipping it: pulling "b" behind the event would be a silent reordering.
  // The "steer now" action may do that (an explicit user act), the automatic drain may not.
  assert.deepEqual(
    headerBundle([e("a", "user"), e("ev", "event"), e("b", "user")]).map((x) => x.id),
    ["a"],
  );
});

// The path through the real server: three messages queued during a run, ONE follow-up turn. Both things that hang on it are
// checked — the prompt the CLI gets (one text, the three joined with a blank line) and the history (three user rows of their own,
// ONE answer). That there are exactly two answers is the real statement: without bundling there would be four.
test("three queued messages go out as ONE turn — with three rows in the history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-server-bundle-"));
  const bin = path.join(root, "fake-claude");
  const gate = path.join(root, "gate-on");
  const previousBin = process.env.CLAUDE_BIN;
  let server;
  let base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    // The FIRST turn ends not after a deadline but on a signal from the test: only when all three messages are provably queued may it
    // finish. With a clock the machine under load would decide how many land in the bundle — the test would be weather, not a
    // statement. A oneshot (`claude -p`, e.g. title generation) sends no stream-json line and never gets past here.
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const gate = ${JSON.stringify(gate)};
let turn = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.exitCode = 1; return; }
  if (msg.type !== "user") return;
  turn++;
  const n = turn;
  const got = ((msg.message && msg.message.content) || []).map((c) => c.text || "").join("");
  const responses = () => {
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Turn " + n + " got: " + got }] } }));
    console.log(JSON.stringify({ type: "result", result: "Turn " + n, session_id: "bundle-session" }));
  };
  if (n > 1) { setTimeout(responses, 60); return; }
  const wait = () => { if (fs.existsSync(gate)) setTimeout(responses, 60); else setTimeout(wait, 20); };
  wait();
});
`);
    fs.chmodSync(bin, 0o755);
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
      body: JSON.stringify({ name: "Bundle test", path: wsPath }),
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

    const send = (text) => json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    const first = await send("First message");
    assert.equal(first.queued, false, "The first message starts the run");

    // The server's answers are the proof that all three really WAIT — not the clock.
    for (const [i, text] of ["Two", "Three", "Four"].entries()) {
      const res = await send(text);
      assert.equal(res.queued, true, `"${text}" must be queued (the first run holds at the gate)`);
      assert.equal(res.position, i + 1, `"${text}" is at position ${i + 1}`);
    }
    fs.writeFileSync(gate, "go");

    const log = await waitFor(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return l.some((m) => m.role === "assistant" && m.text.startsWith("Turn 2")) ? l : null;
    }, "answer of the bundled turn in the history");

    assert.deepEqual(
      log.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.text]),
      [
        ["user", "First message"],
        ["assistant", "Turn 1 got: First message"],
        // Three rows of their own: the separation is what one wants to see in the history …
        ["user", "Two"],
        ["user", "Three"],
        ["user", "Four"],
        // … and ONE turn with ONE prompt. Without bundling there would be three answers here.
        ["assistant", "Turn 2 got: Two\n\nThree\n\nFour"],
      ],
    );
    // Nothing is left behind: the queue is empty, the chat quiet again.
    const state = await json(`${base}/api/chats/${chat.id}/runs`).catch(() => null);
    if (state) assert.equal(state.queued | 0, 0, "After the bundle nothing is left in the queue");
    finished = true;
  } finally {
    try { fs.writeFileSync(gate, "go"); } catch {}
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
