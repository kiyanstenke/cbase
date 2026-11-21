// Joining a chat's event stream (GET /api/chats/:id/stream).
//
// Race: the client creates the chat, attaches the stream (`new EventSource` returns IMMEDIATELY, the connection
// stands a round trip later) and sends the message right after. If the POST reaches the server before the GET,
// "user_message" and "run_started" are lost: the server registers the reader in its fan-out list only AFTER the
// first "connected" and sends nothing afterwards.
//
// This test pins both sides of the contract the client builds on:
//
//   1. There is NO backlog: what happened before joining never arrives over the stream.
//      (So the client must not send before the stream stands.)
//   2. What is FINISHED is in the DB - the reload path can fill the gap. This explicitly does NOT hold for a
//      RUNNING block: its text arises as deltas and is written to the log only at the block end. A rejoin in the
//      middle of writing found nothing in either stream or log and showed an empty answer bubble.
//   3. After "connected" events arrive: whoever waits for it and only then sends sees their own message.
//   4. Hence "connected" carries the text of the running block - exactly once: it must not ADDITIONALLY stand
//      as its own row in the log.
//
// Counter-tests: a server that replays a backlog turns (1) red; a "connected" without the running text turns (4)
// red; a text duplicated into the log turns the exactly-once assertion red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { streamBarrier, waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// After a failure only a few glances at quiet - the body's error stays the reported one, no hang.
async function shortWaitForQuiet(base) {
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Minimal SSE reader: collects events and lets a caller wait for one. `fetch` resolves once the headers are
// there - the server has written "connected" by then, but only the EVENT itself proves the registration.
async function openStream(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  const events = [];
  const waiters = [];
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
            if (!line.startsWith("data: ")) continue;
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }
            events.push(evt);
            for (const w of waiters.slice()) {
              if (!w.pred(evt)) continue;
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(evt);
            }
          }
        }
      }
    } catch { /* the abort on close is expected */ }
  })();
  return {
    events,
    // No deadline (no clock a test can go red on) - if it hangs, the suite ends the run.
    waitFor(pred) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => { waiters.push({ pred, resolve }); });
    },
    async close() { ac.abort(); await pump; },
  };
}

const isUserMessage = (evt) => evt.type === "harness" && evt.subtype === "user_message";
const isConnected = (evt) => evt.type === "harness" && evt.subtype === "connected";

test("chat stream: no backlog before joining, but everything after \"connected\"", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stream-join-"));
  const bin = path.join(root, "fake-claude");
  const previousBin = process.env.CLAUDE_BIN;
  const previousPoll = process.env.CBASE_TRIGGER_POLL;
  let server;
  let base = "";
  let ok = false;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(JSON.stringify({ result: "Test title" })));
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    const answer = "Answer to: " + text;
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: answer }] } }));
    console.log(JSON.stringify({ type: "result", result: answer, session_id: "s1" }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";

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
      body: JSON.stringify({ name: "Stream join", path: wsPath }),
    });
    const newChat = () => json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
      }),
    });

    // ── 1. The lost race: send first, join afterwards ───────────────────────────────────
    const lost = await newChat();
    await json(`${base}/api/chats/${lost.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Message before joining" }),
    });
    const late = await openStream(`${base}/api/chats/${lost.id}/stream`);
    await late.waitFor(isConnected);
    // Not "enough time": first QUIET (the run with its title is done - the server writes nothing by itself any more),
    // then the stream barrier (the reader has everything the server wrote into this stream so far). A backlog
    // would therefore be in `late.events` NOW.
    await waitForQuiet(base, { barrier: [{ reader: late, target: lost.id }] });
    assert.equal(
      late.events.filter(isUserMessage).length,
      0,
      "the server must not replay anything - which is why the client has to wait before sending",
    );
    await late.close();

    // The row is in the DB anyway: the client's reload path can fill the gap.
    const log = await json(`${base}/api/chats/${lost.id}/log`);
    assert.ok(
      log.some((row) => row.role === "user" && String(row.text).includes("Message before joining")),
      "the log must contain the missed message",
    );

    // ── 2. The right order: wait for "connected", then send ─────────────────────────────
    const kept = await newChat();
    const early = await openStream(`${base}/api/chats/${kept.id}/stream`);
    const hello = await early.waitFor(isConnected);
    assert.equal(hello.running, false, "a fresh chat is not running yet");
    await json(`${base}/api/chats/${kept.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Message after joining" }),
    });
    const seen = await early.waitFor(isUserMessage);
    assert.equal(seen.text, "Message after joining");
    // The run itself is announced too - the client's answer bubble hangs on it.
    await early.waitFor((evt) => evt.type === "harness" && evt.subtype === "run_started");
    await early.close();
    await waitForQuiet(base);
    ok = true;
  } finally {
    if (base && !ok) await shortWaitForQuiet(base);
    // `closeAllConnections` BEFORE close: a reader left open after a failure would hold `server.close` forever -
    // the red test would become a hang without a line.
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousPoll === undefined) delete process.env.CBASE_TRIGGER_POLL;
    else process.env.CBASE_TRIGGER_POLL = previousPoll;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Rejoining IN THE MIDDLE of a block ───────────────────────────────────────────────────
// A stream that reconnects while text is being written (screen off, network change, second window) got only an
// empty "connected". The running block existed: its deltas were through, but the log holds it only at the block
// end - the answer bubble stayed empty until the turn finished.
//
// The fake CLI sends one delta and keeps the turn open until the gate file exists, so the test decides WHEN the
// block ends instead of betting on a time window.
test("joined mid-block: \"connected\" carries the running text - and the log holds it exactly once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stream-live-"));
  const bin = path.join(root, "fake-claude");
  const gate = path.join(root, "gate");
  const previousBin = process.env.CLAUDE_BIN;
  const previousPoll = process.env.CBASE_TRIGGER_POLL;
  // The text must be unmistakable: it is later counted how often it stands in the log.
  const PART = "Interim state from the running block";
  let server;
  let base = "";
  let a = null;
  let b = null;
  let ok = false;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const say = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!args.includes("stream-json")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(JSON.stringify({ result: "Test title" })));
} else {
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = ${JSON.stringify(PART)};
    say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    // The turn stays open until the test releases it - stream B joins in exactly this gap.
    while (!fs.existsSync(${JSON.stringify(gate)})) await sleep(50);
    say({ type: "assistant", message: { content: [{ type: "text", text }] } });
    say({ type: "result", result: text, session_id: "s-live" });
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";

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
      body: JSON.stringify({ name: "Stream rejoin", path: wsPath }),
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

    // Stream A: join and send in the right order.
    a = await openStream(`${base}/api/chats/${chat.id}/stream`);
    await a.waitFor(isConnected);
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Write something longer" }),
    });
    // Only once the delta is through is the block really "in the middle".
    await a.waitFor((evt) => evt.type === "stream_event"
      && evt.event?.delta?.type === "text_delta"
      && String(evt.event.delta.text).includes(PART));

    // Stream B joins NOW - the block is still running, the log does not hold it yet.
    b = await openStream(`${base}/api/chats/${chat.id}/stream`);
    const hallo = await b.waitFor(isConnected);
    assert.equal(hallo.running, true, "the run is still running - otherwise this test measures nothing");
    // What is checked is THAT the text comes along, not under which field name: the name belongs to the client
    // contract; this is about the promise "nothing is lost".
    const carrier = Object.keys(hallo).find((k) => JSON.stringify(hallo[k] ?? null).includes(PART));
    assert.ok(carrier, `"connected" does not carry the running text: ${JSON.stringify(hallo).slice(0, 600)}`);

    // The log does NOT hold it yet at this point - that is why the stream must carry it.
    const during = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(
      during.filter((row) => String(row.text || "").includes(PART)).length,
      0,
      "before the block end the text must not be in the log yet - otherwise the reload path would be the answer and this test superfluous",
    );

    // Release: the block ends, the text is written.
    fs.writeFileSync(gate, "los");
    await waitForQuiet(base);
    const afterwards = await json(`${base}/api/chats/${chat.id}/log`);
    const hits = afterwards.filter((row) => String(row.text || "").includes(PART));
    assert.equal(
      hits.length,
      1,
      `the text must stand EXACTLY ONCE in the log - ${hits.length} rows: ${JSON.stringify(hits.map((r) => r.role))}`,
    );
    assert.equal(hits[0].role, "assistant");
    ok = true;
  } finally {
    // Close the streams in finally: `server.close` waits for every open connection; a reader unsubscribed only
    // on the success path turns the first real failure into an endless hang.
    try { await a?.close(); } catch { /* already closed */ }
    try { await b?.close(); } catch { /* already closed */ }
    try { fs.writeFileSync(gate, "los"); } catch { /* then only the fake CLI hangs, which dies right away */ }
    if (base && !ok) await shortWaitForQuiet(base);
    // `closeAllConnections` BEFORE close: a reader left open after a failure would hold `server.close` forever -
    // the red test would become a hang without a line.
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousPoll === undefined) delete process.env.CBASE_TRIGGER_POLL;
    else process.env.CBASE_TRIGGER_POLL = previousPoll;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});
