// Triggers and lifetime of a copy. A copy disappears when it is cleared away and together with its project or workspace —
// NOT with the deletion or archiving of a chat: it belongs to no chat, a deleted chat is just one user less. Disappearing
// goes ONLY through the one clear-away path (stacks/clearAway.js clearAwayCopy: fetch and back up first, then remove). This
// file is the ONLY caller of clearAwayCopy (no second clear-away path); every trigger goes through `removeCopy`.
//
// removeCopy(identifier, { reason, retrieve = [], from = "human" }) → Promise<{ state, copy, report?, open? }>
//   identifier  the id of the row in stack_copies (number, “17” or `{ id }`) — the form for rows WITHOUT an instance row (a
//               waiting one has no instance identifier yet) — or the identifier `<projectId>/copy-<name>` (the live row of
//               that name).
//   reason      TRIGGER: “rest” (DELETE …/stack-copies/:name), “tool”, “project-deleted”, “workspace-deleted”,
//               “restartGrace”.
//   from        who triggers: “human” (the pill, REST), “agent” (the tool), “cbase” (automatic: deleting a project or
//               workspace, after a restart — `automatic: true` to clearAwayCopy: the upper layer of the ignored files is
//               backed up as a tar, never back into main); also `{ who, chatId }` (the calling chat).
//   retrieve    paths of ignored files or new repos that shall go back into main (checked by the clear-away path).
//   Throws only synchronously for a wrong form (TypeError); the promise never rejects.
//
// THE JOB is in the copy's journal BEFORE any effect (section `trigger`: reason, from, retrieve, automatic, since; a second
// trigger adds to it — `retrieve` united, `automatic` stays true, the latest `reason`/`from` wins): the queue never starts a
// row with a job (stacks/state.js removeJob), and the restart picks it up again.
// Then per state of the row:
//   waiting_*         clearAwayCopy at once — it sets the row straight to `removed`: no build, no wake-up call (not for
//                     “human” either — the route's answer says it already; a silent hint if the chat exists). The condition
//                     is stacks/inset.js waitingStill, the same as the route's.
//   build             nothing now: the build runs to its end (aborting in the middle of a pause would endanger the thawing),
//                     its end wakes (stacks/queue.js → wakeQueue → copiesRemoveWake, server.js), and the row in `ready` or
//                     `error` takes the path below. A restart in the middle of the build dismantles, the row waits again,
//                     and its job sets it to `removed`.
//   ready             phase `earmarked` (only in stack_copies; the instance row stays `ready` and does not hold `busy`),
//                     then as below.
//   clearAway/earmarked  executed as soon as `instanceIdle` (projectbox/idle.js) reports the copy empty — otherwise it stays
//                     earmarked and the wake-up asks again (at the end of every turn, at the end of a build or clear-away,
//                     on the check-back interval). A turn running IN the copy is open work of the copy (pinned through its
//                     identifier, runs/instance.js turnIdentifier) — so from inside the copy the clearing away always
//                     happens after the end of the own turn, and the caller never loses its own container.
//   clearAway/fetch … its clear-away lives in this process ⇒ the same promise; otherwise (after a restart) it is continued —
//                     clearAwayCopy is idempotent through the journal.
//   error             clearAwayCopy (leftovers of a failed build or clear-away: what is there goes by id).
// The RESULT: into the log (`[stacks] copy … removed/error — <report>`) and into the row (written by the clear-away path:
// report, error); then per trigger — woken (runs/queue.js deliverUserPrompt, cause “event”: never into the running turn) is
// ONLY the chat that triggered the clear-away as an AGENT; everyone else learns it silently (runs/hints.js), an archived
// chat too (a wake-up call would pull it out of the archive), after a deleted chat only the log:
//   “agent” with `chatId`     (the tool cbase_copy_stack_remove, the route checks the chat against the fence token) ⇒ the
//                             wake-up call to ITS chat (wakeCaller), whoever created the copy; the creator then learns it
//                             silently.
//   “agent” without `chatId`  (the old tool path — a call through the fence that does not name its chat) ⇒ the wake-up
//                             call to the creating chat, but only with `inset` (an agent created the copy with the tool —
//                             its chat waits for the result); without `inset` silent.
//   “human”                   (REST: the “Instances” tab, the pill) ⇒ NEVER a wake-up call, with `inset` neither — at most
//                             the silent hint to the creator. A wake-up call would start an unrequested model turn that
//                             costs quota and tells the agent a wrong situation.
//   “cbase”                   ⇒ silent.
// Every message names the place where the chat works NOW (`chats.instance` after moving out — `locationOfThe`), never a
// fixed “in main”. The chats working in the copy learn it silently too: after `removed` the moving out tells them
// (stacks/inset.js, separator and silent hint), after `error` this file does.
// The LOCK before it (removeLock): the route asks it BEFORE a job is created — work of another chat or without a chat in
// the copy is 409 INSTANCE_WORKING; `earmarked` remains only for the own turn of the calling agent.
// If the server is ending (runs/server-end.js serverEnds), nothing begins; the job waits for the restart.
//
// NO lock reason of its own in `earmarked`. A new turn of the chat begins there as in `ready` (in the copy) and postpones
// the clearing away until the next idle moment. Reason: a waiting turn would sit in the wait row, and that is open work of
// the copy — it would never be empty (a standstill, not a lock); and a lock from `earmarked` on would be `clearAway` from
// the first moment (`busy` for hours). Locking starts at step 0 of the clear-away path (instance row `clearAway`, lock
// first, then idle) — there a new turn waits at the lock of its identifier and runs in main after `removed`.
//
// THE TRIGGERS (wired in server.js):
//   REST          stacks/routes.js DELETE …/stack-copies/:name (from “human”).
//   Deleting      projectbox/erase.js deleteProjectbox, both paths (setCopyDeleteStep → copyDeleteStep).
//   Restart       copiesRemoveRestartGrace (server.js, in the restart timer after copiesRestartGrace): continue a
//                 `clearAway` without a running procedure, every job back into the wake-up — woken only after the
//                 orphans (removeCopyOrphans).
//   NO trigger:
//     Deleting a chat  the chat only loses its binding — its row in `chats` goes, the copy lives on, its `chat_id` then
//                 names a chat that no longer exists (wake-up calls to it are dropped). The closing path (chats/erase.js)
//                 NEVER touches `<runtime>/copy-worktrees/`.
//     Archive     `chats.instance` STAYS (the archive is reversible: brought back, the chat keeps working where it was; if
//                 the copy was cleared away meanwhile, the moving out has already reset the column). As long as a copy the
//                 chat created is working (build, clear-away from `fetch` on), the chat is not archived: reason “copy” of
//                 the open work (runs/archive.js setCopyWork → copyWorkOf) — its wake-up call at `ready`/`error` would be
//                 meant for it.
//     Project switch  the PATCH resets `chats.instance` in the same UPDATE (store/chats.js updateChat), the chat works in
//                 main in the new project — or in the instance the same PATCH chooses (`toInstance`); copyAtProjectSwitch
//                 deposits the silent hint.
//   Failure       clearAway → error (e.g. “Backup pending”): the copy stays the binding of the chats in it
//                 (copyOfTheChat includes `error` with wasReady) — the lock of its instance row `error` ends every start
//                 visibly with the reason (projectbox/idle.js projectLock), never a silent main; a new attempt (clearAway)
//                 or `removed` resolves it.
// No deadline: a copy lives until a trigger clears it away.
//
// Graph child: a child chat of a graph run, pinned in the copy of its orchestrator (`graph_starts.instance`), counts toward
// the idleness of the copy — it is never cleared away under a running child; after `removed` its next turn runs in main
// (the column back to main, silent hint).
//
// Knob: CBASE_COPY_CHECK_BACK_MS (integer ≥ 100, default 60 s) — the check-back interval of an earmarked copy. A product
// cap that says it is one: the usual path is the end of a turn or build; the interval catches an idle moment that comes
// without them (an ending subagent, workflow, monitor). No test promise depends on it: stacks-remove.test.js (4) sets it
// to an hour and requires the clearing away after the end of the turn.
//
// `report2` wakes the chat ONCE per job and state (marker `reported` in the job — a copy stuck in `error` would otherwise
// wake after every restart); the wake-up catches a synchronous throw per job (it would otherwise leave the setImmediate as
// an uncaughtException and end the server), the job stays open, the interval looks again.
//
// Guards: server/backend/test/stacks-remove.test.js (also the lock and the wake-up call to the caller; a human never
// wakes, the old tool path wakes the creator), stacks-remove-notice.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { LABEL_CHAT, LABEL_INSTANCE, LABEL_PROJECT, copyInstance, copyNameOf } from "../projectbox/creation.js";
import { projectboxOps } from "../projectbox/ops.js";
import { DockerError, docker } from "../projectbox/docker.js";
import { helperCleanedUp } from "../projectbox/helper.js";
import { instanceWork, instanceWorkingError, instanceIdle } from "../projectbox/idle.js";
import { onlyOwn } from "../projectbox/erase.js";
import { FINISHED_MARKER } from "../runs/completionNotice.js";
import { depositHint } from "../runs/hints.js";
import { deliverUserPrompt } from "../runs/queue.js";
import { serverEnds } from "../runs/server-end.js";
import { clearAwayCopy } from "./clearAway.js";
import { neverBuilt, setClearAwayRunning, wasReady, waitingStill } from "./inset.js";
import { wakeQueue } from "./queue.js";
import { removeJob, setCopyState } from "./state.js";

// The seam to the clear-away path: without a setting the real clearing away. The guards of the triggers
// (server/backend/test/stacks-remove.test.js) set a recording stand-in — they check THAT and WITH WHICH
// `reason`/`automatic` it is cleared away, never what was fetched; the path trigger → real clear-away is held by
// stacks-clear-away.test.js.
let clearer = clearAwayCopy;
export function setCopyClearerForTest(fn) { clearer = typeof fn === "function" ? fn : clearAwayCopy; }

export const TRIGGER = Object.freeze(["rest", "tool", "project-deleted", "workspace-deleted", "restartGrace"]);
export const WHO = Object.freeze(["human", "agent", "cbase"]);
const SOURCE = "stack-copy";
const TEXT_MAX = 800;
export const CHECK_BACK_MS = 60_000;

const text = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, TEXT_MAX);
const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The check-back interval (header, knob). */
export function copyCheckBackMs() {
  const raw = process.env.CBASE_COPY_CHECK_BACK_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms >= 100 ? ms : CHECK_BACK_MS;
}

// Per row a key with more than the id: tests run several databases in the same process (pattern of stacks/queue.js).
const key = (k) => `${k.id}|${k.projectId}|${k.name}|${k.requestedAt}`;
const running = new Map(); // key → promise of the clear-away running in THIS process
const open = new Map(); // key → id: jobs waiting for idleness or for the end of their build
// stacks/inset.js asks here whether a job still runs or waits in THIS process — a failed clear-away (reported, no longer
// in `open`) needs a new call, a running one does not.
setClearAwayRunning((k) => { const s = key(k); return running.has(s) || open.has(s); });

// ── Forms ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function ofForm(from) {
  const v = typeof from === "string" ? { who: from } : from && typeof from === "object" && !Array.isArray(from) ? from : null;
  if (!v || !WHO.includes(v.who)) throw new TypeError(`removeCopy: from “${typeof from === "string" ? from : JSON.stringify(from)}” — ${WHO.join(" | ")} (or { who, chatId })`);
  return { who: v.who, ...(v.chatId ? { chatId: String(v.chatId) } : {}) };
}

function retrieveForm(r) {
  if (r === undefined || r === null) return [];
  if (!Array.isArray(r) || r.some((x) => typeof x !== "string" || !x)) throw new TypeError("removeCopy: retrieve is a list of paths (text)");
  return [...new Set(r)];
}

/** The row for an identifier (header) — null if there is no live one. A wrong form THROWS. */
export function copyRowTo(identifier) {
  if (typeof identifier === "number" && Number.isInteger(identifier)) return store.stackCopy(identifier);
  if (typeof identifier === "string" && /^[0-9]+$/.test(identifier)) return store.stackCopy(Number(identifier));
  if (identifier && typeof identifier === "object" && Number.isInteger(Number(identifier.id))) return store.stackCopy(Number(identifier.id));
  if (typeof identifier === "string" && identifier.lastIndexOf("/") > 0) {
    const i = identifier.lastIndexOf("/");
    const name = copyNameOf(identifier.slice(i + 1)); // throws for an invalid instance
    if (name === null) throw new TypeError(`removeCopy: “${identifier}” is main, not a copy`);
    return store.liveStackCopy(identifier.slice(0, i), name);
  }
  throw new TypeError(`removeCopy: no identifier “${identifier}” — the id from stack_copies or <projectId>/copy-<name>`);
}

const identifierOf = (k) => store.instanceIdentifier(k.projectId, copyInstance(k.name));

// Record the job (header “THE JOB”) — synchronously, before any effect.
function rememberJob(k, { reason, from, retrieve }) {
  const old = removeJob(k);
  const a = {
    reason, from,
    retrieve: [...new Set([...(Array.isArray(old?.retrieve) ? old.retrieve : []), ...retrieve])],
    automatic: Boolean(old?.automatic) || from.who === "cbase",
    since: old?.since || Date.now(),
    ...(old && old.reason !== reason ? { prior: old.reason } : {}),
  };
  store.writeStackCopyJournal(k.id, { data: { trigger: a } });
  return a;
}

// ── The lock ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The LOCK before the job of a clear-away through REST or the tool — a question, no effect. If something works in the copy
 * (projectbox/idle.js instanceWork, the same calculation as the work lock of the instance actions and the idleness before
 * clearing away), it throws 409 INSTANCE_WORKING `{ chats, open }` (instanceWorkingError) — the route answers with it, and
 * NO job is written to the journal. The one exception: `caller` (the tool's chat, checked by the route against the fence
 * token) and ALL work in the copy belongs to this chat (its own turn, its subagents) and nothing works without a chat ⇒
 * null, and removeCopy keeps `earmarked` until their end. A human through REST has no turn of their own (`caller` null):
 * any work is 409. Earmarking silently under the turn of ANOTHER chat would wait until that one ended and then take its
 * instance away. The automatic triggers (deleting a project or workspace, restart) do not ask it: they have their own locks.
 */
export function removeLock(k, { caller = null } = {}) {
  if (!k) return null;
  const instance = copyInstance(k.name);
  const work = instanceWork(k.projectId, instance);
  if (work.quiet) return null;
  const onlyOwn = Boolean(caller) && work.open.length === 0 && work.chats.length > 0 && work.chats.every((c) => c.id === String(caller));
  if (onlyOwn) return null;
  throw instanceWorkingError(work, instance);
}

// ── The entry ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function removeCopy(identifier, { reason, retrieve = [], from = "human" } = {}) {
  if (!TRIGGER.includes(reason)) throw new TypeError(`removeCopy: reason “${reason}” — ${TRIGGER.join(", ")}`);
  const v = ofForm(from);
  const list = retrieveForm(retrieve);
  const k = copyRowTo(identifier);
  if (!k || k.state === "removed") return Promise.resolve({ state: "removed", copy: k || null, report: k ? "already removed" : "no live copy" });
  const s = key(k);
  if (running.has(s)) return running.get(s); // already being cleared away: another job changes nothing about that
  rememberJob(k, { reason, from: v, retrieve: list });
  open.set(s, k.id);
  return decide(k.id);
}

// What happens now to a row with a job (header, “per state”). Synchronous up to the call of the clear-away.
function decide(id) {
  const k = store.stackCopy(id);
  if (!k || k.state === "removed") {
    if (k) open.delete(key(k));
    return Promise.resolve({ state: "removed", copy: k || null });
  }
  const s = key(k);
  if (running.has(s)) return running.get(s);
  const a = removeJob(k);
  if (!a) { open.delete(s); return Promise.resolve({ state: k.state, copy: k }); }
  // In the ending process no clear-away begins — the job is in the journal, the restart takes it.
  if (serverEnds()) return Promise.resolve({ state: "earmarked", copy: k, reason: "serverEnd" });
  if (waitingStill(k) || k.state === "error") return performAction(k, a);
  if (k.state === "build") return Promise.resolve({ state: "earmarked", copy: k, afterBuild: true });
  let z = k;
  if (k.state === "ready") {
    z = setCopyState(k.id, "clearAway", { phase: "earmarked", reason: `earmarked (${a.reason})` });
    if (a.from.who === "human") {
      hint(z, T`Your copy "${z.name}" is marked for removal: it is removed (fetched, backed up, deleted) as soon as nothing runs in it anymore — until then it keeps working.`);
    }
  }
  if (z.state === "clearAway" && z.phase !== "earmarked") return performAction(z, a); // a clear-away without a running procedure: continue
  const why = notEmpty(z);
  if (why) {
    planCheckBack();
    return Promise.resolve({ state: "earmarked", copy: store.stackCopy(z.id), open: why });
  }
  return performAction(z, a);
}

// The idleness of the copy (projectbox/idle.js instanceIdle): null = empty, otherwise what is open. Not readable ⇒ not empty.
function notEmpty(k) {
  try {
    const l = instanceIdle(identifierOf(k));
    return l.quiet ? null : l.open.map((o) => ({ chatId: o.chatId, reason: o.reason }));
  } catch (e) {
    return [{ chatId: "", reason: "unreadable", text: text(e) }];
  }
}

function performAction(k, a) {
  const s = key(k);
  const wasWaiting = waitingStill(k); // discarded, never built — no wake-up call (stacks/inset.js waitingStill: ONE condition with the route)
  // `error` without wasReady — the build failed, nobody ever worked in the copy. The clear-away only takes the leftovers of
  // the build (stacks/clearAway.js, dismantling by id); it fetches nothing and creates no branch copy/<name>/… — the message
  // says so instead of promising commits, branches and a report that do not exist. The condition is stacks/inset.js
  // neverBuilt — the same by which stacks/clearAway.js only dismantles.
  const never = neverBuilt(k);
  let finished;
  const p = new Promise((r) => { finished = r; });
  running.set(s, p); // BEFORE the call: a wake-up in the middle of the synchronous part gets the same promise
  (async () => {
    let r;
    try {
      r = await clearer(k.id, { reason: a.reason, retrieve: a.retrieve || [], automatic: a.automatic === true });
    } catch (e) { r = { state: "error", report: `clearing away threw: ${text(e)}` }; } // contract: never throws — better safe than sorry
    const state = ["removed", "earmarked", "error"].includes(r?.state) ? r.state : "error";
    const report = reportText(r?.report);
    const now = store.stackCopy(k.id) || k;
    console.log(`[stacks] copy ${identifierOf(k)} (${a.reason}, ${a.from.who}${a.automatic ? ", automatic" : ""}): ${state} — ${report}`);
    if (state === "earmarked") { planCheckBack(); return { state, copy: now, report }; } // step 0: not empty
    open.delete(s);
    try { report2(now, a, state, report, { wasWaiting, neverBuilt: never }); } catch (e) { console.error(`[stacks] copy ${identifierOf(k)}: message:`, text(e)); }
    wakeQueue(); // the end of a clear-away (stacks/queue.js — a copy of the same project or of the same name may go now)
    return { state, copy: now, report };
  })().then(finished, (e) => finished({ state: "error", copy: store.stackCopy(k.id) || k, report: text(e) }))
    .finally(() => { if (running.get(s) === p) running.delete(s); });
  return p;
}

function reportText(b) {
  if (b === undefined || b === null) return "no report";
  const t = typeof b === "string" ? b : JSON.stringify(b);
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)} […]` : t;
}

// ── Messages ────────────────────────────────────────────────────────────────────────────────────────────────────────

function hint(k, text, chatId = k.chatId) {
  try { if (chatId && store.getChat(chatId)) depositHint(chatId, text, { source: SOURCE }); }
  catch (e) { console.error(`[stacks] hint ${k.projectId}/${k.name}:`, text(e)); }
}

// Where a chat works NOW (header, “Every message names the place”): `chats.instance`, read AFTER the moving out — that has
// already reset the chats of the cleared-away copy to main; whoever works in ANOTHER copy stays there. Not readable ⇒
// "main" (a message, not a binding).
function locationOfThe(chatId) {
  try { return (chatId && store.chatInstance(chatId)) || "main"; } catch { return "main"; }
}
const locationDe = (location) => (location === "main" ? "in the main instance" : `in ${location}`);
const locationShown = (location) => (location === "main" ? T("in the main instance") : `in ${location}`);

// The wake-up call (header, “The RESULT”) — in the form of a system message (runs/completionNotice.js FINISHED_MARKER,
// without <status>: Web and iOS show it as a system message, not a user bubble). Only identifiers and the report.
// `neverBuilt` (performAction): a copy whose build failed — only leftovers were removed, there is nothing under copy/<name>/….
// `location` (locationOfThe): the instance in which the woken chat works NOW — main or another copy.
// Web and iOS read only `<summary>` (web/src/lib/completionNotice.ts, Chat/CompletionNotice.swift) and recognise its English
// wording — it changes only together with the two readers (web/test/completion-notice-binding.test.mjs); the `<note>` may change.
export function copyWakeText(k, state, report, { neverBuilt = false, location = "main" } = {}) {
  const inst = copyInstance(k.name);
  const ok = state === "removed";
  const summary = ok
    ? (neverBuilt ? `Copy "${k.name}" removed (never built)` : `Copy "${k.name}" removed`)
    : `Copy "${k.name}" not removed: ${String(k.error || report).split("\n")[0].slice(0, 300)}`;
  const inMain = location === "main";
  const note = ok && neverBuilt
    ? `This is a system message about the copy ${k.projectId}/${inst}, not a user reply. It was never built — there was nothing in it to fetch or back up; only the leftovers of its failed build were removed. This chat keeps working ${locationDe(location)}; a new attempt goes ${inMain ? "" : "from the main instance "}with cbase_copy_stack.`
    : ok
      ? `This is a system message about the copy ${k.projectId}/${inst}, not a user reply. This chat works ${inMain ? "in the main instance of the project" : `in ${location}`}; what the copy had in commits and open work is in the main instance under the branches copy/${k.name}/… (report above).`
      : `This is a system message about the copy ${k.projectId}/${inst}, not a user reply. It is in “error” and is NOT removed; nothing is lost. The reason is above.`;
  return [FINISHED_MARKER, `<task-id>${xml(inst)}</task-id>`, `<summary>${xml(summary)}</summary>`, `<result>${xml(report)}</result>`, `<note>${xml(note)}</note>`, "</task-notification>"].join("\n");
}

// A result that is not an end (`error`) is reported ONCE per job. Otherwise every restart started a new wake-up turn: the
// restart picks up the job of a copy in `error` again (copiesRemoveRestartGrace), the clear-away fails again, and `report2`
// would wake the chat every time. The marker `reported: { state, at }` is in the job (journal section `trigger`) and
// survives the restart; a NEW trigger (rememberJob builds the job without it) reports again, as does a different result.
// `removed` does not need it (afterwards there is no job).
function alreadyReported(a, state) { return state !== "removed" && a?.reported?.state === state; }
function reportedRemember(k, a, state) {
  if (state === "removed") return;
  try {
    const now = removeJob(store.stackCopy(k.id)) || a; // the job as it stands NOW
    store.writeStackCopyJournal(k.id, { data: { trigger: { ...now, reported: { state, at: Date.now() } } } });
  }
  catch (e) { console.error(`[stacks] copy ${identifierOf(k)}: message not recorded (${text(e)}) — a restart reports once more`); }
}

function report2(k, a, state, report, { wasWaiting = false, neverBuilt = false } = {}) {
  const ok = state === "removed";
  // The chats working in the copy (`chats.instance`), except the creating one — after `removed` the moving out has already
  // reset and notified them (the list is empty then); after `error` they stay bound and learn it here, silently. Without
  // the calling agent chat — it gets the wake-up call (wakeCaller).
  const caller = a?.from?.who === "agent" && a.from.chatId ? String(a.from.chatId) : "";
  const inside = ok ? [] : store.chatsInInstance(k.projectId, copyInstance(k.name)).filter((id) => id !== k.chatId && id !== caller);
  const already = alreadyReported(a, state);
  if (inside.length && !already) {
    for (const id of inside) {
      hint(k, T`The copy "${k.name}" this chat works in could not be removed (${a.reason}): ${String(k.error || report).slice(0, 300)} — it is in "error", nothing is lost.`, id);
    }
  }
  // If an AGENT triggered the clear-away (the tool, `from: { who: "agent", chatId }`), the result wakes ITS chat — it waits
  // for it, whoever created the copy. The creator (if another chat) then only learns it silently.
  if (wakeCaller(k, a, state, report, { wasWaiting, neverBuilt, inside, already })) return;
  const chat = k.chatId ? store.getChat(k.chatId) : null;
  if (!chat) { // chat deleted or created without a chat: only the log — and the marker if somebody was told
    if (inside.length && !already) reportedRemember(k, a, state);
    return;
  }
  if (already) {
    console.log(`[stacks] copy ${identifierOf(k)}: “${state}” is already reported for this job — no second wake-up call`);
    return;
  }
  const location = locationOfThe(chat.id);
  if (ok && wasWaiting) {
    hint(k, T`Your requested copy "${k.name}" was discarded (${a.reason}) before it was built — this chat works ${locationShown(location)}.`);
    return;
  }
  // Woken is only who created with `inset` — and only if an AGENT triggered the clear-away on the old tool path (`from:
  // "agent"` without `chatId`; with `chatId` wakeCaller above took over the message, or the caller is gone or archived —
  // then the creator learns it silently). A HUMAN (REST) never wakes: the creator waits for nothing, and a wake-up call
  // would start an unrequested model turn.
  if (a.from.who === "agent" && !a.from.chatId && !chat.archivedAt && k.inset) {
    const t = copyWakeText(k, state, report, { neverBuilt, location });
    deliverUserPrompt(chat, { prompt: t, display: t, cause: "event" });
    reportedRemember(k, a, state);
    return;
  }
  reportedRemember(k, a, state);
  if (ok && neverBuilt) {
    hint(k, T`Your copy "${k.name}" was never built and is removed (${a.reason}) — there was nothing in it to save; this chat works ${locationShown(location)}.`);
    return;
  }
  hint(k, ok
    ? T`Your copy "${k.name}" was removed (${a.reason}): its commits and open work are in the main instance under copy/${k.name}/…; this chat works ${locationShown(location)}.`
    : T`Your copy "${k.name}" could not be removed (${a.reason}): ${String(k.error || report).slice(0, 300)} — it is in "error", nothing is lost.`);
}

// The wake-up call to the calling agent chat (report2). → true if this path took over the message. Without `from.chatId` (a
// human, an older tool call without a chat, an automatic trigger) `report2` decides (header: only the creator is woken
// there, and only on the old tool path). A waiting request (discarded) never wakes — the tool's answer said it already. If
// the chat is gone or archived, nothing.
function wakeCaller(k, a, state, report, { wasWaiting, neverBuilt, inside, already }) {
  const id = a?.from?.who === "agent" && a.from.chatId ? String(a.from.chatId) : "";
  if (!id) return false;
  const chat = store.getChat(id);
  if (!chat) return false;
  if (already) {
    console.log(`[stacks] copy ${identifierOf(k)}: “${state}” is already reported for this job — no second wake-up call`);
    return true;
  }
  if (state === "removed" && wasWaiting) return false; // the path below only deposits the silent hint
  if (!chat.archivedAt) {
    const t = copyWakeText(k, state, report, { neverBuilt, location: locationOfThe(id) });
    deliverUserPrompt(chat, { prompt: t, display: t, cause: "event" });
  }
  // The creator (another chat that still lives) learns it silently — it did not trigger the clear-away.
  if (k.chatId && k.chatId !== id && !inside.includes(k.chatId)) {
    const ok = state === "removed";
    hint(k, ok
      ? T`Your copy "${k.name}" was removed (${a.reason}, by another chat): its commits and open work are in the main instance under copy/${k.name}/….`
      : T`Your copy "${k.name}" could not be removed (${a.reason}, by another chat): ${String(k.error || report).slice(0, 300)} — it is in "error", nothing is lost.`);
  }
  reportedRemember(k, a, state);
  return true;
}

// ── The wake-up ─────────────────────────────────────────────────────────────────────────────────────────────────────

let scheduled = false;
let checkBack = null;

/** Decide every open job anew — in the next turn of the event loop, batched. Without a job: nothing. */
export function copiesRemoveWake() {
  if (!open.size || scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    // A SYNCHRONOUS throw here (reading the row, `decide` up to the call of the clear-away: setCopyState, a “database is
    // locked” beyond busy_timeout, …) would leave the setImmediate as an uncaughtException and end the server. Caught per
    // job: the job stays open, the interval looks again, the other jobs go on. Synchronous as before — the order of the
    // calls does not change.
    let warf = false;
    for (const [s, id] of [...open]) {
      try {
        const k = store.stackCopy(id);
        if (!k || key(k) !== s) { open.delete(s); continue; } // another database (tests) or gone
        decide(id).catch((e) => console.error(`[stacks] remove ${k.projectId}/${k.name}:`, text(e)));
      } catch (e) {
        warf = true;
        console.error(`[stacks] remove: job ${id} threw in the wake-up (${text(e)}) — stays earmarked, the interval looks again`);
      }
    }
    if (warf) planCheckBack();
  });
}

function planCheckBack() {
  if (checkBack || !open.size) return;
  const ms = copyCheckBackMs();
  checkBack = setTimeout(() => {
    checkBack = null;
    if (!open.size) return;
    console.log(`[stacks] remove: check-back after ${ms} ms (cap CBASE_COPY_CHECK_BACK_MS) — ${open.size} earmarked`);
    copiesRemoveWake();
    planCheckBack();
  }, ms);
  checkBack.unref?.();
}

/** Hook for the turn end (server.js): after the rest of the turn end the idleness counts. */
export function copiesRemoveTurnEnd() { copiesRemoveWake(); }

/** When the server closes (server.js): wake-up and interval gone — the next start reads the jobs anew. */
export function copiesRemoveCleanUp() {
  open.clear();
  scheduled = false;
  if (checkBack) { clearTimeout(checkBack); checkBack = null; }
}

/** Test seam and view: open jobs and running clear-aways in this process. */
export const removeStatus = () => ({ open: [...open.values()], running: running.size });

// ── The triggers ────────────────────────────────────────────────────────────────────────────────────────────────────

/** runs/archive.js setCopyWork: a copy the chat created, as long as it works (build, clear-away from `fetch` on), otherwise
 *  null. A chat can have created several — the first working one in request order. */
export function copyWorkOf(chatId) {
  for (const k of store.liveStackCopiesOfChat(chatId)) {
    if (k.state === "build" || (k.state === "clearAway" && k.phase !== "earmarked")) return { name: k.name, state: k.state, phase: k.phase };
  }
  return null;
}

/**
 * Does this copy carry work (ready, clearAway) or did it (error after it was ready)? The states in which a binding to it
 * holds (copyOfTheChat); the migration that freed the copies asks the same question (stacks/inset.js).
 */
export const copyCarriesBinding = (k) => Boolean(k) && (["ready", "clearAway"].includes(k.state) || (k.state === "error" && wasReady(k)));

/**
 * The instance from `chats.instance` — null for main; otherwise `{ projectId, instance }` in the chat's project, with
 * `tot: true` if there is no live copy for it that carries or carried work (`copyCarriesBinding`: a failed clear-away would
 * otherwise let the chat fall silently into main while the unsaved work lies in the copy; the lock of its instance row
 * `error` holds every start with a message).
 */
export function copyOfTheChat(chatId) {
  const instance = chatId ? store.chatInstance(chatId) : null;
  if (!instance) return null;
  const chat = store.getChat(chatId);
  if (!chat?.projectId) return null; // without a project no instance applies (the switch resets the column)
  let name = null;
  try { name = copyNameOf(instance); } catch { name = null; } // a broken column is dead, never main
  const k = name ? store.liveStackCopy(chat.projectId, name) : null;
  if (!copyCarriesBinding(k)) return { projectId: chat.projectId, instance, tot: true };
  return { projectId: k.projectId, instance: copyInstance(k.name), state: k.state, phase: k.phase };
}

/** At a project switch: the silent hint that the chat has left its copy — the column fell in the same UPDATE, and a switch
 *  back does NOT bind it again (the instance is chosen in the chat).
 *  `toInstance`: the instance the SAME PATCH chooses in the new project — the sentence names it; without it the chat works
 *  in main there (otherwise the hint would say main while the next turn runs in the chosen copy). */
export function copyAtProjectSwitch({ chatId, ofProject = null, toProject = null, ofInstance = null, toInstance = null } = {}) {
  if (!chatId || !ofInstance || !ofProject) return;
  let name;
  try { name = copyNameOf(ofInstance); } catch { return; }
  if (!name) return;
  const k = { projectId: ofProject, name, chatId };
  const title = (pid) => store.getProject(pid)?.name || pid;
  const there = toProject && toInstance && toInstance !== "main" ? String(toInstance) : "main";
  hint(k, T`This chat is now ${toProject ? T`in the project "${title(toProject)}"` : T("without a project")} and works there in ${there}. The copy "${name}" in the project "${title(ofProject)}" lives on — nothing from here runs in it; the chat only gets back into it by choosing its instance.`, chatId);
}

/**
 * projectbox/erase.js setCopyDeleteStep: if a copy of one of the projects lives, trigger the clear-away for EACH and answer
 * 409 — otherwise null (the deletion goes on as before). Identifiers and words, never a value.
 */
export function copyDeleteStep(projectIds, { way = "workspace" } = {}) {
  const live = [...new Set((projectIds || []).map(String))].flatMap((pid) => store.liveStackCopies(pid));
  if (!live.length) return null;
  const reason = way === "project" ? "project-deleted" : "workspace-deleted";
  for (const k of live) {
    try { removeCopy(k.id, { reason, from: "cbase" }).catch((e) => console.error(`[stacks] delete ${k.projectId}/${k.name}:`, text(e))); }
    catch (e) { console.error(`[stacks] delete ${k.projectId}/${k.name}: job not placed:`, text(e)); } // the 409 holds anyway
  }
  const copies = live.map((k) => {
    const j = store.stackCopy(k.id) || k;
    return { projectId: j.projectId, name: j.name, instance: copyInstance(j.name), state: j.state, phase: j.phase };
  });
  const names = copies.map((k) => k.name).join(", ");
  const one = copies.length === 1;
  return {
    status: 409,
    body: {
      // User-visible like the neighbouring routes — through T.
      error: one ? T`Copy ${names} is being removed — delete again afterwards` : T`Copies ${names} are being removed — delete again afterwards`,
      code: "COPY_CLEAR_AWAY", projectId: copies[0].projectId, copies,
    },
  };
}

// ── Restart ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * server.js, in the restart timer after copiesRestartGrace: every row with a job back into the wake-up, a clear-away
 * without a running procedure (`clearAway` from `fetch` on) is continued — also without a job (then “restartGrace”,
 * automatic). Only after the helper orphans were cleaned up (projectbox/helper.js helperCleanedUp — a helper of the last
 * server run may otherwise still hang on the copy), and only after the orphans (below). Returns `{ jobs, finished }` —
 * `finished` is the promise of the orphans and of the waking (for tests; the clear-away itself runs afterwards in the wake-up).
 */
export function copiesRemoveRestartGrace() {
  let jobs = 0;
  for (const k of store.liveStackCopies()) {
    const a = removeJob(k);
    const half = k.state === "clearAway" && k.phase !== "earmarked";
    if (!a && !half) continue;
    const s = key(k);
    if (running.has(s)) continue;
    if (!a) {
      try { rememberJob(k, { reason: "restartGrace", from: { who: "cbase" }, retrieve: [] }); }
      catch (e) { console.error(`[stacks] restart ${k.projectId}/${k.name}: job not recorded:`, text(e)); continue; }
    }
    open.set(s, k.id);
    jobs += 1;
  }
  // First the orphans, then the wake-up: a clear-away that removes objects alongside shall not cross their reading (the
  // objects of live rows are no orphans anyway).
  const finished = helperCleanedUp().then(async () => {
    const b = projectboxOps() ? await removeCopyOrphans() : { container: [], networks: [], error: [] };
    copiesRemoveWake();
    return b;
  }).catch((e) => {
    copiesRemoveWake();
    console.error("[stacks] restart of the copies:", text(e));
    return { container: [], networks: [], error: [text(e)] };
  });
  return { jobs, finished };
}

// An object with the chat label is an orphan if for its instance there is neither a live row in stack_copies nor an
// instance row AND its chat is missing — everything else can still be assigned.
function waise(labels) {
  const pid = labels?.[LABEL_PROJECT];
  const chatId = labels?.[LABEL_CHAT];
  if (!pid || !chatId) return false;
  let name;
  try { name = copyNameOf(labels[LABEL_INSTANCE]); } catch { return false; }
  if (!name) return false; // a main never carries the label — not ours
  if (store.liveStackCopy(pid, name)) return false;
  if (store.projectInstance(pid, copyInstance(name))) return false;
  return !store.getChat(chatId);
}

const idsFrom = (t) => String(t || "").split(/\s+/).filter(Boolean);
const missing = (e) => e instanceof DockerError && /No such (object|container|network)|not found/i.test(`${e.stderr}\n${e.message}`);

// The labels per object, read ONE BY ONE: an object that disappears between list and read (a clear-away alongside) is then
// only missing itself — `docker inspect a b` would otherwise end with exit 1 for all.
async function labelsRead(ids, kind, error) {
  const out = new Map();
  const format = kind === "network" ? "{{json .Labels}}" : "{{json .Config.Labels}}";
  for (const id of ids) {
    try {
      const r = kind === "network"
        ? await docker(["network", "inspect", "--format", format, id])
        : await docker(["inspect", "--type", "container", "--format", format, id]);
      out.set(id, JSON.parse(String(r.stdout || "").trim() || "null") || {});
    } catch (e) {
      if (!missing(e)) error.push(`read ${kind === "network" ? "network" : "container"} ${id.slice(0, 12)}: ${text(e)}`);
    }
  }
  return out;
}

/**
 * Removes orphaned containers and networks of a copy (chat label, set ON the container) by id. Only with the ops marker.
 * The volume of a copy carries no chat label and stays — it is in the log.
 */
export async function removeCopyOrphans() {
  const report = { container: [], networks: [], error: [] };
  if (!projectboxOps()) return report;
  // Containers: only those carrying the labels ON the container (projectbox/erase.js onlyOwn — ONE filter with deletion and dismantling).
  try {
    const { own } = await onlyOwn(idsFrom((await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${LABEL_CHAT}`])).stdout));
    const labels = await labelsRead(own, "container", report.error);
    for (const [id, l] of labels) {
      if (!waise(l)) continue;
      try { await docker(["rm", "-f", id]); report.container.push(id); }
      catch (e) { if (!missing(e)) report.error.push(`container ${id.slice(0, 12)}: ${text(e)}`); }
    }
  } catch (e) { report.error.push(`read containers: ${text(e)}`); }
  // Networks (a network inherits no labels).
  try {
    const networks = idsFrom((await docker(["network", "ls", "-q", "--no-trunc", "--filter", `label=${LABEL_CHAT}`])).stdout);
    const labels = await labelsRead(networks, "network", report.error);
    for (const [id, l] of labels) {
      if (!waise(l)) continue;
      try { await docker(["network", "rm", id]); report.networks.push(id); }
      catch (e) { if (!missing(e)) report.error.push(`network ${id.slice(0, 12)}: ${text(e)}`); }
    }
  } catch (e) { report.error.push(`read networks: ${text(e)}`); }
  if (report.container.length || report.networks.length || report.error.length) {
    console.log(`[stacks] restart: orphaned copy objects — ${report.container.length} container(s), ${report.networks.length} network(s) removed${report.error.length ? `; ${report.error.join("; ")}` : ""} (volumes of a copy carry no chat label and stay)`);
  }
  return report;
}
