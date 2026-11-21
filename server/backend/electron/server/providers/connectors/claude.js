// Provider "claude" — the native Claude Code CLI primitives (headless, on the host).
// Auth via the keychain login (`claude auth login`); a CLAUDE_CODE_OAUTH_TOKEN / API key that may be set is
// deliberately NOT passed through.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { materialMessage } from "../contract.js";
// Every write to a child's stdin goes through this helper — it registers the error handler BEFORE writing (a dead
// process otherwise throws EPIPE as an unhandled exception and takes the server process down).
import { closeStdin, writeStdin } from "../kind-stdin.js";
import { anthropicConsumption, reportConsumption } from "./consumption.js";
// The ONE start function: without an instance exactly `spawn`, with an instance in the project container (runtime/inProject.js).
import { inProject } from "../../runtime/inProject.js";
// The LFS environment of an agent start (runs/lfs-environment.js, a leaf) — without an instance the same opts.
import { withLfsEnvironment } from "../../runs/lfs-environment.js";
// The order of the effort levels and the one clamp computation: workflows.js, a leaf without imports of its own (see
// EFFORT_LEVELS there).
import { EFFORT_LEVELS, effortFallback } from "../../workflows.js";
// CPU saver: nice in front of the CLI and the deadline of the wait hook — a leaf (mcp/cpu-saver.js).
import { HOOK_DEADLINE_S, withNice } from "../../../mcp/cpu-saver.js";

export const claudeBin = () => process.env.CLAUDE_BIN || "claude";

// The bash guard (rule: mcp/detach-rule.js): a PreToolUse hook on "Bash" that rejects `run_in_background` and every
// detaching (nohup, setsid, disown, `&`, screen/tmux -d) at the call — detached shells die with the turn in cbase, and
// nobody reports their end. Via `--settings` (flag settings also apply under `--setting-sources user`) in EVERY chat
// run: main agent, subagent, workflow agent. Measured at 2.1.296 with `--setting-sources user` and
// `bypassPermissions`: the rejection reaches the model as a tool result (is_error), the next call runs, the turn ends
// regularly. The hook runs in the CLI's process — in a project container there, with the same program and path as the
// MCP server (toolchain/mcp-config.js: `process.execPath` + script under mcp/).
const BASH_GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mcp", "bash-guard.js");
// CPU saver: `cpuWait` — ONLY on the run of a background agent with the toggle switched on — appends `--cpu-wait` to
// the hook and sets its deadline explicitly to HOOK_DEADLINE_S (above the cap of the waiting; measured at 2.1.296: the
// CLI honors `timeout`, an expired hook still lets the command run). Without `cpuWait` the line is byte-identical to
// the plain one (guard cpu-saver.test.js).
export function bashGuardSettings({ cpuWait = false } = {}) {
  const hook = cpuWait
    ? { type: "command", command: `"${process.execPath}" "${BASH_GUARD}" --cpu-wait`, timeout: HOOK_DEADLINE_S }
    : { type: "command", command: `"${process.execPath}" "${BASH_GUARD}"` };
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } });
}

// Claude models. Context window = ONE source (this /api/providers field) for the frontend.
//
// The catalog lives HERE and not in the provider index — like the Codex catalog with its level lists lives in the Codex
// connector and `providers/index.js` only imports both. The reason is the clamp: the index imports this connector, a
// way back would be an import cycle, and only here the connector can clamp per model (`claudeEfforts`).
// The catalog exists in THREE places (here, `web/src/components/chat/ChatCatalog.tsx` including the `/model` aliases,
// iOS `Chat/ChatViewModel+Slash.swift`); `web/test/composer-contract.test.mjs` binds the web fallback to this
// declaration.
export const CLAUDE_MODELS = [
  // Fable 5.1 needs Claude Code ≥ 2.1.251; an older CLI answers 400 "does not support this model". The version is
  // pinned in server/backend/Dockerfile.
  //
  // `efforts` per model: the levels the model SUPPORTS — measured at the pinned CLI: model table in the binary
  // (`effort` ⇒ low/medium/high, `xhigh_effort`, `max_effort`) and the wire (`output_config.effort` as chosen).
  // Haiku 4.5 supports NO levels (`capabilities: ["context_management"]`, catalog `thinking:{type:"none"}`; never an
  // `output_config` on the wire, every `--effort` fizzles out silently). An EMPTY list means "no levels" (no flag), a
  // MISSING one "unknown" (pass through) — `effortFallback` in workflows.js.
  //
  // `catalogLevel`: the level the CLI runs without `--effort` — the option marked "Default" in the CLI's account
  // catalog (`~/.claude/cache/model-catalog/*-cc.json`, `thinking.effort_options`; the catalog embedded in the binary
  // says the same `default_effort`). It presets the provider's default level (`effortStandard` in providers/index.js).
  // Haiku 4.5: none.
  // Fable 5.2: in the binary since the pin 2.1.322 (the alias `fable` points to 5.2 there); account catalog:
  // window 1,000,000, levels low … max, `default_effort` medium (Fable 5.1 and 5: high).
  { id: "claude-fable-5-2", label: "Fable 5.2", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "claude-fable-5-1", label: "Fable 5.1", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "high" },
  { id: "claude-fable-5", label: "Fable 5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "high" },
  // Opus 5.5 needs Claude Code ≥ 2.1.280 (account catalog `min_claude_code_version`; older answers 400
  // "unrecognized_model"). Levels low … max, catalog level medium, window 1,000,000.
  { id: "claude-opus-5-5", label: "Opus 5.5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "claude-opus-5", label: "Opus 5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "high" },
  { id: "claude-opus-4-8", label: "Opus 4.8", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "high" },
  // Sonnet 5.5 and Haiku 5.5 (from 2.1.296): the model table carries them with `context.window` 1e6 (native_1m),
  // `effort`/`xhigh_effort`/`max_effort` and `default_effort: "medium"`; embedded catalog and account catalog name the
  // levels low … max with "medium" as the default and NO `min_claude_code_version`. On the wire
  // (measured against the real CLI at 2.1.296): without --effort `output_config.effort` "medium", each of the
  // five levels as chosen, `thinking` adaptive. They are the default of their family — the CLI's alias
  // `sonnet`/`haiku` points at them (web and iOS keep their `/model` aliases in step).
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "claude-sonnet-5", label: "Sonnet 5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "high" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"], catalogLevel: "medium" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", context: 200000, efforts: [] },
];

// The CLI's native orchestrators are off in EVERY cbase Claude run. If a model calls Claude's `Workflow` tool, cbase
// closes stdin after the first result, and the CLI silently aborts the workflow after its wait ceiling (exit 0, in the
// chat only "I'll get back to you"); cbase counts its agents as 0, the credit gate does not see them, and "no subagent
// of a subagent" is bypassed through it. There is exactly ONE orchestrator: cbase's.
//
// The block sits HERE and not in the run specs: the oneshots have no spec and still the full toolset, and every future
// run kind is included by itself. Appended BEHIND the spec's entries (the check of the native subagents reads
// "Agent,Task" at the beginning). Measured at 2.1.273 and 2.1.280: the block removes `Workflow` from init AND from the
// request, stderr stays empty — also next to `--tools ""`. The keyword "ultracode" in the text does NOT fire headless
// (only `--effort ultracode`); the setting `workflowKeywordTriggerEnabled` exists, it is therefore not set.
//
// Claude's `Agent` and `Task` — in EVERY run, not only for the subagent: otherwise a main chat would have a second
// path to subagents past cap, depth, credit gate and consumption counting. Agent definitions run as agent types of
// `cbase_agent` through the core (runs/agents.js); `--agents` is in no spawn.
//
// Claude's `SendMessage` and `ListAgents`: talking to other agents only goes via `cbase_agents_list`/
// `cbase_agent_send`. Measured at the pinned CLI: in `-p` it offers both
// (init AND first request, in chat and oneshot form); the block removes both from init and request, exit 0, stderr
// empty — also with ToolSearch. Re-measure on every CLI jump. Repeated at 2.1.296 and 2.1.322 (together with
// sp4-claude-wait.mjs): the same names, both blocks hold; newly offered without a block only `Monitor` (it is in
// CLAUDE_WAIT_LOCK).
// `EnterWorktree`, `ExitWorktree` and `ReportFindings` — at the pin in the toolset of every chat run:
// EnterWorktree/ExitWorktree create their own git checkout and move the CLI's working directory past cbase (cbase
// manages worktrees itself: cbase_agent with isolation "worktree"; runtime folder and instance only know the run's
// directory); ReportFindings is the back channel of a CLI-own review flow that does not exist in cbase (findings
// belong in the response or the report).
// `TaskStop` stays ALLOWED (see CLAUDE_WAIT_LOCK): the end of a run sends `stop_task` as a control message over stdin
// (runChatClaude cbaseEndInput), not as a tool call — whether blocking the tool touches this path is not measured at
// the pin.
// Reference-Version: 2.1.322
export const CLAUDE_LOCK_DEFAULT = Object.freeze(["Workflow", "Agent", "Task", "SendMessage", "ListAgents", "EnterWorktree", "ExitWorktree", "ReportFindings"]);

// What a ONESHOT must additionally not have: everything that triggers ANOTHER turn after the response. Up to 2.1.291
// `claude -p` ended a background command 5 s after the last result and dropped a scheduled wakeup; since 2.1.292 the
// CLI waits for both and runs a follow-up turn afterwards (changelog: "one-shot `claude -p` … both are now waited
// for"). Measured against an API mock in the oneshot form (`-p --output-format json`, prompt via stdin) at 2.1.296: a
// 20 s background Bash ⇒ result after 20.5 s with the text of the FOLLOW-UP turn and a third request; a
// ScheduleWakeup ⇒ after 103 s, again with the follow-up turn. But a oneshot (title, goal, verdict, compaction, scan,
// classification) has exactly ONE response — the caller would get the wrong one and wait until its deadline. Hence in
// every oneshot:
//   • `ScheduleWakeup` blocked (measured: the block removes it from the request, the call ends "No such tool available");
//   • `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (ONESHOT_ENVIRONMENT): the parameter `run_in_background` drops out of
//     the Bash schema (measured at 2.1.280 and 2.1.296); a call with it does not wait. A cron job (CronCreate) does NOT
//     hold a oneshot at 2.1.296 (measured) — it stays allowed. The same environment also removes the notification turn:
//     a background command that ends during the LAST model request would replace the response with the evaluation of
//     its notification;
//   • `Monitor` blocked: the environment does NOT switch it off (the tool only asks a server-side
//     flag, not `backgroundTasksDisabled`), and an armed monitor holds `claude -p` after the end
//     (another server-side flag, default on). Measured at 2.1.280 AND 2.1.296 against an API mock WITH
//     ONESHOT_ENVIRONMENT: offered, and "sleep 25; echo ping" ⇒ exit after 25.4 s with the response of the follow-up
//     turn.
// The chat (stream-json) does not need this: there `cbaseEndInput` ends open tasks itself (runChatClaude) — also an
// armed monitor (measured: `stop_task` ⇒ "killed", no follow-up turn) —, and a scheduled wakeup does not hold after
// stdin closes at 2.1.296 either (measured).
export const ONESHOT_LOCK = Object.freeze(["ScheduleWakeup", "Monitor"]);
export const ONESHOT_ENVIRONMENT = Object.freeze({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });

// The CLI's own wait tools are off in EVERY cbase Claude run. The base rule (runs/system-prompt.js, waiting for
// something) names EXACTLY TWO tools — cbase_monitor and cbase_wakeup; if the CLI offered ScheduleWakeup and
// CronCreate/CronDelete/CronList next to them, the rule would forbid what the offering shows. The native wakeups only
// live in THIS CLI session (when the run ends, the wakeup is gone), cbase cannot show them for every provider, and
// Codex/engine have none. `Monitor` is included: at the pin behind a server flag, an armed one holds `-p` (see
// ONESHOT_LOCK). `TaskStop` stays ALLOWED — it ends an own background command (the Bash hook rejects
// `run_in_background`, so TaskStop has hardly anything left to stop, but a block remains unmeasured — `stop_task` of
// the run end goes through the same task mechanism of the CLI).
// Measured at the pin 2.1.296 (chat form with and without ToolSearch and
// oneshot): without the block ScheduleWakeup, CronCreate, CronDelete, CronList and TaskStop in init and request; with
// it only TaskStop, exit 0, stderr empty. Re-measure on every CLI jump.
export const CLAUDE_WAIT_LOCK = Object.freeze(["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "Monitor"]);

// The block list of a run: the spec's, behind it the default and the wait tools — every name once.
function blockList(fromSpec) {
  const list = Array.isArray(fromSpec) ? fromSpec.filter(Boolean) : [];
  return [...new Set([...list, ...CLAUDE_LOCK_DEFAULT, ...CLAUDE_WAIT_LOCK])];
}

// Environment for Claude calls: the subscription/keychain login must not be trumped by a set API key or .env token —
// so these variables are removed.
export function cleanClaudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  // The CLI's auto memory off: otherwise it would keep its own memory/ per working folder under
  // ~/.claude/projects/<slug>/ in -p mode, invisible in cbase, and advertise it in the system prompt (measured at
  // 2.1.280: without the variable init reports `memory_paths.auto` and creates the folder, with it neither). Knowledge
  // belongs in the context system. Re-measure on every CLI jump (wording in the binary).
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

// The environment of the service detection — laid over cleanClaudeEnv, in the project container as in the backend.
// Measured at the pin 2.1.280: `claude -p` calls git in a repo on every start (`ls-files` twice, `remote get-url
// origin`, `remote`, `status`, `log`, `config user.name`) and for `ls-files`, `status`, `log` and `config` removes our
// `GIT_DIR` and replaces `GIT_CONFIG_*` with its eight `-c` — a repo-local `filter.<x>.clean` would run at start. With
// CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 `status`, `log` and `config` go away (the filter does not run), `ls-files`
// and `remote`/`remote get-url` remain. The other values are the hardening: they reach `remote`/`remote get-url` (with
// GIT_DIR=/nonexistent exit 128, silent) and every child the CLI does not harden itself. In the project container all
// names go along via `envAlways` as `-e NAME` (runtime/inProject.js) — even if the backend carries the same value; the
// value only stands in the environment of the docker child. A property of the binary, not a contract: re-measure on
// every CLI jump.
// ENABLE_CLAUDEAI_MCP_SERVERS=false (measured with a real login at the pin 2.1.280, fresh CLAUDE_CONFIG_DIR per case,
// `--debug-file`): without `--strict-mcp-config` the CLI fetches the list of claude.ai connectors (`[claudeai-mcp]
// Fetching … /v1/mcp_servers`) and builds a transport per connector ("Initializing claude.ai proxy transport"). With
// `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (buildClaudeOnceArgs) the list is still fetched, but NO
// transport, init 0 — the hardening holds. With this variable ("0", "false", "no", "off") the CLI reports
// "[claudeai-mcp] Disabled via env var" and fetches nothing at all, with or without strict. Both together: the switch
// saves the fetch and does not depend on the order in the binary, strict holds if a CLI jump renames the switch.
export const DETECTION_ENVIRONMENT = Object.freeze({
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  GIT_DIR: "/nonexistent",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
});
// The tools of the service detection (init names exactly these three — no Bash, no MCP tool). The read boundary (no
// reference out of the working folder) depends on the permission mode `default` and on no `--add-dir` being set —
// buildClaudeOnceArgs sets the mode EXPLICITLY (see there) and never `--add-dir`.
export const DETECTION_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);

// Errors in the RESULT OBJECT of a one-time call — the exit code alone does not tell. Measured at the CLI's schema
// (2.1.270): its error variant carries `is_error:true` with `subtype` error_during_execution | error_max_turns |
// error_max_budget_usd | error_max_structured_output_retries and the wording in `errors: [string]` — WITHOUT `result`;
// its success variant (`subtype:"success"`) can carry `is_error:true` with the wording in `result`. The object has no
// `error` field. Reading only `result` would turn a usage limit under exit 0 into the "response" — persisted as a
// context summary, as a chat title, as a verdict. The wording is the MESSAGE of the exception, because every caller
// (isLimitError, compaction) reads the exception text with detectLimitHit — what is not there, nobody can recognize
// as a limit. Null if the object is not an error.
function resultError(ev) {
  if (!ev || typeof ev !== "object") return null;
  const subtype = String(ev.subtype || "");
  // All error variants set `is_error`; the subtype is the second safeguard in case a build writes one without the other.
  if (ev.is_error !== true && !subtype.startsWith("error")) return null;
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const errors = Array.isArray(ev.errors) ? ev.errors.map(text).filter(Boolean).join("\n") : "";
  return new Error(errors || text(ev.result) || `Claude oneshot failed${subtype ? ` (${subtype})` : ""}`);
}

// The arguments of a oneshot. The prompt ALWAYS goes via stdin, never as a positional argument — that is why the
// variadic `--disallowedTools` may stand at the end: nothing follows it that it could swallow.
// Factored out so that a guard checks the oneshot form without a fake binary.
export function buildClaudeOnceArgs({ material = false, model = "", effort = "", withoutTools = false, onlyRead = false } = {}) {
  const args = material
    ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
    : ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  // The level of a oneshot: `runOnce` has already resolved and clamped it — the same clamp here is then a no-op and
  // only protects the direct call. No level ⇒ no flag (Haiku 4.5).
  const level = effort ? mapClaudeEffort(effort, model) : "";
  if (level) args.push("--effort", level);
  if (withoutTools) args.push("--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  // The service detection only reads — Read, Glob, Grep. Plus the same empty MCP configuration as above: in the first
  // run of a fresh config folder the claude.ai connectors stood as MCP servers in init despite
  // `--setting-sources user`. `withoutTools` takes precedence (then none at all).
  else if (onlyRead) args.push("--tools", DETECTION_TOOLS.join(","), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  // Only the user's settings, never the working folder's. All oneshots except the service scan run sandboxed in an
  // empty folder (runs/sandboxing.js); the scan without an instance stays in the backend in the project folder — and a
  // converted project's container writes that folder freely. Without the flag the CLI would load the project's
  // `.claude/settings.json` and run its hooks in the backend: outside fence and network separation, with DB, docker
  // seam and the neighboring projects in reach. The same holds for the project's `.mcp.json`: its stdio server would
  // start in the backend, even WITHOUT approval in the settings (-p knows no trust prompt). Measured at the isolated
  // CLI 2.1.283/2.1.287/2.1.288 in exactly this form: without the flag hook and server wrote their mark, with
  // `--setting-sources user` neither. The chat run has the same isolation via `spec.settingSources`. Price: the CLI
  // does not read the project's CLAUDE.md this way either — a oneshot gets its context explicitly in the prompt.
  // Guard: native-orchestrator.test.js.
  args.push("--setting-sources", "user");
  // The permission mode EXPLICITLY. Without `--permission-mode` `claude -p` starts in mode `auto` since 2.1.285 with
  // telemetry switched off (2.1.280: `default`) — and auto mode collects git context at start WITHOUT our GIT_DIR
  // (`config --get-regexp`, `symbolic-ref`, `rev-parse`, `status --porcelain --untracked-files=normal`); in the service
  // detection both repo-local filters (`clean`, `process`) would run — exactly what DETECTION_ENVIRONMENT is meant to
  // prevent. CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS still works but does not cover auto mode. Measured against
  // the real CLI (2.1.280, 2.1.284 … 2.1.288, 2.1.296): with `--permission-mode
  // default` 2.1.296 shows exactly the git set of 2.1.280 (`ls-files`, `remote`/`remote get-url`, `--version`,
  // `worktree list`), no filter, mode `default` — also with telemetry on. Applies to EVERY oneshot, not only the
  // detection: a oneshot never asks for permission, and auto mode would be a second, silent classifier next to our
  // toolset. Before the variadic `--disallowedTools` (see above).
  args.push("--permission-mode", "default");
  args.push("--disallowedTools", [...new Set([...blockList([]), ...ONESHOT_LOCK])].join(","));
  return args;
}

// One-time, non-interactive call → parsed text response (result).
//
// `images` (optional): [{ mime, dataB64 }] — images the model should LOOK AT. They force the call onto another input
// path: plain text goes via stdin, images need `--input-format stream-json` because a prompt only carries characters
// and no bytes. The CLI then also requires `--output-format stream-json` ("--input-format=stream-json requires
// output-format=stream-json"), which is why the result is fished out of the lines here instead of a single JSON object.
//
// Without images the text path stays the normal case — converting all one-time calls to stream-json would burden each
// of them with line-by-line evaluation.
/**
 * A single call without a conversation.
 *
 * `withoutTools` is the boundary for derived tasks with FOREIGN text (classification and extraction). Without the
 * switch the CLI starts with its full default set: measured, it then reads in the working directory and runs Bash
 * (writing and network are off). That is right for a service scan and wrong for a foreign message — there an injected
 * instruction is an attack, not a task. Verified: with `--tools ""` the same model answers "no tool" to both
 * requests. `--strict-mcp-config` with an empty configuration additionally removes the MCP tools — without it the CLI
 * would pull a configuration from the environment.
 */
// `onlyRead` and `instance`: the service detection. `onlyRead` gives it the tools Read/Glob/Grep and the environment
// DETECTION_ENVIRONMENT; with `instance` it runs in the project container (`inProject`, the names via `envAlways`)
// and always in this form — without an instance in the backend like every oneshot (`spawn`).
export function runOnceClaude(prompt, { cwd, timeoutMs = 90_000, model, effort = "", images = [], documents = [], withoutTools = false, onlyRead = false, instance = null, provider = "claude", atConsumption } = {}) {
  // The same construction as with every other connector (contract.js): images and documents are two block kinds — the
  // API rejects a PDF as `image`. Here the neutral format is also the wire format, so it goes unchanged into the
  // stream-json line.
  const message = materialMessage(prompt, { images, documents });
  const material = typeof message.content === "string" ? null : message.content;
  return new Promise((resolve, reject) => {
    const read = onlyRead === true || Boolean(instance);
    const args = buildClaudeOnceArgs({ material: !!material, model, effort, withoutTools, onlyRead: read });
    // ONESHOT_ENVIRONMENT in EVERY oneshot (no background command that replaces the one response with a follow-up turn — see there).
    const env = { ...cleanClaudeEnv(), ...(read ? DETECTION_ENVIRONMENT : {}), ...ONESHOT_ENVIRONMENT };
    const child = instance
      ? inProject(instance, claudeBin(), args, { cwd, env, envAlways: [...Object.keys(DETECTION_ENVIRONMENT), ...Object.keys(ONESHOT_ENVIRONMENT)] })
      : spawn(claudeBin(), args, { cwd, env });
    // The consumption is in the result event (`usage`, Anthropic shape; the model as the key of `modelUsage` if the
    // call named none) — reported also for a result marked as an error: the tokens are spent.
    const report = (ev) => {
      const v = anthropicConsumption(ev?.usage);
      if (v) reportConsumption(atConsumption, { provider: provider || "claude", model: model || Object.keys(ev?.modelUsage || {})[0] || "", ...v });
    };
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Timeout")); }, timeoutMs);
    // The whole input at once, then closed. If the CLI dies before that (missing binary, immediate abort), that has no
    // consequence — the outcome of this call is in `close`/`error` of the child anyway, and both are wired below.
    writeStdin(child, material ? `${JSON.stringify({ type: "user", message })}\n` : prompt, { close: true });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Exit ≠ 0 with a result object: the CLI reports e.g. "Prompt is too long" in the result on stdout, not on
      // stderr — the compaction (../../claude.js compactConversation) only shortens if it reads this wording in the
      // exception.
      if (code !== 0) {
        let fromResult = null;
        for (const row of [out, ...out.split("\n")]) {
          try { const ev = JSON.parse(row); if (ev?.type === "result" || "is_error" in (ev || {})) { fromResult = resultError(ev); break; } } catch { /* next */ }
        }
        return reject(fromResult || new Error(err.slice(-500) || `exit ${code}`));
      }
      if (material) {
        // stream-json: one JSON line per event, the result is in the one with type "result". Broken lines are skipped
        // instead of losing the whole run.
        for (const row of out.split("\n")) {
          if (!row.trim()) continue;
          try {
            const ev = JSON.parse(row);
            if (ev?.type === "result") {
              report(ev);
              const error = resultError(ev);
              return error ? reject(error) : resolve(typeof ev.result === "string" ? ev.result : "");
            }
          } catch { /* partial line or progress noise — the next one counts. */ }
        }
        return reject(new Error("The stream contained no result."));
      }
      let parsed;
      try { parsed = JSON.parse(out); } catch (e) { return reject(new Error("Response not parseable: " + String(e))); }
      report(parsed);
      const error = resultError(parsed);
      if (error) return reject(error);
      resolve(typeof parsed.result === "string" ? parsed.result : "");
    });
  });
}

// The five levels the Claude CLI knows — measured at 2.1.273 and 2.1.280 (same wording): a value outside these five
// ends with exit 0 and the stderr line "Warning: Unknown --effort value '…' — ignoring it and using the default
// effort. Valid values: low, medium, high, xhigh, max." Nobody reads this line: the turn runs, just with the DEFAULT
// instead of the chosen level — a silent downgrade, indistinguishable from a regular run.
//
// A chat's provider switch does NOT rewrite the stored level — the user chose it, and the UI marks it. So every
// provider clamps itself, and all by THE SAME computation (`effortFallback` in workflows.js): the highest supported
// level that is NOT ABOVE the requested one. The connector clamps per model against ITS list (`efforts` in
// `CLAUDE_MODELS`); these five are only the levels the CLI KNOWS at all — the UIs' default for a model without a
// catalog entry (bound in effort.test.mjs).
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * The levels this Claude model supports — the question `effortRunning` (providers/index.js) and the clamp at spawn
 * (`mapClaudeEffort`) ask THE SAME way. From `CLAUDE_MODELS`:
 *   • a model in the catalog ⇒ its list, also the EMPTY one (Haiku 4.5: no levels ⇒ no `--effort`);
 *   • a model outside (alias, future id, empty = CLI default) ⇒ `null`, "unknown": the level passes through — a
 *     provider's catalog is a lower bound.
 * @param {string} model  the model id of the run
 * @param {string} model  the model id of the run
 * @returns {string[] | null}
 */
export function claudeEfforts(model = "") {
  const list = CLAUDE_MODELS.find((m) => m.id === model)?.efforts;
  return Array.isArray(list) ? [...list] : null;
}

export function mapClaudeEffort(effort, model = "") {
  const e = String(effort || "").toLowerCase();
  const supported = claudeEfforts(model);
  const fallback = effortFallback(e, supported);
  // No level (not in EFFORT_LEVELS) ⇒ no flag at all, the same everywhere.
  if (!fallback) {
    if (e && supported && !supported.length) console.warn(`[claude] ${model} supports no effort levels — "${e}" does not go to the CLI.`);
    else if (e) console.warn(`[claude] "${e}" is not an effort level at all (valid: ${EFFORT_LEVELS.join(", ")}) — the run thinks with the CLI default.`);
    return "";
  }
  if (fallback !== e) console.warn(`[claude] Effort "${e}" is not supported by ${model} (supported: ${(supported || []).join(", ")}) — the run thinks with "${fallback}".`);
  return fallback;
}

// Builds the Claude CLI arguments from the provider-neutral run spec (see providers/index.js).
export function buildClaudeChatArgs(spec) {
  // input-format stream-json: stdin stays open → the orchestrator (doRun) can inject further user messages while a
  // monitor is waiting and ends the run explicitly (cbaseEndInput) as soon as a result without open monitors comes.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--append-system-prompt", spec.systemPrompt,
    // Since CLI 2.1.267 the default freezes the system prompt at the FIRST turn of a session and sends it verbatim on
    // every --resume, even if a later start passes different text — until the compaction, which cbase does itself
    // (session reset, no CLI /compact). The appended prompt changes between turns on purpose (/goal, project focus,
    // tool choice, skill catalog). `off` is the behavior up to 2.1.259. Re-measured at 2.1.273 and 2.1.280: two turns
    // via --resume — with the flag the second carries its own appended prompt, without it that of the first.
    "--system-prompt-snapshot", "off"];
  for (const d of spec.addDirs || []) args.push("--add-dir", d);
  // Cut the built-in tools (spec.builtinTools = list; [] = none, null = full set). --tools ONLY affects the built-in
  // set, MCP tools stay untouched (verified). It is variadic: the next token MUST be an option, otherwise it swallows
  // it — that is why the push stands right before the --permission-mode that always follows.
  // `--tools` is the allowlist over the CLI's BUILT-IN tools — and its ToolSearch is one of them. A cut set would cut
  // it away too, and the CLI would put all MCP schemas into every request (see runs/do-run.js). It is only appended
  // if the turn carries enough tools for deferred loading to pay off; whether they are really deferred, the CLI
  // decides afterwards.
  if (Array.isArray(spec.builtinTools)) {
    const tools = spec.toolSearch && !spec.builtinTools.includes("ToolSearch")
      ? [...spec.builtinTools, "ToolSearch"]
      : spec.builtinTools;
    args.push("--tools", tools.join(","));
  }
  // Explicitly forbid individual tools: the spec's entries (every run: the native Skill tool; subagents at the depth
  // limit: the cbase_agent family), behind them the connector's fixed default (`Workflow`, `Agent`, `Task`, see
  // CLAUDE_LOCK_DEFAULT) — the flag is therefore in EVERY run. --disallowedTools is variadic like --tools, so it
  // stands right before the next option.
  args.push("--disallowedTools", blockList(spec.disallowedTools).join(","));
  // Every run carries a mode (the preparation sets it: `chat.permissionMode || "bypassPermissions"`, outer loop
  // "default"/"acceptEdits"). If it is missing after all, it is `default` — never an empty flag and never the CLI
  // default: since 2.1.285 that is `auto` without the flag (see buildClaudeOnceArgs).
  args.push("--permission-mode", spec.permissionMode || "default");
  args.push("--settings", bashGuardSettings({ cpuWait: spec.saver === true }));
  // CPU saver: the hook events in the stream — agent-runtime.js reads "waiting for CPU" from them (system/hook_progress with the mark).
  if (spec.saver === true) args.push("--include-hook-events");
  args.push("--mcp-config", spec.mcpConfigPath, "--strict-mcp-config");
  args.push("--allowedTools", (spec.allowedTools || []).join(","));
  if (spec.permissionPromptTool) args.push("--permission-prompt-tool", "mcp__cbase__cbase_permission_prompt");
  // `--setting-sources` is the ISOLATION, not the injection: it hides the on-disk skills of the working directory
  // (cwd = workspace, i.e. the skills of foreign project sources). Skills come via `cbase_skill`, and the native Skill
  // tool is disabled via --disallowedTools.
  if (spec.settingSources) args.push("--setting-sources", spec.settingSources);
  if (spec.model) args.push("--model", spec.model);
  const effort = mapClaudeEffort(spec.effort, spec.model);
  if (effort) args.push("--effort", effort);
  if (spec.sessionId) args.push("--resume", spec.sessionId);
  if (spec.sessionId && spec.forkPending) args.push("--fork-session");
  return args;
}

// The open background tasks of ONE CLI process — read from its stream, needed by `cbaseEndInput` (runChatClaude). The
// actual list `system/background_tasks_changed` is authoritative (as in runs/do-run.js): it REPLACES the set — it
// comes before the `task_started` of the same task (measured), so it already names what is about to start. In
// addition `system/task_started` adds, and `system/task_updated` with a status other than running/pending removes.
// When in doubt rather one too many: an unnecessarily stopped task costs nothing (`stop_task` with an unknown id
// answers `success`, measured at 2.1.296), a forgotten one up to two hours of waiting and a follow-up turn. Every task
// kind counts (Bash, Monitor, …): the CLI waits for each, and whoever closes stdin wants to end the process. Measured
// for the monitor (2.1.280 and 2.1.296): without stop_task exit only after its end plus a follow-up turn, with
// stop_task "killed" and exit after 0.1 s.
// What the ledger can NOT prevent: a command that ends during the last model request is already done at the result,
// but its notification to the model is pending — the CLI runs it 4 ms after the result as its own turn, with stdin
// open or closed (2.1.280 and 2.1.296). The consumer takes it: the chat as a continuation of the same run
// (runs/do-run.js `owedFollowUpTurn`), the subagent keeps the report of the first result
// (providers/agent-runtime.js, makeForward).
export function openTasksLedger() {
  const open = new Set();
  return {
    observe(evt) {
      if (!evt || evt.type !== "system") return;
      if (evt.subtype === "task_started" && evt.task_id) open.add(String(evt.task_id));
      else if (evt.subtype === "background_tasks_changed" && Array.isArray(evt.tasks)) {
        open.clear();
        for (const t of evt.tasks) if (t?.task_id) open.add(String(t.task_id));
      } else if (evt.subtype === "task_updated" && evt.task_id) {
        const st = evt.patch?.status;
        if (st && st !== "running" && st !== "pending") open.delete(String(evt.task_id));
      }
    },
    open: () => [...open],
  };
}

// How long `cbaseEndInput` waits for the responses to its `stop_task` requests before it closes stdin anyway (a CLI
// that does not know the request or hangs). Measured, 2.1.280 and 2.1.296 answer in 2–5 ms.
const STOP_TASK_DEADLINE_MS = 5000;

// Chat run with streaming. onEvent gets every stream-json event (Claude shape).
// Resolves with {code, sessionId, resultText, errorText, stderr}.
export function runChatClaude({ spec, onEvent, onSpawn }) {
  return new Promise((resolve) => {
    const args = buildClaudeChatArgs(spec);
    // `spec.instance`: fixed at the start of the turn; without it this is exactly a plain start. With it the CLI
    // carries the LFS environment — its Bash and its hooks inherit it (runs/lfs-environment.js).
    // CPU saver: a background agent with the toggle on starts under `nice -n 10` (its Bash children inherit it).
    const [program, argv] = withNice(claudeBin(), args, spec.saver === true);
    const child = inProject(spec.instance || null, program, argv, withLfsEnvironment(spec.instance || null, { cwd: spec.cwd, env: cleanClaudeEnv() }));
    // stdin stays open (input-format stream-json). The orchestrator controls the end:
    //  • cbaseInject(text)  — another user message into the RUNNING process (monitor wait phase)
    //  • cbaseEndInput()    — close stdin → the CLI exits after its current state
    const userMsg = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: String(text) }] } }) + "\n";
    // Whether the input is still open the helper knows (ended, destroyed or EPIPE seen) — no second mark next to it.
    // `writeStdin` returns `false` as soon as the process accepts nothing anymore — exactly the answer `cbaseInject`
    // owes its caller. Also as soon as the end is DECIDED (`endDecided`): between the stop_task requests and the
    // closing stdin is still open, a message there would begin a turn that the closing would cut off.
    let endDecided = false;
    child.cbaseInject = (text) => !endDecided && writeStdin(child, userMsg(text));
    // The end: up to 2.1.291 the CLI itself ended every background command 5 s after stdin closed. Since 2.1.292 it
    // WAITS for it — a dev server holds the process until the command's time limit — and afterwards runs an ADDITIONAL
    // turn with a model call (measured against an API mock: 20.4 s instead of 5.4 s, three instead of two requests). A
    // chat, a subagent or a workflow agent with a dev server would thus stay `busy` for up to two hours, and a
    // subagent would report the text of the follow-up turn instead of its report. Therefore cbase ends the open tasks
    // ITSELF before it closes stdin: per task `control_request` `stop_task`, then — as soon as every request is
    // answered — stdin closed. Measured at 2.1.280 and 2.1.296: task `killed`, no follow-up turn, exit 0 (SIGTERM
    // would work too but ends with 143). Here and not in the orchestrator, so that chat (runs/do-run.js), subagent and
    // workflow agent (providers/agent-runtime.js) and outer loop end the same way. Without an open task: stdin closed
    // immediately, no further line on stdin.
    const tasks = openTasksLedger();
    const pending = new Set();
    let stopDeadline = null;
    const close = () => {
      if (stopDeadline) { clearTimeout(stopDeadline); stopDeadline = null; }
      pending.clear();
      closeStdin(child);
    };
    child.cbaseEndInput = () => {
      if (endDecided) return;
      endDecided = true;
      for (const taskId of tasks.open()) {
        const requestId = `cbase-stop-${taskId}`;
        const row = JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "stop_task", task_id: taskId } }) + "\n";
        if (writeStdin(child, row)) pending.add(requestId);
      }
      if (!pending.size) return close();
      stopDeadline = setTimeout(() => {
        console.warn(`[claude] stop_task without a response (${[...pending].join(", ")}) — closing stdin anyway.`);
        close();
      }, Number(process.env.CBASE_STOP_TASK_DEADLINE_MS) || STOP_TASK_DEADLINE_MS);
      stopDeadline.unref?.();
    };
    //  • controlCbase(text) — a message IN THE MIDDLE of the turn (cbase_agent_send to a running subagent): the same
    //    path; the CLI delivers it at the next tool boundary (measured at 2.1.280 and 2.1.296, t35-tool-limit.mjs).
    //    If it only arrives during the LAST model request, the turn ends without it, and the CLI runs it afterwards as
    //    its own turn — even if stdin closes at the first result (measured at 2.1.280 and 2.1.296).
    child.controlCbase = (text) => !endDecided && writeStdin(child, userMsg(text));
    onSpawn?.(child); // hand the process to the caller (for abort/injection)
    writeStdin(child, userMsg(spec.input));
    let buf = "";
    let sessionId = null;
    let resultText = null;
    // The error text of the last turn: ONLY from a result marked as an error (`is_error` or subtype `error_*`, the
    // same reading as resultError and runs/do-run.js). `resultText` is the model's RESPONSE in a successful turn — the
    // limit detection (runs/auto-continue.js) therefore reads this field.
    let errorText = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        // The CLI's response to a control request is protocol, not a conversation event: it goes to NO consumer (the
        // orchestrator, the subagent core, the history and the clients do not know the type — an error response would
        // look like an error of the run there). cbase only sends `stop_task`; once the last one is answered, stdin
        // closes.
        if (evt.type === "control_response") {
          const rid = evt.response?.request_id;
          if (rid && pending.delete(rid) && !pending.size) close();
          continue;
        }
        // BEFORE onEvent: a consumer calls cbaseEndInput synchronously from within this event (agent-runtime at the result).
        tasks.observe(evt);
        if (evt.session_id) sessionId = evt.session_id;
        if (evt.type === "result") {
          resultText = typeof evt.result === "string" ? evt.result : null;
          const error = resultError(evt);
          errorText = error ? error.message : "";
        }
        onEvent(evt);
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { if (stopDeadline) clearTimeout(stopDeadline); resolve({ code: -1, sessionId, resultText, errorText, stderr: String(e) }); });
    child.on("close", (code) => { if (stopDeadline) clearTimeout(stopDeadline); resolve({ code, sessionId, resultText, errorText, stderr }); });
  });
}
