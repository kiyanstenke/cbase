// The level for oneshots and app agents.
//
// Before, NO oneshot got a level: verdicts, completion gate, categorization, extraction, compaction, adjust and the special chats
// thought with whatever happened to be in the CLI's configuration file. Now:
//   - every app-agent key carries, in ITS settings row (`agent_model_<key>`), a level next to the model ("" = the provider's
//     default level);
//   - `runOnce` resolves it like every run (`effortRunning`: empty => default => clamp to the model) and passes it to all three
//     paths: Claude as `--effort`, Codex as `-c model_reasoning_effort=...`, OpenRouter as `reasoning_effort`;
//   - the level travels as RUN DESCRIPTION (`agentRunFor` -> {model, effort}) through the seven wrappers in claude.js, never in
//     the model reference.
//
// The spawn tests hit REAL child processes (fake binaries under CLAUDE_BIN/CODEX_BIN that write their argv): a spy on the
// connector would only prove that `runOnce` passes something on, not that it arrives on the wire.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultModelFor, effortStandard, getConnector, registerConnector, runOnce } from "../electron/server/providers/index.js";
import { CODEX_WITHOUT_DELEGATION } from "../electron/server/providers/connectors/codex.js";
import { replaceOpenRouter } from "./openrouter-spy.mjs";
import {
  classifyContext, classifyProjectDump, compactConversation, curateContext, mergeProjectContext, routeDumpToProject, scanServices,
} from "../electron/server/claude.js";
import { startServer } from "../electron/server/server.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
// The Codex model without max is a test model with the numbers of gpt-5.5 (switched off).
import { GAP, withGapsModel } from "./gaps-model.mjs";
import { readJsonl } from "./jsonl.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, "..", "electron", "server");

// A spy in place of `runOnce` of the two native connectors; the rest stays real (catalog, clamp).
async function withSpy(fn) {
  const real = { claude: getConnector("claude"), codex: getConnector("codex") };
  const calls = [];
  try {
    for (const id of ["claude", "codex"]) {
      registerConnector({ ...real[id], runOnce: async (prompt, opts) => { calls.push({ id, prompt, ...opts }); return "{}"; } });
    }
    await fn(calls);
  } finally {
    registerConnector(real.claude);
    registerConnector(real.codex);
  }
}

test("runOnce passes the level RESOLVED and CLAMPED to the connector: set, default, no levels, substitute", async () => {
  await withSpy(async (calls) => {
    const fall = async (opts) => { calls.length = 0; await runOnce("p", opts); assert.equal(calls.length, 1); return calls[0]; };
    assert.equal((await fall({ provider: "claude", model: "claude-sonnet-5", effort: "low" })).effort, "low", "set and carried");
    assert.equal((await fall({ provider: "claude", model: "claude-sonnet-5", effort: "" })).effort, effortStandard("claude"),
      "empty => the default level of the provider");
    assert.equal((await fall({ provider: "claude", model: "claude-sonnet-5" })).effort, effortStandard("claude"),
      "without a value => the default as well; no oneshot thinks with the CLI configuration file any more");
    assert.equal((await fall({ provider: "claude", model: "claude-haiku-4-5-20251001", effort: "max" })).effort, "",
      "Haiku 4.5 carries no levels => none at all");
    assert.equal((await fall({ provider: "claude", model: "claude-haiku-4-5-20251001" })).effort, "",
      "not even the default: title, target and verdicts stay without the flag out of the box");
    await withGapsModel(async () => {
      assert.equal((await fall({ provider: "codex", model: GAP, effort: "max" })).effort, "xhigh", "a model without max => the substitute downwards");
      const ref = await fall({ model: `codex::${GAP}`, effort: "max" });
      assert.equal(ref.id, "codex", "the provider in the model reference wins");
      assert.equal(ref.effort, "xhigh", "and the clamp applies to ITS model");
    });
  });
});

// ── The three paths on the wire ─────────────────────────────────────────────────────────────────────────────
function fakeBins(root) {
  const log = path.join(root, "argv.jsonl");
  const claude = path.join(root, "claude-fake");
  fs.writeFileSync(claude, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "claude", argv: process.argv.slice(2) }) + "\\n");
process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ type: "result", result: "ok" })); });
`, { mode: 0o755 });
  const codex = path.join(root, "codex-fake");
  fs.writeFileSync(codex, `#!/usr/bin/env node
const a = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "codex", argv: a }) + "\\n");
const i = a.indexOf("-o"); if (i >= 0) require("fs").writeFileSync(a[i + 1], "ok");
`, { mode: 0o755 });
  // The fakes (child processes) write argv.jsonl; only completed lines are read (jsonl.mjs).
  return { log, claude, codex, rows: () => readJsonl(log) };
}
async function withBins(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-oneshot-level-"));
  const prior = { claude: process.env.CLAUDE_BIN, codex: process.env.CODEX_BIN };
  const b = fakeBins(root);
  try {
    process.env.CLAUDE_BIN = b.claude;
    process.env.CODEX_BIN = b.codex;
    await fn(b, root);
  } finally {
    for (const [k, v] of [["CLAUDE_BIN", prior.claude], ["CODEX_BIN", prior.codex]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.warn("[test] cleanup:", e?.message || e); }
  }
}
const flagValue = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

test("Claude oneshot spawns with a clamped --effort; without a level (Haiku) without the flag, sandboxed stays sandboxed", async () => {
  await withBins(async (b, root) => {
    assert.equal(await runOnce("p", { provider: "claude", model: "claude-sonnet-5", effort: "xhigh", cwd: root }), "ok");
    await runOnce("p", { provider: "claude", model: "claude-haiku-4-5-20251001", effort: "max", cwd: root });
    await runOnce("p", { provider: "claude", model: "claude-opus-5-5", effort: "low", cwd: root, withoutTools: true });
    const [sonnet, haiku, sandboxed] = b.rows();
    assert.equal(flagValue(sonnet.argv, "--effort"), "xhigh");
    assert.equal(flagValue(sonnet.argv, "--model"), "claude-sonnet-5");
    assert.ok(!haiku.argv.includes("--effort"), `Haiku 4.5 gets no --effort: ${haiku.argv.join(" ")}`);
    assert.equal(flagValue(sandboxed.argv, "--effort"), "low");
    // Without tools still means: empty tool set, strict empty MCP configuration, lock list.
    assert.equal(flagValue(sandboxed.argv, "--tools"), "", "sandboxed: --tools \"\"");
    assert.ok(sandboxed.argv.includes("--strict-mcp-config"));
    assert.equal(flagValue(sandboxed.argv, "--mcp-config"), '{"mcpServers":{}}');
    assert.ok(sandboxed.argv.includes("--disallowedTools"));
  });
});

test("Codex oneshot spawns with the level as a configuration value, clamped to the model, delegation still off", async () => {
  await withBins(async (b, root) => {
    assert.equal(await withGapsModel(() => runOnce("p", { provider: "codex", model: GAP, effort: "max", cwd: root })), "ok");
    await runOnce("p", { provider: "codex", model: "gpt-5.6-sol", effort: "low", cwd: root });
    const [g55, sol] = b.rows();
    const cValues = (argv) => argv.flatMap((a, i) => (a === "-c" ? [argv[i + 1]] : []));
    assert.ok(cValues(g55.argv).includes('model_reasoning_effort="xhigh"'), `model without max: max => xhigh: ${g55.argv.join(" ")}`);
    assert.ok(cValues(sol.argv).includes('model_reasoning_effort="low"'), `Sol: low — ${sol.argv.join(" ")}`);
    const chain = g55.argv.join("\u0000");
    assert.ok(chain.includes(CODEX_WITHOUT_DELEGATION.join("\u0000")), "native delegation stays off");
    assert.equal(flagValue(g55.argv, "-s"), "read-only", "the oneshot stays read-only");
  });
});

test("OpenRouter oneshot sends the level in the field of its wire; all five, an entry with `efforts` clamps", async () => {
  // Only the built-in OpenRouter runs over HTTP; the spy replaces it with the same factory and the base example.test.
  const orig = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const back = replaceOpenRouter({ baseUrl: "https://example.test/v1", models: [
    { id: "z-ai/glm", label: "GLM" },
    { id: "gpt-oss", label: "OSS", efforts: ["low", "medium", "high"] },
  ] });
  try {
    await runOnce("p", { provider: "openrouter", model: "z-ai/glm", effort: "max" });
    await runOnce("p", { provider: "openrouter", model: "gpt-oss", effort: "max" });
    const [or, oss] = bodies;
    assert.equal(or.reasoning_effort, "max", "OpenRouter: max arrives as max");
    assert.equal(oss.reasoning_effort, "high", "an entry with low/medium/high: clamped to high");
  } finally {
    globalThis.fetch = orig;
    back();
  }
});

// ── The seven wrappers around runOnce ──────────────────────────────────────────────────────────────────────
// Six of them run sandboxed (runs/sandboxing.js, without a `cwd` parameter); `sandboxed()` needs DIRS set, so without a server
// an empty folder of our own (afterwards the previous state). The sandboxing itself is held by oneshot-sandboxing.test.js.
test("Each of the seven wrappers in claude.js passes `effort` on to runOnce", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-oneshot-wrapper-"));
  const dirsPrior = DIRS;
  try {
    fs.mkdirSync(path.join(root, "empty"));
    setDirs({ ...(dirsPrior || {}), empty: path.join(root, "empty") });
    await withSpy(async (calls) => {
      const run = { model: "claude::claude-sonnet-5", effort: "low" };
      const cases = {
        compactConversation: () => compactConversation({ transcript: "User: a\nAssistant: b", ...run }),
        classifyContext: () => classifyContext("A snippet", ["notes"], run),
        classifyProjectDump: () => classifyProjectDump({ text: "Dump", categories: [{ slug: "a", label: "A" }], ...run }),
        mergeProjectContext: () => mergeProjectContext({ existing: { title: "T", body: "B" }, incomingText: "fresh", categories: [{ slug: "a", label: "A" }], ...run }),
        routeDumpToProject: () => routeDumpToProject({ text: "Dump", projects: [{ id: "p1", name: "P1", path: root }], ...run }),
        scanServices: () => scanServices({ cwd: root, ...run }),
        curateContext: () => curateContext({ userText: "u", assistantText: "a", existing: [], categories: [{ slug: "a", label: "A" }], ...run }),
      };
      for (const [name, calls2] of Object.entries(cases)) {
        calls.length = 0;
        await calls2().catch(() => {});
        assert.ok(calls.length >= 1, `${name}: no call of runOnce`);
        for (const a of calls) assert.equal(a.effort, "low", `${name}: the level did not arrive`);
      }
    });
  } finally {
    setDirs(dirsPrior);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Whoever reads an app-agent model reads the level too: outside agent-models.js `agentModelFor` appears only at named
// places that start no oneshot. Every other place takes `agentRunFor` (model AND level).
const MODEL_WITHOUT_LEVEL_ALLOWED = {
  "settings/routes.js": "GET /api/agent-models: the effective model for DISPLAY (choice and \"Default · <level>\")",
  "workflows/driver.js": "verdictOneshot/doneJudgeModel: the verdict model; verdictOneshot sets the level from agentRunFor(\"workflow\")",
};
test("Source text: no oneshot reads an app-agent model without its level", () => {
  const findings = {};
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") run(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      const rel = path.relative(SERVER_DIR, p).split(path.sep).join("/");
      if (rel === "settings/agent-models.js") continue;
      if (/\bagentModelFor\(/.test(fs.readFileSync(p, "latin1"))) findings[rel] = true;
    }
  };
  run(SERVER_DIR);
  const unknown = Object.keys(findings).filter((f) => !MODEL_WITHOUT_LEVEL_ALLOWED[f]);
  assert.deepEqual(unknown, [], `agentModelFor without a level at: ${unknown.join(", ")}; use agentRunFor(...) there`);
  const orphaned = Object.keys(MODEL_WITHOUT_LEVEL_ALLOWED).filter((f) => !findings[f]);
  assert.deepEqual(orphaned, [], `exception without a match: ${orphaned.join(", ")}; remove the entry`);
  // The verdict really carries the level of the app agent "workflow" (not only the model).
  const driver = fs.readFileSync(path.join(SERVER_DIR, "workflows", "driver.js"), "utf8");
  assert.match(driver, /runOnce\(prompt, \{[^}]*effort: agentRunFor\("workflow"\)\.effort/, "verdictOneshot passes the level of the app agent \"workflow\"");
});

// ── Setting, route, special chats ────────────────────────────────────────────────────────────────────
async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-oneshot-server-"));
  const prior = { claude: process.env.CLAUDE_BIN, codex: process.env.CODEX_BIN, poll: process.env.CBASE_TRIGGER_POLL };
  let server;
  try {
    process.env.CLAUDE_BIN = path.join(root, "claude-exists-not");
    process.env.CODEX_BIN = path.join(root, "codex-exists-not");
    process.env.CBASE_TRIGGER_POLL = "0";
    fs.mkdirSync(path.join(root, "ws"));
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (p, method = "GET", body) => {
      const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ws = (await api("/api/workspaces", "POST", { name: "Oneshot-level", path: path.join(root, "ws") })).body;
    await fn({ api, ws });
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of [["CLAUDE_BIN", prior.claude], ["CODEX_BIN", prior.codex], ["CBASE_TRIGGER_POLL", prior.poll]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.warn("[test] cleanup:", e?.message || e); }
  }
}

test("PUT /api/agent-models: level in the same row, each half only when stated, unknown 400", async () => {
  await withServer(async ({ api }) => {
    let r = await api("/api/agent-models", "PUT", { key: "adjust", effort: "high" });
    assert.equal(r.status, 200);
    assert.equal(r.body.effort, "high", "a level alone (model Auto) is a choice");
    assert.equal(r.body.value, null, "and no model");
    assert.deepEqual(JSON.parse(store.getSetting("agent_model_adjust", "")), { effort: "high" }, "the same settings row");
    r = await api("/api/agent-models", "PUT", { key: "adjust", provider: "claude", model: "claude-sonnet-5" });
    assert.equal(r.body.effort, "high", "a model change leaves the level standing");
    assert.deepEqual(r.body.value, { provider: "claude", model: "claude-sonnet-5" });
    r = await api("/api/agent-models", "PUT", { key: "adjust", effort: "" });
    assert.equal(r.body.effort, "", "\"\" means default");
    assert.deepEqual(r.body.value, { provider: "claude", model: "claude-sonnet-5" }, "and leaves the model standing");
    assert.equal((await api("/api/agent-models", "PUT", { key: "adjust", effort: "turbo" })).status, 400, "no level => 400");
    assert.equal((await api("/api/agent-models", "PUT", { key: "adjust", effort: "ultra" })).status, 400, "not the old sixth either");
    assert.equal((await api("/api/agent-models", "PUT", { key: "adjust" })).status, 400, "a body without a statement changes nothing");
    assert.deepEqual(JSON.parse(store.getSetting("agent_model_adjust", "")), { provider: "claude", model: "claude-sonnet-5" });
    const g = (await api("/api/agent-models")).body;
    assert.equal(g.efforts.adjust, "");
    assert.deepEqual(g.effective.adjust, { provider: "claude", model: "claude-sonnet-5" });
    assert.deepEqual(g.effective.title, { provider: "claude", model: "claude-haiku-4-5-20251001" }, "auto title: the fixed Haiku");
    assert.deepEqual(Object.keys(g.efforts).sort(), Object.keys(g.agents).sort(), "every key has a level entry");
  });
});

test("Adjust spawns with the level of its app agent; without a choice with the default, on Haiku without", async () => {
  await withServer(async ({ api }) => {
    await withSpy(async (calls) => {
      await api("/api/agent-models", "PUT", { key: "adjust", provider: "claude", model: "claude-sonnet-5", effort: "max" });
      assert.equal((await api("/api/adjust", "POST", { text: "Hello", prompt: "shorter" })).status, 200);
      assert.equal(calls.at(-1).effort, "max");
      await api("/api/agent-models", "PUT", { key: "adjust", effort: "" });
      await api("/api/adjust", "POST", { text: "Hello", prompt: "shorter" });
      assert.equal(calls.at(-1).effort, effortStandard("claude"), "default => the default level of the provider");
      await api("/api/agent-models", "PUT", { key: "adjust", provider: "", model: "", effort: "high" });
      await api("/api/adjust", "POST", { text: "Hello", prompt: "shorter" });
      assert.equal(calls.at(-1).model, "claude-haiku-4-5-20251001", "Auto = the fixed Haiku");
      assert.equal(calls.at(-1).effort, "", "Haiku carries no levels => none");
    });
  });
});

// `effective` is the model that RUNS, from the same functions as the run. Before, the route reported
// `resolveModelRef(agentModelFor(k))` for every key, i.e. without a choice the default model of the ACTIVE provider: with Codex
// active a Codex model for keys that fell back to Claude, and for compaction a model that does not exist (it runs with the
// chat's). Counter-test: the route at the old state (`resolveModelRef(agentModelFor(k))` in GET and PUT) => this test red.
test("Active provider Codex, no choice => compact says \"as the chat\", a oneshot follows the active provider; the special chats are gone", async () => {
  await withServer(async ({ api }) => {
    assert.equal((await api("/api/provider", "POST", { provider: "codex" })).body?.active, "codex");
    const w = (await api("/api/agent-models")).body.effective;
    for (const k of ["manager_pipeline", "manager_administrator", "manager_categorization", "manager_ingest"]) assert.equal(k in w, false, `${k} is still in the response`);
    assert.deepEqual(w.compact, { provider: "", model: "", asChat: true }, "compact without a choice: no single model, the route says so");
    assert.equal(w.classify.provider, "codex", "a oneshot without a choice still follows the active provider");
    // PUT answers from the same function: with its own choice compaction runs this model, without it the chat again.
    let r = await api("/api/agent-models", "PUT", { key: "compact", provider: "claude", model: "claude-sonnet-5" });
    assert.deepEqual(r.body.effective, { provider: "claude", model: "claude-sonnet-5" });
    r = await api("/api/agent-models", "PUT", { key: "compact", provider: "", model: "" });
    assert.deepEqual(r.body.effective, { provider: "", model: "", asChat: true });
    assert.equal((await api("/api/agent-models", "PUT", { key: "manager_administrator", effort: "low" })).status, 400, "a removed key is unknown");
  });
  // GET and PUT report from the SAME function.
  const route = fs.readFileSync(path.join(SERVER_DIR, "settings", "routes.js"), "utf8");
  assert.equal((route.match(/effective\[k\] = agentEffective\(k\)|effective: agentEffective\(key\)/g) || []).length, 2, "GET and PUT report `agentEffective`");
});
