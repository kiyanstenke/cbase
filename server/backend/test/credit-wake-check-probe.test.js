// The other side of the incident in credit-wake-check.test.js: the gate row that REALLY still stands at the wake
// timer — and what it then says.
//
// Situation at the wake timer: the 5-hour window stands at 100 % WITHOUT a reset (a valid time lock without a date),
// next to it the empty extra usage. The gate locks (the wake timer now asks the same question), chooseWait knows no
// reset ⇒ it probes. Three promises, each red against the old behaviour:
//   · probe stage: the stage is the number of probes already made: the first look after a dated gate row lies five
//     minutes ahead (formerly ten — `probes + 1`), via limits.nextProbing;
//   · no promised time: `resetsAt` is empty (formerly the old, past reset — web and iOS read "continue at <probe time>"
//     from it), the wait sentence says only "window full.", the label is the window that really locks;
//   · log line: the log names the rescheduling: `[limit] <chat>: still in place (session 100 %, reset unknown) → probe
//     1/24, …` — in the incident no line stood between parking and giving up.
// Plus, in the same server life: a mere suspicion (`requireReset`) on an account with empty extra usage does not park,
// writes nothing into the history and leaves the chat's waiting row standing. And a PROOF — the message itself says
// credit, or the reset is fixed and lies too far — gets its history row back (formerly only a console line), but
// likewise discards no foreign row; the rejection "credits" from a credit WINDOW alone stays a suspicion.
// Own file because the 60-second cache of fetchUsageLimits is module-wide (see header of credit-gate.test.js).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as limits from "../electron/server/limits.js";
import { startServer } from "../electron/server/server.js";
import { maybeAutoContinue } from "../electron/server/runs/auto-continue.js";
import * as store from "../electron/server/store.js";
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

// ── The provider: before parking full with a reset in three seconds, afterwards full WITHOUT a reset ─────────
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const observed = { chatId: "", situation: "gate" };
const extra = { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR", disabled_reason: "out_of_credits" };
function usageResponse() {
  const parked = !!(observed.chatId && store.getPendingResume(observed.chatId));
  if (observed.situation === "suspicion") {
    // Suspicion: the chat's window is free, only the pot is empty.
    const body = { five_hour: { utilization: 20, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() }, extra_usage: extra };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (observed.situation === "only-pot") {
    // Pot only: no time window at all, just the empty pot — the rejection "credits" from the window alone.
    return new Response(JSON.stringify({ extra_usage: extra }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const body = {
    five_hour: { utilization: 100, resets_at: parked ? null : new Date(Date.now() + 3_000).toISOString() },
    seven_day: { utilization: 40, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
    extra_usage: extra,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url === USAGE_URL) return Promise.resolve(usageResponse());
  return realFetch(input, init);
};

// The server's log — it runs in THIS process; the lines still go to stdout.
const log = [];
const realLog = console.log;
console.log = (...a) => { log.push(a.map(String).join(" ")); realLog(...a); };

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
    say({ type: "result", result: "DONE", session_id: "probing" });
  });
}
`;

test("Gate row that still stands at the wake timer: five minutes to the next look, no promise, a line in the log — and a suspicion discards nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wake-probe-"));
  const KEYS = ["CLAUDE_BIN", "NPX_BIN", "CBASE_TRIGGER_POLL", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN",
    "CBASE_SCHEDULE_TICK_MS", "CBASE_DEPOSIT_TICK_MS", "CBASE_ADMINISTRATOR_TICK_MS"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server = null, base = "", finished = false;
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
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "probing", path: wsPath }) });
    await json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    await json(`${base}/api/ui-lang`, { method: "PUT", body: JSON.stringify({ lang: "de" }) });

    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    observed.chatId = chat.id;
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "JOB" }) });

    // Parked with a known reset — the promise (still) rightly stands.
    const prior = await waitFor(async () => {
      const w = (await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait;
      return w && w.reason === "credit" ? w : null;
    }, "gate wait row");
    assert.ok(prior.resetsAt > 0, "precondition: parked with a date");

    // The wake timer: the window still stands, no reset is visible any more ⇒ probe.
    const row = await waitFor(() => {
      const z = store.getPendingResume(chat.id);
      return z && (z.probes || 0) > 0 ? z : null;
    }, "first probe", 100);
    // The promises are COLLECTED and checked all at once at the end: each is a repair of its own, and the counter-test
    // against the old state should show each one red, not just the first.
    const error = [];
    const check = (ok, what) => { if (!ok) error.push(what); };
    check(row.reason === "credit", `the gate mark stays ("Start anyway" button): ${row.reason}`);
    check(row.probes === 1, `one probe: ${row.probes}`);
    // Stage 0 for the first look — formerly `probes + 1` = ten minutes.
    check(row.dueAt - row.updatedAt === 5 * 60_000, `probe stage: the first look lies five minutes ahead, not ${(row.dueAt - row.updatedAt) / 60_000}`);
    // No promise any more.
    const wait = (await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait;
    check(wait.resetsAt === null, `no promised time: no reset any more for clients to build "continue at" on: ${wait.resetsAt}`);
    check(wait.group === "session", `no promised time: the label is the window that locks: ${wait.group}`);
    check(!/Weiter um/.test(wait.text), `no promised time: the wait sentence promises no clock time: ${wait.text}`);
    // The log names the rescheduling with the locking window.
    const rows = log.filter((l) => l.includes(chat.id) && l.includes("still in place"));
    check(rows.some((l) => l.includes("session 100 %") && l.includes("reset unknown") && l.includes(`probe 1/${limits.MAX_PROBES}`)),
      `log line: the line for rescheduling is missing: ${JSON.stringify(rows)}`);
    check(!fs.existsSync(turnLog), "no turn started");

    await json(`${base}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
    await waitForQuiet(base);

    // A SUSPICION (turn ended cleanly, a subagent reported "You've hit your Opus limit", `requireReset`) on an account
    // with empty extra usage. Formerly the credit window turned "no reset evidenced" into the rejection "credits":
    // history row "credit reached", and cancelAutoContinue cleared the chat's waiting compaction.
    observed.situation = "suspicion";
    const second = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    const later = Date.now() + 3600_000;
    store.setPendingResume(second.id, { kind: "compact", provider: "claude", limitGroup: "session", limitLabel: "session", reason: "reset", resetsAt: later, dueAt: later });
    const beforeRow = store.getPendingResume(second.id);
    const takenOver = await maybeAutoContinue(store.getChat(second.id), {
      providerId: "claude", res: { resultText: "", stderr: "" }, events: ["You've hit your Opus limit"], kind: "run", requireReset: true, prompt: "x",
    });
    check(takenOver === false, "suspicion: it does not park");
    const afterRow = store.getPendingResume(second.id);
    check(afterRow?.kind === "compact" && afterRow?.createdAt === beforeRow.createdAt, `suspicion: the waiting compaction still stands: ${JSON.stringify(afterRow)}`);
    const rows2 = (await json(`${base}/api/chats/${second.id}/log`)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind);
    check(rows2.length === 0, `suspicion: no history row for a suspicion: ${JSON.stringify(rows2)}`);

    // Proof: the same waiting compaction, three more hints from a cleanly ended turn.
    const limitKinds = async () => (await json(`${base}/api/chats/${second.id}/log`)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text).kind);
    const hint = (text) => maybeAutoContinue(store.getChat(second.id), {
      providerId: "claude", res: { resultText: "", stderr: "" }, events: [text], kind: "run", requireReset: true, prompt: "x",
    });
    const compressionStandsStill = (what) => {
      const z = store.getPendingResume(second.id);
      check(z?.kind === "compact" && z?.createdAt === beforeRow.createdAt, `proof ${what}: the waiting compaction still stands: ${JSON.stringify(z)}`);
    };
    // (a) Proof "credits": the CLI itself says "out of usage credits" — the work never took place, the history says so.
    check(await hint("You're out of usage credits") === false, "proof, credit: it is not parked");
    const afterProof = await limitKinds();
    check(afterProof.filter((k) => k === "credits").length === 1, `proof, credit: one history row "credits": ${JSON.stringify(afterProof)}`);
    compressionStandsStill("credit proof");
    // (b) Proof "too-long": the reset is fixed but lies beyond the maximum wait.
    const far = new Date(Date.now() + limits.MAX_WAIT_MS + 86_400_000).toISOString();
    check(await hint(`Usage limit reached — resets at ${far}`) === false, "proof, too far: it is not parked");
    const afterFar = await limitKinds();
    check(afterFar.filter((k) => k === "too-long").length === 1, `proof, too far: one history row "too-long": ${JSON.stringify(afterFar)}`);
    compressionStandsStill("too far");
    // (c) Suspicion: no time window, only the empty pot, the message without a credit word — the rejection would come from
    // the WINDOW alone, which is an account state and no proof for this turn. No row, nothing discarded.
    observed.situation = "only-pot";
    check(await hint("You've hit your Opus limit") === false, "proof, pot suspicion: it is not parked");
    const afterPot = await limitKinds();
    check(afterPot.length === afterFar.length, `proof, pot suspicion: no new history row: ${JSON.stringify(afterPot)}`);
    compressionStandsStill("pot suspicion");
    store.clearPendingResume(second.id);
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
