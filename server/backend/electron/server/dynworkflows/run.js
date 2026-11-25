// The run of a dynamic workflow. The lifecycle is modelled on the graph driver (workflows/driver.js): the run lives
// OUTSIDE the turn. `cbase_dynamic_workflow` returns at once (task id, run id, script path), the turn ends, the chat is
// free; at the end the completion notice (`<task-notification>`) arrives through the chat's ONE wake path
// (runs/queue.js deliverUserPrompt, cause "agent" — an unknown cause would silently become "user" and be bundled).
//
// The script runs with the 1:1 script API (sandbox.js). Every `agent()` starts through the agent core
// (runs/agents.js) in a core of its OWN per run: it does not belong to the chat — `/stop` and the main agent's agent
// routes do not reach it, idle clean-up and the subagent inventory do not know it. Before every start the core asks the
// credit gate, consumption is booked per agent at once. The journal carries per `agent()` launched · started ·
// result|failed with the `v2` key (journal.js) in call order, every entry with its phase.
//
// Workflow agents as in the baseline: `model` is resolved by model.js (Claude aliases mean Claude, `provider::model`,
// unique catalog ids; unknown ⇒ throw before anything starts), `effort` per agent clamped to ITS model — both in
// resolved form in the key. The core carries the marker `workflowAgent` (runs/agents.js): the chat's toolset 1:1 minus
// delegation, workflows, question, wakeup, monitor; approvals rejected without a card.
// Frame and sanitising are in frame.js. Stored are the structured transcript per agent (the core's sink) and the
// `phase()`/`log()` lines (store/dynworkflow-runs.js).
//
// End of life: `cbase_dynamic_workflow_stop` ends run and agents without a notice (as in the baseline); so does the
// stop by the human, but it deposits a silent hint for the next turn (see stopDynWorkflow); deleting the chat (hook
// "chatClosed", every delete path through chats/erase.js) stops silently and deletes the rows; the server end
// interrupts, and the restart resumes (see dynWorkflowsRestartGrace); archiving is locked (runs/archive.js through the
// ONE query runs/background.js). While a run is "running", /api/runs/active reports `busy` — read from the data layer
// (store/dynworkflow-runs.js), never through an import of this folder into runs/.
//
// Safety net: every run start goes through `los()` with a catch; a throwing core start becomes a rejection of the
// agent() call, a crashing agent child a `null`; the sandbox catches endless loops per section and unhandled rejections
// of the script.
import fs from "node:fs";
import path from "node:path";

import * as store from "../store.js";
import { T } from "../i18n.js";
import { effortRunning, getConnector, startGateVerdict } from "../providers/index.js";
import { probeDelayMs } from "../limits.js";
import { effortFallback, effortSavable } from "../workflows.js";
import { predecessorOf } from "../providers/retired.js";
import { tokenSum, tokenParts } from "../providers/connectors/consumption.js";
import { humanInput } from "../runs/human-input.js";
import { openAgents, setParkWakeup, cleanUpWorktreesInRuntimeFolder } from "../runs/agents.js";
import { removeAsRoot } from "../projectbox/cleanUp.js";
import { autoContinueEnabled } from "../runs/limit-gate.js";
import { projectCheckBackMs } from "../runs/project-lock.js";
import { agentContextWithoutTurn } from "../runs/do-run.js";
import { instanceFromIdentifier, instanceIsCopy, instanceIdentifierOf, instanceOfChat, turnIdentifier } from "../runs/instance.js";
import { deliverUserPrompt } from "../runs/queue.js";
import { workflowScripts } from "../runs/outputs.js";
import { afterRelocation } from "../runs/runtime-location.js";
import { writeInRuntimeFolder } from "../runs/runtime-write.js";
import { instanceOfTheChat, readInRuntimeFolder, readInTheInstance } from "../runs/runtime-limit.js";
import { FINISHED_RESULT_MAX, FINISHED_MARKER } from "../runs/completionNotice.js";
import { depositHint } from "../runs/hints.js";
import { backgroundEnds } from "../runs/background.js";
import { ownServerEnd } from "../runs/server-end.js";
import { managerLocked, managerLockText } from "../runs/manager-lock.js";
import { readJob, writeRuling, graphStep, createCard, readCard, nodeOpens, keywordInTurn } from "./approval.js";
import { RUN_ID_PATTERN, createChain, createPlayback, newRunId, newTaskId, normOptions } from "./journal.js";
import { startScript, unknownWorkflowText } from "./sandbox.js";
import { MetaError, ScriptError, checkScript } from "./script.js";
import { resolveAgentModel } from "./model.js";
import { WORKFLOW_AGENT_FRAME, framedJob, sanitizeResult } from "./frame.js";
import { capCountsNow, createStagger, runSlots } from "./cap.js";
import { FAILED_ATTEMPTS_MAX, FOLLOW_UP, STRUCTURE_FRAME, openOutput, withoutResultText, checkSchema } from "./structured.js";
import { budgetOfTheTurn, potFor } from "./budget.js";
import { sizesWarning } from "./size.js";
import { createProviderPark } from "./parking.js";
import { jobWithMessages, earmarkParked, reportLeftBehind, deliverAfterStart, messagesFromJournal, setRunAccess, reportUndelivered } from "./message.js";
import { reminderChatClosed } from "./reminder.js";
import { TREE_EVENT, RUNS_CAP, treeView } from "./tree.js";
import { broadcast, sse } from "../runtime/sse.js";

// runId → run of this server run. Module state like the run maps in runs/state.js; emptied at the server end.
const active = new Map();
// message.js: the running workflows and the tree reporter — registered instead of imported.
setRunAccess({ runs: () => [...active.values()], report: (run2) => reportTree(run2) });
const SCRIPT_MAX = 524288; // as in the baseline (schema.json: script.maxLength)

const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const errorText = (status, reason, error) => ({ status, body: { reason, error } });

// ── agentType, isolation, repo ───────────────────────────────────────────────────────────────────────────────────────
// `agentType` names an agent type from THE SAME list as cbase_agent (agent-runtime listTypes: the built-in ones and the
// cbase agent definitions of the chat's effective view), ignoring case as there. Checked SYNCHRONOUSLY before the key
// is created: an unknown type throws with the list of available ones — no journal, no process. `types` is only called
// when a type is given (a call without one opens no core for it).
// `subagent_type` (the name on the tool cbase_agent) counts as a spelling of `agentType`: silently ignored, the
// workflow agent would run without a type, i.e. without its model and MCP servers.
// Returns the name and the definition's model ("" = none): without `model` in the call it applies, as with cbase_agent
// (agent-runtime start: `args.model || def.model`).
export function agentTypeOf(opts, types) {
  const raw = opts.agentType ?? opts.subagent_type;
  if (raw === undefined || raw === null) return { type: "", model: "" };
  if (opts.agentType != null && opts.subagent_type != null && String(opts.agentType).trim().toLowerCase() !== String(opts.subagent_type).trim().toLowerCase()) {
    throw new Error("agent(): agentType and subagent_type name different types — give only agentType.");
  }
  const all = types();
  const names = all.map((t) => t.name);
  const list = `Available agent types: ${names.join(", ")}.`;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`agent(): agentType must be a non-empty string. ${list}`);
  const type = raw.trim();
  const def = all.find((t) => t.name.toLowerCase() === type.toLowerCase());
  if (!def) throw new Error(`agent(): unknown agentType '${type}'. ${list}`);
  return { type, model: String(def.model || "") };
}
// isolation and repo go to the core unchanged — it checks both, as for cbase_agent (agent-runtime start).
const coreIsolation = (opts) => ({
  ...(opts.isolation !== undefined && opts.isolation !== null ? { isolation: String(opts.isolation) } : {}),
  ...(opts.repo !== undefined && opts.repo !== null ? { repo: String(opts.repo) } : {}),
});
// The changed worktrees of a run, from its journal (including those from a predecessor's cache) — only what is still
// there. Nobody cleans them up; that is why they appear in the completion notice and in the output file. (Only
// exception: deleting the chat removes them in the runtime folder of a relocated project — dynWorkflowsChatClosed.)
const WORKTREES_IN_NOTICE = 20;
function changedWorktrees(runId) {
  const seen = new Set();
  const out = [];
  for (const e of store.readDynJournal(runId)) {
    const dir = e.worktree?.dir;
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) continue;
    seen.add(dir);
    out.push({ n: e.n, dir, agentId: String(e.worktree.agentId || "") });
  }
  return out;
}
function worktreeRow(list) {
  if (!list.length) return "";
  const named = list.slice(0, WORKTREES_IN_NOTICE).map((w) => `${w.dir} (agent() #${w.n})`).join(", ");
  const rest = list.length > WORKTREES_IN_NOTICE ? ` … and ${list.length - WORKTREES_IN_NOTICE} more (output file, “worktrees”)` : "";
  return `Changed worktrees stay in place and are not cleaned up (${list.length}): ${named}${rest}.`;
}

// ── Start and end marker in the history ─────────────────────────────────────────────────────────────────────────
// A run leaves EXACTLY two rows in the chat: the start marker when it begins, and the end marker with its outcome.
// Nothing else — no row per workflow agent (the core's sink is empty), no intermediate state; whoever wants to see what
// is running reads the tree. A role of its OWN, not `meta`: `meta` already holds two kinds (metrics and compaction), and
// a view without a case distinction broke on that once. The row is JSON `{ phase: "start"|"end", runId, taskId, name,
// status?, at }`; live the same as harness event `workflow_marker` (nested under `marker` so that no field overwrites
// the envelope — like limit_line). `status` of the end marker is the run's outcome: finished · stopped · failed (like
// the completion notice) and interrupted (server end). Read by web and iOS.
export const MARKER_ROLE = "workflow_marker";
export const MARKER_EVENT = "workflow_marker";

// The GLOBAL event: start and end of a run on /api/events — the pill "Active runs" (web pills/ActiveRunsPill.tsx)
// reloads on it instead of waiting for the tick. A resumed run reports its start too (it has no start marker), and a
// run without a chat its end.
export const GLOBAL_EVENT = "dyn_workflow";
function reportGlobal(run2, open) {
  try { broadcast({ type: GLOBAL_EVENT, chatId: run2.chatId, runId: run2.runId, open }); } catch { /* no streams */ }
}

function marker(run2, phase, status) {
  if (phase === "end") {
    if (run2.endMarker) return; // exactly ONE end marker per run, even if a safety net still fires after the end
    run2.endMarker = true;
    reportGlobal(run2, false);
  }
  const row = { phase, runId: run2.runId, taskId: run2.taskId, name: run2.name, ...(status ? { status } : {}), at: Date.now() };
  try { store.addMessage(run2.chatId, MARKER_ROLE, JSON.stringify(row), row.at); } catch { return; } // chat or database gone
  try { sse(run2.chatId, { type: "harness", subtype: MARKER_EVENT, marker: row }); } catch { /* no run state (server end) */ }
  reportTree(run2);
}

// ── The progress tree (tree.js) ───────────────────────────────────────────────────────────────────────────────
// Route (`GET /api/chats/:id/dyn-workflows/tree`) and event (`dynwf_tree` in the chat's stream, per run the WHOLE
// view) build with the same function from the database — plus the live state of the agents from the core (tokens of a
// running one, "parked") while the run lives in this server run. It is reported after every change (journal,
// phase()/log(), transcript, warning, end, stop), bundled into ONE report per tick of the event loop: a parallel() with
// a hundred calls writes a hundred entries in one synchronous step.

/** The view of a run as route and event deliver it — `null` when it does not exist (any more). */
export function dynTree(runId) {
  const row = store.readDynRun(runId);
  if (!row) return null;
  const live = new Map();
  const ctl = active.get(runId)?.ctl;
  if (ctl) for (const r of ctl.list()) live.set(r.agentId, r);
  // The cap numbers in effect NOW: a waiting agent shows "waiting · 8 at a time" instead of a mute dashed circle — the
  // view only takes them on a running run (tree.js, "The cap that holds").
  const cap = row.status === "running" ? capCountsNow() : null;
  return treeView({ run: row, journal: store.readDynJournal(runId), events: store.readDynEvents(runId), live, cap });
}

/** The trees of a chat: the newest runs (newest first) and how many beyond them are not shown. */
export function dynTrees(chatId) {
  const { runs, total } = store.dynRunsInChat(chatId, RUNS_CAP);
  return { runs: runs.map((r) => dynTree(r.runId)).filter(Boolean), additional: Math.max(0, total - runs.length) };
}

function reportTree(run2) {
  if (run2.silenced || run2.treeScheduled) return;
  run2.treeScheduled = true;
  setImmediate(() => {
    run2.treeScheduled = false;
    if (run2.silenced) return; // deleted: no tree any more
    let tree = null;
    try { tree = dynTree(run2.runId); } catch (e) { console.error("[dynworkflow] tree:", e?.message || e); }
    if (tree) try { sse(run2.chatId, { type: "harness", subtype: TREE_EVENT, tree }); } catch { /* no run state (server end) */ }
  });
}

/** The running workflows of a chat in THIS server run. */
export const dynWorkflowsOf = (chatId) => [...active.values()].filter((l) => l.chatId === chatId);

/**
 * A saved workflow in the chat's EFFECTIVE view: in a workspace chat all of the workspace, in a project chat only those
 * taken over there — one not taken over counts as unknown there. Ignoring case like `/name` (store/dynworkflows.js).
 * The library lives in the database: it is read synchronously, an empty view is a read one, not an unloaded one.
 * @returns {{ entry: Object|null, available: string[] }}
 */
export function savedWorkflow(chat, name) {
  const view = store.effectiveDynWorkflows(chat.workspaceId, chat.projectId || null);
  const n = String(name ?? "").toLowerCase();
  return { entry: view.find((w) => w.name.toLowerCase() === n) || null, available: view.map((w) => w.name) };
}

/** The instance for `workflow({scriptPath})`: the one PINNED to the run (`run.instanceIdentifier`), not the chat's
 *  current one — moving into or out of a copy in the middle of the run leaves its agents where they began, also across
 *  a restart (the identifier is stored on the run). `undefined` (restart of a run without a stored identifier): the
 *  chat's. An identifier whose instance no longer exists throws EOUTSIDE — never a read in the main instance. */
function instanceOfTheHost(chatId, run2) {
  const k = run2?.instanceIdentifier;
  if (k === undefined) return instanceOfTheChat(store.getChat(chatId));
  if (k === null) return null;
  const inst = instanceFromIdentifier(k);
  if (!inst) throw Object.assign(new Error(`The run's instance ${k} no longer exists.`), { code: "EOUTSIDE" });
  return inst;
}

/**
 * The `workflow()` host of a run: `({ name } | { scriptPath })` → `{ script, name? }`, looked up at every call, fresh
 * from the database in the chat's view; `{scriptPath}` like the tool input (absolute, readable). A throw is the error
 * of the call in the script. Async — the path of a chat in its COPY lies in the copy's project folder, and only its
 * container reads that (runs/runtime-limit.js readInTheInstance); the server would see the main instance. The sandbox
 * core accepts a promise.
 */
export function hostWorkflow(chatId, run2) {
  return async ({ name, scriptPath }) => {
    if (scriptPath !== undefined) {
      if (!path.isAbsolute(scriptPath)) throw new Error(`workflow({scriptPath: '${scriptPath}'}): scriptPath must be an absolute path.`);
      try { return { script: await readInTheInstance(scriptPath, { instance: instanceOfTheHost(chatId, run2), encoding: "utf8" }) }; } catch (e) {
        throw new Error(`workflow({scriptPath: '${scriptPath}'}): the script file is not readable: ${e.code || e.message}`);
      }
    }
    const chat = store.getChat(chatId);
    if (!chat) throw new Error(T("The chat of this workflow no longer exists."));
    const { entry, available } = savedWorkflow(chat, name);
    if (!entry) throw new Error(unknownWorkflowText(name, available));
    return { script: entry.script, name: entry.name };
  };
}

/**
 * The script of an explicit `scriptPath` when the chat works in a COPY — its path then (also) lies in the copy's
 * project folder, and only its container reads that (runs/runtime-limit.js readInTheInstance), never the server (it
 * would see the main instance). The route reads it AHEAD and passes it to `startDynWorkflow` (which stays
 * synchronous): `{ path, script }` or `{ path, error }`; `null` where there is nothing to read ahead (no explicit path,
 * no copy chat) — then `startDynWorkflow` reads itself.
 */
export async function readAloudCopy(chat, b = {}) {
  const detail = typeof b.scriptPath === "string" ? b.scriptPath.trim() : "";
  if (!detail) return null;
  let inst;
  try { inst = instanceOfTheChat(chat); } catch { return null; } // startDynWorkflow reports a missing instance of the turn itself (EOUTSIDE)
  if (!instanceIsCopy(inst)) return null;
  const filePath = afterRelocation(chat, detail);
  if (!path.isAbsolute(filePath)) return null; // the message "absolute path" belongs to startDynWorkflow
  try { return { path: filePath, script: await readInTheInstance(filePath, { instance: inst, encoding: "utf8" }) }; } catch (e) { return { path: filePath, error: e.code || e.message }; }
}

/**
 * `cbase_dynamic_workflow`: check, store the script, create the run. It only starts with `los()` — AFTER the answer
 * to the tool (the synchronous beginning of a script may compute for up to 30 s; the tool returns before that).
 * @returns {{ status: number, body: Object, los?: () => void }}
 */
export function startDynWorkflow(chat, b = {}, { readAloud = null } = {}) {
  // Also in a chat with an open graph run: the step holds until its workflow has ended and its completion notice has
  // been processed in the same step (the ONE query runs/background.js counts it, the step's turn holds through the
  // "hold" switch). The opt-in follows AFTER the script check: a card only shows what would also run.
  const resume = typeof b.resumeFromRunId === "string" ? b.resumeFromRunId.trim() : "";
  if (resume && !RUN_ID_PATTERN.test(resume)) return errorText(400, "resume", `resumeFromRunId “${resume}” does not match ${RUN_ID_PATTERN}.`);
  // Resume through the tool: a NEW run whose chain runs against the old one's journal — the longest unchanged prefix
  // comes from the cache. Only a run of this chat; a running one has to be stopped first.
  let before = null;
  if (resume) {
    before = store.dynRunInChat(chat.id, resume);
    if (!before || before.runId !== resume) {
      return errorText(404, "resume", T`No workflow run ${resume} in this chat, so there is nothing to resume. To run the workflow from the start, call the tool again without resumeFromRunId.`);
    }
    if (before.status === "running") {
      return errorText(409, "resume", T`Run ${resume} is still running — stop it with cbase_dynamic_workflow_stop before resuming from it.`);
    }
  }
  // `scriptPath` takes precedence over `script` and `name` (baseline), `script` over `name`; a resume without all
  // three runs the old run's script. `name` starts a saved workflow from the chat's effective view — afterwards the
  // same path as a script: check, opt-in, stored script file, the same return value.
  let script;
  const withoutText = !(typeof b.script === "string" && b.script.trim());
  const nameChoice = typeof b.name === "string" ? b.name.trim() : "";
  // After a project switch of the chat a stored script path lies at the new runtime folder — `afterRelocation`
  // translates an old one that no longer exists (runs/runtime-location.js).
  const pathDetail = typeof b.scriptPath === "string" && b.scriptPath.trim() ? b.scriptPath.trim() : (before && withoutText && !nameChoice ? before.scriptPath : "");
  const filePath = pathDetail ? afterRelocation(chat, pathDetail) : "";
  if (filePath) {
    if (!path.isAbsolute(filePath)) return errorText(400, "script", T`scriptPath must be an absolute path: "${filePath}".`);
    // With an instance only in the project folder or runtime folder of THIS instance, through the checked descriptor
    // (without an explicit instance a path outside any runtime folder would read any file on the server) — everything
    // else is "not readable" (EOUTSIDE).
    // In a COPY the route has already read an explicit `scriptPath` through the container (readAloudCopy); the server
    // has no anchor for the project folder there and would find nothing — never the main instance's file.
    if (readAloud && readAloud.path === filePath) {
      if (readAloud.error) return errorText(400, "script", T`The script file "${filePath}" is not readable: ${readAloud.error}.`);
      script = readAloud.script;
    } else try { script = readInRuntimeFolder(filePath, { instance: instanceOfTheChat(chat), encoding: "utf8" }); } catch (e) {
      return errorText(400, "script", T`The script file "${filePath}" is not readable: ${e.code || e.message}.`);
    }
  } else if (typeof b.script === "string" && b.script.trim()) script = b.script;
  else if (nameChoice) {
    const { entry, available } = savedWorkflow(chat, nameChoice);
    if (!entry) {
      const list = available.length ? available.join(", ") : T("(none)");
      return errorText(404, "name", T`No saved workflow "${nameChoice}" in this chat. Available: ${list}`);
    }
    script = entry.script;
  } else return errorText(400, "script", T("The script is missing: `script` (the text), `scriptPath` (a file) or `name` (a saved workflow)."));
  if (script.length > SCRIPT_MAX) return errorText(400, "script", `script exceeds ${SCRIPT_MAX} characters.`);
  let meta;
  try { ({ meta } = checkScript(script)); } catch (e) {
    if (e instanceof MetaError || e instanceof ScriptError) return errorText(400, "script", e.message);
    throw e;
  }
  // The human cause: the message the human typed into the running turn — it reaches every workflow agent as a relay
  // before the computed job (frame.js). Without a turn or without human input there is none.
  const human = humanInput(chat.id);
  const request = Array.isArray(human) && human.length ? human[human.length - 1] : null;
  // Opt-in: the ultracode mode OR the keyword in the human input of THIS turn OR the keyword in the node text of the
  // graph step the chat stands at — the mode from a graph run's run settings arrives through the chat. Otherwise the
  // approval card: nothing starts, the tool returns at once, the human decides (decideApproval); a graph step holds at
  // it like at an open question (workflows/gates.js).
  // A resume without args of its own runs the old run's — also through the card: the job remembers the predecessor,
  // `decideApproval` reads it fresh when accepting.
  const args = b.args !== undefined ? b.args : before?.args;
  // The budget "+500k" (budget.js): from the human input of THIS turn, with its identifier — the pot belongs to the turn
  // and is shared by all its runs. It travels along through the card (the ruling comes after the turn).
  const budget = budgetOfTheTurn(chat.id);
  if (!chat.ultracode && !keywordInTurn(chat.id) && !nodeOpens(chat.id)) {
    const { requestId, card } = createCard(chat.id, { script, meta, args, callId: b.callId, request, resumeOf: before?.runId || "", budget });
    // The job's location leads out of the runtime folder (approval.js): no card, nothing started.
    if (!card) {
      return errorText(409, "location", T("The request behind the approval card cannot be stored (the output folder leads outside the runtime folder) — no card, nothing started."));
    }
    return {
      status: 202,
      body: {
        status: "awaiting_approval", requestId, name: card.name,
        note: T`The workflow "${card.name}" is waiting for the user's approval — the user has not opted into multi-agent orchestration in this turn (no Ultracode mode, no "ultracode" in their message). A card with name, description and phases is shown in the chat. Nothing is running. End your turn now and do not call the tool again: if they accept, the workflow starts and a <task-notification> arrives when it ends; if they reject, you learn it as a system message.`,
      },
    };
  }
  return startChecked(chat, { script, meta, args, callId: b.callId, request, before, budget });
}

// The start of a checked script with opt-in: store the script, create the run, `los()` for the caller.
function startChecked(chat, { script, meta, args, callId, request, before = null, budget = null }) {
  // The instance of its core is fixed from here on — that of the starting turn, otherwise the chat's; a resume
  // (`resumeFromRunId`, also through the card) takes its predecessor's if that carries one: it is the same workflow,
  // and the restart that gave it up would have continued it there. If the chat creates or removes a copy in the
  // meantime, this workflow's agents keep running where it began (no workflow splits its agents across two instances).
  // The identifier is stored on the run (`dyn_workflow_runs.instance_identifier`) and thus also holds after a server
  // restart; an instance that no longer exists then throws at the next agent() (runs/do-run.js
  // agentContextWithoutTurn) — never a start in the main instance. Computed BEFORE anything is stored: a locked copy
  // (instanceOfChat throws) leaves no run "running" without a core.
  const instanceIdentifier = before?.instanceIdentifier || (turnIdentifier(chat.id) ?? instanceIdentifierOf(instanceOfChat(chat)));
  const runId = newRunId();
  const taskId = newTaskId();
  const folder = path.join(workflowScripts(chat.id), runId);
  const scriptPath = path.join(folder, "script.js");
  // In a project's runtime folder through the descriptor (runs/runtime-write.js): the project container mounts it rw, a
  // symlink `outputs/<chat>/workflows → /somewhere` would otherwise place the script — agent text — on the server. If
  // the path leads out, nothing starts (409, nothing created, no row).
  try {
    if (!writeInRuntimeFolder(scriptPath, script)) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(scriptPath, script);
    }
  } catch (e) {
    if (e?.code !== "EOUTSIDE" && e?.code !== "ENOFILE") throw e;
    return errorText(409, "location", T`The script file "${scriptPath}" cannot be created (${e.message}) — nothing started.`);
  }
  const outputPath = path.join(folder, "result.json");
  const name = String(meta?.name || "workflow");
  const old = before ? store.readDynJournal(before.runId) : [];
  const pot = potFor({ total: budget?.total ?? null, turnId: budget?.turnId || "" });
  store.createDynRun({ runId, taskId, chatId: chat.id, name, meta, scriptPath, outputPath, callId, args, resumeOf: before?.runId || "", budgetTotal: pot.total, instanceIdentifier });
  if (pot.total !== null) store.dynRunBudgetStatus(runId, pot.consumed());
  // An interrupted predecessor is thereby superseded — otherwise the next restart would resume it a second time.
  if (before?.status === "interrupted") store.abandonDynRun(before.runId, `resumed as ${runId}`);
  const run2 = newRun({ runId, taskId, chatId: chat.id, name, scriptPath, outputPath, callId, request, pot, instanceIdentifier });
  // The graph step it starts in: only ITS workflow holds the step — a workflow from an earlier human message does not
  // (it has no marker or that of another step). Also through the card: the step waits at it, so the ruling still falls
  // within it.
  run2.graph = graphStep(chat.id);
  active.set(runId, run2);
  return {
    status: 201,
    body: {
      status: "started", taskId, runId, scriptPath, name,
      // The ways to the running workflow, named where the agent gets hold of it: a message reaches each of its agents
      // (communication/target-wf.js), so correcting never needs a stop and a restart. Guard: test/start-answers-message-path.test.js.
      note: T`The workflow "${name}" runs in the background. End your turn now: when it finishes, a <task-notification> arrives with the result. To correct or add to one of its agents, write to it with cbase_agent_send to "wf:${runId}:<n>" (cbase_agents_list shows the agents and their numbers) — it keeps its work. Stop it with cbase_dynamic_workflow_stop and taskId ${taskId} only when the task as a whole no longer holds, then start anew.`,
    },
    go: () => {
      run2.end = run(run2, script, args, { old, journalNew: true }).catch((e) => runFailed(run2, e));
    },
  };
}

// The safety net of `run`: a throw — a database that refuses the ending, an output file that cannot be written, a
// delivery that throws itself — must not let the run end as "failed" WITHOUT a completion notice. The start tells the
// agent "end your turn, the result arrives as <task-notification>": a plain chat (without a holding graph step) would
// wait forever. So the same "failed" notice goes out as for a script error — exactly ONCE (`run.reported`: if `run`
// already delivered, that stands) and never after stop, deletion or server end (there `run` reports nothing either).
// Every step here stands in a safety net of its own: the safety net itself must not throw.
function runFailed(run2, e) {
  const errorText = String(e?.message || e || "").slice(0, 1000) || "(without Notice)";
  console.error("[dynworkflow] run", run2.runId, "failed:", errorText);
  try { store.endDynRun(run2.runId, { status: "failed", error: errorText, agentCount: run2.scheduled }); } catch { /* database gone */ }
  const report = !run2.stopped && !run2.silenced && !run2.serverEnd;
  if (report) marker(run2, "end", "failed"); // at most ONE end marker (marker checks `endMarker`)
  try { closeCore(run2); } catch (err) { console.error("[dynworkflow] closing the core:", err?.message || err); }
  active.delete(run2.runId);
  if (report && !run2.reported) {
    try {
      const chat = store.getChat(run2.chatId);
      if (chat) {
        let journalRows = [];
        try { journalRows = store.readDynJournal(run2.runId).map(({ at: _at, ...z }) => z); } catch { /* database gone */ }
        resultWrite(run2.outputPath, { runId: run2.runId, taskId: run2.taskId, name: run2.name, status: "failed", returnValue: null,
          error: errorText, events: run2.events, journal: journalRows });
        const text = completionNotice(run2, { status: "failed", returnValue: null, error: errorText, agentCount: run2.scheduled });
        run2.reported = true;
        deliverUserPrompt(chat, { prompt: text, display: text, cause: "agent" });
      }
    } catch (err) { console.error("[dynworkflow] notice:", err?.message || err); }
  }
  // Without a notice (stop) or after it: ask the holding turn again — not after deletion and not at the server end.
  if (!run2.silenced && !run2.serverEnd) {
    try { backgroundEnds(run2.chatId); } catch (err) { console.error("[dynworkflow] background:", err?.message || err); }
  }
}

// The output file of a run (end and abandonment). In the runtime folder through the descriptor: the project container
// sees `<runId>/result.json` as soon as the script lies next to it — a symlink in its place would let the server write
// the result over some other file. An error goes to the log.
function resultWrite(filePath, result) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  try { if (!writeInRuntimeFolder(filePath, text)) fs.writeFileSync(filePath, text); } catch (e) { console.error("[dynworkflow] output file:", e?.message || e); }
}

// The state of a run in this server run (the same for the start through the tool and for the restart).
// `instanceIdentifier`: the core's instance — an identifier `<project>/<instance>` (pinned), `null` (begun without an
// instance: no core in a project container) or `undefined` (the chat's current one: only after a restart for a run
// without a stored identifier).
function newRun({ runId, taskId, chatId, name, scriptPath, outputPath, callId, request = null, resumed = false, pot = potFor(), instanceIdentifier = undefined }) {
  return { runId, taskId, chatId, name, scriptPath, outputPath, callId: String(callId || ""), request, resumed, instanceIdentifier,
    // Budget and size warning: the turn's pot, the agent() calls, the ended agents and their tokens.
    pot, scheduled: 0, finished: 0, tokens: 0, warning: false,
    // Open background work (runs/background.js): since when, and in which graph step it started.
    startedAt: Date.now(), graph: null,
    sandbox: null, ctl: null, open: new Set(), events: [], end: null, stopped: false, silenced: false, serverEnd: false, endMarker: false, closed: false,
    // The completion notice has been delivered: the safety net of `run` then does not report a second time.
    reported: false,
    // Concurrency (cap.js): the run's slots under both caps and the prompt-cache stagger.
    slots: runSlots(runId), stagger: createStagger(),
    // Parking per provider (parking.js): who of which provider is parked; per agent() its entry (n → { key, slot,
    // parked }), read by `onImage` — the core's deposit that writes the park state into the journal.
    park: createProviderPark(), entries: new Map(), onImage: null,
    // The agent() calls whose value is going back from a resume's cache right now (message.js workflowTarget:
    // "finished" without an entry in `entries` and without a result in the new journal).
    fromCache: new Set() };
}

// The run's core — opened at the first agent(), with the chat's context without a turn (runs/do-run.js), held (`hold:
// true` — the reports go to the run, none as a completion notice to the chat) and OWN (see header).
function coreOf(run2, atEnd) {
  if (run2.ctl) return run2.ctl;
  const context = agentContextWithoutTurn(run2.chatId, run2.instanceIdentifier === undefined ? {} : { identifier: run2.instanceIdentifier });
  if (!context) throw new Error(T("The chat of this workflow no longer exists."));
  run2.ctl = openAgents({ ...context, hold: true, deliver: null }, {
    event: () => {},
    // What the core could no longer deliver to an agent (gate, stop, end) is "not_delivered" afterwards (message.js).
    // If the server ends (see interruptIfServerEnds), the run freezes BEFORE this end reaches the script or the
    // messages — only a result (the restart's cache) still enters the journal afterwards, never a `failed`.
    atEnd: (rec, info) => { run2.ctl?.takeReports(); interruptIfServerEnds(run2); reportUndelivered(run2, rec, info); atEnd(rec, info); },
    // The history of a workflow agent does not belong in the chat but in its transcript.
  }, { own: true, workflowAgent: true, frame: WORKFLOW_AGENT_FRAME, sink: (evt) => { if (!run2.silenced) transcript(run2, evt); },
    // The state of every agent at every sign of life: parking and continuing in the journal come from it (run: onImage).
    deposit: { remember: (image) => { try { run2.onImage?.(image); } catch (e) { console.error("[dynworkflow] park state:", e?.message || e); } }, row: () => {} } });
  return run2.ctl;
}

// The structured transcript of a workflow agent — the row shapes of subagents in the chat history (runs/agents.js),
// assigned through the call block `dynwf:<runId>:<n>` (the core puts it on every event).
const TEXT_MAX = 12000;
function transcript(run2, evt) {
  const m = /^dynwf:[^:]+:(\d+)$/.exec(String(evt?.parent_tool_use_id || ""));
  if (!m) return;
  const n = Number(m[1]);
  run2.stagger.firstEvent(n); // the first of a prefix has answered: the cache is written
  const row = (kind, fields) => {
    try { store.writeDynAgentRow(run2.runId, n, kind, fields); } catch (e) { console.error("[dynworkflow] transcript:", e?.message || e); }
    reportTree(run2); // the running agent's tokens in the tree
  };
  if (evt.type === "assistant") {
    for (const blk of evt.message?.content ?? []) {
      if (blk?.type === "text" && blk.text?.trim()) row("text", { text: String(blk.text).slice(0, TEXT_MAX) });
      else if (blk?.type === "thinking" && blk.thinking?.trim()) row("thinking", { text: String(blk.thinking).slice(0, TEXT_MAX) });
      else if (blk?.type === "tool_use") row("tool", { id: blk.id || "", name: blk.name || "", input: blk.input ?? {} });
    }
  } else if (evt.type === "user") {
    for (const blk of evt.message?.content ?? []) {
      if (blk?.type !== "tool_result" || !blk.tool_use_id) continue;
      const content = typeof blk.content === "string" ? blk.content
        : Array.isArray(blk.content) ? blk.content.map((c) => (c?.type === "text" ? c.text : `[${c?.type || "?"}]`)).join("\n") : "";
      row("tool-result", { id: blk.tool_use_id, text: String(content).slice(0, TEXT_MAX), error: Boolean(blk.is_error) });
    }
  }
}

// An agent has ended: its output goes into the turn's pot — at once, so that the next agent() sees it —, the state into
// the run's row (restart), and into the size calculation the same number as in the tree (consumption.js tokenSum:
// everything except cache reads). With the loop engine the reported number is a lower bound; it counts anyway.
function bookAgent(run2, info) {
  const u = info?.usage || {};
  run2.pot.book(Number(u.output) || 0);
  if (run2.pot.total !== null && !run2.silenced) {
    try { store.dynRunBudgetStatus(run2.runId, run2.pot.consumed()); } catch (e) { console.error("[dynworkflow] Budget:", e?.message || e); }
  }
  run2.finished++;
  run2.tokens += tokenSum(tokenParts(u, info?.billing));
  checkSize(run2);
}

// The size warning (size.js): ONCE per run, as event "warning" in the run (the tree reads it, the output file carries
// it) — never under ultracode.
function checkSize(run2) {
  if (run2.warning || run2.silenced) return;
  const w = sizesWarning({ scheduled: run2.scheduled, finished: run2.finished, tokens: run2.tokens, ultracode: Boolean(store.getChat(run2.chatId)?.ultracode) });
  if (!w) return;
  run2.warning = true;
  const count = (x) => Number(x).toLocaleString(T("en-US##locale"));
  const text = T`Large workflow: ${w.scheduled} agent() calls, ${count(w.tokens)} tokens spent, ${count(w.projected)} projected — above the warning threshold (more than 25 agents or 1.5M tokens). Stop it on the run or with cbase_dynamic_workflow_stop.`;
  if (run2.events.length < 500) run2.events.push({ kind: "warning", text, axis: w.axis, scheduled: w.scheduled, tokens: w.tokens, projected: w.projected });
  try { store.writeDynEvent(run2.runId, { kind: "warning", text, phase: null }); } catch (e) { console.error("[dynworkflow] warning:", e?.message || e); }
  reportTree(run2);
}

function closeCore(run2) {
  // Waiting calls drop out, occupied slots go back to the other runs, no stagger clock remains.
  run2.closed = true;
  run2.slots.close();
  run2.stagger.close();
  run2.park.close();
  const ctl = run2.ctl;
  run2.ctl = null;
  if (!ctl) return;
  if (run2.silenced) ctl.silence();
  try { ctl.close(); } catch (e) { console.error("[dynworkflow] core:", e?.message || e); }
}

// `alt`: the entries of the journal being resumed ([] = fresh run). `journalNew`: this run's journal is a different one
// than `alt` (fresh or resumeFromRunId) — then the cache hits are written into it too, so that a later resume from THIS
// run finds them; the restart continues the same journal and does not write them twice.
async function run(run2, script, args, { old = [], journalNew = true } = {}) {
  const { runId, chatId } = run2;
  const chain = createChain(old);
  const playback = createPlayback(old);
  let unanswered = 0;
  // If the script only stands on held hits, the playback releases the earliest (journal.js). "Stands" is measured by
  // the sandbox (`quiet()`); it is only asked after an event (hit held, agent finished), never in a loop.
  const checkQuiet = () => {
    if (!playback.heldCount()) return;
    Promise.resolve().then(() => run2.sandbox?.quiet()).then(() => {
      if (run2.stopped || run2.silenced || run2.serverEnd) return;
      const prior = playback.heldCount();
      playback.quiet({ onlyHeldOpen: unanswered > 0 && unanswered === prior });
      if (playback.heldCount() < prior) checkQuiet();
    }).catch((e) => console.error("[dynworkflow] playback:", e?.message || e));
  };
  const journal = (entry) => { if (!run2.silenced) { store.writeDynJournal(runId, entry); reportTree(run2); } };
  // The phase the script is in right now — for log() lines and failures (an agent() carries its own).
  let phaseNow = null;
  // An agent's end can arrive before its start returns — then it waits here.
  const waiters = new Map();
  const early = new Map();
  const atEnd = (rec, info) => {
    const w = waiters.get(rec.agentId);
    if (w) { waiters.delete(rec.agentId); w(info); } else early.set(rec.agentId, info);
  };
  const endOf = (agentId) => (early.has(agentId)
    ? Promise.resolve(early.get(agentId)).finally(() => early.delete(agentId))
    : new Promise((r) => waiters.set(agentId, r)));

  // ── Parking per provider (parking.js) ──
  // The park state from the journal the restart continues: per key the image of the agent that last parked at the
  // limit (neither continued nor finished afterwards). Its agent() then starts NO new process but picks it up parked —
  // with its wakeup at the reset (runs/agents.js, the same path as for subagents after a restart). A resume through
  // resumeFromRunId (new journal) runs it anew.
  const parkInJournal = new Map();
  if (!journalNew) {
    for (const e of old) {
      if (!e?.key) continue;
      if (e.kind === "waiting" && e.reason === "limit" && e.image?.agentId) parkInJournal.set(e.key, e.image);
      else if (e.kind === "started" || e.kind === "result" || e.kind === "failed") parkInJournal.delete(e.key);
    }
  }
  // An agent's image at every sign of life (the core's deposit): the transition to "parked" is written to the journal
  // as "waiting" with reason "limit" and the image (the restart picks it up from that), frees its slot under the caps
  // and holds new agents of THIS provider; the transition back is written as "started" (continued) and takes a slot
  // again — without waiting for it (the process is already running; the cap may be exceeded briefly for that).
  run2.onImage = (image) => {
    const m = /^dynwf:[^:]+:(\d+)$/.exec(String(image?.parentToolUseId || ""));
    const e = m ? run2.entries.get(Number(m[1])) : null;
    if (!e || e.end || run2.closed) return;
    if (image.state === "parked" && !e.parked) {
      e.parked = true;
      e.agentId = String(image.agentId || "");
      journal({ kind: "waiting", n: e.n, key: e.key, phase: e.ph, reason: "limit", provider: image.provider, agentId: e.agentId,
        until: Number(image.parkedUntil) || 0, resetsAt: Number(image.resetsAt) || 0, image });
      const f = e.approve;
      e.approve = null;
      f?.();
      run2.park.parks(e.provider, e.agentId);
    } else if (image.state === "running" && e.parked) {
      e.parked = false;
      run2.park.further(e.provider, e.agentId);
      journal({ kind: "started", n: e.n, key: e.key, phase: e.ph, agentId: e.agentId, resumed: true });
      // The process is already running: this slot does not ask the storage gate (cap.js, `storage: false`).
      run2.slots.request({ storage: false }).then((f) => { if (!f) return; if (e.end || e.parked || e.approve) f(); else e.approve = f; });
    }
  };
  // The credit gate for an agent's provider (the core asks it before EVERY start — here only the reading for workflow
  // agents: wait instead of fail). null ⇒ start; otherwise the state and when to ask again (reset of the window,
  // unknown ⇒ in growing steps as with parking, limits.probeDelayMs). For providers other than Claude the gate knows
  // no verdict — it answers ok, and none is invented.
  const gateFor = async (target, attempt) => {
    let u;
    // The core's project: once the core exists, the agent works in ITS project — even if the chat has switched in the
    // meantime. Before the first agent() there is no core; then the chat's, with which it is about to be opened.
    const projectId = run2.ctl?.project || null;
    // And the core's instance (its identifier) — the lock judges it, not the chat's.
    const identifier = projectId ? run2.ctl?.instance || null : null;
    // The next agent belongs to this run — the "layout" lock lets it through in `waiting` when the run began before the
    // job (`parentSince`).
    try { u = await startGateVerdict({ provider: target.provider, model: target.model, chatId, purpose: "agent", ...(projectId ? { projectId } : {}), ...(identifier ? { identifier } : {}), parentSince: run2.startedAt }); } catch { return null; }
    if (!u || u.ok === true) return null;
    // The per-project lock answers at the same gate: "wait" (the instance is starting or being recreated, the server
    // is ending) means waiting instead of failing here too; "reject" (relocation) and "error" let the start through —
    // there the core rejects it with a reason (runs/agents.js), and the agent fails visibly.
    if (u.project) return u.project.kind === "wait" ? { project: u.project } : null;
    const reset = Number(u.window?.resetsAt) || 0;
    return { percent: typeof u.percent === "number" ? u.percent : null, window: String(u.window?.label || u.window?.group || ""),
      until: reset > Date.now() ? reset : Date.now() + probeDelayMs(attempt) };
  };
  // A slot for agent `e`: first no parked agent of its provider, then the gate, then the caps with the storage gate.
  // → true (slot in e.approve) · false (run closed) · { nullReason } (auto-continue off: do not park, agent() yields null).
  const slotTake = async (e, target) => {
    let gateAttempt = 0;
    for (;;) {
      if (interruptIfServerEnds(run2) || run2.closed) return false;
      if (run2.park.parked(target.provider)) {
        journal({ kind: "waiting", n: e.n, key: e.key, phase: e.ph, reason: "limit", provider: target.provider });
        await run2.park.wait(target.provider);
        continue;
      }
      const gate = await gateFor(target, gateAttempt);
      // The lock of a relocated project answers "wait" at the server end — at the server's OWN end no waiting enters the
      // journal: the run freezes, the restart starts the agent anew (with the foreign marker alone it waits).
      if (interruptIfServerEnds(run2) || run2.closed) return false;
      // At the project lock: not a limit, so wait even with auto-continue off — until the instance is `ready`
      // (projectbox/idle.js wakeProject → wakeProjectWaiting) or the run closes.
      if (gate?.project) {
        journal({ kind: "waiting", n: e.n, key: e.key, phase: e.ph, reason: "project", provider: target.provider,
          state: String(gate.project.state || gate.project.reason || "") });
        await run2.park.atProject({ until: Date.now() + projectCheckBackMs(), wakeup: setParkWakeup });
        continue;
      }
      if (gate) {
        if (!autoContinueEnabled()) {
          return { nullReason: `credit gate: ${gate.window || "?"} at ${gate.percent ?? "?"} % for ${target.provider} — auto-continue is off, the agent does not wait` };
        }
        gateAttempt += 1;
        journal({ kind: "waiting", n: e.n, key: e.key, phase: e.ph, reason: "credit-gate", provider: target.provider, percent: gate.percent, window: gate.window, until: gate.until });
        await run2.park.atGate({ until: gate.until, wakeup: setParkWakeup });
        continue;
      }
      // Under both caps AND at the storage gate (cap.js): whoever waits for memory is in the journal as "waiting" with
      // reason "storage" and the text of the situation — the arbiter (workflows/storage-queue.js) releases it.
      const f = await run2.slots.request({
        waiting: (cap) => journal({ kind: "waiting", n: e.n, key: e.key, phase: e.ph, reason: "cap", cap }),
        waitingForStorage: (situation) => journal({ kind: "waiting", n: e.n, key: e.key, phase: e.ph, reason: "storage", ...(situation ? { situation } : {}) }),
      });
      // At the server end the core stays open (see run): the slot of an agent that ends regularly within the window
      // goes to a waiting call — which no longer starts.
      if (!f || interruptIfServerEnds(run2) || run2.closed) { f?.(); return false; }
      if (run2.park.parked(target.provider)) { f(); continue; } // an agent of the provider parked while waiting for the slot
      e.approve = f;
      return true;
    }
  };
  // An agent() that yields null names itself in log() — otherwise the gap would pass as a complete result.
  const nullLog = ({ label, n, agentId = "", reason }) => {
    const who = `agent ${label ? `“${label}”` : `#${n}`}${agentId ? ` (${agentId})` : ""}`;
    event({ kind: "log", text: `${who} returned null — ${String(reason || "no result").split("\n").filter(Boolean).slice(0, 2).join(" · ").slice(0, 500)}` });
  };

  const event = (e) => {
    if (e?.kind === "phase") phaseNow = e.title ?? null;
    if (run2.events.length < 500) run2.events.push(e);
    // Persisted: phase()/log() lines and failures — the tree reads them from there.
    if (!run2.silenced) {
      try { store.writeDynEvent(runId, { kind: e.kind, text: e.kind === "phase" ? e.title : e.text, phase: phaseNow }); } catch (x) { console.error("[dynworkflow] event:", x?.message || x); }
      reportTree(run2);
    }
  };

  // StructuredOutput (structured.js): if the turn ended without a valid call, the run follows up ONCE — not after the
  // cap of failed attempts, not for a failed or stopped agent, not during a stop.
  const followUp = async (agentId, info, output) => {
    let followedUp = false;
    for (;;) {
      const st = output.snapshot();
      if (st.accepted || followedUp || st.failedAttempts >= FAILED_ATTEMPTS_MAX || info?.report?.status !== "completed" || run2.closed || !run2.ctl || run2.serverEnd) break;
      followedUp = true;
      try { await run2.ctl.send({ agentId, message: FOLLOW_UP }); } catch (e) { console.error("[dynworkflow] follow-up:", e?.message || e); break; }
      info = await endOf(agentId);
    }
    return { info, followedUp };
  };

  // `lane`: the caller's lane (sandbox.js, journal.js "branches") — `null` in the root and in the linear chain.
  const agent = ({ n, prompt, opts = {}, phase, workflow }, lane = null) => {
    // Once the server is ending, no agent() begins any more — neither journal nor slot nor process: the run freezes
    // (the answer no longer reaches the aborted script), and the restart calls it again.
    if (interruptIfServerEnds(run2)) return Promise.resolve(null);
    const chat = store.getChat(chatId);
    if (!chat) throw new Error(T("The chat of this workflow no longer exists."));
    // The agent type BEFORE everything else: an unknown one throws with the list, without journal and process. First
    // because its model applies when the call names none.
    const { type, model: typeModel } = agentTypeOf(opts, () => coreOf(run2, atEnd).types());
    // Model and effort BEFORE everything else: a throw here starts nothing and writes no journal.
    const target = resolveAgentModel(opts.model ?? (typeModel || undefined), chat);
    const level = effortSavable(opts.effort === null || opts.effort === undefined ? undefined : opts.effort);
    if (level.kind === "unknown") throw new Error(`agent(): Unknown effort level “${String(opts.effort).slice(0, 40)}”. Allowed: 'low' | 'medium' | 'high' | 'xhigh' | 'max' — or omit effort.`);
    // The schema likewise BEFORE everything else: an unsatisfiable one throws, without journal and without an agent process.
    const schema = opts.schema === undefined || opts.schema === null ? null : opts.schema;
    const check = schema ? checkSchema(schema) : null;
    // In the journal key the type is always `agentType` — even if the script wrote `subagent_type`.
    const typeInKey = opts.subagent_type != null ? { agentType: opts.agentType ?? opts.subagent_type, subagent_type: undefined } : {};
    // Clamped to ITS model, the same calculation as at the spawn (runs/agents.js buildSpec) — like that in the key.
    const effort = level.kind === "level" ? effortRunning(target.provider, target.model, level.level) : "";
    // The key under which the same call stands in the journal from BEFORE its model was retired: per retired
    // predecessor the same options with its name and the effort IT carried.
    const fallback = predecessorOf(target.provider, target.model).map((v) => normOptions(
      { ...opts, ...typeInKey, effort: level.kind === "level" ? effortFallback(level.level, v.oldEfforts) : "" }, { model: `${target.provider}::${v.old}`, kind: chain.kind }));
    const segment = chain.further(prompt, normOptions({ ...opts, ...typeInKey, effort }, { model: target.ref, kind: chain.kind }), fallback, lane);
    const { key, cache } = segment;
    // Every `launched` names the chain kind of its run (journal.js chainKindOf: if missing, it was the linear one).
    const kindField = { chain: chain.kind };
    // A LIVE agent with a result: if the lane continues "replaced" behind it (journal.js), the result says so.
    const replacedField = (agentId) => (segment.result(agentId) ? { replaced: String(agentId ?? "") } : {});
    run2.scheduled = Math.max(run2.scheduled, n);
    checkSize(run2);
    const label = typeof opts.label === "string" ? opts.label : "";
    const ph = phase ?? null;
    // An agent() from a child (workflow()) is in the journal of THIS run, with the child's name.
    const kindField2 = typeof workflow === "string" ? { workflow } : {};
    if (cache) {
      // From the journal: no start, no spawn — the value goes back in the old completion order.
      if (journalNew) journal({ kind: "launched", n, key, label, phase: ph, prompt, opts, provider: target.provider, model: target.model, effort, ...kindField2, ...kindField });
      unanswered++;
      run2.fromCache.add(n);
      const p = new Promise((gib) => {
        playback.hold(key, () => {
          // A changed worktree of the old run is still there — it belongs in THIS run's notice too.
          // `replaced` travels along: a resume from THIS run must take the same detour behind the hit (journal.js).
          if (journalNew) journal({ kind: "result", n, key, phase: ph, value: cache.value, fromCache: true, ...(cache.worktree ? { worktree: cache.worktree } : {}), ...(cache.replaced !== undefined ? { replaced: cache.replaced } : {}) });
          unanswered--;
          run2.fromCache.delete(n);
          gib(cache.value);
        });
      });
      checkQuiet();
      return p;
    }
    journal({ kind: "launched", n, key, label, phase: ph, prompt, opts, provider: target.provider, model: target.model, effort, ...kindField2, ...kindField });
    unanswered++;
    const job = framedJob(prompt, run2.request);
    try { store.writeDynAgentRow(runId, n, "job", { text: job }); } catch (e) { console.error("[dynworkflow] transcript:", e?.message || e); }
    // This agent()'s entry for parking and slot (see onImage/slotTake).
    // `skipped` is set ONLY by the "skip" action (skipDynAgent) — the marker in the journal follows it, not the
    // report's status "stopped".
    // message.js: label (alias of the run address), what was earmarked before the start — after a restart the messages
    // from the continued journal —, what arrived during the start, and the StructuredOutput reference (after a message
    // the newest object counts).
    const e = { n, key, ph, provider: target.provider, agentId: "", approve: null, parked: false, end: false, skipped: false,
      label: label || `workflow-agent ${n}`, earmarked: journalNew ? [] : messagesFromJournal(old, key), afterStart: [], starting: false, output: null };
    run2.entries.set(n, e);
    const gibSlot = () => { const f = e.approve; e.approve = null; f?.(); };
    const p = (async () => {
      let start = null;
      // Restart of an agent parked at the limit: pick it up parked, do NOT start anew — it continues at the reset (its
      // wakeup), and until then it occupies no slot. Not with a schema: the StructuredOutput messenger depends on a
      // reference of this server run — the agent then runs anew.
      const image = check ? null : parkInJournal.get(key);
      if (image) {
        parkInJournal.delete(key);
        e.agentId = String(image.agentId);
        e.parked = true;
        let a = null;
        try { a = coreOf(run2, atEnd).pickUpParked(image); } catch (x) { console.error("[dynworkflow] park state not picked up:", x?.message || x); }
        if (a?.status === "parked") {
          run2.park.parks(e.provider, e.agentId);
          start = { agentId: a.agentId };
          // Also into the journal as "waiting" in the new attempt: the tree reads from the last `launched` on, and
          // without this entry the parked agent would show as "running" after every deploy (without an agent id, hence
          // without a live record). With the image: another restart picks it up the same way.
          journal({ kind: "waiting", n: e.n, key: e.key, phase: e.ph, reason: "limit", provider: image.provider || e.provider, agentId: e.agentId,
            until: Number(image.parkedUntil) || 0, resetsAt: Number(image.resetsAt) || 0, image, pickedUp: true });
          // It continues its session: what the session knows does not go in again — only what was earmarked while parked.
          e.earmarked = [];
          // What the park state brought back itself (agent-runtime: follow-ups after its turn and what was earmarked
          // while parked from before the image) does not go in a second time.
          const already = new Set((Array.isArray(image.supplyLater) ? image.supplyLater : []).map((x) => String(x?.messageId || "")).filter(Boolean));
          await earmarkParked(run2, e, messagesFromJournal(old, key, { afterParking: true }), already);
        } else { e.parked = false; e.agentId = ""; }
      }
      let output = null;
      if (!start) {
        // A slot under both caps, before that no parked agent of the same provider and the credit gate. Whoever does
        // not start at once is in the journal as "waiting" with a reason (limit · credit-gate · project · cap · storage
        // · stagger) — a waiting agent can be told from a hanging or finished one. The key is already fixed (above, in
        // call order); waiting does not change it.
        const free = await slotTake(e, target);
        if (free === false) return null; // run stopped, deleted or ended before a slot freed up
        if (free !== true) {
          nullLog({ label, n, reason: free.nullReason });
          journal({ kind: "failed", n, key, phase: ph, error: free.nullReason });
          return null;
        }
        // The reference under which this agent's StructuredOutput messenger checks in the server — open until agent() answers.
        output = check ? openOutput({ chatId, check }) : null;
        e.output = output;
        let passedAlong = [];
        try {
          // Prompt-cache staggering: the first of a prefix starts at once, the rest after its first event.
          const prefix = `${target.provider}::${target.model}::${type}`;
          const stagger = run2.stagger.before(prefix, n, { prefixCache: Boolean(getConnector(target.provider)?.caps?.prefixCache) });
          if (stagger) {
            journal({ kind: "waiting", n, key, phase: ph, reason: "stagger" });
            await stagger;
            // The stagger releases as soon as the first delivers its first event — also after the server end (the core
            // stays open, see run): then no process starts any more.
            if (interruptIfServerEnds(run2) || run2.closed) { output?.close(); return null; }
          }
          // agentType, isolation and repo go to the core like the arguments of cbase_agent: role and tool list of the
          // definition (cut through the workflow agents' marker), the repo (agent-runtime — ambiguous ⇒ throw with the
          // list, BEFORE any process). The model: the call's, otherwise the type's, otherwise the chat's — `model`
          // always goes along explicitly.
          // Earmarked messages (message.js) stand as fenced blocks BEHIND the job — in its first request; what arrives
          // during the start is collected in `afterStart` and goes in through the core right afterwards.
          passedAlong = e.earmarked.splice(0);
          const jobNow = jobWithMessages(job, passedAlong);
          e.starting = true;
          start = await coreOf(run2, atEnd).start(
            { description: label || `workflow-agent ${n}`, prompt: jobNow, run_in_background: true, model: target.ref, ...(effort ? { effort } : {}),
              ...(type ? { subagent_type: type } : {}), ...coreIsolation(opts) },
            { parentToolUseId: `dynwf:${runId}:${n}`, ...(output ? { structure: { schema, reference: output.reference, frame: STRUCTURE_FRAME } } : {}) },
          );
        } catch (x) {
          e.starting = false;
          run2.stagger.end(n);
          output?.close();
          interruptIfServerEnds(run2); // a start that fails at the server end is interrupted
          // No process saw the job: the messages passed along go back, and the finally reports them as "not_delivered"
          // (reportLeftBehind). At the server end they stay — the restart appends them again.
          if (!run2.serverEnd) e.earmarked.unshift(...passedAlong);
          // An agent the server end aborted is INTERRUPTED, not failed: without an entry it does not break the
          // restart's prefix and runs anew there.
          if (!run2.serverEnd) journal({ kind: "failed", n, key, phase: ph, error: String(x?.message || x) });
          throw x;
        }
        e.agentId = start.agentId;
        e.starting = false;
        journal({ kind: "started", n, key, phase: ph, agentId: start.agentId });
        if (e.afterStart.length) deliverAfterStart(run2, e).catch((x) => console.error("[dynworkflow] message:", x?.message || x));
      }
      let info;
      let followedUp = false;
      try {
        info = await endOf(start.agentId);
        if (output) ({ info, followedUp } = await followUp(start.agentId, info, output));
      } finally { run2.stagger.end(n); output?.close(); }
      // rec.usage counts across the continuation (agent-runtime); it is booked ONCE with the state after the follow-up.
      bookAgent(run2, info);
      const rep = info?.report || {};
      const aborted = run2.serverEnd || run2.stopped || run2.silenced;
      // A CHANGED worktree stays in place (the core only removes unchanged ones) and is in the journal — from there the
      // completion notice names it, also after a restart. Named, never silently deleted.
      const wt = rep.worktree ? { worktree: { dir: String(rep.worktree), agentId: start.agentId } } : {};
      // For the tree: the consumption from the report, with its kind — a lower bound for the loop engine — and its
      // parts (input, cache, output; shown on hover). Skipping (the stop of ONE workflow agent) counts as failed but
      // carries its marker: the agent was stopped, the run was not — as long as the core is open (`closed`: stop, script
      // error and end close it and thereby end the agents still running; those are not skipped).
      const parts = info?.usage ? tokenParts(info.usage, info.billing) : null;
      const consumption = { ...(typeof rep.totalTokens === "number" ? { tokens: rep.totalTokens } : {}), ...(rep.tokenKind ? { tokenKind: rep.tokenKind } : {}),
        ...(parts && tokenSum(parts) + parts.cacheRead > 0 ? { tokenParts: parts } : {}) };
      const skipped = e.skipped && rep.status === "stopped" && !run2.closed && !run2.silenced && !run2.serverEnd ? { skipped: true } : {};
      // The reason in log(): for skipping the baseline's wording ("the user skips the agent"), not that of the stop.
      const nullReason = skipped.skipped ? "skipped by the user" : [rep.error || rep.status, rep.notes].filter(Boolean).join("\n");
      if (output) {
        // With a schema the value is the checked object — never the last text. Without a valid object: null, and log()
        // names the agent.
        const st = output.snapshot();
        if (st.accepted) {
          journal({ kind: "result", n, key, phase: ph, agentId: start.agentId, ...wt, value: st.object, ...consumption, ...replacedField(start.agentId) });
          return st.object;
        }
        if (aborted) return null;
        const text = rep.status === "completed" ? withoutResultText({ label, n, agentId: start.agentId, snapshot: st, followedUp }) : null;
        if (text) event({ kind: "log", text });
        else nullLog({ label, n, agentId: start.agentId, reason: nullReason });
        journal({ kind: "failed", n, key, phase: ph, agentId: start.agentId, ...wt, error: text || String(rep.error || rep.status || "no result"), ...consumption, ...skipped });
        return null;
      }
      if (rep.status === "completed") {
        const value = sanitizeResult(String(rep.report ?? ""));
        journal({ kind: "result", n, key, phase: ph, agentId: start.agentId, ...wt, value, ...consumption, ...replacedField(start.agentId) });
        return value;
      }
      // Failed (limit without auto-continue, stall after the restarts, crash): null, and log() names the agent — not
      // when the whole run was aborted. It is in the journal anyway (except at the server end): the tree reads
      // "stopped" or "skipped" from it.
      if (!aborted) nullLog({ label, n, agentId: start.agentId, reason: nullReason });
      if (!run2.serverEnd) journal({ kind: "failed", n, key, phase: ph, agentId: start.agentId, ...wt, error: String(rep.error || rep.status || "no result"), ...consumption, ...skipped });
      return null;
    })().finally(() => {
      reportLeftBehind(run2, e);
      e.end = true;
      gibSlot();
      if (e.parked) { e.parked = false; run2.park.further(e.provider, e.agentId); }
      if (run2.entries.get(n) === e) run2.entries.delete(n);
    });
    run2.open.add(p);
    const finished = () => { run2.open.delete(p); unanswered--; playback.done(key); checkQuiet(); };
    p.then(finished, finished);
    return p;
  };

  if (!run2.resumed) marker(run2, "start"); // a restart continues the run, it does not begin it
  reportGlobal(run2, true);
  run2.sandbox = startScript({
    script, args,
    // The turn's budget: `budget.total` in the script, the counter is the pot (main run + agents).
    budget: { total: run2.pot.total, consumed: run2.pot.consumed },
    host: {
      agent,
      // The forks of parallel()/pipeline() (journal.js "branches"). In the linear chain (a run that continues an old
      // linear journal) there are no lanes — then the sandbox tracks none either.
      ...(chain.kind === "branches" ? { fork: (b, variety) => chain.fork(b, variety) } : {}),
      // workflow() in the script: hostWorkflow — looked up at every call, a throw is the error of the call.
      workflow: hostWorkflow(chatId, run2),
      event,
    },
  });
  // If the server already ended during the script's synchronous beginning (there is no `run.sandbox` yet, interrupting
  // could not abort it): now, before an answer goes in (it comes in the next microtask at the earliest).
  if (run2.serverEnd) run2.sandbox.abort();
  const r = await run2.sandbox.end;
  // Agents the script did not wait for run to their end — their consumption belongs to the run. Not on an error or
  // stop: then the core closes them.
  if (r.ok && !run2.stopped && !run2.silenced && !run2.serverEnd) await Promise.allSettled([...run2.open]);
  // At the server end: the script is aborted, the CORE stays open — its agents keep working until `server.close`, and
  // whoever ends WITH a result within the window is in the journal (the restart serves it from the cache).
  // `dynWorkflowsAtServerEnd` closes it and takes it out of `active`; no new agent starts until then (agent(), slotTake
  // and the stagger ask interruptIfServerEnds). No notice.
  if (run2.serverEnd) return;
  closeCore(run2);
  active.delete(runId);
  if (run2.stopped || run2.silenced) { // stop through the tool, deletion: no notice
    // Stopped without a completion notice: a turn that waited for this workflow (graph step) asks again — otherwise it
    // would hold forever. After deletion there is no such turn any more.
    if (run2.stopped && !run2.silenced) backgroundEnds(chatId);
    return;
  }
  const status = r.ok ? "finished" : "failed";
  const errorText = r.ok ? "" : `${r.error?.name && r.error.name !== "Error" ? `${r.error.name}: ` : ""}${r.error?.text || ""}`;
  store.endDynRun(runId, { status, error: errorText, returnValue: r.ok ? r.returnValue : null, agentCount: r.agentCount });
  marker(run2, "end", status); // before the completion notice: the marker is in the history before the follow-up turn begins
  const result = {
    runId, taskId: run2.taskId, name: run2.name, status, returnValue: r.ok ? r.returnValue : null, error: errorText || null,
    failures: r.failures || [], events: run2.events, journal: store.readDynJournal(runId).map(({ at: _at, ...e }) => e),
  };
  const worktrees = changedWorktrees(runId);
  if (worktrees.length) result.worktrees = worktrees; // only with changed ones — otherwise the file stays as it was
  resultWrite(run2.outputPath, result);
  const chat = store.getChat(chatId);
  if (!chat) return;
  const text = completionNotice(run2, { status, returnValue: result.returnValue, error: errorText, agentCount: r.agentCount, worktrees });
  run2.reported = true; // before delivery: if it throws, the safety net (runFailed) does not deliver a second time
  deliverUserPrompt(chat, { prompt: text, display: text, cause: "agent" });
  // AFTER delivery: a holding turn has then already taken in the completion notice (wait phase) and only asks again at
  // its end — asked earlier, it would close its input before the notice arrives.
  backgroundEnds(chatId);
}

// The completion notice in the format of runs/completionNotice.js (the same kind: web and iOS show it as a system
// row, the name is in <name>) — with the workflow's identifiers instead of a subagent's.
function completionNotice(run2, { status, returnValue, error: errorText, agentCount, worktrees = [] }) {
  const finished = status === "finished";
  const full = returnValue === null || returnValue === undefined ? "" : (typeof returnValue === "string" ? returnValue : JSON.stringify(returnValue, null, 2));
  const result = full.length > FINISHED_RESULT_MAX ? `${full.slice(0, FINISHED_RESULT_MAX)}\n[… truncated — the full result is in the output file]` : full;
  const summary = finished ? `Workflow "${run2.name}" completed` : `Workflow "${run2.name}" failed: ${String(errorText || "").split("\n")[0].slice(0, 300)}`;
  const hint = [
    `Run id ${run2.runId}, script ${run2.scriptPath}, agent() calls: ${Number(agentCount) || 0}.`,
    finished ? "The result, the journal per agent() and the log() lines are in the output file."
      : "What happened until then (journal per agent(), log() lines) is in the output file. Change the script at the path and start again with scriptPath.",
    ...(worktrees.length ? [worktreeRow(worktrees)] : []),
  ].join("\n");
  return [
    FINISHED_MARKER,
    `<task-id>${xml(run2.taskId)}</task-id>`,
    ...(run2.callId ? [`<tool-use-id>${xml(run2.callId)}</tool-use-id>`] : []),
    `<output-file>${xml(run2.outputPath)}</output-file>`,
    `<status>${finished ? "completed" : "failed"}</status>`,
    `<name>${xml(run2.name)}</name>`,
    `<summary>${xml(summary)}</summary>`,
    `<result>${xml(result)}</result>`,
    finished ? `<diagnostics>${xml(hint)}</diagnostics>` : `<recovery>${xml(hint)}</recovery>`,
    "<note>This is a system message about your dynamic workflow, not a user reply. Evaluate it and continue working.</note>",
    "</task-notification>",
  ].join("\n");
}

// The two stop paths: the agent through `cbase_dynamic_workflow_stop` (`from: "agent"`) and the human through the
// UI's route (`from: "human"`). The ending is the same; the only difference is who learns of it. Neither sends a
// completion notice (it would wake the chat). If the agent stops, there is no notice at all, as in the baseline — it
// knows. If the human stops, the stop deposits a SILENT hint (runs/hints.js): the next turn carries it, an idle chat
// is not woken, no turn queued, no wait row — so the agent does not wait for a result that never comes. That is the
// same path as for the human stop of a subagent (runs/agents.js) and for orphans.
//
// End and stop crossing: exactly ONE arrives. The hint is only created if THIS call ended the run — the run is still
// in `active`, nobody stopped it before, and the row went from "running" to "stopped". `run` takes the run out of
// `active` and delivers the completion notice in the SAME synchronous step after reading `stopped`; a stop afterwards
// no longer finds it (200, `running: false`, no hint), a stop before sets `stopped`, and `run` reports nothing.
const STOP_OF = new Set(["human", "agent"]);

function stopHint(run2) {
  return T`The dynamic workflow "${run2.name}" (run id ${run2.runId}, task id ${run2.taskId}) was stopped by the human. No <task-notification> will arrive — what happened until then (journal per agent()) is in the run; the script is at ${run2.scriptPath}.`;
}

/**
 * End run and agents, without a completion notice. `id` = task id or run id; `from` is required ("human" | "agent" — a
 * missing originator is not a statement) and is stored in the run's row afterwards.
 */
export function stopDynWorkflow(chatId, id, { from } = {}) {
  if (!STOP_OF.has(from)) throw new Error(`stopDynWorkflow: from must be "human" or "agent", was ${JSON.stringify(from)}`);
  const who = String(id || "").trim();
  if (!who) return errorText(400, "id", T("Field \"taskId\" is missing."));
  const row = store.dynRunInChat(chatId, who);
  if (!row) return errorText(404, "unknown", T`No dynamic workflow "${who}" in this chat.`);
  const run2 = active.get(row.runId);
  // Already ended (finished, failed, stopped, interrupted), in the middle of a stop or frozen at the server end (its
  // row is "interrupted", its core stays open until `close`, see run): nothing changes.
  if (!run2 || run2.stopped || run2.serverEnd) {
    const now = store.readDynRun(row.runId) || row;
    return { status: 200, body: { ok: true, taskId: row.taskId, runId: row.runId, status: now.status, running: false, stoppedOf: now.stoppedOf || null } };
  }
  run2.stopped = true;
  const ended = store.endDynRun(row.runId, { status: "stopped", stoppedOf: from });
  marker(run2, "end", "stopped"); // the completion notice is omitted (baseline), the end marker is not
  run2.sandbox?.abort();
  closeCore(run2);
  if (ended && from === "human") depositHint(chatId, stopHint(run2), { source: "dynworkflow-stop" });
  return { status: 200, body: { ok: true, taskId: row.taskId, runId: row.runId, status: "stopped", running: false, stoppedOf: from } };
}

// ── Skip and restart per workflow agent ─────────────────────────────────────────────────────────────────────────
// The two actions on a row of the tree, 1:1 like Claude Code's view — there is no third word ("stop per agent"), the
// stop of the WHOLE workflow stays at the header (stopDynWorkflow). Both go through the run's core, which owns the
// agent; `n` is the number of its agent() call. Neither is a human stop of the workflow: no silent hint to the main
// agent, the run keeps running.
//   Skip: the agent ends (stop in the core), agent() yields null, in the journal "failed" with the marker `skipped`
//     (run) — at a later resume it breaks the cache prefix like any failed one (journal.js).
//   Restart: the running attempt ends, the same job starts anew (agent-runtime restart, the same path as the stall
//     restart); the script gets the new attempt's result. The journal holds `{ kind: "restart", from: "human" }` — the
//     tree counts them (`restarts`); the entry does not count for the prefix.
function interventionTarget(chatId, id, n) {
  const who = String(id || "").trim();
  const row = who ? store.dynRunInChat(chatId, who) : null;
  if (!row) return { f: errorText(404, "unknown", T`No dynamic workflow "${who}" in this chat.`) };
  const run2 = active.get(row.runId);
  if (!run2 || run2.stopped || run2.closed || run2.silenced || run2.serverEnd) {
    return { f: errorText(409, "run-closed", T`The workflow "${row.name}" is no longer running.`) };
  }
  const e = run2.entries.get(Number(n));
  if (!e || e.end) return { f: errorText(409, "agent-closed", T`Agent ${n} is not running (finished, failed or never called).`) };
  if (!e.agentId || !run2.ctl) return { f: errorText(409, "not-started", T`Agent ${n} is still waiting to start.`) };
  return { run: run2, e };
}

export function skipDynAgent(chatId, id, n) {
  const { f, run: run2, e } = interventionTarget(chatId, id, n);
  if (f) return f;
  e.skipped = true;
  if (!run2.ctl.stop(e.agentId, { ofHuman: true })) {
    e.skipped = false;
    return errorText(409, "agent-closed", T`Agent ${n} is no longer known to the run.`);
  }
  return { status: 200, body: { ok: true, runId: run2.runId, n: e.n, agentId: e.agentId, status: "skipped" } };
}

export function restartDynAgent(chatId, id, n) {
  const { f, run: run2, e } = interventionTarget(chatId, id, n);
  if (f) return f;
  const r = run2.ctl.restart(e.agentId);
  if (!r?.ok) return errorText(409, "running-not", T`Agent ${n} is not running right now (parked or between turns) — a restart only works mid-attempt.`);
  try { store.writeDynJournal(run2.runId, { kind: "restart", n: e.n, key: e.key, phase: e.ph, agentId: e.agentId, from: "human" }); } catch (x) { console.error("[dynworkflow] journal:", x?.message || x); }
  reportTree(run2);
  return { status: 200, body: { ok: true, runId: run2.runId, n: e.n, agentId: e.agentId, restart: true } };
}

// ── The ruling at the approval card (approval.js) ───────────────────────────────────────────────────────────────
// The UI's route (dynworkflows/routes.js) — both fields required, a missing one is not a statement. Every card is
// decided EXACTLY once: there is no await between `readCard` and `writeRuling`, a second click finds the ruling and
// changes nothing (409). Accepting starts the run like a start with opt-in (afterwards as always: marker, completion
// notice) and deposits a SILENT hint for the agent (it does not wake — the completion notice does). Rejecting never
// starts anything; the agent learns it as a SYSTEM MESSAGE (cause "agent", shape of a completion notice without
// <status> and <name> — web and iOS show "system message"), never as human input.
const DECISIONS = new Map([["accept", "accepted"], ["reject", "rejected"]]);

function rejectionNotice(card, job) {
  return [
    FINISHED_MARKER,
    `<task-id>${xml(card.requestId)}</task-id>`,
    ...(job?.callId ? [`<tool-use-id>${xml(job.callId)}</tool-use-id>`] : []),
    `<summary>${xml(`Workflow "${card.name}" was rejected by the user`)}</summary>`,
    `<result>${xml(T`The user rejected the approval card of the dynamic workflow "${card.name}". Nothing ran. Do not start it again; do the task without a workflow or ask the user how they want to proceed.`)}</result>`,
    "<note>This is a system message about your dynamic workflow, not a user reply. Evaluate it and continue working.</note>",
    "</task-notification>",
  ].join("\n");
}

/** POST /api/chats/:id/dyn-workflows/approval — `{ requestId, decision: "accept"|"reject" }`. */
export function decideApproval(chatId, b = {}, { beforeRuling = null } = {}) {
  const requestId = typeof b?.requestId === "string" ? b.requestId.trim() : "";
  if (!requestId) return errorText(400, "requestId", T("Field \"requestId\" is missing: the card being decided."));
  const word = typeof b?.decision === "string" ? DECISIONS.get(b.decision) : undefined;
  if (!word) return errorText(400, "decision", T("Field \"decision\" is missing or unknown: \"accept\" or \"reject\"."));
  const chat = store.getChat(chatId);
  if (!chat) return errorText(404, "chat", T("Chat not found."));
  // Fresh from the DB (the chat routes' lock read the chat before the body): nothing starts in the archive.
  if (chat.archivedAt) return { status: 409, body: { archived: true, error: T("The chat is archived — read only. Restore it first.") } };
  const k = readCard(chatId, requestId);
  if (!k) return errorText(404, "unknown", T("No such approval card in this chat."));
  if (k.ruling) {
    return { status: 409, body: { reason: "decided", decision: k.ruling.decision, error: T("This card has already been decided.") } };
  }
  const job = readJob(chatId, requestId);
  if (word === "rejected") {
    // `beforeRuling` (dynworkflows/routes.js): a graph step that holds at this card runs again BEFORE the notice
    // starts a turn — otherwise the turn would end at a waiting run, and nobody would judge it.
    beforeRuling?.(requestId);
    const ruling = writeRuling(chatId, { requestId, decision: "rejected" });
    const text = rejectionNotice(k.card, job);
    deliverUserPrompt(chat, { prompt: text, display: text, cause: "agent" });
    return { status: 200, body: { ok: true, ...ruling } };
  }
  // Accepting: the same checks as a start — if the card gets stuck on them, it stays open.
  if (typeof job?.script !== "string") return errorText(410, "job", T("The request behind this card is gone — nothing started."));
  let meta;
  try { ({ meta } = checkScript(job.script)); } catch (e) {
    if (e instanceof MetaError || e instanceof ScriptError) return errorText(400, "script", e.message);
    throw e;
  }
  // A resume through the card: the predecessor fresh — if it is running by now, the card stays open; if it is gone,
  // the workflow starts from the top.
  let before = null;
  if (job.resumeOf) {
    before = store.dynRunInChat(chatId, job.resumeOf);
    if (before?.runId !== job.resumeOf) before = null;
    if (before?.status === "running") {
      return errorText(409, "resume", T`Run ${before.runId} is still running — stop it with cbase_dynamic_workflow_stop before resuming from it.`);
    }
  }
  beforeRuling?.(requestId);
  const r = startChecked(chat, { script: job.script, meta, args: job.args, callId: job.callId, request: job.request, before, budget: job.budget ?? null });
  if (!r.go) return r; // the location leads out (409): the card stays open
  const { runId, taskId, scriptPath } = r.body;
  const ruling = writeRuling(chatId, { requestId, decision: "accepted", runId, taskId });
  depositHint(chatId, T`The user accepted the approval card of the dynamic workflow "${k.card.name}" — it is running (run id ${runId}, task id ${taskId}, script ${scriptPath}). A <task-notification> arrives when it ends; stop it with cbase_dynamic_workflow_stop.`, { source: "dynworkflow-approval" });
  return { status: 200, body: { ok: true, ...ruling, scriptPath }, go: r.go };
}

// ── Hooks for the registration list (server.js) ─────────────────────────────────────────────────────────────────

/** Hook "chatClosed" (every delete path: chats/erase.js → runs/agents.js): stop its workflows silently, delete the rows. */
export function dynWorkflowsChatClosed({ chatId }) {
  for (const run2 of dynWorkflowsOf(chatId)) {
    run2.silenced = true;
    run2.sandbox?.abort();
    closeCore(run2);
    active.delete(run2.runId);
  }
  // The changed worktrees of its workflow agents in a project's runtime folder: they are ONLY in the journal (the
  // agents store no image in their own core) — so BEFORE the run tables are deleted. The same calculation as for
  // subagents (runs/agents.js); without a project location the journal is not read, a flat worktree stays. An agent
  // that only this closing ends is not in the journal — its end decides itself.
  cleanUpWorktreesInRuntimeFolder(chatId, () => store.dynRunsInChat(chatId, Number.MAX_SAFE_INTEGER).runs
    .flatMap((l) => changedWorktrees(l.runId)), { rootFallback: removeAsRoot, who: "workflow agents" });
  store.deleteDynRuns(chatId);
  reminderChatClosed(chatId); // the state of the ultracode reminders goes with it
}

/**
 * The second source of the ONE query for open background work (runs/background.js, set in server.js; read by archive,
 * end of work and the holding of a graph step): the running dynamic workflows of this chat (without `chatId` of all
 * chats) as rows `{ kind: "dynworkflow", chatId, runId, taskId, name, startedAt, step }`.
 * `step`: the workflow belongs to the step the chat's open graph run stands at NOW (the same run, the same step
 * number) — only then does it hold it. undefined = none.
 */
export function dynWorkflowsOpen({ chatId } = {}) {
  const rows = [...active.values()].filter((l) => !chatId || l.chatId === chatId).map((l) => {
    const now = l.graph ? graphStep(l.chatId) : null;
    return {
      kind: "dynworkflow", chatId: l.chatId, runId: l.runId, taskId: l.taskId, name: l.name, startedAt: l.startedAt,
      step: Boolean(now && now.runId === l.graph.runId && now.step === l.graph.step),
    };
  });
  return rows.length ? rows : undefined;
}

/**
 * The running dynamic workflows (of one chat) with their compute state — `{ chatId, runId, taskId, name, startedAt,
 * open, waiting, computes }`. `open`: agent() calls in progress; `waiting`: of those, the ones waiting at the project
 * lock, at the gate or parked (parking.js `waiting`, plus agents parked at the limit). `computes` is false when at
 * least one call is open and ALL wait — such a run does not hold up applying a layout (projectbox/layout/job.js,
 * through the setter in server.js; projectbox/ does not import dynworkflows/run.js).
 */
export function dynWorkflowSituation({ chatId } = {}) {
  return [...active.values()].filter((l) => !chatId || l.chatId === chatId).map((l) => {
    const open = l.entries.size;
    const waiting = l.park.waiting() + [...l.entries.values()].filter((e) => e.parked).length;
    return { chatId: l.chatId, runId: l.runId, taskId: l.taskId, name: l.name, startedAt: l.startedAt, open, waiting, computes: !(open > 0 && waiting >= open) };
  });
}

/** At server start: what an earlier server run left as "running" (crash) is interrupted — the restart resumes it
 * (dynWorkflowsRestartGrace). */
export function dynWorkflowsAtStart() {
  return store.interruptDynRuns(T("Server restarted — the run was interrupted."));
}

// ── The server end ──────────────────────────────────────────────────────────────────────────────────────────────────
// A run ends with the server run INTERRUPTED: row "interrupted" with the marker "ordered" (the restart does not count
// that as an attempt), end marker, the script aborted (from here on no answer goes in any more), `serverEnd` set (no
// `failed`, no log() about an agent, no message "not_delivered" — run, message.js). With `core` the core is closed too
// and the run taken out of `active` (only `dynWorkflowsAtServerEnd` at `server.close`); without it (the first touch in
// the window before, see below) core and run stay as they are — the run's agents keep working until `close`. Calling
// it twice does no harm: row, marker and abort happen once.
function interrupt(run2, { core = true } = {}) {
  if (!run2.serverEnd) {
    run2.serverEnd = true;
    try { store.endDynRun(run2.runId, { status: "interrupted", ordered: true, error: T("Server stopped — the run was interrupted.") }); } catch { /* database gone */ }
    marker(run2, "end", "interrupted");
    run2.sandbox?.abort();
  }
  if (core) {
    closeCore(run2);
    active.delete(run2.runId);
  }
}

// THE RACE AT THE SERVER END. `dynWorkflowsAtServerEnd` only runs at `server.close` — and before it lies the "serverEnd"
// chain (runs/server-end.js: the marker, then up to 45 s of subscribers, among them `docker stop -t 30` of every
// project container). A workflow agent in a relocated project would die there (exit 137) and its end would reach the
// script as an ordinary failure: `failed` in the journal, "returned null", then the next agent() — started, waiting at
// the "server end" lock —, all BEFORE the run counted as interrupted; the restart would then resume, and the tree
// would show the abort as an error. So the run freezes at the FIRST touch with an ending server: at an agent's end
// (the core's callback, before journal, script and messages), on entering agent(), after every wait for a slot (gate,
// project lock, parking, cap, stagger) and at a failing start.
// The question is `ownServerEnd()` — set FIRST at SIGTERM, before the "serverEnd" chain stops the project containers.
// NOT the gateway's foreign marker: freezing cannot be undone in a process that lives on, and any agent process on the
// server can write that marker — a false alarm would halt the run until the next restart (no completion notice, a
// waiting graph step hangs). With the foreign marker an agent of a relocated project waits at the lock as before; if
// the gateway stops the project containers itself (unhealthy server, destroy), an agent killed there arrives as a
// failure.
// What freezing does NOT do: close the core. Agents already running keep working until `server.close`
// (`dynWorkflowsAtServerEnd` ends them) — an agent on the server that ends WITH a result within the window of up to
// 45 s is in the journal, and the restart serves it from the cache; one in a project container dies at `docker stop`
// and runs anew in the restart. Only no new one starts, and no result reaches the script any more.
// Guard: server/backend/test/dynworkflows-server-end.test.js.
function interruptIfServerEnds(run2) {
  if (!run2.serverEnd && ownServerEnd()) interrupt(run2, { core: false });
  return run2.serverEnd;
}

/** At the end of the server run (`server.close`): all runs interrupted, their agents ended, no timer remains. */
export function dynWorkflowsAtServerEnd() {
  serverRun++;
  for (const run2 of [...active.values()]) interrupt(run2);
}

// ── Resume after the restart ────────────────────────────────────────────────────────────────────────────────────
// The NORMAL case, not the exception: no deploy waits for running workflows. The restart hook (runs/resume.js,
// registered in server.js) picks every interrupted run up again: THE SAME run (run id, task id, journal), the script
// from its file with its `args`, the chain against its own journal — finished, unchanged agents come from the cache
// (no spawn), interrupted and merely started ones run anew. The continuation only starts agents through the run's
// core, NO turn: the chat stays free (the hook fires synchronously BEFORE the filter of chat runs — a turn started
// here would count as running there), the result arrives as a completion notice as always.
//
// Attempt cap as for the auto-resume of chat runs (runs/resume.js MAX_RESUME_ATTEMPTS): every pick-up after an end that
// was NOT ordered (crash, throwing continuation) increments `attempts` on the run in the database — so the counter
// survives the next crash. An ordered server end (interrupt) does not count and does not give up (otherwise the third
// deploy would give up a healthy run). If the counter stands at the cap after a crash, the run is given up (failed, end
// marker) and reported to the chat (completion notice "failed" — delivered outside the hook, see above). A
// continuation that THROWS does not take the server down: it runs with a safety net, becomes an error row in the chat
// (role "hint"), the run is interrupted again (not ordered), and the next attempt counts.
export const DYN_RESUME_CAP = 2;
let serverRun = 0; // counts the server ends: a deferred notice of an ended server run no longer delivers

function errorLine(chatId, text) {
  try { store.addMessage(chatId, "hint", text); } catch (e) { console.error("[dynworkflow] error row:", e?.message || e); }
}

// A run's instance from its row: the stored identifier, otherwise `undefined` — the chat's current instance. Only an
// identifier is ever stored, never "begun without an instance": a run from before the column has none, and a run that
// began without an instance runs in the main instance after a relocation between start and restart (the relocation
// puts the project there) — with `null` it would run on the server at the old path. There is no copy for it: one is
// only created in the relocated project, and the relocation waits for idle, which counts open workflows.
const identifierTheRow = (row) => row?.instanceIdentifier || undefined;

function abandon(row, reason) {
  if (!store.abandonDynRun(row.runId, reason)) return;
  const run2 = newRun({ ...row, instanceIdentifier: identifierTheRow(row) });
  marker(run2, "end", "failed");
  const chat = store.getChat(row.chatId);
  if (!chat) return;
  const text = completionNotice(run2, { status: "failed", returnValue: null, error: reason, agentCount: row.agentCount });
  const result = { runId: row.runId, taskId: row.taskId, name: row.name, status: "failed", returnValue: null, error: reason,
    journal: store.readDynJournal(row.runId).map(({ at: _at, ...e }) => e) };
  resultWrite(row.outputPath, result);
  const alive = serverRun;
  // After the hook, not inside it: the completion notice starts a turn, and the filter of chat runs only runs afterwards.
  setImmediate(() => {
    if (alive !== serverRun) return;
    try { deliverUserPrompt(store.getChat(row.chatId) || chat, { prompt: text, display: text, cause: "agent" }); } catch (e) { console.error("[dynworkflow] notice:", e?.message || e); }
  });
}

function resumptionFailed(run2, e) {
  const reason = String(e?.message || e || "").slice(0, 1000) || "(without Notice)";
  console.error("[dynworkflow] resumption of", run2.runId, "failed:", reason);
  run2.serverEnd = true; // this attempt's agents are interrupted, not failed (no failed in the journal)
  run2.sandbox?.abort();
  closeCore(run2);
  active.delete(run2.runId);
  // The run is no longer open — for the global stream too. `run` reported it open, and the end marker (which otherwise
  // sends `open: false`) would not come if the finishing threw BEFORE it or the continuation never reached `run`
  // (script gone, but already in `active` and thus in the initial state): a new connection would no longer see it, an
  // existing one would keep it, and the chat list's busy icon would spin until a reload.
  if (!run2.endMarker) reportGlobal(run2, false);
  try { store.endDynRun(run2.runId, { status: "interrupted", error: reason }); } catch { /* database gone */ }
  errorLine(run2.chatId, T`The dynamic workflow "${run2.name}" (run id ${run2.runId}) could not be resumed after the restart: ${reason}`);
}

// The start path of a continuation: everything after the pick-up runs in ONE promise with a safety net — a throw
// (script gone, journal unreadable, core start) becomes an error row, not an unhandled rejection of the server process.
function resumeValue(row) {
  // The pot survives the restart as a number: the same upper bound, the last booked consumption as the base.
  // The core opens in the instance the run BEGAN in (the identifier on the run), not in the chat's current one.
  const run2 = newRun({ ...row, resumed: true, pot: potFor({ total: row.budgetTotal, prior: row.budgetConsumed }), instanceIdentifier: identifierTheRow(row) });
  active.set(row.runId, run2);
  run2.end = (async () => {
    const script = await fs.promises.readFile(row.scriptPath, "utf8");
    const old = store.readDynJournal(row.runId);
    await run(run2, script, row.args, { old, journalNew: false });
  })().catch((e) => resumptionFailed(run2, e));
}

/**
 * Restart hook (runs/resume.js): resume every interrupted run or give it up after the attempt cap. NEVER resume the
 * run of a manager chat: its agents ran through their own core, past the lock in doRun. Given up without a notice (the
 * chat accepts none, runs/manager-lock.js).
 */
export function dynWorkflowsRestartGrace() {
  for (const row of store.dynRunsInterrupted()) {
    try {
      if (active.has(row.runId)) continue;
      const chat = store.getChat(row.chatId);
      if (!chat) { store.abandonDynRun(row.runId, "chat deleted"); continue; }
      if (managerLocked(chat)) { store.abandonDynRun(row.runId, managerLockText()); continue; }
      if (!row.endOrdered && row.attempts >= DYN_RESUME_CAP) {
        abandon(row, T`Given up after ${DYN_RESUME_CAP} resume attempts — the run broke off again at every restart. Resume it with resumeFromRunId ${row.runId} or start over.`);
        continue;
      }
      if (!store.pickUpDynRun(row.runId)) continue;
      resumeValue(row);
    } catch (e) {
      console.error("[dynworkflow] restart", row.runId, ":", e?.message || e);
    }
  }
}
