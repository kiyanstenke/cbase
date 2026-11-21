// A new attempt after a failed copy. Case at hand: building a copy failed, the dismantling was complete, and the wake-up said
// "it was NOT built … a new attempt goes with cbase_copy_stack" — but the request answered 409 COPY_OCCUPIED because the row
// stayed alive in `error`; the agent found cbase_copy_stack_remove on its own, and its message promised commits, branches
// `copy/k1/…` and a report for a copy that was never built, which did not exist.
//
// What holds (stacks/state.js copyRequests, stacks/request.js, stacks/inset.js copyHolds/newAttemptSet, stacks/remove.js
// copyWakeText) — the failure is built through the REAL setters and the real dismantling (stacks/dismantling.js without an
// operation mark: it only takes the instance row if nothing stayed standing — otherwise it throws with the sentence, as in the
// build); request and clear-away run over REST on the real server. A copy keeps its name until it is removed; a new attempt
// of the same chat always goes through as ANOTHER copy under a free name:
//   (1) A cleanly failed copy (never built, instance row gone, no job) stays `error` and keeps its name. A new POST
//       …/stack-copies of the same chat => 202, a new row `waiting_queue`; the automatic name skips the old one (k2); naming the
//       old one explicitly => 409 NAME_TAKEN with the sentence what is with it (`occupiedWhatToDo`); a third attempt => 202 again.
//   (2) Leftovers or work in the failed copy do not stop a new attempt (202, the old one unchanged); the sentence what to do
//       stands at the 409 of its NAME (dismantling => cbase_copy_stack_remove removes the leftovers; worked => fetches and
//       backs up its work).
//   (2b) A job to clear away, at the REAL entry removeCopy (from "agent") with a stand-in clearer that returns `error` and holds at
//       a gate: while it RUNS the 409 says "it is being removed; the result comes as a system message"; once it FAILED (reported,
//       nothing runs or waits in this process) it says "call cbase_copy_stack_remove with name "k1" again" — and the second call
//       EXECUTES (second clearer call, second wake-up); in the resumption after a restart (the restart grace resumes the reported
//       job, a renewed failure is not reported again) the sentence says both.
//   (3) The wake-up "not built" (stacks/inset.js) says the same as the request: in both cases "a new attempt goes directly with
//       cbase_copy_stack" and names cbase_copy_stack_remove for the name (clean: "releases the name") or for the leftovers.
//       Checked on the log of a real wake turn.
//   (4) Clearing away a NEVER built copy (the old tool path, from "agent": wake-up; REST DELETE, from "mensch": silent hint, no
//       wake-up; project deletion, from "cbase": silent hint) reports a short, true sentence — "never built", without commits,
//       without branches `copy/<name>/…`, without a report.
//   (5) A failed dismantling of a NEVER built copy (docker = /usr/bin/false) leaves it never built: `error` "… — never built, …",
//       report `neverBuilt`, no `clearAway` section, no layer; copyOfTheChat null, the chat's lock null, the name stays taken
//       only with the sentence of the dismantling (never "Work was done in it"). Likewise for the two forms an earlier release wrote
//       (`{ error }`, then the run of a second clear-away with `time` on top) — they heal on reading. The next call dismantles
//       (`removed`, instance row gone), after that the new attempt goes through (202). The `worked` fixtures here and in
//       stacks-inset.test.js (16) carry `ready` as done in the log (as stacks/build.js).
//
// COUNTER-TESTS (each shown red by one sabotage):
//   stacks/request.js: the pre-check blocks every live copy                                  => (1) red (409 before the await)
//   stacks/state.js: copyRequests without resolving failed ones                              => (1) red (409 at the index)
//   stacks/inset.js: cleanFailed without `worked` (wasReady)                                 => (2) red (case "work": 202 — the
//                                                                                                work of the copy would be gone)
//                    cleanFailed without `job`                                               => (2) red (case "job": 202)
//                    cleanFailed without `instance`                                          => (2) red (case "rest": the pre-check
//                                                                                                lets it pass, only the second layer holds)
//                    moveInWakeText always counts "clean"                                    => (3) red
//   stacks/remove.js performAction: `neverBuilt = false`                                     => (4) red
//   stacks/inset.js jobStatus without "failed"/"repeated" (always "running")                 => (2b) red
//                   cleanFailed without `job`                                                => (2b) red (202 instead of 409)
//   stacks/remove.js: the registration setClearAwayRunning missing                           => (2b) red (resumption: "failed"
//                                                                                                although it runs)
//   stacks/clearAway.js catch: `never = false`                                               => (5) red (sentence "Backup pending …")
//   stacks/inset.js wasReady reading the `clearAway` section alone                           => (5) red (reading `{ error }`: "the never
//                                                                                                built copy counts as obtained")
//
// No clock: waits on states (waitForTruthy without deadline), the log (waitForLog) and quiet. macOS: TMPDIR real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { containerName, copyInstance } from "../electron/server/projectbox/creation.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { projectLock } from "../electron/server/projectbox/idle.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { storageQueueSoon } from "../electron/server/workflows/storage-queue.js";
import { clearAwayCopy } from "../electron/server/stacks/clearAway.js";
import { neverBuilt, wasReady } from "../electron/server/stacks/inset.js";
import { removeStatus, copyOfTheChat, removeCopy, copiesRemoveCleanUp, copiesRemoveRestartGrace, setCopyClearerForTest } from "../electron/server/stacks/remove.js";
import { setQueueWakeup } from "../electron/server/stacks/queue.js";
import { dismantleCopy } from "../electron/server/stacks/dismantling.js";
import { removeJob, copyRequests, copyJournal, setCopyState } from "../electron/server/stacks/state.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function response(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
const post = (base, pid, body) => response(`${base}/api/projects/${pid}/stack-copies`, { method: "POST", body: JSON.stringify(body) });

function newChat(wsId, pid) {
  const t = Date.now();
  return store.createChat({ id: crypto.randomUUID(), workspaceId: wsId, projectId: pid, createdAt: t, updatedAt: t });
}
// A coding chat over REST (title set, no title oneshot) — one in which a wake turn runs with the fake CLI.
async function chatIn(ctx, pid) {
  const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "New attempt", projectId: pid }) });
  return store.getChat(c.id);
}

// A CONVERTED project with a running main in the fake docker and a code repo (as stacks-routes.test.js) — the request reads the
// refs of main IN main.
async function converted(ctx) {
  const s = scenario(ctx, { projectId: crypto.randomUUID() });
  const fd = await fakeDocker({ programs: { ...s.programs } });
  const pid = s.projectId;
  const cid = dx(fd, "run", "-d", "--name", containerName(pid), "--label", `cbase.project=${pid}`, "cbase-projectbox:latest");
  store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([]), ip: "127.0.0.1" });
  const d = path.join(s.path, "repo");
  git(d, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(d, "a.txt"), "one\n");
  git(d, "add", "a.txt");
  git(d, "commit", "-q", "-m", "one");
  return { s, fd, pid };
}

// The build fails as in stacks/build.js: the copy stood in `build` (instance row `create`, created in the SAME step), the
// dismantling (stacks/dismantling.js — here without an operation mark, so without docker) runs, and then `error` with the reason
// plus what stayed standing. `rest`: the instance row carries a container — the dismantling then does NOT take it (it throws with
// "left standing: container …"), it goes with the copy to `error`. `withoutWakeCall`: the wake-up mark set beforehand (the wake
// turn is not the subject there). `worked`: the journal carries `ready` as done and a clear-away (wasReady) — a copy in which work
// was done (the `clearAway` section alone no longer counts, stacks/inset.js wasReady).
async function failed(pid, chatId, name, { rest = false, withoutWakeCall = true, worked = false } = {}) {
  const k = copyRequests({ projectId: pid, name, chatId });
  setCopyState(k.id, "build", { phase: "clone1" });
  assert.equal(store.projectInstance(pid, copyInstance(name))?.state, "create", "build creates the instance row");
  if (rest) setInstanceState(pid, copyInstance(name), "create", { containerId: `c-rest-${name}` });
  setCopyState(k.id, "build", { phase: "prepare" });
  if (withoutWakeCall) store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "error", at: 0 } } } });
  if (worked) store.writeStackCopyJournal(k.id, { step: "ready", done: "ready", data: { clearAway: { time: 1, reason: "rest" } } });
  let addition = "";
  try {
    await dismantleCopy({ copy: store.stackCopy(k.id), instance: copyInstance(name), journal: copyJournal(k.id), reason: "error", rootCause: { step: "prepare", code: "COPY_REF_MISSING" } });
  } catch (e) { addition = ` — ${String(e?.message || e).split("\n")[0]}`; }
  const z = setCopyState(k.id, "error", { error: `prepare: a ref points to a missing object (COPY_REF_MISSING)${addition}` });
  assert.equal(z.state, "error");
  assert.equal(Boolean(store.projectInstance(pid, copyInstance(name))), rest, rest ? "the rest of the instance row is missing" : "the dismantling left the instance row standing");
  return store.stackCopy(k.id);
}

const liveOfTheChats = (chatId) => store.liveStackCopies().filter((k) => k.chatId === chatId);

// After each test: no copy lives any more, no instance row of a copy remains (a working one would hold the harness's quiet).
function clean() {
  for (const k of store.liveStackCopies()) {
    try {
      if (["build", "ready", "clearAway"].includes(k.state)) setCopyState(k.id, "error", { error: "test end" });
      store.deleteProjectInstance(k.projectId, copyInstance(k.name));
      setCopyState(k.id, "removed");
    } catch (e) { console.error("clean-up:", e?.message || e); }
  }
  copiesRemoveCleanUp();
}

// The message (role user) of the wake-up for copy `name` whose summary matches `summary` — or null.
function wakeText(log, name, summary) {
  const m = log.find((x) => x.role === "user" && String(x.text || "").includes(`<task-id>${copyInstance(name)}</task-id>`) && summary.test(String(x.text || "")));
  return m ? String(m.text) : null;
}

test("(1) a new attempt of the same chat goes through (202) as ANOTHER copy — the failed one stays and keeps its name; named explicitly => 409 with the sentence; a third attempt => 202", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await converted(ctx);
    let woken = 0;
    setQueueWakeup(() => { woken += 1; }); // the queue starts nothing (stacks-routes.test.js (3))
    try {
      const chat = newChat(ctx.ws.id, b.pid);
      const old = await failed(b.pid, chat.id, "k1");
      const prior = JSON.stringify(old);

      const r = await withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id }));
      assert.equal(r.status, 202, `the new attempt after a clean failure: ${JSON.stringify(r.body)}`);
      assert.deepEqual([r.body.copy.name, r.body.copy.state, r.body.copy.chatId, r.body.copy.inset], ["k2", "waiting_queue", chat.id, true], "the automatic name skips the name of the failed copy");
      assert.equal(woken, 1, "the queue was not woken");
      assert.equal(JSON.stringify(store.stackCopy(old.id)), prior, "the failed copy was touched (replaced?) — it stays");
      assert.deepEqual(liveOfTheChats(chat.id).map((k) => [k.name, k.state]), [["k1", "error"], ["k2", "waiting_queue"]], "two live copies of the same chat");
      const list = await withOps(b.fd, () => response(`${ctx.base}/api/projects/${b.pid}/stack-copies?all=1`));
      assert.deepEqual(list.body.copies.map((k) => [k.name, k.state]), [["k1", "error"], ["k2", "waiting_queue"]]);

      // Explicitly its name: 409 — the sentence says what is with it and that without a name a free one is taken.
      const r2 = await withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id, name: "k1" }));
      assert.equal(r2.status, 409, JSON.stringify(r2.body));
      assert.equal(r2.body.code, "NAME_TAKEN", "the pre-check of the name (stacks/request.js) — the sentence comes from occupiedWhatToDo");
      assert.match(r2.body.error, /„k1“ \(error\).*cbase_copy_stack_remove with name "k1" releases the name.*without name cbase picks a free name/s, r2.body.error);

      // A third attempt of the same chat (the new one still waits): 202 — nothing holds it any more.
      const r3 = await withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id }));
      assert.equal(r3.status, 202, JSON.stringify(r3.body));
      assert.equal(r3.body.copy.name, "k3");
      assert.deepEqual(liveOfTheChats(chat.id).map((k) => k.name), ["k1", "k2", "k3"]);
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean();
      b.fd.cleanUp();
    }
  });
});

test("(2) leftovers or work in the failed copy do not stop a new attempt (202, the old one unchanged); the sentence stands at the 409 of its name", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await converted(ctx);
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    try {
      const cases = [
        // The dismantling left the instance row (container) standing.
        ["rest", { rest: true }, /dismantling left something standing \(instance copy-rest: error\): cbase_copy_stack_remove with name "rest" removes the leftovers/],
        // Work was done in it (the journal carries a clear-away): fetch and back up.
        ["work", { worked: true }, /Work was done in it: cbase_copy_stack_remove with name "work" fetches and backs up/],
        // A job to clear away — running or failed — is in (2b), at the real clearing away.
      ];
      for (const [name, like, set] of cases) {
        const chat = newChat(ctx.ws.id, b.pid);
        const old = await failed(b.pid, chat.id, name, like);
        const prior = JSON.stringify(old);
        const occupied = await withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id, name }));
        assert.equal(occupied.status, 409, `${name}: ${JSON.stringify(occupied.body)}`);
        assert.equal(occupied.body.code, "NAME_TAKEN", `${name}: ${JSON.stringify(occupied.body)}`);
        assert.match(occupied.body.error, new RegExp(`„${name}“ \\(error\\)`), occupied.body.error);
        assert.match(occupied.body.error, set, `${name}: the sentence does not say what is with it — ${occupied.body.error}`);
        const r = await withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id }));
        assert.equal(r.status, 202, `${name}: the new attempt without a name — ${JSON.stringify(r.body)}`);
        assert.equal(JSON.stringify(store.stackCopy(old.id)), prior, `${name}: the failed copy was touched`);
        assert.deepEqual(liveOfTheChats(chat.id).map((k) => k.id), [old.id, r.body.copy.id], `${name}: not both live`);
      }
      assert.equal(woken, 2, "the queue was not woken per new attempt");
      // The same lock at the setter itself (stacks/state.js copyRequests — the path of the index), with the same sentence.
      const rest = store.liveStackCopies(b.pid).find((k) => k.name === "rest");
      assert.throws(() => copyRequests({ projectId: b.pid, name: "rest", chatId: rest.chatId }),
        (e) => e.code === "COPY_OCCUPIED" && e.status === 409 && /cbase_copy_stack_remove with name "rest" removes the leftovers/.test(e.message));
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean();
      b.fd.cleanUp();
    }
  });
});

test("(2b) a job to clear away: while it RUNS the 409 says it is being removed, the result comes; once it FAILED (reported, nothing runs) it names cbase_copy_stack_remove AGAIN — and the second call really executes; in the resumption after a restart it says both", async () => {
  // The stand-in at the seam (stacks/remove.js setCopyClearerForTest): every call returns `error` — like a clear-away that
  // fails —, a call with a gate stops there (the RUNNING clear-away, no clock). The copy already stands in `error`, never built
  // and WITHOUT leftovers (the dismantling took the instance row): only the job holds the name here.
  const calls = [];
  const gates = new Map(); // number of the call -> { begun, open }
  const gateFor = (n) => {
    const t = {};
    t.begun = new Promise((r) => { t.go = r; });
    t.open = new Promise((r) => { t.on = r; });
    gates.set(n, t);
    return t;
  };
  setCopyClearerForTest(async (copyId, opts = {}) => {
    calls.push({ copyId, ...opts });
    const t = gates.get(calls.length);
    if (t) { t.go(); await t.open; }
    return { state: "error", report: "Test: the clear-away fails" };
  });
  try {
    await withAgentsServer(async (ctx) => {
      const b = await converted(ctx);
      setQueueWakeup(() => {});
      try {
        // A chat over REST: the wake-up of the failed clear-away (from "agent") runs there as a real wake turn with the fake CLI —
        // outside withOps, i.e. on today's path (runInstance without operation: no instance).
        const chat = await chatIn(ctx, b.pid);
        const k = await failed(b.pid, chat.id, "k1");
        // The 409 comes over the NAME "k1" — without a name the new attempt would go through, (1).
        const attempt = () => withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id, name: "k1" }));
        const occupied = (r, where) => {
          assert.equal(r.status, 409, `${where}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.code, "NAME_TAKEN", `${where}: ${JSON.stringify(r.body)}`);
          assert.match(r.body.error, /„k1“ \(error\)/, r.body.error);
          return r.body.error;
        };
        const NOT_CLEARED_AWAY = /<summary>Copy "k1" not removed/;
        const wakeCalls = async () => (await json(`${ctx.base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "user" && wakeText([m], "k1", NOT_CLEARED_AWAY)).length;
        const RUNNING = /It is being removed; the result comes as a system message/;
        const FAILED = /Its removal failed .* call cbase_copy_stack_remove with name "k1" again/;
        const REPEATED = /Its removal had failed and is running once more right now: if it succeeds, a system message comes.*if it fails again, NONE comes — then call cbase_copy_stack_remove with name "k1" again/;

        // (a) The clear-away RUNS (at the gate): the new attempt waits for the system message — also at the setter (index).
        const t1 = gateFor(1);
        const first = removeCopy(k.id, { reason: "tool", from: "agent" });
        await t1.begun;
        assert.equal(removeStatus().running, 1, "the clear-away does not run");
        let t = occupied(await attempt(), "running");
        assert.match(t, RUNNING, `running: ${t}`);
        assert.doesNotMatch(t, /again/, `running: the sentence sends to clear away once more — ${t}`);
        assert.throws(() => copyRequests({ projectId: b.pid, name: "k1", chatId: chat.id }), (e) => e.code === "COPY_OCCUPIED" && RUNNING.test(e.message));

        // (b) It FAILS: reported (a wake-up "not cleared away"), after that nothing runs or waits any more — nothing comes by itself.
        t1.on();
        const e1 = await first;
        assert.equal(e1.state, "error", JSON.stringify(e1));
        await ctx.waitForLog(chat.id, (l) => wakeText(l, "k1", NOT_CLEARED_AWAY));
        await ctx.waitForQuiet();
        assert.equal(removeJob(store.stackCopy(k.id))?.reported?.state, "error", "the failure is not reported in the job");
        assert.deepEqual(removeStatus(), { open: [], running: 0 }, "after the failure something still runs or waits");
        const prior = JSON.stringify(store.stackCopy(k.id));
        t = occupied(await attempt(), "failed");
        assert.match(t, FAILED, `failed: the sentence does not say what to do — ${t}`);
        assert.doesNotMatch(t, RUNNING, `failed: the sentence lets one wait for a system message that never comes — ${t}`);
        assert.equal(JSON.stringify(store.stackCopy(k.id)), prior, "the 409 touched the copy");
        assert.deepEqual(liveOfTheChats(chat.id).map((x) => x.id), [k.id], "a second row");
        assert.throws(() => copyRequests({ projectId: b.pid, name: "k1", chatId: chat.id }), (e) => e.code === "COPY_OCCUPIED" && FAILED.test(e.message));

        // (c) The sentence keeps its word: cbase_copy_stack_remove again (the same entry, from "agent") EXECUTES — and reports.
        const e2 = await removeCopy(k.id, { reason: "tool", from: "agent" });
        assert.equal(calls.length, 2, `the second call did not run: ${calls.length} call(s)`);
        assert.equal(e2.state, "error", JSON.stringify(e2));
        await ctx.waitForLog(chat.id, (l) => l.filter((m) => m.role === "user" && wakeText([m], "k1", NOT_CLEARED_AWAY)).length >= 2);
        await ctx.waitForQuiet();

        // (d) Restart: the restart grace resumes the reported job (stacks/remove.js copiesRemoveRestartGrace) — it RUNS (at the
        // gate), but a renewed failure is not reported once more. The sentence says both; afterwards "failed" again.
        const t3 = gateFor(3);
        copiesRemoveCleanUp(); // server end: waker and tick gone, the job (reported `error`) stays in the journal
        const after = copiesRemoveRestartGrace();
        assert.equal(after.jobs, 1, "the restart grace did not resume the job");
        await after.finished;
        await t3.begun;
        t = occupied(await attempt(), "repeated");
        assert.match(t, REPEATED, `resumption: ${t}`);
        assert.doesNotMatch(t, RUNNING, `resumption: the sentence promises a system message that does not come on a renewed failure — ${t}`);
        t3.on();
        await waitForTruthy(() => (calls.length >= 3 && removeStatus().running === 0 ? true : null), "the resumption is over");
        await ctx.waitForQuiet();
        assert.equal(await wakeCalls(), 2, "the resumption reported its failure once more");
        t = occupied(await attempt(), "after the resumption");
        assert.match(t, FAILED, `after the resumption: ${t}`);
      } finally {
        for (const x of gates.values()) x.on();
        setQueueWakeup(storageQueueSoon);
        clean();
        b.fd.cleanUp();
      }
    });
  } finally { setCopyClearerForTest(null); }
});

test("(3) the wake-up \"not built\" says the same as the request: in both cases a new attempt goes directly; clean => cbase_copy_stack_remove releases the name, leftovers => removes the leftovers", async () => {
  await withAgentsServer(async (ctx) => {
    try {
      // A project WITHOUT a main instance: the wake turn runs locally with the fake CLI (stacks-remove.test.js (4)).
      const pid = scenario(ctx, { projectId: crypto.randomUUID() }).projectId;
      const clean2 = await chatIn(ctx, pid);
      await failed(pid, clean2.id, "k1", { withoutWakeCall: false });
      const leftoversChat = await chatIn(ctx, pid);
      await failed(pid, leftoversChat.id, "k2", { rest: true, withoutWakeCall: false });

      const notBuilt = /<summary>Copy "k\d" not built/;
      const a = wakeText(await ctx.waitForLog(clean2.id, (l) => wakeText(l, "k1", notBuilt)), "k1", notBuilt);
      assert.match(a, /Nothing of it is left except its row: cbase_copy_stack_remove with name "k1" releases the name\. A new attempt goes directly with cbase_copy_stack at any time/, a);
      const b = wakeText(await ctx.waitForLog(leftoversChat.id, (l) => wakeText(l, "k2", notBuilt)), "k2", notBuilt);
      assert.match(b, /Its dismantling left something standing \(instance copy-k2: error\): cbase_copy_stack_remove with name "k2" removes the leftovers/, b);
      // A new attempt goes directly even with leftovers — the wake-up says so.
      assert.match(b, /A new attempt goes directly with cbase_copy_stack at any time/, b);
      await ctx.waitForQuiet();
    } finally { clean(); }
  });
});

test("(4) clearing away a NEVER built copy reports \"never built\" — without commits, branches copy/<name>/… and report (tool from \"agent\" wakes, REST from \"mensch\" silent, project deletion from \"cbase\")", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker();
    try {
      const pid = scenario(ctx, { projectId: crypto.randomUUID() }).projectId;
      const without = (t, where) => {
        for (const [word, re] of [["copy/<name>/", /copy\/k\d\//], ["Commits", /Commits/i], ["Branches", /Branch/i], ["Report", /Bericht|\breport\b/i]]) {
          assert.equal(re.test(t), false, `${where}: the message of a never built copy names ${word}: ${t}`);
        }
      };

      // The old tool path (cbase_copy_stack_remove through the fence, without the own chat — from "agent"): a wake-up to the
      // creator. (A REST DELETE from "mensch" never wakes, see below.)
      const chat = await chatIn(ctx, pid);
      const k = await failed(pid, chat.id, "k1", { rest: true });
      await withOps(fd, async () => {
        await removeCopy(k.id, { reason: "tool", from: "agent" });
        await waitForTruthy(() => (store.stackCopy(k.id)?.state === "removed" ? true : null), "the never built copy is removed");
      });
      assert.equal(store.projectInstance(pid, "copy-k1"), null, "the rest of the instance row stayed");
      const clearedAway = /<summary>Copy "k1" removed \(never built\)|<summary>Copy "k1" removed/;
      const t = wakeText(await ctx.waitForLog(chat.id, (l) => wakeText(l, "k1", clearedAway)), "k1", clearedAway);
      assert.match(t, /never built/, t);
      assert.match(t, /This chat keeps working in the main instance; a new attempt goes with cbase_copy_stack\./, t);
      without(t, "Weckruf");
      await ctx.waitForQuiet();

      // REST DELETE (from "mensch"): NO wake-up — the creator learns it silently, with the same short sentence "never built".
      const three = await chatIn(ctx, pid);
      const k3 = await failed(pid, three.id, "k3", { rest: true });
      await withOps(fd, async () => {
        const r = await response(`${ctx.base}/api/projects/${pid}/stack-copies/k3`, { method: "DELETE", body: "{}" });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        await waitForTruthy(() => (store.stackCopy(k3.id)?.state === "removed" ? true : null), "the never built copy k3 is removed");
      });
      await ctx.waitForQuiet();
      const log3 = await json(`${ctx.base}/api/chats/${three.id}/log`);
      assert.equal(JSON.stringify(log3).includes("<task-id>copy-k3</task-id>"), false, "a human cleared away, and the creator was woken");
      const h3 = store.openHints(three.id).map((x) => x.text).find((x) => x.includes("„k3“"));
      assert.ok(h3, `no hint for copy k3: ${JSON.stringify(store.openHints(three.id))}`);
      assert.match(h3, /nie gebaut.*dieser Chat arbeitet im Haupt/s, h3);
      without(h3, "Hinweis (Mensch)");

      // From "cbase" (automatic): a silent hint — likewise without commits and branches. Deleting the project is the trigger
      // "from cbase" (at the entry).
      const two = await chatIn(ctx, pid);
      const k2 = await failed(pid, two.id, "k2", { rest: true });
      await withOps(fd, async () => {
        await removeCopy(k2.id, { reason: "project-deleted", from: "cbase" });
        await waitForTruthy(() => (store.stackCopy(k2.id)?.state === "removed" ? true : null), "the never built copy is removed");
      });
      const h = store.openHints(two.id).map((x) => x.text).find((x) => x.includes("„k2“"));
      assert.ok(h, `no hint for copy k2: ${JSON.stringify(store.openHints(two.id))}`);
      assert.match(h, /nie gebaut/, h);
      without(h, "Hint");
      await ctx.waitForQuiet();
    } finally {
      clean();
      fd.cleanUp();
    }
  });
});

// ── (5) a failed dismantling does not make a never built copy a fetched one ───────────────────────────────────────────────────
// The error catch of stacks/clearAway.js used to write the `clearAway` section (`{ error }`) on the "never built" path too, and
// wasReady read "work was done here" from it: ONE hiccup of the daemon during the dismantling, and every further clear-away took
// the path with fetching (COPY_STANDS — there is no copy), the chat hung on the lock of a copy it was never in, a new attempt
// answered 409 "Work was done in it", project and workspace deletion 409 — forever.
test("(5) a failed dismantling of a NEVER built copy (a hiccup of the daemon) leaves it never built — no `clearAway` section, the chat does not bind to it, the next call dismantles, the new attempt goes through; rows an earlier release wrote this way heal on reading", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await converted(ctx);
    setQueueWakeup(() => {});
    try {
      const chat = newChat(ctx.ws.id, b.pid);
      const k = await failed(b.pid, chat.id, "k1", { rest: true });
      assert.equal(neverBuilt(k), true, "precondition: never built");
      const neverFetched = async (where) => {
        const z = store.stackCopy(k.id);
        assert.equal(z.state, "error", where);
        assert.equal(wasReady(z), false, `${where}: the never built copy counts as obtained`);
        assert.equal(neverBuilt(z), true, where);
        assert.equal(copyOfTheChat(chat.id), null, `${where}: the chat binds to a copy it was never in`);
        const s = await withOps(b.fd, () => projectLock(chat.id, "turn"));
        assert.equal(s, null, `${where}: the lock holds the chat — ${JSON.stringify(s)}`);
        // Its name is taken — with the sentence of the dismantling, not with "Work was done in it".
        const r = await withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id, name: "k1" }));
        assert.equal(r.status, 409, `${where}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /dismantling left something standing \(instance copy-k1: error\): cbase_copy_stack_remove with name "k1" removes the leftovers/, `${where}: ${r.body.error}`);
        assert.doesNotMatch(r.body.error, /Work was done in it/, `${where}: ${r.body.error}`);
      };

      // (a) A hiccup of the daemon: every docker call fails, the dismantling too.
      const one = await withOps(b.fd, () => clearAwayCopy(k.id, { reason: "test" }), { CBASE_DOCKER_BIN: "/usr/bin/false" });
      assert.equal(one.state, "error", JSON.stringify(one.report));
      assert.match(one.report.error, / — nie gebaut, in ihr gibt es nichts zu sichern; ein neuer Aufruf \(cbase_copy_stack_remove\) baut den Rest zurück$/, one.report.error);
      assert.doesNotMatch(one.report.error, /Sicherung ausstehend|die Schicht bleibt/, one.report.error);
      assert.deepEqual([one.report.neverBuilt, "layer" in one.report, "backup" in one.report], [true, false, false], JSON.stringify(one.report));
      assert.equal(store.stackCopy(k.id).journal?.data?.clearAway, undefined, "the \"never built\" path wrote a clearAway section");
      assert.match(store.stackCopy(k.id).error, /nie gebaut/, "the reason is not in the row");
      await neverFetched("after the failed dismantling");

      // (b) Reading: how a release before wrote the row — first the reason, then on top the run of a second clear-away (COPY_STANDS).
      for (const clearAway of [
        { error: "Sicherung ausstehend: docker: Exit 1 — die Schicht bleibt: /x" },
        { time: 1, reason: "test", automatic: false, error: "Sicherung ausstehend: Kopie x/copy-k1: … (COPY_STANDS) — die Schicht bleibt: /x" },
      ]) {
        store.writeStackCopyJournal(k.id, { data: { clearAway } });
        await neverFetched(`reading ${JSON.stringify(clearAway)}`);
      }

      // (c) The daemon is back: the next call dismantles (not the path with fetching — there it ended COPY_STANDS) => removed.
      const two = await withOps(b.fd, () => clearAwayCopy(k.id, { reason: "test" }));
      assert.equal(two.state, "removed", JSON.stringify(two.report));
      assert.ok("dismantling" in two.report && !("fetch" in two.report), `not the dismantling: ${JSON.stringify(two.report)}`);
      assert.equal(store.projectInstance(b.pid, copyInstance("k1")), null, "the rest of the instance row stayed");

      // (d) The chat is free: the new attempt goes through.
      const r = await withOps(b.fd, () => post(ctx.base, b.pid, { chatId: chat.id }));
      assert.equal(r.status, 202, `the new attempt after the dismantling: ${JSON.stringify(r.body)}`);
      assert.deepEqual(liveOfTheChats(chat.id).map((x) => x.name), [r.body.copy.name], "the cleared-away one still lives");
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean();
      b.fd.cleanUp();
    }
  });
});
