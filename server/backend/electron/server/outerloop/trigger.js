// The TRIGGERS of the outer loop: when an agent runs on a chat — the run itself is driven by run.js. Registered in
// server.js (hook registry, tick in the listen callback); `runs/` does not know this folder.
//
//   run_end     subscriber of the hook kinds `end` AND `turnEnd` (runs/do-run.js — no new line there), name "outer-loop",
//               synchronous: one run per active agent with this kind (not awaited). SELF-WAKE LOCK: not for a turn whose
//               latest row of role `user` is a message of kind `outer_loop` (runs/message-marker.js) — otherwise the
//               outer loop would write, the turn end, the outer loop write … without end. Quiet, interval and clock times
//               still see this turn.
//   quiet       the same two subscribers arm a timer (agent, chat) per active agent with quiet (`minutes × 60 s`,
//               re-arming replaces). On expiry: if the chat runs or a row arrived since arming ⇒ re-arm, else a run.
//               The restart grace re-creates resting timers from the database (remainder from the chat's last row).
//   interval,   the tick (`setInterval(outerLoopTick, OUTER_LOOP_TICK_MS())` in server.js): per effective agent the chats
//   clockTime   with something new above the watermark (store.outerLoopChatsWithNew) → activation → due? Interval: at
//               least `minutes` since the last start of the pair. Clock time: one of the times (zone of the workspace)
//               lies between the last start of the pair with trigger `clockTime` (else the agent's last change or the
//               start of the activation) — and not before the previous pass of this server run, unless an open run
//               deferred it — and now; after a start a missed one runs ONCE at the next tick. A clock time at which the
//               chat carried nothing new is consumed ("only on chats with something new"). The tick also continues parked
//               runs whose time has come (safety net).
//   follow-up   run.js.
//
// The agenda keeper ("start only in a quiet chat"): NO trigger starts a run while agenda/upkeep.js upkeepQuietReason names
// a reason (turn, compaction, queued input, background work, open question). Quiet ⇒ re-arm the timer as for a running
// chat; interval ⇒ no start, nothing consumed (the last start stands, the next tick checks again); clock time ⇒ deferred
// as with an open run; "after every run end" ⇒ no start, without an own check here: an abort has no side effect there, the
// check in run.js startOuterLoopRun (before any row, synchronous) suffices. The same check catches follow-up and wakeup.
// Why: a run that only failed on writing with 409 would end `finished` and push the watermark past the history it was
// meant to catch up on; one that started mid-turn would then write on half a history.
//
// Abort: outerLoopAborter({ agentIds }) — set in server.js via outerloop/abort.js setOuterLoopAborter — and the hook
// "chatClosed" silence the cores and take timers and markers. Test seams: outerLoopQuietNow, outerLoopQuietCount,
// outerLoopTickNow(now), outerLoopWakeParkedNow (run.js). Tests wait for a row or an event, never for a deadline.

import * as store from "../store.js";
import { running } from "../runs/state.js";
import { readMessage } from "../runs/message-marker.js";
import { nextCronAtZone } from "../cron.js";
import { timeZoneDefault } from "../workspaces/timeZone.js";
import { activeAgentsFor, activation, effective } from "./activation.js";
import {
  OUTER_LOOP_ROLES, outerLoopParkedDue, wakeParkedOuterLoop, outerLoopCoresSilence, outerLoopRunsAtStart,
  outerLoopRunAtServerEnd, pairOpen, keeperWaiting, startOuterLoopRun,
} from "./run.js";

/** The tick for interval and clock times (ms): `CBASE_OUTER_LOOP_TICK_MS`, at least 200, default 60 s. */
export const OUTER_LOOP_TICK_MS = () => Math.max(200, Number(process.env.CBASE_OUTER_LOOP_TICK_MS) || 60_000);

const key = (agentId, chatId) => `${agentId}|${chatId}`;
const clocks = new Map(); // pair → { agentId, chatId, lastId, t, fn }
let closed = false;

const kind = (agent, a) => (agent?.trigger || []).find((x) => x?.kind === a) || null;

function start(agent, chat, trigger) {
  startOuterLoopRun({ agent, chat, trigger }).catch((e) => console.error(`[outer-loop] ${trigger}:`, e?.message || e));
}

// Is the latest row of role `user` a message of an outer loop agent? (Only asked if an agent with "after every run end"
// is active.)
function selfWoken(chatId) {
  const rows = store.listMessages(chatId);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role !== "user") continue;
    return readMessage(rows[i].text)?.kind === "outer_loop";
  }
  return false;
}

// ── Quiet ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function clockFrom(k) {
  const e = clocks.get(k);
  clocks.delete(k);
  if (e) clearTimeout(e.t);
}

/** Arm a quiet timer (agent, chat) — a standing one is replaced. `ms` = the waiting time. */
function quietArm(agentId, chatId, ms) {
  if (closed) return;
  const k = key(agentId, chatId);
  clockFrom(k);
  const e = { agentId, chatId, lastId: Number(store.messageStats(chatId)?.lastId) || 0, t: null, fn: null };
  e.fn = () => quietExpired(k, e);
  e.t = setTimeout(e.fn, Math.min(Math.max(0, ms), 2 ** 31 - 1));
  e.t.unref?.();
  clocks.set(k, e);
}

function quietExpired(k, e) {
  if (clocks.get(k) !== e || closed) return;
  clocks.delete(k);
  const agent = store.outerLoopAgent(e.agentId);
  const chat = store.getChat(e.chatId);
  const quiet = kind(agent, "quiet");
  if (!agent || !chat || !quiet || !activation(agent, chat).active) return;
  // The chat is not quiet: it runs, or a row arrived since arming — re-arm. For the agenda keeper also every reason of the
  // quiet check of its write path (open question, background work, queued input).
  if (running.has(chat.id) || keeperWaiting(agent, chat.id) || (Number(store.messageStats(chat.id)?.lastId) || 0) > e.lastId) {
    quietArm(agent.id, chat.id, quiet.minutes * 60_000);
    return;
  }
  start(agent, chat, "quiet");
}

// ── Hook subscribers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Subscriber of `end` and `turnEnd` (name "outer-loop", synchronous): "after every run end" and the quiet timers. */
export function outerLoopEndHook(payload = {}) {
  if (closed || !payload?.chat?.id) return;
  const chat = store.getChat(payload.chat.id);
  if (!chat) return;
  const active = activeAgentsFor(chat);
  if (!active.length) return;
  let itself = null;
  for (const { agent } of active) {
    if (kind(agent, "run_end")) {
      if (itself === null) itself = selfWoken(chat.id);
      if (!itself) start(agent, chat, "run_end");
    }
    const quiet = kind(agent, "quiet");
    if (quiet) quietArm(agent.id, chat.id, quiet.minutes * 60_000);
  }
}

/** Subscriber of `chatClosed` (every delete path, BEFORE the rows are deleted): cores silenced, timers and markers gone. */
export function outerLoopChatClosed({ chatId } = {}) {
  if (!chatId) return;
  outerLoopCoresSilence({ chatId: String(chatId) });
  for (const k of [...clocks.keys()]) if (k.endsWith(`|${chatId}`)) clockFrom(k);
}

/**
 * The aborter (outerloop/abort.js setOuterLoopAborter): cores of the runs of these agents silenced, timers and markers gone
 * — or only the cores of exactly these runs (deleting a project; their timers stay, the chats fall anyway).
 */
export function outerLoopAborter({ agentIds = [], runIds = [] } = {}) {
  const ids = new Set((agentIds || []).map(String));
  const lids = (runIds || []).map(String).filter(Boolean);
  if (lids.length) outerLoopCoresSilence({ runIds: lids });
  if (!ids.size) return;
  outerLoopCoresSilence({ agentIds: [...ids] });
  for (const k of [...clocks.keys()]) if (ids.has(k.split("|")[0])) clockFrom(k);
}

/**
 * Subscriber of `restartGrace` (name "outer-loop", after "dyn-workflows"): re-create the wakeups of parked runs; per active
 * pair with quiet and something new since the last finished run, that is not running, a timer with the remainder from the
 * chat's last row.
 */
export function outerLoopRestartGrace() {
  if (closed) return;
  wakeParkedOuterLoop();
  const now = Date.now();
  for (const ws of store.listWorkspaces()) {
    for (const agent of store.outerLoopAgentsOf(ws.id)) {
      const quiet = kind(agent, "quiet");
      if (!quiet || !effective(agent)) continue;
      const ids = store.outerLoopChatsWithNew(ws.id, agent.id, OUTER_LOOP_ROLES);
      if (!ids.length) continue;
      const stats = store.chatStats(ids);
      for (const chatId of ids) {
        const chat = store.getChat(chatId);
        if (!chat || !activation(agent, chat).active || pairOpen(agent.id, chatId)) continue;
        const last = Number(stats.get(chatId)?.lastMessageAt) || now;
        quietArm(agent.id, chatId, Math.max(0, last + quiet.minutes * 60_000 - now));
      }
    }
  }
}

// ── Tick (interval, clock times) ──────────────────────────────────────────────────────────────────────────────────────────────

// Clock times: a clock time applies to the chats that carry something new AT THAT TIME. The tick only sees chats with
// something new — a chat without anything new at 09:00 left no run row, and the next new message at 15:01 would find the
// 09:00 between the last clock-time start and now and run at once. So the tick remembers up to when it has already SEEN the
// clock times (`tickPrior`, per server run): a clock time before the previous pass is consumed — except for a pair whose
// due clock time an open run deferred (`deferred`), which catches up on it. After a start (null) the last clock-time start
// or the creation applies: a clock time a sleeping container missed runs ONCE afterwards.
let tickPrior = null;
const deferred = new Set();

const nextClockTime = (hhmm, from, tz) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return nextCronAtZone(`${m} ${h} * * *`, from, tz);
};

/** One pass of the tick at the time `now`. → number of runs triggered. */
export function outerLoopTick(now = Date.now()) {
  if (closed) return 0;
  let n = outerLoopParkedDue(now);
  const seen = tickPrior;
  for (const ws of store.listWorkspaces()) {
    const agents = store.outerLoopAgentsOf(ws.id).filter((a) => effective(a) && (kind(a, "interval") || kind(a, "clockTime")));
    if (!agents.length) continue;
    const tz = timeZoneDefault(ws.id);
    for (const agent of agents) {
      const iv = kind(agent, "interval");
      const uz = kind(agent, "clockTime");
      const ids = store.outerLoopChatsWithNew(ws.id, agent.id, OUTER_LOOP_ROLES);
      if (!ids.length) continue;
      // The last start per chat — queried per pair, not from a window of the latest runs (a chat behind the 500 latest
      // would count as "never started").
      const starts = store.outerLoopLastStarts(agent.id, ids);
      for (const chatId of ids) {
        const chat = store.getChat(chatId);
        if (!chat) continue;
        const current = activation(agent, chat);
        if (!current.active) continue;
        const k = key(agent.id, chatId);
        const st = starts.get(chatId) || { all: null, clock: null };
        const ivDue = Boolean(iv) && (st.all === null || now - st.all >= iv.minutes * 60_000);
        let uzDue = false;
        if (uz) {
          const base = st.clock ?? Math.max(Number(agent.updatedAt) || 0, Number(current.since) || 0);
          const from = seen === null || deferred.has(k) ? base : Math.max(base, seen);
          uzDue = uz.times.some((z) => { const t = nextClockTime(z, from, tz); return t > 0 && t <= now; });
        }
        if (pairOpen(agent.id, chatId) || keeperWaiting(agent, chatId)) {
          // An open run — the due clock time stays for the next pass. Likewise for the agenda keeper in a chat that is not
          // quiet (an interval consumes nothing anyway: it counts from the last start).
          if (uzDue) deferred.add(k);
          continue;
        }
        if (ivDue) { deferred.delete(k); start(agent, chat, "interval"); n += 1; continue; }
        if (uzDue) { deferred.delete(k); start(agent, chat, "clockTime"); n += 1; }
      }
    }
  }
  tickPrior = tickPrior === null ? now : Math.max(tickPrior, now);
  return n;
}

// ── Server lifetime ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** In the listen callback, synchronous: abort open runs of a dead process, timers of this module fresh. → count. */
export function outerLoopAtStart() {
  closed = false;
  tickPrior = null;
  deferred.clear();
  for (const k of [...clocks.keys()]) clockFrom(k);
  return outerLoopRunsAtStart();
}

/** `server.once("close")`: timers, tick state, cores closed silently; the rows stay (`running` ⇒ aborted at the next start). */
export function outerLoopAtServerEnd() {
  closed = true;
  for (const k of [...clocks.keys()]) clockFrom(k);
  outerLoopRunAtServerEnd();
}

// ── Test seams ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Let every quiet timer expire NOW (as if its minutes were over). → count. */
export function outerLoopQuietNow() {
  const all = [...clocks.values()];
  for (const e of all) { clearTimeout(e.t); e.fn(); }
  return all.length;
}
/** How many quiet timers stand. */
export const outerLoopQuietCount = () => clocks.size;
/** Does a quiet timer stand for the pair? */
export const outerLoopQuietStands = (agentId, chatId) => clocks.has(key(agentId, chatId));
/** Run the tick NOW (with a set clock). */
export const outerLoopTickNow = (now = Date.now()) => outerLoopTick(now);
export { outerLoopWakeParkedNow } from "./run.js";
