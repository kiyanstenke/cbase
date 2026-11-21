// The main agent works in the browser of its chat — against the real server (in this process), real Chromium and the real
// @playwright/mcp@0.0.84 (the same version as toolchain/playwright.js). The main agent ALWAYS works in the browser of its chat —
// the same one the human sees in the right bar. No switch, no second server.
//
// What holds here, each promise with the way that breaks it:
//   (1) The switch is gone: PUT …/browser-user answers nobody, the chat object carries no `browserUser`.
//                                                                             Counter-proof: the old route back => red.
//   (2) Only the main run gets the address — subagent, workflow and outer-loop agent keep their profile; a turn with an open
//       graph workflow, a cut-down set and a special chat neither.             Counter-proof: `role === "main"` removed => red.
//   (3) The main run carries `cdpEndpoint` = 127.0.0.1:<port of THIS chat's browser>, even if it did not run before (the turn
//       starts it), the full capabilities, no window; the system prompt carries the fixed sentence.
//                                                                             Counter-proof: do-run without `userBrowser:` => red.
//   (4) While the turn holds it, the idle deadline does not close the browser; after the turn it does again.
//                                                                             Counter-proof: `occupied` without agentChats => red.
//   (5) A real @playwright/mcp connects; if the agent opens a tab, the human's active tab stays the active one and the new one
//       is marked as the agent's; browser and tabs survive the end of the MCP.
//                                                                             Counter-proof: `s.activeTargetId = targetId` at a chat's browser => red.
//   (6) Measurement as a guard: the viewport emulation of the bar (act resize) tolerates the agent's clicks — browser_click hits
//       a button in the corner of the emulated viewport; `browser_close` closes no tab on the connected browser (0.0.84).
//   (7) If the chat's browser does not start, the turn runs in the Playwright profile, the model gets the reason as a notice and
//       the bell a message.                                                    Counter-proof: notice removed in the catch => red.
//
// Tests wait for states, never for a deadline.
// Run:  CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/agent-user-browser.test.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { _idleExpired, act, closeBrowser, getBrowser, listBrowsers, resolveChromium } from "../electron/server/browsers.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { PLAYWRIGHT_CAPABILITIES, loginStockRoot } from "../electron/server/toolchain/playwright.js";
import { CHAT_BROWSER_SENTENCE, userBrowserApplies } from "../electron/server/devtools/user-browser.js";
import * as store from "../electron/server/store.js";
import { json, makeChat, makeWorkspace, ok, waitFor, withServer } from "./server-harness.mjs";

const CHROMIUM = resolveChromium();
// The gate switches off the chats' browser for all suites (tools/check/targets/check.mjs) — this guard tests it.
process.env.CBASE_CHAT_BROWSER_OFF = "0";
// What a red test left open would otherwise keep the test process alive — red would turn into a hang.
test.after(() => { for (const b of listBrowsers()) if (b.kind === "user") closeBrowser(b.id); });
const PW_MCP = "@playwright/mcp@0.0.84";

const argValue = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
// The Playwright configuration of a turn: --mcp-config → mcpServers.playwright → --config.
function playwrightConfig(argv) {
  const mcp = JSON.parse(fs.readFileSync(argValue(argv, "--mcp-config"), "utf8"));
  const pw = mcp.mcpServers.playwright;
  assert.ok(pw, "no playwright entry in the MCP configuration of the turn");
  const file = argValue(pw.args, "--config");
  return { file, cfg: JSON.parse(fs.readFileSync(file, "utf8")), server: Object.keys(mcp.mcpServers) };
}
const chatSession = (chatId) => listBrowsers().find((b) => b.kind === "user" && b.scopeKey === `chat:${chatId}`) || null;

// The real @playwright/mcp over stdio — the way the CLI starts it (npx -y <package> --config <file>).
function startMcp(cfgFile) {
  const child = spawn(process.env.NPX_BIN || "npx", ["-y", PW_MCP, "--config", cfgFile], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let stderr = "";
  const wait = new Map();
  let nid = 1;
  let end = null;
  const ended = new Promise((r) => child.on("exit", (code, sig) => { end = `${code}/${sig}`; for (const f of wait.values()) f({ error: { message: `MCP ended ${end}: ${stderr.slice(-400)}` } }); r(end); }));
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const row = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(row); wait.get(m.id)?.(m); wait.delete(m.id); } catch { /* not a JSON line */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    if (end) return resolve({ error: { message: `MCP ended ${end}` } });
    const id = nid++;
    wait.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const tool = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(!r.error, `${name}: ${JSON.stringify(r.error)}`);
    const text = r.result?.content?.map((c) => c.text || "").join("\n") || "";
    assert.ok(!r.result?.isError && !text.startsWith("### Error"), `${name}: ${text.slice(0, 300)}`); // a tool error is no result
    return text;
  };
  return {
    async start() {
      const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cbase-test", version: "1" } });
      assert.ok(!r.error, `initialize: ${JSON.stringify(r.error)} ${stderr.slice(-400)}`);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async tools() { const r = await rpc("tools/list", {}); assert.ok(!r.error, JSON.stringify(r.error)); return (r.result?.tools || []).map((x) => x.name); },
    tool,
    // The end of a turn: the CLI closes stdin (measured: SIGTERM has the same effect).
    async end() { child.stdin.end(); return ended; },
    kill() { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
  };
}

test("(1) the switch is gone — no route, no field", async () => {
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "NB", wsPath);
    const chat = await makeChat(base, ws.id);
    assert.equal("browserUser" in chat, false, "the chat object carries no browserUser");
    const r = await json(`${base}/api/chats/${chat.id}/browser-user`, { method: "PUT", body: JSON.stringify({ on: true }) });
    assert.notEqual(r.status, 200, "PUT …/browser-user answers nobody any more");
    assert.equal("browserUser" in (await ok(`${base}/api/chats/${chat.id}`)), false, "GET /api/chats/:id carries no browserUser");
  });
});

test("(2) only the main run gets the address — subagent, workflow and outer-loop agent keep their profile", async () => {
  await withServer(async ({ base, wsPath, root }) => {
    const ws = await makeWorkspace(base, "NB", wsPath);
    const chat = await makeChat(base, ws.id);
    const address = "http://127.0.0.1:9";
    const read = (file) => JSON.parse(fs.readFileSync(argValue(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.playwright.args, "--config"), "utf8"));
    const baseValue = { chatId: chat.id, workspaceId: ws.id, userBrowser: address };
    const main = path.join(root, "main.mcp.json");
    writeMcpConfig(main, baseValue);
    const h = read(main);
    assert.equal(h.browser.cdpEndpoint, address, "main run: cdpEndpoint");
    assert.equal(h.browser.userDataDir, undefined, "main run: no profile");
    assert.equal(h.browser.launchOptions, undefined, "main run: no launchOptions");
    assert.equal(fs.existsSync(path.join(loginStockRoot(), `chat-${chat.id}`)), false, "main run: the Playwright profile is not created");
    for (const [name, extra] of [
      ["Subagent (depth)", { agentDepth: 1, profileKey: `${chat.id}-agent-a1` }],
      ["Subagent (profile)", { profileKey: `${chat.id}-agent-a2` }],
      ["Workflow agent", { workflowAgent: "wf1", agentDepth: 1, profileKey: `${chat.id}-agent-wf1` }],
      ["Outer-loop agent", { outerLoop: "ol1:run1", agentDepth: 1, profileKey: `${chat.id}-agent-ol1` }],
    ]) {
      const file = path.join(root, `${name.replace(/\W+/g, "-")}.mcp.json`);
      writeMcpConfig(file, { ...baseValue, ...extra });
      const c = read(file);
      assert.equal(c.browser.cdpEndpoint, undefined, `${name}: no address`);
      assert.match(String(c.browser.userDataDir || ""), new RegExp(`chat-${extra.profileKey}$`), `${name}: its own profile`);
    }
    // The rule at the turn (userBrowserApplies): ordinary chat, full set, no open graph workflow — without a switch.
    const c = store.getChat(chat.id);
    assert.equal(userBrowserApplies(c), true, "ordinary chat");
    assert.equal(userBrowserApplies(c, { toolset: "named" }), false, "cut-down set");
    assert.equal(userBrowserApplies({ ...c, kind: "app" }), false, "app agent chat");
    assert.equal(userBrowserApplies({ ...c, specialRole: "pipeline" }), false, "special chat");
    store.startWorkflowRun({ id: "nb-wf-run", chatId: chat.id, workflowId: "nb-wf", workflowName: "NB", workspaceId: ws.id });
    assert.equal(store.workflowOpenFor(chat.id), true, "starting point: graph workflow open");
    assert.equal(userBrowserApplies(c), false, "turn with an open graph workflow = workflow step");
    store.abandonWorkflowRuns(chat.id, "test");
  });
});

test("(3)–(6) the main agent works in the chat's browser — real @playwright/mcp, the human's selection stays, tabs survive, measurements", { skip: !CHROMIUM ? "Chromium missing" : false }, async (t) => {
  const web = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<title>CB page</title><h1>Agent in the chat browser</h1><button style="position:fixed;right:8px;bottom:8px" onclick="document.title=\'clicked\'">Click</button>');
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const page = `http://127.0.0.1:${web.address().port}/page`;
  const mcps = [];
  let sessionId = "";
  try {
    await withServer(async ({ base, wsPath, turns }) => {
      const ws = await makeWorkspace(base, "NB", wsPath);
      const chat = await makeChat(base, ws.id);
      assert.equal(chatSession(chat.id), null, "starting point: the chat's browser does not run");
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "STAY-OPEN cb" }) });
      const turn = await waitFor(async () => turns().find((x) => x.text.includes("STAY-OPEN cb")), "turn in the chat's browser");

      // (3) Configuration of the main run — the turn started the browser.
      const session = chatSession(chat.id);
      assert.ok(session, "the turn started the chat's browser");
      sessionId = session.id;
      const s = getBrowser(session.id);
      const { file, cfg, server } = playwrightConfig(turn.argv);
      assert.equal(cfg.browser.cdpEndpoint, `http://127.0.0.1:${s.debugPort}`, "cdpEndpoint = debug port of this chat's browser");
      assert.equal(cfg.browser.userDataDir, undefined, "no Playwright profile in the configuration");
      assert.equal(cfg.browser.launchOptions, undefined, "no launchOptions");
      assert.equal(cfg.browser.contextOptions, undefined, "no window — the browser's own applies");
      assert.deepEqual(cfg.capabilities, [...PLAYWRIGHT_CAPABILITIES], "the full capabilities");
      assert.deepEqual(server.filter((n) => /browser/i.test(n)), [], "no second browser server");
      assert.equal(fs.existsSync(path.join(loginStockRoot(), `chat-${chat.id}`)), false, "the Playwright profile was not created");
      assert.ok(String(argValue(turn.argv, "--append-system-prompt") || "").includes(CHAT_BROWSER_SENTENCE), "the fixed sentence is in the system prompt");

      // (4) The turn holds the browser.
      assert.equal(chatSession(chat.id).agentChat, chat.id, "GET /api/browsers names the holding chat");
      _idleExpired(session.id);
      assert.ok(getBrowser(session.id), "the idle deadline does not close a held browser");

      // (5) The real @playwright/mcp: new tab, navigate — the human's selection stays.
      const t0 = Date.now();
      const mcp1 = startMcp(file); mcps.push(mcp1);
      await mcp1.start();
      const names = await mcp1.tools();
      t.diagnostic(`MCP connected after ${Date.now() - t0} ms, ${names.length} tools`);
      assert.ok(names.some((n) => /cookie|storage/i.test(n)), `storage tools missing: ${names.join(", ")}`);
      assert.ok(names.some((n) => /mouse.*xy/i.test(n)), `vision tools missing: ${names.join(", ")}`);
      const activePrior = s.activeTargetId;
      assert.ok(activePrior, "starting point: the browser has an active tab (the human's)");
      await mcp1.tool("browser_tabs", { action: "new" });
      await mcp1.tool("browser_navigate", { url: page });
      await waitFor(async () => [...s.tabs.values()].some((x) => x.url === page), "the agent's tab is in the session");
      await s.cdp.send("Target.getTargets", {}); // barrier: events before the answer are processed
      const agentTab = [...s.tabs.values()].find((x) => x.url === page).targetId;
      assert.equal(s.activeTargetId, activePrior, "a new tab of the agent does not change the active tab (the human's selection)");
      await waitFor(async () => s.agentTab === agentTab, "the new tab is marked as the agent's");
      const prior = s.tabOrder.length;

      // (6a) Measurement: viewport emulation of the bar and a click of the agent.
      await act(s.id, { type: "reload", tab: agentTab }); // attaches the tab's CDP session (like a viewer)
      await waitFor(async () => [...s.tabs.values()].find((x) => x.targetId === agentTab)?.sessionId, "tab attached");
      assert.equal((await act(s.id, { type: "resize", width: 600, height: 420, dpr: 2 })).ok, true);
      const tab = s.tabs.get(agentTab);
      const width = await s.cdp.send("Runtime.evaluate", { expression: "innerWidth", returnByValue: true }, tab.sessionId);
      assert.equal(width.result.value, 600, "the bar's emulation applies in the agent's tab");
      const snapshot = await mcp1.tool("browser_snapshot", {});
      const ref = /button "Click" \[ref=(\w+)\]/.exec(snapshot)?.[1];
      assert.ok(ref, `no button in the snapshot: ${snapshot.slice(0, 400)}`);
      await mcp1.tool("browser_click", { element: "Click", target: ref }); // 0.0.84: `target` (up to 0.0.78 `ref`)
      const title = async () => (await s.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, tab.sessionId)).result.value;
      await waitFor(async () => (await title()) === "clicked", "the agent's click hits the button in the emulated viewport");

      await mcp1.end();
      await s.cdp.send("Target.getTargets", {});
      assert.ok(getBrowser(session.id) && s.proc.exitCode === null, "Chromium lives after the end of the MCP");
      assert.equal(s.tabOrder.length, prior, "all tabs stay");
      await waitFor(async () => {
        try { return JSON.parse(fs.readFileSync(path.join(s.profileDir, "cbase-tabs.json"), "utf8")).urls.includes(page); } catch { return false; }
      }, "cbase-tabs.json carries the agent's tab");

      // (6b) Measurement: browser_close on the connected browser.
      const mcp2 = startMcp(file); mcps.push(mcp2);
      await mcp2.start();
      const beforeClose = s.tabOrder.length;
      const response = await mcp2.tool("browser_close", {});
      await s.cdp.send("Target.getTargets", {});
      if (s.tabCreation) await s.tabCreation;
      t.diagnostic(`browser_close: ${beforeClose} tabs before, ${s.tabOrder.length} after — answer: ${response.slice(0, 160).replace(/\n/g, " ")}`);
      assert.ok(getBrowser(session.id), "the session lives after browser_close");
      // Measured on 0.0.84 (also free with three tabs): on the connected browser browser_close closes NO tab — the MCP only
      // disconnects and reports "No open tabs"; the next call reconnects and sees all of them again. If a new version changes that, this turns red.
      assert.equal(s.tabOrder.length, beforeClose, "browser_close closes no tab on the connected browser");
      await mcp2.end();

      // (4) After the turn: released, the agent's marker drops, the deadline applies again.
      await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
      await waitFor(async () => chatSession(chat.id)?.agentChat === "", "after the turn nobody holds it");
      assert.equal(s.agentTab, null, "without an agent no agent marker on the tab");
      _idleExpired(session.id);
      assert.equal(getBrowser(session.id), null, "without a turn and without a viewer the deadline closes it");
      sessionId = "";
    });
  } finally {
    for (const m of mcps) m.kill();
    if (sessionId) closeBrowser(sessionId);
    await new Promise((r) => web.close(r));
  }
});

test("(7) if the chat's browser does not start, the turn runs in the Playwright profile — notice to the model, message in the bell", async () => {
  const prior = process.env.CBASE_CHROMIUM;
  // A "Chromium" that ends at once: resolveChromium takes the file (it exists), launchUserBrowser sees the exit.
  process.env.CBASE_CHROMIUM = "/usr/bin/false";
  try {
    await withServer(async ({ base, wsPath, turns }) => {
      const ws = await makeWorkspace(base, "NB", wsPath);
      const chat = await makeChat(base, ws.id);
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "cb failure" }) });
      const turn = await waitFor(async () => turns().find((x) => x.text.includes("cb failure")), "turn despite the failure");
      const { cfg } = playwrightConfig(turn.argv);
      assert.equal(cfg.browser.cdpEndpoint, undefined, "no address");
      assert.match(String(cfg.browser.userDataDir || ""), new RegExp(`chat-${chat.id}$`), "the chat's Playwright profile");
      assert.match(turn.text, /could not be started for this turn/, "the model learns of the fallback in the same turn");
      const events = (await ok(`${base}/api/services/events?since=0`)).events || [];
      assert.ok(events.some((e) => e.chatId === chat.id && /eigenes Profil/.test(e.title)), "the bell reports the fallback");
    });
  } finally {
    if (prior === undefined) delete process.env.CBASE_CHROMIUM; else process.env.CBASE_CHROMIUM = prior;
  }
});
