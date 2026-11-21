// The stall watchdog: a run that shows NO progress for `deadlineMs` counts as hanging. The clock STANDS while a tool
// call is open — a long build, a waiting foreground grandchild or a long search is work, not a stall —, and restarts
// after the end of the last open call.
//
// The signal is the NORMALIZED event stream that all three paths deliver: every event is progress; a call is open from
// its `tool_use` block (assistant) to the `tool_result` with the same id (user). Claude delivers both itself
// (stream-json); Codex translates `item.started`/`item.completed` with the item id (connectors/codex.js — measured at
// 0.153.1, re-measured for MCP calls at 0.162.1: both carry the same id, and the CLI is silent while the command
// runs); the loop engine announces every call with its id and reports the result afterwards (engine.js). Nothing here
// depends on a message id: Codex's `message_start` carries none.
//
// Deadline and repetitions are PARAMETERS, not constants: the subagents run it with the environment deadline and zero
// repetitions (providers/agent-runtime.js). The clock is injected — `now()` and `wakeup(ms, fn) → off` —, so that a
// test ADVANCES it instead of waiting for a duration (adjustableClock).
//
// Leaf without imports.

/** The wall clock. */
export const realClock = {
  now: () => Date.now(),
  wakeup: (ms, fn) => { const t = setTimeout(fn, Math.min(Math.max(0, ms), 2 ** 31 - 1)); t.unref?.(); return () => clearTimeout(t); },
};

/**
 * A clock a test can advance: `now()` is the wall clock (or zero with `{real:false}`) plus the offset that
 * `advance(ms)` adds; every wakeup whose time is reached fires immediately and in order. With `real` (default) a
 * wakeup additionally fires by wall clock — in production it is an ordinary clock.
 */
export function adjustableClock({ real = true } = {}) {
  let offset = 0;
  const wakeup = new Set();
  const now = () => (real ? Date.now() : 0) + offset;
  const fire = (e) => {
    if (!wakeup.delete(e)) return;
    if (e.t) clearTimeout(e.t);
    e.fn();
  };
  return {
    now,
    wakeup(ms, fn) {
      const e = { due: now() + Math.max(0, ms), fn, t: null };
      if (real) { e.t = setTimeout(() => fire(e), Math.min(Math.max(0, ms), 2 ** 31 - 1)); e.t.unref?.(); }
      wakeup.add(e);
      return () => { if (e.t) clearTimeout(e.t); wakeup.delete(e); };
    },
    /** Advance the clock by `ms`; returns the number of wakeups fired (including ones created along the way). */
    advance(ms) {
      offset += Math.max(0, Number(ms) || 0);
      let n = 0;
      for (;;) {
        const due = [...wakeup].filter((e) => e.due <= now()).sort((a, b) => a.due - b.due);
        if (!due.length) return n;
        for (const e of due) { n += 1; fire(e); }
      }
    },
    count: () => wakeup.size,
  };
}

/**
 * @param {Object} o
 * @param {number} o.deadlineMs                  this long without progress ⇒ stall
 * @param {number} [o.repetitions=0]             how often the owner may start over after a stall (atStall)
 * @param {{now:()=>number, wakeup:(ms:number, fn:Function)=>Function}} [o.clock]
 * @param {(i:{attempt:number, stillMs:number}) => void} [o.atStall]     stall no. `attempt` ≤ repetitions —
 *        the owner starts over; the clock then restarts
 * @param {(i:{attempts:number, stillMs:number}) => void} o.atTask   the last stall: give up
 */
export function createStallWatchdog({ deadlineMs, repetitions = 0, clock = realClock, atStall = null, atTask }) {
  const deadline = Math.max(1, Number(deadlineMs) || 0);
  const allowed = Math.max(0, Math.floor(Number(repetitions) || 0));
  const open = new Set();   // ids of the open tool calls
  let last = clock.now(); // last progress
  let out = null;            // the armed wakeup (null = none)
  let attempts = 0;
  let calls = 0;           // calls seen so far (for the measurement line: does this path have a tool signal?)
  let ended = false;

  const disarm = () => { const a = out; out = null; if (a) { try { a(); } catch { /* see below */ } } };
  // Exactly ONE wakeup, set to the earliest possible stall. Progress only moves `last`; if the wakeup fires too early,
  // it re-arms for the rest — no re-arming per event (a stream has hundreds of deltas per second).
  const sharpness = () => {
    if (ended || open.size || out) return;
    out = clock.wakeup(Math.max(0, last + deadline - clock.now()), check);
  };
  function check() {
    out = null;
    if (ended || open.size) return;
    const stillMs = clock.now() - last;
    if (stillMs < deadline) return sharpness();
    attempts += 1;
    if (attempts <= allowed) {
      try { atStall?.({ attempt: attempts, stillMs }); } catch { /* the owner must not take the watchdog down */ }
      last = clock.now();
      return sharpness();
    }
    ended = true;
    try { atTask?.({ attempts, stillMs }); } catch { /* see above */ }
  }

  const progress = () => { last = clock.now(); sharpness(); };
  const on = (id) => {
    calls += 1;
    open.add(String(id || `without-id-${calls}`));
    last = clock.now();
    disarm();
  };
  const closed = (id) => {
    open.delete(String(id || ""));
    progress();
  };

  sharpness();
  return {
    /** An event of the normalized stream: always progress; `tool_use` opens, `tool_result` closes. */
    observe(evt) {
      if (ended || !evt || typeof evt !== "object") return;
      const content = Array.isArray(evt.message?.content) ? evt.message.content : [];
      let opened = false;
      if (evt.type === "assistant") for (const b of content) if (b?.type === "tool_use") { on(b.id); opened = true; }
      if (evt.type === "user") for (const b of content) if (b?.type === "tool_result") closed(b.tool_use_id);
      if (!opened) progress();
    },
    progress,
    toolOn: on,
    toolTo: closed,
    /**
     * The process restarts (stall repetition or restart by the human): whatever was open in the old one never closes —
     * a `tool_result` of the killed process does not come. The open calls are dropped, the clock runs from now; the
     * number of stalls stays.
     */
    newProcess() { if (ended) return; open.clear(); progress(); },
    /** The run is over (done, failed, stopped, parked): no more wakeup. */
    end() { ended = true; disarm(); },
    snapshot: () => ({ open: open.size, calls, attempts, ended, stillMs: clock.now() - last, deadlineMs: deadline }),
  };
}
