// transcript.js — persisted chat history → neutral messages for the loop engine.
//
// Stateless providers (all third parties) have no `--resume`: their memory IS this transcript. It is therefore
// reconstructed COMPLETELY, including `tool_use`/`tool_result` — otherwise a chat would not know from its second
// message on which files it had read and which commands it had run.
//
// PURE: no DB, no I/O — input are the rows from store.listMessages, output are messages in the neutral engine format
// ({role, content: string | Block[]}). That makes it testable.

import { askAnswerPrompt, cardClosedSentence, cardsHistory } from "../runs/question-history.js";

export const TRANSCRIPT_TEXT_CAP = 40_000;   // per SINGLE text message (against monster entries)
export const TRANSCRIPT_MIN_CHARS = 60_000;  // lower bound, even with a tiny context window
const CHARS_PER_TOKEN = 3.5;                 // rough estimate, rather conservative for code
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Character budget of the lookback. Depends on the model's CONTEXT WINDOW, not on a fixed number: otherwise a 1M model
 * would get the same lookback as a 128k model, and the engine's autocompact could never kick in because the history
 * always stayed tiny. Half the window leaves room for system prompt, tool catalog and the new run.
 */
export function transcriptBudgetChars(contextWindow) {
  const win = Number(contextWindow) > 0 ? Number(contextWindow) : DEFAULT_CONTEXT_WINDOW;
  return Math.max(TRANSCRIPT_MIN_CHARS, Math.floor(win * 0.5 * CHARS_PER_TOKEN));
}

/**
 * @param {Array<{role:string,text:string}>} rows  rows from store.listMessages (chronological)
 * @param {{contextWindow?:number, dropTrailingUser?:boolean, attachmentDir?:string}} opts
 *   dropTrailingUser — leave out the trailing stored user rows (doRun appends the current prompt separately as
 *   spec.input).
 *   attachmentDir — folder of the chat attachments. Earlier image attachments cannot be restored as an image block
 *   (they are not in the history), but their PATH can: the model can look at them again via `Read` when needed — just
 *   like on the CLI path via --add-dir.
 *   attachmentPath — instead of the folder a function file name → path (runs/system-prompt.js, the reader with the
 *   project-container fallback: an attachment may still lie in the old runtime folder). It takes precedence.
 * @returns {Array<{role:string, content:string|Array}>}  Plus (non-enumerable) `beginningPreserved`: does the lookback
 *   contain the `input` row that carried the preambles from the start of the session (runs/do-run.js `preambleResumed`)?
 *
 * The role `input`: the wording with which the loop engine REALLY sent a user message out — including agenda, hint and
 * ultracode preamble, summary, hook context and date line. In the replay it replaces what the human (or the system)
 * left as a row for it: all user-side rows (`user`, `ask_answer`, `monitor`) of the same GAP — between two model-side
 * rows (`assistant`, `tool`, `tool_result`, `ask`) — are dropped, the `input` rows of the gap stand in their place,
 * UNSHORTENED and UNTRIMMED: only then does the first request of the next run begin with the bytes of the last one
 * (prompt cache), and the model sees in the follow-up turn what it saw in the turn before (the agenda!). A gap without
 * `input` (Claude/Codex turns, older chats, a silent abort before sending) stays as it was. The order within the gap
 * does not matter — an injection writes its user row sometimes before, sometimes after the input.
 */
export function buildTranscript(rows, { contextWindow = 0, dropTrailingUser = true, attachmentDir = "", attachmentPath: attachmentPath2 = null } = {}) {
  const attachmentPath = typeof attachmentPath2 === "function" ? attachmentPath2 : attachmentDir ? (f) => `${attachmentDir}/${f}` : null;
  const list = Array.isArray(rows) ? rows : [];
  let end = list.length;
  if (dropTrailingUser) while (end > 0 && list[end - 1].role === "user") end--;

  // Start boundary: after /clear (hard boundary) or after a compaction (doRun prepends its summary once).
  let start = 0;
  for (let i = 0; i < end; i++) {
    if (list[i].role === "clear") { start = i + 1; continue; }
    if (list[i].role !== "meta") continue;
    try { if (JSON.parse(list[i].text).compacted) start = i + 1; } catch { /* run metas and the like */ }
  }

  const clip = (s) => (s.length > TRANSCRIPT_TEXT_CAP ? s.slice(0, TRANSCRIPT_TEXT_CAP) + "\n… [truncated]" : s);
  const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // ── Pass 1: rows → messages with blocks ──────────────────────────────────────
  // The order in the DB IS the order of the run (assistant text → tool → tool_result → …), so sequential appending is
  // enough. Subagent rows (parent set) stay out: their calls belong to the subagent's conversation, which no longer
  // exists — as tool_use in the main thread they would have no matching result.
  const items = []; // { role, blocks:[], chars }
  const pushText = (role, text) => {
    const t = String(text || "").trim();
    if (!t) return;
    items.push({ role, blocks: [{ type: "text", text: clip(t) }], chars: Math.min(t.length, TRANSCRIPT_TEXT_CAP) });
  };
  const openToolUses = new Set(); // tool_use_id while the result is still missing
  // Where a question card closed WITHOUT a selection — by the rule of openAskOf (runs/question-history.js), the run
  // window of the workflow exception taken from the history rows. Computed over the WHOLE history: the card can stand
  // before the start boundary. Claude and Codex keep the hint "card closed" in their session; here it is not a row
  // (runs/hints.js) and has to stand where the card closed — otherwise the model says "the card is above" again in the
  // follow-up turn.
  const cardsTo = cardsHistory(list).closedCards;
  const cardTo = (z) => `[Question card closed, without a selection]\n${cardClosedSentence(z.card, z.reason)}`;
  // cbase_ask writes its card DURING the tool call — the `ask` row stands between `tool` and `tool_result`. As its own
  // assistant message there it would separate call and result, and the OpenAI format requires the tool message right
  // after the call. The text therefore waits until the results of this round are in.
  let waiting = null; // { ids: Set<tool_use_id>, texts: string[] }
  const handIn = () => { if (waiting) for (const t of waiting.texts) pushText("assistant", t); waiting = null; };

  // The user-side gap (see header: role `input`): from which entry it begins and whether it already carries an input.
  const USER_SIDE = new Set(["user", "ask_answer", "monitor", "input"]);
  const MODEL_SIDE = new Set(["assistant", "tool", "tool_result", "ask"]);
  let gapFrom = 0;
  let gapWithInput = false;

  // Whether a model-side row really contributed something: a subagent row (parent) or an orphaned result does NOT end
  // the gap — a background agent also writes its rows between the user row and the input of a turn.
  const state = () => `${items.length}:${items.at(-1)?.blocks.length ?? 0}:${openToolUses.size}:${waiting ? waiting.texts.length : -1}`;

  for (let i = start; i < end; i++) {
    const r = list[i];
    if (r.role === "input") {
      const b = json(r.text);
      const text = typeof b?.text === "string" ? b.text : "";
      if (!text) continue;
      if (!gapWithInput) { items.splice(gapFrom); gapWithInput = true; }
      items.push({ role: "user", blocks: [{ type: "text", text }], chars: text.length, beginning: b.beginning === true });
      continue;
    }
    if (gapWithInput && USER_SIDE.has(r.role)) continue; // covered by the input of this gap
    const prior = state();
    process(r, i);
    if (MODEL_SIDE.has(r.role) && state() !== prior) { gapFrom = items.length; gapWithInput = false; }
  }

  function process(r, i) {
    if (r.role === "user") {
      const files = attachmentPath && Array.isArray(r.attachments)
        ? r.attachments.map((a) => a?.file).filter(Boolean).map(attachmentPath)
        : [];
      const text = files.length ? `${r.text}\n[Attachments of this message: ${files.join(", ")}]` : r.text;
      // This human message bypassed an open card: the sentence the agent read in its turn before the input.
      const closed = cardsTo.get(i);
      pushText("user", closed ? `${cardTo(closed)}\n\n---\n\n${text}` : text);
      return;
    }
    if (r.role === "assistant") { pushText("assistant", r.text); return; }
    if (r.role === "tool") {
      const b = json(r.text);
      if (!b || b.parent || !b.id || !b.name) return;
      const last = items[items.length - 1];
      const block = { type: "tool_use", id: b.id, name: b.name, input: b.input && typeof b.input === "object" ? b.input : {} };
      const chars = JSON.stringify(block).length;
      if (last && last.role === "assistant") { last.blocks.push(block); last.chars += chars; }
      else items.push({ role: "assistant", blocks: [block], chars });
      openToolUses.add(b.id);
      return;
    }
    if (r.role === "tool_result") {
      const b = json(r.text);
      if (!b || !b.id || !openToolUses.has(b.id)) return; // result of a subagent call or the like
      openToolUses.delete(b.id);
      const last = items[items.length - 1];
      const block = { type: "tool_result", tool_use_id: b.id, content: String(b.result ?? ""), is_error: Boolean(b.isError) };
      const chars = block.content.length + 64;
      if (last && last.role === "user" && last.blocks.every((x) => x.type === "tool_result")) { last.blocks.push(block); last.chars += chars; }
      else items.push({ role: "user", blocks: [block], chars });
      if (waiting && ![...waiting.ids].some((id) => openToolUses.has(id))) handIn();
      return;
    }
    // Question cards are real conversation content (the model asked, the user answered).
    if (r.role === "ask") {
      const b = json(r.text);
      const qs = Array.isArray(b?.questions) ? b.questions.map((q) => String(q?.question || "").trim()).filter(Boolean) : [];
      if (!qs.length) return;
      const text = `[Question to the user]\n${qs.join("\n")}`;
      const last = items[items.length - 1];
      const open = last?.role === "assistant" ? last.blocks.filter((x) => x.type === "tool_use" && openToolUses.has(x.id)).map((x) => x.id) : [];
      if (!open.length) { pushText("assistant", text); return; }
      waiting ??= { ids: new Set(), texts: [] };
      for (const id of open) waiting.ids.add(id);
      waiting.texts.push(text);
      return;
    }
    if (r.role === "ask_answer") {
      // `answers` is an ARRAY of {header, question, selected, text} (runs/ask.js normalizeAskAnswers). Literally the
      // input with which the answer reached the agent (askAnswerPrompt). Without answers the server dismissed the card
      // (dismissAsk: step skipped, workflow start/end, archive) — then the sentence of its silent hint.
      const b = json(r.text);
      const answers = Array.isArray(b?.answers) ? b.answers.filter((a) => a && typeof a === "object").map((a) => ({
        header: String(a.header || ""),
        question: String(a.question || ""),
        selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
        text: String(a.text || ""),
      })) : [];
      if (answers.length) pushText("user", askAnswerPrompt(answers));
      else if (cardsTo.has(i)) pushText("user", cardTo(cardsTo.get(i)));
      return;
    }
    if (r.role === "monitor") {
      const b = json(r.text);
      if (b?.event === "fired") pushText("user", `[Monitor event: ${b.description || b.taskId}]`);
      return;
    }
    // thinking/goal/limit/workflow/meta/clear: no model context (thinking blocks without a signature cannot be replayed
    // anyway, the rest is app bookkeeping).
  }

  // A run aborted in the middle of a tool leaves a tool_use WITHOUT a result. Unpaired, at least Anthropic rejects the
  // whole request → supply the result.
  if (openToolUses.size) {
    const blocks = [...openToolUses].map((id) => ({ type: "tool_result", tool_use_id: id, content: "(The run ended before the result)", is_error: true }));
    items.push({ role: "user", blocks, chars: blocks.length * 64 });
  }
  handIn(); // a card from a round whose result never came — behind the supplied results

  // ── Pass 2: trim to the budget from the end ──────────────────────────────────
  const budget = transcriptBudgetChars(contextWindow);
  let used = 0;
  let cut = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    used += items[i].chars;
    if (used > budget) { cut = i + 1; break; }
  }
  // The cut must not land on a result message — its tool_use would lie before it.
  while (cut < items.length && items[cut].role === "user" && items[cut].blocks.some((b) => b.type === "tool_result")) cut++;
  const kept = items.slice(cut);
  const beginningPreserved = kept.some((it) => it.beginning === true);
  const withBeginning = (arr) => Object.defineProperty(arr, "beginningPreserved", { value: beginningPreserved, enumerable: false });
  if (!kept.length) return withBeginning([]);

  // ── Pass 3: neutral messages ─────────────────────────────────────────────────
  const out = kept.map((it) => ({
    role: it.role,
    // Plain text stays a string (the connectors prefer that over a one-block array).
    content: it.blocks.length === 1 && it.blocks[0].type === "text" ? it.blocks[0].text : it.blocks,
  }));
  // Anthropic requires a user message as the first entry. After trimming an assistant turn can be in front — then a
  // short line says honestly that older content is missing.
  if (out[0].role === "assistant") {
    out.unshift({ role: "user", content: "[Continuation of an earlier conversation — the older part was left out for lack of space.]" });
  }
  return withBeginning(out);
}
