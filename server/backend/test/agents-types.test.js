// The agent definitions run through the core — and ONLY there. Before, Claude's own Agent/Task tool stood in every Claude
// main chat, and cbase handed it the definitions via `--agents`: a second way to subagents that bypassed cap, depth, credit
// gate and consumption counting. Since then Agent/Task is locked in EVERY Claude run (CLAUDE_LOCK_DEFAULT), `--agents` is in
// no spawn, and a definition is an agent type of cbase_agent.
//
// At the main seam (agent harness: real server, real cbase MCP server, real core, fake Claude):
//   1. the main chat no longer sees Agent/Task, and no spawn carries --agents;
//   2. a PROJECT definition with a skill and a model reference, started through cbase_agent from a Claude main chat, carries
//      role, origin sentence, skill block and model at the spawn — and counts in cap and depth and stands in the agent bar
//      (SSE harness/background);
//   3. the detection of CLI background tasks has lost only its Agent/Task branch: a background Bash is detected as before
//      (hold reason, display) and its evaluation, which follows by itself, arrives.
//
// Counter-proofs (which sabotage turns which test red):
//   • CLAUDE_LOCK_DEFAULT back to ["Workflow"] (the old lock list of the main chat) => test 1: Agent stands in the tool list
//     of the fake Claude.
//   • the Bash branch in runs/do-run.js removed (`blk.name === "Bash" && …` never true) => test 3: no task in the display,
//     the run does not hold.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";

// The main agent: writes down its view (built-in tools, --agents, lock list) and runs the commands of its input —
// START:X starts the agent type "till-checker" in the background (the subagent waits at gate "subX"); BASH replays the
// measured sequence of a background Bash (task_started -> result -> gate "bash" -> end of the task -> follow-up turn of
// the CLI by itself).
const fake = fakeClaude({
  sub: `
    const marker = (/Job \\[([A-Z])\\]/.exec(text) || [])[1] || "x";
    fs.writeFileSync(path.join(LOCATION, "sub-" + marker + ".json"), JSON.stringify({
      argv, model: arg("--model"), locked: arg("--disallowedTools"), tools: await mcpTools(),
    }));
    await gate("sub" + marker);
    finished();
    say({ type: "result", result: "Report " + marker, session_id: "sub-session-" + marker });`,
  main: `
  fs.writeFileSync(path.join(LOCATION, "main-" + turn + ".json"), JSON.stringify({
    builtin: eingebauteTools(), withAgents: argv.includes("--agents"), locked: arg("--disallowedTools"),
  }));
  const calls = async (name, args, id) => {
    say({ type: "assistant", message: { id: "m-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__" + name, input: args }] } });
    let t = "";
    try { const r = await mcpCall(name, args); t = (r && r.result && r.result.isError ? "FEHLER " : "") + textOf(r); }
    catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  };
  for (const x of (text.match(/\\bSTART:[A-Z]\\b/g) || []).map((o) => o.slice(6))) {
    await calls("cbase_agent", { subagent_type: "till-checker", name: x, description: "Till " + x, prompt: "Job [" + x + "].", run_in_background: true }, "toolu_start_" + x);
  }
  if (text.includes("BASH")) {
    say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_bash_1",
      input: { command: "until test -f done; do sleep 8; done", description: "Wait for the E2E run", run_in_background: true } }] } });
    say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sh-1" }] });
    say({ type: "system", subtype: "task_started", task_id: "sh-1", tool_use_id: "toolu_bash_1" });
    say({ type: "assistant", message: { content: [{ type: "text", text: "E2E running, I will report back" }] } });
    say({ type: "result", result: "E2E running, I will report back", session_id: "main-session" });
    await gate("bash");
    say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    say({ type: "system", subtype: "task_updated", task_id: "sh-1", patch: { status: "completed" } });
    say({ type: "system", subtype: "task_notification", task_id: "sh-1", tool_use_id: "toolu_bash_1" });
    say({ type: "system", subtype: "init", session_id: "main-session" });
    say({ type: "assistant", message: { content: [{ type: "text", text: "E2E green — MR open" }] } });
    finished();
    say({ type: "result", result: "E2E green — MR open", session_id: "main-session" });
    return;
  }
  say({ type: "assistant", message: { id: "main-end-" + turn, content: [{ type: "text", text: "Turn " + turn + " done" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

const message = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const readJson = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

// The tool result of a call from the history — as soon as it stands there.
const result = (waitForLog, chatId, id) => waitForLog(chatId, (l) => l.some((m) => m.role === "tool_result" && JSON.parse(m.text).id === id))
  .then((l) => JSON.parse(l.find((m) => m.role === "tool_result" && JSON.parse(m.text).id === id).text).result);

// The event stream of the chat, recorded — the agent bar (harness/background) reads from it.
async function stream(base, chatId) {
  const ctl = new AbortController();
  const events = [];
  const r = await fetch(`${base}/api/chats/${chatId}/stream`, { signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const blk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const z of blk.split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch {} }
        }
      }
    } catch { /* unsubscribed */ }
  })();
  return { events, close: () => ctl.abort() };
}

async function withSlider(value, fn) {
  const prior = process.env.CBASE_AGENT_CAP;
  process.env.CBASE_AGENT_CAP = String(value);
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env.CBASE_AGENT_CAP;
    else process.env.CBASE_AGENT_CAP = prior;
  }
}

// A project "Till" in the workspace, with a project skill and a project definition that loads it and names a model. The
// harness chat is a WORKSPACE chat: there the project agent carries its origin (effectiveAgents).
async function till({ base, ws, root }) {
  const projPath = path.join(root, "workspace", "till");
  fs.mkdirSync(projPath, { recursive: true });
  const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: projPath }) });
  await json(`${base}/api/projects/${project.id}/skills`, { method: "POST", body: JSON.stringify({
    name: "receipt", description: "Formats a till receipt.", body: "Instructions for receipt.",
  }) });
  await json(`${base}/api/projects/${project.id}/agents`, { method: "POST", body: JSON.stringify({
    name: "till-checker", description: "Checks till receipts.", body: "You check till receipts.", skills: ["receipt"], model: "claude::claude-sonnet-5",
  }) });
  return { project, projPath };
}

test("Claude main chat: Agent and Task are not in its tools, and no spawn carries --agents", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, waitForLog, waitForIdle }) => {
    // A definition in the workspace — exactly what used to go to the CLI as --agents.
    await json(`${base}/api/workspaces/${ws.id}/agents`, { method: "POST", body: JSON.stringify({ name: "checker", description: "Checks", body: "You check." }) });
    await message(base, chat.id, "hello");
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Turn 1 done"));
    const view = readJson(root, "main-1.json");
    assert.ok(view.builtin.includes("Bash"), `the fake does not read the tools: ${JSON.stringify(view)}`);
    for (const n of ["Agent", "Task", "Workflow"]) assert.equal(view.builtin.includes(n), false, `${n} stands in the tools of the main chat: ${view.locked}`);
    assert.equal(view.withAgents, false, "the main chat gets --agents");
    await waitForIdle();
  }, { claude: fake });
});

test("project definition via cbase_agent from the Claude main chat: role, origin, skills and model at the spawn; cap, depth and bar apply", async () => {
  await withSlider(1, () => withAgentsServer(async ({ base, ws, chat, root, gate, waitForTruthy, waitForLog, waitForIdle }) => {
    const { projPath } = await till({ base, ws, root });
    const s = await stream(base, chat.id);
    try {
      // A starts; B is the same type over the cap (slider 1) — so it counts like every subagent.
      await message(base, chat.id, "START:A START:B");
      const a = await result(waitForLog, chat.id, "toolu_start_A");
      assert.doesNotMatch(a, /^FEHLER /, a);
      const b = await result(waitForLog, chat.id, "toolu_start_B");
      assert.match(b, /^FEHLER /, b);
      assert.match(b, /Cap reached/, b);
      await gate.reached("subA");
      assert.equal(fs.existsSync(path.join(root, "sub-B.json")), false, "the rejected type started a process");

      // At the subagent's spawn: origin sentence, role, skill block (complete), frame of depth 1, model.
      const sub = readJson(root, "sub-A.json");
      const sys = sub.argv.join("\n");
      assert.ok(sys.includes(`You belong to the project "Till" (folder: ${projPath})`), "origin sentence missing");
      assert.match(sys, /You check till receipts\./);
      assert.match(sys, /# Loaded skills/);
      assert.match(sys, /## Skill: receipt — Formats a till receipt\./);
      assert.match(sys, /Instructions for receipt\./);
      assert.ok(sys.indexOf("You belong to the project") < sys.indexOf("You check till receipts.") && sys.indexOf("You check till receipts.") < sys.indexOf("# Loaded skills"), "order origin -> role -> skills");
      assert.equal(sub.model, "claude-sonnet-5", "the model reference of the definition");
      // Depth: level 1 of 3, may delegate itself; the CLI's own agents stay locked for it too.
      assert.match(sys, /SUBAGENT of cbase \(depth 1 of 3/);
      assert.ok(sub.tools.includes("cbase_agent"), "at depth 1 cbase_agent stands");
      assert.match(sub.locked, /\bAgent\b/);
      assert.match(sub.locked, /\bTask\b/);
      assert.equal(sub.argv.includes("--agents"), false);

      // Agent bar (SSE harness/background): the agent stands with its type's model under its call block.
      await waitForTruthy(() => s.events.some((e) => e.type === "harness" && e.subtype === "background"
        && (e.agents || []).some((x) => x.toolUseId === "toolu_start_A")), "agent bar");
      const row = s.events.filter((e) => e.type === "harness" && e.subtype === "background")
        .flatMap((e) => e.agents || []).find((x) => x.toolUseId === "toolu_start_A");
      assert.equal(row.name, "A");
      assert.equal(row.model, "claude-sonnet-5");
      // cbase_agents_list: the agent under its type with the loaded skills, and the choice names the origin (before, it
      // stood only in the --agents description).
      const selection = await json(`${base}/api/chats/${chat.id}/agents`);
      const run = selection.agents.find((x) => x.name === "A");
      assert.equal(run?.subagent_type, "till-checker", JSON.stringify(selection.agents));
      assert.deepEqual(run.skills, ["receipt"]);
      assert.equal(selection.types.find((t) => t.name === "till-checker")?.originProject, "Till");
    } finally {
      gate.open("subA");
      s.close();
    }
    await waitForIdle();
  }, { claude: fake }));
});

test("background Bash of a fake Claude: detected as before (hold reason, display), the CLI's evaluation arrives", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForLog, waitForIdle }) => {
    try {
      await message(base, chat.id, "BASH");
      // The first text stands BEHIND task_started in the stream — once it is in the history, the server has seen the task.
      await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "E2E running, I will report back"));
      await gate.reached("bash");
      const item = (await json(`${base}/api/active-runs`)).items.find((it) => it.chatId === chat.id);
      assert.equal(item?.background?.tasks, 1, `the background Bash is missing in the display: ${JSON.stringify(item)}`);
      assert.equal(item.background.agents, 0);
      gate.open("bash");
      const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
      assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["E2E running, I will report back", "E2E green — MR open"]);
      // One run, ended regularly — stdin stayed open for the evaluation.
      assert.equal(log.filter((m) => m.role === "meta").length, 1);
      assert.equal(JSON.parse(log.find((m) => m.role === "meta").text).aborted, undefined);
    } finally {
      gate.open("bash");
    }
    await waitForIdle();
  }, { claude: fake });
});
