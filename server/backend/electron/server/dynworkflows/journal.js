// The key chain of a dynamic workflow's journal and resuming from an old journal.
//
// Key per agent() call as in Claude Code:
//   `v2:` + sha256(previous state of the LANE ‖ \0 ‖ prompt ‖ \0 ‖ normalised options)
// normalised options = schema, model, effort, isolation, agentType, disallowedTools, bashCommandClamp as JSON with
// RECURSIVELY sorted keys; a call without options is `{}` (label and phase are NOT part) — `chainOptions`, the
// baseline's calculation, checked against a real Claude Code journal (server/backend/test/fixtures/
// dynworkflows-journal/<pin>/, dynworkflows-journal.test.js). cbase deviation, additive and as a step of its own
// BEFORE that (`normOptions`): `model` takes the RESOLVED `provider::model`, plus `repo` — otherwise a provider switch
// would hit the cache. Claude Code uses the value as the script writes it, or none at all; against the fixture only the
// chain calculation itself can therefore match.
//
// TWO CHAIN KINDS:
//   "linear"   — the calculation up to Claude Code 2.1.296: ONE chain across all agent() in call order. It remains as
//                the FALLBACK: a journal written linearly resumes linearly (restart after deploy, resumeFromRunId).
//   "branches" — the calculation since 2.1.322, read from the binary: every LANE carries its own state `prev` (root:
//                ""). parallel()/pipeline() FORK the lane they are called in — synchronously at the call, before the
//                first await:
//                  before = lane.prev;  lane.prev = Z(before, variety, "fork")     variety = "parallel" | "pipeline"
//                  slot i (one thunk, or ONE pipeline item across all stages):  { prev: Z(before, variety, "slot:i") }
//                  after all slots ended:  lane.prev = Z(lane.prev, variety, "join" ‖ per slot \0 ‖ its prev)
//                with Z(a, variety, x) = sha256(a ‖ \0 ‖ variety ‖ \0 ‖ x) as hex WITHOUT `v2:`. The join computes on
//                the state the lane has THEN (an agent() next to a parallel() that was not awaited has moved it on); an
//                empty list or a malformed call forks but never joins (as in the baseline). An agent() computes on its
//                lane as before and sets the lane's state to its key. Without parallel()/pipeline() both kinds are
//                equal.
//                "REPLACED": if an agent() runs LIVE although its key already had an end in the old journal (result,
//                failed, or a result with a later restart), the lane does not continue on the key after its result but
//                on sha256(key ‖ "\0replaced\0" ‖ agentId) — everything behind it gets new keys, an old result from
//                behind a re-run agent never hits again. Only if the lane still stands on the key. The result then
//                carries `replaced: <agentId>`, and a hit on such a result takes the same detour. DEVIATION from the
//                baseline, deliberate: there the reader derives "replaced" from the order of entries (a result for a
//                key that already had an end); cbase writes it onto the result because resumeFromRunId begins a NEW
//                journal in which the predecessor's entries are missing. Equal as long as the lane still stood on the
//                key at the result.
// Which kind a journal speaks is written on EVERY `launched` (`chain`); if the field is MISSING it is "linear" — the ONE
// place for that is `chainKindOf`. A run computes in the kind of the journal it resumes from (the last `launched`
// wins) and keeps writing it: no mixed chains. Without a predecessor (or with a journal without any `launched`):
// `CHAIN_KIND_NEW`.
//
// The chain follows call order, not completion order: the sandbox reports every call and every fork synchronously
// (sandbox.js keeps a call's lane through AsyncLocalStorage like the baseline), and the run computes at once.
//
// Resume: the longest unchanged prefix comes from the old journal — ONE prefix across all lanes, in call order
// (baseline: one flag per run, not per lane). An agent that only started does not break the prefix (it runs anew, the
// following ones may still hit); a failed or skipped one breaks it, as does a new or changed call, and in kind
// "branches" also a result whose agent was started once more afterwards (baseline: "demoted"). "From the cache" only
// means: finished with a result.
//
// For the progress tree the same calculation as a prediction over `n` (`servedFromTheJournal`).
//
// A leaf: only node:crypto.
import crypto from "node:crypto";

export const KEY_VERSION = "v2:";
export const ENTRY_KINDS = Object.freeze(["launched", "started", "result", "failed"]);
// Shape of the baseline (schema.json, resumeFromRunId): ^wf_[a-z0-9-]{6,}$
export const RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;
// The chain kinds (see header). New runs compute `CHAIN_KIND_NEW`.
export const CHAINS_KINDS = Object.freeze(["linear", "branches"]);
export const CHAIN_KIND_NEW = "branches";
// The options the baseline puts into the key (label and phase not). `disallowedTools` and `bashCommandClamp` are in
// the baseline's list since 2.1.296; cbase only takes them up with kind "branches" — the linear calculation stays byte
// for byte the one the old journals were written with (a script with these options would otherwise no longer hit
// them). cbase's agent() does NOT ACT on either (no tool cut per call) — they are only part of the key.
export const BASELINE_OPTIONS = Object.freeze(["schema", "model", "effort", "isolation", "agentType", "disallowedTools", "bashCommandClamp"]);
export const BASELINE_OPTIONS_LINEAR = Object.freeze(["schema", "model", "effort", "isolation", "agentType"]);
// The baseline normalises these two BEFORE the key: a list of names is sorted without duplicates, an empty one is dropped.
const LIST_OPTIONS = Object.freeze(["disallowedTools", "bashCommandClamp"]);
const fieldsThe = (kind) => (kind === "linear" ? BASELINE_OPTIONS_LINEAR : BASELINE_OPTIONS);

export const newRunId = () => `wf_${crypto.randomBytes(6).toString("hex")}`;
export const newTaskId = () => `w${crypto.randomBytes(4).toString("hex")}`;

// JSON with sorted keys, recursively — so that {a,b} and {b,a} give the same key.
function sorted(w) {
  if (Array.isArray(w)) return w.map(sorted);
  if (w && typeof w === "object") return Object.fromEntries(Object.keys(w).sort().map((k) => [k, sorted(w[k])]));
  return w;
}

function optionsJson(opts, fields) {
  const n = {};
  for (const k of fields) {
    let w = opts[k];
    if (LIST_OPTIONS.includes(k) && Array.isArray(w) && w.every((x) => typeof x === "string")) w = w.length ? [...new Set(w)].sort() : undefined;
    if (w !== undefined && w !== null && w !== "") n[k] = w;
  }
  return JSON.stringify(sorted(n));
}

/** The baseline's normalised options — the values as the script writes them. `kind`: the chain kind (default: the new one). */
export const chainOptions = (opts = {}, kind = CHAIN_KIND_NEW) => optionsJson(opts || {}, fieldsThe(kind));

/**
 * The options of an agent() call as they enter the cbase key: the baseline's calculation, with `model` replaced by
 * the resolved `provider::model` beforehand and `repo` added.
 * @param {Object} opts   the options from the script
 * @param {{ model: string, kind?: string }} resolved  `model` = the resolved `provider::model` (required); `kind` = the
 *        run's chain kind (default: the new one — without disallowedTools/bashCommandClamp in the call both are equal)
 */
export function normOptions(opts = {}, { model, kind = CHAIN_KIND_NEW }) {
  if (!model) throw new Error("normOptions: the resolved model (provider::model) is missing");
  return optionsJson({ ...(opts || {}), model }, [...fieldsThe(kind), "repo"]);
}

export const key = (prior, prompt, norm) =>
  KEY_VERSION + crypto.createHash("sha256").update(`${prior}\0${prompt}\0${norm}`).digest("hex");

/**
 * The state of a lane at a fork: `what` = "fork", the number of a slot (⇒ `slot:<i>`) or the list of slot states when
 * joining (⇒ `join` ‖ per slot \0 ‖ state). Hex without `v2:`.
 */
export function branchKey(prior, variety, what) {
  const h = crypto.createHash("sha256").update(String(prior)).update("\0").update(String(variety)).update("\0");
  if (typeof what === "number") h.update(`slot:${what}`);
  else if (what === "fork") h.update("fork");
  else { h.update("join"); for (const p of what) h.update("\0").update(String(p)); }
  return h.digest("hex");
}

/** The state of a lane behind a RE-RUN agent whose key already had an end in the old journal. */
export const replacedKey = (keyName, agentId) =>
  crypto.createHash("sha256").update(String(keyName)).update("\0replaced\0").update(String(agentId ?? "")).digest("hex");

/**
 * The chain kind a journal speaks — the ONE place for "missing ⇒ linear". The LAST `launched` with a key wins (within
 * one run all are equal; after a rollback to a server before the change and forward again, the kind of the newest
 * attempt wins — its results are the freshest).
 * @returns {string|null} "linear" · "branches" · an unknown value, verbatim (a journal of a NEWER server) · null when
 *          the journal carries no `launched` (nothing to hit: the caller takes `CHAIN_KIND_NEW`)
 */
export function chainKindOf(entries = []) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.kind !== "launched" || !e.key) continue;
    return e.chain === undefined || e.chain === null ? "linear" : String(e.chain);
  }
  return null;
}

// LINEAR — the last state per key of an old journal: result beats started beats launched; failed stays failed until a
// later result heals the same key (a resume that re-ran it).
function statusPerKey(entries) {
  const rang = { launched: 0, started: 1, failed: 2, result: 3 };
  const m = new Map();
  for (const e of entries) {
    if (!e?.key || !(e.kind in rang)) continue;
    const old = m.get(e.key);
    if (!old || rang[e.kind] >= rang[old.kind] || e.kind === "result") m.set(e.key, e);
  }
  return m;
}

// BRANCHES — the state of an old journal as the baseline's reader builds it, in entry order: a result holds until its
// agent is started once more (then "back", baseline "demoted") or fails; "failed" sticks to the key (a later result
// still counts). cbase's `launched` (per agent(), at the call) counts like `started`: the agent was due. The other
// kinds (waiting, restart, message) change nothing.
function statusTheBranches(entries) {
  const results = new Map(), due = new Set(), failed = new Set(), back = new Set();
  for (const e of entries) {
    if (!e?.key) continue;
    if (e.kind === "result") { results.set(e.key, e); back.delete(e.key); }
    else if (e.kind === "launched" || e.kind === "started") { if (results.delete(e.key)) back.add(e.key); due.add(e.key); }
    else if (e.kind === "failed") { results.delete(e.key); failed.add(e.key); }
  }
  return {
    results, failed, back,
    known: (k) => results.has(k) || due.has(k) || failed.has(k),
    // "Only started": was due, without an end — it runs anew, the prefix holds.
    onlyStarted: (k) => due.has(k) && !failed.has(k) && !back.has(k),
  };
}

// What a hit returns to the run. A changed worktree of the old call travels along: it is still there and belongs in
// the notice. `replaced` ("branches" only): the agentId with which the lane continues behind this result.
const asCache = (e) => ({ value: e.value ?? null, ...(e.worktree ? { worktree: e.worktree } : {}), ...(typeof e.replaced === "string" ? { replaced: e.replaced } : {}) });
const NO_FORK = Object.freeze({ slot: () => null, connect: () => {} });
const NEVER_REPLACED = () => false;

export class ChainKindError extends Error {
  constructor(kind) {
    super(`The journal speaks the chain kind “${kind}”, which this server does not know (known: ${CHAINS_KINDS.join(", ")}) — it comes from a newer version and cannot be resumed here.`);
    this.name = "ChainKindError";
  }
}

/**
 * The chain of a run.
 *
 * `further(prompt, norm, fallback, lane)` computes the key of the next call and says whether its result comes from the
 * old journal: `{ key, cache: { value, worktree?, replaced? } | null, result(agentId) }`. The run calls `result` when a
 * LIVE call has its result, BEFORE writing it to the journal: `true` ⇒ the lane continues "replaced", and the result
 * carries `replaced: <agentId>` (see header; linear always `false`).
 *
 * `fork(lane, variety)` → `{ slot(i) → lane, connect() }` — parallel()/pipeline() (see header). `lane` is what `slot`
 * returned, or `null` for the root. In kind "linear" there are no lanes: `slot` returns `null`, nothing changes.
 *
 * `fallback`: further normalised options under which THE SAME call may stand in the old journal — those of a retired
 * predecessor of the resolved model (providers/retired.js; run.js computes them). Without them a run that resolved the
 * old model before the switch and the successor afterwards would re-run EVERY agent() after the deploy — worktree
 * changes included. If the own key does not hit but a substitute does, the substitute's key applies: returned as `key`
 * (journal and playback keep speaking the old run's language) and as predecessor of the next link. Only while the
 * chain holds; a broken prefix stays broken.
 * @param {Object[]} oldEntries  entries `{ kind, key, value?, chain? }` of the run being resumed ([] = no resume)
 * @param {{ kind?: string }} [o]  the chain kind; default: that of the old journal (`chainKindOf`), without one `CHAIN_KIND_NEW`
 */
export function createChain(oldEntries = [], { kind = chainKindOf(oldEntries) ?? CHAIN_KIND_NEW } = {}) {
  if (!CHAINS_KINDS.includes(kind)) throw new ChainKindError(kind);
  return kind === "linear" ? linearChain(oldEntries) : branchChain(oldEntries);
}

function linearChain(oldEntries) {
  const old = statusPerKey(oldEntries);
  let prior = "";
  let broken = false;
  return {
    kind: "linear",
    fork: () => NO_FORK,
    further(prompt, norm, fallback = []) {
      let keyName = key(prior, prompt, norm);
      let e = old.get(keyName);
      if (!e && !broken) {
        for (const n of fallback || []) {
          const k = key(prior, prompt, n);
          if (old.has(k)) { keyName = k; e = old.get(k); break; }
        }
      }
      prior = keyName;
      if (!broken && e?.kind === "result") return { key: keyName, cache: asCache(e), result: NEVER_REPLACED };
      // New, changed or failed (also skipped): from here on nothing hits. Only started: this one runs anew, the chain
      // holds.
      if (!e || e.kind === "failed") broken = true;
      return { key: keyName, cache: null, result: NEVER_REPLACED };
    },
  };
}

function branchChain(oldEntries) {
  const old = statusTheBranches(oldEntries);
  const root = { prev: "" };
  let broken = false; // ONE prefix across all lanes
  return {
    kind: "branches",
    fork(lane, variety) {
      const b = lane ?? root;
      const before = b.prev;
      b.prev = branchKey(before, variety, "fork");
      const slots = [];
      return {
        slot(i) { const p = { prev: branchKey(before, variety, i) }; slots[i] = p; return p; },
        // On the state the lane has NOW; a slot that never existed (gap) enters empty.
        connect() { b.prev = branchKey(b.prev, variety, Array.from(slots, (p) => p?.prev ?? "")); },
      };
    },
    further(prompt, norm, fallback = [], lane = null) {
      const b = lane ?? root;
      let keyName = key(b.prev, prompt, norm);
      if (!broken && !old.known(keyName)) {
        for (const n of fallback || []) {
          const k = key(b.prev, prompt, n);
          if (old.known(k)) { keyName = k; break; }
        }
      }
      b.prev = keyName;
      const e = broken ? undefined : old.results.get(keyName);
      if (e) {
        const cache = asCache(e);
        if (cache.replaced !== undefined) b.prev = replacedKey(keyName, cache.replaced);
        return { key: keyName, cache, result: NEVER_REPLACED };
      }
      // New, changed, failed (also skipped) or a result with a later restart: from here on nothing hits.
      // Only started: this one runs anew, the chain holds.
      if (!old.onlyStarted(keyName)) broken = true;
      // It runs live. If its key already had an end in the old journal, the lane continues replaced after its result —
      // only if it still stands on the key then.
      const hadEnd = old.results.has(keyName) || old.back.has(keyName) || old.failed.has(keyName);
      return {
        key: keyName, cache: null,
        result(agentId) {
          if (!hadEnd || b.prev !== keyName) return false;
          b.prev = replacedKey(keyName, agentId);
          return true;
        },
      };
    },
  };
}

/**
 * Which agent() calls a restart will serve from the journal as long as the script calls them again unchanged — for the
 * progress tree (tree.js): THE SAME calculation as `createChain` over the same old entries (in the journal's chain
 * kind, `chainKindOf`), only in call order `n` instead of over prompt and options (the key of an `n` is on its
 * `launched`). A result comes from the cache, one that only started does not break the chain, a failed (also skipped)
 * one or one without a state breaks it — in kind "branches" also a result whose agent was started once more
 * afterwards. An `n` without `launched` (an agent() that threw before its key — model, effort, schema, type) is no
 * link of the chain and is skipped as there. A journal of unknown kind serves nothing.
 * A PREDICTION: if the script calls differently (changed, differently resolved model), the call writes a new
 * `launched`, and the tree shows the new attempt from there. Bound to `createChain` in dynworkflows-journal.test.js.
 * @param {Object[]} oldEntries  entries `{ kind, n, key, chain? }` of the journal as the restart read them
 * @returns {Set<number>} the `n` whose result the restart returns from the journal
 */
export function servedFromTheJournal(oldEntries = []) {
  const kind = chainKindOf(oldEntries);
  const served = new Set();
  if (kind === null || !CHAINS_KINDS.includes(kind)) return served;
  const keyPerN = new Map();
  for (const e of oldEntries) if (e?.kind === "launched" && e.key) keyPerN.set(e.n, e.key);
  // Per key: "hits" · "further" (only started) · "breakage".
  let verdict;
  if (kind === "linear") {
    const state = statusPerKey(oldEntries);
    verdict = (k) => { const a = state.get(k)?.kind; return a === "result" ? "hits" : a === "launched" || a === "started" ? "further" : "breakage"; };
  } else {
    const state = statusTheBranches(oldEntries);
    verdict = (k) => (state.results.has(k) ? "hits" : state.onlyStarted(k) ? "further" : "breakage");
  }
  for (const n of [...keyPerN.keys()].sort((a, b) => a - b)) {
    const u = verdict(keyPerN.get(n));
    if (u === "hits") served.add(n);
    else if (u === "breakage") break;
  }
  return served;
}

/**
 * The playback of a resume: results from the journal go back to the script in the COMPLETION ORDER of the old run, not
 * at once. The chain follows call order — and in `pipeline()` the call order of a stage depends on the completion of
 * the previous one. If all hits came at once, the script would call the second stage in a different order, and from
 * there no key would hit any more.
 *
 * `hold(key, gib)`: a hit waits until all results that finished before it in the old run have been delivered.
 * `done(key)`: a live call has finished. `quiet({ onlyHeldOpen })`: the script is waiting; if it stands ONLY on held
 * hits, the expected predecessor never comes (script changed, predecessor failed) — then the earliest held one goes
 * out instead of deadlocking.
 */
export function createPlayback(oldEntries = []) {
  const queue = oldEntries.filter((e) => e?.kind === "result").map((e) => e.key);
  const slot = new Map(queue.map((k, i) => [k, i]));
  const held = new Map(); // key → gib()
  const done = new Set();
  let pointer = 0;
  const gibFree = (k) => { const gib = held.get(k); held.delete(k); done.add(k); gib(); };
  const pump = () => {
    while (pointer < queue.length) {
      const k = queue[pointer];
      if (held.has(k)) { pointer++; gibFree(k); } else if (done.has(k)) pointer++; else break;
    }
  };
  return {
    hold(keyName, gib) { held.set(keyName, gib); pump(); },
    done(keyName) { done.add(keyName); pump(); },
    heldCount: () => held.size,
    quiet({ onlyHeldOpen }) {
      if (!onlyHeldOpen || !held.size) return;
      const early = [...held.keys()].sort((a, b) => (slot.get(a) ?? Infinity) - (slot.get(b) ?? Infinity))[0];
      gibFree(early);
      pump();
    },
  };
}
