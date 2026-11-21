// Guards of the manifest comparison in the relocation (steps 4 and 14).
//
// Two parts, both run FOR REAL: the program server/backend/cbase-manifest through `python3` on real trees in a temp folder (files, an
// empty file, 200 small files, random bytes with a nanosecond mtime, setuid, sticky, private, symlink, dangling symlink, directory
// symlink, symlink to the outside, hardlink across two directories, sparse file, FIFO, a name with a line break and with umlauts, a
// rebuilt Postgres heap file) and the comparer projectbox/relocation/manifest.js over its output.
//
// What is NOT real here, and why: macOS has no os.listxattr, and without root there is no foreign owner. The wrapper (WRAPPER below)
// therefore injects os.listxattr/os.getxattr (per tree a table path -> {name: value}) and lays an owner or a directory size over
// os.stat/os.fstat, both assigned to the path through the inode. The program itself runs unchanged (runpy). The real xattrs and ACLs
// are measured on the server; the way through /proc/self/fd/<dir>/<name> also runs at EVERY image build on Linux (Dockerfile, stage
// backend: a small tree with a symlink, the closing line is checked). The wrapper is itself a guard: an xattr call through a PATH with
// follow_symlinks=True (it followed a symlink in the tree) throws.
//
// The twelve errors, each applied to a proper copy K (afterwards the times are reset as in K, so exactly THAT error remains): g1 file
// missing · g2 empty file missing · g3 a user.* xattr missing · g4 the access ACL missing · g5 owner 1234:5678 -> 0:0 · g6 setuid lost ·
// g7 a bit flipped · g8 hardlink broken · g9 root as freshly created (0:0, 0755) · g10 symlink target different, same length · g11 a file
// missing, a foreign one of the same size added · g12 one character in the heap file flipped (offset 8162, "2" -> "0"). Each is red, and
// the comparer names EXACTLY it.
//
// COUNTER-TESTS (in the test, on every run):
//   - the comparison over size and count only (hardlinks counted once like `du`) lets 9 of the 12 through — the same check run against
//     it is red;
//   - a version of the program that also writes the size of a directory turns the proper copy red (the directory sizes in S and K really
//     differ — APFS computes them from the number of entries, ext4 never shrinks, so the wrapper injects them, and the test checks
//     beforehand that the program SEES them that way);
//   - the slot check (Dockerfile, build.sh, deploy) against the state before the manifest program existed is red.
//
// Run (with the gate deadlines like any backend file alone):
//   CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//   CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/relocation-manifest.test.js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { SYSTEM_PATHS, mountRules } from "../electron/server/projectbox/creation.js";
import {
  DEVIATIONS_CAP, MANIFEST_PROGRAM, MANIFEST_VERSION, readManifest, manifestArgv, checkManifestStream, comparisonRows,
  compareManifestStreams, compareManifests,
} from "../electron/server/projectbox/relocation/manifest.js";
import { dockerfileStages } from "../../../tools/check/lib/projectbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const PROGRAM = path.join(REPO, "server/backend/cbase-manifest");
// The slot at the last state BEFORE the manifest program (reduced from 0bcae4a: Dockerfile and build.sh; there was no list of the
// build context yet): the stages and the copy lines, none of them names cbase-manifest.
const BEFORE_S1_25 = {
  dockerfile: [
    "FROM node:22-bookworm-slim AS base",
    "RUN useradd -m -u 1001 -s /bin/bash agent && usermod -aG docker agent",
    "FROM base AS projectbox",
    "COPY projectbox-entry.sh /usr/sbin/cbase-projectbox-entry",
    "COPY cbase-wrapper /usr/sbin/cbase-wrapper",
    "FROM base AS backend",
    "COPY package.json ./",
    "COPY electron ./electron",
    "COPY headless.js ./",
    "COPY entry.sh /entry.sh",
    "COPY cbase-project /usr/bin/cbase-project",
    "RUN chmod 755 /usr/bin/cbase-project && node --check /usr/bin/cbase-project",
    "COPY cbase-git /usr/bin/cbase-git",
    "",
  ].join("\n"),
  build: [
    'CTX="build-context"',
    'cp headless.js package.json entry.sh cbase-project cbase-git projectbox-entry.sh cbase-wrapper "$CTX/"',
    'docker build -t "$IMAGE" -f Dockerfile "$CTX"',
    "",
  ].join("\n"),
  files: [],
};

// ── the Python wrapper ──────────────────────────────────────────────────────────────────────────────────────────────────
// copy SRC DST          a proper copy like `cp -a`: permissions, times to the nanosecond, hardlinks, holes, FIFO, symlinks
// times FROM TO         the times of every path in TO as in FROM again (same type assumed), symlinks themselves
// mtime PATH NS         an mtime to the nanosecond (Node cannot do that)
// stat CFG ROOT REL     what the program sees through os.stat at REL: {"st_size":…}
// manifest CFG PROG ROOT   the program with injected xattr functions and a stat overlay
const WRAPPER = String.raw`
import errno, json, os, runpy, stat, sys

def copy(src, dst):
    links = {}
    def file(s, d, size):
        with open(s, "rb") as a, open(d, "wb") as b:
            while True:
                blk = a.read(1 << 20)
                if not blk:
                    break
                if blk.count(0) == len(blk):
                    b.seek(len(blk), 1)
                else:
                    b.write(blk)
            b.truncate(size)
    def rec(s, d):
        st = os.lstat(s)
        m = st.st_mode
        if stat.S_ISDIR(m):
            os.mkdir(d, 0o700)
            for n in sorted(os.listdir(s)):
                rec(os.path.join(s, n), os.path.join(d, n))
            os.chmod(d, stat.S_IMODE(m))
            os.utime(d, ns=(st.st_atime_ns, st.st_mtime_ns))
            return
        key = (st.st_dev, st.st_ino)
        if st.st_nlink > 1 and key in links:
            os.link(links[key], d)
            return
        if stat.S_ISLNK(m):
            os.symlink(os.readlink(s), d)
        elif stat.S_ISFIFO(m):
            os.mkfifo(d)
        elif stat.S_ISREG(m):
            file(s, d, st.st_size)
        else:
            raise SystemExit("copy: unknown type")
        if st.st_nlink > 1:
            links[key] = d
        if not stat.S_ISLNK(m):
            os.chmod(d, stat.S_IMODE(m))
        os.utime(d, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False)
    rec(os.fsencode(src), os.fsencode(dst))

def times(src, dst):
    def rec(v, n):
        try:
            sv = os.lstat(v)
        except FileNotFoundError:
            sv = None
        sn = os.lstat(n)
        if stat.S_ISDIR(sn.st_mode):
            for x in os.listdir(n):
                rec(os.path.join(v, x), os.path.join(n, x))
        if sv is not None and stat.S_IFMT(sv.st_mode) == stat.S_IFMT(sn.st_mode):
            os.utime(n, ns=(sv.st_atime_ns, sv.st_mtime_ns), follow_symlinks=False)
    rec(os.fsencode(src), os.fsencode(dst))

def einspielen(cfg_path, root):
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    real_stat, real_fstat, real_lstat = os.stat, os.fstat, os.lstat
    inodes = {}
    def run(p, rel):
        st = real_lstat(p)
        inodes.setdefault((st.st_dev, st.st_ino), rel)
        if stat.S_ISDIR(st.st_mode):
            for n in sorted(os.listdir(p)):
                run(os.path.join(p, n), n if rel == "." else rel + "/" + n)
    try:
        run(root, ".")
    except OSError:
        pass  # a missing or unreadable root: the program must fail by itself
    class Stat:
        def __init__(self, real, over):
            self._e, self._u = real, over
        def __getattr__(self, n):
            return self._u[n] if n in self._u else getattr(self._e, n)
    def over(st):
        u = cfg.get("stat", {}).get(inodes.get((st.st_dev, st.st_ino)))
        return Stat(st, u) if u else st
    os.stat = lambda *a, **k: over(real_stat(*a, **k))
    os.fstat = lambda *a, **k: over(real_fstat(*a, **k))
    os.lstat = lambda *a, **k: over(real_lstat(*a, **k))
    def rel_of(target, followUps):
        if isinstance(target, int):
            if followUps is False:
                raise ValueError("listxattr: cannot use fd and follow_symlinks together")
            st = real_fstat(target)
        else:
            if followUps is not False:
                raise AssertionError("xattr through a path WITH following a symlink")
            z = os.fsencode(target)
            before = b"/proc/self/fd/"
            if not z.startswith(before):
                raise AssertionError("xattr through a path outside /proc/self/fd")
            fd, _, name = z[len(before):].partition(b"/")
            if not name or b"/" in name:
                raise AssertionError("xattr path not <dir>/<name>")
            st = real_stat(name, dir_fd=int(fd), follow_symlinks=False)
        return inodes[(st.st_dev, st.st_ino)]
    def table(target, followUps):
        return cfg.get("xattr", {}).get(rel_of(target, followUps), {})
    def listxattr(target=None, *, follow_symlinks=None):
        return list(table(target, follow_symlinks).keys())
    def getxattr(target, name, *, follow_symlinks=None):
        w = table(target, follow_symlinks).get(name)
        if w is None:
            raise OSError(errno.ENODATA if hasattr(errno, "ENODATA") else errno.ENOATTR, "no xattr")
        return bytes.fromhex(w)
    os.listxattr, os.getxattr = listxattr, getxattr

kind = sys.argv[1]
if kind == "copy":
    copy(sys.argv[2], sys.argv[3])
elif kind == "times":
    times(sys.argv[2], sys.argv[3])
elif kind == "mtime":
    st = os.lstat(sys.argv[2])
    os.utime(sys.argv[2], ns=(st.st_atime_ns, int(sys.argv[3])), follow_symlinks=False)
elif kind == "stat":
    einspielen(sys.argv[2], sys.argv[3])
    st = os.stat(os.path.join(sys.argv[3], sys.argv[4]), follow_symlinks=False)
    print(json.dumps({"st_size": st.st_size}))
elif kind == "manifest":
    einspielen(sys.argv[2], sys.argv[4])
    sys.argv = [sys.argv[3], "--", sys.argv[4]]
    runpy.run_path(sys.argv[0], run_name="__main__")
else:
    raise SystemExit("unknown kind")
`;

let LOCATION;
let WRAPPER_FILE;
function py(args) {
  // PYTHONDONTWRITEBYTECODE: no __pycache__ next to a program of the repo, however it is loaded.
  const r = spawnSync("python3", [WRAPPER_FILE, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (r.error) throw r.error;
  return r;
}
function pyOk(args) {
  const r = py(args);
  assert.equal(r.status, 0, `python3 ${args[0]}: Exit ${r.status}\n${r.stderr}`);
  return r.stdout;
}

// Per tree an injection table: xattrs (values base-16) and what os.stat should say differently.
const hex = (s) => Buffer.from(s).toString("hex");
// The form of system.posix_acl_access/_default (header 2, then per entry tag, permissions, id), base-16.
const ACL_ACCESS = "0200000001000600ffffffff04000400ffffffff02000600d204000010000600ffffffff20000400ffffffff";
const ACL_DEFAULT = "0200000001000700ffffffff04000500ffffffff10000700ffffffff20000500ffffffff";
function cfgSource() {
  return {
    xattr: {
      "mitx.txt": { "user.comment": hex("hello world") },
      "acl.txt": { "system.posix_acl_access": ACL_ACCESS },
      "default-acl": { "system.posix_acl_default": ACL_DEFAULT },
      many: { "user.binary": crypto.createHash("sha256").update("binary").digest().toString("hex").repeat(8) },
      "setuid-file": { "security.capability": hex("cap_net_bind_service+ep") },
    },
    stat: {
      ".": { st_uid: 1234, st_gid: 1234 },
      "secret.txt": { st_uid: 1234, st_gid: 5678 },
    },
  };
}
// The proper copy: the same values — only the directory `many` is larger (as after a tar copy).
function cfgCopy() {
  const c = cfgSource();
  c.stat.many = { st_size: 12288, st_blocks: 168 };
  return c;
}

let Q; // source
let K; // proper copy
let MQ; // manifest of the source
let MK;
const CONTENT_SECRET = "secret content, never in the manifest\n";
const CONTENT_OUTSIDE = "something lies outside that the run never reads\n";

function writeCfg(name, cfg) {
  const p = path.join(LOCATION, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}
function manifest(root, cfg, program = PROGRAM) {
  return pyOk(["manifest", writeCfg(`cfg-${path.basename(root)}-${crypto.randomUUID()}`, cfg), program, root]);
}

function buildSource(q) {
  fs.mkdirSync(q);
  const p = (...t) => path.join(q, ...t);
  fs.mkdirSync(p("many"));
  for (let i = 0; i < 200; i++) fs.writeFileSync(p("many", `f${String(i).padStart(4, "0")}.txt`), `file ${String(i).padStart(4, "0")} content\n`);
  // 64 KiB of random bytes, fixed seed; mtime from the year 2001 with nanoseconds (set through python below).
  const parts = [];
  for (let i = 0; i < 2048; i++) parts.push(crypto.createHash("sha256").update(`random-${i}`).digest());
  fs.writeFileSync(p("random.bin"), Buffer.concat(parts));
  fs.writeFileSync(p("empty"), "");
  fs.writeFileSync(p("setuid-file"), "#!/bin/sh\necho hello\n");
  fs.chmodSync(p("setuid-file"), 0o4755);
  fs.writeFileSync(p("secret.txt"), CONTENT_SECRET);
  fs.chmodSync(p("secret.txt"), 0o640);
  fs.writeFileSync(p("mitx.txt"), "with xattr\n");
  fs.writeFileSync(p("acl.txt"), "with acl\n");
  fs.mkdirSync(p("default-acl"));
  fs.mkdirSync(p("common"));
  fs.chmodSync(p("common"), 0o1777);
  fs.mkdirSync(p("personal"));
  fs.writeFileSync(p("personal", "note"), "private\n");
  fs.chmodSync(p("personal"), 0o700);
  fs.symlinkSync("random.bin", p("reference"));
  fs.symlinkSync("exists-not", p("hanging"));
  fs.symlinkSync("many", p("folder-reference"));
  fs.symlinkSync(path.join(LOCATION, "outside.txt"), p("after-outside"));
  fs.mkdirSync(p("hl"));
  fs.mkdirSync(p("hl2"));
  fs.writeFileSync(p("hl", "a"), "hardlink-content\n");
  fs.linkSync(p("hl", "a"), p("hl2", "b"));
  // Sparse: 64 MiB apparent, 4 KiB used (APFS creates a hole only from a larger gap; 64 MiB work there and on ext4).
  const fd = fs.openSync(p("thin.bin"), "w");
  fs.writeSync(fd, Buffer.alloc(4096, 0x61), 0, 4096, 64 * 1024 * 1024);
  fs.closeSync(fd);
  execFileSync("mkfifo", [p("fifo")]);
  fs.writeFileSync(p("line\nbreak"), "name with a line break\n");
  fs.writeFileSync(p("Ärger-ü.txt"), "umlauts\n");
  // A rebuilt heap file (three pages of 8192 B); at offset 8162 there is a "2" (g12).
  fs.mkdirSync(p("pgdata", "base", "5"), { recursive: true });
  const heap = Buffer.alloc(3 * 8192);
  for (let i = 0; i < heap.length; i += 16) heap.write(`${String(i).padStart(8, "0")}:value2\n`.slice(0, 16), i, "latin1");
  heap[8162] = "2".charCodeAt(0);
  fs.writeFileSync(p("pgdata", "base", "5", "16390"), heap);
  fs.chmodSync(p("pgdata"), 0o700);
  pyOk(["mtime", p("random.bin"), "1000000000123456789"]);
  fs.chmodSync(q, 0o770);
}

before(() => {
  LOCATION = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relocation-manifest-")));
  WRAPPER_FILE = path.join(LOCATION, "wrapper.py");
  fs.writeFileSync(WRAPPER_FILE, WRAPPER);
  fs.writeFileSync(path.join(LOCATION, "outside.txt"), CONTENT_OUTSIDE);
  Q = path.join(LOCATION, "source");
  K = path.join(LOCATION, "copy");
  buildSource(Q);
  pyOk(["copy", Q, K]);
  MQ = manifest(Q, cfgSource());
  MK = manifest(K, cfgCopy());
});

after(() => {
  if (LOCATION) fs.rmSync(LOCATION, { recursive: true, force: true });
});

const rows = (m) => m.trimEnd().split("\n").map((z) => JSON.parse(z));
const entry = (m, p) => rows(m).find((e) => e.p === p);

// ── the program ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("cbase-manifest: header, root first, closing line with the count; per type exactly its fields, never the size of a directory", () => {
  const z = rows(MQ);
  assert.deepEqual(z[0], { "cbase-manifest": MANIFEST_VERSION });
  assert.deepEqual(z.at(-1), { entries: z.length - 2, end: true });
  assert.equal(z[1].p, ".");
  const m = readManifest(MQ);
  assert.equal(m.ok, true, m.error);
  const e = (p) => m.entries.get(p);
  assert.deepEqual(Object.keys(e(".")).sort(), ["gid", "mode", "mtime", "p", "type", "uid", "xattr"]);
  assert.deepEqual({ mode: e(".").mode, uid: e(".").uid, gid: e(".").gid }, { mode: "0770", uid: 1234, gid: 1234 });
  assert.equal(e("many").size, undefined, "the size of a directory is in the manifest");
  assert.equal(e("many").type, "d");
  assert.equal(e("setuid-file").mode, "4755");
  assert.equal(e("common").mode, "1777");
  assert.equal(e("personal").mode, "0700");
  assert.deepEqual({ uid: e("secret.txt").uid, gid: e("secret.txt").gid, mode: e("secret.txt").mode }, { uid: 1234, gid: 5678, mode: "0640" });
  assert.equal(e("random.bin").mtime, "1000000000123456789", "mtime not to the nanosecond");
  assert.equal(e("random.bin").size, 65536);
  assert.equal(e("random.bin").sha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(Q, "random.bin"))).digest("hex"));
  assert.equal(e("empty").size, 0);
  assert.equal(e("empty").thin, false);
  assert.equal(e("thin.bin").thin, true, "the sparse file is not recognised as sparse");
  assert.equal(e("thin.bin").size, 64 * 1024 * 1024 + 4096);
  assert.equal(e("random.bin").thin, false);
  assert.equal(e("fifo").type, "p");
  assert.equal(e("fifo").sha256, undefined);
  for (const l of ["reference", "hanging", "folder-reference", "after-outside"]) {
    assert.equal(e(l).type, "l", l);
    assert.match(e(l).target, /^[0-9a-f]{64}$/);
  }
  assert.equal(e("reference").target, crypto.createHash("sha256").update("random.bin").digest("hex"));
  // Hardlink group: both paths, the group is named after the one visited first.
  assert.deepEqual([e("hl/a").nlink, e("hl/a").hl, e("hl2/b").nlink, e("hl2/b").hl], [2, "hl/a", 2, "hl/a"]);
  assert.equal(e("mitx.txt").hl, undefined, "hl without a hardlink");
  // Names as bytes: line break and umlauts stay as they are.
  assert.ok(e("line\nbreak"), "the name with a line break is missing");
  assert.ok(m.entries.has("Ärger-ü.txt"), "the name with umlauts is missing");
  // xattrs: all namespaces, per name the sha256 of the value.
  assert.deepEqual(Object.keys(e("acl.txt").xattr), ["system.posix_acl_access"]);
  assert.equal(e("acl.txt").xattr["system.posix_acl_access"], crypto.createHash("sha256").update(Buffer.from(ACL_ACCESS, "hex")).digest("hex"));
  assert.deepEqual(Object.keys(e("default-acl").xattr), ["system.posix_acl_default"]);
  assert.deepEqual(Object.keys(e("setuid-file").xattr), ["security.capability"]);
  assert.deepEqual(Object.keys(e("many").xattr), ["user.binary"]);
  // Depth first, per directory sorted by bytes.
  const paths = z.slice(1, -1).map((x) => x.p);
  assert.ok(paths.indexOf("hl/a") < paths.indexOf("hl2") && paths.indexOf("hl2") < paths.indexOf("hl2/b"));
  assert.equal(paths.filter((x) => x.startsWith("many/")).length, 200);
});

test("cbase-manifest: no symlink is followed, no content and no xattr value is in the manifest", () => {
  const m = readManifest(MQ);
  for (const l of ["folder-reference", "after-outside", "reference"]) {
    assert.ok(![...m.entries.keys()].some((p) => p.startsWith(`${l}/`)), `walked under the symlink ${l}`);
  }
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  assert.ok(!MQ.includes(sha(CONTENT_OUTSIDE)), "the content behind the symlink to the outside was read");
  assert.ok(!MQ.includes(LOCATION), "an absolute path (the target of the symlink to the outside) is in the manifest");
  for (const secret of [CONTENT_SECRET, "hello world", hex("hello world"), ACL_ACCESS, "exists-not", CONTENT_OUTSIDE]) {
    assert.ok(!MQ.includes(secret), `a value is in the manifest: ${JSON.stringify(secret).slice(0, 40)}`);
  }
  assert.ok(!MQ.includes(fs.readFileSync(path.join(Q, "random.bin")).toString("hex").slice(0, 32)));
});

test("cbase-manifest: errors end with exit ≠ 0 and WITHOUT a closing line — a missing root, a file as root, a symlink as root, without os.listxattr", () => {
  const cfg = writeCfg("empty", {});
  for (const [name, root] of [["missing", path.join(LOCATION, "exists-not")], ["File", path.join(Q, "empty")], ["Symlink", path.join(Q, "folder-reference")]]) {
    const r = py(["manifest", cfg, PROGRAM, root]);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /^cbase-manifest: root is not a directory or cannot be opened/, name);
    assert.ok(!r.stdout.includes("\"end\""), `${name}: closing line despite an error`);
  }
  // macOS really lacks os.listxattr — the program refuses instead of delivering a manifest without xattrs. Simulated on Linux:
  // os.listxattr deleted.
  const r = spawnSync("python3", ["-c", `import os, runpy, sys\nif hasattr(os, "listxattr"): del os.listxattr\nsys.argv = [${JSON.stringify(PROGRAM)}, ${JSON.stringify(Q)}]\nrunpy.run_path(sys.argv[0], run_name="__main__")`], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /os\.listxattr is missing/);
  // An unreadable subdirectory (0000): exit 2, no closing line — never "empty". (root reads it anyway; then this part checks
  // nothing, and the message says so.)
  const u = path.join(LOCATION, "unreadable");
  fs.mkdirSync(path.join(u, "closed"), { recursive: true });
  fs.writeFileSync(path.join(u, "closed", "x"), "x");
  fs.chmodSync(path.join(u, "closed"), 0o000);
  try {
    const r2 = py(["manifest", cfg, PROGRAM, u]);
    if (process.getuid?.() === 0) {
      assert.equal(r2.status, 0, "readable as root");
    } else {
      assert.equal(r2.status, 2, r2.stderr);
      assert.ok(!r2.stdout.includes("\"end\""));
      assert.match(r2.stderr, /not readable|cannot be opened/);
    }
  } finally {
    fs.chmodSync(path.join(u, "closed"), 0o755);
  }
});

// ── the comparison ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("the proper copy is field-equal although the directory sizes differ", () => {
  // Precondition, otherwise "green" would prove nothing: the program SEES different sizes for `many` in S and K.
  const gq = JSON.parse(pyOk(["stat", writeCfg("s-q", cfgSource()), Q, "many"])).st_size;
  const gk = JSON.parse(pyOk(["stat", writeCfg("s-k", cfgCopy()), K, "many"])).st_size;
  assert.notEqual(gq, gk, "the directory sizes in S and K are equal — the case checks nothing");
  const result = compareManifests(MQ, MK);
  assert.equal(result.error, null);
  assert.deepEqual(result.deviations, []);
  assert.equal(result.equal, true);
  assert.equal(result.count.desired, result.count.actual);
  assert.deepEqual(comparisonRows(result, "v"), [`v: field-equal (${result.count.desired} entries)`]);
});

test("counter-test: if the program also writes the size of a directory, the proper copy is red", () => {
  const sourceCode = fs.readFileSync(PROGRAM, "utf8");
  const from = `        type, e = entry(rel, st)\n        if type == "d":\n`;
  assert.equal(sourceCode.split(from).length, 2, "the place for the counter-test does not occur exactly once in the program");
  const variant = path.join(LOCATION, "variant-directory-size.py");
  fs.writeFileSync(variant, sourceCode.replace(from, `        type, e = entry(rel, st)\n        if type == "d":\n            e["size"] = st.st_size\n`));
  const vq = manifest(Q, cfgSource(), variant);
  const vk = manifest(K, cfgCopy(), variant);
  assert.notEqual(entry(vq, "many").size, entry(vk, "many").size, "the variant does not see the differing size");
  assert.equal(compareManifests(vq, vk).equal, false, "the variant with a directory size is green");
});

// The twelve errors. `tu` works on the tree G (a copy of K) and/or on the injection table; afterwards the times as in K again.
// `expected` is EXACTLY what the comparer must name.
const TWELVE = [
  ["g1", "file many/f0001.txt (16 B) missing", (g) => fs.rmSync(path.join(g, "many/f0001.txt")), [{ path: "many/f0001.txt", kind: "missing" }]],
  ["g2", "the empty file is missing", (g) => fs.rmSync(path.join(g, "empty")), [{ path: "empty", kind: "missing" }]],
  ["g3", "a user.* xattr is missing", (_g, c) => delete c.xattr["mitx.txt"]["user.comment"], [{ path: "mitx.txt", kind: "field", fields: ["xattr:user.comment"] }]],
  ["g4", "the access ACL is missing", (_g, c) => delete c.xattr["acl.txt"]["system.posix_acl_access"], [{ path: "acl.txt", kind: "field", fields: ["xattr:system.posix_acl_access"] }]],
  ["g5", "owner 1234:5678 → 0:0", (_g, c) => { c.stat["secret.txt"] = { st_uid: 0, st_gid: 0 }; }, [{ path: "secret.txt", kind: "field", fields: ["uid", "gid"] }]],
  ["g6", "setuid lost (4755 → 0755)", (g) => fs.chmodSync(path.join(g, "setuid-file"), 0o755), [{ path: "setuid-file", kind: "field", fields: ["mode"] }]],
  ["g7", "a bit in random.bin flipped, same size", (g) => {
    const p = path.join(g, "random.bin");
    const b = fs.readFileSync(p);
    b[1000] ^= 0x01;
    fs.writeFileSync(p, b);
  }, [{ path: "random.bin", kind: "field", fields: ["sha256"] }]],
  ["g8", "hardlink broken (two files)", (g) => {
    const p = path.join(g, "hl2/b");
    const b = fs.readFileSync(p);
    const mode = fs.statSync(p).mode & 0o7777;
    fs.rmSync(p);
    fs.writeFileSync(p, b);
    fs.chmodSync(p, mode);
  }, [{ path: "hl/a", kind: "field", fields: ["nlink", "hl"] }, { path: "hl2/b", kind: "field", fields: ["nlink", "hl"] }]],
  ["g9", "root of the volume as freshly created: 0:0, 0755", (g, c) => {
    fs.chmodSync(g, 0o755);
    c.stat["."] = { st_uid: 0, st_gid: 0 };
  }, [{ path: ".", kind: "field", fields: ["mode", "uid", "gid"] }]],
  ["g10", "symlink target different, same length", (g) => {
    fs.rmSync(path.join(g, "reference"));
    fs.symlinkSync("random.bix", path.join(g, "reference"));
  }, [{ path: "reference", kind: "field", fields: ["target"] }]],
  ["g11", "a file is missing, a foreign one of the same size added", (g) => {
    const way = path.join(g, "many/f0002.txt");
    const size = fs.statSync(way).size;
    fs.rmSync(way);
    fs.writeFileSync(path.join(g, "many/foreign.txt"), "x".repeat(size));
  }, [{ path: "many/f0002.txt", kind: "missing" }, { path: "many/foreign.txt", kind: "tooMany" }]],
  ["g12", "one character in the heap file flipped (offset 8162, \"2\" → \"0\")", (g) => {
    const p = path.join(g, "pgdata/base/5/16390");
    const b = fs.readFileSync(p);
    assert.equal(b[8162], "2".charCodeAt(0));
    b[8162] = "0".charCodeAt(0);
    fs.writeFileSync(p, b);
  }, [{ path: "pgdata/base/5/16390", kind: "field", fields: ["sha256"] }]],
];

// Further traps (t1: tar without -S, t4/t5: docker cp and BusyBox tar) — neither is seen by size and count.
const FALLEN = [
  ["t1", "sparse file written in full", (g) => {
    const p = path.join(g, "thin.bin");
    const b = fs.readFileSync(p);
    fs.rmSync(p);
    fs.writeFileSync(p, b);
    fs.chmodSync(p, fs.statSync(path.join(K, "thin.bin")).mode & 0o7777);
  }, [{ path: "thin.bin", kind: "field", fields: ["thin"] }]],
  ["t4", "mtime cut to seconds", (g) => pyOk(["mtime", path.join(g, "random.bin"), "1000000000000000000"]),
    [{ path: "random.bin", kind: "field", fields: ["mtime"] }], { withoutTimes: true }],
];

const CASES = new Map();
function fall(id, tu, opts = {}) {
  if (CASES.has(id)) return CASES.get(id);
  const g = path.join(LOCATION, id);
  pyOk(["copy", K, g]);
  const cfg = cfgCopy();
  tu(g, cfg);
  if (!opts.withoutTimes) pyOk(["times", K, g]);
  const m = manifest(g, cfg);
  CASES.set(id, m);
  return m;
}

// The check as a function over a comparer: it is the same for the real one and for the counter-test.
function letThrough(comparison, cases) {
  return cases.filter(([id, , tu, , opts]) => comparison(MK, fall(id, tu, opts)).equal === true).map(([id]) => id);
}

// The first version: size (hardlinks counted once, like `du`) and count.
function onlySizeAndCount(desired, actual) {
  const mass = (text) => {
    const m = readManifest(text);
    assert.equal(m.ok, true, m.error);
    let sum = 0;
    for (const e of m.entries.values()) if (e.type === "f" && (e.hl === undefined || e.hl === e.p)) sum += e.size;
    return [m.entries.size, sum];
  };
  const [a, b] = [mass(desired), mass(actual)];
  return { equal: a[0] === b[0] && a[1] === b[1] };
}

test("the twelve errors: each is red, and the comparer names exactly it — without values", () => {
  for (const [id, what, tu, expected, opts] of TWELVE) {
    const result = compareManifests(MK, fall(id, tu, opts));
    assert.equal(result.error, null, `${id}: ${result.error?.reason}`);
    assert.equal(result.equal, false, `${id} (${what}) is green`);
    assert.deepEqual(result.deviations, expected, `${id} (${what})`);
    // Without values: no hash, no mode, no time in the result.
    const s = JSON.stringify(result);
    assert.ok(!/[0-9a-f]{64}/.test(s), `${id}: a hash in the result`);
    assert.ok(!/"(?:0[0-7]{3}|[1-7][0-7]{3})"/.test(s) && !s.includes("1000000000"), `${id}: a value in the result`);
  }
  assert.deepEqual(letThrough(compareManifests, TWELVE), []);
});

test("counter-test: size and count let 9 of the 12 through — the same check is red against it", () => {
  const through = letThrough(onlySizeAndCount, TWELVE);
  assert.deepEqual(through, ["g3", "g4", "g5", "g6", "g7", "g9", "g10", "g11", "g12"]);
  assert.notDeepEqual(through, [], "the check \"none let through\" would be green against size and count");
  // And the proper copy is green for both: the difference lies only in the errors.
  assert.equal(onlySizeAndCount(MQ, MK).equal, true);
});

test("the traps (tar without -S, docker cp): sparse file written in full and mtime cut to seconds — red, and size and count would not see them", () => {
  for (const [id, what, tu, expected, opts] of FALLEN) {
    const result = compareManifests(MK, fall(id, tu, opts));
    assert.deepEqual(result.deviations, expected, `${id} (${what})`);
  }
  assert.deepEqual(letThrough(compareManifests, FALLEN), []);
  assert.deepEqual(letThrough(onlySizeAndCount, FALLEN), ["t1", "t4"]);
});

// ── the reader: incomplete is not empty ────────────────────────────────────────────────────────────────────────────────

test("readManifest: without a closing line, with a wrong count, truncated, empty, with a foreign or missing field — invalid, and the comparison is never equal", () => {
  const z = MK.split("\n"); // the last element is "" (line end at the close)
  // Change an entry and write it back in the same form (keys sorted).
  const change = (p, fn) => z.map((l, i) => {
    if (i === 0 || !l) return l;
    const e = JSON.parse(l);
    if (e.p !== p) return l;
    fn(e);
    return JSON.stringify(Object.fromEntries(Object.entries(e).sort(([x], [y]) => (x < y ? -1 : 1))));
  }).join("\n");
  const broken = {
    empty: "",
    "header only": `${z[0]}\n`,
    "without closing line": `${z.slice(0, -2).join("\n")}\n`,
    "truncated in the middle of a line": MK.slice(0, MK.length - 7),
    "wrong count": MK.replace(/"entries":(\d+)/, (_, n) => `"entries":${Number(n) + 1}`),
    "one line fewer": [...z.slice(0, 3), ...z.slice(4)].join("\n"),
    "foreign version": MK.replace('{"cbase-manifest":1}', '{"cbase-manifest":2}'),
    "directory with a size": change("many", (e) => { e.size = 4096; }),
    "blocks on a file": change("empty", (e) => { e.blocks = 0; }),
    "file without sha256": change("random.bin", (e) => { delete e.sha256; }),
    "mtime as a number": change("random.bin", (e) => { e.mtime = Number(e.mtime); }),
    "xattr value raw": change("mitx.txt", (e) => { e.xattr["user.comment"] = "hello world"; }),
    "hardlink without hl": change("hl2/b", (e) => { delete e.hl; }),
    "hl without a hardlink": change("mitx.txt", (e) => { e.hl = "empty"; }),
    "hl into the void": change("hl2/b", (e) => { e.hl = "exists/es/not"; }),
    "path twice": change("many/f0001.txt", (e) => { e.p = "many/f0000.txt"; }),
    "absolute path": change("empty", (e) => { e.p = "/empty"; }),
    "path with ..": change("empty", (e) => { e.p = "many/../empty"; }),
    "unknown type": change("fifo", (e) => { e.type = "x"; }),
    "root not first": [z[0], z[2], z[1], ...z.slice(3)].join("\n"),
  };
  assert.equal(readManifest(MK).ok, true);
  for (const [name, text] of Object.entries(broken)) {
    assert.notEqual(text, MK, `${name}: the falsification had no effect`);
    const m = readManifest(text);
    assert.equal(m.ok, false, `${name} counts as valid`);
    assert.ok(!/[0-9a-f]{64}/.test(m.error), `${name}: a hash in the error message`);
    for (const [a, b] of [[MK, text], [text, MK], [text, text]]) {
      const result = compareManifests(a, b);
      assert.equal(result.equal, false, `${name}: the comparison is equal`);
      assert.ok(result.error, `${name}: without an error`);
    }
  }
  assert.equal(compareManifests(null, MK).equal, false);
  assert.equal(compareManifests(MK, undefined).error.page, "actual");
  // A Buffer and the result of readManifest work like text.
  assert.equal(compareManifests(Buffer.from(MQ), readManifest(MK)).equal, true);
});

test("the cap on deviations says that it is one", () => {
  const emptyTree = path.join(LOCATION, "empty-tree");
  fs.mkdirSync(emptyTree);
  const m = manifest(emptyTree, {});
  const result = compareManifests(MK, m, { cap: 5 });
  assert.equal(result.equal, false);
  assert.equal(result.deviations.length, 5);
  assert.equal(result.truncated, result.count.missing + result.count.deviating - 5);
  const txt = comparisonRows(result, "vol");
  assert.match(txt.at(-1), new RegExp(`… and ${result.truncated} more \\(cap 5 lines\\)`));
  assert.match(txt[0], /^vol: DEVIATION — \d+ missing, 0 too many, 1 deviating/);
  assert.equal(compareManifests(MK, m).deviations.length, Math.min(DEVIATIONS_CAP, result.count.missing + 1));
  assert.match(comparisonRows(compareManifests("", m), "vol")[0], /^vol: no valid manifest \(desired\)/);
  for (const d of [0, -1, 1.5, "5"]) assert.throws(() => compareManifests(MK, m, { cap: d }), /cap/);
});

// ── the slot of the program: backend image, /usr/local/bin, read-only in the project container ─────────────────────────

function slotDefects({ dockerfile, build, files }) {
  const defects = [];
  const st = dockerfileStages(dockerfile);
  const where = st.flatMap((s) => s.instructions.filter((a) => /cbase-manifest/.test(a.arg)).map((a) => [s.name, a.op, a.arg]));
  const copy = where.filter(([, op]) => op === "COPY");
  if (copy.length !== 1 || copy[0][0] !== "backend" || copy[0][2] !== `cbase-manifest ${MANIFEST_PROGRAM}`) {
    defects.push("the Dockerfile does not copy cbase-manifest exactly once in the stage backend to /usr/local/bin");
  }
  if (where.some(([stage]) => stage !== "backend")) defects.push("cbase-manifest is outside the stage backend");
  const run = where.find(([, op, arg]) => op === "RUN" && arg.includes(`python3 ${MANIFEST_PROGRAM} `));
  if (!run || !run[2].includes(`grep -qxF '{"end":true,"entries":4}'`) || !run[2].includes("ln -s")) {
    defects.push("the image build does not run cbase-manifest over a tree with a symlink and does not check the closing line");
  }
  if (!/^cp cbase-manifest "\$CTX\/"/m.test(build)) defects.push("build.sh does not stage cbase-manifest");
  if (!files.includes("cbase-manifest")) {
    defects.push("the build context list does not name cbase-manifest");
  }
  return defects;
}

test("the slot: in the backend image under /usr/local/bin (mounted read-only in the project container), in the build context and in the deploy — counter-test against the state before the manifest program", () => {
  const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
  const now = { dockerfile: read("server/backend/Dockerfile"), build: read("server/backend/build.sh"), files: JSON.parse(read("server/backend/build-context-files.json")).files };
  assert.deepEqual(slotDefects(now), []);
  assert.equal(slotDefects(BEFORE_S1_25).length, 4, "the earlier state holds the slot — the check sees nothing");
  // /usr/local/bin is the rule system-bin: read-only, mandatory. If the program moved or the mount fell, it would no longer be the
  // same program in the project container.
  assert.equal(path.dirname(MANIFEST_PROGRAM), SYSTEM_PATHS.usrLocalBin);
  const r = mountRules({ home: "/home/agent", wsPath: null, projectPath: "/home/agent/p", runtime: "/home/agent/cbase/data/projects/x" });
  const bin = r.find((x) => x.target === SYSTEM_PATHS.usrLocalBin);
  assert.ok(bin, "no mount for /usr/local/bin");
  assert.deepEqual([bin.rw, bin.condition, bin.source], [false, "required", SYSTEM_PATHS.usrLocalBin]);
  assert.deepEqual(manifestArgv("/src"), ["python3", MANIFEST_PROGRAM, "--", "/src"]);
  assert.throws(() => manifestArgv("src"), /absolute path/);
  // The program in the repo is executable and starts with python3 (the image build sets 755 anyway).
  assert.equal(fs.statSync(PROGRAM).mode & 0o111, 0o111);
  assert.match(fs.readFileSync(PROGRAM, "utf8"), /^#!\/usr\/bin\/python3\n/);
});

// ── `thin` does not depend on the page cache ─────────────────────────────────────────────────────────────────────────────
// The program once determined `thin` with SEEK_HOLE AFTER reading. ext4/iomap reports a preallocated, never written range
// (posix_fallocate — Postgres from 16, InnoDB) as data only if its pages happen to be in the cache: the desired manifest of a large
// file said "thin" or not depending on the cache, the target after `cp -a` (written in full) "not thin" — step 14a falsely red. Here
// the cold cache is simulated (os.lseek reports a hole at the start for SEEK_HOLE, like ext4 for an uncached preallocated range) and
// the same program is run on the same tree warm and cold: the manifests are field-equal. The real sparse file stays sparse and the
// fully written case red (the tests above).
// COUNTER-TEST (built in): the program with `thin` determined as at the state BEFORE_GL_E (67644b1: SEEK_HOLE after reading)
// delivers different `thin` cold and warm — red.
// Measurable only on the server: a file with `fallocate -l 4G` and partial writing, larger than the free cache.
const THIN_TODAY = /^ {4}thin = n > 0 and st\.st_blocks < st\.st_size \/\/ 512$/m;
const THIN_BEFORE_GL_E = ["    if n == 0:", "        thin = False", "    else:", "        thin = os.lseek(fd, 0, os.SEEK_HOLE) < n"].join("\n");
// The .gitignore of BEFORE_GL_E as far as it matters here (reduced): build output and caches, nothing for Python bytecode.
const GITIGNORE_BEFORE_GL_E = [".env", "data/", "node_modules/", ".next/", "web/out/", "dist/", ".DS_Store", "server/gateway/data/",
  "server/backend/build-context/", "*.tsbuildinfo", "/deploy.local.json", ".deploy-logs/", ""].join("\n");
function manifestColdWarm(program, root) {
  const cfg = writeCfg(`cfg-cold-${crypto.randomUUID()}`, { xattr: {}, stat: {} });
  const run = (cold) => {
    const code = [
      "import os, runpy, sys",
      cold ? "real = os.lseek\nos.lseek = lambda fd, pos, how: 0 if how == getattr(os, 'SEEK_HOLE', -99) else real(fd, pos, how)" : "",
      `sys.argv = [${JSON.stringify(WRAPPER_FILE)}, "manifest", ${JSON.stringify(cfg)}, ${JSON.stringify(program)}, ${JSON.stringify(root)}]`,
      `runpy.run_path(${JSON.stringify(WRAPPER_FILE)}, run_name="__main__")`,
    ].join("\n");
    const r = spawnSync("python3", ["-c", code], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(r.status, 0, `python3 (${cold ? "cold" : "warm"}): Exit ${r.status}\n${r.stderr}`);
    return r.stdout;
  };
  return { cold: run(true), warm: run(false) };
}
function buildPrefilled() {
  const v = path.join(LOCATION, `prefilled-${crypto.randomUUID()}`);
  fs.mkdirSync(v);
  const parts = [];
  for (let i = 0; i < 64; i++) parts.push(crypto.createHash("sha256").update(`table-${i}`).digest());
  fs.writeFileSync(path.join(v, "16384"), Buffer.concat(parts).toString("hex").repeat(64)); // ≈ 256 KiB, fully allocated
  fs.writeFileSync(path.join(v, "small"), "x\n");
  return v;
}

test("`thin` does not depend on the page cache — warm and cold field-equal; the state BEFORE_GL_E was not", () => {
  const v = buildPrefilled();
  const fresh = manifestColdWarm(PROGRAM, v);
  const result = compareManifests(fresh.warm, fresh.cold);
  assert.equal(result.error, null);
  assert.deepEqual(result.deviations, [], JSON.stringify(result.deviations));
  assert.equal(result.equal, true);
  assert.equal(entry(fresh.warm, "16384").thin, false, "a fully allocated file is not thin");
  // The real sparse file from the source stays sparse (64 MiB apparent, 4 KiB used) — warm and cold.
  const q = manifestColdWarm(PROGRAM, Q);
  assert.equal(entry(q.warm, "thin.bin").thin, true);
  assert.equal(entry(q.cold, "thin.bin").thin, true);
  // COUNTER-TEST: the program before the fix.
  const old = path.join(LOCATION, "cbase-manifest-before-gl-e");
  const program = fs.readFileSync(PROGRAM, "utf8");
  assert.match(program, THIN_TODAY, "the line that determines `thin` has moved — the counter-test does not bite");
  fs.writeFileSync(old, program.replace(THIN_TODAY, THIN_BEFORE_GL_E));
  assert.match(fs.readFileSync(old, "utf8"), /os\.SEEK_HOLE\) < n/, "the counter-test program does not determine `thin` through SEEK_HOLE");
  const backThen = manifestColdWarm(old, v);
  const resultOld = compareManifests(backThen.warm, backThen.cold);
  assert.equal(resultOld.equal, false, "the counter-test has no effect: the old state was equal warm and cold");
  assert.ok(resultOld.deviations.some((a) => a.path === "16384" && a.fields?.includes("thin")), JSON.stringify(resultOld.deviations));
});

// ── no Python bytecode in the repo ───────────────────────────────────────────────────────────────────────────────────────
// `server/backend/__pycache__/cbase-{clone,manifest}cpython-314.pyc` once lay in a commit — a name that only an import or
// `py_compile` of a file WITHOUT an extension produces (importlib.util.cache_from_source), not a run as a script (`python3 <program>`
// and `runpy.run_path` write none). What is held: `.gitignore` covers `__pycache__/` and `*.pyc`; the tests load the programs with
// PYTHONDONTWRITEBYTECODE; and no bytecode travels into the image: build.sh and the deploy name the files from server/backend one by
// one (no directory), the Dockerfile copies per file.
// COUNTER-TEST (built in): the `.gitignore` of BEFORE_GL_E does not cover it (`git check-ignore --no-index` against its content).
test("__pycache__ is ignored, no test writes it, and it travels neither into the build context nor into the image", () => {
  const pyc = "server/backend/__pycache__/cbase-manifestcpython-314.pyc";
  const ignored = (content) => {
    const d = fs.mkdtempSync(path.join(LOCATION, "gi-"));
    fs.writeFileSync(path.join(d, ".gitignore"), content);
    execFileSync("git", ["init", "-q", d]);
    return spawnSync("git", ["-C", d, "check-ignore", "-q", "--no-index", pyc]).status === 0;
  };
  assert.equal(ignored(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8")), true, ".gitignore does not cover __pycache__");
  assert.equal(ignored(GITIGNORE_BEFORE_GL_E), false, "the counter-test has no effect");
  // Load both programs as tests and image do (as a script, through runpy) — in a copy, and nothing arises next to it.
  const d = fs.mkdtempSync(path.join(LOCATION, "pyc-"));
  for (const n of ["cbase-manifest", "cbase-clone"]) fs.copyFileSync(path.join(REPO, "server/backend", n), path.join(d, n));
  spawnSync("python3", [path.join(d, "cbase-clone"), "--help"], { encoding: "utf8" });
  spawnSync("python3", ["-c", `import runpy, sys\nsys.argv = ["m", "--", ${JSON.stringify(d)}]\ntry:\n    runpy.run_path(${JSON.stringify(path.join(d, "cbase-manifest"))}, run_name="__main__")\nexcept SystemExit:\n    pass`], { encoding: "utf8" });
  assert.equal(fs.existsSync(path.join(d, "__pycache__")), false, "a run wrote bytecode next to the program");
  // The way into the image: named files only.
  const build = fs.readFileSync(path.join(REPO, "server/backend/build.sh"), "utf8");
  assert.doesNotMatch(build, /cp -R?a? (\.|\.\/|\*)(\s|$)/, "build.sh copies server/backend as a whole");
  const list = JSON.parse(fs.readFileSync(path.join(REPO, "server/backend/build-context-files.json"), "utf8")).files;
  assert.ok(list.length > 0 && list.every((f) => /^[A-Za-z0-9._-]+$/.test(f)), "the build context list holds a directory or a pattern instead of named files");
  const df = fs.readFileSync(path.join(REPO, "server/backend/Dockerfile"), "utf8");
  assert.doesNotMatch(df, /^(COPY|ADD)\s+\.\s/m, "the Dockerfile copies the whole context");
});

// ── a large manifest, measured on the heap ───────────────────────────────────────────────────────────────────────────────
// The manifest of a volume with many entries must not be held by B as ONE string with a map (1 million entries ≈ 258 MB of text,
// ≈ 1.7 GB of heap — an OOM of the whole user backend). The way of the relocation: docker() writes stdout as a stream into a file
// (`stdoutFile`), compareManifestStreams reads both files line by line. Measured in a child with a 48 MB heap on a manifest of
// 300,000 entries (≈ 60 MB): the stream way is green there, and the COUNTER-TEST — the same docker() call without `stdoutFile` and
// the comparison over text — dies on the heap. No clock: the criterion is the heap, not the duration.
test("a large manifest goes as a stream through docker() into a file and is compared line by line — in a heap where text with a map does not fit (counter-test)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-manifest-large-"));
  try {
    const N = 300_000;
    const file = path.join(dir, "desired.jsonl");
    const fd = fs.openSync(file, "w");
    const row = (o) => `${JSON.stringify(o)}\n`;
    const base = { mode: "0644", uid: 1000, gid: 1000, mtime: "1700000000123456789", xattr: {} };
    fs.writeSync(fd, row({ "cbase-manifest": 1 }) + row({ p: ".", type: "d", ...base, mode: "0755" }) + row({ p: "data", type: "d", ...base, mode: "0755" }));
    let chunk = "";
    for (let i = 0; i < N; i++) {
      chunk += row({ p: `data/${String(i).padStart(7, "0")}`, type: "f", ...base, size: i, sha256: crypto.createHash("sha256").update(String(i)).digest("hex"), thin: false, nlink: 1 });
      if (chunk.length > 1 << 20) { fs.writeSync(fd, chunk); chunk = ""; }
    }
    fs.writeSync(fd, `${chunk}${row({ entries: N + 2, end: true })}`);
    fs.closeSync(fd);
    // The fake docker prints the manifest to stdout — like `docker exec <helper> python3 cbase-manifest …`.
    const bin = path.join(dir, "docker");
    fs.writeFileSync(bin, `#!/bin/sh\nexec cat '${file}'\n`, { mode: 0o755 });
    const DOCKER = new URL("../electron/server/projectbox/docker.js", import.meta.url).href;
    const MANIFEST = new URL("../electron/server/projectbox/relocation/manifest.js", import.meta.url).href;
    const code = `
import fs from "node:fs";
import { docker } from ${JSON.stringify(DOCKER)};
import { compareManifestStreams, compareManifests } from ${JSON.stringify(MANIFEST)};
const desired = process.env.DESIRED;
if (process.env.MODE === "stream") {
  const r = await docker(["exec", "helper", "python3"], { capMs: 0, stdoutFile: process.env.ACTUAL_FILE });
  if (r.stdout !== "") throw new Error("stdout collected after all");
  const res = await compareManifestStreams(fs.createReadStream(desired), fs.createReadStream(process.env.ACTUAL_FILE));
  console.log(JSON.stringify({ equal: res.equal, count: res.count }));
} else {
  const r = await docker(["exec", "helper", "python3"], { capMs: 0 });
  const res = compareManifests(fs.readFileSync(desired, "utf8"), r.stdout);
  console.log(JSON.stringify({ equal: res.equal, count: res.count }));
}`;
    const runChild = (mode) => spawnSync(process.execPath, ["--max-old-space-size=48", "--input-type=module", "-e", code], {
      encoding: "utf8", maxBuffer: 1 << 24,
      // docker() aborts an output over 64 MiB (a docker error "output") — the text way would otherwise die of that instead of the
      // heap. The counter-test measures the way without this cap (1 GiB).
      env: { ...process.env, NODE_TEST_CONTEXT: "", CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: bin, MODE: mode, DESIRED: file, ACTUAL_FILE: path.join(dir, "actual.jsonl"), ...(mode === "text" ? { CBASE_DOCKER_OUTPUT_BYTES: String(2 ** 30) } : {}) },
    });
    const stream = runChild("stream");
    assert.equal(stream.status, 0, `stream way failed in the small heap: ${stream.stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
    const result = JSON.parse(stream.stdout.trim().split("\n").at(-1));
    assert.equal(result.equal, true);
    assert.deepEqual(result.count, { desired: N + 2, actual: N + 2, missing: 0, tooMany: 0, deviating: 0 });
    assert.equal(fs.statSync(path.join(dir, "actual.jsonl")).mode & 0o777, 0o600, "the manifest file is not 0600");
    // COUNTER-TEST: the old way (stdout collected, text + map) does not fit in the same heap.
    const old = runChild("text");
    assert.notEqual(old.status, 0, "the text way fits in the heap — the measurement proves nothing");
    assert.match(old.stderr, /heap/i, `the text way did not die of the heap: ${old.stderr.split("\n").filter(Boolean).slice(0, 3).join(" | ")}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The order of the merge is that of the program (depth first, per directory by bytes): a name whose byte is smaller than "/" (a-b,
// a.c against a/x — as a JS string a/x would come last), and a name that is not UTF-8 (surrogate \udcXX, as byte 0x80 BEFORE "é" =
// 0xC3 0xA9, as UTF-16 after it). The trees are measured by the REAL program (wrapper as above); a name that is not UTF-8 is not
// created by APFS — it is inserted as a line at the byte position (and at the UTF-16 position it is invalid).
test("the stream comparison orders like the program (a, a/x, a-b, a.c; non-UTF-8 by bytes) and names the same deviations as the text way", async () => {
  const w = path.join(LOCATION, "order");
  for (const d of ["a/x", "a-b", "b"]) fs.mkdirSync(path.join(w, d), { recursive: true });
  for (const f of ["a/x/1", "a-b/2", "a.c", "b/\u00e9", "b/z"]) fs.writeFileSync(path.join(w, f), f);
  const real = manifest(w, {});
  const rowsReal = real.split("\n");
  const pathOf = (z) => JSON.parse(z).p;
  assert.deepEqual(rowsReal.slice(1, -2).map(pathOf), [".", "a", "a/x", "a/x/1", "a-b", "a-b/2", "a.c", "b", "b/z", "b/\u00e9"], "the program orders differently than assumed");
  // The name 0x80 0x41 under b: by bytes between "z" (0x7A) and "é" (0xC3).
  const template = JSON.parse(rowsReal.find((z) => z.includes('"p":"b/z"')));
  const raw = JSON.stringify({ ...template, p: "b/\udc80A" });
  const withRaw = (beforeValue) => {
    const i = rowsReal.findIndex((z) => { try { return JSON.parse(z).p === beforeValue; } catch { return false; } });
    const z = [...rowsReal.slice(0, i), raw, ...rowsReal.slice(i)];
    return z.join("\n").replace(/"entries":(\d+)/, (_, n) => `"entries":${Number(n) + 1}`);
  };
  const m = withRaw("b/\u00e9");
  assert.equal(readManifest(m).ok, true, readManifest(m).error);
  assert.match(readManifest(withRaw("b/z")).error || "", /order/, "by UTF-16 order (before z) the line would count as valid");
  const paths = m.split("\n").slice(1, -2).map(pathOf);
  const stream = (text) => Readable.from([Buffer.from(text)]);
  const text = compareManifests(m, m);
  assert.equal(text.equal, true, JSON.stringify(text.error));
  const result = await compareManifestStreams(stream(m), stream(m));
  assert.equal(result.equal, true, JSON.stringify(result.error));
  assert.equal(result.count.desired, paths.length);
  // An entry is missing: stream and text name the same.
  const rows = m.split("\n");
  const without = rows.filter((z) => !z.includes('"p":"a-b/2"')).join("\n").replace(/"entries":(\d+)/, (_, n) => `"entries":${Number(n) - 1}`);
  const a = compareManifests(m, without);
  const b = await compareManifestStreams(stream(m), stream(without));
  assert.deepEqual(b, a);
  assert.deepEqual(b.deviations, [{ path: "a-b/2", kind: "missing" }]);
  // A moved line is invalid (it would land at the wrong place in the merge), in both ways.
  const moved = [rows[0], rows[1], rows[3], rows[2], ...rows.slice(4)].join("\n");
  assert.match(readManifest(moved).error || "", /order/);
  assert.match((await compareManifestStreams(stream(m), stream(moved))).error?.reason || "", /order/);
  // In chunks of arbitrary boundaries (in the middle of a line, in the middle of a character) the stream reads the same.
  const bytes = Buffer.from(m);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
  assert.equal((await compareManifestStreams(Readable.from(chunks), stream(m))).equal, true);
  assert.equal((await checkManifestStream(Readable.from(chunks))).entries, paths.length);
  assert.equal((await checkManifestStream(stream(m.slice(0, -1)))).ok, false, "valid without a line end at the close");
});
