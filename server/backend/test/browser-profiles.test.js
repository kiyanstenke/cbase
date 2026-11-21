// Chromium allows only ONE browser per profile (SingletonLock/ProcessSingleton). Because all chats of a workspace used to
// share the same Playwright profile, the second chat browsing at the same time got no browser ("Failed to create a
// ProcessSingleton for your profile directory", exit 21). These tests secure the profile split: an own profile per chat,
// cloned from the workspace stock, logins flow back, dead locks are released — but never the lock of a LIVING process.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  chatIdOfProfile, chatProfileDir, prepareChatProfile, reapUnusedChatProfiles, releaseStaleLocks,
  removeChatProfile, saveChatLogins, workspaceProfileDir,
} from "../electron/server/browser-profiles.js";

const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbase-profiles-"));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
// SingletonLock is a symlink to "<host>-<pid>" — a target that never exists as a file.
// fs.existsSync FOLLOWS the link and therefore always reports false; hence lstat.
const linkExists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
/// Date a file artificially — the reconciliation decides per store by "the fresher one wins".
const touch = (p, deltaMs) => { const at = new Date(Date.now() + deltaMs); fs.utimesSync(p, at, at); };

// A workspace profile with login data and cache, as Chromium leaves it.
function seedJar(root, wsId) {
  const jar = workspaceProfileDir(root, wsId);
  write(path.join(jar, "Default", "Cookies"), "cookie-stock");
  write(path.join(jar, "Default", "Local Storage", "leveldb", "000003.log"), "storage-stock");
  write(path.join(jar, "Local State"), "{}");
  write(path.join(jar, "Cache", "data_0"), "x".repeat(1000));
  write(path.join(jar, "DevToolsActivePort"), "61234\n/devtools/browser/abc");
  return jar;
}

test("a chat profile inherits ONLY the stock's login stores — not the whole profile", () => {
  const root = mkroot();
  seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });

  assert.equal(dir, chatProfileDir(root, "c1"));
  assert.equal(read(path.join(dir, "Default", "Cookies")), "cookie-stock", "cookies must come along");
  assert.equal(read(path.join(dir, "Default", "Local Storage", "leveldb", "000003.log")), "storage-stock");
  // Chromium creates everything else itself — copying a whole profile would be 8.5 MB per chat.
  assert.ok(!fs.existsSync(path.join(dir, "Cache")), "the cache does not belong in the profile");
  assert.ok(!fs.existsSync(path.join(dir, "Local State")), "no all-round clone of the stock");
  assert.ok(!fs.existsSync(path.join(dir, "DevToolsActivePort")), "DevToolsActivePort describes a running instance");
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("two chats get different profiles (otherwise the profile lock collides)", () => {
  const root = mkroot();
  seedJar(root, "ws1");
  const a = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  const b = prepareChatProfile({ root, chatId: "c2", workspaceId: "ws1" });
  assert.notEqual(a, b);
  assert.notEqual(a, workspaceProfileDir(root, "ws1"), "chats do not browse in the stock itself");
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("preparing again does NOT clone again — the chat keeps its state", () => {
  const root = mkroot();
  seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  write(path.join(dir, "Default", "Cookies"), "in-chat-logged-in");
  touch(path.join(dir, "Default", "Cookies"), 5000); // fresher than the stock
  const again = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  assert.equal(again, dir);
  assert.equal(read(path.join(dir, "Default", "Cookies")), "in-chat-logged-in");
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("an EXISTING chat inherits a login done later (reconciliation in both directions)", () => {
  const root = mkroot();
  const jar = seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" }); // profile exists already
  // Afterwards another chat logs in → the stock holds a fresher state.
  write(path.join(jar, "Default", "Cookies"), "login-of-elsewhere");
  touch(path.join(jar, "Default", "Cookies"), 5000);

  prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  assert.equal(
    read(path.join(dir, "Default", "Cookies")), "login-of-elsewhere",
    "the existing chat must get the fresher login pulled in",
  );
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("a chat without login does not delete a foreign login from the stock", async () => {
  const root = mkroot();
  const jar = seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });   // state T1
  write(path.join(jar, "Default", "Cookies"), "foreign-login");                  // T2, other chat
  touch(path.join(jar, "Default", "Cookies"), 4000);

  // This chat browses some page WITHOUT login — Chromium touches the cookie DB in the process.
  prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" }); // pulls in T2
  touch(path.join(dir, "Default", "Cookies"), 6000);              // access makes it fresher

  await saveChatLogins({ root, chatId: "c1", workspaceId: "ws1" });
  assert.equal(
    read(path.join(jar, "Default", "Cookies")), "foreign-login",
    "the foreign login must not be replaced by old stock",
  );
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("nothing is written into a stock with a RUNNING browser", async () => {
  const root = mkroot();
  const jar = seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  write(path.join(dir, "Default", "Cookies"), "chat-login");
  touch(path.join(dir, "Default", "Cookies"), 9000);

  // In the stock a manual claude call browses (living process in the lock).
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  try {
    fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(jar, "SingletonLock"));
    await saveChatLogins({ root, chatId: "c1", workspaceId: "ws1" });
    assert.equal(
      read(path.join(jar, "Default", "Cookies")), "cookie-stock",
      "the cookie database of a running browser must not be replaced",
    );
  } finally {
    child.kill("SIGKILL");
    // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
    // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

test("LevelDB travels as a WHOLE — mixed files of two instances would be destroyed", async () => {
  const root = mkroot();
  const jar = seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  const rel = ["Default", "Local Storage", "leveldb"];
  // The stock has a MANIFEST of its own that the chat does not know; the chat has a newer instance. If mixed file by file,
  // BOTH MANIFESTS would stay → destroyed database.
  write(path.join(jar, ...rel, "MANIFEST-000001"), "old");
  write(path.join(dir, ...rel, "CURRENT"), "MANIFEST-000004");
  write(path.join(dir, ...rel, "MANIFEST-000004"), "fresh");
  for (const f of ["CURRENT", "MANIFEST-000004"]) touch(path.join(dir, ...rel, f), 9000);

  await saveChatLogins({ root, chatId: "c1", workspaceId: "ws1" });
  const target = path.join(jar, ...rel);
  assert.ok(
    !fs.existsSync(path.join(target, "MANIFEST-000001")),
    "the MANIFEST of the old instance must not stay next to the new one",
  );
  assert.equal(read(path.join(target, "MANIFEST-000004")), "fresh");
  assert.equal(read(path.join(target, "CURRENT")), "MANIFEST-000004");
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("SQLite sidecars of the target do not stay next to a replaced database", async () => {
  const root = mkroot();
  const jar = seedJar(root, "ws1");
  write(path.join(jar, "Default", "Cookies-wal"), "old-wal");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  fs.rmSync(path.join(dir, "Default", "Cookies-wal"), { force: true });
  write(path.join(dir, "Default", "Cookies"), "new-status");
  touch(path.join(dir, "Default", "Cookies"), 9000);

  await saveChatLogins({ root, chatId: "c1", workspaceId: "ws1" });
  assert.equal(read(path.join(jar, "Default", "Cookies")), "new-status");
  assert.ok(
    !fs.existsSync(path.join(jar, "Default", "Cookies-wal")),
    "a -wal of the OLD database damages the new one on opening",
  );
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("long unused chat profiles are discarded, young and running ones are not", async () => {
  const root = mkroot();
  seedJar(root, "ws1");
  const prev = prepareChatProfile({ root, chatId: "old", workspaceId: "ws1" });
  const recent = prepareChatProfile({ root, chatId: "recent", workspaceId: "ws1" });
  const running = prepareChatProfile({ root, chatId: "running", workspaceId: "ws1" });
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  try {
    fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(running, "SingletonLock"));
    // Date "old" and "running" to 40 days ago.
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    for (const dir of [prev, running]) {
      for (const p of [dir, path.join(dir, "Default"), path.join(dir, "Default", "Cookies"), path.join(dir, "Default", "Preferences")]) {
        if (fs.existsSync(p)) fs.utimesSync(p, old, old);
      }
    }

    const removed = await reapUnusedChatProfiles({ root });
    assert.deepEqual(removed, ["old"]);
    assert.ok(!fs.existsSync(prev));
    assert.ok(fs.existsSync(recent), "a young profile stays");
    assert.ok(fs.existsSync(running), "a profile with a running browser stays");
    assert.ok(fs.existsSync(workspaceProfileDir(root, "ws1")), "the stock stays");
  } finally {
    child.kill("SIGKILL");
    // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
    // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

test("without a stock an empty profile arises (first run of a fresh workspace)", () => {
  const root = mkroot();
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws-new" });
  assert.ok(fs.existsSync(dir));
  assert.ok(!fs.existsSync(path.join(dir, "Default")), "nothing to clone → Chromium creates the profile itself");
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("an orphaned lock of a dead process is released", async () => {
  const root = mkroot();
  const dir = chatProfileDir(root, "c1");
  fs.mkdirSync(dir, { recursive: true });
  // Crash corpse: symlink to a PID that no longer exists.
  fs.symlinkSync(`${os.hostname()}-999999`, path.join(dir, "SingletonLock"));
  write(path.join(dir, "DevToolsActivePort"), "1234");

  assert.equal(await releaseStaleLocks(dir), true);
  assert.ok(!linkExists(path.join(dir, "SingletonLock")));
  assert.ok(!linkExists(path.join(dir, "DevToolsActivePort")));
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("the lock of a LIVING process stays — otherwise two browsers damage the profile", async () => {
  const root = mkroot();
  const dir = chatProfileDir(root, "c1");
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  try {
    fs.symlinkSync(`${os.hostname()}-${child.pid}`, path.join(dir, "SingletonLock"));
    assert.equal(await releaseStaleLocks(dir), false);
    assert.ok(linkExists(path.join(dir, "SingletonLock")), "a living lock must not disappear");
  } finally {
    child.kill("SIGKILL");
    // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
    // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

test("a login from a chat travels into the stock and thus into the next chat", async () => {
  const root = mkroot();
  seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  // The chat logged in: cookie DB is younger than the stock's.
  write(path.join(dir, "Default", "Cookies"), "fresh-logged-in");
  touch(path.join(dir, "Default", "Cookies"), 5000);

  await saveChatLogins({ root, chatId: "c1", workspaceId: "ws1" });
  assert.equal(read(path.join(workspaceProfileDir(root, "ws1"), "Default", "Cookies")), "fresh-logged-in");

  const next = prepareChatProfile({ root, chatId: "c2", workspaceId: "ws1" });
  assert.equal(read(path.join(next, "Default", "Cookies")), "fresh-logged-in", "a new chat inherits the login");
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("a chat without browser use does not overwrite the stock", async () => {
  const root = mkroot();
  const jar = seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  // Meanwhile ANOTHER chat has updated the stock; this profile is old stock.
  write(path.join(jar, "Default", "Cookies"), "new-stock");
  touch(path.join(jar, "Default", "Cookies"), 5000);

  await saveChatLogins({ root, chatId: "c1", workspaceId: "ws1" });
  assert.equal(read(path.join(jar, "Default", "Cookies")), "new-stock");
  assert.equal(read(path.join(dir, "Default", "Cookies")), "cookie-stock", "the chat stays untouched");
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("a chat that only pulled in does NOT rewrite the stock", async () => {
  const root = mkroot();
  const jar = seedJar(root, "ws1");
  const cookies = path.join(jar, "Default", "Cookies");
  // The inode is the hard proof: writing goes via tmp + rename, so mirroring back replaces the file with a NEW one. The
  // mtime alone would not show it — it is carried along on copying and survives only to the millisecond.
  const before = fs.statSync(cookies).ino;

  // Run without any browsing: prepare (pulls in), then run end.
  prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  await saveChatLogins({ root, chatId: "c1", workspaceId: "ws1" });

  assert.equal(
    fs.statSync(cookies).ino, before,
    "the stock must stay untouched — otherwise every run would constantly rewrite it",
  );
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("a deleted chat takes its profile along, the stock stays", () => {
  const root = mkroot();
  seedJar(root, "ws1");
  const dir = prepareChatProfile({ root, chatId: "c1", workspaceId: "ws1" });
  removeChatProfile({ root, chatId: "c1" });
  assert.ok(!fs.existsSync(dir));
  assert.ok(fs.existsSync(workspaceProfileDir(root, "ws1")));
  // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
  // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
});

test("chatIdOfProfile separates chat profiles from workspace profiles", () => {
  assert.equal(chatIdOfProfile("chat-abc-123"), "abc-123");
  assert.equal(chatIdOfProfile("4b4fdef7-b28c-4c51-be10-a336d958c7a3"), "");
});

// ── Project containers: whose pid is in the lock? ─────────────────────────────────────────────────────
// A Chromium in a project container (hostname `cbp-<n>`) writes the pid of ITS namespace into the lock. Asking
// `process.kill(pid, 0)` in B's own namespace would delete the lock of a living browser whose pid means nothing in B. So
// the hostname decides (browser-profiles.js "WHOSE PID", seam projectbox/browser-network.js foreignProfileLock):
//   (S1) `cbp-<n>` without an instance of that name => with a readable store DEAD (falls), on a read error unknown =>
//        alive (stays); also a lock older than the start of its container => dead;
//   (S2) own hostname => as before, the seam is not asked; a foreign name that is no project container (a former user
//        container — B is named differently after every deploy), and without an operations mark also `cbp-<n>` => as
//        before: the corpse falls, docker is not asked;
//   (S3) `cbp-<n>` of an instance => `docker exec <c> kill -0 <pid>`: exit 0 stays, exit 1 falls — the pid counts in the
//        container (the fake docker maps `kill` to a script whose process table only the test knows: a pid that is dead in
//        B lives "inside");
//   (S4) docker without a verdict (neither 0 nor 1) => unknown => alive;
//   (S5) prepareChatProfile — the ONE synchronous reader, per turn in writeMcpConfig — never asks docker: a lock that only
//        the instance could judge stays there (Chromium in the container clears its own corpse at start);
//        releaseStaleLocks clears it afterwards;
//   (S6) reapUnusedChatProfiles asks the instance: a profile whose browser lives only inside stays;
//   (S7) the chain is asynchronous — no execFileSync/spawnSync/execSync in browser-profiles.js and browser-network.js;
//   (S8) the agent browser scanner (browsers.js) asks docker once per corpse — only a new lock or port file asks again —,
//        and a living one whose port does not answer does not ask at all during the failed-attempt pause;
//   (S9) a hanging dockerd costs ONE cap per pause (LOCK_PAUSE_MS): the remaining locks count as alive without asking,
//        afterwards it asks again;
//   (S10) a PAUSED project container is not "dead": a pause that cbase does not hold answers "is paused" with exit 1 — the
//        lock counts as alive, it stays; a container frozen by cbase is not asked at all (the scanner must not wait at the
//        barrier); after thawing it asks again.
// The tests load the module as a namespace and set the seam with `?.`, so they run unchanged against the state before the
// seam — there (S1), (S3), (S4), (S5) and (S6) are red. Counter-tests (S8)/(S9): 24 instead of 4 calls (six passes), 4 instead
// of 1 — both red; also one sabotage each: without the remembering 19, with the failed-attempt pause AFTER the docker question
// 9, without the cap pause 4, a pause without end "false instead of true"; (S10): "is paused" read as "dead" is red.
import * as profile from "../electron/server/browser-profiles.js";
import * as store from "../electron/server/store.js";
import * as dbModule from "../electron/server/store/db.js";
import { foreignProfileLock, PROJECT_HOSTNAME } from "../electron/server/projectbox/browser-network.js";
// As a namespace: the state before the repair does not know LOCK_PAUSE_MS, and (S9) should be red there, not the file unloadable.
import * as browserNetwork from "../electron/server/projectbox/browser-network.js";
import { startAgentScan } from "../electron/server/browsers.js";
import { advanceCap, pause, thawOut } from "../electron/server/projectbox/docker.js";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { after } from "node:test";

const S14_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-profile-s14-"));
store.initStore(S14_DATA);
after(() => fs.rmSync(S14_DATA, { recursive: true, force: true }));

// A pid that does not live in B (ESRCH) — counted from `ab`, so two calls yield two different ones.
function deadPid(from) {
  for (let p = from; ; p++) {
    try { process.kill(p, 0); } catch (e) { if (e.code === "ESRCH") return p; }
  }
}
const ALIVE_ONLY_WITHIN = deadPid(900_001);
const TOT_WITHIN = deadPid(ALIVE_ONLY_WITHIN + 1);

// `kill -0 <pid>` INSIDE the container: only ALIVE_ONLY_WITHIN lives there.
function killWithin(dir) {
  const script = path.join(dir, "kill-within");
  fs.writeFileSync(script, `#!/bin/sh\n[ "$1" = "-0" ] && [ "$2" = "${ALIVE_ONLY_WITHIN}" ] && exit 0\nexit 1\n`);
  fs.chmodSync(script, 0o755);
  return script;
}

async function withOpsS14(fd, fn, { ops = true } = {}) {
  const names = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN"];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    if (ops) Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });
    else for (const k of names) delete process.env[k];
    profile.setProfileLockSeam?.(foreignProfileLock);
    return await fn();
  } finally {
    profile.setProfileLockSeam?.(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// A project with an instance (hostname) and a running container in the fake docker.
let s14 = 0;
function instanceWithContainer(fd, hostname) {
  const projectId = `ps14x${++s14}`;
  store.createProjectInstance({ projectId, state: "ready", hostname, containerId: `id-${projectId}` });
  const name = `cbase-p-${projectId}`; // the main instance via its stable name
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
  return { projectId, name };
}
const killCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec").map((a) => a.args.join(" "));
function lockIn(root, name, target) {
  const dir = chatProfileDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, path.join(dir, "SingletonLock"));
  write(path.join(dir, "DevToolsActivePort"), "1234");
  return dir;
}
const lockOf = (dir) => path.join(dir, "SingletonLock");
const way = (root) => fs.rmSync(root, { recursive: true, force: true });

// (S1) `cbp-<n>` without an instance row with a READABLE store => dead — the container does not exist (any more); before,
// "unknown => alive" blocked the profile forever. Only a READ ERROR of the store stays "alive" (empty is not unknown) —
// measured with a closed database. Counter-test: the old browser-network.js => red (the lock stayed).
test("lock check (S1): the lock of a project container without an instance row falls if the store is readable; on a read error it stays", async () => {
  const root = mkroot();
  const fd = await fakeDocker();
  try {
    await withOpsS14(fd, async () => {
      const dir = lockIn(root, "s1", `cbp-201-${TOT_WITHIN}`);
      assert.equal(await profile.releaseStaleLocks(dir), true, "without an instance of that name the container does not exist — the lock falls");
      assert.ok(!linkExists(lockOf(dir)), "the lock is gone");
      const dir2 = lockIn(root, "s1-scan", `cbp-201-${TOT_WITHIN}`);
      assert.equal(await profile.leaveProfileSafely(dir2), true, "the scanner considers the profile abandoned");
      assert.deepEqual(killCalls(fd), [], "without an instance of that name nobody asks docker");
      // Counter-check: a read error of the store (closed database) is "unknown => alive".
      const dir3 = lockIn(root, "s1-read-error", `cbp-201-${TOT_WITHIN}`);
      dbModule.db.close();
      try {
        assert.equal(await profile.releaseStaleLocks(dir3), false, "a read error of the store counts as alive");
        assert.ok(linkExists(lockOf(dir3)), "the lock stays");
      } finally { store.initStore(S14_DATA); }
    });
  } finally { fd.cleanUp(); way(root); }
});

// Second case: the lock is OLDER than the last start of its container (`State.StartedAt`) — its Chromium ran in an earlier life
// of the container, and the same pid now belongs to another process (here: it "lives inside"). Dead, without `kill -0`.
// Counter-check: the same lock with a fresh mtime stays (lives inside). Product counter-test: the old browser-network.js => red
// (kill -0 said "alive").
test("fence network: a lock older than the start of its container is dead — even if the pid lives inside", async () => {
  const root = mkroot();
  const aux = mkroot();
  const fd = await fakeDocker({ programs: { kill: killWithin(aux) } });
  try {
    await withOpsS14(fd, async () => {
      instanceWithContainer(fd, "cbp-209");
      const prev = lockIn(root, "s-old", `cbp-209-${ALIVE_ONLY_WITHIN}`);
      const prior = (Date.now() - 3_600_000) / 1000;
      fs.lutimesSync(lockOf(prev), prior, prior);
      assert.equal(await profile.releaseStaleLocks(prev), true, "a lock from an earlier life of the container stayed");
      assert.ok(!linkExists(lockOf(prev)));
      const fresh = lockIn(root, "s-fresh", `cbp-209-${ALIVE_ONLY_WITHIN}`);
      assert.equal(await profile.releaseStaleLocks(fresh), false, "a fresh lock whose pid lives inside stays");
      assert.ok(linkExists(lockOf(fresh)));
    });
  } finally { fd.cleanUp(); way(root); way(aux); }
});

test("lock check (S2): own hostname and foreign names without a project container as before; without an operations mark also cbp-<n>", async () => {
  const root = mkroot();
  const fd = await fakeDocker();
  try {
    await withOpsS14(fd, async () => {
      const asked = [];
      profile.setProfileLockSeam?.((a) => { asked.push(a.host); return foreignProfileLock(a); });
      const own = lockIn(root, "s2-own", `${os.hostname()}-${TOT_WITHIN}`);
      assert.equal(await profile.releaseStaleLocks(own), true, "the own corpse falls as before");
      assert.deepEqual(asked, [], "for the own hostname the seam is not asked");
      // A former user container (without --hostname Docker assigns the id as the name, every deploy a new one).
      const prior = lockIn(root, "s2-prior", `0123456789ab-${TOT_WITHIN}`);
      assert.equal(await profile.releaseStaleLocks(prior), true, "the corpse of the previous B falls as before");
      assert.ok(!linkExists(lockOf(prior)));
      assert.ok(!PROJECT_HOSTNAME.test("0123456789ab") && PROJECT_HOSTNAME.test("cbp-12"), "the instrument separates the two names");
    });
    await withOpsS14(fd, async () => {
      const without = lockIn(root, "s2-without", `cbp-201-${TOT_WITHIN}`);
      assert.equal(await profile.releaseStaleLocks(without), true, "without an operations mark there are no project containers: as before");
    }, { ops: false });
    assert.deepEqual(killCalls(fd), [], "no docker exec");
  } finally { fd.cleanUp(); way(root); }
});

test("lock check (S3): the lock of an instance asks `docker exec <c> kill -0 <pid>` — exit 0 stays, exit 1 falls", async () => {
  const root = mkroot();
  const aux = mkroot();
  const fd = await fakeDocker({ programs: { kill: killWithin(aux) } });
  try {
    await withOpsS14(fd, async () => {
      const { name } = instanceWithContainer(fd, "cbp-202");
      const alive = lockIn(root, "s3-alive", `cbp-202-${ALIVE_ONLY_WITHIN}`);
      const tot = lockIn(root, "s3-tot", `cbp-202-${TOT_WITHIN}`);
      assert.equal(await profile.profileLockAlive(alive), true, "lives within (in B the same pid is dead)");
      assert.equal(await profile.leaveProfileSafely(tot), true, "dead inside: safely abandoned");
      assert.equal(await profile.releaseStaleLocks(alive), false);
      assert.ok(linkExists(lockOf(alive)), "the lock of a browser that lives only in the container stays");
      assert.equal(await profile.releaseStaleLocks(tot), true);
      assert.ok(!linkExists(lockOf(tot)) && !linkExists(path.join(tot, "DevToolsActivePort")), "the corpse falls together with the port file");
      const calls = killCalls(fd);
      const allowed = new Set([`exec ${name} kill -0 ${ALIVE_ONLY_WITHIN}`, `exec ${name} kill -0 ${TOT_WITHIN}`]);
      assert.ok(calls.length === 4 && calls.every((a) => allowed.has(a)), `only kill -0 in the instance's container: ${JSON.stringify(calls)}`);
    });
  } finally { fd.cleanUp(); way(root); way(aux); }
});

test("lock check (S4): a docker without a verdict (neither 0 nor 1) means unknown => alive", async () => {
  const root = mkroot();
  const fd = await fakeDocker();
  try {
    await withOpsS14(fd, async () => {
      const { name } = instanceWithContainer(fd, "cbp-203");
      // Broken only AFTER the start (as after a sysbox restart): the fake docker reads its configuration per call.
      const cfg = path.join(fd.dir, "config.json");
      fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), execBroken: [name] }));
      const dir = lockIn(root, "s4", `cbp-203-${TOT_WITHIN}`);
      assert.equal(await profile.releaseStaleLocks(dir), false, "exit 126 is not \"dead\"");
      assert.ok(linkExists(lockOf(dir)));
      assert.equal(killCalls(fd).length, 1, "docker was asked");
    });
  } finally { fd.cleanUp(); way(root); }
});

test("lock check (S5): prepareChatProfile (synchronous, per turn) never asks docker — the lock of an instance stays there", async () => {
  const root = mkroot();
  const aux = mkroot();
  const fd = await fakeDocker({ programs: { kill: killWithin(aux) } });
  try {
    await withOpsS14(fd, async () => {
      instanceWithContainer(fd, "cbp-204");
      const dir = lockIn(root, "s5", `cbp-204-${TOT_WITHIN}`);
      assert.equal(profile.prepareChatProfile({ root, chatId: "s5", workspaceId: "ws1" }), dir);
      assert.ok(linkExists(lockOf(dir)), "per turn without docker: what only the instance would know counts as alive");
      assert.deepEqual(killCalls(fd), [], "no docker in the synchronous path");
      assert.equal(await profile.releaseStaleLocks(dir), true, "the asynchronous path asks and clears");
      assert.ok(!linkExists(lockOf(dir)));
    });
  } finally { fd.cleanUp(); way(root); way(aux); }
});

test("lock check (S6): reapUnusedChatProfiles asks the instance — a profile whose browser lives only inside stays", async () => {
  const root = mkroot();
  const aux = mkroot();
  const fd = await fakeDocker({ programs: { kill: killWithin(aux) } });
  try {
    await withOpsS14(fd, async () => {
      instanceWithContainer(fd, "cbp-205");
      const alive = lockIn(root, "s6-alive", `cbp-205-${ALIVE_ONLY_WITHIN}`);
      const tot = lockIn(root, "s6-tot", `cbp-205-${TOT_WITHIN}`);
      const prev = new Date(Date.now() - 40 * 24 * 3600 * 1000);
      for (const d of [alive, tot]) fs.utimesSync(d, prev, prev);
      const removed = await profile.reapUnusedChatProfiles({ root });
      assert.deepEqual(removed, ["s6-tot"]);
      assert.ok(fs.existsSync(alive), "a profile whose browser lives in the container stays");
    });
  } finally { fd.cleanUp(); way(root); way(aux); }
});

test("lock check (S7): the chain of the lock check is asynchronous — no execFileSync, spawnSync, execSync", () => {
  for (const rel of ["../electron/server/browser-profiles.js", "../electron/server/projectbox/browser-network.js"]) {
    const text = fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(text, /\b(execFileSync|spawnSync|execSync)\b/, `${rel}: synchronous child process in the event loop`);
  }
});

// A port on `ip` where nobody listens (bound and freed again) — the port of a browser that lives but does not answer.
async function stummerPort(ip) {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, ip, resolve); });
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
const TOT_WITHIN_2 = deadPid(TOT_WITHIN + 1);

test("lock check (S8): the scanner asks docker ONCE per corpse until a new lock or port file comes; a living one without an answer pauses before docker", async (t) => {
  const root = mkroot();
  const aux = mkroot();
  const fd = await fakeDocker({ programs: { kill: killWithin(aux) } });
  const ip = await secondLoopback();
  const port = await stummerPort(ip);
  // The scanner's failed-attempt pause (30 s) counts with Date.now — frozen so a slow run cannot expire it.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let scan = null;
  try {
    await withOpsS14(fd, async () => {
      instanceWithContainer(fd, "cbp-206");
      const corpses = [1, 2, 3].map((i) => lockIn(root, `s8-tot${i}`, `cbp-206-${TOT_WITHIN}`));
      const alive = lockIn(root, "s8-alive", `cbp-206-${ALIVE_ONLY_WITHIN}`);
      for (const d of [...corpses, alive]) write(path.join(d, "DevToolsActivePort"), `${port}\n/devtools/browser/s8`);
      scan = startAgentScan(() => [{ root, host: ip, identifier: "ps14s8/main" }]);
      for (let i = 0; i < 5; i++) await scan.cycle();
      assert.equal(killCalls(fd).length, 4, `five passes, ONE kill -0 per profile: ${JSON.stringify(killCalls(fd))}`);
      // A new browser in one profile writes a new port file, in another a new lock: asked anew ONCE each.
      const later = new Date(fs.statSync(path.join(corpses[0], "DevToolsActivePort")).mtimeMs + 60_000);
      fs.utimesSync(path.join(corpses[0], "DevToolsActivePort"), later, later);
      fs.rmSync(lockOf(corpses[1]));
      fs.symlinkSync(`cbp-206-${TOT_WITHIN_2}`, lockOf(corpses[1]));
      for (let i = 0; i < 3; i++) await scan.cycle();
      assert.equal(killCalls(fd).length, 6, `new port file and new lock once each: ${JSON.stringify(killCalls(fd))}`);
      for (const d of [...corpses, alive]) assert.ok(linkExists(lockOf(d)), "the scanner deletes no lock");
    });
  } finally { scan?.stop(); fd.cleanUp(); way(root); way(aux); }
});

test("lock check (S9): a hanging dockerd costs ONE cap per pause — the remaining locks count as alive without asking, afterwards it asks again", async (t) => {
  const root = mkroot();
  const aux = mkroot();
  const fd = await fakeDocker({ programs: { kill: killWithin(aux) } });
  try {
    await withOpsS14(fd, async () => {
      instanceWithContainer(fd, "cbp-207");
      const dirs = [1, 2, 3].map((i) => lockIn(root, `s9-${i}`, `cbp-207-${TOT_WITHIN}`));
      // From here on every exec hangs (an inner dockerd that does not answer); the fake docker reads its configuration per call.
      const cfg = path.join(fd.dir, "config.json");
      fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), execGate: "s9-hangs" }));
      // The pause counts with Date.now: frozen from 0, so it is surely over after the test (1970 + 30 s).
      t.mock.timers.enable({ apis: ["Date"], now: 0 });
      const first = profile.releaseStaleLocks(dirs[0]);
      await fd.gateReached("s9-hangs");
      assert.equal(advanceCap(), 1, "exactly one kill -0 stands at the cap");
      assert.equal(await first, false, "at the cap: unknown => alive");
      for (const d of dirs.slice(1)) assert.equal(await profile.releaseStaleLocks(d), false, "in the pause: alive, without asking");
      assert.equal(await profile.leaveProfileSafely(dirs[1]), false, "the scanner path does not ask in the pause either");
      assert.equal(killCalls(fd).length, 1, `three profiles, ONE docker exec: ${JSON.stringify(killCalls(fd))}`);
      // After the pause the next lock asks again — docker answers by now, the corpse falls.
      t.mock.timers.tick(browserNetwork.LOCK_PAUSE_MS ?? 30_000);
      fd.openGate("s9-hangs");
      assert.equal(await profile.releaseStaleLocks(dirs[1]), true, "asked after the pause: dead, falls");
      assert.equal(killCalls(fd).length, 2);
      for (const d of [dirs[0], dirs[2]]) assert.ok(linkExists(lockOf(d)), "what counted as alive in the pause stayed");
    });
  } finally { fd.cleanUp(); way(root); way(aux); }
});

test("lock check (S10): a paused project container is not \"dead\" — a foreign pause (\"is paused\", exit 1) means alive, a frozen one is not asked, afterwards again", async () => {
  const root = mkroot();
  const aux = mkroot();
  const fd = await fakeDocker({ programs: { kill: killWithin(aux) } });
  const dx = (...args) => execFileSync(fd.bin, args, { env: { ...process.env, ...fd.env } });
  try {
    await withOpsS14(fd, async () => {
      const { name } = instanceWithContainer(fd, "cbp-208");
      const dir = lockIn(root, "s10", `cbp-208-${ALIVE_ONLY_WITHIN}`);
      // 1. A pause that cbase does NOT hold: the daemon rejects the exec with "is paused" (exit 1).
      dx("pause", name);
      try {
        assert.equal(await profile.leaveProfileSafely(dir), false, "\"is paused\" read as \"dead\" — the scanner remembered a living browser as abandoned");
        assert.equal(await profile.releaseStaleLocks(dir), false, "the lock of a living browser fell during the pause");
        assert.ok(linkExists(lockOf(dir)));
        assert.ok(killCalls(fd).length >= 1, "docker was not asked — the test does not measure the foreign pause");
      } finally {
        dx("unpause", name);
      }
      // 2. Frozen by cbase: alive, without asking docker.
      await pause(name);
      try {
        const mark = killCalls(fd).length;
        assert.equal(await profile.leaveProfileSafely(dir), false, "frozen read as \"dead\"");
        assert.equal(killCalls(fd).length, mark, "a docker exec while the container is frozen");
      } finally {
        await thawOut(name);
      }
      // 3. After thawing it asks again: the browser lives inside.
      const mark = killCalls(fd).length;
      assert.equal(await profile.profileLockAlive(dir), true);
      assert.equal(killCalls(fd).length, mark + 1, "not asked again after thawing");
      assert.ok(linkExists(lockOf(dir)));
    });
  } finally { fd.cleanUp(); way(root); way(aux); }
});
