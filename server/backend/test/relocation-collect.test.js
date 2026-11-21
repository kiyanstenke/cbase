// The data collection of the relocation plan (step 1; projectbox/relocation/collect.js).
//
// What holds:
//   (1) THE SHAPE: against a fake docker (a function emulating both sides of `docker`: ps, inspect, images, volume ls/inspect,
//       system df, network ls/inspect, diff) and REAL git in temp repos, collectRelocationData delivers exactly the data shape from
//       the head of plan.js — planRelocation accepts it without a single "data-missing" or "incomplete". Spot checks per field:
//       `diff` only for containers under the project folder (not `demo-2`), volume size from `system df`, tracked `.env.example`,
//       untracked Compose file, worktree under the worktree root of cbase, repo traits (detached, stash, filter=, submodule, beyond
//       the findRepos limit), the first commit of the project repo without the code repos, ~/.local without share/uv, other
//       projects, texts.
//   (2) NO VALUE: neither `data.env` nor the plan carries an `.env*` value or a value from the MCP environment. Counter-test built in:
//       the same search finds the values in the fixture (the file carries them) and in the RAW data (`data.composeTexts`,
//       `data.mcpServer`) — the detector can turn red, and the raw data never leaves as an answer.
//   (3) UNKNOWN IS NOT EMPTY: a git that fails and a `docker diff` that fails leave the fields MISSING — the plan holds with
//       "data-missing" instead of believing "no worktrees". Counter-test: with the intact git nothing is missing (1). `tracked`
//       and `untrackedCompose` are missing too (a failed `git ls-files` is not "nothing tracked").
//   (4) A converted project rejects the collection (ALREADY_CONVERTED) — its containers no longer run in B.
//   (5) `Options` of a volume (driver_opts) arrive as KEYS, never as values — the plan holds.
//   (6) NO GIT IN B ON A REPO THAT A PROJECT CONTAINER WRITES: a decoy `core.fsmonitor` in an embedded repo does not run (hardening
//       `GIT_HARDENING`); a project WITH an instance row in the project folder runs no git at all, and the plan holds
//       ("nested-converted"). Counter-test: an older collect.js — the decoy marker exists, red.
//   (7) A NEIGHBOR WITH A PROJECT CONTAINER: a worktree of its repo in the project folder (git directory and `commondir` there) is
//       not touched — hold reason, no git on it; its `.venv/pyvenv.cfg` is not read by localReferences (`localReferencesOpen`, hint
//       "incomplete"). Built-in counter-test: without the instance row it reads it.
//   (8) WORKTREES: an orphaned worktree under the cbase root holds the plan BEFORE the stop ("worktree-orphaned"), one that already
//       lies in the runtime folder stays ("worktree-at-target") — none in `move`.
//   (9) SERVICES WITHOUT A PROCESS GROUP: a service registered by the agent with an open port holds the plan ("native-service-unclear").
//   (10) INHERITED LABELS: the images arrive WITH their `Config.Labels` (`Labels`), and a container that inherits `cbase.acceptance`
//       only from its image belongs to the relocation set (diff, Compose text, plan); the project container (cbase.project ON the
//       container) does not. Counter-test: an older collect.js/plan.js — no diff, no container in the plan (red).
//   (11) PROCESSES IN THE PROJECT FOLDER: a process in B with a working directory in the project that belongs to no group of a
//       recorded native run holds the plan ("process-in-project" with pid, program, start); leader and member of the group of a REAL
//       native run (startSimple) do not; one in the session of a REAL terminal that the lock ends (`proj:<id>`) only as a hint.
//       Built-in counter-test: without the exemption the group would be in it. Counter-test with an older plan: no processes (red).
//   (12) Without a project with a project container, a `.git` without `gitdir:` does not hold as "nested-converted".
//        Sabotage: the row without `cFolder.length ?` => (12) red.
//   (13) `bEnvironmentNames` (names only), `foreign[].volumeNames` (`volumeNamesFrom`, block and flow form, `${VAR}` stays literal),
//        `runtimePrefilled`. Sabotage: drop `data.bEnvironmentNames = …` => (13) red.
//   (14) A descendant (ppid chain) of a recorded native run in its OWN group arrives with `descendant: true` in `data.processes`; the
//        plan only names it (hint "process-descendant"). Sabotage: drop `...(p.descendant ? { descendant: true } : {})` in
//        collect.js => red (hold reason).
//   (15) A COMPLETELY empty project folder => `projectRepo` { arises: false, reason: "empty" } in data and plan; a folder with only
//        an empty subfolder => it arises. Sabotage: drop the line with `reason: "empty"` in collect.js => red.
//   (16) A language server of the project in B (without instance, leader of its group) does NOT hold the plan — the lock ends it
//        anyway (idle.js); the plan does not end it (it is read-only), a foreign process still holds. Built-in counter-test:
//        without the exemption the group would be in it. Sabotage: drop `...languageServiceGroups(project.id)` in collect.js => red.
//   All guards here read a FAKE /proc (fake-proc.mjs through processes.js setProcessSeam) — macOS has none, and without a view of
//   the processes every plan would hold with data-missing ("processes").
// No clock, no deadline.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import net from "node:net";
import { gitStandard, planFor, collectRelocationData, sizeFromText, volumeNamesFrom } from "../electron/server/projectbox/relocation/collect.js";
import { endNativeRuns, nativeRuns, recordAgentRun, startSimple } from "../electron/server/services.js";
import { planRelocation } from "../electron/server/projectbox/relocation/plan.js";
import { processesInProject, setProcessSeam } from "../electron/server/projectbox/relocation/processes.js";
import { createTerminal, killTerminal, terminalAvailable, terminalPidsByTag } from "../electron/server/terminal.js";
import { setLspTable } from "../electron/server/lsp/table.js";
import { endAllSessions, groupsInB, sessionFor } from "../electron/server/lsp/sessions.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeProc, emptyProc } from "./fake-proc.mjs";

const EMPTY_PROC = emptyProc();
setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
test.after(() => fs.rmSync(EMPTY_PROC, { recursive: true, force: true }));

const SECRET_ENV = "secret-value-4711";
const SECRET_URL = "pw-secret-0815";
const SECRET_MCP = "mcp-secret-42";
const SECRET_COMPOSE = "compose-secret-99";
const VALUES = [SECRET_ENV, SECRET_URL, SECRET_MCP, SECRET_COMPOSE];
const valueIn = (obj) => VALUES.filter((w) => JSON.stringify(obj).includes(w));

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString();
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// The fake docker: a function over a state (containers, images, volumes, networks, diffs). Records every call.
function fakeDocker(z, { diffBroken = false } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const a = args.join(" ");
    const out = (x) => ({ code: 0, stdout: typeof x === "string" ? x : JSON.stringify(x), stderr: "" });
    if (a === "ps -a -q --no-trunc") return out(z.container.map((c) => c.Id).join("\n"));
    if (args[0] === "inspect" && args[1] === "--type" && args[2] === "container") return out(args.slice(3).map((id) => z.container.find((c) => c.Id === id)));
    if (a === "images -q --no-trunc") return out(z.images.map((i) => i.Id).join("\n"));
    if (args[0] === "image" && args[1] === "inspect") return out(args.slice(2).map((id) => z.images.find((i) => i.Id === id)).filter(Boolean));
    if (a === "volume ls -q") return out(z.volumes.map((v) => v.Name).join("\n"));
    if (args[0] === "volume" && args[1] === "inspect") return out(args.slice(2).map((n) => z.volumes.find((v) => v.Name === n)));
    if (a === "system df -v --format {{json .}}") return out({ Images: [], Containers: [], Volumes: z.df, BuildCache: [] });
    if (a === "network ls -q --no-trunc") return out(z.networks.map((n) => n.Id).join("\n"));
    if (args[0] === "network" && args[1] === "inspect") return out(args.slice(2).map((id) => z.networks.find((n) => n.Id === id)));
    if (args[0] === "diff") {
      if (diffBroken) throw Object.assign(new Error("docker diff: Error response from daemon: broken"), { code: 1, stderr: "broken", stdout: "" });
      return out((z.diffs[args[1]] || []).join("\n"));
    }
    throw new Error(`wrong docker: not replicated: ${a}`);
  };
  return { fn, calls };
}

const id = (s) => sha(s);
function dockerState(projPath) {
  const compose = (service, folder) => ({
    "com.docker.compose.project": folder === projPath ? "demo" : "demo2",
    "com.docker.compose.project.working_dir": folder,
    "com.docker.compose.project.config_files": path.join(folder, "docker-compose.yml"),
    "com.docker.compose.service": service,
    "com.docker.compose.config-hash": sha(service),
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.container-number": "1",
    "com.docker.compose.depends_on": "",
    "com.docker.compose.image": `sha256:${id("image")}`,
  });
  const web = {
    Id: id("web"), Name: "/demo-web-1", Image: `sha256:${id("image")}`,
    Config: { Image: "demo-web:1", Labels: compose("web", projPath) },
    State: { Status: "running", ExitCode: 0 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" }, PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "8080" }] } },
    Mounts: [{ Type: "volume", Name: "demo_data", Destination: "/data", Driver: "local" }],
    NetworkSettings: { Networks: { demo_default: { Aliases: ["web", "demo-web-1"] } } },
  };
  const neighbor = { // working_dir `<proj>-2`: NOT under the project folder — no diff
    ...web, Id: id("neighbor"), Name: "/demo2-web-1", Config: { Image: "demo-web:1", Labels: compose("web", `${projPath}-2`) },
    Mounts: [], NetworkSettings: { Networks: {} }, HostConfig: { RestartPolicy: { Name: "no" } },
  };
  const box = { ...neighbor, Id: id("box"), Name: "/cbase-p-x", Config: { Image: "cbase-projectbox:latest", Labels: { "cbase.project": "x" } } };
  return {
    container: [web, neighbor, box],
    images: [{ Id: `sha256:${id("image")}`, RepoTags: ["demo-web:1"], RepoDigests: [], Size: 50_000_000 }],
    volumes: [{ Name: "demo_data", Driver: "local", Labels: { "com.docker.compose.project": "demo", "com.docker.compose.volume": "data" } }],
    df: [{ Name: "demo_data", Size: "1.5MB", Links: "1" }],
    networks: [
      { Id: id("n1"), Name: "demo_default", Labels: { "com.docker.compose.project": "demo", "com.docker.compose.network": "default" } },
      { Id: id("n2"), Name: "bridge", Labels: {} },
    ],
    diffs: { [id("web")]: ["C /tmp", "A /tmp/x.sock"], [id("neighbor")]: ["A /secret"] },
  };
}

// The project in the temp tree: no repo itself; inside `app` (detached HEAD, stash, filter=, tracked .env.example),
// `deep/a/b/c/lib` (beyond the findRepos depth, with .gitmodules), `.env` with values, an untracked Compose file.
function buildProject(root, home) {
  const proj = path.join(root, "workspace", "demo");
  write(path.join(proj, "docker-compose.yml"), `services:\n  web:\n    image: demo-web:1\n    environment:\n      - API_KEY=${SECRET_COMPOSE}\n    ports: ["8080:80"]\n`);
  write(path.join(proj, ".env"), `SECRET_TOKEN=${SECRET_ENV}\nDATABASE_URL=postgres://u:${SECRET_URL}@localhost:5432/db\n`);
  write(path.join(proj, "notes.md"), "# Notes\n");
  const app = path.join(proj, "app");
  write(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: "next dev -p 3100", build: "next build" } }));
  write(path.join(app, ".env.example"), "PORT=3000\n");
  write(path.join(app, ".env"), "PORT=3100\n");
  write(path.join(app, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  write(path.join(app, ".gitignore"), ".env\n");
  git(app, "init", "-q");
  git(app, "add", "package.json", ".env.example", ".gitattributes", ".gitignore");
  git(app, "commit", "-q", "-m", "one");
  write(path.join(app, "wip.txt"), "wip\n");
  git(app, "add", "wip.txt");
  git(app, "stash", "-q");
  git(app, "checkout", "-q", "--detach");
  const rootDir = path.join(DIRS.scratch, "worktrees");
  fs.mkdirSync(rootDir, { recursive: true });
  git(app, "worktree", "add", "-q", path.join(rootDir, "graph-abc"), "-b", "cbase/graph-abc");
  const lib = path.join(proj, "deep", "a", "b", "c", "lib");
  write(path.join(lib, ".gitmodules"), "[submodule \"x\"]\n\tpath = x\n\turl = ../x\n");
  write(path.join(lib, "README.md"), "lib\n");
  git(lib, "init", "-q");
  git(lib, "add", "-A");
  git(lib, "commit", "-q", "-m", "lib");
  fs.symlinkSync("../pack", path.join(lib, ".git", "objects", "info", "reference")); // a symlink under .git/objects
  for (const rel of ["state/demo-tool", "share/demo-data", "share/uv"]) write(path.join(home, ".local", rel, "f"), "0123456789");
  return proj;
}

async function prepare(ctx) {
  const home = path.join(ctx.root, "home-b");
  const proj = buildProject(ctx.root, home);
  const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Demo", path: proj }) });
  const otherPath = path.join(ctx.root, "workspace", "other");
  write(path.join(otherPath, ".env"), "API=http://localhost:8080/api\n");
  await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Other", path: otherPath }) });
  store.addProjectService(p.id, { name: "app", port: 3100, dir: "app", startCommand: "npm run dev -- -p 3100" });
  const now = Date.now();
  store.createMcpServer({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: p.id, name: "tool", command: "node", args: ["./srv.js"], env: { TOKEN: SECRET_MCP }, createdAt: now, updatedAt: now });
  store.createSkill({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: p.id, name: "start", body: "The app listens on localhost:3100.", createdAt: now, updatedAt: now });
  return { home, proj, p };
}

const FIELDS = ["project", "mounts", "home", "projectNetwork", "container", "images", "volumes", "networks", "diffs", "composeTexts", "untrackedCompose",
  "worktrees", "worktreeRoots", "mcpServer", "env", "tracked", "services", "startScripts", "repos", "projectRepo", "local", "localReferences", "foreign", "texts", "processes"];
const kindsOf = (plan) => [...plan.holdReasons, ...plan.hints].map((x) => x.kind);

test("(1)+(2) the data shape: planRelocation accepts it without data-missing/incomplete; no env or MCP value in data.env and the plan (counter-test: the detector finds them in fixture and raw data)", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const z = dockerState(proj);
    const d = fakeDocker(z);
    const { plan, data } = await planFor(p.id, { docker: d.fn, home });

    for (const f of FIELDS) assert.ok(Object.hasOwn(data, f), `field ${f} missing in the data`);
    const kinds = kindsOf(plan);
    assert.deepEqual(kinds.filter((a) => a === "data-missing" || a === "incomplete"), [], JSON.stringify([...plan.holdReasons, ...plan.hints].filter((x) => /data-missing|incomplete/.test(x.kind))));

    // diff only for the container under the project folder; not the project container (cbase.*) and not `demo-2`.
    assert.deepEqual(Object.keys(data.diffs), [id("web")]);
    assert.deepEqual(d.calls.filter((a) => a[0] === "diff").map((a) => a[1]), [id("web")]);
    assert.deepEqual(plan.container.map((c) => c.name), ["demo-web-1"]);
    assert.deepEqual(data.volumes.find((v) => v.Name === "demo_data").size, 1_500_000);
    assert.deepEqual(Object.keys(data.composeTexts), [path.join(proj, "docker-compose.yml")]);
    assert.deepEqual(data.untrackedCompose, ["docker-compose.yml"]);
    assert.deepEqual(data.tracked, [path.join("app", ".env.example")]);
    assert.ok(data.worktrees.some((w) => w.path.endsWith(path.join("worktrees", "graph-abc"))), JSON.stringify(data.worktrees));
    assert.deepEqual(plan.worktrees.move.map((w) => path.basename(w.path)), ["graph-abc"], "a worktree under the cbase root moves along (step 13)");
    // Traits only.
    const app = data.repos.find((r) => r.path === path.join(proj, "app"));
    const lib = data.repos.find((r) => r.path.endsWith(path.join("c", "lib")));
    assert.deepEqual([app.detached, app.stashes, app.filter, app.beyondLimit, app.embedded, app.alternates, app.objectsReferences], [true, true, true, false, false, false, false]);
    assert.deepEqual([lib.submodule, lib.beyondLimit, lib.detached, lib.objectsReferences], [true, true, false, true]);
    for (const a of ["copy-detached", "copy-stash", "copy-filter", "copy-submodule", "copy-beyond-limit", "copy-objects-reference"]) assert.ok(kinds.includes(a), `hint ${a} missing`);
    // The first commit takes everything except the code repos — also .env and the Compose file.
    assert.equal(data.projectRepo.arises, true);
    assert.deepEqual(data.projectRepo.files.map((x) => x.path).sort(), [".env", "docker-compose.yml", "notes.md"]);
    assert.ok(data.projectRepo.files.every((x) => Number.isInteger(x.bytes)));
    // Service: port dismantling to the repo default of the tracked .env.example (3100 → 3000).
    assert.deepEqual(data.services.map((x) => [x.name, x.port, x.savedCommand]), [["app", 3100, null]]);
    assert.deepEqual(data.startScripts[path.join(proj, "app")], { dev: "next dev -p 3100", build: "next build" });
    assert.deepEqual(plan.dismantling.services.map((x) => [x.name, x.portOld, x.portStandard]), [["app", 3100, 3000]]);
    // ~/.local without share/uv; the other project hits port 8080 of the own stack; the skill mentions 3100.
    assert.deepEqual(data.local.map((x) => [x.rel, x.bytes]), [["state/demo-tool", 10], ["share/demo-data", 10]]);
    assert.deepEqual(plan.hits.hitOf.map((t) => [t.name, t.port]), [["Other", 8080]]);
    assert.ok(plan.mentions.some((n) => n.source === "skill" && n.port === 3100), JSON.stringify(plan.mentions));

    // (2) No value — in the plan and in the classification of the `.env*`.
    assert.deepEqual(valueIn(plan), [], "the plan carries a value");
    assert.deepEqual(valueIn(data.env), [], "data.env carries a value");
    assert.deepEqual(valueIn(data.foreign), [], "data.foreign carries a value");
    // COUNTER-TEST: the detector finds the values where they are — in the fixture and in the raw data, which never leave.
    assert.deepEqual(valueIn(fs.readFileSync(path.join(proj, ".env"), "utf8")), [SECRET_ENV, SECRET_URL]);
    assert.deepEqual(valueIn(data.composeTexts), [SECRET_COMPOSE]);
    assert.deepEqual(valueIn(data.mcpServer), [SECRET_MCP]);
  });
});

test("(3) unknown is not empty: a failing git and a failing docker diff leave fields missing, the plan holds with data-missing", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const brokenGit = async () => ({ code: 128, stdout: "", stderr: "fatal: broken" });
    const data = await collectRelocationData({ projectId: p.id, docker: fakeDocker(dockerState(proj), { diffBroken: true }).fn, git: brokenGit, home });
    assert.equal(data.worktrees, undefined, "no git => worktrees unknown, not []");
    assert.equal(data.tracked, undefined);
    assert.equal(data.projectRepo, undefined);
    assert.deepEqual(data.diffs, {}, "no diff => the container has no entry");
    const plan = planRelocation(data, { exists: () => false });
    const missing = plan.holdReasons.filter((h) => h.kind === "data-missing").map((h) => h.what).sort();
    assert.deepEqual(missing, ["diffs", "tracked", "untrackedCompose", "worktrees"], "the two fields from git ls-files hold too");
    assert.equal(plan.canRelocate, false);
    assert.ok(plan.hints.some((h) => h.kind === "incomplete" && h.what === "projectRepo"));
  });
});

test("(4) a converted project rejects the collection (ALREADY_CONVERTED, 409) — without a docker call", async () => {
  await withAgentsServer(async (ctx) => {
    const filePath = path.join(ctx.root, "workspace", "finished");
    fs.mkdirSync(filePath, { recursive: true });
    const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Finished", path: filePath }) });
    store.createProjectInstance({ projectId: p.id, instance: "main", state: "ready", convertedAt: Date.now() });
    try {
      const d = fakeDocker(dockerState(filePath));
      await assert.rejects(collectRelocationData({ projectId: p.id, docker: d.fn }), (e) => e.code === "ALREADY_CONVERTED" && e.status === 409);
      assert.deepEqual(d.calls, []);
      await assert.rejects(collectRelocationData({ projectId: "exists-not", docker: d.fn }), (e) => e.code === "NO_PROJECT" && e.status === 404);
    } finally {
      store.deleteProjectInstance(p.id, "main");
    }
  });
});

test("sizes from `system df`: human units (base 1000, binary 1024), unknown is null", () => {
  assert.deepEqual(["0B", "512B", "1.5kB", "1.5MB", "2GB", "1KiB", "N/A", "", "12"].map(sizeFromText), [0, 512, 1500, 1_500_000, 2_000_000_000, 1024, null, null, null]);
});

test("(5) `Options` of a volume (driver_opts) arrive as KEYS, never as values — the plan holds", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const z = dockerState(proj);
    const SECRET_OPT = "opt-secret-1337";
    // Compose `driver_opts: { type: none, o: bind, device: … }` or cifs with a password in `o` — values that must never leave.
    z.volumes = z.volumes.map((v) => (v.Name === "demo_data" ? { ...v, Options: { type: "none", o: `bind,password=${SECRET_OPT}`, device: `${proj}/data/${SECRET_OPT}` } } : v));
    z.volumes.push({ Name: "demo_empty", Driver: "local", Labels: { "com.docker.compose.project": "demo", "com.docker.compose.volume": "empty" }, Options: null });
    const { plan, data } = await planFor(p.id, { docker: fakeDocker(z).fn, home });
    assert.deepEqual(data.volumes.find((v) => v.Name === "demo_data").options, ["device", "o", "type"]);
    assert.equal(Object.hasOwn(data.volumes.find((v) => v.Name === "demo_empty"), "options"), false, "Options null means none");
    assert.equal(JSON.stringify(data.volumes).includes(SECRET_OPT), false, "an Options value in data.volumes");
    assert.equal(JSON.stringify(plan).includes(SECRET_OPT), false, "an Options value in the plan");
    assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "volume-options").map((h) => [h.volume, h.options]), [["demo_data", ["device", "o", "type"]]]);
    assert.equal(plan.canRelocate, false);
  });
});

// A repo with one commit; `decoy` sets core.fsmonitor to a command that creates a marker (git ls-files would run it).
function repoWith(dir, files) {
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  return dir;
}
function decoy(root, repo, name) {
  const marker = path.join(root, `DECOY-${name}`);
  git(repo, "config", "core.fsmonitor", `touch '${marker}'; false`);
  return marker;
}
const gitWithLog = () => {
  const calls = [];
  return { calls, fn: async (cwd, args) => { calls.push({ cwd, args }); return gitStandard(cwd, args); } };
};
const converted = (projectId) => store.createProjectInstance({ projectId, instance: "main", state: "ready", convertedAt: Date.now() });

test("(6) the decoy core.fsmonitor does not run — in the embedded repo (hardening) and in the project with a project container inside (no git, hold reason \"nested-converted\")", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const docker = fakeDocker(dockerState(proj)).fn;
    // (a) An embedded repo with a Compose file (=> git ls-files on it) and the decoy.
    const eing = repoWith(path.join(proj, "decoy"), { "docker-compose.yml": "services: {}\n" });
    const markerA = decoy(ctx.root, eing, "a");
    let { plan } = await planFor(p.id, { docker, home });
    assert.equal(fs.existsSync(markerA), false, "git ls-files ran the core.fsmonitor of the embedded repo in B");
    assert.ok(!plan.holdReasons.some((h) => h.kind === "nested-converted"), "a hold reason without a project container");

    // (b) A project WITH an instance row lies in the project folder: its repo (decoy) is never touched, no git runs at all.
    const inside = repoWith(path.join(proj, "inside"), { "docker-compose.yml": "services: {}\n" });
    const markerB = decoy(ctx.root, inside, "b");
    const pi = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Inside", path: inside }) });
    converted(pi.id);
    const g = gitWithLog();
    ({ plan } = await planFor(p.id, { docker, home, git: g.fn }));
    assert.equal(fs.existsSync(markerB), false, "git ran in B on the repo of a project with a project container");
    assert.deepEqual(g.calls, [], `git ran despite nesting: ${JSON.stringify(g.calls).slice(0, 400)}`);
    const h = plan.holdReasons.filter((x) => x.kind === "nested-converted");
    assert.deepEqual(h.map((x) => [x.projectId, x.situation]), [[pi.id, "project-container-darin"]], JSON.stringify(plan.holdReasons));
    assert.equal(plan.canRelocate, false);
  });
});

test("(7) a neighbor with a project container — a worktree of its repo in the project folder is not touched (hold reason), localReferences does not read its .venv", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const docker = fakeDocker(dockerState(proj)).fn;
    const neighbor = repoWith(path.join(ctx.root, "workspace", "neighbor"), { "docker-compose.yml": "services: {}\n" });
    write(path.join(neighbor, ".venv", "pyvenv.cfg"), `home = ${home}/.local/share/neighbor-tool/bin\n`);
    const pn = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Neighbor", path: neighbor }) });
    // Built-in counter-test: without the instance row localReferences reads the neighbor's pyvenv.cfg — the detector can turn red.
    const prior = await collectRelocationData({ projectId: p.id, docker, home });
    assert.deepEqual(prior.localReferences[pn.id], ["share/neighbor-tool"]);
    converted(pn.id);
    // A worktree of the neighbor repo in the project folder: working tree here, git directory and commondir at the neighbor.
    const wt = path.join(proj, "wt-neighbor");
    git(neighbor, "worktree", "add", "-q", wt, "-b", "cbase/wt");
    const markerC = decoy(ctx.root, neighbor, "c"); // only now: the test's own `worktree add` would otherwise run into the decoy
    const g = gitWithLog();
    const { plan, data } = await planFor(p.id, { docker, home, git: g.fn });
    assert.equal(fs.existsSync(markerC), false, "git ran core.fsmonitor from the neighbor's git directory");
    const h = plan.holdReasons.filter((x) => x.kind === "nested-converted");
    assert.deepEqual(h.map((x) => [x.projectId, x.situation, x.repo]), [[pn.id, "git-directory-in-project-container", wt]], JSON.stringify(plan.holdReasons));
    assert.deepEqual(g.calls.filter((a) => a.cwd === wt || a.cwd === neighbor), [], "git ran on the neighbor's worktree or repo");
    // localReferences never in the folder of a project with a project container.
    assert.equal(Object.hasOwn(data.localReferences, pn.id), false, "localReferences read in the folder of the neighbor with a project container");
    assert.deepEqual(data.localReferencesOpen, [pn.id]);
    assert.ok(plan.hints.some((x) => x.kind === "incomplete" && x.what === "localReferences" && x.projectId === pn.id), JSON.stringify(plan.hints));
  });
});

test("(8) an orphaned worktree under the cbase root holds BEFORE the stop, one in the runtime folder stays — none in move", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const app = path.join(proj, "app");
    const way = path.join(DIRS.scratch, "worktrees", "graph-way");
    git(app, "worktree", "add", "-q", way, "-b", "cbase/graph-way");
    fs.rmSync(way, { recursive: true, force: true }); // deleted without `git worktree prune`
    const rest = path.join(DIRS.data, "projects", p.id, "worktrees", "graph-rest"); // leftover of an earlier relocation
    git(app, "worktree", "add", "-q", rest, "-b", "cbase/graph-rest");
    const { plan, data } = await planFor(p.id, { docker: fakeDocker(dockerState(proj)).fn, home });
    const wWay = data.worktrees.find((w) => w.path.endsWith("graph-way"));
    assert.deepEqual([wWay?.prunable, wWay?.missing], [true, true], JSON.stringify(data.worktrees));
    assert.deepEqual(plan.worktrees.move.map((w) => path.basename(w.path)), ["graph-abc"], "an orphaned or already moved worktree is in move — step 13 would fail AFTER the stop");
    assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "worktree-orphaned").map((h) => path.basename(h.path)), ["graph-way"]);
    assert.deepEqual(plan.worktrees.stay.filter((w) => w.atTarget).map((w) => path.basename(w.path)), ["graph-rest"]);
    assert.ok(plan.hints.some((h) => h.kind === "worktree-at-target" && path.basename(h.path) === "graph-rest"), JSON.stringify(plan.hints));
  });
});

test("(9) a service registered by the agent with an open port holds the plan (native-service-unclear)", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const listener = net.createServer();
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    const port = listener.address().port;
    const svc = store.listProjectServices(p.id)[0];
    try {
      recordAgentRun({ projectId: p.id, service: { ...svc, port }, chatId: "c-agent" });
      const { plan } = await planFor(p.id, { docker: fakeDocker(dockerState(proj)).fn, home });
      const h = plan.holdReasons.filter((x) => x.kind === "native-service-unclear");
      assert.deepEqual(h.map((x) => [x.service, x.port, x.reason]), [[svc.id, port, "port-open"]], JSON.stringify(plan.holdReasons));
    } finally {
      await new Promise((r) => listener.close(() => r()));
      await endNativeRuns(p.id, []); // the entry is dead now and falls (step 4, clearing RUNS) — without a signal
    }
  });
});

test("(10) a cbase. label inherited from the image does not take the container out of the relocation set; images carry their labels", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const z = dockerState(proj);
    const image = { "cbase.acceptance": "s1-26", "cbase.anything": "yes" };
    z.images = z.images.map((i) => ({ ...i, Config: { Labels: image } }));
    // Like the real docker: the container carries the labels of its image (its own win).
    z.container = z.container.map((c) => (c.Name === "/demo-web-1" ? { ...c, Config: { ...c.Config, Labels: { ...image, ...c.Config.Labels } } } : c));
    const d = fakeDocker(z);
    const { plan, data } = await planFor(p.id, { docker: d.fn, home });
    assert.deepEqual(Object.keys(data.diffs), [id("web")], "diff for the container with an inherited label — never for the project container");
    assert.deepEqual(Object.keys(data.composeTexts), [path.join(proj, "docker-compose.yml")]);
    assert.deepEqual(plan.container.map((c) => c.name), ["demo-web-1"]);
    assert.deepEqual(data.images.map((i) => i.Labels), [image], "the labels of the image arrive");
    assert.deepEqual(kindsOf(plan).filter((a) => a === "data-missing" || a === "container-excluded"), []);
  });
});

test("(11) a process in the project folder holds the plan — the group of a recorded native run does not, one in the terminal of the lock only as a hint", async () => {
  assert.ok(terminalAvailable(), "node-pty missing — this guard needs a real terminal");
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const svc = store.addProjectService(p.id, { name: "native", startCommand: "exec sleep 3600" });
    const groups = [];
    let terminal = null;
    try {
      startSimple({ projectId: p.id, service: svc, cwd: proj, projectName: "Demo", workspaceId: ctx.ws.id });
      const run = nativeRuns(p.id).find((l) => l.serviceId === svc.id);
      assert.ok(run, "the native run is missing");
      groups.push(run.pid);
      terminal = createTerminal({ cwd: proj, command: "/bin/sleep", args: ["600"], tag: `proj:${p.id}` });
      const [shell] = terminalPidsByTag(`proj:${p.id}`);
      assert.ok(Number.isInteger(shell) && shell > 1, "the terminal shell has no pid");
      // The fake /proc: the leader of the recorded group and a member, a process of its own group (working directory in the
      // project) and a process in the session of the terminal — all with a working directory in the project.
      const fp = fakeProc(path.join(ctx.root, "proc-11"));
      fp.process({ pid: run.pid, cwd: proj, comm: "sh", pgid: run.pid, sid: run.pid });
      fp.process({ pid: 900001, cwd: path.join(proj, "app"), comm: "sleep", pgid: run.pid, sid: run.pid });
      fp.process({ pid: 900002, cwd: path.join(proj, "app"), comm: "node", pgid: 900002, sid: 900002, start: 4242 });
      fp.process({ pid: 900003, cwd: proj, comm: "npm", pgid: 900003, sid: shell });
      setProcessSeam({ root: fp.root, quietMs: 0 });
      const { plan, data } = await planFor(p.id, { docker: fakeDocker(dockerState(proj)).fn, home });
      assert.deepEqual(data.processes, [
        { pid: 900002, start: "proc:4242", program: "node" },
        { pid: 900003, start: "proc:1000", program: "npm", terminal: `proj:${p.id}` },
      ]);
      assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "process-in-project").map((h) => [h.pid, h.program, h.start]), [[900002, "node", "proc:4242"]]);
      assert.deepEqual(plan.hints.filter((h) => h.kind === "process-in-terminal").map((h) => [h.pid, h.terminal]), [[900003, `proj:${p.id}`]]);
      assert.ok(![...plan.holdReasons, ...plan.hints].some((h) => h.pid === run.pid || h.pid === 900001), "the group of the recorded run is in the plan");
      // COUNTER-TEST: without the exemption leader and member of the group would be in it — the exemption works, it is not accidental.
      assert.deepEqual(processesInProject({ projectPath: proj }).map((x) => x.pid), [run.pid, 900001, 900002, 900003].sort((a, b) => a - b));
    } finally {
      setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
      if (terminal) killTerminal(terminal.id);
      for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
    }
  });
});

// ── Further cases ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(12) without a project with a project container, a `.git` file without `gitdir:` does not hold the plan as \"nested-converted\"", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    write(path.join(proj, "broken", ".git"), "no reference\n");
    const { plan } = await planFor(p.id, { docker: fakeDocker(dockerState(proj)).fn, home });
    assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "nested-converted"), [], JSON.stringify(plan.holdReasons));
  });
});

test("(13) the collection carries the names of the environment of B, the volume names of foreign Compose files and the prefilled targets — names and numbers only", async () => {
  assert.deepEqual(volumeNamesFrom("services:\n  db:\n    image: x\n    name: not-this\nvolumes:\n  pg:\n    name: orbit_pgdata # old\n  raw: {}\n  flat: { name: \"flat_v\" }\n  var:\n    name: ${PG_VOLUME}\nnetworks:\n  n:\n    name: no_volume\n"),
    ["${PG_VOLUME}", "flat_v", "orbit_pgdata"]);
  assert.deepEqual(volumeNamesFrom(""), []);
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    write(path.join(ctx.root, "workspace", "other", "docker-compose.yml"), "services: {}\nvolumes:\n  pg:\n    name: demo_data\n");
    const saved = process.env.CBASE_RELOCATION_TEST_NAME;
    process.env.CBASE_RELOCATION_TEST_NAME = "value-the-never-appears";
    try {
      const { data, plan } = await planFor(p.id, { docker: fakeDocker(dockerState(proj)).fn, home });
      assert.ok(data.bEnvironmentNames.includes("CBASE_RELOCATION_TEST_NAME"), "the name is missing");
      assert.equal(JSON.stringify({ data: data.bEnvironmentNames, plan }).includes("value-the-never-appears"), false, "an environment value in the plan");
      assert.deepEqual(data.foreign.find((f) => f.name === "Other").volumeNames, ["demo_data"]);
      assert.deepEqual(data.runtimePrefilled, [], "nothing prefilled");
    } finally { if (saved === undefined) delete process.env.CBASE_RELOCATION_TEST_NAME; else process.env.CBASE_RELOCATION_TEST_NAME = saved; }
  });
});

test("(14) a descendant of a recorded native run in its own group arrives with `descendant` — the plan only names it", async () => {
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    const svc = store.addProjectService(p.id, { name: "native", startCommand: "exec sleep 3600" });
    const groups = [];
    try {
      startSimple({ projectId: p.id, service: svc, cwd: proj, projectName: "Demo", workspaceId: ctx.ws.id });
      const run = nativeRuns(p.id).find((l) => l.serviceId === svc.id);
      assert.ok(run, "the native run is missing");
      groups.push(run.pid);
      // The fake /proc: the leader of the recorded group (exempt) and its child in its OWN group and session (like a jupyter
      // kernel with `start_new_session`), both with a working directory in the project.
      const fp = fakeProc(path.join(ctx.root, "proc-14"));
      fp.process({ pid: run.pid, cwd: proj, comm: "sh", pgid: run.pid, sid: run.pid });
      fp.process({ pid: 900005, cwd: path.join(proj, "app"), comm: "kernel", ppid: run.pid, pgid: 900005, sid: 900005, start: 4343 });
      setProcessSeam({ root: fp.root, quietMs: 0 });
      const { plan, data } = await planFor(p.id, { docker: fakeDocker(dockerState(proj)).fn, home });
      assert.deepEqual(data.processes, [{ pid: 900005, start: "proc:4343", program: "kernel", descendant: true }]);
      assert.deepEqual(plan.hints.filter((h) => h.kind === "process-descendant").map((h) => [h.pid, h.program, h.start]), [[900005, "kernel", "proc:4343"]]);
      assert.deepEqual(plan.holdReasons.filter((h) => /^process-/.test(h.kind)), [], JSON.stringify(plan.holdReasons));
    } finally {
      setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
      for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
    }
  });
});

// The "empty" path of the collection stays (a legacy project with an empty folder still relocates through POST …/relocation).
// Checked at the place that decides (collect.js projectRepoData), not through a whole relocation.
test("(15) a COMPLETELY empty project folder gets no project repo (reason \"empty\") — in data and plan; a folder with only an empty subfolder gets one", async () => {
  await withAgentsServer(async (ctx) => {
    const home = path.join(ctx.root, "home-empty");
    fs.mkdirSync(home, { recursive: true });
    const docker = fakeDocker({ container: [], images: [], volumes: [], df: [], networks: [], diffs: {} }).fn;
    const create = (name, subfolder) => {
      const filePath = path.join(ctx.root, "workspace", name);
      fs.mkdirSync(subfolder ? path.join(filePath, "repo") : filePath, { recursive: true });
      const id = crypto.randomUUID();
      store.addProject(ctx.ws.id, { id, name, path: filePath, createdAt: Date.now() });
      return { id, path: filePath };
    };
    const empty = create("whole-empty", false);
    const { plan, data } = await planFor(empty.id, { docker, home });
    assert.deepEqual([data.projectRepo?.arises, data.projectRepo?.reason], [false, "empty"], JSON.stringify(data.projectRepo));
    assert.deepEqual([plan.projectRepo?.arises, plan.projectRepo?.reason], [false, "empty"], JSON.stringify(plan.projectRepo));
    assert.equal(fs.existsSync(path.join(empty.path, ".git")), false, "the collection created a repo");
    // The opposite direction: only an (empty) subfolder is NOT empty — the repo arises there as before.
    const including = create("with-subfolder", true);
    const two = await planFor(including.id, { docker, home });
    assert.equal(two.data.projectRepo?.arises, true, JSON.stringify(two.data.projectRepo));
    assert.equal(two.plan.projectRepo?.arises, true);
  });
});

test("(16) a language server of the project in B does not hold the plan — a foreign process still does", async () => {
  const fake = path.join(path.dirname(new URL(import.meta.url).pathname), "fake-lsp.mjs");
  await withAgentsServer(async (ctx) => {
    const { home, proj, p } = await prepare(ctx);
    setLspTable({ ts: { command: [process.execPath, fake] } });
    try {
      const s = await sessionFor({ projectId: p.id, instance: null, root: proj }, "ts");
      const leader = s.kind.pid;
      assert.deepEqual(groupsInB(p.id), [leader], "the group of the language server in B");
      const fp = fakeProc(path.join(ctx.root, "proc-16"));
      fp.process({ pid: leader, cwd: proj, comm: "node", pgid: leader, sid: leader });
      fp.process({ pid: 900011, cwd: proj, comm: "tsserver", pgid: leader, sid: leader });
      fp.process({ pid: 900012, cwd: path.join(proj, "app"), comm: "node", pgid: 900012, sid: 900012, start: 4343 });
      setProcessSeam({ root: fp.root, quietMs: 0 });
      const { plan, data } = await planFor(p.id, { docker: fakeDocker(dockerState(proj)).fn, home });
      assert.deepEqual(data.processes.map((x) => x.pid), [900012], JSON.stringify(data.processes));
      assert.deepEqual(plan.holdReasons.filter((h) => h.kind === "process-in-project").map((h) => h.pid), [900012]);
      assert.deepEqual(groupsInB(p.id), [leader], "the plan does not end the language server (it is read-only)");
      // COUNTER-TEST: without the exemption leader and member of the group would be in it.
      assert.deepEqual(processesInProject({ projectPath: proj }).map((x) => x.pid), [leader, 900011, 900012].sort((a, b) => a - b));
    } finally {
      setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
      endAllSessions("test");
      setLspTable(null);
    }
  });
});
