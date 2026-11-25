// The ultracode reminders and the guide to writing workflows.
//
// LIKE CLAUDE CODE (measured on the binary of the pinned version, attachments `ultra_effort_enter`/`ultra_effort_exit`
// and `workflow_keyword_request`): at every user turn the question is what the model last learned about the mode.
//   - mode on, not last reported as "on"  ⇒ the FULL reminder (optimise for the most thorough, most correct answer;
//     a dynamic workflow for every substantial task) — the counter starts at 0;
//   - mode on, already reported           ⇒ the counter counts this user turn; at the 10th, 20th, … the TIGHT one
//     (baseline: `TURNS_BETWEEN_MAINTENANCE: 10`);
//   - mode off, last reported as "on"     ⇒ the off notice.
// "Last reported" only holds while the context that carries the report is still THE SAME: if the turn begins without a
// resumed session — cbase compacted (summary + fresh session), /clear, provider switch, resume retry without a session
// — or the provider compacted the session itself since the last turn (Claude `compact_boundary`, Codex `compacted`,
// loop engine), the model knows neither the full reminder nor the guide any more, and with the mode on the FULL one
// comes again with the guide (the counter restarts). runs/do-run.js asks that question ONCE per turn (`resumed`, the
// same value as for the agenda block runs/agenda-block.js) and passes it here.
// The question depends on the STORED mode (`chats.ultracode`), not on the way there: a PATCH through the route,
// `/effort ultracode` (the same PATCH), creating a chat in the mode and the run setting of a graph workflow trigger the
// same. As in the baseline, an off-and-on-again between two turns reports nothing (last reported is "on").
//
// A "user turn" is a turn with human input — read through the ONE reading (runs/human-input.js humanFrom): completion
// notices, channel, schedule and event turns do not count and get nothing. The counter lives in the database
// (store/ultracode-reminder.js) and survives a restart.
//
// THE GUIDE (dynworkflows/guide.md, the cbase revision of the skill "workflow-authoring") travels with the full
// reminder — and with the keyword "ultracode" in the human input (approval.js carriesKeyword), then only in exactly
// that turn. In Claude Code the model loads it as a skill itself; cbase attaches it because the skill does not exist.
//
// Everything goes into the turn's USER MESSAGE, never into the system prompt: there every change would cost the prompt
// cache of the whole history. And only where `cbase_dynamic_workflow` is in the toolset (the full set of a coding chat;
// a named toolset does not have it — execution side and description side must give the same answer). Connected through
// the setter runs/do-run.js setTurnPreamble (server.js): runs/ never imports dynworkflows/.
//
// The behaviour follows the pinned Claude version, the wordings are cbase's own — when the pin moves, it is re-measured:
// Reference-Version: 2.1.332
// (The baseline also asks `ultra_effort_enter` at `deliveredTurnStart`, not only at `isRegularUserPrompt` — cbase stays
// with the human input, see above.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "../store.js";
import { humanFrom } from "../runs/human-input.js";
import { carriesKeyword } from "./approval.js";

export const REMINDER_TICK = 10;
export const GUIDE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "guide.md");

export const REMINDER_FULL = "Ultracode is on: optimize for the most thorough, most correct answer — not the fastest or cheapest. "
  + "Use cbase_dynamic_workflow for every substantial task; token cost is not a limit. See the section "
  + "**Ultracode** and the quality patterns in the guide to writing workflows (below). You work alone only in "
  + "conversational or trivial turns.";
export const REMINDER_TIGHT = "Ultracode is still on — use cbase_dynamic_workflow; see the Ultracode section of the guide to "
  + "writing workflows.";
export const REMINDER_OFF = "Ultracode is off — for cbase_dynamic_workflow the ordinary opt-in rule from its description applies again.";
export const KEYWORD_SET = "The user wrote the keyword “ultracode” and thereby approved this turn for "
  + "multi-agent orchestration — fulfil the request with cbase_dynamic_workflow.";

const MARKER = "cbase-ultracode";

/**
 * One step of the counting, pure: what this user turn gets and the state afterwards.
 * @param {{ an: boolean, reported: 0|1, turns: number, resumed?: boolean }} s  `resumed: false` = this turn's context
 *   carries nothing from the start of the session (see header) — an earlier "on" report then does not count.
 * @returns {{ kind: "full"|"tight"|"off"|null, fresh: { reported: 0|1, turns: number } }}
 */
export function reminderStep({ enabled, reported, turns, resumed = true }) {
  if (enabled) {
    if (!reported || !resumed) return { kind: "full", fresh: { reported: 1, turns: 0 } };
    const n = (Number(turns) || 0) + 1;
    return { kind: n % REMINDER_TICK === 0 ? "tight" : null, fresh: { reported: 1, turns: n } };
  }
  if (reported) return { kind: "off", fresh: { reported: 0, turns: 0 } };
  return { kind: null, fresh: { reported: 0, turns: Number(turns) || 0 } };
}

let guideCache = null;
/** The guide as the model sees it: without the HTML comments (provenance, stamp). */
export function guideText() {
  if (guideCache === null) guideCache = fs.readFileSync(GUIDE_FILE, "utf8").replace(/<!--[\s\S]*?-->\n*/g, "").trim();
  return guideCache;
}

const disarm = (s) => String(s).replace(new RegExp(`<(\\s*/?\\s*${MARKER})`, "gi"), "‹$1");

/** The fenced block of reminder, keyword sentence and guide; `""` when none of them applies. Pure. */
export function reminderBlock({ kind = null, keyword = false, guide = false }) {
  const sets = [];
  if (kind === "full") sets.push(REMINDER_FULL);
  else if (kind === "tight") sets.push(REMINDER_TIGHT);
  else if (kind === "off") sets.push(REMINDER_OFF);
  if (keyword) sets.push(KEYWORD_SET);
  if (!sets.length && !guide) return "";
  const parts = [
    `<${MARKER}>`,
    "[cbase system reminder — NOT typed by the human; it concerns the ultracode mode of this chat. The human's message follows after the separator.]",
    ...sets,
  ];
  if (guide) parts.push("", `<${MARKER}-guide>`, disarm(guideText()), `</${MARKER}-guide>`);
  parts.push(`</${MARKER}>`);
  return parts.join("\n");
}

/**
 * The hook for runs/do-run.js (setTurnPreamble): what the user message of a BEGINNING turn carries.
 * @param {{ chat: Object, toolset: string, inputs: Array, resumed?: boolean }} o  `inputs` in the shape of
 *   runs/human-input.js; `resumed` is do-run.js's answer to "does the context still carry the start of the session?"
 * @returns {{ text: string, confirm: () => void } | null}  `null` = nothing to do (no user turn, no tool);
 *   `confirm()` writes the new counter state — the caller calls it as soon as the turn really begins.
 */
export function ultracodePreamble({ chat, toolset, inputs, resumed = true }) {
  if (!chat?.id || toolset) return null;
  const human = humanFrom(inputs);
  if (!human.length) return null;
  const fresh = store.getChat(chat.id) || chat;
  let state;
  try { state = store.readUltracodeReminder(chat.id); } catch { return null; /* the table is only missing before initStore */ }
  const { kind, fresh: fresh2 } = reminderStep({ enabled: Boolean(fresh.ultracode), ...state, resumed: resumed !== false });
  const keyword = human.some(carriesKeyword);
  const text = reminderBlock({ kind, keyword, guide: kind === "full" || keyword });
  const changed = fresh2.reported !== state.reported || fresh2.turns !== state.turns;
  return {
    text,
    confirm: () => { if (changed) store.setUltracodeReminder(chat.id, fresh2); },
  };
}

/** With the chat its state goes (called from run.js — every delete path). */
export function reminderChatClosed(chatId) {
  try { store.deleteUltracodeReminder(chatId); } catch { /* nothing to delete without the table */ }
}
