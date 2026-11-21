// The expanded commit in the git bar's graph: the options `files` and `file` of `POST …/git/show`
// (electron/server/git.js "A commit, expanded", gitCommitPart). Measured on a REAL repo in a temp folder.
//
// What hangs here and why it is a guard:
//   (a) The files of an ordinary commit: change, rename (R with the old path), deletion, creation — each exactly once, with the letter
//       git means. Without `-M` the web would show a delete plus a create.
//   (b) A merge commit shows ONLY what it carries against its FIRST parent (like VS Code) — not the changes of the line merged into,
//       and not the combined form.
//   (c) A root commit shows every file as created (against the empty tree) — without `--root` it would say "no changes".
//   (d) File names with spaces, umlauts and NEWLINE arrive verbatim (`-z`); without `-z` the name would be quoted with escapes and
//       the click would ask for a file that does not exist.
//   (e) The cap says it is one: at most 1,000 files, `total` counts all, `clipped` is true; the cap of the output (`cutOff`) drops
//       the half last entry and says `total: null` (unknown, not "this many").
//   (f) The diff of exactly ONE file in this commit, both paths for a rename; in the root commit against the empty tree; in the
//       merge against the first parent; at most 2 MiB, cut at a line boundary, with `clipped`.
//   (g) HARDENING: the hash only lowercase hex 5–64 and exactly one commit starting with it; a path with a leading "-", `..`,
//       absolute, `.`/empty segments is an error BEFORE the first git (`--output=x` writes nothing); `:(glob)*` and `*` are file
//       names, not patterns (`--literal-pathspecs`); a file really named "-x" goes as "./-x".
//   (h) The route: both options go through (200), nonsense is 400, without options the old form `{ hash, diff }` stays.
//   (i) The HOVERED commit (git.js "A commit, hovered", option `info`): author (with umlaut), mail, AUTHOR time in ms, the whole message
//       (subject and body, line breaks, umlauts — also when the repo sets `i18n.logOutputEncoding` to Latin-1), and the numbers
//       against the FIRST parent: files (a rename ONCE, a binary file as a file WITH its own count `binary`, never hidden as "0 lines"),
//       insertions, deletions — held against `git diff --shortstat` of the same pair; the root against the empty tree, the merge
//       against m1. The message has a cap (16 KB, at a character boundary, with `messageClipped`), even when the cap of the output
//       already applied. The route takes `info: true`, nonsense and combinations are 400.
//
// COUNTER-TESTS built in (tests "Counter-test …"): the same checks over answers from deliberately wrong versions — without `-M`,
// without `-z`, without `--root`, against the LAST instead of the first parent, with `-m`, without cap; for the diff without
// `--literal-pathspecs`, without `--` and without checking the path; for `info` without `-z`, without `-M`, without `--root`, against
// the last parent, binary files as 0 lines, `%s` instead of `%B`, without `--encoding=UTF-8`, without cap of the message and with a
// cut in the middle of a character. Each must throw; if one stays green the check measures nothing at that place.
//
// Alone:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//         CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test server/backend/test/git-commit-files.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  COMMIT_FILES_MAX, COMMIT_DIFF_MAX, COMMIT_INFO_FIELDS, COMMIT_MESSAGE_MAX, commitFileDiffArgs, commitFilesArgs, commitInfoArgs, commitPath,
  commitCountsArgs, gitShow, parseCommitInfo, parseNameStatus, parseNumstat,
} from "../electron/server/git.js";
import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";

// ── Isolation (as in git-graph-log.test.js): no foreign ~/.gitconfig ─────────────────────────────────────────────────────────────
const ISO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-commit-")));
after(() => {
  try { fs.rmSync(ISO, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (e) { console.warn(`[test] ${ISO} was left behind (${e.code || e.message}) — test unaffected.`); }
});
fs.mkdirSync(path.join(ISO, "home"));
fs.mkdirSync(path.join(ISO, "xdg"));
Object.assign(process.env, { HOME: path.join(ISO, "home"), XDG_CONFIG_HOME: path.join(ISO, "xdg"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) delete process.env[k];

const ID = ["-c", "user.name=Testerin", "-c", "user.email=t@example.com"];
let clock = 1_790_000_000;
const raw = (cwd, args, env = {}) => spawnSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
const git = (cwd, args, env = {}) => {
  const r = raw(cwd, args, env);
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout;
};
function commit(cwd, msg) {
  git(cwd, ["add", "-A"]);
  const d = `@${(clock += 60)} +0000`;
  git(cwd, [...ID, "commit", "-q", "-m", msg], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}
const write = (cwd, name, text) => { fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), text); };
const NL = "line\nbreak.txt";
const UML = "ümlaut ä/file ö.md";

// The test repo — ONE setup for all tests (it is only read):
//
//   *   M     (main)  merge of feature — against m1: feature.txt (A), a.txt (M); NOT src/lib/one.ts (m1 brought that)
//   |\
//   | * f1    (feature) feature.txt created, a.txt changed
//   * | m1    src/lib/one.ts changed
//   |/
//   * c2      a.txt changed, "b c.txt" → "ümlaut ä/file ö.md" renamed, way.txt deleted, fresh.ts created, "-x" and NL changed
//   * c1      root: a.txt, "b c.txt", way.txt, "-x", NL, src/lib/one.ts
function buildRepo() {
  const w = path.join(ISO, "proj");
  fs.mkdirSync(w);
  git(w, ["init", "-q", "-b", "main"]);
  write(w, "a.txt", "a\n");
  write(w, "b c.txt", "b\ntwo\nthree\nfour\nfive\nsix\n");
  write(w, "way.txt", "gone\n");
  write(w, "-x", "minus\n");
  write(w, NL, "break\n");
  write(w, "src/lib/one.ts", "export const one = 1;\n");
  const c1 = commit(w, "c1 root");
  fs.mkdirSync(path.join(w, path.dirname(UML)));
  git(w, ["mv", "b c.txt", UML]);
  write(w, "a.txt", "a\ntwo\n");
  fs.rmSync(path.join(w, "way.txt"));
  write(w, "fresh.ts", "export {};\n");
  write(w, "-x", "minus\ntwo\n");
  write(w, NL, "break\ntwo\n");
  const c2 = commit(w, "c2 mixture");
  git(w, ["checkout", "-q", "-b", "feature"]);
  write(w, "feature.txt", "f\n");
  write(w, "a.txt", "a\ntwo\nfeature\n");
  const f1 = commit(w, "f1 feature");
  git(w, ["checkout", "-q", "main"]);
  write(w, "src/lib/one.ts", "export const one = 11;\n");
  const m1 = commit(w, "m1 main");
  const dm = `@${(clock += 60)} +0000`;
  git(w, [...ID, "merge", "-q", "--no-ff", "-m", "M Merge feature", "feature"], { GIT_AUTHOR_DATE: dm, GIT_COMMITTER_DATE: dm });
  const M = git(w, ["rev-parse", "HEAD"]).trim();
  return { w, h: { c1, c2, f1, m1, M } };
}
const { w: REPO, h: H } = buildRepo();

// ── The checks (over the ANSWER — so the counter-tests run through them too) ────────────────────────────────────────────────────
const arrange = (l) => [...l].sort((a, b) => a.path.localeCompare(b.path));
function checkC2(a) {
  assert.equal(a.hash, H.c2);
  assert.deepEqual(a.parent, [H.c1]);
  assert.deepEqual(arrange(a.files), arrange([
    { path: "-x", old: null, status: "M" },
    { path: "a.txt", old: null, status: "M" },
    { path: "fresh.ts", old: null, status: "A" },
    { path: "way.txt", old: null, status: "D" },
    { path: NL, old: null, status: "M" },
    { path: UML, old: "b c.txt", status: "R" },
  ]), "c2: change, rename with old path, deletion, creation — names verbatim (space, umlaut, newline)");
  assert.equal(a.total, 6);
  assert.equal(a.clipped, false);
}
function checkMerge(a) {
  assert.equal(a.hash, H.M);
  assert.deepEqual(a.parent, [H.m1, H.f1], "both parents, the first first");
  assert.deepEqual(arrange(a.files), [{ path: "a.txt", old: null, status: "M" }, { path: "feature.txt", old: null, status: "A" }], "the merge against its FIRST parent: only what feature brought");
}
function checkRoot(a) {
  assert.equal(a.hash, H.c1);
  assert.deepEqual(a.parent, [], "a root has no parents");
  assert.deepEqual(arrange(a.files).map((d) => [d.path, d.status, d.old]), arrange([
    { path: "-x" }, { path: "a.txt" }, { path: "b c.txt" }, { path: NL }, { path: "src/lib/one.ts" }, { path: "way.txt" },
  ]).map((d) => [d.path, "A", null]), "the root commit creates every file (against the empty tree)");
}
// The paths a diff concerns (the header lines `diff --git a/<x> b/<y>`).
function headerPaths(diff) {
  return [...String(diff).matchAll(/^diff --git a\/(.*) b\/(.*)$/gm)].map((m) => [m[1], m[2]]);
}
function checkDiffs(run) {
  return (async () => {
    const a = await run(H.c2, { file: "a.txt" });
    assert.equal(a.path, "a.txt", "the echo of the request");
    assert.deepEqual(headerPaths(a.diff), [["a.txt", "a.txt"]], "exactly the one file");
    assert.match(a.diff, /^@@ -1 \+1,2 @@\n a\n\+two\n/m);
    assert.equal(a.clipped, false);
    const r = await run(H.c2, { file: UML, old: "b c.txt" });
    assert.deepEqual(headerPaths(r.diff), [["b c.txt", UML]], "the rename with both paths, umlaut unquoted");
    assert.match(r.diff, /^rename from b c\.txt$/m);
    const nl = await run(H.c2, { file: NL });
    assert.match(nl.diff, /^\+two$/m, "a file with a newline in its name has its diff");
    const root = await run(H.c1, { file: "a.txt" });
    assert.match(root.diff, /^new file mode 100644$/m, "in the root commit against the empty tree");
    assert.deepEqual(headerPaths(root.diff), [["a.txt", "a.txt"]]);
    const merge = await run(H.M, { file: "a.txt" });
    assert.match(merge.diff, /^ two\n\+feature$/m, "in the merge against the first parent (m1 has a.txt with two lines)");
    assert.doesNotMatch(merge.diff, /^[-+]{3} .*one\.ts/m);
    const none = await run(H.M, { file: "src/lib/one.ts" });
    assert.equal(none.diff, "", "one.ts is unchanged in the merge against the first parent");
    const way = await run(H.c2, { file: "way.txt" });
    assert.match(way.diff, /^deleted file mode/m);
    const minus = await run(H.c2, { file: "./-x" });
    assert.deepEqual(headerPaths(minus.diff), [["-x", "-x"]], "a file really named \"-x\", as \"./-x\"");
  })();
}
// The defense: `run(hash, opts)` with dangerous paths. A throw WITH the message of the check (not just any from git), no file
// written, no patterns.
const CHECK_ERROR = /Ungültiger Pfad|Invalid path/;
async function checkDefense(run) {
  const target = path.join(REPO, "x");
  const alsoCwd = path.join(process.cwd(), "x");
  const prior = fs.existsSync(alsoCwd);
  for (const p of ["--output=x", "-x", "--output", "-p"]) {
    await assert.rejects(run(H.c2, { file: p }), CHECK_ERROR, `"${p}" is no path`);
  }
  assert.ok(!fs.existsSync(target) && fs.existsSync(alsoCwd) === prior, "--output=x wrote a file");
  for (const p of ["../x", "../../etc/passwd", "/etc/passwd", "a/../../x", "src/../a.txt", ".", "./", "a//b", "./../x"]) {
    await assert.rejects(run(H.c2, { file: p }), CHECK_ERROR, `"${p}" does not (unambiguously) lie in the repo`);
  }
  // A folder entry ("src/", how `git status` shows an untracked folder) is refused too, with a message that says what it is.
  await assert.rejects(run(H.c2, { file: "src/" }), /ist ein Ordner|is a folder/, `"src/" is a folder, not a file`);
  await assert.rejects(run(H.c2, { file: "a.txt", old: "--output=x" }), CHECK_ERROR, "the old path too");
  for (const p of [":(glob)*", "*", ":!a.txt", ":/a.txt", "*.txt"]) {
    const r = await run(H.c2, { file: p });
    assert.equal(r.diff, "", `"${p}" is a file name, not a pattern (--literal-pathspecs)`);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const files = (h) => gitShow(REPO, "", h, { files: true });
test("(a) (d) the files of a commit: M, R with old path, D, A — names verbatim, also with newline", async () => {
  checkC2(await files(H.c2));
  checkC2(await files(H.c2.slice(0, 7))); // a short hash resolves to the full one
});
test("(b) merge commit: only the changes against the first parent", async () => checkMerge(await files(H.M)));
test("(c) root commit: every file created", async () => checkRoot(await files(H.c1)));

test("(e) cap: at most 1,000 files, total counts all; the output cap drops the half entry", async () => {
  // 1,005 files in one commit — fast-import, so the setup costs no seconds.
  const much = path.join(ISO, "much");
  fs.mkdirSync(much);
  git(much, ["init", "-q", "-b", "main"]);
  let stream = "commit refs/heads/main\ncommitter T <t@example.com> 1790000000 +0000\ndata 4\nmany\n";
  for (let i = 0; i < COMMIT_FILES_MAX + 5; i++) stream += `M 100644 inline d/${String(i).padStart(4, "0")}.txt\ndata 2\n${i % 10}\n`;
  const r = spawnSync("git", ["fast-import", "--quiet"], { cwd: much, input: `${stream}\n`, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const a = await gitShow(much, "", git(much, ["rev-parse", "main"]).trim(), { files: true });
  assert.equal(a.files.length, COMMIT_FILES_MAX);
  assert.equal(a.total, COMMIT_FILES_MAX + 5);
  assert.equal(a.clipped, true, "the cap says it is one");
  // The cap of the output: the last entry can be half — it drops, the number is unknown (gitCommitPart says so with null).
  const full = "M\0a.txt\0R100\0old.txt\0new.txt\0A\0half";
  assert.deepEqual(parseNameStatus(full).files.map((d) => d.path), ["a.txt", "new.txt", "half"]);
  assert.deepEqual(parseNameStatus(full, { cutOff: true }).files.map((d) => d.path), ["a.txt", "new.txt"]);
  assert.deepEqual(parseNameStatus("R100\0old.txt").files, [], "an R without a new path (cut off) is no entry");
  assert.deepEqual(parseNameStatus("X\0broken\0M\0a.txt\0").files, [{ path: "a.txt", old: null, status: "M" }], "an unknown letter skips its path");
});

test("(f) the diff of one file: exactly it, rename with both paths, root, merge against the first parent, deletion", async () => {
  await checkDiffs((h, o) => gitShow(REPO, "", h, o));
});

test("(f) diff cap: at most 2 MiB, cut at a line boundary, clipped", async () => {
  const large = path.join(ISO, "large");
  fs.mkdirSync(large);
  git(large, ["init", "-q", "-b", "main"]);
  const row = `${"x".repeat(99)}\n`;
  write(large, "large.txt", row.repeat(Math.ceil((COMMIT_DIFF_MAX * 1.5) / row.length)));
  const h = commit(large, "large");
  const a = await gitShow(large, "", h, { file: "large.txt" });
  assert.equal(a.clipped, true);
  assert.ok(Buffer.byteLength(a.diff) <= COMMIT_DIFF_MAX, `${Buffer.byteLength(a.diff)} Bytes`);
  assert.ok(Buffer.byteLength(a.diff) > COMMIT_DIFF_MAX - 200, "up to just below the cap");
  assert.ok(a.diff.endsWith(`+${row}`), "cut at a line boundary");
  const small = await gitShow(REPO, "", H.c2, { file: "a.txt" });
  assert.equal(small.clipped, false);
});

test("(g) hardening: hash, paths before the first git, patterns literal", async () => {
  await checkDefense((h, o) => gitShow(REPO, "", h, o));
  for (const h of ["HEAD", "main", "-n1", "abc", H.c2.toUpperCase(), `${H.c2}0000000000000000000000000`, `${H.c2.slice(0, 8)}^`, "", null]) {
    await assert.rejects(gitShow(REPO, "", h, { files: true }), /Ungültiger Commit-Hash|Invalid commit hash/, `Hash ${JSON.stringify(h)}`);
  }
  await assert.rejects(gitShow(REPO, "", "deadbeef00", { files: true }), /nicht gefunden|not found/);
  await assert.rejects(gitShow(REPO, "", H.c2, { files: true, file: "a.txt" }), /schließen sich aus|mutually exclusive/);
  await assert.rejects(gitShow(REPO, "", H.c2, { files: "yes" }), /files ist true|files is true/);
  await assert.rejects(gitShow(REPO, "", H.c2, { file: "" }), /file fehlt|file is missing/);
  // A branch that looks like a hash is not the commit with that start: git would take the branch — the answer does not.
  const foreign = H.c2.slice(0, 7);
  git(REPO, ["branch", "-q", foreign, H.c1]);
  try { await assert.rejects(gitShow(REPO, "", foreign, { files: true }), /nicht gefunden|not found/, "the branch \"<base-16>\" shadows the commit"); }
  finally { git(REPO, ["branch", "-q", "-D", foreign]); }
  // The check alone (pure).
  assert.equal(commitPath("./-x"), "./-x");
  assert.equal(commitPath("a b/c\nd.txt"), "a b/c\nd.txt", "space and newline stand behind `--`, they are allowed");
  assert.throws(() => commitPath("a\0b"), /fehlt|missing/);
  assert.throws(() => commitPath(7), /fehlt|missing/);
  // An untracked folder / embedded repository arrives as "x/" from `git status`: a message that says so, not "invalid path".
  assert.throws(() => commitPath("reader-agent/"), /ist ein Ordner|is a folder/);
  assert.throws(() => commitPath("a/b/"), /ist ein Ordner|is a folder/);
  assert.throws(() => commitPath("a//"), CHECK_ERROR, "an empty segment before the slash stays invalid");
  assert.throws(() => commitPath("/"), CHECK_ERROR);
  assert.throws(() => commitPath("./"), CHECK_ERROR, "the repo root itself is not a folder entry");
  assert.throws(() => commitPath("../x/"), CHECK_ERROR);
  assert.throws(() => commitPath("x".repeat(4097)), /fehlt|missing/);
});

test("(h) the route: files and file go through, nonsense is 400, without both the old form", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    git(projPath, ["init", "-q", "-b", "main"]);
    write(projPath, "a.txt", "1\n2\n3\n4\n5\n");
    commit(projPath, "one");
    write(projPath, "a.txt", "1\n2\n3\n4\n5\nb\n");
    git(projPath, ["mv", "a.txt", "b.txt"]);
    write(projPath, "c.txt", "c\n");
    const two = commit(projPath, "two");
    const ws = await makeWorkspace(base, "G", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const show = (body) => json(`${base}/api/projects/${proj.id}/git/show`, { method: "POST", body: JSON.stringify({ repo: "", hash: two, ...body }) });
    const d = await show({ files: true });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(Object.keys(d.body).sort(), ["clipped", "files", "hash", "parent", "total"]);
    assert.deepEqual(arrange(d.body.files), [{ path: "b.txt", old: "a.txt", status: "R" }, { path: "c.txt", old: null, status: "A" }]);
    const f = await show({ file: "b.txt", old: "a.txt" });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.path, "b.txt");
    assert.deepEqual(headerPaths(f.body.diff), [["a.txt", "b.txt"]]);
    assert.match(f.body.diff, /^\+b$/m);
    for (const [body, pattern] of [
      [{ file: "--output=x" }, CHECK_ERROR], [{ file: "../x" }, CHECK_ERROR], [{ files: true, file: "b.txt" }, /schließen sich aus|mutually exclusive/],
      [{ files: 1 }, /files ist true|files is true/], [{ hash: "HEAD", files: true }, /Ungültiger Commit-Hash|Invalid commit hash/],
    ]) {
      const r = await show(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, pattern);
    }
    assert.ok(!fs.existsSync(path.join(projPath, "x")), "the route wrote nothing");
    const old = await show({});
    assert.equal(old.status, 200);
    assert.deepEqual(Object.keys(old.body), ["hash", "diff"], "without options the answer of today");
    assert.match(old.body.diff, /^ 3 files changed|^ 2 files changed/m);
  });
});

// ── Counter-tests: the checks over answers of wrong versions ──────────────────────────────────────────────────────────────────
// The same computation as gitCommitPart (argv → git → parseNameStatus/cap), with ONE place twisted each.
const parentOf = (h) => git(REPO, ["rev-list", "--parents", "-n", "1", h]).trim().split(" ").slice(1);
function filesRevision(h, argv = (e1, full) => commitFilesArgs(e1, full), { max = COMMIT_FILES_MAX, parse = parseNameStatus } = {}) {
  const parent = parentOf(h);
  const out = git(REPO, argv(parent[0] || null, h, parent));
  const { files: d, total } = parse(out, { max });
  return { hash: h, parent, files: d, total, clipped: total > d.length };
}
// Without -z: the line form `M\tpath` (paths quoted) — read over lines with the same parser.
const rowsParse = (out) => {
  const d = out.split("\n").filter(Boolean).map((z) => { const t = z.split("\t"); return t.length === 3 ? { path: t[2], old: t[1], status: t[0][0] } : { path: t[1], old: null, status: t[0][0] }; });
  return { files: d, total: d.length };
};
test("counter-test files: every wrong version turns the check red", () => {
  const real = commitFilesArgs("e", "h");
  assert.ok(["-r", "-M", "--name-status", "-z", "--no-ext-diff", "--no-textconv"].every((x) => real.includes(x)), `argv of the files: ${real.join(" ")}`);
  assert.ok(commitFilesArgs(null, "h").includes("--root"));
  // The real version over the same way is green — otherwise the counter-test measures the way, not the place.
  checkC2(filesRevision(H.c2));
  checkMerge(filesRevision(H.M));
  checkRoot(filesRevision(H.c1));
  const without = (x) => (e1, full) => commitFilesArgs(e1, full).filter((a) => a !== x);
  const fake = {
    "without -M (the rename as delete + create)": () => checkC2(filesRevision(H.c2, without("-M"))),
    "without -z (names quoted)": () => checkC2(filesRevision(H.c2, without("-z"), { parse: rowsParse })),
    "without --root (the root without files)": () => checkRoot(filesRevision(H.c1, without("--root"))),
    "against the last parent": () => checkMerge(filesRevision(H.M, (e1, full, parent) => commitFilesArgs(parent.at(-1), full))),
    "with -m against every parent": () => checkMerge(filesRevision(H.M, (e1, full) => ["diff-tree", "-r", "-m", "-M", "--no-commit-id", "--name-status", "-z", full])),
    "without -r (folders instead of files)": () => checkC2(filesRevision(H.c2, without("-r"))),
  };
  for (const [name, fn] of Object.entries(fake)) assert.throws(fn, `version "${name}" stays green — the check does not measure this place`);
  // Without cap: all 1,005 files would come — the check from (e) in small: max 2 over c2.
  const capped = filesRevision(H.c2, undefined, { max: 2 });
  assert.equal(capped.clipped, true);
  assert.throws(() => assert.equal(filesRevision(H.c2, undefined, { max: Infinity }).clipped, true), "without cap \"clipped\" stays green");
});

// An unhardened version of the diff: `without` takes places out of the argv, `withoutCheck` leaves out commitPath.
function diffRevision({ without = [], withoutCheck = false } = {}) {
  return async (h, { file, old = null }) => {
    if (!withoutCheck) { commitPath(file); if (old) commitPath(old, "old"); }
    const parent1 = parentOf(h)[0] || null;
    const argv = commitFileDiffArgs(parent1, h, file, old).filter((a) => !without.includes(a));
    const r = raw(REPO, argv);
    if (r.status !== 0) throw new Error(`git: ${r.stderr.trim()}`);
    return { hash: h, path: file, old, diff: r.stdout, clipped: false };
  };
}
test("counter-test diff: without --literal-pathspecs, without -- or without checking the path the defense turns red", async () => {
  const real = commitFileDiffArgs("e", "h", "p");
  assert.deepEqual(real.slice(real.indexOf("--")), ["--", "p"], "the path stands last, behind --");
  assert.ok(["--literal-pathspecs", "--no-ext-diff", "--no-textconv"].every((x) => real.includes(x)) && !real.some((a) => a.startsWith("--output")), `argv des Diffs: ${real.join(" ")}`);
  await checkDiffs(diffRevision());
  await checkDefense(diffRevision());
  const fake = {
    "without --literal-pathspecs (`:(glob)*` is a pattern)": diffRevision({ without: ["--literal-pathspecs"] }),
    "without -- and without check (`--output=x` writes a file)": diffRevision({ without: ["--"], withoutCheck: true }),
    "without check (`-x`, `../x` reach git)": diffRevision({ withoutCheck: true }),
  };
  for (const [name, run] of Object.entries(fake)) {
    await assert.rejects(checkDefense(run), `version "${name}" stays green — the defense does not measure this place`);
  }
  for (const x of [path.join(REPO, "x"), path.join(process.cwd(), "x")]) fs.rmSync(x, { force: true }); // what the version without -- wrote
  // Without the rename (only the new path) git shows a creation — the diff check sees it.
  await assert.rejects(checkDiffs(async (h, o) => diffRevision()(h, { file: o.file })), "without the old path the rename stays green");
  // Against the empty tree without --root: the root commit would have no diff.
  await assert.rejects(checkDiffs(diffRevision({ without: ["--root"] })), "without --root the diff of the root stays green");
});

// ── (i) The hovered commit: `info: true` ──────────────────────────────────────────────────────────────────────────────────────
// A repo of its own (the upper one stays as it is — checks (a)–(h) count its files):
//
//   *   M     (main)  merge of feature, message with body — against m1: f.txt, g.txt (A, +1 each); against f1 it would be a.txt (+2)
//   |\
//   | * f1    (feature) f.txt and g.txt created
//   * | m1    a.txt: two lines added
//   |/
//   * i2      author "Jörg Müller", message with body and umlauts, AUTHOR time ≠ commit time: a.txt (+3 −1), image.png (binary),
//   |         fresh.ts (+2), r.txt → "umbenannt ä.txt" (+1) — 4 files, 6 insertions, 1 deletion, 1 of them binary
//   * i1      root: a.txt (3), image.png (binary), r.txt (6) — 3 files, 9 insertions, 1 of them binary
//   (branch long:) l1 with a 20 KB message (cut in the middle of an "ä"), l2 with 200 KB (above the output cap)
// The repo sets `i18n.logOutputEncoding` to Latin-1: without `--encoding=UTF-8` name and message would arrive as Latin-1 bytes.
const JOERG = ["Jörg Müller", "joerg@example.com"];
const LEA = ["Lea Berg", "lea@example.com"];
const MESSAGE_I2 = "Größe prüfen: ä ö ü ß\n\nErster Absatz mit Umlauten: Übermaß, Öl.\nZweite Zeile desselben Absatzes.\n\n- Punkt eins\n- Punkt zwei";
const MESSAGE_M = "Merge branch 'feature'\n\nMerge with body\nsecond line";
const LANG1 = `Lang\n\nx${"ä".repeat(10_000)}`; // 7 + 20,000 bytes: the cut at 16,384 would fall in the middle of an "ä"
const LANG2 = `Riesig\n\n${"ö".repeat(100_000)}`; // 200 KB: more than the output cap (16 KB + 64 KB)
const PNG = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, n, 0, 255]);
let TIME_I2 = 0;
function commitAs(cwd, msg, [name, mail], offset = 0) {
  git(cwd, ["add", "-A"]);
  const a = (clock += 60);
  const file = path.join(ISO, `nachricht-${a}.txt`);
  fs.writeFileSync(file, msg);
  git(cwd, ["-c", `user.name=${name}`, "-c", `user.email=${mail}`, "commit", "-q", "-F", file], { GIT_AUTHOR_DATE: `@${a} +0000`, GIT_COMMITTER_DATE: `@${a + offset} +0000` });
  return { h: git(cwd, ["rev-parse", "HEAD"]).trim(), a };
}
function buildInfoRepo() {
  const w = path.join(ISO, "info");
  fs.mkdirSync(w);
  git(w, ["init", "-q", "-b", "main"]);
  write(w, "a.txt", "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(w, "image.png"), PNG(1));
  write(w, "r.txt", "1\n2\n3\n4\n5\n6\n");
  const i1 = commitAs(w, "Root: groundwork", JOERG).h;
  write(w, "a.txt", "one\nTWO\nthree\nfour\nfive\n");
  fs.writeFileSync(path.join(w, "image.png"), PNG(2));
  write(w, "fresh.ts", "export const a = 1;\nexport const b = 2;\n");
  git(w, ["mv", "r.txt", "umbenannt ä.txt"]);
  write(w, "umbenannt ä.txt", "1\n2\n3\n4\n5\n6\n7\n");
  const c2 = commitAs(w, `${MESSAGE_I2}\n`, JOERG, 500);
  TIME_I2 = c2.a;
  git(w, ["checkout", "-q", "-b", "feature"]);
  write(w, "f.txt", "f\n");
  write(w, "g.txt", "g\n");
  const f1 = commitAs(w, "f1 feature", LEA).h;
  git(w, ["checkout", "-q", "main"]);
  write(w, "a.txt", "one\nTWO\nthree\nfour\nfive\nsix\nseven\n");
  const m1 = commitAs(w, "m1 main", LEA).h;
  const dm = `@${(clock += 60)} +0000`;
  git(w, [...ID, "merge", "-q", "--no-ff", "-m", MESSAGE_M, "feature"], { GIT_AUTHOR_DATE: dm, GIT_COMMITTER_DATE: dm });
  const M = git(w, ["rev-parse", "HEAD"]).trim();
  git(w, ["checkout", "-q", "-b", "lang"]);
  write(w, "l.txt", "l\n");
  const l1 = commitAs(w, LANG1, JOERG).h;
  write(w, "l.txt", "l\n2\n");
  const l2 = commitAs(w, LANG2, JOERG).h;
  git(w, ["checkout", "-q", "main"]);
  git(w, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
  return { w, h: { i1, i2: c2.h, f1, m1, M, l1, l2 } };
}
const { w: INFO, h: HI } = buildInfoRepo();

// The oracle: git itself. `diff --shortstat` (a binary file counts there as a file without lines) and `--numstat` for the binary files.
function oracleCounts(from, h) {
  const paar = from ? [from, h] : ["--root", h];
  const short = git(INFO, from ? ["diff", "--shortstat", ...paar] : ["show", "--shortstat", "--format=", h]);
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(short);
  assert.ok(m, `git --shortstat: ${JSON.stringify(short)}`);
  const numstat = git(INFO, ["diff-tree", "-r", "-M", "--no-commit-id", "--numstat", ...paar]);
  const binary = numstat.split("\n").filter((z) => z.startsWith("-\t-\t")).length;
  return { files: Number(m[1]), plus: Number(m[2] || 0), minus: Number(m[3] || 0), binary };
}
const countsOf = (a) => ({ files: a.files, plus: a.plus, minus: a.minus, binary: a.binary });
function checkInfoI2(a) {
  assert.equal(a.hash, HI.i2);
  assert.deepEqual(a.parent, [HI.i1]);
  assert.equal(a.author, "Jörg Müller", "the name with umlaut, as UTF-8");
  assert.equal(a.email, "joerg@example.com");
  assert.equal(a.time, TIME_I2 * 1000, "the AUTHOR time in ms (the commit time is 500 s later)");
  assert.equal(a.message, MESSAGE_I2, "the whole message: subject, body, line breaks, umlauts — without the trailing newline");
  assert.equal(a.messageClipped, false);
  assert.deepEqual(countsOf(a), { files: 4, plus: 6, minus: 1, binary: 1 }, "rename once, the binary file as a file with its own count");
  assert.deepEqual(countsOf(a), oracleCounts(HI.i1, HI.i2), "the same numbers as git --shortstat");
  assert.equal(a.countsClipped, false);
}
function checkInfoRoot(a) {
  assert.deepEqual(a.parent, [], "the root has no parents");
  assert.equal(a.message, "Root: groundwork");
  assert.deepEqual(countsOf(a), { files: 3, plus: 9, minus: 0, binary: 1 }, "the root against the empty tree");
  assert.deepEqual(countsOf(a), oracleCounts(null, HI.i1));
}
function checkInfoMerge(a) {
  assert.deepEqual(a.parent, [HI.m1, HI.f1]);
  assert.equal(a.message, MESSAGE_M);
  assert.deepEqual(countsOf(a), { files: 2, plus: 2, minus: 0, binary: 0 }, "the merge against its FIRST parent: what feature brought");
  assert.deepEqual(countsOf(a), oracleCounts(HI.m1, HI.M));
}
function checkInfoLang(a, full) {
  const bytes = Buffer.byteLength(a.message);
  assert.equal(a.messageClipped, true, "the cap says it is one");
  assert.ok(bytes <= COMMIT_MESSAGE_MAX && bytes > COMMIT_MESSAGE_MAX - 4, `${bytes} bytes — up to the cap, not above`);
  assert.ok(!a.message.includes("�"), "never cut in the middle of a character");
  assert.ok(full.startsWith(a.message), "the start of the message, unchanged");
}

const info = (repo, h) => gitShow(repo, "", h, { info: true });
test("(i) info: author with umlaut, author time, whole message, counts with rename and binary file — against git --shortstat", async () => {
  checkInfoI2(await info(INFO, HI.i2));
  checkInfoI2(await info(INFO, HI.i2.slice(0, 9))); // a short hash resolves to the full one
});
test("(i) info: the root against the empty tree, the merge against the first parent", async () => {
  checkInfoRoot(await info(INFO, HI.i1));
  checkInfoMerge(await info(INFO, HI.M));
  const f1 = await info(INFO, HI.f1);
  assert.equal(f1.author, "Lea Berg");
  assert.deepEqual(countsOf(f1), { files: 2, plus: 2, minus: 0, binary: 0 });
});
test("(i) info: the message cap at a character boundary, also above the output cap", async () => {
  checkInfoLang(await info(INFO, HI.l1), LANG1);
  const l2 = await info(INFO, HI.l2);
  checkInfoLang(l2, LANG2);
  assert.deepEqual(countsOf(l2), { files: 1, plus: 1, minus: 0, binary: 0 }, "the counts arrive despite the clipped message");
  // The computations alone (pure).
  assert.deepEqual(parseNumstat(""), { files: 0, plus: 0, minus: 0, binary: 0 }, "empty is an answer: no files");
  assert.deepEqual(parseNumstat("1\t2\ta b\tc\0-\t-\timage.png\u00003\t0\t\0old\0new\0"), { files: 3, plus: 4, minus: 2, binary: 1 }, "a tab in the path, binary, rename");
  assert.equal(parseNumstat("3\t0\t\0alt"), null, "a rename without a new path (cut off): unknown, not half counted");
  assert.equal(parseNumstat("1 2 a.txt\n"), null, "a foreign form: unknown");
  assert.throws(() => parseCommitInfo("Name\0mail\0"), /keinen Kopf|no header/);
  const p = parseCommitInfo("A\0a@b\0x\0Subject\n\nBody\n\n\n");
  assert.deepEqual([p.time, p.message, p.messageClipped], [null, "Subject\n\nBody", false], "an unreadable time is null, not 1970");
  assert.equal(parseCommitInfo("A\0a@b\u00001\0short", { cutOff: true }).messageClipped, true, "cut off is clipped, even when short");
});
test("(i) info: hardening and exclusion as with files/file", async () => {
  for (const h of ["HEAD", "main", "-n1", HI.i2.toUpperCase(), ""]) {
    await assert.rejects(gitShow(INFO, "", h, { info: true }), /Ungültiger Commit-Hash|Invalid commit hash/, `Hash ${JSON.stringify(h)}`);
  }
  await assert.rejects(gitShow(INFO, "", HI.i2, { info: "yes" }), /info ist true|info is true/);
  await assert.rejects(gitShow(INFO, "", HI.i2, { info: true, files: true }), /schließen sich aus|mutually exclusive/);
  await assert.rejects(gitShow(INFO, "", HI.i2, { info: true, file: "a.txt" }), /schließen sich aus|mutually exclusive/);
  const real = commitInfoArgs("h");
  assert.deepEqual(real.slice(-2), ["h", "--"], "the hash last, behind --");
  assert.ok(["-1", "--no-show-signature", "--encoding=UTF-8"].every((x) => real.includes(x)) && real.some((x) => /^--format=.*%B$/.test(x)), `argv of the head: ${real.join(" ")}`);
  const z = commitCountsArgs("e", "h");
  assert.ok(["-r", "-M", "--numstat", "-z", "--no-ext-diff", "--no-textconv"].every((x) => z.includes(x)), `argv of the counts: ${z.join(" ")}`);
  assert.ok(commitCountsArgs(null, "h").includes("--root"));
});

// Counter-tests: the same computation as commitInfo (argv → git → parse), with ONE place twisted each. Read like in the server as
// UTF-8 — an output in Latin-1 becomes unreadable.
function infoRevision(h, { header = commitInfoArgs, counts = (e1, full) => commitCountsArgs(e1, full), parseHeader = parseCommitInfo, parseCounts = parseNumstat, parent = (e) => e[0] || null } = {}) {
  const e = git(INFO, ["rev-list", "--parents", "-n", "1", h]).trim().split(" ").slice(1);
  return { hash: h, parent: e, ...parseHeader(git(INFO, header(h))), ...parseCounts(git(INFO, counts(parent(e), h))), countsClipped: false };
}
test("counter-test info: every wrong version turns the check red", () => {
  checkInfoI2(infoRevision(HI.i2));
  checkInfoRoot(infoRevision(HI.i1));
  checkInfoMerge(infoRevision(HI.M));
  checkInfoLang(infoRevision(HI.l1), LANG1);
  const without = (x) => (e1, full) => commitCountsArgs(e1, full).filter((a) => a !== x);
  const headerWithout = (x) => (h) => commitInfoArgs(h).filter((a) => a !== x);
  const fake = {
    "counts without -z (paths quoted, one line per file)": () => checkInfoI2(infoRevision(HI.i2, { counts: without("-z") })),
    "counts without -M (the rename as delete + create)": () => checkInfoI2(infoRevision(HI.i2, { counts: without("-M") })),
    "counts without --root (the root without files)": () => checkInfoRoot(infoRevision(HI.i1, { counts: without("--root") })),
    "counts against the last parent": () => checkInfoMerge(infoRevision(HI.M, { parent: (e) => e.at(-1) || null })),
    "binary file as 0 lines, not counted": () => checkInfoI2(infoRevision(HI.i2, {
      parseCounts: (out) => ({ ...parseNumstat(out.replaceAll("-\t-\t", "0\t0\t")), binary: 0 }),
    })),
    "%s instead of %B (only the subject)": () => checkInfoI2(infoRevision(HI.i2, { header: (h) => commitInfoArgs(h).map((a) => a.replace("%B", "%s")) })),
    "without --encoding=UTF-8 (the repo outputs Latin-1)": () => checkInfoI2(infoRevision(HI.i2, { header: headerWithout("--encoding=UTF-8") })),
    "message without cap": () => checkInfoLang(infoRevision(HI.l1, { parseHeader: (out) => parseCommitInfo(out, { max: Infinity }) }), LANG1),
    "cap in the middle of a character": () => checkInfoLang(infoRevision(HI.l1, {
      parseHeader: (out) => {
        const r = parseCommitInfo(out, { max: Infinity });
        return { ...r, message: Buffer.from(r.message).subarray(0, COMMIT_MESSAGE_MAX).toString("utf8"), messageClipped: true };
      },
    }), LANG1),
  };
  for (const [name, fn] of Object.entries(fake)) assert.throws(fn, `version "${name}" stays green — the check does not measure this place`);
});

test("(i) the route: info: true goes through, nonsense and combinations are 400", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    git(projPath, ["init", "-q", "-b", "main"]);
    write(projPath, "a.txt", "1\n2\n");
    fs.writeFileSync(path.join(projPath, "b.png"), PNG(7));
    const one = commitAs(projPath, "Heading with umlaut\n\nBody\nsecond line\n", JOERG).h;
    const ws = await makeWorkspace(base, "I", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const show = (body) => json(`${base}/api/projects/${proj.id}/git/show`, { method: "POST", body: JSON.stringify({ repo: "", hash: one, ...body }) });
    const r = await show({ info: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Exactly the fields of the ONE list in git.js, in their order — web/test/git-card.test.mjs holds the web side (normGitCommitInfo) to it.
    assert.deepEqual(Object.keys(r.body), COMMIT_INFO_FIELDS);
    assert.deepEqual([...COMMIT_INFO_FIELDS].sort(), ["author", "binary", "countsClipped", "email", "files", "hash", "message", "messageClipped", "minus", "parent", "plus", "time"]);
    assert.deepEqual([r.body.hash, r.body.author, r.body.message], [one, "Jörg Müller", "Heading with umlaut\n\nBody\nsecond line"]);
    assert.deepEqual([r.body.files, r.body.plus, r.body.minus, r.body.binary], [2, 2, 0, 1]);
    for (const [body, pattern] of [
      [{ info: 1 }, /info ist true|info is true/], [{ info: true, files: true }, /schließen sich aus|mutually exclusive/],
      [{ info: true, file: "a.txt" }, /schließen sich aus|mutually exclusive/], [{ hash: "HEAD", info: true }, /Ungültiger Commit-Hash|Invalid commit hash/],
    ]) {
      const f = await show(body);
      assert.equal(f.status, 400, JSON.stringify(body));
      assert.match(f.body.error, pattern);
    }
    const old = await show({});
    assert.deepEqual(Object.keys(old.body), ["hash", "diff"], "without options the answer of today");
  });
});
