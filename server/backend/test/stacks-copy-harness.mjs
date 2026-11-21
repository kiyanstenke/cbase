// Harness of the return-path guards (fetch, clear away) — NO test, only building blocks for
// server/backend/test/stacks-fetch.test.js and server/backend/test/stacks-clear-away.test.js (and the copy tests that import it).
//
// A copy `k1` through the real sequence up to `ready` (stacks/build.js through setCopyProcedure with the seams of the scenario),
// on the fake docker (server/backend/test/fake-docker.mjs) including the copy view: every `exec` into the copy container sees the
// overlays as local folders, and what it writes there lies afterwards in `layer/<part>` — like the kernel when writing. The
// return-path helper (stacks/returnPath.js) runs in the fake with the same paths as B; its program is the REAL python3.
//
// Building blocks:
//   withCopy(situation, fn, { ops, environment, claude })  server, scenario, fake docker including the main, `situation(b, ctx)`,
//                                  environment (opaque program, storage root, HOME) and the operating marks; `fn({ ctx, b })`.
//                                  Cleanup in the finally. `claude`: the fake main agent of the server (agent-harness fakeClaude)
//                                  for a test in which a REAL turn runs in the copy.
//   buildCopy(b, { name, chatId, base, baseInstance, overRequest })  through the sequence up to `ready`/`error` (`base` as in
//                                  copyRequests; `baseInstance`: the template — the fake clone then copies the daemon state of THAT
//                                  instance into that of the new copy; `overRequest`: through submitCopyRequest including the
//                                  pre-checks; `chatId`: the chat the copy belongs to — a real chat of the project when the test
//                                  needs its binding, otherwise an invented id).
//   b.clone.layerHold(phase = 1)  the next `cbase-clone layer --phase <phase>` stops after its copy until the test lets it go —
//                                  `{ reached(), further() }` (mark files, no timer in the test; the fake clone checks them in a
//                                  loop). After phase 1 a test writes into the template between phase 1 and the pause; in phase 2
//                                  it sees the pause and the lock of the template.
//   b.clone.prelude(text)         a piece of Python before every `python3 -c` of the helpers (the return-path program) — shows e.g. a
//                                  name macOS cannot create; `null` takes it back.
//   inCopy(b, cwd, …cmd)          a command IN the copy (docker exec -w — paths translated, the upper layer updated afterwards).
//   gitCopy(b, cwd, …args)        git IN the copy with an identity "agent".
//   writeInCopy(b, file, text)    write a file IN the copy (through the container, so it lands in the upper layer).
//   showThrough(b, rel, text)     a file that arises in the main AFTER the start of the copy and is visible in the copy through the
//                                  lower layer (the fake copies the lower layer at the start; this adds it as the kernel showed it —
//                                  it is NOT in the upper layer).
//   situationDefault(b, ctx)      project repo + code repo `app` (main, feature, `.gitignore` with `*.log` and `node_modules/`, an
//                                  ignored `old.log` in the main) + the main with an inner container.
//   refs(cwd, pattern), treeOf(cwd, rev), gitlinksIn(cwd, rev), returnPathCalls(b), nothingLeftOver(b, part)
//
// The clone program of the freeze (cbase-clone) is played in as in stacks-creation.test.js; every OTHER python3 call of a helper
// (the return-path program through executeHelper) goes through to the real python3.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { MAIN, PROJECTBOX_IMAGE, containerName, copyInstance, networkName, volumeName } from "../electron/server/projectbox/creation.js";
import { createProjectRepo } from "../electron/server/projectbox/projectRepo.js";
import { heavyLoadStatus } from "../electron/server/projectbox/heavyLoad.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { submitCopyRequest } from "../electron/server/stacks/request.js";
import { copyBuild } from "../electron/server/stacks/build.js";
import { CLONE_PROGRAM } from "../electron/server/stacks/freeze.js";
import { copyLocation } from "../electron/server/stacks/location.js";
import { buildAlive, wakeQueue, setCopyProcedure } from "../electron/server/stacks/queue.js";
import { RETURN_PATH_PROGRAM } from "../electron/server/stacks/returnPath.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker, copyView } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

const GIB = 1024 ** 3;
const REAL_PYTHON = execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();

export const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
export const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

export async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ── cbase-clone (stand-in; as in stacks-creation.test.js) and the real python3 for everything else ───────────────────────
function fakeClone(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "clone.jsonl");
  const js = path.join(dir, "clone.cjs");
  fs.writeFileSync(js, `const fs = require("fs"); const path = require("path");
const argv = process.argv.slice(2);
const [prog, cmd, ...rest] = argv;
if (prog !== ${JSON.stringify(CLONE_PROGRAM)}) {
  const vs = ${JSON.stringify(path.join(dir, "py-prelude.py"))};
  if (argv[0] === "-c" && fs.existsSync(vs)) argv[1] = fs.readFileSync(vs, "utf8") + "\\n" + argv[1];
  const r = require("child_process").spawnSync(${JSON.stringify(REAL_PYTHON)}, argv, { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv }) + "\\n");
const dir = ${JSON.stringify(dir)};
const m = Object.entries(JSON.parse(process.env.FAKE_DOCKER_MOUNTS || "{}")).sort((a, b) => b[0].length - a[0].length);
const local = (p) => { for (const [z, l] of m) { if (p === z) return l; if (p.startsWith(z + "/")) return l + p.slice(z.length); } return p; };
const pos = []; const listen = { "--volumes": [], "--again": [], "--upfront": [], "--reconcile": [] }; let phase = ""; let since = null; let akt = null;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--phase" || a === "--since") { const w = rest[++i]; if (a === "--phase") phase = w; else since = w; akt = null; continue; }
  if (a in listen) { akt = listen[a]; continue; }
  if (akt) akt.push(a); else pos.push(a);
}
const d = JSON.parse(fs.readFileSync(path.join(dir, "daemons.json"), "utf8"));
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const write = (f, z) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".neu", JSON.stringify(z)); fs.renameSync(f + ".neu", f); };
const vols = (w) => { try { return fs.readdirSync(path.join(w, "volumes")); } catch { return []; } };
const copy = (q, z, v) => { fs.rmSync(path.join(z, "volumes", v), { recursive: true, force: true }); fs.cpSync(path.join(q, "volumes", v), path.join(z, "volumes", v), { recursive: true }); };
if (cmd === "copy") {
  const q = local(pos[0]); const z = local(pos[1]);
  // Phase 1 takes the upfront volumes along and reports the beginning; phase 2 copies them anew as the reconciliation (the real
  // program reconciles — tools/check/clone-program.test.mjs).
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
} else if (cmd === "layer") {
  // The upper layers of the template — phase 1 copies (the target must not exist), phase 2 (only with --since) copies anew; the
  // real program reconciles (tools/check/clone-program.test.mjs). The hold mark (layerHold) after the copy of the phase.
  const q = local(pos[0]); const z = local(pos[1]);
  const count = (w) => { let n = 0; for (const e of fs.readdirSync(w, { withFileTypes: true })) { n++; if (e.isDirectory()) n += count(path.join(w, e.name)); } return n; };
  const hold = () => {
    const hold = path.join(dir, "layer-hold-" + phase);
    if (!fs.existsSync(hold)) return;
    fs.rmSync(hold);
    const finished = path.join(dir, "layer-finished-" + phase); const further = path.join(dir, "layer-continue-" + phase);
    fs.writeFileSync(finished, "");
    const tick = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(further)) Atomics.wait(tick, 0, 0, 20);
    fs.rmSync(further); fs.rmSync(finished);
  };
  if (phase === "1") {
    if (since !== null || fs.existsSync(z)) { process.stderr.write("fake-clone layer: phase 1 with --since or target present\\n"); process.exit(2); }
    const begin = BigInt(Date.now()) * 1000000n;
    fs.cpSync(q, z, { recursive: true, verbatimSymlinks: true });
    process.stdout.write("layer phase=1 entries=" + count(z) + " layer_error=0 layer_begin_ns=" + begin + "\\n");
    hold();
  } else {
    if (since === null || !fs.existsSync(z)) { process.stderr.write("fake-clone layer: phase 2 without --since or without phase 1\\n"); process.exit(2); }
    fs.rmSync(z, { recursive: true, force: true });
    fs.cpSync(q, z, { recursive: true, verbatimSymlinks: true });
    process.stdout.write("layer phase=2 entries=" + count(z) + "\\nreconcile replaced=0 fresh=0 deleted=0 folders=0\\n");
    hold();
  }
} else if (cmd === "list") {
  for (const v of listen["--volumes"]) process.stdout.write("volumes/" + v + "\\n");
} else if (cmd === "policy-protection") {
  const z = read(d.copy); const alt = {};
  for (const id of pos.slice(1)) { const c = z.container[id]; const [n, mm] = String((c && c.restart) || "no").split(":"); alt[id] = { Name: n || "no", MaximumRetryCount: n === "on-failure" && Number(mm) > 0 ? Number(mm) : 0 }; if (c) c.restart = ""; }
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
    // Python text BEFORE every `python3 -c` of the helpers (the return-path program) — shows e.g. a name macOS cannot create;
    // null takes it back.
    prelude: (text) => { const f = path.join(dir, "py-prelude.py"); if (text === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, text); },
    // The next `layer --phase <phase>` stops after its copy.
    layerHold: (phase = 1) => {
      fs.writeFileSync(path.join(dir, `layer-hold-${phase}`), "");
      return { reached: () => fs.existsSync(path.join(dir, `layer-finished-${phase}`)), further: () => fs.writeFileSync(path.join(dir, `layer-continue-${phase}`), "") };
    },
  };
}

const stateFile = (fd, daemon) => path.join(fd.dir, "daemon", encodeURIComponent(daemon), "state.json");

// The main with an inner container (the clone needs the state of an inner daemon).
function mainStart(b) {
  const pid = b.s.projectId;
  const cid = dx(b.fd, "run", "-d", "--name", b.main, "--label", `cbase.project=${pid}`, "--mount", `type=volume,src=${volumeName(pid)},dst=/var/lib/docker`, PROJECTBOX_IMAGE);
  store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([], { services: [] }), ip: "127.0.0.1" });
  dx(b.fd, "exec", b.main, "docker", "run", "-d", "--name", "web", "--restart", "always", "--mount", "type=volume,src=run,dst=/d", "img");
  fs.mkdirSync(b.fd.volumeData("run", b.main), { recursive: true });
  fs.writeFileSync(path.join(b.fd.volumeData("run", b.main), "content"), "data-run");
  b.cid = cid;
}

// Project repo + code repo `app`: main (a.txt, b.txt, c.txt, .gitignore), feature (f.txt); in the main `old.log` is ignored.
export async function situationDefault(b, ctx, { beforeCopy = null } = {}) {
  const q = path.join(ctx.root, `outside-${b.s.projectId}`, "source-app");
  fs.mkdirSync(q, { recursive: true });
  git(q, "init", "-q", "-b", "main");
  for (const f of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(q, f), `${f}\n`);
  fs.writeFileSync(path.join(q, ".gitignore"), "*.log\nnode_modules/\n");
  git(q, "add", ".");
  git(q, "commit", "-q", "-m", "one");
  const app = path.join(b.s.path, "app");
  git(b.s.path, "clone", "-q", q, "app");
  git(app, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(app, "f.txt"), "f\n");
  git(app, "add", "f.txt");
  git(app, "commit", "-q", "-m", "feature");
  git(app, "checkout", "-q", "main");
  fs.writeFileSync(path.join(app, "old.log"), "alt\n");
  fs.writeFileSync(path.join(b.s.path, "notes.md"), "Notizen\n");
  if (beforeCopy) await beforeCopy(b, app);
  const pr = await createProjectRepo(b.s.path);
  assert.equal(pr.created, true, JSON.stringify(pr));
  mainStart(b);
  b.app = app;
  b.start = { main: git(app, "rev-parse", "main"), feature: git(app, "rev-parse", "feature") };
}

function writeStorage(root) {
  const cg = path.join(root, "sys", "fs", "cgroup");
  fs.mkdirSync(cg, { recursive: true });
  fs.writeFileSync(path.join(cg, "memory.max"), `${8 * GIB}\n`);
  fs.writeFileSync(path.join(cg, "memory.current"), `${2 * GIB}\n`);
}

/** After every test: no copy lives any more, none stays working. */
export async function cleanUp() {
  await waitForTruthy(() => (store.liveStackCopies().some((k) => buildAlive(k)) ? null : true), "all builds finished");
  for (const k of store.liveStackCopies()) {
    if (["build", "ready", "clearAway"].includes(k.state)) { try { setCopyState(k.id, "error", { error: "end of test" }); } catch { /* already gone */ } }
    store.deleteProjectInstance(k.projectId, copyInstance(k.name));
    try { setCopyState(k.id, "removed"); } catch { /* already gone */ }
  }
  for (const z of store.projectInstances()) if (z.instance !== MAIN) store.deleteProjectInstance(z.projectId, z.instance);
}

// `claude`: the fake main agent of the server (agent-harness fakeClaude) — for a test in which a REAL turn runs in the copy.
export async function withCopy(situation, fn, { ops = true, environment = {}, claude = null } = {}) {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { projectId: crypto.randomUUID() }); // a UUID: the project routes recognise only such ids
    const clone = fakeClone(path.join(ctx.root, `clone-${s.projectId}`));
    const fd = await fakeDocker({ programs: { ...s.programs, python3: clone.python3 }, images: { [PROJECTBOX_IMAGE]: ID } });
    const b = { s, clone, fd, main: containerName(s.projectId), copy: containerName(s.projectId, copyInstance("k1")), opts: { home: s.home, system: s.system } };
    clone.daemons({ main: stateFile(fd, b.main), copy: stateFile(fd, b.copy) });
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-return-path-storage-"));
    writeStorage(storage);
    setCopyProcedure((a) => copyBuild(a, s.opts));
    try {
      await withEnvironment({ CBASE_COPY_OPAQUE_PROGRAM: clone.opaque, CBASE_STORAGE_ROOT: storage, HOME: s.home, ...environment }, async () => {
        await situation(b, ctx);
        return ops ? withOps(fd, () => fn({ ctx, b })) : fn({ ctx, b });
      });
    } finally {
      setCopyProcedure(copyBuild);
      await cleanUp();
      fd.cleanUp();
      fs.rmSync(storage, { recursive: true, force: true });
    }
  }, claude ? { claude } : {});
}

let chatSeq = 0;
export async function buildCopy(b, { name = "k1", chatId = null, base = null, baseInstance = MAIN, overRequest = false } = {}) {
  // `chatId`: the chat the copy belongs to — a real chat of the project when the test needs its binding (fence, file tools);
  // otherwise an invented id. `base`: a copy with a base (fetching a copy with a base). `baseInstance`: the fake clone copies the
  // daemon state of the source into that of the new copy. `overRequest`: through the whole request (stacks/request.js
  // submitCopyRequest — pre-checks including base, without a chat like a human) instead of directly.
  const pid = b.s.projectId;
  b.clone.daemons({ main: stateFile(b.fd, containerName(pid, baseInstance)), copy: stateFile(b.fd, containerName(pid, copyInstance(name))) });
  const k = overRequest
    ? await submitCopyRequest({ projectId: pid, name, chatId, base, baseInstance })
    : copyRequests({ projectId: pid, name, chatId: chatId || `chat-return-path-${++chatSeq}`, base, baseInstance });
  // A real chat is woken at the inset (stacks/inset.js) — the test holds a copy it works in without a wake turn running in
  // between: the mark of the wake call beforehand (as in stacks-inset.test.js).
  if (chatId) store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
  wakeQueue();
  await waitForTruthy(() => {
    const z = store.stackCopy(k.id);
    return ["ready", "error"].includes(z.state) && !buildAlive(z) ? z : null;
  }, `copy ${name} at the end`);
  const z = store.stackCopy(k.id);
  assert.equal(z.state, "ready", `Kopie ${z.state}: ${z.error}`);
  b.k = z;
  b.location = copyLocation({ data: DIRS.data, projectId: b.s.projectId, name });
  return z;
}

export const inCopy = (b, cwd, ...cmd) => dx(b.fd, "exec", "-w", cwd, b.copy, ...cmd);
export const gitCopy = (b, cwd, ...args) => inCopy(b, cwd, "git", "-c", "user.name=agent", "-c", "user.email=agent@copy.example.com", ...args);
/** Write a file IN the copy (through the container, so that it lands in the upper layer). */
export const writeInCopy = (b, file, text) => inCopy(b, path.dirname(file), "/bin/sh", "-c", 'printf "%s" "$1" > "$2"', "sh", text, path.basename(file));

export function showThrough(b, rel, text) {
  fs.writeFileSync(path.join(b.s.path, rel), text);
  const file = path.join(b.fd.dir, "copy-view", encodeURIComponent(b.copy), "state.json");
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const z = s.rows.find((x) => x.target === b.s.path);
  const m = path.join(z.m, rel);
  fs.writeFileSync(m, text);
  const st = fs.lstatSync(m);
  z.man[rel] = { id: `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}`, l: 1 };
  fs.writeFileSync(`${file}.neu`, JSON.stringify(s));
  fs.renameSync(`${file}.neu`, file);
}

/** The refs of a repo under a pattern: { name: oid }. */
export function refs(cwd, pattern = "refs/heads/copy") {
  const out = git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", pattern);
  return Object.fromEntries(out.split("\n").filter(Boolean).map((z) => z.split(" ")));
}
/** The paths in the tree of a commit (with mode). */
export const treeOf = (cwd, rev) => git(cwd, "ls-tree", "-r", "--full-tree", rev).split("\n").filter(Boolean).map((z) => { const [meta, p] = z.split("\t"); return `${meta.split(" ")[0]} ${p}`; });
/** Gitlinks (mode 160000) in EVERY commit reachable from `rev`. */
export function gitlinksIn(cwd, rev) {
  const out = [];
  for (const c of git(cwd, "rev-list", rev).split("\n").filter(Boolean)) for (const z of treeOf(cwd, c)) if (z.startsWith("160000 ")) out.push(`${c.slice(0, 8)} ${z}`);
  return out;
}

/** The calls of the return-path program in the argv of the fake docker: [{ command, rest, argv }]. */
export function returnPathCalls(b) {
  const out = [];
  for (const { args: a } of b.fd.calls()) {
    const i = a.indexOf(RETURN_PATH_PROGRAM);
    if (i > 0 && a[i - 1] === "-c") out.push({ command: a[i + 1], rest: a.slice(i + 2), argv: a });
  }
  return out;
}

/** Nothing is left of the copy. */
export function nothingLeftOver(b, part) {
  const pid = b.s.projectId;
  const z = b.fd.state();
  const inst = copyInstance("k1");
  assert.deepEqual(Object.values(z.container).filter((c) => c.labels?.["cbase.instance"] === inst || c.labels?.["cbase.helper"]).map((c) => c.name), [], `${part}: a container stayed`);
  assert.deepEqual(Object.values(z.networks).filter((n) => n.name === networkName(pid, inst)).map((n) => n.name), [], `${part}: the network stayed`);
  assert.equal(z.volumes[volumeName(pid, inst)], undefined, `${part}: the volume stayed`);
  assert.equal(fs.existsSync(copyLocation({ data: DIRS.data, projectId: pid, name: "k1" }).root.base), false, `${part}: the location stayed`);
  assert.equal(store.projectInstance(pid, inst), null, `${part}: the instance row stayed`);
  assert.equal(copyView(b.fd.dir, b.copy), null, `${part}: the view stayed (container never removed)`);
  assert.equal(heavyLoadStatus(), null, `${part}: the heavy load stayed occupied`);
}
