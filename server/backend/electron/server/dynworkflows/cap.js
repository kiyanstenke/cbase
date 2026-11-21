// Concurrency of dynamic workflows. A run may carry up to 1000 agent() calls; at any time only as many run as the two
// caps below allow AND memory permits (the storage gate, below):
//
//   • cap per RUN:   fixed 8 (`RUN_CAP_DEFAULT`). It does not depend on the core count: inside a user container Node
//     reports a misleading number (the container is limited by a CPU weight libuv does not read).
//   • cap per USER:  across ALL workflows of this server — in container operation those of one user container, without
//     containers those of the one server. Setting `dyn_workflow_user_cap` (web and iOS), default 8.
//
// Surplus calls WAIT (journal entry "waiting" with the reason "cap" and the cap that holds) and start as soon as a slot
// frees up — in call order: there is ONE queue across all runs, first in first out; an entry held only by the cap of
// ITS run does not hold up those of other runs. The run computes the key chain at the call (journal.js), not at the
// start — a waiting call does not change it.
//
// The STORAGE GATE: before a waiting call gets a free slot, distribute() asks the same gate as the graph workflows
// (workflows/storage-gate.js storageSituation — container above 80 % of its limit, measured as memory.current −
// inactive_file, or host below 20 % free; on a Mac without cgroup and meminfo always open), at most ONCE per pass.
// Closed ⇒ the entry waits with the reason "storage" (callback `waitingForStorage` with the text of the situation), and
// nobody BEHIND it starts, even if the gate is open a moment later — otherwise a new call would overtake the waiting
// ones (FIFO). Every entry that would get a slot without the gate is marked; whoever a cap holds keeps waiting for the
// cap. Storage waiters are released ONLY by the shared arbiter (workflows/storage-queue.js, source "dyn-workflows" =
// `storageCandidates`, registered in server.js): at most ONE per pass, the oldest — across graph starts, copies,
// detection, setup, instance starts AND workflow agents together, otherwise the waiting ones would fill the freed
// memory all at once. It is woken by the tick (server.js, `graphTickMs`, default 30 s) and here at the end of every
// agent (`storageQueueSoon` in the release function — a process ended, the most likely moment for memory to free up).
// After a tight phase the number of running agents therefore rises by one per pass. RESIDUAL RISK: agents that get a
// slot in the same pass (a run calls eight agent() at once) see the same measurement — their memory only arrives with
// the process; the graph starts behave the same way. A slot without a process (a parked agent continues, run.js)
// does not ask the gate (`storage: false`) and does not wait behind storage waiters, only behind the caps — the process
// is already running and has to be counted.
//
// These caps are NOT the cap of 20 subagents per chat (runs/agents.js agentCap): a workflow agent lives in a core of
// its own that does not belong to the chat (not counted there), and a `cbase_agent` never arrives here. Two counters
// that do not occupy each other.
//
// Plus prompt-cache staggering: agents with the same prefix (provider, model, agent type — system prompt and tools are
// then identical) start staggered so that the first writes the cache and the rest read it: the first at once, the rest
// as soon as it delivers its first event, at the latest after the stagger deadline (default 5 s). Only for providers
// with a prefix cache (`caps.prefixCache`) — without one, waiting only costs time.
//
// Three knobs (environment, read at call time — `runCap`, `userCapDefault`, `staggerMs` below; gate values in
// tools/check/targets/check.mjs): the cap per run instead of the default 8, the default of the cap per user (as long
// as none is set) and the stagger deadline in ms (0 = no staggering).
//
// A leaf except for the data layer (store.js) and the two leaves of the storage gate (workflows/storage-gate.js, only
// node:fs and i18n; workflows/storage-queue.js without imports).
import * as store from "../store.js";
import { storageQueueSoon } from "../workflows/storage-queue.js";
import { storageSituation } from "../workflows/storage-gate.js";

export const RUN_CAP_DEFAULT = 8;
export const USER_CAP_DEFAULT = 8;
export const USER_CAP_MAX = 64;
export const USER_CAP_SETTING = "dyn_workflow_user_cap";
export const STAGGER_MS_DEFAULT = 5000;

const whole = (w, min) => {
  if (w === undefined || w === null || w === "") return null;
  const n = Number(w);
  return Number.isInteger(n) && n >= min ? n : null;
};

export const runCap = () => whole(process.env.CBASE_DYNWF_RUN_CAP, 1) ?? RUN_CAP_DEFAULT;
export const userCapDefault = () => whole(process.env.CBASE_DYNWF_USER_CAP, 1) ?? USER_CAP_DEFAULT;
export const staggerMs = () => whole(process.env.CBASE_DYNWF_STAGGER_MS, 0) ?? STAGGER_MS_DEFAULT;

/** The cap per user in effect now: the configured one, otherwise the default. */
export function userCap() {
  return whole(store.getSetting(USER_CAP_SETTING, ""), 1) ?? userCapDefault();
}

// The kinds of cap that hold a waiting call — the value `cap` in the journal (`runSlots` → `waiting`) and the keys of
// the numbers on the progress tree (tree.js). The numbers are built from THIS list, not as an object literal: a
// property `user:` with a computed value looks like a user argument to `commandRun` to the root guard
// (in-project-start-places.test.js) — rightly so, it cannot see the value.
export const CAP_KINDS = ["run", "user"];
const COUNT_PER_KIND = new Map([["run", runCap], ["user", userCap]]);
/** The numbers of both caps in effect NOW — per kind from `CAP_KINDS`. */
export const capCountsNow = () => Object.fromEntries(CAP_KINDS.map((kind) => [kind, COUNT_PER_KIND.get(kind)()]));

/**
 * Set the cap per user. A missing field is not a statement: `undefined`/`null` ⇒ error.
 * @returns {{ ok: true, cap: number } | { ok: false, error: string }}
 */
export function setUserCap(value) {
  if (value === undefined || value === null) return { ok: false, error: "missing" };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > USER_CAP_MAX) return { ok: false, error: "invalid" };
  store.setSetting(USER_CAP_SETTING, String(n));
  distribute(); // a larger cap releases waiting calls at once
  return { ok: true, cap: n };
}

// ── The slots ──────────────────────────────────────────────────────────────────────────────────────────────────
// Module state like the run maps in runs/state.js: one server, one user (container) or one app.
const occupiedPerRun = new Map(); // runId → number of occupied slots
let occupiedTotal = 0;
// [{ runId, resolve, since, storage, atStorage, reportStorage }] — first in first out across all runs. `storage`: the
// slot starts a process (asks the gate); `atStorage`: waiting for memory — only the arbiter releases it.
const queue = [];

const occupiedOf = (runId) => occupiedPerRun.get(runId) || 0;

// ONE pass over the queue. `fromStorage` (only from the arbiter, `storageCandidates`): at most ONE storage waiter may
// start when the gate is open. Returns whether one started out of the storage wait.
function distribute({ fromStorage = false } = {}) {
  const run = runCap();
  const user = userCap();
  let situation = null;
  const gateOpen = () => (situation ??= storageSituation()).free;
  let held = false; // from here on nobody starts in this pass — the rest wait behind the storage gate
  let startedFromStorage = false;
  const keptReady = new Map(); // runId → slots the held entries of this pass would occupy
  let total = occupiedTotal;
  for (let i = 0; i < queue.length && total < user;) {
    const w = queue[i];
    if (occupiedOf(w.runId) + (keptReady.get(w.runId) || 0) >= run) { i += 1; continue; }
    if (!held && w.storage) held = w.atStorage ? !fromStorage || startedFromStorage || !gateOpen() : !gateOpen();
    if (held && w.storage) {
      // Would get a slot but waits for memory (or behind one that does): mark it, only reserve the slot.
      // A slot without a process (`storage: false`) passes the storage lock — but not the reserved slots.
      if (!w.atStorage) {
        w.atStorage = true;
        w.reportStorage?.((situation ??= storageSituation()).reason);
      }
      keptReady.set(w.runId, (keptReady.get(w.runId) || 0) + 1);
      total += 1;
      i += 1;
      continue;
    }
    if (w.atStorage) startedFromStorage = true;
    queue.splice(i, 1);
    occupiedPerRun.set(w.runId, occupiedOf(w.runId) + 1);
    occupiedTotal += 1;
    total += 1;
    w.resolve(true);
  }
  return startedFromStorage;
}

/**
 * The source "dyn-workflows" of the shared arbiter (workflows/storage-queue.js, registered in server.js): ONE
 * candidate for the whole queue, `alt` = call time of the oldest storage waiter; `attempts()` releases at most one
 * (distribute with `fromStorage`) — `{ started: true }` only if one started out of the storage wait.
 */
export function storageCandidates() {
  const first = queue.find((w) => w.atStorage);
  if (!first) return [];
  return [{ waitingSince: first.since, storage: true, attempts: () => ({ started: distribute({ fromStorage: true }) }) }];
}

/** Status for the UI and the tests: occupied per run and in total, waiting in total, of those at the storage gate. */
export function capStatus() {
  return { total: occupiedTotal, perRun: Object.fromEntries(occupiedPerRun), waiting: queue.length,
    atStorage: queue.filter((w) => w.atStorage).length, runCap: runCap(), userCap: userCap() };
}

/**
 * The slots of ONE run.
 *   request({ waiting, waitingForStorage, storage }) → Promise<release | null>: `release()` (idempotent) returns the
 *     slot; `null` when the run was closed before a slot freed up. If the call does not get a slot at once, it reports
 *     SYNCHRONOUSLY `waiting(cap)` with "run" or "user" — the cap that holds it — or `waitingForStorage(reason)` (the
 *     text of the situation, empty when it merely stands behind a storage waiter); a call waiting for a cap that the
 *     gate holds later reports `waitingForStorage` at the transition, once. `storage: false` (default true): the slot
 *     starts no process and does not ask the gate.
 *   close(): waiting calls drop out (their promise yields null), occupied slots are returned. Idempotent.
 */
export function runSlots(runId) {
  let closed = false;
  const own = new Set(); // release functions of occupied slots
  const waiting = new Set(); // entries in the queue

  const spaceFor = () => {
    let free = false;
    const approve = () => {
      if (free) return;
      free = true;
      own.delete(approve);
      const n = occupiedOf(runId) - 1;
      if (n > 0) occupiedPerRun.set(runId, n); else occupiedPerRun.delete(runId);
      occupiedTotal -= 1;
      distribute();
      // An agent ended — the most likely moment for memory to free up: wake the arbiter.
      if (queue.some((w) => w.atStorage)) storageQueueSoon();
    };
    own.add(approve);
    return approve;
  };

  return {
    request({ waiting: waiting2, waitingForStorage, storage = true } = {}) {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const entry = { runId, since: Date.now(), storage: storage !== false, atStorage: false, reportStorage: waitingForStorage,
          resolve: (ok) => { waiting.delete(entry); resolve(ok ? spaceFor() : null); } };
        waiting.add(entry);
        queue.push(entry);
        distribute();
        if (waiting.has(entry) && !entry.atStorage) waiting2?.(occupiedOf(runId) >= runCap() ? "run" : "user");
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const e of [...waiting]) {
        const i = queue.indexOf(e);
        if (i >= 0) queue.splice(i, 1);
        e.resolve(false);
      }
      for (const f of [...own]) f();
    },
  };
}

// ── Staggering ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The stagger of one run. `before(key, n, { prefixCache })` → `null` (start at once) or a promise that resolves when
 * the first of this prefix delivers its first event (`firstEvent(n)`), ends (`end(n)`) or the deadline passes. The
 * first of a prefix and every agent of a provider without a prefix cache start at once, as do all with deadline 0.
 * `close()` resolves all waiting calls and clears the clocks (no timer remains).
 */
export function createStagger({ ms = staggerMs() } = {}) {
  const groups = new Map(); // key → { first, open, resolve, free, clock }
  const resolve = (g) => {
    if (!g.open) return;
    g.open = false;
    if (g.clock) clearTimeout(g.clock);
    g.clock = null;
    g.resolve();
  };
  const ofFirst = (n) => [...groups.values()].filter((g) => g.first === n);
  return {
    before(key, n, { prefixCache = false } = {}) {
      if (!prefixCache || !(ms > 0)) return null;
      const g = groups.get(key);
      if (!g) {
        const fresh = { first: n, open: true, resolve: null, free: null, clock: null };
        fresh.free = new Promise((r) => { fresh.resolve = r; });
        fresh.clock = setTimeout(() => resolve(fresh), ms);
        fresh.clock.unref?.();
        groups.set(key, fresh);
        return null;
      }
      return g.open ? g.free : null;
    },
    firstEvent(n) { for (const g of ofFirst(n)) resolve(g); },
    end(n) { for (const g of ofFirst(n)) resolve(g); },
    close() { for (const g of groups.values()) resolve(g); },
  };
}
