// A turn's human input — ONE reading. Several rules ask the same thing: what did the human type in THIS turn? The
// keyword "ultracode", the budget "+500k" and the count of user turns for the ultracode reminder (via `humanFrom`).
// They all read here, never the assembled prompt.
//
// WHAT A TURN IS: from the input that triggers the model up to its `result`. A run (doRun) can carry several turns —
// whatever is injected into the same process at the `result` or in the wait phase (the queue's head bundle, a
// monitor event, an agent report, a wakeup) BEGINS a new turn (`turnBegins`). What is picked up IN THE MIDDLE of a
// turn (with Claude at the next tool boundary, runs/queue.js injectEntry) belongs to the running turn, from its
// pickup on (`pickedUpInTurn`).
//
// WHAT COUNTS AS HUMAN: only the cause "user", and only as the CALLER stated it (allowlist HUMAN_CAUSES). A queue
// entry carries `causeSpecified` next to `cause` for this: `cause` is the value the run goes by (missing ⇒ "user",
// and doRun also turns an unknown one into "user"), `causeSpecified` the one the caller of deliverUserPrompt named
// explicitly — never filled in. If it is missing, the input is NOT human (empty is not unknown); likewise channel,
// schedule, event, "agent" (completion notice), "message" (an agent's message, runs/message-marker.js; guard
// communication-graph.test.js) and any invented cause. A run that starts without inputs (graph step, target continuation,
// restart, continuation of a wait row) has no human input.
//
// A TURN'S IDENTIFIER: every `turnBegins` assigns a new identifier, unique within this server run
// (`turnIdentifier`) — the budget "+500k" belongs to the turn that carries it and counts the main run's output ONLY
// in this turn (runs/turn-output.js). A pickup in the middle of the turn keeps the identifier; `turnPast` removes it.
//
// THE ANNOUNCEMENT: besides cause and text an input can carry an `announcement` — the mention
// "/workflow:<shortName>" in a message, resolved to `{ id, workflows: [{ workflowId, shortName, name }],
// attachments }`. It travels with the input through queue (also `run_inputs`), head bundle, injection, follow-up
// run, steer and restart (stored on `active_runs`), and the running turn reads it via `announcementsInTurn`. It may
// be SET by the message route (`messageChatRoutes`) and by an occurrence of a scheduled job (scheduled/run.js, see
// below) — no client body, no channel. An invalid form is silently dropped here (`announcementForm`), the input
// stays; an entry WITHOUT an announcement carries no field either (the golden anchors of `run_inputs` stay the same).
//
// THE SCHEDULED RUN: an occurrence of a scheduled job arrives with cause "schedule" and explicitly carries `human` —
// the occurrence message with the instructions the human WROTE when creating it. Only then does `inputOf` read it as
// `{ cause: "scheduled", text: human }`, and "scheduled" counts as human (ultracode, budget, opt-in, auto title). A
// "schedule" WITHOUT `human` is not human. `human` is set only by scheduled/run.js via runs/queue.js
// deliverUserPrompt, which accepts it only for cause "schedule". The announcement of an occurrence (`/workflow:` in
// the instructions) is set by scheduled/run.js — the SECOND named setter next to `messageChatRoutes`; it too comes
// from what the human wrote.
// An occurrence's input also carries `scheduledRun` (the id of its run) — only in the input that `inputOf` returns
// (run start and run end read it, runs/do-run.js "turnStart"/"beforeRunBroadcast"); the turn's list (`turnBegins`)
// keeps its form.
//
// Leaf without imports — free of domains like the hub (import-direction.test.js).

const HUMAN_CAUSES = new Set(["user", "scheduled"]);

// chatId → [{ cause, text, announcement? }] of the running turn. Set once a run is past the gate; removed in the
// run's finally (set again by the recursive call on a resume retry).
const turnInputs = new Map();
// chatId → identifier of the running turn. With a random part per server run: after a restart the count starts
// over, and an old identifier must not hit a new one.
const turnIdentifiers = new Map();
const SERVER_RUN = Math.random().toString(36).slice(2, 8);
let nextTurn = 1;

// The caps of the announcement form: id at most 64 characters, 1–20 workflows, at most 50 attachments (absolute paths).
const ANNOUNCEMENT_ID_MAX = 64;
const ANNOUNCEMENT_WORKFLOWS_MAX = 20;
const ANNOUNCEMENT_ATTACHMENTS_MAX = 50;
const isText = (x) => typeof x === "string";

// The announcement in its form — a fresh copy of the known fields only, or `null` if the form is wrong (missing or
// too long id, no or more than 20 workflows, a workflow without id or short name, an attachment that is not an
// absolute path, more than 50 attachments). A missing `attachments` is the empty list. Nothing is truncated: an
// announcement is whole or not at all — half of one would start other workflows than the message named.
function announcementForm(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  if (!isText(a.id) || !a.id || a.id.length > ANNOUNCEMENT_ID_MAX) return null;
  if (!Array.isArray(a.workflows) || a.workflows.length < 1 || a.workflows.length > ANNOUNCEMENT_WORKFLOWS_MAX) return null;
  const workflows = [];
  for (const w of a.workflows) {
    if (!w || typeof w !== "object") return null;
    if (!isText(w.workflowId) || !w.workflowId || !isText(w.shortName) || !w.shortName || !isText(w.name)) return null;
    workflows.push({ workflowId: w.workflowId, shortName: w.shortName, name: w.name });
  }
  const raw = a.attachments === undefined ? [] : a.attachments;
  if (!Array.isArray(raw) || raw.length > ANNOUNCEMENT_ATTACHMENTS_MAX) return null;
  if (!raw.every((p) => isText(p) && p.startsWith("/"))) return null;
  return { id: a.id, workflows, attachments: [...raw] };
}

// `{ cause, text }`, plus `announcement` ONLY if a valid one came along — a field `announcement: null` would
// otherwise sit in every saved entry and every anchor.
const inputForm = (e) => {
  const form = {
    cause: typeof e?.cause === "string" ? e.cause : null,
    text: typeof e?.text === "string" ? e.text : "",
  };
  const announcement = announcementForm(e?.announcement);
  if (announcement) form.announcement = announcement;
  return form;
};

// The input of a queue entry (or of a direct delivery of the same form): the STATED cause, the text the history
// shows (`display` — what the human typed; the prompt carries attachments, slash resolution, instructions), and the
// entry's announcement.
function inputOf(entry) {
  if (entry?.causeSpecified === "schedule" && typeof entry.human === "string" && entry.human) {
    const form = inputForm({ cause: "scheduled", text: entry.human, announcement: entry.announcement });
    return Number.isInteger(entry.scheduledRun) && entry.scheduledRun > 0 ? { ...form, scheduledRun: entry.scheduledRun } : form;
  }
  return inputForm({ cause: entry?.causeSpecified, text: String(entry?.display ?? ""), announcement: entry?.announcement });
}

function turnBegins(chatId, inputs = []) {
  turnInputs.set(chatId, (Array.isArray(inputs) ? inputs : []).map(inputForm));
  turnIdentifiers.set(chatId, `t${SERVER_RUN}-${nextTurn++}`);
}

function pickedUpInTurn(chatId, inputs = []) {
  const list = turnInputs.get(chatId);
  if (!list) return;
  for (const e of inputs) list.push(inputForm(e));
}

function turnPast(chatId) {
  turnInputs.delete(chatId);
  turnIdentifiers.delete(chatId);
}

/** The identifier of the running turn — `null` if none is running. */
function turnIdentifier(chatId) {
  return turnIdentifiers.get(chatId) ?? null;
}

// THE reading: the texts a human typed into the running turn, in order of arrival. `null` means "no turn is
// running" (unknown), `[]` means "a turn is running, without human input".
function humanInput(chatId) {
  const list = turnInputs.get(chatId);
  if (!list) return null;
  return humanFrom(list);
}

// THE SAME reading for the inputs of a turn that is just BEGINNING: the ultracode reminder belongs in the prompt
// before the turn is registered — at the queue's handover (queue.js injectNextRunInput) it is only certain after a
// successful handover that it begins. Inputs in the form of `inputOf`/`turnBegins`.
function humanFrom(inputs) {
  return (Array.isArray(inputs) ? inputs : []).map(inputForm).filter((e) => HUMAN_CAUSES.has(e.cause)).map((e) => e.text);
}

// A turn that ONLY machines triggered (used by the auto title, runs/post-run.js autoTitleHook): it runs, carries
// inputs, and EVERY one explicitly names a non-human cause (wake call, completion notice, monitor, wakeup, channel,
// schedule …). A turn without inputs (doRun directly — an app agent, a graph step) or with an input without a stated
// cause is NOT "without human" — there it is unknown, and the usual rules apply (empty is not unknown).
function turnWithoutHuman(chatId) {
  const list = turnInputs.get(chatId);
  if (!list?.length) return false;
  return list.every((e) => typeof e.cause === "string" && e.cause && !HUMAN_CAUSES.has(e.cause));
}

// The announcements of an input list — EVERY cause, not just "user": the restart carries them under its own cause
// (runs/resume.js), and who may set an announcement is the route's business, not this reading's. Once per id, in
// order of arrival (the first wins). Stored on `active_runs` (do-run.js).
function announcementsFrom(inputs) {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(inputs) ? inputs : []) {
    const a = inputForm(e).announcement;
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

// The announcements of the running turn — `null` means "no turn is running", `[]` "a turn is running, without an
// announcement". A pickup in the middle of the turn belongs to it (pickedUpInTurn), a new turn begins without those
// of the previous one.
function announcementsInTurn(chatId) {
  const list = turnInputs.get(chatId);
  if (!list) return null;
  return announcementsFrom(list);
}

export { HUMAN_CAUSES, announcementForm, announcementsFrom, announcementsInTurn, inputOf, pickedUpInTurn, humanFrom, humanInput, turnBegins, turnIdentifier, turnWithoutHuman, turnPast };
