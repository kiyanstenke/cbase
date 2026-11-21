// The client side of the WebSocket wire: src/lib/browser-wire.ts (read frame, address, measurement) and
// src/lib/browser-source.ts (wire first, SSE as fallback).
//
// Checked: (a) a frame built by the SERVER page (server/backend/electron/server/browser-wire.js frameBinary) is read back by the
// client byte-exactly — the seam in both directions on the real module; (b) the address (http → ws, https → wss, tab, measure);
// (c) the measurement switch and the summary; (d) the source with stubbed WebSocket/EventSource: if the wire fails before opening
// ⇒ SSE, and the page's NEXT source goes straight to SSE; an open wire delivers frames with `bytes` and `send` works; if it breaks
// ⇒ ONE retry, then SSE; close() ⇒ no retry; (e) BrowserPane drives the source, sends inputs and acks over the wire, sends the
// measurement to /api/browsers/measurement.
//
// Counter-test (which sabotage turns which test red): getUint16 little-endian turns (a) red; deleting `wireBroken = true` turns
// (d) "next source" red; deleting `newAttempted` (always retry) turns (d) "one retry" red; BrowserPane without the wire turns
// (e) red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-browser-wire-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "browser-wire.ts"), path.join(webDir, "src", "lib", "browser-source.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom",
], { stdio: "pipe" });
const wire = await import(pathToFileURL(path.join(out, "browser-wire.js")).href);
const source = await import(pathToFileURL(path.join(out, "browser-source.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }
const server = await import(pathToFileURL(path.join(repo, "server", "backend", "electron", "server", "browser-wire.js")).href);

test("(a) the server's frame arrives byte-exactly", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 9, 8, 7, 0xff, 0xd9]);
  const header = { tab: "Ä-Tab", seq: 42, w: 520, h: 860, tc: 1.5, tr: 2, tb: 3 };
  const b = server.frameBinary(header, jpeg);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const f = wire.readFrame(buf);
  assert.deepEqual(f.header, header);
  assert.deepEqual([...f.jpeg], [...jpeg]);
  assert.equal(wire.readFrame(new ArrayBuffer(1)), null);
  const broken = new Uint8Array([0, 200, 1, 2]).buffer;
  assert.equal(wire.readFrame(broken), null, "a head longer than the buffer");
  const msg = server.sseAsMessage('event: hello\ndata: {"vid":"v1","tab":"T"}\n\n');
  assert.deepEqual(wire.readMessage(msg), { event: "hello", data: { vid: "v1", tab: "T" } });
  assert.equal(wire.readMessage("not json"), null);
});

test("(b) the wire's address", () => {
  assert.equal(wire.streamUrl("", "https://cbase.example/app/chat?x=1", "ab-12", "T1", true), "wss://cbase.example/api/browsers/ab-12/stream?tab=T1&measure=1");
  assert.equal(wire.streamUrl("http://127.0.0.1:7718", "http://localhost:3000/", "ab", "", false), "ws://127.0.0.1:7718/api/browsers/ab/stream");
});

test("(c) switch and summary of the measurement", () => {
  assert.equal(wire.measuringOn("?measure=1", null), true);
  assert.equal(wire.measuringOn("", "1"), true);
  assert.equal(wire.measuringOn("?measure=0", "0"), false);
  assert.equal(wire.MESS_TOGGLE, "cbase.measureBrowser");
  const frames = [
    { ta: 1000, n: 30 * 1024, tb: 900, tr: 890, tc: 880, px: 1040, w: 520 },
    { ta: 1100, n: 30 * 1024, tb: 950, tr: 945, tc: 930, px: 1040, w: 520 },
    { ta: 1101, n: 60 * 1024, tb: 1000, tr: 990, tc: 985, px: 390, w: 520 },
  ];
  const z = wire.messSummary(frames, [{ from: 990, image: 1100 }], 1000, { transport: "ws" });
  assert.equal(z.transport, "ws");
  assert.equal(z.images, 3);
  assert.equal(z.fps, 3);
  assert.equal(z.kb_med, 30);
  assert.equal(z.age_rel_med, 1, "age relative to the best image: (100, 150, 101) − 100, median");
  assert.equal(z.age_rel_p90, 50);
  assert.equal(z.bundle, 1);
  assert.equal(z.click_med, 110);
  assert.equal(z.images_sharp, 2);
  assert.equal(z.images_smooth, 1);
});

function world() {
  const ws = [], es = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.binaryType = ""; this.sent = []; ws.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; this.closed = true; }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class FakeES {
    constructor(url) { this.url = url; this.listeners = new Map(); es.push(this); }
    addEventListener(n, f) { if (!this.listeners.has(n)) this.listeners.set(n, []); this.listeners.get(n).push(f); }
    close() { this.closed = true; }
  }
  return { ws, es, FakeWS, FakeES };
}
// Wait for the retry (event: a second socket), not for a duration.
const until = async (fn) => { while (!fn()) await new Promise((r) => setImmediate(r)); };

test("(d) source: wire broken before opening ⇒ SSE, and the next source straight to SSE", () => {
  source._wireBrokenReset();
  const w = world();
  const q = source.streamSource({ wsUrl: "ws://x/ws", sseUrl: "http://x/stream", WS: w.FakeWS, ES: w.FakeES });
  const seen = [];
  q.addEventListener("hello", (ev) => seen.push(ev.data));
  assert.equal(w.ws.length, 1);
  assert.equal(q.send({ a: 1 }), false, "nothing goes over the wire before opening");
  w.ws[0].close();
  assert.equal(w.es.length, 1);
  assert.equal(q.transport, "sse");
  w.es[0].listeners.get("hello")[0]({ data: "{}" });
  assert.deepEqual(seen, ["{}"], "the listeners registered earlier are attached to the SSE stream");
  const q2 = source.streamSource({ wsUrl: "ws://x/ws", sseUrl: "http://x/stream", WS: w.FakeWS, ES: w.FakeES });
  assert.equal(w.ws.length, 1, "the next source tried the broken wire again");
  assert.equal(q2.transport, "sse");
  q.close(); q2.close();
  source._wireBrokenReset();
});

test("(d) source: an open wire delivers frames including bytes, send works; break ⇒ one retry, then SSE; close ⇒ none", async () => {
  source._wireBrokenReset();
  const w = world();
  const q = source.streamSource({ wsUrl: "ws://x/ws", sseUrl: "http://x/stream", WS: w.FakeWS, ES: w.FakeES, newAttemptMs: 0 });
  const frames = [], hello = [];
  q.addEventListener("frame", (ev) => frames.push(ev));
  q.addEventListener("hello", (ev) => hello.push(JSON.parse(ev.data)));
  w.ws[0].open();
  assert.equal(w.ws[0].binaryType, "arraybuffer");
  assert.equal(q.transport, "ws");
  w.ws[0].onmessage({ data: server.sseAsMessage('event: hello\ndata: {"vid":"v"}\n\n') });
  const b = server.frameBinary({ tab: "T", seq: 1, w: 4, h: 3 }, Buffer.from([0xff, 0xd8]));
  w.ws[0].onmessage({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  assert.deepEqual(hello, [{ vid: "v" }]);
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0].data), { tab: "T", seq: 1, w: 4, h: 3 });
  assert.deepEqual([...frames[0].bytes], [0xff, 0xd8]);
  assert.equal(q.send({ tab: "T", events: [] }), true);
  assert.equal(w.ws[0].sent[0], '{"tab":"T","events":[]}');

  w.ws[0].close();
  assert.equal(q.transport, "");
  await until(() => w.ws.length === 2);
  assert.equal(w.es.length, 0);
  w.ws[1].open();
  w.ws[1].close();
  assert.equal(w.ws.length, 2, "more than one retry");
  assert.equal(w.es.length, 1, "no SSE after the second break");
  assert.equal(q.transport, "sse");
  q.close();
  assert.ok(w.es[0].closed);

  const w2 = world();
  const q3 = source.streamSource({ wsUrl: "ws://x/ws", sseUrl: "http://x/stream", WS: w2.FakeWS, ES: w2.FakeES, newAttemptMs: 0 });
  w2.ws[0].open();
  q3.close();
  w2.ws[0].close();
  assert.equal(w2.ws.length + w2.es.length, 1, "the source reconnected after close()");
  source._wireBrokenReset();
});

test("(e) BrowserPane drives the wire: source, inputs and acks over the socket, measurement to /measurement", () => {
  const pane = fs.readFileSync(path.join(webDir, "src", "components", "BrowserPane.tsx"), "utf8");
  assert.ok(/import\s*\{[^}]*\bstreamSource\b[^}]*\}\s*from\s*"@\/lib\/browser-source"/.test(pane), "BrowserPane does not import streamSource");
  assert.ok(/streamSource\(\{\s*wsUrl:\s*streamUrl\(/.test(pane), "the stream does not go through streamSource with the wire address");
  assert.ok(!/new EventSource\(/.test(pane), "BrowserPane opens SSE bypassing the source");
  assert.ok(/esRef\.current\.send\(\{\s*tab:\s*selRef\.current,\s*events:\s*queueRef\.current\s*\}\)/.test(pane), "inputs do not go over the wire");
  assert.ok(/esRef\.current\.send\(\{\s*tab:\s*selRef\.current,\s*events:\s*\[\{\s*t:\s*"ack"/.test(pane), "acks do not go over the wire");
  assert.ok(/\.bytes\s*\?\?/.test(pane), "the frame handler does not take the wire's bytes");
  assert.ok(/api\(`\$\{base\}\/measurement`,\s*\{\s*method:\s*"POST"/.test(pane), "the measurement does not go to /api/browsers/measurement");
  assert.ok(/measuringOn\(/.test(pane), "the measurement switch is not asked");
});
