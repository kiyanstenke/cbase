// What B WRITES into the runtime folder of a project: runs/runtime-write.js and every site that writes, copies, creates, renames or
// deletes through it.
//
// THE FINDING. The runtime folder `<data>/projects/<pid>` is mounted rw in the main and the copy container (projectbox/setup mount
// rule "runtime"); a process there creates arbitrary links. The readers of B went through the descriptor, the writers did not:
// `mkdirSync` + `writeFileSync`, `copyFileSync`, `renameSync`, `cpSync` and `rmSync` by path name followed a link — as intermediate
// folder, as file, also dangling — with the uid of B, out of the folder.
//
// WHAT HOLDS HERE — per site a link that should steer a write of B OUT, and the check that outside (`home`, a folder of B outside every
// runtime folder) afterwards exactly the same stands byte for byte (`image`: type, link target, size and sha256 of every file) and
// nothing was added:
//   (B)  the sheet itself: folder link, file link, dangling file and folder link; outside `false` and nothing.
//   (1)  providers/agent-runtime.js writeOutputFile            `outputs/<chat> -> home/target`
//   (2)  runs/outputs.js createOutputLocation                     `outputs -> home/target`
//   (3)  toolchain/playwright.js playwrightMcpEntry            `playwright-configs/chat-c1-h.json -> home/secret.txt`
//   (4)  toolchain/mcp-config.js writeMcpConfig                `scratch/c1.mcp.json -> home/fresh.json` (dangling)
//   (5)  browsers.js tab list (`_tabsSave`)                  `cbase-tabs.json -> home/secret.txt`
//   (6)  browsers.js profile before start (`_profilePrepare`)  `browser-profiles/proj-p1 -> home/wsprofile` (locks of a live
//        Chromium in B)
//   (7)  captures.js screenshot, manifest, recording           `captures -> home/target`, `manifest.json -> home/b.json`,
//        `video.mp4 -> home/secret.txt` (ffmpeg `-y`), `poster.jpg -> home/secret.txt` (poster of the recording)
//   (8)  browser-profiles.js prepareChatProfile                `Default/Cookies.cbase-tmp -> home/secret.txt` (fixed temp name, no
//        race), `Default/Local Storage -> home/target`, `chat-c2 -> home/target`
//   (9)  browser-profiles.js saveChatLogins (way back)         `Default/Cookies -> home/secret.txt`, `…/leveldb -> home/target` — the
//        file of B would land in the stock and on the next run in the runtime folder
//   (10) browser-profiles.js reapUnusedChatProfiles, removeChatProfile   `playwright-profiles -> home/profile` (rm -r outwards);
//        releaseStaleLocks (deleteLock)                     `chat-c1 -> home/wsprofile` with a dead lock
//   (11) runs/agents.js cleanUpAgent                        `playwright-profiles -> home/profile` (rm -r outwards)
//   (12) runs/runtime-location.js fetchAttachmentAtLocation/copyAttachmentsTo   `attachments -> home/target`
//   (13) runs/runtime-location.js bringAlongChat                    links do not move from the runtime folder to the flat place;
//        `attachments -> home/target` at the destination
//   (14) runs/session-transfer.js pullClaudeSession, removeCopies   `home/.claude/projects -> home/target`, `<sid>.jsonl ->
//        home/secret.txt` (back to B), `projects/<slug> -> home/target` (rm -r outwards)
//   (15) channels/messages.js stageChannelFiles        `attachments/<chat>/channel-… -> home/fresh.txt` (dangling)
//   (16) workflows/graph-start.js attachments of the child chat   `attachments -> home/target`
//   (17) workflows/graph-background.js output file           `graph-<id>.json -> home/fresh.json` (dangling)
//   (18) chats/routes.js upload                                 `attachments/<chat> -> home/target` => 409
//   (19) dynworkflows/run.js script, approval.js card, run.js result   `outputs/<chat>/workflows -> home/target` => 409;
//        `<runId>/result.json -> home/secret.txt`
//   (20) captures.js prune                                     the container swaps `captures` between list and delete for
//        `-> home/caps` (same names in B) — the race without a clock via the path building (`attachmentsOf`, only from prune)
//   (21) projectbox/instance.js placeholders of the single-file mounts (`_placeholder`, at every setup: loss, re-creation, copy)
//        `home/.claude -> home/claude-b` — no empty CLAUDE.md in B, no empty file of B deleted
// Without a runtime folder (flat place) every site writes as before — one probe each in (B), (1), (2), (3), (8).
// Not checked here: chats/routes.js, the text extract `<file>.txt` next to an upload — the same guard as the upload, reachable only in
// the race between two writes of the SAME request (the name carries `Date.now()`); covered via (B).
//
// COUNTER-TESTS. (a) The state before the repair: this file against the old tree plus only the new sheet and the test seams
// (`_tabsSave`, `_profilePrepare`, `_attachmentsCopy`, `_runEnds`, `_placeholder`) => (1)–(21) red, (B) green. (b) Per site the guard
// removed at its line (the old path writer put in again), the file run. Sabotage = the helper call replaced by `false`, only the named
// check run (`--test-name-pattern`):
//   providers/agent-runtime.js writeOutputFile                       => (1) red
//   runs/outputs.js createOutputLocation                              => (2) red
//   toolchain/playwright.js playwrightMcpEntry                        => (3) red
//   toolchain/mcp-config.js writeMcpConfig                            => (4) red
//   browsers.js tab list => (5) red; creating the profile => (6) red; deleting the locks alone => (6) GREEN — the creating before it
//                                             already throws (depth against the race in between; (B))
//   captures.js manifest => (7); screenshot (folder + image) => (7); recording (`own`) => (7); poster of the recording => (7);
//                                             prune => (20) — each red
//   browser-profiles.js copyFileAtomic => (8)+(9) red; cloneTree => (8) red; creating the chat profile => (8) red;
//                                             removeChatProfile, reap, deleteLock => (10) each red; replaceTree (removeTree/renamePath)
//                                             and the accessory files (`-journal`) alone => GREEN — the clone before it already throws,
//                                             both only act in the race (depth; (B))
//   runs/agents.js cleanUpAgent                                       => (11) red
//   runs/runtime-location.js copyFallsMissing => (12) red; move => (13) red
//   runs/session-transfer.js copyFile, copyFolder, removeCopies => (14) each red
//   channels/messages.js stageChannelFiles                            => (15) red
//   workflows/graph-start.js copyAttachments                          => (16) red
//   workflows/graph-background.js output file                         => (17) red
//   chats/routes.js upload                                            => (18) red
//   dynworkflows/run.js script => (19) red; result => (19) red
//   dynworkflows/approval.js card                                     => (19) red
//   projectbox/instance.js placeholder: folder => (21) red; file => (21) red; deleting the empty one => (21) red
// Whole sites (all guards of the site at once): browsers.js profile before start => (6) red; instance.js folder + file => (21) red.
// The static guard next to it: runtime-write-guard.test.js.
//
// No clock: the tests wait for files, states and the quiet of the server (waitForTruthy without a deadline).
//
// Run:  cd server/backend && env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 \
//   CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap \
//   test/runtime-write.test.js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DIRS, setDirs } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import {
  renameInRuntimeFolder, removeInRuntimeFolder, cloneWithoutReference, copyInRuntimeFolder, createFolderInRuntimeFolder,
  readFromRuntimeFolder, openFromRuntimeFolder, writeInRuntimeFolder,
} from "../electron/server/runs/runtime-write.js";
import { locationFor, fetchAttachmentAtLocation, copyAttachmentsTo, bringAlongChat } from "../electron/server/runs/runtime-location.js";
import { createOutputLocation } from "../electron/server/runs/outputs.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";
import { playwrightMcpEntry } from "../electron/server/toolchain/playwright.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { _profilePrepare, _tabsSave, startAgentScan } from "../electron/server/browsers.js";
import { initCaptures, markSent, startRecording, stopRecording, takeScreenshot } from "../electron/server/captures.js";
import { prepareChatProfile, reapUnusedChatProfiles, releaseStaleLocks, removeChatProfile, saveChatLogins } from "../electron/server/browser-profiles.js";
import { cleanUpAgent } from "../electron/server/runs/agents.js";
import { removeCopies, sessionSlug, pullClaudeSession } from "../electron/server/runs/session-transfer.js";
import { stageChannelFiles } from "../electron/server/channels/messages.js";
import { _attachmentsCopy } from "../electron/server/workflows/graph-start.js";
import { _runEnds } from "../electron/server/workflows/graph-background.js";
import { _placeholder } from "../electron/server/projectbox/instance.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";

// ── Shared ───────────────────────────────────────────────────────────────────────────────────────────────────

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// Everything under `dir`: type, link target, size and sha256 — without following a link.
function image(dir) {
  const out = {};
  const go = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const abs = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(abs)}`;
      else if (st.isDirectory()) { out[r] = "folder"; go(abs, r); }
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

// A link at `where` — what stood there (an empty folder the product created) gives way to it.
const reference = (target, where) => { fs.mkdirSync(path.dirname(where), { recursive: true }); fs.rmSync(where, { recursive: true, force: true }); fs.symlinkSync(target, where); };
const write = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const lstatOrNull = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) ?? null;

// A data folder without a server (the sheet sites): DIRS as in startServer, the runtime folder of `p1` is ready.
async function withLocation(fn) {
  const old = DIRS;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lzs-")));
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

// Does `fn` throw — and if so, which code? Evaluated only after the check of the outside (at the old state the image is red).
function attempts(fn) {
  try { const r = fn(); return { ok: true, r }; } catch (e) { return { ok: false, code: e?.code, e }; }
}
async function attemptsAsync(fn) {
  try { const r = await fn(); return { ok: true, r }; } catch (e) { return { ok: false, code: e?.code, e }; }
}

// ── (B) The sheet ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(B) the sheet: no link leads a writer out — folder, file, dangling; outside `false` and nothing happened", async () => {
  await withLocation(({ home, location, data }) => {
    const prior = image(home);
    // Folder link as an intermediate part
    reference(path.join(home, "target"), path.join(location.root, "a"));
    assert.equal(attempts(() => writeInRuntimeFolder(path.join(location.root, "a", "x.txt"), "X")).code, "EOUTSIDE");
    assert.equal(attempts(() => createFolderInRuntimeFolder(path.join(location.root, "a", "n", "m"))).code, "EOUTSIDE");
    // File link in place of the file
    reference(path.join(home, "secret.txt"), path.join(location.root, "b.txt"));
    assert.equal(attempts(() => writeInRuntimeFolder(path.join(location.root, "b.txt"), "X")).code, "EOUTSIDE");
    // Dangling file and folder link
    reference(path.join(home, "fresh.txt"), path.join(location.root, "c.txt"));
    assert.equal(attempts(() => writeInRuntimeFolder(path.join(location.root, "c.txt"), "X")).code, "EOUTSIDE");
    reference(path.join(home, "fresh"), path.join(location.root, "d"));
    assert.equal(attempts(() => writeInRuntimeFolder(path.join(location.root, "d", "x.txt"), "X")).code, "EOUTSIDE");
    assert.equal(attempts(() => createFolderInRuntimeFolder(path.join(location.root, "d"))).code, "EOUTSIDE");
    // Copy: the target a link (fails by itself), the target folder a link (outwards), the source in the runtime folder a link.
    const q = path.join(data, "source.txt");
    fs.writeFileSync(q, "SOURCE");
    assert.equal(copyInRuntimeFolder(q, path.join(location.root, "c.txt")), "copied");
    assert.ok(!lstatOrNull(path.join(location.root, "c.txt")).isSymbolicLink(), "the dangling link fell by itself");
    assert.equal(attempts(() => copyInRuntimeFolder(q, path.join(location.root, "a", "k.txt"))).code, "EOUTSIDE");
    assert.equal(attempts(() => copyInRuntimeFolder(path.join(location.root, "b.txt"), path.join(data, "out.txt"))).code, "EOUTSIDE");
    assert.ok(!fs.existsSync(path.join(data, "out.txt")), "nothing is read from the runtime folder via a link");
    // Clone: a link in the tree stays behind; an intermediate-folder link does not lead out.
    write(path.join(location.root, "tree", "r.txt"), "R");
    reference(path.join(home, "secret.txt"), path.join(location.root, "tree", "s"));
    reference(path.join(home, "target"), path.join(location.root, "tree", "t"));
    const k = cloneWithoutReference(path.join(location.root, "tree"), path.join(data, "clone"));
    assert.deepEqual([k.kind, k.copied, k.error], ["folder", 1, []]);
    assert.deepEqual(fs.readdirSync(path.join(data, "clone")), ["r.txt"]);
    // Delete and rename via an intermediate-folder link: outwards, nothing deleted.
    write(path.join(home, "target", "way.txt"), "STAYS");
    const withWay = image(home);
    assert.equal(attempts(() => removeInRuntimeFolder(path.join(location.root, "a", "way.txt"))).code, "EOUTSIDE");
    assert.equal(attempts(() => renameInRuntimeFolder(path.join(location.root, "a", "way.txt"), path.join(location.root, "w.txt"))).code, "EOUTSIDE");
    assert.deepEqual(image(home), withWay);
    fs.rmSync(path.join(home, "target", "way.txt"));
    assert.deepEqual(image(home), prior, "nothing changed outside");
    // Outside every runtime folder `false`, and nothing happened.
    const flatFile = path.join(data, "scratch", "f.txt");
    assert.equal(writeInRuntimeFolder(flatFile, "F"), false);
    assert.equal(createFolderInRuntimeFolder(path.join(data, "scratch", "o")), false);
    assert.equal(copyInRuntimeFolder(q, flatFile), false);
    assert.equal(cloneWithoutReference(path.join(data, "clone"), path.join(data, "clone2")), false);
    assert.equal(removeInRuntimeFolder(q), false);
    assert.equal(renameInRuntimeFolder(q, path.join(data, "q2")), false);
    assert.ok(!fs.existsSync(path.join(data, "scratch")) && fs.existsSync(q), "outside: nothing created, nothing deleted");
  });
});

// ── (1) agent-runtime.js writeOutputFile ─────────────────────────────────────────────────────────────────────────

function fakeRunChat() {
  return async ({ onEvent, onSpawn }) => {
    onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} });
    onEvent({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Task read" }] } });
    onEvent({ type: "result", result: "REPORT", session_id: "s1" });
    return { code: 0, sessionId: "s1", resultText: "REPORT", stderr: "" };
  };
}
function runtimeCore(cwd) {
  return createAgentRuntime({
    chatId: "c1", cwd, parentProvider: "claude", agentDefs: () => [],
    hosts: () => [{ id: "claude", label: "claude", models: [{ id: "m", label: "m" }] }],
    resolveRef: (ref, fallback) => ({ providerId: fallback, connector: { id: fallback }, model: String(ref || ""), unknownProvider: false }),
    resolveSkills: () => ({ skills: [], missing: [], available: [] }),
    buildSpec: (o) => ({ ...o }), runChat: fakeRunChat(),
    onEvent: () => {}, onStart: () => {}, onFinish: () => {},
    worktreeRoot: path.join(cwd, ".wt"), forkTranscript: () => [],
  });
}

test("(1) writeOutputFile: `outputs/<chat> -> outside` — the output file of the subagent is not created in B; flat as before", async () => {
  await withLocation(async ({ home, location, data, flat }) => {
    reference(path.join(home, "target"), path.join(location.outputs, "c1"));
    const prior = image(home);
    const rt = runtimeCore(path.join(data, "cwd"));
    fs.mkdirSync(path.join(data, "cwd"));
    const res = await rt.start({ run_in_background: false, description: "Check", prompt: "Read" }, { outputDir: path.join(location.outputs, "c1", "agents") });
    assert.equal(res.status, "completed");
    assert.deepEqual(image(home), prior, "the output file landed outside");
    // The report names no path of a file that does not exist, and says why.
    assert.equal(res.outputFile, "", `the report names an output file that was never written: ${res.outputFile}`);
    assert.match(res.notes, /Output file not written.*EOUTSIDE/);
    assert.equal(rt.list().find((a) => a.agentId === res.agentId)?.outputFile, "", "the list does not name it either");
    // Flat it is created as before.
    const rt2 = runtimeCore(path.join(data, "cwd"));
    const flatLocation = path.join(flat.outputs, "c1", "agents");
    const r2 = await rt2.start({ run_in_background: false, description: "Check", prompt: "Read" }, { outputDir: flatLocation });
    assert.equal(r2.status, "completed");
    assert.equal(r2.outputFile, path.join(flatLocation, `${r2.agentId}.output`), "flat: the path as before");
    assert.doesNotMatch(r2.notes, /Output file/);
    const files = fs.readdirSync(flatLocation);
    assert.equal(files.length, 1);
    assert.match(fs.readFileSync(path.join(flatLocation, files[0]), "utf8"), /## Report\nREPORT/);
  });
});

// ── (E) Read cap in the runtime folder ────────────────────────────────────────────────────────────────────────────────
// A sparse 1.9 GB file in the runtime folder (the container creates it with `truncate` in no time): B read it WHOLE via the
// descriptor — the port file in the scanner every 3 s, the tab list, a manifest. With `maxBytes` the reader throws `ETOOLARGE`
// beforehand. The READ SEAM of the test: `fs.readFileSync` and `fs.readSync` counted (the product files call both through the module
// object `fs`) — a whole readFileSync counts the size of the file, readSync the bytes read.
// COUNTER-TEST: runtime-write.js, real-path.js and browsers.js without the option => red (1.9 GB counted, ERR_STRING_TOO_LONG instead
// of ETOOLARGE; the scanner counted the whole port file).
const LARGE = 1_900_000_000;
async function read(fn) {
  const old = { readFileSync: fs.readFileSync, readSync: fs.readSync };
  let bytes = 0;
  fs.readFileSync = function (p, ...rest) {
    try { bytes += (typeof p === "number" ? fs.fstatSync(p) : fs.statSync(p)).size; } catch { /* does not count */ }
    return old.readFileSync.call(fs, p, ...rest);
  };
  fs.readSync = function (...a) { const n = old.readSync.apply(fs, a); bytes += n; return n; };
  let value;
  try { value = await fn(); } finally { fs.readFileSync = old.readFileSync; fs.readSync = old.readSync; }
  return { bytes, value };
}
const thin = (p, n) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ""); fs.truncateSync(p, n); };

test("(E) `maxBytes` — a sparse 1.9 GB file throws ETOOLARGE before reading, the scanner reads at most the cap; small and without the option as before", async () => {
  await withLocation(async ({ location }) => {
    const large = path.join(location.root, "large.bin");
    thin(large, LARGE);
    const r = await read(() => attempts(() => readFromRuntimeFolder(large, "utf8", { maxBytes: 4096 })));
    assert.equal(r.value.code, "ETOOLARGE", `no ETOOLARGE: ${r.value.code || "read"}`);
    assert.ok(r.bytes <= 4097, `${r.bytes} bytes read via the read seam`);
    assert.equal(attempts(() => openFromRuntimeFolder(large, { maxBytes: 4096 })).code, "ETOOLARGE");
    // Small: read as before, with and without the option.
    const small = path.join(location.root, "small.txt");
    fs.writeFileSync(small, "4711\n/devtools/browser/x");
    assert.equal(readFromRuntimeFolder(small, "utf8", { maxBytes: 4096 }), "4711\n/devtools/browser/x");
    assert.equal(readFromRuntimeFolder(small, "utf8"), "4711\n/devtools/browser/x");
    assert.deepEqual(readFromRuntimeFolder(small, undefined, { maxBytes: 4096 }), Buffer.from("4711\n/devtools/browser/x"));
    // Exactly at the cap: still readable; one byte above not.
    fs.writeFileSync(small, "x".repeat(4096));
    assert.equal(readFromRuntimeFolder(small, "utf8", { maxBytes: 4096 }).length, 4096);
    fs.writeFileSync(small, "x".repeat(4097));
    assert.equal(attempts(() => readFromRuntimeFolder(small, "utf8", { maxBytes: 4096 })).code, "ETOOLARGE");
    // Outside: null as before, the option changes nothing about it.
    assert.equal(readFromRuntimeFolder(path.join(DIRS.data, "elsewhere.txt"), "utf8", { maxBytes: 1 }), null);
    // The scanner: an instance root with a 1.9 GB port file — one whole pass reads at most the cap.
    const profile = path.join(location.playwrightProfiles, "chat-large");
    thin(path.join(profile, "DevToolsActivePort"), LARGE);
    let scan = null;
    const s = await read(async () => {
      scan = startAgentScan(() => [{ root: location.playwrightProfiles, host: "127.0.0.1", identifier: "p1/main" }]);
      await scan.cycle();
    });
    scan.stop();
    assert.ok(s.bytes <= 2 * 4097, `a scanner pass read ${s.bytes} bytes via the read seam`);
  });
});

// ── (2) outputs.js createOutputLocation ─────────────────────────────────────────────────────────────────────────────

test("(2) createOutputLocation: `outputs -> outside` — the folder of the chat is not created in B; flat as before", async () => {
  await withLocation(({ home, location, flat }) => {
    reference(path.join(home, "target"), location.outputs);
    const prior = image(home);
    const dir = createOutputLocation("c1", location);
    assert.equal(dir, path.join(location.outputs, "c1"));
    assert.deepEqual(image(home), prior, "the output place was created outside");
    assert.equal(createOutputLocation("c1", flat), path.join(flat.outputs, "c1"));
    assert.ok(fs.statSync(path.join(flat.outputs, "c1")).isDirectory(), "created flat");
  });
});

// ── (3) playwright.js playwrightMcpEntry ─────────────────────────────────────────────────────────────────────────

test("(3) playwrightMcpEntry: `playwright-configs/chat-c1-h.json -> outside` — no file of B overwritten; flat as before", async () => {
  await withLocation(({ home, location, flat }) => {
    reference(path.join(home, "secret.txt"), path.join(location.playwrightConfigs, "chat-c1-h.json"));
    const prior = image(home);
    const v = attempts(() => playwrightMcpEntry("npx", { headless: true, userDataDir: path.join(location.playwrightProfiles, "chat-c1") }));
    assert.deepEqual(image(home), prior, "the configuration overwrote a file of B");
    assert.equal(v.code, "EOUTSIDE");
    const e = playwrightMcpEntry("npx", { headless: true, userDataDir: path.join(flat.playwrightProfiles, "chat-c1") });
    const cfg = e.args[e.args.indexOf("--config") + 1];
    assert.equal(cfg, path.join(flat.playwrightConfigs, "chat-c1-h.json"));
    assert.ok(JSON.parse(fs.readFileSync(cfg, "utf8")).browser, "written flat");
  });
});

// ── (4) mcp-config.js writeMcpConfig ─────────────────────────────────────────────────────────────────────────────

test("(4) writeMcpConfig: `scratch/c1.mcp.json -> outside` (dangling) — no file created in B, the run does not start", async () => {
  await withLocation(({ home, location }) => {
    reference(path.join(home, "fresh.json"), path.join(location.scratch, "c1.mcp.json"));
    const prior = image(home);
    const v = attempts(() => writeMcpConfig(path.join(location.scratch, "c1.mcp.json"), { toolset: "manager", chatId: "c1", workspaceId: "w1", agentDepth: 1 }));
    assert.deepEqual(image(home), prior, "the MCP configuration was created outside");
    assert.equal(v.code, "EOUTSIDE");
  });
});

// ── (5)/(6) browsers.js ──────────────────────────────────────────────────────────────────────────────────────────

test("(5) tab list: `cbase-tabs.json -> outside` — no file of B overwritten with the URL list", async () => {
  await withLocation(({ home, location }) => {
    const profile = path.join(location.browserProfiles, "proj-p1");
    reference(path.join(home, "secret.txt"), path.join(profile, "cbase-tabs.json"));
    const prior = image(home);
    const s = { kind: "user", profileDir: profile, tabOrder: ["t1"], tabs: new Map([["t1", { targetId: "t1", url: "https://example.test/" }]]), activeTargetId: "t1" };
    _tabsSave(s);
    assert.deepEqual(image(home), prior, "the tab list overwrote a file of B");
  });
});

test("(6) profile before start: `browser-profiles/proj-p1 -> a profile in B` — its locks stay, no browser starts", async () => {
  await withLocation(({ home, location }) => {
    const b = path.join(home, "wsprofile");
    fs.mkdirSync(b);
    fs.symlinkSync("machine-4711", path.join(b, "SingletonLock"));
    fs.writeFileSync(path.join(b, "DevToolsActivePort"), "9222\n/devtools/browser/x\n");
    reference(b, path.join(location.browserProfiles, "proj-p1"));
    const prior = image(home);
    const v = attempts(() => _profilePrepare(path.join(location.browserProfiles, "proj-p1")));
    assert.deepEqual(image(home), prior, "the locks of a profile in B fell");
    assert.equal(v.code, "EOUTSIDE");
  });
});

// ── (7) captures.js ──────────────────────────────────────────────────────────────────────────────────────────────

function fakeJpeg(w, h) {
  const b = Buffer.alloc(16, 0);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(11, 4); b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9);
  return b;
}
function fakeBrowser() {
  const frame = { data: fakeJpeg(320, 200).toString("base64"), w: 320, h: 200 };
  const tab = { targetId: "t1", title: "Test page", url: "http://localhost:3100/", lastFrame: frame };
  const session = { scopeKey: "agent:chat-c1:9222", kind: "agent", tabs: new Map([["t1", tab]]), activeTargetId: "t1" };
  return {
    findAgentBrowser: (dir) => (dir === "chat-c1" ? session : null),
    resolveTab: () => tab,
    tabList: () => [{ id: "t1", title: tab.title, url: tab.url, active: true }],
    captureTabScreenshot: async () => ({ data: fakeJpeg(640, 480).toString("base64"), w: 640, h: 480, url: tab.url, title: tab.title }),
    acquireFrameSink: async (s, t) => ({ getFrame: () => t.lastFrame, release: () => {} }),
  };
}

test("(7) captures: `captures -> outside`, `manifest.json -> outside`, `video.mp4 -> outside` — nothing of B overwritten or created", async () => {
  await withLocation(async ({ root, home, location }) => {
    const ff = path.join(root, "fake-ffmpeg");
    fs.writeFileSync(ff, "#!/usr/bin/env node\nrequire(\"node:fs\").writeFileSync(process.argv[process.argv.length - 1], \"MP4-STUB\");\n");
    fs.chmodSync(ff, 0o755);
    const prevFf = process.env.CBASE_FFMPEG;
    process.env.CBASE_FFMPEG = ff;
    try {
      initCaptures({ attachmentsOf: (id) => path.join(location.attachments, id), browser: fakeBrowser() });
      // Manifest: a real capture, afterwards the container swaps its manifest for a link.
      const { capture } = await takeScreenshot({ chatId: "c1", profileKey: "c1", tab: "" });
      const capDir = path.join(location.attachments, "c1", "captures", capture.id);
      // The file of B passes as a manifest — it stands for the race in which the container swaps the manifest for the link between
      // reading (markSent -> getCapture) and writing (writeManifest).
      fs.writeFileSync(path.join(home, "b.json"), JSON.stringify({ id: capture.id, chatId: "c1", sent: false, b: "B-DATA" }));
      fs.rmSync(path.join(capDir, "manifest.json"));
      fs.symlinkSync(path.join(home, "b.json"), path.join(capDir, "manifest.json"));
      // Recording: the folder exists from the start, the container puts `video.mp4` into it as a link.
      const rec = await startRecording({ chatId: "c1", profileKey: "c1", tab: "", fps: 1, maxSeconds: 60 });
      const recDir = path.join(location.attachments, "c1", "captures", rec.captureId);
      fs.symlinkSync(path.join(home, "secret.txt"), path.join(recDir, "video.mp4"));
      fs.symlinkSync(path.join(home, "secret.txt"), path.join(recDir, "poster.jpg"));
      const prior = image(home);
      const m = await attemptsAsync(() => markSent("c1", capture.id, "x"));
      const stop = await attemptsAsync(() => stopRecording({ profileKey: "c1" }));
      assert.deepEqual(image(home), prior, "manifest or video overwrote a file of B");
      // B reads the manifest via the descriptor: the link fails already when reading (404, unknown capture), before writing — the
      // read side is held by runtime-read.test.js (C2); here what counts is that nothing was written outside.
      assert.equal(m.e?.status, 404, m.e?.message);
      assert.ok(stop.ok, stop.e?.message);
      assert.equal(stop.r.capture.video, "video.mp4");
      assert.ok(lstatOrNull(path.join(recDir, "video.mp4")).isFile(), "the video lies as a file in the runtime folder");
      assert.equal(fs.readFileSync(path.join(recDir, "video.mp4"), "utf8"), "MP4-STUB");
      assert.ok(lstatOrNull(path.join(recDir, "poster.jpg")).isFile(), "the poster lies as a file in the runtime folder");
      assert.ok(!fs.existsSync(path.join(recDir, "frames")), "no frames in the runtime folder");
      // Screenshot: `captures` itself a link.
      fs.rmSync(path.join(location.attachments, "c1", "captures"), { recursive: true, force: true });
      reference(path.join(home, "target"), path.join(location.attachments, "c1", "captures"));
      const prior2 = image(home);
      const s = await attemptsAsync(() => takeScreenshot({ chatId: "c1", profileKey: "c1", tab: "" }));
      assert.deepEqual(image(home), prior2, "the screenshot landed outside");
      assert.equal(s.code, "EOUTSIDE");
    } finally {
      initCaptures({ attachmentsDir: path.join(root, "anh") });
      if (prevFf === undefined) delete process.env.CBASE_FFMPEG; else process.env.CBASE_FFMPEG = prevFf;
    }
  });
});

test("(20) capture clean-up: the container swaps `captures` for a link between list and delete — no folder in B deleted", async () => {
  await withLocation(async ({ root, home, location }) => {
    // In the runtime folder: 20 unsent captures with a valid manifest — the new one breaks the cap per chat (20), prune removes the
    // oldest. Outside (`home/caps`, a folder of B): the same names, as if the inventory of B stood there.
    const anh = path.join(location.attachments, "c1");
    const capsDir = path.join(anh, "captures");
    const caps = path.join(home, "caps");
    for (let i = 0; i < 20; i++) {
      const id = `c-${crypto.randomUUID()}`;
      const m = JSON.stringify({ id, chatId: "c1", sent: false, createdAt: i });
      write(path.join(capsDir, id, "manifest.json"), m);
      write(path.join(caps, id, "manifest.json"), m);
      write(path.join(caps, id, "poster.jpg"), `B-IMAGE-${i}`);
    }
    let swapped = false;
    // The race without a clock: the swap happens when the path of the DELETE is built (capDir directly from prune) — the list before
    // it read the real folder (it reads via the descriptor; a swap before the list would make prune find nothing and leave the
    // write side untouched).
    const fromPrune = () => {
      const z = String(new Error().stack).split("\n").map((l) => l.trim());
      const k = z.findIndex((l) => l.startsWith("at capDir "));
      return k >= 0 && String(z[k + 1] || "").startsWith("at prune ");
    };
    const attachmentsOf = (id) => {
      if (!swapped && fromPrune()) {
        swapped = true;
        fs.renameSync(capsDir, path.join(anh, "captures-prior"));
        fs.symlinkSync(caps, capsDir);
      }
      return path.join(location.attachments, id);
    };
    try {
      initCaptures({ attachmentsOf, browser: fakeBrowser() });
      const prior = image(home);
      const s = await attemptsAsync(() => takeScreenshot({ chatId: "c1", profileKey: "c1", tab: "" }));
      assert.ok(swapped, "the swap happened (prune wanted to delete)");
      assert.deepEqual(image(home), prior, "prune deleted a folder in B");
      assert.ok(s.ok, s.e?.message);
    } finally {
      initCaptures({ attachmentsDir: path.join(root, "anh") });
    }
  });
});

// ── (8)–(10) browser-profiles.js ─────────────────────────────────────────────────────────────────────────────────

const oldTime = new Date("2026-09-01T10:00:00Z");
const newTime = new Date("2026-09-20T10:00:00Z");
function stockWithLogin(flat) {
  const jar = path.join(flat.playwrightProfiles, "w1");
  write(path.join(jar, "Default", "Cookies"), "STOCK-COOKIES");
  write(path.join(jar, "Default", "Local Storage", "leveldb", "CURRENT"), "STOCK-LEVELDB");
  for (const p of [path.join(jar, "Default", "Cookies"), path.join(jar, "Default", "Local Storage", "leveldb", "CURRENT")]) fs.utimesSync(p, newTime, newTime);
  return jar;
}

test("(8) prepareChatProfile: fixed temp name as a link, `Local Storage -> outside`, `chat-c2 -> outside` — nothing in B; flat as before", async () => {
  await withLocation(({ home, location, flat }) => {
    stockWithLogin(flat);
    const profile = path.join(location.playwrightProfiles, "chat-c1");
    fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
    fs.symlinkSync(path.join(home, "secret.txt"), path.join(profile, "Default", "Cookies.cbase-tmp"));
    reference(path.join(home, "target"), path.join(profile, "Default", "Local Storage"));
    reference(path.join(home, "target"), path.join(location.playwrightProfiles, "chat-c2"));
    const prior = image(home);
    prepareChatProfile({ root: location.playwrightProfiles, stock: flat.playwrightProfiles, chatId: "c1", workspaceId: "w1" });
    const v = attempts(() => prepareChatProfile({ root: location.playwrightProfiles, stock: flat.playwrightProfiles, chatId: "c2", workspaceId: "w1" }));
    assert.deepEqual(image(home), prior, "the sync wrote outside");
    assert.equal(fs.readFileSync(path.join(profile, "Default", "Cookies"), "utf8"), "STOCK-COOKIES", "the login arrived in the runtime folder");
    assert.equal(fs.statSync(path.join(profile, "Default", "Cookies")).mtimeMs, newTime.getTime(), "with the time of the source");
    assert.equal(v.code, "EOUTSIDE");
    // Flat as before.
    const fp = prepareChatProfile({ root: flat.playwrightProfiles, chatId: "c3", workspaceId: "w1" });
    assert.equal(fs.readFileSync(path.join(fp, "Default", "Cookies"), "utf8"), "STOCK-COOKIES");
    assert.equal(fs.readFileSync(path.join(fp, "Default", "Local Storage", "leveldb", "CURRENT"), "utf8"), "STOCK-LEVELDB");
  });
});

test("(9) saveChatLogins: `Default/Cookies -> B file`, `…/leveldb -> B folder` — no file of B lands in the stock, the stock stays", async () => {
  await withLocation(async ({ home, location, flat }) => {
    const jar = stockWithLogin(flat);
    for (const p of [path.join(jar, "Default", "Cookies"), path.join(jar, "Default", "Local Storage", "leveldb", "CURRENT")]) fs.utimesSync(p, oldTime, oldTime);
    const stockPrior = image(jar);
    const profile = path.join(location.playwrightProfiles, "chat-c1");
    write(path.join(profile, "Default", "Preferences"), "{}");
    fs.symlinkSync(path.join(home, "secret.txt"), path.join(profile, "Default", "Cookies"));
    write(path.join(home, "target", "000003.log"), "B-DATA");
    reference(path.join(home, "target"), path.join(profile, "Default", "Local Storage", "leveldb"));
    const prior = image(home);
    await saveChatLogins({ root: location.playwrightProfiles, stock: flat.playwrightProfiles, chatId: "c1", workspaceId: "w1" });
    assert.deepEqual(image(home), prior);
    assert.deepEqual(image(jar), stockPrior, "a file of B landed in the stock (or the stock lost its login)");
  });
});

test("(10) reapUnusedChatProfiles, removeChatProfile, releaseStaleLocks: `playwright-profiles -> outside`, `chat-c1 -> a profile in B` — nothing in B deleted", async () => {
  await withLocation(async ({ home, location }) => {
    write(path.join(home, "profile", "chat-x", "Default", "Cookies"), "B-PROFILE");
    reference(path.join(home, "profile"), location.playwrightProfiles);
    const prior = image(home);
    const way = await reapUnusedChatProfiles({ root: location.playwrightProfiles, now: Date.now() + 400 * 24 * 3_600_000 });
    assert.deepEqual(image(home), prior, "a profile in B fell");
    assert.deepEqual(way, []);
    // The chat is deleted: its profile falls — via the link it would be one in B.
    removeChatProfile({ root: location.playwrightProfiles, chatId: "x" });
    assert.deepEqual(image(home), prior, "removeChatProfile deleted a profile in B");
    // A dead lock (pid 0) in a profile that is one in B via a link: the locks of B stay.
    fs.rmSync(location.playwrightProfiles);
    const b = path.join(home, "wsprofile");
    fs.mkdirSync(b);
    fs.symlinkSync("machine-0", path.join(b, "SingletonLock"));
    fs.writeFileSync(path.join(b, "SingletonCookie"), "B-COOKIE");
    reference(b, path.join(location.playwrightProfiles, "chat-c1"));
    const prior2 = image(home);
    await releaseStaleLocks(path.join(location.playwrightProfiles, "chat-c1"));
    assert.deepEqual(image(home), prior2, "the locks of a profile in B fell");
  });
});

// ── (11) agents.js cleanUpAgent ───────────────────────────────────────────────────────────────────────────────

test("(11) cleanUpAgent: `playwright-profiles -> outside` — the clean-up at the end of the agent deletes nothing in B", async () => {
  await withLocation(({ home, location }) => {
    write(path.join(home, "profile", "chat-c1-agent-a1", "Default", "Cookies"), "B-PROFILE");
    reference(path.join(home, "profile"), location.playwrightProfiles);
    const prior = image(home);
    const warn = cleanUpAgent("c1", "a1", { location, warn: () => {} });
    assert.deepEqual(image(home), prior, "the profile in B fell");
    assert.ok(warn.some((w) => w.includes("chat-c1-agent-a1")), warn.join("\n"));
  });
});

// ── (12)/(13) runtime-location.js ────────────────────────────────────────────────────────────────────────────────────

test("(12) fetchAttachmentAtLocation/copyAttachmentsTo: `attachments -> outside` — no attachment copied into B", async () => {
  await withLocation(({ home, location, flat }) => {
    write(path.join(flat.attachments, "c1", "a.txt"), "ATTACHMENT");
    reference(path.join(home, "target"), location.attachments);
    const prior = image(home);
    const chat = { id: "c1", projectId: null };
    const h = attempts(() => fetchAttachmentAtLocation(chat, "a.txt", location));
    const k = attempts(() => copyAttachmentsTo(chat, { location }));
    assert.deepEqual(image(home), prior, "the attachment landed outside");
    assert.equal(h.code, "EOUTSIDE");
    assert.ok(k.ok && k.r.error.length === 1 && k.r.copied.length === 0, JSON.stringify(k.r));
  });
});

// Every link under `dir` (without following).
function referencesUnder(dir) {
  return Object.entries(image(dir)).filter(([, v]) => v.startsWith("link:")).map(([k]) => k);
}

test("(13) bringAlongChat: no link moves from the runtime folder to the flat place; `attachments -> outside` at the destination pulls nothing out", async () => {
  await withLocation(({ home, location, flat }) => {
    // From the runtime folder to the flat place — without a destination (c1) and merged (c2).
    for (const id of ["c1", "c2"]) {
      write(path.join(location.attachments, id, "r.txt"), `R-${id}`);
      reference(path.join(home, "secret.txt"), path.join(location.attachments, id, "s"));
      reference(path.join(home, "target"), path.join(location.attachments, id, "d"));
      reference(path.join(home, "fresh.txt"), path.join(location.attachments, id, "h"));
    }
    write(path.join(flat.attachments, "c2", "old.txt"), "OLD");
    const prior = image(home);
    for (const id of ["c1", "c2"]) {
      const r = bringAlongChat(id, { location: flat });
      assert.deepEqual(r.error, [], id);
    }
    assert.deepEqual(image(home), prior);
    assert.deepEqual(referencesUnder(flat.attachments), [], "a link from the runtime folder now lies in the flat place");
    assert.equal(fs.readFileSync(path.join(flat.attachments, "c1", "r.txt"), "utf8"), "R-c1");
    assert.equal(fs.readFileSync(path.join(flat.attachments, "c2", "r.txt"), "utf8"), "R-c2");
    assert.equal(fs.readFileSync(path.join(flat.attachments, "c2", "old.txt"), "utf8"), "OLD");
    assert.ok(!fs.existsSync(path.join(location.attachments, "c1")) && !fs.existsSync(path.join(location.attachments, "c2")), "the source fell");
    // Into the runtime folder whose `attachments` leads out: the files of B stay where they are.
    write(path.join(flat.attachments, "c3", "f.txt"), "F");
    fs.rmSync(location.attachments, { recursive: true, force: true });
    reference(path.join(home, "target"), location.attachments);
    const prior2 = image(home);
    const r3 = bringAlongChat("c3", { location });
    assert.deepEqual(image(home), prior2, "the files of the chat moved outside");
    assert.equal(r3.error.length, 1, JSON.stringify(r3));
    assert.equal(fs.readFileSync(path.join(flat.attachments, "c3", "f.txt"), "utf8"), "F", "the source stayed");
  });
});

// ── (14) session-transfer.js ───────────────────────────────────────────────────────────────────────────────────────

test("(14) session transfer: `projects -> outside` on the way there, `<sid>.jsonl -> B file` on the way back, `projects/<slug> -> outside` on delete", async () => {
  await withLocation(({ root, home, location }) => {
    const sid = "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";
    const bHome = path.join(root, "b-home", ".claude");
    const pHome = path.join(location.home, ".claude");
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const slugB = "-old-cwd";
    write(path.join(bHome, "projects", slugB, `${sid}.jsonl`), "{\"type\":\"user\"}\n");
    write(path.join(bHome, "projects", slugB, sid, "tool-results", "t.txt"), "TOOL");
    reference(path.join(home, "target"), path.join(pHome, "projects"));
    const prior = image(home);
    const hin = attempts(() => pullClaudeSession({ sid, destination: pHome, cwd, sources: [bHome] }));
    assert.deepEqual(image(home), prior, "the session landed outside");
    assert.equal(hin.code, "EOUTSIDE");
    // Way back: the only copy in the project home is a link to a file of B.
    fs.rmSync(path.join(pHome, "projects"));
    const sid2 = "1f1e2d3c-aaaa-bbbb-cccc-1234567890ab";
    reference(path.join(home, "secret.txt"), path.join(pHome, "projects", "-p", `${sid2}.jsonl`));
    const to = attempts(() => pullClaudeSession({ sid: sid2, destination: bHome, cwd, sources: [pHome] }));
    const target = path.join(bHome, "projects", sessionSlug(fs.realpathSync(cwd)), `${sid2}.jsonl`);
    assert.ok(!fs.existsSync(target) || !fs.readFileSync(target, "utf8").includes("B-SECRET"), "a file of B was copied as a session");
    assert.equal(to.code, "EOUTSIDE");
    // Deleting the old copies: an intermediate folder became a link.
    write(path.join(home, "target", sid, "x.txt"), "B-STAYS");
    reference(path.join(home, "target"), path.join(pHome, "projects", "-q"));
    const prior3 = image(home);
    removeCopies([path.join(pHome, "projects", "-q", sid)]);
    assert.deepEqual(image(home), prior3, "deleting the old copy hit B");
  });
});

// ── With a server: store, instance row, real routes ───────────────────────────────────────────────────────────────

// A converted project (instance row, without an operation marker — no docker), the chat in it. Returns the runtime folder.
async function projectInChat(ctx, chatId = ctx.chat.id) {
  const filePath = path.join(ctx.root, "workspace", "till");
  const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: filePath }) });
  fs.mkdirSync(filePath, { recursive: true });
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now() });
  await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  const w = locationFor({ projectId: p.id, converted: true });
  fs.mkdirSync(w.root, { recursive: true });
  return w;
}

test("(15) stageChannelFiles: `attachments/<chat>/channel-… -> outside` (dangling) — no file created in B", async () => {
  await withAgentsServer(async (ctx) => {
    const w = await projectInChat(ctx);
    const home = createHome(ctx.root);
    write(path.join(DIRS.channelFiles, "k1", "channel-1-1-plan.txt"), "PLAN");
    reference(path.join(home, "fresh.txt"), path.join(w.attachments, ctx.chat.id, "channel-1-1-plan.txt"));
    const prior = image(home);
    stageChannelFiles({ id: "k1" }, store.getChat(ctx.chat.id), [{ files: [{ file: "channel-1-1-plan.txt" }] }]);
    assert.deepEqual(image(home), prior, "the channel file was created outside");
    const dst = path.join(w.attachments, ctx.chat.id, "channel-1-1-plan.txt");
    assert.ok(lstatOrNull(dst).isFile(), "the link fell, the file lies in the runtime folder");
    assert.equal(fs.readFileSync(dst, "utf8"), "PLAN");
  });
});

test("(16) attachments of the child chat: `attachments -> outside` — no attachment copied into B", async () => {
  await withAgentsServer(async (ctx) => {
    const w = await projectInChat(ctx);
    const home = createHome(ctx.root);
    const source = path.join(ctx.root, "announcement.txt");
    fs.writeFileSync(source, "ANNOUNCEMENT");
    reference(path.join(home, "target"), w.attachments);
    const prior = image(home);
    const out = _attachmentsCopy([source], ctx.chat.id);
    assert.deepEqual(image(home), prior, "the attachment landed outside");
    assert.deepEqual(out, []);
  });
});

test("(17) output file of a graph run: `graph-<id>.json -> outside` (dangling) — no file created in B", async () => {
  await withAgentsServer(async (ctx) => {
    const w = await projectInChat(ctx);
    const home = createHome(ctx.root);
    reference(path.join(home, "fresh.json"), path.join(w.outputs, ctx.chat.id, "graph-gs-test1.json"));
    const prior = image(home);
    _runEnds({ id: "gs-test1", chatId: ctx.chat.id, workflowName: "Check", childChatId: null, runId: "", worktreePath: null, stoppedOf: null },
      { state: "finished", run: { note: "" } });
    assert.deepEqual(image(home), prior, "the output file was created outside");
    await ctx.waitForIdle();
  });
});

test("(18) upload: `attachments/<chat> -> outside` — 409, no file in B", async () => {
  await withAgentsServer(async (ctx) => {
    const w = await projectInChat(ctx);
    const home = createHome(ctx.root);
    reference(path.join(home, "target"), path.join(w.attachments, ctx.chat.id));
    const prior = image(home);
    const res = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}/attachments?name=note.txt&artifact=0`, { method: "POST", body: "CONTENT", headers: { Connection: "close" } });
    const text = await res.text();
    assert.deepEqual(image(home), prior, "the attachment landed outside");
    assert.equal(res.status, 409, text);
  });
});

const SCRIPT = (name, body) => `export const meta = { name: '${name}', description: 'Probe ${name}', phases: [{ title: 'Part' }] }\n${body}\n`;
const SUB_WITH_GATE = `
    if (text.includes("{GATE:")) await gate(text.split("{GATE:").pop().split("}")[0]);
    finished();
    say({ type: "result", result: "Finding", session_id: "sub-1" });`;

test("(19) dynamic workflow: `outputs/<chat>/workflows -> outside` => 409 for script and card; `result.json -> B file` stays untouched", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    const w = await projectInChat(ctx);
    const home = createHome(ctx.root);
    const run = (body) => fetch(`${base}/api/chats/${chat.id}/dyn-workflows/run`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
    // Card (without ultracode): the job would go outside.
    const wf = path.join(w.outputs, chat.id, "workflows");
    reference(path.join(home, "target"), wf);
    const prior = image(home);
    const k = await run({ script: SCRIPT("card", "return 1;") });
    const kText = await k.text();
    assert.deepEqual(image(home), prior, "the job of the card landed outside");
    assert.equal(k.status, 409, kText);
    // Script (ultracode): the script file would go outside.
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const s = await run({ script: SCRIPT("script", "return 1;") });
    const sText = await s.text();
    assert.deepEqual(image(home), prior, "the script landed outside");
    assert.equal(s.status, 409, sText);
    await ctx.waitForIdle();
    // Result: the run waits at the gate, the container creates `result.json` as a link.
    fs.rmSync(wf);
    const r = await run({ script: SCRIPT("result", "return await agent('Wait {GATE:e1}');") });
    const body = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body));
    await ctx.gate.reached("e1");
    fs.symlinkSync(path.join(home, "secret.txt"), path.join(path.dirname(body.scriptPath), "result.json"));
    const prior3 = image(home);
    ctx.gate.open("e1");
    await waitForTruthy(() => (store.readDynRun(body.runId)?.status !== "running" ? true : null), `run ${body.runId} finished`);
    assert.deepEqual(image(home), prior3, "the result overwrote a file of B");
    await ctx.waitForIdle();
  }, { claude: fakeClaude({ sub: SUB_WITH_GATE }) });
});

// ── (21) projectbox/instance.js ───────────────────────────────────────────────────────────────────────────────────

test("(21) placeholders of the single-file mounts (projectbox/instance.js): `home/.claude -> a folder of B` — no file created or deleted in B", async () => {
  await withLocation(({ home, location }) => {
    const cliHome = location.home;
    // The container swapped `home/.claude` for a link to a folder of B: CLAUDE.md is missing there, settings.json is empty (the
    // setup deletes an EMPTY placeholder whose mount is missing this time).
    const b = path.join(home, "claude-b");
    write(path.join(b, "settings.json"), "");
    reference(b, path.join(cliHome, ".claude"));
    const prior = image(home);
    const ctx = { cliHome, home: path.join(home, "home-b") };
    const create = attempts(() => _placeholder([{ source: path.join(home, "claude-md"), target: path.join(cliHome, ".claude", "CLAUDE.md"), kind: "file" }], ctx));
    assert.deepEqual(image(home), prior, "the placeholder was created in B");
    assert.equal(create.code, "EOUTSIDE");
    const folder = attempts(() => _placeholder([{ source: path.join(home, "agents"), target: path.join(cliHome, ".claude", "agents"), kind: "folder" }], ctx));
    assert.deepEqual(image(home), prior, "the folder placeholder was created in B");
    assert.equal(folder.code, "EOUTSIDE");
    const erase = attempts(() => _placeholder([], ctx));
    assert.deepEqual(image(home), prior, "the empty placeholder was deleted in B");
    assert.ok(erase.ok, erase.e?.message);
    // `.claude` a real folder, `CLAUDE.md` in it a dangling link outwards.
    fs.rmSync(path.join(cliHome, ".claude"));
    fs.mkdirSync(path.join(cliHome, ".claude"));
    fs.symlinkSync(path.join(home, "fresh.md"), path.join(cliHome, ".claude", "CLAUDE.md"));
    const hanging = attempts(() => _placeholder([{ source: path.join(home, "claude-md"), target: path.join(cliHome, ".claude", "CLAUDE.md"), kind: "file" }], ctx));
    assert.deepEqual(image(home), prior, "the placeholder was created in B via a dangling link");
    assert.equal(hanging.code, "EOUTSIDE");
    // Without a runtime folder as before — the placeholder is created, the empty one falls.
    const flatHome = path.join(home, "flat-home");
    write(path.join(flatHome, ".claude", "settings.json"), "");
    _placeholder([{ source: path.join(home, "claude-md"), target: path.join(flatHome, ".claude", "CLAUDE.md"), kind: "file" }], { cliHome: flatHome, home: ctx.home });
    assert.equal(fs.readFileSync(path.join(flatHome, ".claude", "CLAUDE.md"), "utf8"), "");
    assert.equal(lstatOrNull(path.join(flatHome, ".claude", "settings.json")), null);
  });
});
