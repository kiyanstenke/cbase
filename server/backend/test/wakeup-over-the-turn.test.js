// The wakeup over the turn (guard WK; model monitor-over-the-turn.test.js).
//
// The incident: the agent set `cbase_wakeup`, and the chat stood as "running" until the wake time — stop button instead of
// send, "queue message"; `/api/active-runs` reported `phase: "waiting"`, `/api/runs/active` `runs: 1`, `busy: true`,
// `open.waitPhase: 1`. The wakeup belonged to the TURN: do-run.js held the CLI process in the wait phase until the wake time
// to inject the continuation into the same process. Now it belongs to the CHAT (runs/wakeup.js): the turn ends after setting,
// the chat is free, and at the wake time the owner delivers the continuation via the wake path.
//
// What is held here, each with a counter-test against the old state (shown red):
//  (1) The turn ends after setting: `runs` 0, `busy` false, no wait phase, no row in the run overview; the wakeup stands as
//      field `wakeup`, in `connected` (after reload) and at the gateway's schedule clock (`/api/schedules/next`).
//      Counter-test: the old state (do-run.js with `wakeupController`, holdMs with `wakeupAt`) => red at "runs 0" (runs 1,
//      wait phase). `nextWakeup()` struck from the schedules in scheduled/routes.js => red at "schedule clock".
//  (2) The clock delivers the continuation as a NEW turn — silent (no user row), text `[Scheduled continuation]\n<prompt>`;
//      afterwards no wakeup stands. Counter-test: `fire` in runs/wakeup.js without the call of the delivery => red (no
//      continuation).
//  (3) A message of the human in between starts its own turn IMMEDIATELY (not injected into a waiting process) and leaves
//      the wakeup standing. Counter-test: old state => red at "not injected" (`injected: true` into the wait phase).
//  (4) If the wakeup fires while a turn runs, it is queued and comes AFTER the turn. Counter-test: delivery in server.js with
//      tool boundary/reason "agent" => red at the order (the continuation would go into the middle of the turn).
//  (5) Input validation, cap 24 h, a new one replaces the old, `stop: true` cancels — and exactly ONE continuation with the
//      last prompt.
//  (6) Cancelling without a turn: `stop: true` (agent, no hint) and `/wakeup/stop` (`from` required; the human leaves the
//      next turn a silent hint); setting without a turn is 409. Counter-test: `stopWakeup` in runs/wakeup.js without
//      `depositHint` => red at "hint"; old state => red (409 even when cancelling without a turn).
//  (7) The inventory survives a restart: after the start the wakeup stands again (field, clock); an overdue one comes by
//      itself after the start, with the sentence "Late". Counter-test: the hook registration "wakeup-restart-grace" in
//      server.js struck => red at "overdue"; `loadWakeup` struck => red at "stands after the restart".
//  (8) Archive and delete take it along silently. Counter-test: the archive observer in server.js without `closeWakeup` => red.
//  (9) Prompt, tool description and answer say the same from ONE source (mcp/wakeup-rule.js); "the run stays open until then"
//      appears nowhere any more.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer, restartGraceCycles } from "../electron/server/server.js";
import { wakeupNow, wakeupOf } from "../electron/server/runs/wakeup.js";
import { buildSystemPrompt } from "../electron/server/runs/system-prompt.js";
import { serviceTools } from "../electron/mcp/tools/services.js";
import { WAKEUP_LIFETIME, WAKEUP_AFTER_SETTING } from "../electron/mcp/wakeup-rule.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

// The fake CLI. Every turn can be a new process: no state in the process.
//   "[Scheduled continuation …" (anywhere in the text) -> "CONTINUATION <text>" — this turn comes ONLY if the server delivers.
//   "EDGE_CASES" -> calls the route in turn with nonsense, valid, replacing, cap, cancel, last wakeup (case 5).
//   "WAKE: {json}" -> POST …/wakeup with this body (like cbase_wakeup over the MCP server), answer "WAKEUP <status> <body>".
//   "HOLD" -> waits at the gate `<gates>/hold` (a turn that is computing), then "HELD".
//   otherwise "ECHO <text>" (with the silent hints the turn carries).
const fakeClaude = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
process.stdin.on("end", () => process.exit(0));
const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config") + 1], "utf8"));
const chatId = cfg.mcpServers.cbase.env.CBASE_CHAT_ID;
const base = process.env.CBASE_TEST_BASE;
const gates = process.env.CBASE_WK_GATES;
const textOf = (msg) => { const c = msg.message && msg.message.content; return typeof c === "string" ? c : (c || []).map((b) => b.text || "").join(""); };
const wake = async (body) => {
  const r = await fetch(base + "/api/chats/" + chatId + "/wakeup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.status + " " + (await r.text()).replace(/\\s+/g, " ");
};
const respond = (text) => {
  say({ type: "assistant", message: { content: [{ type: "text", text }] } });
  say({ type: "result", result: text.slice(0, 40), session_id: "wk" });
};
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const text = textOf(msg);
  say({ type: "system", subtype: "init", session_id: "wk" });
  if (text.includes("[Scheduled continuation")) return respond("CONTINUATION " + text);
  if (text.includes("EDGE_CASES")) {
    const out = [];
    out.push("A=" + await wake({ prompt: "no time" }));
    out.push("B=" + await wake({ delaySeconds: 0 }));
    out.push("C=" + await wake({ delaySeconds: 900, prompt: "FIRST" }));
    out.push("D=" + await wake({ delaySeconds: 999999, prompt: "SECOND replaces" }));
    out.push("E=" + await wake({ stop: true }));
    out.push("F=" + await wake({ delaySeconds: 3600, prompt: "LAST wakeup" }));
    return respond(out.join(" | "));
  }
  const i = text.indexOf("WAKE: ");
  if (i >= 0) return respond("WAKEUP " + await wake(JSON.parse(text.slice(i + 6).split("\\n")[0])));
  if (text.includes("HOLD")) {
    fs.writeFileSync(gates + "/hold.waiting", "1");
    while (!fs.existsSync(gates + "/hold")) await new Promise((r) => setTimeout(r, 20));
    return respond("HELD");
  }
  respond("ECHO " + text.slice(0, 4000));
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

// Wait for a STATE, without a deadline (no clock a test turns red at; the emergency brake is the suite).
async function waitUntil(fn, what) {
  for (let i = 0; ; i++) {
    const v = await fn();
    if (v) return v;
    if (i && i % 1500 === 0) process.stderr.write(`[wakeup-test] still waiting for: ${what}\n`);
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

async function newChat(base, wsPath, title = "WK-Test") {
  const ws = await ok(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: `WK ${title}`, path: wsPath }) });
  const chat = await ok(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await ok(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}

function environment(root, env = {}) {
  const bin = path.join(root, "fake-claude");
  fs.writeFileSync(bin, fakeClaude);
  fs.chmodSync(bin, 0o755);
  const gates = path.join(root, "gates");
  fs.mkdirSync(gates, { recursive: true });
  const prior = {};
  const set = { CLAUDE_BIN: bin, CBASE_RESTART_GRACE_MS: RESTART_GRACE_OFF, CBASE_WK_GATES: gates, ...env };
  for (const [k, v] of Object.entries(set)) { prior[k] = process.env[k]; process.env[k] = v; }
  const wsPath = path.join(root, "workspace");
  fs.mkdirSync(wsPath, { recursive: true });
  return { gates, wsPath, back: () => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wk-"));
  const u = environment(root);
  const ctx = { root, wsPath: u.wsPath, gates: u.gates, server: null, base: "" };
  try {
    Object.assign(ctx, await start(root));
    await fn(ctx);
    await waitForQuiet(ctx.base);
  } finally {
    try { fs.writeFileSync(path.join(u.gates, "hold"), ""); } catch { /* cleanup */ }
    await close(ctx.server);
    u.back();
    delete process.env.CBASE_TEST_BASE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleanup says nothing */ }
  }
}

const log = (base, chatId) => ok(`${base}/api/chats/${chatId}/log`);
const metas = async (base, chatId) => (await log(base, chatId)).filter((m) => m.role === "meta").length;
const responses = async (base, chatId) => (await log(base, chatId)).filter((m) => m.role === "assistant").map((m) => m.text);
const active = (base) => ok(`${base}/api/runs/active`);

/** Send a message and wait for the end of its turn (one more `meta` row). -> the last answer. */
async function turn(base, chatId, text) {
  const before = await metas(base, chatId);
  const r = await ok(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
  await waitUntil(async () => (await metas(base, chatId)) > before, `end of the turn "${text.slice(0, 30)}"`);
  return { response: (await responses(base, chatId)).pop() || "", r };
}
/** Set a wakeup through a turn; -> its wake time (from the route's answer). */
async function place(base, chatId, args) {
  const { response } = await turn(base, chatId, `WAKE: ${JSON.stringify(args)}`);
  const m = /^WAKEUP 201 .*"wakeupAt": ?(\d+)/.exec(response);
  assert.ok(m, `the wakeup was not set: ${response}`);
  return Number(m[1]);
}
/** The first event of the stream (`connected`) — as after a reload. */
async function connect(base, chatId) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/chats/${chatId}/stream`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream without connected");
      buf += dec.decode(value, { stream: true });
      const i = buf.indexOf("\n\n");
      if (i < 0) continue;
      const row = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      if (row) return JSON.parse(row.slice(6));
      buf = buf.slice(i + 2);
    }
  } finally { ac.abort(); }
}

test("(1) the turn ends after setting — no run, no wait phase, not busy; the wakeup stands as a field, in connected and at the schedule clock", async () => {
  await withServer(async ({ base, wsPath }) => {
    const chat = await newChat(base, wsPath);
    const at = await place(base, chat.id, { delaySeconds: 3600, prompt: "Check the build", reason: "Build takes an hour" });
    await waitForQuiet(base);
    const st = await active(base);
    // The incident: here stood runs 1, busy true, open.waitPhase 1.
    assert.equal(st.runs, 0, "after setting no turn runs any more");
    assert.equal(st.busy, false, "a waiting wakeup does not hold busy (deploy gate, UI)");
    assert.equal(st.open.waitPhase, 0, "no wait phase");
    assert.equal(st.quiet, true, "a wakeup waits for a clock — quiet");
    assert.deepEqual(st.wakeup.map((w) => [w.chatId, w.at]), [[chat.id, at]], "the field `wakeup` names it");
    assert.equal(((await ok(`${base}/api/active-runs`)).items || []).some((i) => i.chatId === chat.id), false, "the chat is not in the run overview");
    const c = await connect(base, chat.id);
    assert.equal(c.running, false);
    assert.equal(c.waiting, false);
    assert.equal(c.wakeupAt, at, "after the reload the client knows the wakeup");
    assert.equal(c.wakeupReason, "Build takes an hour");
    assert.equal(c.wakeupPrompt, "Check the build");
    assert.equal((await ok(`${base}/api/schedules/next`)).nextAt, at, "the gateway's schedule clock knows it (the reaper does not put the container to sleep)");
    assert.ok(wakeupOf(chat.id));
  });
});

test("(2) the clock delivers the continuation as a new turn — silent, with the prompt; afterwards no wakeup stands", async () => {
  await withServer(async ({ base, wsPath }) => {
    const chat = await newChat(base, wsPath);
    // The real clock (one second) — the only case that does not fire via the test seam: waits for the turn, not for the time.
    await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `WAKE: ${JSON.stringify({ delaySeconds: 1, prompt: "Check the build" })}` }) });
    // For the answer, not for `meta`: if the clock fires before the end of the setting run, the continuation goes into the
    // same process at `result` (queued, see (4)) — one run, two turns, ONE meta row.
    await waitUntil(async () => (await responses(base, chat.id)).some((t) => t.startsWith("CONTINUATION")), "the continuation turn");
    await waitForQuiet(base);
    const a = await responses(base, chat.id);
    assert.equal(a.length, 2, JSON.stringify(a));
    assert.match(a[0], /^WAKEUP 201 /);
    assert.match(a[1], /^CONTINUATION [\s\S]*\[Scheduled continuation\]\nCheck the build/);
    const user = (await log(base, chat.id)).filter((m) => m.role === "user").map((m) => m.text);
    assert.equal(user.some((t) => t.includes("Scheduled continuation")), false, "the continuation writes no user row");
    assert.equal(wakeupOf(chat.id), null);
    assert.deepEqual((await active(base)).wakeup, []);
    assert.equal((await connect(base, chat.id)).wakeupAt, 0);
  });
});

test("(3) a message of the human in between starts its own turn immediately and leaves the wakeup standing", async () => {
  await withServer(async ({ base, wsPath }) => {
    const chat = await newChat(base, wsPath);
    await place(base, chat.id, { delaySeconds: 3600, prompt: "Continue now" });
    const { response, r } = await turn(base, chat.id, "Short interim question");
    assert.equal(r.injected, false, "not injected into a waiting process — there is none");
    assert.equal(r.queued, false, "not queued — the chat is free");
    assert.match(response, /^ECHO [\s\S]*Short interim question/);
    assert.ok(wakeupOf(chat.id), "the wakeup still stands after the interim question");
    const before = await metas(base, chat.id);
    assert.equal(wakeupNow(chat.id), true);
    await waitUntil(async () => (await metas(base, chat.id)) > before, "the continuation turn");
    await waitForQuiet(base);
    const a = await responses(base, chat.id);
    assert.equal(a.length, 3, JSON.stringify(a));
    assert.match(a[2], /Continue now/);
  });
});

test("(4) if the wakeup fires during a turn, it is queued and comes after the turn", async () => {
  await withServer(async ({ base, wsPath, gates }) => {
    const chat = await newChat(base, wsPath);
    await place(base, chat.id, { delaySeconds: 3600, prompt: "After the hold" });
    const before = await metas(base, chat.id);
    await ok(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD" }) });
    await waitUntil(() => fs.existsSync(path.join(gates, "hold.waiting")), "the gate \"hold\"");
    assert.equal(wakeupNow(chat.id), true, "the delivery accepted the continuation (queued)");
    const item = ((await ok(`${base}/api/active-runs`)).items || []).find((i) => i.chatId === chat.id);
    assert.equal(item?.queued, 1, `the continuation waits in the queue: ${JSON.stringify(item)}`);
    fs.writeFileSync(path.join(gates, "hold"), "");
    await waitUntil(async () => (await responses(base, chat.id)).some((t) => t.startsWith("CONTINUATION")), "the continuation");
    await waitForQuiet(base);
    assert.ok((await metas(base, chat.id)) > before);
    const a = await responses(base, chat.id);
    assert.deepEqual(a.slice(1).map((t) => t.split(" ")[0]), ["HELD", "CONTINUATION"], JSON.stringify(a));
  });
});

test("(5) input validation, cap 24 h, a new one replaces the old, stop cancels — exactly ONE continuation with the last prompt", async () => {
  await withServer(async ({ base, wsPath }) => {
    const chat = await newChat(base, wsPath);
    const prior = Date.now();
    const { response: report } = await turn(base, chat.id, "EDGE_CASES");
    const after = Date.now();
    assert.match(report, /A=400 .*delaySeconds/, report);
    assert.match(report, /B=400 .*delaySeconds/, report);
    assert.match(report, /C=201 .*"ok": ?true/, report);
    assert.match(report, /D=201 .*"replaced": ?true/, report);
    const at = /D=201 .*?"wakeupAt": ?(\d+)/.exec(report);
    assert.ok(at, `no wakeupAt in the answer: ${report}`);
    const tagMs = 24 * 3600_000;
    assert.ok(Number(at[1]) >= prior + tagMs && Number(at[1]) <= after + tagMs, `cap does not apply: ${new Date(Number(at[1])).toISOString()}`);
    assert.match(report, /E=200 .*"cancelled": ?true/, report);
    assert.match(report, /F=201 .*"replaced": ?false/, report);
    assert.equal((await active(base)).wakeup.length, 1, "at most ONE wakeup per chat");
    const before = await metas(base, chat.id);
    assert.equal(wakeupNow(chat.id), true);
    await waitUntil(async () => (await metas(base, chat.id)) > before, "the continuation");
    await waitForQuiet(base);
    assert.equal(wakeupNow(chat.id), false, "afterwards none stands");
    const a = await responses(base, chat.id);
    assert.equal(a.length, 2, `exactly one continuation: ${JSON.stringify(a)}`);
    assert.match(a[1], /LAST wakeup/);
    assert.doesNotMatch(a[1], /FIRST|SECOND/);
  });
});

test("(6) cancel without a turn: stop (agent) and the human's stop (from required, silent hint); setting without a turn is 409", async () => {
  await withServer(async ({ base, wsPath }) => {
    const chat = await newChat(base, wsPath);
    const url = `${base}/api/chats/${chat.id}/wakeup`;
    const without = await json(url, { method: "POST", body: JSON.stringify({ delaySeconds: 60, prompt: "whatever" }) });
    assert.equal(without.status, 409);
    assert.match(without.body.error, /run|turn/);
    // The agent cancels from a later turn — here without a turn, via the route: no hint.
    await place(base, chat.id, { delaySeconds: 3600, prompt: "First" });
    assert.deepEqual((await json(url, { method: "POST", body: JSON.stringify({ stop: true }) })).body, { ok: true, cancelled: true });
    assert.equal(wakeupOf(chat.id), null);
    assert.deepEqual((await json(url, { method: "POST", body: JSON.stringify({ stop: true }) })).body, { ok: true, cancelled: false }, "nothing left to cancel");
    // The human stops via the card.
    await place(base, chat.id, { delaySeconds: 3600, prompt: "Second prompt" });
    const stop = `${base}/api/chats/${chat.id}/wakeup/stop`;
    assert.equal((await json(stop, { method: "POST", body: JSON.stringify({}) })).status, 400, "a missing `from` is no statement");
    assert.equal((await json(stop, { method: "POST", body: JSON.stringify({ from: "someone" }) })).status, 400);
    assert.ok(wakeupOf(chat.id), "a rejected stop leaves it standing");
    assert.deepEqual((await json(stop, { method: "POST", body: JSON.stringify({ from: "human" }) })).body, { ok: true, cancelled: true });
    assert.equal(wakeupOf(chat.id), null);
    assert.equal((await connect(base, chat.id)).wakeupAt, 0, "the card disappears");
    // The next turn learns of it (silent hint) — the first cancel by the agent deposited none.
    const { response } = await turn(base, chat.id, "What about the wakeup?");
    assert.match(response, /Der Mensch hat deinen Wecker .*Second prompt.* gestoppt/);
    assert.doesNotMatch(response, /First/);
  });
});

test("(7) restart: the wakeup stands again afterwards; an overdue one comes by itself after the start, marked as late", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wk-new-"));
  const u = environment(root);
  let server = null;
  try {
    let base;
    ({ server, base } = await start(root));
    const chat = await newChat(base, u.wsPath);
    const at = await place(base, chat.id, { delaySeconds: 3600, prompt: "Continue after the restart" });
    await waitForQuiet(base);
    await close(server);
    server = null;
    const f = findInventory(root);
    const inventory = () => JSON.parse(fs.readFileSync(f, "utf8"));
    assert.equal(inventory()[0].at, at, "the inventory is on disk");
    // First restart: it stands again, with the same time.
    process.env.CBASE_RESTART_GRACE_MS = "0";
    let n = restartGraceCycles();
    ({ server, base } = await start(root));
    assert.deepEqual((await active(base)).wakeup.map((w) => w.at), [at], "the wakeup stands after the restart (loaded before listen)");
    await waitUntil(() => restartGraceCycles() > n, "post-start");
    assert.equal((await connect(base, chat.id)).wakeupAt, at);
    await close(server);
    server = null;
    // Second restart with a time that passed during the restart: it comes by itself.
    const rows = inventory();
    rows[0].at = Date.now() - 5 * 60_000;
    fs.writeFileSync(f, JSON.stringify(rows));
    n = restartGraceCycles();
    ({ server, base } = await start(root));
    const before = await metas(base, chat.id);
    await waitUntil(() => restartGraceCycles() > n, "post-start");
    await waitUntil(async () => (await metas(base, chat.id)) > before, "the overdue continuation");
    await waitForQuiet(base);
    const a = await responses(base, chat.id);
    assert.match(a[a.length - 1], /Continue after the restart[\s\S]*(Verspätet|Late)/);
    assert.deepEqual((await active(base)).wakeup, []);
    assert.equal(fs.existsSync(f), false, "the inventory is empty — the file is gone");
  } finally {
    await close(server);
    u.back();
    delete process.env.CBASE_TEST_BASE;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleanup says nothing */ }
  }
});
// The data folder lies under dataRoot (app-state.js DIRS.data) — found instead of guessed: an anchor that throws if it finds nothing.
function findInventory(root) {
  const search = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === "wakeup-open.json") return p;
      if (e.isDirectory()) { const t = search(p); if (t) return t; }
    }
    return null;
  };
  const f = search(root);
  if (!f) throw new Error(`no wakeup-open.json under ${root}`);
  return f;
}

test("(8) archive and delete take the wakeup along silently", async () => {
  await withServer(async ({ base, wsPath }) => {
    for (const way of ["archive", "erase"]) {
      const chat = await newChat(base, wsPath, `WK ${way}`);
      await place(base, chat.id, { delaySeconds: 3600, prompt: way });
      await waitForQuiet(base);
      if (way === "archive") await ok(`${base}/api/chats/${chat.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
      else await ok(`${base}/api/chats/${chat.id}`, { method: "DELETE" });
      assert.equal(wakeupOf(chat.id), null, `${way}: the wakeup is gone`);
      assert.equal((await active(base)).wakeup.some((w) => w.chatId === chat.id), false);
    }
  });
});

test("(9) prompt, tool description and answer say the same from ONE source", async (t) => {
  const prompt = buildSystemPrompt("");
  const tool = serviceTools.find((x) => x.name === "cbase_wakeup");
  assert.ok(tool, "cbase_wakeup is missing from the catalog");
  assert.ok(prompt.includes(WAKEUP_LIFETIME), "the system prompt does not carry the promise verbatim");
  assert.ok(tool.description.includes(WAKEUP_LIFETIME), "the tool description does not carry the promise verbatim");
  for (const [where, text] of [["prompt", prompt], ["description", tool.description], ["answer", WAKEUP_AFTER_SETTING]]) {
    assert.doesNotMatch(text, /run stays (open )?until then|keeps the run open/i, `${where}: the old promise "the run stays open"`);
  }
  t.diagnostic(`promise ${WAKEUP_LIFETIME.length} characters, description ${tool.description.length} characters`);
  // The route's answer carries the instruction — driven in (1)…(6); here the contract of the source.
  assert.match(WAKEUP_AFTER_SETTING, /End your turn now/);
});
