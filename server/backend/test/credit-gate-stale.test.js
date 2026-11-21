// The credit gate with a STALE reading.
//
// On a network error, an expired token or a 429, `fetchUsageLimits` passes the last known state on
// WITHOUT LIMIT — right for display (a ring that vanishes is worse than a slightly old value) and
// wrong for a LOCK: the gate would stop every chat on yesterday's number. So it decides only on a
// reading at most five minutes old; beyond that it STARTS and writes the reason into the history
// (`kind: "gate-stale"`). A silent exception could not be told apart from a gate that does not take hold.
//
// Own file because the seeded utilisation is read only once per PROCESS — the reason is explained
// in the header of credit-gate.test.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an event — WITHOUT a deadline (no timers in tests: the suite deadline is the emergency brake). Every 30 s
// a line on stderr so a hang says what it waits for.
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

// After the last checked answer the run still writes its usage rows and removes itself from
// `active_runs` — do-run.js does that in a `setImmediate` AFTER fireHooks("afterExit"), i.e. later
// than the point where the test is done. If the data directory is deleted first, SQLite reports
// "attempt to write a readonly database"; node:test attributes that late activity to the test that
// just ended and fails the whole FILE. So let it drain first (waitForQuiet, quiet.mjs — no
// deadline), then clean up.

const fakeClaude = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
if (!process.argv.slice(2).includes("--input-format")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ result: "Title" })); process.exit(0); });
} else {
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    let msg; try { msg = JSON.parse(l); } catch { return; }
    if (msg.type !== "user") return;
    setTimeout(() => {
      say({ type: "assistant", message: { content: [{ type: "text", text: "FINISHED" }] } });
      say({ type: "result", result: "FINISHED", session_id: "gate-stale" });
    }, 20);
  });
}
`;

test("Credit gate with a stale reading: it starts — and the history says why", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-credit-alt-"));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN, NPX_BIN: process.env.NPX_BIN, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL,
    HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  let server, base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    // Keep credentials out: the live fetch must fail so the persisted (old) state comes into play —
    // exactly the operating case this rule is about.
    const binDir = path.join(root, "shim");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "security"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(binDir, "security"), 0o755);
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
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;

    // Same seed as in credit-gate.test.js — only half an hour old. The window is at 100 %: without
    // the age check the run would be parked here.
    store.setSetting("usage_cache_v1", JSON.stringify({
      fiveHour: { utilization: 100, resetsAt: null },
      sevenDay: { utilization: 4, resetsAt: null },
      limits: [{ kind: "session", group: "session", percent: 100, resets_at: new Date(Date.now() + 3_600_000).toISOString() }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: "USD", disabled_reason: "", spend_limit_reached: false },
      at: Date.now() - 30 * 60_000,
    }));

    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "credit-stale", path: wsPath }) });
    await json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please do something" }) });

    await waitFor(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
    }, "answer of the fake", 100);
    // The run is completely done — otherwise "no wait row" says nothing (a running chat never waits) and "no
    // notice" says nothing about the end of the run.
    await waitForQuiet(base);
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait, null,
      "must not park on a 30-minute-old number");

    const rows = (await json(`${base}/api/chats/${chat.id}/log`))
      .filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
    const old = rows.find((z) => z.kind === "gate-stale");
    assert.ok(old, `the reason is missing from the history: ${JSON.stringify(rows.map((z) => z.kind))}`);
    assert.match(old.text, /30 Minuten alt|30 minutes old/, `the text does not name the age: ${old.text}`);
    // And nothing was reported: nothing is parked, nothing to wait for.
    assert.equal(((await json(`${base}/api/services/events`)).events || []).filter((e) => e.kind === "limit").length, 0,
      "a notice belongs to parking, not to starting");
    finished = true;
  } finally {
    // Wait for quiet only if the body passed — after a failure a hanging run would otherwise stand without a deadline.
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
