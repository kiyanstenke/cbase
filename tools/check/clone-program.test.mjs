// The clone program server/backend/cbase-clone (in the backend image under /usr/local/bin). server/backend/ lies in no glob of
// the gate, so the guard lives here. The real program runs under the python3 of the PATH against a fixture tree of a Docker folder
// (layers, layerdb, containers, logs, volumes, build cache, network).
//
// Promises:
//   - Phase 1 = every layer `overlay2/<id>` that the layerdb lists as finished (layerdb/sha256/*/cache-id), except `l` and the
//     writable container layers incl. `-init` (from layerdb/mounts/*/mount-id and init-id), plus ONLY the named volumes; a link
//     under overlay2 is never followed. A layer without cache-id (a pull or build is unpacking into it right now) goes to phase 2
//     — even one whose cache-id points to a container layer stays out.
//   - Phase 2 = the rest without `containers/*/*-json.log*`; `--again v` takes `volumes/v` back in; with `--target` every phase-1
//     layer that is missing in the target (created between the phases) is added.
//   - Union of both phases = everything except the logs, intersection empty (without --again).
//   - Layer ids come in two forms: 64 base-16 digits (moby) and 25 characters [0-9a-z] (BuildKit identity.NewID — every layer of an image built
//     with BuildKit, even after the image is deleted). A committed BuildKit layer goes to phase 1, a snapshot only in the build
//     cache (without cache-id) into the pause, and after both phases diff, link, lower and the link under l/ stand in the copy, the
//     lower chain of the container resolves.
//   - Broken inputs (missing volume, a name that would be a path, no layerdb, mount-id missing or not an id, a link instead of a
//     folder) => exit 1 with a message, no list. A layer id outside both forms (path trick even in the length of a real id, empty,
//     overlong, NUL, link form, -init on a cache-id) => exit 1, the message shortened and without control characters.
//   - `copy` calls EXACTLY ONCE per phase `cp -a --preserve=xattr --parents -t TARGET -- …` (as long as the list fits one chunk —
//     see the chunk section at the end) with cwd = source (seam CBASE_CLONE_CP, here a fake cp in Node that copies only the
//     structure — the fidelity of GNU cp (xattrs, whiteouts, sockets, owner) is an acceptance check on the server); after both
//     phases the target equals the source without logs, an --again volume without old leftovers, empty container folders are
//     there, mode of the root taken over; a second time never mixes; a missing phase-1 volume and a failing cp are errors.
//   - `copy --phase 1 … --upfront V…` takes running volumes along early and reports `upfront_begin_ns`; phase 2 with
//     `--reconcile V… --since T` compares the tree instead of copying it whole — ctime from T (with margin) or kind, size, mtime,
//     mode, owner, xattrs different => copied again (in the SAME cp), missing => created, surplus => deleted, hard-link groups
//     rebuilt, folder metadata last; afterwards the tree equals the source (hash over content, metadata, xattrs, links). Wrong
//     calls (`--reconcile` without `--since`, in phase 1, `--upfront` in phase 2, named twice) => exit 1 with a message.
//   - The upfront volumes go in their OWN cp after the phase-1 list; if the service deletes an entry meanwhile (fake cp: FAKE_CP_WAY,
//     message "cannot stat" and exit 1 like GNU cp), phase 1 is green with `upfront_error=1`, and after the reconcile the tree equals
//     the source; if a volume root folder is missing in the target afterwards => exit 1.
//   - `policy-protection` changes ONLY the named ids (the others byte-equal), prints the old values, checks everything first and
//     then writes (a broken second container leaves the first unchanged), follows no link.
//   - `fadvise`: on Linux it counts the regular files without links; without posix_fadvise (macOS) it is an error with a message.
//   - A list over one chunk (1,000 paths, 64 KiB argv) goes to cp in chunks — a change set over ARG_MAX runs through (layer and
//     copy --reconcile), groups sharing a file stay together, a too-large group becomes ONE file again in the target. Deletion
//     markers do not count via ctime.
// Counter-proofs (sabotaged copies of the program): without the exclusion of the container layers a writable layer stands in
// phase 1; without the cache-id check a half-unpacked layer stands in phase 1; without the log filter logs stand in phase 2;
// without --again the volume is missing; policy-protection over all containers changes a foreign one; only the old form (64 base-16 digits)
// breaks on the BuildKit layer; a layer id that takes any value lets the path tricks through — each red. Reconcile: without the
// ctime check, without the hardlink groups, without the folder metadata, without the xattr comparison the reconcile stays
// unequal — each red.
//
// Run:  node --test --test-reporter=tap tools/check/clone-program.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const CLONE = path.join(REPO, "server/backend/cbase-clone");

const id = (name) => crypto.createHash("sha256").update(name).digest("hex");
const IMG1 = id("image-1"), IMG2 = id("image-2");
const LA = id("level-a"), LB = id("level-b");
const CA = id("container-a"), CB = id("container-b"), CC = id("container-c");
const ANON = id("anon");
const HALF = id("half-unpacked"); // a layer an in-flight pull is unpacking into — still without cache-id
// BuildKit (moby worker, graphdriver adapter) puts every layer it builds under its snapshot key — identity.NewID(), 25 characters
// [0-9a-z] — and moby registers it on export under exactly that name: the cache-id IS this id, even after the image is deleted (the
// build cache holds the layer). BK1 is the id a real clone once aborted on ("is not a layer id"); BK2 the next stage of the same
// build; BKC a snapshot that stands only in the build cache (never exported, without cache-id) and therefore belongs in the pause like HALF.
const bk = (name) => BigInt(`0x${id(name)}`).toString(36).slice(-25).padStart(25, "0");
const BK1 = "wh5gx8o8oncmiwxfogmqtma43";
const BK2 = bk("buildkit-2"), BKC = bk("buildkit-cache");

function write(p, content = "") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// A Docker folder as the inner dockerd leaves it (overlay2 driver), small.
function fixture(base) {
  const q = path.join(base, "source");
  const f = (rel, content = rel) => write(path.join(q, rel), content);
  f("engine-id", "e1");
  f("buildkit/cache.db"); f("buildkit/history.db");
  fs.mkdirSync(path.join(q, "buildkit/content/ingest"), { recursive: true });
  f("image/overlay2/repositories.json", "{}");
  f(`image/overlay2/imagedb/content/sha256/${id("cfg")}`);
  f(`image/overlay2/layerdb/sha256/${id("chain1")}/cache-id`, IMG1);
  f(`image/overlay2/layerdb/sha256/${id("chain2")}/cache-id`, IMG2);
  f(`image/overlay2/layerdb/mounts/${CA}/mount-id`, LA);
  f(`image/overlay2/layerdb/mounts/${CA}/init-id`, `${LA}-init`);
  f(`image/overlay2/layerdb/mounts/${CB}/mount-id`, `${LB}\n`); // without init-id: the -init layer comes via mount-id
  f(`overlay2/${IMG1}/diff/usr/bin/tool`); f(`overlay2/${IMG1}/link`, "AAAA");
  f(`overlay2/${IMG2}/diff/etc/file`); f(`overlay2/${IMG2}/lower`, "l/AAAA");
  fs.mkdirSync(path.join(q, `overlay2/${IMG2}/work`), { recursive: true });
  // An image built with BuildKit (`docker compose build`): two layers over IMG1, both committed; the container LA runs on it (its
  // lower chain goes via the links of the BuildKit layers). The links and `lower` never carry a layer id.
  f(`image/overlay2/layerdb/sha256/${id("chain-bk1")}/cache-id`, BK1);
  f(`image/overlay2/layerdb/sha256/${id("chain-bk2")}/cache-id`, `${BK2}\n`);
  f(`overlay2/${BK1}/diff/app/package.json`, "{}"); f(`overlay2/${BK1}/link`, "CCCC"); f(`overlay2/${BK1}/lower`, "l/AAAA");
  fs.mkdirSync(path.join(q, `overlay2/${BK1}/work`), { recursive: true });
  f(`overlay2/${BK2}/diff/app/dist/index.js`); f(`overlay2/${BK2}/link`, "DDDD"); f(`overlay2/${BK2}/lower`, "l/CCCC:l/AAAA");
  fs.mkdirSync(path.join(q, `overlay2/${BK2}/work`), { recursive: true });
  f(`overlay2/${BKC}/diff/root/.cache/pip/wheel.whl`); f(`overlay2/${BKC}/link`, "EEEE"); f(`overlay2/${BKC}/lower`, "l/CCCC:l/AAAA");
  f(`overlay2/${LA}/diff/var/lib/postgresql/data/PG_VERSION`, "16"); f(`overlay2/${LA}/lower`, "l/BBBB:l/DDDD:l/CCCC:l/AAAA");
  f(`overlay2/${LA}-init/diff/etc/hosts`);
  f(`overlay2/${LB}/diff/tmp/x`);
  f(`overlay2/${LB}-init/diff/etc/hostname`);
  f(`overlay2/${HALF}/diff/usr/lib/half.so`, "half"); // without layerdb/sha256/*/cache-id
  fs.mkdirSync(path.join(q, "overlay2/l"), { recursive: true });
  fs.symlinkSync(`../${IMG1}/diff`, path.join(q, "overlay2/l/AAAA"));
  fs.symlinkSync(`../${BK1}/diff`, path.join(q, "overlay2/l/CCCC"));
  fs.symlinkSync(`../${BK2}/diff`, path.join(q, "overlay2/l/DDDD"));
  fs.symlinkSync(`../${BKC}/diff`, path.join(q, "overlay2/l/EEEE"));
  for (const c of [CA, CB]) {
    f(`containers/${c}/config.v2.json`, JSON.stringify({ ID: c }));
    f(`containers/${c}/hostconfig.json`, JSON.stringify({ RestartPolicy: { Name: "always", MaximumRetryCount: 0 }, Memory: 1073741824, Binds: null }));
    f(`containers/${c}/${c}-json.log`, "log\n");
  }
  f(`containers/${CA}/${CA}-json.log.1`, "old\n");
  f(`containers/${CA}/hostname`, "a");
  fs.mkdirSync(path.join(q, `containers/${CA}/mounts`), { recursive: true });
  f(`containers/${CC}/${CC}-json.log`, "only logs\n"); // a container folder that is empty without logs
  f("network/files/local-kv.db");
  f("volumes/metadata.db");
  f("volumes/pgdata/_data/PG_VERSION", "16"); f("volumes/pgdata/_data/base/1/1259", "page");
  f("volumes/cache/_data/x");
  f(`volumes/${ANON}/_data/y`);
  fs.mkdirSync(path.join(q, "tmp"), { recursive: true });
  fs.chmodSync(q, 0o710);
  return q;
}

// The fake cp: logs call and cwd, checks the form, copies with --parents semantics (ancestors with the source's mode), links as
// links, never over existing files.
const CP_CJS = `
const fs = require("fs");
const path = require("path");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CP_LOG, JSON.stringify({ cwd: process.cwd(), args: a }) + "\\n");
if (process.env.FAKE_CP_ERROR === "1") { process.stderr.write("cp: broken\\n"); process.exit(1); }
const i = a.indexOf("--");
const header = a.slice(0, i);
if (i < 0 || JSON.stringify(header.slice(0, 4)) !== JSON.stringify(["-a", "--preserve=xattr", "--parents", "-t"]) || header.length !== 5) {
  process.stderr.write("cp: wrong form " + JSON.stringify(a) + "\\n"); process.exit(2);
}
const target = header[4];
// Hard links WITHIN the call stay connected (like GNU cp); otherwise the system's \`cp -p\` per file, then \`touch -r\` per folder —
// times to the nanosecond, mode, links as links (the reconcile compares mtime_ns; fs.cpSync would not match it).
const { spawnSync } = require("child_process");
const seen = new Map();
const run = (prog, args) => { const r = spawnSync(prog, args, { stdio: "inherit" }); if (r.status !== 0) process.exit(r.status || 1); };
// FAKE_CP_WAY = a path (relative to the source) that "the service" deletes just before cp reads it — like GNU cp: message
// "cannot stat", keep copying, exit 1 at the end.
const wayPath = process.env.FAKE_CP_WAY || "";
let error = false;
function entry(q, z) {
  if (wayPath && q === wayPath) fs.rmSync(q, { recursive: true, force: true });
  try { copy(q, z); } catch (e) {
    if (e.code !== "ENOENT") throw e;
    process.stderr.write("cp: cannot stat '" + q + "': No such file or directory\\n");
    error = true;
  }
}
function copy(q, z) {
  const st = fs.lstatSync(q);
  if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(q), z); return; }
  if (st.isDirectory()) {
    fs.mkdirSync(z);
    for (const k of fs.readdirSync(q).sort()) entry(path.join(q, k), path.join(z, k));
    fs.chmodSync(z, st.mode & 0o7777);
    run("touch", ["-r", q, z]);
    return;
  }
  if (!st.isFile()) { process.stderr.write("cp: kind not reproduced " + q + "\\n"); process.exit(3); }
  const key = st.dev + ":" + st.ino;
  if (st.nlink > 1 && seen.has(key)) { fs.linkSync(seen.get(key), z); return; }
  run("cp", ["-p", q, z]);
  if (st.nlink > 1) seen.set(key, z);
}
for (const e of a.slice(i + 1)) {
  const parts = e.split("/");
  for (let k = 1; k < parts.length; k++) {
    const rel = parts.slice(0, k).join("/");
    const zp = path.join(target, rel);
    if (!fs.existsSync(zp)) { fs.mkdirSync(zp); fs.chmodSync(zp, fs.statSync(rel).mode & 0o7777); }
  }
  const zp = path.join(target, e);
  let exists = true; try { fs.lstatSync(zp); } catch { exists = false; }
  if (exists) { process.stderr.write("cp: already there " + zp + "\\n"); process.exit(1); }
  entry(e, zp);
}
if (error) process.exit(1);
`;

function build() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clone-"));
  const w = { base, source: fixture(base), target: path.join(base, "target"), cpLog: path.join(base, "cp.jsonl"), cp: path.join(base, "cp") };
  fs.mkdirSync(w.target, { mode: 0o755 });
  fs.writeFileSync(path.join(base, "cp.cjs"), CP_CJS);
  fs.writeFileSync(w.cp, `#!/bin/sh\nexec "$FAKE_NODE" "${path.join(base, "cp.cjs")}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(w.cpLog, "");
  return w;
}
const way = (w) => fs.rmSync(w.base, { recursive: true, force: true });

function clone(w, args, { program = CLONE, env = {} } = {}) {
  const r = spawnSync("python3", [program, ...args], {
    encoding: "utf8",
    // PYTHONDONTWRITEBYTECODE: never a __pycache__ next to the program in the repo.
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", CBASE_CLONE_CP: w.cp, FAKE_NODE: process.execPath, FAKE_CP_LOG: w.cpLog, ...env },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr, rows: r.stdout.split("\n").filter(Boolean) };
}
const list = (w, args, opts) => {
  const r = clone(w, ["list", ...args], opts);
  assert.equal(r.code, 0, r.err);
  return r.rows;
};

// All paths under `root` (relative), without following links: files, links and empty folders (the leaves).
function sheets(root, rel = "") {
  const p = path.join(root, rel);
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return [rel];
  const children = fs.readdirSync(p).sort();
  if (!children.length) return [rel];
  return children.flatMap((k) => sheets(root, rel ? `${rel}/${k}` : k));
}
const extended = (q, entries) => entries.flatMap((e) => sheets(q, e));
const isLog = (p) => /^containers\/[^/]+\/[^/]*-json\.log[^/]*$/.test(p);
// A tree as a comparable list: path, kind, content or link target.
function tree(root) {
  return sheets(root).filter(Boolean).map((rel) => {
    const p = path.join(root, rel);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return `${rel} -> ${fs.readlinkSync(p)}`;
    if (st.isDirectory()) return `${rel}/`;
    return `${rel} = ${fs.readFileSync(p, "utf8")}`;
  });
}

const PHASE1 = [`overlay2/${IMG1}`, `overlay2/${IMG2}`, `overlay2/${BK1}`, `overlay2/${BK2}`].sort().concat(["volumes/cache", "volumes/pgdata"]);
const CONTAINER_LEVELS = [LA, `${LA}-init`, LB, `${LB}-init`];

// The promises about phase 1 — as a function, so the same check turns red on a sabotage.
function checkPhase1(p1) {
  for (const e of CONTAINER_LEVELS) assert.ok(!p1.includes(`overlay2/${e}`), `writable layer ${e.slice(0, 8)}… in phase 1`);
  assert.ok(!p1.includes(`overlay2/${HALF}`), "a layer without cache-id (half unpacked) in phase 1");
  assert.ok(!p1.includes(`overlay2/${BKC}`), "a snapshot only in the build cache (without cache-id) in phase 1");
  for (const e of [BK1, BK2]) assert.ok(p1.includes(`overlay2/${e}`), `the committed BuildKit layer ${e.slice(0, 8)}… is missing from phase 1`);
  assert.ok(!p1.includes("overlay2/l"), "overlay2/l in phase 1");
  assert.deepEqual(p1, PHASE1);
}
function checkPhase2(w, p2, { again = [] } = {}) {
  assert.deepEqual(p2.filter(isLog), [], "logs in phase 2");
  for (const v of ["pgdata", "cache"]) assert.equal(p2.includes(`volumes/${v}`), again.includes(v), `volumes/${v} in phase 2: ${p2.includes(`volumes/${v}`)}`);
  for (const e of [...CONTAINER_LEVELS, "l", HALF, BKC]) assert.ok(p2.includes(`overlay2/${e}`), `overlay2/${e.slice(0, 8)} missing from phase 2`);
  for (const e of [IMG1, IMG2, BK1, BK2]) assert.ok(!p2.includes(`overlay2/${e}`), `the phase-1 layer ${e.slice(0, 8)}… also in phase 2`);
  for (const e of ["image", "buildkit", "network", "engine-id", "tmp", "volumes/metadata.db", `volumes/${ANON}`, `containers/${CA}/config.v2.json`, `containers/${CA}/mounts`]) {
    assert.ok(p2.includes(e), `${e} missing from phase 2`);
  }
}

test("list: phase 1 without container layers (incl. -init, also without init-id) and without overlay2/l, only with the named volumes", () => {
  const w = build();
  try {
    checkPhase1(list(w, ["--phase", "1", w.source, "--volumes", "pgdata", "cache"]));
    assert.deepEqual(list(w, ["--phase", "1", w.source]), PHASE1.filter((e) => !e.startsWith("volumes/")), "without --volumes no volume");
  } finally { way(w); }
});

test("list: phase 2 without logs; union = everything except logs, intersection empty; --again takes a phase-1 volume back in", () => {
  const w = build();
  try {
    const p1 = list(w, ["--phase", "1", w.source, "--volumes", "pgdata", "cache"]);
    const p2 = list(w, ["--phase", "2", w.source, "--volumes", "pgdata", "cache"]);
    checkPhase2(w, p2);
    const a1 = extended(w.source, p1), a2 = extended(w.source, p2);
    assert.deepEqual(a1.filter((x) => a2.includes(x)), [], "phase 1 and 2 overlap");
    const everything = sheets(w.source).filter((x) => !isLog(x));
    assert.deepEqual([...a1, ...a2].sort(), everything.sort(), "union ≠ everything except the logs");
    // The folder of the container that has only logs stands in no list — copy creates it empty (test "copy").
    assert.ok(!p2.some((e) => e === `containers/${CC}` || e.startsWith(`containers/${CC}/`)), "the log folder in phase 2");
    assert.ok(sheets(w.source).some(isLog), "the fixture has no logs");

    const p2n = list(w, ["--phase", "2", w.source, "--volumes", "pgdata", "cache", "--again", "pgdata"]);
    checkPhase2(w, p2n, { again: ["pgdata"] });
    assert.deepEqual(p2n.filter((e) => !p2.includes(e)), ["volumes/pgdata"]);
  } finally { way(w); }
});

test("list: with --target a phase-1 layer that is missing in the target (created between the phases) comes in phase 2", () => {
  const w = build();
  try {
    fs.mkdirSync(path.join(w.target, `overlay2/${IMG1}`), { recursive: true });
    const p2 = list(w, ["--phase", "2", w.source, "--target", w.target]);
    assert.ok(p2.includes(`overlay2/${IMG2}`), "the missing layer is missing");
    assert.ok(!p2.includes(`overlay2/${IMG1}`), "an already copied layer once more");
  } finally { way(w); }
});

test("list: a layer without cache-id stays out of phase 1 and comes in the pause — even if it is committed by then", () => {
  const w = build();
  try {
    assert.ok(!list(w, ["--phase", "1", w.source]).includes(`overlay2/${HALF}`), "half unpacked in phase 1");
    // Phase 1 ran (the finished layers in the target); then moby commits the layer (tx.Commit) — it is missing in the target and comes.
    for (const e of [IMG1, IMG2]) fs.mkdirSync(path.join(w.target, `overlay2/${e}`), { recursive: true });
    assert.ok(list(w, ["--phase", "2", w.source, "--target", w.target]).includes(`overlay2/${HALF}`), "still without cache-id: missing from phase 2");
    write(path.join(w.source, `image/overlay2/layerdb/sha256/${id("chain-half")}/cache-id`), HALF);
    const p2 = list(w, ["--phase", "2", w.source, "--target", w.target]);
    assert.ok(p2.includes(`overlay2/${HALF}`), "committed but not in the target: missing from phase 2");
    assert.ok(!p2.includes(`overlay2/${IMG1}`), "an already copied layer once more");
    // A cache-id that points to a container layer (broken or malicious) does not bring it into phase 1.
    write(path.join(w.source, `image/overlay2/layerdb/sha256/${id("chain-la")}/cache-id`), LA);
    const p1 = list(w, ["--phase", "1", w.source]);
    assert.ok(!p1.includes(`overlay2/${LA}`), "a container layer with cache-id in phase 1");
    assert.ok(p1.includes(`overlay2/${HALF}`), "the committed layer is missing from phase 1");
  } finally { way(w); }
});

test("list: a link under overlay2 is never followed and never taken as a layer in phase 1", () => {
  const w = build();
  try {
    const outside = path.join(w.base, "outside");
    fs.mkdirSync(outside);
    const link = id("link");
    fs.symlinkSync(outside, path.join(w.source, `overlay2/${link}`));
    assert.ok(!list(w, ["--phase", "1", w.source]).includes(`overlay2/${link}`));
    assert.ok(list(w, ["--phase", "2", w.source]).includes(`overlay2/${link}`), "the link is missing from phase 2 (copied as a link)");
  } finally { way(w); }
});

// Values in the layerdb from which the program makes layer names and that it must reject: path tricks (even in the length of a
// real id), empty, overlong, NUL, the form of a link under overlay2/l (26 characters [A-Z0-9]), a length next to it, "-init" on a
// cache-id. As a list with its own check, so the same check turns red on a too WIDE sabotage — the extension by the BuildKit form
// must not soften the defense.
const MOUNT_ID = `image/overlay2/layerdb/mounts/${CB}/mount-id`;
const CACHE_ID = `image/overlay2/layerdb/sha256/${id("chain1")}/cache-id`;
const BROKEN_IDS = [
  [MOUNT_ID, "../../etc", /mount-id: “\.\.\/\.\.\/etc” is not a layer id/],
  [CACHE_ID, "../../etc", /cache-id: “\.\.\/\.\.\/etc” is not a layer id/],
  [CACHE_ID, `../${BK1.slice(3)}`, /cache-id: “\.\.\/[0-9a-z]{22}” is not a layer id/], // 25 characters, but a path
  [CACHE_ID, `${BK1.slice(0, 12)}/${BK1.slice(13)}`, /is not a layer id/],
  [CACHE_ID, `${IMG1.slice(0, 32)}/${IMG1.slice(33)}`, /is not a layer id/], // 64 characters with a slash
  [MOUNT_ID, `../${LB.slice(3)}`, /mount-id: .* is not a layer id/],
  [MOUNT_ID, `${BK1.slice(0, 12)}/${BK1.slice(13)}`, /mount-id: .* is not a layer id/],
  [CACHE_ID, "", /cache-id: “” is not a layer id/],
  [MOUNT_ID, "", /mount-id: “” is not a layer id/],
  [CACHE_ID, "..", /is not a layer id/],
  [CACHE_ID, "l", /is not a layer id/],
  [CACHE_ID, "a".repeat(5000), /cache-id: “a{80}…” is not a layer id/], // the message does not carry the whole value
  [CACHE_ID, `${BK1.slice(0, 24)}\0`, /cache-id: “[0-9a-z]{24}\\x00” is not a layer id/],
  [MOUNT_ID, `${LB.slice(0, 63)}\0`, /is not a layer id/],
  [CACHE_ID, `${BK1}a`, /is not a layer id/], // 26
  [CACHE_ID, BK1.slice(1), /is not a layer id/], // 24
  [CACHE_ID, `${IMG1}0`, /is not a layer id/], // 65
  [CACHE_ID, BK1.toUpperCase(), /is not a layer id/],
  [CACHE_ID, "CCCCDDDDEEEEFFFFGGGGHHHH22", /is not a layer id/], // the form of a link under overlay2/l
  [CACHE_ID, `${IMG1}-init`, /cache-id: .* is not a layer id \(expected: .*never -init\)/],
  [CACHE_ID, `${BK1}-init`, /is not a layer id/],
  [MOUNT_ID, `${LB}-init-init`, /is not a layer id/],
  [MOUNT_ID, `${LB.slice(0, 40)}`, /is not a layer id/],
];
function checkBrokenIds(program = CLONE) {
  for (const [file, value, notice] of BROKEN_IDS) {
    const w = build();
    try {
      fs.writeFileSync(path.join(w.source, file), value);
      const r = clone(w, ["list", "--phase", "1", w.source], { program });
      assert.equal(r.code, 1, `${file.split("/").pop()} = ${JSON.stringify(value.slice(0, 40))}: Exit ${r.code} ${r.err}`);
      assert.match(r.err, notice);
      assert.ok(!r.err.includes("\0") && r.err.length < 600, `the message carries the foreign value raw: ${JSON.stringify(r.err.slice(0, 120))}`);
      assert.equal(r.out, "", "a list despite the error");
    } finally { way(w); }
  }
}

test("list: a layer id of neither form (path trick, empty, overlong, NUL, link form, -init on the cache-id) is exit 1", () => {
  checkBrokenIds();
});

test("list: broken inputs are exit 1 with a message, never a list", () => {
  const cases = [
    [(w) => ["--phase", "1", w.source, "--volumes", "nonexistent"], null, /Volume nonexistent is missing/],
    [(w) => ["--phase", "1", w.source, "--volumes", "../x"], null, /“\.\.\/x” is not a volume name/],
    [(w) => ["--phase", "2", w.source, "--again", "a/b"], null, /“a\/b” is not a volume name/],
    [(w) => ["--phase", "1", w.source, "--again", "pgdata"], null, /--again and --target exist only in phase 2/],
    [(w) => ["--phase", "1", w.source], (w) => fs.rmSync(path.join(w.source, "image/overlay2/layerdb"), { recursive: true }), /layerdb is missing/],
    [(w) => ["--phase", "1", w.source], (w) => fs.rmSync(path.join(w.source, `image/overlay2/layerdb/mounts/${CB}/mount-id`)), /mount-id is missing/],
    [(w) => ["--phase", "1", w.source], (w) => {
      const d = path.join(w.source, `image/overlay2/layerdb/mounts/${CB}`);
      fs.renameSync(d, `${d}.real`); fs.symlinkSync(`${d}.real`, d);
    }, /is not a folder/],
    [(w) => ["--phase", "1", path.join(w.base, "nonexistent")], null, /Source .* is not a folder/],
  ];
  for (const [args, prior, notice] of cases) {
    const w = build();
    try {
      if (prior) prior(w);
      const r = clone(w, ["list", ...args(w)]);
      assert.equal(r.code, 1, `${notice}: Exit ${r.code} ${r.err}`);
      assert.match(r.err, notice);
      assert.equal(r.out, "", "a list despite the error");
    } finally { way(w); }
  }
});

test("copy: ONE cp -a --preserve=xattr --parents -t TARGET -- … per phase from the source; afterwards the target equals the source without logs", () => {
  const w = build();
  try {
    const r1 = clone(w, ["copy", "--phase", "1", w.source, w.target, "--volumes", "pgdata", "cache"]);
    assert.equal(r1.code, 0, r1.err);
    assert.equal(r1.out, `phase=1 entries=${PHASE1.length}\n`);
    // Between the phases: a container starts and writes into pgdata (a new file, a deleted one) => --again.
    write(path.join(w.source, "volumes/pgdata/_data/pg_wal/0001"), "wal");
    fs.rmSync(path.join(w.source, "volumes/pgdata/_data/base/1/1259"));
    const r2 = clone(w, ["copy", "--phase", "2", w.source, w.target, "--volumes", "pgdata", "cache", "--again", "pgdata"]);
    assert.equal(r2.code, 0, r2.err);
    const calls = fs.readFileSync(w.cpLog, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z));
    assert.equal(calls.length, 2, "not exactly one cp per phase");
    for (const a of calls) {
      assert.equal(fs.realpathSync(a.cwd), fs.realpathSync(w.source), "cp not from the source");
      assert.deepEqual(a.args.slice(0, 6), ["-a", "--preserve=xattr", "--parents", "-t", w.target, "--"]);
    }
    assert.deepEqual(calls[0].args.slice(6), PHASE1);
    checkPhase2(w, calls[1].args.slice(6), { again: ["pgdata"] });
    // The target: the source without logs, the empty container folder there, pgdata without the deleted page, mode of the root.
    assert.deepEqual(tree(w.target).sort(), [...tree(w.source).filter((x) => !isLog(x.split(" ")[0])), `containers/${CC}/`].sort());
    assert.ok(fs.statSync(path.join(w.target, `containers/${CC}`)).isDirectory());
    assert.equal(fs.existsSync(path.join(w.target, "volumes/pgdata/_data/base/1/1259")), false, "old leftover in the --again volume");
    assert.equal(fs.statSync(w.target).mode & 0o7777, 0o710, "mode of the root not taken over");
    assert.equal(fs.readlinkSync(path.join(w.target, "overlay2/l/AAAA")), `../${IMG1}/diff`, "the link not as a link");
    // The BuildKit layers came in phase 1 (running), the snapshot only in the build cache in the pause — with diff, link, lower and
    // the link under l/, so the container's chain resolves in the copy.
    assert.ok(calls[0].args.includes(`overlay2/${BK1}`) && calls[0].args.includes(`overlay2/${BK2}`), "BuildKit layer not copied in phase 1");
    assert.ok(calls[1].args.includes(`overlay2/${BKC}`), "the build-cache snapshot not copied in phase 2");
    for (const [link, level] of [["CCCC", BK1], ["DDDD", BK2], ["EEEE", BKC]]) {
      assert.equal(fs.readlinkSync(path.join(w.target, `overlay2/l/${link}`)), `../${level}/diff`, `l/${link} missing or points elsewhere`);
      assert.equal(fs.readFileSync(path.join(w.target, `overlay2/${level}/link`), "utf8"), link);
    }
    assert.equal(fs.readFileSync(path.join(w.target, `overlay2/${LA}/lower`), "utf8"), "l/BBBB:l/DDDD:l/CCCC:l/AAAA");
    for (const l of fs.readFileSync(path.join(w.target, `overlay2/${LA}/lower`), "utf8").split(":").slice(1)) {
      assert.ok(fs.statSync(path.join(w.target, "overlay2", l)).isDirectory(), `${l} of the lower chain does not resolve in the copy`);
    }
    assert.equal(fs.readFileSync(path.join(w.target, `overlay2/${BK2}/diff/app/dist/index.js`), "utf8"), `overlay2/${BK2}/diff/app/dist/index.js`);
  } finally { way(w); }
});

test("list: BuildKit layers (cache-id = 25 characters [0-9a-z]) are layers — committed in phase 1, only in the build cache in the pause", () => {
  const w = build();
  try {
    // The image is deleted, the build cache holds the layer — its cache-id stays.
    fs.rmSync(path.join(w.source, `image/overlay2/imagedb/content/sha256/${id("cfg")}`));
    const r = clone(w, ["list", "--phase", "1", w.source, "--volumes", "pgdata", "cache"]);
    assert.equal(r.code, 0, `the BuildKit layer aborts the clone: ${r.err}`);
    checkPhase1(r.rows);
    checkPhase2(w, list(w, ["--phase", "2", w.source, "--volumes", "pgdata", "cache"]));
    // If the build-cache snapshot is exported between the phases (cache-id appears), the pause fetches it like any layer.
    for (const e of [IMG1, IMG2, BK1, BK2]) fs.mkdirSync(path.join(w.target, `overlay2/${e}`), { recursive: true });
    write(path.join(w.source, `image/overlay2/layerdb/sha256/${id("chain-bkc")}/cache-id`), BKC);
    const p2 = list(w, ["--phase", "2", w.source, "--target", w.target]);
    assert.ok(p2.includes(`overlay2/${BKC}`), "exported but not in the target: missing from phase 2");
    assert.ok(!p2.includes(`overlay2/${BK1}`), "an already copied BuildKit layer once more");
  } finally { way(w); }
});

test("list: a container layer in BuildKit form (mount-id) stays out like any container layer incl. -init", () => {
  const w = build();
  try {
    // By the sources moby hands out mount-ids only as 64 base-16 digits; accepting the BuildKit form there is the safe direction (one more
    // layer in the pause), rejecting it would break the clone. A cache-id that points to it does not bring it in.
    const cd = id("container-d"), bkm = bk("container-d-level");
    write(path.join(w.source, `image/overlay2/layerdb/mounts/${cd}/mount-id`), bkm);
    write(path.join(w.source, `image/overlay2/layerdb/mounts/${cd}/init-id`), `${bkm}-init`);
    write(path.join(w.source, `image/overlay2/layerdb/sha256/${id("chain-bkm")}/cache-id`), bkm);
    for (const e of [bkm, `${bkm}-init`]) write(path.join(w.source, `overlay2/${e}/diff/x`));
    const p1 = list(w, ["--phase", "1", w.source]);
    assert.ok(!p1.includes(`overlay2/${bkm}`) && !p1.includes(`overlay2/${bkm}-init`), "a writable layer in BuildKit form in phase 1");
    const p2 = list(w, ["--phase", "2", w.source]);
    assert.ok(p2.includes(`overlay2/${bkm}`) && p2.includes(`overlay2/${bkm}-init`), "the container layer is missing from phase 2");
  } finally { way(w); }
});

test("copy: never mixes (phase 1 twice), a missing phase-1 volume and a failing cp are exit 1", () => {
  const w = build();
  try {
    assert.equal(clone(w, ["copy", "--phase", "1", w.source, w.target, "--volumes", "pgdata"]).code, 0);
    const again = clone(w, ["copy", "--phase", "1", w.source, w.target, "--volumes", "pgdata"]);
    assert.equal(again.code, 1);
    assert.match(again.err, /already exists in the target — a clone never mixes/);
    const withoutVolume = clone(w, ["copy", "--phase", "2", w.source, w.target, "--volumes", "pgdata", "cache"]);
    assert.equal(withoutVolume.code, 1);
    assert.match(withoutVolume.err, /Phase-1 volume cache is missing in the target/);
    const broken = clone(w, ["copy", "--phase", "2", w.source, w.target, "--volumes", "pgdata"], { env: { FAKE_CP_ERROR: "1" } });
    assert.equal(broken.code, 1);
    assert.match(broken.err, /cp ended with 1 \(phase 2/);
    assert.equal(fs.readFileSync(w.cpLog, "utf8").split("\n").filter(Boolean).length, 2, "cp called despite the early error");
  } finally { way(w); }
});

// ── upfront copy of the running volumes and reconcile in the pause ─────────────────────────────────────────────────────
// A helper program in Python (written independently of the program): set xattrs (without following links), write content at the
// same mtime to the nanosecond, and the TREE HASH of a folder: per entry path, kind, mode, owner, size, mtime_ns (not for links),
// content, link target, xattrs, link count and the group of hard links (the first path of the same file).
const HELP_PY = String.raw`
import ctypes, ctypes.util, hashlib, os, stat, sys
def _libc():
    l = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    l.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int]; l.listxattr.restype = ctypes.c_ssize_t
    l.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]; l.getxattr.restype = ctypes.c_ssize_t
    l.setxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]; l.setxattr.restype = ctypes.c_int
    return l
def xattrs(p):
    if hasattr(os, "listxattr"):
        return sorted((n, os.getxattr(p, n, follow_symlinks=False).hex()) for n in os.listxattr(p, follow_symlinks=False))
    l = _libc(); b = os.fsencode(p)
    n = l.listxattr(b, None, 0, 1); buf = ctypes.create_string_buffer(max(n, 1)); n = l.listxattr(b, buf, n, 1)
    aus = []
    for name in [x for x in buf.raw[:n].split(b"\0") if x]:
        m = l.getxattr(b, name, None, 0, 0, 1); w = ctypes.create_string_buffer(max(m, 1)); m = l.getxattr(b, name, w, m, 0, 1)
        aus.append((name.decode(), w.raw[:m].hex()))
    return sorted(aus)
def set_xattr(p, name, value):
    if hasattr(os, "setxattr"): os.setxattr(p, name, value.encode(), follow_symlinks=False); return
    w = value.encode()
    if _libc().setxattr(os.fsencode(p), name.encode(), w, len(w), 0, 1) != 0: raise OSError(ctypes.get_errno(), "setxattr", p)
def tree(root):
    rows, groups = [], {}
    for location, folder, files in os.walk(root, followlinks=False):
        folder.sort()
        for n in [""] + sorted(files + folder) if location == root else sorted(files + folder):
            p = os.path.join(location, n) if n else location
            st = os.lstat(p); rel = os.path.relpath(p, root)
            z = [rel, oct(st.st_mode), str(st.st_uid), str(st.st_gid)]
            if stat.S_ISLNK(st.st_mode): z.append("-> " + os.readlink(p))
            else: z.append(str(st.st_mtime_ns))
            if stat.S_ISREG(st.st_mode):
                z += [str(st.st_size), hashlib.sha256(open(p, "rb").read()).hexdigest()[:16], "n=" + str(st.st_nlink)]
                if st.st_nlink > 1: z.append("group=" + groups.setdefault((st.st_dev, st.st_ino), rel))
            z.append(repr(xattrs(p)))
            rows.append(" ".join(z))
    return sorted(set(rows))
def content(p, fresh):
    st = os.lstat(p)
    with open(p, "wb") as f: f.write(fresh.encode())
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
command = sys.argv[1]
if command == "set": set_xattr(sys.argv[2], sys.argv[3], sys.argv[4])
elif command == "tree": print("\n".join(tree(sys.argv[2])))
elif command == "content": content(sys.argv[2], sys.argv[3])
`;
function help(w, ...args) {
  const p = path.join(w.base, "help.py");
  if (!fs.existsSync(p)) fs.writeFileSync(p, HELP_PY);
  const r = spawnSync("python3", [p, ...args], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// The reconcile situation: pgdata runs (upfront copy), cache is a phase-1 volume. Before phase 1: a group of hard links (one, two),
// a second (g1, g2), files that stay equal, and subfolders. Then phase 1 with --upfront, then changes in source AND target, each
// with the criterion that must catch it. Returns: the outputs of both phases and the tree hash of both sides.
const D = "volumes/pgdata/_data";
function reconcileSituation(w, { program = CLONE, moreEnv = {} } = {}) {
  const q = (rel) => path.join(w.source, D, rel);
  const z = (rel) => path.join(w.target, D, rel);
  for (const [rel, content] of [["one", "one"], ["g1", "group"], ["equal", "stays"], ["mode", "mode"], ["way", "way"], ["foreign-xattr", "fx"], ["under/u", "u"], ["zzz/z", "z"]]) write(q(rel), content);
  fs.linkSync(q("one"), q("two"));
  fs.linkSync(q("g1"), q("g2"));
  const env = { CBASE_CLONE_CTIME_MARGIN_NS: "0", ...moreEnv };
  const r1 = clone(w, ["copy", "--phase", "1", w.source, w.target, "--volumes", "cache", "--upfront", "pgdata"], { program, env });
  assert.equal(r1.code, 0, r1.err);
  const begin = (r1.out.match(/ upfront_begin_ns=(\d+)\n$/) || [])[1];
  assert.ok(begin, `phase 1 does not name the start of the upfront copy: ${r1.out}`);
  assert.equal(fs.statSync(z("two")).ino, fs.statSync(z("one")).ino, "phase 1 did not connect the hard links (fake cp)");

  // In the source, with the main running (between the phases):
  help(w, "content", q("PG_VERSION"), "17"); // same size, mtime reset to the ns — only the ctime sees it
  fs.rmSync(q("way"));
  write(q("fresh"), "fresh");
  fs.linkSync(q("one"), q("three")); // a new hard link: one/two change their link count (ctime), three is new
  fs.chmodSync(q("mode"), 0o600);
  help(w, "set", q("under"), "user.cbase", "folder"); // an xattr on a folder: only the folder metadata carry it
  // In the target (what does not belong there — the reconcile must not trust the upfront copy):
  write(z("only-in-target"), "x");
  help(w, "set", z("foreign-xattr"), "user.foreign", "x"); // source unchanged (old ctime) — only the xattr comparison sees it
  // The group g1/g2 split in the target: two files of equal content and times, each with a foreign hard link — the link count is
  // right (2), the times are right; only the group says it is not ONE file.
  fs.rmSync(z("g2"));
  assert.equal(spawnSync("cp", ["-p", z("g1"), z("g2")]).status, 0);
  fs.linkSync(z("g1"), z("zzz/x"));
  fs.linkSync(z("g2"), z("zzz/y"));

  const r2 = clone(w, ["copy", "--phase", "2", w.source, w.target, "--volumes", "cache", "--reconcile", "pgdata", "--since", begin], { program, env });
  return { r1, r2, source: help(w, "tree", path.join(w.source, "volumes/pgdata")), target: help(w, "tree", path.join(w.target, "volumes/pgdata")) };
}

test("upfront copy (phase 1 --upfront) and reconcile in the pause (--reconcile --since) => same tree, only the changes counted, ONE cp in the pause", () => {
  const w = build();
  try {
    const a = reconcileSituation(w);
    assert.equal(a.r2.code, 0, a.r2.err);
    // replaced: PG_VERSION (ctime), one + two (link count, ctime), mode, foreign-xattr (xattr), g1 + g2 (group); new: fresh, three;
    // deleted: way, only-in-target, zzz/x, zzz/y; folders: _data, under (xattr), zzz. Not counted: equal, base/1/1259, pgdata.
    assert.match(a.r2.out, /\nreconcile replaced=7 fresh=2 deleted=4 folders=3\n$/);
    assert.deepEqual(a.target.split("\n"), a.source.split("\n"), "after the reconcile the volume of the copy does not equal the source");
    // Phase 1: the list, THEN the upfront volumes in their own cp (its messages are tolerated). Phase 2 does NOT copy pgdata anew
    // (no full copy in the pause) — the reconcile entries stand in the same, single cp.
    const calls = fs.readFileSync(w.cpLog, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z));
    assert.equal(calls.length, 3, "not list + upfront volumes in phase 1 and exactly one cp in the pause");
    assert.ok(calls[0].args.includes("volumes/cache") && !calls[0].args.includes("volumes/pgdata"), "the upfront volume in the cp of the list");
    assert.deepEqual(calls[1].args.slice(6), ["volumes/pgdata"], "the upfront volumes not in their own cp after the list");
    assert.match(a.r1.out, / upfront_error=0 upfront_begin_ns=\d+\n$/);
    const p2 = calls[2].args.slice(6);
    assert.ok(!p2.includes("volumes/pgdata"), "pgdata copied whole in the pause");
    assert.deepEqual(p2.filter((e) => e.startsWith("volumes/pgdata/")).sort(),
      ["three", "one", "foreign-xattr", "g1", "g2", "mode", "fresh", "PG_VERSION", "two"].map((n) => `${D}/${n}`).sort());
    assert.ok(!p2.includes(`${D}/equal`), "an unchanged file copied");
    // The reconcile volume does not stand in the phase-2 list (list speaks the same language).
    assert.ok(!list(w, ["--phase", "2", w.source, "--volumes", "cache", "--reconcile", "pgdata", "--since", "1"]).includes("volumes/pgdata"));
  } finally { way(w); }
});

test("wrong calls of the upfront copy are exit 1 with a message (without --since, roles twice, phase swapped, target without upfront copy)", () => {
  const cases = [
    [["copy", "--phase", "2", "Q", "Z", "--reconcile", "pgdata"], /--reconcile without --since/],
    [["copy", "--phase", "1", "Q", "Z", "--volumes", "pgdata", "--upfront", "pgdata"], /--volumes and --upfront both name pgdata/],
    [["copy", "--phase", "2", "Q", "Z", "--again", "pgdata", "--reconcile", "pgdata", "--since", "1"], /--again and --reconcile both name pgdata/],
    [["copy", "--phase", "1", "Q", "Z", "--reconcile", "pgdata", "--since", "1"], /--reconcile and --since exist only in phase 2/],
    [["copy", "--phase", "2", "Q", "Z", "--upfront", "pgdata"], /--upfront exists only in phase 1/],
    [["copy", "--phase", "2", "Q", "Z", "--reconcile", "pgdata", "--since", "1"], /Reconcile volume pgdata is missing in the target/],
    [["copy", "--phase", "1", "Q", "Z", "--upfront", "../x"], /“\.\.\/x” is not a volume name/],
  ];
  for (const [args, notice] of cases) {
    const w = build();
    try {
      const r = clone(w, args.map((a) => (a === "Q" ? w.source : a === "Z" ? w.target : a)));
      assert.equal(r.code, 1, `${notice}: Exit ${r.code} ${r.err}`);
      assert.match(r.err, notice);
    } finally { way(w); }
  }
});

// ── the upfront copy runs next to a live service ────────────────────────────────────────────────────────────────────────
// A service deletes or renames between readdir and lstat (SQLite journal, Redis temp-*.rdb, WAL recycling): GNU cp reports
// "No such file or directory", keeps copying and ends with 1. The upfront volume used to stand in the cp of the phase-1 list, and
// every exit ≠ 0 made the clone fail. Now: its own cp, tolerated and counted, the reconcile of the pause creates what is missing —
// the tree equals the source. Only a missing volume root folder stays exit 1.
test("if the service deletes an entry during the upfront copy, phase 1 is green (upfront_error=1), and the reconcile of the pause brings the tree to the source; a missing volume root folder stays exit 1", () => {
  const w = build();
  try {
    const q = (rel) => path.join(w.source, D, rel);
    write(q("journal"), "j1");
    write(q("stays"), "b");
    const env = { CBASE_CLONE_CTIME_MARGIN_NS: "0" };
    const r1 = clone(w, ["copy", "--phase", "1", w.source, w.target, "--volumes", "cache", "--upfront", "pgdata"], { env: { ...env, FAKE_CP_WAY: `${D}/journal` } });
    assert.equal(r1.code, 0, `phase 1 failed on an entry the service deleted: ${r1.err}`);
    const m = / upfront_error=(\d+) upfront_begin_ns=(\d+)\n$/.exec(r1.out);
    assert.ok(m, `phase 1 does not name error count and start of the upfront copy: ${r1.out}`);
    assert.equal(m[1], "1");
    assert.match(r1.err, /up-front copy: cp ended with 1, 1 message\(s\) — tolerated, the reconciliation in the pause reconciles; the first: cp: cannot stat/);
    assert.equal(fs.existsSync(path.join(w.target, D, "journal")), false, "precondition: the deleted journal is missing in the target");
    assert.equal(fs.readFileSync(path.join(w.target, D, "stays"), "utf8"), "b", "cp did not keep copying after the message");
    assert.ok(fs.existsSync(path.join(w.target, "volumes/cache/_data/x")), "the phase-1 list is missing");
    // Between the phases the service creates the journal anew; in the pause phase 2 reconciles.
    write(q("journal"), "j2");
    const r2 = clone(w, ["copy", "--phase", "2", w.source, w.target, "--volumes", "cache", "--reconcile", "pgdata", "--since", m[2]], { env });
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /\nreconcile replaced=0 fresh=1 deleted=0 folders=\d+\n$/);
    assert.deepEqual(help(w, "tree", path.join(w.target, "volumes/pgdata")).split("\n"), help(w, "tree", path.join(w.source, "volumes/pgdata")).split("\n"),
      "after the reconcile the volume of the copy does not equal the source");
  } finally { way(w); }
  const w2 = build();
  try {
    const r = clone(w2, ["copy", "--phase", "1", w2.source, w2.target, "--volumes", "cache", "--upfront", "pgdata"], { env: { FAKE_CP_WAY: "volumes/pgdata" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, /Up-front volume volumes\/pgdata is missing in the target after the up-front copy \(cp ended with 1: cp: cannot stat/);
  } finally { way(w2); }
});

// Counter-proofs of the reconcile: one spot of the program sabotaged each => the tree of the copy no longer equals the source — red.
for (const [name, from, after, what] of [
  ["without-ctime.py", "    if ss.st_ctime_ns >= threshold and not is_deletion_marker(ss):\n", "    if False:\n", "without ctime the content of equal size and mtime stays old"],
  ["without-groups.py", "        if None in targets or len(targets) > 1:\n", "        if False:\n", "without the group g1/g2 stay two files"],
  ["without-folder.py", "        if count is not None:\n            folder_metadata(", "        if False:\n            folder_metadata(", "without folder metadata the xattr is missing"],
  ["without-xattr.py", "    return xattrs_of(sp) != xattrs_of(dp)\n", "    return False\n", "without the xattr comparison the foreign xattr stays"],
]) {
  test(`counter-proof: ${what} — red`, () => {
    const w = build();
    try {
      const a = reconcileSituation(w, { program: sabotage(w, name, from, after) });
      assert.equal(a.r2.code, 0, a.r2.err);
      assert.notDeepEqual(a.target.split("\n"), a.source.split("\n"), "the sabotage changed nothing — the guard would not see the defect");
    } finally { way(w); }
  });
}

const hc = (w, c) => path.join(w.source, `containers/${c}/hostconfig.json`);

test("policy-protection: only the named ids to \"no\", the old values as JSON, everything else unchanged", () => {
  const w = build();
  try {
    const beforeB = fs.readFileSync(hc(w, CB));
    fs.chmodSync(hc(w, CA), 0o600);
    const r = clone(w, ["policy-protection", w.source, CA]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { [CA]: { Name: "always", MaximumRetryCount: 0 } });
    const a = JSON.parse(fs.readFileSync(hc(w, CA), "utf8"));
    assert.deepEqual(a, { RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, Memory: 1073741824, Binds: null });
    assert.equal(fs.statSync(hc(w, CA)).mode & 0o777, 0o600, "mode not kept");
    assert.deepEqual(fs.readFileSync(hc(w, CB)), beforeB, "an unnamed container changed");
    assert.deepEqual(fs.readdirSync(path.join(w.source, `containers/${CA}`)).filter((n) => n.includes("cbase-clone")), [], "temp file still there");
  } finally { way(w); }
});

test("policy-protection: check everything first, then write; no id, no link, no JSON object => exit 1, nothing changed", () => {
  const cases = [
    [(w) => [CA, "abc"], null, /“abc” is not a container id/],
    [(w) => [CA, CB], (w) => fs.writeFileSync(hc(w, CB), "[1,2]"), /not a JSON object/],
    [(w) => [CA, CB], (w) => fs.writeFileSync(hc(w, CB), "{broken"), /Expecting property name/],
    [(w) => [CA, CB], (w) => { fs.rmSync(hc(w, CB)); fs.symlinkSync(hc(w, CA), hc(w, CB)); }, /is not a file/],
    [(w) => [CA, CC], null, /hostconfig\.json/],
  ];
  for (const [ids, prior, notice] of cases) {
    const w = build();
    try {
      if (prior) prior(w);
      const beforeA = fs.readFileSync(hc(w, CA));
      const r = clone(w, ["policy-protection", w.source, ...ids(w)]);
      assert.equal(r.code, 1, `${notice}: ${r.err}`);
      assert.match(r.err, notice);
      assert.deepEqual(fs.readFileSync(hc(w, CA)), beforeA, `${notice}: the first container was changed anyway`);
    } finally { way(w); }
  }
});

test("fadvise: on Linux every regular file without links; without posix_fadvise (macOS) exit 1 with a message", () => {
  const w = build();
  try {
    const r = clone(w, ["fadvise", path.join(w.source, "volumes"), path.join(w.source, "overlay2/l"), path.join(w.base, "nonexistent")]);
    if (process.platform === "linux") {
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, `fadvise files=${sheets(path.join(w.source, "volumes")).length} error=0\n`);
    } else {
      assert.equal(r.code, 1);
      assert.match(r.err, /posix_fadvise does not exist on this platform/);
    }
  } finally { way(w); }
});

test("the program loads under python3 and names its five commands (the run the Dockerfile does in the image)", () => {
  const r = spawnSync("python3", [CLONE, "--help"], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\{list,copy,fadvise,policy-protection,layer\}/);
  assert.equal(fs.statSync(CLONE).mode & 0o111, 0o111, "not executable");
  assert.match(fs.readFileSync(CLONE, "utf8"), /^#!\/usr\/bin\/env python3\n/);
});

// ── counter-proofs: sabotaged copies of the program ──────────────────────────────────────────────────────────────

function sabotage(w, name, from, after) {
  const text = fs.readFileSync(CLONE, "utf8");
  assert.equal(text.split(from).length, 2, `the spot "${from.slice(0, 60)}" does not stand exactly once — the sabotage does not bite`);
  const p = path.join(w.base, name);
  fs.writeFileSync(p, text.replace(from, after), { mode: 0o755 });
  return p;
}

test("counter-proof: without the exclusion of the container layers a writable layer stands in phase 1 — red", () => {
  const w = build();
  try {
    // The cache-id check already keeps a container layer out — only a cache-id that points to it (broken or malicious) makes the
    // exclusion of the container layers carry alone.
    write(path.join(w.source, `image/overlay2/layerdb/sha256/${id("chain-la")}/cache-id`), LA);
    const program = sabotage(w, "without-levels.py", 'return n != "l" and n not in self.levels and is_folder', 'return n != "l" and is_folder');
    const p1 = list(w, ["--phase", "1", w.source, "--volumes", "pgdata", "cache"], { program });
    assert.ok(p1.includes(`overlay2/${LA}`));
    assert.throws(() => checkPhase1(p1), /writable layer/);
  } finally { way(w); }
});

test("counter-proof: without the cache-id check a half-unpacked layer stands in phase 1 — red", () => {
  const w = build();
  try {
    const program = sabotage(w, "without-cache-id.py", " and n in self.committed\n", "\n");
    const p1 = list(w, ["--phase", "1", w.source, "--volumes", "pgdata", "cache"], { program });
    assert.ok(p1.includes(`overlay2/${HALF}`));
    assert.throws(() => checkPhase1(p1), /without cache-id/);
  } finally { way(w); }
});

test("counter-proof: without the log filter the logs stand in phase 2 — red", () => {
  const w = build();
  try {
    const program = sabotage(w, "with-logs.py", "if not fnmatch.fnmatchcase(f, LOG_PATTERN)]", "]");
    assert.throws(() => checkPhase2(w, list(w, ["--phase", "2", w.source, "--volumes", "pgdata", "cache"], { program })), /logs in phase 2/);
  } finally { way(w); }
});

test("counter-proof: without --again the volume to be taken back is missing from phase 2 — red", () => {
  const w = build();
  try {
    const program = sabotage(w, "without-again.py", "upfront = (set(volumes) - set(again))", "upfront = (set(volumes))");
    const p2 = list(w, ["--phase", "2", w.source, "--volumes", "pgdata", "cache", "--again", "pgdata"], { program });
    assert.throws(() => checkPhase2(w, p2, { again: ["pgdata"] }), /volumes\/pgdata in phase 2/);
  } finally { way(w); }
});

test("counter-proof: policy-protection over all containers instead of the named ones changes a foreign one — red", () => {
  const w = build();
  try {
    const beforeB = fs.readFileSync(hc(w, CB));
    const program = sabotage(w, "all.py", "ids = list(dict.fromkeys(args.ids))",
      'ids = sorted(n for n in os.listdir(os.path.join(args.target, "containers")) if os.path.exists(os.path.join(args.target, "containers", n, "hostconfig.json")))');
    assert.equal(clone(w, ["policy-protection", w.source, CA], { program }).code, 0);
    assert.notDeepEqual(fs.readFileSync(hc(w, CB)), beforeB, "the sabotage changed nothing — the check would not see it");
  } finally { way(w); }
});

test("counter-proof: with the old form alone (only 64 base-16 digits) the BuildKit layer breaks the clone — red", () => {
  const w = build();
  try {
    const program = sabotage(w, "only-base16.py", 'LEVELS_ID = r"(?:[0-9a-f]{64}|[0-9a-z]{25})"', 'LEVELS_ID = r"(?:[0-9a-f]{64})"');
    assert.throws(() => list(w, ["--phase", "1", w.source, "--volumes", "pgdata", "cache"], { program }), /cache-id: “[0-9a-z]{25}” is not a layer id/);
  } finally { way(w); }
});

test("counter-proof: a too wide layer id (any value) lets the path tricks through — red", () => {
  const w = build();
  try {
    const program = sabotage(w, "too-far.py", 'LEVELS_ID = r"(?:[0-9a-f]{64}|[0-9a-z]{25})"', 'LEVELS_ID = r"(?:.*)"');
    assert.throws(() => checkBrokenIds(program), /Exit 0/);
  } finally { way(w); }
});

// ── `layer` — the upper layers of a template copy ─────────────────────────────────────────────────────────────────────────
// The template keeps running while phase 1 copies; in the pause phase 2 reconciles (the same reconcile as `--reconcile`, over the
// whole tree). Measured on the real kernel: whiteouts 0,0 and `user.overlay.*` come with GNU cp; here the fake cp (structure, times,
// mode, links) and an xattr via the helper. Counter-proof: phase 2 without the reconcile (phase 1 only) => the tree per part unequal — red.
function layerSituation(w, { program = CLONE } = {}) {
  const q = path.join(w.base, "template", "layer");
  const z = path.join(w.base, "fresh", "layer");
  fs.mkdirSync(path.dirname(z));
  const s = (rel, t) => write(path.join(q, rel), t);
  s("p/notes.md", "n"); s("p/.wh.way.txt", ""); s("p/.git/HEAD", "ref: refs/heads/main\n"); s("p/changed.txt", "alt"); s("p/stays.txt", "b");
  fs.mkdirSync(path.join(q, "p/.git/objects"));
  help(w, "set", path.join(q, "p/.git"), "user.overlay.opaque", "y");
  s("r0/app.js", "a"); s("r0/folder/way.txt", "w"); s("r0.objects/ab/cdef", "obj"); s("local/bin/x", "x");
  fs.symlinkSync("x", path.join(q, "local/bin/y"));
  const env = { CBASE_CLONE_CTIME_MARGIN_NS: "0" };
  const r1 = clone(w, ["layer", "--phase", "1", q, z], { program, env });
  assert.equal(r1.code, 0, r1.err);
  const begin = (r1.out.match(/^layer phase=1 entries=4 layer_error=0 layer_begin_ns=(\d+)\n$/) || [])[1];
  assert.ok(begin, `phase 1 does not name its start: ${r1.out}`);
  // The template keeps working (between the phases):
  help(w, "content", path.join(q, "p/changed.txt"), "fresh"); // same size, mtime reset — only the ctime sees it
  fs.chmodSync(path.join(q, "p/stays.txt"), 0o600);
  fs.rmSync(path.join(q, "r0/folder"), { recursive: true });
  s("r0/fresh.txt", "fresh"); s("r0.objects/12/3456", "obj2"); s("p/.wh.late.txt", "");
  help(w, "set", path.join(q, "r0"), "user.overlay.opaque", "y"); // an xattr on the root of a part: the folder metadata
  const r2 = clone(w, ["layer", "--phase", "2", q, z, "--since", begin], { program, env });
  const parts = ["p", "r0", "r0.objects", "local"];
  return { q, z, r1, r2, source: parts.map((t) => help(w, "tree", path.join(q, t))), target: parts.map((t) => help(w, "tree", path.join(z, t))) };
}

test("layer: phase 1 copies the upper layers of the running template into a NEW target, phase 2 reconciles in the pause => the same tree per part (content, times, mode, xattrs, links); only the changes counted", () => {
  const w = build();
  try {
    const a = layerSituation(w);
    assert.equal(a.r2.code, 0, a.r2.err);
    // replaced: changed.txt (ctime), stays.txt (mode); new: r0/fresh.txt, r0.objects/12, p/.wh.late.txt; deleted: r0/folder.
    assert.match(a.r2.out, /^layer phase=2 entries=5\nreconcile replaced=2 fresh=3 deleted=1 folders=\d+\n$/);
    assert.deepEqual(a.target, a.source, "after the reconcile the new layer does not equal that of the template");
    assert.equal(fs.statSync(a.z).mode & 0o777, fs.statSync(a.q).mode & 0o777, "mode of the root not taken over");
  } finally { way(w); }
});

test("layer: wrong calls are exit 1 with a message (target already there, phase 2 without --since or without phase 1, --since in phase 1)", () => {
  const w = build();
  try {
    const q = path.join(w.base, "vq");
    write(path.join(q, "p/a"), "a");
    const z = path.join(w.base, "vz");
    const cases = [
      [["layer", "--phase", "2", q, z, "--since", "1"], /phase 1 did not run/],
      [["layer", "--phase", "2", q, z], /Phase 2 without --since/],
      [["layer", "--phase", "1", q, z, "--since", "1"], /--since exists only in phase 2/],
      [["layer", "--phase", "1", path.join(w.base, "missing"), z], /Source .* is not a folder/],
    ];
    for (const [args, notice] of cases) {
      const r = clone(w, args);
      assert.equal(r.code, 1, `${notice}: Exit ${r.code} ${r.err}`);
      assert.match(r.err, notice);
    }
    assert.equal(clone(w, ["layer", "--phase", "1", q, z]).code, 0);
    const r = clone(w, ["layer", "--phase", "1", q, z]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /never mixes/);
  } finally { way(w); }
});

test("counter-proof: phase 2 without the reconcile — the state of the pause is missing in the new layer — red", () => {
  const w = build();
  try {
    const program = sabotage(w, "layer-without-reconcile.py", '    reconcile(source, target, "", threshold_of(args.since), count, copy, folder, groups)\n', "");
    const a = layerSituation(w, { program });
    assert.equal(a.r2.code, 0, a.r2.err);
    assert.notDeepEqual(a.target, a.source, "the sabotage does not bite");
  } finally { way(w); }
});

// ── the path list in CHUNKS to cp ───────────────────────────────────────────────────────────────────────────────────────
// The reconcile names every changed entry individually; an `npm ci`, a branch switch or a `chmod -R` in the template between
// phase 1 and the pause turned that into tens of thousands of paths in ONE argv — over ARG_MAX phase 2 ended IN the pause with
// E2BIG ("Argument list too long"), rollback, copy failed. Now at most CHUNK_COUNT paths and CHUNK_BYTES argv bytes per cp; entries
// that share a file (also a file INSIDE a folder copied as a whole) in the same chunk; a group that would exceed the limit alone
// is split and joined again to ONE file in the target. If everything fits one chunk: ONE cp as before.
// Counter-proof: the large situation with the program from before the repair => red — `layer` and `copy --reconcile` each
// exit 1 "[Errno 7] Argument list too long"; in the guard itself the same probe over chunks as large as the whole list (the
// regulators) — and one sabotage each of the groups and of the re-joining with small chunks => tree unequal.

// A FAST fake cp in Python for thousands of entries (the one in Node starts a `cp -p` per file): the same form and --parents
// semantics, links as links, hard links within the call connected, times to the nanosecond, never over existing files; logs
// per call the count and argv bytes of the paths (the paths themselves only up to 50).
const FAST_CP_PY = String.raw`
import json, os, shutil, stat, sys
a = sys.argv[1:]
i = a.index("--") if "--" in a else -1
header, paths = a[:i], a[i + 1:]
with open(os.environ["FAKE_CP_LOG"], "a") as f:
    f.write(json.dumps({"count": len(paths), "bytes": sum(len(os.fsencode(p)) + 9 for p in paths), "paths": paths if len(paths) <= 50 else None}) + "\n")
if i < 0 or header[:4] != ["-a", "--preserve=xattr", "--parents", "-t"] or len(header) != 5:
    sys.exit("cp: wrong form " + json.dumps(a[:8]))
target = header[4]
seen = {}
def copy(q, z):
    st = os.lstat(q)
    if stat.S_ISLNK(st.st_mode):
        os.symlink(os.readlink(q), z)
        return
    if stat.S_ISDIR(st.st_mode):
        os.mkdir(z)
        for n in sorted(os.listdir(q)):
            copy(os.path.join(q, n), os.path.join(z, n))
        os.chmod(z, stat.S_IMODE(st.st_mode))
        os.utime(z, ns=(st.st_atime_ns, st.st_mtime_ns))
        return
    if not stat.S_ISREG(st.st_mode):
        sys.exit("cp: kind not reproduced " + q)
    k = (st.st_dev, st.st_ino)
    if st.st_nlink > 1 and k in seen:
        os.link(seen[k], z)
        return
    shutil.copyfile(q, z)
    os.chmod(z, stat.S_IMODE(st.st_mode))
    os.utime(z, ns=(st.st_atime_ns, st.st_mtime_ns))
    if st.st_nlink > 1:
        seen[k] = z
for e in paths:
    parts = e.split("/")
    for k in range(1, len(parts)):
        rel = "/".join(parts[:k])
        zp = os.path.join(target, rel)
        if not os.path.lexists(zp):
            os.mkdir(zp)
            os.chmod(zp, stat.S_IMODE(os.stat(rel).st_mode))
    zp = os.path.join(target, e)
    if os.path.lexists(zp):
        sys.exit("cp: already there " + zp)
    copy(e, zp)
`;
function fastCp(w) {
  const py = path.join(w.base, "fast-cp.py");
  fs.writeFileSync(py, FAST_CP_PY);
  const cp = path.join(w.base, "fast-cp");
  fs.writeFileSync(cp, `#!/bin/sh\nexec python3 -I '${py}' "$@"\n`, { mode: 0o755 });
  return cp;
}
const log = (w) => fs.readFileSync(w.cpLog, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z));

// The large situation: so many files under a folder with a long name that their paths exceed this machine's ARG_MAX by a quarter
// (macOS 1 MiB, Linux mostly 2 MiB); phase 1 with a running source, then a `chmod` on every file (the ctime jumps — each stands
// individually in the pause list), then phase 2. `kind` = "layer" | "reconcile" (copy --reconcile on pgdata).
const ARG_MAX = Number(spawnSync("getconf", ["ARG_MAX"], { encoding: "utf8" }).stdout) || 2 * 1024 * 1024;
const LANG = "n".repeat(150);
function largeSituation(w, kind, { moreEnv = {} } = {}) {
  const env = { CBASE_CLONE_CTIME_MARGIN_NS: "0", ...moreEnv };
  const opts = { env };
  w.cp = fastCp(w);
  const root = kind === "layer" ? path.join(w.base, "template", "layer") : w.source;
  const rel = kind === "layer" ? `p/${LANG}` : `${D}/${LANG}`;
  const proPath = Buffer.byteLength(`${rel}/f000000`) + 9;
  const count = Math.ceil((ARG_MAX * 1.25) / proPath);
  const file = (i) => path.join(root, rel, `f${String(i).padStart(6, "0")}`);
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(file(i), "");
  let r1;
  let z;
  if (kind === "layer") {
    z = path.join(w.base, "fresh", "layer");
    fs.mkdirSync(path.dirname(z));
    r1 = clone(w, ["layer", "--phase", "1", root, z], opts);
  } else {
    z = w.target;
    r1 = clone(w, ["copy", "--phase", "1", w.source, w.target, "--volumes", "cache", "--upfront", "pgdata"], opts);
  }
  assert.equal(r1.code, 0, r1.err);
  const since = /(?:layer|upfront)_begin_ns=(\d+)/.exec(r1.out)?.[1];
  assert.ok(since, r1.out);
  for (let i = 0; i < count; i++) fs.chmodSync(file(i), 0o600);
  const n0 = log(w).length;
  const r2 = kind === "layer"
    ? clone(w, ["layer", "--phase", "2", root, z, "--since", since], opts)
    : clone(w, ["copy", "--phase", "2", w.source, w.target, "--volumes", "cache", "--reconcile", "pgdata", "--since", since], opts);
  return { r2, count, calls: log(w).slice(n0), target: path.join(z, rel) };
}

for (const kind of ["layer", "reconcile"]) {
  test(`chunks (${kind}): a change set over ARG_MAX between phase 1 and the pause — phase 2 copies in chunks under both limits, every file arrives`, () => {
    const w = build();
    try {
      const a = largeSituation(w, kind);
      assert.equal(a.r2.code, 0, `phase 2 failed on the large list: ${a.r2.err.slice(0, 300)}`);
      const m = /entries=(\d+) chunks=(\d+)/.exec(a.r2.out);
      assert.ok(m, `no chunks reported: ${a.r2.out}`);
      assert.match(a.r2.out, new RegExp(`\\nreconcile replaced=${a.count} fresh=0 deleted=0 folders=\\d+\\n$`));
      assert.equal(Number(m[2]), a.calls.length, "chunks= does not name the number of cp calls");
      assert.ok(a.calls.length > 1);
      for (const x of a.calls) {
        assert.ok(x.count <= 1000, `a chunk with ${x.count} paths`);
        assert.ok(x.bytes <= 64 * 1024, `a chunk with ${x.bytes} argv bytes`);
      }
      assert.equal(a.calls.reduce((s, x) => s + x.count, 0), Number(m[1]), "not every entry went into exactly one chunk");
      const files = fs.readdirSync(a.target);
      assert.equal(files.length, a.count);
      for (const f of files) assert.equal(fs.lstatSync(path.join(a.target, f)).mode & 0o777, 0o600, `${f}: the state of the pause is missing`);
    } finally { way(w); }
  });

  test(`counter-proof (${kind}): with chunks as large as the whole list (the state before: ONE cp) phase 2 ends with E2BIG — red`, () => {
    const w = build();
    try {
      const a = largeSituation(w, kind, { moreEnv: { CBASE_CLONE_CHUNK_COUNT: "1000000000", CBASE_CLONE_CHUNK_BYTES: "1000000000000" } });
      assert.equal(a.r2.code, 1, "the large list went through in ONE cp — the guard would not see the defect");
      assert.match(a.r2.err, /Argument list too long/);
    } finally { way(w); }
  });
}

// The small group situation (the fake cp in Node): a file with three names (a1, a2 and — between the phases — `new/a3` in a NEW
// folder that is copied as a whole), one with two (b1, b2), single ones. In the pause: a1, a2, b1, b2, c replaced (ctime), new,
// x1…x4 new — the list in the order of the reconcile `t/new, t/x1…t/x4, t/a1, t/a2, t/b1, t/b2, t/c`.
function chunkSituation(w, { program = CLONE, moreEnv = {} } = {}) {
  const q = path.join(w.base, "template", "layer");
  const z = path.join(w.base, "fresh", "layer");
  fs.mkdirSync(path.dirname(z));
  const s = (rel, t) => write(path.join(q, rel), t);
  s("t/a1", "a"); s("t/b1", "b"); s("t/c", "c"); s("t/d/e", "e");
  fs.linkSync(path.join(q, "t/a1"), path.join(q, "t/a2"));
  fs.linkSync(path.join(q, "t/b1"), path.join(q, "t/b2"));
  const env = { CBASE_CLONE_CTIME_MARGIN_NS: "0", ...moreEnv };
  const r1 = clone(w, ["layer", "--phase", "1", q, z], { program, env });
  assert.equal(r1.code, 0, r1.err);
  const since = /layer_begin_ns=(\d+)/.exec(r1.out)?.[1];
  for (const n of ["x1", "x2", "x3", "x4"]) s(`t/${n}`, n);
  fs.mkdirSync(path.join(q, "t/new"));
  fs.linkSync(path.join(q, "t/a1"), path.join(q, "t/new/a3"));
  fs.chmodSync(path.join(q, "t/b1"), 0o600);
  fs.chmodSync(path.join(q, "t/c"), 0o600);
  const n0 = log(w).length;
  const r2 = clone(w, ["layer", "--phase", "2", q, z, "--since", since], { program, env });
  // The part `t` is compared (the root carries only mode and owner of the source, never its times — as in the layer situation).
  return { r2, calls: log(w).slice(n0).map((x) => x.args.slice(6)), source: help(w, "tree", path.join(q, "t")), target: help(w, "tree", path.join(z, "t")) };
}
const argvBytes = (list) => list.reduce((s, p) => s + Buffer.byteLength(p) + 9, 0);
const together = (calls, ...paths) => calls.some((a) => paths.every((p) => a.includes(p)));

test("chunks of 3 — every group sharing a file in ONE cp (also the new folder with its member); the tree equals the source incl. hard links", () => {
  const w = build();
  try {
    const a = chunkSituation(w, { moreEnv: { CBASE_CLONE_CHUNK_COUNT: "3" } });
    assert.equal(a.r2.code, 0, a.r2.err);
    assert.match(a.r2.out, /^layer phase=2 entries=10 chunks=4\nreconcile replaced=5 fresh=5 deleted=0 folders=\d+\n$/);
    for (const x of a.calls) assert.ok(x.length <= 3, JSON.stringify(x));
    assert.ok(together(a.calls, "t/new", "t/a1", "t/a2"), `a1, a2 and the folder with a3 in different cp: ${JSON.stringify(a.calls)}`);
    assert.ok(together(a.calls, "t/b1", "t/b2"), JSON.stringify(a.calls));
    assert.deepEqual(a.target.split("\n"), a.source.split("\n"), "in chunks the new layer does not equal the template");
  } finally { way(w); }
});

test("the byte limit holds on its own (count wide, 40 argv bytes) — every chunk below it, the groups together, the tree equal", () => {
  const w = build();
  try {
    const a = chunkSituation(w, { moreEnv: { CBASE_CLONE_CHUNK_BYTES: "40" } });
    assert.equal(a.r2.code, 0, a.r2.err);
    assert.match(a.r2.out, / chunks=\d+\n/);
    for (const x of a.calls) assert.ok(argvBytes(x) <= 40, `${argvBytes(x)} argv bytes: ${JSON.stringify(x)}`);
    assert.ok(together(a.calls, "t/new", "t/a1", "t/a2") && together(a.calls, "t/b1", "t/b2"), JSON.stringify(a.calls));
    assert.deepEqual(a.target.split("\n"), a.source.split("\n"));
  } finally { way(w); }
});

test("a group larger than a chunk (chunks of 2) is split and joined again to ONE file in the target — the tree equals the source", () => {
  const w = build();
  try {
    const a = chunkSituation(w, { moreEnv: { CBASE_CLONE_CHUNK_COUNT: "2" } });
    assert.equal(a.r2.code, 0, a.r2.err);
    for (const x of a.calls) assert.ok(x.length <= 2, JSON.stringify(x));
    assert.ok(!together(a.calls, "t/new", "t/a1", "t/a2"), "precondition: group a does not fit in one chunk");
    assert.deepEqual(a.target.split("\n"), a.source.split("\n"), "the split group stayed several files in the target");
  } finally { way(w); }
});

test("the reconcile of the upfront volumes (copy --reconcile) in chunks of 2 => the same tree as in one chunk", () => {
  const w = build();
  try {
    const a = reconcileSituation(w, { moreEnv: { CBASE_CLONE_CHUNK_COUNT: "2" } });
    assert.equal(a.r2.code, 0, a.r2.err);
    // `folders` counts one fewer here: re-joining the split group (one/two/three) already gives `_data` its times back.
    assert.match(a.r2.out, /^phase=2 entries=\d+ chunks=\d+\nreconcile replaced=7 fresh=2 deleted=4 folders=\d+\n$/);
    assert.deepEqual(a.target.split("\n"), a.source.split("\n"), "in chunks the volume of the copy does not equal the source");
  } finally { way(w); }
});

for (const [name, from, after, slider, what] of [
  ["without-groups-chunks.py", "            if a != b:\n                parent[max(a, b)] = min(a, b)\n", "            if False:\n                pass\n", "3",
    "without the groups a1/a2/new fall into different cp"],
  ["without-link.py", "            os.unlink(zp)\n            os.link(first, zp, follow_symlinks=False)\n", "            continue\n", "2",
    "without the re-joining the split group stays several files"],
]) {
  test(`counter-proof: ${what} — red`, () => {
    const w = build();
    try {
      const a = chunkSituation(w, { program: sabotage(w, name, from, after), moreEnv: { CBASE_CLONE_CHUNK_COUNT: slider } });
      assert.equal(a.r2.code, 0, a.r2.err);
      assert.notDeepEqual(a.target.split("\n"), a.source.split("\n"), "the sabotage changed nothing — the guard would not see the defect");
    } finally { way(w); }
  });
}

// The flip side of the walk: to find the groups, the program looks into every folder copied as a whole — and never follows a link
// (each folder via the descriptor of its parent with O_NOFOLLOW). If it followed one, a member of the group would stand under
// `new/reference/…`, and the re-joining would hit a path behind a link in the target (where it stops strictly).
// Counter-proof: the walk with `x.stat()` and without O_NOFOLLOW (it follows links) => exit 1 "behind a link" — red.
function referenceSituation(w, { program = CLONE } = {}) {
  const q = path.join(w.base, "template", "layer");
  const z = path.join(w.base, "fresh", "layer");
  fs.mkdirSync(path.dirname(z));
  write(path.join(q, "t/a1"), "a");
  fs.linkSync(path.join(q, "t/a1"), path.join(q, "t/a2"));
  fs.mkdirSync(path.join(q, "t/d"));
  const env = { CBASE_CLONE_CTIME_MARGIN_NS: "0", CBASE_CLONE_CHUNK_COUNT: "2" };
  const r1 = clone(w, ["layer", "--phase", "1", q, z], { program, env });
  assert.equal(r1.code, 0, r1.err);
  const since = /layer_begin_ns=(\d+)/.exec(r1.out)?.[1];
  // Between the phases: a third member in t/d (the group a1/a2/d/a3 does not fit in a chunk of 2 — it is re-joined) and a NEW
  // folder with a link to t/d.
  fs.linkSync(path.join(q, "t/a1"), path.join(q, "t/d/a3"));
  fs.mkdirSync(path.join(q, "t/new"));
  fs.symlinkSync("../d", path.join(q, "t/new/reference"));
  write(path.join(q, "t/new/x"), "x");
  const r2 = clone(w, ["layer", "--phase", "2", q, z, "--since", since], { program, env });
  return { r2, z, source: help(w, "tree", path.join(q, "t")), target: r2.code === 0 ? help(w, "tree", path.join(z, "t")) : "" };
}

test("the walk through a folder copied as a whole follows no link — the link stays a link, the group is joined without it", () => {
  const w = build();
  try {
    const a = referenceSituation(w);
    assert.equal(a.r2.code, 0, a.r2.err);
    assert.ok(fs.lstatSync(path.join(a.z, "t/new/reference")).isSymbolicLink());
    assert.deepEqual(a.target.split("\n"), a.source.split("\n"));
  } finally { way(w); }
});

test("counter-proof: a walk that follows links finds a member behind `new/reference` — the re-joining stops there — red", () => {
  const w = build();
  try {
    const text = fs.readFileSync(CLONE, "utf8");
    const from = ["            s = x.stat(follow_symlinks=False)\n", "FOLDER_WITHOUT_REFERENCE = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW\n"];
    for (const v of from) assert.equal(text.split(v).length, 2, `the spot "${v.trim()}" does not stand exactly once`);
    const program = path.join(w.base, "stat-follows.py");
    fs.writeFileSync(program, text.replace(from[0], "            s = x.stat()\n").replace(from[1], "FOLDER_WITHOUT_REFERENCE = os.O_RDONLY | os.O_DIRECTORY\n"), { mode: 0o755 });
    const a = referenceSituation(w, { program });
    assert.equal(a.r2.code, 1, "the sabotage changed nothing — the guard would not see the defect");
    assert.match(a.r2.err, /behind a link/);
  } finally { way(w); }
});

// ── deletion markers do not count via ctime ──────────────────────────────────────────────────────────────────────────────
// Since kernel 5.8 overlayfs creates deletion markers (character device 0:0) as hard links to ONE shared inode; every new or
// removed link raises the ctime of ALL. With the ctime as the signal, after a single deletion in the template every deletion marker
// of the layer went into cp anew in the pause. Creating a character device needs root — here the REAL program runs in a driver that
// redirects `os.lstat`: an empty file whose name begins with `.wh.` is seen by the program as character device 0:0, otherwise with
// its real values (inode, link count, ctime, mtime, owner). The situation's deletion markers ARE hard links of one file — a new
// link raises the ctime of all, as in the kernel.
// Counter-proof: the reconcile with the ctime for every kind (the state before) => `replaced=39` instead of 1 — red.
const DELETION_MARKER_PY = String.raw`
import importlib.machinery, importlib.util, os, stat, sys
lader = importlib.machinery.SourceFileLoader("cbase_clone", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("cbase_clone", lader))
lader.exec_module(m)
real = os.lstat
class DeletionMarker:
    def __init__(self, st):
        for k in dir(st):
            if k.startswith("st_"):
                setattr(self, k, getattr(st, k))
        self.st_mode, self.st_rdev, self.st_size = stat.S_IFCHR, 0, 0
def lstat(p, *a, **k):
    st = real(p, *a, **k)
    if os.path.basename(os.fsdecode(p)).startswith(".wh.") and stat.S_ISREG(st.st_mode) and st.st_size == 0:
        return DeletionMarker(st)
    return st
os.lstat = lstat
sys.exit(m.main(sys.argv[2:]))
`;
function deletionMarkersSituation(w, { program = CLONE } = {}) {
  const driver = path.join(w.base, "deletionMarker.py");
  fs.writeFileSync(driver, DELETION_MARKER_PY);
  const run = (...args) => {
    const r = spawnSync("python3", [driver, program, ...args], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", CBASE_CLONE_CP: w.cp, FAKE_NODE: process.execPath, FAKE_CP_LOG: w.cpLog, CBASE_CLONE_CTIME_MARGIN_NS: "0" },
    });
    if (r.error) throw r.error;
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const q = path.join(w.base, "template", "layer");
  const z = path.join(w.base, "fresh", "layer");
  fs.mkdirSync(path.dirname(z));
  const marker = (n) => path.join(q, "p", `.wh.w${String(n).padStart(2, "0")}`);
  write(marker(0), "");
  for (let i = 1; i < 40; i++) fs.linkSync(marker(0), marker(i)); // 40 deletion markers, ONE inode — as the kernel creates them
  write(path.join(q, "p", "file"), "d");
  const r1 = run("layer", "--phase", "1", q, z);
  assert.equal(r1.code, 0, r1.err);
  const since = /layer_begin_ns=(\d+)/.exec(r1.out)?.[1];
  // The template deletes another file of the main: a new link to the shared inode — the ctime of all jumps. Plus a deletion marker
  // over which the file arises anew (kind: character device → file), and one that falls entirely.
  fs.linkSync(marker(0), path.join(q, "p", ".wh.fresh"));
  fs.rmSync(marker(5));
  write(marker(5), "back again");
  fs.rmSync(marker(6));
  const n0 = log(w).length;
  const r2 = run("layer", "--phase", "2", q, z, "--since", since);
  // The view of both sides: name and kind (deletion marker) or content.
  const view = (root) => fs.readdirSync(path.join(root, "p")).sort().map((n) => {
    const p = path.join(root, "p", n);
    const st = fs.lstatSync(p);
    return n.startsWith(".wh.") && st.isFile() && st.size === 0 ? `${n} deletion marker` : `${n} = ${fs.readFileSync(p, "utf8")}`;
  });
  return { r2, phase2: log(w).slice(n0).flatMap((x) => x.args.slice(6)), source: view(q), target: view(z) };
}

test("a new deletion marker on the shared inode leaves the others alone — in the pause only what changed in existence or kind is copied", () => {
  const w = build();
  try {
    const a = deletionMarkersSituation(w);
    assert.equal(a.r2.code, 0, a.r2.err);
    assert.match(a.r2.out, /^layer phase=2 entries=2\nreconcile replaced=1 fresh=1 deleted=1 folders=\d+\n$/);
    assert.deepEqual(a.phase2.sort(), ["p/.wh.fresh", "p/.wh.w05"], "the pause copied unchanged deletion markers");
    assert.deepEqual(a.target, a.source, "the view of the new layer does not equal that of the template");
  } finally { way(w); }
});

test("counter-proof: with the ctime for every kind (the state before) every deletion marker of the layer goes into cp anew in the pause — red", () => {
  const w = build();
  try {
    const program = sabotage(w, "deletion-marker-ctime.py", "    if ss.st_ctime_ns >= threshold and not is_deletion_marker(ss):\n", "    if ss.st_ctime_ns >= threshold:\n");
    const a = deletionMarkersSituation(w, { program });
    assert.equal(a.r2.code, 0, a.r2.err);
    assert.doesNotMatch(a.r2.out, /\nreconcile replaced=1 fresh=1 /, "the sabotage changed nothing — the guard would not see the defect");
    assert.match(a.r2.out, /\nreconcile replaced=39 fresh=1 deleted=1 /);
  } finally { way(w); }
});
