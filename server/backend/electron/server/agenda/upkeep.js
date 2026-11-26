// The agenda keeper's write path: the computation behind POST /api/chats/:id/agenda/upkeep (agenda/routes.js, tool
// cbase_agenda_maintain). The keeper exists because the main model sometimes forgets to update the agenda — and the two must
// never update it at the same time.
//
// The order of the checks, each with its own status and one sentence for the model:
//   1. the chat keeps an agenda (409 NO_AGENDA) — archived is already caught by chats/routes.js before the body (409), by the
//      transaction a second time
//   2. body: object, `base` integer ≥ 0, only known fields (400 BODY)
//   3. the marker `outerLoop` = `<agentId>:<runId>`: the run IS RUNNING, belongs to this agent, sits on this chat, the agent is
//      the agenda keeper (403 NO_RUN) — the same shape as communication/target-outer-loop.js checkSendMarker
//   4. quiet: no turn, no queued input, no background work, no open question (409 CHAT_WORKING + reason)
//   5. the transaction (agenda/change.js, originator "keeper"): version (409 STALE), operations (400 NOT_ALLOWED, BACKWARD,
//      NO_SHEET, NOT_EMPTY, INVALID), lock (409 REVERTED), then the computation as for every writer
//   6. only with an effect: the silent hint to the main agent; log and event come from the transaction
//
// THERE IS NO await BETWEEN 4 AND 5: quiet holds for exactly the transaction that writes next. A turn that starts a millisecond
// later sees the new agenda (its block is built at turn start) — and the abort at `turnStart` (outerloop/) ends the keeper's
// run before it can write a second time. A keeper that decided on an old state is caught by `base`.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { compacting, pendingRunInputs, running } from "../runs/state.js";
import { backgroundWork } from "../runs/background.js";
import { openAskOf } from "../runs/ask.js";
import { depositHint } from "../runs/hints.js";
import { changeAgenda } from "./change.js";
import { AGENDA_UPKEEP_CODES, AgendaError, nextStep } from "./operations.js";

/** The body's fields: the tool's arguments and the markers the MCP server sets AFTER them. */
export const UPKEEP_BODY_FIELDS = Object.freeze(["base", "title", "description", "steps", "outerLoop", "ofProfile", "workflowAgent"]);
/** The reasons of the quiet check, in the order they are checked. */
export const UPKEEP_QUIET_REASONS = Object.freeze(["turn", "queued", "background", "question"]);
/** The hint names at most this many changes one by one, texts cut to this many characters. */
export const UPKEEP_HINT_CAP = Object.freeze({ changes: 20, text: 80 });

const no = (status, code, text, extra = {}) => ({ status, body: { ok: false, code, error: text, ...extra } });
const marker = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Check the run marker against the run. → `{ agent, run }` or `{ error }` (403 NO_RUN).
 * The run's toolset is not looked at: which tools the keeper has is decided by outerloop/set.js — here only WHO writes counts.
 */
export function checkUpkeepMarker(chat, value) {
  const s = marker(value);
  const i = s.indexOf(":");
  const error = no(403, "NO_RUN", T("rejected: no running agenda-keeper run on this chat — only the agenda keeper updates the agenda this way, within its own run; the main agent writes it with cbase_agenda_write."));
  if (i <= 0 || i === s.length - 1) return { error };
  const agentId = s.slice(0, i);
  const run = store.outerLoopRun(s.slice(i + 1));
  if (!run || run.state !== "running" || run.agentId !== agentId || run.chatId !== chat.id) return { error };
  const agent = store.outerLoopAgent(agentId);
  if (!agent || !agent.agendaKeeper || agent.workspaceId !== chat.workspaceId) return { error };
  return { agent, run };
}

/**
 * Is the chat quiet? → null or the reason (`UPKEEP_QUIET_REASONS`). Synchronous and without writing — called right before
 * the transaction. Compacting counts as a turn (it works on the same session).
 */
export function upkeepQuietReason(chatId) {
  const id = String(chatId);
  if (running.has(id) || compacting.has(id)) return "turn";
  if ((pendingRunInputs.get(id) || []).length) return "queued";
  if (backgroundWork(id).length) return "background";
  if (openAskOf(id)) return "question";
  return null;
}

const QUIET_TEXT = {
  turn: () => T("the main agent is working right now (a turn is running)"),
  queued: () => T("a message is waiting for the next turn"),
  background: () => T("subagents or workflows of the chat are still working in the background"),
  question: () => T("the chat is waiting for a human's answer to a question"),
};

const short = (s, max = UPKEEP_HINT_CAP.text) => {
  const z = [...String(s ?? "")];
  return z.length > max ? `${z.slice(0, max - 1).join("")}…` : z.join("");
};

/**
 * The text of the silent hint to the main agent — from the changes (`changed` of the transaction) and the new agenda in
 * its response shape (for text and status of the items). Pure, exported for tests.
 */
export function upkeepHintText(changed, agenda) {
  const byId = new Map((agenda?.steps || []).map((s) => [s.id, s]));
  const parts = (changed || []).slice(0, UPKEEP_HINT_CAP.changes).map((g) => {
    if (g.kind === "title") return T`title “${short(g.after)}”`;
    if (g.kind === "description") return T("description set");
    const s = byId.get(g.pointId);
    const text = short(s?.text ?? g.after ?? "");
    if (g.kind === "fresh") return T`new ${g.pointId} “${text}” (${s?.status ?? "open"})`;
    return T`${g.pointId} “${text}” ${g.prior} → ${g.after}`;
  });
  const rest = Math.max(0, (changed || []).length - UPKEEP_HINT_CAP.changes);
  if (rest) parts.push(T`… and ${rest} more`);
  return T`The agenda keeper (outer loop) brought your agenda up to date: ${parts.join("; ")}. If something is wrong, change it with cbase_agenda_write — your change takes precedence; the keeper never repeats a change you took back.`;
}

const NO_AGENDA = () => T("This chat keeps no agenda — only coding chats have one.");

/**
 * The whole path after reading the body (checks 1–6 above). `chat` = the chat from the path, `body` = the body as read.
 * → `{ status, body }`.
 */
export function maintainAgenda(chat, body, { now = Date.now() } = {}) {
  if (!store.chatKeepsAgenda(chat)) return no(409, "NO_AGENDA", NO_AGENDA());
  if (!body || typeof body !== "object" || Array.isArray(body)) return no(400, "BODY", T("The body must be an object — nothing written."));
  if (!Number.isInteger(body.base) || body.base < 0) {
    return no(400, "BODY", T("base is missing or not an integer ≥ 0 — send the version you read with cbase_agenda; nothing written."));
  }
  const unknown = Object.keys(body).filter((k) => !UPKEEP_BODY_FIELDS.includes(k));
  if (unknown.length) return no(400, "BODY", T`Unknown fields: ${unknown.join(", ")} — allowed are base, title, description, steps; nothing written.`);
  // A workflow marker means: not an outer-loop run — the same precedence as communication/sender.js senderOf (the workflow
  // marker before the outer loop's, that before the profile marker; an outer-loop run with a profile stays an outer-loop run).
  if (marker(body.workflowAgent)) return checkUpkeepMarker(chat, "").error;
  const m = checkUpkeepMarker(chat, body.outerLoop);
  if (m.error) return m.error;
  // ── From here synchronous until after the transaction (no await): quiet holds for exactly this transaction. ──
  const reason = upkeepQuietReason(chat.id);
  if (reason) {
    return no(409, "CHAT_WORKING", T`The chat is not idle — ${QUIET_TEXT[reason]()}. Change nothing and note it.`, { reason });
  }
  const { base, outerLoop: _o, ofProfile: _p, workflowAgent: _w, ...input } = body;
  let r;
  try {
    r = changeAgenda(chat.id, chat.workspaceId, input, {
      now, originator: "keeper",
      keeper: { agentId: m.agent.id, runId: m.run.id, mark: m.agent.markUpkeep, base },
    });
  } catch (e) {
    if (e instanceof AgendaError) {
      const code = e.code && Object.hasOwn(AGENDA_UPKEEP_CODES, e.code) ? e.code : "INVALID";
      return no(AGENDA_UPKEEP_CODES[code], code, e.message);
    }
    if (e?.code === "archived") return no(409, "ARCHIVED", T("The chat is archived — read only."), { archived: true });
    if (e?.code === "no_agenda") return no(409, "NO_AGENDA", NO_AGENDA());
    if (e?.code === "chat_missing") return no(404, "CHAT_MISSING", "chat not found");
    throw e;
  }
  if (r.unchanged) return { status: 200, body: { ok: true, unchanged: true, agenda: r.agenda, version: r.agenda.version } };
  depositHint(chat.id, upkeepHintText(r.changed, r.agenda), { source: "agenda-keeper" });
  return { status: 200, body: { ok: true, agenda: r.agenda, version: r.agenda.version, changed: r.changed, touched: r.touched, next: nextStep(r.agenda) } };
}
