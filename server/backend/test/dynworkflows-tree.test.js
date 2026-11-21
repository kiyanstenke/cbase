// The progress tree of a dynamic workflow at the main seam — real server, real cbase MCP server, real agent core; only
// the providers are fakes. Checked is the view (dynworkflows/tree.js via run.js dynTree) on BOTH paths: the route
// `GET /api/chats/:id/dyn-workflows/tree` and the `dynwf_tree` event in the chat stream — after every step both show the
// same state (reload = live). The client's tree computation (bands, n/m, display word) is checked by
// web/test/dyn-tree.test.mjs.
//
// The stream is read without a socket: a subscriber in `streams` (runtime/sse.js) — the server writes there as to an
// open response; there is no connection left hanging in the finally.
//
// Skipping is the stop of ONE workflow agent, through its route
// (`POST …/dyn-workflows/runs/:runId/agents/:n/skip`; the seam itself is checked by dynworkflows-interventions.test.js).
//
// Counter-tests (which sabotage turns which test red):
//   - tree.js agentState not reading the marker `skipped` (a skipped agent reads "error") => "main seam" red;
//   - run.js reportTree without `run2.treeScheduled = false` (only the FIRST report goes out) => both tests red at "the
//     event shows the same state as the route" (dropping reportTree in the marker alone stays green: the last journal
//     entry's report falls into the same tick as the end and carries it — the line there is a safeguard);
//   - tree.js `logsTruncated: 0` (the cap stays silent) => "log() line cap" red;
//   - run.js dynTree without `cap` passed to treeView (the numbers never arrive) => "main seam" red at "the numbers of
//     both caps on the running run";
//   - tree.js capCounts without the condition `status !== "running"` => "cap on the run" red at "no number on the
//     finished run";
//   - tree.js capCounts without `wholeNumber(…)` (every number passes) => "cap on the run" red at "no number that is not
//     a whole number ≥ 1".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { LOG_CAP, treeView } from "../electron/server/dynworkflows/tree.js";
import { streams } from "../electron/server/runtime/sse.js";
import * as store from "../electron/server/store.js";

process.env.CBASE_DYNWF_STAGGER_MS = "0";

const MAIN = `
  if (text.startsWith("<task-notification>")) {
    say({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const i = text.indexOf("WF[");
  if (i >= 0) {
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test waits only for existence
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "done" }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;

// {TAG:x} in the job, {GATE:x} holds the agent at the gate after its first event.
const SUB = `
    const cut = text.lastIndexOf("Here is the task:");
    const job = cut >= 0 ? text.slice(cut) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    say({ type: "assistant", message: { id: "s1-" + tag, content: [{ type: "text", text: "working on " + tag }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "s2-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });

function withEnvironment(values) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) process.env[k] = String(v);
  return () => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

// A subscriber of the chat stream without a socket: collects the dynwf_tree events per run (the newest counts).
function listener(chatId) {
  const trees = new Map();
  const all = [];
  const subscription = {
    write(row) {
      const m = /^data: (.*)\n\n$/s.exec(row);
      if (!m) return;
      const e = JSON.parse(m[1]);
      if (e.type === "harness" && e.subtype === "dynwf_tree") { trees.set(e.tree.runId, e.tree); all.push(e.tree); }
    },
  };
  const subs = streams.get(chatId) ?? new Set();
  streams.set(chatId, subs);
  subs.add(subscription);
  return { trees, all, unsubscribe: () => subs.delete(subscription) };
}

async function startWf(ctx, tag, script) {
  await post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text: `WF[${tag}]:${JSON.stringify({ script })}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(r.status, "started", JSON.stringify(r));
  return r;
}

const state = (tree) => Object.fromEntries(tree.agents.map((a) => [a.label, a.status]));
const tick = () => new Promise((r) => setImmediate(r));
// A journal state to wait for — NEVER the view's own state: whoever waits for the thing under test hangs under a
// sabotage instead of turning red.
const journalHas = (runId, check, what) => waitForTruthy(() => check(store.readDynJournal(runId)), what);
const contains = (j, n, kind) => j.some((e) => e.n === n && e.kind === kind);
// Route and event on the QUIET run (all agents at the gate or done): the same route twice with a tick between — by then
// the bundled report (ONE setImmediate per change) is long written, and the event MUST be equal.
async function quiet(ctx, l, runId) {
  const route = async () => (await json(`${ctx.base}/api/chats/${ctx.chat.id}/dyn-workflows/tree`)).runs.find((b) => b.runId === runId);
  for (;;) {
    const r1 = await route();
    await tick();
    const r2 = await route();
    if (JSON.stringify(r1) !== JSON.stringify(r2)) continue;
    await tick();
    assert.deepEqual(l.trees.get(runId), r2, "the event shows the same state as the route (reload = live)");
    return r2;
  }
}

test("main seam: two phases, three agents, one log() — route and event show header, phases, agents with state (waiting, running, skipped, finished) and log() lines alike; the transcript per agent", async () => {
  // The per-user cap differs from the default (8), so the number on the run proves it is the one IN EFFECT.
  const back = withEnvironment({ CBASE_DYNWF_RUN_CAP: 2, CBASE_DYNWF_USER_CAP: 5 });
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, gate } = ctx;
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
      const empty = await json(`${base}/api/chats/${chat.id}/dyn-workflows/tree`);
      assert.deepEqual(empty, { runs: [], additional: 0 }, "a chat without a workflow: an empty list that was READ");
      const l = listener(chat.id);
      try {
        const script = [
          "export const meta = { name: 'tree', description: 'Tree', phases: [{ title: 'Read' }, { title: 'Check' }] }",
          "phase('Read')",
          "log('here we go')",
          "const r = await parallel([",
          "  () => agent('A {TAG:a} {GATE:a}', { label: 'Reader A' }),",
          "  () => agent('B {TAG:b} {GATE:b}', { label: 'Reader B' }),",
          "  () => agent('C {TAG:c} {GATE:c}', { label: 'Checker C', phase: 'Check' }),",
          "])",
          "return r",
        ].join("\n");
        const wf = await startWf(ctx, "t1", script);
        await Promise.all(["a", "b"].map((t) => gate.reached(t)));
        // Cap 2 per run: A and B run, C waits for a slot.
        await journalHas(wf.runId, (j) => contains(j, 1, "started") && contains(j, 2, "started") && contains(j, 3, "waiting"), "A and B started, C waiting");
        const b1 = await quiet(ctx, l, wf.runId);
        assert.equal(b1.name, "tree");
        assert.equal(b1.description, "Tree", "meta.description is the run's description");
        assert.equal(b1.status, "running");
        assert.equal(b1.taskId, wf.taskId);
        assert.equal(b1.phase, "Read", "the current phase is the last phase() line");
        assert.deepEqual(b1.phases, ["Read", "Check"]);
        assert.deepEqual(b1.logs.map((z) => [z.text, z.phase]), [["here we go", "Read"]]);
        assert.equal(b1.logsTruncated, 0);
        assert.deepEqual(b1.agents.map((a) => [a.n, a.label, a.phase, a.status]), [
          [1, "Reader A", "Read", "running"], [2, "Reader B", "Read", "running"], [3, "Checker C", "Check", "waiting"],
        ]);
        const c1 = b1.agents[2];
        assert.equal(c1.reason, "cap");
        assert.equal(c1.cap, "run");
        // The reason for waiting is visible: on the running run the NUMBERS of both caps in effect now — the client turns
        // them into "waiting · 2 at a time" (web/src/lib/dyn-tree.ts).
        assert.deepEqual(b1.cap, { run: 2, user: 5 }, "the numbers of both caps on the running run");
        for (const a of b1.agents) assert.equal(a.provider, "claude", `${a.label}: provider`);
        assert.ok(b1.agents[0].agentId && b1.agents[1].agentId, "running agents carry their agentId");
        assert.equal(c1.agentId, "", "a waiting one has none yet");
        // Time per agent: started ones carry `startedAt` (their `started` in the journal), no end yet; the waiting one has
        // no start — its row shows no time instead of counting the wait as work time.
        const jStart = (n) => store.readDynJournal(wf.runId).find((e) => e.n === n && e.kind === "started")?.at;
        for (const a of b1.agents.slice(0, 2)) {
          assert.equal(a.startedAt, jStart(a.n), `${a.label}: startedAt is the time of its first “started”`);
          assert.ok(!("endedAt" in a), `${a.label}: still running, no endedAt`);
        }
        assert.ok(!("startedAt" in c1) && !("endedAt" in c1), "the waiting one carries no time");

        // Skip B (the stop of ONE workflow agent): it counts as failed in the journal, the tree says "skipped" — and C
        // gets its slot.
        const sp = await post(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${wf.runId}/agents/2/skip`, {});
        assert.equal(sp.agentId, b1.agents[1].agentId, "the core knows the agent");
        await gate.reached("c");
        const jB = store.readDynJournal(wf.runId).filter((e) => e.n === 2 && e.kind === "failed");
        assert.equal(jB.length, 1, "skipping is in the journal as failed");
        assert.equal(jB[0].skipped, true);
        await journalHas(wf.runId, (j) => contains(j, 3, "started"), "C started");
        const b2 = await quiet(ctx, l, wf.runId);
        assert.deepEqual(state(b2), { "Reader A": "running", "Reader B": "skipped", "Checker C": "running" });
        assert.equal(b2.agents[1].tokenKind, "only_output", "the consumption from the report, with its kind (lower bound)");
        assert.equal(typeof b2.agents[1].tokens, "number");

        gate.open("a");
        gate.open("c");
        await waitForTruthy(() => store.readDynRun(wf.runId)?.status !== "running", "run ended");
        const b3 = await quiet(ctx, l, wf.runId);
        assert.equal(b3.status, "finished", b3.error);
        assert.ok(!("cap" in b3), "no cap numbers on the finished run — nobody waits there");
        assert.deepEqual(state(b3), { "Reader A": "finished", "Reader B": "skipped", "Checker C": "finished" });
        assert.ok(b3.endedAt >= b3.startedAt);
        // Every finished agent carries its end — the time of its result/failed — and it does not lie before its start.
        const jEnd = (n) => [...store.readDynJournal(wf.runId)].reverse().find((e) => e.n === n && (e.kind === "result" || e.kind === "failed"))?.at;
        for (const a of b3.agents) {
          assert.equal(a.startedAt, jStart(a.n), `${a.label}: startedAt`);
          assert.equal(a.endedAt, jEnd(a.n), `${a.label}: endedAt is the time of its end`);
          assert.ok(a.endedAt >= a.startedAt, `${a.label}: end not before the start`);
        }
        assert.deepEqual(store.readDynRun(wf.runId).returnValue, ["Finding a", null, "Finding c"], "the skipped place is null");
        // Every intermediate state was visible live, the waiting one included.
        const seen = new Set(l.all.filter((b) => b.runId === wf.runId).flatMap((b) => b.agents.map((a) => `${a.label}:${a.status}`)));
        for (const s of ["Checker C:waiting", "Checker C:running", "Checker C:finished", "Reader B:running", "Reader B:skipped"]) assert.ok(seen.has(s), `seen live: ${s}`);

        // The transcript of ONE agent: the framed job, then its rows.
        const tr = await json(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${wf.runId}/agents/3`);
        assert.equal(tr.runId, wf.runId);
        assert.equal(tr.n, 3);
        assert.equal(tr.rows[0].kind, "job");
        assert.match(tr.rows[0].text, /\{TAG:c\}/);
        assert.ok(tr.rows.some((z) => z.kind === "text" && z.text === "Finding c"), JSON.stringify(tr.rows));
        const perTask = await json(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${wf.taskId}/agents/1`);
        assert.ok(perTask.rows.some((z) => z.text === "Finding a"), "via the task id too");
        const foreign = await fetch(`${base}/api/chats/${chat.id}/dyn-workflows/runs/wf_unknown/agents/1`, { headers: { Connection: "close" } });
        assert.equal(foreign.status, 404);
        await ctx.waitForIdle();
      } finally { l.unsubscribe(); }
    }, { claude });
  } finally { back(); }
});

test("stop at the head: the human stop ends the whole run — route and event then show “stopped” with its originator, the running agent stands as stopped", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, gate } = ctx;
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const l = listener(chat.id);
    try {
      const script = "export const meta = { name: 'halt', description: 'Stop', phases: [{ title: 'One' }] }\nphase('One')\nconst a = await agent('A {TAG:h} {GATE:h}', { label: 'Worker' })\nreturn a";
      const wf = await startWf(ctx, "t2", script);
      await gate.reached("h");
      await journalHas(wf.runId, (j) => contains(j, 1, "started"), "worker started");
      assert.deepEqual(state(await quiet(ctx, l, wf.runId)), { Worker: "running" });
      // The button at the head sends `from: "human"`; the route sets the originator itself.
      const r = await post(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${wf.runId}/stop`, { from: "human" });
      assert.equal(r.status, "stopped");
      await journalHas(wf.runId, (j) => contains(j, 1, "failed"), "the worker has ended");
      const b = await quiet(ctx, l, wf.runId);
      assert.equal(b.status, "stopped");
      assert.equal(b.stoppedOf, "human");
      assert.deepEqual(state(b), { Worker: "stopped" }, "stopped with the run — not skipped, not error");
      await ctx.waitForIdle();
    } finally { l.unsubscribe(); }
  }, { claude });
});

test("log() line cap: the newest LOG_CAP, and the view says how many it left out", () => {
  const events = Array.from({ length: LOG_CAP + 5 }, (_, i) => ({ kind: "log", text: `z${i}`, phase: null, at: i }));
  const run = { runId: "wf_cap", taskId: "w1", name: "d", status: "running", meta: {}, startedAt: 0 };
  const s = treeView({ run, journal: [], events });
  assert.equal(s.logs.length, LOG_CAP);
  assert.equal(s.logs[0].text, "z5", "the oldest drop out");
  assert.equal(s.logs.at(-1).text, `z${LOG_CAP + 4}`);
  assert.equal(s.logsTruncated, 5);
});

// The reason for waiting is visible: on the RUNNING run the view carries the numbers of the caps passed in, and per
// waiting row the reason and kind from the journal. Counter-tests in the header of this file.
test("cap on the run: the numbers only on the running run, only whole numbers ≥ 1; per waiting row reason and kind from the journal", () => {
  const run = { runId: "wf_wait", taskId: "w4", name: "w", status: "running", meta: {}, startedAt: 1000 };
  const j = (n, kind, extra = {}) => ({ n, kind, at: 1000 + n, key: `k${n}`, phase: "Check", ...extra });
  const journal = [
    j(1, "launched", { label: "run" }), j(1, "waiting", { reason: "cap", cap: "run" }),
    j(2, "launched", { label: "user" }), j(2, "waiting", { reason: "cap", cap: "user" }),
    // First the cap, then the stagger: the NEWEST reason counts, the cap kind drops with it.
    j(3, "launched", { label: "stagger" }), j(3, "waiting", { reason: "cap", cap: "run" }), j(3, "waiting", { reason: "stagger" }),
    j(4, "launched", { label: "started" }), j(4, "waiting", { reason: "cap", cap: "run" }), j(4, "started", { agentId: "a4" }),
  ];
  const cap = { run: 2, user: 8 };
  const s = treeView({ run, journal, events: [], cap });
  assert.deepEqual(s.cap, { run: 2, user: 8 });
  assert.deepEqual(s.agents.map((a) => [a.label, a.status, a.reason ?? null, a.cap ?? null]), [
    ["run", "waiting", "cap", "run"], ["user", "waiting", "cap", "user"], ["stagger", "waiting", "stagger", null],
    ["started", "running", null, null],
  ]);
  for (const status of ["finished", "stopped", "failed", "interrupted"]) {
    assert.ok(!("cap" in treeView({ run: { ...run, status }, journal, events: [], cap })), `no number on the finished run (${status})`);
  }
  assert.ok(!("cap" in treeView({ run, journal, events: [] })), "without numbers passed in no field");
  assert.deepEqual(treeView({ run, journal: [], events: [], cap: { run: 0, user: 2.5 } }).cap, undefined, "no number that is not a whole number ≥ 1");
  assert.deepEqual(treeView({ run, journal: [], events: [], cap: { run: "2", user: 3 } }).cap, { user: 3 }, "no number that is not a whole number ≥ 1 — the valid one stays");
});

// The time per agent and the description — on the view itself, with written-out timestamps. Counter-test: `startedAt`
// read from the LAST `started` (a restart reset the clock) => red at "after a restart the time counts from the first
// start"; `startedAt` from `launched` (the wait for a slot counted as work time) => red at "the waiting one carries no
// time".
test("time per agent and description: startedAt = first “started”, endedAt = its end; without a start no time; meta.description as the description", () => {
  const run = { runId: "wf_time", taskId: "w2", name: "z", status: "running", meta: { description: "Checks the findings." }, startedAt: 1000 };
  const j = (n, kind, at, extra = {}) => ({ n, kind, at, key: `k${n}`, phase: "Read", ...extra });
  const journal = [
    j(1, "launched", 1000, { label: "A", provider: "claude", model: "claude-opus-5-5" }), j(1, "started", 1400, { agentId: "a1" }),
    j(2, "launched", 1000, { label: "B" }), j(2, "waiting", 1001, { reason: "cap" }),
    j(3, "launched", 1000, { label: "C" }), j(3, "result", 1002, { fromCache: true }),
    j(4, "launched", 1000, { label: "D" }), j(4, "started", 1500, { agentId: "a4" }), j(4, "restart", 3000, { agentId: "a4" }),
    j(4, "started", 3100, { agentId: "a4", resumed: true }), j(4, "result", 9000, { agentId: "a4", tokens: 12, tokenKind: "full" }),
    j(5, "launched", 1000, { label: "E" }), j(5, "failed", 1003, { error: "no slot" }),
  ];
  const s = treeView({ run, journal, events: [] });
  assert.equal(s.description, "Checks the findings.");
  const time = Object.fromEntries(s.agents.map((a) => [a.label, [a.startedAt ?? null, a.endedAt ?? null]]));
  assert.deepEqual(time.A, [1400, null], "running: start, no end yet");
  assert.deepEqual(time.B, [null, null], "the waiting one carries no time");
  assert.deepEqual(time.C, [null, 1002], "from the journal: an end but no start — no work time");
  assert.deepEqual(time.D, [1500, 9000], "after a restart the time counts from the first start");
  assert.deepEqual(time.E, [null, 1003], "failed before the start");
  assert.equal(treeView({ run: { ...run, meta: {} }, journal: [], events: [] }).description, "", "without meta.description empty, not undefined");
  assert.equal(treeView({ run: { ...run, meta: { description: 7 } }, journal: [], events: [] }).description, "", "a non-string is no description");
});

// The parts of a token count (input, cache, output) for the hover title — from the live agent via the core (publicRec),
// from the finished one via the journal (run.js writes them beside tokens/tokenKind). An older journal carries none, and
// then no field is there either.
test("token parts in the tree: live from the core, finished from the journal, old data without", () => {
  const run = { runId: "wf_parts", taskId: "w3", name: "t", status: "running", meta: {}, startedAt: 1000 };
  const j = (n, kind, extra = {}) => ({ n, kind, at: 1000 + n, key: `k${n}`, phase: null, ...extra });
  const parts = { input: 10, cacheWrite: 19_288, cacheRead: 102_640, output: 3_431 };
  const journal = [
    j(1, "launched", { label: "finished" }), j(1, "started", { agentId: "a1" }), j(1, "result", { agentId: "a1", tokens: 22_729, tokenKind: "full", tokenParts: parts }),
    j(2, "launched", { label: "live" }), j(2, "started", { agentId: "a2" }),
    j(3, "launched", { label: "old" }), j(3, "started", { agentId: "a3" }), j(3, "result", { agentId: "a3", tokens: 4, tokenKind: "only_output" }),
  ];
  const live = new Map([["a2", { tokens: 13, tokenKind: "full", tokenParts: { input: 9, cacheWrite: 0, cacheRead: 0, output: 4 }, status: "running" }]]);
  const after = Object.fromEntries(treeView({ run, journal, events: [], live }).agents.map((a) => [a.label, a]));
  assert.deepEqual(after.finished.tokenParts, parts);
  assert.deepEqual(after.live.tokenParts, { input: 9, cacheWrite: 0, cacheRead: 0, output: 4 });
  assert.equal(after.live.tokens, 13);
  assert.ok(!("tokenParts" in after.old), "an older journal carries no parts");
});
