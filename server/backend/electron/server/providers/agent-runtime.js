// agent-runtime.js — the provider-neutral SUBAGENT core.
//
// Why this core exists: the Claude CLI spins up its subagents ITSELF — the main model calls its built-in tool `Agent`
// (still listed under the old name `Task` in the init event; cbase blocks both). The event stream of that:
//   assistant/tool_use  name="Agent" {description, prompt, subagent_type, run_in_background}
//   system/task_started {task_id, tool_use_id, description, subagent_type, task_type:"local_agent", prompt}
//   user (parent_tool_use_id = tool_use id of the call)   ← the subagent's task
//   system/task_updated {patch:{status:"completed", end_time}}
//   system/task_notification {status, output_file, summary, usage:{total_tokens,tool_uses,duration_ms}}
//   user/tool_result    report + "agentId: … (use SendMessage … to continue this agent)" + <usage>
//                       plus tool_use_result {resolvedModel, totalTokens, totalToolUseCount, …}
// So a subagent runs as its own agent loop with its own context, toolset and model — but ALWAYS at Claude. A Codex
// chat had no subagent tool at all, and the loop engine could only drive providers with complete() as subagents.
//
// This core closes that gap: EVERY model may start EVERY other one as a subagent. It drives the subagent as a complete
// run of its own through the provider registry (runChat) — a subagent at a native CLI (Claude/Codex) is as possible
// as one at a completion provider, no matter WHO started it.
//
// The core is deliberately free of HTTP, DB and registry: everything environment-dependent comes in as a callback
// (buildSpec/runChat/resolveRef/agentDefs). That is why it is testable without a server.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitRun } from "../runtime/git-run.js";

import { PROJECT_REPO_SECTION, PROJECT_REPO_KEY, isProjectRepo } from "../git.js";
import { formatModelRef, mcpOfTheType, parseModelRef, withParent } from "./contract.js";
import { buildTranscript } from "./transcript.js";
import { createUsageTally } from "../usage-tally.js";
import { subscriptionPlus, tokenSum, tokenParts, tokenIncrease, consumptionPlus } from "./connectors/consumption.js";
import { createStallWatchdog, realClock } from "./stall-watchdog.js";
import { AGENT_DEPTH_MAX, remainingDepth } from "../../mcp/visibility.js";
import { EFFORT_LEVELS, effortSavable } from "../workflows.js";
import { writeInRuntimeFolder } from "../runs/runtime-write.js";

// How long a call waits for a subagent (MCP edge, foreground deadline, "the main agent never waits"): agent-wait.js.
// The names are re-exported here — importers read them from this file.
import { OUTPUT_WAIT_MAX_MS, mainAgentWaitMs, foregroundDeadline, foregroundDeadlines } from "./agent-wait.js";
import { cpuWaitFrom } from "../../mcp/cpu-saver.js"; // "save computing power"
export { OUTPUT_WAIT_MAX_MS, MAIN_AGENT_WAIT_DEFAULT_MS, MCP_WAIT_EDGE_MS, FOREGROUND_DEFAULT_MS, mainAgentWaitMs, foregroundDeadline, foregroundDeadlinesNow } from "./agent-wait.js";
const DEFAULT_WAIT_MS = OUTPUT_WAIT_MAX_MS;
const MAX_WAIT_MS = OUTPUT_WAIT_MAX_MS;
// The input with which a parked subagent resumes its session after the reset.
const RESUMPTION_AFTER_LIMIT = "The usage limit has been reset. Continue your task exactly where you were interrupted, and report at the end as required.";

// ── Stall deadline ────────────────────────────────────────────────────────────────────────────────────────────
// That long without progress ⇒ the subagent counts as failed and is ended (the clock stands while a tool call runs —
// providers/stall-watchdog.js). The environment knob is read at every turn; the gate sets one hour so that only the
// test seam triggers a stall there, never the load.
export const STALL_DEFAULT_MS = 600_000;
const positiveOr = (n, preset) => (Number.isFinite(n) && n > 0 ? n : preset);
export function agentStallDeadline() {
  return positiveOr(Number(process.env.CBASE_AGENT_STALL_MS), STALL_DEFAULT_MS);
}
// The subagents' rule: the deadline above, zero repetitions — a stall ends the agent as failed.
export const subagentStallRule = () => ({ deadlineMs: agentStallDeadline(), repetitions: 0 });
// The workflow agents' rule: 180 s without progress ⇒ restarted, up to 5 times; after the last stall failed (agent()
// returns null). The same watchdog, only parameterised. Two environment knobs, read at every turn (the names are in
// the function): the deadline and the number of restarts (0 is valid: none).
export const WORKFLOW_STALL_DEFAULT_MS = 180_000;
export const WORKFLOW_STALL_REPETITIONS = 5;
const workflowStallDeadline = () => positiveOr(Number(process.env.CBASE_DYNWF_STALL_MS), WORKFLOW_STALL_DEFAULT_MS);
function workflowStallRestarts() {
  const raw = process.env.CBASE_DYNWF_STALL_REPETITIONS;
  return raw !== undefined && raw !== "" && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : WORKFLOW_STALL_REPETITIONS;
}
export const workflowStallRule = () => ({ deadlineMs: workflowStallDeadline(), repetitions: workflowStallRestarts() });
const REPORT_CAP = 60_000;         // report of ONE subagent (like the engine's MAX_TOOL_TEXT)
const TRANSCRIPT_CAP = 400;        // rows of the recorded history per subagent

// Built-in agent types. `general-purpose` is the nameless default case, `fork` inherits the parent chat's context —
// the same two special cases Claude Code knows.
export const BUILTIN_AGENT_TYPES = {
  "general-purpose": {
    description: "General-purpose subagent without a special role: researches, searches, works through partial steps and reports briefly.",
    prompt: "",
  },
  fork: {
    description: "Like general-purpose, but inherits this chat's conversation history so far (for tasks that need the context).",
    prompt: "",
    inheritContext: true,
  },
};

// A subagent's frame: it names the DEPTH and the remaining levels — from the same count the MCP server, the CLI block
// list and the loop engine read (mcp/visibility.js). `delegated` says whether its set contains the subagent tool: if
// not, the frame does not explain it either (execution side and description side give the same answer). The marker
// line "SUBAGENT of cbase" stays verbatim (the tests' fake CLIs recognise the role by it).
// Where the report of a background child goes: to its PARENT agent as long as that one lives (the same delivery as
// cbase_agent_send to a running agent), otherwise to the main agent. ONE sentence for frame and execution
// (runs/agents.js onFinish). It names both ways of delivery: mid-turn where the provider can, otherwise right after.
export const GRANDCHILD_REPORT_SET = "Reports of your background subagents reach you by themselves as a system message (<task-notification>)"
  + " while you are working — in your next tool round or, where your provider cannot do that, right after your"
  + " current turn; if you end before that, they go to the main agent. You can collect them (foreground or cbase_agent_output),"
  + " but you do not have to.";
const LEVELS_WORD = ["no further level", "one further level", "two further levels", "three further levels"];
export function subagentFrame({ depth = 1, delegated = true } = {}) {
  const t = Math.max(1, Number(depth) || 1);
  const rest = remainingDepth(t);
  const underDir = LEVELS_WORD[rest] || `${rest} further levels`;
  const delegate = rest > 0 && delegated
    ? [
      `You may start subagents yourself (cbase_agent): below you there is still room for ${underDir}. Your subagents`,
      `never get more tools than you. ${GRANDCHILD_REPORT_SET}`,
    ]
    : rest > 0
      ? ["You do NOT delegate further: your toolset contains no subagent tool."]
      : [`You do NOT delegate further: you are on the last permitted level — below you there is room for ${underDir}.`];
  return [
    "",
    "# Your role in this run",
    `You are a SUBAGENT of cbase (depth ${t} of ${AGENT_DEPTH_MAX} below the chat). You work through a bounded`,
    "subtask on your own and report BRIEFLY and concretely at the end. Your report is the return value to your",
    "caller — they see nothing of your work except this report; so write it so that it is understandable without",
    "your history (findings, paths, numbers, decisions).",
    ...delegate,
    "You do NOT ask the user: questions belong in your report, so that the main agent asks them.",
  ].join("\n");
}
// The frame of a direct subagent of the chat with the subagent tool — the core's default when nobody sets a frame of
// their own (runs/agents.js computes it per agent from depth and set).
export const SUBAGENT_FRAME = subagentFrame({ depth: 1, delegated: true });

// Skills a subagent gets loaded IN FULL. The normal case is the catalog (name + purpose in the system prompt, body via
// `cbase_skill`) — a subagent whose whole role is a guide would otherwise fetch it as its FIRST tool call in every
// run. So the body goes straight into the system prompt; what is loaded this way is missing from the run's catalog.
export function skillsBlock(skills) {
  const list = (skills || []).filter((s) => s && s.name);
  if (!list.length) return "";
  const lines = [
    "# Loaded skills",
    "These guides are FULLY loaded for your task — you do not need to fetch them with `cbase_skill`. They apply to this work.",
  ];
  for (const s of list) {
    const purpose = String(s.description || "").replace(/\s+/g, " ").trim();
    lines.push("", `## Skill: ${s.name}${purpose ? ` — ${purpose}` : ""}`, "", String(s.body || "").trim());
  }
  return lines.join("\n");
}

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}\n… [truncated]` : t;
};

// Error text of a result event marked as an error — empty if the turn is none. Two shapes:
//   • loop engine (contract.js): `is_error:true` + `error.message`, the partial text stays in `result`.
//   • Claude CLI: the error variant carries `is_error:true` + `subtype` error_during_execution | error_max_turns |
//     error_max_budget_usd | … and the wording in `errors: [string]` — WITHOUT `result`; the success variant
//     (`subtype:"success"`) can carry `is_error:true` with the wording in `result`.
// Reading only `error.message || result` sees the CLI error variant as an empty error.
function resultError(evt) {
  if (!evt || evt.is_error !== true) return "";
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const errors = Array.isArray(evt.errors) ? evt.errors.map(text).filter(Boolean).join("\n") : "";
  return text(evt.error?.message) || text(evt.error) || errors || text(evt.result) || "Turn ended as an error (no wording)";
}

// The core's starter WITHOUT an instance: synchronous, without a cap.
const gitInB = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || "").trim() };
};
// A git of the core without an instance: runtime/git-run.js then calls ONLY the fallback — synchronous, the same value.
// With an instance no git goes through here: that is what the callback `gitFor` is for (see createAgentRuntime).
const git = (args, cwd) => gitRun(null, cwd, args, { fallback: () => gitInB(args, cwd) });

/**
 * Unregister a subagent's worktree from its repo when its chat falls: `git worktree remove --force <dir>`, then
 * `git worktree prune` — so the entry under .git/worktrees/ falls even if the folder is already gone or the caller
 * removes it itself. The branch `cbase/agent-<aid>` STAYS: it lives in the project's repo, not in the runtime folder,
 * and carries the agent's commits. Nothing without a repo. → true if `remove` succeeded. ONLY WITHOUT an instance: with
 * one, the same step goes as a teardown job into the project container (runs/git-post-work.js).
 */
export function unregisterWorktree({ dir, repo } = {}) {
  if (!dir || !repo || !fs.existsSync(repo)) return false;
  const r = git(["worktree", "remove", "--force", dir], repo);
  git(["worktree", "prune"], repo);
  return r.ok;
}

/** List (array) or comma list (string) → trimmed array without empty entries. */
export function toolList(v) {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(",");
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
}

/**
 * A definition's tool list: `null` = not set, `[]` = empty — two statements. The store carries it as `toolList` (list
 * or null); without that field (a caller that only knows `tools`) an empty comma list means "not set".
 */
export function definitionsList(def) {
  if (!def) return null;
  if (Array.isArray(def.toolList)) return toolList(def.toolList);
  if (def.toolList === null) return null;
  const l = toolList(def.tools);
  return l.length ? l : null;
}

/**
 * @param {Object} deps
 * @param {string} deps.chatId
 * @param {string} deps.cwd                     working directory of the parent run (the subagent's default)
 * @param {string} deps.parentProvider          provider id of the parent run (fallback for model references)
 * @param {string} [deps.parentModel]           the chat's model (`chat.model`, "" = its provider's default) — what a
 *                                              subagent without a model inherits at the chat's provider
 * @param {(provider:string) => string} [deps.defaultModel]  a provider's default model (registry: defaultModelFor)
 * @param {() => Array} deps.agentDefs          app-managed agent definitions ({name,description,body,tools,model,originProject,originProjectPath})
 * @param {() => Array} deps.hosts              possible providers ([{id,label,models:[{id,label}]}]) — for description and error hints
 * @param {(ref:string, fallback:string) => Object} deps.resolveRef   "[provider::]model" → {providerId, connector, model, unknownProvider}
 * @param {(names:string[], def?:Object) => Object} [deps.resolveSkills]  names → {skills:[{name,description,body}], missing:[], available:[]} — the catalog of the calling chat; `def` is the definition of the started type (a workspace agent brings along the workspace skills of its definition)
 * @param {(o:Object) => Object|Promise<Object>} deps.buildSpec run spec of the subagent (MCP config, permissions, directories …) — may
 *        be asynchronous (runs/agents.js reads the project memory; drive waits)
 * @param {(o:Object) => Promise} deps.runChat  provider dispatch (native CLI OR loop engine)
 * @param {(evt:Object) => void} deps.onEvent   event of the subagent (already with parent_tool_use_id)
 * @param {(rec:Object) => void} [deps.onStart]
 * @param {(rec:Object) => void} [deps.onFinish]
 * @param {(rec:Object) => void} [deps.onStatus]  the status of a LIVING agent changes without an event (parking, resuming)
 * @param {() => Array} [deps.forkTranscript]   history of the parent chat (for subagent_type "fork")
 * @param {string|((identifier:string|null) => string)} [deps.worktreeRoot]  root for isolation:"worktree" — a function
 *        returns it per instance IDENTIFIER (the worktrees of a copy live in a folder of their own, runs/runtime-location.js)
 * @param {() => Promise<Array<{name:string, relPath?:string, root:string}>>|Array} [deps.repoCandidates]
 *        the repos of the focus project — for isolation:"worktree" when the working folder is not a repo
 * @param {string} [deps.frame]                frame behind the role (default SUBAGENT_FRAME; "" = the caller appends it itself, see runs/agents.js agentSpecFactory)
 * @param {(identifier:string) => ({run:Function, teardown:Function}|null)} [deps.gitFor]  the management git of an instance
 */
export function createAgentRuntime({
  chatId,
  cwd,
  parentProvider = "",
  // What a subagent without a model inherits: the chat's model if it runs at the chat's provider, otherwise — or
  // without a chat model — its provider's default model. The default comes as a callback from the owner: the core stays
  // free of registry and database. Without the callback the connector default applies.
  parentModel = "",
  defaultModel = () => "",
  agentDefs = () => [],
  hosts = () => [],
  resolveRef,
  resolveSkills = null,
  buildSpec,
  runChat,
  onEvent = () => {},
  onStart = () => {},
  onFinish = () => {},
  onStatus = () => {},
  // A foreground agent has switched to the background (deadline or button) — for the display.
  onSwitch = () => {},
  forkTranscript = null,
  worktreeRoot = "",
  // The repos of the focus project: a project chat deliberately has the workspace as its working folder — if that is
  // not a repo, isolation:"worktree" branches off the project's one repo (or the one named with `repo`). A callback,
  // so the core stays free of database and registry (answer of git.js projectRepos).
  repoCandidates = () => [],
  frame = SUBAGENT_FRAME,
  // Limit parking per agent. `atLimit(agent, errorText, {attempts, sessionId})` decides after a failed turn:
  // `{ dueAt, resetsAt }` = park at the limit and resume at `dueAt`, `{ note }` = fail with this sentence in the
  // report, `null` = no limit. Without the callback the agent just fails.
  atLimit = null,
  // The alarm of the resumption — from the owner, so that it hangs on the SERVER RUN and not on this module. Returns a
  // function that switches it off again.
  wakeup = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
  // A resumption after the limit failed (also: its preparation threw) — for a row in the chat.
  atResumptionError = () => {},
  // The cap of concurrent subagents: counted by the OWNER per chat (runs/agents.js) — a core only sees its own agents,
  // the cap holds across all cores of the chat. Returns the error text if no slot is free, otherwise null. Asked BEFORE
  // the entry in `agents`, without an `await` in between — two concurrent starts cannot slip past the count.
  slotMissing = () => null,
  // The durable store: `remember(image)` gets an agent's state at every sign of life (start, session known, turn end,
  // parking, resuming, end), `row(agentId, row)` every new row of its history. From that the owner resumes it after a
  // restart or the idle clean-up (pickUp). Without a store it lives only in memory. A throw of the store never topples
  // the agent.
  deposit = null,
  // The credit gate before EVERY start: asked with the subagent's provider and model, returns the error text (or a
  // promise of it) if the gate is closed, otherwise null. Without the callback everyone starts, without a microtask of
  // delay (unit tests: the start is then synchronous up to the first turn).
  startGate = () => null,
  // The clock of the stall watchdog: from the owner, so that a test can advance it — `{ now(), wakeup(ms, fn) → off }`.
  stallClock = realClock,
  // Deadline and repetitions of the stall watchdog: `() => { deadlineMs, repetitions }`, read at EVERY turn. The
  // default is the subagents' (zero repetitions); workflow agents run workflowStallRule.
  stallRule = subagentStallRule,
  // The core's instance as an IDENTIFIER "<project>/<instance>" (runs/instance.js), null = none. A new agent carries
  // it in `rec.instance` and in its image; the spec factory resolves it — a picked-up agent keeps the one of its image,
  // even if the chat has switched projects in the meantime.
  instance = null,
  // The management git of an instance: `gitFor(identifier)` → `{ run(args, cwd) → Promise<{ ok, out, err, stands }>,
  // teardown(job) → Promise<{ removed, changed, postWork, error }> }` or null (no instance, the synchronous way). The
  // owner resolves the identifier (runs/agents.js); the core knows no project container. Asked only WITH an identifier.
  gitFor = () => null,
  // Consumption AFTER the end: an agent ended mid-turn settles before its process ends, and that reports the rest only
  // afterwards (Codex from the rollout, the engine in res.usage) — onFinish is over,
  // `atLateConsumption(agent, { increase, billing, provider, model })` books it.
  atLateConsumption = () => {},
} = {}) {
  if (typeof resolveRef !== "function") throw new Error("agent-runtime: resolveRef is missing");
  if (typeof buildSpec !== "function") throw new Error("agent-runtime: buildSpec is missing");
  if (typeof runChat !== "function") throw new Error("agent-runtime: runChat is missing");

  const agents = new Map();  // agentId -> rec
  let seq = 0;
  let closed = false;

  // ── Store ─────────────────────────────────────────────────────────────────────
  // The state in the table: an ended one is `finished` (failed and stopped included — status and originator stand
  // beside it), a parked one `parked`, everything else `running`. "orphaned" is only set by the restart (runs/agents.js).
  const stateOf = (rec) => (rec.settled ? "finished" : rec.status === "parked" ? "parked" : "running");
  // What a resumption needs, and no more: the history goes row by row (row), runtime things (child, waiters, alarm,
  // counters) not at all. The session: the last turn's, otherwise the one the running turn already reported.
  const pasteboardImage = (rec) => ({
    agentId: rec.agentId, name: rec.name, type: rec.type, description: rec.description, prompt: rec.prompt,
    provider: rec.provider, model: rec.model, ...(rec.effort ? { effort: rec.effort } : {}), sessionId: rec.sessionId || rec.sessionLive || "",
    state: stateOf(rec), status: rec.status, stoppedOf: rec.stoppedOf || "",
    background: rec.background, inheritContext: rec.inheritContext, cwd: rec.cwd, worktree: rec.worktree || null,
    ...(rec.worktreeRepo ? { worktreeRepo: rec.worktreeRepo } : {}),
    ...(rec.instance ? { instance: rec.instance } : {}), // only with an instance — without, the image stays byte-equal
    parentToolUseId: rec.parentToolUseId, outputFile: rec.outputFile, tools: rec.tools ?? null, skills: rec.skills,
    ...(rec.outputMissing ? { outputMissing: rec.outputMissing } : {}), // only if the file is missing — otherwise the image stays byte-equal
    systemPrompt: rec.systemPrompt, depth: rec.depth, parentAgent: rec.parentAgent, parentSet: rec.parentSet ?? null, ...(rec.mcp ? { mcp: rec.mcp } : {}),
    startedAt: rec.startedAt, endedAt: rec.endedAt, text: rec.text, error: rec.error, notes: rec.notes,
    toolUses: rec.toolUses, usage: rec.usage, billing: rec.billing,
    // A parked one carries when it continues: from that the restart sets its alarm again (pickUp). Only on a parked
    // one — every other row stays as it was.
    ...(rec.status === "parked" ? { parkedUntil: rec.parkedUntil, resetsAt: rec.resetsAt || 0, parkAttempts: rec.parkAttempts, ...supplyLaterImage(rec) } : {}),
    // The not yet booked consumption of a PARKED one (its turn ended at the limit, booking happens at its end) —
    // otherwise a restart would lose it. Only then; every other image stays byte-equal.
    ...(rec.status === "parked" && rec.open ? { open: rec.open } : {}),
  });
  // What a PARKED one still gets supplied later — only the messages to workflow agents (with `messageId`,
  // dynworkflows/message.js): a message promised for after its turn lived only in memory and was lost by a restart
  // during parking — the journal cannot tell whether it already went into the session in an earlier turn. Without
  // such entries the image stays byte-equal.
  function supplyLaterImage(rec) {
    const list = (rec.supplyLater || []).filter((e) => e?.messageId).map((e) => ({
      messageId: String(e.messageId), from: e.from === "human" ? "human" : "agent", raw: String(e.raw ?? ""), text: String(e.text ?? ""),
      ...(e.onResumption === true ? { onResumption: true } : {}),
    }));
    return list.length ? { supplyLater: list } : {};
  }
  const supplyLaterFromImage = (image) => (Array.isArray(image?.supplyLater) ? image.supplyLater : []).filter((e) => e?.messageId).map((e) => ({
    kind: "message", messageId: String(e.messageId), from: e.from === "human" ? "human" : "agent", raw: String(e.raw ?? ""), text: String(e.text ?? ""),
    ...(e.onResumption === true ? { onResumption: true } : {}),
  }));
  function create(rec) {
    if (!deposit?.remember) return;
    try { deposit.remember(pasteboardImage(rec)); } catch (e) { console.error("[agent] store:", e?.message || e); }
  }
  // Every row of the history goes through here: into the core's memory AND into the store.
  function rowValue(rec, row) {
    rec.rows.push(row);
    if (!deposit?.row) return;
    try { deposit.row(rec.agentId, row); } catch (e) { console.error("[agent] store (history):", e?.message || e); }
  }

  // Consumption NOW. drive() fills `rec.usage` only AFTER `await runChat`; the tally observes every event
  // (makeForward) and is the only value that grows live. After the end rec.usage applies again (for completion
  // providers it holds the connector's exact sums).
  const usageNow = (rec) => (rec.settled ? rec.usage : rec.tally.totals());
  // Is this number COMPLETE? Measured, not guessed from the provider name: the tally books an input side only if the
  // event carries a message.id (usage-tally.js addInput) or a whole turn arrives as `consumption` (Codex). The loop
  // engine reports its consumption as message_start WITHOUT an id — there the input stays uncounted and the sum is a
  // LOWER BOUND. A completion provider delivers exact sums at the end (billing "metered").
  const tokenKind = (rec) => {
    const u = usageNow(rec);
    return (u.input || 0) + (u.cached || 0) > 0 || (rec.settled && rec.billing === "metered") ? "full" : "only_output";
  };
  // The parts NOW (consumption.js tokenParts): the number shown is their sum without cache reads (tokenSum); the tree
  // of a dynamic workflow breaks all four down on hover. Only in publicRec — the report the model reads carries the
  // sum alone. Sent along only if something is counted.
  const partsNow = (rec) => tokenParts(usageNow(rec), rec.settled ? rec.billing : "");
  const withParts = (t) => (tokenSum(t) + t.cacheRead > 0 ? { tokenParts: t } : {});

  const publicRec = (rec) => {
    const parts = partsNow(rec);
    return {
      agentId: rec.agentId,
      name: rec.name,
      subagent_type: rec.type,
      description: rec.description,
      provider: rec.provider,
      // ONE spelling for the model in the whole app: bare model id or empty, the provider stands beside it. Whoever
      // wants to combine both does so at the display.
      model: rec.model,
      skills: rec.skills.map((s) => s.name),
      status: rec.status,
      // Only on a parked agent (status "parked"): when it continues and when the window is reset.
      ...(rec.status === "parked" ? { parkedUntil: rec.parkedUntil, resetsAt: rec.resetsAt || 0 } : {}),
      background: rec.background,
      cwd: rec.cwd,
      worktree: rec.worktree ? rec.worktree.dir : "",
      // The call this subagent belongs to (empty if only synthetic — then there is no block in the history a result
      // could be appended to).
      parentToolUseId: String(rec.parentToolUseId || "").startsWith("agent:") ? "" : rec.parentToolUseId,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      durationMs: (rec.endedAt || Date.now()) - rec.startedAt,
      tokens: tokenSum(parts),
      tokenKind: tokenKind(rec),
      ...withParts(parts),
      toolUses: rec.toolUses,
      outputFile: outputFile(rec),
      ...(rec.waitingForCpu && !rec.settled ? { waitingForCpu: true } : {}), // only while a command waits for CPU
    };
  };

  // ── Types & definitions ───────────────────────────────────────────────────────
  function defsByName() {
    const map = new Map();
    for (const d of agentDefs() || []) {
      const name = String(d?.name || "").trim();
      if (name) map.set(name.toLowerCase(), d);
    }
    return map;
  }

  // How a definition's skills would stand at the start — THE SAME resolution as loadSkills: `skills` names only what
  // the start loads; what it does not find is under `skillsMissing` (a start fails on it). Without a resolver the
  // start loads nothing (loadSkills throws), so every named name is missing then.
  function skillState(d) {
    const names = toolList(d?.skills);
    if (!names.length) return { skills: [], missing: [] };
    if (typeof resolveSkills !== "function") return { skills: [], missing: names };
    let r = {};
    try { r = resolveSkills(names, d) || {}; } catch { return { skills: [], missing: names }; }
    const missing = Array.isArray(r.missing) ? r.missing.map(String) : [];
    return { skills: names.filter((n) => !missing.includes(n)), missing };
  }

  /** Selectable agent types with description — for the tool description and error messages. */
  function listTypes() {
    const out = [];
    for (const [name, def] of Object.entries(BUILTIN_AGENT_TYPES)) {
      out.push({ name, description: def.description, builtin: true, model: "", tools: [] });
    }
    for (const d of agentDefs() || []) {
      if (!d?.name) continue;
      const state = skillState(d);
      out.push({
        name: String(d.name),
        description: String(d.description || "").replace(/\s+/g, " ").slice(0, 300),
        builtin: false,
        model: String(d.model || ""),
        tools: definitionsList(d) || [],
        skills: state.skills,
        ...(state.missing.length ? { skillsMissing: state.missing } : {}),
        originProject: d.originProject || "",
      });
    }
    return out;
  }

  const hostHint = () => {
    const list = hosts() || [];
    if (!list.length) return `Only this chat's provider ("${parentProvider}") is possible — leave model out.`;
    // A provider with a catalog (OpenRouter, `catalog: true`) names its short list and adds that every catalog model works.
    const catalog = list.filter((h) => h.catalog).map((h) => ` — at ${h.label} every catalog model with tools via ${h.id}::<id>`).join("");
    return `Possible: ${list.map((h) => (h.models || []).map((m) => `${h.id}::${m.id}`).join(", ")).filter(Boolean).join(", ")}`
      + `${catalog} — or a bare model id/tier for this chat's provider.`;
  };

  // ── Worktree isolation ────────────────────────────────────────────────────────
  // The counterpart of `isolation:"worktree"` of the Claude agent tool: the subagent works on a checkout of its own of
  // the same repo, so it can change files in parallel with other agents without colliding. An unchanged worktree is
  // removed again at the end.
  //
  // In a relocated project EVERY git of this section runs in the project container — asynchronously via `gitFor`
  // (`kg`). Creating: `makeWorktree(…, kg)` returns a promise (start() calls it BEFORE the await-free section).
  // Tearing down: as a job (runs/git-post-work.js) — awaited at the turn end before settle writes the report
  // (worktreeBeforeEnd), on the synchronous paths (stop, close) accepted and executed afterwards. Without an instance
  // everything is synchronous in the backend.
  const gitOf = (identifier) => (identifier ? gitFor(identifier) || null : null);
  // The worktree root per identifier — a string is the same for every instance, a function of the owner
  // (runs/agents.js) picks the folder of the main instance or of a copy. Without an identifier (no project container)
  // `null`: the root of the main instance.
  const rootFor = (identifier) => (typeof worktreeRoot === "function" ? worktreeRoot(identifier || null) : worktreeRoot);
  const containerStandsText = (where) => `The project container is stopped — ${where} only works once the project is running again (a new turn wakes it).`;

  async function worktreeInProject(agentId, repoRoot, kg, identifier = null) {
    const top = await kg.run(["rev-parse", "--show-toplevel"], repoRoot);
    if (top.stands) throw new Error(containerStandsText('isolation:"worktree"'));
    if (!top.ok || !top.out) throw new Error(`isolation:"worktree" needs a Git repository — ${repoRoot} is not one.`);
    const root = rootFor(identifier) || path.join(path.dirname(top.out), ".cbase-worktrees");
    // No mkdir in the backend: the container determines `top.out`, and the worktree root lies in the runtime folder
    // it describes — `worktree add` creates the missing folders itself, IN the project container.
    const dir = path.join(root, `agent-${agentId}`);
    const branch = `cbase/agent-${agentId}`;
    const base = (await kg.run(["rev-parse", "HEAD"], top.out)).out;
    const add = await kg.run(["worktree", "add", "-b", branch, dir, "HEAD"], top.out);
    if (!add.ok) throw new Error(`The worktree could not be created: ${add.err || add.out}`);
    // The LFS files of the fresh worktree, only in a repo with LFS files, with the credentials per host
    // (runs/git-post-work.js — never throws; if it fails, pointers stay as before).
    if (typeof kg.lfs === "function") await kg.lfs(dir);
    return { dir, branch, repo: top.out, base };
  }

  // The teardown job of a subagent worktree: unchanged gone including the branch, changed left standing (like releaseWorktree).
  const teardownJob = (wt, who = "subagent") => ({ who, worktrees: [{ repo: wt.repo, dir: wt.dir, branch: wt.branch, base: wt.base, deleteBranch: true }] });

  // A freshly created worktree whose start was then rejected (cap, run end, skill): back, as a job.
  function worktreeBack(wt, kg) {
    Promise.resolve().then(() => kg.teardown(teardownJob(wt, "subagent (start rejected)")))
      .then((r) => { if (r && !r.removed && !r.postWork) console.warn(`[agent] worktree of a rejected start stays: ${wt.dir} ${(r.error || []).join(" · ")}`); })
      .catch((e) => console.error("[agent] worktree of a rejected start:", e?.message || e));
  }

  // The end of a turn WITH instance and worktree: the teardown in the container, AWAITED before settle writes the
  // report — so the report says, as without an instance, whether the worktree stays. null without a worktree or
  // without an instance (then settle in the same tick). Never throws.
  function worktreeBeforeEnd(rec) {
    const wt = rec.worktree;
    if (!wt || rec.settled || rec.worktreeTeardown) return null;
    let kg = null;
    try { kg = gitOf(rec.instance); } catch { return null; } // the instance is not readable: settle stays without git (releaseWorktree)
    if (!kg) return null;
    const p = kg.teardown(teardownJob(wt)).then((r) => {
      if (rec.worktree !== wt) return;
      if (r.removed) {
        rec.worktree = null;
        rec.worktreeRepo = wt.repo; // a resumption creates a fresh one from it
        if (rec.settled) create(rec);
        return;
      }
      rec.worktreeNote = {
        wt,
        text: r.changed ? `Worktree with changes is left standing: ${wt.dir} (branch ${wt.branch}).`
          : r.postWork ? `Worktree is left standing for now: ${wt.dir} (branch ${wt.branch}) — the project container is stopped; it is checked and, if unchanged, removed at the next start of the project.`
            : `Worktree is left standing: ${wt.dir} (branch ${wt.branch}) — its teardown in the project container failed: ${(r.error || []).join(" · ")}`,
      };
    }).catch((e) => console.error("[agent] worktree at turn end:", e?.message || e));
    rec.worktreeTeardown = p;
    p.finally(() => { if (rec.worktreeTeardown === p) rec.worktreeTeardown = null; });
    return p;
  }

  // The end of a turn: without an instance exactly settle, in the same tick; with instance and worktree first worktreeBeforeEnd.
  function turnEnd(rec) {
    const finished = () => settle(rec, rec.killRequested ? "stopped" : "completed");
    const prior = worktreeBeforeEnd(rec);
    return prior ? prior.then(finished) : finished();
  }

  function makeWorktree(agentId, repoRoot, kg = null, identifier = null) {
    if (kg) return worktreeInProject(agentId, repoRoot, kg, identifier);
    const top = git(["rev-parse", "--show-toplevel"], repoRoot);
    if (!top.ok || !top.out) throw new Error(`isolation:"worktree" needs a Git repository — ${repoRoot} is not one.`);
    const root = rootFor(null) || path.join(path.dirname(top.out), ".cbase-worktrees");
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(root, `agent-${agentId}`);
    const branch = `cbase/agent-${agentId}`;
    const base = git(["rev-parse", "HEAD"], top.out).out;
    const add = git(["worktree", "add", "-b", branch, dir, "HEAD"], top.out);
    if (!add.ok) throw new Error(`The worktree could not be created: ${add.err || add.out}`);
    return { dir, branch, repo: top.out, base };
  }

  // Which repo is branched off: it is unambiguous if the working folder is a repo or the focus project has EXACTLY
  // one; otherwise the call throws with the list, and `repo` decides (name, relative path in the project or absolute
  // path). An unknown `repo` throws with the same list — never guessed.
  // The project repo is not a code repo: if the working folder is the project folder of a relocated project,
  // `rev-parse` reports its root — it counts as "no repo", and the branch comes from the project's code repos
  // (repoCandidates); it falls out of the list as well. A subagent never branches it off.
  // With an instance the project container determines the path (`--show-toplevel`), and the backend does not read its
  // `.git/config` (a FIFO there would halt the event loop, a link would read a backend file) — git asks for the marker
  // IN the container (`--type=bool`: the same truth values as git.js). Project repo exactly on success and "true"; if
  // the container is stopped, no worktree works.
  // A repo without a checked-in file (empty HEAD tree — the init of a project setup creates only an EMPTY commit) is
  // not a candidate: its worktree would be an empty folder without the untracked files of the main folder. The folder
  // stays readable in the main instance; if none is left or `repo` names exactly such a one, the error says so. Asked
  // only at the choice (isolation:"worktree"), never when resuming an already chosen repo.
  async function emptyTree(kg, root) {
    const r = kg ? await kg.run(["ls-tree", "--name-only", "HEAD"], root) : git(["ls-tree", "--name-only", "HEAD"], root);
    if (r?.stands) throw new Error(containerStandsText('isolation:"worktree"'));
    return Boolean(r?.ok) && !String(r?.out || "").trim();
  }
  async function projectRepoInContainer(kg, root) {
    const r = await kg.run(["config", "--local", "--type=bool", "--get", `${PROJECT_REPO_SECTION}.${PROJECT_REPO_KEY}`], root);
    if (r?.stands) throw new Error(containerStandsText('isolation:"worktree"'));
    return Boolean(r?.ok) && String(r?.out || "").trim() === "true";
  }
  async function selectRepo(repoArg, baseCwd, kg = null) {
    // With an instance: in the project container.
    const top = kg ? await kg.run(["rev-parse", "--show-toplevel"], baseCwd) : git(["rev-parse", "--show-toplevel"], baseCwd);
    if (top.stands) throw new Error(containerStandsText('isolation:"worktree"'));
    const markers = new Map(); // with an instance: ONE question to the container per root
    const inContainer = async (root) => {
      if (!markers.has(root)) markers.set(root, await projectRepoInContainer(kg, root));
      return markers.get(root);
    };
    const seen = new Set();
    const empty = []; // repos without a checked-in file
    let own = top.ok && top.out && !(kg ? await inContainer(top.out) : isProjectRepo(top.out)) ? top.out : "";
    if (own && await emptyTree(kg, own)) {
      empty.push({ name: path.basename(own), relPath: "", root: own });
      seen.add(own);
      own = "";
    }
    if (!repoArg && own) return own;
    let project = [];
    try { project = (await repoCandidates()) || []; } catch (e) { console.error("[agent] repos of the project:", e?.message || e); }
    const list = [];
    for (const r of [...(own ? [{ name: path.basename(own), relPath: "", root: own }] : []), ...project]) {
      const root = String(r?.root || "");
      if (!root || seen.has(root) || (kg ? await inContainer(root) : isProjectRepo(root))) continue;
      seen.add(root);
      const entry = { name: String(r.name || path.basename(root)), relPath: String(r.relPath || ""), root };
      if (root !== own && await emptyTree(kg, root)) { empty.push(entry); continue; }
      list.push(entry);
    }
    const emptySet = () => (empty.length
      ? ` Without a checked-in file (no worktree possible, the folder is readable in the main instance): ${empty.map((r) => `"${r.name}" (${r.root})`).join(", ")}.`
      : "");
    const enumeration = () => (list.length
      ? `Repos: ${list.map((r) => `"${r.name}" (${r.root})`).join(", ")}.${emptySet()}`
      : empty.length ? emptySet().trim() : `Neither ${baseCwd} nor this chat's project contains a Git repository.`);
    const matches = (r) => r.name === repoArg || (r.relPath && r.relPath === repoArg) || r.root === repoArg || path.resolve(r.root) === path.resolve(baseCwd, repoArg);
    if (repoArg) {
      const hits = list.find(matches);
      if (!hits && empty.some(matches)) throw new Error(`The repo "${repoArg}" has no checked-in file yet — a worktree of it would be empty.${emptySet()}`);
      if (!hits) throw new Error(`Unknown repo "${repoArg}". ${enumeration()}`);
      return hits.root;
    }
    if (list.length === 1) return list[0].root;
    if (!list.length && empty.length) throw new Error(`isolation:"worktree" does not work here — no repo has a checked-in file.${emptySet()}`);
    if (!list.length) throw new Error(`isolation:"worktree" needs a Git repository — ${baseCwd} is not one, and this chat's project has none.`);
    throw new Error(`isolation:"worktree" is ambiguous here — state with repo which repo is branched off. ${enumeration()}`);
  }

  // A subagent's effort level: only the levels of the order — never "ultracode" (a mode of the chat, not a level).
  // Empty or missing = not stated. Clamped only at the spawn, to ITS model (runs/agents.js).
  function levelFromArgument(value) {
    if (value === undefined || value === null || value === "") return "";
    const verdict = effortSavable(value);
    if (verdict.kind === "level") return verdict.level;
    throw new Error(`Unknown level "${String(value).slice(0, 40)}" for effort — allowed are ${EFFORT_LEVELS.join(", ")}`
      + " (ultracode is a mode of the chat, not a level). Without effort the subagent thinks at its caller's level.");
  }

  // Unchanged = remove without a trace; changed = leave standing and name it in the report (the agent's work must not
  // be cleared away just because the run ends).
  function releaseWorktree(rec) {
    const wt = rec.worktree;
    if (!wt) return "";
    // With an instance no git here — the teardown already ran at the turn end (worktreeBeforeEnd, its note) or goes
    // into the project container as a job now (stop, close: synchronous, without waiting).
    const kg = gitOf(rec.instance);
    if (kg) {
      const note = rec.worktreeNote;
      rec.worktreeNote = null;
      if (note && note.wt === wt) return note.text;
      const text = `Worktree ${wt.dir} (branch ${wt.branch}) is being checked in the project container: unchanged it is removed, with changes it is left standing.`;
      if (!rec.worktreeTeardown) {
        const p = kg.teardown(teardownJob(wt)).then((r) => {
          if (r.removed && rec.worktree === wt) { rec.worktree = null; rec.worktreeRepo = wt.repo; create(rec); }
        }).catch((e) => console.error("[agent] worktree teardown:", e?.message || e));
        rec.worktreeTeardown = p;
        p.finally(() => { if (rec.worktreeTeardown === p) rec.worktreeTeardown = null; });
      }
      return text;
    }
    const dirty = git(["status", "--porcelain"], wt.dir);
    // The agent's own commits count just like uncommitted changes: both are work an automatic clean-up would destroy.
    const ahead = wt.base ? git(["rev-list", "--count", `${wt.base}..HEAD`], wt.dir) : { ok: false, out: "0" };
    const changed = Boolean(dirty.out) || (ahead.ok && Number(ahead.out) > 0);
    if (changed) return `Worktree with changes is left standing: ${wt.dir} (branch ${wt.branch}).`;
    git(["worktree", "remove", "--force", wt.dir], wt.repo);
    git(["branch", "-D", wt.branch], wt.repo);
    rec.worktree = null;
    // The repo stays noted: a resumption (send) creates a fresh worktree from it.
    rec.worktreeRepo = wt.repo;
    return "";
  }

  // Before the new process of a resumption: the folder it continues in must exist. An unchanged worktree was removed
  // at its end (releaseWorktree) — then a fresh one from the same repo, at the same place (the CLI's session hangs on
  // the path). If that fails, or another working folder is missing: a rejection that names the reason — never silently
  // in a missing folder. With an instance the fresh worktree is created in the project container — then a promise
  // (send waits), otherwise null.
  function folderForResumption(rec) {
    if (rec.cwd && fs.existsSync(rec.cwd)) return null;
    const fresh = "Start it anew with cbase_agent if the subtask is still needed.";
    const kg = rec.worktreeRepo ? gitOf(rec.instance) : null;
    if (kg) {
      return makeWorktree(rec.agentId, rec.worktreeRepo, kg, rec.instance).then((wt) => { rec.worktree = wt; rec.cwd = wt.dir; }, (e) => {
        throw new Error(`Subagent "${rec.agentId}" cannot be resumed: its worktree was removed at its end (unchanged),`
          + ` and a new one could not be created from ${rec.worktreeRepo} in the project container — ${String(e?.message || e)} ${fresh}`);
      });
    }
    if (rec.worktreeRepo) {
      try {
        rec.worktree = makeWorktree(rec.agentId, rec.worktreeRepo);
        rec.cwd = rec.worktree.dir;
        return null;
      } catch (e) {
        throw new Error(`Subagent "${rec.agentId}" cannot be resumed: its worktree was removed at its end (unchanged),`
          + ` and a new one could not be created from ${rec.worktreeRepo} — ${String(e?.message || e)} ${fresh}`);
      }
    }
    throw new Error(`Subagent "${rec.agentId}" cannot be resumed: its working folder ${rec.cwd || "(none)"} no longer exists. ${fresh}`);
  }

  // ── One subagent ──────────────────────────────────────────────────────────────
  // Provider and model of a start — BEFORE the record, because the credit gate asks for the SUBAGENT's provider, not
  // the chat's. The ONE resolution: gate, record (`rec.model`), spawn (buildSpec), level clamp, consumption and report
  // (`resolvedModel`) all read this result, nobody resolves again.
  //
  // `inherit` is the caller — the chat or (depth ≥ 2) the calling subagent: `{ provider, model }`. A reference without
  // a prefix applies to ITS provider; if the reference names no model (neither argument nor agent type nor the part
  // behind "provider::"), the subagent inherits the caller's model if it runs at the caller's provider, otherwise its
  // provider's default model. (Leaving the gap to the connector spawned models the chat never chose.)
  function resolveModel(ref, inherit = { provider: parentProvider, model: parentModel }) {
    const r = resolveRef(String(ref || ""), inherit.provider);
    if (!r || !r.connector) throw new Error(`Model "${ref}" cannot be resolved. ${hostHint()}`);
    if (r.unknownProvider) throw new Error(`Unknown provider in model "${ref}". ${hostHint()}`);
    if (parseModelRef(ref).model) return { provider: r.providerId, model: r.model || "" };
    const inherited = (r.providerId === inherit.provider && String(inherit.model || "")) || String(defaultModel(r.providerId) || "");
    if (!inherited) return { provider: r.providerId, model: r.model || "" };
    // Through the connector like every named model (tiers, aliases, modelMap) — idempotent for a finished id.
    return { provider: r.providerId, model: resolveRef(formatModelRef(r.providerId, inherited), inherit.provider)?.model || inherited };
  }

  // Load skills IN FULL: argument ∪ definition, in order of mention, without duplicates. A name the caller's catalog
  // does not know is an ERROR — not silently dropped: the main agent would otherwise have a subagent without the guide
  // it believed it had equipped it with, and nobody would look for it because nothing is missing.
  // Resolved with the definition: a workspace agent brings along the workspace skills it names — the same resolution
  // describes the type (listTypes, the selection in the system prompt).
  function loadSkills(argNames, def) {
    // First the definition (the type's basic equipment), then the call (what this task needs in addition) — so the
    // role stands before the supplement.
    const names = [...new Set([...toolList(def?.skills), ...toolList(argNames)])];
    if (!names.length) return [];
    if (typeof resolveSkills !== "function") throw new Error(`Skills are not available in this run (requested: ${names.join(", ")}).`);
    const r = resolveSkills(names, def) || {};
    const missing = Array.isArray(r.missing) ? r.missing : [];
    if (missing.length) {
      const avail = Array.isArray(r.available) && r.available.length ? ` Available in this chat: ${r.available.join(", ")}.` : " No skill is available in this chat.";
      throw new Error(`Skill${missing.length > 1 ? "s" : ""} "${missing.join("\", \"")}" not found.${avail}`);
    }
    return (Array.isArray(r.skills) ? r.skills : []).map((s) => ({ name: String(s.name), description: String(s.description || ""), body: String(s.body || "") }));
  }

  // Mirror the subagent's events into the parent stream. Filtered is what would confuse the bookkeeping of the
  // PARENT RUN:
  //   • `result`        ends a turn there (resultsSeen/turnActive) — but the subagent has not ended a turn of the
  //                     main agent.
  //   • `system/*`      is the lifecycle of ITS process (init, task_*): the parent run would book foreign task ids as
  //                     its own background work.
  //   • token events (message_start/message_delta/consumption): its consumption is reported ONCE at the end (usage),
  //                     otherwise the run tally would count it a second time.
  // Everything else (text and thinking deltas, tool calls, tool results) passes with parent_tool_use_id — web and iOS
  // client render that indented under the call.
  function makeForward(rec) {
    return (evt) => {
      if (!evt || typeof evt !== "object") return;
      try { rec.watchdog?.observe(evt); } catch { /* the watchdog must never disturb a subagent */ }
      try { rec.tally.observe(evt); } catch { /* counting must never disturb a subagent */ }
      if (evt.type === "result") {
        // A LATER result of the same process: if a background command ends while the last model request is running, it
        // is already finished at the first result (no stop_task), but its notice to the model is pending — and the CLI
        // runs it right afterwards as a turn of its own, with stdin open or closed (it cannot be prevented at the end).
        // That text is a reaction to the notice, not the report: it is not taken over, and neither is its error mark
        // (the task was done). Exception: if a message was accepted mid-turn (`rec.controlled`), the later result can
        // be its answer — then it counts.
        rec.results = (rec.results || 0) + 1;
        if (rec.results > 1 && !rec.controlled?.length) {
          try { rec.child?.cbaseEndInput?.(); } catch { /* process already dead */ }
          return;
        }
        // The subagent is done with its turn. Native CLIs and the engine keep the input open afterwards (monitor/alarm
        // semantics of the main chat) — but a subagent has exactly ONE turn, so close explicitly here, otherwise
        // runChat never returns.
        //
        // The turn's ERROR MARK goes along. The event (rightly) does not go into the parent stream, so for a subagent
        // that died at the limit this is the ONLY channel through which the wording gets up. drive() reads the mark
        // after runChat and lets the run fail on it — even with exit 0, because the CLI survives a limit, closes the
        // turn and waits for the next input.
        const error = resultError(evt);
        if (error) rec.turnError = error;
        // `result` is the report — unless it IS the error message (CLI success variant with is_error): that belongs
        // in `error`, not as a "report" with the wrong label in the history. A partial text beside an engine error
        // mark is kept, however.
        if (typeof evt.result === "string" && evt.result.trim() !== error) rec.text = evt.result;
        try { rec.child?.cbaseEndInput?.(); } catch { /* process already dead */ }
        return;
      }
      const cpu = cpuWaitFrom(evt); // is a Bash command waiting for CPU (hook or engine, mcp/cpu-saver.js)? A change reports the row.
      if (cpu !== null && cpu !== Boolean(rec.waitingForCpu)) {
        rec.waitingForCpu = cpu;
        try { onStatus(publicRec(rec)); } catch { /* the display must never disturb the agent */ }
      }
      if (evt.type === "system") {
        // The session is in the first event (Claude `system/init`, Codex `thread.started` → init, engine systemInit) —
        // stored at once: a crash in the middle of the first turn should leave it resumable. `rec.sessionId` stays as
        // it was until the turn end (drive and limit parking read it).
        if (evt.session_id && evt.session_id !== rec.sessionLive) { rec.sessionLive = String(evt.session_id); create(rec); }
        return;
      }
      if (evt.type === "stream_event" && ["message_start", "message_delta", "consumption"].includes(evt.event?.type)) return;
      let out = evt;
      if (evt.type === "assistant" && evt.message?.usage) {
        const { usage, ...message } = evt.message;
        out = { ...evt, message };
      }
      // Record the history (in the row shape of store.listMessages) — from it `send` builds the resumption of a
      // provider without a real --resume.
      recordRows(rec, evt);
      onEvent(withParent(out, rec.parentToolUseId));
    };
  }

  function recordRows(rec, evt) {
    if (rec.rows.length > TRANSCRIPT_CAP) return;
    if (evt.type === "assistant") {
      for (const b of evt.message?.content ?? []) {
        if (b?.type === "text" && String(b.text || "").trim()) rowValue(rec, { role: "assistant", text: String(b.text) });
        else if (b?.type === "tool_use") {
          rec.toolUses += 1;
          rowValue(rec, { role: "tool", text: JSON.stringify({ name: b.name, id: b.id, input: b.input || {} }) });
        }
      }
      return;
    }
    if (evt.type === "user") {
      for (const b of evt.message?.content ?? []) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const text = Array.isArray(b.content)
          ? b.content.map((c) => (typeof c === "string" ? c : c?.text ?? (c?.type === "image" ? "[Image]" : ""))).join("")
          : String(b.content ?? "");
        rowValue(rec, { role: "tool_result", text: JSON.stringify({ id: b.tool_use_id, result: clip(text, 24_000), isError: Boolean(b.is_error) }) });
      }
    }
  }

  // Write out the subagent's full history (counterpart of the Claude CLI's `output_file`). In a project's runtime
  // folder through the descriptor (runs/runtime-write.js): the project container mounts it rw, and a link there would
  // let the backend write the output somewhere else — with the task as content. If the path leads outside, no file is
  // created (convenience, see below).
  function writeOutputFile(rec) {
    if (!rec.outputFile) return;
    try {
      const head = [
        `# Subagent ${rec.agentId} (${rec.type || "general-purpose"})`,
        `Provider: ${rec.provider}   Model: ${rec.model || "(default)"}`,
        `Skills: ${rec.skills.length ? rec.skills.map((s) => s.name).join(", ") : "(no)"}`,
        `Directory: ${rec.cwd}`,
        `Task:\n${rec.prompt}`,
        "",
        "## History",
      ].join("\n");
      const body = rec.rows.map((r) => `[${r.role}] ${r.text}`).join("\n");
      const text = `${head}\n${body}\n\n## Report\n${rec.text || "(no Report)"}\n`;
      if (!writeInRuntimeFolder(rec.outputFile, text)) {
        fs.mkdirSync(path.dirname(rec.outputFile), { recursive: true });
        fs.writeFileSync(rec.outputFile, text);
      }
      rec.outputMissing = ""; // a later successful write takes the mark back
    } catch (e) {
      // The file is convenience, not a contract — but its absence must be said: otherwise report and list would name
      // the path of a file that does not exist, and the main agent would read into the void. So: warning, mark
      // `outputMissing`, one sentence in the notes, and `outputFile` is empty there.
      const code = e?.code || e?.message || String(e);
      console.warn(`[agent] output file of ${rec.agentId} not written (${code}): ${rec.outputFile}`);
      rec.outputMissing = String(code);
      const set = `Output file not written (${code}): ${rec.outputFile}`;
      if (!String(rec.notes || "").includes(set)) rec.notes = rec.notes ? `${rec.notes}\n${set}` : set;
    }
  }
  // What report and list name as the output file: the path only if the file was written.
  function outputFile(rec) { return rec.outputMissing ? "" : rec.outputFile; }

  // Drive one turn of this subagent (first task OR resumption via send).
  async function drive(rec, input) {
    rec.status = "running";
    rec.child = null;
    rec.turnError = ""; // error mark of THIS turn (makeForward sets it at the result event)
    rec.results = 0; // results of the running process (makeForward: a later one is a notice turn)
    rec.controlled = []; // what is delivered into the middle of THIS turn (see readjust, restart below)
    // Providers without a real --resume need the history; at the first turn possibly the chat's (fork). Computed ONCE
    // per turn: a restart of the turn takes the same history (the rows of the killed attempt do not belong in it).
    const history = rec.sessionId
      ? buildTranscript(rec.rows, { contextWindow: 0, dropTrailingUser: false })
      : (rec.inheritContext && typeof forkTranscript === "function" ? forkTranscript() : []);
    // The input can grow between two attempts of THE SAME turn (see below).
    let inputValue = rec.beforeStart.length ? [input, ...rec.beforeStart.splice(0).map((e) => e.beforeStartText || e.text)].join("\n\n") : input;
    // The extended input IS the task of this turn — if it parks at the limit before the first answer (without a
    // session), the resumption (further) takes `lastInput`; the messages are already out of `beforeStart`.
    if (inputValue !== input) rec.lastInput = inputValue;
    const buildSpecValue = () => buildSpec({
      agentId: rec.agentId,
      systemPrompt: rec.systemPrompt,
      input: inputValue,
      provider: rec.provider,
      model: rec.model,
      effort: rec.effort,
      cwd: rec.cwd,
      tools: rec.tools,
      skills: rec.skills,
      sessionId: rec.sessionId,
      inheritContext: rec.inheritContext,
      depth: rec.depth,
      parentSet: rec.parentSet, mcp: rec.mcp || null, // the coding MCP servers of the type (contract.js mcpOfTheType)
      instance: rec.instance || null, // the identifier of its instance (the factory resolves it)
      // The schema of an agent(prompt, {schema}) (workflow agents only) — every turn, also a resumption.
      structure: rec.structure || null,
      transcript: history,
    });
    // Asynchronous: the project memory of a copy is read by its container. In that time a message can arrive before
    // the first process (control → `beforeStart`, `inTurn` is not set yet) — it belongs in THIS input like the ones
    // before (above); otherwise it would lie until the agent ends and go back as undelivered.
    // In every `await buildSpecValue()` it can be stopped, aborted or its core closed (settle has already run) — then
    // NO process starts any more; otherwise a stopped agent would still spawn.
    const past = () => rec.killRequested || rec.settled || closed;
    let spec = await buildSpecValue();
    if (past()) return undefined;
    while (rec.beforeStart.length) {
      inputValue = [inputValue, ...rec.beforeStart.splice(0).map((e) => e.beforeStartText || e.text)].join("\n\n");
      rec.lastInput = inputValue; // see above
      spec = await buildSpecValue();
      if (past()) return undefined;
    }
    // The stall watchdog applies to THIS turn: from now until runChat returns — a parked agent has no process and no
    // clock. Subagents: zero repetitions, a stall ends the agent as failed. Workflow agents: every stall up to the
    // number of repetitions ends only the PROCESS, and the same turn starts anew — the same input, the session from
    // before the turn (a hanging call is not resumed); only the stall after that gives up. The clock keeps running
    // across the restarts (one watchdog per turn). The same path carries the restart by the human (`restart`):
    // `rec.restart` says who wanted it ("stall" | "human") — only the stall watchdog counts its repetitions.
    const { deadlineMs: deadline, repetitions } = stallRule();
    const sessionPrior = rec.sessionId;
    rec.restart = "";
    rec.watchdog = createStallWatchdog({
      deadlineMs: deadline, repetitions, clock: stallClock,
      atStall: () => {
        if (rec.settled || rec.killRequested) return;
        rec.restart = "stall";
        try { rec.child?.kill?.("SIGTERM"); } catch { /* already dead */ }
      },
      atTask: () => stallAbort(rec, deadline),
    });
    let res;
    // The consumption of ALL attempts of this turn: a restart (stall watchdog, human) overwrites `res`, but the killed
    // attempt has paid rounds behind it — the loop engine delivers them in `res.usage` even on abort.
    let attempts = null;
    rec.inTurn = true;
    try {
      for (;;) {
        res = await runChat({
          providerId: rec.provider,
          spec,
          onEvent: rec.forward,
          // A process that already finds a restart signal at the spawn does not count as the first (see control: "earmark").
          onSpawn: (child) => { rec.child = child; if (rec.killRequested || rec.restart) { try { child.kill?.("SIGTERM"); } catch {} } else rec.firstProcess = true; },
        });
        attempts = consumptionPlus(attempts, res?.usage);
        if (!rec.restart || rec.killRequested || closed) break;
        if (rec.restart === "stall") rec.stallRestarts = (rec.stallRestarts || 0) + 1;
        else if (rec.restart === "human") rec.handRestarts = (rec.handRestarts || 0) + 1;
        rec.restart = "";
        // The new attempt begins with the session from BEFORE the turn — it does not know what was delivered into the
        // middle of the killed attempt; that goes to its input, as does what was earmarked before the first process
        // (the restart "earmark", see control).
        const addition = [...rec.controlled.splice(0), ...rec.beforeStart.splice(0)].map((e) => e.beforeStartText || e.text).filter(Boolean);
        if (addition.length) {
          inputValue = [inputValue, ...addition].join("\n\n");
          rec.lastInput = inputValue;
          spec = await buildSpecValue();
          if (past()) break; // stopped while the new attempt was being built
        }
        rec.child = null;
        rec.turnError = "";
        rec.results = 0;
        rec.text = "";
        rec.sessionId = sessionPrior;
        rec.sessionLive = "";
        // An open call of the killed process never closes — otherwise the clock would stand for the rest of the turn.
        rec.watchdog.newProcess();
      }
    } finally {
      rec.restart = "";
      rec.inTurn = false;
      rec.watchdog.end();
    }
    rec.sessionId = res?.sessionId || rec.sessionId;
    // The same boundary as in makeForward: the connector stores `resultText` from the result event even if that was
    // the error message — that is then in `error`, not in the report. Only if no result event came through
    // makeForward: the connector holds the LAST result — after a notice turn its text, which makeForward did not
    // take as the report.
    if (!rec.results && typeof res?.resultText === "string" && res.resultText.trim() && res.resultText.trim() !== rec.turnError) rec.text = res.resultText;
    rec.stderr = String(res?.stderr || "").slice(-2000);
    // Tokens: completion providers deliver exact sums, native CLIs only the event stream (tally) — BEFORE the error
    // check. Two states: `rec.usage` over ALL turns (image, budget, outer loop), `rec.open` since the last booking
    // (settle → onFinish → runs/agents.js; a resumption would otherwise book the whole sum again). The costs (USD) in
    // both are all or nothing (`consumptionPlus`); a turn without a complete report makes only ITS booking unknown.
    if (attempts && (attempts.input || attempts.output || attempts.costMissing)) {
      rec.usage = consumptionPlus(rec.usage, attempts);
      rec.open = consumptionPlus(rec.open, attempts);
      rec.billing = "metered";
    } else if (rec.billing !== "metered") {
      counterFold(rec);
    }
    // Already ended (settle ran while the process was still ending): bookLate books the rest; an agent resumed in the
    // meantime is no longer settled, its rest goes with the next booking.
    if (rec.settled) bookLate(rec);
    // The run has failed if the process ended with exit ≠ 0 OR its result event was marked as an error. runChat does
    // not throw on exit ≠ 0 (runChatClaude resolves with {code, stderr}, the engine likewise) — without this check a
    // subagent that died at the usage limit would settle as finished with an empty report, the wording only in
    // rec.stderr. We throw so that the same .catch applies as for a provider that throws itself: ONE error path
    // (rec.error, status "failed", note), not two.
    // A deliberate stop is not an error — stop() has already written its result, and exit 143 after SIGTERM must not
    // overwrite it.
    // The message carries the WORDING (the turn's error mark, plus the last stderr lines — at the CLI the reset time
    // is there): the parent run reads the report with detectLimitHit, and what is not in the message it cannot
    // recognise.
    create(rec); // turn end: session, report, consumption
    if (!rec.killRequested && (rec.turnError || (res && res.code !== 0))) {
      const stderrTail = String(res?.stderr || "").trim().split("\n").filter(Boolean).slice(-3).join("\n");
      const parts = [rec.turnError, stderrTail].filter((t, i, a) => t && a.indexOf(t) === i);
      throw new Error(parts.join("\n") || `Exit ${res?.code}`);
    }
    // The turn at the new place is confirmed — the factory (runs/agents.js) clears away the old copies of the session
    // if the same turn continued the same session. A stopped turn confirms nothing.
    if (!rec.killRequested && typeof spec.confirmSession === "function") {
      try { spec.confirmSession(res?.sessionId); } catch (e) { console.warn(`[agent] ${rec.agentId}: old session copy not removed: ${e?.message || e}`); }
    }
    return res;
  }

  // Drive a turn and afterwards what was supplied later (cbase_agent_send to a running agent that does not accept the
  // message mid-turn — Codex, or it only just started): as a resumption of THE SAME session, before it ends. Then
  // `completion`: from here no turn accepts anything any more — a message waits for the end.
  // Supplying later is a NEW process: it asks the credit gate like a start. If the gate is closed, the agent ends with
  // the report of its turn, and what was supplied goes to the main agent via settle — with the reason. The override
  // ("start anyway") is carried by the entry that brought it (send), otherwise the core's applies.
  async function run(rec, input) {
    await drive(rec, input);
    while (rec.supplyLater.length && !rec.killRequested && !closed) {
      const locked = await gateVerdict(rec, rec.supplyLater.some((e) => e.overruled === true) ? true : undefined);
      if (locked) { rec.supplyLaterReason = locked; break; }
      if (rec.killRequested || closed) break;
      const n = rec.supplyLater.splice(0).map((e) => e.text).join("\n\n");
      rowValue(rec, { role: "user", text: n });
      rec.lastInput = n;
      rec.text = "";
      await drive(rec, n);
    }
    rec.completion = true;
  }

  // Subscription: the counter counts over the core's life — only its increase since the last fold is added (a metered
  // agent without consumption does not switch to the counter). Folded at the turn end (drive) and in settle when it
  // ends MID-turn.
  function counterFold(rec) {
    const t = rec.tally.totals();
    const fresh = tokenIncrease(rec.counterStatus, t);
    rec.counterStatus = t;
    rec.usage = subscriptionPlus(rec.usage, fresh);
    rec.open = subscriptionPlus(rec.open, fresh);
    rec.billing = "subscription";
  }

  function bookLate(rec) { // see option atLateConsumption; afterwards `open` begins at zero
    const z = rec.open;
    rec.open = null;
    if (!z || (!z.input && !z.output && !z.cached && !z.costMissing)) return;
    const info = { increase: { input: 0, output: 0, cached: 0, ...z }, billing: rec.billing, provider: rec.provider, model: rec.model };
    try { atLateConsumption(publicRec(rec), info); } catch { /* the booking must not topple anything */ }
  }

  function settle(rec, status, note = "") {
    if (rec.settled) return;
    // Ended mid-turn (stop, stall, close): fold the counter NOW — onFinish books it, the rest is booked late.
    if (rec.inTurn && rec.billing !== "metered") counterFold(rec);
    rec.completion = false;
    // What was supplied to it but never delivered (it failed, was stopped, the gate was closed before supplying) does
    // not go into the void: it travels with onFinish to the owner, who delivers it to the main agent. Taken out here,
    // it arrives over no later path again (a resumption begins with an empty list).
    const reason = rec.supplyLaterReason || "";
    const undelivered = [...rec.supplyLater.splice(0), ...(rec.beforeStart || []).splice(0)].map((e) => ({ ...e, ...(reason ? { reason } : {}) }));
    rec.supplyLaterReason = "";
    // A parked agent that ends now (stop, close, run end) takes its alarm with it.
    wakeupOff(rec);
    rec.parkedUntil = 0;
    rec.settled = true;
    rec.status = status;
    rec.endedAt = Date.now();
    let extra = note;
    try { const w = releaseWorktree(rec); if (w) extra = extra ? `${extra}\n${w}` : w; } catch { /* worktree clean-up must never throw */ }
    if (extra) rec.notes = rec.notes ? `${rec.notes}\n${extra}` : extra;
    writeOutputFile(rec);
    create(rec);
    // Its living FOREGROUND children lose the call that waited for them: the same transition as at the turn end, one
    // notice per child (onSwitch) — BEFORE its own end, so that the bar never shows the children with the mark of a
    // call that no longer exists. Not when the core closes: there all end.
    if (!closed) {
      for (const kind of [...agents.values()]) {
        if (kind.parentAgent === rec.agentId && !kind.settled && !kind.background) toBackground(kind, "parent-end");
      }
    }
    // If a call waited for the report, it has it now — then the server must NOT deliver it again as a new turn
    // (otherwise the same report would be in the run twice).
    const waiters = rec.waiters.splice(0);
    const rep = report(rec);
    for (const w of waiters) w(rep);
    // What came since the last booking (see drive) — and nothing more from here: the next booking begins at zero.
    const increase = { input: 0, output: 0, cached: 0, ...(rec.open || {}) };
    rec.open = null;
    try {
      onFinish(publicRec(rec), {
        // `usage`: the sum over all turns (budget, outer loop); `increase`: what is to be BOOKED (runs/agents.js).
        usage: { ...rec.usage }, increase, billing: rec.billing, provider: rec.provider, model: rec.model,
        delivered: waiters.length > 0, report: rep,
        // Supplied later without delivery (see above): `{ text, kind: "report"|"message", report?, reason? }`.
        undelivered,
        // Stopped (human, main agent, run end, deletion): the owner delivers no completion notice for it. A stall
        // abort ends through the same stop but is "failed" — its completion notice comes.
        stopped: rec.killRequested === true && rec.status === "stopped",
      });
    } catch { /* the server must not topple the agent */ }
  }

  function wakeupOff(rec) {
    const out = rec.wakeupOff;
    rec.wakeupOff = null;
    if (out) { try { out(); } catch { /* an alarm must not topple the end */ } }
  }

  // A turn has failed. At the usage limit (atLimit) the agent PARKS itself — the chat gets no waiting row, the parent
  // run does not park along. Otherwise it ends as "failed".
  async function fail(rec, e) {
    rec.completion = true; // until parked or ended: a message waits for the end (see run)
    rec.error = String(e?.message || e);
    let note = "";
    if (typeof atLimit === "function" && !rec.killRequested && !closed && !rec.settled) {
      let choice = null;
      try { choice = await atLimit(publicRec(rec), rec.error, { attempts: rec.parkAttempts, sessionId: rec.sessionId }); }
      catch (err) { console.error("[agent] limit check failed:", err?.message || err); }
      if (choice?.dueAt && !rec.killRequested && !closed && !rec.settled) return park(rec, choice);
      note = String(choice?.note || "");
    }
    if (rec.resumed) {
      try { atResumptionError(publicRec(rec), rec.error); } catch { /* the row must not topple the end */ }
    }
    // With instance and worktree first the teardown in the container (see turnEnd); without, the same tick.
    const beforeEnd = worktreeBeforeEnd(rec);
    if (beforeEnd) await beforeEnd;
    settle(rec, rec.killRequested ? "stopped" : "failed", [`Error: ${rec.error}`, note].filter(Boolean).join("\n"));
  }

  // Parking: no process, no report, an alarm. The agent stays alive (not settled) — it counts as open background
  // work, keeps a holding turn open and occupies its slot under the chat's cap.
  function park(rec, { dueAt, resetsAt = 0 }) {
    rec.completion = false; // the resumption after the reset takes along what was supplied later (run)
    rec.status = "parked";
    rec.child = null;
    rec.parkedUntil = Number(dueAt) || Date.now();
    rec.resetsAt = Number(resetsAt) || 0;
    rec.parkAttempts += 1;
    // Whoever waits for the report (foreground call, cbase_agent_output) does not sit out the waiting time — they
    // learn now that the report only comes after the reset, and by itself (delivered like a background report).
    // A foreground agent is a background one from here: its waiting call returns, so nobody waits for it any more —
    // the same transition as deadline and button, including onSwitch (that is then also the notice).
    const switched = toBackground(rec, "parking");
    for (const w of rec.waiters.splice(0)) w(parked(rec));
    wakeupOff(rec);
    rec.wakeupOff = wakeup(Math.max(0, rec.parkedUntil - Date.now()), () => further(rec));
    create(rec);
    // One event per transition: if the switch has already reported, parking does not report again.
    if (!switched) { try { onStatus(publicRec(rec)); } catch { /* the display must not topple parking */ } }
  }

  // After the reset: resume the same session. WITH a safety net — what throws here (the turn's preparation) becomes a
  // failed report plus a row in the chat, not a process end.
  function further(rec) {
    rec.wakeupOff = null;
    if (rec.settled || closed || rec.killRequested) return;
    rec.parkedUntil = 0;
    rec.resetsAt = 0;
    rec.resumed = true;
    try {
      // With a session: resume where it stood. Without (the limit already hit the first request): the same task again.
      // What was earmarked for it while parked (control) hangs on THIS input — not as a turn of its own afterwards.
      const earmarked = rec.supplyLater.filter((e) => e.onResumption === true);
      if (earmarked.length) rec.supplyLater = rec.supplyLater.filter((e) => e.onResumption !== true);
      const input = [rec.sessionId ? RESUMPTION_AFTER_LIMIT : rec.lastInput, ...earmarked.map((e) => e.text)].join("\n\n");
      // Without a session this input IS the task: if it parks again before the first answer, the next resumption takes
      // it including the messages just appended — they are already out of `supplyLater`. Like the restart in drive.
      if (!rec.sessionId) rec.lastInput = input;
      // The folder it continues in, as with send — an unchanged worktree was removed at its end (also at the server
      // end); without this line the process would start in the missing folder and fail with ENOENT.
      const folder = folderForResumption(rec);
      if (rec.sessionId) rowValue(rec, { role: "user", text: input });
      rec.text = "";
      rec.error = "";
      // With an instance the worktree is created in the project container (a promise) — in this window the agent can
      // be stopped or its core closed. Then NO process starts any more (drive would otherwise set the already settled
      // agent to "running" forever and spawn into the container), and the worktree just created goes back. Like send
      // after its `await folder`.
      const past = () => rec.settled || closed || rec.killRequested;
      rec.done = Promise.resolve(folder).then(() => {
        if (past()) { try { releaseWorktree(rec); } catch { /* worktree clean-up must never throw */ } return undefined; }
        return run(rec, input).then(() => turnEnd(rec));
      }, (e) => { if (past()) return undefined; throw e; }) // no worktree, but already stopped: nothing to report
        .catch((e) => fail(rec, e))
        .catch((e) => console.error("[agent] resumption not completed:", e?.message || e));
      create(rec);
      try { onStatus(publicRec(rec)); } catch { /* see park */ }
    } catch (e) {
      fail(rec, new Error(`Resumption after the usage limit failed: ${e?.message || e}`))
        .catch((err) => console.error("[agent] resumption not completed:", err?.message || err));
    }
  }

  /** Result of a finished (or failed) subagent — 1:1 the fields of the Claude CLI. */
  function report(rec) {
    const durationMs = (rec.endedAt || Date.now()) - rec.startedAt;
    return {
      status: rec.status,
      // The reason stands BESIDE the status, before the report: of a failed report the parent run keeps only the
      // beginning as limit evidence (runs/do-run.js limitEvidence: 2000 characters) — behind a long partial report
      // the wording would be outside what it ever reads.
      error: rec.error || "",
      agentId: rec.agentId,
      name: rec.name,
      description: rec.description,
      agentType: rec.type || "general-purpose",
      provider: rec.provider,
      // The same value as publicRec.model: bare model id or empty — the report is the source from which the clients
      // read the model of a FINISHED subagent.
      resolvedModel: rec.model,
      skills: rec.skills.map((s) => s.name),
      report: clip(rec.text || "", REPORT_CAP) || (rec.status === "completed" ? "(no Report)" : ""),
      totalTokens: tokenSum(partsNow(rec)),
      // As in publicRec: says whether totalTokens is complete or a lower bound.
      tokenKind: tokenKind(rec),
      totalToolUseCount: rec.toolUses,
      totalDurationMs: durationMs,
      cwd: rec.cwd,
      worktree: rec.worktree ? rec.worktree.dir : "",
      outputFile: outputFile(rec),
      notes: rec.notes || "",
      note: rec.status === "completed"
        ? `Continue with cbase_agent_send (agentId "${rec.agentId}") — the subagent keeps its context.`
        : "",
    };
  }

  function waitFor(rec, waitMs) {
    if (rec.settled) return Promise.resolve(report(rec));
    if (rec.status === "parked") return Promise.resolve(parked(rec));
    const ms = Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMs) || 0));
    if (!ms) return Promise.resolve({ ...running(rec), waited: 0 });
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = rec.waiters.indexOf(fin);
        if (i >= 0) rec.waiters.splice(i, 1);
        resolve({ ...running(rec), waited: ms });
      }, ms);
      timer.unref?.();
      function fin(res) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      }
      rec.waiters.push(fin);
    });
  }

  // The foreground call: waits for the report, at most until the deadline — then the agent switches to the background
  // and the call returns. `rec.front` is the switch of the call waiting RIGHT NOW (for the button "To the
  // background"); an end, parking or the switch itself clear it. Wait queues of cbase_agent_output stay untouched:
  // they have their own deadline.
  function inForeground(rec) {
    if (rec.settled) return Promise.resolve(report(rec));
    if (rec.status === "parked") return Promise.resolve(parked(rec));
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const end = (res) => {
        if (done) return false;
        done = true;
        clearTimeout(timer);
        foregroundDeadlines.delete(changeover);
        const i = rec.waiters.indexOf(fin);
        if (i >= 0) rec.waiters.splice(i, 1);
        if (rec.front === changeover) rec.front = null;
        resolve(res);
        return true;
      };
      function fin(res) { end(res); }
      function changeover(reason) {
        if (done || rec.settled) return false;
        rec.background = true;
        // Parked: the answer is that of parking (report after the reset, by itself) — with the mark of the switch.
        end(reason === "parking" ? { ...parked(rec), background: true, intoTheBackground: reason } : switched(rec, reason));
        try { onSwitch(publicRec(rec)); } catch { /* the display must not topple the switch */ }
        return true;
      }
      // The main agent only gets here with the knob (gate) and waits at most as long as it says.
      const deadline = rec.parentAgent ? foregroundDeadline() : Math.min(foregroundDeadline(), mainAgentWaitMs());
      timer = setTimeout(() => changeover("deadline"), deadline);
      timer.unref?.();
      foregroundDeadlines.add(changeover);
      rec.front = changeover;
      rec.deadlineMs = deadline;
      rec.waiters.push(fin);
    });
  }

  const switched = (rec, reason) => ({
    ...running(rec),
    background: true,
    intoTheBackground: reason, // "deadline" | "human" | "turn-end" | "parent-end" ("parking" answers with `parked`, see inForeground)
    note: `Continues in the background (agentId "${rec.agentId}"): `
      + (reason === "human"
        ? "the human has sent the subagent to the background."
        : reason === "turn-end"
          ? "the turn that waited for it has ended."
          : reason === "parent-end"
            ? "the agent that waited for it has ended."
            : `the subagent ran longer than ${Math.round((rec.deadlineMs || foregroundDeadline()) / 1000)} s in the foreground.`)
      + " Its report comes by itself as a system message (<task-notification>) when it is finished. Work on something"
      + " else or end your turn — do not poll, do not sleep; cbase_agent_output only if you need it in the same"
      + " turn.",
  });

  /**
   * Send a foreground agent to the background AT ONCE (button "To the background", the Ctrl+B of Claude Code): the
   * waiting call returns, the agent is an ordinary background agent from now on.
   * @returns {{ok: boolean, agentId?: string, background?: boolean, reason?: string}}
   */
  function intoTheBackground(id, reason = "human") {
    const rec = find(id);
    if (!rec) return { ok: false, reason: "unknown" };
    if (rec.settled) return { ok: false, agentId: rec.agentId, reason: "finished" };
    // Already in the background (say, just switched by the deadline): the requested state holds — not an error.
    if (rec.background) return { ok: true, agentId: rec.agentId, background: true, already: true };
    toBackground(rec, reason);
    return { ok: true, agentId: rec.agentId, background: true };
  }

  // The ONE transition foreground → background: deadline, button, parking, turn end, end of the parent agent. Whoever
  // resolves the waiting call switches here — "foreground" means "a call is waiting". If one waits (`rec.front`), it
  // returns with the answer of the reason; otherwise only the kind changes. Exactly one onSwitch per agent: a second
  // trigger finds `rec.background` already set. Returns whether a switch happened.
  function toBackground(rec, reason) {
    if (rec.settled || rec.background) return false;
    if (rec.front) return rec.front(reason);
    rec.background = true;
    try { onSwitch(publicRec(rec)); } catch { /* the display must not topple the switch */ }
    return true;
  }

  // `main`: does the MAIN AGENT read this answer? It never waits (see mainAgentWaitMs) — the note offers it no
  // waiting. Without a value it is the one that started the agent.
  const running = (rec, main = !rec.parentAgent) => ({
    status: "running",
    agentId: rec.agentId,
    name: rec.name,
    description: rec.description,
    agentType: rec.type || "general-purpose",
    provider: rec.provider,
    resolvedModel: rec.model, // one spelling, see report()
    note: main
      ? "The subagent works in the background — you do not wait for it. Work on something else or end your turn:"
        + " its report comes by itself as a system message (<task-notification>). cbase_agent_output only shows its"
        + " state. Do not poll, do not sleep."
      : "The subagent keeps working in the background. Work on something else or end your turn — its report"
        + " comes by itself as a system message. If you need it in the same turn: cbase_agent_output"
        + ` with agentId "${rec.agentId}". Do not poll, do not sleep.`,
  });

  const parked = (rec) => ({
    ...running(rec),
    status: "parked",
    parkedUntil: rec.parkedUntil,
    note: `The subagent is at the usage limit of its provider (${rec.provider}) and resumes by itself at ${new Date(rec.parkedUntil).toISOString()}`
      + ". Its report is then delivered to you automatically as a new message. End your turn now"
      + " or work on something else — do not poll, do not sleep, do not start it anew.",
  });

  // ── Public interface ──────────────────────────────────────────────────────────
  async function start(args = {}, meta = {}) {
    if (closed) throw new Error("The run has ended — a subagent needs a running turn.");
    const prompt = String(args.prompt || "").trim();
    if (!prompt) throw new Error("prompt is missing — the subagent needs its complete, self-explanatory task.");

    const typeRaw = String(args.subagent_type || "").trim();
    const key = typeRaw.toLowerCase();
    const builtin = BUILTIN_AGENT_TYPES[key] || (!typeRaw ? BUILTIN_AGENT_TYPES["general-purpose"] : null);
    const def = builtin ? null : defsByName().get(key);
    if (typeRaw && !builtin && !def) {
      const known = listTypes().map((t) => t.name);
      throw new Error(`Unknown subagent_type "${typeRaw}". Selectable: ${known.join(", ")}.`);
    }
    // Model: explicit argument ▸ model of the agent type ▸ inheritance: provider+model of the caller — the chat or
    // (depth ≥ 2) the calling agent (meta.parentProvider/parentModel, like parentEffort) —, see resolveModel.
    const inherit = meta.parentProvider
      ? { provider: String(meta.parentProvider), model: String(meta.parentModel || "") }
      : { provider: parentProvider, model: parentModel };
    const target = resolveModel(args.model || def?.model || "", inherit);
    // Level: argument ▸ level of the calling agent (meta.parentEffort) ▸ "" = the chat's.
    const effort = levelFromArgument(args.effort) || String(meta.parentEffort || "");
    // Isolation and repo BEFORE the gate and the cap: a wrong call fails before anything starts.
    // "remote" does not exist in cbase (there is no cloud session) — say so explicitly.
    const isolation = String(args.isolation || "").trim().toLowerCase();
    if (isolation === "remote") throw new Error('isolation:"remote" does not exist in cbase — there is no cloud session. Use "worktree" (a Git checkout of its own) or leave the field out.');
    if (isolation && isolation !== "none" && isolation !== "worktree") throw new Error(`Unknown isolation "${isolation}" — allowed are "worktree" and "none".`);
    const repoArg = String(args.repo || "").trim();
    if (repoArg && isolation !== "worktree") throw new Error(`repo only takes effect with isolation:"worktree" — "${repoArg}" was not branched off, no subagent started.`);
    // The core's management git — null without an instance (the synchronous way).
    const kg = gitOf(instance);
    const repoRoot = isolation === "worktree" ? await selectRepo(repoArg, cwd, kg) : "";
    // Credit gate: if it is closed, nothing starts — no process, no MCP config, no profile —, and the call gets the
    // reason as a tool error instead of a silent waiting row. The `await`s of the start come BEFORE the cap: none may
    // lie between the count and the entry in `agents` (see `slotMissing`).
    // The core's instance travels along: the lock per project judges by the project the agent RUNS in, not by the one
    // the chat carries in the meantime. Without an instance the field is missing.
    const response = startGate({ provider: target.provider, model: target.model, ...(instance ? { instance } : {}) });
    const locked = response && typeof response.then === "function" ? await response : response;
    if (locked) throw new Error(locked);
    // With an instance the worktree is created HERE — in the project container, asynchronously, BEFORE the await-free
    // section in which the cap and `agents.set` count. If the section rejects afterwards, the fresh worktree goes back
    // as a teardown job (`back`). Without an instance it is created synchronously below, in the section.
    let upfront = null;
    if (repoRoot && kg) {
      const index = ++seq;
      const id = `a${crypto.randomUUID().slice(0, 8)}-${index}`;
      upfront = { agentId: id, index, wt: await makeWorktree(id, repoRoot, kg, instance) };
    }
    const back = (e) => { if (upfront) worktreeBack(upfront.wt, kg); return e; };
    if (closed) throw back(new Error("The run has ended — a subagent needs a running turn."));
    // No queue: above the cap the call fails at once and starts nothing (no process, no MCP config).
    const full = slotMissing();
    if (full) throw back(new Error(full));

    const index = upfront ? upfront.index : ++seq;
    const agentId = upfront ? upfront.agentId : `a${crypto.randomUUID().slice(0, 8)}-${index}`;
    const description = String(args.description || def?.description || typeRaw || "Subtask").replace(/\s+/g, " ").slice(0, 160);
    const rec = {
      agentId,
      name: String(args.name || "").trim().slice(0, 64) || (typeRaw || "agent") + `-${index}`,
      type: typeRaw || "general-purpose",
      description,
      prompt,
      // Without a value in the background (as in Claude Code): the call returns at once, the completion notice comes
      // over the wake path. `false` = foreground, the call waits for the report — only for a subagent that delegates
      // itself: the main agent never waits (see mainAgentWaitMs).
      background: args.run_in_background !== false || (!meta.parentAgent && !mainAgentWaitMs()),
      inheritContext: Boolean(builtin?.inheritContext || args.inherit_context === true),
      status: "starting",
      startedAt: Date.now(),
      endedAt: 0,
      provider: parentProvider,
      model: "",
      effort, // the requested level, unclamped ("" = the chat's) — clamped at the spawn, to its model
      cwd,
      instance: instance || null, // the core's instance, for its whole life
      worktree: null,
      sessionId: "",
      sessionLive: "", // the session the running turn has already reported (see makeForward)
      text: "",
      stderr: "",
      turnError: "", // error mark of the running turn from the result event (see makeForward)
      error: "",
      notes: "",
      rows: [{ role: "user", text: prompt }],
      toolUses: 0,
      usage: { input: 0, output: 0, cached: 0 },
      billing: "subscription",
      tally: createUsageTally(),
      waiters: [],
      front: null,   // the switch of the waiting foreground call, see inForeground
      deadlineMs: 0,
      settled: false,
      child: null,
      killRequested: false,
      watchdog: null, // the stall watchdog of the running or last turn, see drive
      // Limit parking: alarm off, when to continue, reset according to the provider, how often parked, the input of
      // the running turn (for a resumption without a session) and whether the turn is a resumption.
      wakeupOff: null,
      parkedUntil: 0,
      resetsAt: 0,
      parkAttempts: 0,
      lastInput: prompt,
      resumed: false,
      // Readjusting: messages delivered after the running turn as a resumption (see run), whether no turn accepts
      // them any more (`completion`), and who stopped it ("human" | "agent" | "" = nobody).
      supplyLater: [],
      supplyLaterReason: "", // why what was supplied later is no longer delivered (the gate was closed) — see run/settle
      // See control: what was delivered into the middle of the running turn (a restart of the turn appends it to the
      // input — the session from before the turn does not know it), what came before its FIRST process (it goes into
      // the first model request), and whether that process exists yet.
      controlled: [],
      beforeStart: [],
      firstProcess: false,
      completion: false,
      stoppedOf: "",
      // ALWAYS set: by this id the parent run recognises that an event belongs to a subagent (no context counter, no
      // main answer, no new turn). If the real tool_use id is missing, a synthetic one does the same job — the
      // clients put a block with an unknown parent call at the top instead of losing it.
      parentToolUseId: meta.parentToolUseId || `agent:${agentId}`,
      outputFile: meta.outputDir ? path.join(meta.outputDir, `${agentId}.output`) : "",
      tools: [], mcp: mcpOfTheType(def), // mcp: coding MCP servers of the type — only from the definition, never from the call
      skills: [],
      systemPrompt: "",
      // Origin: depth below the chat, the parent agent (empty = the main agent) and the set it passes on (null = the
      // chat's set). buildSpec computes this agent's tools and frame from that.
      depth: Math.max(1, Number(meta.depth) || 1),
      parentAgent: meta.parentAgent || "",
      parentSet: meta.parentSet ?? null,
      // { schema, reference, frame } of an agent(prompt, {schema}) — null without a schema.
      structure: meta.structure || null,
    };

    rec.provider = target.provider;
    rec.model = target.model;

    // Tool allowlist: argument ▸ list of the definition — the same path, the same rule (set means only what is
    // listed). `null` = not set (the full set of the path). An EMPTY argument is "not stated" and falls back to the
    // definition: a model that sends `tools: []` rarely means "nothing at all".
    rec.tools = toolList(args.tools).length ? toolList(args.tools) : definitionsList(def);

    // Skills: argument ∪ skills field of the definition — unlike tools the two ADD up (a call supplements the role,
    // it does not replace it). Loaded in full, see skillsBlock.
    try { rec.skills = loadSkills(args.skills, def); } catch (e) { throw back(e); }

    // Role: prompt of the definition + loaded skills + subagent frame (+ project origin). The skills stand BEHIND the
    // role and BEFORE the frame: the role says who it is, the guide how it works, the frame what a subagent never does.
    const role = String(def?.body || def?.prompt || builtin?.prompt || "").trim();
    const origin = def?.originProject
      ? `You belong to the project "${def.originProject}"${def.originProjectPath ? ` (folder: ${def.originProjectPath})` : ""} — your task refers to this project.\n\n`
      : "";
    const loaded = skillsBlock(rec.skills);
    rec.systemPrompt = `${origin}${role}${loaded ? `\n\n${loaded}` : ""}${frame}`;

    // Isolation: the repo is chosen above (selectRepo).
    if (repoRoot) {
      rec.worktree = upfront ? upfront.wt : makeWorktree(agentId, repoRoot);
      rec.cwd = rec.worktree.dir;
    }

    rec.forward = makeForward(rec);
    agents.set(agentId, rec);
    create(rec);
    if (deposit?.row) { try { deposit.row(agentId, rec.rows[0]); } catch (e) { console.error("[agent] store (history):", e?.message || e); } }
    try { onStart(publicRec(rec)); } catch { /* the display must not prevent the start */ }

    // The run itself does NOT hang on the caller: a foreground agent also keeps running alongside when it switches to
    // the background after the deadline. That is exactly what makes the deadline harmless.
    rec.done = run(rec, prompt)
      .then(() => turnEnd(rec))
      .catch((e) => fail(rec, e));

    if (rec.background) return { ...running(rec), started: true, background: true };
    return inForeground(rec); // `wait_ms` no longer has an effect — the deadline is the product's
  }

  // ── Readjusting and resuming ──────────────────────────────────────────────────────────────────────────────────
  // A message to a LIVING agent: mid-turn if its provider can (`controlCbase` on the child — Claude via stdin: it
  // stands in the next model request behind the tool result; the loop engine in its next tool round), otherwise after
  // the end of the running turn as a resumption of the same session (Codex: `exec` reads stdin only BEFORE the start,
  // up to EOF; a parked agent; an agent whose process is not up yet). Returns "delivered" | "after_end" | null (no
  // longer alive). `entry` says what is supplied later: `kind` "message" (cbase_agent_send, including the turn's
  // override) or "report" (a grandchild's report, including `report`) — so that settle passes it on correctly if it
  // never arrives.
  function readjust(rec, text, entry = {}) {
    if (rec.settled || rec.completion) return null;
    if (rec.status === "running" && typeof rec.child?.controlCbase === "function" && rec.child.controlCbase(text)) {
      rowValue(rec, { role: "user", text });
      if (rec.inTurn) rec.controlled.push({ kind: "message", ...entry, text });
      return "delivered";
    }
    rec.supplyLater.push({ kind: "message", ...entry, text });
    return "after_end";
  }

  /**
   * A message to an agent of a dynamic workflow — unlike `send` it NEVER resumes a finished agent (the script has its
   * result; it is not a return channel either).
   *   "delivered"   running and accepts it mid-turn (Claude CLI at the tool boundary, loop engine)
   *   "after_end"   running, accepts it only after its turn (Codex): resumption of THE SAME session, before it ends
   *                 and its result goes to the script (run)
   *   "earmarked"   its first process is not up yet (the race right after the start): it goes into the FIRST model
   *                 request — the attempt already built restarts with an extended input before it spawns
   *                 (`entry.beforeStartText` instead of `text`, the fenced block of the task); parked at the limit: to
   *                 the input of the resumption (further)
   *   null          it is no longer alive (finished, failed, stopped) — or its end is already certain
   * What no longer arrives afterwards (gate before supplying, stop, end) goes to onFinish with `undelivered` (settle).
   */
  async function control(id, text, entry = {}) {
    const rec = find(id);
    if (!rec) return null;
    // It is ending right now (or deciding at the limit whether it parks): await the end, then ask again — like send.
    if (!rec.settled && rec.completion && rec.status !== "parked") { try { await rec.done; } catch { /* its turn is over */ } }
    if (rec.settled || rec.killRequested || closed) return null;
    if (rec.status === "parked") {
      rec.supplyLater.push({ kind: "message", ...entry, onResumption: true, text });
      return "earmarked";
    }
    if (!rec.firstProcess) {
      rec.beforeStart.push({ kind: "message", ...entry, text });
      if (rec.inTurn && !rec.restart) rec.restart = "earmark";
      return "earmarked";
    }
    return readjust(rec, text, entry);
  }

  // The credit gate before a NEW process (start, resumption, supplying later) for this agent's provider and model.
  // `overruled` undefined = the core's override (runs/agents.js). → error text or null; without a promise answer no
  // microtask of delay.
  function gateVerdict(rec, overruled) {
    const response = startGate({ provider: rec.provider, model: rec.model, ...(overruled === undefined ? {} : { overruled }),
      ...(rec.instance ? { instance: rec.instance } : {}) }); // the instance of ITS image (see start)
    return response && typeof response.then === "function" ? response : Promise.resolve(response || null);
  }

  // A message that begins with "/" is read by the Claude CLI as a command (unknown: the WHOLE message swallowed, zero
  // turns; known: it executes it itself) — via stdin as via --resume. So never with "/" in front.
  const withoutCommand = (text) => (text.startsWith("/") ? `Message from your caller:\n${text}` : text);

  const delivered = (rec) => ({
    ...running(rec),
    delivered: true,
    note: `Delivered: the subagent (agentId "${rec.agentId}") reads your message in its next tool round and`
      + " keeps working with it. Its report comes by itself as a system message as before — do not poll.",
  });
  const afterEnd = (rec) => ({
    ...(rec.status === "parked" ? parked(rec) : running(rec)),
    afterEnd: true,
    note: `The subagent (agentId "${rec.agentId}") accepts no message in the middle of its turn — it is delivered after the end`
      + " of its running turn as a resumption of the same session. Its report then comes by itself as a"
      + " system message (<task-notification>) — do not poll.",
  });

  /**
   * cbase_agent_send (counterpart of SendMessage), three cases by the recipient's state: if it runs, the message goes
   * into its next tool round (see readjust); if it is finished or stopped by the agent, it is resumed with full
   * context — ALWAYS in the background (as in Claude Code; the call does not wait, the answer comes as a completion
   * notice under the same id); if a HUMAN stopped it, the call is rejected. `run_in_background` has no effect here
   * any more and is not rejected.
   */
  // `parentAgent`: the CALLING agent ("" = the main agent, which never waits — see mainAgentWaitMs). The note of a
  // resumption follows it, not the target's parent agent: the main agent may also resume a grandchild whose parent is
  // already finished. Without a value (human, graph, workflow) the target's parent agent applies.
  async function send(args = {}, { overruled, parentAgent } = {}) {
    if (closed) throw new Error("The run has ended — a subagent needs a running turn.");
    const rec = find(args.agentId || args.to || args.name);
    if (!rec) throw new Error(`Unknown subagent "${args.agentId || args.to || args.name}". cbase_agents_list shows those of this run.`);
    const raw = String(args.message || args.prompt || "").trim();
    if (!raw) throw new Error("message is missing.");
    const message = withoutCommand(raw);
    // If it still lives but no turn accepts anything any more (it is ending): await its end, then resume.
    if (!rec.settled && rec.completion) await rec.done;
    if (!rec.settled) {
      const outcome = readjust(rec, message, { kind: "message", ...(overruled === undefined ? {} : { overruled }) });
      if (outcome === "delivered") return delivered(rec);
      if (outcome === "after_end") return afterEnd(rec);
    }
    if (closed) throw new Error("The run has ended — a subagent needs a running turn.");
    if (rec.stoppedOf === "human") {
      throw new Error(`Subagent "${rec.agentId}" was stopped by the human — you do not resume it. Do not bypass the decision:`
        + " ask the user whether the subtask is still needed, or do it yourself.");
    }
    // A stopped agent is "finished" at once, but its process only ends after the signal — only then is its session
    // certain, and only then can its old turn change nothing about it any more (it would otherwise run into the
    // resumption).
    try { await rec.done; } catch { /* the old turn is over either way */ }
    if (closed) throw new Error("The run has ended — a subagent needs a running turn.");
    if (!rec.settled) return send(args, { overruled, parentAgent }); // resumed from another side in the meantime: the same question again
    // The resumption starts a NEW process — it asks the credit gate like a start, with the same wording. The override
    // is an argument of the turn that sends (runs/routes.js).
    const locked = await gateVerdict(rec, overruled);
    if (locked) throw new Error(locked);
    if (closed) throw new Error("The run has ended — a subagent needs a running turn.");
    if (!rec.settled) return send(args, { overruled, parentAgent }); // resumed from another side during the gate question
    const folder = folderForResumption(rec);
    if (folder) {
      // The worktree was created in the project container — afterwards the same questions as after the gate.
      await folder;
      if (closed) throw new Error("The run has ended — a subagent needs a running turn.");
      if (!rec.settled) return send(args, { overruled, parentAgent });
    }
    rec.settled = false;
    rec.killRequested = false; // one stopped by the agent resumes
    rec.stoppedOf = "";
    rec.completion = false;
    rec.status = "running";
    rec.endedAt = 0;
    rec.text = "";
    rec.error = "";
    rowValue(rec, { role: "user", text: message });
    rec.lastInput = message;
    rec.parkAttempts = 0;
    rec.resumed = false;
    rec.background = true;
    if (args.parentToolUseId) rec.parentToolUseId = args.parentToolUseId; // null = keep the old id
    create(rec);
    try { onStart(publicRec(rec)); } catch {}
    rec.done = run(rec, message)
      .then(() => turnEnd(rec))
      .catch((e) => fail(rec, e));
    return {
      ...running(rec),
      resumed: true,
      background: true,
      note: `Resumed (agentId "${rec.agentId}") with full context, in the background: the call does not wait. The answer`
        + " comes by itself as a system message (<task-notification>) under the same agentId. Work on something else or"
        // If the main agent writes, it never waits (see mainAgentWaitMs) — the note offers it no collecting.
        + ((parentAgent === undefined ? rec.parentAgent : parentAgent)
          ? " end your turn — do not poll, do not sleep; cbase_agent_output only if you need it in the same turn."
          : " end your turn — do not poll, do not sleep."),
    };
  }

  /**
   * A message to a LIVING agent, without resuming a finished one (a grandchild's report to its parent agent). Returns
   * null if it is no longer alive — then it belongs to someone else.
   */
  function messageValue(id, text, { report = null } = {}) {
    const rec = find(id);
    return rec ? readjust(rec, String(text || ""), { kind: "report", ...(report ? { report } : {}) }) : null;
  }

  /**
   * Collect the report or wait for it (counterpart of TaskOutput). `meta.parentAgent`: the calling agent ("" = the
   * main agent — it never waits, see mainAgentWaitMs; not for a grandchild it queries either).
   */
  async function output(args = {}, meta = {}) {
    const rec = find(args.agentId || args.task_id || args.name);
    if (!rec) throw new Error(`Unknown subagent "${args.agentId || args.task_id || args.name}". cbase_agents_list shows those of this run.`);
    if (rec.settled) return report(rec);
    if (rec.status === "parked") return parked(rec);
    const main = !meta.parentAgent;
    if (args.block === false || (main && !mainAgentWaitMs())) return running(rec, main);
    const ms = args.timeout == null ? DEFAULT_WAIT_MS : args.timeout;
    return waitFor(rec, main ? Math.min(ms, mainAgentWaitMs()) : ms);
  }

  /**
   * Abort (counterpart of TaskStop). `ofHuman` distinguishes the two causes: the main agent via `cbase_agent_stop` or
   * a human via the stop button in the agents bar.
   */
  function stop(id, { ofHuman = false } = {}) {
    const rec = find(id);
    if (!rec) return false;
    rec.killRequested = true;
    if (rec.settled) return true;
    // Who stopped it decides about a later resumption: cbase_agent_send does not resume one stopped by the human. A
    // finished agent that someone "stops" stays resumable (line above).
    // Who stopped it belongs in the RESULT. A subagent that vanishes silently lets the main agent's turn run into the
    // deadline (AGENT_DRAIN_MS) instead of working on; and without the reason "stopped" could not be told from
    // "finished without findings".
    abort(rec, {
      status: "stopped",
      stoppedOf: ofHuman ? "human" : "agent",
      reason: ofHuman ? "Stopped by the human. No result." : "Aborted by the main agent. No result.",
    });
    return true;
  }

  // Restart of ONE running agent by the human: the same path as the stall restart in `drive` — the running attempt
  // ends (signal to the process), the same turn starts anew with THE SAME input and the session from before the turn;
  // the report is that of the new attempt (text and error mark of the old one are dropped). No settle, no completion
  // notice. Only mid-turn (`inTurn`): a parked, finished or stopped agent or one between two turns has no attempt that
  // could restart.
  function restart(id) {
    const rec = find(id);
    if (!rec) return { ok: false, reason: "unknown" };
    if (rec.settled || rec.killRequested || !rec.inTurn || rec.status !== "running") return { ok: false, reason: "running-not", agentId: rec.agentId };
    rec.restart = "human";
    try { rec.child?.kill?.("SIGTERM"); } catch { /* already dead */ }
    return { ok: true, agentId: rec.agentId };
  }

  // The ONE abort of a living agent: signal to its process, result with reason, settle. `stop` and the stall watchdog
  // both go through here; only status and originator differ.
  function abort(rec, { status, stoppedOf, reason }) {
    rec.killRequested = true;
    rec.stoppedOf = stoppedOf;
    rec.error = reason;
    // An interim state is kept, the reason stands before it.
    rec.text = rec.text ? `${reason}\n\nInterim state:\n${rec.text}` : reason;
    try { rec.child?.kill?.("SIGTERM"); } catch { /* already dead */ }
    // A connector that does not react to the signal must not leave the caller hanging.
    settle(rec, status, reason);
  }

  // Stall: `deadline` ms without progress and without an open tool call. The agent ends through the stop as FAILED —
  // not as stopped (originator empty): its completion notice comes, and cbase_agent_send resumes it (one stopped by
  // the human would be rejected).
  function stallAbort(rec, deadline) {
    if (rec.settled || rec.killRequested) return;
    abort(rec, { status: "failed", stoppedOf: "", reason: `No progress for ${Math.round(deadline / 1000)} s — ended by the stall watchdog.` });
  }

  /**
   * Pick an agent up again from the store: after a restart ("orphaned") or after its core was closed while idle.
   * Afterwards it stands in the core like a finished one — `send` resumes it via the stored session (Claude/Codex) or
   * the stored history (loop engine), under the same agentId. If the core already knows it, that one stays. Returns
   * the public record.
   *
   * A PARKED one with a stored resumption time (the restart, runs/agents.js) then stands parked in the core — alive,
   * with its alarm; when that fires, it resumes over the same resumption as an agent that parked without a restart
   * (further → run, --resume on the stored session). If the time is already past, the alarm fires at once.
   */
  function pickUp(image) {
    if (closed) throw new Error("The run has ended — a subagent needs a running turn.");
    const agentId = String(image?.agentId || "");
    if (!agentId) throw new Error("pickUp: agentId is missing");
    if (agents.has(agentId)) return publicRec(agents.get(agentId));
    const rows = Array.isArray(image.rows) ? image.rows.map((r) => ({ role: String(r.role), text: String(r.text ?? "") })) : [];
    const rec = {
      agentId,
      name: String(image.name || agentId),
      type: String(image.type || "general-purpose"),
      description: String(image.description || ""),
      prompt: String(image.prompt || ""),
      background: true,
      inheritContext: Boolean(image.inheritContext),
      // An orphaned one stood in the middle of its work — for the resumption it counts like an ended one, the reason
      // is in the report; a finished one keeps its status.
      status: image.state === "orphaned" ? "stopped" : String(image.status || "completed"),
      startedAt: Number(image.startedAt) || Date.now(),
      endedAt: Number(image.endedAt) || Date.now(),
      provider: String(image.provider || parentProvider),
      // An old image carries "" without a model — it then ran with its provider's default. It resumes with that.
      model: String(image.model || "") || String(defaultModel(String(image.provider || parentProvider)) || ""),
      effort: effortSavable(image.effort).kind === "level" ? image.effort : "",
      cwd: String(image.cwd || cwd),
      // The instance of its image, not that of the core picking it up (resume and orphan notice hit the same one).
      instance: typeof image.instance === "string" && image.instance ? image.instance : null,
      worktree: image.worktree || null,
      // An image from the server end carries the repo only in the worktree — without this fallback a cleaned-up
      // worktree agent would not be resumable after a restart.
      worktreeRepo: String(image.worktreeRepo || image.worktree?.repo || ""),
      sessionId: String(image.sessionId || ""),
      sessionLive: "",
      text: String(image.text || ""),
      stderr: "",
      turnError: "",
      error: image.state === "orphaned" ? "Interrupted by a restart of cbase." : String(image.error || ""),
      notes: String(image.notes || ""),
      rows,
      toolUses: Number(image.toolUses) || 0,
      usage: { input: 0, output: 0, cached: 0, ...(image.usage || {}) },
      billing: image.billing === "metered" ? "metered" : "subscription",
      tally: createUsageTally(),
      waiters: [],
      front: null,
      deadlineMs: 0,
      settled: true,
      child: null,
      killRequested: false,
      wakeupOff: null,
      parkedUntil: 0,
      resetsAt: 0,
      parkAttempts: 0,
      lastInput: String(image.prompt || ""),
      resumed: false,
      supplyLater: [],
      supplyLaterReason: "",
      // See control: a picked-up one already had processes.
      controlled: [],
      beforeStart: [],
      firstProcess: true,
      completion: false,
      stoppedOf: String(image.stoppedOf || ""),
      parentToolUseId: String(image.parentToolUseId || `agent:${agentId}`),
      outputFile: String(image.outputFile || ""),
      outputMissing: String(image.outputMissing || ""),
      tools: Array.isArray(image.tools) ? image.tools.map(String) : null,
      skills: Array.isArray(image.skills) ? image.skills : [],
      systemPrompt: String(image.systemPrompt || ""),
      depth: Math.max(1, Number(image.depth) || 1),
      parentAgent: String(image.parentAgent || ""),
      parentSet: image.parentSet ?? null, mcp: mcpOfTheType(image),
      pickedUp: true,
    };
    rec.forward = makeForward(rec);
    rec.done = Promise.resolve();
    const until = Number(image.parkedUntil) || 0;
    if (image.state === "parked" && until > 0) {
      rec.settled = false;
      rec.status = "parked";
      rec.endedAt = 0;
      rec.error = "";
      rec.parkedUntil = until;
      rec.resetsAt = Number(image.resetsAt) || 0;
      rec.parkAttempts = Math.max(1, Number(image.parkAttempts) || 1);
      rec.supplyLater = supplyLaterFromImage(image); // see pasteboardImage
      // Its not yet booked consumption (see pasteboardImage) — booked at its end, with what comes after.
      rec.open = image.open && typeof image.open === "object" ? consumptionPlus(null, image.open) : null;
      rec.wakeupOff = wakeup(Math.max(0, until - Date.now()), () => further(rec));
    }
    agents.set(agentId, rec);
    return publicRec(rec);
  }

  function find(id) {
    const key = String(id || "").trim();
    if (!key) return null;
    if (agents.has(key)) return agents.get(key);
    const byName = [...agents.values()].filter((a) => a.name === key);
    return byName.length ? byName[byName.length - 1] : null; // the youngest wins (as in Claude Code)
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const rec of [...agents.values()]) {
      if (rec.settled) continue;
      rec.killRequested = true;
      try { rec.child?.kill?.("SIGTERM"); } catch {}
      settle(rec, "stopped", "The main agent's run has ended.");
    }
  }

  return {
    start,
    send,
    message: messageValue,
    control,
    output,
    stop,
    restart,
    intoTheBackground,
    close,
    list: () => [...agents.values()].map(publicRec),
    types: listTypes,
    hostHint,
    has: (id) => Boolean(find(id)),
    pickUp,
    // State of the stall watchdog in the running turn — for test seams, not part of the report; null before the first turn.
    stallState: (id) => { const rec = find(id); return rec?.watchdog ? rec.watchdog.snapshot() : null; },
    get: (id) => { const rec = find(id); return rec ? publicRec(rec) : null; },
    // An agent's instance identifier: that of its image or of the core — null without. Not in publicRec: the clients'
    // view stays byte-equal.
    instanceOf: (id) => find(id)?.instance || null,
    // What a child inherits from this agent — not part of the report: depth, requested tools, the set it was started
    // with itself, its parent agent, provider, model and call block (stream for Codex).
    origin: (id) => {
      const rec = find(id);
      return rec ? { agentId: rec.agentId, depth: rec.depth, tools: rec.tools ? [...rec.tools] : null, parentSet: rec.parentSet, parentAgent: rec.parentAgent, mcp: rec.mcp || null,
        provider: rec.provider, model: rec.model || "", effort: rec.effort || "", parentToolUseId: rec.parentToolUseId, settled: rec.settled } : null;
    },
    // Correct a subagent's call block afterwards (confirmation of a provisional Codex assignment,
    // runs/call-blocks.js). From then on its events carry the new block.
    reattach: (id, parentToolUseId) => {
      const rec = find(id);
      if (!rec || !parentToolUseId) return false;
      rec.parentToolUseId = parentToolUseId;
      return true;
    },
  };
}
