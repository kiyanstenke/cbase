#!/usr/bin/env node
// The PreToolUse hook of the Claude CLI against detached shell commands (rule and text: mcp/detach-rule.js).
// Hooked in via `--settings` into every chat run of the CLI (providers/connectors/claude.js `bashGuardSettings`, matcher "Bash") —
// main agent, subagent, workflow agent alike. Reads the hook input from stdin (`{ hook_event_name, tool_name, tool_input }`) and
// answers with `permissionDecision: "deny"` plus the reason: the CLI hands the reason to the model as a tool result, the turn goes
// on (measured on 2.1.296). Allowed ⇒ no output, exit 0. A broken input does NOT refuse (exit 0): the guard must not block an
// ordinary command just because it stumbles itself.
//
// Runs in the CLI's process — in a project container there, with the same path as the MCP server (mcp/cbase-mcp.js).
//
// `--cpu-wait` ("CPU saver"): only on the run of a BACKGROUND agent with the switch on (connectors/claude.js
// `bashGuardSettings({ cpuWait: true })`). Then an allowed command waits before starting as long as the CPU is overloaded, at most
// 120 s (rule mcp/cpu-saver.js), and reports the wait with the marker on stderr — the CLI passes it into the stream as
// `system/hook_progress` (measured on 2.1.296). Afterwards exit 0 without output: the command starts. A refused command never waits.
// Without the argument the hook is exactly the plain one.
import { detachReason } from "./detach-rule.js";
import { endText, waitForCpu, waitText } from "./cpu-saver.js";

const CPU_WAIT = process.argv.includes("--cpu-wait");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let e = null;
  try { e = JSON.parse(raw); } catch { process.exit(0); }
  if (!e || e.tool_name !== "Bash") process.exit(0);
  const reason = detachReason(e.tool_input);
  if (!reason) {
    if (!CPU_WAIT) process.exit(0);
    waitForCpu({ atBegin: (state) => process.stderr.write(waitText(state) + "\n") })
      .then((r) => { if (r.waitedMs) process.stderr.write(endText(r) + "\n"); })
      .catch(() => {})
      .finally(() => process.exit(0));
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.text },
  }) + "\n");
  process.exit(0);
});
