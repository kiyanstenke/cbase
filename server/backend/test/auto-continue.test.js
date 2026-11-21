// End-to-end tests of automatic continuation at the usage limit — over the REAL HTTP routes,
// with a fake CLI that fails at the limit on the first run and answers normally afterwards.
//
// Why: a real usage limit cannot be provoked. The fake CLI therefore prints exactly the wordings found in the installed
// binaries (Claude 2.1.220, Codex 0.145.0), and the reset time comes from two real sources:
//   · Claude — reset hint IN the error text (the usage endpoint is unreachable in the test; exactly this fallback must
//     hold),
//   · Codex — a real rollout file with a rate_limits snapshot under CODEX_HOME.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an event — WITHOUT a deadline (no timers in tests: the suite deadline is the emergency brake). A deadline
// would itself be a clock a test goes red on under load. Every 30 s a line on stderr names the condition.
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
/**
 * Wait until the waiting state is RESOLVED.
 *
 * Not the same as "the answer is in the log": the run writes the log, another path clears the waiting state. Reading
 * right after the log entry tests a race — under load you lose it.
 *
 * Explicitly NOT for the cases where no waiting state may arise at all — there wait-until-empty would be an assertion
 * that always holds. Those stay single reads.
 */
const waitResolved = (base, chatId) =>
  waitFor(async () => ((await waitState(base, chatId)).wait ? null : true), `waiting state of ${chatId} resolved`);

// Fake Claude: fails as long as the marker file is missing — with the wording of the real CLI plus
// (optionally) a reset hint. Afterwards it answers as in normal operation.
// `limitRuns`     = how many runs should fail at the limit.
// `subagentLimit` = the limit hits a SUBAGENT: the process keeps running and ends with code 0 — the error sits only in the
//                   tool result of the subagent call. Two KINDS, and they report differently (hence a word, not a switch):
//                     "cbase" (default) — the OWN subagent `mcp__cbase__cbase_agent`. It runs as its own cbase run; its
//                        report comes back as an ORDINARY tool result, the limit evidence is in the text. The CLI does NOT
//                        set `is_error` here — it delivered the call without error.
//                     "task" — the CLI's built-in kind (`Task`/`Agent`), with `is_error` (untested now: locked).
// `compactLimit`  = how often COMPACTION (oneshot with the compact prompt) fails at the limit. Recognized by the prompt
//                   text so that the title oneshot stays untouched.
// `goalLimit`     = how often the GOAL VERDICT fails at the limit (also recognized by the prompt text).
// `switchSet`     = the CLI switches the model by itself and says so. The sentence then appears in the answer AND in the
//                   result — just like the real CLI, which repeats its message. Nothing fails: the run goes on.
const fakeClaude = ({ stateFile, promptLog, resetInSeconds = null, limitRuns = 1, credits = false, subagentLimit = false, compactLimit = 0, goalLimit = 0, switchSet = "" }) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const state = ${JSON.stringify(stateFile)};
const compactState = ${JSON.stringify(`${stateFile}.compact`)};
const goalState = ${JSON.stringify(`${stateFile}.goal`)};
const hint = ${resetInSeconds == null ? "\"\"" : `" · resets at " + new Date(Date.now() + ${resetInSeconds} * 1000).toISOString()`};
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {           // oneshot: title/verdicts/compact
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    if (/compacting the chat history/i.test(stdin)) {            // the compact prompt from claude.js
      let n = 0;
      try { n = Number(fs.readFileSync(compactState, "utf8")) || 0; } catch {}
      if (n < ${compactLimit}) {
        try { fs.writeFileSync(compactState, String(n + 1)); } catch {}
        process.stderr.write("Claude usage limit reached" + hint + "\\n");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ result: "SUMMARY: state of the log" }));
      process.exit(0);
    }
    if (/overarching target/i.test(stdin)) {  // the goal judge from server.js
      let n = 0;
      try { n = Number(fs.readFileSync(goalState, "utf8")) || 0; } catch {}
      if (n < ${goalLimit}) {
        try { fs.writeFileSync(goalState, String(n + 1)); } catch {}
        process.stderr.write("Claude usage limit reached" + hint + "\\n");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ result: '{"achieved": true, "note": "Goal achieved"}' }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ result: "Title" }));
    process.exit(0);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    let msg; try { msg = JSON.parse(l); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    try { fs.appendFileSync(${JSON.stringify(promptLog)}, text.replace(/\\s+/g, " ").slice(0, 200) + "\\n"); } catch {}
    let runs = 0;
    try { runs = Number(fs.readFileSync(state, "utf8")) || 0; } catch {}
    if (runs < ${limitRuns} && ${JSON.stringify(subagentLimit ? (subagentLimit === true ? "cbase" : String(subagentLimit)) : "")} !== "") {
      // Subagent at the limit: call, tool result with the CLI's wording, then the MAIN agent
      // ends the turn regularly. No error code — the server closes stdin.
      const genus = ${JSON.stringify(subagentLimit === "task" ? "task" : "cbase")};
      // "collected": the report of a BACKGROUND agent does not come with the call but when
      // collected with cbase_agent_output — same report form, different tool.
      const tool = genus === "task" ? "Task"
        : ${JSON.stringify(subagentLimit === "collected" ? "mcp__cbase__cbase_agent_output" : "mcp__cbase__cbase_agent")};
      // The built-in kind reports a tool error; the own subagent does the same when its CLI dies
      // ("cbase-error"). "true" is the plain case: an ordinary report in which the wording is only TEXT —
      // data, no error.
      const result = { type: "tool_result", tool_use_id: "tu_sub_1", content: "Claude usage limit reached" + hint };
      if (${JSON.stringify(subagentLimit === "task" || subagentLimit === "cbase-error" || subagentLimit === "collected")}) result.is_error = true;
      try { fs.writeFileSync(state, String(runs + 1)); } catch {}
      setTimeout(() => {
        say({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_sub_1", name: tool, input: { description: "Subtask" } }] } });
        say({ type: "user", message: { content: [result] } });
        say({ type: "assistant", message: { content: [{ type: "text", text: "Subagent could not work." }] } });
        say({ type: "result", result: "Subagent could not work.", session_id: "auto-continue" });
      }, 30);
      return;
    }
    if (runs < ${limitRuns}) {
      try { fs.writeFileSync(state, String(runs + 1)); } catch {}
      // Wording of the real CLI; reset hint only if wanted.
      const extra = ${credits ? '" Visit https://chatgpt.com/codex/settings/usage to purchase more credits"' : '""'};
      process.stderr.write("Claude usage limit reached" + hint + extra + "\\n");
      setTimeout(() => process.exit(1), 30);
      return;
    }
    const changeover = ${JSON.stringify(switchSet)};
    // The sentence sits on a LINE OF ITS OWN: the server cuts out the whole line around the hit, and a
    // sentence glued to "FINISHED …" would then end up in the log together with foreign text.
    const out = (changeover ? changeover + "\\n" : "") + "FINISHED " + text.replace(/\\s+/g, " ").slice(0, 80);
    setTimeout(() => {
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "auto-continue" });
    }, 30);
  });
}
`;

// Fake Codex: fails once with the real Codex wording, then a normal answer.
// `modelTextBeforeTod`: instead of at the limit the run dies of a network error AFTER the model has written a text — the
// text is the subject under test (it talks about rate limits and 429).
const fakeCodex = ({ stateFile, limitRuns = 1, modelTextBeforeTod = "" }) => `#!/usr/bin/env node
const fs = require("node:fs");
const state = ${JSON.stringify(stateFile)};
const say = (o) => console.log(JSON.stringify(o));
const args = process.argv.slice(2);
const prompt = args[args.length - 1] || "";
if (!args.includes("--json")) { // runOnce counterpart: -o <file>
  const i = args.indexOf("-o");
  if (i >= 0 && args[i + 1]) { try { fs.writeFileSync(args[i + 1], "Title"); } catch {} }
  process.exit(0);
}
let runs = 0;
try { runs = Number(fs.readFileSync(state, "utf8")) || 0; } catch {}
say({ type: "thread.started", thread_id: "codex-thread-1" });
say({ type: "turn.started" });
if (${JSON.stringify(modelTextBeforeTod)}) {
  try { fs.writeFileSync(state, String(runs + 1)); } catch {}
  say({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: ${JSON.stringify(modelTextBeforeTod)} } });
  say({ type: "turn.failed", error: { message: "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)" } });
  setTimeout(() => process.exit(1), 30);
} else if (runs < ${limitRuns}) {
  try { fs.writeFileSync(state, String(runs + 1)); } catch {}
  say({ type: "turn.failed", error: { message: "You've hit your usage limit." } });
  setTimeout(() => process.exit(1), 30);
} else {
  say({ type: "item.completed", item: { type: "agent_message", text: "FINISHED " + prompt.slice(0, 60) } });
  say({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  setTimeout(() => process.exit(0), 30);
}
`;

// Rollout file like the real Codex CLI: one JSONL line with a rate_limits snapshot.
function writeCodexRollout(codexHome, { resetInSeconds = 2, reachedType = "primary", usedPercent = 100 } = {}) {
  const dir = path.join(codexHome, "sessions", "2026", "07", "30");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-2026-07-30T12-00-00-codex-thread-1.jsonl");
  const snapshot = {
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: reachedType === "primary" ? usedPercent : 12, window_minutes: 300, resets_at: Math.floor((Date.now() + resetInSeconds * 1000) / 1000) },
        secondary: { used_percent: reachedType === "secondary" ? usedPercent : 30, window_minutes: 10080, resets_at: Math.floor((Date.now() + resetInSeconds * 1000) / 1000) },
        plan_type: "plus",
        rate_limit_reached_type: reachedType,
      },
      info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 }, last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 }, model_context_window: 400000 },
    },
  };
  fs.writeFileSync(file, JSON.stringify(snapshot) + "\n");
  return file;
}

// Keep the Anthropic usage endpoint out of the test: it is the preferred reset source of the Claude path but would query
// the developer's REAL account here — the test would depend on the current account state (and wait for hours with an
// exhausted window). Without credentials the server falls back to the reset hint in the message, which is exactly the
// fallback to be tested here. For that: HOME on an empty directory (no .credentials.json there) and a `security` that
// finds nothing (macOS keychain).
function isolateCredentials(root) {
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  const security = path.join(binDir, "security");
  fs.writeFileSync(security, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(security, 0o755);
  // `npx` as a no-op (like wait-row-lifecycle.test.js): every server loads the Playwright MCP into the npx cache of the
  // redirected HOME at start — over the network, up to 300 s (toolchain/playwright.js), and the grandchild keeps the test
  // process open that long. No test here needs the browser.
  const npx = path.join(binDir, "npx");
  fs.writeFileSync(npx, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(npx, 0o755);
  process.env.NPX_BIN = npx;
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

async function withServer(fn, { claude = null, codex = null, codexHome = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-autocont-"));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN, CODEX_HOME: process.env.CODEX_HOME, NPX_BIN: process.env.NPX_BIN,
    CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL, HOME: process.env.HOME, PATH: process.env.PATH,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  let server, base = "";
  let finished = false;   // the body ran through without throwing (see finally)
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    isolateCredentials(root);
    const stateFile = path.join(root, "runs.txt");
    const promptLog = path.join(root, "prompts.txt");
    if (claude !== false) {
      const bin = path.join(root, "fake-claude");
      fs.writeFileSync(bin, fakeClaude({ stateFile, promptLog, ...(claude || {}) }));
      fs.chmodSync(bin, 0o755);
      process.env.CLAUDE_BIN = bin;
    }
    if (codex) {
      const bin = path.join(root, "fake-codex");
      fs.writeFileSync(bin, fakeCodex({ stateFile: path.join(root, "codex-runs.txt"), ...codex }));
      fs.chmodSync(bin, 0o755);
      process.env.CODEX_BIN = bin;
    }
    if (codexHome) {
      const home = path.join(root, "codex-home");
      fs.mkdirSync(home, { recursive: true });
      writeCodexRollout(home, codexHome);
      process.env.CODEX_HOME = home;
    }
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Limit", path: wsPath }) });
    await fn({ base, ws, root, stateFile, promptLog });
    finished = true;
  } finally {
    // Wait for quiet only after a passed body (template: agent-harness.mjs) — after a failure a hanging run would
    // otherwise stand without a deadline, and the error above would never arrive.
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    discardTempRoot(root);
  }
}

// Remove the temp folder — but a failure MUST NOT fail the test. The folder carries a redirected HOME; npm still writes
// into `.npm/_cacache` there while the server is already closed, and `rmSync` aborts with ENOTEMPTY. Cleanup is hygiene,
// not a subject under test.
function discardTempRoot(root) {
  try {
    // A child process still writing causes ENOTEMPTY; that says something about cleanup, not the product.
    // It is still not kept quiet — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  } catch (e) {
    console.error(`[test] temp folder left behind (${e?.code || e?.message}): ${root}`);
  }
}

async function newChat(base, ws, { provider = "claude", title = "Limit chat" } = {}) {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider, model: provider === "codex" ? "gpt-5.6-sol" : "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}
const send = (base, id, text) => json(`${base}/api/chats/${id}/message`, { method: "POST", body: JSON.stringify({ text }) });
const waitState = (base, id) => json(`${base}/api/chats/${id}/auto-continue`);
const log = (base, id) => json(`${base}/api/chats/${id}/log`);
// The bell (and thus the push): notices of kind `limit` for ONE chat. Filtered by chat because the event buffer in
// services.js is module-wide and grows across all tests of this file — a count over everything would depend on order.
const limitNotifications = async (base, chatId) =>
  ((await json(`${base}/api/services/events`)).events || [])
    .filter((e) => e.kind === "limit" && (e.chatId === chatId || e.managerChatId === chatId));

test("Claude at the limit: run is parked and resumes by itself after the reset", async () => {
  await withServer(async ({ base, ws, promptLog }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    // 1) A waiting state arises — with the reset time from the message.
    const waiting = await waitFor(async () => {
      const s = await waitState(base, chat.id);
      return s.wait ? s : null;
    });
    assert.ok(waiting?.wait, "no waiting state created");
    assert.equal(waiting.wait.reason, "reset", "the reset hint from the message must take effect");
    assert.ok(waiting.wait.dueAt > Date.now() - 5_000);
    assert.match(waiting.wait.evidence, /usage limit reached/i);

    // 2) The overview shows the waiting run (otherwise it lies invisible).
    const overview = await json(`${base}/api/active-runs`);
    const item = overview.items.find((i) => i.kind === "limit" && i.chatId === chat.id);
    assert.ok(item, "waiting run missing in /api/active-runs");
    assert.equal(overview.counts.limit, 1);

    // 3) The log records the wait row (survives a reload).
    const entries = (await log(base, chat.id)).filter((e) => e.role === "limit");
    assert.ok(entries.length >= 1);
    assert.equal(JSON.parse(entries[0].text).kind, "wait");

    // 3b) And there is a NOTICE. Without it nothing tells you about the parking: the "answer finished" message is
    // explicitly suppressed then, and with a weekly window it would stay silent for days.
    const parked = await waitFor(async () => {
      const m = await limitNotifications(base, chat.id);
      return m.length ? m : null;
    });
    assert.equal(parked.length, 1, "exactly one notice for parking");
    assert.match(parked[0].title, /Wartet|Waiting/, `title of the parking notice: ${parked[0].title}`);
    assert.match(parked[0].body, /5-Stunden-Limit|5-hour limit|Nutzungslimit|usage limit/i, "the notice does not say which window");

    // 4) Continuation happens BY ITSELF (reset ~2 s in the future, grace at ~20 s because of the
    //    minimum wait → awaited here via the sweeper/timer).
    const done = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? l : null;
    }, "", 250);
    assert.ok(done, "run was not continued automatically");
    // The waiting state is resolved afterwards.
    assert.ok(await waitResolved(base, chat.id), "the waiting state stayed");
    // And it was the same task (no new prompt invented).
    const prompts = fs.readFileSync(promptLog, "utf8").trim().split("\n");
    assert.equal(prompts.length, 2, "the task must be repeated exactly once");
    assert.equal(prompts[0], prompts[1]);
    const resumed = (await log(base, chat.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind);
    assert.ok(resumed.includes("resume"), "resume row missing in the log");

    // 5) CONTINUING also reports — as a second notice, not as an overwrite of the first
    // (the bundle id carries a value of its own for each half).
    const both = await waitFor(async () => {
      const m = await limitNotifications(base, chat.id);
      return m.length >= 2 ? m : null;
    });
    assert.equal(both.length, 2, `parking and continuing are two notices: ${JSON.stringify(both.map((e) => e.title))}`);
    assert.match(both[1].title, /Läuft weiter|Continuing/, `title of the continue notice: ${both[1].title}`);
    assert.notEqual(both[0].id, both[1].id, "the second must not replace the first");
  }, { claude: { resetInSeconds: 2 } });
});

test("Codex at the limit: rate_limit_reached_type determines window and reset", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws, { provider: "codex" });
    await send(base, chat.id, "Codex please");
    const waiting = await waitFor(async () => {
      const s = await waitState(base, chat.id);
      return s.wait ? s : null;
    });
    assert.ok(waiting?.wait, "no waiting state for Codex");
    assert.equal(waiting.wait.provider, "codex");
    assert.equal(waiting.wait.group, "session", "primary = 5-hour window");
    assert.equal(waiting.wait.reason, "reset");
    assert.match(waiting.wait.evidence, /hit your usage limit/i);
    const done = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? l : null;
    }, "", 250);
    assert.ok(done, "Codex run was not continued");
  }, { codex: {}, codexHome: { reachedType: "primary", resetInSeconds: 2 } });
});

// With Codex `resultText` is the MODEL'S TEXT. Limit detection used to read it too — a turn in which the model wrote
// "I'll add a rate limit … 429" and then died of a network error was parked as "limit, reset unknown" and repeated up to
// twelve times. Counter-test: with that reading restored a wait row appears here.
test("a Codex turn whose model text talks about rate limits and which dies of a network error is not parked", async () => {
  await withServer(async ({ base, ws, root }) => {
    const chat = await newChat(base, ws, { provider: "codex" });
    await send(base, chat.id, "Build the login");
    await waitForQuiet(base);
    const s = await waitState(base, chat.id);
    assert.equal(s.wait ?? null, null, `model text parked as limit evidence: ${JSON.stringify(s.wait)}`);
    assert.equal(fs.readFileSync(path.join(root, "codex-runs.txt"), "utf8"), "1", "the turn ran exactly once");
  }, { codex: { modelTextBeforeTod: "I'll add a rate limit to the /login endpoint — the API answers 429 Too Many Requests otherwise." } });
});

test("weekly limit with Codex: the long window wins", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws, { provider: "codex" });
    await send(base, chat.id, "Codex please");
    const waiting = await waitFor(async () => {
      const s = await waitState(base, chat.id);
      return s.wait ? s : null;
    });
    assert.equal(waiting.wait.group, "weekly", "secondary = weekly window");
    assert.match(waiting.wait.limitText, /Wochenlimit|weekly limit/);
  }, { codex: { limitRuns: 5 }, codexHome: { reachedType: "secondary", resetInSeconds: 2 } });
});

test("credits exhausted: no waiting, but a normal error with a reason", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    const line = await waitFor(async () => {
      const l = await log(base, chat.id);
      const hit = l.filter((e) => e.role === "limit").map((e) => JSON.parse(e.text)).find((x) => x.kind === "credits");
      return hit || null;
    });
    assert.ok(line, "credits case was not recognized");
    assert.match(line.text, /Guthaben|credits/i);
    assert.equal((await waitState(base, chat.id)).wait, null, "no waiting state may arise");
  }, { claude: { credits: true, limitRuns: 5 } });
});

test("switched off: limit is noted but not waited for", async () => {
  await withServer(async ({ base, ws }) => {
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    assert.equal((await json(`${base}/api/auto-continue`)).enabled, false);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    const off = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.filter((e) => e.role === "limit").map((e) => JSON.parse(e.text)).find((x) => x.kind === "off") || null;
    });
    assert.ok(off, "notice about the disabled continuation missing");
    assert.equal((await waitState(base, chat.id)).wait, null);
  }, { claude: { limitRuns: 5, resetInSeconds: 2 } });
});

// Parked counts as running. A message of the user's own used to REPLACE the scheduled continuation: the wait row fell away
// together with the parked task, without a prompt — whoever wrote "also do … on the side" to a waiting chat lost the task
// the chat was waiting for. Now the message queues behind the continuation, as it would on a running chat; the wait row
// stays untouched. Only the button discards — and it then starts the queued message instead of leaving it lying.
//
// Counter-test against the old behavior: there the row vanished after the message and `cancel` appeared in the log —
// both may appear here only after the explicit discard.
test("own message queues behind the parked continuation — only the button discards", async () => {
  await withServer(async ({ base, ws, promptLog }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First attempt");
    const wait = await waitFor(async () => (await waitState(base, chat.id)).wait || null);
    const response = await send(base, chat.id, "Differently after all");
    assert.equal(response.queued, true, "the message was not queued");
    assert.equal(response.parked, true, "the response says WHY it was queued (the client shows it)");
    assert.equal(response.queue.length, 1);
    // Quiet instead of half a second: whatever the message would have triggered is through (the queue behind a
    // parked row does not count as open — it is waiting).
    await waitForQuiet(base);
    const still = (await waitState(base, chat.id)).wait;
    assert.ok(still, "the wait row vanished with the own message");
    assert.equal(still.updatedAt, wait.updatedAt, "the wait row was rewritten — it belongs to the parked task");
    const limitKinds = async () => (await log(base, chat.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind);
    assert.equal((await limitKinds()).includes("cancel"), false, "an own message no longer discards anything");
    assert.equal(fs.readFileSync(promptLog, "utf8").split("\n").filter(Boolean).length, 1, "the queued message started next to the wait row");

    // Discard — explicitly, via button. The queued message then waits for nobody anymore and runs as a
    // turn of its own (the fake is free after the first limit run).
    const del = await json(`${base}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
    assert.equal(del.ok, true);
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
    }, "answer of the queued message", 100);
    await waitForQuiet(base);
    assert.ok((await limitKinds()).includes("cancel"), "the discard is not in the log");
    assert.equal((await waitState(base, chat.id)).wait, null);
    const prompts = fs.readFileSync(promptLog, "utf8").split("\n").filter(Boolean);
    assert.equal(prompts.length, 2, `exactly one more turn: ${JSON.stringify(prompts)}`);
    assert.match(prompts[1], /Differently after all/, "the QUEUED message ran, not the discarded task");
    assert.doesNotMatch(prompts[1], /First attempt/);
  }, { claude: { resetInSeconds: 3600 } }); // reset far away → only the button can resolve it
});

test("\"Try now\" starts immediately, \"Cancel\" discards", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    await waitFor(async () => ((await waitState(base, chat.id)).wait ? true : null));
    const now = await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST" });
    assert.equal(now.ok, true);
    const done = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
    }, "", 100);
    assert.ok(done, "manual attempt did not run");

    // Cancel on a second chat
    const other = await newChat(base, ws, { title: "Second" });
    fs.writeFileSync(path.join(path.dirname(process.env.CLAUDE_BIN), "runs.txt"), "0"); // back to the limit
    await send(base, other.id, "Something else too");
    await waitFor(async () => ((await waitState(base, other.id)).wait ? true : null));
    const del = await json(`${base}/api/chats/${other.id}/auto-continue`, { method: "DELETE" });
    assert.equal(del.ok, true);
    assert.equal((await waitState(base, other.id)).wait, null);
  }, { claude: { resetInSeconds: 3600 } });
});

test("restart: the wait row is rescheduled and continues", async () => {
  // Two server lives on the SAME data directory: the first run fails at the limit, the server goes off,
  // the second must pick up the parked work by itself.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-autocont-restart-"));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN, NPX_BIN: process.env.NPX_BIN, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL,
    HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  const stateFile = path.join(root, "runs.txt");
  const promptLog = path.join(root, "prompts.txt");
  const bin = path.join(root, "fake-claude");
  const dataRoot = path.join(root, "data-root");
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    isolateCredentials(root);
    fs.writeFileSync(bin, fakeClaude({ stateFile, promptLog, resetInSeconds: 2 }));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);

    let chatId = "";
    const first = await startServer({ port: 0, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base1 = `http://127.0.0.1:${first.address().port}`;
    const ws = await json(`${base1}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Limit", path: wsPath }) });
    const chat = await newChat(base1, ws);
    chatId = chat.id;
    await send(base1, chatId, "Work across the restart");
    await waitFor(async () => ((await waitState(base1, chatId)).wait ? true : null), "wait row in the first server life");
    await waitForQuiet(base1);   // nothing in flight anymore (title, hooks) — the parked row does not count
    await new Promise((r) => first.close(r)); // server off while the run is parked

    const second = await startServer({ port: 0, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base2 = `http://127.0.0.1:${second.address().port}`;
    let through = false;   // the body of the second life ran through without throwing (see finally)
    try {
      const state = await waitState(base2, chatId);
      assert.ok(state.wait, "waiting state did not survive the restart");
      const done = await waitFor(async () => {
        const l = await log(base2, chatId);
        return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
      }, "continuation after the restart", 250);
      assert.ok(done, "parked work was not continued after the restart");
      through = true;
    } finally {
      if (through) await waitForQuiet(base2);
      await new Promise((r) => second.close(r));
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    discardTempRoot(root);
  }
});

// A report is data, not an error. The server used to search the REPORT of the own subagent for the limit wording — the
// substitute for agent-runtime reporting a subagent that died at the limit as "completed". The search took ordinary
// technical text ("I set the rate limit to 100 req/s") for a hit: a cleanly finished run was parked and repeated at the
// reset. Now a subagent that died comes back as an ERROR (next test); a report without an error mark parks nothing,
// even if the wording is in it.
//
// Counter-test against the old behavior: there a wait row with reason "reset" arose here, and the task ran a second time
// after two seconds.
test("subagent report with limit wording but without an error mark: data — the run is NOT parked", async () => {
  await withServer(async ({ base, ws, promptLog }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please work with subagents");
    const done = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.includes("Subagent")) ? l : null;
    });
    assert.ok(done, "answer of the main agent missing");
    // Quiet instead of 2.5 s "longer than the reset in the fake": parking would be decided at the run end, BEFORE quiet — a
    // wait row or limit row would already be there (and the repetition would only come from it).
    await waitForQuiet(base);
    assert.equal((await waitState(base, chat.id)).wait, null, "a report without an error mark parked the run");
    assert.deepEqual((await log(base, chat.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind), [], "and wrote a limit row");
    const prompts = fs.readFileSync(promptLog, "utf8").trim().split("\n");
    assert.equal(prompts.length, 1, `the task ran more than once: ${JSON.stringify(prompts)}`);
  }, { claude: { resetInSeconds: 2, subagentLimit: true } });
});

// No double parking. The error report of the OWN subagent (`mcp__cbase__cbase_agent`, `is_error`) used to count as limit
// evidence of the parent run: the run ended with code 0, parked anyway and ran as a WHOLE turn once more at the reset. Now
// such an agent parks ITSELF at the limit (runs/agents.js, agent-limit-parking.test.js) — if its report still comes back as
// an error, it deliberately did not park (auto-continue off, credits, reset too far), and the main agent learns it from
// the report.
//
// Counter-test against the old behavior (shown red once): `subagentUses` back in the evidence branch of runs/do-run.js ⇒ a
// run wait row with reason "reset", and the task runs a second time after the reset.
async function noDoubleParking({ base, ws, promptLog }) {
  const chat = await newChat(base, ws);
  await send(base, chat.id, "Please work with subagents");
  await waitFor(async () => {
    const l = await log(base, chat.id);
    return l.some((e) => e.role === "assistant" && e.text.includes("Subagent")) ? l : null;
  }, "answer of the main agent");
  await waitForQuiet(base);
  assert.equal((await waitState(base, chat.id)).wait, null, "the error report of an own subagent parked the parent run");
  assert.deepEqual((await log(base, chat.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind), [], "and wrote a limit row");
  const prompts = fs.readFileSync(promptLog, "utf8").trim().split("\n");
  assert.equal(prompts.length, 1, `the task ran more than once: ${JSON.stringify(prompts)}`);
}

test("subagent (cbase_agent) at the limit: its error report does NOT park the parent run (the agent parks itself)", async () => {
  await withServer(noDoubleParking, { claude: { resetInSeconds: 2, subagentLimit: "cbase-error" } });
});

// The built-in kind (Claude's `Task`/`Agent` with `is_error`) used to be tested here: its error report was limit evidence of
// the parent run. Claude's Agent/Task is now locked in EVERY run (CLAUDE_LOCK_DEFAULT) — the CLI can no longer make that
// call, the branch in runs/do-run.js is gone with it, and so is the test (it tested a path that no longer exists). The loop
// engine's `Task` goes to the core and parks there itself (agent-limit-parking.test.js).

// The COLLECTED report: a background agent reports its failure not at the `cbase_agent` call but only via
// `cbase_agent_output`/`_send`. This error report is no longer limit evidence of the parent run either — the agent parks
// itself at the limit.
test("subagent report COLLECTED (cbase_agent_output) at the limit: does NOT park the parent run either", async () => {
  await withServer(noDoubleParking, { claude: { resetInSeconds: 2, subagentLimit: "collected" } });
});

// A run that ends cleanly and mentions a limit ONLY in passing must trigger nothing —
// otherwise every Bash output with "rate limit" would park a chat for hours.
test("no reset time, no exhausted window: a clean run is not parked", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please work with subagents");
    const done = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.includes("Subagent")) ? l : null;
    });
    assert.ok(done, "answer of the main agent missing");
    await waitForQuiet(base);
    assert.equal((await waitState(base, chat.id)).wait, null, "without a proven reset there must be no waiting");
  }, { claude: { resetInSeconds: null, subagentLimit: true, limitRuns: 99 } });
});

// ── The provider switches the model itself ───────────────────────────────────
// At the Fable limit the CLI continues on another model by itself and bills against the credits from then on. This is NOT
// prevented (two layers doing the same would be worse than one) — but it must not stay secret either. The wording is read
// from the binary of the installed CLI, not invented.
test("model switch by the CLI: one line in the log — exactly one, and no waiting state", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    const row = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.filter((e) => e.role === "limit").map((e) => JSON.parse(e.text)).find((x) => x.kind === "model_switch") || null;
    });
    assert.equal(row.model, "Opus 5", `the target model is not in the row: ${JSON.stringify(row)}`);
    assert.equal(row.limitName, "Fable");
    assert.match(row.text, /gewechselt|switched/);
    assert.match(row.set, /continuing on/, "the CLI wording belongs in the row — otherwise the claim cannot be verified");

    await waitForQuiet(base);
    const all = (await log(base, chat.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text)).filter((x) => x.kind === "model_switch");
    assert.equal(all.length, 1, `the CLI repeats its sentence in the result — it must still appear only ONCE in the log (${all.length})`);
    // A model switch is NOT a limit hit: the run is done, there is nothing to wait for.
    assert.equal((await waitState(base, chat.id)).wait, null, "a continuing turn must not create a waiting state");
    assert.ok((await log(base, chat.id)).some((e) => e.role === "assistant" && e.text.includes("FINISHED")), "the answer of the run is missing");
  }, { claude: { limitRuns: 0, switchSet: "Fable limit reached · continuing on Opus 5 uses usage credits, which are billed separately." } });
});

// The goal gate is a derived model call AFTER a successful run. If it failed at the limit, the goal used to count silently
// as "unchecked": no verdict, no continuation, no trace.
test("goal verdict at the limit: the gate is parked and caught up", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws);
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Finish the job" }) });
    await send(base, chat.id, "First message");

    const waiting = await waitFor(async () => {
      const s = await waitState(base, chat.id);
      return s.wait ? s : null;
    });
    assert.ok(waiting?.wait, "the goal gate was not parked");
    assert.equal(waiting.wait.kind, "judge");

    // The run itself is through — only the verdict is parked.
    const l = await log(base, chat.id);
    assert.ok(l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")), "the answer of the run is missing");
    assert.ok(!l.some((e) => e.role === "goal"), "before the reset there must be no verdict");

    // After the reset the gate judges later — "achieved" ⇒ row in the log, goal cleared.
    const judged = await waitFor(async () => {
      const rows = await log(base, chat.id);
      return rows.find((e) => e.role === "goal") || null;
    }, "", 250);
    assert.ok(judged, "the goal verdict was not caught up");
    assert.equal(JSON.parse(judged.text).achieved, true);
    assert.ok(await waitResolved(base, chat.id), "the waiting state stayed after the goal verdict");
    assert.equal((await json(`${base}/api/chats/${chat.id}`)).goal || "", "", "an achieved goal must be cleared");
  }, { claude: { resetInSeconds: 2, limitRuns: 0, goalLimit: 1 } });
});

// Compacting is a model call like any other — only without a run that could be repeated. At the limit the COMPACTION is
// therefore parked and caught up; the log stays intact.
test("compacting at the limit: is parked and caught up after the reset", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First message for the log");
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? l : null;
    }, "first answer");
    await waitForQuiet(base);

    // 1) Compaction fails at the limit — as a waiting state, not as an error.
    const out = await json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
    assert.equal(out.ok, false);
    assert.equal(out.limited, true, "a limit while compacting must come back as a waiting state");

    const waiting = await waitFor(async () => {
      const s = await waitState(base, chat.id);
      return s.wait ? s : null;
    });
    assert.equal(waiting.wait.kind, "compact", "the wait row must refer to the compaction");

    // 2) The log is untouched: no summary, no compaction marker.
    const before = await json(`${base}/api/chats/${chat.id}`);
    assert.ok(!before.contextSummary, "the log must not be touched on failure");

    // 3) After the reset it is caught up by itself.
    const compacted = await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "meta" && (() => { try { return JSON.parse(e.text).compacted; } catch { return false; } })()) ? l : null;
    }, "", 250);
    assert.ok(compacted, "the compaction was not caught up");
    assert.ok(await waitResolved(base, chat.id), "the waiting state must be resolved afterwards");
    const after = await json(`${base}/api/chats/${chat.id}`);
    assert.match(after.contextSummary || "", /SUMMARY/);
  }, { claude: { resetInSeconds: 2, limitRuns: 0, compactLimit: 1 } });
});
