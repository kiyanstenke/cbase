// Monitors over the turn. The incident: the agent started `cbase_monitor` on a vitest suite and ended its answer eight seconds
// later. The monitor hung on the TURN (runs/do-run.js, `createMonitorRuntime` per run, `close()` in the finally): with the end
// of the turn it died silently (no line, no wakeup) and the suite ran on alone. Since then it belongs to the CHAT
// (runs/monitors.js): it survives the end of the answer and messages of the human, every report wakes the chat as a new turn
// (the wake way of the completion notice), and only its command, a stop, its time limit, the archive or erasing end it. A
// restart ends it too; then the chat gets ONE note.
//
// What is held here, each with a counter-test (shown red):
//  (1) survives the end of the turn, counts in busy/open, "end" wakes EXACTLY ONCE with exit code and last lines, not on output
//      lines; the log file stands in the output place.
//      COUNTER-TEST: `closeMonitors(chat.id)` in the finally of doRun => "lives after the turn" red (the incident). In
//      providers/monitor-runtime.js the `if (rec.report === "end") return;` in notify removed => "wakes exactly once" red (2
//      notices). In runs/routes.js the monitor count removed from `busy` => "busy" red.
//  (2) "rows": a line wakes the IDLE chat, the monitor lives on; a message of the human in mid-wait leaves it standing; the stop
//      of the human ends it without a wakeup. A PERSISTENT monitor (a watch that may stay open for days) does not hold `busy` —
//      the deploy does not wait for it, the swap interrupts it and the restart starts it again (monitor-persistent.test.js) — but it
//      is named in `monitors` with `persistent: true`.
//      COUNTER-TEST: in runs/monitors.js `onNotification` without the wake => "the event wakes" red. In runs/routes.js `busy`
//      counting every monitor again => "a persistent monitor does not hold busy" red.
//  (3) the stop route: `taskId` and `from` are required (400), unknown is 404.
//  (4) a live monitor is open work: archiving is refused (409, reason "monitor") and the monitor lives on — the auto-archive would
//      otherwise end a quiet watch after X days without anybody noticing; after the human's stop the chat archives. Erasing ends
//      it (the process is gone).
//      COUNTER-TEST: "monitor" removed from ARCHIVE_REASONS in runs/archive.js => "archive refused" red; in chats/erase.js the
//      line `closeMonitors(id)` removed => "erase" red.
//  (5) the log file is capped (note at the end), and the notice says "capped".
//      COUNTER-TEST: in runs/monitors.js `logWrite` without the cap => "capped" red.
//  (6) a WebSocket monitor with "end" reports once when the connection closes; the frames do not wake.
//  (7) restart: a monitor WITH a time limit gets ONE note (restart-grace hook "monitors-restart-grace"), at the second restart no
//      further one. (A persistent one starts again instead: monitor-persistent.test.js.)
//      COUNTER-TEST: the hook registration in server.js removed => "note" red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import { startServer, restartGraceCycles } from "../electron/server/server.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

// The fake CLI: "STARTE {json}" starts a monitor with these arguments (like cbase_monitor over the MCP server), any other input,
// a wakeup too, gets "ECHO". Every turn can be a new process: no state in the process.
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
  say({ type: "system", subtype: "init", session_id: "mo" });
  const i = text.indexOf("STARTE ");
  if (i >= 0 && !text.startsWith("<task-notification>")) {
    const r = await fetch(base + "/api/chats/" + chatId + "/monitor", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: text.slice(i + 7),
    });
    const body = await r.json();
    say({ type: "assistant", message: { content: [{ type: "text", text: "MONITOR " + r.status + " " + (body.taskId || body.error) }] } });
    say({ type: "result", result: "started", session_id: "mo" });
    return;
  }
  say({ type: "assistant", message: { content: [{ type: "text", text: "ECHO" }] } });
  say({ type: "result", result: "ECHO", session_id: "mo" });
});
`;

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
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
    if (i && i % 1500 === 0) process.stderr.write(`[monitor-test] still waiting for: ${what}\n`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const RESTART_GRACE_OFF = String(24 * 3600_000);

async function start(root) {
  const server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.CBASE_TEST_BASE = base;
  return { server, base };
}
async function close(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
}

async function newChat(base, wsPath, title = "MO-Test") {
  const ws = await ok(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: `MO ${title}`, path: wsPath }) });
  const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await ok(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}

async function withServer(fn, { env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mo-"));
  const bin = path.join(root, "fake-claude");
  fs.writeFileSync(bin, fakeClaude);
  fs.chmodSync(bin, 0o755);
  const prior = {};
  const set = { CLAUDE_BIN: bin, CBASE_RESTART_GRACE_MS: RESTART_GRACE_OFF, ...env };
  for (const [k, v] of Object.entries(set)) { prior[k] = process.env[k]; process.env[k] = v; }
  const wsPath = path.join(root, "workspace");
  fs.mkdirSync(wsPath);
  const ctx = { root, wsPath, server: null, base: "" };
  try {
    Object.assign(ctx, await start(root));
    await fn(ctx);
    await waitForQuiet(ctx.base);
  } finally {
    await close(ctx.server);
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.CBASE_TEST_BASE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleaning up is no statement */ }
  }
}

const log = (base, chatId) => ok(`${base}/api/chats/${chatId}/log`);
const metas = async (base, chatId) => (await log(base, chatId)).filter((m) => m.role === "meta").length;
const notices = async (base, chatId) => (await log(base, chatId)).filter((m) => m.role === "user" && String(m.text).startsWith("<task-notification>")).map((m) => m.text);
const active = (base) => ok(`${base}/api/runs/active`);

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
const alive = async (base, taskId) => (await active(base)).monitors.some((x) => x.taskId === taskId);
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const gate = (root, name) => path.join(root, `gate-${name}`);
const waitForGate = (file) => `while [ ! -f ${sh(file)} ]; do sleep 0.05; done`;

test("(1) \"end\": survives the end of the turn, counts in busy, wakes EXACTLY ONCE with exit code, last lines and log file", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const chat = await newChat(base, wsPath);
    const t = gate(root, "end");
    const taskId = await startMonitor(base, chat.id, {
      command: `echo ROW-ONE; echo ROW-TWO; ${waitForGate(t)}; echo FINISHED-XYZ; exit 3`, description: "Suite", report: "end",
    });
    // The turn is over and the monitor lives (the incident: here it was dead).
    assert.ok(await alive(base, taskId), "the monitor lives after the end of its turn");
    const st = await active(base);
    assert.equal(st.busy, true, "a living monitor holds busy (deploy gate, idle reaper)");
    assert.equal(st.quiet, false, "and the quiet of the tests");
    assert.equal(st.monitors.find((m) => m.taskId === taskId).report, "end");
    // The output lines do not wake in the mode "end": no notice came up to the gate.
    const location = (await ok(`${base}/api/chats/${chat.id}/outputs`));
    await waitUntil(async () => (await ok(`${base}/api/chats/${chat.id}/outputs`)).entries.some((e) => e.path === `monitors/${taskId}.log` && e.size > 0), "log file");
    assert.ok(Array.isArray(location.roots));
    assert.deepEqual(await notices(base, chat.id), [], "\"end\" does not wake on output lines");
    fs.writeFileSync(t, "");
    await waitUntil(async () => (await notices(base, chat.id)).length > 0, "the notice of the end");
    await waitForQuiet(base);
    const all = await notices(base, chat.id);
    assert.equal(all.length, 1, `exactly ONE notice: ${JSON.stringify(all)}`);
    const m = all[0];
    assert.match(m, /<status>failed<\/status>/);
    assert.match(m, /Exit-Code 3|exit code 3/);
    assert.match(m, /FINISHED-XYZ/);
    assert.match(m, /ROW-ONE/, "the last lines come along");
    assert.match(m, new RegExp(`monitors/${taskId}\\.log`), "the notice names the log file");
    assert.equal(await alive(base, taskId), false);
    // The log file holds the whole output and the end.
    const file = await fetch(`${base}/api/chats/${chat.id}/outputs/file?path=${encodeURIComponent(`monitors/${taskId}.log`)}&inline=1`).then((r) => r.text());
    assert.match(file, /ROW-ONE[\s\S]*FINISHED-XYZ[\s\S]*Exit-Code 3|exit code 3/);
  });
});

test("(2) \"rows\": an event wakes the idle chat, a message of the human leaves it standing, the stop of the human ends it silently", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const chat = await newChat(base, wsPath);
    const t1 = gate(root, "one");
    const taskId = await startMonitor(base, chat.id, {
      command: `${waitForGate(t1)}; echo HITS-1; while true; do sleep 0.2; done`, description: "Watch", report: "rows", persistent: true,
    });
    assert.ok(await alive(base, taskId));
    // Persistent: named, but not in `busy` (the deploy would otherwise wait for days); open work all the same.
    const st = await waitUntil(async () => { const a = await active(base); return a.runs === 0 ? a : null; }, "the start turn is over");
    assert.equal(st.monitors.find((m) => m.taskId === taskId)?.persistent, true, "the field names it as persistent");
    assert.equal(st.busy, false, "a persistent monitor does not hold busy");
    assert.equal(st.quiet, false, "but it is open work for the quiet of the tests");
    // A message of the human in mid-wait: a whole turn, afterwards the monitor lives on.
    const before = await metas(base, chat.id);
    await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "How is it going?" }) });
    await waitUntil(async () => (await metas(base, chat.id)) > before, "end of the human turn");
    assert.ok(await alive(base, taskId), "the monitor survives a message of the human and its turn");
    // An event wakes the idle chat.
    const beforeEvent = await metas(base, chat.id);
    fs.writeFileSync(t1, "");
    await waitUntil(async () => (await notices(base, chat.id)).length > 0, "wakeup of the event");
    await waitUntil(async () => (await metas(base, chat.id)) > beforeEvent, "turn of the wakeup");
    const [m] = await notices(base, chat.id);
    assert.match(m, /<status>running<\/status>/);
    assert.match(m, /Monitor "Watch" event/);
    assert.match(m, /HITS-1/);
    assert.ok(await alive(base, taskId), "after the event it runs on");
    // The human stops: no wakeup, the monitor is gone, a silent line in the history.
    await ok(`${base}/api/chats/${chat.id}/monitor/stop`, { method: "POST", body: JSON.stringify({ taskId, from: "human" }) });
    await waitForQuiet(base);
    assert.equal(await alive(base, taskId), false);
    assert.equal((await notices(base, chat.id)).length, 1, "the stop of the human does not wake");
    const rows = (await log(base, chat.id)).filter((x) => x.role === "monitor").map((x) => JSON.parse(x.text));
    assert.ok(rows.some((z) => z.event === "done" && z.status === "stopped"), JSON.stringify(rows));
  });
});

test("(3) the stop route: taskId and from are required, an unknown monitor is 404, even without a turn", async () => {
  await withServer(async ({ base, wsPath }) => {
    const chat = await newChat(base, wsPath);
    const url = `${base}/api/chats/${chat.id}/monitor/stop`;
    assert.equal((await json(url, { method: "POST", body: JSON.stringify({ from: "human" }) })).status, 400);
    assert.equal((await json(url, { method: "POST", body: JSON.stringify({ taskId: "monitor_x" }) })).status, 400, "a missing from is no instruction");
    assert.equal((await json(url, { method: "POST", body: JSON.stringify({ taskId: "monitor_x", from: "someone" }) })).status, 400);
    assert.equal((await json(url, { method: "POST", body: JSON.stringify({ taskId: "monitor_x", from: "agent" }) })).status, 404);
  });
});

test("(4) a live monitor holds the archive (409, reason monitor) — after the stop the chat archives; erasing ends it with its process", async () => {
  await withServer(async ({ base, root, wsPath }) => {
    const tot = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    for (const way of ["archive", "erase"]) {
      const chat = await newChat(base, wsPath, `MO ${way}`);
      const pidFile = path.join(root, `pid-${way}`);
      const taskId = await startMonitor(base, chat.id, { command: `echo $$ > ${sh(pidFile)}; while true; do sleep 0.2; done`, description: way, report: "rows", persistent: true });
      const pid = Number(await waitUntil(() => { try { return fs.readFileSync(pidFile, "utf8").trim(); } catch { return ""; } }, "pid"));
      assert.ok(pid > 0 && !tot(pid));
      if (way === "archive") {
        const r = await fetch(`${base}/api/chats/${chat.id}/archive`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
        const body = await r.json();
        assert.equal(r.status, 409, `archive refused while the monitor runs: ${JSON.stringify(body)}`);
        assert.deepEqual((body.open || []).map((o) => o.reason), ["monitor"], "the reason is the monitor");
        assert.ok(await alive(base, taskId), "the monitor lives on");
        await ok(`${base}/api/chats/${chat.id}/monitor/stop`, { method: "POST", body: JSON.stringify({ taskId, from: "human" }) });
        await waitUntil(async () => !(await alive(base, taskId)), "the stop ends it");
        await ok(`${base}/api/chats/${chat.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
      } else {
        await ok(`${base}/api/chats/${chat.id}`, { method: "DELETE" });
        assert.equal(await alive(base, taskId), false, `${way}: the monitor is gone`);
      }
      await waitUntil(() => tot(pid), `${way}: the process ends`);
    }
  });
});

test("(5) the log file is capped, with a note, and the notice says so", async () => {
  await withServer(async ({ base, wsPath }) => {
    const chat = await newChat(base, wsPath);
    const taskId = await startMonitor(base, chat.id, { command: "for i in $(seq 1 200); do echo ROW-$i-0123456789; done; exit 0", description: "Lots", report: "end" });
    await waitUntil(async () => (await notices(base, chat.id)).length > 0, "notice");
    await waitForQuiet(base);
    const [m] = await notices(base, chat.id);
    assert.match(m, /<status>completed<\/status>/);
    assert.match(m, /gedeckelt|capped/);
    assert.match(m, /ROW-200-/, "the last lines come despite the cap");
    const file = await fetch(`${base}/api/chats/${chat.id}/outputs/file?path=${encodeURIComponent(`monitors/${taskId}.log`)}&inline=1`).then((r) => r.text());
    assert.ok(Buffer.byteLength(file) < 2048, `the file does not grow above the cap: ${Buffer.byteLength(file)} bytes`);
    assert.doesNotMatch(file, /ROW-150-/);
  }, { env: { CBASE_MONITOR_LOG_MAX: "600" } });
});

test("(6) WebSocket with \"end\": the frames do not wake, the closing wakes once", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const open = new Set();
  let close2 = null;
  wss.on("connection", (s) => {
    open.add(s);
    s.send("FRAME-1");
    s.send("FRAME-2");
    close2 = () => s.close(1000, "finished");
  });
  try {
    await withServer(async ({ base, wsPath }) => {
      const chat = await newChat(base, wsPath);
      const taskId = await startMonitor(base, chat.id, { ws: `ws://127.0.0.1:${wss.address().port}/x`, description: "WS", report: "end" });
      await waitUntil(() => close2, "connection");
      await waitUntil(async () => (await ok(`${base}/api/chats/${chat.id}/outputs`)).entries.some((e) => e.path === `monitors/${taskId}.log` && e.size > 40), "frames in the log");
      assert.deepEqual(await notices(base, chat.id), [], "frames do not wake in the mode \"end\"");
      close2();
      await waitUntil(async () => (await notices(base, chat.id)).length > 0, "notice");
      await waitForQuiet(base);
      const all = await notices(base, chat.id);
      assert.equal(all.length, 1, JSON.stringify(all));
      assert.match(all[0], /WebSocket geschlossen \(Code 1000|WebSocket geschlossen \(code 1000/);
      assert.match(all[0], /FRAME-2/);
    });
  } finally {
    for (const s of open) s.terminate();
    await new Promise((r) => wss.close(() => r()));
  }
});

test("(7) restart: the chat gets ONE note, at the next restart no further one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mo-new-"));
  const bin = path.join(root, "fake-claude");
  fs.writeFileSync(bin, fakeClaude);
  fs.chmodSync(bin, 0o755);
  const prior = { CLAUDE_BIN: process.env.CLAUDE_BIN, CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS };
  process.env.CLAUDE_BIN = bin;
  process.env.CBASE_RESTART_GRACE_MS = RESTART_GRACE_OFF;
  const wsPath = path.join(root, "workspace");
  fs.mkdirSync(wsPath);
  let server = null;
  try {
    let base;
    ({ server, base } = await start(root));
    const chat = await newChat(base, wsPath);
    const taskId = await startMonitor(base, chat.id, { command: "while true; do sleep 0.2; done", description: "Longrunner", report: "end" });
    await close(server);
    server = null;
    const notes = async (b) => (await log(b, chat.id)).filter((m) => m.role === "hint" && String(m.text).includes(taskId));
    for (const round of [1, 2]) {
      process.env.CBASE_RESTART_GRACE_MS = "0";
      const n = restartGraceCycles();
      ({ server, base } = await start(root));
      await waitUntil(() => restartGraceCycles() > n, "restart grace");
      const existing = await notes(base);
      assert.equal(existing.length, 1, `round ${round}: exactly one note ${JSON.stringify(existing)}`);
      assert.match(existing[0].text, /Longrunner/);
      assert.deepEqual((await active(base)).monitors, [], "after the restart it does not live");
      await close(server);
      server = null;
    }
  } finally {
    await close(server);
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env.CBASE_TEST_BASE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleaning up is no statement */ }
  }
});
