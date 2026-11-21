// ── Notifications: which kind goes to the phone when ──────────────
// ONE source for the vocabulary. The gateway pushes by it, and the settings and the chat menu read it.
//
// Two levels, on purpose:
//   global per kind   — the default, applies everywhere (app_settings, key `push.<kind>`)
//   per chat per kind — three-valued: if the entry is missing, the global default applies
// A two-valued checkbox on the chat would not work: with default "off" a fresh chat would stay silent even on a question,
// with default "on" the wish "off by default" would be violated.
import { T } from "./i18n.js";

export const ON = "on";
export const OFF = "off";
export const STANDARD = "standard";

// `chat: true` means: a per-chat toggle hangs on this kind. The others have no chat it could hang on (a service outage
// belongs to a project, a suggestion to the workspace).
export const KINDS = [
  { key: "question", chat: true, preset: true },
  // Approval: an agent wants to run a tool that needs an approval, and waits (the card of the coding MCP airlock and of the
  // scheduled turn).
  { key: "approval", chat: true, preset: true },
  { key: "review", chat: true, preset: true },
  { key: "finished", chat: true, preset: false },
  { key: "workflow", chat: true, preset: false },
  { key: "trigger", chat: true, preset: false },
  // Usage limit: the run was parked OR continues after the reset. The same kind reports both — whoever wants to know about the
  // parking also wants to know when it went on, and two toggles for the two halves of the same event would be one control too many.
  // Default on: with a weekly window there are days between the two messages.
  { key: "limit", chat: true, preset: true },
  { key: "schedule", chat: false, preset: true },
  { key: "service", chat: false, preset: true },
  { key: "info", chat: false, preset: false },
];

// Which toggles an ordinary chat offers.
export const CHAT_KINDS = KINDS.filter((a) => a.chat).map((a) => a.key);
// And which a SCHEDULE offers: in a scheduled run only two things can happen — it asks a question, or it is finished (that
// is the kind `schedule`, not `finished`: "finished" stays suppressed at run end so that two notifications do not report the
// same thing). Toggles for review/workflow/trigger would be dead controls here.
export const SCHEDULE_KINDS = ["schedule", "question", "approval"];
const BY_KEY = new Map(KINDS.map((a) => [a.key, a]));

// The label appears on the lock screen as a subtitle — so it must be understandable on its own ("Review" stays English in
// German too: that is what the node is called in the workflow editor).
export function kindLabel(kind) {
  switch (kind) {
    case "question": return T("Question");
    case "approval": return T("Approval");
    case "review": return T("Review");
    case "finished": return T("Answer ready");
    case "workflow": return T("Workflow step");
    case "trigger": return T("Workflow triggered");
    case "limit": return T("Usage limit");
    case "schedule": return T("Schedule");
    case "service": return T("Service");
    default: return T("Notice");
  }
}

export function kindHint(kind) {
  switch (kind) {
    case "question": return T("A run needs your answer and is paused until it arrives.");
    case "approval": return T("An agent wants to run a tool that needs your approval — the run is waiting.");
    case "review": return T("A review node is waiting for your verdict.");
    case "finished": return T("A run finished and produced an answer.");
    case "workflow": return T("A workflow reached a step you ticked for notification.");
    case "trigger": return T("A workflow was triggered from outside (e.g. GitLab).");
    case "limit": return T("A run is waiting for a usage limit to reset — and reports back when it continues.");
    case "schedule": return T("A scheduled run finished or failed.");
    case "service": return T("A service went down or came back up.");
    default: return T("Captures and other notices.");
  }
}

// Bell kind → push kind. Only two differ: the bell distinguishes `down`/`up` (two symbols), for the phone both are
// "service"; and `question` is called that there.
export function kindOfKind(kind) {
  switch (kind) {
    case "question": return "question";
    case "down": case "up": return "service";
    default: return BY_KEY.has(kind) ? kind : "info";
  }
}

export const isKind = (kind) => BY_KEY.has(kind);
export const defaultOf = (kind) => BY_KEY.get(kind)?.preset ?? false;
export const isChatKind = (kind) => BY_KEY.get(kind)?.chat === true;

// A chat choice is valid only if it sets a CHAT kind to one of the two real values. `standard` is not stored but is the
// absence of an entry — otherwise there would be two spellings for the same state, and the marker on the chat row would have to
// know both.
export function normalizeChoice(raw, allowed = CHAT_KINDS) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [kind, value] of Object.entries(raw)) {
    if (!allowed.includes(kind)) continue;
    if (value === ON || value === OFF) out[kind] = value;
  }
  return out;
}

// The global defaults from the stored settings (`push.<kind>` = "1" | "0").
export function globalDefaults(getSetting) {
  const out = {};
  for (const a of KINDS) {
    const raw = getSetting(`push.${a.key}`, "");
    out[a.key] = raw === "" ? a.preset : raw === "1";
  }
  return out;
}

/**
 * The one decision. `choice` is the (normalized) choice of the chat or the schedule, `global` the result of globalDefaults().
 * An unknown kind does not get through — otherwise a future notice type would push along unasked, just because nobody thought
 * of this place.
 *
 * The choice applies to EVERY kind a chat hangs on — not only the ones from CHAT_KINDS. The run chat of a schedule inherits
 * `schedule`, and without this rule its inherited choice would lead nowhere while the surface displays it. `isChatKind` says
 * only WHICH toggles an ordinary chat offers — not which take effect.
 */
export function pushAllowed(kind, choice, global) {
  if (!isKind(kind)) return false;
  const own = choice?.[kind];
  if (own === ON) return true;
  if (own === OFF) return false;
  return global?.[kind] ?? defaultOf(kind);
}

// What shows in the chat list that a chat deviates from the default. "Off" wins in a mixed state: silence is the state that
// surprises — "why did nothing come here" is the question the marker must answer.
export function chatMarker(choice, allowed = CHAT_KINDS) {
  const values = Object.values(normalizeChoice(choice, allowed));
  if (values.includes(OFF)) return "silent";
  if (values.includes(ON)) return "loud";
  return "";
}
