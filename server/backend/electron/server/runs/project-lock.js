// The lock per project, as seen from runs/.
//
// A leaf with ONE import (i18n.js, itself without imports): runs/ stays free of domains. WHAT the lock rules is known
// to the domain side (projectbox/idle.js `projectLock`, registered in server.js via `setProjectLock`); here is only
// THAT it is asked, and the form of the answer. Unset (tests without a server, locally before boot) ⇒ no lock, every
// start as before.
//
// startLock(chatId, purpose)  purpose ∈ "turn" · "agent" · "oneshot" · "view" (the git view — like "turn", without
//   nudging a stopped instance). Answer `null` (start) or { kind, reason, state, projectId, text }:
//     kind "wait"   the start waits and begins at the transition to ready (turn: queue or wait row with reason
//                   "project"/"serverEnd"; workflow agent: dynworkflows/parking.js);
//     kind "deny"   the start is refused with a reason (subagent and oneshot during a relocation);
//     kind "error"  the instance of a converted project is in the error state: the start ends visibly at once.
//   Reason "unreadable" is woken by no transition (`withoutTransition`): the sweeper checks its wait row at its own
//   pace (runs/limit-gate.js autoContinueSweepMs), not after `projectCheckBackMs()`, and the composer does not queue.
//   Asked at three places: doRun (runs/limit-gate.js `projectLockHolds`, next to the credit gate), deliverUserPrompt
//   (composer path: queue — except for "unreadable", see `waitingInTheQueue`) and fireAutoContinueInner (a due wait
//   row is not started). Oneshots and subagents ask via the start gate (`projectStartGate`, set in server.js BEFORE
//   the credit verdict). A oneshot WITH an instance (service detection in the project container) asks about its
//   project, even without a chat, and waits like an agent — the waiting itself is held by the caller
//   (projects/scans.js).
//   CLOSED ON ERRORS: if the domain side cannot rule (the database throws — SQLITE_BUSY — or it has a fault itself), a
//   turn or agent waits (reason "unreadable") instead of running on the old path, possibly in parallel to a
//   relocation; a oneshot runs. The domain side catches database errors itself and reads the explicit lock (in
//   memory) BEFORE any database access where the project is known without one (an agent's core); the catch here is
//   the backstop for everything else.
//   THE BOUNDARY: the domain side fails closed only where an instance row concerns or could concern the project (it
//   knows the projects with a row without the database, store.instanceRowPossible); without any row it answers a
//   read error with null. So no database error reaches the catch here, only a fault of the domain side itself — and a
//   fault of the verdict stays closed (runs/ does not know which projects carry a row).
//
import { T } from "../i18n.js";

// The reasons of a wait row that are NOT a usage limit: "project" (the instance is working) and "serverEnd" (the
// process is ending). They belong to neither auto-continue switch: auto-continue off does not discard them
// (runs/auto-continue.js).
export const LOCK_REASONS = Object.freeze(["project", "serverEnd"]);
export const isLockReason = (reason) => LOCK_REASONS.includes(reason);

// A wait row with its OWN reason (limit "reset"/"probe", credit gate), whose start the lock halted, KEEPS its reason
// — otherwise resume row, limit notice and the auto-continue switch would be lost (runs/auto-continue.js
// fireAutoContinueInner). So that the transition to ready still starts it (projectbox/idle.js wakeProject otherwise
// wakes only the reasons above and overdue rows), this process remembers the chat. In memory: after a restart the
// sweeper takes the row at its postponed time.
const halted = new Set();
export function rememberHalted(chatId) { if (chatId) halted.add(String(chatId)); }
/** Takes the mark — `true` if the chat had a halted row. */
export const takeHalted = (chatId) => halted.delete(String(chatId || ""));

// Check back on a waiting row in case the wakeup of the transition to ready fails to come — a product cap that says
// it is one: the waking itself is done by the transition (projectbox/idle.js `wakeProject`), not by this deadline.
// Knob CBASE_PROJECT_CHECK_BACK_MS (integer ≥ 1000), otherwise 10 minutes.
export const PROJECT_CHECK_BACK_MS = 10 * 60_000;
export function projectCheckBackMs() {
  const raw = process.env.CBASE_PROJECT_CHECK_BACK_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms >= 1000 ? ms : PROJECT_CHECK_BACK_MS;
}

const KINDS = new Set(["wait", "deny", "error"]);
let lock = null;

export function setProjectLock(fn) {
  lock = typeof fn === "function" ? fn : null;
}

// `projectId`: the project in which the start RUNS if it is not the one the chat carries now — a subagent core stays
// pinned to its project after a project switch. Without it, the chat's project.
// `identifier`: the instance `<projectId>/<instance>` the core is pinned to — like its project; the domain side then
// rules on THIS instance, not on the one the chat is in now. Only with `projectId`.
// `inContainer`: a oneshot that runs in the project container (service detection) — asked via `projectId` even
// WITHOUT a chat, and the domain side rules as for an agent (wait instead of run). Only for purpose "oneshot" and
// only with `projectId`.
// `parentSince`: the start time of the work this start belongs to (a subagent's core, a dynamic workflow's run, a
// graph workflow's run) — only the layout lock in its waiting state reads it (projectbox/idle.js verdictTheLock).
// Without it the call to the domain side keeps two arguments.
// `purpose` "view": the git view (devtools/code-route.js gitSituation) — the domain side rules as for a turn but
// never nudges a stopped instance (projectbox/idle.js stoppedVerdict).
export function startLock(chatId, purpose = "turn", { projectId = null, identifier = null, inContainer = false, parentSince = null } = {}) {
  const z = purpose === "agent" || purpose === "oneshot" || purpose === "view" ? purpose : "turn";
  const inProject = z === "oneshot" && inContainer === true && Boolean(projectId);
  if (!lock || (!chatId && !inProject)) return null;
  try {
    const since = Number.isFinite(parentSince) ? { parentSince } : null;
    const core = projectId ? { projectId: String(projectId), ...(identifier ? { identifier: String(identifier) } : {}), ...(inProject ? { inContainer: true } : {}), ...(since || {}) } : null;
    const u = core ? lock(String(chatId || ""), z, core) : since ? lock(String(chatId), z, since) : lock(String(chatId), z);
    return u && typeof u === "object" && KINDS.has(u.kind) ? u : null;
  } catch (e) {
    // Closed (see file header) — a oneshot runs, turn and agent wait; a oneshot IN the project container waits like
    // an agent.
    console.error(`[project] lock (${purpose}, ${chatId || projectId}) cannot be checked — closed:`, e?.message || e);
    if (z === "oneshot" && !inProject) return null;
    return {
      kind: "wait", reason: "unreadable", state: "unreadable", projectId: projectId ? String(projectId) : null,
      text: T("The project lock cannot be checked right now — this start waits and is retried shortly."),
    };
  }
}

/** Does NO transition of the instance wake this start (reason "unreadable")? Then the clock checks back. */
export const withoutTransition = (u) => u?.reason === "unreadable";
/** Does the turn wait in the chat's queue (composer)? Only if a transition wakes it — otherwise it waits in the
 *  wait row (doRun) that the sweeper checks. */
export const waitingInTheQueue = (u) => u?.kind === "wait" && !withoutTransition(u);

// The share in the start gate (providers/index.js setStartGate): oneshots (`runOnce`) and subagents (core,
// runs/agents.js; dynamic workflows interpret it in dynworkflows/). `null` ⇒ not responsible, the credit verdict
// decides; otherwise the refusal in the gate's form (`ok: false`, `text`) with the verdict under `project`.
// Synchronous — the caller waits for the gate anyway.
// `projectId` is passed by the subagent core or a dynamic workflow: the project of its core — and `identifier`, the
// instance of its core.
// `instance`: the instance a oneshot runs in (providers/index.js runOnce — today only service detection,
// projects/scans.js). With it the lock rules on its project and its identifier, even without a chat.
// `parentSince`: the start time of the work a subagent or workflow agent belongs to (its core or its run) — see
// startLock.
export function projectStartGate({ chatId = "", purpose = "oneshot", projectId = null, identifier = null, instance = null, parentSince = null } = {}) {
  const inContainer = purpose !== "agent" && Boolean(instance);
  if (inContainer) {
    projectId = String(instance.projectId || projectId || "") || null;
    identifier = identifier || instance.identifier || (projectId ? `${projectId}/${instance.instance || "main"}` : null);
  }
  const u = startLock(chatId, purpose === "agent" ? "agent" : "oneshot", { projectId, identifier, inContainer, parentSince });
  if (!u) return null;
  return { ok: false, project: u, text: String(u.text || "") };
}
