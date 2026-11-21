// Guard for the split MCP server: `TOOLS` in electron/mcp/cbase-mcp.js is `[...projectTools, ...artifactTools, ...]` from the
// group modules (catalog.js), and the ORDER of this array is `tools/list`, i.e. part of the prompt prefix of every run
// (a reshuffle costs the prompt cache). No other test measures it: the tests that compare tool lists SORT the names before
// comparing. This one freezes the order of the full catalog.
//
// Counter-tests (one sabotage each, on a copy of the tree; (order) = "tools/list delivers the tools in the frozen order",
// (coding catalog) = "the coding catalog ...", (copy tools) = "the four copy tools stand last and only in the relocated project"):
//   catalog.js: catalog without the group        => (order), (copy tools) red
//   catalog.js: group not last                   => (order), (copy tools) red
//   stacks.js: tool renamed                      => (order), (coding catalog), (copy tools) red
//   offering.js: filter by instance missing      => (coding catalog), (copy tools) red
//   visibility.js: without a marker all visible  => (coding catalog), (copy tools) red
//   visibility.js: a copy sees the creation      => (copy tools) red
//   visibility.js: main without the creation     => (order), (copy tools) red
//   catalog.js without `...agendaTools`          => all three red; the group before `...outerLoopTools` => (order) red;
//   visibility.js without "cbase_agenda_write" in VIEW_BY_DEPTH.alwaysLocked => (coding catalog) stays green (depth 0); the cut
//     per depth is held by server/backend/test/agenda.test.js.
//   tools/projects.js with cbase_project_create against the snapshot => all three red ("catalog.js carries exactly the names of
//     the snapshot ...").
//
// The snapshot is an alarm, not a lock: whoever adds or reorders a tool updates the file and says so in the changelog, never
// just to turn a red test green.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COPY_TOOLS, ONLY_WITH_RUN_BINDING, ONLY_WITH_OUTER_LOOP_MARKER, ONLY_OUTER_LOOP } from "../electron/mcp/visibility.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { agendaTools } from "../electron/mcp/tools/agenda.js";
import { skillTools } from "../electron/mcp/tools/skills.js";
import { timelineTools } from "../electron/mcp/tools/timeline.js";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const SNAPSHOT = fileURLToPath(new URL("./fixtures/mcp-catalog.snapshot.txt", import.meta.url));
const EXPECTED = fs.readFileSync(SNAPSHOT, "utf8").split("\n").filter(Boolean);
// The identifier of an instance "<projectId>/<instance>" (toolchain/mcp-config.js CBASE_INSTANCE): the main of a relocated project and a copy.
const INSTANCE_MAIN = "0123456789abcdef0123456789abcdef/main";
const INSTANCE_COPY = "0123456789abcdef0123456789abcdef/copy-k1";
// The agenda group stands behind the outer-loop group at the very end: read and write, both in the coding catalog.
const AGENDA = agendaTools.map((t) => t.name);
const SKILLS_WRITE = skillTools.map((t) => t.name);
// The Teams watch stands behind the skill group at the very end: all three in the coding catalog (main run only).
const TIMELINE = timelineTools.map((t) => t.name);

// tools/list per spawn: the same way the app and every test go; the entry point is never imported.
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_SCHEMA: undefined, CBASE_SKILL_WRITE: undefined, CBASE_APPROVAL: undefined, CBASE_INSTANCE: undefined, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
    setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: tools/list (${stderr.trim().split("\n")[0] || "no error output"})`)); }, 15_000).unref();
  });
}

test("MCP catalog: tools/list delivers the tools in the frozen order", async () => {
  // The order is the order of the group modules; groups that only some runs see (outer-loop, run-binding, copy tools, skill write,
  // timeline) stand at the end, so the prefix before them stays the same for every other run. A tool added, dropped or
  // moved changes the prompt prefix of every run once: update the snapshot knowingly.
  assert.equal(EXPECTED.length, 69, "the snapshot carries 69 names");
  // The catalog itself against the snapshot: the query below loads CBASE_TOOLS = snapshot, so a NEW tool the snapshot does not
  // know would go unnoticed there.
  assert.deepEqual([...CATALOG_NAMES], EXPECTED, "catalog.js carries exactly the names of the snapshot, in this order");
  assert.deepEqual(AGENDA, ["cbase_agenda", "cbase_agenda_write", "cbase_agenda_maintain"]);
  assert.deepEqual(SKILLS_WRITE, ["cbase_skill_write"]);
  assert.deepEqual(TIMELINE, ["cbase_timeline", "cbase_timeline_write"]);
  const REAR = AGENDA.length + SKILLS_WRITE.length + TIMELINE.length;
  assert.deepEqual(EXPECTED.slice(-(COPY_TOOLS.length + 1 + REAR), -(1 + REAR)), COPY_TOOLS, "the copy tools stand before the outer-loop group, in this order (cache prefix)");
  assert.deepEqual(EXPECTED.slice(-(1 + REAR), -REAR), ONLY_OUTER_LOOP, "the outer-loop group stands before the agenda group");
  assert.deepEqual(EXPECTED.slice(-REAR, -(SKILLS_WRITE.length + TIMELINE.length)), AGENDA, "the agenda group stands before the skill group");
  assert.deepEqual(EXPECTED.slice(-(SKILLS_WRITE.length + TIMELINE.length), -TIMELINE.length), SKILLS_WRITE, "the skill group stands before the timeline");
  assert.deepEqual(EXPECTED.slice(-TIMELINE.length), TIMELINE, "the timeline group stands at the very end");
  // Full list via CBASE_TOOLS (every group visible), CBASE_SKILLS (cbase_skill visible), CBASE_SCHEMA (the StructuredOutput
  // messenger visible) and CBASE_INSTANCE (a run in the relocated project: the copy tools visible).
  // cbase_chat_analyse is missing without the marker of an outer-loop run even in the explicit list (outerloop-visibility.test.js).
  // CBASE_SKILL_WRITE: a main run that may write skills; cbase_skill_write visible.
  // The run-binding marker (visibility.js ONLY_WITH_RUN_BINDING): CBASE_APPROVAL (cbase_permission_prompt).
  const tools = await toolsList({ CBASE_TOOLS: JSON.stringify(EXPECTED), CBASE_SKILLS: JSON.stringify(["x"]), CBASE_SCHEMA: JSON.stringify({ type: "object", properties: {} }), CBASE_INSTANCE: INSTANCE_MAIN, CBASE_SKILL_WRITE: "1", CBASE_APPROVAL: "1" });
  assert.deepEqual(tools.map((t) => t.name), EXPECTED.filter((n) => !ONLY_WITH_OUTER_LOOP_MARKER.includes(n)));
  // Every tool is complete: name, description, schema; a group module that half-loses an entry shows up here, not only in chat.
  for (const t of tools) assert.ok(t.name && t.description && t.inputSchema?.type === "object", `complete: ${t.name}`);
});

test("MCP catalog: the coding catalog (no set, no skills, no schema, no instance) is the order minus cbase_skill, StructuredOutput and the copy tools", async () => {
  const tools = await toolsList({});
  const expected = EXPECTED.filter((n) => n !== "cbase_skill" && n !== "StructuredOutput" && !COPY_TOOLS.includes(n) && !ONLY_WITH_OUTER_LOOP_MARKER.includes(n) && !ONLY_WITH_RUN_BINDING.includes(n) && !SKILLS_WRITE.includes(n));
  // 56 tools: the full snapshot minus what a plain coding chat does not see: the run-binding tools (only their own run has them;
  // every call failed in a coding chat), the copy tools (only in a relocated project), the outer-loop-only tools (cbase_agenda_maintain,
  // cbase_chat_analyse, timeline) and the skill write tool (needs CBASE_SKILL_WRITE).
  assert.equal(expected.length, 56);
  assert.deepEqual(tools.map((t) => t.name), expected);
});

test("MCP catalog: with the marker CBASE_SKILL_WRITE the coding main run has both skill tools (the write tool behind the agenda, last); without it none (not even by list)", async () => {
  const coding = EXPECTED.filter((n) => n !== "cbase_skill" && n !== "StructuredOutput" && !COPY_TOOLS.includes(n) && !ONLY_WITH_OUTER_LOOP_MARKER.includes(n) && !ONLY_WITH_RUN_BINDING.includes(n) && !SKILLS_WRITE.includes(n));
  const including = (await toolsList({ CBASE_SKILL_WRITE: "1" })).map((t) => t.name);
  assert.deepEqual(including, EXPECTED.filter((n) => coding.includes(n) || n === "cbase_skill" || SKILLS_WRITE.includes(n)), "catalog order, cbase_skill even without a catalog, the write tool last");
  assert.deepEqual(including.slice(-1), SKILLS_WRITE);
  // An explicit list (subagent from depth 2, special run) never makes it effective: without the marker it is missing.
  const list = (await toolsList({ CBASE_TOOLS: JSON.stringify(EXPECTED) })).map((t) => t.name);
  assert.equal(list.includes("cbase_skill_write"), false, "without the marker it is missing even in the explicit list");
  // And with the marker as a subagent (depth 1) or workflow agent it stays locked (description = execution).
  for (const env of [{ CBASE_AGENT_DEPTH: "1" }, { CBASE_WORKFLOW_AGENT: "wf-1" }, { CBASE_ONLY_SUBAGENTS: "1" }, { CBASE_OUTER_LOOP: "a:b", CBASE_TOOLS: JSON.stringify(EXPECTED) }]) {
    const n = (await toolsList({ ...env, CBASE_SKILL_WRITE: "1" })).map((t) => t.name);
    assert.equal(n.includes("cbase_skill_write"), false, `locked for ${JSON.stringify(env).slice(0, 60)}`);
  }
});

test("MCP catalog: the four copy tools stand last and only in the relocated project (all four in main, in a copy without the creation, none without instance, not even by explicit list)", async () => {
  // Without the agenda group, which stands BEHIND the copy tools (catalog order); it is appended at the end.
  const coding = EXPECTED.filter((n) => n !== "cbase_skill" && n !== "StructuredOutput" && !COPY_TOOLS.includes(n) && !ONLY_OUTER_LOOP.includes(n) && !ONLY_WITH_RUN_BINDING.includes(n) && !AGENDA.includes(n) && !SKILLS_WRITE.includes(n) && !TIMELINE.includes(n));
  // The agenda of a run without an outer-loop marker: without the keeper tool (agenda-keeper-only set).
  const AGENDA_WITHOUT_MARKER = AGENDA.filter((n) => !ONLY_WITH_OUTER_LOOP_MARKER.includes(n));
  assert.equal(coding.length, 54);
  const inMain = await toolsList({ CBASE_INSTANCE: INSTANCE_MAIN });
  assert.deepEqual(inMain.map((t) => t.name), [...coding, ...COPY_TOOLS, ...AGENDA_WITHOUT_MARKER], "main: the coding catalog + the four copy tools + the agenda last");
  const inCopy = await toolsList({ CBASE_INSTANCE: INSTANCE_COPY });
  assert.deepEqual(inCopy.map((t) => t.name), [...coding, ...COPY_TOOLS.filter((n) => n !== "cbase_copy_stack"), ...AGENDA_WITHOUT_MARKER], "copy: without cbase_copy_stack");
  // An explicit list (subagent from depth 2: the full set spelled out) does not offer them without an instance.
  const list = await toolsList({ CBASE_TOOLS: JSON.stringify([...coding, ...COPY_TOOLS, ...AGENDA_WITHOUT_MARKER]) });
  assert.deepEqual(list.map((t) => t.name), [...coding, ...AGENDA_WITHOUT_MARKER], "without an instance the four are missing even in the explicit list");
  const withInstance = await toolsList({ CBASE_TOOLS: JSON.stringify([...coding, ...COPY_TOOLS, ...AGENDA_WITHOUT_MARKER]), CBASE_INSTANCE: INSTANCE_MAIN });
  assert.deepEqual(withInstance.map((t) => t.name), [...coding, ...COPY_TOOLS, ...AGENDA_WITHOUT_MARKER], "with an instance the list offers them");
});
