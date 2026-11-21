// The credit gate: when the global setting is on, cbase starts NO new turn from limits.START_GATE_PERCENT (99 %)
// but parks it like a time limit. The chat then shows "Start anyway (costs credit)" — it releases EXACTLY ONE turn.
//
// ── Why a file of its own ──────────────────────────────────────────────────────────────
// The gate reads the utilisation via `fetchUsageLimits({force:false})`. Without credentials (and a test must not
// have any — it would query the developer's real account) the server falls back to the state PERSISTED in
// `app_settings`; this test seeds exactly that.
//
// That fallback is read only ONCE per process, though: `usageCacheLoaded` in account/usage.js is module-wide, and
// after the first call no further server of the same process sees a new seed. In auto-continue.test.js that first
// call has long run (every limit hit goes through `limitWindowsFor`) and returns NOTHING — the gate could not be
// woken there. `node --test` gives each FILE a process of its own; hence the gate lives here and not there.
//
// For the same reason all tests IN THIS FILE share a single seeded utilisation (five hours at 100 %, freshly
// measured). The "stale reading" case needs another seed and therefore lives in credit-gate-stale.test.js.
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

// Fake Claude: every turn is LOGGED and answered. The log is the main measurement here —
// "parked instead of started" means: the CLI was not called at all.
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
    try { fs.appendFileSync(${JSON.stringify(turnLog)}, text.replace(/\\s+/g, " ").slice(0, 120) + "\\n"); } catch {}
    setTimeout(() => {
      const out = "FINISHED " + text.replace(/\\s+/g, " ").slice(0, 60);
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "gate" });
    }, 20);
  });
}
`;
// Fake Codex: the same log, so "Codex is not gated" rests on a real turn.
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
// Collapse whitespace as in fakeClaude: the Codex prompt is MULTI-LINE, and turns() counts
// lines — unfiltered, a single turn would fall apart into several entries.
try { fs.appendFileSync(${JSON.stringify(turnLog)}, "codex: " + String(prompt).replace(/\\s+/g, " ").slice(0, 100) + "\\n"); } catch {}
say({ type: "thread.started", thread_id: "codex-gate-1" });
say({ type: "turn.started" });
say({ type: "item.completed", item: { type: "agent_message", text: "FINISHED " + String(prompt).slice(0, 60) } });
say({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
setTimeout(() => process.exit(0), 20);
`;

// Keep the Anthropic usage endpoint out of the test (empty HOME, a `security` that finds
// nothing, no OAuth token). The live fetch then fails at once — and exactly then the
// persisted state, which `usageSeed` supplies, takes over.
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
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

// The seeded utilisation: the session window stands at 100 %, measured NOW. Form and field names as in
// fetchUsageLimits — `limits[]` is the source claudeWindows builds the windows from.
//
// The reset is deliberately an HOUR ahead and not a few seconds: otherwise the scheduled continuation fires in the
// middle of the test, runs into the same gate and parks a second time — the run never starts (the gate does exactly
// what it should), but attempt counter and notices grow, and a check for "exactly one notice" would depend on the
// test machine's run time.
const usageSeed = ({ percent = 100, ageMs = 0, resetInSeconds = 3600 } = {}) => ({
  fiveHour: { utilization: percent, resetsAt: new Date(Date.now() + resetInSeconds * 1000).toISOString() },
  sevenDay: { utilization: 4, resetsAt: null },
  limits: [
    { kind: "session", group: "session", percent, resets_at: new Date(Date.now() + resetInSeconds * 1000).toISOString() },
    { kind: "weekly", group: "weekly", percent: 4, resets_at: null },
  ],
  extra_usage: {
    is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25,
    currency: "USD", disabled_reason: "", spend_limit_reached: false,
  },
  at: Date.now() - ageMs,
});

async function withServer(fn, { usage = usageSeed(), codex = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-credit-"));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN, NPX_BIN: process.env.NPX_BIN,
    CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL,
    HOME: process.env.HOME, PATH: process.env.PATH,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  let server, base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  const turnLog = path.join(root, "turns.txt");
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
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
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    // Seed BEFORE the first run: the first `fetchUsageLimits` of this process reads the
    // setting, no later one does (see header of this file).
    store.setSetting("usage_cache_v1", JSON.stringify(usage));
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Credit", path: wsPath }) });
    await fn({ base, ws, root, server, turns: () => { try { return fs.readFileSync(turnLog, "utf8").split("\n").filter(Boolean); } catch { return []; } } });
    finished = true;
  } finally {
    // Wait for quiet only if the body passed (model: agent-harness.mjs) — after a failure a hanging run would
    // otherwise stand without a deadline, and the error above would never arrive.
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A failure while cleaning up says something about the cleanup, not about the product.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

const newChat = (base, ws, { provider = "claude", title = "gate-chat" } = {}) =>
  json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider, model: provider === "codex" ? "gpt-5.6-sol" : "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions", title }),
  });
const send = (base, id, text) => json(`${base}/api/chats/${id}/message`, { method: "POST", body: JSON.stringify({ text }) });
const waitState = (base, id) => json(`${base}/api/chats/${id}/auto-continue`);
const log = (base, id) => json(`${base}/api/chats/${id}/log`);
const limitRows = async (base, id) =>
  (await log(base, id)).filter((e) => e.role === "limit").map((e) => JSON.parse(e.text));
const gateOn = (base, on = true) => json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: on }) });

test("Gate on: the turn is not even begun — parked like a time limit", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const state = await gateOn(base);
    assert.equal(state.enabled, true);
    assert.equal((await json(`${base}/api/credit-gate`)).threshold, 99, "the threshold comes from the server, not from the client");

    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");

    const wait = await waitFor(async () => {
      const s = await waitState(base, chat.id);
      return s.wait ? s.wait : null;
    });
    assert.equal(wait.kind, "run");
    assert.equal(wait.reason, "credit", "the client recognises the \"Start anyway\" button only by this reason");
    assert.equal(wait.gate, true);
    assert.ok(wait.dueAt > 0, "the gate also schedules a continuation");

    // THE CORE: the CLI was not called. A "parked" with a turn that ran would be worthless —
    // the gate must prevent the START, not clean up afterwards. Quiet first: whatever would have started is through by then.
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], `a turn ran anyway: ${JSON.stringify(turns())}`);
    assert.equal((await log(base, chat.id)).some((e) => e.role === "assistant"), false, "there is already an answer in the history");

    // The row in the history says WHO decided and why.
    const rows = await limitRows(base, chat.id);
    const gate = rows.find((z) => z.kind === "gate");
    assert.ok(gate, `no gate row in the history: ${JSON.stringify(rows.map((z) => z.kind))}`);
    assert.equal(gate.percent, 100);
    assert.match(gate.text, /Guthaben-Gate|Credit gate/);

    // And there is a notice — otherwise the chat stands still without anyone learning of it.
    const notices = ((await json(`${base}/api/services/events`)).events || [])
      .filter((e) => e.kind === "limit" && e.chatId === chat.id);
    assert.equal(notices.length, 1, `exactly one parking notice: ${JSON.stringify(notices.map((m) => m.title))}`);
    assert.match(notices[0].title, /Wartet|Waiting/);

    // The usage view shows the same state (web and iOS read it from here).
    const usage = await json(`${base}/api/usage`);
    assert.equal(usage.gate.enabled, true);
    assert.equal(usage.gate.threshold, 99);
    assert.ok(usage.gate.window, "the window the gate means is missing from /api/usage");
    assert.equal(usage.credit.active, true, "the credit balance is displayed");
    assert.equal(usage.credit.limit, 50, "5,000 cents are 50 dollars — the conversion belongs on the server");
    assert.equal(usage.credit.consumed, 12.5);
    assert.equal(usage.credit.percent, 25);

    await json(`${base}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
  });
});

test("\"Start anyway\" releases EXACTLY ONE turn — afterwards the gate takes hold again", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "First job");
    await waitFor(async () => ((await waitState(base, chat.id)).wait ? true : null));

    // "Try now" WITHOUT `anyway` on a gate row: the attempt starts, runs into the gate and parks again
    // at once — the release hangs on the "Start anyway" button, not on the row coming from the gate. (Once
    // `reason === "credit"` sufficed, and the release lay as a mark in memory until some later start
    // consumed it.)
    const prior = (await waitState(base, chat.id)).wait;
    await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST" });
    // Do not read the OLD row: only one younger than the row before the click — otherwise the
    // check would prove only that the row was already there before the click.
    const again = await waitFor(async () => {
      const w = (await waitState(base, chat.id)).wait;
      return w && w.updatedAt > prior.updatedAt ? w : null;
    });
    assert.equal(again.reason, "credit", "the row stays a gate row");
    assert.equal(again.gate, true);
    // An attempt is a START, not a wake-up: the turn did not get past the gate, so it cost no
    // attempt. Counting at the wake timer BEFORE the start would discard the job as "gave-up"
    // after twelve such cycles without it ever having run.
    assert.equal(again.attempts, 0, "a start intercepted at the gate cost an attempt");
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], `"Try now" without anyway ran a turn on credit: ${JSON.stringify(turns())}`);
    assert.equal((await limitRows(base, chat.id)).some((z) => z.kind === "gate-free"), false, "no release without the button");

    // The button on the chat: the same path as "Try now", but WITH `anyway` — the release
    // is an argument of exactly this start, not a state that could linger.
    const free = await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) });
    assert.equal(free.ok, true);
    // The route does NOT answer with the row it just released: the chat is running, and a
    // running chat waits for nothing.
    assert.equal(free.wait, null, "the strip kept showing a wait time during the run");
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
    }, "answer of the fake", 100);
    await waitForQuiet(base);
    assert.equal(turns().length, 1, `exactly ONE turn: ${JSON.stringify(turns())}`);
    const rows = await limitRows(base, chat.id);
    assert.ok(rows.some((z) => z.kind === "gate-free"), `the deliberate exception is missing from the history: ${JSON.stringify(rows.map((z) => z.kind))}`);

    // And the next job is held again. If the release had stuck to the CHAT, it would run
    // through — and one click would become a permanent state nobody decided on.
    await send(base, chat.id, "Second job");
    const again2 = await waitFor(async () => {
      const s = await waitState(base, chat.id);
      return s.wait ? s.wait : null;
    });
    assert.equal(again2.reason, "credit");
    await waitForQuiet(base);
    assert.equal(turns().length, 1, `the second job ran anyway: ${JSON.stringify(turns())}`);
    await json(`${base}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
  });
});

// THE COUNTER-TEST to both tests above: the same utilisation, the same message, only the
// setting is off (the default). Without it "it is parked" would prove only that something
// parks — not that the gate does.
test("Gate off (default): the same state starts normally", async () => {
  await withServer(async ({ base, ws, turns }) => {
    assert.equal((await json(`${base}/api/credit-gate`)).enabled, false, "the default is OFF");
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
    }, "answer of the fake", 100);
    await waitForQuiet(base);
    assert.equal(turns().length, 1);
    assert.equal((await waitState(base, chat.id)).wait, null, "without the gate nothing may wait");
    assert.deepEqual((await limitRows(base, chat.id)).map((z) => z.kind), [], "and no limit row");
  });
});

// Codex has no query endpoint. Its utilisation value comes from the session file of the
// LAST run and is structurally stale — a gate on it would park for no reason or too late.
// The Claude state next to it (100 %) must therefore not stop a Codex chat.
test("Codex is not gated — even when the Claude window is full", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const chat = await newChat(base, ws, { provider: "codex" });
    await send(base, chat.id, "Codex please");
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
    }, "answer of the fake", 100);
    await waitForQuiet(base);
    assert.equal(turns().length, 1, "the Codex turn did not run");
    assert.equal((await waitState(base, chat.id)).wait, null, "a Codex chat must not wait at the credit gate");
  }, { codex: true });
});

// Switch B does NOT depend on switch A (auto-continue). The gate must not START without
// auto-continue ("nobody wakes the row", row `gate-off`) — the reasoning held, the consequence did not:
// the user switched on a cost brake that braked nothing while both surfaces promised the opposite.
// Gate wait rows are self-sustaining: switching the gate on IS the consent to carry on at the reset —
// and neither the switch nor the wake timer of A may discard them.
//
// Counter-test against the old behaviour: a turn ran here, `wait` was null and the history held
// `gate-off` — exactly the three assertions that now hold the other way round.
test("Auto-continue off: the gate parks ANYWAY — and neither the switch nor the wake timer of A discards the row", async () => {
  await withServer(async ({ base, ws, turns, root, server }) => {
    await gateOn(base);
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    const wait = await waitFor(async () => (await waitState(base, chat.id)).wait || null);
    assert.equal(wait.reason, "credit");
    assert.equal(wait.gate, true);
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], `the gate let the turn through without auto-continue: ${JSON.stringify(turns())}`);
    const kinds = (await limitRows(base, chat.id)).map((z) => z.kind);
    assert.ok(kinds.includes("gate"), `no gate row: ${JSON.stringify(kinds)}`);
    assert.equal(kinds.includes("gate-off"), false, "\"gate-off\" no longer exists — the gate parks without A as well");

    // Switching A off (once more, after switching on in between) clears time-limit
    // rows — the gate row does not belong to it.
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    const list = (await json(`${base}/api/auto-continue`)).waiting;
    assert.ok(list.some((w) => w.chatId === chat.id && w.reason === "credit"), `the switch discarded the gate row: ${JSON.stringify(list)}`);

    // The WAKE TIMER of A: a due gate row is not discarded even with A=off. It is made due via the
    // store; it is triggered by the sweep of a second server life on the same data directory
    // (2.5 s after start) — the only non-manual wake path a test can trigger. The window stands at 100 %
    // permanently in this file, so the wake timer reschedules the row instead of starting — and it stays
    // a gate row (reason "credit"), otherwise rescheduling would take away the "Start anyway" button and the protection from A.
    store.reschedulePendingResume(chat.id, { dueAt: Date.now() - 1_000 });
    const prior = store.getPendingResume(chat.id);
    // The first server life ends here — as in the restart test of auto-continue.test.js. The
    // second `close` in the cleanup of withServer is harmless (the callback comes at once).
    await new Promise((r) => server.close(r));
    const dataRoot = path.join(root, "data-root");
    const second = await startServer({ port: 0, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base2 = `http://127.0.0.1:${second.address().port}`;
    let through = false;   // the body of the second life ran through without a throw (see finally)
    try {
      const fresh = await waitFor(async () => {
        const w = (await waitState(base2, chat.id)).wait;
        return w && w.updatedAt > prior.updatedAt && w.dueAt > Date.now() ? w : null;
      }, "wake timer reschedules the gate row", 100);
      assert.equal(fresh.reason, "credit", "the gate row lost its reason when rescheduled");
      assert.equal(fresh.gate, true);
      assert.equal((await json(`${base2}/api/auto-continue`)).enabled, false, "precondition: A is off");
      await waitForQuiet(base2);
      assert.deepEqual(turns(), [], `the wake timer started despite the full window: ${JSON.stringify(turns())}`);
      assert.equal((await limitRows(base2, chat.id)).some((z) => z.kind === "off"), false, "A=off discarded the gate row");
      await json(`${base2}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
      through = true;
    } finally {
      if (through) await waitForQuiet(base2);
      await new Promise((r) => second.close(r));
    }
  });
});

// ── The switch that switched nothing ───────────────────────────
//
// Reported: "the 99 % button jumps back to off when switched on". Measured: the web client sent the
// gate switch as `{creditGate}` to /api/auto-continue — a route that neither reads nor sends that
// field. It answered 200, the client read `undefined` and put the switch back.
//
// The costly part is in THIS file because it concerns the server: `PUT /api/auto-continue`
// read a MISSING `enabled` as ON. A body with a foreign field thereby silently flipped an
// entirely different setting — every click on the credit switch turned auto-continue
// on, in BOTH directions.
test("A body without `enabled` is no statement — both switches reject it", async () => {
  await withServer(async ({ base }) => {
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    assert.equal((await json(`${base}/api/auto-continue`)).enabled, false);

    // EXACTLY the call the broken web client made.
    const error = await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ creditGate: true }) })
      .then(() => null, (e) => e);
    assert.ok(error, "a body without `enabled` must be rejected instead of guessed");
    assert.equal(error.status, 400);
    assert.equal((await json(`${base}/api/auto-continue`)).enabled, false, "the foreign setting was silently flipped");
    assert.equal((await json(`${base}/api/credit-gate`)).enabled, false, "and the gate did not go on from it anyway");

    // The same trap with the opposite sign: on the gate route a missing field would silently mean
    // OFF. That too is a decision nobody made.
    await gateOn(base);
    const f2 = await json(`${base}/api/credit-gate`, { method: "PUT", body: "{}" }).then(() => null, (e) => e);
    assert.ok(f2, "here too an empty body must not switch anything");
    assert.equal(f2.status, 400);
    assert.equal((await json(`${base}/api/credit-gate`)).enabled, true, "the gate was silently switched off");
    // And an explicit `null` is no more a statement than a missing field.
    const f3 = await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: null }) })
      .then(() => null, (e) => e);
    assert.equal(f3?.status, 400);
  });
});

// The wait row is the ONLY information web and iOS have about this state — the strip's label and the
// button "Start anyway (costs credit)" hang on it. The web client once compared `reason === "gate"`;
// the server sends that value nowhere, so the button never appeared. Both fields are pinned here.
test("The wait row names `gate: true` AND `reason: \"credit\"` — both sides read it", async () => {
  await withServer(async ({ base, ws }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    await send(base, chat.id, "Please do something");
    const wait = await waitFor(async () => (await waitState(base, chat.id)).wait || null);

    assert.equal(wait.gate, true, "the explicit mark is missing — without it only a text comparison remains");
    assert.equal(wait.reason, "credit");
    assert.notEqual(wait.reason, "gate", "\"gate\" was never the value of this field");

    // The same row in the GLOBAL list (usage page): it comes from the same serializer
    // but is read separately — checking only one of the two views would prove nothing.
    const list = (await json(`${base}/api/auto-continue`)).waiting;
    const row = list.find((w) => w.chatId === chat.id);
    assert.ok(row, `the row is missing from the global list: ${JSON.stringify(list)}`);
    assert.equal(row.gate, true);
    assert.equal(row.reason, "credit");

    await json(`${base}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
  });
});

// "Try now" and "Start anyway (costs credit)" are TWO buttons. The server once could not tell
// them apart: it did not read the body at all and gave every manual attempt the gate's one-time
// release. On a TIME wait row that is an expense nobody asked for — and one the label there does
// not announce.
test("\"Try now\" on a time wait row does NOT release the credit gate", async () => {
  await withServer(async ({ base, ws, turns }) => {
    await gateOn(base);
    const chat = await newChat(base, ws);
    // A wait row as a TIME LIMIT leaves it (reason "reset"), not the gate.
    const now = Date.now();
    store.setPendingResume(chat.id, {
      kind: "run", prompt: "Please do something", provider: "claude",
      limitGroup: "session", limitLabel: "session", reason: "reset",
      resetsAt: now + 3_600_000, dueAt: now + 3_600_000, now,
    });
    assert.equal((await waitState(base, chat.id)).wait.gate, false, "precondition: this is NOT a gate row");

    await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST" });

    // The attempt starts but runs into the gate — it must intercept the start. Formerly a
    // turn ran on credit here without anyone having asked for it.
    const again = await waitFor(async () => {
      const w = (await waitState(base, chat.id)).wait;
      return w && w.reason === "credit" ? w : null;
    });
    assert.equal(again.gate, true);
    await waitForQuiet(base);
    assert.deepEqual(turns(), [], `a turn ran on credit: ${JSON.stringify(turns())}`);
    assert.equal((await limitRows(base, chat.id)).some((z) => z.kind === "gate-free"), false,
      "the one-time release was granted although nobody pressed \"Start anyway\"");

    // The counter-test in the same chat: WITH `anyway` it is the human's explicit decision —
    // then exactly one turn runs, and the history records that it was deliberate.
    await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) });
    await waitFor(async () => {
      const l = await log(base, chat.id);
      return l.some((e) => e.role === "assistant" && e.text.startsWith("FINISHED")) ? true : null;
    }, "answer of the fake", 100);
    await waitForQuiet(base);
    assert.equal(turns().length, 1, `exactly ONE turn: ${JSON.stringify(turns())}`);
    assert.ok((await limitRows(base, chat.id)).some((z) => z.kind === "gate-free"), "the deliberate exception is missing from the history");
  });
});
