// The WebSocket wire of the streamed browser and the live measurement.
//
// Checked: (a) the binary frame format (header length, header, JPEG) and the text messages from SSE blocks; (b) the
// client's inputs (unreadable => null, at most MAX_EVENTS) and the folding at the socket; (c) the measurement: only known
// fields, both caps (row and file — the younger half stays, cut at a line boundary); (d) against REAL Chromium over a
// real HTTP server with the upgrade from browsers.js: hello as text, frames binary (JPEG bytes, header with seq and
// measuring points), ack and click over the same socket — the click arrives, in order (mousePressed and mouseReleased as
// TWO messages); an unknown browser gets no wire; (e) the gateway (server/gateway/index.js) lets exactly this path through
// — otherwise every wire would end there and the client would silently fall back to SSE. The SSE path (fallback for old
// clients) is unchanged and stays covered by browser-last-tab / -image-stage / -flow-control.
//
// Counter-tests: writing the header length little-endian => (a) and (d) red; removing the MAX_EVENTS cap => (b) red;
// removing the file cap => (c) red; removing `if (way === "stream")` in browsers.js => (d) red (the handshake fails);
// removing `!isStream` from the gateway's upgrade switch or its pattern without `$` => (e) red.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { MAX_EVENTS, readInput, foldInputs, frameBinary, sseAsMessage } from "../electron/server/browser-wire.js";
import { FILE_MAX, ROW_MAX, appendMeasurement, sanitizeMeasurement } from "../electron/server/browser-measurement.js";
import { STREAM_UPGRADE, upgradeWay } from "../electron/server/runtime/upgrade-way.js";
import { attachTunnel } from "../electron/server/tunnel.js";
import { act, attachBrowserDevtools, closeBrowser, ensureUserBrowser, getBrowser, resolveChromium } from "../electron/server/browsers.js";

const CHROMIUM = resolveChromium();

test("(a) frame format: [u16 BE header length][header JSON][JPEG]; SSE block → {event, data}", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const header = { tab: "T", seq: 7, w: 520, h: 860, tc: 1, tr: 2, tb: 3 };
  const b = frameBinary(header, jpeg);
  const n = b.readUInt16BE(0);
  assert.deepEqual(JSON.parse(b.subarray(2, 2 + n).toString("utf8")), header);
  assert.deepEqual(b.subarray(2 + n), jpeg);
  assert.equal(b.length, 2 + n + jpeg.length);
  assert.equal(sseAsMessage('event: tabs\ndata: {"tabs":[1]}\n\n'), '{"event":"tabs","data":{"tabs":[1]}}');
  assert.equal(sseAsMessage("event: ping\ndata: {}\n\n"), '{"event":"ping","data":{}}');
  assert.equal(sseAsMessage(": comment\n\n"), null);
  assert.throws(() => frameBinary({ x: "a".repeat(70_000) }, jpeg), /too large/);
});

test("(b) inputs: unreadable => null, at most MAX_EVENTS; at the socket hovering replaces, wheel sums, clicks stay", () => {
  assert.equal(readInput("no json"), null);
  assert.equal(readInput('{"events":"x"}'), null);
  assert.deepEqual(readInput('{"tab":"T","events":[{"t":"ack","v":"v","seq":1}]}'), { tab: "T", events: [{ t: "ack", v: "v", seq: 1 }] });
  const many = readInput(JSON.stringify({ events: Array.from({ length: 2000 }, () => ({ t: "mouse", type: "mouseMoved" })) }));
  assert.equal(many.events.length, MAX_EVENTS);
  const q = [];
  for (let i = 0; i < 10; i++) foldInputs(q, { t: "mouse", type: "mouseWheel", x: i, y: 0, deltaX: 0, deltaY: 40 });
  foldInputs(q, { t: "mouse", type: "mousePressed", x: 1, y: 1 });
  foldInputs(q, { t: "mouse", type: "mouseMoved", x: 1, y: 1, buttons: 1 });
  foldInputs(q, { t: "mouse", type: "mouseMoved", x: 2, y: 2, buttons: 1 });
  foldInputs(q, { t: "mouse", type: "mouseReleased", x: 2, y: 2 });
  foldInputs(q, { t: "mouse", type: "mouseWheel", deltaY: 10 });
  assert.deepEqual(q.map((e) => e.type), ["mouseWheel", "mousePressed", "mouseMoved", "mouseReleased", "mouseWheel"]);
  assert.equal(q[0].deltaY, 400);
  assert.equal(q[0].x, 9);
  assert.equal(q[2].x, 2, "the dragged hover keeps the last position");
});

test("(c) measurement: only known fields, row cap and file cap", () => {
  const e = sanitizeMeasurement({ fps: 12.345, kb_med: "33", transport: "ws".repeat(40), malicious: "x", click_med: Infinity, age_rel_med: null }, Date.UTC(2026, 10, 2));
  assert.deepEqual(Object.keys(e).sort(), ["fps", "kb_med", "time", "transport"]);
  assert.equal(e.fps, 12.3);
  assert.equal(e.kb_med, 33);
  assert.equal(e.transport.length, 24);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-measurement-"));
  try {
    const file = path.join(dir, "m.jsonl");
    for (let i = 0; i < 400; i++) appendMeasurement(file, { images: i, fps: 1 }, { fileMax: 4000 });
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.length <= 4000, `the file grew past the cap: ${text.length}`);
    const rows = text.trim().split("\n").map((z) => JSON.parse(z));
    assert.equal(rows[rows.length - 1].images, 399, "the youngest row is missing");
    assert.ok(rows.length > 10, "the cut threw away more than the older half");
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].images, rows[i - 1].images + 1, "rows are missing in the middle or cut apart");
    assert.ok(FILE_MAX <= 1024 * 1024 && ROW_MAX <= 4096, "the caps have grown");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(e) the gateway lets the wire through: same pattern as B, the path without query; not neighbouring paths", () => {
  const index = fs.readFileSync(new URL("../../gateway/index.js", import.meta.url), "utf8");
  const m = /const isStream = (\/.+\/)\.test\(url\.pathname\);/.exec(index);
  assert.ok(m, "the gateway does not know the wire (isStream missing) — every upgrade to …/stream would end there with destroy");
  assert.match(index, /!isDevtools && !isStream\) \{ socket\.destroy\(\); return; \}/, "isStream is not in the upgrade switch");
  const gw = new RegExp(m[1].slice(1, -1));
  const id = "0f0f1234-aaaa-bbbb-cccc-000000000001";
  assert.ok(gw.test(`/api/browsers/${id}/stream`));
  assert.ok(STREAM_UPGRADE.test(`/api/browsers/${id}/stream?tab=T&measure=1`));
  assert.equal(upgradeWay(`/api/browsers/${id}/stream?tab=T`), "stream");
  for (const p of [`/api/browsers/${id}/streamx`, `/api/browsers/${id}/stream/x`, `/api/browsers/../stream`]) {
    assert.ok(!gw.test(p), `gateway lets ${p} through`);
    assert.notEqual(upgradeWay(p), "stream", `B takes ${p} as the wire`);
  }
});

async function waitFor(what, fn, { tickMs = 20 } = {}) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    const sec = Math.floor((Date.now() - start) / 30_000);
    if (sec > reported) { reported = sec; console.error(`[waiting] for ${sec * 30} s: ${what}`); }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

test("(f) both upgrade listeners as in server.js (tunnel first): the wire reaches browsers.js — unknown browser 404, not destroyed", async () => {
  const srv = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  attachTunnel(srv);
  attachBrowserDevtools(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const response = await new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${srv.address().port}/api/browsers/00000000-0000-0000-0000-000000000000/stream`);
      w.on("unexpected-response", (_rq, res) => resolve(res.statusCode));
      w.on("open", () => { w.close(); resolve("open"); });
      w.on("error", () => resolve("error"));
    });
    assert.equal(response, 404, "the tunnel listener destroyed the wire before browsers.js saw it");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("(d) real Chromium over the wire: hello as text, frames binary, ack and click on the same socket; unknown browser without a wire", { skip: !CHROMIUM ? "Chromium missing" : false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wire-"));
  const page = `<!doctype html><body style="margin:0;height:3000px" onclick="document.title='click'+(++window.n)"><script>window.n=0</script><h1>Wire</h1>`;
  const web = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(page); });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const srv = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  attachBrowserDevtools(srv);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  let id = "", proc = null, ws = null;
  try {
    const b = await ensureUserBrowser({ scopeKey: `test:wire:${path.basename(root)}`, profileDir: path.join(root, "profile"), label: "Wire", workspaceId: "ws-test" });
    id = b.id;
    const s = getBrowser(id);
    proc = s.proc;
    await waitFor("first tab", () => s.tabOrder.length >= 1);
    assert.deepEqual(await act(id, { type: "resize", width: 400, height: 300, dpr: 2 }), { ok: true });
    assert.deepEqual(await act(id, { type: "navigate", url: `http://127.0.0.1:${web.address().port}/` }), { ok: true });
    await waitFor("page loaded", () => (s.tabs.get(s.activeTargetId)?.url || "").startsWith("http://127.0.0.1"));

    // An unknown browser: no wire (the handshake fails with 404).
    const foreign = await new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${srv.address().port}/api/browsers/00000000-0000-0000-0000-000000000000/stream`);
      w.on("unexpected-response", (_rq, res) => resolve(res.statusCode));
      w.on("open", () => { w.close(); resolve("open"); });
      w.on("error", () => resolve("error"));
    });
    assert.equal(foreign, 404);

    const texts = [];
    const frames = [];
    let vid = "", tab = "";
    ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/api/browsers/${id}/stream?measure=1`);
    ws.on("message", (data, binary) => {
      if (!binary) {
        const n = JSON.parse(String(data));
        texts.push(n.event);
        if (n.event === "hello") { vid = n.data.vid; tab = n.data.tab; }
        return;
      }
      const buf = Buffer.from(data);
      const k = buf.readUInt16BE(0);
      const header = JSON.parse(buf.subarray(2, 2 + k).toString("utf8"));
      const jpeg = buf.subarray(2 + k);
      frames.push({ header, soi: jpeg[0] === 0xff && jpeg[1] === 0xd8, n: jpeg.length });
      ws.send(JSON.stringify({ tab, events: [{ t: "ack", v: vid, seq: header.seq }] }));
    });
    await waitFor("hello and a frame", () => texts.includes("hello") && frames.length > 0);
    assert.equal(texts[0], "hello", "the first text message is not hello");
    assert.ok(frames.every((f) => f.soi), "a frame carries no JPEG bytes");
    assert.ok(frames.every((f) => f.header.tab === tab && f.header.seq > 0 && f.header.w === 400), `wrong header: ${JSON.stringify(frames[0].header)}`);
    assert.ok(!("data" in frames[0].header), "the header still carries base64");

    // Two clicks, each as TWO messages (press, release) — delivery keeps the order, the title counts both.
    for (let i = 0; i < 2; i++) {
      ws.send(JSON.stringify({ tab, events: [{ t: "mouse", type: "mousePressed", x: 50, y: 50, button: "left", buttons: 1, clickCount: 1 }] }));
      ws.send(JSON.stringify({ tab, events: [{ t: "mouse", type: "mouseReleased", x: 50, y: 50, button: "left", buttons: 0, clickCount: 1 }] }));
    }
    const sid = s.tabs.get(tab).sessionId;
    await waitFor("two clicks arrived", async () => (await s.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sid)).result.value === "click2");
        const measured = frames.filter((f) => f.header.tc > 0);
    for (const f of measured) assert.ok(f.header.tb >= f.header.tr, `measuring points in the wrong order: ${JSON.stringify(f.header)}`);
    t.diagnostic(`wire: ${frames.length} frames, text ${texts.join(",")}, ${frames.map((f) => f.n).slice(0, 3).join("/")} B`);
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    if (id) closeBrowser(id);
    if (proc) {
      await new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode) return resolve();
        const timer = setTimeout(resolve, 5000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await new Promise((r) => web.close(r));
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// (g) Dialog deadline (an agent once hung for 20 minutes on a confirm). A tab served only by an agent (own CDP
// connection like Playwright, no viewer): if the agent does not answer, B declines after the deadline; if it answers
// itself, its answer stands. Counter-test: if B never attaches to such a tab, the confirm stays open — the test waits forever.
test("(g) dialog in a tab without a viewer: B declines after the deadline, the agent's own answer wins", { skip: !CHROMIUM ? "Chromium fehlt" : false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dialog-"));
  const page = `<!doctype html><title>start</title><script>setTimeout(() => { document.title = confirm("gone?") ? "yes" : "no"; }, 50)</script>`;
  const web = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(page); });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const saved = process.env.CBASE_BROWSER_DIALOG_DEADLINE_MS;
  process.env.CBASE_BROWSER_DIALOG_DEADLINE_MS = "300";
  let id = "", proc = null, raw = null;
  try {
    const b = await ensureUserBrowser({ scopeKey: `test:dialog:${path.basename(root)}`, profileDir: path.join(root, "profile"), label: "Dialog", workspaceId: "ws-test" });
    id = b.id;
    const s = getBrowser(id);
    proc = s.proc;
    await waitFor("first tab", () => s.tabOrder.length >= 1);
    // The agent's connection: raw, like Playwright via cdpEndpoint.
    raw = new WebSocket(s.cdp.wsUrl);
    await new Promise((ok, no) => { raw.once("open", ok); raw.once("error", no); });
    let n = 0;
    const open = new Map();
    const events = [];
    raw.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.id && open.has(m.id)) { open.get(m.id)(m); open.delete(m.id); } else if (m.method) events.push(m);
    });
    const send = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++n; open.set(i, ok); raw.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const title = async (sid) => (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sid)).result?.result?.value;
    const tabOfTheAgents = async () => {
      const { result } = await send("Target.createTarget", { url: "about:blank" });
      const { result: a } = await send("Target.attachToTarget", { targetId: result.targetId, flatten: true });
      await send("Page.enable", {}, a.sessionId);
      await send("Page.navigate", { url: `http://127.0.0.1:${web.address().port}/` }, a.sessionId);
      await waitFor("confirm open", () => events.some((e) => e.method === "Page.javascriptDialogOpening" && e.sessionId === a.sessionId));
      return a.sessionId;
    };

    // 1) The agent stays silent: B declines after the deadline.
    const s1 = await tabOfTheAgents();
    await waitFor("B declined", () => events.some((e) => e.method === "Page.javascriptDialogClosed" && e.sessionId === s1));
    assert.equal(events.find((e) => e.method === "Page.javascriptDialogClosed" && e.sessionId === s1).params.result, false);
    await waitFor("title no", async () => (await title(s1)) === "no");

    // 2) The agent answers itself within the deadline: its answer counts.
    const s2 = await tabOfTheAgents();
    await send("Page.handleJavaScriptDialog", { accept: true }, s2);
    await waitFor("title yes", async () => (await title(s2)) === "yes");
    assert.equal(events.find((e) => e.method === "Page.javascriptDialogClosed" && e.sessionId === s2)?.params.result, true, "B got ahead of the agent");
  } finally {
    if (saved === undefined) delete process.env.CBASE_BROWSER_DIALOG_DEADLINE_MS; else process.env.CBASE_BROWSER_DIALOG_DEADLINE_MS = saved;
    try { raw?.close(); } catch { /* closed */ }
    if (id) closeBrowser(id);
    if (proc) {
      await new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode) return resolve();
        const timer = setTimeout(resolve, 5000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await new Promise((r) => web.close(r));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
