// Limits and stall of workflow agents — main seam with the agent harness: real server, real cbase MCP server, real agent
// core; only the providers are faked (Claude AND Codex in one server).
//
// What holds: a workflow agent at the usage limit PARKS through the per-agent park mechanism — in its run's journal as
// "waiting" with reason "limit" plus the park state, never in the chat's wait row. While it parks, the run starts no new
// agent of the SAME provider (also "waiting"/"limit"); branches of other providers keep running; at the reset the parked
// ones resume. The park state survives a hard restart (the restart takes the agent back up parked instead of starting it
// anew). Without auto-continue nothing parks: agent() returns null, log() names the agent. At the credit gate (>= 99 %,
// Claude only) a new agent waits with reason "credit-gate", a Codex agent starts; when the human switches the gate off, it
// starts. Stall: 180 s without progress => restart, up to 5 times, then null; the clock stands while a tool call runs.
//
// Without a clock: the reset is two hours away (the REAL CLI 2.1.280 wording "You've hit your session limit · resets
// 5:40pm (Europe/Berlin)" — not "usage limit reached", which was already recognized by accident), and the test wakes the
// agents itself (`wakeParkedNow`, in the server process via `ctx.wakeParked()`); the stall deadline is one hour (as in the
// gate), and the test ADVANCES the stall clock (`advanceStallClock`). It waits for events (journal, transcript, the fakes'
// files), never for a duration.
//
// Counter-tests (which sabotage turns which test red):
//   - parking.js `parked` true for EVERY provider (no per-provider parking) => "main seam" red (c1 waits too);
//   - runs/agents.js `atLimit` set to null (no per-agent park mechanism) => "main seam" red (A returns failed/null);
//   - run.js slotTake without the limit branch (no parking at run level) => "main seam" red (b starts);
//   - run.js without the park state from the journal (`parkInJournal` empty) => "restart" red (new spawn without --resume);
//   - run.js without `nullLog` => "without auto-continue" red; settings/routes.js without `wakeGateWaiting()` => "gate" red;
//   - runs/agents.js without `stallRule: workflowStallRule` => "stall" red (failed after the first standstill);
//   - gate-wakeup.js without `wakeGateWaiting()` => "account switch" red (the agent keeps waiting without hanging).
process.env.CBASE_DYNWF_STAGGER_MS = "0";
process.env.CBASE_DYNWF_STALL_MS = String(3_600_000);

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { advanceStallClock, wakeParkedNow } from "../electron/server/runs/agents.js";
import { gateWaitingCount } from "../electron/server/dynworkflows/parking.js";
import { wakeGateWaitingIfFree } from "../electron/server/dynworkflows/gate-wakeup.js";
import * as store from "../electron/server/store.js";

const DEADLINE = 3_600_000;
const CODEX = "codex::gpt-5.6-sol";

// The main agent: "WF[<tag>]:{json}" calls cbase_dynamic_workflow (result under wf-<tag>); every other message
// gets "Reply"; a completion notice is read.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    say({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const i = text.indexOf("WF[");
  if (i >= 0) {
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test only waits for the file to exist
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    finished();
    say({ type: "result", result: "Workflow started", session_id: "main-session" });
    return;
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Reply to " + text.slice(0, 40) }] } });
  finished();
  say({ type: "result", result: "Response", session_id: "main-session" });`;

// A Claude workflow agent. {TAG:x} names it (every spawn appends an "x" to sub-start-<tag>); {LIMIT}: the FIRST spawn
// fails at the limit with the wording of CLI 2.1.280 (template `uh`, reset from `Pc`: two hours away, local time), the
// continuation (--resume sub-<tag>-s) reports; {GATE:x} holds it at gate x-<spawn count>; {HAENGT}: one event, then
// standstill; {WERKZEUG:x}: an open tool call until gate x-<spawn count>, then standstill — from the second spawn on
// both report.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const further = arg("--resume");
    let tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    if (further && further.startsWith("sub-") && further.endsWith("-s")) tag = further.slice(4, -2);
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    const nr = fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length;
    if (job.includes("{LIMIT}") && nr === 1) {
      say({ type: "system", subtype: "init", session_id: "sub-" + tag + "-s" });
      const r = new Date(Date.now() + 2 * 3600 * 1000);
      const clock = r.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/[ \\u202f]([AP]M)/i, (u, i) => i.toLowerCase());
      process.stderr.write("You've hit your session limit · resets " + clock + " (Europe/Berlin)\\n");
      setTimeout(() => process.exit(1), 30);
      return;
    }
    say({ type: "assistant", message: { id: "s1-" + tag + nr, content: [{ type: "text", text: "working " + nr }] } });
    if (job.includes("{HAENGT}")) { await new Promise(() => {}); }
    if (job.includes("{WERKZEUG:") && nr === 1) {
      const w = job.split("{WERKZEUG:")[1].split("}")[0];
      const id = "tu-" + w + "-" + nr;
      say({ type: "assistant", message: { id: "w-" + nr, content: [{ type: "tool_use", id, name: "Bash", input: { command: "make" } }] } });
      await gate(w + "-" + nr);
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "built" }] } });
      await new Promise(() => {});
    }
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0] + "-" + nr);
    finished();
    say({ type: "result", result: "Finding " + tag + " #" + nr + " resumed=" + (further === "sub-" + tag + "-s"), session_id: "sub-" + tag + "-s" });`;

// A Codex workflow agent (`exec --json`, prompt as the last argument): {TAG:x}, {GATE:x} as above (gate x without spawn count).
const CODEX_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often only waits for a file to EXIST and then reads it — without the rename it read an empty one under
// load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const text = argv[argv.length - 1] || "";
const ab = text.lastIndexOf("Here is the task:");
const job = ab >= 0 ? text.slice(ab) : text;
const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "cx";
fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
say({ type: "thread.started", thread_id: "codex-" + tag });
say({ type: "turn.started" });
(async () => {
  if (job.includes("{GATE:")) {
    const file = path.join(LOCATION, "gates", job.split("{GATE:")[1].split("}")[0]);
    fs.writeFileSync(file + ".waiting", String(process.pid));
    await new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); r(); } }, 20); });
  }
  say({ type: "item.completed", item: { id: "response", type: "agent_message", text: "Codex " + tag } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const put = (url, body) => json(url, { method: "PUT", body: JSON.stringify(body) });
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Limits', phases: [{ title: 'Eins' }] }\n${body}\n`;
async function start(ctx, tag, body) {
  await post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text: `WF[${tag}]:${JSON.stringify({ script: script(tag, body) })}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(r.status, "started", JSON.stringify(r));
  return r;
}
const spawns = (root, tag) => { const f = path.join(root, `sub-start-${tag}`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0; };
const entries = (runId, n) => store.readDynJournal(runId).filter((e) => e.n === n);
// The first state of an agent() after "launched" (started or waiting) — waits until there is one.
const firstState = (runId, n) => waitForTruthy(() => entries(runId, n).find((e) => e.kind !== "launched") || null, `state of agent #${n}`);
const toEnd = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} ended`);
const turnPast = (ctx) => waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn ended");

// Without an account (model: agent-credit-gate.test.js): otherwise utilization and window would come from the developer's REAL account.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dynwf-limit-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleaning up ${root}: ${e.code || e.message}`); }
  }
}
// Session window 100 %, measured now, reset in one hour (field names as in fetchUsageLimits).
function seedFullSession() {
  const at = Date.now();
  const iso = new Date(at + 3_600_000).toISOString();
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: 100, resetsAt: iso }, sevenDay: { utilization: 4, resetsAt: null },
    limits: [{ kind: "session", group: "session", percent: 100, resets_at: iso }, { kind: "weekly", group: "weekly", percent: 4, resets_at: null }],
    at,
  }));
}

test("main seam: a Claude agent at the limit parks (\"waiting\", reason limit), the run's next Claude agent waits too, a Codex branch keeps running; no wait row, the chat stays free; at the reset the parked ones resume", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root, gate } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "h", [
      "const a = agent('A {TAG:a} {LIMIT}', { label: 'a' });",
      `const c0 = await agent('C0 {TAG:c0} {GATE:c0}', { model: '${CODEX}', label: 'c0' });`,
      `const [b, c1] = await parallel([() => agent('B {TAG:b}', { label: 'b' }), () => agent('C1 {TAG:c1}', { model: '${CODEX}', label: 'c1' })]);`,
      "return { a: await a, c0, b, c1 };",
    ].join("\n"));
    await turnPast(ctx);

    // A parks: in the journal "waiting" with reason limit, provider, reset and the park state (image with session).
    const a = await waitForTruthy(() => entries(r.runId, 1).find((e) => e.kind === "waiting" || e.kind === "failed" || e.kind === "result") || null, "A parked or ended");
    assert.equal(a.kind, "waiting", `A does not park but ends: ${JSON.stringify(a)}`);
    assert.equal(a.reason, "limit");
    assert.equal(a.provider, "claude");
    assert.ok(a.until > Date.now() + 3_600_000, `reset two hours away: ${new Date(a.until).toISOString()}`);
    assert.equal(a.image?.sessionId, "sub-a-s", "the park state carries the session for the continuation");
    assert.equal(a.image?.state, "parked");
    assert.deepEqual(entries(r.runId, 1).map((e) => e.kind), ["launched", "started", "waiting"]);

    // Now it goes on: b (Claude) and c1 (Codex) are called AFTER A parked.
    await gate.reached("c0");
    gate.open("c0");
    const b = await firstState(r.runId, 3);
    const c1 = await firstState(r.runId, 4);
    assert.equal(c1.kind, "started", `the Codex branch waits too: ${JSON.stringify(c1)}`);
    assert.equal(b.kind, "waiting", `the second Claude agent starts despite the parked provider: ${JSON.stringify(b)}`);
    assert.equal(b.reason, "limit");
    assert.equal(b.provider, "claude");
    await waitForTruthy(() => entries(r.runId, 4).some((e) => e.kind === "result"), "c1 fertig");
    assert.equal(spawns(root, "b"), 0, "no process for the waiting Claude agent");
    assert.equal(spawns(root, "a"), 1, "A waits without a process");

    // The chat's wait row stays untouched, and the chat is free: no turn, a message gets answered.
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait ?? null, null, "no wait row for the chat");
    const active = await json(`${base}/api/runs/active`);
    assert.equal(active.runs, 0);
    assert.equal(active.busy, false, "a workflow does not count in busy");
    assert.equal(active.dynWorkflows.length, 1, "the workflow runs (parks)");
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Hello while parked" });
    await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && /Reply to Hello while/.test(m.text)));
    await turnPast(ctx);
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait ?? null, null, "no wait row even after a turn");

    // The reset (injected): A resumes its session, then b starts.
    assert.ok(wakeParkedNow() >= 1, "a park alarm was set");
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { a: "Finding a #2 resumed=true", c0: "Codex c0", b: "Finding b #1 resumed=false", c1: "Codex c1" });
    assert.deepEqual(entries(r.runId, 1).map((e) => e.kind), ["launched", "started", "waiting", "started", "result"]);
    assert.equal(entries(r.runId, 1)[3].resumed, true);
    assert.deepEqual(entries(r.runId, 3).map((e) => e.kind), ["launched", "waiting", "started", "result"]);
    await ctx.waitForIdle();
  }, { claude, codex: CODEX_FAKE }));
});

test("restart: the park state survives a hard restart — the parked agent is taken up again parked, does NOT start before the reset and then continues its session", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    await post(`${base}/api/chats/${chat.id}/message`, { text: `WF[n]:${JSON.stringify({ script: script("n", "const a = await agent('A {TAG:a} {LIMIT}', { label: 'a' });\nreturn { a };") })}` });
    await waitForTruthy(() => fs.existsSync(path.join(root, "wf-n")), "tool result n");
    const r = JSON.parse(fs.readFileSync(path.join(root, "wf-n"), "utf8"));
    assert.equal(r.status, "started", JSON.stringify(r));
    // Straight from the server process's database: it runs in WAL mode (store/db.js), so a reading connection blocks no server
    // writer. (It used to read a FILE COPY — under WAL that misses every commit still in `-wal`.)
    const read = (sql, ...args) => waitForTruthy(() => {
      let db = null;
      try { db = new DatabaseSync(path.join(ctx.dataRoot, "data", "automater.db"), { readOnly: true }); return { rows: db.prepare(sql).all(...args) }; }
      catch (e) { if (/locked|busy/i.test(e?.message)) return null; throw e; }
      finally { db?.close(); }
    }, "database readable").then((x) => x.rows);
    const journal = async () => (await read("SELECT n, kind, entry FROM dyn_workflow_journal WHERE run_id = ? ORDER BY seq", r.runId)).map((z) => ({ n: z.n, kind: z.kind, ...JSON.parse(z.entry) }));
    const run = async () => (await read("SELECT status, attempts, returnValue FROM dyn_workflow_runs WHERE id = ?", r.runId))[0];
    const prior = await waitForTruthy(async () => (await journal()).find((e) => e.n === 1 && ["waiting", "failed", "result"].includes(e.kind)) || null, "A parked or ended");
    assert.equal(prior.kind, "waiting", `A does not park: ${JSON.stringify(prior)}`);
    assert.equal(prior.reason, "limit");
    assert.ok(prior.image?.agentId, "the park state is in the journal");
    assert.equal(spawns(root, "a"), 1);

    await ctx.crash(); // SIGKILL, new server process with immediate restart
    // The restart took the run up and called agent() again (second "launched") — in the same step it took up the parked
    // agent (no await in between, run.js).
    await waitForTruthy(async () => (await journal()).filter((e) => e.kind === "launched").length === 2, "restart has resumed");
    assert.equal((await run()).attempts, 1, "the attempt is counted on the run");
    assert.equal((await run()).status, "running", "the run stands parked instead of running to the end");
    assert.equal(spawns(root, "a"), 1, "the parked agent does not start after the restart before the reset");
    const afterLaunch = (j) => j.slice(j.map((e) => e.kind).lastIndexOf("launched") + 1).map((e) => e.kind);
    // The new attempt carries the parking itself — otherwise the tree (from the last `launched`) would compute "running".
    assert.deepEqual(afterLaunch(await journal()), ["waiting"], "no new start, but the parking in the new attempt");
    assert.equal((await journal()).at(-1).reason, "limit");
    const tree = await json(`${ctx.base}/api/chats/${chat.id}/dyn-workflows/tree`);
    const ag = tree.runs.find((x) => x.runId === r.runId)?.agents?.find((x) => x.n === 1);
    assert.deepEqual([ag?.status, ag?.reason], ["waiting", "limit"], `the tree shows the taken-up agent parked: ${JSON.stringify(ag)}`);

    ctx.wakeParked(); // the reset
    await waitForTruthy(async () => ((await run())?.status !== "running" ? true : null), "run ended");
    const l = await run();
    assert.equal(l.status, "finished");
    assert.deepEqual(JSON.parse(l.returnValue), { a: "Finding a #2 resumed=true" }, "continued through the stored session, not started anew");
    const j = await journal();
    assert.deepEqual(afterLaunch(j), ["waiting", "started", "result"]);
    assert.equal(j.filter((e) => e.kind === "started").at(-1).resumed, true);
    assert.equal(spawns(root, "a"), 2);
    await ctx.waitForIdle();
  }, { claude, childProcess: true }));
});

test("without auto-continue nothing parks: the agent at the limit returns null, log() names it with its label; no wait row", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    await put(`${base}/api/auto-continue`, { enabled: false });
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "o", "const a = await agent('A {TAG:a} {LIMIT}', { label: 'alpha' });\nreturn { a };");
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { a: null });
    assert.deepEqual(entries(r.runId, 1).map((e) => e.kind), ["launched", "started", "failed"], "no \"waiting\"");
    const logs = store.readDynEvents(r.runId).filter((e) => e.kind === "log").map((e) => e.text);
    assert.ok(logs.some((t) => t.includes("“alpha”") && /returned null/.test(t) && /session limit/.test(t)), `log() does not name the agent: ${JSON.stringify(logs)}`);
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait ?? null, null);
    await put(`${base}/api/auto-continue`, { enabled: true });
    await ctx.waitForIdle();
  }, { claude }));
});

test("credit gate on, Claude at 100 %: the new Claude agent waits (reason credit-gate), the Codex agent starts; gate off => the waiting one starts", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root, gate: gateState } = ctx;
    seedFullSession();
    const gate = (on) => put(`${base}/api/credit-gate`, { enabled: on });
    await gate(false);
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "g", [
      `const x0 = await agent('X0 {TAG:x0} {GATE:x0}', { model: '${CODEX}', label: 'x0' });`,
      `const [k, x] = await parallel([() => agent('K {TAG:k}', { label: 'k' }), () => agent('X {TAG:x}', { model: '${CODEX}', label: 'x' })]);`,
      "return { x0, k, x };",
    ].join("\n"));
    await gateState.reached("x0");
    await turnPast(ctx);
    await gate(true);
    gateState.open("x0");
    const k = await firstState(r.runId, 2);
    const x = await firstState(r.runId, 3);
    assert.equal(k.kind, "waiting", `the Claude agent starts at the gate: ${JSON.stringify(k)}`);
    assert.equal(k.reason, "credit-gate");
    assert.equal(k.provider, "claude");
    assert.equal(k.percent, 100);
    assert.equal(x.kind, "started", `the Codex agent waits at the gate: ${JSON.stringify(x)}`);
    await waitForTruthy(() => entries(r.runId, 3).some((e) => e.kind === "result"), "x fertig");
    assert.equal(spawns(root, "k"), 0);
    assert.equal(gateWaitingCount(), 1);
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait ?? null, null, "no wait row for the chat");

    await gate(false);
    assert.equal(gateWaitingCount(), 0, "switching the gate off wakes the workflow agents waiting at the gate");
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { x0: "Codex x0", k: "Finding k #1 resumed=false", x: "Codex x" });
    assert.deepEqual(entries(r.runId, 2).map((e) => e.kind), ["launched", "waiting", "started", "result"]);
    await ctx.waitForIdle();
  }, { claude, codex: CODEX_FAKE }));
});

// Account switch: the gate stays ON, but a newer measurement shows it free for every model (another account is signed in) —
// the sweeper tick wakes the waiting agent (dynworkflows/gate-wakeup.js) instead of letting it wait until the old account's
// reset. The test calls the waker itself; if the server's tick runs in between, the agent is woken just the same — what is
// counted is `gateWaitingCount()`, synchronously after the call.
function seedFreeAccount(at) {
  const iso = new Date(at + 7 * 86_400_000).toISOString();
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: 3, resetsAt: iso }, sevenDay: { utilization: 0, resetsAt: iso },
    limits: [{ kind: "session", group: "session", percent: 3, resets_at: iso }, { kind: "weekly", group: "weekly", percent: 0, resets_at: iso }],
    at,
  }));
}

test("credit gate on, Claude at 100 %: the Claude agent waits; an account switch (newer measurement, everything free) wakes it with the gate still on", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root, gate: gateState } = ctx;
    seedFullSession();
    const gate = (on) => put(`${base}/api/credit-gate`, { enabled: on });
    await gate(false);
    await ultracodeOn(base, chat.id);
    // The main turn is itself a Claude run — the gate only goes on once it is over; until then a Codex agent holds the run.
    const r = await start(ctx, "w", [
      `const w0 = await agent('W0 {TAG:w0} {GATE:w0}', { model: '${CODEX}', label: 'w0' });`,
      "const k = await agent('K {TAG:kw}', { label: 'kw' });",
      "return { w0, k };",
    ].join("\n"));
    await gateState.reached("w0");
    await turnPast(ctx);
    await gate(true);
    gateState.open("w0");
    const k = await firstState(r.runId, 2);
    assert.equal(k.kind, "waiting", `the Claude agent starts at the gate: ${JSON.stringify(k)}`);
    assert.equal(k.reason, "credit-gate");
    assert.equal(spawns(root, "kw"), 0);
    assert.equal(gateWaitingCount(), 1);
    // Without a newer measurement the tick wakes nothing: the measurement parked on says "full".
    wakeGateWaitingIfFree();
    assert.equal(gateWaitingCount(), 1, "without a newer measurement the agent keeps waiting");

    seedFreeAccount(Date.now() + 1);
    wakeGateWaitingIfFree();
    assert.equal(gateWaitingCount(), 0, "a newer measurement showing the gate free wakes the workflow agent waiting at the gate");
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { w0: "Codex w0", k: "Finding kw #1 resumed=false" });
    assert.deepEqual(entries(r.runId, 2).map((e) => e.kind), ["launched", "waiting", "started", "result"]);
    assert.equal((await json(`${base}/api/credit-gate`)).enabled, true, "the gate stayed on");
    await ctx.waitForIdle();
  }, { claude, codex: CODEX_FAKE }));
});

test("stall: without progress the workflow agent is restarted, up to 5 times — after the fifth restart agent() returns null, and log() names it", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await start(ctx, "s", "const s = await agent('S {TAG:s} {HAENGT}', { label: 'stall' });\nreturn { s };");
    // Per spawn: its first event is in the transcript (the watchdog has seen it), then the clock advances one deadline.
    const texts = () => store.readDynAgentHistory(r.runId, 1).filter((z) => z.kind === "text").length;
    for (let i = 1; i <= 6; i++) {
      const state = await waitForTruthy(() => (texts() >= i ? "running" : store.readDynRun(r.runId)?.status !== "running" ? "ended" : null), `Spawn ${i}`);
      assert.equal(state, "running", `already ended after ${i - 1} standstills — the agent was not restarted`);
      assert.equal(spawns(root, "s"), i);
      assert.ok(advanceStallClock(DEADLINE) >= 1, `standstill ${i}: no watchdog due`);
    }
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { s: null });
    assert.equal(spawns(root, "s"), 6, "one start and five restarts, no sixth");
    assert.deepEqual(entries(r.runId, 1).map((e) => e.kind), ["launched", "started", "failed"]);
    const logs = store.readDynEvents(r.runId).filter((e) => e.kind === "log").map((e) => e.text);
    assert.ok(logs.some((t) => t.includes("“stall”") && /returned null/.test(t) && /No progress/.test(t)), JSON.stringify(logs));
    await ctx.waitForIdle();
    void base; void chat;
  }, { claude });
});

test("stall: while a tool call runs the clock stands — only afterwards the standstill counts, and the restart reports", async () => {
  await withAgentsServer(async (ctx) => {
    const { root, gate } = ctx;
    await ultracodeOn(ctx.base, ctx.chat.id);
    const r = await start(ctx, "w", "const w = await agent('W {TAG:w} {WERKZEUG:w}', { label: 'werkzeug' });\nreturn { w };");
    const history = (kind) => store.readDynAgentHistory(r.runId, 1).filter((z) => z.kind === kind).length;
    await waitForTruthy(() => history("tool") === 1, "Werkzeugaufruf offen");
    await gate.reached("w-1");
    assert.equal(advanceStallClock(DEADLINE * 3), 0, "the clock kept running during the tool call");
    assert.equal(spawns(root, "w"), 1);
    gate.open("w-1");
    await waitForTruthy(() => history("tool-result") === 1, "Werkzeugergebnis gesehen");
    assert.ok(advanceStallClock(DEADLINE) >= 1, "after the call the standstill counts");
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { w: "Finding w #2 resumed=false" }, "the restart reports");
    assert.equal(spawns(root, "w"), 2);
    await ctx.waitForIdle();
  }, { claude });
});
