// The concurrency of the dynamic workflows at the main seam: real server, real cbase MCP server, real agent core, only the
// providers faked (harness of agent-harness.mjs). The unit (formula, slots, stagger) is in dynworkflows-cap.test.js.
//
// The caps are knobs: per run through CBASE_DYNWF_RUN_CAP (set per test here), per user through the route
// `/api/dyn-workflow-cap` (the setting from web and iOS). The stagger is 0 except in the stagger test. Checked at the event:
// gates instead of durations, journal instead of a time window.
//
// COUNTER-TESTS (each turns the named test red):
//   - removing `&& occupiedTotal < user` in cap.js distribute() (no cap per user) turns "main seam" red at "exactly three
//     agents run" (four run);
//   - computing the key in run.js only at completion instead of at the call turns "key chain" red;
//   - run.js coreOf with `own: false` (workflow agents in the core of the chat) turns "two counters" red ("Cap reached: ...
//     already 2 subagents");
//   - replacing the prefix-cache question in run.js by `true` turns "stagger" red (the engine waits).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { normOptions, key, branchKey } from "../electron/server/dynworkflows/journal.js";
import * as store from "../electron/server/store.js";

process.env.CBASE_DYNWF_STAGGER_MS = "0";

// The main agent: "WF[<tag>]:{json}" calls cbase_dynamic_workflow, "AG[<tag>]:{json}" cbase_agent, each with a call block
// like the real CLI; the tool result is stored afterwards under wf-<tag> or ag-<tag>.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    say({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  for (const [marker, tool, before] of [["WF[", "cbase_dynamic_workflow", "wf-"], ["AG[", "cbase_agent", "ag-"]]) {
    const i = text.indexOf(marker);
    if (i < 0) continue;
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_" + before.replace("-", "") + "_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + tool, input: args }] } });
    let t = "";
    try { const r = await mcpCall(tool, args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.writeFileSync(path.join(LOCATION, before + tag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    break;
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "done" }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;

// An agent (workflow agent or cbase_agent): {TAG:x} in the computed task, {GATE:x} holds it at the gate after the first
// event. Start and end stand as "+x"/"-x" in the shared log, from which the concurrency is derived.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "concurrent.log"), "+" + tag + "\\n");
    say({ type: "assistant", message: { id: "s1-" + tag, content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    fs.appendFileSync(path.join(LOCATION, "concurrent.log"), "-" + tag + "\\n");
    say({ type: "assistant", message: { id: "s2-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const patch = (url, body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
const ultracode = (base, chatId, on) => patch(`${base}/api/chats/${chatId}`, { model: "claude-opus-5-5", ultracode: on });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Cap', phases: [{ title: 'Read' }] }\n${body}\n`;
const parallelOf = (prompts) => `const r = await parallel([${prompts.map((p) => `() => agent(${JSON.stringify(p)})`).join(", ")}]);\nreturn r;`;

async function calls(ctx, kind, tag, args) {
  await post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text: `${kind}[${tag}]:${JSON.stringify(args)}` });
  const file = path.join(ctx.root, `${kind === "WF" ? "wf" : "ag"}-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  await turnPast(ctx); // busy stays true while agents live; the turn is over anyway
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
}
// The turn is over as soon as none runs any more (busy counts background agents, workflows not).
const turnPast = (ctx) => waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn finished");
async function startWf(ctx, tag, prompts) {
  await post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text: `WF[${tag}]:${JSON.stringify({ script: script(tag, parallelOf(prompts)) })}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(r.status, "started", JSON.stringify(r));
  await turnPast(ctx);
  return r;
}
// Each of the `count` agent() calls stands in the journal as started or waiting: the state in which the cap takes hold.
const settled = (runId, count) => waitForTruthy(() => {
  const j = store.readDynJournal(runId);
  const n = new Set(j.filter((e) => e.kind === "started" || e.kind === "waiting").map((e) => e.n));
  return n.size === count ? j : null;
}, `journal ${runId} settled`);
const finished = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} finished`);
const log = (root) => {
  const f = path.join(root, "concurrent.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
// Peak concurrency from the log, in total and per run (run = first letter of the tag).
function peak(rows) {
  const running = new Set();
  let total = 0;
  const perRun = {};
  for (const z of rows) {
    if (z[0] === "+") running.add(z.slice(1)); else running.delete(z.slice(1));
    total = Math.max(total, running.size);
    for (const l of new Set([...running].map((t) => t[0]))) perRun[l] = Math.max(perRun[l] || 0, [...running].filter((t) => t[0] === l).length);
  }
  return { total, perRun };
}
const started = (root) => new Set(log(root).filter((z) => z[0] === "+").map((z) => z.slice(1)));
const waiting = (j) => j.filter((e) => e.kind === "waiting").map((e) => [e.n, e.reason, e.cap]);
function withEnvironment(values) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) process.env[k] = String(v);
  return () => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

test("route: cap per user: default 8, without a field 400, invalid 400, a set value applies; the cap per run stands next to it", async () => {
  const back = withEnvironment({ CBASE_DYNWF_RUN_CAP: 5 });
  try {
    await withAgentsServer(async ({ base }) => {
      const url = `${base}/api/dyn-workflow-cap`;
      const empty = await json(url);
      assert.equal(empty.cap, 8);
      assert.equal(empty.preset, 8);
      assert.equal(empty.runCap, 5);
      for (const body of [{}, { enabled: true }, { cap: null }]) {
        const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match((await r.json()).error, /cap/);
      }
      for (const body of [{ cap: 0 }, { cap: "x" }, { cap: 1.5 }, { cap: 65 }]) {
        const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
        assert.equal(r.status, 400, JSON.stringify(body));
      }
      assert.equal((await json(url)).cap, 8, "a rejected body changes nothing");
      assert.deepEqual(await json(url, { method: "PUT", body: JSON.stringify({ cap: 4 }) }), { ok: true, cap: 4, preset: 8, runCap: 5 });
      assert.equal((await json(url)).cap, 4);
    });
  } finally { back(); }
});

test("main seam: cap 2 per run and 3 per user, two runs with three agent() each; never more than 2 of one run, never more than 3 in total; surplus ones \"wait\" with reason cap and start as soon as a slot is free", async () => {
  const back = withEnvironment({ CBASE_DYNWF_RUN_CAP: 2 });
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, root, gate } = ctx;
      await json(`${base}/api/dyn-workflow-cap`, { method: "PUT", body: JSON.stringify({ cap: 3 }) });
      await ultracode(base, chat.id, true);
      const A = await startWf(ctx, "a", ["A1 {TAG:a1} {GATE:a1}", "A2 {TAG:a2} {GATE:a2}", "A3 {TAG:a3} {GATE:a3}"]);
      const jA = await settled(A.runId, 3);
      const B = await startWf(ctx, "b", ["B1 {TAG:b1} {GATE:b1}", "B2 {TAG:b2} {GATE:b2}", "B3 {TAG:b3} {GATE:b3}"]);
      const jB = await settled(B.runId, 3);
      await Promise.all(["a1", "a2", "b1"].map((t) => gate.reached(t)));
      // Counted at the children that really run, not at the bookkeeping, which could claim the opposite.
      assert.deepEqual([...started(root)].sort(), ["a1", "a2", "b1"], "exactly three agents run");
      assert.deepEqual(waiting(jA), [[3, "cap", "run"]], "a3 waits for the cap of its run");
      assert.deepEqual(waiting(jB), [[2, "cap", "user"], [3, "cap", "user"]], "b2 and b3 wait for the cap per user");
      // A waiting call stands in the journal as such: not as started, not as finished.
      for (const [j, n] of [[jA, 3], [jB, 2], [jB, 3]]) assert.deepEqual(j.filter((e) => e.n === n).map((e) => e.kind), ["launched", "waiting"]);
      const active = await json(`${base}/api/runs/active`);
      assert.equal(active.dynWorkflows.length, 2, "both runs stand in the field of their own (no longer in busy)");

      // Slots become free one after the other, and exactly the next one in the queue starts.
      gate.open("a1");
      await gate.reached("a3"); // run A has a slot again, a3 stood before b2
      assert.deepEqual([...started(root)].sort(), ["a1", "a2", "a3", "b1"]);
      gate.open("b1");
      await gate.reached("b2");
      gate.open("a2");
      await gate.reached("b3");
      for (const t of ["a3", "b2", "b3"]) gate.open(t);
      const [eA, eB] = [await finished(A.runId), await finished(B.runId)];
      assert.equal(eA.status, "finished", eA.error);
      assert.equal(eB.status, "finished", eB.error);
      assert.deepEqual(eA.returnValue, ["Finding a1", "Finding a2", "Finding a3"]);
      assert.deepEqual(eB.returnValue, ["Finding b1", "Finding b2", "Finding b3"]);
      const h = peak(log(root));
      assert.equal(h.total, 3, `at most three at the same time, and the cap was reached: ${log(root).join(" ")}`);
      assert.deepEqual(h.perRun, { a: 2, b: 2 });
      // Every waiting call was started, AFTER its waiting entry.
      for (const runId of [A.runId, B.runId]) {
        const j = store.readDynJournal(runId);
        for (const n of [1, 2, 3]) {
          const kinds = j.filter((e) => e.n === n).map((e) => e.kind);
          assert.ok(["launched,started,result", "launched,waiting,started,result"].includes(kinds.join(",")), `${runId} ${n}: ${kinds}`);
        }
      }
      await ctx.waitForIdle();
    }, { claude });
  } finally { back(); }
});

// The key of a thunk of parallel() hangs on ITS slot (slot:i), not on the key of the one called before (journal.js branch
// chains). The promise of this test: it is fixed at the CALL, waiting and completion order do not change it.
test("key chain: waiting calls do not change it; reversed release order, the keys are still fixed at the call (per slot of parallel())", async () => {
  const back = withEnvironment({ CBASE_DYNWF_RUN_CAP: 2 });
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, root, gate } = ctx;
      await ultracode(base, chat.id, true);
      const prompts = ["C1 {TAG:c1} {GATE:c1}", "C2 {TAG:c2} {GATE:c2}", "C3 {TAG:c3} {GATE:c3}", "C4 {TAG:c4} {GATE:c4}"];
      const r = await startWf(ctx, "c", prompts);
      await settled(r.runId, 4);
      await Promise.all(["c1", "c2"].map((t) => gate.reached(t)));
      // Released backwards: first c2, then c1; c3 gets the slot of c2, c4 that of c1.
      gate.open("c2");
      await gate.reached("c3");
      gate.open("c1");
      await gate.reached("c4");
      gate.open("c4");
      await waitForTruthy(() => store.readDynJournal(r.runId).some((e) => e.kind === "result" && e.n === 4), "c4 done before c3");
      gate.open("c3");
      const end = await finished(r.runId);
      assert.equal(end.status, "finished", end.error);
      assert.deepEqual(end.returnValue, ["Finding c1", "Finding c2", "Finding c3", "Finding c4"], "the return value in call order");
      assert.equal(log(root).filter((z) => z[0] === "+").length, 4, "every agent started exactly once");
      const norm = normOptions({}, { model: "claude::claude-opus-5-5" });
      const keys = prompts.map((p, i) => key(branchKey("", "parallel", i), p, norm));
      const j = store.readDynJournal(r.runId);
      for (const e of j) assert.equal(e.key, keys[e.n - 1], `${e.kind} ${e.n}`);
      assert.deepEqual(waiting(j), [[3, "cap", "run"], [4, "cap", "run"]]);
      // Completion was c2, c1, c4, c3; the chain still stands in 1, 2, 3, 4.
      assert.deepEqual(j.filter((e) => e.kind === "result").map((e) => e.n), [2, 1, 4, 3]);
      assert.deepEqual(j.filter((e) => e.kind === "launched").map((e) => e.key), keys);
      await ctx.waitForIdle();
    }, { claude });
  } finally { back(); }
});

test("two counters: a background subagent takes no slot of the workflow caps, a workflow agent none of the cap per chat", async () => {
  const back = withEnvironment({ CBASE_DYNWF_RUN_CAP: 16, CBASE_AGENT_CAP: 2 });
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, gate } = ctx;
      await json(`${base}/api/dyn-workflow-cap`, { method: "PUT", body: JSON.stringify({ cap: 1 }) });
      await ultracode(base, chat.id, true);
      const h1 = await calls(ctx, "AG", "h1", { description: "On the side", prompt: "Task {TAG:h1} {GATE:h1}", run_in_background: true });
      assert.ok(!h1.error, JSON.stringify(h1));
      await gate.reached("h1");
      // Cap per user 1, a cbase_agent lives: the workflow agent starts at once anyway.
      const w = await startWf(ctx, "w", ["W1 {TAG:w1} {GATE:w1}", "W2 {TAG:w2} {GATE:w2}"]);
      const j = await settled(w.runId, 2);
      assert.deepEqual(waiting(j), [[2, "cap", "user"]], "w1 runs, w2 waits; the subagent does not count");
      await gate.reached("w1");
      // Cap per chat 2, plus a workflow agent: a second cbase_agent still works (without Ultracode the cap applies).
      await ultracode(base, chat.id, false);
      const h2 = await calls(ctx, "AG", "h2", { description: "On the side two", prompt: "Task {TAG:h2} {GATE:h2}", run_in_background: true });
      assert.ok(!h2.error, `the workflow agent took a slot of the cap per chat: ${h2.error}`);
      await gate.reached("h2");
      // Counterpart: now there are two subagents of the chat; the third falls at the cap per chat, not at the workflow.
      const h3 = await calls(ctx, "AG", "h3", { description: "On the side three", prompt: "Task {TAG:h3}", run_in_background: true });
      assert.match(h3.error || "", /Cap reached/);
      for (const t of ["h1", "h2", "w1"]) gate.open(t);
      await gate.reached("w2");
      gate.open("w2");
      assert.equal((await finished(w.runId)).status, "finished");
      await ctx.waitForIdle();
    }, { claude });
  } finally { back(); }
});

test("stagger: similar Claude agents start after the first event of the first (\"waits\", reason stagger), an engine without prefix cache is not delayed", async () => {
  // One hour deadline: resolved only by the event of the first, never by the clock.
  const back = withEnvironment({ CBASE_DYNWF_RUN_CAP: 16, CBASE_DYNWF_STAGGER_MS: 3_600_000 });
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, gate, engine } = ctx;
      await ultracode(base, chat.id, true);
      const body = [
        "const r = await parallel([",
        "  () => agent('S1 {TAG:s1} {GATE:s1}'),",
        "  () => agent('S2 {TAG:s2}'),",
        `  () => agent('E1', { model: ${JSON.stringify(engine.model)} }),`,
        `  () => agent('E2', { model: ${JSON.stringify(engine.model)} }),`,
        "]);",
        "return r;",
      ].join("\n");
      await post(`${base}/api/chats/${chat.id}/message`, { text: `WF[s]:${JSON.stringify({ script: script("stagger", body) })}` });
      await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "wf-s")), "tool result s");
      const r = JSON.parse(fs.readFileSync(path.join(ctx.root, "wf-s"), "utf8"));
      assert.equal(r.status, "started", JSON.stringify(r));
      // s1 stands at the gate AFTER its first event. s2 is done anyway: the event released it.
      await gate.reached("s1");
      await waitForTruthy(() => store.readDynJournal(r.runId).filter((e) => e.kind === "result" && e.n !== 1).length === 3, "s2, e1, e2 done");
      const j = store.readDynJournal(r.runId);
      assert.deepEqual(waiting(j), [[2, "stagger", undefined]], "only s2 waits for the first of its prefix; the engine starts undelayed");
      assert.deepEqual(j.filter((e) => e.n === 2).map((e) => e.kind), ["launched", "waiting", "started", "result"]);
      gate.open("s1");
      const end = await finished(r.runId);
      assert.equal(end.status, "finished", end.error);
      assert.deepEqual(end.returnValue.slice(0, 2), ["Finding s1", "Finding s2"]);
      await ctx.waitForIdle();
    }, { claude, engine: true });
  } finally { back(); }
});
