// A tool list on an agent definition means the same on all three paths (Claude, Codex, engine): only what is listed,
// MCP tools and `cbase_*` included. ONE computation (runs/agent-set.js) cuts the cbase part (CBASE_TOOLS at the server),
// the built-ins, the foreign servers (MCP config, allowedTools, Codex enabled_tools) and the skill tool with its prompt
// catalog.
//
// Not set is not empty: `null` = the full set of the path, `[]` = none of the cuttable tools. The app plumbing
// `cbase_permission_prompt` (the CLI's --permission-prompt-tool) sits next to every explicit list and does not count
// as a tool of the agent (PLUMBING).
//
// Counter-tests (each shown red once): old rule "list without cbase entry => no cut" => the Claude and the Codex
// subagent with "Read" see all cbase_*; old engine allowlist (built-ins only) => the engine does not offer
// cbase_context_list; migration not called => the existing definition loses its cbase_* and the browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { agentToolset, engineAllowlist, readToolList, unknownTool } from "../electron/server/runs/agent-set.js";
import * as store from "../electron/server/store.js";
import { TOOL_MIGRATION_MARKER, migrateToolLists } from "../electron/server/toolchain/agent-tools.js";

const PLUMBING = new Set(["cbase_permission_prompt"]);
const cbNames = (names) => names.map((n) => String(n).replace(/^mcp__cbase__/, "")).filter((n) => n.startsWith("cbase_") && !PLUMBING.has(n));

// ── The computation (no server) ─────────────────────────────────────────────────────────────────────────────────────

test("computation: \"Read, cbase_context_list\" is only what is listed — not set is the full set, empty is nothing", () => {
  const set = agentToolset({ required: ["Read", "cbase_context_list"], depth: 1 });
  assert.deepEqual(set, { cbase: ["cbase_context_list"], builtin: ["Read"], extern: {}, skill: false });
  assert.deepEqual(engineAllowlist(set), ["Read", "mcp__cbase__cbase_context_list"]);

  // Built-ins only: NO cbase tool.
  const onlyRead = agentToolset({ required: ["Read"], depth: 1 });
  assert.deepEqual(onlyRead.cbase, []);
  assert.deepEqual(onlyRead.extern, {});

  // Not set: the full set of the path (no cut anywhere).
  const free = agentToolset({ required: null, depth: 1 });
  assert.deepEqual(free, { cbase: null, builtin: null, extern: null, skill: true });
  assert.equal(engineAllowlist(free), null);
  assert.deepEqual(agentToolset({ required: ["*"], depth: 1 }), free, "\"*\" means everything, as in Claude Code");

  // Empty: none of the cuttable tools — a different case from "not set".
  const empty = agentToolset({ required: [], depth: 1 });
  assert.deepEqual(empty, { cbase: [], builtin: [], extern: {}, skill: false });
  assert.deepEqual(engineAllowlist(empty), []);

  // Catalog order, not the definition's (prompt cache).
  const backward = agentToolset({ required: ["cbase_context_list", "Grep", "mcp__cbase__cbase_projects_list"], depth: 1 });
  assert.deepEqual(backward.cbase, ["cbase_projects_list", "cbase_context_list"]);

  // The whole cbase server and foreign servers in Claude Code's notation.
  const server = agentToolset({ required: ["mcp__cbase", "mcp__playwright", "mcp__pg__query", "mcp__pg__schema", "mcp__git__*"], depth: 1 });
  assert.equal(server.cbase, null, "mcp__cbase = the whole server, no cut at depth 1");
  assert.deepEqual(server.extern, { playwright: null, pg: ["query", "schema"], git: null });
  assert.equal(server.skill, true);
  assert.deepEqual(engineAllowlist(server), ["mcp__cbase__*", "mcp__playwright__*", "mcp__pg__query", "mcp__pg__schema", "mcp__git__*"]);
  assert.deepEqual(agentToolset({ required: ["Skill"], depth: 1 }).cbase, ["cbase_skill"], "Skill is the skill tool of cbase");

  // Inheritance: a child never gets more than its parent — foreign servers and the skill tool included.
  const grandchild = agentToolset({ parent: server, required: ["mcp__pg", "mcp__acme", "cbase_skill"], depth: 2 });
  assert.deepEqual(grandchild.extern, { pg: ["query", "schema"] });
  assert.deepEqual(agentToolset({ parent: set, required: null, depth: 2 }).skill, false);
  assert.deepEqual(agentToolset({ parent: set, required: null, depth: 2 }).cbase, ["cbase_context_list"]);

  const part = readToolList(["Read", "mcp__cbase__cbase_context_list"]);
  assert.deepEqual([...part.cbase], ["cbase_context_list"]);
  assert.equal(readToolList(null), null);
});

test("saving: a name that is not a registered tool is named", () => {
  assert.equal(unknownTool(["Read", "Bash(git *)", "cbase_context_list", "mcp__cbase__cbase_context_get", "mcp__cbase", "mcp__playwright", "Skill", "*"]), null);
  assert.equal(unknownTool(["Read", "Raed"]), "Raed");
  assert.equal(unknownTool(["cbase_nonexistent"]), "cbase_nonexistent");
  assert.equal(unknownTool(["mcp__cbase__cbase_nonexistent"]), "mcp__cbase__cbase_nonexistent");
  assert.equal(unknownTool(["mcp__foreign__query"]), "mcp__foreign__query");
  assert.equal(unknownTool(["mcp__foreign__query", "mcp__foreign"], { server: ["foreign"] }), null);
});

// ── The migration (no server) ───────────────────────────────────────────────────────────────────────────────────────

test("migration: an existing definition with a list gets ONCE what the Claude path gave it — without it the definition would lose tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-toollist-migrate-"));
  try {
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    store.initStore(dataDir);
    // An empty store gets no marker (the golden fixtures are empty stores).
    assert.equal(migrateToolLists(), null);
    assert.equal(store.getSetting(TOOL_MIGRATION_MARKER, ""), "");

    const T0 = 1_790_000_000_000;
    store.createWorkspace({ id: "ws-43", name: "Demo", path: path.join(root, "ws"), createdAt: T0 });
    store.createMcpServer({ id: "m1", workspaceId: "ws-43", name: "browser-tools", transport: "stdio", command: "npx", createdAt: T0, updatedAt: T0 });
    // Three existing definitions, one without a list and one that already names a cbase tool. Existing means: comma list
    // in `tools`, no JSON list.
    const defs = [["api-reviewer", "Read, Grep, Glob"], ["sql-reviewer", "Read, Grep, Bash"], ["test-writer", "Read, Write, Edit, Bash, Grep"], ["free", ""], ["counter", "Read, cbase_context_list"]];
    for (const [name] of defs) store.createAgent({ id: `a-${name}`, workspaceId: "ws-43", name, createdAt: T0, updatedAt: T0 });
    const raw = new DatabaseSync(path.join(dataDir, "automater.db"));
    for (const [name, tools] of defs) raw.prepare("UPDATE agents SET tools = ?, tool_list = NULL WHERE id = ?").run(tools, `a-${name}`);
    raw.close();

    // What the old Claude path gave the existing definition: all cbase_*, the browser, every workspace server.
    const prior = agentToolset({ required: store.getAgent("a-api-reviewer").toolList, depth: 1 });
    console.log(`[toollist] without migration: cbase ${JSON.stringify(prior.cbase)}, servers ${JSON.stringify(prior.extern)}`);

    assert.deepEqual(migrateToolLists(), { definitions: 4 });
    const after = Object.fromEntries(defs.map(([name]) => [name, store.getAgent(`a-${name}`)]));
    assert.deepEqual(after["api-reviewer"].toolList, ["Read", "Grep", "Glob", "mcp__cbase", "mcp__playwright", "mcp__browser-tools"]);
    assert.equal(after["api-reviewer"].tools, "Read, Grep, Glob, mcp__cbase, mcp__playwright, mcp__browser-tools");
    assert.equal(after.free.toolList, null, "without a list stays without a list");
    assert.deepEqual(after.counter.toolList, ["Read", "cbase_context_list", "mcp__playwright", "mcp__browser-tools"], "a definition that names cbase tools already got only these");

    // The proof: after the migration the new rule gives exactly what the old Claude path gave.
    const set = agentToolset({ required: after["api-reviewer"].toolList, depth: 1 });
    assert.equal(set.cbase, null, "the existing definition would lose its cbase_*");
    assert.deepEqual(set.extern, { playwright: null, "browser-tools": null }, "the existing definition would lose the browser or workspace servers");
    assert.deepEqual(set.builtin, ["Read", "Grep", "Glob"]);
    assert.equal(set.skill, true);

    // Exactly once: a second start changes nothing, not even for a newly created definition.
    assert.ok(store.getSetting(TOOL_MIGRATION_MARKER, ""));
    store.createAgent({ id: "a-new", workspaceId: "ws-43", name: "fresh", toolList: ["Read"], createdAt: T0, updatedAt: T0 });
    assert.equal(migrateToolLists(), null);
    assert.deepEqual(store.getAgent("a-new").toolList, ["Read"]);
    assert.deepEqual(store.getAgent("a-api-reviewer").toolList, after["api-reviewer"].toolList);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The main seam: three paths over the real MCP server ─────────────────────────────────────────────────────────────

// The Claude subagent records what it sees: tools/list of its cbase server (minus --disallowedTools), its built-in
// tools, --allowedTools, the servers of its MCP config and whether its prompt carries the skill catalog.
const SUB = `
  const marker = (/Task ([A-Z0-9-]+)/.exec(text) || [])[1] || "?";
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers; } catch {}
  const view = { tools: await mcpTools(), builtin: eingebauteTools(), allowed: arg("--allowedTools"), server: Object.keys(cfg),
    env: (cfg.cbase || {}).env || {}, skillCatalog: joined.includes("cbase_skill"),
    onlyMain: ((/Only the main agent has these MCP servers: (.+?) — /.exec(joined) || [])[1]) || null };
  fs.writeFileSync(path.join(LOCATION, "view-" + marker + ".json"), JSON.stringify(view));
  say({ type: "assistant", message: { id: "t-" + marker, content: [{ type: "text", text: "Result " + marker }] } });
  finished();
  say({ type: "result", result: "Result " + marker, session_id: "s-" + marker });`;

const main = (jobs) => `
  const jobs = ${JSON.stringify(jobs)}.map((a) => ({ ...a, input: { run_in_background: false, ...a.input } }));
  say({ type: "assistant", message: { id: "main-1", content: jobs.map((a) => ({ type: "tool_use", id: a.id, name: "mcp__cbase__cbase_agent", input: a.input })) } });
  const rs = await Promise.all(jobs.map((a) => mcpCall("cbase_agent", a.input)));
  say({ type: "user", message: { content: jobs.map((a, i) => ({ type: "tool_result", tool_use_id: a.id, content: textOf(rs[i]) })) } });
  say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: "finished" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// Fake Codex as subagent: reads its MCP servers from the -c arguments, asks tools/list at the cbase server and records
// which servers and which enabled_tools it got.
const fakeCodexSub = () => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for a file to EXIST and then reads it — without rename it read an empty one under
// load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".part-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const joined = argv.join(" ");
const cfg = { env: {} };
const server = new Set();
const enabled = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const c = argv[i + 1] || "";
  const s = /^mcp_servers\\.([A-Za-z0-9_-]+)\\./.exec(c);
  if (s) server.add(s[1]);
  const e = /^mcp_servers\\.([A-Za-z0-9_-]+)\\.enabled_tools=(.*)$/.exec(c);
  if (e) enabled[e[1]] = JSON.parse(e[2]);
  const m = /^mcp_servers\\.cbase\\.(command|args|env\\.(\\w+))=(.*)$/.exec(c);
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
  say({ type: "thread.started", thread_id: "codex-sub" });
  say({ type: "turn.started" });
  const marker = (/Task ([A-Z0-9-]+)/.exec(joined) || [])[1] || "CODEX";
  if (joined.includes("SUBAGENT of cbase")) {
    const tools = ((await rpc("tools/list", {})).result || { tools: [] }).tools.map((t) => t.name);
    fs.writeFileSync(path.join(LOCATION, "view-" + marker + ".json"), JSON.stringify({ tools, env: cfg.env, server: [...server], enabled, skillCatalog: joined.includes("cbase_skill"),
      onlyMain: ((/Only the main agent has these MCP servers: (.+?) — /.exec(joined) || [])[1]) || null }));
  }
  say({ type: "item.completed", item: { id: "response", type: "agent_message", text: "Result CODEX" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

const viewOf = (root, marker) => JSON.parse(fs.readFileSync(path.join(root, `view-${marker}.json`), "utf8"));
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
// A skill in the workspace: without it cbase_skill would be missing from every run and the cut of the skill tool proved nothing.
const skill = (base, ws) => json(`${base}/api/workspaces/${ws.id}/skills`, { method: "POST", body: JSON.stringify({ name: "checklist", area: "coding", description: "Checks step by step.", body: "Instructions." }) });
const definition = (base, ws, name, tools) => json(`${base}/api/workspaces/${ws.id}/agents`, { method: "POST", body: JSON.stringify({ name, description: `Definition ${name}`, tools, body: "You review." }) });

test("three paths: \"Read, cbase_context_list\" shows exactly cbase_context_list at the cbase server — no list means the full set, empty means nothing", async () => {
  const engineRequests = [];
  const round = (b) => {
    const sys = String((b.messages || []).find((m) => m.role === "system")?.content || "");
    if (!sys.includes("SUBAGENT of cbase")) return null;
    engineRequests.push(b);
    return { text: "Result ENGINE" };
  };
  const claude = fakeClaude({
    sub: SUB,
    main: main([
      { id: "toolu_claude", input: { description: "Claude reader", prompt: "Task CLAUDE", subagent_type: "reader" } },
      { id: "toolu_codex", input: { description: "Codex reader", prompt: "Task CODEX", subagent_type: "reader", model: "codex::gpt-5.6-sol" } },
      { id: "toolu_engine", input: { description: "Engine reader", prompt: "Task ENGINE", subagent_type: "reader", model: "openrouter::m1" } },
      { id: "toolu_nurread", input: { description: "Read only", prompt: "Task ONLYREAD", subagent_type: "only-read" } },
      { id: "toolu_codexread", input: { description: "Codex read only", prompt: "Task CODEXREAD", subagent_type: "only-read", model: "codex::gpt-5.6-sol" } },
      { id: "toolu_free", input: { description: "Without list", prompt: "Task FREE", subagent_type: "free" } },
      { id: "toolu_empty", input: { description: "Empty list", prompt: "Task EMPTY", subagent_type: "empty" } },
    ]),
  });
  await withAgentsServer(async ({ base, chat, ws, root, waitForLog }) => {
    // Saving: an unknown name is a 400 carrying the name.
    const wrong = await fetch(`${base}/api/workspaces/${ws.id}/agents`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ name: "broken", tools: "Read, cbase_context_lsit" }) });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /cbase_context_lsit/);
    const reader = await definition(base, ws, "reader", "Read, cbase_context_list");
    assert.deepEqual(reader.toolList, ["Read", "cbase_context_list"]);
    await definition(base, ws, "only-read", "Read");
    const free = await definition(base, ws, "free", "");
    assert.equal(free.toolList, null, "an empty comma list is \"not set\"");
    const empty = await definition(base, ws, "empty", []);
    assert.deepEqual(empty.toolList, [], "an empty list is set");
    // A PUT without tools leaves the list alone.
    const unchanged = await json(`${base}/api/workspaces/${ws.id}/agents/${reader.id}`, { method: "PUT", body: JSON.stringify({ description: "fresh" }) });
    assert.deepEqual(unchanged.toolList, ["Read", "cbase_context_list"]);

    await skill(base, ws);
    await send(base, chat.id, "Three paths");
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    const claudeView = viewOf(root, "CLAUDE"), codexView = viewOf(root, "CODEX");
    const engineNames = (engineRequests[0]?.tools || []).map((t) => t.function?.name || t.name);
    console.log(`[toollist] Claude: cbase ${JSON.stringify(cbNames(claudeView.tools))}, built-in ${JSON.stringify(claudeView.builtin)}, servers ${JSON.stringify(claudeView.server)}`);
    console.log(`[toollist] Codex: cbase ${JSON.stringify(cbNames(codexView.tools))}, servers ${JSON.stringify(codexView.server)}; Engine: ${JSON.stringify(engineNames)}`);

    // cbase server: exactly cbase_context_list on all three paths.
    assert.deepEqual(cbNames(claudeView.tools), ["cbase_context_list"]);
    assert.deepEqual(cbNames(codexView.tools), ["cbase_context_list"]);
    assert.deepEqual(JSON.parse(claudeView.env.CBASE_TOOLS), ["cbase_context_list"]);
    assert.deepEqual(JSON.parse(codexView.env.CBASE_TOOLS), ["cbase_context_list"]);
    // Built-ins: Claude only Read; the engine offers exactly Read and cbase_context_list; Codex keeps its own (the CLI
    // does not cut them — the form hint says so).
    assert.deepEqual(claudeView.builtin, ["Read"]);
    assert.deepEqual(engineNames.filter((n) => n !== "ToolSearch").sort(), ["Read", "mcp__cbase__cbase_context_list"]);
    // Foreign servers: none (the list names none) — not the browser either, not even for Codex.
    assert.deepEqual(claudeView.server, ["cbase"]);
    assert.deepEqual(codexView.server, ["cbase"]);
    assert.equal(claudeView.allowed, "mcp__cbase");
    // Tool guidance: no skill catalog where there is no skill tool.
    assert.equal(claudeView.skillCatalog, false);
    assert.equal(cbNames(claudeView.tools).includes("cbase_skill"), false);

    // Built-ins only ("Read"): no cbase_* — on the Claude AND the Codex path.
    assert.deepEqual(cbNames(viewOf(root, "ONLYREAD").tools), []);
    assert.deepEqual(cbNames(viewOf(root, "CODEXREAD").tools), []);

    // No list: the full set of the path (the golden "subagent" holds the bytes).
    const freeView = viewOf(root, "FREE");
    assert.equal(freeView.env.CBASE_TOOLS, undefined, "no explicit list at the server without a list");
    assert.ok(cbNames(freeView.tools).includes("cbase_context_list") && cbNames(freeView.tools).includes("cbase_agent"));
    assert.ok(freeView.server.includes("playwright"), "without a list the browser stays");
    assert.ok(freeView.builtin.includes("Bash"));
    assert.ok(cbNames(freeView.tools).includes("cbase_skill") && freeView.skillCatalog, "without a list the skill tool and catalog stay");

    // Empty list: none of the cuttable tools.
    const emptyView = viewOf(root, "EMPTY");
    assert.deepEqual(cbNames(emptyView.tools), []);
    assert.deepEqual(emptyView.builtin, []);
    assert.deepEqual(emptyView.server, ["cbase"]);
  }, { claude, codex: fakeCodexSub(), engine: { round } });
});

// The list of a definition names no coding servers (400 with a hint); a subagent gets a coding server exactly when
// "Subagents inherit" is on there — as a shell under the server's name, fully allowed (the airlock checks per call),
// without `enabled_tools`. Whoever does not inherit appears in the frame sentence "… only the main agent has".
// Counter-test (shown red once): `unknownInWorkspace` accepting coding servers again => the definition saves, the 400 is missing.
test("coding server: not in the tool list (400), the subagent inherits only via the switch — Claude and Codex, frame sentence for the rest", async () => {
  const claude = fakeClaude({
    sub: SUB,
    main: main([
      { id: "toolu_s", input: { description: "Server", prompt: "Task SERVER", subagent_type: "server" } },
      { id: "toolu_codex", input: { description: "Codex", prompt: "Task CODEX", subagent_type: "server", model: "codex::gpt-5.6-sol" } },
    ]),
  });
  await withAgentsServer(async ({ base, chat, ws, root, waitForLog }) => {
    const created = {};
    for (const name of ["pg", "git"]) {
      created[name] = await json(`${base}/api/workspaces/${ws.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name, transport: "stdio", command: "node", args: ["-e", "0"] }) });
    }
    const gitId = created.git.server?.id || created.git.id;
    await json(`${base}/api/mcp-servers/${gitId}`, { method: "PATCH", body: JSON.stringify({ subagentsInherit: true }) });
    await assert.rejects(definition(base, ws, "server", "Read, mcp__cbase, mcp__pg__query, mcp__git"), (e) => /400/.test(String(e.message)) && /Subagenten erben/.test(String(e.message)), "a coding server in the list is a 400 with a hint");
    const def = await definition(base, ws, "server", "Read, mcp__cbase");
    assert.deepEqual(def.toolList, ["Read", "mcp__cbase"]);
    await skill(base, ws);
    await send(base, chat.id, "Server");
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    const s = viewOf(root, "SERVER"), c = viewOf(root, "CODEX");
    console.log(`[airlock] Server: Claude ${JSON.stringify(s.server)} allowed ${s.allowed}; Codex ${JSON.stringify(c.server)} enabled ${JSON.stringify(c.enabled)}; frame ${JSON.stringify(s.onlyMain)}`);
    assert.equal(s.env.CBASE_TOOLS, undefined, "mcp__cbase = the whole server, no cut");
    assert.deepEqual([...s.server].sort(), ["cbase", "git"], "git inherits (switch), pg does not — the list names neither");
    assert.deepEqual(s.allowed.split(",").sort(), ["mcp__cbase", "mcp__git"]);
    assert.deepEqual([...c.server].sort(), ["cbase", "git"]);
    assert.deepEqual(c.enabled, {}, "a shell carries no enabled_tools — it filters itself");
    assert.equal(s.onlyMain, "pg", "the frame names what only the main agent has");
    assert.equal(c.onlyMain, "pg");
  }, { claude, codex: fakeCodexSub() });
});
