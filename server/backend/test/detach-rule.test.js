// The rule against detached shells (mcp/detach-rule.js).
//
// Proves: (1) the detection: every detaching form is refused; `&&`, `&>`, `2>&1`, a `&` inside quotes, a comment and
// `… & wait` are allowed; (2) the hook process (mcp/bash-guard.js) answers the CLI with `deny` and the text, and stays
// silent for allowed input, other tools and broken input; (3) EVERY Claude CLI chat run carries the hook (`--settings`
// from `buildClaudeChatArgs`) and the command in it is executable and refuses: the wire the real CLI calls
// (measured against the real CLI); (4) execution and description side agree: the same sentence is in the
// system prompt and the engine's Bash description, and no prompt sentence recommends nohup/run_in_background any more.
//
// COUNTER-TESTS: removing `if (before === ">" …) return false` in detach-rule.js turns "2>&1 allowed" red; removing the line
// `args.push("--settings", bashGuardSettings())` in connectors/claude.js turns (3) red; `permissionDecision: "deny"` →
// "allow" in bash-guard.js turns (2) red; removing `${DETACH_RULE}` in system-prompt.js turns (4) red.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DETACH_REFUSAL, DETACH_RULE, detachReason, withoutQuotes } from "../electron/mcp/detach-rule.js";
import { MONITOR_RULE } from "../electron/mcp/monitor-rule.js";
import { bashGuardSettings, buildClaudeChatArgs } from "../electron/server/providers/connectors/claude.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(HERE, "..", "electron", "mcp", "bash-guard.js");

const REJECTED = [
  [{ command: "npm test", run_in_background: true }, "run_in_background"],
  [{ command: "nohup npm run dev > dev.log 2>&1" }, "nohup"],
  [{ command: "/usr/bin/nohup ./server" }, "nohup"],
  [{ command: "setsid ./server" }, "setsid"],
  [{ command: "./server & disown" }, "disown"],
  [{ command: "npx vitest run > out.log 2>&1 &" }, "&"],
  [{ command: "npx vitest run &" }, "&"],
  [{ command: "(npm run dev &)" }, "&"],
  [{ command: "npm run dev & echo started" }, "&"],
  [{ command: "cd web && npm run dev &" }, "&"],
  [{ command: "screen -dmS dev npm run dev" }, "screen -d"],
  [{ command: "screen -d -m ./x" }, "screen -d"],
  [{ command: "tmux new -d -s dev 'npm run dev'" }, "tmux -d"],
  [{ command: "tmux new-session -ds dev ./x" }, "tmux -d"],
  [{ command: "daemonize /usr/bin/x" }, "daemonize"],
  [{ command: "echo los; nohup ./x &" }, "nohup"],
];
const ALLOWED = [
  { command: "npm test && npm run build" },
  { command: "npm test 2>&1 | tail -20" },
  { command: "make &> build.log" },
  { command: "make &>> build.log" },
  { command: "cmd >&2" },
  { command: "cmd |& tee x" },
  { command: "echo 'a & b'" },
  { command: 'echo "nohup is forbidden & so is disown"' },
  { command: "grep -c '&' file" },
  { command: "echo a\\&b" },
  { command: "ls # nohup & gone afterwards" },
  { command: "a & b & wait" },
  { command: "screen -ls" },
  { command: "tmux ls" },
  { command: "git log --oneline" },
  { command: "npm test", run_in_background: false },
  { command: "" },
  {},
  null,
];

test("(1) detection: every detaching form refused with the refusal text, no false hit on &&, &>, 2>&1, quotes, comment, wait", () => {
  for (const [input, form] of REJECTED) {
    const g = detachReason(input);
    assert.ok(g, `not refused: ${JSON.stringify(input)}`);
    assert.equal(g.form, form, JSON.stringify(input));
    assert.equal(g.text, DETACH_REFUSAL);
  }
  for (const input of ALLOWED) assert.equal(detachReason(input), null, `wrongly refused: ${JSON.stringify(input)}`);
  assert.equal(withoutQuotes(`a 'x & y' "b \\" &" c`), `a '_____' "______" c`);
  assert.match(DETACH_REFUSAL, /cbase_monitor/);
  assert.match(DETACH_REFUSAL, /report: "end"/);
});

const watch = (input, raw = null) => spawnSync(process.execPath, [WATCH], { input: raw ?? JSON.stringify(input), encoding: "utf8" });

test("(2) the hook process: deny with the refusal, otherwise silent, also for another tool and broken input", () => {
  const r = watch({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 9", run_in_background: true } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DETACH_REFUSAL } });
  for (const [input, raw] of [
    [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test 2>&1" } }],
    [{ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { command: "nohup x &" } }],
    [null, "not json"],
  ]) {
    const s = watch(input, raw);
    assert.equal(s.status, 0);
    assert.equal(s.stdout, "", `silence expected: ${JSON.stringify(input) ?? raw}`);
  }
});

test("(3) every Claude CLI chat run carries the hook and its command refuses", () => {
  const args = buildClaudeChatArgs({ systemPrompt: "x", mcpConfigPath: "/tmp/m.json", permissionMode: "bypassPermissions", settingSources: "user" });
  const i = args.indexOf("--settings");
  assert.ok(i > 0, "no --settings in the chat run");
  assert.equal(args[i + 1], bashGuardSettings());
  const s = JSON.parse(args[i + 1]);
  const [entry] = s.hooks.PreToolUse;
  assert.equal(entry.matcher, "Bash");
  const command = entry.hooks[0].command;
  assert.equal(entry.hooks[0].type, "command");
  // The CLI runs the command through the shell; so does the test.
  const r = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "setsid ./x" } }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.ok(fs.existsSync(WATCH));
});

test("(4) the same rule in prompt, monitor description and the engine's Bash, and no sentence recommends detaching any more", async () => {
  const source = fs.readFileSync(path.join(HERE, "..", "electron", "server", "runs", "system-prompt.js"), "utf8");
  assert.match(source, /\$\{DETACH_RULE\}/, "the system prompt carries the rule");
  assert.doesNotMatch(source, /\(nohup <start command>/, "no nohup recipe in the prompt any more");
  assert.doesNotMatch(source, /run_in_background` is still fine/);
  // The prohibition stands ONCE in the prompt, in DETACH_RULE, not in the monitor sentence as well (guard
  // prompt-audit.test.js (8)); the monitor sentence only says how to wait.
  assert.doesNotMatch(MONITOR_RULE, /run_in_background/);
  assert.match(DETACH_RULE, /run_in_background/);
  const { BUILTIN_TOOLS, BUILTIN_TOOL_DEFS } = await import("../electron/server/providers/tool-runtime.js").catch(() => ({}));
  const defs = BUILTIN_TOOL_DEFS || BUILTIN_TOOLS;
  const runtime = fs.readFileSync(path.join(HERE, "..", "electron", "server", "providers", "tool-runtime.js"), "utf8");
  assert.match(runtime, /description: `Executes a shell command in the working directory and returns the output\. \$\{DETACH_RULE\}`/);
  if (defs?.Bash) assert.ok(defs.Bash.description.includes(DETACH_RULE));
});
