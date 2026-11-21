// "Remove old containers": `projectbox/layout/superseded.js` and its two routes in `projectbox/layout/routes.js`, the
// `superseded` field (projectbox/setup/status.js), `projectWork` (runs/routes.js), the column `project_superseded.earmarked`
// (store/project-layout.js).
//
// WHAT HOLDS HERE, each with its counter-test (GP) in the test or its sabotage (S) at the product:
//   (a)  GET lists exactly the containers of the `project_superseded` rows with name, state and size (`inspect --size`), plus
//        volumes, network and image of the old stack with sizes from `system df -v --format {{json .}}` ("1.2MB" ⇒ 1200000); a
//        container the daemon no longer knows is listed as `missing`; a volume the NEW stack also mounts goes under `stays`
//        with a reason, not into the deletion list. GP (computed from the daemon state): by Compose label alone it would be in it.
//        Silent daemon ⇒ 409 NOT_READY, never an empty list. Without a row no docker call.
//   (b)  POST without/with an incomplete `confirmed` (also without `running`) ⇒ 400 CONFIRMATION_MISSING; 409 RELOCATION,
//        SETUP_OPEN, COPY_OPEN (with `name`), LAYOUT_OPEN (`waiting`, `running`, `error` after the turn, with `state`),
//        OCCUPIED (with `what`), NOT_READY (GET too), RUNNING (at the gate), NOT_CONVERTED. GP: `error` BEFORE the turn does not block.
//   (c)  In the log of the INNER fake docker: `stop -t 30` only for the running container, `rm <id>` without `-f`, then
//        `volume rm <name>`, `network rm <id>`, `image rm <id>` — in this order, never `-f`. A volume of the old stack that
//        appeared after the GET stays ("by name only"); a shared volume a client "confirms" anyway is not touched. What a
//        superseded container that STAYS (not confirmed) uses stays, even if confirmed.
//   (d)  A row is dropped only on `No such container` (the `missing` row and the removed ones); the row of a container that
//        was not confirmed stays. If the daemon goes silent mid-run the run ends `error` and EVERY row stays. At the seam
//        (containerById): a silent daemon and an outer "No such container: cbase-p-…" prove nothing.
//   (e)  At the gate before `stop`: `projectWork` carries `{ state: "superseded", phase: "container" }` and `busy`; only with its
//        own boot id (GP: a foreign one yields nothing); the project occupancy is "superseded"; GET says `running: true`. The
//        event `project/superseded` carries exactly type, projectId, state, since, removed, stays (plus `error` on failure) —
//        names, no ids, no labels. The field `superseded` on `/api/projects`, `/api/workspaces` and `/api/workspaces/:id`
//        counts the rows and is absent at 0.
//   (L)  computeSet, pure: a volume of its own goes into the deletion list only if anonymous (label or 64 hex digits without a
//        project label) or with the old stack's Compose default name; "fixed name", "without Compose label", "belongs to the
//        Compose project" stay; what belongs only via label or `_default` name stays ("by name only", and if the name lives
//        again: "lives again"); a foreign network of a superseded container does not belong at all; the earmark of a row whose
//        container is missing counts like a mount; an image with a name that is no build name of the old stack stays.
//   (D)(E)(G) The confirmation goes stale: a container that has been running since the GET but was not in `running` stays
//        ("running since the confirmation") with its volume — no stop, no rm. At the gate before `stop`, a STOPPED container
//        from outside holds a confirmed volume, network and image: `volume rm`/`image rm` fail at the daemon (the text goes
//        under `stays`, the regex branches run), the network stays via the FRESH read (`network rm` would not have refused for a
//        stopped one), `state: "finished"`, both rows are dropped (what is used from outside no longer belongs to the old stack).
//   (C)(F) Abort between `rm` and `volume rm` (injected error at `volume rm`), then a restart of B: the earmark is in the
//        database, `?status=1` says `{ running: false, last: null }`, GET names the ANONYMOUS and the named volume and the
//        network of the removed container (`missing`); a run that does not confirm them ends `finished` and leaves the row; a
//        second removes them, and only then is the row dropped.
//        Before that: `?status=1` carries the report with `since` = `since` of the 202 answer, without docker (also with a
//        silent daemon and with an instance that is not `ready`).
//   (S)  Schema: a table without `earmarked` gets the column at start, its rows stay (in a child process — initStore rebinds
//        the module-wide `db`, see schema-register.test.js).
//   (X)  Delete: the project and workspace paths clear `project_superseded` including the earmark.
//   (f)  Fence: fence.test.js (`/superseded/**` rejected).
//   (g)  Without server operation: both routes 404 "only in server mode".
//
// SABOTAGES AT THE PRODUCT (each turns red):
//    1. computeSet: volumes by label WITHOUT the exclusion from outside        ⇒ (a) red: "shared" is in the deletion list
//    2. run: volumes by membership instead of `confirmed`                       ⇒ (c) red: run 1 removes `old_db`
//    3. step 7: delete the rows unchecked                                       ⇒ (d) red: the row of the unconfirmed one is dropped
//    4. `stop` for every container                                              ⇒ (c) red: `stop` for the stopped one
//    5. `rm -f <id>`                                                            ⇒ (c) red at the log
//    6. the field is missing in setupFor (setup/status.js)                       ⇒ (e) red: [3,3,3] expected
//    7. the loop in runs/routes.js pushes nothing into `projectWork`            ⇒ (e) red at the gate
//    8. silent daemon ⇒ empty list instead of 409                               ⇒ (a) red: 200 with `stacks: []`
//    9. the fence line "project-superseded" dropped                             ⇒ fence.test.js red (`GET /api/projects/pA/superseded`)
//   10. supersededInWork without the boot id comparison                         ⇒ (e) red at the GP "foreign boot id"
//   11. containerById: an unnamed id counts as gone                           ⇒ (d) red at the seam (outer "No such container")
//   12. containers by membership instead of `confirmed`                         ⇒ (c) red: run 1 also removes the running one
//   13. without the guard "a standing superseded container uses it"             ⇒ (c) red: `volume rm old_data` reaches the daemon
//   14. a missing `confirmed` treated as an empty confirmation                  ⇒ (b) red: 202 instead of 400
//   15. without the COPY_OPEN check                                             ⇒ (b) red: 202 instead of 409
//   16. `foreignReason` always returns null (every own volume/network counts as Compose's own) ⇒ (L) red: "ext", "fixed", "new_x"
//       in the deletion list
//   17. the second pass puts volumes/networks into the deletion list by name only ⇒ (L) red: "old_only_label" in it
//   18. step 2a (earmarkSuperseded) dropped                                     ⇒ (C) red: "earmarked BEFORE the rm" (empty)
//   19. the comparison with `confirmed.running` dropped                         ⇒ (D) red: no "running since the confirmation"
//   20. a missing `running` as an empty list                                    ⇒ (b) red: 202 instead of 400
//   21. the fresh read before `network rm` dropped                              ⇒ (E) red: `old_default` removed despite the stopped one
//   22. `since` is missing at the end                                           ⇒ (a)–(e) red: undefined instead of `since` of the 202 answer
//   23. `?status=1` not evaluated (always the full GET)                         ⇒ (C) red: `stacks` instead of `{ running, last }`
//   24. the "in use" branch at `volume rm` dropped                              ⇒ (E) red: `error` instead of `finished`
//   25. computeSet does not read the earmark                                    ⇒ (C) red: after the restart GET names no volumes
//   26. step 7 does not ask the earmark (the row is dropped on `missing`)       ⇒ (C) red: the row was dropped in the run without confirmation
//   27. an image with a foreign name counts as its own                          ⇒ (L) red: `old-web:latest` in the deletion list
//   28. deleteLayout without the row for `project_superseded`                   ⇒ (X) red at the project path, (S) red
//   29. the ALTER of the column `earmarked` dropped                             ⇒ (S) red: "no such column: earmarked"
//
// Note: `exec` runs LOCALLY. This test starts only the fake docker itself in the project container (`docker …` against the
// inner daemon) — no lsof, no kill.
//
// Run (one file alone, with the gate time limits as in ./check):
//   env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 \
//     CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/superseded-remove.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { BOOT_ID } from "../electron/server/app-state.js";
import { containerOf } from "../electron/server/projectbox/run-instance.js";
import { occupancyOfProject, withProjectOccupancy } from "../electron/server/projectbox/instance.js";
import {
  SupersededError, MISSING, supersededEnd, supersededInWork, supersededAlive, supersededView, supersededStatus, startSuperseded,
  forgetSuperseded, containerById, computeSet,
} from "../electron/server/projectbox/layout/superseded.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { ONLY_IN_OPS_TEXT, active, request, create, dx, finished, inProject, withCreation, viewIn, gateClosed } from "./setup-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = "com.docker.compose.project";
const V = "com.docker.compose.volume";
const N = "com.docker.compose.network";
const ANON = "com.docker.volume.anonymous";
const ID_OLD = "a1".repeat(32);
const ID_WAY = "ee".repeat(32);
const empty = () => ({ container: [], running: [], volumes: [], networks: [], images: [] });
const byName = (a, b) => a.name.localeCompare(b.name);
const withoutType = ({ type: _t, ...r }) => r;

// Change the state of a fake-docker daemon under ITS lock (same build as layout-check.test.js).
function inState(fd, daemon, fn) {
  const folder = path.join(fd.dir, "daemon", encodeURIComponent(daemon));
  const lock = path.join(folder, "lock");
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== "EEXIST") throw e; }
    Atomics.wait(tick, 0, 0, 5); // lock tick, no deadline
  }
  fs.writeFileSync(path.join(lock, "holders"), String(process.pid));
  try {
    const file = path.join(folder, "state.json");
    const z = JSON.parse(fs.readFileSync(file, "utf8"));
    fn(z);
    fs.writeFileSync(`${file}.test`, JSON.stringify(z));
    fs.renameSync(`${file}.test`, file);
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// The removing calls in the inner daemon's log from `ab` on (stop, rm, volume/network/image rm).
const deleteCalls = (fd, cname, mark) => fd.calls({ daemon: cname }).slice(mark).map((x) => x.args)
  .filter((a) => a[0] === "stop" || a[0] === "rm" || a[0] === "rmi" || a[0] === "kill" || (["volume", "network", "image"].includes(a[0]) && ["rm", "remove", "prune"].includes(a[1])));

// A project in server operation with its inner docker and the route paths (for the tests in operation).
async function projectWithDocker(ctx, fd, name) {
  const proj = await create(ctx, { name, sources: [] });
  await finished(proj.id);
  const pid = proj.id;
  const cname = containerOf(store.projectInstance(pid, "main"));
  const d = (...args) => dx(fd, "exec", "-u", "agent", cname, "docker", ...args);
  return {
    pid, cname, d,
    post: (body) => inProject(ctx, pid, "/superseded/remove", { method: "POST", body }),
    fetch: () => inProject(ctx, pid, "/superseded"),
    state: () => inProject(ctx, pid, "/superseded", { query: "status=1" }),
    rows: () => store.supersededOf(pid, "main").map((z) => z.containerId).sort(),
    row: (containerId, namePrior, nameNow) => store.rememberSuperseded({ projectId: pid, containerId, namePrior, nameNow, stackPrior: "old", stackNow: "fresh" }),
    containerName: (n) => Object.values(fd.state(cname).container).find((c) => c.name === n) || null,
    imageLoad: () => {
      const images = path.join(ctx.root, `bilder-${pid}.json`);
      fs.writeFileSync(images, JSON.stringify({ fakeDockerImages: [{ ref: "old-app:latest", id: ID_OLD, labels: { [P]: "old" } }] }));
      d("image", "load", "-i", images);
    },
    // A volume or network as Compose creates it for key `k` of the old stack (`old_<k>` with both labels).
    composeVolume: (k) => d("volume", "create", "--label", `${P}=old`, "--label", `${V}=${k}`, `old_${k}`),
    composeNetwork: (k) => d("network", "create", "--label", `${P}=old`, "--label", `${N}=${k}`, `old_${k}`),
  };
}

// ── (L) the calculation, pure ──────────────────────────────────────────────────────────────────────────────────────────────

test("(L) computeSet: ownership (A), by name only (B), earmark (C), images with a foreign name, the old name lives again", () => {
  const hex = (z) => z.repeat(64);
  const row = (containerId, since, earmarked) => ({ containerId, namePrior: `old-${containerId}`, nameNow: `old-${containerId}-old`, stackPrior: "old", stackNow: "fresh", since, earmarked });
  const rows = [row("c1", 1, { volumes: [], networks: [] }), row("c9", 2, { volumes: [hex("9")], networks: ["n1"] })];
  const mounted = ["old_own", "fixed", "ext", "new_x", hex("a"), hex("b")];
  const raw = new Map([
    ["c1", { Id: "c1", Name: "/old-c1-old", State: { Status: "exited" }, SizeRw: 10, Mounts: mounted.map((Name) => ({ Type: "volume", Name })), NetworkSettings: { Networks: { old_default: {}, proxy: {} } } }],
    ["c9", MISSING],
  ]);
  const superseded = { id: "c1", name: "old-c1-old", labels: { [P]: "old" }, mounts: mounted.map((name) => ({ type: "volume", name })), networks: ["old_default", "proxy"], imageId: "sha256:i1" };
  const live = { id: "c2", name: "old-app-1", labels: { [P]: "old" }, mounts: [], networks: [], imageId: "" };
  const inv = (container) => ({
    container,
    volumes: [
      { name: "old_own", labels: { [P]: "old", [V]: "own" }, size: 5 }, // (2) Compose's default name
      { name: "old_only_label", labels: { [P]: "old", [V]: "only_label" }, size: 7 }, // B: nobody mounts it
      { name: "fixed", labels: { [P]: "old", [V]: "data" }, size: 1 }, // `name: fixed`
      { name: "ext", labels: {}, size: 1 }, // by hand or `external`
      { name: "new_x", labels: { [P]: "fresh", [V]: "x" }, size: 1 }, // of another project
      { name: hex("a"), labels: { [ANON]: "" }, size: 2 }, // (1) anonymous, dockerd ≥ 23
      { name: hex("b"), labels: {}, size: 3 }, // (1) anonymous, dockerd 20.10
      { name: hex("9"), labels: { [ANON]: "" }, size: 4 }, // C: only via the earmark of the missing row
    ],
    networks: [
      { id: "n1", name: "old_default", labels: { [P]: "old", [N]: "default" } },
      { id: "n2", name: "old_free", labels: { [P]: "old", [N]: "free" } }, // B: nobody is attached
      { id: "n3", name: "proxy", labels: { [P]: "proxy", [N]: "default" } }, // does not belong at all
    ],
    images: [
      { id: "sha256:i1", tags: ["old-app:latest"], size: null, labels: { [P]: "old" } },
      { id: "sha256:i2", tags: ["ohne:1"], size: 3, labels: null },
      { id: "sha256:i3", tags: ["old-web:latest", "new-web:latest"], size: 9, labels: { [P]: "old" } }, // retagged for "new"
    ],
  });
  const m = computeSet(rows, raw, inv([superseded]));
  assert.equal(m.stacks.length, 1);
  const s = m.stacks[0];
  assert.deepEqual(s.container.map((c) => [c.id, c.state]), [["c1", "exited"], ["c9", "missing"]]);
  assert.deepEqual(s.volumes.map((v) => v.name).sort(), ["old_own", hex("a"), hex("b"), hex("9")].sort(), "(A) Compose's own and anonymous, (C) the earmarked one of the missing row");
  assert.deepEqual(s.networks, [{ id: "n1", name: "old_default" }]);
  assert.deepEqual(s.images, [{ id: "sha256:i1", name: "old-app:latest", size: null }], "an image without readable labels never, one with a foreign name stays");
  const reason = Object.fromEntries(m.stays.map((b) => [`${b.kind}:${b.name}`, b.reason]));
  assert.deepEqual(Object.keys(reason).sort(), ["image:old-web:latest", "network:old_free", "volume:ext", "volume:fixed", "volume:new_x", "volume:old_only_label"]);
  assert.match(reason["volume:fixed"], /^fester Name — kann ein anderer Stack benutzen$/);
  assert.match(reason["volume:ext"], /^ohne Compose-Label angelegt — kann ein anderer Stack benutzen \(external\)$/);
  assert.match(reason["volume:new_x"], /^gehört dem Compose-Projekt „fresh“$/);
  assert.match(reason["volume:old_only_label"], /^nur über den Namen zugeordnet — der Stack-Name kann wieder leben$/);
  assert.match(reason["network:old_free"], /^nur über den Namen zugeordnet/);
  assert.match(reason["image:old-web:latest"], /^trägt auch den Namen „new-web:latest“ — ein anderer Stack kann es benutzen$/);
  assert.ok(!m.stays.some((b) => b.name === "proxy"), "a foreign network of a superseded container does not belong at all");
  assert.deepEqual(m.total, { bytes: 10 + 5 + 2 + 3 + 4, withoutSize: 1 });

  // The old name lives again (a container OUTSIDE the set carries the same Compose project): what belongs only by name stays
  // with this reason; what a superseded container mounts still belongs.
  const l = computeSet(rows, raw, inv([superseded, live]));
  assert.deepEqual(l.stacks[0].volumes.map((v) => v.name).sort(), ["old_own", hex("a"), hex("b"), hex("9")].sort(), "mounted belongs, even if the name lives again");
  for (const k of ["volume:old_only_label", "network:old_free", "image:old-app:latest"]) {
    const b = l.stays.find((x) => `${x.kind}:${x.name}` === k);
    assert.match(b?.reason || "", /lebt wieder.*old-app-1/, k);
  }
  assert.deepEqual(l.stacks[0].images, []);

  // C without earmark: the anonymous volume of the missing row belongs to nothing — it would be listed nowhere (the GP of the earmark).
  const withoutEarmarking = computeSet(rows.map((z) => ({ ...z, earmarked: { volumes: [], networks: [] } })), raw, inv([superseded]));
  assert.ok(!withoutEarmarking.stacks[0].volumes.some((v) => v.name === hex("9")) && !withoutEarmarking.stays.some((b) => b.name === hex("9")));
});

// ── (S) schema: the column `earmarked` on an older table ─────────────────────────────────────────────────

test("(S) a table `project_superseded` without `earmarked` gets the column at start, its rows stay (child process)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-superseded-schema-"));
  try {
    const script = `
      import { DatabaseSync } from "node:sqlite";
      import path from "node:path";
      const dir = process.argv[1];
      const old = new DatabaseSync(path.join(dir, "automater.db"));
      old.exec("CREATE TABLE project_superseded (project_id TEXT NOT NULL, instance TEXT NOT NULL DEFAULT 'main', container_id TEXT NOT NULL, name_prior TEXT NOT NULL DEFAULT '', name_now TEXT NOT NULL DEFAULT '', stack_prior TEXT NOT NULL DEFAULT '', stack_now TEXT NOT NULL DEFAULT '', since INTEGER NOT NULL, PRIMARY KEY (project_id, instance, container_id))");
      old.exec("INSERT INTO project_superseded (project_id, container_id, name_prior, stack_prior, stack_now, since) VALUES ('p1', 'c1', 'old-app-1', 'old', 'fresh', 1)");
      old.close();
      const store = await import(${JSON.stringify(path.join(HERE, "../electron/server/store.js"))});
      store.initStore(dir);
      const prior = store.supersededOf("p1", "main");
      const present = store.earmarkSuperseded("p1", "main", "c1", { volumes: ["old_data", "old_data", ""], networks: ["n1"] });
      const after = store.supersededOf("p1", "main");
      store.initStore(dir); // a second start: the column exists already
      const again = store.supersededOf("p1", "main");
      store.deleteLayout("p1");
      console.log(JSON.stringify({ prior, present, after, again, afterwards: store.supersededOf("p1", "main") }));
    `;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, dir], { encoding: "utf8", env }).trim().split("\n").pop());
    assert.deepEqual(out.prior.map((z) => [z.containerId, z.stackPrior, z.earmarked]), [["c1", "old", { volumes: [], networks: [] }]], "the old row stays, without earmark");
    assert.equal(out.present, true);
    assert.deepEqual(out.after[0].earmarked, { volumes: ["old_data"], networks: ["n1"] }, "duplicates and empty entries are dropped on write");
    assert.deepEqual(out.again[0].earmarked, { volumes: ["old_data"], networks: ["n1"] });
    assert.deepEqual(out.afterwards, [], "the delete path removes the row including the earmark");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── (g) Without server operation ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(g) without server operation: GET …/superseded (also ?status=1) and POST …/superseded/remove answer 404 \"only in server mode\"", async () => {
  await withAgentsServer(async (ctx) => {
    const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Old", path: path.join(ctx.root, "workspace", "old") } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    for (const [method, sub, body, query] of [["GET", "/superseded"], ["GET", "/superseded", undefined, "status=1"], ["POST", "/superseded/remove", { confirmed: empty() }]]) {
      const x = await inProject(ctx, r.body.id, sub, { method, body, query });
      assert.equal(x.status, 404, `${method} ${sub} ${query || ""}`);
      assert.match(x.body.error, ONLY_IN_OPS_TEXT, `${method} ${sub}`);
    }
  });
});

// ── (a)–(e) in server operation ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(a)–(e) inventory, refusals, run by id, rows only on \"No such container\", projectWork at the gate, event and field", async () => {
  await withCreation(async ({ ctx, fd, reader }) => {
    fd.openGate("stop"); // setup and seeding stop nothing at the gate
    const cfg = path.join(fd.dir, "config.json");
    const config = (fields) => fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), ...fields }));
    let pid = null;
    try {
      const pr = await projectWithDocker(ctx, fd, "Superseded");
      pid = pr.pid;
      const { cname, d, post, fetch, state, rows, row, containerName } = pr;
      const reports = () => reader.events.filter((e) => e.type === "project/superseded" && e.projectId === pid);
      const report = (n) => waitForTruthy(() => reports()[n - 1], `report ${n} of the removal`);
      const field = async () => {
        const projects = (await request(`${ctx.base}/api/projects`)).body;
        const list = (await request(`${ctx.base}/api/workspaces`)).body;
        const inWs = (await viewIn(ctx, pid)) || {};
        const fromList = list.find((w) => w.id === ctx.ws.id)?.projects?.find((p) => p.id === pid) || {};
        const fromProjects = projects.find((p) => p.id === pid) || {};
        return [fromProjects, fromList, inWs].map((p) => ("superseded" in p ? p.superseded : "missing"));
      };
      const insideState = () => fd.state(cname);

      assert.deepEqual(await field(), ["missing", "missing", "missing"], "(e) without a row no field");

      // The old stack "old" (renamed to "new"): two renamed containers, one restarted by hand (running), one stopped; their
      // volumes and the network as Compose creates them (`old_<key>` with both labels), the image with the label. The new
      // stack also mounts the volume "shared".
      pr.imageLoad();
      for (const k of ["data", "db"]) pr.composeVolume(k);
      d("volume", "create", "--label", `${P}=old`, "--label", `${V}=shared`, "shared"); // `name: shared` in both stacks
      const oldNetwork = pr.composeNetwork("default");
      d("network", "create", "--label", `${P}=new`, "new_default");
      const idApp = d("run", "-d", "--name", "old-app-1-old-aaaa", "--network", "old_default", "--label", `${P}=old`,
        "--mount", "type=volume,source=old_data,target=/data", "--mount", "type=volume,source=shared,target=/shared", "old-app:latest");
      const idDb = d("run", "-d", "--name", "old-db-1-old-bbbb", "--network", "old_default", "--label", `${P}=old`,
        "--mount", "type=volume,source=old_db,target=/db", "alpine:3");
      d("stop", idDb);
      const idNew = d("run", "-d", "--name", "new-app-1", "--network", "new_default", "--label", `${P}=new`, "--mount", "type=volume,source=shared,target=/shared", "alpine:3");
      inState(fd, cname, (z) => {
        z.volumes.old_data.size = 1234567;
        Object.values(z.images).find((b) => b.id === ID_OLD).size = 5_000_000;
        Object.values(z.container).find((c) => c.id === idApp).size = 4096;
      });
      row(idApp, "old-app-1", "old-app-1-old-aaaa");
      row(idDb, "old-db-1", "old-db-1-old-bbbb");
      row(ID_WAY, "old-way-1", "old-way-1-old-cccc");
      assert.deepEqual(await field(), [3, 3, 3], "(e) the field counts the rows");

      // ── (a) GET ──────────────────────────────────────────────────────────────────────────────────────────────────────
      const g = await fetch();
      assert.equal(g.status, 200, JSON.stringify(g.body));
      assert.deepEqual(Object.keys(g.body).sort(), ["running", "stacks", "stays", "total"]);
      assert.equal(g.body.stacks.length, 1);
      const s = g.body.stacks[0];
      assert.deepEqual([s.stackPrior, s.stackNow, Number.isFinite(s.since)], ["old", "fresh", true]);
      assert.deepEqual([...s.container].sort(byName), [
        { id: idApp, name: "old-app-1-old-aaaa", state: "running", size: 4096 },
        { id: idDb, name: "old-db-1-old-bbbb", state: "exited", size: 0 },
        { id: ID_WAY, name: "old-way-1-old-cccc", state: "missing", size: null },
      ]);
      assert.deepEqual([...s.volumes].sort(byName), [{ name: "old_data", size: 1200000 }, { name: "old_db", size: 0 }], "sizes from the {{json .}} lines of system df");
      assert.deepEqual(s.networks, [{ id: oldNetwork, name: "old_default" }]);
      assert.deepEqual(s.images, [{ id: `sha256:${ID_OLD}`, name: "old-app:latest", size: 5000000 }], "image size via system df (inspect carries none)");
      assert.deepEqual(g.body.stays.map((b) => [b.kind, b.name]), [["volume", "shared"]]);
      assert.match(g.body.stays[0].reason, /„new-app-1“ benutzt/);
      assert.deepEqual(g.body.total, { bytes: 4096 + 1200000 + 5000000, withoutSize: 0 });
      assert.equal(g.body.running, false);
      // GP: by Compose label alone (computed from the daemon state) "shared" would be in the deletion list.
      const onlyLabel = Object.values(insideState().volumes).filter((v) => v.labels?.[P] === "old").map((v) => v.name).sort();
      assert.deepEqual(onlyLabel, ["old_data", "old_db", "shared"], "GP: the label alone would take \"shared\" along");

      // (a) Silent daemon ⇒ 409 NOT_READY, no list — `?status=1` still answers (F: without docker).
      config({ execBroken: [cname] });
      const silent = await fetch();
      const statusSilent = await state();
      config({ execBroken: [] });
      assert.deepEqual([silent.status, silent.body.code], [409, "NOT_READY"], JSON.stringify(silent.body));
      assert.ok(!("stacks" in silent.body), "never an empty list");
      assert.match(silent.body.error, /antwortet nicht/);
      assert.deepEqual([statusSilent.status, statusSilent.body], [200, { running: false, last: null }], "(F) without docker, without report: null");

      // ── (b) the refusals ─────────────────────────────────────────────────────────────────────────────────────────────
      const { running: _l, ...withoutRunning } = empty();
      for (const body of [undefined, {}, { confirmed: null }, { confirmed: [] }, { confirmed: { container: [], running: [], volumes: [], networks: [] } },
        { confirmed: { ...empty(), images: [1] } }, { confirmed: { ...empty(), volumes: [""] } }, { confirmed: { ...empty(), networks: "x" } },
        { confirmed: withoutRunning }, { confirmed: { ...empty(), running: "x" } }, { confirmed: { ...empty(), running: [7] } }]) {
        const r = await post(body);
        assert.deepEqual([r.status, r.body?.code], [400, "CONFIRMATION_MISSING"], `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      }
      const no = async (code, fields = {}) => {
        const r = await post({ confirmed: empty() });
        assert.deepEqual([r.status, r.body?.code], [409, code], JSON.stringify(r.body));
        for (const [k, v] of Object.entries(fields)) assert.equal(r.body[k], v, `${code}.${k}`);
        assert.equal(supersededAlive(pid), false, `${code}: no run`);
      };
      const relocation = store.createRelocation({ projectId: pid, location: "/relocation/superseded-test" });
      try { await no("RELOCATION"); } finally { store.deleteRelocation(relocation.id); }
      store.createSetup({ projectId: pid, sources: [], codeRepos: [] });
      try { await no("SETUP_OPEN"); } finally { store.deleteSetup(pid); }
      const copy = store.createStackCopy({ projectId: pid, name: "k1", chatId: ctx.chat.id, state: "error" });
      try { await no("COPY_OPEN", { name: "k1" }); } finally { store.changeStackCopy(copy.id, { state: "removed" }); }
      store.createLayout({ projectId: pid, plan: { finalMapping: { ways: [{ old: "old", fresh: "fresh" }], way: [] } }, confirmed: {}, since: Date.now() });
      await no("LAYOUT_OPEN", { state: "waiting" });
      store.layoutSet(pid, { state: "running" });
      await no("LAYOUT_OPEN", { state: "running" });
      store.layoutSet(pid, { state: "error", turned: true, error: "Test" });
      await no("LAYOUT_OPEN", { state: "error" });
      store.layoutSet(pid, { turned: false }); // GP: `error` BEFORE the turn does not block — the run (d) below runs like this
      let go;
      const hold = new Promise((r) => { go = r; });
      const foreign = withProjectOccupancy(pid, "erase", () => hold);
      try { await no("OCCUPIED", { what: "erase" }); } finally { go(); await foreign; }
      store.changeProjectInstance(pid, "main", { state: "error", error: "Test" });
      try {
        await no("NOT_READY");
        const gNot = await fetch();
        assert.deepEqual([gNot.status, gNot.body.code], [409, "NOT_READY"], JSON.stringify(gNot.body));
        assert.equal((await state()).status, 200, "(F) the status needs no ready instance");
      } finally { store.changeProjectInstance(pid, "main", { state: "ready", error: "" }); }
      assert.deepEqual([startSuperseded("exists-not", { confirmed: empty() }).status, startSuperseded("exists-not", { confirmed: empty() }).body.code], [409, "NOT_CONVERTED"]);
      await assert.rejects(supersededView("exists-not"), (e) => e instanceof SupersededError && e.code === "NOT_CONVERTED");
      assert.throws(() => supersededStatus("exists-not"), (e) => e instanceof SupersededError && e.code === "NOT_CONVERTED");
      assert.deepEqual(rows(), [idApp, idDb, ID_WAY].sort(), "no refusal changed anything");

      // ── (c)(d) run 1: only the stopped container confirmed (layout in `error` before the turn) ─────────────────────
      let mark = fd.calls({ daemon: cname }).length;
      // Confirmed: the stopped container plus the volume and network that the NOT confirmed (remaining) container uses.
      const r1 = await post({ confirmed: { ...empty(), container: [idDb], volumes: ["old_data"], networks: [oldNetwork] } });
      assert.equal(r1.status, 202, JSON.stringify(r1.body));
      assert.deepEqual([r1.body.ok, Number.isFinite(r1.body.since)], [true, true]);
      await supersededEnd(pid);
      const b1 = await report(1);
      store.deleteLayoutJob(pid);
      assert.equal(b1.state, "finished", JSON.stringify(b1));
      assert.equal(b1.since, r1.body.since, "(F) `since` of the end = `since` of the 202 response");
      assert.deepEqual(b1.removed, { container: ["old-db-1-old-bbbb"], volumes: [], networks: [], images: [], bytes: 0 });
      assert.deepEqual(b1.stays.map((b) => [b.kind, b.name]).sort(), [
        ["container", "old-app-1-old-aaaa"], ["image", "old-app:latest"], ["network", "old_default"], ["volume", "old_data"], ["volume", "old_db"], ["volume", "shared"],
      ].sort());
      assert.match(b1.stays.find((b) => b.name === "old-app-1-old-aaaa").reason, /nicht bestätigt/);
      assert.match(b1.stays.find((b) => b.name === "old_db").reason, /nicht bestätigt/);
      for (const n of ["old_data", "old_default"]) assert.match(b1.stays.find((b) => b.name === n).reason, /„old-app-1-old-aaaa“ benutzt/, `${n}: confirmed, but used by the remaining container`);
      assert.deepEqual(deleteCalls(fd, cname, mark), [["rm", idDb]], "(c) no stop for the stopped one, rm without -f; volume and network of the remaining one never touched");
      assert.deepEqual(rows(), [idApp], "(d) the rows of idDb (removed; its earmarked network is carried by the remaining one's row) and of the missing one are dropped, the unconfirmed one's stays");
      assert.equal(containerName("old-db-1-old-bbbb"), null);
      assert.equal(containerName("old-app-1-old-aaaa")?.status, "running");
      assert.deepEqual(await field(), [1, 1, 1]);
      const gAfter = await fetch();
      assert.equal(gAfter.body.last?.state, "finished", "GET carries the last report");
      assert.deepEqual((await state()).body, { running: false, last: withoutType(b1) }, "(F) ?status=1 carries the same report");
      // B: `old_db` was not confirmed; its container is gone — it hangs on no superseded container and no earmark any more.
      assert.match(gAfter.body.stays.find((b) => b.name === "old_db")?.reason || "", /^nur über den Namen zugeordnet/);
      assert.ok(!gAfter.body.stacks[0].volumes.some((v) => v.name === "old_db"));

      // ── (e)(d) run 2: at the gate before `stop`; then the daemon goes silent ⇒ `error`, the row stays ────────────────────
      gateClosed(fd, "stop");
      mark = fd.calls({ daemon: cname }).length;
      const r2 = await post({ confirmed: { ...empty(), container: [idApp], running: [idApp] } });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      await fd.gateReached("stop");
      const run = await active(ctx.base);
      assert.ok(run.projectWork.some((x) => x.projectId === pid && x.instance === "main" && x.state === "superseded" && x.phase === "container"), JSON.stringify(run.projectWork));
      assert.equal(run.busy, true);
      assert.deepEqual(supersededInWork(BOOT_ID).map((x) => x.projectId), [pid]);
      assert.deepEqual(supersededInWork("one-foreign-boot-id"), [], "GP: a foreign boot id does not see the run");
      assert.equal(occupancyOfProject(pid)?.what, "superseded");
      const r3 = await post({ confirmed: { ...empty(), container: [idApp], running: [idApp] } });
      assert.deepEqual([r3.status, r3.body.code], [409, "RUNNING"], JSON.stringify(r3.body));
      assert.equal((await fetch()).body.running, true);
      config({ execBroken: [cname] });
      assert.deepEqual((await state()).body, { running: true, last: withoutType(b1) }, "(F) during the run, with a silent daemon: running and the previous report");
      fd.openGate("stop");
      await supersededEnd(pid);
      config({ execBroken: [] });
      const b2 = await report(2);
      assert.equal(b2.state, "error", JSON.stringify(b2));
      assert.equal(b2.since, r2.body.since);
      assert.deepEqual(b2.removed, { container: [], volumes: [], networks: [], images: [], bytes: 0 });
      assert.match(b2.error, /„container“ scheiterte/);
      assert.deepEqual(Object.keys(b2).sort(), ["error", "projectId", "removed", "since", "state", "stays", "type"]);
      assert.deepEqual(deleteCalls(fd, cname, mark), [["stop", "-t", "30", idApp]], "(c) stop -t 30 for the running one; the rm did not reach the silent daemon");
      assert.deepEqual(rows(), [idApp], "(d) silent daemon: the row stays");
      assert.ok(!(await active(ctx.base)).projectWork.some((x) => x.projectId === pid), "no longer in projectWork after the end");
      assert.equal(occupancyOfProject(pid), null);
      d("start", idApp); // restarted by hand
      fd.openGate("stop");

      // ── (c)(d)(e) run 3: everything from the confirmation confirmed; then a volume of the old stack appears ─────────────────
      const g3 = await fetch();
      assert.equal(g3.status, 200, JSON.stringify(g3.body));
      const s3 = g3.body.stacks[0];
      assert.deepEqual(s3.container.map((c) => [c.id, c.state]), [[idApp, "running"]]);
      // The client also "confirms" what is under `stays` (shared, old_db) — it is not touched anyway.
      const confirmed = {
        container: s3.container.map((c) => c.id), running: s3.container.filter((c) => c.state === "running").map((c) => c.id),
        volumes: [...s3.volumes.map((v) => v.name), "shared", "old_db"], networks: s3.networks.map((n) => n.id), images: s3.images.map((i) => i.id),
      };
      d("volume", "create", "--label", `${P}=old`, "--label", `${V}=new`, "old_new"); // after the confirmation
      mark = fd.calls({ daemon: cname }).length;
      const r4 = await post({ confirmed });
      assert.equal(r4.status, 202, JSON.stringify(r4.body));
      await supersededEnd(pid);
      const b3 = await report(3);
      assert.deepEqual(Object.keys(b3).sort(), ["projectId", "removed", "since", "state", "stays", "type"], "(e) only current fields");
      assert.equal(b3.state, "finished", JSON.stringify(b3));
      assert.deepEqual(b3.removed, { container: ["old-app-1-old-aaaa"], volumes: ["old_data"], networks: ["old_default"], images: ["old-app:latest"], bytes: 4096 + 1200000 + 5000000 });
      assert.deepEqual(b3.stays.map((b) => [b.kind, b.name]).sort(), [["volume", "old_db"], ["volume", "old_new"], ["volume", "shared"]]);
      assert.match(b3.stays.find((b) => b.name === "old_new").reason, /^nur über den Namen zugeordnet/);
      assert.match(b3.stays.find((b) => b.name === "shared").reason, /„new-app-1“ benutzt/);
      const text = JSON.stringify(b3);
      for (const value of [idApp, ID_OLD, oldNetwork, P]) assert.ok(!text.includes(value), `(e) the event carries no ids and no labels: ${value}`);
      const l3 = deleteCalls(fd, cname, mark);
      assert.deepEqual(l3, [["stop", "-t", "30", idApp], ["rm", idApp], ["volume", "rm", "old_data"], ["network", "rm", oldNetwork], ["image", "rm", `sha256:${ID_OLD}`]]);
      assert.ok(!l3.flat().some((a) => a === "-f" || a === "--force"), "nie -f");
      assert.deepEqual(rows(), [], "(d) the row is dropped — the daemon no longer knows the container, its earmark is gone");
      const z = insideState();
      assert.deepEqual(Object.keys(z.volumes).sort(), ["old_db", "old_new", "shared"], "only what was confirmed and belongs fell");
      assert.equal(containerName("new-app-1")?.status, "running", "the new stack runs untouched");
      assert.equal(containerName("old-app-1-old-aaaa"), null);
      assert.ok(!Object.values(z.networks).some((n) => n.name === "old_default") && Object.values(z.networks).some((n) => n.name === "new_default"));
      assert.ok(!Object.values(z.images).some((b) => b.id === ID_OLD));
      assert.deepEqual(await field(), ["missing", "missing", "missing"], "(e) at 0 no field");

      // (a) Without a row no docker call: the list is empty because the database says so.
      mark = fd.calls({ daemon: cname }).length;
      const g4 = await fetch();
      assert.deepEqual([g4.status, g4.body.stacks, g4.body.stays, g4.body.total, g4.body.running], [200, [], [], { bytes: 0, withoutSize: 0 }, false]);
      assert.equal(g4.body.last?.state, "finished");
      assert.ok(!fd.calls({ daemon: cname }).slice(mark).some((x) => x.args[0] === "inspect" && x.args.includes("--size")), "no inspect without a row");

      // (d) The "gone" rule of step 7 at the seam itself: only a message naming EXACTLY this id is proof.
      const gone = await containerById(cname, [idApp, ID_WAY, idNew]);
      assert.deepEqual([gone.get(idApp), gone.get(ID_WAY), gone.get(idNew)?.Name], [MISSING, MISSING, "/new-app-1"]);
      await assert.rejects(containerById(`cbase-p-exists-not-${pid}`, [idApp]), /neither read nor reported as unknown/, "an outer \"No such container\" proves nothing about the inner ones");
      config({ execBroken: [cname] });
      try { await assert.rejects(containerById(cname, [idApp]), /OCI runtime exec failed/, "a silent daemon proves nothing"); } finally { config({ execBroken: [] }); }
    } finally {
      config({ execBroken: [] });
      fd.openGate("stop");
      if (pid) await supersededEnd(pid);
      if (pid) store.deleteLayoutJob(pid);
      forgetSuperseded();
    }
  }, { fdOpts: { stopGate: "stop", checkUsed: true }, environment: () => ({ CBASE_LAYOUT_CHECK_BACK_MS: "3600000" }) });
});

// ── (D)(E)(G) the confirmation goes stale ───────────────────────────────────────────────────────────────────────────────────

test("(D)(E)(G) started since the confirmation ⇒ stays; at the gate a stopped container from outside holds volume, network and image ⇒ daemon text or fresh read, finished", async () => {
  await withCreation(async ({ ctx, fd }) => {
    fd.openGate("stop");
    let pid = null;
    try {
      const pr = await projectWithDocker(ctx, fd, "Stale");
      pid = pr.pid;
      const { cname, d, post, fetch, state, rows, row, containerName } = pr;
      pr.imageLoad();
      for (const k of ["data", "db"]) pr.composeVolume(k);
      const oldNetwork = pr.composeNetwork("default");
      const idApp = d("run", "-d", "--name", "old-app-1-old-aaaa", "--network", "old_default", "--mount", "type=volume,source=old_data,target=/data", "old-app:latest");
      const idDb = d("run", "-d", "--name", "old-db-1-old-bbbb", "--network", "old_default", "--label", `${P}=old`, "--mount", "type=volume,source=old_db,target=/db", "alpine:3");
      d("stop", idDb);
      row(idApp, "old-app-1", "old-app-1-old-aaaa");
      row(idDb, "old-db-1", "old-db-1-old-bbbb");
      const g = await fetch();
      assert.equal(g.status, 200, JSON.stringify(g.body));
      assert.deepEqual([...g.body.stacks[0].container].sort(byName).map((c) => [c.id, c.state]), [[idApp, "running"], [idDb, "exited"]]);

      // (D) The client showed idDb stopped (`running` empty); before the POST somebody starts it by hand.
      d("start", idDb);
      let mark = fd.calls({ daemon: cname }).length;
      const r1 = await post({ confirmed: { ...empty(), container: [idDb], volumes: ["old_db"] } });
      assert.equal(r1.status, 202, JSON.stringify(r1.body));
      await supersededEnd(pid);
      const e1 = (await state()).body.last;
      assert.deepEqual([e1?.state, e1?.since], ["finished", r1.body.since], JSON.stringify(e1));
      assert.match(e1.stays.find((b) => b.kind === "container" && b.name === "old-db-1-old-bbbb")?.reason || "", /^läuft seit der Rückfrage$/);
      assert.match(e1.stays.find((b) => b.name === "old_db")?.reason || "", /„old-db-1-old-bbbb“ benutzt/, "its volume stays with it");
      assert.deepEqual(e1.removed, { container: [], volumes: [], networks: [], images: [], bytes: 0 });
      assert.deepEqual(deleteCalls(fd, cname, mark), [], "(D) neither stop nor rm — GP: without the comparison with `running` the run would stop it");
      assert.equal(containerName("old-db-1-old-bbbb")?.status, "running");
      assert.deepEqual(rows(), [idApp, idDb].sort());
      d("stop", idDb);

      // (E)(G) Everything confirmed; at the gate before `stop` a STOPPED container appears from outside that mounts the volume,
      // is attached to the network and comes from the image (`run` without -d: created, ran, ended — a `stop` would itself wait at the gate).
      const g2 = await fetch();
      const s2 = g2.body.stacks[0];
      const best = {
        container: s2.container.map((c) => c.id), running: s2.container.filter((c) => c.state === "running").map((c) => c.id),
        volumes: s2.volumes.map((v) => v.name), networks: s2.networks.map((n) => n.id), images: s2.images.map((i) => i.id),
      };
      assert.deepEqual([best.running, best.volumes.sort(), best.networks, best.images], [[idApp], ["old_data", "old_db"], [oldNetwork], [`sha256:${ID_OLD}`]]);
      gateClosed(fd, "stop");
      mark = fd.calls({ daemon: cname }).length;
      const r2 = await post({ confirmed: best });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      await fd.gateReached("stop");
      d("run", "--name", "foreign-1", "--label", `${P}=foreign`, "--network", "old_default", "--mount", "type=volume,source=old_data,target=/d", "old-app:latest");
      assert.equal(containerName("foreign-1")?.status, "exited");
      fd.openGate("stop");
      await supersededEnd(pid);
      const e2 = (await state()).body.last;
      assert.deepEqual([e2?.state, e2?.since], ["finished", r2.body.since], JSON.stringify(e2));
      assert.deepEqual([...e2.removed.container].sort(), ["old-app-1-old-aaaa", "old-db-1-old-bbbb"]);
      assert.deepEqual([e2.removed.volumes, e2.removed.networks, e2.removed.images], [["old_db"], [], []]);
      const reason = Object.fromEntries(e2.stays.map((b) => [`${b.kind}:${b.name}`, b.reason]));
      assert.match(reason["volume:old_data"] || "", /^docker volume rm: .*volume is in use/, "(G) the daemon text of the \"in use\" branch");
      assert.match(reason["image:old-app:latest"] || "", /^docker image rm: .*being used by container/, "(G) the daemon text of the \"being used\" branch");
      assert.match(reason["network:old_default"] || "", /^wird von „foreign-1“ benutzt$/, "(E) the fresh read — `network rm` would not have refused for a stopped one");
      const l2 = deleteCalls(fd, cname, mark);
      assert.ok(!l2.some((a) => a[0] === "network"), `(E) no network rm: ${JSON.stringify(l2)}`);
      assert.ok(l2.some((a) => a[0] === "volume" && a[2] === "old_data") && l2.some((a) => a[0] === "image"), "(G) volume rm and image rm reached the daemon");
      assert.deepEqual(rows(), [], "both rows are dropped: what is used from outside no longer belongs to the old stack, old_db is gone");
      const z = fd.state(cname);
      assert.ok(Object.values(z.networks).some((n) => n.name === "old_default") && "old_data" in z.volumes && !("old_db" in z.volumes));
    } finally {
      fd.openGate("stop");
      if (pid) await supersededEnd(pid);
      forgetSuperseded();
    }
  }, { fdOpts: { stopGate: "stop", checkUsed: true }, environment: () => ({ CBASE_LAYOUT_CHECK_BACK_MS: "3600000" }) });
});

// ── (C)(F) abort between rm and volume rm, then restart ────────────────────────────────────────────────────────────

test("(C)(F) abort between `rm` and `volume rm`, then restart: the earmark carries the volumes of the removed container, only then is the row dropped", async () => {
  await withCreation(async ({ ctx, fd }) => {
    fd.openGate("stop");
    let pid = null;
    try {
      const pr = await projectWithDocker(ctx, fd, "Abort");
      pid = pr.pid;
      const { cname, d, post, fetch, state, rows, row, containerName } = pr;
      pr.imageLoad();
      const anon = "c3".repeat(32); // this is how dockerd ≥ 23 creates an anonymous volume
      d("volume", "create", "--label", `${ANON}=`, anon);
      pr.composeVolume("data");
      const oldNetwork = pr.composeNetwork("default");
      const idX = d("run", "-d", "--name", "old-app-1-old-xxxx", "--network", "old_default",
        "--mount", `type=volume,source=${anon},target=/anon`, "--mount", "type=volume,source=old_data,target=/data", "old-app:latest");
      row(idX, "old-app-1", "old-app-1-old-xxxx");
      const g = await fetch();
      assert.equal(g.status, 200, JSON.stringify(g.body));
      const s = g.body.stacks[0];
      assert.deepEqual(s.volumes.map((v) => v.name).sort(), ["old_data", anon].sort(), "(A) the anonymous and the Compose-own one");
      const best = { container: [idX], running: [idX], volumes: s.volumes.map((v) => v.name), networks: [oldNetwork], images: [`sha256:${ID_OLD}`] };

      // Abort between step 3 and 4: `volume rm` fails with an error no rule knows.
      fd.errorAt([{ daemon: cname, pattern: "^volume rm" }]);
      const r1 = await post({ confirmed: best });
      assert.equal(r1.status, 202, JSON.stringify(r1.body));
      await supersededEnd(pid);
      fd.errorAt([]);
      const st1 = (await state()).body;
      assert.deepEqual([st1.running, st1.last?.state, st1.last?.since], [false, "error", r1.body.since], JSON.stringify(st1));
      assert.match(st1.last.error, /„volumes“ scheiterte/);
      assert.equal(containerName("old-app-1-old-xxxx"), null, "the container is gone");
      assert.ok(anon in fd.state(cname).volumes && "old_data" in fd.state(cname).volumes, "its volumes are still there");
      assert.deepEqual(rows(), [idX], "the row stays");
      const vm = store.supersededOf(pid, "main")[0].earmarked;
      assert.deepEqual([[...vm.volumes].sort(), vm.networks], [["old_data", anon].sort(), [oldNetwork]], "(C) earmarked BEFORE the rm");

      // Restart of B. In-process (the harness has ctx.restart): the database is reopened; a real restart forgets the process
      // memory (report) — here forgetSuperseded().
      await ctx.restart({ withBackground: true, instancesReady: true });
      forgetSuperseded();
      const st2 = await state();
      assert.deepEqual([st2.status, st2.body], [200, { running: false, last: null }], "(F) after the restart: no run, no report");
      const g2 = await fetch();
      assert.equal(g2.status, 200, JSON.stringify(g2.body));
      const s2 = g2.body.stacks[0];
      assert.deepEqual(s2.container.map((c) => [c.id, c.state]), [[idX, "missing"]]);
      assert.deepEqual(s2.volumes.map((v) => v.name).sort(), ["old_data", anon].sort(), "(C) via the earmark — GP: without it the anonymous one would be listed nowhere, the named one only by name");
      assert.deepEqual(s2.networks, [{ id: oldNetwork, name: "old_default" }]);
      assert.deepEqual(s2.images.map((i) => i.id), [`sha256:${ID_OLD}`]);

      // A run that does NOT confirm the earmarked objects ends `finished` — the row stays (step 7: its earmark is open;
      // GP: on `missing` alone it would be dropped, and the anonymous volume would then belong to nothing).
      const r0 = await post({ confirmed: empty() });
      assert.equal(r0.status, 202, JSON.stringify(r0.body));
      await supersededEnd(pid);
      const e0 = (await state()).body.last;
      assert.deepEqual([e0?.state, e0?.since], ["finished", r0.body.since], JSON.stringify(e0));
      assert.deepEqual(rows(), [idX], "the earmark keeps the row");

      // Removing once more continues; only then is the row dropped.
      const r2 = await post({ confirmed: { ...empty(), volumes: s2.volumes.map((v) => v.name), networks: [oldNetwork], images: [`sha256:${ID_OLD}`] } });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      await supersededEnd(pid);
      const e2 = (await state()).body.last;
      assert.deepEqual([e2?.state, e2?.since], ["finished", r2.body.since], JSON.stringify(e2));
      assert.deepEqual([[...e2.removed.volumes].sort(), e2.removed.networks, e2.removed.images], [["old_data", anon].sort(), ["old_default"], ["old-app:latest"]]);
      assert.deepEqual(rows(), [], "the row is dropped — container and earmark are gone");
      assert.deepEqual(Object.keys(fd.state(cname).volumes), []);
    } finally {
      fd.errorAt([]);
      fd.openGate("stop");
      if (pid) await supersededEnd(pid);
      forgetSuperseded();
    }
  }, { fdOpts: { stopGate: "stop", checkUsed: true }, environment: () => ({ CBASE_LAYOUT_CHECK_BACK_MS: "3600000" }) });
});

// ── (X) Delete ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(X) delete clears `project_superseded` including the earmark — the project and the workspace path", async () => {
  await withCreation(async ({ ctx }) => {
    const remember = (projectId) => {
      store.rememberSuperseded({ projectId, containerId: "c1", namePrior: "old-app-1", stackPrior: "old", stackNow: "fresh" });
      assert.equal(store.earmarkSuperseded(projectId, "main", "c1", { volumes: ["old_data"], networks: ["n1"] }), true);
      assert.equal(store.supersededCount(projectId), 1);
    };
    const proj = await create(ctx, { name: "Way", sources: [] });
    await finished(proj.id);
    remember(proj.id);
    const dp = await request(`${ctx.base}/api/projects/${proj.id}`, { method: "DELETE" });
    assert.equal(dp.status, 200, JSON.stringify(dp.body));
    assert.deepEqual(store.supersededOf(proj.id), [], "project path");

    const wsPath = path.join(ctx.root, "ws-superseded");
    fs.mkdirSync(wsPath);
    const ws = (await request(`${ctx.base}/api/workspaces`, { method: "POST", body: { name: "Two", path: wsPath } })).body;
    const pid = "p-superseded-ws";
    fs.mkdirSync(path.join(wsPath, "p"));
    store.addProject(ws.id, { id: pid, name: "Without row", path: path.join(wsPath, "p"), createdAt: Date.now() });
    remember(pid);
    const dw = await request(`${ctx.base}/api/workspaces/${ws.id}`, { method: "DELETE" });
    assert.equal(dw.status, 200, JSON.stringify(dw.body));
    assert.deepEqual(store.supersededOf(pid), [], "workspace path");
  });
});
