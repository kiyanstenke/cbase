// Gate rows with a real server: how long a gate row waits, and the probe stage.
//
// Wait time: WHETHER a gate row waits is asked of the gate (threshold 99, model cut); HOW LONG used to be computed
// by chooseWait over all time locks from 98 % with the latest reset. Situation: session 99.5 % (reset in an hour),
// week 98.5 % (reset in three days), extra usage empty. The gate holds only on the session and would let the turn start
// after its reset — the row slept until the weekly reset, and the strip named a time days ahead. Three ways park or
// schedule a gate row, all three here: the gate at the turn (creditGateHolds), the wake timer
// (fireAutoContinueInner) and a oneshot intercepted at the gate (maybeAutoContinue with `gate`).
//
// Two more promises:
//   (a) For a gate row the wake timer asks the GATE question (runs/limit-gate.js lockingWindow) — checked directly,
//       without a server (the first test).
//   (b) If the gate parks with an unknown reset, that first look is a probe (`probes` 1, five minutes). And if it
//       re-parks an EXISTING row (the wake timer started its turn, the gate holds again), the stage keeps counting
//       (ten minutes) — a fixed first stage with `probes` rising anyway would be wrong.
//
// The usage endpoint is SIMULATED (switch on `globalThis.fetch`, as in credit-wake-check.test.js); the situation changes
// between the parts, and the 60-second cache is then explicitly refetched (fetchUsageLimits force) — otherwise the gate
// would judge by the previous part's situation.
//
// Counter-test: the wait time on all three ways turns red if the due time falls back to the weekly reset; the probe-stage
// check turns red at the second stage if it is fixed to the first; (a) and the first probe stage each turn red if the
// line they hold is sabotaged.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as limits from "../electron/server/limits.js";
import { startServer } from "../electron/server/server.js";
import { fireAutoContinue, maybeAutoContinue } from "../electron/server/runs/auto-continue.js";
import { lockingWindow, waitTimeFor } from "../electron/server/runs/limit-gate.js";
import { fetchUsageLimits } from "../electron/server/account/usage.js";
import * as store from "../electron/server/store.js";
import { waitForQuiet } from "./quiet.mjs";

process.env.CBASE_LIMIT_GRACE_MS ||= "2000";
process.env.CBASE_LIMIT_MIN_WAIT_MS ||= "2000";
const GRACE = Number(process.env.CBASE_LIMIT_GRACE_MS);
const MODEL = "claude-haiku-4-5-20251001";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an event — WITHOUT a deadline (no timers in tests); a line on stderr every 30 s.
async function waitFor(fn, what = "", every = 40) {
  const begin = Date.now();
  let reported = begin;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - reported >= 30_000) {
      reported = Date.now();
      console.error(`[waiting] for ${Math.round((reported - begin) / 1000)} s: ${what}`);
    }
    await sleep(every);
  }
}

// ── The situations ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Fixed times for the whole file: the due time is checked against EXACTLY these resets.
const SESSION_RESET = Date.now() + 3600_000;
const WEEK_RESET = Date.now() + 3 * 86_400_000;
const EXTRA = { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR", disabled_reason: "out_of_credits" };
const LAGEN = {
  // Probe stage: the window is full, no reset is visible.
  "without-reset": { five_hour: { utilization: 100, resets_at: null }, seven_day: { utilization: 40, resets_at: new Date(WEEK_RESET).toISOString() }, extra_usage: EXTRA },
  // Wait time: the gate holds on the session (99.5 ≥ 99), the week is only at the wait mark (98.5 ≥ 98).
  week: {
    five_hour: { utilization: 99.5, resets_at: new Date(SESSION_RESET).toISOString() },
    seven_day: { utilization: 98.5, resets_at: new Date(WEEK_RESET).toISOString() },
    extra_usage: EXTRA,
  },
};
const observed = { situation: "without-reset" };
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url === USAGE_URL) return Promise.resolve(new Response(JSON.stringify(LAGEN[observed.situation]), { status: 200, headers: { "content-type": "application/json" } }));
  return realFetch(input, init);
};

// Fake Claude: the gate holds in every part — a turn that starts anyway shows up in the file.
const fakeClaude = (turnLog) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
if (!process.argv.slice(2).includes("--input-format")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ result: "Title" })); process.exit(0); });
} else {
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    let msg; try { msg = JSON.parse(l); } catch { return; }
    if (msg.type !== "user") return;
    try { fs.appendFileSync(${JSON.stringify(turnLog)}, "turn\\n"); } catch {}
    say({ type: "assistant", message: { content: [{ type: "text", text: "DONE" }] } });
    say({ type: "result", result: "DONE", session_id: "gate-wait-time" });
  });
}
`;

test("Wake timer: asks the GATE for a gate row and the time locks for a limit row — and computes the wait time from the same question", () => {
  const now = Date.parse("2026-10-04T17:40:44Z");
  const inHour = now + 3600_000;
  const inDays = now + 3 * 86_400_000;
  const chat = { id: "c-gate", model: MODEL };
  const window = (group, percent, resetsAt) => ({ id: group, group, label: group, scope: "", percent, resetsAt, reached: false, provider: "claude" });
  // Session 98.5 %: a time lock (98) but NO gate lock (99).
  const tight = [window(limits.GROUPS.SESSION, 98.5, inHour)];
  assert.equal(lockingWindow({ gateRow: true, chat, providerId: "claude", windows: tight, now: now }), null,
    "a gate row starts at 98.5 % — the gate would do so too");
  assert.equal(lockingWindow({ gateRow: false, chat, providerId: "claude", windows: tight, now: now })?.group, limits.GROUPS.SESSION,
    "a limit row keeps waiting at 98.5 %");
  // Session 99.5 %, week 98.5 %: both rows wait — the gate row until the session, the limit row until the week.
  const situation = [window(limits.GROUPS.SESSION, 99.5, inHour), window(limits.GROUPS.WEEKLY, 98.5, inDays)];
  const gate = waitTimeFor({ gateRow: true, chat, providerId: "claude", windows: situation, now: now });
  const limit = waitTimeFor({ gateRow: false, chat, providerId: "claude", windows: situation, now: now });
  assert.equal(lockingWindow({ gateRow: true, chat, providerId: "claude", windows: situation, now: now })?.group, limits.GROUPS.SESSION);
  assert.equal(gate.window?.group, limits.GROUPS.SESSION);
  assert.equal(gate.resumeAt, inHour + GRACE);
  assert.equal(limit.window?.group, limits.GROUPS.WEEKLY);
  assert.equal(limit.resumeAt, inDays + GRACE);
});

test("Gate rows with a real server: the probe stage keeps counting, and the wait lasts as long as the gate holds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gate-wait-time-"));
  const KEYS = ["CLAUDE_BIN", "NPX_BIN", "CBASE_TRIGGER_POLL", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN",
    "CBASE_SCHEDULE_TICK_MS", "CBASE_DEPOSIT_TICK_MS", "CBASE_ADMINISTRATOR_TICK_MS"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server = null, base = "", finished = false;
  const chats = [];
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000";
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";
    process.env.CBASE_ADMINISTRATOR_TICK_MS = "3600000";
    const binDir = path.join(root, "shim");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.NPX_BIN = path.join(binDir, "npx");
    fs.mkdirSync(path.join(root, "home"), { recursive: true });
    process.env.HOME = path.join(root, "home");
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "cbase-test-token";
    const turnLog = path.join(root, "turns.txt");
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude(turnLog), { mode: 0o755 });
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);

    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "gate-wait-time", path: wsPath }) });
    await json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    await json(`${base}/api/ui-lang`, { method: "PUT", body: JSON.stringify({ lang: "de" }) });
    const newChat = async () => {
      const c = await json(`${base}/api/chats`, {
        method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: MODEL, permissionMode: "bypassPermissions" }),
      });
      chats.push(c.id);
      return c;
    };
    const gateRow = (chatId) => waitFor(async () => {
      const w = (await json(`${base}/api/chats/${chatId}/auto-continue`)).wait;
      return w && w.reason === "credit" ? store.getPendingResume(chatId) : null;
    }, "gate wait row");
    // The promises are COLLECTED and checked all at once at the end: the counter-test against the old state should
    // show each one red, not just the first.
    const error = [];
    const check = (ok, what) => { if (!ok) error.push(what); };
    const min = (ms) => ms / 60_000;
    const iso = (ts) => (ts ? new Date(ts).toISOString() : String(ts));

    // ── Probe stage: the gate parks with an unknown reset ──────────────────────────────────────────────────────
    const a = await newChat();
    await json(`${base}/api/chats/${a.id}/message`, { method: "POST", body: JSON.stringify({ text: "JOB-A" }) });
    const first = await gateRow(a.id);
    await waitForQuiet(base);
    check(first.probes === 1, `probe stage: the gate's first look is a probe (probes ${first.probes})`);
    check(first.dueAt - first.updatedAt === 5 * 60_000, `probe stage: first stage five minutes, not ${min(first.dueAt - first.updatedAt)}`);
    // The wake timer starts the row's turn (here the "Try now" button, so no network look intervenes) —
    // the gate holds again and re-parks the SAME row. We wait for the re-parked row: the wake timer pushes it
    // six hours back before the start, re-parking pulls it forward again.
    const prior = store.getPendingResume(a.id);
    const fired = await fireAutoContinue(a.id, { manual: true });
    check(fired?.ok === true, `probe stage: precondition — the row's turn is kicked off: ${JSON.stringify(fired)}`);
    const second = await waitFor(() => {
      const z = store.getPendingResume(a.id);
      return z && z.updatedAt > prior.updatedAt && z.dueAt - z.updatedAt < 3600_000 ? z : null;
    }, "re-parked gate row", 40);
    await waitForQuiet(base);
    check(second.probes === 2, `probe stage: the second look is the second probe (probes ${second.probes})`);
    check(second.dueAt - second.updatedAt === 10 * 60_000, `probe stage: second stage ten minutes, not ${min(second.dueAt - second.updatedAt)}`);
    check(!fs.existsSync(turnLog), "probe stage: no turn started — the gate holds");
    await json(`${base}/api/chats/${a.id}/auto-continue`, { method: "DELETE" });
    await waitForQuiet(base);

    // ── Wait time: session 99.5 %, week 98.5 % ─────────────────────────────────────────────────────────────────
    observed.situation = "week";
    await fetchUsageLimits({ force: true });   // bring the 60 s cache to the new situation — the gate reads it
    // (1) The gate at the turn.
    const b = await newChat();
    await json(`${base}/api/chats/${b.id}/message`, { method: "POST", body: JSON.stringify({ text: "JOB-B" }) });
    const parked = await gateRow(b.id);
    await waitForQuiet(base);
    check(parked.resetsAt === SESSION_RESET, `wait time, gate: the row names the session reset (${iso(SESSION_RESET)}), not ${iso(parked.resetsAt)}`);
    check(parked.dueAt === SESSION_RESET + GRACE, `wait time, gate: due after the session reset (${iso(SESSION_RESET + GRACE)}), not ${iso(parked.dueAt)}`);
    // (2) The wake timer: the gate still holds (99.5 %) — it reschedules to the reset of the window it holds on.
    const woken = await fireAutoContinue(b.id);
    await waitForQuiet(base);
    const afterWakeup = store.getPendingResume(b.id);
    check(woken?.reason === "still-limited", `wait time, wake timer: precondition — the row still stands: ${JSON.stringify(woken)}`);
    check(woken?.dueAt === SESSION_RESET + GRACE && afterWakeup?.dueAt === SESSION_RESET + GRACE,
      `wait time, wake timer: rescheduled to the session reset (${iso(SESSION_RESET + GRACE)}), not ${iso(woken?.dueAt)} / ${iso(afterWakeup?.dueAt)}`);
    check(afterWakeup?.resetsAt === SESSION_RESET, `wait time, wake timer: the row names the session reset, not ${iso(afterWakeup?.resetsAt)}`);
    // (3) A oneshot intercepted at the gate (runOnce throws with gateLimitText and `err.gate`).
    const c = await newChat();
    const windowOfTheGates = limits.gateWindow(limits.claudeWindows(LAGEN.week), { model: MODEL });
    const takenOver = await maybeAutoContinue(store.getChat(c.id), {
      providerId: "claude", res: { resultText: limits.gateLimitText(windowOfTheGates), stderr: "" }, kind: "run", prompt: "JOB-C",
      gate: { window: windowOfTheGates, percent: 100, model: MODEL },
    });
    const oneshot = store.getPendingResume(c.id);
    check(takenOver === true && oneshot?.reason === "credit", `wait time, oneshot: precondition — parked as a gate row: ${takenOver} ${JSON.stringify(oneshot?.reason)}`);
    check(oneshot?.dueAt === SESSION_RESET + GRACE, `wait time, oneshot: due after the session reset (${iso(SESSION_RESET + GRACE)}), not ${iso(oneshot?.dueAt)}`);
    check(!fs.existsSync(turnLog), "wait time: no turn started — the gate holds");

    for (const id of chats) await json(`${base}/api/chats/${id}/auto-continue`, { method: "DELETE" });
    await waitForQuiet(base);
    assert.deepEqual(error, []);
    finished = true;
  } finally {
    if (base && !finished) {
      for (const id of chats) { try { store.clearPendingResume(id); } catch { /* clean up */ } }
    }
    if (base) await waitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
