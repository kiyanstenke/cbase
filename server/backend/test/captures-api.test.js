import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { showCaptures } from "../electron/server/chats/captures-show.js";

// Capture routes through the real server: browser gate (409), profileKey scope (403), the turn-end card (persistence + SSE,
// never twice; the turn path itself is in captures-turn-end.test.js), the removed send route and range delivery for the video.
// A capture is seeded straight to disk — the browser side is tested by captures.test.js.

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}
async function raw(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  return { status: res.status, body: await res.json() };
}
async function waitForSse(reader, predicate, timeoutMs = 10_000) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const read = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), remaining)),
    ]);
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

test("capture routes: gates, send card and range delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-capapi-"));
  let server;
  try {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Cap-Test", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude" }) });

    // Without an agent browser, screenshot and recording start run into the 409 gate.
    const noBrowser = await raw(`${base}/api/chats/${chat.id}/captures`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(noBrowser.status, 409);
    assert.match(noBrowser.body.error, /No browser/);
    const recNoBrowser = await raw(`${base}/api/chats/${chat.id}/captures/record`, { method: "POST", body: JSON.stringify({ action: "start" }) });
    assert.ok([409, 424].includes(recNoBrowser.status)); // 424 only if the test machine lacks ffmpeg
    // A foreign profileKey is rejected before any browser is looked up.
    const foreign = await raw(`${base}/api/chats/${chat.id}/captures`, { method: "POST", body: JSON.stringify({ profileKey: "other-chat" }) });
    assert.equal(foreign.status, 403);

    // Seed a capture (as left behind by takeScreenshot/stopRecording).
    const cid = "c-12345678-1234-1234-1234-123456789abc";
    const dir = path.join(root, "data-root", "data", "attachments", chat.id, "captures", cid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "poster.jpg"), Buffer.from("JPEG_DATA"));
    fs.writeFileSync(path.join(dir, "video.mp4"), Buffer.from("0123456789ABCDEF")); // 16 Bytes
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: cid, chatId: chat.id, kind: "recording", createdAt: Date.now(), profileKey: chat.id,
      url: "http://localhost:3100/", title: "Test page", w: 640, h: 480,
      poster: "poster.jpg", video: "video.mp4", fps: 4, frames: 12, durationMs: 3000,
      bytes: 16, autoStopped: false, sent: false, caption: "This is how it looks now.", show: true,
    }));
    const list = await json(`${base}/api/chats/${chat.id}/captures`);
    assert.equal(list.captures.length, 1);

    // The send route is gone: no card, the manifest stays unsent.
    const dropped = await fetch(`${base}/api/chats/${chat.id}/captures/${cid}/send`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    assert.equal(dropped.ok, false, "POST …/captures/:cid/send no longer exists");
    assert.equal((await json(`${base}/api/chats/${chat.id}/log`)).some((e) => e.role === "capture"), false);
    // Turn end: the card is persisted (role capture) and arrives live over the chat stream.
    const streamRes = await fetch(`${base}/api/chats/${chat.id}/stream`);
    const reader = streamRes.body.getReader();
    assert.equal(showCaptures(chat.id), 1);
    const evt = await waitForSse(reader, (e) => e.type === "harness" && e.subtype === "capture_message");
    assert.equal(evt.captureId, cid);
    assert.equal(evt.caption, "This is how it looks now.");
    assert.equal(evt.video, "video.mp4");
    await reader.cancel().catch(() => {});
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const row = log.find((e) => e.role === "capture");
    assert.ok(row, "capture row missing in the log");
    assert.equal(JSON.parse(row.text).captureId, cid);
    // Never twice: a second turn end shows nothing.
    assert.equal(showCaptures(chat.id), 0);
    assert.equal((await json(`${base}/api/chats/${chat.id}/log`)).filter((e) => e.role === "capture").length, 1);

    // Range delivery: full (200), partial (206), suffix, invalid (416).
    const full = await fetch(`${base}/api/chats/${chat.id}/captures/${cid}/file/video.mp4`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    // `private` keeps a CDN (Cloudflare) from serving the file at the edge without auth.
    assert.match(full.headers.get("cache-control") || "", /private/);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(await full.text(), "0123456789ABCDEF");
    const part = await fetch(`${base}/api/chats/${chat.id}/captures/${cid}/file/video.mp4`, { headers: { Range: "bytes=4-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 4-9/16");
    assert.equal(await part.text(), "456789");
    const tail = await fetch(`${base}/api/chats/${chat.id}/captures/${cid}/file/video.mp4`, { headers: { Range: "bytes=-4" } });
    assert.equal(tail.status, 206);
    assert.equal(await tail.text(), "CDEF");
    const bad = await fetch(`${base}/api/chats/${chat.id}/captures/${cid}/file/video.mp4`, { headers: { Range: "bytes=99-" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */16");
    const poster = await fetch(`${base}/api/chats/${chat.id}/captures/${cid}/file/poster.jpg`);
    assert.equal(poster.headers.get("content-type"), "image/jpeg");
    // Serve nothing outside the whitelist.
    const evil = await fetch(`${base}/api/chats/${chat.id}/captures/${cid}/file/manifest.json`);
    assert.equal(evil.status, 404);
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
