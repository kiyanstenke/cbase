// Guards for the fetch of the git overview — gitView/fetch.js over the real route of a real server (agent-harness.mjs), the fake
// docker (fake-docker.mjs, its `exec` runs LOCAL) and real git with a bare remote. Model: instances-tree.test.js (its small helpers
// appear here once more — a .test.js never imports another).
//
// What it proves, each with the sabotage that breaks it:
//   (1) Without the server-mode marker 404, a project not yet converted 409 NOT_CONVERTED; `auto` missing => 400 (a missing field is no
//       statement).
//   (2) The fetch runs in the container of the instance and fetches (origin/main then sits on the remote's new commit); `remoteState`
//       is the time of FETCH_HEAD. A second `auto: true` within FETCH_GAP_MS is `skipped` — NO docker call; `auto: false` (the button)
//       bypasses the throttle; after the gap (clock seam, no waiting) `auto: true` fetches again. Sabotage: the throttle without
//       `body.auto &&` => (2) red (the button was skipped); without the throttle (`false &&`) => (2) red (the second auto called docker).
//   (3) The same locks as the existing fetch: a writing layout job => 409 LAYOUT_RUNNING, a project lock (relocation) => 409 with the
//       state (`starts`, reason) — both WITHOUT a docker call. Sabotage: without the up-front check of the setup lock and without it
//       in the state => (3) red (200, the fetch ran).
//   (5) The fetch that ran discards the reading: the large view then shows the numbers for the remote AS OF NOW (main down 1), not the
//       stored ones from before. Sabotage: dismissReading struck from fetch.js => (5) red (down 0 from the cache). And `repo`: a folder
//       inside the repo that is none itself is 404 UNKNOWN_REPO — before the throttle, without docker (sabotage: the old path check =>
//       red, the fetch ran).
//   (4) An instance that is not `ready` (main stopped, copy starting) is neither asked nor woken: 409 INSTANCE_NOT_READY with state, NO
//       docker call to any daemon; an unknown copy 404. Sabotage: readyInstance without the state check => (4) red (docker exec into the
//       stopped container).
// No time limit: waits for answers, never for a duration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { FETCH_GAP_MS } from "../electron/server/gitView/contract.js";
import { setFetchClock, forgetFetchDrossel } from "../electron/server/gitView/fetch.js";
import { setLayoutReader } from "../electron/server/projectbox/setup/status.js";
import { layoutReader } from "../electron/server/projectbox/layout/job.js";
import { projectLocks } from "../electron/server/projectbox/idle.js";
import { containerName } from "../electron/server/projectbox/creation.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { realGit, gitLocation, createRepo } from "./projectbox-git-scenario.mjs";

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
function containerStart(fd, o, name) {
  const env = { ...o.containerEnv, PATH: o.env.PATH };
  execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
// The `docker exec` calls at the host daemon from index `ab`, counted per target container.
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
const allCalls = (fd) => fd.calls({ daemon: "host" }).length;
async function fetchData(base, pid, body) {
  const r = await fetch(`${base}/api/projects/${pid}/gitView/fetch`, { method: "POST", headers: { "content-type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test("(1)–(4) fetch of the git overview: server mode and conversion, throttle with clock seam, button, locks, no instance that is not ready", async () => {
  forgetFetchDrossel();
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-gu5-");
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const P = path.join(ctx.root, "workspace", "gu5");
      const A = path.join(P, "app");
      const R = path.join(o.location, "remote.git");
      createRepo(A, o.env, { remote: R });
      const p = await ctx.projectWithoutInstance({ name: "Git overview", path: P });

      // (1) without the server-mode marker 404 — before everything else; in server mode, not converted, 409.
      await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined }, async () => {
        const r = await fetchData(base, p.id, { repo: "app", instance: "main", auto: true });
        assert.equal(r.status, 404, JSON.stringify(r.body));
      });
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        const nu = await fetchData(base, p.id, { repo: "app", instance: "main", auto: true });
        assert.deepEqual([nu.status, nu.body.code], [409, "NOT_CONVERTED"], JSON.stringify(nu.body));

        const main = `cbase-p-${p.id}`;
        containerStart(fd, o, main);
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
        const withoutAuto = await fetchData(base, p.id, { repo: "app", instance: "main" });
        assert.deepEqual([withoutAuto.status, withoutAuto.body.code], [400, "AUTO_MISSING"], JSON.stringify(withoutAuto.body));
        // (5) `repo`: only a code repo of the project — a folder inside the repo is none.
        fs.mkdirSync(path.join(A, "under"), { recursive: true });
        const beforeUnder = allCalls(fd);
        const under = await fetchData(base, p.id, { repo: "app/under", instance: "main", auto: false });
        assert.deepEqual([under.status, under.body.code], [404, "UNKNOWN_REPO"], JSON.stringify(under.body));
        assert.equal(allCalls(fd), beforeUnder, "a foreign folder called docker");

        // (2) A new commit in the remote (via a second clone), then the first auto fetch: it fetches.
        const C = path.join(o.location, "clone");
        realGit(o.location, ["clone", "-q", R, C], o.env);
        fs.writeFileSync(path.join(C, "b.txt"), "b\n");
        realGit(C, ["add", "-A"], o.env);
        realGit(C, ["commit", "-q", "-m", "second state"], o.env);
        realGit(C, ["push", "-q", "origin", "main"], o.env);
        const fresh = realGit(C, ["rev-parse", "HEAD"], o.env).trim();
        assert.notEqual(realGit(A, ["rev-parse", "origin/main"], o.env).trim(), fresh, "seed: origin/main is still old");

        // (5) The large view reads now (origin/main still old: main down 0) and stores the reading.
        const view = async () => {
          const r = await fetch(`${base}/api/projects/${p.id}/gitView?repo=app`, { headers: { Connection: "close" } });
          const b = await r.json();
          assert.equal(r.status, 200, JSON.stringify(b));
          return b.rows.find((z) => z.name === "main" && z.instance === "main");
        };
        assert.equal((await view())?.toRemote?.back, 0, "seed: main is not behind origin/main before the fetch");

        let before = allCalls(fd);
        const one = await fetchData(base, p.id, { repo: "app", instance: "main", auto: true });
        assert.equal(one.status, 200, JSON.stringify(one.body));
        assert.equal(one.body.skipped, false);
        assert.equal(one.body.remoteState.source, "fetch-head");
        assert.ok(Number.isSafeInteger(one.body.remoteState.at) && one.body.remoteState.at > 0, JSON.stringify(one.body.remoteState));
        assert.ok((execsFrom(fd, before)[main] || 0) >= 1, "the fetch did not run in the container");
        assert.equal(realGit(A, ["rev-parse", "origin/main"], o.env).trim(), fresh, "the fetch did not fetch");
        assert.equal((await view())?.toRemote?.back, 1, "after the fetch the view showed the stored reading from before");

        // A second auto within the gap: skipped, NO docker call.
        before = allCalls(fd);
        const two = await fetchData(base, p.id, { repo: "app", instance: "main", auto: true });
        assert.equal(two.status, 200, JSON.stringify(two.body));
        assert.deepEqual([two.body.skipped, two.body.remoteState], [true, one.body.remoteState]);
        assert.ok(two.body.nextNotBefore > Date.now(), JSON.stringify(two.body));
        assert.equal(allCalls(fd), before, "the throttle called docker");

        // The button (auto: false) bypasses it.
        before = allCalls(fd);
        const button = await fetchData(base, p.id, { repo: "app", instance: "main", auto: false });
        assert.deepEqual([button.status, button.body.skipped], [200, false], JSON.stringify(button.body));
        assert.ok((execsFrom(fd, before)[main] || 0) >= 1, "the button did not fetch");

        // After the gap (clock seam, no waiting) auto fetches again.
        const now = Date.now();
        setFetchClock(() => now + FETCH_GAP_MS + 1);
        try {
          before = allCalls(fd);
          const later = await fetchData(base, p.id, { repo: "app", instance: "main", auto: true });
          assert.deepEqual([later.status, later.body.skipped], [200, false], JSON.stringify(later.body));
          assert.ok((execsFrom(fd, before)[main] || 0) >= 1);
        } finally { setFetchClock(null); }

        // (3) The locks of the existing git actions — without docker. First the layout job, then a project lock (relocation).
        setLayoutReader((pid) => (pid === String(p.id) ? "running" : null));
        try {
          before = allCalls(fd);
          const gl = await fetchData(base, p.id, { repo: "app", instance: "main", auto: false });
          assert.deepEqual([gl.status, gl.body.code], [409, "LAYOUT_RUNNING"], JSON.stringify(gl.body));
          assert.equal(allCalls(fd), before, "docker ran under the layout lock");
        } finally { setLayoutReader(layoutReader); }
        const lock = await projectLocks(p.id, { reason: "relocation" });
        assert.equal(lock.ok, true, JSON.stringify(lock));
        try {
          before = allCalls(fd);
          const fetched = await fetchData(base, p.id, { repo: "app", instance: "main", auto: false });
          assert.equal(fetched.status, 409, JSON.stringify(fetched.body));
          assert.equal(fetched.body.starts, true, JSON.stringify(fetched.body));
          assert.equal(allCalls(fd), before, "docker ran under the project lock");
        } finally { lock.resolve(); }

        // (4) Not ready: main stopped, a copy starting — no docker at any daemon; an unknown copy 404.
        store.changeProjectInstance(p.id, "main", { state: "stopped" });
        store.createStackCopy({ projectId: p.id, name: "k1", state: "ready" });
        store.createProjectInstance({ projectId: p.id, instance: "copy-k1", state: "start", containerId: containerName(p.id, "copy-k1") });
        try {
          before = allCalls(fd);
          for (const instance of ["main", "k1"]) {
            const r = await fetchData(base, p.id, { repo: "app", instance, auto: false });
            assert.deepEqual([r.status, r.body.code, r.body.state], [409, "INSTANCE_NOT_READY", instance === "main" ? "stopped" : "start"], JSON.stringify(r.body));
          }
          assert.equal(allCalls(fd), before, "an instance that is not ready was asked or woken");
          const foreign = await fetchData(base, p.id, { repo: "app", instance: "k9", auto: true });
          assert.deepEqual([foreign.status, foreign.body.code], [404, "UNKNOWN_INSTANCE"], JSON.stringify(foreign.body));
          const copyForm = await fetchData(base, p.id, { repo: "app", instance: "copy-k1", auto: true });
          assert.equal(copyForm.status, 404, `the name at the seam is "k1", not "copy-k1": ${JSON.stringify(copyForm.body)}`);
        } finally {
          // An instance in state `start` counts as working — otherwise the harness would wait for an idle that never comes.
          store.changeProjectInstance(p.id, "main", { state: "ready" });
          store.deleteProjectInstance(p.id, "copy-k1");
        }
      });
    });
  } finally {
    forgetFetchDrossel();
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});
