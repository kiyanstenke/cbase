// The owner of the subagents per chat (runs/agents.js): the spec factory with explicit context, its frame parameter, the
// own event sink and the agent routes without a running turn. Real server, real MCP server, fake CLI (agent-harness.mjs) —
// the harness runs in the same process, so the modules here are the same instances as the server's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { agentSpecFactory, agentsOf } from "../electron/server/runs/agents.js";
import { outputLocation } from "../electron/server/runs/outputs.js";
import { SUBAGENT_FRAME } from "../electron/server/providers/agent-runtime.js";
import { buildClaudeChatArgs } from "../electron/server/providers/connectors/claude.js";
import { chatSkills } from "../electron/server/toolchain/skill-catalog.js";
import * as store from "../electron/server/store.js";

// Main agent: ONE foreground subagent via cbase_agent, then an answer. The subagent does what `sub` says.
const withSubagent = (sub) => fakeClaude({
  sub,
  main: `
  say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_agent_call", name: "mcp__cbase__cbase_agent",
    input: { description: "Fetch finding", prompt: "Take a look.", run_in_background: false } }] } });
  let report = "";
  try { report = textOf(await mcpCall("cbase_agent", { description: "Fetch finding", prompt: "Take a look.", run_in_background: false })); }
  catch (e) { report = "FEHLER " + e.message; }
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent_call", content: report }] } });
  say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: report.includes("Finding 42") ? "Finding received" : "no finding" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

test("the spec factory delivers, WITHOUT a turn and from explicit context, the same specification as the run — and the frame is its parameter", async () => {
  // The subagent writes down what the run started it with: its arguments and its MCP config.
  const script = withSubagent(`
    fs.writeFileSync(path.join(LOCATION, "sub-argv.json"), JSON.stringify(argv));
    fs.writeFileSync(path.join(LOCATION, "sub-mcp.json"), fs.readFileSync(cfgPath));
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Finding 42" }] } });
    finished();
    say({ type: "result", result: "Finding 42", session_id: "sub-session" });`);
  await withAgentsServer(async ({ base, chat, ws, root, waitForLog }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Fetch the finding" }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    const result = log.map((m) => m.role === "tool_result" && JSON.parse(m.text)).find((r) => r && r.id === "toolu_agent_call");
    const report = JSON.parse(result.result);
    assert.equal(report.status, "completed");

    // The turn is over: the factory gets everything from the context, nothing from a run. The turn's core stays open because
    // it knows a (finished) agent that a later turn can resume — attached to no turn.
    assert.equal(agentsOf(chat.id)?.inTurn() ?? false, false, "without a turn no core hangs on a run");
    const row = store.getChat(chat.id);
    const context = {
      chat: row,
      provider: "claude",
      // The run carries the chat's output location — a profile without it would not be the run's.
      profile: { permissionMode: "bypassPermissions", addDirs: [outputLocation(chat.id)], builtinTools: null },
      tools: {
        toolset: "", cbase: null, extraServers: store.effectiveMcpServers(ws.id, null), extern: [], mcpAllow: [],
        skills: chatSkills(row),
      },
      depth: 1,
    };
    // What the core hands to the factory: general-purpose has no role, so only the blank before it — and no tool list
    // (`null`; `[]` is the EMPTY list, not "unset"). The core resolved the model (without a value that of the chat) — the
    // factory gets it ready, as in the run.
    assert.equal(report.resolvedModel, row.model, "without a model argument: the chat's model");
    const o = { agentId: report.agentId, systemPrompt: "", input: "Take a look.", provider: "claude", model: report.resolvedModel,
      cwd: store.getWorkspace(ws.id).path, tools: null, skills: [], sessionId: null, transcript: [], inheritContext: false };
    // Asynchronous: the project memory of a copy is read by its container.
    const spec = await agentSpecFactory(context)(o);
    const argvRun = JSON.parse(fs.readFileSync(path.join(root, "sub-argv.json"), "utf8"));
    assert.deepEqual(buildClaudeChatArgs(spec), argvRun, "the arguments of the subagent run");
    assert.equal(fs.readFileSync(spec.mcpConfigPath, "utf8"), fs.readFileSync(path.join(root, "sub-mcp.json"), "utf8"),
      "the same MCP config (depth, profile, tools)");
    assert.equal(spec.systemPrompt, SUBAGENT_FRAME, "without a value: today's frame, byte-equal");

    // With a value the frame replaces today's — otherwise nothing changes in the specification.
    const own = await agentSpecFactory(context, { frame: "\n\nYour last text is literally the return value." })({ ...o, systemPrompt: "Role" });
    assert.equal(own.systemPrompt, "Role\n\nYour last text is literally the return value.");
    const { systemPrompt: _a, ...restOwn } = own;
    const { systemPrompt: _b, ...restDefault } = await agentSpecFactory(context)({ ...o, systemPrompt: "Role" });
    assert.deepEqual(restOwn, restDefault);

    // The agent routes read the owner per chat; without a running turn they answer as before.
    // With a JSON type: a body without it is answered by readBody with 415 (runtime/http.js).
    const r = await fetch(`${base}/api/chats/${chat.id}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "No active run — a subagent needs a running turn." });
    const list = await json(`${base}/api/chats/${chat.id}/agents`);
    // The finished agent stays known (resumable), none is living.
    assert.deepEqual(list.agents.map((a) => a.status), ["completed"], "without a run no living subagents — the finished one stays known");
    assert.ok(list.types.some((t) => t.name === "general-purpose" && t.builtin), `choice without a run: ${JSON.stringify(list).slice(0, 300)}`);
  }, { claude: script });
});

test("alarm and schedule of a SUBAGENT do not set those of the main run — its tools still stand under the call", async () => {
  // Counter-proof (old state, the turn's sink): ScheduleWakeup/CronCreate of the subagent set the chat's alarm — the run went
  // into the waiting phase with wakeupAt and kept the chat open until the wake time.
  const script = withSubagent(`
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "tool_use", id: "toolu_sub_wake", name: "ScheduleWakeup",
      input: { delaySeconds: 600, prompt: "go on later", reason: "Sub alarm" } }] } });
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub_wake", content: "ok" }] } });
    say({ type: "assistant", message: { id: "sub-2", content: [{ type: "tool_use", id: "toolu_sub_cron", name: "CronCreate",
      input: { cron: "*/5 * * * *", prompt: "check", recurring: true } }] } });
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub_cron", content: "Scheduled recurring task abcd1234 (*/5 * * * *)" }] } });
    say({ type: "assistant", message: { id: "sub-3", content: [{ type: "text", text: "Finding 42" }] } });
    finished();
    say({ type: "result", result: "Finding 42", session_id: "sub-session" });`);
  await withAgentsServer(async ({ base, chat, waitForTruthy }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Fetch the finding" }) });
    // Wait for one of two events: the run is over (meta) OR it keeps the chat with an alarm.
    const outcome = await waitForTruthy(async () => {
      const run = (await json(`${base}/api/active-runs`))?.items?.find((it) => it.chatId === chat.id);
      if (run?.background?.wakeupAt > 0) return { wakeup: run.background.wakeupAt };
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      return log.some((m) => m.role === "meta") ? { end: log } : null;
    }, "run end or alarm at the chat");
    assert.equal(outcome.wakeup, undefined, `the subagent set the main run's alarm (wakeupAt ${outcome.wakeup})`);
    const log = outcome.end;
    assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["Finding received"]);
    // The subagent's tools still stand nested under its call block.
    const under = log.filter((m) => m.role === "tool").map((m) => JSON.parse(m.text)).filter((t) => t.parent === "toolu_agent_call");
    assert.deepEqual(under.map((t) => t.name), ["ScheduleWakeup", "CronCreate"]);
  }, { claude: script });
});
