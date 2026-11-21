// The merge of the subagent list (src/lib/agents.ts): running ones from the SSE event, finished ones from the
// history, and each EXACTLY ONCE. Without a browser, because this checks the contract that the right rail
// (AgentBar.tsx), the mark in the history and the iOS app share.
//
// Counter-test: remove in `agentsList` the id match (the line that assigns the block to a running entry via
// `bl.id` or `rep.agentId`) and push every block to `onlyBlock`; the third case below then yields TWO entries
// instead of one, and "live wins" is void: exactly the duplication that moving into the right rail is meant to
// remove.
//
// Run:  node --test web/test/agents.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// Like tool-summary.test.mjs: compile the real source with the local tsc and import it.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-agents-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "agents.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  agentsList, tokenText, tokenTitle, tokenShort, durationShort, fmtTokens, modelText, modelShort,
  appendMeasurementPoint, tempoProMinute, stateCard, stateKey, bubblesKey,
  backgroundAfter, BACKGROUND_EMPTY, waitingUntilText,
} = await import(pathToFileURL(path.join(out, "agents.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// The same placeholder replacement as `fmt` in src/lib/i18n.ts; English is the key.
const t = (k, p) => (p ? k.replace(/\{(\w+)\}/g, (m, x) => (x in p ? String(p[x]) : m)) : k);

// A finished report, as agent-runtime.js writes it as tool_result.
const report = (o = {}) => JSON.stringify({
  status: "completed", agentId: "a-1", description: "Read tests", provider: "claude",
  resolvedModel: "claude-opus-5", report: "Everything green.", totalTokens: 4200,
  totalToolUseCount: 7, totalDurationMs: 64_000, ...o,
});
const block = (o = {}) => ({ kind: "tool", name: "Task", id: "tu-1", input: { description: "Read tests" }, done: true, ...o });

test("only running: they come from the event, carry no report and stand on \"running\"", () => {
  const l = agentsList([{
    taskId: "task-9", agentId: "a-9", description: "Build test bench", provider: "codex",
    model: "gpt-5.6-sol", status: "running", startedAt: 1000, tokens: 12_000, tokenKind: "only_output", toolUses: 3,
  }], []);
  assert.equal(l.length, 1);
  assert.equal(l[0].status, "running");
  assert.equal(l[0].live, true);
  assert.equal(l[0].job, "Build test bench");
  assert.equal(l[0].model, "codex::gpt-5.6-sol");
  assert.equal(l[0].agentId, "a-9");
  assert.equal(l[0].report, undefined);
  assert.equal(l[0].tokens, 12_000);
  assert.equal(l[0].startedAt, 1000);
});

test("only finished: job, model, duration, tokens and report come from the tool_result", () => {
  const l = agentsList([], [block({ result: report() })]);
  assert.equal(l.length, 1);
  assert.equal(l[0].status, "finished");
  assert.equal(l[0].live, false);
  assert.equal(l[0].withoutResult, false);
  assert.equal(l[0].report, "Everything green.");
  assert.equal(l[0].durationMs, 64_000);
  assert.equal(l[0].tokens, 4200);
  assert.equal(l[0].tools, 7);
  assert.equal(l[0].model, "claude::claude-opus-5");
});

// A FINISHED agent comes after reloading only from the report, which carries `tokenKind` (agent-runtime.js report()).
// The rail shows `tokenShort(agent.tokens, agent.tokenKind)` (AgentBar.tsx), the report header `tokenText`.
// Counter-test against the old state (fixed "full"): the mark is missing, the first check is red.
test("finished agent after reloading: `tokenKind` comes from the report; a lower bound shows \"≥\" and \"at least\"", () => {
  const [codex] = agentsList([], [block({ result: report({ provider: "codex", totalTokens: 12_000, tokenKind: "only_output" }) })]);
  assert.equal(codex.tokenKind, "only_output", "the lower bound from the report");
  assert.equal(tokenShort(codex.tokens, codex.tokenKind), "≥12k");
  assert.equal(tokenText(codex.tokens, codex.tokenKind, t), "at least 12k");
  // Complete count (Claude): still no mark.
  const [claude] = agentsList([], [block({ result: report({ tokenKind: "full" }) })]);
  assert.equal(claude.tokenKind, "full");
  assert.equal(tokenShort(claude.tokens, claude.tokenKind), "4,2k");
});

// The title of the number breaks it down; cache reads stand last and expressly outside the sum. Without parts it stays
// the number alone.
test("title of a token count: the number, below it its parts; cache reads not counted", () => {
  const parts = { input: 10, cacheWrite: 19_288, cacheRead: 102_640, output: 3_431 };
  assert.equal(tokenTitle(22_729, "full", parts, t),
    ["23k", "Input: 10", "Cache written: 19k", "Output: 3,4k", "Cache read: 103k (not counted)"].join("\n"));
  assert.equal(tokenTitle(22_729, "full", undefined, t), "23k");
  assert.equal(tokenTitle(12_000, "only_output", undefined, t), "at least 12k");
  assert.equal(tokenTitle(undefined, "full", parts, t), "");
});

test("finished agent from old data (report WITHOUT `tokenKind`): unknown, not silently \"full\"", () => {
  const [old] = agentsList([], [block({ result: report() })]);
  assert.equal("tokenKind" in JSON.parse(report()), false, "the old-data report really does not carry the field");
  assert.equal(old.tokenKind, undefined, "without the field the kind is unknown; nobody measured \"full\"");
  // The display also carries the mark for the unknown: whether the number is complete nobody measured, "at least" is
  // true for every counted one. Counter-test (tokenLowerLimit only for "only_output"): the two lines here are red.
  assert.equal(tokenShort(old.tokens, old.tokenKind), "≥4,2k");
  assert.equal(tokenText(old.tokens, old.tokenKind, t), "at least 4,2k");
  // A foreign value is just as unknown, not the first of the two kinds that happens to fit.
  const [foreign] = agentsList([], [block({ result: report({ tokenKind: "estimated" }) })]);
  assert.equal(foreign.tokenKind, undefined);
  assert.equal(tokenShort(foreign.tokens, foreign.tokenKind), "≥4,2k");
});

test("the same agent live AND as a block: exactly ONE entry, and live wins", () => {
  // The background agent gets a tool_result at once ("status: running"): the block is there, but the agent is
  // running. Without the match it would stand twice in the list.
  const bl = block({ id: "tu-7", result: JSON.stringify({ status: "running", agentId: "a-7" }) });
  const l = agentsList([{
    taskId: "task-7", agentId: "a-7", description: "Read diff", provider: "claude",
    model: "claude-fable-5-1", status: "running", startedAt: 500, tokens: 800, tokenKind: "full",
  }], [bl]);
  assert.equal(l.length, 1, "exactly once; the id match takes hold");
  assert.equal(l[0].status, "running");
  assert.equal(l[0].live, true);
  assert.equal(l[0].job, "Read diff");
  assert.equal(l[0].tokens, 800);
  // The key is the tool call id; the selection from the mark in the history hangs on it.
  assert.equal(l[0].id, "tu-7");

  // Also via the agentId in the report, when the tool call id does not come along.
  const l2 = agentsList([{ agentId: "a-1", description: "Read tests", provider: "claude", model: "claude-opus-5" }],
    [block({ id: "", result: report() })]);
  assert.equal(l2.length, 1);
  assert.equal(l2[0].live, true);
});

test("running first, then the finished ones in history order", () => {
  const l = agentsList(
    [{ agentId: "live-1", description: "still running", provider: "claude" }],
    [
      block({ id: "tu-a", result: report({ agentId: "a-a", description: "first" }) }),
      block({ id: "tu-b", result: report({ agentId: "a-b", description: "second" }) }),
    ],
  );
  assert.deepEqual(l.map((a) => a.job), ["still running", "first", "second"]);
});

test("empty inputs yield an empty list; no entry out of nothing", () => {
  assert.deepEqual(agentsList([], []), []);
  assert.deepEqual(agentsList(undefined, undefined), []);
});

test("a block without a report is neither finished nor running; it says \"without result\"", () => {
  // Run stopped or restarted: the call is in the history, a report never came.
  const l = agentsList([], [block({ result: "", done: false })]);
  assert.equal(l.length, 1);
  assert.equal(l[0].withoutResult, true);
  assert.equal(l[0].status, "error");
  assert.equal(l[0].report, undefined);
  assert.equal(l[0].job, "Read tests", "the job then stands in the tool call");
});

test("a stopped agent carries its raw status; \"stopped\" is not \"failed\"", () => {
  const l = agentsList([], [block({ result: report({ status: "stopped", report: "", error: "Stopped by the human." }) })]);
  assert.equal(l[0].status, "error");
  assert.equal(l[0].rawStatus, "stopped");
  assert.equal(l[0].withoutResult, false);
  assert.equal(l[0].report, "Stopped by the human.");
});

test("tokens with \"at least\" for every kind except \"full\" (unknown included)", () => {
  assert.equal(tokenText(12_000, "only_output", t), "at least 12k");
  assert.equal(tokenText(12_000, "full", t), "12k");
  assert.equal(tokenText(12_000, undefined, t), "at least 12k");
  // No number means no statement, not "0".
  assert.equal(tokenText(undefined, "full", t), "");
  assert.equal(fmtTokens(940), "940");
  assert.equal(fmtTokens(1200), "1,2k");
});

test("tokens short: \"≥\" stands for the words \"at least\" in the column, and ONLY where it applies", () => {
  assert.equal(tokenShort(12_000, "only_output"), "≥12k");
  assert.equal(tokenShort(12_000, "full"), "12k");
  assert.equal(tokenShort(940, undefined), "≥940");
  // No number is not a zero: the column stays empty and sets its own dash.
  assert.equal(tokenShort(undefined, "full"), "");
  // The two forms say the same: the same number, once as a word, once as a sign.
  assert.equal(tokenShort(12_000, "only_output").slice(1), tokenText(12_000, "only_output", t).replace("at least ", ""));
});

test("duration short is m:ss, from an hour on h:mm:ss", () => {
  assert.equal(durationShort(64_000), "1:04");
  assert.equal(durationShort(9_000), "0:09");
  assert.equal(durationShort(3_725_000), "1:02:05");
});

test("model as \"provider::model\"; \"(provider default)\" is not a model", () => {
  assert.equal(modelText("claude", "claude-opus-5"), "claude::claude-opus-5");
  assert.equal(modelText("codex", "(provider default)"), "codex");
  assert.equal(modelText("", "gpt-6-astra"), "gpt-6-astra");
  assert.equal(modelText("", ""), "");
});

test("model short: the double provider drops out, a foreign model name stays whole", () => {
  // The narrow column of the rail shows "claude::opus-5"; cut off it would read
  // "claude::claud…", which no longer names the model.
  // The input is the FINISHED spelling, as `Agent.model` carries it.
  assert.equal(modelShort(modelText("claude", "claude-opus-5")), "claude::opus-5");
  assert.equal(modelShort("claude::claude-fable-5-1"), "claude::fable-5-1");
  // No double head: nothing to shorten.
  assert.equal(modelShort("codex::gpt-6-astra"), "codex::gpt-6-astra");
  // A model name that only HAPPENS to begin with the provider needs the hyphen:
  // "claudia" is not "claude-".
  assert.equal(modelShort("claude::claudia"), "claude::claudia");
  // Without "::" there is nothing to shorten: the provider alone, a model alone, or nothing at all.
  assert.equal(modelShort("claude"), "claude");
  assert.equal(modelShort("claude-opus-5"), "claude-opus-5");
  assert.equal(modelShort(""), "");
  // The counter-test to the bug found: applied twice the result stays the same, and
  // the provider is NOT prefixed a second time.
  assert.equal(modelShort(modelShort("claude::claude-opus-5")), "claude::opus-5");
});

test("tempo: under two measurement points and under the minimum span it stays EMPTY instead of lying", () => {
  assert.equal(tempoProMinute([]), null);
  assert.equal(tempoProMinute([{ time: 0, tokens: 10 }]), null);
  // 400 ms apart: any number per minute could be extrapolated from that.
  assert.equal(tempoProMinute([{ time: 0, tokens: 0 }, { time: 400, tokens: 40 }]), null);
  // 30 s, 1000 tokens => 2000/min.
  assert.equal(tempoProMinute([{ time: 0, tokens: 0 }, { time: 30_000, tokens: 1000 }]), 2000);
});

test("the tempo window slides: old points drop, a step back starts anew", () => {
  let p = [];
  for (const [time, tokens] of [[0, 0], [20_000, 500], [40_000, 1000], [70_000, 1750]]) p = appendMeasurementPoint(p, time, tokens);
  // The ANCHOR stays: the last point before the window boundary is not cut away with the rest;
  // otherwise the span would shrink with every cut and the tempo would drop out for no reason.
  assert.equal(p[0].time, 0);
  assert.equal(tempoProMinute(p), 1500);
  // Only the point after next pushes the zero out (boundary 30 s, anchor 20 s).
  const further = appendMeasurementPoint(p, 90_000, 2000);
  assert.equal(further[0].time, 20_000);
  // A new run counts from the start: the old series would be a negative increment.
  const fresh = appendMeasurementPoint(p, 80_000, 12);
  assert.equal(fresh.length, 1);
  assert.equal(tempoProMinute(fresh), null);
});

// ── The state per agent ─────────────────────────────────────────────────────────────────────────
// The chain itself is checked by history-without-points.test.mjs; here is what the LIST gives it: who comes from the
// stream, who only from the history, and which turn is running.
const identifier = (a) => a.state?.identifier ?? "finished";

test("state: the stream wins, even when the call stands in an OLDER bubble", () => {
  // Background agent: call `done` with "running", a new answer has already arisen; the block therefore does NOT
  // stand in `running`. The stream leads it: "running", as in the rail.
  const bl = block({ id: "tu-bg", result: JSON.stringify({ status: "running", agentId: "a-bg" }) });
  const l = agentsList([{ taskId: "tu-bg", agentId: "a-bg", description: "Background" }], [bl], new Set());
  assert.equal(l.length, 1);
  assert.equal(identifier(l[0]), "running");
});

test("state: only from the history; the four intentional changes to the rail", () => {
  const running = new Set(["tu-run"]);
  const l = agentsList([], [
    // native CLI `Task`, finished, without JSON report: formerly "without result", now finished
    block({ id: "tu-native", result: "Read through.", done: true }),
    // the same in the running turn, still without result: formerly "without result", now "running"
    block({ id: "tu-run", result: undefined, done: false }),
    // error without report: formerly "without result", now "error"
    block({ id: "tu-err", result: "Boom", resultIsError: true, done: true }),
    // another raw status with a result: formerly "failed", now finished
    block({ id: "tu-different", result: report({ status: "timeout" }), done: true }),
  ], running);
  assert.deepEqual(l.map((a) => [a.id, identifier(a)]), [
    ["tu-native", "finished"], ["tu-run", "running"], ["tu-err", "error"], ["tu-different", "finished"],
  ]);
});

test("state: without `running` no turn is running; the call without result is called \"without result\"", () => {
  const l = agentsList([], [block({ id: "tu-x", result: undefined, done: false })]);
  assert.equal(identifier(l[0]), "without-result");
  // A background call with "running" that the stream no longer leads is over, even when its turn is still
  // running: the list is known, it is not in it.
  const bg = agentsList([], [block({ id: "tu-bg", result: JSON.stringify({ status: "running" }) })], new Set(["tu-bg"]));
  assert.equal(identifier(bg[0]), "without-result");
  // Stopped carries its word, finished none.
  const st = agentsList([], [block({ id: "tu-s", result: report({ status: "stopped" }) })]);
  assert.equal(identifier(st[0]), "stopped");
  const ok = agentsList([], [block({ id: "tu-ok", result: report() })]);
  assert.equal(ok[0].state, null, "a finished agent carries no word");
});

test("stateCard / stateKey: block id to state; same content gives the same key", () => {
  const list = agentsList(
    [{ taskId: "tu-1", agentId: "a-1", description: "running", tokens: 10 }],
    [block({ id: "tu-1", result: JSON.stringify({ status: "running" }) }), block({ id: "tu-2", result: report({ agentId: "a-2" }) })],
  );
  const card = stateCard(list);
  assert.equal(card.get("tu-1").identifier, "running");
  assert.equal(card.has("tu-2"), true, "a finished one stands WITH null in the card, not missing");
  assert.equal(card.get("tu-2"), null);
  assert.equal(stateKey(list), "tu-1:running|tu-2:finished");
  // A token tick changes the list, not the key; memoization hangs on it.
  const tick = agentsList(
    [{ taskId: "tu-1", agentId: "a-1", description: "running", tokens: 999 }],
    [block({ id: "tu-1", result: JSON.stringify({ status: "running" }) }), block({ id: "tu-2", result: report({ agentId: "a-2" }) })],
  );
  assert.notEqual(tick, list);
  assert.equal(stateKey(tick), stateKey(list));
  // An entry without id (stream without call id, no block) belongs in no card.
  const without = agentsList([{ description: "without id" }], []);
  assert.equal(stateCard(without).size, 0);
  assert.equal(stateKey(without), "");
});

test("bubblesKey: a row sees only the states of ITS calls", () => {
  const card = new Map([["tu-a", { identifier: "running" }], ["tu-b", null]]);
  const rowA = [{ kind: "text" }, { kind: "tool", id: "tu-a" }, { kind: "tool", id: "tu-foreign" }];
  const rowB = [{ kind: "tool", id: "tu-b" }];
  assert.equal(bubblesKey(rowA, card), "tu-a:running|");
  assert.equal(bubblesKey(rowB, card), "tu-b:finished|");
  // If only tu-a changes, the key of row B stands still; it does not redraw.
  const fresh = new Map([["tu-a", { identifier: "stopped" }], ["tu-b", null]]);
  assert.notEqual(bubblesKey(rowA, fresh), bubblesKey(rowA, card));
  assert.equal(bubblesKey(rowB, fresh), bubblesKey(rowB, card));
  // Without a card (fallback) every row is the same.
  assert.equal(bubblesKey(rowA, undefined), "");
});

// ── Background agents survive their turn ───────────────────────────────────────────────────────
// The state the hook useBackground holds, and the list the rail computes from it. Counter-test (shown red): in
// `backgroundAfter` empty everything again on `run_done` (`return BACKGROUND_EMPTY`): the agent drops out of the list
// and stands as "without result".
const live = { taskId: "a-7", agentId: "a-7", toolUseId: "tu-7", description: "On the side", provider: "claude", model: "", status: "running", startedAt: 1, tokens: 3, tokenKind: "only_output", toolUses: 0 };
const hgBlock = block({ id: "tu-7", name: "mcp__cbase__cbase_agent", input: { description: "On the side" }, result: JSON.stringify({ status: "running", agentId: "a-7" }) });
const harness = (subtype, o = {}) => ({ type: "harness", subtype, ...o });
const run = (...evts) => evts.reduce((s, e) => backgroundAfter(s, e), BACKGROUND_EMPTY);

// A turn that THROWS while a background agent lives. `run_error` empties the whole state (the client does not know what
// the error took along); the server therefore reports the survivors once more AFTER the error (runs/do-run.js startRun;
// the guard there: agent-lifetime.test.js "error with survivors"). Here the sequence as the server sends it since,
// and the old one beside it: with it the living agent was gone after `run_error`.
test("background state: error with survivors; after run_error and the repeat report the agent is still there", () => {
  const prior = [
    harness("connected", { running: false, agents: [live] }),
    harness("run_started"),
    harness("background", { agents: [live] }), // the finally reports the survivors
  ];
  const fresh = run(...prior, harness("run_error", { stderr: "Preparation broken" }), harness("background", { agents: [live] }));
  assert.deepEqual(fresh.agents.map((a) => a.agentId), ["a-7"], "the agent stands after run_error");
  assert.equal(agentsList(fresh.agents, [hgBlock], new Set())[0].live, true, "and live in the rail");
  const old = run(...prior, harness("run_error", { stderr: "Preparation broken" }));
  assert.deepEqual(old.agents, [], "the old sequence (without repeat report) emptied it; that is why the server reports again");
});

test("background state: run_done empties only the foreground; the background agent stays and stands as running", () => {
  const s = run(
    harness("connected", { running: true, agents: [] }),
    harness("run_started"),
    harness("background", { agents: [live], monitors: [{ taskId: "m1" }], tasks: [{ taskId: "b1" }], wakeupAt: 99 }),
    harness("run_done"),
  );
  assert.equal(s.waiting, false);
  assert.deepEqual(s.tasks, [], "commands belong to the turn");
  // The wakeup belongs to the CHAT (server runs/wakeup.js): it survives run_done; its end is reported by `background`.
  assert.equal(s.wakeupAt, 99, "the wakeup survives run_done");
  const aborted = run(harness("background", { wakeupAt: 77, wakeupReason: "R", wakeupPrompt: "P" }), harness("run_aborted"));
  assert.deepEqual([aborted.wakeupAt, aborted.wakeup.reason], [77, "R"], "and an abort");
  assert.equal(run(harness("background", { wakeupAt: 77 }), harness("background", { wakeupAt: 0 })).wakeupAt, 0, "a background without it takes it away");
  // A monitor belongs to the CHAT (server runs/monitors.js): it survives run_done like the agent.
  assert.deepEqual(s.monitors.map((m) => m.taskId), ["m1"], "the monitor survives run_done");
  assert.deepEqual(s.agents.map((a) => a.agentId), ["a-7"], "the agent survives run_done");
  // The rail: after run_done no turn is running any more (empty `running` set); the agent still stands live, with agentId
  // (stop button), not as "without result".
  const [a] = agentsList(s.agents, [hgBlock], new Set());
  assert.equal(a.live, true);
  assert.equal(a.agentId, "a-7", "without agentId no stop button");
  assert.equal(a.state?.identifier, "running");
  // A new turn (say a user message) does not take it away either.
  assert.deepEqual(backgroundAfter(s, harness("run_started")).agents.map((x) => x.agentId), ["a-7"]);
});

test("background state: the server reports the end (background without it); afterwards \"finished\" from the history", () => {
  const s = run(harness("background", { agents: [live] }), harness("run_done"), harness("background", { agents: [] }));
  assert.deepEqual(s.agents, []);
  const finished = block({ id: "tu-7", name: "mcp__cbase__cbase_agent", result: report({ agentId: "a-7" }) });
  const [a] = agentsList(s.agents, [finished], new Set());
  assert.equal(a.live, false);
  assert.equal(a.state, null, "finished carries no word");
});

test("background state: reloading after run_done; the connected event carries the living agent", () => {
  const s = run(harness("connected", { running: false, waiting: false, agents: [live] }));
  const [a] = agentsList(s.agents, [hgBlock], new Set());
  assert.equal(a.state?.identifier, "running");
  assert.equal(a.agentId, "a-7");
});

test("background state: abort and error empty everything; unknown events leave the state alone (same identity)", () => {
  const s = run(harness("background", { agents: [live] }));
  assert.equal(backgroundAfter(s, harness("run_aborted")), BACKGROUND_EMPTY);
  assert.equal(backgroundAfter(s, harness("run_error")), BACKGROUND_EMPTY);
  assert.equal(backgroundAfter(s, harness("title")), s);
  assert.equal(backgroundAfter(s, { type: "stream_event" }), s);
  assert.equal(backgroundAfter(s, harness("run_busy")), s, "nothing was waiting; nothing changed");
  const w = backgroundAfter(s, harness("run_waiting", { agents: [live] }));
  assert.equal(w.waiting, true);
  assert.equal(backgroundAfter(w, harness("background", { agents: [live] })).waiting, true, "background leaves the waiting phase standing");
  assert.equal(backgroundAfter(w, harness("run_busy")).waiting, false);
});

test("parked: the row carries parkedUntil, only with status \"parked\", and \"waiting until HH:MM\"", () => {
  const until = new Date(2026, 8, 25, 14, 5).getTime();
  const [a] = agentsList([{ ...live, status: "parked", parkedUntil: until, resetsAt: until }], [], new Set());
  assert.equal(a.parkedUntil, until);
  assert.equal(a.state?.identifier, "running", "parked is living");
  assert.equal(waitingUntilText(until, t), "waiting until 14:05");
  assert.equal(agentsList([{ ...live, parkedUntil: until }], [], new Set())[0].parkedUntil, undefined, "without \"parked\" no waiting");
});

// The button "To background" stands only on a foreground agent; the mark comes from the server's row (runs/agents.js
// rows, only on foreground agents) and from nowhere else. Counter-test: the takeover in `agentsList` removed turns
// it red.
test("foreground: the mark of the server row arrives, a background agent and a finished one carry none", () => {
  const list = agentsList(
    [{ agentId: "a-front", toolUseId: "t-front", description: "Front", foreground: true }, { agentId: "a-rear", toolUseId: "t-rear", description: "Rear" }],
    [{ id: "t-finished", name: "mcp__cbase__cbase_agent", input: { description: "Done" }, result: JSON.stringify({ status: "completed", agentId: "a-finished", report: "ok" }), done: true }],
  );
  const after = Object.fromEntries(list.map((a) => [a.agentId, a.foreground]));
  assert.deepEqual(after, { "a-front": true, "a-rear": undefined, "a-finished": undefined });
});

// ── Monitors over the turn ────────────────────────────────────────────────────────────────────
// In a chat nothing stood any more under Background Tasks after the turn, although the agent had promised a monitor.
// A monitor belongs to the chat since: every outcome of the turn leaves it standing, only a `background` without it
// takes it away, and a reload (connected) brings it back. Counter-test (shown red, reverted): in `backgroundAfter` on
// `run_done` again `{ ...BACKGROUND_EMPTY, agents: s.agents }` turns "survives every outcome" red; on `run_aborted`
// again `BACKGROUND_EMPTY` likewise.
test("monitor state: survives every outcome of the turn, goes only with its background, comes back with connected", () => {
  const mon = { taskId: "monitor_1", description: "Suite", report: "end", startedAt: 5, logPath: "monitors/monitor_1.log" };
  for (const end of ["run_done", "run_aborted", "run_error"]) {
    const s = run(harness("run_started"), harness("background", { monitors: [mon] }), harness(end), harness("run_started"));
    assert.deepEqual(s.monitors.map((m) => m.taskId), ["monitor_1"], `the monitor survives ${end} and the next run_started`);
    assert.equal(s.monitors[0].logPath, "monitors/monitor_1.log", "the fields of the card come along");
  }
  const way = run(harness("background", { monitors: [mon] }), harness("run_done"), harness("background", { monitors: [] }));
  assert.deepEqual(way.monitors, [], "the server reports the end with a background without it");
  const fresh = run(harness("connected", { running: false, waiting: false, monitors: [mon] }));
  assert.deepEqual(fresh.monitors.map((m) => m.taskId), ["monitor_1"], "after reloading it stands there again");
});
