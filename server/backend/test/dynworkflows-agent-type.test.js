// Worktree and agentType in the dynamic workflow, through the harness of the main seam (agent-harness.mjs): real server, real
// cbase MCP server, real agent core; only the providers are faked. Two options of `agent()` on mechanics that already stand:
//   - `isolation: 'worktree'` (+ additive `repo`): the core branches off as for cbase_agent (agent-runtime selectRepo); not
//     unambiguous => throw with the list of repos BEFORE any process; changed worktrees stay in place and are listed in the
//     completion notice (run.js changedWorktrees, from the journal);
//   - `agentType`: role and tool list of a cbase definition, 1:1, intersected with the set of the chat minus the block list of
//     the workflow agents (runs/agent-set.js workflowAgentSet, mcp/visibility.js lockedForWorkflowAgent); an unknown type
//     throws synchronously with the list (run.js agentTypeOf).
// agentType, isolation and repo stand in the journal key (journal.js normOptions): a resume with another repo breaks the
// prefix at exactly this call.
//
// Git runs under a fixed configuration from the ENVIRONMENT (`GIT_CONFIG_COUNT`, GLOBAL/NOSYSTEM off): `GIT_CONFIG_GLOBAL=
// /dev/null` alone does not cover `core.excludesFile`/`core.attributesFile`, and the test must hold on a foreign machine.
//
// COUNTER-TESTS (each turns the named test red):
//   - run.js not passing isolation/repo to the core (`coreIsolation` empty) turns "worktree" red: no throw without repo, the
//     agent works in the workspace;
//   - run.js without `subagent_type` at the start turns "agentType" red: no role, the full set;
//   - the block list not mixed in (agent-set.js workflowAgentSet without `lockedForWorkflowAgent` AND mcp/offering.js
//     without the flag) turns "agentType" red: cbase_agent appears;
//   - run.js without `agentTypeOf` turns "agentType" red: the unknown type starts only at the core (journal "launched");
//   - run.js without `worktreeRow` in the completion notice turns "worktree" red.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { workflowAgentSet } from "../electron/server/runs/agent-set.js";
import * as store from "../electron/server/store.js";

// ── Git without personal configuration (like agent-level-repo.test.js) ─────────────────────────────────────────────────
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test",
  GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com",
  GIT_CONFIG_KEY_2: "core.excludesFile", GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_KEY_3: "core.attributesFile", GIT_CONFIG_VALUE_3: "/dev/null",
  GIT_CONFIG_KEY_4: "init.defaultBranch", GIT_CONFIG_VALUE_4: "main",
};
async function withGitEnvironment(fn) {
  const prior = Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GIT_ENV);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
function createRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  fs.writeFileSync(path.join(dir, "common.txt"), "start\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "start"], dir);
}
const worktrees = (repo) => git(["worktree", "list", "--porcelain"], repo).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => fs.realpathSync(l.slice(9)));

// ── The providers ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A workflow agent with marker {TAG:x}: counts its spawns, stores tools (tools/list of its cbase server minus
// --disallowedTools), builtin tools, whether the role is in the system prompt, and its directory. "CHANGE" writes the SAME
// file into its directory; with the messenger (schema) it delivers an object.
const SUB = `
    const front = text.lastIndexOf("Here is the task:");
    const job = front >= 0 ? text.slice(front) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "spawns-" + tag), "1");
    const tools = await mcpTools();
    fs.writeFileSync(path.join(LOCATION, "at-" + tag + ".json"), JSON.stringify({ tools, builtin: eingebauteTools(), role: joined.includes("ROLE-CHECKER"), cwd: process.cwd() }));
    if (job.includes("CHANGE")) fs.writeFileSync(path.join(process.cwd(), "common.txt"), "by " + tag + "\\n");
    if (tools.includes("StructuredOutput")) await mcpCall("StructuredOutput", { ok: true, tag });
    say({ type: "assistant", message: { id: "s-" + tag, usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: "text", text: "Text " + tag }] } });
    finished();
    say({ type: "result", result: "Text " + tag, session_id: "sub-" + tag });`;
const claude = fakeClaude({ sub: SUB });

// Fake Codex with a real tools/list: the cbase server from -c mcp_servers.cbase.* (as codex.js passes it), the task with
// system prompt from the last argument (codex.js codexPrompt).
const codex = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it; without rename it would read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const argv = process.argv.slice(2);
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
const tag = text.includes("{TAG:") ? text.split("{TAG:")[1].split("}")[0] : "x";
const list = () => new Promise((resolve, reject) => {
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
      if (m.id === 2) { try { child.stdin.end(); } catch {} resolve(((m.result && m.result.tools) || []).map((t) => t.name)); }
    }
  });
  child.on("error", reject);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\\n");
});
(async () => {
  fs.appendFileSync(path.join(LOCATION, "spawns-" + tag), "1");
  fs.writeFileSync(path.join(LOCATION, "at-" + tag + ".json"), JSON.stringify({ tools: await list(), role: text.includes("ROLE-CHECKER") }));
  say({ type: "thread.started", thread_id: "cx-" + tag });
  say({ type: "turn.started" });
  say({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "Codex " + tag } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

// The loop engine: stores tools and system prompt of every request that carries the role.
const engineRoles = [];
const engineRound = (b) => {
  const system = (b.messages || []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (system.includes("ROLE-CHECKER")) engineRoles.push((b.tools || []).map((t) => t.function?.name || t.name));
  return { text: "Engine done" };
};

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Agent type', phases: [{ title: 'Work' }] }\n${body}\n`;
const readAt = (root, tag) => JSON.parse(fs.readFileSync(path.join(root, `at-${tag}.json`), "utf8"));
const spawns = (root, tag) => { const f = path.join(root, `spawns-${tag}`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0; };
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });

async function run(ctx, chatId, body) {
  const r = await post(`${ctx.base}/api/chats/${chatId}/dyn-workflows/run`, body);
  assert.equal(r.status, "started", JSON.stringify(r));
  const end = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), `run ${r.runId}`);
  const log = await ctx.waitForLog(chatId, (l) => l.some((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(r.runId)));
  await ctx.waitForIdle();
  return { ...r, end, notice: log.find((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(r.runId)).text };
}

test("worktree: one repo suffices without repo; with two agent() throws with the list without a process, repo chooses; two parallel ones write the same file without conflict, stay in place and are listed in the completion notice; a resume with another repo breaks exactly there", async () => {
  await withGitEnvironment(() => withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    // The project is in the workspace, its folder is no repo; create it empty first (a full folder would trigger the service scan).
    const projPath = path.join(root, "workspace", "till");
    const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Checkout", path: projPath }) });
    const app = path.join(projPath, "app");
    createRepo(app);
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
      workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
    }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Worktree workflow" }) });
    await ultracodeOn(base, chat.id);

    // One repo: the option suffices.
    const one = await run(ctx, chat.id, { script: script("one", "return await agent('CHANGE {TAG:e1}', { isolation: 'worktree' });") });
    assert.equal(one.end.status, "finished", one.end.error);
    const e1 = readAt(root, "e1");
    assert.ok(worktrees(app).includes(fs.realpathSync(e1.cwd)), `the agent worked in a worktree of app: ${e1.cwd}`);
    assert.equal(fs.readFileSync(path.join(app, "common.txt"), "utf8"), "start\n", "the repo itself stayed untouched");
    const wtOne = JSON.parse(fs.readFileSync(one.end.outputPath, "utf8")).worktrees || [];
    assert.deepEqual(wtOne.map((w) => fs.realpathSync(w.dir)), [fs.realpathSync(e1.cwd)], "the changed worktree is in the output file");
    assert.ok(one.notice.includes(wtOne[0].dir), `... and in the completion notice: ${one.notice}`);

    // Two repos: not unambiguous without repo; in parallel with repo; an unchanged one disappears.
    const lib = path.join(projPath, "lib");
    createRepo(lib);
    const two = await run(ctx, chat.id, { script: script("two", [
      "let without = 'no throw';",
      "try { await agent('CHANGE {TAG:without}', { isolation: 'worktree' }); } catch (e) { without = e.message; }",
      "const [p, q] = await parallel([() => agent('CHANGE {TAG:p1}', { isolation: 'worktree', repo: 'lib' }), () => agent('CHANGE {TAG:p2}', { isolation: 'worktree', repo: 'lib' })]);",
      "const u = await agent('READ {TAG:u1}', { isolation: 'worktree', repo: 'app' });",
      "return { without, p, q, u };",
    ].join("\n")) });
    assert.equal(two.end.status, "finished", two.end.error);
    const { without, p, q, u } = two.end.returnValue;
    assert.match(without, /is ambiguous here/, without);
    assert.ok(without.includes('"app"') && without.includes('"lib"'), `the throw names both repos: ${without}`);
    assert.equal(spawns(root, "without"), 0, "without an unambiguous repo no agent process comes into being");
    assert.deepEqual([p, q, u], ["Text p1", "Text p2", "Text u1"]);
    const [p1, p2, u1] = ["p1", "p2", "u1"].map((t) => readAt(root, t));
    assert.notEqual(p1.cwd, p2.cwd, "two worktrees of their own");
    for (const [x, tag] of [[p1, "p1"], [p2, "p2"]]) {
      assert.ok(worktrees(lib).includes(fs.realpathSync(x.cwd)), `${tag} is a worktree of lib`);
      assert.equal(fs.readFileSync(path.join(x.cwd, "common.txt"), "utf8"), `by ${tag}\n`, `${tag}: the same file, no conflict`);
    }
    const output = JSON.parse(fs.readFileSync(two.end.outputPath, "utf8"));
    assert.deepEqual(output.worktrees.map((w) => fs.realpathSync(w.dir)).sort(), [p1.cwd, p2.cwd].map((d) => fs.realpathSync(d)).sort(), "the output file carries exactly the two changed ones");
    for (const w of output.worktrees) {
      assert.ok(two.notice.includes(w.dir), `${w.dir} is in the completion notice: ${two.notice}`);
      assert.ok(fs.existsSync(w.dir), `${w.dir} is still there afterwards`);
    }
    assert.equal(fs.readFileSync(path.join(lib, "common.txt"), "utf8"), "start\n");
    assert.equal(fs.existsSync(u1.cwd), false, "the unchanged worktree is gone");
    assert.equal(two.notice.includes(path.basename(u1.cwd)), false, "... and not in the notice");
    assert.match(two.notice, /Changed worktrees stay in place and are not cleaned up \(2\)/);
    const launched = store.readDynJournal(two.runId).filter((e) => e.kind === "launched").map((e) => e.n);
    assert.ok(launched.includes(1), "the throw at the core is in the journal (launched + failed)");
    assert.ok(store.readDynJournal(two.runId).some((e) => e.kind === "failed" && e.n === 1 && /is ambiguous here/.test(e.error)));

    // Resume with another repo: the call before comes from the cache, from the changed one on everything runs again.
    const text = (repo) => script("resume", [
      "const a = await agent('READ {TAG:r1}');",
      `const b = await agent('READ {TAG:r2}', { isolation: 'worktree', repo: '${repo}' });`,
      "const c = await agent('READ {TAG:r3}');",
      "return { a, b, c };",
    ].join("\n"));
    const r1 = await run(ctx, chat.id, { script: text("app") });
    assert.equal(r1.end.status, "finished", r1.end.error);
    const equal = await run(ctx, chat.id, { script: text("app"), resumeFromRunId: r1.runId });
    assert.deepEqual([spawns(root, "r1"), spawns(root, "r2"), spawns(root, "r3")], [1, 1, 1], "same repo => everything from the cache");
    assert.equal(equal.end.status, "finished");
    const different = await run(ctx, chat.id, { script: text("lib"), resumeFromRunId: r1.runId });
    assert.equal(different.end.status, "finished", different.end.error);
    assert.deepEqual([spawns(root, "r1"), spawns(root, "r2"), spawns(root, "r3")], [1, 2, 2], "another repo => the prefix breaks exactly at this call");
    const fromCache = store.readDynJournal(different.runId).filter((e) => e.kind === "result").map((e) => [e.n, e.fromCache === true]);
    assert.deepEqual(fromCache.sort(), [[1, true], [2, false], [3, false]]);
    const key = (runId, n) => store.readDynJournal(runId).find((e) => e.kind === "launched" && e.n === n).key;
    assert.equal(key(different.runId, 1), key(r1.runId, 1));
    assert.notEqual(key(different.runId, 2), key(r1.runId, 2), "repo is in the key");
    console.log(`  [worktree] one: ${path.basename(e1.cwd)}; two in parallel in lib: ${path.basename(p1.cwd)}, ${path.basename(p2.cwd)}; resume repo app->lib: spawns r1/r2/r3 = 1/2/2`);
  }, { claude }));
});

test("agentType: role and tool list of the definition for Claude, Codex and the loop engine, without block list and without what the chat does not have; with a schema the messenger stays; an unknown type throws synchronously with the list", async () => {
  engineRoles.length = 0;
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root, engine } = ctx;
    await ultracodeOn(base, chat.id);
    const T0 = Date.now();
    // The definition lists one ordinary tool, two from the block list and one that a coding chat does not have
    // (cbase_channel_create), plus a builtin one.
    const list = ["Read", "cbase_projects_list", "cbase_agent", "cbase_dynamic_workflow", "cbase_channel_create"];
    store.createAgent({ id: "a-checker", workspaceId: ws.id, name: "checker", description: "Checks", body: "ROLE-CHECKER: you check.", toolList: list, createdAt: T0, updatedAt: T0 });

    const S = { type: "object", properties: { ok: { type: "boolean" }, tag: { type: "string" } }, required: ["ok"] };
    const r = await run(ctx, chat.id, { script: script("types", [
      "const c = await agent('T {TAG:tc}', { agentType: 'checker' });",
      "const x = await agent('T {TAG:tx}', { agentType: 'Checker', model: 'codex::gpt-5.6-sol' });",
      `const e = await agent('T', { agentType: 'checker', model: ${JSON.stringify(engine.model)} });`,
      `const s = await agent('T {TAG:ts}', { agentType: 'checker', schema: ${JSON.stringify(S)} });`,
      "const o = await agent('T {TAG:to}');",
      "let unknown = 'no throw';",
      "try { await agent('U {TAG:tu}', { agentType: 'doesnotexist' }); } catch (err) { unknown = err.message; }",
      "return { c, x, e, s, o, unknown };",
    ].join("\n")) });
    assert.equal(r.end.status, "finished", r.end.error);
    const { c, x, e, s, o, unknown } = r.end.returnValue;
    assert.deepEqual([c, x, e], ["Text tc", "Codex tx", "Engine done"]);

    const locked = ["cbase_agent", "cbase_dynamic_workflow", "cbase_channel_create"];
    // Claude: role in the system prompt, exactly what is listed (tools/list of the cbase server), builtin only Read.
    const tc = readAt(root, "tc");
    assert.equal(tc.role, true, "Claude: the role of the definition is in the system prompt");
    assert.ok(tc.tools.includes("cbase_projects_list"), `Claude: the listed tool is there: ${tc.tools}`);
    for (const w of locked) assert.equal(tc.tools.includes(w), false, `Claude: ${w} is missing despite the list`);
    assert.deepEqual(tc.builtin, ["Read"], "Claude: the builtins of the list");
    // Codex: does not read the list; the cut sits in the MCP server (tools/list).
    const tx = readAt(root, "tx");
    assert.equal(tx.role, true, "Codex: the role is in the prompt");
    assert.ok(tx.tools.includes("cbase_projects_list"), `Codex: ${tx.tools}`);
    for (const w of locked) assert.equal(tx.tools.includes(w), false, `Codex: ${w} is missing in the tools/list of the MCP server`);
    // Loop engine: its allowlist.
    assert.ok(engineRoles.length >= 1, "Engine: the role is in the system prompt");
    const en = engineRoles[0];
    assert.ok(en.includes("mcp__cbase__cbase_projects_list"), `Engine: ${en}`);
    for (const w of locked) assert.equal(en.includes(`mcp__cbase__${w}`), false, `Engine: ${w} is missing`);
    // The same answer from the ONE computation (runs/agent-set.js), checked after the providers so that the counter-test
    // "block list not mixed in" turns red at the providers, not here.
    assert.deepEqual(workflowAgentSet({ required: list }).cbase, ["cbase_projects_list"]);
    // StructuredOutput survives the cut of the definition.
    assert.deepEqual(s, { ok: true, tag: "ts" }, "with a schema the agent of the definition delivers the object");
    assert.ok(readAt(root, "ts").tools.includes("StructuredOutput"), "the messenger stands next to the list of the definition");
    assert.equal(readAt(root, "tc").tools.includes("StructuredOutput"), false, "without a schema no messenger");
    // Without agentType: the set of the chat (only minus the block list) and no role.
    assert.equal(o, "Text to");
    const to = readAt(root, "to");
    assert.equal(to.role, false);
    assert.ok(to.tools.length > tc.tools.length, "without a definition the full set of the chat");
    // Unknown: synchronous, with the list, without journal and without a process.
    assert.match(unknown, /^agent\(\): unknown agentType 'doesnotexist'\. Available agent types: .*general-purpose.*checker/, unknown);
    assert.equal(spawns(root, "tu"), 0, "no agent process");
    assert.equal(store.readDynJournal(r.runId).filter((j) => j.kind === "launched").length, 5, "no journal for the unknown type");
    // agentType is in the key: the same calls without it would give other keys (a resume would not hit).
    const lc = store.readDynJournal(r.runId).find((j) => j.kind === "launched" && j.n === 1);
    assert.equal(lc.opts.agentType, "checker");
    console.log(`  [agentType] Claude ${tc.tools.length} tools (${tc.tools.join(",")}), Codex ${tx.tools.length}, Engine ${en.length}; without type ${to.tools.length}`);
  }, { claude, codex, engine: { round: engineRound } });
});

// The main agent wrote agent(…, { subagent_type: 'status-scanner' }); the option must not be silently ignored, and the
// workflow agent must run the model of the definition, not that of the chat (cbase_agent takes `def.model`).
// COUNTER-TEST: restoring the old agent-type reading (only opts.agentType, model not returned) gives "Text ma" instead of
// "Codex ma".
test("agentType: the model of the definition applies without model in the call, a model in the call wins; subagent_type is the same option; two different ones throw", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root } = ctx;
    await ultracodeOn(base, chat.id);
    const T0 = Date.now();
    store.createAgent({ id: "a-scanner", workspaceId: ws.id, name: "scanner", description: "Scans", body: "ROLE-CHECKER: you scan.", model: "codex::gpt-5.6-sol", createdAt: T0, updatedAt: T0 });
    store.createAgent({ id: "a-other", workspaceId: ws.id, name: "other", description: "Different", body: "ROLE-OTHER", createdAt: T0, updatedAt: T0 });
    const r = await run(ctx, chat.id, { script: script("type_model", [
      "const a = await agent('T {TAG:ma}', { agentType: 'scanner' });",
      "const b = await agent('T {TAG:mb}', { subagent_type: 'Scanner' });",
      "const c = await agent('T {TAG:mc}', { agentType: 'scanner', model: 'claude-haiku-4-5-20251001' });",
      "const d = await agent('T {TAG:md}', { agentType: 'other' });",
      "let two = 'no throw';",
      "try { await agent('T {TAG:mz}', { agentType: 'scanner', subagent_type: 'other' }); } catch (e) { two = e.message; }",
      "return { a, b, c, d, two };",
    ].join("\n")) });
    assert.equal(r.end.status, "finished", r.end.error);
    const { a, b, c, d, two } = r.end.returnValue;
    assert.equal(a, "Codex ma", "without model: the model of the definition (codex), not that of the chat");
    assert.equal(b, "Codex mb", "subagent_type acts like agentType");
    assert.equal(readAt(root, "mb").role, true, "... with the role of the definition");
    assert.equal(c, "Text mc", "a model in the call beats that of the definition");
    assert.equal(d, "Text md", "a definition without a model inherits the chat");
    assert.match(two, /agentType and subagent_type name different types/);
    assert.equal(spawns(root, "mz"), 0, "the throw starts no process");
    const launched = (n) => store.readDynJournal(r.runId).find((j) => j.kind === "launched" && j.n === n);
    assert.equal(launched(1).provider, "codex", "the journal names the provider of the definition");
    assert.equal(launched(3).provider, "claude");
  }, { claude, codex });
});
