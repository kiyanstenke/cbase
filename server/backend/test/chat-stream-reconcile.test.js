// The server seam of opening a chat. Three promises that web (chat/ChatPane.tsx, lib/history-reconcile.ts) and iOS
// (Chat/ChatViewModel+Stream.swift) build on:
//
//   N1  The "connected" of the chat stream carries `lastId` (highest messages.id, 0 without rows) and `total` (row
//       count), counted like the counter-check of GET .../log/delta. A client can thus detect a gap between its state
//       and the server's even if the reconcile on open discarded its result.
//   N2  A `hint` row (written outside the turn's own stream: subagent at the limit, dynamic workflow, graph
//       background, migrations, instance switch ...) goes out as `{ type: "row", row }` to the open streams of its
//       chat - `row` in the same shape as a row from GET .../log. Other roles do not: the turn sends those itself
//       through its events.
//   N3  An image attachment (png/jpeg/gif/webp) carries `w`/`h` from the file header - in the upload response AND in
//       the message meta (which the server re-describes from the file). Without a readable header no field.
//
// Counter-tests (ONE per guard):
//   (N1) drop `lastId: state.lastId, total: state.total, ` from the "connected" in chats/routes.js => "N1 ..." red
//        (`undefined` instead of 0 or the counter-check number).
//   (N2) comment out the `store.setRowsObserver(...)` line in server.js => "N2 ..." hangs waiting for the event -
//        the suite deadline ends it (no timer in the test); green with the line.
//   (N3) replace `withImageDimensions(..., imageDimensionsFromFile(...))` in runs/routes.js with the bare object =>
//        "N3 ..." red (the message meta without `w`/`h`); the upload response still carries them - exactly the case
//        this guard catches.
//
// Single: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/chat-stream-reconcile.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { imageDimensions, imageDimensionsFromFile } from "../electron/server/runtime/image-dimensions.js";
import { streamBarrier, waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// SSE reader (like chat-stream-join.test.js): collects, lets a caller wait for an event - no deadline.
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
    } catch { /* abort on close */ }
  })();
  return {
    events,
    waitFor(pred) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => { waiters.push({ pred, resolve }); });
    },
    async close() { ac.abort(); await pump; },
  };
}
const isConnected = (e) => e.type === "harness" && e.subtype === "connected";

// ── Image headers, built by hand (no dependency, no decoding) ────────────────────────────────────────────────────────────
function pngHeader(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 6; // bit depth, color type - like a real RGBA PNG
  return b;
}
function gifHeader(w, h) {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}
// JPEG: SOI, optional APP1 with EXIF rotation (big-endian TIFF, one entry), an APP0 in between, SOF0 with height/width.
function jpegHeader(w, h, rotation = 0, { le = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  parts.push(app0);
  if (rotation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    if (le) { tiff.write("II", 0, "latin1"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(rotation, 18); }
    else { tiff.write("MM", 0, "latin1"); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1, 8); tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(rotation, 18); }
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]); header.writeUInt16BE(payload.length + 2, 2);
    parts.push(header, payload);
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
function webpHeader(kind, w, h) {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write(kind, 12, "latin1");
  if (kind === "VP8X") { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  if (kind === "VP8L") { b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21); }
  if (kind === "VP8 ") { b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  return b;
}

test("N3 imageDimensions: PNG, GIF, WebP (three kinds), JPEG with EXIF rotation - and nothing guessed", () => {
  assert.deepEqual(imageDimensions(pngHeader(1170, 2532)), { w: 1170, h: 2532 });
  assert.deepEqual(imageDimensions(gifHeader(7, 5)), { w: 7, h: 5 });
  assert.deepEqual(imageDimensions(webpHeader("VP8X", 1000, 500)), { w: 1000, h: 500 });
  assert.deepEqual(imageDimensions(webpHeader("VP8L", 640, 480)), { w: 640, h: 480 });
  assert.deepEqual(imageDimensions(webpHeader("VP8 ", 320, 200)), { w: 320, h: 200 });
  assert.deepEqual(imageDimensions(jpegHeader(4032, 3024)), { w: 4032, h: 3024 });
  // Portrait phone shot: stored landscape with rotation 6 - the browser shows it upright, so swapped.
  assert.deepEqual(imageDimensions(jpegHeader(4032, 3024, 6)), { w: 3024, h: 4032 });
  assert.deepEqual(imageDimensions(jpegHeader(4032, 3024, 8, { le: true })), { w: 3024, h: 4032 });
  assert.deepEqual(imageDimensions(jpegHeader(4032, 3024, 3)), { w: 4032, h: 3024 }, "180° stays landscape");
  // Empty is not unknown: broken, truncated and foreign headers give null, never a dimension.
  assert.equal(imageDimensions(Buffer.from("not an image")), null);
  assert.equal(imageDimensions(pngHeader(10, 10).subarray(0, 20)), null);
  assert.equal(imageDimensions(jpegHeader(10, 10).subarray(0, 12)), null);
  assert.equal(imageDimensions(pngHeader(0, 10)), null);
  assert.equal(imageDimensions(Buffer.alloc(0)), null);
  assert.equal(imageDimensions("png"), null);
});

test("N3 imageDimensionsFromFile: only image extensions, only regular files - a symlink is not followed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-image-dimensions-"));
  try {
    fs.writeFileSync(path.join(root, "a.png"), pngHeader(30, 20));
    fs.writeFileSync(path.join(root, "a.txt"), pngHeader(30, 20));
    fs.symlinkSync(path.join(root, "a.png"), path.join(root, "b.png"));
    assert.deepEqual(imageDimensionsFromFile(path.join(root, "a.png")), { w: 30, h: 20 });
    assert.equal(imageDimensionsFromFile(path.join(root, "a.txt")), null, "no image name, no dimension");
    assert.equal(imageDimensionsFromFile(path.join(root, "b.png")), null, "a symlink in place of the attachment: not followed");
    assert.equal(imageDimensionsFromFile(path.join(root, "missing.png")), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("N1/N2/N3 on the real server: connected carries the state, a hint row reaches the open stream, attachments carry dimensions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stream-reconcile-"));
  const bin = path.join(root, "fake-claude");
  const previousBin = process.env.CLAUDE_BIN;
  const previousPoll = process.env.CBASE_TRIGGER_POLL;
  let server;
  let base = "";
  const reader = [];
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(JSON.stringify({ result: "Test title" })));
} else {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "seen" }] } }));
    console.log(JSON.stringify({ type: "result", result: "seen", session_id: "s1" }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Reconcile", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });

    // ── N1: an empty chat reports 0/0, a filled one exactly the state of the delta counter-check ──
    const empty = await openStream(`${base}/api/chats/${chat.id}/stream`);
    reader.push(empty);
    const c0 = await empty.waitFor(isConnected);
    assert.equal(c0.lastId, 0, "without rows: lastId 0");
    assert.equal(c0.total, 0, "without rows: total 0");
    await empty.close();
    store.addMessage(chat.id, "user", "Question");
    store.addMessage(chat.id, "assistant", "Response");
    const delta = await json(`${base}/api/chats/${chat.id}/log/delta?since=0`);
    const full = await openStream(`${base}/api/chats/${chat.id}/stream`);
    reader.push(full);
    const c1 = await full.waitFor(isConnected);
    assert.equal(c1.lastId, delta.lastId, "lastId = that of the delta route");
    assert.equal(c1.total, delta.total, "total = the counter-check of the delta route");
    assert.equal(c1.total, 2);
    assert.ok(c1.lastId > 0);

    // ── N2: a hint goes out as `row`, in the shape of a log row; other roles do not ──
    store.addMessage(chat.id, "assistant", "an answer without an event of its own");
    store.addMessage(chat.id, "hint", "Subagent \"x\" could not continue after the usage limit");
    const z = await full.waitFor((e) => e.type === "row");
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const hintRow = log.find((r) => r.role === "hint");
    assert.deepEqual(z.row, hintRow, "same shape as GET .../log");
    assert.ok(z.row.id > c1.lastId, "the row lies behind the reported state - the client appends it");
    const start = await streamBarrier(full, chat.id);
    assert.equal(full.events.slice(0, start).filter((e) => e.type === "row").length, 1, "only the hint row came as `row`");

    // ── N3: the upload carries w/h, the message too (the server re-describes the meta); text without ──
    const up = async (name, body) => (await fetch(`${base}/api/chats/${chat.id}/attachments?name=${encodeURIComponent(name)}&artifact=0`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body })).json();
    const image = await up("screen.png", pngHeader(1440, 900));
    assert.equal(image.w, 1440);
    assert.equal(image.h, 900);
    const photo = await up("photo.jpg", jpegHeader(4032, 3024, 6));
    assert.deepEqual([photo.w, photo.h], [3024, 4032], "EXIF rotation: portrait");
    const text = await up("note.txt", Buffer.from("not an image"));
    assert.ok(!("w" in text) && !("h" in text), "a text carries no dimensions");
    // The client sends the meta WITHOUT dimensions (like an old client) - the server reads them from the file itself.
    const withoutDimensions = (a) => ({ name: a.name, file: a.file });
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "with attachments", attachments: [withoutDimensions(image), withoutDimensions(photo), withoutDimensions(text)] }) });
    await waitForQuiet(base);
    const message = (await json(`${base}/api/chats/${chat.id}/log`)).find((r) => r.role === "user" && r.text === "with attachments");
    assert.ok(message, "the message is in the log");
    const [a1, a2, a3] = message.attachments;
    assert.deepEqual([a1.w, a1.h], [1440, 900], "N3: the message meta carries the dimensions");
    assert.deepEqual([a2.w, a2.h], [3024, 4032]);
    assert.ok(!("w" in a3) && !("h" in a3));
  } finally {
    for (const l of reader) await l.close().catch(() => {});
    if (base) await waitForQuiet(base).catch(() => {});
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousPoll === undefined) delete process.env.CBASE_TRIGGER_POLL;
    else process.env.CBASE_TRIGGER_POLL = previousPoll;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
