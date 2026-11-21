// The REST routes of the copies (stacks/routes.js, stacks/request.js) against the real server and the fake docker: the main
// `cbase-p-<pid>` runs in the fake, every git of the name choice runs through the real wrapper INSIDE the main (executed
// locally).
//
// What holds here:
//   (1) Without ops markers 404 "only in server mode" — no row, no docker.
//   (2) Per case: foreign chat ⇒ 400, no coding kind (manager, app agent) ⇒ 403, archived ⇒ 409, project not converted ⇒ 409;
//       also body (unknown field, `chatId` not a string), chat missing, `base` and name form, a `baseInstance` other than main
//       without a live template ⇒ 409 TEMPLATE_UNKNOWN, no instance ⇒ 400 BASE_INSTANCE_INVALID (the copy from a copy itself
//       is checked by copy-from-copy.test.js, the tool by copy-tools.test.js (2d)). None creates a row.
//   (3) Success: 202 with the row `waiting_queue` (without journal), the queue is WOKEN (counting seam setQueueWakeup —
//       without a procedure hook-up nothing starts). A second POST of the same chat ⇒ 202 (another copy, `k2`) and wakes; a
//       POST WITHOUT chatId (a human) ⇒ 202 with `chatId: null`, `createdOf: null`, `inset: false`. The creator is listed as
//       `createdOf: { chatId, title }`. GET list and per name (404 for an unknown one), with the stored result and without
//       journal.
//   (4) A backup folder occupies its name, so does a ref `copy/<n>/…` in a repo of the main — the automatic name skips both;
//       named explicitly ⇒ 409 with a reason. A branch `copy` blocks the space ⇒ 409.
//   (4b) A tag `copy/k1/v1` and a note `refs/notes/copy/k2/x` occupy their names likewise (the fetch writes into all three
//       spaces) — the request gets k3.
//   (5) With a controllable procedure and an open storage gate the POST answers with the state AFTER the queue pass:
//       `build`/`clone1`, the procedure started exactly once.
//   (6) The chat is deleted or archived WHILE the refs are read (held at the exec gate `refs` of the fake docker) ⇒ 404
//       NO_CHAT or 409 ARCHIVED, no row, the queue stays asleep.
//   (7) The way the error wake call names (remove, then copy_stack) succeeds — see the head of the test.
//   (8) The base is pre-checked IN the main — a text no repo knows, a `rel` that is no repo of the main (also a worktree
//       without its own .git), a ref its repo does not know ⇒ 409 COPY_BASE at once; a repo in which `rev-parse` does not end
//       with 0/1 (a broken object) ⇒ 409 REFS_UNREADABLE, never "unknown"; reflog, stash and pseudo refs ⇒ 400 BASE_INVALID.
//       No row, the queue sleeps. A known ref ⇒ 202; a text only the copy's new project repo knows (the project folder has no
//       `.git` here) ⇒ 202 (the late check decides).
//   (8b) The same with a project repo WITH marker: a relative ref (`HEAD~1`) is not "unknown" there (the "state before copy"
//       commit shifts it) — a foreign name and a relative ref in a code repo stay 409.
//       `@{u}`, `@{upstream}`, `@{push}` (case-insensitive) are no reflog references — a repo with an upstream knows them, the
//       copy carries `branch.*`/`remote.*` and `refs/remotes/*` ⇒ 202; any other `@{…}` (also `@{0}`, a date) stays 400, and
//       the sentence names what works. `@{u}~1` without upstream (git dies with 128) is unknown (409 COPY_BASE), not "did not
//       look"; `broken~1` stays REFS_UNREADABLE; `^main` (exit 0 without id) is unknown. For (8b): the reservation only holds
//       if the project repo knows the NAME PART of the relative ref — `typo~1`, `mian^` ⇒ 409.
//
// COUNTER-PROOFS (each shown red):
//   request.js without the check `chat.projectId !== pid`            ⇒ (2) red (foreign chat: 202 instead of 400)
//   request.js without isCodingChat                                 ⇒ (2) red (manager chat: 202 instead of 403)
//   request.js without the archive check                             ⇒ (2) red (archived: 202 instead of 409)
//   request.js without the converted check                           ⇒ (2) red (409 REFS_UNREADABLE instead of NOT_CONVERTED)
//   request.js without wakeQueue()                                   ⇒ (3) red (wakeups 0 instead of 1)
//   request.js backupNames always returns []                         ⇒ (4) red (k1 instead of k3)
//   request.js/names.js reading only refs/heads/copy                 ⇒ (4b) red (k1 instead of k3)
//   request.js checking the chat only BEFORE the await               ⇒ (6) red (deleted: 202 and a row `waiting_queue`)
//   stacks/inset.js with the old note "A new attempt goes with cbase_copy_stack."
//                                                                    ⇒ (7) red (the named way: 409 "already has a live copy")
//   request.js checking only the form of the base                    ⇒ (8) red (unknown text: 202 and a row)
//   request.js without the call of baseInMain                        ⇒ (8) red (202 instead of 409)
//   request.js: knowsCommit reads every exit ≠ 0 as "unknown"        ⇒ (8) red (broken object: COPY_BASE instead of REFS_UNREADABLE)
//   request.js without the reservation `could` (text)                ⇒ (8) red ("HEAD~1": 409 instead of 202)
//   request.js: `could` with marker always false                     ⇒ (8b) red ("HEAD~1": 409 instead of 202)
//   request.js rejecting every `@{` again (onlyInMain)               ⇒ (8) red (400 instead of 409)
//   REFLOG letting `@{0}` through too                                ⇒ (8) red (`main@{0}`: 202 instead of 400)
//   knowsCommit without the name part at exit 128                    ⇒ (8) red (`@{u}~1`: REFS_UNREADABLE instead of COPY_BASE)
//   knowsCommit: exit 0 without checking the id                      ⇒ (8) red (`^main`: 202 instead of 409)
//   `could` with marker without the name part                        ⇒ (8b) red (`typo~1`: 202 instead of 409)
//   request.js without the main-stopped check / without the stopped-template branch ⇒ (9) red
//
// No clock: nothing is waited for — the queue pass is a microtask, the answer comes after. macOS: real TMPDIR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { containerName, copyInstance } from "../electron/server/projectbox/creation.js";
import { createProjectRepo } from "../electron/server/projectbox/projectRepo.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { storageQueueSoon } from "../electron/server/workflows/storage-queue.js";
import { projectCopiesLocation } from "../electron/server/stacks/location.js";
import { setCopyProcedure, setQueueWakeup } from "../electron/server/stacks/queue.js";
import { moveInWakeText } from "../electron/server/stacks/inset.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const GIB = 1024 ** 3;

// Status and body (also for 4xx).
async function response(url, init) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
const post = (base, pid, body) => response(`${base}/api/projects/${pid}/stack-copies`, { method: "POST", body: JSON.stringify(body) });
const get = (base, pid, rest = "") => response(`${base}/api/projects/${pid}/stack-copies${rest}`);

function newChat(wsId, pid, extra = {}) {
  const t = Date.now();
  return store.createChat({ id: crypto.randomUUID(), workspaceId: wsId, projectId: pid, createdAt: t, updatedAt: t, ...extra });
}

// A converted project with a running main and two code repos (`repo`, `repo2`).
async function build(ctx, fdOpts = {}) {
  const s = scenario(ctx, { projectId: crypto.randomUUID() });
  const fd = await fakeDocker({ programs: { ...s.programs }, ...fdOpts });
  const pid = s.projectId;
  const cid = dx(fd, "run", "-d", "--name", containerName(pid), "--label", `cbase.project=${pid}`, "cbase-projectbox:latest");
  store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([]), ip: "127.0.0.1" });
  for (const r of ["repo", "repo2"]) {
    const d = path.join(s.path, r);
    fs.mkdirSync(d, { recursive: true });
    git(d, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(d, "a.txt"), "one\n");
    git(d, "add", "a.txt");
    git(d, "commit", "-q", "-m", "one");
  }
  return { s, fd, pid, chat: newChat(ctx.ws.id, pid) };
}

// After every test: every row to `removed` (a live row would count in `copies`).
function clean(pid) {
  for (const k of store.liveStackCopies(pid)) {
    if (["build", "ready", "clearAway"].includes(k.state)) setCopyState(k.id, "error", { error: "end of test" });
    store.deleteProjectInstance(pid, copyInstance(k.name));
    setCopyState(k.id, "removed");
  }
}

test("(1) without ops markers 404 \"only in server mode\" — no row, no docker", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const n = b.fd.calls().length;
      for (const r of [await post(ctx.base, b.pid, { chatId: b.chat.id }), await get(ctx.base, b.pid), await get(ctx.base, b.pid, "/k1")]) {
        assert.equal(r.status, 404);
        assert.deepEqual(r.body, { error: "only in server mode" });
      }
      assert.deepEqual(store.stackCopiesOf(b.pid), []);
      assert.equal(b.fd.calls().length, n, "a docker call without ops");
    } finally {
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

test("(2) execution-side checks: foreign chat 400, no coding kind 403, archived 409, not converted 409 — no row", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    // A second project WITHOUT instance row (not converted) with a coding chat.
    const old = scenario(ctx, { projectId: crypto.randomUUID() });
    try {
      await withOps(b.fd, async () => {
        const fall = async (body, status, code, pid = b.pid) => {
          const r = await post(ctx.base, pid, body);
          assert.equal(r.status, status, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
          if (code) assert.equal(r.body.code, code, JSON.stringify(r.body));
          return r;
        };
        await fall({ chatId: newChat(ctx.ws.id, old.projectId).id }, 400, "FOREIGN_CHAT");
        await fall({ chatId: newChat(ctx.ws.id, null).id }, 400, "FOREIGN_CHAT");
        await fall({ chatId: newChat(ctx.ws.id, b.pid, { kind: "manager" }).id }, 403, "NO_CODING_CHAT");
        await fall({ chatId: newChat(ctx.ws.id, b.pid, { kind: "service" }).id }, 403, "NO_CODING_CHAT");
        const arch = newChat(ctx.ws.id, b.pid);
        assert.equal(store.archiveChat(arch.id), true);
        await fall({ chatId: arch.id }, 409, "ARCHIVED");
        await fall({ chatId: newChat(ctx.ws.id, old.projectId).id }, 409, "NOT_CONVERTED", old.projectId);
        // Body, chat, forms.
        await fall({ chatId: b.chat.id, color: "red" }, 400);
        // An empty body is a human creating (202, (3)) — a non-string chatId stays 400.
        await fall({ chatId: "" }, 400);
        await fall({ chatId: 7 }, 400);
        // A copy from a copy — the template must live (alive AND ready, stacks/request.js templateOf); no instance ⇒ 400.
        await fall({ chatId: b.chat.id, baseInstance: "copy-k1" }, 409, "TEMPLATE_UNKNOWN");
        await fall({ chatId: b.chat.id, baseInstance: "copy-Groß" }, 400, "BASE_INSTANCE_INVALID");
        await fall({ baseInstance: "" }, 400);
        await fall({ chatId: crypto.randomUUID() }, 404, "NO_CHAT");
        await fall({ chatId: b.chat.id, base: "-x" }, 400, "BASE_INVALID");
        await fall({ chatId: b.chat.id, base: { "../outside": "main" } }, 400, "BASE_INVALID");
        await fall({ chatId: b.chat.id, name: "Groß" }, 400, "NAME_INVALID");
        await fall({ chatId: b.chat.id, name: "main" }, 400, "NAME_INVALID");
      });
      assert.deepEqual(store.stackCopiesOf(b.pid), []);
      assert.deepEqual(store.stackCopiesOf(old.projectId), []);
    } finally {
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

test("(3) success: 202 waiting_queue, the queue woken; a second time of the same chat and without a chat likewise 202; GET list and per name, without journal", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    try {
      await withOps(b.fd, async () => {
        const r = await post(ctx.base, b.pid, { chatId: b.chat.id, base: { repo: "main" } });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        assert.deepEqual([r.body.copy.name, r.body.copy.state, r.body.copy.chatId, r.body.copy.base], ["k1", "waiting_queue", b.chat.id, { repo: "main" }]);
        assert.deepEqual([r.body.copy.inset, r.body.copy.baseInstance, r.body.copy.createdOf], [true, "main", { chatId: b.chat.id, title: b.chat.title }]);
        assert.equal("journal" in r.body.copy, false);
        assert.equal(woken, 1, "the queue was not woken");
        // The same chat once more ⇒ another copy.
        const two = await post(ctx.base, b.pid, { chatId: b.chat.id });
        assert.equal(two.status, 202, JSON.stringify(two.body));
        assert.deepEqual([two.body.copy.name, two.body.copy.chatId], ["k2", b.chat.id]);
        assert.equal(woken, 2);
        // Without a chat (a human, the UI): no chat checks, no move-in.
        const human = await post(ctx.base, b.pid, {});
        assert.equal(human.status, 202, JSON.stringify(human.body));
        assert.deepEqual([human.body.copy.name, human.body.copy.chatId, human.body.copy.createdOf, human.body.copy.inset], ["k3", null, null, false]);
        assert.equal(woken, 3);
        for (const x of [two, human]) setCopyState(x.body.copy.id, "removed");
        // The result is in the row (the build writes it) — GET returns it, the journal never.
        setCopyState(r.body.copy.id, "waiting_queue", { result: { version: 1, name: "k1", hints: ["x"] } });
        const list = await get(ctx.base, b.pid);
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.copies.map((k) => [k.name, k.state, "journal" in k]), [["k1", "waiting_queue", false]]);
        const one = await get(ctx.base, b.pid, "/k1");
        assert.equal(one.status, 200);
        assert.deepEqual(one.body.copy.result, { version: 1, name: "k1", hints: ["x"] });
        assert.equal("journal" in one.body.copy, false);
        assert.equal((await get(ctx.base, b.pid, "/k9")).status, 404);
        // Removed: no longer in the list, still readable with `all=1` and per name (the report).
        setCopyState(r.body.copy.id, "removed", { result: { version: 1, name: "k1", report: true } });
        assert.deepEqual((await get(ctx.base, b.pid)).body.copies, []);
        assert.deepEqual((await get(ctx.base, b.pid, "?all=1")).body.copies.map((k) => [k.name, k.state]), [["k1", "removed"], ["k2", "removed"], ["k3", "removed"]]);
        assert.deepEqual((await get(ctx.base, b.pid, "/k1")).body.copy.result, { version: 1, name: "k1", report: true });
      });
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

test("(4) backup folder and ref `copy/<n>/…` occupy the name; a branch `copy` blocks the space", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    try {
      fs.mkdirSync(path.join(projectCopiesLocation({ data: DIRS.data, projectId: b.pid }).backup, "k1"), { recursive: true });
      git(path.join(b.s.path, "repo"), "branch", "copy/k2/x");
      await withOps(b.fd, async () => {
        const a = await post(ctx.base, b.pid, { chatId: b.chat.id });
        assert.equal(a.status, 202, JSON.stringify(a.body));
        assert.equal(a.body.copy.name, "k3", "k1 (backup) and k2 (ref) are occupied");
        const c2 = newChat(ctx.ws.id, b.pid);
        for (const [name, reason] of [["k1", /Sicherungen einer früheren Kopie/], ["k2", /Branches unter copy\/k2\//], ["k3", /lebende Kopie/]]) {
          const r = await post(ctx.base, b.pid, { chatId: c2.id, name });
          assert.equal(r.status, 409, `${name}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.code, "NAME_TAKEN");
          assert.match(r.body.error, reason);
        }
        // A branch named exactly `copy` blocks the whole space.
        git(path.join(b.s.path, "repo2"), "branch", "copy");
        const space = await post(ctx.base, b.pid, { chatId: c2.id });
        assert.equal(space.status, 409, JSON.stringify(space.body));
        assert.equal(space.body.code, "SPACE_BLOCKED");
      });
      assert.equal(woken, 1);
      assert.deepEqual(store.liveStackCopies(b.pid).map((k) => k.name), ["k3"]);
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

test("(4b) a leftover tag `copy/k1/v1` and a note `refs/notes/copy/k2/x` in the main occupy their names — the request gets k3", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    try {
      const repo = path.join(b.s.path, "repo");
      git(repo, "tag", "copy/k1/v1");
      git(repo, "update-ref", "refs/notes/copy/k2/x", git(repo, "rev-parse", "HEAD").trim());
      await withOps(b.fd, async () => {
        const a = await post(ctx.base, b.pid, { chatId: b.chat.id });
        assert.equal(a.status, 202, JSON.stringify(a.body));
        assert.equal(a.body.copy.name, "k3", "k1 (tag) and k2 (note) are occupied");
      });
      assert.equal(woken, 1);
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

test("(5) with procedure and open gate: the answer shows the state AFTER the pass — build/clone1, the procedure started once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-routes-storage-"));
  const cg = path.join(root, "sys", "fs", "cgroup");
  fs.mkdirSync(cg, { recursive: true });
  fs.writeFileSync(path.join(cg, "memory.max"), `${8 * GIB}\n`);
  fs.writeFileSync(path.join(cg, "memory.current"), `${2 * GIB}\n`);
  const prior = process.env.CBASE_STORAGE_ROOT;
  process.env.CBASE_STORAGE_ROOT = root;
  try {
    await withAgentsServer(async (ctx) => {
      const b = await build(ctx);
      const runs = [];
      let end = null;
      setCopyProcedure((o) => {
        runs.push({ id: o.copy.id, instance: o.instance });
        return new Promise((r) => { end = r; }).then(() => {
          store.deleteProjectInstance(o.copy.projectId, o.instance);
          setCopyState(o.copy.id, "error", { error: "Probe: Ende" });
        });
      });
      try {
        await withOps(b.fd, async () => {
          const r = await post(ctx.base, b.pid, { chatId: b.chat.id });
          assert.equal(r.status, 202, JSON.stringify(r.body));
          assert.deepEqual([r.body.copy.state, r.body.copy.phase], ["build", "clone1"]);
          assert.deepEqual(runs, [{ id: r.body.copy.id, instance: copyInstance(r.body.copy.name) }]);
          end();
          await waitForTruthy(() => (store.stackCopy(r.body.copy.id).state === "error" ? true : null), "the procedure ended");
        });
      } finally {
        setCopyProcedure(null);
        if (end) end();
        clean(b.pid);
        b.fd.cleanUp();
      }
    });
  } finally {
    if (prior === undefined) delete process.env.CBASE_STORAGE_ROOT; else process.env.CBASE_STORAGE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The chat is deleted or archived WHILE the request reads the refs of the main (the only await, held here at the exec gate of
// the fake docker). Without the second check the request would afterwards create a row with `inset` for a chat that no longer
// exists, and the queue would build it.
// COUNTER-PROOF: request.js without the second check (`projectAndChat` only before the await) ⇒ red (202, a row, the queue woken).
test("(6) the chat is deleted or archived while the refs are read — 404 NO_CHAT or 409 ARCHIVED, no row, the queue sleeps", async () => {
  await withAgentsServer(async (ctx) => {
    const GATE = "refs";
    const b = await build(ctx, { execGate: GATE });
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    const gateBack = () => {
      b.fd.closeGate(GATE);
      fs.rmSync(path.join(b.fd.dir, "gates", `${encodeURIComponent(GATE)}.waiting`), { force: true });
    };
    try {
      await withOps(b.fd, async () => {
        for (const [what, disrupt, status, code] of [
          ["deleted", (chat) => response(`${ctx.base}/api/chats/${chat.id}`, { method: "DELETE" }), 404, "NO_CHAT"],
          ["archived", (chat) => response(`${ctx.base}/api/chats/${chat.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) }), 409, "ARCHIVED"],
        ]) {
          gateBack();
          const chat = newChat(ctx.ws.id, b.pid);
          const request = post(ctx.base, b.pid, { chatId: chat.id });
          await b.fd.gateReached(GATE);
          const s = await disrupt(chat);
          assert.equal(s.status, 200, `${what}: ${JSON.stringify(s.body)}`);
          b.fd.openGate(GATE);
          const r = await request;
          assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.code, code, `${what}: ${JSON.stringify(r.body)}`);
          assert.deepEqual(store.stackCopiesOf(b.pid), [], `${what}: a row for a chat that is ${what}`);
          assert.equal(woken, 0, `${what}: the queue was woken`);
        }
      });
    } finally {
      b.fd.openGate(GATE);
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

// The error wake call (stacks/inset.js moveInWakeText) names the way to a new attempt. A failed copy is LIVE (it holds the
// name) — "A new attempt goes with cbase_copy_stack" ended in 409 NAME_TAKEN. The guard walks EXACTLY the way the text names:
// every named tool in its order, through the route it calls (mcp/tools/stacks.js: remove = DELETE, copy_stack = POST) — and the
// last step must succeed.
// Red before the fix: only cbase_copy_stack was named ⇒ 409 NAME_TAKEN.
test("(7) the way the error wake call names (first cbase_copy_stack_remove, then cbase_copy_stack) succeeds", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    let woken = 0;
    setQueueWakeup(() => { woken += 1; }); // the new request does not build here (without procedure, counted as in (3))
    setCopyProcedure(null);
    try {
      await withOps(b.fd, async () => {
        const k = copyRequests({ projectId: b.pid, name: "k1", chatId: b.chat.id });
        // The marker beforehand: the test reads the text, a wake turn would otherwise run through the harness's fake CLI.
        store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "error", at: 0 } } } });
        setCopyState(k.id, "build", { phase: "clone1" });
        store.deleteProjectInstance(b.pid, copyInstance("k1")); // as after the freeze was rolled back
        setCopyState(k.id, "error", { error: "clone1: disk full" });
        const text = moveInWakeText(store.stackCopy(k.id), "error");
        const named = [...text.matchAll(/\bcbase_copy_stack(?:_remove|_fetch|_list)?\b/g)].map((m) => m[0]);
        assert.ok(named.length, `the error wake call names no way: ${text}`);
        const WAYS = {
          cbase_copy_stack_remove: async () => {
            const r = await response(`${ctx.base}/api/projects/${b.pid}/stack-copies/k1`, { method: "DELETE", body: "{}" });
            assert.equal(r.status, 202, `remove: ${JSON.stringify(r.body)}`);
            await waitForTruthy(() => (store.stackCopy(k.id).state === "removed" ? true : null), "the failed copy is cleared away");
            return r;
          },
          cbase_copy_stack: () => post(ctx.base, b.pid, { chatId: b.chat.id }),
        };
        let r = null;
        for (const w of named) {
          assert.ok(WAYS[w], `the error wake call names ${w} — no way to a new attempt`);
          r = await WAYS[w]();
        }
        assert.equal(named.at(-1), "cbase_copy_stack", `the named way does not end in the new attempt: ${named.join(" → ")}`);
        assert.equal(r.status, 202, `the named way (${named.join(" → ")}) fails: ${JSON.stringify(r.body)}`);
        // If nothing is left of the failed copy, the wake call names only cbase_copy_stack, and the new request supersedes it
        // (`removed`, result.superseded) — the automatic name skips the superseded one (k2). Via remove → copy_stack, k1 is
        // already `removed` and free.
        const direct = named.length === 1;
        assert.deepEqual([r.body.copy.name, r.body.copy.state], [direct ? "k2" : "k1", "waiting_queue"], `way ${named.join(" → ")}`);
        if (direct) assert.equal(store.stackCopy(k.id).state, "removed", "the cleanly failed copy was not superseded");
        assert.ok(woken >= 1, "the new request did not wake the queue"); // plus the end of the clearing away
      });
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

// A typo in `base` cost a volume clone, a pause of the main, creation and teardown and came back as a wake call — the request
// checked only the FORM, whether a repo knows the ref was left to the preparation in the copy. The guard enters the request
// path with every kind of base against real repos in the main (fake docker, git local): `repo` knows the tag `only-in-repo`
// and a branch `broken` on a destroyed object, `repo2` knows neither, `wt` is a worktree of `repo2` (gitfile — the copy does
// not carry it as a repo of its own, stacks/code-snapshot.js). The project folder has no `.git`: the copy would only get a new
// project repo before the freeze, which knows `HEAD~1` and `main` — that stays with the late check.
// COUNTER-PROOF: the form-only check ⇒ red (unknown text 202 with a row `waiting_queue`).
test("(8) the base is pre-checked in the main — unknown 409 COPY_BASE, not looked up 409 REFS_UNREADABLE, reflog/stash/pseudo ref 400; no row, the queue sleeps; known 202", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const repo = path.join(b.s.path, "repo");
    const repo2 = path.join(b.s.path, "repo2");
    git(repo, "tag", "only-in-repo");
    // A branch on a destroyed commit object: `rev-parse broken^{commit}` ends with 128, `for-each-ref refs/heads/copy` with 0.
    git(repo, "commit", "-q", "--allow-empty", "-m", "to be destroyed");
    const broken = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "branch", "broken", broken);
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    const object = path.join(repo, ".git", "objects", broken.slice(0, 2), broken.slice(2));
    fs.chmodSync(object, 0o644);
    fs.writeFileSync(object, "not zlib");
    git(repo2, "worktree", "add", "-q", "-b", "wt-branch", path.join(b.s.path, "wt"));
    // `repo` has an upstream like a clone (`branch.main.*`, `refs/remotes/origin/main`) — git resolves `@{u}`, `@{upstream}`
    // and `@{push}` from it, and the copy carries both (code-snapshot.js SCRIPT `config`, prepare.js).
    git(repo, "config", "remote.origin.url", "/nowhere");
    git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(repo, "config", "branch.main.remote", "origin");
    git(repo, "config", "branch.main.merge", "refs/heads/main");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    try {
      await withOps(b.fd, async () => {
        const fall = async (base, status, code, pattern = null) => {
          const r = await post(ctx.base, b.pid, { chatId: b.chat.id, base });
          assert.equal(r.status, status, `${JSON.stringify(base)} → ${JSON.stringify(r.body)}`);
          assert.equal(r.body.code, code, `${JSON.stringify(base)} → ${JSON.stringify(r.body)}`);
          if (pattern) assert.match(r.body.error, pattern, JSON.stringify(base));
          return r;
        };
        // Unknown: at once, in the wording of the late check (stacks/prepare.js).
        await fall("exists-not-e2e", 409, "COPY_BASE", /^basis „exists-not-e2e“: kein Repo der Kopie kennt diesen Commit \(repo, repo2; im Haupt nachgesehen\) — nichts wird geraten$/);
        await fall({ "exists-not": "main" }, 409, "COPY_BASE", /„exists-not“ — das Haupt hat keins unter diesem Pfad \(repo, repo2\)/);
        await fall({ wt: "main" }, 409, "COPY_BASE", /„wt“ — dort liegt ein Worktree, Submodul oder Verweis ohne eigenes \.git/);
        await fall({ repo2: "only-in-repo" }, 409, "COPY_BASE", /das Repo „repo2“ kennt „only-in-repo“ nicht als Commit/);
        await fall({ repo: "main", repo2: "only-in-repo" }, 409, "COPY_BASE", /„repo2“/);
        // Not looked up is not unknown (empty is not unknown).
        await fall("broken", 409, "REFS_UNREADABLE", /in repo \(Exit 128\) nicht nachgesehen/);
        await fall({ repo: "broken" }, 409, "REFS_UNREADABLE", /im Repo „repo“ nicht nachgesehen \(Exit 128\)/);
        // … also behind a relative ref: the name part `broken` itself dies with 128 — no "unknown" (knowsCommit). git 2.54 ends
        // this lookup with exit 1 instead, but prints the read error: a 1 with an error text is "not looked up" as well.
        await fall({ repo: "broken~1" }, 409, "REFS_UNREADABLE", /im Repo „repo“ nicht nachgesehen \(Exit (?:128|1)\)/);
        // Without upstream `repo2` does not know `@{u}` (exit 1); `@{u}~1` DIES there with 128 ("no upstream configured") and is
        // just as unknown, not "not looked up" — knowsCommit then asks the name part. `^main` (a negation, no revision) ends
        // with 0 but prints no id — unknown, as in the late check.
        await fall({ repo2: "@{u}" }, 409, "COPY_BASE", /das Repo „repo2“ kennt „@\{u\}“ nicht als Commit/);
        await fall({ repo2: "@{u}~1" }, 409, "COPY_BASE", /das Repo „repo2“ kennt „@\{u\}~1“ nicht als Commit/);
        await fall("@{u}~1", 409, "COPY_BASE", /^basis „@\{u\}~1“: kein Repo der Kopie kennt diesen Commit/);
        await fall("^main", 409, "COPY_BASE", /^basis „\^main“: kein Repo der Kopie kennt diesen Commit/);
        // What never exists in the copy (or points to another commit there): form (400), before any docker.
        const n = b.fd.calls().length;
        for (const base of ["main@{1}", "@{-1}", "main@{0}", "@{0}", "main@{yesterday}", "@{u}@{1}", "stash", "refs/stash", "ORIG_HEAD", "FETCH_HEAD~1", { repo: "MERGE_HEAD" }]) {
          await fall(base, 400, "BASE_INVALID", /gibt es in der Kopie nicht/);
        }
        // The sentence names what works — `@{…}` is not rejected wholesale.
        const reflog = await fall("main@{1}", 400, "BASE_INVALID", /`@\{u\}`, `@\{upstream\}` und `@\{push\}` gehen/);
        assert.doesNotMatch(reflog.body.error, /\(`@\{…\}`\)/, "the rejection rejects every @{…} again");
        assert.equal(b.fd.calls().length, n, "a form check called docker");
        assert.deepEqual(store.stackCopiesOf(b.pid), [], "a rejected base created a row");
        assert.equal(woken, 0, "a rejected base woke the queue");

        // Known: in one repo (text) or in the named one (object) ⇒ 202 (each its own chat — no longer necessary).
        const ok = async (base) => {
          const r = await post(ctx.base, b.pid, { chatId: newChat(ctx.ws.id, b.pid).id, base });
          assert.equal(r.status, 202, `${JSON.stringify(base)} → ${JSON.stringify(r.body)}`);
          assert.equal(r.body.copy.state, "waiting_queue");
          return r.body.copy;
        };
        await ok("only-in-repo");
        await ok({ repo: "only-in-repo", repo2: "main" });
        // Knows none today (one commit each), but the copy's new project repo does: not "unknown" — the late check decides.
        await ok("HEAD~1");
        await ok({ ".": "main" });
        // `@{u}`, `@{upstream}` and `@{push}` are no reflog references (case-insensitive, also with `~`/`^`) — `repo` knows
        // them, the copy too (measured, head of request.js). They used to be 400 "does not exist in the copy".
        await ok("@{u}");
        await ok({ repo: "main@{upstream}", repo2: "main" });
        await ok({ repo: "HEAD@{PUSH}" });
        await ok({ repo: "@{U}^{commit}" });
      });
      assert.deepEqual(store.liveStackCopies(b.pid).map((k) => [k.name, k.state]), ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"].map((n) => [n, "waiting_queue"]));
      assert.equal(woken, 8);
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

// The project repo WITH marker gets the commit "state before copy" before the copy — a relative ref points one commit further
// back in the copy. What only the copy knows there, the pre-check never calls "unknown"; a non-relative ref and a code repo
// (it gets no commit) stay unambiguous.
// COUNTER-PROOF: request.js without the reservation (`could` always false) ⇒ (8) and (8b) red ("HEAD~1": 409 instead of 202).
test("(8b) in the project repo with marker a relative ref is not \"unknown\" (state before copy) — a foreign name and a code repo are", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const pr = await createProjectRepo(b.s.path); // one commit, marker (as after the relocation)
    assert.equal(pr.created, true, JSON.stringify(pr));
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    try {
      await withOps(b.fd, async () => {
        const fall = async (base, status, code) => {
          const r = await post(ctx.base, b.pid, { chatId: newChat(ctx.ws.id, b.pid).id, base });
          assert.equal(r.status, status, `${JSON.stringify(base)} → ${JSON.stringify(r.body)}`);
          if (code) assert.equal(r.body.code, code, `${JSON.stringify(base)} → ${JSON.stringify(r.body)}`);
        };
        await fall("exists-not-e2e", 409, "COPY_BASE");
        await fall({ ".": "exists-not-e2e" }, 409, "COPY_BASE");
        await fall({ repo: "HEAD~1" }, 409, "COPY_BASE");
        // "State before copy" only shifts the position, no new name arises — a relative ref whose name part the project repo
        // does not know (a typo) is 409 at once, without row and without wake call.
        await fall({ ".": "typo~1" }, 409, "COPY_BASE");
        await fall("exists-not-e2e~1", 409, "COPY_BASE");
        await fall("mian^", 409, "COPY_BASE");
        await fall({ ".": "tippfehler^2" }, 409, "COPY_BASE");
        assert.deepEqual(store.stackCopiesOf(b.pid), [], "an unknown name part created a row");
        assert.equal(woken, 0);
        await fall("HEAD~1", 202);
        await fall({ ".": "HEAD~1" }, 202);
        await fall({ ".": "main", repo: "main" }, 202);
        // The name part is known: the reservation stays (the late check decides).
        await fall("main~1", 202);
        await fall({ ".": "@^" }, 202);
      });
      assert.equal(store.liveStackCopies(b.pid).length, 5);
      assert.equal(woken, 5);
    } finally {
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});

// ── (9) a STOPPED main or a stopped template ─────────────────────────────────────────────────────────────────────
// The request used to read the refs in the stopped main container and ended with 409 REFS_UNREADABLE — without a way, and a
// stopped template was "only comes into being when ready", although it never becomes ready by itself. Now: 409 MAIN_STOPPED
// BEFORE any docker exec (for every request — the copy from a template needs the main's refs too), the sentence names the
// "Instanzen" tab; a stopped template stays TEMPLATE_NOT_READY but names the way. No row, the queue sleeps.
// COUNTER-PROOF: request.js without the check `inst.state === "stopped" || …` ⇒ red (409 REFS_UNREADABLE instead of
// MAIN_STOPPED); without the stopped-template branch ⇒ red (the sentence does not name the tab).
test("(9) main stopped ⇒ 409 MAIN_STOPPED with a way, without docker exec; template stopped ⇒ TEMPLATE_NOT_READY with a way — no row", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    let woken = 0;
    setQueueWakeup(() => { woken += 1; });
    try {
      await withOps(b.fd, async () => {
        // The template k1 lives (ready), its instance row is stopped.
        const k1 = store.createStackCopy({ projectId: b.pid, name: "k1", chatId: b.chat.id, state: "ready" });
        store.createProjectInstance({ projectId: b.pid, instance: copyInstance("k1"), state: "stopped", convertedAt: Date.now() });
        const v = await post(ctx.base, b.pid, { chatId: b.chat.id, baseInstance: copyInstance("k1") });
        assert.equal(v.status, 409, JSON.stringify(v.body));
        assert.equal(v.body.code, "TEMPLATE_NOT_READY");
        assert.match(v.body.error, /ist gestoppt .*startet nicht von selbst — erst im Reiter „Instanzen“ starten/, JSON.stringify(v.body));

        // The main stops (row AND container, as projectbox/instance-stop.js): every request ends before reading the refs.
        dx(b.fd, "stop", store.projectInstance(b.pid, "main").containerId);
        const execs = () => b.fd.calls().filter((a) => a.args?.[0] === "exec").length;
        for (const state of ["stop", "stopped"]) {
          store.changeProjectInstance(b.pid, "main", { state });
          const prior = execs();
          for (const body of [{ chatId: b.chat.id }, {}, { chatId: b.chat.id, name: "k5", base: { repo: "main" } }]) {
            const r = await post(ctx.base, b.pid, body);
            assert.equal(r.status, 409, `${state} ${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
            assert.equal(r.body.code, "MAIN_STOPPED", JSON.stringify(r.body));
            assert.match(r.body.error, /Die Instanz main von Projekt .* ist gestoppt .*im Reiter „Instanzen“ starten/, JSON.stringify(r.body));
          }
          assert.equal(execs(), prior, "the request read in the stopped main");
        }
        assert.deepEqual(store.liveStackCopies(b.pid).map((k) => k.id), [k1.id], "a row despite the rejection");
        assert.equal(woken, 0, "the queue was woken");
      });
    } finally {
      // `stopping` is a working state (busy): if it stayed after a red case, the server's end would wait for quiet forever —
      // the counter-proof hung instead of going red.
      if (store.projectInstance(b.pid, "main")) store.changeProjectInstance(b.pid, "main", { state: "stopped" });
      setQueueWakeup(storageQueueSoon);
      clean(b.pid);
      b.fd.cleanUp();
    }
  });
});
