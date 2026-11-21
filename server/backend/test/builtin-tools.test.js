// A run's tool set: spec.builtinTools trims the provider's BUILT-IN tools (Read/Bash/Task/…), MCP tools stay untouched.
// For Claude Code that is `--tools`; verified empirically: `--tools ""` removes every built-in tool while the tools
// from --mcp-config remain callable. The engine side lives in engine-harness.test.js.
import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeChatArgs } from "../electron/server/providers/connectors/claude.js";
import { BUILTIN_TOOLS } from "../electron/server/providers/contract.js";

const spec = (extra = {}) => ({
  cwd: "/tmp",
  input: "go",
  systemPrompt: "sys",
  addDirs: [],
  permissionMode: "bypassPermissions",
  mcpConfigPath: "/tmp/x.mcp.json",
  allowedTools: ["mcp__cbase"],
  permissionPromptTool: false,
  model: "",
  effort: "",
  sessionId: "",
  forkPending: false,
  ...extra,
});

test("--tools: only for a trimmed set, and the variadic trap stays shut", () => {
  // Normal case: no --tools → the CLI keeps its full built-in set.
  assert.equal(buildClaudeChatArgs(spec()).includes("--tools"), false);

  // Trimmed chat (empty list): empty value = no built-in tools.
  const none = buildClaudeChatArgs(spec({ builtinTools: [] }));
  const at = none.indexOf("--tools");
  assert.ok(at >= 0, "--tools missing");
  assert.equal(none[at + 1], "");
  // --tools is variadic: if anything other than an option followed, the CLI would swallow it.
  assert.match(none[at + 2], /^--/);

  // A real list goes out comma-separated (one argument, not several).
  const some = buildClaudeChatArgs(spec({ builtinTools: ["Read", "Grep"] }));
  assert.equal(some[some.indexOf("--tools") + 1], "Read,Grep");

  // MCP stays untouched: config and allow-list stand unchanged in the arguments.
  assert.ok(none.includes("--mcp-config") && none.includes("--strict-mcp-config"));
  assert.equal(none[none.indexOf("--allowedTools") + 1], "mcp__cbase");
});

// ToolSearch on the CLI path. The Claude CLI runs its own ToolSearch as a BUILT-IN tool — a trimmed set ("Read,Glob,Grep")
// silently cut it away, and the CLI put all MCP schemas into every request. Whether the turn carries enough tools is
// decided by runs/do-run.js (`toolSearchNeeded`); here we only check that the flag arrives.
test("--tools: ToolSearch is added when the turn carries many tools", () => {
  const including = buildClaudeChatArgs(spec({ builtinTools: ["Read", "Glob", "Grep"], toolSearch: true }));
  assert.equal(including[including.indexOf("--tools") + 1], "Read,Glob,Grep,ToolSearch");

  // Without the flag the line stays character-identical to the existing one — the snapshots depend on it.
  const without = buildClaudeChatArgs(spec({ builtinTools: ["Read", "Glob", "Grep"] }));
  assert.equal(without[without.indexOf("--tools") + 1], "Read,Glob,Grep");

  // Twice does not help: if it is already in the set, it stays once.
  const duplicate = buildClaudeChatArgs(spec({ builtinTools: ["Read", "ToolSearch"], toolSearch: true }));
  assert.equal(duplicate[duplicate.indexOf("--tools") + 1], "Read,ToolSearch");

  // Full set (builtinTools = null): no --tools, the CLI has its ToolSearch anyway.
  assert.equal(buildClaudeChatArgs(spec({ toolSearch: true })).includes("--tools"), false);
});

// ── Skills no longer come via the command line ──────────────────────────────
//
// Skills reach EVERY provider through the MCP tool `cbase_skill`; the command line carries nothing of them (no
// `--plugin-dir`). Two things that could easily have been swept away are pinned here: `--setting-sources` was never
// just the carrier of the injection but the ISOLATION against a `.claude/skills` in the working directory — it must
// stay set without a plugin directory. And the CLI's NATIVE skill tool must be explicitly disallowed, otherwise two
// tools doing the same thing would stand side by side.
test("skills: no --plugin-dir any more, isolation and disallowing stay", () => {
  const args = buildClaudeChatArgs(spec({ settingSources: "user", disallowedTools: ["Skill"] }));

  assert.equal(args.includes("--plugin-dir"), false, "the staged plugin directory is gone");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "user", "the isolation stands without a plugin directory too");

  const at = args.indexOf("--disallowedTools");
  assert.ok(at >= 0, "--disallowedTools missing");
  // Skill comes from the spec and stands FIRST; behind it the connector fixedly appends `Workflow` — Claude's native
  // orchestrator (native-orchestrator.test.js) — and behind that the CLI's wait tools (CLAUDE_WAIT_LOCK).
  assert.equal(args[at + 1], "Skill,Workflow,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");
  // --disallowedTools is variadic like --tools: an option MUST follow, otherwise it swallows it.
  assert.match(args[at + 2], /^--/);

  // Disallowing and trimming go together: a run carries both side by side.
  const beides = buildClaudeChatArgs(spec({ builtinTools: ["Read", "Glob", "Grep"], settingSources: "user", disallowedTools: ["Skill"] }));
  assert.equal(beides[beides.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(beides[beides.indexOf("--disallowedTools") + 1], "Skill,Workflow,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");

  // Counter-check: without the spec fields `--setting-sources` is absent (it comes from the spec, not from a default
  // in the connector). For `--disallowedTools` that is deliberately not so: the block on the native orchestrators sits
  // as a default IN the connector, because oneshots have no spec at all and every future run kind would otherwise run
  // without it. So without the spec field EXACTLY the default must stand — not Skill (the spec's business) and not nothing.
  const bare = buildClaudeChatArgs(spec());
  assert.equal(bare.includes("--setting-sources"), false);
  assert.equal(bare[bare.indexOf("--disallowedTools") + 1], "Workflow,Agent,Task,SendMessage,ListAgents,EnterWorktree,ExitWorktree,ReportFindings,ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor");
});

// Since CLI 2.1.267 the default freezes the additional prompt at the first turn; cbase rebuilds it every turn (agenda
// state, /goal, focus). `off` restores the 2.1.259 behaviour and stands in EVERY chat right behind the prompt — fixed,
// not from a spec property.
test("--system-prompt-snapshot off stands in every chat right behind --append-system-prompt", () => {
  for (const args of [buildClaudeChatArgs(spec()), buildClaudeChatArgs(spec({ builtinTools: [], sessionId: "s1" }))]) {
    const i = args.indexOf("--append-system-prompt");
    assert.ok(i >= 0);
    assert.equal(args[i + 2], "--system-prompt-snapshot");
    assert.equal(args[i + 3], "off");
  }
});

// `Skill` is no longer part of the built-in tool vocabulary: it is disallowed, so it cannot come back. If it stayed
// in the list, every reader would see a capability that does not exist.
test("Skill is in no built-in tool set any more", () => {
  assert.equal(BUILTIN_TOOLS.includes("Skill"), false);
  // The neighbours stay: the list was shortened, not rewritten.
  for (const t of ["Read", "Bash", "Task", "ExitPlanMode", "ToolSearch"]) assert.ok(BUILTIN_TOOLS.includes(t), t);
});
