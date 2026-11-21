// Watching an agent browse and intervening for it — against REAL Chromium and the real server.
//
// The finding, measured with the real server and real @playwright/mcp 0.0.78: the route delivered frames, inputs arrived —
// but the right chat bar chose the SESSION id, and the agent starts a new Chromium per run (turn, workflow step) in the same
// profile: new session, new id, and the bar silently fell back to its own browser (about:blank). If the agent opened a new
// tab, the view stayed on the first one. A subagent's browser stood under its raw folder name and WITHOUT a workspace
// (missing from every filtered list). And the port file of a finished browser stayed behind, the scanner knocked on the
// dead port again and again.
//
// What holds here, every line against the real browser:
//   (1) Main agent ("chat-<id>") and subagent ("chat-<id>-agent-<aid>") appear in GET /api/browsers with their identity
//       (`profile`, `chatId`, `agentId`), their name (chat title resp. the subagent's description) and the chat's
//       workspace — also in the list filtered by workspace.
//   (2) Per browser: a viewer via /stream gets hello and a frame, a click and text via /input land in the input field of
//       THIS browser (read over the "agent's" line, not ours).
//   (3) If the agent opens a tab and works there, that is the agent's tab (`agentTab`, `activeAt`): the running viewer
//       gets it in the tabs event, a new viewer without a tab choice attaches to it, an input without a tab goes into it.
//   (4) If the agent restarts its Chromium (next run), the same PROFILE appears with a new session.
//   (5) The scanner no longer knocks on the port of a browser whose end we saw, nor on that of a crashed one (lock there,
//       process dead); on a live port file without a lock it does (the control proves the instrument).
//
// Why a bare Chromium and not @playwright/mcp: the test should run on every machine with Chromium, without an npx cache.
// What counts here is rebuilt — a Chromium with `--remote-debugging-port=0` in the chat's profile that writes its port
// file, and ANOTHER client that drives it (for Playwright the pipe, here an own WebSocket).
//
// We wait for states, never for a deadline — if a path hangs, the suite ends it. The two absences in (5) need no time
// window: two control profiles, each created after the previous one was knocked on, prove that a whole scan pass is over
// AFTER the setup.
//
// Counter-tests: the state before the repair is red in (1) ("profile missing"); without `rememberActivity` red in (3);
// without the mapping in devtools/browser-names.js red in (1) at the subagent's name and workspace; without `deadKey`
// resp. `leaveProfileSafely` red in (5).
//
// Run:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_EMBED_OFFLINE=1 \
//             node --test --test-reporter=tap server/backend/test/browser-agent-choice.test.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveChromium } from "../electron/server/browsers.js";

// Chromium (usually Google Chrome here) with the REAL HOME: with an empty one Chrome starts every navigation and finishes
// none. The server gets an empty one (see below).
const REAL_HOME = process.env.HOME;
const CHROMIUM = resolveChromium();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for a state — without a deadline. `what` is in the stack if the suite ends a hang.
async function waitForTruthy(what, fn) {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await sleep(60);
  }
}
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A Chromium as Playwright starts it for the agent: headless, own profile, debug port 0 (=> DevToolsActivePort).
// The WebSocket address comes from stderr — NO HTTP retrieval against the booting browser (see the note in browsers.js).
function startAgentsChromium(profile, url) {
  fs.mkdirSync(profile, { recursive: true });
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--enable-automation", "--window-size=1000,700"];
  if (process.platform === "linux") args.push("--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
  args.push(url);
  const proc = spawn(CHROMIUM, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: REAL_HOME } });
  const wsUrl = new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.once("exit", (c) => reject(new Error(`Chromium exited (code ${c}): ${buf.slice(-300)}`)));
  });
  return { proc, wsUrl };
}
const end = (proc, signal = "SIGTERM") => new Promise((resolve) => {
  if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
  proc.once("exit", () => resolve());
  try { proc.kill(signal); } catch { resolve(); }
});

// The "agent's" line (for Playwright the pipe): an own CDP client, flat sessions.
async function agentsLine(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP connection failed")); });
  let seq = 0;
  const open = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && open.has(m.id)) { const p = open.get(m.id); open.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    open.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const sessions = new Map();
  const session = async (targetId) => {
    if (!sessions.has(targetId)) sessions.set(targetId, (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId);
    return sessions.get(targetId);
  };
  const evaluate = async (targetId, expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true }, await session(targetId))).result?.value;
  const firstPage = async () => (await send("Target.getTargets")).targetInfos.find((t) => t.type === "page")?.targetId;
  return { send, evaluate, firstPage, close: () => { try { ws.close(); } catch { /* gone */ } } };
}

// An SSE viewer over the real route: collects events, acks frames like the client.
function viewer(base, id, tab = "") {
  const events = [];
  let vid = "";
  const req = http.get(`${base}/api/browsers/${id}/stream${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`, (res) => {
    let buf = "";
    res.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const kind = /^event: (\S+)/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || "{}");
        events.push({ kind, data });
        if (kind === "hello") vid = data.vid;
        if (kind === "frame" && vid) {
          void fetch(`${base}/api/browsers/${id}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: [{ t: "ack", v: vid, seq: data.seq }] }) }).catch(() => {});
        }
      }
    });
  });
  req.on("error", () => {});
  return {
    events,
    hello: () => events.find((e) => e.kind === "hello")?.data || null,
    frame: () => events.find((e) => e.kind === "frame")?.data || null,
    shutdown: () => { try { req.destroy(); } catch { /* gone */ } },
  };
}

// A server that only counts who knocks — stands on a port that a port file names.
async function knockCounter(port = 0) {
  let n = 0;
  const s = http.createServer((_req, res) => { n++; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  for (;;) {
    const ok = await new Promise((resolve) => { s.once("error", () => resolve(false)); s.listen(port, "127.0.0.1", () => resolve(true)); });
    if (ok) break;
    await sleep(100); // the port of the just-finished Chromium is being freed
  }
  return { port: s.address().port, count: () => n, shutdown: () => new Promise((r) => s.close(() => r())) };
}

const PAGE = (title) => "data:text/html," + encodeURIComponent(
  `<title>${title}</title><body style="margin:0;font:20px sans-serif"><h1>${title}</h1><input id=u autofocus style="font-size:24px;width:400px"></body>`);

test("agent browser: main and subagent with identity, name and workspace in the list; watching and intervening per browser; the view follows the new tab; a restart keeps the profile; dead port files stay untouched", { skip: !CHROMIUM ? "Chromium missing" : false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-agent-choice-"));
  const dataRoot = path.join(root, "data-root");
  const wsPath = path.join(root, "workspace");
  fs.mkdirSync(wsPath);
  // Environment as in web/test/streams/server.mjs: empty HOME (no developer account, no ~/.claude), no keychain, npx as a
  // no-op (no Playwright warm-up from the registry), no token.
  const prior = Object.fromEntries(["CBASE_RESTART_GRACE_MS", "HOME", "PATH", "NPX_BIN", "CLAUDE_CODE_OAUTH_TOKEN"].map((k) => [k, process.env[k]]));
  const shim = path.join(root, "shim");
  fs.mkdirSync(shim);
  for (const [name, body] of [["security", "exit 1"], ["npx", "exit 0"]]) {
    fs.writeFileSync(path.join(shim, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(shim, name), 0o755);
  }
  fs.mkdirSync(path.join(root, "home"));
  process.env.HOME = path.join(root, "home");
  process.env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
  process.env.NPX_BIN = path.join(shim, "npx");
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
  // Load only now: modules that compute their paths from HOME at import see the empty one.
  const { startServer } = await import("../electron/server/server.js");
  const store = await import("../electron/server/store.js");
  const port = await freePort();
  const server = await startServer({ port, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
  const base = `http://127.0.0.1:${port}`;
  const json = async (u, o = {}) => (await fetch(base + u, { headers: { "Content-Type": "application/json", Connection: "close" }, ...o })).json();
  const list = async (q = "") => (await json(`/api/browsers${q}`)).browsers;
  const chromiums = [];
  const lines = [];
  const viewerAll = [];
  const counter = [];
  try {
    const ws = await json("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Agent choice", path: wsPath }) });
    const chat = await json("/api/chats", { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
    await json(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Explore projects" }) });
    // The subagent as the core stores it (runs/agents.js → store.rememberSubagent): the description is its name.
    store.rememberSubagent(chat.id, { agentId: "sub1", name: "", description: "Check login", state: "running", provider: "claude", model: "" });

    const profile = path.join(dataRoot, "data", "playwright-profiles");
    const profileMain = `chat-${chat.id}`;
    const profileSub = `chat-${chat.id}-agent-sub1`;
    const main = startAgentsChromium(path.join(profile, profileMain), PAGE("Main agent"));
    const sub = startAgentsChromium(path.join(profile, profileSub), PAGE("Subagent"));
    chromiums.push(main.proc, sub.proc);
    const lineMain = await agentsLine(await main.wsUrl);
    const lineSub = await agentsLine(await sub.wsUrl);
    lines.push(lineMain, lineSub);

    // ── (1) List: identity, name, workspace ──
    const both = await waitForTruthy("both agent browsers in the list", async () => {
      const l = (await list()).filter((b) => b.kind === "agent");
      const h = l.find((b) => b.scopeKey.split(":")[1] === profileMain);
      const s = l.find((b) => b.scopeKey.split(":")[1] === profileSub);
      return h && s ? { h, s } : null;
    });
    assert.equal(both.h.profile, profileMain, `profile missing on the main agent browser: ${JSON.stringify(both.h)}`);
    assert.equal(both.s.profile, profileSub, "profile on the subagent browser");
    assert.deepEqual([both.h.chatId, both.h.agentId], [chat.id, ""], "main agent: chat and no agent");
    assert.deepEqual([both.s.chatId, both.s.agentId], [chat.id, "sub1"], "subagent: chat and its agentId");
    assert.equal(both.h.label, "Explore projects", "main agent under the chat title");
    assert.equal(both.s.label, "Check login", `subagent under its description, not the folder name — measured "${both.s.label}"`);
    assert.equal(both.s.workspaceId, ws.id, `the subagent browser carries its chat's workspace — measured "${both.s.workspaceId}"`);
    const filtered = (await list(`?workspaceId=${ws.id}`)).map((b) => b.profile || b.scopeKey);
    assert.ok(filtered.includes(profileMain) && filtered.includes(profileSub), `the workspace list carries both: ${JSON.stringify(filtered)}`);

    // ── (2) Watch and intervene per browser ──
    for (const [b, line, text] of [[both.h, lineMain, "hello-main"], [both.s, lineSub, "hello-sub"]]) {
      const z = viewer(base, b.id);
      viewerAll.push(z);
      await waitForTruthy(`hello and frame of ${b.profile}`, () => z.hello() && z.frame());
      assert.equal(z.frame().tab, z.hello().tab, "the frame belongs to the hello tab");
      assert.ok(z.frame().data.length > 100, "the frame carries an image");
      const tab = z.hello().tab;
      // Click into the field (the agent reads the coordinates from ITS page), then text — both via the route.
      const r = JSON.parse(await line.evaluate(tab, "JSON.stringify(document.getElementById('u').getBoundingClientRect())"));
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      await line.evaluate(tab, "document.activeElement && document.activeElement.blur(), true");
      const response = await json(`/api/browsers/${b.id}/input`, { method: "POST", body: JSON.stringify({ tab: "", events: [
        { t: "mouse", type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
        { t: "mouse", type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
        { t: "text", text },
      ] }) });
      assert.deepEqual(response, { ok: true });
      const value = await waitForTruthy(`text in the field of ${b.profile}`, async () => (await line.evaluate(tab, "document.getElementById('u').value")) || null);
      assert.equal(value, text, "the input lands in THIS agent's browser");
    }

    // ── (3) The agent opens a tab and works there ──
    const running = viewerAll[0];
    const firstTab = running.hello().tab;
    // We wait for what would happen just the same WITHOUT the repair (the tab is in the list, the tabs event names it, the
    // text is in ANY field) — the check comes afterwards. So a fault is red, not a hang. The tab is registered and becomes
    // the agent's tab in the same event in which it enters the list (wireTargets).
    const activePrior = (await list()).find((b) => b.id === both.h.id).activeAt;
    const { targetId: newTab } = await lineMain.send("Target.createTarget", { url: PAGE("Second tab") });
    const after = await waitForTruthy("the new tab is in the list", async () => {
      const h = (await list()).find((b) => b.id === both.h.id);
      return h?.tabs === 2 ? h : null;
    });
    assert.equal(after.agentTab, newTab, `the agent's tab is the new one, not the first (${firstTab}) — measured "${after.agentTab}"`);
    assert.ok(after.activeAt > 0 && after.activeAt >= activePrior, "activeAt is stamped with the new tab");
    const tabsEvent = await waitForTruthy("a tabs event with the new tab", () =>
      running.events.find((e) => e.kind === "tabs" && e.data.tabs.some((x) => x.id === newTab))?.data);
    assert.equal(tabsEvent.agentTab, newTab, "the running viewer learns the agent's tab");
    assert.deepEqual(tabsEvent.tabs.map((x) => [x.id, Boolean(x.agent)]), [[firstTab, false], [newTab, true]], "exactly the new tab carries the mark");
    const fresh = viewer(base, both.h.id);
    viewerAll.push(fresh);
    await waitForTruthy("hello of the new viewer", () => fresh.hello());
    assert.equal(fresh.hello().tab, newTab, `a viewer without a tab choice attaches to the agent's tab, not the first (${firstTab})`);
    assert.equal(fresh.hello().agentTab, newTab, "hello names the agent's tab");
    // We wait for the FOCUS in the field, not just for the field: `autofocus` only takes effect in a later task than parsing.
    // If the text input came in between, it fell into the void — no field carried text, and the wait below hung forever
    // (reproduced under 12 CPU burners 1 in 10, both fields empty during the hang, the new tab's field focused afterwards).
    await waitForTruthy("the new tab has its field in focus", async () => (await lineMain.evaluate(newTab, "document.activeElement === document.getElementById('u')")) === true);
    await lineMain.evaluate(firstTab, "document.getElementById('u').value = '', true");
    await json(`/api/browsers/${both.h.id}/input`, { method: "POST", body: JSON.stringify({ events: [{ t: "text", text: "in-second-tab" }] }) });
    const fields = await waitForTruthy("the text is in one of the two fields", async () => {
      const f = { first: await lineMain.evaluate(firstTab, "document.getElementById('u').value"), fresh: await lineMain.evaluate(newTab, "document.getElementById('u').value") };
      return f.first || f.fresh ? f : null;
    });
    assert.deepEqual(fields, { first: "", fresh: "in-second-tab" }, "an input without a tab goes into the tab in which the agent works");

    // ── (4) The next run: same profile, a new Chromium ──
    const oldId = both.h.id;
    const oldPortFile = fs.readFileSync(path.join(profile, profileMain, "DevToolsActivePort"), "utf8").split("\n")[0];
    lineMain.close();
    await end(main.proc);
    await waitForTruthy("the old session is gone", async () => !(await list()).some((b) => b.id === oldId));
    assert.ok(fs.existsSync(path.join(profile, profileMain, "DevToolsActivePort")), "precondition of (5): Chromium leaves its port file behind");
    // (5a) Whoever stands on the dead port now gets no visit — measured below, after two controls.
    const atDeadPort = await knockCounter(Number(oldPortFile));
    counter.push(atDeadPort);
    // (5b) A crashed browser: lock on a dead process, port file pointing to a counter.
    const deadProcess = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => deadProcess.once("exit", r));
    const crash = await knockCounter();
    counter.push(crash);
    const crashProfile = path.join(profile, `chat-${chat.id}-agent-crashed`);
    fs.mkdirSync(crashProfile, { recursive: true });
    fs.writeFileSync(path.join(crashProfile, "DevToolsActivePort"), `${crash.port}\n/devtools/browser/x`);
    fs.symlinkSync(`${os.hostname()}-${deadProcess.pid}`, path.join(crashProfile, "SingletonLock"));
    // Two controls without a lock: each is knocked on — the second only in a pass that began after the first.
    for (const name of ["control-1", "control-2"]) {
      const k = await knockCounter();
      counter.push(k);
      const d = path.join(profile, `chat-${chat.id}-agent-${name}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "DevToolsActivePort"), `${k.port}\n/devtools/browser/x`);
      await waitForTruthy(`the scanner knocks on ${name}`, () => k.count() > 0);
    }
    assert.equal(atDeadPort.count(), 0, `the port of the finished browser was knocked on ${atDeadPort.count()}× — its port file is a corpse`);
    assert.equal(crash.count(), 0, `the port of the crashed browser (lock, process dead) was knocked on ${crash.count()}×`);
    await atDeadPort.shutdown();

    const newStart = startAgentsChromium(path.join(profile, profileMain), PAGE("Second run"));
    chromiums.push(newStart.proc);
    await newStart.wsUrl;
    const again = await waitForTruthy("same profile with a new session", async () =>
      (await list()).find((b) => b.kind === "agent" && b.profile === profileMain && b.id !== oldId) || null);
    assert.equal(again.chatId, chat.id);
    assert.equal(again.label, "Explore projects", "same name after the restart");
    t.diagnostic(`old session ${oldId.slice(0, 8)}, new ${again.id.slice(0, 8)} — profile ${profileMain}`);
  } finally {
    for (const z of viewerAll) z.shutdown();
    for (const l of lines) l.close();
    await Promise.all(chromiums.map((p) => end(p)));
    for (const z of counter) await z.shutdown().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A child process still writing (Chromium cleaning its profile) can throw ENOTEMPTY — a statement about the cleanup,
    // not about the product; it is still not kept quiet.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
