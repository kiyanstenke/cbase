// The job of a layout change: take over, quiet, holders, lock. What the project tab switches over must really happen at some
// point, without a running agent standing in the middle of a half-rebuilt tree.
//
// THE PATH: `takeOver` creates the job in `waiting` (store/project-layout.js), earmarks the lock "layout" (projectbox/idle.js
// earmarkProject — a lock on the WHOLE project over the waiting time) and checks for quiet at once. Quiet means: no holder.
// Then, in the SAME synchronous check that reads the quiet: `running` + boot id + phase of the lock — from then on EVERY start
// in the project waits. After that the checks that cannot be synchronous (terminals in the project container through the
// container program, processes in B through /proc) and the synchronous one once more; if anything is open after all, back to
// `waiting` (the waiters that may pass in `waiting` are woken). Otherwise the job goes to the execution (`setLayoutExecution`;
// if unset it stays in `running`).
//
// HOLDERS (`layoutQuiet` → `{ holders: [{ kind, id, chatId?, name, text, stoppable }], hints: [...] }`), built on projectIdle
// (idle.js):
//   turn         a turn runs (also at an approval card), a compaction, a target verdict, a monitor              → turn stop
//   agent        a subagent lives and computes (one parked at the limit is a hint)                               → stopAgent(…, { ofHuman: true })
//   dynworkflow  a dynamic workflow whose agent() calls do not all wait (dynworkflows/run.js dynWorkflowSituation via
//                `setDynWorkflowAccess`; one that waits only at the lock, the gate or parked is a hint — otherwise both would
//                deadlock)                                                                                      → stop the run
//   outerloop    an outer-loop run works in the project (runs/agents.js coresInProject)                         → abortOuterLoop
//   upload       a later upload operation is open (also interrupted), or a chunk request BEGAN less than the upload quiet
//                time ago (runtime/upload-stamp.js uploadRunning)                                               → discard the operation
//   terminal     in the project container: a foreground command of the session (`tpgid` ≠ group of the shell, via the program
//                ./proc-program.js); in B (workspace terminal): its foreground process works under an affected path. A session
//                in the container whose group is still unknown holds (empty is not unknown)                     → killTerminal with notice
//   turn (in B)  a process IN B under an affected path that descends from the CLI process of a chat             → turn stop
//   process      any other process IN B there that belongs to no terminal — a subagent, the bash of the loop engine, a
//                background server (./processes-in-b.js)                                                        → not stoppable
//   copy         a live copy of the project (both directions)                                                   → not stoppable
//   worktree     a graph workflow is just creating its worktree (workflows/graph-start.js)                      → not stoppable
//   git · detection · verdict · oneshot   short, not stoppable (the services detection has no abort)
//   check        one of the asynchronous checks could not be read — holds until it can be read again
// Do NOT hold (hints): a chat at the usage limit (wait row), a workflow before the human review, a parked agent, a graph
// workflow in the background between two steps or its announced start, an interrupted run before the resumption (its turn waits
// at the lock). The queue never counts (the lock fills it itself), services never count.
//
// RE-CHECKED: at turn end (server.js setTurnObserver), when the background work of a chat becomes empty (runs/agents.js
// setWorkEmptyObserver — the last agent of a core without a turn, the end of a dynamic workflow), at the end of a terminal
// (terminal.js setTerminalEndObserver), on every report of an upload operation (setup/status.js setUploadObserver), after "stop",
// in the check-back tick (`checkBackMs`, knob CBASE_LAYOUT_CHECK_BACK_MS, default 30 s — it catches the ageing of the upload
// quiet time and every path without an observer) and when the instance changes to `ready` (`layoutAtReady`). The check per
// project never runs twice; a request in the meantime checks once more afterwards.
//
// RESTART GRACE (`layoutRestartGrace`, synchronous hook "project-layout", registered in server.js BEFORE every path that lets
// turns start again): for every job in `waiting`/`running`/`error` after the turn point, the lock again; `running` before the
// turn point gets `backward = true` and keeps the lock (its way back runs at `ready`). Also the rebuild marker of the monitor
// (services.js setRebuildMarker) for every job in `running` and `error` after the turn point — it lives in memory only.
//
// A failed WAY BACK (`error`, `turned = false`, `backward = true`) does not lock (before the turn point nothing in the tree has
// changed), but its journal stays open: reverting and a new take-over answer 409 RETURN_PATH_OPEN (otherwise the row `before`
// would go — the restart rules and the desired state the way back restores); "Retry" runs the way back to its end.
// `backToWaiting` is the way of the procedure back to `waiting` (after a way back at restart grace or because of a workspace
// chat in the folder).
//
// Import rule: projectbox/ does not import projects/, stacks/, dynworkflows/run.js — what comes from there comes through
// setters from server.js (`setDynWorkflowAccess`). Foreign text (names of chats, agents, processes) goes only as data into `name`.

import fs from "node:fs";
import path from "node:path";

import { BOOT_ID } from "../../app-state.js";
import * as store from "../../store.js";
import { T } from "../../i18n.js";
import { broadcast } from "../../runtime/sse.js";
import { uploadRunning } from "../../runtime/upload-stamp.js";
import { running, stopRun } from "../../runs/state.js";
import { coresInProject, liveAgents, stopAgent } from "../../runs/agents.js";
import { wakeProjectWaiting } from "../../dynworkflows/parking.js";
import { endTerminalWithNotice, terminalSessions } from "../../terminal.js";
import { abortOuterLoop } from "../../outerloop/abort.js";
import { ONLY_IN_OPS, projectboxOps } from "../ops.js";
import { MAIN } from "../creation.js";
import { runInstance } from "../run-instance.js";
import { projectLocked, projectIdle, earmarkProject } from "../idle.js";
import { processSeamRoot } from "../relocation/processes.js";
import { dismissUpload } from "../setup/upload.js";
import { setRebuildMarker } from "../../services.js";
import { LayoutError, currentSituation, layoutSituation, layoutCheck, normalizeSteps } from "./read.js";
import { procInB, searchInProject } from "./proc-program.js";
import { processesInB } from "./processes-in-b.js";

export const CHECK_BACK_MS = 30_000;
export function checkBackMs() {
  const raw = process.env.CBASE_LAYOUT_CHECK_BACK_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 50 ? n : CHECK_BACK_MS;
}

const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const response = (status, code, text, fields = {}) => ({ status, body: { code, error: text, ...fields } });

// ── Connections (server.js) ─────────────────────────────────────────────────────────────────────────────────────────────

// fn(projectId, { resume }) — the procedure. If unset, a quiet job stays in `running` (tests only).
let execution = null;
export function setLayoutExecution(fn) { execution = typeof fn === "function" ? fn : null; }
// dynworkflows/run.js via server.js: `situation({ chatId })` → dynWorkflowSituation, `stop(chatId, runId)` → stopDynWorkflow.
let dyn = { situation: null, stop: null };
export function setDynWorkflowAccess({ situation = null, stop = null } = {}) {
  dyn = { situation: typeof situation === "function" ? situation : null, stop: typeof stop === "function" ? stop : null };
}

// ── Lock and state in memory ─────────────────────────────────────────────────────────────────────────────────────

const earmarkings = new Map(); // projectId → handle from earmarkProject
const checkBack = new Map(); // projectId → timer
const checking = new Set();
const again2 = new Set();
const last = new Map(); // projectId → { asyncHolders, at } of the last whole check (with the asynchronous parts)

const phaseOf = (a) => (a.state === "waiting" ? "waiting" : a.state === "running" ? "running" : "error");

// The quiet check sets `running` (step "quiet") so that no start in the project begins during its asynchronous parts — this
// holds for the STARTS (the phase of the lock, idle.js). For everyone who READS the state (write lock of the code tab, service
// start, upload, list row, view, "stop") the job still waits in this window: no procedure step is announced, nothing is being
// rebuilt. Otherwise every check (every 30 s, after every turn end) would answer 409 "the layout is being rebuilt" for a few
// hundred milliseconds. After the restart grace (`backward`) it is a real `running` again: the way back runs at `ready`.
const inQuietCheck = (a) => a.state === "running" && a.step === "quiet" && !a.turned && !a.backward;
const viewState = (a) => (inQuietCheck(a) ? "waiting" : a.state);

/** The lock "layout" for this job (earmark it or update the phase). → `{ ok, … }` like earmarkProject. */
export function setLock(pid, a) {
  const old = earmarkings.get(pid);
  if (old) { old.phase(phaseOf(a)); return { ok: true }; }
  const v = earmarkProject(pid, { since: a.since, phase: phaseOf(a) });
  if (v.ok) earmarkings.set(pid, v);
  return v;
}
/** Release the lock (wakes the waiters) and stop the tick. */
export function releaseLock(pid) {
  const v = earmarkings.get(pid);
  earmarkings.delete(pid);
  stopCheckBack(pid);
  last.delete(pid);
  if (v) v.resolve();
}
export const lockStands = (pid) => earmarkings.has(String(pid));

function placeCheckBack(pid) {
  stopCheckBack(pid);
  const t = setTimeout(() => { checkBack.delete(pid); checkQuiet(pid); }, checkBackMs());
  t.unref?.();
  checkBack.set(pid, t);
}
function stopCheckBack(pid) {
  const t = checkBack.get(pid);
  if (t) clearTimeout(t);
  checkBack.delete(pid);
}

/** The reader for setup/status.js setLayoutReader (server.js): `waiting` · `running` · `error` (only after the turn point) · null. */
export function layoutReader(pid) {
  const a = store.layoutJob(pid);
  if (!a) return null;
  const z = viewState(a);
  if (z === "waiting" || z === "running") return z;
  return a.state === "error" && a.turned ? "error" : null;
}

/** The row of the project list: the job as long as it is not `finished`, with the NUMBER of holders (only in `waiting`: "layout
 *  waits for quiet (N)"). Connected in server.js to setup/status.js setLayoutRowsReader. */
export function layoutRow(pid) {
  const a = store.layoutJob(pid);
  if (!a || a.state === "finished") return null;
  const z = viewState(a);
  return {
    state: z, turned: a.turned, backward: a.backward, step: z === "waiting" ? "" : a.step || "", error: a.error || null, since: a.since,
    holders: z === "waiting" ? layoutQuiet(pid).holders.length : 0,
  };
}

export function report(pid, fields = {}) {
  const a = store.layoutJob(pid);
  broadcast({ type: "project/layout", projectId: String(pid), kind: "job", state: a?.state || "gone", step: a?.step || "", ...fields });
}

// ── Quiet ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const chatName = (chatId) => { try { return short(store.getChat(chatId)?.title || "", 80) || String(chatId); } catch { return String(chatId); } };

/** The synchronous part of the quiet (header, "HOLDERS") — memory and database only, no await. */
export function quietSync(pid) {
  const holders = [];
  const hints = [];
  const alongside = (h) => { if (!holders.some((x) => x.kind === h.kind && x.id === h.id)) holders.push(h); };
  const hint = (h) => { if (!hints.some((x) => x.kind === h.kind && x.id === h.id)) hints.push(h); };
  const l = projectIdle(pid);
  const chats = new Set(store.chatIdsInProject(pid));
  const dynChats = new Set(chats);
  for (const o of l.open) {
    const c = o.chatId;
    switch (o.reason) {
      case "queue": break; // the lock fills it itself
      case "waitRow": hint({ kind: "waitRow", id: c, chatId: c, name: chatName(c), text: o.text }); break;
      case "interrupted": hint({ kind: "interrupted", id: c, chatId: c, name: chatName(c), text: o.text }); break;
      case "workflow": case "graphWorkflow": case "graph-start":
        hint({ kind: o.reason, id: c, chatId: c, name: chatName(c), text: o.text }); break;
      case "running": case "compacted": case "target": case "approval": case "monitor":
        alongside({ kind: "turn", id: c, chatId: c, name: chatName(c), text: o.text, stoppable: running.has(c) }); break;
      case "agent": case "workflowagent": case "dynworkflow": break; // individually below
      case "outerloop":
        if (o.runId) alongside({ kind: "outerloop", id: String(o.runId), chatId: c, name: chatName(c), text: o.text, stoppable: true });
        break;
      case "git": case "detection": case "verdict": case "oneshot": case "worktree":
        alongside({ kind: o.reason, id: c || o.reason, ...(c ? { chatId: c } : {}), name: c ? chatName(c) : "", text: o.text, stoppable: false }); break;
      default:
        // A reason this table does not know holds (better to wait than to rebuild under it).
        alongside({ kind: String(o.reason || "unknown"), id: c || String(o.reason), ...(c ? { chatId: c } : {}), name: c ? chatName(c) : "", text: o.text, stoppable: false });
    }
  }
  // Subagents of the chats in the project and those in a core of this project whose chat has switched.
  const agents = liveAgents().filter((a) => chats.has(a.chatId));
  for (const k of coresInProject(pid)) {
    if (k.kind === "agent" && !chats.has(k.chatId)) agents.push(k);
    if (k.kind === "workflow") dynChats.add(k.chatId);
  }
  for (const a of agents) {
    const name = short(a.description || a.name || a.agentId, 80);
    if (a.status === "parked") { hint({ kind: "agent", id: String(a.agentId), chatId: a.chatId, name, text: T("A subagent is waiting at the usage limit.") }); continue; }
    alongside({ kind: "agent", id: String(a.agentId), chatId: a.chatId, name, text: T`Subagent “${name}” is working.`, stoppable: true });
  }
  // Dynamic workflows: only one that computes holds.
  let runs = [];
  if (dyn.situation) { try { runs = dyn.situation({}) || []; } catch (e) { alongside({ kind: "check", id: "dynworkflows", name: "", text: short(e?.message || e), stoppable: false }); } }
  for (const w of runs) {
    if (!dynChats.has(w.chatId)) continue;
    const name = short(w.name || w.runId, 80);
    if (!w.computes) { hint({ kind: "dynworkflow", id: String(w.runId), chatId: w.chatId, name, text: T("A dynamic workflow is waiting (at the lock, the gate or the limit).") }); continue; }
    alongside({ kind: "dynworkflow", id: String(w.runId), chatId: w.chatId, name, text: T`The dynamic workflow “${name}” is working.`, stoppable: true });
  }
  // Uploads: an open later operation (also interrupted), or a chunk that just began.
  const operations = store.retroactiveOperations(pid);
  for (const v of operations) {
    alongside({ kind: "upload", id: String(v.operation), name: short(v.staging, 80), text: T`An upload is open (${v.state}).`, stoppable: true });
  }
  if (!operations.length && uploadRunning(pid)) {
    alongside({ kind: "upload", id: "chunk", name: "", text: T("A chunk of an upload just arrived."), stoppable: false });
  }
  // A live copy holds, in both directions: `takeOver` and `again` check the situation beforehand, but one can still arise between
  // the check and the procedure (before the turn point a job in `error` does not lock, and the copy request then accepts it).
  // Not stoppable: clearing away a copy is its own path with a question.
  for (const k of store.liveStackCopies(pid)) {
    alongside({ kind: "copy", id: String(k.id), ...(k.chatId ? { chatId: k.chatId } : {}), name: short(k.name, 80), text: T`The copy “${short(k.name, 60)}” is open.`, stoppable: false });
  }
  return { holders, hints };
}

// The affected paths of the job (absolute): every `old` and every left-out path.
export function affectedPaths(a, proj) {
  const root = path.resolve(String(proj.path));
  const end = a?.plan?.finalMapping || { ways: [], gone: [] };
  return [...(end.ways || []).map((w) => path.join(root, w.old)), ...(end.gone || []).map((p) => path.join(root, p))];
}

/** The asynchronous part: terminals in the project container (program), workspace terminals and workspace chats in B (/proc). */
export async function quietAsync(pid, proj, a) {
  const holders = [];
  const check = (id, e) => holders.push({ kind: "check", id, name: "", text: T`Cannot be checked (${id}): ${short(e?.message || e, 200)}`, stoppable: false });
  const sessions = terminalSessions();
  // 1. Terminals in the project container (main; terminals of a copy do not count — a live copy already holds in quietSync).
  const inC = sessions.filter((s) => s.inContainer && typeof s.identifier === "string" && s.identifier.startsWith(`${pid}/`));
  const withoutGroup = inC.filter((s) => !s.pgid);
  for (const s of withoutGroup) holders.push({ kind: "terminal", id: s.id, name: s.tag, text: T("A terminal is starting."), stoppable: true });
  const withGroup = inC.filter((s) => s.pgid);
  if (withGroup.length) {
    const inst = runInstance(pid);
    if (!inst) check("terminals", T("project container not ready"));
    else {
      try {
        const r = await searchInProject(inst, "foreground", { pids: withGroup.map((s) => s.pgid) });
        const byKey = new Map((r.sessions || []).map((x) => [x.pid, x]));
        for (const s of withGroup) {
          const x = byKey.get(s.pgid);
          if (x?.foreground) holders.push({ kind: "terminal", id: s.id, name: short(x.name || s.tag, 80), text: T`“${short(x.name, 40)}” is running in the terminal.`, stoppable: true });
        }
      } catch (e) { check("terminals", e); }
    }
  }
  // 2. In B: every process under the affected paths that belongs to no terminal — the turn of a chat (stoppable) or a process
  //    without a known run (subagent, bash of the loop engine, background server); the same computation as step 5 (a) of the
  //    procedure (./processes-in-b.js). Plus the workspace terminals with a command in the foreground.
  const inB = sessions.filter((s) => !s.inContainer && s.pid);
  let situation = null;
  try { situation = processesInB({ paths: affectedPaths(a, proj), roots: [path.resolve(String(proj.path))], sessions }); } catch (e) { check("processes-b", e); }
  if (situation) {
    holders.push(...situation.holders);
    if (situation.findings.length && inB.length) {
      try {
        const v = procInB(fs, "foreground", { pids: inB.map((s) => s.pid) }, processSeamRoot()).sessions || [];
        const byKey = new Map(v.map((x) => [x.pid, x]));
        for (const s of inB) {
          const x = byKey.get(s.pid);
          if (x?.foreground && situation.findings.some((p) => p.pgid === x.tpgid)) holders.push({ kind: "terminal", id: s.id, name: short(x.name || s.tag, 80), text: T`“${short(x.name, 40)}” is running in an affected folder in the terminal.`, stoppable: true });
        }
      } catch (e) { check("terminals-b", e); }
    }
  }
  return { holders };
}

/** The whole quiet for the view: the synchronous part from NOW and the asynchronous part of the last check. */
export function layoutQuiet(pid) {
  const s = quietSync(pid);
  const old = last.get(pid);
  const holders = [...s.holders];
  for (const h of old?.asyncHolders || []) if (!holders.some((x) => x.kind === h.kind && x.id === h.id)) holders.push(h);
  return { holders, hints: s.hints };
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** (Re-)check the quiet of this project — never twice; a request during a check checks once more afterwards. */
export function checkQuiet(pid) {
  const p = String(pid ?? "");
  if (!p || !projectboxOps()) return;
  if (checking.has(p)) { again2.add(p); return; }
  const a = store.layoutJob(p);
  if (!a || a.state !== "waiting") return;
  checking.add(p);
  (async () => {
    try { await checkOnce(p); } catch (e) {
      console.error(`[layout] ${p}: quiet not checked: ${short(e?.message || e)}`);
      placeCheckBack(p);
    } finally {
      checking.delete(p);
      if (again2.delete(p)) checkQuiet(p);
    }
  })();
}
/** Is a check running right now (tests: wait for its end instead of a duration)? */
export const quietCheckRunning = (pid) => checking.has(String(pid));

async function checkOnce(pid) {
  const a = store.layoutJob(pid);
  if (!a || a.state !== "waiting") return;
  const proj = store.getProject(pid);
  if (!proj) return;
  // A foreign lock of the whole project keeps the earmark (a waiting layout replaces it on delete) — no transition to `running`
  // under it; releasing it gives the earmark back.
  const foreign = projectLocked(pid);
  if (foreign && foreign.reason !== "layout") { placeCheckBack(pid); return; }
  if (store.projectInstance(pid, MAIN)?.state !== "ready") { placeCheckBack(pid); return; } // layoutAtReady checks then
  // 1. synchronous: read the quiet and — if it is there — set `running` + boot id + phase in the SAME check.
  const s1 = quietSync(pid);
  if (s1.holders.length) {
    last.set(pid, { asyncHolders: last.get(pid)?.asyncHolders || [], at: Date.now() });
    placeCheckBack(pid);
    return;
  }
  store.layoutSet(pid, { state: "running", process: BOOT_ID, step: "quiet" });
  earmarkings.get(pid)?.phase("running");
  // 2. the asynchronous checks — every start in the project waits now.
  let asy;
  try { asy = await quietAsync(pid, proj, a); } catch (e) { asy = { holders: [{ kind: "check", id: "quiet", name: "", text: short(e?.message || e), stoppable: false }] }; }
  // 3. once more synchronously (what still got through between 1 and 2 as a follow-up step).
  const s2 = quietSync(pid);
  const holders = [...s2.holders, ...asy.holders];
  last.set(pid, { asyncHolders: asy.holders, at: Date.now() });
  if (holders.length) {
    store.layoutSet(pid, { state: "waiting", process: "", step: "" });
    earmarkings.get(pid)?.phase("waiting");
    wakeProjectWaiting(); // follow-up steps that waited at the lock in `running` may pass again in `waiting`
    report(pid);
    placeCheckBack(pid);
    return;
  }
  stopCheckBack(pid);
  // From here on it is a real `running` — the step "quiet" goes (the procedure writes its own).
  store.layoutSet(pid, { step: "" });
  console.log(`[layout] ${pid}: quiet — the job is running`);
  report(pid);
  if (execution) execution(pid, { resume: false });
}

/** The procedure gives a job back to `waiting`: journal, turn and way-back marks empty, the lock in phase `waiting` (the waiters
 *  that may pass there are woken), the check-back tick runs. The procedure checks the quiet only when it has ended itself
 *  (otherwise the check would still find it running). */
export function backToWaiting(pid) {
  store.layoutSet(pid, { state: "waiting", process: "", step: "", journal: null, turned: false, backward: false, error: "" });
  const v = setLock(pid, store.layoutJob(pid));
  if (!v.ok) console.error(`[layout] ${pid}: lock back to "waiting" not set: ${short(v.error || v.open?.[0]?.text)}`);
  wakeProjectWaiting();
  report(pid);
  placeCheckBack(pid);
}

/** The instance became `ready` (server.js on-ready, setRecreateDone): a waiting job checks its quiet; it also resumes an open
 *  procedure (via the execution). */
export function layoutAtReady(pid) {
  const a = store.layoutJob(pid);
  if (!a) return;
  if (a.state === "waiting") { checkQuiet(pid); return; }
  if (a.state === "running" && execution && a.process !== BOOT_ID) execution(pid, { resume: true });
}

/** An event after which the quiet of one or all waiting jobs is to be re-checked (observer in server.js). */
export function checkBackLayout(pid = null) {
  if (!projectboxOps()) return;
  if (pid) { checkQuiet(pid); return; }
  for (const a of store.layoutJobs()) if (a.state === "waiting") checkQuiet(a.projectId);
}
/** For the observer at the end of a chat (turn, background): the jobs of the chat's project — and, because a workspace chat in B can
 *  be a holder, all waiting ones of the same workspace. */
export function layoutAfterChat(chatId) {
  if (!projectboxOps()) return;
  const open = store.layoutJobs().filter((a) => a.state === "waiting");
  if (!open.length) return;
  const chat = store.getChat(chatId);
  for (const a of open) {
    const p = store.getProject(a.projectId);
    if (!chat || chat.projectId === a.projectId || (p && String(p.workspaceId) === String(chat.workspaceId))) checkQuiet(a.projectId);
  }
}

// ── The route paths ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The view of a job (GET …/layout/job). */
export function jobView(pid) {
  const a = store.layoutJob(pid);
  if (!a) return null;
  const z = viewState(a);
  const quiet = z === "waiting" ? layoutQuiet(pid) : { holders: [], hints: [] };
  return {
    state: z, turned: a.turned, backward: a.backward, step: z === "waiting" ? "" : a.step, error: a.error || null, since: a.since,
    steps: a.plan?.steps || [], finalMapping: a.plan?.finalMapping || null, codeRepos: a.plan?.codeRepos || [],
    holders: quiet.holders, hints: quiet.hints, report: a.report || null,
  };
}

const sameSteps = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/** POST …/layout/takeOver `{ steps, check }` → `{ status, body }`. */
export async function takeOver(pid, proj, body) {
  if (!projectboxOps()) return { status: 404, body: { error: ONLY_IN_OPS } };
  const n = normalizeSteps(body);
  if (n.error) return response(400, "STEPS", n.error);
  const checkId = typeof body?.check === "string" ? body.check : "";
  if (!checkId) return response(400, "CHECK", T("“check” is missing — check first, then apply."));
  const open = store.layoutOpen(pid);
  if (open) return response(409, "JOB_OPEN", T`An order is already open (${open.state}).`, { state: open.state });
  const last2 = store.layoutJob(pid);
  if (last2?.state === "error" && last2.backward) return returnPathOpen();
  let situation;
  try { situation = await currentSituation(pid, proj); } catch (e) {
    if (e instanceof LayoutError) return { status: e.status || 409, body: { code: e.code, error: e.message } };
    throw e;
  }
  if (situation.locked) return { status: 409, body: { code: situation.locked.code, error: situation.locked.text, ...(situation.locked.name ? { name: situation.locked.name } : {}) } };
  const p = layoutCheck(pid, checkId);
  if (!p || p.state !== "finished" || !p.result || !sameSteps(p.steps, n.steps)) {
    return response(409, "CHECK_STALE", T("The check does not match these steps (any more) — please check again."));
  }
  const e = p.result;
  // Decision: a rule error blocks the take-over, also one that already applied before (`before: true`) — 400 on rule errors,
  // without exception; the cautious way.
  if (e.error?.length) return response(400, "RULES", T("The structure violates rules — fix them first."), { error: e.error });
  const end = e.finalMapping || { ways: [], gone: [], codeRepos: [] };
  if (!end.ways.length && !end.gone.length && !(end.codeRepos || []).length) {
    return response(400, "NO_CHANGE", T("These steps change nothing."));
  }
  // Without docker read there is no confirmed set (`confirmable: null`) — and without it step 9 would remove nothing safe.
  if (e.confirmable === null) return response(409, "DOCKER_UNREAD", T("Docker in the project container could not be read during the check — please check again."));
  const root = path.resolve(String(proj.path));
  const plan = {
    steps: n.steps, finalMapping: end, codeRepos: e.codeRepos || end.codeRepos || [], root,
    affected: [...end.ways.map((w) => w.old), ...end.gone],
  };
  const confirmed = {
    check: checkId, confirmable: e.confirmable, leaveOut: e.leaveOut, move: e.move, stacks: e.stacks,
    borrowedObjects: e.borrowedObjects, warnings: e.warnings,
  };
  try { store.createLayout({ projectId: pid, plan, confirmed, since: Date.now() }); } catch (x) {
    if (x?.code === "JOB_OPEN") return response(409, "JOB_OPEN", T("An order is already open."));
    throw x;
  }
  const v = setLock(pid, store.layoutJob(pid));
  if (!v.ok) {
    store.deleteLayoutJob(pid);
    return response(409, "LOCKED", T`The project is locked right now: ${short(v.error || v.open?.[0]?.text || "")}`);
  }
  console.log(`[layout] ${pid}: job created (${end.ways.length} moves, ${end.gone.length} left out, ${(plan.codeRepos || []).length} code repos) — waits for quiet`);
  report(pid);
  checkQuiet(pid);
  return { status: 202, body: { job: jobView(pid) } };
}

/** DELETE …/layout/job — "revert": only in `waiting` and in `error` before the turn point. */
export function revert(pid) {
  if (!projectboxOps()) return { status: 404, body: { error: ONLY_IN_OPS } };
  const a = store.layoutJob(pid);
  if (!a || a.state === "finished") return response(404, "NO_JOB", T("There is no open order."));
  if (a.state === "error" && !a.turned && a.backward) return returnPathOpen();
  if (!(a.state === "waiting" || (a.state === "error" && !a.turned))) {
    return response(409, "JOB_RUNNING", T("The order is already running (or stopped after the point of no return) — it can no longer be reverted."), { state: a.state });
  }
  store.deleteLayoutJob(pid);
  releaseLock(pid);
  console.log(`[layout] ${pid}: job reverted`);
  report(pid);
  return { status: 200, body: { ok: true } };
}

// A failed way back stands open — "Retry" first.
const returnPathOpen = () => response(409, "RETURN_PATH_OPEN",
  T("The way back of the last order did not complete — use “Retry” first, then revert or apply again."));

/** For the delete path (projectbox/erase.js): revert a WAITING job. → whether one went. */
export function revertWaiting(pid) {
  const a = store.layoutJob(pid);
  if (!a || a.state !== "waiting") return false;
  store.deleteLayoutJob(pid);
  releaseLock(pid);
  report(pid);
  return true;
}

/** POST …/layout/job/again — only in `error`: before the turn point back to `waiting`, after it on from the step. */
export function again(pid) {
  if (!projectboxOps()) return { status: 404, body: { error: ONLY_IN_OPS } };
  const a = store.layoutJob(pid);
  if (!a || a.state !== "error") return response(409, "NOT_ERROR", T("Retrying only works after an error."), { state: a?.state || null });
  if (a.turned || a.backward) {
    // After the turn point on from the step; a failed way back runs to its end — its lock was released and is earmarked
    // again.
    if (!execution) return response(409, "NOT_AVAILABLE", T("The execution is not connected."));
    store.layoutSet(pid, { state: "running", process: BOOT_ID, error: "" });
    const v = setLock(pid, store.layoutJob(pid));
    if (!v.ok) {
      store.layoutSet(pid, { state: "error", process: "", error: a.error });
      return response(409, "LOCKED", T("The project is locked otherwise right now."));
    }
    report(pid);
    execution(pid, { resume: true });
    return { status: 202, body: { job: jobView(pid) } };
  }
  // Before the turn point "again" is a new take-over of the same plan — so the same situation as there: in `error` before the turn
  // point the job does not lock, a copy, a relocation or a setup may have begun in the meantime. Synchronous (without a look into
  // the container — the root git has not changed through a failed run before the turn point); a container that is not ready does
  // not stop it, the job then waits for `ready`.
  const situation = layoutSituation(pid, store.getProject(pid) || { path: "" }, null);
  if (situation.locked && situation.locked.code !== "NOT_READY") {
    return { status: 409, body: { code: situation.locked.code, error: situation.locked.text, ...(situation.locked.name ? { name: situation.locked.name } : {}) } };
  }
  store.layoutSet(pid, { state: "waiting", error: "", step: "", process: "", since: Date.now() });
  const v = setLock(pid, store.layoutJob(pid));
  if (!v.ok) {
    store.layoutSet(pid, { state: "error", error: a.error });
    return response(409, "LOCKED", T("The project is locked otherwise right now."));
  }
  report(pid);
  checkQuiet(pid);
  return { status: 202, body: { job: jobView(pid) } };
}

/** POST …/layout/holders/stop `{ kind, id }` — "stop" per holder through the path that already exists. */
export async function stopHolder(pid, proj, body) {
  if (!projectboxOps()) return { status: 404, body: { error: ONLY_IN_OPS } };
  const a = store.layoutJob(pid);
  if (!a || viewState(a) !== "waiting") return response(409, "NOT_WAITING", T("Stopping holders only works while the order waits for quiet."));
  const kind = typeof body?.kind === "string" ? body.kind : "";
  const id = typeof body?.id === "string" ? body.id : "";
  const h = layoutQuiet(pid).holders.find((x) => x.kind === kind && x.id === id);
  if (!h) return response(404, "HOLDER_UNKNOWN", T("This holder does not exist (any more)."));
  if (!h.stoppable) return response(409, "NOT_STOPPABLE", T("This holder cannot be stopped — it ends by itself."));
  const notice = T("Ended: the project structure is being applied.");
  let ok = false;
  if (kind === "turn") ok = Boolean(stopRun(h.chatId));
  else if (kind === "agent") ok = Boolean(stopAgent(h.chatId, id, { ofHuman: true })?.ok);
  else if (kind === "dynworkflow") ok = Boolean(dyn.stop && dyn.stop(h.chatId, id));
  else if (kind === "outerloop") ok = abortOuterLoop({ runIds: [id], reason: "layout" }).runs > 0;
  else if (kind === "terminal") ok = endTerminalWithNotice(id, notice);
  else if (kind === "upload") { const r = await dismissUpload(pid, proj, id); ok = r.status === 200; if (!ok) return r; }
  console.log(`[layout] ${pid}: holder ${kind} ${id} stopped (${ok ? "ok" : "already gone"})`);
  checkQuiet(pid);
  return { status: 200, body: { ok, job: jobView(pid) } };
}

// ── Restart grace ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The synchronous restart-grace hook "project-layout" (header). Returns `undefined`. */
export function layoutRestartGrace() {
  if (!projectboxOps()) return undefined;
  for (const a of store.layoutJobs()) {
    try {
      if (!store.layoutLocks(a)) continue;
      if (a.state === "running" && !a.turned && !a.backward) store.layoutSet(a.projectId, { backward: true });
      if (a.state !== "waiting") setRebuildMarker(a.projectId, true); // the monitor does not check the rebuilt project
      const v = setLock(a.projectId, store.layoutJob(a.projectId));
      if (!v.ok) console.error(`[layout] ${a.projectId}: lock not set at restart grace: ${short(v.error || v.open?.[0]?.text)}`);
      if (a.state === "waiting") placeCheckBack(a.projectId);
    } catch (e) { console.error(`[layout] ${a.projectId}: restart grace: ${short(e?.message || e)}`); }
  }
  return undefined;
}

/** For tests only: forget memory (release locks, stop ticks). */
export function forgetJobs() {
  for (const pid of [...earmarkings.keys()]) releaseLock(pid);
  for (const pid of [...checkBack.keys()]) stopCheckBack(pid);
  last.clear();
  again2.clear();
}
