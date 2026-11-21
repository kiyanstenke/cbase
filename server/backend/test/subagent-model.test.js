// Subagent model choice: the main model decides per call WHICH model — and which PROVIDER — a subagent runs on. The first
// test covers model-ref resolution (providers/index.js:resolveModelRef); type and model are resolved by the agents core
// (native-agent.test.js, engine-task-core.test.js). The last two tests cover INHERITING the model when none is given, at the
// main seam (agent harness: real server, real core, model on the wire): a subagent without model at the chat's provider runs
// the CHAT's model, a grandchild its parent agent's, a foreign provider its own default.
// Counter-test: with providers/agent-runtime.js and runs/agents.js reverted, the Claude subagent spawns
// `--model claude-sonnet-5` (default) instead of the chat model, the grandchild likewise, and the engine subagent asks with
// m1 (first catalog model).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { formatModelRef, parseModelRef } from "../electron/server/providers/contract.js";
import { defaultModelFor, getConnector, registerConnector, resolveModelRef } from "../electron/server/providers/index.js";
import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";

function fakeConnector({ id, label, models, complete }) {
  return {
    id,
    label,
    models,
    caps: { ownsAgentLoop: false, nativeToolCalling: true, streaming: false, subagents: true, vision: false },
    cleanEnv: () => ({}),
    resolveModel: (m) => m || models[0].id,
    runOnce: async () => "",
    complete,
  };
}

test("model refs: syntax and registry resolution", () => {
  assert.deepEqual(parseModelRef("openai::gpt-5"), { provider: "openai", model: "gpt-5", raw: "openai::gpt-5" });
  assert.deepEqual(parseModelRef("  opus  "), { provider: "", model: "opus", raw: "opus" });
  assert.deepEqual(parseModelRef(null), { provider: "", model: "", raw: "" });
  assert.equal(formatModelRef("openai", "gpt-5"), "openai::gpt-5");
  assert.equal(formatModelRef("", "opus"), "opus");

  // The registry knows only claude, codex, openrouter (only-three-provider.test.js): the spy REPLACES OpenRouter and the real
  // one is put back afterwards.
  const real = getConnector("openrouter");
  registerConnector(fakeConnector({
    id: "openrouter", label: "Solo", models: [{ id: "solo-1", label: "Eins", context: 1000 }],
    complete: async () => ({ text: "", toolCalls: [], usage: {}, stop: "end" }),
  }));
  try {
    // Without a prefix the run's provider stays.
    const own = resolveModelRef("solo-1", "openrouter");
    assert.equal(own.providerId, "openrouter");
    assert.equal(own.crossProvider, false);

    // With a prefix the provider changes.
    const foreign = resolveModelRef("openrouter::solo-1", "claude");
    assert.equal(foreign.providerId, "openrouter");
    assert.equal(foreign.model, "solo-1");
    assert.equal(foreign.crossProvider, true);

    // An unknown prefix is NOT swallowed as a provider — otherwise the subagent would run silently at the wrong provider
    // instead of letting the model correct itself.
    const bogus = resolveModelRef("nonexistent::x", "openrouter");
    assert.equal(bogus.unknownProvider, true);
    assert.equal(bogus.providerId, "openrouter");
  } finally { registerConnector(real); }
});

// ── Inheritance without a model ─────────────────────────────────────────────────────────────────
// The main agent starts the calls from the message (after "CALLS:") one after another in the foreground and stores each
// result under its `tag` in the throwaway folder (pattern of agent-level-repo.test.js).
const MAIN = `
  const everything = ((msg.message && msg.message.content) || []).map((c) => (c && c.text) || "").join("\\n");
  const calls = JSON.parse(everything.slice(everything.indexOf("CALLS:") + 6).split("\\n")[0]);
  for (let i = 0; i < calls.length; i++) {
    const { tag, ...rest } = calls[i];
    const id = "toolu_" + tag;
    const input = { run_in_background: false, description: "Part " + tag, ...rest };
    say({ type: "assistant", message: { id: "m_" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input }] } });
    const r = await mcpCall("cbase_agent", input);
    const t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    fs.writeFileSync(path.join(LOCATION, "res-" + tag + ".txt"), t);
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// The subagent reports its `--model`; "ENKEL:" in the task starts a grandchild WITHOUT model.
const SUB = `
  if (text.includes("ENKEL:")) {
    say({ type: "assistant", message: { id: "sub-grandchild", content: [{ type: "tool_use", id: "toolu_grandchild", name: "mcp__cbase__cbase_agent", input: {} }] } });
    const r = await mcpCall("cbase_agent", { description: "Grandchild", prompt: "Leaf without model", run_in_background: false });
    fs.writeFileSync(path.join(LOCATION, "res-grandchild.txt"), (r.result && r.result.isError ? "FEHLER " : "") + textOf(r));
  }
  finished();
  say({ type: "result", result: "model=" + (arg("--model") || "-"), session_id: "sub-session" });`;

// A fake Codex that reports its `-m`.
const CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for a file to EXIST and then reads it — without the rename it read an empty one under
// load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const i = argv.indexOf("-m");
say({ type: "thread.started", thread_id: "codex-thread" });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "model=" + (i >= 0 ? argv[i + 1] : "-") } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

const readResult = (root, tag) => fs.readFileSync(path.join(root, `res-${tag}.txt`), "utf8");
const reportOf = (root, tag) => {
  const t = readResult(root, tag);
  assert.doesNotMatch(t, /^FEHLER /, `${tag}: ${t}`);
  return JSON.parse(t);
};
const modelOnWire = (rep) => /model=(\S+)/.exec(rep.report || "")?.[1];

test("inheritance without model: Claude subagent runs the CHAT model, explicit wins, grandchild inherits from the parent agent, a foreign provider takes its default", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForLog, waitForIdle }) => {
    // A chat model that is NOT the provider's default — otherwise the old behavior would look the same.
    const CHAT_MODEL = "claude-opus-5-5";
    const standard = defaultModelFor("claude");
    assert.notEqual(standard, CHAT_MODEL, "precondition: the chat model is not the default");
    const p = await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: CHAT_MODEL }) });
    assert.equal(p.model, CHAT_MODEL, JSON.stringify(p));
    const HAIKU = "claude-haiku-4-5-20251001";
    const codexStandard = defaultModelFor("codex");
    const metaCount = (l) => l.filter((m) => m.role === "meta").length;
    const prior = metaCount(await json(`${base}/api/chats/${chat.id}/log`));
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `CALLS:${JSON.stringify([
      { tag: "without", prompt: "inherits" },
      { tag: "prefix-empty", model: "claude::", prompt: "inherits too" },
      { tag: "explicit", model: `claude::${HAIKU}`, prompt: "named" },
      { tag: "codex-without", model: "codex::", prompt: "foreign" },
      { tag: "parent", model: `claude::${HAIKU}`, prompt: "ENKEL: start one" },
    ])}` }) });
    await waitForLog(chat.id, (l) => metaCount(l) > prior);
    await waitForIdle();

    const without = reportOf(root, "without");
    assert.equal(modelOnWire(without), CHAT_MODEL, `without model: --model of the chat, not the default (${standard}): ${without.report}`);
    // Description == execution: the report names the model that ran.
    assert.equal(without.resolvedModel, CHAT_MODEL, "resolvedModel in the report");
    assert.equal(modelOnWire(reportOf(root, "prefix-empty")), CHAT_MODEL, "\"claude::\" without model: same inheritance");
    const ausdr = reportOf(root, "explicit");
    assert.equal(modelOnWire(ausdr), HAIKU, "explicit model wins");
    assert.equal(ausdr.resolvedModel, HAIKU);
    const codex = reportOf(root, "codex-without");
    assert.equal(codex.provider, "codex");
    assert.equal(modelOnWire(codex), codexStandard, `foreign provider without model: its default, never the chat model: ${codex.report}`);
    assert.equal(codex.resolvedModel, codexStandard);
    assert.equal(modelOnWire(reportOf(root, "parent")), HAIKU);
    const grandchild = JSON.parse(fs.readFileSync(path.join(root, "res-grandchild.txt"), "utf8"));
    assert.equal(modelOnWire(grandchild), HAIKU, `the grandchild inherits the model of its PARENT agent, not the chat's: ${grandchild.report}`);
    assert.equal(grandchild.resolvedModel, HAIKU);
    console.log(`  [inheritance] chat ${CHAT_MODEL}, default ${standard}: without ${modelOnWire(without)}, explicit ${modelOnWire(ausdr)}, codex:: ${modelOnWire(codex)}, grandchild ${modelOnWire(grandchild)}`);
  }, { claude: fakeClaude({ main: MAIN, sub: SUB }), codex: CODEX });
});

test("inheritance without model: an OpenRouter chat on a model other than the first catalog model asks with the chat model for the subagent too", async () => {
  // The measured case: a chat on one model spawned its subagents with the first catalog model (the connector filled the gap)
  // — 403. Here: the harness catalog [m1, m2, …], default m1 (stored by the OpenRouter sign-in — without a stored one there
  // is no default), chat on m2 (via the built-in OpenRouter).
  const isSub = (b) => /subagent of cbase/i.test(JSON.stringify(b.messages?.[0]?.content ?? ""));
  const hasTool = (b) => (b.messages || []).some((m) => m.role === "tool");
  const round = async (b) => {
    if (isSub(b)) return { text: "SUB-REPORT" };
    return hasTool(b) ? { text: "finished" } : { toolCalls: [{ id: "call_inherit", name: "mcp__cbase__cbase_agent", arguments: { description: "Look", prompt: "Look and report.", run_in_background: false } }] };
  };
  await withAgentsServer(async ({ base, ws, engine, waitForIdle }) => {
    assert.equal(defaultModelFor(engine.id), "m1", "precondition: the provider default is m1, not the chat model");
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: engine.id, model: "m2", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Inheritance engine" }) });
    await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please use a subagent" }) });
    await waitForIdle();

    const sub = engine.requests.filter((b) => b.stream !== false && isSub(b));
    assert.ok(sub.length, "no request from the subagent");
    assert.deepEqual([...new Set(sub.map((b) => b.model))], ["m2"], "the subagent asks with the chat model");
    const main = engine.requests.filter((b) => b.stream !== false && !isSub(b));
    assert.deepEqual([...new Set(main.map((b) => b.model))], ["m2"], "precondition: the main run uses m2");
    const list = await json(`${base}/api/chats/${c.id}/agents`);
    assert.deepEqual(list.agents.map((a) => [a.provider, a.model]), [[engine.id, "m2"]], "core list: same model");
  }, { engine: { round } });
});
