// The relocation procedure (projectbox/relocation/procedure.js) against the fake docker that imitates BOTH daemons
// (fake-docker.mjs: B = "host", the inner one through `exec cbase-p-<id> docker ...`, Compose in its own block). The data
// steps (data.js: steps 9, 11, 13 and the data part of 15) and the plan (collect.js) are injected fakes that log their call
// and their return path; the plan is built by hand from the state of B (shape of projectbox/relocation/plan.js - the
// interplay with the real plan is checked by relocation-plan-procedure.test.js).
//
// The situation in B: Compose project "shop" with `db` (postgres:16, always, named volume pgdata), `web` (depends_on db,
// unless-stopped, anonymous volume /app/cache, network shop_default + external extnetz) and `migrate` (depends_on db,
// exited); Compose file plus cbase override, `.env` with a bait value.
//
// What holds here:
//   (1) Success: order and arguments on the wire - dry run `config --hash` inside BEFORE the first stop; stop by id with
//       `-t 30` in reverse depends_on order (web before db, the finished migrate not); AFTER that `update --restart=no`;
//       images as a stream (`save <tags>` in B, `exec -i ... docker load`, no -o/-i); named volumes (create + copy) BEFORE
//       step 8; the exact `up` arguments; 12b without override (control `--dry-run ... --force-recreate`, trial run, `up` of
//       the "Recreate" services, second trial run - no `config --hash` any more); anonymous volumes AFTER step 10 into the
//       volume of the FINAL container; `rm` only by id and only after the passed check (actual manifests). Afterwards B is
//       empty (containers, volumes, images, networks of the project), inside db and web run, migrate stands; row `ready`
//       with `converted_at`, journal `finished`, report with duration per step. The network WITHOUT labels (extnetz) stays
//       in B, the report names it. During the relocation: `busy` with `projectWork`, the project locked (step 2). The bait
//       from `.env` appears nowhere (DB, log, report, command lines).
//   (2) An error at EVERY one of steps 3-14 (creation, dry run, stop, images, volumes, networks, equality, port dismantling,
//       new hash, project repo, anonymous volumes, runtime, check) => return path: nothing removed, old containers run
//       (migrate stays finished), policies back, override and `.env` byte-equal, project container with volume and network
//       gone, no helpers, no instance row, journal `back`; the data steps log their return path in the order runtime ->
//       ports -> project-repo. The bait from `.env` is in neither journal nor log even in the error case (the Compose error
//       of the dry run carries it in its message). The reason (`step "<s>": ...`) stands in journal, report and answer; if
//       `up` fails in "equality", the planned container names are already in the journal.
//   (3) Preconditions change nothing: hold reason, not idle (locked), heavy load occupied, open journal, a half relocation of
//       ANOTHER project without decision (RELOCATION_ELSEWHERE) => 409 without a journal row and without a docker call after
//       the plan.
//   (4) Restart BEFORE the turnaround (crashed in the middle of "networks") => return path; AFTER the turnaround (crashed
//       before "recheck", project container and inner containers stand) => first start (project container, then the stages
//       inside), then the renewed check, only then `rm` of the old containers.
//   (5) Without the operating marker no docker call - neither the relocation (404) nor the decider.
//   (7) A native service in B (real process group): step 4 writes it into the journal, ends the group and empties RUNS; the
//       return path (images fails) starts it again in B (new group).
//   Also in (1): the helpers mount sources read-only, the manifest program only read-only bound (manifestArgv), `cp -a`.
//   (8)  a return-path part fails (start of db) => the return path continues and ends `back`: reason before the return path
//        in journal and row, `returnPathError` names the part, the AutoRemove one-off container is "gone" (done), db stays
//        (not come back = not deleted), no instance row; afterwards a second relocation runs through.
//   (9)  a return path that deleted data in the ONLY place (instance carries converted_at) => `hold-return-path` with reason
//        and way out, nothing removed; the way out (POST .../relocation/resume = `resumeRelocation`) takes it to the end.
//   (10) the project container does not start in the restart, converted_at empty => return path instead of a hold after
//        the turnaround.
//   (11) restart from "remove" checks again before the rm - if a container is missing inside, B stays untouched.
//   (12) "stop" re-reads the containers after lock and idle (working_dir in the project, shared volume) => return path,
//        nothing stopped.
//   (12b) on re-reading, a `cbase.` label inherited from the image does not count, and a container of cbase on a volume of
//        the plan is a deviation => return path in "stop", nothing stopped.
//   (13) a native service listens on another port after the start (lsof in the project container) => the row carries the
//        measured one, the old one is in the report.
//   (18) a relocation leaves no process in B that works in the project. A REAL child process (working dir in the project
//        folder, own group, started by the test and ended by pid in the finally), seen through a fake /proc (fake-proc.mjs -
//        macOS has none):
//        (a) it shows up only AFTER the plan => "stop" holds BEFORE the first stop, return path, nothing stopped;
//        (b) at the first look it stands in the group of a captured native run (exempt) and survives its ending => the second
//            look after endNativeRuns holds, return path AFTER the stop: containers run again with their policies, the
//            native service starts again.
//        cbase never ends the foreign process itself - it lives after the return path. Counter-proof: without the process
//        look the relocation goes ahead in both cases (red). All other guards here see a /proc in which only B stands.
//        (c) a DESCENDANT of the captured run (ppid chain) in its own group passes the first look (`descendantsCount: false` -
//            it may end with the service) and holds only in the second, which exempts nobody => return path AFTER the stop.
//            Counter-proof: `descendantsCount: true` in the first look => return path already before the first stop (red).
//   (19) the project container crashes in "start" in the middle of the start sequence and starts again => the target of the
//        relocation stays (checkLiveness in stepStart: no snapshot from the fresh dockerd), and the observer
//        (projectbox/resumption.js, started in the test, tick by hand) brings the stack back after the relocation.
//   (20) if `cbase-p-<id>-docker` already lay in B (rest of an earlier instance), the creation notes
//        `insideIds.volumeFound: true`, and the return path (error in "networks") does not remove the volume - the content
//        stays. Sabotage `if (found !== false)` -> `if (false)` => red (the volume falls). The case "not found => removed"
//        is in (2).
//   (21) the database does not delete the instance row in rw-completion (a TEMP trigger just for this project) => the return
//        path holds there, named (journal open in "rw-completion", row `relocation`/`hold-return-path` with reason and way
//        out), instead of reporting "back" with a row without a journal; the way out (resumeRelocation) repeats only
//        rw-completion and ends "back" without a row.
//   A test that turns red does not hang: a row that stayed in a working state goes in the finally (`rowApprove`).
//   (14) the inner dockerd fills an EMPTY volume at `up` from the image (copy-up, `imageContent` in the fake docker): an
//        anonymous node_modules-like volume in which a package is missing in B, and a named volume that is empty in B => step
//        12 empties both targets before the `cp -a` (the named one only because its source is empty), the check is green,
//        inside stands exactly the content of B. Real `cp`/`find` on the folders of the fake docker, a manifest over the content.
//   (15) step 15 removes only what demonstrably belongs to this project - a volume without the Compose label (`external`)
//        stays, a pulled image stays (a built one goes), no `builder prune`; the manifests lie as files (0600) in the
//        relocation location.
//   (16) a volume of the plan is missing at the desired manifest => return path in "stop" with its name, B does not create it empty.
//   (17) .env values in every form (comment, quote with comment, `export`, whitespace, `KEY: value`, CRLF, escaped quote) are
//        blacked out in a Compose error message - nowhere in journal or log.
//
// Waiting only on events (promises of the injected data steps, the result of the procedure) - no duration is a criterion.
//
// COUNTER-TESTS (built in, one sabotage each in a copy of procedure.js outside the tree, loaded with absolute imports):
//   (G-a) "remove" BEFORE "check" in the journal plan            => the order checker of (1) reports "rm before the check"
//   (G-b) return path without the old policies (images fails)    => the return-path checker of (2) reports the policies
//   (G-c) turnaround moved to "creation"                         => the checker of (4, before the turnaround) reports "no return path"
//   (G-d) restart after the turnaround without the start first   => the checker of (4, after the turnaround) reports it
//   (G-e) Compose error without blacking out the .env values     => the return-path checker finds the bait in the journal
//   (G-f) return path aborts at the first failed part            => the checker of (8) reports the open end and the row
//   (G-g) restart from "remove" without the renewed check        => the checker of (11) reports the rm
//   (G-h) step 12 without emptying                               => (14) fails in "check" on both volumes
//   (G-i) without catching up empty named sources                => on the named one
//   (G-j) step 15 without the label check                        => the `external` volume is gone
//   (G-k) the blacking out of the first version                  => a value is in the journal
//   stepStart without `await checkLiveness(id, ...)`             => (19) red: the target comes from the fresh dockerd
//                                                                   (db and web `exited`, migrate `created`)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { DIRS } from "../electron/server/app-state.js";
import { containerName, networkName, volumeName } from "../electron/server/projectbox/creation.js";
import { withProjectOccupancy } from "../electron/server/projectbox/instance.js";
import { instancesRestartGrace, setRelocationDecider } from "../electron/server/projectbox/instances.js";
import { createRelocationLocation, relocationTime } from "../electron/server/projectbox/journal.js";
import { projectLocks } from "../electron/server/projectbox/idle.js";
import { occupyHeavyLoad } from "../electron/server/projectbox/heavyLoad.js";
import * as procedureOriginal from "../electron/server/projectbox/relocation/procedure.js";
import { nativeRuns, startSimple, startDesiredServices } from "../electron/server/services.js";
import { desiredTickRound, resumptionRestartGrace, resumptionQuiet, resumptionStatus, stopResumption } from "../electron/server/projectbox/resumption.js";
import { setNativeServicesStarter } from "../electron/server/projectbox/restore.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeProc, emptyProc } from "./fake-proc.mjs";
import { setProcessSeam } from "../electron/server/projectbox/relocation/processes.js";
import { readJsonl } from "./jsonl.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Step 4 reads /proc - here a fake one in which only B stands (case (18) sets its own).
const EMPTY_PROC = emptyProc();
setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
test.after(() => fs.rmSync(EMPTY_PROC, { recursive: true, force: true }));
const PROCEDURE = path.resolve(HERE, "..", "electron", "server", "projectbox", "relocation", "procedure.js");

const IDA = "a1".repeat(32);
const IDB = "b2".repeat(32);
// shop-web is BUILT by Compose (label of the Compose project), postgres:16 pulled (without labels).
const IMAGES = { "cbase-projectbox:latest": ID, "postgres:16": IDA, "shop-web:latest": { id: IDB, labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": "web" } } };
const MODEL = {
  shop: {
    db: { image: "postgres:16", restart: "always", volumes: [{ name: "pgdata", target: "/var/lib/postgresql/data" }] },
    web: { image: "shop-web:latest", restart: "unless-stopped", dependsOn: ["db"], volumes: [{ target: "/app/cache" }], networks: ["default"], extern: ["extnetz"] },
    migrate: { image: "shop-web:latest", dependsOn: ["db"] },
  },
};
const SECRET = "SECRET_VALUE_4711";
const L = { project: "com.docker.compose.project", service: "com.docker.compose.service", hash: "com.docker.compose.config-hash", image: "com.docker.compose.image" };
const HEX64 = /^[0-9a-f]{64}$/;
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();

// ── Helper programs in the helper (through `programs` of the fake docker) ────────────────────────────────────────────
// python3: the manifest program - logs argv, prints a valid manifest; with the file `deviation` it reports another content
// at the TARGET (/relocation/target/...). cp: logs argv. Plus the "source" of the manifest program in B.
function auxPrograms(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "programs.jsonl");
  const deviation = path.join(dir, "deviation");
  const write = (name, body) => {
    const js = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(js, body);
    const sh = path.join(dir, name);
    fs.writeFileSync(sh, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 });
    return sh;
  };
  const header = `const fs = require("fs");\nconst argv = process.argv.slice(2);\n`;
  const python3 = write("fake-python3", `${header}fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prog: "python3", argv }) + "\\n");
const root = argv[argv.length - 1];
const sha = (root.startsWith("/relocation/target/") && fs.existsSync(${JSON.stringify(deviation)}) ? "e" : "d").repeat(64);
const z = [{ "cbase-manifest": 1 }, { p: ".", type: "d", mode: "0755", uid: 0, gid: 0, mtime: "1", xattr: {} },
  { p: "data", type: "f", mode: "0644", uid: 0, gid: 0, mtime: "1", xattr: {}, size: 3, sha256: sha, thin: false, nlink: 1 },
  { entries: 2, end: true }];
process.stdout.write(z.map((x) => JSON.stringify(x)).join("\\n") + "\\n");
`);
  const cp = write("fake-cp", `${header}fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prog: "cp", argv }) + "\\n");\n`);
  const source = path.join(dir, "cbase-manifest");
  fs.writeFileSync(source, "# placeholder: in B the program lies under /usr/local/bin (Dockerfile)\n");
  return { log, deviation, programs: { python3, cp }, manifestSource: fs.realpathSync(source) };
}

// ── The situation in B ───────────────────────────────────────────────────────────────────────────────────────────────

async function build(ctx, { stopsInside = false, programs = {}, instanceIp = null, imageContent = {}, images = {} } = {}) {
  const s = scenario(ctx);
  const aux = auxPrograms(path.join(ctx.root, `aux-${s.projectId}`));
  const fd = await fakeDocker({ images: { ...IMAGES, ...images }, programs: { ...s.programs, ...aux.programs, ...programs }, compose: MODEL, stopsInside, imageContent, ...(instanceIp ? { instanceIp } : {}) });
  const compose = path.join(s.path, "docker-compose.yml");
  const override = path.join(s.path, "docker-compose.override.yml");
  const env = path.join(s.path, ".env");
  fs.writeFileSync(compose, "services: {}\n# db, web, migrate (the model stands in the fake docker)\n");
  fs.writeFileSync(override, "# from cbase: port override\n");
  fs.writeFileSync(env, `PORT=3100\nSECRET=${SECRET}\n`);
  dx(fd, "network", "create", "extnetz");
  dx(fd, "compose", "-p", "shop", "--project-directory", s.path, "-f", compose, "-f", override, "up", "--no-start", "--no-build", "--pull", "never", "db", "migrate", "web");
  const shop = Object.values(fd.state().container).filter((c) => c.labels[L.project] === "shop");
  const ids = Object.fromEntries(shop.map((c) => [c.labels[L.service], c.id]));
  dx(fd, "start", ids.db, ids.web, ids.migrate);
  dx(fd, "stop", ids.migrate);
  const anonB = fd.state().container[ids.web].mounts.find((m) => m.Destination === "/app/cache").Name;
  // The volumes in B carry content (as in reality: Postgres data, a cache) - an EMPTY source is fetched again by step 12
  // after the copy-up (case (14)).
  for (const v of ["shop_pgdata", anonB]) { fs.mkdirSync(fd.volumeData(v), { recursive: true }); fs.writeFileSync(path.join(fd.volumeData(v), "data"), "abc"); }
  const b = {
    s, fd, aux, compose, override, env, ids, anonB, envPrior: fs.readFileSync(env), overridePrior: fs.readFileSync(override),
    start: fd.calls().length,
  };
  b.calls = () => fd.calls().slice(b.start);
  b.plan = planFrom(b);
  return b;
}

// The plan in the shape of projectbox/relocation/plan.js (only the fields the procedure reads), from the state of B.
function planFrom(b, { holdReasons = [] } = {}) {
  const z = b.fd.state();
  const shop = Object.values(z.container).filter((c) => c.labels[L.project] === "shop").sort((x, y) => (x.name < y.name ? -1 : 1));
  const container = shop.map((c) => ({
    id: c.id, name: c.name, service: c.labels[L.service], composeProject: "shop", state: c.status, exitCode: c.exitCode,
    restart: c.restart || "no", image: `sha256:${c.imageId}`, imageRef: c.image, composeImage: c.labels[L.image], configHash: c.labels[L.hash],
    oneoff: c.labels["com.docker.compose.oneoff"] === "True", dependsOn: (MODEL.shop[c.labels[L.service]]?.dependsOn || []),
    mounts: c.mounts.map((m) => ({ type: "volume", name: m.Name, target: m.Destination, anonym: HEX64.test(m.Name) })),
    networks: c.networks.map((n) => n.name).sort(), ports: [],
  }));
  const files = [b.compose, b.override];
  return {
    projectId: b.s.projectId, projectPath: b.s.path, canRelocate: holdReasons.length === 0, holdReasons, hints: [],
    container,
    compose: [{
      project: "shop", folder: b.s.path, files, envFiles: [], args: ["-p", "shop", "--project-directory", b.s.path, ...files.flatMap((d) => ["-f", d])],
      services: ["db", "migrate", "web"], container: container.map((c) => c.name),
    }],
    startFollowUp: ["shop-db-1", "shop-migrate-1", "shop-web-1"], stopFollowUp: ["shop-web-1", "shop-migrate-1", "shop-db-1"],
    images: [{ id: `sha256:${IDA}`, tags: ["postgres:16"], bytes: 100 }, { id: `sha256:${IDB}`, tags: ["shop-web:latest"], bytes: 200 }],
    volumes: {
      named: [{ name: "shop_pgdata", labels: z.volumes.shop_pgdata.labels, bytes: 10, container: ["shop-db-1"], withoutContainer: false }],
      anonym: [{ name: b.anonB, container: "shop-web-1", target: "/app/cache", bytes: 5 }],
    },
    networks: { itself: ["extnetz"], owner: [{ network: "shop_default", project: "shop" }] },
    withoutLabel: [], worktrees: {}, dismantling: { env: [], services: [], overrides: [{ file: path.basename(b.override), ofCbase: true }] },
    slot: null, downtime: null, mentions: [], hits: [],
  };
}

// The injected data steps (data.js) and the plan (collect.js). Port dismantling puts the override file aside and fetches it
// back in the return path; all others only log. `raises`: this step fails (before its effect); `hold`: this step waits
// for `approve()` and reports `arrived`.
function dataSteps(b, { raises = null, hold = null } = {}) {
  const log = [];
  let approve;
  let reached;
  const held = new Promise((r) => { approve = r; });
  const arrived = new Promise((r) => { reached = r; });
  const aside = (ctx) => path.join(ctx.relocationLocation, "override-aside.yml");
  const mach = (name, fn = () => {}) => async (ctx) => {
    log.push(name);
    if (hold === name) { reached(ctx); await held; }
    if (raises === name) throw Object.assign(new Error(`injected: ${name}`), { step: name });
    return fn(ctx);
  };
  const steps = {
    portDismantling: mach("portDismantling", (ctx) => fs.renameSync(b.override, aside(ctx))),
    portDismantlingBack: mach("portDismantlingBack", (ctx) => { if (fs.existsSync(aside(ctx))) fs.renameSync(aside(ctx), b.override); }),
    projectRepoStep: mach("projectRepoStep"),
    projectRepoBack: mach("projectRepoBack"),
    relocateRuntime: mach("relocateRuntime"),
    runtimeBack: mach("runtimeBack"),
    cleanUpAfterStart: mach("cleanUpAfterStart"),
    planFor: async () => ({ plan: b.plan, data: {} }),
  };
  return { steps, log, approve: () => approve(), arrived };
}

// The environment in operation: the marks (projectbox-scenario.mjs), the manifest program, the stage cap in the opposite
// direction, the network root for the restoration.
function inOps(b, fn, values = {}) {
  return withOps(b.fd, async () => {
    const desired = { CBASE_MANIFEST_PROGRAM: b.aux.manifestSource, CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: b.s.root, ...values };
    const saved = Object.fromEntries(Object.keys(desired).map((k) => [k, process.env[k]]));
    try {
      for (const [k, v] of Object.entries(desired)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
}

// A copy of procedure.js with ONE sabotage, outside the tree, relative imports as absolute file URLs.
const sabotaged = new Map();
async function sabotage(name, old, fresh) {
  if (sabotaged.has(name)) return sabotaged.get(name);
  const text = fs.readFileSync(PROCEDURE, "utf8");
  assert.equal(text.split(old).length, 2, `Sabotage ${name}: the spot does not stand exactly once in procedure.js`);
  const dir = path.dirname(PROCEDURE);
  const rewritten = text.replace(old, fresh)
    .replace(/(from\s+|import\()"(\.{1,2}\/[^"]+)"/g, (_, before, rel) => `${before}"${pathToFileURL(path.resolve(dir, rel)).href}"`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-sabotage-"));
  sabotageFolder.push(folder);
  const target = path.join(folder, `procedure-${name}.mjs`);
  fs.writeFileSync(target, rewritten);
  const module = await import(pathToFileURL(target).href);
  sabotaged.set(name, module);
  return module;
}
const sabotageFolder = [];
test.after(() => { for (const d of sabotageFolder) fs.rmSync(d, { recursive: true, force: true }); });

// ── Checkers (return findings instead of throwing - the counter-tests expect them) ───────────────────────────────────────

const argsText = (a) => a.args.join(" ");
const inner = (b) => containerName(b.s.projectId);

/** Order and arguments of a successful relocation (1). */
function orderFindings(b) {
  const f = [];
  const a = b.calls();
  const idx = (pred) => a.findIndex(pred);
  const last = (pred) => { for (let i = a.length - 1; i >= 0; i--) if (pred(a[i])) return i; return -1; };
  const host = (x) => x.daemon === "host";
  const inside = (x) => x.daemon === inner(b);
  const old = new Set(Object.values(b.ids));

  const dry = idx((x) => inside(x) && x.args[0] === "compose" && x.args.includes("config"));
  const firstStop = idx((x) => host(x) && x.args[0] === "stop" && old.has(x.args.at(-1)));
  if (dry < 0 || firstStop < 0 || dry > firstStop) f.push("dry run config --hash not before the first stop");

  const stops = a.filter((x) => host(x) && x.args[0] === "stop" && x.args.some((y) => old.has(y))).map((x) => x.args);
  const desiredStops = [["stop", "-t", "30", b.ids.web], ["stop", "-t", "30", b.ids.db]];
  if (JSON.stringify(stops.slice(0, 2)) !== JSON.stringify(desiredStops)) f.push(`stops not "web, then db, by id with -t 30": ${JSON.stringify(stops)}`);
  if (stops.some((x) => x.includes(b.ids.migrate))) f.push("the finished migrate was stopped");
  const update = idx((x) => host(x) && x.args[0] === "update" && x.args[1] === "--restart=no");
  const lastStop = last((x) => host(x) && x.args[0] === "stop" && x.args.some((y) => old.has(y)) && x.args.includes("30"));
  if (update < 0 || update < lastStop) f.push("update --restart=no not after the last stop");
  else if (!(a[update].args.includes(b.ids.db) && a[update].args.includes(b.ids.web))) f.push("update --restart=no without db/web");

  const save = idx((x) => host(x) && x.args[0] === "save");
  if (save < 0 || JSON.stringify(a[save].args) !== JSON.stringify(["save", "postgres:16", "shop-web:latest"])) f.push("no `save <tags>` in B");
  if (idx((x) => host(x) && x.args[0] === "exec" && x.args.includes("-i") && argsText(x).endsWith(`${inner(b)} docker load`)) < 0) f.push("no `exec -i ... docker load`");
  if (a.some((x) => ["save", "load"].includes(x.args[0]) && (x.args.includes("-o") || x.args.includes("-i")))) f.push("image through a file instead of as a stream");

  const ups = a.map((x, i) => [x, i]).filter(([x]) => inside(x) && x.args[0] === "compose" && x.args.includes("up") && !x.args.includes("--dry-run")).map(([, i]) => i);
  if (ups.length < 2) f.push(`expected two \`up\` inside (8 and 12b), seen ${ups.length}`);
  const desiredUp = ["compose", "-p", "shop", "--project-directory", b.s.path, "-f", b.compose, "-f", b.override, "up", "--no-start", "--no-build", "--pull", "never", "db", "migrate", "web"];
  if (ups.length && JSON.stringify(a[ups[0]].args) !== JSON.stringify(desiredUp)) f.push(`first up with other arguments: ${argsText(a[ups[0]])}`);
  if (ups.length > 1 && a[ups[1]].args.includes(b.override)) f.push("12b with the override file put aside");
  const volCreate = idx((x) => inside(x) && x.args[0] === "volume" && x.args[1] === "create" && x.args.at(-1) === "shop_pgdata");
  const cpNamed = idx((x) => host(x) && x.args[0] === "exec" && x.args.includes("cp") && x.args.includes("/relocation/source/shop_pgdata/."));
  if (volCreate < 0 || cpNamed < 0 || volCreate > ups[0] || cpNamed > ups[0]) f.push("named volume not created and copied before 8");
  const cpAnon = idx((x) => host(x) && x.args[0] === "exec" && x.args.includes("cp") && x.args.includes(`/relocation/source/${b.anonB}/.`));
  if (cpAnon < 0 || cpAnon < ups.at(-1)) f.push("anonymous volume not copied after 10 (12b)");
  else {
    const web = Object.values(b.fd.state(inner(b)).container).find((c) => c.name === "shop-web-1");
    const target = web?.mounts.find((m) => m.Destination === "/app/cache")?.Name;
    if (!target || !a[cpAnon].args.includes(`/relocation/target/volumes/${target}/_data`)) f.push("anonymous volume not into the volume of the FINAL container");
  }
  // `config` only in the dry run; 12b asks Compose in the trial run (without override): control with `--force-recreate`,
  // trial run before the `up`, second after it. The dry run asks per Compose project `config --hash` AND once the model
  // (`config --format json`: env_file and the volumes without label).
  const configs = a.filter((x) => inside(x) && x.args[0] === "compose" && x.args.includes("config"));
  const kindOf = (x) => (x.args.includes("--hash") ? "hash" : x.args.includes("--format") ? "model" : "?");
  if (configs.map(kindOf).join(",") !== "hash,model") f.push(`expected inside exactly \`config --hash\`, then \`config --format json\` (dry run), seen ${configs.map(kindOf).join(",") || "none"}`);
  const probes = a.map((x, i) => [x, i]).filter(([x]) => inside(x) && x.args[0] === "compose" && x.args.includes("--dry-run"));
  const desiredProbe = ["compose", "--progress", "json", "--dry-run", "-p", "shop", "--project-directory", b.s.path, "-f", b.compose, "up", "--no-start", "--no-build", "--pull", "never"];
  if (probes.length !== 3) f.push(`expected three trial runs in 12b, seen ${probes.length}`);
  else {
    const [[k], [v, iv], [n, in_]] = probes;
    if (JSON.stringify(k.args) !== JSON.stringify([...desiredProbe, "--force-recreate", "db", "migrate", "web"])) f.push(`control with other arguments: ${argsText(k)}`);
    for (const x of [v, n]) if (JSON.stringify(x.args) !== JSON.stringify([...desiredProbe, "db", "migrate", "web"])) f.push(`trial run with other arguments: ${argsText(x)}`);
    if (ups.length > 1 && !(iv < ups[1] && ups[1] < in_)) f.push("the `up` in 12b does not lie between the two trial runs");
  }

  const check = last((x) => host(x) && x.args[0] === "exec" && argsText(x).includes("python3 /usr/local/bin/cbase-manifest -- /relocation/target/"));
  if (check < 0) f.push("no actual manifests at the target (check)");
  const rms = a.map((x, i) => [x, i]).filter(([x]) => host(x) && x.args[0] === "rm" && !x.args.includes("-v"));
  for (const [x, i] of rms) {
    const target = x.args.filter((y) => !y.startsWith("-"));
    if (target.length !== 2 || !HEX64.test(target[1])) f.push(`rm not by id: ${argsText(x)}`);
    if (old.has(target[1]) && i < check) f.push("rm before the check");
    if (old.has(target[1]) && x.args.includes("-f")) f.push("rm of an old container with -f");
  }
  if (rms.filter(([x]) => old.has(x.args.at(-1))).length !== 3) f.push(`not all three old containers removed by id (${rms.length} rm)`);
  return f;
}

/** The state after a return path (2). */
function returnPathFindings(b, result, step, log) {
  const f = [];
  if (result?.end !== "back") f.push(`End ${result?.end} instead of back (${result?.error || "-"})`);
  if (result?.step !== step) f.push(`Step ${result?.step} instead of ${step}`);
  const z = b.fd.state();
  const c = (d) => z.container[b.ids[d]];
  for (const d of ["db", "web", "migrate"]) if (!c(d)) f.push(`${d} removed`);
  if (c("db")?.status !== "running") f.push("db does not run");
  if (c("web")?.status !== "running") f.push("web does not run");
  if (c("migrate")?.status !== "exited") f.push("migrate no longer finished");
  if (c("db")?.restart !== "always") f.push(`Policy db ${c("db")?.restart || "no"} instead of always`);
  if (c("web")?.restart !== "unless-stopped") f.push(`Policy web ${c("web")?.restart || "no"} instead of unless-stopped`);
  for (const v of ["shop_pgdata", b.anonB]) if (!z.volumes[v]) f.push(`Volume ${v.slice(0, 12)} removed`);
  for (const r of ["postgres:16", "shop-web:latest"]) if (!z.images[r]) f.push(`Image ${r} removed`);
  for (const n of ["shop_default", "extnetz"]) if (!Object.values(z.networks).some((x) => x.name === n)) f.push(`Network ${n} removed`);
  if (Object.values(z.container).some((x) => x.name === containerName(b.s.projectId))) f.push("project container still there");
  if (z.volumes[volumeName(b.s.projectId)]) f.push("volume of the project container still there");
  if (Object.values(z.networks).some((x) => x.name === networkName(b.s.projectId))) f.push("network of the project container still there");
  if (Object.values(z.container).some((x) => x.labels["cbase.helper"])) f.push("helper left");
  if (store.projectInstance(b.s.projectId, "main")) f.push("instance row left");
  const j = store.relocationsOf(b.s.projectId).at(-1);
  if (j?.end !== "back" || j.endedAt === null) f.push(`Journal ${j?.end || "open"} instead of back`);
  if (b.calls().some((x) => x.daemon === "host" && x.args[0] === "rm" && Object.values(b.ids).includes(x.args.at(-1)))) f.push("old container removed");
  if (!fs.existsSync(b.override) || !fs.readFileSync(b.override).equals(b.overridePrior)) f.push("override not back");
  if (!fs.readFileSync(b.env).equals(b.envPrior)) f.push(".env not byte-equal");
  // The bait from `.env` appears nowhere even in the error case (journal with error text, log of the relocation).
  if (JSON.stringify(store.relocationsOf(b.s.projectId)).includes(SECRET)) f.push("value from .env in the journal");
  try { if (fs.readFileSync(path.join(j.location, "log.log"), "utf8").includes(SECRET)) f.push("value from .env in the log"); } catch { /* no log */ }
  const rw = log.filter((n) => n.endsWith("Back"));
  if (JSON.stringify(rw) !== JSON.stringify(["runtimeBack", "portDismantlingBack", "projectRepoBack"])) f.push(`return path of the data steps: ${rw.join(", ")}`);
  return f;
}

async function relocation(b, module, opts = {}) {
  const d = dataSteps(b, opts);
  const result = await inOps(b, () => module.startRelocation(b.s.projectId, { steps: d.steps, creation: b.s.opts }), opts.values);
  return { result, log: d.log };
}

// ── (1) Success ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function success(ctx, module) {
  const b = await build(ctx);
  try {
    const d = dataSteps(b, { hold: "portDismantling" });
    let during = null;
    const run = inOps(b, async () => {
      const p = module.startRelocation(b.s.projectId, { steps: d.steps, creation: b.s.opts });
      await d.arrived;
      const active = await json(`${ctx.base}/api/runs/active`);
      const lock = projectLocks(b.s.projectId, { reason: "relocation" });
      if (lock.ok) lock.resolve();
      during = { active, lock, row: store.projectInstance(b.s.projectId, "main") };
      d.approve();
      return p;
    });
    const result = await run;
    return { b, result, log: d.log, during };
  } catch (e) { b.fd.cleanUp(); throw e; }
}

test("(1) success: order on the wire, B empty, the stack runs inside, busy and lock during the relocation, no value from .env", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, result, log, during } = await success(ctx, procedureOriginal);
    try {
      assert.deepEqual(result.ok ? [] : [result.error], [], "the relocation failed");
      assert.equal(result.end, "finished");
      assert.deepEqual(orderFindings(b), []);
      // During the relocation (at the gate in the port dismantling): busy with projectWork, the row in `relocation`, the project locked.
      assert.equal(during.active.busy, true, JSON.stringify(during.active));
      assert.ok(during.active.projectWork.some((x) => x.projectId === b.s.projectId && x.state === "relocation"), JSON.stringify(during.active.projectWork));
      assert.ok(during.active.projectWork.some((x) => x.projectId === b.s.projectId && x.state === "heavyLoad"));
      assert.equal(during.row.state, "relocation");
      assert.equal(during.lock.ok, false, "the project was not locked during the relocation");
      // The data steps in their order, no return path.
      assert.deepEqual(log, ["portDismantling", "projectRepoStep", "relocateRuntime", "cleanUpAfterStart"]);
      // B: nothing left of the project.
      const z = b.fd.state();
      assert.deepEqual(Object.values(z.container).filter((c) => c.labels[L.project] === "shop"), []);
      assert.equal(z.volumes.shop_pgdata, undefined);
      assert.equal(z.volumes[b.anonB], undefined);
      assert.ok(z.images["postgres:16"], "a pulled image stays in B (case (15))");
      assert.equal(z.images["shop-web:latest"], undefined);
      assert.ok(!Object.values(z.networks).some((n) => n.name === "shop_default"), "the network of the Compose project stayed");
      // A network WITHOUT labels (extnetz, `external`) stays in B like a volume without a label - another project may lead it;
      // the report names it.
      assert.ok(Object.values(z.networks).some((n) => n.name === "extnetz"), "the network without labels was removed in B");
      assert.ok(!Object.values(z.container).some((c) => c.labels["cbase.helper"]), "helper left");
      // Inside: the stack, db and web run, migrate not started.
      const zi = b.fd.state(inner(b));
      const inside = Object.fromEntries(Object.values(zi.container).map((c) => [c.name, c.status]));
      assert.deepEqual(inside, { "shop-db-1": "running", "shop-web-1": "running", "shop-migrate-1": "created" });
      // Row, journal, report.
      const row = store.projectInstance(b.s.projectId, "main");
      assert.equal(row.state, "ready");
      assert.ok(row.convertedAt > 0);
      const snapshot = procedureOriginal.relocationStatus(b.s.projectId);
      assert.equal(snapshot.end, "finished");
      assert.ok(snapshot.duration.some((x) => x.step === "remove"), JSON.stringify(snapshot.duration));
      assert.equal(snapshot.report.remove.container.length, 3);
      assert.deepEqual(snapshot.report.remove.networks, ["shop_default"]);
      assert.ok(snapshot.report.remove.not.some((x) => x.startsWith("network extnetz: without a Compose label — stays in B")), JSON.stringify(snapshot.report.remove.not));
      assert.ok(fs.existsSync(path.join(snapshot.location, "report.json")));
      // The bait appears nowhere: journal (DB), log, report, command lines.
      const j = store.relocationsOf(b.s.projectId).at(-1);
      assert.ok(!JSON.stringify(j).includes(SECRET), "value from .env in the journal");
      for (const f of ["log.log", "report.json", "plan.json"]) assert.ok(!fs.readFileSync(path.join(j.location, f), "utf8").includes(SECRET), `value from .env in ${f}`);
      assert.ok(!JSON.stringify(b.fd.calls()).includes(SECRET), "value from .env in a command line");
      // The helpers: sources read-only, the manifest program bound read-only and called through manifestArgv, cp -a.
      const runs = b.calls().filter((x) => x.daemon === "host" && x.args[0] === "run" && x.args.includes("cbase.helper=relocation"));
      assert.ok(runs.length >= 4, `helpers: ${runs.length}`);
      for (const r of runs) {
        const mounts = r.args.filter((_, k) => r.args[k - 1] === "--mount");
        for (const m of mounts.filter((x) => x.includes("dst=/relocation/source/"))) assert.ok(m.endsWith(",readonly"), `source not read-only: ${m}`);
        for (const m of mounts.filter((x) => x.includes("dst=/usr/local/bin/cbase-manifest"))) assert.ok(m.startsWith("type=bind,") && m.endsWith(",readonly"), m);
        assert.ok(!r.args.includes("-v") && !r.args.includes("-p"), "helper with -v/-p");
      }
      const programs = readJsonl(b.aux.log);
      assert.ok(programs.some((x) => x.prog === "python3" && x.argv[0] === "/usr/local/bin/cbase-manifest" && x.argv[1] === "--"));
      assert.ok(programs.filter((x) => x.prog === "cp").length === 2 && programs.filter((x) => x.prog === "cp").every((x) => x.argv[0] === "-a" && x.argv[1] === "--"));
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-a) counter-test: \"remove\" before \"check\" => the order checker reports rm before the check", async () => {
  const module = await sabotage("remove-before-check",
    `"project-repo", "anonymous-volumes", "runtime", "check", "start", "recheck", "remove", "completion",`,
    `"project-repo", "anonymous-volumes", "runtime", "remove", "check", "start", "recheck", "completion",`);
  await withAgentsServer(async (ctx) => {
    const { b } = await success(ctx, module);
    try {
      assert.ok(orderFindings(b).includes("rm before the check"), JSON.stringify(orderFindings(b)));
    } finally { b.fd.cleanUp(); }
  });
});

// ── (2) Return path at every step 3-14 ─────────────────────────────────────────────────────────────────────────────

// Per step the error: at the fake docker (daemon: "host" = B, "inside" = the project container) or as a data step.
const ERROR = [
  ["creation", { docker: { daemon: "host", pattern: "^volume create .*cbase-p-" } }],
  // The error message carries the bait from `.env` (the alternative in the pattern stands in the message of the fake docker) -
  // like a Compose error that names a resolved value.
  ["dryrun", { docker: { daemon: "inside", pattern: `^compose .* config --hash|${SECRET}` } }],
  ["stop", { docker: { daemon: "host", pattern: "^update --restart=no" } }],
  ["images", { docker: { daemon: "inside", pattern: "^load" } }],
  ["volumes", { docker: { daemon: "inside", pattern: "^volume create" } }],
  ["networks", { docker: { daemon: "inside", pattern: "^network create extnetz" } }],
  ["equality", { docker: { daemon: "inside", pattern: "^compose .* up " } }],
  ["port-dismantling", { raises: "portDismantling" }],
  ["new-hash", { docker: { daemon: "inside", pattern: "^compose --progress json --dry-run " } }],
  ["project-repo", { raises: "projectRepoStep" }],
  ["anonymous-volumes", { docker: { daemon: "host", pattern: "^exec -u 0 [0-9a-f]{64} cp -a -- /relocation/source/[0-9a-f]{64}/" } }],
  ["runtime", { raises: "relocateRuntime" }],
  ["check", { deviation: true }],
];

async function withError(ctx, module, step, kind, built = null) {
  const b = built || await build(ctx);
  if (kind.docker) b.fd.errorAt([{ ...kind.docker, daemon: kind.docker.daemon === "inside" ? inner(b) : kind.docker.daemon }]);
  if (kind.deviation) fs.writeFileSync(b.aux.deviation, "");
  const { result, log } = await relocation(b, module, { raises: kind.raises || null });
  return { b, result, log };
}

test("(2) an error at every step 3-14 => return path: nothing removed, old containers run, policies back, override and .env byte-equal", async () => {
  await withAgentsServer(async (ctx) => {
    for (const [step, kind] of ERROR) {
      const { b, result, log } = await withError(ctx, procedureOriginal, step, kind);
      try {
        assert.deepEqual(returnPathFindings(b, result, step, log), [], `error in "${step}"`);
        // The reason is in the journal (column and report) and in the answer - it was not lost with the return path.
        const j = store.relocationsOf(b.s.projectId).at(-1);
        assert.ok(String(j.error).startsWith(`step "${step}"`), `${step}: journal error "${j.error}"`);
        assert.ok(String(j.report?.returnPath?.reason).startsWith(`step "${step}"`), `${step}: reason in the report ${JSON.stringify(j.report?.returnPath)}`);
        assert.ok(String(result.error).startsWith(`step "${step}"`), `${step}: answer "${result.error}"`);
        // If `up` fails in "equality", the names of the containers it should create are already in the journal.
        if (step === "equality") assert.deepEqual(j.insideIds?.containerNames, ["shop-db-1", "shop-migrate-1", "shop-web-1"], JSON.stringify(j.insideIds));
      } finally { b.fd.cleanUp(); }
    }
  });
});

test("(G-b) counter-test: return path without the old policies => the return-path checker reports them", async () => {
  const module = await sabotage("without-policies", `    if (!p || p === "no") continue;`, "    continue;");
  await withAgentsServer(async (ctx) => {
    const { b, result, log } = await withError(ctx, module, "images", ERROR.find(([n]) => n === "images")[1]);
    try {
      const f = returnPathFindings(b, result, "images", log);
      assert.ok(f.some((x) => x.startsWith("Policy db")), JSON.stringify(f));
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-e) counter-test: Compose error without blacking out => the return-path checker finds the value from .env in the journal", async () => {
  const module = await sabotage("without-redact", `    for (const w of envValues(g)) row = row.split(w).join("***");\n`, "");
  await withAgentsServer(async (ctx) => {
    const { b, result, log } = await withError(ctx, module, "dryrun", ERROR.find(([n]) => n === "dryrun")[1]);
    try {
      const f = returnPathFindings(b, result, "dryrun", log);
      assert.ok(f.includes("value from .env in the journal"), JSON.stringify(f));
    } finally { b.fd.cleanUp(); }
  });
});

// ── (3) Preconditions ────────────────────────────────────────────────────────────────────────────────────────────

test("(3) preconditions: hold reason, locked, heavy load occupied, open journal => 409, no journal row, no docker", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const pid = b.s.projectId;
      const expect = async (code, prior) => {
        const count = store.relocationsOf(pid).length;
        const d = dataSteps(b);
        let error = null;
        await inOps(b, async () => {
          const cleanUp = prior?.();
          try { await procedureOriginal.startRelocation(pid, { steps: d.steps, creation: b.s.opts }); }
          catch (e) { error = e; }
          finally { cleanUp?.(); }
        });
        assert.ok(error, `${code}: no error`);
        assert.equal(error.code, code, `${code}: ${error.message}`);
        assert.equal(error.status, 409);
        assert.equal(store.relocationsOf(pid).length, count, `${code}: journal row created`);
        assert.deepEqual(b.calls(), [], `${code}: docker called`);
        assert.equal(store.projectInstance(pid, "main"), null);
      };
      b.plan = planFrom(b, { holdReasons: [{ kind: "worktree-outside", text: "…" }] });
      await expect("HOLD");
      b.plan = planFrom(b);
      await expect("NOT_IDLE", () => { const s = projectLocks(pid, { reason: "relocation" }); assert.ok(s.ok); return () => s.resolve(); });
      await expect("HEAVY_LOAD_OCCUPIED", () => occupyHeavyLoad("relocation", { projectId: "other-project" }));
      const open = store.createRelocation({ projectId: pid, instance: "main", location: path.join(ctx.root, "open") });
      try { await expect("RELOCATION_OPEN"); } finally { store.deleteRelocation(open.id); }
      // The half relocation of ANOTHER project, not yet decided by the restart, needs the heavy load first.
      const foreign = store.createRelocation({ projectId: "other-project", instance: "main", location: path.join(ctx.root, "foreign") });
      try { await expect("RELOCATION_ELSEWHERE"); } finally { store.deleteRelocation(foreign.id); }
      // Afterwards the project is free: the lock can be set.
      await inOps(b, async () => { const s = projectLocks(pid, { reason: "relocation" }); assert.ok(s.ok, "lock stayed"); s.resolve(); });
    } finally { b.fd.cleanUp(); }
  });
});

// ── (4) Restart ──────────────────────────────────────────────────────────────────────────────────────────────────

// Drive the relocation by hand up to before `announced` and announce `announced` without doing it - a crash in the middle
// of the step. Afterwards no procedure lives (the occupancy is released).
async function untilCrash(b, d, announced) {
  return inOps(b, () => withProjectOccupancy(b.s.projectId, "relocation", async () => {
    const location = createRelocationLocation({ data: DIRS.data, projectId: b.s.projectId, time: relocationTime() });
    const row = store.createRelocation({ projectId: b.s.projectId, instance: "main", location });
    const k = procedureOriginal.relocationContext(row, { steps: d.steps, creation: b.s.opts, plan: b.plan });
    await k.journal.note({ plan: b.plan });
    const w = procedureOriginal.relocationEffects(k);
    for (const n of procedureOriginal.RELOCATION_JOURNAL.forward) {
      if (n === announced) break;
      await k.journal.step(n, w[n]);
    }
    store.writeRelocation(row.id, { direction: "forward", step: announced });
    return row.id;
  }));
}

// The restart "project-instances": the decider of the module for THIS project; the promise of its procedure.
async function restartGrace(b, module, d) {
  const seam = module.relocationRestartGraceSeam({ steps: d.steps, creation: b.s.opts });
  let run = null;
  return inOps(b, async () => {
    setRelocationDecider((e) => { if (e.projectId === b.s.projectId) run = seam.decider(e); return run; });
    instancesRestartGrace();
    assert.ok(run, "the decider was not called");
    return run;
  });
}

async function beforeTheTurnaround(ctx, module) {
  const b = await build(ctx);
  const d = dataSteps(b);
  await untilCrash(b, d, "networks");
  const result = await restartGrace(b, module, d);
  return { b, result, log: d.log };
}

async function afterTheTurn(ctx, module) {
  const b = await build(ctx, { stopsInside: true });
  const d = dataSteps(b);
  await untilCrash(b, d, "recheck");
  // The restart of B: the project container stands, with it its dockerd (stopsInside).
  const beforeRestart = b.calls().length;
  dx(b.fd, "stop", containerName(b.s.projectId));
  const result = await restartGrace(b, module, d);
  const a = b.calls().slice(beforeRestart + 1);
  const f = [];
  if (result?.end !== "finished") f.push(`End ${result?.end} (${result?.error || "-"})`);
  const startProject = a.findIndex((x) => x.daemon === "host" && x.args[0] === "start");
  const startInside = a.findIndex((x) => x.daemon === inner(b) && x.args[0] === "start");
  const firstRm = a.findIndex((x) => x.daemon === "host" && x.args[0] === "rm" && Object.values(b.ids).includes(x.args.at(-1)));
  if (startProject < 0) f.push("the project container was not started");
  if (startInside < 0) f.push("the stages inside were not started");
  if (firstRm < 0) f.push("no rm of the old containers");
  if (startProject >= 0 && firstRm >= 0 && firstRm < startProject) f.push("rm before the start");
  if (startInside >= 0 && firstRm >= 0 && firstRm < startInside) f.push("rm before the start of the stages inside");
  const inside = Object.fromEntries(Object.values(b.fd.state(inner(b)).container).map((c) => [c.name, c.status]));
  if (inside["shop-db-1"] !== "running" || inside["shop-web-1"] !== "running") f.push(`not everything runs inside: ${JSON.stringify(inside)}`);
  if (store.projectInstance(b.s.projectId, "main")?.state !== "ready") f.push("row not ready");
  return { b, f };
}

test("(4a) restart BEFORE the turnaround (crashed in \"networks\") => return path", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, result, log } = await beforeTheTurnaround(ctx, procedureOriginal);
    try {
      assert.deepEqual(returnPathFindings(b, result, null, log).filter((x) => !x.startsWith("Step")), []);
      assert.equal(result.ok, false);
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-c) counter-test: turnaround at \"creation\" => the restart before the turnaround goes forward, the checker reports it", async () => {
  const module = await sabotage("apply-creation", `  pivot: "start",`, `  pivot: "creation",`);
  await withAgentsServer(async (ctx) => {
    const { b, result, log } = await beforeTheTurnaround(ctx, module);
    try {
      const f = returnPathFindings(b, result, null, log);
      assert.ok(f.some((x) => x.startsWith("End")), JSON.stringify(f));
    } finally { b.fd.cleanUp(); }
  });
});

test("(4b) restart AFTER the turnaround (before \"recheck\", everything stands) => first start, then renewed check, then rm", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, f } = await afterTheTurn(ctx, procedureOriginal);
    try {
      assert.deepEqual(f, []);
      assert.equal(procedureOriginal.relocationStatus(b.s.projectId).end, "finished");
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-d) counter-test: restart after the turnaround without the start first => the checker reports it", async () => {
  const module = await sabotage("without-start", `            await stepStart(ctx);\n`, "");
  await withAgentsServer(async (ctx) => {
    const { b, f } = await afterTheTurn(ctx, module);
    try {
      assert.ok(f.length > 0, "the sabotage went unnoticed");
    } finally { b.fd.cleanUp(); }
  });
});

// ── (8)-(13) return path ─────────────────────────────────────────────────────────────────────────────────────────

// A test that turns red must not hang: a row that stayed in a working state (a hold) would hold the quiet of the harness
// (`projectInstances`) forever - it goes in the finally.
function rowApprove(pid) {
  const z = store.projectInstance(pid, "main");
  if (z && store.PROJECT_WORK_STATES.includes(z.state)) store.deleteProjectInstance(pid, "main");
}

// (8) a return-path part fails (the start of db), a one-off container with AutoRemove is gone at the stop. The reason
// (images) stands in the journal BEFORE the return path; when runtimeBack runs, the test records journal and row.
async function returnPathPartial(ctx, module) {
  const b = await build(ctx);
  const pid = b.s.projectId;
  dx(b.fd, "run", "-d", "--rm", "--name", "shop-cli-run-0a1b2c3d4e5f", "--label", `${L.project}=shop`, "--label", `${L.service}=cli`,
    "--label", "com.docker.compose.oneoff=True", "--label", `com.docker.compose.project.working_dir=${b.s.path}`, "shop-web:latest");
  b.plan = planFrom(b);
  b.fd.errorAt([{ daemon: inner(b), pattern: "^load" }, { daemon: "host", pattern: `^start ${b.ids.db}$` }]);
  const d = dataSteps(b);
  const at = {};
  const runtimeBack = d.steps.runtimeBack;
  d.steps.runtimeBack = async (k) => {
    at.journal = store.relocationsOf(pid).at(-1)?.error ?? null;
    at.row = store.projectInstance(pid, "main");
    return runtimeBack(k);
  };
  const result = await inOps(b, () => module.startRelocation(pid, { steps: d.steps, creation: b.s.opts }));
  return { b, result, log: d.log, at };
}

/** The state after a return path with a failed part (8): named end, nothing locked, nothing not-yet-recovered deleted. */
function partialFindings(b, result, log, at) {
  const f = [];
  if (result?.end !== "back") f.push(`End ${result?.end} instead of back (${result?.error || "-"})`);
  if (!String(result?.error).startsWith('step "images"')) f.push(`reason in the answer: ${result?.error}`);
  if (!(result?.returnPathError || []).some((x) => x.step === "rw-old-start" && x.text.includes("shop-db-1"))) f.push(`failed start of db not named: ${JSON.stringify(result?.returnPathError)}`);
  if (!(result?.gone || []).some((x) => x.includes("shop-cli-run-0a1b2c3d4e5f"))) f.push(`AutoRemove container not named as gone: ${JSON.stringify(result?.gone)}`);
  const z = b.fd.state();
  if (!z.container[b.ids.db]) f.push("db removed (did not come back - must not be deleted)");
  if (z.container[b.ids.web]?.status !== "running") f.push("web does not run");
  if (z.container[b.ids.db]?.restart !== "always") f.push(`Policy db ${z.container[b.ids.db]?.restart || "no"} instead of always`);
  if (z.container[b.ids.web]?.restart !== "unless-stopped") f.push("policy web not back");
  if (store.projectInstance(b.s.projectId, "main")) f.push("instance row left (the project would stay locked in \"relocation\")");
  const j = store.relocationsOf(b.s.projectId).at(-1);
  if (j?.end !== "back" || j.endedAt === null) f.push(`Journal ${j?.end || "open"} instead of back`);
  const jf = String(j?.error);
  if (!jf.startsWith('step "images"') || !jf.includes("return path partial") || !jf.includes("rw-old-start")) f.push(`journal error: ${jf}`);
  if (!log.includes("projectRepoBack")) f.push("the return path did not continue after the failed part");
  if (!String(at.journal).startsWith('step "images"')) f.push(`reason not in the journal BEFORE the return path: ${at.journal}`);
  if (!String(at.row?.error).includes('step "images"')) f.push(`reason not on the row BEFORE the return path: ${at.row?.error}`);
  return f;
}

test("(8) a failed return-path part => the return path continues, end \"back\" with reason and named parts, AutoRemove = done, restartable", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, result, log, at } = await returnPathPartial(ctx, procedureOriginal);
    try {
      assert.deepEqual(partialFindings(b, result, log, at), []);
      // Restartable: the reason is fixed (db starts again), a new plan, a second relocation runs through.
      b.fd.errorAt([]);
      dx(b.fd, "start", b.ids.db);
      b.plan = planFrom(b);
      const { result: second } = await relocation(b, procedureOriginal);
      assert.equal(second.end, "finished", second.error);
    } finally { rowApprove(b.s.projectId); b.fd.cleanUp(); }
  });
});

test("(G-f) counter-test: return path aborts at the first failed part => the checker of (8) reports the open end", async () => {
  // `holds` (rw-completion) also stops the return path - the spot carries both marks.
  const module = await sabotage("return-path-aborts-early", "      if (e?.endangered || e?.holds) throw e;\n", "      throw e;\n");
  await withAgentsServer(async (ctx) => {
    const { b, result, log, at } = await returnPathPartial(ctx, module);
    try {
      const f = partialFindings(b, result, log, at);
      assert.ok(f.some((x) => x.startsWith("End open")) && f.some((x) => x.startsWith("instance row left")), JSON.stringify(f));
    } finally { rowApprove(b.s.projectId); b.fd.cleanUp(); }
  });
});

test("(9) a return path that deleted data in the ONLY place (instance converted) holds, named - hold-return-path with way out, the way out leads back", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const pid = b.s.projectId;
    try {
      const d = dataSteps(b);
      await untilCrash(b, d, "networks");
      // The instance carries `converted_at`: something may have arisen inside that exists nowhere else.
      store.changeProjectInstance(pid, "main", { convertedAt: Date.now() });
      const result = await restartGrace(b, procedureOriginal, d);
      assert.equal(result.end, "open", JSON.stringify(result));
      assert.equal(result.direction, "backward");
      assert.match(result.wayOut, /\/relocation\/resume/);
      const row = store.projectInstance(pid, "main");
      assert.deepEqual([row.state, row.phase], ["relocation", "hold-return-path"]);
      assert.match(row.error, /already converted/);
      assert.match(row.error, /restart grace before the turnaround/, "the reason of the return path is missing on the row");
      assert.match(row.error, /\/relocation\/resume/);
      const z = b.fd.state();
      assert.ok(Object.values(z.container).some((c) => c.name === containerName(pid)), "the project container was removed");
      assert.ok(z.volumes[volumeName(pid)], "its volume was removed");
      assert.ok(!d.log.includes("runtimeBack"), "the runtime folder was touched");
      const j = store.relocationsOf(pid).at(-1);
      assert.equal(j.endedAt, null);
      assert.match(String(j.report?.returnPath?.hold?.text), /rw-runtime/);
      const snapshot = procedureOriginal.relocationStatus(pid);
      assert.equal(snapshot.alive, false);
      assert.match(snapshot.wayOut, /\/relocation\/resume/);
      // The way out, once the reason is fixed: the second way takes the return path to the end.
      store.changeProjectInstance(pid, "main", { convertedAt: null });
      const two = await inOps(b, () => procedureOriginal.resumeRelocation(pid, { steps: d.steps, creation: b.s.opts }).run);
      assert.deepEqual(returnPathFindings(b, two, null, d.log).filter((x) => !x.startsWith("Step")), []);
    } finally { rowApprove(pid); b.fd.cleanUp(); }
  });
});

test("(10) the project container does not start in the restart (converted_at empty) => return path instead of a hold after the turnaround", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const pid = b.s.projectId;
    try {
      const d = dataSteps(b);
      await untilCrash(b, d, "start");
      assert.equal(store.projectInstance(pid, "main")?.convertedAt ?? null, null);
      const projectC = Object.values(b.fd.state().container).find((c) => c.name === containerName(pid));
      dx(b.fd, "stop", projectC.id);
      b.fd.errorAt([{ daemon: "host", pattern: `^start ${projectC.id}$` }]);
      const result = await restartGrace(b, procedureOriginal, d);
      assert.deepEqual(returnPathFindings(b, result, "start", d.log), []);
    } finally { rowApprove(pid); b.fd.cleanUp(); }
  });
});

// (11) crashed in "remove" (the check had passed); afterwards a container is missing inside.
async function fromRemove(ctx, module) {
  const b = await build(ctx, { stopsInside: true });
  const d = dataSteps(b);
  await untilCrash(b, d, "remove");
  dx(b.fd, "exec", containerName(b.s.projectId), "docker", "rm", "-f", "shop-web-1");
  const prior = b.calls().length;
  const result = await restartGrace(b, module, d);
  const old = new Set(Object.values(b.ids));
  const rms = b.calls().slice(prior).filter((x) => x.daemon === "host" && x.args[0] === "rm" && old.has(x.args.at(-1)));
  const f = [];
  if (rms.length) f.push(`old containers removed although shop-web-1 is missing inside: ${rms.map(argsText).join("; ")}`);
  if (result?.end !== "open") f.push(`End ${result?.end}`);
  for (const n of ["db", "web", "migrate"]) if (!b.fd.state().container[b.ids[n]]) f.push(`${n} missing in B`);
  return { b, result, f };
}

test("(11) restart from \"remove\" checks again before the rm - if a container is missing inside, B stays untouched", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, result, f } = await fromRemove(ctx, procedureOriginal);
    try {
      assert.deepEqual(f, []);
      assert.equal(result.step, "recheck");
      const row = store.projectInstance(b.s.projectId, "main");
      assert.equal(row.state, "ready");
      assert.match(row.error, /recheck.*shop-web-1.*\/relocation\/resume/);
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-g) counter-test: restart from \"remove\" without the renewed check => the checker of (11) reports the rm", async () => {
  const module = await sabotage("without-recheck",
    `            if (from === "remove") { setPhase(ctx, "recheck"); await stepRecheck(ctx); }\n`, "");
  await withAgentsServer(async (ctx) => {
    const { b, f } = await fromRemove(ctx, module);
    try {
      assert.ok(f.some((x) => x.startsWith("old containers removed")), JSON.stringify(f));
    } finally { b.fd.cleanUp(); }
  });
});

test("(12) \"stop\" re-reads the containers after lock and idle - one started since the plan => return path, nothing stopped", async () => {
  await withAgentsServer(async (ctx) => {
    for (const kind of ["working_dir", "volume"]) {
      const b = await build(ctx);
      try {
        if (kind === "working_dir") {
          dx(b.fd, "run", "-d", "--name", "shop-worker-1", "--label", `${L.project}=shop`, "--label", `com.docker.compose.project.working_dir=${b.s.path}`, "shop-web:latest");
        } else {
          dx(b.fd, "run", "-d", "--name", "foreign-1", "--mount", "type=volume,src=shop_pgdata,dst=/data", "postgres:16");
        }
        const { result, log } = await relocation(b, procedureOriginal);
        assert.deepEqual(returnPathFindings(b, result, "stop", log), [], kind);
        assert.match(result.error, kind === "working_dir" ? /shop-worker-1/ : /foreign-1.*shop_pgdata/, kind);
        assert.deepEqual(b.calls().filter((x) => x.daemon === "host" && ["stop", "update"].includes(x.args[0])).map(argsText), [], `${kind}: stopped`);
      } finally { rowApprove(b.s.projectId); b.fd.cleanUp(); }
    }
  });
});

// (12b) re-reading in "stop" used to leave out every container with ANY `cbase.` key - also one that only inherits it from its
// image (the fake docker inherits image labels like the real one). Now only an own key ON the container counts
// (projectbox/own-labels.js), and a container of cbase on a volume of the plan is a deviation too. Counter-proof: with the
// old procedure.js both cases pass the re-reading (red).
const IDC = "c3".repeat(32);
test("(12b) \"stop\" overlooks no container because of a cbase. label - an inherited one does not count, a container of cbase on a plan volume is a deviation", async () => {
  await withAgentsServer(async (ctx) => {
    const findings = {}; // collected per case - the counter-proof shows both cases red, not only the first
    for (const kind of ["image-label", "own-on-volume"]) {
      const b = await build(ctx, { images: { "labelled:1": { id: IDC, labels: { "cbase.acceptance": "acceptance-1", "cbase.anything": "yes" } } } });
      try {
        if (kind === "image-label") {
          dx(b.fd, "run", "-d", "--name", "shop-worker-1", "--label", `${L.project}=shop`, "--label", `com.docker.compose.project.working_dir=${b.s.path}`, "labelled:1");
        } else {
          dx(b.fd, "run", "-d", "--name", "cbase-p-other", "--label", "cbase.project=other", "--label", "cbase.instance=main", "--mount", "type=volume,src=shop_pgdata,dst=/data", "cbase-projectbox:latest");
        }
        const { result, log } = await relocation(b, procedureOriginal);
        const f = returnPathFindings(b, result, "stop", log);
        const pattern = kind === "image-label"
          ? /shop-worker-1: added since the plan \(working_dir in the project\)/
          : /cbase-p-other \(left out as a container of cbase: cbase\.project, cbase\.instance\): mounts shop_pgdata/;
        if (!pattern.test(String(result.error || ""))) f.push(`error text: ${result.error || "-"}`);
        const stopped = b.calls().filter((x) => x.daemon === "host" && ["stop", "update"].includes(x.args[0])).map(argsText);
        if (stopped.length) f.push(`stopped: ${stopped.length} call(s)`);
        if (f.length) findings[kind] = f;
      } finally { rowApprove(b.s.projectId); b.fd.cleanUp(); }
    }
    assert.deepEqual(findings, {});
  });
});

// (13) `lsof` in the project container is a fake (argv-driven, reads the groups from a file): the group of a service is the
// one that holds its log file open (the shell), its listening stands in `-iTCP -sTCP:LISTEN`.
function fakeLsof(dir, groupsFile) {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, "fake-lsof.cjs");
  fs.writeFileSync(js, `const fs = require("fs");
const argv = process.argv.slice(2);
const G = JSON.parse(fs.readFileSync(${JSON.stringify(groupsFile)}, "utf8"));
if (argv.includes("-iTCP")) {
  process.stdout.write(G.map((g) => "p" + (7000 + g.pgid) + "\\ng" + g.pgid + "\\nf5\\nn*:" + g.port + "\\n").join(""));
  process.exit(0);
}
const i = argv.indexOf("--");
const file = i >= 0 ? String(argv[i + 1] || "") : "";
const g = G.find((x) => file.endsWith("_" + x.serviceId + ".log"));
if (g) { process.stdout.write("p" + (7000 + g.pgid) + "\\ng" + g.pgid + "\\nf1\\n"); process.exit(0); }
process.exit(1);
`);
  const sh = path.join(dir, "fake-lsof");
  fs.writeFileSync(sh, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 });
  return sh;
}

test("(13) a native service listens on another port after the start => the row carries the measured one, the old one is in the report", async () => {
  await withAgentsServer(async (ctx) => {
    const dir = path.join(ctx.root, "lsof");
    const groupsFile = path.join(dir, "groups.json");
    const b = await build(ctx, { programs: { lsof: fakeLsof(dir, groupsFile) }, instanceIp: "127.0.0.1" });
    const pid = b.s.projectId;
    const pids = [];
    try {
      const api = store.addProjectService(pid, { name: "api", port: 47391, startCommand: "exec sleep 3600" });
      const worker = store.addProjectService(pid, { name: "worker", port: 47393, startCommand: "exec sleep 3600" });
      fs.writeFileSync(groupsFile, JSON.stringify([{ serviceId: api.id, pgid: 501, port: 47392 }, { serviceId: worker.id, pgid: 601, port: 47393 }]));
      // Started in B WITH the operating marker (the identity of the group, services.js ownGroupAlive).
      await inOps(b, async () => {
        for (const s of [api, worker]) startSimple({ projectId: pid, service: s, cwd: b.s.path, projectName: "native", workspaceId: ctx.ws.id });
        const l = nativeRuns(pid);
        pids.push(...l.map((x) => x.pid));
        assert.deepEqual(l.map((x) => x.serviceId).sort(), [api.id, worker.id].sort());
      });
      const { result } = await relocation(b, procedureOriginal, { values: { CBASE_RELOCATION_PORT_MS: "300" } });
      assert.equal(result.end, "finished", result.error);
      const j = store.relocationsOf(pid).at(-1);
      const ports = j.report?.start?.ports || [];
      assert.deepEqual(ports.find((p) => p.id === api.id), { id: api.id, name: "api", prior: 47391, measured: 47392, finding: "implemented" }, JSON.stringify(ports));
      assert.deepEqual(ports.find((p) => p.id === worker.id), { id: worker.id, name: "worker", port: 47393, finding: "listens" }, JSON.stringify(ports));
      assert.equal(store.getProjectService(api.id).port, 47392, "the row does not carry the measured port");
      assert.equal(store.getProjectService(worker.id).port, 47393);
      assert.match(fs.readFileSync(path.join(j.location, "log.log"), "utf8"), /listens on 47392 instead of 47391/);
    } finally {
      for (const p of pids) { try { process.kill(-p, "SIGKILL"); } catch { /* gone */ } }
      rowApprove(pid);
      b.fd.cleanUp();
    }
  });
});

// ── (7) Native services in B (step 4 and return path 4) ──────────────────────────────────────────────────────────────

test("(7) a native service in B: step 4 ends its group and empties RUNS (journal first), the return path starts it again", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const pids = [];
    try {
      const svc = store.addProjectService(b.s.projectId, { name: "native", startCommand: "exec sleep 3600" });
      // In B the operating marker carries every start: only with it does the run remember the start time of its group - an
      // entry without it would count as foreign in the relocation (after a swap of B every old group is dead).
      await inOps(b, async () => startSimple({ projectId: b.s.projectId, service: svc, cwd: b.s.path, projectName: "native", workspaceId: ctx.ws.id }));
      const prior = nativeRuns(b.s.projectId);
      assert.deepEqual(prior.map((l) => l.serviceId), [svc.id]);
      pids.push(prior[0].pid);
      const { result, log } = await withError(ctx, procedureOriginal, "images", ERROR.find(([n]) => n === "images")[1], b);
      assert.deepEqual(returnPathFindings(b, result, "images", log), []);
      const j = store.relocationsOf(b.s.projectId).at(-1);
      assert.deepEqual(j.container.native, [svc.id], "the native service was not in the journal");
      assert.throws(() => process.kill(prior[0].pid, 0), "the old group is still alive");
      const after = nativeRuns(b.s.projectId);
      pids.push(...after.map((l) => l.pid));
      assert.deepEqual(after.map((l) => l.serviceId), [svc.id], "the return path did not restart the service");
      assert.notEqual(after[0].pid, prior[0].pid);
    } finally {
      for (const p of pids) { try { process.kill(-p, "SIGKILL"); } catch { /* gone */ } }
      b.fd.cleanUp();
    }
  });
});

// ── (18) no process in B stays behind in the project ─────────────────────────────────────────────────────────────

// A real process with its working dir in the project folder, in its own group (like a dev server from a terminal of B).
function foreignProcess(cwd) {
  const subprocess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { cwd, stdio: "ignore", detached: true });
  subprocess.unref();
  return subprocess.pid;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("(18a) a process that works in the project folder only AFTER the plan => return path in \"stop\" before the first stop, nothing stopped", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx); // the plan stands (b.plan, without hold reason) - the process comes afterwards
    let foreign = null;
    try {
      foreign = foreignProcess(path.join(b.s.path, "repo"));
      const fp = fakeProc(path.join(ctx.root, `proc-18a-${b.s.projectId}`));
      fp.process({ pid: foreign, cwd: path.join(b.s.path, "repo"), comm: "node", pgid: foreign, sid: foreign, start: 4711 });
      setProcessSeam({ root: fp.root, quietMs: 0 });
      const { result, log } = await relocation(b, procedureOriginal);
      assert.deepEqual(returnPathFindings(b, result, "stop", log), []);
      assert.match(String(result.error), new RegExp(`before the first stop — nothing stopped\\): pid ${foreign} \\(node, Start proc:4711\\)`));
      assert.deepEqual(b.calls().filter((x) => x.daemon === "host" && ["stop", "update"].includes(x.args[0])).map(argsText), [], "stopped");
      assert.ok(alive(foreign), "cbase ended the foreign process");
    } finally {
      setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
      if (foreign) { try { process.kill(foreign, "SIGKILL"); } catch { /* gone */ } }
      rowApprove(b.s.projectId);
      b.fd.cleanUp();
    }
  });
});

test("(18b) a process that survives the ending of the group of a native run => second look after endNativeRuns, return path: containers and native service run again", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const groups = [];
    let foreign = null;
    try {
      const svc = store.addProjectService(b.s.projectId, { name: "native", startCommand: "exec sleep 3600" });
      await inOps(b, async () => startSimple({ projectId: b.s.projectId, service: svc, cwd: b.s.path, projectName: "native", workspaceId: ctx.ws.id }));
      const [run] = nativeRuns(b.s.projectId);
      assert.equal(run?.serviceId, svc.id);
      groups.push(run.pid);
      // The outlier: at the first look a member of the captured group (exempt), in truth in its own group - ending the group
      // does not hit it (like a real process whose pid/pgid was overwritten in the run).
      foreign = foreignProcess(b.s.path);
      const fp = fakeProc(path.join(ctx.root, `proc-18b-${b.s.projectId}`));
      fp.process({ pid: foreign, cwd: b.s.path, comm: "node", pgid: run.pid, sid: run.pid, start: 4712 });
      setProcessSeam({ root: fp.root, quietMs: 0 });
      const { result, log } = await relocation(b, procedureOriginal);
      assert.deepEqual(returnPathFindings(b, result, "stop", log), []);
      assert.match(String(result.error), new RegExp(`after ending the native services\\): pid ${foreign} \\(node, Start proc:4712\\)`));
      // The return path came AFTER the stop: it was stopped, and everything runs again (returnPathFindings: db/web run, policies back).
      assert.ok(b.calls().some((x) => x.daemon === "host" && x.args[0] === "stop"), "no stop - the second look was not reached");
      const j = store.relocationsOf(b.s.projectId).at(-1);
      assert.deepEqual(j.container?.native, [svc.id], "the native service was not in the journal");
      assert.equal(alive(run.pid), false, "the group of the native run is still alive - step 4 did not end it");
      const fresh = nativeRuns(b.s.projectId);
      groups.push(...fresh.map((l) => l.pid));
      assert.deepEqual(fresh.map((l) => l.serviceId), [svc.id], "the return path did not restart the native service");
      assert.ok(alive(foreign), "cbase ended the foreign process");
    } finally {
      setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
      if (foreign) { try { process.kill(foreign, "SIGKILL"); } catch { /* gone */ } }
      for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
      rowApprove(b.s.projectId);
      b.fd.cleanUp();
    }
  });
});

test("(18c) a descendant of a native run in its own group passes the first look and holds only in the second - return path after the stop, not before", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const groups = [];
    let foreign = null;
    try {
      const svc = store.addProjectService(b.s.projectId, { name: "native", startCommand: "exec sleep 3600" });
      await inOps(b, async () => startSimple({ projectId: b.s.projectId, service: svc, cwd: b.s.path, projectName: "native", workspaceId: ctx.ws.id }));
      const [run] = nativeRuns(b.s.projectId);
      assert.equal(run?.serviceId, svc.id);
      groups.push(run.pid);
      // Like a jupyter kernel: child of the run (ppid), but in its OWN group and session, working dir in the project. The leader
      // of the group stands in /proc only as an ancestor (working dir outside).
      foreign = foreignProcess(b.s.path);
      const fp = fakeProc(path.join(ctx.root, `proc-18c-${b.s.projectId}`));
      fp.process({ pid: run.pid, cwd: "/", comm: "sh", pgid: run.pid, sid: run.pid });
      fp.process({ pid: foreign, cwd: b.s.path, comm: "kernel", ppid: run.pid, pgid: foreign, sid: foreign, start: 4713 });
      setProcessSeam({ root: fp.root, quietMs: 0 });
      const { result, log } = await relocation(b, procedureOriginal);
      assert.deepEqual(returnPathFindings(b, result, "stop", log), []);
      assert.match(String(result.error), new RegExp(`after ending the native services\\): pid ${foreign} \\(kernel, Start proc:4713\\)`));
      assert.doesNotMatch(String(result.error), /before the first stop/, "the first look counted the descendant");
      assert.ok(b.calls().some((x) => x.daemon === "host" && x.args[0] === "stop"), "no stop - the first look held the descendant");
      assert.equal(alive(run.pid), false, "the group of the native run is still alive - step 4 did not end it");
      const fresh = nativeRuns(b.s.projectId);
      groups.push(...fresh.map((l) => l.pid));
      assert.deepEqual(fresh.map((l) => l.serviceId), [svc.id], "the return path did not restart the native service");
      assert.ok(alive(foreign), "cbase ended the foreign process");
    } finally {
      setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
      if (foreign) { try { process.kill(foreign, "SIGKILL"); } catch { /* gone */ } }
      for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
      rowApprove(b.s.projectId);
      b.fd.cleanUp();
    }
  });
});

// ── (5) Operating marker ───────────────────────────────────────────────────────────────────────────────────────────

test("(5) without the operating marker no docker - the relocation answers 404, the decider touches nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const prior = process.env.CBASE_DOCKER_BIN;
    try {
      process.env.CBASE_DOCKER_BIN = b.fd.bin; // the seam points to the fake docker - only the operating marker is missing
      const d = dataSteps(b);
      await assert.rejects(procedureOriginal.startRelocation(b.s.projectId, { steps: d.steps, creation: b.s.opts }),
        (e) => e.code === "NO_OPS" && e.status === 404);
      assert.deepEqual(store.relocationsOf(b.s.projectId), []);
      const open = store.createRelocation({ projectId: b.s.projectId, instance: "main", location: path.join(ctx.root, "g1") });
      try {
        const seam = procedureOriginal.relocationRestartGraceSeam({ steps: d.steps, creation: b.s.opts });
        const result = await seam.decider({ projectId: b.s.projectId, instance: "main" });
        assert.equal(result.ok, false);
        assert.equal(store.readRelocation(open.id).endedAt, null, "the journal was touched");
        assert.equal(seam.afterReady({ projectId: b.s.projectId, instance: "main" }), undefined);
      } finally { store.deleteRelocation(open.id); }
      assert.deepEqual(b.calls(), [], "no docker without operation");
      assert.deepEqual(d.log, []);
    } finally {
      if (prior === undefined) delete process.env.CBASE_DOCKER_BIN; else process.env.CBASE_DOCKER_BIN = prior;
      b.fd.cleanUp();
    }
  });
});

// ── Volumes (14)-(17) ──────────────────────────────────────────────────────────────────────────────────────────────

// A manifest program over the CONTENT (for (14)): translates the root through FAKE_DOCKER_MOUNTS (fake-docker.mjs) and writes
// per entry path, type and sha256 of the content in the order of the program (depth first, names by bytes); permissions,
// owner and times fixed - the case is "which files with which content".
function contentManifest(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, "content-manifest.cjs");
  fs.writeFileSync(js, `const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const argv = process.argv.slice(2);
let w = argv[argv.length - 1];
const mounts = Object.entries(JSON.parse(process.env.FAKE_DOCKER_MOUNTS || "{}")).sort((a, b) => b[0].length - a[0].length);
for (const [target, local] of mounts) if (w === target || w.startsWith(target + "/")) { w = local + w.slice(target.length); break; }
const aus = [JSON.stringify({ "cbase-manifest": 1 })];
const base = { mode: "0755", uid: 0, gid: 0, mtime: "1", xattr: {} };
const run = (abs, rel) => {
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) {
    aus.push(JSON.stringify({ p: rel, type: "d", ...base }));
    for (const n of fs.readdirSync(abs, { encoding: "buffer" }).sort(Buffer.compare)) run(path.join(abs, n.toString()), rel === "." ? n.toString() : rel + "/" + n.toString());
  } else aus.push(JSON.stringify({ p: rel, type: "f", ...base, size: st.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"), thin: false, nlink: 1 }));
};
run(w, ".");
aus.push(JSON.stringify({ entries: aus.length - 1, end: true }));
process.stdout.write(aus.join("\\n") + "\\n");
`);
  const sh = path.join(dir, "content-manifest");
  fs.writeFileSync(sh, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 });
  return sh;
}
const contentOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : null);
function setContent(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
}

// The image brings content at both volume paths; in B a package is missing in the anonymous volume (npm uninstall x), and the
// named one is empty.
const IMAGE_CONTENT = {
  "shop-web:latest": { "/app/cache": { "x/index.js": "x", "y/index.js": "y-old" } },
  "postgres:16": { "/var/lib/postgresql/data": { PG_VERSION: "16" } },
};
async function copyUpRun(ctx, module) {
  const b = await build(ctx, { programs: { cp: null, python3: contentManifest(path.join(ctx.root, `content-${crypto.randomUUID()}`)) }, imageContent: IMAGE_CONTENT });
  setContent(b.fd.volumeData(b.anonB), { "y/index.js": "y-new", data: "abc" });
  setContent(b.fd.volumeData("shop_pgdata"), {});
  const { result } = await relocation(b, module);
  return { b, result };
}
const insideVolume = (b, service, target) => Object.values(b.fd.state(inner(b)).container).find((c) => c.name === `shop-${service}-1`)?.mounts.find((m) => m.Destination === target)?.Name;

test("(14) copy-up at `up` - step 12 empties the anonymous target and the named one with an empty source before the `cp -a`; inside stands exactly B", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, result } = await copyUpRun(ctx, procedureOriginal);
    try {
      assert.equal(result.end, "finished", result.error);
      const anon = insideVolume(b, "web", "/app/cache");
      assert.deepEqual(contentOf(b.fd.volumeData(anon, inner(b))), ["data", "y", "y/index.js"], "anonymous volume inside != B");
      assert.equal(fs.readFileSync(path.join(b.fd.volumeData(anon, inner(b)), "y/index.js"), "utf8"), "y-new");
      assert.deepEqual(contentOf(b.fd.volumeData("shop_pgdata", inner(b))), [], "named volume inside not empty like in B");
      // Precondition, otherwise "green" would prove nothing: the copy-up really filled the targets (the emptying stands on the wire).
      const finds = b.calls().filter((x) => x.daemon === "host" && x.args[0] === "exec" && x.args.includes("find") && x.args.includes("-delete"));
      assert.deepEqual(finds.map((x) => x.args.find((y) => y.startsWith("/relocation/target/"))).sort(), [`/relocation/target/volumes/${anon}/_data`, "/relocation/target/volumes/shop_pgdata/_data"].sort());
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-h)+(G-i) counter-test: step 12 without emptying => \"check\" fails on both volumes; without catching up empty named sources => on the named one", async () => {
  const withoutClear = await sabotage("without-clear", `      if (p.targetMode === "clear") await executeHelper(h, ["find", target, "-xdev", "-mindepth", "1", "-delete"], { capMs: relocationCapMs("copy") });
      if (!(await empty(h, target))) throw stepError(`, `      if (false) throw stepError(`);
  const withoutCatchUp = await sabotage("without-catch-up", `    ...(ctx.plan.volumes?.named || []).map((v) => ({ source: v.name, target: v.name, targetMode: "clear", onlyIfSourceEmpty: true })),\n`, "");
  await withAgentsServer(async (ctx) => {
    for (const [module, expected] of [[withoutClear, ["anon", "shop_pgdata"]], [withoutCatchUp, ["shop_pgdata"]]]) {
      const { b, result } = await copyUpRun(ctx, module);
      try {
        assert.equal(result.end, "back", `the sabotage ran through (${expected})`);
        assert.equal(result.step, "check", result.error);
        const names = expected.map((n) => (n === "anon" ? b.anonB : n));
        for (const n of names) assert.ok(result.error.includes(`${n}: manifest differs`), `${n}: ${result.error}`);
        assert.equal(names.length === 1 && result.error.includes(`${b.anonB}: manifest differs`), false, result.error);
      } finally { b.fd.cleanUp(); }
    }
  });
});

// (15): an `external` volume without labels (the plan would hold - here it stands in the plan anyway: the second safeguard).
async function withExternal(ctx, module) {
  const b = await build(ctx);
  dx(b.fd, "volume", "create", "shared_pg");
  setContent(b.fd.volumeData("shared_pg"), { data: "shared" });
  b.plan.volumes.named.push({ name: "shared_pg", labels: {}, bytes: 7, container: [], withoutContainer: true });
  const { result } = await relocation(b, module);
  return { b, result };
}

test("(15) step 15 removes only the demonstrable - external volume and pulled image stay, no builder prune; manifests as files 0600", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, result } = await withExternal(ctx, procedureOriginal);
    try {
      assert.equal(result.end, "finished", result.error);
      const z = b.fd.state();
      const e = procedureOriginal.relocationStatus(b.s.projectId).report.remove;
      assert.ok(z.volumes.shared_pg, "the external volume without a Compose label was removed in B");
      assert.ok(e.not.includes("volume shared_pg: without the Compose label of this project — stays (owner unclear)"), JSON.stringify(e.not));
      assert.equal(z.volumes.shop_pgdata, undefined, "the volume of the Compose project stayed");
      assert.ok(z.images["postgres:16"], "the pulled image was removed");
      assert.ok(e.not.some((x) => x.startsWith(`image ${IDA.slice(0, 12)} (postgres:16): not built by this project — stays`)), JSON.stringify(e.not));
      assert.equal(z.images["shop-web:latest"], undefined, "the built image stayed");
      assert.deepEqual(e.images, [IDB.slice(0, 12)]);
      assert.deepEqual(b.calls().filter((x) => x.args[0] === "builder"), [], "builder prune called");
      assert.match(e.buildCache, /not touched/);
      const location = path.join(store.relocationsOf(b.s.projectId).at(-1).location, "manifests");
      const files = fs.readdirSync(location).sort();
      assert.deepEqual(files, [`${b.anonB}.desired.jsonl`, `${insideVolume(b, "web", "/app/cache")}.actual.jsonl`, "shared_pg.actual.jsonl", "shared_pg.desired.jsonl", "shop_pgdata.actual.jsonl", "shop_pgdata.desired.jsonl"].sort());
      for (const f of files) assert.equal(fs.statSync(path.join(location, f)).mode & 0o777, 0o600, f);
    } finally { b.fd.cleanUp(); }
  });
});

test("(G-j) counter-test: step 15 without the label check of the volumes => the external volume is gone in B", async () => {
  const module = await sabotage("volume-without-label", `!projects.has(l[LABEL.project]) ? "without the Compose label of this project — stays (owner unclear)"\n        : `, "");
  await withAgentsServer(async (ctx) => {
    const { b, result } = await withExternal(ctx, module);
    try {
      assert.equal(result.end, "finished", result.error);
      assert.equal(b.fd.state().volumes.shared_pg, undefined, "the sabotage did not bite");
    } finally { b.fd.cleanUp(); }
  });
});

// The pure verdict over the volumes without a label (procedure.js `volumeVerdict`) - every branch on its own, because a silently
// folded branch ("does not name it" taken as accepted) would otherwise show only in the end-to-end run.
test("volumeVerdict: does not name it, external, other file set, unresolved name, left over in B - and the good case", () => {
  const { volumeVerdict } = procedureOriginal;
  const vols = (...e) => new Map(e.map(([n, s, x]) => [n, { key: s, external: Boolean(x) }]));
  const v = (name, container, extra = {}) => ({ name, labels: {}, container, withoutLabel: "geo", ...extra });
  const main = { project: "geo", container: ["geo-db-1"], vols: vols(["geo_pgdata", "pgdata"]) };
  const minio = { project: "geo", container: ["geo-minio-1"], vols: vols(["geo_minio", "minio"]) };
  // Good: every file set names only its volumes (two -f sets of one project) - both checked, against their own set.
  const gut = volumeVerdict({ named: [v("geo_pgdata", ["geo-db-1"]), v("geo_minio", ["geo-minio-1"])], groups: [main, minio], inB: new Set(["geo_pgdata", "geo_minio"]) });
  assert.deepEqual(gut, { error: [], checked: [{ volume: "geo_pgdata", project: "geo", key: "pgdata" }, { volume: "geo_minio", project: "geo", key: "minio" }] });
  // The set whose container mounts it does not name it => error, not checked.
  const missing = volumeVerdict({ named: [v("hand", ["geo-db-1"])], groups: [main], inB: new Set(["hand"]) });
  assert.deepEqual(missing.checked, []);
  assert.deepEqual(missing.error, ["hand (without a Compose label): the model of geo does not name it"]);
  // external in the own set, or in another set of the same project => error.
  for (const g of [[{ ...main, vols: vols(["geo_pgdata", "pgdata", true]) }], [main, { ...minio, vols: vols(["geo_pgdata", "pg", true]) }]]) {
    const r = volumeVerdict({ named: [v("geo_pgdata", ["geo-db-1"])], groups: g, inB: new Set() });
    assert.deepEqual(r.checked, []);
    assert.match(r.error.join(), /geo_pgdata \(without a Compose label\): `external` in the model of geo/);
  }
  // No set has a container that mounts it => error.
  assert.match(volumeVerdict({ named: [v("geo_pgdata", ["foreign-1"])], groups: [main], inB: new Set() }).error.join(), /no file set of geo has a container/);
  // A name with `$` after interpolation => not checkable; an own volume of the model that lies in B and does not move along => error.
  assert.match(volumeVerdict({ named: [], groups: [{ ...main, vols: vols(["${X}_data", "data"]) }], inB: new Set() }).error.join(), /not resolved in the model of \w+ — cannot be checked/);
  const leftOver = volumeVerdict({ named: [], groups: [{ ...main, vols: vols(["geo_leftovers", "leftovers"], ["ext_vol", "e", true]) }], inB: new Set(["geo_leftovers", "ext_vol"]) });
  assert.deepEqual(leftOver.error, ["geo_leftovers: the model of geo names it as its own volume, it lies in B and would not move along (no container mounts it)"]);
  // Volumes WITH a label (without `withoutLabel`) are not checked by the verdict - they carry their proof.
  assert.deepEqual(volumeVerdict({ named: [{ name: "geo_pgdata", labels: { "com.docker.compose.project": "geo" }, container: ["geo-db-1"] }], groups: [main], inB: new Set(["geo_pgdata"]) }), { error: [], checked: [] });
});

test("(16) a volume of the plan is missing at the desired manifest => return path in \"stop\" with its name, B does not create it empty", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      b.plan.volumes.named.push({ name: "shop_gone", labels: { [L.project]: "shop" }, bytes: 1, container: [], withoutContainer: true });
      const { result, log } = await relocation(b, procedureOriginal);
      assert.equal(result.end, "back", result.error);
      assert.equal(result.step, "stop");
      assert.match(result.error, /volume\(s\) vanished since the plan: shop_gone/);
      assert.equal(b.fd.state().volumes.shop_gone, undefined, "B created the missing volume empty");
      assert.deepEqual(returnPathFindings(b, result, "stop", log), []);
    } finally { b.fd.cleanUp(); }
  });
});

// (17): the forms, and what compose-go interpolates from them (what an error message can quote).
const ENV_FORMS = [
  ["A_COMMENT=value_one_7a # do not share", "value_one_7a"],
  ['B_QUOTED="value two 7b" # comment', "value two 7b"],
  ["C_SINGLE='value_three_7c'#x", "value_three_7c"],
  ["export   D_EXPORT = value_four_7d   ", "value_four_7d"],
  ["E_COLON: value_five_7e", "value_five_7e"],
  ["F_CRLF=value_six_7f\r", "value_six_7f"],
  ['G_MASK="a\\"value_seven_7g" # c', 'a"value_seven_7g'],
];

test("(17) .env values in every form are blacked out in a Compose error message - nowhere in journal or log", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      fs.appendFileSync(b.env, `${ENV_FORMS.map(([z]) => z).join("\n")}\n`);
      b.envPrior = fs.readFileSync(b.env);
      // The message of the fake docker carries every alternative of the pattern - like a Compose error that quotes values.
      b.fd.errorAt([{ daemon: inner(b), pattern: `^compose .* config --hash|${ENV_FORMS.map(([, w]) => w).join("|")}` }]);
      const { result, log } = await relocation(b, procedureOriginal);
      assert.equal(result.step, "dryrun", result.error);
      assert.deepEqual(returnPathFindings(b, result, "dryrun", log), []);
      assert.deepEqual(envLecks(b), [], "a value from .env is in the journal or log");
      assert.match(store.relocationsOf(b.s.projectId).at(-1).error, /injected error/, "the message did not arrive - the case checks nothing");
    } finally { b.fd.cleanUp(); }
  });
});

function envLecks(b) {
  const j = store.relocationsOf(b.s.projectId).at(-1);
  const texts = [JSON.stringify(store.relocationsOf(b.s.projectId))];
  try { texts.push(fs.readFileSync(path.join(j.location, "log.log"), "utf8")); } catch { /* no log */ }
  return ENV_FORMS.map(([, w]) => w).filter((w) => texts.some((t) => t.includes(w) || t.includes(JSON.stringify(w).slice(1, -1))));
}

test("(G-k) counter-test: the blacking out of the first version (only `KEY=value` literally) => values are in the journal", async () => {
  const module = await sabotage("redact-old", `    for (const w of envInterpretations(text)) values.add(w);\n`, `    for (const row of text.split("\\n")) {
      const m = row.match(/^\\s*(?:export\\s+)?[A-Za-z_][A-Za-z0-9_]*\\s*=\\s*(.*?)\\s*$/);
      const w = m ? m[1].replace(/^(["'])(.*)\\1$/, "$2") : "";
      if (w.length >= 3) values.add(w);
    }\n`);
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      fs.appendFileSync(b.env, `${ENV_FORMS.map(([z]) => z).join("\n")}\n`);
      b.fd.errorAt([{ daemon: inner(b), pattern: `^compose .* config --hash|${ENV_FORMS.map(([, w]) => w).join("|")}` }]);
      const { result } = await relocation(b, module);
      assert.equal(result.step, "dryrun", result.error);
      const lecks = envLecks(b);
      assert.ok(lecks.length >= 3, `the old version blacked out too much: ${JSON.stringify(lecks)}`);
    } finally { b.fd.cleanUp(); }
  });
});

// ── (19) the observer after a crash in the relocation ──────────────────────────────────────────────────────────────────
// The project container crashes in step "start" in the middle of the start sequence (phase "services", the starter of the
// native services is injected) and the daemon restarts it: its inside is a fresh dockerd. checkLiveness in
// relocation/procedure.js stepStart prevents the snapshot from it - the target of the relocation stays - and the observer
// (projectbox/resumption.js) noted the unmarked die with its event time: after the relocation the tick triggers the
// resumption, and inside db and web run again. Without that line no guard entered it (struck, everything stayed green).
test("(19) crash with restart of the project container in step \"start\" => the target of the relocation stays (no snapshot from the fresh dockerd), the observer brings the stack back afterwards", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const pid = b.s.projectId;
    const name = containerName(pid);
    const pids = [];
    let calls = 0;
    const dies = () => resumptionStatus().verdicts.filter((u) => u.name === name && u.action === "die");
    try {
      // A native service in B (like (7)): step 4 writes it into the journal, the start sequence inside calls the starter for it.
      const svc = store.addProjectService(pid, { name: "native", startCommand: "exec sleep 3600" });
      await inOps(b, async () => startSimple({ projectId: pid, service: svc, cwd: b.s.path, projectName: "native", workspaceId: ctx.ws.id }));
      pids.push(...nativeRuns(pid).map((l) => l.pid));
      setNativeServicesStarter(async () => {
        calls += 1;
        if (calls === 1) {
          const n = dies().length;
          b.fd.crash(name, { restart: true });
          // Continue only when the observer has seen the die - so it surely falls into the living procedure of the relocation.
          await waitForTruthy(() => dies().length > n, "the die of the crash has reached the observer");
        }
        return { error: [] };
      });
      await inOps(b, async () => {
        resumptionRestartGrace();
        try {
          await waitForTruthy(() => b.fd.streams().length === 1, "the observer's stream runs");
          await resumptionQuiet();
          const prior = resumptionStatus();
          const d = dataSteps(b);
          const result = await procedureOriginal.startRelocation(pid, { steps: d.steps, creation: b.s.opts });
          assert.equal(result.end, "finished", result.error);
          assert.equal(calls, 1, "the start sequence did not reach the starter (otherwise this checks nothing)");
          assert.deepEqual(dies().map((u) => u.reason), ["state-relocation"]);
          const z = store.projectInstance(pid, "main");
          assert.equal(z.state, "ready");
          const states = Object.fromEntries((z.desired?.container || []).map((c) => [c.name, c.state]));
          assert.deepEqual(states, { "shop-db-1": "running", "shop-migrate-1": "exited", "shop-web-1": "running" }, "the target comes from the fresh dockerd");
          const j = store.relocationsOf(pid).at(-1);
          assert.match(fs.readFileSync(path.join(j.location, "log.log"), "utf8"), /snapshot not written .*restarted or stood still during the start sequence/);
          // After the relocation: the tick looks (the die with its event time), the container has restarted since => resumption.
          await desiredTickRound();
          await resumptionQuiet();
          assert.equal(resumptionStatus().resumptions - prior.resumptions, 1, JSON.stringify(resumptionStatus().verdicts.filter((u) => u.name === name)));
          const inside = Object.fromEntries(Object.values(b.fd.state(name).container).map((c) => [c.name, c.status]));
          assert.equal(inside["shop-db-1"], "running", JSON.stringify(inside));
          assert.equal(inside["shop-web-1"], "running", JSON.stringify(inside));
          assert.equal(store.projectInstance(pid, "main").state, "ready");
        } finally {
          stopResumption("end of test");
          await resumptionQuiet();
        }
      }, { CBASE_PROJECT_DESIRED_MS: "0" });
    } finally {
      setNativeServicesStarter(startDesiredServices);
      for (const p of pids) { try { process.kill(-p, "SIGKILL"); } catch { /* gone */ } }
      rowApprove(pid);
      b.fd.cleanUp();
    }
  });
});

// ── (20) a found volume of the project container survives the return path ─────────────────────────────────────────────

test("(20) if the volume of the project container already lay in B (rest of an earlier instance), the return path does not remove it - the journal carries volumeFound", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const pv = volumeName(b.s.projectId);
    try {
      dx(b.fd, "volume", "create", "--label", `cbase.project=${b.s.projectId}`, pv);
      fs.mkdirSync(b.fd.volumeData(pv), { recursive: true });
      fs.writeFileSync(path.join(b.fd.volumeData(pv), "rest"), "from an earlier instance");
      b.start = b.fd.calls().length;
      b.fd.errorAt([{ daemon: inner(b), pattern: "^network create extnetz" }]);
      const { result } = await relocation(b, procedureOriginal);
      assert.equal(result?.end, "back", JSON.stringify(result));
      const j = store.relocationsOf(b.s.projectId).at(-1);
      assert.equal(j.insideIds?.volumeFound, true, JSON.stringify(j.insideIds));
      assert.ok(b.fd.state().volumes[pv], "the return path removed a volume it did not create");
      assert.equal(fs.readFileSync(path.join(b.fd.volumeData(pv), "rest"), "utf8"), "from an earlier instance");
      assert.deepEqual(b.calls().filter((x) => x.daemon === "host" && x.args[0] === "volume" && x.args[1] === "rm" && x.args.includes(pv)), [], "volume rm on the found volume");
      assert.ok(!Object.values(b.fd.state().container).some((x) => x.name === containerName(b.s.projectId)), "the project container falls anyway");
    } finally { rowApprove(b.s.projectId); b.fd.cleanUp(); }
  });
});

// ── (21) a failed row deletion in rw-completion ───────────────────────────────────────────────────────────────────────

test("(21) if deleting the instance row fails in rw-completion, the return path holds, named (journal open) - the way out leads back, without a row", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const pid = b.s.projectId;
    const trigger = "guard_n31_no_delete";
    const lock = () => rawDb.exec(`CREATE TEMP TRIGGER ${trigger} BEFORE DELETE ON project_instances WHEN OLD.project_id = '${pid}' BEGIN SELECT RAISE(ABORT, 'injected: the database does not delete'); END`);
    const approve = () => rawDb.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    try {
      lock();
      b.fd.errorAt([{ daemon: inner(b), pattern: "^load" }]); // "images" fails => return path before the turnaround
      const d = dataSteps(b);
      const result = await inOps(b, () => procedureOriginal.startRelocation(pid, { steps: d.steps, creation: b.s.opts }));
      const row = store.projectInstance(pid, "main");
      const j = store.relocationsOf(pid).at(-1);
      assert.notEqual(result?.end, "back", `"back" reported although the instance row still stands (${row?.state}/${row?.phase})`);
      assert.equal(result.end, "open", JSON.stringify(result));
      assert.deepEqual([result.direction, result.step], ["backward", "rw-completion"]);
      assert.match(result.wayOut, /\/relocation\/resume/);
      assert.equal(j.endedAt, null, "the journal is closed - the next start would find a row without a journal");
      assert.deepEqual([j.direction, j.step], ["backward", "rw-completion"]);
      assert.deepEqual([row.state, row.phase], ["relocation", "hold-return-path"]);
      assert.match(row.error, /instance row is not deleted/);
      assert.match(row.error, /step "images"/, "the reason of the return path is missing on the row");
      assert.match(row.error, /\/relocation\/resume/);
      // Everything else is back: the old containers run, the project container is gone.
      const z = b.fd.state();
      assert.equal(z.container[b.ids.db]?.status, "running");
      assert.equal(z.container[b.ids.web]?.status, "running");
      assert.ok(!Object.values(z.container).some((c) => c.name === containerName(pid)), "the project container is still there");
      // The way out, once the database deletes again: only rw-completion, then "back" without a row.
      approve();
      const prior = d.log.length;
      const two = await inOps(b, () => procedureOriginal.resumeRelocation(pid, { steps: d.steps, creation: b.s.opts }).run);
      assert.equal(two.end, "back", JSON.stringify(two));
      assert.match(String(two.error), /^step "images"/);
      assert.deepEqual(d.log.slice(prior), [], "the way out repeated already finished data steps of the return path");
      assert.equal(store.projectInstance(pid, "main"), null, "the instance row still stands");
      const j2 = store.relocationsOf(pid).at(-1);
      assert.equal(j2.end, "back");
      assert.ok(j2.endedAt > 0);
    } finally { approve(); rowApprove(pid); b.fd.cleanUp(); }
  });
});
