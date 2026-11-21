// Guard for the file access of copies (server/backend/electron/server/runtime/fileAccess.js).
//
// THE ACCESS. The loop engine's file tools, the code editor and the project memory run in B, and B sees the main; the overlay view of a
// copy exists only INSIDE the copy container. Every access to a path under a copy's project folder therefore goes through its
// container (one Node program per call via commandRun) — and if the container fails, the call fails, never a read or write in B in
// its place.
//
// The promises, each with the way that breaks it:
//   (1) fileWay: only a COPY knows the way "copy"; the main and "no instance" are always "b"; the runtime folder stays in B; a path
//       under OR above a copy's project folder goes through it (a tree walk from above would otherwise see the main); a neighbour with
//       the same name start (`project-x` next to `project`) does not belong.
//   (2) The cores (operations of the program, in B against a folder AND as a real `node -e PROGRAM` — the same result, so no outside
//       references in the cores' text): read with size/sha/cap, write with comparison (`expect`: ECONFLICT instead of a silent
//       overwrite), append, binary bytes over stdin, stat/list/create/name/erase with the error codes files.js reports today.
//   (3) The tree walks (glob, grep, search, names): the rules of tool-runtime.js and files.js (hidden and heavy folders out, binary
//       and too large skipped, context lines, multiline, cap with notice); the paths come back RELATIVE.
//   (4) The overlay view (real copy on the fake docker): a file of the main can be read in the copy; what the copy writes stands only
//       in it (the main stays byte-exact, sha256); what it deletes is "not found" there and still present in the main; a tree walk sees
//       the copy's own file, B does not; binary bytes arrive and come back intact.
//   (5) No fallback: if the container is down (`exec` fails), every call throws `FileAccessError` — reading does not return the main,
//       writing creates nothing in B. An output cap is an error with a message, no silent truncation. Without an instance or with a
//       relative path the call is a build error (TypeError), no way to B.
//
// No clock: the copy is built through the real queue (stacks-copy-harness.mjs), waiting is on states; the cap is triggered through the
// size of the output, not a deadline.
//
// COUNTER-TESTS (one sabotage each on a copy of the tree):
//   run in B instead of the container                     => (4), (5) red
//   write without comparison                              => (2), (4) red
//   cap swallowed                                         => (5) red
//   container error becomes empty                         => (5) red
//   fileWay without copy check                            => (1) red
//   fileWay deeper anchor does not win                    => (1) red
//   fileWay runtime inside the project always b           => (1) red
//   fileWay only under the project                        => (1) red
//   fileWay neighbour with same start                     => (1) red
//   glob oldest first                                     => (3) red
//   glob anchor ignored                                   => (3) red
//   grep reads binary                                     => (3) red
//   grep without context separator                        => (3) red
//   search enters .git                                    => (3) red
//   search without size limit                             => (3) red
//   write without folder creation                         => (2), (4) red
//   erase follows the symlink                             => (2) red
//   create overwrites                                     => (4) red
//   relative paths allowed                                => (5) red
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as dz from "../electron/server/runtime/fileAccess.js";
import { instanceForProject, instanceIsCopy } from "../electron/server/runs/instance.js";
import { json } from "./agent-harness.mjs";
import { buildCopy, situationDefault, withCopy } from "./stacks-copy-harness.mjs";

const { CORES, PROGRAM, FileAccessError } = dz;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (p) => sha(fs.readFileSync(p));
const SKIP = ["node_modules", ".git", "dist", "build", ".next", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".cache", "coverage", ".turbo"];

// The operation in B against a folder (in-process) and as the real program in a child process: both must say the same.
function inB(op, o, paths, stdin = Buffer.alloc(0)) {
  try { return { ok: true, ...CORES.programCore(fs, path, crypto, op, o, paths, () => stdin) }; }
  catch (e) { return { ok: false, code: e.code || "EERROR", message: String(e.message) }; }
}
function asProgram(op, o, paths, stdin = Buffer.alloc(0)) {
  const rawOut = execFileSync(process.execPath, ["-e", PROGRAM, "--", op, JSON.stringify(o), ...paths], { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(rawOut.trim().split("\n").pop());
}
const beides = (op, o, paths, stdin) => {
  const a = inB(op, o, paths, stdin);
  const b = asProgram(op, o, paths, stdin);
  assert.deepEqual(b, a, `${op}: the program in the child process says something different from the core in B`);
  return a;
};

function withFolder(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-file-access-")));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function write(root, rel, content, sec) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (sec != null) fs.utimesSync(p, sec, sec);
  return p;
}
// The tree of the tree walks: visible (a.js, src/b.ts, src/deep/c.md), binary (bin.dat with NUL), heavy (node_modules, .git), hidden (.hidden).
function tree(root) {
  write(root, "a.js", "const x = 1;\nfoo()\nconst y = 2;\nFOO()\n", 1000);
  write(root, "src/b.ts", "export const foo = 1;\nexport function bar() {}\n", 3000);
  write(root, "src/deep/c.md", "# Title\nfoo bar\nbaz\n", 2000);
  write(root, "src/deep/bin.dat", Buffer.from([0x66, 0x6f, 0x6f, 0, 1, 2]), 10);
  write(root, "node_modules/m/i.js", "foo\n", 20);
  write(root, ".hidden/h.js", "foo\n", 30);
  write(root, ".git/config", "foo\n", 40);
}

// ── (1) fileWay ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) fileWay: only a copy goes through the container — the runtime folder stays in B, a path above the project belongs to the copy, a neighbour does not", () => {
  const copy = { projectId: "p1", instance: "copy-k1", identifier: "p1/copy-k1" };
  const main = { projectId: "p1", instance: "main", identifier: "p1/main" };
  const location = { project: "/w/project", runtime: "/d/runtime/p1" };
  const table = [
    [copy, "/w/project", "copy"], [copy, "/w/project/src/a.js", "copy"], [copy, "/w/project/../project/x", "copy"],
    [copy, "/w", "copy"], // a tree walk from above would see the main
    [copy, "/w/project-x/a.js", "b"], [copy, "/w/other/a.js", "b"],
    [copy, "/d/runtime/p1/attachment/image.png", "b"], [copy, "/d/runtime/p1", "b"],
    [copy, "/etc/hosts", "b"],
    [main, "/w/project/src/a.js", "b"], [main, "/w", "b"],
    [{ projectId: "p1" }, "/w/project/a.js", "b"], [null, "/w/project/a.js", "b"], [undefined, "/w/project/a.js", "b"],
  ];
  for (const [inst, abs, expected] of table) assert.equal(dz.fileWay(inst, abs, location), expected, `${inst?.identifier || inst} ${abs}`);
  assert.equal(dz.fileWay(copy, "/w/project/a.js", {}), "b", "without a project folder the way knows nothing of a copy");
  // If one anchor lies within the other, the deeper wins; a tree walk above the runtime folder stays in B.
  const inProject = { project: "/w/project", runtime: "/w/project/.runtime" };
  assert.equal(dz.fileWay(copy, "/w/project/.runtime/outputs/x.txt", inProject), "b");
  assert.equal(dz.fileWay(copy, "/w/project/src/a.js", inProject), "copy");
  const reversed = { project: "/d/l/p1/work", runtime: "/d/l/p1" };
  assert.equal(dz.fileWay(copy, "/d/l/p1/work/a.js", reversed), "copy");
  assert.equal(dz.fileWay(copy, "/d/l/p1/attachment/x.png", reversed), "b");
  assert.equal(dz.fileWay(copy, "/d/l/p1", reversed), "b", "the runtime folder itself stays in B, even if the project lies inside it");
  assert.equal(instanceIsCopy(copy), true);
  assert.equal(instanceIsCopy(main), false);
});

// ── (2) The operations ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The mutating cores run per way in a folder of their own: once as a function in B, once as the real program in a child process.
const WAYS = { "in B": inB, "as program": asProgram };

for (const [way, run] of Object.entries(WAYS)) test(`(2) cores ${way}: read, write with comparison, append, binary bytes`, () => {
  withFolder((w) => {
    const p = path.join(w, "sub", "t.txt");
    // Writing creates folders and reports size and sha256.
    let r = run("write", {}, [p], Buffer.from("Hello\n"));
    assert.equal(r.ok, true);
    assert.equal(r.size, 6);
    assert.equal(r.sha256, sha("Hello\n"));
    // Reading: kind, size, sha256, bytes as base64.
    r = run("read", { maxBytes: 100 }, [p]);
    assert.deepEqual({ kind: r.kind, size: r.size, sha256: r.sha256, data: Buffer.from(r.data, "base64").toString() }, { kind: "file", size: 6, sha256: sha("Hello\n"), data: "Hello\n" });
    // Above maxBytes no bytes come.
    r = run("read", { maxBytes: 3 }, [p]);
    assert.equal(r.tooBig, true);
    assert.equal(r.size, 6);
    assert.equal(r.data, undefined);
    // A folder is not opened.
    r = run("read", { maxBytes: 100 }, [path.dirname(p)]);
    assert.equal(r.kind, "folder");
    // If it is missing: ENOENT.
    r = run("read", { maxBytes: 100 }, [path.join(w, "missing.txt")]);
    assert.deepEqual([r.ok, r.code], [false, "ENOENT"]);
    assert.equal(r.message, `ENOENT: no such file or directory, open '${path.join(w, "missing.txt")}'`, "the message like readFileSync's in B");
    // An empty file: size 0, the sha256 of nothing.
    r = run("write", {}, [path.join(w, "empty.txt")], Buffer.alloc(0));
    assert.deepEqual([r.ok, r.size, r.sha256], [true, 0, sha("")]);
    // The comparison: the expected sha256 matches → written; another → ECONFLICT, the file stays.
    r = run("write", { expect: sha("Hello\n") }, [p], Buffer.from("Two\n"));
    assert.equal(r.ok, true);
    r = run("write", { expect: sha("Hello\n") }, [p], Buffer.from("Three\n"));
    assert.deepEqual([r.ok, r.code], [false, "ECONFLICT"]);
    assert.equal(fs.readFileSync(p, "utf8"), "Two\n", "a stale state overwrote the file");
    // `expect: null`: the file must not exist.
    r = run("write", { expect: null }, [p], Buffer.from("Four\n"));
    assert.deepEqual([r.ok, r.code], [false, "ECONFLICT"]);
    r = run("write", { expect: null }, [path.join(w, "fresh.txt")], Buffer.from("New\n"));
    assert.equal(r.ok, true);
    // Append: continue instead of replace (chunks of an upload).
    run("write", { append: true }, [p], Buffer.from("+appended\n"));
    assert.equal(fs.readFileSync(p, "utf8"), "Two\n+appended\n");
    // Binary: every byte value survives the way.
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    run("write", {}, [path.join(w, "all.bin")], all);
    r = run("read", { maxBytes: 1000 }, [path.join(w, "all.bin")]);
    assert.ok(Buffer.from(r.data, "base64").equals(all), "binary bytes changed");
    assert.equal(r.sha256, sha(all));
    // A folder as the target of a write: EISDIR, nothing written.
    r = run("write", {}, [path.dirname(p)], Buffer.from("x"));
    assert.deepEqual([r.ok, r.code], [false, "EISDIR"]);
    // Unknown operation.
    assert.equal(run("conjure", {}, [p]).code, "EOP");
  });
});

for (const [way, run] of Object.entries(WAYS)) test(`(2) cores ${way}: stat, list, create, name, erase — the errors files.js reports today (EEXIST, ENOENT, ENOTDIR)`, () => {
  withFolder((w) => {
    write(w, "d/a.txt", "a");
    fs.symlinkSync("a.txt", path.join(w, "d", "reference"));
    fs.symlinkSync("missing", path.join(w, "d", "tot"));
    let r = run("stat", {}, [path.join(w, "d/a.txt")]);
    assert.deepEqual([r.kind, r.size], ["file", 1]);
    r = run("stat", {}, [path.join(w, "d/reference")]);
    assert.deepEqual([r.kind, r.target.kind], ["reference", "file"]);
    r = run("stat", {}, [path.join(w, "d/tot")]);
    assert.deepEqual([r.kind, r.target], ["reference", null]);
    assert.equal(run("stat", {}, [path.join(w, "nothing")]).code, "ENOENT");
    // list: lstat per entry, for a symlink the target too.
    r = run("list", {}, [path.join(w, "d")]);
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    assert.deepEqual(Object.keys(byName).sort(), ["a.txt", "reference", "tot"]);
    assert.equal(byName["a.txt"].kind, "file");
    assert.equal(byName.reference.kind, "reference");
    assert.equal(byName.reference.target.kind, "file");
    assert.equal(byName.tot.target, null);
    assert.equal(run("list", {}, [path.join(w, "d/a.txt")]).code, "ENOTDIR");
    assert.equal(run("list", {}, [path.join(w, "nothing")]).code, "ENOENT");
    // create: new yes, existing (also as a dead symlink) EEXIST.
    assert.equal(run("create", { kind: "file" }, [path.join(w, "n/x/fresh.txt")]).ok, true);
    assert.equal(fs.readFileSync(path.join(w, "n/x/fresh.txt"), "utf8"), "");
    assert.equal(run("create", { kind: "folder" }, [path.join(w, "n/y/z")]).ok, true);
    assert.ok(fs.statSync(path.join(w, "n/y/z")).isDirectory());
    assert.equal(run("create", { kind: "file" }, [path.join(w, "d/a.txt")]).code, "EEXIST");
    assert.equal(run("create", { kind: "file" }, [path.join(w, "d/tot")]).code, "EEXIST", "a symlink without target is an existing name");
    assert.equal(fs.existsSync(path.join(w, "missing")), false, "create followed the dead symlink");
    // name: source missing ENOENT, target present EEXIST, otherwise moved (the target's folders are created).
    assert.equal(run("name", {}, [path.join(w, "nothing"), path.join(w, "x")]).code, "ENOENT");
    assert.equal(run("name", {}, [path.join(w, "d/a.txt"), path.join(w, "d/reference")]).code, "EEXIST");
    assert.equal(run("name", {}, [path.join(w, "d/a.txt"), path.join(w, "e/f/b.txt")]).ok, true);
    assert.equal(fs.readFileSync(path.join(w, "e/f/b.txt"), "utf8"), "a");
    // erase: a symlink goes itself, its target stays; a folder with its content; something missing ENOENT.
    write(w, "target/stays.txt", "b");
    fs.symlinkSync(path.join(w, "target"), path.join(w, "d", "to-target"));
    assert.equal(run("erase", {}, [path.join(w, "d/to-target")]).ok, true);
    assert.ok(fs.existsSync(path.join(w, "target/stays.txt")), "erase followed the symlink");
    assert.equal(run("erase", {}, [path.join(w, "d")]).ok, true);
    assert.equal(fs.existsSync(path.join(w, "d")), false);
    assert.equal(run("erase", {}, [path.join(w, "d")]).code, "ENOENT");
  });
});

// ── (3) The tree walks ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) glob: the rules of tool-runtime — root-relative, by modification time, hidden and heavy folders out, cap", () => {
  withFolder((w) => {
    tree(w);
    const o = { skip: SKIP, maxFiles: 20000, maxHits: 400 };
    let r = beides("glob", { ...o, pattern: "**/*.js", anchor: w }, [w]);
    assert.deepEqual(r.hits.map((t) => t.rel), ["a.js"], "node_modules and .hidden do not belong");
    // Against the file name alone, by modification time: the newest first.
    r = beides("glob", { ...o, pattern: "src/**", anchor: w }, [w]);
    assert.deepEqual(r.hits.map((t) => t.rel), ["src/b.ts", "src/deep/c.md", "src/deep/bin.dat"]);
    r = beides("glob", { ...o, pattern: "*.md", anchor: w }, [w]);
    assert.deepEqual(r.hits.map((t) => t.rel), ["src/deep/c.md"], "the file name alone hits");
    // Against the absolute location that B names (`anchor`) — not against the one under which the container sees the root.
    r = beides("glob", { ...o, pattern: `${w}/src/*.ts`, anchor: w }, [w]);
    assert.deepEqual(r.hits.map((t) => t.rel), ["src/b.ts"]);
    r = inB("glob", { ...o, pattern: "/whole/elsewhere/src/*.ts", anchor: "/whole/elsewhere" }, [w]);
    assert.deepEqual(r.hits.map((t) => t.rel), ["src/b.ts"], "the anchor counts, not the root in the container");
    // Cap: total counts all, hits only up to maxHits; maxFiles ends the walk.
    r = beides("glob", { ...o, pattern: "src/**", anchor: w, maxHits: 1 }, [w]);
    assert.deepEqual([r.total, r.hits.length], [3, 1]);
    r = beides("glob", { ...o, pattern: "**", anchor: w, maxFiles: 2 }, [w]);
    assert.equal(r.total, 2);
  });
});

// globToRegExp once turned `**` and `*` into nested `.*` — a pattern with many `**` needed unbounded backtracking against every
// NON-matching path, synchronously (measured: 7.2 s for 1,932 files). Now an automaton with at most length(pattern) × length(path)
// steps, in B as in the container's program (its text goes along via PROGRAM). The table pins the old meaning: `*`/`?` never across
// `/`, `**` across everything except a line end, a `/` after `**` belongs to it, `[`/`{` literal.
test("(3) glob without backtracking — the same meaning as before, a pattern with many ** at once, in B as in the program", () => {
  const table = [
    ["**/*.ts", "a.ts", true], ["**/*.ts", "src/x/a.ts", true], ["**/*.ts", "a.tsx", false],
    ["src/**", "src/a/b", true], ["src/**", "src", false], ["*.md", "a/b.md", false], ["*.md", "b.md", true],
    ["a?c", "abc", true], ["a?c", "a/c", false], ["**", "", true], ["**", "a\nb", false], ["*", "a\nb", true],
    ["[a].md", "[a].md", true], ["[a].md", "a.md", false], ["{a,b}.md", "a.md", false], ["{a,b}.md", "{a,b}.md", true],
    ["a.b", "axb", false], ["***", "a/b", true], ["x/**/y", "x/y", true], ["x/**/y", "x/a/b/y", true],
  ];
  for (const [pattern, filePath, desired] of table) assert.equal(dz.globToRegExp(pattern).test(filePath), desired, `${pattern} against ${JSON.stringify(filePath)}`);
  withFolder((w) => {
    const deep = Array.from({ length: 12 }, (_, i) => `folder-with-long-names-${i}`).join("/");
    write(w, `${deep}/one-file-with-long-names.js`, "x", 1000);
    write(w, `${deep}/target.md`, "x", 2000);
    const r = beides("glob", { skip: SKIP, maxFiles: 20000, maxHits: 400, pattern: "**/**/**/**/**/**/**/**/**/*.md", anchor: w }, [w]);
    assert.deepEqual(r.hits.map((t) => t.rel), [`${deep}/target.md`]);
  });
});

test("(3) grep: hit lines with context, multiline, filter, binary skipped, invalid expression — lines relative to the target", () => {
  withFolder((w) => {
    tree(w);
    const o = { skip: SKIP, maxFiles: 20000, maxHits: 300, mode: "content", prior: 0, after: 0, numbers: true, ci: false, multiline: false, glob: null, exts: null };
    const afterFile = (r) => Object.fromEntries(r.proFile.map((e) => [e.file, e]));
    let r = beides("grep", { ...o, pattern: "foo" }, [w]);
    let d = afterFile(r);
    assert.deepEqual(Object.keys(d).sort(), ["a.js", "src/b.ts", "src/deep/c.md"], "binary, node_modules and .hidden drop out");
    assert.deepEqual(d["a.js"].lines, [[2, ":", "foo()"]]);
    assert.equal(r.total, 3);
    assert.equal(r.cutOff, false);
    // Case.
    r = beides("grep", { ...o, pattern: "foo", ci: true }, [w]);
    assert.deepEqual(afterFile(r)["a.js"].lines, [[2, ":", "foo()"], "--", [4, ":", "FOO()"]], "two groups (line 3 missing): \"--\" between");
    // Context: lines before and after, hit lines with ":", context with "-".
    r = beides("grep", { ...o, pattern: "bar", prior: 1, after: 1, glob: "*.md" }, [w]);
    assert.deepEqual(Object.keys(afterFile(r)), ["src/deep/c.md"]);
    assert.deepEqual(afterFile(r)["src/deep/c.md"].lines, [[1, "-", "# Title"], [2, ":", "foo bar"], [3, "-", "baz"]]);
    // A single file as target: its `file` is empty.
    r = beides("grep", { ...o, pattern: "const" }, [path.join(w, "a.js")]);
    assert.deepEqual(afterFile(r)[""].lines, [[1, ":", "const x = 1;"], "--", [3, ":", "const y = 2;"]], "a single file is called \"\"");
    // File type (extensions) and target "file".
    r = beides("grep", { ...o, pattern: "foo", exts: ["ts"] }, [w]);
    assert.deepEqual(Object.keys(afterFile(r)), ["src/b.ts"]);
    // Multiline: `s` lets "." hit line breaks, both lines count.
    r = beides("grep", { ...o, pattern: "x = 1;\\nfoo", multiline: true }, [w]);
    assert.deepEqual(afterFile(r)["a.js"].lines, [[1, ":", "const x = 1;"], [2, ":", "foo()"]]);
    // A target that does not exist: empty, no error.
    r = beides("grep", { ...o, pattern: "foo" }, [path.join(w, "exists-not")]);
    assert.deepEqual(r.proFile, []);
    // Invalid expression.
    r = beides("grep", { ...o, pattern: "(" }, [w]);
    assert.match(r.error, /Invalid RegExp/);
    // Cap of the hits: truncation is reported, not concealed.
    r = beides("grep", { ...o, pattern: "foo", ci: true, maxHits: 1 }, [path.join(w, "a.js")]);
    assert.equal(r.cutOff, true);
    // Cap of the files.
    r = beides("grep", { ...o, pattern: "foo", maxFiles: 1 }, [w]);
    assert.equal(r.proFile.length <= 1, true);
  });
});

test("(3) search and names: the rules of files.js — .git and node_modules out (VS Code's defaults), hidden folders NOT, binary and too large files skipped, cap", () => {
  withFolder((w) => {
    tree(w);
    const o = { query: "foo", regex: false, caseSensitive: false, heavy: false, skip: SKIP, maxFiles: 40000, maxFile: 1024 * 1024, maxHits: 2000 };
    const rels = (r) => r.results.map((e) => e.rel).sort();
    let r = beides("search", o, [w]);
    assert.deepEqual(rels(r), [".hidden/h.js", "a.js", "src/b.ts", "src/deep/c.md"], "unlike glob/grep a hidden folder counts");
    assert.equal(r.hits, 5);
    assert.equal(r.files, 4);
    assert.equal(r.cutOff, false);
    const a = r.results.find((e) => e.rel === "a.js");
    assert.deepEqual(a.matches, [{ line: 2, text: "foo()", hits: [[0, 3]] }, { line: 4, text: "FOO()", hits: [[0, 3]] }]);
    // Case, without "use exclude settings and ignore files" everything (also .git — like VS Code), regex.
    assert.deepEqual(rels(beides("search", { ...o, caseSensitive: true }, [w])), [".hidden/h.js", "a.js", "src/b.ts", "src/deep/c.md"]);
    assert.deepEqual(beides("search", { ...o, caseSensitive: true }, [w]).results.find((e) => e.rel === "a.js").matches.length, 1);
    assert.deepEqual(rels(beides("search", { ...o, exclusions: false }, [w])), [".git/config", ".hidden/h.js", "a.js", "node_modules/m/i.js", "src/b.ts", "src/deep/c.md"]);
    assert.deepEqual(rels(beides("search", { ...o, query: "^export", regex: true }, [w])), ["src/b.ts"]);
    assert.match(beides("search", { ...o, query: "(", regex: true }, [w]).error, /Invalid regular expression/);
    // Too large files drop out (`maxFile`), the cap of the hits is reported.
    assert.deepEqual(rels(beides("search", { ...o, maxFile: 10 }, [w])), [".hidden/h.js"]);
    assert.equal(beides("search", { ...o, maxHits: 2 }, [w]).cutOff, true);
    assert.equal(beides("search", { ...o, maxFiles: 1 }, [w]).cutOff, true);
    // names: the relative path contains the query; without a query all (except heavy folders); the cap reports `stopped`.
    let n = beides("names", { query: "deep", skip: SKIP, maxFiles: 20000 }, [w]);
    assert.deepEqual(n.files.sort(), ["src/deep/bin.dat", "src/deep/c.md"]);
    n = beides("names", { query: "", skip: SKIP, maxFiles: 20000 }, [w]);
    assert.deepEqual(n.files.sort(), [".hidden/h.js", "a.js", "src/b.ts", "src/deep/bin.dat", "src/deep/c.md"]);
    assert.equal(n.stopped, false);
    n = beides("names", { query: "", skip: SKIP, maxFiles: 2 }, [w]);
    assert.equal(n.stopped, true);
  });
});

// ── (4) + (5) Through the container of a real copy ─────────────────────────────────────────────────────────────────────────

async function copyWithChat(ctx, b) {
  const pid = b.s.projectId;
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
  await buildCopy(b, { chatId: ctx.chat.id });
  const inst = instanceForProject(pid, "copy-k1");
  assert.ok(inst, "the copy's instance must resolve");
  assert.equal(instanceIsCopy(inst), true);
  return inst;
}
const errorOf = async (p) => { try { await p; } catch (e) { return e; } return null; };

test("(4) overlay view: the copy reads through to the main, writes and deletes only in itself; the main stays byte-exact; a tree walk sees the file of the copy only", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const notes = path.join(b.s.path, "notes.md");
    const mainPrior = shaFile(notes);

    // The main's file can be read in the copy (lower layer).
    let r = await dz.read(inst, notes);
    assert.equal(r.kind, "file");
    assert.equal(r.data.toString(), "Notizen\n");
    assert.equal(r.sha256, mainPrior);
    assert.equal((await dz.stat(inst, notes)).kind, "file");

    // Writing in the copy: the copy reads the new content, the main does not.
    const w = await dz.write(inst, notes, "only in the copy\n");
    assert.equal(w.sha256, sha("only in the copy\n"));
    assert.equal((await dz.read(inst, notes)).data.toString(), "only in the copy\n");
    assert.equal(shaFile(notes), mainPrior, "the copy wrote into the main");

    // A file ONLY of the copy (with a new folder): there in the copy, not in B.
    const only = path.join(b.s.path, "fresh", "copy-only.txt");
    await dz.write(inst, only, "K\n");
    assert.equal((await dz.read(inst, only)).data.toString(), "K\n");
    assert.equal(fs.existsSync(only), false, "the copy's file lies in B, so in the main");
    assert.equal(fs.existsSync(path.dirname(only)), false);
    const namesInFolder = (await dz.list(inst, path.dirname(only))).map((e) => e.name);
    assert.deepEqual(namesInFolder, ["copy-only.txt"]);
    assert.ok((await dz.list(inst, b.s.path)).some((e) => e.name === "fresh"));

    // Binary bytes survive the way through docker exec (stdin → file → base64 back).
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await dz.write(inst, path.join(b.s.path, "all.bin"), all);
    const back = await dz.read(inst, path.join(b.s.path, "all.bin"));
    assert.ok(back.data.equals(all), "binary bytes changed");
    assert.equal(back.sha256, sha(all));
    // `tooBig` carries the FULL size (> maxBytes) — channels/messages.js relies on it. Counter-test: fileAccess.js returning
    // `size: o.maxBytes` instead of `st.size` => (2) and (4) red.
    const tooBig = await dz.read(inst, path.join(b.s.path, "all.bin"), { maxBytes: 10 });
    assert.deepEqual([tooBig.tooBig, tooBig.size, tooBig.data], [true, 256, null], "tooBig without the full size");
    assert.ok(tooBig.size > 10);
    // An empty file: stdin is empty, but there.
    const empty = await dz.write(inst, path.join(b.s.path, "empty.txt"), "");
    assert.deepEqual([empty.size, empty.sha256], [0, sha("")]);
    assert.equal((await dz.read(inst, path.join(b.s.path, "empty.txt"))).data.length, 0);

    // The tree walks see what shows through AND the own; B only the main.
    const o = { skip: SKIP, maxFiles: 20000, maxHits: 400 };
    const g = await dz.glob(inst, b.s.path, { ...o, pattern: "**/*.txt" });
    const gp = g.hits.map((t) => path.relative(b.s.path, t.p)).sort();
    assert.deepEqual(gp, ["app/a.txt", "app/b.txt", "app/c.txt", "empty.txt", "fresh/copy-only.txt"], "glob: showing through plus own, absolute paths under the root");
    assert.ok(g.hits.every((t) => path.isAbsolute(t.p) && t.p.startsWith(b.s.path + path.sep)));
    const gr = await dz.grep(inst, b.s.path, { ...o, maxHits: 300, mode: "content", prior: 0, after: 0, numbers: true, ci: false, multiline: false, glob: null, exts: null, pattern: "only in the copy" });
    assert.deepEqual(gr.proFile.map((e) => e.file), [notes]);
    assert.deepEqual(gr.proFile[0].lines, [`${notes}:1:only in the copy`]);
    const su = await dz.search(inst, b.s.path, { query: "copy", regex: false, caseSensitive: true, heavy: false, skip: SKIP, maxFiles: 40000, maxFile: 1048576, maxHits: 2000 });
    assert.deepEqual(su.results.map((e) => e.rel).sort(), ["notes.md"]);
    const na = await dz.names(inst, b.s.path, { query: "copy-only", skip: SKIP, maxFiles: 20000 });
    assert.deepEqual(na.files, ["fresh/copy-only.txt"]);
    assert.equal(fs.existsSync(path.join(b.s.path, "fresh")), false);

    // Deleting in the copy: "not found" there, still present in the main (whiteout of the upper layer).
    await dz.erase(inst, notes);
    assert.equal(await dz.stat(inst, notes), null);
    const e = await errorOf(dz.read(inst, notes));
    assert.ok(e instanceof FileAccessError, String(e));
    assert.equal(e.code, "ENOENT");
    assert.equal(shaFile(notes), mainPrior, "the copy's delete hit the main");
    assert.equal((await dz.list(inst, b.s.path)).some((x) => x.name === "notes.md"), false);

    // Creating, renaming, deleting a folder in the copy.
    await dz.create(inst, path.join(b.s.path, "folder", "x.txt"), "file");
    assert.equal((await errorOf(dz.create(inst, path.join(b.s.path, "folder", "x.txt"), "file"))).code, "EEXIST");
    // An existing FOLDER is likewise not silently "created" (mkdir -p would): create reports what is already there.
    await dz.create(inst, path.join(b.s.path, "folder3"), "folder");
    assert.equal((await errorOf(dz.create(inst, path.join(b.s.path, "folder3"), "folder"))).code, "EEXIST");
    await dz.erase(inst, path.join(b.s.path, "folder3"));
    await dz.name(inst, path.join(b.s.path, "folder"), path.join(b.s.path, "folder2"));
    assert.equal((await errorOf(dz.name(inst, path.join(b.s.path, "folder"), path.join(b.s.path, "x")))).code, "ENOENT");
    await dz.erase(inst, path.join(b.s.path, "folder2"));
    assert.equal(await dz.stat(inst, path.join(b.s.path, "folder2", "x.txt")), null);
    assert.equal(fs.existsSync(path.join(b.s.path, "folder")) || fs.existsSync(path.join(b.s.path, "folder2")), false, "a folder of the copy lies in the main");
  });
});

test("(4) edit: read, change, write back with comparison — if the file changed in between, ECONFLICT instead of a silent overwrite", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const file = path.join(b.s.path, "edit.txt");
    await dz.write(inst, file, "one\ntwo\n");
    // The ordinary way.
    const w = await dz.edit(inst, file, (t) => t.replace("two", "2"));
    assert.equal(w.sha256, sha("one\n2\n"));
    assert.equal((await dz.read(inst, file)).data.toString(), "one\n2\n");
    // Another writer between reading and writing: conflict, its state stays.
    const e = await errorOf(dz.edit(inst, file, async (t) => {
      await dz.write(inst, file, "between\n");
      return `${t}my state\n`;
    }));
    assert.equal(e?.code, "ECONFLICT", String(e));
    assert.equal((await dz.read(inst, file)).data.toString(), "between\n", "the stale state overwrote the newer one");
    // The change itself fails: nothing written.
    const e2 = await errorOf(dz.edit(inst, file, () => { throw new Error("old_string not found"); }));
    assert.match(e2.message, /old_string not found/);
    assert.equal((await dz.read(inst, file)).data.toString(), "between\n");
    // A folder and a missing file.
    assert.equal((await errorOf(dz.edit(inst, b.s.path, (t) => t))).code, "EISDIR");
    assert.equal((await errorOf(dz.edit(inst, path.join(b.s.path, "missing.txt"), (t) => t))).code, "ENOENT");
    // Too large: not read, not changed.
    assert.equal((await errorOf(dz.edit(inst, file, (t) => t, { maxBytes: 3 }))).code, "TOO_LARGE");
    // `expect` on writing: the file must not exist / must have this state.
    assert.equal((await errorOf(dz.write(inst, file, "x", { expect: null }))).code, "ECONFLICT");
    assert.equal((await dz.write(inst, path.join(b.s.path, "fresh.txt"), "x", { expect: null })).size, 1);
  });
});

test("(5) no fallback: if the container is down every call throws — reading does not return the main, writing creates nothing in B; the output cap is an error with a message", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const notes = path.join(b.s.path, "notes.md");
    const mainPrior = shaFile(notes);
    const o = { skip: SKIP, maxFiles: 20000, maxHits: 400, pattern: "**/*" };

    // The output cap (no timer): an answer that does not fit the buffer is an error with a message.
    const d = await errorOf(dz.glob(inst, b.s.path, o, { maxBuffer: 16 }));
    assert.ok(d instanceof FileAccessError, String(d));
    assert.equal(d.code, "CAP");
    assert.equal(d.cap, "output");
    assert.match(d.message, /output cap \(16 bytes\) reached — aborted, nothing truncated/);
    assert.match(d.message, /copy-k1/, "the message names the copy");

    // The container is down (every exec fails as after a restart).
    const cfg = path.join(b.fd.dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), execBroken: [b.copy] }));
    const error = [
      await errorOf(dz.read(inst, notes)),
      await errorOf(dz.write(inst, path.join(b.s.path, "fallback.txt"), "in B?\n")),
      await errorOf(dz.edit(inst, notes, (t) => `${t}x`)),
      await errorOf(dz.stat(inst, notes)),
      await errorOf(dz.list(inst, b.s.path)),
      await errorOf(dz.create(inst, path.join(b.s.path, "fallback-folder"), "folder")),
      await errorOf(dz.name(inst, notes, path.join(b.s.path, "fallback-new.md"))),
      await errorOf(dz.erase(inst, notes)),
      await errorOf(dz.glob(inst, b.s.path, o)),
      await errorOf(dz.grep(inst, b.s.path, { ...o, pattern: "Notizen", mode: "content", prior: 0, after: 0, numbers: true })),
      await errorOf(dz.search(inst, b.s.path, { query: "Notizen", skip: SKIP, maxFiles: 10, maxFile: 1000, maxHits: 10 })),
      await errorOf(dz.names(inst, b.s.path, { query: "", skip: SKIP, maxFiles: 10 })),
    ];
    error.forEach((e, i) => {
      assert.ok(e instanceof FileAccessError, `call ${i}: ${e ? String(e) : "returned something instead of throwing (fallback to B?)"}`);
      assert.equal(e.code, "PROGRAM", `call ${i}: ${e.code}`);
    });
    // B is untouched: nothing created, renamed, deleted or written.
    assert.equal(shaFile(notes), mainPrior);
    for (const n of ["fallback.txt", "fallback-folder", "fallback-new.md"]) assert.equal(fs.existsSync(path.join(b.s.path, n)), false, `${n} lies in B`);

    // Build errors are no ways to B: without instance, with a relative path.
    assert.ok((await errorOf(dz.read(null, notes))) instanceof TypeError);
    assert.ok((await errorOf(dz.read(inst, "notes.md"))) instanceof TypeError);
    assert.ok((await errorOf(dz.write(inst, "rel/x.txt", "x"))) instanceof TypeError);
    assert.equal(fs.existsSync(path.join(process.cwd(), "rel")), false);
  });
});

// ── (6) list with repoInfo ───────────────────────────────────────────────────────────────────────
// For the layout: per folder entry `isRepo` (`.git` is a FOLDER) and `worktreeOf` (`.git` is a file whose `gitdir:` points into
// `<repo>/.git/worktrees/<n>` of a repo UNDER the root — relative). A submodule (`.git/modules/…`), a worktree of a repo outside the
// root, a symlink named `.git` and a FIFO named `.git` are neither. Without `repoInfo` the answer stays as before (no new fields). In B
// and as program the same.
// COUNTER-TESTS: `isRepo` via `statSync` instead of `lstatSync` (follows the symlink) => (6) red at "reference"; the root comparison
// without separator (`startsWith(root)`) => (6) red at "neighbor".
test("(6) list with repoInfo: isRepo only for a .git folder, worktreeOf only for a worktree of a repo under the root — without repoInfo as before", () => {
  withFolder((t) => {
    const w = path.join(t, "proj");
    fs.mkdirSync(path.join(w, "repo", ".git", "worktrees", "wt1"), { recursive: true });
    fs.mkdirSync(path.join(w, "deep", "inside", ".git", "worktrees", "x"), { recursive: true });
    write(w, "wt/.git", "gitdir: ../repo/.git/worktrees/wt1\n");
    write(w, "wt-abs/.git", `gitdir: ${path.join(w, "deep", "inside", ".git", "worktrees", "x")}\n`);
    write(w, "sub/.git", "gitdir: ../repo/.git/modules/sub\n");
    // A repo NEXT TO the root with the same name start (`proj-x`): its worktree in the root is no worktree "of the project".
    fs.mkdirSync(path.join(t, "proj-x", ".git", "worktrees", "n"), { recursive: true });
    write(w, "neighbor/.git", `gitdir: ${path.join(t, "proj-x", ".git", "worktrees", "n")}\n`);
    fs.mkdirSync(path.join(t, "foreign", ".git"), { recursive: true });
    fs.mkdirSync(path.join(w, "reference"));
    fs.symlinkSync(path.join(t, "foreign", ".git"), path.join(w, "reference", ".git"));
    fs.mkdirSync(path.join(w, "fifo"));
    execFileSync("mkfifo", [path.join(w, "fifo", ".git")]);
    fs.mkdirSync(path.join(w, "free"));
    write(w, "file.txt", "x");
    const r = beides("list", { repoInfo: true, root: w }, [w]);
    const byKey = Object.fromEntries(r.entries.map((e) => [e.name, { isRepo: e.isRepo, worktreeOf: e.worktreeOf }]));
    assert.deepEqual(byKey, {
      "file.txt": { isRepo: undefined, worktreeOf: undefined },
      fifo: { isRepo: false, worktreeOf: undefined },
      free: { isRepo: false, worktreeOf: undefined },
      neighbor: { isRepo: false, worktreeOf: undefined },
      repo: { isRepo: true, worktreeOf: undefined },
      sub: { isRepo: false, worktreeOf: undefined },
      deep: { isRepo: false, worktreeOf: undefined },
      reference: { isRepo: false, worktreeOf: undefined },
      wt: { isRepo: false, worktreeOf: "repo" },
      "wt-abs": { isRepo: false, worktreeOf: "deep/inside" },
    });
    // Without repoInfo: no new field (the code editor gets the same answer as before).
    const without = beides("list", {}, [w]);
    assert.ok(without.entries.every((e) => !("isRepo" in e) && !("worktreeOf" in e)), JSON.stringify(without.entries));
  });
});
