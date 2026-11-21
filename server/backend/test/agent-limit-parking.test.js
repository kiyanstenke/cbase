// Limit parking per agent.
//
// Before, not the subagent parked but the whole parent run: the failed report became the limit evidence of the HELD run, the
// run parked at its end and was repeated as a WHOLE turn at the reset. Now the agent parks itself — in the owner per chat
// (runs/agents.js agentLimitChoice, providers/agent-runtime.js park/further) —, the chat gets no wait row, and after the reset
// the agent continues its session and reports.
//
// Measured at the main seam (agent-harness.mjs): real server, real MCP server, fake providers — for each way in which cbase
// parks a run at the limit (Claude, Codex, loop engine). Events are waited for ("report there"), never a clock; the wait until
// the continuation is set by the gate deadlines (CBASE_LIMIT_GRACE_MS/_MIN_WAIT_MS).
//
// The park state is observed without a clock: the reset lies an hour away, and the test wakes it itself (`wakeParkedNow`,
// runs/agents.js). An earlier version parked 1 s and polled in turn — under gate load the look missed the window, and the test
// reported "never parked" for an agent that had parked.
//
// Counter-tests (each shown red once): `atLimit` in runs/agents.js set to null => the agents end as "failed", five of the six
// tests are red, none hangs; the continuation in `further` without its `.catch` => the safety-net test is red. Double parking is
// held by auto-continue.test.js ("… does NOT park the parent run any more").
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { liveAgents, parkWakeupCount, wakeParkedNow } from "../electron/server/runs/agents.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";

// ── The fakes ────────────────────────────────────────────────────────────────────────────────────
// On the task the main agent starts the agents from `<LOCATION>/job.json` in the background and ends; every turn that is a
// completion notice (its own run, `<task-notification>`) writes it back ("Delivered: …"). The Claude subagent fails at the
// limit on the first call (CLI wording, reset in `<LOCATION>/reset-seconds`), on the second it reports — and says whether it was
// continued (session + continuation input).
const fakeClaudeWithLimit = fakeClaude({
  sub: `
    const counter = path.join(LOCATION, "sub-claude");
    let n = 0;
    try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
    fs.writeFileSync(counter, String(n + 1));
    if (n === 0) {
      let s = 1;
      try { s = Number(fs.readFileSync(path.join(LOCATION, "reset-seconds"), "utf8")) || 1; } catch {}
      say({ type: "system", subtype: "init", session_id: "sub-limit-session" });
      process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + s * 1000).toISOString() + "\\n");
      setTimeout(() => process.exit(1), 30);
      return;
    }
    const resumed = arg("--resume") === "sub-limit-session" && text.includes("usage limit has been reset");
    say({ type: "assistant", message: { id: "sub-2", content: [{ type: "text", text: "Claude finding after reset" }] } });
    finished();
    say({ type: "result", result: "Claude finding after reset | resumed=" + resumed, session_id: "sub-limit-session" });`,
  main: `
    if (!text.startsWith("<task-notification>")) {
      const jobs = JSON.parse(fs.readFileSync(path.join(LOCATION, "job.json"), "utf8"));
      let i = 0;
      for (const a of jobs) {
        const id = "toolu_bg_" + (++i);
        const input = { description: a.description, prompt: "Look.", run_in_background: true, ...(a.model ? { model: a.model } : {}) };
        say({ type: "assistant", message: { id: "main-" + i, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input }] } });
        let t = "";
        try { t = textOf(await mcpCall("cbase_agent", input)); } catch (e) { t = "FEHLER " + e.message; }
        say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
      }
      say({ type: "assistant", message: { id: "main-x", content: [{ type: "text", text: "Agents started" }] } });
      finished();
      say({ type: "result", result: "Agents started", session_id: "main-session" });
      return;
    }
    say({ type: "system", subtype: "init", session_id: "main-session" });
    say({ type: "assistant", message: { id: "main-t" + turn, content: [{ type: "text", text: "Delivered: " + text.replace(/\\s+/g, " ").slice(0, 6000) }] } });
    finished();
    say({ type: "result", result: "ok", session_id: "main-session" });`,
});

// Codex fails at the limit on the first call (CLI wording, relative reset from `<LOCATION>/codex-reset-seconds`, default 1 s — its
// own file, because "Per provider separately" lets Claude park long and Codex short), then reports over `resume`.
const fakeCodexWithLimit = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const counter = path.join(LOCATION, "sub-codex");
let n = 0;
try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
fs.writeFileSync(counter, String(n + 1));
const ri = argv.indexOf("resume");
say({ type: "thread.started", thread_id: ri >= 0 ? argv[ri + 1] : "codex-limit-thread" });
say({ type: "turn.started" });
if (n === 0 && fs.existsSync(path.join(LOCATION, "codex-limit"))) {
  let s = 1;
  try { s = Number(fs.readFileSync(path.join(LOCATION, "codex-reset-seconds"), "utf8")) || 1; } catch {}
  say({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in " + s + "s." } });
  setTimeout(() => process.exit(1), 30);
} else {
  say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "Codex finding after reset" + (ri >= 0 ? " (resume " + argv[ri + 1] + ")" : "") } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
}
`;

// The loop engine: the first time a 429 with the wording "Usage limit reached · resets at …", then the finding.
let engineCalls = 0;
let engineResetSec = 1;
const engineWithLimit = {
  round: () => (++engineCalls === 1
    ? { status: 429, body: { error: { message: `Usage limit reached · resets at ${new Date(Date.now() + engineResetSec * 1_000).toISOString()}`, type: "rate_limit_error" } } }
    : { text: "Engine finding after reset" }),
};

// The limit windows would otherwise come from the developer's REAL account (Anthropic usage endpoint, ~/.codex) — the test would
// depend on the balance and wait for hours at a really exhausted window. As in auto-continue.test.js: empty HOME and CODEX_HOME,
// a `security` that finds nothing (macOS keychain), no OAuth token. Then the reset from the wording applies.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-limit-account-"));
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleanup of ${root}: ${e.code || e.message}`); }
  }
}

const job = (root, list) => fs.writeFileSync(path.join(root, "job.json"), JSON.stringify(list));
// Over ALL open cores of the chat: a completion notice opens a new turn with a core that takes over ownership — a parked agent
// lives on in its old core, `agentsOf` alone would not see it depending on the timing.
const rows = (chatId) => liveAgents().filter((z) => z.chatId === chatId);
const delivered = (log) => log.filter((m) => m.role === "assistant" && m.text.startsWith("Delivered:")).map((m) => m.text).join("\n");
const waitRow = async (base, chatId) => (await json(`${base}/api/chats/${chatId}/auto-continue`)).wait;
const limitRows = (log) => log.filter((m) => m.role === "limit");

// Waits until `finished(log)` holds, and notes every agent that ever stood there as "parked" (with reset time).
// Without a clock: the park state lasts at least the minimum wait (gate: 2 s), the look at it costs microseconds.
async function observe(ctx, finished) {
  const parked = new Map();
  const log = await ctx.waitForTruthy(async () => {
    for (const z of rows(ctx.chat.id)) if (z.status === "parked") parked.set(z.provider, z);
    const l = await json(`${ctx.base}/api/chats/${ctx.chat.id}/log`);
    return finished(l) ? l : null;
  }, "reports");
  return { parked, log };
}

test("A Claude subagent at the limit parks ITSELF — no wait row in the chat — and continues its session after the reset", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    job(root, [{ description: "Claude part" }]);
    // One hour: the park state stands until the test dissolves it itself (wakeParkedNow) — no clock decides whether the look falls
    // into the park window (with a 1 s reset it missed under gate load: "never parked").
    fs.writeFileSync(path.join(root, "reset-seconds"), "3600");
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Work with agents" }) });

    // The agent stands parked in the owner — with reset time; the chat has NO wait row.
    // We wait for "parked OR report already there" — the old state (agent ends "failed") turns red that way instead of hanging.
    const z = await ctx.waitForTruthy(async () => rows(chat.id).find((x) => x.status === "parked")
      || (delivered(await json(`${base}/api/chats/${chat.id}/log`)) ? { status: "never parked" } : null), "parked or report");
    assert.equal(z.status, "parked", "the agent did not park at the limit");
    assert.ok(z.parkedUntil > Date.now() - 60_000, `parked with continuation time: ${JSON.stringify(z)}`);
    assert.ok(z.resetsAt > 0, `with reset time: ${JSON.stringify(z)}`);
    assert.equal(await waitRow(base, chat.id), null, "the pause belongs to the agent, not to the chat");
    // A parked agent is open background work — busy and the field see it.
    const active = await json(`${base}/api/runs/active`);
    assert.equal(active.busy, true);
    assert.ok(active.agents.some((a) => a.agentId === z.agentId), `the parked agent in the query of open background work: ${JSON.stringify(active.agents)}`);

    // After the reset (here: woken): continued (session + continuation input) and reports — delivered to the main
    // agent.
    assert.equal(wakeParkedNow(), 1, "exactly one park alarm stood");
    const { log } = await observe(ctx, (l) => delivered(l).includes('Agent "Claude part" completed'));
    assert.match(delivered(log), /Claude finding after reset/);
    const text = delivered(log);
    assert.match(text, /resumed=true/, text);
    assert.match(text, /<status>completed<\/status>/, text);
    await ctx.waitForIdle();
    const after = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(limitRows(after), [], "no limit row in the history — the run did not park");
    assert.equal(await waitRow(base, chat.id), null);
    assert.equal(parkWakeupCount(), 0, "the alarm is used up");
  }, { claude: fakeClaudeWithLimit }));
});

test("A Codex and an engine subagent at the limit park likewise and report after the reset", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root, engine } = ctx;
    job(root, [{ description: "Codex part", model: "codex::gpt-5.1-codex" }, { description: "Engine part", model: engine.model }]);
    fs.writeFileSync(path.join(root, "codex-limit"), "1");
    fs.writeFileSync(path.join(root, "codex-reset-seconds"), "3600"); // as above: park until the test wakes it
    engineResetSec = 3600;
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Work with agents" }) });
    // Both parked — OR a report already there (the old state delivers "failed" and turns red that way instead of hanging).
    const state = await ctx.waitForTruthy(async () => {
      const parked = new Set(rows(chat.id).filter((z) => z.status === "parked").map((z) => z.provider));
      if (parked.has("codex") && parked.has(engine.id)) return [...parked].sort();
      return /Agent "(Codex|Engine) part"/.test(delivered(await json(`${base}/api/chats/${chat.id}/log`))) ? ["never both parked"] : null;
    }, "both parked or report");
    assert.deepEqual(state, ["codex", engine.id].sort(), "both stood parked");
    assert.equal(wakeParkedNow(), 2, "two park alarms stood");
    const { log } = await observe(ctx, (l) => {
      const t = delivered(l);
      return t.includes('Agent "Codex part" completed') && t.includes('Agent "Engine part" completed');
    });
    assert.match(delivered(log), /Codex finding after reset/);
    assert.match(delivered(log), /Engine finding after reset/);
    assert.match(delivered(log), /Codex finding after reset \(resume codex-limit-thread\)/, "Codex continues its thread");
    await ctx.waitForIdle();
    assert.deepEqual(limitRows(await json(`${base}/api/chats/${chat.id}/log`)), []);
    assert.equal(await waitRow(base, chat.id), null);
  }, { claude: fakeClaudeWithLimit, codex: fakeCodexWithLimit, engine: engineWithLimit }));
});

test("Per provider separately: a parked Claude agent does not hold the Codex agent of the same chat — and the stop takes it along with its alarm", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    job(root, [{ description: "Claude part" }, { description: "Codex part", model: "codex::gpt-5.1-codex" }]);
    fs.writeFileSync(path.join(root, "reset-seconds"), "3600"); // parks an hour — the test never waits for it
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Work with agents" }) });
    const log = await ctx.waitForLog(chat.id, (l) => delivered(l).includes("Codex finding after reset"));
    const claude = rows(chat.id).find((z) => z.provider === "claude");
    assert.equal(claude?.status, "parked", `the Claude agent still stands parked: ${JSON.stringify(rows(chat.id))}`);
    assert.ok(!delivered(log).includes("Claude finding"));
    assert.equal(parkWakeupCount(), 1);

    // "Stop all": there is no holding turn any more — the chat stop does not reach an agent without a turn, "stop all" does; the
    // parked agent ends, the alarm is gone.
    await json(`${base}/api/chats/${chat.id}/agents/stop`, { method: "POST", body: JSON.stringify({ from: "human" }) });
    await ctx.waitForIdle();
    assert.equal(parkWakeupCount(), 0, "the reset alarm is gone with the stop");
    assert.ok(rows(chat.id).every((z) => z.status !== "parked" && z.status !== "running"), JSON.stringify(rows(chat.id)));
    assert.deepEqual((await json(`${base}/api/runs/active`)).agents, []);
    assert.equal(await waitRow(base, chat.id), null);
  }, { claude: fakeClaudeWithLimit, codex: fakeCodexWithLimit }));
});

test("Auto-continue off: the agent ends as failed, with the limit reason in the report — the main agent learns it", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    job(root, [{ description: "Claude part" }]);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Work with agents" }) });
    const { parked, log } = await observe(ctx, (l) => delivered(l).includes("<status>failed</status>"));
    assert.equal(parked.size, 0, "without auto-continue no agent parks");
    const text = delivered(log);
    assert.match(text, /usage limit reached/i, text);
    assert.match(text, /automatisches Fortsetzen ist ausgeschaltet|auto-continue is switched off/, text);
    await ctx.waitForIdle();
    assert.equal(await waitRow(base, chat.id), null, "and the run does not park either");
    assert.equal(fs.readFileSync(path.join(root, "sub-claude"), "utf8"), "1", "no second attempt");
  }, { claude: fakeClaudeWithLimit }));
});

test("Deleting the chat ends a parked agent together with its alarm — also after the end of its turn", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    job(root, [{ description: "Claude part" }]);
    fs.writeFileSync(path.join(root, "reset-seconds"), "3600");
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Work with agents" }) });
    // Turn over (the main agent has answered) and the agent parked — OR already gone (old state: "failed").
    const afterTurn = await ctx.waitForTruthy(async () => {
      const r = await json(`${base}/api/runs/active`);
      if (r.runs !== 0) return null;
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      if (!l.some((m) => m.role === "assistant" && m.text === "Agents started")) return null;
      const z = rows(chat.id);
      return z.some((x) => x.status === "parked") || !z.length ? r : null;
    }, "turn over, agent parked");
    assert.ok(rows(chat.id).some((x) => x.status === "parked"), "the agent did not park at the limit");
    assert.equal(afterTurn.busy, true, "a parked agent is open background work");
    assert.equal(afterTurn.agents.length, 1);
    assert.equal(parkWakeupCount(), 1);

    const res = await fetch(`${base}/api/chats/${chat.id}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(res.status, 200, await res.text());
    assert.equal(parkWakeupCount(), 0, "the alarm is gone with the chat");
    assert.deepEqual((await json(`${base}/api/runs/active`)).agents, []);
  }, { claude: fakeClaudeWithLimit }));
});

// ── The safety net of the continuation, at the core itself ──────────────────────────────────────
test("Continuation with safety net: a preparation that throws after the reset becomes a failed report with a row — no process end", async () => {
  let specs = 0;
  const rowsInChat = [];
  let finished;
  const end = new Promise((r) => { finished = r; });
  const rt = createAgentRuntime({
    chatId: "c1",
    cwd: process.cwd(),
    parentProvider: "claude",
    resolveRef: () => ({ connector: {}, providerId: "claude", model: "" }),
    buildSpec: () => {
      if (++specs > 1) throw new Error("MCP configuration not writable");
      return {};
    },
    runChat: async () => ({ code: 1, stderr: "Claude usage limit reached · resets in 1s", sessionId: "s1" }),
    atLimit: async (a, errorText) => (/usage limit/.test(errorText) ? { dueAt: Date.now(), resetsAt: Date.now() } : null),
    wakeup: (ms, fn) => { const t = setImmediate(fn); return () => clearImmediate(t); },
    atResumptionError: (a, reason) => rowsInChat.push(reason),
    onFinish: (rec, info) => finished(info.report),
  });
  const first = await rt.start({ prompt: "Do something", run_in_background: true });
  assert.equal(first.status, "running");
  const report = await end;
  assert.equal(specs, 2, "the continuation tried the preparation");
  assert.equal(report.status, "failed");
  assert.match(report.error, /MCP configuration not writable/);
  assert.equal(rowsInChat.length, 1, "one row in the chat");
  assert.match(rowsInChat[0], /MCP configuration not writable/);
  rt.close();
});
