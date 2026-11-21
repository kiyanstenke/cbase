// Depth 3 and tool inheritance.
//
// Subagents may start subagents themselves — down to the third level under the chat. ONE count at three places that
// each used to carry a fixed depth 1: the MCP server (CBASE_AGENT_DEPTH + table from mcp/visibility.js), the CLI
// block list of the subagent spec (runs/agents.js) and the marker of the loop engine (`agentDepth`, providers/engine.js).
// Visibility is a table: "always locked" versus "only at the boundary" (the cbase_agent* family). A child never gets
// more tools than its parent AGENT (runs/agent-set.js, ONE computation), and the set goes to the MCP server as an
// explicit list.
//
// All three paths (fake Claude, fake Codex, loop engine) run the main seam through the REAL MCP server and the real
// routes (agent-harness.mjs). Each subagent writes down what it sees (tools/list of its server minus --disallowedTools,
// its depth, the levels its frame names, its MCP environment) — `view-<marker>.json`.
//
// Counter-tests (each shown red once):
//   · MCP server: boundary at depth >= 1 instead of >= 3 => every grandchild start fails (Claude, Codex, engine via MCP).
//   · CLI block list: family locked from depth 1 => the Claude grandchild does not start.
//   · Engine marker: `mayDelegate` at depth < 1 => `Task` is missing for the engine subagent, the grandchild does not start.
//   · old state of the table (without wakeup/monitor under "always") => a subagent sees cbase_wakeup.
//   · definition instead of intersection in runs/agent-set.js => the grandchild sees cbase_project_delete.
//   · LIFO instead of call id => the grandchildren of the two parallel children land under the same block.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { AGENT_DEPTH_MAX, ONLY_WITH_RUN_BINDING, ONLY_WITH_OUTER_LOOP_MARKER, VIEW_BY_DEPTH, lockedForDepth, remainingDepth } from "../electron/mcp/visibility.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { agentToolset } from "../electron/server/runs/agent-set.js";
import { subagentFrame } from "../electron/server/providers/agent-runtime.js";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const FAMILY = VIEW_BY_DEPTH.onlyAtTheLimit;
const ALWAYS = VIEW_BY_DEPTH.alwaysLocked;
const HAIKU = "claude::claude-haiku-4-5-20251001";

// tools/list of a real MCP server with this environment (no server behind it — only the list matters).
function mcpList(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SCRIPT], {
      env: { ...process.env, CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined,
        CBASE_BASE_URL: "http://127.0.0.1:1", CBASE_CHAT_ID: "c-depth", ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      for (const z of buf.split("\n")) {
        let m; try { m = JSON.parse(z); } catch { continue; }
        if (m.id === 2) { child.stdin.end(); child.kill(); resolve(m.result.tools.map((t) => t.name)); }
      }
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

// ── The table, the computation, the frame (no server) ───────────────────────────────────────────────────────────────

test("Table: always locked (also wakeup and monitor) versus only at the boundary (the cbase_agent family)", async () => {
  console.log(`[depth] boundary ${AGENT_DEPTH_MAX}; always locked ${ALWAYS.length}, only at the boundary ${FAMILY.length}`);
  for (const n of [...ALWAYS, ...FAMILY]) assert.ok(CATALOG_NAMES.includes(n), `"${n}" is in the table but not in the catalog`);
  for (const n of ["cbase_wakeup", "cbase_monitor", "cbase_ask"]) {
    for (let t = 1; t <= AGENT_DEPTH_MAX; t++) assert.equal(lockedForDepth(n, t), true, `${n} at depth ${t}`);
    assert.equal(lockedForDepth(n, 0), false, `${n} belongs to the chat itself`);
  }
  for (const n of FAMILY) {
    for (let t = 0; t < AGENT_DEPTH_MAX; t++) assert.equal(lockedForDepth(n, t), false, `${n} at depth ${t}`);
    assert.equal(lockedForDepth(n, AGENT_DEPTH_MAX), true, `${n} at the boundary`);
  }
  assert.deepEqual([1, 2, 3].map(remainingDepth), [2, 1, 0]);

  // The same MCP server, four depths: what it actually offers.
  const list = {};
  for (const t of [0, 1, 2, 3]) list[t] = await mcpList(t ? { CBASE_AGENT_DEPTH: String(t) } : {});
  for (const n of FAMILY) {
    assert.ok(list[0].includes(n) && list[1].includes(n) && list[2].includes(n), `${n} is missing before the boundary`);
    assert.equal(list[3].includes(n), false, `${n} is present at depth 3`);
  }
  for (const t of [1, 2, 3]) {
    for (const n of ["cbase_wakeup", "cbase_monitor", "cbase_monitor_stop"]) assert.equal(list[t].includes(n), false, `${n} visible at depth ${t}`);
  }
  assert.ok(list[0].includes("cbase_wakeup") && list[0].includes("cbase_monitor"), "the chat itself keeps wakeup and monitor");
});

test("Computation: parent set ∩ definition ∩ table, catalog order — empty is not unset", () => {
  // A reading parent set (the intersection of a read-only agent).
  const reading = ["cbase_projects_list", "cbase_context_list", "cbase_context_get", "cbase_agent", "cbase_ask", "cbase_artifacts_list"];
  const WRITING = ["cbase_project_update", "cbase_project_delete", "cbase_context_create", "cbase_context_update"];
  // Depth 1: the reading intersection, explicit, without a question.
  const kind = agentToolset({ parent: { cbase: reading, builtin: null }, required: null, depth: 1 });
  assert.ok(Array.isArray(kind.cbase) && kind.cbase.includes("cbase_agent") && !kind.cbase.includes("cbase_ask"));
  for (const t of WRITING) assert.equal(kind.cbase.includes(t), false, `child has ${t}`);
  // Grandchild with a definition that lists write tools: only the reading remainder stays.
  const grandchild = agentToolset({ parent: kind, required: ["mcp__cbase__cbase_project_delete", "cbase_context_create", "cbase_context_get", "Read"], depth: 2 });
  assert.deepEqual(grandchild.cbase, ["cbase_context_get"]);
  assert.deepEqual(grandchild.builtin, ["Read"]);
  // Grandchild without its own list: EXACTLY the set of the parent agent.
  assert.deepEqual(agentToolset({ parent: kind, required: null, depth: 2 }).cbase, kind.cbase);
  // At the boundary the family drops out.
  const greatGrandchild = agentToolset({ parent: kind, required: null, depth: 3 });
  assert.deepEqual(greatGrandchild.cbase, kind.cbase.filter((n) => !FAMILY.includes(n)));
  // Empty is not unset: an empty set stays empty (and explicit), an unset one is "no intersection" at depth 1
  // and from depth 2 the full set of a coding chat — spelled out, never the server's fallback.
  assert.deepEqual(agentToolset({ parent: { cbase: [], builtin: null }, depth: 2 }).cbase, []);
  assert.equal(agentToolset({ parent: { cbase: null, builtin: null }, depth: 1 }).cbase, null);
  const full = agentToolset({ parent: { cbase: null, builtin: null }, depth: 2 }).cbase;
  // Without the tools with an outer-loop marker: cbase_chat_analysis and cbase_agenda_maintain (agenda maintainer)
  // belong to the outer-loop run alone, never to the full set of a subagent — likewise the run-bound tools
  // (cbase_permission_prompt).
  assert.deepEqual(full, CATALOG_NAMES.filter((n) => !ALWAYS.includes(n) && !ONLY_WITH_OUTER_LOOP_MARKER.includes(n) && !ONLY_WITH_RUN_BINDING.includes(n)));
  assert.equal(full.includes("cbase_agenda_maintain"), false, "a subagent never gets the tool of the agenda maintainer");
  // Catalog order, no matter in which order they were requested.
  const backward = agentToolset({ parent: { cbase: null, builtin: null }, required: ["cbase_artifacts_list", "cbase_projects_list"], depth: 1 });
  assert.deepEqual(backward.cbase, ["cbase_projects_list", "cbase_artifacts_list"]);
  // Built-in: the child never more than the parent agent.
  assert.deepEqual(agentToolset({ parent: { cbase: null, builtin: ["Read", "Grep"] }, required: ["Write", "Read"], depth: 2 }).builtin, ["Read"]);
  assert.deepEqual(agentToolset({ parent: { cbase: null, builtin: ["Read", "Grep"] }, required: null, depth: 2 }).builtin, ["Read", "Grep"]);
});

test("Frame: names depth and remaining levels, and the subagent tool only if it is in the set", () => {
  const r1 = subagentFrame({ depth: 1, delegated: true });
  assert.match(r1, /SUBAGENT of cbase \(depth 1 of 3/);
  assert.match(r1, /two further levels/);
  assert.match(r1, /cbase_agent/);
  const r3 = subagentFrame({ depth: 3, delegated: true });
  assert.match(r3, /no further level/);
  assert.equal(r3.includes("cbase_agent"), false, "depth 3 explains a tool it does not have");
  const without = subagentFrame({ depth: 1, delegated: false });
  assert.equal(without.includes("cbase_agent"), false, "a set without the subagent tool does not get it explained");
});

// ── The main seam ───────────────────────────────────────────────────────────────────────────────────────────────────

// The subagent (fake Claude): writes down its view, starts a child — as long as it may and the assignment does not say
// "SHEET" — and reports. "GATE": it opens its call block and waits until the test lets it go on. At depth 3 it tries
// anyway (the result is in its view). Marker "V" (manager child) starts two grandchildren: one with the definition
// "writer" and one without its own list.
const SUB = `
  const depth = Number((/depth (\\d) of/.exec(joined) || [])[1] || 0);
  const marker = (/Assignment ([A-Z0-9-]+)/.exec(text) || [])[1] || "?";
  const levels = joined.includes("two further levels") ? 2 : joined.includes("no further level") ? 0 : joined.includes("one further level") ? 1 : -1;
  let env = {};
  try { env = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase.env; } catch {}
  const view = { depth, levels, tools: await mcpTools(), locked: arg("--disallowedTools"), env, attempt: null };
  const jobs = marker === "V"
    ? [{ id: "toolu_k_V_a", input: { description: "Writer", prompt: "Assignment V-2 SHEET", subagent_type: "writer" } },
       { id: "toolu_k_V_b", input: { description: "Reader", prompt: "Assignment V-3 SHEET" } }]
    : text.includes("SHEET") ? [] : [{ id: "toolu_k_" + marker.replace(/-/g, "_"), input: { description: "Child of " + marker, prompt: "Assignment " + marker + "-" + (depth + 1) } }];
  // Foreground explicitly (the default is background): the child agent waits for the report of the grandchild.
  for (const a of jobs) a.input = { run_in_background: false, ...a.input };
  if (jobs.length) {
    say({ type: "assistant", message: { id: "a-" + marker, content: jobs.map((a) => ({ type: "tool_use", id: a.id, name: "mcp__cbase__cbase_agent", input: a.input })) } });
    if (text.includes("GATE")) await gate("kind-" + marker);
    const rs = [];
    for (const a of jobs) rs.push(await mcpCall("cbase_agent", a.input));
    view.attempt = rs.map((r) => ({ error: Boolean(r.result && r.result.isError) || Boolean(r.error), text: textOf(r) || JSON.stringify(r.error || "") }));
    say({ type: "user", message: { content: jobs.map((a, i) => ({ type: "tool_result", tool_use_id: a.id, content: view.attempt[i].text, is_error: view.attempt[i].error })) } });
  }
  fs.writeFileSync(path.join(LOCATION, "view-" + marker + ".json"), JSON.stringify(view));
  say({ type: "assistant", message: { id: "t-" + marker, content: [{ type: "text", text: "Finding " + marker }] } });
  finished();
  say({ type: "result", result: "Finding " + marker, session_id: "s-" + marker });`;

// The main agent: starts the assignments IN PARALLEL (Promise.all) from ONE reply.
const main = (jobs) => `
  const jobs = ${JSON.stringify(jobs)}.map((a) => ({ ...a, input: { run_in_background: false, ...a.input } }));
  say({ type: "assistant", message: { id: "main-1", content: jobs.map((a) => ({ type: "tool_use", id: a.id, name: "mcp__cbase__cbase_agent", input: a.input })) } });
  const rs = await Promise.all(jobs.map((a) => mcpCall("cbase_agent", a.input)));
  say({ type: "user", message: { content: jobs.map((a, i) => ({ type: "tool_result", tool_use_id: a.id, content: textOf(rs[i]) })) } });
  say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: "finished" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

const viewOf = (root, marker) => JSON.parse(fs.readFileSync(path.join(root, `view-${marker}.json`), "utf8"));
const rows = (log, role) => log.filter((m) => m.role === role).map((m) => JSON.parse(m.text));
const parentOfText = (log, text) => rows(log, "sub_text").filter((t) => t.text === text).map((t) => t.parent);
const parentOfTool = (log, id) => rows(log, "tool").filter((t) => t.id === id).map((t) => t.parent);
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });

test("Claude: two parallel children, each with a chain to depth 3 — view per depth, frame, block list, nesting", async () => {
  const claude = fakeClaude({
    sub: SUB,
    main: main([
      { id: "toolu_one", input: { description: "Part ONE", prompt: "Assignment ONE GATE", model: HAIKU } },
      { id: "toolu_two", input: { description: "Part TWO", prompt: "Assignment TWO GATE", model: HAIKU } },
    ]),
  });
  await withAgentsServer(async ({ base, chat, root, gate, waitForLog }) => {
    await send(base, chat.id, "Two chains");
    // Both children stand there with an OPEN call block before either starts its grandchild — so a LIFO fallback would show.
    await gate.reached("kind-ONE");
    await gate.reached("kind-TWO");
    await waitForLog(chat.id, (l) => ["toolu_k_ONE", "toolu_k_TWO"].every((id) => parentOfTool(l, id).length));
    gate.open("kind-ONE");
    gate.open("kind-TWO");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    for (const w of ["ONE", "TWO"]) {
      const s1 = viewOf(root, w), s2 = viewOf(root, `${w}-2`), s3 = viewOf(root, `${w}-2-3`);
      console.log(`[depth] ${w}: depths ${s1.depth}/${s2.depth}/${s3.depth}, levels ${s1.levels}/${s2.levels}/${s3.levels}, tools ${s1.tools.length}/${s2.tools.length}/${s3.tools.length}`);
      assert.deepEqual([s1.depth, s2.depth, s3.depth], [1, 2, 3]);
      assert.deepEqual([s1.levels, s2.levels, s3.levels], [2, 1, 0], "the frame names the remaining levels");
      for (const n of FAMILY) {
        assert.ok(s1.tools.includes(n) && s2.tools.includes(n), `${n} is missing before the boundary (${w})`);
        assert.equal(s3.tools.includes(n), false, `${n} at depth 3 (${w})`);
      }
      for (const s of [s1, s2, s3]) {
        for (const n of ["cbase_wakeup", "cbase_monitor", "cbase_ask"]) assert.equal(s.tools.includes(n), false, `${n} visible at depth ${s.depth}`);
      }
      assert.ok(s3.locked.split(",").includes("mcp__cbase__cbase_agent"), "depth 3: the family is in the CLI block list");
      assert.equal(s1.locked.split(",").includes("mcp__cbase__cbase_agent"), false);
      assert.equal(s1.attempt[0].error, false, `the grandchild start of ${w} failed: ${s1.attempt[0].text}`);
      assert.equal(s2.attempt[0].error, false, `the start at depth 2 failed: ${s2.attempt[0].text}`);
      assert.equal(s3.attempt[0].error, true, "at depth 3 the attempt must not start anything");
      // The grandchild inherits EXACTLY the set of its parent agent — as an explicit list, even without an intersection at the chat.
      assert.equal(s1.env.CBASE_TOOLS, undefined, "depth 1 of a coding chat: no intersection");
      assert.ok(s2.env.CBASE_TOOLS, "depth 2: the list goes out explicitly");
      assert.deepEqual(s2.tools, s1.tools, "the grandchild sees exactly what its parent agent sees");
      assert.deepEqual(JSON.parse(s3.env.CBASE_TOOLS), JSON.parse(s2.env.CBASE_TOOLS).filter((n) => !FAMILY.includes(n)));

      // Nested, each under its OWN parent call: child under the main block, grandchild under the child's block.
      const main = w === "ONE" ? "toolu_one" : "toolu_two";
      assert.deepEqual(parentOfText(log, `Finding ${w}`), [main]);
      assert.deepEqual(parentOfTool(log, `toolu_k_${w}`), [main]);
      assert.deepEqual(parentOfText(log, `Finding ${w}-2`), [`toolu_k_${w}`], `the grandchild of ${w} is not under its parent block`);
      assert.deepEqual(parentOfTool(log, `toolu_k_${w}_2`), [`toolu_k_${w}`]);
      assert.deepEqual(parentOfText(log, `Finding ${w}-2-3`), [`toolu_k_${w}_2`]);
    }
    // Nothing in the main bubble: the only text without a parent is the main agent's answer.
    assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["finished"]);
    assert.equal(rows(log, "sub_text").length, 6, "six agents, six findings — none discarded");
  }, { claude });
});

// Fake Codex as a SUBAGENT (depth 1): reads its MCP configuration from the -c arguments, writes its view and
// starts a grandchild through a real mcp_tool_call (item.started/completed, Codex _meta without toolUseId).
const fakeCodexKind = () => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const joined = argv.join(" ");
const cfg = { env: {} };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const m = /^mcp_servers\\.cbase\\.(command|args|env\\.(\\w+))=(.*)$/.exec(argv[i + 1] || "");
  if (!m) continue;
  const value = JSON.parse(m[3]);
  if (m[1] === "command") cfg.command = value; else if (m[1] === "args") cfg.args = value; else cfg.env[m[2]] = value;
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"], detached: true });
    try { fs.writeFileSync(path.join(LOCATION, "pids", "g" + child.pid), "mcp"); } catch {}
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
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
(async () => {
  say({ type: "thread.started", thread_id: "codex-kind" });
  say({ type: "turn.started" });
  if (joined.includes("SUBAGENT of cbase")) {
    const tools = ((await rpc("tools/list", {})).result || { tools: [] }).tools.map((t) => t.name);
    const a = { description: "Child of CODEX", prompt: "Assignment CODEX-2 SHEET", model: ${JSON.stringify(HAIKU)}, run_in_background: false };
    say({ type: "item.started", item: { id: "item_codex_k", type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: a, status: "in_progress" } });
    const r = await rpc("tools/call", { name: "cbase_agent", arguments: a, _meta: { callId: "call_1", itemId: "fc_1", threadId: "codex-kind" } });
    const res = r.result || { isError: true, content: [{ type: "text", text: JSON.stringify(r.error || "") }] };
    say({ type: "item.completed", item: { id: "item_codex_k", type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: a,
      result: { content: res.content || [], structured_content: null }, status: res.isError ? "failed" : "completed" } });
    fs.writeFileSync(path.join(LOCATION, "view-CODEX.json"), JSON.stringify({ tools, env: cfg.env, error: Boolean(res.isError), text: (res.content || [])[0]?.text || "" }));
  }
  say({ type: "item.completed", item: { id: "response", type: "agent_message", text: "Finding CODEX" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

test("Codex: a Codex subagent at depth 1 sees cbase_agent and starts a grandchild — under ITS block (stream assignment)", async () => {
  const claude = fakeClaude({ sub: SUB, main: main([{ id: "toolu_codex", input: { description: "Codex part", prompt: "Assignment CODEX", model: "codex::gpt-5.6-sol" } }]) });
  await withAgentsServer(async ({ base, chat, root, waitForLog }) => {
    await send(base, chat.id, "Codex chain");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    const s = viewOf(root, "CODEX");
    assert.equal(s.env.CBASE_AGENT_DEPTH, "1");
    assert.ok(s.tools.includes("cbase_agent"), `cbase_agent is missing for the Codex child: ${s.tools.join(",")}`);
    assert.equal(s.tools.includes("cbase_wakeup"), false);
    assert.equal(s.error, false, `the grandchild start failed: ${s.text}`);
    const grandchild = viewOf(root, "CODEX-2");
    assert.equal(grandchild.depth, 2);
    assert.deepEqual(parentOfTool(log, "item_codex_k"), ["toolu_codex"], "the Codex call is under the main block");
    assert.deepEqual(parentOfText(log, "Finding CODEX-2"), ["item_codex_k"], "the grandchild is under the block of its Codex parent");
  }, { claude, codex: fakeCodexKind() });
});

test("Loop engine: an engine subagent at depth 1 gets cbase_agent (never Task) and uses it to start a grandchild through the core", async () => {
  const kindRequests = [];
  const round = (b) => {
    const sys = String((b.messages || []).find((m) => m.role === "system")?.content || "");
    if (!sys.includes("SUBAGENT of cbase")) return null;
    kindRequests.push(b);
    if ((b.messages || []).some((m) => m.role === "tool")) return { text: "Finding ENGINE" };
    return { toolCalls: [{ id: "call_engine_agent", name: "mcp__cbase__cbase_agent", arguments: { description: "Child of ENGINE", prompt: "Assignment ENGINE-2 SHEET", model: HAIKU, run_in_background: false } }] };
  };
  await withAgentsServer(async ({ base, chat, root, engine, waitForLog }) => {
    await send(base, chat.id, "Engine chain");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    const names = (kindRequests[0]?.tools || []).map((t) => t.function?.name || t.name);
    console.log(`[depth] engine child: ${names.length} tools, cbase_agent ${names.includes("mcp__cbase__cbase_agent") ? "yes" : "no"}; model ${engine.model}`);
    assert.ok(names.includes("mcp__cbase__cbase_agent"), `cbase_agent is missing for the engine subagent at depth 1: ${names.join(",")}`);
    assert.ok(!names.includes("Task"), "the engine offers no Task any more");
    const grandchild = viewOf(root, "ENGINE-2");
    assert.equal(grandchild.depth, 2, "the grandchild runs at depth 2");
    assert.deepEqual(parentOfTool(log, "call_engine_agent"), ["toolu_engine"], "the cbase_agent call is under the main block");
    assert.deepEqual(parentOfText(log, "Finding ENGINE-2"), ["call_engine_agent"], "the grandchild is under the call block of its engine parent");
  }, { claude: fakeClaude({ sub: SUB, main: main([{ id: "toolu_engine", input: { description: "Engine part", prompt: "Assignment ENGINE", model: "openrouter::m1" } }]) }), engine: { round } });
});
