// End to end of the native subagent tool: real server, real cbase MCP server, real HTTP route; only the CLI is faked. It does
// what a model would do: call `cbase_agent`. The server then starts a SECOND CLI run as a subagent, mirrors its events nested
// into the chat and returns its report as the tool result.
//
// The tooling (server on a free port, fake Claude with a real MCP call, fake Codex, fake preset endpoint, waiting without a
// deadline, gates, restart, finally) stands in `agent-harness.mjs`; here stand only the roles of the fakes and the assertions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, fakeCodex, json, withAgentsServer } from "./agent-harness.mjs";

// A fake CLI for BOTH roles. What tells it that it is the subagent: the server appends the subagent system prompt to it
// (--append-system-prompt), the same feature by which a real model recognises its role (the harness derives `isSub` from it).
const fakeClaudeNativeAgent = (modelRef = "", skills = null) => fakeClaude({
  sub: `
    // Role subagent: use a tool (proves the nesting in the chat) and report. What the subagent finds in ITS system prompt: the
    // full body of a loaded skill and the catalog line; the test measures both at the report, not at a claim.
    const sysPrompt = arg("--append-system-prompt");
    const skillMarker = "skills=" + (sysPrompt.includes("# Loaded skills") ? "loaded" : "-")
      + (sysPrompt.includes("Instructions for checklist.") ? "+body" : "")
      + (sysPrompt.includes("- checklist:") ? "+catalog" : "");
    // The depth stands in the MCP CONFIG of this run (the MCP server gets it as env, the CLI itself does not); through exactly
    // that it hides cbase_agent*/cbase_ask for a subagent.
    let cfgDepth = "-";
    try { cfgDepth = String(JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase.env.CBASE_AGENT_DEPTH || "-"); } catch {}
    // A copy for the test: the server removes the file at the agent end.
    try { fs.copyFileSync(cfgPath, path.join(LOCATION, "sub-" + path.basename(cfgPath))); } catch {}
    say({ type: "assistant", message: { id: "sub-1", usage: { input_tokens: 11, output_tokens: 5 },
      content: [{ type: "tool_use", id: "toolu_sub_read", name: "Read", input: { file_path: "/tmp/sub" } }] } });
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub_read", content: "read" }] } });
    const marker = "disallow=" + (arg("--disallowedTools") || "-") + " depth=" + cfgDepth + " " + skillMarker
      + " model=" + (arg("--model") || "-");
    say({ type: "assistant", message: { id: "sub-2", content: [{ type: "text", text: "Befund 42 | " + marker }] } });
    finished();
    say({ type: "result", result: "Befund 42 | " + marker, session_id: "sub-session" });`,
  main: `
  // Role main agent: first ask for the choice, then start a subagent.
  let types = "";
  let report = "";
  try {
    types = textOf(await mcpCall("cbase_agents_list", { view: "start" }));
    // The call block MUST stand in the stream before the tool call: that is how the server knows under which block it hangs the
    // events of the subagent.
    say({ type: "assistant", message: { id: "main-1", usage: { input_tokens: 20, output_tokens: 8 },
      content: [{ type: "tool_use", id: "toolu_agent_call", name: "mcp__cbase__cbase_agent",
        input: { description: "Fetch finding", prompt: "Look into it and report the finding.", run_in_background: false } }] } });
    const res = await mcpCall("cbase_agent", { description: "Fetch finding", prompt: "Look into it and report the finding.", run_in_background: false${modelRef ? `, model: ${JSON.stringify(modelRef)}` : ""}${skills ? `, skills: ${JSON.stringify(skills)}` : ""} });
    report = textOf(res);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent_call", content: report }] } });
  } catch (e) {
    report = "ERROR " + e.message;
  }
  const ok = report.includes("Befund 42");
  const hasTypes = types.includes("general-purpose") && types.includes("hosts");
  say({ type: "assistant", message: { id: "main-2", content: [{ type: "text",
    text: "Result: " + (ok ? "Befund 42 received" : "no finding") + " | Choice: " + (hasTypes ? "known" : "missing") }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

// The first turn of the background start: start the subagent with run_in_background. `afterwards` is what the main agent still
// does in the same turn. The start is every turn that is NOT a completion notice: the notice comes as a run of its own (new
// process, turn 1 again there).
const backgroundStart = (afterwards) => `
  if (!text.startsWith("<task-notification>")) {
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_bg_call", name: "mcp__cbase__cbase_agent",
      input: { description: "Aside", prompt: "Look into it.", run_in_background: true } }] } });
    let t = "";
    try {
      const res = await mcpCall("cbase_agent", { description: "Aside", prompt: "Look into it.", run_in_background: true });
      t = textOf(res);
    } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg_call", content: t }] } });
${afterwards}
    return;
  }`;

// Variant for the background start: the main agent ends its turn at once, the report must then reach it by itself as a new turn.
const fakeClaudeBackgroundAgent = fakeClaude({
  sub: `
    say({ type: "assistant", message: { id: "sub-1", usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "Background finding 42" }] } });
    finished();
    say({ type: "result", result: "Background finding 42", session_id: "sub-session" });`,
  main: backgroundStart(`
    say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: t.startsWith("ERROR") ? t.slice(0, 200) : "Subagent running" }] } });
    say({ type: "result", result: "Subagent running", session_id: "main-session" });`) + `
  // Second turn: it arises ONLY if the server has delivered the report by itself.
  say({ type: "system", subtype: "init", session_id: "main-session" });
  say({ type: "assistant", message: { id: "main-3", content: [{ type: "text",
    text: "Delivered: " + (text.includes("Background finding 42") ? "yes" : "no") + " | " + text.slice(0, 60).replace(/\\n/g, " ") }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`,
});

// As above, but the main agent FETCHES the report in the same turn (cbase_agent_output). So a waiter stands ready when it
// finishes: exactly the situation in which the addendum to the call block used to fail. The subagent takes its time so that
// the pickup really runs when it settles (otherwise it would be the other case).
const fakeClaudeCollectedAgent = fakeClaude({
  sub: `
    setTimeout(() => {
      say({ type: "assistant", message: { id: "sub-1", usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "Background finding 42" }] } });
      finished();
      say({ type: "result", result: "Background finding 42", session_id: "sub-session" });
    }, 1_200);`,
  main: backgroundStart(`
    let agentId = "";
    try { agentId = JSON.parse(t).agentId || ""; } catch {}
    say({ type: "assistant", message: { id: "main-2", content: [{ type: "tool_use", id: "toolu_out_call", name: "mcp__cbase__cbase_agent_output",
      input: { agentId } }] } });
    let o = "";
    try {
      o = textOf(await mcpCall("cbase_agent_output", { agentId }));
    } catch (e) { o = "FEHLER " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_out_call", content: o }] } });
    say({ type: "assistant", message: { id: "main-3", content: [{ type: "text", text: o.includes("Background finding 42") ? "Picked up itself" : "Got nothing" }] } });
    finished();
    say({ type: "result", result: "Picked up itself", session_id: "main-session" });`),
});

const withServer = (script, fn, { codex = false } = {}) =>
  withAgentsServer(async (ctx) => fn(ctx), { claude: script, codex: codex ? fakeCodex() : null });

test("a CLI chat starts a real subagent run through cbase_agent", async () => {
  await withServer(fakeClaudeNativeAgent(), async ({ base, chat, dataRoot, root, waitForLog }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Get me the finding" }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    // 1) The main agent got the report of the subagent as a tool result.
    const texts = log.filter((m) => m.role === "assistant").map((m) => m.text);
    assert.deepEqual(texts, ["Result: Befund 42 received | Choice: known"]);

    // 2) The tool result carries the full report: status, agentId, provider, model, tokens.
    const rows = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text));
    const agentResult = rows.find((r) => r.id === "toolu_agent_call");
    assert.ok(agentResult, "the result of the cbase_agent call must be persisted");
    const payload = JSON.parse(agentResult.result);
    assert.equal(payload.status, "completed");
    assert.equal(payload.provider, "claude");
    assert.match(payload.report, /Befund 42/);
    assert.ok(payload.agentId, "the report must carry the agentId");
    assert.ok(payload.totalTokens > 0, "tokens of the subagent are reported");
    // The Claude CLI reports both sides on an assistant event WITH message.id; the number is complete, and the report says so.
    assert.equal(payload.tokenKind, "full");
    assert.equal(payload.resolvedModel.includes("::"), false, "the model never carries the provider");

    // 3) The subagent ran with the right limits: no built-in agent tool, depth 1 (its MCP server thereby hides cbase_agent* and
    //    cbase_ask).
    assert.match(payload.report, /disallow=Agent,Task/);
    assert.match(payload.report, /depth=1/);
    // Without a skills argument the subagent loads nothing in full (the catalog of this chat is empty).
    assert.match(payload.report, /skills=-(?![+])/);
    // ... and it runs with an EXPLICIT model. Without a model argument agent-runtime.js creates `rec.model = ""`; that used to go
    // to the spawn, and the CLI was started WITHOUT `--model`/`-m`. On the Codex side that means the clamp at the spawn clamps
    // against a model nobody named (`model="" effort=max` yields `-c model_reasoning_effort="max"` without `-m`), and the run
    // hangs on the CLI default: harmless today, not on a default change of the CLI, and nothing would turn red. An empty `model`
    // is therefore not "unknown" but the INHERITANCE: the same value as in the main run (`chat.model || defaultModelFor(...)`),
    // here the model of the chat (Haiku), not the default (claude-sonnet-5).
    assert.match(payload.report, /model=claude-haiku-4-5-20251001\b/, "the subagent starts with the model of the chat, not without a model and not with the default");
    assert.equal(payload.resolvedModel, "claude-haiku-4-5-20251001", "the report names the model that ran");

    // 4) Its work hangs NESTED under the call, not in the main stream.
    const tools = log.filter((m) => m.role === "tool").map((m) => JSON.parse(m.text));
    const call = tools.find((t) => t.name === "mcp__cbase__cbase_agent");
    assert.ok(call, "the call itself stands in the history");
    const nested = tools.find((t) => t.name === "Read");
    assert.ok(nested, "the tool of the subagent stands in the history");
    assert.equal(nested.parent, "toolu_agent_call");

    // 4b) Its TEXT hangs there too, as a role of its own `sub_text` with a parent. Without it it stood live in the fold and was
    //     gone after a reload. As `assistant` it must NOT appear: that is the main text of this chat and would falsify the context.
    const subTexts = log.filter((m) => m.role === "sub_text").map((m) => JSON.parse(m.text));
    assert.ok(subTexts.length >= 1, "the text of the subagent is persisted nested");
    assert.equal(subTexts[0].parent, "toolu_agent_call");
    assert.match(subTexts[0].text, /Befund 42/);
    assert.ok(
      !log.some((m) => m.role === "assistant" && /disallow=/.test(m.text)),
      "the text of the subagent must not stand in the history as a main answer",
    );

    // 5) The run ended regularly (not aborted, no double delivery of the report).
    const metas = log.filter((m) => m.role === "meta").map((m) => JSON.parse(m.text));
    assert.equal(metas.length, 1);
    assert.equal(metas[0].aborted, undefined);

    // 6) The MCP config of the subagent is a config of its OWN, with depth, time limit and a profile of its own. Read at the
    //    copy the subagent took during its run: at the agent end the file is gone.
    const scratch = path.join(dataRoot, "data", "scratch");
    const copy = fs.readdirSync(root).find((f) => f.startsWith(`sub-${chat.id}.agent-`) && f.endsWith(".mcp.json"));
    assert.ok(copy, "the subagent gets its own MCP config");
    assert.equal(fs.existsSync(path.join(scratch, copy.slice(4))), false, "the MCP config of the subagent survives its end");
    const cfg = JSON.parse(fs.readFileSync(path.join(root, copy), "utf8")).mcpServers;
    assert.equal(cfg.cbase.env.CBASE_AGENT_DEPTH, "1");
    assert.ok(cfg.cbase.timeout >= 600_000, "a foreground subagent may run longer than the MCP default limit");
    assert.match(cfg.playwright.args.join(" "), /-agent-/);

    // 7) The consumption of the subagent is recorded as a line of its OWN (kind 'sub', its provider, subscription billing), not
    //    hidden in the main line. Without it nobody would know what the subagents of a run actually consume. Through the usage
    //    (/api/usage/consumption): the chat carries TWO lines (main stream 20/8, subagent 11/5), and the subagent share is its output.
    const usage = await json(`${base}/api/usage/consumption?provider=claude&window=30d`);
    const row = usage.chats.find((c) => c.chatId === chat.id);
    assert.ok(row, `the chat is missing in the usage: ${JSON.stringify(usage.chats)}`);
    assert.deepEqual({ input: row.input, output: row.output, runs: row.runs }, { input: 20 + 11, output: 8 + 5, runs: 2 });
    assert.ok(usage.subagentsShare > 0, `without a subagent line: ${JSON.stringify(usage)}`);
  });
});

test("skills on the call: the subagent gets the whole body in its system prompt, without the catalog line", async () => {
  await withServer(fakeClaudeNativeAgent("", ["checklist"]), async ({ base, chat, ws, waitForLog }) => {
    await json(`${base}/api/workspaces/${ws.id}/skills`, { method: "POST", body: JSON.stringify({
      name: "checklist", area: "coding", description: "Checks step by step.", body: "Instructions for checklist.",
    }) });
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Get me the finding" }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    const rows = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text));
    const agentResult = rows.find((r) => r.id === "toolu_agent_call");
    assert.ok(agentResult, `no result of the subagent in the history: ${JSON.stringify(log.map((l) => l.role))}`);
    const payload = JSON.parse(agentResult.result);
    assert.equal(payload.status, "completed", payload.error || "");
    // The block stands there, WITH body, and the catalog line of the same skill is missing (it would say "fetch what you already
    // have").
    assert.match(payload.report, /skills=loaded\+body(?!\+catalog)/, payload.report);
    // The report names the loaded skills; the caller sees what the subagent ran with.
    assert.deepEqual(payload.skills, ["checklist"]);
    // (That the MAIN RUN gets only the catalog line and never the body is measured by a test of its own at its CLI arguments;
    // here the fake records only the subagent.)
  });
});

test("the subagent runs at ANOTHER provider than the chat", async () => {
  // Exactly the gap this tool closes: the Claude CLI always starts its own subagents at Claude. Here the chat is a Claude chat
  // and the subagent a Codex run.
  await withServer(fakeClaudeNativeAgent("codex::gpt-5.1-codex"), async ({ base, chat, waitForLog }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Get the finding at Codex" }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    const rows = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text));
    const agentResult = rows.find((r) => r.id === "toolu_agent_call");
    assert.ok(agentResult, `no result of the subagent in the history: ${JSON.stringify(log.map((l) => l.role))}`);
    const payload = JSON.parse(agentResult.result);
    assert.equal(payload.status, "completed");
    assert.equal(payload.provider, "codex", "the subagent must have run at the FOREIGN provider");
    assert.equal(payload.resolvedModel, "gpt-5.1-codex");
    assert.match(payload.report, /Codex-Befund 42/);
    // Codex reports the whole turn as an event `consumption` (connectors/codex.js): input AND output are counted (9 + 4 from
    // turn.completed of the fake).
    assert.equal(payload.tokenKind, "full");
    assert.equal(payload.totalTokens, 13, "input and output of the Codex turn");

    // The main agent got the finding (the fake checks it for "Befund 42"; the Codex subagent reported "Codex-Befund 42").
    assert.deepEqual(
      log.filter((m) => m.role === "assistant").map((m) => m.text),
      ["Result: Befund 42 received | Choice: known"],
    );

    // ... and the consumption lies with the right provider (not in the Claude line): the Codex usage carries the chat with the
    // subagent line (share 1: Codex ran only the subagent), the Claude usage only the main stream.
    const codexUsage = await json(`${base}/api/usage/consumption?provider=codex&window=30d`);
    const codexRow = codexUsage.chats.find((c) => c.chatId === chat.id);
    assert.ok(codexRow, `Codex line of the subagent is missing: ${JSON.stringify(codexUsage)}`);
    assert.equal(codexRow.runs, 1);
    assert.equal(codexUsage.subagentsShare, 1);
    const claudeRow = (await json(`${base}/api/usage/consumption?provider=claude&window=30d`)).chats.find((c) => c.chatId === chat.id);
    assert.equal(claudeRow?.runs, 1, "in the Claude usage stands only the main stream");
  }, { codex: true });
});

test("a background subagent delivers its report as a new turn and adds it to its call", async () => {
  await withServer(fakeClaudeBackgroundAgent, async ({ base, chat, waitForLog }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start it aside" }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text.startsWith("Delivered:")));

    // The main agent ended its turn and afterwards worked on BY ITSELF; the completion notice (`<task-notification>`, a run of
    // its own) names the agentId (for follow-up questions).
    const texts = log.filter((m) => m.role === "assistant").map((m) => m.text);
    assert.equal(texts.length, 2, `unexpected answers: ${JSON.stringify(texts)}`);
    assert.equal(texts[0], "Subagent running");
    assert.match(texts[1], /^Delivered: yes \| <task-notification> <task-id>a/);

    // The call block shows the REPORT at the end, no longer "status: running": the second tool_result with the same id overwrites
    // the first (live as in the reloaded history).
    const results = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text)).filter((r) => r.id === "toolu_bg_call");
    assert.equal(results.length, 2, "first \"running\", then the report");
    assert.match(results[0].result, /"status": "running"/);
    const final = JSON.parse(results[1].result);
    assert.equal(final.status, "completed");
    assert.match(final.report, /Background finding 42/);
  });
});

test("a FETCHED report also lands at its call block; otherwise \"running\" would stand there forever", async () => {
  await withServer(fakeClaudeCollectedAgent, async ({ base, chat, waitForLog, waitForIdle }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start and fetch" }) });
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Picked up itself"));
    await waitForIdle();
    const log = await json(`${base}/api/chats/${chat.id}/log`);

    // The main agent fetched the report itself; NO delivered turn follows.
    const texts = log.filter((m) => m.role === "assistant").map((m) => m.text);
    assert.deepEqual(texts, ["Picked up itself"], `unexpected answers: ${JSON.stringify(texts)}`);

    // The call block: first the placeholder, then the addendum. Without the second entry the agent bar shows the subagent as
    // "without result" with "-" tokens and "-" runtime, although its full report stands one line further.
    // Counter-test: with the old condition (`!info.delivered`) this block has exactly ONE entry, and it says "running"; the
    // test then fails here.
    const calls = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text)).filter((r) => r.id === "toolu_bg_call");
    assert.equal(calls.length, 2, "first \"running\", then the addendum");
    assert.match(calls[0].result, /"status": "running"/);
    const after = JSON.parse(calls[1].result);
    assert.equal(after.status, "completed");
    assert.ok(after.totalDurationMs > 0, "the runtime stands at the block");
    assert.ok(after.totalTokens > 0, `the tokens stand at the block: ${JSON.stringify(after)}`);

    // And WITHOUT the report text a second time: it already stands in the block of the pickup. The same 12 KB twice costs again at
    // every continuation of the chat.
    assert.match(after.report, /cbase_agent_output/);
    assert.doesNotMatch(after.report, /Background finding 42/);
    const pickup = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text)).find((r) => r.id === "toolu_out_call");
    assert.match(pickup.result, /Background finding 42/, "the full report stands at the pickup");
  });
});
