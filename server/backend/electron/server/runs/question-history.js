// Question cards in the history: when a card closes (closesCard, cardsHistory) and what the agent reads about it
// (askAnswerPrompt, cardClosedSentence). Extracted from runs/ask.js so that the engine transcript (providers/transcript.js) reads
// the same rule as openAskOf instead of carrying a fourth copy next to openAskOf, store/chats.js listOpenAsks (SQL) and the
// clients (chatBubbles.ts buildTimeline).
//
// Reason: the loop engine (third-party providers) has no `--resume`; its memory is the transcript buildTranscript builds from the
// history each turn. A card that a message of the human had bypassed would show there from the next turn on only as
// a bare question row — the "card closed" hint is no history row (runs/hints.js); Claude and Codex keep it in their session,
// the engine lost it.
//
// A leaf: no DB, no I/O — buildTranscript is pure and is tested without a server.

import { isCompletionNotice } from "./completionNotice.js";
import { isMessage } from "./message-marker.js";

// Whether a user row with this text closes an open card. A subagent's completion notice and another agent's message sit under
// the role "user" but are not the human's decision. Read by cardsHistory (afterwards) and runs/ask.js bypassedCard (before);
// store/chats.js listOpenAsks carries the same rule as SQL.
export const closesCard = (text) => !isCompletionNotice(text) && !isMessage(text);

const read = (text) => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, value: null }; } };

/**
 * The question cards of a history, row by row — the rule of openAskOf: the newest card is open as long as it is unanswered and no
 * message of the human came after it. EXCEPTION in a running workflow: there free text does not close the card (an interjected
 * question must not consume a node's decision point, runs/ask.js); it then closes only with its answer or with the `ask_answer`
 * of dismissAsk. `/clear` always closes it, also during a run — like the clients (chatBubbles.ts closeAsks) and listOpenAsks
 * (`clear` is among the closing roles there; the workflow exception applies to user rows only).
 *
 * @param {Array<{role:string,text:string}>} rows  history rows, chronological
 * @param {{workflowOpen?: boolean}} [o]  set: the server knows whether a workflow is running NOW, and that holds for the whole
 *   history (openAskOf — the card that is open now). Unset: the run window per row from the history rows `workflow`
 *   kind start/end, like the clients (chatBubbles.ts `runOpen`) — for looking back at earlier cards (engine transcript).
 * @returns {{open: {requestId:string, questions:Array}|null, zu: Map<number, {card:{requestId:string, questions:Array}, reason:string}>}}
 *   open — the card at the end; zu — per row index the card THIS row closed without a selection (a message of the human:
 *   bypassed; an `ask_answer` without answers: dismissed), with the reason worded as in cardClosedSentence. `/clear` is not in it:
 *   the transcript's look back begins after it, and the agent has lost the conversation state before it anyway.
 */
export function cardsHistory(rows, { workflowOpen } = {}) {
  const fixed = typeof workflowOpen === "boolean";
  let run = fixed ? workflowOpen : false;
  let open = null;
  const closedCards = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    if (r?.role === "workflow") {
      if (fixed) return;
      const kind = read(r.text).value?.kind;
      if (kind === "start") run = true;
      else if (kind === "end") run = false;
      return;
    }
    if (r?.role === "clear") { open = null; return; }
    if (r?.role === "user") {
      if (open && !run && closesCard(r.text)) { closedCards.set(i, { card: open, reason: BYPASSED }); open = null; }
      return;
    }
    if (r?.role === "ask") {
      const p = read(r.text);
      if (!p.ok) return; // defective row
      const requestId = String(p.value?.requestId || "");
      open = requestId ? { requestId, questions: Array.isArray(p.value.questions) ? p.value.questions : [] } : null;
      return;
    }
    if (r?.role === "ask_answer") {
      const a = read(r.text).value;
      if (!open || String(a?.requestId || "") !== open.requestId) return;
      if (!(Array.isArray(a.answers) && a.answers.length)) closedCards.set(i, { card: open, reason: dismissedReason(a.dismissed) });
      open = null;
    }
  });
  return { open, closedCards };
}

// What the agent learns about a card that closes without a selection (silent hint or the same fence before the input, and in the
// engine transcript at the point where it closed). It says that it is closed and why — whether a message of its own answers the
// question, the model decides from the text.
export function cardClosedSentence(card, reason) {
  const questions = (card?.questions || []).map((q) => String(q?.question || "").trim()).filter(Boolean);
  return [
    `Your question card is closed: ${reason}. It can no longer be clicked, a selection on it will not arrive any more — `
      + "do not refer to it any more. If you still need the decision, ask again (cbase_ask as a new card or in text).",
    ...questions.map((f) => `Question on the card: “${f}”`),
  ].join("\n");
}
export const BYPASSED = "the human did not choose on it but wrote this turn's message — if it answers "
  + "your question, it counts as the answer, otherwise the question is bypassed";
export const bypassedSet = (card) => cardClosedSentence(card, BYPASSED);
const DISMISSED = {
  skip: "the workflow step it belonged to was skipped",
  "workflow-start": "a workflow began in this chat",
  archive: "the chat was archived",
};
export const dismissedReason = (reason) => DISMISSED[reason] || (String(reason).startsWith("run-") ? "the workflow run ended" : "it was discarded");

// What the agent gets to see: the question with the selection, as a user message.
export function askAnswerPrompt(answers) {
  const lines = ["[Answer to your question — the user selected in the chat]"];
  for (const a of answers) {
    lines.push("", `Question: ${a.question}`);
    if (a.selected.length) lines.push(`Selected: ${a.selected.join(", ")}`);
    if (a.text) lines.push(`Own answer: ${a.text}`);
    if (!a.selected.length && !a.text) lines.push("No selection — decide yourself and give a brief reason.");
  }
  lines.push("", "Continue on this basis.");
  return lines.join("\n");
}
// What appears in the history as a user bubble: terse like a typed answer.
export function askAnswerDisplay(answers) {
  const part = (a) => {
    const value = [a.selected.join(", "), a.text].filter(Boolean).join(" — ");
    if (!value) return a.header ? `${a.header}: —` : "—";
    return answers.length > 1 && a.header ? `${a.header}: ${value}` : value;
  };
  return answers.map(part).join("\n");
}
