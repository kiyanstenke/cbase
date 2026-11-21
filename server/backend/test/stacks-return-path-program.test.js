// The return-path program itself (stacks/returnPath.js RETURN_PATH_PROGRAM) — directly with the REAL python3 and real git in a
// temp folder, without helper and without docker: what the program leaves on the disk when a write fails in the middle of a
// file, a run is terminated, a name is not UTF-8 or an entry vanishes. The ways through B (clearing away, fetch) are in
// stacks-clear-away.test.js (5), (6) and stacks-fetch.test.js (4), (5).
//
// What holds here:
//   back     writes into a leftover NEXT to the target and moves it into place only whole (file: `link`, folder: `rename`): a
//            write error (RLIMIT_FSIZE instead of ENOSPC), a SIGTERM in the middle of copying and an unreadable subfolder leave
//            NOTHING under the path in the main — and `error` instead of `denied`; a leftover of a killed run (SIGKILL) does
//            not block the next; the second run fetches completely, modes and times included. Directories and files are made
//            durable: fsync of the target's parent folder, fsync of every file in the folder.
//   lfs      a leftover that stayed behind (old format `.cbase-<sha>.tmp`, new `.cbase-lfs-<marker>-<sha>.tmp`) stops nothing; a
//            truncated write NEVER renames a file under the sha name (`error`, no `copied`); an existing object is not read;
//            it streams (peak of Python allocations under 8 MiB for a 32 MiB object, tracemalloc) and never opens a FIFO
//            (lstat before open, O_NONBLOCK) — `not a file`, the valid object beside it comes.
//   list     an entry that vanishes between listdir and lstat is only missing itself; one whose path breaks PATH_MAX is under
//            `u` — the list ends with `!end`. A name that is not UTF-8 or carries `\n` arrives as `F<json>` (surrogateescape);
//            layerSets reads it, nameBytes turns it back into exactly the bytes. The three places that pass such names on via
//            stdin (WIP, commit in the copy's project repo, check-ignore) send nulBytes (guard at the source — macOS creates
//            no such name). The BYTES are capped too (`!bytes`, exit 3); `tar` names at most `missingCap` names and the count.
//            In a dependencies folder it searches for `.git` — one set `i<rel>` per find (gitInside); that search has its own
//            cap (`depCap`): above it ONE set `x<folder>` (search incomplete) and the list runs on to `!end`.
//   merge    leaves the main untouched if the merge would overwrite an unversioned (ignored) file or had a conflict (merge-tree
//            in memory, then `--no-overwrite-ignore`): the main's `.env` stays, and a modify/delete conflict no longer deletes
//            the ignored `vendor/x.js` (it used to `merge --abort`). A clean merge goes through. If the main's HEAD moves between
//            merge-tree and merge ⇒ `merged: false` "main moved", neither `merge` nor `merge --abort` runs (git wrapper first
//            in PATH, gate file). With `fromOf` (only with `onlyCheck`): a tip above the start point is `free`, another `foreign`
//            ("does not descend from the start point"), an unknown start point `foreign` ("cannot be checked") — the main's HEAD stays; without
//            `fromOf` as before. LFS content: not the pointer (see the block below).
//   clones   creates missing levels (like `back`) and rejects only an EXISTING level that is no folder.
//   size     `returnPathDeadline(bytes)` grows with the bytes (64 GiB ⇒ far above 300 s); `lfs` and `back` run with it.
//
// COUNTER-PROOFS (each shown red):
//   old body of `back` (writing directly to the target path)        ⇒ back file, SIGTERM, folder red (leftover in the main)
//   `back` without `way_rest(tmp)` before creating                   ⇒ back SIGKILL leftover red (FileExistsError ⇒ error)
//   old body of `lfs`                                                ⇒ lfs leftover red (exit 1), truncated red (copied 1),
//                                                                      existing red (denied), memory red (peak ≥ 32 MiB);
//                                                                      FIFO: hangs (open blocks — ended from outside)
//   old body of `list` (lstat without try; raw names; only count)   ⇒ list both vanishing cases red, non-UTF-8 red, `!bytes` red
//   old body of `tar` (whole list `missing`)                         ⇒ tar red
//   old body of `merge` (`merge --no-edit`, abort with `--abort`)    ⇒ merge both red (.env overwritten, vendor/x.js deleted)
//   old body of `clones` (stages_real)                               ⇒ clones red (reference)
//   fetch.js / project-repo-copy.js / clearAway.js: stdin as a string again (`${x}\0` concatenated), each alone
//                                                                    ⇒ source guard for nulBytes red
//   `list` without git_in_dep                                        ⇒ dependencies red (only `anode_modules`)
//   copyLfs/copyBack without the deadline (asAgent without `deadline`) ⇒ size source guard red
//   `merge` without the second read of HEAD                          ⇒ merge-moves red (merge and merge --abort in the log)
//   `back` without sync_folder and with copy_file(…, False)          ⇒ back-durable red (no folder fsync, no fsync for d/x)
//   `merge` without the check of `fromOf`                              ⇒ merge-fromOf red (`{"free":true}` for the foreign tip)
//
// No clock: every run is waited for until its end (event `close`), never a duration. macOS: real TMPDIR.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RETURN_PATH_CAP_MS, RETURN_PATH_PROGRAM, nameBytes, nulBytes, returnPathDeadline, layerSets } from "../electron/server/stacks/returnPath.js";

const PY = execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
const TMP = fs.realpathSync(os.tmpdir());
const MIB = 1024 * 1024;
const IDENT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function withFolder(fn) {
  const d = fs.mkdtempSync(path.join(TMP, "cbase-rwp-"));
  try { return await fn(d); } finally { execFileSync("chmod", ["-R", "u+rwx", d]); execFileSync("rm", ["-rf", d]); }
}

/** One command of the program with the real python3 — until its end. `ulimitF`: RLIMIT_FSIZE in blocks of the shell.
 *  `program`: a (broken) version instead of RETURN_PATH_PROGRAM — for built-in counter-proofs. */
function run(command, { args = [], input, prelude = "", ulimitF, cwd, env = {}, program = RETURN_PATH_PROGRAM } = {}) {
  const prog = prelude ? `${prelude}\n${program}` : program;
  const argv = ulimitF === undefined
    ? [PY, ["-c", prog, command, ...args]]
    : ["/bin/sh", ["-c", `ulimit -f ${ulimitF}; exec "$0" "$@"`, PY, "-c", prog, command, ...args]];
  return new Promise((resolve, reject) => {
    const subprocess = spawn(argv[0], argv[1], { cwd, env: { ...process.env, ...IDENT, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const out = []; const err = [];
    subprocess.stdout.on("data", (b) => out.push(b));
    subprocess.stderr.on("data", (b) => err.push(b));
    subprocess.once("error", reject);
    subprocess.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    subprocess.stdin.on("error", () => {});
    subprocess.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}
const json = (r) => { try { return JSON.parse(r.stdout.toString("utf8")); } catch { assert.fail(`no JSON response (exit ${r.code}/${r.signal}): ${r.stdout.toString("utf8").slice(0, 300)} ${r.stderr.slice(-600)}`); } };
const leftovers = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(".cbase-")) : []);
const py = (s) => `__import__("os").fsencode(${JSON.stringify(s)})`; // a path as a bytes expression in the prelude

// ── back ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("back: a write error in the middle of the file leaves NOTHING under the path in the main (error, no leftover); the second run fetches it whole", async () => {
  await withFolder(async (d) => {
    const q = path.join(d, "layer"); const z = path.join(d, "main");
    fs.mkdirSync(path.join(q, "data"), { recursive: true }); fs.mkdirSync(z);
    const content = crypto.randomBytes(3 * MIB);
    fs.writeFileSync(path.join(q, "data", "dump.bin"), content, { mode: 0o640 });
    const input = { source: q, target: z, rels: ["data/dump.bin"] };
    const a1 = json(await run("back", { input, ulimitF: 2048 }));
    assert.deepEqual(a1.back, []);
    assert.deepEqual((a1.error || []).map((f) => f.rel), ["data/dump.bin"], JSON.stringify(a1));
    assert.match(a1.error[0].reason, /^Error: /);
    assert.deepEqual(a1.denied, [], "a write error is no \"denied\"");
    assert.equal(fs.existsSync(path.join(z, "data", "dump.bin")), false, "a truncated file is in the main");
    assert.deepEqual(leftovers(path.join(z, "data")), [], "a leftover stayed in the main");
    const a2 = json(await run("back", { input }));
    assert.deepEqual([a2.back, a2.error], [["data/dump.bin"], []]);
    assert.ok(fs.readFileSync(path.join(z, "data", "dump.bin")).equals(content), "not fetched completely");
    assert.equal(fs.statSync(path.join(z, "data", "dump.bin")).mode & 0o777, 0o640);
    assert.deepEqual(leftovers(path.join(z, "data")), []);
  });
});

test("back: SIGTERM in the middle of copying (the cap of asAgent) ⇒ exit 143, in the main neither file nor leftover", async () => {
  await withFolder(async (d) => {
    const q = path.join(d, "layer"); const z = path.join(d, "main");
    fs.mkdirSync(q); fs.mkdirSync(z);
    fs.writeFileSync(path.join(q, "large.bin"), crypto.randomBytes(2 * MIB));
    // The signal comes between the last write and taking the place — exactly where the old body left half a file.
    const prelude = `import os as _o, signal as _s\n_fc = _o.fchmod\ndef _fchmod(*a):\n    _o.kill(_o.getpid(), _s.SIGTERM)\n    return _fc(*a)\n_o.fchmod = _fchmod`;
    const r = await run("back", { input: { source: q, target: z, rels: ["large.bin"] }, prelude });
    assert.equal(r.code, 143, `Exit ${r.code}/${r.signal}: ${r.stderr.slice(-400)}`);
    assert.equal(fs.existsSync(path.join(z, "large.bin")), false, "a file is in the main although the run was terminated");
    assert.deepEqual(leftovers(z), [], "the leftover stayed after SIGTERM");
  });
});

test("back: a leftover of a killed run (SIGKILL, fixed name per copy and path) does not block — it is replaced", async () => {
  await withFolder(async (d) => {
    const q = path.join(d, "layer"); const z = path.join(d, "main");
    fs.mkdirSync(path.join(q, "a"), { recursive: true }); fs.mkdirSync(path.join(z, "a"), { recursive: true });
    fs.writeFileSync(path.join(q, "a", "x.log"), "whole\n");
    const marker = sha(Buffer.concat([Buffer.from(q), Buffer.from([0]), Buffer.from("a/x.log")])).slice(0, 24);
    fs.writeFileSync(path.join(z, "a", `.cbase-back-${marker}.tmp`), "half");
    const a = json(await run("back", { input: { source: q, target: z, rels: ["a/x.log"] } }));
    assert.deepEqual([a.back, a.error], [["a/x.log"], []], JSON.stringify(a));
    assert.equal(fs.readFileSync(path.join(z, "a", "x.log"), "utf8"), "whole\n");
    assert.deepEqual(leftovers(path.join(z, "a")), []);
  });
});

test("back: an unreadable subfolder ⇒ no half folder in the main; afterwards complete with modes", async () => {
  await withFolder(async (d) => {
    const q = path.join(d, "layer"); const z = path.join(d, "main");
    const nm = path.join(q, "node_modules");
    for (const [rel, text] of [["a/i.js", "a\n"], ["b/j.js", "b\n"], ["c/k.js", "c\n"]]) {
      fs.mkdirSync(path.dirname(path.join(nm, rel)), { recursive: true });
      fs.writeFileSync(path.join(nm, rel), text);
    }
    fs.chmodSync(path.join(nm, "a", "i.js"), 0o640);
    fs.chmodSync(path.join(nm, "c"), 0o750);
    fs.mkdirSync(z);
    fs.chmodSync(path.join(nm, "b"), 0o000);
    const input = { source: q, target: z, rels: ["node_modules"] };
    try {
      const a1 = json(await run("back", { input }));
      assert.deepEqual([a1.back, (a1.error || []).map((f) => f.rel)], [[], ["node_modules"]], JSON.stringify(a1));
      assert.equal(fs.existsSync(path.join(z, "node_modules")), false, "a half folder is in the main");
      assert.deepEqual(leftovers(z), []);
    } finally { fs.chmodSync(path.join(nm, "b"), 0o755); }
    const a2 = json(await run("back", { input }));
    assert.deepEqual([a2.back, a2.error], [["node_modules"], []]);
    for (const [rel, text] of [["a/i.js", "a\n"], ["b/j.js", "b\n"], ["c/k.js", "c\n"]]) assert.equal(fs.readFileSync(path.join(z, "node_modules", rel), "utf8"), text);
    assert.equal(fs.statSync(path.join(z, "node_modules", "a", "i.js")).mode & 0o777, 0o640);
    assert.equal(fs.statSync(path.join(z, "node_modules", "c")).mode & 0o777, 0o750);
    assert.deepEqual(leftovers(z), []);
  });
});

// ── lfs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function lfsLocations(d) {
  const q = path.join(d, "layer", ".git", "lfs", "objects");
  const z = path.join(d, "main", ".git", "lfs", "objects");
  fs.mkdirSync(q, { recursive: true }); fs.mkdirSync(path.join(d, "main", ".git"), { recursive: true });
  const create = (content, { name = sha(content) } = {}) => {
    const o = path.join(q, name.slice(0, 2), name.slice(2, 4));
    fs.mkdirSync(o, { recursive: true });
    fs.writeFileSync(path.join(o, name), content);
    return { name, rel: `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`, source: path.join(o, name), target: path.join(z, name.slice(0, 2), name.slice(2, 4), name), zo: path.join(z, name.slice(0, 2), name.slice(2, 4)) };
  };
  return { q, z, create };
}

test("lfs: leftovers that stayed behind (old and new format) stop nothing — the object comes, the leftovers are gone", async () => {
  await withFolder(async (d) => {
    const { q, z, create } = lfsLocations(d);
    const o = create(Buffer.from("lfs-content\n"));
    fs.mkdirSync(o.zo, { recursive: true });
    fs.writeFileSync(path.join(o.zo, `.cbase-${o.name}.tmp`), "half");
    const marker = sha(Buffer.from(q)).slice(0, 16);
    fs.writeFileSync(path.join(o.zo, `.cbase-lfs-${marker}-${o.name}.tmp`), "half");
    const r = await run("lfs", { args: [q, z] });
    assert.equal(r.code, 0, r.stderr.slice(-600));
    const a = json(r);
    assert.deepEqual([a.copied, a.existing, a.denied, a.error], [1, 0, [], []]);
    assert.equal(fs.readFileSync(o.target, "utf8"), "lfs-content\n");
    assert.deepEqual(leftovers(o.zo), []);
  });
});

test("lfs: a truncated write NEVER renames a file under the sha name — error, no leftover", async () => {
  await withFolder(async (d) => {
    const { q, z, create } = lfsLocations(d);
    const o = create(crypto.randomBytes(200_000));
    const a = json(await run("lfs", { args: [q, z], ulimitF: 100 }));
    assert.deepEqual([a.copied, a.existing], [0, 0], JSON.stringify(a));
    assert.deepEqual((a.error || []).map((f) => f.rel), [o.rel]);
    assert.equal(fs.existsSync(o.target), false, "a truncated file is under the sha name");
    assert.deepEqual(leftovers(o.zo), []);
    const b = json(await run("lfs", { args: [q, z] }));
    assert.deepEqual([b.copied, b.error], [1, []]);
    assert.equal(sha(fs.readFileSync(o.target)), o.name);
  });
});

test("lfs: an object already in the main is not read (existing, even if the source is unreadable)", async () => {
  await withFolder(async (d) => {
    const { q, z, create } = lfsLocations(d);
    const o = create(Buffer.from("already there\n"));
    fs.mkdirSync(o.zo, { recursive: true });
    fs.copyFileSync(o.source, o.target);
    fs.chmodSync(o.source, 0o000);
    const a = json(await run("lfs", { args: [q, z] }));
    assert.deepEqual([a.copied, a.existing, a.denied], [0, 1, []], JSON.stringify(a));
  });
});

test("lfs: a FIFO under an object name is never opened (not a file), the valid object beside it comes", async () => {
  await withFolder(async (d) => {
    const { q, z, create } = lfsLocations(d);
    const fifo = sha(Buffer.from("fifo"));
    const fo = path.join(q, fifo.slice(0, 2), fifo.slice(2, 4));
    fs.mkdirSync(fo, { recursive: true });
    execFileSync("mkfifo", [path.join(fo, fifo)]);
    const gut = create(Buffer.from("good\n"));
    const a = json(await run("lfs", { args: [q, z] }));
    assert.deepEqual(a.denied, [{ rel: `${fifo.slice(0, 2)}/${fifo.slice(2, 4)}/${fifo}`, reason: "not a file" }]);
    assert.equal(a.copied, 1);
    assert.equal(fs.readFileSync(gut.target, "utf8"), "good\n");
  });
});

test("lfs: an object is streamed, never wholly in memory (tracemalloc: peak under 8 MiB for 32 MiB)", async () => {
  await withFolder(async (d) => {
    const { q, z, create } = lfsLocations(d);
    const o = create(crypto.randomBytes(32 * MIB));
    const prelude = `import tracemalloc as _t, atexit as _a, sys as _y\n_t.start()\n_a.register(lambda: _y.stderr.write("PEAK %d\\n" % _t.get_traced_memory()[1]))`;
    const r = await run("lfs", { args: [q, z], prelude });
    assert.equal(json(r).copied, 1, r.stderr.slice(-400));
    const peak = Number(/PEAK (\d+)/.exec(r.stderr)?.[1]);
    assert.ok(Number.isInteger(peak), r.stderr.slice(-400));
    assert.ok(peak < 8 * MIB, `peak ${peak} bytes — the object was wholly in memory`);
    assert.equal(sha(fs.readFileSync(o.target)), o.name);
  });
});

// ── list, tar ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const listInput = (root, extra = {}) => ({ root, onto: true, cap: 1000, without: [], dependent: ["node_modules"], ...extra });
const sets = (r) => r.stdout.toString("utf8").split("\0");

test("list: an entry that vanishes between listdir and lstat is only missing itself — the list ends with !end", async () => {
  await withFolder(async (d) => {
    const w = path.join(d, "layer");
    fs.mkdirSync(w); fs.writeFileSync(path.join(w, "here.txt"), "here\n");
    const prelude = `import os as _o\n_W = ${py(w)}\n_ld = _o.listdir\ndef _listdir(p=b"."):\n    r = list(_ld(p))\n    if p == _W: r.append(b"vanished.txt")\n    return r\n_o.listdir = _listdir`;
    const r = await run("list", { input: listInput(w), prelude });
    assert.equal(r.code, 0, r.stderr.slice(-600));
    assert.deepEqual(sets(r), ["fhere.txt", "!end", ""]);
  });
});

test("list: an entry above PATH_MAX (ENAMETOOLONG) is under `u` instead of aborting the list", async () => {
  await withFolder(async (d) => {
    const w = path.join(d, "layer");
    fs.mkdirSync(w);
    const pathMax = Number(execFileSync("getconf", ["PATH_MAX", "/"], { encoding: "utf8" }).trim());
    assert.ok(pathMax >= 1024, `PATH_MAX ${pathMax}`);
    // A folder just under PATH_MAX, in it a name that lifts the whole path above it (created with a relative cd).
    const target = pathMax - 150;
    const parts = [];
    let length = w.length;
    while (length + 201 <= target - 50) { parts.push("o".repeat(200)); length += 201; }
    parts.push("p".repeat(target - length - 1));
    const name = "n".repeat(200);
    execFileSync("/bin/sh", ["-c", `cd "$1" && shift && for t in "$@"; do mkdir "$t" && cd "$t" || exit 1; done && : > "${name}"`, "sh", w, ...parts]);
    const r = await run("list", { input: listInput(w) });
    assert.equal(r.code, 0, r.stderr.slice(-600));
    const s = sets(r);
    assert.equal(s.at(-2), "!end");
    assert.ok(s.includes(`u${[...parts, name].join("/")}`), `no u entry for the long path: ${s.map((x) => x.slice(0, 12)).join(",")}`);
  });
});

test("list: a name that is not UTF-8 and one with \\n arrive as F<json>; layerSets reads them, nameBytes gives the bytes back", async () => {
  await withFolder(async (d) => {
    const w = path.join(d, "layer");
    fs.mkdirSync(w);
    fs.writeFileSync(path.join(w, "real.txt"), "e\n");
    fs.writeFileSync(path.join(w, "line\nbreak.txt"), "z\n");
    // macOS (APFS) accepts no name that is not UTF-8 — Linux does: listdir/lstat in the prelude show one.
    const prelude = `import os as _o\n_W = ${py(w)}\n_ld = _o.listdir; _ls = _o.lstat\ndef _listdir(p=b"."):\n    r = list(_ld(p))\n    if p == _W: r.append(b"caf\\xe9.txt")\n    return r\ndef _lstat(p, *a, **k):\n    if p == _o.path.join(_W, b"caf\\xe9.txt"): return _ls(_o.path.join(_W, b"real.txt"))\n    return _ls(p, *a, **k)\n_o.listdir = _listdir; _o.lstat = _lstat`;
    const r = await run("list", { input: listInput(w), prelude });
    assert.equal(r.code, 0, r.stderr.slice(-600));
    assert.ok(r.stdout.includes(Buffer.from('F"caf\\udce9.txt"\0')), r.stdout.toString("latin1"));
    assert.ok(r.stdout.includes(Buffer.from('F"line\\nbreak.txt"\0')), r.stdout.toString("latin1"));
    const l = layerSets(r.stdout.toString("utf8"), w);
    assert.deepEqual(l.files, ["caf\udce9.txt", "line\nbreak.txt", "real.txt"]);
    assert.ok(nameBytes("caf\udce9.txt").equals(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74])));
    assert.ok(nameBytes("a/\u{1F4A9}").equals(Buffer.from("a/\u{1F4A9}", "utf8")), "a real pair (lower half U+DCA9) did not stay UTF-8");
    assert.ok(nulBytes(["x", "caf\udce9"]).equals(Buffer.from([0x78, 0, 0x63, 0x61, 0x66, 0xe9, 0])));
  });
});

// The three places that give the layer's names to Perl/git via stdin send BYTES (nulBytes) — a string with a lone surrogate would
// arrive as U+FFFD (EF BF BD), and check-ignore/`git add` would see a path that does not exist. On macOS such a name cannot be
// created, so the guard stands at the source (call site and form).
test("list, source: WIP (fetch.js), commit in the copy's project repo (project-repo-copy.js) and check-ignore (clearAway.js) give stdin as nulBytes", () => {
  const stacks = path.join(import.meta.dirname, "../electron/server/stacks");
  const places = [["fetch.js", "the backup (WIP)"], ["project-repo-copy.js", "the commit in the copy's project repo"], ["clearAway.js", "check-ignore"]];
  for (const [file, what] of places) {
    const t = fs.readFileSync(path.join(stacks, file), "utf8");
    const rows = t.split("\n").filter((z) => z.includes(`what: "${what}"`) || z.includes(`what: T("${what}")`));
    assert.equal(rows.length, 1, `${file}: call site "${what}" not found exactly once`);
    assert.match(rows[0], /stdin: nulBytes\(/, `${file}: stdin of the call site "${what}" not as nulBytes`);
    assert.doesNotMatch(t, /\.map\(\(\w+\) => `\$\{\w+\}\\0`\)\.join\(""\)/, `${file}: names concatenated as a string with \\0`);
  }
});

test("list: above the bytes cap the list ends with !bytes and exit 3 (not only at the count cap)", async () => {
  await withFolder(async (d) => {
    const w = path.join(d, "layer");
    fs.mkdirSync(w);
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(w, `${"x".repeat(40)}${i}.txt`), "");
    const r = await run("list", { input: listInput(w, { bytes: 200 }) });
    assert.equal(r.code, 3, r.stderr.slice(-400));
    assert.equal(sets(r).at(-2), "!bytes");
    assert.ok(r.stdout.length < 300, `${r.stdout.length} bytes despite cap 200`);
  });
});

test("tar: `missing` names at most missingCap names, the count stands beside it", async () => {
  await withFolder(async (d) => {
    const w = path.join(d, "layer");
    fs.mkdirSync(w);
    const entries = Array.from({ length: 300 }, (_, i) => [w, `missing-${i}.txt`, `missing-${i}.txt`]);
    const r = await run("tar", { input: { entries, cap: MIB, missingCap: 200 } });
    assert.equal(r.code, 0, r.stderr.slice(-400));
    const j = JSON.parse(r.stderr.trim().split("\n").pop());
    assert.deepEqual([j.missing.length, j.count], [200, 300]);
  });
});

// ── merge ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const mergeInput = (target, oid) => ({ target, oid, redirector: [], prefixes: [] });

test("merge: the copy makes `.env` visible and changes it ⇒ not merged, the main's `.env` byte-equal; a clean merge goes through", async () => {
  await withFolder(async (d) => {
    const r = path.join(d, "main");
    fs.mkdirSync(r);
    git(r, "init", "-q");
    fs.writeFileSync(path.join(r, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(r, "a.txt"), "a\n");
    git(r, "add", "."); git(r, "commit", "-q", "-m", "base");
    git(r, "checkout", "-q", "-b", "copy");
    fs.writeFileSync(path.join(r, ".gitignore"), "");
    fs.writeFileSync(path.join(r, ".env"), "COPY=2\n");
    git(r, "add", "-A"); git(r, "commit", "-q", "-m", "copy");
    const copy = git(r, "rev-parse", "HEAD");
    git(r, "checkout", "-q", "main");
    git(r, "checkout", "-q", "-b", "clean"); fs.writeFileSync(path.join(r, "fresh.txt"), "new\n"); git(r, "add", "fresh.txt"); git(r, "commit", "-q", "-m", "clean");
    const clean = git(r, "rev-parse", "HEAD");
    git(r, "checkout", "-q", "main");
    fs.writeFileSync(path.join(r, ".env"), "MAIN_SECRET=1\n");
    const head = git(r, "rev-parse", "HEAD");

    const a = json(await run("merge", { input: mergeInput("refs/heads/copy", copy), cwd: r }));
    assert.equal(a.merged, false, JSON.stringify(a));
    assert.match(a.notice, /\.env/);
    assert.equal(fs.readFileSync(path.join(r, ".env"), "utf8"), "MAIN_SECRET=1\n", "the main's ignored file was overwritten");
    assert.equal(git(r, "rev-parse", "HEAD"), head);

    const b = json(await run("merge", { input: mergeInput("refs/heads/clean", clean), cwd: r }));
    assert.equal(b.merged, true, JSON.stringify(b));
    assert.equal(git(r, "rev-parse", "HEAD"), clean);
    assert.equal(fs.readFileSync(path.join(r, ".env"), "utf8"), "MAIN_SECRET=1\n");
  });
});

test("merge: modify/delete against a file excluded in the main ⇒ not merged, the file stays (no merge --abort that deletes it)", async () => {
  await withFolder(async (d) => {
    const r = path.join(d, "main");
    fs.mkdirSync(path.join(r, "vendor"), { recursive: true });
    git(r, "init", "-q");
    fs.writeFileSync(path.join(r, "vendor", "x.js"), "v1\n");
    git(r, "add", "."); git(r, "commit", "-q", "-m", "base");
    git(r, "checkout", "-q", "-b", "copy");
    fs.writeFileSync(path.join(r, "vendor", "x.js"), "v2 from the copy\n");
    git(r, "commit", "-q", "-am", "copy");
    const copy = git(r, "rev-parse", "HEAD");
    git(r, "checkout", "-q", "main");
    // The main: vendor/ became an embedded repo — out of the index, excluded via info/exclude (commitProjectRepo).
    git(r, "rm", "-q", "--cached", "vendor/x.js");
    fs.appendFileSync(path.join(r, ".git", "info", "exclude"), "/vendor/\n");
    git(r, "commit", "-q", "-m", "vendor is a repo");
    fs.writeFileSync(path.join(r, "vendor", "x.js"), "v1 in the embedded repo\n");
    const head = git(r, "rev-parse", "HEAD");

    const a = json(await run("merge", { input: mergeInput("refs/heads/copy", copy), cwd: r }));
    assert.equal(a.merged, false, JSON.stringify(a));
    assert.equal(fs.existsSync(path.join(r, "vendor", "x.js")), true, "the main's excluded file is gone (merge --abort)");
    assert.equal(fs.readFileSync(path.join(r, "vendor", "x.js"), "utf8"), "v1 in the embedded repo\n");
    assert.equal(git(r, "rev-parse", "HEAD"), head);
    assert.equal(fs.existsSync(path.join(r, ".git", "MERGE_HEAD")), false);
  });
});

// ── merge: the LFS content, not the pointer ─────────────────────────────────────────────────────────────────────────────────
// The project box sets `GIT_LFS_SKIP_SMUDGE=1` (ENV of the image), and `filter.lfs` is in /etc/gitconfig. The merge in the main
// ran with this environment (the program's git environment takes over os.environ) and wrote the POINTER file for `filter=lfs` —
// although copyLfs had put the object into .git/lfs/objects beforehand. git-lfs is missing on the Mac: the guard imitates it with
// a fake filter `lfs` following git-lfs's rules — smudge: `GIT_LFS_SKIP_SMUDGE` on ⇒ the pointer; otherwise the object from
// `.git/lfs/objects/<aa>/<bb>/<oid>`; if it is missing, with `GIT_LFS_SKIP_DOWNLOAD_ERRORS` on the pointer, otherwise an error
// (exit 2, "Error downloading object"), and `filter.lfs.required`. Every run carries `GIT_LFS_SKIP_SMUDGE=1` as in the helper.
//   (a) object in the main ⇒ merged, the CONTENT is in the main;
//   (b) object missing ⇒ merged (the merge does not abort), the pointer is in the main.
// BUILT-IN COUNTER-PROOFS: the program without the line ⇒ (a) writes the pointer; only with `GIT_LFS_SKIP_SMUDGE=0`, without
// `GIT_LFS_SKIP_DOWNLOAD_ERRORS` ⇒ (b) the merge fails at the filter.
const FAKE_LFS = String.raw`
import os, sys
kind, deposit = sys.argv[1], sys.argv[2]
data = sys.stdin.buffer.read()
an = lambda n: os.environ.get(n, "") in ("1", "true")
if kind == "clean":
    sys.stdout.buffer.write(data); sys.exit(0)
oid = None
for z in data.decode("utf-8", "replace").splitlines():
    if z.startswith("oid sha256:"): oid = z[len("oid sha256:"):].strip()
if an("GIT_LFS_SKIP_SMUDGE") or not oid:
    sys.stdout.buffer.write(data); sys.exit(0)
p = os.path.join(deposit, oid[0:2], oid[2:4], oid)
if os.path.isfile(p):
    with open(p, "rb") as f: sys.stdout.buffer.write(f.read())
    sys.exit(0)
if an("GIT_LFS_SKIP_DOWNLOAD_ERRORS"):
    sys.stdout.buffer.write(data); sys.exit(0)
sys.stderr.write("Error downloading object: " + oid + "\n"); sys.exit(2)
`;
const LFS_ROW = '    env["GIT_LFS_SKIP_SMUDGE"] = "0"; env["GIT_LFS_SKIP_DOWNLOAD_ERRORS"] = "1"\n';

// A main with `*.bin filter=lfs` on main and a branch `copy` that brings `image.bin` as a pointer; afterwards the fake filter
// (only then — nothing should filter while creating) and, with `object`, the object where copyLfs puts it.
function lfsMain(r, { object }) {
  const content = `CONTENT from the copy ${crypto.randomBytes(6).toString("hex")}\n`;
  const oid = sha(Buffer.from(content));
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(content)}\n`;
  fs.mkdirSync(r, { recursive: true });
  git(r, "init", "-q");
  fs.writeFileSync(path.join(r, ".gitattributes"), "*.bin filter=lfs -text\n");
  git(r, "add", "."); git(r, "commit", "-q", "-m", "base");
  git(r, "checkout", "-q", "-b", "copy");
  fs.writeFileSync(path.join(r, "image.bin"), pointer);
  git(r, "add", "image.bin"); git(r, "commit", "-q", "-m", "copy");
  const copy = git(r, "rev-parse", "HEAD");
  git(r, "checkout", "-q", "main");
  const filter = path.join(r, "..", `fake-lfs-${path.basename(r)}.py`);
  fs.writeFileSync(filter, FAKE_LFS);
  const deposit = path.join(r, ".git", "lfs", "objects");
  for (const kind of ["smudge", "clean"]) git(r, "config", `filter.lfs.${kind}`, `'${PY}' '${filter}' ${kind} '${deposit}'`);
  git(r, "config", "filter.lfs.required", "true");
  if (object) {
    fs.mkdirSync(path.join(deposit, oid.slice(0, 2), oid.slice(2, 4)), { recursive: true });
    fs.writeFileSync(path.join(deposit, oid.slice(0, 2), oid.slice(2, 4), oid), content);
  }
  return { copy, content, pointer };
}
const lfsMerge = (r, copy, program) => run("merge", { input: mergeInput("refs/heads/copy", copy), cwd: r, env: { GIT_LFS_SKIP_SMUDGE: "1" }, ...(program ? { program } : {}) });

test("merge (LFS): with the project box's GIT_LFS_SKIP_SMUDGE=1 the LFS content reaches the main where the object lies — otherwise the pointer, without the merge failing", async () => {
  assert.equal(RETURN_PATH_PROGRAM.split(LFS_ROW).length, 2, "the line is not in the program exactly once — the counter-proofs do not bite");
  await withFolder(async (d) => {
    // (a) the object is in the main (copyLfs) ⇒ the content.
    const ra = path.join(d, "a");
    const a = lfsMain(ra, { object: true });
    const ma = json(await lfsMerge(ra, a.copy));
    assert.equal(ma.merged, true, JSON.stringify(ma));
    assert.equal(git(ra, "rev-parse", "HEAD"), a.copy);
    assert.equal(fs.readFileSync(path.join(ra, "image.bin"), "utf8"), a.content, "the pointer is in the main instead of the content");
    // (b) the object is missing ⇒ the merge goes through, the pointer is in the main.
    const rb = path.join(d, "b");
    const b = lfsMain(rb, { object: false });
    const mb = json(await lfsMerge(rb, b.copy));
    assert.equal(mb.merged, true, JSON.stringify(mb));
    assert.equal(fs.readFileSync(path.join(rb, "image.bin"), "utf8"), b.pointer);

    // COUNTER-PROOF 1: without the line (the state before the repair) ⇒ (a) writes the pointer.
    const rc = path.join(d, "c");
    const c = lfsMain(rc, { object: true });
    const mc = json(await lfsMerge(rc, c.copy, RETURN_PATH_PROGRAM.replace(LFS_ROW, "")));
    assert.equal(mc.merged, true, JSON.stringify(mc));
    assert.equal(fs.readFileSync(path.join(rc, "image.bin"), "utf8"), c.pointer, "the counter-proof does not bite: without the line the content came");
    // COUNTER-PROOF 2: only GIT_LFS_SKIP_SMUDGE=0 ⇒ (b) fails at the filter (a missing object would abort the merge in the main).
    const re = path.join(d, "e");
    const e = lfsMain(re, { object: false });
    const me = json(await lfsMerge(re, e.copy, RETURN_PATH_PROGRAM.replace(LFS_ROW, '    env["GIT_LFS_SKIP_SMUDGE"] = "0"\n')));
    assert.equal(me.merged, false, `the counter-proof does not bite: without GIT_LFS_SKIP_DOWNLOAD_ERRORS the merge went through (${JSON.stringify(me)})`);
    assert.match(me.notice, /smudge|Error downloading object|filter/i);
  });
});

// ── clones ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("clones: a new repo under a folder the main does not have ⇒ cloned; an existing level as a symlink ⇒ reference", async () => {
  await withFolder(async (d) => {
    const source = path.join(d, "source");
    fs.mkdirSync(source);
    git(source, "init", "-q");
    fs.writeFileSync(path.join(source, "x.txt"), "x\n");
    git(source, "add", "."); git(source, "commit", "-q", "-m", "x");
    const x = git(source, "rev-parse", "HEAD");
    const bundle = path.join(d, "n0.bundle");
    git(source, "bundle", "create", "-q", bundle, "--all");
    const h = path.join(d, "main");
    fs.mkdirSync(path.join(h, "real"), { recursive: true });
    fs.symlinkSync(path.join(h, "real"), path.join(h, "sym"));

    const a = json(await run("clones", { input: { root: h, rel: "experiments/fresh", bundle, redirector: [], prefixes: [] }, cwd: h }));
    assert.equal(a.cloned, true, JSON.stringify(a));
    assert.equal(git(path.join(h, "experiments", "fresh"), "rev-parse", "HEAD"), x);

    const b = json(await run("clones", { input: { root: h, rel: "sym/new2", bundle, redirector: [], prefixes: [] }, cwd: h }));
    assert.deepEqual(b, { cloned: false, reason: "reference" });
    assert.deepEqual(fs.readdirSync(path.join(h, "real")), [], "written through the symlink");
  });
});

// ── list: repos in dependencies ──────────────────────────────────────────────────────────────────────────────────────────

test("list: a repo in a dependencies folder (node_modules/lib/.git) gives the set `inode_modules/lib`", async () => {
  await withFolder(async (d) => {
    const w = path.join(d, "layer");
    fs.mkdirSync(path.join(w, "node_modules", "lib", ".git"), { recursive: true });
    fs.writeFileSync(path.join(w, "node_modules", "lib", ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(w, "node_modules", "lib", "index.js"), "x\n");
    fs.mkdirSync(path.join(w, "node_modules", "without"), { recursive: true });
    fs.writeFileSync(path.join(w, "node_modules", "without", "a.js"), "a\n");
    const r = await run("list", { input: listInput(w) });
    assert.equal(r.code, 0, r.stderr.slice(-600));
    const s = sets(r);
    assert.ok(s.includes("inode_modules/lib"), `no i set: ${s.join(",")}`);
    assert.ok(s.includes("anode_modules"), "the dependencies folder is missing as an a set");
    assert.deepEqual(layerSets(r.stdout.toString("utf8"), w).gitInside, ["node_modules/lib"]);
    assert.deepEqual(layerSets(r.stdout.toString("utf8"), w).depIncomplete, []);
  });
});

// The search in the dependencies has its OWN cap (`depCap`). Above it stands ONE set `x<folder>` (search incomplete) and the
// list runs on to `!end`; the list cap counts the folder as ONE entry. Before, every visited entry counted against the list cap,
// and the WHOLE list aborted with `!cap` (exit 3) — fetch and clearing away failed at a large node_modules. COUNTER-PROOF: the old
// program ⇒ red (exit 3 `!cap` at list cap 5; no set `x` at depCap 3).
test("list: the search in the dependencies counts against depCap — above it `x<folder>` instead of `!cap`, the list runs on to `!end`", async () => {
  await withFolder(async (d) => {
    const w = path.join(d, "layer");
    fs.mkdirSync(path.join(w, "node_modules", "lib", ".git"), { recursive: true });
    fs.writeFileSync(path.join(w, "node_modules", "lib", ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(w, "node_modules", "many"), { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(w, "node_modules", "many", `d${i}.js`), "x\n");
    fs.writeFileSync(path.join(w, "a.txt"), "a\n");
    // The case at hand: 24 entries in node_modules, list cap 5 — the list has only 3 sets.
    const z = await run("list", { input: listInput(w, { cap: 5, depCap: 1000 }) });
    assert.equal(z.code, 0, `${sets(z).slice(-3).join(",")} ${z.stderr.slice(-400)}`);
    assert.deepEqual(sets(z).slice(0, -1).sort(), ["!end", "anode_modules", "fa.txt", "inode_modules/lib"]);
    // The own cap: reached ⇒ `xnode_modules`, otherwise nothing truncated.
    const k = await run("list", { input: listInput(w, { depCap: 3 }) });
    assert.equal(k.code, 0, k.stderr.slice(-600));
    assert.equal(sets(k).at(-2), "!end");
    assert.ok(sets(k).includes("xnode_modules"), `no x set: ${sets(k).join(",")}`);
    const l = layerSets(k.stdout.toString("utf8"), w);
    assert.deepEqual(l.depIncomplete, ["node_modules"]);
    assert.deepEqual(l.files, ["a.txt"]);
  });
});

// ── size: deadline ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("size: returnPathDeadline grows with the bytes (64 GiB ⇒ over 300 s), copyLfs and copyBack use it, size counts bytes", async () => {
  assert.equal(returnPathDeadline(0), RETURN_PATH_CAP_MS);
  assert.ok(returnPathDeadline(64 * 1024 ** 3) > 300_000 + RETURN_PATH_CAP_MS, `${returnPathDeadline(64 * 1024 ** 3)} ms`);
  const t = fs.readFileSync(path.join(import.meta.dirname, "../electron/server/stacks/returnPath.js"), "utf8");
  for (const fn of ["copyLfs", "copyBack"]) {
    const body = t.slice(t.indexOf(`export async function ${fn}(`), t.indexOf("\n}\n", t.indexOf(`export async function ${fn}(`)));
    assert.match(body, /const deadline = returnPathDeadline\(await sizeIn\(/, `${fn}: no deadline from the size`);
    assert.match(body, /await asAgent\([^\n]*, deadline\);/, `${fn}: asAgent without the deadline`);
  }
  await withFolder(async (d) => {
    fs.mkdirSync(path.join(d, "q", "u"), { recursive: true });
    fs.writeFileSync(path.join(d, "q", "a"), Buffer.alloc(1000));
    fs.writeFileSync(path.join(d, "q", "u", "b"), Buffer.alloc(24));
    fs.symlinkSync("/etc/hosts", path.join(d, "q", "v"));
    assert.deepEqual(json(await run("size", { input: { paths: [path.join(d, "q"), path.join(d, "missing")] } })), { bytes: 1024 });
  });
});

// ── merge: the main moves ────────────────────────────────────────────────────────────────────────────────────────────────

test("merge: if someone commits in the main between merge-tree and merge ⇒ merged:false \"main moved\", neither merge nor merge --abort", async () => {
  await withFolder(async (d) => {
    const r = path.join(d, "main");
    fs.mkdirSync(r);
    git(r, "init", "-q");
    fs.writeFileSync(path.join(r, "a.txt"), "base\n");
    git(r, "add", "."); git(r, "commit", "-q", "-m", "base");
    git(r, "checkout", "-q", "-b", "copy");
    fs.writeFileSync(path.join(r, "a.txt"), "from the copy\n");
    git(r, "commit", "-q", "-am", "copy");
    const copy = git(r, "rev-parse", "HEAD");
    git(r, "checkout", "-q", "main");
    // The wrapper first in PATH: logs every call; after `merge-tree` it commits ONCE (gate file) a colliding change in the main —
    // like an agent working in the main at exactly that moment.
    const bin = path.join(d, "bin"); fs.mkdirSync(bin);
    const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const log = path.join(d, "log"); const gate = path.join(d, "gate");
    fs.writeFileSync(gate, "");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case " $* " in
  *" merge-tree "*) '${real}' "$@"; rc=$?
    if [ -e '${gate}' ]; then rm -f '${gate}'
      printf 'in the main\\n' > a.txt && '${real}' -c user.name=t -c user.email=t@t commit -q -am main >/dev/null 2>&1; fi
    exit $rc;;
esac
exec '${real}' "$@"
`, { mode: 0o755 });
    const a = json(await run("merge", { input: mergeInput("refs/heads/copy", copy), cwd: r, env: { PATH: `${bin}:${process.env.PATH}` } }));
    assert.equal(fs.existsSync(gate), false, "the wrapper did not run (merge-tree not seen)");
    assert.equal(a.merged, false, JSON.stringify(a));
    assert.match(a.notice, /main moved/);
    const p = fs.readFileSync(log, "utf8").split("\n");
    assert.deepEqual(p.filter((z) => / merge --no-overwrite-ignore | merge --abort/.test(` ${z} `)), [], "merge or merge --abort ran against the moved HEAD");
    assert.equal(fs.readFileSync(path.join(r, "a.txt"), "utf8"), "in the main\n");
    assert.equal(fs.existsSync(path.join(r, ".git", "MERGE_HEAD")), false);
  });
});

// ── back: durable ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("back: the target's parent folder is synced, and every file of a copied folder (d/x) too", async () => {
  await withFolder(async (d) => {
    const q = path.join(d, "layer"); const z = path.join(d, "main");
    fs.mkdirSync(path.join(q, "d"), { recursive: true }); fs.mkdirSync(z);
    fs.writeFileSync(path.join(q, "f.txt"), "f\n");
    fs.writeFileSync(path.join(q, "d", "x"), "x\n");
    // The seam: every os.fsync logs (folder?, inode) to stderr.
    const prelude = `import os as _o, stat as _st, sys as _sy, json as _js\n_fs = _o.fsync\ndef _fsync(fd):\n    s = _o.fstat(fd)\n    _sy.stderr.write("FSYNC " + _js.dumps([_st.S_ISDIR(s.st_mode), s.st_ino]) + "\\n")\n    return _fs(fd)\n_o.fsync = _fsync`;
    const r = await run("back", { input: { source: q, target: z, rels: ["f.txt", "d"] }, prelude });
    const a = json(r);
    assert.deepEqual([a.back, a.error], [["f.txt", "d"], []], JSON.stringify(a));
    const syncs = r.stderr.split("\n").filter((l) => l.startsWith("FSYNC ")).map((l) => JSON.parse(l.slice(6)));
    const ino = (p) => fs.statSync(p).ino;
    assert.ok(syncs.some(([folder, i]) => folder && i === ino(z)), `no fsync of the target's parent folder: ${JSON.stringify(syncs)}`);
    assert.ok(syncs.some(([folder, i]) => !folder && i === ino(path.join(z, "d", "x"))), "no fsync for d/x");
    assert.ok(syncs.some(([folder, i]) => folder && i === ino(path.join(z, "d"))), "the created folder d was not synced before the rename");
  });
});

// ── merge `fromOf` ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("merge: `fromOf` — a tip above the start point is free, another foreign (nothing touched), an unknown start point not checkable", async () => {
  await withFolder(async (d) => {
    const r = path.join(d, "main");
    fs.mkdirSync(r);
    git(r, "init", "-q");
    fs.writeFileSync(path.join(r, "a.txt"), "a\n");
    git(r, "add", "."); git(r, "commit", "-q", "-m", "start");
    const start = git(r, "rev-parse", "HEAD");
    // The detached tip of the copy: a commit above the start point.
    git(r, "checkout", "-q", "--detach");
    fs.writeFileSync(path.join(r, "copy.md"), "k\n"); git(r, "add", "copy.md"); git(r, "commit", "-q", "-m", "copy");
    const go = git(r, "rev-parse", "HEAD");
    git(r, "update-ref", "refs/heads/copy/k1/detached", go);
    git(r, "checkout", "-q", "main");
    // The main moves on ("state before copy").
    fs.writeFileSync(path.join(r, "main.md"), "h\n"); git(r, "add", "main.md"); git(r, "commit", "-q", "-m", "state before copy");
    const head = git(r, "rev-parse", "HEAD");
    const including = (fromOf) => ({ ...mergeInput("refs/heads/copy/k1/detached", go), onlyCheck: true, fromOf });

    assert.deepEqual(json(await run("merge", { input: including(start), cwd: r })), { free: true });
    const f = json(await run("merge", { input: including(head), cwd: r }));
    assert.equal(f.foreign, true, JSON.stringify(f));
    assert.match(f.notice, /does not descend from the start point/);
    const u = json(await run("merge", { input: including("0".repeat(40)), cwd: r }));
    assert.equal(u.foreign, true, JSON.stringify(u));
    assert.match(u.notice, /cannot be checked/);
    assert.equal(git(r, "rev-parse", "HEAD"), head, "the check touched the main");
    // Without `fromOf` as before; the merge itself brings the tip.
    assert.deepEqual(json(await run("merge", { input: { ...mergeInput("refs/heads/copy/k1/detached", go), onlyCheck: true }, cwd: r })), { free: true });
    assert.equal(json(await run("merge", { input: mergeInput("refs/heads/copy/k1/detached", go), cwd: r })).merged, true);
    assert.equal(git(r, "show", "HEAD:copy.md"), "k");
    assert.equal(git(r, "show", "HEAD:main.md"), "h");
  });
});
