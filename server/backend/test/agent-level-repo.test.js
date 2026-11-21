// effort and repo per subagent. Two independent halves of `cbase_agent`:
//   1. `effort`: the main agent sets a level of the scale per subagent (never "ultracode"). It is clamped to the model of the
//      SUBAGENT by the one substitute rule (downwards). Without it the subagent inherits the level of its caller — the chat or
//      the calling agent. Measured on the wire of all three paths: `--effort` of the fake Claude, `model_reasoning_effort` of
//      the fake Codex, `reasoning_effort` in the request to the fake OpenRouter endpoint of the engine (OpenRouter carries all
//      five; the clamp on a model entry with `efforts` is held by preset-wire.test.js).
//   2. `isolation: 'worktree'` in a project chat whose working folder is (on purpose) the workspace: the one repo of the focus
//      project is branched off; with several the call throws with the list, `repo` chooses.
//
// The test repos are temp repos with git configuration from the ENVIRONMENT (`GIT_CONFIG_COUNT`, with GLOBAL/NOSYSTEM switched
// off) — `GIT_CONFIG_GLOBAL=/dev/null` alone does not cover `core.excludesFile`/`core.attributesFile`. The server runs in the
// test process and inherits them, as do its git calls.
//
// Counter-tests: the hand-over of `rec.effort` to buildSpec removed => the level test red (low arrives as high);
// `repoCandidates` ignored in the core => the worktree test red with a repository error. Third test: a repo without a
// checked-in file is no candidate (see its header).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { GAP, withGapsModel } from "./gaps-model.mjs";

const LEVELS = "low, medium, high, xhigh, max";

// The main agent: starts the calls from the message (after "CALLS:") one after the other in the foreground and stores each
// result under its `tag` in the throwaway folder — an error result with "FEHLER " in front.
const MAIN = `
  // All text blocks of the input: a project chat may put a block in front of the message.
  const everything = ((msg.message && msg.message.content) || []).map((c) => (c && c.text) || "").join("\\n");
  const calls = JSON.parse(everything.slice(everything.indexOf("CALLS:") + 6).split("\\n")[0]);
  for (let i = 0; i < calls.length; i++) {
    const { tag, ...rest } = calls[i];
    const id = "toolu_" + tag;
    const input = { run_in_background: false, description: "Part " + tag, ...rest };
    say({ type: "assistant", message: { id: "m_" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input }] } });
    const r = await mcpCall("cbase_agent", input);
    const t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    fs.writeFileSync(path.join(LOCATION, "result-" + tag + ".txt"), t);
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// The subagent: reports its level (--effort) and its directory; "GRANDCHILD:" in the task starts a grandchild WITHOUT effort (it
// inherits that of the calling agent), "CHANGE" writes a file into its directory.
const SUB = `
  if (text.includes("GRANDCHILD:")) {
    say({ type: "assistant", message: { id: "sub-grandchild", content: [{ type: "tool_use", id: "toolu_grandchild", name: "mcp__cbase__cbase_agent", input: {} }] } });
    const r = await mcpCall("cbase_agent", { description: "Grandchild", prompt: "Leaf without level", run_in_background: false });
    fs.writeFileSync(path.join(LOCATION, "result-grandchild.txt"), (r.result && r.result.isError ? "FEHLER " : "") + textOf(r));
  }
  if (text.includes("CHANGE")) fs.writeFileSync(path.join(process.cwd(), "fresh.txt"), "from the subagent\\n");
  finished();
  say({ type: "result", result: "effort=" + (arg("--effort") || "-") + " cwd=" + process.cwd(), session_id: "sub-session" });`;

// A fake Codex that reports its level from `-c model_reasoning_effort=…` (the harness version reports a fixed text).
const CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const c = argv.filter((a, i) => argv[i - 1] === "-c" && a.startsWith("model_reasoning_effort="));
const eff = c.length ? JSON.parse(c[0].slice("model_reasoning_effort=".length)) : "-";
say({ type: "thread.started", thread_id: "codex-thread" });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "effort=" + eff } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

const readResult = (root, tag) => fs.readFileSync(path.join(root, `result-${tag}.txt`), "utf8");
const report = (root, tag) => {
  const t = readResult(root, tag);
  assert.doesNotMatch(t, /^FEHLER /, `${tag}: ${t}`);
  return JSON.parse(t);
};
const metaCount = (log) => log.filter((m) => m.role === "meta").length;
async function round(ctx, chatId, calls) {
  const prior = metaCount(await json(`${ctx.base}/api/chats/${chatId}/log`));
  await json(`${ctx.base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text: `CALLS:${JSON.stringify(calls)}` }) });
  await ctx.waitForLog(chatId, (l) => metaCount(l) > prior);
  await ctx.waitForIdle();
}

test("effort per subagent: on the wire of Claude, Codex and engine — set, inherited, clamped downwards, unknown rejected", async () => {
  // The Codex model without max is a test model (gpt-5.5 is out of the catalog) — gaps-model.mjs.
  await withGapsModel(() => withAgentsServer(async (ctx) => {
    const { base, chat, root, engine } = ctx;
    // A chat with level high on a model with all five levels.
    const p = await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-sonnet-5", effort: "high" }) });
    assert.equal(p.effort, "high", JSON.stringify(p));
    const SONNET = "claude::claude-sonnet-5";
    await round(ctx, chat.id, [
      { tag: "claude-low", model: SONNET, effort: "low", prompt: "Claude cheap" },
      { tag: "claude-without", model: SONNET, prompt: "Claude inherits" },
      { tag: "codex-low", model: "codex::gpt-5.6-sol", effort: "low", prompt: "Codex cheap" },
      // The test model carries no max: the downward substitute is xhigh (substitute rule), never a level above.
      { tag: "codex-max", model: `codex::${GAP}`, effort: "max", prompt: "Codex thorough" },
      { tag: "codex-without", model: "codex::gpt-5.6-sol", prompt: "Codex inherits" },
      { tag: "engine-low", model: engine.model, effort: "low", prompt: "ENGINE-LOW" },
      // OpenRouter carries all five levels (it maps to the model's step itself): max goes out as max.
      { tag: "engine-max", model: engine.model, effort: "max", prompt: "ENGINE-MAX" },
      { tag: "engine-without", model: engine.model, prompt: "ENGINE-WITHOUT" },
      // A grandchild without a level inherits the level of the CALLING agent (low), not that of the chat (high).
      { tag: "parent-low", model: SONNET, effort: "low", prompt: "GRANDCHILD: start one" },
      { tag: "ultra", model: SONNET, effort: "ultra", prompt: "wrong" },
      { tag: "ultracode", model: SONNET, effort: "ultracode", prompt: "wrong" },
      { tag: "text", model: SONNET, effort: "very thorough", prompt: "wrong" },
    ]);

    const effortOf = (tag) => /effort=(\S+)/.exec(report(root, tag).report)?.[1];
    assert.equal(effortOf("claude-low"), "low", "Claude: --effort low");
    assert.equal(effortOf("claude-without"), "high", "Claude without level: that of the chat");
    assert.equal(effortOf("codex-low"), "low", "Codex: model_reasoning_effort low");
    assert.equal(effortOf("codex-max"), "xhigh", "Codex max on the model without max: downward substitute");
    assert.equal(effortOf("codex-without"), "high", "Codex without level: that of the chat");
    const engineLevel = (marker) => {
      const a = engine.requests.filter((b) => b.stream !== false && JSON.stringify(b.messages || []).includes(marker));
      assert.ok(a.length, `no request for ${marker}`);
      return a.map((b) => b.reasoning_effort);
    };
    for (const tag of ["engine-low", "engine-max", "engine-without"]) assert.equal(report(root, tag).status, "completed", tag);
    assert.deepEqual([...new Set(engineLevel("ENGINE-LOW"))], ["low"], "Engine: reasoning_effort low");
    assert.deepEqual([...new Set(engineLevel("ENGINE-MAX"))], ["max"], "engine max on OpenRouter: max");
    assert.deepEqual([...new Set(engineLevel("ENGINE-WITHOUT"))], ["high"], "engine without level: that of the chat");
    assert.equal(effortOf("parent-low"), "low");
    const grandchild = JSON.parse(fs.readFileSync(path.join(root, "result-grandchild.txt"), "utf8"));
    assert.equal(/effort=(\S+)/.exec(grandchild.report)?.[1], "low", `the grandchild inherits the level of its parent agent: ${grandchild.report}`);
    for (const tag of ["ultra", "ultracode", "text"]) {
      const t = readResult(root, tag);
      assert.match(t, /^FEHLER /, `${tag}: no error — ${t}`);
      assert.ok(t.includes(LEVELS), `${tag}: the list of allowed levels is missing — ${t}`);
    }
    console.log(`  [level] Claude low/inherits ${effortOf("claude-low")}/${effortOf("claude-without")}, Codex low/max/inherits ${effortOf("codex-low")}/${effortOf("codex-max")}/${effortOf("codex-without")}, engine low/max/inherits ${engineLevel("ENGINE-LOW")[0]}/${engineLevel("ENGINE-MAX")[0]}/${engineLevel("ENGINE-WITHOUT")[0]}, grandchild ${/effort=(\S+)/.exec(grandchild.report)?.[1]}`);
  }, { claude: fakeClaude({ main: MAIN, sub: SUB }), codex: CODEX, engine: true }));
});

// Git without personal configuration: everything the repos need comes from the environment.
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
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "start"], dir);
}
const branches = (repo) => git(["branch", "--list", "--format=%(refname:short)"], repo).split("\n").filter(Boolean);
const worktrees = (repo) => git(["worktree", "list", "--porcelain"], repo).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => fs.realpathSync(l.slice(9)));

test("isolation:'worktree' in the project chat: the one repo of the focus project, the list with several, repo chooses; changed stays, unchanged disappears", async () => {
  await withGitEnvironment(() => withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    // The project lies IN the workspace, its folder is no repo; inside exactly one repo (app/). Create it empty first — a full
    // folder would trigger the services scan.
    const projPath = path.join(root, "workspace", "till");
    const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: projPath }) });
    const app = path.join(projPath, "app");
    createRepo(app);
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
      workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
    }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Project worktree" }) });
    assert.equal(chat.projectId, project.id, "the chat is focused on the project");

    await round(ctx, chat.id, [
      { tag: "wt-changed", isolation: "worktree", prompt: "CHANGE please" },
      { tag: "wt-unchanged", isolation: "worktree", prompt: "read only" },
      { tag: "repo-without-isolation", repo: "app", prompt: "wrong" },
    ]);
    const a = report(root, "wt-changed");
    const cwdA = /cwd=(\S+)/.exec(a.report)?.[1];
    assert.ok(a.worktree, `the changed worktree is in the report: ${JSON.stringify(a)}`);
    assert.match(a.notes, /Worktree with changes is left standing/, a.notes);
    assert.equal(fs.realpathSync(cwdA), fs.realpathSync(a.worktree), "the subagent worked in the worktree");
    assert.equal(fs.realpathSync(git(["rev-parse", "--git-common-dir"], a.worktree)), fs.realpathSync(path.join(app, ".git")), "the worktree belongs to the repo of the project");
    assert.ok(worktrees(app).includes(fs.realpathSync(a.worktree)), "the project repo lists it");
    assert.ok(branches(app).includes(`cbase/agent-${a.agentId}`), "its branch stays");
    const b = report(root, "wt-unchanged");
    const cwdB = /cwd=(\S+)/.exec(b.report)?.[1];
    assert.equal(b.worktree, "", "the unchanged one is not in the report");
    assert.match(cwdB, /agent-/, "it also ran in a worktree");
    assert.equal(fs.existsSync(cwdB), false, "the unchanged worktree is gone");
    assert.equal(branches(app).includes(`cbase/agent-${b.agentId}`), false, "along with its branch");
    assert.match(readResult(root, "repo-without-isolation"), /^FEHLER .*repo only takes effect with isolation/);

    // A second repo in the project: ambiguous without repo; with repo exactly this one; an unknown one throws with the list.
    const lib = path.join(projPath, "lib");
    createRepo(lib);
    await round(ctx, chat.id, [
      { tag: "two-without", isolation: "worktree", prompt: "which one?" },
      { tag: "two-lib", isolation: "worktree", repo: "lib", prompt: "CHANGE in lib" },
      { tag: "two-unknown", isolation: "worktree", repo: "xyz", prompt: "wrong" },
    ]);
    for (const tag of ["two-without", "two-unknown"]) {
      const t = readResult(root, tag);
      assert.match(t, /^FEHLER /, `${tag}: ${t}`);
      assert.ok(t.includes(`"app" (${fs.realpathSync(app)})`) || t.includes(`"app" (${app})`), `${tag}: app is missing in the list — ${t}`);
      assert.ok(t.includes('"lib"'), `${tag}: lib is missing in the list — ${t}`);
    }
    assert.match(readResult(root, "two-without"), /is ambiguous here/);
    assert.match(readResult(root, "two-unknown"), /Unknown repo "xyz"/);
    const l = report(root, "two-lib");
    assert.ok(worktrees(lib).includes(fs.realpathSync(l.worktree)), `with repo "lib" lib is branched off: ${JSON.stringify(l)}`);
    assert.equal(worktrees(app).includes(fs.realpathSync(l.worktree)), false, "… and not app");
    console.log(`  [repo] one: ${path.basename(a.worktree)} in app (stays), unchanged gone; two: list app+lib, repo lib → ${path.basename(l.worktree)}`);
  }, { claude: fakeClaude({ main: MAIN, sub: SUB }) }));
});

// A repo without a checked-in file — the init of a project setup creates only an EMPTY commit — is no candidate for
// isolation:"worktree" (providers/agent-runtime.js selectRepo, `emptyTree`): its worktree would be an empty folder without
// the untracked files of the main folder. Counter-test: the cut `emptyTree` in the loop of selectRepo removed => the test red
// at "with-empty" ("not unambiguous — state with repo").
function createEmptyRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  fs.writeFileSync(path.join(dir, "untracked.txt"), "only in the main folder\n");
  git(["commit", "-q", "--allow-empty", "-m", "empty"], dir);
}

test("isolation:'worktree' skips a repo without a checked-in file: next to a full one the full one, repo on the empty one and only-empty throw with a sentence", async () => {
  await withGitEnvironment(() => withAgentsServer(async (ctx) => {
    const { base, ws, root } = ctx;
    // Create the project empty first (a full folder would trigger the services scan), then the repos.
    const projectChat = async (name, filePath) => {
      const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
      const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
        workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
      }) });
      await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: name }) });
      return c;
    };
    const p1 = path.join(root, "workspace", "withempty");
    const c1 = await projectChat("With empty", p1);
    const app = path.join(p1, "app");
    const empty = path.join(p1, "empty");
    createRepo(app);
    createEmptyRepo(empty);
    await round(ctx, c1.id, [
      { tag: "with-empty", isolation: "worktree", prompt: "CHANGE please" },
      { tag: "repo-empty", isolation: "worktree", repo: "empty", prompt: "wrong" },
    ]);
    const a = report(root, "with-empty");
    assert.ok(a.worktree, `without repo the one full repo is chosen: ${JSON.stringify(a)}`);
    assert.equal(fs.realpathSync(git(["rev-parse", "--git-common-dir"], a.worktree)), fs.realpathSync(path.join(app, ".git")), "the worktree belongs to app");
    assert.deepEqual(worktrees(empty), [fs.realpathSync(empty)], "the empty repo got none");
    const r = readResult(root, "repo-empty");
    assert.match(r, /^FEHLER .*The repo "empty" has no checked-in file yet/, r);

    const p2 = path.join(root, "workspace", "only-empty");
    const c2 = await projectChat("Only empty", p2);
    const empty2 = path.join(p2, "empty2");
    createEmptyRepo(empty2);
    await round(ctx, c2.id, [{ tag: "only-empty", isolation: "worktree", prompt: "wrong" }]);
    const n = readResult(root, "only-empty");
    assert.match(n, /^FEHLER .*no repo has a checked-in file/, n);
    assert.ok(n.includes('"empty2"'), `the sentence names the empty repo: ${n}`);
    assert.deepEqual(worktrees(empty2), [fs.realpathSync(empty2)]);
    console.log(`  [empty] app chosen (${path.basename(a.worktree)}), repo empty and only-empty throw`);
  }, { claude: fakeClaude({ main: MAIN, sub: SUB }) }));
});
