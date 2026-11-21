// "Default · <level>" on inheriting fields.
//
// An empty level stays allowed on a new coding chat and in the run settings of a graph workflow and means "the provider's
// default level", resolved in the run (`effortRunning`: default of the effective provider, clamped to the effective
// model). The UI labels it "Default · <level>" (web `effortStandardLabel`, iOS `EffortLevels.standardLabel`). The promise
// of this test: the label names EXACTLY the level the run then spawns with. Both are computed against each other: the web
// computation (lib/effort.ts, compiled here with tsc) on the data of `/api/providers` against the specification the REAL
// server hands to the connector.
//
// Plus the subagent inheritance: a subagent without its own level thinks with the level of the PARENT chat, clamped to ITS
// model (runs/agents.js, `effortDesired(provider, chat.effort)`). Implicit today; without a test it would silently vanish
// when the agent core is reworked. COUNTER-TEST: replacing the inheritance in agents.js with `effortDesired(prov, "")`
// turns the subagent test red (Sonnet high instead of xhigh, the OpenRouter model medium instead of high).
//
// The providers are the real connectors except `runChat` (remembers the specification) and `runOnce` (title), the same seam
// as effort-core.test.js; the test waits for events, not for a clock.
//
// A FRESH run chat of a graph workflow comes into being only through a trigger, here against a fake GitLab like in
// gitlab-trigger.test.js.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import http from "node:http";

import { getConnector, registerConnector } from "../electron/server/providers/index.js";
import * as store from "../electron/server/store.js";
import { buildClaudeChatArgs } from "../electron/server/providers/connectors/claude.js";
import { openRouterSpy } from "./openrouter-spy.mjs";
import { startServer } from "../electron/server/server.js";
import { waitForQuiet } from "./quiet.mjs";
// The Codex model without max is a test model with the numbers of gpt-5.5 (switched off).
import { GAP, withGapsModel } from "./gaps-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "..", "..", "web");

// The web computation as it runs in the browser: lib/effort.ts is a leaf module without imports, tsc compiles it alone.
let webModule = null;
function webEffort() {
  webModule ??= (async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-t15-web-"));
    execFileSync(process.execPath, [path.join(webDir, "node_modules", "typescript", "bin", "tsc"), path.join(webDir, "src", "lib", "effort.ts"),
      "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", out], { cwd: webDir, stdio: "pipe" });
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}');
    const m = await import(pathToFileURL(path.join(out, "effort.js")).href);
    fs.rmSync(out, { recursive: true, force: true });
    return m;
  })();
  return webModule;
}
// The UI translator: only substitutes the placeholders.
const t = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

const wait = async (fn) => {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
};

// A model WITHOUT xhigh: every Claude/Codex catalog model carries xhigh except Haiku, which carries no levels at all. So an
// OpenRouter spy (openrouter-spy.mjs) with a model entry that sets the levels EXPLICITLY to low/medium/high. Faked as a
// subagent host with its own loop so that its run ends here instead of asking an endpoint.
const PRESET = "openrouter";

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-t15-"));
  const prior = { claude: process.env.CLAUDE_BIN, codex: process.env.CODEX_BIN, poll: process.env.CBASE_TRIGGER_POLL, grace: process.env.CBASE_RESTART_GRACE_MS, browser: process.env.CBASE_CHAT_BROWSER_OFF };
  const real = { claude: getConnector("claude"), codex: getConnector("codex"), openrouter: getConnector("openrouter") };
  const specs = [];
  const open = new Set();
  let server;
  let base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  // Set once the body is through: a main run that starts AFTER that ends at once. The finally finishes the runs open at
  // that moment — but finishing one can start a follow-up turn of the same chat (queued subagent reports: the main agent
  // does not wait for them, providers/agent-wait.js, unless CBASE_MAIN_AGENT_WAIT_MS is set as in the gate), and nobody
  // would finish that one: the quiet wait below hung without a deadline (the whole file, for hours).
  let closing = false;
  const fakeRunChat = (id) => ({ spec, onEvent, onSpawn }) => new Promise((resolve) => {
    const finished = () => {
      open.delete(finished);
      onEvent({ type: "result", result: "ok", session_id: `s-${id}` });
      resolve({ code: 0, sessionId: `s-${id}`, resultText: "ok", stderr: "" });
    };
    specs.push({ provider: id, sub: Number(spec.agentDepth) > 0, model: spec.model, effort: spec.effort, spec, finished });
    onSpawn?.({ pid: 0, kill() {}, cbaseInject: () => false, cbaseEndInput: () => {} });
    onEvent({ type: "system", subtype: "init", session_id: `s-${id}` });
    if (Number(spec.agentDepth) > 0 || closing) finished(); else open.add(finished);
  });
  try {
    // No child should ever start; if one does, it should fail at once instead of hitting a real CLI.
    process.env.CLAUDE_BIN = path.join(root, "claude-exists-not");
    process.env.CODEX_BIN = path.join(root, "codex-exists-not");
    process.env.CBASE_TRIGGER_POLL = "0";
    // The restart is a start timer: the test switches it off instead of waiting for it.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    // No chat browser: every turn of a coding chat would start a real headless Chrome, which the server's close does not end —
    // run outside the gate (which sets the switch for every suite), the file never exited after its last test.
    process.env.CBASE_CHAT_BROWSER_OFF = "1";
    for (const id of ["claude", "codex"]) registerConnector({ ...real[id], runOnce: async () => "Title", runChat: fakeRunChat(id) });
    const preset = openRouterSpy({ models: [{ id: "m1", label: "M1", efforts: ["low", "medium", "high"] }] });
    registerConnector({ ...preset, caps: { ...preset.caps, ownsAgentLoop: true }, runOnce: async () => "Title", runChat: fakeRunChat(PRESET) });
    const wsPath = path.join(root, "ws");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const api = async (p, method = "GET", body) => {
      const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ws = (await api("/api/workspaces", "POST", { name: "Default level", path: wsPath })).body;
    // The main run of a chat: its specification is recognised by the MCP configuration `<chatId>.mcp.json`.
    const runOf = (chatId) => wait(() => specs.find((s) => !s.sub && path.basename(String(s.spec.mcpConfigPath || "")) === `${chatId}.mcp.json`));
    // Quiet instead of an own idle copy (busy/runs): hooks, oneshots and follow-up runs are through as well.
    const idle = () => waitForQuiet(base);
    await fn({ api, ws, specs, runOf, idle });
    finished = true;
  } finally {
    closing = true;
    for (const f of [...open]) f();
    // Wait for quiet only when the body passed (template: agent-harness.mjs); after a failure a hanging run would
    // stand without a deadline.
    if (base && finished) await waitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    registerConnector(real.claude);
    registerConnector(real.codex);
    registerConnector(real.openrouter);
    for (const [k, v] of [["CLAUDE_BIN", prior.claude], ["CODEX_BIN", prior.codex], ["CBASE_TRIGGER_POLL", prior.poll], ["CBASE_RESTART_GRACE_MS", prior.grace], ["CBASE_CHAT_BROWSER_OFF", prior.browser]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// A fake GitLab (no network, no token): account, one project, its merge requests; enough for a trigger "mr_opened".
async function withGitlab(fn) {
  const mrs = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gitlab.test");
    const reply = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["private-token"] !== "glpat-test") return reply(401, { message: "401 Unauthorized" });
    if (url.pathname === "/api/v4/user") return reply(200, { id: 7, username: "maintainer", name: "Maintainer", web_url: "http://gitlab.test/maintainer" });
    if (url.pathname === "/api/v4/projects") return reply(200, [{ id: 42, path_with_namespace: "group/project", name: "Project", web_url: "http://gitlab.test/group/project" }]);
    if (url.pathname === "/api/v4/projects/42/merge_requests") {
      const fromIdx = Date.parse(url.searchParams.get("created_after") || "") || -Infinity;
      return reply(200, mrs.filter((r) => Date.parse(r.created_at) >= fromIdx));
    }
    if (url.pathname === "/api/v4/projects/42/issues" || url.pathname === "/api/v4/projects/42/events") return reply(200, []);
    return reply(404, { message: "404 Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn({ glBase: `http://127.0.0.1:${server.address().port}`, mrs });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}
// A fresh run chat: the workflow gets a trigger node before its step, is armed, and a new MR fires ONCE (trigger-test
// with fire). Returns the id of the chat the trigger created.
async function freshRunChat(api, ws, flowId, step, run) {
  let chatId = "";
  await withGitlab(async ({ glBase, mrs }) => {
    const acc = await api("/api/gitlab/accounts", "POST", { label: "Fake-GitLab", host: glBase, token: "glpat-test" });
    assert.equal(acc.status < 300, true, JSON.stringify(acc.body));
    const graph = {
      nodes: [
        { id: "t1", type: "trigger", title: "New MRs", x: 40, y: 40,
          trigger: { source: "gitlab", accountId: acc.body.id, scope: "project", projectId: "42", projectPath: "group/project", events: ["mr_opened"], intervalSec: 30 } },
        { ...step, x: 320, y: 40 },
      ],
      edges: [{ from: "t1", to: step.id }],
    };
    assert.equal((await api(`/api/workspaces/${ws.id}/workflows/${flowId}`, "PUT", { graph, run, lock: { scope: "off" } })).status, 200);
    assert.equal((await api(`/api/workspaces/${ws.id}/workflows/${flowId}`, "PUT", { active: true })).body?.active, true);
    const iid = mrs.length + 1;
    // STRICTLY after the armed waterline: arming sets `since` to the server's NOW, and the trigger takes only events after
    // it (`gitlab.js:pollTrigger`, `e.at > line`). A `new Date()` taken here can fall into the SAME millisecond — since the
    // store commits without waiting for fsync (WAL, synchronous=NORMAL) the arming PUT answers within it — and the MR then
    // counts as "before arming" (fired 0). The line is read, not waited out.
    const armed = store.getTriggerState(flowId, "t1")?.since;
    assert.ok(Number.isFinite(armed), "arming left no waterline");
    const at = new Date(Math.max(Date.now(), armed + 1)).toISOString();
    mrs.push({ id: 1000 + iid, iid, project_id: 42, title: `Run ${iid}`, state: "opened", created_at: at, updated_at: at,
      web_url: `http://gitlab.test/group/project/-/merge_requests/${iid}`, source_branch: "x", target_branch: "main", labels: [],
      description: "", author: { id: 9, username: "colleague" }, references: { full: `group/project!${iid}` } });
    const prior = new Set(store.listChats(ws.id, { archive: "including" }).map((c) => c.id));
    const fired = await api(`/api/workspaces/${ws.id}/workflows/${flowId}/trigger-test`, "POST", { fire: true });
    assert.equal(fired.body?.fired, 1, JSON.stringify(fired.body));
    chatId = store.listChats(ws.id, { archive: "including" }).find((c) => !prior.has(c.id))?.id || "";
    assert.ok(chatId, "the trigger created no chat");
    // Disarmed again: a second case of the same test creates its own account.
    await api(`/api/workspaces/${ws.id}/workflows/${flowId}`, "PUT", { active: false });
  });
  return chatId;
}

// What the UI shows on the empty entry, with the data it has itself (`/api/providers`: catalog + active).
async function display(api, provider, model) {
  const web = await webEffort();
  const { active, providers } = (await api("/api/providers")).body;
  return { level: web.effortDefaultLevel(provider, model, providers, active), label: web.effortStandardLabel(provider, model, providers, t, active) };
}

// The new coding chat carries the inheriting field: creating without a level gives no 400, and the first turn spawns
// with the displayed level.
test("new coding chat without a level: creating gives no 400 and the first turn spawns with the displayed level", async () => {
  await withGapsModel(() => withServer(async ({ api, ws, specs, runOf, idle }) => {
    // The Codex default on max: on a model without max (test model) the display must name the CLAMP, not the default.
    assert.equal((await api("/api/default-effort", "PUT", { provider: "codex", effort: "max" })).status, 200);
    const cases = [
      // "Default (global)": no provider, no model => the globally active provider and its default model. The default
      // model is Sonnet 5.5 (catalog level medium); without a stored default level the fallback level High applies on
      // this fallback model (DEFAULT_EFFORT_FALLBACK).
      { name: "global", fresh: { provider: "", model: "" }, expected: "Default · High" },
      { name: "without-max", fresh: { provider: "codex", model: GAP }, expected: "Default · X-High" },
      { name: "haiku", fresh: { provider: "claude", model: "claude-haiku-4-5-20251001" }, expected: "Default" },
    ];
    for (const f of cases) {
      const { level, label } = await display(api, f.fresh.provider, f.fresh.model);
      assert.equal(label, f.expected, `${f.name}: display`);
      specs.length = 0;
      const body = { workspaceId: ws.id, permissionMode: "bypassPermissions", ...(f.fresh.provider ? { provider: f.fresh.provider, model: f.fresh.model } : {}) };
      const created = await api("/api/chats", "POST", body);
      assert.equal(created.status < 300, true, `${f.name}: creating without a level => ${created.status} ${JSON.stringify(created.body)}`);
      const chatId = created.body.id;
      assert.ok((await api(`/api/chats/${chatId}/message`, "POST", { text: "go" })).status < 300);
      const run = await runOf(chatId);
      assert.equal(run.effort, level, `${f.name}: displayed "${label}", spawned with "${run.effort}"`);
      if (run.provider === "claude") {
        const args = buildClaudeChatArgs(run.spec);
        assert.equal(args.includes("--effort") ? args[args.indexOf("--effort") + 1] : "", level, `${f.name}: --effort on the wire`);
      }
      run.finished();
      await idle();
    }
  }));
});

test("graph workflow with an empty run level: saving gives no 400 and the step spawns with the displayed level", async () => {
  await withGapsModel(() => withServer(async ({ api, ws, runOf, idle }) => {
    assert.equal((await api("/api/default-effort", "PUT", { provider: "codex", effort: "max" })).status, 200);
    const graph = {
      nodes: [{ id: "s0", type: "start", title: "Start", x: 40, y: 40 }, { id: "n1", type: "instruction", title: "Do", text: "Do something", x: 300, y: 40 }],
      edges: [{ from: "s0", to: "n1" }],
    };
    const cases = [
      { name: "global", run: { provider: "", model: "", effort: "" }, expected: "Default · High" }, // fallback level, see above
      { name: "without-max", run: { provider: "codex", model: GAP, effort: "" }, expected: "Default · X-High" },
    ];
    for (const f of cases) {
      const flow = (await api(`/api/workspaces/${ws.id}/workflows`, "POST", { name: `Run ${f.name}` })).body;
      // First a level, then back to empty, both without a 400.
      assert.equal((await api(`/api/workspaces/${ws.id}/workflows/${flow.id}`, "PUT", { graph, run: { doneAll: false, ...f.run, effort: "low" } })).status, 200);
      const put = await api(`/api/workspaces/${ws.id}/workflows/${flow.id}`, "PUT", { run: { effort: "" } });
      assert.equal(put.status, 200, `${f.name}: empty run level => ${put.status} ${JSON.stringify(put.body)}`);
      assert.equal(put.body.run.effort, "");
      const { level, label } = await display(api, f.run.provider, f.run.model);
      assert.equal(label, f.expected, `${f.name}: display`);
      // Started in a FRESH chat by a trigger: the run settings are all the chat carries there.
      const runChat = await freshRunChat(api, ws, flow.id, graph.nodes[1], { doneAll: false, ...f.run, effort: "" });
      const run = await runOf(runChat);
      assert.equal(run.effort, level, `${f.name}: displayed "${label}", the step spawns with "${run.effort}"`);
      run.finished();
      await idle();
    }
  }));
});

// The level of the CHAT applies: an empty run level transfers NOTHING (`chatFieldsFromRun` only set fields). A manual
// start in an existing chat thinks with that chat's level, only a freshly created run chat gets the default level. The
// label says both ("As the chat · new: <level>", the `asChat` variant of `effortStandardLabel`), and the named level is
// that of the fresh chat. COUNTER-TEST: `chatFieldsFromRun` transferring an empty level as the default level turns the
// manual-start part red.
test("empty run level: a manual start in an existing chat keeps its level, a fresh run chat gets the default level", async () => {
  await withServer(async ({ api, ws, runOf, idle }) => {
    const graph = {
      nodes: [{ id: "s0", type: "start", title: "Start", x: 40, y: 40 }, { id: "n1", type: "instruction", title: "Do", text: "Do something", x: 300, y: 40 }],
      edges: [{ from: "s0", to: "n1" }],
    };
    const flow = (await api(`/api/workspaces/${ws.id}/workflows`, "POST", { name: "Run F12" })).body;
    assert.equal((await api(`/api/workspaces/${ws.id}/workflows/${flow.id}`, "PUT", { graph, run: { doneAll: false, provider: "", model: "", effort: "" } })).status, 200);
    const web = await webEffort();
    const { active, providers } = (await api("/api/providers")).body;
    const standard = web.effortDefaultLevel("", "", providers, active);
    assert.ok(standard && standard !== "low", `the probe needs a default level other than "low" (is "${standard}")`);
    assert.equal(web.effortStandardLabel("", "", providers, t, active, true), `As the chat · new: ${web.EFFORT_LABEL[standard]}`, "the label of the run level");

    // 1) Manual start in the existing chat (level low): the step thinks with low, and the chat keeps it.
    const chat = (await api("/api/chats", "POST", { workspaceId: ws.id, provider: "claude", model: "claude-sonnet-5", effort: "low", permissionMode: "bypassPermissions" })).body;
    assert.equal(chat.effort, "low");
    const start = await api(`/api/chats/${chat.id}/workflow`, "POST", { workflowId: flow.id, input: "go" });
    assert.ok(start.status < 300, `Handstart rejected (${start.status} ${JSON.stringify(start.body)})`);
    const hand = await runOf(chat.id);
    assert.equal(hand.effort, "low", "manual start: the chat's level, not the default level");
    hand.finished();
    await idle();
    assert.equal((await api(`/api/chats/${chat.id}`)).body.effort, "low", "the chat keeps its level");

    // 2) Fresh run chat (from a trigger): the default level, exactly the one the label names.
    const fresh = await runOf(await freshRunChat(api, ws, flow.id, graph.nodes[1], { doneAll: false, provider: "", model: "", effort: "" }));
    assert.equal(fresh.effort, standard, "fresh run chat: the default level");
    fresh.finished();
    await idle();
  });
});

test("a subagent without its own level inherits the parent chat's, clamped to ITS model", async () => {
  await withServer(async ({ api, ws, specs }) => {
    assert.deepEqual(getConnector(PRESET).efforts("m1"), ["low", "medium", "high"], "precondition: a model without xhigh");
    const c = (await api("/api/chats", "POST", { workspaceId: ws.id, provider: "claude", model: "claude-opus-5-5", effort: "xhigh", permissionMode: "bypassPermissions" })).body;
    assert.equal(c.effort, "xhigh");
    specs.length = 0;
    assert.ok((await api(`/api/chats/${c.id}/message`, "POST", { text: "go" })).status < 300);
    const main = await wait(() => specs.find((s) => !s.sub));
    assert.equal(main.effort, "xhigh");
    const kind = async (model) => {
      const prior = specs.filter((s) => s.sub).length;
      const r = await api(`/api/chats/${c.id}/agent`, "POST", { prompt: "Check something.", description: "Help", model, callId: "toolu_default_level", run_in_background: false });
      assert.ok(r.status < 300, `${model}: subagent not started (${r.status} ${JSON.stringify(r.body)})`);
      return wait(() => specs.filter((s) => s.sub)[prior]);
    };
    // A model that carries xhigh: the inheritance unchanged (without it: the Claude default high).
    const sonnet = await kind("claude::claude-sonnet-5");
    assert.deepEqual([sonnet.model, sonnet.effort], ["claude-sonnet-5", "xhigh"]);
    const a = buildClaudeChatArgs(sonnet.spec);
    assert.equal(a[a.indexOf("--effort") + 1], "xhigh", "--effort xhigh on the wire");
    // Haiku carries no levels: no level, no --effort.
    const haiku = await kind("claude::claude-haiku-4-5-20251001");
    assert.deepEqual([haiku.model, haiku.effort], ["claude-haiku-4-5-20251001", ""]);
    assert.ok(!buildClaudeChatArgs(haiku.spec).includes("--effort"), "Haiku spawns without --effort");
    // A model without xhigh: the substitute downwards (high), not the default of its provider (medium).
    const withoutXhigh = await kind(`${PRESET}::m1`);
    assert.deepEqual([withoutXhigh.provider, withoutXhigh.model, withoutXhigh.effort], [PRESET, "m1", "high"]);
    main.finished();
  });
});
