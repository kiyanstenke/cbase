// Parking of workflow agents per PROVIDER.
//
// Parking happens at journal level, never in the parent chat's wait row (`pending_resume` is ONE row per chat — a run
// with twenty parking agents would overwrite it). Reasons, all as `{ kind: "waiting", reason }` in the same place as
// cap and stagger:
//
//   "limit"        An agent of the run stands at its provider's usage limit. IT parks through the per-agent park
//                  mechanism (providers/agent-runtime.js, runs/agents.js agentLimitChoice) — no second one is built
//                  here. This leaf only remembers WHICH agents of which provider are parked: while one parks, the run
//                  starts no new agent of that provider (it waits until the last parked one continues or ends);
//                  agents of other providers keep running.
//   "credit-gate"  The credit gate stands for the agent's provider (≥ 99 %, Claude only — there is no verdict for
//                  other providers). The agent does not start and waits until the window resets or the human switches
//                  the gate off (wakeGateWaiting, called from PUT /api/credit-gate).
//   "project"      The per-project lock holds the start: the project's instance is starting (after every deploy), is
//                  being recreated, or the server is ending. The agent does not start and waits for the transition to
//                  `ready` (wakeProjectWaiting, called from projectbox/idle.js wakeProject) — not for a clock; `until`
//                  is only the fallback check in case the wakeup fails to come. During a relocation and on `error` it
//                  does NOT wait: there the start fails with a reason. Also applies with auto-continue switched off —
//                  it is not a limit.
//
// With auto-continue off nothing parks (run.js decides): `agent()` yields null, and `log()` names the agent.
//
// A leaf without imports: the wakeup comes from the caller (runs/agents.js setParkWakeup — the same set as the wakeups
// of parked agents, so `wakeParkedNow` in tests wakes here too, and the server end switches it off).

// Everyone waiting at the gate in this process (one server, one user) — the gate's switch is global.
const gateWaiting = new Set();

/** The gate was switched off: let every workflow agent waiting at the gate ask again NOW. Returns the count. */
export function wakeGateWaiting() {
  const all = [...gateWaiting];
  for (const resolve of all) resolve();
  return all.length;
}

/** How many workflow agents are waiting at the gate right now — for tests and the UI. */
export const gateWaitingCount = () => gateWaiting.size;

// Everyone waiting at the project lock in this process. ALL are always woken: each asks the lock again itself and
// keeps waiting if ITS project is still busy — a list per project would be a second truth next to the lock.
const projectWaiting = new Set();

/** An instance is `ready` (or `error`), a lock released: let every workflow agent waiting at the lock ask again NOW.
 * Returns the count. */
export function wakeProjectWaiting() {
  const all = [...projectWaiting];
  for (const resolve of all) resolve();
  return all.length;
}

/** How many workflow agents are waiting at the project lock right now — for tests. */
export const projectWaitingCount = () => projectWaiting.size;

// Wait until `until` (through the caller's wakeup), until `all` is woken or the run closes — the one shape for gate
// and project lock.
function waitIn(all, here, { until, wakeup }) {
  return new Promise((resolve) => {
    let out = null;
    const resolveValue = () => {
      if (!all.delete(resolveValue)) return;
      here.delete(resolveValue);
      try { out?.(); } catch { /* a wakeup must not break the waking */ }
      resolve();
    };
    all.add(resolveValue);
    here.add(resolveValue);
    out = wakeup(Math.max(0, Number(until) - Date.now()), resolveValue);
  });
}

/**
 * The park state of ONE run.
 *   parks(provider, agentId) / further(provider, agentId): an agent parks, or continues (or ends while parked).
 *   parked(provider): is an agent of this provider parked right now?
 *   wait(provider) → Promise: resolved as soon as no agent of this provider is parked (at once if none is).
 *   atGate({ until, wakeup }) → Promise: resolved at the reset (`until`, through the wakeup), when the gate is switched
 *     off or when the run closes — afterwards the caller asks the gate again.
 *   atProject({ until, wakeup }) → Promise: resolved when the project waiters are woken (wakeProjectWaiting), at the
 *     fallback check (`until`) or when the run closes — afterwards the caller asks the gate again.
 *   snapshot() → { provider: [agentId, …] }
 *   waiting() → how many agent() calls of this run are WAITING right now (at the project lock, at the gate or behind a
 *     parked agent of their provider): a run whose open calls only wait does not hold up applying a layout
 *     (otherwise both would deadlock: it waits at the lock, the lock for it).
 *   close(): resolves all waiters (the caller then checks whether its run is closed). Idempotent.
 */
export function createProviderPark() {
  const parked = new Map();  // provider → Set(agentId)
  const waiting = new Map(); // provider → Set(resolve)
  const atGateHere = new Set(); // the gate waiters of THIS run (resolve)
  const atProjectHere = new Set(); // the project-lock waiters of THIS run (resolve)
  let closed = false;

  const releaseAll = (provider) => {
    const w = waiting.get(provider);
    waiting.delete(provider);
    for (const resolve of w || []) resolve();
  };

  return {
    parks(provider, agentId) {
      if (closed) return;
      if (!parked.has(provider)) parked.set(provider, new Set());
      parked.get(provider).add(String(agentId));
    },
    further(provider, agentId) {
      const set = parked.get(provider);
      if (!set?.delete(String(agentId))) return;
      if (set.size) return;
      parked.delete(provider);
      releaseAll(provider);
    },
    parked: (provider) => !closed && (parked.get(provider)?.size || 0) > 0,
    wait(provider) {
      if (closed || !(parked.get(provider)?.size)) return Promise.resolve();
      return new Promise((resolve) => {
        if (!waiting.has(provider)) waiting.set(provider, new Set());
        waiting.get(provider).add(resolve);
      });
    },
    atGate({ until, wakeup }) {
      if (closed) return Promise.resolve();
      return waitIn(gateWaiting, atGateHere, { until, wakeup });
    },
    atProject({ until, wakeup }) {
      if (closed) return Promise.resolve();
      return waitIn(projectWaiting, atProjectHere, { until, wakeup });
    },
    snapshot: () => Object.fromEntries([...parked].map(([a, s]) => [a, [...s]])),
    waiting: () => atProjectHere.size + atGateHere.size + [...waiting.values()].reduce((n, w) => n + w.size, 0),
    close() {
      if (closed) return;
      closed = true;
      for (const provider of [...waiting.keys()]) releaseAll(provider);
      parked.clear();
      for (const resolve of [...atGateHere]) resolve();
      for (const resolve of [...atProjectHere]) resolve();
    },
  };
}
