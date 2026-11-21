// Uploading afterwards: the routes `POST /api/projects/:id/upload/begin`, `…/upload/:operation/finished`, `…/upload/:operation/abort`,
// `DELETE …/upload/:operation`, `POST …/archive/check`, `POST …/archive/unpack` (projectbox/setup/upload.js, dispatch in
// projectbox/setup/routes.js), the view `uploads` on the project row (projectbox/setup/status.js uploadView), `projectWork`
// (runs/routes.js) and the seam for the layout (setLayoutReader); plus the precheck (TARGET_BLOCKED, REPO_EXISTING over every
// `.git`, STAGING), the partial placing, the server end, the exclusion of the staging folder and the marker of the code repos.
// Over the fake docker (fake-docker.mjs; an `exec` runs locally — python3, node, git, df) and the real server in the test
// process, (10) with the server as a PROCESS.
//
// WHAT HOLDS HERE
//   (1)  Without operation mode all six routes answer 404 "only in server mode" before anything happens.
//   (2)  Files · folders: `begin` creates the operation (`purpose: retroactive`) and the staging folder `.cbase-upload-<operation>/`
//        IN the container, `existing` = EVERY target file that exists (an `.env` of another size counts), `newFolders` = the
//        topmost folders that do not exist; a second batch names `staged`. `finished` without an answer => 409 CONFLICT; with "skip"
//        the `.env` stays byte-equal EVEN IF it was uploaded (a); the new folder becomes a code repo, the existing one does not (c);
//        the project repo gets no commit (f); placing runs as an exec in the container, detection with `onlySupplement` (h);
//        events `project/upload`; row and staging gone. If `/.cbase-*/` is missing in the project repo's block, `begin` maintains it
//        afterwards (git status does not see the staging folder).
//   (3)  Links and obstacles (b): a dangling link, a path THROUGH a link, a folder where a file should go, a file in the way of a
//        folder => 409 TARGET_BLOCKED `{ count, examples }` at `begin` (no operation, no staging, nothing behind the link), at
//        `finished`, at `archive/check` and `archive/unpack`, and in `run` right before placing (error TARGET_BLOCKED, nothing
//        placed; resuming without the archive); a link in the staging folder to the root's `.env` is not in `staged` and not
//        placed (PLACE); dismissing removes staging and row.
//   (4)  Code repos: a new folder with its own `.git` stays as it came; an existing folder gets no git; a root that is itself a code
//        repo lets NO code repo arise; a `.git` above an existing repository => 409 REPO_EXISTING, nothing placed. `/.cbase-*/` is its
//        own line in `.git/info/exclude` of the user's repo, git status does not see the staging folder.
//   (5)  Conflicts of NOW (e): a file that arises after `begin` => 409 CONFLICT at `finished`; one that arises only during placing
//        (`keep`) => operation `error` CONFLICT with `existing`/`examples`, nothing overwritten — resuming with "skip" keeps the
//        agent's file. `conflict` outside the two modes => 400 MODE.
//   (6)  Locks and check (g, h): SETUP_RUNNING, NOT_READY, over the seam LAYOUT_WAITING (`waiting`) and LAYOUT_RUNNING (`running`,
//        `error`, a throwing reader) — for `begin`, `finished`, `archive/*` and chunks (only `running`); without a provider `null`;
//        PATHS (missing, without `size`, > 5,000, `..`, `.cbase-`), OPERATION_UNKNOWN, OPERATION_FOREIGN, NOT_ABORTABLE, NAME, BYTES;
//        SLOT with `free`/`needed`, and no operation arises; a second batch adds topmost folders, removes none; the pure query
//        `retroactiveOperations` (the holder for the layout).
//   (7)  projectWork and interrupted (i): `place` with THIS boot id is in `projectWork` (phase `place`, `busy`), RUNNING for `finished`
//        and `DELETE`; a row with a foreign boot id does not hold, is `interrupted` and is resumed with `finished`; "upload
//        interrupted (N files staged)" after the upload quiet time (pure calculation, no clock).
//   (8)  ZIP with a parent folder: phase `unpack` in `projectWork`; `abort` in the middle of unpacking ends the PROVISIONER (group),
//        the operation is interrupted; `finished` resumes, the new folder becomes a code repo, the archive goes.
//   (9)  ZIP without a parent folder (-> `<zipname>/`): ARCHIVE_INCOMPLETE, ARCHIVE_DIFFERENT, `check` (target, conflicts), `unpack`
//        without `mode` => 202 (keep), with another mode => 400 MODE; an existing parent folder with "overwrite" — no git.
//   (10) Server as a PROCESS (d): a crash between two chunks => the operation is still there (`newFolders` from the ROW), the second
//        chunk goes to the same staging folder without a new `begin`, `finished` creates the code repo.
//   (11) STAGING: `finished` in `upload` without a staging folder => 409, no "finished"; a topmost folder that arises between `begin`
//        and `finished` is no longer new (`upload.newFolders` empty, no `.git`).
//   (12) REPO_EXISTING over EVERY `.git`: an embedded `apps/web/.git` (files); a `.git` that arises during placing stays untouched
//        (single error "repo"); a ZIP with `rp/.git` above the repo `rp` at `check`/`unpack`, when resuming via `finished` with
//        archive (after an abort) and without (arisen during unpacking => error REPO_EXISTING, then 409 via `finished` and `archive/unpack`).
//   (13) Partial placing: a new folder that arrived becomes a code repo and is detected although another entry fails; a server end in
//        the middle of placing (`serverEnds()`, the exec ends) => `place` interrupted, resuming succeeds.
//   (14) Code repos only into an own `.git`: an uploaded repo without HEAD with a staged file and `gpg.program` => no commit, no
//        program start; the marker of the own half init => commit without signing; a marker with an index => none.
//   (15) ZIP without `mode`: a target that arises during unpacking => error CONFLICT instead of silently skipped; the target folder
//        that then exists becomes no code repo (`newOccupied`); resuming with an answer.
//
// Counter-tests (which sabotage turns which test red; the function names are those of upload.js, provisioner.js, code-repos.js):
//   upload.js `run`: "skip" placed as "overwrite"                                       => (2) red (.env changed)
//   upload.js targetsExisting: `fs.statSync` instead of `fs.lstatSync`                  => (3) red (dangling link not "existing")
//   code-repos.js createCodeRepo: the exception for the project repo marker struck      => (2) red (no new code repo)
//   upload.js `run`: commitProjectRepo after placing                                    => (2) red (project repo != "Creation")
//   upload.js uploadFinished: the count of NOW skipped                                  => (5) red (202 instead of 409 CONFLICT)
//   upload.js uploadLock: the question to layoutStatus struck                           => (6) red (200 instead of LAYOUT_WAITING)
//   runs/routes.js: the loop over retroactiveInWork struck                              => (7) red (projectWork empty)
//   status.js uploadView: `interrupted` in `place` never set                             => (7) red
//   store/project-setup.js: `new_folder` only in the process's memory (column always "[]") => (10) red (no code repo after the crash)
//   upload.js beginUpload: the answer TARGET_BLOCKED struck                             => (3) red (200 with an operation)
//   upload.js precheck: the branch `blocked` struck                                     => (3) red (finished 202)
//   upload.js `run`: the throw TARGET_BLOCKED of the precheck struck                    => (3) red (no error TARGET_BLOCKED)
//   upload.js `run`: partial placing throws at once (before the code repos)             => (13) red (no new code repo)
//   upload.js `start`: the detection after a partial placing struck                     => (13) red (detected unchanged)
//   upload.js `start`: `if (serverEnds()) return;` struck                               => (13) red (error instead of place)
//   provisioner.js conflicts: gitCollision only over the outermost repos                => (12) red (202 instead of 409)
//   provisioner.js place: the protection for an existing `.git` struck                  => (12) red (CONFLICT, objects mixed)
//   upload.js `run`: the throw REPO_EXISTING of the precheck struck                     => (12) red
//   upload.js uploadFinished: an archive unchecked                                      => (12) red (202 instead of 409)
//   upload.js startArchiveUnpack: `mode` mandatory again                                => (9), (15) red (400 MODE)
//   upload.js uploadFinished: "conflict is mandatory for the archive" again             => (3) red (400 MODE)
//   upload.js `run`: `newOccupied` not evaluated                                        => (15) red (newFolders [q])
//   upload.js uploadFinished: stillNew skipped                                          => (11) red (newFolders [late])
//   upload.js uploadFinished: the 409 STAGING in `upload` struck                        => (11) red (202)
//   upload.js beginUpload: protectStaging not called                                    => (2), (4) red (git status sees it)
//   code-repos.js createCodeRepo: without marker, a `.git` without HEAD as own half init => (14) red (commit)
//   code-repos.js CODE_REPO_COMMIT: without `commit.gpgSign=false`                      => (14) red (gpg.program ran)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BOOT_ID } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { runInstance } from "../electron/server/projectbox/run-instance.js";
import { creationOptionsFor } from "../electron/server/projectbox/recreate.js";
import { archivePath } from "../electron/server/projectbox/setup/archive.js";
import { CODE_REPO_MESSAGE, HALF_MARKER, createCodeRepo } from "../electron/server/projectbox/setup/code-repos.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { layoutStatus, uploadRun, setLayoutReader, uploadView } from "../electron/server/projectbox/setup/status.js";
import { uploadQuietMs } from "../electron/server/runtime/upload-stamp.js";
import { slugify } from "../electron/server/workspaces/git-auth.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { HOSTS_TEST, ID } from "./projectbox-scenario.mjs";
import {
  ONLY_IN_OPS_TEXT, active, request, create, b64, setupRoute, finished, git, uploadedRepo, upload, inProject, inSources,
  kindSituation, read, withCreation, processGone, pyHold, pyPid, pyWriteHold, pyWriteWaiting, pyWaiting, pyContinue, write, viewIn,
} from "./setup-harness.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const post = (ctx, pid, sub, body) => inProject(ctx, pid, sub, { method: "POST", body });
const begin = (ctx, pid, body) => post(ctx, pid, "/upload/begin", body);
const finishedReport = (ctx, pid, v, body = {}) => post(ctx, pid, `/upload/${v}/finished`, body);
const dismiss = (ctx, pid, v) => inProject(ctx, pid, `/upload/${v}`, { method: "DELETE" });
const deposit = (proj, v) => path.join(proj.path, `.cbase-upload-${v}`);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const log = (p) => git(p, "log", "--format=%s").split("\n");
const CODE_REPO = [CODE_REPO_MESSAGE];
const file = (p, text, offset = 0) => ({ path: p, dataB64: b64(text), offset });

async function emptyProject(ctx, name) {
  const p = await create(ctx, { name, sources: [] });
  await finished(p.id, `${name}: setup finished`);
  assert.equal(store.projectInstance(p.id, "main").state, "ready");
  return p;
}

// Until the operation is GONE (success), is in `error` or interrupted (`place` with a foreign or empty boot id) — and no run
// works on it any more. A state where nothing works any more and that is none of these throws (red instead of a hang).
function operationEnd(operation, what) {
  return waitForTruthy(() => {
    const v = store.projectUpload(operation);
    if (uploadRun(operation)) return false;
    if (!v) return { gone: true };
    if (v.state === "error" || (v.state === "place" && v.process !== BOOT_ID)) return v;
    throw new Error(`${what}: no run is working, the operation is in ${v.state} (${v.process === BOOT_ID ? "own" : "foreign"} boot id)`);
  }, what);
}
const uploadEvents = (reader, v) => reader.events.filter((e) => e.type === "project/upload" && e.operation === v);
const uploadsIn = async (ctx, pid) => (await viewIn(ctx, pid))?.uploads || [];
const TARGET_BLOCKED_TEXT = /liegt im Weg \(Verweis bzw\. Ordner\/Datei\) — dort erst entfernen oder umbenennen; nichts wurde eingesetzt\.|is in the way/;
const STAGING_TEXT = /^Die Bereitstellung fehlt — verwerfen und neu hochladen\.$|^The staging folder is missing/;
// All paths below a folder (recursive, sorted) with size — a `.git` nobody wrote into shows the same list.
const inventory = (abs) => {
  const out = [];
  const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.lstatSync(p); out.push(`${rel}${n}:${st.isDirectory() ? "d" : st.size}`); if (st.isDirectory()) walk(p, `${rel}${n}/`); } };
  walk(abs, "");
  return out;
};
const withoutUpload = (root) => git(root, "status", "--porcelain", "-uall").split("\n").filter((z) => z.includes(".cbase-upload-"));

// ── Build a ZIP (python3 zipfile; same build as project-unpack.test.js, files only) ─────────────────────────────────────
const BUILD = String.raw`
import json, sys, zipfile
a = json.load(sys.stdin)
with zipfile.ZipFile(a["target"], "w") as zf:
    for e in a["entries"]:
        info = zipfile.ZipInfo(e["name"], date_time=(2026, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (0o100644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(info, e["text"].encode())
`;
function buildZip(target, entries) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("python3", ["-c", BUILD], { input: JSON.stringify({ target, entries }) });
  return fs.readFileSync(target);
}
const chunk = (ctx, pid, archiveId, data, from, until) => request(`${ctx.base}/api/projects/${pid}/archive?archiveId=${archiveId}`, {
  method: "POST", body: { archiveId, offset: from, dataB64: data.subarray(from, until).toString("base64") },
});

// ── (1) G1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) without operation mode: all six routes of the after-the-fact path 404 „only in server mode“, no docker, no operation", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID } });
    const prior = process.env.CBASE_DOCKER_BIN;
    try {
      process.env.CBASE_DOCKER_BIN = fd.bin;
      const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Old", path: path.join(ctx.root, "workspace", "old") } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const pid = r.body.id;
      const v = crypto.randomUUID();
      for (const [m, sub, body] of [["POST", "/upload/begin", { paths: [{ path: "a.txt", size: 1 }] }], ["POST", `/upload/${v}/finished`, {}],
        ["POST", `/upload/${v}/abort`, {}], ["DELETE", `/upload/${v}`, undefined], ["POST", "/archive/check", { operation: v }],
        ["POST", "/archive/unpack", { operation: v, mode: "skip" }]]) {
        const x = await inProject(ctx, pid, sub, { method: m, body });
        assert.equal(x.status, 404, `${m} ${sub}`);
        assert.match(x.body.error, ONLY_IN_OPS_TEXT, `${m} ${sub}`);
      }
      assert.deepEqual(store.retroactiveOperations(pid), []);
      assert.deepEqual(fd.calls(), [], "without operation mode no docker");
    } finally {
      if (prior === undefined) delete process.env.CBASE_DOCKER_BIN; else process.env.CBASE_DOCKER_BIN = prior;
      fd.cleanUp();
    }
  });
});

// ── (2) Files · folders: the whole way ────────────────────────────────────────────────────────────────────────────

test("(2) files: operation and staging in the container, existing = every target file, CONFLICT, \"skip\" leaves the .env byte-equal, new folder → code repo, no commit in the project repo, detection onlySupplement", async () => {
  await withCreation(async ({ ctx, fd, detected, reader }) => {
    const proj = await emptyProject(ctx, "Afterwards");
    const pid = proj.id;
    const header = git(proj.path, "rev-parse", "HEAD");
    write(path.join(proj.path, ".env"), "OLD=1\n");
    write(path.join(proj.path, "app", "x.txt"), "old x");
    const envSha = sha(path.join(proj.path, ".env"));
    // The exclusion of the staging folders is missing in the project repo's block (a repo from before) — `begin` maintains it afterwards.
    const exclude = path.join(proj.path, ".git", "info", "exclude");
    fs.writeFileSync(exclude, read(exclude).split("\n").filter((z) => z.trim() !== "/.cbase-*/").join("\n"));
    const paths = [{ path: ".env", size: 12 }, { path: "fresh/a.txt", size: 1 }, { path: "fresh/sub/b.txt", size: 1 }, { path: "app/y.txt", size: 1 }, { path: "app/x.txt", size: 5 }];
    const mark = fd.calls().length;
    const b = await begin(ctx, pid, { paths });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const v = b.body.operation;
    assert.deepEqual([b.body.existing, b.body.examples, b.body.existingPaths, b.body.staged, b.body.newFolders],
      [2, [".env", "app/x.txt"], [".env", "app/x.txt"], [], ["fresh"]], "every target file counts, whatever its size");
    assert.ok(fs.statSync(deposit(proj, v)).isDirectory(), "the staging folder is there");
    assert.ok(fd.calls().slice(mark).some((a) => a.args[0] === "exec" && a.args.includes("create") && a.args.some((x) => String(x).endsWith(`.cbase-upload-${v}`))),
      "the staging folder was created in the container");
    const row = store.projectUpload(v);
    assert.deepEqual([row.purpose, row.kind, row.state, row.newFolders], ["retroactive", "files", "upload", ["fresh"]]);
    assert.deepEqual(store.retroactiveOperations(pid).map((x) => x.operation), [v]);
    const u0 = (await uploadsIn(ctx, pid)).find((x) => x.operation === v);
    assert.deepEqual([u0.state, u0.kind, u0.newFolders], ["upload", "files", ["fresh"]], JSON.stringify(u0));

    const h = await upload(ctx, pid, { files: [file(".env", "NEW=2\nNEW=3\n"), file("fresh/a.txt", "a"), file("fresh/sub/b.txt", "b"), file("app/y.txt", "y"), file("app/x.txt", "new x")] }, v);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.ok(read(exclude).split("\n").includes("/.cbase-*/"), "the project repo's block carries the exclusion again");
    assert.deepEqual(withoutUpload(proj.path), [], "git status does not see the staging folder");
    assert.equal(read(path.join(proj.path, ".env")), "OLD=1\n", "a chunk writes only into the staging folder");
    const b2 = await begin(ctx, pid, { paths, operation: v });
    assert.equal(b2.status, 200, JSON.stringify(b2.body));
    assert.deepEqual(b2.body.staged.map((x) => [x.path, x.size]).sort(), [[".env", 12], ["app/x.txt", 5], ["app/y.txt", 1], ["fresh/a.txt", 1], ["fresh/sub/b.txt", 1]]);
    assert.deepEqual(b2.body.newFolders, ["fresh"]);

    const k = await finishedReport(ctx, pid, v);
    assert.equal(k.status, 409, JSON.stringify(k.body));
    assert.deepEqual([k.body.code, k.body.existing, [...k.body.examples].sort()], ["CONFLICT", 2, [".env", "app/x.txt"]]);
    assert.equal(store.projectUpload(v).state, "upload", "without an answer nothing happens");

    const f = await finishedReport(ctx, pid, v, { conflict: "skip" });
    assert.equal(f.status, 202, JSON.stringify(f.body));
    assert.equal(f.body.upload.state, "place");
    assert.deepEqual(await operationEnd(v, "placed"), { gone: true });

    assert.equal(sha(path.join(proj.path, ".env")), envSha, "(a) \"skip\": the .env is byte-equal although it was uploaded");
    assert.equal(read(path.join(proj.path, "app", "x.txt")), "old x");
    assert.equal(read(path.join(proj.path, "app", "y.txt")), "y");
    assert.equal(read(path.join(proj.path, "fresh", "a.txt")), "a");
    assert.equal(read(path.join(proj.path, "fresh", "sub", "b.txt")), "b");
    assert.deepEqual(log(path.join(proj.path, "fresh")), CODE_REPO, "(c) the new folder gets a code repo");
    assert.equal(fs.existsSync(path.join(proj.path, "app", ".git")), false, "(c) the existing folder gets no git");
    assert.equal(git(proj.path, "rev-parse", "HEAD"), header, "(f) no commit");
    assert.deepEqual(log(proj.path), ["Creation"]);
    assert.equal(fs.existsSync(deposit(proj, v)), false, "the staging folder is gone");
    assert.equal(store.projectUpload(v), null);
    assert.deepEqual(store.retroactiveOperations(pid), []);
    assert.equal((await viewIn(ctx, pid)).uploads, undefined, "without an open operation no field");
    assert.ok(fd.calls().slice(mark).some((a) => a.args[0] === "exec" && a.args.includes("python3") && a.args.includes("place")), "(h) the placing ran in the container");
    assert.ok(detected.includes(`${pid}+`), `(h) the detection with onlySupplement: ${JSON.stringify(detected)}`);
    await waitForTruthy(() => uploadEvents(reader, v).some((e) => e.state === "finished"), "event finished");
    const states = uploadEvents(reader, v).map((e) => e.state);
    assert.deepEqual(states, ["upload", "place", "finished"], JSON.stringify(states));
    for (const e of uploadEvents(reader, v)) assert.deepEqual(Object.keys(e).filter((x) => !["type", "projectId", "operation", "state", "codeRepos"].includes(x)), [], "only ids, states, numbers");
    const a = await active(ctx.base);
    assert.equal(a.projectWork.some((x) => x.projectId === pid), false);
  });
});

// ── (3) Links ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) what the placer never replaces (link at the target or on the way, folder or file in the way) => 409 TARGET_BLOCKED — at `begin` without an operation, at `finished`, at the archive and in `run` right before placing; a link in the staging folder is not placed; dismiss", async () => {
  await withCreation(async ({ ctx, reader, pyGates }) => {
    const proj = await emptyProject(ctx, "Links");
    const pid = proj.id;
    write(path.join(proj.path, ".env"), "SECRET=1\n");
    const envSha = sha(path.join(proj.path, ".env"));
    fs.symlinkSync("nowhere", path.join(proj.path, "broken"));
    fs.mkdirSync(path.join(proj.path, "real"));
    fs.symlinkSync("real", path.join(proj.path, "through"));
    fs.mkdirSync(path.join(proj.path, "x")); // a folder where a file should go
    write(path.join(proj.path, "build"), "b"); // a file where a folder should go
    const bl = await begin(ctx, pid, { paths: [{ path: "broken", size: 1 }, { path: "through/x.txt", size: 1 }, { path: "x", size: 1 },
      { path: "build/out.js", size: 1 }, { path: "free.txt", size: 1 }] });
    assert.deepEqual([bl.status, bl.body.code, bl.body.count, [...(bl.body.examples || [])].sort()], [409, "TARGET_BLOCKED", 4, ["broken", "build", "through", "x"]], JSON.stringify(bl.body));
    assert.match(bl.body.error, TARGET_BLOCKED_TEXT);
    assert.equal(bl.body.existingPaths, undefined, "none of it is a question");
    assert.deepEqual(store.retroactiveOperations(pid), [], "the first `begin` created no operation");
    assert.deepEqual(fs.readdirSync(proj.path).filter((n) => n.startsWith(".cbase-upload-")), [], "and no staging folder");
    assert.deepEqual(fs.readdirSync(path.join(proj.path, "real")), [], "nothing arose behind the link");

    const b = await begin(ctx, pid, { paths: [{ path: "free.txt", size: 1 }, { path: "b.txt", size: 1 }] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const v = b.body.operation;
    assert.deepEqual([b.body.existing, b.body.existingPaths, b.body.newFolders], [0, [], []]);
    fs.symlinkSync("../.env", path.join(deposit(proj, v), "secret.txt"));
    const b2 = await begin(ctx, pid, { paths: [{ path: "secret.txt", size: 9 }], operation: v });
    assert.equal(b2.status, 200, JSON.stringify(b2.body));
    assert.deepEqual(b2.body.staged, [], "a link of the staging folder to the root's .env is not staged");

    // `finished`: a folder where the file should go arose after `begin` — 409, nothing happens; removed afterwards => it goes on.
    write(path.join(deposit(proj, v), "b.txt"), "b");
    fs.mkdirSync(path.join(proj.path, "b.txt"));
    const fb = await finishedReport(ctx, pid, v, { conflict: "overwrite" });
    assert.deepEqual([fb.status, fb.body.code, fb.body.count, fb.body.examples], [409, "TARGET_BLOCKED", 1, ["b.txt"]], JSON.stringify(fb.body));
    assert.equal(store.projectUpload(v).state, "upload");
    fs.rmdirSync(path.join(proj.path, "b.txt"));

    const f = await finishedReport(ctx, pid, v, { conflict: "skip" });
    assert.equal(f.status, 202, JSON.stringify(f.body));
    const e = await operationEnd(v, "placing with a link");
    assert.deepEqual([e.state, e.code], ["error", "PLACE"], JSON.stringify(e));
    assert.match(e.error, /reference/);
    const u = (await uploadsIn(ctx, pid)).find((x) => x.operation === v);
    assert.deepEqual([u.state, u.code], ["error", "PLACE"]);
    assert.equal(fs.existsSync(path.join(proj.path, "secret.txt")), false, "the link did not get into the root");
    assert.equal(read(path.join(proj.path, "b.txt")), "b");
    assert.equal(sha(path.join(proj.path, ".env")), envSha);

    const d = await dismiss(ctx, pid, v);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(fs.existsSync(deposit(proj, v)), false, "dismiss: the staging folder goes (in the container)");
    assert.equal(store.projectUpload(v), null);
    assert.equal(sha(path.join(proj.path, ".env")), envSha, "the .env is byte-equal");
    assert.equal(fs.readlinkSync(path.join(proj.path, "broken")), "nowhere");
    await waitForTruthy(() => uploadEvents(reader, v).some((x) => x.state === "dismissed"), "event dismissed");
    assert.equal((await dismiss(ctx, pid, v)).status, 404, "a second dismiss no longer knows the operation");

    // At the archive: `check` and `unpack` => 409 (a file in the way of the parent folder), the operation stays in `upload`.
    write(path.join(proj.path, "p2"), "file");
    const data = buildZip(path.join(ctx.root, "zips", "p2.zip"), [{ name: "p2/a.txt", text: "a" }]);
    const ba = await begin(ctx, pid, { archive: { bytes: data.length, name: "p2.zip" } });
    const va = ba.body.operation;
    assert.equal((await chunk(ctx, pid, ba.body.archiveId, data, 0, data.length)).status, 200);
    for (const sub of ["/archive/check", "/archive/unpack"]) {
      const r = await post(ctx, pid, sub, { operation: va });
      assert.deepEqual([r.status, r.body.code, r.body.count, r.body.examples], [409, "TARGET_BLOCKED", 1, ["p2"]], `${sub}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, TARGET_BLOCKED_TEXT);
    }
    assert.equal(store.projectUpload(va).state, "upload");

    // In `run` right before placing (the gate before the first `conflicts` — that is the precheck after unpacking): a folder
    // arises where the file should go => error TARGET_BLOCKED, NOTHING placed; removed afterwards, `finished` resumes.
    fs.rmSync(path.join(proj.path, "p2"));
    pyHold(pyGates, "conflicts");
    assert.equal((await post(ctx, pid, "/archive/unpack", { operation: va })).status, 202);
    await pyWaiting(pyGates, "conflicts");
    fs.mkdirSync(path.join(proj.path, "p2", "a.txt"), { recursive: true });
    pyContinue(pyGates, "conflicts");
    const ef = await operationEnd(va, "obstacle before placing");
    assert.deepEqual([ef.state, ef.code, ef.finding], ["error", "TARGET_BLOCKED", { count: 1, examples: ["p2/a.txt"] }], JSON.stringify(ef));
    assert.match(ef.error, TARGET_BLOCKED_TEXT);
    assert.deepEqual(inventory(path.join(proj.path, "p2")), ["a.txt:d"], "nothing placed");
    fs.rmSync(path.join(proj.path, "p2"), { recursive: true });
    assert.equal((await finishedReport(ctx, pid, va)).status, 202, "resume without the archive, against the staging folder");
    assert.deepEqual(await operationEnd(va, "resumed"), { gone: true });
    assert.equal(read(path.join(proj.path, "p2", "a.txt")), "a");
  });
});

// ── (4) Code repos ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(4) code repos: a brought-along .git stays, existing folder without git, root that is itself a repo without code repo, .git above a repository => REPO_EXISTING", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await emptyProject(ctx, "Repos");
    const pid = proj.id;
    const codeHeader = uploadedRepo(path.join(proj.path, "code"));
    fs.mkdirSync(path.join(proj.path, "there"));
    const b = await begin(ctx, pid, { paths: [{ path: "bundled/README", size: 1 }, { path: "there/fresh.txt", size: 1 }, { path: "fresh/x.txt", size: 1 }] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const v = b.body.operation;
    assert.deepEqual(b.body.newFolders, ["bundled", "fresh"]);
    // A script that is executable in the index arrives from the browser without the x bit and gets it back.
    const withRepo = path.join(deposit(proj, v), "bundled");
    uploadedRepo(withRepo);
    write(path.join(withRepo, "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(withRepo, "run.sh"), 0o755);
    execFileSync("git", ["-C", withRepo, "add", "run.sh"]);
    execFileSync("git", ["-C", withRepo, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "run"]);
    fs.chmodSync(path.join(withRepo, "run.sh"), 0o644);
    const withHeader = git(withRepo, "rev-parse", "HEAD");
    write(path.join(deposit(proj, v), "bundled", "README"), "r");
    write(path.join(deposit(proj, v), "da", "fresh.txt"), "d");
    write(path.join(deposit(proj, v), "fresh", "x.txt"), "x");
    assert.equal((await finishedReport(ctx, pid, v)).status, 202);
    assert.deepEqual(await operationEnd(v, "Repos eingesetzt"), { gone: true });
    assert.equal(git(path.join(proj.path, "bundled"), "rev-parse", "HEAD"), withHeader, "the brought-along repo stays as it came");
    assert.deepEqual(log(path.join(proj.path, "bundled")), ["run", "uploaded"]);
    assert.equal(fs.statSync(path.join(proj.path, "bundled", "run.sh")).mode & 0o100, 0o100, "x bit back according to the index");
    assert.deepEqual(log(path.join(proj.path, "fresh")), CODE_REPO);
    assert.equal(fs.existsSync(path.join(proj.path, "da", ".git")), false, "uploading into an existing folder changes nothing about its git");
    assert.equal(read(path.join(proj.path, "da", "fresh.txt")), "d");
    assert.deepEqual(log(proj.path), ["Creation"]);

    // A `.git` above an existing repository: 409, nothing placed, the repository unchanged.
    const r = await begin(ctx, pid, { paths: [{ path: "code/.git/HEAD", size: 21 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.existing, 1);
    uploadedRepo(path.join(deposit(proj, r.body.operation), "code"));
    const k = await finishedReport(ctx, pid, r.body.operation, { conflict: "overwrite" });
    assert.equal(k.status, 409, JSON.stringify(k.body));
    assert.deepEqual([k.body.code, k.body.folder], ["REPO_EXISTING", "code"]);
    assert.equal(git(path.join(proj.path, "code"), "rev-parse", "HEAD"), codeHeader, "the existing repository is unchanged");
    assert.equal(store.projectUpload(r.body.operation).state, "upload");
    assert.equal((await dismiss(ctx, pid, r.body.operation)).status, 200);

    // The root is itself a code repo (no project repo) — a new folder does NOT become a code repo.
    const p54 = await emptyProject(ctx, "Root repo");
    fs.rmSync(path.join(p54.path, ".git"), { recursive: true, force: true });
    const rootHeader = uploadedRepo(p54.path);
    const b54 = await begin(ctx, p54.id, { paths: [{ path: "fresh/x.txt", size: 1 }] });
    assert.equal(b54.status, 200, JSON.stringify(b54.body));
    assert.deepEqual(b54.body.newFolders, ["fresh"]);
    assert.equal((await upload(ctx, p54.id, { files: [file("fresh/x.txt", "x")] }, b54.body.operation)).status, 200);
    assert.ok(read(path.join(p54.path, ".git", "info", "exclude")).split("\n").includes("/.cbase-*/"), "the exclusion is its own line in the user's repo");
    assert.deepEqual(withoutUpload(p54.path), [], "git status does not see the staging folder (a \"commit everything\" would not take it along)");
    assert.equal((await finishedReport(ctx, p54.id, b54.body.operation)).status, 202);
    assert.deepEqual(await operationEnd(b54.body.operation, "root repo placed"), { gone: true });
    assert.equal(read(path.join(p54.path, "fresh", "x.txt")), "x");
    assert.equal(fs.existsSync(path.join(p54.path, "fresh", ".git")), false, "no code repo in a root that is itself one");
    assert.equal(git(p54.path, "rev-parse", "HEAD"), rootHeader);
  });
});

// ── (5) Conflicts of now ────────────────────────────────────────────────────────────────────────────────────────

test("(5) conflicts of NOW: arisen after `begin` => 409 CONFLICT; arisen during placing => error CONFLICT, nothing overwritten, resuming with \"skip\"; MODE", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const proj = await emptyProject(ctx, "Late");
    const pid = proj.id;
    const b = await begin(ctx, pid, { paths: [{ path: "late.txt", size: 3 }] });
    assert.equal(b.body.existing, 0);
    const v = b.body.operation;
    assert.equal((await upload(ctx, pid, { files: [file("late.txt", "fresh")] }, v)).status, 200);
    write(path.join(proj.path, "late.txt"), "agent"); // an agent wrote it while uploading
    const k = await finishedReport(ctx, pid, v);
    assert.equal(k.status, 409, JSON.stringify(k.body));
    assert.deepEqual([k.body.code, k.body.existing, k.body.examples], ["CONFLICT", 1, ["late.txt"]]);
    const m = await finishedReport(ctx, pid, v, { conflict: "keep" });
    assert.deepEqual([m.status, m.body.code], [400, "MODE"], "only overwrite or skip");
    assert.equal((await finishedReport(ctx, pid, v, { conflict: "overwrite" })).status, 202);
    assert.deepEqual(await operationEnd(v, "overwritten"), { gone: true });
    assert.equal(read(path.join(proj.path, "late.txt")), "fresh");

    // During placing (mode `keep`, no answer): the agent's file stays, the operation asks.
    const b2 = await begin(ctx, pid, { paths: [{ path: "late2.txt", size: 3 }] });
    const v2 = b2.body.operation;
    assert.equal((await upload(ctx, pid, { files: [file("late2.txt", "fresh")] }, v2)).status, 200);
    pyHold(pyGates, "place");
    assert.equal((await finishedReport(ctx, pid, v2)).status, 202);
    await pyWaiting(pyGates, "place");
    write(path.join(proj.path, "late2.txt"), "agent");
    pyContinue(pyGates, "place");
    const e = await operationEnd(v2, "conflict during placing");
    assert.deepEqual([e.state, e.code, e.finding], ["error", "CONFLICT", { existing: 1, examples: ["late2.txt"] }], JSON.stringify(e));
    const u = (await uploadsIn(ctx, pid)).find((x) => x.operation === v2);
    assert.deepEqual([u.state, u.code, u.existing, u.examples], ["error", "CONFLICT", 1, ["late2.txt"]], JSON.stringify(u));
    assert.equal(read(path.join(proj.path, "late2.txt")), "agent", "nothing silently overwritten");
    assert.equal(read(path.join(deposit(proj, v2), "late2.txt")), "fresh", "the file stays in the staging folder");
    assert.equal((await finishedReport(ctx, pid, v2, { conflict: "skip" })).status, 202);
    assert.deepEqual(await operationEnd(v2, "skipped"), { gone: true });
    assert.equal(read(path.join(proj.path, "late2.txt")), "agent");
    assert.equal(fs.existsSync(deposit(proj, v2)), false);
  });
});

// ── (6) Locks, seam, check, slot ──────────────────────────────────────────────────────────────────────────────

test("(6) locks over the seam (LAYOUT_WAITING/RUNNING), SETUP_RUNNING, NOT_READY, check of the bodies, SLOT, batches add folders, retroactiveOperations", async () => {
  await withCreation(async ({ ctx, setFree }) => {
    const proj = await emptyProject(ctx, "Locks");
    const pid = proj.id;
    const other = await emptyProject(ctx, "Other");
    const open = await begin(ctx, pid, { paths: [{ path: "first/a.txt", size: 1 }] });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    const v = open.body.operation;

    // The seam: without a provider null; with a provider its state, an unknown value or a throw "unknown".
    assert.equal(layoutStatus(pid), null);
    let state = null;
    setLayoutReader((p) => { if (state === "raises") throw new Error("broken"); return p === pid ? state : null; });
    try {
      const lock = async (expected, what) => {
        for (const [m, sub, body] of [["POST", "/upload/begin", { paths: [{ path: "b.txt", size: 1 }] }], ["POST", `/upload/${v}/finished`, {}],
          ["POST", "/archive/check", { operation: v }], ["POST", "/archive/unpack", { operation: v, mode: "skip" }]]) {
          const r = await inProject(ctx, pid, sub, { method: m, body });
          assert.deepEqual([r.status, r.body.code], [409, expected], `${what}: ${m} ${sub} ${JSON.stringify(r.body)}`);
        }
      };
      state = "waiting";
      await lock("LAYOUT_WAITING", "waiting");
      assert.equal((await upload(ctx, pid, { files: [file("first/a.txt", "a")] }, v)).status, 200, "in `waiting` chunks go through (the holder finishes uploading)");
      state = "running";
      await lock("LAYOUT_RUNNING", "running");
      const st = await upload(ctx, pid, { files: [file("first/a.txt", "a")] }, v);
      assert.deepEqual([st.status, st.body.code], [409, "LAYOUT_RUNNING"], `a chunk in running: ${JSON.stringify(st.body)}`);
      state = "error";
      await lock("LAYOUT_RUNNING", "error");
      state = "raises";
      assert.equal(layoutStatus(pid), "unknown");
      await lock("LAYOUT_RUNNING", "a throwing reader");
      state = null;
      assert.equal(layoutStatus(pid), null);
      const free = await begin(ctx, pid, { paths: [] });
      assert.equal(free.status, 200, `free without a job: ${JSON.stringify(free.body)}`);
      assert.equal((await dismiss(ctx, pid, free.body.operation)).status, 200);
      state = "waiting"; // the reader names the state only for `pid`
      const adjacent = await begin(ctx, other.id, { paths: [] });
      assert.equal(adjacent.status, 200, "the seam asks per project");
      assert.equal((await dismiss(ctx, other.id, adjacent.body.operation)).status, 200);
      state = null;
    } finally { setLayoutReader(null); }

    // SETUP_RUNNING and NOT_READY.
    const fresh = await create(ctx, { name: "Still open", sources: [{ kind: "files", target: "", bytes: 1 }] });
    await inSources(fresh.id);
    const el = await begin(ctx, fresh.id, { paths: [{ path: "a.txt", size: 1 }] });
    assert.deepEqual([el.status, el.body.code], [409, "SETUP_RUNNING"], JSON.stringify(el.body));
    assert.equal((await request(setupRoute(ctx.base, fresh.id, "sources/1/leaveOut"), { method: "POST" })).status, 202);
    await finished(fresh.id, "finished without a source");
    setInstanceState(other.id, "main", "error", { error: "Test" });
    const nb = await begin(ctx, other.id, { paths: [{ path: "a.txt", size: 1 }] });
    assert.deepEqual([nb.status, nb.body.code], [409, "NOT_READY"]);
    setInstanceState(other.id, "main", "ready");

    // Check of the bodies — nothing arises.
    const count = store.retroactiveOperations(pid).length;
    const many = Array.from({ length: 5001 }, (_, i) => ({ path: `f${i}.txt`, size: 0 }));
    for (const [body, code, status = 400] of [[{}, "PATHS"], [{ paths: [{ path: "a.txt" }] }, "PATHS"], [{ paths: many }, "PATHS"],
      [{ paths: [{ path: "../a.txt", size: 1 }] }, "PATHS"], [{ paths: [{ path: ".cbase-x/a", size: 1 }] }, "PATHS"],
      [{ paths: [], operation: crypto.randomUUID() }, "OPERATION_UNKNOWN", 404], [{ archive: { bytes: 3 } }, "NAME"], [{ archive: { name: "a.zip" } }, "BYTES"]]) {
      const r = await begin(ctx, pid, body);
      assert.deepEqual([r.status, r.body.code], [status, code], `${JSON.stringify(body).slice(0, 80)}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    const foreign = await begin(ctx, other.id, { paths: [], operation: v });
    assert.deepEqual([foreign.status, foreign.body.code], [409, "OPERATION_FOREIGN"]);
    const notAborted = await post(ctx, pid, `/upload/${v}/abort`, {});
    assert.deepEqual([notAborted.status, notAborted.body.code], [409, "NOT_ABORTABLE"]);
    assert.equal((await finishedReport(ctx, pid, crypto.randomUUID())).status, 404);
    assert.equal(store.retroactiveOperations(pid).length, count, "no check created an operation");

    // Batches: a later one adds topmost folders that occur only in it, and removes none.
    const s2 = await begin(ctx, pid, { paths: [{ path: "second/b.txt", size: 1 }], operation: v });
    assert.deepEqual(s2.body.newFolders, ["first", "second"]);
    assert.deepEqual(store.retroactiveOperations(pid).map((x) => [x.operation, x.newFolders]), [[v, ["first", "second"]]], "the pure query (the holder for the layout)");
    assert.deepEqual(store.retroactiveOperations(other.id), [], "per project");

    // SLOT: refused, and no operation arises.
    setFree(0);
    const beforeSlot = store.retroactiveOperations(pid).length;
    const p = await begin(ctx, pid, { paths: [{ path: "large.bin", size: 10 }] });
    assert.deepEqual([p.status, p.body.code], [409, "SLOT"], JSON.stringify(p.body));
    assert.ok(Number.isFinite(p.body.free) && Number.isFinite(p.body.needed), JSON.stringify(p.body));
    const pz = await begin(ctx, pid, { archive: { bytes: 10, name: "a.zip" } });
    assert.deepEqual([pz.status, pz.body.code], [409, "SLOT"]);
    assert.equal(store.retroactiveOperations(pid).length, beforeSlot);
    setFree(10 ** 13);
    for (const x of [...store.retroactiveOperations(pid), ...store.retroactiveOperations(other.id)]) assert.equal((await dismiss(ctx, x.projectId, x.operation)).status, 200);
  });
});

// ── (7) projectWork, interrupted ────────────────────────────────────────────────────────────────────────────────

test("(7) `place` with this boot id holds busy (projectWork, RUNNING); a foreign boot id does not hold, is interrupted and is resumed; \"upload interrupted\" after the quiet time", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const proj = await emptyProject(ctx, "Work");
    const pid = proj.id;
    const b = await begin(ctx, pid, { paths: [{ path: "a.txt", size: 1 }] });
    const v = b.body.operation;
    assert.equal((await upload(ctx, pid, { files: [file("a.txt", "a")] }, v)).status, 200);
    pyHold(pyGates, "place");
    assert.equal((await finishedReport(ctx, pid, v)).status, 202);
    await pyWaiting(pyGates, "place");
    const a = await active(ctx.base);
    assert.deepEqual(a.projectWork.filter((x) => x.projectId === pid).map((x) => [x.instance, x.state, x.phase]), [["main", "setUp", "place"]], JSON.stringify(a.projectWork));
    assert.equal(a.busy, true);
    const u = (await uploadsIn(ctx, pid)).find((x) => x.operation === v);
    assert.deepEqual([u.state, u.interrupted], ["place", undefined]);
    for (const r of [await finishedReport(ctx, pid, v), await dismiss(ctx, pid, v)]) assert.deepEqual([r.status, r.body.code], [409, "RUNNING"]);
    pyContinue(pyGates, "place");
    assert.deepEqual(await operationEnd(v, "placed"), { gone: true });
    assert.equal((await active(ctx.base)).projectWork.some((x) => x.projectId === pid), false);

    // A row of an EARLIER process (foreign boot id): does not hold, is interrupted, `finished` resumes.
    const old = crypto.randomUUID();
    store.createProjectUpload({ operation: old, projectId: pid, purpose: "retroactive", kind: "files", staging: `.cbase-upload-${old}`, newFolders: ["old-folder"] });
    write(path.join(deposit(proj, old), "old-folder", "f.txt"), "f");
    store.changeProjectUpload(old, { state: "place", process: "previous" });
    const ua = (await uploadsIn(ctx, pid)).find((x) => x.operation === old);
    assert.deepEqual([ua.state, ua.interrupted], ["place", true], JSON.stringify(ua));
    const a2 = await active(ctx.base);
    // `busy` is still held here by the upload stamp of the first part (`uploadsActive`, the upload quiet time) — not by the foreign row.
    assert.equal(a2.projectWork.some((x) => x.projectId === pid), false, "a foreign boot id never holds");
    assert.equal(a2.busy, a2.uploadsActive > 0, JSON.stringify({ busy: a2.busy, uploadsActive: a2.uploadsActive, runs: a2.runs }));
    assert.equal((await finishedReport(ctx, pid, old)).status, 202, "resuming = finished once more");
    assert.deepEqual(await operationEnd(old, "resumed"), { gone: true });
    assert.equal(read(path.join(proj.path, "old-folder", "f.txt")), "f");
    assert.deepEqual(log(path.join(proj.path, "old-folder")), CODE_REPO);

    // "Upload interrupted (N files staged)": purely calculated (`now`), without a clock in the test.
    const h = await begin(ctx, pid, { paths: [{ path: "x/1.txt", size: 1 }, { path: "x/2.txt", size: 1 }] });
    assert.equal((await upload(ctx, pid, { files: [file("x/1.txt", "1"), file("x/2.txt", "2")] }, h.body.operation)).status, 200);
    const row = store.projectUpload(h.body.operation);
    const last = Math.max(row.lastChunk, row.createdAt);
    assert.equal(uploadView(row, { now: last }).interrupted, undefined, "not interrupted before the quiet time");
    const later = uploadView(row, { now: last + uploadQuietMs() });
    assert.deepEqual([later.state, later.interrupted, later.staged], ["upload", true, 2], JSON.stringify(later));
    assert.equal((await dismiss(ctx, pid, h.body.operation)).status, 200);
  });
});

// ── (8) ZIP with a parent folder: phase, abort, resume ───────────────────────────────────────────────────────────

test("(8) ZIP with a parent folder: phase `unpack` in projectWork; `abort` in the middle of unpacking ends the PROVISIONER, the operation is interrupted; `finished` resumes, new folder → code repo, archive gone", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const proj = await emptyProject(ctx, "Archive");
    const pid = proj.id;
    const data = buildZip(path.join(ctx.root, "zips", "p.zip"), [{ name: "proj/a.txt", text: "a".repeat(200_000) }, { name: "proj/b.txt", text: "b" }]);
    const b = await begin(ctx, pid, { archive: { bytes: data.length, name: "p.zip" } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const { operation: v, archiveId } = b.body;
    assert.equal(b.body.size, 0);
    assert.equal(store.projectUpload(v).kind, "archive");
    assert.equal((await chunk(ctx, pid, archiveId, data, 0, data.length)).status, 200);
    const p = await post(ctx, pid, "/archive/check", { operation: v });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.target, p.body.parentFolder, p.body.files, p.body.existing], ["proj", true, 2, 0], JSON.stringify(p.body));

    pyWriteHold(pyGates, "unpack");
    const e = await post(ctx, pid, "/archive/unpack", { operation: v, mode: "skip" });
    assert.equal(e.status, 202, JSON.stringify(e.body));
    assert.equal(e.body.upload.state, "unpack");
    const pyPid = await pyWriteWaiting(pyGates, "unpack");
    const a = await active(ctx.base);
    assert.deepEqual(a.projectWork.filter((x) => x.projectId === pid).map((x) => [x.state, x.phase]), [["setUp", "unpack"]], JSON.stringify(a.projectWork));
    const start = await post(ctx, pid, `/upload/${v}/abort`, {});
    assert.equal(start.status, 202, JSON.stringify(start.body));
    await processGone(pyPid, "the PROVISIONER is gone (group)");
    const u = await operationEnd(v, "aborted");
    assert.deepEqual([u.state, u.process], ["place", ""], JSON.stringify(u));
    const view = (await uploadsIn(ctx, pid)).find((x) => x.operation === v);
    assert.deepEqual([view.state, view.interrupted, view.archiveId], ["unpack", true, archiveId], JSON.stringify(view));
    assert.equal((await active(ctx.base)).projectWork.some((x) => x.projectId === pid), false);
    assert.equal(fs.existsSync(path.join(proj.path, "proj")), false, "nothing placed");

    assert.equal((await finishedReport(ctx, pid, v)).status, 202, "resume");
    assert.deepEqual(await operationEnd(v, "resumed"), { gone: true });
    assert.equal(read(path.join(proj.path, "proj", "a.txt")).length, 200_000);
    assert.equal(read(path.join(proj.path, "proj", "b.txt")), "b");
    assert.deepEqual(log(path.join(proj.path, "proj")), CODE_REPO, "the new target folder becomes a code repo");
    assert.equal(store.projectArchive(archiveId), null);
    assert.equal(fs.existsSync(archivePath(pid, archiveId)), false, "the archive goes after unpacking");
    assert.deepEqual(log(proj.path), ["Creation"]);
  });
});

// ── (9) ZIP without a parent folder, conflicts ─────────────────────────────────────────────────────────────────────────────

test("(9) ZIP without a parent folder (→ <zipname>/): incomplete, ARCHIVE_DIFFERENT, check, `unpack` without `mode` (keep), another one => 400 MODE; an existing parent folder with \"overwrite\" without git", async () => {
  await withCreation(async ({ ctx, detected }) => {
    const proj = await emptyProject(ctx, "Flat");
    const pid = proj.id;
    const data = buildZip(path.join(ctx.root, "zips", "flat.zip"), [{ name: "a.txt", text: "a" }, { name: "b/c.txt", text: "c" }]);
    const target = slugify("My Archive");
    const b = await begin(ctx, pid, { archive: { bytes: data.length, name: "My Archive.zip" } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const { operation: v, archiveId } = b.body;
    const un = await post(ctx, pid, "/archive/check", { operation: v });
    assert.deepEqual([un.status, un.body.code, un.body.size, un.body.expected], [409, "ARCHIVE_INCOMPLETE", 0, data.length]);
    assert.equal((await chunk(ctx, pid, archiveId, data, 0, 10)).status, 200);
    const further = await begin(ctx, pid, { archive: { bytes: data.length, name: "My Archive.zip" }, operation: v });
    assert.deepEqual([further.status, further.body.operation, further.body.archiveId, further.body.size], [200, v, archiveId, 10], "resuming from size");
    const different = await begin(ctx, pid, { archive: { bytes: data.length + 1, name: "My Archive.zip" }, operation: v });
    assert.deepEqual([different.status, different.body.code], [409, "ARCHIVE_DIFFERENT"]);
    const over = await chunk(ctx, pid, archiveId, Buffer.concat([data, Buffer.from("x")]), 10, data.length + 1);
    assert.deepEqual([over.status, over.body.code], [400, "CHUNK"], "a chunk never reaches beyond the announced size");
    assert.equal((await chunk(ctx, pid, archiveId, data, 10, data.length)).status, 200);
    const p = await post(ctx, pid, "/archive/check", { operation: v });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.target, p.body.parentFolder, p.body.files, p.body.existing], [target, false, 2, 0], JSON.stringify(p.body));
    const wrong = await post(ctx, pid, "/archive/unpack", { operation: v, mode: "keep" });
    assert.deepEqual([wrong.status, wrong.body.code], [400, "MODE"], "a given mode is overwrite or skip");
    const fd2 = await finishedReport(ctx, pid, v);
    assert.deepEqual([fd2.status, fd2.body.code], [409, "OPERATION_KIND"], "an archive goes via archive/unpack");
    const without = await post(ctx, pid, "/archive/unpack", { operation: v });
    assert.equal(without.status, 202, `without mode: keep — ${JSON.stringify(without.body)}`);
    assert.equal(without.body.upload.conflict, undefined, "no answer stored");
    assert.deepEqual(await operationEnd(v, "unpacked flat"), { gone: true });
    assert.equal(read(path.join(proj.path, target, "a.txt")), "a");
    assert.equal(read(path.join(proj.path, target, "b", "c.txt")), "c");
    assert.deepEqual(log(path.join(proj.path, target)), CODE_REPO);
    assert.equal(fs.existsSync(archivePath(pid, archiveId)), false);
    assert.ok(detected.includes(`${pid}+`));

    // A parent folder that exists: conflicts against the root, "overwrite", no git added.
    write(path.join(proj.path, "proj", "a.txt"), "old");
    const d2 = buildZip(path.join(ctx.root, "zips", "p.zip"), [{ name: "proj/a.txt", text: "fresh" }, { name: "proj/z.txt", text: "z" }]);
    const b2 = await begin(ctx, pid, { archive: { bytes: d2.length, name: "p.zip" } });
    assert.equal((await chunk(ctx, pid, b2.body.archiveId, d2, 0, d2.length)).status, 200);
    const p2 = await post(ctx, pid, "/archive/check", { operation: b2.body.operation });
    assert.deepEqual([p2.body.target, p2.body.parentFolder, p2.body.existing, p2.body.examples], ["proj", true, 1, ["proj/a.txt"]], JSON.stringify(p2.body));
    assert.equal((await post(ctx, pid, "/archive/unpack", { operation: b2.body.operation, mode: "overwrite" })).status, 202);
    assert.deepEqual(await operationEnd(b2.body.operation, "unpacked overwritten"), { gone: true });
    assert.equal(read(path.join(proj.path, "proj", "a.txt")), "fresh");
    assert.equal(read(path.join(proj.path, "proj", "z.txt")), "z");
    assert.equal(fs.existsSync(path.join(proj.path, "proj", ".git")), false, "an existing folder gets no git");
    assert.deepEqual(log(proj.path), ["Creation"]);
  });
});

// ── (10) The server as a PROCESS: crash between two chunks ────────────────────────────────────────────────────

test("(10) crash between two chunks (server as a process): the operation carries newFolders from the row, the second chunk goes to the same staging folder, finished creates the code repo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-upload-kind-"));
  const situation = kindSituation(root);
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(bin);
  const dfFile = path.join(root, "df-free");
  fs.writeFileSync(dfFile, String(10 ** 13));
  fs.writeFileSync(path.join(bin, "df"), `#!/bin/sh\necho "    Avail"\n/bin/cat '${dfFile}'\n`, { mode: 0o755 });
  const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: situation.programs });
  const environment = {
    CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECTBOX_TICK_MS: "10",
    CBASE_PROJECTBOX_CREATION_MS: "3600000", CBASE_HOSTS_FILE: HOSTS_TEST, CBASE_PROJECT_STAGE_MS: "3600000",
    CBASE_NETWORK_ROOT: situation.creation.root, HOME: situation.home, PATH: `${bin}:${process.env.PATH}`,
    CBASE_TEST_CREATION_OPTIONS: JSON.stringify(situation.creation),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(environment)) process.env[k] = v;
    await withAgentsServer(async (ctx) => {
      const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Crash", sources: [] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const proj = r.body;
      const ready = (what) => waitForTruthy(async () => {
        const p = await viewIn(ctx, proj.id);
        if (p?.instance?.state === "error") throw new Error(`${what}: instance error: ${JSON.stringify(p.instance)}`);
        if (p?.setup?.state === "error") throw new Error(`${what}: setup error: ${JSON.stringify(p.setup)}`);
        return p && !p.setup && p.instance?.state === "ready" ? p : false;
      }, what);
      await ready("project ready");
      const b = await begin(ctx, proj.id, { paths: [{ path: "fresh/a.txt", size: 1 }, { path: "fresh/b.txt", size: 1 }] });
      assert.equal(b.status, 200, JSON.stringify(b.body));
      const v = b.body.operation;
      assert.deepEqual(b.body.newFolders, ["fresh"]);
      assert.equal((await upload(ctx, proj.id, { files: [file("fresh/a.txt", "a")] }, v)).status, 200);

      await ctx.crash(); // SIGKILL including the group, then a new server process
      const p = await ready("ready after the restart");
      const u = (p.uploads || []).find((x) => x.operation === v);
      assert.ok(u, `the operation is still there: ${JSON.stringify(p.uploads)}`);
      assert.deepEqual([u.state, u.newFolders, u.staged], ["upload", ["fresh"], 1], JSON.stringify(u));

      assert.equal((await upload(ctx, proj.id, { files: [file("fresh/b.txt", "b")] }, v)).status, 200, "the second chunk without a new begin");
      assert.equal((await finishedReport(ctx, proj.id, v)).status, 202);
      await waitForTruthy(async () => {
        const x = await viewIn(ctx, proj.id);
        const w = (x?.uploads || []).find((y) => y.operation === v);
        if (w?.state === "error") throw new Error(`operation error: ${JSON.stringify(w)}`);
        return x && !w;
      }, "the operation is placed");
      assert.equal(read(path.join(proj.path, "fresh", "a.txt")), "a");
      assert.equal(read(path.join(proj.path, "fresh", "b.txt")), "b");
      assert.deepEqual(log(path.join(proj.path, "fresh")), CODE_REPO, "newFolders came from the row, not from the dead process's memory");
      assert.deepEqual(log(proj.path), ["Creation"]);
    }, { childProcess: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (11) STAGING, a folder arises between begin and finished ─────────────────────────────────────────────

test("(11) `finished` in `upload` without a staging folder => 409 STAGING, nothing reported; a topmost folder that arises between `begin` and `finished` gets no code repo", async () => {
  await withCreation(async ({ ctx, reader }) => {
    const proj = await emptyProject(ctx, "Missing");
    const pid = proj.id;
    const b = await begin(ctx, pid, { paths: [{ path: "fresh/a.txt", size: 1 }] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const v = b.body.operation;
    assert.equal((await upload(ctx, pid, { files: [file("fresh/a.txt", "a")] }, v)).status, 200);
    fs.rmSync(deposit(proj, v), { recursive: true, force: true }); // e.g. an agent's `git clean -fdx`
    const f = await finishedReport(ctx, pid, v);
    assert.deepEqual([f.status, f.body.code], [409, "STAGING"], JSON.stringify(f.body));
    assert.match(f.body.error, STAGING_TEXT);
    assert.equal(store.projectUpload(v).state, "upload", "no success where nothing arrived");
    assert.equal(uploadEvents(reader, v).some((e) => e.state === "finished"), false);
    assert.equal(fs.existsSync(path.join(proj.path, "fresh")), false);
    assert.equal((await dismiss(ctx, pid, v)).status, 200);

    const b2 = await begin(ctx, pid, { paths: [{ path: "late/x.txt", size: 1 }] });
    const v2 = b2.body.operation;
    assert.deepEqual(b2.body.newFolders, ["late"]);
    assert.equal((await upload(ctx, pid, { files: [file("late/x.txt", "x")] }, v2)).status, 200);
    write(path.join(proj.path, "late", "agent.txt"), "agent"); // an agent creates the folder while uploading
    const f2 = await finishedReport(ctx, pid, v2);
    assert.equal(f2.status, 202, JSON.stringify(f2.body));
    assert.deepEqual(f2.body.upload.newFolders, [], "no longer new");
    assert.deepEqual(await operationEnd(v2, "into the existing folder"), { gone: true });
    assert.equal(read(path.join(proj.path, "late", "x.txt")), "x");
    assert.equal(fs.existsSync(path.join(proj.path, "late", ".git")), false, "uploading into an existing folder changes nothing about its git");
  });
});

// ── (12) REPO_EXISTING over every .git ───────────────────────────────────────────────────────────────────────────

test("(12) REPO_EXISTING over EVERY .git: an embedded .git (files); the PROVISIONER never writes into a .git that arises only during placing; a ZIP with .git above a repository — check, unpack, resuming via finished with and without archive, arisen during unpacking", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const proj = await emptyProject(ctx, "Mixed");
    const pid = proj.id;

    // (a) embedded: `apps/` is a collecting folder with the repo `apps/web` in it; `apps/.git` and `apps/web/.git` are uploaded.
    const webHeader = uploadedRepo(path.join(proj.path, "apps", "web"));
    const b = await begin(ctx, pid, { paths: [{ path: "apps/web/a.txt", size: 1 }] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const v = b.body.operation;
    uploadedRepo(path.join(deposit(proj, v), "apps"));
    uploadedRepo(path.join(deposit(proj, v), "apps", "web"));
    write(path.join(deposit(proj, v), "apps", "web", "a.txt"), "a");
    const k = await finishedReport(ctx, pid, v, { conflict: "overwrite" });
    assert.deepEqual([k.status, k.body.code, k.body.folder], [409, "REPO_EXISTING", "apps/web"], JSON.stringify(k.body));
    assert.equal(git(path.join(proj.path, "apps", "web"), "rev-parse", "HEAD"), webHeader, "the embedded repo is unchanged");
    assert.equal(fs.existsSync(path.join(proj.path, "apps", ".git")), false, "and none arose above it");
    assert.equal((await dismiss(ctx, pid, v)).status, 200);

    // (b) a `.git` that arises only DURING placing (an agent clones): single error "repo", nothing written into it.
    fs.mkdirSync(path.join(proj.path, "lib"));
    const b2 = await begin(ctx, pid, { paths: [{ path: "lib/x.txt", size: 1 }] });
    const v2 = b2.body.operation;
    uploadedRepo(path.join(deposit(proj, v2), "lib"));
    write(path.join(deposit(proj, v2), "lib", "x.txt"), "x");
    pyHold(pyGates, "place");
    assert.equal((await finishedReport(ctx, pid, v2)).status, 202);
    await pyWaiting(pyGates, "place");
    const libHeader = uploadedRepo(path.join(proj.path, "lib"));
    const libInventory = inventory(path.join(proj.path, "lib", ".git"));
    pyContinue(pyGates, "place");
    const e2 = await operationEnd(v2, "a .git arose during placing");
    assert.deepEqual([e2.state, e2.code], ["error", "PLACE"], JSON.stringify(e2));
    assert.match(e2.error, /repo: lib\/\.git/);
    assert.deepEqual(inventory(path.join(proj.path, "lib", ".git")), libInventory, "no entry of the uploaded .git got in");
    assert.equal(git(path.join(proj.path, "lib"), "rev-parse", "HEAD"), libHeader);
    assert.equal(read(path.join(proj.path, "lib", "x.txt")), "x", "the rest of the folder arrived");
    assert.equal((await dismiss(ctx, pid, v2)).status, 200);

    // (c) a ZIP with `rp/.git` above the repository `rp`: `check` and `unpack` => 409.
    uploadedRepo(path.join(proj.path, "rp"));
    const data = buildZip(path.join(ctx.root, "zips", "rp.zip"), [{ name: "rp/.git/HEAD", text: "ref: refs/heads/zipbranch\n" },
      { name: "rp/.git/config", text: "[core]\n\trepositoryformatversion = 0\n" }, { name: "rp/.git/refs/heads/zipBranch", text: `${"1".repeat(40)}\n` },
      { name: "rp/a.txt", text: "a".repeat(100_000) }]);
    const ba = await begin(ctx, pid, { archive: { bytes: data.length, name: "rp.zip" } });
    const va = ba.body.operation;
    assert.equal((await chunk(ctx, pid, ba.body.archiveId, data, 0, data.length)).status, 200);
    for (const [sub, body] of [["/archive/check", { operation: va }], ["/archive/unpack", { operation: va, mode: "overwrite" }]]) {
      const r = await post(ctx, pid, sub, body);
      assert.deepEqual([r.status, r.body.code, r.body.folder], [409, "REPO_EXISTING", "rp"], `${sub}: ${JSON.stringify(r.body)}`);
    }
    const repoEqual = (header, what) => {
      assert.equal(git(path.join(proj.path, "rp"), "rev-parse", "HEAD"), header, `${what}: HEAD`);
      assert.equal(git(path.join(proj.path, "rp"), "symbolic-ref", "HEAD"), "refs/heads/main", `${what}: the branch`);
      assert.equal(fs.existsSync(path.join(proj.path, "rp", ".git", "refs", "heads", "zip-branch")), false, `${what}: no branch from the ZIP`);
    };

    // Resuming via `finished` with archive: aborted in the middle of unpacking, afterwards an agent creates the repository.
    fs.rmSync(path.join(proj.path, "rp"), { recursive: true });
    pyWriteHold(pyGates, "unpack");
    assert.equal((await post(ctx, pid, "/archive/unpack", { operation: va, mode: "overwrite" })).status, 202);
    const pyPid1 = await pyWriteWaiting(pyGates, "unpack");
    assert.equal((await post(ctx, pid, `/upload/${va}/abort`, {})).status, 202);
    await processGone(pyPid1, "the PROVISIONER is gone");
    assert.deepEqual([(await operationEnd(va, "aborted")).state], ["place"]);
    const header1 = uploadedRepo(path.join(proj.path, "rp"));
    const f1 = await finishedReport(ctx, pid, va);
    assert.deepEqual([f1.status, f1.body.code, f1.body.folder], [409, "REPO_EXISTING", "rp"], JSON.stringify(f1.body));
    repoEqual(header1, "with archive");

    // Arisen DURING unpacking: the check in `run` right before placing => error REPO_EXISTING; resuming without the archive
    // (it went after unpacking) checks the staging folder => 409, via `finished` as via `archive/unpack`.
    fs.rmSync(path.join(proj.path, "rp"), { recursive: true });
    pyWriteHold(pyGates, "unpack");
    assert.equal((await finishedReport(ctx, pid, va)).status, 202);
    await pyWriteWaiting(pyGates, "unpack");
    const header2 = uploadedRepo(path.join(proj.path, "rp"));
    pyContinue(pyGates, "write-unpack");
    const ef = await operationEnd(va, "a repository arose during unpacking");
    assert.deepEqual([ef.state, ef.code, ef.finding], ["error", "REPO_EXISTING", { folder: "rp" }], JSON.stringify(ef));
    assert.match(ef.error, /„rp“ bringt ein \.git mit|“rp” brings a \.git/);
    assert.equal(store.projectArchiveOfOperation(va), null, "the archive went after unpacking");
    repoEqual(header2, "during unpacking");
    for (const [sub, body] of [[`/upload/${va}/finished`, { conflict: "overwrite" }], ["/archive/unpack", { operation: va, mode: "overwrite" }]]) {
      const r = await post(ctx, pid, sub, body);
      assert.deepEqual([r.status, r.body.code, r.body.folder], [409, "REPO_EXISTING", "rp"], `without archive ${sub}: ${JSON.stringify(r.body)}`);
    }
    repoEqual(header2, "after resuming");
    assert.equal((await dismiss(ctx, pid, va)).status, 200);
  });
});

// ── (13) Partial placing, server end ───────────────────────────────────────────────────────────────────────────────

test("(13) partial placing: a new folder that arrived gets a code repo and is detected, also when another entry fails; a server end in the middle of placing => interrupted (not error), resuming succeeds", async () => {
  await withCreation(async ({ ctx, detected, pyGates }) => {
    const proj = await emptyProject(ctx, "Part");
    const pid = proj.id;
    const b = await begin(ctx, pid, { paths: [{ path: "fresh/a.txt", size: 1 }, { path: "b.txt", size: 1 }] });
    const v = b.body.operation;
    assert.deepEqual(b.body.newFolders, ["fresh"]);
    assert.equal((await upload(ctx, pid, { files: [file("fresh/a.txt", "a"), file("b.txt", "b")] }, v)).status, 200);
    pyHold(pyGates, "place");
    assert.equal((await finishedReport(ctx, pid, v)).status, 202);
    await pyWaiting(pyGates, "place");
    fs.mkdirSync(path.join(proj.path, "b.txt")); // the obstacle arises DURING placing: a single error
    const prior = detected.filter((x) => x === `${pid}+`).length;
    pyContinue(pyGates, "place");
    const e = await operationEnd(v, "partial placing");
    assert.deepEqual([e.state, e.code], ["error", "PLACE"], JSON.stringify(e));
    assert.match(e.error, /folder-in-way: b\.txt/);
    assert.equal(read(path.join(proj.path, "fresh", "a.txt")), "a");
    assert.deepEqual(log(path.join(proj.path, "fresh")), CODE_REPO, "the arrived new folder became a code repo although b.txt failed");
    assert.equal(detected.filter((x) => x === `${pid}+`).length, prior + 1, `the detection ran: ${JSON.stringify(detected)}`);
    assert.equal((await dismiss(ctx, pid, v)).status, 200);
    assert.deepEqual(log(path.join(proj.path, "fresh")), CODE_REPO, "dismissing leaves the code repo");

    // Server end in the middle of placing: docker stop ends the exec — the operation stays `place` and is interrupted.
    const b2 = await begin(ctx, pid, { paths: [{ path: "end/a.txt", size: 1 }] });
    const v2 = b2.body.operation;
    assert.equal((await upload(ctx, pid, { files: [file("end/a.txt", "a")] }, v2)).status, 200);
    pyHold(pyGates, "place");
    assert.equal((await finishedReport(ctx, pid, v2)).status, 202);
    await pyWaiting(pyGates, "place");
    const held = pyPid(pyGates, "place");
    serverEndMarkerForTest(true);
    try {
      process.kill(held, "SIGTERM");
      await waitForTruthy(() => !uploadRun(v2), "the run ended with the server");
    } finally {
      serverEndMarkerForTest(false);
      fs.rmSync(path.join(pyGates, "waiting-place"), { force: true });
    }
    const z = store.projectUpload(v2);
    assert.deepEqual([z.state, z.process, z.code || ""], ["place", BOOT_ID, ""], JSON.stringify(z));
    const u = (await uploadsIn(ctx, pid)).find((x) => x.operation === v2);
    assert.deepEqual([u.state, u.interrupted, u.code], ["place", true, undefined], JSON.stringify(u));
    assert.equal(fs.existsSync(path.join(proj.path, "end")), false);
    assert.equal((await finishedReport(ctx, pid, v2)).status, 202, "resume");
    assert.deepEqual(await operationEnd(v2, "resumed"), { gone: true });
    assert.equal(read(path.join(proj.path, "end", "a.txt")), "a");
    assert.deepEqual(log(path.join(proj.path, "end")), CODE_REPO);
  });
});

// ── (14) code repos only into their own .git ────────────────────────────────────────────────────────────────────────

test("(14) code repos only into an own `.git`: an uploaded repo without a commit with a staged file and gpg.program => no commit, no program start; the marker of the own half init => commit without signing, marker gone; with an index => no commit", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await emptyProject(ctx, "Signed");
    const pid = proj.id;
    const ran = path.join(ctx.root, "gpg-ran");
    const signer = path.join(ctx.root, "gpg-program");
    fs.writeFileSync(signer, `#!/bin/sh\n: > '${ran}'\nexit 1\n`, { mode: 0o755 });
    const signed = (repo) => { git(repo, "config", "commit.gpgSign", "true"); git(repo, "config", "gpg.program", signer); };

    const b = await begin(ctx, pid, { paths: [{ path: "without-header/a.txt", size: 1 }] });
    const v = b.body.operation;
    assert.deepEqual(b.body.newFolders, ["without-header"]);
    const up = path.join(deposit(proj, v), "without-header");
    fs.mkdirSync(up, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", up]);
    write(path.join(up, "a.txt"), "a");
    git(up, "add", "a.txt");
    signed(up);
    assert.equal((await finishedReport(ctx, pid, v)).status, 202);
    assert.deepEqual(await operationEnd(v, "the repo without a commit placed"), { gone: true });
    const target = path.join(proj.path, "without-header");
    assert.throws(() => git(target, "rev-parse", "--verify", "--quiet", "HEAD"), "no commit into a brought-along repo");
    assert.equal(fs.existsSync(ran), false, "the gpg.program from the upload did not run");
    assert.equal(git(target, "diff", "--cached", "--name-only"), "a.txt", "the user's index stays as it came");

    // Directly: the marker of the own half init (B died between init and commit) => the commit, without signing — a configuration in
    // the repo does not force it —, and the marker goes. With an index (something was staged) => no commit.
    const inst = runInstance(pid);
    const home = creationOptionsFor(pid).home;
    const half = path.join(proj.path, "half");
    execFileSync("git", ["init", "-q", "-b", "main", half]);
    fs.writeFileSync(path.join(half, ".git", HALF_MARKER), "");
    signed(half);
    const r = await createCodeRepo(inst, proj.path, "half", home ? { home } : {});
    assert.equal(r.created, true, JSON.stringify(r));
    assert.deepEqual(log(half), CODE_REPO);
    assert.equal(fs.existsSync(path.join(half, ".git", HALF_MARKER)), false, "the marker goes after the commit");
    assert.equal(fs.existsSync(ran), false, "commit.gpgSign=false");
    const withIndex = path.join(proj.path, "withindex");
    execFileSync("git", ["init", "-q", "-b", "main", withIndex]);
    fs.writeFileSync(path.join(withIndex, ".git", HALF_MARKER), "");
    write(path.join(withIndex, "a.txt"), "a");
    git(withIndex, "add", "a.txt");
    const r2 = await createCodeRepo(inst, proj.path, "withindex", home ? { home } : {});
    assert.deepEqual([r2.created, r2.reason], [false, "repo"], JSON.stringify(r2));
    assert.throws(() => git(withIndex, "rev-parse", "--verify", "--quiet", "HEAD"), "no commit over a staged index");
  });
});

// ── (15) ZIP without mode: keep ──────────────────────────────────────────────────────────────────────────────────

test("(15) ZIP without `mode` (keep): a target that arises only DURING unpacking => error CONFLICT instead of silently skipped; the target folder that then exists becomes no code repo; resuming via finished with an answer", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const proj = await emptyProject(ctx, "Keep");
    const pid = proj.id;
    const data = buildZip(path.join(ctx.root, "zips", "q.zip"), [{ name: "q/a.txt", text: "fresh" }, { name: "q/b.txt", text: "b" }]);
    const b = await begin(ctx, pid, { archive: { bytes: data.length, name: "q.zip" } });
    const v = b.body.operation;
    assert.equal((await chunk(ctx, pid, b.body.archiveId, data, 0, data.length)).status, 200);
    const p = await post(ctx, pid, "/archive/check", { operation: v });
    assert.deepEqual([p.status, p.body.target, p.body.existing], [200, "q", 0], JSON.stringify(p.body));
    pyWriteHold(pyGates, "unpack");
    const e = await post(ctx, pid, "/archive/unpack", { operation: v });
    assert.equal(e.status, 202, JSON.stringify(e.body));
    assert.deepEqual(e.body.upload.newFolders, ["q"]);
    await pyWriteWaiting(pyGates, "unpack");
    write(path.join(proj.path, "q", "a.txt"), "agent"); // an agent writes while unpacking
    pyContinue(pyGates, "write-unpack");
    const f = await operationEnd(v, "conflict after unpacking");
    assert.deepEqual([f.state, f.code, f.finding], ["error", "CONFLICT", { existing: 1, examples: ["q/a.txt"] }], JSON.stringify(f));
    assert.equal(read(path.join(proj.path, "q", "a.txt")), "agent", "nothing silently skipped or overwritten");
    assert.equal(read(path.join(deposit(proj, v), "q", "a.txt")), "fresh", "the uploaded version stays staged");
    assert.equal(read(path.join(proj.path, "q", "b.txt")), "b");
    assert.deepEqual(store.projectUpload(v).newFolders, [], "q exists by now — no longer new");
    assert.equal(store.projectArchiveOfOperation(v), null);
    const w = await finishedReport(ctx, pid, v, { conflict: "overwrite" });
    assert.equal(w.status, 202, JSON.stringify(w.body));
    assert.deepEqual(await operationEnd(v, "resumed overwritten"), { gone: true });
    assert.equal(read(path.join(proj.path, "q", "a.txt")), "fresh");
    assert.equal(fs.existsSync(path.join(proj.path, "q", ".git")), false, "no code repo in a folder an agent created");
  });
});
