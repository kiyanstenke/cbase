// Account switch: "reached the limit but then switched account".
//
// The Claude account stood at week 100 % (reset in two days), the credit gate parked every message until that reset.
// The human signed in to another account in the user container (week 0 %) — the usage ring showed it after the next
// poll, but the parked row kept waiting for the old reset: a gate row is woken by the timer at its reset, and that
// belonged to the OLD account. The only way on was "Try now". Now the sweeper of the wait rows checks
// (runs/auto-continue.js sweepAutoContinues → runs/limit-gate.js gateFreeByMeasurement): if a reading taken AFTER
// parking shows the gate clear, the row is woken early — without a network call, the wake timer asks afresh
// before starting.
//
// Without an account (model: dynworkflows-limits.test.js "withoutAccount"): no keychain, no credentials, no token — every
// fetch fails, and the state comes from `usage_cache_v1` (account/usage.js re-reads it as long as no live fetch
// succeeded). The two accounts are two seeds; "measured" is the field `at`.
//
// The sweep is called EXPLICITLY here instead of waiting for its tick (no timers in tests): whether it kicks the row off
// is known synchronously (`autoContinueFiring` is set before the first await). If the server's tick runs in between,
// that counts the same (wakeupCycles).
//
// Counter-test: sweepAutoContinues without the branch for gate rows turns "the sweep wakes the gate row after the account
// switch" red without hanging — the row is then cleared instead of waiting for the turn. gateRowFree without the reset line
// turns "once the row's reset has arrived …" red; the two questions with `now` instead of `measuredAt` turn "a window that
// was full at measurement …" red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { sweepAutoContinues, wakeupCycles } from "../electron/server/runs/auto-continue.js";
import { autoContinueFiring, gateFreeByMeasurement, gateFreeForAllByMeasurement } from "../electron/server/runs/limit-gate.js";
import { running } from "../electron/server/runs/state.js";
import { waitForQuiet } from "./quiet.mjs";

process.env.CBASE_LIMIT_GRACE_MS ||= "2000";
process.env.CBASE_LIMIT_MIN_WAIT_MS ||= "2000";

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

// The two accounts as seed in the form fetchUsageLimits stores (reduced: fiveHour/sevenDay, measured `at`).
// Extra usage empty — a credit pot never locks the gate (limits time locks).
const WITHOUT_CREDIT = { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR", disabled_reason: "out_of_credits" };
function seedAccount({ session, week, weekReset, at, fable = null }) {
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: session, resetsAt: new Date(at + 3 * 3600_000).toISOString() },
    sevenDay: { utilization: week, resetsAt: new Date(weekReset).toISOString() },
    ...(fable == null ? {} : { limits: [
      { kind: "session", group: "session", percent: session, resets_at: new Date(at + 3 * 3600_000).toISOString() },
      { kind: "weekly_all", group: "weekly", percent: week, resets_at: new Date(weekReset).toISOString() },
      { kind: "weekly_scoped", group: "weekly", percent: fable, resets_at: new Date(weekReset).toISOString(), scope: { model: { id: null, display_name: "Fable" }, surface: null } },
    ] }),
    extra_usage: WITHOUT_CREDIT,
    at,
  }));
}

// Fake Claude: every turn is logged and answered.
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
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    try { fs.appendFileSync(${JSON.stringify(turnLog)}, text.replace(/\\s+/g, " ").slice(0, 2000) + "\\n"); } catch {}
    say({ type: "assistant", message: { content: [{ type: "text", text: "FINISHED" }] } });
    say({ type: "result", result: "FINISHED", session_id: "account-switch" });
  });
}
`;

test("Account switch: the gate parks until the old account's reset — a NEWER reading of the new account wakes the row early, the turn runs exactly once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-account-switch-"));
  const KEYS = ["CLAUDE_BIN", "NPX_BIN", "CBASE_TRIGGER_POLL", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CBASE_SCHEDULE_TICK_MS", "CBASE_DEPOSIT_TICK_MS", "CBASE_ADMINISTRATOR_TICK_MS", "CBASE_CONTAINER"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server = null, base = "", finished = false;
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000";
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";
    process.env.CBASE_ADMINISTRATOR_TICK_MS = "3600000";
    delete process.env.CBASE_CONTAINER;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    // Without an account: keep keychain and credentials out of the test, `npx` as a no-op.
    const binDir = path.join(root, "shim");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.NPX_BIN = path.join(binDir, "npx");
    fs.mkdirSync(path.join(root, "home"), { recursive: true });
    process.env.HOME = path.join(root, "home");
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    const turnLog = path.join(root, "turns.txt");
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude(turnLog), { mode: 0o755 });
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);

    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "account-switch", path: wsPath }) });
    await json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const error = [];
    const check = (ok, what) => { if (!ok) error.push(what); };

    // The old account: week 100 %, reset in two days — measured now.
    const oldReset = Date.now() + 2 * 86_400_000;
    seedAccount({ session: 20, week: 100, weekReset: oldReset, at: Date.now() });

    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "JOB-AFTER-THE-ACCOUNT-SWITCH" }) });

    // 1. The gate parks until the old account's reset; the CLI was not called.
    const wait = await waitFor(async () => {
      const w = (await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait;
      return w && w.reason === "credit" ? w : null;
    }, "gate wait row");
    assert.equal(wait.gate, true);
    const parked = store.getPendingResume(chat.id);
    assert.ok(parked.dueAt > Date.now() + 86_400_000, `precondition: the row waits for the old account's reset (${new Date(parked.dueAt).toISOString()})`);
    assert.ok(!fs.existsSync(turnLog), "precondition: no turn before the account switch");

    // 2. A sweep WITHOUT a newer reading wakes nothing: the reading it parked on is no news.
    const prior = wakeupCycles(chat.id);
    sweepAutoContinues();
    check(!autoContinueFiring.has(chat.id) && store.getPendingResume(chat.id)?.updatedAt === parked.updatedAt,
      "without a newer reading the gate row stays put");

    // 2b. Once the row's reset has arrived, its timer wakes it at `dueAt` (with grace) — not the sweep, even if a newer
    //     reading shows the window clear (otherwise almost every normal reset would start as an "account switch").
    store.reschedulePendingResume(chat.id, { dueAt: parked.dueAt, resetsAt: Date.now() - 1_000 });
    const resetPending = store.getPendingResume(chat.id);
    seedAccount({ session: 3, week: 0, weekReset: Date.now() + 7 * 86_400_000, at: resetPending.updatedAt + 1 });
    sweepAutoContinues();
    check(!autoContinueFiring.has(chat.id) && store.getPendingResume(chat.id)?.updatedAt === resetPending.updatedAt,
      "once the row's reset has arrived, the sweep does not wake it early");
    store.reschedulePendingResume(chat.id, { dueAt: parked.dueAt, resetsAt: oldReset });
    const again = store.getPendingResume(chat.id);

    // 3. Account switch: the new account (session 3 %, week 0 %), measured AFTER the (last write of the) row.
    seedAccount({ session: 3, week: 0, weekReset: Date.now() + 7 * 86_400_000, at: Math.max(Date.now(), again.updatedAt + 1) });
    sweepAutoContinues();
    const woken = autoContinueFiring.has(chat.id) || running.has(chat.id) || wakeupCycles(chat.id) > prior;
    check(woken, "the sweep wakes the gate row after the account switch");

    if (!woken) {
      store.clearPendingResume(chat.id);   // nothing left that sets a wake timer — red without hanging
    } else {
      await waitFor(async () => (await json(`${base}/api/chats/${chat.id}/log`)).some((e) => e.role === "assistant" && String(e.text).startsWith("FINISHED")),
        "turn after the account switch", 100);
      await waitForQuiet(base);
      const turns = fs.readFileSync(turnLog, "utf8").split("\n").filter(Boolean);
      check(turns.filter((t) => t.includes("JOB-AFTER-THE-ACCOUNT-SWITCH")).length === 1, `exactly one turn with the job: ${JSON.stringify(turns)}`);
      const rows = (await json(`${base}/api/chats/${chat.id}/log`)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
      const resume = rows.find((l) => l.kind === "resume");
      check(resume && /Guthaben-Gate ist frei|credit gate is clear/.test(resume.text) && !/zurückgesetzt|has reset/.test(resume.text),
        `the history row says the gate is clear — not that a limit has reset: ${JSON.stringify(resume)}`);
      check(store.getPendingResume(chat.id) === null, "the wait row is cleaned up");
    }

    // 4. The two questions individually, against the same seed form.
    //    a) A Fable weekly window at 100 % does NOT hold a Haiku chat (model-scoped), but it does hold the workflow question
    //       "free for every model?" — otherwise a woken Fable agent would re-park from the same reading.
    const now = Date.now();
    seedAccount({ session: 3, week: 0, weekReset: now + 7 * 86_400_000, at: now, fable: 100 });
    check(gateFreeByMeasurement({ chat: { model: "claude-haiku-4-5-20251001" }, providerId: "claude", since: now - 1 }) === true,
      "Fable full does not hold a Haiku chat");
    check(gateFreeForAllByMeasurement({ since: now - 1 }) === 0, "Fable full: not free for every model");
    //    b) Reading not newer than `since` ⇒ no statement; Claude only.
    seedAccount({ session: 3, week: 0, weekReset: now + 7 * 86_400_000, at: now + 1 });
    check(gateFreeByMeasurement({ chat: { model: "claude-haiku-4-5-20251001" }, providerId: "claude", since: now + 1 }) === false,
      "a reading that is not newer than the row does not wake");
    check(gateFreeByMeasurement({ chat: { model: "gpt-6-sol" }, providerId: "codex", since: 0 }) === false, "Codex: the gate does not judge");
    check(gateFreeForAllByMeasurement({ since: now }) === now + 1, "free for every model ⇒ the measurement time");
    check(gateFreeForAllByMeasurement({ since: now + 1 }) === 0, "the same reading twice ⇒ no statement");
    //    c) Judged at the time of the MEASUREMENT: a window that was full and still valid at measurement is not
    //       "free" just because its reset has passed meanwhile — that is the normal reset, and the timer wakes it.
    const earlier = Date.now() - 10_000;
    seedAccount({ session: 3, week: 100, weekReset: earlier + 1_000, at: earlier });
    check(gateFreeByMeasurement({ chat: { model: "claude-haiku-4-5-20251001" }, providerId: "claude", since: earlier - 1 }) === false,
      "a window full at measurement is not free because its reset has now passed");
    check(gateFreeForAllByMeasurement({ since: earlier - 1 }) === 0, "the same for the strict question");

    assert.deepEqual(error, []);
    finished = true;
  } finally {
    if (base && finished) await waitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
