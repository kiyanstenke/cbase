// The length guard of the cbase MCP descriptions. Measured is what a model really receives: `tools/list` of the REAL MCP server
// (cbase-mcp.js), per run environment; descriptions are functions of the environment (depth, workflow marker, write permission,
// schedule, outer loop, instance, fence token, size guideline).
//
// Three rules, per tool and environment:
//   1. HARD: at most TRUNCATION_CLI characters. Above it the Claude CLI cuts off and the model never sees the rest, without
//      anything in cbase noticing. Up to 2.1.293 the limit was 2,048: the writing rules of cbase_context_create stood behind it
//      and were never read. The number holds for the pin MEASURED_ON; if the pin in server/backend/Dockerfile jumps, this guard is
//      red until the limit is re-measured against the new binary and updated here.
//   2. TARGET: at most BUDGET characters, unless the tool stands with a reason and measured length in
//      fixtures/mcp-description-exceptions.json. The list may only shrink (like tools/check/loc-allow.json): an exception under
//      the budget is red, and so is a tool that grows beyond its measured length. Printed on every run.
//   3. THE FIRST SENTENCE is the short description (mcp/first-set.js, the same function with which the loop engine builds its
//      catalog of deferred tools): a complete purpose sentence with punctuation at the end, SET_MIN to SET_MAX characters, without
//      a pointer further down. No exception list.
// Besides: every name from CATALOG_NAMES is measured in at least one environment (otherwise the guard would never check a tool).
//
// The check is ONE pure function (`findings`), run against the current state (must be empty) and against built-in sabotages (each
// must deliver exactly its finding), so the guard proves that it enters the ways it forbids.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { firstSentence } from "../electron/mcp/first-set.js";

// Claude Code: `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH ?? (<condition> ? 16384 : 4096)`; measured on the wire 4,096 without and
// 16,384 with deferred loading (measured against the pinned binary). The smaller one is held.
const TRUNCATION_CLI = 4096;
const MEASURED_ON = "2.1.332";
const BUDGET = 1500;
const SET_MAX = 160;
const SET_MIN = 20;

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const EXCEPTIONS_FILE = fileURLToPath(new URL("./fixtures/mcp-description-exceptions.json", import.meta.url));
const DOCKERFILE = fileURLToPath(new URL("../Dockerfile", import.meta.url));
const EXCEPTIONS = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, "utf8")).exceptions;

const ALL = JSON.stringify(CATALOG_NAMES);
const SKILLS = JSON.stringify(["x"]);
const SCHEMA = JSON.stringify({ type: "object", properties: { a: { type: "string" } } });
const MAIN = "0123456789abcdef0123456789abcdef/main";
const COPY = "0123456789abcdef0123456789abcdef/copy-k1";
// Every variable that changes the set or a description; none of it is inherited from the process of this test.
const EMPTY = Object.fromEntries(["CBASE_TOOLS", "CBASE_TOOLSET", "CBASE_SKILLS", "CBASE_AGENT_DEPTH", "CBASE_SCHEMA", "CBASE_WORKFLOW_AGENT",
  "CBASE_OUTER_LOOP", "CBASE_INSTANCE", "CBASE_TOKEN", "CBASE_WRITE_PERMISSION", "CBASE_ONLY_SUBAGENTS", "CBASE_DYNWF_SIZE", "CBASE_SKILL_WRITE",
  "CBASE_APPROVAL"]
  .map((k) => [k, undefined]));

// The run environments as toolchain/mcp-config.js writes them to the MCP server (coding, instance, write permission, depth,
// special run, outer loop, fence, size guideline). The special run (marker CBASE_ONLY_SUBAGENTS) stands in for the removed
// manager runs, once with the full catalog.
const ENVIRONMENTS = {
  "Coding (write permission free)": { CBASE_WRITE_PERMISSION: "free", CBASE_SKILLS: SKILLS, CBASE_SKILL_WRITE: "1" },
  "Coding without write permission on chats": { CBASE_SKILLS: SKILLS },
  "Coding in the main of a relocated project": { CBASE_WRITE_PERMISSION: "free", CBASE_SKILLS: SKILLS, CBASE_INSTANCE: MAIN },
  "Coding in a copy": { CBASE_WRITE_PERMISSION: "free", CBASE_SKILLS: SKILLS, CBASE_INSTANCE: COPY },
  "Subagent depth 1": { CBASE_AGENT_DEPTH: "1", CBASE_SKILLS: SKILLS, CBASE_INSTANCE: MAIN, CBASE_SCHEMA: SCHEMA },
  "Subagent depth 2": { CBASE_AGENT_DEPTH: "2", CBASE_SKILLS: SKILLS },
  "Subagent depth 3": { CBASE_AGENT_DEPTH: "3", CBASE_SKILLS: SKILLS },
  "Workflow agent": { CBASE_WORKFLOW_AGENT: "ag-1", CBASE_SCHEMA: SCHEMA, CBASE_SKILLS: SKILLS, CBASE_INSTANCE: MAIN },
  "Special run": { CBASE_ONLY_SUBAGENTS: "1" },
  "Special run (full catalog)": { CBASE_TOOLS: ALL, CBASE_ONLY_SUBAGENTS: "1", CBASE_SKILLS: SKILLS, CBASE_INSTANCE: MAIN },
  "Outer Loop": { CBASE_OUTER_LOOP: "a0000000-0000-4000-8000-00000000000a:run-1", CBASE_TOOLS: ALL },
  // Run binding (visibility.js): cbase_permission_prompt only with the approval marker; cbase_skill without a catalog has a version of its own.
  "Special run with approval": { CBASE_APPROVAL: "1", CBASE_ONLY_SUBAGENTS: "1" },
  "Coding without skills (write permission only)": { CBASE_SKILL_WRITE: "1", CBASE_APPROVAL: "1" },
  "Project container with fence token": { CBASE_TOKEN: "fence", CBASE_TOOLS: ALL, CBASE_INSTANCE: MAIN },
  "Size guideline small": { CBASE_DYNWF_SIZE: "small" },
  "Size guideline large": { CBASE_DYNWF_SIZE: "large" },
  "Size guideline unrestricted": { CBASE_DYNWF_SIZE: "unrestricted" },
};

// tools/list per spawn (a copy of the helper from mcp-schema.test.js: a .test.js never imports another). No deadline: if the server
// hangs, the deadline of the suite applies.
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, ...EMPTY, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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

// Measurement: name -> list {environment, text}.
async function measure() {
  const measurement = new Map();
  const results = await Promise.all(Object.entries(ENVIRONMENTS).map(async ([environment, env]) => [environment, await toolsList(env)]));
  for (const [environment, tools] of results) {
    for (const t of tools) {
      if (!measurement.has(t.name)) measurement.set(t.name, []);
      measurement.get(t.name).push({ environment, text: t.description });
    }
  }
  return measurement;
}
const longest = (entries) => Math.max(...entries.map((e) => String(e.text ?? "").length));

const SET_END = /[.!?]["'“”»’]*$/;
const REFERENCE = /\b(see|cf\.)\s+(below|above|following)\b|\bas follows\b|\bthe following\s*:?$/i;

// The ONE check: the current state and the sabotages go through it. Every finding is a line with tool and environment.
function findings(measurement, exceptions) {
  const out = [];
  for (const name of CATALOG_NAMES) if (!measurement.has(name)) out.push(`${name}: measured in no environment: extend ENVIRONMENTS`);
  const exception = new Map();
  for (const a of exceptions) {
    if (exception.has(a.name)) out.push(`${a.name}: is in the exception list twice`);
    exception.set(a.name, a);
    if (!String(a.reason || "").trim()) out.push(`${a.name}: exception without a reason`);
    if (!Number.isInteger(a.measured)) out.push(`${a.name}: exception without a measured length`);
  }
  for (const [name, entries] of measurement) {
    for (const { environment, text } of entries) {
      if (typeof text !== "string" || !text) { out.push(`${name} [${environment}]: no description`); continue; }
      if (text.length > TRUNCATION_CLI) out.push(`${name} [${environment}]: ${text.length} characters, above the truncation limit of the CLI (${TRUNCATION_CLI}); the rest never reaches the model`);
      if (text.length > BUDGET && !exception.has(name)) out.push(`${name} [${environment}]: ${text.length} characters, above the budget (${BUDGET}); shorten (field meanings to the schema, answer meanings into the answer)`);
      const set = firstSentence(text);
      if (set.length > SET_MAX) out.push(`${name} [${environment}]: first sentence ${set.length} characters (at most ${SET_MAX}): "${set.slice(0, 80)}..."`);
      if (set.length < SET_MIN) out.push(`${name} [${environment}]: first sentence ${set.length} characters (at least ${SET_MIN}): "${set}"`);
      if (!SET_END.test(set)) out.push(`${name} [${environment}]: first sentence without a sentence end: "${set.slice(0, 80)}"`);
      if (REFERENCE.test(set)) out.push(`${name} [${environment}]: first sentence points elsewhere instead of naming the purpose: "${set.slice(0, 80)}"`);
    }
  }
  for (const [name, a] of exception) {
    if (!measurement.has(name)) { out.push(`${name}: exception for a tool that does not exist; remove`); continue; }
    const max = longest(measurement.get(name));
    if (max <= BUDGET) out.push(`${name}: exception, but ${max} characters (budget ${BUDGET}); remove`);
    else if (max > a.measured) out.push(`${name}: ${max} characters, measured were ${a.measured}: grown; shorten or raise the number with a reason`);
  }
  return out;
}

let MEASUREMENT = null;
const measurement = async () => (MEASUREMENT ??= await measure());

test("length guard: every description in every run environment is under the truncation limit, within budget or named, with a purpose sentence first", async (t) => {
  const m = await measurement();
  const findings2 = findings(m, EXCEPTIONS);
  assert.deepEqual(findings2, [], findings2.join("\n"));
  // The measurement line (the numbers stand HERE, not in the title; a number in a title ages silently).
  let sum = 0;
  for (const e of m.values()) sum += longest(e);
  t.diagnostic(`length guard: ${m.size} tools in ${Object.keys(ENVIRONMENTS).length} environments, sum of the longest versions ${sum} characters, CLI truncation ${TRUNCATION_CLI} (pin ${MEASURED_ON}), budget ${BUDGET}`);
  for (const a of EXCEPTIONS) t.diagnostic(`exception ${a.name}: ${longest(m.get(a.name))} characters (measured ${a.measured}): ${a.reason}`);
});

test("length guard: the sabotages; each violation delivers exactly its finding", async () => {
  const m = await measurement();
  const copy = () => new Map([...m].map(([k, v]) => [k, v.map((e) => ({ ...e }))]));
  const withText = (name, f) => { const k = copy(); for (const e of k.get(name)) e.text = f(e.text); return k; };
  const onlyOne = (findings2, pattern, fall) => {
    assert.equal(findings2.length >= 1, true, `${fall}: no finding`);
    assert.ok(findings2.every((f) => pattern.test(f)), `${fall}: ${findings2.join(" | ")}`);
  };
  // Budget: a description without an exception extended beyond BUDGET.
  onlyOne(findings(withText("cbase_project_update", (t) => t + " " + "x".repeat(BUDGET)), EXCEPTIONS), /^cbase_project_update .*above the budget/, "Budget");
  // Truncation limit: even an exception must not exceed it.
  // The exception list is empty since the GitLab passthrough left (D2): the exception sabotages run on a planted one — the long
  // variant of cbase_project_update with an exception that covers exactly its measured length.
  const longer = withText("cbase_project_update", (t) => t + " " + "x".repeat(BUDGET));
  const L = longest(longer.get("cbase_project_update"));
  const planted = { name: "cbase_project_update", reason: "Sabotage", measured: L };
  assert.deepEqual(findings(longer, [...EXCEPTIONS, planted]), [], "the planted exception covers the long variant (otherwise the sabotages below say nothing)");
  const tooLong = findings(withText("cbase_project_update", (t) => t + "x".repeat(TRUNCATION_CLI)), [...EXCEPTIONS, { ...planted, measured: 99999 }]);
  onlyOne(tooLong, /^cbase_project_update[ :].*(truncation limit|grown)/, "truncation limit");
  assert.ok(tooLong.some((f) => /above the truncation limit/.test(f)), "truncation limit: the exception does not protect from the hard limit");
  // An additional exception for a tool under the budget.
  onlyOne(findings(m, [...EXCEPTIONS, { name: "cbase_project_update", reason: "Sabotage", measured: 9999 }]), /^cbase_project_update: exception, but/, "exception under budget");
  // Grown: the measured number of an exception below today's.
  onlyOne(findings(longer, [...EXCEPTIONS, { ...planted, measured: L - 1 }]), /^cbase_project_update: .*grown/, "grown");
  // An exception without a reason; one for a tool that does not exist.
  onlyOne(findings(longer, [...EXCEPTIONS, { ...planted, reason: "" }]), /^cbase_project_update: exception without a reason/, "without a reason");
  onlyOne(findings(m, [...EXCEPTIONS, { name: "cbase_exists_not", reason: "Sabotage", measured: 2000 }]), /^cbase_exists_not: .*remove/, "dead tool");
  // The first sentence: too long, too short, without a sentence end, a pointer.
  onlyOne(findings(withText("cbase_project_update", (t) => "Renames " + "a project ".repeat(15) + "again. " + t), EXCEPTIONS), /^cbase_project_update .*first sentence \d+ characters \(at most/, "sentence too long");
  onlyOne(findings(withText("cbase_project_update", () => "Rename."), EXCEPTIONS), /^cbase_project_update .*at least/, "sentence too short");
  onlyOne(findings(withText("cbase_project_update", () => "Rename a project without any sentence end"), EXCEPTIONS), /^cbase_project_update .*without a sentence end/, "without a sentence end");
  onlyOne(findings(withText("cbase_project_update", () => "What this tool does, see below. It renames."), EXCEPTIONS), /^cbase_project_update .*points elsewhere/, "pointer");
  // Coverage: a tool that occurs in no environment.
  const without = copy();
  without.delete("cbase_project_update");
  onlyOne(findings(without, EXCEPTIONS), /^cbase_project_update: measured in no environment/, "Abdeckung");
});

test("length guard: the truncation limit is measured at the pin of the Dockerfile", () => {
  const pin = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(fs.readFileSync(DOCKERFILE, "utf8"))?.[1];
  assert.ok(pin, "no Claude Code pin in server/backend/Dockerfile");
  assert.equal(pin, MEASURED_ON, `The pin jumped to ${pin}; the truncation limit TRUNCATION_CLI (${TRUNCATION_CLI}) was measured at ${MEASURED_ON}: `
    + "re-measure the limit against the new binary (with ENABLE_TOOL_SEARCH=false and =true), update TRUNCATION_CLI and MEASURED_ON.");
});
