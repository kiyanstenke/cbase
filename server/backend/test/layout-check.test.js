// Reading and checking the layout of an existing project — `projectbox/layout/{read,program,docker-read,citations,routes}.js`.
//
// WHAT HOLDS HERE, each with its counter-test (CT) or built-in sabotage (S):
//   (R)  The rules on the inventory against `findRepos` (git.js): a repo carries CODE_REPO_LOCATION exactly when the repo search does
//        not see it (depth 5, under a dot folder, under `vendor/`); 26 repos => TOO_MANY_REPOS, findRepos returns 25; a marked folder
//        above a repo => REPO_IN_REPO (findRepos would then no longer see the inner one); a name with a line break => NAME_INVALID.
//        CT: `repoLocationVisible` with its own depth (5) => the case at depth 5 differs from findRepos.
//   (G1) Without operation all three routes answer 404 "only in server mode".
//   (E)  The level comes from the project container (a `docker exec … node -e <program>` in the log), hides `.git` and `.cbase-*`
//        of the root, shows code repos (`isRepo`) and worktrees (`worktreeOf`), rejects the inside of a block (IN_CODE_REPO), a link
//        in the path (REFERENCE), `..` (PATH) and missing things (PATH_MISSING).
//   (P)  The check (one procedure, 202, event, GET):
//        - leaving out a code repo: unpushed commits on a non-HEAD branch and on `copy/<n>/…` (named as a backup), stash, changes,
//          ignored files with names (`.env`), the linked worktree. CT: the read command of the git view (`READ_COMMANDS.gap`,
//          readRepoInfo) reports "0 0" on the same repo — it only sees HEAD.
//        - a repo without a remote: `noRemote`, `unpushed` null, the number of commits.
//        - docker of a left-out folder with sizes from `system df -v --format {{json .}}` (text "1.2MB" => 1200000); a volume that a
//          container OUTSIDE also uses is under `stays`, NOT in the delete list. CT: selecting by compose label alone would take it
//          along (computed from the state of the daemon).
//        - files that the project repo tracks under the path; services and knowledge that hang only there.
//        - a container without compose with a bind source under a moved path => warning WITHOUT_COMPOSE.
//        - the stack name through `config` WITHOUT `-p`, as `env -u COMPOSE_PROJECT_NAME docker compose …` in the container: new
//          folder name => STACK_NAME (with the `container_name` sentence "…-old-<short-id>"); moving under the same name => none;
//          `name:` => none; `COMPOSE_PROJECT_NAME` in `.env` => none. (The last two stacks carry the label of their FOLDER — they
//          were created before the `name:` or `.env` line; the label is therefore no witness of the future name.) The environment of
//          the project container carries COMPOSE_PROJECT_NAME — without `env -u` it would win. CT (on the fake compose of this
//          test, which mimics compose's order -p > environment > .env > name: > folder): with `-p <label>` (the way through
//          configModelArgs) the `name:` case would yield the folder name => a warning wrongly => red; without `env -u` the renamed
//          stack would yield the name of the environment => no warning => red. Plus the argument array in the fake docker's log.
//        - reference between stacks (the build.context of a stack outside points into a moved folder) => REFERENCE.
//        - virtual environments (pyvenv.cfg, shebang with the old path) => VENV.
//        - citations: a start command is listed and NOT changed; a credential only with key, without value.
//        - NOTHING changes: project folder (path, kind, size, mtime, content), inner daemon, database. S: the same snapshot
//          computation reports a single changed file.
//        - every git of the check ran in the container with GIT_HARDENING and `--no-optional-locks`.
//        - the event carries only type, projectId, kind, check, state.
//   (V)  The procedure: a second check aborts the running one (`aborted`, no result; held at the fake git); expired => 404 (knob 0);
//        `steps` missing => 400; a check of another project => 404; root is itself a code repo => GET `rootIsRepo` + `locked`,
//        POST 409 ROOT_IS_REPO. CT: with the marker of the project repo the same folder => `rootIsRepo: false`. The cap of the tree
//        (knob 2 with three nodes) => error CAP, never a truncated tree.
//
// SABOTAGES ON THE PRODUCT (each red):
//   1. `-p <label>` in composeNameArgs (docker-read.js)             => (P) red: withname/withenv "follow the folder", wrong STACK_NAME
//   2. without `-u COMPOSE_PROJECT_NAME`                              => (P) red: all three are called "from-the-environment", no warning
//   3. deleteSet without the check for users outside                  => (P) red: "shared" is in the delete list
//   4. git without `--no-optional-locks` (read.js)                    => (P) red at the SNAPSHOT: `git status` rewrites the index
//      (mtime of `.git/index` in apps/fresh and apps/core) — not only at the argument check
//   5. for-each-ref only `refs/heads/main`                            => (P) red: `unpushed` {total 0, refs []}
//   6. citation of a secret with `text`                               => (P) red at the credential entry
//   7. startCheck without aborting the running one                    => (V) red: A ends "finished" instead of "aborted"
//   8. worktree detection only against the given root path (first version of program.js) => (E) red: `apps/wt` came as code-repo
//      with gitFile — git writes `gitdir:` with the REAL path (macOS /private/var/… for /var/…)
//
// Note: `exec` runs LOCAL. No lsof/kill without a container address; the fake `env` of this test never calls a real docker — it
// only mimics `compose … config --format json --no-interpolate` and passes every other call through to /usr/bin/env.
//
// Run (one file alone, with the gate deadlines as in ./check):
//   env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 \
//     CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/layout-check.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { findRepos, READ_COMMANDS } from "../electron/server/git.js";
import { GIT_HARDENING } from "../electron/server/projectbox/projectRepo.js";
import { containerOf } from "../electron/server/projectbox/run-instance.js";
import { rulesResponse } from "../electron/server/projectbox/setup/rules.js";
import { layoutCore } from "../electron/server/projectbox/layout/program.js";
import { computePlan } from "../electron/server/projectbox/layout/plan.js";
import { forgetChecks } from "../electron/server/projectbox/layout/read.js";
import { hits } from "../electron/server/projectbox/layout/citations.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { FAKE_ENV } from "./fake-compose-env.mjs";
import {
  ONLY_IN_OPS_TEXT, request, create, dx, finished, git, gitHold, gitWaiting, gitContinue, inProject, withCreation, write,
} from "./setup-harness.mjs";

const rules = () => { const r = rulesResponse(); delete r.reserveBytes; return r; };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cbase-layout-${name}-`));
const gitInit = (abs) => {
  fs.mkdirSync(abs, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", abs]);
};
const commit = (abs, msg, file = `${msg}.txt`) => {
  write(path.join(abs, file), `${msg}\n`);
  execFileSync("git", ["-C", abs, "add", "-A"]);
  execFileSync("git", ["-C", abs, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg]);
};

// ── (R) rules against findRepos ───────────────────────────────────────────────────────────────────────────────────────────

test("(R) the rules on the inventory against findRepos: CODE_REPO_LOCATION exactly for the repos the repo search does not see — with counter-test", () => {
  const w = tmp("rules");
  try {
    for (const r of ["r1", "a/b/c/r4", "a/b/c/d/r5", ".hidden/r", "vendor/r"]) gitInit(path.join(w, r));
    write(path.join(w, "zeilen\numbruch.txt"), "x");
    const b = layoutCore(fs, path, "tree", { root: w, cap: 10_000 });
    const plan = computePlan(b.node, [], rules(), "inventory");
    const location = new Set(plan.error.filter((f) => f.code === "CODE_REPO_LOCATION").map((f) => f.path));
    const found = findRepos(w).map((p) => path.relative(w, p)).sort();
    assert.deepEqual(found, ["a/b/c/r4", "r1"]);
    assert.deepEqual(plan.repos.filter((r) => !location.has(r)).sort(), found, "visible by rule == found by findRepos");
    assert.deepEqual([...location].sort(), [".hidden/r", "a/b/c/d/r5", "vendor/r"]);
    assert.ok(plan.error.some((f) => f.code === "NAME_INVALID" && f.path === "zeilen\numbruch.txt"), "a line break in the name");
    // CT: an own depth (5) in the rule — the case at depth 5 then differs from findRepos.
    const r5 = rules();
    r5.limits.depth = 5;
    const different = computePlan(b.node, [], r5, "inventory");
    const location5 = new Set(different.error.filter((f) => f.code === "CODE_REPO_LOCATION").map((f) => f.path));
    assert.notDeepEqual(different.repos.filter((r) => !location5.has(r)).sort(), found, "CT: with an own depth the rule no longer matches findRepos");
    // Repo in repo: whoever marks `a` makes `a/b/c/r4` a repo in a repo — findRepos would then no longer see it (it stops at `a`).
    const marked = computePlan(b.node, [{ kind: "code-repo", path: "a" }], rules(), "inventory");
    assert.ok(marked.error.some((f) => f.code === "REPO_IN_REPO" && f.path === "a/b/c/r4" && f.second === "a"));
    fs.mkdirSync(path.join(w, "a", ".git"));
    assert.ok(!findRepos(w).map((p) => path.relative(w, p)).includes("a/b/c/r4"), "findRepos stops at the outer repo");
  } finally { fs.rmSync(w, { recursive: true, force: true }); }

  const v = tmp("26");
  try {
    for (let i = 0; i < 26; i++) fs.mkdirSync(path.join(v, `r${String(i).padStart(2, "0")}`, ".git"), { recursive: true });
    const plan = computePlan(layoutCore(fs, path, "tree", { root: v, cap: 10_000 }).node, [], rules(), "inventory");
    assert.ok(plan.error.some((f) => f.code === "TOO_MANY_REPOS"));
    assert.equal(findRepos(v).length, 25, "findRepos stops at 25 — the 26th would silently be missing");
    fs.rmSync(path.join(v, "r25"), { recursive: true });
    assert.ok(!computePlan(layoutCore(fs, path, "tree", { root: v, cap: 10_000 }).node, [], rules(), "inventory").error.some((f) => f.code === "TOO_MANY_REPOS"), "25 are allowed");
  } finally { fs.rmSync(v, { recursive: true, force: true }); }
});

test("(R) citations: an old path counts only as a whole path part", () => {
  assert.deepEqual(hits("cd data && ./start.sh", "data").map((t) => t.row), [1]);
  assert.deepEqual(hits("x\n--dir=/srv/p/data/y", "data").map((t) => t.row), [2]);
  assert.deepEqual(hits("database and mydatabase", "data"), [], "no part of a name");
  assert.deepEqual(hits("apps/x-new", "apps/x"), [], "no prefix of a name");
  assert.match(hits(`"a"\u0007 data`, "data")[0].text, /·/, "control characters are replaced");
});

// ── (G1) without operation ────────────────────────────────────────────────────────────────────────────────────────────────

test("(G1) without operation: GET, check and check status answer 404 “only in server mode”", async () => {
  await withAgentsServer(async (ctx) => {
    const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Old", path: path.join(ctx.root, "workspace", "old") } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    for (const [method, sub, body] of [["GET", "/layout"], ["POST", "/layout/check", { steps: [] }], ["GET", `/layout/check/${crypto.randomUUID()}`]]) {
      const x = await inProject(ctx, r.body.id, sub, { method, body });
      assert.equal(x.status, 404, `${method} ${sub}`);
      assert.match(x.body.error, ONLY_IN_OPS_TEXT, `${method} ${sub}`);
    }
  });
});

// ── shared by the server tests ────────────────────────────────────────────────────────────────────────────────────────────

// Change the state of a daemon of the fake docker under ITS lock (shape of fake-docker.mjs withState: folder `lock`
// with holder; the tick of the server reads and writes the same state).
function inState(fd, daemon, fn) {
  const folder = path.join(fd.dir, "daemon", encodeURIComponent(daemon));
  const lock = path.join(folder, "lock");
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== "EEXIST") throw e; }
    Atomics.wait(tick, 0, 0, 5); // tick of the lock, no deadline
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

// A snapshot of the project folder (read locally — that is the TEST): per entry kind, size, mtime and for files the content.
function snapshot(root) {
  const out = {};
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      const l = fs.lstatSync(p);
      const r = path.relative(root, p);
      out[r] = `${l.isDirectory() ? "d" : l.isSymbolicLink() ? "l" : "f"}:${l.size}:${l.mtimeMs}${l.isFile() ? `:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}` : ""}`;
      if (l.isDirectory()) stack.push(p);
    }
  }
  return out;
}

const ID_DB_APP = "da".repeat(32);
const label = (k, v) => ["--label", `${k}=${v}`];
const compose = (project, service, folder, extra = []) => [
  ...label("com.docker.compose.project", project), ...label("com.docker.compose.service", service),
  ...label("com.docker.compose.container-number", "1"), ...label("com.docker.compose.project.working_dir", folder),
  ...label("com.docker.compose.project.config_files", path.join(folder, "compose.yaml")), ...extra,
];
const end = (reader, id) => waitForTruthy(() => reader.events.find((e) => e.type === "project/layout" && e.check === id && e.state !== "running"), `check ${id} at its end`);

// ── (E) + (P) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(E)(P) level and check in the project container: git over all refs, docker with sizes, stack name without -p, references, venv, citations — and nothing changes", async () => {
  await withCreation(async ({ ctx, fd, reader }) => {
    const proj = await create(ctx, { name: "Layout", sources: [] });
    const pid = proj.id;
    await finished(pid);
    const w = proj.path;
    const cname = containerOf(store.projectInstance(pid, "main"));
    const d = (...args) => dx(fd, "exec", "-u", "agent", cname, "docker", ...args);
    const bin = path.join(ctx.root, "fake-bin");
    const envLog = path.join(ctx.root, "fake-env.jsonl");
    fs.writeFileSync(path.join(bin, "env"), FAKE_ENV(envLog), { mode: 0o755 });

    // Repos: apps/core (remote, one branch and one copy backup unpushed, stash, changes, .env ignored, a worktree),
    // apps/fresh (no remote).
    const core = path.join(w, "apps", "core");
    const remote = path.join(ctx.root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    gitInit(core);
    commit(core, "one");
    write(path.join(core, ".gitignore"), ".env\n");
    commit(core, "two");
    execFileSync("git", ["-C", core, "remote", "add", "origin", remote]);
    execFileSync("git", ["-C", core, "push", "-q", "-u", "origin", "main"]);
    execFileSync("git", ["-C", core, "checkout", "-q", "-b", "feature"]);
    commit(core, "feature");
    execFileSync("git", ["-C", core, "checkout", "-q", "-b", "copy/k1/main", "main"]);
    commit(core, "backup");
    execFileSync("git", ["-C", core, "checkout", "-q", "main"]);
    write(path.join(core, "one.txt"), "changed for the stash\n");
    execFileSync("git", ["-C", core, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "stash", "-q"]);
    write(path.join(core, "one.txt"), "changed\n");
    write(path.join(core, "fresh.txt"), "new\n");
    write(path.join(core, ".env"), "SECRET=1\n");
    execFileSync("git", ["-C", core, "worktree", "add", "-q", "-b", "wt", path.join(w, "apps", "wt")]);
    const fresh = path.join(w, "apps", "fresh");
    gitInit(fresh);
    commit(fresh, "alone");
    // CT for (P) git: the read command of the git view (readRepoInfo) sees only HEAD against its upstream.
    assert.equal(git(core, ...READ_COMMANDS.gap).replace(/\s+/g, " "), "0 0", "CT: readRepoInfo does not see the unpushed branches");

    // Docker: the stack "db" in services/db (left out), a volume that the stack "outside" also uses.
    for (const o of ["services/db", "outside", "library", "data", "stacks/renamed", "stacks/moved", "stacks/withname", "stacks/withenv", "other"]) fs.mkdirSync(path.join(w, o), { recursive: true });
    for (const o of ["services/db", "outside", "stacks/renamed", "stacks/moved", "stacks/withenv"]) write(path.join(w, o, "compose.yaml"), "services:\n  app:\n    image: x\n");
    write(path.join(w, "stacks", "withname", "compose.yaml"), "name: fixed\nservices:\n  app:\n    image: x\n");
    write(path.join(w, "stacks", "withenv", ".env"), "COMPOSE_PROJECT_NAME=envfixed\n");
    write(path.join(w, "library", "lib.txt"), "lib\n");
    write(path.join(w, "data", "start.sh"), "#!/bin/sh\n");
    write(path.join(w, ".cbase-test", "x"), "hidden\n");
    fs.symlinkSync(path.join(w, "data"), path.join(w, "reference"));
    const images = path.join(ctx.root, "images.json");
    fs.writeFileSync(images, JSON.stringify({ fakeDockerImages: [{ ref: "db-app:latest", id: ID_DB_APP, labels: { "com.docker.compose.project": "db" } }] }));
    d("image", "load", "-i", images);
    d("volume", "create", ...label("com.docker.compose.project", "db"), "db_data");
    d("volume", "create", ...label("com.docker.compose.project", "db"), "shared");
    d("network", "create", ...label("com.docker.compose.project", "db"), "db_default");
    d("run", "-d", "--name", "db-app-1", "--network", "db_default", ...compose("db", "app", path.join(w, "services", "db")),
      "--mount", "type=volume,source=db_data,target=/var/lib/db", "--mount", "type=volume,source=shared,target=/shared", "db-app:latest");
    d("run", "-d", "--name", "outside-app-1", ...compose("outside", "app", path.join(w, "outside")), "--mount", "type=volume,source=shared,target=/shared", "alpine:3");
    d("run", "-d", "--name", "without-compose", "--mount", `type=bind,source=${path.join(w, "data")},target=/data`, "alpine:3");
    d("run", "-d", "--name", "renamed-app-1", ...compose("renamed", "app", path.join(w, "stacks", "renamed")), "alpine:3");
    d("run", "-d", "--name", "db-fixed", ...compose("renamed", "db", path.join(w, "stacks", "renamed")), "alpine:3");
    d("run", "-d", "--name", "moved-app-1", ...compose("moved", "app", path.join(w, "stacks", "moved")), "alpine:3");
    d("run", "-d", "--name", "withname-app-1", ...compose("withname", "app", path.join(w, "stacks", "withname")), "alpine:3");
    d("run", "-d", "--name", "withenv-app-1", ...compose("withenv", "app", path.join(w, "stacks", "withenv")), "alpine:3");
    inState(fd, cname, (z) => { z.volumes.db_data.size = 1234567; z.volumes.shared.size = 2000; });
    // The environment of the project container carries COMPOSE_PROJECT_NAME (see header).
    inState(fd, "host", (z) => { Object.values(z.container).find((c) => c.name === cname).env.COMPOSE_PROJECT_NAME = "from-the-environment"; });

    // venv: pyvenv.cfg and a shebang with the old absolute path.
    write(path.join(w, "tool", ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
    write(path.join(w, "tool", "env2", "bin", "tool"), `#!${path.join(w, "tool", "env2", "bin", "python")}\nprint(1)\n`);
    fs.chmodSync(path.join(w, "tool", "env2", "bin", "tool"), 0o755);

    // The project repo tracks services/db/compose.yaml; a service and a knowledge entry in services/db; a start command names "data".
    execFileSync("git", ["-C", w, "add", "--", "services/db/compose.yaml"]);
    execFileSync("git", ["-C", w, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "test"]);
    const dbService = store.addProjectService(pid, { name: "db-service", dir: "services/db", startCommand: "docker compose up" });
    const dataService = store.addProjectService(pid, { name: "data-service", dir: "data", startCommand: "cd data && ./start.sh" });
    store.createProjectContext(pid, { category: "architecture", title: "DB", body: "the database", codePaths: ["services/db/compose.yaml"] });
    store.createProjectVar(pid, { key: "DATA_PATH", kind: "secret", value: `${w}/data/secret`, description: "" });

    // ── (E) the level ─────────────────────────────────────────────────────────────────────────────────────────────────────
    const beforeLevel = fd.calls({ daemon: "host" }).length;
    const root = await inProject(ctx, pid, "/layout");
    assert.equal(root.status, 200, JSON.stringify(root.body));
    const names = root.body.entries.map((e) => e.name);
    assert.ok(!names.includes(".git") && !names.includes(".cbase-test"), `verborgen: ${names.join(", ")}`);
    assert.deepEqual(names, [...names].sort(), "sorted by name");
    assert.deepEqual(root.body.entries.find((e) => e.name === "reference"), { name: "reference", kind: "file", reference: true });
    assert.equal(root.body.rootIsRepo, false);
    assert.equal(root.body.locked, null);
    assert.ok(fd.calls({ daemon: "host" }).slice(beforeLevel).some((a) => a.args[0] === "exec" && a.args.includes(cname) && a.args.includes("-e") && a.args.includes("level")), "the level read the container program");
    const apps = await inProject(ctx, pid, "/layout", { query: "path=apps" });
    assert.deepEqual(apps.body.entries, [
      { name: "core", kind: "code-repo", isRepo: true },
      { name: "fresh", kind: "code-repo", isRepo: true },
      { name: "wt", kind: "worktree", isRepo: false, worktreeOf: "apps/core" },
    ]);
    for (const [query, status, code] of [["path=apps/core", 409, "IN_CODE_REPO"], ["path=apps/core/x", 409, "IN_CODE_REPO"], ["path=reference", 409, "REFERENCE"],
      ["path=../x", 400, "PATH"], ["path=missing", 404, "PATH_MISSING"], ["path=data/start.sh", 400, "NO_FOLDER"], ["path=.git", 404, "PATH_MISSING"]]) {
      const r = await inProject(ctx, pid, "/layout", { query });
      assert.equal(r.status, status, `${query}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, query);
    }

    // ── (P) the check ─────────────────────────────────────────────────────────────────────────────────────────────────────
    const steps = [
      { kind: "leaveOut", path: "apps/core" },
      { kind: "leaveOut", path: "apps/fresh" },
      { kind: "leaveOut", path: "services/db" },
      { kind: "move", from: "data", to: "other/data" },
      { kind: "move", from: "library", to: "other/library" },
      { kind: "move", from: "stacks/renamed", to: "stacks/new-name" },
      { kind: "move", from: "stacks/moved", to: "other/moved" },
      { kind: "move", from: "stacks/withname", to: "stacks/withname2" },
      { kind: "move", from: "stacks/withenv", to: "stacks/withenv2" },
      { kind: "move", from: "tool", to: "other/tool" },
    ];
    const prior = { folder: snapshot(w), daemon: fd.state(cname), services: store.listProjectServices(pid) };
    const beforeCalls = fd.calls({ daemon: "host" }).length;
    const post = await inProject(ctx, pid, "/layout/check", { method: "POST", body: { steps } });
    assert.equal(post.status, 202, JSON.stringify(post.body));
    const id = post.body.check;
    const ev = await end(reader, id);
    assert.equal(ev.state, "finished", JSON.stringify((await inProject(ctx, pid, `/layout/check/${id}`)).body.error));
    for (const e of reader.events.filter((x) => x.type === "project/layout")) {
      assert.deepEqual(Object.keys(e).sort(), ["check", "kind", "projectId", "state", "type"], "only ids and state");
    }
    const g = await inProject(ctx, pid, `/layout/check/${id}`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.steps, steps);
    const e = g.body.result;
    assert.deepEqual(e.finalMapping.gone, ["apps/core", "apps/fresh", "services/db"]);
    assert.deepEqual(e.error.filter((f) => !f.prior), [], JSON.stringify(e.error));

    // Git of an omitted code repo.
    const wk = e.leaveOut.find((x) => x.path === "apps/core");
    const k = wk.repos.find((r) => r.path === "apps/core");
    assert.equal(k.branch, "main");
    assert.equal(k.noRemote, false);
    assert.deepEqual(k.unpushed.refs.map((r) => [r.ref, r.commits]).sort(), [["refs/heads/copy/k1/main", 1], ["refs/heads/feature", 1]], JSON.stringify(k.unpushed));
    assert.equal(k.unpushed.total, 2);
    assert.deepEqual(k.copyBackups, [{ name: "k1", branches: ["copy/k1/main"] }]);
    assert.ok(k.withoutUpstream.includes("feature") && !k.withoutUpstream.includes("main"));
    assert.equal(k.stashes, 1);
    assert.equal(k.changes, 2, "one.txt changed, fresh.txt new");
    assert.ok(k.ignored.names.includes(".env"), JSON.stringify(k.ignored));
    assert.deepEqual(k.worktrees.map((x) => [x.path, x.branch, x.missing, x.outside]), [["apps/wt", "wt", false, undefined]], "relative, although git names the real path (macOS: /private/var/…)");
    assert.deepEqual(k.unreadable, []);
    assert.ok(wk.size.bytes > 0 && wk.size.files > 5, JSON.stringify(wk.size));
    const fr = e.leaveOut.find((x) => x.path === "apps/fresh").repos[0];
    assert.deepEqual([fr.noRemote, fr.unpushed, fr.commits], [true, null, 1]);
    // Git of a left-out code repo.
    // Docker of the left-out folder: sizes from {{json .}}, the shared volume stays.
    const wd = e.leaveOut.find((x) => x.path === "services/db");
    assert.deepEqual(wd.docker.container.map((c) => c.name), ["db-app-1"]);
    assert.deepEqual(wd.docker.volumes, [{ name: "db_data", size: 1200000 }], "“1.2MB” from system df");
    assert.deepEqual(wd.docker.networks.map((n) => n.name), ["db_default"]);
    assert.deepEqual(wd.docker.images.map((i) => i.id), [`sha256:${ID_DB_APP}`]);
    assert.deepEqual(wd.docker.stays, [{ kind: "volume", name: "shared", size: 2000, usedBy: ["outside-app-1"] }]);
    // CT: selected by compose label alone, “shared” would be in the delete list.
    const byLabel = Object.values(fd.state(cname).volumes).filter((v) => v.labels["com.docker.compose.project"] === "db").map((v) => v.name).sort();
    assert.deepEqual(byLabel, ["db_data", "shared"], "CT: the label selection would take the shared volume along");
    assert.deepEqual(e.confirmable.volumes.map((v) => v.name), ["db_data"]);
    assert.ok(e.confirmable.container.some((c) => c.name === "db-app-1"));
    assert.deepEqual(wd.projectRepo, { count: 1, names: ["services/db/compose.yaml"] });
    assert.deepEqual(wd.services, [{ id: dbService.id, name: "db-service" }]);
    assert.equal(wd.knowledge, 1);

    // Warnungen.
    const w_ = (code) => e.warnings.filter((x) => x.code === code);
    assert.deepEqual(w_("WITHOUT_COMPOSE").map((x) => [x.container, x.path]), [["without-compose", "data"]]);
    // Reference between stacks: build.context of "outside" points into the moved "library" — visible only from the model (the
    // labels of outside-app-1 name only outside/ and the volume).
    assert.deepEqual(w_("REFERENCE").map((x) => [x.stack, x.path, x.kind, x.file]), [["outside", "library", "build", "outside/compose.yaml"]]);
    const sn = w_("STACK_NAME");
    assert.deepEqual(sn.map((x) => [x.stack, x.fresh]), [["renamed", "new-name"]], JSON.stringify(e.stacks));
    const fixed = Object.values(fd.state(cname).container).find((c) => c.name === "db-fixed");
    assert.deepEqual(sn[0].containerName, [{ name: "db-fixed", afterwards: `db-fixed-old-${fixed.id.slice(0, 12)}` }]);
    assert.match(sn[0].text, /-old-/);
    assert.deepEqual(e.stacks.map((s) => [s.stack, s.name, s.followsFolder]).sort(), [["renamed", "renamed", true], ["withenv", "envfixed", false], ["withname", "fixed", false]], "moved (same name) does not even ask");
    assert.deepEqual(w_("VENV").map((x) => x.path).sort(), ["tool/.venv", "tool/env2"]);
    // The call without -p, with env -u, in the container.
    const configCalls = fd.calls({ daemon: "host" }).slice(beforeCalls).filter((a) => a.args[0] === "exec" && a.args.includes("config") && a.args.includes("env"));
    assert.equal(configCalls.length, 3, "renamed, withname, withenv");
    for (const a of configCalls) {
      const rest = a.args.slice(a.args.indexOf("env"));
      assert.deepEqual(rest.slice(0, 5), ["env", "-u", "COMPOSE_PROJECT_NAME", "docker", "compose"]);
      assert.ok(!rest.includes("-p"), "without -p");
      assert.deepEqual(rest.slice(-4), ["config", "--format", "json", "--no-interpolate"]);
    }
    const envCalls = fs.readFileSync(envLog, "utf8").trim().split("\n").map((z) => JSON.parse(z));
    assert.ok(envCalls.every((x) => x.unset.includes("COMPOSE_PROJECT_NAME") && x.environment === null), "the environment did not arrive");
    // CT on the fake compose: with -p (configModelArgs) the name: stack would be named like its label (= the folder) => a warning
    // wrongly; without env -u the renamed stack would be named like the environment => no warning.
    const fakeEnv = (args, environment = {}) => JSON.parse(execFileSync(path.join(bin, "env"), args, { encoding: "utf8", env: { ...process.env, ...environment } })).name;
    const withName = path.join(w, "stacks", "withname");
    assert.equal(fakeEnv(["-u", "COMPOSE_PROJECT_NAME", "docker", "compose", "-p", "withname", "--project-directory", withName, "-f", path.join(withName, "compose.yaml"), "config", "--format", "json", "--no-interpolate"]), "withname", "CT: -p overrides name:");
    const umb = path.join(w, "stacks", "renamed");
    assert.equal(fakeEnv(["docker", "compose", "--project-directory", umb, "-f", path.join(umb, "compose.yaml"), "config", "--format", "json", "--no-interpolate"], { COMPOSE_PROJECT_NAME: "from-the-environment" }), "from-the-environment", "CT: without env -u the environment wins");

    // Citations: listed, nothing changed; a secret without value.
    const fs_ = e.citations.list;
    assert.ok(fs_.some((x) => x.kind === "service" && x.name === "data-service" && x.field === "start_command" && x.row === 1 && x.text.includes("cd data")), JSON.stringify(fs_));
    const secret = fs_.find((x) => x.kind === "credential");
    assert.deepEqual(secret, { kind: "credential", name: "DATA_PATH", field: "DATA_PATH", secret: true, path: "data" });
    assert.ok(!JSON.stringify(e).includes("/data/secret"), "no value of a secret in the response");
    assert.deepEqual(e.citations.unreadable, []);
    assert.equal(store.getProjectService(dataService.id).startCommand, "cd data && ./start.sh", "the start command is NOT changed");

    // Nothing has changed — and the computation sees a change (S).
    const after = snapshot(w);
    assert.deepEqual(after, prior.folder, "the project folder is unchanged");
    assert.deepEqual(fd.state(cname).container, prior.daemon.container, "the inner daemon: containers equal");
    assert.deepEqual([fd.state(cname).volumes, fd.state(cname).networks, fd.state(cname).images], [prior.daemon.volumes, prior.daemon.networks, prior.daemon.images]);
    assert.deepEqual(store.listProjectServices(pid), prior.services);
    fs.appendFileSync(path.join(w, "data", "start.sh"), "# x\n");
    assert.notDeepEqual(snapshot(w), after, "S: a changed file shows in the snapshot");

    // Every git of the check in the container, hardened and without optional locks.
    const gitCalls = fd.calls({ daemon: "host" }).slice(beforeCalls).filter((a) => a.args[0] === "exec" && a.args.includes("git"));
    assert.ok(gitCalls.length >= 10, `${gitCalls.length} git calls`);
    for (const a of gitCalls) {
      const gg = a.args.slice(a.args.indexOf("git") + 1).join(" ");
      assert.ok(gg.startsWith(`${GIT_HARDENING.join(" ")} --no-optional-locks `), `unhardened: git ${gg.slice(0, 160)}`);
    }

    forgetChecks();
  }, { fdOpts: { compose: { outside: { app: { image: "x", build: { context: "../library" } } } } } });
});

// ── (V) the procedure ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("(V) the procedure: 400 without steps, a new check aborts the running one, expired and foreign project 404, cap of the tree, root is a repo", async () => {
  await withCreation(async ({ ctx, reader, gitGates }) => {
    const proj = await create(ctx, { name: "Procedure", sources: [] });
    const pid = proj.id;
    await finished(pid);
    const repo = path.join(proj.path, "repo");
    gitInit(repo);
    commit(repo, "one");
    write(path.join(proj.path, "notes", "a.txt"), "a\n"); // three nodes (repo, notes, notes/a.txt) — above the cap 2 below
    const steps = [{ kind: "leaveOut", path: "repo" }];
    const check = (body, p = pid) => inProject(ctx, p, "/layout/check", { method: "POST", body });
    const view = (id, p = pid) => inProject(ctx, p, `/layout/check/${id}`);
    const prior = { check: process.env.CBASE_LAYOUT_CHECK_MS, tree: process.env.CBASE_LAYOUT_TREE_CAP };
    try {
      // a missing field is no instruction.
      for (const body of [{}, { steps: "x" }, { steps: [{ path: "repo" }] }, { steps: [{ kind: "move", from: "repo" }] }]) {
        const r = await check(body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.code, "STEPS");
      }

      // A second check aborts the first — the first is held at the fake git (for-each-ref of the repo).
      gitHold(gitGates, "for-each-ref");
      const a = await check({ steps });
      assert.equal(a.status, 202, JSON.stringify(a.body));
      await gitWaiting(gitGates, "for-each-ref");
      assert.equal((await view(a.body.check)).body.state, "running");
      const b = await check({ steps });
      assert.equal(b.status, 202);
      gitContinue(gitGates, "for-each-ref");
      assert.equal((await end(reader, a.body.check)).state, "aborted");
      assert.equal((await end(reader, b.body.check)).state, "finished");
      const sa = (await view(a.body.check)).body;
      assert.equal(sa.state, "aborted");
      assert.ok(!("result" in sa), "an aborted check carries no result");
      const sb = await view(b.body.check);
      assert.equal(sb.status, 200);
      assert.deepEqual(sb.body.result.leaveOut.map((x) => [x.path, x.repos[0].noRemote, x.repos[0].commits]), [["repo", true, 1]]);

      // A check belongs to its project.
      const second = await create(ctx, { name: "Second", sources: [] });
      await finished(second.id);
      const foreign = await view(b.body.check, second.id);
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.code, "CHECK_UNKNOWN");

      // Expired (knob 0): gone at the next read — the same id answered 200 just before (counter-test above).
      process.env.CBASE_LAYOUT_CHECK_MS = "0";
      const old = await view(b.body.check);
      assert.equal(old.status, 404);
      assert.equal(old.body.code, "CHECK_UNKNOWN");
      delete process.env.CBASE_LAYOUT_CHECK_MS;
      assert.equal((await view(crypto.randomUUID())).status, 404);

      // The cap of the tree: above it the check fails with a message — never a truncated tree (counter-test: B above, without the knob).
      process.env.CBASE_LAYOUT_TREE_CAP = "2";
      const c = await check({ steps });
      assert.equal((await end(reader, c.body.check)).state, "error");
      const sc = (await view(c.body.check)).body;
      assert.equal(sc.error.code, "CAP", JSON.stringify(sc.error));
      assert.ok(!("result" in sc));
      delete process.env.CBASE_LAYOUT_TREE_CAP;

      // The root is itself a code repo (a .git without the marker of the project repo) => view only.
      const beforeP54 = await inProject(ctx, pid, "/layout");
      assert.equal(beforeP54.body.rootIsRepo, false, "CT: with the marker the root is the project repo");
      const marker = git(proj.path, "config", "--get", "cbase.projectRepo");
      git(proj.path, "config", "--unset", "cbase.projectRepo");
      try {
        const g = await inProject(ctx, pid, "/layout");
        assert.equal(g.status, 200);
        assert.equal(g.body.rootIsRepo, true);
        assert.equal(g.body.locked.reason, "root-is-repo");
        const p = await check({ steps });
        assert.equal(p.status, 409);
        assert.equal(p.body.code, "ROOT_IS_REPO");
      } finally { git(proj.path, "config", "cbase.projectRepo", marker); }
    } finally {
      for (const [k, v] of [["CBASE_LAYOUT_CHECK_MS", prior.check], ["CBASE_LAYOUT_TREE_CAP", prior.tree]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      forgetChecks();
    }
  });
});
