// A living user browser never has zero tabs — against REAL Chromium.
//
// The incident: `act closeTab` on the last tab left the session alive with `tabs:0`; `attachViewer` found no tab and
// wrote "gone"; the client cleared its id and called ensure(); `ensureUserBrowser` found the SAME session; the next
// stream wrote "gone" again — the "reload tab" endless loop. Since then (browsers.js, `saveTab`/`newTab`/`registerTab`):
// closeTab on the last tab creates the replacement FIRST, `targetDestroyed` without a remaining tab creates one, and
// `attachViewer` creates one instead of writing "gone".
//
// Why real Chromium and no fake: the promise depends on the order of CDP response and event (createTarget answers,
// targetCreated comes before or after) and on what Chromium really does on closeTarget of the last target — a fake would
// have rebuilt exactly that instead of measuring it. Pattern as captures-e2e.test.js: skipped where Chromium is missing.
//
// Counter-tests (each of the three places reverted individually): without the replacement creation in `act closeTab`
// => "exactly ONE replacement tab — measured 0"; without the fallback in `targetDestroyed` => "in the window the
// createTarget of wireTargets is already running" (false !== true); without `saveTab` in `attachViewer` => "viewer in
// the window got no hello — events: gone". All three together => the first. Case 3 (the double click) against `await
// newTab(s)` instead of `fallbackTab(s)` in `act closeTab` => "two parallel closeTab … created 2 replacement tabs".
//
// Run:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 node --test server/backend/test/browser-last-tab.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { act, attachViewer, closeBrowser, ensureUserBrowser, getBrowser, listBrowsers, resolveChromium, tabList } from "../electron/server/browsers.js";

const CHROMIUM = resolveChromium();

// Wait until a condition is true — without a deadline (no clock a test goes red on; the emergency brake is the suite).
// `what` goes to stderr every 30 s so a hang stays readable.
async function waitFor(what, fn, { tickMs = 50 } = {}) {
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

// An SSE response object as attachViewer needs it: collects what the server writes and can trigger the viewer's
// "close" (so stopCastIfIdle/armIdle run).
function fakeRes() {
  const chunks = [];
  const handlers = {};
  return {
    chunks,
    writableLength: 0,
    destroyed: false,
    ended: false,
    write(s) { chunks.push(String(s)); return true; },
    end() { this.ended = true; },
    on(ev, fn) { handlers[ev] = fn; },
    close() { this.destroyed = true; handlers.close?.(); },
    events() { return chunks.map((c) => /^event: (\S+)/m.exec(c)?.[1]).filter(Boolean); },
    hello() { const c = chunks.find((x) => x.startsWith("event: hello")); return c ? JSON.parse(/^data: (.*)$/m.exec(c)[1]) : null; },
  };
}

const savedTabs = (profileDir) => {
  try { return JSON.parse(fs.readFileSync(path.join(profileDir, "cbase-tabs.json"), "utf8")); } catch { return null; }
};

test("last tab: closeTab keeps the session alive with one tab, ensure returns it again, the stream says hello instead of gone — a tab closed from outside gets a replacement, a double click only one", { skip: !CHROMIUM ? "Chromium missing" : false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-last-tab-"));
  const profileDir = path.join(root, "profile");
  const scopeKey = `test:last-tab:${path.basename(root)}`;
  // A real http URL so the tab backup has something to save (it filters about: and data:).
  const web = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<h1>cbase last tab</h1>"); });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const page = `http://127.0.0.1:${web.address().port}/page`;
  let proc = null;
  let id = "";
  try {
    const t0 = Date.now();
    const b = await ensureUserBrowser({ scopeKey, profileDir, label: "Last tab", workspaceId: "ws-test" });
    id = b.id;
    const s = getBrowser(id);
    assert.ok(s, "session present after ensure");
    proc = s.proc;
    // The first tab (about:blank from the start) arrives via targetCreated — there shortly after.
    await waitFor("first tab registered", () => s.tabOrder.length >= 1);
    t.diagnostic(`Chromium started and first tab there after ${Date.now() - t0} ms`);
    const firstTab = s.tabOrder[0];

    // The backup writes only real URLs — navigate first, then it has a tab to save.
    assert.deepEqual(await act(id, { type: "navigate", url: page }), { ok: true });
    await waitFor("cbase-tabs.json carries the page", () => savedTabs(profileDir)?.urls?.includes(page));

    // ── Case 1: closeTab on the ONLY tab ──
    assert.equal(tabList(s).length, 1, "starting point: exactly one tab");
    assert.deepEqual(await act(id, { type: "closeTab", tab: firstTab }), { ok: true });
    await waitFor("old tab gone", () => !s.tabs.has(firstTab));
    assert.ok(getBrowser(id), "the session lives after closing the last tab");
    assert.equal(s.tabOrder.length, 1, `exactly ONE replacement tab — measured ${s.tabOrder.length}`);
    assert.ok(s.activeTargetId && s.tabs.has(s.activeTargetId), "the replacement tab is the active one");
    assert.ok(listBrowsers().some((x) => x.id === id), "the list (/api/browsers) still lists the session");

    // ensure finds the SAME session — what is new is that it has a tab (the identity is checked, not the count).
    const b2 = await ensureUserBrowser({ scopeKey, profileDir, label: "Last tab", workspaceId: "ws-test" });
    assert.equal(b2.id, id, "ensure returns the same session");

    // The stream: hello with a tab, no gone.
    const res = fakeRes();
    await attachViewer(id, "", res);
    const hello = res.hello();
    assert.ok(hello, `attachViewer wrote no hello — events: ${res.events().join(", ") || "none"}`);
    assert.ok(hello.tabs.length >= 1, "hello carries at least one tab");
    assert.equal(hello.tab, s.activeTargetId, "hello hangs on the active (replacement) tab");
    assert.ok(!res.events().includes("gone"), `the stream says "gone": ${res.events().join(", ")}`);
    assert.ok(!res.ended, "attachViewer did not end the stream");
    res.close();

    // The backup: the closed tab does NOT come back at the next start — about:blank drops out of the list, and the list is
    // the state AT write time, not the one before closing.
    const backedUp = await waitFor("cbase-tabs.json without the closed page", () => {
      const g = savedTabs(profileDir);
      return g && !g.urls.includes(page) ? g : null;
    });
    assert.deepEqual(backedUp.urls, [], `about:blank is not in the backup — measured ${JSON.stringify(backedUp.urls)}`);

    // ── Case 2: the only tab closes FROM OUTSIDE (not via act) ──
    // A viewer arrives EXACTLY in the window: the tab has just left the registry, the replacement is only requested.
    // The handler below runs after the one from wireTargets (registration order of the set) — i.e. with an empty tab
    // list and a running createTarget. The viewer attaches to the ONE running createTarget (no second replacement tab).
    const sole = s.activeTargetId;
    const res2 = fakeRes();
    let viewer = null;
    let window = null; // what held in the window — checked AFTER the handler, because Cdp swallows handler errors
    s.cdp.onEvent((msg) => {
      if (msg.method === "Target.targetDestroyed" && msg.params.targetId === sole && !viewer) {
        window = { tabs: s.tabOrder.length, creationRunning: !!s.tabCreation };
        viewer = attachViewer(id, "", res2);
      }
    });
    await s.cdp.send("Target.closeTarget", { targetId: sole });
    // `!!` on purpose: waitFor awaits the return value, and a promise would resolve to its value (undefined) — the test
    // would then wait forever for something that is already there.
    await waitFor("targetDestroyed of the only tab", () => !!viewer);
    await viewer;
    assert.equal(window.tabs, 0, "in the window the tab list is empty — otherwise the test does not measure the window");
    assert.equal(window.creationRunning, true, "in the window the createTarget of wireTargets (targetDestroyed) is already running — without the fallback a browser without a viewer would stay at zero tabs");
    assert.ok(res2.hello(), `viewer in the window got no hello — events: ${res2.events().join(", ") || "none"}`);
    assert.ok(!res2.events().includes("gone"), `the stream in the window says "gone": ${res2.events().join(", ")}`);
    await waitFor("replacement after outside closing", () => !s.tabs.has(sole) && s.tabOrder.length >= 1 && !s.tabCreation);
    assert.ok(getBrowser(id), "the session lives after the outside closing too");
    assert.equal(s.tabOrder.length, 1, `exactly ONE replacement tab — fallback and viewer share the one createTarget; measured ${s.tabOrder.length}`);
    assert.equal(res2.hello().tab, s.activeTargetId, "the viewer hangs on the replacement tab");
    res2.close();

    // ── Case 3: TWO closeTab on the last tab, in parallel (double click on the × over a link with a long POST path — the
    // tab only disappears after targetDestroyed) ──
    // Both still see the tab as the last one; the replacement creation runs via s.tabCreation and is thus ONE
    // createTarget for both — without it: two about:blank tabs.
    const last = s.activeTargetId;
    const cdpSend = s.cdp.send.bind(s.cdp);
    let createTargets = 0;
    s.cdp.send = (m, p, sid) => { if (m === "Target.createTarget") createTargets++; return cdpSend(m, p, sid); };
    try {
      const [r1, r2] = await Promise.all([act(id, { type: "closeTab", tab: last }), act(id, { type: "closeTab", tab: last })]);
      assert.equal(r1.ok, true, "the first closeTab closes");
      t.diagnostic(`double click: second closeTab => ${JSON.stringify(r2)}`);
      await waitFor("the doubly closed tab is gone", () => !s.tabs.has(last) && !s.tabCreation);
      // Barrier instead of 300 ms: Chromium answers the commands of a connection in order and sends the events it produced
      // before BEFORE the answer. A second targetCreated — or a createTarget that a handler only sends in reaction to an
      // answer of its own — is there after this round trip.
      await s.cdp.send("Target.getTargets", {});
    } finally { s.cdp.send = cdpSend; }
    assert.equal(createTargets, 1, `two parallel closeTab on the last tab created ${createTargets} replacement tabs — one createTarget for both`);
    assert.equal(s.tabOrder.length, 1, `after the double click exactly one tab — measured ${s.tabOrder.length}`);
    t.diagnostic(`all three cases after ${Date.now() - t0} ms`);
  } finally {
    // Shutdown: destroySession kills the process, the targets die one after the other — no replacement tab may be
    // requested any more (s.closed). An unhandled rejection would turn this red.
    if (id) closeBrowser(id);
    if (proc) {
      await new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode) return resolve();
        const timer = setTimeout(resolve, 5000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await new Promise((r) => web.close(r));
    // A test must not fail because its temp directory does not go away: a child process still writing produces
    // ENOTEMPTY, which says something about the cleanup, not about the product. It is still not kept quiet — otherwise
    // garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
