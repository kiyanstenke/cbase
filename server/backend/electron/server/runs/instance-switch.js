// Switching the instance of a chat. A chat's binding to an instance is stored in the chats table (NULL = main,
// otherwise `copy-<name>`), not on the copy. This file is the ONE way to change it, with everything that belongs to
// it — called by the PATCH/POST of a chat (chats/routes.js), by moving into and out of a copy (stacks/inset.js) and
// by the restart grace (a binding to a copy without a live row, stacks/inset.js).
//
// instanceChoice(projectId, value, { chatId, ofHuman }) → null (main) | "copy-<name>"   THROWS InstanceChoiceError (status, code)
//     With `chatId` (the switch of an EXISTING chat) first `instancePinned`: the child chat of a graph run ⇒ 409
//     INSTANCE_PINNED, whatever the value; then: a chat with a scheduled job without `ofHuman` ⇒ 409
//     JOB_ONLY_HUMAN (only the PATCH outside the fence is the human, see JOB_ONLY_HUMAN).
//     The check of a requested value (PATCH /api/chats/:id and POST /api/chats; the ABSENCE of the field is checked
//     by the caller — "a missing field is not a statement"). `null` and the main name mean main, in every project
//     (also without relocation: there every chat works "in the main" anyway). Everything else must be a LIVE
//     instance of THIS project: a copy whose row in stack_copies is ready and whose instance row is ready, starting
//     or stopped — otherwise 409 UNKNOWN_INSTANCE (also for a copy that is being built, cleared away or marked for
//     it: nobody moves into it any more). Only in a converted project (409 NOT_CONVERTED; without a project 409
//     NO_PROJECT). Not a string: 400 INSTANCE_INVALID.
//     A STOPPED instance row is live too (list LIVE_INSTANCE) — a chat may switch into it, its next turn starts it.
//     Read-only, without effect — the PATCH's check comes BEFORE the write.
// chatInstanceSet(chatId, instance, { separator = true, ofHuman = false }) → true if something changed
//     Sets the chat's instance; same ⇒ nothing; into a copy for a chat with a scheduled job without `ofHuman` ⇒
//     nothing. Otherwise, in the same synchronous step: (1) the separator in the history — a message of role
//     `hint` "This chat now works in copy-x" (Web and iOS show the role as a separator); (2) the event to the chat
//     (`harness`/`chat_settings` with `instance`) and to all (`chat_meta`) — the same ones header and list reload
//     settings with; (3) the mark on the running turn (runs/instance.js turnInstanceSwitched): a running turn stays
//     pinned — a queued input no longer goes into its open process (turnInstanceDifferent), it becomes the next
//     turn, and that begins in the new instance; its silent hint says where the previous one ran. The CLI session
//     moves along at the next turn via runs/session-location.js sessionForStart (the CLI home belongs to the
//     project, not the instance; only the slug of the working folder changes).
// instanceSeparatorText(instance)   the separator's wording (for tests and the project switch).
// instanceSwitchWakeText(instance)  the wake call after cbase_switch_instance — in the form of a system notice
//     (runs/completionNotice.js FINISHED_MARKER, like the move-in wake call stacks/inset.js moveInWakeText). The
//     route (chats/routes.js) delivers it with cause "event" — never into the running turn; the running turn stays
//     pinned, the wake call becomes the next turn and begins in the new instance.
// instanceAfterProjectSwitch(chatId, prior)   the PATCH of a project set the chat's instance to NULL in the same
//     UPDATE (store/chats.js updateChat) — if a copy stood there before, the separator "… in main" follows (the mark
//     on the turn is set by the project switch itself, turnProjectSwitched).
//
// A leaf of the hub: store, language switch, events, runs/instance.js — no domain (runs/ is free of domains; this
// file knows the copy only as rows of the store).
import * as store from "../store.js";
import { T } from "../i18n.js";
import { broadcast, sse } from "../runtime/sse.js";
import { turnInstanceSwitched } from "./instance.js";
import { FINISHED_MARKER } from "./completionNotice.js";

const MAIN = "main";
const COPY = "copy-";
// The states of an instance row a chat may switch into — including stopped (the next turn starts it).
export const LIVE_INSTANCE = Object.freeze(["ready", "start", "stopped"]);

export class InstanceChoiceError extends Error {
  constructor(message, { code, status = 409 } = {}) {
    super(message);
    this.name = "InstanceChoiceError";
    this.code = code;
    this.status = status;
  }
}

const normal = (instance) => (instance && instance !== MAIN ? String(instance) : null);

/**
 * The child chat of a graph run is pinned to the instance in which its run began — runs/instance.js asks the source
 * "child" for it and NEVER the chat's own column. Accepting a switch anyway would answer "changed", write the
 * separator and a wake call while the turn kept running in the old instance (description and execution would give
 * different answers). So the check THROWS 409 INSTANCE_PINNED before anything is written — also for main (a child
 * never switches). A new chat (POST /api/chats, channel) is never a child: nobody asks there.
 */
export function instancePinned(chatId) {
  const z = chatId ? store.graphStartOfChild(String(chatId)) : null;
  if (!z) return;
  const identifier = String(z.instance || "");
  const where = identifier ? identifier.slice(identifier.lastIndexOf("/") + 1) : MAIN;
  throw new InstanceChoiceError(T`This chat is the child chat of a graph run and works fixed in ${where}, where its run began — its instance does not change.`, { code: "INSTANCE_PINNED" });
}

/** The separator's wording (see header). */
export function instanceSeparatorText(instance) {
  const name = normal(instance) || MAIN;
  return T`This chat now works in ${name}.`;
}

const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The wake call after cbase_switch_instance (see header). Only the instance's name. */
export function instanceSwitchWakeText(instance) {
  const name = normal(instance) || MAIN;
  const note = name === MAIN
    ? "This is a system notice, not a user reply. From this turn on everything you start NEW (CLI, file tools, subagents, terminal, browser, services) runs in the main of the project; what ran in the copy before stays there until it ends."
    : `This is a system notice, not a user reply. From this turn on everything you start NEW (CLI, file tools, subagents, terminal, browser, services) runs in ${name}; what ran before stays in its instance until it ends. Fetching works with cbase_copy_stack_fetch, going back to the main with cbase_switch_instance.`;
  return [FINISHED_MARKER, `<task-id>${xml(name)}</task-id>`, `<summary>${xml(`This chat now works in ${name}`)}</summary>`,
    `<result>${xml(instanceSeparatorText(name))}</result>`, `<note>${xml(note)}</note>`, "</task-notification>"].join("\n");
}

/**
 * Project and instance of a job chat (a chat that carries a scheduled job) are changed only by the HUMAN — the run
 * values live on the chat, a switch by an agent would move every later occurrence there. The tools answer with this
 * sentence themselves beforehand (mcp/lib.js JOB_SENTENCE, same wording; server/backend/test/scheduled-run.test.js
 * holds both); here sits the server-side lock for every other way: the tool's route (the human never speaks there),
 * a PATCH from a project network (a human never comes through the fence) and moving into a copy (stacks/inset.js
 * via chatInstanceSet). → 409 JOB_ONLY_HUMAN.
 */
export const JOB_ONLY_HUMAN = "Project and instance of a scheduled job are changed only by the user under Coding → Scheduled";
const carriesJob = (chatId) => Boolean(chatId && store.getChat(String(chatId))?.jobId);

/** The check of a requested value (see header). `ofHuman`: only the PATCH from the UI (see above) — default no. */
export function instanceChoice(projectId, value, { chatId = null, ofHuman = false } = {}) {
  if (chatId) instancePinned(chatId);
  if (!ofHuman && carriesJob(chatId)) throw new InstanceChoiceError(JOB_ONLY_HUMAN, { code: "JOB_ONLY_HUMAN" });
  if (value === null || value === MAIN) return null;
  if (typeof value !== "string") {
    throw new InstanceChoiceError(T("`instance` is a string (\"main\" or \"copy-<name>\") or null."), { code: "INSTANCE_INVALID", status: 400 });
  }
  if (!projectId) {
    throw new InstanceChoiceError(T("A chat without a project only works in main."), { code: "NO_PROJECT" });
  }
  const pid = String(projectId);
  if (!store.converted(pid)) {
    throw new InstanceChoiceError(T`Project ${pid} does not run in its container — instances only exist after the move.`, { code: "NOT_CONVERTED" });
  }
  const unknown = (why) => new InstanceChoiceError(T`"${value}" is not a live instance of project ${pid}${why ? ` (${why})` : ""}.`, { code: "UNKNOWN_INSTANCE" });
  if (!value.startsWith(COPY)) throw unknown("");
  const copy = store.liveStackCopy(pid, value.slice(COPY.length));
  if (!copy) throw unknown("");
  if (copy.state !== "ready") throw unknown(copy.state === "clearAway" ? T("it is being cleared away") : copy.state);
  const row = store.projectInstance(pid, value);
  if (!row || !LIVE_INSTANCE.includes(row.state)) throw unknown(row ? T`instance ${row.state}` : T("without an instance row"));
  return value;
}

/**
 * Sets the chat's instance with separator, event and turn mark (see header). A job chat moves into a COPY only with
 * `ofHuman` (the PATCH from the UI, checked in instanceChoice) — moving in (stacks/inset.js) then changes nothing.
 * Back to main always works: that is moving out when the copy goes (stacks/inset.js), not an agent's switch.
 */
export function chatInstanceSet(chatId, instance, { separator = true, ofHuman = false } = {}) {
  const chat = chatId ? store.getChat(String(chatId)) : null;
  if (!chat) return false;
  const fresh = normal(instance);
  if ((chat.instance || null) === fresh) return false;
  if (fresh && chat.jobId && !ofHuman) {
    console.log(`[instance] chat ${chat.id}: carries a scheduled job — no switch to ${fresh} (only the human)`);
    return false;
  }
  store.updateChat(chat.id, { instance: fresh });
  if (separator) store.addMessage(chat.id, "hint", instanceSeparatorText(fresh));
  sse(chat.id, { type: "harness", subtype: "chat_settings", instance: fresh });
  broadcast({ type: "chat_meta", chatId: chat.id });
  turnInstanceSwitched(chat.id);
  return true;
}

/** After a project switch that set a copy binding to NULL — the separator (see header). */
export function instanceAfterProjectSwitch(chatId, prior) {
  if (!normal(prior) || !chatId) return false;
  try {
    store.addMessage(String(chatId), "hint", instanceSeparatorText(null));
    sse(String(chatId), { type: "harness", subtype: "chat_settings", instance: null });
  } catch (e) { console.error(`[instance] chat ${chatId}: separator after the project switch:`, e?.message || e); }
  return true;
}
