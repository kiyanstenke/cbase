// The credit gate on EVERY delivery path — and the four switch combinations.
//
// The tests in credit-gate.test.js all take the same path: a new coding chat, a typed message via /message. The comment
// at doRun lists schedule, event, pipeline, channel and auto-resume as covered — without any test ever having entered one
// of them. Here each test takes a DIFFERENT path to the same gate, plus the four combinations of switch A ("Continue
// automatically at the limit") and switch B ("Start no new turn from 99 %"), which were previously measured only
// scattered and only at the composer. No turn of a manager chat begins any more (runs/manager-lock.js): the schedule,
// administrator and pipeline paths are gone, the channel runs coding ↔ coding.
//
// ── The usage endpoint is SIMULATED here, not seeded ──────────────────────────────────────
// credit-gate.test.js seeds the persisted utilisation cache (usage_cache_v1) and lets the live fetch fail. That suffices
// there because no test needs a RESET: the window stands at 100 % for the whole file. Here the window must become free
// again — "it runs after the reset" is half of every promise. The cache in the server is module-wide, though, and is
// read from the database only at the process's first fetch; a second seed would be seen by no server of this process.
// So `globalThis.fetch` sits behind a switch: requests to https://api.anthropic.com/api/oauth/usage are answered by the
// test itself, from `usageState`, at answer time; everything else (the test's own calls against the server) passes
// through. The server runs its REAL path — token from CLAUDE_CODE_OAUTH_TOKEN, fetchUsageLimits, claudeWindows,
// 60-s cache —, only the provider is simulated, just as the fake CLI simulates the provider.
//
// Two deadlines that come from the server and shape this file:
//   · fetchUsageLimits keeps the value for 60 s (the gate reads with force: false), and the cache is module-wide — it
//     survives every server of this file. A reset reaches the gate only when someone reads FORCED, and only the automatic
//     continuation does that (fireAutoContinueInner → limitWindowsFor with force: true). So EXACTLY ONE test has the
//     reset, the last, and it checks all paths at once: every test after it would see a free window for up to 60 s and
//     park nothing.
//   · The wake timer of the wait row is a setTimeout on `dueAt` (reset + grace); the sweeper runs every 60 s and cannot
//     be set. The provider therefore ALWAYS reports the reset six seconds ahead: a parked row becomes due after a few
//     seconds, the continuation reads forced, sees the window still full and only reschedules — attempt counter
//     untouched, reason stays "credit", the row stays the same (createdAt). So the 60-s cache stays fresh across the
//     whole file, and in the last test exactly this wake timer carries the reset: the test sets the state to 10 %, the
//     next wake timer runs the turn. An hour ahead (as in credit-gate.test.js) would not work here: the process's first
//     reading would then stand for 60 s in every following test, and the row of the reset test would not be due for an
//     hour. What that means for the checks: a row is rescheduled between two readings (dueAt, updatedAt), so the tests
//     compare `createdAt` and `prompt`, never `updatedAt`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { MAX_CONTINUES } from "../electron/server/limits.js";
import { restartGraceCycles, startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { doRun } from "../electron/server/runs/do-run.js";
import { releaseTurn } from "../electron/server/runs/instance.js";
import { running, stopRun } from "../electron/server/runs/state.js";
import { waitForQuiet } from "./quiet.mjs";

// The shortened limit deadlines (grace, minimum wait): the check gate sets them in check.mjs; called alone,
// 45 s of wall clock per case would apply otherwise. Only the default — an environment already set wins.
process.env.CBASE_LIMIT_GRACE_MS ||= "2000";
process.env.CBASE_LIMIT_MIN_WAIT_MS ||= "2000";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an event — WITHOUT a deadline (no timers in tests: the suite deadline is the emergency brake). Every 30 s
// a line on stderr so a hang says what it waits for. The end of the work is measured by waitForQuiet (quiet.mjs).
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

// ── The provider: Anthropic's usage endpoint, simulated from the test ───────────
// `percent` is the session window (5 h), `resetInMs` the distance of the reported reset from the
// ANSWER TIME — the shape of /api/oauth/usage (five_hour/seven_day/limits[]/extra_usage) from which
// claudeWindows builds the windows. `retrievals` counts along so a test can prove the server
// really read here.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// `begun` counts the START of a fetch, `retrievals` its answer — with `hold` (one-off, for the next
// fetch: a gate, see usageHold) the spot where a test intervenes "in the middle of the fetch" lies in between.
const usageState = { percent: 100, resetInMs: 6_000, retrievals: 0, begun: 0, hold: null, open: null };
// Holds the NEXT fetch until the test opens the gate — a gate instead of a duration: a delay
// of 2.5 s is not safely longer than the test's way to its intervention under load. Returns the opener.
function usageHold() {
  usageState.hold = new Promise((r) => { usageState.open = r; });
  return usageState.open;
}
function usageResponse() {
  usageState.retrievals += 1;
  const resetsAt = new Date(Date.now() + usageState.resetInMs).toISOString();
  const body = {
    five_hour: { utilization: usageState.percent, resets_at: resetsAt },
    seven_day: { utilization: 4, resets_at: null },
    limits: [
      { kind: "session", group: "session", percent: usageState.percent, resets_at: resetsAt },
      { kind: "weekly", group: "weekly", percent: 4, resets_at: null },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: "USD", disabled_reason: "" },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url === USAGE_URL) {
    usageState.begun += 1;
    const h = usageState.hold;
    usageState.hold = null;
    return h ? h.then(usageResponse) : Promise.resolve(usageResponse());
  }
  return realFetch(input, init);
};

// Fake Claude: every turn is LOGGED and answered. The log is the main measurement
// — "parked instead of started" means: the CLI was not called at all. 2000 characters per turn,
// because channel and event prompts begin with a preamble and the job stands only after it.
const fakeClaude = (turnLog) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
if (!process.argv.slice(2).includes("--input-format")) {   // Oneshot (Auto-Titel)
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ result: "Title" })); process.exit(0); });
} else {
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    let msg; try { msg = JSON.parse(l); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    try { fs.appendFileSync(${JSON.stringify(turnLog)}, text.replace(/\\s+/g, " ").slice(0, 2000) + "\\n"); } catch {}
    setTimeout(() => {
      const out = "FINISHED " + text.replace(/\\s+/g, " ").slice(0, 60);
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "gate-ways" });
    }, 20);
  });
}
`;
// Fake Codex: the same log with a prefix — Codex is not gated and is here the
// way to bring a turn to its end.
const fakeCodex = (turnLog) => `#!/usr/bin/env node
const fs = require("node:fs");
const say = (o) => console.log(JSON.stringify(o));
const args = process.argv.slice(2);
const prompt = args[args.length - 1] || "";
if (!args.includes("--json")) { // Oneshot-Pendant: -o <datei>
  const i = args.indexOf("-o");
  if (i >= 0 && args[i + 1]) { try { fs.writeFileSync(args[i + 1], "Title"); } catch {} }
  process.exit(0);
}
try { fs.appendFileSync(${JSON.stringify(turnLog)}, "codex: " + String(prompt).replace(/\\s+/g, " ").slice(0, 100) + "\\n"); } catch {}
say({ type: "thread.started", thread_id: "codex-gate-ways-1" });
say({ type: "turn.started" });
say({ type: "item.completed", item: { type: "agent_message", text: "FINISHED " + String(prompt).slice(0, 60) } });
say({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
setTimeout(() => process.exit(0), 20);
`;

// Keep keychain and credentials file out of the test (empty HOME, a `security` that finds
// nothing) — otherwise the server would query the developer's real account. The token comes
// from the environment instead, the third source of claudeUsageCredential; with it the
// server makes the live fetch, and that lands in the switch above.
function isolateCredentials(root) {
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  const security = path.join(binDir, "security");
  fs.writeFileSync(security, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(security, 0o755);
  // `npx` as a no-op (as in wait-row-lifecycle.test.js): each server loads the Playwright MCP into the npx cache
  // of the redirected HOME at start — over the network, up to 300 s (toolchain/playwright.js), and the grandchild
  // keeps the test process open that long. No test here needs the browser.
  const npx = path.join(binDir, "npx");
  fs.writeFileSync(npx, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(npx, 0o755);
  process.env.NPX_BIN = npx;
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "cbase-test-token";
}

async function withServer(fn, { codex = false, resetInMs = 6_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-ways-"));
  const KEYS = ["CLAUDE_BIN", "CODEX_BIN", "NPX_BIN", "CBASE_TRIGGER_POLL", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN",
    "CBASE_SCHEDULE_TICK_MS", "CBASE_DEPOSIT_TICK_MS", "CBASE_ADMINISTRATOR_TICK_MS"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const turnLog = path.join(root, "turns.txt");
  const dataRoot = path.join(root, "data-root");
  const webDir = path.join(root, "web");
  const ctx = { server: null, base: "" };
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    usageState.percent = 100;
    usageState.resetInMs = resetInMs;
    process.env.CBASE_TRIGGER_POLL = "0";
    // The three ticks (schedule, deposit, administrator) must not fire on their own here: every
    // path is entered explicitly. One hour suffices for any file run time.
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000";
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";
    process.env.CBASE_ADMINISTRATOR_TICK_MS = "3600000";
    isolateCredentials(root);
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude(turnLog));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    if (codex) {
      const cbin = path.join(root, "fake-codex");
      fs.writeFileSync(cbin, fakeCodex(turnLog));
      fs.chmodSync(cbin, 0o755);
      process.env.CODEX_BIN = cbin;
    }
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    ctx.server = await startServer({ port: 0, dataRoot, webDir, pickDirectory: null, notify: null });
    ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
    const ws = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "gate-ways", path: wsPath }) });
    // Second server life on the SAME data directory — the restart path (resumeInterruptedWork,
    // 2.5 s after start). Returns the new address; the cleanup below closes the
    // last server each time.
    const restart = async () => {
      await waitForQuiet(ctx.base);
      await new Promise((r) => ctx.server.close(r));
      ctx.server = await startServer({ port: 0, dataRoot, webDir, pickDirectory: null, notify: null });
      ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
      return ctx.base;
    };
    await fn({
      base: ctx.base, ws, root, restart,
      turns: () => { try { return fs.readFileSync(turnLog, "utf8").split("\n").filter(Boolean); } catch { return []; } },
      usage: (fields) => Object.assign(usageState, fields),
    });
    finished = true;
  } finally {
    // A held provider fetch (gate switched off while the wake timer reads) must not hold up the cleanup.
    usageState.hold = null;
    usageState.open?.();
    // Wait for quiet only if the body passed (model: agent-harness.mjs) — after a failure a hanging run would
    // otherwise stand without a deadline, and the error above would never arrive.
    if (ctx.base && finished) await waitForQuiet(ctx.base);
    if (ctx.server) await new Promise((r) => ctx.server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A failure while cleaning up says something about the cleanup, not about the product.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// The title follows via PATCH: POST /api/chats assigns the placeholder, and the prompts of the
// event paths (channel) name the chat — that is how the test recognises them.
async function newChat(base, ws, { provider = "claude", title = "gate-chat" } = {}) {
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
const limitKinds = async (base, id) =>
  (await log(base, id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind);
const gateOn = (base, on = true) => json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const autoOn = (base, on = true) => json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: on }) });
const dismiss = (base, id) => json(`${base}/api/chats/${id}/auto-continue`, { method: "DELETE" });
// The gate wait row of this chat — visible only once doRun has removed the chat (for a
// running chat autoContinueView is silent).
const parked = (base, id) => waitFor(async () => {
  const w = (await waitState(base, id)).wait;
  return w && w.reason === "credit" ? w : null;
}, `gate wait row of ${id}`);
// The fake's answer is in the history — the turn has run.
const finished = (base, id, what = "") => waitFor(async () => {
  const l = await log(base, id);
  return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
}, `answer in ${id}${what ? ` (${what})` : ""}`, 100);
const entryIn = async (base, chatId) => (await json(`${base}/api/active-runs`)).items.find((i) => i.chatId === chatId) || null;

// ── Channel ────────────────────────────────────────────────────────────────────────────────
// The delivery of a channel message to the coding chat is a turn with a cause of its own ("channel",
// silent — the card is the message). It comes from a sender that is not itself running (a second coding chat);
// the gate therefore hits the RECIPIENT, and the card with its cursor stands anyway.
test("Channel: the delivery to the coding chat parks at the gate — card and cursor stand, the sender stays unwoken", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const sender = await newChat(base, ws, { title: "Job checkout" });
    const coding = await newChat(base, ws, { title: "Rebuild checkout" });
    const channel = await json(`${base}/api/workspaces/${ws.id}/channels`, {
      method: "POST", body: JSON.stringify({ name: "checkout-rebuild", participants: [sender.id, coding.id] }),
    });
    const sent = await json(`${base}/api/channels/${channel.id}/messages`, {
      method: "POST", body: JSON.stringify({ chatId: sender.id, text: "CHANNEL-JOB: check the payment flow." }),
    });
    assert.equal(sent.seq, 1);

    const wait = await parked(base, coding.id);
    assert.equal(wait.kind, "run");
    const row = store.getPendingResume(coding.id);
    assert.equal(row.payload?.cause, "channel", "the cause \"channel\" belongs in the row — otherwise the continuation is a user turn");
    assert.match(row.prompt, /CHANNEL-JOB: check the payment flow\./, "what is parked is the delivery prompt with the message");
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], `the delivery ran despite the gate: ${JSON.stringify(turns())}`);
    // Card in both histories, cursor advanced — the delivery HAS happened, only the turn waits.
    const state = await json(`${base}/api/channels/${channel.id}`);
    assert.equal(state.messages.length, 1);
    for (const t of state.participants) assert.equal(t.cursor, 1, `cursor of ${t.chatId}`);
    assert.equal((await log(base, coding.id)).filter((e) => e.role === "channel").length, 1, "the card stands at the recipient");
    assert.equal((await waitState(base, sender.id)).wait, null, "the sender is not woken — and so not parked either");
    await dismiss(base, coding.id);
  });
});

// ── The four switch combinations ──────────────────────────────────────────────────────────
// A governs parking IN THE MIDDLE of a turn, B governs the START; each wakes its own rows.
// B used to depend on A: without automatic continuation the gate STARTED ("nobody wakes the
// row", row `gate-off`) — the user switched on a cost brake that braked nothing while both
// surfaces promised the opposite. The counter-test against the old behaviour is the fourth row
// of the table: there a turn ran, and the history held `gate-off`.
// That the A=off row is also CONTINUED at the reset is measured by the last test of this file (it
// runs entirely under A=off).
test("The four switch combinations: only B decides on the start — B parks without A too", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const cases = [
      { A: true, B: true, expected: "parks" },
      { A: true, B: false, expected: "starts" },
      { A: false, B: false, expected: "starts" },
      { A: false, B: true, expected: "parks" }, // parks ANYWAY
    ];
    for (const f of cases) {
      const fall = `A=${f.A ? "on" : "off"} B=${f.B ? "on" : "off"}`;
      assert.equal((await autoOn(base, f.A)).enabled, f.A);
      assert.equal((await gateOn(base, f.B)).enabled, f.B);
      const chat = await newChat(base, ws, { title: fall });
      const prior = turns().length;
      await send(base, chat.id, `Job ${fall}`);
      if (f.expected === "parks") {
        const wait = await parked(base, chat.id);
        assert.equal(wait.gate, true, fall);
        await waitForQuiet(base);
        assert.equal(turns().length, prior, `${fall}: the gate let the turn through — ${JSON.stringify(turns())}`);
        const kinds = await limitKinds(base, chat.id);
        assert.ok(kinds.includes("gate"), `${fall}: no gate row — ${JSON.stringify(kinds)}`);
        assert.equal(kinds.includes("gate-off"), false, `${fall}: "gate-off" existed only while B depended on A`);
        assert.equal(kinds.includes("off"), false, `${fall}: the gate row belongs to B, not to A`);
        await dismiss(base, chat.id);
      } else {
        await finished(base, chat.id);
        await waitForQuiet(base);
        assert.equal(turns().length, prior + 1, `${fall}: exactly one turn — ${JSON.stringify(turns())}`);
        assert.match(turns()[prior], new RegExp(`Job ${fall}`));
        assert.equal((await waitState(base, chat.id)).wait, null, `${fall}: without the gate nothing waits`);
        assert.deepEqual(await limitKinds(base, chat.id), [], `${fall}: and no limit row`);
      }
    }
  });
});

// ── Parked is like running ──────────────────────────────────────────────────────────────
// A chat with a run wait row takes new input into the QUEUE, not into the row. Formerly every
// further cause overwrote the parked prompt (the first job was gone without ever having run), and the
// /message route discarded the row altogether ("Own message — the planned continuation was
// discarded"). Only the button discards now — and it then starts the queued job, which parks at the
// same gate here: the job is not lost, it only changes place. The order 1, 2 after the reset is
// measured by the last test.
test("Parked is like running: a second message queues behind the parked job instead of replacing it", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "JOB-ONE");
    const wait = await parked(base, chat.id);

    const response = await send(base, chat.id, "JOB-TWO");
    assert.equal(response.queued, true, "the second message was not queued");
    assert.equal(response.parked, true, "the answer says WHY it was queued (the client shows it)");
    assert.equal(response.queue.length, 1);
    await waitForQuiet(base);
    const still = (await waitState(base, chat.id)).wait;
    assert.ok(still, "the wait row vanished with the second message");
    assert.equal(still.createdAt, wait.createdAt, "the wait row was rewritten — it belongs to the first job");
    assert.equal(store.getPendingResume(chat.id).prompt, "JOB-ONE", "the row still carries the FIRST job");
    assert.deepEqual(await limitKinds(base, chat.id), ["gate"], "no second gate row and no \"discarded\" row");
    assert.deepEqual(turns(), [], `something started next to the wait row: ${JSON.stringify(turns())}`);
    // The queue is persisted — it can sit for hours until the reset.
    const projection = store.listRunInputs().find((q) => q.chatId === chat.id);
    assert.equal(projection?.entries?.length, 1, `the queue is missing from run_inputs: ${JSON.stringify(projection)}`);
    assert.equal(projection.entries[0].prompt, "JOB-TWO");
    const entry = await entryIn(base, chat.id);
    assert.equal(entry?.kind, "limit");
    assert.equal(entry.queued, 1, "the overview shows the queued job");

    // Discarding via the button: the queued job gets a runner — and it parks at the same
    // gate. The row now carries IT; nothing has run, nothing is lost.
    assert.equal((await dismiss(base, chat.id)).ok, true);
    const two = await waitFor(async () => {
      const w = (await waitState(base, chat.id)).wait;
      return w && w.reason === "credit" && w.createdAt > wait.createdAt ? w : null;
    }, "gate row of the queued job");
    assert.ok(two);
    assert.equal(store.getPendingResume(chat.id).prompt, "JOB-TWO", "after discarding, the queued job is the parked one");
    assert.equal((await entryIn(base, chat.id))?.queued, 0);
    assert.deepEqual(turns(), []);
    assert.deepEqual(await limitKinds(base, chat.id), ["gate", "cancel", "gate"]);
    await dismiss(base, chat.id);
  });
});

// ── Switching A off ─────────────────────────────────────────────────────────────────────
// The switch discards the rows that belong to it — time-limit wait rows (reason "reset"). A
// gate row belongs to B; it used to throw it away too, together with the user's job that never ran.
// Both kinds side by side, ONE switch, two results.
test("Switching A off discards the time wait row — the gate row next to it stays", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const gate = await newChat(base, ws, { title: "Gate" });
    await send(base, gate.id, "Parked at the gate");
    await parked(base, gate.id);
    // A wait row as a TIME LIMIT leaves it (reason "reset", reset an hour ahead).
    const time = await newChat(base, ws, { title: "Time" });
    const now = Date.now();
    store.setPendingResume(time.id, {
      kind: "run", prompt: "Parked at the time limit", provider: "claude",
      limitGroup: "session", limitLabel: "session", reason: "reset",
      resetsAt: now + 3_600_000, dueAt: now + 3_600_000, now,
    });
    assert.equal((await waitState(base, time.id)).wait.gate, false, "precondition: this is NOT a gate row");

    assert.equal((await autoOn(base, false)).enabled, false);
    const list = (await json(`${base}/api/auto-continue`)).waiting;
    assert.ok(list.some((w) => w.chatId === gate.id && w.reason === "credit"), `the switch discarded the gate row: ${JSON.stringify(list)}`);
    assert.equal(list.some((w) => w.chatId === time.id), false, "the time wait row belongs to the switch — it must fall");
    assert.equal((await waitState(base, time.id)).wait, null);
    assert.ok((await limitKinds(base, time.id)).includes("off"), "the discarding is in the history of the time chat");
    assert.equal((await limitKinds(base, gate.id)).includes("off"), false, "there is no discarding in the history of the gate chat");
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], "the switch started nothing");
    await dismiss(base, gate.id);
  });
});

// ── The one-time release does not leak ──────────────────────────────────────────────────────
// The release of "Start anyway" used to be a mark in memory, set BEFORE the attempt and consumed by the next
// arbitrary gate check. If the attempt aborted before — here at the attempt cap —, it lay around, and a later,
// foreign turn ran past the gate on credit with it, with `gate-free` in the history for a button nobody had
// pressed. Now the release is an argument of exactly the start it releases; if that fails, nothing remains
// that could linger.
test("The one-time release does not leak: a \"Start anyway\" that fails at the attempt cap releases no later turn", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First job");
    await parked(base, chat.id);
    // The attempt cap — in production reached by twelve unsuccessful continuations.
    for (let i = 0; i < MAX_CONTINUES; i += 1) store.bumpPendingResumeAttempts(chat.id);
    assert.equal(store.getPendingResume(chat.id).attempts, MAX_CONTINUES);

    // The button. If it meets a self-check of the row that is just running (the wake timer reads every
    // few seconds, see header), the route answers "in-flight" with the standing row —
    // then press again, as a human would. Given up only once `wait` is empty.
    const r = await waitFor(async () => {
      const response = await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) });
      return response.wait === null ? response : null;
    }, "\"Start anyway\" gives up at the cap", 100);
    assert.equal(r.ok, false, "at the cap it gives up, not starts");
    assert.ok((await limitKinds(base, chat.id)).includes("gave-up"), "the giving up is in the history");
    assert.equal(store.getPendingResume(chat.id), null, "the row is gone with the giving up");
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], `the abandoned attempt started: ${JSON.stringify(turns())}`);

    // The next turn — here a typed message, a different delivery path than the button — must park AGAIN.
    // In the old behaviour it ran through, with `gate-free` in the history.
    await send(base, chat.id, "Second job");
    const again = await parked(base, chat.id);
    assert.equal(again.attempts, 0, "a new row — no inheritance of the abandoned counter");
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], `the next turn ran past the gate — the one-time release lingered: ${JSON.stringify(turns())}`);
    const kinds = await limitKinds(base, chat.id);
    assert.equal(kinds.includes("gate-free"), false, "\"Started anyway\" for a turn for which nobody pressed the button");
    assert.deepEqual(kinds, ["gate", "gave-up", "gate"]);
    await dismiss(base, chat.id);
  });
});

// ── Three buttons, three rows ───────────────────────────────────────────────────────────
// Formerly every start from a wait row wrote the same row "resume" — after "Try now" the history
// said "Limit reset — the run is continued" above a window nobody had reset. Now the KIND says who
// started: "resume" the reset, "retry" the human without release, "gate-free" the human with one. The
// clients derive the heading from the kind; the reset itself belongs to the last test of this file.
test("\"Try now\" writes \"retry\", \"Start anyway\" writes \"gate-free\" — neither writes \"resume\"", async () => {
  await withServer(async ({ base, ws, turns }) => {
    // A time wait row (gate off): "Try now" starts the turn without release.
    const time = await newChat(base, ws, { title: "Time" });
    const now = Date.now();
    store.setPendingResume(time.id, {
      kind: "run", prompt: "Parked at the time limit", provider: "claude",
      limitGroup: "session", limitLabel: "session", reason: "reset",
      resetsAt: now + 3_600_000, dueAt: now + 3_600_000, now,
    });
    const r1 = await json(`${base}/api/chats/${time.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    await finished(base, time.id);
    await waitForQuiet(base);
    const timeRows = (await log(base, time.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
    assert.deepEqual(timeRows.map((z) => z.kind), ["retry"], JSON.stringify(timeRows));
    assert.equal(timeRows[0].waitFor, "run");
    assert.equal(timeRows[0].attempts, 1, "the attempt counts — the manual one too");
    assert.match(timeRows[0].text, /erneut versucht/);

    // A gate row: "Start anyway" releases the one turn — and the row names the state.
    await gateOn(base);
    const gate = await newChat(base, ws, { title: "Gate" });
    await send(base, gate.id, "Parked at the gate");
    await parked(base, gate.id);
    const r2 = await json(`${base}/api/chats/${gate.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    await finished(base, gate.id);
    await waitForQuiet(base);
    const gateRows = (await log(base, gate.id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
    assert.deepEqual(gateRows.map((z) => z.kind), ["gate", "gate-free"], JSON.stringify(gateRows));
    const free = gateRows[1];
    assert.equal(free.gate, true);
    assert.equal(free.percent, 100, "the release row names the state of NOW");
    assert.match(free.text, /Trotzdem gestartet/);
    assert.equal(turns().length, 2, JSON.stringify(turns()));
    assert.equal((await waitState(base, gate.id)).wait, null);
  });
});

// ── Gate off while the wake timer reads ─────────────────────────────────────────────────────
// The wake timer of a gate row reads the provider (hundreds of milliseconds to seconds). If the gate is
// switched off EXACTLY then, the route wakes the row — and gets "in-flight" back. The running wake timer
// saw the full window and rescheduled the row to the reset; at the reset the window (here: always) still
// stood, and the row lived forever under a rule that no longer existed. Now the wake timer asks after the
// fetch whether the gate is still on (`gateExpired`) — and starts. Without the rule the turn never begins,
// and the test hangs until the suite deadline (every 30 s a line "[waiting] …" on stderr).
test("Gate off while the wake timer of the gate row is reading the provider — the wake timer starts the turn instead of rescheduling to the reset", async () => {
  await withServer(async ({ base, ws, turns, usage }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Parked at the gate");
    await parked(base, chat.id);
    // The NEXT provider fetch is the wake timer's (reset + grace, see header) — and it
    // hangs at the gate until the gate is off. Until it begins, nobody else reads: no client, no ticks.
    const prior = usageState.begun;
    const retrievalFree = usageHold();
    await waitFor(() => (usageState.begun > prior ? true : null), "fetch of the wake timer begins", 50);
    // In the middle of the fetch: gate off. The route wakes the row itself — and meets the wake timer.
    await gateOn(base, false);
    retrievalFree();
    await finished(base, chat.id);
    await waitForQuiet(base);
    assert.equal((await waitState(base, chat.id)).wait, null, "the row stayed after the turn");
    assert.equal(turns().length, 1, JSON.stringify(turns()));
    const kinds = await limitKinds(base, chat.id);
    assert.deepEqual(kinds, ["gate", "resume"], `in the history: ${JSON.stringify(kinds)}`);
  });
});

// ── active_runs at the gate — and the restart ───────────────────────────────────────────────
// A parked run is persisted by its WAIT ROW, not by active_runs. The gate clears an inherited
// active_runs row, and resumeInterruptedWork does not restart a chat with a run wait row — otherwise
// the same job would run a second time next to the continuation (or queue behind it as a duplicate).
// The crash IN THE MIDDLE of a continuation is simulated: then both rows stand.
test("Parked at the gate leaves no active_runs row — and the restart does not restart the chat", async () => {
  await withServer(async ({ base, ws, turns, restart }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Across the restart");
    const wait = await parked(base, chat.id);
    assert.equal(store.listActiveRuns().some((r) => r.chatId === chat.id), false, "a parked run does not belong in active_runs");

    // Crash in the middle of a continuation: the turn's active_runs row stands, the wait row too.
    store.setActiveRun(chat.id, { kind: "chat", prompt: "Across the restart", startedAt: Date.now() });
    const base2 = await restart();
    // The restart grace (resumeInterruptedWork, then the queue) must HAVE RUN before "nothing was started"
    // says anything — counted, not slept (test seam restartGraceCycles), and afterwards everything it would have
    // started has found quiet. Read right after the restart, which is correct under any load: the timer of the
    // first life died with its close (clearTimeout), and that of the second is created in the listen callback
    // next to resolve — only microtasks run until here, a timer cannot fire in between.
    const restartGraces = restartGraceCycles();
    await waitFor(() => restartGraceCycles() > restartGraces, "restart grace of the second server life");
    await waitForQuiet(base2);
    assert.deepEqual(turns(), [], `the restart started the parked run again: ${JSON.stringify(turns())}`);
    assert.equal(store.listActiveRuns().some((r) => r.chatId === chat.id), false, "the inherited active_runs row was not cleared — the next restart would run into it again");
    const afterwards = (await waitState(base2, chat.id)).wait;
    assert.ok(afterwards, "the wait row did not survive the restart");
    assert.equal(afterwards.reason, "credit");
    assert.equal(afterwards.gate, true);
    assert.equal(afterwards.createdAt, wait.createdAt, "the same row, not a new one");
    assert.deepEqual(await limitKinds(base2, chat.id), ["gate"], "no second gate row — there was no second start");
    assert.equal((await entryIn(base2, chat.id))?.queued, 0, "the restart queued the job as a duplicate");
    assert.equal((await log(base2, chat.id)).some((e) => e.role === "meta" && /resumed/.test(e.text)), false, "no resumption mark in the history");
    await dismiss(base2, chat.id);
  });
});

// ── Archive: the fetch-back stands BEFORE the gate ───────────────────────────────────────────
// Every run fetches its chat back, as the second statement of doRun, right after `running.add` — and
// thereby also one the gate parks in the next step. A parked wait row is open work; if the fetch-back stood
// BEHIND the gate, it would lie in the archive where nobody sees it, and the reset would run a turn in an
// archived chat. This path can be measured only here: only this file simulates the usage endpoint
// (archive.test.js measures the same fetch-back without a gate). Sabotage: moving the call `fetchBack(` in
// doRun behind `creditGateHolds` ⇒ the chat stays archived, red.
async function archiveStream(url) {
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
            try { const e = JSON.parse(line.slice(6)); if (e.type === "chat_archive") events.push(e); } catch { /* partial line */ }
          }
        }
      }
    } catch { /* the abort on closing is expected */ }
  })();
  return { events, async close() { ac.abort(); await pump; } };
}
// A channel message to an archived chat does NOT fetch it back and does not park at the gate — the delivery stops earlier
// (channels/delivery.js deliverChannel: cursor stays, system note at the sender). Counter-test: removing the archive hold in
// deliverChannel turns it red (the chat came back and parked).
test("Archive: a channel message to an archived chat is held — it stays archived, no gate row, no chat_archive, note at the sender", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    // The sender is a coding chat (a manager chat no longer writes, runs/manager-lock.js).
    const sender = await newChat(base, ws, { title: "Job checkout" });
    const coding = await newChat(base, ws, { title: "Checkout archived" });
    const channel = await json(`${base}/api/workspaces/${ws.id}/channels`, {
      method: "POST", body: JSON.stringify({ name: "checkout-archive", participants: [sender.id, coding.id] }),
    });
    const way = await json(`${base}/api/chats/${coding.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
    assert.equal(typeof way.chat.archivedAt, "number", "the chat is archived");
    const stream = await archiveStream(`${base}/api/events`);
    try {
      await json(`${base}/api/channels/${channel.id}/messages`, {
        method: "POST", body: JSON.stringify({ chatId: sender.id, text: "CHANNEL-JOB: checkout from the archive." }),
      });
      assert.equal(typeof store.getChat(coding.id).archivedAt, "number", "the chat stays in the archive");
      assert.equal(store.getPendingResume(coding.id), null, "no gate row");
      assert.deepEqual(turns(), [], "no run");
      assert.ok(store.listMessages(sender.id).some((z) => z.role === "channel" && JSON.parse(z.text).systemKind === "archived"), "note at the sender");
      // No event, without a clock: a watchdog chat is archived afterwards, its event stands at position 0.
      const watchdog = await newChat(base, ws, { title: "Watchdog" });
      await json(`${base}/api/chats/${watchdog.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
      await waitFor(async () => stream.events.some((e) => e.chatIds?.[0] === watchdog.id), "chat_archive of the watchdog");
      assert.equal(stream.events.findIndex((e) => e.chatIds?.[0] === watchdog.id), 0, "no fetch-back");
    } finally { await stream.close(); }
  });
});

// ── A turn that does not get past the gate ───────────────────────────────────────────────────
// The gate sits in doRun BEFORE the try, and until then only HOLDING cleaned up. Two paths beside it, each with the real
// trigger: a THROW in the gate (the table app_settings is renamed for exactly the synchronous part of doRun — the same
// case as a foreign lock beyond busy_timeout) left the chat in `running` for ever; a STOP during the gate await
// (doRun and stopRun in the same tick: running stands, there is no child yet) left the abort mark standing, and it
// killed the next run at spawn.
function withoutTable(root, table, fn) {
  const raw = new DatabaseSync(path.join(root, "data-root", "data", "automater.db"));
  try {
    raw.exec(`ALTER TABLE ${table} RENAME TO ${table}_way_n9`);
    try { return fn(); } finally { raw.exec(`ALTER TABLE ${table}_way_n9 RENAME TO ${table}`); }
  } finally { raw.close(); }
}

test("A throw in the gate does not leave the chat in running — the next message starts, a continuation takes its row with it", async () => {
  await withServer(async ({ base, ws, root, turns }) => {
    const chat = await newChat(base, ws);
    let thrown = null;
    const run = withoutTable(root, "app_settings", () => doRun(store.getChat(chat.id), "GATE-THROW"));
    await run.catch((e) => { thrown = e; });
    const hangs = running.has(chat.id);
    // In the old behaviour nobody cleaned up — without this line the harness cleanup would wait for quiet for ever.
    if (hangs) { running.delete(chat.id); releaseTurn(chat.id, { ran: false }); }
    assert.ok(thrown, "the gate threw (otherwise this test checks nothing)");
    assert.equal(hangs, false, `the chat stayed in running after the throw: ${thrown?.message}`);
    const r = await send(base, chat.id, "AFTERWARDS");
    assert.equal(r.queued, false, "the next message is started, not queued");
    await finished(base, chat.id, "AFTERWARDS");
    assert.deepEqual(turns().filter((t) => /GATE-THROW/.test(t)), [], "the thrown turn never reached the CLI");
    // The same for a RESUMPTION (the catcher at the gate): its run row stands 6 h ahead before the start
    // (fireAutoContinueInner) — if the gate throws, the turn takes it along instead of leaving the chat parked that long.
    await waitForQuiet(base);
    const now = Date.now();
    store.setPendingResume(chat.id, {
      kind: "run", prompt: "RESUMPTION-THROW", provider: "claude", limitGroup: "session", limitLabel: "session",
      reason: "reset", resetsAt: now + 6 * 3_600_000, dueAt: now + 6 * 3_600_000, now,
    });
    // A message BEHIND the continuation's row ("parked is like running"). If the throw takes the row along, it had
    // nobody to start it — the end-of-work hook does not run on this path.
    const q = await send(base, chat.id, "WAITING message");
    assert.equal(q.parked, true, `the message waits behind the continuation (otherwise this part checks nothing): ${JSON.stringify(q)}`);
    let throw2 = null;
    const run2 = withoutTable(root, "app_settings", () => doRun(store.getChat(chat.id), "RESUMPTION-THROW", { resumption: true }));
    await run2.catch((e) => { throw2 = e; });
    if (running.has(chat.id)) { running.delete(chat.id); releaseTurn(chat.id, { ran: false }); }
    const row = store.getPendingResume(chat.id);
    if (row) store.clearPendingResume(chat.id);
    assert.ok(throw2, "the gate threw here too (otherwise this part checks nothing)");
    assert.equal(row, null, "the wait row of the thrown continuation stayed — the chat counted as parked for 6 h");
    // Without a clock: either it runs, or everything stands still and it lies in the queue.
    const outcome = await waitFor(async () => {
      if (turns().some((t) => /WAITING message/.test(t))) return "run";
      const { open } = await json(`${base}/api/runs/active`);
      return open.runs === 0 && open.queue === 1 ? "left lying" : null;
    }, "the waiting message runs — or is left lying");
    assert.equal(outcome, "run", "the message behind the thrown continuation was left lying in the queue");
  });
});

// Formerly the stopped turn PARKED anyway (the gate row stood, and at the reset it would run completely — the stop
// route had answered `ok:true`). Now creditGateHolds asks for the abort mark after its await: no parking, no row
// "Continuing at …", and a continuation takes its run row along — the same rule as in the abort branch of doRun.
test("Stop during the gate await: the turn does not park and takes the abort mark along — a continuation its row, the next run runs", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    const run = doRun(store.getChat(chat.id), "FIRST message"); // synchronous up to the gate's await
    assert.equal(stopRun(chat.id), true, "the stop hits the chat IN THE MIDDLE of the gate (running, no child yet)");
    await run;
    assert.equal(running.has(chat.id), false, "the stopped turn does not hold the chat");
    assert.equal(store.getPendingResume(chat.id), null, "the stopped turn parked — it would run completely at the reset");
    assert.deepEqual(await limitKinds(base, chat.id), [], "no gate row \"Continuing at …\" for a stopped turn");
    // The same for a RESUMPTION: its run row (6 h ahead before the start, fireAutoContinueInner) falls with the stop.
    const now = Date.now();
    store.setPendingResume(chat.id, {
      kind: "run", prompt: "RESUMPTION-STOP", provider: "claude", limitGroup: "session", limitLabel: "session",
      reason: "credit", resetsAt: now + 6 * 3_600_000, dueAt: now + 6 * 3_600_000, now,
    });
    const run2 = doRun(store.getChat(chat.id), "RESUMPTION-STOP", { resumption: true });
    assert.equal(stopRun(chat.id), true, "the stop also hits the continuation in the middle of the gate");
    await run2;
    const row = store.getPendingResume(chat.id);
    if (row) store.clearPendingResume(chat.id);
    assert.equal(row, null, "the stopped continuation stayed parked — it would run at the reset anyway");
    await gateOn(base, false);
    await waitForQuiet(base);
    await send(base, chat.id, "SECOND message");
    await waitForQuiet(base);
    const responses = (await log(base, chat.id)).filter((e) => e.role === "assistant").map((e) => e.text);
    assert.ok(responses.some((t) => t.startsWith("FINISHED SECOND")), `the second message was killed at spawn: ${JSON.stringify(responses)}`);
    assert.deepEqual(turns().filter((t) => /FIRST message|RESUMPTION-STOP/.test(t)), [], "a stopped turn reached the CLI");
  });
});

// ── The reset — for all paths at once, under A=off ──────────────────────────────────────────
// Why ONE test (see header): the reset reaches the gate only via the forced reading of the automatic
// continuation, and afterwards the server's cache holds the free window for 60 s — every test after it
// would park nothing. So this test parks every path, turns the window to 10 % once and measures that each
// continuation comes by itself: the channel runs its turn, and the queue runs in the order 1, 2. The wake
// timer of each row carries the reset itself (the provider reports it six seconds ahead, see header) — no
// hand, no restart.
//
// And all of it under A=OFF: gate rows are self-sustaining — switching the gate on IS the consent to carry
// on at the reset. In the old behaviour nothing would have parked here (`gate-off`), and what had been
// parked nobody would have woken.
test("After the reset all parked paths run by themselves — channel, queue — even with A switched off", async () => {
  await withServer(async ({ base, ws, turns, usage }) => {
    await gateOn(base);
    assert.equal((await autoOn(base, false)).enabled, false);

    // Channel (coding ↔ coding: a manager chat no longer writes, runs/manager-lock.js)
    const sender = await newChat(base, ws, { title: "Job checkout" });
    const coding = await newChat(base, ws, { title: "Rebuild checkout" });
    const channel = await json(`${base}/api/workspaces/${ws.id}/channels`, {
      method: "POST", body: JSON.stringify({ name: "checkout-rebuild", participants: [sender.id, coding.id] }),
    });
    await json(`${base}/api/channels/${channel.id}/messages`, {
      method: "POST", body: JSON.stringify({ chatId: sender.id, text: "CHANNEL-JOB: check the payment flow." }),
    });
    // Queue: two jobs, the first parked, the second behind it
    const chat = await newChat(base, ws, { title: "Two jobs" });
    await send(base, chat.id, "JOB-ONE");
    await parked(base, chat.id);
    assert.equal((await send(base, chat.id, "JOB-TWO")).parked, true);

    const ways = { channel: coding.id, queue: chat.id };
    for (const [way, id] of Object.entries(ways)) {
      const w = await parked(base, id);
      assert.equal(w.gate, true, way);
      assert.equal(w.attempts, 0, `${way}: rescheduling at the full window must not cost an attempt`);
    }
    assert.deepEqual(turns().filter((t) => !t.startsWith("codex:")), [], `a Claude turn ran before the reset: ${JSON.stringify(turns())}`);

    // THE RESET. From here on no hand is added: each row's wake timer reads forced,
    // sees the free window and runs the turn.
    const retrievalsBeforeReset = usageState.retrievals;
    usage({ percent: 10 });
    for (const [way, id] of Object.entries(ways)) {
      await finished(base, id, way);
    }
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.filter((e) => e.role === "assistant" && e.text.startsWith("FINISHED")).length >= 2 ? true : null;
    }, "second job of the queue", 100);
    await waitForQuiet(base);
    assert.ok(usageState.retrievals > retrievalsBeforeReset,
      "the continuations did not read the state at the simulated provider — then the reset did not start them");

    // Every path: the turn has run, the row is gone, the history holds the continuation — and
    // nothing of switch A ("off") and nothing of the old behaviour ("gate-off").
    for (const [way, id] of Object.entries(ways)) {
      assert.equal((await waitState(base, id)).wait, null, `${way}: the wait row stayed after the run`);
      const kinds = await limitKinds(base, id);
      assert.ok(kinds.includes("resume"), `${way}: the continuation row is missing — ${JSON.stringify(kinds)}`);
      assert.equal(kinds.includes("off"), false, `${way}: A=off discarded the gate row`);
      assert.equal(kinds.includes("gate-off"), false, `${way}: "gate-off" no longer exists`);
      assert.equal(kinds.includes("gate-free"), false, `${way}: nobody pressed "Start anyway"`);
    }
    const claudeTurns = turns().filter((t) => !t.startsWith("codex:"));
    assert.equal(claudeTurns.length, 3, `two parked turns plus the queued one: ${JSON.stringify(claudeTurns)}`);
    // Channel: its parked prompt, with the cause the row carried.
    assert.ok(claudeTurns.some((t) => /CHANNEL-JOB: check the payment flow\./.test(t)), "the channel delivery did not run");
    // Queue: first the parked job, then the queued one — and both exactly once.
    const jobs = claudeTurns.filter((t) => /^JOB-(ONE|TWO)\b/.test(t)).map((t) => t.split(" ")[0]);
    assert.deepEqual(jobs, ["JOB-ONE", "JOB-TWO"], "the queue runs in order, after the parked continuation");
    assert.equal((await entryIn(base, chat.id)), null, "the chat has nothing open after both turns");
    assert.equal((await json(`${base}/api/auto-continue`)).enabled, false, "precondition: A was off the whole time");
  }, { codex: true });
});
