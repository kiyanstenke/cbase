import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ffmpegDeadline, initCaptures, listCaptures, markSent, resolveFfmpeg, startRecording, stopRecording, takeScreenshot, captureFilePath } from "../electron/server/captures.js";

// Unit tests of the capture machinery WITHOUT Chromium: browser access is injectable, ffmpeg is replaced by a stub script
// (CBASE_FFMPEG) that only writes the output file.

// Minimal "JPEG": only SOI + SOF0 markers so that jpegSize() finds the dimensions (ffmpeg is stubbed).
function fakeJpeg(w, h) {
  const b = Buffer.alloc(16, 0);
  b[0] = 0xff; b[1] = 0xd8;           // SOI
  b[2] = 0xff; b[3] = 0xc0;           // SOF0
  b.writeUInt16BE(11, 4);             // segment length
  b[6] = 8;                           // precision
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

// `turns` counts the handles of the recording tick after a frame: each handle writes a frame to disk in the same tick
// (captures.js tick). A test waits for this count instead of a duration — the tick's clock belongs to the product, the
// test's does not.
function fakeBrowser({ frame } = {}) {
  const tab = { targetId: "t1", title: "Test page", url: "http://localhost:3100/", lastFrame: frame };
  const session = { scopeKey: "agent:chat-c1:9222", kind: "agent", tabs: new Map([["t1", tab]]), activeTargetId: "t1" };
  const b = {
    tab,
    turns: 0,
    findAgentBrowser: (dir) => (dir === "chat-c1" ? session : null),
    resolveTab: (s, ref) => (!String(ref || "").trim() || ref === "1" ? tab : null),
    tabList: () => [{ id: "t1", title: tab.title, url: tab.url, active: true }],
    captureTabScreenshot: async () => ({ data: fakeJpeg(640, 480).toString("base64"), w: 640, h: 480, url: tab.url, title: tab.title }),
    acquireFrameSink: async (s, t) => ({
      getFrame: () => { b.turns += 1; return t.lastFrame || null; },
      release: () => {},
    }),
  };
  return b;
}

// No deadline: if it hangs, the suite ends the run.
async function until(fn) {
  while (!fn()) await new Promise((r) => setTimeout(r, 5));
}

function stubFfmpeg(root) {
  const bin = path.join(root, "fake-ffmpeg");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nconst out = process.argv[process.argv.length - 1];\nrequire("node:fs").writeFileSync(out, "MP4-STUB-CONTENT");\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("screenshot: manifest + poster.jpg on disk, image data returned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  initCaptures({ attachmentsDir: root, browser: fakeBrowser() });
  const { capture, data } = await takeScreenshot({ chatId: "c1", profileKey: "c1", tab: "" });
  assert.equal(capture.kind, "screenshot");
  assert.equal(capture.w, 640);
  assert.ok(data.length > 0);
  const poster = captureFilePath("c1", capture.id, "poster.jpg");
  assert.ok(poster && fs.existsSync(poster));
  assert.equal(listCaptures("c1")[0].id, capture.id);
  // Only poster.jpg/video.mp4 are deliverable — everything else (traversal!) leads nowhere.
  assert.equal(captureFilePath("c1", capture.id, "manifest.json"), null);
  assert.equal(captureFilePath("c1", "../../../etc", "poster.jpg"), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("No browser → 409 with an English hint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  initCaptures({ attachmentsDir: root, browser: fakeBrowser() });
  await assert.rejects(takeScreenshot({ chatId: "c9", profileKey: "c9", tab: "" }), (e) => e.status === 409 && /No browser/.test(e.message));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the chat's browser: without an agent browser the main agent takes the chat browser, a subagent never", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  const b = fakeBrowser();
  const chatSession = { scopeKey: "chat:c2", kind: "user", tabs: b.tab ? new Map([["t1", b.tab]]) : new Map(), activeTargetId: "t1" };
  b.findChatBrowser = (id) => (id === "c2" ? chatSession : null);
  initCaptures({ attachmentsDir: root, browser: b });
  const { capture } = await takeScreenshot({ chatId: "c2", profileKey: "c2", tab: "" });
  assert.equal(capture.kind, "screenshot");
  await assert.rejects(takeScreenshot({ chatId: "c2", profileKey: "c2-agent-1", tab: "" }), (e) => e.status === 409);
  fs.rmSync(root, { recursive: true, force: true });
});

test("recording: the ticker writes frames, stop produces video + check frames", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  const prevFf = process.env.CBASE_FFMPEG;
  process.env.CBASE_FFMPEG = stubFfmpeg(root);
  try {
    const b = fakeBrowser({ frame: { data: fakeJpeg(800, 600).toString("base64"), w: 800, h: 600 } });
    initCaptures({ attachmentsDir: root, browser: b });
    const rec = await startRecording({ chatId: "c1", profileKey: "c1", tab: "", fps: 8, maxSeconds: 60 });
    assert.ok(rec.captureId.startsWith("c-"));
    // A double start is taboo while the recording runs.
    await assert.rejects(startRecording({ chatId: "c1", profileKey: "c1" }), (e) => e.status === 409);
    await until(() => b.turns >= 2); // two frames written
    const { capture, samples } = await stopRecording({ profileKey: "c1" });
    assert.equal(capture.kind, "recording");
    assert.ok(capture.frames >= 2, `too few frames: ${capture.frames}`);
    assert.equal(capture.video, "video.mp4");
    assert.equal(capture.autoStopped, false);
    assert.ok(samples.length >= 1 && samples.length <= 4);
    const video = captureFilePath("c1", capture.id, "video.mp4");
    assert.equal(fs.readFileSync(video, "utf8"), "MP4-STUB-CONTENT");
    // Raw frames are cleaned up, a second stop finds nothing.
    assert.ok(!fs.existsSync(path.join(path.dirname(video), "frames")));
    await assert.rejects(stopRecording({ profileKey: "c1" }), (e) => e.status === 404);
  } finally {
    if (prevFf === undefined) delete process.env.CBASE_FFMPEG; else process.env.CBASE_FFMPEG = prevFf;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-stop at maxSeconds: a stop afterwards returns autoStopped:true", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  const prevFf = process.env.CBASE_FFMPEG;
  process.env.CBASE_FFMPEG = stubFfmpeg(root);
  try {
    const b = fakeBrowser({ frame: { data: fakeJpeg(320, 200).toString("base64"), w: 320, h: 200 } });
    initCaptures({ attachmentsDir: root, browser: b });
    await startRecording({ chatId: "c1", profileKey: "c1", fps: 8, maxSeconds: 1 }); // Deckel: 8 Frames
    // The eighth handle triggers the auto-stop in the same tick. One tick beyond the cap would find the recording finalized —
    // `frames` would stay 8, otherwise the check below would fail.
    await until(() => b.turns >= 8);
    const { capture } = await stopRecording({ profileKey: "c1" });
    assert.equal(capture.autoStopped, true);
    assert.equal(capture.frames, 8);
  } finally {
    if (prevFf === undefined) delete process.env.CBASE_FFMPEG; else process.env.CBASE_FFMPEG = prevFf;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ffmpeg missing → 424 at start, screenshot still works", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  const prevFf = process.env.CBASE_FFMPEG;
  process.env.CBASE_FFMPEG = path.join(root, "exists-not");
  try {
    assert.equal(resolveFfmpeg(), null);
    initCaptures({ attachmentsDir: root, browser: fakeBrowser() });
    await assert.rejects(startRecording({ chatId: "c1", profileKey: "c1" }), (e) => e.status === 424 && /ffmpeg/.test(e.message));
    const { capture } = await takeScreenshot({ chatId: "c1", profileKey: "c1" });
    assert.equal(capture.kind, "screenshot");
  } finally {
    if (prevFf === undefined) delete process.env.CBASE_FFMPEG; else process.env.CBASE_FFMPEG = prevFf;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retention: cap 20, sent captures survive pruning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-"));
  initCaptures({ attachmentsDir: root, browser: fakeBrowser() });
  const first = (await takeScreenshot({ chatId: "c1", profileKey: "c1" })).capture;
  markSent("c1", first.id, "Important — stays");
  assert.equal(listCaptures("c1").find((m) => m.id === first.id).caption, "Important — stays");
  // Sending twice is taboo.
  assert.throws(() => markSent("c1", first.id, "again"), (e) => e.status === 409);
  for (let i = 0; i < 22; i++) await takeScreenshot({ chatId: "c1", profileKey: "c1" });
  const all = listCaptures("c1");
  assert.ok(all.length <= 20, `cap exceeded: ${all.length}`);
  assert.ok(all.some((m) => m.id === first.id && m.sent), "sent capture was pruned");
  fs.rmSync(root, { recursive: true, force: true });
});

test("ffmpeg deadline grows with the recording: 5 min × 8 frames/s gets more than 60 s, cap 10 min", () => {
  assert.equal(ffmpegDeadline(0), 60_000);
  assert.ok(ffmpegDeadline(300 * 8) > 4 * 60_000, "the long recording (2,400 frames) needs well over 60 s");
  assert.equal(ffmpegDeadline(1e9), 600_000);
});
