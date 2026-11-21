// The browser of a chat — against the real server (in this process) and real Chromium.
//
// Every chat has its own browser; when the chat switches, the browser of the new chat is loaded too. What holds here, each
// promise with the sabotage that breaks it:
//   (1) POST /api/chats/:id/browser/ensure gives every chat ITS browser — scope `chat:<id>`, profile `chat-<id>` at the chat's
//       location, one session per chat (asked twice: the same); an archived chat gets none.
//       Counter-test: chatBrowserTarget with the workspace scope ⇒ red.
//   (2) Logins flow — a cookie in chat A's browser is, after it ends, in both stocks (profile of the workspace browser, Playwright
//       stock) and in chat B's browser; nothing is read from a stock with a running browser (live lock); a new profile reads
//       the main agent's old Playwright profile once.
//       Counter-test: endOf without mirrorLogins ⇒ red; takeOverLogins without the lock question ⇒ red;
//       chatBrowserTarget without the initial fill ⇒ red.
//   (3) Archiving ends the chat's browser; deleting ends it and removes its profile.
//       Counter-test: chatArchive without closeChatBrowser ⇒ red; chatTraces without `browserProfiles` ⇒ red.
//   (4) At the cap the longest-unobserved free chat browser yields; if all are held, 429 with a message that says it is a cap.
//       Counter-test: spaceForChatBrowser removed ⇒ red.
//
// It waits for states, never for a deadline.
// Run:  CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/chat-browser.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeBrowser, getBrowser, holdForAgent, listBrowsers, resolveChromium, closeUserBrowser } from "../electron/server/browsers.js";
import { chatProfileDir } from "../electron/server/browser-profiles.js";
import { chatBrowserProfile, chatTraces, locationForChat, playwrightProfileRoot } from "../electron/server/runs/runtime-location.js";
import { userBrowserTarget } from "../electron/server/devtools/user-browser.js";
import { playwrightProfileDir } from "../electron/server/toolchain/playwright.js";
import * as store from "../electron/server/store.js";
import { json, makeChat, makeWorkspace, waitFor, withServer } from "./server-harness.mjs";

const CHROMIUM = resolveChromium();
const without = !CHROMIUM ? "Chromium missing" : false;

// What a red test left open (e.g. a browser under a foreign scope) would otherwise keep the test process alive — red would become a hang.
test.after(() => { for (const b of listBrowsers()) if (b.kind === "user") closeBrowser(b.id); });

const ensure = (base, chatId) => json(`${base}/api/chats/${chatId}/browser/ensure`, { method: "POST" });
const session = (chatId) => listBrowsers().find((b) => b.kind === "user" && b.scopeKey === `chat:${chatId}`) || null;
const COOKIE = { name: "cbase_cb", value: "registered", domain: "cb.example.test", path: "/", expires: Math.floor(Date.now() / 1000) + 86_400 };
const hasCookie = async (id) => {
  const { cookies } = await getBrowser(id).cdp.send("Storage.getCookies", {});
  return cookies.some((c) => c.name === COOKIE.name && c.value === COOKIE.value);
};
// A live lock like that of a running Chromium: SingletonLock → "<this machine>-<this process>".
const lock = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, "SingletonLock")); };
const unlock = (dir) => fs.rmSync(path.join(dir, "SingletonLock"), { force: true });
// A chat with a message (a draft is not archivable and is in no list).
async function chatWithRow(base, wsId) {
  const c = await makeChat(base, wsId);
  store.addMessage(c.id, "user", "cb");
  return store.getChat(c.id);
}

test("(1) every chat its own browser — scope, profile, one session per chat; none archived", { skip: without }, async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "CB", wsPath);
    const a = await chatWithRow(base, ws.id);
    const b = await chatWithRow(base, ws.id);
    try {
      const ra = await ensure(base, a.id);
      const rb = await ensure(base, b.id);
      assert.equal(ra.status, 200, JSON.stringify(ra.body));
      assert.ok(ra.body.id && rb.body.id && ra.body.id !== rb.body.id, "two chats, two browsers");
      assert.equal(ra.body.scopeKey, `chat:${a.id}`);
      assert.equal(getBrowser(ra.body.id).profileDir, chatBrowserProfile(a), "profile chat-<id> at the chat's location");
      assert.equal(path.basename(getBrowser(rb.body.id).profileDir), `chat-${b.id}`);
      assert.equal((await ensure(base, a.id)).body.id, ra.body.id, "asked twice: the same session");
      // The page's (workspace) browsers stay as they are — another scope.
      assert.equal(listBrowsers().some((x) => x.scopeKey === `ws:${ws.id}`), false, "no workspace browser on the side");
    } finally {
      await closeUserBrowser(`chat:${a.id}`);
      await closeUserBrowser(`chat:${b.id}`);
    }
    const arch = await json(`${base}/api/chats/${a.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
    assert.equal(arch.status, 200, JSON.stringify(arch.body));
    assert.notEqual((await ensure(base, a.id)).status, 200, "an archived chat gets no browser");
    assert.equal(session(a.id), null);
  });
});

test("(2) logins flow between chat browser and stocks — never from a running stock, once from the old profile", { skip: without }, async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "CB", wsPath);
    const stocks = [userBrowserTarget({ workspace: { id: ws.id, name: "CB" } }).profileDir, playwrightProfileDir(ws.id)];
    const [a, b, c, d] = [await chatWithRow(base, ws.id), await chatWithRow(base, ws.id), await chatWithRow(base, ws.id), await chatWithRow(base, ws.id)];
    try {
      // Chat A signs in (a persistent cookie), then its browser ends.
      const ra = await ensure(base, a.id);
      await getBrowser(ra.body.id).cdp.send("Storage.setCookies", { cookies: [COOKIE] });
      assert.equal(await hasCookie(ra.body.id), true, "starting point: A has the cookie");
      assert.equal(await closeUserBrowser(`chat:${a.id}`), true);
      for (const v of stocks) assert.ok(fs.existsSync(path.join(v, "Default", "Cookies")), `the stock ${v} carries A's cookie database`);

      // Chat B inherits the login.
      const rb = await ensure(base, b.id);
      assert.equal(await hasCookie(rb.body.id), true, "B inherits the cookie from the stock");
      await closeUserBrowser(`chat:${b.id}`);

      // If a stock's browser is running (live lock), nothing is read from it.
      for (const v of stocks) lock(v);
      try {
        const rc = await ensure(base, c.id);
        assert.equal(await hasCookie(rc.body.id), false, "nothing is read from a stock with a running browser");
        await closeUserBrowser(`chat:${c.id}`);

        // Initial fill: D's main agent's old Playwright profile (its browser until the change) carries the login.
        const old = chatProfileDir(playwrightProfileRoot(locationForChat(d)), d.id);
        fs.mkdirSync(path.join(old, "Default"), { recursive: true });
        fs.copyFileSync(path.join(stocks[0], "Default", "Cookies"), path.join(old, "Default", "Cookies"));
        const rd = await ensure(base, d.id);
        assert.equal(await hasCookie(rd.body.id), true, "a new profile reads the chat's old Playwright profile once");
      } finally {
        for (const v of stocks) unlock(v);
      }
    } finally {
      for (const x of [a, b, c, d]) await closeUserBrowser(`chat:${x.id}`);
    }
  });
});

test("(3) archiving ends the browser, deleting ends it and removes its profile", { skip: without }, async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "CB", wsPath);
    const a = await chatWithRow(base, ws.id);
    const b = await chatWithRow(base, ws.id);
    try {
      await ensure(base, a.id);
      await ensure(base, b.id);
      assert.ok(session(a.id) && session(b.id), "starting point: both run");
      const arch = await json(`${base}/api/chats/${a.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
      assert.equal(arch.status, 200, JSON.stringify(arch.body));
      assert.equal(session(a.id), null, "archived ⇒ the browser is ended");
      assert.ok(fs.existsSync(chatBrowserProfile(a)), "archived ⇒ the profile stays (restoring opens it as before)");

      const profile = chatBrowserProfile(b);
      assert.ok(chatTraces(locationForChat(b), b.id).some((s) => s.field === "browserProfiles" && s.path === profile), "the profile is a trace of the chat");
      const way = await json(`${base}/api/chats/${b.id}`, { method: "DELETE" });
      assert.equal(way.status, 200, JSON.stringify(way.body));
      assert.equal(session(b.id), null, "deleted ⇒ the browser is ended");
      await waitFor(async () => !fs.existsSync(profile), "deleted ⇒ the profile is gone");
    } finally {
      await closeUserBrowser(`chat:${a.id}`);
      await closeUserBrowser(`chat:${b.id}`);
    }
  });
});

test("(4) the cap — the oldest free chat browser yields; if all are held, 429 with a message", { skip: without }, async () => {
  const prior = process.env.CBASE_CHAT_BROWSER_MAX;
  process.env.CBASE_CHAT_BROWSER_MAX = "2";
  try {
    await withServer(async ({ base, wsPath }) => {
      const ws = await makeWorkspace(base, "CB", wsPath);
      const [f, g, h] = [await chatWithRow(base, ws.id), await chatWithRow(base, ws.id), await chatWithRow(base, ws.id)];
      const hold = [];
      try {
        await ensure(base, f.id);
        await ensure(base, g.id);
        hold.push(holdForAgent(`chat:${f.id}`, f.id), holdForAgent(`chat:${g.id}`, g.id));
        assert.ok(hold.every(Boolean), "starting point: both held");
        const full = await ensure(base, h.id);
        assert.equal(full.status, 429, JSON.stringify(full.body));
        assert.match(full.body.error, /Deckel 2/, "the message says it is a cap");
        assert.equal(session(h.id), null);
        hold[1].approve(); // g becomes free
        const rh = await ensure(base, h.id);
        assert.equal(rh.status, 200, JSON.stringify(rh.body));
        assert.ok(session(h.id), "h runs");
        assert.equal(session(g.id), null, "the free g yielded");
        assert.ok(session(f.id), "the held f stays");
      } finally {
        for (const x of hold) x?.approve();
        for (const x of [f, g, h]) await closeUserBrowser(`chat:${x.id}`);
      }
    });
  } finally {
    if (prior === undefined) delete process.env.CBASE_CHAT_BROWSER_MAX; else process.env.CBASE_CHAT_BROWSER_MAX = prior;
  }
});
