// Question cards (cbase_ask): caps, normalizeAskQuestions, openAskOf (a chat's open question), postAsk, dismissAsk,
// normalizeAskAnswers, askAnswerPrompt/askAnswerDisplay (the human's answer as prompt and as history text).
// The closing rule, the walk through the history and the wordings live in runs/question-history.js (a leaf that the
// engine transcript reads too); askAnswerPrompt/askAnswerDisplay/bypassedSet are passed on from here unchanged.
// No domain is imported here.

import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { recordNotice, resolveNotices } from "../services.js";
import { sse } from "../runtime/sse.js";
import { depositHint } from "./hints.js";
import { askAnswerDisplay, askAnswerPrompt, cardsHistory, cardClosedSentence, closesCard, bypassedSet, dismissedReason } from "./question-history.js";


// ── Questions with a choice card (cbase_ask) ───────────────────────────────
// The agent asks ONE question with recommended options; the chat shows a clickable card. Deliberately NOT blocking:
// the tool returns at once, the agent ends its turn, and the user's choice reaches it as the next message
// (deliverUserPrompt). Reason: a blocking MCP call depends on the providers' own tool time limits (Claude CLI, Codex
// CLI and loop engine have different, partly unknown caps) — but a question may stay open indefinitely, across
// restarts too. So the card lives only in the persisted history (row role='ask', answer as role='ask_answer'), not in
// memory.
const ASK_MAX_QUESTIONS = 4;
const ASK_MAX_OPTIONS = 6;

// Check and normalise the questions from the tool call. Errors are descriptive: the model should be able to correct
// the call instead of producing a broken card.
function normalizeAskQuestions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new Error("questions is missing: give at least one question.");
  if (list.length > ASK_MAX_QUESTIONS) throw new Error(`At most ${ASK_MAX_QUESTIONS} questions per call.`);
  return list.map((q, i) => {
    const question = String(q?.question || "").trim();
    if (!question) throw new Error(`Question ${i + 1}: field "question" is missing.`);
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => ({ label: String(o?.label || "").trim().slice(0, 120), description: String(o?.description || "").trim().slice(0, 400) }))
      .filter((o) => o.label);
    if (options.length < 2) throw new Error(`Question ${i + 1}: give at least two options with "label".`);
    if (options.length > ASK_MAX_OPTIONS) throw new Error(`Question ${i + 1}: at most ${ASK_MAX_OPTIONS} options.`);
    return {
      header: String(q?.header || "").trim().slice(0, 24),
      question: question.slice(0, 1000),
      multiSelect: q?.multiSelect === true,
      options,
    };
  });
}

// Derive a chat's open question from the HISTORY (single source of truth — survives every restart). A question is
// open only while it (a) is unanswered and (b) no user message came after it: if the user writes something else, the
// card is done. Otherwise ignored cards would stay "open" forever and block the target gate and further questions.
//
// EXCEPTION: while a workflow runs, the card stays open until it is really answered (clicked) or the run is ended or
// skipped. A follow-up question typed as free text must not use up a node's decision point: the step is only held
// while a card is open (workflowGateAfterRun), so closing the card would let the run jump to the next node with the
// actual decision unanswered.
//
// The rule itself (which user row closes, when an answer counts) lives ONCE in runs/question-history.js (closesCard,
// cardsHistory) — read here, by bypassedCard (before the write) and by the engine transcript
// (providers/transcript.js); store/chats.js listOpenAsks carries the same rule as SQL.
// A subagent's completion notice is stored under the role "user" but is not a human message — it does not close the
// card (same rule as in the clients). Likewise another agent's message.
// The workflow state of NOW applies to the whole history (sticky): asked for is the card that is open now. `/clear`
// closes it (as in the clients and in listOpenAsks).
function openAskOf(chatId) {
  const sticky = store.workflowOpen(store.getWorkflowRun(chatId));
  return cardsHistory(store.listMessages(chatId), { workflowOpen: sticky }).open;
}

// The card that these inputs BYPASS once their user rows are in the history — or null. Asked BEFORE the write, at
// every place in runs/queue.js where an input becomes a turn; `display` is what gets written (a silent entry writes
// no row). Without this the card closes by the rule above while the agent only gets the message text and keeps
// pointing at "the card above".
function bypassedCard(chatId, entries) {
  if (!(entries || []).some((e) => !e?.silent && closesCard(e?.display))) return null;
  if (store.workflowOpen(store.getWorkflowRun(chatId))) return null; // sticky: the message is a follow-up question
  return openAskOf(chatId);
}

// Ask the question: persist (the card survives reload/restart) and report it live to the chat.
function postAsk(chatId, questions) {
  const requestId = crypto.randomUUID();
  const payload = { requestId, questions };
  store.addMessage(chatId, "ask", JSON.stringify(payload));
  sse(chatId, { type: "harness", subtype: "ask_request", ...payload });
  const chat = store.getChat(chatId);
  const body = questions.map((q) => String(q.question || "").trim()).filter(Boolean).join("\n");
  // A choice card can stay open for hours. So it needs its own durable bell/push notice at once and must not
  // depend on the later end of the run alone.
  recordNotice({
    kind: "question",
    title: T`Question: ${chat?.title || "cbase"}`,
    chatTitle: chat?.title || "",
    body,
    chatId,
    workspaceId: chat?.workspaceId || null,
    projectId: chat?.projectId || null,
    requestId, // so the notice counts as resolved once the card is closed (resolveNotices)
  });
  return payload;
}

// Declare an open card done WITHOUT inventing an answer: the `ask_answer` row carries an EMPTY selection. That is
// what openAskOf and listOpenAsks read ("answered"), while the UI still shows it as an unanswered card that can no
// longer be clicked — the same rendering as an ignored card.
// Needed because the card survives a running workflow (sticky in openAskOf): no user message can void it then.
// Without this cleanup a card from a SKIPPED step would hold the next step on the same old question.
function dismissAsk(chatId, reason = "") {
  const open = openAskOf(chatId);
  if (!open) return null;
  store.addMessage(chatId, "ask_answer", JSON.stringify({
    requestId: open.requestId, answers: [], dismissed: reason || true,
  }));
  sse(chatId, { type: "harness", subtype: "ask_resolved", requestId: open.requestId, answers: [] });
  resolveNotices({ id: chatId, requestId: open.requestId });
  // The agent learns of it with its next turn (silent hint) — otherwise it would wait for a choice that never comes.
  depositHint(chatId, cardClosedSentence(open, dismissedReason(reason)), { source: "question" });
  return open.requestId;
}

// Map the user's choice onto the questions. Allowed are chosen option labels and/or a free text per question ("own
// answer") — both together make sense too.
function normalizeAskAnswers(questions, raw) {
  const given = Array.isArray(raw) ? raw : [];
  return questions.map((q, i) => {
    const a = given[i] || {};
    const labels = new Set(q.options.map((o) => o.label));
    const picked = (Array.isArray(a.selected) ? a.selected : [])
      .map((s) => String(s || "").trim())
      .filter((s) => labels.has(s));
    const selected = q.multiSelect ? picked : picked.slice(0, 1);
    return { header: q.header, question: q.question, selected, text: String(a.text || "").trim().slice(0, 2000) };
  });
}

export { askAnswerDisplay, askAnswerPrompt, dismissAsk, normalizeAskAnswers, normalizeAskQuestions, openAskOf, postAsk, bypassedCard, bypassedSet };
