// The prefix of a Codex run (providers/connectors/codex-prefix.js): defaults + name list of the MCP tools, only when
// the thread does not demonstrably carry this version.
//
// The promises:
//   (1) The name list is the set the run has: the offering of the REAL cbase MCP server (tools/list) with exactly the
//       environment Codex gives it (argv `-c mcp_servers.cbase.env.*`, `env_vars`, `enabled_tools`) - for the coding
//       chat, subagents at every depth, workflow agents, outer loop, instance, copy with token, manager set, explicit
//       list, Codex whitelist. Sabotage: one name too many, one too few => red.
//   (1b) Foreign servers stand with the name exec uses (measured on 0.162.1: `my-srv` + `tool-name.x` =>
//       `mcp__my_srv__tool_name_x`); unpredictable names through the lookup; a locked server is missing.
//   (1c) The measurement is bound to the Codex pin of the Dockerfile.
//   (1d) Playwright stands with the names of the pinned version (toolchain/playwright-tools.js), the image line
//       (`image(...)` in exec) only with an image tool in the run, and the sentence about ALL_TOOLS does not contradict
//       the exec description. The way through conversion, project switch and way back is held by
//       codex-prefix-relocation.test.js.
//   (2) Main seam (real server as its own process, fake Codex CLI with rollouts like the real one): first turn with
//       block and list; second turn in the same thread without; Codex compacts itself (`compacted` in the rollout) =>
//       again; tool set changes (a skill) => again, new version; server restart (new process, nothing in memory) =>
//       the rollout proves the version, no block; A, B, A (skill gone again) => the first version again; the rollout
//       is missing => resume fails, the retry in the new thread carries it.
//   (3) At the connector: instance switch in the same thread (here 93 -> 98 tools) => again, with the copy tools; main
//       -> copy -> main => every time; fork => block.
//   (4) The proof in the rollout: only the LATEST block counts, verbatim and as response_item - compaction after it,
//       another or old block after it, a quote, only event_msg, only an answer, a forgery with the right marker and
//       the cap are no proof. (4b) The growth after a confirmation: from the last line boundary, and only if the
//       confirmed line still stands unchanged. (4c) Cost linear (count over Buffer.concat, no time bound).
//   (5) Counter-check: the old state (every turn carries the block - emergency switch
//       CBASE_CODEX_PREFIX_EVERY_TURN=1) fails the checks of (2)/(3).
//   (6) Only the home of THIS run is searched (B without instance, else the project home).
// Counter-tests: codex.js `threadId: null` instead of the continued one (every turn like a new thread - the old state)
// => (2) "second turn" and (3) red; codex-prefix.js `verdictTheRow` without the compaction row => (2) "after the
// compaction by Codex" and (4) red; codex-prefix.js `offeringNames({})` instead of the `env` of the server entry =>
// (1) "coding chat with skills", (2) "the list carries the new tool" and (3) red. Only the own marker counts (an older
// version stays valid) => (2) "A, B, A", (3) "copy -> main", (4); header anywhere in the text => (4) quote; event_msg
// counts => (4); only the marker instead of verbatim => (4) "forged header"; confirmed line not re-checked => (4b)
// "overwritten"; boundary = file size => (4b) "needle above the old boundary"; joining per block => (4c) (553,648,128
// bytes instead of 0); all homes => (6); raw names, every name predictable, locked server as a line => (1b);
// MEASURED_ON_CODEX != pin => (1c).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { offeringNames } from "../electron/mcp/offering.js";
import { rolloutOfTheThread, runChatCodex, setCodexHomeSource } from "../electron/server/providers/connectors/codex.js";
import {
  MEASURED_ON_CODEX, PREFIX_SCAN_MAX, codexExecName, codexPrefix, codexToolList, forgetPrefixConfirmation, prefixInThread, prefixMarker,
} from "../electron/server/providers/connectors/codex-prefix.js";
import { PLAYWRIGHT_TOOLS } from "../electron/server/toolchain/playwright-tools.js";
import { readCliPins } from "../../../tools/check/lib/cli-pins.mjs";
import { LOCATION, json, withAgentsServer, setLocation } from "./agent-harness.mjs";

const MCP_SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../electron/mcp/cbase-mcp.js");

// ── The fake Codex CLI: rollouts like the real 0.162.1 (user message as response_item AND event_msg item_completed,
// appended per turn), resume without a rollout => "no rollout found", exit 1, no JSON. Every call writes argv to
// <LOCATION>/codex-calls/NNNN.json.
const fakeCodex = () => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
try { fs.mkdirSync(path.join(LOCATION, "pids"), { recursive: true }); fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const argv = process.argv.slice(2);
const say = (o) => console.log(JSON.stringify(o));
const prompt = argv[argv.length - 1];
const calls = path.join(LOCATION, "codex-calls");
fs.mkdirSync(calls, { recursive: true });
for (let n = 0; ; n++) {
  try { fs.writeFileSync(path.join(calls, String(n).padStart(4, "0") + ".json"), JSON.stringify({ argv, token: process.env.CBASE_TOKEN || null }), { flag: "wx" }); break; }
  catch (e) { if (e.code !== "EEXIST") throw e; }
}
const oi = argv.indexOf("--output-last-message");
if (oi >= 0) { fs.writeFileSync(argv[oi + 1], "Title"); process.exit(0); }
const CH = path.resolve(process.env.CODEX_HOME);
function find(id) {
  let hits = null;
  const go = (d) => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) go(p); else if (x.name.endsWith("-" + id + ".jsonl")) hits = p; } };
  go(path.join(CH, "sessions"));
  return hits;
}
const ri = argv.indexOf("resume");
let id, file;
if (ri >= 0) {
  id = argv[ri + 1];
  file = find(id);
  if (!file) { process.stderr.write("Error: thread/resume: thread/resume failed: no rollout found for thread id " + id + " (code -32600)\\n"); process.exit(1); }
} else {
  id = "019fa000-0000-7000-8000-" + String(process.pid).padStart(6, "0") + String(Date.now()).slice(-6);
  file = path.join(CH, "sessions", "2026", "10", "10", "rollout-2026-10-10T00-00-00-" + id + ".jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: "session_meta", payload: { id, cli_version: "fake" } }) + "\\n");
}
const row = (o) => fs.appendFileSync(file, JSON.stringify(o) + "\\n");
row({ type: "event_msg", payload: { type: "task_started" } });
row({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });
row({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: prompt }] } } });
const response = "Answer " + (prompt.split("\\n").pop() || "").slice(0, 40);
row({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: response }] } });
say({ type: "thread.started", thread_id: id });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: response } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

const calls = (root) => {
  const d = path.join(root, "codex-calls");
  return (fs.existsSync(d) ? fs.readdirSync(d).sort() : []).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
};
const promptOf = (call) => call.argv[call.argv.length - 1];
const resumeOf = (call) => { const i = call.argv.indexOf("resume"); return i >= 0 ? call.argv[i + 1] : null; };
const revisionOf = (prompt) => (/^\[SYSTEM-DEFAULTS \(revision ([0-9a-f]{12})\)/.exec(prompt) || [])[1] || null;

// The checks of (2)/(3) - separate functions so the counter-check (5) sees them fail on the old state.
function checkWithBlock(prompt, what) {
  assert.ok(revisionOf(prompt), `${what}: the turn carries the block (header with version) - it begins with ${JSON.stringify(prompt.slice(0, 80))}`);
  assert.ok(prompt.includes("[END SYSTEM-DEFAULTS]") && prompt.includes("# MCP tools of this run"), `${what}: defaults AND name list in the block`);
}
function checkWithoutBlock(prompt, what) {
  assert.ok(!prompt.includes("[SYSTEM-DEFAULTS"), `${what}: the continued thread already carries the version - the turn must not repeat the block (it begins with ${JSON.stringify(prompt.slice(0, 80))})`);
}

// The names from the block: the lines "- name, name" between the heading and "Other servers".
function namesFromBlock(prompt) {
  const block = prompt.slice(0, prompt.indexOf("[END SYSTEM-DEFAULTS]"));
  const part = block.slice(block.indexOf("# MCP tools of this run")).split("\nOther servers")[0];
  return part.split("\n").filter((z) => z.startsWith("- ")).flatMap((z) => z.slice(2).split(", "));
}

// The environment of the cbase server as Codex gives it - from argv (`-c mcp_servers.cbase.env.K="v"`, `env_vars` from
// the environment of the CLI) - and `enabled_tools`.
function cbaseEnvironmentFromArgv(argv, token) {
  const env = {};
  let enabled = null;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c") continue;
    const a = argv[i + 1];
    let m = /^mcp_servers\.cbase\.env\.([A-Za-z0-9_]+)=([\s\S]*)$/.exec(a);
    if (m) { env[m[1]] = JSON.parse(m[2]); continue; }
    m = /^mcp_servers\.cbase\.env_vars=([\s\S]*)$/.exec(a);
    if (m && JSON.parse(m[1]).includes("CBASE_TOKEN") && token) env.CBASE_TOKEN = token;
    m = /^mcp_servers\.cbase\.enabled_tools=([\s\S]*)$/.exec(a);
    if (m) enabled = JSON.parse(m[1]);
  }
  return { env, enabled };
}

// tools/list of the REAL server - with a clean environment like Codex (no inheritance from the test process).
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const k = spawn(process.execPath, [MCP_SCRIPT], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), CBASE_BASE_URL: "http://127.0.0.1:9", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let finished = false;
    k.stdout.setEncoding("utf8");
    k.stdout.on("data", (d) => {
      buffer += d;
      let i;
      while (!finished && (i = buffer.indexOf("\n")) >= 0) {
        const row = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let msg = null;
        try { msg = JSON.parse(row); } catch { continue; }
        if (msg.id === 2) { finished = true; k.stdin.end(); k.kill(); resolve(msg.result.tools.map((t) => t.name)); }
      }
    });
    k.on("error", reject);
    k.on("exit", (code) => { if (!finished) reject(new Error(`MCP server ended before tools/list (${code})`)); });
    k.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    k.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
}

// As a SET (the list is grouped by families, tools/list stands in catalog order) and without duplicates.
function compareNames(list, offering, what) {
  assert.equal(new Set(list).size, list.length, `${what}: the name list names no name twice`);
  assert.deepEqual([...list].sort(), [...offering].sort(), `${what}: the name list in the block is the offering of the run (tools/list)`);
}

async function withEnvironment(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ── (1) Name list == offering of the real server, across the environments of real runs ───────────────────────────────────────
const ENVIRONMENTS = [
  ["Coding chat", {}],
  ["Coding chat with skills", { CBASE_SKILLS: '["grill"]' }],
  ["Subagent depth 1", { CBASE_AGENT_DEPTH: "1", CBASE_SKILLS: '["grill"]' }],
  ["Subagent depth 3 (explicit list)", { CBASE_AGENT_DEPTH: "3", CBASE_TOOLS: JSON.stringify(CATALOG_NAMES.slice(0, 40)) }],
  ["Workflow agent with schema", { CBASE_WORKFLOW_AGENT: "a1", CBASE_SCHEMA: '{"type":"object"}', CBASE_SCHEMA_REFERENCE: "b" }],
  ["Outer loop", { CBASE_OUTER_LOOP: "a:l", CBASE_TOOLS: '["cbase_chat_analysis","cbase_projects_list","cbase_ask"]' }],
  ["Instance (main)", { CBASE_INSTANCE: "p1/main", CBASE_SKILLS: '["grill"]' }],
  ["Copy with token", { CBASE_INSTANCE: "p1/copy-x", CBASE_TOKEN: "secret" }],
  ["Pipeline (named set)", { CBASE_TOOLSET: "manager" }],
  ["Manager agent (explicit list)", { CBASE_TOOLS: '["cbase_fact_search","cbase_proposal_submit","cbase_todo_create"]', CBASE_SKILLS: '["x"]' }],
  ["Unreadable list", { CBASE_TOOLS: "broken" }],
];

test("(1) name list == tools/list of the real server per run - with enabled_tools; one name too many or too few is red", async () => {
  const counts = [];
  for (const [what, env] of ENVIRONMENTS) {
    const offering = await toolsList(env);
    const list = codexToolList({ cbase: { command: "node", args: [], env } });
    const names = namesFromBlock(`${list}\n[END SYSTEM-DEFAULTS]`);
    compareNames(names, offering, what);
    assert.deepEqual(offeringNames(env), offering, `${what}: offering.js computes what the server offers`);
    counts.push(`${what} ${offering.length}`);
  }
  // Codex' whitelist cuts further (pushMcpConfig `enabled_tools`): the list names only the intersection.
  const only = ["cbase_projects_list", "cbase_ask", "cbase_exists_not"];
  const cut = namesFromBlock(`${codexToolList({ cbase: { env: {}, enabledTools: only } })}\n[END SYSTEM-DEFAULTS]`);
  assert.deepEqual(cut, (await toolsList({})).filter((n) => only.includes(n)), "enabled_tools: only what server AND whitelist have");
  // Sabotage: the computation with a catalog that has one name too many or too few fails the comparison.
  const real = await toolsList({});
  assert.throws(() => compareNames(offeringNames({}, [...CATALOG_NAMES, "cbase_invented"]), real, "Sabotage +1"), /name list/);
  assert.throws(() => compareNames(offeringNames({}, CATALOG_NAMES.filter((n) => n !== "cbase_context_list")), real, "Sabotage −1"), /name list/);
  console.log(`[codex-prefix] offering per run: ${counts.join(" · ")}`);
});

// Measured on Codex 0.162.1 (real exec call): server `my-srv`, raw tool name -> name in
// ALL_TOOLS. The simple rule (every character except [A-Za-z0-9_] becomes `_`) holds for these names; the other measured
// cases (`__a` => `mcp__my_srv__a`, `Ünï` => `mcp__my_srv_n_`, collisions with a hash suffix) are NOT predictable and are
// looked up.
const MEASURED_SIMPLE = [
  ["tool-name.x", "mcp__my_srv__tool_name_x"],
  ["a b", "mcp__my_srv__a_b"],
  ["UPPER_low", "mcp__my_srv__UPPER_low"],
  ["1start", "mcp__my_srv__1start"],
  ["a___b", "mcp__my_srv__a___b"],
  ["x_y", "mcp__my_srv__x_y"],
  ["x".repeat(70), `mcp__my_srv__${"x".repeat(70)}`],
];

test("(1b) foreign servers: the names as exec uses them (measured), special cases through the lookup; locked is missing", () => {
  for (const [raw, inExec] of MEASURED_SIMPLE) assert.equal(codexExecName("my-srv", raw), inExec, `measured: ${raw}`);
  // cbase's own names never fall under the rewriting - the short form `mcp__cbase__<name>` of the hint holds.
  assert.deepEqual(CATALOG_NAMES.filter((n) => codexExecName("cbase", n) !== `mcp__cbase__${n}` || !/^[A-Za-z0-9]/.test(n)), [], "cbase tool names only from [A-Za-z0-9_], a letter first");

  const list = codexToolList({
    cbase: { env: {} },
    "my-srv": { command: "x", enabledTools: ["tool-name.x", "a b", "Ünï", "a--b", "a.-b"] },
    pg: { command: "x", enabledTools: ["query"] },
    locked: { command: "x", enabledTools: [] },
    "play-wright": { command: "npx" },
  });
  assert.match(list, /^- my-srv: mcp__my_srv__tool_name_x, mcp__my_srv__a_b — plus 3 with special characters in the name, via `ALL_TOOLS\.filter\(\(x\) => x\.name\.startsWith\("mcp__my_srv_"\)\)/m,
    "predictable in full; non-ASCII and the two colliding ones (a--b, a.-b => a__b) through the lookup");
  assert.match(list, /^- pg: mcp__pg__query$/m);
  assert.match(list, /^- play-wright: names via `ALL_TOOLS\.filter\(\(x\) => x\.name\.startsWith\("mcp__play_wright_"\)\)/m, "the pattern with the rewritten server name");
  assert.doesNotMatch(list, /^- locked/m, "a server with enabled_tools [] is locked and missing");
  assert.doesNotMatch(list, /mcp__my-srv|mcp__play-wright/, "no raw server name in a name or pattern");
  assert.equal(codexToolList({ locked: { command: "x", enabledTools: [] } }), "", "only a locked server: no list");
  assert.equal(codexToolList({}), "", "without a server no list");
});

// (1d) The system prompt names Playwright tools bare (browser_tabs, browser_take_screenshot ...), the list named only the
// lookup for Playwright; images in a tool result Codex sees only through `image(...)` in exec
// (measured on the wire); and the sentence about ALL_TOOLS contradicted the exec description
// ("filter ALL_TOOLS by name"). Counter-tests: codexToolList without the Playwright branch; the image line -> "";
// the old sentence "instead of searching ALL_TOOLS broadly".
test("(1d) Playwright with names, the image line only with image tools, no contradiction to the exec description", () => {
  const list = codexToolList({ cbase: { env: {} }, playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.84"] } });
  const row = list.split("\n").find((z) => z.startsWith("- playwright"));
  assert.ok(row, "a line for Playwright");
  assert.doesNotMatch(row, /ALL_TOOLS/, "Playwright no longer through the lookup");
  assert.match(row, /^- playwright \(in exec `mcp__playwright__<name>`\): /);
  assert.deepEqual(row.split("): ")[1].split(", "), [...PLAYWRIGHT_TOOLS], "all names of the pinned version, in order");
  for (const n of ["browser_tabs", "browser_take_screenshot", "browser_navigate", "browser_snapshot"]) assert.ok(row.includes(n), n);
  // enabled_tools cuts here too; [] locks.
  const cut = codexToolList({ playwright: { command: "npx", enabledTools: ["browser_tabs", "browser_exists_not"] } });
  assert.match(cut, /^- playwright: mcp__playwright__browser_tabs$/m);
  assert.equal(codexToolList({ playwright: { command: "npx", enabledTools: [] } }), "");
  // The image line: with a cbase capture or Playwright screenshot in the run, otherwise not.
  assert.match(list, /image\(r\.content\.find\(\(x\) => x\.type === "image"\)\)/);
  assert.match(list, /mcp__cbase__cbase_screenshot/);
  assert.match(list, /mcp__playwright__browser_take_screenshot\)/);
  assert.match(list, /image\(await tools\.view_image\(\{ path \}\)\)/);
  const withoutImage = codexToolList({ cbase: { env: { CBASE_TOOLS: '["cbase_projects_list"]' } } });
  assert.doesNotMatch(withoutImage, /image\(/, "without an image tool no image line");
  // ALL_TOOLS: no "instead of ... searching" against "To find one, filter ALL_TOOLS by name and description" of the CLI.
  assert.doesNotMatch(list, /instead of [^.]*ALL_TOOLS/);
  assert.match(list, /the names are listed here in full/);
});

test("(1c) the measurement is bound to the Codex pin: a jump is red until codex-exec-call.cjs is re-measured", () => {
  const dockerfile = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../Dockerfile"), "utf8");
  const pin = readCliPins(dockerfile).codex;
  assert.equal(MEASURED_ON_CODEX, pin,
    `codex-prefix.js is measured on Codex ${MEASURED_ON_CODEX}, the Dockerfile pins ${pin}: re-measure against the codex-${pin} binary `
    + "(ALL_TOOLS shape, input verbatim as response_item, resume in the same rollout, name rule), put the result in the header of codex-prefix.js, then bring MEASURED_ON_CODEX along");
});

// ── (2) Main seam: real server as its own process ─────────────────────────────────────────────────────────────────────
test("(2) Codex chat: block in the first turn, not in the second; again after compaction, tool-set change and failed resume; after a restart the rollout proves it", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-prefix-home-"));
  try {
    await withEnvironment({ CODEX_HOME: codexHome, CBASE_CODEX_PREFIX_EVERY_TURN: undefined }, () => withAgentsServer(async (ctx) => {
      const { base, ws, root } = ctx;
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex prefix" }) });
      let n = 0;
      const turn = async (text) => {
        const prior = calls(root).length;
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
        n += 1;
        await ctx.waitForLog(chat.id, (log) => log.filter((m) => m.role === "assistant").length >= n);
        await ctx.waitForQuiet();
        return calls(root).slice(prior);
      };
      const rollout = (id) => { let t = null; const go = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else if (e.name.endsWith(`-${id}.jsonl`)) t = p; } }; go(path.join(codexHome, "sessions")); return t; };

      // Turn 1: new thread => block with defaults and list; the list is the offering of the server with the environment from argv.
      const [one] = await turn("ONE");
      const p1 = promptOf(one);
      checkWithBlock(p1, "first turn");
      assert.equal(resumeOf(one), null);
      assert.match(p1, /\n\nONE$/, "the input stands behind the block");
      const { env, enabled } = cbaseEnvironmentFromArgv(one.argv, one.token);
      assert.equal(env.CBASE_CHAT_ID, chat.id, "the environment comes from the argv of the run");
      const offering = (await toolsList(env)).filter((x) => !enabled || enabled.includes(x));
      compareNames(namesFromBlock(p1), offering, "first turn");
      const f1 = revisionOf(p1);

      // Turn 2: same thread, nothing changed => no block.
      const [two] = await turn("TWO");
      const thread = resumeOf(two);
      assert.ok(thread && rollout(thread), "turn 2 continues the thread of turn 1, and it has its rollout");
      checkWithoutBlock(promptOf(two), "second turn");
      assert.equal(promptOf(two), "TWO");

      // Codex compacts the thread itself: the replacement history does not reliably carry the block => the next turn brings it.
      fs.appendFileSync(rollout(thread), JSON.stringify({ type: "compacted", payload: { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: p1.slice(0, 300) }] }] } }) + "\n");
      const [three] = await turn("THREE");
      assert.equal(resumeOf(three), thread);
      checkWithBlock(promptOf(three), "after the compaction by Codex");
      assert.equal(revisionOf(promptOf(three)), f1, "the same version - only the compaction displaced it");
      const [four] = await turn("FOUR");
      checkWithoutBlock(promptOf(four), "after the renewed delivery");

      // Tool set changes => new version, in the same thread. A skill used to bring cbase_skill newly into the set; since
      // then the main run of a coding chat always has it (it may write skills) - the change is therefore the switch
      // "agents may change skills": off => cbase_skill_write drops out of the set.
      const skill = await json(`${base}/api/workspaces/${ws.id}/skills`, { method: "POST", body: JSON.stringify({ name: "grill", area: "coding", description: "Puts a plan to the test.", body: "Instructions." }) });
      await json(`${base}/api/workspaces/${ws.id}/skill-settings`, { method: "PUT", body: JSON.stringify({ agentsWrite: false }) });
      const [five] = await turn("FIVE");
      assert.equal(resumeOf(five), thread);
      const p5 = promptOf(five);
      checkWithBlock(p5, "after the tool-set change");
      assert.notEqual(revisionOf(p5), f1, "a new version");
      assert.ok(!namesFromBlock(p5).includes("cbase_skill_write") && namesFromBlock(p1).includes("cbase_skill_write"), "the list loses the write tool");
      assert.ok(namesFromBlock(p5).includes("cbase_skill") && namesFromBlock(p1).includes("cbase_skill"), "the read tool stays");
      const u5 = cbaseEnvironmentFromArgv(five.argv, five.token);
      compareNames(namesFromBlock(p5), (await toolsList(u5.env)).filter((x) => !u5.enabled || u5.enabled.includes(x)), "after the tool-set change");

      // Server restart (new PROCESS - nothing in memory): the rollout proves the version => no block.
      await ctx.restart();
      const [six] = await turn("SIX");
      assert.equal(resumeOf(six), thread);
      checkWithoutBlock(promptOf(six), "after the restart (the rollout proves the version)");

      // A, B, A: the skill drops out again => again the version of turn 1 - it stands further back in the rollout, but
      // the LATEST block is that of FIVE, and "a newer version replaces this one entirely" => the block comes again.
      await json(`${base}/api/workspaces/${ws.id}/skills/${skill.id}`, { method: "DELETE" });
      await json(`${base}/api/workspaces/${ws.id}/skill-settings`, { method: "PUT", body: JSON.stringify({ agentsWrite: true }) });
      const [seven] = await turn("SEVEN");
      assert.equal(resumeOf(seven), thread);
      checkWithBlock(promptOf(seven), "A, B, A (skill and switch back)");
      assert.equal(revisionOf(promptOf(seven)), f1, "the version of turn 1, delivered again");

      // The rollout is missing => resume fails, the retry (new thread) carries the block.
      fs.rmSync(rollout(thread));
      const attempts = await turn("EIGHT");
      assert.equal(attempts.length, 2, `failed resume and retry: ${attempts.map(resumeOf).join(", ")}`);
      assert.equal(resumeOf(attempts[0]), thread);
      assert.equal(resumeOf(attempts[1]), null, "the retry starts a new thread");
      checkWithBlock(promptOf(attempts[1]), "after a failed resume");
      assert.equal(revisionOf(promptOf(attempts[1])), f1);
      const [nine] = await turn("NINE");
      assert.ok(resumeOf(nine) && resumeOf(nine) !== thread, "the chat continues the new thread");
      checkWithoutBlock(promptOf(nine), "in the new thread after the retry");
      console.log(`[codex-prefix] turn 1: ${p1.length} characters prefix+input, turn 2: ${promptOf(two).length}; names ${namesFromBlock(p1).length} → ${namesFromBlock(p5).length}`);
    }, { codex: fakeCodex(), childProcess: true }));
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

// ── (3) At the connector: instance switch, fork; (5) counter-check ──────────────────────────────────────────────────────────────
async function withConnector(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-prefix-"));
  const bin = path.join(root, "fake-codex");
  fs.writeFileSync(bin, setLocation(fakeCodex(), root));
  fs.chmodSync(bin, 0o755);
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome);
  try {
    return await withEnvironment({ CODEX_BIN: bin, CODEX_HOME: codexHome }, () => fn({
      root,
      turn: async ({ input, sessionId = "", forkPending = false, env = {}, systemPrompt = "Defaults of the test." }) => {
        let handle = null;
        const prior = calls(root).length;
        const res = await runChatCodex({
          spec: { cwd: root, input, systemPrompt, model: "", effort: "", permissionMode: "bypassPermissions", sessionId, forkPending, addDirs: [],
            mcpServers: { cbase: { command: process.execPath, args: [MCP_SCRIPT], env: { CBASE_BASE_URL: "http://127.0.0.1:9", ...env } } } },
          onSpawn: (h) => { handle = h; },
          onEvent: (e) => { if (e.type === "result") handle.cbaseEndInput(); },
        });
        assert.equal(res.code, 0, res.stderr);
        const [call] = calls(root).slice(prior);
        return { res, call, prompt: promptOf(call) };
      },
    }));
  } finally {
    forgetPrefixConfirmation();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("(3) connector: an instance switch in the same thread brings the block back with the copy tools; a fork always carries it", async () => {
  await withConnector(async ({ turn }) => {
    const a = await turn({ input: "A" });
    checkWithBlock(a.prompt, "new thread");
    const thread = a.res.sessionId;
    const b = await turn({ input: "B", sessionId: thread });
    checkWithoutBlock(b.prompt, "same thread without a change");
    // Instance switch (CBASE_INSTANCE at the cbase server) - the set grows by the copy tools.
    const c = await turn({ input: "C", sessionId: thread, env: { CBASE_INSTANCE: "p1/main" } });
    checkWithBlock(c.prompt, "after the instance switch");
    const prior = namesFromBlock(a.prompt);
    const after = namesFromBlock(c.prompt);
    assert.deepEqual(after.filter((x) => !prior.includes(x)), ["cbase_copy_stack", "cbase_copy_stack_list", "cbase_copy_stack_fetch", "cbase_copy_stack_remove", "cbase_switch_instance"]);
    compareNames(after, await toolsList({ CBASE_INSTANCE: "p1/main" }), "after the instance switch");
    const d = await turn({ input: "D", sessionId: thread, env: { CBASE_INSTANCE: "p1/main" } });
    checkWithoutBlock(d.prompt, "after the delivery of the new version");
    // Main -> copy -> main (the chat switches into a copy and back): the version of main stands further back in the
    // thread, the latest block is that of the copy => back in main the block comes again.
    const copy = await turn({ input: "K", sessionId: thread, env: { CBASE_INSTANCE: "p1/copy-x" }, systemPrompt: "Defaults of the test. You work in copy x." });
    checkWithBlock(copy.prompt, "into the copy");
    assert.ok(!namesFromBlock(copy.prompt).includes("cbase_copy_stack"), "in a copy the creation is missing");
    const back = await turn({ input: "H", sessionId: thread, env: { CBASE_INSTANCE: "p1/main" } });
    checkWithBlock(back.prompt, "copy -> main");
    assert.equal(revisionOf(back.prompt), revisionOf(c.prompt), "the version of main, delivered again");
    const again = await turn({ input: "H2", sessionId: thread, env: { CBASE_INSTANCE: "p1/main" } });
    checkWithoutBlock(again.prompt, "main, nothing changed");
    // A fork (forkPending) is a new thread - block, even if the session it branches from carries it.
    const e = await turn({ input: "E", sessionId: thread, forkPending: true, env: { CBASE_INSTANCE: "p1/main" } });
    checkWithBlock(e.prompt, "Fork");
    assert.equal(resumeOf(e.call), null);
    console.log(`[codex-prefix] instance switch: ${prior.length} -> ${after.length} names`);
  });
});

test("(5) counter-check: the old state (every turn with a block) fails the check of the second turn", async () => {
  await withEnvironment({ CBASE_CODEX_PREFIX_EVERY_TURN: "1" }, () => withConnector(async ({ turn }) => {
    const a = await turn({ input: "A" });
    const b = await turn({ input: "B", sessionId: a.res.sessionId });
    assert.equal(resumeOf(b.call), a.res.sessionId);
    assert.throws(() => checkWithoutBlock(b.prompt, "second turn"), /must not repeat the block/);
    assert.equal(revisionOf(b.prompt), revisionOf(a.prompt), "on the old state: the same version again in the same thread");
  }));
});

// ── (4) The proof in the rollout ──────────────────────────────────────────────────────────────────────────────────────────
// Rollout lines as Codex 0.162.1 writes them (codex-exec-call.cjs part b): the input verbatim as response_item
// message role user, beside it event_msg item_completed UserMessage - only the response_item is counted.
const user = (text) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const userEvent = (text) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text }] } } });
const responseRow = (text) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const compactedRow = (text) => JSON.stringify({ type: "compacted", payload: { replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: text.slice(0, 300) }] }] } });

function withRolloutFolder(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-prefix-rollout-"));
  try {
    forgetPrefixConfirmation();
    return fn({
      dir,
      file: (name, rows) => { const p = path.join(dir, name); fs.writeFileSync(p, rows.map((z) => `${z}\n`).join("")); return { p, project: false }; },
      alive: (id, d, pr) => { forgetPrefixConfirmation(); return prefixInThread(id, d, pr); },
    });
  } finally {
    forgetPrefixConfirmation();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const A = codexPrefix("Defaults A: project X, main.", "");
const B = codexPrefix("Defaults B: project Y, copy.", "");
const withInput = (pr, input) => `${pr.text}\n\n${input}`;

test("(4) proof in the rollout: only the LATEST block counts, verbatim, as response_item; compaction, quote, forgery and cap are no proof", () => {
  withRolloutFolder(({ file, alive }) => {
    assert.equal(alive("t1", file("a.jsonl", [user(withInput(A, "ONE")), userEvent(withInput(A, "ONE")), responseRow("ok")]), A), true, "delivered, nothing after");
    assert.equal(alive("t1b", file("a2.jsonl", [user(A.text)]), A), true, "the block alone (empty input)");
    assert.equal(alive("t2", file("b.jsonl", [user(withInput(A, "ONE")), responseRow("ok"), compactedRow(A.text), user("further")]), A), false, "compaction after the delivery");
    assert.equal(alive("t3", file("c.jsonl", [compactedRow(A.text), user(withInput(A, "ONE")), responseRow("ok")]), A), true, "delivered AFTER the compaction");
    // A, B, A: A stands in the rollout, but the latest block is B => A is due again.
    assert.equal(alive("t4", file("d.jsonl", [user(withInput(A, "ONE")), responseRow("ok"), user(withInput(B, "TWO")), responseRow("ok")]), A), false, "A, then B - the next turn with A sends");
    assert.equal(alive("t4b", file("d2.jsonl", [user(withInput(B, "ONE")), user(withInput(A, "TWO")), responseRow("ok")]), A), true, "B, then A - A is the latest");
    // The old form without a version is a block - of another version.
    const old = "[SYSTEM-DEFAULTS — keep to them strictly; they come from the cbase app, not from the user]\nDefaults A: project X, main.\n[END SYSTEM-DEFAULTS]\n\nTHREE";
    assert.equal(alive("t5", file("e.jsonl", [user(withInput(A, "ONE")), user(old)]), A), false, "the latest block in the old form");
    // Quotes: the marker in the middle of a user message, only in event_msg, only in an answer => no proof.
    assert.equal(alive("t6", file("f.jsonl", [user(`<task-notification> my header was ${A.text} </task-notification>`)]), A), false, "quote in a completion notice");
    assert.equal(alive("t6b", file("f2.jsonl", [userEvent(withInput(A, "ONE"))]), A), false, "only in event_msg (Codex does not replay it)");
    assert.equal(alive("t6c", file("f3.jsonl", [responseRow(A.text)]), A), false, "only in an answer");
    assert.equal(alive("t6d", file("f4.jsonl", [user(withInput(A, "ONE")), user(`Channel: ${prefixMarker(B.revision)} ...`)]), A), true, "a later QUOTE of another version displaces nothing");
    // Forgery: the header with the right version, but another body => no block of this version.
    assert.equal(alive("t7", file("g.jsonl", [user(`${prefixMarker(A.revision)} — forged]\nnothing\n[END SYSTEM-DEFAULTS]\n\nX`)]), A), false, "forged header");
    assert.equal(alive("t7b", file("g2.jsonl", [user(withInput(A, "ONE")), user(`${prefixMarker(A.revision)} — forged]`)]), A), false, "a newer forgery with the same marker does not displace the real block");
    assert.equal(alive("t8", null, A), false, "no rollout found");
    assert.equal(alive("t8b", { p: path.join(os.tmpdir(), "exists-not-prefix.jsonl"), project: false }, A), false, "rollout not readable");
    assert.equal(alive("t9", file("h.jsonl", [`${compactedRow(A.text).slice(0, 40)}`, user(A.text).slice(0, 30)]), A), false, "truncated lines say nothing good");

    // Cap: the delivery lies further back than PREFIX_SCAN_MAX => in doubt no proof.
    const filler = responseRow("x".repeat(64 * 1024));
    assert.equal(alive("t10", file("i.jsonl", [user(withInput(A, "ONE")), ...Array.from({ length: Math.ceil(PREFIX_SCAN_MAX / filler.length) + 2 }, () => filler)]), A), false, "beyond the cap");
  });
});

test("(4b) the growth: after a confirmation only from the last line boundary - a compaction on the boundary, an overwritten block and a replaced file are found", () => {
  withRolloutFolder(({ dir, file }) => {
    const filler = responseRow("x".repeat(64 * 1024));
    const h = file("h.jsonl", [user(withInput(A, "ONE")), ...Array.from({ length: 40 }, () => filler)]);
    assert.equal(prefixInThread("th", h, A), true);
    fs.appendFileSync(h.p, `${responseRow("further")}\n`);
    assert.equal(prefixInThread("th", h, A), true, "growth without compaction: still confirmed");
    fs.appendFileSync(h.p, `${user(withInput(B, "TWO"))}\n`);
    assert.equal(prefixInThread("th", h, A), false, "another block in the growth");

    // At the confirmation the last line is truncated (Codex is writing right now), the needle `"type":"compacted"` lies
    // above the boundary. The boundary must not lie in the middle of the line - otherwise the growth sees only `acted"}`
    // and keeps confirming.
    const v = JSON.stringify({ payload: { replacement_history: [] }, type: "compacted" });
    const cut = v.indexOf('"compacted"') + 5;
    const k = file("k.jsonl", [user(withInput(A, "ONE"))]);
    fs.appendFileSync(k.p, v.slice(0, cut));
    forgetPrefixConfirmation();
    assert.equal(prefixInThread("tk", k, A), true, "truncated, still without the needle: the block is the latest");
    fs.appendFileSync(k.p, `${v.slice(cut)}\n`);
    assert.equal(prefixInThread("tk", k, A), false, "the needle above the old boundary is found");

    // After the confirmation the real block in the rollout is overwritten (same length, same inode) and growth is
    // appended - the growth alone would see nothing; the confirmed line no longer stands there => read it all => no block.
    forgetPrefixConfirmation();
    const real = user(withInput(A, "ONE"));
    const m = file("m.jsonl", [responseRow("prior"), real, responseRow("ok")]);
    assert.equal(prefixInThread("tm", m, A), true);
    const fallback = Buffer.from(user("x".repeat(Buffer.byteLength(real) - Buffer.byteLength(user("")))));
    assert.equal(fallback.length, Buffer.byteLength(real));
    const fd = fs.openSync(m.p, "r+");
    try { fs.writeSync(fd, fallback, 0, fallback.length, Buffer.byteLength(`${responseRow("prior")}\n`)); } finally { fs.closeSync(fd); }
    fs.appendFileSync(m.p, `${responseRow("afterwards")}\n`);
    assert.equal(prefixInThread("tm", m, A), false, "the confirmed block was overwritten");

    // A replaced file (other inode) is read in full, not from the old spot.
    forgetPrefixConfirmation();
    assert.equal(prefixInThread("th2", h, B), true);
    fs.writeFileSync(path.join(dir, "h2.jsonl"), `${responseRow("fresh")}\n`.repeat(2000));
    fs.renameSync(path.join(dir, "h2.jsonl"), h.p);
    assert.equal(prefixInThread("th2", h, B), false, "replaced file without a block");
  });
});

test("(4c) cost: a line over many blocks is joined ONCE - 40 MiB without a line break cost no Buffer.concat", () => {
  withRolloutFolder(({ dir }) => {
    const p = path.join(dir, "large.jsonl");
    fs.writeFileSync(p, "");
    fs.truncateSync(p, 40 * 1024 * 1024); // sparse: 40 MiB of zero bytes, no line break
    const real = Buffer.concat;
    let bytes = 0;
    Buffer.concat = (list, ...rest) => { bytes += list.reduce((s, b) => s + b.length, 0); return real.call(Buffer, list, ...rest); };
    try {
      assert.equal(prefixInThread("tg", { p, project: false }, A), false, "beyond the cap, without a line");
      assert.equal(bytes, 0, `without a line break nothing is joined (old: ${32} growing copies, about 528 MiB)`);
      // A line over three blocks, then a block with a line break: joined exactly once, at most as large as read.
      const row = user(withInput(A, "x".repeat(3 * 1024 * 1024)));
      fs.writeFileSync(p, `${responseRow("beforehand")}\n${row}\n`);
      bytes = 0;
      forgetPrefixConfirmation();
      assert.equal(prefixInThread("tg2", { p, project: false }, A), true, "the long line is the block");
      assert.ok(bytes <= fs.statSync(p).size, `joined ${bytes} bytes at ${fs.statSync(p).size} read (linear, not quadratic)`);
    } finally {
      Buffer.concat = real;
    }
  });
});

test("(6) the rollout counts only in the home of THIS run: B for a run without an instance, the project home for a run in the project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-prefix-homes-"));
  const homeB = path.join(root, "b", ".codex");
  const homeP = path.join(root, "projects", "p1", "home", ".codex");
  const id = "019fa111-2222-7333-8444-555566667777";
  const create = (home) => {
    const p = path.join(home, "sessions", "2026", "10", "10", `rollout-2026-10-10T00-00-00-${id}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${user(withInput(A, "ONE"))}\n`);
    return p;
  };
  try {
    await withEnvironment({ CODEX_HOME: homeB }, () => {
      setCodexHomeSource(() => [homeP], (pid) => (pid === "p1" ? homeP : null));
      try {
        const onlyProject = create(homeP);
        assert.equal(rolloutOfTheThread(id, null), null, "a run in B does not see the rollout in the project home (Codex in B would not find it either)");
        assert.deepEqual(rolloutOfTheThread(id, { projectId: "p1", instance: "main" }), { p: onlyProject, project: true }, "a run in the project reads its home - as the project home (descriptor way)");
        assert.equal(rolloutOfTheThread(id, { projectId: "p2", instance: "main" }), null, "another project: another home");
        const inB = create(homeB);
        assert.deepEqual(rolloutOfTheThread(id, null), { p: inB, project: false });
        setCodexHomeSource(() => [homeP]); // without the source of the project home: no proof for a run in the project
        assert.equal(rolloutOfTheThread(id, { projectId: "p1", instance: "main" }), null);
      } finally {
        setCodexHomeSource(null);
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
