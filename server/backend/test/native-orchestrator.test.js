// The leak of the native orchestrators is closed.
//
// Claude's `Workflow` tool used to be in every cbase Claude run, also in subagents and oneshots; Codex's own delegation
// (`spawn_agent`/`wait_agent`, proactive at Codex's highest thinking level) in every Codex run. Both bypass cbase: no consumption,
// no credit gate, no depth rule. The lock sits in the CONNECTORS, in both argument builders per provider (chat and oneshot), so
// every run kind is covered automatically. This file checks the builders; that every run kind really carries them is held by the
// golden runs (`fixtures/golden/*/spawn.json`).
//
// Measured, not assumed:
//   - Claude: `--disallowedTools ...,Workflow` removes the tool from init and request, stderr empty, also next to `--tools ""`.
//   - Codex: `--disable multi_agent` ALONE leaves all collaboration tools in place (the model catalog carries "v2" and takes
//     precedence over the feature); only `-c agents.enabled=false` switches it off, and `--disable multi_agent_v2` holds against
//     an enabled v2 feature.
//   - Claude's `SendMessage` and `ListAgents` are behind it too: `-p` offers both, the lock removes them from init and request.
//   - A oneshot carries `--permission-mode default` (without the flag `-p` starts in mode `auto` since 2.1.285 and collects git
//     context without our GIT_DIR), plus `ScheduleWakeup` in the lock and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (since 2.1.292 `-p`
//     WAITS for background bash and timers and returns the text of a follow-up turn instead of the answer). A chat run always
//     carries a mode, never an empty one.
//   - Behind the default, in EVERY run the CLI's wait tools (CLAUDE_WAIT_LOCK: ScheduleWakeup, CronCreate, CronDelete, CronList,
//     Monitor): the base rule names only cbase_monitor and cbase_wakeup; the lock removes them from init and request, TaskStop stays.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClaudeChatArgs, buildClaudeOnceArgs, runOnceClaude } from "../electron/server/providers/connectors/claude.js";
import { buildCodexChatArgs, buildCodexOnceArgs, runOnceCodex } from "../electron/server/providers/connectors/codex.js";
import { readJsonl } from "./jsonl.mjs";

// The expectations are written out VERBATIM, not via the exported constants: a test that reads the constant
// would stay green if someone emptied it, which is exactly the counter-test it must pass.
const CODEX_TOGGLE = ["--disable", "multi_agent", "--disable", "multi_agent_v2", "-c", "agents.enabled=false"];
// The lock of a oneshot: the five native orchestrators, then the wake-up timer and the monitor
// (ONESHOT_ENVIRONMENT does not switch it off, an armed monitor holds `-p` after the end).
const ONESHOT_LOCK_VERBATIM = "Workflow,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor";

const claudeSpec = (extra = {}) => ({
  cwd: "/tmp", input: "go", systemPrompt: "sys", addDirs: [], permissionMode: "bypassPermissions",
  mcpConfigPath: "/tmp/x.mcp.json", allowedTools: ["mcp__cbase"], permissionPromptTool: false,
  model: "", effort: "", sessionId: "", forkPending: false, ...extra,
});

const valueOf = (args, flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

// --disallowedTools is variadic: only an option or the end may follow its value, otherwise the CLI
// swallows the next word as another tool name.
function variadicSafe(args) {
  const i = args.indexOf("--disallowedTools");
  assert.ok(i >= 0, "--disallowedTools missing");
  assert.equal(args.indexOf("--disallowedTools", i + 1), -1, "the flag appears exactly once");
  const afterwards = args[i + 2];
  assert.ok(afterwards === undefined || /^--/.test(afterwards), `"${afterwards}" follows the lock list instead of an option`);
}

test("Claude chat: Workflow, Agent and Task are in EVERY lock list, after the entries of the specification", () => {
  // Agent/Task are locked in the main chat too: the only way to a subagent is cbase_agent (core).
  // Coding chat, pipeline, app agents: runs/do-run.js passes ["Skill"].
  const chat = buildClaudeChatArgs(claudeSpec({ disallowedTools: ["Skill"] }));
  assert.equal(valueOf(chat, "--disallowedTools"), "Skill,Workflow,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");
  variadicSafe(chat);

  // Subagent: ["Agent","Task","Skill"], appended so that the native subagent check (it reads
  // "Agent,Task" at the START of the list, native-agent-e2e.test.js) keeps holding.
  const sub = buildClaudeChatArgs(claudeSpec({ disallowedTools: ["Agent", "Task", "Skill"] }));
  assert.equal(valueOf(sub, "--disallowedTools"), "Agent,Task,Skill,Workflow,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");
  assert.match(valueOf(sub, "--disallowedTools"), /^Agent,Task/);
  variadicSafe(sub);

  // A run kind WITHOUT its own lock list (any future one): the default alone.
  const bare = buildClaudeChatArgs(claudeSpec());
  assert.equal(valueOf(bare, "--disallowedTools"), "Workflow,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");
  variadicSafe(bare);

  // Trimmed set and continuation: the same lock.
  const narrow = buildClaudeChatArgs(claudeSpec({ builtinTools: [], sessionId: "s1", disallowedTools: ["Skill"] }));
  assert.equal(valueOf(narrow, "--disallowedTools"), "Skill,Workflow,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");
  variadicSafe(narrow);

  // If a name is already in the specification, it does not appear twice.
  const duplicate = buildClaudeChatArgs(claudeSpec({ disallowedTools: ["Workflow", "Skill"] }));
  assert.equal(valueOf(duplicate, "--disallowedTools"), "Workflow,Skill,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");
});

// Since 2.1.285 the CLI's default without `--permission-mode` is `auto`. A chat run passes its mode on as it is; if it is missing
// (empty specification) it is `default`, never an empty flag and never the CLI's default.
test("Claude chat: the mode of the specification goes out unchanged, a missing one becomes default", () => {
  for (const mode of ["bypassPermissions", "acceptEdits", "plan", "default"]) {
    const args = buildClaudeChatArgs(claudeSpec({ permissionMode: mode }));
    assert.equal(valueOf(args, "--permission-mode"), mode);
    assert.equal(args.filter((a) => a === "--permission-mode").length, 1);
  }
  for (const empty of ["", undefined, null]) {
    const args = buildClaudeChatArgs(claudeSpec({ permissionMode: empty }));
    assert.equal(valueOf(args, "--permission-mode"), "default", `permissionMode ${JSON.stringify(empty)}`);
  }
});

test("Claude oneshot: every form carries the lock, and nothing follows it (the prompt goes over stdin)", () => {
  for (const form of [
    {},
    { model: "claude-sonnet-5" },
    { material: true },
    { withoutTools: true },
    { material: true, model: "claude-opus-5", withoutTools: true },
  ]) {
    const args = buildClaudeOnceArgs(form);
    assert.equal(valueOf(args, "--disallowedTools"), ONESHOT_LOCK_VERBATIM, JSON.stringify(form));
    variadicSafe(args);
    // No positional argument anywhere: every word is an option or the value of an option.
    assert.equal(args[0], "-p");
    // The mode is stated explicitly, exactly once and before the variadic lock.
    assert.equal(valueOf(args, "--permission-mode"), "default", JSON.stringify(form));
    assert.equal(args.filter((a) => a === "--permission-mode").length, 1, JSON.stringify(form));
    assert.ok(args.indexOf("--permission-mode") < args.indexOf("--disallowedTools"), JSON.stringify(form));
  }
  // The existing flags are still there: the lock is added, it replaces nothing.
  const without = buildClaudeOnceArgs({ withoutTools: true });
  assert.equal(valueOf(without, "--tools"), "");
  assert.ok(without.includes("--strict-mcp-config"));
});

test("Codex chat: the three switches are in every run, BEFORE the resume subcommand", () => {
  const fresh = buildCodexChatArgs({ cwd: "/tmp/x", model: "gpt-5.6-sol", effort: "high", permissionMode: "bypassPermissions" });
  const i = fresh.indexOf("--disable");
  assert.ok(i > 0, "no --disable");
  assert.deepEqual(fresh.slice(i, i + CODEX_TOGGLE.length), CODEX_TOGGLE);
  assert.equal(fresh.includes("resume"), false);

  const further = buildCodexChatArgs({ cwd: "/tmp/x", model: "gpt-6-astra", sessionId: "thread-1", permissionMode: "acceptEdits" });
  const j = further.indexOf("--disable");
  assert.deepEqual(further.slice(j, j + CODEX_TOGGLE.length), CODEX_TOGGLE);
  const r = further.indexOf("resume");
  assert.ok(r > j + CODEX_TOGGLE.length - 1, "the switches belong before the subcommand");
  assert.equal(further[r + 1], "thread-1");
  // After `resume <thread>` no switch follows: the form measured in the container (switches before the
  // subcommand, continuing a v2 thread => `disabled`), and the one every exec flag has here.
  assert.equal(further.slice(r).some((a) => a === "--disable" || a === "agents.enabled=false"), false);

  // Fork without resume (fresh thread): the same switches.
  const fork = buildCodexChatArgs({ cwd: "/tmp/x", sessionId: "thread-1", forkPending: true, permissionMode: "plan" });
  const k = fork.indexOf("--disable");
  assert.deepEqual(fork.slice(k, k + CODEX_TOGGLE.length), CODEX_TOGGLE);
});

test("Codex oneshot: the exported builder carries the switches, the prompt stays the last word", () => {
  const args = buildCodexOnceArgs({ prompt: "Title please", outFile: "/tmp/o.txt", model: "gpt-5.6-sol", cwd: "/tmp/x" });
  assert.equal(args[0], "exec");
  const i = args.indexOf("--disable");
  assert.deepEqual(args.slice(i, i + CODEX_TOGGLE.length), CODEX_TOGGLE);
  assert.equal(args.at(-1), "Title please");
  assert.equal(valueOf(args, "-o"), "/tmp/o.txt");
  assert.equal(valueOf(args, "-m"), "gpt-5.6-sol");
  assert.equal(valueOf(args, "-s"), "read-only");
  // Without model and cwd: the switches stay, nothing invented is added.
  const tight = buildCodexOnceArgs({ prompt: "p", outFile: "/tmp/o.txt" });
  const j = tight.indexOf("--disable");
  assert.deepEqual(tight.slice(j, j + CODEX_TOGGLE.length), CODEX_TOGGLE);
  assert.equal(tight.includes("-m"), false);
  assert.equal(tight.includes("-C"), false);
});

// The spawn uses the builder: a fake CLI records its argv, the real runOnce paths start it.
test("runOnceClaude and runOnceCodex start with exactly these arguments", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-orchestrator-"));
  const log = path.join(dir, "argv.jsonl");
  const claudeFake = path.join(dir, "claude");
  const codexFake = path.join(dir, "codex");
  fs.writeFileSync(claudeFake, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "claude", argv: process.argv.slice(2), backgroundFrom: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null }) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })); });
`, { mode: 0o755 });
  fs.writeFileSync(codexFake, `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "codex", argv }) + "\\n");
const o = argv.indexOf("-o");
if (o >= 0) fs.writeFileSync(argv[o + 1], "ok");
`, { mode: 0o755 });
  const saved = { claude: process.env.CLAUDE_BIN, codex: process.env.CODEX_BIN };
  process.env.CLAUDE_BIN = claudeFake;
  process.env.CODEX_BIN = codexFake;
  t.after(() => {
    if (saved.claude === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = saved.claude;
    if (saved.codex === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved.codex;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn(`[test] cleanup: ${e.message}`); }
  });

  assert.equal(await runOnceClaude("Say ok.", { cwd: dir, withoutTools: true }), "ok");
  assert.equal(await runOnceCodex("Say ok.", { cwd: dir, model: "gpt-5.6-sol" }), "ok");

  const rows = readJsonl(log); // Only completed lines (jsonl.mjs): the fake CLI writes while the test reads.
  const claudeRow = rows.find((z) => z.bin === "claude");
  const claude = claudeRow.argv;
  const codex = rows.find((z) => z.bin === "codex").argv;
  assert.deepEqual(claude, buildClaudeOnceArgs({ withoutTools: true }));
  assert.equal(valueOf(claude, "--disallowedTools"), ONESHOT_LOCK_VERBATIM);
  assert.equal(valueOf(claude, "--permission-mode"), "default");
  // No background command in a oneshot: the child's environment carries the switch.
  assert.equal(claudeRow.backgroundFrom, "1", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS missing in the environment of the oneshot");
  assert.equal(codex.at(-1), "Say ok.");
  const i = codex.indexOf("--disable");
  assert.deepEqual(codex.slice(i, i + CODEX_TOGGLE.length), CODEX_TOGGLE);
});

// A Claude oneshot runs in B with `cwd` = project folder, and for a converted project the project container writes to it. Without
// `--setting-sources` the CLI loads the settings of the working folder and runs their hooks, in B, outside fence and network
// separation. The fake CLI here behaves like the real one: without the flag (or with "project" in it) it reads
// `<cwd>/.claude/settings.json` and runs the SessionStart hook. Without `--setting-sources user` the hook writes its marker.
test("A Claude oneshot runs no hook from the project settings of the working folder (--setting-sources user)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-oneshot-hook-"));
  const project = path.join(dir, "project");
  const marker = path.join(dir, "hook-ran-in-B");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${JSON.stringify(marker)}` }] }] },
  }));
  const claudeFake = path.join(dir, "claude");
  fs.writeFileSync(claudeFake, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const argv = process.argv.slice(2);
const i = argv.indexOf("--setting-sources");
const sources = i < 0 ? ["user", "project", "local"] : String(argv[i + 1]).split(",");
if (sources.includes("project")) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".claude", "settings.json"), "utf8"));
    for (const g of cfg.hooks?.SessionStart || []) for (const h of g.hooks || []) if (h.type === "command") execSync(h.command);
  } catch { /* no project settings */ }
}
process.stdin.resume();
process.stdin.on("end", () => { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Title" })); });
`, { mode: 0o755 });
  const saved = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = claudeFake;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = saved;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn(`[test] cleanup: ${e.message}`); }
  });

  // Both forms: the text path (title, verdict) and the material path (images), with and without tools.
  assert.equal(await runOnceClaude("Give a title.", { cwd: project }), "Title");
  assert.equal(await runOnceClaude("Give a title.", { cwd: project, withoutTools: true }), "Title");
  assert.equal(fs.existsSync(marker), false, "the project SessionStart hook ran in the oneshot");
  for (const form of [{}, { material: true }, { withoutTools: true }, { material: true, withoutTools: true, model: "claude-opus-5" }]) {
    const args = buildClaudeOnceArgs(form);
    assert.equal(valueOf(args, "--setting-sources"), "user", JSON.stringify(form));
    variadicSafe(args);
  }
});
