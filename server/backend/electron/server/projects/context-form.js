// The FORM of a context entry, checked on writing. The SERVER says it in-band, in the response of the write — like `similar`
// on create: a response steers the model more strongly than any rule in a prompt or tool description, and it reaches every
// run that writes (subagents and workflow agents do not get the system prompt block).
//
// The check is a HINT, not a lock: the entry is written, the response lists `formHints` (one short, actionable sentence
// each). It is locked (`rejection`) only if the caller demands it (`lock` — the routes set it only for the marker `ofAgent`,
// which only the MCP tools send; a human in web or iOS never gets a 400 for length) AND the body exceeds CONTEXT_BODY_LIMIT
// characters — on change only if it grew compared to the stored one: an old, long entry stays editable. The length hint is
// ALWAYS there, also above the limit (the hint-only paths — drops, human — would otherwise say nothing).
//
// Runtime: the patterns run over the whole text, so NO unbounded quantifier except `[^\n]*` directly before `$` (guard
// context-form.test.js; polynomial patterns once blocked the backend for seconds on long whitespace), at most
// CONTEXT_CHECK_TEXT_CAP characters are checked per field, and a lock returns at once.
//
// The patterns exist ONCE here; readers: projects/routes.js (POST/PUT /api/projects/:id/context), projects/context.js
// (dumpIntoProject: create and merge), workspaces/routes.js (workspace context POST and PUT). Guard with false-positive
// counter-checks: server/backend/test/context-form.test.js.
//
// A leaf that imports only `i18n.js` (the text of the lock goes through `T`). The hints are English like all texts to models.
import { T } from "../i18n.js";

export const CONTEXT_BODY_HINT = 2000;
export const CONTEXT_BODY_LIMIT = 6000;
// The patterns check at most this many characters per field — the length itself is reported by the length hint.
export const CONTEXT_CHECK_TEXT_CAP = 20000;

// Branch name as PLACE OF ORIGIN: only after "Branch", "Zweig", "auf" or "im" (optionally with colon, bold, backtick or
// quotes) — "behoben, Branch `fix/…`", "lief auf `fix/…`"; the German words stay because entries are written in German too. A
// branch that is itself the subject of the knowledge ("trunk is `feat/…`", a comparison of two branches in a table) carries
// none of these words before it and is no finding. The prefix word lowercase, as branches carry it.
const BRANCH = /\b(?:[Bb]ranch(?:es)?|[Zz]weig|auf|im)[*:]{0,3}[ \t]{1,3}[`„"'(]?((?:feature|feat|fix|bugfix|hotfix|chore|wip|release)\/[\w.\-/]{0,120}\w)/;
// Commit hash ONLY in a commit context (a word before it), 7–40 hex with at least one digit AND one letter, not part of a UUID
// or a longer identifier — a UUID, a color value (#1a2b3c4d), a checksum without a commit word, a sha256 (64 characters) and
// a date ("Stand 20261010") are no finding.
const COMMIT = /\b(?:commits?|sha|hash|rev(?:ision)?|stand|head)\b[\s:=`„"'(@]{0,4}(?=[0-9a-f]{0,39}\d)(?=[0-9a-f]{0,39}[a-f])([0-9a-f]{7,40})(?![\w-])/i;
// Issue/MR number in the TITLE: "#12", "!34" (GitLab MR), "Issue 12", "MR !34", "Ticket #5", "PR 7".
const NUMBER_IN_TITLE = /(?:^|[\s(\/[])([#!]\d{1,6})\b|\b((?:issue|mr|merge[- ]request|ticket|pr)[ \t]{0,3}[#!]?\d{1,6})\b/i;
// Status section: a heading that AS A WHOLE is a status word (German or English; optionally with date, colon or parenthesis
// after it) — "Stand der Technik" or "Status-Codes der API" are none. Read from the heading text (no line break, trimmed).
// German terms here match German user input on purpose (the UI is bilingual) - an intended exception to the English-only rule.
const STATUS_WORD = /^(?:status|stand|aktueller stand|fortschritt|erledigt|done|nächste schritte|next steps|offen|offene punkte|offene fragen|todo|to-do|verlauf|historie|changelog|was fehlt|ausstehend|noch zu tun)(?:[ \t]{0,3}[:(–]|[ \t]{1,3}\d|$)/i;
// An ATX heading: up to three spaces, 1–6 "#", ONE whitespace, the rest of the line (trimmed and without closing "#" in JS —
// `headingText`, not a pattern with two quantifiers over the same whitespace).
const HEADING = /^ {0,3}#{1,6}[ \t]([^\n]*)$/gm;
const CHECKBOX = /^[ \t]{0,40}[-*+][ \t]{1,4}\[[ xX]\](?:[ \t]|$)/m;

// For the guard (context-form.test.js): every pattern of this file, under its name.
export const CONTEXT_FORM_PATTERN = { BRANCH, COMMIT, NUMBER_IN_TITLE, STATUS_WORD, HEADING, CHECKBOX };

const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
const capped = (s) => (s !== null && s.length > CONTEXT_CHECK_TEXT_CAP ? s.slice(0, CONTEXT_CHECK_TEXT_CAP) : s);

// The text of a heading: trimmed, without a closing "#" sequence (CommonMark: after whitespace or as the whole content).
function headingText(raw) {
  const s = raw.trimEnd();
  let h = s.length;
  while (h > 0 && s[h - 1] === "#") h--;
  const without = h === s.length || h === 0 || s[h - 1] === " " || s[h - 1] === "\t" ? s.slice(0, h) : s;
  return without.trim();
}

/**
 * Checks the written fields of a context entry.
 * @param {{ title?: unknown, summary?: unknown, body?: unknown, category?: unknown }} fields  only what THIS call writes
 *   (`category` the effective category — on change the existing one if no new one comes)
 * @param {{ previousBodyLength?: number, lock?: boolean }} [opts]  `lock`: reject above the limit (only for agents — the
 *   marker `ofAgent`); `previousBodyLength`: on change the length of the stored body (an old, long one stays editable)
 * @returns {{ formHints: string[], rejection: { length: number, limit: number } | null }}
 */
export function checkContextForm(fields = {}, { previousBodyLength, lock = false } = {}) {
  const text = (v) => (typeof v === "string" ? v : null);
  const bodyFull = text(fields.body);
  if (lock && bodyFull !== null && bodyFull.length > CONTEXT_BODY_LIMIT
    && !(Number.isFinite(previousBodyLength) && bodyFull.length <= previousBodyLength)) {
    // Locked: nothing is written, so there is nothing to check — return at once.
    return { formHints: [], rejection: { length: bodyFull.length, limit: CONTEXT_BODY_LIMIT } };
  }
  const title = capped(text(fields.title));
  const summary = capped(text(fields.summary));
  const body = capped(bodyFull);
  const openPoints = String(fields.category || "") === "open-points";
  const hints = [];

  if (bodyFull !== null && bodyFull.length > CONTEXT_BODY_HINT) {
    hints.push(`body has ${bodyFull.length} characters — an entry carries ONE statement, usually under 1,500 characters: shorten it or split it into several entries.`);
  }

  const everything = [title, summary, body].filter((x) => x !== null).join("\n");
  const branch = BRANCH.exec(everything);
  if (branch) {
    hints.push(`names the branch "${short(branch[1])}" — if it is only the place where something originated or was fixed, leave it out (branch names go stale); if the branch itself is the subject of the knowledge, it stays.`);
  }
  const commit = COMMIT.exec(everything);
  if (commit) hints.push(`contains a commit hash ("${commit[1]}") — commit states go stale; codePaths set the anchor (the server anchors the current commits itself).`);
  if (title !== null) {
    const seq = NUMBER_IN_TITLE.exec(title);
    if (seq) hints.push(`the title carries the number "${seq[1] || seq[2]}" — the title is the statement; what you learned from the issue is knowledge, its number is not.`);
  }
  if (body !== null && !openPoints) {
    let status = null;
    for (const m of body.matchAll(HEADING)) {
      const h = headingText(m[1]);
      if (STATUS_WORD.test(h)) { status = h; break; }
    }
    if (status) hints.push(`body has a status section ("${short(status)}") — state and progress go stale; open items become an entry of their own in the category open-points.`);
    if (CHECKBOX.test(body)) hints.push("body contains checkboxes (- [ ]) — a task list belongs in an entry of the category open-points or in the chat's agenda.");
  }
  return { formHints: hints, rejection: null };
}

/** The error text of a lock (400), in the UI language. */
export function formRejectionText({ length, limit }) {
  return T`body has ${length} characters (limit ${limit}) — nothing written. An entry carries ONE statement: split it into several entries (title = the statement, body usually under 1,500 characters) or shorten it; open items become an entry of their own in the category open-points.`;
}

// The response of a write with the hints — the field is absent if there are none (the response then stays the same).
export const withFormHints = (response, hints) => (hints && hints.length ? { ...response, formHints: hints } : response);
