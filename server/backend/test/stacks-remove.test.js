// Triggers and lifetime of a copy (stacks/remove.js) against the real server and the fake docker. The clearing away itself is
// a recording stand-in at the seam `remove.js:setCopyClearerForTest` (below, `fakeClearAway`: removes via the dismantling
// WITHOUT fetching): what is checked is THAT and WITH WHICH `reason`/`automatic` it was cleared away (`clearAwayCalls`) and that
// the copy is gone afterwards — never what was fetched. The path trigger -> REAL clear-away is held by stacks-clear-away.test.js.
//
// What holds:
//   (1) Deleting a chat does NOT clear the copy away — a copy belongs to no chat. It lives on (row `ready`, container and network
//       stand, no clearing away), its row names the creator as `createdOf` with `title: null`; `<runtime>/copy-worktrees/`
//       survives the closing path, the chat's own traces fall.
//   (2) Archiving (chat PUT and folder PUT) does NOT clear away — the copies live, no silent hint about the copy; a copy in the
//       build stays open work "copy" of the creating chat (409, stacks/remove.js copyWorkOf).
//   (3) Over REST: `waiting_storage` => discarded, without instance row and without build; `build`/`clone1` => the job waits, the
//       end of the build (wakeQueue) clears away.
//   (4) REST DELETE: `earmarked` only in stack_copies (instance row `ready`) while a turn IN the copy runs — a human over REST gets
//       409 without a job; the agent's tool IN the copy is earmarked, cleared away after the turn ends, with `retrieve`, and the
//       result as a wake-up in the chat. Body and 404.
//   (4b) Work of ANOTHER chat blocks the clearing away — also for the tool; a token does not claim a foreign chat; when the copy
//       is quiet the tool clears away and the wake-up goes to the CALLER (the creator learns silently).
//   (4c) A HUMAN (REST) never wakes the creator of a copy with `inset` — silent hint with the place where it works now; the old
//       tool path (token, without `chatId`) keeps waking the creator.
//   (5) Deleting a project or workspace: first DELETE 409 "copy k1 is being cleared away — delete again afterwards" and the
//       clearing away runs, after `removed` 200.
//   (6) Project switch: 200, the copy lives; the switch resets the binding (`chats.instance`), the way back does NOT bind again
//       (the instance is chosen in the chat, chat-instance.test.js); a silent hint.
//   (7) In the ending server the job stays in the journal (the queue does not start the row); copiesRemoveRestartGrace resumes it
//       and a `clearAway` without a run (`restartGrace`, automatic); the orphan sweep removes orphaned containers and networks
//       (label `cbase.chat` without a row AND without a chat), nothing else.
//   (8) server.js: setters and the place in the restart-grace timer; NO registration on chatClosed/chatArchived any more.
//
// COUNTER-TESTS (each shown red, then reverted):
//   runtime-location.js chatTraces also taking copy-worktrees                         => (1) red (the worktree fell)
//   server.js setQueueWakeup(storageQueueSoon) without copiesRemoveWake               => (3) red (clone1 stayed after ready)
//   remove.js decide without the idle check (`const reason = null`)                   => (4) red (cleared away under the turn)
//   projectbox/erase.js copy step only for the way "project"                          => (5) red (workspace: 409 of the lock)
//   runs/instance.js instanceNameForChat without the project comparison               => (6) red (in B the copy of A)
//   stacks/queue.js copyCandidates without `!removeJob(k)`                            => (7) red (the queue would offer it)
//   remove.js copiesRemoveRestartGrace without the half-cleared rows                  => (7) red (clearAway/fetch stayed)
//   remove.js orphan sweep without the chat check                                     => (7) red (a container with a chat fell)
//   remove.js copiesRemoveTurnEnd as an empty function                                => (4) red (0 instead of 1 clear-away after
//                                                                                        the turn end)
// (4) holds the end of the turn as a trigger: the check-back tick is set to one hour (CBASE_COPY_CHECK_BACK_MS), and after the
// turn end and two passes of the event loop the clearing away MUST have been called exactly once — otherwise the 60 s tick would
// make up for it. chat-instance.test.js (4) holds the sabotage "W26 removed in store/chats.js" for the reversed promises
// (delete chat, archive, switch without re-binding).
//
// No clock: waits on states (waitForTruthy, waitForQuiet) and gates. macOS: TMPDIR real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { createInstance } from "../electron/server/projectbox/instance.js";
import { cleanUpOpenRoot } from "../electron/server/projectbox/cleanUp.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { wakeProject } from "../electron/server/projectbox/idle.js";
import { instanceNameForChat, pinTurn, turnIdentifier } from "../electron/server/runs/instance.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { TOKEN_HEADER } from "../electron/server/projectbox/fence.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { removeCopy, copiesRemoveCleanUp, copiesRemoveRestartGrace, copiesRemoveWake, setCopyClearerForTest } from "../electron/server/stacks/remove.js";
import { dismantleCopy } from "../electron/server/stacks/dismantling.js";
import { copyCandidates, wakeQueue } from "../electron/server/stacks/queue.js";
import { removeJob, copyRequests, copyJournal, setCopyState } from "../electron/server/stacks/state.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

// The stand-in at the seam: record every call, then remove via what exists WITHOUT fetching — waiting => straight to `removed`;
// `ready`/`clearAway` => phase `fetch` (the instance row goes to `clearAway` in the same step), dismantling per the journal,
// `removed`, wakeProject.
const clearAwayCalls = [];
const short = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, 400);
async function fakeClearAway(copyId, opts = {}) {
  clearAwayCalls.push({ copyId, ...opts });
  const k = store.stackCopy(copyId);
  if (!k) return { state: "error", report: `copy ${copyId}: no row` };
  if (k.state === "removed") return { state: "removed", report: "already removed" };
  try {
    if (store.STACK_COPY_WAITING.includes(k.state)) {
      const report = "discarded while waiting — nothing created, nothing to fetch";
      setCopyState(k.id, "removed", { result: { report } });
      return { state: "removed", report };
    }
    if (k.state === "ready" || k.state === "clearAway") setCopyState(k.id, "clearAway", { phase: "fetch" });
    await Promise.resolve();
    await dismantleCopy({ copy: store.stackCopy(k.id), instance: copyInstance(k.name), journal: copyJournal(k.id), reason: "clearAway" });
    const report = `Stand-in: removed without fetching (${opts.reason || "—"})`;
    setCopyState(k.id, "removed", { result: { report } });
    try { wakeProject(k.projectId); } catch (e) { console.error(`stand-in clear-away ${k.projectId}/${k.name}: wake:`, short(e)); }
    return { state: "removed", report };
  } catch (e) {
    const report = `clear-away failed: ${short(e)}`;
    try { if (store.stackCopy(k.id)?.state !== "removed") setCopyState(k.id, "error", { error: report }); }
    catch (x) { console.error(`stand-in clear-away ${k.projectId}/${k.name}: error not set:`, short(x)); }
    return { state: "error", report };
  }
}
setCopyClearerForTest(fakeClearAway);

process.env.TMPDIR = fs.realpathSync(os.tmpdir());
const HERE = path.dirname(fileURLToPath(import.meta.url));

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const nextTick = () => new Promise((r) => setImmediate(r));

async function response(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
const erase = (base, what, id, { purge = false } = {}) => response(`${base}/api/${what}/${id}${purge ? "?purge=1" : ""}`, { method: "DELETE" });

// A coding chat with a title (no title oneshot) in workspace and project.
async function chatIn(ctx, { wsId = ctx.ws.id, pid = null, folderId = null } = {}) {
  const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: wsId, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Copy test", ...(pid ? { projectId: pid } : {}), ...(folderId ? { folderId } : {}) }) });
  return store.getChat(c.id);
}

// A project with a created main (createInstance over the fake docker).
async function project(ctx, open, opts = {}) {
  const s = scenario(ctx, { projectId: crypto.randomUUID(), ...opts });
  const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: { ...s.programs } });
  open.push(fd);
  const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
  assert.equal(row.state, "ready");
  return { s, fd, pid: s.projectId };
}

// A `ready` copy with its instance row; with `fd` also container and network of the copy in the fake docker (labels as at creation).
let networkSeq = 10;
function copyReady(pid, chatId, name = "k1", fd = null) {
  const k = copyRequests({ projectId: pid, name, chatId });
  setCopyState(k.id, "build", { phase: "clone1" });
  // The `ready` wake-up (stacks/inset.js) is not the subject here — the mark is set beforehand, otherwise a wake turn would run in
  // the copy while the triggers are checked (stacks-inset.test.js holds the wake-up).
  store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
  setCopyState(k.id, "ready");
  if (fd) {
    const labels = ["--label", `cbase.project=${pid}`, "--label", `cbase.instance=${copyInstance(name)}`, "--label", `cbase.chat=${chatId}`];
    dx(fd, "network", "create", "--subnet", `10.230.${networkSeq++}.0/24`, ...labels, `cbase-kn-${pid}-${name}`);
    dx(fd, "run", "-d", "--name", `cbase-k-${pid}-${name}`, ...labels, "cbase-projectbox:latest");
  }
  return store.stackCopy(k.id);
}
const copyObjects = (fd, pid, name = "k1") => {
  const z = fd.state();
  return {
    container: Object.values(z.container).filter((c) => c.name === `cbase-k-${pid}-${name}`).length,
    networks: Object.values(z.networks).filter((n) => n.name === `cbase-kn-${pid}-${name}`).length,
  };
};
// A token only counts in a CONVERTED project (runs/instance.js via projectbox/run-instance.js: the main row with `convertedAt`) — the
// tests create it only around the tool calls: a turn in the converted project would otherwise run over the project container,
// and that is not the point here (the turn runs locally, pinned in the copy).
async function convertedDuring(pid, fn) {
  store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now(), containerId: "", desired: null, ip: "127.0.0.1" });
  try { return await fn(); } finally { store.deleteProjectInstance(pid, "main"); }
}
const callsSince = (n, id) => clearAwayCalls.slice(n).filter((a) => a.copyId === id).map(({ reason, automatic, retrieve }) => ({ reason, automatic, retrieve }));
const removed = (id) => waitForTruthy(() => (store.stackCopy(id)?.state === "removed" ? true : null), `copy ${id} removed`);

// After each test: every live row to `removed`, working instances to `error`, the fake docker gone.
function clean(open) {
  for (const k of store.liveStackCopies()) {
    try {
      if (["build", "ready", "clearAway"].includes(k.state)) setCopyState(k.id, "error", { error: "test end" });
      store.deleteProjectInstance(k.projectId, copyInstance(k.name));
      setCopyState(k.id, "removed");
    } catch (e) { console.error("clean-up:", e?.message || e); }
  }
  for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
  for (const fd of open) fd.cleanUp();
}

test("(1) deleting a chat does NOT clear the copy away: it lives on, `createdOf` without a title; copy-worktrees/ survives the closing path", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const { fd, pid } = await project(ctx, open);
      const chat = await chatIn(ctx, { pid });
      const k = copyReady(pid, chat.id, "k1", fd);
      assert.deepEqual(copyObjects(fd, pid), { container: 1, networks: 1 });
      // The worktree of a copy lies under `<runtime>/copy-worktrees/<name>/` — the chat's closing path never touches it. Next to
      // it a real trace of the chat that MUST fall.
      const wt = path.join(DIRS.data, "projects", pid, "copy-worktrees", "k1", `agent-${chat.id}`);
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(wt, "work.txt"), "unsaved\n");
      const lane = path.join(DIRS.data, "projects", pid, "scratch", chat.id);
      fs.mkdirSync(lane, { recursive: true });
      const n = clearAwayCalls.length;
      await withOps(fd, async () => {
        const r = await erase(ctx.base, "chats", chat.id);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        await ctx.waitForQuiet();
        // In a project with an instance the closing path removes the traces as root in the container (projectbox/cleanUp.js) —
        // asynchronously; clearing the copy away used to hide the wait (the same quiet).
        await cleanUpOpenRoot();
        // The list names the creator that no longer exists.
        const list = await response(`${ctx.base}/api/projects/${pid}/stack-copies`);
        assert.equal(list.status, 200, JSON.stringify(list.body));
        const row = list.body.copies.find((x) => x.id === k.id);
        assert.deepEqual(row?.createdOf, { chatId: chat.id, title: null }, JSON.stringify(row));
      });
      assert.ok(!store.getChat(chat.id), "the chat stayed");
      assert.equal(store.stackCopy(k.id).state, "ready", "the copy fell with the chat");
      assert.deepEqual(callsSince(n, k.id), [], "deleting the chat called the clearing away");
      assert.equal(removeJob(store.stackCopy(k.id)), null, "deleting the chat wrote a job");
      assert.deepEqual(copyObjects(fd, pid), { container: 1, networks: 1 }, "container or network of the copy fell");
      assert.equal(store.projectInstance(pid, "copy-k1").state, "ready");
      assert.ok(fs.existsSync(path.join(wt, "work.txt")), "the closing path removed copy-worktrees/");
      assert.equal(fs.existsSync(lane), false, "the chat's trace stayed — the closing path did not run");
    } finally { clean(open); }
  });
});

test("(2) archiving does NOT clear away: chat PUT and folder PUT leave the copies alive, no hint about the copy; a build = open work \"copy\" of the creator", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const { fd, pid } = await project(ctx, open);
      const a = await chatIn(ctx, { pid });
      const t = Date.now();
      const folder = store.createChatFolder({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: pid, name: "Folder", createdAt: t, updatedAt: t });
      const b = await chatIn(ctx, { pid, folderId: folder.id });
      assert.equal(store.getChat(b.id).folderId, folder.id);
      const ka = copyReady(pid, a.id, "k1", fd);
      const kb = copyReady(pid, b.id, "k2", fd);
      // A copy in the build is open work of the chat that created it (`copy`, only build/clearAway from `fetch`).
      const c = await chatIn(ctx, { pid });
      const kc = copyRequests({ projectId: pid, name: "k3", chatId: c.id });
      setCopyState(kc.id, "build", { phase: "clone1" });
      const n = clearAwayCalls.length;
      await withOps(fd, async () => {
        const locked = await response(`${ctx.base}/api/chats/${c.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
        assert.equal(locked.status, 409, JSON.stringify(locked.body));
        assert.deepEqual(locked.body.open.map((o) => o.reason), ["copy"]);
        assert.match(locked.body.open[0].text, /Kopie „k3“ wird gerade aufgebaut/);
        // Away with it — an instance row in `create` is work, the quiet below waited for it.
        setCopyState(kc.id, "error", { error: "Test" });
        store.deleteProjectInstance(pid, "copy-k3");
        setCopyState(kc.id, "removed");

        const ra = await response(`${ctx.base}/api/chats/${a.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
        assert.equal(ra.status, 200, JSON.stringify(ra.body));
        const rb = await response(`${ctx.base}/api/chat-folders/${folder.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
        assert.equal(rb.status, 200, JSON.stringify(rb.body));
        assert.deepEqual(rb.body.chatIds, [b.id]);
        await ctx.waitForQuiet();
      });
      assert.deepEqual([store.stackCopy(ka.id).state, store.stackCopy(kb.id).state], ["ready", "ready"], "a copy fell with the archive");
      assert.deepEqual([callsSince(n, ka.id), callsSince(n, kb.id), callsSince(n, kc.id)], [[], [], []], "the archive called the clearing away");
      assert.deepEqual([copyObjects(fd, pid, "k1"), copyObjects(fd, pid, "k2")], [{ container: 1, networks: 1 }, { container: 1, networks: 1 }]);
      for (const x of [a, b]) {
        assert.ok(store.getChat(x.id).archivedAt, `${x.id}: the chat came back from the archive (a wake-up?)`);
        assert.deepEqual(store.openHints(x.id).filter((y) => y.source === "stack-copy" && /abgeräumt/.test(y.text)), [], "a hint about the clearing away");
      }
    } finally { clean(open); }
  });
});

test("(3) over REST: waiting_storage => discarded without a build; build/clone1 => the job waits, the end of the build clears away", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const pid = scenario(ctx, { projectId: crypto.randomUUID() }).projectId;
      const fd = await fakeDocker();
      open.push(fd);
      const w = await chatIn(ctx, { pid });
      const a = await chatIn(ctx, { pid });
      const kw = copyRequests({ projectId: pid, name: "k1", chatId: w.id, state: "waiting_storage" });
      const ka = copyRequests({ projectId: pid, name: "k2", chatId: a.id });
      setCopyState(ka.id, "build", { phase: "clone1" });
      const n = clearAwayCalls.length;
      const url = `${ctx.base}/api/projects/${pid}/stack-copies`;

      // Do not wait for quiet: the instance row of the copy in the build (`create`) is open work until the build ends.
      const r1 = await withOps(fd, () => response(`${url}/k1`, { method: "DELETE", body: "{}" }));
      assert.equal(r1.status, 202, JSON.stringify(r1.body));
      await removed(kw.id);
      assert.deepEqual(callsSince(n, kw.id), [{ reason: "rest", automatic: false, retrieve: [] }]);
      assert.equal(store.projectInstance(pid, "copy-k1"), null, "a discarded request created an instance row");

      const r2 = await withOps(fd, () => response(`${url}/k2`, { method: "DELETE", body: "{}" }));
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      await waitForTruthy(() => removeJob(store.stackCopy(ka.id)), "the job");
      await nextTick();
      const midway = store.stackCopy(ka.id);
      assert.deepEqual([midway.state, midway.phase], ["build", "clone1"], "aborted in the middle of the build");
      assert.equal(removeJob(midway)?.reason, "rest");
      assert.deepEqual(callsSince(n, ka.id), []);
      // The end of the build (stacks/queue.js start -> finally): `ready`, then the queue's waker.
      setCopyState(ka.id, "ready");
      wakeQueue();
      await nextTick(); // the waker decides in the next pass, the call of the clearing away is synchronous there
      assert.deepEqual(callsSince(n, ka.id).length, 1, "the end of the build did not wake the job");
      await removed(ka.id);
      assert.deepEqual(callsSince(n, ka.id), [{ reason: "rest", automatic: false, retrieve: [] }]);
      assert.equal(store.projectInstance(pid, "copy-k2"), null);
      await ctx.waitForQuiet();
    } finally { clean(open); }
  });
});

const CLAUDE_HOLD = fakeClaude({
  main: 'if (text.includes("HOLD")) await gate("w24"); finished(); say({ type: "result", result: "ok", session_id: "main-session" });',
});

test("(4) DELETE: a human over REST gets 409 without a job under the turn; the tool of the agent IN the copy is earmarked, then cleared away with retrieve and a wake-up in the chat", async () => {
  // The check-back tick (default 60 s) must not make up for the clearing away here — otherwise (4) would stay green even if the
  // end of the turn does not wake. The tick is set to one hour for this test, and the clearing away must have happened in the
  // pass after the turn end (see below), not at some point.
  copiesRemoveCleanUp();
  const tickPrior = process.env.CBASE_COPY_CHECK_BACK_MS;
  process.env.CBASE_COPY_CHECK_BACK_MS = "3600000";
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      // A project without a main instance: the turn runs locally; the copy carries its instance row without a container.
      const pid = scenario(ctx, { projectId: crypto.randomUUID() }).projectId;
      const fd = await fakeDocker();
      open.push(fd);
      const chat = await chatIn(ctx, { pid });
      const k = copyReady(pid, chat.id, "k1");
      const url = `${ctx.base}/api/projects/${pid}/stack-copies`;
      await withOps(fd, async () => {
        assert.equal((await response(`${url}/k9`, { method: "DELETE", body: "{}" })).status, 404);
        const foreign = await response(`${url}/k1`, { method: "DELETE", body: JSON.stringify({ immediately: true }) });
        assert.equal(foreign.status, 400, JSON.stringify(foreign.body));
        assert.equal((await response(`${url}/k1`, { method: "DELETE", body: JSON.stringify({ retrieve: "a" }) })).status, 400);
      });
      assert.equal(store.stackCopy(k.id).state, "ready", "a rejected DELETE changed something");

      // A turn of the chat, held at the gate and pinned IN the copy (doRun does that itself).
      const r0 = await json(`${ctx.base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD please" }) });
      assert.ok(!r0.error, JSON.stringify(r0));
      await ctx.gate.reached("w24");
      pinTurn(chat.id, { projectId: pid, instance: { projectId: pid, instance: "copy-k1" } });
      assert.equal(turnIdentifier(chat.id), `${pid}/copy-k1`);

      const n = clearAwayCalls.length;
      // A human over REST has no turn of their own — the turn in the copy is the work of someone else: 409 with a list, no job in
      // the journal, nothing touched.
      const human = await withOps(fd, () => response(`${url}/k1`, { method: "DELETE", body: JSON.stringify({ retrieve: ["fresh/file.txt"] }) }));
      assert.equal(human.status, 409, JSON.stringify(human.body));
      assert.equal(human.body.code, "INSTANCE_WORKING");
      assert.deepEqual(human.body.chats.map((c) => [c.id, c.title]), [[chat.id, "Copy test"]]);
      assert.deepEqual(human.body.open, []);
      assert.equal(removeJob(store.stackCopy(k.id)), null, "the rejected DELETE wrote a job into the journal");
      assert.equal(store.stackCopy(k.id).state, "ready");
      // `chatId` only names the tool through the fence — without a token 400, nothing touched.
      const withoutFence = await withOps(fd, () => response(`${url}/k1`, { method: "DELETE", body: JSON.stringify({ chatId: chat.id }) }));
      assert.equal(withoutFence.status, 400, JSON.stringify(withoutFence.body));
      assert.equal(removeJob(store.stackCopy(k.id)), null);
      // The agent's tool IN the copy (token of the copy, its own chat): the ONLY work is its turn => earmarked.
      const tokenK = tokenFor(store.projectInstance(pid, "copy-k1"));
      const r = await convertedDuring(pid, () => withOps(fd, () => response(`${url}/k1`, { method: "DELETE", headers: { [TOKEN_HEADER]: tokenK }, body: JSON.stringify({ retrieve: ["fresh/file.txt"], chatId: chat.id }) })));
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.deepEqual([r.body.copy.state, r.body.copy.phase], ["clearAway", "earmarked"]);
      assert.equal("journal" in r.body.copy, false);
      assert.deepEqual({ ...r.body.job, since: 0 }, { reason: "tool", from: { who: "agent", chatId: chat.id }, retrieve: ["fresh/file.txt"], automatic: false, since: 0 });
      // `earmarked` only stands in stack_copies — the instance row stays `ready` (does not hold busy).
      assert.equal(store.projectInstance(pid, "copy-k1").state, "ready");
      // A waker in the middle of the turn changes nothing (from the copy only after the turn).
      copiesRemoveWake();
      await nextTick();
      await nextTick();
      assert.deepEqual(callsSince(n, k.id), [], "cleared away under the running turn of the copy");
      assert.equal(store.stackCopy(k.id).phase, "earmarked");

      ctx.gate.open("w24");
      // The end of the turn wakes (runs/instance.js turn release -> observer `end` -> copiesRemoveTurnEnd -> waker in the next
      // pass) — counted BEFORE waiting for `removed`: without the wake-up the copy would stand until the tick.
      await waitForTruthy(() => (turnIdentifier(chat.id) === null ? true : null), "Turn-Ende");
      await nextTick();
      await nextTick();
      assert.equal(callsSince(n, k.id).length, 1, "the end of the turn did not wake the clearing away (only the check-back tick would have made up for it)");
      await removed(k.id);
      assert.deepEqual(callsSince(n, k.id), [{ reason: "tool", automatic: false, retrieve: ["fresh/file.txt"] }]);
      assert.equal(store.projectInstance(pid, "copy-k1"), null);
      // The result as a wake-up in the main of the calling chat (occasion "event", form of the system message).
      const log = await ctx.waitForLog(chat.id, (l) => JSON.stringify(l).includes("<task-id>copy-k1</task-id>"));
      assert.match(JSON.stringify(log), /Copy \\"k1\\" removed/);
      await ctx.waitForQuiet();

      // Over REST: a waiting request is discarded at once — without a wake-up.
      const k2 = copyRequests({ projectId: pid, name: "k2", chatId: chat.id });
      const r2 = await withOps(fd, () => response(`${url}/k2`, { method: "DELETE", body: "{}" }));
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      assert.equal(r2.body.copy.state, "removed");
      await ctx.waitForQuiet();
      const log2 = await json(`${ctx.base}/api/chats/${chat.id}/log`);
      assert.equal(JSON.stringify(log2).includes("<task-id>copy-k2</task-id>"), false, "wake-up for a discarded request");
      assert.equal(store.stackCopy(k2.id).state, "removed");
    } finally { clean(open); }
  }, { claude: CLAUDE_HOLD }).finally(() => {
    copiesRemoveCleanUp(); // this test's tick gone
    if (tickPrior === undefined) delete process.env.CBASE_COPY_CHECK_BACK_MS; else process.env.CBASE_COPY_CHECK_BACK_MS = tickPrior;
  });
});

// Work of ANOTHER chat blocks the clearing away — also for the tool; a token claims no foreign chat; when the copy is quiet, the tool
// clears away, and the wake-up goes to the CALLER (the creator learns silently).
test("(4b) DELETE under the work of a foreign chat: the tool of another chat gets 409 with a list, no job; a token with a chat outside its instance is 403; quiet => cleared away, wake-up to the caller", async () => {
  copiesRemoveCleanUp();
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const pid = scenario(ctx, { projectId: crypto.randomUUID() }).projectId;
      const fd = await fakeDocker();
      open.push(fd);
      const a = await chatIn(ctx, { pid });
      const bChat = await chatIn(ctx, { pid });
      const c = await chatIn(ctx, { pid });
      const k = copyReady(pid, a.id, "k1");
      // B works in the copy (its binding, without a run) — its tool comes with the token of the copy; C stands in the main.
      store.updateChat(bChat.id, { instance: "copy-k1" });
      const url = `${ctx.base}/api/projects/${pid}/stack-copies`;
      // Chat A works IN the copy (its turn, held at the gate).
      const r0 = await json(`${ctx.base}/api/chats/${a.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD please" }) });
      assert.ok(!r0.error, JSON.stringify(r0));
      await ctx.gate.reached("w24");
      pinTurn(a.id, { projectId: pid, instance: { projectId: pid, instance: "copy-k1" } });
      const tokenK = tokenFor(store.projectInstance(pid, "copy-k1"));
      const n = clearAwayCalls.length;
      // The tool of chat B — A works in the copy: 409 with A in the list, no job, row unchanged.
      const foreign = await convertedDuring(pid, () => withOps(fd, () => response(`${url}/k1`, { method: "DELETE", headers: { [TOKEN_HEADER]: tokenK }, body: JSON.stringify({ chatId: bChat.id }) })));
      assert.equal(foreign.status, 409, JSON.stringify(foreign.body));
      assert.equal(foreign.body.code, "INSTANCE_WORKING");
      assert.deepEqual(foreign.body.chats.map((c) => c.id), [a.id]);
      assert.equal(removeJob(store.stackCopy(k.id)), null, "the rejected DELETE wrote a job into the journal");
      assert.equal(store.stackCopy(k.id).state, "ready");
      // A copy token claims no chat of the main (C — fence context chatReason): 403, nothing touched.
      const wrong = await convertedDuring(pid, () => withOps(fd, () => response(`${url}/k1`, { method: "DELETE", headers: { [TOKEN_HEADER]: tokenK }, body: JSON.stringify({ chatId: c.id }) })));
      assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
      assert.equal(removeJob(store.stackCopy(k.id)), null);
      assert.deepEqual(callsSince(n, k.id), []);

      ctx.gate.open("w24");
      await waitForTruthy(() => (turnIdentifier(a.id) === null ? true : null), "Turn-Ende");
      await ctx.waitForQuiet();
      // Quiet: B's tool clears away; the wake-up with the result goes to B, the creator A learns silently.
      // The clearing away (the stand-in: dismantling over docker) continues after the answer — the operation mark stays until `removed`.
      await withOps(fd, async () => {
        const ok = await convertedDuring(pid, () => response(`${url}/k1`, { method: "DELETE", headers: { [TOKEN_HEADER]: tokenK }, body: JSON.stringify({ chatId: bChat.id }) }));
        assert.equal(ok.status, 202, JSON.stringify(ok.body));
        await removed(k.id);
      });
      assert.deepEqual(callsSince(n, k.id), [{ reason: "tool", automatic: false, retrieve: [] }]);
      await ctx.waitForLog(bChat.id, (l) => JSON.stringify(l).includes("<task-id>copy-k1</task-id>"));
      await ctx.waitForQuiet();
      const logA = await json(`${ctx.base}/api/chats/${a.id}/log`);
      assert.equal(JSON.stringify(logA).includes("<task-id>copy-k1</task-id>"), false, "the creator was woken although B cleared away");
      assert.match(store.openHints(a.id).map((h) => h.text).join("\n"), /von einem anderen Chat/);
    } finally { clean(open); }
  }, { claude: CLAUDE_HOLD }).finally(() => copiesRemoveCleanUp());
});

// Only whoever triggered the clearing away as an AGENT is woken. A human (REST, `from: "human"`) does NOT wake the creator of a copy
// with `inset` — the creator gets the silent hint, which names the place where it works NOW (here another copy), not a fixed
// "in main". The old tool path (token, without `chatId`) keeps waking the creator.
// Counter-test: stacks/remove.js notice with the old condition `a.from.who !== "cbase" && … && k.inset` => (4c) red ("a human cleared
// away, and the creator A was woken" — the wake-up turn stood in A's log).
test("(4c) a human never wakes: REST DELETE of a copy with `inset` => no turn in the creator, a silent hint with its place; the old tool path (without chatId) wakes the creator", async () => {
  copiesRemoveCleanUp();
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const pid = scenario(ctx, { projectId: crypto.randomUUID() }).projectId;
      const fd = await fakeDocker();
      open.push(fd);
      const a = await chatIn(ctx, { pid });
      const c = await chatIn(ctx, { pid });
      // A created k1 (tool: `inset`), C created k2; A meanwhile works in k2 (the choice of its instance), C likewise.
      const k1 = copyReady(pid, a.id, "k1");
      const k2 = copyReady(pid, c.id, "k2");
      assert.equal(k1.inset, true, "the copy carries no `inset` — then (4c) would check nothing");
      store.updateChat(a.id, { instance: "copy-k2" });
      assert.deepEqual([store.getChat(a.id).instance, store.getChat(c.id).instance], ["copy-k2", "copy-k2"]);
      const url = `${ctx.base}/api/projects/${pid}/stack-copies`;
      const n = clearAwayCalls.length;

      // The HUMAN clears k1 away (REST, without a token): quiet => cleared away — and A, who created it, gets NO wake-up.
      await withOps(fd, async () => {
        const r = await response(`${url}/k1`, { method: "DELETE", body: "{}" });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        assert.deepEqual(r.body.job?.from, { who: "human" });
        await removed(k1.id);
      });
      assert.deepEqual(callsSince(n, k1.id), [{ reason: "rest", automatic: false, retrieve: [] }]);
      await ctx.waitForQuiet();
      const logA = await json(`${ctx.base}/api/chats/${a.id}/log`);
      assert.equal(JSON.stringify(logA).includes("<task-id>copy-k1</task-id>"), false, "a human cleared away, and the creator A was woken");
      assert.equal(logA.filter((m) => m.role === "user").length, 0, `a turn in the creator A: ${JSON.stringify(logA).slice(0, 400)}`);
      const hA = store.openHints(a.id).map((h) => h.text).find((t) => t.includes("Deine Kopie „k1“ ist abgeräumt"));
      assert.ok(hA, `no silent hint to the creator: ${JSON.stringify(store.openHints(a.id))}`);
      assert.match(hA, /Deine Kopie „k1“ ist abgeräumt \(rest\).*dieser Chat arbeitet in copy-k2\./s, hA);
      assert.equal(store.getChat(a.id).instance, "copy-k2", "clearing k1 away reset the binding to k2");

      // The old tool path (token of the copy, WITHOUT its own chat): the creator C is woken — after the move into main.
      const tokenK2 = tokenFor(store.projectInstance(pid, "copy-k2"));
      await withOps(fd, async () => {
        const r = await convertedDuring(pid, () => response(`${url}/k2`, { method: "DELETE", headers: { [TOKEN_HEADER]: tokenK2 }, body: "{}" }));
        assert.equal(r.status, 202, JSON.stringify(r.body));
        assert.deepEqual(r.body.job?.from, { who: "agent" });
        await removed(k2.id);
      });
      const logC = await ctx.waitForLog(c.id, (l) => JSON.stringify(l).includes("<task-id>copy-k2</task-id>"));
      assert.match(JSON.stringify(logC), /This chat works in the main instance of the project/);
      await ctx.waitForQuiet();
      // A worked in k2 and was reset by the move (silent hint) — it is not woken: it did not create k2.
      const logA2 = await json(`${ctx.base}/api/chats/${a.id}/log`);
      assert.equal(JSON.stringify(logA2).includes("<task-id>copy-k2</task-id>"), false, "the move woke A");
      assert.equal(store.getChat(a.id).instance, null);
    } finally { clean(open); }
  }, { claude: CLAUDE_HOLD }).finally(() => copiesRemoveCleanUp());
});

test("(5) deleting a project and a workspace: 409 \"copy is being cleared away\", the clearing away runs; after `removed` 200", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      for (const way of ["project", "workspace"]) {
        const wsPath = path.join(ctx.root, `ws-${way}`);
        fs.mkdirSync(wsPath);
        const ws = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: `Deleting ${way}`, path: wsPath }) });
        const { fd, pid } = await project(ctx, open, { workspace: ws });
        const chat = await chatIn(ctx, { wsId: ws.id, pid });
        const k = copyReady(pid, chat.id, "k1", fd);
        const [what, id] = way === "project" ? ["projects", pid] : ["workspaces", ws.id];
        const n = clearAwayCalls.length;
        await withOps(fd, async () => {
          const r1 = await erase(ctx.base, what, id, { purge: true });
          assert.equal(r1.status, 409, `${way}: ${JSON.stringify(r1.body)}`);
          assert.equal(r1.body.error, "Kopie k1 wird abgeräumt — danach erneut löschen");
          assert.equal(r1.body.code, "COPY_CLEAR_AWAY");
          assert.deepEqual(r1.body.copies.map((x) => [x.projectId, x.name, x.instance]), [[pid, "k1", "copy-k1"]]);
          assert.ok(store.getProject(pid), `${way}: the project fell with the first DELETE`);
          await removed(k.id);
          await ctx.waitForQuiet();
          const r2 = await erase(ctx.base, what, id, { purge: true });
          assert.equal(r2.status, 200, `${way}: ${JSON.stringify(r2.body)}`);
        });
        assert.deepEqual(callsSince(n, k.id), [{ reason: `${way}-deleted`, automatic: true, retrieve: [] }]);
        assert.deepEqual(copyObjects(fd, pid), { container: 0, networks: 0 });
        assert.ok(!store.getProject(pid), `${way}: the project stayed`);
        if (way === "workspace") assert.ok(!store.getWorkspace(ws.id), "the workspace stayed");
      }
    } finally { clean(open); }
  });
});

test("(6) project switch: 200, the copy lives; the switch resets the binding, the way back does not bind again; a silent hint", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const a = scenario(ctx, { projectId: crypto.randomUUID(), name: "Alpha" }).projectId;
      const b = scenario(ctx, { projectId: crypto.randomUUID(), name: "Beta" }).projectId;
      const chat = await chatIn(ctx, { pid: a });
      const without = await chatIn(ctx, { pid: a });
      const k = copyReady(a, chat.id, "k1");
      const n = clearAwayCalls.length;
      assert.equal(instanceNameForChat(chat.id, a), "copy-k1", "the inset did not bind the creating chat");
      assert.equal(instanceNameForChat(without.id, a), "main", "a chat without a copy");

      const hin = await response(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: b }) });
      assert.equal(hin.status, 200, JSON.stringify(hin.body));
      assert.equal(store.getChat(chat.id).projectId, b);
      assert.equal(store.getChat(chat.id).instance, null, "the project switch left the binding standing");
      assert.equal(store.stackCopy(k.id).state, "ready", "the switch touched the copy");
      assert.equal(instanceNameForChat(chat.id, b), "main", "in B the chat would run in the copy of A");
      const h1 = store.openHints(chat.id).filter((h) => h.source === "stack-copy");
      assert.equal(h1.length, 1);
      assert.match(h1[0].text, /im Projekt „Beta“ und arbeitet dort in main.*Kopie „k1“ im Projekt „Alpha“ lebt weiter/s);

      const back = await response(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: a }) });
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.equal(instanceNameForChat(chat.id, a), "main", "back in A the switch bound the chat to the copy again");
      assert.equal(store.openHints(chat.id).filter((h) => h.source === "stack-copy").length, 1, "a second hint without a copy binding");
      assert.deepEqual(callsSince(n, k.id), [], "a project switch is no trigger");
    } finally { clean(open); }
  });
});

test("(7) restart grace: the job survives the server end (the queue does not start the row), a clearAway without a run is resumed; the orphan sweep only removes orphans", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const { fd, pid } = await project(ctx, open);
      const chat = await chatIn(ctx, { pid });
      const img = "cbase-projectbox:latest";
      const lab = (instance, chatId) => ["--label", `cbase.project=${pid}`, "--label", `cbase.instance=${instance}`, "--label", `cbase.chat=${chatId}`];

      // The job stays in the journal in the ending server — the row waits, and the queue no longer offers it.
      const w = copyRequests({ projectId: pid, name: "k1", chatId: chat.id });
      assert.equal(copyCandidates().length, 1);
      serverEndMarkerForTest(true);
      let r;
      try { r = await removeCopy(w.id, { reason: "rest", from: "human" }); } finally { serverEndMarkerForTest(false); }
      assert.equal(r.state, "earmarked");
      assert.equal(store.stackCopy(w.id).state, "waiting_queue");
      assert.equal(removeJob(store.stackCopy(w.id))?.reason, "rest");
      assert.equal(copyCandidates().length, 0, "the queue would offer a row with a job to remove");

      // A clearing away that the last server run began (phase `fetch`, no run any more).
      const other = await chatIn(ctx, { pid });
      const h = copyReady(pid, other.id, "k2", fd);
      setCopyState(h.id, "clearAway", { phase: "fetch" });
      assert.equal(store.projectInstance(pid, "copy-k2").state, "clearAway");

      // Orphans and non-orphans.
      const ghosts = crypto.randomUUID();
      const waiseC = dx(fd, "run", "-d", "--name", "orphan-c", ...lab("copy-k7", ghosts), img);
      const waiseN = dx(fd, "network", "create", "--subnet", "10.230.77.0/24", ...lab("copy-k7", ghosts), "orphan-n");
      dx(fd, "volume", "create", "--label", `cbase.project=${pid}`, "--label", "cbase.instance=copy-k7", "orphan-v");
      dx(fd, "run", "-d", "--name", "with-chat", ...lab("copy-k8", chat.id), img); // the chat lives
      // The row lives (`ready` — a waiting one would be taken by the queue after the next waker), its chat does not.
      const rowWithoutChat = copyReady(pid, crypto.randomUUID(), "k9", fd);

      copiesRemoveCleanUp(); // a new process: nothing in the waker
      const n = clearAwayCalls.length;
      const report = await withOps(fd, async () => {
        const after = copiesRemoveRestartGrace();
        assert.equal(after.jobs, 2);
        const b = await after.finished;
        await removed(w.id);
        await removed(h.id);
        await ctx.waitForQuiet();
        return b;
      });
      assert.deepEqual(callsSince(n, w.id), [{ reason: "rest", automatic: false, retrieve: [] }]);
      assert.deepEqual(callsSince(n, h.id), [{ reason: "restartGrace", automatic: true, retrieve: [] }]);
      assert.deepEqual(copyObjects(fd, pid, "k2"), { container: 0, networks: 0 });
      assert.equal(store.projectInstance(pid, "copy-k2"), null);
      assert.deepEqual([report.container, report.networks, report.error], [[waiseC], [waiseN], []]);
      const z = fd.state();
      assert.deepEqual(Object.values(z.container).map((c) => c.name).filter((x) => x !== `cbase-p-${pid}`).sort(), [`cbase-k-${pid}-k9`, "with-chat"]);
      assert.ok(Object.values(z.container).some((c) => c.name === `cbase-p-${pid}`), "the main fell");
      assert.ok("orphan-v" in z.volumes, "a volume of the copy (without chat label) fell");
      assert.ok(!Object.values(z.networks).some((x) => x.name === "orphan-n"));
      assert.equal(store.stackCopy(rowWithoutChat.id).state, "ready");
      assert.deepEqual(copyObjects(fd, pid, "k9"), { container: 1, networks: 1 });
    } finally { clean(open); }
  });
});

test("(8) server.js: hooks, setters, waker and the place in the restart-grace timer", () => {
  const server = fs.readFileSync(path.join(HERE, "../electron/server/server.js"), "utf8");
  // Deleting a chat and archiving are no triggers any more — the registrations are gone, the hook kind "chatArchived" too.
  for (const gone of ["copyChatClosed", "copyChatArchived", 'registerHook("chatArchived"']) {
    assert.ok(!server.includes(gone), `server.js still names ${gone}`);
  }
  for (const row of [
    "setCopyWork(copyWorkOf);",
    "setCopySource(copyOfTheChat, { atSwitch: copyAtProjectSwitch, kind: copyKind });",
    "setCopyDeleteStep(copyDeleteStep);",
    "setQueueWakeup(() => { storageQueueSoon(); copiesRemoveWake(); });",
    // right after in the same observer the layout job — the copies stay second.
    "end: (a) => { try { recreateTurnObserver.end(a); } finally { try { copiesRemoveTurnEnd(a); } finally { layoutAfterChat(a?.chatId); } } },",
    "cleanUpRecreate(); copiesRemoveCleanUp();",
  ]) assert.ok(server.includes(row), `server.js: ${row}`);
  const block = server.slice(server.indexOf("const restartGrace = setTimeout("), server.indexOf("}, restartGraceMs());"));
  const a = block.indexOf("copiesRestartGrace();");
  const e = block.indexOf("copiesRemoveRestartGrace();");
  const g = block.indexOf("graphStartsRestartGrace();");
  assert.ok(a > 0 && e > a && g > e, "copiesRemoveRestartGrace is missing in the restart-grace timer or not between copiesRestartGrace and graphStartsRestartGrace");
});
