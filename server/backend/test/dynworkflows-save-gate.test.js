// The storage gate of dynamic workflows at the main seam. An agent() starts only if the same gate as for graph workflows is
// open (workflows/storage-gate.js storageSituation — container above 80 % of its limit, measured as memory.current −
// inactive_file, or host below 20 % free); otherwise it "waits" with reason "storage", and the shared arbiter
// (workflows/storage-queue.js, source "dyn-workflows") releases at most ONE per pass, in call order across all runs
// (dynworkflows/cap.js distribute). Real server, real cbase MCP server, real agent core; only the providers (agent harness)
// and the measured situation are faked.
//
// The SEAM for the situation is the same as in graph-save-gate.test.js: `CBASE_STORAGE_ROOT` points to a throwaway folder
// with sys/fs/cgroup and proc/meminfo, which the test rewrites — reading goes through the gate's real path. No clock: the
// arbiter's tick is set to one day, the test calls `wakeStorageQueue()` itself (same module state, the server runs in the
// test process); in the second test the end of an agent wakes it (release in cap.js). It waits for events (journal,
// gates), never for a duration; a hang reports every 30 s what it waits for.
//
// The unit (a slot without a process does not ask the gate, the arbiter's source) is in dynworkflows-cap.test.js.
//
// Counter-tests (which sabotage turns which test red):
//   - in cap.js distribute() replace `gateOpen` by `() => true` (no gate) => "full storage" red at "both wait for the
//     storage" (a1 and a2 run at once), "transition" hangs (c3 starts at once, the reason storage never comes);
//   - in distribute() SKIP a storage waiter outside the arbiter instead of holding it (`if (w.atStorage && !fromStorage) {
//     i += 1; continue; }` before the gate) => "full storage" red at "b1 waits behind a2" (b1 overtakes);
//   - in distribute() never set the flag `startedFromStorage` => "full storage" red at "the first pass releases exactly
//     one" (it releases both);
//   - in cap.js release without `storageQueueSoon()` => "transition" hangs at c3 (only the tick would wake it, one day).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { capStatus } from "../electron/server/dynworkflows/cap.js";
import { wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";

process.env.CBASE_DYNWF_STAGGER_MS = "0";

const GIB = 1024 ** 3;

// The main agent: "WF[<tag>]:{json}" calls cbase_dynamic_workflow with a call block like the real CLI; the tool result is
// then under wf-<tag>. It reads a <task-notification> silently.
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
    fs.writeFileSync(path.join(LOCATION, "wf-" + tag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "done" }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;

// A workflow agent: {TAG:x} in the computed task, {GATE:x} holds it at the gate after the first event. Its start stands as
// "+x", its end as "-x" in the shared log — from which who really ran and in which order.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "started.log"), "+" + tag + "\\n");
    say({ type: "assistant", message: { id: "s1-" + tag, content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    fs.appendFileSync(path.join(LOCATION, "started.log"), "-" + tag + "\\n");
    say({ type: "assistant", message: { id: "s2-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

// ── The measured situation ───────────────────────────────────────────────────────────────────────────────────────────
// The fake root as in graph-save-gate.test.js: cgroup files in bytes, meminfo in kB.
function writeStorage(root, { max, current, inactive = 0, total = 32 * 1024 * 1024, available = 16 * 1024 * 1024 }) {
  const cg = path.join(root, "sys", "fs", "cgroup");
  const proc = path.join(root, "proc");
  fs.mkdirSync(cg, { recursive: true });
  fs.mkdirSync(proc, { recursive: true });
  fs.writeFileSync(path.join(cg, "memory.max"), `${max}\n`);
  fs.writeFileSync(path.join(cg, "memory.current"), `${current}\n`);
  fs.writeFileSync(path.join(cg, "memory.stat"), `anon ${current}\nfile 0\ninactive_file ${inactive}\n`);
  fs.writeFileSync(path.join(proc, "meminfo"), `MemTotal:       ${total} kB\nMemAvailable:   ${available} kB\n`);
}
// The user container: 12 GiB limit. Full = 90 % used; relaxed = 3 GiB.
const FULL = { max: 12 * GIB, current: Math.round(12 * GIB * 0.9) };
const RELAXED = { max: 12 * GIB, current: 3 * GIB };
const FULL_REASON = "wartet auf Speicher: Container bei 90 % seiner Grenze (10,8 von 12,0 GiB)";

// The server with the fake root and an arbiter tick of one day (the tick is read at start, the root at every measurement) —
// reset afterwards.
async function withStorageServer(fn, environment = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dynwf-storage-"));
  const values = { CBASE_STORAGE_ROOT: root, CBASE_GRAPH_TICK_MS: String(24 * 3600 * 1000), ...environment };
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) process.env[k] = String(v);
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

// ── Helpers as in dynworkflows-concurrency.test.js ──────────────────────────────────────────────────────────
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const patch = (url, body) => json(url, { method: "PATCH", body: JSON.stringify(body) });
const ultracode = (base, chatId) => patch(`${base}/api/chats/${chatId}`, { model: "claude-opus-5-5", ultracode: true });
const script = (name, prompts) => `export const meta = { name: '${name}', description: 'Storage', phases: [{ title: 'Read' }] }\n`
  + `const r = await parallel([${prompts.map((p) => `() => agent(${JSON.stringify(p)})`).join(", ")}]);\nreturn r;\n`;
const turnPast = (ctx) => waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn ended");
async function startWf(ctx, tag, prompts) {
  await post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text: `WF[${tag}]:${JSON.stringify({ script: script(tag, prompts) })}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(r.status, "started", JSON.stringify(r));
  await turnPast(ctx);
  return r;
}
// Each of the `count` agent() calls is in the journal as started or waiting.
const settled = (runId, count) => waitForTruthy(() => {
  const j = store.readDynJournal(runId);
  return new Set(j.filter((e) => e.kind === "started" || e.kind === "waiting").map((e) => e.n)).size === count ? j : null;
}, `journal ${runId} settled`);
const finished = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} ended`);
// The starts in their order, counted at the children that really ran.
const starts = (root) => {
  const f = path.join(root, "started.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((z) => z[0] === "+").map((z) => z.slice(1)) : [];
};
const waiting = (j) => j.filter((e) => e.kind === "waiting").map((e) => [e.n, e.reason, e.cap ?? e.situation ?? null]);
const kinds = (j, n) => j.filter((e) => e.n === n).map((e) => e.kind);

test("full storage: no agent() starts, all wait with reason \"storage\"; then exactly one starts per pass, in call order across two runs — a new call does not overtake the waiting ones, even with the gate open", async () => {
  await withStorageServer(async (ctx) => {
    const { base, chat, root, gate, storage } = ctx;
    storage(FULL);
    await ultracode(base, chat.id);
    const A = await startWf(ctx, "a", ["A1 {TAG:a1} {GATE:a1}", "A2 {TAG:a2} {GATE:a2}"]);
    const jA = await settled(A.runId, 2);
    assert.deepEqual(waiting(jA), [[1, "storage", FULL_REASON], [2, "storage", FULL_REASON]], "both wait for the storage, with the situation text");
    assert.deepEqual(starts(root), [], "no agent ran");
    assert.equal(capStatus().atStorage, 2);
    assert.equal(capStatus().total, 0, "a storage waiter occupies no slot");
    // The arbiter with storage still full: nothing starts.
    assert.equal(wakeStorageQueue(), 0, "closed stays closed");

    // Relaxed: ONE per pass — the oldest.
    storage(RELAXED);
    assert.equal(wakeStorageQueue(), 1, "the first pass releases exactly one");
    await gate.reached("a1");
    assert.deepEqual(starts(root), ["a1"]);
    assert.ok(!kinds(store.readDynJournal(A.runId), 2).includes("started"), "a2 keeps waiting for the next pass");

    // A NEW call with the gate open queues up BEHIND a2 (FIFO) — it does not start past it.
    const B = await startWf(ctx, "b", ["B1 {TAG:b1} {GATE:b1}"]);
    const jB = await settled(B.runId, 1);
    assert.deepEqual(waiting(jB), [[1, "storage", null]], "b1 waits behind a2 (reason storage, without situation — the gate is open)");
    assert.deepEqual(starts(root), ["a1"], "b1 does not overtake a2");

    assert.equal(wakeStorageQueue(), 1);
    await gate.reached("a2");
    assert.deepEqual(starts(root), ["a1", "a2"], "a2 before b1");
    assert.equal(wakeStorageQueue(), 1);
    await gate.reached("b1");
    assert.deepEqual(starts(root), ["a1", "a2", "b1"]);
    assert.equal(wakeStorageQueue(), 0, "nobody waits any more");
    assert.equal(capStatus().atStorage, 0);

    for (const t of ["a1", "a2", "b1"]) gate.open(t);
    const [eA, eB] = [await finished(A.runId), await finished(B.runId)];
    assert.equal(eA.status, "finished", eA.error);
    assert.equal(eB.status, "finished", eB.error);
    assert.deepEqual(eA.returnValue, ["Finding a1", "Finding a2"]);
    assert.deepEqual(eB.returnValue, ["Finding b1"]);
    const jA2 = store.readDynJournal(A.runId);
    for (const n of [1, 2]) assert.deepEqual(kinds(jA2, n), ["launched", "waiting", "started", "result"], `a${n}`);
    assert.deepEqual(kinds(store.readDynJournal(B.runId), 1), ["launched", "waiting", "started", "result"], "b1");
    assert.equal(starts(root).length, 3, "every agent started exactly once");
    await ctx.waitForIdle();
  });
});

test("transition: a waiter of the cap that the gate holds once a slot is free waits for the storage — and the end of an agent wakes the arbiter, without a tick", async () => {
  await withStorageServer(async (ctx) => {
    const { base, chat, root, gate, storage } = ctx;
    storage(RELAXED);
    await ultracode(base, chat.id);
    const C = await startWf(ctx, "c", ["C1 {TAG:c1} {GATE:c1}", "C2 {TAG:c2} {GATE:c2}", "C3 {TAG:c3} {GATE:c3}"]);
    const j = await settled(C.runId, 3);
    await Promise.all(["c1", "c2"].map((t) => gate.reached(t)));
    assert.deepEqual(waiting(j), [[3, "cap", "run"]], "c3 waits for its run's cap");
    // c1's slot becomes free, the storage is full: c3 does not get it.
    storage(FULL);
    gate.open("c1");
    const jc = await waitForTruthy(() => {
      const jj = store.readDynJournal(C.runId);
      return jj.some((e) => e.n === 3 && e.kind === "waiting" && e.reason === "storage") ? jj : null;
    }, "c3 waits for the storage");
    assert.deepEqual(waiting(jc), [[3, "cap", "run"], [3, "storage", FULL_REASON]]);
    assert.deepEqual([...starts(root)].sort(), ["c1", "c2"], "c3 did not run"); // c1 and c2 start side by side
    // Relaxed, and c2 ends: its end wakes the arbiter (the tick is one day), c3 starts.
    storage(RELAXED);
    gate.open("c2");
    await gate.reached("c3");
    assert.deepEqual(starts(root).slice(2), ["c3"], "c3 as third, exactly once");
    gate.open("c3");
    const end = await finished(C.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, ["Finding c1", "Finding c2", "Finding c3"]);
    assert.deepEqual(kinds(store.readDynJournal(C.runId), 3), ["launched", "waiting", "waiting", "started", "result"]);
    await ctx.waitForIdle();
  }, { CBASE_DYNWF_RUN_CAP: 2 });
});
