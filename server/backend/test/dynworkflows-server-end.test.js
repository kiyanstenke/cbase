// A dynamic workflow across a server end (seen in operation): the run `ticket-implement-and-check` (implementer, then
// checker) was interrupted by a deploy and continued by the restart. The implementer ran again — the progress tree (web bar
// "Background Tasks", iOS) showed it red anyway, the checker "waiting", "2 agents · 10k tokens" and the log() line
// "Implementation finished (NO report)" of the aborted attempt. Two defects:
//
//   1. The RACE at the server end (dynworkflows/run.js `interruptIfServerEnds`): endServer sets the marker and runs the
//      "serverEnd" chain (including `docker stop` of the project containers) — `dynWorkflowsAtServerEnd` only runs at
//      `server.close`. The agent killed in the container (exit 137) arrived in the script as an ordinary failure: `failed` in
//      the journal, "returned null", the script's own log() line, the next agent() — before freezing. Played here with the
//      marker in the test process (`serverEndMarkerForTest`, as endServer sets it FIRST) and a SIGKILL at the agent (like
//      `docker stop` after its deadline).
//   2. The VIEW across the restart (dynworkflows/tree.js, boundary `attemptFrom` from store pickUpDynRun): the journal of all
//      attempts stands one behind the other, `agentState` read the `failed` of the aborted attempt behind the new `launched`,
//      the checker started by the aborted attempt stood there as waiting, log() and tokens of the old attempt with it. Played
//      here with exactly the rows the race left behind in operation (legacy: databases from before the repair), at the main
//      seam (route AND event) and at the view itself with the journal from production.
//
// Harness as in dynworkflows-resume.test.js (real server, real MCP server, real core, fake providers); the restart is
// triggered through `fireHooks("restartGrace")` (the harness switches its timer off). It never waits for the thing under
// test itself, but for something old and new code do alike — red instead of a hang under the counter-test.
//
// Counter-tests (which sabotage turns which test red):
//   - run.js at the state before the repair => "race at the server end" red at "interrupted, not running": the run kept
//     running — failed for the implementer, log(), the checker started;
//   - only `interruptIfServerEnds(run2)` removed in the core's `atEnd` callback => the same red at the journal ("no failed
//     for the killed implementer"): its death reached the script, only the next agent() froze the run;
//   - tree.js at the state before the repair => "tree after the restart", "view with the journal from production", "view across
//     a restart" and "agentState …" red (implementer "error", checker "waiting");
//   - tree.js log()/phase over all events instead of from `attemptFrom.events` => "tree after the restart" and "view with the
//     journal from production" red at the log() rows;
//   - tree.js without `fromLastStart` in `agentState` => "agentState reads the youngest attempt" red;
//   - store pickUpDynRun without the boundary (`attempt_ab_*` stays 0) => "tree after the restart" red at the checker (the view
//     takes all attempts as one).
//
// Also: only the OWN orderly end freezes (`ownServerEnd()`, the marker endServer sets FIRST), never the foreign marker `b-ends`
// alone (A3); the core stays open after freezing — a sibling agent keeps working until server.close, and its result is in the
// journal (A2); every place where an agent waits in the window (entry into agent(), cap, stagger, credit gate) freezes instead
// of starting (A4); and every restart here checks that the orderly end cost no attempt (A1; its counter-tests are in the
// header of dynworkflows-resume.test.js).
//
// Counter-tests for A2–A4:
//   - run.js with `serverEnds` instead of `ownServerEnd` (the foreign marker freezes again) => "foreign marker b-ends alone"
//     red (interrupted instead of finished);
//   - run() closes the core at the server end at once again => "A2" red (the sibling's result is missing in the journal) and
//     "stagger" red (even the result of the agent whose end freezes is missing — the restart could not serve it from the
//     cache);
//   - slotTake without the check after the request => "cap" red (B got the slot and started: `started` in the journal);
//   - the stagger without the check after the wait => "stagger" red (B started: `started` in the journal);
//   - agent() without the check at entry => "before the first agent()" red (launched in the journal);
//   - run() without the sandbox abort after a synchronous freeze => the same red (the null reached the script, log() after it);
//   - slotTake without the check at the top of the loop AND after the gate => "credit gate" red (K waited a second time); each
//     of the two reverted alone stays green — they cover each other at the gate, the guard only holds their union.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { agentState, treeView } from "../electron/server/dynworkflows/tree.js";
import { dynWorkflowSituation } from "../electron/server/dynworkflows/run.js";
import { wakeGateWaiting } from "../electron/server/dynworkflows/parking.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { bEndsOwnerForTest, ownServerEnd, serverEndMarkerForTest, serverEnds } from "../electron/server/runs/server-end.js";
import { streams } from "../electron/server/runtime/sse.js";
import * as store from "../electron/server/store.js";

process.env.CBASE_DYNWF_STAGGER_MS = "0";

// The main agent as in dynworkflows-resume.test.js: "WF[<tag>]:{json}" calls cbase_dynamic_workflow, a completion notice
// lands in notices.jsonl.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    fs.appendFileSync(path.join(LOCATION, "notices.jsonl"), JSON.stringify({ text }) + "\\n");
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
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    say({ type: "assistant", message: { id: "b-" + tag, content: [{ type: "text", text: "Workflow started" }] } });
    finished();
    say({ type: "result", result: "Workflow started", session_id: "main-session" });
    return;
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Response" }] } });
  finished();
  say({ type: "result", result: "Response", session_id: "main-session" });`;

// A workflow agent: {TAG:x} names it, {GATE:x} holds it at gate `<x>-<spawn count>` (the gate file carries its pid — the test
// kills it there like `docker stop`), {VORTOR:x} likewise, but BEFORE its first event (the stagger only releases the other
// agents of its prefix with that). Every spawn appends an "x" to sub-start-<tag>.
const SUB = `
    const cut = text.lastIndexOf("Here is the task:");
    const job = cut >= 0 ? text.slice(cut) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    const nr = fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length;
    if (job.includes("{VORTOR:")) await gate(job.split("{VORTOR:")[1].split("}")[0] + "-" + nr);
    say({ type: "assistant", message: { id: "s1-" + tag + nr, usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0] + "-" + nr);
    say({ type: "assistant", message: { id: "s2-" + tag + nr, content: [{ type: "text", text: "Finding " + tag + " #" + nr }] } });
    finished();
    say({ type: "result", result: "Finding " + tag + " #" + nr, session_id: "sub-" + tag + nr });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
// The script from operation, cut to the necessary: implementer, on null a log() line of its own, then the checker.
const SCRIPT = [
  "export const meta = { name: 'ticket-implement-and-check', description: 'Implement, then check', phases: [{ title: 'Implement' }, { title: 'Review' }] }",
  "phase('Implement')",
  "const report = await agent('Implement ticket 11 {TAG:u} {GATE:u}', { label: 'implement:11', phase: 'Implement' })",
  "if (report === null) log('Implementation finished (NO report)')",
  "phase('Review')",
  "const verdict = await agent('Check ticket 11 {TAG:r}', { label: 'review:11', phase: 'Review' })",
  "return { report, verdict }",
].join("\n");

async function start(ctx, tag, args) {
  await post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text: `WF[${tag}]:${JSON.stringify(args)}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(r.status, "started", JSON.stringify(r));
  return r;
}
const spawns = (root, tag) => { const f = path.join(root, `sub-start-${tag}`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0; };
const notices = (root) => readJsonl(path.join(root, "notices.jsonl")).map((z) => z.text);
const has = (j, n, kind) => j.some((e) => e.n === n && e.kind === kind);
const journalHas = (runId, check, what) => waitForTruthy(() => check(store.readDynJournal(runId)), what);
const notMoreRunning = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} ended`);
const markers = (log, runId) => log.filter((m) => m.role === "workflow_marker").map((m) => JSON.parse(m.text)).filter((m) => m.runId === runId).map((m) => [m.phase, m.status]);
const pidAtGate = (root, name) => Number(fs.readFileSync(path.join(root, "gates", `${name}.waiting`), "utf8"));
const tick = () => new Promise((r) => setImmediate(r));

// A subscriber of the chat stream without a socket (as in dynworkflows-tree.test.js): the youngest dynwf_tree per run.
function listener(chatId) {
  const trees = new Map();
  const subscription = {
    write(row) {
      const m = /^data: (.*)\n\n$/s.exec(row);
      if (!m) return;
      const e = JSON.parse(m[1]);
      if (e.type === "harness" && e.subtype === "dynwf_tree") trees.set(e.tree.runId, e.tree);
    },
  };
  const subs = streams.get(chatId) ?? new Set();
  streams.set(chatId, subs);
  subs.add(subscription);
  return { trees, unsubscribe: () => subs.delete(subscription) };
}
// Route and event at the QUIET run: the same route twice with a tick between, then the event must be equal.
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
const agentsOf = (b) => b.agents.map((a) => [a.n, a.label, a.status]);
const kinds = (j, n) => j.filter((e) => e.n === n).map((e) => (e.kind === "waiting" ? `waiting:${e.reason}` : e.kind));
// Without an open agent() call: the run is gone from this server run, or none of its calls is still in progress
// (run.js dynWorkflowSituation `open` — an entry only drops AFTER its journal entry).
const withoutOpen = (chatId, runId) => { const l = dynWorkflowSituation({ chatId }).find((x) => x.runId === runId); return !l || l.open === 0; };
// The end of a run in the restart: restart (orderly), restart hook, finished.
async function restartGraceUntilFinished(ctx, runId) {
  await ctx.restart({ withBackground: true });
  assert.equal(store.readDynRun(runId).status, "interrupted");
  await fireHooks("restartGrace", {});
  assert.equal(store.readDynRun(runId).attempts, 0, "an orderly server end is no attempt (A1)");
  const end = await notMoreRunning(runId);
  assert.equal(end.status, "finished", end.error);
  await waitForTruthy(() => notices(ctx.root).length === 1, "CompletionNotice");
  assert.match(notices(ctx.root)[0], /<status>completed<\/status>/);
  return end;
}

// The FOREIGN marker b-ends (as in server-end-marker.test.js withRoot): a root with /run/cbase (0755) and the marker (0644),
// the expected owner set through the seam to the own uid — serverEnds() is then true without endServer having run.
async function withForeignMarker(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynwf-foreign-marker-"));
  const dir = path.join(root, "run", "cbase");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, "b-ends"), `${Date.now()}\n`);
  fs.chmodSync(path.join(dir, "b-ends"), 0o644);
  const saved = process.env.CBASE_NETWORK_ROOT;
  process.env.CBASE_NETWORK_ROOT = root;
  bEndsOwnerForTest(typeof process.getuid === "function" ? process.getuid() : 0);
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.CBASE_NETWORK_ROOT; else process.env.CBASE_NETWORK_ROOT = saved;
    bEndsOwnerForTest(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
// An environment variable for the duration of a body (cap, stagger — both read at call time, cap.js).
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
// Without an account (as in dynworkflows-limits.test.js): utilization and window would otherwise come from the developer's REAL account.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynwf-server-end-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("race at the server end: if a workflow agent dies after the server began to end, its death does not reach the script — no failed, no log(), no next agent(); the run is interrupted, and the restart starts the agent anew", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "s", { script: SCRIPT });
    await ctx.gate.reached("u-1");
    await journalHas(r.runId, (j) => has(j, 1, "started"), "implementer started");

    // endServer sets the marker FIRST; then the "serverEnd" chain stops the project containers, and the agent inside dies
    // hard — both BEFORE server.close triggers dynWorkflowsAtServerEnd.
    serverEndMarkerForTest(true);
    try {
      process.kill(pidAtGate(root, "u-1"), "SIGKILL");
      // What BOTH states reach: the run no longer runs (new: interrupted; old: finished after the checker) or the journal
      // knows an end of the implementer (old).
      await waitForTruthy(() => store.readDynRun(r.runId)?.status !== "running" || has(store.readDynJournal(r.runId), 1, "failed"), "the run reacts to the implementer's death");
    } finally { serverEndMarkerForTest(false); }

    const row = store.readDynRun(r.runId);
    assert.equal(row.status, "interrupted", `interrupted, not ${row.status} (${row.error})`);
    const journal = store.readDynJournal(r.runId);
    assert.deepEqual(journal.map((e) => [e.n, e.kind]), [[1, "launched"], [1, "started"]],
      "no failed for the killed implementer (it does not break the restart's prefix) and no agent() after");
    const events = store.readDynEvents(r.runId);
    assert.deepEqual(events.map((e) => [e.kind, e.text]), [["phase", "Implement"]],
      "neither \"returned null\" nor the script's own log() line nor the next phase");
    await waitForTruthy(async () => markers(await json(`${base}/api/chats/${chat.id}/log`), r.runId).length === 2, "end marker");
    assert.deepEqual(markers(await json(`${base}/api/chats/${chat.id}/log`), r.runId), [["start", undefined], ["end", "interrupted"]]);
    assert.equal(spawns(root, "r"), 0, "the checker never started");

    // Restart: the same run, the implementer runs anew (only started => no hit, no break).
    await ctx.restart({ withBackground: true });
    assert.equal(store.readDynRun(r.runId).status, "interrupted");
    await fireHooks("restartGrace", {});
    assert.equal(store.readDynRun(r.runId).attempts, 0, "the freeze was an orderly server end: no attempt (A1)");
    await ctx.gate.reached("u-2");
    await journalHas(r.runId, (j) => j.filter((e) => e.n === 1 && e.kind === "started").length === 2, "implementer started in the restart");
    assert.equal(spawns(root, "u"), 2, "the implementer starts anew in the restart");
    const tree = (await json(`${base}/api/chats/${chat.id}/dyn-workflows/tree`)).runs.find((b) => b.runId === r.runId);
    assert.deepEqual(agentsOf(tree), [[1, "implement:11", "running"]]);

    ctx.gate.open("u-2");
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { report: "Finding u #2", verdict: "Finding r #1" }, "the report of the second attempt, then the checker");
    assert.deepEqual(store.readDynEvents(r.runId).filter((e) => e.kind === "log"), [], "never a log() line \"NO report\"");
    await waitForTruthy(() => notices(root).length === 1, "CompletionNotice");
    assert.match(notices(root)[0], /<status>completed<\/status>/);
    await ctx.waitForIdle();
  }, { claude });
});

// ── The window between endServer and server.close (A2–A4) ──────────────────────────────────

// A2: agents in B (workspace chat without a project) do not die of `docker stop` — they work until `close`. If `run` closed
// the core right after freezing, an agent that would have finished regularly in the window would die and start from scratch
// in the restart.
test("server end without project container (A2): the run freezes at the end of the first agent, the second keeps working — its result is in the journal, and the restart serves both from the cache", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "k", { script: [
      "export const meta = { name: 'two-in-b', description: 'A and B side by side', phases: [{ title: 'One' }] }",
      "const [a, b] = await parallel([() => agent('A {TAG:a} {GATE:a}', { label: 'a' }), () => agent('B {TAG:b} {GATE:b}', { label: 'b' })])",
      "if (a === null || b === null) log('an agent without a result')",
      "return { a, b }",
    ].join("\n") });
    await ctx.gate.reached("a-1");
    await ctx.gate.reached("b-1");
    await journalHas(r.runId, (j) => has(j, 1, "started") && has(j, 2, "started"), "A and B started");
    serverEndMarkerForTest(true);
    try {
      ctx.gate.open("a-1");
      // What both states reach: the run freezes, or A is finished in the journal (without freezing the run keeps running).
      await waitForTruthy(() => store.readDynRun(r.runId)?.status !== "running" || has(store.readDynJournal(r.runId), 1, "result"), "A ended");
      assert.equal(store.readDynRun(r.runId).status, "interrupted", "the run freezes at the end of A");
      ctx.gate.open("b-1");
      // What both states reach: no open agent() any more — new, because B ends regularly; old, because the core was closed and the run gone.
      await waitForTruthy(() => withoutOpen(chat.id, r.runId), "B ended");
    } finally { serverEndMarkerForTest(false); }
    const j = store.readDynJournal(r.runId);
    assert.deepEqual([kinds(j, 1), kinds(j, 2)], [["launched", "started", "result"], ["launched", "started", "result"]],
      "B finished regularly in the window — its result is in the journal (the restart's cache)");
    assert.deepEqual(store.readDynEvents(r.runId).filter((e) => e.kind === "log"), [], "no result reached the aborted script");

    const end = await restartGraceUntilFinished(ctx, r.runId);
    assert.deepEqual(end.returnValue, { a: "Finding a #1", b: "Finding b #1" });
    assert.deepEqual([spawns(root, "a"), spawns(root, "b")], [1, 1], "both from the cache, none anew");
    await ctx.waitForIdle();
  }, { claude });
});

// A3: only the OWN end freezes. Any agent process in B can write the foreign marker b-ends; if a false alarm stopped the run
// for good in the surviving process (interrupted, no completion notice), that would be the defect.
test("foreign marker b-ends alone (A3): it freezes no run — the agent ends regularly, the script keeps running, the run ends finished with a completion notice", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "f", { script: [
      "export const meta = { name: 'foreign-marker', description: 'A, then B', phases: [{ title: 'One' }] }",
      "const a = await agent('A {TAG:a} {GATE:a}', { label: 'a' })",
      "const b = await agent('B {TAG:b}', { label: 'b' })",
      "return { a, b }",
    ].join("\n") });
    await ctx.gate.reached("a-1");
    await withForeignMarker(async () => {
      assert.equal(serverEnds(), true, "the foreign marker applies — otherwise this test would check nothing");
      assert.equal(ownServerEnd(), false);
      ctx.gate.open("a-1");
      await notMoreRunning(r.runId);
    });
    const end = store.readDynRun(r.runId);
    assert.equal(end.status, "finished", `finished, not ${end.status} (${end.error})`);
    assert.deepEqual(end.returnValue, { a: "Finding a #1", b: "Finding b #1" });
    await waitForTruthy(() => notices(root).length === 1, "CompletionNotice");
    assert.match(notices(root)[0], /<status>completed<\/status>/);
    await ctx.waitForIdle();
  }, { claude });
});

// A4: the places where a run freezes other than at an agent's end — each one where NO agent ends before it asks.
test("server end before the first agent() (A4): a run that begins in the window freezes at the entry into agent() — no journal, no process, the script does not continue; the restart runs it", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    let r;
    serverEndMarkerForTest(true);
    try {
      // A turn in B also begins during the server end (only a relocated project waits at its lock).
      r = await start(ctx, "e", { script: [
        "export const meta = { name: 'eintritt', description: 'agent() in the synchronous start', phases: [{ title: 'One' }] }",
        "phase('One')",
        "const a = await agent('A {TAG:a}', { label: 'a' })",
        "log('after A: ' + a)",
        "return { a }",
      ].join("\n") });
      await waitForTruthy(() => store.readDynRun(r.runId)?.status !== "running", "the run freezes");
    } finally { serverEndMarkerForTest(false); }
    assert.equal(store.readDynRun(r.runId).status, "interrupted");
    assert.deepEqual(store.readDynJournal(r.runId), [], "no launched: agent() does not begin");
    assert.deepEqual(store.readDynEvents(r.runId).map((e) => [e.kind, e.text]), [["phase", "One"]],
      "the null answer does not reach the script (no log() after it)");
    await waitForTruthy(async () => markers(await json(`${base}/api/chats/${chat.id}/log`), r.runId).length === 2, "end marker");
    assert.deepEqual(markers(await json(`${base}/api/chats/${chat.id}/log`), r.runId), [["start", undefined], ["end", "interrupted"]]);
    assert.equal(spawns(root, "a"), 0);

    const end = await restartGraceUntilFinished(ctx, r.runId);
    assert.deepEqual(end.returnValue, { a: "Finding a #1" });
    assert.equal(spawns(root, "a"), 1);
    await ctx.waitForIdle();
  }, { claude });
});

test("server end at the cap (A4): an agent waits for a slot, the first ends regularly in the window — the slot goes to the waiting one, which no longer starts; the restart runs it", async () => {
  await withEnvironment({ CBASE_DYNWF_RUN_CAP: "1" }, () => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "d", { script: [
      "export const meta = { name: 'cap', description: 'A occupies the one slot, B waits', phases: [{ title: 'One' }] }",
      "const [a, b] = await parallel([() => agent('A {TAG:a} {GATE:a}', { label: 'a' }), () => agent('B {TAG:b}', { label: 'b' })])",
      "return { a, b }",
    ].join("\n") });
    await ctx.gate.reached("a-1");
    await journalHas(r.runId, (j) => kinds(j, 2).includes("waiting:cap"), "B waits at the cap");
    serverEndMarkerForTest(true);
    try {
      ctx.gate.open("a-1");
      // What both states reach: no open agent() any more, or B has started (the defect).
      await waitForTruthy(() => withoutOpen(chat.id, r.runId) || has(store.readDynJournal(r.runId), 2, "started"), "A ended, B decided");
    } finally { serverEndMarkerForTest(false); }
    const j = store.readDynJournal(r.runId);
    assert.equal(store.readDynRun(r.runId).status, "interrupted");
    assert.deepEqual([kinds(j, 1), kinds(j, 2)], [["launched", "started", "result"], ["launched", "waiting:cap"]],
      "B only got the slot after the server end — and did not start");
    assert.equal(spawns(root, "b"), 0);

    const end = await restartGraceUntilFinished(ctx, r.runId);
    assert.deepEqual(end.returnValue, { a: "Finding a #1", b: "Finding b #1" });
    assert.deepEqual([spawns(root, "a"), spawns(root, "b")], [1, 1]);
    await ctx.waitForIdle();
  }, { claude }));
});

test("server end in the stagger (A4): an agent waits for the first event of the first of its prefix — it comes in the window, the waiting one no longer starts", async () => {
  await withEnvironment({ CBASE_DYNWF_STAGGER_MS: String(24 * 3_600_000) }, () => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "s", { script: [
      "export const meta = { name: 'stagger', description: 'A first, B after its first event', phases: [{ title: 'One' }] }",
      "const [a, b] = await parallel([() => agent('A {TAG:a} {VORTOR:va}', { label: 'a' }), () => agent('B {TAG:b}', { label: 'b' })])",
      "return { a, b }",
    ].join("\n") });
    await ctx.gate.reached("va-1");
    await journalHas(r.runId, (j) => kinds(j, 2).includes("waiting:stagger"), "B waits in the stagger");
    assert.equal(spawns(root, "b"), 0, "precondition: B really waits");
    serverEndMarkerForTest(true);
    try {
      ctx.gate.open("va-1");
      await waitForTruthy(() => withoutOpen(chat.id, r.runId) || has(store.readDynJournal(r.runId), 2, "started"), "A ended, B decided");
    } finally { serverEndMarkerForTest(false); }
    const j = store.readDynJournal(r.runId);
    assert.equal(store.readDynRun(r.runId).status, "interrupted");
    assert.deepEqual([kinds(j, 1), kinds(j, 2)], [["launched", "started", "result"], ["launched", "waiting:stagger"]],
      "the stagger released B after the server end — B did not start, A is finished (the core stayed open)");
    assert.equal(spawns(root, "b"), 0);

    const end = await restartGraceUntilFinished(ctx, r.runId);
    assert.deepEqual(end.returnValue, { a: "Finding a #1", b: "Finding b #1" });
    assert.deepEqual([spawns(root, "a"), spawns(root, "b")], [1, 1]);
    await ctx.waitForIdle();
  }, { claude }));
});

test("server end at the credit gate (A4): an agent waits at the gate, the server end comes, it is woken (the gate still stands) — it does not wait a second time and does not start; the restart runs it", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    // Session window 100 % (field names as in fetchUsageLimits), reset in one hour — the gate holds every Claude agent.
    const at = Date.now();
    const iso = new Date(at + 3_600_000).toISOString();
    store.setSetting("usage_cache_v1", JSON.stringify({
      fiveHour: { utilization: 100, resetsAt: iso }, sevenDay: { utilization: 4, resetsAt: null },
      limits: [{ kind: "session", group: "session", percent: 100, resets_at: iso }, { kind: "weekly", group: "weekly", percent: 4, resets_at: null }],
      at,
    }));
    const gate = (on) => json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
    await gate(false);
    await ultracodeOn(base, chat.id);
    // The gate would also hold the turn that starts the workflow: first A runs (gate off), the turn ends, then the gate on —
    // K, which comes after A, waits at it.
    const r = await start(ctx, "g", { script: [
      "export const meta = { name: 'gate', description: 'A, then K at the gate', phases: [{ title: 'One' }] }",
      "const a = await agent('A {TAG:a} {GATE:a}', { label: 'a' })",
      "const k = await agent('K {TAG:k}', { label: 'k' })",
      "return { a, k }",
    ].join("\n") });
    await ctx.gate.reached("a-1");
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs | 0) === 0, "turn ended");
    await gate(true);
    ctx.gate.open("a-1");
    await journalHas(r.runId, (j) => kinds(j, 2).includes("waiting:credit-gate"), "K waits at the gate");
    serverEndMarkerForTest(true);
    try {
      assert.equal(wakeGateWaiting(), 1, "K stood at the gate");
      // What both states reach: the run freezes, or K waits a second time at the gate (the defect).
      await waitForTruthy(() => store.readDynRun(r.runId)?.status !== "running" || kinds(store.readDynJournal(r.runId), 2).filter((a) => a === "waiting:credit-gate").length > 1, "K decided");
    } finally { serverEndMarkerForTest(false); }
    assert.equal(store.readDynRun(r.runId).status, "interrupted");
    assert.deepEqual(kinds(store.readDynJournal(r.runId), 2), ["launched", "waiting:credit-gate"]);
    assert.equal(spawns(root, "k"), 0);

    await gate(false);
    const end = await restartGraceUntilFinished(ctx, r.runId);
    assert.deepEqual(end.returnValue, { a: "Finding a #1", k: "Finding k #1" });
    assert.deepEqual([spawns(root, "a"), spawns(root, "k")], [1, 1], "A from the cache, K anew");
    await ctx.waitForIdle();
  }, { claude }));
});

test("tree after the restart: shows the running attempt — the restarted implementer runs (not \"error\", not with the tokens of the dead attempt), the checker started by the aborted attempt is missing, log() and phase of the aborted attempt are gone; route and event equal", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "b", { script: SCRIPT });
    await ctx.gate.reached("u-1");
    await journalHas(r.runId, (j) => has(j, 1, "started"), "implementer started");
    await ctx.restart({ withBackground: true });
    assert.equal(store.readDynRun(r.runId).status, "interrupted");

    // What the race wrote into the journal in operation (legacy from before the repair): the killed implementer as failed,
    // the two log() lines, the phase "Review" and the checker at the lock.
    const k1 = store.readDynJournal(r.runId).find((e) => e.n === 1 && e.kind === "launched").key;
    const agentAge = store.readDynJournal(r.runId).find((e) => e.n === 1 && e.kind === "started").agentId;
    store.writeDynJournal(r.runId, { kind: "failed", n: 1, key: k1, phase: "Implement", agentId: agentAge, error: "Exit 137", tokens: 10345, tokenKind: "full" });
    store.writeDynEvent(r.runId, { kind: "log", text: `agent "implement:11" (${agentAge}) returned null — Exit 137 · Error: Exit 137`, phase: "Umsetzen" });
    store.writeDynEvent(r.runId, { kind: "log", text: "Implementation finished (NO report)", phase: "Implement" });
    store.writeDynEvent(r.runId, { kind: "phase", text: "Review", phase: "Implement" });
    store.writeDynJournal(r.runId, { kind: "launched", n: 2, key: "v2:alt-review", phase: "Review", label: "review:11", prompt: "Check ticket 11", opts: {}, provider: "codex", model: "gpt-5.6-sol", effort: "" });
    store.writeDynJournal(r.runId, { kind: "waiting", n: 2, key: "v2:alt-review", phase: "Review", reason: "project", provider: "codex", state: "serverEnd" });
    const prior = (await json(`${base}/api/chats/${chat.id}/dyn-workflows/tree`)).runs.find((b) => b.runId === r.runId);
    assert.equal(prior.status, "interrupted");

    const l = listener(chat.id);
    try {
      await fireHooks("restartGrace", {});
      await ctx.gate.reached("u-2");
      await journalHas(r.runId, (j) => j.filter((e) => e.n === 1 && e.kind === "started").length === 2, "implementer started in the restart");
      const b = await quiet(ctx, l, r.runId);
      assert.equal(b.status, "running");
      assert.deepEqual(agentsOf(b), [[1, "implement:11", "running"]],
        "the implementer runs again, the checker of the aborted attempt is neither waiting nor there at all");
      const u = b.agents[0];
      const newStart = store.readDynJournal(r.runId).filter((e) => e.n === 1 && e.kind === "started").at(-1);
      assert.equal(u.agentId, newStart.agentId, "the agentId of the running attempt");
      assert.equal(u.startedAt, newStart.at, "the time runs from the start in the restart");
      assert.ok(!("endedAt" in u), "no end: the failed of the dead attempt does not apply");
      assert.notEqual(u.tokens, 10345, "not the tokens of the dead attempt");
      assert.equal(b.phase, "Implement", "the phase of the running attempt");
      assert.deepEqual(b.logs, [], "no log() line of the aborted attempt");
      assert.deepEqual(b.phases, ["Implement", "Review"]);

      // On to the end: the checker joins anew in the running attempt.
      ctx.gate.open("u-2");
      const end = await notMoreRunning(r.runId);
      assert.equal(end.status, "finished", end.error);
      const b2 = await quiet(ctx, l, r.runId);
      assert.deepEqual(agentsOf(b2), [[1, "implement:11", "finished"], [2, "review:11", "finished"]]);
      assert.equal(b2.agents[1].provider, "claude", "the checker of the running attempt, not the old entry");
      assert.equal(b2.phase, "Review");
      assert.deepEqual(b2.logs, []);
      await waitForTruthy(() => notices(ctx.root).length === 1, "CompletionNotice");
      await ctx.waitForIdle();
    } finally { l.unsubscribe(); }
  }, { claude });
});

// The view itself with the journal and the events from production (times as ms since the first row, run wf_157970bd7691,
// `attempts` 1): the boundary stands behind the rows of the first attempt.
test("view with the journal from production: the implementer runs, the checker is missing, \"2 agents · 10k tokens\" and \"NO report\" are gone", () => {
  const s = (mmss) => { const [m, x] = mmss.split(":").map(Number); return (m * 60 + x) * 1000; };
  const j = (at, n, kind, extra = {}) => ({ n, kind, at: s(at), key: n === 1 ? "v2:implement" : "v2:review", phase: n === 1 ? "Implement" : "Review", ...extra });
  const journal = [
    j("00:20", 1, "launched", { label: "implement:11", provider: "claude", model: "claude-opus-5-5" }),
    j("00:21", 1, "started", { agentId: "a4e4e62d7-1" }),
    j("02:50", 1, "failed", { agentId: "a4e4e62d7-1", error: "Exit 137", tokens: 10345, tokenKind: "full" }),
    j("02:50", 2, "launched", { label: "review:11", provider: "codex", model: "gpt-5.6-sol" }),
    j("02:50", 2, "waiting", { reason: "project", provider: "codex", state: "serverEnd" }),
    // --- Nachstart ---
    j("03:01", 1, "launched", { label: "implement:11", provider: "claude", model: "claude-opus-5-5" }),
    ...Array.from({ length: 11 }, (_, i) => j(`03:${String(1 + i * 7).padStart(2, "0")}`, 1, "waiting", { reason: "project", state: "start" })),
    j("04:30", 1, "started", { agentId: "a77557843-1" }),
  ];
  const e = (at, kind, text, phase = "Implement") => ({ kind, text, phase, at: s(at) });
  const events = [
    e("00:20", "phase", "Implement"),
    e("02:50", "log", "agent \"implement:11\" (a4e4e62d7-1) returned null — Exit 137 · Error: Exit 137"),
    e("02:50", "log", "Implementation finished (NO report)"),
    e("02:50", "phase", "Review"),
    // --- Nachstart ---
    e("03:00", "phase", "Implement"),
  ];
  const run = { runId: "wf_157970bd7691", taskId: "w1", name: "ticket-implement-and-check", status: "running", meta: { phases: [{ title: "Implement" }, { title: "Review" }] },
    startedAt: s("00:20"), attemptFrom: { journal: 5, events: 4 } };
  const live = new Map([["a77557843-1", { agentId: "a77557843-1", status: "running", tokens: 4200, tokenKind: "full" }]]);
  const b = treeView({ run, journal, events, live });
  assert.deepEqual(b.agents.map((a) => [a.n, a.label, a.status, a.agentId, a.tokens, a.startedAt]), [[1, "implement:11", "running", "a77557843-1", 4200, s("04:30")]]);
  assert.equal(b.phase, "Implement");
  assert.deepEqual(b.logs, []);
  assert.deepEqual(b.phases, ["Implement", "Review"]);
  // Without a boundary (a run without a restart) the view stays as it was — here the rows of a single attempt.
  const oneAttempt = treeView({ run: { ...run, attemptFrom: undefined }, journal: journal.slice(0, 5), events: events.slice(0, 4), live: new Map() });
  assert.deepEqual(oneAttempt.agents.map((a) => [a.n, a.status]), [[1, "error"], [2, "waiting"]]);
  assert.equal(oneAttempt.logs.length, 2);
});

test("view across a restart: a result that the restart serves from the journal stays \"finished\"; one behind a failed agent runs anew and is missing until then", () => {
  const j = (n, kind, extra = {}) => ({ n, kind, at: 0, key: `k${n}`, phase: "P", ...extra });
  const run = { runId: "wf_x", taskId: "w", name: "x", status: "running", meta: {}, startedAt: 0 };
  // Attempt 1: A finished, B only started (aborted), C waited for a slot. Restart: B started anew.
  const journal = [
    j(1, "launched", { label: "A" }), j(1, "started", { agentId: "a1" }), j(1, "result", { agentId: "a1", tokens: 7, at: 5 }),
    j(2, "launched", { label: "B" }), j(2, "started", { agentId: "b1" }),
    j(3, "launched", { label: "C" }), j(3, "waiting", { reason: "cap" }),
    j(2, "launched", { label: "B" }), j(2, "started", { agentId: "b2" }),
  ];
  const b = treeView({ run: { ...run, attemptFrom: { journal: 7, events: 0 } }, journal, events: [] });
  assert.deepEqual(b.agents.map((a) => [a.label, a.status, a.agentId]), [["A", "finished", "a1"], ["B", "running", "b2"]],
    "A comes from the journal (finished, with its tokens), B runs anew, the restart has not reached C yet");
  assert.equal(b.agents[0].tokens, 7);
  // Attempt 1: A failed (really, not at the server end), B finished. The restart breaks the prefix at A — B runs anew as
  // soon as the script reaches it; until then it is not "finished".
  const broken = [
    j(1, "launched", { label: "A" }), j(1, "started", { agentId: "a1" }), j(1, "failed", { agentId: "a1", error: "broken" }),
    j(2, "launched", { label: "B" }), j(2, "started", { agentId: "b1" }), j(2, "result", { agentId: "b1" }),
    j(1, "launched", { label: "A" }), j(1, "started", { agentId: "a2" }),
  ];
  const g = treeView({ run: { ...run, attemptFrom: { journal: 6, events: 0 } }, journal: broken, events: [] });
  assert.deepEqual(g.agents.map((a) => [a.label, a.status, a.agentId]), [["A", "running", "a2"]]);
});

test("agentState reads the youngest attempt: a new launched/started after a failed means \"running\", not \"error\"", () => {
  const es = [
    { n: 1, kind: "launched" }, { n: 1, kind: "started", agentId: "x1" }, { n: 1, kind: "failed", error: "Exit 137" },
    { n: 1, kind: "launched" }, { n: 1, kind: "waiting", reason: "project" },
  ];
  assert.equal(agentState(es, { runStatus: "running" }), "waiting");
  assert.equal(agentState([...es, { n: 1, kind: "started", agentId: "x2" }], { runStatus: "running" }), "running");
  // Unchanged within ONE attempt: the human restart writes no launched.
  assert.equal(agentState([{ n: 1, kind: "launched" }, { n: 1, kind: "started" }, { n: 1, kind: "restart" }, { n: 1, kind: "failed", skipped: true }], { runStatus: "running" }), "skipped");
});
