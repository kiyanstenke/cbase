// System prompt findings: what cbase sends to Claude Code, Codex and the loop engine on the wire. Where a finding already has a
// thematic guard, it lives there (each test's header names it).
//
// Finding 2  Subagents and workflow agents get the project focus and project memory of the main run — the same calculation
//            (runs/system-prompt.js projectFocus/projectMemory), for Claude, Codex and the loop engine, without the base block;
//            the focus names only tools from the run's offering (mcp/offering.js offeringOfTheEntry).
// Finding 3  The title oneshot runs sandboxed (runs/sandboxing.js — the same form as classification and extraction), and
//            `withoutTools` also works for Codex.
// Finding 4  Wait tools, to-do list and Task: the wording names only what is offered (Claude locks the CLI's wait tools, the
//            engine does not provide Task/Monitor/TaskStop/ScheduleWakeup).
// Finding 5  (guard gone) a turn of a special chat no longer starts (runs/manager-lock.js).
// Finding 6  Codex does not read the project memory itself (`-c project_doc_max_bytes=0` in every exec) — cbase's calculation is
//            the only source for all three providers.
// Finding 8  Fallback of the default model: Claude Sonnet 5.5, and NO server default copies it (curator, services scan and
//            compaction read providers/index.js DEFAULT_MODEL_FALLBACK or defaultModelFor).
//
// COUNTER-TESTS: see the header of each test.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/system-prompt-findings.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_MODEL_FALLBACK } from "../electron/server/providers/index.js";
import { CLAUDE_MODELS, CLAUDE_WAIT_LOCK, buildClaudeChatArgs, buildClaudeOnceArgs } from "../electron/server/providers/connectors/claude.js";
import { CODEX_WITHOUT_FILE_ACCESS, CODEX_WITHOUT_SELF_READ, buildCodexChatArgs, buildCodexOnceArgs } from "../electron/server/providers/connectors/codex.js";
import { AGENT_MODEL_DEFAULTS } from "../electron/server/settings/agent-models.js";
import { DIRS } from "../electron/server/app-state.js";
import { sandboxed } from "../electron/server/runs/sandboxing.js";
import { ENGINE_NOT_PROVIDED } from "../electron/server/providers/engine.js";
import { buildSystemPrompt, projectFocusPrompt } from "../electron/server/runs/system-prompt.js";
import { agentSpecFactory } from "../electron/server/runs/agents.js";
import { chatSkills } from "../electron/server/toolchain/skill-catalog.js";
import { offeringOfTheEntry } from "../electron/mcp/offering.js";
import * as store from "../electron/server/store.js";
import { TOOLS as MCP_TOOLS } from "../electron/mcp/catalog.js";
import { fakeClaude, fakeCodex, withAgentsServer } from "./agent-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "electron", "server");
const MCP = path.join(HERE, "..", "electron", "mcp");

function jsFiles(root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...jsFiles(p)); }
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── Finding 8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: providers/index.js DEFAULT_MODEL_FALLBACK.claude back to "claude-sonnet-5" ⇒ red (first claim); in
// settings/agent-models.js CURATOR_MODEL `|| "claude-sonnet-5"` again ⇒ red (copy found).
test("default model fallback: Claude falls back to Sonnet 5.5, and no server default copies a model name", () => {
  assert.equal(DEFAULT_MODEL_FALLBACK.claude, "claude-sonnet-5-5", "fallback of the default model (Claude)");
  assert.equal(DEFAULT_MODEL_FALLBACK.codex, "gpt-5.6-sol", "Codex keeps its default");
  assert.ok(CLAUDE_MODELS.some((m) => m.id === DEFAULT_MODEL_FALLBACK.claude), "the fallback is in the Claude catalog");
  if (!process.env.CURATOR_MODEL) assert.equal(AGENT_MODEL_DEFAULTS.curator, DEFAULT_MODEL_FALLBACK.claude, "curator without env = fallback");
  if (!process.env.SERVICES_SCAN_MODEL) assert.equal(AGENT_MODEL_DEFAULTS.services, DEFAULT_MODEL_FALLBACK.claude, "services scan without env = fallback");
  // No literal of a Sonnet model outside the catalog (connectors/claude.js) and the one table (providers/index.js); aliases of
  // the dynamic workflows (dynworkflows/model.js) are bound to /model (web/test/list-binding.test.mjs).
  const allowed = new Set([path.join(SERVER, "providers", "connectors", "claude.js"), path.join(SERVER, "providers", "index.js"), path.join(SERVER, "dynworkflows", "model.js")]);
  const findings = [];
  for (const file of [...jsFiles(SERVER), ...jsFiles(MCP)]) {
    if (allowed.has(file)) continue;
    fs.readFileSync(file, "utf8").split("\n").forEach((row, i) => {
      if (/["'`]claude-sonnet-5(-5)?["'`]/.test(row)) findings.push(`${path.relative(SERVER, file)}:${i + 1}: ${row.trim()}`);
    });
  }
  assert.deepEqual(findings, [], "Sonnet literal outside the catalog and the fallback table");
});

// ── Finding 6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Codex read AGENTS.md itself (git root up to cwd) IN ADDITION to cbase's project memory — measured at 0.162.1
// (on the wire): `-c project_doc_max_bytes=0` removes it, but only in the exec that carries it
// (a continuation without it adds it again). So: in EVERY exec, in the chat BEFORE `resume`, in the oneshot likewise.
// Counter-test: `...CODEX_WITHOUT_SELF_READ` removed from buildCodexChatArgs in connectors/codex.js ⇒ red (chat and
// continuation); removed from buildCodexOnceArgs ⇒ red (oneshot).
test("no Codex exec reads the project memory itself — chat, continuation (before resume) and oneshot", () => {
  assert.deepEqual([...CODEX_WITHOUT_SELF_READ], ["-c", "project_doc_max_bytes=0"]);
  const before = (argv, word) => { const i = argv.findIndex((a, j) => a === "-c" && argv[j + 1] === "project_doc_max_bytes=0"); return i >= 0 && (word == null || i < argv.indexOf(word)); };
  assert.ok(before(buildCodexChatArgs({ cwd: "/tmp", permissionMode: "default" })), "chat without the switch");
  const gone = buildCodexChatArgs({ cwd: "/tmp", permissionMode: "default", sessionId: "thread-1" });
  assert.ok(gone.includes("resume"), "continuation carries resume");
  assert.ok(before(gone, "resume"), "the switch comes before resume (exec flag)");
  assert.ok(before(buildCodexChatArgs({ cwd: "/tmp", permissionMode: "acceptEdits", codexWithoutFileAccess: true })), "outer loop without the switch");
  assert.ok(before(buildCodexOnceArgs({ prompt: "p", outFile: "/tmp/x.txt" })), "oneshot without the switch");
});

// ── Finding 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The title oneshot used to run as a full agent in the chat's working folder (a 44,000-character system prompt and catalog
// for a task of 370 characters); now it goes through the SAME sandboxing as classification and extraction
// (runs/sandboxing.js): empty cwd, no tools — and `withoutTools` also works for Codex.
// Counter-test: runs/post-run.js maybeAutoTitle with `cwd: resolveCwd(chat)` instead of the sandboxing spread ⇒ red (cwd and
// --tools); connectors/codex.js buildCodexOnceArgs without the line `if (withoutTools) …` ⇒ red (Codex).
test("the title oneshot runs sandboxed — empty cwd, no tools, no MCP servers", async () => {
  const oneshot = 'fs.writeFileSync(path.join(LOCATION, "title-oneshot.json"), JSON.stringify({ argv, cwd: process.cwd(), prompt })); respond("Rebuild checkout");';
  await withAgentsServer(async ({ base, ws, root, waitForTruthy }) => {
    const r = await fetch(`${base}/api/chats`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    const chat = await r.json();
    await fetch(`${base}/api/chats/${chat.id}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Please rebuild the checkout." }) });
    const file = path.join(root, "title-oneshot.json");
    await waitForTruthy(() => fs.existsSync(file), "title oneshot started");
    const { argv, cwd, prompt } = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(prompt, /Titel \(3-6 Wörter\)/, "it is the title oneshot");
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(DIRS.empty), "cwd is the empty folder, not the workspace");
    assert.ok(argv.includes("--tools") && argv[argv.indexOf("--tools") + 1] === "", "--tools \"\" (no built-ins)");
    assert.ok(argv.includes("--strict-mcp-config"), "strict, empty MCP configuration");
    assert.equal(argv[argv.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    await waitForTruthy(async () => (await (await fetch(`${base}/api/chats/${chat.id}`)).json()).title === "Rebuild checkout", "title set");
  }, { claude: fakeClaude({ oneshot }) });
});

test("`withoutTools` also cuts a Codex oneshot (the same switches as an outer loop without choice)", () => {
  const followUp = (list, f) => list.some((_, i) => f.every((x, j) => list[i + j] === x));
  assert.ok(followUp(buildCodexOnceArgs({ prompt: "p", outFile: "/tmp/x.txt", withoutTools: true }), CODEX_WITHOUT_FILE_ACCESS), "sandboxed ⇒ CODEX_WITHOUT_FILE_ACCESS");
  assert.equal(buildCodexOnceArgs({ prompt: "p", outFile: "/tmp/x.txt" }).includes("shell_tool"), false, "without the switch the oneshot stays as it was");
  assert.deepEqual(Object.keys(sandboxed()).sort(), ["cwd", "withoutTools"]);
});

// ── Finding 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The base rule forbade the built-in wait tools (`Monitor`/`TaskStop`, `ScheduleWakeup`, `CronCreate`), yet they were offered —
// Claude got ScheduleWakeup up front and the three cron tools deferred, the engine got Monitor, TaskStop, ScheduleWakeup and
// `Task` (a double of cbase_agent). The to-do section named TaskCreate/TaskUpdate (Claude does provide them — the sentence
// names them per provider, system-prompt-proofread.test.js). The OFFERING side was wrong: Claude locks the wait tools in every
// run (CLAUDE_WAIT_LOCK; TaskStop stays for its own background commands), the engine no longer provides the four
// (ENGINE_NOT_PROVIDED, guard on offering and execution in engine-harness.test.js), and the description says what the
// execution has — nothing about tools that do not exist.
// Counter-test: connectors/claude.js lock list (line 158) without `...CLAUDE_WAIT_LOCK` ⇒ red (first claim); runs/system-prompt.js
// with the old sentence "do NOT take the built-in equivalents …" or "(TaskCreate/TaskUpdate)" ⇒ red (second).
test("Claude chats, subagents and oneshots lock the CLI wait tools; TaskStop stays", () => {
  assert.deepEqual([...CLAUDE_WAIT_LOCK], ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "Monitor"]);
  const spec = { cwd: "/tmp", input: "los", systemPrompt: "sys", addDirs: [], permissionMode: "default", mcpConfigPath: "/tmp/x.mcp.json",
    allowedTools: ["mcp__cbase"], permissionPromptTool: false, model: "", effort: "", sessionId: "", forkPending: false };
  const locked = (args) => String(args[args.indexOf("--disallowedTools") + 1] || "").split(",");
  for (const [who, args] of [
    ["chat", buildClaudeChatArgs({ ...spec, disallowedTools: ["Skill"] })],
    ["subagent", buildClaudeChatArgs({ ...spec, disallowedTools: ["Agent", "Task", "Skill"] })],
    ["without own list", buildClaudeChatArgs(spec)],
    ["oneshot", buildClaudeOnceArgs({})],
  ]) {
    for (const n of CLAUDE_WAIT_LOCK) assert.ok(locked(args).includes(n), `${who}: ${n} is not locked (${locked(args)})`);
    assert.ok(!locked(args).includes("TaskStop"), `${who}: TaskStop locked — it ends its own background commands`);
  }
});

test("base rule and monitor/wakeup descriptions name no tool that no provider offers", () => {
  const reason = buildSystemPrompt("");
  const mcp = (n) => MCP_TOOLS.find((t) => t.name === n)?.description || "";
  const texts = { BaseRule: reason, cbase_monitor: mcp("cbase_monitor"), cbase_wakeup: mcp("cbase_wakeup") };
  assert.ok(texts.cbase_monitor && texts.cbase_wakeup, "the descriptions exist");
  const notProvided = new Set([...CLAUDE_WAIT_LOCK, ...ENGINE_NOT_PROVIDED]); // Claude provides Task*: system-prompt-proofread.test.js
  // Compound names (ScheduleWakeup, CronCreate, TaskStop …) count as a whole word; "Monitor" and "Task" are also ordinary words
  // ("the user sees monitor and wakeup") and count only as a tool name in backticks.
  for (const [where, text] of Object.entries(texts)) {
    for (const n of notProvided) {
      const pattern = /^[A-Z][a-z]+[A-Z]/.test(n) ? new RegExp(`\\b${n}\\b`) : new RegExp(`\`${n}\``);
      assert.doesNotMatch(text, pattern, `${where} nennt ${n}`);
    }
  }
  // What remains: the two cbase tools of the wait rule and cbase_agent as the only way to a subagent. `run_in_background` is no
  // way any more — the base rule names the ban (mcp/detach-rule.js).
  assert.match(reason, /two tools in the run/);
  assert.match(reason, /`cbase_monitor`/);
  assert.match(reason, /`cbase_wakeup`/);
  assert.doesNotMatch(reason, /run_in_background` (is )?(still )?(fine|ok|okay|allowed)/i);
  // Provider-neutral: "a shell command in the background" instead of "Bash with run_in_background".
  assert.match(reason, /A shell command in the background \(such as run_in_background\) and any detaching .* are forbidden in cbase/);
  assert.match(reason, /ONLY way to a subagent/);
});

// ── Finding 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A subagent or workflow agent used to carry only its role (measured ≈ 1,000 characters): it did not know which project it
// works in and did not know its CLAUDE.md/AGENTS.md — since finding 6 Codex no longer reads them itself either. Now
// runs/agents.js buildAgentSpec calculates both blocks with the SAME calculation as the main run (system-prompt.js
// projectFocus, projectMemory) — for every provider, without the base block, never for an outer-loop run. The focus names only
// tools the agent's cbase server offers.
// Counter-test: runs/agents.js with `projectParts = []` ⇒ red (first claim: no block for subagent, Codex, engine, workflow
// agent); with `tools: null` instead of the offering ⇒ red (the narrow subagent reads cbase_vars_list/get);
// system-prompt.js copyToolRow with the old fixed sentence ⇒ red (the workflow agent in the copy reads fetch, clean up,
// switch).
const B2_MAIN = `
  if (text.includes("B2-START")) {
    fs.writeFileSync(path.join(LOCATION, "b2-main-sp"), arg("--append-system-prompt"));
    const jobs = [
      { description: "full", prompt: "SUB-FULL", run_in_background: false },
      { description: "narrow", prompt: "SUB-NARROW", tools: ["Read", "cbase_projects_list"], run_in_background: false },
      { description: "codex", prompt: "SUB-CODEX", model: "codex::gpt-5.6-sol", run_in_background: false },
      { description: "engine", prompt: "SUB-ENGINE", model: "openrouter::m1", run_in_background: false },
    ];
    for (const [i, a] of jobs.entries()) {
      const id = "toolu_b2_" + i;
      say({ type: "assistant", message: { id: "b2-" + i, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input: a }] } });
      let r = "";
      try { r = textOf(await mcpCall("cbase_agent", a)); } catch (e) { r = "ERROR " + e.message; }
      fs.writeFileSync(path.join(LOCATION, "b2-report-" + i), r);
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: r }] } });
    }
  }
  say({ type: "assistant", message: { id: "b2-end-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "b2-main" });`;
const B2_SUB = `
  const marker = ["SUB-FULL", "SUB-NARROW", "WF-AGENT"].find((m) => text.includes(m)) || "other";
  fs.writeFileSync(path.join(LOCATION, "b2-sub-sp-" + marker), arg("--append-system-prompt"));
  fs.writeFileSync(path.join(LOCATION, "b2-sub-env-" + marker), JSON.stringify(JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase.env || {}));
  say({ type: "assistant", message: { id: "s-" + marker, content: [{ type: "text", text: "Finding 42" }] } });
  finished();
  say({ type: "result", result: "Finding 42", session_id: "sub-" + marker });`;
const B2_CODEX = fakeCodex({ text: "Codex finding 42" })
  .replace("const say =", "fs.appendFileSync(path.join(LOCATION, \"b2-codex-argv.jsonl\"), JSON.stringify(process.argv.slice(2)) + \"\\n\");\nconst say =");

// A section of the system prompt: from its heading up to the next first-level heading.
function section(text, header) {
  const i = String(text).indexOf(header);
  if (i < 0) return "";
  const j = text.indexOf("\n\n# ", i + header.length);
  return j < 0 ? text.slice(i) : text.slice(i, j);
}
const BASE_BLOCK = "This chat runs in the cbase app.";

test("subagents (Claude, Codex, engine) and workflow agents carry the main run's project focus and memory, without base block — a cut in the sentence cuts the tool sentences too, an outer-loop run gets nothing", async () => {
  await withAgentsServer(async ({ base, ws, root, waitForTruthy, waitForIdle, engine }) => {
    const json = async (url, opts = {}) => (await fetch(url, { ...opts, headers: { "Content-Type": "application/json", Connection: "close" } })).json();
    fs.writeFileSync(path.join(ws.path, "CLAUDE.md"), "Workspace rule: WS-KIWI-11\n");
    const projPath = path.join(ws.path, "till");
    const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: projPath }) });
    fs.mkdirSync(projPath, { recursive: true });
    fs.writeFileSync(path.join(projPath, "AGENTS.md"), "Project rule: PROJ-MANGO-44\n");
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
      workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
    }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Till project" }) });
    // The user's instructions: one section per scope in the workspace, one in the project, one switched off and one the project
    // deselects.
    const section_ = async (projectId, title, text, scope, on = true) => (await json(`${base}/api/workspaces/${ws.id}/instructions`, {
      method: "POST", body: JSON.stringify({ projectId, title, text, scope, enabled: on }) })).section;
    await section_(null, "For all", "AW-ALL-11", "all");
    await section_(null, "Persona", "AW-MAIN-12", "main");
    await section_(null, "Subagents", "AW-SUB-13", "sub");
    await section_(null, "Off", "AW-AUS-14", "all", false);
    const deselected = await section_(null, "Deselected", "AW-DESELECTED-15", "all");
    await json(`${base}/api/workspaces/${ws.id}/instructions/${deselected.id}/takeover`, { method: "PUT", body: JSON.stringify({ projectId: project.id, takenOver: false }) });
    await section_(project.id, "Project", "AW-PROJ-21", "all");

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "B2-START" }) });
    await waitForTruthy(() => fs.existsSync(path.join(root, "b2-report-3")), "four subagents reported");
    await waitForIdle();
    const read = (n) => fs.readFileSync(path.join(root, n), "utf8");
    for (const i of [0, 1, 2, 3]) assert.doesNotMatch(read(`b2-report-${i}`), /^ERROR |"status": ?"failed"/, `subagent ${i}: ${read(`b2-report-${i}`).slice(0, 300)}`);

    // The main run: base block, focus, memory.
    const main = read("b2-main-sp");
    const focus = section(main, "# Project focus"), memory = section(main, "# Project memory");
    assert.ok(main.includes(BASE_BLOCK) && focus.includes("\"Till\"") && memory.includes("PROJ-MANGO-44"),
      `the main run carries all three: ${main.slice(-900)}`);
    // Nobody reads the CLAUDE.md of the workspace folder any more — counter-test against the old state: there it was in here.
    assert.ok(!main.includes("WS-KIWI-11"), "the workspace file is no longer in the prompt");
    // The instructions in the main run: all + main, workspace before project; not sub, not off, not deselected.
    const instructionsMain = section(main, "# User instructions");
    assert.ok(["AW-ALL-11", "AW-MAIN-12", "AW-PROJ-21"].every((x) => instructionsMain.includes(x)), `main run: ${instructionsMain}`);
    assert.ok(["AW-SUB-13", "AW-AUS-14", "AW-DESELECTED-15"].every((x) => !main.includes(x)), `main run carries foreign content: ${instructionsMain}`);
    assert.ok(instructionsMain.indexOf("AW-ALL-11") < instructionsMain.indexOf("AW-PROJ-21"), "workspace before project");
    assert.ok(main.indexOf("# User instructions") < main.indexOf(BASE_BLOCK), "in front, where the persona used to be");
    assert.match(focus, /cbase_vars_list\/get/, "the main run's focus names its tools (today's wording)");

    // The subagents: the same focus and memory (character for character), no base block.
    const codexArgv = fs.readFileSync(path.join(root, "b2-codex-argv.jsonl"), "utf8").trim().split("\n").map((z) => JSON.parse(z));
    const codexPrompt = codexArgv.map((a) => a.join("\n")).find((a) => a.includes("SUB-CODEX")) || "";
    const engineRequest = engine.requests.find((b) => JSON.stringify(b.messages || []).includes("SUB-ENGINE"));
    const systemOf = (b) => (b?.messages || []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((t) => t.text || "").join(""))).join("\n");
    const agents = { "Claude subagent": read("b2-sub-sp-SUB-FULL"), "Codex subagent": codexPrompt, "Engine subagent": systemOf(engineRequest) };
    for (const [who, sp] of Object.entries(agents)) {
      assert.ok(sp, `${who}: no prompt recorded`);
      assert.ok(sp.includes(focus), `${who}: the main run's project focus is missing`);
      assert.ok(sp.includes(memory), `${who}: the main run's project memory is missing`);
      assert.ok(!sp.includes(BASE_BLOCK), `${who}: the base block belongs to the main run`);
      assert.ok(sp.indexOf(focus) > sp.indexOf("# Your role in this run") && sp.indexOf(memory) > sp.indexOf(focus),
        `${who}: order as in the main run — after the role, focus before memory`);
      // The instructions: all + sub, not main — before the focus. Counter-test without the wiring in runs/agents.js: red.
      assert.ok(["AW-ALL-11", "AW-SUB-13", "AW-PROJ-21"].every((x) => sp.includes(x)), `${who}: instructions missing`);
      assert.ok(["AW-MAIN-12", "AW-AUS-14", "AW-DESELECTED-15"].every((x) => !sp.includes(x)), `${who}: carries foreign content`);
      assert.ok(sp.indexOf("# User instructions") < sp.indexOf(focus), `${who}: instructions before the focus`);
    }

    // A subagent with a tool list (only Read and cbase_projects_list): focus and memory yes, but no sentence about tools its
    // server does not offer.
    const narrow = read("b2-sub-sp-SUB-NARROW");
    const narrowFocus = section(narrow, "# Project focus");
    const narrowOffering = new Set(offeringOfTheEntry({ env: JSON.parse(read("b2-sub-env-SUB-NARROW")) }));
    assert.ok(!narrowOffering.has("cbase_vars_list") && narrowOffering.has("cbase_projects_list"), `offering: ${[...narrowOffering]}`);
    assert.ok(narrowFocus.includes(`Project folder: ${projPath}`) && narrow.includes(memory), narrow.slice(-900));
    assert.doesNotMatch(narrowFocus, /cbase_/, `the narrow subagent reads about tools it does not have:\n${narrowFocus}`);

    // A workflow agent (own core, own marker) — the same focus, the same memory.
    const script = "export const meta = { name: 'b2', description: 'Finding 2', phases: [{ title: 'Read' }] }\nreturn await agent('WF-AGENT {TAG:w}');\n";
    // Without Ultracode mode the run waits for a card; a model without levels does not carry the mode (chats/ultracode.js).
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const r = await json(`${base}/api/chats/${chat.id}/dyn-workflows/run`, { method: "POST", body: JSON.stringify({ script }) });
    assert.equal(r.status, "started", JSON.stringify(r));
    await waitForTruthy(() => store.readDynRun(r.runId)?.status !== "running", "workflow run finished");
    assert.equal(store.readDynRun(r.runId).status, "finished", store.readDynRun(r.runId).error);
    const wf = read("b2-sub-sp-WF-AGENT");
    assert.ok(wf.includes("WORKFLOW AGENT of cbase") && wf.includes(focus) && wf.includes(memory) && !wf.includes(BASE_BLOCK),
      `workflow agent: ${wf.slice(-900)}`);
    assert.ok(["AW-ALL-11", "AW-SUB-13", "AW-PROJ-21"].every((x) => wf.includes(x)) && !wf.includes("AW-MAIN-12"), `workflow agent, instructions: ${wf.slice(0, 900)}`);

    // An outer-loop run gets neither (it observes chats and runs sandboxed) — the same factory, only with a marker.
    const row = store.getChat(chat.id);
    const context = {
      chat: row, provider: "claude",
      profile: { permissionMode: "bypassPermissions", addDirs: [], builtinTools: null },
      tools: { toolset: "", cbase: null, extraServers: [], extern: [], mcpAllow: [], skills: chatSkills(row) },
      depth: 1,
    };
    const o = { agentId: "b2-factory", systemPrompt: "Role", input: "x", provider: "claude", model: "claude-haiku-4-5-20251001",
      cwd: ws.path, tools: null, skills: [], sessionId: null, transcript: [], inheritContext: false };
    const sub = await agentSpecFactory(context)(o);
    const ol = await agentSpecFactory(context, { outerLoop: { agentId: "b2-ol", runId: "b2-run" } })({ ...o, agentId: "b2-ol-agent" });
    assert.ok(sub.systemPrompt.includes(memory), "the factory without marker: with memory");
    assert.ok(!ol.systemPrompt.includes("# Project memory") && !ol.systemPrompt.includes("# Project focus"), `Outer Loop: ${ol.systemPrompt.slice(0, 400)}`);
    assert.ok(sub.systemPrompt.includes("AW-SUB-13") && !ol.systemPrompt.includes("# User instructions"), "outer loop without instructions");
    await waitForIdle();
  }, { claude: fakeClaude({ main: B2_MAIN, sub: B2_SUB }), codex: B2_CODEX, engine: true });
});

test("the focus names only tools from the run's offering — workflow agent and subagent in a copy, lists; the main run as before", () => {
  const proj = { id: "p", name: "Till", path: "/ws/till" };
  const copy = { name: "k1" };
  const IDENTIFIER = "p/copy-k1";
  const cases = {
    "Workflow agent in the copy": { CBASE_WORKFLOW_AGENT: "a1", CBASE_INSTANCE: IDENTIFIER },
    "Subagent in the copy": { CBASE_AGENT_DEPTH: "1", CBASE_INSTANCE: IDENTIFIER },
    "Subagent with an empty cbase list": { CBASE_AGENT_DEPTH: "1", CBASE_INSTANCE: IDENTIFIER, CBASE_TOOLS: JSON.stringify(["cbase_projects_list"]) },
    "Subagent with half a list": { CBASE_AGENT_DEPTH: "2", CBASE_INSTANCE: IDENTIFIER, CBASE_TOOLS: JSON.stringify(["cbase_vars_get", "cbase_copy_stack_fetch", "cbase_artifacts_read"]) },
  };
  const texts = {};
  for (const [who, env] of Object.entries(cases)) {
    const offering = new Set(offeringOfTheEntry({ env }));
    const text = projectFocusPrompt(proj, { converted: true, copy, tools: offering });
    texts[who] = text;
    for (const n of text.match(/cbase_[a-z0-9_]+/g) || []) assert.ok(offering.has(n), `${who}: the focus names ${n}, the offering does not have it`);
    if (text.includes("cbase_vars_list/get")) assert.ok(offering.has("cbase_vars_list") && offering.has("cbase_vars_get"), who);
    if (text.includes("cbase_*-Tools")) assert.ok([...offering].some((n) => /^cbase_(context|ports)_/.test(n)), who);
    assert.match(text, /# Your copy/, `${who}: the copy paragraph stays (state, branch space, real targets)`);
  }
  assert.match(texts["Workflow agent in the copy"], /are done by the chat, not by you/);
  // No excess cutting: a subagent without a list has everything — its focus is word for word the main run's.
  assert.equal(texts["Subagent in the copy"], projectFocusPrompt(proj, { converted: true, copy }));
  assert.match(texts["Subagent with half a list"], /cbase_vars_get returns/);
  assert.match(texts["Subagent with half a list"], /Fetch: cbase_copy_stack_fetch/);
});
