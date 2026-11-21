// Guards for the prompt construction of the coding chats. One promise per finding — description side (system prompt, tool
// description) = execution side (offering, route, CLI flags):
//
//   (1)  Tools with a run binding — cbase_permission_prompt only where the CLI calls it (mcp/visibility.js ONLY_WITH_RUN_BINDING,
//        offering.js, toolchain/mcp-config.js); cbase_context_route is gone.
//   (2)  No workflow agent reads "write … with cbase_agent_send to "main"" — it does not have the tool.
//   (3)  cbase_service_start no longer recommends starting from the shell yourself.
//   (4)  cbase_ports_list does not say "machine-wide … conflict" in the project container (the focus says: no conflict).
//   (5)  ONE sentence about the scope of the credentials (mcp/credentials-set.js) — true against the store's route computation.
//   (6)  The base block does not call cbase_projects_list "across all workspaces".
//   (7)  Every model example `provider::model` in a tool description stands in the catalog of its provider.
//   (8)  ONE place per statement in the base block (detach ban, `skills`, service_add → service_start); DETACH_RULE provider-neutral.
//   (9)  cbase_skill refers to "Available skills" only when the run has a catalog — and the title is the catalog's.
//   (10) Without project focus: the read rule names projectId, the message the way; no schema text speaks of "global agents".
//   (11) The agenda block claims no authorship ("you wrote it yourself").
//   (13) The Claude CLI locks EnterWorktree, ExitWorktree, ReportFindings in every run; TaskStop stays (stop_task).
//
// COUNTER-TESTS: each test's "Counter-test:" comment names the sabotage that turns it red.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/prompt-audit.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { SET_PORTS_IN_PROJECT, buildSystemPrompt, projectFocusPrompt, subagentChoicePrompt } from "../electron/server/runs/system-prompt.js";
import { agendaFence } from "../electron/server/runs/agenda-block.js";
import { agentToolset } from "../electron/server/runs/agent-set.js";
import { approvalOverMcp, writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import * as airlockTexts from "../electron/server/toolchain/airlock-texts.js";
import { skillCatalog } from "../electron/server/toolchain/skill-catalog.js";
import { PROVIDERS } from "../electron/server/providers/index.js";
import { CLAUDE_MODELS, buildClaudeChatArgs } from "../electron/server/providers/connectors/claude.js";
import { CODEX_MODELS } from "../electron/server/providers/connectors/codex.js";
import { offeringNames } from "../electron/mcp/offering.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { DETACH_RULE } from "../electron/mcp/detach-rule.js";
import { MONITOR_RULE } from "../electron/mcp/monitor-rule.js";
import { CREDENTIALS_AREA, CREDENTIALS_IN_PROJECT } from "../electron/mcp/credentials-set.js";
import { NO_PROJECT } from "../electron/mcp/lib.js";
import { SKILL_CATALOG_TITLE } from "../electron/mcp/tools/app.js";
import { PORTS_LIST_IN_PROJECT, PORTS_LIST_IN_B } from "../electron/mcp/tools/services.js";
import { APPROVAL_TOOL, ONLY_WITH_RUN_BINDING, lockedForWorkflowAgent } from "../electron/mcp/visibility.js";
import { makeChat, makeProject, makeWorkspace, withMcp, withServer } from "./server-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// An environment without any marker — the test process might otherwise inherit CBASE_* of a surrounding session.
const WITHOUT_MARKERS = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("CBASE_") && k !== "CBASE_EMBED_OFFLINE").map((k) => [k, undefined]));
const REASON = buildSystemPrompt("", { agenda: true, watch: true });
const count = (text, part) => text.split(part).length - 1;

/** tools/list of the real MCP server with this environment (without a backend: tools/list asks for none). */
async function list(env) {
  let tools = [];
  await withMcp({ ...WITHOUT_MARKERS, CBASE_BASE_URL: "http://127.0.0.1:9", ...env }, async ({ rpc }) => { tools = (await rpc("tools/list", {})).result?.tools || []; });
  return tools;
}

// ── (1) Run binding ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: offering.js without the filter lockedForRunBinding => red ("full coding catalog without …").
test("(1) tools with a run binding: the full coding catalog, an explicit list and a subagent do not offer them — only their run", () => {
  assert.deepEqual([...ONLY_WITH_RUN_BINDING], [APPROVAL_TOOL], "the run binding: approval");
  assert.ok(!CATALOG_NAMES.includes("cbase_context_route"), "cbase_context_route is gone");

  const full = offeringNames({});
  for (const n of ONLY_WITH_RUN_BINDING) assert.ok(!full.includes(n), `full coding catalog without ${n}`);
  const explicit = offeringNames({ CBASE_TOOLS: JSON.stringify(CATALOG_NAMES) });
  for (const n of ONLY_WITH_RUN_BINDING) assert.ok(!explicit.includes(n), `explicit list without a marker without ${n}`);
  // Their run has them.
  assert.ok(offeringNames({ CBASE_APPROVAL: "1" }).includes(APPROVAL_TOOL), "approval marker: cbase_permission_prompt");
  // A subagent from depth 2 carries the spelled-out list (agent-set.js FULL_SET) — without the bound names.
  const grandchild = agentToolset({ parent: { cbase: null, builtin: null }, depth: 2 });
  for (const n of ONLY_WITH_RUN_BINDING) assert.ok(!(grandchild.cbase || []).includes(n), `grandchild's list without ${n}`);
});

// Counter-test: approvalOverMcp without `caps.ownsAgentLoop` => red (the engine would get the marker).
test("(1) the approval marker follows the CLI flag: only Claude outside bypassPermissions", () => {
  assert.equal(approvalOverMcp(PROVIDERS.claude.caps, "default"), true);
  assert.equal(approvalOverMcp(PROVIDERS.claude.caps, "acceptEdits"), true);
  assert.equal(approvalOverMcp(PROVIDERS.claude.caps, "bypassPermissions"), false);
  assert.equal(approvalOverMcp(PROVIDERS.codex.caps, "default"), false, "Codex never asks");
  for (const [id, p] of Object.entries(PROVIDERS)) if (!p.caps.ownsAgentLoop) assert.equal(approvalOverMcp(p.caps, "default"), false, `${id}: the engine asks in its own process`);
});

// Counter-test: mcp-config.js writes the marker CBASE_CONTEXT_AGENT again for an old chat of the kind "context" => red
// ("old context chat without marker").
test("(1)(2) writeMcpConfig: approval marker, none of the context agent any more; \"main\" only where cbase_agent_send is offered", async () => {
  await withServer(async ({ base, wsPath, root }) => {
    const ws = await makeWorkspace(base, "Audit", wsPath);
    const coding = await makeChat(base, ws.id);
    const t = Date.now();
    const context = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "context", permissionMode: "bypassPermissions", createdAt: t, updatedAt: t });
    const env = (cfg) => writeMcpConfig(path.join(root, `audit-${crypto.randomUUID()}.mcp.json`), cfg).servers.cbase.env;

    const c = env({ chatId: coding.id, workspaceId: ws.id });
    assert.equal(c.CBASE_APPROVAL, undefined, "without `approval` no approval marker");
    assert.ok(!offeringNames(c).includes(APPROVAL_TOOL));
    const k = env({ chatId: context.id, workspaceId: ws.id });
    assert.equal(k.CBASE_CONTEXT_AGENT, undefined, "old context chat without marker");
    assert.equal(env({ chatId: coding.id, workspaceId: ws.id, approval: true }).CBASE_APPROVAL, "1");

    // (2) The address "main": a coding server that subagents do not inherit.
    const server = [{ id: "s-audit", name: "fake", transport: "stdio", command: process.execPath, args: [], subagentsInherit: false, choice: null }];
    const sub = env({ chatId: coding.id, workspaceId: ws.id, extraServers: server, agentDepth: 1, profileKey: `${coding.id}-agent-a1`, agentId: "a1" });
    assert.equal(sub.CBASE_MAIN_ADDRESS, "1", "subagent at depth 1: has cbase_agent_send, so the address");
    assert.ok(offeringNames(sub).includes("cbase_agent_send"));
    // Counter-test: mcp-config.js again with `(workflowAgent || agentDepth > 0 || profileKey)` => red.
    const wf = env({ chatId: coding.id, workspaceId: ws.id, extraServers: server, agentDepth: 1, workflowAgent: "w1", agentId: "w1" });
    assert.equal(wf.CBASE_MAIN_ADDRESS, undefined, "workflow agent: no cbase_agent_send, so no address");
    assert.ok(!offeringNames(wf).includes("cbase_agent_send"));
    const limit = env({ chatId: coding.id, workspaceId: ws.id, extraServers: server, agentDepth: 3, profileKey: `${coding.id}-agent-a3`, agentId: "a3" });
    assert.equal(limit.CBASE_MAIN_ADDRESS, undefined, "depth 3: no cbase_agent_send, so no address");
  });
});

// Counter-test: airlock-texts.js workflowMarker with the old sentence => red.
test("(2) the airlock's refusal to a workflow agent names no tool it does not have", () => {
  assert.equal(lockedForWorkflowAgent("cbase_agent_send"), true, "precondition: a workflow agent does not have cbase_agent_send");
  assert.doesNotMatch(airlockTexts.workflowMarker(), /cbase_agent_send/);
  assert.doesNotMatch(airlockTexts.onlyMain("fake", "workflow"), /cbase_agent_send/);
  assert.match(airlockTexts.onlyMain("fake", "subagent"), /cbase_agent_send an „main“/, "a subagent keeps the way");
});

// ── (3) (4) Services and ports ─────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: the old description of cbase_service_start => red; services.js with the old ports_list description => red.
test("(3)(4) cbase_service_start does not send to the shell; cbase_ports_list fits the project container and B", async () => {
  const inB = await list({});
  const start = inB.find((t) => t.name === "cbase_service_start").description;
  assert.doesNotMatch(start, /yourself via Bash|start via Bash/);
  assert.match(start, /cbase_service_update \(startCommand\) and then start again/);
  assert.equal(inB.find((t) => t.name === "cbase_ports_list").description, PORTS_LIST_IN_B);
  const inProject = await list({ CBASE_INSTANCE: "0123456789abcdef0123456789abcdef/main" });
  const p = inProject.find((t) => t.name === "cbase_ports_list").description;
  assert.equal(p, PORTS_LIST_IN_PROJECT);
  for (const d of [PORTS_LIST_IN_B, PORTS_LIST_IN_PROJECT]) assert.doesNotMatch(d, /machine-wide/i);
  // The focus of a project in its own container and the description say the same.
  assert.match(SET_PORTS_IN_PROJECT, /the same port of another project is no conflict/);
  assert.match(p, /the same port of another project is no conflict/);
});

// ── (5) Credentials ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: system-prompt.js VARS_REST with "(not those of the workspace)" => red; workspace.js with "otherwise those of the
// workspace." => red.
test("(5) ONE sentence about the credentials in base block, focus and both tools — and it matches the routes' computation", async () => {
  const tools = await list({});
  const d = (n) => tools.find((t) => t.name === n).description;
  assert.ok(REASON.includes(CREDENTIALS_AREA), "base block");
  assert.ok(d("cbase_vars_list").includes(CREDENTIALS_AREA), "cbase_vars_list");
  assert.ok(d("cbase_vars_get").includes(CREDENTIALS_AREA), "cbase_vars_get");
  const focus = projectFocusPrompt({ id: "p1", name: "Till", path: "/x/till" });
  assert.ok(focus.includes(CREDENTIALS_IN_PROJECT), "project focus");
  for (const [where, text] of [["base block", REASON], ["focus", focus], ["vars_list", d("cbase_vars_list")], ["vars_get", d("cbase_vars_get")]]) {
    assert.doesNotMatch(text, /not those of the workspace|otherwise those of the workspace\.|otherwise from those of the workspace/i, `${where}: no old sentence`);
  }
  // The computation the sentence describes (projects/routes.js and toolchain/routes.js with ?mcp=1).
  await withServer(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Vars", wsPath);
    fs.mkdirSync(path.join(wsPath, "till"), { recursive: true });
    const proj = await makeProject(base, ws.id, path.join(wsPath, "till"));
    const wv = store.createVar(ws.id, { key: "WS_A", kind: "variable", value: "w", description: "", mcpAccess: true });
    store.createVar(ws.id, { key: "WS_B", kind: "variable", value: "w", description: "", mcpAccess: true });
    store.createVar(ws.id, { key: "EQUAL", kind: "variable", value: "ws", description: "", mcpAccess: true });
    store.createProjectVar(proj.id, { key: "P_A", kind: "variable", value: "p", description: "", mcpAccess: true });
    store.createProjectVar(proj.id, { key: "EQUAL", kind: "variable", value: "proj", description: "", mcpAccess: true });
    store.setWorkspaceVarAvailable(proj.id, wv.id, false);
    const inProject = new Map(store.effectiveProjectVars(proj.id, ws.id).map((v) => [v.key, v]));
    assert.deepEqual([...inProject.keys()].sort(), ["EQUAL", "P_A", "WS_B"], "project focus: own + the workspace's that are not hidden");
    assert.equal(inProject.get("EQUAL").value, "proj", "with the same key the project's wins");
    const without = new Map(store.effectiveWorkspaceVars(ws.id).map((v) => [v.key, v]));
    assert.deepEqual([...without.keys()].sort(), ["EQUAL", "P_A", "WS_A", "WS_B"], "without focus: workspace + all projects");
    assert.equal(without.get("EQUAL").value, "ws", "with the same key the workspace's wins");
  });
});

// ── (6) (8) (10) Base block ───────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: system-prompt.js with "project list across all workspaces" => red; with `skills` in the section on handing off
// work => red; detach-rule.js with the old sentence => red; monitor-rule.js again with "run_in_background" => red.
test("(6)(8)(10) base block: projects of this workspace, one place per statement, provider-neutral detach ban, projectId without focus", async () => {
  assert.doesNotMatch(REASON, /(?:across|over) all workspaces/i);
  assert.match(REASON, /The projects of this workspace: cbase_projects_list/);
  const projects = (await list({})).find((t) => t.name === "cbase_projects_list").description;
  assert.doesNotMatch(projects, /global agents/i);

  // The detach ban exactly once (in DETACH_RULE), the monitor sentence does not repeat it.
  assert.equal(count(REASON, "run_in_background"), 1, "run_in_background exactly once in the base block");
  assert.equal(count(REASON, DETACH_RULE), 1);
  assert.doesNotMatch(MONITOR_RULE, /run_in_background|nohup|detach/);
  // Provider-neutral and with separate ways.
  assert.doesNotMatch(DETACH_RULE, /Bash with run_in_background|where cbase runs the shell/);
  assert.match(DETACH_RULE, /A service that should keep running you start with cbase_service_start; a command with an end .* as cbase_monitor\./);
  // service_add → service_start in ONE place.
  assert.equal(count(REASON, "cbase_service_add"), 1, "cbase_service_add once");
  assert.match(REASON, /cbase_service_add \(port and startCommand\) and then cbase_service_start/);
  // `skills` of the subagent: only in the subagent-choice section (it stands where the base block stands: both only without toolset).
  const choice = subagentChoicePrompt([], []);
  assert.equal(count(`${REASON}\n${choice}`, "With `skills`"), 1, "\"With `skills`\" once in base block + subagent choice");

  // (10) Without project focus.
  assert.match(REASON, /cbase_context_list with your QUESTION in `search` .*, in a chat without project focus `projectId` from cbase_projects_list; `q` only/);
  assert.match(NO_PROJECT, /projectId/);
  assert.match(NO_PROJECT, /cbase_projects_list/);
});

// Counter-test: lib.js with the old message => red; a schema text "for global agents" back => red.
test("(10) cbase_context_list without a project answers with the way via projectId; no tool speaks of global agents", async () => {
  const all = await list({ CBASE_TOOLS: JSON.stringify(CATALOG_NAMES), CBASE_APPROVAL: "1", CBASE_SKILLS: JSON.stringify(["x"]), CBASE_INSTANCE: "0123456789abcdef0123456789abcdef/main" });
  for (const t of all) assert.doesNotMatch(JSON.stringify(t), /global agents?\b/i, `${t.name}: no global agents`);
  await withMcp({ ...WITHOUT_MARKERS, CBASE_BASE_URL: "http://127.0.0.1:9" }, async ({ call }) => {
    const r = await call("cbase_context_list", { search: "Till" });
    assert.equal(r.isError, true);
    assert.match(r.text, new RegExp(NO_PROJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

// ── (7) Model examples ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: agents.js again with "codex::gpt-5.1-codex" => red.
test("(7) every model example provider::model in a tool description stands in its provider's catalog", async () => {
  const catalog = { claude: new Set(CLAUDE_MODELS.map((m) => m.id)), codex: new Set(CODEX_MODELS.map((m) => m.id)) };
  const text = JSON.stringify(await list({}));
  const examples = [...text.matchAll(/\b(claude|codex)::([A-Za-z0-9][A-Za-z0-9._-]*)/g)].map((m) => [m[1], m[2]]);
  assert.ok(examples.length >= 2, "there are examples");
  for (const [provider, model] of examples) assert.ok(catalog[provider].has(model), `${provider}::${model} is in the catalog`);
});

// ── (9) Skill tool ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: app.js with the fixed description => red (without a catalog it refers to the list).
test("(9) cbase_skill names the catalog only when there is one — and its heading is SKILL_CATALOG_TITLE", async () => {
  assert.ok(skillCatalog([{ name: "tdd", description: "x" }]).startsWith(`## ${SKILL_CATALOG_TITLE}\n`), "heading of the catalog");
  const without = (await list({ CBASE_SKILL_WRITE: "1" })).find((t) => t.name === "cbase_skill");
  assert.ok(without, "with write permission and without a catalog the tool exists");
  assert.ok(!JSON.stringify(without).includes(SKILL_CATALOG_TITLE), "… and refers to no list");
  assert.match(without.description, /NO skill is currently assigned/);
  const including = (await list({ CBASE_SKILLS: JSON.stringify(["tdd"]) })).find((t) => t.name === "cbase_skill");
  assert.ok(including.description.includes(`(“${SKILL_CATALOG_TITLE}”)`), "with a catalog: the reference to the list");
});

// ── (11) Agenda ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: agenda-block.js with "you wrote it yourself" => red.
test("(11) the agenda block claims no authorship", () => {
  const block = agendaFence({ title: "Rebuild the till", description: "Goal: cents instead of euros", steps: [] });
  assert.ok(block.includes("<cbase-agenda"), "the block is built");
  assert.doesNotMatch(block, /\byou (?:have |'ve )?(?:written|wrote)\b/i);
});

// ── (13) Lock list of the Claude CLI ────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: claude.js CLAUDE_LOCK_DEFAULT without the three names => red.
test("(13) every Claude run locks EnterWorktree, ExitWorktree and ReportFindings; TaskStop stays", () => {
  const args = buildClaudeChatArgs({ systemPrompt: "x", mcpConfigPath: "/tmp/m.json", permissionMode: "bypassPermissions", settingSources: "user" });
  const locked = args[args.indexOf("--disallowedTools") + 1].split(",");
  for (const n of ["EnterWorktree", "ExitWorktree", "ReportFindings"]) assert.ok(locked.includes(n), `${n} locked`);
  assert.ok(!locked.includes("TaskStop"), "TaskStop stays (stop_task of the run end)");
});
