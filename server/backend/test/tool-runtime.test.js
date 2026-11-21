// The 13 built-in tools of the own harness. They replicate Claude Code's toolbox and used to have NO test - exactly the layer where the
// silent defects sat.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BUILTIN_TOOL_NAMES, isBuiltinTool, killBackgroundShells, runBuiltinTool } from "../electron/server/providers/tool-runtime.js";
import { DIRS, setDirs } from "../electron/server/app-state.js";
import { setDescriptorSeam } from "../electron/server/runtime/real-path.js";

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-toolrt-"));
  return { root, ctx: { cwd: root, addDirs: [], env: process.env } };
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const run = (name, args, ctx) => runBuiltinTool(name, args, ctx);
// Wait for an event - without a deadline (no clock a test goes red on).
async function waitForTruthy(fn) { for (;;) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } }
// The operating marker (projectbox/ops.js projectboxOps) for the duration of `fn` - and afterwards the old state again.
async function inOps(fn) {
  const saved = { c: process.env.CBASE_CONTAINER, d: process.env.CBASE_DIND };
  process.env.CBASE_CONTAINER = "1";
  process.env.CBASE_DIND = "1";
  try { return await fn(); } finally {
    if (saved.c === undefined) delete process.env.CBASE_CONTAINER; else process.env.CBASE_CONTAINER = saved.c;
    if (saved.d === undefined) delete process.env.CBASE_DIND; else process.env.CBASE_DIND = saved.d;
  }
}

test("Toolbox: names and detection", () => {
  for (const n of ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite"]) {
    assert.ok(BUILTIN_TOOL_NAMES.includes(n), `${n} is missing in the toolbox`);
    assert.ok(isBuiltinTool(n));
  }
  assert.ok(!isBuiltinTool("Task")); // lives in the engine, not in the runtime
});

test("Write/Read/Edit/MultiEdit work like in Claude", async () => {
  const { root, ctx } = tmp();
  try {
    const file = path.join(root, "sub", "a.txt");
    const w = await run("Write", { file_path: file, content: "one\ntwo\nthree\n" }, ctx);
    assert.equal(w.isError, false);
    assert.ok(fs.existsSync(file), "Write creates missing folders");

    const r = await run("Read", { file_path: file }, ctx);
    assert.match(r.content, /1\tone/);
    assert.match(r.content, /3\tthree/);

    // offset/limit like in Claude (1-based)
    const part = await run("Read", { file_path: file, offset: 2, limit: 1 }, ctx);
    assert.match(part.content, /2\ttwo/);
    assert.ok(!/three/.test(part.content));

    // Edit demands uniqueness.
    fs.writeFileSync(file, "x\nx\n");
    const ambiguous = await run("Edit", { file_path: file, old_string: "x", new_string: "y" }, ctx);
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content, /not unique/);
    const all = await run("Edit", { file_path: file, old_string: "x", new_string: "y", replace_all: true }, ctx);
    assert.equal(all.isError, false);
    assert.equal(fs.readFileSync(file, "utf8"), "y\ny\n");

    // MultiEdit: several replacements in one call.
    fs.writeFileSync(file, "a\nb\n");
    const multi = await run("MultiEdit", { file_path: file, edits: [{ old_string: "a", new_string: "1" }, { old_string: "b", new_string: "2" }] }, ctx);
    assert.equal(multi.isError, false);
    assert.equal(fs.readFileSync(file, "utf8"), "1\n2\n");

    // A missing old_string is a tool ERROR, not a crash.
    const missing = await run("Edit", { file_path: file, old_string: "nonexistent", new_string: "z" }, ctx);
    assert.equal(missing.isError, true);
  } finally { rm(root); }
});

test("Path sandbox: file tools do not leave cwd and addDirs", async () => {
  const { root, ctx } = tmp();
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-extra-"));
  try {
    const outside = path.join(os.tmpdir(), "cbase-outside.txt");
    fs.writeFileSync(outside, "secret");
    const denied = await run("Read", { file_path: outside }, ctx);
    assert.equal(denied.isError, true);
    assert.match(denied.content, /outside the allowed area/);

    // ...not even through ..-paths.
    const traversal = await run("Read", { file_path: "../../etc/hosts" }, ctx);
    assert.equal(traversal.isError, true);

    // With addDir the same place is allowed.
    fs.writeFileSync(path.join(extra, "b.txt"), "ok");
    const allowed = await run("Read", { file_path: path.join(extra, "b.txt") }, { ...ctx, addDirs: [extra] });
    assert.equal(allowed.isError, false);
    assert.match(allowed.content, /ok/);
    fs.rmSync(outside, { force: true });
  } finally { rm(root); rm(extra); }
});

// With an instance the file tools check the REAL location (runtime/real-path.js). The agent's Bash then runs in the project container, the
// tools in B - a symlink it creates there would point at the neighbour project in B. The same holds WITHOUT an instance IN OPERATION
// (operating marker): a chat without a project works in B over the folders of converted projects. WITHOUT the operating marker - the local
// server - today's way stays: Read and Write follow the symlink. Counter-test against the old state: this test red - Read returns
// "NEIGHBOR-SECRET" even with an instance.
test("Symlink boundary: Read, Write, Edit, Grep and Glob follow no symlink out of the project - with an instance, in operation also without; the local server as today", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-symlink-"));
  const proj = path.join(base, "workspace", "till");
  const neighbor = path.join(base, "workspace", "depot");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(neighbor, { recursive: true });
  const secret = path.join(neighbor, "secret.txt");
  fs.writeFileSync(secret, "NEIGHBOR-SECRET\n");
  fs.writeFileSync(path.join(proj, "real.txt"), "OWN\n");
  fs.symlinkSync(path.join("..", "depot", "secret.txt"), path.join(proj, "link.txt"));   // file to the outside
  fs.symlinkSync(neighbor, path.join(proj, "linkdir"));                                  // folder to the outside (absolute)
  fs.symlinkSync(path.join("..", "depot", "fresh.txt"), path.join(proj, "dead.txt"));     // without a target, to the outside
  fs.symlinkSync("real.txt", path.join(proj, "internal.txt"));                           // staying inside is allowed
  fs.symlinkSync("loop-b", path.join(proj, "loop-a"));
  fs.symlinkSync("loop-a", path.join(proj, "loop-b"));
  // The working folder itself through a symlink (like /var -> /private/var on macOS): the roots are resolved likewise.
  const projOverLink = path.join(base, "project-link");
  fs.symlinkSync(proj, projOverLink);
  const today = { cwd: projOverLink, addDirs: [], env: process.env };
  const inProject = { ...today, instance: { projectId: "p1", instance: "main", identifier: "p1/main", ip: "10.230.0.2" } };
  const outside = (r) => { assert.equal(r.isError, true, r.content); assert.match(r.content, /leads out of the allowed area|outside the allowed area/); };
  try {
    // Read of a file that lies in the neighbour through a symlink.
    await inOps(async () => {
      const withoutInstance = await run("Read", { file_path: "link.txt" }, today);
      outside(withoutInstance);
      assert.ok(!withoutInstance.content.includes("NEIGHBOR-SECRET"), "in operation Read without an instance no longer follows the symlink");
      assert.match((await run("Read", { file_path: "internal.txt" }, today)).content, /OWN/, "without an instance: the symlink INSIDE the project works");
    });
    const r = await run("Read", { file_path: "link.txt" }, inProject);
    outside(r);
    assert.match(r.content, /symlink/);
    assert.ok(!r.content.includes("NEIGHBOR-SECRET"));
    outside(await run("Read", { file_path: path.join(projOverLink, "linkdir", "secret.txt") }, inProject));

    // Write to a NEW file under a symlink folder and through a symlink without a target: nothing appears in the neighbour.
    outside(await run("Write", { file_path: "linkdir/fresh.txt", content: "x" }, inProject));
    outside(await run("Write", { file_path: "dead.txt", content: "x" }, inProject));
    outside(await run("Write", { file_path: "linkdir/deep/fresh.txt", content: "x" }, inProject));
    assert.deepEqual(fs.readdirSync(neighbor), ["secret.txt"], "nothing created in the neighbour project");
    // Edit and MultiEdit through the symlink: the neighbour stays unchanged.
    outside(await run("Edit", { file_path: "link.txt", old_string: "SECRET", new_string: "WAY" }, inProject));
    outside(await run("MultiEdit", { file_path: "link.txt", edits: [{ old_string: "SECRET", new_string: "WAY" }] }, inProject));
    assert.equal(fs.readFileSync(secret, "utf8"), "NEIGHBOR-SECRET\n");
    // Grep and Glob with a symlink folder as the start.
    outside(await run("Grep", { pattern: "SECRET", path: "linkdir" }, inProject));
    outside(await run("Glob", { pattern: "*.txt", path: "linkdir" }, inProject));
    outside(await run("Grep", { pattern: "SECRET", path: "link.txt" }, inProject));
    // A loop has no location - rejected, not thrown.
    outside(await run("Write", { file_path: "loop-a/x.txt", content: "x" }, inProject));

    // Inside everything stays as it was: the symlink in the project, a new file in a new folder, Grep over the project.
    assert.match((await run("Read", { file_path: "internal.txt" }, inProject)).content, /OWN/);
    const w = await run("Write", { file_path: "fresh/under/a.txt", content: "FRESH" }, inProject);
    assert.equal(w.isError, false, w.content);
    assert.equal(fs.readFileSync(path.join(proj, "fresh", "under", "a.txt"), "utf8"), "FRESH");
    const g = await run("Grep", { pattern: "OWN|SECRET", output_mode: "files_with_matches" }, inProject);
    assert.ok(!g.content.includes("secret.txt"), `Grep over the project follows no symlink folder: ${g.content}`);
    // An addDir (runtime folder) is a root like the working folder.
    const runItem = path.join(base, "runtime");
    fs.mkdirSync(runItem);
    fs.writeFileSync(path.join(runItem, "attachment.txt"), "ATTACHMENT");
    assert.match((await run("Read", { file_path: path.join(runItem, "attachment.txt") }, { ...inProject, addDirs: [runItem] })).content, /ATTACHMENT/);

    // Writing without an instance in operation: the symlink folder no longer leads into the neighbour.
    await inOps(async () => {
      outside(await run("Write", { file_path: "linkdir/fresh.txt", content: "x" }, today));
      outside(await run("Edit", { file_path: "link.txt", old_string: "SECRET", new_string: "WAY" }, today));
    });
    assert.deepEqual(fs.readdirSync(neighbor), ["secret.txt"], "in operation without an instance nothing created in the neighbour project");
    assert.equal(fs.readFileSync(secret, "utf8"), "NEIGHBOR-SECRET\n");

    // The local server (no operating marker, no instance): today's way. Last, because the write really lands in the neighbour here.
    assert.match((await run("Read", { file_path: "link.txt" }, today)).content, /NEIGHBOR-SECRET/, "local: Read follows the symlink (today)");
    const localWrite = await run("Write", { file_path: "linkdir/fresh.txt", content: "x" }, today);
    assert.equal(localWrite.isError, false, `local: Write through the symlink folder (today): ${localWrite.content}`);
    assert.ok(fs.existsSync(path.join(neighbor, "fresh.txt")));
  } finally { rm(base); }
});

// Read WITHOUT an instance read a FIFO with readFileSync - synchronous, in B: the event loop stood until someone wrote into the FIFO
// (measured 1,861 ms; without a writer forever). Now it is opened non-blocking and rejected at the descriptor as "no regular file". The
// writer here delivers as soon as someone reads: against the old state its content comes back as the result (no hang, a red verdict),
// today never. Edit and Write likewise - neither waits. This holds in operation (operating marker); the local server keeps today's way.
test("A FIFO in the project is no file - Read, Edit and Write without an instance do not wait for it in operation and read nothing from it", async () => {
  const { root, ctx } = tmp();
  const fifo = path.join(root, "README.md");
  execFileSync("mkfifo", [fifo]);
  const writer = spawn("sh", ["-c", `printf FIFO-CONTENT > ${JSON.stringify(fifo)}`], { stdio: "ignore" });
  try {
    await inOps(async () => {
      const r = await run("Read", { file_path: "README.md" }, ctx);
      assert.equal(r.isError, true, `Read of a FIFO: ${r.content}`);
      assert.ok(!String(r.content).includes("FIFO-CONTENT"), `read from the FIFO: ${r.content}`);
      assert.match(r.content, /Not a regular file/);
      const e = await run("Edit", { file_path: "README.md", old_string: "FIFO", new_string: "X" }, ctx);
      assert.equal(e.isError, true, `Edit of a FIFO: ${e.content}`);
      // Grep over the folder skips it silently (like any other unreadable file).
      assert.equal((await run("Grep", { pattern: "FIFO-CONTENT" }, ctx)).content, "No matches.");
    });
  } finally {
    writer.kill("SIGKILL");
    rm(root);
  }
});

// The ROOTS themselves. Output location, attachment folder and worktree are ordinary subfolders of the rw-mounted runtime folder
// `<data>/projects/<pid>` - the project container can replace one of them by a link. Before, the realpath of the root applied:
// `outputs/chat1 -> depot` (or `-> /`) made the neighbour project (or all of B) a root. Now a root under the runtime folder only counts
// through the trusted anchor (runs/runtime-limit.js; here without a store only the runtime folder from DIRS), and a link in its place
// does not count at all. The data folder lies under os.tmpdir() - on macOS behind /var -> /private/var: the real root next to the link
// proves that the anchor is determined by realpath. Counter-test: this test red - Read returns "NEIGHBOR-SECRET" over the output location.
test("A root replaced by a link (with an instance): output location and worktree under the runtime folder then do not count - Read, Write, Edit, Glob and Grep reject; a real root there works", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-root-"));
  const data = path.join(base, "data");
  const proj = path.join(base, "workspace", "till");
  const neighbor = path.join(base, "workspace", "depot");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(neighbor, { recursive: true });
  const secret = path.join(neighbor, "secret.txt");
  fs.writeFileSync(secret, "NEIGHBOR-SECRET\n");
  const lz = path.join(data, "projects", "p1");
  const outputs = path.join(lz, "outputs", "chat1");
  const wholeB = path.join(lz, "outputs", "chat2");
  const attachments = path.join(lz, "attachments", "chat1");
  const worktree = path.join(lz, "worktrees", "wt1");
  fs.mkdirSync(path.dirname(outputs), { recursive: true });
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.mkdirSync(attachments, { recursive: true });
  fs.writeFileSync(path.join(attachments, "note.txt"), "ATTACHMENT");
  fs.symlinkSync(neighbor, outputs);   // the output location - replaced in the container by a link into the neighbour project
  fs.symlinkSync("/", wholeB);          // ... or onto the root of B
  fs.symlinkSync(neighbor, worktree);   // a worktree as cwd, likewise
  const inst = { projectId: "p1", instance: "main", identifier: "p1/main" };
  const today = { cwd: proj, addDirs: [attachments, outputs, wholeB], env: process.env };
  const inProject = { ...today, instance: inst };
  const outside = (r) => { assert.equal(r.isError, true, r.content); assert.match(r.content, /leads out of the allowed area|outside the allowed area/); assert.ok(!r.content.includes("NEIGHBOR-SECRET")); };
  const prior = DIRS;
  setDirs({ data });
  try {
    // Counter-check in the same test: without an instance Read follows the root (today).
    assert.match((await run("Read", { file_path: path.join(outputs, "secret.txt") }, today)).content, /NEIGHBOR-SECRET/);

    outside(await run("Read", { file_path: path.join(outputs, "secret.txt") }, inProject));
    outside(await run("Read", { file_path: path.join(wholeB, secret) }, inProject));
    outside(await run("Write", { file_path: path.join(outputs, "fresh.txt"), content: "x" }, inProject));
    outside(await run("Write", { file_path: path.join(wholeB, neighbor, "deep", "fresh.txt"), content: "x" }, inProject));
    outside(await run("Edit", { file_path: path.join(outputs, "secret.txt"), old_string: "SECRET", new_string: "WAY" }, inProject));
    outside(await run("Glob", { pattern: "*.txt", path: outputs }, inProject));
    outside(await run("Grep", { pattern: "SECRET", path: outputs }, inProject));
    assert.deepEqual(fs.readdirSync(neighbor), ["secret.txt"], "nothing created in the neighbour project");
    assert.equal(fs.readFileSync(secret, "utf8"), "NEIGHBOR-SECRET\n");

    // A worktree as cwd, replaced by a link: the cwd is no root any more.
    const inWorktree = { cwd: worktree, addDirs: [], env: process.env, instance: inst };
    outside(await run("Read", { file_path: "secret.txt" }, inWorktree));
    outside(await run("Grep", { pattern: "SECRET" }, inWorktree));
    outside(await run("Glob", { pattern: "*.txt" }, inWorktree));

    // A real root under the runtime folder stays one: read and write.
    assert.match((await run("Read", { file_path: path.join(attachments, "note.txt") }, inProject)).content, /ATTACHMENT/);
    const w = await run("Write", { file_path: path.join(attachments, "fresh", "x.txt"), content: "FRESH" }, inProject);
    assert.equal(w.isError, false, w.content);
    assert.equal(fs.readFileSync(path.join(attachments, "fresh", "x.txt"), "utf8"), "FRESH");
    assert.match((await run("Glob", { pattern: "*.txt", path: attachments }, inProject)).content, /note\.txt/);
    // A root that does not exist (yet) arises on writing as before - also through the descriptor.
    const missing = path.join(lz, "outputs", "chat3");
    const wf = await run("Write", { file_path: path.join(missing, "a", "b.txt"), content: "HERE" }, { ...inProject, addDirs: [missing] });
    assert.equal(wf.isError, false, wf.content);
    assert.equal(fs.readFileSync(path.join(missing, "a", "b.txt"), "utf8"), "HERE");
  } finally { setDirs(prior); rm(base); }
});

// Between check and access. resolveInSandbox used to check the real location and return the LITERAL path; Read/Write/Edit/Grep then
// resolved it anew. If a path part turns into a link into the neighbour project in between, B read or wrote there. Now they first open,
// check the location of the OPENED object and access through the descriptor (runtime/real-path.js). Two triggers for the swap `dir -> depot`:
//   (a) at the first realpath of the path - in the old state exactly the window between check and access; now the open still follows,
//       and the opened location lies outside: rejected.
//   (b) AFTER the open, when determining the location of the descriptor (Linux: readlink of /proc/self/fd/<fd>; without /proc - macOS -
//       the seam setDescriptorSeam as an F_GETPATH substitute: realpath of the path under which it was just opened). The original object
//       is still what is read and written.
// WHAT THE MAC RUN PROVES: the whole way through the descriptor (open, check the location of the opened object, read/write via fd, check
// the parent folder before creating, check the created file once more and remove it on a location outside). WHAT NOT: that
// `/proc/self/fd/<fd>` delivers the location and that `/proc/self/fd/<fd>/<name>` pins the checked folder - without /proc the creation
// goes through the path, (b) Write ends there with a rejection instead of a file in the old folder. On Linux (B, CI) the same test
// drives the real /proc way. COUNTER-TESTS: tool-runtime.js and runtime/real-path.js in the old state => (a) red (Read returns
// "NEIGHBOR", Write creates in the neighbour, Edit changes it, Grep finds it) and (b) red (the location is never determined after the
// open); sabotage "readInArea reads after the check over the path" => (b) Read red; sabotage "writeInArea does not check the created
// file" => (b) Write red (macOS).
test("TOCTOU with an instance: if a path part turns into a link into the neighbour project between check and access, Read, Write, Edit and Grep still never read or write there", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-toctou-"));
  const proj = path.join(base, "workspace", "till");
  const neighbor = path.join(base, "workspace", "depot");
  const dir = path.join(proj, "dir");
  const way = `${dir}-aside`;
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(neighbor, { recursive: true });
  fs.writeFileSync(path.join(dir, "file.txt"), "OWN\n");
  fs.writeFileSync(path.join(neighbor, "file.txt"), "NEIGHBOR\n");
  const ctx = { cwd: proj, addDirs: [], env: process.env, instance: { projectId: "p1", instance: "main", identifier: "p1/main" } };
  const swap = () => { fs.renameSync(dir, way); fs.symlinkSync(neighbor, dir); };
  const back = () => {
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dir);
    if (fs.existsSync(way)) fs.renameSync(way, dir);
  };
  const neighborUntouched = () => {
    assert.deepEqual(fs.readdirSync(neighbor), ["file.txt"], "nothing created in the neighbouring project");
    assert.equal(fs.readFileSync(path.join(neighbor, "file.txt"), "utf8"), "NEIGHBOR\n", "the neighbour is unchanged");
  };
  // (a) at the first realpath of the named path.
  const realNative = fs.realpathSync.native;
  let atRealpath = null;
  fs.realpathSync.native = function (p, ...r) {
    const out = realNative.call(this, p, ...r);
    if (atRealpath && path.resolve(String(p)) === atRealpath) { atRealpath = null; swap(); }
    return out;
  };
  // (b) after the open.
  let afterOpen = false;
  const afterTheOpen = () => { if (afterOpen) { afterOpen = false; swap(); } };
  const realReadlink = fs.readlinkSync;
  if (fs.existsSync("/proc/self/fd")) {
    fs.readlinkSync = function (p, ...r) { const out = realReadlink.call(this, p, ...r); if (String(p).startsWith("/proc/self/fd/")) afterTheOpen(); return out; };
  } else setDescriptorSeam((fd, p) => { const r = fs.realpathSync(p); afterTheOpen(); return r; });
  try {
    // (a) Read, Write, Edit, Grep.
    atRealpath = path.join(dir, "file.txt");
    const r = await run("Read", { file_path: path.join(dir, "file.txt") }, ctx);
    assert.ok(!r.content.includes("NEIGHBOR"), `(a) Read read in the neighbour: ${r.content}`);
    back();
    atRealpath = dir;
    await run("Write", { file_path: path.join(dir, "fresh.txt"), content: "X" }, ctx);
    back();
    neighborUntouched();
    atRealpath = path.join(dir, "file.txt");
    await run("Edit", { file_path: path.join(dir, "file.txt"), old_string: "\n", new_string: "\nCHANGED\n" }, ctx);
    back();
    neighborUntouched();
    atRealpath = dir;
    const g = await run("Grep", { pattern: "NEIGHBOR", path: dir }, ctx);
    assert.ok(!g.content.includes("NEIGHBOR"), `(a) Grep found in the neighbour: ${g.content}`);
    back();
    assert.equal(atRealpath, null, "(a) the swap took place");

    // (b) Read: the original object, through the descriptor.
    afterOpen = true;
    const rb = await run("Read", { file_path: path.join(dir, "file.txt") }, ctx);
    assert.equal(afterOpen, false, "(b) the location is determined at the opened descriptor");
    assert.equal(rb.isError, false, rb.content);
    assert.match(rb.content, /OWN/);
    assert.ok(!rb.content.includes("NEIGHBOR"));
    back();
    // (b) Write: never in the neighbour - with /proc in the pinned folder (now `dir-aside`), without it rejected and removed.
    afterOpen = true;
    const wb = await run("Write", { file_path: path.join(dir, "new2.txt"), content: "Y" }, ctx);
    assert.equal(afterOpen, false, "(b) the location of the parent folder is determined at the opened descriptor");
    assert.ok(!fs.existsSync(path.join(neighbor, "new2.txt")), `(b) Write created in the neighbour: ${wb.content}`);
    if (!wb.isError) assert.equal(fs.readFileSync(path.join(way, "new2.txt"), "utf8"), "Y");
    back();
    neighborUntouched();
    // (b) Edit: the own file is read and written.
    afterOpen = true;
    const eb = await run("Edit", { file_path: path.join(dir, "file.txt"), old_string: "OWN", new_string: "OWN2" }, ctx);
    assert.equal(eb.isError, false, eb.content);
    assert.equal(fs.readFileSync(path.join(way, "file.txt"), "utf8"), "OWN2\n");
    back();
    neighborUntouched();
  } finally {
    fs.realpathSync.native = realNative;
    fs.readlinkSync = realReadlink;
    setDescriptorSeam(null);
    rm(base);
  }
});

test("Read: images as an image block, notebooks as cells", async () => {
  const { root, ctx } = tmp();
  try {
    // A tiny valid PNG (1x1, transparent).
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const img = path.join(root, "image.png");
    fs.writeFileSync(img, png);
    const r = await run("Read", { file_path: img }, ctx);
    assert.equal(r.isError, false);
    assert.ok(Array.isArray(r.content), "images must come back as blocks, not as text");
    const image = r.content.find((b) => b.type === "image");
    assert.ok(image, "image block missing");
    assert.equal(image.source.media_type, "image/png");
    assert.equal(image.source.data, png.toString("base64"));

    const nb = path.join(root, "n.ipynb");
    fs.writeFileSync(nb, JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["# Titel"] },
        { cell_type: "code", source: ["print(1)\n"], outputs: [{ output_type: "stream", text: ["1\n"] }] },
      ],
    }));
    const nbr = await run("Read", { file_path: nb }, ctx);
    assert.match(nbr.content, /Cell 0 \(markdown\)/);
    assert.match(nbr.content, /Cell 1 \(code\)/);
    assert.match(nbr.content, /Output/);
  } finally { rm(root); }
});

test("Glob and Grep: patterns, output modes, context rows, multiline", async () => {
  const { root, ctx } = tmp();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "one\nHITS here\nthree\nfour\n");
    fs.writeFileSync(path.join(root, "src", "b.js"), "nix\nHITS there\n");
    fs.writeFileSync(path.join(root, "note.md"), "HITS in markdown\n");

    const g = await run("Glob", { pattern: "**/*.ts" }, ctx);
    assert.match(g.content, /a\.ts/);
    assert.ok(!/b\.js/.test(g.content));

    // Default: hit rows with a row number.
    const content = await run("Grep", { pattern: "HITS" }, ctx);
    assert.match(content.content, /a\.ts:2:HITS here/);

    // File names only.
    const files = await run("Grep", { pattern: "HITS", output_mode: "files_with_matches" }, ctx);
    assert.equal(files.content.split("\n").length, 3);
    assert.ok(!/HITS here/.test(files.content));

    // Count per file.
    const counts = await run("Grep", { pattern: "HITS", output_mode: "count", glob: "**/*.ts" }, ctx);
    assert.match(counts.content, /a\.ts:1/);

    // Context rows (-C) deliver neighbouring rows with a hyphen instead of a colon.
    const withCtx = await run("Grep", { pattern: "HITS", path: path.join(root, "src", "a.ts"), "-C": 1 }, ctx);
    assert.match(withCtx.content, /a\.ts-1-one/);
    assert.match(withCtx.content, /a\.ts:2:HITS here/);
    assert.match(withCtx.content, /a\.ts-3-three/);

    // File type filter instead of glob.
    const typed = await run("Grep", { pattern: "HITS", type: "js" }, ctx);
    assert.match(typed.content, /b\.js/);
    assert.ok(!/a\.ts/.test(typed.content));

    // Multiline: a pattern across the row boundary.
    const ml = await run("Grep", { pattern: "HITS here\\nthree", multiline: true, output_mode: "files_with_matches" }, ctx);
    assert.match(ml.content, /a\.ts/);
    const noMl = await run("Grep", { pattern: "HITS here\\nthree", output_mode: "files_with_matches" }, ctx);
    assert.match(noMl.content, /No matches/);

    // head_limit caps the output.
    const head = await run("Grep", { pattern: "HITS", output_mode: "files_with_matches", head_limit: 1 }, ctx);
    assert.equal(head.content.split("\n").length, 1);

    // An invalid RegExp is a tool error.
    const bad = await run("Grep", { pattern: "(" }, ctx);
    assert.equal(bad.isError, true);
  } finally { rm(root); }
});

test("Bash: foreground, exit code, background including lifecycle messages", async () => {
  const { root, ctx } = tmp();
  try {
    const ok = await run("Bash", { command: "echo hello" }, ctx);
    assert.equal(ok.isError, false);
    assert.match(ok.content, /hello/);

    const fail = await run("Bash", { command: "exit 3" }, ctx);
    assert.equal(fail.isError, true);
    assert.match(fail.content, /Exit code 3/);

    // Background: the messages are the reason why a run can stay open.
    const events = [];
    const bgCtx = { ...ctx, runId: "run-1", toolUseId: "tu-1", onBackgroundShell: (e) => events.push(e) };
    const bg = await run("Bash", { command: "echo one; sleep 0.2; echo two", run_in_background: true }, { ...bgCtx, detachAllowed: true });
    assert.equal(bg.isError, false);
    const id = bg.content.match(/bash_id: (\w+)/)[1];
    assert.equal(events[0].event, "started");
    assert.equal(events[0].toolUseId, "tu-1");

    // Wait for the end of the command, not for a duration: "exited" is reported by the runtime at the "close" of the process - then
    // its output has been read completely too.
    await waitForTruthy(() => events.some((e) => e.event === "exited" && e.id === id));
    const out = await run("BashOutput", { bash_id: id }, ctx);
    assert.match(out.content, /one/);
    assert.match(out.content, /two/);
    assert.match(out.content, /ended \(exit code 0\)/);
    // A second call returns only NEW (incremental like in Claude).
    const again = await run("BashOutput", { bash_id: id }, ctx);
    assert.match(again.content, /no fresh Output/);
    const exited = events.find((e) => e.event === "exited");
    assert.ok(exited, "the end of the background command must be reported");
    assert.equal(exited.exitCode, 0);

    // Filter on the output.
    const events2 = [];
    const bg2 = await run("Bash", { command: "printf 'aaa\\nbbb\\n'", run_in_background: true }, { ...({ ...ctx, runId: "run-1", onBackgroundShell: (e) => events2.push(e) }), detachAllowed: true });
    const id2 = bg2.content.match(/bash_id: (\w+)/)[1];
    await waitForTruthy(() => events2.some((e) => e.event === "exited" && e.id === id2));
    const filtered = await run("BashOutput", { bash_id: id2, filter: "^bbb" }, ctx);
    assert.match(filtered.content, /bbb/);
    assert.ok(!/aaa/.test(filtered.content));

    // An unknown ID is an error, not a crash.
    const unknown = await run("BashOutput", { bash_id: "nonexistent" }, ctx);
    assert.equal(unknown.isError, true);

    // KillShell ends a running command.
    const long = await run("Bash", { command: "sleep 30", run_in_background: true }, { ...({ ...ctx, runId: "run-1" }), detachAllowed: true });
    const id3 = long.content.match(/bash_id: (\w+)/)[1];
    const killed = await run("KillShell", { shell_id: id3 }, ctx);
    assert.equal(killed.isError, false);
  } finally {
    killBackgroundShells("run-1");
    rm(root);
  }
});

test("Bash: aborting the run ends the foreground process", async () => {
  const { root, ctx } = tmp();
  const controller = new AbortController();
  try {
    const p = run("Bash", { command: "sleep 20" }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await p;
    assert.equal(r.isError, true);
    assert.match(r.content, /Aborted/);
  } finally { rm(root); }
});

test("NotebookEdit: replace, insert, delete", async () => {
  const { root, ctx } = tmp();
  try {
    const nb = path.join(root, "n.ipynb");
    const write = (cells) => fs.writeFileSync(nb, JSON.stringify({ cells, nbformat: 4, nbformat_minor: 5, metadata: {} }));
    write([{ cell_type: "code", source: ["old\n"], outputs: [{ output_type: "stream", text: ["x"] }], execution_count: 1, metadata: {} }]);

    await run("NotebookEdit", { notebook_path: nb, cell_number: 0, new_source: "new\n" }, ctx);
    let doc = JSON.parse(fs.readFileSync(nb, "utf8"));
    assert.deepEqual(doc.cells[0].source, ["new\n"]);
    assert.deepEqual(doc.cells[0].outputs, [], "the output of a changed code cell is no longer valid");

    await run("NotebookEdit", { notebook_path: nb, cell_number: 0, new_source: "# md", cell_type: "markdown", edit_mode: "insert" }, ctx);
    doc = JSON.parse(fs.readFileSync(nb, "utf8"));
    assert.equal(doc.cells.length, 2);
    assert.equal(doc.cells[1].cell_type, "markdown");

    await run("NotebookEdit", { notebook_path: nb, cell_number: 1, new_source: "", edit_mode: "delete" }, ctx);
    doc = JSON.parse(fs.readFileSync(nb, "utf8"));
    assert.equal(doc.cells.length, 1);

    const oob = await run("NotebookEdit", { notebook_path: nb, cell_number: 9, new_source: "x" }, ctx);
    assert.equal(oob.isError, true);
  } finally { rm(root); }
});

test("An unknown tool ends as an error message, not as an exception", async () => {
  const { root, ctx } = tmp();
  try {
    const r = await run("ExistsNot", {}, ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /Unknown built-in tool/);
  } finally { rm(root); }
});

/**
 * `Read` on a PDF returns text AND the pages.
 *
 * Before, only the text extract existed - so a diagram, a table grid or a scan was invisible for every provider except the Claude CLI,
 * and a scanned PDF ended in "PDF without extractable text". The extract stays (cheap, searchable), the document block
 * complements it; what the provider can take of it is decided by `resultContentFor` in engine.js.
 */
test("Read on a PDF: text extract plus document block", async () => {
  const { root, ctx } = tmp();
  try {
    // A PDF whose text layer names the axes while the bars are DRAWN as rectangles - the case this is about: the statement is in the
    // picture, not in the text.
    const content = "q 0.2 0.35 0.8 rg 120 100 28 40 re f 200 100 28 150 re f Q\n"
      + "BT /F1 10 Tf 126 85 Td (Jan) Tj ET BT /F1 10 Tf 206 85 Td (Feb) Tj ET";
    const objs = [
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
      `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
      "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    ];
    const pdf = path.join(root, "utilization.pdf");
    fs.writeFileSync(pdf, Buffer.from(`%PDF-1.4\n${objs.join("\n")}\ntrailer << /Size 6 /Root 1 0 R >>\n%%EOF\n`, "latin1"));

    const r = await run("Read", { file_path: pdf }, ctx);
    assert.equal(r.isError, false, r.content);
    const blocks = Array.isArray(r.content) ? r.content : null;
    assert.ok(blocks, `Read must return blocks, not only text: ${String(r.content).slice(0, 200)}`);
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text, /Jan/, "the text extract stays next to it");
    const doc = blocks.find((b) => b.type === "document");
    assert.ok(doc, "the document block is missing - then a drawn diagram stays invisible");
    assert.equal(doc.source.media_type, "application/pdf");
    assert.equal(doc.name, "utilization.pdf");
    // The bytes must be the file, not a summary of it.
    assert.equal(Buffer.from(doc.source.data, "base64").subarray(0, 5).toString("latin1"), "%PDF-");
  } finally { rm(root); }
});

test("resultContentFor: the document block is replaced, not thrown away", async () => {
  const { resultContentFor } = await import("../electron/server/providers/engine.js");
  const docFrom = (pdf) => ({ type: "document", name: "x.pdf", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } });
  const withText = (pdf) => [{ type: "text", text: "PDF: /x.pdf\n\nJan Feb" }, docFrom(pdf)];

  // A PDF WITH an embedded JPEG (DCTDecode stream = JPEG file, byte for byte) and one without.
  let seed = 99;
  const fill = (n) => Buffer.from(Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 16) & 0xff;
  }));
  const jpegData = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), fill(9000)]);
  const withImage = Buffer.concat([
    Buffer.from("%PDF-1.5\n", "latin1"),
    Buffer.from(`1 0 obj << /Subtype /Image /Filter /DCTDecode /Length ${jpegData.length} >> stream\n`, "latin1"),
    jpegData, Buffer.from("\nendstream endobj\n%%EOF\n", "latin1"),
  ]);
  const withoutImage = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n", "latin1");

  // (a) Provider takes documents: the block stays unchanged.
  const can = resultContentFor(withText(withImage), { caps: { vision: true, documents: true } });
  assert.equal(can.filter((b) => b.type === "document").length, 1);

  // (b) Only images: the block is REPLACED by the embedded images - together with the notice that drawn diagrams are not contained in
  // them. Without that sentence the model would take the few images for the whole content.
  const onlyImages = resultContentFor(withText(withImage), { caps: { vision: true, documents: false } });
  assert.ok(Array.isArray(onlyImages), `with an embedded image blocks must remain: ${String(onlyImages).slice(0, 120)}`);
  assert.equal(onlyImages.some((b) => b.type === "document"), false, "no block the provider does not take");
  assert.equal(onlyImages.filter((b) => b.type === "image").length, 1, "the embedded image comes along");
  const text = onlyImages.map((b) => b.text || "").join("\n");
  assert.match(text, /DRAWN diagrams are NOT among them/);
  assert.match(text, /Jan Feb/, "the text extract stays");

  // (c) Only images, but the PDF contains none: then only text remains - folded, but WITH a notice.
  // Thrown away, the history would look like a completely read PDF.
  const empty = resultContentFor(withText(withoutImage), { caps: { vision: true, documents: false } });
  assert.equal(typeof empty, "string");
  assert.match(empty, /contains no embedded image/);
  assert.match(empty, /Jan Feb/);

  // (d) No images at all: everything folded to text, the notice stays, base64 does NOT land in the text.
  const blind = resultContentFor(withText(withImage), { caps: { vision: false, documents: false } });
  assert.equal(typeof blind, "string", "without vision it is folded");
  assert.match(blind, /cannot look at/);
  assert.equal(blind.includes(jpegData.subarray(0, 40).toString("base64").slice(0, 20)), false,
    "the base64 payload must NOT land in the text in the history");
});

// Read with an instance checks the size at the descriptor BEFORE reading. A sparse 1.9 GB file in the project (the container creates it
// with `truncate` in no time) was read completely by B just to report "too large" afterwards. The message stays the same; the read seam
// (fs.readFileSync/readSync counted) counts at most the cap. Without an instance as today. Counter-test: tool-runtime.js in the old state
// => red (1.9 GB counted).
test("read cap: Read with an instance - an image or text over the cap is not read, the message stays", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-read-cap-"));
  const proj = path.join(base, "workspace", "till");
  fs.mkdirSync(proj, { recursive: true });
  for (const n of ["image.png", "large.txt"]) { fs.writeFileSync(path.join(proj, n), ""); fs.truncateSync(path.join(proj, n), 1_900_000_000); }
  const ctx = { cwd: proj, addDirs: [], env: process.env, instance: { projectId: "p1", instance: "main", identifier: "p1/main", ip: "10.230.0.2" } };
  const old = { readFileSync: fs.readFileSync, readSync: fs.readSync };
  let bytes = 0;
  fs.readFileSync = function (p, ...rest) {
    try { bytes += (typeof p === "number" ? fs.fstatSync(p) : fs.statSync(p)).size; } catch { /* does not count */ }
    return old.readFileSync.call(fs, p, ...rest);
  };
  fs.readSync = function (...a) { const n = old.readSync.apply(fs, a); bytes += n; return n; };
  try {
    const image = await run("Read", { file_path: "image.png" }, ctx);
    const text = await run("Read", { file_path: "large.txt" }, ctx);
    fs.readFileSync = old.readFileSync; fs.readSync = old.readSync;
    assert.match(JSON.stringify(image.content), /Image too large \(1900000000 bytes/);
    assert.match(JSON.stringify(text.content), /File too large \(1900000000 bytes\)/);
    assert.ok(bytes <= 3_500_001 + 400_001, `${bytes} bytes read through the read seam`);
  } finally {
    fs.readFileSync = old.readFileSync; fs.readSync = old.readSync;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Two read paths stayed without a cap: Read on a PDF (measured: 200 MB sparse => rss +601 MB) and Grep per file. With an instance B now
// reads at most READ_MAX (the limit of the copy's pipeline, runtime/fileAccess.js): the PDF reports "too large", Grep skips the file and
// SAYS so; a small file beside it is found. Without an instance as today (Read and Grep read completely - shown here only on small
// files). COUNTER-TESTS: providers/tool-runtime.js in the old state => red (Read of the PDF: "Cannot create a string longer than …"
// instead of "too large"); only the Grep cap taken back => red (7.6 GB counted).
test("read cap (follow-up): PDF and Grep with an instance - a file over READ_MAX is not read, Grep says it skipped it", async () => {
  const { READ_MAX } = await import("../electron/server/runtime/fileAccess.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-read-cap2-"));
  const proj = path.join(base, "workspace", "till");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "large.pdf"), "%PDF-1.4\n");
  fs.truncateSync(path.join(proj, "large.pdf"), 1_900_000_000);
  fs.writeFileSync(path.join(proj, "large.log"), "SEARCH_WORD\n");
  fs.truncateSync(path.join(proj, "large.log"), 1_900_000_000);
  fs.writeFileSync(path.join(proj, "small.txt"), "one\nSEARCH_WORD here\n");
  const ctx = { cwd: proj, addDirs: [], env: process.env, instance: { projectId: "p1", instance: "main", identifier: "p1/main", ip: "10.230.0.2" } };
  const old = { readFileSync: fs.readFileSync, readSync: fs.readSync };
  let bytes = 0;
  fs.readFileSync = function (p, ...rest) {
    try { bytes += (typeof p === "number" ? fs.fstatSync(p) : fs.statSync(p)).size; } catch { /* does not count */ }
    return old.readFileSync.call(fs, p, ...rest);
  };
  fs.readSync = function (...a) { const n = old.readSync.apply(fs, a); bytes += n; return n; };
  try {
    const pdf = await run("Read", { file_path: "large.pdf" }, ctx);
    const pdfBytes = bytes;
    bytes = 0;
    const grep = await run("Grep", { pattern: "SEARCH_WORD", output_mode: "files_with_matches" }, ctx);
    const grepBytes = bytes;
    fs.readFileSync = old.readFileSync; fs.readSync = old.readSync;
    assert.match(JSON.stringify(pdf.content), /File too large \(1900000000 bytes\)/, JSON.stringify(pdf.content).slice(0, 300));
    assert.ok(pdfBytes <= READ_MAX + 1, `Read (PDF) las ${pdfBytes} Bytes`);
    const text = JSON.stringify(grep.content);
    assert.ok(grepBytes <= 2 * (READ_MAX + 1), `Grep las ${grepBytes} Bytes`);
    assert.match(text, /small\.txt/, "the small file with a hit is missing");
    assert.doesNotMatch(text, /large\.log/);
    assert.match(text, /2 files over \d+ bytes not searched/, `Grep does not say that it skipped: ${text}`);
    // Without an instance as today: no message, the small file is found (this way reads the large ones completely - not driven here).
    const flat = path.join(base, "flat");
    fs.mkdirSync(flat);
    fs.writeFileSync(path.join(flat, "small.txt"), "SEARCH_WORD\n");
    const g2 = JSON.stringify((await run("Grep", { pattern: "SEARCH_WORD", output_mode: "files_with_matches" }, { cwd: flat, addDirs: [], env: process.env })).content);
    assert.match(g2, /small\.txt/);
    assert.doesNotMatch(g2, /not searched/);
  } finally {
    fs.readFileSync = old.readFileSync; fs.readSync = old.readSync;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── Provider and loop engine ───────────────────────────────────────────────────────────────────────────────────

// Is the process still alive (not a zombie)? `ps` instead of kill(0): a just-killed process still sits in the table as a zombie.
function alive(pid) {
  try {
    const st = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return st !== "" && !st.startsWith("Z");
  } catch { return false; }
}
const waitTot = (pid) => waitForTruthy(() => !alive(pid));
const pidFrom = async (file) => Number(await waitForTruthy(() => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; } }));

// The deadline, abort, KillShell and the cleanup at run end only hit the shell - a grandchild lived on as an orphan, and if it held
// stdout, the tool call never returned at its deadline. In the old state the grandchild survives in (a) (the test waits forever for its
// death there - the gate's deadline turns it red; (b) would hang, (c)-(e) would survive as well).
// The death is WAITED for (`waitTot`), not checked at once: SIGKILL to the group is delivered when kill() returns, the grandchild is only
// dead when the kernel has reaped it - under load a little later. No time limit: the old state stays red.
test("Deadline, abort, KillShell and run end end the whole process group - no grandchild survives, the deadline returns", async () => {
  const { root, ctx } = tmp();
  const pids = [];
  const grandchild = (file) => `sleep 3600 >/dev/null 2>&1 & echo $! > ${JSON.stringify(file)}; wait`;
  try {
    // (a) The deadline: the shell waits for its grandchild.
    const a = await run("Bash", { command: grandchild(path.join(root, "a.pid")), timeout: 1000 }, ctx);
    const pidA = await pidFrom(path.join(root, "a.pid"));
    pids.push(pidA);
    assert.equal(a.isError, true, a.content);
    await waitTot(pidA);
    assert.match(a.content, /Deadline of 1000 ms expired/);

    // (b) A grandchild that LEAVES its group and holds stdout: the deadline returns anyway (it does not wait for `close`).
    const pidB = path.join(root, "b.pid");
    const b = await run("Bash", { command: `perl -e 'open(my $f, ">", $ARGV[0]); print $f $$; close $f; setpgrp(0, 0); sleep 3600' ${JSON.stringify(pidB)} & wait`, timeout: 1000 }, ctx);
    pids.push(await pidFrom(pidB));
    assert.match(b.content, /Deadline of 1000 ms expired/);

    // (c) The abort of the run.
    const ac = new AbortController();
    const running = run("Bash", { command: grandchild(path.join(root, "c.pid")) }, { ...ctx, signal: ac.signal });
    const pidC = await pidFrom(path.join(root, "c.pid"));
    pids.push(pidC);
    ac.abort();
    assert.match((await running).content, /Aborted/);
    await waitTot(pidC);

    // (d) KillShell of a background shell.
    const d = await run("Bash", { command: grandchild(path.join(root, "d.pid")), run_in_background: true }, { ...ctx, detachAllowed: true });
    const idD = /bash_id: (bash_[\w-]+)/.exec(d.content)[1];
    const pidD = await pidFrom(path.join(root, "d.pid"));
    pids.push(pidD);
    assert.equal((await run("KillShell", { shell_id: idD }, ctx)).isError, false);
    await waitTot(pidD);

    // (e) The cleanup at run end (killBackgroundShells with runId).
    await run("Bash", { command: grandchild(path.join(root, "e.pid")), run_in_background: true }, { ...({ ...ctx, runId: "run-m21" }), detachAllowed: true });
    const pidE = await pidFrom(path.join(root, "e.pid"));
    pids.push(pidE);
    killBackgroundShells("run-m21");
    await waitTot(pidE);
  } finally {
    for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } }
    rm(root);
  }
});

// A glob pattern with several `**` became nested `.*` - backtracking without a bound, synchronous in B, three times per file. The
// automaton needs at most length(pattern) x length(path) steps for every pattern. In the old state this glob hangs (minutes per path);
// the hits themselves are the same as before (the equality is held by fileAccess.test.js).
test("Glob with many ** is no backtracking without end - the same hits, at once", async () => {
  const { root, ctx } = tmp();
  try {
    const deep = path.join(root, ...Array.from({ length: 12 }, (_, i) => `folder-with-long-names-${i}`));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "one-file-with-long-names.js"), "x");
    fs.writeFileSync(path.join(deep, "target.ts"), "x");
    const r = await run("Glob", { pattern: "**/**/**/**/**/**/**/**/**/*.ts" }, ctx);
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /target\.ts/);
    assert.doesNotMatch(r.content, /one-file-with-long-names\.js/);
    // `[` and `{` apply literally (no character classes).
    fs.writeFileSync(path.join(root, "[a].md"), "x");
    assert.match((await run("Glob", { pattern: "[a].md" }, ctx)).content, /\[a\]\.md/);
    assert.equal((await run("Glob", { pattern: "{a,b}.md" }, ctx)).content, "No matches.");
  } finally { rm(root); }
});

// Grep and the BashOutput filter run a RegExp of the model. `(a+)+$` against a line of 40 `a` and a `!` needs 2^40 steps - in the old
// state B stands at this place (practically forever). Now the call ends at the deadline (`CBASE_REGEX_DEADLINE_MS`, small here) with a
// wording that says it was one; an ordinary pattern works as before.
test("A RegExp with backtracking without end ends at the deadline - Grep and BashOutput filter, B does not stand", async () => {
  const { root, ctx } = tmp();
  const saved = process.env.CBASE_REGEX_DEADLINE_MS;
  process.env.CBASE_REGEX_DEADLINE_MS = "300";
  try {
    const row = `${"a".repeat(40)}!`;
    fs.writeFileSync(path.join(root, "malicious.txt"), `${row}\nnormal\n`);
    const g = await run("Grep", { pattern: "^(a+)+$" }, ctx);
    assert.equal(g.isError, true, g.content);
    assert.match(g.content, /deadline of 300 ms/);
    assert.match((await run("Grep", { pattern: "normal", output_mode: "files_with_matches" }, ctx)).content, /malicious\.txt/);
    // Multiline goes the same way.
    assert.match((await run("Grep", { pattern: "^(a+)+$", multiline: true }, ctx)).content, /deadline of 300 ms/);

    // BashOutput: first wait until the shell is done (through its lifecycle message - a BashOutput would read the output away).
    let finished = false;
    const bg = await run("Bash", { command: `printf '%s\\nnormal\\n' ${row}`, run_in_background: true }, { ...({ ...ctx, onBackgroundShell: (e) => { if (e.event === "exited") finished = true; } }), detachAllowed: true });
    const id = /bash_id: (bash_[\w-]+)/.exec(bg.content)[1];
    await waitForTruthy(() => finished);
    const f = await run("BashOutput", { bash_id: id, filter: "^(a+)+$" }, ctx);
    assert.equal(f.isError, true, f.content);
    assert.match(f.content, /deadline of 300 ms/);
    // The output is not lost: without a filter it still comes.
    assert.match((await run("BashOutput", { bash_id: id }, ctx)).content, /normal/);
  } finally {
    if (saved === undefined) delete process.env.CBASE_REGEX_DEADLINE_MS; else process.env.CBASE_REGEX_DEADLINE_MS = saved;
    rm(root);
  }
});

// WebFetch WITHOUT an instance read the WHOLE body into memory (`arrayBuffer()`) and kept 2 MB afterwards (measured: 300 MB body =>
// +803 MB RSS). A body without end makes it visible: in the old state the fetch waits until its deadline (30 s) and ends as an error;
// now the page comes after the cap, and the stream is aborted.
test("WebFetch without an instance reads the body only up to the cap - an endless body returns the page, the server sees the abort", async () => {
  const http = await import("node:http");
  let aborted = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.write("BEGINNING-THE-PAGE\n");
    const block = "x".repeat(64 * 1024);
    let open = true;
    res.on("close", () => { open = false; aborted = true; });
    const pump = () => { while (open && res.write(block)) { /* until the buffer is full */ } if (open) res.once("drain", pump); };
    pump();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await run("WebFetch", { url: `http://127.0.0.1:${server.address().port}/endless-n19` }, { cwd: os.tmpdir(), addDirs: [], env: process.env });
    assert.equal(r.isError, false, String(r.content).slice(0, 300));
    assert.match(r.content, /BEGINNING-THE-PAGE/);
    await waitForTruthy(() => aborted);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// Before every built-in tool call the runtime yields to the event loop. The calls of a round followed each other as microtasks, and the
// tools run largely synchronously - gateway probes and SSE never got a turn between them. Measured without a clock: a `setImmediate`
// queued BEFORE the call runs before its body (the file does not exist yet); in the old state Write wrote synchronously in the same
// tick, and the file was already there.
test("A built-in tool call yields to the event loop first - a queued tick comes before its body", async () => {
  const { root, ctx } = tmp();
  try {
    const file = path.join(root, "tick.txt");
    let beforeTheBody = null;
    setImmediate(() => { beforeTheBody = !fs.existsSync(file); });
    const r = await run("Write", { file_path: file, content: "x" }, ctx);
    assert.equal(r.isError, false, r.content);
    assert.equal(beforeTheBody, true, "the queued tick only ran after the body of Write");
  } finally { rm(root); }
});
