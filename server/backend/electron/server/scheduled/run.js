// The run of a scheduled job: deliver an occurrence (startRun), the run end (row, repetition, one-time done) and the
// subscribers of the hooks that server.js registers. A run is NOT a new chat: every occurrence is a message to THE SAME
// Coding chat the job carries (`chats.job_id`) — cause "schedule", through the ordinary delivery (runs/queue.js
// deliverUserPrompt). If the chat is busy, compacting, parked or locked, the occurrence is queued and runs in FIFO order
// with the human's entries; an occurrence goes alone (headerBundle) and never into an open process (runs/state.js
// inputFitsIntoTheRun), a scheduled turn takes in nothing else (`causeBound`, do-run.js).
// One `doRun` therefore carries at most ONE scheduled run.
//
// The mapping turn ↔ run: the occurrence carries the id of its run as the marker `scheduledRun` — in the queue entry and in
// the turn's input (runs/queue.js deliverUserPrompt, runs/human-input.js inputOf; if a gate holds the turn back behind a
// foreign wait row, it travels in the new entry, runs/limit-gate.js parkOrQueue). Run start ("turnStart") and run end
// ("beforeRunBroadcast") read it from the inputs. Without a marker — the resume after a restart (runs/resume.js) and the
// continuation of a wait row carry no inputs — the run that the start of this turn took over applies (`runInTurn`), and
// only where that is missing too, the OLDEST open run that is not waiting in the queue: after a restart exactly the one
// scheduledAtStart left open. A run without a turn does not stay open, because EVERY path on which a turn ends without
// the finally of doRun reports its end: the throw in the gate (runs/limit-gate.js clearAwayGateWithoutTurn) and the
// abandoned resume (scheduledAbandoned). A parked turn (limit, credit gate) ends only with its continuation.
//
// The subscribers (registered in server.js; hooks.js throws on a duplicate name):
//   turnStart             "scheduled"      scheduledTurnStart       the real start: `startedAt`, open question
//   beforeRunBroadcast    "scheduled-end"  scheduledEndHook         run end (cause "schedule", not parked); if background
//                                                                   work of the chat is still running, the run waits for "end"
//   end                   "scheduled"      scheduledWorkEnd         the end of work: a run that waited for its background work
//   afterLimitCancel      "scheduled-end"  scheduledDismissedHook   the parked continuation is dismissed ⇒ `aborted` (the human)
//                                                                   or `error` with the wording (attempt cap, switch off, situation)
//   restartGraceAbandoned "scheduled"      scheduledAbandoned       the resume after the restart is given up ⇒ `error`
//   chatClosed            "scheduled"      scheduledChatClosed      the job falls with its chat (the reverse direction; after the row)
//   inputDismissed        "scheduled"      scheduledInputDismissed  the human dismisses the queued occurrence ⇒ `dismissed`
// A chat that is not `kind = normal` gets no occurrence.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { wallTimeText } from "../cron.js";
import { broadcast } from "../runtime/sse.js";
import { deliverUserPrompt } from "../runs/queue.js";
import { pendingRunInputs } from "../runs/state.js";
import { backgroundWork } from "../runs/background.js";
import { dismissAsk, openAskOf } from "../runs/ask.js";
import { getMonitorEvents, resolveNotices } from "../services.js";
import { firstLines } from "../workflows/run-state.js";
import { announcementText, graphSlash } from "../workflows/slash-workflow.js";
import { cadenceText } from "./cadence.js";
import { runEndNotification } from "./notification.js";

// The repetition after the first error (golden runs and tests set the knob).
export const SCHEDULED_REPETITION_MS = () => Math.max(200, Number(process.env.CBASE_SCHEDULE_RETRY_MS || 5 * 60_000));

/** The plain text of the cadence in the UI language — for the system prompt (runs/system-prompt.js setScheduledCadenceText). */
export const cadencePlainText = (a) => cadenceText(a);

const errorWith = (status, text) => Object.assign(new Error(text), { status });
const hint = (chatId, text) => { try { store.addMessage(chatId, "hint", text); } catch (e) { console.error("[scheduled] hint:", e?.message || e); } };
const report = (a, run, status) => broadcast({ type: "scheduled", workspaceId: a.workspaceId, jobId: a.id, runId: run?.id ?? null, chatId: run?.chatId || a.chatId || null, status });

/**
 * Is this run waiting in its chat's queue? Its entry is the one whose id it remembered (`entryId`), or one that carries
 * its marker (`scheduledRun` — the entry a gate created anew behind a foreign wait row). ONE answer for dropout,
 * run end, restart (tick.js) and the state of the UI (routes.js).
 */
export function waitingInTheQueue(l) {
  if (!l?.chatId) return false;
  return (pendingRunInputs.get(l.chatId) || []).some((e) => (l.entryId && e.id === l.entryId) || e.scheduledRun === l.id);
}

/** Is an occurrence of this job already waiting in the queue? Only occurrences count — the human's entries do not. */
const waitingRun = (jobId) => store.openScheduledRuns(jobId).find(waitingInTheQueue) || null;

/** The occurrence message: fixed and short, never with "/" at the start (the CLI would otherwise read a slash command). */
function occurrenceText(a, name, cause, when) {
  const time = `${wallTimeText(when, a.timeZone)} (${a.timeZone})`;
  const addition = cause === "caughtUp" ? T(" · caught up")
    : cause === "repetition" ? T(" · retry after an error")
      : cause === "hand" ? T(" · started by hand") : "";
  return T`Scheduled run "${name}" — ${time}${addition}`;
}

/**
 * Deliver an occurrence. `cause`: "tick" (due), "hand" ("Run now"), "caughtUp", "repetition"; `scheduledAt` the
 * occurrence (ms, default now). Returns `{ run }` — also for a dropped or refused run. Throws (409) when the chat is
 * missing or not one for Scheduled, and for "Run now" while an occurrence of this job is waiting.
 */
export function startRun(job, cause = "tick", { scheduledAt = 0 } = {}) {
  const now = Date.now();
  const chat = job?.chatId ? store.getChat(job.chatId) : null;
  if (!chat) throw errorWith(409, T("The chat of this task is missing"));
  if (chat.kind !== "normal") throw errorWith(409, T("A scheduled task only runs in a coding chat"));
  const when = scheduledAt || now;
  const base = { jobId: job.id, workspaceId: job.workspaceId, chatId: chat.id, cause, scheduledAt: when };

  // 1. Dropout: an occurrence of this job is already waiting — the tick books the new one as failed, "Run now" is 409.
  const waiting = waitingRun(job.id);
  if (waiting) {
    if (cause === "hand") throw errorWith(409, T("A run of this task is already queued"));
    const text = T`Run at ${wallTimeText(when, job.timeZone)} dropped — the one from ${wallTimeText(waiting.scheduledAt, job.timeZone)} is still queued`;
    const run = store.createScheduledRun({ ...base, status: "failed", error: text });
    store.updateScheduledRun(run.id, { endedAt: now });
    hint(chat.id, text);
    report(job, run, "failed");
    return { run: store.getScheduledRun(run.id) };
  }

  // 2. An open question is closed only by the START of the occurrence (scheduledTurnStart), not by its delivery: a queued
  // occurrence waits behind a turn whose card the human can still answer.

  store.updateScheduledJob(job.id, { lastRunAt: now, retryAt: 0, updatedAt: now });
  const run = store.createScheduledRun({ ...base, queuedAt: now });

  // 3. The announcement: `/workflow:` in the instructions works as in a typed message. A refusal ends as an error with
  // its wording; only 409 `open` is repeated — only that can heal within five minutes.
  const g = graphSlash(chat, { text: job.instructions || "" });
  if (g && g.status) {
    endRun(run.id, { error: String(g.body?.error || g.status), repeatable: g.status === 409 && g.body?.reason === "open" });
    return { run: store.getScheduledRun(run.id) };
  }

  // 4. Deliver. `human` is the occurrence message plus the instructions: what the human wrote for this occurrence.
  const display = occurrenceText(job, chat.title || "", cause, when);
  const prompt = g ? announcementText(g.hits, display) : display;
  let r;
  try {
    r = deliverUserPrompt(chat, { prompt, display, cause: "schedule", human: `${display}\n\n${job.instructions || ""}`.trim(), scheduledRun: run.id, ...(g ?{ announcement: g.announcement } : {}) });
  } catch (e) {
    endRun(run.id, { error: String(e?.message || e) });
    throw e;
  }
  if (!r?.ok) endRun(run.id, { error: String(r?.error || T("Delivery refused")) });
  else if (r.entryId) store.updateScheduledRun(run.id, { entryId: r.entryId });
  else if (store.getScheduledRun(run.id)?.status === "open") store.updateScheduledRun(run.id, { startedAt: now });
  const nowRun = store.getScheduledRun(run.id);
  // "running" is reported only by the start of the turn (scheduledTurnStart) — a directly delivered occurrence has passed
  // the gate only there; reporting it here too would put "running" on the stream twice for the same run. Only the
  // queued occurrence reports here.
  if (nowRun?.status === "open" && r?.entryId) report(job, nowRun, "queued");
  return { run: nowRun };
}

/**
 * The short version of a response: its FIRST PARAGRAPH (up to the first blank line), its lines joined with " · ", capped
 * at 200 characters with an ellipsis (firstLines). The job block in the system prompt promises this (the first paragraph
 * of the answer to an occurrence becomes the notification, runs/system-prompt.js). A function of its own: firstLines
 * stays as it is for the notices of the workflows (workflows/gates.js).
 */
export function summary(text) {
  const paragraph = String(text || "").trim().split(/\r?\n[ \t]*\r?\n/)[0] || "";
  return firstLines(paragraph, 200);
}

// The short version of the last response — the notification to the human and `short` of the run row.
function shortOf(chatId, resultText = "") {
  let text = String(resultText || "").trim();
  if (!text) {
    try { text = store.listMessages(chatId).filter((m) => m.role === "assistant").map((m) => m.text).pop() || ""; } catch { /* no text, no teaser */ }
  }
  return summary(text);
}

/**
 * Close a run and update the job: `aborted` (stop, steering, dismissed continuation) is not repeated; the FIRST error
 * sets `retry_at` = now + 5 min, unless `repeatable` is false or it already was the repetition; a one-time job becomes
 * `done` as soon as nothing more follows. A run already closed stays as it is.
 */
export function endRun(runId, { error = "", resultText = "", aborted = false, repeatable = true } = {}) {
  const run = store.getScheduledRun(runId);
  if (!run || run.status !== "open") return null;
  const now = Date.now();
  const status = aborted ? "aborted" : error ? "error" : "ok";
  const reason = String(error || "").slice(0, 300);
  const short = status === "ok" ? shortOf(run.chatId, resultText) : "";
  store.updateScheduledRun(run.id, {
    endedAt: now, status, error: reason, short,
    question: Boolean(openAskOf(run.chatId)), ...(run.startedAt ? {} : { startedAt: run.queuedAt || now }),
  });
  const a = store.getScheduledJob(run.jobId);
  if (a) {
    const again = status === "error" && repeatable && run.cause !== "repetition";
    const finished = !again && a.cadence === "oneTime" && a.status === "active";
    store.updateScheduledJob(a.id, {
      retryAt: again ? now + SCHEDULED_REPETITION_MS() : 0, lastStatus: status, lastError: status === "ok" ? "" : reason, updatedAt: now,
      ...(finished ? { status: "done", nextAt: 0 } : {}),
    });
    report(a, run, status);
    // The notice — its error does not cost the run end.
    try { runEndNotification(a, run, { status, reason, short, again }); } catch (e) { console.error("[scheduled] notification:", e?.message || e); }
  }
  return store.getScheduledRun(run.id);
}

// Runs whose occurrence turn ended while background work of the chat was running (subagents, dynamic workflows —
// runs/background.js), their ids per chat. The main agent never waits for a subagent: an occurrence that delegates ends
// with an interim text, and the report only arrives as a turn of its own (cause "agent"). So the run closes at the end
// of work — like target gate, compaction and "end" (runs/do-run.js), also when the work ends without a turn — with the
// response that processed the reports. In memory only: after a restart the subagents are orphaned, and
// scheduledAtStart closes the run "Server restarted".
const waitsForBackground = new Map();

// The run that the start of a turn took over, per chat (a chat has at most one turn, a turn at most one occurrence).
// In memory only: after a restart no turn is running any more, and a resume takes over its run anew.
const runInTurn = new Map();

/** The marker `scheduledRun` from a turn's inputs (see header) — `null` when none carries it. */
function runFromInputs(inputs) {
  const e = (Array.isArray(inputs) ? inputs : []).find((x) => Number.isInteger(x?.scheduledRun) && x.scheduledRun > 0);
  return e ? e.scheduledRun : null;
}

/**
 * The run of a turn in this chat (see header): that of its marker, otherwise the one taken over at the start, otherwise
 * the oldest open one not waiting in the queue. Only an OPEN run of THIS job — a marker whose run is already closed hits no other.
 */
function runOfTheTurns(chatId, inputs) {
  const a = store.jobOfTheChat(chatId);
  if (!a) return null;
  const matches = (l) => (l && l.status === "open" && l.jobId === a.id ? l : null);
  const id = runFromInputs(inputs);
  if (id) return matches(store.getScheduledRun(id));
  const takenOver = runInTurn.get(chatId);
  if (takenOver) { const l = matches(store.getScheduledRun(takenOver)); if (l) return l; }
  return store.openScheduledRuns(a.id).find((l) => !waitingInTheQueue(l)) || null;
}

// If a question card is open when the next occurrence BEGINS, it is done — without inventing an answer. The occurrence's
// row of role user has already closed it (runs/ask.js openAskOf), but its bell notice would stay open forever: every open
// `question` notice of this chat whose card is no longer open is resolved. A card the row does NOT close (running
// workflow) is closed by dismissAsk. A hint in the history when something happened.
function questionClose(chatId) {
  let closed = 0;
  if (openAskOf(chatId)) { dismissAsk(chatId, "scheduled"); closed += 1; }
  const open = openAskOf(chatId)?.requestId || null;
  const leftOver = new Set(getMonitorEvents(0)
    .filter((n) => n.kind === "question" && !n.resolved && n.chatId === chatId && n.requestId && n.requestId !== open)
    .map((n) => n.requestId));
  for (const requestId of leftOver) closed += resolveNotices({ id: chatId, requestId, kinds: ["question"] });
  if (closed) hint(chatId, T("The open question was closed — the next scheduled run begins."));
}

// turnStart/"scheduled": a turn with cause "schedule" in a job chat has passed the gate (runs/do-run.js behind turnBegins) —
// its run begins NOW: `startedAt` is the real start (a queued occurrence carried none until then, a directly delivered one
// the time of delivery), and an open question closes. A resume without a marker takes over its run without moving the
// start. On a resume retry the hook fires a second time for the same turn — then nothing changes.
export function scheduledTurnStart({ chat, cause, inputs }) {
  if (!chat?.id || cause !== "schedule") return;
  try {
    const run = runOfTheTurns(chat.id, inputs);
    if (!run || runInTurn.get(chat.id) === run.id) return;
    runInTurn.set(chat.id, run.id);
    if (runFromInputs(inputs)) store.updateScheduledRun(run.id, { startedAt: Date.now() });
    const a = store.getScheduledJob(run.jobId);
    if (a) report(a, store.getScheduledRun(run.id), "running");
    questionClose(chat.id);
  } catch (e) { console.error("[scheduled] run start:", e?.message || e); }
}

// beforeRunBroadcast/"scheduled-end": in the finally of doRun (and at the three ends in the gate, runs/limit-gate.js: stop,
// project lock, throw) — BEFORE the broadcast, so the list already sees the final state when refreshing. Responsible only
// for a turn with cause "schedule" in a job chat; a parked run has not ended (its takeover stays — the continuation
// carries no inputs and finds it again that way).
export function scheduledEndHook({ chat, error = "", resultText = "", parked = false, cause, aborted = false, inputs = [] }) {
  if (!chat?.id || cause !== "schedule" || parked) return;
  try {
    const run = runOfTheTurns(chat.id, inputs);
    runInTurn.delete(chat.id);
    if (!run) return;
    // The turn has ended, its work has not (see waitsForBackground): an error or abort closes immediately, otherwise "end".
    if (!error && !aborted && backgroundWork(chat.id).length) {
      waitsForBackground.set(chat.id, [...(waitsForBackground.get(chat.id) || []), run.id]);
      return;
    }
    endRun(run.id, { error, resultText, aborted: Boolean(aborted) });
  } catch (e) { console.error("[scheduled] run end:", e?.message || e); }
}

// end/"scheduled": the end of the chat's work (runs/do-run.js — after the turn after which nothing is open any more, or
// without a turn). A run whose occurrence turn ended with open background work closes now — with the last response (which
// processed the reports) and without repetition: the occurrence has already had its effect. A parked end keeps waiting
// (parked is like running — the end of the continuation comes back here).
export function scheduledWorkEnd({ chat, lastResponse = "", error = "", parked = false }) {
  const ids = chat?.id ? waitsForBackground.get(chat.id) : null;
  if (!ids?.length || parked) return;
  waitsForBackground.delete(chat.id);
  try {
    for (const id of ids) endRun(id, { error, resultText: lastResponse, repeatable: false });
  } catch (e) { console.error("[scheduled] run end (end of work):", e?.message || e); }
}

// afterLimitCancel/"scheduled-end": the wait row of the parked occurrence is dismissed. If the HUMAN dismissed it (`kind`
// "cancel": strip, steering, clearing the chat, aborted workflow), the run ends `aborted` — without a notification, they
// know. If the MACHINE gave up (attempt cap "gave-up", switch "off", situation "credits"/"too-long"), it ends `error` with
// the row's wording — with a notification (scheduled/notification.js) and without repetition (it would run into the
// same limit). Only a run row carries a run.
export function scheduledDismissedHook({ chat, row, note = "", kind = "cancel", reason = "" }) {
  if (!chat?.id || (row?.kind || "run") !== "run" || row?.payload?.cause !== "schedule") return;
  try {
    const run = runOfTheTurns(chat.id, []);
    runInTurn.delete(chat.id);
    if (!run) return;
    const text = reason || note || T("Continuation discarded");
    if (kind === "cancel") endRun(run.id, { error: text, aborted: true });
    else endRun(run.id, { error: text, repeatable: false });
  } catch (e) { console.error("[scheduled] run end (wait row dismissed):", e?.message || e); }
}

// restartGraceAbandoned/"scheduled": the resume of an occurrence after the restart is given up (runs/resume.js, after
// MAX_RESUME_ATTEMPTS) — no doRun runs there, so no finally. Without this end the run would stay open forever (DELETE
// 409), and the end of the next occurrence would close it instead of itself. `error` without repetition: the turn may
// already have had an effect.
export function scheduledAbandoned({ chat, cause }) {
  if (!chat?.id || cause !== "schedule") return;
  try {
    const run = runOfTheTurns(chat.id, []);
    runInTurn.delete(chat.id);
    if (run) endRun(run.id, { error: T("Resume after the restart given up"), repeatable: false });
  } catch (e) { console.error("[scheduled] run end (resume given up):", e?.message || e); }
}

// chatClosed/"scheduled": deleting the chat deletes its job with its runs (the reverse direction: deleting the job leaves
// the chat). The hook fires AFTER the chat row (chats/erase.js closeChats), the binding `chats.job_id` is gone by then —
// so every job without a chat is deleted (store/scheduled.js deleteOrphanedScheduledJobs).
export function scheduledChatClosed({ chatId }) {
  waitsForBackground.delete(chatId);
  try {
    for (const a of store.deleteOrphanedScheduledJobs()) {
      broadcast({ type: "scheduled", workspaceId: a.workspaceId, jobId: a.id, runId: null, chatId, status: "deleted" });
    }
  } catch (e) { console.error("[scheduled] chat closed:", e?.message || e); }
}

// inputDismissed/"scheduled": the human dismissed the queued occurrence — its run becomes `dismissed` (no error, no
// repetition, the job stays as it was). It is found in the same two ways as in waitingInTheQueue: by the id it
// remembered, or by the marker `scheduledRun` of the entry a gate created ANEW (whose id the run does not know).
export function scheduledInputDismissed({ chatId, entry }) {
  try {
    const a = entry?.id ? store.jobOfTheChat(chatId) : null;
    const run = a ? store.openScheduledRuns(a.id).find((l) => (l.entryId && l.entryId === entry.id) || (entry.scheduledRun && entry.scheduledRun === l.id)) : null;
    if (!run) return;
    store.updateScheduledRun(run.id, { status: "dismissed", endedAt: Date.now() });
    report(a, run, "dismissed");
  } catch (e) { console.error("[scheduled] entry dismissed:", e?.message || e); }
}
