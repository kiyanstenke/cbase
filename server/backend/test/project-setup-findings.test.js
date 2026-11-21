// Findings from the review of slice 3 of project setup (server part): one test per finding, each walking the path that breaks
// without the repair. Separate file because project-setup.test.js sat at the line guard; both share ./setup-harness.mjs. Runs
// over the fake docker (fake-docker.mjs; an `exec` runs locally), the fake git and the fake python3 of the harness, and the
// real server in the test process.
//
//   (B1)  Over the REAL gateway (server/gateway/gateway-harness.mjs: index.js as a child, fake docker reporting the port of the
//         real backend): the gateway answers `/api/health` itself (`projectCreation` never arrives), passes the rules route
//         through, and that one says `mode: "container"`. See also project-setup.test.js (2) and (9) against the backend alone.
//   (B2)  `begin`/`finished` while the `container` step RUNS => NOT_READY (not RUNNING: both clients wait only on NOT_READY);
//         `leaveOut` stays RUNNING; afterwards it goes through.
//   (B5)  `website/.git` and `website/themes/t/.git` in ONE source: the inner repo is content of the outer one (the client's
//         rule) -- no CODE_REPO_LOCATION, both repos arrive as uploaded.
//   (B6)  A target that appears BETWEEN counting and placing (the fake python3 holds the provisioner before `place`): the
//         uploaded file stays staged, the setup recounts and asks (P6) with the new number; the rest is placed; "overwrite"
//         => the uploaded version wins.
//   (B7)  Resume near the reserve: only what is still to come is required (bytes minus what is staged); if even that does not
//         fit, SLOT with `needed` = rest + reserve.
//   (B8)  Workspace level: the lock computes paths like the routes that write -- leading `/` and `\`, `dir` with `/`, `\` in an
//         upload's file path, a worktree relative to a neighbour repo (`../<slug>/wt`) => 409, nothing in the project.
//   (B14) Deleting a workspace (docker stop at the gate): a POST of the setup => 409 WORKSPACE_GETS_DELETED, no project; a
//         project that slipped past that POST is cleaned up by the deletion (its setup row is gone).
//   (B15) The lock judges AFTER the body: three requests with an open body (files/write at project level, upload at workspace
//         level into the project, git/commit), the step begins, then the body arrives => 409, nothing written. Plus git/fetch,
//         which passed the lock BEFORE the step and waits at `git remote get-url`: its location asks the lock again =>
//         409 SETUP_RUNNING.
//   (B17) ENOSPC mid-chunk (seam setChunkWriter) => 409 SLOT with the specified wording; the source stays `wait-upload`.
//   (B18) All sources left out => finished WITHOUT services detection (P9).
// Finding 22 (`error` without prefix) is covered by project-setup.test.js (4)/(5) and (8); finding 9 (detection during a server
// step) and 16 (paths in the secret filter) by project-detection.test.js.
//
// Wait only on events (row states, gates of the fake docker/git/python3, the server reading the body); no duration is a
// criterion. Every open request ends in `finally`.
//
// COUNTER-TESTS (one sabotage each, then the affected test turns red):
//   B1  rules route without `mode` => (B1) red (and project-setup.test.js (2), (9)).
//   B2  the NOT_READY check before RUNNING removed => (B2) red.
//   B5  the provisioner without its "outermost repo" rule => (B5) red.
//   B6  without an answer, `skip` instead of `keep` again => (B6) red.
//   B7  `checkSlot` with all bytes instead of the rest => (B7) red.
//   B8  `inside` via path.resolve instead of resolveInside, no `\` => `/` in the upload, worktree only against the root -- each => (B8) red.
//   B14 the 409 WORKSPACE_GETS_DELETED removed, or the fresh read of the project list in the DELETE removed -- each => (B14) red.
//   B15 the old lock block (before the body), or the location of /git not wrapped -- each => (B15) red.
//   B17 ENOSPC not translated => (B17) red.
//   B18 `empty` computed from the number of sources => (B18) red.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import diagnostics from "node:diagnostics_channel";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { prepareSetup } from "../../../server/gateway/gateway-harness.mjs";
import { BOOT_ID } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { setChunkWriter } from "../electron/server/projectbox/setup/operation.js";
import { waitForTruthy } from "./agent-harness.mjs";
import {
  request as requestData, create, b64, staging, setupRoute, finished, git, gitHold, gitWaiting, gitContinue, uploadedRepo, upload,
  inWorkspace, inSources, read, withCreation, pyHold, pyWaiting, pyContinue, write, viewIn, gateClosed, waitUntil,
} from "./setup-harness.mjs";

const source = (ctx, pid, seq, what, body) => requestData(setupRoute(ctx.base, pid, `sources/${seq}/${what}`), { method: "POST", body });
function locked(x, pid, what) {
  assert.equal(x.status, 409, `${what}: ${JSON.stringify(x.body)}`);
  assert.equal(x.body.code, "SETUP_RUNNING", `${what}: ${JSON.stringify(x.body)}`);
  assert.equal(x.body.projectId, pid, what);
}

// A request with an OPEN body (like the harness's open-chunk request, for any route): head and a space are at the server, only
// `end(body)` sends the rest. It returns once the server BEGINS to read the body (a `data` listener, seen through
// diagnostics_channel) or has already answered -- an event, not a duration. `shutdown()` destroys it (for the finally).
async function openRequest(ctx, filePath, method) {
  let page = null;
  const consumer = ({ request, response }) => { if (request.url === filePath) page = { request, response }; };
  diagnostics.subscribe("http.server.request.start", consumer);
  const pendingRequest = http.request(`${ctx.base}${filePath}`, { method, headers: { "Content-Type": "application/json", Connection: "close" } });
  const responseValue = new Promise((resolve, reject) => {
    pendingRequest.on("response", (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { t += c; });
      res.on("end", () => { let b; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    pendingRequest.on("error", reject);
  });
  responseValue.catch(() => {}); // a destroyed remainder in the finally is not an unhandled error
  pendingRequest.write(" ");
  try {
    await waitForTruthy(() => page && (page.request.listenerCount("data") > 0 || page.response.writableEnded), `${method} ${filePath}: der Server liest den Rumpf`);
  } finally { diagnostics.unsubscribe("http.server.request.start", consumer); }
  return { end: (body) => { pendingRequest.end(JSON.stringify(body)); return responseValue; }, shutdown: () => { if (!pendingRequest.writableEnded) pendingRequest.destroy(); } };
}

// ── (B1) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B1) over the REAL gateway: it answers /api/health itself (without `projectCreation`), passes the rules route to the backend — there mode is “container”", async () => {
  await withCreation(async ({ ctx }) => {
    const gw = await prepareSetup();
    try {
      // The gateway's fake docker reports the port of this test's REAL backend as the user container's port (as in operation).
      fs.writeFileSync(path.join(gw.state, "port"), String(new URL(ctx.base).port));
      const u = gw.users.createUser({ username: "maintainer", password: "correct-123" });
      const header = { cookie: `cbase_gw=${gw.users.createSession(u.id)}`, Connection: "close" };
      await gw.start();
      const health = await fetch(`${gw.base}/api/health`, { headers: header });
      const hb = await health.json();
      assert.equal(health.status, 200);
      assert.equal(hb.gateway, true, JSON.stringify(hb));
      assert.equal("projectCreation" in hb, false, `the gateway answers itself — the backend's field never arrives there: ${JSON.stringify(hb)}`);
      const r = await fetch(`${gw.base}/api/projectCreation/rules`, { headers: header });
      const rb = await r.json();
      assert.equal(r.status, 200, JSON.stringify(rb));
      assert.equal(rb.mode, "container", `the setup route arrives through the gateway: ${JSON.stringify(rb)}`);
      assert.ok(rb.omit && rb.limits && rb.names, "the answer is the backend's (rules), not an echo of the gateway");
      assert.equal(gw.alive(), true, gw.log());
    } finally { await gw.end(); }
  });
});

test("(B2) begin and finished while the container step RUNS => NOT_READY (not RUNNING), leaveOut stays RUNNING; afterwards it goes through", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const proj = await create(ctx, { name: "Early bird", sources: [{ kind: "files", target: "", bytes: 1 }] });
    const pid = proj.id;
    await fd.gateReached("exec");
    const e = store.setupOf(pid);
    assert.deepEqual([e.step, e.state, e.process], ["container", "setUp", BOOT_ID], "the container step is running");
    for (const what of ["begin", "finished"]) {
      const r = await source(ctx, pid, 1, what, { bytes: 1 });
      assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "NOT_READY", `${what}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await source(ctx, pid, 1, "leaveOut")).body.code, "RUNNING", "leaveOut keeps answering RUNNING");
    fd.openGate("exec");
    await inSources(pid);
    assert.equal((await source(ctx, pid, 1, "begin", { bytes: 1 })).status, 200);
    write(path.join(staging(proj, 1), "a.txt"), "a");
    assert.equal((await source(ctx, pid, 1, "finished")).status, 202);
    await finished(pid);
    assert.equal(read(path.join(proj.path, "a.txt")), "a");
  }, { fdOpts: { execGate: "exec" } });
});

// ── (B5) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B5) website/.git and website/themes/t/.git in ONE source: the inner repo is content — no CODE_REPO_LOCATION, both as uploaded", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "Website", sources: [{ kind: "folder", target: "website", bytes: 0 }] });
    const pid = proj.id;
    await inSources(pid);
    assert.equal((await source(ctx, pid, 1, "begin", { bytes: 0 })).status, 200);
    const b = staging(proj, 1);
    const outside = uploadedRepo(path.join(b, "website"));
    write(path.join(b, "website", "index.html"), "<p>hello</p>\n");
    const inside = uploadedRepo(path.join(b, "website", "themes", "t"));
    write(path.join(b, "website", "themes", "t", "theme.css"), "p {}\n");
    assert.equal((await source(ctx, pid, 1, "finished")).status, 202);
    await finished(pid, "website placed");
    assert.equal(git(path.join(proj.path, "website"), "rev-parse", "HEAD"), outside, "the outer repo as uploaded");
    assert.equal(git(path.join(proj.path, "website", "themes", "t"), "rev-parse", "HEAD"), inside, "the inner repo arrived as content");
    assert.equal(read(path.join(proj.path, "website", "index.html")), "<p>hello</p>\n");
    assert.equal(read(path.join(proj.path, "website", "themes", "t", "theme.css")), "p {}\n");
    assert.equal(fs.existsSync(staging(proj, 1)), false);
  });
});

// ── (B6) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B6) a target appears BETWEEN counting and placing: the uploaded file stays staged, recounted, the P6 question — nothing falls silently", async () => {
  await withCreation(async ({ ctx, pyGates }) => {
    const proj = await create(ctx, { name: "Late occupied", sources: [{ kind: "files", target: "", bytes: 4 }] });
    const pid = proj.id;
    await inSources(pid);
    assert.equal((await source(ctx, pid, 1, "begin", { bytes: 4 })).status, 200);
    write(path.join(staging(proj, 1), "a.txt"), "fresh");
    write(path.join(staging(proj, 1), "b.txt"), "b");
    pyHold(pyGates, "place");
    assert.equal((await source(ctx, pid, 1, "finished")).status, 202);
    await pyWaiting(pyGates, "place"); // counted: nothing at the target — the provisioner holds before placing
    assert.ok(!store.setupOf(pid).waiting, "counted without a conflict");
    fs.writeFileSync(path.join(proj.path, "a.txt"), "agent"); // a turn or agent kept running (P1) and wrote it just now
    pyContinue(pyGates, "place");
    await waitUntil(pid, (e) => e?.waiting === "conflict", "recounted, waits for a conflict answer");
    const view = await viewIn(ctx, pid);
    assert.deepEqual(view.setup.conflict, { existing: 1, examples: ["a.txt"] });
    assert.equal(read(path.join(staging(proj, 1), "a.txt")), "fresh", "the uploaded version is still staged");
    assert.equal(read(path.join(proj.path, "a.txt")), "agent", "the target is unchanged");
    assert.equal(read(path.join(proj.path, "b.txt")), "b", "what was free is placed");
    const r = await requestData(setupRoute(ctx.base, pid, "conflict"), { method: "POST", body: { mode: "overwrite" } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await finished(pid);
    assert.equal(read(path.join(proj.path, "a.txt")), "fresh", "the human decided: overwrite");
    assert.equal(fs.existsSync(staging(proj, 1)), false);
  });
});

// ── (B7) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B7) resume near the reserve: only what is still to come is required; if even that does not fit, SLOT including the rest", async () => {
  await withCreation(async ({ ctx, setFree }) => {
    const RESERVE = 5_000_000_000;
    const proj = await create(ctx, { name: "Resume", sources: [{ kind: "files", target: "", bytes: 10_000 }] });
    const pid = proj.id;
    await inSources(pid);
    setFree(RESERVE + 20_000);
    const first = await source(ctx, pid, 1, "begin", { bytes: 10_000, paths: [{ path: "part.bin" }] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // 8,000 bytes arrived, then the upload broke off — and they reduced the free space.
    write(path.join(staging(proj, 1), "part.bin"), Buffer.alloc(8_000, 1));
    setFree(RESERVE + 3_000);
    const gone = await source(ctx, pid, 1, "begin", { bytes: 10_000, paths: [{ path: "part.bin" }], operation: first.body.operation });
    assert.equal(gone.status, 200, `resume: only 2,000 bytes are missing — ${JSON.stringify(gone.body)}`);
    assert.deepEqual(gone.body.existing, [{ path: "part.bin", size: 8_000 }]);
    setFree(RESERVE + 1_000);
    const tight = await source(ctx, pid, 1, "begin", { bytes: 10_000, operation: first.body.operation });
    assert.equal(tight.status, 409, JSON.stringify(tight.body));
    assert.equal(tight.body.code, "SLOT");
    assert.equal(tight.body.needed, 2_000 + RESERVE, "needed is the rest plus the reserve");
    assert.equal(tight.body.free, RESERVE + 1_000);
  });
});

// ── (B8) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B8) workspace level: the lock computes paths like the routes that write (leading / and \\, dir with /, \\ in the upload, worktree relative to the repo)", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const proj = await create(ctx, { name: "Probe", sources: [{ kind: "files", target: "", bytes: 1 }] });
    const pid = proj.id;
    const slug = path.basename(proj.path);
    fd.openGate("exec");
    await inSources(pid);
    assert.equal((await source(ctx, pid, 1, "begin", { bytes: 1 })).status, 200);
    write(path.join(staging(proj, 1), "a.txt"), "a");
    fs.writeFileSync(path.join(proj.path, "old.txt"), "old");
    uploadedRepo(path.join(ctx.root, "workspace", "other")); // a neighbour repo in B, not a project
    gateClosed(fd, "exec");
    assert.equal((await source(ctx, pid, 1, "finished")).status, 202);
    await fd.gateReached("exec");
    await waitForTruthy(() => store.setupOf(pid)?.step === "place", "step place");

    locked(await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: `/${slug}/slash.txt`, content: "x" } }), pid, "leading slash");
    locked(await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: `\\${slug}/bs1.txt`, content: "x" } }), pid, "leading backslash");
    locked(await inWorkspace(ctx, "/files", { method: "DELETE", query: `path=${encodeURIComponent(`/${slug}/old.txt`)}` }), pid, "DELETE with slash");
    locked(await inWorkspace(ctx, "/upload", { method: "POST", body: { dir: `/${slug}`, files: [{ path: "dir.txt", dataB64: b64("d") }] } }), pid, "upload, dir with slash");
    locked(await inWorkspace(ctx, "/upload", { method: "POST", body: { dir: "", files: [{ path: `${slug}\\bs.txt`, dataB64: b64("b") }] } }), pid, "upload with backslash");
    locked(await inWorkspace(ctx, "/git/worktree", { method: "POST", body: { repo: "other", path: `../${slug}/wt`, branch: "wt", newBranch: true } }), pid, "worktree relative to the repo");
    for (const f of ["slash.txt", "bs1.txt", "dir.txt", "bs.txt", "wt"]) assert.equal(fs.existsSync(path.join(proj.path, f)), false, `${f} in the project`);
    assert.equal(read(path.join(proj.path, "old.txt")), "old", "nothing deleted");
    // Everything else stays open.
    const r = await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: "/outside.txt", content: "d" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(read(path.join(ctx.root, "workspace", "outside.txt")), "d");

    fd.openGate("exec");
    await finished(pid);
  }, { fdOpts: { execGate: "exec" } });
});

// ── (B14) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B14) deleting a workspace (docker stop at the gate): a setup POST => 409 WORKSPACE_GETS_DELETED; what slipped past it is cleaned up by the deletion", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const wsPath = path.join(ctx.root, "ws-delete");
    fs.mkdirSync(wsPath);
    const ws = (await requestData(`${ctx.base}/api/workspaces`, { method: "POST", body: { name: "Gets deleted", path: wsPath } })).body;
    const p1 = (await requestData(`${ctx.base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: { name: "Stays", sources: [] } })).body;
    await finished(p1.id);
    assert.equal(store.projectInstance(p1.id, "main")?.state, "ready");
    const erase = requestData(`${ctx.base}/api/workspaces/${ws.id}`, { method: "DELETE" });
    let open = true;
    try {
      await fd.gateReached("stop");
      const r = await requestData(`${ctx.base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: { name: "Too late", sources: [] } });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, "WORKSPACE_GETS_DELETED");
      assert.ok(!store.listAllProjects().some((p) => p.name === "Too late"), "no project was created");
      assert.equal(fs.existsSync(path.join(wsPath, "tooLate")), false, "no folder");
      // A project that slipped past this POST (another route): row and setup row directly in the store.
      const past = crypto.randomUUID();
      fs.mkdirSync(path.join(wsPath, "past"));
      store.addProject(ws.id, { id: past, name: "Slipped past", path: path.join(wsPath, "past"), createdAt: Date.now() });
      store.createSetup({ projectId: past, sources: [], codeRepos: [] });
      fd.openGate("stop");
      const d = await erase;
      open = false;
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.ok(!store.getProject(past), "the project is gone");
      assert.equal(store.setupOf(past), null, "its setup row went with it (deleteProjectbox over the fresh list)");
      assert.deepEqual(store.projectInstancesOf(p1.id), [], "the first project is cleaned up");
    } finally {
      if (open) { fd.openGate("stop"); await erase.catch(() => {}); }
    }
  }, { fdOpts: { stopGate: "stop" } });
});

// ── (B15) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B15) the write lock judges AFTER the body: open requests, the step begins, then the body => 409; git asks it again in its location", async () => {
  await withCreation(async ({ ctx, pyGates, gitGates }) => {
    const proj = await create(ctx, { name: "On the way", sources: [{ kind: "files", target: "", bytes: 1 }] });
    const pid = proj.id;
    const slug = path.basename(proj.path);
    await inSources(pid);
    assert.equal((await source(ctx, pid, 1, "begin", { bytes: 1 })).status, 200);
    write(path.join(staging(proj, 1), "a.txt"), "a");
    uploadedRepo(path.join(proj.path, "r")); // a repo in the project, without origin (git/fetch below)
    const open = [];
    let fetch = null;
    try {
      open.push(await openRequest(ctx, `/api/projects/${pid}/files/write`, "PUT"));
      open.push(await openRequest(ctx, `/api/workspaces/${ctx.ws.id}/upload`, "POST"));
      open.push(await openRequest(ctx, `/api/projects/${pid}/git/commit`, "POST"));
      // git/fetch passed the lock BEFORE the step and waits at `git remote get-url` (the access, before the action).
      gitHold(gitGates, "get-url");
      fetch = requestData(`${ctx.base}/api/projects/${pid}/git/fetch`, { method: "POST", body: { repo: "r" } });
      await gitWaiting(gitGates, "get-url");

      pyHold(pyGates, "place");
      assert.equal((await source(ctx, pid, 1, "finished")).status, 202);
      await pyWaiting(pyGates, "place");
      const e = store.setupOf(pid);
      assert.deepEqual([e.step, e.process], ["place", BOOT_ID], "the server step is running");

      const [file, up, commit] = open;
      locked(await file.end({ path: "inFlight.txt", content: "u" }), pid, "files/write with an open body");
      locked(await up.end({ dir: "", files: [{ path: `${slug}/up.txt`, dataB64: b64("h") }] }), pid, "workspace upload with an open body");
      locked(await commit.end({ repo: "r", message: "x" }), pid, "git/commit with an open body");
      gitContinue(gitGates, "get-url");
      locked(await fetch, pid, "git/fetch: the location asks the lock before the action");
      fetch = null;
      for (const f of ["inFlight.txt", "up.txt"]) assert.equal(fs.existsSync(path.join(proj.path, f)), false, `${f} in the project`);
      assert.deepEqual(git(path.join(proj.path, "r"), "log", "--format=%s").split("\n"), ["uploaded"], "no commit");
    } finally {
      for (const o of open) o.shutdown();
      if (fetch) { gitContinue(gitGates, "get-url"); await fetch.catch(() => {}); }
      if (fs.existsSync(path.join(pyGates, "waiting-place"))) pyContinue(pyGates, "place");
    }
    await finished(pid);
    assert.equal(read(path.join(proj.path, "a.txt")), "a");
  });
});

// ── (B17) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B17) ENOSPC mid-chunk => 409 SLOT with the specified wording (not 400 ENOSPC), the source stays wait-upload", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "Full", sources: [{ kind: "files", target: "", bytes: 3 }] });
    const pid = proj.id;
    await inSources(pid);
    const b = await source(ctx, pid, 1, "begin", { bytes: 3 });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    setChunkWriter(() => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28 }); });
    try {
      const r = await upload(ctx, pid, { files: [{ path: "a.txt", dataB64: b64("abc"), offset: 0 }] }, b.body.operation);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, "SLOT", JSON.stringify(r.body));
      assert.match(r.body.error, /Kein Platz mehr auf dem Datenträger des Servers|No space left on the server's disk/);
      assert.equal(r.body.path, "a.txt");
      assert.equal(r.body.written, 0);
    } finally { setChunkWriter(null); }
    assert.equal(store.sourceOf(pid, 1).state, "wait-upload");
    const further = await upload(ctx, pid, { files: [{ path: "a.txt", dataB64: b64("abc"), offset: 0 }] }, b.body.operation);
    assert.equal(further.status, 200, `after the space it continues: ${JSON.stringify(further.body)}`);
    assert.equal((await source(ctx, pid, 1, "finished")).status, 202);
    await finished(pid);
    assert.equal(read(path.join(proj.path, "a.txt")), "abc");
  });
});

// ── (B18) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(B18) all sources left out => finished WITHOUT services detection (empty project, P9)", async () => {
  await withCreation(async ({ ctx, detected }) => {
    const proj = await create(ctx, { name: "All gone", sources: [{ kind: "folder", target: "x", bytes: 1 }] });
    const pid = proj.id;
    await inSources(pid);
    const w = await source(ctx, pid, 1, "leaveOut");
    assert.equal(w.status, 202, JSON.stringify(w.body));
    await finished(pid, "finished without a source");
    assert.deepEqual(detected, [], "no services detection on an empty project");
    assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"], "the project repo is there");
  });
});
