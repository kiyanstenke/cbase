// Harness of the sandbox seam: a fake agent host without a server and the prohibition probes.
//
// USED BY: dynworkflows-sandbox.test.js. Started as a process of its own (`<node> dynworkflows-harness.mjs
// rejection|afterRun`) the file runs a probe that could end the process and writes its result as ONE JSON row to stdout;
// without an argument it runs the prohibition probes.
//
// No clock: the fake host releases answers when the test says so (`respond`), or at once (`auto`); what "done" means is
// told by `run.quiet()` of the sandbox, not by a waiting time.
import { startScript, unknownWorkflowText, CLOCK_TEXT, RANDOM_TEXT } from "../electron/server/dynworkflows/sandbox.js";

/**
 * A host that records every agent() call.
 * @param {{ auto?: (call) => any, workflows?: Object<string, string> }} [o]  `auto` answers at once (value, promise or
 *        throw); without `auto` every call stays open until the test releases it with `respond`/`fail`; the test
 *        chooses the release order. `workflows`: name -> script, the library for workflow().
 */
export function fakeHost({ auto, workflows = {} } = {}) {
  const calls = [];
  const events = [];
  const followUp = []; // both in ONE row, as the host experiences it: { agent: prompt } | event
  const open = new Map();
  const byPrompt = (prompt) => {
    const a = calls.find((x) => x.prompt === prompt && open.has(x.n));
    if (!a) throw new Error(`no open call with prompt ${JSON.stringify(prompt)} (open: ${JSON.stringify(calls.filter((x) => open.has(x.n)).map((x) => x.prompt))})`);
    return a.n;
  };
  return {
    calls,
    events,
    followUp,
    host: {
      agent(a) {
        calls.push(a);
        followUp.push({ agent: a.prompt });
        if (auto) return auto(a);
        return new Promise((res, rej) => open.set(a.n, { res, rej }));
      },
      event(e) { events.push(e); followUp.push(e); },
      workflow({ name }) {
        followUp.push({ workflow: name });
        if (!Object.hasOwn(workflows, name)) throw new Error(unknownWorkflowText(name, Object.keys(workflows)));
        return { script: workflows[name], name };
      },
    },
    /** Answer the open call with this prompt. */
    respond(prompt, value) {
      const n = byPrompt(prompt);
      open.get(n).res(value);
      open.delete(n);
    },
    fail(prompt, text) {
      const n = byPrompt(prompt);
      open.get(n).rej(new Error(text));
      open.delete(n);
    },
    openPrompts: () => calls.filter((a) => open.has(a.n)).map((a) => a.prompt),
  };
}

/** Run a body against an immediate host and return the end. */
export async function run(o, auto = () => null) {
  const f = fakeHost({ auto });
  const run2 = startScript({ ...o, host: f.host });
  try {
    return { ...(await run2.end), calls: f.calls, events: f.events };
  } finally {
    run2.abort();
  }
}

// The prohibitions of the original, one probe each: the body returns what it sees. `expected` is the return value, `error`
// the wording of the error at the end. Temporal is listed because a Node may bring it into the context.
const fang = (expression) => `try { ${expression}; return "offen"; } catch (e) { return e.name + ": " + e.message; }`;
export const PROHIBITIONS = [
  { name: "Date.now()", body: fang("Date.now()"), expected: `Error: ${CLOCK_TEXT}` },
  { name: "new Date()", body: fang("new Date()"), expected: `Error: ${CLOCK_TEXT}` },
  { name: "Date()", body: fang("Date()"), expected: `Error: ${CLOCK_TEXT}` },
  { name: "Math.random()", body: fang("Math.random()"), expected: `Error: ${RANDOM_TEXT}` },
  { name: "back door (new Date(0)).constructor.now()", body: fang("new Date(0).constructor.now()"), expected: `Error: ${CLOCK_TEXT}` },
  { name: "Date with an argument stays", body: "return new Date(0).toISOString() + ' ' + Date.UTC(2020, 0, 1)", expected: "1970-01-01T00:00:00.000Z 1577836800000" },
  { name: "eval", body: `try { eval("1"); return "offen"; } catch (e) { return e.name; }`, expected: "EvalError" },
  { name: "Function from text", body: `try { new Function("return 1"); return "offen"; } catch (e) { return e.name; }`, expected: "EvalError" },
  {
    name: "deleted and missing globals",
    body: "return ['Temporal','WeakRef','FinalizationRegistry','SharedArrayBuffer','Atomics','WebAssembly','ShadowRealm','queueMicrotask','process','require','performance','fetch'].map((g) => g + ':' + typeof globalThis[g]).join(' ')",
    expected: "Temporal:undefined WeakRef:undefined FinalizationRegistry:undefined SharedArrayBuffer:undefined Atomics:undefined WebAssembly:undefined ShadowRealm:undefined queueMicrotask:undefined process:undefined require:undefined performance:undefined fetch:undefined",
  },
  { name: "Temporal.Now", body: fang("Temporal.Now.instant()"), expected: "ReferenceError: Temporal is not defined" },
  { name: "import()", body: `return await import("node:fs")`, error: "SyntaxError: import() is not available in workflow scripts." },
];

export async function checkProhibitions() {
  const out = [];
  for (const v of PROHIBITIONS) {
    const r = await run({ body: v.body });
    out.push({ name: v.name, result: r.ok ? r.returnValue : { error: r.error.text } });
  }
  return out;
}

// The unhandled rejection of a script's own promise, in a process of its OWN: under `node --test` the test runner itself
// listens for `unhandledRejection` and would count it as an error of the file even if the run catches it. Here the catcher of
// the sandbox is the only listener, as in the server. The process reports the end of both runs and lives on afterwards (one
// round of the event loop later it writes "alive").
export async function checkRejection() {
  let late = null;
  const run2 = startScript({ body: `Promise.reject(new Error("boom im Skript")); const r = await agent("hangs"); return r`,
    host: { agent: () => new Promise((r) => { late = r; }) } });
  const end = await run2.end;
  late?.("late");
  await run2.quiet();
  run2.abort();
  const caught = await run({ body: `const p = Promise.reject(new Error("x")); await agent("a"); try { await p; } catch (e) { return "gefangen " + e.message; }` }, () => "R");
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  return { end: { ok: end.ok, error: end.error }, caught: { ok: caught.ok, returnValue: caught.returnValue }, listeners: process.listenerCount("unhandledRejection") };
}

// After the script end the context never runs again: an agent() the script did not wait for answers only when the catcher is
// already deregistered; a continuation that still ran in the context and threw would be an unhandled rejection without a
// listener and end the process. Two ends: ok and runtime error (whose open agents the core answers with null). The answer
// comes only when the catcher is demonstrably gone.
export async function checkAfterRun() {
  const rounds = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  const cases = [
    { name: "ok", body: `agent("a").then((t) => JSON.parse(t)); return "done";`, response: "kein json" },
    { name: "runtime", body: `agent("b").then((t) => t.length); throw new Error("broken before");`, response: null },
    { name: "fortsetzung ruft agent", body: `agent("c").then(() => agent("d")); return "done";`, response: "C" },
  ];
  const out = [];
  for (const fall of cases) {
    const calls = [];
    let approve = null;
    const run2 = startScript({ body: fall.body, host: { agent: (a) => { calls.push(a.prompt); return new Promise((r) => { approve = r; }); } } });
    const end = await run2.end;
    await rounds(4);
    const listenersPrior = process.listenerCount("unhandledRejection");
    approve(fall.response);
    await rounds(4);
    await run2.quiet();
    out.push({ name: fall.name, ok: end.ok, kind: end.error?.kind ?? null, listenersPrior, calls });
  }
  return out;
}

// The `setTimeout(r, 0)` before "alive" is one ROUND of the event loop, not a duration: an unhandled rejection is processed
// at the end of the microtask round, so before any timer; if it ended the process, it did so before this line. Load shifts
// WHEN the round comes, not the order; `rounds(n)` above likewise.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  if (process.argv[2] === "afterRun") {
    const result = await checkAfterRun();
    await new Promise((r) => setTimeout(r, 0));
    process.stdout.write(`${JSON.stringify({ result, alive: true })}\n`);
  } else if (process.argv[2] === "rejection") {
    const result = await checkRejection();
    await new Promise((r) => setTimeout(r, 0));
    process.stdout.write(`${JSON.stringify({ result, alive: true })}\n`);
  } else {
    const result = await checkProhibitions();
    process.stdout.write(`${JSON.stringify({ version: process.version, electron: process.versions.electron ?? null, result })}\n`);
  }
}
