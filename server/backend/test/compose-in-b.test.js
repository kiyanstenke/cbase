// The operations state for the operator's status check: Compose containers in B next to converted projects and the projects without an
// instance row — GET /api/projectbox/ops-status (projectbox/relocation/routes.js projectboxOpsRoutes, leaf
// projectbox/relocation/compose-in-b.js).
//
// What holds here:
//   composeInB  per CONVERTED project, `composeInB` names the Compose containers in B (working_dir in the project folder); a
//               project with a stack that is not converted does not appear there but under `withoutInstanceRow`. If `ps` fails,
//               the field is `null` — unknown, not `[]` (built-in counter-test via a broken docker in front).
//               Sabotage: the ops status without the field => red ("composeInB missing").
//   state       running AND stopped containers, with `running`.
//               Sabotage: the entry without `running` => red.
//   cap         if `ps` hangs, the route answers at the SHORT cap (below the curl deadline of the deploy tool's remote.mjs
//               remoteOpsStatus): `composeInB` null, the synchronous part (`withoutInstanceRow`) arrives, the warning names THE
//               cap. No clock: the `ps` waits on a gate file, the test advances the caps (advanceCap).
//               Sabotage: `containerInB` without `capMs` => red (the message names "cap of 120000 ms (seam default ...)").
//   withoutInstanceRow  names EXACTLY the projects without an instance row, with id and name (the setup row of the operator's status check
//               names them, the deploy tool's project-container.mjs setupRow). Without an ops marker the route is 404 and docker is
//               not called; the fence rejects it from project networks (row "ops-status").
//               Sabotage: `withoutInstanceRow` in routes.js without the filter (all projects) => red; the fence row removed => red
//               (the route would fall under no row).
//
// Only the response and the "ps hangs" marker are waited for — no duration is a criterion.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { COMPOSE_IN_B_CAP_MS, OPS_STATUS_CURL_MAX_TIME_S } from "../electron/server/projectbox/relocation/compose-in-b.js";
import { advanceCap } from "../electron/server/projectbox/docker.js";
import { rowFor } from "../electron/server/projectbox/fence-table.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

// The Compose model of the stacks from `project(…, { stack: "<name>" })`: one service `db` each, without a volume (`stack3`: the stopped
// leftover in the stopped-container test).
const MODEL = Object.fromEntries(["stack1", "stack2", "stack3"].map((n) => [n, { db: { image: "postgres:16", restart: "always" } }]));
const L = { project: "com.docker.compose.project", service: "com.docker.compose.service" };
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const ROUTE = "/api/projectbox/ops-status";

// A project without a stack (the scenario creates it via the store, without an instance row); `stack` (a name from MODEL) also creates in
// B a running Compose service with working_dir in the project.
function project(ctx, fd, { name, stack = false } = {}) {
  const s = scenario(ctx, { name });
  if (stack) {
    const d = (n) => path.join(s.path, n);
    fs.writeFileSync(d("docker-compose.yml"), "services: {}\n# db (the model lives in the fake docker)\n");
    dx(fd, "compose", "-p", stack, "--project-directory", s.path, "-f", d("docker-compose.yml"), "up", "--no-start", "--no-build", "--pull", "never", "db");
    const c = Object.values(fd.state().container).find((x) => x.labels[L.service] === "db" && x.labels["com.docker.compose.project.working_dir"] === s.path);
    dx(fd, "start", c.id);
  }
  return s;
}
const convert = (s) => store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: "c".repeat(64) });

// The environment in operations (as relocation-end.test.js inOps): markers, stage cap in the opposite direction, network root, the
// scenario's HOME.
async function inOps(fd, s, fn) {
  return withOps(fd, async () => {
    const desired = { CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: s.root, HOME: s.home };
    const saved = Object.fromEntries(Object.keys(desired).map((k) => [k, process.env[k]]));
    try {
      for (const [k, v] of Object.entries(desired)) process.env[k] = v;
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
}

// The fake docker including the "inside" of every project container (status file of the entrypoint, cgroup.subtree_control — read via
// a `cat` that the fake redirects there; like projectbox-scenario.mjs scenario, but ONE for all projects of the test).
async function imageDocker(ctx) {
  const inside = path.join(ctx.root, `inside-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(path.join(inside, "run"), { recursive: true });
  fs.mkdirSync(path.join(inside, "sys", "fs", "cgroup"), { recursive: true });
  fs.writeFileSync(path.join(inside, "run", "cbase-projectbox.status"), "phase=ready\nnotice=DNAT set\n");
  fs.writeFileSync(path.join(inside, "sys", "fs", "cgroup", "cgroup.subtree_control"), "cpu io memory pids\n");
  const cat = path.join(inside, "fake-cat");
  fs.writeFileSync(cat, `#!/bin/sh\nexec /bin/cat '${inside}'"$1"\n`, { mode: 0o755 });
  return fakeDocker({ images: { "cbase-projectbox:latest": ID, "postgres:16": "a1".repeat(32) }, programs: { cat }, compose: MODEL });
}

// ── Compose containers in B of a converted project ───────────────────────────────────────────────────────────────────────
test("GET /api/projectbox/ops-status names the Compose containers in B of each converted project (composeInB); if ps fails, the field is null", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await imageDocker(ctx);
    const brokenDir = fs.mkdtempSync(path.join(fd.dir, "ps-broken-"));
    const broken = path.join(brokenDir, "docker");
    fs.writeFileSync(broken, `#!/bin/sh\nif [ "$1" = ps ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi\nexec "${fd.bin}" "$@"\n`, { mode: 0o755 });
    try {
      const converted = project(ctx, fd, { name: "Converted with leftover", stack: "stack1" });
      const not = project(ctx, fd, { name: "Not converted", stack: "stack2" });
      convert(converted);
      const rest = Object.values(fd.state().container).find((c) => c.labels[L.project] === "stack1");
      await inOps(fd, converted, async () => {
        const r = await json(`${ctx.base}${ROUTE}`);
        assert.ok(Array.isArray(r.composeInB), `composeInB missing: ${JSON.stringify(r)}`);
        assert.deepEqual(r.composeInB, [{ projectId: converted.projectId, name: "Converted with leftover", container: rest.name, running: true }]);
        assert.ok(r.withoutInstanceRow.some((x) => x.projectId === not.projectId), JSON.stringify(r.withoutInstanceRow));
        process.env.CBASE_DOCKER_BIN = broken;
        try {
          const k = await json(`${ctx.base}${ROUTE}`);
          assert.equal(k.composeInB, null, `ps failed, the field is not null: ${JSON.stringify(k.composeInB)}`);
          assert.ok(Array.isArray(k.withoutInstanceRow), "without docker the rest of the state is missing");
        } finally { process.env.CBASE_DOCKER_BIN = fd.bin; }
      });
    } finally { fd.cleanUp(); }
  });
});

// ── `composeInB` carries the state ────────────────────────────────────────────────────────────────────────────────────────
// `ps -a` — a stopped container in the folder of a converted project (the relocation deliberately leaves one-shot containers and containers
// with changed labels in B) stands with `running: false` next to the running one; the operator's status check separates them afterwards
// (in the operator's deploy tool, not part of this repository).
test("composeInB names running AND stopped containers of a converted project with `running`", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await imageDocker(ctx);
    try {
      const converted = project(ctx, fd, { name: "Converted with leftover", stack: "stack1" });
      convert(converted);
      // A second stack in the same folder, created and NEVER started: the stopped leftover.
      dx(fd, "compose", "-p", "stack3", "--project-directory", converted.path, "-f", path.join(converted.path, "docker-compose.yml"), "up", "--no-start", "--no-build", "--pull", "never", "db");
      const run = Object.values(fd.state().container).find((c) => c.labels[L.project] === "stack1");
      const rest = Object.values(fd.state().container).find((c) => c.labels[L.project] === "stack3");
      assert.ok(run && rest, "the seed is missing");
      await inOps(fd, converted, async () => {
        const r = await json(`${ctx.base}${ROUTE}`);
        const sorted = [...r.composeInB].sort((a, b) => a.container.localeCompare(b.container));
        const desired = [
          { projectId: converted.projectId, name: "Converted with leftover", container: run.name, running: true },
          { projectId: converted.projectId, name: "Converted with leftover", container: rest.name, running: false },
        ].sort((a, b) => a.container.localeCompare(b.container));
        assert.deepEqual(sorted, desired);
      });
    } finally { fd.cleanUp(); }
  });
});

// ── The cap of `ps` in the route is short ────────────────────────────────────────────────────────────────────────────────────
test("if `docker ps` hangs in B, the route answers at the short cap — composeInB null, withoutInstanceRow arrives; the cap lies below the deploy's curl deadline", async () => {
  assert.ok(COMPOSE_IN_B_CAP_MS > 0 && COMPOSE_IN_B_CAP_MS + 1000 <= OPS_STATUS_CURL_MAX_TIME_S * 1000,
    `cap ${COMPOSE_IN_B_CAP_MS} ms leaves no second under curl --max-time ${OPS_STATUS_CURL_MAX_TIME_S} for the rest of the response`);
  await withAgentsServer(async (ctx) => {
    const fd = await imageDocker(ctx);
    const dir = fs.mkdtempSync(path.join(fd.dir, "ps-sluggish-"));
    const marker = path.join(dir, "ps-hangs");
    const gate = path.join(dir, "gate");
    const sluggish = path.join(dir, "docker");
    fs.writeFileSync(sluggish, `#!/bin/sh\nif [ "$1" = ps ]; then : > '${marker}'; while [ ! -e '${gate}' ]; do sleep 0.05; done; fi\nexec "${fd.bin}" "$@"\n`, { mode: 0o755 });
    const warnings = [];
    const origWarn = console.warn;
    try {
      const converted = project(ctx, fd, { name: "Converted" });
      const not = project(ctx, fd, { name: "Not converted" });
      convert(converted);
      await inOps(fd, converted, async () => {
        process.env.CBASE_DOCKER_BIN = sluggish;
        console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
        try {
          const response = json(`${ctx.base}${ROUTE}`);
          await waitForTruthy(() => fs.existsSync(marker), "the route's ps hangs");
          advanceCap();
          const r = await response;
          assert.equal(r.composeInB, null, `at the cap composeInB is unknown: ${JSON.stringify(r.composeInB)}`);
          assert.ok(r.withoutInstanceRow.some((x) => x.projectId === not.projectId), `the synchronous part is missing: ${JSON.stringify(r)}`);
          const w = warnings.find((x) => x.includes("[ops-status] containers in B not readable"));
          assert.ok(w, `no warning: ${JSON.stringify(warnings)}`);
          assert.match(w, new RegExp(`cap of ${COMPOSE_IN_B_CAP_MS} ms reached`));
          assert.doesNotMatch(w, /seam default/);
        } finally {
          console.warn = origWarn;
          process.env.CBASE_DOCKER_BIN = fd.bin;
          fs.writeFileSync(gate, "");
        }
      });
    } finally { fd.cleanUp(); }
  });
});

// ── Projects without an instance row, with names; without operations 404; the fence ────────────────────────────────────────
test("withoutInstanceRow names EXACTLY the projects without an instance row with id and name; without an ops marker 404 without docker; the fence rejects the route from project networks", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await imageDocker(ctx);
    try {
      const converted = project(ctx, fd, { name: "Converted" });
      const a = project(ctx, fd, { name: "Old one" });
      const b = project(ctx, fd, { name: "Old two" });
      convert(converted);
      // Without an ops marker: 404, no docker.
      const r404 = await fetch(`${ctx.base}${ROUTE}`);
      assert.equal(r404.status, 404);
      await r404.text();
      assert.deepEqual(fd.calls(), [], "docker called without an ops marker");
      await inOps(fd, converted, async () => {
        const r = await json(`${ctx.base}${ROUTE}`);
        const without = [...r.withoutInstanceRow].sort((x, y) => x.name.localeCompare(y.name));
        // The harness workspace may carry projects of its own — only what this test created is counted, plus the statement that
        // NO converted one is among them.
        const own = without.filter((x) => [a.projectId, b.projectId, converted.projectId].includes(x.projectId));
        assert.deepEqual(own, [{ projectId: a.projectId, name: "Old one" }, { projectId: b.projectId, name: "Old two" }]);
        for (const x of r.withoutInstanceRow) assert.equal(store.projectInstance(x.projectId, "main"), null, `${x.name} has an instance row`);
        assert.deepEqual(r.composeInB, []);
      });
    } finally { fd.cleanUp(); }
  });
  const z = rowFor("GET", ROUTE);
  assert.equal(z?.row.family, "ops-status");
  assert.equal(z.row.rule, "rejected");
  assert.equal(rowFor("GET", "/api/projectbox/relocation-tick")?.row.family === "relocation-tick", false, "the row of the removed tick is still there");
});
