// Guard for the tree of instances — projectbox/instances-tree.js through the real route of a real server (agent-harness.mjs), the
// fake docker (fake-docker.mjs, its `exec` runs LOCAL) and real git in throwaway repos. `docker` INSIDE the project container is a
// wrapper around the same fake docker with the daemon of the container (FAKE_DOCKER_DAEMON in the container's environment).
//
// Each promise, with the way that breaks it:
//   (1) Contract: `{ loaded, ops, asOf, instances }`, main first, then the copies in creation order — also a WAITING copy without an
//       instance row (with `waiting: { reason: "queue", since }`); per instance exactly the fields of FIELDS; `progress` is null except on
//       a copy that waits or is being created; an instance that is not ready and not named carries container and repos as
//       `{ loaded: false, open: false }`, never an empty list. `action` per instance: null without an action; the action sits on ITS
//       instance, but only if it began after the instance row was created.
//   (2) Summary, counted on the wire: the first tree reads EVERY ready instance (one exec each, none into a waiting one), the next one
//       within SUMMARY_MS none — from memory, with the same `asOf`; `?open=main` reads exactly main fresh; `?fresh=1` every ready
//       one; a state change of the row (updatedAt) re-reads exactly that instance, an expired deadline every one. In it `docker ps -a`
//       (containers with service, run, status — also stopped ones) and per code repo branch and number of open files, with
//       GIT_OPTIONAL_LOCKS=0; every part read carries `asOf`.
//   (3) Partial failure: the exec into a copy whose container is missing yields `container`/`repos` with `loaded: false` and a reason —
//       main in the same tree is complete; a waiting copy is never asked (no exec), even if it is in `open`.
//   (4) Services: `link` exactly at (instance, service) — a link of the copy does not appear in main nor at the neighbouring service;
//       `startable` is false in EVERY instance without a start command (the plain start of the tree used to end there in a 400
//       "no start command stored"), true with one. Chats: the chat of the copy with `running`.
//   (5) Without the operating marker 404, a project that is not converted 409 NOT_CONVERTED.
//
// Counter-tests: `startable` again `name === MAIN || …` => (4) red (the web service of main without a start command was startable);
// the link search without `x.instance === name` => (4) red (the link of the copy also stood in main); the detail row for a
// non-named instance as `{ loaded: false, list: [] }` => (1) red; without the fence row => fence.test.js red; the summary without
// memory (`false && …`), without the `marker` comparison and without `fresh` => (2) red each (second tree re-read · state change did
// not re-read · fresh did not read every one); `actionThe` without the comparison with the creation time of the row => (1) red (the
// action of the predecessor stood at the copy). No time limit: waits on answers, never on a duration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { running } from "../electron/server/runs/state.js";
import { containerName } from "../electron/server/projectbox/creation.js";
import { TREE_SCRIPT, openFromQuery } from "../electron/server/projectbox/instances-tree.js";
import { actionBegins, actionEnds } from "../electron/server/projectbox/instance-action-status.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { realGit, gitLocation } from "./projectbox-git-scenario.mjs";

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd, o) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", GIT_TERMINAL_PROMPT: undefined, CBASE_GIT_PROJECTS: path.join(o.location, "git-projects") });
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8", env: { ...process.env, ...fd.env } }).trim();
async function response(url) {
  const r = await fetch(url, { headers: { Connection: "close" } });
  return { status: r.status, body: await r.json() };
}

// `docker` in the container: a wrapper around the fake docker; the daemon comes from the environment of the container.
function dockerInContainer(fd, o) {
  const folder = path.join(o.location, "inside-bin");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "docker"), `#!/bin/sh\nexec '${fd.bin}' "$@"\n`, { mode: 0o755 });
  return folder;
}
function containerStart(fd, o, name) {
  const env = { ...o.containerEnv, FAKE_DOCKER_DAEMON: name, PATH: `${dockerInContainer(fd, o)}${path.delimiter}${o.env.PATH}` };
  execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
// The `docker exec` calls on the host daemon from `ab` on, counted per target container (the target is the first argument after the options).
function execsFrom(fd, from) {
  const count = {};
  for (const a of fd.calls({ daemon: "host" }).slice(from)) {
    if (a.args[0] !== "exec") continue;
    const rest = a.args.slice(1);
    let i = 0;
    while (i < rest.length && rest[i].startsWith("-")) i += ["-u", "--user", "-e", "--env", "-w", "--workdir"].includes(rest[i]) ? 2 : 1;
    count[rest[i]] = (count[rest[i]] || 0) + 1;
  }
  return count;
}
// `action` — the last action of the human on the instance. A part that was read carries `asOf` (when it was read) — checked and
// removed for the comparison.
function withoutStatus(part) {
  const { asOf, ...rest } = part;
  assert.equal(typeof asOf, "number", `a part read without asOf: ${JSON.stringify(part)}`);
  return rest;
}
const FIELDS = ["name", "identifier", "state", "phase", "error", "waiting", "cpu", "memBytes", "createdOf", "base", "container", "repos", "services", "chats", "action", "progress"];

test("unit: ?open comma-separated, empty entries and spaces; the script asks docker ps with the template and git without optional locks in REPOS_SCRIPT", () => {
  assert.deepEqual([...openFromQuery("main, copy-k1,,junk ")], ["main", "copy-k1", "junk"]);
  assert.deepEqual([...openFromQuery(null)], []);
  assert.match(TREE_SCRIPT, /docker ps -a --format "\$v"/);
  assert.match(TREE_SCRIPT, /rev-parse --show-toplevel/);
});

// (6) The project folder lies IN a code repo (a subfolder): the root question (git.js projectReposWithRoot, like projectRepos) runs in
// the SAME exec — still exactly one —, and the row is that of this repo (`rel: ""`), read in the folder. Counter-test: without
// `rootQuestion` the tree searches only UNDER the folder — `list` was empty. (If the folder itself is a repo, the search finds it
// too; that does not distinguish the root question, measured.)
test("(6) project folder in a code repo: root question in the same exec, one row with rel \"\"", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-in8w-");
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        const R = path.join(ctx.root, "workspace", "root-in8");
        const P = path.join(R, "project");
        fs.mkdirSync(P, { recursive: true });
        realGit(R, ["init", "-q", "-b", "main"], o.env);
        fs.writeFileSync(path.join(P, "x.txt"), "x\n");
        realGit(R, ["add", "-A"], o.env);
        realGit(R, ["commit", "-q", "-m", "one"], o.env);
        fs.writeFileSync(path.join(P, "y.txt"), "y\n");
        const p = await ctx.projectWithoutInstance({ name: "Root project", path: P });
        const main = `cbase-p-${p.id}`;
        containerStart(fd, o, main);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
        const before = fd.calls({ daemon: "host" }).length;
        const r = await response(`${ctx.base}/api/projects/${p.id}/instances?open=main`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(execsFrom(fd, before), { [main]: 1 });
        const h = r.body.instances[0];
        assert.deepEqual(withoutStatus(h.repos), { loaded: true, open: true, error: "", list: [{ rel: "", branch: "main", detached: false, open: 1 }] });
        assert.deepEqual(withoutStatus(h.container), { loaded: true, open: true, error: "", list: [] }, "a daemon without containers is an empty, LOADED list");
      });
    });
  } finally {
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(1)–(5) contract, summary (memory, fresh, state change, deadline), partial failure, link per (instance, service), chats, no marker and 409", async () => {
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-in8-");
  let turnChat = null;
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = path.join(ctx.root, "workspace", "tree-in8");
      fs.mkdirSync(P, { recursive: true });
      // A code repo `app` with a changed and a new file; the project folder itself is not a repo.
      const A = path.join(P, "app");
      fs.mkdirSync(A);
      realGit(A, ["init", "-q", "-b", "main"], o.env);
      fs.writeFileSync(path.join(A, "a.txt"), "a\n");
      realGit(A, ["add", "-A"], o.env);
      realGit(A, ["commit", "-q", "-m", "one"], o.env);
      realGit(A, ["checkout", "-q", "-b", "feat/login"], o.env);
      fs.writeFileSync(path.join(A, "a.txt"), "changed\n");
      fs.writeFileSync(path.join(A, "fresh.txt"), "n\n");

      // (5) no operating marker: 404 before anything is read.
      const without = await ctx.projectWithoutInstance({ name: "Without", path: path.join(ctx.root, "workspace", "without-in8") });
      await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined }, async () => {
        const r = await response(`${base}/api/projects/${without.id}/instances`);
        assert.equal(r.status, 404, JSON.stringify(r.body));
      });
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        const nu = await response(`${base}/api/projects/${without.id}/instances`);
        assert.deepEqual([nu.status, nu.body.code], [409, "NOT_CONVERTED"], JSON.stringify(nu.body));

        const p = await ctx.projectWithoutInstance({ name: "Tree project", path: P });
        const main = `cbase-p-${p.id}`;
        containerStart(fd, o, main);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
        // In the inner daemon: one running Compose container and one stopped.
        dx(fd, "exec", main, "docker", "run", "-d", "--name", "web-1", "--label", "com.docker.compose.service=web", "web-img");
        dx(fd, "exec", main, "docker", "run", "-d", "--name", "db-1", "--label", "com.docker.compose.service=db", "pg-img");
        dx(fd, "exec", main, "docker", "stop", "db-1");
        // k1: ready, created by the chat (tool), container MISSING (the exec fails); k2: waits in the queue, without a row.
        const k1 = store.createStackCopy({ projectId: p.id, name: "k1", chatId: ctx.chat.id, inset: true, state: "ready" });
        store.createProjectInstance({ projectId: p.id, instance: "copy-k1", state: "ready", containerId: containerName(p.id, "copy-k1") });
        store.createStackCopy({ projectId: p.id, name: "k2" });
        // Two services: `web` with a port without a start command, `api` with a start command; a link on (copy-k1, web).
        const web = store.addProjectService(p.id, { name: "Web", port: 39117 });
        const api = store.addProjectService(p.id, { name: "Api", port: 39118, startCommand: "npm start" });
        store.createPreviewLink({ id: "link-k1-web", projectId: p.id, instance: "copy-k1", serviceId: web.id, port: 39117, mode: "dev", createdAt: Date.now(), runningSinceAt: 4_000_000_000_000 });
        // The chat works in copy-k1 (the human's way: PATCH), its turn runs.
        await json(`${base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        await json(`${base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ instance: "copy-k1" }) });
        const title = store.getChat(ctx.chat.id).title;
        const url = (q = "") => `${base}/api/projects/${p.id}/instances${q}`;
        turnChat = ctx.chat.id;
        running.add(turnChat);
        try {
          // (1)(2) without `open`: the contract; every READY instance read once (summary), the waiting one never.
          const before0 = fd.calls({ daemon: "host" }).length;
          const r0 = await response(url());
          assert.equal(r0.status, 200, JSON.stringify(r0.body));
          assert.deepEqual(execsFrom(fd, before0), { [main]: 1, [containerName(p.id, "copy-k1")]: 1 }, "the summary did not read every ready instance exactly once");
          assert.deepEqual([r0.body.loaded, r0.body.ops, typeof r0.body.asOf], [true, true, "number"]);
          assert.deepEqual(r0.body.instances.map((i) => i.name), ["main", "copy-k1", "copy-k2"]);
          for (const i of r0.body.instances) assert.deepEqual(Object.keys(i), FIELDS, i.name);
          {
            const [h, a, b] = r0.body.instances;
            assert.deepEqual([withoutStatus(h.container).loaded, withoutStatus(h.repos).loaded], [true, true], "main without summary");
            assert.deepEqual(withoutStatus(h.repos).list, [{ rel: "app", branch: "feat/login", detached: false, open: 2 }]);
            for (const part of [a.container, a.repos]) {
              assert.deepEqual([part.loaded, part.open], [false, true], JSON.stringify(part));
              assert.match(part.error, /No such container/, "the error of the copy is invisible (`open: false` would mean “closed”)");
            }
            assert.deepEqual([b.container, b.repos], [{ loaded: false, open: false }, { loaded: false, open: false }], "the waiting copy was asked");
            // `progress` only on a copy that waits or is being created (projectbox/copy-progress.js) — main and a ready copy carry
            // null, the waiting one step 0 without an estimate.
            assert.deepEqual([h.progress, a.progress], [null, null], "a ready instance carries a progress");
            assert.deepEqual([b.progress?.kind, b.progress?.reason, b.progress?.step, b.progress?.share], ["waiting", "queue", 0, null], JSON.stringify(b.progress));
          }
          // The next tree within the deadline: NO exec, the same state from memory.
          const before0b = fd.calls({ daemon: "host" }).length;
          const r0b = await response(url());
          assert.deepEqual(execsFrom(fd, before0b), {}, "the second tree re-read instead of taking the memory");
          assert.deepEqual(r0b.body.instances.map((i) => [i.container, i.repos]), r0.body.instances.map((i) => [i.container, i.repos]));
          const [h0, a0, b0] = r0.body.instances;
          assert.deepEqual([h0.action, a0.action, b0.action], [null, null, null], "without an action `action: null` stands");
          // The action sits on ITS instance — but only if it began after the instance row was created (a copy that was removed and
          // re-created with the same name does not inherit the state of its predecessor).
          // Every action ends BEFORE the check: a running one would hold `busy` (project work), and a red case would hang at the end of the server.
          actionBegins(p.id, "copy-k1", "branch", 1);
          actionEnds(p.id, "copy-k1", { ok: true });
          assert.equal((await response(url())).body.instances.find((i) => i.name === "copy-k1").action, null, "the action of a predecessor stood at the copy");
          actionBegins(p.id, "copy-k1", "branch");
          actionEnds(p.id, "copy-k1", { ok: false, error: "Exit 1" });
          const withAction = (await response(url())).body.instances;
          assert.deepEqual(withAction.map((i) => [i.name, i.action?.kind ?? null, i.action?.error ?? null]), [["main", null, null], ["copy-k1", "branch", "Exit 1"], ["copy-k2", null, null]]);
          assert.deepEqual([h0.identifier, h0.state, h0.waiting, h0.createdOf, h0.base], [`${p.id}/main`, "ready", null, null, null]);
          assert.equal(typeof h0.cpu, "number", "cpu of main from the measurement (docker stats)");
          assert.ok(h0.memBytes > 0, JSON.stringify(h0));
          assert.deepEqual([a0.state, a0.waiting, a0.createdOf, a0.base], ["ready", null, { chatId: ctx.chat.id, title }, "main"]);
          assert.deepEqual([a0.cpu, a0.memBytes], [null, null], "the copy without a container has no numbers — null, not 0");
          assert.deepEqual([b0.state, b0.waiting?.reason, typeof b0.waiting?.since, b0.createdOf], ["waiting_queue", "queue", "number", null]);
          assert.equal(k1.baseInstance, "main");

          // (4) Services: link exactly at (copy-k1, Web); startable in the copy only with a start command. Chats: the chat of the copy runs.
          const service = (i, id) => i.services.find((d) => d.id === id);
          assert.deepEqual(Object.keys(service(h0, web.id)), ["id", "name", "port", "running", "holdsStart", "startable", "link"]);
          assert.equal(service(h0, web.id).link, null, "the link of the copy stood in main");
          assert.equal(service(a0, api.id).link, null, "the link stood at the neighbouring service");
          assert.deepEqual(service(a0, web.id).link, { id: "link-k1-web", url: "", procedure: 4_000_000_000_000, state: "start" });
          assert.deepEqual([service(h0, web.id).startable, service(h0, api.id).startable, service(a0, web.id).startable, service(a0, api.id).startable], [false, true, false, true],
            "startable only with a start command — in main as in the copy (without a command the plain start ends in the 400)");
          assert.deepEqual([service(h0, web.id).running, service(h0, web.id).holdsStart], [false, false]);
          assert.deepEqual(a0.chats, [{ id: ctx.chat.id, title, running: true }]);
          assert.deepEqual(h0.chats, []);

          // (2) `open=main`: exactly ONE exec into the main container, none into the copy.
          const before1 = fd.calls({ daemon: "host" }).length;
          const r1 = await response(url("?open=main"));
          assert.equal(r1.status, 200, JSON.stringify(r1.body));
          assert.deepEqual(execsFrom(fd, before1), { [main]: 1 }, "not exactly one exec per open instance (the copy comes from memory)");
          const h1 = r1.body.instances[0];
          assert.deepEqual(withoutStatus(h1.container), { loaded: true, open: true, error: "", list: [
            { name: "db-1", service: "db", running: false, status: h1.container.list[0]?.status },
            { name: "web-1", service: "web", running: true, status: h1.container.list[1]?.status }] });
          assert.ok(h1.container.list[1].status, "the status text is missing");
          assert.deepEqual(withoutStatus(h1.repos), { loaded: true, open: true, error: "", list: [{ rel: "app", branch: "feat/login", detached: false, open: 2 }] });
          assert.deepEqual([r1.body.instances[1].container.loaded, r1.body.instances[1].container.open], [false, true], "the copy does not carry its read error");
          assert.deepEqual([r1.body.instances[2].container, r1.body.instances[2].repos], [{ loaded: false, open: false }, { loaded: false, open: false }]);
          // The exec carried GIT_OPTIONAL_LOCKS (as `-e NAME`, the value from the environment of the docker child).
          const execArgs = fd.calls({ daemon: "host" }).slice(before1).find((a) => a.args[0] === "exec").args;
          assert.ok(execArgs.includes("GIT_OPTIONAL_LOCKS"), execArgs.join(" "));

          // (2) `?fresh=1` re-reads every ready instance; a state change of the row (updatedAt) exactly that one; an expired deadline every one.
          const beforeF = fd.calls({ daemon: "host" }).length;
          assert.equal((await response(url("?fresh=1"))).status, 200);
          assert.deepEqual(execsFrom(fd, beforeF), { [main]: 1, [containerName(p.id, "copy-k1")]: 1 }, "fresh did not read every ready instance");
          store.changeProjectInstance(p.id, "main", { phase: "", now: Date.now() + 1000 });
          const beforeZ = fd.calls({ daemon: "host" }).length;
          assert.equal((await response(url())).status, 200);
          assert.deepEqual(execsFrom(fd, beforeZ), { [main]: 1 }, "a state change of main did not re-read exactly main");
          await withEnvironment({ CBASE_INSTANCE_SUMMARY_MS: "1" }, async () => {
            const beforeT = fd.calls({ daemon: "host" }).length;
            assert.equal((await response(url())).status, 200);
            assert.deepEqual(execsFrom(fd, beforeT), { [main]: 1, [containerName(p.id, "copy-k1")]: 1 }, "an expired deadline did not re-read");
          });

          // (3) All three open (plus an unknown name): main complete, k1 with a reason (container missing), k2 never asked.
          const before2 = fd.calls({ daemon: "host" }).length;
          const r2 = await response(url("?open=main,copy-k1,copy-k2,copy-nonexistent"));
          assert.equal(r2.status, 200, JSON.stringify(r2.body));
          assert.deepEqual(execsFrom(fd, before2), { [main]: 1, [containerName(p.id, "copy-k1")]: 1 });
          const [h2, a2, b2] = r2.body.instances;
          assert.equal(h2.repos.loaded, true);
          assert.equal(h2.container.list.length, 2);
          for (const part of [a2.container, a2.repos]) {
            assert.equal(part.loaded, false, JSON.stringify(part));
            assert.equal(part.open, true);
            assert.match(part.error, /No such container/);
            assert.equal("list" in part, false, "a failed query carried a list");
          }
          for (const part of [b2.container, b2.repos]) {
            assert.deepEqual([part.loaded, part.open], [false, true]);
            assert.match(part.error, /nicht bereit \(waiting_queue\)/);
          }
        } finally {
          running.delete(turnChat);
          turnChat = null;
        }
      });
    });
  } finally {
    if (turnChat) running.delete(turnChat);
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});
