// What B READS in a project's runtime and project folder, and what dockerd MOUNTS from there. The write side is held by
// runtime-write.test.js.
//
// THE FINDING. Runtime folder `<data>/projects/<pid>` and project folder are mounted rw in the main container (and the runtime folder
// in the copy container); a process there creates links and FIFOs. B wrote there only via the descriptor — but reading, mounting and
// choosing targets still went by path name: `readFileSync` followed a link (the bytes of B went to the requester, into the system
// prompt, into a channel) and stalled the event loop of B on a FIFO; a read manifest decided by itself where B writes and what it
// deletes; dockerd mounted a source through a link from B.
//
// WHAT HOLDS HERE — per site the link that should lead B out, and the check that nothing outside (`home`, a folder of B outside every
// runtime folder) is read, written, deleted or mounted:
//   (L)  runs/runtime-write.js openFromRuntimeFolder/readFromRuntimeFolder: file link and folder link on the way => EOUTSIDE,
//        FIFO => ENOFILE (no stall); outside `null`.
//   (M)  projectbox/instance.js mount sources: `<runtime>/home/.local -> <folder of B>` => no setup (SOURCE_REFERENCE), no `run`;
//        every `--mount` source of a `run` lies under its anchor after realpath; counter-test: without a link it is created.
//   (C1) file route of a capture: `captures/<cid>/poster.jpg -> <B file>` => 404 instead of the bytes; list: `manifest.json -> <B JSON>`
//        => not listed.
//   (C2) manifest with `id` "../../../../../../home/target": markSent does not write to B, prune deletes nothing in B (rm -r).
//   (C3) doFinalize: `manifest.json -> <B file>` => the capture ends with an error, the profile is free (no 409), nothing outside
//        overwritten.
//   (B1) browsers.js tab list at start: `cbase-tabs.json -> <B JSON>` => no start URL from B.
//   (B2) browsers.js scan of an instance root: `playwright-profiles -> <profiles of B>` and `chat-y/DevToolsActivePort -> <B file>`
//        => no request to the port a file of B names.
//   (K)  channels/messages.js: between resolving and depositing the container swaps `plan.md` for `-> <B file>` => nothing deposited;
//        another file at the place => "changed"; a FIFO => "not a file" without a stall.
//   (F)  dynworkflows/approval.js readJob: `approvals/<id>.json -> <B JSON>` => no job.
//   (G)  runs/system-prompt.js project memory of the main: `<project>/CLAUDE.md -> <B file>` => not in the prompt, `AGENTS.md` in the
//        project is; without an instance as before. (G2) the way outside the anchors, (G3) the read cap (sparse 1.9 GB).
//   (H)  projectbox/cli-home.js: `home -> <B folder>` => no folders and no `.claude.json` in B, copyLocal creates no `.local` there
//        either; `home/.local -> …` and `home/.local/share -> …` => `cp -a` deposits nothing in B.
//   (W)  workflows/worktree.js createGraphWorktree: `copy-worktrees -> <B folder>` => neither folder nor worktree in B.
//   (R)  runs/agents.js repoOfOneWorktrees (the delete path of a chat, worktrees from the journal of a dynamic workflow):
//        `worktrees/agent-a1/.git -> <B file>` and `<gitdir>/commondir -> <B file>` => no repo from B; FIFO => unknown, no stall;
//        without an instance as before.
//   (D)  code-route.js / runtime/http.js serveDownload: the download of the code view goes through ONE descriptor.
//   (Z)  runs/runtime-limit.js readInRuntimeFolder WITH an instance reads at most READ_MAX (32 MiB) — a sparse file above it =>
//        ETOOLARGE before reading; without an instance as before.
// Without a runtime folder (flat place) every site reads as before — one probe each in (L), (C2), (G); plus golden-runs.test.js.
//
// FIFO and stall: at the old state a reader on a FIFO (open without O_NONBLOCK) blocked the event loop — a test on it would hang there,
// not turn red. The red is therefore shown via the link; (L), (C1), (K), (G), (R) check the FIFO only after the link, i.e. only if the
// site is already repaired.
//
// COUNTER-TESTS. (a) The state before the repair: this file against the old tree plus only the new read functions of the sheet and the
// test seams (`_tabsRead`, `_channelFilesDeposit`, `_repoOf_oneWorktrees`) => (M), (C1), (C2), (C3), (B1), (B2), (K), (F), (G), (H),
// (W), (R) red, (L) green. (b) Per site the repair taken back (the old reader put in again), only the named check run:
//   projectbox/instance.js     `if (references.length) throw … SOURCE_REFERENCE` switched off                      => (M) red
//   captures.js               captureFile without descriptor (path as before)                                   => (C1) red
//                              readManifest with `readFileSync` instead of readFromRuntimeFolder                => (C1), (C2) red
//                              doFinalize without try/finally (the old three-liner)                             => (C3) red
//                              prune without `removeInRuntimeFolder`                                            => runtime-write.test.js red
//   browsers.js               tabsRead with `readFileSync`                                                      => (B1) red
//                              portFile with `readFileSync`/`statSync`                                          => (B2) red
//   channels/messages.js      `else if (d.source) channelSourceCopy(…)` deleted                                 => (K) red
//   dynworkflows/approval.js  readJob with `readFileSync`                                                       => (F) red
//   runs/system-prompt.js     project memory with `readFileSync`                                                => (G) red
//   projectbox/cli-home.js    createCliHome: `mkdirSync` instead of createFolderInRuntimeFolder                 => (H) red
//                              copyLocal: target with `mkdirSync`                                               => (H) red
//                              copyLocal: parent folder per entry with `mkdirSync`                              => (H) red
//   workflows/worktree.js     `fs.mkdirSync(basis, …)` instead of createWorktreeRoot                            => (W) red
//   runs/agents.js            repoOfOneWorktrees with `readFileSync`                                            => (R) red
// Dropped because the counter-test stayed GREEN (the line carried nothing): a folder reader via the descriptor in captures.js
// listCaptures and in the scan of browsers.js — every entry goes through readManifest or portFile there anyway.
//
// No clock: the tests wait for files, responses and one whole pass of the scanner (`cycle()`).
//
// Run:  cd server/backend && env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 \
//   CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap \
//   test/runtime-read.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DIRS, setDirs } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { readFromRuntimeFolder, openFromRuntimeFolder } from "../electron/server/runs/runtime-write.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { initCaptures, markSent, startRecording, stopRecording, takeScreenshot } from "../electron/server/captures.js";
import { _tabsRead, startAgentScan } from "../electron/server/browsers.js";
import { _channelFilesDeposit, resolveChannelFiles } from "../electron/server/channels/messages.js";
import { readJob } from "../electron/server/dynworkflows/approval.js";
import { projectMemoryPrompt, projectMemoryPromptIn } from "../electron/server/runs/system-prompt.js";
import { copyLocal, createCliHome } from "../electron/server/projectbox/cli-home.js";
import { _repoOf_oneWorktrees } from "../electron/server/runs/agents.js";
import { createGraphWorktree } from "../electron/server/workflows/worktree.js";
import { createInstance } from "../electron/server/projectbox/instance.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario, raises } from "./projectbox-scenario.mjs";

// ── Shared ───────────────────────────────────────────────────────────────────────────────────────────────────

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// Everything under `dir`: type, link target, size and sha256 — without following a link (FIFOs as "fifo").
function image(dir) {
  const out = {};
  const go = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const abs = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(abs)}`;
      else if (st.isDirectory()) { out[r] = "folder"; go(abs, r); }
      else if (st.isFIFO()) out[r] = "fifo";
      else out[r] = `${st.size}:${sha(fs.readFileSync(abs))}`;
    }
  };
  go(dir, "");
  return out;
}

// Outside: a folder of B outside every runtime folder — a "secret" file, an empty target folder.
function createHome(root) {
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "target"), { recursive: true });
  fs.writeFileSync(path.join(home, "secret.txt"), "B-SECRET\n");
  return home;
}
const reference = (target, where) => { fs.mkdirSync(path.dirname(where), { recursive: true }); fs.rmSync(where, { recursive: true, force: true }); fs.symlinkSync(target, where); };
const write = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const fifo = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.rmSync(p, { recursive: true, force: true }); const r = spawnSync("mkfifo", [p]); assert.equal(r.status, 0, String(r.stderr)); };

// A data folder without a server: DIRS as in startServer, the runtime folder of `p1` is ready.
async function withLocation(fn) {
  const old = DIRS;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lzl-")));
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  setDirs({ data, scratch: path.join(data, "scratch"), attachments: path.join(data, "attachments"), outputs: path.join(data, "outputs") });
  const home = createHome(root);
  const location = locationFor({ projectId: "p1", converted: true });
  fs.mkdirSync(location.root, { recursive: true });
  try { return await fn({ root, data, home, location, flat: locationFor({}) }); } finally {
    setDirs(old);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function attempts(fn) {
  try { const r = fn(); return { ok: true, r }; } catch (e) { return { ok: false, code: e?.code, e }; }
}
async function attemptsAsync(fn) {
  try { const r = await fn(); return { ok: true, r }; } catch (e) { return { ok: false, code: e?.code, e }; }
}

// The operation markers around a body (projectbox/operation.js), with a fake docker — never a real daemon.
async function withMarkers(fn, fd = null) {
  const values = { CBASE_CONTAINER: "1", CBASE_DIND: "1", ...(fd ? { CBASE_DOCKER_BIN: fd.bin } : {}) };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// A converted project in the chat of the server (as in runtime-write.test.js) — plus path and instance row.
async function projectInChat(ctx, chatId = ctx.chat.id) {
  const filePath = path.join(ctx.root, "workspace", "till");
  fs.mkdirSync(filePath, { recursive: true });
  const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: filePath }) });
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}` });
  await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  const w = locationFor({ projectId: p.id, converted: true });
  fs.mkdirSync(w.root, { recursive: true });
  return { w, path: filePath, projectId: p.id, inst: store.projectInstance(p.id, "main") };
}

// ── (L) The sheet ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(L) the sheet: reading only without a link — file, folder on the way, FIFO; outside `null`", async () => {
  await withLocation(({ home, location, data }) => {
    const prior = image(home);
    write(path.join(location.root, "real.txt"), "REAL");
    assert.equal(readFromRuntimeFolder(path.join(location.root, "real.txt"), "utf8"), "REAL");
    reference(path.join(home, "secret.txt"), path.join(location.root, "a.txt"));
    assert.equal(attempts(() => readFromRuntimeFolder(path.join(location.root, "a.txt"), "utf8")).code, "EOUTSIDE");
    assert.equal(attempts(() => openFromRuntimeFolder(path.join(location.root, "a.txt"))).code, "EOUTSIDE");
    reference(path.join(home), path.join(location.root, "o"));
    assert.equal(attempts(() => readFromRuntimeFolder(path.join(location.root, "o", "secret.txt"), "utf8")).code, "EOUTSIDE");
    // A link that stays inside the runtime folder as an intermediate part: allowed (the container writes it anyway).
    fs.mkdirSync(path.join(location.root, "inside"));
    write(path.join(location.root, "inside", "x.txt"), "X");
    reference(path.join(location.root, "inside"), path.join(location.root, "pointer"));
    assert.equal(readFromRuntimeFolder(path.join(location.root, "pointer", "x.txt"), "utf8"), "X");
    // FIFO: no stall.
    fifo(path.join(location.root, "f.txt"));
    assert.equal(attempts(() => readFromRuntimeFolder(path.join(location.root, "f.txt"), "utf8")).code, "ENOFILE");
    assert.deepEqual(image(home), prior);
    // Outside: `null`.
    write(path.join(data, "scratch", "f.txt"), "F");
    assert.equal(readFromRuntimeFolder(path.join(data, "scratch", "f.txt"), "utf8"), null);
    assert.equal(openFromRuntimeFolder(path.join(data, "scratch", "f.txt")), null);
  });
});

// ── (M) Mount sources ─────────────────────────────────────────────────────────────────────────────────────────────

const hostCalls = (fd) => fd.calls({ daemon: "host" }).map((a) => a.args);
const under = (p, r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
// Every `--mount` source of a `run` that lies under an anchor by its wording, and where it lies after realpath.
function mountsHinaus(fd, anchor) {
  const out = [];
  for (const args of hostCalls(fd).filter((a) => a[0] === "run")) {
    args.forEach((a, i) => {
      if (args[i - 1] !== "--mount") return;
      const src = /(?:^|,)src=([^,]*)/.exec(a)?.[1];
      if (!src) return;
      const a0 = anchor.find((x) => src !== x && under(src, x));
      if (!a0) return;
      let real = null;
      try { real = fs.realpathSync(src); } catch { real = "(missing)"; }
      if (!under(real, fs.realpathSync(a0))) out.push(`${src} → ${real}`);
    });
  }
  return out;
}

test("(M) mount sources: `home/.local -> a folder of B` — no setup, no `run`, no source out of the anchor; without a link it is created", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const b = path.join(s.home, ".local-b");
    write(path.join(b, "bin", "tool"), "B-TOOL\n");
    reference(b, path.join(s.location.home, ".local"));
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs });
    try {
      const anchor = [s.location.root, s.path];
      const r = await attemptsAsync(() => withOps(fd, () => createInstance(s.projectId, s.opts)));
      assert.deepEqual(mountsHinaus(fd, anchor), [], "a mount source led out of its anchor");
      assert.equal(r.ok, false, "the setup ran despite the link");
      assert.equal(r.code, "SOURCE_REFERENCE", r.e?.message);
      assert.match(r.e.message, /\.local/);
      assert.deepEqual(hostCalls(fd).filter((a) => a[0] === "run"), [], "no `run`");
      // Counter-test: without a link — a real folder — the container is created, and its sources stay in the anchor.
      fs.rmSync(path.join(s.location.home, ".local"));
      fs.mkdirSync(path.join(s.location.home, ".local"));
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready", row.error);
      assert.deepEqual(mountsHinaus(fd, anchor), []);
      assert.ok(hostCalls(fd).some((a) => a[0] === "run" && a.some((x) => x.includes(`src=${path.join(s.location.home, ".local")},`))), "cli-local is mounted");
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      fd.cleanUp();
    }
  });
});

// ── (C) captures.js ──────────────────────────────────────────────────────────────────────────────────────────────

function fakeJpeg(w, h) {
  const b = Buffer.alloc(16, 0);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(11, 4); b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9);
  return b;
}
function fakeBrowser(profileKeys) {
  const frame = { data: fakeJpeg(320, 200).toString("base64"), w: 320, h: 200 };
  const tab = { targetId: "t1", title: "Test page", url: "http://localhost:3100/", lastFrame: frame };
  const session = { scopeKey: "agent:x:9222", kind: "agent", tabs: new Map([["t1", tab]]), activeTargetId: "t1" };
  return {
    findAgentBrowser: (dir) => (profileKeys.some((k) => dir === `chat-${k}`) ? session : null),
    resolveTab: () => tab,
    tabList: () => [{ id: "t1", title: tab.title, url: tab.url, active: true }],
    captureTabScreenshot: async () => ({ data: fakeJpeg(640, 480).toString("base64"), w: 640, h: 480, url: tab.url, title: tab.title }),
    acquireFrameSink: async (s, t) => ({ getFrame: () => t.lastFrame, release: () => {} }),
  };
}
const manifest = (id, chatId, extra = {}) => JSON.stringify({ id, chatId, kind: "screenshot", createdAt: 1, sent: false, poster: "poster.jpg", ...extra });
const cid = () => `c-${crypto.randomUUID()}`;

test("(C1) file route and list of a capture: `poster.jpg -> B file` => 404 instead of the bytes, `manifest.json -> B JSON` => not listed", async () => {
  await withAgentsServer(async (ctx) => {
    const { w } = await projectInChat(ctx);
    const home = createHome(ctx.root);
    const caps = path.join(w.attachments, ctx.chat.id, "captures");
    const a = cid();
    write(path.join(caps, a, "manifest.json"), manifest(a, ctx.chat.id));
    reference(path.join(home, "secret.txt"), path.join(caps, a, "poster.jpg"));
    const b = cid();
    write(path.join(home, "b.json"), manifest(b, ctx.chat.id, { title: "B-DATA" }));
    reference(path.join(home, "b.json"), path.join(caps, b, "manifest.json"));
    const file = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/captures/${a}/file/poster.jpg`, { headers: { Connection: "close" } });
    const text = await file.text();
    assert.ok(!text.includes("B-SECRET"), "the file route delivered a file of B");
    assert.equal(file.status, 404, text);
    const list = await json(`${ctx.base}/api/chats/${ctx.chat.id}/captures`);
    assert.ok(!JSON.stringify(list).includes("B-DATA"), "the list read a manifest of B");
    assert.deepEqual(list.captures.map((c) => c.id), [a]);
    // Counter-test: a real file is delivered, also as a range.
    fs.rmSync(path.join(caps, a, "poster.jpg"));
    write(path.join(caps, a, "poster.jpg"), "PICT-0123456789");
    const real = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/captures/${a}/file/poster.jpg`, { headers: { Connection: "close" } });
    assert.equal(real.status, 200);
    assert.equal(await real.text(), "PICT-0123456789");
    const part = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/captures/${a}/file/poster.jpg`, { headers: { Connection: "close", Range: "bytes=5-8" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "0123");
    const above = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/captures/${a}/file/poster.jpg`, { headers: { Connection: "close", Range: "bytes=99-" } });
    assert.equal(above.status, 416);
    await above.text();
    // FIFO in place of the file: 404, no stall.
    fifo(path.join(caps, a, "video.mp4"));
    const f = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/captures/${a}/file/video.mp4`, { headers: { Connection: "close" } });
    assert.equal(f.status, 404, await f.text());
  });
});

test("(C2) a manifest with an outside `id`: markSent does not write to B, prune deletes nothing in B; flat as before", async () => {
  await withLocation(async ({ root, home, location, data }) => {
    try {
      initCaptures({ attachmentsOf: (id) => path.join(location.attachments, id), browser: fakeBrowser(["c1"]) });
      const caps = path.join(location.attachments, "c1", "captures");
      const out = "../../../../../../home/target";
      assert.equal(path.join(caps, "x", "..", out), path.join(home, "target"), "the way out is right");
      write(path.join(home, "target", "B-CAPTURE.txt"), "B");
      const prior = image(home);
      // markSent: the manifest decided where B writes.
      const m1 = cid();
      write(path.join(caps, m1, "manifest.json"), manifest(out, "c1"));
      const s = attempts(() => markSent("c1", m1, "x"));
      assert.deepEqual(image(home), prior, "markSent wrote a manifest to B");
      assert.equal(s.ok, false);
      assert.equal(s.e?.status, 404);
      // prune: 20 captures and one with an outward `id` (the oldest) — the screenshot breaks the cap.
      for (let i = 0; i < 20; i++) { const c = cid(); write(path.join(caps, c, "manifest.json"), manifest(c, "c1", { createdAt: 10 + i })); }
      fs.writeFileSync(path.join(caps, m1, "manifest.json"), manifest(out, "c1", { createdAt: 0 }));
      const shot = await attemptsAsync(() => takeScreenshot({ chatId: "c1", profileKey: "c1", tab: "" }));
      assert.deepEqual(image(home), prior, "prune deleted a folder in B");
      assert.ok(shot.ok, shot.e?.message);
      // Flat: reads the same manifest as before (a folder of B, no container) — markSent writes there.
      initCaptures({ attachmentsDir: path.join(data, "anh"), browser: fakeBrowser(["c2"]) });
      const f = cid();
      write(path.join(data, "anh", "c2", "captures", f, "manifest.json"), manifest(f, "c2"));
      assert.equal(markSent("c2", f, "Title").sent, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, "anh", "c2", "captures", f, "manifest.json"), "utf8")).caption, "Title");
    } finally { initCaptures({ attachmentsDir: path.join(root, "anh") }); }
  });
});

test("(C3) doFinalize: `manifest.json -> B file` — the capture ends with an error, nothing outside overwritten, the profile is free", async () => {
  await withLocation(async ({ root, home, location }) => {
    const ff = path.join(root, "fake-ffmpeg");
    fs.writeFileSync(ff, "#!/usr/bin/env node\nrequire(\"node:fs\").writeFileSync(process.argv[process.argv.length - 1], \"MP4-STUB\");\n");
    fs.chmodSync(ff, 0o755);
    const prevFf = process.env.CBASE_FFMPEG;
    process.env.CBASE_FFMPEG = ff;
    try {
      initCaptures({ attachmentsOf: (id) => path.join(location.attachments, id), browser: fakeBrowser(["c3"]) });
      const rec = await startRecording({ chatId: "c3", profileKey: "c3", tab: "", fps: 1, maxSeconds: 60 });
      const recDir = path.join(location.attachments, "c3", "captures", rec.captureId);
      fs.symlinkSync(path.join(home, "secret.txt"), path.join(recDir, "manifest.json"));
      const prior = image(home);
      const stop = await attemptsAsync(() => stopRecording({ profileKey: "c3" }));
      assert.deepEqual(image(home), prior, "the manifest overwrote a file of B");
      const fresh = await attemptsAsync(() => startRecording({ chatId: "c3", profileKey: "c3", tab: "", fps: 1, maxSeconds: 60 }));
      assert.ok(fresh.ok, `the profile stayed occupied: ${fresh.e?.message}`);
      assert.ok(stop.ok, stop.e?.message);
      assert.match(stop.r.capture.error, /Manifest/);
      const two = await stopRecording({ profileKey: "c3" });
      assert.equal(two.capture.error, undefined);
      assert.equal(two.capture.video, "video.mp4");
    } finally {
      initCaptures({ attachmentsDir: path.join(root, "anh") });
      if (prevFf === undefined) delete process.env.CBASE_FFMPEG; else process.env.CBASE_FFMPEG = prevFf;
    }
  });
});

// ── (B) browsers.js ──────────────────────────────────────────────────────────────────────────────────────────────

test("(B1) tab list at start: `cbase-tabs.json -> B JSON` — no start URL from a file of B", async () => {
  await withLocation(({ home, location }) => {
    const profile = path.join(location.browserProfiles, "proj-p1");
    write(path.join(home, "tabs.json"), JSON.stringify({ urls: ["https://secret.test/"] }));
    reference(path.join(home, "tabs.json"), path.join(profile, "cbase-tabs.json"));
    const r = attempts(() => _tabsRead(profile));
    assert.ok(!JSON.stringify(r.r ?? null).includes("secret.test"), "the tab list came from a file of B");
    assert.equal(r.code, "EOUTSIDE");
    fifo(path.join(profile, "cbase-tabs.json"));
    assert.equal(attempts(() => _tabsRead(profile)).code, "ENOFILE");
    fs.rmSync(path.join(profile, "cbase-tabs.json"));
    write(path.join(profile, "cbase-tabs.json"), JSON.stringify({ urls: ["https://own.test/"] }));
    assert.deepEqual(_tabsRead(profile).urls, ["https://own.test/"]);
  });
});

test("(B2) scan of an instance root: `playwright-profiles -> profiles of B`, `DevToolsActivePort -> B file` — no request to a port from B", async () => {
  const requests = [];
  const srv = http.createServer((req, res) => { requests.push(req.url); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    await withLocation(async ({ home, location }) => {
      // The profiles of B: an agent browser with a port file.
      write(path.join(home, "profile", "chat-x", "DevToolsActivePort"), `${port}\n/devtools/browser/x\n`);
      reference(path.join(home, "profile"), location.playwrightProfiles);
      const root = { root: location.playwrightProfiles, host: "127.0.0.1", identifier: "p1/main" };
      const scan = startAgentScan(() => [root]);
      try {
      await scan.cycle();
      assert.deepEqual(requests, [], "the scan asked a browser of B via the link of the root");
      // The root real, the port file of a profile a link to a file of B.
      fs.rmSync(location.playwrightProfiles);
      write(path.join(home, "port.txt"), `${port}\n`);
      reference(path.join(home, "port.txt"), path.join(location.playwrightProfiles, "chat-y", "DevToolsActivePort"));
      await scan.cycle();
      assert.deepEqual(requests, [], "the scan read the port from a file of B");
      // Counter-test: a real port file is asked.
      fs.rmSync(path.join(location.playwrightProfiles, "chat-y", "DevToolsActivePort"));
      write(path.join(location.playwrightProfiles, "chat-y", "DevToolsActivePort"), `${port}\n/devtools/browser/y\n`);
      await scan.cycle();
      assert.deepEqual(requests, ["/json/version"]);
      } finally { scan.stop(); }
    });
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

// ── (K) channels/messages.js ─────────────────────────────────────────────────────────────────────────────────────

test("(K) channel files: between resolving and depositing `plan.md` becomes a link to B — nothing deposited; changed and FIFO => error", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { path: filePath } = await projectInChat(ctx);
      const home = createHome(ctx.root);
      write(path.join(filePath, "plan.md"), "# Plan\n");
      await withMarkers(async () => {
        const chat = store.getChat(ctx.chat.id);
        const deposit = path.join(DIRS.channelFiles, "k-read");
        // Link.
        let resolved = resolveChannelFiles(chat, ["plan.md"]);
        reference(path.join(home, "secret.txt"), path.join(filePath, "plan.md"));
        let r = attempts(() => _channelFilesDeposit({ id: "k-read" }, resolved));
        const deposited = fs.existsSync(deposit) ? fs.readdirSync(deposit).map((n) => fs.readFileSync(path.join(deposit, n), "utf8")) : [];
        assert.ok(!deposited.some((t) => t.includes("B-SECRET")), "a file of B landed in the channel");
        assert.equal(r.ok, false);
        // Another file at the same place (the container swaps the content): changed, nothing deposited.
        fs.rmSync(path.join(filePath, "plan.md"));
        write(path.join(filePath, "plan.md"), "# Plan\n");
        resolved = resolveChannelFiles(chat, ["plan.md"]);
        fs.rmSync(path.join(filePath, "plan.md"));
        write(path.join(filePath, "plan.md"), "# Another plan, longer\n");
        r = attempts(() => _channelFilesDeposit({ id: "k-read" }, resolved));
        assert.equal(r.ok, false);
        assert.match(r.e.message, /geändert/);
        // FIFO: no stall.
        resolved = resolveChannelFiles(chat, ["plan.md"]);
        fifo(path.join(filePath, "plan.md"));
        r = attempts(() => _channelFilesDeposit({ id: "k-read" }, resolved));
        assert.equal(r.ok, false);
        assert.throws(() => resolveChannelFiles(chat, ["plan.md"]), /Keine Datei/);
        // Counter-test: the same file goes through.
        fs.rmSync(path.join(filePath, "plan.md"));
        write(path.join(filePath, "plan.md"), "# Plan\n");
        const ok = _channelFilesDeposit({ id: "k-read" }, resolveChannelFiles(chat, ["plan.md"]));
        assert.equal(fs.readFileSync(path.join(deposit, ok[0].file), "utf8"), "# Plan\n");
      }, fd);
      assert.deepEqual(fd.calls(), [], "no docker call");
    });
  } finally { fd.cleanUp(); }
});

// ── (F) dynworkflows/approval.js ─────────────────────────────────────────────────────────────────────────────────

test("(F) readJob: `approvals/<id>.json -> B JSON` — no job from a file of B", async () => {
  await withAgentsServer(async (ctx) => {
    const { w } = await projectInChat(ctx);
    const home = createHome(ctx.root);
    const rid = crypto.randomUUID();
    write(path.join(home, "job.json"), JSON.stringify({ script: "B-SCRIPT", callId: "" }));
    reference(path.join(home, "job.json"), path.join(w.outputs, ctx.chat.id, "workflows", "approvals", `${rid}.json`));
    assert.equal(readJob(ctx.chat.id, rid), null, "the job came from a file of B");
    const real = crypto.randomUUID();
    write(path.join(w.outputs, ctx.chat.id, "workflows", "approvals", `${real}.json`), JSON.stringify({ script: "OWN" }));
    assert.equal(readJob(ctx.chat.id, real).script, "OWN");
  });
});

// ── (G) runs/system-prompt.js ───────────────────────────────────────────────────────────────────────────────────

test("(G) project memory of the main: `<project>/CLAUDE.md -> B file` — not in the prompt; AGENTS.md in the project is; without an instance as before", async () => {
  await withAgentsServer(async (ctx) => {
    const { path: filePath, inst } = await projectInChat(ctx);
    const home = createHome(ctx.root);
    assert.ok(inst, "the instance row exists");
    reference(path.join(home, "secret.txt"), path.join(filePath, "CLAUDE.md"));
    write(path.join(filePath, "AGENTS.md"), "OWN-RULE\n");
    const mem = await projectMemoryPromptIn([filePath], inst);
    assert.ok(!mem.includes("B-SECRET"), "a file of B stood in the system prompt");
    assert.match(mem, /OWN-RULE/);
    // FIFO: no stall, the file is missing.
    fifo(path.join(filePath, "CLAUDE.md"));
    assert.match(await projectMemoryPromptIn([filePath], inst), /OWN-RULE/);
    // Without an instance the same block as projectMemoryPrompt.
    fs.rmSync(path.join(filePath, "CLAUDE.md"));
    write(path.join(filePath, "CLAUDE.md"), "PROJECT\n");
    assert.equal(await projectMemoryPromptIn([filePath], null), projectMemoryPrompt([filePath]));
  });
});

// ── (H) projectbox/cli-home.js ───────────────────────────────────────────────────────────────────────────────────

test("(H) CLI home: `home -> B`, `home/.local -> B`, `home/.local/share -> B` — no folders, no .claude.json, no cp -a in B", async () => {
  await withLocation(async ({ home, location, root }) => {
    const oldCfg = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      await withMarkers(async () => {
        const user = path.join(root, "user");
        write(path.join(user, ".claude.json"), JSON.stringify({ userID: "u-1", oauthAccount: { a: 1 }, hasCompletedOnboarding: true }));
        write(path.join(user, ".local", "bin", "tool"), "W\n");
        write(path.join(user, ".local", "share", "uv", "python"), "UV\n");
        const prior = image(home);
        // `home` itself a link to a folder of B.
        reference(path.join(home, "target"), location.home);
        const a = attempts(() => createCliHome("p1", { home: user }));
        assert.deepEqual(image(home), prior, "the CLI home was created in B");
        assert.equal(a.code, "EOUTSIDE");
        const a2 = attempts(() => copyLocal("p1", {}, { home: user }));
        assert.deepEqual(image(home), prior, "copyLocal created `.local` in B");
        assert.equal(a2.code, "EOUTSIDE");
        // `home/.local` a link: copyLocal deposits nothing in B.
        fs.rmSync(location.home);
        fs.mkdirSync(location.home);
        reference(path.join(home, "target"), path.join(location.home, ".local"));
        const b = attempts(() => copyLocal("p1", {}, { home: user }));
        assert.deepEqual(image(home), prior, "copyLocal deposited ~/.local in B");
        assert.equal(b.code, "EOUTSIDE");
        // `home/.local/share` a link: the target folder of an entry.
        fs.rmSync(path.join(location.home, ".local"));
        reference(path.join(home, "target"), path.join(location.home, ".local", "share"));
        const c = attempts(() => copyLocal("p1", {}, { home: user }));
        assert.deepEqual(image(home), prior, "cp -a followed the link `share`");
        assert.equal(c.code, "EOUTSIDE");
        // Counter-test: without links the CLI home and the copy are created.
        fs.rmSync(location.home, { recursive: true, force: true });
        const d = createCliHome("p1", { home: user });
        assert.equal(d.prefilled, true);
        const cj = JSON.parse(fs.readFileSync(path.join(location.home, ".claude", ".claude.json"), "utf8"));
        assert.equal(cj.userID, "u-1");
        assert.equal(fs.statSync(path.join(location.home, ".claude", ".claude.json")).mode & 0o777, 0o600);
        const e = copyLocal("p1", {}, { home: user });
        assert.deepEqual(e.copied.sort(), ["bin", "share/uv"]);
        assert.equal(fs.readFileSync(path.join(location.home, ".local", "share", "uv", "python"), "utf8"), "UV\n");
      });
    } finally { if (oldCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldCfg; }
  });
});

// ── (W) workflows/worktree.js ─────────────────────────────────────────────────────────────────────────────────────

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test",
  GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com",
  GIT_CONFIG_KEY_2: "init.defaultBranch", GIT_CONFIG_VALUE_2: "main",
};

test("(W) createGraphWorktree: `copy-worktrees -> a folder of B` — neither root nor worktree in B", async () => {
  const saved = Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GIT_ENV);
  try {
    await withLocation(async ({ home, location, root }) => {
      const proj = path.join(root, "app");
      write(path.join(proj, "README.md"), "# app\n");
      for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "start"]]) {
        const r = spawnSync("git", args, { cwd: proj, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
      }
      reference(path.join(home, "target"), path.join(location.root, "copy-worktrees"));
      const prior = image(home);
      const r = await attemptsAsync(() => createGraphWorktree({ startId: "read-w1", project: { name: "App", path: proj }, root: path.join(location.root, "copy-worktrees", "k1"), instance: null }));
      assert.deepEqual(image(home), prior, "the worktree root was created in B");
      assert.equal(r.code, "EOUTSIDE", r.e?.message);
      // Counter-test: without a link the worktree is created under the root.
      fs.rmSync(path.join(location.root, "copy-worktrees"));
      const info = await createGraphWorktree({ startId: "read-w2", project: { name: "App", path: proj }, root: path.join(location.root, "copy-worktrees", "k1"), instance: null });
      assert.ok(fs.existsSync(path.join(info.dir, "README.md")));
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ── (R) runs/agents.js repoOfOneWorktrees ───────────────────────────────────────────────────────────────────────

test("(R) worktree clean-up of a chat: `.git -> B file`, `commondir -> B file` => no repo from B; FIFO without a stall; without an instance as before", async () => {
  await withLocation(({ home, location }) => {
    const inst = { projectId: "p1", instance: "main", identifier: "p1/main" };
    const dir = path.join(location.worktrees, "agent-a1");
    fs.mkdirSync(dir, { recursive: true });
    const repoB = path.join(home, "repo");
    write(path.join(home, "git-file"), `gitdir: ${path.join(repoB, ".git", "worktrees", "agent-a1")}\n`);
    reference(path.join(home, "git-file"), path.join(dir, ".git"));
    assert.equal(_repoOf_oneWorktrees(dir, inst), "", "the repo came from a file of B");
    assert.equal(_repoOf_oneWorktrees(dir, null), repoB, "without an instance as before");
    // `.git` real, `commondir` below it a link to a file of B: not read — two levels above the gitdir.
    const gd = path.join(location.root, "gd", ".git", "worktrees", "agent-a1");
    fs.rmSync(path.join(dir, ".git"));
    write(path.join(dir, ".git"), `gitdir: ${gd}\n`);
    write(path.join(home, "common"), `${path.join(repoB, ".git")}\n`);
    reference(path.join(home, "common"), path.join(gd, "commondir"));
    assert.equal(_repoOf_oneWorktrees(dir, inst), path.join(location.root, "gd"), "commondir came from a file of B");
    assert.equal(_repoOf_oneWorktrees(dir, null), repoB, "commondir as before");
    // A real commondir within the area is read.
    fs.rmSync(path.join(gd, "commondir"));
    write(path.join(gd, "commondir"), "../../../../different/.git\n");
    assert.equal(_repoOf_oneWorktrees(dir, inst), path.join(location.root, "different"));
    // FIFO as `.git`: unknown, no stall.
    fifo(path.join(dir, ".git"));
    assert.equal(_repoOf_oneWorktrees(dir, inst), "");
  });
});

// ── (D) The download of the code view through ONE descriptor ───────────────────────────────────────────────────────────────
// code-route.js used to check beforehand via the descriptor (files.js downloadTarget with limit) and runtime/http.js serveDownload then
// loaded via the PATH. The swap happens here at the last possible moment — when the read stream is created or a file of the ZIP is
// opened (fs.createReadStream / fs.openSync, wrapped in this process): `a.txt` or `folder/image.png` becomes a link to a file of B.
// At the old state its bytes went out (red); now the old content (the descriptor is already open) or the entry is missing and is
// named in `_CBASE-SKIPPED.txt`. `image.png` is stored unpacked in the ZIP (STORED_EXT) — bytes of B would be readable.
// Without an instance unchanged (a second, non-converted project). COUNTER-TEST: code-route.js with the pre-check and serveDownload
// without `limit` (the old call) => red.
test("(D) download of a converted project — a swap for a link after the check never brings bytes of B out (file and folder); without an instance as before", async (t) => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { path: filePath, projectId } = await projectInChat(ctx);
      const home = createHome(ctx.root);
      write(path.join(home, "image-b.png"), "B-SECRET-IMAGE\n");
      write(path.join(filePath, "a.txt"), "OLD-CONTENT\n");
      write(path.join(filePath, "folder", "image.png"), "OLD-IMAGE\n");
      write(path.join(filePath, "folder", "c.png"), "C-IMAGE\n");
      await withMarkers(async () => {
        // Raw via node:http: even an aborted response (Content-Length does not fit the bytes of B) delivers its bytes.
        const fetch = (rel) => new Promise((resolve, reject) => {
          const req = http.get(`${ctx.base}/api/projects/${projectId}/files/download?path=${encodeURIComponent(rel)}`, { headers: { Connection: "close" } }, (res) => {
            const parts = [];
            const finished = () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("latin1") });
            res.on("data", (c) => parts.push(c));
            res.on("end", finished);
            res.on("aborted", finished);
            res.on("error", finished);
            res.on("close", finished);
          });
          req.on("error", reject);
        });
        let active = null;
        const swapped = [];
        const swap = (target, source) => { fs.rmSync(target); fs.symlinkSync(source, target); swapped.push(path.basename(target)); };
        const realCrs = fs.createReadStream;
        const realOpen = fs.openSync;
        const crs = t.mock.method(fs, "createReadStream", function (p, o) {
          if (active === "file" && !swapped.length && (String(p).endsWith(`${path.sep}a.txt`) || (p === null && o?.fd !== undefined))) swap(path.join(filePath, "a.txt"), path.join(home, "secret.txt"));
          return realCrs.call(fs, p, o);
        });
        const op = t.mock.method(fs, "openSync", function (p, ...r) {
          if (active === "folder" && !swapped.length && path.basename(String(p)) === "image.png") swap(path.join(filePath, "folder", "image.png"), path.join(home, "image-b.png"));
          return realOpen.call(fs, p, ...r);
        });
        try {
          active = "file";
          const d = await fetch("a.txt");
          active = null;
          assert.deepEqual(swapped, ["a.txt"], "the swap did not happen — the test measures nothing");
          assert.ok(!d.body.includes("B-SECRET"), `the bytes of B went out (file): ${d.status} ${d.body}`);
          assert.ok((d.status === 200 && d.body === "OLD-CONTENT\n") || d.status === 400, `${d.status} ${d.body}`);
          swapped.length = 0;
          active = "folder";
          const z = await fetch("folder");
          active = null;
          assert.deepEqual(swapped, ["image.png"], "the swap did not happen — the test measures nothing");
          assert.equal(z.status, 200);
          assert.ok(!z.body.includes("B-SECRET"), "the bytes of B went out (ZIP)");
          assert.ok(z.body.includes("C-IMAGE"), "the rest of the folder is missing in the ZIP");
          assert.ok(z.body.includes("_CBASE-SKIPPED.txt"), "the skipped entry is not named");
          // A FIFO and a link in the folder: skipped and named, no stall.
          fifo(path.join(filePath, "folder", "pipe"));
          reference(path.join(home, "secret.txt"), path.join(filePath, "folder", "pointer.txt"));
          const z2 = await fetch("folder");
          assert.equal(z2.status, 200);
          assert.ok(!z2.body.includes("B-SECRET"));
          assert.ok(z2.body.includes("pipe") && z2.body.includes("pointer.txt"), "FIFO and link are missing in the note file");
          // A special file as target: 400.
          const f = await fetch("folder/pipe");
          assert.equal(f.status, 400, f.body);
        } finally {
          active = null;
          crs.mock.restore();
          op.mock.restore();
        }
      }, fd);
      // Without an instance (a project without an instance row): today's way — a link INSIDE the project is followed.
      const free = path.join(ctx.root, "workspace", "free");
      write(path.join(free, "x.txt"), "FREE\n");
      fs.symlinkSync(path.join(free, "x.txt"), path.join(free, "y.txt"));
      const q = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Free", path: free }) });
      for (const rel of ["x.txt", "y.txt"]) {
        const r = await fetch(`${ctx.base}/api/projects/${q.id}/files/download?path=${rel}`, { headers: { Connection: "close" } });
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "FREE\n");
      }
    });
  } finally { fd.cleanUp(); }
});

// ── (G2) Project memory outside the anchors, link by link ─────────────────────────────────────────────────────────────────
// (G) holds `<project>/CLAUDE.md -> B file`. A file of the WORKSPACE (above the project folder, no anchor) used to be read by B with
// readFileSync — via a link of the user into the project folder (`ws/CLAUDE.md -> <project>/CLAUDE.md`) B followed the link the
// container had created (`-> home/secret.txt`). A way outside the anchors is now resolved link by link: if an intermediate lands in
// the area of the instance, B reads the rest only via the area read; otherwise O_NONBLOCK and only a regular file. COUNTER-TEST:
// system-prompt.js with readFileSync outside the anchors again => red.
test("(G2) `ws/CLAUDE.md -> <project>/CLAUDE.md -> B file` — not in the prompt; regular files are; FIFO in the workspace without a stall; without an instance as before", async () => {
  await withAgentsServer(async (ctx) => {
    const { path: filePath, inst } = await projectInChat(ctx);
    const home = createHome(ctx.root);
    const ws = path.join(ctx.root, "workspace");
    reference(path.join(home, "secret.txt"), path.join(filePath, "CLAUDE.md"));
    reference(path.join(filePath, "CLAUDE.md"), path.join(ws, "CLAUDE.md"));
    try {
      const mem = await projectMemoryPromptIn([ws, filePath], inst);
      assert.ok(!mem.includes("B-SECRET"), `a file of B stood in the system prompt: ${mem}`);
      // Counter-test: the same chain onto a regular file in the project stands in the prompt (once).
      fs.rmSync(path.join(filePath, "CLAUDE.md"));
      write(path.join(filePath, "CLAUDE.md"), "PROJECT-RULE\n");
      const mem2 = await projectMemoryPromptIn([ws, filePath], inst);
      assert.equal(mem2.split("PROJECT-RULE").length - 1, 1, mem2);
      // A regular workspace file stays; a FIFO there does not stall B.
      fs.rmSync(path.join(ws, "CLAUDE.md"));
      write(path.join(ws, "CLAUDE.md"), "WS-RULE\n");
      fifo(path.join(ws, "AGENTS.md"));
      const mem3 = await projectMemoryPromptIn([ws, filePath], inst);
      assert.match(mem3, /WS-RULE/);
      assert.match(mem3, /PROJECT-RULE/);
      fs.rmSync(path.join(ws, "AGENTS.md"));
      // Without an instance the same block as projectMemoryPrompt.
      assert.equal(await projectMemoryPromptIn([ws, filePath], null), projectMemoryPrompt([ws, filePath]));
    } finally {
      for (const n of ["CLAUDE.md", "AGENTS.md"]) fs.rmSync(path.join(ws, n), { force: true });
    }
  });
});

// (G3) The project memory of the main used to read CLAUDE.md/AGENTS.md WHOLE on EVERY turn (area read without a cap) and cut to
// 40,000 characters only afterwards — a sparse 1.9 GB file created by a process in the project container made B load it whole into
// memory per turn (and the string exceeded the V8 limit: the file was then MISSING in the prompt). Now B reads at most the beginning
// (MEMORY_MAX_BYTES = 40,000 x 4 bytes, one more to detect it), and the beginning stands cut and marked as cut in the prompt — in the
// project folder and on the way outside the anchors (workspace). The read seam counts only reads of the large file (fstat >= 1.9 GB):
// a whole readFileSync counts its size, readSync the bytes read — the server in the same process reads meanwhile, that does not count.
// COUNTER-TEST: runs/system-prompt.js with area read without a cap, readFileSync on the descriptor => red (1.9 GB counted, the
// beginning is missing in the prompt).
const MEMORY_LARGE = 1_900_000_000;
const MEMORY_CAP = 40_000 * 4;
async function atTheLargeRead(fn) {
  const old = { readFileSync: fs.readFileSync, readSync: fs.readSync };
  const large = (st) => st.size >= MEMORY_LARGE;
  let bytes = 0;
  fs.readFileSync = function (p, ...rest) {
    try { const st = typeof p === "number" ? fs.fstatSync(p) : fs.statSync(p); if (large(st)) bytes += st.size; } catch { /* does not count */ }
    return old.readFileSync.call(fs, p, ...rest);
  };
  fs.readSync = function (fd, ...a) {
    const n = old.readSync.call(fs, fd, ...a);
    try { if (large(fs.fstatSync(fd))) bytes += n; } catch { /* does not count */ }
    return n;
  };
  let value;
  try { value = await fn(); } finally { fs.readFileSync = old.readFileSync; fs.readSync = old.readSync; }
  return { bytes, value };
}
test("(G3) a sparse 1.9 GB CLAUDE.md in the project and an AGENTS.md in the workspace — B reads at most the cap, their beginning stands cut in the prompt; small as before", async () => {
  await withAgentsServer(async (ctx) => {
    const { path: filePath, inst } = await projectInChat(ctx);
    const ws = path.join(ctx.root, "workspace");
    const thin = (p, header) => { write(p, header); fs.truncateSync(p, MEMORY_LARGE); };
    try {
      thin(path.join(filePath, "CLAUDE.md"), "PROJECT-BEGINNING\n");
      const p = await atTheLargeRead(() => projectMemoryPromptIn([filePath], inst));
      assert.ok(p.bytes <= MEMORY_CAP + 1, `${p.bytes} bytes read of the CLAUDE.md in the project`);
      assert.match(p.value, /PROJECT-BEGINNING/, "the beginning of the large file is missing in the prompt");
      assert.match(p.value, /… \[truncated\]/);
      // Outside the anchors (workspace, link by link): the same cap.
      fs.rmSync(path.join(filePath, "CLAUDE.md"));
      thin(path.join(ws, "AGENTS.md"), "WS-BEGINNING\n");
      const w = await atTheLargeRead(() => projectMemoryPromptIn([ws, filePath], inst));
      assert.ok(w.bytes <= MEMORY_CAP + 1, `${w.bytes} bytes read of the AGENTS.md in the workspace`);
      assert.match(w.value, /WS-BEGINNING/);
      assert.match(w.value, /… \[truncated\]/);
      // Small: whole, without the marker.
      fs.rmSync(path.join(ws, "AGENTS.md"));
      write(path.join(filePath, "CLAUDE.md"), "SMALL-RULE\n");
      const k = await projectMemoryPromptIn([filePath], inst);
      assert.match(k, /SMALL-RULE/);
      assert.doesNotMatch(k, /truncated/);
    } finally {
      fs.rmSync(path.join(ws, "AGENTS.md"), { force: true });
      fs.rmSync(path.join(filePath, "CLAUDE.md"), { force: true });
    }
  });
});

// ── (Z) The read cap at the seam readInRuntimeFolder ───────────────────────────────────────────────────────────────────────
// With an instance the seam read every file whole — the file is written by the project container: a `script.js` it inflates to 1.9 GB
// (`truncate`), and a `cbase_dynamic_workflow` with `scriptPath` let B grow to 3.9 GB. Now the same cap as for the copy
// (runtime/fileAccess.js READ_MAX, 32 MiB): larger => ETOOLARGE BEFORE reading. Without an instance as before.
// COUNTER-TEST: runs/runtime-limit.js without the cap => red (the 33 MiB are read, no throw).
test("(Z) readInRuntimeFolder with an instance — a sparse file above the cap throws ETOOLARGE without being read; small and without an instance as before", async () => {
  const { RUNTIME_READ_MAX, readInRuntimeFolder } = await import("../electron/server/runs/runtime-limit.js");
  await withLocation(async ({ location }) => {
    const inst = { projectId: "p1", instance: "main", identifier: "p1/main" };
    assert.equal(RUNTIME_READ_MAX, 32 * 1024 * 1024, "the cap is that of the copy (READ_MAX)");
    const large = path.join(location.root, "outputs", "c1", "workflows", "wf_1", "script.js");
    fs.mkdirSync(path.dirname(large), { recursive: true });
    fs.writeFileSync(large, "");
    fs.truncateSync(large, RUNTIME_READ_MAX + 1024 * 1024); // sparse: 33 MiB without disk
    assert.throws(() => readInRuntimeFolder(large, { instance: inst, encoding: "utf8" }), (e) => e.code === "ETOOLARGE" && e.limit === RUNTIME_READ_MAX);
    const small = path.join(path.dirname(large), "small.js");
    fs.writeFileSync(small, "return 1;\n");
    assert.equal(readInRuntimeFolder(small, { instance: inst, encoding: "utf8" }), "return 1;\n");
    // Without an instance the seam reads as before — also the large file (only someone who runs in B anyway writes there).
    assert.equal(readInRuntimeFolder(large, { instance: null }).length, RUNTIME_READ_MAX + 1024 * 1024);
  });
});
