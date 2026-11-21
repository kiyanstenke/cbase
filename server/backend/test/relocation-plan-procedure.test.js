// Plan AND procedure together: the REAL collection (projectbox/relocation/collect.js over the seam projectbox/docker.js), the REAL
// plan (plan.js) and the REAL procedure (procedure.js) against the fake docker that emulates both daemons (fake-docker.mjs).
// relocation-procedure.test.js builds its plan by hand — the defects lay exactly in the seam in between: the plan said "can
// relocate", the procedure failed (once, after the stop).
//
// The situation in B: Compose project "shop" with `db` (postgres:16, named volume pgdata, running), the PROFILE service `extra`
// (profiles: [extra], created by its name, anonymous volume /cache, exited) and a leftover one-off container from
// `compose run -d --no-deps tool` (oneoff=True, own image tool-image:1, own anonymous volume /work, exited).
//
// What holds:
//   (1) The relocation succeeds: the dry run calls `--profile * config --hash *` (the profile service has a hash), `up` without
//       `--profile` and without `tool`; inside there are exactly db and extra. The one-off container STAYS in B — with its
//       anonymous volume and its image —, the plan names it as a hint, the report as "not transferred".
//   (G-1) COUNTER-TEST: a plan that lists the one-off container in `compose.services` and `volumes.anonym` (sabotage in a copy of
//       plan.js) => the relocation fails and returns; it fails already in 12b ("new-hash"): the check of the trial run sees the
//       container `shop-tool-1`, which `up tool` created inside, outside the plan.
//   (G-2) COUNTER-TEST: a procedure whose `configHashArgs` carries no `--profile *` (sabotage in copies of compose-config.js and
//       procedure.js) => the dry run stops ("shop-extra-1"), before the first stop.
//   (A)  The image of `db` carries `LABEL cbase.acceptance=s1-26` (and `cbase.anything`), the container inherits it (the fake
//       docker like the real one) — the REAL collection, plan and procedure still relocate `db` with pgdata. Counter-test: an
//       older plan.js/collect.js/procedure.js — the plan lists only `extra`, pgdata "withoutContainer", db is missing inside (red).
//   (F)  The fake docker like the real Compose (v2.40.3 measured): `config --hash *` without a profile leaves `extra` out, a named
//       inactive service is "disabled", `--profile *` names it.
//   For a service with `env_file`, `config --hash` is NEVER the label of `up` and blind to the content of the env_file:
//   (B3-i)   `db` carries `env_file: db.env` (with a decoy value) — the real plan and procedure relocate the stack completely:
//            the dry run names db in `report.dryrun.withoutHash` (reason env_file, detected through `config --format json
//            --no-interpolate`), the equality is green, 12b creates nothing anew, inside db carries the label from B; the decoy
//            appears nowhere (journal, log). Counter-test: an older state — return path in the dry run ("shop-db-1").
//   (B3-iii) Drift of a service WITHOUT env_file (the Compose file changes after the `up` in B) is still caught by the dry run —
//            ONLY `shop-extra-1` is named, not the env_file service db; nothing stopped. Counter-test: an older state — db was
//            in the message too.
//   (B3-k)   The check in 12b: if the relocation does not see Compose's verdict (the fake docker writes nothing in the trial run),
//            12b stops with "not readable" and returns — instead of silently reporting "nothing new" (without the check the
//            relocation ended `finished` with an outdated container).
//   (F3)     The fake docker as measured: `config --hash` of an env_file service ≠ its label and independent of the content, `up`
//            takes the content into the hash, the trial run `--progress json --dry-run up …` reports "Recreate" (with the short-id
//            name), "Running", nothing for a current stopped container, "Creating" for a missing one and a warning for orphans —
//            and changes nothing in the state.
// Waiting only for the result of the procedure — no duration is a criterion.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "../electron/server/store.js";
import { containerName } from "../electron/server/projectbox/creation.js";
import * as procedureOriginal from "../electron/server/projectbox/relocation/procedure.js";
import * as planOriginal from "../electron/server/projectbox/relocation/plan.js";
import { collectRelocationData } from "../electron/server/projectbox/relocation/collect.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeComposeHash, fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";
import { setProcessSeam } from "../electron/server/projectbox/relocation/processes.js";
import { emptyProc } from "./fake-proc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Plan and step 4 read /proc (projectbox/relocation/processes.js) — here a fake one containing only B (macOS has none; without a
// view of the processes the plan would hold with data-missing).
const EMPTY_PROC = emptyProc();
setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
test.after(() => fs.rmSync(EMPTY_PROC, { recursive: true, force: true }));
const PB = path.resolve(HERE, "..", "electron", "server", "projectbox");

const IDA = "a1".repeat(32);
const IDB = "b2".repeat(32);
const IDC = "c3".repeat(32);
const IMAGES = { "cbase-projectbox:latest": ID, "postgres:16": IDA, "shop-web:latest": IDB, "tool-image:1": IDC };
const MODEL = {
  shop: {
    db: { image: "postgres:16", restart: "always", volumes: [{ name: "pgdata", target: "/var/lib/postgresql/data" }] },
    extra: { image: "shop-web:latest", profiles: ["extra"], volumes: [{ target: "/cache" }] },
    tool: { image: "tool-image:1", volumes: [{ target: "/work" }] },
  },
};
const L = { project: "com.docker.compose.project", service: "com.docker.compose.service", oneoff: "com.docker.compose.oneoff" };
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();

// The manifest program and `cp` in the helper (as in relocation-procedure.test.js: a valid manifest, equal at source and target).
function auxPrograms(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const js = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(js, body);
    const sh = path.join(dir, name);
    fs.writeFileSync(sh, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 });
    return sh;
  };
  const python3 = write("fake-python3", `const z = [{ "cbase-manifest": 1 }, { p: ".", type: "d", mode: "0755", uid: 0, gid: 0, mtime: "1", xattr: {} },
  { p: "data", type: "f", mode: "0644", uid: 0, gid: 0, mtime: "1", xattr: {}, size: 3, sha256: "d".repeat(64), thin: false, nlink: 1 },
  { entries: 2, end: true }];
process.stdout.write(z.map((x) => JSON.stringify(x)).join("\\n") + "\\n");
`);
  const cp = write("fake-cp", "");
  const source = path.join(dir, "cbase-manifest");
  fs.writeFileSync(source, "# placeholder: in B the program lives under /usr/local/bin (Dockerfile)\n");
  return { programs: { python3, cp }, manifestSource: fs.realpathSync(source) };
}

async function build(ctx, { images = {}, model = MODEL, files = {}, dryrunSilent = false } = {}) {
  const s = scenario(ctx);
  const aux = auxPrograms(path.join(ctx.root, `aux-${s.projectId}`));
  const fd = await fakeDocker({ images: { ...IMAGES, ...images }, programs: { ...s.programs, ...aux.programs }, compose: model, dryrunSilent });
  const file = path.join(s.path, "docker-compose.yml");
  fs.writeFileSync(file, "services:\n  db:\n    image: postgres:16\n  extra:\n    image: shop-web:latest\n    profiles: [extra]\n  tool:\n    image: tool-image:1\n");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(s.path, name), content);
  const g = ["compose", "-p", "shop", "--project-directory", s.path, "-f", file];
  dx(fd, ...g, "up", "--no-start", "--no-build", "--pull", "never", "db", "extra"); // a named service activates its profile
  const shop = () => Object.values(fd.state().container).filter((c) => c.labels[L.project] === "shop");
  const id = (d) => shop().find((c) => c.labels[L.service] === d && c.labels[L.oneoff] !== "True").id;
  dx(fd, "start", id("db"), id("extra"));
  dx(fd, "stop", id("extra"));
  const run = dx(fd, ...g, "run", "-d", "--no-deps", "tool");
  dx(fd, "stop", run);
  const runC = shop().find((c) => c.name === run);
  return { s, fd, aux, file, run, runVolume: runC.mounts[0].Name, extraVolume: shop().find((c) => c.name === "shop-extra-1").mounts[0].Name };
}

function inOps(b, fn) {
  return withOps(b.fd, async () => {
    const desired = { CBASE_MANIFEST_PROGRAM: b.aux.manifestSource, CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: b.s.root };
    const saved = Object.fromEntries(Object.keys(desired).map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, desired);
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
}

// The data steps (data.js) only log; the plan is the REAL one — collection and planRelocation (or a sabotage).
function steps(b, planModule) {
  const nothing = async () => {};
  return {
    portDismantling: nothing, portDismantlingBack: nothing, projectRepoStep: nothing, projectRepoBack: nothing,
    relocateRuntime: nothing, runtimeBack: nothing, cleanUpAfterStart: nothing,
    planFor: async (pid) => {
      const data = await collectRelocationData({ projectId: pid, home: b.s.home });
      const plan = planModule.planRelocation(data, { exists: () => false });
      b.plan = plan;
      return { plan, data };
    },
  };
}

async function relocation(b, { plan = planOriginal, procedure = procedureOriginal } = {}) {
  try {
    return await inOps(b, () => procedure.startRelocation(b.s.projectId, { steps: steps(b, plan), creation: b.s.opts }));
  } catch (e) {
    throw new Error(`${e.message}${e.holdReasons ? ` — ${JSON.stringify(e.holdReasons)}` : ""}${b.plan ? ` — hold reasons ${JSON.stringify(b.plan.holdReasons)}` : ""}`, { cause: e });
  }
}

// Copies outside the tree with exactly one place replaced; relative imports as absolute file URLs (except `replaceImport`).
const copies = [];
test.after(() => { for (const d of copies) fs.rmSync(d, { recursive: true, force: true }); });
async function copy(source, override, replaceImport = {}) {
  let text = fs.readFileSync(source, "utf8");
  for (const [old, fresh] of override) {
    assert.equal(text.split(old).length, 2, `sabotage: the place does not occur exactly once in ${path.basename(source)}: ${old}`);
    text = text.replace(old, fresh);
  }
  const dir = path.dirname(source);
  text = text.replace(/(from\s+|import\()"(\.{1,2}\/[^"]+)"/g, (_, before, rel) => `${before}"${replaceImport[rel] || pathToFileURL(path.resolve(dir, rel)).href}"`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-plan-procedure-"));
  copies.push(folder);
  const target = path.join(folder, `${path.basename(source, ".js")}.mjs`);
  fs.writeFileSync(target, text);
  return { url: pathToFileURL(target).href, module: await import(pathToFileURL(target).href) };
}

const inside = (b) => b.fd.state(containerName(b.s.projectId));
const dryrun = (b) => b.fd.calls({ daemon: containerName(b.s.projectId) }).filter((a) => a.args[0] === "compose" && a.args.includes("config"));
const trialRuns = (b) => b.fd.calls({ daemon: containerName(b.s.projectId) }).filter((a) => a.args[0] === "compose" && a.args.includes("--dry-run"));

test("(1) one-off container and profile service: the real plan says \"can relocate\", and the real procedure succeeds — the one-off container stays in B", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const result = await relocation(b);
      assert.deepEqual(result.ok ? [] : [result.step, result.error], [], "the relocation failed");
      assert.equal(result.end, "finished");
      // The plan: no service `tool`, no anonymous volume and no image of the one-off container; named as a hint.
      assert.deepEqual(b.plan.compose.map((g) => g.services), [["db", "extra"]]);
      assert.deepEqual(b.plan.volumes.anonym.map((v) => v.name), [b.extraVolume]);
      assert.ok(!b.plan.images.some((i) => i.tags.includes("tool-image:1")));
      assert.ok(b.plan.hints.some((h) => h.kind === "once-container" && h.container === b.run && h.anonym.includes(b.runVolume)));
      // On the wire: `--profile *` only on `config`, `up` without `--profile` and without `tool`. Only the dry run calls `config`
      // (12b asks Compose in the trial run): `--hash`, then — always, for the volumes without a label — the model once (`--format json`).
      const configs = dryrun(b);
      assert.equal(configs.length, 2, `config calls: ${configs.length}`);
      assert.deepEqual(configs.map((c) => c.args.slice(c.args.indexOf("--profile"), c.args.indexOf("--profile") + 4)), [["--profile", "*", "config", "--hash"], ["--profile", "*", "config", "--format"]]);
      assert.equal(trialRuns(b).length, 3, "12b: check, trial run before and after the re-creation");
      const ups = b.fd.calls({ daemon: containerName(b.s.projectId) }).filter((a) => a.args[0] === "compose" && a.args.includes("up"));
      assert.ok(ups.length >= 1 && ups.every((a) => !a.args.includes("--profile") && !a.args.includes("tool")), JSON.stringify(ups.map((a) => a.args)));
      // Inside exactly db and extra; in B the one-off container stays with its volume and image, the rest is gone.
      assert.deepEqual(Object.values(inside(b).container).map((c) => c.name).sort(), ["shop-db-1", "shop-extra-1"]);
      const z = b.fd.state();
      assert.deepEqual(Object.values(z.container).filter((c) => c.labels[L.project] === "shop").map((c) => [c.name, c.status]), [[b.run, "exited"]]);
      assert.ok(z.volumes[b.runVolume], "the anonymous volume of the one-off container is gone");
      assert.ok(z.images["tool-image:1"], "the image of the one-off container is gone");
      assert.equal(z.volumes.shop_pgdata, undefined);
      assert.equal(z.volumes[b.extraVolume], undefined);
      const snapshot = procedureOriginal.relocationStatus(b.s.projectId);
      assert.deepEqual(snapshot.report.notTransferred.onceContainer, [b.run]);
      assert.ok(snapshot.report.remove.not.some((x) => x.startsWith(`container ${b.run}: one-off container`)), JSON.stringify(snapshot.report.remove.not));
      assert.equal(store.projectInstance(b.s.projectId, "main")?.state, "ready");
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-1) counter-test: a plan with the one-off container in services and anonymous volumes => return path AFTER the stop", async () => {
  const { module } = await copy(path.join(PB, "relocation", "plan.js"), [
    ["const replica = relocation.filter((c) => !isOnce(c));", "const replica = relocation;"],
    ["    if (!once) {\n      if (ref.includes(\"@\"))", "    if (true) {\n      if (ref.includes(\"@\"))"],
    ["        if (once) {\n          if (isAnonym) onceAnonym.push(m.Name);", "        if (false) {\n          if (isAnonym) onceAnonym.push(m.Name);"],
  ]);
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const result = await relocation(b, { plan: module });
      assert.equal(b.plan.canRelocate, true, "the sabotage already holds in the plan — the counter-test proves nothing");
      assert.ok(b.plan.compose[0].services.includes("tool") && b.plan.volumes.anonym.some((v) => v.name === b.runVolume), "sabotage without effect");
      assert.equal(result.end, "back", JSON.stringify(result));
      // The trial run in 12b sees the container outside the plan.
      assert.equal(result.step, "new-hash", result.error);
      assert.match(result.error, /not in the plan shop-tool-1/);
      assert.ok(b.fd.calls({ daemon: "host" }).some((a) => a.args[0] === "stop"), "the return path came before the stop");
      // The return path restores B: db runs again, the one-off container is there untouched.
      const z = b.fd.state();
      assert.equal(Object.values(z.container).find((c) => c.name === "shop-db-1")?.status, "running");
      assert.ok(Object.values(z.container).some((c) => c.name === b.run));
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-2) counter-test: `config --hash *` without `--profile *` => the dry run stops at the profile service, before the first stop", async () => {
  const config = await copy(path.join(PB, "compose-config.js"), [['"--profile", "*", "config", "--hash", "*"]', '"config", "--hash", "*"]']]);
  const { module } = await copy(path.join(PB, "relocation", "procedure.js"), [], { "../compose-config.js": config.url });
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const result = await relocation(b, { procedure: module });
      assert.equal(result.end, "back", JSON.stringify(result));
      assert.equal(result.step, "dryrun", result.error);
      assert.match(result.error, /shop-extra-1/);
      assert.ok(!b.fd.calls({ daemon: "host" }).some((a) => a.args[0] === "stop" && a.args.includes("-t")), "stopped despite the dry-run hold");
    } finally { b.fd.cleanUp(); }
  });
});

test("(A) an image with LABEL cbase.acceptance — collection, plan and procedure relocate the container with its volume", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { images: { "postgres:16": { id: IDA, labels: { "cbase.acceptance": "s1-26", "cbase.anything": "yes" } } } });
    try {
      const db = Object.values(b.fd.state().container).find((c) => c.name === "shop-db-1");
      assert.equal(db.labels["cbase.acceptance"], "s1-26", "the fake docker does not inherit the image labels");
      const result = await relocation(b);
      assert.deepEqual(result.ok ? [] : [result.step, result.error], [], "the relocation failed");
      assert.deepEqual(b.plan.compose.map((g) => g.services), [["db", "extra"]]);
      assert.deepEqual(b.plan.volumes.named.map((v) => [v.name, v.container, v.withoutContainer]), [["shop_pgdata", ["shop-db-1"], false]]);
      assert.deepEqual(Object.values(inside(b).container).map((c) => c.name).sort(), ["shop-db-1", "shop-extra-1"]);
      assert.ok(!Object.values(b.fd.state().container).some((c) => c.name === "shop-db-1"), "db stayed in B");
    } finally { b.fd.cleanUp(); }
  });
});

test("(F) the fake docker like Compose v2.40.3: without a profile the profile service is missing in `config --hash *`, named it is \"disabled\"", async () => {
  const fd = await fakeDocker({ images: IMAGES, compose: MODEL });
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "relocation-profile-"));
    copies.push(d);
    const file = path.join(d, "docker-compose.yml");
    fs.writeFileSync(file, "services: {}\n");
    const g = ["compose", "-p", "shop", "--project-directory", d, "-f", file];
    const services = (text) => text.split("\n").map((z) => z.split(" ")[0]).filter(Boolean);
    assert.deepEqual(services(dx(fd, ...g, "config", "--hash", "*")), ["db", "tool"]);
    assert.deepEqual(services(dx(fd, ...g, "--profile", "*", "config", "--hash", "*")), ["db", "extra", "tool"]);
    assert.deepEqual(services(dx(fd, ...g, "--profile", "extra", "config", "--hash", "*")), ["db", "extra", "tool"]);
    assert.throws(() => execFileSync(fd.bin, [...g, "config", "--hash", "db,extra"], { stdio: "pipe" }), (e) => /no such service: extra: disabled/.test(String(e.stderr)));
  } finally { fd.cleanUp(); }
});

// ── env_file ────────────────────────────────────────────────────────────────────────────────────────────────────────

const B3_SECRET = "B3_DECOY_4242";
const MODEL_ENV = { shop: { ...MODEL.shop, db: { ...MODEL.shop.db, envFile: ["db.env"] } } };
const buildEnv = (ctx, o = {}) => build(ctx, { model: MODEL_ENV, files: { "db.env": `DB_PASS=${B3_SECRET}\nA=1\n` }, ...o });
const labelOf = (state, name) => Object.values(state.container).find((c) => c.name === name)?.labels["com.docker.compose.config-hash"];

test("(B3-i) a stack with an env_file service relocates completely — dry run without a hash comparison for it, equality green, 12b creates nothing anew", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await buildEnv(ctx);
    try {
      const labelB = labelOf(b.fd.state(), "shop-db-1");
      const result = await relocation(b);
      assert.deepEqual(result.ok ? [] : [result.step, result.error], [], "the relocation failed");
      assert.equal(result.end, "finished");
      const snapshot = procedureOriginal.relocationStatus(b.s.projectId);
      assert.deepEqual(snapshot.report.dryrun?.withoutHash, [{ name: "shop-db-1", service: "db", project: "shop", reason: "env_file" }]);
      assert.deepEqual(snapshot.report.newlyCreated, []);
      // "has env_file" came from Compose's model inside, without values (`--no-interpolate`), once.
      const modelCalls = dryrun(b).filter((a) => a.args.includes("--format"));
      assert.equal(modelCalls.length, 1);
      assert.deepEqual(modelCalls[0].args.slice(modelCalls[0].args.indexOf("--profile")), ["--profile", "*", "config", "--format", "json", "--no-interpolate", "--no-env-resolution"]);
      // Inside db and extra, db with the label from B (not created anew).
      assert.deepEqual(Object.values(inside(b).container).map((c) => c.name).sort(), ["shop-db-1", "shop-extra-1"]);
      assert.equal(labelOf(inside(b), "shop-db-1"), labelB);
      const j = JSON.stringify(store.relocationsOf(b.s.projectId));
      assert.ok(!j.includes(B3_SECRET), "value from the env_file in the journal");
      const proto = fs.readFileSync(path.join(store.relocationsOf(b.s.projectId).at(-1).location, "log.log"), "utf8");
      assert.ok(!proto.includes(B3_SECRET), "value from the env_file in the log");
      assert.match(proto, /without hash comparison \(env_file, equality checks them\): shop-db-1/);
    } finally { b.fd.cleanUp(); }
  });
});

test("(B3-iii) drift of a service WITHOUT env_file is still caught by the dry run — only it is named, not the env_file service; nothing stopped", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await buildEnv(ctx);
    try {
      fs.appendFileSync(b.file, "# changed after the up (drift)\n");
      const result = await relocation(b);
      assert.equal(result.end, "back", JSON.stringify(result));
      assert.equal(result.step, "dryrun", result.error);
      assert.match(result.error, /shop-extra-1/);
      assert.doesNotMatch(result.error, /shop-db-1/, "the env_file service is in the message");
      assert.deepEqual(store.relocationsOf(b.s.projectId).at(-1).report?.dryrun?.withoutHash?.map((x) => x.name), ["shop-db-1"]);
      assert.ok(!b.fd.calls({ daemon: "host" }).some((a) => a.args[0] === "stop" && a.args.includes("-t")), "stopped despite the dry-run hold");
    } finally { b.fd.cleanUp(); }
  });
});

test("(B3-k) a trial run whose verdict the relocation does not see => the check in 12b stops, return path — never silently \"nothing new\"", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await buildEnv(ctx, { dryrunSilent: true });
    try {
      const result = await relocation(b);
      assert.equal(result.end, "back", JSON.stringify(result));
      assert.equal(result.step, "new-hash", result.error);
      assert.match(result.error, /the control with --force-recreate does not report shop-db-1, shop-extra-1 as "Recreate" — the verdict of Compose is not readable/);
      assert.equal(trialRuns(b).length, 1, "a trial run still ran after the failed check");
      assert.equal(Object.values(b.fd.state().container).find((c) => c.name === "shop-db-1")?.status, "running", "the return path did not bring db back");
    } finally { b.fd.cleanUp(); }
  });
});

test("(F3) the fake docker like Compose v5.3.1: config --hash of an env_file service ≠ label and blind to the content, up takes it, the trial run changes nothing", async () => {
  const model = { t: { with: { image: "postgres:16", envFile: ["x.env"] }, without: { image: "postgres:16" }, mig: { image: "postgres:16" }, fresh: { image: "postgres:16" } } };
  const fd = await fakeDocker({ images: IMAGES, compose: model });
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "relocation-envfile-"));
    copies.push(d);
    const file = path.join(d, "docker-compose.yml");
    fs.writeFileSync(file, "services: {}\n");
    fs.writeFileSync(path.join(d, "x.env"), "A=1\n");
    const g = ["compose", "-p", "t", "--project-directory", d, "-f", file];
    dx(fd, ...g, "up", "--no-start", "--no-build", "--pull", "never", "with", "without", "mig");
    const id = (n) => Object.values(fd.state().container).find((c) => c.name === n).id;
    dx(fd, "start", id("t-with-1"), id("t-without-1"));
    const hashes = () => Object.fromEntries(dx(fd, ...g, "config", "--hash", "*").split("\n").filter(Boolean).map((z) => z.split(" ")));
    const h1 = hashes();
    assert.notEqual(h1.with, labelOf(fd.state(), "t-with-1"), "config --hash of an env_file service equals the label");
    assert.equal(h1.without, labelOf(fd.state(), "t-without-1"));
    const probe = (...extra) => {
      const r = spawnSync(fd.bin, ["compose", "--progress", "json", "--dry-run", ...g.slice(1), "up", "--no-start", "--no-build", "--pull", "never", ...extra], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stderr.split("\n").filter(Boolean).map((z) => JSON.parse(z));
    };
    const prior = JSON.stringify(fd.state());
    assert.deepEqual(probe("with", "without", "mig"), [
      { id: "Container t-with-1", status: "Done", text: "Running" }, { id: "Container t-without-1", status: "Done", text: "Running" },
    ], "current: Running for the running ones, nothing for the stopped mig");
    fs.writeFileSync(path.join(d, "x.env"), "A=2\n");
    assert.deepEqual(hashes(), h1, "config --hash saw the content of the env_file");
    const rows = probe("with", "without", "mig", "fresh");
    assert.deepEqual(rows.filter((z) => z.id?.startsWith("Container")).map((z) => [z.id.replace(/[0-9a-f]{12}_/, "<short>_"), z.text]), [
      ["Container t-with-1", "Recreate"], ["Container <short>_t-with-1", "Recreated"], ["Container t-without-1", "Running"],
      ["Container t-fresh-1", "Creating"], ["Container t-fresh-1", "Created"],
    ]);
    assert.equal(JSON.stringify(fd.state()), prior, "the trial run changed the state");
    // An orphan (a container of the Compose project without a service in the model) shows up as a warning.
    const w = await fakeDocker({ images: IMAGES, compose: { t: { without: { image: "postgres:16" } } } });
    try {
      dx(w, ...g, "up", "--no-start", "--no-build", "--pull", "never", "without");
      fs.writeFileSync(path.join(w.dir, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(w.dir, "config.json"), "utf8")), compose: { t: { mig: { image: "postgres:16" } } } }));
      const r = spawnSync(w.bin, ["compose", "--progress", "json", "--dry-run", ...g.slice(1), "up", "--no-start", "--no-build", "--pull", "never", "mig"], { encoding: "utf8" });
      assert.match(r.stderr.split("\n")[0], /^\{"level":"warning","msg":"Found orphan containers \(\[t-without-1\]\)/);
    } finally { w.cleanUp(); }
    // The real creation takes the new content: `up` re-creates it, the label is the hash of `up`.
    const old = labelOf(fd.state(), "t-with-1");
    dx(fd, ...g, "up", "--no-start", "--no-build", "--pull", "never", "with");
    assert.notEqual(labelOf(fd.state(), "t-with-1"), old);
    assert.equal(labelOf(fd.state(), "t-with-1"), fakeComposeHash({ service: "with", files: [file], folder: d, envFile: [path.join(d, "x.env")] }));
    // Compose's model: env_file only with --no-interpolate, then without a value; without the switch the value instead of env_file (v2.40.3).
    const modelJson = (...o) => JSON.parse(dx(fd, ...g, "--profile", "*", "config", "--format", "json", ...o)).services.with;
    assert.deepEqual(modelJson("--no-interpolate", "--no-env-resolution").env_file, [{ path: path.join(d, "x.env"), required: true }]);
    assert.equal(modelJson("--no-env-resolution").env_file, undefined);
    assert.deepEqual(modelJson("--no-env-resolution").environment, { A: "2" });
  } finally { fd.cleanUp(); }
});
