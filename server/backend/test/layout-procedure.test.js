// The execution of a layout — `projectbox/layout/{procedure,docker-rebuild,bringAlong,label-files,rebuild-program}.js`, plus the
// worktree cut of empty repos (workflows/worktree.js) and the write lock LAYOUT_RUNNING.
//
// The real server with the real connection (server.js setLayoutExecution(layoutProcedure)), the fake docker with an inner daemon in
// the project container, a fake /proc for the search in the container (setProcSearchSeam) and in B (setProcessSeam), the native
// services through the test seam `setLayoutServices` (state, stop, start as recorders — a start would otherwise run locally).
// The look-again tick is set to one hour (every progress comes from an event or an explicit nudge), the SIGTERM → SIGKILL deadline
// to 0 (the second pass sends SIGKILL).
//
// WHAT HOLDS HERE, each with its counter-test (CT) or built-in sabotage (S, below):
//   (A)  The whole procedure on an inventory: `apps` (code repo `core` with linked worktree `core-wt`) → `packages`; the stack `api`
//        (`stacks/api` → `api`, same folder name => re-created with `--force-recreate`, it ran => it runs); the stack `web` with a
//        fixed `container_name` `web-fixed` (`stacks/web` → `stacks/frontend`: compose then calls it "frontend" => the old container
//        is in `project_superseded`, renamed to `web-fixed-old-<short-id>` (`docker rename <id>`), stopped; the new `frontend-app-1`
//        runs); `services/db` left out (container, volume, network, image gone by id — and a container that appeared there AFTER the
//        check is under `add` in the report); `tools` becomes a code repo (empty commit). Plus: the worktree through `worktree
//        repair` from the main repo (git reads `packages/core-wt`), the services (`dir` rewritten, the one under `services/db` is
//        dropped), the knowledge (path rewritten), the native services (all running ones stopped, the dropped one not restarted), a
//        background process in the project container under `stacks/api` (fake /proc: SIGTERM ignored => SIGKILL, in the report), the
//        silent hint to the workspace chat, the event `kind: "finished"`, marker and lock gone; every `worktree` git with
//        GIT_HARDENING, the reading ones with `--no-optional-locks`; an uninvolved container keeps running untouched.
//   (S1) The write lock and `projectWork` while the procedure runs (at the gate of the fake docker before `stop`): files/write on
//        project AND workspace level 409 LAYOUT_RUNNING, service start 409 LAYOUT_RUNNING, `/api/runs/active` with
//        `{ state: "layout", phase: "stop" }`, `layoutsOpen` 1, `busy`. CT: after the end files/write works (200).
//   (N1) Restart BEFORE the turnaround (the procedure ends with the server after `stop`, `ctx.restart()`): without the post-start hook
//        no lock (CT), the hook sets `backward`, lock and marker; the own row of an EARLIER process is not in `projectWork` but
//        counts in `layoutsOpen`; the restore (`ready`) runs the way back — the old restart rule is back, the container runs, the
//        native service is started — and the job WAITS again (not `error`); a nudge then runs it all the way through.
//   (N2) Restart AFTER the turnaround (at the git gate of `init` in step 13): the lock holds without a living procedure (files/write
//        409); the restore continues FORWARD — no way-back step (the old restart rule does not come back), finished. Then the
//        worktree cut at this project: a graph worktree skips `tools` (empty HEAD tree), takes `apps/core`, and the prompt names the
//        skipped one (CT: without `skipped` no sentence).
//   (G)  Cross-check: between check and turnaround the target folder `api` appears (at the git gate of `worktree` in step 1) =>
//        LAYOUT_CHANGED, the way back runs (restart rule back, container and native services run again), `error` before the
//        turnaround with "check again", lock and marker gone, withdrawing works (200), nothing changed in the tree.
//   (F)  An error AFTER the turnaround: `services/db/data` is write-protected => leaving out refused => the root fallback runs
//        through `docker exec -u root` (in the log; on the test machine that is no root, it fails too) => `error` with `turned`,
//        step `leaveOut`; the lock STAYS (files/write 409), marker stays, withdrawing 409, `layoutsOpen` 1, not in `projectWork`.
//        "Try again" (after chmod) continues AT THE STEP: no second `stop`/`update`, finished.
//   (Pr) /proc (B sees its OWN fake /proc `procB`, knob B_QUIET_MS 0): between quiet and step 5 a process WITHOUT a run starts in B
//        under `stacks/api` => step 5 (a) sends the job back to `waiting`, the quiet shows it as `process` (not stoppable); without
//        it the job runs through. A left-out link (`tool-link` → a folder outside) falls, its target and the processes in it
//        (container and B) stay untouched; the VS Code server in the project container gets SIGTERM, then SIGKILL, with a sentence in
//        the report.
//   (D)  Docker: a stack whose service carries a BUILT image (`web-app`) is created under the new name from the same image and runs
//        (CT: `frontend-app` did not exist before); a stack whose re-creation fails stays stopped and gives its old containers back
//        from `project_superseded`; `supersede` a second time does not rename again (CT: the rename to its own name throws); a
//        volume of two left-out folders is in the confirmation for BOTH under "falls", is confirmed and missing in `add` (CT:
//        computed per path it stood under "stays").
//   (Wt) Graph worktree over two repos: the left-out one falls from the row with its own entries, the row stays; the link
//        `node_modules` then points to the new place and resolves (CT: before, absolute to the old one).
//   (Wd) Repeatable: an occupied parking place (`.cbase-layout/0`, the check does not see it) holds BEFORE the turnaround with way
//        back; "..old" with write-protected content goes into the root fallback instead of synchronously throwing "not in the
//        project folder"; step 13 fails at the commit of the second code repo (git gate) — the report already carries the first,
//        and after a lost report the repetition finds it at its commit (report and hint name both).
//   (A)  plus: the start instruction of the dropped service goes with it (CT: the one of the remaining one stays).
//
// SABOTAGES ON THE PRODUCT (each red):
//   1. procedure.js step `worktrees` without `worktree repair`              => (A) red (git does not read packages/core-wt)
//   2. procedure.js `crossCheck` without the LAYOUT_CHANGED throw           => (G) red (past the turnaround, `error` in `place`)
//   3. setup/status.js layoutWriteLock always false                          => (S1)(N1), (N2), (F) red (files/write 200 instead of 409)
//   4. workflows/worktree.js without the cut of empty trees                 => (N2) red (`tools` not skipped)
//   5. procedure.js afterReturnPath without the "post-start" branch (always `error`) => (S1)(N1) red (error instead of waiting)
//   6. docker-rebuild.js supersede without `docker rename`                  => (A) red ("web-fixed renamed")
//   7. procedure.js errorAfterTurnaround with releaseLock instead of setLock => (F) red (the lock fell after the turnaround)
//   8. server.js without setLayoutExecution(layoutProcedure)                => all five red (the job stayed `running` without a
//      procedure; red instead of hanging because of the cleanup in the finally — the row held `projectWork` and so the quiet of the harness)
//   9. processes-in-b.js without the holder "process"                       => (Pr) red, layout-quiet (W) red
//  10. proc-program.js search path = realpath of the whole path             => (Pr) red, layout-quiet (P) "link" red
//  11. procedure.js `crossCheck` without the parking place                  => (Wd) red
//  12. docker-rebuild.js supersede without the name of now (always rename)  => (D) red
//  13. docker-rebuild.js composeNew without imageNamesBringAlong            => (D) red
//  14. bringAlong.js graphPlan empties the whole row                        => (Wt) red
//  15. procedure.js `worktrees` without `links`                             => (Wt) red
//  16. procedure.js `code-repos` without the commit reading / without a report per repo => (Wd) red (both)
//  17. bringAlong.js `rel.startsWith("..")`                                 => (Wd) red
//  18. docker-read.js delete set per path                                   => (D) red
//  19. store/projects.js serviceFallsWithLayout without the start instruction => (A) red
//  20. procedure.js `terminals` without the end of the editor sessions      => (Pr) red
//
// Note: `exec` runs LOCAL — the /proc search here ALWAYS reads a fake /proc (a signal is written to `signals.jsonl`, never sent to a
// real pid), and no service is really started (test seam).
//
// Run (one file alone, with the gate deadlines as in ./check):
//   env -u NODE_TEST_CONTEXT CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 \
//     CBASE_AGENT_STALL_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/layout-procedure.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { BOOT_ID } from "../electron/server/app-state.js";
import { GIT_HARDENING } from "../electron/server/projectbox/projectRepo.js";
import { containerOf } from "../electron/server/projectbox/run-instance.js";
import { restoreInstance } from "../electron/server/projectbox/restore.js";
import { layoutStatus } from "../electron/server/projectbox/setup/status.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { locationFor, worktreeRoot } from "../electron/server/runs/runtime-location.js";
import { worktreePrompt } from "../electron/server/runs/system-prompt.js";
import { setRebuildMarker, rebuildMarkerStands } from "../electron/server/services.js";
import { setProcessSeam } from "../electron/server/projectbox/relocation/processes.js";
import { setProcSearchSeam } from "../electron/server/projectbox/layout/proc-program.js";
import { forgetChecks } from "../electron/server/projectbox/layout/read.js";
import {
  forgetJobs, checkBackLayout, layoutRestartGrace, quietCheckRunning, lockStands,
} from "../electron/server/projectbox/layout/job.js";
import { PARK, forgetProcedures, layoutProcedureAlive, setLayoutServices } from "../electron/server/projectbox/layout/procedure.js";
import { supersede } from "../electron/server/projectbox/layout/docker-rebuild.js";
import { dockerInventory, deleteSet } from "../electron/server/projectbox/layout/docker-read.js";
import { CODE_REPO_MESSAGE, CODE_REPO_MESSAGE_BEFORE } from "../electron/server/projectbox/setup/code-repos.js";
import { removeGraphWorktree, createGraphWorktree } from "../electron/server/workflows/worktree.js";
import { waitForTruthy } from "./agent-harness.mjs";
import { fakeProc } from "./fake-proc.mjs";
import { FAKE_ENV } from "./fake-compose-env.mjs";
import {
  active, create, dx, finished, git, gitHold, gitContinue, inProject, inWorkspace, withCreation, write, gatePath, gateClosed,
} from "./setup-harness.mjs";

// ── shared ────────────────────────────────────────────────────────────────────────────────────────────────────

const LP = "com.docker.compose.project";
const label = (k, v) => ["--label", `${k}=${v}`];
const composeLabels = (project, service, folder) => [
  ...label(LP, project), ...label("com.docker.compose.service", service), ...label("com.docker.compose.container-number", "1"),
  ...label("com.docker.compose.project.working_dir", folder), ...label("com.docker.compose.project.config_files", path.join(folder, "compose.yaml")),
];
const ID_ALPINE = "a1".repeat(32);
const ID_DB = "db".repeat(32);
const ID_WEB = "eb".repeat(32); // the image BUILT by compose for a service without `image:` (called `<project>-<service>`)
// The model of the stacks that step 18 re-creates (`api` under the old name, `frontend` — the new name of `web`).
const COMPOSE = { api: { app: { image: "alpine:3" } }, frontend: { app: { image: "alpine:3" } } };
const ALL = [
  { kind: "move", from: "apps", to: "packages" },
  { kind: "move", from: "stacks/api", to: "api" },
  { kind: "move", from: "stacks/web", to: "stacks/frontend" },
  { kind: "leaveOut", path: "services/db" },
  { kind: "code-repo", path: "tools" },
];
const gitInit = (abs) => { fs.mkdirSync(abs, { recursive: true }); execFileSync("git", ["init", "-q", "-b", "main", abs]); };
const commit = (abs, msg) => {
  write(path.join(abs, `${msg}.txt`), `${msg}\n`);
  execFileSync("git", ["-C", abs, "add", "-A"]);
  execFileSync("git", ["-C", abs, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg]);
};
const exists = (abs) => fs.existsSync(abs);
const real = (p) => fs.realpathSync(p);

// The frame of every test: server in operation (withCreation), the fake /proc, the native services as recorders, the knobs. In the
// finally all gates open, and the END of every procedure is awaited (a failure midway would otherwise let it run on).
async function withLayout(fn, { fdOpts = {} } = {}) {
  await withCreation(async (a) => {
    // Two fake /proc: the project container (`proc`) and B (`procB`). EVERY process in B under an affected path holds — a shared
    // /proc would make the processes of the container hold in B.
    const proc = fakeProc(path.join(a.ctx.root, "fake-proc"), { itself: 10 });
    const procB = fakeProc(path.join(a.ctx.root, "fake-proc-b"), { itself: 20 });
    setProcSearchSeam({ root: proc.root });
    setProcessSeam({ root: procB.root });
    const natives = { list: [], stopped: [], started: [] };
    setLayoutServices({
      status: async () => natives.list,
      stop: async (_pid, id) => { natives.stopped.push(Number(id)); },
      start: async (_pid, ids) => { natives.started.push(...ids.map((x) => Number(x && typeof x === "object" ? x.id : x))); return { error: [] }; },
    });
    const projects = new Set();
    try {
      await fn({ ...a, proc, procB, natives, remember: (pid) => projects.add(pid) });
    } finally {
      serverEndMarkerForTest(false);
      a.fd.openGate("stop");
      for (const f of fs.readdirSync(a.gitGates)) if (f.startsWith("waiting-")) gitContinue(a.gitGates, f.slice("waiting-".length));
      for (const pid of projects) await waitForTruthy(() => !layoutProcedureAlive(pid) && !quietCheckRunning(pid), "procedure ended (cleanup)");
      // A job that stayed in `running` WITHOUT a procedure (sabotage 8: the execution is missing) would hold `projectWork` and so the
      // quiet of the harness forever after the failure — the red would turn into a hang. The cleanup removes it.
      for (const pid of projects) if (store.layoutJob(pid)?.state === "running") store.deleteLayoutJob(pid);
      for (const pid of projects) setRebuildMarker(pid, false);
      setLayoutServices();
      forgetProcedures();
      forgetJobs();
      forgetChecks();
      setProcSearchSeam();
      setProcessSeam();
    }
  }, {
    fdOpts: { compose: COMPOSE, ...fdOpts },
    environment: () => ({ CBASE_LAYOUT_CHECK_BACK_MS: "3600000", CBASE_LAYOUT_TERM_MS: "0", CBASE_LAYOUT_B_QUIET_MS: "0" }),
  });
}

// The inventory (see header (A)). `withWorktree`: the linked worktree `apps/core-wt` (a graph worktree over a project with a worktree
// IN the tree would not work — findRepos counts it as a repo; hence only in (A)).
async function inventory({ ctx, fd, natives, remember }, { name = "Layout", withWorktree = false, webImage = "alpine:3" } = {}) {
  const proj = await create(ctx, { name, sources: [] });
  const pid = proj.id;
  remember(pid);
  await finished(pid);
  const w = proj.path;
  const cname = containerOf(store.projectInstance(pid, "main"));
  const d = (...args) => dx(fd, "exec", "-u", "agent", cname, "docker", ...args);
  fs.writeFileSync(path.join(ctx.root, "fake-bin", "env"), FAKE_ENV(path.join(ctx.root, "fake-env.jsonl")), { mode: 0o755 });
  const core = path.join(w, "apps", "core");
  gitInit(core);
  commit(core, "core");
  if (withWorktree) execFileSync("git", ["-C", core, "worktree", "add", "-q", "-b", "wt", path.join(w, "apps", "core-wt")]);
  write(path.join(w, "tools", "run.sh"), "#!/bin/sh\n");
  write(path.join(w, "services", "db", "data", "x.bin"), "x\n");
  for (const o of ["stacks/api", "stacks/web", "services/db", "stays"]) write(path.join(w, o, "compose.yaml"), "services:\n  app:\n    image: alpine:3\n");
  const images = path.join(ctx.root, "images.json");
  fs.writeFileSync(images, JSON.stringify({ fakeDockerImages: [{ ref: "alpine:3", id: ID_ALPINE }, { ref: "db-app:latest", id: ID_DB, labels: { [LP]: "db" } }, { ref: "web-app:latest", id: ID_WEB }] }));
  d("image", "load", "-i", images);
  d("volume", "create", ...label(LP, "db"), "db_data");
  d("network", "create", ...label(LP, "db"), "db_default");
  const name_ = (n) => Object.values(fd.state(cname).container).find((c) => c.name === n);
  d("run", "-d", "--name", "db-app-1", "--network", "db_default", ...composeLabels("db", "app", path.join(w, "services", "db")),
    "--mount", "type=volume,source=db_data,target=/var/lib/db", "db-app:latest");
  d("run", "-d", "--name", "api-app-1", "--restart", "unless-stopped", ...composeLabels("api", "app", path.join(w, "stacks", "api")), "alpine:3");
  d("run", "-d", "--name", "web-fixed", ...composeLabels("web", "app", path.join(w, "stacks", "web")), webImage);
  d("run", "-d", "--name", "stays-app-1", ...composeLabels("stays", "app", path.join(w, "stays")), "alpine:3");
  const id = Object.fromEntries(["db-app-1", "api-app-1", "web-fixed", "stays-app-1"].map((n) => [n, name_(n).id]));
  const apiService = store.addProjectService(pid, { name: "api-service", dir: "stacks/api", startCommand: "true" });
  const dbService = store.addProjectService(pid, { name: "db-service", dir: "services/db", startCommand: "true" });
  natives.list = [{ id: apiService.id, name: "api-service", running: true }, { id: dbService.id, name: "db-service", running: true }];
  store.createProjectContext(pid, { category: "architecture", title: "API", body: "the API", codePaths: ["stacks/api/compose.yaml"] });
  return { proj, pid, w, cname, d, id, name_, apiService, dbService };
}

async function check(ctx, pid, steps) {
  const r = await inProject(ctx, pid, "/layout/check", { method: "POST", body: { steps } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = r.body.check;
  const s = await waitForTruthy(async () => { const x = (await inProject(ctx, pid, `/layout/check/${id}`)).body; return x && x.state !== "running" ? x : null; }, `check ${id} at its end`);
  assert.equal(s.state, "finished", JSON.stringify(s));
  assert.deepEqual(s.result.error, [], JSON.stringify(s.result.error));
  return id;
}
async function takeOver(ctx, pid, steps, check2) {
  const r = await inProject(ctx, pid, "/layout/takeOver", { method: "POST", body: { steps, check: check2 } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
}
// Until no quiet check and no procedure of this project runs any more — then the job is the one they left behind.
const quiet = (pid, what = "procedure ended") => waitForTruthy(() => !quietCheckRunning(pid) && !layoutProcedureAlive(pid), what).then(() => store.layoutJob(pid));
// Until `pred()` holds — if every procedure ends first, it throws (red instead of a hang).
const until = (pid, pred, what) => waitForTruthy(async () => {
  if (await pred()) return true;
  if (layoutProcedureAlive(pid) || quietCheckRunning(pid)) return false;
  if (await pred()) return true;
  const a = store.layoutJob(pid);
  throw new Error(`${what}: no procedure lives any more — ${JSON.stringify(a && { state: a.state, step: a.step, error: a.error, turned: a.turned })}`);
}, what);
const shortJob = (a) => JSON.stringify(a && { state: a.state, step: a.step, turned: a.turned, backward: a.backward, error: a.error, warnings: a.report?.warnings });
const writeAttempt = (ctx, pid, rel = "fresh.txt") => inProject(ctx, pid, "/files/write", { method: "PUT", body: { path: rel, content: "x" } });
const insideCalls = (fd, cname, mark = 0) => fd.calls().slice(mark).filter((x) => x.daemon === cname).map((x) => x.args);

// ── (A) the whole procedure ───────────────────────────────────────────────────────────────────────────────────────────

test("(A) the whole procedure: folders, worktree, stacks (re-created, superseded and renamed, left out including a late arrival), code repo, services, knowledge, uninvolved ones, hint", async () => {
  await withLayout(async (a) => {
    const { ctx, fd, proc, natives, reader } = a;
    const B = await inventory(a, { withWorktree: true });
    const { pid, w, cname, d, id } = B;
    // A background server of an agent in the project container under `stacks/api` (fake /proc), it ignores SIGTERM.
    proc.process({ pid: 4242, cwd: path.join(w, "stacks", "api"), comm: "background" });
    fs.writeFileSync(path.join(proc.root, "4242", "ignored"), "SIGTERM\n");

    // The start instructions of both services (the dropped one's goes with it, the remaining one's stays).
    store.setStartInstructions(pid, "db-service", "first the database");
    store.setStartInstructions(pid, "api-service", "then the API");
    const check2 = await check(ctx, pid, ALL);
    // AFTER the confirmation another container appears in the left-out folder (it goes with it and is in the report).
    d("run", "-d", "--name", "db-straggler", ...composeLabels("db", "late", path.join(w, "services", "db")), "alpine:3");
    const mark = fd.calls().length;
    await takeOver(ctx, pid, ALL, check2);
    const job = await quiet(pid);
    assert.equal(job?.state, "finished", shortJob(job));
    const report = job.report;

    // The tree.
    for (const p of ["packages/core/core.txt", "packages/core-wt/core.txt", "api/compose.yaml", "stacks/frontend/compose.yaml", "tools/.git", "tools/run.sh", "stays/compose.yaml"]) assert.ok(exists(path.join(w, p)), `${p} fehlt`);
    for (const p of ["apps", "stacks/api", "stacks/web", "services/db", PARK]) assert.ok(!exists(path.join(w, p)), `${p} still exists`);
    // The code repo: exactly one empty commit, the file untracked.
    assert.equal(git(path.join(w, "tools"), "rev-list", "--count", "HEAD"), "1");
    assert.equal(git(path.join(w, "tools"), "ls-tree", "--name-only", "HEAD"), "", "an EMPTY commit");
    // The worktree: repaired from the main repo — git reads it at the new place, and the main repo lists it there.
    assert.equal(real(path.resolve(path.join(w, "packages", "core-wt"), git(path.join(w, "packages", "core-wt"), "rev-parse", "--git-common-dir"))), real(path.join(w, "packages", "core", ".git")), "git liest pakete/core-wt");
    const list = git(path.join(w, "packages", "core"), "worktree", "list", "--porcelain").split("\n").filter((z) => z.startsWith("worktree ")).map((z) => real(z.slice(9)));
    assert.ok(list.includes(real(path.join(w, "packages", "core-wt"))), list.join(", "));
    assert.deepEqual(report.warnings, [], "no warning");

    // Docker in the project container.
    const z = fd.state(cname);
    const c = Object.values(z.container);
    const after = (n) => c.find((x) => x.name === n);
    assert.equal(after("db-app-1"), undefined);
    assert.equal(after("db-straggler"), undefined);
    assert.equal(z.volumes.db_data, undefined, "the volume of the left-out stack is gone");
    assert.ok(!Object.values(z.networks).some((n) => n.name === "db_default"), "the network is gone");
    assert.ok(!Object.values(z.images).some((b) => b.id === ID_DB), "the image of the stack is gone");
    assert.ok(Object.values(z.images).some((b) => b.id === ID_ALPINE), "a foreign image stays");
    const api = after("api-app-1");
    assert.notEqual(api.id, id["api-app-1"], "neu created (--force-recreate)");
    assert.equal(path.resolve(api.labels["com.docker.compose.project.working_dir"]), path.join(w, "api"));
    assert.equal(api.status, "running", "it ran before, it runs");
    const old = c.find((x) => x.id === id["web-fixed"]);
    assert.equal(old.name, `web-fixed-old-${id["web-fixed"].slice(0, 12)}`, "web-fixed renamed");
    assert.equal(old.status, "exited", "the old one stays stopped");
    assert.equal(after("frontend-app-1")?.status, "running", "the new stack runs");
    assert.equal(after("stays-app-1").id, id["stays-app-1"]);
    assert.equal(after("stays-app-1").status, "running", "an uninvolved container keeps running untouched");
    assert.deepEqual(store.supersededOf(pid, "main").map((r) => [r.containerId, r.namePrior, r.nameNow, r.stackPrior, r.stackNow]),
      [[id["web-fixed"], "web-fixed", old.name, "web", "frontend"]]);
    // Removed and renamed by id, never by name.
    const inside = insideCalls(fd, cname, mark);
    const rms = inside.filter((x) => (x[0] === "rm" || x[0] === "rmi" || (x[0] === "network" && x[1] === "rm")));
    assert.ok(rms.length >= 4, JSON.stringify(rms));
    for (const x of rms) assert.match(x.at(-1), /^(sha256:)?[0-9a-f]{64}$/, `by id: ${x.join(" ")}`);
    assert.deepEqual(inside.filter((x) => x[0] === "rename"), [["rename", id["web-fixed"], old.name]]);

    // The report.
    assert.deepEqual(report.add.map((h) => [h.kind, h.name]), [["container", "db-straggler"]], "what arrived after the confirmation");
    assert.deepEqual(report.removed.container.map((x) => x.name).sort(), ["db-app-1", "db-straggler"]);
    assert.deepEqual(report.superseded.map((x) => [x.name, x.afterwards, x.fresh]), [["web-fixed", old.name, "frontend"]]);
    assert.deepEqual(report.compose.map((x) => [x.project, x.name, x.outcome]).sort(), [["api", "api", "created"], ["web", "frontend", "created"]]);
    assert.deepEqual(report.codeRepos, ["tools"]);
    assert.deepEqual(report.services, { rewritten: [{ name: "api-service", old: "stacks/api", fresh: "api" }], dropped: [{ name: "db-service" }] });
    assert.deepEqual(report.foreign, [{ name: "background" }]);
    assert.deepEqual(fs.readFileSync(path.join(proc.root, "signals.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
      [{ pid: 4242, signal: "SIGTERM" }, { pid: 4242, signal: "SIGKILL" }], "SIGTERM, then SIGKILL — only in the fake /proc");

    // Database: services and knowledge, the native services.
    assert.equal(store.getProjectService(B.apiService.id).dir, "api");
    assert.equal(store.getProjectService(B.dbService.id), null, "the service under the left-out folder is dropped");
    assert.equal(store.getStartInstructions(pid, "db-service"), "", "… including its start instruction (otherwise a later service of the same name would inherit it)");
    assert.equal(store.getStartInstructions(pid, "api-service"), "then the API", "CT: the one of the remaining service stays");
    assert.deepEqual(store.listProjectContext(pid, { withBody: false }).filter((x) => x.title === "API").map((x) => x.codePaths), [["api/compose.yaml"]]);
    assert.deepEqual(natives.stopped.sort((x, y) => x - y), [B.apiService.id, B.dbService.id].sort((x, y) => x - y), "all running native services stopped");
    assert.deepEqual(natives.started, [B.apiService.id], "the dropped one not restarted");

    // git: every `worktree` with hardening, the reading one without locks.
    const wt = fd.calls().slice(mark).filter((x) => x.args[0] === "exec" && x.args.includes("worktree") && (x.args.includes("repair") || x.args.includes("--porcelain"))).map((x) => x.args);
    assert.ok(wt.some((x) => x.includes("list")) && wt.some((x) => x.includes("repair")), JSON.stringify(wt.map((x) => x.slice(-4))));
    for (const x of wt) for (const h of GIT_HARDENING) assert.ok(x.includes(h), `without ${h}: ${x.slice(-6).join(" ")}`);
    for (const x of wt.filter((y) => y.includes("list"))) assert.ok(x.includes("--no-optional-locks"), "reading without locks");

    // Hint, event, marker, lock, columns.
    const hint = store.openHints(ctx.chat.id).map((h) => h.text).join("\n");
    for (const t of ["apps → packages", "stacks/api → api", "Gelöscht: services/db", "Neues Code-Repo: tools"]) assert.ok(hint.includes(t), `${t} is missing in the hint: ${hint}`);
    await waitForTruthy(() => reader.events.find((e) => e.type === "project/layout" && e.projectId === pid && e.kind === "finished"), "Ereignis fertig");
    assert.equal(rebuildMarkerStands(pid), false);
    assert.equal(lockStands(pid), false);
    assert.equal(layoutStatus(pid), null);
    // `turned` stays as a trace (the run went past the turnaround); a new job creates the row anew (createLayoutJob).
    assert.deepEqual([job.journal, job.prior, job.turned, job.backward], [null, null, true, false]);
  });
});

// ── (S1) + (N1) write lock, projectWork, restart before the turnaround ────────────────────────────────────────────────

test("(S1)(N1) at the gate before `stop`: write lock and projectWork; restart before the turnaround ⇒ post-start hook, way back at `ready`, the job waits again — a nudge runs it through", async () => {
  await withLayout(async (a) => {
    const { ctx, fd, natives } = a;
    fd.openGate("stop"); // the creation stops nothing at the gate
    const B = await inventory(a, { name: "Neustart davor" });
    const { pid, w, cname } = B;
    const steps = [{ kind: "move", from: "stacks/api", to: "api" }];
    const check2 = await check(ctx, pid, steps);
    const slug = path.basename(w);
    assert.equal((await writeAttempt(ctx, pid, "prior.txt")).status, 200, "CT: before the job files/write works");
    gateClosed(fd, "stop");
    await takeOver(ctx, pid, steps, check2);
    await until(pid, () => exists(`${gatePath(fd, "stop")}.waiting`), "step 3 at the gate before `stop`");

    // (S1) While the procedure runs.
    assert.equal(layoutStatus(pid), "running");
    assert.equal(rebuildMarkerStands(pid), true, "the rebuild marker stands from step 2 on");
    const r1 = await writeAttempt(ctx, pid);
    assert.deepEqual([r1.status, r1.body?.code], [409, "LAYOUT_RUNNING"], JSON.stringify(r1.body));
    const r2 = await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: `${slug}/fresh.txt`, content: "x" } });
    assert.deepEqual([r2.status, r2.body?.code], [409, "LAYOUT_RUNNING"], `Workspace-Ebene: ${JSON.stringify(r2.body)}`);
    const r3 = await inProject(ctx, pid, `/services/${B.apiService.id}/start`, { method: "POST", body: { mode: "simple" } });
    assert.deepEqual([r3.status, r3.body?.code], [409, "LAYOUT_RUNNING"], JSON.stringify(r3.body));
    const run = await active(ctx.base);
    assert.ok(run.projectWork.some((x) => x.projectId === pid && x.state === "layout" && x.phase === "stop"), JSON.stringify(run.projectWork));
    assert.equal(run.layoutsOpen, 1);
    assert.equal(run.busy, true);

    // The server ends in the middle of the procedure: after `stop` no further step and no way back.
    serverEndMarkerForTest(true);
    fd.openGate("stop");
    const beforeRestart = await quiet(pid, "the procedure ends with the server");
    serverEndMarkerForTest(false);
    assert.deepEqual([beforeRestart.state, beforeRestart.turned, beforeRestart.journal?.step, beforeRestart.journal?.done], ["running", false, "postWork", "stop"], shortJob(beforeRestart));
    assert.equal(B.name_("api-app-1").status, "exited");
    assert.equal(B.name_("api-app-1").restart, "", "step 3 set restart no (the fake docker holds `no` as empty)");

    const oldBoot = BOOT_ID;
    await ctx.restart({ withBackground: true });
    assert.notEqual(BOOT_ID, oldBoot);
    // A new process has neither lock nor marker in memory (in-process they survived — forgotten here, as after a real end).
    forgetJobs();
    setRebuildMarker(pid, false);
    assert.equal(lockStands(pid), false, "CT: without the post-start hook no lock");
    layoutRestartGrace();
    assert.equal(store.layoutJob(pid).backward, true, "running before the turnaround => backward");
    assert.equal(lockStands(pid), true);
    assert.equal(rebuildMarkerStands(pid), true);
    const run2 = await active(ctx.base);
    assert.ok(!run2.projectWork.some((x) => x.projectId === pid && x.state === "layout"), "the row of an earlier process does not hold");
    assert.equal(run2.layoutsOpen, 1, "… but counts for the rollback lock");
    assert.equal(store.projectInstance(pid, "main").state, "start");

    await restoreInstance(pid, "main", { reason: "Test: Nachstart" });
    await new Promise((r) => setImmediate(r)); // the tick in which atReady calls its consumers
    assert.ok(layoutProcedureAlive(pid) || store.layoutJob(pid).state !== "running", "the consumer at atReady did not start");
    const afterReturnPath = await quiet(pid, "way back after the post-start");
    assert.equal(afterReturnPath.state, "waiting", shortJob(afterReturnPath));
    assert.deepEqual([afterReturnPath.journal, afterReturnPath.prior, afterReturnPath.turned, afterReturnPath.backward], [null, null, false, false]);
    const api = B.name_("api-app-1");
    assert.deepEqual([api.status, api.restart], ["running", "unless-stopped"], "the old restart rule and the run are back");
    assert.ok(natives.started.includes(B.apiService.id), "the native service runs again");
    assert.ok(exists(path.join(w, "stacks", "api", "compose.yaml")) && !exists(path.join(w, "api")), "nothing changed in the tree");
    assert.equal(rebuildMarkerStands(pid), false);
    assert.equal(layoutStatus(pid), "waiting");

    // A nudge (event, explicit here): quiet => the whole procedure.
    checkBackLayout(pid);
    const end = await quiet(pid);
    assert.equal(end.state, "finished", shortJob(end));
    assert.ok(exists(path.join(w, "api", "compose.yaml")) && !exists(path.join(w, "stacks", "api")));
    assert.equal(path.resolve(B.name_("api-app-1").labels["com.docker.compose.project.working_dir"]), path.join(w, "api"));
    assert.equal((await writeAttempt(ctx, pid, "afterwards.txt")).status, 200, "CT: after the end files/write works");
    assert.ok(insideCalls(fd, cname).length > 0);
  }, { fdOpts: { stopGate: "stop" } });
});

// ── (N2) restart after the turnaround, the worktree cut ────────────────────────────────────────────────────────────────

test("(N2) restart after the turnaround (at the git gate of `init`): the lock holds without a procedure, `ready` continues forward; then a graph worktree skips the empty code repo", async () => {
  await withLayout(async (a) => {
    const { ctx, fd, gitGates } = a;
    const B = await inventory(a, { name: "Neustart danach" });
    const { pid, w, cname } = B;
    const steps = [{ kind: "move", from: "stacks/api", to: "api" }, { kind: "code-repo", path: "tools" }];
    const check2 = await check(ctx, pid, steps);
    gitHold(gitGates, "init");
    await takeOver(ctx, pid, steps, check2);
    await until(pid, () => exists(path.join(gitGates, "waiting-init")), "step 13 at the git gate of init");
    serverEndMarkerForTest(true);
    gitContinue(gitGates, "init");
    const before = await quiet(pid, "the procedure ends with the server");
    serverEndMarkerForTest(false);
    assert.deepEqual([before.state, before.turned, before.journal?.step], ["running", true, "project-repo"], shortJob(before));
    assert.ok(exists(path.join(w, "api", "compose.yaml")), "placed before the end");
    const mark = fd.calls().length;

    await ctx.restart({ withBackground: true });
    forgetJobs();
    setRebuildMarker(pid, false);
    layoutRestartGrace();
    assert.equal(store.layoutJob(pid).backward, false, "after the turnaround no way back");
    const r = await writeAttempt(ctx, pid);
    assert.deepEqual([r.status, r.body?.code], [409, "LAYOUT_RUNNING"], "the lock holds, also without a living procedure");
    await restoreInstance(pid, "main", { reason: "Test: Nachstart" });
    await new Promise((x) => setImmediate(x));
    const end = await quiet(pid, "forward after the post-start");
    assert.equal(end.state, "finished", shortJob(end));
    assert.ok(!insideCalls(fd, cname, mark).some((x) => x[0] === "update" && x.includes("unless-stopped")), "no way-back step (rw-rules) ran");
    const api = B.name_("api-app-1");
    assert.deepEqual([api.status, path.resolve(api.labels["com.docker.compose.project.working_dir"])], ["running", path.join(w, "api")]);

    // The worktree cut: `tools` has an empty HEAD tree, `apps/core` a file.
    const info = await createGraphWorktree({ startId: "a19b19c19d19e19f", project: { id: pid, name: B.proj.name, path: w }, root: worktreeRoot(locationFor({ projectId: pid, converted: true })) });
    try {
      assert.deepEqual((info.skipped || []).map((x) => x.relPath), ["tools"], JSON.stringify(info));
      assert.deepEqual(info.repos.map((x) => x.relPath), ["apps/core"]);
      assert.ok(exists(path.join(info.dir, "apps", "core", "core.txt")), "the repo with a file got its checkout");
      assert.ok(!exists(path.join(info.dir, "tools")), "the empty one got none");
      const set = worktreePrompt(info, { project: { path: w } });
      assert.match(set, /Without a checkout of their own because no file is checked in yet: tools \(/);
      assert.doesNotMatch(worktreePrompt({ ...info, skipped: undefined }, { project: { path: w } }), /Without a checkout of their own/, "CT: without skipped ones no sentence (golden)");
    } finally {
      const way = await removeGraphWorktree(info, { force: true });
      assert.deepEqual(way.error || [], []);
    }
  });
});

// ── (G) cross-check ───────────────────────────────────────────────────────────────────────────────────────────────

test("(G) the tree changes between check and turnaround ⇒ LAYOUT_CHANGED, way back (restart rule, container, native services), `error` before the turnaround, lock gone, withdrawing works", async () => {
  await withLayout(async (a) => {
    const { ctx, fd, gitGates, natives } = a;
    const B = await inventory(a, { name: "Gegenpruefen" });
    const { pid, w, cname } = B;
    const steps = [{ kind: "move", from: "stacks/api", to: "api" }];
    const check2 = await check(ctx, pid, steps);
    gitHold(gitGates, "worktree");
    const mark = fd.calls().length;
    await takeOver(ctx, pid, steps, check2);
    await until(pid, () => exists(path.join(gitGates, "waiting-worktree")), "step 1 at the git gate of worktree");
    write(path.join(w, "api", "other.txt"), "created in between\n"); // the target exists now
    gitContinue(gitGates, "worktree");
    const job = await quiet(pid);
    assert.deepEqual([job.state, job.turned, job.backward, job.journal], ["error", false, false, null], shortJob(job));
    assert.match(job.error, /geändert.*\bapi\b.*neu prüfen/, job.error);
    // The way back: `update --restart no` + `stop`, then the old rule back; the container and the native services run.
    const inside = insideCalls(fd, cname, mark);
    assert.ok(inside.some((x) => x[0] === "update" && x.includes("no") && x.includes(B.id["api-app-1"])), "Schritt 3 lief");
    assert.ok(inside.some((x) => x[0] === "update" && x.includes("unless-stopped") && x.includes(B.id["api-app-1"])), "rw-rules lief");
    const api = B.name_("api-app-1");
    assert.deepEqual([api.id, api.status, api.restart], [B.id["api-app-1"], "running", "unless-stopped"]);
    assert.deepEqual(natives.started.sort((x, y) => x - y), [B.apiService.id, B.dbService.id].sort((x, y) => x - y));
    assert.ok(exists(path.join(w, "stacks", "api", "compose.yaml")), "nothing moved in the tree");
    assert.equal(lockStands(pid), false, "the lock falls");
    assert.equal(rebuildMarkerStands(pid), false);
    assert.equal(layoutStatus(pid), null, "`error` before the turnaround does not lock");
    assert.equal((await writeAttempt(ctx, pid)).status, 200);
    const back = await inProject(ctx, pid, "/layout/job", { method: "DELETE" });
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });
});

// ── (F) error after the turnaround, root fallback, try again ────────────────────────────────────────────────────────────────

test("(F) leaving out refused ⇒ root fallback through docker exec -u root ⇒ `error` after the turnaround: the lock stays; “try again” continues at the step", async () => {
  await withLayout(async (a) => {
    const { ctx, fd } = a;
    const B = await inventory(a, { name: "After the turnaround" });
    const { pid, w, cname } = B;
    const shielded = path.join(w, "services", "db", "data");
    const steps = [{ kind: "leaveOut", path: "services/db" }];
    const check2 = await check(ctx, pid, steps);
    fs.chmodSync(shielded, 0o555);
    try {
      const mark = fd.calls().length;
      await takeOver(ctx, pid, steps, check2);
      const a1 = await quiet(pid);
      assert.deepEqual([a1.state, a1.turned, a1.step], ["error", true, "leaveOut"], shortJob(a1));
      assert.match(a1.error, /auch als root nicht entfernen/);
      const root = fd.calls().slice(mark).filter((x) => x.args[0] === "exec" && x.args[x.args.indexOf("-u") + 1] === "root" && x.args.includes("gone"));
      assert.equal(root.length, 1, "the root fallback ran exactly once through docker exec -u root");
      // After the turnaround: the lock stays.
      assert.equal(lockStands(pid), true);
      assert.equal(rebuildMarkerStands(pid), true);
      assert.equal(layoutStatus(pid), "error");
      const r = await writeAttempt(ctx, pid);
      assert.deepEqual([r.status, r.body?.code], [409, "LAYOUT_RUNNING"], JSON.stringify(r.body));
      assert.equal((await inProject(ctx, pid, "/layout/job", { method: "DELETE" })).status, 409, "withdrawing does not work after the turnaround");
      const run = await active(ctx.base);
      assert.equal(run.layoutsOpen, 1);
      assert.ok(!run.projectWork.some((x) => x.projectId === pid && x.state === "layout"));
      assert.equal(B.name_("db-app-1"), undefined, "docker fell before leaving out (step 9)");

      fs.chmodSync(shielded, 0o755);
      const ab2 = fd.calls().length;
      const e = await inProject(ctx, pid, "/layout/job/again", { method: "POST" });
      assert.equal(e.status, 202, JSON.stringify(e.body));
      const a2 = await quiet(pid);
      assert.equal(a2.state, "finished", shortJob(a2));
      assert.ok(!exists(path.join(w, "services", "db")));
      const afterwards = insideCalls(fd, cname, ab2);
      assert.ok(!afterwards.some((x) => x[0] === "stop" || (x[0] === "update" && x.includes("no"))), `no step before leaving out ran again: ${JSON.stringify(afterwards.filter((x) => x[0] === "stop" || x[0] === "update"))}`);
      assert.equal(lockStands(pid), false);
      assert.equal((await writeAttempt(ctx, pid)).status, 200);
    } finally {
      try { fs.chmodSync(shielded, 0o755); } catch { /* already gone */ }
    }
  });
});

// ── further cases ────────────────────────────────────────────────────────────

const holdersOf = async (ctx, pid) => ((await inProject(ctx, pid, "/layout/job")).body.job?.holders || []).map((h) => [h.kind, h.id, h.stoppable]);
const signals = (proc) => (exists(path.join(proc.root, "signals.jsonl")) ? fs.readFileSync(path.join(proc.root, "signals.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("(Pr) /proc: a process in B without a run sends step 5 back to `waiting`; a left-out link hits nothing under its target; the VS Code server in the project container is ended", async () => {
  await withLayout(async (a) => {
    const { ctx, proc, procB, gitGates } = a;
    const B = await inventory(a, { name: "Prozesse" });
    const { pid, w } = B;
    const outside = path.join(ctx.root, "outside");
    write(path.join(outside, "stays.txt"), "x\n");
    fs.symlinkSync(outside, path.join(w, "tool-link"));
    // In the project container: one works in the TARGET of the link (nothing may hit it), the VS Code server (ignores SIGTERM).
    proc.process({ pid: 5151, cwd: outside, comm: "in-target" });
    proc.process({ pid: 7171, cwd: "/", exe: "/home/agent/.vscode-server/bin/abc123/node", comm: "code-server" });
    fs.writeFileSync(path.join(proc.root, "7171", "ignored"), "SIGTERM\n");
    // In B: one in the target of the link — it does not hold.
    procB.process({ pid: 6161, cwd: outside, comm: "b-in-target" });
    const steps = [{ kind: "move", from: "stacks/api", to: "api" }, { kind: "leaveOut", path: "tool-link" }];
    const check2 = await check(ctx, pid, steps);
    gitHold(gitGates, "worktree");
    await takeOver(ctx, pid, steps, check2);
    await until(pid, () => exists(path.join(gitGates, "waiting-worktree")), "step 1 at the git gate of worktree");
    // Between quiet and step 5 a process without a run (a subagent, the bash of the loop engine) starts in B in `stacks/api`.
    procB.process({ pid: 8181, cwd: path.join(w, "stacks", "api"), comm: "npm" });
    gitContinue(gitGates, "worktree");
    let job = await quiet(pid);
    assert.equal(job.state, "waiting", `back to waiting (step 5 must see more than the main CLI of a running turn): ${shortJob(job)}`);
    assert.ok(exists(path.join(w, "stacks", "api", "compose.yaml")) && !exists(path.join(w, "api")), "nothing changed in the tree");
    assert.equal(B.name_("api-app-1").status, "running", "the way back ran");
    assert.deepEqual(signals(proc), [], "no signal before step 5 (b)");
    checkBackLayout(pid);
    await quiet(pid, "the quiet after the way back");
    assert.deepEqual(await holdersOf(ctx, pid), [["process", "b:8181", false]], "it holds as a process without a run — the link process 6161 does not");
    // It ends => a nudge runs the job through.
    procB.gone(8181);
    checkBackLayout(pid);
    job = await quiet(pid);
    assert.equal(job.state, "finished", shortJob(job));
    // The link is gone, its target and the process in it untouched; only the editor server got signals.
    assert.ok(exists(path.join(w, "api", "compose.yaml")), "moved");
    assert.throws(() => fs.lstatSync(path.join(w, "tool-link")), /ENOENT/, "the link fell");
    assert.ok(exists(path.join(outside, "stays.txt")), "its target stays");
    assert.deepEqual(signals(proc), [{ pid: 7171, signal: "SIGTERM" }, { pid: 7171, signal: "SIGKILL" }], "only the editor server — never the process in the target of the link");
    assert.ok(exists(path.join(proc.root, "5151")), "the process in the target lives");
    assert.ok(job.report.warnings.some((t) => /Editor-Sitzung/.test(t)), JSON.stringify(job.report.warnings));
  });
});

test("(D) Docker: a renamed stack with a built image is created under the new name, one that stays stopped gives its old containers back; `supersede` is repeatable; a volume of two left-out folders is in the confirmation under “falls”", async () => {
  await withLayout(async (a) => {
    const { ctx, fd } = a;
    const B = await inventory(a, { name: "Docker", webImage: "web-app" });
    const { pid, w, cname, d, id, name_ } = B;
    // A second renamed stack whose image is missing under the new name (`stacks/ui` → `stacks/surface`, model: `missing:1`).
    write(path.join(w, "stacks", "ui", "compose.yaml"), "services:\n  app:\n    image: alpine:3\n");
    d("run", "-d", "--name", "ui-app-1", ...composeLabels("ui", "app", path.join(w, "stacks", "ui")), "alpine:3");
    // Two left-out folders with ONE volume.
    for (const o of ["alt1", "alt2"]) write(path.join(w, o, "compose.yaml"), "services:\n  app:\n    image: alpine:3\n");
    d("volume", "create", "shared");
    for (const o of ["alt1", "alt2"]) d("run", "-d", "--name", `${o}-app-1`, ...composeLabels(o, "app", path.join(w, o)), "--mount", "type=volume,source=shared,target=/d", "alpine:3");
    const ui = name_("ui-app-1").id;
    const steps = [
      { kind: "move", from: "stacks/web", to: "stacks/frontend" }, { kind: "move", from: "stacks/ui", to: "stacks/surface" },
      { kind: "leaveOut", path: "alt1" }, { kind: "leaveOut", path: "alt2" },
    ];
    const check2 = await check(ctx, pid, steps);
    const e = (await inProject(ctx, pid, `/layout/check/${check2}`)).body.result;
    for (const x of e.leaveOut) {
      assert.deepEqual(x.docker.volumes.map((v) => v.name), ["shared"], `${x.path}: the shared volume goes with it`);
      assert.ok(!x.docker.stays.some((y) => y.name === "shared"), `${x.path}: … and is not under “stays”`);
    }
    assert.ok(e.confirmable.volumes.some((v) => v.name === "shared"), "it is confirmed too");
    // CT: computed per path, the container of the other path held it “outside” — step 9 deleted it anyway.
    const inv = await dockerInventory(cname);
    assert.ok(deleteSet(inv, [name_("alt1-app-1").id]).stays.some((y) => y.name === "shared"), "CT: per path it stood under “stays”");
    assert.ok(!Object.keys(fd.state(cname).images).some((r) => r.startsWith("frontend-app")), "CT: the image under the new name does not exist before (`up --no-build --pull never` failed)");

    await takeOver(ctx, pid, steps, check2);
    const job = await quiet(pid);
    assert.equal(job.state, "finished", shortJob(job));
    const report = job.report;
    // The volume is gone and was not under “add” (it was confirmed).
    assert.equal(fd.state(cname).volumes.shared, undefined);
    assert.deepEqual(report.add, [], JSON.stringify(report.add));
    // The built stack under the new name from the old image, started; the other one stays stopped and gives its containers back.
    assert.deepEqual(report.compose.map((x) => [x.project, x.name, x.outcome]).sort(), [["ui", "surface", "stopped"], ["web", "frontend", "created"]], JSON.stringify(report.warnings));
    assert.deepEqual([name_("frontend-app-1")?.status, name_("frontend-app-1")?.imageId], ["running", ID_WEB], "from the image of the old container");
    assert.deepEqual(store.supersededOf(pid, "main").map((r) => r.containerId), [id["web-fixed"]], `only those of the created stack (ui: ${ui})`);
    assert.deepEqual(report.superseded.map((x) => x.stack), ["web"]);
    assert.ok(report.warnings.some((t) => /„ui“ bleibt unter dem alten Namen/.test(t)), JSON.stringify(report.warnings));
    assert.equal(name_("ui-app-1")?.status, "exited", "the old ui container stays stopped");
    // Step 9 a second time (crash in the middle of the loop, “try again”) — no throw, no second rename.
    const old = Object.values(fd.state(cname).container).find((c) => c.id === id["web-fixed"]);
    assert.equal(old.name, `web-fixed-old-${id["web-fixed"].slice(0, 12)}`);
    assert.throws(() => d("rename", id["web-fixed"], old.name), /same name/, "CT: the rename to its own name is an error for the daemon");
    const mark = fd.calls().length;
    const rows = await supersede(pid, "main", cname, [{ project: "web", p48: { newName: "frontend" }, container: [{ id: id["web-fixed"], name: "web-fixed", service: "app", fixed: true }] }]);
    assert.deepEqual(rows.map((z) => z.afterwards), [old.name]);
    assert.ok(!insideCalls(fd, cname, mark).some((x) => x[0] === "rename"), "no second rename");
  }, { fdOpts: { compose: { ...COMPOSE, frontend: { app: { image: "frontend-app" } }, ui: { app: { image: "fehlt:1" } } } } });
});

test("(Wt) graph worktree: a left-out repo falls from the row, the others stay with their path; the linked dependencies point to the new place", async () => {
  await withLayout(async (a) => {
    const { ctx } = a;
    const B = await inventory(a, { name: "Graph" });
    const { pid, w } = B;
    const core = path.join(w, "apps", "core");
    write(path.join(core, ".gitignore"), "node_modules/\n");
    commit(core, "ignored");
    write(path.join(core, "node_modules", "pack", "index.js"), "module.exports = 1;\n");
    gitInit(path.join(w, "old-repo"));
    commit(path.join(w, "old-repo"), "old");
    const START = "b13b14c0ffee0001";
    const info = await createGraphWorktree({ startId: START, project: { id: pid, name: B.proj.name, path: w }, root: worktreeRoot(locationFor({ projectId: pid, converted: true })) });
    let newInfo = info;
    try {
      assert.deepEqual(info.repos.map((r) => r.relPath).sort(), ["apps/core", "old-repo"], JSON.stringify(info.repos));
      const link = info.own.find((e) => e.kind === "link");
      assert.ok(link, JSON.stringify(info.own));
      assert.equal(fs.readlinkSync(link.path), link.source, "CT: the link points ABSOLUTELY to the old place in the main folder");
      const oldTarget = info.repos.find((r) => r.relPath === "old-repo").target;
      store.createGraphStart({ id: START, chatId: ctx.chat.id, workflowId: "wf-b13", workflowName: "Graph", shortName: "graph", status: "started", worktree: true });
      store.changeGraphStart(START, { worktreePath: info.dir, worktreeInfo: JSON.stringify(info) });
      const steps = [{ kind: "move", from: "apps/core", to: "core" }, { kind: "leaveOut", path: "old-repo" }];
      const check2 = await check(ctx, pid, steps);
      await takeOver(ctx, pid, steps, check2);
      const job = await quiet(pid);
      assert.equal(job.state, "finished", shortJob(job));
      const z = store.graphStart(START);
      assert.equal(z.worktreePath, info.dir, "the row stays (it used to be empty — the run then worked in the main folder)");
      newInfo = JSON.parse(z.worktreeInfo);
      assert.deepEqual(newInfo.repos.map((r) => [r.relPath, real(r.root)]), [["core", real(path.join(w, "core"))]], "only the left-out repo fell");
      assert.ok(!newInfo.own.some((x) => x.path.startsWith(`${oldTarget}${path.sep}`)), "its own entries too");
      const l = newInfo.own.find((x) => x.kind === "link");
      assert.equal(l.path, link.path);
      assert.equal(real(l.source), real(path.join(w, "core", "node_modules")));
      assert.equal(fs.readlinkSync(l.path), l.source, "the link points to the new place");
      assert.ok(exists(path.join(l.path, "pack", "index.js")), "… and resolves");
      assert.ok(!exists(oldTarget), "the worktree of the left-out repo is gone (step 11)");
      assert.ok(!job.report.warnings.some((t) => /Graph-Worktree/.test(t)), JSON.stringify(job.report.warnings));
    } finally {
      await removeGraphWorktree({ ...newInfo, repos: newInfo.repos.filter((r) => exists(r.target)) }, { force: true });
    }
  });
});

test("(Wd) repeatable: an occupied parking place holds BEFORE the turnaround; “..old” goes into the root fallback; a code repo of an earlier run is in report and hint", async () => {
  await withLayout(async (a) => {
    const { ctx, fd, gitGates } = a;
    const B = await inventory(a, { name: "Repeat" });
    const { pid, w } = B;
    // The parking place is occupied — the check does not see it (hidden); it must fail BEFORE the turnaround, not only `parking` after it.
    fs.mkdirSync(path.join(w, PARK, "0"), { recursive: true });
    const s1 = [{ kind: "move", from: "stacks/api", to: "api" }];
    await takeOver(ctx, pid, s1, await check(ctx, pid, s1));
    let job = await quiet(pid);
    assert.deepEqual([job.state, job.turned], ["error", false], shortJob(job));
    assert.match(job.error, /\.cbase-layout/);
    assert.ok(exists(path.join(w, "stacks", "api", "compose.yaml")) && !exists(path.join(w, "api")), "nothing changed in the tree");
    assert.deepEqual([B.name_("api-app-1").status, B.name_("api-app-1").restart], ["running", "unless-stopped"], "the way back ran");
    assert.equal(lockStands(pid), false);
    assert.equal((await inProject(ctx, pid, "/layout/job", { method: "DELETE" })).status, 200);
    fs.rmSync(path.join(w, PARK), { recursive: true });

    // “..old” (root-owned content) is dropped, two new code repos.
    const shielded = path.join(w, "..old", "data");
    write(path.join(shielded, "x.bin"), "x\n");
    for (const o of ["new-a", "new-b"]) write(path.join(w, o, "run.sh"), "#!/bin/sh\n");
    const s2 = [{ kind: "leaveOut", path: "..old" }, { kind: "code-repo", path: "new-a" }, { kind: "code-repo", path: "new-b" }];
    const p2 = await check(ctx, pid, s2);
    fs.chmodSync(shielded, 0o555);
    try {
      const mark = fd.calls().length;
      await takeOver(ctx, pid, s2, p2);
      job = await quiet(pid);
      assert.deepEqual([job.state, job.turned, job.step], ["error", true, "leaveOut"], shortJob(job));
      assert.match(job.error, /auch als root nicht entfernen/, "the root fallback ran");
      assert.doesNotMatch(job.error, /nicht im Projektordner/, "“..old” must not count as outside (the throw came at every “try again”)");
      const root = fd.calls().slice(mark).filter((x) => x.args[0] === "exec" && x.args[x.args.indexOf("-u") + 1] === "root" && x.args.includes("gone"));
      assert.equal(root.length, 1, "through docker exec -u root");
      fs.chmodSync(shielded, 0o755);

      // Step 13 creates `new-a` and fails at the commit of `new-b` (the git gate holds both commits, the second aborts).
      gitHold(gitGates, "commit");
      assert.equal((await inProject(ctx, pid, "/layout/job/again", { method: "POST" })).status, 202);
      await until(pid, () => exists(path.join(gitGates, "waiting-commit")), "the commit of new-a at the gate");
      gitHold(gitGates, "commit");
      gitContinue(gitGates, "commit");
      await until(pid, () => fs.readdirSync(gitGates).filter((f) => f.startsWith("held-commit.")).length === 2 && exists(path.join(gitGates, "waiting-commit")), "the commit of new-b at the gate");
      fs.writeFileSync(path.join(gitGates, "abort-commit"), "");
      gitContinue(gitGates, "commit");
      job = await quiet(pid);
      assert.deepEqual([job.state, job.turned, job.step], ["error", true, "code-repos"], shortJob(job));
      assert.deepEqual(job.report.codeRepos, ["new-a"], "the report is written after EVERY repo (not only at the end of the step)");
      fs.rmSync(path.join(gitGates, "abort-commit"));
      // B died between the commit of new-a and its report: the report does not know it — the repetition finds it at its commit.
      store.layoutSet(pid, { report: { ...job.report, codeRepos: [] } });
      assert.equal(git(path.join(w, "new-a"), "log", "-1", "--format=%s"), CODE_REPO_MESSAGE);
      // ... and created before the commit messages became English: the old message still counts as ours (reading old data).
      git(path.join(w, "new-a"), "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", "commit", "--amend", "--allow-empty", "-q", "-m", CODE_REPO_MESSAGE_BEFORE);
      assert.equal((await inProject(ctx, pid, "/layout/job/again", { method: "POST" })).status, 202);
      job = await quiet(pid);
      assert.equal(job.state, "finished", shortJob(job));
      assert.deepEqual([...job.report.codeRepos].sort(), ["new-a", "new-b"], "both — new-a reported “already a repo” and used to go missing silently");
      assert.equal(git(path.join(w, "new-b"), "rev-list", "--count", "HEAD"), "1", "the half init of new-b got its commit");
      const hint = store.openHints(ctx.chat.id).map((h) => h.text).join("\n");
      assert.match(hint, /Neues Code-Repo: new-a, new-b|Neues Code-Repo: new-b, new-a/, hint);
      assert.ok(!exists(path.join(w, "..old")));
    } finally {
      try { fs.chmodSync(shielded, 0o755); } catch { /* already gone */ }
    }
  });
});
