// The VS Code pill opens main and copies of a converted project as Dev Containers windows. The tunnel response
// (devtools/routes.js `tunnelResponse`) carries a field `projects` for that ONLY in project-box operation: per converted
// project the instances in state `ready`, with the container name from the identifier (projectbox/creation.js
// containerName — main `cbase-p-<pid>`, copy `cbase-k-<pid>-<name>`), NEVER from the DNS name.
//
// Promises:
//   - without the operation marker (local) NO field `projects` — the response keeps today's shape;
//   - in operation: only converted projects, only instances in `ready` — or a main in `start`/`create` whose container
//     already stands (phase `stage k/n`, `services`, `names`) —, no row without a project, no invalid instance;
//   - `starting`: a main that is still before that (container being created/started), without a link — only if the project
//     is not already in `projects`;
//   - the same response shape in GET and in the POST responses (stop) — the pill replaces its state with each.
// Counter-tests:
//   - `projects` emitted without asking for the operation marker => "without operation marker no field" red;
//   - filter `state === "ready"` removed => the copy in `create` is in the list, red;
//   - container name from `copyName`/DNS instead of containerName(pid, instance) => red.
//
// Run (gate environment): CBASE_LIMIT_GRACE_MS=2000 … node --test --test-reporter=tap test/vscode-projects.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { json, withAgentsServer } from "./agent-harness.mjs";

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const WITHOUT = { CBASE_CONTAINER: undefined, CBASE_DIND: undefined };
const OPS = { CBASE_CONTAINER: "1", CBASE_DIND: "1" };

test("tunnel response: projects with main and ready copies only in project-box operation, container name from the identifier", async () => {
  await withAgentsServer(async (ctx) => {
    const { base } = ctx;
    const folder = (n) => { const p = path.join(ctx.root, "workspace", n); fs.mkdirSync(p, { recursive: true }); return p; };
    const create = (name) => json(`${base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: folder(name) }) });
    const a = await create("My Check");
    const b = await create("not-converted");
    const now = Date.now();
    store.createProjectInstance({ projectId: a.id, state: "ready", convertedAt: now, containerId: "whatever-main", dnsName: "my-check.cbase" });
    store.createProjectInstance({ projectId: a.id, instance: "copy-alpha", state: "ready", chatId: ctx.chat.id, copyName: "alpha", containerId: "whatever-copy", dnsName: "alpha.my-check.cbase" });
    store.createProjectInstance({ projectId: a.id, instance: "copy-beta", state: "create", chatId: ctx.chat.id, copyName: "beta" });
    store.createProjectInstance({ projectId: b.id, state: "ready" }); // a row without convertedAt converts nothing
    store.createProjectInstance({ projectId: "gone-123", state: "ready", convertedAt: now }); // row without a project
    try {
      // Without operation marker no field — neither in the GET nor in a POST response.
      await withEnvironment(WITHOUT, async () => {
        const st = await json(`${base}/api/vscode-tunnel`);
        assert.equal(Object.hasOwn(st, "projects"), false, "without operation marker no field projects");
        assert.ok(Array.isArray(st.workspaces));
        const stop = await json(`${base}/api/vscode-tunnel/stop`, { method: "POST", body: "{}" });
        assert.equal(Object.hasOwn(stop, "projects"), false);
      });

      await withEnvironment(OPS, async () => {
        const st = await json(`${base}/api/vscode-tunnel`);
        assert.ok(Array.isArray(st.projects), "in operation projects is there");
        assert.deepEqual(st.projects.map((p) => p.id), [a.id], "only the converted project, no row without a project");
        const [p] = st.projects;
        assert.equal(p.name, "My Check");
        assert.equal(p.path, a.path);
        assert.equal(p.workspaceId, ctx.ws.id);
        assert.deepEqual(p.instances, [
          { identifier: `${a.id}/main`, kind: "main", name: null, container: `cbase-p-${a.id}`, state: "ready" },
          { identifier: `${a.id}/copy-alpha`, kind: "copy", name: "alpha", container: `cbase-k-${a.id}-alpha`, state: "ready" },
        ]);
        // The same shape in the POST response.
        const stop = await json(`${base}/api/vscode-tunnel/stop`, { method: "POST", body: "{}" });
        assert.deepEqual(stop.projects, st.projects);

        // Main not ready, copy ready: the project stays with the copy; if nothing is ready it drops out.
        store.changeProjectInstance(a.id, "main", { state: "error" });
        const onlyCopy = await json(`${base}/api/vscode-tunnel`);
        assert.deepEqual(onlyCopy.projects[0].instances.map((i) => i.identifier), [`${a.id}/copy-alpha`]);
        assert.deepEqual(st.starting, [], "nothing is starting");
        store.changeProjectInstance(a.id, "copy-alpha", { state: "clearAway" });
        assert.deepEqual((await json(`${base}/api/vscode-tunnel`)).projects, []);

        // `starting`: a main in `start` (restoration after a deploy) stands without a link, not in `projects`; if the
        // project has a ready copy it stands only in `projects`. A non-converted project is missing here too.
        store.changeProjectInstance(a.id, "main", { state: "start" });
        store.changeProjectInstance(b.id, "main", { state: "start" });
        const starts = await json(`${base}/api/vscode-tunnel`);
        assert.deepEqual(starts.projects, []);
        assert.deepEqual(starts.starting, [{ id: a.id, name: "My Check", workspaceId: ctx.ws.id, state: "start" }]);
        // If the container already stands (from the phase `stage k/n`) the main gets its link, even while the stack is still
        // starting — for VS Code the container is enough.
        store.changeProjectInstance(a.id, "main", { phase: "stage 2/3" });
        const stack = await json(`${base}/api/vscode-tunnel`);
        assert.deepEqual(stack.projects.map((p) => p.instances), [[{ identifier: `${a.id}/main`, kind: "main", name: null, container: `cbase-p-${a.id}`, state: "start" }]]);
        assert.deepEqual(stack.starting, []);
        store.changeProjectInstance(a.id, "main", { phase: "wait" });
        assert.deepEqual((await json(`${base}/api/vscode-tunnel`)).projects, [], "no link before the stages (the inner dockerd does not answer yet)");
        store.changeProjectInstance(a.id, "copy-alpha", { state: "ready" });
        const withCopy = await json(`${base}/api/vscode-tunnel`);
        assert.deepEqual([withCopy.projects.map((p) => p.id), withCopy.starting], [[a.id], []]);
      });
    } finally {
      for (const pid of [a.id, b.id, "gone-123"]) store.deleteProjectInstance(pid);
    }
  });
});
