// Resume of a dynamic workflow — main seam with the agent harness: real server, real cbase MCP server, real agent core; only
// the providers are faked. The server restarts on the SAME database while a workflow runs; the "restartGrace" hook
// (registered in server.js's hook list) continues the run — finished, unchanged agents from the journal (no spawn at the
// fake CLI), interrupted ones anew, the completion notice arrives, and the continuation starts no turn. Also the attempt cap
// with a throwing continuation (safety net) and `resumeFromRunId`/`scriptPath` at the tool.
//
// The restart timer is 24 h in the harness (a test before it switches it off); here it is triggered as in
// agent-orphaned.test.js through `fireHooks("restartGrace")` — the hooks of that kind are `wait: false`, so the chain runs
// synchronously in the call, and what it changes on the run is in the database afterwards. No time limit: it waits for
// events (files of the fake CLI, rows in the history).
//
// Counter-tests (which sabotage turns which test red):
//   - drop `registerHook("restartGrace", dynWorkflowsRestartGrace, …)` in server.js => "restart" red (the run stays interrupted);
//   - drop the safety net (`.catch(… resumptionFailed …)` in run.js) => the throwing continuation becomes an unhandled
//     rejection, the server process dies => "attempt cap" red (ECONNREFUSED at the next request);
//   - remove the cache hit in run() (`cache` ignored) => "restart" and "resumeFromRunId" red (a new spawn for the finished agent).
// Orderly server end costs no attempt (one place reverted each time, this file and dynworkflows-server-end.test.js run):
//   - store pickUpDynRun counts every pick-up again (`attempts + 1`) => here "restart" (attempts 1), "three orderly server
//     ends" (restart 1 counted) and "a crash and a throwing continuation" (step 1) red, in dynworkflows-server-end.test.js
//     "race", "A2" and the four "A4" (every restart there checks attempts 0);
//   - run.js interrupt without `ordered: true` => the same except "a crash …" (it sets the mark itself);
//   - store pickUpDynRun without `end_ordered = 0` => both A1 tests red at the mark after the pick-up (a crash after an
//     orderly end would not count — a crash loop would never be capped);
//   - run.js dynWorkflowsRestartGrace without `!row.endOrdered` => "a crash …" red at step 4 (given up at the cap although
//     the last end was orderly).
// Branch chains (journal.js "branches"):
//   - journal.js chainKindOf: a `launched` without `chain` counts as "branches" instead of "linear" => "fallback" red (the
//     two agents from parallel() run anew after the restart: their linear key does not match the branch computation);
//   - journal.js `CHAIN_KIND_NEW = "linear"` => "two branches" red (the keys of the second agents hang on the completion
//     order again) and "fallback" red (the fresh run already writes linear — the test demands the difference);
//   - run.js passes the lane not on to `chain.further` (`null` instead of `lane`) => "two branches" red;
//   - run.js does not write `replaced` onto the result (`replacedField` returns `{}`, the lane still takes the detour) =>
//     "replaced" red at the third run (c no longer hits, new spawn); the hit does not pass `replaced` on (the `result` with
//     `fromCache` without the field) => "replaced" red at the fourth run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { running } from "../electron/server/runs/state.js";
import { DYN_RESUME_CAP, dynWorkflowsAtStart, dynWorkflowsRestartGrace } from "../electron/server/dynworkflows/run.js";
import { replacedKey, newRunId, newTaskId, normOptions, key } from "../electron/server/dynworkflows/journal.js";
import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";

// The main agent (as in dynworkflows-run.test.js — a test file imports no other): "WF[<tag>]:{json}" calls
// cbase_dynamic_workflow with these arguments and stores the tool result under wf-<tag>; a completion notice it stores in
// notices.jsonl.
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
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test only waits for the file to exist
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    say({ type: "assistant", message: { id: "b-" + tag, content: [{ type: "text", text: "Workflow started" }] } });
    finished();
    say({ type: "result", result: "Workflow started", session_id: "main-session" });
    return;
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Response" }] } });
  finished();
  say({ type: "result", result: "Response", session_id: "main-session" });`;

// A workflow agent: {TAG:x} names it, {GATE:x} holds it at the gate. Every spawn appends an "x" to sub-start-<tag> — the
// count "no new spawn" reads this file. The gate opens a file `<name>` (gate.open); whoever reaches it a second time after a
// restart waits at `<name>-<spawn count>`, so the test releases the second pass on its own.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    const seq = fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length;
    say({ type: "assistant", message: { id: "s1-" + tag + seq, usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0] + "-" + seq);
    say({ type: "assistant", message: { id: "s2-" + tag + seq, content: [{ type: "text", text: "Finding " + tag + " #" + seq }] } });
    finished();
    say({ type: "result", result: "Finding " + tag + " #" + seq, session_id: "sub-" + tag + seq });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Resume', phases: [{ title: 'One' }] }\n${body}\n`;
async function startAt(ctx, chatId, tag, args) {
  await post(`${ctx.base}/api/chats/${chatId}/message`, { text: `WF[${tag}]:${JSON.stringify(args)}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
}
const spawns = (root, tag) => { const f = path.join(root, `sub-start-${tag}`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0; };
// The fakes (child processes) write the logs while the test reads — only completed lines (jsonl.mjs).
const notices = (root) => readJsonl(path.join(root, "notices.jsonl")).map((z) => z.text);
const resultFrom = (text) => text.split("<result>")[1]?.split("</result>")[0] ?? "";
const notMoreRunning = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} ended`);
const markers = (log, runId) => log.filter((m) => m.role === "workflow_marker").map((m) => JSON.parse(m.text)).filter((m) => m.runId === runId).map((m) => [m.phase, m.status]);

test("restart: a running workflow survives the restart — finished from the journal (no spawn), interrupted anew, no turn, completion notice arrives", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const text = script("resume", "const a = await agent('One {TAG:a}', { label: 'a' });\nconst b = await agent('Two {TAG:b} {GATE:b}', { label: 'b' });\nreturn { a, b };");
    const r = await startAt(ctx, chat.id, "n", { script: text, args: { x: 1 } });
    assert.equal(r.status, "started", JSON.stringify(r));
    await ctx.gate.reached("b-1");
    assert.deepEqual([spawns(root, "a"), spawns(root, "b")], [1, 1]);
    assert.deepEqual(store.readDynJournal(r.runId).map((e) => e.kind), ["launched", "started", "result", "launched", "started"]);

    await ctx.restart({ withBackground: true });
    const interrupted = store.readDynRun(r.runId);
    assert.equal(interrupted.status, "interrupted");
    assert.deepEqual(interrupted.args, { x: 1 }, "the args are on the run");
    assert.deepEqual(store.readDynJournal(r.runId).map((e) => e.kind), ["launched", "started", "result", "launched", "started"],
      "the agent aborted by the server end is only started, not failed");

    await fireHooks("restartGrace", {});
    const resumed = store.readDynRun(r.runId);
    assert.equal(resumed.status, "running", "the restart hook continues the run");
    // The restart here is ORDERLY (server.close → dynWorkflowsAtServerEnd): it costs no attempt (a crash does, see "attempt
    // cap" and dynworkflows-limits.test.js "restart").
    assert.equal(resumed.attempts, 0, "an orderly server end does not count as an attempt");
    await ctx.gate.reached("b-2");
    assert.equal(spawns(root, "a"), 1, "finished and unchanged => from the journal, no new spawn");
    assert.equal(spawns(root, "b"), 2, "interrupted => runs anew");
    // No turn: the chat is not running, /api/runs/active counts no turn — and the workflow is not in busy but in its own
    // field.
    assert.equal(running.has(chat.id), false, "the chat is not marked running");
    const active = await json(`${base}/api/runs/active`);
    assert.equal(active.runs, 0, JSON.stringify(active));
    assert.equal(active.busy, false, "the running workflow does not hold up the deploy");
    assert.equal(active.dynWorkflows.length, 1, "the running workflow is in its own field");

    ctx.gate.open("b-2");
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { a: "Finding a #1", b: "Finding b #2" }, "a from the cache, b new");
    await waitForTruthy(() => notices(root).length === 1, "CompletionNotice");
    const m = notices(root)[0];
    assert.ok(isCompletionNotice(m) && m.includes(`<task-id>${r.taskId}</task-id>`) && m.includes("<status>completed</status>"), m);
    assert.deepEqual(JSON.parse(resultFrom(m).replace(/&quot;/g, '"')), { a: "Finding a #1", b: "Finding b #2" });
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(markers(log, r.runId), [["start", undefined], ["end", "interrupted"], ["end", "finished"]], "no second start marker");
    // The journal continues without writing the hit twice.
    assert.deepEqual(store.readDynJournal(r.runId).map((e) => e.kind), ["launched", "started", "result", "launched", "started", "launched", "started", "result"]);
    await ctx.waitForIdle();
  }, { claude });
});

// The server runs here as its OWN process (`childProcess: true`) and crashes (`crash()`: SIGKILL, then a new process on the same
// data folder, immediate restart) — so without the safety net the server process really dies of the unhandled rejection, as
// in operation, and the test turns red instead of node:test swallowing the rejection.
test("attempt cap: a continuation that throws at every start becomes an error row and an attempt — given up after the cap and reported to the chat; the server process lives", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "d", { script: script("cap", "return await agent('Wait {TAG:d} {GATE:d}');") });
    await ctx.gate.reached("d-1");
    // First the turn that started the workflow must end — otherwise the first crash hits it in the middle of finishing, the
    // restart continues it from active_runs, and `busy` is afterwards true for a foreign reason.
    await waitForTruthy(async () => ((await json(`${base}/api/runs/active`)).runs | 0) === 0, "turn ended");
    // The continuation throws: the script is gone (it reads it from its file).
    fs.rmSync(r.scriptPath);
    // The reading connection only for ONE look: kept open across the crashes it would stand next to every new server
    // process, and a reader's lock has hit that process's writer before (dynworkflows-limits.test.js). ctx.db() itself waits
    // for a writer's lock (busy timeout, agent-harness.mjs).
    const row = () => {
      const db = ctx.db();
      try { return db.prepare("SELECT status, attempts, error FROM dyn_workflow_runs WHERE id = ?").get(r.runId); }
      finally { db.close(); }
    };
    const errorLines = async () => (await json(`${base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "hint" && m.text.includes(r.runId));
    for (let attempt = 1; attempt <= DYN_RESUME_CAP; attempt++) {
      await ctx.crash();
      // If the server process dies of a throw, the request fails here (ECONNREFUSED) — red, without hanging.
      await waitForTruthy(async () => (await errorLines()).length === attempt, `error row ${attempt}`);
      assert.deepEqual({ ...row(), error: undefined }, { status: "interrupted", attempts: attempt, error: undefined }, `attempt ${attempt}: counted, interrupted again`);
      // Quiet instead of a look at `busy` right after the error row: the restart runs immediately after the crash
      // (CBASE_RESTART_GRACE_MS=0), and what it kicks off is only through afterwards. A dead server does not answer — then
      // waitForQuiet returns null, and the line is red.
      const quiet = await ctx.waitForQuiet();
      assert.ok(quiet, "the server answers");
      assert.equal(quiet.busy, false, JSON.stringify(quiet));
    }
    // The counter survived the crashes: it is on the run in the database. The next start gives up.
    await ctx.crash();
    const abandoned = await waitForTruthy(() => { const z = row(); return z.status === "failed" ? z : null; }, "abandoned");
    assert.equal(abandoned.attempts, DYN_RESUME_CAP, "not taken up again");
    assert.match(abandoned.error, new RegExp(`${DYN_RESUME_CAP}`));
    await waitForTruthy(() => notices(root).length === 1, "notice to the chat");
    const m = notices(root)[0];
    assert.ok(m.includes(`<task-id>${r.taskId}</task-id>`) && m.includes("<status>failed</status>") && m.includes(r.runId), m);
    assert.equal(spawns(root, "d"), 1, "no further agent started");
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(markers(log, r.runId).at(-1), ["end", "failed"]);
    await ctx.waitForIdle();
  }, { claude, childProcess: true });
});

// Every deploy is an orderly server end. If EVERY pick-up counted, a workflow across three deploys would be given up at the
// third restart as "aborted again at every restart".
test("attempt cap only for aborts: three orderly server ends in a row — each is continued, none counts as an attempt, the run is not given up", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "g", { script: script("ordered", "return await agent('Wait {TAG:g} {GATE:g}', { label: 'g' });") });
    assert.equal(r.status, "started", JSON.stringify(r));
    const state = () => { const z = store.readDynRun(r.runId); return { status: z.status, attempts: z.attempts, ordered: z.endOrdered }; };
    for (let k = 1; k <= DYN_RESUME_CAP + 1; k++) {
      await ctx.gate.reached(`g-${k}`);
      await ctx.restart({ withBackground: true });
      assert.deepEqual(state(), { status: "interrupted", attempts: 0, ordered: true }, `server end ${k}: interrupted, orderly`);
      await fireHooks("restartGrace", {});
      assert.deepEqual(state(), { status: "running", attempts: 0, ordered: false }, `restart ${k}: continued, not counted, not given up`);
    }
    const last = DYN_RESUME_CAP + 2;
    await ctx.gate.reached(`g-${last}`);
    ctx.gate.open(`g-${last}`);
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.equal(end.returnValue, `Finding g #${last}`);
    assert.equal(spawns(root, "g"), last, "one new attempt of the agent per server end");
    await waitForTruthy(() => notices(root).length === 1, "CompletionNotice");
    assert.match(notices(root)[0], /<status>completed<\/status>/);
    await ctx.waitForIdle();
  }, { claude });
});

// The restart's decision on its own, without agents: the transitions of the row through the data layer (crash =
// dynWorkflowsAtStart finds "running", orderly = endDynRun with `ordered`), the restart itself through
// dynWorkflowsRestartGrace. Without a script file every continuation throws (error row, interrupted again — NOT orderly).
test("attempt cap only for aborts: a crash and a throwing continuation count, an orderly end does not — at the cap an orderly end still continues, the next abort gives up", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    const runId = newRunId();
    store.createDynRun({ runId, taskId: newTaskId(), chatId: chat.id, name: "cap-a1", meta: {}, scriptPath: path.join(root, "missing", "script.js"), outputPath: path.join(root, "a1-result.json") });
    const row = () => { const z = store.readDynRun(runId); return { status: z.status, attempts: z.attempts, ordered: z.endOrdered }; };
    const errorLines = async () => (await json(`${base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "hint" && m.text.includes(runId)).length;
    const ordered = () => assert.equal(store.endDynRun(runId, { status: "interrupted", ordered: true }), true);
    // In between the row stands on "running" without a run holding it: if a check fails there, the harness cleanup (quiet: no
    // running workflow) would wait forever — so the finally takes it out of "running" (otherwise a no-op).
    try {
      // 1. An orderly end does not count; the pick-up takes the mark back.
      ordered();
      assert.deepEqual(row(), { status: "interrupted", attempts: 0, ordered: true });
      assert.equal(store.pickUpDynRun(runId), true);
      assert.deepEqual(row(), { status: "running", attempts: 0, ordered: false }, "orderly => no attempt");
      // 2./3. Two crashes (the next start finds "running") count — also the first one AFTER an orderly end.
      for (const attempt of [1, 2]) {
        assert.equal(dynWorkflowsAtStart(), 1);
        assert.deepEqual(row(), { status: "interrupted", attempts: attempt - 1, ordered: false });
        assert.equal(store.pickUpDynRun(runId), true);
        assert.deepEqual(row(), { status: "running", attempts: attempt, ordered: false }, `crash ${attempt} => counted`);
      }
      // 4. An orderly end at the cap: the restart continues (does not count, does not give up). The continuation throws (no
      //    script) — interrupted again, this time NOT orderly.
      ordered();
      dynWorkflowsRestartGrace();
      assert.deepEqual(row(), { status: "running", attempts: DYN_RESUME_CAP, ordered: false }, "orderly at the cap => continued");
      await waitForTruthy(async () => (await errorLines()) === 1, "error row of the throwing continuation");
      assert.deepEqual(row(), { status: "interrupted", attempts: DYN_RESUME_CAP, ordered: false });
      // 5. Now an abort at the cap: given up and reported.
      dynWorkflowsRestartGrace();
      assert.deepEqual(row(), { status: "failed", attempts: DYN_RESUME_CAP, ordered: false }, "abort at the cap => given up");
      await waitForTruthy(() => notices(root).length === 1, "notice to the chat");
      assert.ok(notices(root)[0].includes("<status>failed</status>") && notices(root)[0].includes(runId), notices(root)[0]);
    } finally {
      store.endDynRun(runId, { status: "failed", error: "test end" });
    }
    await ctx.waitForIdle();
  }, { claude });
});

test("resumeFromRunId + scriptPath: the same script delivers the prefix from the journal; a changed, resolved provider::model restarts from that call on", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    // a has its model in the script (alias → claude::claude-opus-5-5), b inherits the chat's model.
    const text = script("prefix", "const a = await agent('A {TAG:ra}', { model: 'opus' });\nconst b = await agent('B {TAG:rb}');\nreturn { a, b };");
    const r1 = await startAt(ctx, chat.id, "r1", { script: text });
    assert.equal((await notMoreRunning(r1.runId)).status, "finished");
    await waitForTruthy(() => notices(root).length === 1, "completion notice 1");
    await ctx.waitForIdle();
    assert.deepEqual([spawns(root, "ra"), spawns(root, "rb")], [1, 1]);

    // Same script through scriptPath: everything from the cache, no spawn, the same return value, a run of its own.
    const r2 = await startAt(ctx, chat.id, "r2", { scriptPath: r1.scriptPath, resumeFromRunId: r1.runId });
    assert.equal(r2.status, "started", JSON.stringify(r2));
    assert.notEqual(r2.runId, r1.runId);
    const e2 = await notMoreRunning(r2.runId);
    assert.equal(e2.status, "finished", e2.error);
    assert.deepEqual(e2.returnValue, { a: "Finding ra #1", b: "Finding rb #1" });
    assert.deepEqual([spawns(root, "ra"), spawns(root, "rb")], [1, 1], "same script => no spawn");
    assert.equal(store.readDynRun(r2.runId).resumeOf, r1.runId);
    assert.ok(store.readDynJournal(r2.runId).filter((e) => e.kind === "result").every((e) => e.fromCache === true), "the hits are in the new journal");
    await waitForTruthy(() => notices(root).length === 2, "completion notice 2");
    await ctx.waitForIdle();

    // The chat's model changes: the script's text is the same, but b resolves differently => a from the cache, b new.
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-sonnet-5" }) });
    const r3 = await startAt(ctx, chat.id, "r3", { resumeFromRunId: r1.runId });
    assert.equal(r3.status, "started", JSON.stringify(r3));
    const e3 = await notMoreRunning(r3.runId);
    assert.equal(e3.status, "finished", e3.error);
    assert.deepEqual(e3.returnValue, { a: "Finding ra #1", b: "Finding rb #2" });
    assert.deepEqual([spawns(root, "ra"), spawns(root, "rb")], [1, 2], "changed resolved model => anew from that call on");
    const b3 = store.readDynJournal(r3.runId).find((e) => e.kind === "launched" && e.prompt.startsWith("B "));
    assert.equal(`${b3.provider}::${b3.model}`, "claude::claude-sonnet-5");
    await waitForTruthy(() => notices(root).length === 3, "completion notice 3");

    // An unknown run: a named error, nothing starts.
    const r4 = await startAt(ctx, chat.id, "r4", { resumeFromRunId: "wf_000000000000" });
    assert.match(r4.error || "", /nothing to resume|nichts fortzusetzen/);
    await ctx.waitForIdle();
  }, { claude });
});

// Seam of approval and resume: a resume without opt-in goes through the approval card — and stays a resume when accepted. The
// card's job remembers the predecessor (`resumeOf`); without it the accepted run would start from scratch (spawn instead of
// cache, `resumeOf` empty).
test("resumeFromRunId through the approval card: accepted, it runs the prefix from the predecessor's journal", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const text = script("card", "const a = await agent('A {TAG:ka}');\nreturn { a };");
    const r1 = await startAt(ctx, chat.id, "k1", { script: text });
    assert.equal((await notMoreRunning(r1.runId)).status, "finished");
    await waitForTruthy(() => notices(root).length === 1, "completion notice 1");
    await ctx.waitForIdle();
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ ultracode: false }) });

    const r2 = await startAt(ctx, chat.id, "k2", { resumeFromRunId: r1.runId });
    assert.equal(r2.status, "awaiting_approval", JSON.stringify(r2));
    await ctx.waitForIdle();
    const ent = await post(`${base}/api/chats/${chat.id}/dyn-workflows/approval`, { requestId: r2.requestId, decision: "accept" });
    assert.ok(ent.runId, JSON.stringify(ent));
    const e2 = await notMoreRunning(ent.runId);
    assert.equal(e2.status, "finished", e2.error);
    assert.equal(store.readDynRun(ent.runId).resumeOf, r1.runId);
    assert.deepEqual(e2.returnValue, { a: "Finding ka #1" });
    assert.equal(spawns(root, "ka"), 1, "accepted resume => hit from the cache, no spawn");
    // The completion notice is in the history (the agent gets it with the silent hint of the acceptance as a preamble —
    // `notices()` only reads inputs that BEGIN with the notice).
    await waitForTruthy(() => store.listMessages(chat.id).some((m) => typeof m.text === "string" && m.text.includes(`<task-id>${ent.taskId}</task-id>`)), "completion notice 2");
    await ctx.waitForIdle();
  }, { claude });
});

// ── Branch chains (journal.js header) ─────────────────────────────────────────────────────────
// The fallback: a deploy freezes running workflows and continues them from their journal. A journal written by the server
// BEFORE the branch chains carries linear keys and no chain kind on its `launched` — it must keep hitting, and the
// continuing run computes and writes linear on (no mixed chain), also through resumeFromRunId in two stages (C continues B,
// B continued A). The old journal is made here from a real run: while the server stands, its rows are rewritten to the old
// form (keys of the linear computation, `chain` removed) — the linear computation itself is bound to the Claude Code
// journal in dynworkflows-journal.test.js.
test("fallback: a journal of the LINEAR chain (server before the branch chains) is continued afterwards and hits — the restart and resumeFromRunId over two stages compute and write linear on", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const text = script("linear", "const [a, b] = await parallel([() => agent('LA {TAG:la}', { label: 'a' }), () => agent('LB {TAG:lb}', { label: 'b' })]);\nconst c = await agent('LC {TAG:lc} {GATE:lc}', { label: 'c' });\nreturn { a, b, c };");
    const r = await startAt(ctx, chat.id, "lin", { script: text });
    assert.equal(r.status, "started", JSON.stringify(r));
    await ctx.gate.reached("lc-1");
    await ctx.restart({ withBackground: true });
    assert.equal(store.readDynRun(r.runId).status, "interrupted");

    // The keys as the server computed them before: ONE chain in call order.
    const norm = (label) => normOptions({ label }, { model: "claude::claude-opus-5-5", kind: "linear" });
    const k1 = key("", "LA {TAG:la}", norm("a"));
    const k2 = key(k1, "LB {TAG:lb}", norm("b"));
    const k3 = key(k2, "LC {TAG:lc} {GATE:lc}", norm("c"));
    const linear = { 1: k1, 2: k2, 3: k3 };
    const fresh = store.readDynJournal(r.runId);
    assert.deepEqual(fresh.filter((e) => e.kind === "launched").map((e) => [e.n, e.chain]), [[1, "branches"], [2, "branches"], [3, "branches"]], "the fresh run computes the new kind");
    assert.deepEqual([1, 2, 3].map((n) => fresh.find((e) => e.n === n).key === linear[n]), [false, false, false], "and its keys are NOT the linear ones (otherwise the test would check nothing)");
    for (const z of rawDb.prepare("SELECT seq, n, entry FROM dyn_workflow_journal WHERE run_id = ?").all(r.runId)) {
      const e = JSON.parse(z.entry);
      delete e.chain;
      rawDb.prepare("UPDATE dyn_workflow_journal SET key = ?, entry = ? WHERE seq = ?").run(linear[z.n], JSON.stringify(e), z.seq);
    }
    const oldCount = store.readDynJournal(r.runId).length;

    await fireHooks("restartGrace", {});
    await ctx.gate.reached("lc-2");
    assert.deepEqual([spawns(root, "la"), spawns(root, "lb"), spawns(root, "lc")], [1, 1, 2], "the two from parallel() come from the linear journal, only the interrupted one runs anew");
    ctx.gate.open("lc-2");
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { a: "Finding la #1", b: "Finding lb #1", c: "Finding lc #2" });
    // The continuing attempt keeps writing in the journal's kind: the same linear key, the kind now explicit.
    const alongside = store.readDynJournal(r.runId).slice(oldCount);
    assert.deepEqual(alongside.map((e) => [e.kind, e.n, e.key === k3]), [["launched", 3, true], ["started", 3, true], ["result", 3, true]]);
    assert.equal(alongside[0].chain, "linear");
    await waitForTruthy(() => notices(root).length === 1, "completion notice 1");
    await ctx.waitForIdle();

    // B continues A (resumeFromRunId, new journal), C continues B: everything from the journal, still linear.
    let before = r.runId;
    for (const [i, tag] of ["lin-b", "lin-c"].entries()) {
      const f = await startAt(ctx, chat.id, tag, { resumeFromRunId: before });
      assert.equal(f.status, "started", JSON.stringify(f));
      const e = await notMoreRunning(f.runId);
      assert.equal(e.status, "finished", e.error);
      assert.deepEqual(e.returnValue, { a: "Finding la #1", b: "Finding lb #1", c: "Finding lc #2" }, tag);
      assert.deepEqual([spawns(root, "la"), spawns(root, "lb"), spawns(root, "lc")], [1, 1, 2], `${tag}: no new spawn`);
      const j = store.readDynJournal(f.runId);
      assert.deepEqual(j.filter((x) => x.kind === "launched").map((x) => [x.n, x.key, x.chain]), [[1, k1, "linear"], [2, k2, "linear"], [3, k3, "linear"]], `${tag}: linear keys, kind explicit`);
      assert.deepEqual(j.filter((x) => x.kind === "result").map((x) => x.fromCache), [true, true, true]);
      await waitForTruthy(() => notices(root).length === i + 2, `completion notice ${tag}`);
      await ctx.waitForIdle();
      before = f.runId;
    }
  }, { claude });
});

// Two branches with two agents each in sequence, one after the join. In the linear computation the key of each SECOND agent
// depended on which first agent finished first (its call then came earlier); with branch chains every branch computes on
// its own lane — two runs of the same script with reversed completion order write the same keys (with different `n`), and
// a resume of either hits everything.
test("two branches with two agents each: the keys do not depend on the completion order — two runs with reversed order write the same ones, and a resume of either hits all five without a spawn", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const text = script("branches", [
      "const r = await parallel([",
      "  async () => { const x = await agent('A1 {TAG:a1} {GATE:a1}', { label: 'a1' }); return [x, await agent('A2 {TAG:a2} {GATE:a2}', { label: 'a2' })]; },",
      "  async () => { const y = await agent('B1 {TAG:b1} {GATE:b1}', { label: 'b1' }); return [y, await agent('B2 {TAG:b2} {GATE:b2}', { label: 'b2' })]; },",
      "]);",
      "const z = await agent('Z {TAG:z}', { label: 'z' });",
      "return { r, z };",
    ].join("\n"));
    const tags = ["a1", "a2", "b1", "b2", "z"];
    const perLabel = (runId, f) => Object.fromEntries(store.readDynJournal(runId).filter((e) => e.kind === "launched").map((e) => [e.label, f(e)]));
    // A fresh run; `first2` names the branch whose first agent finishes first (its second is then call 3).
    const runFresh = async (tag, seq, first2) => {
      const run = await startAt(ctx, chat.id, tag, { script: text });
      assert.equal(run.status, "started", JSON.stringify(run));
      const [first, then] = first2 === "a" ? ["a", "b"] : ["b", "a"];
      await Promise.all([ctx.gate.reached(`a1-${seq}`), ctx.gate.reached(`b1-${seq}`)]);
      ctx.gate.open(`${first}1-${seq}`);
      await ctx.gate.reached(`${first}2-${seq}`);
      ctx.gate.open(`${then}1-${seq}`);
      await ctx.gate.reached(`${then}2-${seq}`);
      ctx.gate.open(`a2-${seq}`);
      ctx.gate.open(`b2-${seq}`);
      const e = await notMoreRunning(run.runId);
      assert.equal(e.status, "finished", e.error);
      assert.deepEqual(e.returnValue, { r: [[`Finding a1 #${seq}`, `Finding a2 #${seq}`], [`Finding b1 #${seq}`, `Finding b2 #${seq}`]], z: `Finding z #${seq}` });
      await waitForTruthy(() => notices(root).length === seq, `completion notice ${tag}`);
      await ctx.waitForIdle();
      return run;
    };
    const one = await runFresh("z1", 1, "b");
    const two = await runFresh("z2", 2, "a");
    // The call order was different …
    assert.deepEqual(perLabel(one.runId, (e) => e.n), { a1: 1, b1: 2, b2: 3, a2: 4, z: 5 });
    assert.deepEqual(perLabel(two.runId, (e) => e.n), { a1: 1, b1: 2, a2: 3, b2: 4, z: 5 });
    // … the keys are the same, also the one behind the join.
    assert.deepEqual(perLabel(two.runId, (e) => e.key), perLabel(one.runId, (e) => e.key));
    assert.equal(new Set(Object.values(perLabel(one.runId, (e) => e.key))).size, 5);
    assert.deepEqual(tags.map((t) => spawns(root, t)), [2, 2, 2, 2, 2]);

    // Resume of either: all five from the journal, no spawn, the return value of the respective predecessor.
    for (const [i, [before, seq]] of [[one, 1], [two, 2]].entries()) {
      const f = await startAt(ctx, chat.id, `z-resume-${seq}`, { resumeFromRunId: before.runId });
      assert.equal(f.status, "started", JSON.stringify(f));
      const e = await notMoreRunning(f.runId);
      assert.equal(e.status, "finished", e.error);
      assert.deepEqual(e.returnValue, { r: [[`Finding a1 #${seq}`, `Finding a2 #${seq}`], [`Finding b1 #${seq}`, `Finding b2 #${seq}`]], z: `Finding z #${seq}` });
      assert.deepEqual(tags.map((t) => spawns(root, t)), [2, 2, 2, 2, 2], "no new spawn");
      assert.deepEqual(store.readDynJournal(f.runId).filter((x) => x.kind === "result").map((x) => x.fromCache), [true, true, true, true, true]);
      assert.deepEqual(perLabel(f.runId, (x) => x.key), perLabel(one.runId, (x) => x.key));
      await waitForTruthy(() => notices(root).length === 3 + i, `completion notice resume ${seq}`);
      await ctx.waitForIdle();
    }
  }, { claude });
});

// "Replaced" at the main seam (journal.js header): an agent that had an end in the predecessor (here: skipped) and runs LIVE at
// the resume diverts the lane behind it — the call after it gets a new key (its old result came about behind an agent
// without a result). The result carries `replaced: <agentId>`; a resume of THIS run (new journal, the predecessor's entries
// are missing there) takes the same detour at the hit and hits the call behind it — also in the next stage, where the
// result itself was already a hit.
test("replaced: an agent rerun at the resume diverts the chain behind it — the call after it runs anew, and resumes of this run (two stages) hit everything", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const text = script("replaced", "const a = await agent('EA {TAG:ea}', { label: 'a' });\nconst b = await agent('EB {TAG:eb} {GATE:eb}', { label: 'b' });\nconst c = await agent('EC {TAG:ec}', { label: 'c' });\nreturn { a, b, c };");
    const tags = ["ea", "eb", "ec"];
    const start = (runId, n) => store.readDynJournal(runId).find((e) => e.kind === "launched" && e.n === n);
    const finishedOf = async (run, count) => {
      const e = await notMoreRunning(run.runId);
      assert.equal(e.status, "finished", e.error);
      await waitForTruthy(() => notices(root).length === count, `completion notice ${count}`);
      await ctx.waitForIdle();
      return e;
    };
    // Run 1: b is skipped (failed in the journal), c runs behind it.
    const r1 = await startAt(ctx, chat.id, "e1", { script: text });
    await ctx.gate.reached("eb-1");
    await post(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${r1.runId}/agents/2/skip`, {});
    assert.deepEqual((await finishedOf(r1, 1)).returnValue, { a: "Finding ea #1", b: null, c: "Finding ec #1" });
    const kB = start(r1.runId, 2).key;

    // Run 2 continues 1: a from the journal, b live (it had an end), c live under a NEW key.
    const r2 = await startAt(ctx, chat.id, "e2", { resumeFromRunId: r1.runId });
    await ctx.gate.reached("eb-2");
    ctx.gate.open("eb-2");
    assert.deepEqual((await finishedOf(r2, 2)).returnValue, { a: "Finding ea #1", b: "Finding eb #2", c: "Finding ec #2" });
    assert.deepEqual(tags.map((t) => spawns(root, t)), [1, 2, 2]);
    const j2 = store.readDynJournal(r2.runId);
    const b2 = j2.find((e) => e.kind === "result" && e.n === 2);
    assert.equal(start(r2.runId, 2).key, kB, "b under its old key");
    assert.ok(b2.agentId && b2.replaced === b2.agentId, `the result names the detour (${JSON.stringify({ agentId: b2.agentId, replaced: b2.replaced })})`);
    const kC = key(replacedKey(kB, b2.agentId), "EC {TAG:ec}", normOptions({ label: "c" }, { model: "claude::claude-opus-5-5" }));
    assert.equal(start(r2.runId, 3).key, kC, "c hangs behind the detour");
    assert.notEqual(kC, start(r1.runId, 3).key);
    assert.equal(j2.find((e) => e.kind === "result" && e.n === 3).replaced, undefined, "a new key had no end: nothing to replace");

    // Run 3 continues 2, run 4 continues 3: everything from the journal — the hit on b takes the detour and passes it on.
    let before = r2;
    for (const [i, tag] of ["e3", "e4"].entries()) {
      const f = await startAt(ctx, chat.id, tag, { resumeFromRunId: before.runId });
      assert.deepEqual((await finishedOf(f, 3 + i)).returnValue, { a: "Finding ea #1", b: "Finding eb #2", c: "Finding ec #2" }, tag);
      assert.deepEqual(tags.map((t) => spawns(root, t)), [1, 2, 2], `${tag}: no new spawn`);
      const j = store.readDynJournal(f.runId);
      assert.deepEqual(j.filter((e) => e.kind === "launched").map((e) => e.key), [start(r1.runId, 1).key, kB, kC], tag);
      assert.deepEqual(j.filter((e) => e.kind === "result").map((e) => [e.n, e.fromCache, e.replaced]), [[1, true, undefined], [2, true, b2.agentId], [3, true, undefined]], tag);
      before = f;
    }
  }, { claude });
});
