// The outer loop: what a run sees in the cbase MCP server and what the others do NOT see. Over the REAL MCP server (spawn,
// tools/list) and the real server (the answers that must match the description - execution side = description side):
//   (1) `cbase_chat_analysis` is missing from EVERY run without the marker: main run of a coding chat, subagent at depth 2 with an
//       explicit list (that names it), workflow agent - and it is in no full set of a subagent
//   (2) with the marker: without a list ONLY the analysis tool (never the full catalog); with a list the list minus OUTER_LOOP_LOCKED -
//       `cbase_permission_prompt` is missing (ALWAYS does not count), the depth does not count
//   (3) OUTER_LOOP_LOCKED is bound in BOTH directions: every cbase tool of an excluded group that is still in the catalog is locked,
//       and nothing locked is selectable (OUTER_LOOP_SELECTABLE) or the analysis tool. The tools of the excluded groups are
//       recorded (EXCLUDED_PARKED) because their catalog is gone - a group whose tools all vanished checks nothing any more and
//       still sits in the list.
//   (4) with the marker, the description of agent_send / agents_list names only `chat:` resp. the three views, and so does the schema -
//       and the server answers accordingly: `channel:`/`wf:`/`graph:`/subagent 403, view `start`/`channel` 400
//   The agenda keeper: (1) holds for `cbase_agenda_maintain` too (ONLY_AGENDA_KEEPER - even the main run lacks it), (2) with the
//   marker it gets through if the list names it (only outerloop/set.js writes the list), and in (3) `cbase_agenda` is the ONE named
//   exception of the agenda group (EXCEPTIONS_AP4): not locked, not selectable - only the keeper's set carries it.
//
// COUNTER-TESTS (each shown red, then restored):
//   visibility.js lockedForOuterLoop without a marker `false` instead of ONLY_OUTER_LOOP => (1) red (the explicit list offered it);
//   "cbase_proposal_submit" or "cbase_artifacts_read" removed from OUTER_LOOP_LOCKED => (3) red; mcp/offering.js without a list the
//   full catalog instead of ONLY_OUTER_LOOP => (2) red;
//   visibility.js lockedForOuterLoop without a marker again `ONLY_OUTER_LOOP.includes(name)` => (1) red (the main run offered
//   cbase_agenda_maintain); runs/agent-set.js FULL_SET only without ONLY_OUTER_LOOP => (1) red.
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-visibility.test.js

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { CATALOG_NAMES, TOOLS } from "../electron/mcp/catalog.js";
import { ONLY_AGENDA_KEEPER, ONLY_OUTER_LOOP, OUTER_LOOP_LOCKED, lockedForOuterLoop } from "../electron/mcp/visibility.js";
import { CODING_GROUPS } from "../electron/server/toolchain/tool-catalog.js";
import { OUTER_LOOP_GROUPS, OUTER_LOOP_SELECTABLE } from "../electron/server/outerloop/catalog.js";
import { agentToolset } from "../electron/server/runs/agent-set.js";
import { withAgentsServer } from "./agent-harness.mjs";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const ANALYSIS = "cbase_chat_analysis";
const MAINTAIN = "cbase_agenda_maintain";
const MARKER = "a0000000-0000-4000-8000-00000000000a:run-1";

// tools/list per spawn - the same way as mcp-catalog.test.js, without a deadline (if the server hangs, the suite's deadline applies).
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const empty = { CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_SCHEMA: undefined, CBASE_WORKFLOW_AGENT: undefined, CBASE_OUTER_LOOP: undefined, CBASE_INSTANCE: undefined, CBASE_FENCE_TOKEN: undefined };
    const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, ...empty, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) { child.kill(); resolve(msg.result.tools); }
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => { if (code) reject(new Error(`MCP server exited with ${code}: ${stderr.trim().split("\n")[0]}`)); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}
const names = async (env) => (await toolsList(env)).map((t) => t.name);

test("(1) without a marker cbase_chat_analysis is missing from every run - main run, depth-2 subagent with list, workflow agent, explicit list", async () => {
  // Behind it in the catalog come the agenda group (cbase_agenda, cbase_agenda_write, cbase_agenda_maintain), the skill group
  // (cbase_skill_write) and the timeline (two tools, only the timeline agent - timeline-agent.test.js); named in mcp-catalog.test.js.

  assert.deepEqual(CATALOG_NAMES.slice(-7, -6), [ANALYSIS], "the outer-loop group sits before the agenda, skill and timeline groups");
  assert.deepEqual([...ONLY_AGENDA_KEEPER], [MAINTAIN]);
  const list = JSON.stringify([...CATALOG_NAMES]);
  const cases = [
    ["main run of a coding chat", {}],
    ["depth-2 subagent with explicit list", { CBASE_AGENT_DEPTH: "2", CBASE_TOOLS: list }],
    ["workflow agent", { CBASE_WORKFLOW_AGENT: "wf-1", CBASE_AGENT_DEPTH: "1", CBASE_TOOLS: list }],

    ["explicit list including analysis and maintenance", { CBASE_TOOLS: JSON.stringify(["cbase_projects_list", ANALYSIS, MAINTAIN]) }],
    ["run with the full list", { CBASE_TOOLS: list }],
  ];
  for (const [what, env] of cases) {
    const n = await names(env);
    assert.ok(n.length > 0, `${what}: any tools at all`);
    assert.equal(n.includes(ANALYSIS), false, `${what}: ${ANALYSIS} is missing`);
    assert.equal(n.includes(MAINTAIN), false, `${what}: ${MAINTAIN} is missing`);
  }
  // A subagent's full set (runs/agent-set.js FULL_SET) does not carry it - otherwise it would be in every grandchild's list.
  const full = agentToolset({ parent: { cbase: null, builtin: null }, depth: 2 }).cbase;
  assert.equal(full.includes(ANALYSIS), false);
  assert.equal(full.includes(MAINTAIN), false, "a subagent's full set does not carry the keeper's tool");
  assert.ok(full.includes("cbase_agenda_write") === false && full.includes("cbase_agenda"), "counter-check: the set is real (read yes, write no)");
  assert.equal(lockedForOuterLoop(ANALYSIS, ""), true);
  assert.equal(lockedForOuterLoop(ANALYSIS, MARKER), false);
  assert.equal(lockedForOuterLoop(MAINTAIN, ""), true);
  assert.equal(lockedForOuterLoop(MAINTAIN, MARKER), false);
});

test("(2) with a marker: without a list only the analysis tool, with a list the list minus OUTER_LOOP_LOCKED - no permission_prompt, no depth", async () => {
  assert.deepEqual(await names({ CBASE_OUTER_LOOP: MARKER }), ONLY_OUTER_LOOP, "without a list: never the full catalog");
  // The set of a run with communication and project knowledge: everything there except what a run without a turn cannot have - and the
  // facts (no longer part of the outer-loop selection).
  const set = ["cbase_projects_list", "cbase_fact_search", "cbase_agents_list", "cbase_agent_send", "cbase_permission_prompt", "cbase_ask", ANALYSIS];
  assert.deepEqual(await names({ CBASE_OUTER_LOOP: MARKER, CBASE_TOOLS: JSON.stringify(set) }),
    ["cbase_agents_list", "cbase_agent_send", "cbase_projects_list", ANALYSIS].sort((x, y) => CATALOG_NAMES.indexOf(x) - CATALOG_NAMES.indexOf(y)),
    "permission_prompt (ALWAYS), ask and fact_search are missing, catalog order");
  // The full catalog as a list - nothing locked gets through, the depth (3 here: the family would otherwise sit at the limit) does not count.
  const everything = await names({ CBASE_OUTER_LOOP: MARKER, CBASE_AGENT_DEPTH: "3", CBASE_TOOLS: JSON.stringify([...CATALOG_NAMES]) });
  for (const g of OUTER_LOOP_LOCKED) assert.equal(everything.includes(g), false, `${g} is locked`);
  for (const w of OUTER_LOOP_SELECTABLE) assert.ok(everything.includes(w), `${w} is selectable and arrives`);
  assert.ok(everything.includes(ANALYSIS));
  // The keeper's two tools arrive with a marker if the list names them - only outerloop/set.js writes the list.
  assert.ok(everything.includes("cbase_agenda") && everything.includes(MAINTAIN), "with a marker the list decides");
  assert.deepEqual(await names({ CBASE_OUTER_LOOP: MARKER, CBASE_TOOLS: JSON.stringify(["cbase_agents_list", ANALYSIS]) }),
    ["cbase_agents_list", ANALYSIS], "without them in the list they are missing (every other outer-loop agent)");
});

// Recorded from the removed manager tool catalog: the groups excluded from the outer loop, with their cbase tools in source
// order (the `read` group carried only built-ins). Whatever of it is still in the catalog today must be locked.
const EXCLUDED_PARKED = Object.freeze({
  agendas: ["cbase_agenda"],
  question: ["cbase_ask"],
  artifacts: ["cbase_artifacts_list", "cbase_artifacts_read"],
  tasks: ["cbase_todo_list", "cbase_todo_create", "cbase_todo_update", "cbase_todo_delete"],
  assign: ["cbase_chat_assign"],
  documents: ["cbase_doc_list", "cbase_doc_read", "cbase_doc_write", "cbase_doc_move", "cbase_doc_delete", "cbase_doc_import"],
  facts: ["cbase_fact_search", "cbase_fact_get", "cbase_fact_create", "cbase_fact_update"],
  memory: ["cbase_memory_read", "cbase_memory_update"],
  read: [],
  projectKnowledge: ["cbase_pfact_search", "cbase_pfact_get", "cbase_pfact_create", "cbase_pfact_update"],
  suggestions: ["cbase_proposal_submit", "cbase_proposal_list", "cbase_proposal_withdraw"],
  workflows: ["cbase_workflow_list"],
  schedules: ["cbase_schedule_list", "cbase_schedule_create", "cbase_schedule_update", "cbase_schedule_delete", "cbase_schedule_run"],
});

// The named exceptions of direction 1: a tool of an excluded group that is NOT locked - with a
// reason. It still must not be selectable (checked below): only outerloop/set.js puts it into a set.
const EXCEPTIONS_AP4 = Object.freeze({
  cbase_agenda: "the agenda keeper reads the agenda of the observed chat",
});

test("(3) OUTER_LOOP_LOCKED is bound - in both directions", () => {
  // The outer-loop selection is exactly the coding groups, and none of them is excluded.
  assert.deepEqual([...OUTER_LOOP_GROUPS], CODING_GROUPS.map((g) => g.key));
  for (const k of OUTER_LOOP_GROUPS) assert.equal(Object.hasOwn(EXCLUDED_PARKED, k), false, `${k} is in the selection AND excluded`);
  const excluded = Object.entries(EXCLUDED_PARKED).map(([key, tools]) => ({ key, tools }));
  const locked = new Set(OUTER_LOOP_LOCKED);
  // Direction 1: every cbase tool of an excluded group is locked (`read` carries built-ins - those are chosen there).
  for (const g of excluded) {
    for (const t of g.tools.filter((x) => CATALOG_NAMES.includes(x))) {
      if (Object.hasOwn(EXCEPTIONS_AP4, t)) {
        assert.equal(locked.has(t), false, `${t} is a named exception and still locked`);
        assert.equal(OUTER_LOOP_SELECTABLE.includes(t), false, `${t} is an exception and still must not be selectable`);
        continue;
      }
      assert.ok(locked.has(t), `${t} (group ${g.key}) is missing from OUTER_LOOP_LOCKED`);
    }
  }
  t_exceptions: for (const t of Object.keys(EXCEPTIONS_AP4)) {
    for (const g of excluded) if (g.tools.includes(t)) continue t_exceptions;
    assert.fail(`${t} is an exception but is in no excluded group (remove the entry)`);
  }
  // Direction 2: nothing locked is selectable, none is the analysis tool, each is a tool of the catalog (no typo).
  for (const t of locked) {
    assert.ok(CATALOG_NAMES.includes(t), `${t} is not in the catalog`);
    assert.equal(OUTER_LOOP_SELECTABLE.includes(t), false, `${t} is locked AND selectable`);
    assert.equal(ONLY_OUTER_LOOP.includes(t), false);
    assert.equal(ONLY_AGENDA_KEEPER.includes(t), false, `${t} is locked AND the keeper's tool`);
  }
  // What is neither selectable nor locked never gets into a set (outerloop/set.js) - still, nothing chat-bound may be among them
  // that a hand-written list could bring in: delegation and workflows are locked.
  for (const t of ["cbase_agent", "cbase_agent_output", "cbase_agent_stop", "cbase_dynamic_workflow", "cbase_workflow_start", "cbase_wakeup", "cbase_monitor", "cbase_permission_prompt"]) {
    assert.ok(locked.has(t), `${t}`);
  }
  // What of the excluded groups is still in the catalog (not empty - otherwise direction 1 would check nothing).
  assert.deepEqual(excluded.flatMap((g) => g.tools).filter((x) => CATALOG_NAMES.includes(x)).sort(),
    ["cbase_agenda", "cbase_artifacts_list", "cbase_artifacts_read", "cbase_ask"]);
});

test("(4) description with a marker = the server's response: agent_send only chat:, agents_list three views", async () => {
  const including = await toolsList({ CBASE_OUTER_LOOP: MARKER, CBASE_TOOLS: JSON.stringify(["cbase_agents_list", "cbase_agent_send", ANALYSIS]) });
  const send = including.find((t) => t.name === "cbase_agent_send");
  const list = including.find((t) => t.name === "cbase_agents_list");
  assert.match(send.description, /to = "chat:<id>"/);
  for (const foreign of ["channel:", "wf:", "graph:", "agent:"]) assert.equal(send.description.includes(foreign), false, `agent_send does not name ${foreign}`);
  assert.deepEqual(Object.keys(send.inputSchema.properties).sort(), ["message", "to"], "only to and message - no files, no from");
  assert.deepEqual(list.inputSchema.properties.view.enum, ["summary", "chats", "chat"]);
  for (const foreign of ["'start'", "'channel'"]) {
    assert.equal(list.description.includes(foreign), false, `agents_list does not name ${foreign}`);
    assert.equal(list.inputSchema.properties.view.description.includes(foreign), false, `the view does not name ${foreign}`);
  }
  // Without a marker: the descriptions of the coding chat (counter-check - otherwise the test would only check a text that does not exist).
  const without = await toolsList({});
  assert.match(without.find((t) => t.name === "cbase_agent_send").description, /channel:/);
  assert.ok(without.find((t) => t.name === "cbase_agents_list").inputSchema.properties.view.enum.includes("start"));
  assert.ok(TOOLS.some((t) => t.name === ANALYSIS));

  await withAgentsServer(async ({ base, chat, ws }) => {
    const json = async (method, path, body) => {
      const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Connection: "close" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const agent = store.createOuterLoopAgent({ id: MARKER.split(":")[0], workspaceId: ws.id, name: "Checker", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: "m", tools: ["cbase_agents_list", "cbase_agent_send"] });
    store.createOuterLoopRun({ id: "run-1", agentId: agent.id, chatId: chat.id, trigger: "quiet", set: { cbase: ["cbase_agents_list", "cbase_agent_send", ANALYSIS], builtin: [], extern: [], dropped: { fence: [], approval: [] } } });
    try {
      const q = (view) => `/api/chats/${chat.id}/communication?${new URLSearchParams({ view, outerLoop: MARKER })}`;
      for (const view of ["start", "channel"]) assert.equal((await json("GET", q(view))).status, 400, `view ${view}: 400`);
      for (const view of ["summary", "chats"]) assert.equal((await json("GET", q(view))).status, 200, `view ${view}: 200`);
      const summary = (await json("GET", q("summary"))).body;
      for (const k of ["subagents", "workflowAgents", "graphRuns", "channelPartner", "agents"]) assert.equal(k in summary, false, `summary without ${k}`);
      assert.ok(Array.isArray(summary.chats) && summary.notes?.source, "chats and the origin of the notes");
      for (const to of ["channel:k1", "wf:w1", "graph:g1", "agent:a1", "a1"]) {
        const r = await json("POST", `/api/chats/${chat.id}/agent/send`, { to, message: "hello", from: "agent", outerLoop: MARKER });
        assert.equal(r.status, 403, `${to}: 403 (${JSON.stringify(r.body)})`);
      }
    } finally {
      store.outerLoopRunEnd("run-1", { state: "finished" });
    }
  });
});
