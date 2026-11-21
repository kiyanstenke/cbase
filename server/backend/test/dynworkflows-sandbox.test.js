// The sandbox seam of dynamic workflows: script against a fake agent host, without a server.
//
// The semantics of parallel(), pipeline(), the agent cap, meta, events and the prohibitions under Node. The reference examples of
// Claude Code with their hand-written expectations are measured outside this tree.
//
// No clock: the fake host enforces orders (it releases answers when the test says so), `run.quiet()` says "everything
// reported". Every run is aborted in the finally — open promises of the script would hold nothing, but a tick of the
// sandbox would keep running.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startScript, AGENT_CAP, AGENT_CAP_TEXT, LIST_CAP, NESTED_TEXT, WORKFLOW_FORM_TEXT, deadlineText } from "../electron/server/dynworkflows/sandbox.js";
import { ERROR_FIRST_INSTRUCTION } from "../electron/server/dynworkflows/script.js";
import { fakeHost, run, checkProhibitions, PROHIBITIONS } from "./dynworkflows-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Drive a run and abort it in the finally. */
async function withRun(o, f, body) {
  const run2 = startScript({ ...o, host: f.host });
  try {
    return await body(run2);
  } finally {
    run2.abort();
  }
}

// ── Semantics the examples do not show ──────────────────────────────────────────────────────────────────────

test("parallel(): a dying branch returns null at its place, the call does not throw; a skipped agent returns null", async () => {
  const r = await run({
    body: `return await parallel([() => agent("a"), () => agent("b"), () => { throw new Error("broken") }, () => agent("c")])`,
  }, (a) => {
    if (a.prompt === "a") return "A";
    if (a.prompt === "b") return Promise.reject(new Error("dead"));
    return null; // c: skipped or died
  });
  assert.equal(r.ok, true, r.error?.text);
  assert.deepEqual(r.returnValue, ["A", null, null, null]);
  assert.deepEqual(r.failures, ["parallel[1] failed: dead", "parallel[2] failed: broken"]);
  assert.deepEqual(r.events.filter((e) => e.kind === "log").map((e) => e.text), ["parallel[1] failed: dead", "parallel[2] failed: broken"]);
  const individual = await run({ body: `return [await agent("gone"), "after"]` }, () => null);
  assert.deepEqual(individual.returnValue, [null, "after"]);
});

test("pipeline() without barrier: an element's next stage starts as soon as ITS previous one is finished — at the fake host's event sequence", async () => {
  const f = fakeHost();
  await withRun({
    body: `return await pipeline(["x", "y", "z"], (it) => agent("s1:" + it), (r, it, i) => agent("s2:" + it + ":" + r + ":" + i))`,
  }, f, async (run2) => {
    await run2.quiet();
    assert.deepEqual(f.openPrompts(), ["s1:x", "s1:y", "s1:z"]);
    f.respond("s1:x", "X");
    await run2.quiet();
    assert.deepEqual(f.openPrompts(), ["s1:y", "s1:z", "s2:x:X:0"], "x is in stage 2 while y and z still hang in stage 1");
    f.respond("s1:z", null); // null ends this element's chain
    f.respond("s2:x:X:0", "XX");
    await run2.quiet();
    assert.deepEqual(f.openPrompts(), ["s1:y"]);
    f.fail("s1:y", "died");
    const r = await run2.end;
    assert.equal(r.ok, true, r.error?.text);
    assert.deepEqual(r.returnValue, ["XX", null, null]);
    assert.deepEqual(r.failures, ["pipeline[1] failed: died"]);
  });
});

test("two agent() calls whose second finishes first appear at the host in call order — synchronously, before the first wait", async () => {
  const f = fakeHost();
  await withRun({
    body: `const a = agent("one"); log("after one"); const b = agent("two"); const second = await b; log("two done"); return [await a, second]`,
  }, f, async (run2) => {
    assert.deepEqual(f.followUp, [{ agent: "one" }, { kind: "log", text: "after one" }, { agent: "two" }], "reported before the script waits for the first time");
    f.respond("two", 2);
    await run2.quiet();
    assert.deepEqual(f.followUp.at(-1), { kind: "log", text: "two done" });
    f.respond("one", 1);
    const r = await run2.end;
    assert.deepEqual(r.returnValue, [1, 2]);
    assert.deepEqual(f.calls.map((a) => [a.n, a.prompt]), [[1, "one"], [2, "two"]]);
  });
});

test(`cap: agent() number ${AGENT_CAP + 1} and parallel()/pipeline() with ${LIST_CAP + 1} entries throw with the cap wording`, async () => {
  const cap = await run({
    body: `const ps = []; for (let i = 0; i < ${AGENT_CAP + 1}; i++) ps.push(agent("a" + i));
      try { await ps[${AGENT_CAP}]; return "no cap"; } catch (e) { return e.name + ": " + e.message; }`,
  }, () => null);
  assert.equal(cap.returnValue, `WorkflowAgentCapError: ${AGENT_CAP_TEXT}`);
  assert.equal(cap.calls.length, AGENT_CAP, "the call above the cap does not even report");
  assert.match(AGENT_CAP_TEXT, new RegExp(`^This run has made ${AGENT_CAP} agent\\(\\) calls, `));
  const list = `array length ${LIST_CAP + 1} exceeds the maximum of ${LIST_CAP} supported across the workflow VM boundary`;
  for (const call of [
    `parallel(Array.from({ length: ${LIST_CAP + 1} }, () => () => 1))`,
    `pipeline(Array.from({ length: ${LIST_CAP + 1} }, (_, i) => i), (x) => x)`,
  ]) {
    const r = await run({ body: `try { await ${call}; return "no cap"; } catch (e) { return e.message; }` });
    assert.equal(r.returnValue, list, call);
  }
  const exactly = await run({ body: `return (await parallel(Array.from({ length: ${LIST_CAP} }, () => () => 1))).length` });
  assert.equal(exactly.returnValue, LIST_CAP, "exactly at the cap it still works");
});

test("meta: a non-literal meta is rejected BEFORE execution; a syntax error that the TypeScript parser silently repairs is reported anyway", async () => {
  const cases = [
    ['{ name: NAME, description: "d" }', "meta must be a pure literal: non-literal node type in meta: Identifier"],
    ['{ name: log("ran"), description: "d" }', "meta must be a pure literal: non-literal node type in meta: CallExpression"],
    ['{ name: `n-${1}`, description: "d" }', "meta must be a pure literal: template interpolation not allowed in meta"],
    ['{ ...BASIS, description: "d" }', "meta must be a pure literal: only plain properties allowed in meta"],
    ['{ [K]: "n", description: "d" }', "meta must be a pure literal: computed keys not allowed in meta"],
    ['{ name: "n", description: "d", phases: [...P] }', "meta must be a pure literal: spread not allowed in meta"],
    ['{ description: "d" }', "meta.name must be a non-empty string"],
  ];
  for (const [literal, wording] of cases) {
    const r = await run({ script: `export const meta = ${literal}\nlog("body ran")\nreturn 1` });
    assert.deepEqual([r.ok, r.error?.kind, r.error?.text], [false, "meta", wording], literal);
    assert.deepEqual(r.events, [], `${literal}: nothing ran`);
  }
  const front = await run({ script: `log("first")\nexport const meta = { name: "n", description: "d" }` });
  assert.deepEqual([front.error?.kind, front.error?.text], ["meta", ERROR_FIRST_INSTRUCTION]);
  assert.deepEqual(front.events, []);
  const without = await run({ script: `const meta = { name: "n", description: "d" }\nreturn 1` });
  assert.deepEqual([without.error?.kind, without.error?.text], ["meta", ERROR_FIRST_INSTRUCTION]);

  // The TypeScript parser repairs silently: it delivers a tree including meta — V8 decides.
  const repaired = 'export const meta = { name: "n", description: "d" }\nconst x = ;\nreturn 1';
  const ts = createRequire(import.meta.url)("typescript");
  const source = ts.createSourceFile("w.js", repaired, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.statements.length, 3, "the parser builds all three statements despite the error");
  const r = await run({ script: repaired });
  assert.equal(r.error?.kind, "syntax");
  assert.match(r.error.text, /^Script parse error: Unexpected token ';'\. Workflow scripts must be plain JavaScript/);

  const gut = startScript({ script: 'export const meta = { name: "n", description: "d", whenToUse: "w", phases: [{ title: "A", detail: "x" }, { nope: 1 }], extra: -1 }\nreturn 1', host: fakeHost().host });
  gut.abort();
  assert.deepEqual(json(gut.meta), { name: "n", description: "d", whenToUse: "w", phases: [{ title: "A", detail: "x" }] });
});

test("phase() and log() reach the host as events in script order; args comes from the input; budget in the baseline's form", async () => {
  const body = `phase("Scan"); log("one"); const r = await agent("x"); phase({}); log(42); console.log("c", { a: 1 }); console.warn("w");
    return { args, realArray: args.value instanceof Array, r, total: budget.total, spent: budget.spent(), rest: budget.remaining(),
      infinite: budget.remaining() === Infinity, fixed: Object.isFrozen(budget), key: Object.keys(budget) }`;
  const without = await run({ body, args: { value: [1, 2] } }, () => "R");
  assert.equal(without.ok, true, without.error?.text);
  assert.deepEqual(without.events, [
    { kind: "phase", title: "Scan" }, { kind: "log", text: "one" }, { kind: "phase", title: "[object]" },
    { kind: "log", text: "42" }, { kind: "log", text: 'c {"a":1}' }, { kind: "log", text: "[warn] w" },
  ]);
  assert.equal(without.calls[0].phase, "Scan", "an agent() without opts.phase belongs to the current phase");
  assert.deepEqual(without.returnValue, { args: { value: [1, 2] }, realArray: true, r: "R", total: null, spent: 0, rest: null, infinite: true, fixed: true, key: ["total", "spent", "remaining"] });
  const including = await run({ body: "return [budget.total, budget.spent(), budget.remaining(), typeof args]", budget: { total: 1000, consumed: () => 300 } });
  assert.deepEqual(including.returnValue, [1000, 300, 700, "undefined"]);
});

test("the prohibitions under Node (gate): clock, randomness, code generation, deleted globals, import() — with their wording", async () => {
  const actual = await checkProhibitions();
  assert.deepEqual(actual, PROHIBITIONS.map((v) => ({ name: v.name, result: v.error ? { error: v.error } : v.expected })));
});

test("abort: a waiting script ends with \"Workflow aborted\", a late answer no longer reaches it", async () => {
  const f = fakeHost();
  const run2 = startScript({ body: `const r = await agent("hangs"); log("never " + r); return r`, host: f.host });
  await run2.quiet();
  run2.abort();
  const r = await run2.end;
  assert.deepEqual([r.ok, r.error.kind, r.error.text], [false, "abort", "Workflow aborted"]);
  f.respond("hangs", "late");
  await run2.quiet();
  assert.deepEqual(f.events, []);
});

// Deviation from the baseline: the limit applies to EVERY section between two wait points, not only the start — after an
// answer of the host, in a tick of parallel(), in a timer callback. The limit is an argument here (200 ms), it waits for the
// end of the run, not for a clock. Under `node --test` an async_hook is active — exactly there Node aborts hard (SIGABRT)
// when the callback closes, without healAsyncStack.
// Counter-tests: remove `timeout` from the pump => the first case hangs (the loop holds the process; ended from outside
// after 25 s); remove `healAsyncStack` => SIGABRT of the file.
test("time limit per section: a loop after the first wait, in parallel() and in a timer ends as \"deadline\" with the limit in the text", async () => {
  for (const [like, body] of [
    ["after the host's answer", `await agent("a"); for (;;) {}`],
    ["in the branch of parallel()", `await parallel([() => { for (;;) {} }]); return 1`],
    // Two timers of the same delay fire in creation order: the looping one before the one the script waits for.
    ["in the timer callback", `setTimeout(() => { for (;;) {} }, 0); await new Promise((r) => setTimeout(r, 0)); return 1`],
  ]) {
    const r = await run({ body, sectionDeadlineMs: 200 }, () => "R");
    assert.deepEqual([r.ok, r.error?.kind], [false, "deadline"], `${like}: ${JSON.stringify(r.error)}`);
    assert.equal(r.error.text, deadlineText(200), like);
    assert.match(r.error.text, /200 ms/, `${like}: the text names the limit`);
  }
  // If the script only waits, the limit stays untouched — also across many sections.
  const ok = await run({ body: `let s = 0; for (let i = 0; i < 50; i++) s += (await agent("x" + i)).length; return s`, sectionDeadlineMs: 200 }, () => "RR");
  assert.deepEqual([ok.ok, ok.returnValue], [true, 100], JSON.stringify(ok.error));
});

// The unhandled rejection of a SCRIPT-OWNED promise reaches the process. The run catches it and ends as failed with the error
// text; the process keeps running. In a process of its own (dynworkflows-harness.mjs checkRejection): there the catcher is the
// only listener, as in the server.
// Counter-test: the catcher registers nothing (empty unregister) => the child process dies of the rejection (exit != 0) => red.
test("unhandled rejection in the script: the run ends as \"runtime\" with the error text, the process lives on, the catcher is gone again", async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const subprocess = spawn(process.execPath, [path.join(HERE, "dynworkflows-harness.mjs"), "rejection"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  subprocess.stdout.on("data", (d) => { out += d; });
  subprocess.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => subprocess.on("close", r));
  assert.equal(code, 0, `the process died (exit ${code}): ${err.slice(-800)}`);
  const { result, alive } = JSON.parse(out.trim().split("\n").at(-1));
  assert.equal(alive, true);
  assert.deepEqual([result.end.ok, result.end.error.kind, result.end.error.name], [false, "runtime", "UnhandledRejection"]);
  assert.match(result.end.error.text, /boom im Skript/);
  // A rejection that the script catches itself is none.
  assert.deepEqual(result.caught, { ok: true, returnValue: "gefangen x" });
  // After the runs nobody listens any more: Node behaves as without workflows again.
  assert.equal(result.listeners, 0);
});

// After the script's end the context never runs again: an un-awaited `agent(…).then(…)` would answer after the catcher was
// unregistered, the continuation would still run in the context, its throw would be an unhandled rejection without a
// listener — the backend process would die. A process of its own as above (the test runner would otherwise listen itself).
// Counter-test: remove the line `past = true;` in `end2.finally` in sandbox.js => the child process dies (exit 1, "is not
// valid JSON") => red.
test("after the script's end (ok or runtime error) a late agent() answer no longer reaches the context: the process lives, the continuation starts nothing", async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const subprocess = spawn(process.execPath, [path.join(HERE, "dynworkflows-harness.mjs"), "afterRun"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  subprocess.stdout.on("data", (d) => { out += d; });
  subprocess.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => subprocess.on("close", r));
  assert.equal(code, 0, `the process died (exit ${code}): ${err.slice(-800)}`);
  const { result, alive } = JSON.parse(out.trim().split("\n").at(-1));
  assert.equal(alive, true);
  assert.deepEqual(result, [
    // listenersPrior 0: the answer only came when the catcher was demonstrably gone — exactly the path of the finding.
    { name: "ok", ok: true, kind: null, listenersPrior: 0, calls: ["a"] },
    { name: "runtime", ok: false, kind: "runtime", listenersPrior: 0, calls: ["b"] },
    // A continuation that would call another agent after the end does not start it (the core is closed by then).
    { name: "fortsetzung ruft agent", ok: true, kind: null, listenersPrior: 0, calls: ["c"] },
  ]);
});

// ── workflow(): a saved workflow as a sub-step ─────────────────────────────────────────────
// 1:1 as in the baseline (guide 2.1.280): the child shares cap, counter, abort and budget with the parent run, its agent()
// calls reach the same host (carrying its name there), the child's `args` is the second argument, and a workflow() in the
// child throws. Counter-test: replace the child's own `workflow` by the parent script's (sandbox.js child start:
// `nested` → `workflow`) => "one level" is red.
const kindScript = (name, body) => `export const meta = { name: '${name}', description: 'Building block' }\n${body}\n`;

test("workflow(): the child runs as a sub-step — its own args and phase, its agent() at the same host with its name, the return value arrives in the parent script", async () => {
  const f = fakeHost({
    auto: (a) => `R:${a.prompt}`,
    workflows: { kind: kindScript("kind", `phase("Child-phase"); const x = await agent("k " + args.value); return { x, args, type: typeof args.list.map };`) },
  });
  await withRun({ body: `phase("Parent"); const a = await agent("e1"); const k = await workflow("kind", { value: 7, list: [1] });
      const b = await agent("e2"); return { a, k, b, args: args ?? null };` }, f, async (run2) => {
    const r = await run2.end;
    assert.equal(r.ok, true, r.error?.text);
    assert.deepEqual(r.returnValue, { a: "R:e1", k: { x: "R:k 7", args: { value: 7, list: [1] }, type: "function" }, b: "R:e2", args: null });
    assert.deepEqual(f.calls.map((a) => [a.n, a.prompt, a.phase, a.workflow]), [[1, "e1", "Parent", undefined], [2, "k 7", "Child-phase", "kind"], [3, "e2", "Parent", undefined]],
      "one counter for both; the child has its phase, the parent script keeps its own");
    assert.equal(r.agentCount, 3);
  });
});

test("workflow() in the called workflow throws (one level as in the baseline); an unknown name throws with the list of available ones; wrong form and syntax errors of the child throw", async () => {
  const f = fakeHost({
    auto: () => "R",
    workflows: {
      kind: kindScript("kind", `try { await workflow("enkel"); return "nested ran"; } catch (e) { return e.message; }`),
      grandchild: kindScript("grandchild", `return await agent("grandchild-agent");`),
      broken: kindScript("broken", `return (;`),
    },
  });
  await withRun({ body: `const fang = async (p) => { try { return await p; } catch (e) { return e.name + ": " + e.message; } };
      return [await fang(workflow("kind")), await fang(workflow("exists-not")), await fang(workflow(42)), await fang(workflow("broken"))];` }, f, async (run2) => {
    const r = await run2.end;
    assert.equal(r.ok, true, r.error?.text);
    assert.equal(r.returnValue[0], NESTED_TEXT);
    assert.equal(r.returnValue[1], "Error: workflow('exists-not'): no workflow with that name. Available: kind, grandchild, broken");
    assert.equal(r.returnValue[2], `TypeError: ${WORKFLOW_FORM_TEXT}`);
    assert.match(r.returnValue[3], /^Error: .*SyntaxError|^Error: .*Unexpected token/);
    assert.deepEqual(f.calls, [], "the grandchild never started an agent");
    assert.ok(!f.followUp.some((x) => x.workflow === "grandchild"), "the grandchild was not even looked up");
  });
});

test(`workflow(): parent and child share the cap of ${AGENT_CAP} agent() — together above it the first call above the cap in the child throws`, async () => {
  const f = fakeHost({
    auto: () => null,
    workflows: { kind: kindScript("kind", `const ps = []; for (let i = 0; i < 401; i++) ps.push(agent("k" + i));
      try { await ps[400]; return "no cap"; } catch (e) { return e.name; }`) },
  });
  await withRun({ body: `for (let i = 0; i < 600; i++) agent("e" + i); return await workflow("kind");` }, f, async (run2) => {
    const r = await run2.end;
    assert.equal(r.ok, true, r.error?.text);
    assert.equal(r.returnValue, "WorkflowAgentCapError");
    assert.equal(f.calls.length, AGENT_CAP);
  });
});

test("workflow(): parent and child share budget (same total, same consumption, same throw) and the abort (the child's open agents no longer reach the script)", async () => {
  let spent = 0;
  const f = fakeHost({
    auto: () => { spent += 6; return "R"; },
    workflows: { kind: kindScript("kind", `const a = await agent("k1"); try { await agent("k2"); return "no budget"; } catch (e) { return [budget.total, budget.spent(), e.name]; }`) },
  });
  await withRun({ body: `await agent("e1"); return await workflow("kind");`, budget: { total: 12, consumed: () => spent } }, f, async (run2) => {
    const r = await run2.end;
    assert.equal(r.ok, true, r.error?.text);
    assert.deepEqual(r.returnValue, [12, 12, "WorkflowBudgetExceededError"]);
    assert.deepEqual(f.calls.map((a) => a.prompt), ["e1", "k1"]);
  });
  const g = fakeHost({ workflows: { kind: kindScript("kind", `const a = await agent("hangs"); log("never " + a); return await agent("after");`) } });
  await withRun({ body: `return await workflow("kind");` }, g, async (run2) => {
    await run2.quiet();
    assert.deepEqual(g.openPrompts(), ["hangs"]);
    run2.abort();
    const r = await run2.end;
    assert.deepEqual([r.ok, r.error.kind], [false, "abort"]);
    g.respond("hangs", "late");
    await run2.quiet();
    assert.deepEqual(g.calls.map((a) => a.prompt), ["hangs"], "after the abort the child starts nothing any more");
    assert.deepEqual(g.events, []);
  });
});

// ── Lanes (journal.js "branches") ──────────────────────────────────────────────────────
// The sandbox tells the host in WHICH lane an agent() was called: parallel()/pipeline() fork (synchronously at the call), every
// thunk or element runs in its slot — across every `await`, even if the continuation runs from the answer of a FOREIGN agent,
// from a timer or from the start of a child (workflow()). Carried through AsyncLocalStorage across the vm boundary
// (sandbox.js header). The keys themselves are bound to the real journal by dynworkflows-journal.test.js; here the mapping
// call → lane stands for the paths the fixture script does not take.
// Counter-tests: the body starts without a root lane (`run = los()`) => red (calls behind the first `await` without a lane or
// in the lane of the random answerer); `inSlot` calls `f()` without `lanes.run` => red (everything in the root); `fork`
// passes `null` instead of `laneNow()` (nested hangs on the root) => red.
function laneHost({ workflows = {} } = {}) {
  const calls = []; // [prompt, lane]
  const forks = []; // [variety, parent lane]
  const connected = [];
  const open = new Map();
  const name = (b) => (b === null ? "root" : b.name);
  return {
    calls, forks, connected,
    respond(prompt, value) { const r = open.get(prompt); assert.ok(r, `offen: ${prompt} (open: ${[...open.keys()]})`); open.delete(prompt); r(value); },
    open: () => [...open.keys()].sort(),
    host: {
      fork(lane, variety) {
        const seq = forks.push([variety, name(lane)]);
        return { slot: (i) => ({ name: `${name(lane)}>${variety}${seq}[${i}]` }), connect: () => { connected.push(seq); } };
      },
      agent(a, lane) { calls.push([a.prompt, name(lane)]); return new Promise((r) => open.set(a.prompt, r)); },
      workflow({ name: n }) { return { script: workflows[n], name: n }; },
    },
  };
}

test("lanes: every agent() reports its thunk's lane — across await, foreign answers, timers, then chains, a child (workflow()) and nested; the fork stands at the call, connecting happens after all slots", async () => {
  const w = laneHost({ workflows: { kind: kindScript("kind", `const k = await agent("in-child"); return k;`) } });
  const run2 = startScript({
    body: `const before = await agent("before");
      const open = parallel([
        async () => { await new Promise((r) => setTimeout(r, 0)); const a = await agent("t1"); return agent("t2 " + a); },
        async () => { const k = await workflow("kind"); return agent("after-child " + k); },
        () => agent("c1").then((c) => agent("c2 " + c)),
        async () => { const [x] = await parallel([() => agent("inside")]); const p = await pipeline(["e"], (e) => agent("stage1 " + e), (r) => agent("stage2 " + r)); return agent("after-inside " + x + p[0]); },
      ]);
      const beside = await agent("beside");
      const r = await open;
      const after = await agent("after");
      return { before, beside, r, after };`,
    host: w.host,
  });
  try {
    // Answers always in REVERSED order of the open calls — every continuation thus runs from another one's evaluation.
    for (;;) {
      await run2.quiet();
      const open = w.open();
      if (!open.length) break;
      for (const p of open.reverse()) w.respond(p, p.split(" ")[0].toUpperCase());
    }
    const r = await run2.end;
    assert.equal(r.ok, true, r.error?.text);
    assert.equal(run2.withoutLane(), 0);
    const P = "root>parallel1";
    assert.deepEqual(Object.fromEntries(w.calls), {
      before: "root", beside: "root", after: "root",
      t1: `${P}[0]`, "t2 T1": `${P}[0]`,
      "in-child": `${P}[1]`, "after-child IN-CHILD": `${P}[1]`,
      c1: `${P}[2]`, "c2 C1": `${P}[2]`,
      inside: `${P}[3]>parallel2[0]`, "stage1 e": `${P}[3]>pipeline3[0]`, "stage2 STAGE1": `${P}[3]>pipeline3[0]`, "after-inside INSIDESTAGE2": `${P}[3]`,
    });
    assert.deepEqual(w.forks, [["parallel", "root"], ["parallel", `${P}[3]`], ["pipeline", `${P}[3]`]]);
    // The fork stood BEFORE "beside" was called (synchronously at the call of parallel()); connected inner before outer.
    assert.deepEqual(w.connected, [2, 3, 1]);
  } finally {
    run2.abort();
  }
});

test("lanes: without `host.fork` (linear chain) there are none — agent() gets null, parallel()/pipeline() run as before; an empty list and a form error fork but never connect (baseline)", async () => {
  const lanes = [];
  const without = startScript({
    body: `const r = await parallel([() => agent("a"), () => agent("b")]); const p = await pipeline([1], (x) => agent("c" + x)); return [r, p];`,
    host: { agent: (a, lane) => { lanes.push(lane); return a.prompt; } },
  });
  try {
    const r = await without.end;
    assert.deepEqual([r.ok, r.returnValue], [true, [["a", "b"], ["c1"]]]);
    assert.deepEqual(lanes, [null, null, null]);
  } finally { without.abort(); }
  const w = laneHost();
  const run2 = startScript({
    body: `const empty = await parallel([]); let error = ""; try { await pipeline("x"); } catch (e) { error = e.name; } return [empty, error];`,
    host: w.host,
  });
  try {
    const r = await run2.end;
    assert.deepEqual([r.ok, r.returnValue], [true, [[], "TypeError"]]);
    assert.deepEqual(w.forks, [["parallel", "root"], ["pipeline", "root"]]);
    assert.deepEqual(w.connected, []);
  } finally { run2.abort(); }
});

// The limit per section aborts a microtask IN THE MIDDLE of a slot (between the host frame `lanes.run` and the thunk): the
// run ends as "deadline", the process lives, and the next run carries its lanes untouched (one storage per run).
test("lanes: the time limit per section in a slot of parallel() and pipeline() ends as \"deadline\" — the next run carries its lanes as before", async () => {
  for (const body of [`await agent("a"); await parallel([() => agent("b"), () => { for (;;) {} }]); return 1`, `await pipeline([1], async (x) => { await agent("c"); for (;;) {} }); return 1`]) {
    const w = laneHost();
    const run2 = startScript({ body, sectionDeadlineMs: 200, host: { ...w.host, agent: (a, lane) => { w.calls.push([a.prompt, lane === null ? "root" : lane.name]); return "R"; } } });
    try {
      const r = await run2.end;
      assert.deepEqual([r.ok, r.error?.kind], [false, "deadline"], JSON.stringify(r.error));
      assert.equal(run2.withoutLane(), 0);
    } finally { run2.abort(); }
  }
  const w = laneHost();
  const afterwards = startScript({ body: `const r = await parallel([async () => { await agent("x"); return agent("y"); }]); return [r, await agent("z")];`, host: { ...w.host, agent: (a, lane) => { w.calls.push([a.prompt, lane === null ? "root" : lane.name]); return a.prompt; } } });
  try {
    const r = await afterwards.end;
    assert.deepEqual([r.ok, r.returnValue], [true, [["y"], "z"]]);
    assert.deepEqual(w.calls, [["x", "root>parallel1[0]"], ["y", "root>parallel1[0]"], ["z", "root"]]);
    assert.equal(afterwards.withoutLane(), 0);
  } finally { afterwards.abort(); }
});
