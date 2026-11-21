// The booking of a main turn (originally in runs/do-run.js, the block "usage recording" at the end of the run; moved out when the
// booking got the cache separated, the generation ids and the state for the late booking; do-run.js stood at the 2,000-line guard).
//
// Two sources, because there are two modes of operation:
//   • Loop engine (OpenRouter) delivers the run's exact sums in res.usage → `metered`, broken down per (provider, model,
//     main/sub) in `parts` — a subagent may have run at another provider, a collective row would assign its tokens to the wrong
//     billing. Per part the reported amount (USD; null ⇒ the tick asks for it later or estimates it, account/openrouter-inquiry.js),
//     the provider of the last round and the generation ids.
//   • Native Claude/Codex CLIs do NOT set res.usage (subscription). Their consumption is in the tally, counted from the event stream →
//     `subscription`, main stream and subagents separate, the cache as read and write (usage-tally.js `cacheRead`/`cacheWrite`).
// Also on abort/error something was consumed (= billed) → always record. Native subagents (cbase_agent) are booked by their owner per
// agent immediately at its end (runs/agents.js) — their consumption is neither in res.usage nor in this run's tally.
//
// THE STATE FOR THE LATE BOOKING: a main turn books only here, at its end. If the process dies before (OOM, crash, deploy), its
// `active_runs` row still stands — `rememberTurnSession` records the session in it as soon as the turn reports it (the init event),
// and the restart books the turn late from the session file (runs/lateBooking.js, from `started_at`). The booking here and the
// clearing of the session belong together: a row whose turn is booked must not name a session any more — so bookTurn clears it in
// the same synchronous step.
//
// THE ONCE CALLS (`onceBooking`): only retrieval (communication/retrieval.js) and the outer loop used to book; title, target,
// compaction, classification, extraction, verdicts, service detection … consumed invisibly. Every runOnce place now carries
// `atConsumption: onceBooking("<role>", chatId)` with a role from ONCE_ROLES of the contract (account/usage-contract.js); the row has
// `source = 'once'` and `agent_id = <role>`. Guard server/backend/test/once-consumption.test.js (by source text).

import * as store from "../store.js";
import { subscriptionBooking, bookingCounts, meteredBooking } from "../providers/connectors/consumption.js";

// A part is to be booked if it carries tokens — or generation ids without tokens: the ONLY round of an OpenRouter run broke off
// after the response head (user stop, network). OpenRouter billed it; the row (0 tokens, amount NULL, the ids) is the only way the
// tick asks for the amount (account/openrouter-inquiry.js). A part without tokens and without an id has no trace: booked, the tick
// would "estimate" it at the catalog price of 0 tokens as 0 USD — a wrong number.
export const withGenerations = (t) => Array.isArray(t?.generations) && t.generations.length > 0;
const bookable = (t) => Boolean(t && (t.input || t.output || t.cached || withGenerations(t)));

/**
 * Book a turn's consumption. `assignment`: `{ chatId, runId?, step?, secs }` (the workflow assignment from the RUN START);
 * `res`: the result of runChat; `tally`: the event stream's counter; `providerId`/`model`: the run; `runBegin`: the
 * `started_at` of its active_runs row (see below). Never throws — the booking must not disturb a run.
 *
 * With the booking, in the SAME synchronous step, the active_runs row loses its session: otherwise only doRun's finally cleared the
 * row, and awaits lay in between (maybeAutoContinue at the limit, the instance check) — if the process died there, the restart
 * found session and `started_at` and booked the same turn a second time (runs/lateBooking.js). Only the row of THIS turn
 * (`started_at` = `runBegin`): a retry has its own.
 */
export function bookTurn({ assignment, res, tally, providerId, model = "", runBegin = null }) {
  try { bookTurnRows({ assignment, res, tally, providerId, model }); }
  catch (e) { console.error("[usage] turn not booked:", e?.message || e); }
  // Also after a throw: the turn is over (there is `res`) — a late booking from its session would now be wrong in every case.
  if (assignment?.chatId && runBegin) {
    try { store.setActiveRunSession(assignment.chatId, { session: "", provider: "", model: "" }, { startedAt: runBegin }); } catch { /* without the column */ }
  }
}

function bookTurnRows({ assignment, res, tally, providerId, model }) {
  const u = res?.usage;
  const parts = !u ? [] : Array.isArray(u.parts) && u.parts.length
    ? u.parts
    : [{ provider: providerId, model: u.model || model, kind: "main", input: u.input || 0, output: u.output || 0,
      cached: u.cached || 0, cacheWrite: u.cacheWrite || 0, cost: u.cost ?? null, upstream: u.upstream || "", generations: u.generations }];
  if (u && (u.input || u.output || parts.some(bookable))) {
    let secsLeft = assignment.secs; // count runtime only ONCE per run
    for (const part of parts) {
      if (!bookable(part)) continue;
      store.addUsageEvent({
        ...assignment,
        provider: part.provider || providerId,
        model: part.model || u.model || model,
        ...meteredBooking(part),
        kind: part.kind === "sub" ? "sub" : "main",
        secs: secsLeft,
        upstream: part.upstream || "",
      });
      secsLeft = 0;
    }
    return;
  }
  for (const [kind, t] of [["main", tally?.main], ["sub", tally?.sub]]) {
    if (!t || (!t.input && !t.output && !t.cached)) continue;
    store.addUsageEvent({
      ...assignment,
      provider: providerId,
      model: model,
      ...subscriptionBooking(t),
      kind,
      secs: kind === "main" ? assignment.secs : 0,
    });
  }
}

/** Record the running turn's session in its `active_runs` row (see header). Never throws. */
export function rememberTurnSession(chatId, { session, provider, model = "" }) {
  if (!chatId || !session) return;
  try { store.setActiveRunSession(chatId, { session, provider, model }); } catch { /* without the column: no late booking, the run goes on */ }
}

/**
 * The `atConsumption` callback of a once call (see header): books the report (providers/index.js runOnce → reportConsumption) as a
 * row with `source = 'once'`, `agent_id = role`, at the chat that triggered the call ("" = none — a deposit, a scan).
 * Never throws (reportConsumption catches anyway).
 */
export function onceBooking(role, chatId = "") {
  return (v) => {
    if (!v || !v.provider) return;
    try {
      store.addUsageEvent({
        provider: v.provider, model: v.model || "",
        ...bookingCounts(v),
        upstream: v.billing === "metered" ? v.upstream || "" : "",
        chatId: chatId ? String(chatId) : "", source: "once", agentId: String(role || ""),
      });
    } catch (e) { console.error(`[usage] once call "${role}" not booked:`, e?.message || e); }
  };
}
