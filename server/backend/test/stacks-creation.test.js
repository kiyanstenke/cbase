// Creation, preparation and start of a copy (stacks/build.js, creation.js, prepare.js, start.js, dismantling.js) against the fake docker
// (fake-docker.mjs). The build runs FOR REAL through the queue (copyRequests + wakeQueue, the hook-up from server.js with the
// scenario's test seams): freezing and clone as in stacks-freeze.test.js (`cbase-clone` played in, the code snapshot real), the
// creation through projectbox/instance.js createInstance, every git of the preparation in the copy container through the real shell
// — the fake's "copy view" plays the entrypoint's overlays as local folders (block in fake-docker.mjs), and the copy's inner daemon
// starts only after `.prepared`, like a fresh dockerd on the cloned volume.
//
// What is proved:
//   (1) Through the queue up to `ready`: overlays.tsv outer before inner, every object row DIRECTLY behind its repo, `.local` last;
//       the refs of every copy repo = those of the snapshot without `refs/stash` (HEAD with symbolic refs), the project repo with
//       marker, identity, hooksPath, gpgsign and hook 0755, the open work from the tar, the delete list applied (`git status` of the
//       copy = that of main), every versioned file in the upper layer; only the desired containers run — the stopped `always`
//       container stays off (policy protection) and carries `always` again afterwards; EXACTLY ONE transition to `ready` (events
//       `project/instance` and `project/copy` once each), the instance row with `converted_at`; the result is stored; journal
//       creation/prepare/start; heavy load and occupancy free. Also a worker `on-failure:3` after exit 1 (the fake restarts it on
//       the restart like the real dockerd), and `nothingLeftOver` checks the hosts block.
//   (2) base + a see-through `.gitignore`: three delete passes, `src/generated/g.js` is gone, HEAD detached on the base.
//   (3) A ref to an object reachable only through `alternates` (two refs, two objects): COPY_REF_MISSING names BOTH, and the
//       dismantling is complete (container, network, volume, location with layer, instance row; main runs).
//   (4) a crashed native service with desired state "on" stays off in the copy — only what ran at freeze time is started. The project
//       folder carries no code repo (only a gitfile) and no project repo: it arises at freeze time — the rows are project folder, its
//       objects and `.local`, only `p` is prepared.
//   (5) without ops marks no docker call — the build ends in `error` NO_OPS without an instance row; the dismantling without marks
//       calls no docker and names what stayed.
//   (6) the queue: a leftover of an instance row makes the start step throw => `error` with INSTANCE_CONFLICT and a hint, no start
//       on every pass.
//   (7) Path guard: under stacks/ B writes to the file system only in objects.js — fetching and clearing away also go through its
//       helpers (createReturnPath, createBackup, dismissBackupFile, cleanUpBackup) — every other place is named with count and
//       reason and mentions neither `layer` nor `objects` nor `work(` (with built-in sabotage). Plus the literals of the fake's copy
//       view = the product's.
//   (8) the instance row is no longer in `create` before `ready` => the copy does not become ready — INSTANCE_STATE, dismantling,
//       `error`, no transition, no `converted_at`.
//   (9) server end in `prepare` => the copy stays in `build` (no dismantling next to the stop chain, no `error`); the restart
//       grace of the next process dismantles and puts it back at its old place.
//  (10) server end in freezing (barrier at the lock) => after its own dismantling `waiting_queue` at the old place instead of `error`;
//       in the ending process no new build begins.
//  (11) restartFlag: RestartPolicy -> `--restart`, `on-failure` WITH a count.
//  (12) the project folder as a code repo with a non-ignored worktree (gitfile invalid in the copy), in `app` an embedded repo, a
//       submodule, an ignored worktree and assume-unchanged files => `ready`, the worktree's files NOT deleted, `cfg.txt` with the
//       content of main, `way.txt` gone; the result names all four under `notLinked` and in the hints.
//  (13) the copy container crashes in the middle of the start sequence and restarts => no desired state from the fresh dockerd: `error`
//       with "restarted during the start sequence", the dismantling is complete.
//  (14)/(15) the REAL stop chain (marker + `fireHooks("serverEnd")`, all consumers from server.js) once while main is frozen for phase 2
//       of the clone (the clone fake holds at a gate there), once in the start sequence of the copy; afterwards the next process in
//       the order of server.js (earmark, project-thaw, project-restore, project-instances, copiesRestartGrace — replayed in the
//       process, see the head of (14)). Main is thawed before the stop and ends in order (143, not 137), its desired state is not
//       written from the pause; in the ending process no `error` ((15): `build` without dismantling); after the restart main runs
//       (`ready`), the copy is in `waiting_queue` at the old place without `error`, and nothing of it is left.
//  (16) if `prepare` fails while the server runs and the server end begins during the dismantling of the failure handler, the copy
//       finally stands at `error` — the error wake call goes out anyway (queued, marker `inset.wakeCall`); only the setter that
//       announces the way back holds the wake call at server end (freeze.js).
//  (17)/(18) basis "main" (17) or "feature", which only app knows (18), with open changes of the PROJECT ROOT (note-new.md new,
//       notes.md changed): the copy's project repo stands detached at the state BEFORE "State before copy" — neither change in the copy,
//       clean status —, the commit itself stands in main and carries them, the copy's refs equal the snapshot; journal `applies`
//       and result (`head` detached at the state before, `applies` true or false). Without base as before: (1) additionally checks
//       that note-new.md came along through the commit.
//  (19) pure: checkoutArgs (without beforeCopy as before; a resolved id must resolve; otherwise the state before; `{ ".": ref }`
//       unknown => COPY_BASE; a base other than the one read, beforeCopy on a code repo, no id => COPY_PREPARE) and baseOfTheRepo.
//
// COUNTER-TESTS (each shown red, each file restored afterwards):
//   prepare.js SET_UP without the abort after `cat-file --batch-check` (update-ref then checks itself)
//       => (3) red: "update-ref --no-deref: exit 128 (COPY_PREPARE)", refs/tags/v1 not named
//   prepare.js post-work after ONE pass                                => (2) red: "src/.gitignore still shows through"
//   freeze.js without policy protection (candidates empty)             => (1) red: old-db runs in the copy
//   build.js starts through restoreInstance (the way of main)          => (1) red: error "start: … no converted instance"
//   creation.js overlayRows: object rows at the end instead of behind their repo => (1) red: overlays.tsv in another order
//   freeze.js `desired.services` = main's desired state instead of the running ones => (4) red: services [1, 2] started instead of [1]
//   dismantling.js without the branch "without ops mark"               => (5) red: "incomplete: look up container: … only in server mode"
//       instead of the sentence of what stayed (no docker call even then — docker.js refuses itself)
//   queue.js start without `startFailed`                               => (6) red in 0.7 s: stays waiting_queue. With the first body
//       (waiting by setImmediate) that was a HANG — the old state spins an endless microtask chain; since then (6) counts micro steps
//       (microUntil) and ends the chain in the `finally`
//   prepare.js setUpInput without the filter `refs/stash`              => (1) red: refs/stash in the copy
//   dismantling.js without bringAlongNames                              => (3), (8), (9) red: "the name k1.project-s3.cbase stayed in the hosts block"
//   state.js coupling the instance without `ifState: "create"`          => (8) red: "the copy became ready above an instance row in error"
//   build.js both catch branches without serverEnds                     => (9) red: "in the ending process error: prepare: … COPY_REF_MISSING",
//       (10) red: "… lock: the server ends — no freezing"
//   queue.js runProcedure without serverEnds                            => (9) red: "build ended without a result" — the safety net caught
//   queue.js attempts without serverEnds                                => (10) red: "a second build in the ending process"
//   freeze.js POLICY_PROTECTION without "on-failure"                    => (1) red: worker runs in the copy
//   start.js restartFlag without the retry count                        => (1) red: worker carries "on-failure" instead of "on-failure:3", (11) red
//   code-snapshot.js/prepare.js before the repair                       => (12) red: error "path "app/" is not relative …"; prepare.js
//       alone old (post-work without exceptions) => (12) red: "wt/README.md missing in the copy"; the LIST without `ls-files -v`
//       => (12) red: `cfg.txt` with the state of HEAD
//   result.js before the read-through (`seam()` in (1) and (4), base in (2)): => (1), (2), (4) red (container twice as "native",
//       applies null); every start entry native => (1), (4) red; `code.preparation` dropped or not read => (2) red;
//       snapshot.json never read => (1) red (repos without head)
//   start.js without `await checkLiveness(containerId, …)`               => (13) red: the copy became "ready" with the desired state
//       from the fresh dockerd
//   projectbox/serverEnd.js: the thaw line (`const thaw = thawAll(…)`) replaced by `null`
//       => (14) red: "main ended hard (137): not thawed before the stop …"; (15) stays green (nothing is paused there)
//   inset.js, state.js, freeze.js with the wake call suppressed for EVERY error at server end => (16) red (0 instead of 1)
//   code-snapshot.js without readBeforeCopy => (17), (18) red; prepare.js CHECKOUT with the old arguments => (17), (18) red;
//       result.js `applies` from the id again => (18) red ("applies: true"); result.js `head` detached only if applies => (18) red
//       (branch "main")
//
// No clock: waiting is on states (waitForTruthy without a deadline), the stream barrier and, in (6), counted micro steps. macOS:
// TMPDIR real (a helper mounts no bind source through the link /var -> /private/var).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import {
  MAIN, MAIN_BOTTOM_INSIDE, COPY_ROOT_INSIDE, PROJECTBOX_IMAGE, containerName, copyInstance, networkName, volumeName,
} from "../electron/server/projectbox/creation.js";
import { nativeServicesStatus } from "../electron/server/projectbox/services.js";
import { thawRestartGrace, isFrozen } from "../electron/server/projectbox/docker.js";
import { setInstanceState, instancesRestartGrace } from "../electron/server/projectbox/instances.js";
import { dnsNameOf } from "../electron/server/projectbox/names.js";
import { CGROUP_CONTROL, STATUS_FILE } from "../electron/server/projectbox/instance.js";
import { PRE_COMMIT, PROJECT_REPO_HOOK, PROJECT_REPO_CONFIG, createProjectRepo } from "../electron/server/projectbox/projectRepo.js";
import { heavyLoadStatus } from "../electron/server/projectbox/heavyLoad.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { recreateRestartGraceSeam } from "../electron/server/projectbox/recreate.js";
import { setNativeServicesStarter, setRecreateRestartGrace, restoreRestartGrace, earmarkRestore } from "../electron/server/projectbox/restore.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { pendingRunInputs } from "../electron/server/runs/state.js";
import { startDesiredServices } from "../electron/server/services.js";
import { copyBuild } from "../electron/server/stacks/build.js";
import { CLONE_PROGRAM, setNativeServicesStatus } from "../electron/server/stacks/freeze.js";
import { OVERLAYS_FILE, PREPARED_FILE, copyLocation } from "../electron/server/stacks/location.js";
import { buildAlive, copiesRestartGrace, wakeQueue, setCopyProcedure, postponedStarts } from "../electron/server/stacks/queue.js";
import { restartFlag } from "../electron/server/stacks/start.js";
import { SET } from "../electron/server/stacks/result.js";
import { baseOfTheRepo, checkoutArgs } from "../electron/server/stacks/prepare.js";
import { dismantleCopy } from "../electron/server/stacks/dismantling.js";
import { copyRequests, copyJournal, setCopyState } from "../electron/server/stacks/state.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { COPY_VIEW, fakeDocker, copyView } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { HOSTS_TEST, ID, withOps, scenario } from "./projectbox-scenario.mjs";
import { GLOBAL } from "./quiet.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "electron", "server");
const GIB = 1024 ** 3;
const micro = () => new Promise((r) => setImmediate(r)); // afterwards all microtasks have run
// At most `steps` micro steps until `condition()` holds — counted, no clock; for places where the defect is an endless microtask
// chain (setImmediate never gets its turn there). The verdict falls afterwards in the assertion, not here.
async function microUntil(condition, steps = 200) {
  for (let i = 0; i < steps && !condition(); i++) await null;
}
const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

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
// As in stacks-freeze.test.js (volumes between /src and /dst through FAKE_DOCKER_MOUNTS), plus what the copy needs afterwards:
// phase 2 copies the state of the main's inner daemon onto the copy's (without processes — the clone of the volume is the docker root
// with the container configuration), `policy-protection` prints per id the old RestartPolicy as `{ Name, MaximumRetryCount }` like
// the real program (`on-failure:3` => "on-failure" with 3) and sets it to "no" in the copy. The paths of the two states are in
// `daemons.json` (the test writes them as soon as the fake docker stands). The opaque program writes the marker `.wh..wh..opq`,
// which the fake's copy view reads as `user.overlay.opaque`.
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
const pos = []; const listen = { "--volumes": [], "--again": [], "--upfront": [], "--reconcile": [] }; let phase = ""; let akt = null;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--phase" || a === "--since") { const w = rest[++i]; if (a === "--phase") phase = w; akt = null; continue; }
  if (a in listen) { akt = listen[a]; continue; }
  if (akt) akt.push(a); else pos.push(a);
}
const d = JSON.parse(fs.readFileSync(path.join(dir, "daemons.json"), "utf8"));
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const write = (f, z) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(z)); fs.renameSync(f + ".tmp", f); };
const vols = (w) => { try { return fs.readdirSync(path.join(w, "volumes")); } catch { return []; } };
const copy = (q, z, v) => { fs.rmSync(path.join(z, "volumes", v), { recursive: true, force: true }); fs.cpSync(path.join(q, "volumes", v), path.join(z, "volumes", v), { recursive: true }); };
if (cmd === "copy") {
  const q = local(pos[0]); const z = local(pos[1]);
  // The gate in phase 2 (main is frozen) — the test triggers the server end there and opens it afterwards.
  if (phase === "2" && fs.existsSync(path.join(dir, "clone2.gate"))) {
    fs.writeFileSync(path.join(dir, "clone2.waiting"), "");
    const s = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path.join(dir, "clone2.open"))) Atomics.wait(s, 0, 0, 5);
  }
  // Phase 1 takes the upfront volumes along and reports the start; phase 2 copies them again completely as the "reconcile" (the
  // real program reconciles — tools/check/clone-program.test.mjs).
  if (phase === "1") { for (const v of [...listen["--volumes"], ...listen["--upfront"]]) copy(q, z, v); if (listen["--upfront"].length) process.stdout.write("upfront_begin_ns=" + (BigInt(Date.now()) * 1000000n) + "\\n"); }
  else {
    const again = new Set(listen["--again"]);
    const upfront = listen["--volumes"].filter((v) => !again.has(v));
    for (const v of again) fs.rmSync(path.join(z, "volumes", v), { recursive: true, force: true });
    for (const v of vols(q)) if (!upfront.includes(v)) copy(q, z, v);
    const h = read(d.main);
    for (const c of Object.values(h.container || {})) c.processes = [];
    write(d.copy, h);
  }
  process.stdout.write("phase=" + phase + "\\n");
} else if (cmd === "list") {
  for (const v of listen["--volumes"]) process.stdout.write("volumes/" + v + "\\n");
} else if (cmd === "policy-protection") {
  const z = read(d.copy); const alt = {};
  for (const id of pos.slice(1)) { const c = z.container[id]; const [n, m] = String((c && c.restart) || "no").split(":"); alt[id] = { Name: n || "no", MaximumRetryCount: n === "on-failure" && Number(m) > 0 ? Number(m) : 0 }; if (c) c.restart = ""; }
  write(d.copy, z);
  process.stdout.write(JSON.stringify(alt) + "\\n");
} else if (cmd !== "fadvise") { process.stderr.write("fake-clone: unknown command " + cmd + "\\n"); process.exit(2); }
`);
  const python3 = path.join(dir, "fake-python3");
  fs.writeFileSync(python3, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`, { mode: 0o755 });
  const opaque = path.join(dir, "fake-opaque");
  fs.writeFileSync(opaque, `#!/bin/sh\nfor p in "$@"; do : > "$p/.wh..wh..opq"; done\n`, { mode: 0o755 });
  return {
    python3, opaque,
    calls: () => readJsonl(log).map((x) => x.argv),
    daemons: (values) => fs.writeFileSync(path.join(dir, "daemons.json"), JSON.stringify(values)),
    // Clone phase 2 holds at the gate (an), reports (waiting), goes on (on) — files instead of a duration.
    gate: {
      release: () => fs.writeFileSync(path.join(dir, "clone2.gate"), ""),
      waiting: () => fs.existsSync(path.join(dir, "clone2.waiting")),
      on: () => fs.writeFileSync(path.join(dir, "clone2.open"), ""),
    },
  };
}

// ── The situation ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const stateFile = (fd, daemon) => path.join(fd.dir, "daemon", encodeURIComponent(daemon), "state.json");

// Main with its inner daemon: web (running, always), job (running, no policy), old-db (stopped, always), upkeep (stopped,
// unless-stopped) — each with a volume whose data the clone copies —, plus worker (on-failure:3, exit 1, without a volume).
function mainWithStack(b, { services = [] } = {}) {
  const pid = b.s.projectId;
  const cid = dx(b.fd, "run", "-d", "--name", b.main, "--label", `cbase.project=${pid}`, "--mount", `type=volume,src=${volumeName(pid)},dst=/var/lib/docker`, PROJECTBOX_IMAGE);
  store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([], { services }), ip: "127.0.0.1" });
  const inside = (...a) => dx(b.fd, "exec", b.main, "docker", ...a);
  const mnt = (v) => ["--mount", `type=volume,src=${v},dst=/d`];
  inside("run", "-d", "--name", "web", "--restart", "always", ...mnt("run"), "img");
  inside("run", "-d", "--name", "job", ...mnt("job"), "img");
  inside("run", "--name", "old-db", "--restart", "always", ...mnt("alt"), "img");
  inside("run", "--name", "upkeep", "--restart", "unless-stopped", ...mnt("upkeep"), "img");
  // A worker `on-failure:3`, off after three crashes (exit 1) — the restart of the copy's dockerd would start it again (the counter
  // begins at 0) if the policy protection did not hold it off.
  inside("run", "--name", "worker", "--restart", "on-failure:3", "img");
  b.fd.setExit("worker", 1, b.main);
  for (const v of ["run", "job", "alt", "upkeep"]) {
    fs.mkdirSync(b.fd.volumeData(v, b.main), { recursive: true });
    fs.writeFileSync(path.join(b.fd.volumeData(v, b.main), "content"), `data-${v}`);
  }
  b.cid = cid;
  b.inside = inside;
}

// (1): the project repo with a code repo `app` (clone with origin, branch, stash, open changes, info/exclude).
async function situationSuccess(b, ctx) {
  const outside = path.join(ctx.root, `outside-${b.s.projectId}`);
  const q = path.join(outside, "source-app");
  fs.mkdirSync(q, { recursive: true });
  git(q, "init", "-q", "-b", "main");
  for (const f of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(q, f), `${f}\n`);
  git(q, "add", ".");
  git(q, "commit", "-q", "-m", "one");
  const app = path.join(b.s.path, "app");
  git(b.s.path, "clone", "-q", q, "app");
  git(app, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(app, "f.txt"), "f\n");
  git(app, "add", "f.txt");
  git(app, "commit", "-q", "-m", "feature");
  git(app, "checkout", "-q", "main");
  fs.appendFileSync(path.join(app, "a.txt"), "stashed\n");
  git(app, "stash", "-q");
  fs.appendFileSync(path.join(app, "a.txt"), "open\n");
  fs.rmSync(path.join(app, "b.txt"));
  fs.writeFileSync(path.join(app, "with space.txt"), "space\n");
  fs.mkdirSync(path.join(app, "under"));
  fs.writeFileSync(path.join(app, "under", "deep.txt"), "deep\n");
  fs.writeFileSync(path.join(app, ".git", "info", "exclude"), "# own rule\n*.log\n");
  fs.writeFileSync(path.join(app, "noise.log"), "ignored\n");
  fs.writeFileSync(path.join(b.s.path, "notes.md"), "Notes\n");
  const pr = await createProjectRepo(b.s.path);
  assert.equal(pr.created, true, JSON.stringify(pr));
  fs.writeFileSync(path.join(b.s.path, "note-new.md"), "new\n");
  mainWithStack(b);
  b.app = app;
}

// (2): the project folder itself is a code repo. c1 (the base) carries only README.md; HEAD (c2) adds a `.gitignore` with `src/`,
// in it `src/.gitignore` with `generated/` and `src/generated/g.js` — in the copy at c1 everything shows through from main, and
// every level hides the next.
function situationBase(b) {
  const p = b.s.path;
  git(p, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(p, "README.md"), "one\n");
  git(p, "add", "README.md");
  git(p, "commit", "-q", "-m", "c1");
  b.c1 = git(p, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(p, ".gitignore"), "src/\n");
  fs.mkdirSync(path.join(p, "src", "generated"), { recursive: true });
  fs.writeFileSync(path.join(p, "src", ".gitignore"), "generated/\n");
  fs.writeFileSync(path.join(p, "src", "a.js"), "a\n");
  fs.writeFileSync(path.join(p, "src", "generated", "g.js"), "g\n");
  git(p, "add", "-f", ".gitignore", "src/.gitignore", "src/a.js", "src/generated/g.js");
  git(p, "commit", "-q", "-m", "c2");
  mainWithStack(b);
}

// (3): the project folder is a code repo with `alternates` onto a foreign repo; two refs point to two objects that exist only there.
function situationAlternates(b, ctx) {
  const p = b.s.path;
  const foreign = path.join(ctx.root, `foreign-${b.s.projectId}`);
  fs.mkdirSync(foreign, { recursive: true });
  git(foreign, "init", "-q", "-b", "main");
  for (const n of [1, 2]) { fs.writeFileSync(path.join(foreign, "f.txt"), `${n}\n`); git(foreign, "add", "."); git(foreign, "commit", "-q", "-m", `f${n}`); }
  const f2 = git(foreign, "rev-parse", "HEAD");
  const f1 = git(foreign, "rev-parse", "HEAD~1");
  git(p, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(p, "own.txt"), "own\n");
  git(p, "add", ".");
  git(p, "commit", "-q", "-m", "own");
  fs.writeFileSync(path.join(p, ".git", "objects", "info", "alternates"), `${path.join(foreign, ".git", "objects")}\n`);
  git(p, "update-ref", "refs/heads/extern", f2);
  git(p, "update-ref", "refs/tags/v1", f1);
  mainWithStack(b);
  b.missing = { "refs/heads/extern": f2, "refs/tags/v1": f1 };
}

// (4): no repo; two native services in the main's desired state, one of them crashed. Plus a folder with a `.git` as a FILE (gitfile
// of a linked worktree) — it does not come through the snapshot, the result names it.
function situationServices(b) {
  mainWithStack(b, { services: [1, 2] });
  fs.mkdirSync(path.join(b.s.path, "wt"), { recursive: true });
  fs.writeFileSync(path.join(b.s.path, "wt", ".git"), "gitdir: /nowhere/.git/worktrees/wt\n");
}

// ── The seam ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function writeStorage(root) {
  const cg = path.join(root, "sys", "fs", "cgroup");
  fs.mkdirSync(cg, { recursive: true });
  fs.writeFileSync(path.join(cg, "memory.max"), `${8 * GIB}\n`);
  fs.writeFileSync(path.join(cg, "memory.current"), `${2 * GIB}\n`);
}

// A reader of the global stream (/api/events) — the same form as in stacks-schema.test.js.
async function globalReaderFor(base) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort on close */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}

// After every test: no copy lives any more, none stays working (the instance row made `busy` true).
async function cleanUp() {
  await waitForTruthy(() => (store.liveStackCopies().some((k) => buildAlive(k)) ? null : true), "all builds finished");
  for (const k of store.liveStackCopies()) {
    if (["build", "ready", "clearAway"].includes(k.state)) { try { setCopyState(k.id, "error", { error: "test end" }); } catch { /* already gone */ } }
    store.deleteProjectInstance(k.projectId, copyInstance(k.name));
    try { setCopyState(k.id, "removed"); } catch { /* already gone */ }
  }
  for (const z of store.projectInstances()) if (z.instance !== MAIN) store.deleteProjectInstance(z.projectId, z.instance);
}

// Server, scenario, fake docker with main and situation, the build hook-up with the scenario's seams, the environment (opaque
// program, storage root, HOME) and — by default — the ops marks. `fn({ ctx, b })`.
async function withCreation(situation, fn, { ops = true } = {}) {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const clone = fakeClone(path.join(ctx.root, `klon-${s.projectId}`));
    const fd = await fakeDocker({ programs: { ...s.programs, python3: clone.python3 }, images: { [PROJECTBOX_IMAGE]: ID } });
    const b = { s, clone, fd, main: containerName(s.projectId), copy: containerName(s.projectId, copyInstance("k1")) };
    clone.daemons({ main: stateFile(fd, b.main), copy: stateFile(fd, b.copy) });
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-creation-storage-"));
    writeStorage(storage);
    setCopyProcedure((a) => copyBuild(a, s.opts));
    try {
      await withEnvironment({ CBASE_COPY_OPAQUE_PROGRAM: clone.opaque, CBASE_STORAGE_ROOT: storage, HOME: s.home }, async () => {
        await situation(b, ctx);
        b.start = fd.calls().length;
        return ops ? withOps(fd, () => fn({ ctx, b })) : fn({ ctx, b });
      });
    } finally {
      setCopyProcedure(copyBuild);
      await cleanUp();
      fd.cleanUp();
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
}

let chatSeq = 0;
// Through the queue: request, wake (the waker from server.js — one bundled pass), wait until the build is over.
async function buildCopy(b, { name = "k1", base = null } = {}) {
  const k = copyRequests({ projectId: b.s.projectId, name, chatId: `chat-creation-${++chatSeq}`, base });
  wakeQueue();
  await waitForTruthy(() => {
    const z = store.stackCopy(k.id);
    return ["ready", "error"].includes(z.state) && !buildAlive(z) ? z : null;
  }, `copy ${name} at the end`);
  return store.stackCopy(k.id);
}

const refsOf = (cwd) => git(cwd, "for-each-ref", "--format=%(refname) %(objectname) %(symref)").split("\n").filter(Boolean).sort();
const refsFromSnapshot = (r) => r.refs.filter((x) => x.name !== "refs/stash").map((x) => `${x.name} ${x.oid}${x.symref ? ` ${x.symref}` : " "}`.trimEnd()).sort();
const withoutEmpty = (rows) => rows.map((z) => z.trimEnd());
const copyM = (b) => copyView(b.fd.dir, b.copy).rows.find((z) => z.target === b.s.path).m;

// The seam build -> result: per repo of the snapshot an entry with `head` (only snapshot.json carries it), the refs as a number,
// nothing of the code unknown, `notLinked` as in the snapshot; every service exactly once.
function seam(result, sn) {
  assert.deepEqual(result.unknown.filter((u) => /Code|code snapshot|native services|containers of the copy/.test(u.what)), [], JSON.stringify(result.unknown));
  assert.deepEqual(result.code.repos.map((r) => [r.rel, r.head?.oid ?? null, r.refs]),
    sn.repos.map((r) => [r.rel, r.head.oid ? r.head.oid.slice(0, 12) : null, r.refs.length]), "the code state does not come from snapshot.json");
  assert.ok(result.code.repos.every((r) => r.head !== null), "a repo without head: snapshot.json not read");
  assert.deepEqual(result.notBroughtAlong.notLinked, sn.notLinked);
  // Per kind and name: a container and a native service may have the same name ((4): `worker` both). That a container does NOT
  // appear additionally as "native" is held by the complete lists in (1) and (4).
  const names = result.services.map((d) => `${d.kind}:${d.name}`);
  assert.deepEqual(names, [...new Set(names)], `a service appears twice: ${JSON.stringify(result.services.map((d) => [d.kind, d.name]))}`);
}

// Nothing of the copy is left (dismantling), main runs thawed.
function nothingLeftOver(b, part) {
  const pid = b.s.projectId;
  const z = b.fd.state();
  const inst = copyInstance("k1");
  assert.deepEqual(Object.values(z.container).filter((c) => c.labels?.["cbase.instance"] === inst || c.labels?.["cbase.helper"]).map((c) => c.name), [], `${part}: a container stayed`);
  assert.deepEqual(Object.values(z.networks).filter((n) => n.name === networkName(pid, inst)).map((n) => n.name), [], `${part}: the network stayed`);
  assert.equal(z.volumes[volumeName(pid, inst)], undefined, `${part}: the volume stayed`);
  assert.equal(fs.existsSync(copyLocation({ data: DIRS.data, projectId: pid, name: "k1" }).root.base), false, `${part}: the location stayed`);
  assert.equal(store.projectInstance(pid, inst), null, `${part}: the instance row stayed`);
  assert.equal(copyView(b.fd.dir, b.copy), null, `${part}: the view stayed (container never removed)`);
  assert.equal(Boolean(z.container[b.cid].paused), false, `${part}: main stayed paused`);
  assert.equal(heavyLoadStatus(), null, `${part}: the heavy load stayed taken`);
  // The copy's name (`k1.<main>.cbase`) is no longer in the hosts block — without an instance row it falls out.
  const name = dnsNameOf(pid, inst);
  if (name) assert.deepEqual(hostsRows().filter((z) => z.split(/\s+/).includes(name)), [], `${part}: the name ${name} stayed in the hosts block`);
}
const hostsRows = () => fs.readFileSync(HOSTS_TEST, "latin1").split("\n").map((z) => z.trim()).filter(Boolean);

// ── (1) ──────────────────────────────────────────────────────────────────────────────────────

test("(1) through the queue up to ready: overlays.tsv, refs without stash, project repo, tar and delete list, upper layer, only desired containers, ONE transition with converted_at", async () => {
  await withCreation(situationSuccess, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    const reader = await globalReaderFor(ctx.base);
    try {
      await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the global stream");
      const bar = await ctx.barrier(reader, GLOBAL);
      const k = await buildCopy(b);
      assert.equal(k.state, "ready", `copy ${k.state}: ${k.error}`);

      // overlays.tsv: outer before inner, the object row DIRECTLY behind its repo, `.local` last — the copy's paths.
      const location = copyLocation({ data: DIRS.data, projectId: pid, name: "k1" });
      const runtimeHome = locationFor({ projectId: pid, converted: true }).home;
      const w = (i) => location.inside.work(i);
      assert.deepEqual(fs.readFileSync(location.root.overlays, "utf8").split("\n").filter(Boolean), [
        [b.s.path, `${MAIN_BOTTOM_INSIDE}${b.s.path}`, location.inside.layer("p"), w(0)],
        [path.join(b.s.path, ".git", "objects"), location.inside.objects("p"), location.inside.layerObjects("p"), w(1)],
        [b.app, `${MAIN_BOTTOM_INSIDE}${b.app}`, location.inside.layer("r0"), w(2)],
        [path.join(b.app, ".git", "objects"), location.inside.objects("r0"), location.inside.layerObjects("r0"), w(3)],
        [path.join(b.s.home, ".local"), path.join(runtimeHome, ".local"), location.inside.layer("local"), w(4)],
      ].map((z) => z.join("\t")));
      assert.ok(fs.existsSync(location.root.prepared), "`.prepared` exists");

      // The refs: those of the snapshot without refs/stash, HEAD with symbolic refs.
      const sn = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
      const m = copyM(b);
      const mApp = path.join(m, "app");
      for (const [part, cwd] of [["p", m], ["r0", mApp]]) {
        const r = sn.repos.find((x) => x.part === part);
        assert.deepEqual(withoutEmpty(refsOf(cwd)), refsFromSnapshot(r), `${part}: the copy's refs ≠ snapshot without stash`);
        assert.equal(git(cwd, "symbolic-ref", "HEAD"), r.head.symref, `${part}: HEAD`);
      }
      assert.ok(sn.repos.find((x) => x.part === "r0").refs.some((x) => x.name === "refs/stash"), "the snapshot carries refs/stash (otherwise this checked nothing)");
      assert.equal(git(mApp, "rev-parse", "refs/remotes/origin/HEAD"), git(b.app, "rev-parse", "origin/main"));
      assert.equal(git(mApp, "config", "branch.main.remote"), "origin");
      assert.equal(git(mApp, "config", "remote.origin.url"), git(b.app, "config", "remote.origin.url"));
      assert.equal(fs.readFileSync(path.join(mApp, ".git", "info", "exclude"), "utf8"), "# own rule\n*.log\n");
      // The project repo: marker, identity, hooksPath, gpgsign; the hook 0755.
      for (const [key, value] of PROJECT_REPO_CONFIG) assert.equal(git(m, "config", "--local", key), value, key);
      const hook = path.join(m, PROJECT_REPO_HOOK);
      assert.equal(fs.readFileSync(hook, "utf8"), PRE_COMMIT);
      assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
      // The work: tar (changed, new, in subfolders), delete list, the same `git status` as in main.
      assert.equal(fs.readFileSync(path.join(mApp, "a.txt"), "utf8"), "a.txt\nopen\n");
      assert.equal(fs.existsSync(path.join(mApp, "b.txt")), false, "b.txt (deleted in main) is gone");
      assert.equal(fs.readFileSync(path.join(mApp, "under", "deep.txt"), "utf8"), "deep\n");
      assert.equal(git(mApp, "status", "--porcelain=v1", "--untracked-files=all"), git(b.app, "status", "--porcelain=v1", "--untracked-files=all"));
      assert.equal(git(m, "status", "--porcelain=v1"), "", "the project repo is clean after the commit");
      // WITHOUT base: the open change of the project root came along through "State before copy".
      assert.equal(fs.readFileSync(path.join(m, "note-new.md"), "utf8"), "new\n", "without base note-new.md is missing in the copy");
      // An ignored file of main shows through (accepted, named) — read, never copied up.
      assert.equal(fs.readFileSync(path.join(mApp, "noise.log"), "utf8"), "ignored\n");
      assert.equal(fs.existsSync(path.join(location.root.layer("r0"), "noise.log")), false, "an ignored file does not lie on top");
      // Every versioned file lies in the upper layer; objects/ stayed untouched (the links, never written).
      const deleted = new Set(git(mApp, "ls-files", "--deleted").split("\n").filter(Boolean));
      assert.deepEqual([...deleted], ["b.txt"], "only what the delete list names is deleted");
      for (const f of git(mApp, "ls-files").split("\n").filter((x) => x && !deleted.has(x))) assert.ok(fs.existsSync(path.join(location.root.layer("r0"), f)), `missing on top: ${f}`);
      for (const f of git(m, "ls-files").split("\n").filter(Boolean)) assert.ok(fs.existsSync(path.join(location.root.layer("p"), f)), `missing on top: ${f}`);
      assert.ok(fs.existsSync(path.join(location.root.layer("r0"), ".git", "HEAD")), "the copy's .git lies on top");

      // Only the desired containers run; the stopped `always` stays off and carries its policy again.
      const inside = Object.fromEntries(Object.values(b.fd.state(b.copy).container).map((c) => [c.name, c]));
      assert.deepEqual(Object.keys(inside).filter((n) => inside[n].status === "running").sort(), ["job", "web"]);
      assert.deepEqual([inside["old-db"].status, inside["old-db"].restart], ["exited", "always"], "old-db did not run at freeze time — the copy does not start it");
      assert.deepEqual([inside.upkeep.status, inside.upkeep.restart], ["exited", "unless-stopped"]);
      // The worker (on-failure:3, exit 1) stays off — the restart of the copy's dockerd would start it without the policy
      // protection — and carries its policy again afterwards WITH the count (restartFlag "on-failure:3", not "on-failure").
      assert.deepEqual([inside.worker.status, inside.worker.restart], ["exited", "on-failure:3"], "worker (on-failure:3, exit 1) did not run at freeze time — the copy does not start it");
      const journal = store.stackCopy(k.id).journal.data;
      assert.deepEqual(Object.keys(journal.start.policy).sort(), ["always", "on-failure:3", "unless-stopped"]);
      assert.equal(journal.creation.overlays, 5);
      assert.equal(journal.prepare.step, "prepared");

      // ONE transition to ready — the instance row with converted_at.
      const row = store.projectInstance(pid, inst);
      assert.equal(row.state, "ready");
      assert.ok(row.convertedAt > 0, "converted_at missing");
      // The copy's name is in the hosts block (the creation wrote it; nothingLeftOver checks that the dismantling takes it).
      assert.ok(row.dnsName && hostsRows().some((z) => z.endsWith(` ${row.dnsName}`)), `the name ${row.dnsName} is missing in the hosts block`);
      assert.equal(row.containerId, Object.values(b.fd.state().container).find((c) => c.name === b.copy).id);
      const until = await ctx.barrier(reader, GLOBAL);
      const ev = reader.events.slice(bar, until);
      assert.equal(ev.filter((e) => e.type === "project/instance" && e.instance === inst && e.state === "ready").length, 1, "instance: exactly ONE transition to ready");
      assert.equal(ev.filter((e) => e.type === "project/copy" && e.id === k.id && e.state === "ready").length, 1, "copy: exactly ONE transition to ready");
      // The seam to the result: the result of the real result collection is stored (its content is the business of stacks-result.test.js).
      const result = store.stackCopy(k.id).result;
      assert.equal(result?.name, "k1", "the result is stored");
      assert.equal(result?.branchSpace, "copy/k1/", "the result comes from stacks/result.js, not from a placeholder");
      assert.ok(Array.isArray(result?.code?.repos) && result.code.repos.length > 0, "the build hands the code state into the result");
      // The fields from the REAL build arrive. The code state per repo from snapshot.json (the summary carries no `head` — the build
      // passes `data` through), what did not come along; the services from the start exactly ONCE with their kind — no container a
      // second time as "native" (no native service is registered here).
      seam(result, sn);
      const openCounts = (o) => [o.paths.length, o.erase.length, o.hidden.length, o.hiddenMissing];
      assert.deepEqual(result.code.repos.map((r) => [r.rel, r.state]), sn.repos.map((r) => [r.rel, r.open && openCounts(r.open).some((x) => x !== 0) ? { kind: "open", paths: r.open.paths.length, erase: r.open.erase.length, hidden: r.open.hidden.length, hiddenMissing: r.open.hiddenMissing } : { kind: "clean" }]));
      assert.equal(result.code.repos.find((r) => r.rel === "app").state.kind, "open");
      assert.deepEqual(result.notBroughtAlong.stashes, [{ rel: "app", count: 1 }]);
      assert.deepEqual(result.services.map((d) => `${d.kind}:${d.name}:${d.state}`), [
        "container:job:running", "container:old-db:exited", "container:upkeep:exited", "container:web:running",
        "container:worker:exited", // did not run at freeze time, the copy does not start it
      ]);
      assert.equal(heavyLoadStatus(), null);
      assert.equal(store.projectInstance(pid, MAIN).state, "ready");
      assert.equal(Boolean(b.fd.state().container[b.cid].paused), false, "main runs");
    } finally { await reader.shutdown(); }
  });
});

// ── (2) ──────────────────────────────────────────────────────────────────────

test("(2) base + see-through .gitignore: three delete passes, src/generated/g.js is gone, HEAD on the base", async () => {
  await withCreation(situationBase, async ({ b }) => {
    const k = await buildCopy(b, { base: b.c1 });
    assert.equal(k.state, "ready", `copy ${k.state}: ${k.error}`);
    const m = copyM(b);
    assert.equal(git(m, "rev-parse", "HEAD"), b.c1, "HEAD on the base");
    assert.throws(() => git(m, "symbolic-ref", "-q", "HEAD"), "HEAD is detached");
    for (const f of [".gitignore", "src/.gitignore", "src/a.js", "src/generated/g.js"]) assert.equal(fs.existsSync(path.join(m, f)), false, `${f} still shows through`);
    assert.equal(fs.readFileSync(path.join(m, "README.md"), "utf8"), "one\n");
    assert.equal(git(m, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"), "", "nothing unversioned, nothing ignored");
    const v = store.stackCopy(k.id).journal.data.prepare;
    assert.equal(v.step, "prepared");
    // The whiteouts of the upper layer: each of the four files lay below (in main), so one whiteout per file.
    const location = copyLocation({ data: DIRS.data, projectId: b.s.projectId, name: "k1" });
    for (const f of [".gitignore", "src/.gitignore", "src/a.js", "src/generated/g.js"]) {
      assert.ok(fs.existsSync(path.join(location.root.layer("p"), path.dirname(f), `.wh.${path.basename(f)}`)), `whiteout for ${f} missing`);
    }
    // Three passes (each level hid the next), four files deleted, the base hit — the preparation's journal carries per repo what happened.
    const p = v.result.find((r) => r.part === "p");
    assert.deepEqual([p.base, p.passes, p.deletedAfter, p.tar], [b.c1, 3, 4, false], JSON.stringify(p));
    // The seam: the result names what the preparation resolved — the base applied (a full id no ref points to: guessed through the
    // ref names that would be "null"), and the repo stands detached on it, not on `main`.
    const result = store.stackCopy(k.id).result;
    const sn = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
    assert.deepEqual(result.code.repos.map((r) => [r.rel, r.head, r.state]), [[".", { branch: null, oid: b.c1.slice(0, 12) }, { kind: "base", base: b.c1, applies: true }]]);
    assert.equal(sn.repos[0].head.symref, "refs/heads/main", "the snapshot stood on main (otherwise the detached HEAD checked nothing)");
  });
});

// ── (3) ──────────────────────────────────────────────────────────────────────────────

test("(3) refs to objects only through alternates: COPY_REF_MISSING names both, the dismantling is complete", async () => {
  await withCreation(situationAlternates, async ({ b }) => {
    const k = await buildCopy(b);
    assert.equal(k.state, "error");
    assert.match(k.error, /^prepare: /, k.error);
    for (const [ref, id] of Object.entries(b.missing)) {
      assert.ok(k.error.includes(ref), `${ref} is missing in the reason: ${k.error}`);
      assert.ok(k.error.includes(id.slice(0, 12)), `${id.slice(0, 12)} is missing in the reason: ${k.error}`);
    }
    assert.match(k.error, /\(COPY_REF_MISSING\)/);
    assert.doesNotMatch(k.error, /refs\/heads\/main/, "a valid ref is not a missing one");
    const j = store.stackCopy(k.id).journal.data;
    assert.deepEqual(j.dismantling.rootCause, { step: "prepare", code: "COPY_REF_MISSING" });
    assert.deepEqual(j.dismantling.error, []);
    assert.equal(j.prepare.step, "setUp", "failed at setting up, nothing after");
    // Container and network were there (the creation ran), now nothing is left.
    assert.ok(j.creation.containerId, "the creation ran");
    const rm = b.fd.calls({ daemon: "host" }).slice(b.start).map((a) => a.args).filter((a) => (a[0] === "rm" && a.includes(j.creation.containerId)) || (a[0] === "network" && a[1] === "rm"));
    assert.equal(rm.length, 2, `container and network removed by id: ${JSON.stringify(rm)}`);
    nothingLeftOver(b, "prepare");
  });
});

// ── (4) ───────────────────────────────────────────────────────────────────────────────────────────

test("(4) a crashed native service with desired state \"on\" stays off; a project without a code repo gets its project repo", async () => {
  await withCreation(situationServices, async ({ b }) => {
    // The hook-ups only in the running server (server.js sets the real ones at start).
    const started = [];
    setNativeServicesStatus(async () => [
      { id: 1, name: "api", port: 3000, running: true },
      { id: 2, name: "worker", port: null, running: false },
    ]);
    setNativeServicesStarter(async (pid, ids, opts) => { started.push({ pid, ids, instance: opts?.instance }); return { error: [] }; });
    try {
      const pid = b.s.projectId;
      assert.deepEqual(store.projectInstance(pid, MAIN).desired.services, [1, 2], "both are in the main's desired state (worker crashed)");
      const k = await buildCopy(b);
      assert.equal(k.state, "ready", `copy ${k.state}: ${k.error}`);
      assert.deepEqual(started, [{ pid, ids: ["1"], instance: copyInstance("k1") }], "only the service that ran at freeze time");
      assert.deepEqual(store.projectInstance(pid, copyInstance("k1")).desired.services, [1]);
      assert.deepEqual(store.stackCopy(k.id).journal.data.freeze.services.map((d) => [d.id, d.running]), [[1, true], [2, false]]);
      // Without a code repo and without a project repo: it arose at freeze time — the project folder, its objects and ~/.local,
      // nothing else; only the project repo was prepared.
      assert.equal(store.stackCopy(k.id).journal.data.freeze.projectRepo.created, true);
      const location = copyLocation({ data: DIRS.data, projectId: pid, name: "k1" });
      assert.deepEqual(fs.readFileSync(location.root.overlays, "utf8").split("\n").filter(Boolean).map((z) => z.split("\t")[0]), [b.s.path, path.join(b.s.path, ".git", "objects"), path.join(b.s.home, ".local")]);
      assert.deepEqual(store.stackCopy(k.id).journal.data.prepare.result.map((r) => [r.part, r.rel]), [["p", "."]]);
      // The seam: the native services from the start with their state, the containers ONCE each with their kind — none a second time
      // as "native"; the gitfile stands under notLinked.
      const result = store.stackCopy(k.id).result;
      const sn = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
      assert.deepEqual(sn.notLinked, [{ rel: "wt", reason: "gitfile" }], "the snapshot names the gitfile (otherwise this checked nothing)");
      seam(result, sn);
      assert.deepEqual(result.services.map((d) => `${d.kind}:${d.name}:${d.state}:${d.ports.join(",")}`), [
        "container:job:running:", "container:old-db:exited:", "container:upkeep:exited:", "container:web:running:",
        "container:worker:exited:", "native:api:running:3000", "native:worker:off:",
      ]);
    } finally {
      setNativeServicesStatus(nativeServicesStatus);
      setNativeServicesStarter(startDesiredServices);
    }
  });
});

// ── (5) ─────────────────────────────────────────────────────────────────────────────────

test("(5) without ops marks no docker: the build ends in error NO_OPS without an instance row; the dismantling names what stayed", async () => {
  await withCreation(situationServices, async ({ b }) => withEnvironment({ CBASE_DOCKER_BIN: b.fd.bin }, async () => {
    // The fake docker is the binary, only the marks are missing: a call past the guards would appear in the log.
    const pid = b.s.projectId;
    const k = await buildCopy(b);
    assert.equal(k.state, "error");
    assert.match(k.error, /NO_OPS/);
    assert.equal(store.projectInstance(pid, copyInstance("k1")), null, "the head's instance row is gone");
    assert.deepEqual(b.fd.calls().slice(b.start), [], "no docker call");
    assert.deepEqual(b.clone.calls(), []);

    // The dismantling without marks: the journal says location and volume are created — it calls no docker and throws with the sentence.
    const k2 = copyRequests({ projectId: pid, name: "k2", chatId: "chat-creation-g1" });
    setCopyState(k2.id, "build", { phase: "clone1" });
    const journal = copyJournal(k2.id);
    await journal.note({ freeze: { location: true, volume: true, helperId: null } });
    let thrown = null;
    try { await dismantleCopy({ copy: store.stackCopy(k2.id), instance: copyInstance("k2"), journal, reason: "probe" }); } catch (e) { thrown = e; }
    assert.ok(thrown, "the dismantling did not throw");
    assert.equal(thrown.code, "COPY_DISMANTLING");
    assert.match(thrown.message, /ohne Betriebsmarke kein docker — stehen geblieben: Helfer\/Volume\/Ort des Einfrierens/);
    assert.equal(store.projectInstance(pid, copyInstance("k2"))?.state, "create", "the row stays as long as something stayed");
    assert.deepEqual(b.fd.calls().slice(b.start), [], "no docker call in the dismantling");
  }), { ops: false });
});

// ── (6) ──────────────────────────────────────────────────────────────────────────────

test("(6) queue: a leftover instance row => error INSTANCE_CONFLICT with a hint, no start per pass", async () => {
  await withCreation(situationServices, async ({ b }) => {
    const pid = b.s.projectId;
    store.createProjectInstance({ projectId: pid, instance: copyInstance("k1"), state: "error", error: "leftover from before" });
    const chatId = "chat-creation-rest";
    const k = copyRequests({ projectId: pid, name: "k1", chatId });
    // The pass runs bundled in the next microtick, the start step inside it synchronously: a few micro steps afterwards the verdict
    // stands. COUNTED, not waited for: the old state spun an endless microtask chain here (setter throws -> heavy load free -> waker
    // -> pass -> …) in which no setImmediate and no clock got a turn — waiting for the event would have been a hang, not a red. The
    // `finally` ends the chain SYNCHRONOUSLY.
    wakeQueue();
    try {
      await microUntil(() => store.stackCopy(k.id).state !== "waiting_queue");
      const z = store.stackCopy(k.id);
      assert.equal(z.state, "error", `after the pass ${z.state} (${z.reason})`);
      assert.match(z.error, /^Start gescheitert: .*steht schon da .*\(INSTANCE_CONFLICT\)$/, z.error);
    } finally {
      if (store.STACK_COPY_WAITING.includes(store.stackCopy(k.id)?.state)) setCopyState(k.id, "error", { error: "test end" });
    }
    await micro();
    const hints = store.openHints(chatId).filter((h) => h.source === "stack-copy");
    assert.equal(hints.length, 1);
    assert.match(hints[0].text, /entstand nicht: Start gescheitert/);
    assert.equal(store.projectInstance(pid, copyInstance("k1")).error, "leftover from before", "the leftover stays as it is");
    assert.deepEqual(postponedStarts(), []);
    // Another pass starts nothing (the row is in error, no longer in the queue).
    wakeQueue();
    await micro();
    assert.equal(store.stackCopy(k.id).state, "error");
    assert.deepEqual(b.clone.calls(), [], "no freezing began");
    assert.equal(heavyLoadStatus(), null);
  });
});

// ── (7) ────────────────────────────────────────────────────────────────────────

// Comments out, lines stay (copy from stacks-schema.test.js — a .test.js never imports another). Strings with ' and " end at the
// line at the latest; templates and block comments may span lines.
function withoutComments(text) {
  let out = "";
  let state = "code";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "row"; i++; continue; }
      if (c === "/" && n === "*") { state = "block"; i++; continue; }
      if (c === "\"" || c === "'" || c === "`") state = c;
      out += c;
    } else if (state === "row") {
      if (c === "\n") { state = "code"; out += c; }
    } else if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i++; } else if (c === "\n") out += c;
    } else {
      if (c === "\\") { out += c + (n ?? ""); i++; continue; }
      if (c === state || (c === "\n" && state !== "`")) state = "code";
      out += c;
    }
  }
  return out;
}

// The writing calls of node:fs (including promises), as a method or as a named import.
const WRITING = ["writeFile", "appendFile", "mkdir", "mkdtemp", "link", "symlink", "copyFile", "cp", "rm", "rmdir", "rename", "unlink",
  "chmod", "fchmod", "lchmod", "chown", "fchown", "lchown", "truncate", "ftruncate", "utimes", "futimes", "lutimes", "createWriteStream",
  "write", "writev", "open", "opendir"];
const WRITE_RE = new RegExp(`\\b(?:fs|fsp|promises)\\s*\\.\\s*(?:promises\\s*\\.\\s*)?(${WRITING.join("|")})(?:Sync)?\\s*\\(`, "g");
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']node:fs(?:\/promises)?["']/g;
// Where B may write under stacks/: the location of the layers, objects and work folders. The clear-away path writes only through
// the helpers of objects.js (return-path empty repos, backup folder) — so an fs call in fetch.js, clearAway.js, returnPath.js or
// project-repo-copy.js turns red.
const WRITE_LOCATIONS = new Set(["objects.js"]);
/** Every other place, named: file, count, reason — and its arguments mention neither layer nor objects nor work(. */
const WRITE_EXCEPTIONS = [
  { file: "freeze.js", count: 1, reason: "the main's runtime folder `processes` before the clone helper (the shell creates no folders) — not under the copy" },
  { file: "code-snapshot.js", count: 1, reason: "snapshot.json (0600, `wx`) in the root of the copy — next to the layers, never in them" },
  { file: "prepare.js", count: 1, reason: "the marker `.prepared` (0644, `wx`) in the root of the copy — the entrypoint waits for it" },
];
const FORBIDDEN_IN_ARGUMENT = /layer|[Oo]bjects|\bwork\s*\(/;

function argumentFrom(code, i) {
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === "(") depth++;
    else if (code[j] === ")" && --depth === 0) return code.slice(i + 1, j);
  }
  return code.slice(i + 1);
}

function writeViolations(files, exceptions = WRITE_EXCEPTIONS) {
  const v = [];
  const list = new Map(exceptions.map((e) => [e.file, e]));
  const seen = new Set();
  for (const [file, text] of Object.entries(files)) {
    if (WRITE_LOCATIONS.has(file)) continue;
    const code = withoutComments(text);
    for (const m of code.matchAll(IMPORT_RE)) {
      const names = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].replace(/Sync$/, "")).filter((x) => WRITING.includes(x));
      if (names.length) v.push(`${file}: imports ${names.join(", ")} from node:fs — past the count`);
    }
    const hits = [...code.matchAll(WRITE_RE)];
    if (!hits.length) continue;
    const e = list.get(file);
    seen.add(file);
    if (!e) { v.push(`${file}: ${hits.length} writing fs call(s) (${hits.map((t) => t[1]).join(", ")}) — only in ${[...WRITE_LOCATIONS].join("/")} or named`); continue; }
    if (hits.length !== e.count) v.push(`${file}: ${hits.length} writing fs calls instead of ${e.count} (${e.reason})`);
    for (const t of hits) {
      const arg = argumentFrom(code, t.index + t[0].length - 1);
      if (FORBIDDEN_IN_ARGUMENT.test(arg)) v.push(`${file}: ${t[1]}(${arg.slice(0, 80)}) writes under layer/objects/work — that belongs in objects.js`);
    }
  }
  for (const e of exceptions) if (!seen.has(e.file)) v.push(`exception without a hit: ${e.file} — removed? Then remove the entry`);
  return v;
}

const stacksFiles = () => Object.fromEntries(fs.readdirSync(path.join(SERVER, "stacks")).filter((n) => n.endsWith(".js")).sort().map((n) => [n, fs.readFileSync(path.join(SERVER, "stacks", n), "utf8")]));

test("(7) path guard: under stacks/ B writes only in objects.js — every other place named, never under layer/objects/work; with built-in sabotage", () => {
  const real = stacksFiles();
  for (const e of WRITE_EXCEPTIONS) console.log(`[stacks-write] exception ${e.file} (${e.count}×): ${e.reason}`);
  console.log(`[stacks-write] measured over ${Object.keys(real).length} files; write locations ${[...WRITE_LOCATIONS].join(", ")}`);
  assert.ok(withoutComments(real["objects.js"]).match(WRITE_RE)?.length > 0, "objects.js does not write — the guard searches wrongly");
  assert.deepEqual(writeViolations(real), []);

  // Sabotage: every rule red once, a comment not.
  const including = (file, addition) => ({ ...real, [file]: `${real[file]}\n${addition}\n` });
  const cases = [
    ["start.js", "fs.mkdirSync(location.root.base);", /^start\.js: 1 writing/],
    ["prepare.js", 'fs.writeFileSync(path.join(location.root.layer("p"), "x"), "");', /^prepare\.js: 2 writing/],
    ["prepare.js", "await fsp.rm(location.root.base, { recursive: true });", /^prepare\.js: 2 writing/],
    ["queue.js", 'import { rmSync } from "node:fs";', /^queue\.js: imports rm from node:fs/],
    ["build.js", "fs.promises.writeFile(file, text);", /^build\.js: 1 writing/],
  ];
  for (const [file, addition, pattern] of cases) {
    const v = writeViolations(including(file, addition));
    assert.ok(v.some((x) => pattern.test(x)), `not recognized: ${addition}\n${v.join("\n")}`);
  }
  const under = writeViolations({ ...real, "prepare.js": real["prepare.js"].replace("fs.writeFileSync(location.root.prepared,", "fs.writeFileSync(location.root.layer(\"p\"),") });
  assert.ok(under.some((x) => /writes under layer\/objects\/work/.test(x)), `a path under layer/ with the same count not recognized:\n${under.join("\n")}`);
  assert.deepEqual(writeViolations(including("start.js", "// fs.writeFileSync(x)\n/* fs.rmSync(y) */")), [], "a comment is not a call");
  assert.ok(writeViolations(real, WRITE_EXCEPTIONS.slice(1)).some((x) => /^freeze\.js: 1 writing/.test(x)), "a removed exception is red");
  assert.ok(writeViolations(real, [...WRITE_EXCEPTIONS, { file: "start.js", count: 1, reason: "probe" }]).some((x) => /^exception without a hit: start\.js/.test(x)), "an exception without a place is red");
});

test("(7b) the fake docker's copy view speaks the product's literals (entrypoint, location, status file)", () => {
  assert.deepEqual(COPY_VIEW, {
    root: COPY_ROOT_INSIDE, main: MAIN_BOTTOM_INSIDE, overlays: OVERLAYS_FILE, prepared: PREPARED_FILE,
    status: STATUS_FILE, cgroup: CGROUP_CONTROL,
  });
});

// ── (8) ────────────────────────────────────────

// The build with a seam at the journal: on entering the step `step`, `prior()` runs — the same journal object, only `step` wrapped
// (projectbox/journal.js createJournal returns a plain object).
function buildWithSeam(b, step, prior) {
  setCopyProcedure((a) => copyBuild({ ...a, journal: { ...a.journal, step: (name, fn, o) => {
    if (name === step) prior();
    return a.journal.step(name, fn, o);
  } } }, b.s.opts));
}

test("(8) if the instance row is no longer in `create` before `ready`, the copy does not become ready — dismantling, error, no transition, no converted_at", async () => {
  await withCreation(situationServices, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    // Another path sets the instance row to `error` between `start` and `ready`.
    buildWithSeam(b, "ready", () => setInstanceState(pid, inst, "error", { error: "probe: another path" }));
    const reader = await globalReaderFor(ctx.base);
    try {
      await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the global stream");
      const bar = await ctx.barrier(reader, GLOBAL);
      const k = await buildCopy(b);
      assert.equal(k.state, "error", `the copy became "${k.state}" above an instance row in error`);
      assert.match(k.error, /^ready: Instance .*“ready” only from “create” — the row is in “error”, nothing changed \(INSTANCE_STATE\)$/, k.error);
      const until = await ctx.barrier(reader, GLOBAL);
      const ready = reader.events.slice(bar, until).filter((e) => e.state === "ready" && ((e.type === "project/instance" && e.instance === inst) || (e.type === "project/copy" && e.id === k.id)));
      assert.deepEqual(ready, [], "a transition to ready");
      assert.deepEqual(store.stackCopy(k.id).journal.data.dismantling.rootCause, { step: "ready", code: "INSTANCE_STATE" });
      nothingLeftOver(b, "ready"); // including the instance row: no converted_at on a broken instance
    } finally { await reader.shutdown(); }
  });
});

// ── (9)/(10) ───────────────────────────────────────────────────
// In the product the marker "server ends" is set by the server-end routine (and the stop chain stops the copy container); here the
// test seam sets it on entering a step — the step then fails for its own reason (COPY_REF_MISSING or the lock of freezing), as it
// would fail at a stopped container.

test("(9) server end in `prepare` => the copy stays in build (no dismantling, no error); the next process's restart grace dismantles, old place", async () => {
  await withCreation(situationAlternates, async ({ b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    buildWithSeam(b, "prepare", () => serverEndMarkerForTest(true));
    try {
      const k = copyRequests({ projectId: pid, name: "k1", chatId: `chat-creation-${++chatSeq}` });
      wakeQueue();
      const z = await waitForTruthy(() => {
        const x = store.stackCopy(k.id);
        return x.state !== "waiting_queue" && !buildAlive(x) ? x : null;
      }, "build finished");
      assert.deepEqual([z.state, z.phase, z.error], ["build", "prepare", ""], `in the ending process "${z.state}": ${z.error}`);
      assert.equal(store.projectInstance(pid, inst)?.state, "create", "the instance row fell in the ending process");
      assert.equal(store.stackCopy(k.id).journal.data.dismantling, undefined, "a dismantling next to the stop chain");
      assert.equal(heavyLoadStatus(), null);

      // The next process (server.js): marker gone, the hook "project-instances", then the restart grace of the copies — without
      // the procedure hook-up, so the postponed copy does not build again at once.
      setCopyProcedure(null);
      serverEndMarkerForTest(false);
      instancesRestartGrace();
      assert.equal(store.projectInstance(pid, inst)?.state, "error");
      assert.equal(copiesRestartGrace(), 1);
      const w = await waitForTruthy(() => {
        const x = store.stackCopy(k.id);
        return x.state !== "build" ? x : null;
      }, "restart dismantling finished");
      assert.equal(w.state, "waiting_queue", `after the restart "${w.state}": ${w.error}`);
      assert.equal(w.requestedAt, k.requestedAt, "the old place");
      assert.match(w.reason, /Neustart des Servers mitten im Aufbau \(Phase „prepare“\) — zurückgebaut, wieder in der Reihe/);
      assert.equal(store.stackCopy(k.id).journal.data.dismantling.reason, "restart");
      nothingLeftOver(b, "restart");
      setCopyState(k.id, "removed");
    } finally { serverEndMarkerForTest(false); }
  });
});

test("(10) server end in freezing (barrier at the lock) => after its dismantling back into the queue at the old place, not error; no new start in the ending process", async () => {
  await withCreation(situationServices, async ({ b }) => {
    const pid = b.s.projectId;
    buildWithSeam(b, "freeze", () => serverEndMarkerForTest(true));
    // The number of builds = the number of phase-1 clones (freezing ends here at the lock, before phase 2). A second one ends the
    // waiting AT ONCE (otherwise without this guard the queue would spin build after build in the microtick — a hang, not a red).
    const builds = () => b.clone.calls().filter((a) => a[1] === "copy").length;
    try {
      const k = copyRequests({ projectId: pid, name: "k1", chatId: `chat-creation-${++chatSeq}` });
      wakeQueue();
      const z = await waitForTruthy(() => {
        const x = store.stackCopy(k.id);
        if (builds() > 1) return x;
        return !buildAlive(x) && (x.state === "error" || (x.state === "waiting_queue" && x.reason)) ? x : null;
      }, "build finished");
      assert.equal(builds(), 1, "a second build in the ending process");
      assert.equal(z.state, "waiting_queue", `in the ending process "${z.state}": ${z.error}`);
      assert.equal(z.requestedAt, k.requestedAt, "the old place");
      assert.equal(z.reason, "Serverende mitten im Aufbau (freeze) — zurückgebaut, wieder in der Reihe (alter Platz)");
      assert.equal(z.error, "");
      nothingLeftOver(b, "freeze");
      // A waker in the ending process does not restart it.
      wakeQueue();
      await micro();
      const n = store.stackCopy(k.id);
      assert.deepEqual([n.state, buildAlive(n), builds()], ["waiting_queue", false, 1], "a new build in the ending process");
      setCopyProcedure(null);
      setCopyState(k.id, "removed");
    } finally { serverEndMarkerForTest(false); }
  });
});

// ── (11) ────────────────────────────────────────────────────────────────────────────

test("(11) restartFlag: RestartPolicy (as cbase-clone prints it, or the name) → `--restart`; on-failure with count; unreadable null", () => {
  assert.equal(restartFlag({ Name: "on-failure", MaximumRetryCount: 3 }), "on-failure:3");
  assert.equal(restartFlag({ Name: "on-failure", MaximumRetryCount: 0 }), "on-failure");
  assert.equal(restartFlag("on-failure"), "on-failure");
  assert.equal(restartFlag({ Name: "always", MaximumRetryCount: 0 }), "always");
  assert.equal(restartFlag("unless-stopped"), "unless-stopped");
  assert.equal(restartFlag({ Name: "", MaximumRetryCount: 0 }), "no");
  assert.equal(restartFlag("no"), "no");
  for (const x of [null, undefined, {}, { Name: "on-failure:3" }, "sometimes", 42]) assert.equal(restartFlag(x), null, JSON.stringify(x));
});

// ── (12) ─────────────────────────────────────────────────────────

// The project folder is itself a code repo with a linked, NOT ignored worktree `wt` (with an unversioned file in it) and the code
// repo `app`; in `app` an embedded repo `sub`, a submodule `lib/ext`, an ignored worktree `.worktrees/x` and `cfg.txt`
// (assume-unchanged, changed) with `way.txt` (assume-unchanged, deleted). The worktrees' gitfiles point RELATIVELY to their gitdir:
// the fake runs the copy locally, an absolute gitdir would point into the real main there — in the real copy it points to the
// copy's `.git`, where it is missing, and the gitfile is invalid as here.
function situationRepoInRepo(b, ctx) {
  const p = b.s.path;
  const outside = path.join(ctx.root, `outside-${b.s.projectId}`);
  fs.mkdirSync(outside, { recursive: true });
  const relative = (wt, gitdir) => fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.relative(wt, gitdir)}\n`);
  git(p, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(p, "README.md"), "p\n");
  git(p, "add", "README.md");
  git(p, "commit", "-q", "-m", "p");
  git(p, "worktree", "add", "-q", path.join(p, "wt"), "-b", "wtbranch");
  relative(path.join(p, "wt"), path.join(p, ".git", "worktrees", "wt"));
  fs.writeFileSync(path.join(p, "wt", "only-in-wt.txt"), "wt\n");
  const qExt = path.join(outside, "source-ext");
  fs.mkdirSync(qExt);
  git(qExt, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(qExt, "e.txt"), "e\n");
  git(qExt, "add", ".");
  git(qExt, "commit", "-q", "-m", "e");
  const app = path.join(p, "app");
  fs.mkdirSync(app);
  git(app, "init", "-q", "-b", "main");
  for (const f of ["cfg.txt", "way.txt"]) fs.writeFileSync(path.join(app, f), `${f}\n`);
  fs.writeFileSync(path.join(app, ".gitignore"), ".worktrees/\n");
  git(app, "add", ".");
  git(app, "commit", "-q", "-m", "a");
  git(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", qExt, "lib/ext");
  git(app, "commit", "-q", "-m", "sub");
  const sub = path.join(app, "sub");
  fs.mkdirSync(sub);
  git(sub, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
  git(sub, "add", ".");
  git(sub, "commit", "-q", "-m", "s");
  git(app, "worktree", "add", "-q", path.join(app, ".worktrees", "x"), "-b", "x");
  relative(path.join(app, ".worktrees", "x"), path.join(app, ".git", "worktrees", "x"));
  git(app, "update-index", "--assume-unchanged", "cfg.txt", "way.txt");
  fs.writeFileSync(path.join(app, "cfg.txt"), "hidden changed\n");
  fs.rmSync(path.join(app, "way.txt"));
  mainWithStack(b);
  b.app = app;
}

test("(12) repos in repos: code repo as project folder with worktree, embedded repo, submodule and hidden changes => ready, nothing deleted, the result names them", async () => {
  await withCreation(situationRepoInRepo, async ({ b }) => {
    const k = await buildCopy(b);
    assert.equal(k.state, "ready", `copy ${k.state}: ${k.error}`);
    const m = copyM(b);
    // The worktrees and repos in repos: there, with the state of main — the delete passes left them out (in the copy the gitfile of
    // `wt` is invalid, git would list its files one by one as unversioned).
    assert.throws(() => git(path.join(m, "wt"), "rev-parse", "--git-dir"), "the gitfile of wt is invalid in the copy (otherwise this checked nothing)");
    for (const f of ["wt/README.md", "wt/only-in-wt.txt", "app/sub/s.txt", "app/lib/ext/e.txt", "app/.worktrees/x/cfg.txt"]) {
      assert.ok(fs.existsSync(path.join(m, f)), `${f} is missing in the copy`);
    }
    // The changed assume-unchanged file with the content of main, the deleted one gone.
    assert.equal(fs.readFileSync(path.join(m, "app", "cfg.txt"), "utf8"), "hidden changed\n");
    assert.equal(fs.existsSync(path.join(m, "app", "way.txt")), false, "way.txt (deleted in main, assume-unchanged) is gone");
    // The result names what did not come through the snapshot (display: stacks/result.js).
    const nm = store.stackCopy(k.id).result.notBroughtAlong;
    assert.deepEqual(nm.notLinked, [
      { rel: "wt", reason: "gitfile" }, { rel: "app/sub", reason: "embedded" },
      { rel: "app/lib/ext", reason: "submodule" }, { rel: "app/.worktrees/x", reason: "worktree" },
    ]);
    assert.ok(store.stackCopy(k.id).result.hints.some((h) => h.includes("app/lib/ext (submodule)") && h.includes("app/.worktrees/x (worktree)")));
  });
});

// ── (13) ─────────────────────────────────────────────────────────
// If the copy container crashes while booting and the daemon restarts it (a fresh inner dockerd), its inside is the crash, not the
// intent: stacks/start.js checkLiveness throws, the copy ends in `error` (dismantling) — no desired state from the crash, no `ready`.
test("(13) crash with restart of the copy container while booting => no desired state from the fresh dockerd, the copy ends in error, the dismantling is complete", async () => {
  await withCreation(situationServices, async ({ b }) => {
    setNativeServicesStatus(async () => [{ id: 1, name: "api", port: 3000, running: true }, { id: 2, name: "worker", port: null, running: false }]);
    let calls = 0;
    setNativeServicesStarter(async () => {
      calls += 1;
      if (calls === 1) b.fd.crash(b.copy, { restart: true }); // in the middle of the copy's start sequence (phase "services")
      return { error: [] };
    });
    try {
      const k = await buildCopy(b);
      assert.equal(calls, 1, "the copy's start sequence did not reach the starter (otherwise this checked nothing)");
      assert.equal(k.state, "error", `the copy became "${k.state}" with a desired state from the fresh dockerd`);
      assert.match(k.error, /^start: .*restarted or stood still during the start sequence/, k.error);
      nothingLeftOver(b, "start");
    } finally {
      setNativeServicesStatus(nativeServicesStatus);
      setNativeServicesStarter(startDesiredServices);
    }
  });
});

// ── (14)/(15) ───────────────────────────────────────────────────────────────
// (9)/(10) set only the MARKER on entering a step. Here the real stop chain runs — like the server-end routine without close and
// exit: the marker, then `fireHooks("serverEnd")` with all consumers from server.js (git jobs, projectbox: thawing next to the
// snapshot, then `docker stop -t 30`, project restart grace) — once while main is FROZEN for phase 2 of the clone, once in the middle
// of the copy's start sequence. Afterwards the next process, replayed in the process in the order of server.js: earmarking before
// listening, "project-thaw", "project-restore", "project-instances", then copiesRestartGrace (without the procedure hook-up, so the
// copy does not build again at once). A server as a PROCESS (withAgentsServer { childProcess: true }) would not carry the build's seams over
// (scenario options, storage root, clone fake, store seed) — the module state that does not survive a real restart (the set
// `frozen`) is empty here through the chain's thawing; the test checks that explicitly instead of presuming it.
const situationPlain = (b) => mainWithStack(b);

// Without the recreation hook-up: the main of this file is created by hand (mainWithStack, without the label `cbase.mounts.v2`), and
// its "restart" check would otherwise recreate it — a matter of the situation, not of the chain.
async function nextProcess() {
  setCopyProcedure(null);
  serverEndMarkerForTest(false);
  setRecreateRestartGrace(null);
  try {
    assert.ok(earmarkRestore() >= 1, "main was not earmarked before listening");
    await thawRestartGrace();
    const again = restoreRestartGrace();
    instancesRestartGrace();
    await again;
    copiesRestartGrace();
  } finally { setRecreateRestartGrace(recreateRestartGraceSeam); }
}

function mainRunning(b, part) {
  const pid = b.s.projectId;
  const h = b.fd.state().container[b.cid];
  assert.deepEqual([h.status, Boolean(h.paused)], ["running", false], `${part}: main does not run`);
  const row = store.projectInstance(pid, MAIN);
  assert.deepEqual([row.state, row.error], ["ready", ""], `${part}: main is in "${row.state}": ${row.error}`);
}

test("(14) server end in freezing (main paused) => thawed and stopped in order, its desired state not from the pause; restart: main runs, the copy waits at the old place, no error", async () => {
  await withCreation(situationPlain, async ({ b }) => {
    const pid = b.s.projectId;
    const desiredPrior = store.projectInstance(pid, MAIN).desired;
    b.clone.gate.release();
    try {
      await withEnvironment({ CBASE_NETWORK_ROOT: b.s.root, CBASE_SNAPSHOT_MS: "3600000" }, async () => {
        const k = copyRequests({ projectId: pid, name: "k1", chatId: `chat-creation-${++chatSeq}` });
        wakeQueue();
        await waitForTruthy(() => (b.clone.gate.waiting() ? true : null), "clone phase 2 at the gate");
        assert.equal(Boolean(b.fd.state().container[b.cid].paused), true, "main is not paused in phase 2 (otherwise this checked nothing)");
        assert.equal(isFrozen(b.main), true);

        serverEndMarkerForTest(true);
        await fireHooks("serverEnd", {});
        const h = b.fd.state().container[b.cid];
        assert.deepEqual([h.status, h.exitCode], ["exited", 143], "main ended hard (137): not thawed before the stop, TERM did not reach the frozen dockerd");
        assert.equal(isFrozen(b.main), false, "the set `frozen` still holds main (a real restart would have it empty)");
        assert.deepEqual(store.projectInstance(pid, MAIN).desired, desiredPrior, "the main's desired state was written from the pause");

        b.clone.gate.on();
        const z = await waitForTruthy(() => { const x = store.stackCopy(k.id); return buildAlive(x) ? null : x; }, "build in the ending process finished");
        assert.notEqual(z.state, "error", `in the ending process "error": ${z.error}`);

        await nextProcess();
        const w = await waitForTruthy(() => { const x = store.stackCopy(k.id); return x.state !== "build" && !buildAlive(x) ? x : null; }, "restart finished");
        assert.deepEqual([w.state, w.error], ["waiting_queue", ""], `after the restart "${w.state}": ${w.error}`);
        assert.equal(w.requestedAt, k.requestedAt, "the old place");
        mainRunning(b, "restart");
        nothingLeftOver(b, "restart");
        setCopyState(k.id, "removed");
      });
    } finally {
      b.clone.gate.on();
      serverEndMarkerForTest(false);
    }
  });
});

test("(15) server end in the copy's start sequence => no error, no dismantling next to the stop chain; restart: main runs, the copy waits at the old place", async () => {
  await withCreation(situationPlain, async ({ b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    setNativeServicesStatus(async () => [{ id: 1, name: "api", port: 3000, running: true }]);
    let inTheStartSequence = 0;
    setNativeServicesStarter(async (_pid, _ids, { instance } = {}) => {
      if (instance === inst) {
        inTheStartSequence += 1;
        if (inTheStartSequence === 1) {
          serverEndMarkerForTest(true);
          await fireHooks("serverEnd", {});
        }
      }
      return { error: [] };
    });
    try {
      await withEnvironment({ CBASE_NETWORK_ROOT: b.s.root, CBASE_SNAPSHOT_MS: "3600000" }, async () => {
        const k = copyRequests({ projectId: pid, name: "k1", chatId: `chat-creation-${++chatSeq}` });
        wakeQueue();
        const z = await waitForTruthy(() => {
          const x = store.stackCopy(k.id);
          return inTheStartSequence && !buildAlive(x) ? x : null;
        }, "build in the ending process finished");
        assert.equal(inTheStartSequence, 1, "the copy's start sequence did not reach the starter (otherwise this checked nothing)");
        assert.deepEqual([z.state, z.error], ["build", ""], `in the ending process "${z.state}": ${z.error}`);
        assert.equal(store.stackCopy(k.id).journal.data.dismantling, undefined, "a dismantling next to the stop chain");
        const h = b.fd.state().container[b.cid];
        assert.deepEqual([h.status, h.exitCode], ["exited", 143], "main was not stopped in order");

        await nextProcess();
        const w = await waitForTruthy(() => { const x = store.stackCopy(k.id); return x.state !== "build" && !buildAlive(x) ? x : null; }, "restart finished");
        assert.deepEqual([w.state, w.error], ["waiting_queue", ""], `after the restart "${w.state}": ${w.error}`);
        assert.equal(w.requestedAt, k.requestedAt, "the old place");
        assert.match(w.reason, /Neustart des Servers mitten im Aufbau \(Phase „start“\)/);
        mainRunning(b, "restart");
        nothingLeftOver(b, "restart");
        setCopyState(k.id, "removed");
      });
    } finally {
      serverEndMarkerForTest(false);
      setNativeServicesStatus(nativeServicesStatus);
      setNativeServicesStarter(startDesiredServices);
    }
  });
});

// ── (16) ─────────────────────────────────────────────────────────────────────────────────
// If a step fails after freezing while the server still runs, build.js dismantles in its failure handler and then sets `error` — if
// the server end begins DURING this dismantling (the seam sets the marker on entering the step "dismantling"), nobody puts the copy
// back. The copy transition used to suppress EVERY error wake call at server end, catching up only on the freeze path: the copy
// stood still at `error`, the chat waited for the promised wake call. Now only the setter that announces the way back holds it
// (freeze.js, `returnPathAtServerEnd`).
test("(16) if the server end begins during the dismantling after a failed step, the error wake call still goes out — queued, with marker", async () => {
  await withCreation(situationAlternates, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const chatId = ctx.chat.id;
    const queued = () => store.listRunInputs().filter((r) => r.chatId === chatId).flatMap((r) => r.entries);
    // The chat in the project: then the start lock of the server end holds the wake call in its queue instead of starting a turn —
    // as in the product, where the copy's chat stands in its project.
    const p = await fetch(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ projectId: pid }) });
    assert.equal(p.status, 200, await p.text());
    buildWithSeam(b, "dismantling", () => serverEndMarkerForTest(true));
    try {
      const k = copyRequests({ projectId: pid, name: "k1", chatId });
      wakeQueue();
      const z = await waitForTruthy(() => {
        const x = store.stackCopy(k.id);
        return x.state !== "waiting_queue" && !buildAlive(x) ? x : null;
      }, "build finished");
      assert.equal(z.state, "error", `after the dismantling at server end "${z.state}"`);
      assert.match(z.error, /^prepare: .*\(COPY_REF_MISSING\)/, z.error);
      assert.equal(queued().filter((e) => /NOT built/.test(String(e.prompt))).length, 1,
        "the copy finally stands at error, and the chat never learns of it (no wake call, not even queued)");
      assert.equal(store.stackCopy(k.id).journal?.data?.inset?.wakeCall?.state, "error", "the wake call's marker is missing");
      // The announcement has exactly ONE setter — freezing (afterwards build.js backAfterServerEnd decides).
      const advanceNotifier = [];
      const run = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (e.name !== "node_modules") run(p); continue; }
          if (e.name.endsWith(".js") && fs.readFileSync(p, "latin1").includes("returnPathAtServerEnd: true")) advanceNotifier.push(path.relative(SERVER, p));
        }
      };
      run(SERVER);
      assert.deepEqual(advanceNotifier, ["stacks/freeze.js"], "another setter holds the error wake call at server end");
    } finally {
      // First empty the chat's queue, then the marker: without the marker the queued system message would start a turn.
      pendingRunInputs.delete(chatId);
      store.clearRunInputs(chatId);
      serverEndMarkerForTest(false);
    }
  });
});

// ── (17)–(19) ────────────────────────

// The situation of (1) (project repo with `app`), plus open changes of the PROJECT ROOT: `note-new.md` (new, from situationSuccess)
// and `notes.md` changed. `b.before` = the HEAD of the project repo before, `b.appMain`/`b.appFeature` the branches of app.
async function situationRootOpen(b, ctx) {
  await situationSuccess(b, ctx);
  fs.appendFileSync(path.join(b.s.path, "notes.md"), "changed\n");
  b.before = git(b.s.path, "rev-parse", "HEAD");
  b.appMain = git(b.app, "rev-parse", "main");
  b.appFeature = git(b.app, "rev-parse", "feature");
}

// The commit "State before copy" stands in main and carries the open changes of the project root — it stays.
function mainCommitStays(b) {
  assert.equal(git(b.s.path, "log", "-1", "--format=%s"), "State before copy k1");
  assert.equal(git(b.s.path, "rev-parse", "HEAD^"), b.before, "the commit \"State before copy\" does not sit on the state before");
  const inside = git(b.s.path, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
  for (const f of ["note-new.md", "notes.md"]) assert.ok(inside.includes(f), `${f} is missing in the commit "State before copy": ${inside}`);
}

// The copy's project repo stands detached at the state BEFORE the commit — without the open changes of the project root.
function rootWithoutOpen(b, m, part) {
  assert.equal(git(m, "rev-parse", "HEAD"), b.before, `${part}: the copy's project repo is not at the state before "State before copy"`);
  assert.throws(() => git(m, "symbolic-ref", "-q", "HEAD"), `${part}: HEAD is detached`);
  assert.equal(fs.existsSync(path.join(m, "note-new.md")), false, `${part}: note-new.md (new in main) came along despite base`);
  assert.equal(fs.readFileSync(path.join(m, "notes.md"), "utf8"), "Notes\n", `${part}: notes.md carries the open change of main`);
  assert.equal(git(m, "status", "--porcelain=v1"), "", `${part}: the copy's project repo is not clean`);
}

test("(17) base \"main\" — the copy's project repo stands at the state BEFORE \"State before copy\", without the open changes of the project root; the commit stays in main", async () => {
  await withCreation(situationRootOpen, async ({ b }) => {
    const k = await buildCopy(b, { base: "main" });
    assert.equal(k.state, "ready", `copy ${k.state}: ${k.error}`);
    mainCommitStays(b);
    const m = copyM(b);
    rootWithoutOpen(b, m, "basis main");
    // app knows main: detached on its main, without open changes — as before.
    const mApp = path.join(m, "app");
    assert.equal(git(mApp, "rev-parse", "HEAD"), b.appMain);
    assert.equal(fs.readFileSync(path.join(mApp, "a.txt"), "utf8"), "a.txt\n");
    assert.equal(fs.existsSync(path.join(mApp, "with space.txt")), false);
    // The copy's refs equal the snapshot (main there AFTER the commit) — only HEAD stands before.
    const location = copyLocation({ data: DIRS.data, projectId: b.s.projectId, name: "k1" });
    const sn = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
    const p = sn.repos.find((x) => x.part === "p");
    assert.deepEqual(withoutEmpty(refsOf(m)), refsFromSnapshot(p));
    assert.equal(git(m, "rev-parse", "refs/heads/main"), git(b.s.path, "rev-parse", "HEAD"), "the copy's main = the main instance's main including \"State before copy\"");
    assert.deepEqual(p.beforeCopy, { head: b.before, base: b.before, text: "main" });
    // Journal and result: the base applied in both repos; the project repo stands at b.before (stacks/fetch.js: start point).
    const v = store.stackCopy(k.id).journal.data.prepare.result;
    assert.deepEqual(v.map((e) => [e.rel, e.base, e.applied]), [[".", b.before, true], ["app", b.appMain, true]]);
    const result = store.stackCopy(k.id).result;
    assert.deepEqual(result.code.repos.map((r) => [r.rel, r.head, r.state]), [
      [".", { branch: null, oid: b.before.slice(0, 12) }, { kind: "base", base: "main", applies: true }],
      ["app", { branch: null, oid: b.appMain.slice(0, 12) }, { kind: "base", base: "main", applies: true }],
    ]);
    assert.ok(result.hints.includes(SET.base));
  });
});

test("(18) a base only app knows — the project repo stands detached at the state BEFORE \"State before copy\" (not on main), the base did not apply there", async () => {
  await withCreation(situationRootOpen, async ({ b }) => {
    const k = await buildCopy(b, { base: "feature" });
    assert.equal(k.state, "ready", `copy ${k.state}: ${k.error}`);
    mainCommitStays(b);
    const m = copyM(b);
    rootWithoutOpen(b, m, "basis feature");
    assert.equal(git(path.join(m, "app"), "rev-parse", "HEAD"), b.appFeature);
    const v = store.stackCopy(k.id).journal.data.prepare.result;
    assert.deepEqual(v.map((e) => [e.rel, e.base, e.applied]), [[".", b.before, false], ["app", b.appFeature, true]]);
    const result = store.stackCopy(k.id).result;
    assert.deepEqual(result.code.repos.map((r) => [r.rel, r.head, r.state]), [
      [".", { branch: null, oid: b.before.slice(0, 12) }, { kind: "base", base: "feature", applies: false }],
      ["app", { branch: null, oid: b.appFeature.slice(0, 12) }, { kind: "base", base: "feature", applies: true }],
    ]);
  });
});

test("(19) checkoutArgs and baseOfTheRepo — pure", () => {
  const X = "a".repeat(40);
  const Y = "b".repeat(40);
  const p = (beforeCopy) => ({ part: "p", rel: ".", projectRepo: true, ...(beforeCopy === undefined ? {} : { beforeCopy }) });
  const error = (fn, code) => assert.throws(fn, (e) => e.code === code, code);
  // Without beforeCopy (code repo, no base, snapshot without it) as before.
  assert.deepEqual(checkoutArgs(p(), null), { text: "", required: false, state: "" });
  assert.deepEqual(checkoutArgs({ part: "r0", rel: "app" }, { text: "v1", required: true }), { text: "v1", required: true, state: "" });
  // With beforeCopy: the id resolved back then (must resolve), otherwise the state before.
  assert.deepEqual(checkoutArgs(p({ head: X, base: Y, text: "main" }), { text: "main", required: false }), { text: Y, required: true, state: X });
  assert.deepEqual(checkoutArgs(p({ head: X, base: null, text: "feature" }), { text: "feature", required: false }), { text: "", required: false, state: X });
  assert.deepEqual(checkoutArgs(p({ head: X, base: null, text: null }), null), { text: "", required: false, state: X });
  // `{ ".": ref }` (required) that the project repo did not know back then => COPY_BASE, as in the CHECKOUT itself.
  error(() => checkoutArgs(p({ head: X, base: null, text: "exists-not" }), { text: "exists-not", required: true }), "COPY_BASE");
  // Nothing is guessed: a base other than the one read, beforeCopy on a code repo, an id that is none.
  error(() => checkoutArgs(p({ head: X, base: Y, text: "main" }), { text: "dev", required: false }), "COPY_PREPARE");
  error(() => checkoutArgs(p({ head: X, base: null, text: null }), { text: "main", required: false }), "COPY_PREPARE");
  error(() => checkoutArgs({ part: "r0", rel: "app", projectRepo: false, beforeCopy: { head: X, base: null, text: null } }, null), "COPY_PREPARE");
  error(() => checkoutArgs(p({ head: "HEAD", base: null, text: null }), null), "COPY_PREPARE");
  // baseOfTheRepo: the base of ONE repo, form like basePerRepo.
  assert.equal(baseOfTheRepo(null, "."), null);
  assert.deepEqual(baseOfTheRepo("main", "."), { text: "main", required: false });
  assert.deepEqual(baseOfTheRepo({ ".": "v1", app: "x" }, "."), { text: "v1", required: true });
  assert.equal(baseOfTheRepo({ app: "x" }, "."), null);
  error(() => baseOfTheRepo("-x", "."), "COPY_BASE");
  error(() => baseOfTheRepo(["main"], "."), "COPY_BASE");
  error(() => baseOfTheRepo({ ".": "a\nb" }, "."), "COPY_BASE");
});
