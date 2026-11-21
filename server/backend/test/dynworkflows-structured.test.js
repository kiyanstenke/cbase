// StructuredOutput of a dynamic workflow, through the main-seam harness: real server, real cbase MCP server, real agent
// core; only the providers are fakes. `agent(prompt, {schema})` returns a validated object, identically on Claude, Codex
// and the loop engine: schema via environment to the MCP server, the StructuredOutput messenger, validation in the server
// with ajv, one follow-up nudge, `null` plus log() after 5 failed attempts. Also: messenger visibility in every tool cut
// (MCP server by spawn) and the contract of the validation route.
//
// Counter-tests (which sabotage turns which test red):
//   - mcp/offering.js without the `outside` exception in the TOOL_LIST branch => "visibility" fails with an explicit list
//     set (and with a definition's list);
//   - the follow-up logic without the nudge => "follow-up" fails: agent() returns null after ONE turn;
//   - agent-set.js engineAllowlist without `bote` => "engine cut" fails: the list takes the messenger from the engine;
//   - providers/engine.js without the messenger in ALWAYS_ON => "Codex and loop engine" fails: it hides behind ToolSearch;
//   - structured.js with the old marker (`message` opens only an already accepted object, acceptance closes it again) =>
//     "message during turn 1" fails: the script gets the object from BEFORE the message.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { engineAllowlist, workflowAgentSet } from "../electron/server/runs/agent-set.js";
import { FAILED_ATTEMPTS_MAX, FOLLOW_UP, SchemaError, checkSchema } from "../electron/server/dynworkflows/structured.js";
import * as store from "../electron/server/store.js";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const BOTE = "StructuredOutput";
const SCHEMA = { type: "object", properties: { count: { type: "integer" }, word: { type: "string" } }, required: ["count"], additionalProperties: false };

// ── Visibility: tools/list of the MCP server by spawn ────────────────────────────────────────────────────────────────
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const empty = { CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_WORKFLOW_AGENT: undefined, CBASE_SCHEMA: undefined, CBASE_SCHEMA_REFERENCE: undefined };
    const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, ...empty, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const row = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!row) continue;
        const m = JSON.parse(row);
        if (m.id === 2) { child.stdin.end(); resolve(m.result.tools); }
      }
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}
const withSchema = (env = {}) => ({ CBASE_SCHEMA: JSON.stringify(SCHEMA), CBASE_SCHEMA_REFERENCE: "so_test", ...env });
const bote = (tools) => tools.find((t) => t.name === BOTE) || null;

test("visibility: the messenger is in tools/list only with a schema — and survives explicit list, named set, depth, marker and a definition's list", async () => {
  assert.equal(bote(await toolsList({})), null, "without a schema it is absent");
  assert.equal(bote(await toolsList({ CBASE_SCHEMA: "{broken" })), null, "an unreadable schema is no schema");
  assert.equal(bote(await toolsList({ CBASE_SCHEMA: "[1]" })), null, "a non-object is no schema");
  const free = bote(await toolsList(withSchema()));
  assert.ok(free, "with a schema it is present");
  assert.deepEqual(free.inputSchema, SCHEMA, "its input schema IS the call's schema");
  // A definition's list 1:1 — computed like for a workflow agent with `tools: ["Read"]`.
  const definition = workflowAgentSet({ parent: { cbase: null, builtin: null }, required: ["Read"] });
  assert.deepEqual(definition.cbase, [], "precondition: the list leaves no cbase name");
  const agentType = workflowAgentSet({ parent: { cbase: null, builtin: null }, required: ["Read", "cbase_projects_list", "cbase_agent", "cbase_dynamic_workflow"] });
  assert.deepEqual(agentType.cbase, ["cbase_projects_list"], "precondition: the block list is mixed in");
  const cuts = {
    "explicit list": { CBASE_TOOLS: JSON.stringify(["cbase_projects_list"]) },
    "a definition's list": { CBASE_TOOLS: JSON.stringify(definition.cbase), CBASE_WORKFLOW_AGENT: "a-def" },
    // (No named set: none is named any more.)
    "depth 3": { CBASE_AGENT_DEPTH: "3" },
    "workflow-agent marker": { CBASE_WORKFLOW_AGENT: "a-wf", CBASE_AGENT_DEPTH: "1" },
    // An agentType whose list is cut with the mixed-in block list of the workflow agents.
    "agentType with mixed-in block list": { CBASE_TOOLS: JSON.stringify(agentType.cbase), CBASE_WORKFLOW_AGENT: "a-type" },
  };
  for (const [what, env] of Object.entries(cuts)) {
    assert.equal(bote(await toolsList(env)), null, `${what}: absent without a schema`);
    assert.ok(bote(await toolsList(withSchema(env))), `${what}: with a schema it survives the cut`);
  }
  // The same on the running agent of a definition (agent() with schema AND agentType): dynworkflows-agent-type.test.js.
});

test("engine cut: the allowlist of a list carries the messenger when the start has a schema — otherwise not; without a list no filter", () => {
  const set = workflowAgentSet({ parent: { cbase: null, builtin: null }, required: ["Read"] });
  assert.deepEqual(engineAllowlist(set), ["Read"]);
  assert.deepEqual(engineAllowlist(set, { bote: true }), ["Read", `mcp__cbase__${BOTE}`]);
  assert.equal(engineAllowlist({ cbase: null, builtin: null, extern: null }, { bote: true }), null, "without a list there is no filter");
  assert.deepEqual(engineAllowlist({ cbase: null, builtin: ["Read"], extern: {} }, { bote: true }), ["Read", "mcp__cbase__*"], "a whole cbase server already carries it");
});

test("schema check: root object with properties, required ⊆ properties, ajv compiles — otherwise a throw with the reason", () => {
  assert.equal(typeof checkSchema(SCHEMA), "function");
  const raises = (schema, pattern) => assert.throws(() => checkSchema(schema), (e) => e instanceof SchemaError && pattern.test(e.message), JSON.stringify(schema));
  raises({ type: "array", items: {} }, /root schema must declare type: 'object'/);
  raises(null, /root schema must declare type: 'object'/);
  raises({ type: "object" }, /properties/);
  raises({ type: "object", properties: { a: {} }, required: ["a", "b"] }, /required "b" not in properties/);
  raises({ type: "object", properties: { a: { type: "intger" } } }, /received an invalid JSON Schema/);
});

// ── The providers ────────────────────────────────────────────────────────────────────────────────────────────────────
// A workflow agent with marker {TAG:x} and plan {SO:<base64 JSON>} = per turn the objects it sends to the messenger.
// Per turn it records argv, tools and the messenger's answers; a resumed turn (--resume sub-<tag>) reads the plan from
// the first turn's file.
const SUB = `
    const front = text.lastIndexOf("Here is the task:");
    const job = front >= 0 ? text.slice(front) : text;
    const resume = arg("--resume");
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : (resume.startsWith("sub-") ? resume.slice(4) : "x");
    fs.appendFileSync(path.join(LOCATION, "argv.jsonl"), JSON.stringify(argv) + "\\n");
    const planFile = path.join(LOCATION, "so-plan-" + tag);
    if (job.includes("{SO:")) fs.writeFileSync(planFile, Buffer.from(job.split("{SO:")[1].split("}")[0], "base64").toString("utf8"));
    const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, "utf8")) : [];
    const counter = path.join(LOCATION, "so-turns-" + tag);
    const round = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    fs.writeFileSync(counter, String(round + 1));
    fs.appendFileSync(path.join(LOCATION, "so-texts-" + tag), JSON.stringify(text) + "\\n");
    if (round === 0) {
      fs.writeFileSync(path.join(LOCATION, "so-tools-" + tag), JSON.stringify(await mcpTools()));
      fs.writeFileSync(path.join(LOCATION, "so-frame-" + tag), String(joined.includes("# Your result is an object")));
      fs.writeFileSync(path.join(LOCATION, "so-env-" + tag), JSON.stringify(JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase.env || {}));
    }
    for (const object of plan[round] || []) {
      const r = await mcpCall("StructuredOutput", object);
      fs.appendFileSync(path.join(LOCATION, "so-calls-" + tag + ".jsonl"), JSON.stringify({ round, error: Boolean(r.result && r.result.isError), text: textOf(r) }) + "\\n");
    }
    say({ type: "assistant", message: { id: "s-" + tag + "-" + round, usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "Text " + tag }] } });
    finished();
    say({ type: "result", result: "Text " + tag, session_id: "sub-" + tag });`;
const claude = fakeClaude({ sub: SUB });

// Fake Codex with real MCP calls: reads the cbase server from its -c mcp_servers.cbase.* arguments (as codex.js passes
// them), the job from the last argument, the plan as above; an `exec … resume <id>` is a resumed turn. {GATE:x} holds the
// FIRST turn BEFORE its calls at gate x.
const codex = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for a file to EXIST and then reads it — without rename it read an empty one under load.
// pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(LOCATION, "codex-argv.jsonl"), JSON.stringify(argv) + "\\n");
const cfg = { env: {} };
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] !== "-c") continue;
  const m = /^mcp_servers\\.cbase\\.(command|args|env\\.([A-Za-z0-9_]+))=([\\s\\S]*)$/.exec(argv[i + 1]);
  if (!m) continue;
  const v = JSON.parse(m[3]);
  if (m[1] === "command") cfg.command = v; else if (m[1] === "args") cfg.args = v; else cfg.env[m[2]] = v;
}
const say = (o) => console.log(JSON.stringify(o));
const text = argv[argv.length - 1] || "";
const ri = argv.indexOf("resume");
const alt = ri >= 0 ? argv[ri + 1] : "";
const tag = text.includes("{TAG:") ? text.split("{TAG:")[1].split("}")[0] : (alt.startsWith("cx-") ? alt.slice(3) : "x");
function mcpRpc(method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"], detached: true });
    try { fs.writeFileSync(path.join(LOCATION, "pids", "g" + child.pid), "mcp"); } catch {}
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { try { child.stdin.end(); } catch {} resolve(m); }
      }
    });
    child.on("error", reject);
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", id: 2, method, params });
  });
}
const textOf = (m) => (m && m.result && m.result.content && m.result.content[0] && m.result.content[0].text) || "";
(async () => {
  const planFile = path.join(LOCATION, "so-plan-" + tag);
  if (text.includes("{SO:")) fs.writeFileSync(planFile, Buffer.from(text.split("{SO:")[1].split("}")[0], "base64").toString("utf8"));
  const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, "utf8")) : [];
  const counter = path.join(LOCATION, "so-turns-" + tag);
  const round = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(round + 1));
  fs.appendFileSync(path.join(LOCATION, "so-texts-" + tag), JSON.stringify(text) + "\\n");
  if (round === 0 && text.includes("{GATE:")) {
    const file = path.join(LOCATION, "gates", text.split("{GATE:")[1].split("}")[0]);
    fs.writeFileSync(file + ".waiting", String(process.pid));
    await new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); r(); } }, 20); });
  }
  if (round === 0) {
    const l = await mcpRpc("tools/list", {});
    fs.writeFileSync(path.join(LOCATION, "so-tools-" + tag), JSON.stringify(((l.result && l.result.tools) || []).map((t) => t.name)));
  }
  for (const object of plan[round] || []) {
    const r = await mcpRpc("tools/call", { name: "StructuredOutput", arguments: object });
    fs.appendFileSync(path.join(LOCATION, "so-calls-" + tag + ".jsonl"), JSON.stringify({ round, error: Boolean(r.result && r.result.isError), text: textOf(r) }) + "\\n");
  }
  say({ type: "thread.started", thread_id: "cx-" + tag });
  say({ type: "turn.started" });
  say({ type: "item.completed", item: { id: "answer-" + round, type: "agent_message", text: "Codex text " + tag } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

// The loop engine: an agent with a schema is recognized by the messenger in its tool list. First turn text only (the engine
// cannot force a call — nudging is the normal case); in the nudged turn first invalid, then valid.
const engineRequests = [];
const engineRound = (b) => {
  const names = (b.tools || []).map((t) => t.function?.name || t.name);
  if (!names.includes(`mcp__cbase__${BOTE}`)) return { text: "Engine without schema" };
  engineRequests.push({ names, messages: b.messages || [] });
  const msgs = b.messages || [];
  const nudge = msgs.findIndex((m) => m.role === "user" && String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("without delivering a valid result"));
  if (nudge < 0) return { text: "Text only, no call" };
  const toolResults = msgs.slice(nudge).filter((m) => m.role === "tool").length;
  if (toolResults === 0) return { toolCalls: [{ id: "call_so_1", name: `mcp__cbase__${BOTE}`, arguments: { count: "seven" } }] };
  if (toolResults === 1) return { toolCalls: [{ id: "call_so_2", name: `mcp__cbase__${BOTE}`, arguments: { count: 7, word: "engine" } }] };
  return { text: "finished" };
};

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'StructuredOutput', phases: [{ title: 'Deliver' }] }\n${body}\n`;
const plan = (rounds) => Buffer.from(JSON.stringify(rounds)).toString("base64");
// The fakes (child processes) write the logs while the test reads — complete lines only (jsonl.mjs).
const readRows = (root, file) => readJsonl(path.join(root, file));
const turns = (root, tag) => (fs.existsSync(path.join(root, `so-turns-${tag}`)) ? Number(fs.readFileSync(path.join(root, `so-turns-${tag}`), "utf8")) : 0);

async function run(base, chatId, text) {
  const r = await post(`${base}/api/chats/${chatId}/dyn-workflows/run`, { script: text });
  assert.equal(r.status, "started", JSON.stringify(r));
  const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), `run ${r.runId}`);
  return { ...r, end };
}
const logs = (runId) => store.readDynEvents(runId).filter((e) => e.kind === "log").map((e) => e.text);
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });

function noSchemaFlags(root) {
  const all = [...readRows(root, "argv.jsonl"), ...readRows(root, "codex-argv.jsonl")];
  assert.ok(all.length > 0, "precondition: there were spawns");
  for (const av of all) {
    assert.equal(av.includes("--json-schema"), false, `no --json-schema: ${av.join(" ").slice(0, 200)}`);
    assert.equal(av.includes("--output-schema"), false, `no --output-schema: ${av.join(" ").slice(0, 200)}`);
  }
}

test("Claude: an invalid call comes back as an error with ajv wording, a valid one is the value of agent(); without a schema no messenger; an unsatisfiable schema throws without a spawn", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await run(base, chat.id, script("claude-so", [
      `const S = ${JSON.stringify(SCHEMA)};`,
      `const a = await agent('A {TAG:a} {SO:${plan([[{ count: "three" }, { count: 3, word: "three" }]])}}', { schema: S });`,
      "const b = await agent('B {TAG:b}');",
      "let root = 'no throw', requiredValue = 'no throw';",
      "try { await agent('W {TAG:w}', { schema: { type: 'array', items: {} } }); } catch (e) { root = e.message; }",
      "try { await agent('P {TAG:p}', { schema: { type: 'object', properties: { x: {} }, required: ['y'] } }); } catch (e) { requiredValue = e.message; }",
      "return { a, b, root, requiredValue };",
    ].join("\n")));
    assert.equal(r.end.status, "finished", r.end.error);
    const { a, b, root: rootDir, requiredValue: required } = r.end.returnValue;
    assert.deepEqual(a, { count: 3, word: "three" }, "agent() returns the validated object, not the last text");
    assert.equal(b, "Text b", "without a schema the last text as before");
    const calls = readRows(root, "so-calls-a.jsonl");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].error, true, "the invalid call is an error tool result");
    assert.match(calls[0].text, /\/count must be integer/, "with the ajv wording");
    assert.equal(calls[1].error, false);
    assert.match(calls[1].text, /Accepted/);
    assert.equal(turns(root, "a"), 1, "valid in the same turn — no nudge");
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, "so-tools-a"), "utf8")).includes(BOTE), "the agent with a schema sees the messenger");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "so-tools-b"), "utf8")).includes(BOTE), false, "the one without a schema does not");
    assert.equal(fs.readFileSync(path.join(root, "so-frame-a"), "utf8"), "true", "its system prompt tells it");
    assert.equal(fs.readFileSync(path.join(root, "so-frame-b"), "utf8"), "false");
    const envA = JSON.parse(fs.readFileSync(path.join(root, "so-env-a"), "utf8"));
    assert.deepEqual(JSON.parse(envA.CBASE_SCHEMA), SCHEMA, "the schema arrives by environment");
    assert.match(envA.CBASE_SCHEMA_REFERENCE, /^so_/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "so-env-b"), "utf8")).CBASE_SCHEMA, undefined);
    // Unsatisfiable: a throw with the reason, no journal and no spawn.
    assert.match(rootDir, /unsatisfiable JSON Schema — the root schema must declare type: 'object'/);
    assert.match(required, /required "y" not in properties/);
    assert.equal(turns(root, "w") + turns(root, "p"), 0, "no spawn counted at the fake CLI");
    assert.equal(readRows(root, "argv.jsonl").length, 2, "exactly two spawns: a and b");
    const j = store.readDynJournal(r.runId);
    assert.deepEqual(j.filter((e) => e.kind === "launched").map((e) => e.n), [1, 2], "no journal for the throws");
    assert.deepEqual(j.find((e) => e.kind === "result" && e.n === 1).value, { count: 3, word: "three" }, "the object is in the journal (resume)");
    noSchemaFlags(root);
    await ctx.waitForIdle();
  }, { claude });
});

test("nudge and cap: a turn without a valid call is nudged EXACTLY once; after 5 failed attempts and after a futile nudge agent() returns null, and log() names the agent", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const wrong = { count: "x" };
    const r = await run(base, chat.id, script("follow-up", [
      `const S = ${JSON.stringify(SCHEMA)};`,
      // n: first turn no call at all, valid in the nudged one.
      `const n = await agent('N {TAG:n} {SO:${plan([[], [{ count: 1 }]])}}', { schema: S, label: 'nudged' });`,
      // d: six invalid calls in the first turn — the sixth hits the cap; no nudge.
      `const d = await agent('D {TAG:d} {SO:${plan([[wrong, wrong, wrong, wrong, wrong, wrong]])}}', { schema: S, label: 'capped' });`,
      // s: never calls, not even when nudged.
      "const s = await agent('S {TAG:s}', { schema: S, label: 'silent' });",
      "return { n, d, s };",
    ].join("\n")));
    assert.equal(r.end.status, "finished", r.end.error);
    const { n, d, s } = r.end.returnValue;
    assert.deepEqual(n, { count: 1 });
    assert.equal(turns(root, "n"), 2, "nudged once");
    const textsN = readRows(root, "so-texts-n");
    assert.equal(textsN[1], FOLLOW_UP, "with the wording of the nudge");

    assert.equal(d, null, "null after 5 failed attempts");
    assert.equal(turns(root, "d"), 1, "no nudge at the cap");
    const onD = readRows(root, "so-calls-d.jsonl");
    assert.equal(onD.length, 6);
    assert.ok(onD.every((x) => x.error), "all invalid");
    assert.match(onD[5].text, new RegExp(`Cap reached: ${FAILED_ATTEMPTS_MAX} invalid calls`));

    assert.equal(s, null);
    assert.equal(turns(root, "s"), 2, "nudged exactly once, not more");

    const rows = logs(r.runId);
    const agentD = store.readDynJournal(r.runId).find((e) => e.kind === "started" && e.n === 2).agentId;
    const agentS = store.readDynJournal(r.runId).find((e) => e.kind === "started" && e.n === 3).agentId;
    assert.ok(rows.some((z) => z.includes("“capped”") && z.includes(agentD) && /after 5 attempts — last StructuredOutput error: \/count must be integer/.test(z)), `log() names the agent at the cap: ${rows.join(" | ")}`);
    assert.ok(rows.some((z) => z.includes("“silent”") && z.includes(agentS) && z.includes("after in-conversation nudge")), `log() names the silent agent: ${rows.join(" | ")}`);
    assert.equal(rows.filter((z) => z.includes("“nudged”")).length, 0, "the nudged one delivered");
    assert.deepEqual(store.readDynJournal(r.runId).filter((e) => e.kind === "failed").map((e) => e.n), [2, 3]);
    noSchemaFlags(root);
    await ctx.waitForIdle();
  }, { claude });
});

test("Codex and loop engine take the same path: invalid → error with ajv wording, valid → the object; the engine is nudged (normal case) and sees the messenger without ToolSearch", async () => {
  engineRequests.length = 0;
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, engine } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await run(base, chat.id, script("provider-so", [
      `const S = ${JSON.stringify(SCHEMA)};`,
      `const c = await agent('C {TAG:c} {SO:${plan([[{ word: "no number" }, { count: 5 }]])}}', { schema: S, model: 'codex::gpt-5.6-sol' });`,
      `const e = await agent('E', { schema: S, model: ${JSON.stringify(engine.model)} });`,
      `const o = await agent('O', { model: ${JSON.stringify(engine.model)} });`,
      "return { c, e, o };",
    ].join("\n")));
    assert.equal(r.end.status, "finished", r.end.error);
    const { c, e, o } = r.end.returnValue;
    // Codex
    assert.deepEqual(c, { count: 5 });
    const onC = readRows(root, "so-calls-c.jsonl");
    assert.deepEqual(onC.map((x) => x.error), [true, false]);
    assert.match(onC[0].text, /\(root\) must have required property 'count'/, "ajv wording via Codex too");
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, "so-tools-c"), "utf8")).includes(BOTE), "Codex sees the messenger through its MCP server");
    assert.equal(turns(root, "c"), 1);
    // Loop-Engine
    assert.deepEqual(e, { count: 7, word: "engine" });
    assert.equal(o, "Engine without schema");
    assert.ok(engineRequests.length >= 3, `requests with messenger: ${engineRequests.length}`);
    const afterNudge = engineRequests.filter((a) => a.messages.some((m) => m.role === "user" && String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("without delivering a valid result")));
    assert.ok(afterNudge.length >= 2 && afterNudge.length < engineRequests.length, "the first turn ended with text, the second is nudged");
    const toolText = (a) => a.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    const last = engineRequests[engineRequests.length - 1];
    assert.match(toolText(last)[0], /\/count must be integer/, "the engine gets the ajv wording as tool result");
    assert.match(toolText(last)[1], /Accepted/);
    // The workflow agent has the chat's full set — the engine hides MCP tools behind ToolSearch. That the messenger is
    // in the request anyway (else it would not be in engineRequests at all) is the ALWAYS_ON exception.
    assert.ok(engineRequests[0].names.includes("ToolSearch"), "precondition: the engine hides tools behind ToolSearch");
    assert.equal(engineRequests[0].names.includes("mcp__cbase__cbase_projects_list"), false, "precondition: an ordinary cbase tool is deferred");
    noSchemaFlags(root);
    await ctx.waitForIdle();
  }, { claude, codex, engine: { round: engineRound } });
});

// Agent communication: when an agent with a schema gets a message, the NEWEST valid object counts — even if the message
// came BEFORE its acceptance. The normal case with Codex: the message arrives during turn 1 (promised "after its turn,
// before its result goes to the script"), turn 1 still delivers its first object, only the continuation reads the message
// and delivers a second one.
test("message during turn 1 (Codex, before the StructuredOutput call): the continuation replaces the accepted object — the script gets the NEWEST", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await post(`${base}/api/chats/${chat.id}/dyn-workflows/run`, { script: script("so-message", [
      `const S = ${JSON.stringify(SCHEMA)};`,
      `return await agent('N {TAG:n} {GATE:n} {SO:${plan([[{ count: 1, word: "prior" }], [{ count: 2, word: "after" }]])}}', { schema: S, model: 'codex::gpt-5.6-sol' });`,
    ].join("\n")) });
    assert.equal(r.status, "started", JSON.stringify(r));
    await gate.reached("n");
    const s = await post(`${base}/api/chats/${chat.id}/agent/send`, { to: `wf:${r.runId}:1`, message: "Please heed MARKER-SO", from: "human" });
    assert.equal(s.state, "after_turn", JSON.stringify(s));
    gate.open("n");
    const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), `Lauf ${r.runId}`);
    assert.equal(end.status, "finished", end.error);
    const on = readRows(root, "so-calls-n.jsonl");
    assert.deepEqual(on.map((x) => [x.round, x.error]), [[0, false], [1, false]], `both objects accepted: ${JSON.stringify(on)}`);
    assert.match(on[0].text, /replaces/, "the acceptance says a later valid object replaces it");
    assert.match(JSON.parse(fs.readFileSync(path.join(root, "so-texts-n"), "utf8").trim().split("\n")[1]), /MARKER-SO/, "the continuation carried the message");
    assert.deepEqual(end.returnValue, { count: 2, word: "after" }, "the script gets the object AFTER the message");
    await ctx.waitForIdle();
  }, { claude, codex });
});

test("validation route: without a schema reference or without a payload 400, a reference that is not open 404", async () => {
  await withAgentsServer(async ({ base, chat }) => {
    const url = `${base}/api/chats/${chat.id}/dyn-workflows/structured-output`;
    const raw = async (body) => { const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
    const withoutReference = await raw({ object: { count: 1 } });
    assert.equal(withoutReference.status, 400);
    assert.match(withoutReference.body.error, /reference/);
    assert.equal((await raw({ reference: "  ", object: {} })).status, 400, "an empty reference is none");
    const withoutObject = await raw({ reference: "so_x" });
    assert.equal(withoutObject.status, 400);
    assert.match(withoutObject.body.error, /object/);
    assert.equal((await raw({})).status, 400);
    assert.equal((await raw({ reference: "so_nonexistent", object: { count: 1 } })).status, 404);
  }, { claude });
});
