// The wait row belongs to its kind — and the workflow verdicts at the limit.
//
// One wait row per chat, three kinds (`run` > `judge` > `compact`), several writers and several deleters. Without a rule
// who owns the row: a cleanly ending run also deleted a waiting compaction, an abort left the run row standing and
// restarted the stopped job six hours later, a /compact failed at the limit overwrote a parked verdict including its
// re-entry, skipping and ending a workflow left its parked verdict lying around, a completion gate at the limit without
// parking died of a SQLite bind error and left the run "running" forever, and cap and review interpretation counted an
// UNREAD answer as "stop" or "findings". Every test here enters exactly the path where the finding arose, over the real
// HTTP routes, with a fake CLI that fails at the limit where the test demands it.
//
// Pattern as auto-continue.test.js (limit through the fake CLI: exit 1 with the wording of the real CLI) and
// workflow-engine-e2e.test.js (verdicts recognized by prompt text). The limit deadlines come from the environment
// (`./check` sets them); without them every case would wait 45 s of wall clock.
//
// Three tests here fail by design against the old state, each showing a finding at the waker (`fireAutoContinueInner`,
// today runs/auto-continue.js):
//   - "compaction due while a turn runs" — the waker discarded a compact (and likewise a judge) row as soon as the chat
//     ran; now the kind counts there too: the row stays and is re-checked after a minute, only a run row is discarded.
//   - "race … the queued run is already done" and "… the waker reports no continuation any more" — after its usage
//     lookup the waker worked with a snapshot of the row; now it re-reads it after the lookup and steps back ("gone")
//     if it is missing or another path rewrote it (updatedAt/createdAt).
//
// Without a clock: no test waits a duration and concludes from it. A turn that must run "long enough" stands at a gate
// (`gatePattern`), the waker's usage lookup at a gate in the keychain command (`securityHold`); "the waker did NOT
// start" is only said once it came back (test seam wakeupCycles), and the test makes the row due itself (dueNow) instead
// of hoping for a reset in seconds.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scheduleAutoContinue, wakeupCycles } from "../electron/server/runs/auto-continue.js";
import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { RIPCORD, RIPCORD_MS } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

process.env.CBASE_LIMIT_GRACE_MS ??= "2000";
process.env.CBASE_LIMIT_MIN_WAIT_MS ??= "2000";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for an event — WITHOUT a deadline (the emergency brake is the suite deadline). Every 30 s a line to stderr, so a
// hang says what it waits for. The end of the work is measured by waitForQuiet (quiet.mjs).
async function waitFor(fn, what = "", every = 40) {
  const begin = Date.now();
  let reported = begin;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - reported >= 30_000) {
      reported = Date.now();
      console.error(`[waiting] for ${Math.round((reported - begin) / 1000)} s: ${what || String(fn).replace(/\s+/g, " ").slice(0, 160)}`);
    }
    await sleep(every);
  }
}

// Minimal SSE reader (as chat-stream-join.test.js): collects events and lets one wait for one. ALWAYS closed in the
// test's finally — server.close() would otherwise wait for the open connection, and the first real failure would become
// an eternal hang.
async function openStream(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  const events = [];
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ }
          }
        }
      }
    } catch { /* the abort on closing is expected */ }
  })();
  return {
    events,
    waitFor: (pred) => waitFor(() => events.find(pred) || null, `event in the stream: ${String(pred)}`),
    async close() { ac.abort(); await pump; },
  };
}

// A fake Claude that THINKS ALONG — the union of the fakes from auto-continue.test.js and workflow-engine-e2e.test.js, with
// knobs that do not exist there individually:
//   `limitRuns`   — this many TURNS fail at the limit (exit 1, wording of the real CLI + reset).
//   `exit2Turns`  — these turn numbers (1-based, across all turns) die with exit 2 WITHOUT limit wording: the real error
//                   that is no limit.
//   `holdMs`      — an answering turn takes this long (the short default; whoever wants to measure or abort a turn
//                   MID-run takes the gate).
//   `gatePattern` — an answering turn whose prompt matches the pattern answers only once the gate file (`gateFile`, set by
//                   withServer, opened with `openTheGate()`) exists — a gate instead of a duration that becomes too short
//                   under load.
//   `judgeLimit` + `judgePattern` — this many verdicts whose prompt matches the pattern fail at the limit. The pattern is
//                   ONE per test (completion gate, interpretation), otherwise it would hit the switch before and the
//                   test would check the wrong verdict place.
//   `compactLimit` / `goalLimit` as in auto-continue.test.js; `gate: "never"` as in the e2e.
// Everything lands in one log file: TURN lines with the prompt, ONESHOT lines with the question.
const fakeClaude = ({ stateFile, promptLog, gateFile, gatePattern = "", resetInSeconds = 2, limitRuns = 1, exit2Turns = [], holdMs = 30, compactLimit = 0, goalLimit = 0, judgeLimit = 0, judgePattern = "work step is DONE", gate = "second" }) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const log = (s) => { try { fs.appendFileSync(${JSON.stringify(promptLog)}, s.replace(/\\s+/g, " ").slice(0, 600) + "\\n"); } catch {} };
const counter = (file) => { let n = 0; try { n = Number(fs.readFileSync(file, "utf8")) || 0; } catch {} return n; };
const set = (file, n) => { try { fs.writeFileSync(file, String(n)); } catch {} };
const hint = " · resets at " + new Date(Date.now() + ${resetInSeconds} * 1000).toISOString();
const limitTod = () => { process.stderr.write("Claude usage limit reached" + hint + "\\n"); process.exit(1); };
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {                 // Oneshot: title, verdicts, compact, goal gate
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    log("ONESHOT " + stdin.slice(0, 500));
    let result = "Title";
    if (/compacting the chat history/i.test(stdin)) {                  // the compact prompt
      const n = counter(${JSON.stringify(`${stateFile}.compact`)});
      if (n < ${compactLimit}) { set(${JSON.stringify(`${stateFile}.compact`)}, n + 1); limitTod(); }
      result = "SUMMARY: state of the history";
    } else if (/overarching target/i.test(stdin)) {     // the goal judge
      const n = counter(${JSON.stringify(`${stateFile}.goal`)});
      if (n < ${goalLimit}) { set(${JSON.stringify(`${stateFile}.goal`)}, n + 1); limitTod(); }
      result = '{"achieved": true, "note": "Goal reached"}';
    } else {
      if (${judgeLimit} > 0 && new RegExp(${JSON.stringify(judgePattern)}).test(stdin)) {
        const n = counter(${JSON.stringify(`${stateFile}.judge`)});
        if (n < ${judgeLimit}) { set(${JSON.stringify(`${stateFile}.judge`)}, n + 1); limitTod(); }
      }
      if (/work step is DONE/.test(stdin)) {
        // Only the gate prompt contains "work step is DONE"; its own line is already in the log.
        let prior = 0;
        try { prior = (fs.readFileSync(${JSON.stringify(promptLog)}, "utf8").match(/work step is DONE/g) || []).length; } catch {}
        const rework = ${JSON.stringify(gate === "never")} || prior <= 1;
        result = rework ? '{"done": false, "note": "the report is missing"}' : '{"done": true, "note": ""}';
      } else if (/You interpret ONE answer/.test(stdin)) {
        // Interpretation of a cap or review answer — marker instead of a word heuristic.
        result = /"approval"/.test(stdin)
          ? (/FREE-PLEASE/.test(stdin) ? '{"approval": true, "note": "Marker FREE"}' : '{"approval": false, "note": "Marker FINDING"}')
          : (/MORE-PLEASE/.test(stdin) ? '{"continue": true, "rounds": 1, "note": "Marker MORE"}' : '{"continue": false, "rounds": 0, "note": "Marker STOP"}');
      } else if (/list|JSON array/i.test(stdin)) result = '["Alpha", "Beta", "Gamma"]';
      else if (/condition/i.test(stdin)) result = /YES-PLEASE/.test(stdin) ? '{"yes": true, "note": "Marker YES"}' : '{"yes": false, "note": "Marker NO"}';
    }
    process.stdout.write(JSON.stringify({ result }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {                                                 // Turn (stream-json)
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    let msg; try { msg = JSON.parse(l); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    log("TURN " + text);
    const turn = counter(${JSON.stringify(`${stateFile}.turns`)}) + 1;
    set(${JSON.stringify(`${stateFile}.turns`)}, turn);
    const runs = counter(${JSON.stringify(stateFile)});
    if (runs < ${limitRuns}) {
      set(${JSON.stringify(stateFile)}, runs + 1);
      process.stderr.write("Claude usage limit reached" + hint + "\\n");
      setTimeout(() => process.exit(1), 30);
      return;
    }
    if (${JSON.stringify(exit2Turns)}.includes(turn)) {
      // A REAL error, no limit: none of the wordings limits.js knows.
      process.stderr.write("Model unreachable\\n");
      setTimeout(() => process.exit(2), 30);
      return;
    }
    const out = "ERLEDIGT: " + text.replace(/\\s+/g, " ").slice(0, 120);
    const respond = () => setTimeout(() => {
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "waitRow" });
    }, ${holdMs});
    if (${JSON.stringify(gatePattern)} && new RegExp(${JSON.stringify(gatePattern)}).test(text)) {
      const gate = setInterval(() => { if (fs.existsSync(${JSON.stringify(gateFile)})) { clearInterval(gate); respond(); } }, 20);
    } else respond();
  });
}
`;

// Keep the Anthropic usage endpoint out of the test (empty HOME, a `security` that finds nothing, no OAuth token): the
// server falls back to the reset hint in the message.
// `securityHold`: the THIRD call of the keychain command — the waker's, see inWakeupWindow — stands at a gate file until
// the test calls `securityGateOpen()`; so the waker's usage lookup is stuck as long as the test needs (race tests below),
// instead of two seconds that may be over under load before the test intervenes. `trap '' TERM`: the server calls
// `security` with a five-second deadline (execFile timeout) — that must not break the gate; the loop ends at the latest
// at the ripcord. Effective on macOS only: keychainCredential runs only under darwin.
function isolateCredentials(root, { securityHold = false } = {}) {
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  const security = path.join(binDir, "security");
  // Every call leaves a line: so the race test knows the waker is stuck IN the usage lookup — a time derived from dueAt
  // alone does not hit the window (the timer fires one second after scheduling at the earliest, and scheduling happens
  // only AFTER parking's own usage lookup).
  const calls = path.join(root, "security-calls.log");
  const securityGate = path.join(root, "security-gate");
  const hold = securityHold
    ? `if [ "$(wc -l < ${JSON.stringify(calls)} | tr -d ' ')" = 3 ]; then\n  trap '' TERM\n  n=0\n  while [ ! -f ${JSON.stringify(securityGate)} ] && [ $n -lt ${RIPCORD_MS / 50} ]; do sleep 0.05; n=$((n+1)); done\nfi\n`
    : "";
  fs.writeFileSync(security, `#!/bin/sh\necho x >> ${JSON.stringify(calls)}\n${hold}exit 1\n`);
  fs.chmodSync(security, 0o755);
  // `npx` as a no-op: at start the server loads the Playwright MCP into the npx cache — into the redirected HOME, with
  // node-gyp and Python, ten seconds and longer. Cleanup then ran into ENOTEMPTY and waited 20 retries (about 31 s per
  // test). No test here needs the browser.
  const npx = path.join(binDir, "npx");
  fs.writeFileSync(npx, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(npx, 0o755);
  process.env.NPX_BIN = npx;
  // Likewise the embedding model: without this marker the server loads ~130 MB into the test's HOME.
  process.env.CBASE_EMBED_OFFLINE = "1";
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    securityCalls: () => { try { return fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } },
    securityGateOpen: () => fs.writeFileSync(securityGate, ""),
  };
}

// RECORD the server's console (passed through, not swallowed): the server runs in the same process, its stderr is our
// console.error. A SQLite bind error at the completion gate stood exactly there — and nowhere else.
function consoleTranscribe() {
  const rows = { error: [], log: [] };
  const orig = { error: console.error, log: console.log };
  console.error = (...a) => { rows.error.push(a.map(String).join(" ")); orig.error(...a); };
  console.log = (...a) => { rows.log.push(a.map(String).join(" ")); orig.log(...a); };
  return { rows, restore() { console.error = orig.error; console.log = orig.log; } };
}

const ENV_KEYS = ["CLAUDE_BIN", "NPX_BIN", "CBASE_EMBED_OFFLINE", "CBASE_TRIGGER_POLL", "CBASE_DEPOSIT_TICK_MS", "CBASE_SCHEDULE_TICK_MS", "CBASE_RESTART_GRACE_MS", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN"];

async function withServer(fn, { claude = {}, securityHold = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wait-row-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const consoleLog = consoleTranscribe();
  const gateFile = path.join(root, "turn-gate");
  const openTheGate = () => fs.writeFileSync(gateFile, "");
  let gates = () => {};
  let server, base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";   // the deposit must not interfere here
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000"; // schedules run here only "by hand"
    // No test here restarts: the post-start (resumeInterruptedWork, queue) stays off, instead of falling into a test 2.5 s
    // after the start or making cleanup wait for it.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3600_000);
    const { securityCalls, securityGateOpen } = isolateCredentials(root, { securityHold });
    gates = () => { try { openTheGate(); securityGateOpen(); } catch { /* root already gone */ } };
    const stateFile = path.join(root, "runs.txt");
    const promptLog = path.join(root, "prompts.txt");
    fs.writeFileSync(promptLog, "");
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude({ stateFile, promptLog, gateFile, ...claude }));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Wait row", path: wsPath }) });
    await fn({
      base, ws, root, server, stateFile, securityCalls, securityGateOpen, openTheGate,
      console: consoleLog.rows,
      prompts: () => fs.readFileSync(promptLog, "utf8").split("\n").filter(Boolean),
      turns: () => fs.readFileSync(promptLog, "utf8").split("\n").filter((l) => l.startsWith("TURN")),
    });
    finished = true;
  } finally {
    consoleLog.restore();
    // Every gate open: a held turn or waker must not hold up cleanup.
    gates();
    // Wait for quiet only if the body passed (as in agent-harness.mjs) — after a failure a hanging run would otherwise have
    // no deadline, and the error above would never arrive.
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A failure during cleanup says something about the cleanup, not about the product.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

async function newChat(base, ws, title = "Wait-row chat") {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}
const send = (base, id, text) => json(`${base}/api/chats/${id}/message`, { method: "POST", body: JSON.stringify({ text }) });
const waitState = (base, id) => json(`${base}/api/chats/${id}/auto-continue`);
const waitRow = (base, id) => waitFor(async () => (await waitState(base, id)).wait || null, `wait row of ${id}`);
// Make the row due NOW — instead of hoping for a reset in a few seconds that falls under load into a check that does not
// expect it yet. The same way as an expired reset: dueAt passes, the waker (timer, 1 s at the earliest) or the sweeper
// fires fireAutoContinue. Reason, kind, counter stay.
function dueNow(chatId) {
  const now = Date.now();
  store.reschedulePendingResume(chatId, { dueAt: now, now });
  scheduleAutoContinue(store.getPendingResume(chatId), { now });
}
const log = (base, id) => json(`${base}/api/chats/${id}/log`);
const limitRows = async (base, id) => (await log(base, id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
const hasFinished = async (base, id, pattern = /ERLEDIGT/) => (await log(base, id)).some((e) => e.role === "assistant" && pattern.test(e.text));
const compactMarkers = async (base, id) =>
  (await log(base, id)).filter((e) => e.role === "meta" && (() => { try { return JSON.parse(e.text).compacted; } catch { return false; } })());
const autoContinue = (base, on) => json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const abort = (base, id) => json(`${base}/api/chats/${id}/auto-continue`, { method: "DELETE" });
const now = (base, id, body) => json(`${base}/api/chats/${id}/auto-continue/now`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

// `run: { doneAll: false }`: "check all work steps" is on by default. The gate cases set the gate at the node
// (`doneCheck: true` => `doneMode: "on"`) — exactly ONE.
async function makeFlow(base, ws, name, graph, extra = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ graph, ...extra, run: { doneAll: false, ...(extra.run || {}) } }) });
}
const start = (base, chatId, workflowId, input = "") =>
  json(`${base}/api/chats/${chatId}/workflow`, { method: "POST", body: JSON.stringify({ workflowId, input }) });
const runOf = (base, runId) => json(`${base}/api/workflow-runs/${runId}`);
const untilStatus = (base, runId, ...want) =>
  waitFor(async () => { const d = await runOf(base, runId); return want.includes(d.run.status) ? d : null; }, `run ${runId}: ${want.join("/")}`);

// A step with a completion gate, a second behind it — the gate's verdict is the verdict place.
const gateFlow = () => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
    { id: "n2", type: "instruction", title: "Afterwards", text: "AFTER THE WORK", x: 440, y: 0 },
    { id: "e0", type: "end", title: "End", x: 660, y: 0 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
});
// Loop with cap 1: instruction -> condition (marker NO) -> back; after one round the cap asks (workflow-loop-cap.test.js).
const cycleFlow = () => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "Round", text: "WORK", maxVisits: 1, x: 200, y: 0 },
    { id: "c1", type: "condition", title: "Done?", text: "Is everything done? (NO-PLEASE)", x: 420, y: 0 },
    { id: "e1", type: "end", title: "End", x: 640, y: -80 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "e1", branch: "true" }, { from: "c1", to: "n1", branch: "false" }],
});
// Review loop: approval continues, findings go into the fix (workflow-review-e2e.test.js).
const reviewFlow = () => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "r1", type: "review", title: "Request review", text: "Test the checkout.", x: 200, y: 0 },
    { id: "further", type: "instruction", title: "Phase 5", text: "PHASE FIVE: commit", x: 420, y: -60 },
    { id: "fix", type: "instruction", title: "Fix findings", text: "FIX: {{answer}}", x: 420, y: 90 },
    { id: "e1", type: "end", title: "End", x: 640, y: -60 },
  ],
  edges: [
    { from: "s0", to: "r1" },
    { from: "r1", to: "further", branch: "ok" },
    { from: "r1", to: "fix", branch: "issues" },
    { from: "fix", to: "r1" },
    { from: "further", to: "e1" },
  ],
});

// ── 1. compact survives a run ────────────────────────────────────────────────────────────
// A compaction parked at the limit waits for the reset, not for the next turn. Without the rule every cleanly ending run
// deleted the row regardless of its kind — the promise "will be caught up automatically at HH:MM" was broken without
// saying so. Counter-test against the old state: `wait` was null after the turn, and the compaction marker never came.
// The reset lies an hour ahead: before dueNow the row cannot become due, even if the turn next to it takes long under load.
test("compaction at the limit survives a turn running in between and is caught up at dueAt", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First message for the history");
    await waitFor(() => hasFinished(base, chat.id), "first answer");
    await waitForQuiet(base);

    const out = await json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
    assert.equal(out.limited, true, "the compaction must come back as a wait state at the limit");
    const parked = await waitRow(base, chat.id);
    assert.equal(parked.kind, "compact");

    // An ordinary turn runs through next to it — a compact row parks no chat.
    const response = await send(base, chat.id, "Second message, quite normal");
    assert.equal(response.queued, false, "a compact row must not lock the chat like a run row");
    await waitFor(() => hasFinished(base, chat.id, /Second message/), "second answer");
    await waitForQuiet(base);
    assert.equal(turns().length, 2);

    // THE CORE: the row STILL stands — unchanged, with the same timestamp.
    const afterwards = (await waitState(base, chat.id)).wait;
    assert.ok(afterwards, "the turn deleted the waiting compaction");
    assert.equal(afterwards.kind, "compact");
    assert.equal(afterwards.updatedAt, parked.updatedAt, "the row was rewritten — it belongs to the compaction");
    assert.equal((await compactMarkers(base, chat.id)).length, 0, "must not have compacted before dueAt");

    // And at dueAt it is caught up.
    dueNow(chat.id);
    await waitFor(async () => (await compactMarkers(base, chat.id)).length ? true : null, "compaction marker", 250);
    assert.match((await json(`${base}/api/chats/${chat.id}`)).contextSummary || "", /SUMMARY/);
    await waitFor(async () => ((await waitState(base, chat.id)).wait ? null : true), "row gone after the compaction");
  }, { claude: { limitRuns: 0, compactLimit: 1, resetInSeconds: 3600 } });
});

// The same promise from the third side: the row becomes DUE while a turn runs. The waker must not discard the compaction
// then — it waits for the chat, not for this turn (the ownership rule holds for every deleter, not only the three in doRun).
test("compaction due while a turn runs: the row stays and is caught up afterwards", async () => {
  await withServer(async ({ base, ws, turns, openTheGate }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First message for the history");
    await waitFor(() => hasFinished(base, chat.id), "first answer");
    await waitForQuiet(base);
    const out = await json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
    assert.equal(out.limited, true);
    const parked = await waitRow(base, chat.id);
    assert.equal(parked.kind, "compact");

    // The turn stands at the gate; the row becomes due IN THE MIDDLE of it, and the waker comes back while it runs (counted,
    // not assumed).
    await send(base, chat.id, "Long turn");
    await waitFor(() => (turns().some((l) => /Long turn/.test(l)) ? true : null), "the long turn runs");
    const wakeup = wakeupCycles(chat.id);
    dueNow(chat.id);
    await waitFor(() => wakeupCycles(chat.id) > wakeup, "waker fires in the middle of the turn");
    assert.equal(await hasFinished(base, chat.id, /Long turn/), false, "precondition: the turn was running when the waker came");

    // The row must still be there — in the store, not only in the view.
    const row = store.getPendingResume(chat.id);
    assert.ok(row && row.kind === "compact", `the waker discarded the waiting compaction during the turn: ${JSON.stringify(row)}`);
    assert.equal((await compactMarkers(base, chat.id)).length, 0, "compacted next to the running turn");
    // And after the turn the compaction comes (the waker re-armed itself).
    openTheGate();
    await waitFor(() => hasFinished(base, chat.id, /Long turn/), "answer of the long turn");
    await waitFor(async () => (await compactMarkers(base, chat.id)).length ? true : null, "compaction marker", 250);
  }, { claude: { limitRuns: 0, compactLimit: 1, resetInSeconds: 3600, gatePattern: "Long turn" } });
});

// ── 2. judge > compact ───────────────────────────────────────────────────────────────────
// A parked verdict carries the re-entry of a procedure (here: the goal gate). A /compact failing at the limit afterwards
// must not displace it — setPendingResume (ON CONFLICT) used to overwrite kind AND payload, and the re-entry was gone.
test("judge > compact: a parked verdict stays, a /compact failing at the limit afterwards does not wait", async () => {
  await withServer(async ({ base, ws, console }) => {
    const chat = await newChat(base, ws);
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Finish the job" }) });
    await send(base, chat.id, "First message");
    const verdict = await waitRow(base, chat.id);
    assert.equal(verdict.kind, "judge", "precondition: the goal gate is parked");
    await waitForQuiet(base);

    // /compact runs into the same limit. It must NOT park — the row belongs to the verdict. The caller gets the failure
    // reported honestly (500 with the wording), instead of a promise that cost the verdict.
    const error = await json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" }).then((b) => ({ body: b }), (e) => e);
    assert.equal(error.status, 500, `expected: failure without wait state, was ${JSON.stringify(error.body)}`);
    assert.match(error.body?.error || "", /usage limit/i, "the reason of the failure belongs in the answer");
    await waitForQuiet(base);
    const still = (await waitState(base, chat.id)).wait;
    assert.equal(still.kind, "judge", "the compaction displaced the parked verdict");
    assert.equal(still.updatedAt, verdict.updatedAt, "the verdict row was touched");
    assert.ok(console.log.some((l) => l.includes(chat.id) && /compact does not wait/.test(l) && /has priority/.test(l)),
      `the log line "has priority" is missing: ${JSON.stringify(console.log.filter((l) => l.includes("[limit]")))}`);
    // The history has no wait row for the compaction (only the verdict's).
    const waits = (await limitRows(base, chat.id)).filter((z) => z.kind === "wait");
    assert.deepEqual(waits.map((z) => z.waitFor), ["judge"], `wait rows in the history: ${JSON.stringify(waits)}`);
    await abort(base, chat.id);
  }, { claude: { limitRuns: 0, goalLimit: 1, compactLimit: 1, resetInSeconds: 600 } });
});

// ── 2b. An outdated verdict is dropped ───────────────────────────────────────────────────
// The judge row waits for the CHAT — which keeps running meanwhile. The parked goal verdict carried only the texts of
// back then: after the reset it ruled on the FIRST answer while the third long stood, and wrote "goal reached" under a
// conversation that was elsewhere. Now the row carries the state at parking (`lastId`; a workflow verdict the run with
// cursor), and the re-entry checks it: if the chat has moved on since, the verdict is dropped with a line in the history —
// the goal gate of the NEW turn has ruled anyway.
test("outdated goal verdict: a parked goal verdict that a later turn overtook is dropped on waking — no verdict on an old answer", async () => {
  await withServer(async ({ base, ws, prompts }) => {
    const chat = await newChat(base, ws);
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Finish the job" }) });
    await send(base, chat.id, "First message");
    const verdict = await waitRow(base, chat.id);
    assert.equal(verdict.kind, "judge", "precondition: the goal gate is parked");
    await waitForQuiet(base);
    const targetVerdicts = () => prompts().filter((l) => l.startsWith("ONESHOT") && /overarching target/i.test(l)).length;
    assert.equal(targetVerdicts(), 1);

    // The chat keeps running (a judge row does not lock it) — its own goal gate rules on the NEW answer (the limit is
    // used up, the fake answers).
    const response = await send(base, chat.id, "Second message");
    assert.equal(response.queued, false);
    await waitFor(() => hasFinished(base, chat.id, /Second message/), "second answer");
    await waitForQuiet(base);
    await waitFor(() => (targetVerdicts() === 2 ? true : null), "second goal verdict");
    const still = (await waitState(base, chat.id)).wait;
    assert.ok(still && still.kind === "judge", "precondition: the old row still stands (it belongs to the chat, not the turn)");

    // Waking: the verdict of back then is outdated — it is dropped instead of ruling on the first answer.
    const r = await now(base, chat.id);
    assert.equal(r.ok, false, JSON.stringify(r));
    // Quiet: a verdict that waking would still have started counts as open work — afterwards it has run.
    await waitForQuiet(base);
    assert.equal((await waitState(base, chat.id)).wait, null, "the outdated row stayed");
    const rows = await limitRows(base, chat.id);
    const dropped = rows.find((z) => z.kind === "cancel" && /überholt|outdated/.test(z.text));
    assert.ok(dropped, `no row for the drop: ${JSON.stringify(rows.map((z) => [z.kind, z.text]))}`);
    assert.equal(targetVerdicts(), 2, "the outdated verdict ran anyway — on an answer that is no longer the last");
  }, { claude: { limitRuns: 0, goalLimit: 1, resetInSeconds: 600 } });
});

// The same for a WORKFLOW verdict: the row of a gate verdict carries the run at parking (`run`: id, status, step, cursor,
// generation), and the re-entry — the switch `judge` in workflows/gates.js — checks it with runStillOur. If a later user
// turn advances the cursor (its gate rules "done", the run stands at the next node), the old verdict is dropped with the
// history line "outdated" — and no third gate verdict runs. Without the runStillOur line it would be dropped too (the
// status no longer matches), but SILENTLY: no line in the history, and the user would see a wait row vanish without
// learning why.
test("outdated gate verdict: a parked GATE verdict that a later user turn overtook is dropped on waking with the line \"outdated\" — no third verdict", async () => {
  await withServer(async ({ base, ws, prompts }) => {
    // Behind the gate a question node: the run HOLDS there (waiting) instead of ending — an end would clear the judge row
    // itself (finishWorkflow), and the re-entry would never come up.
    const flow = await makeFlow(base, ws, "Gate-outdated", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
        { id: "a1", type: "ask", title: "Question", text: "How should it continue?", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "a1" }, { from: "a1", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Gate-outdated chat");
    const r = await start(base, chat.id, flow.id, "go");
    const verdict = await waitRow(base, chat.id);
    assert.equal(verdict.kind, "judge", "precondition: the gate verdict is parked");
    assert.equal(verdict.workflow, true);
    await waitForQuiet(base);
    const gateVerdicts = () => prompts().filter((l) => l.startsWith("ONESHOT") && /work step is DONE/.test(l)).length;
    assert.equal(gateVerdicts(), 1);
    const prior = await runOf(base, r.run.id);
    assert.equal(prior.run.status, "running");

    // The chat keeps running (a judge row does not lock it): the user turn ends with code 0, the workflow runs => hook
    // afterRun/workflow-gate => the gate rules on the NEW output (the limit is used up, the fake says "done") => the run
    // advances to the question and holds.
    const response = await send(base, chat.id, "Second message");
    assert.equal(response.queued, false);
    await waitFor(() => hasFinished(base, chat.id, /Second message/), "second answer");
    const waiting = await untilStatus(base, r.run.id, "waiting", "failed", "done");
    assert.equal(waiting.run.status, "waiting", `the run should stand at the question, was ${waiting.run.status}: ${waiting.run.note}`);
    assert.equal(waiting.run.nodeId, "a1");
    assert.equal(gateVerdicts(), 2);
    const still = (await waitState(base, chat.id)).wait;
    assert.ok(still && still.kind === "judge", "precondition: the old judge row still stands (it belongs to the chat, not the turn)");

    // Waking: the verdict of back then belongs to a run state that no longer exists — it is dropped with the line
    // "outdated" instead of ruling on the old output.
    const w = await now(base, chat.id);
    assert.equal(w.ok, false, JSON.stringify(w));
    // Quiet: a third gate verdict that waking would still have started has run afterwards.
    await waitForQuiet(base);
    assert.equal((await waitState(base, chat.id)).wait, null, "the outdated row stayed");
    const rows = await limitRows(base, chat.id);
    const dropped = rows.find((z) => z.kind === "cancel" && /überholt|outdated/.test(z.text));
    assert.ok(dropped, `no row for the drop (counter-test: runStillOur struck): ${JSON.stringify(rows.map((z) => [z.kind, z.text]))}`);
    assert.equal(gateVerdicts(), 2, "the outdated verdict ran anyway — a third gate verdict on an old output");
    const afterwards = await runOf(base, r.run.id);
    assert.equal(afterwards.run.status, "waiting", "waking touched the waiting run");
    assert.equal(afterwards.run.nodeId, "a1");
    // Leave it cleaned up.
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    await untilStatus(base, r.run.id, "cancelled", "failed", "done");
  }, { claude: { limitRuns: 0, judgeLimit: 1, judgePattern: "work step is DONE", resetInSeconds: 600 } });
});

// ── 3. Abort clears the run row ──────────────────────────────────────────────────────────
// fireAutoContinueInner pushes the row back six hours when the continuation starts and relies on doRun. The `aborted`
// branch was the only one that did not clean up: six hours after the stop the stopped job ran again by itself.
test("abort of the continuation clears the run row — no restart after six hours", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    const wait = await waitRow(base, chat.id);
    assert.equal(wait.kind, "run");

    // Continuation by hand (moving dueAt forward would be the same via the waker; the button is the shorter way to the same
    // starting point). The turn stands at the gate until it is stopped — it is never opened.
    const r = await now(base, chat.id);
    assert.equal(r.ok, true);
    await waitFor(() => (turns().length >= 2 ? true : null), "the continuation runs");
    assert.ok(store.getPendingResume(chat.id), "precondition: during the run the row stands (attempt counter)");
    const stop = await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
    assert.equal(stop.ok, true);
    await waitForQuiet(base);

    // No row any more — in the view AND in the store (the store is the waker of the next 6 h).
    assert.equal((await waitState(base, chat.id)).wait, null, "after the abort nothing waits any more");
    assert.equal(store.getPendingResume(chat.id), null, "the run row still stands — the job would run again after 6 h");
    assert.equal((await json(`${base}/api/auto-continue`)).waiting.length, 0);
    assert.ok((await log(base, chat.id)).some((e) => e.role === "meta" && JSON.parse(e.text).aborted), "the abort is not in the history");
    assert.equal(turns().length, 2, "a turn still started after the abort");
  }, { claude: { limitRuns: 1, resetInSeconds: 3600, gatePattern: "Please do something" } });
});

// ── 4. The error branch emits null ───────────────────────────────────────────────────────
// A real error (exit ≠ 0, no limit) after the continuation clears the row — and must TELL the clients. Without
// `limit_wait: null` an open chat kept the strip that no longer existed server-side; its button ran into a 404.
test("error branch: exit 2 without a limit clears the row AND sends limit_wait null", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    await waitRow(base, chat.id);
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      await stream.waitFor((e) => e.subtype === "connected");
      await now(base, chat.id);
      await stream.waitFor((e) => e.subtype === "run_started");
      const error = await stream.waitFor((e) => e.subtype === "run_error");
      assert.equal(error.code, 2);
      assert.doesNotMatch(error.stderr || "", /usage limit/i, "precondition: NO limit error");
      // After run_started and BEFORE/AT run_error: the row goes to the clients as `null`.
      const iStart = stream.events.findIndex((e) => e.subtype === "run_started");
      const iErr = stream.events.findIndex((e) => e.subtype === "run_error");
      const empty = stream.events.slice(iStart + 1, iErr + 2).filter((e) => e.subtype === "limit_wait");
      assert.ok(empty.some((e) => e.wait === null), `after the error no limit_wait:null came: ${JSON.stringify(stream.events.map((e) => e.subtype))}`);
      await waitForQuiet(base);
      assert.equal((await waitState(base, chat.id)).wait, null);
      assert.equal(store.getPendingResume(chat.id), null);
      // And the error stays an error: no second wait row, no second attempt.
      assert.equal((await limitRows(base, chat.id)).filter((z) => z.kind === "wait").length, 1, "the exit-2 error was parked as a limit");
    } finally {
      await stream.close();
    }
  }, { claude: { limitRuns: 1, resetInSeconds: 3600, exit2Turns: [2] } });
});

// ── 5. View null while running ───────────────────────────────────────────────────────────
// A running chat waits for nothing: the row stays (attempt counter, +6 h), the VIEW is empty — at ONE place
// (autoContinueView), for route, global list and the answer of /now.
test("while the continuation runs the view is null — /now does not answer with the row it just released", async () => {
  await withServer(async ({ base, ws, turns, openTheGate }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    await waitRow(base, chat.id);

    const r = await now(base, chat.id);
    assert.equal(r.ok, true);
    assert.equal(r.wait, null, "the route answered with the row it had just released");
    await waitFor(() => (turns().length >= 2 ? true : null), "the continuation runs");
    assert.equal((await waitState(base, chat.id)).wait, null, "during the run the strip counted down six hours");
    assert.equal((await json(`${base}/api/auto-continue`)).waiting.length, 0, "the global list is silent for a running chat too");
    const row = store.getPendingResume(chat.id);
    assert.ok(row && row.attempts === 1 && row.dueAt > Date.now() + 5 * 3600_000, `the row carries the attempt counter meanwhile: ${JSON.stringify(row)}`);
    const again = await now(base, chat.id).then(() => null, (e) => e);
    assert.equal(again?.status, 409, "a second click during the run must be rejected");

    // Up to here the turn stood at the gate — every check above lay safely in the MIDDLE of the run.
    openTheGate();
    await waitFor(() => hasFinished(base, chat.id), "answer of the continuation");
    await waitForQuiet(base);
    assert.equal((await waitState(base, chat.id)).wait, null);
    assert.equal(store.getPendingResume(chat.id), null, "after the clean end the row is cleared");
  }, { claude: { limitRuns: 1, resetInSeconds: 3600, gatePattern: "Please do something" } });
});

// ── 6. Race: after its usage lookup the waker works with a snapshot ───────────────────────
// Between the first `running` test and the start lies a network call (usage endpoint, with keychain and token refresh
// hundreds of milliseconds to seconds). What happens to the row in this window the waker must not pass over afterwards.
// The window arises here through the keychain command (only macOS reads it) — skipped elsewhere instead of reporting a
// green result without meaning.
//
// Hitting the window: parking itself calls `security` twice (calls 1 and 2); the third call is the waker — and it stands
// at the gate (`securityHold`) until the test calls `securityGateOpen()`: so long the waker is stuck in the lookup,
// without a `running` test lying in between anywhere. A time derived from dueAt alone would not hit the window: the timer
// fires one second after scheduling at the earliest. Whether the waker really CAME BACK afterwards (and was not merely not
// due yet) is counted by wakeupCycles — only then does "no second start" say something.
const inWakeupWindow = (securityCalls) =>
  waitFor(() => (securityCalls() >= 3 ? true : null), "the waker is stuck in the usage lookup", 25);

// (a) The run that discarding starts from the queue is STILL RUNNING when the waker comes back from its lookup: the second
// `running` check catches it.
test("race: the row falls during the usage lookup, the queued run is still running — the waker starts no second one", async (t) => {
  if (process.platform !== "darwin") { t.skip("the window arises through `security` (macOS only)"); return; }
  await withServer(async ({ base, ws, turns, securityCalls, securityGateOpen, openTheGate }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First attempt");
    await waitRow(base, chat.id);
    assert.equal(securityCalls(), 2, "precondition: parking asked the keychain twice");
    const message = await send(base, chat.id, "Differently");
    assert.equal(message.parked, true, "precondition: the second message waits behind the row");

    await inWakeupWindow(securityCalls);
    const wakeup = wakeupCycles(chat.id);
    const del = await abort(base, chat.id);
    assert.equal(del.ok, true, "precondition: the row still stood when aborted");
    // The queued turn runs — and stands at the gate until the waker is back from its lookup.
    await waitFor(() => (turns().length >= 2 ? true : null), "the queued turn runs");
    securityGateOpen();
    await waitFor(() => wakeupCycles(chat.id) > wakeup, "the waker comes back from the lookup");
    openTheGate();
    await waitFor(() => hasFinished(base, chat.id, /Differently/), "answer of the queued turn");
    await waitForQuiet(base);
    const all = turns();
    assert.deepEqual(all.map((l) => l.slice(5, 20)), ["First attempt", "Differently"], `two runs in the same chat: ${JSON.stringify(all)}`);
    assert.equal(store.getPendingResume(chat.id), null);
  }, { claude: { limitRuns: 1, resetInSeconds: 2, gatePattern: "Differently" }, securityHold: true });
});

// (b) The queued run is already DONE when the waker comes back (a short turn, a long lookup): `running` is empty again — and
// the row the waker works with is a snapshot from BEFORE the lookup. It was discarded; its job must not start any more.
// The check belongs on the ROW, not only on `running`.
test("race: the row falls during the usage lookup, the queued run is already done — the discarded job does NOT start", async (t) => {
  if (process.platform !== "darwin") { t.skip("the window arises through `security` (macOS only)"); return; }
  await withServer(async ({ base, ws, turns, securityCalls, securityGateOpen }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First attempt");
    await waitRow(base, chat.id);
    assert.equal(securityCalls(), 2, "precondition: parking asked the keychain twice");
    const message = await send(base, chat.id, "Differently");
    assert.equal(message.parked, true, "precondition: the second message waits behind the row");

    await inWakeupWindow(securityCalls);
    const wakeup = wakeupCycles(chat.id);
    const del = await abort(base, chat.id);
    assert.equal(del.ok, true, "precondition: the row still stood when aborted");
    await waitFor(() => hasFinished(base, chat.id, /Differently/), "answer of the queued turn");
    // The queued run is completely through (`running` empty) — ONLY THEN the waker comes back from its lookup.
    await waitForQuiet(base);
    securityGateOpen();
    await waitFor(() => wakeupCycles(chat.id) > wakeup, "the waker comes back from the lookup");
    await waitForQuiet(base);   // a false start from the snapshot would have run by now
    const all = turns();
    assert.deepEqual(all.map((l) => l.slice(5, 20)), ["First attempt", "Differently"],
      `the waker started the DISCARDED job with its snapshot of the row: ${JSON.stringify(all)}`);
    assert.equal(store.getPendingResume(chat.id), null);
  }, { claude: { limitRuns: 1, resetInSeconds: 2 }, securityHold: true });
});

// (c) The same situation, the second promise: if the row fell during the lookup, the waker reports NO continuation — neither
// as a history line "reset — the run is continued" nor as a notice "Continuing" (push). Both would announce a run that
// does not exist.
test("race: after the discarded row the waker reports no continuation any more", async (t) => {
  if (process.platform !== "darwin") { t.skip("the window arises through `security` (macOS only)"); return; }
  await withServer(async ({ base, ws, securityCalls, securityGateOpen }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First attempt");
    await waitRow(base, chat.id);
    await inWakeupWindow(securityCalls);
    const wakeup = wakeupCycles(chat.id);
    const del = await abort(base, chat.id);
    assert.equal(del.ok, true, "precondition: the row still stood when aborted");
    securityGateOpen();
    await waitFor(() => wakeupCycles(chat.id) > wakeup, "the waker comes back from the lookup");
    await waitForQuiet(base);
    const kinds = (await limitRows(base, chat.id)).map((z) => z.kind);
    const iCancel = kinds.indexOf("cancel");
    assert.ok(iCancel >= 0, `the discard row is missing: ${JSON.stringify(kinds)}`);
    assert.equal(kinds.slice(iCancel + 1).includes("resume"), false,
      `after the discard the history still says "the run is continued" — for a run that does not exist: ${JSON.stringify(kinds)}`);
    const notifications = ((await json(`${base}/api/services/events`)).events || [])
      .filter((e) => e.kind === "limit" && (e.chatId === chat.id || e.managerChatId === chat.id));
    assert.equal(notifications.some((m) => /Läuft weiter|Continuing/.test(m.title)), false,
      `a notice "Continuing" for a discarded job: ${JSON.stringify(notifications.map((m) => m.title))}`);
  }, { claude: { limitRuns: 1, resetInSeconds: 2 }, securityHold: true });
});

// ── 7. Workflow: completion gate at the limit that cannot be parked ───────────────────────
// Auto-continue OFF, the verdict fails at the limit: parkJudge does not take over. Without the fix the code fell into
// "not done" with `note === undefined`, updateWorkflowRun threw a SQLite bind error ("Provided value cannot be bound to
// SQLite parameter 2"), and the run stayed "running" without driver, wait row and ending — lock included. Now it ends
// honestly. resumeInterruptedWork never runs here (CBASE_RESTART_GRACE_MS, see withServer).
test("completion gate at the limit with auto-continue off => run ends \"failed\" with usage limit, no hang, no SQLite error, no row", async () => {
  await withServer(async ({ base, ws, console }) => {
    await autoContinue(base, false);
    const flow = await makeFlow(base, ws, "Gate-at-limit-without-A", gateFlow());
    const chat = await newChat(base, ws, "Gate-limit chat");
    const r = await start(base, chat.id, flow.id, "go");

    const ended = await untilStatus(base, r.run.id, "failed", "done", "cancelled");
    assert.equal(ended.run.status, "failed", `expected "failed", was ${ended.run.status}: ${ended.run.note}`);
    assert.match(ended.run.note, /Nutzungslimit|Usage limit/, `the note does not name the limit: ${ended.run.note}`);
    const gate = ended.steps.filter((s) => s.kind === "gate").at(-1);
    assert.ok(gate?.detail?.limited === true && gate?.detail?.failed === true, `the gate row carries neither limited nor failed: ${JSON.stringify(gate?.detail)}`);
    assert.equal(ended.steps.filter((s) => s.kind === "end").length, 1, "a run ends EXACTLY ONCE");
    // No wait state, no second entry in the run overview, no lock.
    assert.equal((await waitState(base, chat.id)).wait, null);
    assert.equal(store.getPendingResume(chat.id), null);
    assert.equal((await json(`${base}/api/active-runs`)).items.filter((i) => i.chatId === chat.id).length, 0, "the ended run is still in the overview");
    assert.equal(store.listLocks().filter((l) => l.runId === r.run.id).length, 0, "the ended run's lock still stands");
    // The history says why: the "off" line of the switched-off continuing.
    assert.ok((await limitRows(base, chat.id)).some((z) => z.kind === "off"), "the limit line \"off\" is missing in the history");
    // And the server console is clean — exactly there the bind error stood.
    const sqlite = console.error.filter((l) => /SQLite|cannot be bound|\[workflow\] Gate:/i.test(l));
    assert.deepEqual(sqlite, [], `SQLite error in the server console: ${JSON.stringify(sqlite)}`);
  }, { claude: { limitRuns: 0, judgeLimit: 1, judgePattern: "work step is DONE", resetInSeconds: 600 } });
});

// Counter-case: with auto-continue on the same verdict is parked (judge row with workflow reference), the run stays
// "running", and the run overview shows it ONCE as "limit" — not as "running" and not twice.
test("counter-case: with auto-continue on the gate verdict is parked — one judge row, the run waits visibly", async () => {
  await withServer(async ({ base, ws, console }) => {
    const flow = await makeFlow(base, ws, "Gate-at-limit-with-A", gateFlow());
    const chat = await newChat(base, ws, "Gate-park chat");
    const r = await start(base, chat.id, flow.id, "go");
    const wait = await waitRow(base, chat.id);
    assert.equal(wait.kind, "judge");
    assert.equal(wait.workflow, true, "the row must know the workflow");
    assert.equal((await runOf(base, r.run.id)).run.status, "running");
    const items = (await json(`${base}/api/active-runs`)).items.filter((i) => i.chatId === chat.id);
    assert.equal(items.length, 1, `the chat appears ${items.length} times in the overview`);
    assert.equal(items[0].kind, "workflow");
    assert.equal(items[0].phase, "limit", `phase war ${items[0].phase}`);
    assert.equal(items[0].limit?.kind, "judge");
    assert.equal(items[0].background?.wakeupAt, wait.dueAt);
    assert.deepEqual(console.error.filter((l) => /SQLite|cannot be bound/i.test(l)), []);
    // Leave it cleaned up: cancelling ends the run and takes the row along (see section 9).
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    await untilStatus(base, r.run.id, "cancelled", "failed", "done");
    assert.equal((await waitState(base, chat.id)).wait, null);
  }, { claude: { limitRuns: 0, judgeLimit: 1, judgePattern: "work step is DONE", resetInSeconds: 600 } });
});

// ── 8. Cap and review interpretation at the limit with auto-continue off ──────────────────
// An UNREAD answer is not an unclear answer. It used to count at the cap as "stop" (run "cancelled", reason "could not read
// the answer") and in the review as "findings" (a paid fix round for an approval that perhaps was one). Now the run ends
// honestly with the limit — like switch, list and gate.
test("cap interpretation at the limit with auto-continue off => \"failed\" with usage limit, not \"cancelled — not readable\"", async () => {
  await withServer(async ({ base, ws, turns, console }) => {
    await autoContinue(base, false);
    const flow = await makeFlow(base, ws, "Cap-at-limit", cycleFlow(), { lock: { scope: "off", template: "" } });
    const chat = await newChat(base, ws, "Cap chat");
    const r = await start(base, chat.id, flow.id);
    const held = await waitFor(async () => {
      const d = await json(`${base}/api/chats/${chat.id}/workflow`);
      return d.run?.status === "waiting" && d.run?.pending === "cap" ? d.run : null;
    }, "run waits at the round cap");
    assert.ok(held, "precondition: the run waits at the round cap");
    const rounds = () => turns().filter((l) => /WORK/.test(l)).length;
    assert.equal(rounds(), 1);

    // Unclear (no "continue", no "stop") => the model interprets — and that fails at the limit.
    await send(base, chat.id, "hm, what do you think, you decide");
    const ended = await untilStatus(base, r.run.id, "failed", "cancelled", "done");
    assert.equal(ended.run.status, "failed", `expected "failed", was ${ended.run.status}: ${ended.run.note}`);
    assert.match(ended.run.note, /Nutzungslimit|Usage limit/, `the note does not name the limit: ${ended.run.note}`);
    assert.doesNotMatch(ended.run.note, /nicht deutbar|Could not read/, "the unread answer was booked as \"not readable\"");
    assert.equal(rounds(), 1, "despite the limit another round ran");
    assert.equal((await waitState(base, chat.id)).wait, null);
    assert.ok((await limitRows(base, chat.id)).some((z) => z.kind === "off"));
    assert.deepEqual(console.error.filter((l) => /SQLite|cannot be bound/i.test(l)), []);
  }, { claude: { limitRuns: 0, judgeLimit: 1, judgePattern: "You interpret ONE answer", resetInSeconds: 600 } });
});

test("review interpretation at the limit with auto-continue off => \"failed\" with usage limit — no fix round for an unread answer", async () => {
  await withServer(async ({ base, ws, turns, console }) => {
    await autoContinue(base, false);
    const flow = await makeFlow(base, ws, "Review-at-limit", reviewFlow(), { lock: { scope: "off", template: "" } });
    const chat = await newChat(base, ws, "Review chat");
    const r = await start(base, chat.id, flow.id, "Branch-9");
    const waiting = await untilStatus(base, r.run.id, "waiting", "failed", "done");
    assert.equal(waiting.run.status, "waiting", `the run should wait for the review, was ${waiting.run.status}: ${waiting.run.note}`);
    assert.equal(turns().length, 1, "precondition: exactly one turn (the request)");

    // "whatever" is none of the unambiguous approvals => the model interprets — at the limit.
    await send(base, chat.id, "whatever, you take a look");
    const ended = await untilStatus(base, r.run.id, "failed", "cancelled", "done");
    assert.equal(ended.run.status, "failed", `expected "failed", was ${ended.run.status}: ${ended.run.note}`);
    assert.match(ended.run.note, /Nutzungslimit|Usage limit/, `the note does not name the limit: ${ended.run.note}`);
    assert.equal(ended.steps.some((s) => s.kind === "review" && s.detail?.verdict === "issues"), false, "an unread answer was counted as a finding");
    assert.equal(turns().some((l) => /FIX/.test(l)), false, "a fix round ran that nobody asked for");
    assert.equal(turns().length, 1, "a turn still ran after the limit");
    assert.equal((await waitState(base, chat.id)).wait, null);
    assert.deepEqual(console.error.filter((l) => /SQLite|cannot be bound/i.test(l)), []);
  }, { claude: { limitRuns: 0, judgeLimit: 1, judgePattern: "You interpret ONE answer", resetInSeconds: 600 } });
});

// ── 9. Skipping and ending clear a judge row ──────────────────────────────────────────────
// A parked verdict hangs on a node. If the node drops out (skipped) or the run (ended), the re-entry is moot. Without the
// cleanup the row stayed — after the reset it ruled on the output of a FOREIGN node, and until then the strip showed a
// wait nobody was waiting for any more.
test("skipping the step takes the parked judge row along — the run goes through without a second verdict", async () => {
  await withServer(async ({ base, ws, turns, prompts }) => {
    const flow = await makeFlow(base, ws, "Gate-skip", gateFlow());
    const chat = await newChat(base, ws, "Skip-Chat");
    const r = await start(base, chat.id, flow.id, "go");
    const wait = await waitRow(base, chat.id);
    assert.equal(wait.kind, "judge", "precondition: the gate verdict is parked");
    await waitForQuiet(base);

    const skip = await json(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" });
    assert.equal(skip.ok, true);
    // Immediately after skipping: no row any more — not only when the run is over.
    assert.equal(store.getPendingResume(chat.id), null, "the judge row still stands after skipping");
    assert.equal((await waitState(base, chat.id)).wait, null);

    const done = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    assert.ok(turns().some((l) => /AFTER THE WORK/.test(l)), "the next step did not run");
    assert.equal(turns().filter((l) => /DO THE WORK/.test(l)).length, 1, "the skipped step ran again");
    // Only ONE gate verdict (the one at the limit) — none caught up on a foreign output.
    assert.equal(prompts().filter((l) => l.startsWith("ONESHOT") && /work step is DONE/.test(l)).length, 1, "the parked verdict was caught up despite skipping");
    assert.equal((await json(`${base}/api/auto-continue`)).waiting.length, 0);
  }, { claude: { limitRuns: 0, judgeLimit: 1, judgePattern: "work step is DONE", resetInSeconds: 600 } });
});

test("ending the workflow (cancel) takes the parked judge row along — the reason stays \"cancelled by the user\"", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Gate-end", gateFlow());
    const chat = await newChat(base, ws, "Cancel-Chat");
    const r = await start(base, chat.id, flow.id, "go");
    const wait = await waitRow(base, chat.id);
    assert.equal(wait.kind, "judge");
    await waitForQuiet(base);

    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    const ended = await untilStatus(base, r.run.id, "cancelled", "failed", "done");
    assert.equal(ended.run.status, "cancelled", `expected "cancelled", was ${ended.run.status}: ${ended.run.note}`);
    // finishWorkflow clears the row — and the reason is the user's, not "usage limit" (the cancel ends BEFORE discarding the
    // row; cancelAutoContinue then finds a run that is already over).
    assert.match(ended.run.note, /abgebrochen|Cancelled by the user/i, `wrong reason: ${ended.run.note}`);
    assert.doesNotMatch(ended.run.note, /Nutzungslimit|Usage limit/);
    assert.equal(store.getPendingResume(chat.id), null, "the judge row still stands after ending");
    assert.equal((await waitState(base, chat.id)).wait, null);
    assert.equal(ended.steps.filter((s) => s.kind === "end").length, 1, "a run ends EXACTLY ONCE");
  }, { claude: { limitRuns: 0, judgeLimit: 1, judgePattern: "work step is DONE", resetInSeconds: 600 } });
});

// ── 10. cancel => workflow failed ─────────────────────────────────────────────────────────
// A workflow node turn parks at the time limit (run row with `workflow: true`). If the user discards the row at the strip,
// the run has failed — a "running" workflow without a driver only holds its lock. Without the rule it counted only for
// "gave-up"; the run then stood invisibly at "running" until the next backend start collected it.
test("cancel => workflow failed: DELETE /auto-continue ends the parked workflow and releases the lock", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const flow = await makeFlow(base, ws, "Node-at-limit", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "First", text: "STEP ONE", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Second", text: "STEP TWO", x: 400, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }],
    }); // Lock: default (one run per workflow as long as no project is set)
    const chatA = await newChat(base, ws, "Chat A");
    const rA = await start(base, chatA.id, flow.id);
    const wait = await waitRow(base, chatA.id);
    assert.equal(wait.kind, "run");
    assert.equal(wait.workflow, true, "the row does not know its workflow — cancelAutoContinue reads exactly this marker");
    assert.equal((await runOf(base, rA.run.id)).run.status, "running");
    // The overview shows the parked workflow ONCE, as "limit".
    const items = (await json(`${base}/api/active-runs`)).items.filter((i) => i.chatId === chatA.id);
    assert.equal(items.length, 1, `${items.length} entries for the same chat`);
    assert.equal(items[0].kind, "workflow");
    assert.equal(items[0].phase, "limit");
    assert.equal(items[0].limit?.reason, "reset");
    // The lock holds: a second start of the same workflow is rejected.
    const chatB = await newChat(base, ws, "Chat B");
    const blocked = await start(base, chatB.id, flow.id).then(() => null, (e) => e);
    assert.equal(blocked?.status, 409, "precondition: the parked run's lock holds");

    const del = await abort(base, chatA.id);
    assert.equal(del.ok, true);
    const ended = await untilStatus(base, rA.run.id, "failed", "cancelled", "done");
    assert.equal(ended.run.status, "failed", `the workflow stayed at ${ended.run.status}: ${ended.run.note}`);
    assert.match(ended.run.note, /abgebrochen|cancelled/i, `the note does not name the discard: ${ended.run.note}`);
    assert.equal(store.listLocks().filter((l) => l.runId === rA.run.id).length, 0, "the lock still stands");
    assert.equal((await json(`${base}/api/active-runs`)).items.filter((i) => i.chatId === chatA.id).length, 0);

    // The lock is free: the same workflow starts in another chat and runs through.
    const rB = await start(base, chatB.id, flow.id);
    const doneB = await untilStatus(base, rB.run.id, "done", "failed", "cancelled");
    assert.equal(doneB.run.status, "done", `second run ended as ${doneB.run.status}: ${doneB.run.note}`);
    assert.equal(turns().filter((l) => /STEP ONE/.test(l)).length, 2, "limit attempt in A + run in B");
  }, { claude: { limitRuns: 1, resetInSeconds: 3600 } });
});
