// A chat's queue: queued messages (enqueueRunInput, cancelRunInput), delivery to the run (deliverUserPrompt,
// injectNextRunInput, takeNextRunInput), bundling from the head (headerBundle — stays `export function`, server.js
// re-exports it for the tests) and "steer" (controlActive, controlNow).
// No domain is imported here: the human involvement in the channels subscribes to the hook "beforeDeliver"
// (registered in server.js), and `waitForRunEnd` lives in runs/state.js.

import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { cancelAutoContinue } from "./auto-continue.js";
import { compacting, inputFitsIntoTheRun, pendingRunInputs, persistRunInputs, runChildren, runWaiting, runWaitPhaseYield, running, stopRun, waitForRunEnd, workflowDecides } from "./state.js";
import { injectionPreamble, withTurnPreamble, startRun } from "./do-run.js";
import { fireHooks } from "./hooks.js";
import { runOverruled } from "./limit-gate.js";
import { sse } from "../runtime/sse.js";
import { isCompletionNotice } from "./completionNotice.js";
import { isMessage } from "./message-marker.js";
import { announcementForm, humanFrom, inputOf, pickedUpInTurn, turnBegins } from "./human-input.js";
import { startLock, waitingInTheQueue } from "./project-lock.js";
import { turnInstanceDifferent } from "./instance.js";
import { onlyReadable, onlyReadableText } from "./only-readable.js";
import { managerLocked, managerLockText } from "./manager-lock.js";
import { staysInArchive } from "./archive.js";
import { bypassedCard, bypassedSet } from "./ask.js";
import { depositHint, hintFence, withHints } from "./hints.js";


// `controllable`: only what the USER queued may be taken along by "steer". An event or channel entry carries a
// different toolset (see deliverUserPrompt) and does not belong in a user turn — the UI counts its button by this
// field, otherwise "Steer (3)" would promise more than the server sends.
const publicPendingInputs = (chatId) => (pendingRunInputs.get(chatId) || []).map((x) => ({
  id: x.id,
  text: x.display || x.attachments?.map((a) => a.name).filter(Boolean).join(", ") || "",
  controllable: (x.cause || "user") === "user",
  ...(systemNotice(x) ? { systemNotice: true } : {}),
}));
// A subagent's completion notice (cause "agent") is stored under the role of a user message but is a SYSTEM NOTICE —
// the events to the clients say so explicitly (`systemNotice: true`), the stored row carries the marker at its start
// (runs/completionNotice.js). Likewise an agent's message (cause "message", form in runs/message-marker.js): not the
// human's input — the human cannot discard it (cancelRunInput 409), and the clients show it as a card, not a user
// bubble.
const systemNotice = (x) => (x?.cause || "user") === "agent" || x?.cause === "message" || isCompletionNotice(x?.display) || isMessage(x?.display);
// Server and clients recognise a row's kind by its START alone (completion notice, agent message). If the HUMAN types
// or pastes a text that begins like one, it would be a card instead of their bubble, not discardable in the queue
// (409) and not in the index — so an input with cause "user" gets a space in front at ONE place (deliverUserPrompt):
// "space in front" is no kind (bound in web/test/agents-message-binding.test.mjs).
const markerDisarmed = (s) => (isCompletionNotice(s) || isMessage(s) ? ` ${s}` : s);
// Is an entry held while a card for the human is open in the chat? The domain side knows the answer (which causes,
// which cards — channels/delivery.js, registered in server.js); runs/ does not import it (import guard), the same
// setter pattern as elsewhere. Unset holds nothing. Asked at the three places where a queued entry goes into a turn:
// injectNextRunInput (at the `result` and in the wait phase), takeNextRunInput (follow-up run) and injectEntry (tool
// boundary). A held entry stays in the queue; what lies behind it (the human's answer) passes it.
let inputHoldsSource = null;
export function setInputHolds(fn) { inputHoldsSource = typeof fn === "function" ? fn : null; }
function held(chatId, entry) {
  if (!inputHoldsSource) return false;
  try { return Boolean(inputHoldsSource(chatId, entry)); } catch (e) {
    console.error("[queue] hold check:", chatId, e?.message || e);
    return false;
  }
}
const freeEntries = (chatId, queue) => (queue || []).filter((e) => !held(chatId, e));
// If these inputs bypass an open question card (runs/ask.js bypassedCard), the agent learns it in THEIR turn — asked
// BEFORE the user rows are written. If the turn begins as a new run, doRun carries the silent hint; the handover into
// the running process (at the `result`, in the wait phase, at the tool boundary) reads no silent hints and gets the
// same fence directly in front of its input.
function cardsHintDeposit(chatId, entries) {
  const card = bypassedCard(chatId, entries);
  if (card) depositHint(chatId, bypassedSet(card), { source: "question" });
}
function cardsFence(chatId, entries) {
  const card = bypassedCard(chatId, entries);
  return card ? hintFence([{ source: "question", text: bypassedSet(card) }]) : "";
}
// Take a bundle's entries out of the queue — by identity, not from the head: a held entry may stand in front.
function bundleWithdraw(queue, block) {
  for (const e of block) {
    const i = queue.indexOf(e);
    if (i >= 0) queue.splice(i, 1);
  }
}
function emitPendingInputs(chatId) {
  sse(chatId, { type: "harness", subtype: "message_queue", queued: publicPendingInputs(chatId) });
}
function enqueueRunInput(chatId, entry) {
  const queue = pendingRunInputs.get(chatId) || [];
  queue.push(entry);
  pendingRunInputs.set(chatId, queue);
  persistRunInputs(chatId);
  emitPendingInputs(chatId);
  return queue.length;
}
// Hand a user contribution to a chat: if a turn is running it is queued (and injected at once in an open monitor wait
// phase); otherwise it starts a new run. ONE place for both paths, so the semantics do not drift apart.
// `cause`: where the turn comes from — "user" (default), "event", "schedule" (job run), "channel", "agent"
// (completion notice), "message".
// `silent`: the caller has already written the message into the history as a row of its own (channel card) — then NO
// user row and no user_message event is created, neither now nor at a later injection/takeover from the queue.
// `causeSpecified`: the cause as the CALLER named it — never filled in. The run goes on by `cause` (missing ⇒ "user");
// the turn's human input reads only the specified one (runs/human-input.js).
// `announcement`: the resolved mention "/workflow:<short name>" of this message — only `messageChatRoutes` may set it.
// It travels in the entry (and so in `run_inputs`) and in the turn's input; an invalid form is dropped, and an entry
// without one carries no field.
// `toolLimit`: the input may go INTO the running turn — with Claude at the next tool boundary, like the completion
// notice (cause "agent"); otherwise (Codex, loop engine) it stays queued and goes into the same process at the
// `result`. Only for the cause "message" and only where the caller says so — the message to the node agent of a graph
// run (workflows/graph-message.js). A message to an ordinary chat comes after its turn.
// `human`: accepted only with cause "schedule", otherwise silently ignored — the text a human wrote for this
// occurrence (occurrence message plus the job's instructions, scheduled/run.js). It travels in the entry and in the
// turn's input; runs/human-input.js reads it as "scheduled".
// `scheduledRun`: likewise only with cause "schedule" — the id of the job run this occurrence carries. Run start and
// run end (scheduled/run.js) assign the turn to its run through it instead of guessing "the oldest open one".
function deliverUserPrompt(chat, { prompt, display, attachments = null, cause: causeSpecified, silent = false, announcement = null, toolLimit = false, human = null, scheduledRun = null }) {
  // A read-only chat accepts nothing — no user row, no entry, no turn, no hook. The routes answer 409 beforehand
  // (chats/routes.js); the machine paths arrive here (channel, wake call, copy, …).
  if (onlyReadable(chat)) return { ok: false, queued: false, injected: false, onlyReadable: true, error: onlyReadableText() };
  // A manager chat likewise (runs/manager-lock.js) — with the same marker `onlyReadable` (the communication paths
  // answer 409 to it) and one of its own.
  if (managerLocked(chat)) return { ok: false, queued: false, injected: false, onlyReadable: true, managerLocked: true, error: managerLockText() };
  const cause = causeSpecified === undefined ? "user" : causeSpecified;
  const id = chat.id;
  // An agent (channel, message) does not bring a chat back from the archive — write nothing, queue nothing, no turn.
  // The deliveries stop earlier; this is the second safeguard at the shared place.
  if (staysInArchive(id, cause)) {
    return { ok: false, queued: false, injected: false, archived: true, error: T("The chat is archived — no agent brings it back.") };
  }
  // A SILENT agent message already has its row in the history — true only for the channel card (whose display is the
  // channel sentence). A silent entry whose display is the message itself would never appear: a programming error.
  if (silent && cause === "message" && isMessage(display)) {
    throw new Error("deliverUserPrompt: an agent message (cause \"message\") is silent only with a card of its own (channel) — its row in the history was missing here");
  }
  if (cause === "user") { prompt = markerDisarmed(prompt); display = markerDisarmed(display); }
  const checkedAnnouncement = announcementForm(announcement);
  // What the entry carries in addition: the checked announcement and, for an occurrence, the human text — each only if present.
  const withDetails = checkedAnnouncement ? { announcement: checkedAnnouncement } : {};
  if (cause === "schedule" && typeof human === "string" && human) withDetails.human = human;
  if (cause === "schedule" && Number.isInteger(scheduledRun) && scheduledRun > 0) withDetails.scheduledRun = scheduledRun;
  // Hook "beforeDeliver": the message is here, nothing is decided yet — for EVERY cause, at this place, synchronously
  // (no subscriber waits). Subscriber today: the human involvement in the channels (a user message in a participant
  // chat resets the cap counter of its channels). The condition `cause === "user"` is in the subscriber — it controls
  // nothing in runs/.
  fireHooks("beforeDeliver", { chat, cause });
  // During compaction there is nothing to inject into (no child process) — the message waits in the same queue and is
  // started as soon as the summary is done.
  if (compacting.has(id)) {
    const entry = { id: crypto.randomUUID(), prompt, display, attachments: attachments || [], cause, causeSpecified, silent, ...withDetails };
    const position = enqueueRunInput(id, entry);
    return { ok: true, queued: true, injected: false, position, compacting: true, queue: publicPendingInputs(id), entryId: entry.id };
  }
  // "Parked is like running": a chat with a run wait row (at the time limit or the credit gate) takes new input into
  // the queue, not into the row. The row is ONE per chat — otherwise every further cause (schedule, channel, wake
  // call, answer to a question) would replace the user's parked prompt, which would vanish without ever having run.
  // The second message waits behind the first and runs after it, bundled by the rules of headerBundle; the finally of
  // the continuation drains the queue. To get rid of the parked continuation there is "Cancel" on the strip (DELETE) —
  // which then starts the next entry itself (cancelAutoContinue).
  const parked = store.getPendingResume(id)?.kind === "run";
  // If this chat's graph workflow is deciding without a turn right now (final verdict, switch — state.js
  // workflowDecides), the chat is occupied as well: a turn now would be, for the gate afterwards, the result of the
  // NEXT step whose task never went out. The entry waits and goes with the run's next turn (at the `result`) — or as a
  // follow-up run if the driver decides on an end or a wait (auto-continue.js drainQueue). The answer is as for a
  // running turn: queued, without a field of its own.
  const decides = workflowDecides.has(id);
  if (running.has(id) || parked || decides) {
    const entry = { id: crypto.randomUUID(), prompt, display, attachments: attachments || [], cause, causeSpecified, silent, ...withDetails };
    const position = enqueueRunInput(id, entry);
    // An EVENT is not injected into a running turn: the running turn carries the toolset of its own cause, and an
    // event turn must never get that. It waits and becomes a follow-up run of its own. A channel message reaches a
    // Coding chat at the next turn transition like any user message — there is no toolset per cause there.
    // A PARKED chat has no process anything could be injected into (`running` is empty, `runWaiting` all the more):
    // then the entry waits, and the answer says `parked`.
    if (parked && !running.has(id)) {
      return { ok: true, queued: true, injected: false, parked: true, position, queue: publicPendingInputs(id), entryId: entry.id };
    }
    if (!running.has(id)) return { ok: true, queued: true, injected: false, position, queue: publicPendingInputs(id), entryId: entry.id };
    // An event never goes into the running turn; completion notice, channel and message do.
    const injectable = cause !== "event";
    // A completion notice does not wait for the wait phase: with Claude a message that goes to stdin mid-turn arrives
    // at the next tool boundary (it stands in the next model request behind the tool result, ONE result). Codex and the
    // loop engine reject an injection mid-turn — then it stays queued and goes at the result as a turn of its own
    // (injectNextRunInput; alone, headerBundle bundles only "user").
    const midTurn = cause === "agent" || (cause === "message" && toolLimit);
    if (midTurn && injectable && !runOverruled.has(id) && injectEntry(id, entry)) {
      return { ok: true, queued: false, injected: true, position: 0, queue: publicPendingInputs(id), entryId: null };
    }
    // injectNextRunInput reports the ids of the entries taken over. The question here is NOT whether anything went
    // over but whether THIS entry went along: it may lie behind an event that cuts the bundle — then the bundle runs
    // and it stays queued. A `true` here would report "delivered" to the client and leave the message in the queue.
    // A "start anyway" releases ONE turn — not the message that arrives during that turn. It waits for the run's
    // finally and then asks the gate itself.
    const takenOver = injectable && runWaiting.has(id) && !runOverruled.has(id) ? injectNextRunInput(id) : false;
    const injected = Array.isArray(takenOver) && takenOver.includes(entry.id);
    if (injected) sse(id, { type: "harness", subtype: "run_busy", monitors: [] });
    // Queued in the wait phase of a turn that runs in ANOTHER instance than the chat now carries (turnInstanceDifferent
    // — move into the copy, project switch): the wait phase of its process ends NOW, and the finally starts the queue
    // where the chat stands. Otherwise a wakeup or monitor would keep the old process open, and its continuations
    // would run as turns in the old instance after the switch.
    else if (runWaiting.has(id)) runWaitPhaseYield.get(id)?.();
    return { ok: true, queued: !injected, injected, position: injected ? 0 : position, queue: publicPendingInputs(id), entryId: injected ? null : entry.id };
  }
  // The lock per project: if the project's instance is working (relocation, start, recreation) or the server is
  // ending, the message waits in this chat's queue instead of beginning a turn — it stands there visibly ("queued"),
  // and the transition to ready starts it (projectbox idle wake). Its user row is created, as for every queued entry,
  // only at the start. The error state does NOT wait: the message goes into the run and doRun ends it visibly
  // (runs/limit-gate.js projectLockHolds). Without an instance row and ops marker the lock answers null and nothing
  // changes here. If the project's state is unreadable, no transition wakes the queue — then the message goes into the
  // run and doRun parks it in the wait row, which the sweeper checks.
  if (waitingInTheQueue(startLock(id, "turn"))) {
    const entry = { id: crypto.randomUUID(), prompt, display, attachments: attachments || [], cause, causeSpecified, silent, ...withDetails };
    const position = enqueueRunInput(id, entry);
    return { ok: true, queued: true, injected: false, locked: true, position, queue: publicPendingInputs(id), entryId: entry.id };
  }
  cardsHintDeposit(id, [{ silent, display }]);
  if (!silent) {
    store.addMessage(id, "user", display, Date.now(), attachments, cause);
    sse(id, { type: "harness", subtype: "user_message", text: display, attachments: attachments || [], ...(systemNotice({ cause, display }) ? { systemNotice: true } : {}) });
  }
  startRun(chat, prompt, { attachments, cause, inputs: [inputOf({ causeSpecified, display, ...withDetails })] });
  return { ok: true, queued: false, injected: false };
}
// Give ONE queue entry to the running process (only for the completion notice and tool-boundary inputs, see
// deliverUserPrompt) — the same rows and events as injectNextRunInput, but for exactly this entry, not the head.
function injectEntry(chatId, entry) {
  // A completion notice does not go into the process of another instance either — it stays queued (see above).
  if (turnInstanceDifferent(chatId)) return false;
  // An open card also holds the tool boundary (with Claude a message would otherwise go directly behind cbase_ask).
  if (held(chatId, entry)) return false;
  const child = runChildren.get(chatId);
  if (typeof child?.cbaseInject !== "function") return false;
  // Not typed by the human (completion notice, event, channel …) ⇒ marked as such for the CLI (providers/connectors/claude.js).
  const synthetic = humanFrom([inputOf(entry)]).length === 0;
  if (!child.cbaseInject(withHints(cardsFence(chatId, [entry]), entry.prompt), { synthetic })) return false;
  const queue = pendingRunInputs.get(chatId) || [];
  const i = queue.indexOf(entry);
  if (i >= 0) queue.splice(i, 1);
  if (!queue.length) pendingRunInputs.delete(chatId);
  persistRunInputs(chatId);
  const wasPresent = runWaiting.delete(chatId);
  // In the wait phase the pickup begins a new turn; mid-turn (tool boundary) it belongs to that turn.
  if (wasPresent) turnBegins(chatId, [inputOf(entry)]);
  else pickedUpInTurn(chatId, [inputOf(entry)]);
  if (!entry.silent) store.addMessage(chatId, "user", entry.display, Date.now(), entry.attachments, entry.cause);
  sse(chatId, {
    type: "harness", subtype: "message_injected", id: entry.id, text: entry.display, silent: entry.silent === true,
    attachments: entry.attachments || [], queued: publicPendingInputs(chatId), systemNotice: true,
  });
  if (wasPresent) sse(chatId, { type: "harness", subtype: "run_busy", monitors: [] });
  return true;
}
// Discard a queued entry. A SYSTEM NOTICE (a subagent's completion notice) is not the human's input: discarded, the
// main agent would never get the report — it stays and is delivered.
// Returns `{ status: 200, entry }`, `{ status: 404 }` (not there, e.g. already delivered) or `{ status: 409 }`.
function cancelRunInput(chatId, entryId) {
  const queue = pendingRunInputs.get(chatId) || [];
  const idx = queue.findIndex((x) => x.id === entryId);
  if (idx < 0) return { status: 404 };
  if (systemNotice(queue[idx])) return { status: 409 };
  const [removed] = queue.splice(idx, 1);
  if (queue.length) pendingRunInputs.set(chatId, queue);
  else pendingRunInputs.delete(chatId);
  persistRunInputs(chatId);
  emitPendingInputs(chatId);
  // Hook "inputDismissed": the human discarded an entry — the domain side closes what hung on it (the job run becomes
  // dismissed, scheduled/run.js). ONLY here: emptying a read-only chat never hits a job chat (runs/only-readable.js).
  fireHooks("inputDismissed", { chatId, entry: removed });
  return { status: 200, entry: removed };
}
// What belongs from the HEAD of the queue into ONE turn. Without bundling, three queued messages would become three
// turns with three answers although the user meant one task. The automatic drain and "steer" (see controlNow) have
// the same form: one row in the history per message, ONE prompt to the model, ONE run.
//
// Two rules, and both are conditions, not preferences:
//
//  1. ONLY `cause: "user"`. Event, schedule and channel each carry a toolset of their own (see deliverUserPrompt and
//     doRun) — bundled into a shared turn, one of them would get the other's tools. If such an entry is in front, it
//     goes alone.
//  2. ONLY CONTIGUOUS from the head. controlNow may filter the user entries out of the whole queue — that is an
//     explicit action of the user. The automatic drain must not reorder: if an event lay between two messages, the
//     bundle would pull the second one past it.
export function headerBundle(queue) {
  if (!queue?.length) return [];
  if ((queue[0].cause || "user") !== "user") return [queue[0]];
  let n = 1;
  while (n < queue.length && (queue[n].cause || "user") === "user") n += 1;
  return queue.slice(0, n);
}

// Take over the bundle from the head of the queue. The provider handles guarantee false as long as the current turn
// is not ready to accept input. A successful injection creates a clean user→assistant boundary in the live stream
// and in the persisted history.
//
// Returns `false` if nothing went over — otherwise the ids of the entries taken over: `deliverUserPrompt` must know
// whether ITS entry went along (it may lie behind an event and stay while the bundle in front runs). An empty array
// is never returned, so `if (injectNextRunInput(id))` stays valid.
function injectNextRunInput(chatId) {
  // A turn stays in the instance it began in. If the chat now stands in another one (the copy became ready or was
  // removed), the input does not go into its open process — it becomes the next turn (follow-up run) there.
  if (turnInstanceDifferent(chatId)) return false;
  const queue = pendingRunInputs.get(chatId);
  const child = runChildren.get(chatId);
  if (!queue?.length || typeof child?.cbaseInject !== "function") return false;
  // Held entries (open card) do not count as the head — they stay, the rest passes them.
  const block = headerBundle(freeEntries(chatId, queue));
  if (!block.length) return false;
  // If the running turn takes only inputs of its own cause (state.js, per-cause runs — today only the scheduled turn),
  // only a bundle of THE SAME cause goes into its process; everything else stays and becomes a follow-up run.
  if (!inputFitsIntoTheRun(chatId, block[0].cause)) return false;
  // ONE prompt for the whole bundle — the same pattern as controlNow. If a user turn begins with it, it carries that
  // turn's ultracode reminder; it is counted only once the handover succeeded.
  const inputs = block.map(inputOf);
  const preamble = injectionPreamble(chatId, inputs);
  const input = withTurnPreamble(block.map((e) => e.prompt).filter(Boolean).join("\n\n"), preamble?.text || "");
  // A bundle without any human input is marked as not typed (providers/connectors/claude.js); one human line keeps the bundle the user's.
  const synthetic = humanFrom(inputs).length === 0;
  if (!child.cbaseInject(withHints(cardsFence(chatId, block), input), { synthetic })) return false;
  preamble?.confirm();
  bundleWithdraw(queue, block);
  if (!queue.length) pendingRunInputs.delete(chatId);
  persistRunInputs(chatId);
  runWaiting.delete(chatId);
  // Taken over at the `result` or in the wait phase: the bundle is the entry of a NEW turn.
  turnBegins(chatId, inputs);
  // One event per entry: in `startInjectedTurn` the clients collapse an empty answer bubble before appending the user
  // row — N events in a row therefore give N user rows and EXACTLY ONE open answer. A collective event would have
  // changed the contract (three clients); this does not.
  for (const entry of block) {
    // `silent` MUST go along: the promise of deliverUserPrompt is "no user row and no user_message event, neither now
    // nor at a later injection". The if clause covers only the DB row — without the field the clients would turn this
    // event into a user bubble the server never stored.
    //
    // The event is NOT suppressed: besides the text it carries the new queue and the turn boundary at which the
    // clients close the previous answer bubble. With `silent` the clients leave out exactly the bubble (web
    // `startInjectedTurn`, iOS the same branch).
    if (!entry.silent) store.addMessage(chatId, "user", entry.display, Date.now(), entry.attachments, entry.cause);
    sse(chatId, {
      type: "harness",
      subtype: "message_injected",
      id: entry.id,
      text: entry.display,
      silent: entry.silent === true,
      attachments: entry.attachments || [],
      queued: publicPendingInputs(chatId),
      ...(systemNotice(entry) ? { systemNotice: true } : {}),
    });
  }
  return block.map((e) => e.id);
}
// If a provider ends/aborts before its next safe transition, messages already accepted must not be lost: they are
// taken over as a fresh follow-up run — ONE run for the whole head bundle (see headerBundle), not one per message.
//
// So what comes back is not a queue entry but the finished task: prompt, attachments, cause and inputs. This function
// writes the history rows itself — one per message; the separation is what one wants to see in the history.
function takeNextRunInput(chatId) {
  // The inherited queue of a read-only chat is discarded, not started — here, because EVERY drain (run end,
  // compaction, discarded wait row, restart, project wake) goes through this function. Asked only if something is
  // queued: an empty drain costs no read.
  if (pendingRunInputs.get(chatId)?.length && onlyReadable(store.getChat(chatId))) {
    pendingRunInputs.delete(chatId);
    persistRunInputs(chatId);
    emitPendingInputs(chatId);
    return null;
  }
  // The inherited queue of a manager chat does not start (runs/manager-lock.js) — and stays as it is (no row in
  // `run_inputs` changed).
  if (pendingRunInputs.get(chatId)?.length && managerLocked(store.getChat(chatId))) return null;
  const queue = pendingRunInputs.get(chatId);
  if (!queue?.length) return null;
  // A held entry (open card) does not become a follow-up run — it stays until the human has answered.
  const block = headerBundle(freeEntries(chatId, queue));
  if (!block.length) return null;
  bundleWithdraw(queue, block);
  if (!queue.length) pendingRunInputs.delete(chatId);
  persistRunInputs(chatId);
  cardsHintDeposit(chatId, block);
  for (const entry of block) {
    if (entry.silent) continue;
    store.addMessage(chatId, "user", entry.display, Date.now(), entry.attachments, entry.cause);
    sse(chatId, {
      type: "harness",
      subtype: "user_message",
      text: entry.display,
      attachments: entry.attachments || [],
      ...(systemNotice(entry) ? { systemNotice: true } : {}),
    });
  }
  emitPendingInputs(chatId);
  const attachments = block.flatMap((e) => e.attachments || []);
  return {
    prompt: block.map((e) => e.prompt).filter(Boolean).join("\n\n"),
    attachments: attachments.length ? attachments : null,
    // A bundle consists only of "user" entries; a single entry carries its own cause — in both cases the first
    // entry's cause is the right one.
    cause: block[0].cause || "user",
    // Per input its specified cause — the follow-up run carries them into its turn.
    inputs: block.map(inputOf),
  };
}

// Chats whose running turn is being aborted FOR steering right now. While the marker stands, the finally of doRun
// rescues no queue entry as a follow-up run of its own — it would run against the collective run that controlNow is
// about to start.
const controlActive = new Set();

// "Steer": abort the running turn and deliver all messages queued by the USER at once as ONE new run — one row in the
// history each, one run.
//
// The order is not arbitrary, every step stops a fault:
//  1. TAKE OUT BEFORE THE STOP. Otherwise the finally of doRun rescues the oldest entry as a follow-up run of its own
//     (takeNextRunInput) — the user would get a run with ONE message and then a second with the rest.
//  2. The marker `controlActive` also stops the same path for what STAYS: a channel entry would start a run there
//     while we are still waiting for the run end.
//  3. Only `cause: "user"` is taken along. Everything else carries a toolset of its own and stays in the queue — it is
//     injected into the new run as into any other.
//  4. Start only after the real run end. `stopRun` sends SIGTERM, `running` drops only in the run's finally; an
//     immediate doRun would be queued instead of started.
async function controlNow(chat) {
  const id = chat.id;
  // No steering DURING COMPACTION. No turn runs there (`running` is empty), so the clause below would fall through
  // and start a run NEXT TO the compaction — with the old session and the full history, exactly what is being paid to
  // get rid of. Besides, `compactChatContext` afterwards writes `claudeSessionId: null` into the middle of the running
  // turn. The messages already lie right: the finally of the compaction starts them itself, and then they see the
  // summary. The same order as in `deliverUserPrompt` — there `compacting` also comes BEFORE `running`.
  if (compacting.has(id)) return { ok: false, reason: "compacted" };
  // Likewise during a decision of the graph workflow without a turn (state.js workflowDecides): there is no turn to
  // abort, and a collective run now would run next to the step the driver is about to start. The messages go with its
  // turn (at the `result`) or as a follow-up run if the run ends or waits.
  if (!running.has(id) && workflowDecides.has(id)) return { ok: false, reason: "workflow" };
  const queue = pendingRunInputs.get(id) || [];
  const including = queue.filter((e) => (e.cause || "user") === "user");
  if (!including.length) return { ok: false, reason: "empty" };
  const rest = queue.filter((e) => (e.cause || "user") !== "user");
  if (rest.length) pendingRunInputs.set(id, rest);
  else pendingRunInputs.delete(id);
  persistRunInputs(id);
  emitPendingInputs(id);
  controlActive.add(id);
  try {
    if (running.has(id)) {
      stopRun(id);
      await waitForRunEnd(id);
      // waitForRunEnd returns SILENTLY after its deadline — a run whose end takes longer (a grandchild keeps stdout
      // open, an MCP call of the loop engine cannot be aborted) is then still in `running`. Starting the collective
      // run anyway would put a second doRun next to the old one, and the stop's abort marker would kill it at spawn —
      // the messages taken out would be lost. So ask again after waiting, and rather honestly do nothing: the messages
      // go back to the FRONT of the queue (they were meant to run first) and run after the old run's end as one
      // follow-up run (once `controlActive` drops below); likewise if a compaction or a workflow decision occupies the
      // chat in the meantime — then its end starts them.
      const taken = running.has(id) ? "running" : compacting.has(id) ? "compacted" : workflowDecides.has(id) ? "workflow" : "";
      if (taken) {
        pendingRunInputs.set(id, [...including, ...(pendingRunInputs.get(id) || [])]);
        persistRunInputs(id);
        emitPendingInputs(id);
        console.log(`[steer] ${id}: the run is not free yet after the stop (${taken}) — ${including.length} message(s) stay queued`);
        return { ok: false, reason: taken, queue: publicPendingInputs(id) };
      }
    } else if (store.getPendingResume(id)?.kind === "run") {
      // "Parked is like running" — also when steering: if the chat stands with a run wait row, the parked
      // continuation is what gets "aborted", like the running turn above. Explicitly, with a row in the history —
      // otherwise the collective run would start NEXT TO the row, and if it ran through, its end would silently clear
      // the foreign row: the task the chat was waiting for would be gone without a word. cancelAutoContinue also
      // closes a hanging schedule run and workflow; it does NOT start the next entry (`controlActive`), the collective
      // run starts that itself.
      cancelAutoContinue(id, { note: T(
        "Steered — the parked continuation was discarded; the queued messages run now.") });
    }
    // One user row per message: the separation is what one wants to see in the history. Only the prompt to the model
    // is joined into ONE text.
    cardsHintDeposit(id, including);
    for (const e of including) {
      if (e.silent) continue;
      store.addMessage(id, "user", e.display, Date.now(), e.attachments, e.cause);
      sse(id, { type: "harness", subtype: "user_message", text: e.display, attachments: e.attachments || [] });
    }
    const prompt = including.map((e) => e.prompt).filter(Boolean).join("\n\n");
    const attachments = including.flatMap((e) => e.attachments || []);
    const current = store.getChat(id) || chat;
    startRun(current, prompt, { attachments: attachments.length ? attachments : null, cause: "user", inputs: including.map(inputOf) });
  } finally {
    controlActive.delete(id);
  }
  return { ok: true, sent: including.length, queue: publicPendingInputs(id) };
}

export { cancelRunInput, deliverUserPrompt, emitPendingInputs, enqueueRunInput, freeEntries, injectNextRunInput, publicPendingInputs, controlActive, controlNow, takeNextRunInput };
