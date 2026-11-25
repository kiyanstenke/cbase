// The view of the progress tree: ONE dynamic workflow as header, phases, agents and log() lines — computed from what
// the run stores (the phase per journal entry, the persisted phase()/log() lines, "waiting" with a reason). Pure (only
// import: the leaf journal.js, for the chain of a restart): run.js reads row, journal and events from the database and
// adds the live state of the agents (tokens of a running one, "parked" at the limit) — the route and the event build
// the view with the SAME function, so after a reload the tree shows what it showed live before.
//
// Per agent the view carries `startedAt`/`endedAt` (timestamps of its journal entries) and on the run the
// `description` (meta.description). The client computes the duration from them (web lib/dyn-tree.ts `agentDurationMs`).
//
// Per agent the view carries ONE state word (`agentState`); the client turns it into the display word through the
// bound table (web lib/history-state.ts `journalAgentState`, iOS `HistoryState.journalAgent`). Grouping by phase and
// n/m is computed ONCE by the client's tree calculation (web lib/dyn-tree.ts) — the view delivers the agents with phase
// and state, the phases in their order and the log() lines.
//
// THE RUNNING ATTEMPT. A restart continues THE SAME journal (run.js) — the entries of all attempts follow one another
// in it, without a marker of their own (the journal keeps the baseline's shape). The boundary therefore lives on the
// RUN: `run.attemptFrom` = how many journal and event rows had been written before the latest restart (store
// pickUpDynRun, in read order). The view shows the running attempt:
//   - an agent it (re)started (`launched` behind the boundary), with its entries from THIS `launched` on — state,
//     tokens, time, phase, restarts of this attempt; a `failed` of the aborted attempt no longer counts;
//   - an agent before it only if the restart serves its result from the journal (journal.js `servedFromTheJournal`,
//     the same calculation as the restart's chain): as "finished" with the attempt that brought the result — it is part
//     of the run (in a restart a cache hit writes no row, so it would otherwise never be visible);
//   - every other agent of an earlier attempt drops out: it was aborted (or failed and breaks the prefix), the script
//     has not reached it again yet, and when it does, it starts anew — until then it is neither "running" nor "waiting"
//     nor "error";
//   - phase()/log() only of the running attempt: in a restart the script runs from the top and writes every line that
//     still holds a second time; what only the aborted attempt wrote ("… returned null — Exit 137") no longer holds.
//     Marking instead of dropping would have shown every valid line twice. The output file still carries everything.
// Without a restart the boundary is 0 — the view is the same as before.
//
// THE CAP THAT HOLDS. A waiting agent carries `reason` and, for "cap", the KIND from the journal (`cap`: run · user —
// the cap that held it when it queued up); in addition the RUNNING run carries the NUMBERS of both caps in effect NOW
// (`cap: { run, user }`, passed in by run.js from cap.js — this file stays pure). The client turns that into
// "waiting · 8 at a time" (web lib/dyn-tree.ts `waitText`, iOS `DynTree.waitText`, bound). On an ended run the field is
// missing: nobody waits there (agentState), a number would only be noise in every event.
// RESIDUAL RISK: the kind is the one at queueing time. If the holding cap changes while it waits (its run fills up
// after the per-user cap queued it, or vice versa), the line names the earlier one — the number is right, the kind is
// not. Computing the kind live from cap.js would make the view depend on module state of this server run (after a
// restart a different one than in the journal) — for a case where it still holds: it waits for a slot.
import { servedFromTheJournal } from "./journal.js";

/** The event in the chat's stream (harness subtype). Not "workflow…": `workflow_run` and `kind: "workflow"` are the graph. */
export const TREE_EVENT = "dynwf_tree";
/** A header carries this many log() lines — the newest. Whoever truncates says so (`logsTruncated`). */
export const LOG_CAP = 200;
/** A chat shows this many runs — the newest. Whoever truncates says so. */
export const RUNS_CAP = 20;

const RUN_END = new Set(["finished", "stopped", "failed", "interrupted"]);

// The entries of one `n` from its LAST `launched` on — its newest attempt. An agent() call writes exactly one `launched`
// per attempt (a restart by the human or the stall guard writes none, a server restart one); without `launched` all.
function fromLastStart(entries) {
  let from = -1;
  entries.forEach((e, i) => { if (e.kind === "launched") from = i; });
  return from > 0 ? entries.slice(from) : entries;
}

/**
 * The state of ONE agent() call from its journal entries (journal order) — read from its last `launched` on: a restart
 * starts it anew, and a `result`/`failed` of the aborted attempt is not its state.
 *   finished · error · skipped (a failed one with the marker `skipped` — in the journal skipping still counts as
 *   failed) · stopped (the whole run was stopped before it had a result) · running · waiting (no slot, stagger or
 *   parked at the usage limit) · without-result (the run is over, a result never came).
 * @param {Object[]} all  journal entries of this `n`
 * @param {{ runStatus: string, live?: { status?: string } | null }} o
 */
export function agentState(all, { runStatus, live = null }) {
  const entries = fromLastStart(all);
  const last = [...entries].reverse().find((e) => e.kind === "result" || e.kind === "failed") || null;
  if (last?.kind === "result") return "finished";
  if (last?.kind === "failed") return last.skipped ? "skipped" : (runStatus === "stopped" ? "stopped" : "error");
  if (RUN_END.has(runStatus)) return runStatus === "stopped" ? "stopped" : "without-result";
  if (live?.status === "parked") return "waiting";
  const started = entries.some((e) => e.kind === "started");
  if (started) return "running";
  return entries.some((e) => e.kind === "waiting") ? "waiting" : "running";
}

// The boundary of the running attempt in read order (see header), clamped to the rows read.
const limitIn = (count, length) => Math.min(Math.max(0, Math.floor(Number(count) || 0)), length);

// Per `n` the entries of the attempt the view shows — or none (see header, "The running attempt"). `[n, entries]` in
// call order.
function shownAttempts(journal, fromJ) {
  const perN = new Map(); // n → [{ e, i }] (i = position in the journal)
  journal.forEach((e, i) => {
    // n 0: a run-level entry (a message noted for an agent not called yet, dynworkflows/message.js) — no agent of the tree.
    if (!(Number(e.n) > 0)) return;
    if (!perN.has(e.n)) perN.set(e.n, []);
    perN.get(e.n).push({ e, i });
  });
  // What the restart serves from the journal — computed over exactly the entries it read (those before the boundary).
  const served = fromJ ? servedFromTheJournal(journal.slice(0, fromJ)) : new Set();
  const out = [];
  for (const [n, list] of [...perN.entries()].sort((a, b) => a[0] - b[0])) {
    const starts = list.filter((x) => x.e.kind === "launched");
    const inRunning = !fromJ || (starts.length ? starts.at(-1).i >= fromJ : list.some((x) => x.i >= fromJ));
    if (inRunning) { out.push([n, fromLastStart(list.map((x) => x.e))]); continue; }
    if (!served.has(n)) continue; // aborted or failed, not (yet) started again by the running attempt
    // Served from the journal: the attempt that brought its result (the last `result`, like statusPerKey), from the
    // `launched` before it.
    const before = list.filter((x) => x.i < fromJ).map((x) => x.e);
    const r = before.findLastIndex((e) => e.kind === "result");
    if (r < 0) continue;
    const s = before.slice(0, r + 1).findLastIndex((e) => e.kind === "launched");
    out.push([n, before.slice(Math.max(0, s), r + 1)]);
  }
  return out;
}

/**
 * The view of one run.
 * @param {{ run: Object, journal: Object[], events: Object[], live?: Map<string, Object> }} o
 *        `run` the row (store mapRun, with `attemptFrom` — the boundary of the running attempt), `journal`
 *        readDynJournal, `events` readDynEvents, `live` agentId → public record of the core (tokens, tokenKind,
 *        tokenParts, status) — only while the run lives in this server run.
 * @param {{ run?: number, user?: number } | null} [o.cap]  the caps in effect now (cap.js runCap/userCap) — only on a
 *        running run in the view, each number only a whole one ≥ 1 (see header, "The cap that holds").
 */
export function treeView({ run, journal, events, live = new Map(), cap = null }) {
  const fromJ = limitIn(run.attemptFrom?.journal, journal.length);
  const fromE = limitIn(run.attemptFrom?.events, events.length);
  const attempts = shownAttempts(journal, fromJ);
  const agents = attempts.map(([n, es]) => {
    const start = es.find((e) => e.kind === "launched") || {};
    const agentId = [...es].reverse().find((e) => e.agentId)?.agentId || "";
    const end = [...es].reverse().find((e) => e.kind === "result" || e.kind === "failed") || null;
    const wait = [...es].reverse().find((e) => e.kind === "waiting") || null;
    const rec = agentId ? live.get(agentId) || null : null;
    const status = agentState(es, { runStatus: run.status, live: rec });
    const tokens = rec && !end ? rec.tokens : end?.tokens;
    const tokenKind = rec && !end ? rec.tokenKind : end?.tokenKind;
    const tokenParts = rec && !end ? rec.tokenParts : end?.tokenParts;
    // Restarts by the human (run.js restartDynAgent) — visible so that a second attempt does not look like the first.
    const restarts = es.filter((e) => e.kind === "restart").length;
    // The agent's time: from the FIRST start of its process IN the shown attempt (`started` — not `launched`: waiting
    // for a slot lies in between) to its end. A restart by human or stall guard and continuing after parking write
    // another `started`, the time still counts from the first; a server restart does not: there the agent begins from
    // the top, with a `launched` of its own. No `started` (result from a predecessor's journal, failed before the
    // start) ⇒ no `startedAt`.
    const start1 = es.find((e) => e.kind === "started");
    return {
      n,
      label: typeof start.label === "string" ? start.label : "",
      phase: es.find((e) => e.phase !== null && e.phase !== undefined)?.phase ?? null,
      status,
      // What a waiting agent waits for (cap · stagger · limit when parked at the usage limit · credit-gate · project ·
      // storage) and, for "cap", the kind from the journal (run · user) — the number lives on the run.
      ...(status === "waiting" ? { reason: rec?.status === "parked" ? "limit" : (wait?.reason || ""), ...(wait?.cap ? { cap: wait.cap } : {}) } : {}),
      provider: start.provider || "",
      model: start.model || "",
      effort: start.effort || "",
      agentId,
      ...(typeof tokens === "number" ? { tokens } : {}),
      ...(tokenKind ? { tokenKind } : {}),
      ...(tokenParts && typeof tokenParts === "object" ? { tokenParts } : {}),
      ...(end?.fromCache ? { fromCache: true } : {}),
      ...(restarts ? { restarts } : {}),
      ...(typeof start.workflow === "string" ? { workflow: start.workflow } : {}),
      ...(typeof start1?.at === "number" ? { startedAt: start1.at } : {}),
      ...(typeof end?.at === "number" ? { endedAt: end.at } : {}),
    };
  });
  // The phases in their order: first those from meta (so the header also knows the ones still to come), then every
  // further one as it appears in the run (phase() lines and the agents' phase).
  const phases = [];
  const remember = (t) => { if (typeof t === "string" && t && !phases.includes(t)) phases.push(t); };
  for (const p of Array.isArray(run.meta?.phases) ? run.meta.phases : []) remember(p?.title);
  // Only the phase()/log() lines of the running attempt and the `launched` of the shown agents (see header).
  const now = events.slice(fromE);
  const temporal = [...now.filter((e) => e.kind === "phase").map((e) => ({ at: e.at, t: e.text })),
    ...attempts.flatMap(([, es]) => es.filter((e) => e.kind === "launched")).map((e) => ({ at: e.at, t: e.phase }))].sort((a, b) => a.at - b.at);
  for (const z of temporal) remember(z.t);
  const phaseEvent = [...now].reverse().find((e) => e.kind === "phase");
  const logs = now.filter((e) => e.kind === "log").map((e) => ({ text: e.text, phase: e.phase, at: e.at }));
  // The size warning belongs to the run, not to an attempt — the newest one (a restart recomputes it and may repeat it).
  const warning = [...events].reverse().find((e) => e.kind === "warning");
  return {
    runId: run.runId,
    taskId: run.taskId,
    name: run.name,
    status: run.status,
    stoppedOf: run.stoppedOf || "",
    error: run.error || "",
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    // meta.description of the script (script.js: required) — the paragraph below the header; empty where meta has none.
    description: typeof run.meta?.description === "string" ? run.meta.description : "",
    phase: phaseEvent?.text ?? null,
    phases,
    agents,
    logs: logs.slice(-LOG_CAP),
    logsTruncated: Math.max(0, logs.length - LOG_CAP),
    ...(warning ? { warning: warning.text } : {}),
    ...capCounts(run.status, cap),
  };
}

// The cap numbers for the view (see header): only on a running run, each number only a whole one ≥ 1 — what is missing
// stays missing (the client then says "waiting for a free slot" without a number instead of inventing one).
const wholeNumber = (x) => Number.isInteger(x) && x >= 1;
function capCounts(status, cap) {
  if (status !== "running" || !cap || typeof cap !== "object") return {};
  // The keys are the kinds from cap.js (`capCountsNow`) — this file stays pure and takes them as they come.
  const d = Object.fromEntries(Object.entries(cap).filter(([, n]) => wholeNumber(n)));
  return Object.keys(d).length ? { cap: d } : {};
}
