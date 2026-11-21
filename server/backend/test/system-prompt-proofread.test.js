// Guards of the system prompt findings (second reading): the findings 1–8 of the system prompt measurement. Where a finding
// already has a thematic guard, it lives there (each test's header names it).
//
// Finding 1  Project memory of a subagent whose record carries no instance (started before the move, adopted): B asks for the
//            instance NOW and never reads a converted project via the path (runs/system-prompt.js projectMemory).
// Finding 2  The project memory covers what Codex used to read itself: the way from the git root to the working folder, for a
//            subagent also that of its worktree (memoryFolder, agentCwd); what B reads for a copy stops at its boundary.
// Finding 3  The hook "SubagentStop" fires at the end of every subagent (runs/agents.js → providers/hook-run.js); every offered
//            hook kind has a firer.
// Finding 4  (the to-do set per provider fell with the to-do section; see below.)
// Finding 5  A stop (human, main agent, core closed) while the core builds the spec prevents the spawn — after EVERY
//            `await buildSpec()` in drive (providers/agent-runtime.js), also in the restart of a turn.
// Finding 6  A message delivered before the first process belongs to the input that a continuation repeats after parking at the
//            limit (`rec.lastInput` in drive, both branches, as in the restart path).
// Finding 7  `caps.subagents` is gone: no run read it, web and iOS showed it (providers/contract.js normalizeCaps, the
//            connectors, web ProviderSettings.tsx, iOS ProviderSettings/ProviderEditor/AccountModels, fixture of the iOS test);
//            stored or sent it stays valid and is ignored.
// Finding 8  A Codex run without chosen built-ins (outer loop, sandboxed oneshot) switches off `request_user_input`
//            (CODEX_WITHOUT_FILE_ACCESS += `-c tools.experimental_request_user_input.enabled=false`, measured on the wire with
//            the real CLI at 0.162.1 and 0.153.1) — the frame need not name it.
//
// COUNTER-TESTS: see the header of each test.
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/system-prompt-proofread.test.js

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { agentSpecFactory } from "../electron/server/runs/agents.js";
import { instanceForProject } from "../electron/server/runs/instance.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { chatSkills } from "../electron/server/toolchain/skill-catalog.js";
import { HOOK_EVENTS } from "../electron/server/toolchain/profiles.js";
import { runningHooks } from "../electron/server/providers/hook-run.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";
import { fakeClaude, fakeCodex, withAgentsServer } from "./agent-harness.mjs";

const json = async (url, opts = {}) => (await fetch(url, { ...opts, headers: { "Content-Type": "application/json", Connection: "close" } })).json();

// The operation marker (projectbox/ops.js) only for the duration of ONE call — without it every project counts as "not converted".
const OPS = ["CBASE_CONTAINER", "CBASE_DIND"];
async function inOps(fn) {
  const saved = Object.fromEntries(OPS.map((k) => [k, process.env[k]]));
  for (const k of OPS) process.env[k] = "1";
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// A converted project in the server's chat: project folder under the workspace, instance row, runtime folder.
async function convertedProject({ base, ws, chat }, name = "till") {
  const filePath = path.join(ws.path, name);
  fs.mkdirSync(filePath, { recursive: true });
  const p = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}` });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  fs.mkdirSync(locationFor({ projectId: p.id, converted: true }).root, { recursive: true });
  return { path: filePath, projectId: p.id };
}

// The factory of a core as the agent opener builds it (Claude, without cut) — and the start of an agent.
function factoryFor(chatId, { instance = null } = {}) {
  const row = store.getChat(chatId);
  return agentSpecFactory({
    chat: row, provider: "claude",
    profile: { permissionMode: "bypassPermissions", addDirs: [], builtinTools: null },
    tools: { toolset: "", cbase: null, extraServers: [], extern: [], mcpAllow: [], skills: chatSkills(row) },
    depth: 1,
  }, { instance });
}
const start = (cwd, extra = {}) => ({ agentId: `g-${Math.random().toString(36).slice(2, 8)}`, systemPrompt: "Role", input: "x", provider: "claude",
  model: "claude-haiku-4-5-20251001", cwd, tools: null, skills: [], sessionId: null, transcript: [], inheritContext: false, ...extra });

// ── Finding 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A subagent that started before its project's move carries no instance in its record (agent-runtime.js adopt:
// `rec.instance = null`); the core that adopts it is already converted. B used to read its project memory via the path —
// `<project>/CLAUDE.md → ~/.claude-login/.credentials.json` (placed in the project container) was in the system prompt, and
// a FIFO held the event loop until a writer came (here a child process after 3 s: its text would be in the prompt).
// COUNTER-TEST: runs/system-prompt.js projectMemory with `projectMemoryPromptIn(…, instance)` (without asking) again ⇒ red
// (B-SECRET in the prompt).
test("record without instance + converted project — no link out of the project folder, no FIFO in the prompt; a vanished copy without memory; without server operation as before", async () => {
  await withAgentsServer(async (ctx) => {
    const { path: filePath, projectId } = await convertedProject(ctx);
    const secret = path.join(ctx.root, "home", "secret.txt");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, '{"accessToken":"B-SECRET-TOKEN-7"}\n');
    fs.symlinkSync(secret, path.join(filePath, "CLAUDE.md"));
    fs.writeFileSync(path.join(filePath, "AGENTS.md"), "Project rule: PROJ-RULE-G1\n");
    const main = await inOps(() => instanceForProject(projectId));
    assert.ok(main, "the instance row exists (operation + converted)");
    const factory = factoryFor(ctx.chat.id, { instance: main });

    // Record without instance — the agent runs in B, in the workspace.
    const sp = (await inOps(() => factory(start(ctx.ws.path, { instance: null })))).systemPrompt;
    assert.ok(!sp.includes("B-SECRET"), `a file of B was in the system prompt:\n${sp.slice(-600)}`);
    assert.match(sp, /PROJ-RULE-G1/, "the regular file of the project stays");

    // FIFO instead of the file: no hang, no content.
    fs.rmSync(path.join(filePath, "CLAUDE.md"));
    const fifo = path.join(filePath, "CLAUDE.md");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const writer = spawn("sh", ["-c", `sleep 3; printf 'FIFO-CONTENT-G1' > '${fifo}'`], { stdio: "ignore" });
    try {
      const sp2 = (await inOps(() => factory(start(ctx.ws.path, { instance: null })))).systemPrompt;
      assert.ok(!sp2.includes("FIFO-CONTENT-G1"), "B read the FIFO in the project folder");
      assert.match(sp2, /PROJ-RULE-G1/);
    } finally { writer.kill("SIGKILL"); }

    // A copy that no longer exists: no memory — never the main's in its place.
    const sp3 = (await inOps(() => factory(start(ctx.ws.path, { instance: `${projectId}/copy-away` })))).systemPrompt;
    assert.ok(!sp3.includes("# Project memory"), `the main's memory took the copy's place:\n${sp3.slice(-600)}`);

    // Without server operation (local) nothing is converted — reading works as before.
    fs.rmSync(fifo);
    fs.writeFileSync(path.join(filePath, "CLAUDE.md"), "PROJ-CLAUDE-G1\n");
    const sp4 = (await factory(start(ctx.ws.path, { instance: null }))).systemPrompt;
    assert.match(sp4, /PROJ-CLAUDE-G1/);
    assert.match(sp4, /PROJ-RULE-G1/);
  });
});

// ── Finding 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Since Codex no longer reads its project memory itself (`project_doc_max_bytes=0`, finding 6), what it read and cbase's list did
// not name was missing — measured at 0.162.1 (sp6): from the git root through every intermediate folder to the working folder.
// In the main run the root ABOVE the workspace, for a subagent its worktree (cbase read via the CHAT's working folder). Now the
// same way for every provider (runs/system-prompt.js memoryFolder), for a subagent additionally that of its working folder
// (agentCwd).
// COUNTER-TESTS: memoryFolder `[ws, cwd, proj]` again without the way ⇒ (a) and (b) red; runs/agents.js without `agentCwd` ⇒
// (b) red; projectMemoryPromptIn of a copy without `limit` again ⇒ (c) red (B-SECRET from the copy's worktree in the prompt).
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

test("(a) the main run reads from the git root through every intermediate folder to the working folder — without a root only the folder; in an instance not beyond its anchors", async () => {
  const { projectMemory, memoryFolder } = await import("../electron/server/runs/system-prompt.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "cbase-g2a-")));
  try {
    const root = path.join(tmp, "root"), middle = path.join(root, "middle"), ws = path.join(middle, "ws");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(path.join(root, ".git")); // the marker by which Codex also recognizes the root (project_root_markers)
    fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT-RULE-G2\n");
    fs.writeFileSync(path.join(middle, "CLAUDE.md"), "MIDDLE-RULE-G2\n");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "WS-RULE-G2\n");
    const mem = await projectMemory({ id: "g2a" }, { cwd: ws, instance: null });
    const places = ["ROOT-RULE-G2", "MIDDLE-RULE-G2", "WS-RULE-G2"].map((m) => mem.indexOf(m));
    assert.ok(places.every((i) => i >= 0), `the way from the root is missing:\n${mem}`);
    assert.deepEqual([...places].sort((x, y) => x - y), places, "order as in Codex: from the root downwards");
    // Without a root: only the working folder (as before, and as in Codex).
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    assert.deepEqual(memoryFolder({}, ws, null), [ws]);
    // In an instance the way ends at the anchor under which the working folder lies (the container sees nothing above).
    fs.mkdirSync(path.join(root, ".git"));
    assert.deepEqual(memoryFolder({}, ws, null, { limits: [middle] }), [ws]);
    assert.deepEqual(memoryFolder({}, ws, null, { limits: [ws] }), [ws]);
    assert.deepEqual(memoryFolder({}, ws, null, { limits: [path.join(tmp, "elsewhere")] }), [root, middle, ws]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("(b) a subagent in the worktree carries the AGENTS.md of its repo (and of the subfolder it works in) — next to the chat's memory; converted: across the boundary", async () => {
  await withAgentsServer(async (ctx) => {
    fs.writeFileSync(path.join(ctx.ws.path, "CLAUDE.md"), "WS-RULE-G2B\n");
    const repo = path.join(ctx.root, "repo");
    fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "REPO-RULE-G2B\n");
    fs.writeFileSync(path.join(repo, "pkg", "AGENTS.md"), "PKG-RULE-G2B\n");
    assert.equal(git(repo, "init", "-q").status, 0);
    git(repo, "add", "-A");
    assert.equal(git(repo, "commit", "-q", "-m", "x").status, 0);
    const wt = path.join(ctx.root, "worktrees", "agent-g2b");
    assert.equal(git(repo, "worktree", "add", "-q", wt, "HEAD").status, 0);
    const factory = factoryFor(ctx.chat.id);
    for (const provider of ["claude", "codex"]) {
      const sp = (await factory(start(path.join(wt, "pkg"), { provider, instance: null }))).systemPrompt;
      for (const m of ["REPO-RULE-G2B", "PKG-RULE-G2B"]) assert.ok(sp.includes(m), `${provider}: ${m} missing\n${sp.slice(-900)}`);
      // The workspace folder contributes nothing any more — those are the workspace's instructions in the database.
      assert.ok(!sp.includes("WS-RULE-G2B"), `${provider}: the CLAUDE.md of the workspace folder must no longer appear`);
      assert.ok(sp.indexOf("REPO-RULE-G2B") < sp.indexOf("PKG-RULE-G2B"), `${provider}: the agent's way from the root downwards`);
    }
    // Converted: the worktree lies in the runtime folder (rw in the project container) — a link there does not lead out.
    const { projectId } = await convertedProject(ctx);
    const main = await inOps(() => instanceForProject(projectId));
    const wtB = path.join(locationFor({ projectId, converted: true }).worktrees, "agent-g2c");
    fs.mkdirSync(wtB, { recursive: true });
    fs.writeFileSync(path.join(wtB, ".git"), "gitdir: /nowhere\n");
    fs.writeFileSync(path.join(wtB, "AGENTS.md"), "WT-RULE-G2C\n");
    const secret = path.join(ctx.root, "home", "secret-g2.txt");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "B-SECRET-G2\n");
    fs.symlinkSync(secret, path.join(wtB, "CLAUDE.md"));
    const spB = (await inOps(() => factoryFor(ctx.chat.id, { instance: main })(start(wtB, { instance: main.identifier || `${projectId}/main` })))).systemPrompt;
    assert.ok(spB.includes("WT-RULE-G2C"), `the worktree's AGENTS.md is missing:\n${spB.slice(-900)}`);
    assert.ok(!spB.includes("B-SECRET-G2"), "a link in the worktree led out");
  });
});

test("(c) what B reads for a copy (its runtime folder with its agents' worktrees) stops at its boundary — no link out, no FIFO; the copy's version stays", async () => {
  const { withCopy, situationDefault, buildCopy } = await import("./stacks-copy-harness.mjs");
  const { projectMemoryPromptIn } = await import("../electron/server/runs/system-prompt.js");
  const { worktreeRoot } = await import("../electron/server/runs/runtime-location.js");
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); }, async ({ ctx, b }) => {
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: b.s.projectId }) });
    await buildCopy(b, { chatId: ctx.chat.id });
    const inst = instanceForProject(b.s.projectId, "copy-k1");
    assert.ok(inst, "the copy can be resolved");
    const wt = path.join(worktreeRoot(locationFor({ projectId: b.s.projectId, converted: true }), "copy-k1"), "agent-g2k");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "WT-COPY-RULE\n");
    const secret = path.join(ctx.root, "home", "secret-g2k.txt");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "B-SECRET-G2K\n");
    fs.symlinkSync(secret, path.join(wt, "CLAUDE.md"));
    const mem = await projectMemoryPromptIn([wt], inst);
    assert.ok(mem.includes("WT-COPY-RULE"), `the AGENTS.md in the copy's worktree is missing:\n${mem}`);
    assert.ok(!mem.includes("B-SECRET-G2K"), `a link in the copy's runtime folder led out:\n${mem}`);
    fs.rmSync(path.join(wt, "CLAUDE.md"));
    assert.equal(spawnSync("mkfifo", [path.join(wt, "CLAUDE.md")]).status, 0);
    assert.match(await projectMemoryPromptIn([wt], inst), /WT-COPY-RULE/, "a FIFO in the copy's runtime folder");
  });
});

// ── Finding 3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The hook "SubagentStop" was fired only by the loop engine's `Task`; with it the only caller fell, and toolchain/profiles.js
// HOOK_EVENTS, web and iOS kept offering the kind. Now the core fires it at the end of EVERY subagent
// (runs/agents.js onFinish → providers/hook-run.js fireAgentHook), for every provider.
// COUNTER-TEST: runs/agents.js without the line `if (!ol) subagentStopHook(info.report);` ⇒ (a) and (b) red.
const SERVER = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "electron", "server");
function jsFiles(root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...jsFiles(p)); }
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}
// A firer: a call of a hook path with the kind's name as literal (engine.js fireNotifyHook/fireContextHook/matchHooks,
// providers/hook-run.js fireAgentHook/matchingHooks).
const FIRER = /\b(?:fireNotifyHook|fireContextHook|matchHooks|fireAgentHook)\(\s*"([A-Za-z]+)"|\bpassendeHooks\([^,()]+,\s*"([A-Za-z]+)"/g;

test("(a) every offered hook kind has a firer", () => {
  const fired = new Set();
  for (const f of jsFiles(SERVER)) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(FIRER)) fired.add(m[1] || m[2]);
  }
  const without = HOOK_EVENTS.filter((e) => !fired.has(e));
  assert.deepEqual(without, [], `offered (toolchain/profiles.js HOOK_EVENTS, web, iOS), but fired nowhere: ${without.join(", ")}`);
  const foreign = [...fired].filter((e) => !HOOK_EVENTS.includes(e));
  assert.deepEqual(foreign, [], `fired, but not offered: ${foreign.join(", ")}`);
});

const G3_MAIN = `
  if (text.includes("G3-START")) {
    const jobs = [
      { description: "claude-sub", prompt: "G3-SUB-CLAUDE", run_in_background: false },
      { description: "codex-sub", prompt: "G3-SUB-CODEX", model: "codex::gpt-5.6-sol", run_in_background: false },
    ];
    for (const [i, a] of jobs.entries()) {
      const id = "toolu_g3_" + i;
      say({ type: "assistant", message: { id: "g3-" + i, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input: a }] } });
      let r = "";
      try { r = textOf(await mcpCall("cbase_agent", a)); } catch (e) { r = "ERROR " + e.message; }
      fs.writeFileSync(path.join(LOCATION, "g3-report-" + i), r);
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: r }] } });
    }
  }
  say({ type: "assistant", message: { id: "g3-end-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "g3-main" });`;
const G3_SUB = `
  say({ type: "assistant", message: { id: "g3-s", content: [{ type: "text", text: "Claude-Report-G3" }] } });
  finished();
  say({ type: "result", result: "Claude-Report-G3", session_id: "g3-sub" });`;

test("(b) the end of a subagent fires \"SubagentStop\" exactly once — Claude and Codex, content as before, the matcher checks the type", async () => {
  await withAgentsServer(async ({ base, ws, root, waitForTruthy, waitForIdle }) => {
    const json = async (url, opts = {}) => (await fetch(url, { ...opts, headers: { "Content-Type": "application/json", Connection: "close" } })).json();
    const file = path.join(root, "g3-hook.jsonl"), foreign = path.join(root, "g3-hook-foreign.jsonl");
    const r = await json(`${base}/api/agent-hooks`, { method: "PUT", body: JSON.stringify({ hooks: [
      { event: "SubagentStop", matcher: "*", command: `cat >> '${file}'; echo >> '${file}'` },
      { event: "SubagentStop", matcher: "^nobody$", command: `cat >> '${foreign}'; echo >> '${foreign}'` },
    ] }) });
    assert.equal(r.hooks?.length, 2, JSON.stringify(r));
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
      workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
    }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Hook" }) });
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "G3-START" }) });
    await waitForTruthy(() => fs.existsSync(path.join(root, "g3-report-1")), "two subagents reported");
    // Idle: both agents have ended (onFinish ran); then the end of the hooks that fired — no waiting for a file that would
    // never come without a firer.
    await waitForIdle();
    await runningHooks();
    const z = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((x) => x.trim()).map((x) => JSON.parse(x)) : [];
    assert.equal(z.length, 2, `exactly one hook per subagent:\n${JSON.stringify(z, null, 1)}`);
    assert.equal(new Set(z.map((e) => e.agent_id)).size, 2, "two different agents");
    for (const e of z) {
      assert.equal(e.hook_event_name, "SubagentStop");
      assert.equal(e.agent, "general-purpose");
      assert.equal(e.cwd, ws.path);
      assert.ok("session_id" in e && !("error" in e), JSON.stringify(e));
    }
    assert.deepEqual(z.map((e) => e.result).sort(), ["Claude-Report-G3", "Codex-Report-G3"]);
    assert.ok(!fs.existsSync(foreign), "a hook with a foreign matcher fired");
  }, { claude: fakeClaude({ main: G3_MAIN, sub: G3_SUB }), codex: fakeCodex({ text: "Codex-Report-G3" }) });
});

// ── Finding 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (The two guards of the to-do sentence — it named each provider's own task list, Claude TaskCreate/TaskUpdate, Codex and the
// loop engine the neutral sentence — fell with the removal of the to-do section of the system prompt. That the base rule and the
// monitor/wakeup descriptions name no tool that no provider offers is held by system-prompt-findings.test.js, finding 4.)

// ── Findings 5 and 6: the core between `await buildSpec()` and the spawn (providers/agent-runtime.js drive) ─────────────────────
// Directly at the core, without a server: `buildSpec` waits at a gate the test opens; `runChat` counts the spawns (a call IS the
// spawn, onSpawn comes after). After opening a gate the test waits until the microtask queue is empty (`quiet`): between the
// resolved build and the spawn there is no I/O step, so a spawn is settled afterwards or never — no duration.
const signal = () => { let on; const p = new Promise((r) => { on = r; }); return { p, on }; };
const quiet = () => new Promise((r) => setImmediate(r));
function coreWithGates({ runChat, atLimit = null, startGate } = {}) {
  const specs = [];
  const buildCalled = new Map();
  const buildGate = new Map();
  const end = signal();
  const rt = createAgentRuntime({
    chatId: `c-${Math.random().toString(36).slice(2, 8)}`,
    cwd: process.cwd(),
    parentProvider: "claude",
    resolveRef: () => ({ connector: {}, providerId: "claude", model: "" }),
    buildSpec: async (a) => {
      const n = specs.push(String(a.input));
      buildCalled.get(n)?.on();
      if (buildGate.has(n)) await buildGate.get(n).p;
      return {};
    },
    runChat,
    ...(atLimit ? { atLimit } : {}),
    ...(startGate ? { startGate } : {}),
    wakeup: (ms, fn) => { const t = setImmediate(fn); return () => clearImmediate(t); },
    onFinish: (rec, info) => end.on(info.report),
  });
  // The n-th build (1-based) waits until `open(n)`; `called(n)` resolves as soon as it has begun.
  const gateAt = (n) => { buildGate.set(n, signal()); buildCalled.set(n, signal()); };
  return { rt, specs, end: end.p, gateAt, called: (n) => buildCalled.get(n).p, open: (n) => buildGate.get(n).on() };
}

// Counter-test: the three `if (over()) …` after `await buildSpec()` removed from drive ⇒ (a) 1 spawn, (b) 1 spawn, (c) 2 spawns
// instead of 1 — red.
test("a stop while the spec is being built — no spawn (first build, build after a message before the start, restart of the turn)", async () => {
  const counted = {};
  // (a) Stop in the first build.
  {
    let spawns = 0;
    const k = coreWithGates({ runChat: async () => { spawns += 1; return { code: 0, resultText: "never" }; } });
    k.gateAt(1);
    const first = await k.rt.start({ prompt: "Task a", run_in_background: true });
    await k.called(1);
    assert.equal(k.rt.stop(first.agentId, { ofHuman: true }), true);
    const report = await k.end;
    assert.equal(report.status, "stopped");
    k.open(1);
    await quiet();
    counted.a = spawns; // a stopped agent spawned after the build of its spec
    k.rt.close();
  }
  // (b) A message before the start extends the input (second build), the stop comes in this second build.
  {
    let spawns = 0;
    const k = coreWithGates({ runChat: async () => { spawns += 1; return { code: 0, resultText: "never" }; } });
    k.gateAt(1);
    k.gateAt(2);
    const first = await k.rt.start({ prompt: "Task b", run_in_background: true });
    await k.called(1);
    assert.equal(await k.rt.control(first.agentId, "Message b"), "earmarked");
    k.open(1);
    await k.called(2);
    assert.match(k.specs[1], /Message b/);
    k.rt.stop(first.agentId);
    await k.end;
    k.open(2);
    await quiet();
    counted.b = spawns; // stopped in the build after the message before the start — and yet spawned
    k.rt.close();
  }
  // (c) Restart by the human with a message delivered in the middle of the turn: the new attempt builds its spec anew (second
  // build), the stop comes in this build.
  {
    const children = [];
    const firstSpawn = signal();
    const k = coreWithGates({
      runChat: async ({ onSpawn }) => {
        const tot = signal();
        const kind = { killed: false, kill() { kind.killed = true; tot.on(); }, controlCbase: () => true };
        children.push(kind);
        onSpawn?.(kind);
        if (children.length === 1) firstSpawn.on();
        await tot.p;
        return { code: 143 };
      },
    });
    k.gateAt(2);
    const first = await k.rt.start({ prompt: "Task c", run_in_background: true });
    await firstSpawn.p;
    assert.equal(await k.rt.control(first.agentId, "Message c"), "delivered");
    assert.equal(k.rt.restart(first.agentId).ok, true);
    await k.called(2);
    assert.match(k.specs[1], /Message c/);
    k.rt.stop(first.agentId);
    await k.end;
    k.open(2);
    await quiet();
    counted.c = children.length - 1; // stopped in the build of the restart — and yet a second process
    k.rt.close();
  }
  // All three ways in ONE comparison: the counter-test shows each one individually.
  assert.deepEqual(counted, { a: 0, b: 0, c: 0 }, "spawns after the stop per way");
});

// Counter-test: both new `rec.lastInput = input` removed from drive ⇒ (a) and (b) red (the continuation gets only the task or
// the added message, the message before the start is missing).
test("a message before the start survives parking at the limit before the first answer — it is in the continuation", async () => {
  const LIMIT = { code: 1, stderr: "Claude usage limit reached · resets in 1s" };
  const atLimit = async (a, text) => (/usage limit/.test(text) ? { dueAt: Date.now(), resetsAt: Date.now() } : null);
  const withMessage = {};
  // (a) The message arrives during the first build (the loop over `beforeStart`).
  {
    let calls = 0;
    const k = coreWithGates({ atLimit, runChat: async () => (++calls === 1 ? LIMIT : { code: 0, resultText: "done a" }) });
    k.gateAt(1);
    const first = await k.rt.start({ prompt: "Task a", run_in_background: true });
    await k.called(1);
    assert.equal(await k.rt.control(first.agentId, "Message before start a"), "earmarked");
    k.open(1);
    const report = await k.end;
    assert.equal(report.status, "completed");
    assert.equal(calls, 2, "parked and continued once");
    const resumption = k.specs.at(-1);
    assert.ok(resumption.includes("Task a"), `continuation without the task:\n${resumption}`);
    withMessage.a = resumption.includes("Message before start a");
    k.rt.close();
  }
  // (b) The message is already in `beforeStart` when drive begins: an added turn, before whose gate query it arrives — the agent
  // has not reported a process yet (this provider does not call onSpawn).
  {
    let calls = 0;
    const firstRun = signal();
    const firstGo = signal();
    const gateAsked = signal();
    const gateGo = signal();
    let gates = 0;
    const k = coreWithGates({
      atLimit,
      startGate: () => (++gates === 2 ? (gateAsked.on(), gateGo.p.then(() => null)) : null),
      runChat: async () => {
        calls += 1;
        if (calls === 1) { firstRun.on(); await firstGo.p; return { code: 0, resultText: "first turn" }; }
        return calls === 2 ? LIMIT : { code: 0, resultText: "done b" };
      },
    });
    const first = await k.rt.start({ prompt: "Task b", run_in_background: true });
    await firstRun.p;
    const way = await k.rt.send({ agentId: first.agentId, message: "Added b" });
    assert.equal(way.afterEnd, true, "added, not delivered");
    firstGo.on();
    await gateAsked.p;
    assert.equal(await k.rt.control(first.agentId, "Message before start b"), "earmarked");
    gateGo.on();
    const report = await k.end;
    assert.equal(report.status, "completed");
    assert.equal(calls, 3, "first turn, added turn at the limit, continuation");
    assert.ok(k.specs[1].includes("Added b") && k.specs[1].includes("Message before start b"), `second build:\n${k.specs[1]}`);
    const resumption = k.specs.at(-1);
    assert.ok(resumption.includes("Added b"), `continuation without the added message:\n${resumption}`);
    withMessage.b = resumption.includes("Message before start b");
    k.rt.close();
  }
  assert.deepEqual(withMessage, { a: true, b: true }, "the message before the start is in the continuation — per way");
});

// ── Finding 7: `caps.subagents` is gone ────────────────────────────────────────────────────────────────────────────────────
// No run read the switch (every provider starts subagents via the core), web and iOS showed it as a capability and as a switch
// in the editor. The contract no longer knows it; a stored value and an older client that sends it stay valid (no 400) and are
// ignored. Counter-test: the old `providers/contract.js` and `web/…/ProviderSettings.tsx` ⇒ (a) and (c) red (`subagents` in
// the caps of every provider, the stored override comes through), (b) red (web names the key).
// There are no presets and no provider editor any more (`/api/presets`, `/api/provider-configs` are gone): (a) asks only the
// three providers, (c) a stored override in the row `providers.openrouter` — nobody reads it, the built-in OpenRouter has fixed
// capabilities (connectors/openrouter.js), and an older client no longer reaches the deleted routes.
const REPO = path.join(SERVER, "..", "..", "..", "..");
const WITHOUT_SUBAGENTS = [
  "web/src/components/settings/ProviderSettings.tsx",
  "mobile/CbaseMobile/Settings/ProviderSettings.swift",
  "mobile/CbaseMobile/Models/AccountModels.swift",
  "mobile/test-fixtures/chat-gateway/state.mjs",
  "mobile/test-fixtures/chat-gateway/routes-chat.mjs",
  "server/backend/electron/server/providers/index.js",
  "server/backend/electron/server/providers/connectors/openai-chat.js",
  "server/backend/electron/server/providers/connectors/openrouter.js",
];
test("`caps.subagents` is gone — contract, providers, web and iOS; a stored value is no error and is ignored", async () => {
  const { normalizeCaps } = await import("../electron/server/providers/contract.js");
  const { PROVIDERS } = await import("../electron/server/providers/index.js");
  // All findings in ONE comparison at the end: the counter-test shows each place individually.
  const findings = [];
  const check = (ok, what) => { if (!ok) findings.push(what); };
  // (a) The contract and every source of capabilities.
  const n = normalizeCaps({ subagents: true, vision: true });
  check(!("subagents" in n), "normalizeCaps passes `subagents` through");
  assert.equal(n.vision, true);
  for (const p of Object.values(PROVIDERS)) check(!("subagents" in (p.caps || {})), `provider ${p.id} reports subagents`);
  // (b) No client and no fixture names the key (identifier, not the term "subagents").
  for (const file of WITHOUT_SUBAGENTS) {
    check(!(/\bsubagents\b/.test(fs.readFileSync(path.join(REPO, file), "utf8"))), `${file} still names \`subagents\``);
  }
  // (c) At the server: the row `providers.openrouter` holds an old override with `caps.subagents` (as the editor used to
  // write it) — the start does not mind, and no capability the registry reports carries the field.
  await withAgentsServer(async ({ dataRoot }) => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataRoot, "data", "automater.db"));
    try {
      const n = db.prepare("UPDATE providers SET caps = ? WHERE id = 'openrouter'").run(JSON.stringify({ subagents: true, vision: false })).changes;
      assert.equal(n, 1, "the row providers.openrouter exists (PUT /api/openrouter of the harness)");
    } finally { db.close(); }
    // What `/api/providers` reports as `caps` is the registry (`PROVIDERS`, same process) — the route itself asks the CLI after
    // the login, which the fake cannot do.
    for (const p of Object.values(PROVIDERS)) check(!("subagents" in (p.caps || {})), `registry: ${p.id} reports subagents`);
  }, { engine: true });
  assert.deepEqual(findings, [], "`subagents` still lives");
});

// ── Finding 8: Codex outer loop without chosen built-ins — `request_user_input` ─────────────────────────────────────────────────
// On the wire (0.162.1 and 0.153.1) `request_user_input` stood at the front of the
// request, the frame (outerloop/input.js built-in line) did not name it. `-c tools.experimental_request_user_input.enabled=false`
// removes it from the whole request, also for a continuation — it is therefore in CODEX_WITHOUT_FILE_ACCESS. Description and
// execution give the same answer: what the frame does not name, the argv carries as switched off. A coding chat carries the
// switch too (CODEX_WITHOUT_OWN_TOOLS in EVERY Codex run, guard codex-own-tools.test.js) — exactly once.
// Counter-test: CODEX_WITHOUT_FILE_ACCESS without the pair ⇒ red (outer loop, continuation, oneshot, frame).
test("a Codex run without chosen built-ins switches off request_user_input — chat, continuation before resume, oneshot; the frame names nothing that is on the wire", async () => {
  const { buildCodexChatArgs, buildCodexOnceArgs } = await import("../electron/server/providers/connectors/codex.js");
  const { outerLoopFrame } = await import("../electron/server/outerloop/input.js");
  const TOGGLE = ["-c", "tools.experimental_request_user_input.enabled=false"];
  const place = (argv) => argv.findIndex((_, i) => TOGGLE.every((x, j) => argv[i + j] === x));
  const ol = buildCodexChatArgs({ cwd: "/tmp", permissionMode: "acceptEdits", codexWithoutFileAccess: true });
  const gone = buildCodexChatArgs({ cwd: "/tmp", permissionMode: "acceptEdits", codexWithoutFileAccess: true, sessionId: "thread-1" });
  const once = buildCodexOnceArgs({ prompt: "p", outFile: "/tmp/x.txt", withoutTools: true });
  const frame = outerLoopFrame({ name: "Observer", provider: "codex" }, { id: "c1", title: "Chat" },
    { cbase: [], extern: [], builtin: [], dropped: { approval: [], fence: [], genus: [] } });
  assert.match(frame, /Keine Befehle und kein Dateizugriff/, "the Codex line without choice");
  assert.deepEqual({
    outerLoop: place(ol) >= 0,
    resumptionBeforeResume: place(gone) >= 0 && place(gone) < gone.indexOf("resume"),
    oneshot: place(once) >= 0,
    frameMatches: frame.includes("request_user_input") || place(ol) >= 0,
  }, { outerLoop: true, resumptionBeforeResume: true, oneshot: true, frameMatches: true });
  // EVERY Codex run carries it, a coding chat too — and a run without file access not twice.
  const count = (argv) => argv.filter((a) => a === TOGGLE[1]).length;
  assert.ok(place(buildCodexChatArgs({ cwd: "/tmp", permissionMode: "default" })) >= 0, "a coding chat carries the switch");
  assert.deepEqual([count(ol), count(gone), count(once)], [1, 1, 1], "exactly once, also in the full cut");
});
