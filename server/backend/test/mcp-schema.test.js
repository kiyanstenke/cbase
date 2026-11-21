// The schema guard of the cbase tools.
//
// Why a guard of its own: the catalog snapshot (mcp-catalog.test.js) pins only the tool NAMES; it does not see an enumeration in
// the schema. And the MCP tool files import only their own helper library (own process, import-direction.test.js), so the level
// order stands there as a second copy (`mcp/lib.js:EFFORT_LEVELS`) beside the truth `server/workflows.js:EFFORT_LEVELS`. It is
// bound through `tools/list`, i.e. through what a model really sees.
//
// The rule is general: EVERY field `effort` with an enumeration, anywhere in the schema of any tool, carries exactly the order. A
// tool that takes a level in future falls under the guard by itself; `cbase_agent` MUST carry one so that the search does not
// come up empty.
//
// Counter-tests: `max` removed from EFFORT_LEVELS => red; a sixth level only in EFFORT_LEVELS => red; the enumeration removed
// from channels.js => red. "ultracode" appended to cbase_agent.effort => red, a level left out => red, the enumeration removed
// from mcp/tools/agents.js => red.
// Copy tools (one sabotage each in stacks.js, the whole file run; without sabotage all green, each sabotage red):
//   stacks.js: base only text                               => schema guard red
//   stacks.js: base an object with numbers                  => schema guard red
//   stacks.js: retrieve not an array                        => schema guard red
//   stacks.js: fetch one field more                         => schema guard red
//   stacks.js: fetch without the required field             => schema guard red
//   stacks.js: creation description without turn            => schema guard red
//   stacks.js: creation description without waiting states  => schema guard red
//   stacks.js: creation description with open changes       => schema guard red
//   stacks.js: fetch description clears up                  => schema guard red
//   stacks.js: remove description immediately               => schema guard red
// `cbase_copy_stack` carries `baseInstance` (a text, the same form as the REST body), and the description says what a copy from
// a copy brings along and that creation is from the main. Counter-tests:
//   stacks.js: baseInstance removed from the schema                            => schema guard red ("the fields differ")
//   stacks.js: the old sentence "..., and there is no copy of a copy."         => schema guard red ("does not say where it is created")
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EFFORT_LEVELS } from "../electron/server/workflows.js";
import { OUTPUT_WAIT_MAX_MS, FOREGROUND_DEFAULT_MS } from "../electron/server/providers/agent-runtime.js";
import { ONLY_WITH_OUTER_LOOP_MARKER } from "../electron/mcp/visibility.js";
import { AGENT_CHANGE, AGENT_READ } from "../electron/server/lsp/contract.js";
import { CODE_ACTION_KINDS } from "../electron/server/lsp/actions.js";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const ALL = fs.readFileSync(fileURLToPath(new URL("./fixtures/mcp-catalog.snapshot.txt", import.meta.url)), "utf8").split("\n").filter(Boolean);

// The four copy tools hang on the instance marker (CBASE_INSTANCE): the full catalog of this guard is that of a run in the MAIN of
// a relocated project. Without the marker exactly these four are missing (the numbers are held by mcp-catalog.test.js).
const INSTANCE_MAIN = "0123456789abcdef0123456789abcdef/main";

// tools/list per spawn, no deadline: if the server hangs, the deadline of the suite applies.
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_SCHEMA: undefined, CBASE_INSTANCE: INSTANCE_MAIN, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
    child.on("exit", (code) => { if (code && code !== null) reject(new Error(`MCP server exited with ${code}: ${stderr.trim().split("\n")[0]}`)); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

// Every field `effort` with `enum`, recursively through properties/items, with the path for the message.
function effortEnumerations(schema, path, out) {
  if (!schema || typeof schema !== "object") return out;
  for (const [name, field] of Object.entries(schema.properties || {})) {
    const here = `${path}.${name}`;
    if (name === "effort" && Array.isArray(field?.enum)) out.push([here, field.enum]);
    effortEnumerations(field, here, out);
  }
  if (schema.items) effortEnumerations(schema.items, `${path}[]`, out);
  return out;
}

test("schema guard: every effort enumeration in tools/list is the level order; cbase_agent carries one", async () => {
  // With a schema: otherwise the StructuredOutput messenger is missing (it hangs on CBASE_SCHEMA alone). With CBASE_SKILL_WRITE:
  // otherwise cbase_skill_write is missing. With the run-binding marker (visibility.js ONLY_WITH_RUN_BINDING): approval.
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(ALL), CBASE_SKILLS: JSON.stringify(["x"]), CBASE_SCHEMA: JSON.stringify({ type: "object", properties: {} }), CBASE_SKILL_WRITE: "1", CBASE_APPROVAL: "1" });
  // cbase_chat_analyse stands only in an outer-loop run (marker CBASE_OUTER_LOOP); without it it is missing here too, and so is
  // cbase_agenda_maintain.
  assert.equal(tools.length, ALL.filter((n) => !ONLY_WITH_OUTER_LOOP_MARKER.includes(n)).length, "the full catalog arrived");
  const findings = tools.flatMap((t) => effortEnumerations(t.inputSchema, t.name, []));
  console.log(`  [schema guard] ${findings.length} effort enumeration(s): ${findings.map(([p]) => p).join(", ")} · order ${EFFORT_LEVELS.join(" < ")}`);
  assert.ok(findings.some(([p]) => p === "cbase_agent.effort"), "cbase_agent carries effort as an enumeration");
  for (const [p, list] of findings) assert.deepEqual(list, EFFORT_LEVELS, `${p}: the enumeration differs from the level order (workflows.js EFFORT_LEVELS)`);
});

// The properties of the two foreground tools: `wait_ms` is gone; a foreground agent switches to the background by itself after
// 240 s (providers/agent-runtime.js FOREGROUND_DEFAULT_MS), and the description says exactly that. A new field (such as
// `effort`/`repo`) updates this list; it is the place where a schema field is wanted and named.
// Counter-test: `wait_ms` back in the schema of cbase_agent => red.
const AGENT_FIELDS = {
  // `effort` (level per subagent, enumeration see above) and `repo` (which repo a worktree branches).
  cbase_agent: ["description", "prompt", "subagent_type", "model", "run_in_background", "tools", "skills", "effort", "isolation", "repo", "name"],
  // No `run_in_background`: a finished agent ALWAYS continues in the background. `to` is the target (subagent, channel:<id>,
  // chat:<id> ...), `agentId` stays an alias, `files` as with the channel send.
  cbase_agent_send: ["to", "agentId", "message", "files"],
};

// Since the main agent never waits (server/providers/agent-wait.js) this holds for a subagent that delegates itself (depth >= 1);
// the schema offers the main agent (depth 0) no foreground any more, see the guard after this.
test("schema guard: cbase_agent and cbase_agent_send carry exactly their fields; no wait_ms, the 240 s rule stands in the description", async () => {
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(ALL), CBASE_SKILLS: JSON.stringify(["x"]), CBASE_AGENT_DEPTH: "1" });
  for (const [name, fields] of Object.entries(AGENT_FIELDS)) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} is missing in tools/list`);
    assert.deepEqual(Object.keys(t.inputSchema.properties), fields, `${name}: the fields differ`);
    assert.doesNotMatch(JSON.stringify(t), /wait_ms|still running/, `${name}: the old waiting time still stands in the schema or the description`);
  }
  const agent = tools.find((t) => t.name === "cbase_agent");
  assert.match(agent.description, /at most 240 s/, "the description names the deadline");
  assert.match(agent.description, /keeps running in the background/, "the description names what the call then reports");
  // Both fields say what they do, on the fields themselves rather than additionally in the description.
  assert.match(agent.inputSchema.properties.effort.description, /Effort level of THIS subagent only/, "the field effort says what it is for");
  assert.match(agent.inputSchema.properties.effort.description, /it inherits the level of its principal/, "the field effort names the default");
  assert.match(agent.inputSchema.properties.repo.description, /which repo is branched if it is not unambiguous/, "the field repo says what it is for");
  // The three cases of cbase_agent_send stand in its description.
  const send = tools.find((t) => t.name === "cbase_agent_send").description;
  for (const fall of [/RUNNING[^.]*next tool round/, /DONE[^.]*in the background/, /HUMAN stopped it, the call is rejected/]) {
    assert.match(send, fall, `cbase_agent_send: ${fall} is missing in the description`);
  }
});

// The waiting time of cbase_agent_output: schema and core used to promise up to 600 s (default 300 s), but the MCP request
// aborts at about 300 s. Clamped to the edge of the foreground (240 s, ONE constant in the core). What is checked is the
// NUMBER, at the schema (maximum, wording of field and description) and at the constant, never by waiting.
// Counter-test: `maximum` in the schema back to 600000 => red; OUTPUT_WAIT_MAX_MS back to 600_000 => red.
test("schema guard: cbase_agent_output waits at most 240 s; maximum, field and description say it, the same number as the core", async () => {
  assert.equal(OUTPUT_WAIT_MAX_MS, 240_000, "the cap of the core is not below the ~300 s edge of the MCP request");
  assert.equal(OUTPUT_WAIT_MAX_MS, FOREGROUND_DEFAULT_MS, "the same edge as the foreground");
  // Only a subagent (depth >= 1) may wait; the main agent never, see the next guard.
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(ALL), CBASE_SKILLS: JSON.stringify(["x"]), CBASE_AGENT_DEPTH: "1" });
  const out = tools.find((t) => t.name === "cbase_agent_output");
  assert.ok(out, "cbase_agent_output is missing in tools/list");
  const timeout = out.inputSchema.properties.timeout;
  assert.equal(timeout.maximum, OUTPUT_WAIT_MAX_MS, "the maximum in the schema differs from the core");
  assert.match(timeout.description, new RegExp(`maximum ${OUTPUT_WAIT_MAX_MS}\\b`), timeout.description);
  assert.doesNotMatch(JSON.stringify(out), /600000|300000/, "the old waiting time still stands in the schema or the description");
  assert.match(out.description, new RegExp(`at most ${OUTPUT_WAIT_MAX_MS / 1000} s`), "the description names the limit");
});

// The main agent never waits (server/providers/agent-wait.js, execution guard main-agent-waiting-never.test.js): at depth 0
// cbase_agent always returns at once and cbase_agent_output does not wait, so the schema offers neither `run_in_background` nor
// `block`/`timeout` there, and no description promises waiting.
// Counter-test: `waitingNever` in mcp/tools/agents.js set to `() => false` => red.
test("schema guard: the main agent (depth 0) is offered no foreground and no waiting", async () => {
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(ALL), CBASE_SKILLS: JSON.stringify(["x"]) });
  const agent = tools.find((t) => t.name === "cbase_agent");
  assert.deepEqual(Object.keys(agent.inputSchema.properties), AGENT_FIELDS.cbase_agent.filter((f) => f !== "run_in_background"),
    "cbase_agent: the schema of the main agent carries run_in_background");
  assert.match(agent.description, /ALWAYS runs in the BACKGROUND/, "the description says it always runs in the background");
  assert.match(agent.description, /you do not wait for it/);
  assert.doesNotMatch(agent.description, /run_in_background|at most 240 s|within the same turn/, "the description offers waiting");
  const out = tools.find((t) => t.name === "cbase_agent_output");
  assert.deepEqual(Object.keys(out.inputSchema.properties), ["agentId"], "cbase_agent_output: the schema of the main agent carries block/timeout");
  assert.match(out.description, /You do not wait for it/);
  assert.doesNotMatch(out.description, /waits for it|at most 240 s|block/, "the description offers waiting");
});

// The input of cbase_dynamic_workflow follows the Workflow tool of Claude Code field by field (type, maxLength, pattern), without
// extra fields. The table below is that shape; a private test outside this tree binds it to the measured reference schema.
// Descriptions may differ (cbase explains what holds here). The stop takes exactly `taskId`.
// Counter-test: `pattern` of resumeFromRunId removed => red.
// reference-shape:begin
const BASELINE_SCHEMA = { properties: {
  script: { type: "string", maxLength: 524288 },
  name: { type: "string" },
  description: { type: "string" },
  title: { type: "string" },
  args: {},
  scriptPath: { type: "string" },
  resumeFromRunId: { type: "string", pattern: "^wf_[a-z0-9-]{6,}$" },
} };
// reference-shape:end
const WITHOUT_BASELINE = [];

test("schema guard: cbase_dynamic_workflow carries the fields of the baseline (with `name`) with type, maxLength and pattern; the stop only taskId", async () => {
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(ALL), CBASE_SKILLS: JSON.stringify(["x"]) });
  const wf = tools.find((t) => t.name === "cbase_dynamic_workflow");
  assert.ok(wf, "cbase_dynamic_workflow is missing in tools/list");
  const desired = Object.keys(BASELINE_SCHEMA.properties).filter((k) => !WITHOUT_BASELINE.includes(k));
  assert.deepEqual(Object.keys(wf.inputSchema.properties), desired, "the fields differ from the baseline");
  for (const k of desired) {
    const v = BASELINE_SCHEMA.properties[k];
    const h = wf.inputSchema.properties[k];
    for (const m of ["type", "maxLength", "pattern"]) assert.deepEqual(h[m], v[m], `${k}.${m}: cbase ${JSON.stringify(h[m])}, baseline ${JSON.stringify(v[m])}`);
  }
  assert.equal(wf.inputSchema.additionalProperties, false, "extra fields are forbidden as in the baseline");
  assert.deepEqual(wf.inputSchema.required || [], [], "none is required (the server checks script OR scriptPath)");
  const stop = tools.find((t) => t.name === "cbase_dynamic_workflow_stop");
  assert.ok(stop, "cbase_dynamic_workflow_stop is missing in tools/list");
  assert.deepEqual(Object.keys(stop.inputSchema.properties), ["taskId"]);
  assert.deepEqual(stop.inputSchema.required, ["taskId"]);
});

// Description and execution of the opt-in: cbase_dynamic_workflow also starts in a graph step (mode from the run settings,
// "ultracode" in the node text), while the description used to say "in a chat in which a graph workflow is running it never
// starts"; a graph step has no human input, hence no reminder that would contradict. Bound to the ONE opt-in condition in
// dynworkflows/run.js: each of its checks needs its sentence in the description (a fourth check without a sentence is red),
// and the graph lock must not stand there.
// Counter-test: the old sentence "In a chat in which a graph workflow is running, it never starts." put back => red.
const OPT_IN_SETS = {
  "chat.ultracode": /in Ultracode mode \(in a graph workflow also via its run settings\)/,
  "keywordInTurn(chat.id)": /wrote “ultracode” in their message of this turn/,
  "nodeOpens(chat.id)": /the task of the graph workflow step the chat is at contains “ultracode”/,
};
test("description of cbase_dynamic_workflow names every opt-in way of the execution (run.js) and no graph lock", async () => {
  const run = fs.readFileSync(fileURLToPath(new URL("../electron/server/dynworkflows/run.js", import.meta.url)), "utf8");
  const condition = /\n {2}if \(([^\n]*)\) \{\n {4}const \{ requestId, card \} = createCard\(/.exec(run);
  assert.ok(condition, "the opt-in condition before createCard cannot be found in run.js");
  const checks = condition[1].split(" && ").map((t) => t.replace(/^!/, "").trim());
  assert.deepEqual(checks.slice().sort(), Object.keys(OPT_IN_SETS).sort(), `opt-in checks of the execution: ${JSON.stringify(checks)}`);
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(ALL), CBASE_SKILLS: JSON.stringify(["x"]) });
  const description = tools.find((t) => t.name === "cbase_dynamic_workflow").description;
  for (const [p, set] of Object.entries(OPT_IN_SETS)) assert.match(description, set, `${p}: the way is missing in the description`);
  assert.doesNotMatch(description, /graph workflow is running, it never starts/, "the lifted graph lock still stands in the description");
});

// The input of the copy tools: exactly these fields, required only where noted. `base` is a text OR an object { relPath: ref };
// `retrieve` a list of paths; the descriptions are fixed (cache prefix) and name what the agent does afterwards: end the turn,
// fetch before clearing up. Counter-tests: in the header of the file.
const COPY_FIELDS = {
  cbase_copy_stack: { fields: ["name", "baseInstance", "base"], required: [] },
  cbase_copy_stack_list: { fields: ["all"], required: [] },
  cbase_copy_stack_fetch: { fields: ["name"], required: ["name"] },
  cbase_copy_stack_remove: { fields: ["name", "retrieve"], required: ["name"] },
  // The instance of the own chat: required field, a text.
  cbase_switch_instance: { fields: ["instance"], required: ["instance"] },
};
test("schema guard: the copy tools carry exactly their fields (base: text or object, retrieve: list) and their sentences", async () => {
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(ALL), CBASE_SKILLS: JSON.stringify(["x"]) });
  for (const [name, { fields, required }] of Object.entries(COPY_FIELDS)) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} is missing in tools/list`);
    assert.deepEqual(Object.keys(t.inputSchema.properties), fields, `${name}: the fields differ`);
    assert.deepEqual(t.inputSchema.required || [], required, `${name}: the required fields differ`);
  }
  const create = tools.find((t) => t.name === "cbase_copy_stack");
  assert.deepEqual(create.inputSchema.properties.base.anyOf.map((x) => x.type), ["string", "object"], "base: a text OR an object { relPath: ref }");
  assert.equal(create.inputSchema.properties.base.anyOf[1].additionalProperties.type, "string", "base as an object: one ref (text) per repo");
  assert.match(create.description, /End your turn afterwards/, "the creation says that the agent ends its turn");
  assert.match(create.description, /waiting_queue[\s\S]*waiting_storage/, "the creation names the two waiting states");
  assert.match(create.description, /NO open changes/, "base takes no open changes along");
  // The template: a text as in the REST body; the description names both forms, what comes along from a copy, and the place of creation.
  assert.equal(create.inputSchema.properties.baseInstance.type, "string", "baseInstance: a text (\"main\" or \"copy-<name>\")");
  assert.match(create.description, /`baseInstance` \(optional\)[^`]*"main" \(default\) or "copy-<name>" of a READY copy/, "the description does not name the forms of baseInstance");
  assert.match(create.description, /including index, reflogs and stashes/, "the description does not say what a copy from a copy brings along");
  assert.match(create.description, /only from the main \(in a copy this tool is missing\)/, "the description does not say where it is created (mcp/visibility.js)");
  assert.doesNotMatch(create.description, /there is no copy of a copy/, "the description denies the copy from a copy (wrong now)");
  const fetch = tools.find((t) => t.name === "cbase_copy_stack_fetch").description;
  assert.match(fetch, /without clearing the copy/, "fetching does not clear up");
  assert.match(fetch, /it lives on; fetching again is safe/, "the copy lives on after fetching, a second fetch is repeatable");
  assert.match(fetch, /copy\/<name>\//, "fetched into the branch space copy/<name>/...");
  const way = tools.find((t) => t.name === "cbase_copy_stack_remove");
  assert.equal(way.inputSchema.properties.retrieve.type, "array");
  assert.equal(way.inputSchema.properties.retrieve.items.type, "string");
  assert.match(way.description, /after the end of this turn/, "from the copy itself the clearing up happens after the turn");
  // Every copy of the project, the lock against foreign work, no discarding: description side = execution side.
  assert.match(way.description, /any copy of this project/, "_remove works with every copy");
  assert.match(way.description, /INSTANCE_WORKING/, "_remove names the lock against foreign work");
  const changeover = tools.find((t) => t.name === "cbase_switch_instance");
  assert.equal(changeover.inputSchema.properties.instance.type, "string");
  assert.match(changeover.description, /End your turn afterwards/, "the switch says that the agent ends its turn (wakeup at turn end)");
  assert.match(changeover.description, /running turn stays/, "the running turn stays pinned");
});

// Editor navigation: the language service of the agents in TWO tools; cbase_lsp reads (actions = `AGENT_READ` from
// server/lsp/contract.js), cbase_lsp_edit writes (= `AGENT_CHANGE`). The MCP process never imports the server tree; this guard
// binds the second copy of the lists (mcp/tools/workspace.js LSP_READ/LSP_CHANGE/LSP_KINDS) through tools/list. Description side
// = execution side: each names the other, the reading one says "without changing anything".
// Counter-test: `hover` removed from LSP_READ => red; `rename` additionally in LSP_READ => red (the intersection too);
// `source` removed from LSP_KINDS => red.
test("schema guard: cbase_lsp carries exactly the reading actions of the contract, cbase_lsp_edit exactly the writing ones, and each names the other", async () => {
  const tools = await toolsList({});
  const read = tools.find((t) => t.name === "cbase_lsp");
  const change = tools.find((t) => t.name === "cbase_lsp_edit");
  assert.ok(read && change, "both stand in the coding catalog");
  assert.deepEqual(read.inputSchema.properties.action.enum, [...AGENT_READ], "cbase_lsp: action ≠ AGENT_READ (server/lsp/contract.js)");
  assert.deepEqual(change.inputSchema.properties.action.enum, [...AGENT_CHANGE], "cbase_lsp_edit: action ≠ AGENT_CHANGE");
  assert.equal(AGENT_READ.filter((a) => AGENT_CHANGE.includes(a)).length, 0, "no action is both reading and writing");
  for (const t of [read, change]) assert.deepEqual(t.inputSchema.properties.kinds.items.enum, [...CODE_ACTION_KINDS], `${t.name}: kinds ≠ CODE_ACTION_KINDS (lsp/actions.js)`);
  assert.deepEqual(change.inputSchema.required, ["file", "action"], "cbase_lsp_edit requires the action; there is no default that writes");
  assert.deepEqual(read.inputSchema.required, ["file"]);
  assert.match(read.description, /without changing anything/);
  assert.match(read.description, /cbase_lsp_edit/, "the reading tool names the writing one");
  assert.match(change.description, /cbase_lsp code_actions/, "the writing one names where the index comes from");
  assert.match(change.description, /All or nothing/);
});
