import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveChromium } from "../electron/server/browsers.js";
import { resolveFfmpeg } from "../electron/server/captures.js";
import { startServer } from "../electron/server/server.js";
import { showCaptures } from "../electron/server/chats/captures-show.js";

// End to end with REAL Chromium and REAL ffmpeg: the agent scan finds the browser through DevToolsActivePort, screenshot and
// recording run over the second CDP connection, ffmpeg builds a playable MP4. Skipped where Chromium or ffmpeg is missing
// (e.g. a bare CI).

const CHROMIUM = resolveChromium();
const FFMPEG = resolveFfmpeg();

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

test("integration: screenshot + MP4 capture against real Chromium", { skip: !CHROMIUM || !FFMPEG ? "Chromium or ffmpeg missing" : false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cape2e-"));
  let server;
  let chromium;
  try {
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Cap-E2E", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude" }) });

    // Start the browser the way the Playwright MCP leaves it: its own chat-<id> profile with --remote-debugging-port=0 —
    // the agent scan (3 s poll) then attaches by itself.
    const profile = path.join(root, "data-root", "data", "playwright-profiles", `chat-${chat.id}`);
    fs.mkdirSync(profile, { recursive: true });
    chromium = spawn(CHROMIUM, [
      "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
      "--no-first-run", "--no-default-browser-check", "--window-size=800,600",
      "data:text/html,<h1 style='font-size:80px'>cbase Capture-Test</h1>",
    ], { stdio: "ignore" });

    // Poll for a screenshot until the scan has connected — without a deadline (a test must not go red on a clock; the
    // suite is the emergency brake). Slowest path of the scan: if the first probe fails (`/json/version` aborts after 10 s
    // because Chromium does not answer yet under load), `startAgentScan` pauses the key for 30 s, then the next 3 s tick
    // comes — a 30 s deadline would fall short. The time to the first screenshot is a measurement line in the log, a
    // waiting line goes to stderr every 30 s.
    let shot = null;
    const t0 = Date.now();
    let reported = 0;
    while (!shot) {
      const res = await fetch(`${base}/api/chats/${chat.id}/captures`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      if (res.ok) { shot = await res.json(); break; }
      await res.text().catch(() => {});
      const s = Math.floor((Date.now() - t0) / 30_000);
      if (s > reported) { reported = s; console.error(`[waiting] ${s * 30} s so far: the scan is finding the browser`); }
      await new Promise((r) => setTimeout(r, 500));
    }
    t.diagnostic(`first screenshot after ${Date.now() - t0} ms (boot + scan)`);
    assert.ok(shot, "screenshot never happened — the scan did not find the browser");
    assert.ok(shot.capture.w > 0);
    const jpeg = Buffer.from(shot.data, "base64");
    assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8); // real JPEG

    // Recording: 4 fps, let it run until three frames are on disk (a fixed 1.5 s delivered too few screencast frames under
    // load), stop → playable MP4 (ftyp magic).
    const { recording } = await json(`${base}/api/chats/${chat.id}/captures/record`, { method: "POST", body: JSON.stringify({ action: "start", fps: 4 }) });
    const framesDir = path.join(root, "data-root", "data", "attachments", chat.id, "captures", recording.captureId, "frames");
    const tRec = Date.now();
    let reportedRec = 0;
    while ((fs.existsSync(framesDir) ? fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length : 0) < 3) {
      const s = Math.floor((Date.now() - tRec) / 30_000);
      if (s > reportedRec) { reportedRec = s; console.error(`[waiting] ${s * 30} s so far: three frames of the recording (${framesDir})`); }
      await new Promise((r) => setTimeout(r, 50));
    }
    const stopped = await json(`${base}/api/chats/${chat.id}/captures/record`, { method: "POST", body: JSON.stringify({ action: "stop" }) });
    assert.equal(stopped.capture.video, "video.mp4", `video missing: ${stopped.capture.error || "?"}`);
    assert.ok(stopped.capture.frames >= 3, `too few frames: ${stopped.capture.frames}`);
    assert.ok(stopped.samples.length >= 1);
    const head = await fetch(`${base}/api/chats/${chat.id}/captures/${stopped.capture.id}/file/video.mp4`, { headers: { Range: "bytes=0-15" } });
    assert.equal(head.status, 206);
    const magic = Buffer.from(await head.arrayBuffer());
    assert.equal(magic.subarray(4, 8).toString("ascii"), "ftyp", "not an MP4 container");

    // And the way to the user: the turn end shows both recordings of the main agent — screenshot, then video (called
    // directly here, the turn path is in captures-turn-end.test.js).
    assert.equal(showCaptures(chat.id), 2);
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(log.filter((e) => e.role === "capture").map((e) => JSON.parse(e.text).kind), ["screenshot", "recording"]);
  } finally {
    // Wait for the REAL end of the browser, not just send the signal: Chromium has helper processes that still write into
    // the profile for milliseconds. Cleaning up at once failed sporadically with `ENOTEMPTY` — regularly under load.
    // `maxRetries` alone was not enough.
    if (chromium) {
      try { chromium.kill("SIGKILL"); } catch {}
      await new Promise((resolve) => {
        if (chromium.exitCode !== null || chromium.signalCode) return resolve();
        const timer = setTimeout(resolve, 5000);
        chromium.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (server) server.closeAllConnections?.();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    // A test must not fail because its temp directory does not go away: a child process still writing causes ENOTEMPTY,
    // which says something about cleanup, not about the product. It is still not swallowed — otherwise junk piles up
    // unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
