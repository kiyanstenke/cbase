// Persistent monitors (cbase_monitor with persistent: true — a watch open for days, e.g. the Teams watch on a WebSocket). Such a
// watch (a) has NO total event cap — before, it ended after CBASE_MONITOR_MAX_EVENTS events however
// slowly they came; the throttle stays the cost protection — and (b) SURVIVES a server restart: the restart hook starts it again by
// itself (same command, chat, id, log file continued). A monitor with a time limit stays as it was (cap, note on restart).
//
// What is held here, each with a counter-proof (shown red):
//  (1) through the chat: a persistent monitor delivers more events than the cap and keeps running; the same watch WITHOUT
//      persistent ends at the cap with status "flooded".
//      COUNTER-PROOF: providers/monitor-runtime.js rip cord without `!rec.persistent &&` => "persistent: 5 events" red.
//  (2) restart: the persistent monitor runs again after the restart (same id, `persistent`, the log continued) and delivers; one
//      the human stopped before does not come back; one with a time limit gets its note as before; stopped after the restart it
//      stays gone at the next restart.
//      COUNTER-PROOF: in runs/monitors.js monitorsRestartGrace the branch `if (z.persistent && z.args)` replaced by `if (false)` =>
//      "runs again" red (it gets the note instead).
//  (3) crash loop: a resumed monitor whose command fails at once is tried CBASE_MONITOR_RESUME_MAX times, then ends for good with
//      ONE notice (no notice per attempt); the next restart does not start it again.
//      COUNTER-PROOF: in runs/monitors.js onDone the branch `if (unstable && …) { failedAttempt … }` replaced by `if (false)` =>
//      (3) red (one attempt, ended normally); the block `if (e.stableTimer) { … return; }` in onNotification removed => (3) red
//      (a wake per attempt).
//  (4) crash loop of the backend: a monitor resumed again and again without ever running its stable period (the backend dies
//      earlier each time) is given up after CBASE_MONITOR_RESUME_MAX starts — the count stands in the inventory before the start.
//      COUNTER-PROOF: inventoryRow writing `attempts: 0` instead of `e.attempts` => the count never reaches the file, the monitor is
//      resumed forever — the file turns red (cancelled: (3) waits for an end notice that never comes).
//  (5) between two attempts the monitor is named (`resuming: true`) and open work (archive refused); the human's stop and deleting
//      the chat end it for good, also across the next restart.
//      COUNTER-PROOF: in stopMonitor `const row = dropPending(chatId, id);` -> `const row = null;`, or the `dropPending` loop in
//      closeMonitors removed => the file turns red (cancelled: the waiting monitor cannot be ended, the quiet never comes).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer, restartGraceCycles } from "../electron/server/server.js";
import { T } from "../electron/server/i18n.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

// The fake CLI: "STARTE {json}" starts a monitor with these arguments (like cbase_monitor over the MCP server), any other input —
// a monitor notice too — gets "ECHO". Every turn can be a new process: no state in the process.
const fakeClaude = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
process.stdin.on("end", () => process.exit(0));
const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config") + 1], "utf8"));
const chatId = cfg.mcpServers.cbase.env.CBASE_CHAT_ID;
const base = process.env.CBASE_TEST_BASE;
const textOf = (msg) => { const c = msg.message && msg.message.content; return typeof c === "string" ? c : (c || []).map((b) => b.text || "").join(""); };
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const text = textOf(msg);
  say({ type: "system", subtype: "init", session_id: "mp" });
  const i = text.indexOf("STARTE ");
  if (i >= 0 && !text.startsWith("<task-notification>")) {
    const r = await fetch(base + "/api/chats/" + chatId + "/monitor", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: text.slice(i + 7),
    });
    const body = await r.json();
    say({ type: "assistant", message: { content: [{ type: "text", text: "MONITOR " + r.status + " " + (body.taskId || body.error) }] } });
    say({ type: "result", result: "started", session_id: "mp" });
    return;
  }
  say({ type: "assistant", message: { content: [{ type: "text", text: "ECHO" }] } });
  say({ type: "result", result: "ECHO", session_id: "mp" });
});
`;

// `Connection: close` (like agent-harness.mjs json): after a restart the fetch pool may still hold a socket to the OLD server
// (closeAllConnections tore it down); a GET on it is retried by undici, a POST ends in "fetch failed" (seen in the gate of 18.11.).
async function json(url, init) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const ok = async (url, init) => {
  const r = await json(url, init);
  if (r.status >= 400) throw new Error(`${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

// Wait for a STATE, without a deadline (no clock on which a test turns red; the emergency brake is the suite).
async function waitUntil(fn, what) {
  for (let i = 0; ; i++) {
    const v = await fn();
    if (v) return v;
    if (i && i % 1500 === 0) process.stderr.write(`[monitor-persistent] still waiting for: ${what}\n`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const RESTART_GRACE_OFF = String(24 * 3600_000);

// One data root over several server runs in this process (the restart): start, close, start again.
function lab(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mp-"));
  const bin = path.join(root, "fake-claude");
  fs.writeFileSync(bin, fakeClaude);
  fs.chmodSync(bin, 0o755);
  const wsPath = path.join(root, "workspace");
  fs.mkdirSync(wsPath);
  const set = { CLAUDE_BIN: bin, CBASE_RESTART_GRACE_MS: RESTART_GRACE_OFF, ...env };
  const prior = {};
  for (const [k, v] of Object.entries(set)) { prior[k] = process.env[k]; process.env[k] = v; }
  let server = null;
  const self = {
    root, wsPath, base: "",
    async start() {
      server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
      self.base = `http://127.0.0.1:${server.address().port}`;
      process.env.CBASE_TEST_BASE = self.base;
      return self.base;
    },
    async close() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      server = null;
    },
    // A restart: close, start again with the restart grace at once, wait until its hooks ran.
    async restart() {
      await self.close();
      process.env.CBASE_RESTART_GRACE_MS = "0";
      const n = restartGraceCycles();
      await self.start();
      await waitUntil(() => restartGraceCycles() > n, "restart grace");
      process.env.CBASE_RESTART_GRACE_MS = RESTART_GRACE_OFF;
    },
    async end() {
      try {
        if (server) {
          // A test that failed midway leaves its watch running — stop it, otherwise the quiet waits for it until the suite's brake.
          for (const m of (await ok(`${self.base}/api/runs/active`)).monitors) await json(`${self.base}/api/chats/${m.chatId}/monitor/stop`, { method: "POST", body: JSON.stringify({ taskId: m.taskId, from: "agent" }) });
          await waitForQuiet(self.base);
        }
      } finally {
        await self.close();
        for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        delete process.env.CBASE_TEST_BASE;
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleaning up is no statement */ }
      }
    },
  };
  return self;
}

async function newChat(base, wsPath, title = "MP-Test") {
  const ws = await ok(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: `MP ${title}`, path: wsPath }) });
  const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await ok(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}

const log = (base, chatId) => ok(`${base}/api/chats/${chatId}/log`);
const metas = async (base, chatId) => (await log(base, chatId)).filter((m) => m.role === "meta").length;
const notices = async (base, chatId) => (await log(base, chatId)).filter((m) => m.role === "user" && String(m.text).startsWith("<task-notification>")).map((m) => m.text);
const noticesOf = async (base, chatId, taskId) => (await notices(base, chatId)).filter((t) => t.includes(`<task-id>${taskId}</task-id>`));
const active = (base) => ok(`${base}/api/runs/active`);
// No turn runs and none waits (a live monitor is open work — waitForQuiet would wait for it forever).
const turnsOver = (base) => waitUntil(async () => { const a = await active(base); return a.runs === 0 && !(a.queued > 0); }, "the turns are over");
const monitorOf = async (base, taskId) => (await active(base)).monitors.find((x) => x.taskId === taskId) || null;
const logFile = (base, chatId, taskId) => fetch(`${base}/api/chats/${chatId}/outputs/file?path=${encodeURIComponent(`monitors/${taskId}.log`)}&inline=1`, { headers: { Connection: "close" } }).then((r) => r.text());

/** Starts a monitor through a turn and returns its taskId as soon as the turn is over. */
async function startMonitor(base, chatId, args) {
  const before = await metas(base, chatId);
  await ok(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text: `STARTE ${JSON.stringify(args)}` }) });
  await waitUntil(async () => (await metas(base, chatId)) > before, "end of the start turn");
  const response = (await log(base, chatId)).filter((m) => m.role === "assistant").map((m) => m.text).filter((t) => t.startsWith("MONITOR ")).pop() || "";
  const m = /^MONITOR 201 (\S+)/.exec(response);
  assert.ok(m, `the monitor did not start: ${response}`);
  return m[1];
}
const stop = (base, chatId, taskId, from = "agent") => ok(`${base}/api/chats/${chatId}/monitor/stop`, { method: "POST", body: JSON.stringify({ taskId, from }) });
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// A watch that reports the content of a gate file once per appearance (and removes it) — one process at a time.
const gateWatch = (file) => `while true; do if [ -f ${sh(file)} ]; then echo "HIT-$(cat ${sh(file)})"; rm -f ${sh(file)}; fi; sleep 0.05; done`;
// Write the gate and wait until the watch took it (the file is gone) — then the line is out.
async function fire(file, word) {
  fs.writeFileSync(file, word);
  await waitUntil(() => !fs.existsSync(file), `the watch takes ${word}`);
}

test("(1) a persistent monitor delivers more events than the cap and keeps running; without persistent it ends at the cap", async () => {
  const L = lab({ CBASE_MONITOR_MAX_EVENTS: "3", CBASE_MONITOR_RATE_MAX: "1000" });
  try {
    const base = await L.start();
    const chat = await newChat(base, L.wsPath);
    const results = {};
    for (const persistent of [true, false]) {
      const gate = path.join(L.root, `gate-${persistent}`);
      const taskId = await startMonitor(base, chat.id, {
        command: gateWatch(gate), description: persistent ? "Watch" : "Bounded", report: "rows",
        ...(persistent ? { persistent: true } : { timeout_ms: 3_600_000 }),
      });
      for (let i = 1; i <= 5; i++) {
        if (!(await monitorOf(base, taskId))) break; // the bounded one is gone after the cap
        await fire(gate, `${persistent}-${i}`);
        await waitUntil(async () => (await noticesOf(base, chat.id, taskId)).length >= i, `notice ${i}`);
      }
      await turnsOver(base);
      results[persistent] = { taskId, all: await noticesOf(base, chat.id, taskId), alive: Boolean(await monitorOf(base, taskId)) };
    }
    const p = results.true;
    assert.equal(p.all.length, 5, `persistent: 5 events: ${JSON.stringify(p.all)}`);
    assert.ok(p.all.every((t) => /<status>running<\/status>/.test(t)), "every one an event");
    assert.match(p.all[4], /HIT-true-5/);
    assert.equal(p.alive, true, "it keeps running after more events than the cap");
    const b = results.false;
    assert.equal(b.alive, false, "the bounded one ended");
    assert.equal(b.all.length, 4, `three events, then the flood notice: ${JSON.stringify(b.all)}`);
    assert.match(b.all[3], /<status>flooded<\/status>/);
    await stop(base, chat.id, p.taskId);
    await waitUntil(async () => !(await monitorOf(base, p.taskId)), "stop");
  } finally { await L.end(); }
});

test("(2) restart: the persistent monitor runs again (same id, same log) and delivers; a stopped one stays gone; a bounded one gets its note", async () => {
  // The stable period short: the held events after the resume go out quickly (the wait is on the notice, not on a duration).
  const L = lab({ CBASE_MONITOR_RESUME_STABLE_MS: "200" });
  try {
    let base = await L.start();
    const chat = await newChat(base, L.wsPath);
    const gate = path.join(L.root, "gate-watch");
    const watch = await startMonitor(base, chat.id, { command: gateWatch(gate), description: "Teams watch", report: "rows", persistent: true });
    const stopped = await startMonitor(base, chat.id, { command: "while true; do sleep 0.2; done", description: "Stopped watch", report: "rows", persistent: true });
    const bounded = await startMonitor(base, chat.id, { command: "while true; do sleep 0.2; done", description: "Longrunner", report: "end" });
    await fire(gate, "one");
    await waitUntil(async () => (await noticesOf(base, chat.id, watch)).length === 1, "first event");
    await stop(base, chat.id, stopped, "human");
    await waitUntil(async () => !(await monitorOf(base, stopped)), "stop of the human");
    await turnsOver(base);

    await L.restart();
    base = L.base;
    // The restart hook runs synchronously before the cycle counts — its outcome stands now (no waiting: the counter-proof is red at
    // once instead of hanging).
    const again = await monitorOf(base, watch);
    assert.ok(again, "the persistent monitor runs again");
    assert.equal(again.persistent, true);
    assert.equal(again.chatId, chat.id);
    const st = await active(base);
    assert.deepEqual(st.monitors.map((m) => m.taskId), [watch], `only the persistent one runs again: ${JSON.stringify(st.monitors)}`);
    assert.equal(st.busy, false, "a persistent one does not hold busy after the resume either");
    const hints = (await log(base, chat.id)).filter((m) => m.role === "hint");
    assert.equal(hints.filter((h) => h.text.includes(bounded)).length, 1, "the bounded one gets ONE note");
    assert.equal(hints.filter((h) => h.text.includes(watch) || h.text.includes(stopped)).length, 0, "the persistent ones get no orphan note");
    // It delivers after the restart — through the same id.
    await fire(gate, "two");
    await waitUntil(async () => (await noticesOf(base, chat.id, watch)).some((t) => t.includes("HIT-two")), "event after the restart");
    const file = await logFile(base, chat.id, watch);
    assert.match(file, /HIT-one[\s\S]*Resumed after a server restart[\s\S]*HIT-two/, `the same log continued:\n${file}`);
    const rows = (await log(base, chat.id)).filter((x) => x.role === "monitor").map((x) => JSON.parse(x.text));
    assert.ok(rows.some((z) => z.event === "started" && z.taskId === watch && z.resumed === true), JSON.stringify(rows));
    // Stopped after the restart (by the agent, with the old id): gone for good, also at the next restart.
    await stop(base, chat.id, watch, "agent");
    await waitUntil(async () => !(await monitorOf(base, watch)), "stop after the restart");
    await waitForQuiet(base);
    const before = (await notices(base, chat.id)).length;
    await L.restart();
    base = L.base;
    await waitForQuiet(base);
    assert.deepEqual((await active(base)).monitors, [], "nothing comes back");
    assert.equal((await notices(base, chat.id)).length, before, "and nothing wakes");
    assert.equal((await log(base, chat.id)).filter((m) => m.role === "hint" && m.text.includes(bounded)).length, 1, "no second note");
  } finally { await L.end(); }
});

test("(3) crash loop: a resumed monitor that fails at once is tried RESUME_MAX times, then ends with ONE notice — and stays gone", async () => {
  const L = lab({ CBASE_MONITOR_RESUME_MAX: "3", CBASE_MONITOR_RESUME_BACKOFF_MS: "20" });
  try {
    let base = await L.start();
    const chat = await newChat(base, L.wsPath);
    const broken = path.join(L.root, "broken");
    const count = path.join(L.root, "count");
    const taskId = await startMonitor(base, chat.id, {
      command: `if [ -f ${sh(broken)} ]; then echo ATTEMPT >> ${sh(count)}; echo BROKEN-LINE; exit 1; fi; while true; do sleep 0.2; done`,
      description: "Fragile watch", report: "rows", persistent: true,
    });
    await turnsOver(base);
    fs.writeFileSync(broken, "");
    await L.restart();
    base = L.base;
    const [end] = await waitUntil(async () => { const n = await noticesOf(base, chat.id, taskId); return n.length ? n : null; }, "the end notice");
    await waitForQuiet(base);
    const attempts = () => (fs.existsSync(count) ? fs.readFileSync(count, "utf8").trim().split("\n").length : 0);
    assert.equal(attempts(), 3, "three attempts");
    const all = await noticesOf(base, chat.id, taskId);
    assert.equal(all.length, 1, `exactly one notice, none per attempt: ${JSON.stringify(all)}`);
    assert.match(end, /<status>failed<\/status>/);
    // The end text in the language of the run (the gate runs with CBASE_UI_LANG=de): its fixed part before the detail.
    const endHead = T`End: could not be started again after the server restart — ${"<detail>"}.`.split(" — ")[0];
    assert.ok(end.includes(endHead), `the end text "${endHead}" is missing: ${end}`);
    assert.match(end, /BROKEN-LINE/, "the last lines come along");
    assert.equal(await monitorOf(base, taskId), null, "it does not run");
    const file = await logFile(base, chat.id, taskId);
    assert.match(file, /Resume attempt 1 failed[\s\S]*Resume attempt 2 failed/, file);
    await L.restart();
    base = L.base;
    await waitForQuiet(base);
    assert.equal(attempts(), 3, "the next restart does not start it again");
    assert.equal((await noticesOf(base, chat.id, taskId)).length, 1);
  } finally { await L.end(); }
});

test("(4) crash loop of the backend: resumed RESUME_MAX times without a stable period, the next restart gives it up", async () => {
  // The stable period is never reached (default 60 s; the restarts come earlier).
  const L = lab({ CBASE_MONITOR_RESUME_MAX: "2" });
  try {
    let base = await L.start();
    const chat = await newChat(base, L.wsPath);
    const taskId = await startMonitor(base, chat.id, { command: "while true; do sleep 0.2; done", description: "Watch in a crash loop", report: "rows", persistent: true });
    await turnsOver(base);
    for (const round of [1, 2]) {
      await L.restart();
      base = L.base;
      assert.ok(await monitorOf(base, taskId), `round ${round}: resumed`);
      const file = await logFile(base, chat.id, taskId);
      assert.match(file, new RegExp(`Resumed after a server restart \\(attempt ${round}\\)`), file);
    }
    await L.restart();
    base = L.base;
    assert.equal(await monitorOf(base, taskId), null, "given up at the third restart");
    const [end] = await waitUntil(async () => { const n = await noticesOf(base, chat.id, taskId); return n.length ? n : null; }, "the end notice");
    assert.match(end, /<status>failed<\/status>/);
    assert.match(end, /2 starts in a row did not run|2 Starts in Folge liefen keine/);
    await waitForQuiet(base);
    assert.equal(await monitorOf(base, taskId), null);
  } finally { await L.end(); }
});

test("(5) between two attempts the monitor is named (resuming) and open work; the human's stop and deleting the chat end it for good", async () => {
  // The pause after a failed attempt long: the monitor stays in its waiting state for the test.
  const L = lab({ CBASE_MONITOR_RESUME_BACKOFF_MS: String(3_600_000) });
  try {
    let base = await L.start();
    const broken = path.join(L.root, "broken");
    const cmd = `if [ -f ${sh(broken)} ]; then exit 1; fi; while true; do sleep 0.2; done`;
    const a = await newChat(base, L.wsPath, "MP stop");
    const b = await newChat(base, L.wsPath, "MP delete");
    const ta = await startMonitor(base, a.id, { command: cmd, description: "Waits A", report: "rows", persistent: true });
    const tb = await startMonitor(base, b.id, { command: cmd, description: "Waits B", report: "rows", persistent: true });
    await turnsOver(base);
    fs.writeFileSync(broken, "");
    await L.restart();
    base = L.base;
    for (const t of [ta, tb]) await waitUntil(async () => (await monitorOf(base, t))?.resuming === true, `${t} waits for its next attempt`);
    const st = await active(base);
    assert.equal(st.busy, false, "persistent: no busy");
    assert.equal(st.quiet, false, "open work all the same");
    const r = await fetch(`${base}/api/chats/${a.id}/archive`, { method: "PUT", headers: { "content-type": "application/json", Connection: "close" }, body: JSON.stringify({ archived: true }) });
    assert.equal(r.status, 409, "a waiting monitor holds the archive");
    await stop(base, a.id, ta, "human");
    await ok(`${base}/api/chats/${b.id}`, { method: "DELETE" });
    assert.deepEqual((await active(base)).monitors, [], "both are gone");
    await waitForQuiet(base);
    fs.rmSync(broken);
    await L.restart();
    base = L.base;
    assert.deepEqual((await active(base)).monitors, [], "and do not come back after the next restart");
    assert.deepEqual(await noticesOf(base, a.id, ta), [], "the stop does not wake");
    const rows = (await log(base, a.id)).filter((x) => x.role === "monitor").map((x) => JSON.parse(x.text));
    assert.ok(rows.some((z) => z.event === "done" && z.taskId === ta && z.status === "stopped"), JSON.stringify(rows));
  } finally { await L.end(); }
});
