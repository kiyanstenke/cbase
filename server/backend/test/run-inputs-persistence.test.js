// The queue survives a restart.
//
// Since "parked counts as running", a message arriving behind a parked continuation waits in the queue until the
// limit resets - hours, with the weekly limit days. The queue used to be an in-process map: a restart in that time
// lost the message without a trace. Now the table `run_inputs` mirrors it and the start reads it back.
//
// -- Why the second server life is its OWN PROCESS --------------------------------------------------------------
// The other restart tests (auto-continue, credit-gate) run two servers in the same process one after another. That
// is not enough for THIS promise: the map is module-wide and survives a `server.close()` - an in-process restart
// would still have the message without the table, and the counter-test against the old state would stay green. A
// child process has an empty map, and that is the restart in question. A side effect that is even needed here: the
// child reads the usage cache fresh (read only ONCE per process, see credit-gate.test.js) - so the window can be set
// to 10 % for the second life and the continuation runs through instead of parking at the gate a second time.
//
// Counter-test: against the state without the table (shadow copy of server.js and store.js) the queue is empty after
// the restart, "message two" is gone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { waitForQuiet } from "./quiet.mjs";

// The server under test - as a path, so the child process loads THE SAME one (also in a shadow copy for the counter-test).
const SERVER_JS = fileURLToPath(new URL("../electron/server/server.js", import.meta.url));

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an event - WITHOUT a deadline (no timers in tests: the emergency brake is the suite deadline). Every 30 s a
// line on stderr so that a hang says what it waits for. The end of the work is measured by waitForQuiet (quiet.mjs).
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
// The next SSE event matching `predicate`. The reader belongs to the caller - who closes it in the finally, otherwise
// server.close() waits forever for the open connection. No deadline; it turns red only if the stream ENDS without the event.
async function waitForSse(reader, predicate) {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((x) => x.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (predicate(event)) return event;
    }
  }
  throw new Error("SSE event not received");
}

// Fake Claude like in credit-gate.test.js: every turn is logged and answered with "DONE <prompt>" - both server
// lives use the same file.
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
      const out = "DONE " + text.replace(/\\s+/g, " ").slice(0, 60);
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "persist" });
    }, 20);
  });
}
`;

// Keep the Anthropic usage endpoint out of the test (empty HOME, a `security` that finds nothing, no OAuth token) -
// then the persisted state from `usage_cache_v1` applies. The child process inherits the environment.
function isolateCredentials(root) {
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  const security = path.join(binDir, "security");
  fs.writeFileSync(security, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(security, 0o755);
  // `npx` as a no-op (like wait-row-lifecycle.test.js): every server loads the Playwright MCP into the npx cache of
  // the redirected HOME at start - the grandchild of the second life still wrote there when the test cleaned up, and
  // rmSync used up its 20 retries. No test here needs the browser.
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

// Shape as in fetchUsageLimits; the reset lies an hour ahead so the continuation does not fire by itself - it is
// triggered here by hand, at a known point.
// `at` is the measurement time: a measurement AFTER parking that shows the gate free wakes the row early (account
// switch, runs/limit-gate.js gateFreeByMeasurement) - whoever checks that the row stays seeds an older one.
const usageSeed = ({ percent = 100, resetInSeconds = 3600, at = Date.now() } = {}) => ({
  fiveHour: { utilization: percent, resetsAt: new Date(Date.now() + resetInSeconds * 1000).toISOString() },
  sevenDay: { utilization: 4, resetsAt: null },
  limits: [
    { kind: "session", group: "session", percent: percent, resets_at: new Date(Date.now() + resetInSeconds * 1000).toISOString() },
    { kind: "weekly", group: "weekly", percent: 4, resets_at: null },
  ],
  extra_usage: {
    is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25,
    currency: "USD", disabled_reason: "", spend_limit_reached: false,
  },
  at,
});

// The second server life: a child process on the same data directory. Reports its port on stdout; it is ended by
// SIGTERM (closes the server cleanly).
//
// The port comes only once the child's RESTART has run: resumeInterruptedWork and the queue (runInputsRestartGrace)
// fire at once (CBASE_RESTART_GRACE_MS=0), and the child reports only afterwards (test seam restartGraceCycles in
// server.js). Otherwise "nothing runs by itself in the second life" would be asked within the 2.5 s BEFORE the
// restart and prove nothing - now the restart had its chance before anyone asks.
function secondLiveness({ dataRoot, webDir, root }) {
  const runner = path.join(root, "second-liveness.mjs");
  fs.writeFileSync(runner, `
import { restartGraceCycles, startServer } from ${JSON.stringify(SERVER_JS)};
const server = await startServer({ port: 0, dataRoot: ${JSON.stringify(dataRoot)}, webDir: ${JSON.stringify(webDir)}, pickDirectory: null, notify: null });
while (restartGraceCycles() < 1) await new Promise((r) => setTimeout(r, 10));
process.stdout.write("PORT " + server.address().port + "\\n");
process.on("SIGTERM", () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
`);
  const child = spawn(process.execPath, [runner], { env: { ...process.env, CBASE_RESTART_GRACE_MS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stderr.on("data", (c) => { out += c; });
  const port = new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => {
      out += c;
      const m = /^PORT (\d+)$/m.exec(String(c));
      if (m) resolve(Number(m[1]));
    });
    child.once("exit", (code) => reject(new Error(`second life ended before the start (code ${code}):\n${out.slice(-2000)}`)));
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 8000).unref();
  });
  return { child, port, stop, log: () => out };
}

test("Restart: a message queued behind the parked continuation survives and runs after the reset", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-run-inputs-"));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL,
    HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS, NPX_BIN: process.env.NPX_BIN,
  };
  const turnLog = path.join(root, "turns.txt");
  const turns = () => { try { return fs.readFileSync(turnLog, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const dataRoot = path.join(root, "data-root");
  const webDir = path.join(root, "web");
  let first = null, second = null, reader = null;
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    // The first life (in the test process) has no restart; the second runs its own at once (see secondLiveness).
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3600_000);
    isolateCredentials(root);
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude(turnLog));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);

    // -- First life: gate on, window full, message one parks, message two queues --
    first = await startServer({ port: 0, dataRoot, webDir, pickDirectory: null, notify: null });
    const base1 = `http://127.0.0.1:${first.address().port}`;
    store.setSetting("usage_cache_v1", JSON.stringify(usageSeed({ percent: 100 })));
    await json(`${base1}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const ws = await json(`${base1}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Persistence", path: wsPath }) });
    const chat = await json(`${base1}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions", title: "Queue" }),
    });
    const beforeParking = Date.now();
    const one = await json(`${base1}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "message one" }) });
    assert.equal(one.queued, false);
    const wait = await waitFor(async () => (await json(`${base1}/api/chats/${chat.id}/auto-continue`)).wait || null, "gate row of message one");
    assert.equal(wait.reason, "credit", "precondition: message one is parked at the gate");
    const two = await json(`${base1}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "message two" }) });
    assert.equal(two.queued, true, "message two was not queued");
    assert.equal(two.parked, true, "the queueing does not know the parked continuation");
    assert.deepEqual(turns(), [], `a turn ran in the first life: ${JSON.stringify(turns())}`);
    const logBefore = await json(`${base1}/api/chats/${chat.id}/log`);
    assert.deepEqual(logBefore.filter((m) => m.role === "user").map((m) => m.text), ["message one"],
      "a QUEUED message is not in the history yet");

    // The first life ends while both wait: the row in pending_resumes, the entry in run_inputs. For the second life the
    // window drops to 10 % - the child reads the cache fresh - so the continuation runs through instead of parking again.
    // Measured BEFORE parking: a newer measurement showing the gate free would wake the row already in the restart
    // (account switch) - what is checked here is that it survives the restart as a row.
    await waitForQuiet(base1);
    await new Promise((r) => first.close(r));
    first = null;
    store.setSetting("usage_cache_v1", JSON.stringify(usageSeed({ percent: 10, at: beforeParking })));

    // -- Second life: own process, same DB --
    second = secondLiveness({ dataRoot, webDir, root });
    const base2 = `http://127.0.0.1:${await second.port}`;
    const stream = await fetch(`${base2}/api/chats/${chat.id}/stream`);
    reader = stream.body.getReader();
    const connected = await waitForSse(reader, (evt) => evt.type === "harness" && evt.subtype === "connected");
    assert.deepEqual((connected.queued || []).map((q) => q.text), ["message two"],
      `the queue did not survive the restart: ${JSON.stringify(connected.queued)}\n${second.log().slice(-1500)}`);
    assert.equal(connected.running, false, "nothing runs by itself in the second life - the row stands until the reset (the restart has run, see secondLiveness)");
    assert.deepEqual(turns(), [], `the restart of the second life started a turn: ${JSON.stringify(turns())}`);
    const wait2 = (await json(`${base2}/api/chats/${chat.id}/auto-continue`)).wait;
    assert.equal(wait2?.reason, "credit", "the wait row itself did not survive the restart");
    await reader.cancel();
    reader = null;

    // The reset (triggered by hand): the continuation runs through, its end takes over the queued entry - both turns,
    // in the order they were sent.
    const now = await json(`${base2}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(now.ok, true, `the continuation did not start: ${JSON.stringify(now)}`);
    const log = await waitFor(async () => {
      const l = await json(`${base2}/api/chats/${chat.id}/log`);
      return l.filter((m) => m.role === "assistant").length >= 2 ? l : null;
    }, "two answers in the second life", 100);
    // History user -> assistant -> user -> assistant: first the parked continuation, then the queued entry - each with
    // its own answer.
    const followUp = log.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.text]);
    assert.deepEqual(followUp.map((x) => x[0]), ["user", "assistant", "user", "assistant"], JSON.stringify(followUp));
    assert.equal(followUp[0][1], "message one");
    assert.match(followUp[1][1], /^DONE/);
    assert.equal(followUp[2][1], "message two");
    assert.match(followUp[3][1], /^DONE/);
    assert.equal(turns().length, 2, `exactly two turns: ${JSON.stringify(turns())}`);
    assert.match(turns()[0], /message one/);
    assert.match(turns()[1], /message two/);
    await waitForQuiet(base2);
    const afterwards = await fetch(`${base2}/api/chats/${chat.id}/stream`);
    reader = afterwards.body.getReader();
    const empty = await waitForSse(reader, (evt) => evt.type === "harness" && evt.subtype === "connected");
    assert.deepEqual(empty.queued, [], "after the run nothing is left in the queue");
    await reader.cancel();
    reader = null;
  } finally {
    // Open connections FIRST - server.close() waits for each.
    if (reader) { try { await reader.cancel(); } catch {} }
    if (second) await second.stop();
    if (first) await new Promise((r) => first.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A failure during cleanup is a statement about the cleanup, not about the product.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

// The queue sweeper (runInputsRestartGrace): an entry whose runner died with the old process - here: queued during a
// turn, the server falls BEFORE the turn ends and the active_runs row is already gone - has nobody to take it over
// after the restart. It must start by itself. Reproduced through the store: row in run_inputs, no wait row, no active_run.
test("Restart: an entry without a runner is started by itself after the start", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-run-inputs-sweep-"));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL,
    HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS, NPX_BIN: process.env.NPX_BIN,
  };
  const turnLog = path.join(root, "turns.txt");
  const turns = () => { try { return fs.readFileSync(turnLog, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const dataRoot = path.join(root, "data-root");
  const webDir = path.join(root, "web");
  let first = null, second = null;
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3600_000);
    isolateCredentials(root);
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude(turnLog));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);

    first = await startServer({ port: 0, dataRoot, webDir, pickDirectory: null, notify: null });
    const base1 = `http://127.0.0.1:${first.address().port}`;
    store.setSetting("usage_cache_v1", JSON.stringify(usageSeed({ percent: 10 })));
    const ws = await json(`${base1}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Sweep", path: wsPath }) });
    const chat = await json(`${base1}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions", title: "Sweep" }),
    });
    await waitForQuiet(base1);
    await new Promise((r) => first.close(r));
    first = null;
    // The entry as deliverUserPrompt writes it - with the attachment DESCRIPTION (the bytes lie in the attachment
    // directory, not in the row). `todos: true` is an OLD entry from the time of the "create todo" switch (gone since):
    // it must pass the restart silently like any other.
    const attDir = path.join(dataRoot, "attachments", chat.id);
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, "note.txt"), "Content");
    store.replaceRunInputs(chat.id, [{
      id: "11111111-1111-4111-8111-111111111111", prompt: "Orphaned job", display: "Orphaned job",
      attachments: [{ name: "note.txt", file: "note.txt", mime: "text/plain", size: 6 }], cause: "user", silent: false, todos: true,
    }]);
    assert.equal(store.listRunInputs().length, 1, "precondition: the row is in the DB");
    assert.equal(store.getPendingResume(chat.id), null, "precondition: no wait row");

    second = secondLiveness({ dataRoot, webDir, root });
    const base2 = `http://127.0.0.1:${await second.port}`;
    const log = await waitFor(async () => {
      const l = await json(`${base2}/api/chats/${chat.id}/log`);
      return l.some((m) => m.role === "assistant" && m.text.startsWith("DONE")) ? l : null;
    }, "answer to the orphaned job", 100);
    const user = log.find((m) => m.role === "user");
    assert.equal(user?.text, "Orphaned job");
    assert.deepEqual((user?.attachments || []).map((a) => a.file), ["note.txt"], "the attachment description was lost at restart");
    assert.equal(turns().length, 1, `exactly one turn: ${JSON.stringify(turns())}`);
    assert.match(turns()[0], /Orphaned job/);
    await waitForQuiet(base2);
    await second.stop();
    second = null;
    assert.deepEqual(store.listRunInputs(), [], "the taken-over entry is still in the DB");
  } finally {
    if (second) await second.stop();
    if (first) await new Promise((r) => first.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});
