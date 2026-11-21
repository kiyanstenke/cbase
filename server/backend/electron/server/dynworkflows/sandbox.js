// The script language of Claude Code's workflow tool, 1:1, in a vm context INSIDE the backend process (like Claude
// Code itself). The host calls `startScript` as a function and receives agent() calls and events as callbacks.
//
// The yardstick is the workflow tool of the pinned Claude Code version (measured in the private part of the repository):
// the globals `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`,
// `console`, `setTimeout`/`clearTimeout`; the same prohibitions (clock and randomness throw — they would break resume
// —, no code generation from strings, the deleted globals); the same caps (1000 agent() per run, 4096 entries per list
// across the boundary, 30 s for the synchronous part); the messages are cbase's own. Plus `workflow()`: a saved workflow
// as a sub-step, one level, with cap, counter, abort and budget of the parent run.
//
// The wrappers are created INSIDE the context (prelude as source text): their promises are promises of the context,
// and across the boundary only strings (`send(text)`) and numbers go out, only strings come in. No object of the
// server reaches the script — an array from the server would not be `instanceof Array` there.
//
// Every agent() call reports SYNCHRONOUSLY to the host before it awaits for the first time: the order of calls at the
// host is call order, not completion order (the journal's key chain builds on that).
//
// LANES (journal.js, chain kind "branches"): parallel() and pipeline() fork the lane they are called in, every thunk or
// item runs in a slot of its own, and every agent() computes its key on ITS lane. Which one that is, is tracked by an
// AsyncLocalStorage as in the baseline — across every `await` in the script, even when the continuation runs out of a
// foreign evaluation (another agent's answer, tick, timer). Measured on Node 22.17 with `microtaskMode:
// "afterEvaluate"`: the context's promises carry the store state of their creation, PROVIDED the storage is already
// running when the script starts (so the body starts in the root lane; a promise from before the first `run` would
// have no state and inherit that of whoever happens to call). The sandbox computes nothing: the host gets
// `host.fork(lane, variety)` → `{ slot(i) → lane, connect() }` synchronously at the call of parallel()/pipeline() and
// the lane as second argument of `host.agent(call, lane)` (`null` = root). The host's lane objects never reach the
// context (only the fork's number does). Without `host.fork` (linear chain, tests without a journal) no storage runs.
//
// Not here (deliberately, "vm in the server" without an additional protective shell): freezing the intrinsics and the
// baseline's await rewriting (they close escapes through thenables), a cap for memory. Residual risk: an escape from vm
// reaches the server, a script that eats memory takes it down.
//
// Two deviations from the baseline, both against a server that stands for ALL chats:
//   · Time limit per SECTION. The baseline only limits the synchronous beginning (30 s); a loop after the first
//     `await` would block the whole session there. Here the context runs with `microtaskMode: "afterEvaluate"`: its
//     microtasks run ONLY inside an evaluation, and every return into the context (host answer, tick, timer) is an
//     evaluation with `timeout` (`pump`). If a section between two await points computes longer than the limit
//     (default 30 s, knob: sectionDeadline below), the run ends as failed (`error.kind` "deadline"), and the backend is
//     reachable again. A timer callback of the script therefore never runs directly out of the server but as a
//     microtask in the context.
//   · A catcher for the unhandled rejection of a SCRIPT-OWNED promise (`Promise.reject(…)` without a handler). For
//     Node it belongs to the process — without a catcher it would end the server. It is recognised by the context's
//     promise prototype (read before the script); the run ends as failed with the error text. A foreign rejection is
//     treated by the catcher like Node itself would: if there is no other listener, it rethrows it.
import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";

import { MetaError, ScriptError, checkBody, checkScript } from "./script.js";

export const AGENT_CAP = 1000;
export const LIST_CAP = 4096;
export const SYNC_DEADLINE_MS = 30000;
// The limit per section between two await points — default like the beginning. Read at every start.
export const SECTION_DEFAULT_MS = 30000;
// Knob in milliseconds, set to a fixed value in the gate (tools/check/targets/check.mjs).
export function sectionDeadline() { const v = Number(process.env.CBASE_DYNWF_SECTION_MS); return Number.isFinite(v) && v > 0 ? v : SECTION_DEFAULT_MS; }
export const deadlineText = (ms) => `Workflow script computed for more than ${ms} ms without waiting (limit per section between two awaits, cbase) — the run was stopped. Split long loops or move the work into an agent().`;

// The messages of the clock and randomness lock and of the agent cap.
export const CLOCK_TEXT = "Date.now() and new Date() are not available in workflow scripts — resuming a run depends on it. Add timestamps after the workflow has returned, or hand them in through args.";
export const RANDOM_TEXT = "Math.random() is not available in workflow scripts — resuming a run depends on it. To get N different samples, put the index into the label or the prompt of each agent.";
export const AGENT_CAP_TEXT = `This run has made ${AGENT_CAP} agent() calls, the most one run may make. The usual cause is a loop on budget.remaining() without a token budget: with budget.total null, remaining() is Infinity and the loop never ends. Give the loop a fixed maximum number of rounds, or set a token budget.`;
export const ABORT_TEXT = "Workflow aborted";
// workflow(): the wrong form, the unknown name and the call inside a child.
export const WORKFLOW_FORM_TEXT = "workflow() takes the name of a saved workflow (a string) or {scriptPath: <string>}";
export const NESTED_TEXT = "A child workflow cannot call workflow() itself — workflows nest one level deep, not more.";
export const unknownWorkflowText = (name, available) => `workflow('${name}'): no workflow with that name. Available: ${available.length ? available.join(", ") : "(none)"}`;

// The globals the baseline deletes from the context (`hardenVMIntrinsics`), plus `Temporal`: some Node builds bring it
// along in the vm context, the baseline (Bun) does not — and `Temporal.Now` is a clock.
export const DELETED_GLOBALS = ["ShadowRealm", "WebAssembly", "FinalizationRegistry", "WeakRef", "Atomics",
  "SharedArrayBuffer", "queueMicrotask", "$vm", "gc", "edenGC", "fullGC", "print", "readFile", "Loader", "Temporal"];

// The clock and randomness lock.
const DETERMINISM = `(() => {
      const NOW_ERR = ${JSON.stringify(CLOCK_TEXT)};
      const RANDOM_ERR = ${JSON.stringify(RANDOM_TEXT)};
      Math.random = function random() { throw new Error(RANDOM_ERR) };
      const RealDate = Date;
      RealDate.now = function now() { throw new Error(NOW_ERR) };
      function ShimDate(...a) {
        if (!new.target) throw new Error(NOW_ERR); // bare Date() → now-string
        if (a.length === 0) throw new Error(NOW_ERR);
        return Reflect.construct(RealDate, a, new.target);
      }
      ShimDate.now = RealDate.now;
      ShimDate.parse = RealDate.parse;
      ShimDate.UTC = RealDate.UTC;
      ShimDate.prototype = RealDate.prototype;
      // Close the (new Date(x)).constructor backdoor to RealDate.now — point
      // .constructor at the shim, then freeze RealDate so it can't be undone.
      RealDate.prototype.constructor = ShimDate;
      Object.freeze(RealDate);
      globalThis.Date = ShimDate;
    })()`;

// The prelude runs in the context. It gets the bridge as an argument, not as a global variable.
const PRELUDE = `(function (bridge) {
  "use strict";
  const { send: sendRaw, consumed: consumed, tick, aborted: aborted, timer, timerClear, fork: fork, inSlot, connect: connect } = bridge;
  // A timer callback runs as a microtask INSIDE the context (only then is it under the limit per section) —
  // with the intrinsics of now, not with whatever the script later puts on Promise.
  const thenFn = Promise.prototype.then, resolved = Promise.resolve();
  const inContext = (fn) => () => { thenFn.call(resolved, () => { try { fn(); } catch { /* swallowed as in the baseline */ } }); };
  const AGENT_CAP = bridge.AGENT_CAP, LIST_CAP = bridge.LIST_CAP, budgetTotal = bridge.budgetTotal;
  const AGENT_CAP_TEXT = bridge.AGENT_CAP_TEXT;
  const send = (m) => sendRaw(JSON.stringify(m));
  const pending = new Map();
  let count = 0;
  let currentPhase;
  const never = () => new Promise(() => {});
  const wait0 = () => new Promise((r) => tick(() => r()));
  const quiet = (p) => { p.catch(() => {}); return p; };

  class WorkflowAgentCapError extends Error { constructor() { super(AGENT_CAP_TEXT); this.name = "WorkflowAgentCapError"; } }
  class WorkflowBudgetExceededError extends Error {
    constructor(spent, total) {
      super("Workflow token budget exceeded (" + spent.toLocaleString("en-US") + " / " + total.toLocaleString("en-US") + " output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.");
      this.name = "WorkflowBudgetExceededError";
    }
  }
  // Primitives become text, everything else "[object]"/"[function]" (as in the baseline) — for prompt, phase, log.
  const asText = (v) => (v == null || (typeof v !== "object" && typeof v !== "function")) ? String(v) : "[" + typeof v + "]";
  function errorText(e) {
    try {
      if (e !== null && typeof e === "object" && typeof e.message === "string") return { name: typeof e.name === "string" ? e.name : "Error", msg: e.message };
      return { name: "Error", msg: String(e) };
    } catch { return { name: "Error", msg: "<unprintable thrown value>" }; }
  }
  function capCheck() { if (count >= AGENT_CAP) throw new WorkflowAgentCapError(); }
  function budgetCapCheck() {
    if (budgetTotal == null || budgetTotal <= 0) return;
    const s = consumed();
    if (s < budgetTotal) return;
    throw new WorkflowBudgetExceededError(s, budgetTotal);
  }
  // A list across the boundary: read the length, cap, entries one by one (as in the baseline).
  function lengthOf(a) {
    let n;
    try { n = a.length; } catch { throw new Error("unable to read array length across the workflow VM boundary"); }
    if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error("array length is not a safe integer across the workflow VM boundary");
    if (n > LIST_CAP) throw new Error("array length " + n + " exceeds the maximum of " + LIST_CAP + " supported across the workflow VM boundary");
    return n;
  }
  function copyOf(a) {
    if (a === null || typeof a !== "object") return [];
    const n = lengthOf(a), out = [];
    for (let i = 0; i < n; i++) { try { out[i] = a[i]; } catch { out[i] = undefined; } }
    return out;
  }
  const fail = (text, withLog) => send({ t: "failure", text, log: withLog });
  const optsClone = (o) => (o !== null && typeof o === "object" && !Array.isArray(o)) ? JSON.parse(JSON.stringify(o)) : {};

  // agent() with the phase of ITS script: the parent script carries \`currentPhase\`, a child (workflow())
  // its own. Counter, cap and budget are the same for both — the child shares them with the parent run (baseline).
  function agentOf(prompt, opts, phaseNow, kind) {
    if (aborted()) return never();
    const o = optsClone(opts);
    try { capCheck(); budgetCapCheck(); } catch (e) { return quiet(wait0().then(() => { throw e; })); }
    const n = ++count;
    const phase = o.phase != null ? String(o.phase) : phaseNow();
    return quiet(new Promise((res, rej) => {
      pending.set(n, { res, rej });
      const m = { t: "agent", n, prompt: asText(prompt), opts: o, phase: phase === undefined ? null : phase };
      if (kind !== undefined) m.workflow = kind;
      send(m);
    }));
  }
  function agent(prompt, opts) { return agentOf(prompt, opts, () => currentPhase, undefined); }

  // workflow(): a saved workflow (name) or a script file ({scriptPath}) as a sub-step.
  // Lookup and translation happen in the server; back comes a function of THIS context that calls \`kindStart\` —
  // only strings cross the boundary (name, path, args as JSON). The child runs in the same context under the same
  // guards (limit per section, catcher, abort) and sees its own \`args\`, \`agent\`, \`phase\` and \`workflow\`:
  // a workflow() in the child throws (one level as in the baseline).
  const openW = new Map();
  let wCount = 0;
  const WORKFLOW_FORM_TEXT = bridge.WORKFLOW_FORM_TEXT, NESTED_TEXT = bridge.NESTED_TEXT;
  function workflow(ref, a) {
    if (aborted()) return never();
    let name, path;
    if (typeof ref === "string") name = ref;
    else if (ref !== null && typeof ref === "object" && typeof ref.scriptPath === "string") path = ref.scriptPath;
    else return quiet(Promise.reject(new TypeError(WORKFLOW_FORM_TEXT)));
    let argsText;
    try { argsText = a === undefined ? undefined : JSON.stringify(a); } catch (e) { return quiet(Promise.reject(e)); }
    const w = ++wCount;
    return quiet(new Promise((res, rej) => {
      openW.set(w, { res, rej });
      send({ t: "workflow", w, name, scriptPath: path, args: argsText });
    }));
  }
  const nested = function workflow() { return quiet(Promise.reject(new Error(NESTED_TEXT))); };
  // The child's result like that of a run: JSON, not a function.
  function kindResult(v) {
    if (typeof v === "function") throw new Error("workflow result cannot be a function");
    const s = JSON.stringify(v, (_k, x) => (typeof x === "function" ? undefined : x));
    return s === undefined ? null : JSON.parse(s);
  }
  function kindStart(w, fn, argsText, name) {
    const ow = openW.get(w);
    if (!ow) return;
    openW.delete(w);
    thenFn.call(resolved, () => {
      let kindPhase;
      const kAgent = function agent(prompt, opts) { return agentOf(prompt, opts, () => kindPhase, name); };
      const kPhase = function phase(title) { kindPhase = asText(title); send({ t: "phase", title: kindPhase }); };
      let p;
      try { p = fn(argsText === undefined ? undefined : JSON.parse(argsText), nested, kAgent, kPhase); } catch (e) { ow.rej(e); return; }
      thenFn.call(p, (v) => { try { ow.res(kindResult(v)); } catch (e) { ow.rej(e); } }, (e) => ow.rej(e));
    });
  }
  function kindError(w, text) {
    const ow = openW.get(w);
    if (!ow) return;
    openW.delete(w);
    ow.rej(new Error(String(text)));
  }

  function evaluate(kind, settled) {
    let droppedCount = 0;
    const out = settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const { name, msg } = errorText(r.reason);
      if (name === "WorkflowBudgetExceededError") { droppedCount++; return null; }
      fail(kind + "[" + i + "] failed: " + msg, true);
      return null;
    });
    if (droppedCount > 0) fail(kind + ": " + droppedCount + " " + (droppedCount === 1 ? "slot" : "slots") + " dropped — token budget exceeded", false);
    return out;
  }

  // BARRIER: waits for all; a throwing branch becomes null, the call itself never rejects.
  // The lane's fork (journal.js "branches") as in the baseline SYNCHRONOUSLY at the call, before the first await — even if
  // a malformed call throws afterwards or the list is empty (then without connect); it connects after ALL slots ended.
  const parallel = (thunks) => quiet((async () => {
    if (aborted()) return never();
    const g = fork("parallel");
    await wait0();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    const j = copyOf(thunks);
    if (j.length === 0) return [];
    capCheck(); budgetCapCheck();
    for (const f of j) if (typeof f !== "function") throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    const settled = await Promise.allSettled(j.map((f, i) => { try { return Promise.resolve(inSlot(g, i, f)); } catch (e) { return Promise.reject(e); } }));
    connect(g);
    return evaluate("parallel", settled);
  })());

  // NO barrier: every item runs alone through all stages; null ends its chain, a throw makes it null.
  // ONE slot per item, across all its stages (baseline).
  const pipeline = (items, ...stages) => quiet((async () => {
    if (aborted()) return never();
    const g = fork("pipeline");
    await wait0();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    const z = copyOf(items), s = copyOf(stages);
    if (z.length === 0) return [];
    capCheck(); budgetCapCheck();
    for (const f of s) if (typeof f !== "function") throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    const settled = await Promise.allSettled(z.map((item, i) => inSlot(g, i, async () => {
      let v = await item;
      for (const stage of s) { if (v === null) break; v = await stage(v, item, i); }
      return v;
    })));
    connect(g);
    return evaluate("pipeline", settled);
  })());

  const phase = (title) => { currentPhase = asText(title); send({ t: "phase", title: currentPhase }); };
  const log = (message) => { send({ t: "log", text: asText(message) }); };
  const budget = Object.freeze({
    __proto__: null,
    total: budgetTotal,
    spent: () => consumed(),
    remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - consumed())),
  });
  // console as in the baseline: everything becomes a log line, error/warn with a prefix.
  function logText(values) {
    return values.map((w) => {
      if (typeof w === "string") return w;
      if (w === null || (typeof w !== "object" && typeof w !== "function")) { try { return JSON.stringify(w); } catch { return "[" + typeof w + "]"; } }
      let a;
      try { const s = JSON.stringify(w); if (s !== undefined && s !== "{}") return s; a = s ?? "[" + typeof w + "]"; } catch { return "[" + typeof w + "]"; }
      let f; try { f = String(w); } catch { f = "<unprintable>"; }
      return f === "[object Object]" || f === "<unprintable>" ? a : f;
    }).join(" ");
  }
  const row = (prefix) => (...w) => send({ t: "log", text: prefix + logText(w) });
  const consoleObj = Object.freeze({ __proto__: null, log: row(""), info: row(""), debug: row(""), error: row("[error] "), warn: row("[warn] ") });
  const setTimeout = function setTimeout(fn, ms) {
    return timer(typeof fn === "function" ? inContext(fn) : () => {}, typeof ms === "number" ? ms : typeof ms === "string" ? (+ms || 0) : 0);
  };
  const clearTimeout = function clearTimeout(id) {
    if (typeof id === "number" || typeof id === "string") timerClear(typeof id === "number" ? id : +id);
  };

  for (const [k, v] of Object.entries({ agent, parallel, pipeline, phase, log, budget, workflow, console: consoleObj, setTimeout, clearTimeout })) {
    Object.defineProperty(globalThis, k, { value: v, writable: true, enumerable: true, configurable: true });
  }
  function receive(raw) {
    const m = JSON.parse(raw);
    const w = pending.get(m.n);
    if (!w) return;
    pending.delete(m.n);
    if (m.ok) w.res(m.value === undefined ? null : m.value);
    else { const e = new Error(String(m.error || "agent() failed")); if (typeof m.name === "string") e.name = m.name; w.rej(e); }
  }
  return { receive: receive, kindStart, kindError };
})`;

const ERASE = `(() => { for (const g of ${JSON.stringify(DELETED_GLOBALS)}) delete globalThis[g]; })()`;

/**
 * Start a script in the vm context.
 *
 * @param {Object} o
 * @param {string} [o.script]  a whole script (`export const meta = …` first) — or
 * @param {string} [o.body]    a body without meta (fragments of the guide; the host has already read meta)
 * @param {*} [o.args]         the value of `args`, verbatim (as JSON into the context)
 * @param {{ total?: number|null, consumed?: () => number }} [o.budget]  the turn's target and its counter
 * @param {{ agent: (call: {n, prompt, opts, phase}, lane: Object|null) => any, fork?: (lane: Object|null, variety: string) => { slot: (i: number) => Object|null, connect: () => void }, event?: (e: Object) => void }} o.host
 *        `fork` (see header, "Lanes"): without it there are no lanes — `agent` always gets `null` as `lane`.
 *        `agent` answers with a value (also as a promise; `null` = skipped/died) or rejects (the script sees an
 *        error). `event` gets `{kind: "phase", title}`, `{kind: "log", text}`, `{kind: "failure", text}` in script
 *        order. An agent() from a child carries `workflow` (its name).
 *        `workflow({ name } | { scriptPath })` returns the child's `{ script, name? }` (also as a promise) or throws —
 *        the throw is the error of the workflow() call in the script; without it every name is unknown.
 * @param {{ values?: Object, source?: string }} [o.exampleEnvironment]  ONLY for the guide's examples that presuppose
 *        names without defining them: JSON values as global names, the source is run in the context before the body.
 *        A real run carries none.
 * @param {number} [o.syncDeadlineMs]  deadline for the synchronous part (default 30 s as in the baseline)
 * @param {number} [o.sectionDeadlineMs]  limit per section between two await points (default `sectionDeadline()`)
 * @returns {{ meta: Object|null, end: Promise<Object>, abort: () => void, quiet: () => Promise<void>, withoutLane?: () => number }}
 *          `withoutLane()` (only on a started run): how often an agent() or a fork arrived WITHOUT a storage state —
 *          always 0 as long as the lanes hold (measuring point for the tests).
 *          `end` ALWAYS resolves: `{ ok: true, returnValue, agentCount, failures }` or `{ ok: false, error: { kind:
 *          "meta"|"syntax"|"runtime"|"abort"|"deadline", name, text }, agentCount, failures }` — "runtime" also for an
 *          unhandled rejection of a script-owned promise. `quiet()` resolves as soon as the script only waits for
 *          answers of the host (no microtask, no internal tick open).
 */
export function startScript(o) {
  const host = o.host;
  const event = (e) => { try { host.event?.(e); } catch { /* an observer does not break the run */ } };
  const failures = [];
  let agentCount = 0;
  let aborted = false;
  // The script has ended (ok, runtime error, abort): the context never runs again. An agent() it did not wait for runs
  // to its end at the host, but its answer no longer goes in — otherwise a continuation (`agent(…).then(…)`) would run
  // after the catcher was unregistered, and its rejection would end the backend process.
  let past = false;
  let atAbort = () => {};
  const ticks = new Set();
  const timers = new Map();
  const toEnd = (error) => ({ ok: false, error, agentCount, failures });
  // The lanes (see header): one storage per run, only when the host forks. The state is the host's lane; the root is a
  // symbol of its own so that "no state" (code outside any lane — that could only come from a bug here) does not pass
  // as the root unnoticed: `laneNow` counts it.
  const lanes = typeof host.fork === "function" ? new AsyncLocalStorage() : null;
  const ROOT = Object.freeze({ root: true });
  let withoutLane = 0;
  const laneNow = () => {
    const b = lanes ? lanes.getStore() : ROOT;
    if (b === undefined) withoutLane++;
    return b === undefined || b === ROOT ? null : b;
  };
  // Timers of the script and the start of a child (workflow()) run into the context as callbacks of the SERVER
  // (setTimeout, then): Node hands them the state that applied at registration — the lane of whoever set the timer or
  // called workflow(). Bound in dynworkflows-sandbox.test.js, not rebuilt here.
  const forks = new Map();
  let forkCount = 0;

  const quiet = async () => {
    for (;;) {
      await new Promise((r) => setImmediate(r));
      if (ticks.size === 0) {
        await new Promise((r) => setImmediate(r));
        if (ticks.size === 0) return;
      }
    }
  };
  // The end from outside: abort (host), limit per section, unhandled rejection. The first reason wins.
  const end = (error) => {
    if (aborted) return;
    aborted = true;
    for (const h of ticks) clearTimeout(h);
    ticks.clear();
    for (const h of timers.values()) clearTimeout(h);
    timers.clear();
    atAbort(error);
  };
  const abort = () => end({ kind: "abort", name: "Error", text: ABORT_TEXT });

  let meta = null;
  let body;
  try {
    if (o.script !== undefined) ({ meta, body } = checkScript(o.script));
    else { body = String(o.body ?? ""); checkBody(body); }
  } catch (e) {
    const kind = e instanceof MetaError ? "meta" : e instanceof ScriptError ? "syntax" : "runtime";
    return { meta: null, end: Promise.resolve(toEnd({ kind, name: e?.name || "Error", text: String(e?.message || e) })), abort, quiet };
  }

  let script;
  try {
    // The body runs in an async context (baseline: "use await directly"), strict as in the baseline.
    script = new vm.Script(`(async () => {'use strict';\n${body}\n})()`, {
      filename: "workflow.js",
      importModuleDynamically: () => { throw new Error("import() is not available in workflow scripts."); },
    });
  } catch (e) {
    return { meta, end: Promise.resolve(toEnd({ kind: "syntax", name: "SyntaxError", text: `SyntaxError: ${e?.message || e}` })), abort, quiet };
  }

  // `afterEvaluate`: the context's microtasks only run inside an evaluation — under its `timeout`.
  const context = vm.createContext({}, { name: "workflow", codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const sectionMs = Number(o.sectionDeadlineMs) > 0 ? Number(o.sectionDeadlineMs) : sectionDeadline();
  // Every return into the context: an empty evaluation whose microtask run is under the limit. Not nested — a return
  // DURING a pump runs along in that pump's microtask run.
  let pumps = false;
  const pump = () => {
    if (aborted || past || pumps) return;
    pumps = true;
    const depth = asyncDepth();
    try { PUMP.runInContext(context, { timeout: sectionMs }); }
    catch (e) {
      healAsyncStack(depth);
      const deadline = e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
      end({ kind: deadline ? "deadline" : "runtime", name: "Error", text: deadline ? deadlineText(sectionMs) : String(e?.message || e) });
    } finally { pumps = false; }
  };
  vm.runInContext(DETERMINISM, context, { filename: "prelude.js" });
  vm.runInContext(ERASE, context, { filename: "prelude.js" });
  const total = o.budget && Number.isFinite(o.budget.total) ? o.budget.total : null;
  const consumed = typeof o.budget?.consumed === "function" ? o.budget.consumed : () => 0;
  let receive = null;
  const fromContext = (raw) => {
    const m = JSON.parse(raw);
    if (m.t === "agent") {
      agentCount = m.n;
      const call = { n: m.n, prompt: m.prompt, opts: m.opts, phase: m.phase };
      if (typeof m.workflow === "string") call.workflow = m.workflow; // from a child (workflow())
      let response;
      // Synchronously out of the script's agent(): the storage state IS the caller's lane.
      try { response = Promise.resolve(host.agent(call, laneNow())); } catch (e) { response = Promise.reject(e); }
      response.then(
        (value) => {
          if (aborted || past) return;
          let text;
          try { text = JSON.stringify({ n: m.n, ok: true, value: value === undefined ? null : value }); } catch (e) {
            text = JSON.stringify({ n: m.n, ok: false, error: `agent() result is not JSON: ${e.message}` });
          }
          receive(text);
          pump();
        },
        (e) => {
          if (aborted || past) return;
          receive(JSON.stringify({ n: m.n, ok: false, error: String(e?.message || e), name: typeof e?.name === "string" ? e.name : undefined }));
          pump();
        },
      );
    } else if (m.t === "workflow") kindRequest(m);
    else if (m.t === "phase") event({ kind: "phase", title: m.title });
    else if (m.t === "log") event({ kind: "log", text: m.text });
    else if (m.t === "failure") {
      failures.push(m.text);
      event({ kind: "failure", text: m.text });
      if (m.log) event({ kind: "log", text: m.text });
    }
  };
  const bridge = {
    send: (raw) => fromContext(String(raw)),
    consumed: () => Number(consumed()) || 0,
    tick: (further) => {
      if (aborted || past) return;
      const h = setTimeout(() => { ticks.delete(h); further(); pump(); }, 0);
      ticks.add(h);
    },
    aborted: () => aborted,
    timer: (fn, ms) => {
      if (aborted || past) return 0;
      // `fn` only puts the callback into the context as a microtask (PRELUDE inContext) — it runs in the pump.
      const h = setTimeout(() => { timers.delete(id); try { fn(); } catch { /* swallowed as in the baseline */ } pump(); }, ms);
      const id = Number(h);
      timers.set(id, h);
      return id;
    },
    timerClear: (id) => { const h = timers.get(id); if (h) { clearTimeout(h); timers.delete(id); } },
    // Lanes (see header). Only the fork's number goes into the context; 0 = the host does not fork.
    fork: (variety) => {
      if (!lanes) return 0;
      const seq = ++forkCount;
      forks.set(seq, host.fork(laneNow(), String(variety)));
      return seq;
    },
    inSlot: (seq, i, f) => {
      const lane = seq ? forks.get(seq)?.slot(i) : null;
      return lane ? lanes.run(lane, f) : f();
    },
    connect: (seq) => { const g = seq ? forks.get(seq) : null; if (g) { forks.delete(seq); g.connect(); } },
    AGENT_CAP, LIST_CAP, AGENT_CAP_TEXT, WORKFLOW_FORM_TEXT, NESTED_TEXT, budgetTotal: total,
  };
  const inside = vm.runInContext(PRELUDE, context, { filename: "prelude.js" })(bridge);
  receive = inside.receive;
  // workflow(): the host looks it up (`host.workflow({ name } | { scriptPath })` → `{ script, name? }`, also as a
  // promise; a throw is the error of the call), here it is checked and translated INSIDE the context. Only the
  // translated function of the context and strings go back into the context — never an object of the server.
  function kindRequest(m) {
    const who = typeof m.name === "string" ? { name: m.name } : { scriptPath: String(m.scriptPath) };
    let response;
    try {
      if (typeof host.workflow !== "function") throw new Error(unknownWorkflowText(who.name ?? who.scriptPath, []));
      response = Promise.resolve(host.workflow(who));
    } catch (e) { response = Promise.reject(e); }
    response.then((kind) => {
      if (aborted || past) return;
      let fn;
      let name = String(kind?.name || who.name || "workflow");
      try {
        const { meta: kMeta, body: kBody } = checkScript(String(kind?.script ?? ""));
        if (!kind?.name && kMeta?.name) name = String(kMeta.name); // {scriptPath}: the name from its meta
        // Outer function with the child's own globals as parameters, inside it the body as in a run (its own
        // declarations may shadow these names).
        fn = new vm.Script(`(function (args, workflow, agent, phase) { 'use strict'; return (async () => {'use strict';\n${kBody}\n})(); })`, {
          filename: `workflow-${name}.js`,
          importModuleDynamically: () => { throw new Error("import() is not available in workflow scripts."); },
        }).runInContext(context, { timeout: sectionMs });
      } catch (e) {
        inside.kindError(m.w, e instanceof ScriptError || e instanceof MetaError ? e.message : `${e?.name === "SyntaxError" ? "SyntaxError: " : ""}${e?.message || e}`);
        pump();
        return;
      }
      inside.kindStart(m.w, fn, typeof m.args === "string" ? m.args : undefined, name);
      pump();
    }, (e) => {
      if (aborted || past) return;
      inside.kindError(m.w, String(e?.message || e));
      pump();
    });
  }

  const environment = o.exampleEnvironment;
  if (environment) {
    for (const [k, v] of Object.entries(environment.values || {})) {
      context[k] = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(v))})`, context);
    }
    if (environment.source) vm.runInContext(String(environment.source), context, { filename: "example-environment.js" });
  }
  // args as in the baseline: JSON, parsed in the context — an object of the server would arrive with a foreign prototype.
  const argsText = o.args === undefined ? undefined : JSON.stringify(o.args);
  Object.defineProperty(context, "args", {
    value: argsText === undefined ? undefined : vm.runInContext(`JSON.parse(${JSON.stringify(argsText)})`, context),
    writable: true, enumerable: true, configurable: true,
  });

  const abort2 = new Promise((r) => { atAbort = (error) => r(toEnd(error)); });
  // The unhandled rejection of a script-owned promise: recognised by the context's prototype, read BEFORE the script
  // runs (it could overwrite `Promise` afterwards — the built-in promises still carry this one).
  const [contextProto, contextThen] = vm.runInContext("[Object.getPrototypeOf(Promise.resolve()), Promise.prototype.then]", context);
  const unregister = register(contextProto, (reason) => {
    let text;
    try { text = typeof reason?.message === "string" ? reason.message : String(reason); } catch { text = "<unprintable thrown value>"; }
    end({ kind: "runtime", name: "UnhandledRejection", text: `Unhandled promise rejection in workflow script: ${text}` });
  });
  let run;
  try {
    const go = () => script.runInContext(context, { timeout: o.syncDeadlineMs ?? SYNC_DEADLINE_MS });
    run = lanes ? lanes.run(ROOT, go) : go();
  } catch (e) {
    past = true; // the synchronous deadline: an agent() from the synchronous part still gets its answer
    lanes?.disable();
    unregister();
    return { meta, end: Promise.resolve(runtimeError(e)), abort, quiet };
  }
  function runtimeError(e) {
    let name = "Error", text;
    try { name = typeof e?.name === "string" ? e.name : "Error"; text = typeof e?.message === "string" ? e.message : String(e); } catch { text = "<unprintable thrown value>"; }
    return toEnd({ kind: "runtime", name, text });
  }
  // Subscribe to the script's end — AT ONCE and with the context's `then` from before the script: under
  // `afterEvaluate` the reaction to a promise of the context lands in ITS queue, and that only runs in a pump (a
  // `Promise.resolve(run)` would only create it in a microtask of the server — after the last pump, forever).
  const ended = new Promise((res, rej) => { contextThen.call(run, res, rej); });
  pump();
  const finished = ended.then(
    (value) => {
      if (typeof value === "function") return toEnd({ kind: "runtime", name: "Error", text: "workflow result cannot be a function" });
      let returnValue;
      try {
        const s = JSON.stringify(value, (_k, v) => (typeof v === "function" ? undefined : v));
        returnValue = s === undefined ? null : JSON.parse(s);
      } catch (e) {
        return runtimeError(e);
      }
      return { ok: true, returnValue, agentCount, failures };
    },
    runtimeError,
  );
  const end2 = Promise.race([finished, abort2]).finally(() => {
    past = true;
    for (const h of ticks) clearTimeout(h);
    ticks.clear();
    for (const h of timers.values()) clearTimeout(h);
    timers.clear();
    // This run's storage: off as soon as no code of the context runs any more (Node switches its promise hooks off
    // when no storage is on — outside a run it costs the server nothing).
    lanes?.disable();
    unregister();
  });
  return { meta, end: end2, abort, quiet, withoutLane: () => withoutLane };
}

// ── The stack of async ids after an abort inside a microtask ────────────────────────────────────────────────────────
// If the limit aborts a microtask of the context, it lacks the "after" callback of the promise hooks: with an
// async_hook active (Node 22 also for AsyncLocalStorage, `node --test` always) its id stays on the stack, and Node
// aborts HARD when closing the surrounding callback ("Assertion failed: (env_->execution_async_id()) == (0)"). The
// cure is the one in Node's own popAsyncContext (lib/internal/async_hooks.js): back down to the depth before the pump.
// The fields are only behind `process.binding("async_wrap")` (Node 22); where the binding is missing, the residual
// risk remains for a createHook in the process.
let asyncFields;
function asyncBinding() {
  if (asyncFields !== undefined) return asyncFields;
  asyncFields = null;
  const prior = process.noDeprecation;
  try {
    process.noDeprecation = true; // DEP0111 — the access is intentional and justified above
    const b = process.binding("async_wrap");
    if (b?.async_hook_fields && b.async_id_fields && b.async_ids_stack && b.constants?.kStackLength !== undefined) asyncFields = b;
  } catch { /* no binding in this Node build */ } finally { process.noDeprecation = prior; }
  return asyncFields;
}
function asyncDepth() {
  const b = asyncBinding();
  return b ? b.async_hook_fields[b.constants.kStackLength] : 0;
}
function healAsyncStack(depth) {
  const b = asyncBinding();
  if (!b) return;
  const k = b.constants;
  while (b.async_hook_fields[k.kStackLength] > depth) {
    const top = b.async_hook_fields[k.kStackLength] - 1;
    b.async_id_fields[k.kExecutionAsyncId] = b.async_ids_stack[2 * top];
    b.async_id_fields[k.kTriggerAsyncId] = b.async_ids_stack[2 * top + 1];
    b.execution_async_resources?.pop?.();
    b.async_hook_fields[k.kStackLength] = top;
  }
}

// ── The catcher for unhandled rejections ────────────────────────────────────────────────────────────────────────────
// A listener on the process, only while a run needs it — afterwards whatever Node itself does applies again. The
// mapping prototype → run is weak: a forgotten context holds on to nothing. It is unregistered only after two rounds
// of the event loop: Node evaluates unhandled rejections AFTER the microtasks, and the rejection a run ends with would
// otherwise arrive at a catcher that no longer knows it.
const PUMP = new vm.Script("undefined", { filename: "pump.js" });
const assignment = new WeakMap(); // promise prototype of a context → the run's callback (or null once it ended)
let registered = 0;
function catchRejection(reason, promise) {
  let proto = null;
  try { proto = Object.getPrototypeOf(promise); } catch { /* a Proxy or the like — then not ours */ }
  if (proto && assignment.has(proto)) {
    const f = assignment.get(proto);
    if (f) { try { f(reason); } catch (e) { console.error("[dynworkflows] catcher:", e?.message || e); } }
    return;
  }
  // Not from a workflow script: like Node without this listener — if there is no other, it continues as an exception.
  if (process.listenerCount("unhandledRejection") > 1) return;
  throw reason;
}
function register(proto, callback) {
  assignment.set(proto, callback);
  if (registered++ === 0) process.on("unhandledRejection", catchRejection);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    setImmediate(() => setImmediate(() => {
      assignment.set(proto, null);
      if (--registered === 0) process.off("unhandledRejection", catchRejection);
    }));
  };
}
