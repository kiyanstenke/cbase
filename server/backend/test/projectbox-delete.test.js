// Guard of the delete paths with a project container. Contract: after deleting a project or workspace no container of the project
// runs any more; without `purge=1` volume and runtime folder stay ("discarding is not deleting"); without an instance row both
// routes do EXACTLY what they did before (G2).
//
// Held here, through the real server in the test process and the fake docker (fake-docker.mjs):
//   - G2: without a row the same answer as before (word for word) and an EMPTY call log — project, workspace sub-route and workspace;
//   - with a row: `ps -a` and `ps` (what ran) → every `stop -t 30 <id>` → every `rm -f <id>` (by id, 64 base-16 digits; two
//     phases: stop everything first, then remove) → `network ls` → `network rm <id>` → probe `ps`; no `volume rm`; container and
//     network gone, volume, runtime folder and project folder present, row gone;
//   - a container with the project's label that the row does not know (a failed creation) is deleted too;
//   - purge=1: `volume rm`, runtime folder gone — a root-owned remainder goes through `docker exec -u root … rm -rf`, BEFORE the
//     `stop` (afterwards the container would not exist); counter-test: if the container does not run, the remainder stays and is
//     in the report (`runtime: "partial"`);
//   - 409 during `relocation`, `create`, `recreate`, while a procedure works on the instance and during a creation — and then
//     NOTHING is deleted (project, row, container, for the workspace also the chats);
//   - a failing `stop`: 500, nothing deleted;
//   - the probe after removing still finds a container: 500, and the row STAYS — otherwise a second attempt would take the path
//     without a row (no docker call, G2) and the remainder would live forever; the second attempt clears it;
//   - workspace with two projects with a row: both containers gone, both rows gone;
//   - without the operation mark (G1) with a row: no docker call, the row is deleted anyway;
//   - ONLY WHEN IDLE: a CONVERTED project that is being worked on is deleted by neither the project nor the workspace route — 409
//     with the reasons (`open`), no docker call, everything stays; when idle the "delete" lock holds over the whole delete: a
//     message during the `stop` waits (`locked`) and runs afterwards; a NOT converted project and operation without mark delete
//     as before, even in the middle of a turn;
//   - the workspace sub-route DELETE /api/workspaces/:wid/projects/:pid goes the same way as /api/projects/:id (projectbox/erase.js
//     projectDelete); source guard: `store.deleteProject(` only in a named table and there after `deleteProjectbox(`, both routes
//     call `projectDelete(`;
//   - a store that throws while locking releases the lock — its own and that of an already locked first project;
//   - a 409 at the second project of a workspace leaves the shell of the first alive; when idle the delete ends it;
//   - B cannot be stopped ⇒ 500, the already stopped container of A runs again, no row, no network is deleted;
//   - deleting a project brings the Claude session (with `<sid>/`) and Codex rollout from the project home to B — without and with
//     purge (before emptying); deleting a workspace does not (its chats are deleted with it);
//   - a project of ANOTHER workspace through the workspace sub-route ⇒ 404, nothing deleted (also with purge=1, also without row);
//   - purge=1 removes the top level of the runtime folder entry by entry through `removeAsRoot` (exec rm in the container) — at
//     the stop gate all entries are still in B, one exec rm each in the log; if it fails (wrong `rm`) step 6 clears after the
//     container ended; purge=1 also takes `<data>/copies-backup/<pid>/` (with `ignored.tar` holding the `.env`) and
//     `<data>/copies/<pid>` (only after success) — link-safe: a link in place of `copies/<pid>` is deleted itself, its target stays;
//     without purge and on 409 both stay; they are deleted also without an instance row and via the workspace sub-route;
//   - step 9b: `<data>/relocations/<pid>/` (with `env-backup/` holding the original `.env` files) goes after success with AND
//     without purge, with and without a row, via project and workspace route (there also for a project without a row); link-safe;
//     an open relocation journal holds it (notice, `leftBehind`); a 409 leaves it standing; the rows in `project_relocations` stay.
//
// COUNTER-TESTS (each shown red, taken back):
//   projects/routes.js and workspaces/routes.js from before the project container          ⇒ "with a row" and "workspace" red (no
//                                                          docker call, the container keeps running, the row stays)
//   erase.js: the lock of the states removed                  ⇒ "409" red (the container was deleted in the middle of a relocation)
//   erase.js: `volume rm` also without purge                  ⇒ "with a row" red (volume gone)
//   erase.js: step 1 (runtime with root fallback before the stop) removed ⇒ "purge=1" red (root-owned remainder stayed, "partial")
//   erase.js: only the id of the row, no `ps --filter label`  ⇒ "with a row" red (the orphaned container stayed, only the probe caught it: 500)
//   erase.js: the row deleted before the probe                ⇒ "the probe finds" red (row gone, the second attempt did not call docker)
//   erase.js without the idle lock                            ⇒ "only when idle" red (200, the container was deleted in the middle of a turn)
//   erase.js: the lock released right after the check         ⇒ "only when idle" red (the message during the stop ran at once, `locked` missing)
//   workspaces/routes.js from before the repair               ⇒ the sub-route tests red ("the sub-route deleted in the middle of a turn")
//   a throw in projectLocks does not release the lock         ⇒ the lock test red ("the lock of B stayed"); idleLocks not releasing the held ones ⇒ ("… of A stayed")
//   no restart of the stopped container                       ⇒ the B-not-stoppable test red ("the container of A does not run any more")
//   no bringing back of the sessions / only after phase 1     ⇒ the session test red ("with purge=1 the sessions were deleted …")
//   step 1 with runtimeAsServer before the stop               ⇒ "purge=1 … entry by entry" red (B deleted attachments, outputs, home, scratch while the container ran)
//   both calls of copiesLocationsRemove removed               ⇒ "purge=1 … backups" red (the backups stayed)
//   9b only with purge / without the check of the open journal / not in the branch without a row ⇒ the relocation-folder test red
//
// Run:  CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/projectbox-delete.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { volumeName } from "../electron/server/projectbox/creation.js";
import { docker } from "../electron/server/projectbox/docker.js";
import { createInstance, withProjectOccupancy } from "../electron/server/projectbox/instance.js";
import { setInstanceState, withProcedure } from "../electron/server/projectbox/instances.js";
import { relocationFolderOf, createRelocationLocation, relocationTime } from "../electron/server/projectbox/journal.js";
import { projectLocked, projectLock } from "../electron/server/projectbox/idle.js";
import { deleteProjectbox, setCopyDeleteStep } from "../electron/server/projectbox/erase.js";
import { copyDeleteStep } from "../electron/server/stacks/remove.js";
import { projectClaudeDir, projectCodexDir } from "../electron/server/runs/session-location.js";
import { claudeCopies, codexCopies } from "../electron/server/runs/session-transfer.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { projectCopiesLocation } from "../electron/server/stacks/location.js";
import { DIRS } from "../electron/server/app-state.js";
import { pendingRunInputs, running } from "../electron/server/runs/state.js";
import { countTerminalsByTag, createTerminal, killTerminal, terminalAvailable } from "../electron/server/terminal.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { setUiLang } from "../electron/server/i18n.js";
import { fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

const hostCalls = (fd) => fd.calls({ daemon: "host" }).map((a) => a.args);
const DELETE_KINDS = new Set(["ps", "stop", "rm", "network", "volume", "exec"]);
// Only the calls of the delete (from `from`): the creation before it has its own.
const since = (fd, from) => hostCalls(fd).slice(from).filter((a) => DELETE_KINDS.has(a[0]));
const word = (a) => (a[0] === "network" || a[0] === "volume" ? `${a[0]} ${a[1]}` : a[0] === "exec" ? `exec ${a[2]}` : a[0]);

async function erase(base, what, id, { purge = false } = {}) {
  const r = await fetch(`${base}/api/${what}/${id}${purge ? "?purge=1" : ""}`, { method: "DELETE", headers: { Connection: "close" } });
  return { status: r.status, body: await r.json() };
}

// A project with a created project container (createInstance through the fake docker).
async function withInstance(ctx, open, opts = {}) {
  const s = scenario(ctx, { projectId: crypto.randomUUID(), ...opts });
  const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID, ...(opts.images || {}) }, programs: { ...s.programs, ...(opts.programs || {}) } });
  open.push(fd);
  const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
  assert.equal(row.state, "ready");
  return { s, fd, row };
}

const cleanUp = (open) => {
  for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "Testende" });
  for (const fd of open) fd.cleanUp();
};

test("G2: without an instance row the same answer as before and no docker call — project and workspace", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID } });
    try {
      const p1 = scenario(ctx, { projectId: crypto.randomUUID() });
      const p2 = scenario(ctx, { projectId: crypto.randomUUID() });
      await withOps(fd, async () => {
        // The answers from before the project container, word for word.
        assert.deepEqual(await erase(ctx.base, "projects", p1.projectId), { status: 200, body: { ok: true, purged: false, note: "Ordner bleibt erhalten." } });
        assert.deepEqual(await erase(ctx.base, "projects", p2.projectId, { purge: true }), { status: 200, body: { ok: true, purged: false, note: "Ordner bleibt erhalten." } });
        // The workspace sub-route (the button of the web UI) goes the same way — without a row as before.
        const p3 = scenario(ctx, { projectId: crypto.randomUUID() });
        assert.deepEqual(await erase(ctx.base, `workspaces/${ctx.ws.id}/projects`, p3.projectId, { purge: true }), { status: 200, body: { ok: true, purged: false, note: "Ordner bleibt erhalten." } });
        assert.ok(!store.getProject(p3.projectId), "the sub-route did not delete the project");
        const wsPath = path.join(ctx.root, "ws-g2");
        fs.mkdirSync(wsPath);
        const ws = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "G2", path: wsPath }) });
        scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
        assert.deepEqual(await erase(ctx.base, "workspaces", ws.id, { purge: true }), { status: 200, body: { ok: true, removedChats: 0, note: "Ordner auf der Platte bleibt erhalten." } });
      });
      assert.deepEqual(fd.calls(), [], "docker ran without an instance row");
      assert.ok(!store.getProject(p1.projectId), "the project stayed");
      assert.ok(fs.existsSync(p1.location.home), "without a row the delete does not touch the runtime folder");
    } finally { fd.cleanUp(); }
  });
});

test("with a row: stop → rm by id → network rm, no volume rm without purge — the orphaned container is deleted too", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const { s, fd, row } = await withInstance(ctx, open);
      // A container with the label of the project that the row does not know (`run` created it, the row never got the id).
      const waise = await withOps(fd, async () => (await docker(["run", "-d", "--name", `orphan-${s.projectId}`, "--label", `cbase.project=${s.projectId}`, "alpine"])).stdout.trim());
      const foreign = await withOps(fd, async () => (await docker(["run", "-d", "--name", "foreign", "--label", "cbase.project=other", "alpine"])).stdout.trim());
      const from = hostCalls(fd).length;

      const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.equal(r.body.purged, false);
      assert.equal(r.body.note, "Ordner bleibt erhalten.");
      // State first (the counter-test with the old routes fails here: the container keeps running, the row stays).
      const z = fd.state();
      assert.deepEqual(Object.values(z.container).map((c) => c.id), [foreign], "a container of the project stayed — or the foreign one was deleted with it");
      assert.deepEqual(Object.values(z.networks), [], "the network stayed");
      assert.ok(z.volumes[volumeName(s.projectId)], "without purge=1 the volume is gone");
      assert.ok(fs.existsSync(s.location.home), "without purge=1 the runtime folder is gone");
      assert.ok(fs.existsSync(s.path), "the project folder is gone");
      assert.equal(store.projectInstance(s.projectId), null, "the row stayed");
      assert.ok(!store.getProject(s.projectId), "the project stayed");

      const [b] = r.body.projectContainer;
      assert.deepEqual({ projectId: b.projectId, instances: b.instances, volume: b.volume, runtime: b.runtime, lying: b.leftBehind, notices: b.notices },
        { projectId: s.projectId, instances: [`${s.projectId}/main`], volume: "stays", runtime: "stays", lying: [], notices: [] });
      assert.deepEqual([...b.container].sort(), [row.containerId, waise].sort());

      const a = since(fd, from);
      // Two phases: stop everything first (reversible, `ps -q` notes what ran), then remove.
      assert.deepEqual(a.map(word), ["ps", "ps", "stop", "stop", "rm", "rm", "network ls", "network rm", "ps"], JSON.stringify(a));
      for (const x of a.filter((x) => x[0] === "stop")) assert.deepEqual(x.slice(0, 3), ["stop", "-t", "30"], "not stopped with the grace period of the container");
      for (const x of a.filter((x) => x[0] === "rm")) {
        assert.equal(x[1], "-f");
        assert.match(x[2], /^[0-9a-f]{64}$/, "removal was not by id");
      }
      const iStop = a.findIndex((x) => x[0] === "stop" && x[3] === row.containerId);
      assert.ok(iStop >= 0 && iStop < a.findIndex((x) => x[0] === "rm" && x[2] === row.containerId), "rm before stop");
      assert.ok(!a.some((x) => x[0] === "volume"), "without purge=1 the volume was touched");
    } finally { cleanUp(open); }
  });
});

// `--filter label=cbase.project=<pid>` also matches a container that only inherits the label from its image (the fake docker
// inherits image labels like the real one). Counter-test: an erase.js without the own-label check stops and removes it (red).
test("a container that only inherits cbase.project=<pid> from its image is no project container — the delete leaves it and names it", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const pid = crypto.randomUUID();
      const { s, fd, row } = await withInstance(ctx, open, { projectId: pid, images: { "inherit:1": { id: "f6".repeat(32), labels: { "cbase.project": pid, "cbase.instance": "main" } } } });
      const user = await withOps(fd, async () => (await docker(["run", "-d", "--name", "deduction-1", "inherit:1"])).stdout.trim());
      assert.equal(fd.state().container[user]?.labels["cbase.project"], pid, "the fake docker does not inherit the labels of the image");
      const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.values(fd.state().container).map((c) => [c.id, c.status]), [[user, "running"]], "the user container was deleted or is not running");
      const [b] = r.body.projectContainer;
      assert.deepEqual(b.container, [row.containerId]);
      assert.ok(b.notices.some((m) => m.includes(user.slice(0, 12)) && /nur von seinem Image/.test(m)), JSON.stringify(b.notices));
    } finally { cleanUp(open); }
  });
});

test("purge=1: volume rm, runtime folder gone — root-owned remainders through the container BEFORE the stop; if it does not run they stay, named", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const locked = [];
    // "root" in the project container: gives the permissions back, then rm — in the fake docker exec runs locally as the same user.
    const rootRm = path.join(ctx.root, "root-rm");
    fs.writeFileSync(rootRm, `#!/bin/sh\nfor a; do case "$a" in -*) ;; *) chmod -R u+w "$a" 2>/dev/null;; esac; done\nexec /bin/rm "$@"\n`);
    fs.chmodSync(rootRm, 0o755);
    const rootOwn = (location) => {
      const d = path.join(location.root, "scratch", "root-own");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "of-root.txt"), "x");
      fs.chmodSync(d, 0o555);
      locked.push(d);
      return d;
    };
    try {
      assert.notEqual(process.getuid?.(), 0, "chmod does not bite as root — this guard needs a non-root user");
      const { s, fd, row } = await withInstance(ctx, open, { programs: { rm: rootRm } });
      rootOwn(s.location);
      const from = hostCalls(fd).length;
      const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [b] = r.body.projectContainer;
      assert.deepEqual({ volume: b.volume, runtime: b.runtime, lying: b.leftBehind }, { volume: "removed", runtime: "removed", lying: [] }, JSON.stringify(b));
      const a = since(fd, from);
      const iExec = a.findIndex((x) => x[0] === "exec" && x[2] === "root");
      const iStop = a.findIndex((x) => x[0] === "stop");
      assert.ok(iExec >= 0, `no root fallback through the container: ${JSON.stringify(a)}`);
      assert.deepEqual(a[iExec].slice(3, 6), [row.containerId, "rm", "-rf"]);
      assert.ok(iExec < iStop, "the root fallback came after the stop — the container no longer ran then");
      assert.ok(a.some((x) => x[0] === "volume" && x[1] === "rm" && x[2] === volumeName(s.projectId)), "purge=1 without volume rm");
      assert.equal(fd.state().volumes[volumeName(s.projectId)], undefined, "the volume stayed");
      assert.equal(fs.existsSync(s.location.root), false, "the runtime folder stayed");

      // Counter-test: the container does not run (stopped before the delete) — the root-owned remainder stays and is in the report.
      const t = await withInstance(ctx, open, { programs: { rm: rootRm } });
      const rest = rootOwn(t.s.location);
      await withOps(t.fd, () => docker(["stop", t.row.containerId]));
      const r2 = await withOps(t.fd, () => erase(ctx.base, "projects", t.s.projectId, { purge: true }));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      const [b2] = r2.body.projectContainer;
      assert.equal(b2.runtime, "partial");
      assert.ok(b2.leftBehind.some((p) => p === path.join(t.s.location.root, "scratch")), JSON.stringify(b2.leftBehind));
      assert.ok(b2.notices.some((m) => m.includes("gehört root")), JSON.stringify(b2.notices));
      assert.ok(fs.existsSync(path.join(rest, "of-root.txt")));
      assert.equal(Object.values(t.fd.state().container).length, 0, "the container stayed");
      assert.equal(store.projectInstance(t.s.projectId), null);
    } finally {
      for (const d of locked) { try { fs.chmodSync(d, 0o755); } catch { /* already gone */ } }
      cleanUp(open);
    }
  });
});

test("409: during relocation, create, recreate, a procedure and a creation — nothing deleted, not for the workspace either", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    setUiLang("en"); // after the server start: the lock sentences are the English source texts
    try {
      const wsPath = path.join(ctx.root, "ws-409");
      fs.mkdirSync(wsPath);
      const ws = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Lock", path: wsPath }) });
      const chat = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
      const { s, fd, row } = await withInstance(ctx, open, { workspace: ws });
      const checkNothing = async (cause) => {
        const from = hostCalls(fd).length;
        const rp = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
        assert.equal(rp.status, 409, `${cause}: ${JSON.stringify(rp.body)}`);
        assert.equal(rp.body.projectId, s.projectId);
        const rw = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id, { purge: true }));
        assert.equal(rw.status, 409, `${cause} (Workspace): ${JSON.stringify(rw.body)}`);
        assert.deepEqual(hostCalls(fd).slice(from), [], `${cause}: docker ran`);
        assert.ok(store.getProject(s.projectId), `${cause}: the project was deleted`);
        assert.ok(store.getWorkspace(ws.id), `${cause}: the workspace was deleted`);
        assert.ok(store.getChat(chat.id), `${cause}: the chat was deleted`);
        assert.ok(store.projectInstance(s.projectId), `${cause}: the row was deleted`);
        assert.equal(Object.values(fd.state().container)[0]?.status, "running", `${cause}: the container no longer ran`);
        return rp.body.error;
      };
      for (const state of ["relocation", "create", "recreate"]) {
        setInstanceState(s.projectId, "main", state, { phase: "test" });
        assert.match(await checkNothing(state), new RegExp(`in “${state}”`));
      }
      // `start` does not lock by itself — but a live procedure (the restoration) on it does.
      setInstanceState(s.projectId, "main", "start", { phase: "stage-1" });
      let free;
      const procedure = withProcedure(s.projectId, "main", () => new Promise((r) => { free = r; }));
      assert.match(await checkNothing("procedure"), /A flow is working on project container/);
      free();
      await procedure;
      setInstanceState(s.projectId, "main", "ready");
      // A creation or another delete holds the project (instance.js withProjectOccupancy).
      let go;
      const occupied = withProjectOccupancy(s.projectId, "creation", () => new Promise((r) => { go = r; }));
      assert.match(await checkNothing("creation"), /a creation is running/);
      go();
      await occupied;
      assert.equal(store.projectInstance(s.projectId).containerId, row.containerId);

      // Afterwards it works: the workspace goes with project, chat and container.
      const r = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.removedChats, 1);
      assert.equal(r.body.projectContainer.length, 1);
      assert.ok(!store.getWorkspace(ws.id), "the workspace stayed");
      assert.equal(store.projectInstance(s.projectId), null);
      assert.deepEqual(Object.values(fd.state().container), []);
    } finally { setUiLang("de"); cleanUp(open); }
  });
});

// A live row in stack_kopien blocks the delete. While waiting there is no instance row of the copy yet: the lock of the instances
// alone would see nothing. This lock is the FALLBACK without a hook (projectbox/erase.js setCopyDeleteStep): the test removes the
// hook for its duration; the copy step itself is held by server/backend/test/stacks-clear-away.test.js.
// COUNTER-TEST (shown red, taken back): erase.js without the copy check (`if (false && copies.length)`) ⇒ red, "200 !== 409"
// (the project was deleted with its container).
test("409: a live copy (waiting, without an instance row of its own) blocks project and workspace — after `removed` it works", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    let copy = null;
    try {
      const wsPath = path.join(ctx.root, "ws-copy");
      fs.mkdirSync(wsPath);
      const ws = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Copy", path: wsPath }) });
      const chat = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
      const { s, fd } = await withInstance(ctx, open, { workspace: ws });
      copy = copyRequests({ projectId: s.projectId, name: "k1", chatId: chat.id });
      setCopyDeleteStep(null);
      assert.equal(store.projectInstance(s.projectId, "copy-k1"), null, "waiting: no instance row of the copy yet — the delete lock of the instances would see nothing");
      for (const [what, id] of [["projects", s.projectId], ["workspaces", ws.id]]) {
        const from = hostCalls(fd).length;
        const r = await withOps(fd, () => erase(ctx.base, what, id, { purge: true }));
        assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.projectId, s.projectId);
        assert.match(r.body.error, /eine Kopie lebt noch — copy-k1 \(waiting_queue\); löschen erst nach dem Abräumen/);
        assert.deepEqual(hostCalls(fd).slice(from), [], `${what}: docker ran`);
      }
      assert.ok(store.getProject(s.projectId), "the project was deleted");
      assert.ok(store.getWorkspace(ws.id), "the workspace was deleted");
      assert.ok(store.getChat(chat.id), "the chat was deleted");
      assert.equal(store.projectInstance(s.projectId).state, "ready", "the instance of the main was touched");
      assert.equal(Object.values(fd.state().container)[0]?.status, "running", "the container no longer ran");

      // Removed is history, no lock: the workspace goes with project and container.
      setCopyState(copy.id, "removed");
      copy = null;
      const r = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.projectContainer.length, 1);
      assert.ok(!store.getWorkspace(ws.id), "the workspace stayed");
    } finally {
      setCopyDeleteStep(copyDeleteStep); // the hook that server.js sets
      if (copy) try { setCopyState(copy.id, "removed"); } catch { /* already gone */ }
      cleanUp(open);
    }
  });
});

test("a failing stop: 500, nothing deleted", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const { s, fd } = await withInstance(ctx, open);
      // A docker that refuses `stop` and passes everything else to the fake docker.
      const bin = path.join(ctx.root, "docker-without-stop");
      fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = stop ]; then echo "Error response from daemon: cannot stop container: permission denied" >&2; exit 1; fi\nexec '${fd.bin}' "$@"\n`);
      fs.chmodSync(bin, 0o755);
      const r = await withOps({ bin }, () => erase(ctx.base, "projects", s.projectId));
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.match(r.body.error, /nicht gestoppt: .*permission denied.*Zeile, Netz und Volume bleiben, das Projekt auch/);
      assert.ok(store.getProject(s.projectId));
      assert.ok(store.projectInstance(s.projectId));
      assert.equal(Object.values(fd.state().container).length, 1);
      assert.equal(Object.values(fd.state().networks).length, 1);
    } finally { cleanUp(open); }
  });
});

test("the probe still finds a container: 500, the row STAYS — and the second attempt clears it", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const { s, fd, row } = await withInstance(ctx, open);
      // A docker whose `rm -f` only pretends to remove this one container (a remainder that only the probe sees).
      const bin = path.join(ctx.root, "docker-tough-rm");
      fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = rm ] && [ "$3" = '${row.containerId}' ]; then echo "$3"; exit 0; fi\nexec '${fd.bin}' "$@"\n`);
      fs.chmodSync(bin, 0o755);
      const r = await withOps({ bin }, () => erase(ctx.base, "projects", s.projectId));
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.match(r.body.error, /stehen noch Container .* die Zeile bleibt/);
      assert.ok(store.projectInstance(s.projectId), "the row was deleted before the probe — a second attempt would take the path without docker");
      assert.ok(store.getProject(s.projectId));
      const from = hostCalls(fd).length;
      const r2 = await withOps(fd, () => erase(ctx.base, "projects", s.projectId));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      assert.ok(since(fd, from).some((a) => a[0] === "rm" && a[2] === row.containerId), "the second attempt did not call docker");
      assert.deepEqual(Object.values(fd.state().container), []);
      assert.equal(store.projectInstance(s.projectId), null);
    } finally { cleanUp(open); }
  });
});

test("workspace with two projects, purge=1: both containers, networks, volumes, rows gone", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const wsPath = path.join(ctx.root, "ws-two");
      fs.mkdirSync(wsPath);
      const ws = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Two", path: wsPath }) });
      // Both in the SAME fake docker (one user container): two scenarios, one daemon.
      const s1 = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const s2 = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s1.programs });
      open.push(fd);
      await withOps(fd, () => createInstance(s1.projectId, s1.opts));
      await withOps(fd, () => createInstance(s2.projectId, s2.opts));
      assert.equal(Object.values(fd.state().container).length, 2);
      const r = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id, { purge: true }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.projectContainer.map((b) => [b.projectId, b.volume, b.runtime]).sort(), [[s1.projectId, "removed", "removed"], [s2.projectId, "removed", "removed"]].sort());
      assert.equal(r.body.note, "Ordner auf der Platte bleibt erhalten.");
      const z = fd.state();
      assert.deepEqual([Object.values(z.container).length, Object.values(z.networks).length, Object.keys(z.volumes).length], [0, 0, 0]);
      for (const s of [s1, s2]) {
        assert.equal(store.projectInstance(s.projectId), null);
        assert.equal(fs.existsSync(s.location.root), false);
      }
      assert.ok(fs.existsSync(wsPath), "the workspace folder was deleted (it stays)");
    } finally { cleanUp(open); }
  });
});

test("G1: without the operation mark with a row — no docker call, the row is deleted anyway", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const { s, fd } = await withInstance(ctx, open);
      const from = hostCalls(fd).length;
      const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId), { CBASE_DIND: undefined });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.projectContainer[0].ops, false);
      assert.match(r.body.projectContainer[0].notices[0], /kein Server-Betrieb/);
      assert.deepEqual(hostCalls(fd).slice(from), [], "docker ran without the operation mark");
      assert.equal(store.projectInstance(s.projectId), null);
      assert.ok(fs.existsSync(s.location.home), "without purge=1 the runtime folder was deleted");
    } finally { cleanUp(open); }
  });
});

// A converted project is deleted only when idle.
test("only when idle: converted and busy ⇒ 409 with reasons, nothing deleted; the lock holds over the delete; not converted as before", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const isRunning = new Set();
    // A turn "runs" (runs/state.js running — the same set that doRun fills): the idle check counts it as running. The delete
    // path only asks the idle check; which path began the turn is not the question here (project-lock.test.js).
    const turn = (chatId) => { running.add(chatId); isRunning.add(chatId); };
    const turnEnd = (chatId) => { running.delete(chatId); isRunning.delete(chatId); };
    const chatIn = (projectId, workspaceId = ctx.ws.id) => json(`${ctx.base}/api/chats`, { method: "POST",
      body: JSON.stringify({ workspaceId, projectId, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
    const convert = (projectId) => store.changeProjectInstance(projectId, "main", { convertedAt: Date.now() });
    try {
      // ── Not converted (row `ready` without converted_at): in the middle of a turn as before — the container is removed, 200 ──
      {
        const { s, fd: fd1 } = await withInstance(ctx, open);
        const c = await chatIn(s.projectId);
        turn(c.id);
        const r = await withOps(fd1, () => erase(ctx.base, "projects", s.projectId));
        assert.equal(r.status, 200, `a not converted project stayed: ${JSON.stringify(r.body)}`);
        assert.equal(store.projectInstance(s.projectId), null);
        turnEnd(c.id);
      }

      // ── Converted and busy: 409 with the reasons — project, workspace; no docker, nothing deleted ──
      const wsPath = path.join(ctx.root, "ws-idle");
      fs.mkdirSync(wsPath);
      const ws = await json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Idle", path: wsPath }) });
      const s = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, stopGate: "stop" });
      open.push(fd);
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      convert(s.projectId);
      const c = await chatIn(s.projectId, ws.id);
      turn(c.id);
      const from = hostCalls(fd).length;
      for (const [what, id] of [["projects", s.projectId], ["workspaces", ws.id]]) {
        const r = await withOps(fd, () => erase(ctx.base, what, id, { purge: true }));
        assert.equal(r.status, 409, `${what}: the container was deleted in the middle of a turn — ${JSON.stringify(r.body)}`);
        assert.equal(r.body.projectId, s.projectId);
        assert.match(r.body.error, /nicht im Leerlauf — Ein Lauf ist aktiv/);
        assert.deepEqual(r.body.open.map((o) => [o.chatId, o.reason]), [[c.id, "running"]]);
      }
      assert.deepEqual(hostCalls(fd).slice(from), [], "docker ran");
      assert.ok(store.getProject(s.projectId) && store.getWorkspace(ws.id) && store.getChat(c.id), "something was deleted");
      assert.equal(store.projectInstance(s.projectId).containerId, row.containerId);
      assert.equal(Object.values(fd.state().container)[0]?.status, "running");
      assert.equal(projectLocked(s.projectId), null, "the lock stayed after the 409");

      // ── When idle: the "erase" lock holds over the delete — a message at the `stop` waits, afterwards it runs ──
      turnEnd(c.id);
      const erase2 = withOps(fd, () => erase(ctx.base, "projects", s.projectId));
      // For the gate OR the end of the delete — if it ran past the `stop`, a bare wait for the gate would hang forever.
      let toEnd = false;
      erase2.finally(() => { toEnd = true; }).catch(() => {});
      await waitForTruthy(() => toEnd || fs.existsSync(path.join(fd.dir, "gates", "stop.waiting")), "stop at the gate or delete finished");
      assert.deepEqual(projectLocked(s.projectId)?.reason, "erase", "no lock during the delete");
      const n = await withOps(fd, () => json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURING the delete" }) }));
      assert.equal(n.locked, true, `the message ran into a container that is just falling: ${JSON.stringify(n)}`);
      assert.equal(n.queued, true);
      fd.openGate("stop");
      const r = await erase2;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(projectLocked(s.projectId), null, "the lock stayed after the delete");
      assert.equal(store.projectInstance(s.projectId), null);
      // The transition (release → wakeProject) took the entry from the queue synchronously: it runs or has already run.
      assert.deepEqual((await json(`${ctx.base}/api/runs/active`)).open?.queue ?? 0, 0, "the message stayed in the queue");
      await ctx.waitForQuiet();
      const log = await json(`${ctx.base}/api/chats/${c.id}/log`);
      const u = log.findIndex((m) => m.role === "user" && m.text.includes("DURING the delete"));
      assert.ok(u >= 0 && log.slice(u + 1).some((m) => m.role === "assistant"), `user → assistant: ${JSON.stringify(log.map((m) => m.role))}`);

      // ── G1: without the operation mark a converted project is also deleted in the middle of a turn as before (no container can run) ──
      {
        const t = await withInstance(ctx, open);
        convert(t.s.projectId);
        const c3 = await chatIn(t.s.projectId);
        turn(c3.id);
        const r3 = await withOps(t.fd, () => erase(ctx.base, "projects", t.s.projectId), { CBASE_DIND: undefined });
        assert.equal(r3.status, 200, JSON.stringify(r3.body));
        turnEnd(c3.id);
      }
    } finally {
      for (const id of isRunning) running.delete(id);
      for (const fd of open) fd.openGate?.("stop");
      cleanUp(open);
    }
  });
});

// ── Instance lock, sub-route, sessions ────────────────────────────────────────────────────────────────────────────────

const ELECTRON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "electron");
const chatIn = (ctx, projectId, workspaceId) => json(`${ctx.base}/api/chats`, { method: "POST",
  body: JSON.stringify({ workspaceId, projectId, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
// The order of the projects of a workspace (store/projects.js: ORDER BY created_at) — pinned instead of trusting a clock.
const order = (...ids) => ids.forEach((id, i) => db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(i + 1, id));
async function newWs(ctx, name) {
  const p = path.join(ctx.root, `ws-${name}`);
  fs.mkdirSync(p);
  return json(`${ctx.base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name, path: p }) });
}
// A converted project without creation (the idle lock only asks the row; the container is missing in the fake docker — a
// delete when idle does not find it and clears the row).
const converted = (projectId) => store.createProjectInstance({ projectId, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${projectId}` });

// The callers of store.deleteProject as a named table — each goes through deleteProjectbox first, and both project delete routes
// call the one path. Without a hit, with a new hit or without the path before it ⇒ red.
const DELETE_PROJECT_ALLOWED = [
  { key: "server/projectbox/erase.js#projectDelete", way: "the ONE path of both project delete routes — after deleteProjectbox" },
];
const PROJECT_DELETE_ROUTES = [
  { key: "server/projects/routes.js#itemProjectRoutes", way: "DELETE /api/projects/:id (iOS, MCP)" },
  { key: "server/workspaces/routes.js#tailWorkspaceRoutes", way: "DELETE /api/workspaces/:wid/projects/:pid (the button of the web UI)" },
];
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const FUNCTION_TOP = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/;
function sourceFiles() {
  const out = [];
  const run = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (n.name === "node_modules") continue;
      const abs = path.join(dir, n.name);
      if (n.isDirectory()) run(abs);
      else if (/\.(c|m)?js$/.test(n.name)) out.push({ path: path.relative(ELECTRON, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "latin1") });
    }
  };
  run(ELECTRON);
  return out;
}
// Per `file#function` the calls of `name(` (without declaration and comment lines) with the body of the function before it.
function calls(files, name) {
  const pattern = new RegExp(`(?<!function\\s)\\b${name}\\(`);
  const hits = new Map();
  for (const { path: filePath, text } of files) {
    const rows = text.split("\n");
    rows.forEach((z, i) => {
      if (COMMENT.test(z) || !pattern.test(z)) return;
      let fn = "(Modulebene)";
      let start = 0;
      for (let k = i; k >= 0; k--) { const f = rows[k].match(FUNCTION_TOP); if (f) { fn = f[1]; start = k; break; } }
      const k = `${filePath}#${fn}`;
      if (!hits.has(k)) hits.set(k, []);
      hits.get(k).push({ row: i + 1, prior: [...rows.slice(start, i), z.slice(0, z.search(pattern))].join("\n") });
    });
  }
  return hits;
}
function deletionPathViolations(files) {
  const v = [];
  const allowed = new Map(DELETE_PROJECT_ALLOWED.map((e) => [e.key, e]));
  const dp = calls(files.filter((d) => !d.path.startsWith("server/store/")), "deleteProject");
  for (const [k, t] of dp) {
    if (!allowed.has(k)) v.push(`${k} (line ${t.map((x) => x.row).join(", ")}) calls deleteProject past the project container — through projectbox/erase.js projectDelete`);
    else for (const x of t) if (!/\bdeleteProjectbox\(/.test(x.prior)) v.push(`${k}:${x.row} calls deleteProject without deleteProjectbox before it`);
  }
  for (const k of allowed.keys()) if (!dp.has(k)) v.push(`row without a hit ${k} — rebuilt? Then delete the row`);
  const pl = calls(files, "projectDelete");
  for (const r of PROJECT_DELETE_ROUTES) if (!pl.has(r.key)) v.push(`${r.key} (${r.way}) does not call projectDelete`);
  return v;
}

test("source: store.deleteProject only after deleteProjectbox, both project delete routes through projectDelete — with built-in sabotage", () => {
  const real = sourceFiles();
  for (const e of [...DELETE_PROJECT_ALLOWED, ...PROJECT_DELETE_ROUTES]) console.log(`[projectbox-delete] ${e.key}: ${e.way}`);
  assert.deepEqual(deletionPathViolations(real), []);
  const including = (filePath, text) => [...real.filter((d) => d.path !== filePath), { path: filePath, text }];
  const text = (filePath) => real.find((d) => d.path === filePath).text;
  // A new caller past the path.
  const past = deletionPathViolations(including("server/workspaces/sabotage.js", 'import * as store from "../store.js";\nexport async function foreign(wid, pid) {\n  store.deleteProject(wid, pid);\n}\n'));
  assert.deepEqual(past, ["server/workspaces/sabotage.js#foreign (line 3) calls deleteProject past the project container — through projectbox/erase.js projectDelete"]);
  // The path without deleteProjectbox before it.
  const l = "server/projectbox/erase.js";
  const withoutBox = deletionPathViolations(including(l, text(l).replace('await deleteProjectbox([projectId], { purge, sessionsToB: true, way: "project" })', "{ felder: {} }")));
  assert.equal(withoutBox.length, 1, JSON.stringify(withoutBox));
  assert.match(withoutBox[0], /^server\/projectbox\/erase\.js#projectDelete:\d+ calls deleteProject without deleteProjectbox before it$/);
  // A route that no longer calls the path.
  const w = "server/workspaces/routes.js";
  assert.deepEqual(deletionPathViolations(including(w, text(w).replace("await projectDelete(", "await otherWay("))),
    ["server/workspaces/routes.js#tailWorkspaceRoutes (DELETE /api/workspaces/:wid/projects/:pid (the button of the web UI)) does not call projectDelete"]);
});

test("DELETE /api/workspaces/:wid/projects/:pid goes through the project container — 409 in a turn, when idle it is deleted with its row", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const isRunning = new Set();
    try {
      const { s, fd, row } = await withInstance(ctx, open);
      store.changeProjectInstance(s.projectId, "main", { convertedAt: Date.now() });
      const c = await chatIn(ctx, s.projectId, ctx.ws.id);
      running.add(c.id);
      isRunning.add(c.id);
      const what = `workspaces/${ctx.ws.id}/projects`;
      const from = hostCalls(fd).length;
      const r = await withOps(fd, () => erase(ctx.base, what, s.projectId, { purge: true }));
      assert.equal(r.status, 409, `the sub-route deleted in the middle of a turn: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /nicht im Leerlauf — Ein Lauf ist aktiv/);
      assert.deepEqual(hostCalls(fd).slice(from), [], "docker ran");
      assert.ok(store.getProject(s.projectId), "the project was deleted");
      assert.equal(store.projectInstance(s.projectId)?.containerId, row.containerId);
      assert.equal(Object.values(fd.state().container)[0]?.status, "running");

      running.delete(c.id);
      isRunning.delete(c.id);
      const r2 = await withOps(fd, () => erase(ctx.base, what, s.projectId));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      assert.deepEqual({ ok: r2.body.ok, purged: r2.body.purged, note: r2.body.note }, { ok: true, purged: false, note: "Ordner bleibt erhalten." });
      assert.equal(r2.body.projectContainer?.[0]?.projectId, s.projectId, "the answer does not name the project container");
      assert.equal(store.projectInstance(s.projectId), null, "the row stayed — orphaned, without a project");
      assert.deepEqual(Object.values(fd.state().container), [], "the container kept running");
      assert.ok(!store.getProject(s.projectId), "the project stayed");
    } finally {
      for (const id of isRunning) running.delete(id);
      cleanUp(open);
    }
  });
});

test("a store that throws while locking releases the lock — its own and the ones already held", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker();
    try {
      const ws = await newWs(ctx, "thrown");
      const a = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const b = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      order(a.projectId, b.projectId);
      converted(a.projectId);
      converted(b.projectId);
      // Only B has a chat — only ITS idle check reads graph_starts (store.openForegroundStart); so A is locked before B throws.
      await chatIn(ctx, b.projectId, ws.id);
      // The table is missing only around the synchronous part (locking and idle check), afterwards it is back.
      const withoutTable = (fn) => {
        db.exec("ALTER TABLE graph_starts RENAME TO graph_starts_d2");
        try { return fn(); } finally { db.exec("ALTER TABLE graph_starts_d2 RENAME TO graph_starts"); }
      };
      for (const list of [[b.projectId], [a.projectId, b.projectId]]) {
        await assert.rejects(withOps(fd, () => withoutTable(() => deleteProjectbox(list))), /graph_starts/);
        assert.equal(projectLocked(b.projectId), null, `${list.length} project(s): the lock of B stayed after the throw`);
        assert.equal(projectLocked(a.projectId), null, `${list.length} project(s): the already held lock of A stayed`);
      }
      assert.deepEqual(fd.calls(), [], "docker ran");
      // Afterwards it deletes again (no lock in the way, the rows are still there).
      const r = await withOps(fd, () => erase(ctx.base, "projects", a.projectId));
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } finally {
      for (const z of store.projectInstances()) store.deleteProjectInstance(z.projectId);
      fd.cleanUp();
    }
  });
});

test("409 at the second project of a workspace — the shell of the first lives; when deleted it ends with the delete", async () => {
  assert.ok(terminalAvailable(), "node-pty is missing — this guard needs a real shell");
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker();
    const shells = [];
    const isRunning = new Set();
    try {
      const ws = await newWs(ctx, "shells");
      const a = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const b = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      order(a.projectId, b.projectId);
      converted(a.projectId);
      converted(b.projectId);
      const cb = await chatIn(ctx, b.projectId, ws.id);
      running.add(cb.id);
      isRunning.add(cb.id);
      const tag = `proj:${a.projectId}`;
      shells.push(createTerminal({ cwd: ctx.root, command: "/bin/sleep", args: ["600"], tag }).id);
      assert.equal(countTerminalsByTag(tag), 1);

      const r = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id));
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.projectId, b.projectId);
      assert.equal(countTerminalsByTag(tag), 1, "the shell of A ended although the 409 was supposed to delete nothing");
      assert.ok(store.getWorkspace(ws.id));
      assert.equal(projectLocked(a.projectId), null);
      assert.equal(projectLocked(b.projectId), null);
      assert.deepEqual(fd.calls(), [], "docker ran");

      // When idle the delete of A ends its shell itself (the project route clears no terminals — only the lock).
      const r2 = await withOps(fd, () => erase(ctx.base, "projects", a.projectId));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      assert.equal(countTerminalsByTag(tag), 0, "the shell of A lives on after the delete");
    } finally {
      for (const id of isRunning) running.delete(id);
      for (const id of shells) killTerminal(id);
      for (const z of store.projectInstances()) store.deleteProjectInstance(z.projectId);
      fd.cleanUp();
    }
  });
});

test("workspace with A and B, B cannot be stopped — 500, A runs again, no row, no network is deleted", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      const ws = await newWs(ctx, "two-stop");
      const s1 = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const s2 = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      order(s1.projectId, s2.projectId);
      const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s1.programs });
      open.push(fd);
      const z1 = await withOps(fd, () => createInstance(s1.projectId, s1.opts));
      const z2 = await withOps(fd, () => createInstance(s2.projectId, s2.opts));
      // A docker that does NOT stop only the container of B and passes everything else to the fake docker.
      const bin = path.join(ctx.root, "docker-b-without-stop");
      fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = stop ] && [ "$4" = '${z2.containerId}' ]; then echo "Error response from daemon: cannot stop container: permission denied" >&2; exit 1; fi\nexec '${fd.bin}' "$@"\n`);
      fs.chmodSync(bin, 0o755);
      const from = hostCalls(fd).length;
      const r = await withOps({ bin }, () => erase(ctx.base, "workspaces", ws.id));
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body.projectId, s2.projectId);
      assert.ok(store.getWorkspace(ws.id), "the workspace was deleted");
      for (const [s, z, name] of [[s1, z1, "A"], [s2, z2, "B"]]) {
        assert.equal(store.projectInstance(s.projectId)?.containerId, z.containerId, `the row of ${name} was deleted — ${name} is demoted, the workspace stayed`);
        assert.equal(fd.state().container[z.containerId]?.status, "running", `the container of ${name} no longer runs`);
        assert.ok(store.getProject(s.projectId));
      }
      assert.match(r.body.error, /nicht gestoppt: .*permission denied.* — nichts entfernt, 1 schon gestoppte\(r\) Container wieder gestartet; Zeile, Netz und Volume bleiben, das Projekt auch$/);
      assert.deepEqual(r.body.projectContainer, []);
      assert.equal(Object.values(fd.state().networks).length, 2, "a network was deleted");
      const a = hostCalls(fd).slice(from);
      assert.ok(a.some((x) => x[0] === "start" && x[1] === z1.containerId), `A was not started again: ${JSON.stringify(a)}`);
      assert.ok(!a.some((x) => x[0] === "rm" || x[0] === "network" && x[1] === "rm"), `something was removed: ${JSON.stringify(a)}`);
    } finally { cleanUp(open); }
  });
});

test("deleting a project brings its sessions to B — without and with purge; deleting a workspace does not", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-d2-b-"));
    const prior = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
    process.env.CLAUDE_CONFIG_DIR = path.join(b, ".claude");
    process.env.CODEX_HOME = path.join(b, ".codex");
    // In the home of the project: a Claude session with `<sid>/` (tool results, subagents) and a Codex rollout — as they lie after
    // turns in the project container (the copy in B was deleted with the first confirmed turn).
    const seedSessions = (pid, tag) => {
      const sid = `s-${tag}-${crypto.randomUUID()}`;
      const tid = `t-${tag}-${crypto.randomUUID()}`;
      const slug = path.join(projectClaudeDir(pid), "projects", "-project-in-container");
      fs.mkdirSync(path.join(slug, sid, "tool-results"), { recursive: true });
      fs.writeFileSync(path.join(slug, `${sid}.jsonl`), `{"tag":"${tag}"}\n`);
      fs.writeFileSync(path.join(slug, sid, "tool-results", "large.txt"), "x");
      const scroll = path.join(projectCodexDir(pid), "sessions", "2026", "09", "29", `rollout-2026-09-29T10-00-00-${tid}.jsonl`);
      fs.mkdirSync(path.dirname(scroll), { recursive: true });
      fs.writeFileSync(scroll, "r\n");
      return { sid, tid };
    };
    const inB = ({ sid, tid }) => ({ claude: claudeCopies(sid, [process.env.CLAUDE_CONFIG_DIR]).length, codex: codexCopies(tid, [process.env.CODEX_HOME]).length });
    try {
      // Without purge: the row is deleted, the runtime folder stays — the session would no longer be found there.
      const t1 = await withInstance(ctx, open);
      const x1 = seedSessions(t1.s.projectId, "one");
      const r1 = await withOps(t1.fd, () => erase(ctx.base, "projects", t1.s.projectId));
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.deepEqual(inB(x1), { claude: 1, codex: 1 }, "the sessions stayed in the home of the deleted project");
      assert.equal(r1.body.projectContainer[0].sessionsToB, 2);
      assert.equal(fs.readFileSync(claudeCopies(x1.sid, [process.env.CLAUDE_CONFIG_DIR])[0].file, "utf8"), `{"tag":"one"}\n`);
      assert.ok(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "-project-in-container", x1.sid, "tool-results", "large.txt")), "the folder <sid>/ did not come along");
      assert.ok(fs.existsSync(t1.s.location.home), "without purge=1 the runtime folder was deleted");

      // With purge: step 1 empties the runtime folder — the sessions moved before.
      const t2 = await withInstance(ctx, open);
      const x2 = seedSessions(t2.s.projectId, "two");
      const r2 = await withOps(t2.fd, () => erase(ctx.base, `workspaces/${ctx.ws.id}/projects`, t2.s.projectId, { purge: true }));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      assert.equal(fs.existsSync(t2.s.location.root), false, "the runtime folder stayed");
      assert.deepEqual(inB(x2), { claude: 1, codex: 1 }, "with purge=1 the sessions of the surviving chats were deleted with it");

      // The workspace takes its chats with it — nothing moves to B.
      const ws = await newWs(ctx, "sessions");
      const t3 = await withInstance(ctx, open, { workspace: ws });
      const x3 = seedSessions(t3.s.projectId, "three");
      const r3 = await withOps(t3.fd, () => erase(ctx.base, "workspaces", ws.id));
      assert.equal(r3.status, 200, JSON.stringify(r3.body));
      assert.deepEqual(inB(x3), { claude: 0, codex: 0 });
    } finally {
      for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(b, { recursive: true, force: true });
      cleanUp(open);
    }
  });
});

// ── A project of ANOTHER workspace through the workspace sub-route ──────────────────────────────────────────────────
// store.deleteProject(wid, pid) checks the workspace only at the row in `projects`; context, services, agents, skills,
// workflows and facts would be deleted for any pid, with purge=1 also the folder of the project — and the route answered 200. Now
// 404, and nothing is deleted, also without an instance row (an error, no G2 question). In the own workspace the answer stays
// word for word. Counter-test: an erase.js without the check ⇒ red (200, context and services gone).
test("DELETE /api/workspaces/<foreign>/projects/<pid> — 404, nothing deleted (context, services, agents, folder), also with purge=1; in the own workspace as before", async () => {
  await withAgentsServer(async (ctx) => {
    const foreign = await newWs(ctx, "Foreign");
    const filePath = path.join(ctx.root, "workspace", "own");
    fs.mkdirSync(filePath, { recursive: true });
    const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Own", path: filePath }) });
    fs.writeFileSync(path.join(filePath, "file.txt"), "stays\n");
    store.addProjectService(p.id, { name: "web", port: 3999 });
    store.createProjectContext(p.id, { category: "note", title: "Stays", body: "Context of the project" });
    store.createAgent({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: p.id, name: "project-agent", createdAt: Date.now(), updatedAt: Date.now() });
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(p.id).n;
    const inventory = () => ({ project: Boolean(store.getProject(p.id)), services: count("project_services"), context: count("project_context"), agents: count("agents"), file: fs.existsSync(path.join(filePath, "file.txt")) });
    const prior = inventory();
    assert.deepEqual(prior, { project: true, services: 1, context: 1, agents: 1, file: true });

    for (const purge of [false, true]) {
      const r = await erase(ctx.base, `workspaces/${foreign.id}/projects`, p.id, { purge });
      assert.equal(r.status, 404, `purge=${purge}: a project of another workspace — ${JSON.stringify(r.body)}`);
      assert.deepEqual(inventory(), prior, `purge=${purge}: deleted through the foreign workspace`);
    }

    // In the own workspace: the answer as before, word for word, and everything is deleted (the folder stays without purge).
    const r = await erase(ctx.base, `workspaces/${ctx.ws.id}/projects`, p.id);
    assert.deepEqual(r, { status: 200, body: { ok: true, purged: false, note: "Ordner bleibt erhalten." } });
    assert.deepEqual(inventory(), { project: false, services: 0, context: 0, agents: 0, file: true });
  });
});

// The plan per instance through the label — containers and networks of a copy (`cbase-k-…`, without a row: a remainder) are deleted like
// those of the main, their volume only with purge=1 and then by LABEL (that of the main still by name).
// COUNTER-TEST (shown red, taken back): erase.js with `volume rm` only by the name of the main ⇒ red (the volume of the copy
// stays after purge=1).
test("copy: container and network are deleted with it; its volume only with purge=1, by label", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      for (const purge of [false, true]) {
        const { s, fd } = await withInstance(ctx, open);
        const k = `cbase-k-${s.projectId}-k1`;
        const labels = ["--label", `cbase.project=${s.projectId}`, "--label", "cbase.instance=copy-k1"];
        execFileSync(fd.bin, ["volume", "create", ...labels, `${k}-docker`]);
        execFileSync(fd.bin, ["network", "create", "--subnet", "10.230.99.0/24", ...labels, `cbase-kn-${s.projectId}-k1`]);
        execFileSync(fd.bin, ["run", "-d", "--name", k, ...labels, "cbase-projectbox:latest"]);
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge }));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const z = fd.state();
        assert.deepEqual(Object.values(z.container).map((c) => c.name), [], `${purge}: a container stayed`);
        assert.deepEqual(Object.values(z.networks).map((n) => n.name), [], `${purge}: a network stayed`);
        assert.deepEqual(Object.keys(z.volumes).sort(), purge ? [] : [volumeName(s.projectId), `${k}-docker`].sort(), `${purge}: Volumes`);
        assert.deepEqual(r.body.projectContainer[0].notices, [], JSON.stringify(r.body));
      }
    } finally { cleanUp(open); }
  });
});

// ── Runtime folder and copy folders ────────────────────────────────────────────────────────────────────────────────

// Step 1 (purge=1, the container still runs) deletes NOTHING in B — every entry of the runtime folder goes through the container
// (`exec -u root <id> rm -rf <entry>`). Here the rm fails in the container: at the `stop` gate everything is still there, and
// only step 6 (after removing the container) clears in B. COUNTER-TEST: step 1 with runtimeAsServer ⇒ red (at the gate the
// non-root-owned entries were already gone — B had deleted them while the container ran).
test("purge=1: step 1 deletes nothing in B while the container runs — every entry through the container; if it fails only step 6 clears", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const broken = path.join(ctx.root, "rm-broken");
    fs.writeFileSync(broken, "#!/bin/sh\necho 'rm: refused' >&2\nexit 1\n", { mode: 0o755 });
    try {
      const s = scenario(ctx, { projectId: crypto.randomUUID() });
      const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: { ...s.programs, rm: broken }, stopGate: "stop" });
      open.push(fd);
      const row = await withOps(fd, () => createInstance(s.projectId, s.opts));
      assert.equal(row.state, "ready");
      const root = s.location.root;
      fs.mkdirSync(path.join(root, "scratch", "deep"), { recursive: true });
      fs.writeFileSync(path.join(root, "scratch", "deep", "note.txt"), "x");
      const entries = fs.readdirSync(root).sort();
      assert.ok(entries.includes("scratch") && entries.length >= 2, JSON.stringify(entries));
      const from = hostCalls(fd).length;
      const erase2 = withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
      let toEnd = false;
      erase2.finally(() => { toEnd = true; }).catch(() => {});
      await waitForTruthy(() => toEnd || fs.existsSync(path.join(fd.dir, "gates", "stop.waiting")), "stop at the gate or delete finished");
      assert.equal(toEnd, false, "the delete ran past the stop gate");
      // At the gate: the container still runs — B deleted nothing, and every entry went to the container.
      assert.deepEqual(fs.readdirSync(root).sort(), entries, "B deleted in the runtime folder while the container ran");
      assert.ok(fs.existsSync(path.join(root, "scratch", "deep", "note.txt")));
      const execs = since(fd, from).filter((a) => a[0] === "exec" && a[2] === "root");
      assert.deepEqual(execs.map((a) => a.slice(3, 6)), entries.map(() => [row.containerId, "rm", "-rf"]), JSON.stringify(execs));
      assert.deepEqual(execs.map((a) => a[6]).sort(), entries.map((n) => path.join(root, n)).sort());
      fd.openGate("stop");
      const r = await erase2;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [b] = r.body.projectContainer;
      assert.equal(b.runtime, "removed", JSON.stringify(b));
      assert.ok(b.notices.some((m) => m.includes("ließ sich nicht über den Projekt-Container entfernen")), JSON.stringify(b.notices));
      assert.equal(fs.existsSync(root), false, "step 6 did not clear the runtime folder");
    } finally {
      for (const fd of open) fd.openGate?.("stop");
      cleanUp(open);
    }
  });
});

// With purge=1 also `<data>/copies-backup/<pid>/` (bundle, `ignored.tar` with `.env`) and `<data>/copies/<pid>` go — link-safe
// (a link inside or in their place is deleted as a link, its target stays); without purge both stay; a 409 leaves them standing;
// also without an instance row (G2: the answer stays word for word) and through the workspace. COUNTER-TEST: the call of
// copiesLocationsRemove removed (sabotage in erase.js) ⇒ red (the backup with the `.env` stayed).
test("purge=1: copies-backup/<pid> and copies/<pid> are deleted with it, link-safe — without purge and on 409 they stay; also without a row and through the workspace", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const outside = path.join(ctx.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "b-file"), "B\n");
    const seed = (pid, { referenceInsteadFolder = false } = {}) => {
      const o = projectCopiesLocation({ data: DIRS.data, projectId: pid });
      fs.mkdirSync(path.join(o.backup, "k1"), { recursive: true });
      fs.writeFileSync(path.join(o.backup, "k1", "ignored.tar"), "SECRET=1\n");
      fs.writeFileSync(path.join(o.backup, "k1", "n0.bundle"), "bundle");
      fs.symlinkSync(outside, path.join(o.backup, "k1", "reference"));
      if (referenceInsteadFolder) {
        fs.mkdirSync(path.dirname(o.copies), { recursive: true });
        fs.symlinkSync(outside, o.copies);
      } else {
        fs.mkdirSync(path.join(o.copies, "k1", "layer", "p"), { recursive: true });
        fs.writeFileSync(path.join(o.copies, "k1", "layer", "p", "x"), "x");
      }
      return o;
    };
    const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
    const outsideIntact = () => assert.equal(fs.readFileSync(path.join(outside, "b-file"), "utf8"), "B\n", "the target of a link was deleted");
    try {
      // With a row, purge=1: both gone, the target of the links stays.
      {
        const { s, fd } = await withInstance(ctx, open);
        const o = seed(s.projectId);
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(exists(o.backup), false, "the backups of the copies (with ignored.tar holding the .env) stayed");
        assert.equal(exists(o.copies), false, "the locations of the copies stayed");
        assert.deepEqual(r.body.projectContainer[0].leftBehind, [], JSON.stringify(r.body));
        outsideIntact();
      }
      // Without purge: both stay.
      {
        const { s, fd } = await withInstance(ctx, open);
        const o = seed(s.projectId);
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.ok(exists(path.join(o.backup, "k1", "ignored.tar")) && exists(path.join(o.copies, "k1", "layer", "p", "x")), "without purge something was deleted");
      }
      // 409 (an instance in "relocation"): nothing is deleted.
      {
        const { s, fd } = await withInstance(ctx, open);
        const o = seed(s.projectId);
        setInstanceState(s.projectId, "main", "relocation", { phase: "test" });
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.ok(exists(path.join(o.backup, "k1", "ignored.tar")) && exists(path.join(o.copies, "k1")), "a 409 deleted the folders of the copies");
        setInstanceState(s.projectId, "main", "error", { error: "Testende" });
      }
      // Without a row (G2), `copies/<pid>` a link: both gone, the answer without a new field, the target stays.
      {
        const s = scenario(ctx, { projectId: crypto.randomUUID() });
        const o = seed(s.projectId, { referenceInsteadFolder: true });
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID } });
        open.push(fd);
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(Object.keys(r.body).sort(), ["note", "ok", "purged"], "a new field in the answer without a row (G2)");
        assert.equal(exists(o.backup), false);
        assert.equal(exists(o.copies), false, "the link in place of copies/<pid> stayed");
        assert.deepEqual(hostCalls(fd), [], "a docker call without a row");
        outsideIntact();
      }
      // Through the workspace, purge=1.
      {
        const ws = await newWs(ctx, "copies-locations");
        const { s, fd } = await withInstance(ctx, open, { workspace: ws });
        const o = seed(s.projectId);
        const r = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id, { purge: true }));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(exists(o.backup) || exists(o.copies), false, "through the workspace the folders of the copies stayed");
        outsideIntact();
      }
    } finally { cleanUp(open); }
  });
});

// Deleting a project also removes its relocation folder `<data>/relocations/<pid>/` (with the `.env*` originals). Step 9b, only
// after success, with AND without purge, with and without a row, through project and workspace route; link-safe (a link in its
// place is deleted itself, a link inside is deleted as a link); an open relocation journal holds it (notice in the report); a 409 leaves
// it standing; the rows in `project_relocations` stay.
test("relocation folder: goes with the project — without and with purge, without a row, through the workspace; link-safe; an open journal and a 409 leave it standing", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const outside = path.join(ctx.root, "outside-relocation");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "b-file"), "B\n");
    const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
    const outsideIntact = () => assert.equal(fs.readFileSync(path.join(outside, "b-file"), "utf8"), "B\n", "the target of a link was deleted");
    // A relocation as relocation/procedure.js leaves it: `<time>/` with plan and the backup of the `.env`, plus a link to the outside.
    const seed = (pid, { referenceInsteadFolder = false } = {}) => {
      const folder = relocationFolderOf({ data: DIRS.data, projectId: pid });
      if (referenceInsteadFolder) {
        fs.mkdirSync(path.dirname(folder), { recursive: true });
        fs.symlinkSync(outside, folder);
        return folder;
      }
      const location = createRelocationLocation({ data: DIRS.data, projectId: pid, time: relocationTime() });
      fs.mkdirSync(path.join(location, "env-backup"), { recursive: true });
      fs.writeFileSync(path.join(location, "env-backup", ".env"), "SECRET=1\n", { mode: 0o600 });
      fs.writeFileSync(path.join(location, "plan.json"), "{}\n");
      fs.symlinkSync(outside, path.join(location, "reference"));
      return folder;
    };
    try {
      // With a row, WITHOUT purge: gone, nothing left behind, the target of the link stays; the journal row stays.
      {
        const { s, fd } = await withInstance(ctx, open);
        const folder = seed(s.projectId);
        const j = store.createRelocation({ projectId: s.projectId, location: path.join(folder, "x") });
        store.endRelocation(j.id, "finished");
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(exists(folder), false, "without purge the relocation folder (with .env backup) stayed");
        assert.deepEqual(r.body.projectContainer[0].leftBehind, [], JSON.stringify(r.body));
        assert.equal(store.relocationsOf(s.projectId).length, 1, "the row in project_relocations was deleted (it stays)");
        outsideIntact();
      }
      // With a row, purge=1: gone likewise.
      {
        const { s, fd } = await withInstance(ctx, open);
        const folder = seed(s.projectId);
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(exists(folder), false, "with purge the relocation folder stayed");
        outsideIntact();
      }
      // 409 (an instance in "relocation"): it stays whole.
      {
        const { s, fd } = await withInstance(ctx, open);
        const folder = seed(s.projectId);
        setInstanceState(s.projectId, "main", "relocation", { phase: "test" });
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId, { purge: true }));
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.ok(fs.readdirSync(folder).length === 1 && exists(path.join(folder, fs.readdirSync(folder)[0], "env-backup", ".env")), "a 409 deleted the relocation folder");
        setInstanceState(s.projectId, "main", "error", { error: "Testende" });
      }
      // An OPEN relocation journal (the instance is not in "relocation"): the delete goes through, the folder stays with a notice.
      {
        const { s, fd } = await withInstance(ctx, open);
        const folder = seed(s.projectId);
        const j = store.createRelocation({ projectId: s.projectId, location: path.join(folder, "x") });
        try {
          const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId));
          assert.equal(r.status, 200, JSON.stringify(r.body));
          assert.ok(exists(folder), "an open journal did not hold the relocation folder (its way back)");
          const b = r.body.projectContainer[0];
          assert.deepEqual(b.leftBehind, [folder], JSON.stringify(b));
          assert.ok(b.notices.some((m) => /Umzug des Projekts steht noch offen/.test(m)), JSON.stringify(b.notices));
        } finally { store.deleteRelocation(j.id); }
      }
      // Without a row (G2), the folder itself a link: the link is deleted, its target stays; the answer without a new field, no docker.
      {
        const s = scenario(ctx, { projectId: crypto.randomUUID() });
        const folder = seed(s.projectId, { referenceInsteadFolder: true });
        const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID } });
        open.push(fd);
        const r = await withOps(fd, () => erase(ctx.base, "projects", s.projectId));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(Object.keys(r.body).sort(), ["note", "ok", "purged"], "a new field in the answer without a row (G2)");
        assert.equal(exists(folder), false, "the link in place of the relocation folder stayed");
        assert.deepEqual(hostCalls(fd), [], "a docker call without a row");
        outsideIntact();
      }
      // Through the workspace, without purge: a project with a row and one without — both relocation folders gone.
      {
        const ws = await newWs(ctx, "relocation-folder");
        const { s, fd } = await withInstance(ctx, open, { workspace: ws });
        const without = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
        const o1 = seed(s.projectId);
        const o2 = seed(without.projectId);
        const r = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(exists(o1), false, "through the workspace the relocation folder of the project with a row stayed");
        assert.equal(exists(o2), false, "through the workspace the relocation folder of the project without a row stayed");
        outsideIntact();
      }
    } finally { cleanUp(open); }
  });
});

// ── Deleting a workspace wakes nothing before its chats are deleted ─────────────────────────────────────────────────────────
// If deleteProjectbox released the idle lock in its finally, the transition (resolve → wakeProject) would wake the message that
// waited during the delete — a turn would start under a chat that is deleted moments later and keep running in B under a deleted id.
// So the route releases itself, AFTER the closing path (`halt`): the queue is gone with the chat, and wakeProject finds nothing.
// Observed at `running.add` (the same set that doRun fills) — there is no clock: the delete holds at the `stop` gate, the message
// arrives there.
// COUNTER-TEST: workspaces/routes.js and projectbox/erase.js releasing the lock in the finally ⇒ red ("woken …").
test("a message waiting during the workspace delete is not woken — no turn starts, nothing stands under the deleted id", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const add = running.add;
    const woken = [];
    try {
      const ws = await newWs(ctx, "lz3");
      const s = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, stopGate: "stop" });
      open.push(fd);
      await withOps(fd, () => createInstance(s.projectId, s.opts));
      store.changeProjectInstance(s.projectId, "main", { convertedAt: Date.now() });
      const c = await chatIn(ctx, s.projectId, ws.id);
      running.add = function (id) { if (id === c.id) woken.push(id); return add.call(this, id); };

      const erase2 = withOps(fd, () => erase(ctx.base, "workspaces", ws.id));
      let toEnd = false;
      erase2.finally(() => { toEnd = true; }).catch(() => {});
      await waitForTruthy(() => toEnd || fs.existsSync(path.join(fd.dir, "gates", "stop.waiting")), "stop at the gate or delete finished");
      assert.equal(projectLocked(s.projectId)?.reason, "erase", "no lock during the delete");
      const n = await withOps(fd, () => json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURING the workspace delete" }) }));
      assert.equal(n.locked, true, `the message ran into a container that is just falling: ${JSON.stringify(n)}`);
      fd.openGate("stop");
      const r = await erase2;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(woken, [], "woken: the waiting message started a turn before its chat was deleted");
      await ctx.waitForQuiet();
      assert.deepEqual(woken, [], "woken: after the delete a turn started under the deleted chat id");
      assert.ok(!store.getChat(c.id) && !store.getWorkspace(ws.id), "chat or workspace still exist");
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ?").get(c.id).n, 0, "history stands under the deleted chat id");
      assert.equal(projectLocked(s.projectId), null, "the lock stayed after the delete");
    } finally {
      running.add = add;
      for (const fd of open) fd.openGate?.("stop");
      cleanUp(open);
    }
  });
});

// ── The workspace lock stops starts in ALL chats of the workspace ───────────────────────────────────────────────────
// The second check of the route (`after`, after the docker steps) would leave a half-deleted workspace on a 409: if a turn began
// during the docker steps in a chat WITHOUT a converted project (tick, manager, filing, a message), project container and
// instance rows were already gone, workspace, projects and chats still stood — and the relocation tick moved the projects again
// after the quiet period. So the route locks the WORKSPACE FIRST (projectbox/idle.js workspaceDeleteLock, asked through
// projectLock — the same domain side that doRun, composer, wait line and start gate ask): a turn and an agent wait in EVERY chat
// of the workspace, a oneshot runs; after success the waiting ones are deleted with their chats, after a refusal they start. `after`
// remains the safeguard. Observed at `running.add` (the same set that doRun fills) and at the queue of /api/runs/active — no
// clock: the delete holds at the `stop` gate, the message arrives there.
// COUNTER-TESTS: workspaces/routes.js and projectbox/idle.js without the workspace lock ⇒ both red ("the message began a turn …";
// without the lock the turn started, and `after` answered 409 after removing the containers); `resolve()` without waking ⇒
// "refusal" red ("the held message stayed in the queue").
test("a message to a chat WITHOUT a project waits during the workspace delete — no turn, 200, nothing stays half", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    const add = running.add;
    const started = [];
    let cId = null;
    try {
      const ws = await newWs(ctx, "n24-without-project");
      const s = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, stopGate: "stop" });
      open.push(fd);
      await withOps(fd, () => createInstance(s.projectId, s.opts));
      store.changeProjectInstance(s.projectId, "main", { convertedAt: Date.now() });
      // A chat of the workspace WITHOUT a project — the "erase" lock of the project does not touch it — and one of ANOTHER workspace.
      const c = await chatIn(ctx, null, ws.id);
      cId = c.id;
      const foreign = await chatIn(ctx, null, ctx.ws.id);
      running.add = function (id) { if (id === c.id) started.push(id); return add.call(this, id); };

      const erase2 = withOps(fd, () => erase(ctx.base, "workspaces", ws.id));
      let toEnd = false;
      erase2.finally(() => { toEnd = true; }).catch(() => {});
      await waitForTruthy(() => toEnd || fs.existsSync(path.join(fd.dir, "gates", "stop.waiting")), "stop at the gate or delete finished");
      assert.equal(toEnd, false, "the delete ran past the stop gate — the path with docker steps was not entered");
      const n = await withOps(fd, () => json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURING the workspace delete, without a project" }) }));
      assert.equal(n.locked, true, `the message began a turn in a chat that is about to be deleted: ${JSON.stringify(n)}`);
      assert.deepEqual(started, [], "a turn started during the delete");
      // The verdict per purpose: an agent waits, a oneshot runs; a chat of another workspace is not affected.
      assert.deepEqual([projectLock(c.id, "agent")?.kind, projectLock(c.id, "agent")?.reason], ["wait", "workspace"], "a subagent began in the workspace that is just falling");
      assert.equal(projectLock(c.id, "oneshot"), null, "a oneshot waits — it cannot wait");
      assert.equal(projectLock(foreign.id, "turn"), null, "the lock touches a chat of another workspace");
      // A second delete of the same workspace while the first runs: 409, and the lock of the first stays.
      const second = await withOps(fd, () => erase(ctx.base, "workspaces", ws.id));
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.match(second.body.error, /wird gerade gelöscht/);
      fd.openGate("stop");
      const r = await erase2;
      assert.equal(r.status, 200, `the delete did not finish (half deleted?): ${JSON.stringify(r.body)}`);
      assert.deepEqual(started, [], "the waiting message started a turn before its chat was deleted");
      await ctx.waitForQuiet();
      assert.deepEqual(started, [], "after the delete a turn started under the deleted chat id");
      assert.ok(!store.getChat(c.id) && !store.getWorkspace(ws.id) && !store.getProject(s.projectId), "chat, workspace or project still exist");
      assert.equal(store.projectInstance(s.projectId), null, "the instance row stayed");
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ?").get(c.id).n, 0, "history stands under the deleted chat id");
      assert.ok(store.getChat(foreign.id), "the chat of the other workspace was deleted with it");
    } finally {
      running.add = add;
      // A failure must not become a hang: after a failure the harness waits for quiet, and an entry that nobody wakes any more
      // would hold it open forever (measured with the sabotage "resolve without waking").
      if (cId) pendingRunInputs.delete(cId);
      for (const fd of open) fd.openGate?.("stop");
      cleanUp(open);
    }
  });
});

test("if the workspace delete aborts (stop fails, 500), the held message starts afterwards", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    let cId = null;
    try {
      const ws = await newWs(ctx, "n24-refusal");
      const s = scenario(ctx, { projectId: crypto.randomUUID(), workspace: ws });
      const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, stopGate: "stop" });
      open.push(fd);
      await withOps(fd, () => createInstance(s.projectId, s.opts));
      store.changeProjectInstance(s.projectId, "main", { convertedAt: Date.now() });
      const c = await chatIn(ctx, null, ws.id);
      cId = c.id;
      // A docker whose `stop` first waits at the gate (the fake docker holds there) and THEN fails — the route answers 500, and
      // nothing is deleted (the stopped containers start again).
      const bin = path.join(ctx.root, "docker-stop-fails");
      fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = stop ]; then '${fd.bin}' "$@" >/dev/null; echo "Error response from daemon: cannot stop container: permission denied" >&2; exit 1; fi\nexec '${fd.bin}' "$@"\n`);
      fs.chmodSync(bin, 0o755);

      const erase2 = withOps({ bin }, () => erase(ctx.base, "workspaces", ws.id));
      let toEnd = false;
      erase2.finally(() => { toEnd = true; }).catch(() => {});
      await waitForTruthy(() => toEnd || fs.existsSync(path.join(fd.dir, "gates", "stop.waiting")), "stop at the gate or delete finished");
      assert.equal(toEnd, false, "the delete ran past the stop gate");
      const n = await withOps({ bin }, () => json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURING a delete that fails" }) }));
      assert.equal(n.locked, true, `the message began a turn while the workspace was being deleted: ${JSON.stringify(n)}`);
      fd.openGate("stop");
      const r = await erase2;
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.ok(store.getChat(c.id) && store.getWorkspace(ws.id) && store.projectInstance(s.projectId), "despite the 500 something was deleted");
      // The route releases the lock in the finally, synchronously after its answer: the entry has already been taken from the queue.
      assert.equal((await json(`${ctx.base}/api/runs/active`)).open?.queue ?? 0, 0, "the held message stayed in the queue");
      await ctx.waitForQuiet();
      const log = await json(`${ctx.base}/api/chats/${c.id}/log`);
      const u = log.findIndex((m) => m.role === "user" && m.text.includes("DURING a delete that fails"));
      assert.ok(u >= 0 && log.slice(u + 1).some((m) => m.role === "assistant"), `user → assistant: ${JSON.stringify(log.map((m) => m.role))}`);
      assert.equal(projectLock(c.id, "turn"), null, "the workspace lock stayed after the refusal");
    } finally {
      if (cId) pendingRunInputs.delete(cId); // see above: a failure must not become a hang
      for (const fd of open) fd.openGate?.("stop");
      cleanUp(open);
    }
  });
});
