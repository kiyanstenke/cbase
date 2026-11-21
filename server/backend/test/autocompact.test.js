import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as ac from "../electron/server/autocompact.js";
import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { startRun } from "../electron/server/runs/do-run.js";
import { readJsonl } from "./jsonl.mjs";
import { waitForQuiet } from "./quiet.mjs";

// Automatic compaction: rule (autocompact.js) and path through the server — after a run whose context reaches the
// threshold, cbase compacts by itself; the next turn runs without resume, with the summary in front. One global stage,
// overridable per chat.

test("rule: stages, preset, three-valued per chat, due", () => {
  assert.equal(ac.stage(60), 60);
  assert.equal(ac.stage("60"), 60);
  assert.equal(ac.stage(0), 0);
  assert.equal(ac.stage(45), null, "only the fixed stages");
  assert.equal(ac.stage(""), null);
  assert.equal(ac.stage(null), null);
  assert.equal(ac.globalValueOf(() => ""), ac.PRESET);
  assert.equal(ac.globalValueOf(() => "70"), 70);
  assert.equal(ac.globalValueOf(() => "broken"), ac.PRESET, "a broken value falls back to the preset");
  // per chat: null = default (global), 0 = off, stage = own choice
  assert.equal(ac.effective(null, 60), 60);
  assert.equal(ac.effective(0, 60), 0);
  assert.equal(ac.effective(80, 60), 80);
  assert.equal(ac.effective(45, 60), 60, "an invalid chat value does not count");
  // due
  assert.equal(ac.due({ tokens: 120_000, window: 200_000, percent: 60 }), true);
  assert.equal(ac.due({ tokens: 119_999, window: 200_000, percent: 60 }), false);
  assert.equal(ac.due({ tokens: 190_000, window: 200_000, percent: 0 }), false, "off means never");
  assert.equal(ac.due({ tokens: 190_000, window: 0, percent: 60 }), false, "without a window never");
  // engine: share or its own valve
  assert.equal(ac.engineShare(60, 0.78), 0.6);
  assert.equal(ac.engineShare(0, 0.78), 0.78);
});

test("cap: two equal-ranking triggers, the earlier one applies", () => {
  assert.equal(ac.maxStage(350_000), 350_000);
  assert.equal(ac.maxStage("350000"), 350_000);
  assert.equal(ac.maxStage(0), 0, "0 = no cap");
  assert.equal(ac.maxStage(333_000), null, "only the fixed stages");
  assert.equal(ac.maxStage(""), null);
  assert.equal(ac.globalerMax(() => ""), ac.MAX_DEFAULT);
  assert.equal(ac.globalerMax(() => "broken"), ac.MAX_DEFAULT, "a broken value falls back to the preset");
  assert.equal(ac.globalerMax(() => "500000"), 500_000);
  // 50k steps up to one million; preset OFF — with a number, rolling out would silently switch automatic compaction on in
  // every installation.
  assert.equal(ac.MAX_DEFAULT, ac.NO_CAP);
  assert.equal(ac.MAX_STAGES[0], 50_000);
  assert.equal(ac.MAX_STAGES.at(-1), 1_000_000);
  assert.equal(ac.MAX_STAGES.length, 20);

  // The reason for the cap: with a window of one million the smallest stage is 300,000 tokens, the obvious one (60 %)
  // 600,000 — a share alone is no rule there.
  assert.equal(ac.threshold({ window: 1_000_000, percent: 60, absolute: 0 }), 600_000);
  assert.equal(ac.threshold({ window: 1_000_000, percent: 60, absolute: 350_000 }), 350_000, "the cap applies earlier");
  assert.equal(ac.threshold({ window: 200_000, percent: 60, absolute: 350_000 }), 120_000, "with a small window the share");
  assert.equal(ac.threshold({ window: 0, percent: 60, absolute: 350_000 }), 350_000, "without a window the cap carries alone");
  assert.equal(ac.threshold({ window: 0, percent: 60, absolute: 0 }), 0, "without both: never");

  // The measured case: global "at the latest at 500k", share OFF, chat at 652,705 tokens, window 1 M. Formerly the share
  // was the master switch and nothing happened.
  assert.equal(ac.threshold({ window: 1_000_000, percent: 0, absolute: 500_000 }), 500_000);
  assert.equal(ac.due({ tokens: 652_705, window: 1_000_000, percent: 0, absolute: 500_000 }), true);
  // The rule is off when BOTH are off.
  assert.equal(ac.threshold({ window: 1_000_000, percent: 0, absolute: 0 }), 0);
  assert.equal(ac.due({ tokens: 900_000, window: 1_000_000, percent: 0, absolute: 0 }), false);

  // The cap is three-valued per chat — the same design as the share.
  assert.equal(ac.maxEffective(null, 500_000), 500_000, "default inherits the global cap");
  assert.equal(ac.maxEffective(0, 500_000), 0, "\"Off\" switches it off for this chat");
  assert.equal(ac.maxEffective(150_000, 500_000), 150_000, "an own stage wins");
  assert.equal(ac.maxEffective(123, 500_000), 500_000, "a value outside the stages is no choice");

  assert.equal(ac.due({ tokens: 350_000, window: 1_000_000, percent: 60, absolute: 350_000 }), true);
  assert.equal(ac.due({ tokens: 349_999, window: 1_000_000, percent: 60, absolute: 350_000 }), false);
  assert.equal(ac.due({ tokens: 349_999, window: 1_000_000, percent: 60, absolute: 0 }), false, "without a cap only at 600k");
  assert.equal(ac.due({ tokens: 400_000, window: 0, percent: 60, absolute: 350_000 }), true, "the cap works without a window");

  // The engine computes in shares of ITS window — the cap must be converted there.
  assert.equal(ac.engineShare(60, 0.78, { window: 1_000_000, absolute: 350_000 }), 0.35);
  assert.equal(ac.engineShare(60, 0.78, { window: 200_000, absolute: 350_000 }), 0.6, "a cap above the window changes nothing");
  assert.equal(ac.engineShare(60, 0.78, { window: 1_000_000, absolute: 0 }), 0.6);
  assert.equal(ac.engineShare(0, 0.78, { window: 1_000_000, absolute: 500_000 }), 0.5, "the cap alone carries here too");
  assert.equal(ac.engineShare(0, 0.78, { window: 1_000_000, absolute: 0 }), 0.78, "both off ⇒ its own valve");
});

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}
async function status(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  await res.text();
  return res.status;
}
// No deadline (no clock a test can go red on; if it hangs, the suite ends the run). `what` goes to stderr every 30 s so a
// hang stays readable.
async function waitFor(fn, what) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    const s = Math.floor((Date.now() - start) / 30_000);
    if (s > reported) { reported = s; console.error(`[waiting] for ${s * 30} s: ${what}`); }
    await new Promise((r) => setTimeout(r, 40));
  }
}
/**
 * Stop running turns before the server closes.
 *
 * A fake CLI child in stream-json mode waits on stdin until the server ends the turn. If the test aborts before (wrong
 * assertion, or a deadline runs out under load), the child lives on — and a running child process keeps the event loop
 * of the TEST PROCESS open: node --test then never finishes the file. The gate would run into its deadline and report
 * "backend tests failed" without a single red line.
 */
async function stopAllRuns(base) {
  try {
    const r = await fetch(`${base}/api/active-runs`);
    const b = await r.json();
    for (const it of b?.items || []) {
      if (it.chatId && (it.phase === "running" || it.phase === "waiting")) {
        await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
      }
    }
  } catch { /* server already closed or never came up */ }
}

/**
 * Last safeguard: whatever still runs under THIS temp bin is killed hard. `bin` is the path from `mkdtemp` and thus unique
 * to this test — it hits nothing foreign. Needed next to `stopAllRuns` because a ONESHOT (title, summary, goal verdict) is
 * not a "running turn": it hangs on no stop route, and a slow oneshot would hold the process just the same.
 */
function killFakeChildren(bin) {
  let pids = [];
  try {
    pids = execFileSync("/usr/bin/pgrep", ["-f", bin], { encoding: "utf8" }).split("\n").map((x) => +x.trim()).filter(Boolean);
  } catch { return []; } // exit 1 = no match
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  if (pids.length) console.warn(`fake CLI children killed after the test: ${pids.join(", ")}`);
  return pids;
}

const compactMarkers = (log) => log.filter((r) => r.role === "meta").map((r) => { try { return JSON.parse(r.text); } catch { return {}; } }).filter((m) => m.compacted);

test("after the run cbase compacts by itself — global, overridable per chat, follow-up turn with summary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-autocompact-"));
  const bin = path.join(root, "fake-claude");
  const argvLog = path.join(root, "argv.jsonl");
  const promptLog = path.join(root, "prompts.jsonl");
  const prev = { bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL };
  let server;
  let base = null;
  try {
    // The fake reports 150,000 input tokens per answer — with Haiku (200k window) that is 75 %.
    // Oneshots (title, summary) answer with a fixed word.
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(JSON.stringify({ result: "SUMMARY" })));
} else {
  fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(text) + "\\n");
    console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Response" }] } }));
    console.log(JSON.stringify({ type: "result", result: "Response", session_id: "session-" + Math.random().toString(36).slice(2, 8) }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "ws"); fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "AC", path: wsPath }) });
    const newChat = async (fields = {}) => {
      const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
      if (Object.keys(fields).length) await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify(fields) });
      return json(`${base}/api/chats/${c.id}`);
    };
    // The QUIET after the run includes compaction: the work end (runs/do-run.js) decides in the run's finally, in the same
    // tick as `running.delete`, and `compacting.add` comes before the first await — a run that should compact is thus never
    // "quiet" before the compaction is through. So "nothing compacts" needs no pause anymore.
    const run = async (id, text) => {
      await json(`${base}/api/chats/${id}/message`, { method: "POST", body: JSON.stringify({ text }) });
      await waitForQuiet(base);
    };
    const markers = async (id) => compactMarkers(await json(`${base}/api/chats/${id}/log`));

    // Global stage: preset off, only fixed stages allowed.
    let g = await json(`${base}/api/autocompact`);
    assert.equal(g.percent, 0);
    assert.deepEqual(g.stages, ac.STAGES);
    assert.equal(await status(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ percent: 45 }) }), 400);
    assert.equal(await status(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ percent: "x" }) }), 400);
    g = await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ percent: 60 }) });
    assert.equal(g.percent, 60);

    // Chat A follows the default (autocompact null): 75 % ≥ 60 % ⇒ compacts after the run.
    const a = await newChat();
    assert.equal(a.autocompact, null, "without choice: default");
    await run(a.id, "First question");
    const markerA = await waitFor(async () => (await markers(a.id))[0], "chat A was not compacted automatically");
    assert.equal(markerA.auto, true);
    assert.equal(markerA.percent, 60);
    const aAfter = await waitFor(async () => { const c = await json(`${base}/api/chats/${a.id}`); return c.claudeSessionId === null ? c : null; }, "session not reset");
    assert.equal(aAfter.contextTokens, 0);
    // contextSummary is the MESSAGE modeled on the reference (runs/compaction-baseline.js summaryMessage): introduction,
    // summary, sentence about the transcript; the summary itself sits at the marker.
    assert.match(aAfter.contextSummary, /^This session continues an earlier conversation[^\n]*\nSUMMARY\n/);
    assert.equal(markerA.summary, "SUMMARY");
    // The follow-up turn: without resume, the summary in front of the prompt.
    await run(a.id, "Second question");
    const argv = readJsonl(argvLog); // Complete lines only (jsonl.mjs) — the fake CLI writes while the test reads.
    assert.equal(argv.length, 2);
    assert.ok(argv[0].every((x) => x !== "--resume"), "first run without resume");
    assert.ok(argv[1].every((x) => x !== "--resume"), "after compaction the session starts fresh");
    const prompts = readJsonl(promptLog);
    assert.match(prompts[1], /SUMMARY[\s\S]*Second question/, "summary stands before the new question");
    // And due a second time (150k of 200k): the markers become two.
    await waitFor(async () => (await markers(a.id)).length === 2, "second compaction");

    // Chat B: per-chat OFF overrides the global stage — no compaction, session stays.
    const b = await newChat({ autocompact: 0 });
    assert.equal(b.autocompact, 0);
    await run(b.id, "Question to B");
    assert.equal((await markers(b.id)).length, 0, "off means off");
    assert.match((await json(`${base}/api/chats/${b.id}`)).claudeSessionId || "", /^session-/);

    // Global off, chat C with its own stage 50: compacts anyway.
    await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ percent: 0 }) });
    const c = await newChat({ autocompact: 50 });
    assert.equal(c.autocompact, 50);
    await run(c.id, "Question to C");
    const markerC = await waitFor(async () => (await markers(c.id))[0], "chat C was not compacted");
    assert.equal(markerC.percent, 50);
    // Chat D without choice at global off: nothing.
    const d = await newChat();
    await run(d.id, "Question to D");
    assert.equal((await markers(d.id)).length, 0);

    // PATCH: only stages, null = back to default.
    assert.equal(await status(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ autocompact: 45 }) }), 400);
    const cStd = await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ autocompact: null }) });
    assert.equal(cStd.autocompact, null);

    // The cap is a trigger of ITS OWN. The measured case: share on "Off", global "at the latest at" set — formerly nothing
    // happened at all because the share was the master switch. Here: window 200k, cap 100k, the fake reports 150k.
    assert.equal((await json(`${base}/api/autocompact`)).maxTokens, 0, "preset: no cap");
    assert.equal(await status(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ maxTokens: 123_456 }) }), 400);
    const gd = await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ maxTokens: 100_000 }) });
    assert.equal(gd.maxTokens, 100_000);
    assert.equal(gd.percent, 0, "the share stays off — that is the point");
    assert.deepEqual(gd.maxStages, ac.MAX_STAGES);
    const e = await newChat();
    await run(e.id, "Cap question");
    const markerE = (await waitFor(async () => (await markers(e.id))[0], "compaction via the cap"));
    assert.equal(markerE.auto, true);
    // Two controls, two switches: "share off" only switches off the share — the global cap keeps carrying. Otherwise one
    // control would again be the master switch of the other, which was exactly the measured bug.
    const f = await newChat({ autocompact: 0 });
    await run(f.id, "Share-off-cap-on");
    const markerF = (await waitFor(async () => (await markers(f.id))[0], "cap carries despite share off"));
    assert.equal(markerF.auto, true);

    // A chat is fully off only when BOTH controls are on "Off".
    const gz = await newChat({ autocompact: 0, autocompactMax: 0 });
    assert.equal(gz.autocompactMax, 0);
    await run(gz.id, "Both-off");
    assert.equal((await markers(gz.id)).length, 0, "both off means off");

    // And the per-chat cap wins against the global one: here 50k instead of 100k, with 150k reported.
    assert.equal(await status(`${base}/api/chats/${gz.id}`, { method: "PATCH", body: JSON.stringify({ autocompactMax: 123_456 }) }), 400);
    const hh = await newChat({ autocompactMax: 50_000 });
    assert.equal(hh.autocompactMax, 50_000);
    const hhStd = await json(`${base}/api/chats/${hh.id}`, { method: "PATCH", body: JSON.stringify({ autocompactMax: null }) });
    assert.equal(hhStd.autocompactMax, null, "null withdraws the own choice");
  } finally {
    // Order: stop the runs first (otherwise a fake CLI child lives on and holds the event loop), then the environment,
    // then the server — `closeAllConnections` BEFORE `close`, because `server.close()` waits for every open connection
    // and a failure would otherwise look like a hang. Finally the hard safeguard for oneshot children.
    if (base) await stopAllRuns(base);
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    killFakeChildren(bin);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.warn("Cleanup:", e?.message || e); }
  }
});

// Goal gate and compaction. Measured in a long chat: a run over 30 minutes ended, the compaction was due — and a goal gate
// would have started its continuation NEXT TO it (the gate only checked `running`, and no turn runs during compaction):
// with the old session and the full log, while compactChatContext writes `claudeSessionId: null` into the middle of the
// new turn. The continuation belongs BEHIND the compaction: fresh session, summary in front.
//
// The summary only answers here when the test opens its gate: the judge is done immediately, and without the order in the
// server it would win the race every time. The gate is opened only when NOTHING else is open next to the compaction — a
// goal gate running next to it would have had its chance, including the continuation, by then; the counter-test against
// the old behavior thus fails deterministically, not by chance.
test("goal gate waits for the compaction: the continuation starts without resume, with summary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-autocompact-target-"));
  const bin = path.join(root, "fake-claude");
  const argvLog = path.join(root, "argv.jsonl");
  const promptLog = path.join(root, "prompts.jsonl");
  const judgeState = path.join(root, "judge.txt");
  const gateWaiting = path.join(root, "summary.waiting");
  const gateOpen = path.join(root, "summary.free");
  const prev = { bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL };
  let server;
  let base = null;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    if (/compacting the chat history/i.test(stdin)) {           // the summary (claude.js) — only when the test opens the gate
      fs.writeFileSync(${JSON.stringify(gateWaiting)}, "1");
      const tick = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gateOpen)})) return;
        clearInterval(tick);
        console.log(JSON.stringify({ result: "SUMMARY" }));
      }, 25);
      return;
    }
    if (/overarching target/i.test(stdin)) {     // the goal judge (server.js) — immediately
      let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(judgeState)}, "utf8")) || 0; } catch {}
      fs.writeFileSync(${JSON.stringify(judgeState)}, String(n + 1));
      console.log(JSON.stringify({ result: n === 0 ? '{"achieved": false, "note": "still open"}' : '{"achieved": true, "note": "done"}' }));
      return;
    }
    console.log(JSON.stringify({ result: "Title" }));
  });
} else {
  fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    const runs = fs.existsSync(${JSON.stringify(promptLog)}) ? fs.readFileSync(${JSON.stringify(promptLog)}, "utf8").split("\\n").filter(Boolean).length : 0;
    fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(text) + "\\n");
    // Only the FIRST run fills the context (150k of 200k ⇒ due); the continuation stays small, otherwise cbase
    // would compact a second time and the session check below would hit the second compaction instead of
    // the continuation.
    const input = runs === 0 ? 150000 : 10000;
    console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Response" }] } }));
    console.log(JSON.stringify({ type: "result", result: "Response", session_id: "session-" + Math.random().toString(36).slice(2, 8) }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "ws"); fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "ACZ", path: wsPath }) });
    await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ percent: 60 }) });
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Finish everything" }) });
    await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "First question" }) });

    // The compaction stands at the gate and NOTHING else is open: no run, no goal verdict, no other oneshot (the title is
    // done). A goal gate next to the compaction (the old bug) would have judged by now and driven its continuation with
    // the old session — the check below would turn red, without any clock involved.
    await waitFor(async () => {
      if (!fs.existsSync(gateWaiting)) return false;
      const { open } = await json(`${base}/api/runs/active`);
      return open.compaction === 1 && open.oneshots === 1 && open.runs === 0 && open.targetCheck === 0
        && open.verdicts === 0 && open.queue === 0 && open.hooks === 0 && open.waitPhase === 0 && open.agents === 0;
    }, "the compaction stands alone at the gate");
    fs.writeFileSync(gateOpen, "1");

    // The first run ends, compaction is due, the judge says "open" ⇒ continuation.
    const resumption = await waitFor(async () => {
      const argv = readJsonl(argvLog); // complete lines only ("Unexpected end of JSON input" otherwise)
      return argv.length >= 2 ? argv : null;
    }, "the continuation of the goal gate did not start");
    assert.equal(resumption.length, 2, "exactly one run and one continuation");
    assert.ok(resumption[1].every((x) => x !== "--resume"), "the continuation must take the fresh session — not the old one next to the compaction");
    // The fake CLI writes its argv first, then reads stdin and writes the prompt — under load there is a window between the
    // two ("the summary stands before the continuation" red, green 3× alone). So wait for the SECOND prompt line, not just
    // the argv.
    const prompts = await waitFor(async () => {
      const rowsValue = readJsonl(promptLog);
      return rowsValue.length >= 2 ? rowsValue : null;
    }, "the prompt of the continuation did not arrive");
    assert.match(prompts[1], /SUMMARY[\s\S]*\[Target gate\]/, "the summary stands before the continuation");
    // Quiet includes the second verdict (targetCheck + oneshots) — the looks below no longer wait.
    await waitForQuiet(base);

    // Order in the log: compaction marker BEFORE the verdict and before the continuation.
    const rows = await waitFor(async () => {
      const l = await json(`${base}/api/chats/${c.id}/log`);
      return l.filter((r) => r.role === "goal").length >= 2 ? l : null;
    }, "the second verdict (achieved) is missing");
    // The harness prompt of the continuation is no user row — its trace in the log is the
    // second answer, and that must stand AFTER marker and verdict.
    const iMarker = rows.findIndex((r) => r.role === "meta" && /"compacted":true/.test(r.text));
    const iVerdict = rows.findIndex((r) => r.role === "goal");
    const iResumption = rows.findIndex((r, i) => i > iVerdict && r.role === "assistant");
    assert.ok(iMarker >= 0 && iVerdict > iMarker && iResumption > iVerdict, `order: marker ${iMarker}, verdict ${iVerdict}, continuation ${iResumption}`);
    assert.equal(JSON.parse(rows[iVerdict].text).continuing, true);
    assert.equal(compactMarkers(rows).length, 1, "exactly one compaction — the continuation stays small");
    // In the end: the goal achieved and cleared, the session that of the continuation (not null,
    // not the first) — the compaction no longer overwrote the running turn.
    const chatEnd = await waitFor(async () => { const x = await json(`${base}/api/chats/${c.id}`); return x.goal === "" ? x : null; }, "the goal was not cleared after the second verdict");
    assert.match(chatEnd.claudeSessionId || "", /^session-/, "the session of the continuation must stay");
  } finally {
    // Order: stop the runs first (otherwise a fake CLI child lives on and holds the event loop), then the environment,
    // then the server — `closeAllConnections` BEFORE `close`, because `server.close()` waits for every open connection
    // and a failure would otherwise look like a hang. Finally the hard safeguard for oneshot children.
    try { fs.writeFileSync(gateOpen, "1"); } catch { /* folder already gone */ }
    if (base) await stopAllRuns(base);
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    killFakeChildren(bin);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.warn("Cleanup:", e?.message || e); }
  }
});

// Between the end of a turn and the goal gate's continuation the judge judges WITHOUT a turn — the client releases `busy`
// already at `run_done`. A /compact in that window used to run through, its finally started the queue, and the gate's
// continuation ran next to it: two CLI processes in the same chat, the continuation's session was lost. Now the route
// rejects the window (409), and the continuation checks `compacting` itself.
test("goal verdict without a turn: /compact is rejected, the continuation runs alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-autocompact-goal-window-"));
  const bin = path.join(root, "fake-claude");
  const promptLog = path.join(root, "prompts.jsonl");
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  const T = (n) => path.join(root, n);
  const prev = { bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL };
  let server;
  let base = null;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const T = (n) => path.join(${JSON.stringify(root)}, n);
const wait = (gate, fn) => { const t = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(t); fn(); } }, 20); };
if (!args.includes("stream-json")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    if (/compacting the chat history/i.test(stdin)) { fs.writeFileSync(T("compact.ran"), "1"); console.log(JSON.stringify({ result: "SUMMARY" })); return; }
    if (/overarching target/i.test(stdin)) {
      let n = 0; try { n = Number(fs.readFileSync(T("judge.n"), "utf8")) || 0; } catch {}
      fs.writeFileSync(T("judge.n"), String(n + 1));
      if (n > 0) { console.log(JSON.stringify({ result: '{"achieved": true, "note": "done"}' })); return; }
      fs.writeFileSync(T("judge.waiting"), "1");
      wait(T("judge.free"), () => console.log(JSON.stringify({ result: '{"achieved": false, "note": "still open"}' })));
      return;
    }
    console.log(JSON.stringify({ result: "Title" }));
  });
} else {
  const me = path.join(${JSON.stringify(live)}, String(process.pid));
  fs.writeFileSync(me, "1");
  process.on("exit", () => { try { fs.unlinkSync(me); } catch {} });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ pid: process.pid, text: text.slice(0, 200), live: fs.readdirSync(${JSON.stringify(live)}).length }) + "\\n");
    console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Response" }] } }));
    console.log(JSON.stringify({ type: "result", result: "Response", session_id: "session-" + process.pid }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "ws"); fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "ACZ-Window", path: wsPath }) });
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Finish everything" }) });
    await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "First question" }) });
    await waitFor(async () => {
      if (!fs.existsSync(T("judge.waiting"))) return false;
      const { open } = await json(`${base}/api/runs/active`);
      return open.runs === 0 && open.targetCheck === 1;
    }, "the turn is over, the goal verdict stands at the gate");
    assert.equal(await status(`${base}/api/chats/${c.id}/compact`, { method: "POST" }), 409, "the chat does not compact in the verdict window");
    fs.writeFileSync(T("judge.free"), "1");
    await waitFor(async () => (await json(`${base}/api/chats/${c.id}`)).goal === "", "the continuation ran, the second verdict cleared the goal");
    await waitForQuiet(base);
    const prompts = readJsonl(promptLog);
    assert.equal(prompts.length, 2, `one turn and one continuation: ${JSON.stringify(prompts)}`);
    assert.match(prompts[1].text, /\[Target gate\]/);
    assert.ok(prompts.every((p) => p.live === 1), `never two CLI processes at once: ${JSON.stringify(prompts)}`);
    assert.equal(fs.existsSync(T("compact.ran")), false, "no compaction next to the verdict");
  } finally {
    try { fs.writeFileSync(T("judge.free"), "1"); } catch { /* folder already gone */ }
    if (base) await stopAllRuns(base);
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    killFakeChildren(bin);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.warn("Cleanup:", e?.message || e); }
  }
});

// M17, second half: the /compact route is closed in the verdict window, but a compaction also begins there without it — a
// parked compact row fires at the reset or via "Try now", and fireAutoContinueInner only asks `running`. Until then the
// goal gate's continuation then silently DISCARDED itself although the goal row just written announced "continuing": the
// goal stayed open and nothing came. Now cleanly one after the other — first the compaction ends, then the continuation
// runs, with the summary in front, never next to it. Both stand at gates so the window stays open as long as the test
// needs; without a clock: either the goal is reached or everything stands still.
test("goal verdict and parked compaction firing mid-verdict: the continuation runs afterwards, not never", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-autocompact-target-row-"));
  const bin = path.join(root, "fake-claude");
  const promptLog = path.join(root, "prompts.jsonl");
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  const T = (n) => path.join(root, n);
  const prev = { bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL };
  let server;
  let base = null;
  let nowAttempt = null;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const T = (n) => path.join(${JSON.stringify(root)}, n);
const wait = (gate, fn) => { const t = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(t); fn(); } }, 20); };
if (!args.includes("stream-json")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    if (/compacting the chat history/i.test(stdin)) {
      fs.writeFileSync(T("compact.waiting"), "1");
      wait(T("compact.free"), () => { fs.writeFileSync(T("compact.ran"), "1"); console.log(JSON.stringify({ result: "SUMMARY" })); });
      return;
    }
    if (/overarching target/i.test(stdin)) {
      let n = 0; try { n = Number(fs.readFileSync(T("judge.n"), "utf8")) || 0; } catch {}
      fs.writeFileSync(T("judge.n"), String(n + 1));
      if (n > 0) { console.log(JSON.stringify({ result: '{"achieved": true, "note": "done"}' })); return; }
      fs.writeFileSync(T("judge.waiting"), "1");
      wait(T("judge.free"), () => console.log(JSON.stringify({ result: '{"achieved": false, "note": "still open"}' })));
      return;
    }
    console.log(JSON.stringify({ result: "Title" }));
  });
} else {
  const me = path.join(${JSON.stringify(live)}, String(process.pid));
  fs.writeFileSync(me, "1");
  process.on("exit", () => { try { fs.unlinkSync(me); } catch {} });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ pid: process.pid, text, live: fs.readdirSync(${JSON.stringify(live)}).length }) + "\\n");
    console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Response" }] } }));
    console.log(JSON.stringify({ type: "result", result: "Response", session_id: "session-" + process.pid }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "ws"); fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "ACZ-Target-row", path: wsPath }) });
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Finish everything" }) });
    await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "First question" }) });
    await waitFor(async () => {
      if (!fs.existsSync(T("judge.waiting"))) return false;
      const { open } = await json(`${base}/api/runs/active`);
      return open.runs === 0 && open.targetCheck === 1;
    }, "the turn is over, the goal verdict stands at the gate");
    // A parked compaction (as after a limit) — "Try now" fires it IN THE MIDDLE of the verdict. The route only answers
    // when the compaction is through; its promise is collected below.
    const now = Date.now();
    store.setPendingResume(c.id, {
      kind: "compact", provider: "claude", limitGroup: "session", limitLabel: "session",
      reason: "reset", resetsAt: now + 6 * 3_600_000, dueAt: now + 6 * 3_600_000, now: now,
    });
    nowAttempt = fetch(`${base}/api/chats/${c.id}/auto-continue/now`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await waitFor(async () => {
      if (!fs.existsSync(T("compact.waiting"))) return false;
      const { open } = await json(`${base}/api/runs/active`);
      return open.compaction === 1 && open.targetCheck === 1;
    }, "the compaction runs, the goal verdict still stands at the gate");
    fs.writeFileSync(T("judge.free"), "1");
    // The verdict has fallen ("still open") — recognized at the end of its oneshot: only the compaction's runs (it stands at
    // the gate), and the gate keeps its marker while it waits for the compaction to end. Only then does the compaction
    // end. The goal row "continuing" only appears once it REALLY continues — it is NOT there in this window.
    await waitFor(async () => {
      const { open } = await json(`${base}/api/runs/active`);
      return open.oneshots === 1 && open.compaction === 1 && open.targetCheck === 1;
    }, "the verdict has fallen, the compaction still runs");
    assert.ok(!(await json(`${base}/api/chats/${c.id}/log`)).some((r) => r.role === "goal"), "the goal row waits for the continuation");
    fs.writeFileSync(T("compact.free"), "1");
    // Quiet first, THEN the goal: the other way round — read the goal (still open), then quiet — left a window between the
    // two requests in which the continuation including the second verdict ran to its end; the test then saw quiet with a
    // goal from BEFORE and reported "dismissed". When everything is still, the goal no longer changes — the one read
    // afterwards is the final one.
    const outcome = await waitFor(async () => {
      const { open } = await json(`${base}/api/runs/active`);
      const still = open.runs === 0 && open.compaction === 0 && open.targetCheck === 0 && open.oneshots === 0;
      const reached = (await json(`${base}/api/chats/${c.id}`)).goal === "";
      return reached ? "resumed" : still ? "dismissed" : null;
    }, "the continuation runs and the goal is reached — or everything stands still");
    assert.equal((await nowAttempt).status, 200);
    nowAttempt = null;
    assert.equal(outcome, "resumed", "the goal gate continuation silently discarded itself although the goal row announced it");
    await waitForQuiet(base);
    const gz = (await json(`${base}/api/chats/${c.id}/log`)).filter((r) => r.role === "goal").map((r) => JSON.parse(r.text));
    assert.deepEqual(gz.map((z) => [z.achieved, z.continuing === true]), [[false, true], [true, false]], "\"continuing\", then \"achieved\"");
    const prompts = readJsonl(promptLog);
    assert.equal(prompts.length, 2, `one turn and one continuation: ${JSON.stringify(prompts.map((p) => p.text.slice(0, 80)))}`);
    assert.match(prompts[1].text, /SUMMARY[\s\S]*\[Target gate\]/, "the continuation ran AFTER the compaction, with the summary in front");
    assert.ok(prompts.every((p) => p.live === 1), `never two CLI processes at once: ${JSON.stringify(prompts.map((p) => p.live))}`);
    assert.equal(fs.existsSync(T("compact.ran")), true, "the compaction ran");
  } finally {
    for (const t of ["judge.free", "compact.free"]) { try { fs.writeFileSync(T(t), "1"); } catch { /* folder already gone */ } }
    if (nowAttempt) await nowAttempt.catch(() => {});
    if (base) await stopAllRuns(base);
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    killFakeChildren(bin);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.warn("Cleanup:", e?.message || e); }
  }
});

// The work end leaves the queue for the automatic compaction, whose finally starts it. But if compactChatContext returned
// BEFORE that finally ("too little log" — here: a turn without a user row, as startRun starts one for a driver or agent,
// with a full context), a queued message stayed lying until the next one happened to arrive. The message arrives AFTER
// the result, when stdin is already closed (gate at the process end) — so it is not injected into the process and reaches
// the work end in the queue.
test("compaction returns early (too little log): the queued message runs anyway", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-autocompact-early-"));
  const bin = path.join(root, "fake-claude");
  const promptLog = path.join(root, "prompts.jsonl");
  const T = (n) => path.join(root, n);
  const prev = { bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL };
  let server;
  let base = null;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const T = (n) => path.join(${JSON.stringify(root)}, n);
if (!args.includes("stream-json")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => console.log(JSON.stringify({ result: /compacting the chat history/i.test(stdin) ? "SUMMARY" : "Title" })));
} else {
  let hold = false;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    hold = hold || text.includes("HOLD-END");
    fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(text.slice(0, 200)) + "\\n");
    const input = text.includes("HOLD-END") ? 150000 : 10000;
    console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Response" }] } }));
    console.log(JSON.stringify({ type: "result", result: "Response", session_id: "session-" + process.pid }));
  });
  process.stdin.on("end", () => {
    if (!hold) return;
    fs.writeFileSync(T("end.waiting"), "1");
    const t = setInterval(() => { if (fs.existsSync(T("end.free"))) { clearInterval(t); process.exit(0); } }, 20);
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "ws"); fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "ACZ-Early", path: wsPath }) });
    await json(`${base}/api/autocompact`, { method: "PUT", body: JSON.stringify({ percent: 60 }) });
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    startRun(store.getChat(c.id), "HOLD-END first work");
    await waitFor(() => fs.existsSync(T("end.waiting")), "the turn answered, its process stands at the end gate");
    const q = await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "SECOND message" }) });
    assert.equal(q.queued, true, `the turn was still running — queued: ${JSON.stringify(q)}`);
    fs.writeFileSync(T("end.free"), "1");
    // Without a clock: either the message ran, or everything stands still and it lies in the queue (the old bug).
    const outcome = await waitFor(async () => {
      if (readJsonl(promptLog).some((t) => t.includes("SECOND message"))) return "run";
      const { open } = await json(`${base}/api/runs/active`);
      return open.runs === 0 && open.compaction === 0 && open.queue === 1 ? "stuck" : null;
    }, "the queued message runs — or stays stuck");
    assert.equal(outcome, "run", "the message stayed in the queue behind the early-returned compaction");
    await waitForQuiet(base);
  } finally {
    try { fs.writeFileSync(T("end.free"), "1"); } catch { /* folder already gone */ }
    if (base) await stopAllRuns(base);
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    killFakeChildren(bin);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { console.warn("Cleanup:", e?.message || e); }
  }
});
