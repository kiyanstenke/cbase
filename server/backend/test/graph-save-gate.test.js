// Storage gate of graph workflows: a NEW background run waits (`waiting_storage`) while the user container is above 80 % of
// its limit or the host has under 20 % free, and starts by itself afterwards. The tick and the waker ask storage first, then
// the lock (workflows/graph-start.js redeem, wakeGraphStarts). Per pass at most ONE run leaves `waiting_storage`, the oldest.
// The foreground does not know the gate.
//
// Two parts:
//   - the leaf workflows/storage-gate.js with a fake reader (`read`) or a fake root (`CBASE_STORAGE_ROOT`): `max`, numbers,
//     missing files, the limits exactly at 80 % and 20 %;
//   - the main seam via `withAgentsServer` with `CBASE_STORAGE_ROOT` (a throwaway folder with sys/fs/cgroup and proc/meminfo
//     that the test rewrites) and `CBASE_GRAPH_TICK_MS=200`. "One per pass" runs with a tick of one day and calls
//     wakeGraphStarts ITSELF (same module state, the server runs in the test process) - a 200 ms tick would turn "the second
//     still waits" into a race against the clock.
//
// The fake main agent as in graph-background.test.js: "GS[<tag>]:{json}§" calls `cbase_workflow_start` through the REAL
// cbase MCP server (result in `gs-<tag>.jsonl`), "HALT:<x>" in the text of a step holds at the gate.
//
// Counter-tests (which sabotage turns which test red):
//   - drop the check `if (z.background) { … storageSituation() … }` in redeem  => "Full storage" red (the run starts at
//     once: `running` instead of `waiting_storage`);
//   - drop `"waiting_storage"` from the list in wakeGraphStarts  => "Full storage" hangs (the run never starts after relief);
//   - never set the mark `fromStorageStarted` in wakeGraphStarts  => "One per pass" red (both start in the first pass).
// The measure is `memory.current - inactive_file` from memory.stat, not `memory.current` - the page cache would keep the
// gate shut for good (a 2 GB copy, 10 % real need, gate at 99 %). Counter-test: set `occupied` equal to `current` again
// => "The page cache does not count" and "Page cache does not hold up the background start" red.
// No deadline in the test itself (rule "no timers in tests"): a hang reports every 30 s what it waits for.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { running } from "../electron/server/runs/state.js";
import { backgroundWork } from "../electron/server/runs/background.js";
import { streams } from "../electron/server/runtime/sse.js";
import { wakeGraphStarts } from "../electron/server/workflows/graph-start.js";
import { CONTAINER_SHARE_MAX, HOST_FREE_MIN, storageSituation } from "../electron/server/workflows/storage-gate.js";

const GIB = 1024 ** 3;

// ── The leaf ────────────────────────────────────────────────────────────────────────────────────────────────────

// A fake reader over a table path -> text; a missing path throws like readFileSync.
const reader = (files) => (p) => {
  if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return files[p];
};
const meminfo = (totalKb, availableKb) => `MemTotal:       ${totalKb} kB\nMemFree:          1000 kB\nMemAvailable:   ${availableKb} kB\nBuffers:           10 kB\n`;
const MAX = "/sys/fs/cgroup/memory.max";
const CUR = "/sys/fs/cgroup/memory.current";
const STAT = "/sys/fs/cgroup/memory.stat";
// A memory.stat as in the user container - `inactive_file` in the middle, plus the cgroup v1 field of similar name.
const stat = (inactiveFile) => `anon 1183000000\nfile 350000000\nactive_file 200000000\ninactive_file ${inactiveFile}\ntotal_inactive_file 7\nshmem 57769984\n`;
const MEM = "/proc/meminfo";

test("leaf: the limits are 80 % at the container and 20 % free at the host", () => {
  assert.equal(CONTAINER_SHARE_MAX, 0.8);
  assert.equal(HOST_FREE_MIN, 0.2);
});

test("leaf: without any file (the Mac) the gate is free - both parts off", () => {
  assert.deepEqual(storageSituation({ read: reader({}) }), { free: true, reason: "", container: null, host: null });
});

test("leaf: `max` (no limit), an unreadable or broken file, a missing current switch the container part off", () => {
  for (const files of [
    { [MAX]: "max\n", [CUR]: String(8 * GIB) },
    { [CUR]: String(8 * GIB) },
    { [MAX]: "", [CUR]: "1" },
    { [MAX]: "eight GiB\n", [CUR]: "1" },
    { [MAX]: "0\n", [CUR]: "1" },
    { [MAX]: String(8 * GIB) },
    { [MAX]: String(8 * GIB), [CUR]: "broken" },
  ]) {
    const situation = storageSituation({ read: reader(files) });
    assert.equal(situation.container, null, JSON.stringify(files));
    assert.equal(situation.free, true, JSON.stringify(files));
  }
  // A reader that throws for EVERY file is the same as no file.
  assert.deepEqual(storageSituation({ read: () => { throw new Error("EACCES"); } }), { free: true, reason: "", container: null, host: null });
});

test("leaf: meminfo without MemTotal or MemAvailable switches the host part off", () => {
  for (const t of ["MemTotal: 1000 kB\n", "MemAvailable: 10 kB\n", "", "MemTotal: 0 kB\nMemAvailable: 0 kB\n"]) {
    const situation = storageSituation({ read: reader({ [MEM]: t }) });
    assert.equal(situation.host, null, JSON.stringify(t));
    assert.equal(situation.free, true);
  }
});

test("leaf: numbers in bytes, share as a fraction - container EXACTLY at 80 % is free, one byte above is not", () => {
  const max = 5 * GIB;
  const exactly = storageSituation({ read: reader({ [MAX]: `${max}\n`, [CUR]: `${4 * GIB}\n` }) });
  assert.deepEqual(exactly, { free: true, reason: "", container: { current: 4 * GIB, inactiveFile: null, occupied: 4 * GIB, max, share: 0.8 }, host: null });
  const above = storageSituation({ read: reader({ [MAX]: `${max}\n`, [CUR]: `${4 * GIB + 1}\n` }) });
  assert.equal(above.free, false);
  // Rounded, but never onto the limit: "above 80 %" shows at least 81.
  assert.equal(above.reason, "wartet auf Speicher: Container bei 81 % seiner Grenze (4,0 von 5,0 GiB)");
  const full = storageSituation({ read: reader({ [MAX]: `${8 * GIB}\n`, [CUR]: `${Math.round(8 * GIB * 0.85)}\n` }) });
  assert.equal(full.reason, "wartet auf Speicher: Container bei 85 % seiner Grenze (6,8 von 8,0 GiB)");
  assert.equal(full.host, null);
});

test("leaf: the page cache does not count - occupied = memory.current - inactive_file, the reason names occupied", () => {
  const max = 8 * GIB;
  const current = Math.round(7.9 * GIB); // 99 % - the gate stood there after a 2 GB copy
  // Almost all of it is reclaimable cache: the gate is open, the share is the occupied one.
  const cache = storageSituation({ read: reader({ [MAX]: `${max}\n`, [CUR]: `${current}\n`, [STAT]: stat(5 * GIB) }) });
  assert.equal(cache.free, true);
  assert.deepEqual(cache.container, { current, inactiveFile: 5 * GIB, occupied: current - 5 * GIB, max, share: (current - 5 * GIB) / max });
  // Little cache: shut, and the reason shows occupied (6.9 GiB), not current (7.9 GiB).
  const real = storageSituation({ read: reader({ [MAX]: `${max}\n`, [CUR]: `${current}\n`, [STAT]: stat(1 * GIB) }) });
  assert.equal(real.free, false);
  assert.equal(real.reason, "wartet auf Speicher: Container bei 86 % seiner Grenze (6,9 von 8,0 GiB)");
  // Exactly at the limit is free, one byte above is not - computed with occupied.
  const limit = storageSituation({ read: reader({ [MAX]: `${5 * GIB}`, [CUR]: `${5 * GIB}`, [STAT]: stat(GIB) }) });
  assert.equal(limit.container.share, 0.8);
  assert.equal(limit.free, true);
  assert.equal(storageSituation({ read: reader({ [MAX]: `${5 * GIB}`, [CUR]: `${5 * GIB}`, [STAT]: stat(GIB - 1) }) }).free, false);
  // More cache than current (a snapshot of two files) => 0, never negative.
  const below = storageSituation({ read: reader({ [MAX]: `${max}`, [CUR]: `${GIB}`, [STAT]: stat(2 * GIB) }) });
  assert.equal(below.container.occupied, 0);
  assert.equal(below.container.share, 0);
});

test("leaf: without memory.stat, without an inactive_file line or with a broken number memory.current counts - never \"off\"", () => {
  const max = 8 * GIB;
  const current = Math.round(max * 0.9);
  for (const st of [undefined, "", "anon 1\nfile 2\n", "inactive_file viel\n", "total_inactive_file 7516192768\n", "inactive_file 7516192768 kB\n"]) {
    const files = { [MAX]: `${max}`, [CUR]: `${current}` };
    if (st !== undefined) files[STAT] = st;
    const situation = storageSituation({ read: reader(files) });
    assert.equal(situation.container.inactiveFile, null, JSON.stringify(st));
    assert.equal(situation.container.occupied, current, JSON.stringify(st));
    assert.equal(situation.free, false, JSON.stringify(st));
    assert.equal(situation.reason, "wartet auf Speicher: Container bei 90 % seiner Grenze (7,2 von 8,0 GiB)");
  }
  // inactive_file 0 is a number, not a missing value.
  assert.equal(storageSituation({ read: reader({ [MAX]: `${max}`, [CUR]: `${current}`, [STAT]: stat(0) }) }).container.inactiveFile, 0);
  // A reader that only cannot read memory.stat (EACCES) is the same as no file.
  const onlyStat = (p) => { if (p === STAT) throw new Error("EACCES"); return { [MAX]: `${max}`, [CUR]: `${current}` }[p] ?? (() => { throw new Error("ENOENT"); })(); };
  assert.equal(storageSituation({ read: onlyStat }).container.occupied, current);
});

test("leaf: host EXACTLY 20 % free is free, below is not - kB become bytes", () => {
  const exactly = storageSituation({ read: reader({ [MEM]: meminfo(1_000_000, 200_000) }) });
  assert.deepEqual(exactly, { free: true, reason: "", container: null, host: { available: 200_000 * 1024, total: 1_000_000 * 1024, share: 0.2 } });
  const tight = storageSituation({ read: reader({ [MEM]: meminfo(1_000_000, 199_999) }) });
  assert.equal(tight.free, false);
  // "below 20 %" shows at most 19.
  assert.equal(tight.reason, "wartet auf Speicher: Host hat nur 19 % frei");
  const empty = storageSituation({ read: reader({ [MEM]: meminfo(32_000_000, 3_200_000) }) });
  assert.equal(empty.reason, "wartet auf Speicher: Host hat nur 10 % frei");
});

test("leaf: if both hit, the reason names the container; if either part is tight, the gate is shut", () => {
  const max = 8 * GIB;
  const both = storageSituation({ read: reader({ [MAX]: `${max}`, [CUR]: `${Math.round(max * 0.9)}`, [MEM]: meminfo(1000, 100) }) });
  assert.equal(both.free, false);
  assert.match(both.reason, /^wartet auf Speicher: Container bei 90 %/);
  const onlyHost = storageSituation({ read: reader({ [MAX]: `${max}`, [CUR]: `${max / 2}`, [MEM]: meminfo(1000, 100) }) });
  assert.equal(onlyHost.reason, "wartet auf Speicher: Host hat nur 10 % frei");
  assert.equal(onlyHost.container.share, 0.5);
});

test("leaf: without a reader it reads under CBASE_STORAGE_ROOT (a trailing slash does no harm)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-storage-"));
  const prior = process.env.CBASE_STORAGE_ROOT;
  try {
    writeStorage(root, { max: 8 * GIB, current: 7 * GIB, total: 1000, available: 500 });
    process.env.CBASE_STORAGE_ROOT = `${root}/`;
    const situation = storageSituation();
    assert.equal(situation.free, false);
    assert.equal(situation.reason, "wartet auf Speicher: Container bei 88 % seiner Grenze (7,0 von 8,0 GiB)");
    assert.deepEqual(situation.host, { available: 500 * 1024, total: 1000 * 1024, share: 0.5 });
    writeStorage(root, { max: "max", current: 7 * GIB, total: 1000, available: 500 });
    assert.equal(storageSituation().free, true);
  } finally {
    if (prior === undefined) delete process.env.CBASE_STORAGE_ROOT;
    else process.env.CBASE_STORAGE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The main seam ────────────────────────────────────────────────────────────────────────────────────────────────

// The fake root: cgroup files in bytes, meminfo in kB. `null` omits a file.
function writeStorage(root, { max = null, current = null, inactive = null, total = null, available = null } = {}) {
  const cg = path.join(root, "sys", "fs", "cgroup");
  const proc = path.join(root, "proc");
  fs.mkdirSync(cg, { recursive: true });
  fs.mkdirSync(proc, { recursive: true });
  const set = (file, content) => (content === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, content));
  set(path.join(cg, "memory.max"), max === null ? null : `${max}\n`);
  set(path.join(cg, "memory.current"), current === null ? null : `${current}\n`);
  set(path.join(cg, "memory.stat"), inactive === null ? null : stat(inactive));
  set(path.join(proc, "meminfo"), total === null ? null : meminfo(total, available ?? 0));
}
const FULL = { max: 8 * GIB, current: Math.round(8 * GIB * 0.9) }; // 90 % of the limit
const RELAXED = { max: 8 * GIB, current: 2 * GIB };
// The same 90 % in memory.current, of which 6 GiB reclaimable cache - occupied is 1.2 GiB (15 %).
const FULL_WITH_CACHE = { ...FULL, inactive: 6 * GIB };
const FULL_REASON = "wartet auf Speicher: Container bei 90 % seiner Grenze (7,2 von 8,0 GiB)";

// The server with the fake root and a tick; both are environment that the server reads at start (tick) or on every
// reading (root) - restored afterwards.
async function withStorageServer(fn, { tick = "200" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-storage-"));
  const prior = { CBASE_STORAGE_ROOT: process.env.CBASE_STORAGE_ROOT, CBASE_GRAPH_TICK_MS: process.env.CBASE_GRAPH_TICK_MS };
  process.env.CBASE_STORAGE_ROOT = root;
  process.env.CBASE_GRAPH_TICK_MS = tick;
  try {
    await withAgentsServer((ctx) => fn({ ...ctx, storage: (situation) => writeStorage(root, situation) }), { claude });
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text }) + "\\n");
  const step = String(text).includes("[cbase workflow");
  const g = text.indexOf("GS[");
  if (g >= 0 && !step) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
    say({ type: "assistant", message: { id: "a-" + gtag + "-" + turn, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_workflow_start", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_workflow_start", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.appendFileSync(path.join(LOCATION, "gs-" + gtag + ".jsonl"), JSON.stringify({ t }) + "\\n");
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  const hold = (String(text).match(/HALT:(\\w+)/) || [])[1];
  if (hold && step) await gate(hold);
  finished();
  say({ type: "result", result: step ? "ERLEDIGT " + String(text).replace(/\\s+/g, " ").slice(0, 80) : "Started.", session_id: "s-main" });`;

const claude = fakeClaude({ main: MAIN });

async function raw(url, method = "GET", body = undefined) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const send = (base, chatId, text) => raw(`${base}/api/chats/${chatId}/message`, "POST", { text });
const stop = (base, chatId, startId) => raw(`${base}/api/chats/${chatId}/graph-workflows/${encodeURIComponent(startId)}/stop`, "POST", { from: "human" });

// A workflow `s -> n1 -> e` without a closing gate and WITHOUT a lock - two runs may go side by side, waiting happens only
// at storage.
function newWorkflow(ws, name, text = "WORK") {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, createdAt: now, updatedAt: now, graph: {
    nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text }, { id: "e", type: "end", title: "End" }],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
  } });
  return store.updateWorkflow(w.id, { run: { doneAll: false }, lock: { scope: "off" } });
}
async function toolResult(root, tag) {
  const file = path.join(root, `gs-${tag}.jsonl`);
  const [{ t }] = await waitForTruthy(() => { const z = readJsonl(file); return z.length ? z : null; }, `tool result ${tag}`);
  assert.ok(!t.startsWith("ERROR "), t);
  return JSON.parse(t);
}
// A start from an orchestrator turn (message with announcement, the fake calls the tool) - the turn is over afterwards.
async function startAt(base, root, chatId, short, tag, { input = "los", background = true } = {}) {
  const r = await send(base, chatId, `/workflow:${short} GS[${tag}]:${JSON.stringify({ workflow: short, input, background })}§`);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const result = await toolResult(root, tag);
  await turnFree(chatId);
  return result;
}
const rowInState = (startId, status) => waitForTruthy(() => { const z = store.graphStart(startId); return z?.status === status ? z : null; }, `row ${startId} -> ${status}`);
const runFinished = (runId) => waitForTruthy(() => { const r = store.getWorkflowRunById(runId); return r && !store.workflowOpen(r) ? r : null; }, `run ${runId} finished`);
const turnFree = (chatId) => waitForTruthy(() => !running.has(chatId), `turn of ${chatId} finished`);

function stream(chatId) {
  const events = [];
  const reader = { write(row) { for (const z of String(row).split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch { /* not JSON */ } } } };
  if (!streams.has(chatId)) streams.set(chatId, new Set());
  streams.get(chatId).add(reader);
  return { runs: (startId) => events.filter((e) => e.subtype === "graph_run" && e.run?.startId === startId).map((e) => e.run), close: () => streams.get(chatId)?.delete(reader) };
}

test("full storage: the background start waits (waiting_storage, event, background work), the foreground does not - after relief it starts by itself", async () => {
  await withStorageServer(async ({ base, ws, chat, root, storage }) => {
    newWorkflow(ws, "Storage Flow", "STORAGE");
    storage(FULL);
    const s = stream(chat.id);
    try {
      const r = await startAt(base, root, chat.id, "storage-flow", "a", { input: "one" });
      const { start } = r;
      assert.equal(start.state, "waiting_storage", JSON.stringify(start));
      assert.equal(start.reason, FULL_REASON);
      assert.equal(r.hint.split(" Am Ende")[0], `Angenommen im Hintergrund (eigener Chat) — er ${FULL_REASON} und startet dann von selbst.`);
      const z = store.graphStart(start.startId);
      assert.equal(z.status, "waiting_storage");
      assert.ok(z.childChatId, "the child chat already exists");
      assert.ok(!store.getWorkflowRun(z.childChatId), "no run in the child chat yet");
      assert.deepEqual(s.runs(start.startId).map((l) => [l.state, l.reason]), [["waiting_storage", FULL_REASON]], "exactly one event: the result");
      assert.deepEqual(backgroundWork(chat.id).map((h) => h.startId), [z.id], "the waiting row is background work");
      // A pass with unchanged storage changes nothing and reports nothing (the tick asks every 200 ms).
      wakeGraphStarts();
      assert.equal(store.graphStart(z.id).status, "waiting_storage");
      assert.equal(s.runs(z.id).length, 1);

      // The foreground does not know the gate: same storage, and the run goes in the orchestrator.
      const v = await startAt(base, root, chat.id, "storage-flow", "v", { input: "front", background: false });
      const zv = await rowInState(v.start.startId, "started");
      assert.equal((await runFinished(zv.runId)).status, "done");
      assert.equal(store.graphStart(z.id).status, "waiting_storage", "the background keeps waiting");

      // Relief: the tick redeems - without anyone doing anything.
      storage(RELAXED);
      const gz = await rowInState(z.id, "started");
      assert.equal(gz.reason, "");
      assert.equal(store.getWorkflowRunById(gz.runId).chatId, z.childChatId);
      assert.equal((await runFinished(gz.runId)).status, "done");
      const states = s.runs(z.id).map((l) => l.state);
      assert.equal(states[0], "waiting_storage");
      assert.ok(states.includes("running") && states.at(-1) === "finished", JSON.stringify(states));
      await waitForTruthy(() => (backgroundWork(chat.id).length ? null : true), "nothing open any more");
      await turnFree(chat.id);
    } finally { s.close(); }
  });
});

test("page cache does not hold up the background start: 90 % in memory.current, almost all inactive_file - the run starts at once", async () => {
  await withStorageServer(async ({ base, ws, chat, root, storage }) => {
    newWorkflow(ws, "Cache Flow", "CACHE");
    storage(FULL_WITH_CACHE);
    const { start } = await startAt(base, root, chat.id, "cache-flow", "a", { input: "one" });
    assert.notEqual(start.state, "waiting_storage", JSON.stringify(start));
    assert.equal(start.reason ?? "", "");
    const z = await rowInState(start.startId, "started");
    assert.equal((await runFinished(z.runId)).status, "done");
    await waitForTruthy(() => (backgroundWork(chat.id).length ? null : true), "nothing open any more");
    await turnFree(chat.id);
  });
});

test("one per pass: two waiting runs - the oldest starts first, the second only in the next pass", async () => {
  await withStorageServer(async ({ base, ws, chat, root, gate, storage }) => {
    newWorkflow(ws, "Two Flow", "TWO HALT:h");
    storage({ max: "max", total: 1_000_000, available: 100_000 }); // the host is tight, the container without a limit
    const a = (await startAt(base, root, chat.id, "two-flow", "a", { input: "one" })).start;
    const b = (await startAt(base, root, chat.id, "two-flow", "b", { input: "two" })).start;
    for (const x of [a, b]) {
      assert.equal(x.state, "waiting_storage", JSON.stringify(x));
      assert.equal(x.reason, "wartet auf Speicher: Host hat nur 10 % frei");
    }
    storage({ max: "max", total: 1_000_000, available: 500_000 });
    wakeGraphStarts();
    // Right after the pass (synchronous): the older runs, the younger still waits.
    const za = store.graphStart(a.startId);
    assert.equal(za.status, "started");
    assert.equal(store.graphStart(b.startId).status, "waiting_storage");
    assert.ok(!store.getWorkflowRun(store.graphStart(b.startId).childChatId), "no run in the second child");
    await gate.reached("h"); // the step of the first holds at the gate - no run end, no waker
    wakeGraphStarts();
    const zb = store.graphStart(b.startId);
    assert.equal(zb.status, "started", "the next pass starts the second");
    assert.ok(store.workflowOpen(store.getWorkflowRunById(za.runId)), "while the first still runs (no lock)");
    gate.open("h");
    assert.equal((await runFinished(za.runId)).status, "done");
    assert.equal((await runFinished(zb.runId)).status, "done");
    await waitForTruthy(() => (backgroundWork(chat.id).length ? null : true), "nothing open any more");
    await turnFree(chat.id);
  }, { tick: String(24 * 3_600_000) });
});

test("stop of a waiting row: `stopped` by the human - after relief nothing starts", async () => {
  await withStorageServer(async ({ base, ws, chat, root, storage }) => {
    newWorkflow(ws, "Stop Flow", "STOP");
    storage(FULL);
    const a = (await startAt(base, root, chat.id, "stop-flow", "a")).start;
    assert.equal(a.state, "waiting_storage", JSON.stringify(a));
    const st = await stop(base, chat.id, a.startId);
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.run.state, "stopped");
    assert.equal(st.body.run.stoppedOf, "human");
    assert.deepEqual(backgroundWork(chat.id), [], "the row is out of the queue");
    storage(RELAXED);
    wakeGraphStarts();
    const z = store.graphStart(a.startId);
    assert.equal(z.status, "stopped");
    assert.equal(z.runId, null);
    assert.ok(!store.getWorkflowRun(z.childChatId), "no run in the child chat");
    // A second stop: already over.
    assert.equal((await stop(base, chat.id, a.startId)).status, 409);
    // The completion notice to the orchestrator (stopped by the human) is a turn of its own - wait for it.
    await waitForTruthy(() => (store.listMessages(chat.id).some((m) => m.role === "user" && String(m.text).includes(a.startId)) ? true : null), "CompletionNotice");
    await turnFree(chat.id);
  });
});
