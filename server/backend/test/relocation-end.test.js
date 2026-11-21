// The relocation end to end: the REAL procedure (projectbox/relocation/procedure.js) with the REAL data steps (data.js) and the REAL
// collection with plan (collect.js -> plan.js) — nothing is injected except the fake docker (fake-docker.mjs, BOTH daemons: B =
// "host", the inner one through `exec cbase-p-<id> docker …`, with Compose) and the helper programs in the helper (manifest, cp).
// Real git repos and worktrees in the temp tree.
//
// The situation in B: a project that is a repo itself (docker-compose.yml and a tracked .env.example with PORT=3000), an UNtracked
// .env (PORT=3100 and a decoy value), the override file of cbase (docker-compose.cbase.yml, untracked); Compose project "shop" with
// `db` (always, named volume) and `web` (unless-stopped, depends_on db, anonymous volume); two registered services — `web` with
// `-p 3100`/port 3100 and a row in service_start_commands, `api` with `PORT=3101`/port 3101 WITHOUT a row (repo default not
// recognisable); a graph child chat with a worktree under the flat worktree root with an UNcommitted file, without `projectId` in
// worktree_info (an old graph worktree), and a subagent that worked in this worktree.
//
// What holds:
//   (a)+(b) Error in step 14 (manifest differs) — so after step 9 and 13 => return path: .env and override byte-equal, start command,
//       service_start_commands (also "no row") and port byte-equal; the uncommitted file at the old place, graph_starts columns and the
//       subagent image byte-equal.
//       COUNTER-TEST (built in, a copy of data.js with sabotage or a naive return path): portDismantlingBack without the service values
//       => start command without `-p 3100`, red; runtimeBack "delete the copies from 13" without moving back => the file is missing, red.
//   (c)+(d) Success => resolveCwd returns the moved worktree for the child chat, worktree_info carries `projectId`, the image of the
//       moved subagent `instance = <pid>/main`; `web` without `-p`, port 3000 (repo default from the tracked .env.example), `api` keeps
//       `PORT=3101 node server.js` and port 3101 (no default, named in the report); the check in 14 green.
//       COUNTER-TEST (a copy of data.js with sabotage): without rewriting the columns => resolveCwd falls back with a log line, red;
//       `port = alt.port` instead of the default => port 3100, red.
//   (f) The route with the real procedure: a hold reason of the REAL plan (worktree outside) => POST 409 HOLD with `holdReasons` in the
//       answer, no journal, no writing docker; without it => 202 with the state of THIS relocation. Counter-test shown by hand: a
//       route that answered after one round of the event loop answered 202 in both cases — with `state: null` or the previous
//       relocation; the HOLD appeared only in the log.
//   (e) The main seam as its own server process (withAgentsServer { childProcess: true }): during a relocation (at the gate in step 6, the copy
//       of the named volumes) `busy:true` with `projectWork`, a message to a chat of the project starts no turn; a hard restart there
//       (crash(), the follow-up runs by itself afterwards) => the decider takes the return path: journal `back`, old containers run with
//       their policies, project container gone, no instance row. Then the queued message runs (the follow-up wakes without a lock,
//       procedure.js setGone). COUNTER-TEST: the same crash without a registered decider cannot be reproduced (server.js always
//       registers it); instead the guard asserts that BEFORE the restart nothing was rolled back (the old containers stood, the journal
//       was open) — so the return path came from the follow-up. Without the waking the test would wait at "log" forever — a hang, not a
//       red (waiting without a deadline; the gate's deadline ends it).
//   (h) Compose v5.3.1 measured on the server: `config --hash` of an env_file service is never the label of `up` and blind to the content
//       of the env_file: `web` reads `env_file: .env.web` with PORT=3100 (untracked; the tracked `.env.example` says 3000), `.env` carries
//       no port, no override file. The REAL dismantling (9) sets PORT in `.env.web` to 3000 => 12b re-creates EXACTLY web (not db), the
//       container inside carries the hash of `up` WITH the new content, the relocation ends `finished`. Counter-test: an older state —
//       return path in the dry run (web), and with the new dry run but the old 12b: return path in "new-hash".
//   (m) A process in B whose working directory is the graph worktree (flat worktree root, outside the project folder) holds the plan
//       (409 HOLD "process-in-project") — step 13 would move the folder from under it. Sabotage: `additional` in collect.js empty => red.
//
// Waiting only for the result of the procedure, the journal and the gate file of the fake cp — no duration is a criterion.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { containerName, networkName, volumeName } from "../electron/server/projectbox/creation.js";
import { heavyLoadStatus } from "../electron/server/projectbox/heavyLoad.js";
import * as procedure from "../electron/server/projectbox/relocation/procedure.js";
import { locationFor, worktreeRoot } from "../electron/server/runs/runtime-location.js";
import { resolveCwd } from "../electron/server/runs/system-prompt.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeComposeHash, fakeDocker } from "./fake-docker.mjs";
import { HOSTS_TEST, ID, STAT, withOps, routeText, scenario } from "./projectbox-scenario.mjs";
import { RIPCORD_MS } from "./ripcord.mjs";
import { setProcessSeam } from "../electron/server/projectbox/relocation/processes.js";
import { fakeProc, emptyProc } from "./fake-proc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Plan and step 4 read /proc (projectbox/relocation/processes.js) — here a fake one containing only B (macOS has none; without a
// view of the processes the plan would hold with data-missing).
const EMPTY_PROC = emptyProc();
setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
test.after(() => fs.rmSync(EMPTY_PROC, { recursive: true, force: true }));
const DATA_JS = path.resolve(HERE, "..", "electron", "server", "projectbox", "relocation", "data.js");

const IDA = "a1".repeat(32);
const IDB = "b2".repeat(32);
const IMAGES = { "cbase-projectbox:latest": ID, "postgres:16": IDA, "shop-web:latest": IDB };
const MODEL = {
  shop: {
    db: { image: "postgres:16", restart: "always", volumes: [{ name: "pgdata", target: "/var/lib/postgresql/data" }] },
    web: { image: "shop-web:latest", restart: "unless-stopped", dependsOn: ["db"], volumes: [{ target: "/app/cache" }] },
  },
};
// (h) web reads its environment from `.env.web` (`env_file:`).
const MODEL_ENV_WEB = { shop: { ...MODEL.shop, web: { ...MODEL.shop.web, envFile: [".env.web"] } } };
const SECRET = "END_SECRET_8812";
const L = { project: "com.docker.compose.project", service: "com.docker.compose.service" };
const WRITING = new Set(["run", "start", "stop", "rm", "update", "create", "load", "save", "rmi", "prune", "exec"]);
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ── Helper programs in the helper (through `programs` of the fake docker) ──────────────────────────────────────────────
// python3 = the manifest program (a valid manifest; with the file `deviation` it reports different content at the TARGET).
// cp logs and, as long as the file `cp-hold` exists, stops at the GATE: marker `cp.waiting`, continues only with `cp-open` (polling,
// no deadline; the ripcord ends an orphaned cp — otherwise it would hang forever after an aborted test).
function auxPrograms(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "programs.jsonl");
  const p = (n) => JSON.stringify(path.join(dir, n));
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
const sha = (root.startsWith("/relocation/target/") && fs.existsSync(${p("deviation")}) ? "e" : "d").repeat(64);
const z = [{ "cbase-manifest": 1 }, { p: ".", type: "d", mode: "0755", uid: 0, gid: 0, mtime: "1", xattr: {} },
  { p: "data", type: "f", mode: "0644", uid: 0, gid: 0, mtime: "1", xattr: {}, size: 3, sha256: sha, thin: false, nlink: 1 },
  { entries: 2, end: true }];
process.stdout.write(z.map((x) => JSON.stringify(x)).join("\\n") + "\\n");
`);
  const cp = write("fake-cp", `${header}fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prog: "cp", argv }) + "\\n");
if (fs.existsSync(${p("cp-hold")})) {
  fs.writeFileSync(${p("cp.waiting")}, "");
  const ripcord = Date.now() + ${RIPCORD_MS};
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(${p("cp-open")})) { if (Date.now() > ripcord) process.exit(9); Atomics.wait(buffer, 0, 0, 15); }
}
`);
  const source = path.join(dir, "cbase-manifest");
  fs.writeFileSync(source, "# placeholder: in B the program lives under /usr/local/bin (Dockerfile)\n");
  return {
    log, deviation: path.join(dir, "deviation"), cpHold: path.join(dir, "cp-hold"), cpWaiting: path.join(dir, "cp.waiting"),
    cpOpen: path.join(dir, "cp-open"), programs: { python3, cp }, manifestSource: fs.realpathSync(source),
  };
}

// ── The situation in B ─────────────────────────────────────────────────────────────────────────────────────────────────

// The project as a repo, the files, the stack in B (the fake docker must already exist: `fd`).
function seedProject(fd, filePath, { envWeb = false } = {}) {
  const d = (n) => path.join(filePath, n);
  fs.writeFileSync(d("docker-compose.yml"), "services: {}\n# db, web (the model lives in the fake docker)\n");
  fs.writeFileSync(d(".env.example"), "PORT=3000\n");
  git(filePath, "init", "-q", "-b", "main");
  git(filePath, "add", "docker-compose.yml", ".env.example");
  git(filePath, "commit", "-q", "-m", "start");
  // (h): the port lives in the env_file of web (`.env.web`), not in `.env`; no override file of cbase.
  fs.writeFileSync(d(".env"), envWeb ? `SECRET_KEY=${SECRET}\n` : `PORT=3100\nSECRET=${SECRET}\n`);
  if (envWeb) fs.writeFileSync(d(".env.web"), `PORT=3100\nWEB_SECRET=${SECRET}\n`);
  else fs.writeFileSync(d("docker-compose.cbase.yml"), "# from cbase: port override\n");
  dx(fd, "compose", "-p", "shop", "--project-directory", filePath, "-f", d("docker-compose.yml"), ...(envWeb ? [] : ["-f", d("docker-compose.cbase.yml")]),
    "up", "--no-start", "--no-build", "--pull", "never", "db", "web");
  const shop = Object.values(fd.state().container).filter((c) => c.labels[L.project] === "shop");
  const ids = Object.fromEntries(shop.map((c) => [c.labels[L.service], c.id]));
  dx(fd, "start", ids.db, ids.web);
  return { ids, env: d(".env"), override: d("docker-compose.cbase.yml"), envPrior: fs.readFileSync(d(".env")), overridePrior: envWeb ? null : fs.readFileSync(d("docker-compose.cbase.yml")) };
}

async function build(ctx, { projectId, withG20 = true, envWeb = false, model = null, prior = null } = {}) {
  const s = scenario(ctx, projectId ? { projectId } : {});
  const pid = s.projectId;
  const aux = auxPrograms(path.join(ctx.root, `aux-${pid}`));
  const fd = await fakeDocker({ images: IMAGES, programs: { ...s.programs, ...aux.programs }, compose: model || (envWeb ? MODEL_ENV_WEB : MODEL) });
  prior?.(fd); // what already lies in B before Compose creates the stack (a volume without a label)
  const situation = seedProject(fd, s.path, { envWeb });
  // The registered services: `web` with a row in service_start_commands, `api` without.
  const web = store.addProjectService(pid, { name: "web", port: 3100, startCommand: "next dev -p 3100" });
  store.updateProjectService(web.id, { startCommand: "next dev -p 3100" });
  const api = store.addProjectService(pid, { name: "api", port: 3101, startCommand: "PORT=3101 node server.js" });
  const b = { s, pid, aux, fd, ...situation, web, api, start: fd.calls().length };
  if (withG20) Object.assign(b, seedG20(ctx, b));
  b.calls = () => fd.calls().slice(b.start);
  return b;
}

// A graph child chat with a worktree under the FLAT worktree root, an uncommitted file in it, worktree_info without `projectId`
// (old graph worktree), a subagent in the worktree of the child chat.
function seedG20(ctx, b) {
  const n = crypto.randomBytes(4).toString("hex");
  const root = worktreeRoot(locationFor({}));
  fs.mkdirSync(root, { recursive: true });
  const seg = `graph-${n}`;
  const g = path.join(root, seg);
  git(b.s.path, "worktree", "add", "-q", "-b", `cbase/graph-${n}`, g, "HEAD");
  fs.writeFileSync(path.join(g, "open.txt"), "unsaved\n");
  const c1 = `c-${n}`;
  const k1 = `k-${n}`;
  for (const id of [c1, k1]) store.createChat({ id, workspaceId: ctx.ws.id, projectId: b.pid, provider: "claude", createdAt: 1, updatedAt: 1 });
  const gs = `gs-${n}`;
  store.createGraphStart({ id: gs, chatId: c1, childChatId: k1, workflowId: `wf-${n}`, workflowName: "Wf", shortName: "wf", background: true, worktree: true, status: "started" });
  store.changeGraphStart(gs, {
    worktreePath: g,
    worktreeInfo: JSON.stringify({ dir: g, branch: `cbase/graph-${n}`, repos: [{ name: "shop", relPath: "", root: b.s.path, target: g, base: "b" }], own: [] }),
  });
  store.rememberSubagent(k1, { agentId: "a2", name: "two", provider: "claude", model: "m", sessionId: "", state: "finished", status: "completed", cwd: g, worktree: null, instance: "alt/main" });
  return { g, seg, c1, k1, gs, gNew: path.join(worktreeRoot(locationFor({ projectId: b.pid, converted: true })), seg) };
}

// The environment in operation: the markers (projectbox-scenario.mjs), the manifest program, the stage cap in the opposite direction,
// the network root — and HOME = the home of the scenario (trust entry, ~/.local, CLI home: never the machine's real home).
function inOps(b, fn) {
  return withOps(b.fd, async () => {
    const desired = { CBASE_MANIFEST_PROGRAM: b.aux.manifestSource, CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: b.s.root, HOME: b.s.home };
    const saved = Object.fromEntries(Object.keys(desired).map((k) => [k, process.env[k]]));
    try {
      for (const [k, v] of Object.entries(desired)) process.env[k] = v;
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
}

const relocation = (b, steps = {}, further = {}) => inOps(b, () => procedure.startRelocation(b.pid, { steps, creation: b.s.opts, ...further }));

const services = (b) => Object.fromEntries(["web", "api"].map((n) => {
  const d = store.listProjectServices(b.pid).find((x) => x.name === n);
  return [n, { startCommand: d.startCommand, port: d.port, row: store.serviceStartRow(b.pid, n) }];
}));
const imageOf = (b) => store.subagentsOf(b.k1);

// ── Sabotage: a copy of data.js outside the tree, relative imports as absolute file URLs ──────────────────────────────
const sabotageFolder = [];
test.after(() => { for (const d of sabotageFolder) fs.rmSync(d, { recursive: true, force: true }); });
async function dataSabotaged(name, replacements) {
  let text = fs.readFileSync(DATA_JS, "utf8");
  for (const [old, fresh] of replacements) {
    assert.equal(text.split(old).length, 2, `sabotage ${name}: "${old.slice(0, 60)}…" does not occur exactly once in data.js`);
    text = text.replace(old, fresh);
  }
  const dir = path.dirname(DATA_JS);
  text = text.replace(/(from\s+|import\()"(\.{1,2}\/[^"]+)"/g, (_, before, rel) => `${before}"${pathToFileURL(path.resolve(dir, rel)).href}"`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-end-"));
  sabotageFolder.push(folder);
  const target = path.join(folder, `data-${name}.mjs`);
  fs.writeFileSync(target, text);
  return import(pathToFileURL(target).href);
}

// ── (a)+(b) Return path after an error in 14 ───────────────────────────────────────────────────────────────────────────

function returnPathFindings(b, result, prior) {
  const f = [];
  if (result?.end !== "back") f.push(`end ${result?.end} instead of back (${result?.error || "—"})`);
  if (result?.step !== "check") f.push(`step ${result?.step} instead of check (${result?.error || "—"})`);
  if (!fs.readFileSync(b.env).equals(b.envPrior)) f.push(".env not byte-equal");
  if (!fs.existsSync(b.override) || !fs.readFileSync(b.override).equals(b.overridePrior)) f.push("override not back");
  const d = services(b);
  for (const n of ["web", "api"]) {
    if (d[n].startCommand !== prior.services[n].startCommand) f.push(`${n}: start command "${d[n].startCommand}" instead of "${prior.services[n].startCommand}"`);
    if (d[n].port !== prior.services[n].port) f.push(`${n}: port ${d[n].port} instead of ${prior.services[n].port}`);
    if (JSON.stringify(d[n].row) !== JSON.stringify(prior.services[n].row)) f.push(`${n}: service_start_commands not byte-equal`);
  }
  if (!fs.existsSync(path.join(b.g, "open.txt")) || fs.readFileSync(path.join(b.g, "open.txt"), "utf8") !== "unsaved\n") f.push("the uncommitted file is missing at the old place");
  if (JSON.stringify(store.graphWorktreeRows()) !== JSON.stringify(prior.columns)) f.push("graph_starts columns not byte-equal");
  if (JSON.stringify(imageOf(b)) !== JSON.stringify(prior.image)) f.push("subagent image not as before");
  const z = b.fd.state();
  for (const [service, policy] of [["db", "always"], ["web", "unless-stopped"]]) {
    const c = z.container[b.ids[service]];
    if (c?.status !== "running") f.push(`${service} is not running`);
    if (c?.restart !== policy) f.push(`policy ${service} ${c?.restart || "no"} instead of ${policy}`);
  }
  if (store.projectInstance(b.pid, "main")) f.push("instance row left");
  if (JSON.stringify(store.relocationsOf(b.pid)).includes(SECRET)) f.push("value from .env in the journal");
  return f;
}

async function returnPath(ctx, steps) {
  const b = await build(ctx);
  const prior = { services: services(b), columns: store.graphWorktreeRows(), image: imageOf(b) };
  fs.writeFileSync(b.aux.deviation, ""); // step 14: the actual manifest differs
  const result = await relocation(b, steps);
  return { b, result, prior };
}

test("(a)+(b) error in 14 => return path: .env, override, start commands, service_start_commands (also \"no row\"), port byte-equal; graph file at the old place, columns byte-equal", async () => {
  await withAgentsServer(async (ctx) => {
    const { b, result, prior } = await returnPath(ctx, {});
    try {
      assert.equal(prior.services.api.row, null, "api has no row in service_start_commands");
      assert.deepEqual(returnPathFindings(b, result, prior), []);
      // The return path really came after 9 and 13: the journal names the dismantling and the worktree move.
      const j = store.relocationsOf(b.pid).at(-1);
      assert.deepEqual(j.dismantling, [{ file: ".env", key: ["PORT"] }]);
      assert.deepEqual(j.services.map((x) => [x.name, x.startCommand, x.port]).sort(), [["api", "PORT=3101 node server.js", 3101], ["web", "next dev -p 3100", 3100]]);
      assert.equal(j.worktrees.list.length, 1, "step 13 had moved the worktree");
      assert.equal(fs.existsSync(b.gNew), false, "no worktree left in the runtime folder");
    } finally { b.fd.cleanUp(); }
  });
});

test("(a-G)+(b-G) counter-test: return path without the service values => start command without -p 3100; deleting copies without moving back => the file is missing", async () => {
  const sab = await dataSabotaged("without-services", [[
    "  for (const old of j.services || []) {\n    try {\n      if (store.setService(old.id, { startCommand: old.startCommand, port: old.port, startRow: old.startRow })) report.services++;",
    "  for (const old of []) {\n    try {\n      if (store.setService(old.id, { startCommand: old.startCommand, port: old.port, startRow: old.startRow })) report.services++;",
  ]]);
  await withAgentsServer(async (ctx) => {
    const naive = async (c) => { fs.rmSync(path.join(DIRS.data, "projects", c.projectId), { recursive: true, force: true }); };
    const { b, result, prior } = await returnPath(ctx, { portDismantlingBack: sab.portDismantlingBack, runtimeBack: naive });
    try {
      const f = returnPathFindings(b, result, prior);
      assert.ok(f.includes("web: start command \"next dev\" instead of \"next dev -p 3100\""), JSON.stringify(f));
      assert.ok(f.includes("the uncommitted file is missing at the old place"), JSON.stringify(f));
    } finally { b.fd.cleanUp(); }
  });
});

// ── (c)+(d) Success ────────────────────────────────────────────────────────────────────────────────────────────────────

// The relocation with console.log captured (the log line of resolveCwd comes ONCE per path — already in the session move of 13).
async function relocationWithLog(b, steps = {}) {
  const logs = [];
  const orig = console.log;
  const fang = mock.method(console, "log", (...a) => { logs.push(a.map(String).join(" ")); orig(...a); });
  try { return { result: await relocation(b, steps), logs }; } finally { fang.mock.restore(); }
}

function successFindings(b, result, logs) {
  const f = [];
  if (result?.end !== "finished") f.push(`end ${result?.end} (${result?.error || "—"})`);
  const state = procedure.relocationStatus(b.pid);
  if (state?.report?.check?.passed !== true) f.push("check in 14 not passed");
  // (c) graph: the worktree with its file at the new place, resolveCwd finds it, worktree_info with projectId, subagent in the container.
  if (fs.readFileSync(path.join(b.gNew, "open.txt"), { encoding: "utf8", flag: "r" }) !== "unsaved\n") f.push("file not in the moved worktree");
  const log = mock.method(console, "log", (...a) => { logs.push(a.map(String).join(" ")); });
  let cwd;
  try { cwd = resolveCwd(store.getChat(b.k1)); } finally { log.mock.restore(); }
  if (cwd !== b.gNew) f.push(`resolveCwd returns ${cwd} instead of the moved worktree`);
  if (logs.some((l) => l.includes(`[graph-worktree] ${b.k1}: the worktree`) && l.includes("is missing"))) f.push("resolveCwd fell back with a log line");
  const row = store.graphWorktreeRows().find((z) => z.id === b.gs);
  const info = JSON.parse(row.info);
  if (row.path !== b.gNew || info.dir !== b.gNew || info.repos[0].target !== b.gNew) f.push("graph_starts does not point to the new place");
  if (info.projectId !== b.pid) f.push("worktree_info without projectId");
  const a2 = store.readSubagent(b.k1, "a2");
  if (a2.instance !== `${b.pid}/main`) f.push(`subagent instance ${a2.instance}`);
  if (a2.cwd !== b.gNew) f.push("subagent cwd not rewritten");
  // (d) Services: dismantling to the repo default.
  const d = services(b);
  if (d.web.startCommand !== "next dev" || d.web.row?.startCommand !== "next dev") f.push(`web: start command "${d.web.startCommand}"`);
  if (d.web.port !== 3000) f.push(`web: port ${d.web.port} instead of 3000`);
  // Without a repo default the start command stays with `PORT=3101` (the old port is free in the container's own network).
  if (d.api.startCommand !== "PORT=3101 node server.js" || d.api.row !== null) f.push(`api: start command "${d.api.startCommand}" or a row`);
  if (d.api.port !== 3101) f.push(`api: port ${d.api.port} instead of 3101 (no default recognisable)`);
  if (!fs.readFileSync(b.env, "latin1").startsWith("PORT=3000\n")) f.push(".env not at the repo default");
  // Step 9 put the override file of cbase aside (plan.dismantling.overrides[].file), step 15 cleared it away.
  if (fs.existsSync(b.override)) f.push("the override file of cbase is still in the project");
  return f;
}

test("(c)+(d) success: resolveCwd returns the moved worktree, worktree_info with projectId, subagent <pid>/main; -p 3100/port 3100 => without -p, port 3000; check in 14 green", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const { result, logs } = await relocationWithLog(b);
      assert.deepEqual(successFindings(b, result, logs), []);
      const state = procedure.relocationStatus(b.pid);
      assert.ok(state.plan.hints.some((h) => h.kind === "service-port-unknown" && h.service === "api"), "the plan names the service without a repo default");
      assert.equal(fs.existsSync(b.g), false, "moved, not copied");
      assert.equal(store.projectInstance(b.pid, "main").state, "ready");
      // B empty, db and web run inside; no value from .env in the journal.
      assert.deepEqual(Object.values(b.fd.state().container).filter((c) => c.labels[L.project] === "shop"), []);
      const inside = Object.fromEntries(Object.values(b.fd.state(containerName(b.pid)).container).map((c) => [c.name, c.status]));
      assert.deepEqual(inside, { "shop-db-1": "running", "shop-web-1": "running" });
      assert.ok(!JSON.stringify(store.relocationsOf(b.pid)).includes(SECRET), "value from .env in the journal");
    } finally { b.fd.cleanUp(); }
  });
});

test("(c-G)+(d-G) counter-test: without rewriting the columns => fallback with a log line; port = old value => port 3100", async () => {
  const sab = await dataSabotaged("without-columns-old-port", [
    ["  writeRows(fresh);\n", ""],
    ["    const port = standard ?? old.port;\n", "    const port = old.port;\n"],
  ]);
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const { result, logs } = await relocationWithLog(b, { relocateRuntime: sab.relocateRuntime, portDismantling: sab.portDismantling });
      const f = successFindings(b, result, logs);
      assert.ok(f.some((x) => x.startsWith("resolveCwd returns")), JSON.stringify(f));
      assert.ok(f.includes("resolveCwd fell back with a log line"), JSON.stringify(f));
      assert.ok(f.includes("web: port 3100 instead of 3000"), JSON.stringify(f));
    } finally { b.fd.cleanUp(); }
  });
});

// ── (f) The route with the real procedure ─────────────────────────────────────────────────────────────────────────────

async function raw(url, init = {}) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* no JSON */ }
  return { status: r.status, body, text };
}

test("(f) route with the real procedure: hold reason of the real plan => 409 HOLD with holdReasons, no journal, no writing docker; without it => 202 with the state of THIS relocation", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { projectId: crypto.randomUUID(), withG20: false });
    const outside = path.join(ctx.root, `outside-${b.pid}`);
    git(b.s.path, "worktree", "add", "-q", "-b", "outside", outside, "HEAD");
    try {
      await inOps(b, async () => {
        const r = await raw(`${ctx.base}/api/projects/${b.pid}/relocation`, { method: "POST" });
        assert.equal(r.status, 409, r.text);
        assert.equal(r.body.code, "HOLD", r.text);
        assert.ok(r.body.holdReasons.some((h) => h.kind === "worktree-outside"), r.text);
        assert.ok(!r.text.includes(SECRET), "value from .env in the answer");
        assert.deepEqual(store.relocationsOf(b.pid), [], "a HOLD creates no journal");
        assert.deepEqual(b.calls().filter((a) => WRITING.has(a.args[0]) || (a.args[0] === "builder")), [], "a HOLD writes nothing with docker");
        assert.equal(heavyLoadStatus(), null);

        git(b.s.path, "worktree", "remove", "--force", outside);
        const r2 = await raw(`${ctx.base}/api/projects/${b.pid}/relocation`, { method: "POST" });
        assert.equal(r2.status, 202, r2.text);
        const j = store.relocationsOf(b.pid);
        assert.equal(j.length, 1);
        assert.equal(r2.body.state?.id, j[0].id, "the answer carries the state of THIS relocation");
        assert.equal(r2.body.state.open, true);
        // The route passes no creation options: on this machine the creation fails (no network marker under /), the relocation
        // returns — the test waits for the journal.
        await waitForTruthy(() => store.readRelocation(j[0].id).endedAt !== null, "end of the relocation");
        assert.equal(store.readRelocation(j[0].id).end, "back");
        assert.equal(heavyLoadStatus(), null);
      });
    } finally { b.fd.cleanUp(); }
  });
});

// ── (e) The main seam as its own server process: crash in step 6 ───────────────────────────────────────────────────────

// The home and the creation environment of the server process (like projectbox-scenario.mjs, but without the store of the test
// process — the server runs as its own process).
function kindSituation(root) {
  const dir = path.join(root, "kind-situation");
  const home = path.join(dir, "home");
  for (const d of [".claude/agents", ".codex", ".claude-login", ".ssh"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}\n");
  const system = { usrLocalBin: path.join(dir, "sys", "bin"), usrLocalNodeModules: path.join(dir, "sys", "nm"), mcp: path.join(dir, "sys", "mcp") };
  for (const d of Object.values(system)) fs.mkdirSync(d, { recursive: true });
  const rootDir = path.join(dir, "root");
  fs.mkdirSync(path.join(rootDir, "run", "cbase"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "proc", "1"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "proc", "net"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "run", "cbase", "network-separation.ok"), "4242\n");
  fs.writeFileSync(path.join(rootDir, "proc", "1", "stat"), STAT(4242));
  fs.writeFileSync(path.join(rootDir, "proc", "net", "route"), routeText([["eth0", "172.24.0.0/16"]]));
  const inside = path.join(dir, "inside");
  fs.mkdirSync(path.join(inside, "run"), { recursive: true });
  fs.mkdirSync(path.join(inside, "sys", "fs", "cgroup"), { recursive: true });
  fs.writeFileSync(path.join(inside, "run", "cbase-projectbox.status"), "phase=ready\nnotice=DNAT set\n");
  fs.writeFileSync(path.join(inside, "sys", "fs", "cgroup", "cgroup.subtree_control"), "cpu io memory pids\n");
  const cat = path.join(dir, "fake-cat");
  fs.writeFileSync(cat, `#!/bin/sh\nexec /bin/cat '${inside}'"$1"\n`);
  fs.chmodSync(cat, 0o755);
  return { home, creation: { home, system, root: rootDir, addresses: ["192.0.2.10/24"] }, programs: { cat } };
}

test("(e) main seam as a process: at the gate in step 6 busy + projectWork, a message starts no turn; crash there => the follow-up decider takes the return path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-end-kind-"));
  const situation = kindSituation(root);
  const aux = auxPrograms(path.join(root, "aux"));
  const fd = await fakeDocker({ images: IMAGES, programs: { ...situation.programs, ...aux.programs }, compose: MODEL });
  const environment = {
    CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECTBOX_TICK_MS: "10",
    CBASE_PROJECTBOX_CREATION_MS: "3600000", CBASE_HOSTS_FILE: HOSTS_TEST, CBASE_MANIFEST_PROGRAM: aux.manifestSource,
    CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: situation.creation.root, HOME: situation.home,
    CBASE_TEST_RELOCATION_CREATION: JSON.stringify(situation.creation),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(environment)) process.env[k] = v;
    await withAgentsServer(async (ctx) => {
      const filePath = path.join(ctx.root, "workspace", "shop");
      fs.mkdirSync(filePath, { recursive: true });
      const lagB = seedProject(fd, filePath);
      const p = await ctx.projectWithoutInstance({ name: "Shop", path: filePath });
      await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });

      // The relocation through the ROUTE in the server process; the test entry (agent-server-child.mjs, CBASE_TEST_RELOCATION_CREATION)
      // gives the real procedure the creation options of this situation. The answer comes as soon as the journal exists; the
      // relocation then stops at the cp gate in step 6.
      fs.writeFileSync(aux.cpHold, "");
      const start = await raw(`${ctx.base}/api/projects/${p.id}/relocation`, { method: "POST" });
      assert.equal(start.status, 202, start.text);
      assert.equal(start.body.state?.open, true, start.text);
      await waitForTruthy(() => fs.existsSync(aux.cpWaiting), "cp at the gate (step 6)");

      const active = await json(`${ctx.base}/api/runs/active`);
      assert.equal(active.busy, true, JSON.stringify(active));
      assert.ok(active.projectWork.some((x) => x.projectId === p.id && x.state === "relocation"), JSON.stringify(active.projectWork));
      assert.ok(active.projectWork.some((x) => x.projectId === p.id && x.state === "heavyLoad"), JSON.stringify(active.projectWork));
      const n = await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURING-THE-RELOCATION" }) });
      assert.equal(n.queued, true, JSON.stringify(n));
      assert.equal(n.locked, true, JSON.stringify(n));
      assert.equal((await json(`${ctx.base}/api/runs/active`)).runs, 0, "no turn during the relocation");
      const before = (await json(`${ctx.base}/api/projects/${p.id}/relocation`)).state;
      assert.equal(before.open, true);
      assert.equal(before.step, "volumes", JSON.stringify(before));
      // Before the restart nothing is rolled back: the old containers stand (stopped, without a policy), the project container lives.
      const z0 = fd.state();
      assert.equal(z0.container[lagB.ids.db].status, "exited");
      assert.ok(Object.values(z0.container).some((c) => c.name === containerName(p.id)), "the project container is missing before the crash");

      await ctx.crash(); // SIGKILL, then a new server process — the follow-up runs immediately (CBASE_RESTART_GRACE_MS=0)
      fs.writeFileSync(aux.cpOpen, ""); // an orphaned cp (if it survived the helper) ends
      await waitForTruthy(async () => (await json(`${ctx.base}/api/projects/${p.id}/relocation`)).state?.open === false, "end of the relocation after the follow-up");
      const next = (await json(`${ctx.base}/api/projects/${p.id}/relocation`)).state;
      assert.equal(next.end, "back", JSON.stringify(next));
      assert.equal(next.direction, "backward");
      const z = fd.state();
      for (const [service, policy] of [["db", "always"], ["web", "unless-stopped"]]) {
        assert.equal(z.container[lagB.ids[service]]?.status, "running", `${service} is not running`);
        assert.equal(z.container[lagB.ids[service]]?.restart, policy, `Policy ${service}`);
      }
      assert.ok(!Object.values(z.container).some((c) => c.name === containerName(p.id)), "project container still there");
      assert.equal(z.volumes[volumeName(p.id)], undefined, "volume of the project container still there");
      assert.ok(!Object.values(z.networks).some((x) => x.name === networkName(p.id)), "network of the project container still there");
      assert.ok(!Object.values(z.container).some((c) => c.labels["cbase.helper"]), "helper left");
      assert.ok(fs.readFileSync(lagB.env).equals(lagB.envPrior), ".env not byte-equal");
      const db = ctx.db();
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_instances WHERE project_id = ?").get(p.id).n, 0, "instance row left"); }
      finally { db.close(); }
      // After the return path the queued message runs (the lock is free).
      await ctx.waitForLog(ctx.chat.id, (log) => {
        const i = log.findIndex((m) => m.role === "user" && String(m.text).includes("DURING-THE-RELOCATION"));
        return i >= 0 && log.slice(i + 1).some((m) => m.role === "assistant");
      });
    }, { childProcess: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (g) the REAL plan holds on a volume without the Compose label of this project ────────────────────────────────────────
// `volume-shared` sees only EXISTING containers. A volume that another project lists as `external`, whose containers are missing
// right now (`compose down`), slipped through — and step 15 removed it in B. The real plan (collect.js -> plan.js) over the fake
// docker: without a label and with the label of ANOTHER Compose project it holds (`volume-extern`), with the label of this project it
// does not. Counter-test: against an older plan.js the first case has no hold reason (run by hand).
test("(g) an external volume with a foreign Compose label holds in the plan; without any label the dry run holds (model: external) — nothing stopped; with the label of the project none does", async () => {
  const { planFor } = await import("../electron/server/projectbox/relocation/collect.js");
  await withAgentsServer(async (ctx) => {
    // [labels, volume-extern in the plan, volume-without-label in the plan]
    const cases = [[[], [], ["shared_pg"]], [["--label", "com.docker.compose.project=other"], ["shared_pg"], []], [["--label", "com.docker.compose.project=shop"], [], []]];
    for (const [labels, extern, without] of cases) {
      const s = scenario(ctx, { projectId: crypto.randomUUID() });
      const aux = auxPrograms(path.join(ctx.root, `aux-${s.projectId}`));
      const model = { shop: { ...MODEL.shop, web: { ...MODEL.shop.web, volumes: [...MODEL.shop.web.volumes, { extern: "shared_pg", target: "/shared" }] } } };
      const fd = await fakeDocker({ images: IMAGES, programs: { ...s.programs, ...aux.programs }, compose: model });
      try {
        dx(fd, "volume", "create", ...labels, "shared_pg");
        seedProject(fd, s.path);
        const { plan } = await inOps({ s, fd, aux }, () => planFor(s.projectId));
        assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "volume-extern").map((h) => h.volume), extern, JSON.stringify(plan.holdReasons));
        assert.deepEqual(plan.hints.filter((h) => h.kind === "volume-without-label").map((h) => h.volume), without);
        assert.ok(!plan.holdReasons.some((h) => h.kind === "volume-shared"), "volume-shared would see it after all — the case checks nothing");
        assert.ok(plan.volumes.named.some((v) => v.name === "shared_pg"), "the volume is not in the plan");
      } finally { fd.cleanUp(); }
    }
    // Without a label down to the procedure: the dry run asks the model, `external` => back before anything is stopped.
    const model = { shop: { ...MODEL.shop, web: { ...MODEL.shop.web, volumes: [...MODEL.shop.web.volumes, { extern: "shared_pg", target: "/shared" }] } } };
    const b = await build(ctx, { withG20: false, model, prior: (fd) => dx(fd, "volume", "create", "shared_pg") });
    try {
      const result = await relocation(b);
      assert.equal(result.end, "back", result.error);
      assert.equal(result.step, "dryrun");
      assert.match(result.error, /shared_pg \(without a Compose label\): `external` in the model of shop/);
      assert.deepEqual(b.calls().filter((a) => a.daemon === "host" && a.args[0] === "stop"), [], "stopped before the dry-run verdict");
      assert.ok(b.fd.state().volumes.shared_pg, "the volume is gone in B");
      assert.deepEqual(Object.values(b.fd.state().container).filter((c) => c.labels[L.project] === "shop").map((c) => c.status).sort(), ["running", "running"]);
    } finally { b.fd.cleanUp(); }
  });
});

// ── (i)–(k) Volumes without a Compose label and the receipt of the write layer ─────────────────────────────────────────────

test("(i) pgdata without a Compose label (created before Compose) moves along — checked against the model, inside without a label like in B; in B it stays (release by hand); finished", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { withG20: false, prior: (fd) => dx(fd, "volume", "create", "shop_pgdata") });
    try {
      assert.deepEqual(b.fd.state().volumes.shop_pgdata.labels, {}, "Compose set a label (the real one never does)");
      const result = await relocation(b);
      assert.deepEqual(result.ok ? [] : [result.step, result.error], [], "the relocation failed");
      assert.equal(result.end, "finished");
      const state = procedure.relocationStatus(b.pid);
      assert.deepEqual(state.report.dryrun?.volumesWithoutLabel, [{ volume: "shop_pgdata", project: "shop", key: "pgdata" }]);
      // The model proves only that THIS project lists it — a shut-down other one could name it under that name. It stays in B, the
      // report names it.
      assert.ok(!state.report.remove.volumes.includes("shop_pgdata"), JSON.stringify(state.report.remove));
      assert.ok(b.fd.state().volumes.shop_pgdata, "a volume without a label was removed in B");
      assert.ok(state.report.remove.not.some((x) => x.startsWith("volume shop_pgdata: without a Compose label — stays in B")), JSON.stringify(state.report.remove.not));
      const inside = b.fd.state(containerName(b.pid)).volumes.shop_pgdata;
      assert.deepEqual(inside?.labels, {}, "inside not the same volume as in B");
    } finally { b.fd.cleanUp(); }
  });
});

test("(j) a volume without a label that the model names (also under an interpolated `name:`) but that no container mounts lies in B => dry run holds (two cases), nothing stopped", async () => {
  await withAgentsServer(async (ctx) => {
    // [model entry of the profile service, name in B]
    for (const [vol, name] of [[{ name: "leftovers", target: "/leftovers" }, "shop_leftovers"], [{ name: "leftovers", volName: "${LEFTOVERS_VOL:-shop_leftover_new}", target: "/leftovers" }, "shop_leftover_new"]]) {
      const model = { shop: { ...MODEL.shop, extra: { image: "postgres:16", profiles: ["extra"], volumes: [vol] } } };
      const b = await build(ctx, { withG20: false, model, prior: (fd) => dx(fd, "volume", "create", name) });
      try {
        const result = await relocation(b);
        assert.equal(result.end, "back", result.error);
        assert.equal(result.step, "dryrun");
        assert.ok(result.error.includes(`${name}: the model of shop names it as its own volume, it lies in B and would not move along`), result.error);
        assert.deepEqual(b.calls().filter((a) => a.daemon === "host" && a.args[0] === "stop"), []);
        assert.ok(b.fd.state().volumes[name]);
      } finally { b.fd.cleanUp(); }
    }
  });
});

test("(l) pgdata without a label under an interpolated `name:` — the model without interpolation names it literally, the second call resolves => checked, finished", async () => {
  await withAgentsServer(async (ctx) => {
    const model = { shop: { ...MODEL.shop, db: { ...MODEL.shop.db, volumes: [{ name: "pgdata", volName: "${PG_VOL:-shop_dbdata}", target: "/var/lib/postgresql/data" }] } } };
    const b = await build(ctx, { withG20: false, model, prior: (fd) => dx(fd, "volume", "create", "shop_dbdata") });
    try {
      const db = Object.values(b.fd.state().container).find((c) => c.name === "shop-db-1");
      assert.ok(db.mounts.some((m) => m.Name === "shop_dbdata"), "the fake did not resolve the name");
      const result = await relocation(b);
      assert.deepEqual(result.ok ? [] : [result.step, result.error], [], "the relocation failed");
      assert.equal(result.end, "finished");
      assert.deepEqual(procedure.relocationStatus(b.pid).report.dryrun?.volumesWithoutLabel, [{ volume: "shop_dbdata", project: "shop", key: "pgdata" }]);
      const modelCalls = b.fd.calls({ daemon: containerName(b.pid) }).filter((a) => a.args[0] === "compose" && a.args.includes("config") && a.args.includes("--format"));
      assert.deepEqual(modelCalls.map((a) => a.args.includes("--no-interpolate")), [true, false], "first without, then with interpolation — only because a `$` was in the name");
    } finally { b.fd.cleanUp(); }
  });
});

test("(k) a write layer holds; a receipt with a wrong number is rejected (nothing created); with name and number from the plan => finished, the report names what was dismissed", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { withG20: false });
    try {
      b.fd.setDiff("shop-web-1", ["C /app", "C /app/.venv", "A /app/.venv/bin", "A /app/.venv/bin/pytest", "A /root/.cache/uv/x"]);
      let hold;
      await assert.rejects(relocation(b), (e) => { hold = e.holdReasons?.find((h) => h.kind === "writeLayer" && h.container === "shop-web-1"); return e.code === "HOLD" && hold?.count === 2; });
      const q = (x) => ({ acknowledged: [{ kind: "writeLayer", container: "shop-web-1", count: 2, checksum: hold.checksum, ...x }] });
      await assert.rejects(relocation(b, {}, q({ count: 3 })), (e) => e.code === "RECEIPT_MISMATCHED");
      await assert.rejects(relocation(b, {}, q({ checksum: "0000000000000000" })), (e) => e.code === "RECEIPT_MISMATCHED");
      assert.deepEqual(store.relocationsOf(b.pid), [], "a rejected receipt created a journal");
      const result = await relocation(b, {}, q({}));
      assert.deepEqual(result.ok ? [] : [result.step, result.error], [], "the relocation failed");
      assert.equal(result.end, "finished");
      const [v] = procedure.relocationStatus(b.pid).report.dismissed;
      assert.deepEqual({ ...v, folder: undefined }, { kind: "writeLayer", container: "shop-web-1", count: 2, checksum: hold.checksum, folder: undefined, examples: ["/app/.venv/bin/pytest", "/root/.cache/uv/x"], list: "dismissed/shop-web-1.jsonl" });
      assert.deepEqual(v.folder, [{ path: "/app/.venv/bin", count: 1 }, { path: "/root/.cache/uv", count: 1 }]);
      // The WHOLE list lies in the relocation location (0600), one line per path.
      const j = store.relocationsOf(b.pid).at(-1);
      const file = path.join(j.location, v.list);
      assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n").map((z) => JSON.parse(z)), ["/app/.venv/bin/pytest", "/root/.cache/uv/x"]);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(j.plan?.acknowledged?.map((x) => x.container), ["shop-web-1"]);
    } finally { b.fd.cleanUp(); }
  });
});

// ── (h) the port dismantling changes the env_file of a service ────────────────────────────────────────────────────────

test("(h) the dismantling changes PORT in the env_file of web => 12b re-creates EXACTLY web, inside with the hash of up including the new content; finished", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { withG20: false, envWeb: true });
    try {
      const labelIn = (state, name) => Object.values(state.container).find((c) => c.name === name)?.labels["com.docker.compose.config-hash"];
      const prior = { db: labelIn(b.fd.state(), "shop-db-1"), web: labelIn(b.fd.state(), "shop-web-1") };
      const result = await relocation(b);
      assert.deepEqual(result.ok ? [] : [result.step, result.error], [], "the relocation failed");
      assert.equal(result.end, "finished");
      const j = store.relocationsOf(b.pid).at(-1);
      assert.deepEqual(j.dismantling, [{ file: ".env.web", key: ["PORT"] }], "the dismantling did not go to the env_file");
      assert.ok(fs.readFileSync(path.join(b.s.path, ".env.web"), "latin1").startsWith("PORT=3000\n"), ".env.web not at the repo default");
      const snapshot = procedure.relocationStatus(b.pid);
      assert.deepEqual(snapshot.report.dryrun?.withoutHash?.map((x) => [x.name, x.reason]), [["shop-web-1", "env_file"]]);
      assert.deepEqual(snapshot.report.newlyCreated, ["shop/web"], "12b did not re-create exactly web");
      assert.equal(snapshot.report.check?.passed, true);
      // Inside: web with the hash of `up` over the NEW content of the env_file, db unchanged with the label from B.
      const inside = b.fd.state(containerName(b.pid));
      const desiredWeb = fakeComposeHash({ service: "web", files: [path.join(b.s.path, "docker-compose.yml")], folder: b.s.path, envFile: [path.join(b.s.path, ".env.web")] });
      assert.equal(labelIn(inside, "shop-web-1"), desiredWeb, "web inside does not carry the hash of up with the new content");
      assert.notEqual(desiredWeb, prior.web);
      assert.equal(labelIn(inside, "shop-db-1"), prior.db, "db was re-created");
      assert.deepEqual(j.insideIds?.createNew, ["shop-web-1"]);
      assert.equal(j.insideIds?.desiredHash?.["shop-web-1"], desiredWeb);
      assert.ok(!JSON.stringify(store.relocationsOf(b.pid)).includes(SECRET), "value from an .env in the journal");
      assert.ok(!fs.readFileSync(path.join(j.location, "log.log"), "utf8").includes(SECRET), "value from an .env in the log");
    } finally { b.fd.cleanUp(); }
  });
});

// ── (m) whoever works in a worktree that step 13 moves holds the relocation ─────────────────────────────────────────────

test("(m) a process in B with its working folder in the graph worktree (under the flat worktree root, NOT in the project folder) => 409 HOLD process-in-project, no journal", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { projectId: crypto.randomUUID() }); // the route accepts only a project id of its form (as in (f))
    const procDir =fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-end-proc-"));
    try {
      const proc = fakeProc(procDir);
      proc.process({ pid: 4711, cwd: fs.realpathSync(b.g), comm: "vim", start: 77 });
      setProcessSeam({ root: procDir, quietMs: 0 });
      await inOps(b, async () => {
        const r = await raw(`${ctx.base}/api/projects/${b.pid}/relocation`, { method: "POST" });
        assert.equal(r.status, 409, r.text);
        assert.equal(r.body.code, "HOLD", r.text);
        assert.deepEqual(r.body.holdReasons.filter((h) => h.kind === "process-in-project").map((h) => [h.pid, h.program]), [[4711, "vim"]], r.text);
        assert.deepEqual(store.relocationsOf(b.pid), [], "a HOLD creates no journal");
        assert.equal(fs.readFileSync(path.join(b.g, "open.txt"), "utf8"), "unsaved\n", "the worktree stays");
      });
    } finally {
      setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
      fs.rmSync(procDir, { recursive: true, force: true });
      b.fd.cleanUp();
    }
  });
});
