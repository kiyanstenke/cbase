// Freezing and volume clone of a copy (stacks/freeze.js) against the fake docker (fake-docker.mjs: B = "host", the main's inner
// daemon via `exec cbase-p-<id> docker …`, its docker root is the `_data` of the volume `cbase-p-<id>-docker`). `cbase-clone` is a
// played-in program (python3 via `programs`) that logs argv and copies volumes like the real program (phase 1 the named ones,
// phase 2 the rest including `--again`); the code snapshot runs for real — git in the helper through the real shell.
//
// What is proved:
//   (1) Success: order on the wire helper -> phase 1 -> inspect (desired) -> pause -> code -> phase 2 -> unpause -> helper gone; the
//       helper with its mounts (source read-only, target, project folder, runtime folder, open/, /usr/local/bin read-only,
//       ~/.gitconfig read-only) and only `cbase.helper*` labels; phase-1 volumes = those without a running container (a shared one
//       never); started between phase 1 and pause, new, stopped-and-again, gone, `--rm` (only visible through the events) and
//       disappeared => `--again` with a reason; unchanged => not; desired = what runs; policy protection for stopped
//       `always`/`unless-stopped`; journal before every step; the target volume carries the data; copy in build/clone2, main thawed,
//       lock and heavy load free.
//       Volumes WITH a running container already go along in phase 1 as `--upfront` (the fake copies them and reports
//       `upfront_begin_ns`), phase 2 names them `--reconcile … --since <ns>` (the fidelity of the reconcile is held by
//       tools/check/clone-program.test.mjs); journal `phase1.upfront`/`upfrontSince`; the fake reports `upfront_error=2`, the
//       journal carries `phase1.upfrontError` = 2.
//   (2) A forced error before EVERY step (CBASE_COPY_ERROR_AT) => thaw BEFORE every dismantling call, nothing stays (volume, location,
//       helper, instance row), copy `error` with the step in the reason, journal stands on the step. Plus the full disk in phase 2.
//   (3) A leftover of an earlier copy (location or volume) => fails, does NOT touch the leftover.
//   (4) Preconditions without a docker call: without ops (no-ops mark), wrong phase, without occupancy, heavy load taken.
//   (5) a management git of main that runs before the pause holds the `pause` until it ends (counting seam waitingForCommands — no
//       clock); with the cap CBASE_COPY_GIT_MS there is no `pause` and the copy fails.
//   (6) `removeAsRoot` during the pause waits at the barrier and runs after the thaw (argv unchanged).
//   (7) The pure rules: phase1Volumes, againVolumes (including "buffer overflowed"), policyCandidates (a paused inner container with
//       a policy is a candidate), eventsComplete.
//   (8) a management git that is KILLED before the pause counts until its group is gone in the container — the TERM goes out at once
//       (not at the barrier), KILL after the escalation, only then `pause`.
//   (9) an overflowed event buffer (the fake docker with buffer 4) and a restarted main (empty buffer, new StartedAt) => every
//       phase-1 volume in `--again` — never measured by the length of the answer.
//  (10) a mount between desired and effective `pause` (gate at `pause`, after the next full second) => the recheck discards the copy;
//       a mount between `ps` and `inspect` of inspect1 (gate at `inspect`, two seconds before the old start) => `--again`.
//  (11) the thaw fails (unpause played in as broken) => copy `error` "thaw", dismantling complete, main stays frozen until the guard
//       thaws it later.
//  (12) `volume rm` of the copy fails => the instance row stays (in `error`) instead of being orphaned.
//  (13) the helper is emptied after the code snapshot (`stop -t 0` + `start`, before phase 2); a tar that grew after its check
//       discards the copy; the unpacking (prepare.js TAR_UNPACK) takes no `.git` entry.
//  (14) a still empty project folder stays without (`reason: "empty"`, no `.git`); a code repo as project folder (`repo`) and an
//       existing project repo (`marker`, no commit) are not created. The project repo of the situation otherwise is created between
//       helper and pause: first commit "Project repo created before copy k1", then "State before copy k1"; the snapshot names `p` before `r0` ((1)).
//  (15) a teardown in main (worktree of a subagent or graph run) whose exec hit a pause that cbase did not hold ("is paused": wait,
//       do not wake) lies in main's post-work; freezing the copy thaws, and AFTER that the post-work runs in main's container
//       (`worktree remove` after the `unpause`; row, folder and branch are gone). The copies' post-work belongs to copy-worktrees.test.js.
//  (16) if the helper is not removed (`rm -f -v` fails) the location of the copy stays, `error` names it.
//
// COUNTER-TESTS (each shown red, restored afterwards):
//   freeze.js beforePause without waiting for commandsPast                       => (5) red ("pause while the git ran")
//   cleanUp.js `docker(["exec", "-u", "root", …])` again                         => (6) red (fails at "is paused", false)
//   freeze.js without mountEvents (hooked in empty)                              => (1) red (rmv missing in --again)
//   freeze.js phase1Volumes without the filter of the running ones               => (1) red (run/shared in phase 1)
//   freeze.js `thawOut` in the catch instead of the finally (dismantling before the thaw) => (2) red (rm of the helper before unpause)
//   freeze.js without the existence test of the location                         => (3) red (the foreign location is gone)
//   git-run.js, inProject.js, docker.js on the old state                          => (8) red ("the counter already fell")
//   git-run.js alone on the old state (commandEnds at `close`)                    => (8) red (same)
//   inProject.js group kills without `{ kill: true }` (with CBASE_COPY_GIT_MS=4000 from outside) => (8) red: the TERM waits at the
//     barrier for a thaw that waits for quiet — only the cap of the waiting ends it
//   freeze.js on the old state                                                    => (7) (9) (10) (12) (13a) red
//   freeze.js without the comparison of the main's start                          => (9) red (restart)
//   freeze.js without the check of the recheck                                    => (10) red
//   freeze.js pausedMs at the end of beforePause again                            => (10) red (a)
//   freeze.js start AFTER inspect1 again                                          => (10) red (b)
//   freeze.js without `if (tauError) throw` (with CBASE_PAUSE_CAP_MS=2000)        => (11) red
//   freeze.js instance row deleted unconditionally again                          => (12) red
//   freeze.js without emptyHelper                                                 => (1) (13a) red
//   freeze.js without checkOpenAfterClear                                         => (13a) red
//   prepare.js TAR_UNPACK without `--exclude=.git`                                => (13b) red
//   freeze.js without the call of projectRepoBeforeCopy                           => (1) (14) red
//   code-snapshot.js projectRepoBeforeCopy without the empty rule                 => (14) red (the empty folder got a .git)
//   freeze.js without `if (!tauError) postWorkOfTheMain(pid);`                    => (15) red
//   freeze.js clone1 without `...volArgs(upfront, "--upfront")`                   => (1) red ("phase 1 did not name the start")
//   dismantlingClone: `if (!helperGone)` replaced by `if (false)`                 => (16) red ("the location fell although the helper …")
//
// No deadline: waiting is on gate files, counting seams and states (waitForTruthy); (10) additionally waits until the clock has
// passed a full second — a condition nothing turns red on (the old calculation in whole seconds only looked wrong).
// macOS: the temp directory sits behind the link /var -> /private/var, and a helper mounts no bind source through a link — TMPDIR real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { MAIN, containerName, copyInstance, volumeName } from "../electron/server/projectbox/creation.js";
import { removeAsRoot } from "../electron/server/projectbox/cleanUp.js";
import { isFrozen, advanceRethaw, openRethaw, pause, thawOut, waitingForThaw } from "../electron/server/projectbox/docker.js";
import { withProjectOccupancy } from "../electron/server/projectbox/instance.js";
import { runInstance } from "../electron/server/projectbox/run-instance.js";
import { projectLocked } from "../electron/server/projectbox/idle.js";
import { occupyHeavyLoad, heavyLoadStatus } from "../electron/server/projectbox/heavyLoad.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { commandRun, runningCommandsIn, waitingForCommands } from "../electron/server/runtime/git-run.js";
import { openEscalations } from "../electron/server/runtime/inProject.js";
import { postWorkFile, openGitJobs, worktreeTeardown } from "../electron/server/runs/git-post-work.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import {
  EVENT_BUFFER, CLONE_PROGRAM, freeze, againVolumes, phase1Volumes, policyCandidates,
} from "../electron/server/stacks/freeze.js";
// As a namespace: the counter-test against the old state (without this export) still loads the file, and only (7) turns red.
import * as freezeJs from "../electron/server/stacks/freeze.js";
import { projectRepoBeforeCopy } from "../electron/server/stacks/code-snapshot.js";
import { createProjectRepo } from "../electron/server/projectbox/projectRepo.js";
import { TAR_UNPACK } from "../electron/server/stacks/prepare.js";
import { copyLocation } from "../electron/server/stacks/location.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ── cbase-clone (played in) ─────────────────────────────────────────────────────────────────────────────────────────
// Logs argv; `copy` copies volumes between the local folders of /src and /dst (FAKE_DOCKER_MOUNTS) like the real program (phase 2:
// empty the --again volumes in the target, then everything except the remaining phase-1 volumes; a missing phase-1 volume in the
// target is an error). With the file `hold` phase 1 waits at the gate after copying (`clone1.finished`, then `clone1.continue`).
// `error-<command>-<phase>` makes the call fail with its content on stderr.
function fakeClone(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "clone.jsonl");
  const js = path.join(dir, "clone.cjs");
  fs.writeFileSync(js, `const fs = require("fs"); const path = require("path");
const dir = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv }) + "\\n");
const m = Object.entries(JSON.parse(process.env.FAKE_DOCKER_MOUNTS || "{}")).sort((a, b) => b[0].length - a[0].length);
const local = (p) => { for (const [z, l] of m) { if (p === z) return l; if (p.startsWith(z + "/")) return l + p.slice(z.length); } return p; };
const [prog, cmd, ...rest] = argv;
if (prog !== ${JSON.stringify(CLONE_PROGRAM)}) { process.stderr.write("fake-clone: unknown program " + prog + "\\n"); process.exit(2); }
const pos = []; const listen = { "--volumes": [], "--again": [], "--upfront": [], "--reconcile": [] }; let phase = ""; let since = null; let akt = null;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--phase") { phase = rest[++i]; akt = null; continue; }
  if (a === "--since") { since = rest[++i]; akt = null; continue; }
  if (a in listen) { akt = listen[a]; continue; }
  if (akt) akt.push(a); else pos.push(a);
}
const f = path.join(dir, "error-" + cmd + (phase ? "-" + phase : ""));
if (fs.existsSync(f)) { process.stderr.write(fs.readFileSync(f, "utf8")); process.exit(1); }
const vols = (w) => { try { return fs.readdirSync(path.join(w, "volumes")); } catch { return []; } };
const copy = (q, z, v) => { fs.rmSync(path.join(z, "volumes", v), { recursive: true, force: true }); fs.cpSync(path.join(q, "volumes", v), path.join(z, "volumes", v), { recursive: true }); };
const wait = (file) => { const s = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(file)) Atomics.wait(s, 0, 0, 20); };
if (cmd === "copy") {
  const q = local(pos[0]); const z = local(pos[1]);
  if (phase === "1") {
    for (const v of [...listen["--volumes"], ...listen["--upfront"]]) copy(q, z, v);
    if (listen["--upfront"].length) process.stdout.write("phase=1 entries=0 upfront_error=2 upfront_begin_ns=" + (BigInt(Date.now()) * 1000000n) + "\\n");
    if (fs.existsSync(path.join(dir, "hold"))) { fs.writeFileSync(path.join(dir, "clone1.finished"), ""); wait(path.join(dir, "clone1.continue")); }
  } else {
    const again = new Set(listen["--again"]);
    const upfront = listen["--volumes"].filter((v) => !again.has(v));
    for (const v of upfront) if (!fs.existsSync(path.join(z, "volumes", v))) { process.stderr.write("phase-1 volume " + v + " missing in the target\\n"); process.exit(1); }
    // A reconcile volume must be in the target (phase 1 with --upfront) and needs --since; here it is reconciled as a full copy
    // (the real program reconciles — tools/check/clone-program.test.mjs).
    if (listen["--reconcile"].length && !/^\\d+$/.test(String(since))) { process.stderr.write("--reconcile without --since\\n"); process.exit(1); }
    for (const v of listen["--reconcile"]) if (!fs.existsSync(path.join(z, "volumes", v))) { process.stderr.write("reconcile volume " + v + " missing in the target\\n"); process.exit(1); }
    for (const v of again) fs.rmSync(path.join(z, "volumes", v), { recursive: true, force: true });
    for (const v of vols(q)) if (!upfront.includes(v)) copy(q, z, v);
  }
  if (!(phase === "1" && listen["--upfront"].length)) process.stdout.write("phase=" + phase + "\\n");
} else if (cmd === "list") {
  for (const v of listen["--volumes"]) process.stdout.write("volumes/" + v + "\\n");
} else if (cmd === "policy-protection") {
  process.stdout.write(JSON.stringify(Object.fromEntries(pos.slice(1).map((id) => [id, "alt-" + id.slice(0, 4)]))) + "\\n");
} else if (cmd !== "fadvise") { process.stderr.write("fake-clone: unknown command " + cmd + "\\n"); process.exit(2); }
`);
  const python3 = path.join(dir, "fake-python3");
  fs.writeFileSync(python3, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 });
  const opaque = path.join(dir, "fake-opaque");
  const opaqueLog = path.join(dir, "opaque.log");
  fs.writeFileSync(opaque, `#!/bin/sh\nfor p in "$@"; do printf '%s\\n' "$p" >> '${opaqueLog}'; done\n`, { mode: 0o755 });
  return {
    dir, log, python3, opaque, opaqueLog,
    calls: () => readJsonl(log).map((x) => x.argv),
    hold: () => fs.writeFileSync(path.join(dir, "hold"), ""),
    finished: () => fs.existsSync(path.join(dir, "clone1.finished")),
    further: () => fs.writeFileSync(path.join(dir, "clone1.continue"), ""),
    error: (what, text) => fs.writeFileSync(path.join(dir, `error-${what}`), text),
  };
}

// ── The situation ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// In main: old-db (stopped, always, volume aged), upkeep (stopped, unless-stopped), once (stopped, no), web (running, volume run),
// g1 (stopped) + g2 (running) share `shared`, job/shortjob (stopped), the free volumes free, rmv, fresh, way.
async function build(ctx, fdOpts = {}) {
  const s = scenario(ctx);
  const clone = fakeClone(path.join(ctx.root, `klon-${s.projectId}`));
  const fd = await fakeDocker({ programs: { ...s.programs, python3: clone.python3 }, ...fdOpts });
  const main = containerName(s.projectId);
  const cid = dx(fd, "run", "-d", "--name", main, "--label", `cbase.project=${s.projectId}`, "--mount", `type=volume,src=${volumeName(s.projectId)},dst=/var/lib/docker`, "cbase-projectbox:latest");
  store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([]), ip: "127.0.0.1" });
  const inside = (...a) => dx(fd, "exec", main, "docker", ...a);
  for (const v of ["free", "rmv", "fresh", "way"]) inside("volume", "create", v);
  const mnt = (v) => ["--mount", `type=volume,src=${v},dst=/d`];
  inside("run", "--name", "old-db", "--restart", "always", ...mnt("aged"), "img");
  inside("run", "--name", "upkeep", "--restart", "unless-stopped", ...mnt("upkeep"), "img");
  inside("run", "--name", "once", ...mnt("once"), "img");
  inside("run", "-d", "--name", "web", "--restart", "always", ...mnt("run"), "img");
  inside("run", "--name", "g1", ...mnt("shared"), "img");
  inside("run", "-d", "--name", "g2", ...mnt("shared"), "img");
  inside("run", "--name", "job", ...mnt("changeover"), "img");
  inside("run", "--name", "shortjob", ...mnt("short"), "img");
  for (const v of ["aged", "upkeep", "once", "run", "shared", "free", "rmv", "fresh", "way", "changeover", "short"]) {
    fs.mkdirSync(fd.volumeData(v, main), { recursive: true });
    fs.writeFileSync(path.join(fd.volumeData(v, main), "content"), `data-${v}`);
  }
  // A code repo in the project folder (the snapshot runs for real): a commit and an open change.
  const repo = path.join(s.path, "repo");
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  fs.writeFileSync(path.join(repo, "fresh.txt"), "open\n");
  const b = { s, fd, clone, main, cid, inside, start: fd.calls({ daemon: "host" }).length };
  b.host = () => fd.calls({ daemon: "host" }).slice(b.start).map((a) => a.args);
  b.gateWaiting = (name) => fs.existsSync(path.join(fd.dir, "gates", `${encodeURIComponent(name)}.waiting`)); // fake-docker gatePath
  return b;
}

let chatSeq = 0;
function newCopy(b, { name = "k1", base = null } = {}) {
  const k = copyRequests({ projectId: b.s.projectId, name, chatId: `chat-freeze-${++chatSeq}`, base });
  return setCopyState(k.id, "build", { phase: "clone1" });
}

// Freezing in ops, with the occupancy "copy" as the build holds it.
const inOps = (b, fn, values = {}) => withEnvironment({ CBASE_COPY_OPAQUE_PROGRAM: b.clone.opaque, ...values }, () => withOps(b.fd, fn));
const freeze2 = (b, k) => withProjectOccupancy(b.s.projectId, "copy", () => freeze(k.id, { home: b.s.home, system: b.s.system }));

async function raises(p) {
  try { await p; } catch (e) { return e; }
  assert.fail("freeze did not throw");
}

// After every test: no copy stays working (the instance row made `busy` true), no pause stays.
async function cleanUp(b) {
  for (const k of store.liveStackCopies()) {
    if (k.state === "build") { try { setCopyState(k.id, "error", { error: "test end" }); } catch { /* already gone */ } }
  }
  for (const z of store.projectInstances()) if (z.instance !== MAIN) store.deleteProjectInstance(z.projectId, z.instance);
  if (b && isFrozen(b.main)) await withOps(b.fd, () => thawOut(b.main)).catch(() => {});
  b?.fd.cleanUp();
}

const help = (a) => a[0] === "run" && String(a[a.indexOf("--name") + 1] || "").startsWith("cbase-helper-clone-");
const cloneCall = (what, phase) => (a) => a[0] === "exec" && a.includes(CLONE_PROGRAM) && a[a.indexOf(CLONE_PROGRAM) + 1] === what && (!phase || a[a.indexOf("--phase") + 1] === phase);
const psIn = (main) => (a) => a[0] === "exec" && a.includes(main) && a[a.indexOf(main) + 1] === "docker" && a[a.indexOf(main) + 2] === "ps";

function nothingLeftOver(b, k, part) {
  const pid = b.s.projectId;
  const z = b.fd.state();
  assert.deepEqual(Object.values(z.container).filter((c) => c.labels?.["cbase.helper"]).map((c) => c.name), [], `${part}: a helper stayed`);
  assert.equal(z.volumes[volumeName(pid, copyInstance("k1"))], undefined, `${part}: the copy's volume stayed`);
  assert.equal(fs.existsSync(copyLocation({ data: DIRS.data, projectId: pid, name: "k1" }).root.base), false, `${part}: the copy's location stayed`);
  assert.equal(store.projectInstance(pid, copyInstance("k1")), null, `${part}: the instance row stayed`);
  const row = store.stackCopy(k.id);
  assert.equal(row.state, "error", `${part}: copy ${row.state}`);
  assert.match(row.error, new RegExp(`^${part}: `), `${part}: reason ${row.error}`);
  assert.equal(Boolean(z.container[b.cid].paused), false, `${part}: main stayed paused`);
  assert.equal(isFrozen(b.main), false, `${part}: the barrier stayed shut`);
  assert.equal(projectLocked(pid), null, `${part}: the lock stayed`);
  assert.equal(heavyLoadStatus(), null, `${part}: the heavy load stayed taken`);
}

// ── (1) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) success: helper → phase 1 → desired → pause → code → phase 2 → unpause; --again with reason, desired, policy protection, journal, data in the target", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const pid = b.s.projectId;
      const k = newCopy(b);
      b.clone.hold();
      await inOps(b, async () => {
        const runItem = freeze2(b, k);
        runItem.catch(() => {});
        await waitForTruthy(() => b.clone.finished(), "phase 1 stands at the gate");
        assert.equal(store.stackCopy(k.id).phase, "clone1", "during phase 1 the copy is in clone1");
        // Between phase 1 and pause: job runs now, shortjob ran briefly, a --rm container ran and is gone, a new container
        // mounts `fresh`, `once` lost its container, `way` has disappeared.
        b.inside("start", "job");
        b.inside("start", "shortjob");
        b.inside("stop", "shortjob");
        b.inside("run", "-d", "--rm", "--name", "transient", "--mount", "type=volume,src=rmv,dst=/x", "img");
        b.inside("stop", "transient");
        b.inside("run", "--name", "late", "--mount", "type=volume,src=fresh,dst=/x", "img");
        b.inside("rm", "once");
        b.inside("volume", "rm", "way");
        b.clone.further();
        const result = await runItem;

        // Order on the wire.
        const h = b.host();
        const i = (pred, from = 0) => { const n = h.findIndex((a, j) => j >= from && pred(a)); assert.ok(n >= 0, `not found from ${from}: ${pred}`); return n; };
        const iHelper = i(help);
        const iClone1 = i(cloneCall("copy", "1"));
        const iDesired = i(psIn(b.main), iClone1);
        const iPause = i((a) => a[0] === "pause");
        const iCode = i((a) => a[0] === "exec" && a.includes("/usr/sbin/cbase-wrapper") && a.includes("sh") && a.includes("-c"));
        // The helper is emptied after the code — stop -t 0 and start of the SAME helper, before phase 2.
        const iStop = i((a) => a[0] === "stop" && a[1] === "-t" && a[2] === "0", iCode);
        const iStart = i((a) => a[0] === "start", iStop);
        assert.equal(h[iStop][3], h[iStart][1], "stop and start did not hit the same container");
        assert.notEqual(h[iStop][3], b.cid, "main stopped instead of the helper");
        const iClone2 = i(cloneCall("copy", "2"));
        const iThaw = i((a) => a[0] === "unpause");
        const iGone = i((a) => a[0] === "rm" && a.includes("-v"));
        const followUp = [iHelper, iClone1, iDesired, iPause, iCode, iStop, iStart, iClone2, iThaw, iGone];
        assert.deepEqual([...followUp].sort((x, y) => x - y), followUp, `order ${JSON.stringify(followUp)}`);
        assert.equal(h.filter((a) => a[0] === "pause").length, 1);

        // The helper: mounts and labels.
        const run = h[iHelper];
        const mounts = run.filter((_, j) => run[j - 1] === "--mount");
        const runtime = locationFor({ projectId: pid, converted: true });
        const location = copyLocation({ data: DIRS.data, projectId: pid, name: "k1" });
        assert.deepEqual(mounts, [
          `type=volume,src=${volumeName(pid)},dst=/src,readonly`,
          `type=volume,src=${volumeName(pid, copyInstance("k1"))},dst=/dst`,
          `type=bind,src=${b.s.path},dst=${b.s.path}`,
          `type=bind,src=${runtime.root},dst=${runtime.root}`,
          `type=bind,src=${location.root.open},dst=${location.root.open}`,
          `type=bind,src=${b.s.system.usrLocalBin},dst=/usr/local/bin,readonly`,
          `type=bind,src=${path.join(b.s.home, ".gitconfig")},dst=${path.join(b.s.home, ".gitconfig")},readonly`,
        ]);
        const labels = run.filter((_, j) => run[j - 1] === "--label");
        assert.ok(labels.every((l) => l.startsWith("cbase.helper")), `labels: ${labels}`);

        // Phase 1 and phase 2.
        const p1 = ["aged", "changeover", "free", "fresh", "once", "rmv", "short", "upkeep", "way"];
        assert.deepEqual(result.phase1.volumes, p1, "phase 1: without a running container, shared never");
        const k2 = h[iClone2];
        const volsFrom = (a, flag) => { const s = a.indexOf(flag); if (s < 0) return []; const r = []; for (const x of a.slice(s + 1)) { if (x.startsWith("--")) break; r.push(x); } return r; };
        assert.deepEqual(volsFrom(h[iClone1], "--volumes"), p1);
        assert.deepEqual(volsFrom(k2, "--volumes"), p1);
        assert.deepEqual(volsFrom(k2, "--again"), ["changeover", "fresh", "once", "rmv", "short", "way"]);
        // The volumes of running containers (run at web, shared at g2) come UPFRONT in phase 1 and are only reconciled in the pause —
        // from the start of the upfront copy that phase 1 reports.
        assert.deepEqual(volsFrom(h[iClone1], "--upfront"), ["run", "shared"], "the running volumes are missing in phase 1");
        assert.deepEqual(volsFrom(k2, "--reconcile"), ["run", "shared"], "the running volumes are not reconciled in the pause");
        assert.match(String(volsFrom(k2, "--since")[0]), /^\d+$/, "phase 2 without the start of the upfront copy");
        assert.deepEqual(result.phase1.upfront, ["run", "shared"]);
        const journal = store.stackCopy(k.id).journal.data;
        assert.deepEqual(journal.freeze.again, { once: "container-gone", short: "started", fresh: "new-container", rmv: "mounted", changeover: "running", way: "disappeared" });
        assert.deepEqual([journal.freeze.events.incomplete, journal.freeze.events.reason], [false, null], "the ordinary case counts as complete");
        assert.equal(journal.freeze.part, "finished");
        assert.deepEqual(journal.freeze.phase1.upfront, ["run", "shared"]);
        assert.equal(String(journal.freeze.phase1.upfrontSince), volsFrom(k2, "--since")[0], "the start of the upfront copy is not in the journal");
        // The tolerated messages of the upfront volumes' own cp, counted in the journal.
        assert.equal(journal.freeze.phase1.upfrontError, 2, "the number of tolerated messages of the upfront copy is not in the journal");
        assert.equal(journal.freeze.thawed, true);
        assert.equal(journal.freeze.helperId, null);
        assert.ok(journal.freeze.location && journal.freeze.volume && journal.freeze.pause);

        // Desired state and policy protection.
        assert.deepEqual(result.desired.container.filter((c) => c.state === "running").map((c) => c.name).sort(), ["g2", "job", "web"]);
        const insideZ = b.fd.state(b.main);
        const idOf = (n) => Object.values(insideZ.container).find((c) => c.name === n).id;
        const cand = [idOf("old-db"), idOf("upkeep")].sort();
        assert.deepEqual(journal.freeze.policy.candidates, cand);
        const ps = h[i(cloneCall("policy-protection"))];
        assert.deepEqual(ps.slice(ps.indexOf("/dst") + 1), cand);
        assert.deepEqual(result.policy, Object.fromEntries(cand.map((id) => [id, `alt-${id.slice(0, 4)}`])));
        assert.deepEqual(journal.freeze.policy.old, result.policy);
        // fadvise on the target after phase 2, never on the live source.
        const fa = h.filter(cloneCall("fadvise")).at(-1);
        assert.deepEqual(fa.slice(fa.indexOf("fadvise") + 1), ["/dst"]);

        // Data in the target: every volume of the source, `way` not.
        const target = b.fd.volumeData(volumeName(pid, copyInstance("k1")));
        const inTarget = fs.readdirSync(path.join(target, "volumes")).sort();
        assert.deepEqual(inTarget, ["aged", "changeover", "free", "fresh", "once", "rmv", "run", "shared", "short", "upkeep"]);
        for (const v of inTarget) assert.equal(fs.readFileSync(path.join(target, "volumes", v, "_data", "content"), "utf8"), `data-${v}`);
        assert.deepEqual(b.fd.state().volumes[volumeName(pid, copyInstance("k1"))].labels, { "cbase.project": pid, "cbase.instance": "copy-k1" });

        // The code ran in the pause: snapshot, objects, open change.
        assert.ok(fs.existsSync(location.root.snapshot));
        assert.deepEqual(result.code.repos.map((r) => [r.part, r.rel]), [["p", "."], ["r0", "repo"]], "the project folder carried no project repo");
        assert.equal(result.code.repos[1].open?.paths, 2, "a.txt changed, fresh.txt new");
        // The project repo arose BEFORE the pause in the helper; in the pause "State before copy" followed.
        assert.equal(journal.freeze.projectRepo.created, true);
        assert.match(journal.freeze.projectRepo.commit, /^[0-9a-f]{40,64}$/);
        assert.deepEqual(git(b.s.path, "log", "--format=%s").trim().split("\n"), ["State before copy k1", "Project repo created before copy k1"]);
        assert.equal(git(b.s.path, "config", "--local", "cbase.projectRepo").trim(), "true");
        const iInit = i((a) => a[0] === "exec" && a.includes("git") && a.includes("init"));
        assert.ok(iHelper < iInit && iInit < iPause, `git init between helper and pause (${iHelper}/${iInit}/${iPause})`);
        assert.ok(fs.readdirSync(location.root.objects("r0")).length > 0);

        // Afterwards: copy in build/clone2, instance to create, main running, lock, heavy load and helper gone.
        const row = store.stackCopy(k.id);
        assert.deepEqual([row.state, row.phase], ["build", "clone2"]);
        assert.equal(store.projectInstance(pid, copyInstance("k1")).state, "create");
        assert.equal(Boolean(b.fd.state().container[b.cid].paused), false);
        assert.equal(isFrozen(b.main), false);
        assert.equal(projectLocked(pid), null);
        assert.equal(heavyLoadStatus(), null);
        assert.deepEqual(Object.values(b.fd.state().container).filter((c) => c.labels?.["cbase.helper"]), []);
        assert.ok(result.times.clone1Ms >= 0 && result.times.clone2Ms >= 0 && result.times.pauseMs >= 0);
      });
    } finally { await cleanUp(b); }
  });
});

// ── (2) ──────────────────────────────────────────────────────────────────────────────

const PARTS = ["location", "volume", "helper", "projectRepo", "inspect1", "clone1", "lock", "services", "pause", "code", "clear", "clone2", "recheck", "policy", "fadvise", "helper-gone"];

test("(2) a forced error before every step: thaw before every dismantling, nothing stays, copy error with reason; full disk in phase 2", async () => {
  await withAgentsServer(async (ctx) => {
    const cases = [...PARTS.map((t) => ({ part: t })), { part: "clone2", disk: true }];
    for (const f of cases) {
      const b = await build(ctx);
      try {
        const k = newCopy(b);
        if (f.disk) b.clone.error("copy-2", "cp: error writing '/dst/volumes/run/_data/content': No space left on device\n");
        const e = await inOps(b, () => raises(freeze2(b, k)), f.disk ? {} : { CBASE_COPY_ERROR_AT: f.part });
        const what = f.disk ? "clone2 (disk)" : f.part;
        assert.equal(e.code, "COPY_BUILD", `${what}: ${e.message}`);
        assert.equal(e.part, f.part, what);
        assert.equal(e.dismantled, true, `${what}: ${e.message}`);
        nothingLeftOver(b, k, f.part);
        if (f.disk) assert.match(store.stackCopy(k.id).error, /No space left on device/);
        assert.equal(store.stackCopy(k.id).journal.data.freeze.part, f.part);
        const h = b.host();
        if (f.part === "location") assert.deepEqual(h, [], "before the location: no docker call");
        const iPause = h.findIndex((a) => a[0] === "pause");
        if (["code", "clear", "clone2"].includes(f.part)) {
          assert.ok(iPause >= 0, `${what}: not paused`);
          const iThaw = h.findIndex((a) => a[0] === "unpause");
          const iBack = h.findIndex((a, j) => j > iPause && ((a[0] === "rm" && a.includes("-v")) || (a[0] === "volume" && a[1] === "rm")));
          assert.ok(iThaw > iPause && iBack > iThaw, `${what}: dismantling before the thaw (${iPause}/${iThaw}/${iBack})`);
        } else if (PARTS.indexOf(f.part) <= PARTS.indexOf("pause")) {
          assert.equal(iPause, -1, `${what}: paused although the error came before`);
        }
      } finally { await cleanUp(b); }
    }
  });
});

// ── (3) ──────────────────────────────────────────────────────────────────────────────────

test("(3) a leftover (location or volume) of an earlier copy: fails, does NOT touch it", async () => {
  await withAgentsServer(async (ctx) => {
    for (const rest of ["location", "volume"]) {
      const b = await build(ctx);
      try {
        const pid = b.s.projectId;
        const location = copyLocation({ data: DIRS.data, projectId: pid, name: "k1" });
        const vname = volumeName(pid, copyInstance("k1"));
        if (rest === "location") { fs.mkdirSync(location.root.base, { recursive: true }); fs.writeFileSync(path.join(location.root.base, "foreign"), "x"); }
        else dx(b.fd, "volume", "create", "--label", `cbase.project=${pid}`, "--label", "cbase.instance=copy-k1", vname);
        const k = newCopy(b);
        const e = await inOps(b, () => raises(freeze2(b, k)));
        assert.equal(e.part, rest, e.message);
        assert.match(e.message, /gibt es schon/);
        if (rest === "location") assert.equal(fs.readFileSync(path.join(location.root.base, "foreign"), "utf8"), "x", "the foreign location was touched");
        else {
          assert.ok(b.fd.state().volumes[vname], "the foreign volume was removed");
          assert.equal(fs.existsSync(location.root.base), false, "the own location stayed");
        }
        assert.equal(store.stackCopy(k.id).state, "error");
        assert.equal(store.projectInstance(pid, copyInstance("k1")), null);
      } finally { await cleanUp(b); }
    }
  });
});

// ── (4) ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(4) preconditions without a docker call: without ops, wrong phase, without occupancy, heavy load taken", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const k = newCopy(b);
      // Without the ops mark.
      const g1 = await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined }, () => raises(withProjectOccupancy(b.s.projectId, "copy", () => freeze(k.id))));
      assert.equal(g1.code, "NO_OPS");
      await inOps(b, async () => {
        // Without occupancy.
        await assert.rejects(freeze(k.id, { home: b.s.home, system: b.s.system }), /without the project occupancy “copy”/);
        // Heavy load of another project.
        const free = occupyHeavyLoad("relocation", { projectId: "other" });
        try {
          await assert.rejects(freeze2(b, k), (e) => e.code === "HEAVY_LOAD_OCCUPIED");
        } finally { free(); }
        // Wrong phase.
        setCopyState(k.id, "build", { phase: "clone2" });
        await assert.rejects(freeze2(b, k), /not in build\/clone1/);
      });
      assert.deepEqual(b.host(), [], "a precondition called docker");
      assert.equal(store.stackCopy(k.id).state, "build", "a precondition is no failure of the copy");
    } finally { await cleanUp(b); }
  });
});

// ── (5) ───────────────────────────────────────────────────────────────────────

function gitInMain(b, gate) {
  // A management git (runtime/git-run.js, instance of main) that runs up to the gate — the shell runs it locally.
  const inst = { projectId: b.s.projectId, instance: MAIN, identifier: b.s.projectId };
  return commandRun(inst, b.s.path, "sh", ["-c", `while [ ! -e '${gate}' ]; do sleep 0.02; done; echo done`]);
}

test("(5) a management git that runs before the pause holds the pause until it ends — with the cap there is no pause", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const gate = path.join(b.clone.dir, "git.continue");
      await inOps(b, async () => {
        const gitRun = gitInMain(b, gate);
        await waitForTruthy(() => runningCommandsIn(b.main) === 1, "the git runs in main");
        const k = newCopy(b);
        const run = freeze2(b, k);
        run.catch(() => {});
        const paused = () => b.host().some((a) => a[0] === "pause");
        await waitForTruthy(() => waitingForCommands(b.main) > 0 || paused(), "freeze waits for the git (or pauses)");
        assert.equal(paused(), false, "pause while the git ran");
        assert.equal(runningCommandsIn(b.main), 1);
        assert.equal(isFrozen(b.main), true, "the barrier is shut while waiting");
        fs.writeFileSync(gate, "");
        const r = await gitRun;
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout.trim(), "done");
        await run;
        assert.equal(b.host().filter((a) => a[0] === "pause").length, 1, "after the git: pause");
        assert.equal(store.stackCopy(k.id).phase, "clone2");
      });
    } finally { await cleanUp(b); }
  });
  // Cap: the git does not end => no pause, the copy fails, main stays untouched.
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const gate = path.join(b.clone.dir, "git2.continue");
    try {
      await inOps(b, async () => {
        const gitRun = gitInMain(b, gate);
        await waitForTruthy(() => runningCommandsIn(b.main) === 1, "the git runs in main");
        const k = newCopy(b);
        const e = await raises(freeze2(b, k));
        assert.equal(e.part, "pause", e.message);
        assert.match(e.message, /Verwaltungs-git .*CBASE_COPY_GIT_MS/);
        assert.equal(b.host().some((a) => a[0] === "pause"), false, "paused despite the cap");
        assert.equal(waitingForCommands(b.main), 0, "the waiting stayed");
        nothingLeftOver(b, k, "pause");
        fs.writeFileSync(gate, "");
        assert.equal((await gitRun).code, 0);
      }, { CBASE_COPY_GIT_MS: "50" });
    } finally {
      fs.writeFileSync(gate, "");
      await cleanUp(b);
    }
  });
});

// ── (6) ─────────────────────────────────────────────────────────────────────────────

test("(6) removeAsRoot during the pause waits at the barrier and runs after the thaw (argv unchanged)", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      await inOps(b, async () => {
        const rest = path.join(locationFor({ projectId: b.s.projectId, converted: true }).root, "leftover-root");
        fs.mkdirSync(rest, { recursive: true });
        await pause(b.main);
        let finished = false;
        const p = removeAsRoot({ projectId: b.s.projectId, path: rest });
        p.then(() => { finished = true; });
        await waitForTruthy(() => waitingForThaw() > 0 || finished, "the clean-up waits (or ends)");
        assert.equal(finished, false, "the clean-up ran into the pause (is paused) instead of waiting");
        assert.equal(b.host().some((a) => a[0] === "exec" && a.includes("root")), false, "exec into the paused container");
        await thawOut(b.main);
        assert.equal(await p, true);
        const exec = b.host().filter((a) => a[0] === "exec" && a.includes("root"));
        assert.deepEqual(exec, [["exec", "-u", "root", b.cid, "rm", "-rf", rest]]);
      });
    } finally { await cleanUp(b); }
  });
});

// ── (7) ──────────────────────────────────────────────────────────────────────────────────────────────

test("(7) rules: phase-1 volumes, --again with reason (buffer overflowed => all), policy candidates", () => {
  const c = (id, running, volumes, { startedAt = "t0", restart = "no" } = {}) => ({ id, name: id, running, status: running ? "running" : "exited", startedAt, restart, volumes });
  const image1 = [c("a", false, ["v1"]), c("b", true, ["v2"]), c("g1", false, ["g"]), c("g2", true, ["g"])];
  assert.deepEqual(phase1Volumes(["v1", "v2", "g", "free"], image1), ["free", "v1"]);
  const phase1 = { volumes: ["free", "v1"], container: image1 };
  assert.deepEqual(againVolumes(phase1, { container: image1, volumes: ["free", "v1", "v2", "g"] }).again, []);
  assert.deepEqual(againVolumes(phase1, { container: image1, volumes: ["free", "v1"] }, { mounted: new Set(["free"]) }).reasons, { free: "mounted" });
  assert.deepEqual(againVolumes(phase1, { container: image1, volumes: ["free", "v1"] }, { incomplete: true }).reasons, { free: "events-incomplete", v1: "events-incomplete" });
  assert.equal(EVENT_BUFFER, 256);
  const policy = [c("x", false, [], { restart: "always" }), c("y", false, [], { restart: "unless-stopped" }), c("z", false, [], { restart: "on-failure" }), c("n", false, [], { restart: "no" }), c("l", true, [], { restart: "always" })];
  // A paused inner container counts as running for the volumes, but not in the desired state — with a policy it is a candidate.
  policy.push({ ...c("p", true, [], { restart: "always" }), status: "paused" }, { ...c("r", true, [], { restart: "always" }), status: "restarting" });
  assert.deepEqual(policyCandidates(policy), ["p", "x", "y", "z"]);
  // The window is covered only if the oldest event lies before it (or the buffer is empty).
  const { eventsComplete } = freezeJs;
  assert.equal(typeof eventsComplete, "function", "no completeness rule — the length of the answer decided");
  assert.equal(eventsComplete([], 100), true, "a quiet daemon");
  assert.equal(eventsComplete([99, 150, 400], 100), true);
  assert.equal(eventsComplete([100, 150, 400], 100), false, "the oldest lies in the window — something before it may be missing");
  assert.equal(eventsComplete([50, null], 100), false, "an event without a time");
});

// ── (8) ─────────────────────────────────────────────────────

test("(8) a management git killed before the pause counts until its group is quiet — TERM at once, KILL after the escalation, only then pause", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    const t1 = path.join(b.clone.dir, "git8.output");
    const t2 = path.join(b.clone.dir, "git8.end");
    const pidFile = path.join(b.clone.dir, "git8.pid");
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await inOps(b, async () => {
        const inst = { projectId: b.s.projectId, instance: MAIN, identifier: b.s.projectId };
        // The group ignores TERM (the shell and, inherited, its children), writes more than the output cap at gate t1 and otherwise
        // runs until t2 — a long git that B kills (output cap like the deadline of the git-run cap).
        const script = `trap '' TERM; echo $$ > '${pidFile}'; while [ ! -e '${t1}' ]; do sleep 0.02; done; head -c 4096 /dev/zero | tr '\\0' x; while [ ! -e '${t2}' ]; do sleep 0.02; done`;
        const gitRun = commandRun(inst, b.s.path, "sh", ["-c", script], { maxBuffer: 1024 });
        await waitForTruthy(() => runningCommandsIn(b.main) === 1 && fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", "the git runs in main");
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        const k = newCopy(b);
        const run = freeze2(b, k);
        run.catch(() => {});
        await waitForTruthy(() => waitingForCommands(b.main) > 0, "freeze waits for the git");
        fs.writeFileSync(t1, "");
        const r = await gitRun;
        assert.equal(r.cap, "output", r.stderr);
        // The docker CLI is gone, the group in the container is not: as long as its escalation is open, the command counts.
        if (openEscalations() > 0) assert.equal(runningCommandsIn(b.main), 1, "the CLI ended, the group lives — and the counter already fell");
        const kills = () => b.host().flatMap((a, i) => (a[0] === "exec" && a.includes("kill") ? [[a[5], i]] : []));
        const paused = () => b.host().some((a) => a[0] === "pause");
        await waitForTruthy(() => kills().some(([sig]) => sig === "-TERM") || paused(), "TERM to the group (or pause) on the wire");
        assert.equal(paused(), false, "pause before the TERM to the group — the TERM waited at the barrier for the thaw");
        await run;
        const iPause = b.host().findIndex((a) => a[0] === "pause");
        const iTerm = kills().find(([sig]) => sig === "-TERM")?.[1] ?? -1;
        const iKill = kills().find(([sig]) => sig === "-KILL")?.[1] ?? -1;
        assert.ok(iTerm >= 0 && iKill > iTerm && iPause > iKill, `TERM ${iTerm} < KILL ${iKill} < pause ${iPause}`);
        await waitForTruthy(() => !alive(pid), "the group is gone");
        assert.equal(runningCommandsIn(b.main), 0);
        assert.equal(store.stackCopy(k.id).phase, "clone2");
      }, { CBASE_IN_PROJECT_ESCALATION_MS: "300" });
    } finally {
      fs.writeFileSync(t2, "");
      await cleanUp(b);
    }
  });
});

// ── (9) ──────────────────────────────────────────────────

test("(9) overflowed buffer or restarted main (empty buffer) => every phase-1 volume in --again", async () => {
  await withAgentsServer(async (ctx) => {
    for (const fall of ["buffer", "restart"]) {
      const b = await build(ctx, fall === "buffer" ? { eventBuffer: 4 } : {});
      try {
        const k = newCopy(b);
        b.clone.hold();
        await inOps(b, async () => {
          const run = freeze2(b, k);
          run.catch(() => {});
          await waitForTruthy(() => b.clone.finished(), "phase 1 stands at the gate");
          // In phase 1 a --rm container mounts `rmv` and is gone before the desired state comes — only the event knows of it.
          b.inside("run", "-d", "--rm", "--name", "transient", "--mount", "type=volume,src=rmv,dst=/x", "img");
          b.inside("stop", "transient");
          if (fall === "buffer") {
            // Four events afterwards: the buffer (4) holds only them, the mount has dropped out.
            for (let i = 0; i < 4; i++) { b.inside("run", "-d", "--rm", "--name", `noise${i}`, "img"); b.inside("stop", `noise${i}`); }
          } else {
            // Main restarts (unless-stopped after OOM): a fresh inner dockerd with an empty buffer.
            dx(b.fd, "stop", b.main);
            dx(b.fd, "start", b.main);
          }
          b.clone.further();
          await run;
          const p1 = ["aged", "changeover", "free", "fresh", "once", "rmv", "short", "upkeep", "way"];
          const k2 = b.host().filter(cloneCall("copy", "2")).at(-1);
          const after = k2.slice(k2.indexOf("--again") + 1);
          const end = after.findIndex((x) => x.startsWith("--")); // `--reconcile … --since …` follow
          assert.deepEqual(end < 0 ? after : after.slice(0, end), p1, `${fall}: not every phase-1 volume again`);
          const e = store.stackCopy(k.id).journal.data.freeze;
          assert.deepEqual([e.events.incomplete, e.events.reason], [true, fall], fall);
          assert.equal(e.again.rmv, "events-incomplete", fall);
          assert.equal(store.stackCopy(k.id).phase, "clone2", fall);
        });
      } finally { await cleanUp(b); }
    }
  });
});

// ── (10) ───────────────────────────────────────────────────────────────────────

test("(10) a mount between desired and effective pause discards the copy (recheck); a mount between ps and inspect of inspect1 => --again", async () => {
  // (a) The `pause` waits at the gate after the desired state stands — there a --rm container mounts `free`, after the next full
  // second (in whole seconds and with the end BEFORE the pause the recheck did not see it).
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { pauseGate: "pause" });
    try {
      const k = newCopy(b);
      await inOps(b, async () => {
        const run = freeze2(b, k);
        run.catch(() => {});
        await b.fd.gateReached("pause");
        const target = (Math.floor(Date.now() / 1000) + 1) * 1000;
        await waitForTruthy(() => Date.now() > target, "the next full second");
        b.inside("run", "-d", "--rm", "--name", "late", "--mount", "type=volume,src=free,dst=/x", "img");
        b.inside("stop", "late");
        b.fd.openGate("pause");
        const e = await raises(run);
        assert.equal(e.part, "recheck", e.message);
        assert.match(e.message, /Volume free eingehängt/);
        nothingLeftOver(b, k, "recheck");
      });
    } finally { await cleanUp(b); }
  });
  // (b) The `inspect` of inspect1 waits at the gate (after the `ps`) — there a --rm container with `free` starts, runs through
  // phase 1 and is gone before the desired state. The gate opens two full seconds later (the old start AFTER inspect1, −1 s, missed it).
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { inspectGate: "inspect1" });
    try {
      const k = newCopy(b);
      b.clone.hold();
      await inOps(b, async () => {
        const run = freeze2(b, k);
        run.catch(() => {});
        await b.fd.gateReached("inspect1");
        b.inside("run", "-d", "--rm", "--name", "during", "--mount", "type=volume,src=free,dst=/x", "img");
        const target = (Math.floor(Date.now() / 1000) + 2) * 1000;
        await waitForTruthy(() => Date.now() >= target, "two full seconds");
        b.fd.openGate("inspect1");
        await waitForTruthy(() => b.clone.finished(), "phase 1 stands at the gate");
        b.inside("stop", "during");
        b.clone.further();
        const result = await run;
        assert.ok(result.phase1.volumes.includes("free"), "free was no phase-1 volume");
        assert.equal(store.stackCopy(k.id).journal.data.freeze.again.free, "mounted");
      });
    } finally { await cleanUp(b); }
  });
});

// ── (11) ──────────────────────────────────────────────────────────────────────────

test("(11) unpause fails => copy error \"thaw\", dismantling complete, main stays frozen until the guard thaws it later", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const pid = b.s.projectId;
      const k = newCopy(b);
      b.fd.errorAt([{ daemon: "host", pattern: "^unpause " }]);
      await inOps(b, async () => {
        const e = await raises(freeze2(b, k));
        assert.equal(e.part, "thaw", e.message);
        assert.equal(e.dismantled, true, e.message);
        assert.match(store.stackCopy(k.id).error, /^thaw: Auftauen des Haupts scheiterte/);
        assert.equal(store.stackCopy(k.id).state, "error");
        assert.deepEqual(Object.values(b.fd.state().container).filter((c) => c.labels?.["cbase.helper"]).map((c) => c.name), [], "a helper stayed");
        assert.equal(b.fd.state().volumes[volumeName(pid, copyInstance("k1"))], undefined, "the copy's volume stayed");
        assert.equal(store.projectInstance(pid, copyInstance("k1")), null, "the instance row stayed");
        assert.equal(b.host().some(cloneCall("copy", "2")), true, "phase 2 did not run");
        assert.equal(b.host().some(cloneCall("policy-protection")), false, "it went on after the failed thaw");
        // Main stays frozen (barrier shut), the guard has planned a retry; lock and heavy load are free.
        assert.equal(Boolean(b.fd.state().container[b.cid].paused), true);
        assert.equal(isFrozen(b.main), true);
        assert.equal(openRethaw(), 1);
        assert.equal(projectLocked(pid), null);
        assert.equal(heavyLoadStatus(), null);
        b.fd.errorAt([]);
        assert.equal(advanceRethaw(), 1);
        await waitForTruthy(() => !isFrozen(b.main), "the guard thaws later");
        assert.equal(Boolean(b.fd.state().container[b.cid].paused), false);
      });
    } finally {
      b.fd.errorAt([]);
      await cleanUp(b);
    }
  });
});

// ── (12) ────────────────────────────────────────────────────────────

test("(12) volume rm of the copy fails => the instance row stays (error) and holds the volume", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const pid = b.s.projectId;
      const k = newCopy(b);
      b.fd.errorAt([{ daemon: "host", pattern: "^volume rm " }]);
      await inOps(b, async () => {
        const e = await raises(freeze2(b, k));
        assert.equal(e.part, "clone2", e.message);
        assert.equal(e.dismantled, false, e.message);
        assert.match(store.stackCopy(k.id).error, /Rückbau unvollständig: Volume /);
        const row = store.projectInstance(pid, copyInstance("k1"));
        assert.ok(row, "the instance row fell although the volume stayed");
        assert.equal(row.state, "error");
        assert.ok(b.fd.state().volumes[volumeName(pid, copyInstance("k1"))], "the volume is gone — the error was not played in");
        assert.deepEqual(Object.values(b.fd.state().container).filter((c) => c.labels?.["cbase.helper"]).map((c) => c.name), [], "a helper stayed");
        assert.equal(fs.existsSync(copyLocation({ data: DIRS.data, projectId: pid, name: "k1" }).root.base), false, "the location stayed");
        assert.equal(isFrozen(b.main), false);
      }, { CBASE_COPY_ERROR_AT: "clone2" });
    } finally {
      b.fd.errorAt([]);
      await cleanUp(b);
    }
  });
});

// ── (13) ─────────────────────────────────────────────────────

test("(13a) the helper is emptied before phase 2; a tar that is no longer the checked one afterwards discards the copy", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx, { stopGate: "helper-clear" });
    try {
      const pid = b.s.projectId;
      const k = newCopy(b);
      await inOps(b, async () => {
        let finished = false;
        const run = freeze2(b, k);
        run.then(() => { finished = true; }, () => { finished = true; });
        await waitForTruthy(() => b.gateWaiting("helper-clear") || finished, "the emptying of the helper (or the end)");
        assert.equal(finished, false, "no `stop` of the helper after the code — a process of main lived until after clone2");
        // What a process of main in the helper would do up to here: the checked tar grows.
        const open = copyLocation({ data: DIRS.data, projectId: pid, name: "k1" }).root.open;
        const tar = fs.readdirSync(open).find((n) => n.endsWith(".tar"));
        assert.ok(tar, "no tar in open/");
        fs.appendFileSync(path.join(open, tar), Buffer.alloc(512));
        b.fd.openGate("helper-clear");
        const e = await raises(run);
        assert.equal(e.part, "clear", e.message);
        assert.match(e.message, /nach seiner Prüfung geändert/);
        assert.equal(b.host().some(cloneCall("copy", "2")), false, "phase 2 ran anyway");
        nothingLeftOver(b, k, "clear");
      });
    } finally {
      b.fd.openGate("helper-clear");
      await cleanUp(b);
    }
  });
});

test("(13b) unpacking the open changes (prepare.js TAR_UNPACK) takes no .git entry", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, "tar-without-git-"));
  try {
    const source = path.join(root, "q");
    const target = path.join(root, "z");
    const files = { "a.txt": "a", ".gitignore": "x", ".git/config": "[core]\n\tfsmonitor = ./evil\n", "sub/.git/HEAD": "ref", "x/.github/w.yml": "w", "y/.gitx": "g" };
    for (const [rel, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), content); }
    const tar = path.join(root, "open.tar");
    execFileSync("tar", ["-cf", tar, "-C", source, "a.txt", ".gitignore", ".git", "sub", "x", "y"]);
    fs.mkdirSync(target);
    execFileSync("tar", [...TAR_UNPACK], { cwd: target, input: fs.readFileSync(tar) });
    const exists = (rel) => fs.existsSync(path.join(target, rel));
    assert.deepEqual([".git/config", "sub/.git/HEAD"].filter(exists), [], "a .git entry was unpacked");
    assert.deepEqual(["a.txt", ".gitignore", "x/.github/w.yml", "y/.gitx"].filter((r) => !exists(r)), [], "too much excluded");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── (14) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(14) a still empty project folder stays without project repo; a code repo as project folder and an existing project repo are not created", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      fs.rmSync(path.join(b.s.path, "repo"), { recursive: true, force: true });
      assert.deepEqual(fs.readdirSync(b.s.path), [], "the project folder is empty");
      const k = newCopy(b);
      const result = await inOps(b, () => freeze2(b, k));
      assert.deepEqual(store.stackCopy(k.id).journal.data.freeze.projectRepo, { created: false, reason: "empty" });
      assert.equal(fs.existsSync(path.join(b.s.path, ".git")), false, "an empty folder got a .git (target of a git clone)");
      assert.deepEqual(result.code.repos, []);
    } finally { await cleanUp(b); }
  });
  // Without a helper: these cases end before a git would run.
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, "pf1-"));
  try {
    const code = path.join(root, "code");
    fs.mkdirSync(code);
    git(code, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(code, "a.txt"), "a\n");
    assert.deepEqual(await projectRepoBeforeCopy({ projectId: "p", name: "k1", projectPath: code, helper: null }), { created: false, reason: "repo" });
    assert.doesNotMatch(fs.readFileSync(path.join(code, ".git", "config"), "utf8"), /projectrepo/i, "the code repo now carries the marker");
    const own = path.join(root, "own");
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, "note.md"), "n\n");
    await createProjectRepo(own);
    const prior = git(own, "rev-parse", "HEAD").trim();
    assert.deepEqual(await projectRepoBeforeCopy({ projectId: "p", name: "k1", projectPath: own, helper: null }), { created: false, reason: "marker" });
    assert.equal(git(own, "rev-parse", "HEAD").trim(), prior, "an existing project repo got a commit");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── (15) ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(15) a teardown that hit the paused main (\"is paused\") lies in main's post-work and runs after the thaw", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    try {
      const pid = b.s.projectId;
      const repo = path.join(b.s.path, "repo");
      const dir = path.join(b.s.location.worktrees, "agent-np");
      fs.mkdirSync(b.s.location.worktrees, { recursive: true });
      git(repo, "worktree", "add", "-q", "-b", "cbase/agent-np", dir, "HEAD");
      const denier = path.join(b.fd.dir, "docker-pause");
      fs.writeFileSync(denier, "#!/bin/sh\nprintf '%s\\n' 'Error response from daemon: Container 4f2a is paused, unpause the container before exec' >&2\nexit 1\n", { mode: 0o755 });
      const k = newCopy(b);
      await inOps(b, async () => {
        // 1. A teardown in main whose exec hits the daemon's pause (cbase did not hold it: no barrier): into the post-work.
        const main = runInstance(pid);
        assert.ok(main, "main is converted and alive");
        const r = await withEnvironment({ CBASE_DOCKER_BIN: denier }, () =>
          worktreeTeardown(main, { who: "Test", worktrees: [{ repo, dir, branch: "cbase/agent-np", deleteBranch: true }] }));
        assert.deepEqual({ postWork: r.postWork, changed: r.changed, removed: r.removed }, { postWork: true, changed: false, removed: false }, JSON.stringify(r));
        assert.ok(fs.existsSync(dir), "the worktree stays until the thaw");
        assert.ok(fs.existsSync(postWorkFile(pid)), "main's post-work is in its file");
        const prior = b.host().length;
        // 2. Freezing the copy thaws — afterwards main's post-work runs in main's container.
        await freeze2(b, k);
        await openGitJobs();
        assert.equal(fs.existsSync(dir), false, "the worktree stayed after the thaw (main's post-work did not run)");
        assert.equal(fs.existsSync(postWorkFile(pid)), false, "the post-work row stayed");
        assert.equal(fs.existsSync(`${postWorkFile(pid)}.running`), false, "the takeover stayed");
        assert.equal(git(repo, "branch", "--list", "cbase/agent-np").trim(), "", "the branch of the unchanged worktree stayed");
        const h = b.host().slice(prior);
        const iThaw = h.findIndex((a) => a[0] === "unpause");
        const iTeardown = h.findIndex((a) => a[0] === "exec" && a.includes(b.main) && a.includes("git") && a.includes("remove"));
        assert.ok(iThaw >= 0, "no unpause on the wire");
        assert.ok(iTeardown > iThaw, `the worktree remove did not run after the unpause (unpause ${iThaw}, remove ${iTeardown})`);
      });
    } finally { await cleanUp(b); }
  });
});

// ── (16) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// dismantlingClone must not delete the copy's location when the clone helper was NOT removed — the helper mounts `open/` rw (and may
// still run), and B would delete recursively in a tree a container writes to. Now the location stays and `error` names it with the reason.
test("(16) if the helper is not removed (rm fails) the copy's location stays — error names it and the helper", async () => {
  await withAgentsServer(async (ctx) => {
    const b = await build(ctx);
    let locationBase = null;
    try {
      const pid = b.s.projectId;
      const k = newCopy(b);
      locationBase = copyLocation({ data: DIRS.data, projectId: pid, name: "k1" }).root.base;
      b.fd.errorAt([{ daemon: "host", pattern: "^rm -f -v " }]);
      await inOps(b, async () => {
        const e = await raises(freeze2(b, k));
        assert.equal(e.part, "clone2", e.message);
        assert.equal(e.dismantled, false, e.message);
        assert.ok(Object.values(b.fd.state().container).some((c) => c.labels?.["cbase.helper"]), "the helper is gone — the error was not played in");
        assert.equal(fs.existsSync(locationBase), true, "the location fell although the helper (with open/ rw) was not removed");
        const f = store.stackCopy(k.id).error;
        assert.ok(f.includes(`Ort ${locationBase}: bleibt — Helfer nicht entfernt`), f);
        assert.ok(store.projectInstance(pid, copyInstance("k1")), "the instance row fell although something stayed");
        assert.equal(isFrozen(b.main), false);
      }, { CBASE_COPY_ERROR_AT: "clone2" });
    } finally {
      b.fd.errorAt([]);
      if (locationBase) fs.rmSync(locationBase, { recursive: true, force: true });
      await cleanUp(b);
    }
  });
});
