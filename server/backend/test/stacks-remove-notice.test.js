// Notice and wake-up of the removal of a copy (stacks/remove.js).
//
//   (1) A copy that stays in `error` wakes its chat ONCE per job. Without the mark, every restart started a new wake-up turn:
//       the restart grace resumed the job (copiesRemoveRestartGrace), the clean-up failed again, and the notice woke the chat
//       each time with the same system message. The mark `reported` lives in the job (journal section) and survives a restart;
//       a NEW trigger reports again. Against the real server: the trigger of the old tool path (removeCopy, from "agent" without
//       a chat — the path that wakes the creator) with a stand-in clearer that always returns `error`, then twice server end +
//       restart of the jobs (copiesRemoveCleanUp, copiesRemoveRestartGrace) — the stand-in runs again each time, the wake-up
//       appears once in the log; a second trigger => twice. (A human trigger, REST DELETE, never wakes: stacks-remove.test.js (4c).)
//   (2) A SYNCHRONOUS throw in the waker (copiesRemoveWake -> setImmediate: the read of the row) no longer ends the server.
//       In a child process (an uncaughtException would otherwise end the test process): a row with a job in `build`, a foreign
//       connection holds `BEGIN EXCLUSIVE`, `CBASE_DB_BUSY_MS=50` — the read in the waker throws "database is locked".
//       Expected: exit 0, the job stays open, the message is on stderr.
//
// COUNTER-TESTS (each shown red, then reverted):
//   remove.js: `alreadyReported` always returns false          => (1) red (the wake-up appeared twice after the restart)
//   remove.js: the waker without try/catch                     => (2) red (exit 1, "database is locked" as uncaught)
//
// No clock: waits on states (waitForTruthy, waitForQuiet) and on the end of the child process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { removeStatus, removeCopy, copiesRemoveCleanUp, copiesRemoveRestartGrace, setCopyClearerForTest } from "../electron/server/stacks/remove.js";
import { removeJob, copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { scenario } from "./projectbox-scenario.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

// The stand-in at the seam: every clean-up fails and sets the row to `error`.
const calls = [];
async function failsAlways(copyId, opts = {}) {
  calls.push({ copyId, ...opts });
  const k = store.stackCopy(copyId);
  const report = "Test: the clean-up always fails";
  if (k && k.state !== "error" && k.state !== "removed") setCopyState(k.id, "error", { error: report });
  return { state: "error", report };
}

async function chatIn(ctx, pid) {
  const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Copy notice", projectId: pid }) });
  return store.getChat(c.id);
}
const wakeCalls = async (ctx, chatId, name = "k1") => {
  const log = await json(`${ctx.base}/api/chats/${chatId}/log`);
  return log.filter((m) => m.role === "user" && String(m.text || "").includes(`<task-id>${copyInstance(name)}</task-id>`)).length;
};
// A removal pass is over: the stand-in ran `n` times, and no clean-up is running in this process any more.
const pass = (id, n) => waitForTruthy(() => (calls.filter((a) => a.copyId === id).length >= n && removeStatus().running === 0 ? true : null), `clean-up ${id} ${n}x`);

test("a copy stuck in `error`: the chat is woken ONCE per job, not after every restart; a new trigger reports again", async () => {
  setCopyClearerForTest(failsAlways);
  try {
    await withAgentsServer(async (ctx) => {
      const fd = await fakeDocker();
      try {
        const pid = scenario(ctx, { projectId: crypto.randomUUID() }).projectId;
        const chat = await chatIn(ctx, pid);
        const k = copyRequests({ projectId: pid, name: "k1", chatId: chat.id });
        setCopyState(k.id, "build", { phase: "clone1" });
        // The `ready` wake-up (stacks/inset.js) is not the subject here — the mark is set beforehand, otherwise it would wake the
        // chat before the clean-up wake-ups this guard counts (stacks-inset.test.js holds the `ready` wake-up).
        store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
        setCopyState(k.id, "ready");

        removeCopy(k.id, { reason: "tool", from: "agent" }).catch((e) => console.error("trigger:", e?.message || e));
        await pass(k.id, 1);
        assert.equal(store.stackCopy(k.id).state, "error");
        await ctx.waitForLog(chat.id, (l) => JSON.stringify(l).includes("<task-id>copy-k1</task-id>"));
        await ctx.waitForQuiet();
        assert.equal(await wakeCalls(ctx, chat.id), 1);
        assert.equal(removeJob(store.stackCopy(k.id))?.reported?.state, "error", "the notice is not recorded in the job");

        // Two restarts: the grace resumes the job, the clean-up fails again — no new wake-up.
        for (const n of [2, 3]) {
          copiesRemoveCleanUp(); // server end: waker and tick gone, the job stays in the journal
          const after = copiesRemoveRestartGrace();
          assert.equal(after.jobs, 1, `restart ${n - 1}: the job was not resumed`);
          await after.finished;
          await pass(k.id, n);
          await ctx.waitForQuiet();
          assert.equal(await wakeCalls(ctx, chat.id), 1, `after restart ${n - 1} a second wake-up for the same \`error\``);
        }

        // A NEW trigger (the same tool path onto the copy in `error`) reports again.
        removeCopy(k.id, { reason: "tool", from: "agent" }).catch((e) => console.error("trigger:", e?.message || e));
        await pass(k.id, 4);
        await ctx.waitForLog(chat.id, (l) => JSON.stringify(l).split("<task-id>copy-k1</task-id>").length - 1 >= 2);
        await ctx.waitForQuiet();
        assert.equal(await wakeCalls(ctx, chat.id), 2);
      } finally {
        copiesRemoveCleanUp();
        // Clean up as in stacks-remove.test.js: first the instance row, then `removed`.
        for (const z of store.liveStackCopies()) {
          try { store.deleteProjectInstance(z.projectId, copyInstance(z.name)); setCopyState(z.id, "removed"); }
          catch (e) { console.error("clean-up:", e?.message || e); }
        }
        fd.cleanUp();
      }
    });
  } finally { setCopyClearerForTest(null); }
});

// ── (2) in a child process ───────────────────────────────────────────────────────

const STORE_URL = new URL("../electron/server/store.js", import.meta.url).href;
const DB_URL = new URL("../electron/server/store/db.js", import.meta.url).href;
const STATE_URL = new URL("../electron/server/stacks/state.js", import.meta.url).href;
const REMOVE_URL = new URL("../electron/server/stacks/remove.js", import.meta.url).href;
const KIND = `
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as store from ${JSON.stringify(STORE_URL)};
import { db as storeDb } from ${JSON.stringify(DB_URL)};
import { copyRequests, setCopyState } from ${JSON.stringify(STATE_URL)};
import { removeStatus, removeCopy, copiesRemoveCleanUp, copiesRemoveWake } from ${JSON.stringify(REMOVE_URL)};
const dir = process.argv[2];
store.initStore(dir);
// The store runs in WAL mode (store/db.js), where a foreign BEGIN EXCLUSIVE blocks writers only and the waker's read goes
// through. This test is about the catch around a synchronous throw, not about the journal mode: the test store goes back to
// the rollback journal, where the foreign lock makes the waker's read throw "database is locked".
storeDb.exec("PRAGMA journal_mode=DELETE");
const k = copyRequests({ projectId: "p-r2c19", name: "k1", chatId: "c-r2c19" });
setCopyState(k.id, "build", { phase: "clone1" });
const r = await removeCopy(k.id, { reason: "rest", from: "human" });
if (r.state !== "earmarked") { console.log(JSON.stringify({ unexpected: r.state })); process.exit(3); }
const holders = new DatabaseSync(path.join(dir, "automater.db"));
holders.exec("BEGIN EXCLUSIVE");
copiesRemoveWake();
await new Promise((res) => setImmediate(res)); // after the waker's pass (it was first in the queue)
await new Promise((res) => setImmediate(res));
holders.exec("ROLLBACK");
console.log(JSON.stringify({ alive: true, id: k.id, open: removeStatus().open }));
copiesRemoveCleanUp();
`;

test("a synchronous throw in the waker (database locked) does not end the process — the job stays open, the message is on stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-r2c19-"));
  try {
    const script = path.join(dir, "child.mjs");
    fs.writeFileSync(script, KIND);
    const env = { ...process.env, CBASE_DB_BUSY_MS: "50" };
    delete env.NODE_TEST_CONTEXT;
    const subprocess = spawn(process.execPath, [script, dir], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    subprocess.stdout.on("data", (d) => { out += d; });
    subprocess.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((r) => subprocess.once("close", r));
    assert.equal(code, 0, `the child process died of the throw in the waker (exit ${code}):\n${err.split("\n").filter((z) => !/ExperimentalWarning|trace-warnings/.test(z)).join("\n")}`);
    const row = out.split("\n").map((z) => { try { return JSON.parse(z); } catch { return null; } }).find((z) => z && z.alive);
    assert.ok(row, `no answer: ${out}`);
    assert.deepEqual(row.open, [row.id], "the job dropped out of the waker instead of staying open");
    assert.match(err, /threw in the wake-up \(database is locked\)/, err);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
