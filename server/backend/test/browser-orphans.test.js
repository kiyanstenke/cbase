// No own browser outlives its backend — against the real server (in this process), real Chromium and real child processes.
//
// What holds here, each promise with the way that breaks it:
//   (1) Closing the server ends every own browser it started (chat browser via POST /api/chats/:id/browser/ensure): no process
//       with the owner marker of this process is left, and the browser led its OWN process group (helpers included).
//       Counter-test: the `close` acceptor in server.js without closeAllUserBrowsers ⇒ red (measured 2026-11-21).
//   (2) A backend killed with SIGKILL leaves nothing behind: on Linux the browser dies with it (setpriv --pdeathsig), on every
//       platform the sweep of the next server ends what is left (marker with a dead owner).
//       Counter-test: sweepOrphanedBrowsers without the kill ⇒ red (on macOS; on Linux the death signal already ends it).
//   (3) SIGTERM to a process without its own signal handler (no headless.js) ends its browsers too, and the process still dies by
//       SIGTERM (the default action stays).
//       Counter-test: the signal net without killAllBrowserGroups ⇒ red.
//   (4) The sweep at server start ends a planted leftover with the marker of a dead owner — and leaves alone a process with the
//       marker of a LIVING owner and a process without the marker (never by name).
//       Counter-test: server.js without `void sweepOrphanedBrowsers()` ⇒ red; the sweep without the owner question ⇒ red.
//
// Waiting is for states (process gone, line on stdout), each with a cap that reports itself and prints the process list.
// Run:  CBASE_EMBED_OFFLINE=1 node --test --test-timeout=180000 --test-reporter=tap server/backend/test/browser-orphans.test.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { listBrowsers, closeBrowser, resolveChromium } from "../electron/server/browsers.js";
import { OWNER_SWITCH, markedProcesses, ownerMarker, sweepOrphanedBrowsers } from "../electron/server/browser-process.js";
import { json, makeChat, makeWorkspace, withServer } from "./server-harness.mjs";

const CHROMIUM = resolveChromium();
const without = !CHROMIUM ? "Chromium missing" : false;
// The gate switches off the chats' browser for all suites — the route below does not ask, but this file tests the browser.
process.env.CBASE_CHAT_BROWSER_OFF = "0";
test.after(() => { for (const b of listBrowsers()) if (b.kind === "user") closeBrowser(b.id); });

const BROWSERS_JS = pathToFileURL(path.join(import.meta.dirname, "..", "electron", "server", "browsers.js")).href;
const CAP_MS = 20_000;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const ofOwner = async (owner) => (await markedProcesses()).filter((r) => r.owner === owner);

// Waits until `check()` is true; after CAP_MS red with `what` and the marked processes of `owner`.
async function until(check, what, owner) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > CAP_MS) {
      const left = owner ? await ofOwner(owner) : [];
      assert.fail(`cap of ${CAP_MS} ms: ${what} — marked processes of ${owner}: ${JSON.stringify(left.map((r) => ({ pid: r.pid, pgid: r.pgid, args: r.args.slice(0, 120) })))}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
const hardKill = (rows) => { for (const r of rows) { try { process.kill(r.pgid === r.pid ? -r.pid : r.pid, "SIGKILL"); } catch {} } };

// A child process that starts an own browser through browsers.js, prints `READY <pid>` and then idles.
function browserChild(root) {
  const code = `
    const { ensureUserBrowser } = await import(${JSON.stringify(BROWSERS_JS)});
    await ensureUserBrowser({ scopeKey: "ws:orphans", profileDir: ${JSON.stringify(path.join(root, "profile"))}, label: "orphans", workspaceId: "orphans" });
    console.log("READY " + process.pid);
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stderr.on("data", (d) => { err += d; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { out += d; if (/READY \d+/.test(out)) resolve(); });
    child.on("exit", (c, s) => reject(new Error(`child ended ${c}/${s} before READY: ${err.slice(-600)}`)));
  });
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return { child, ready, exited };
}

test("(1) closing the server ends the chat browser — its whole group, no marked process left", { skip: without, timeout: 120_000 }, async (t) => {
  let leader = null;
  try {
    await withServer(async ({ base, wsPath }) => {
      const ws = await makeWorkspace(base, "Orphans", wsPath);
      const chat = await makeChat(base, ws.id);
      const r = await json(`${base}/api/chats/${chat.id}/browser/ensure`, { method: "POST" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body?.id && !r.body.error, `the chat browser started: ${JSON.stringify(r.body)}`);
      const mine = await ofOwner(process.pid);
      assert.ok(mine.length >= 1, "the started browser carries the owner marker of this process");
      leader = mine.find((x) => x.pgid === x.pid);
      assert.ok(leader, `the browser leads its own process group: ${JSON.stringify(mine.map((x) => [x.pid, x.pgid]))}`);
      t.diagnostic(`chat browser ${leader.pid} leads group ${leader.pgid}, ${mine.length} marked process(es)`);
    });
    await until(async () => !groupAlive(leader.pgid) && (await ofOwner(process.pid)).length === 0,
      "after server.close the browser's group is gone and no marked process of this process is left", process.pid);
  } finally {
    hardKill(await ofOwner(process.pid));
  }
});

test("(2) SIGKILL of the backend: the browser does not outlive it (Linux: death signal; everywhere: the sweep)", { skip: without, timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-orphans-"));
  const c = browserChild(root);
  let owner = null;
  try {
    await c.ready;
    owner = c.child.pid;
    const before = await ofOwner(owner);
    assert.ok(before.some((x) => x.pgid === x.pid), `the child's browser leads its own group: ${JSON.stringify(before.map((x) => [x.pid, x.pgid]))}`);
    c.child.kill("SIGKILL");
    await c.exited;
    if (process.platform === "linux") {
      await until(async () => (await ofOwner(owner)).length === 0, "Linux: the browser died with its parent (pdeathsig) — without a sweep", owner);
      t.diagnostic("Linux: the death signal ended the browser");
    } else {
      // macOS has no death signal: measured, the browser survives its parent. The sweep (the next server start) ends it.
      const left = await ofOwner(owner);
      t.diagnostic(`${process.platform}: ${left.length} marked process(es) outlived the SIGKILL — the sweep's case`);
      // Which sweep ends it does not matter: in the gate other test servers start in parallel, and each start sweeps — one of them
      // may be first (seen in the gate: this sweep found nothing, the orphan was already gone). Only a sweep kills a marked process
      // of a dead owner, so "nothing of the owner is left" below is the proof; with a sweep that does not kill it stays red.
      const { ended } = await sweepOrphanedBrowsers();
      t.diagnostic(`this sweep ended ${ended.filter((e) => e.owner === owner).length} of ${left.length}`);
      await until(async () => (await ofOwner(owner)).length === 0, "the sweep left no marked process of the killed backend", owner);
    }
  } finally {
    try { c.child.kill("SIGKILL"); } catch {}
    if (owner) hardKill(await ofOwner(owner));
    // A Chrome helper without the owner marker (crashpad) may still write into the profile: cleaning up the temp folder is not the
    // promise of this test — a leftover folder is reported, not failed (seen on the Linux runner: ENOTEMPTY even after 10 retries).
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }); } catch (e) { t.diagnostic(`temp folder left: ${e.code}`); }
  }
});

test("(3) SIGTERM without a signal handler of its own: the browsers end, the process still dies by SIGTERM", { skip: without, timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-orphans-"));
  const c = browserChild(root);
  let owner = null;
  try {
    await c.ready;
    owner = c.child.pid;
    const leader = (await ofOwner(owner)).find((x) => x.pgid === x.pid);
    assert.ok(leader, "the child's browser leads its own group");
    // On Linux the death signal would end the browser anyway once the child is gone — the group must be gone when the child is.
    c.child.kill("SIGTERM");
    const { signal } = await c.exited;
    assert.equal(signal, "SIGTERM", "the default action of SIGTERM stays (the net raises it again)");
    await until(async () => !groupAlive(leader.pgid) && (await ofOwner(owner)).length === 0, "after SIGTERM the browser's group is gone without a sweep", owner);
  } finally {
    try { c.child.kill("SIGKILL"); } catch {}
    if (owner) hardKill(await ofOwner(owner));
    // A Chrome helper without the owner marker (crashpad) may still write into the profile: cleaning up the temp folder is not the
    // promise of this test — a leftover folder is reported, not failed (seen on the Linux runner: ENOTEMPTY even after 10 retries).
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }); } catch (e) { t.diagnostic(`temp folder left: ${e.code}`); }
  }
});

// A planted process with an argv of our choice, leader of its own group (like a browser of way 1).
function plant(args) {
  const p = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore", detached: true });
  const exited = new Promise((r) => p.on("exit", () => r()));
  return { p, exited };
}
async function deadPid() {
  const p = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => p.on("exit", r));
  assert.equal(alive(p.pid), false, "the borrowed pid is free");
  return p.pid;
}

test("(4) the sweep at server start ends a leftover of a dead owner — never one of a living owner, never one without the marker", { timeout: 120_000 }, async () => {
  const dead = await deadPid();
  const livingOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const foreign = plant([ownerMarker(livingOwner.pid), "--headless=new"]);
  const unmarked = plant([`${OWNER_SWITCH}x=${dead}`, "--headless=new"]); // similar, but not the marker
  const planted = [];
  try {
    // Test servers starting in parallel sweep too: one may end the orphan between two reads (seen in the gate: the second read found it
    // gone — "reading 'owner' of undefined"). So the row comes from the read the wait sees, and an orphan a foreign sweep took before
    // it was seen at all is planted anew. Who ends it later does not matter (see (2)): only a sweep kills a marked process.
    let orphan = null;
    let seen = null;
    while (!seen) {
      orphan = plant([ownerMarker(dead), "--headless=new"]);
      planted.push(orphan.p);
      await until(async () => {
        seen = (await markedProcesses()).find((r) => r.pid === orphan.p.pid) || null;
        return seen || !alive(orphan.p.pid);
      }, "the planted orphan is visible with its marker", dead);
    }
    assert.equal(seen.owner, dead);
    assert.equal(seen.pgid, orphan.p.pid, "the planted orphan leads its group");
    assert.equal((await markedProcesses()).some((r) => r.pid === unmarked.p.pid), false, "a look-alike switch is no marker");
    await withServer(async () => {
      await until(async () => !alive(orphan.p.pid), "the sweep of the server start ended the orphan of the dead owner", dead);
    });
    await orphan.exited;
    assert.equal(alive(foreign.p.pid), true, "the browser of a LIVING owner stays");
    assert.equal(alive(unmarked.p.pid), true, "a process without the marker stays");
    // The direct call says what it did — and does nothing more on a second pass.
    const again = await sweepOrphanedBrowsers();
    assert.equal(again.ended.some((e) => e.pid === foreign.p.pid || e.pid === unmarked.p.pid), false, JSON.stringify(again));
  } finally {
    for (const x of [...planted, foreign.p, unmarked.p, livingOwner]) { try { x.kill("SIGKILL"); } catch {} }
  }
});
