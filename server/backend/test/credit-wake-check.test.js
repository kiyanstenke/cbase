// The incident "this did not continue after the usage reset", with a real server.
//
// Account: credit gate on, extra usage off and empty (`extra_usage.disabled_reason: "out_of_credits"` — a PERMANENT
// account state). The gate parked the message at 100 % in the 5-hour window; at the reset the wake timer
// (fireAutoContinueInner) read "session 4 %, credit 100 %" — and took the credit window without a reset for a valid
// lock (limits.stillBlocked). Instead of starting it probed at 10/20/30/45/60 min and would have discarded the job after
// 24 looks, while the gate would have started the same turn without hesitation. Gate and wake timer now share ONE rule
// (limits.timeLocks): credit and spending cap are not a time lock.
//
// Also the clock time in server texts (i18n.js clockText): the gate row in the history names the time in the zone the
// client reports with the language (PUT /api/ui-lang, field `zone`) — the process runs in UTC here on purpose, like the
// user container.
//
// The usage endpoint is SIMULATED as in credit-gate-ways.test.js (switch on `globalThis.fetch`): as long as the chat
// has NO wait row the window stands at 100 % (the gate parks), once it exists at 4 % with empty extra usage — the
// situation at the wake timer. No time window decides which answer comes, the state does.
//
// Counter-test: if the wake timer reschedules the row to probing (`probes` 1, due ten minutes ahead), the test waits for
// "ran OR rescheduled" and turns RED without hanging.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { waitForQuiet } from "./quiet.mjs";

process.env.TZ = "UTC";   // the process zone of the user container (Node picks it up at runtime)
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

// ── The provider ─────────────────────────────────────────────────────────────────────────────
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const observed = { chatId: "", retrievals: 0 };
function usageResponse() {
  observed.retrievals += 1;
  const parked = !!(observed.chatId && store.getPendingResume(observed.chatId));
  // Before parking: the window is full, reset in three seconds. After: the situation of the incident at the wake timer.
  const body = parked
    ? {
      five_hour: { utilization: 4, resets_at: new Date(Date.now() + 5 * 3600_000).toISOString() },
      seven_day: { utilization: 85, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR", disabled_reason: "out_of_credits" },
    }
    : {
      five_hour: { utilization: 100, resets_at: new Date(Date.now() + 3_000).toISOString() },
      seven_day: { utilization: 85, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR", disabled_reason: "out_of_credits" },
    };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url === USAGE_URL) return Promise.resolve(usageResponse());
  return realFetch(input, init);
};

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
    say({ type: "result", result: "FINISHED", session_id: "wake-check" });
  });
}
`;

test("Gate parks at 100 %, at the reset 4 % and extra usage empty — the turn starts, and the row names the human's clock time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wake-check-"));
  const KEYS = ["CLAUDE_BIN", "NPX_BIN", "CBASE_TRIGGER_POLL", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN",
    "CBASE_SCHEDULE_TICK_MS", "CBASE_DEPOSIT_TICK_MS", "CBASE_ADMINISTRATOR_TICK_MS", "CBASE_CONTAINER"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let server = null, base = "", finished = false;
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000";
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";
    process.env.CBASE_ADMINISTRATOR_TICK_MS = "3600000";
    delete process.env.CBASE_CONTAINER;
    // Keep keychain and credentials out of the test; the token comes from the environment, the fetch lands in
    // the switch above. `npx` as a no-op (no Playwright download into the redirected HOME).
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
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "wake-check", path: wsPath }) });
    await json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: true }) });

    // The client reports the human's zone with the language (web: syncLangToBackend at start).
    const set = await json(`${base}/api/ui-lang`, { method: "PUT", body: JSON.stringify({ lang: "de", zone: "Europe/Berlin" }) });
    // The promises are COLLECTED and checked all at once at the end: the counter-test against the old state should
    // show each one red — the wake check first — not just the first.
    const error = [];
    const check = (ok, what) => { if (!ok) error.push(what); };

    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    observed.chatId = chat.id;
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "JOB-AFTER-THE-RESET" }) });

    // 1. The gate parks (session 100 %): a gate row with a known reset, the CLI was not called.
    const wait = await waitFor(async () => {
      const w = (await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait;
      return w && w.reason === "credit" ? w : null;
    }, "gate wait row");
    assert.equal(wait.gate, true);
    assert.ok(wait.resetsAt > 0, "precondition: the row knows the reset");
    const row = store.getPendingResume(chat.id);
    assert.equal(row.probes || 0, 0);
    const limitRows = async () => (await json(`${base}/api/chats/${chat.id}/log`)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
    const gateRow = (await limitRows()).find((l) => l.kind === "gate");
    assert.ok(gateRow, "the gate row is in the history");
    // The sentence's clock time is the human's (Europe/Berlin), not the process's (UTC).
    const fmt = (zone) => new Date(row.dueAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) });
    assert.notEqual(fmt("Europe/Berlin"), fmt("UTC"), "precondition: the two zones differ");
    check(gateRow.text.includes(fmt("Europe/Berlin")) && !gateRow.text.includes(fmt("UTC")),
      `clock time: expected in the human's zone (${fmt("Europe/Berlin")}), not UTC (${fmt("UTC")}): ${gateRow.text}`);

    // 2. At the reset: session 4 %, extra usage empty. The wake timer MUST start — like the gate.
    const outcome = await waitFor(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      if (l.some((e) => e.role === "assistant" && String(e.text).startsWith("FINISHED"))) return "run";
      const z = store.getPendingResume(chat.id);
      if (z && (z.probes || 0) > 0) return `rescheduled (probe ${z.probes}, due ${new Date(z.dueAt).toISOString()})`;
      return null;
    }, "turn ran or row rescheduled", 100);
    if (outcome !== "run") {
      error.unshift(`wake check: the wake timer took the empty credit for a lock — ${outcome}`);
      store.clearPendingResume(chat.id);   // nothing left that sets a wake timer
    } else {
      const turns = fs.readFileSync(turnLog, "utf8").split("\n").filter(Boolean);
      check(turns.filter((t) => t.includes("JOB-AFTER-THE-RESET")).length === 1, `exactly one turn with the job: ${JSON.stringify(turns)}`);
      check((await limitRows()).some((l) => l.kind === "resume"), "the history says it continues");
      await waitForQuiet(base);
      check(store.getPendingResume(chat.id) === null, "the wait row is cleaned up");
    }
    check(observed.retrievals >= 2, "the server really asked the provider at the wake timer");

    // The route: valid ⇒ stored, missing ⇒ unchanged (an older client says nothing about the zone — "a missing
    // field is no statement"), invalid ⇒ the ZONE stays, the LANGUAGE is accepted anyway, and the answer says so
    // (Chromium reports "Etc/Unknown" when the system zone cannot be determined; rejecting the whole move with 400 would
    // let the web client swallow the error and the server texts stay silently in the old language).
    check(set.zone === "Europe/Berlin" && store.getSetting("ui_zone") === "Europe/Berlin", `route: zone stored: ${JSON.stringify(set)}`);
    const unknown = await json(`${base}/api/ui-lang`, { method: "PUT", body: JSON.stringify({ lang: "en", zone: "Etc/Unknown" }) }).catch((e) => ({ status: e.status }));
    check(unknown.ok === true && unknown.lang === "en" && unknown.zoneRejected === true,
      `route: an invalid zone does not undo the language switch and is reported: ${JSON.stringify(unknown)}`);
    check((await json(`${base}/api/ui-lang`)).lang === "en" && store.getSetting("ui_lang") === "en", "route: the language is switched");
    check((await json(`${base}/api/ui-lang`)).zone === "Europe/Berlin" && store.getSetting("ui_zone") === "Europe/Berlin",
      "route: the invalid zone does not change the stored one");
    const valid = await json(`${base}/api/ui-lang`, { method: "PUT", body: JSON.stringify({ lang: "de", zone: "Europe/Berlin" }) });
    check(valid.zoneRejected === undefined, `route: a valid zone is not rejected: ${JSON.stringify(valid)}`);
    await json(`${base}/api/ui-lang`, { method: "PUT", body: JSON.stringify({ lang: "de" }) });
    check((await json(`${base}/api/ui-lang`)).zone === "Europe/Berlin", "route: a missing field does not change the zone");
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
