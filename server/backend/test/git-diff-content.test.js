// The diff tab of the code tabs in the chat: the options `content` of `POST …/git/diff` and `POST …/git/show` (with `file`) and
// `workingTree` of `POST …/git/apply` (electron/server/git.js "Content of both sides", gitApply). Measured on REAL repos in a temp folder.
//
// What hangs here and why it is a guard:
//   (a) Unstaged: prior is the INDEX (not HEAD — a partly staged file would otherwise show staged content as a change, and a hunk the
//       tab wants to stage would not fit), after says "workingTree" (the tab reads that via files/read, the same way as its saving).
//   (b) Staged: prior HEAD, after the index; a repo without a commit has NO prior ("missing", never an empty text).
//   (c) Untracked: prior missing, the diff against /dev/null with the path WITHOUT "./" — a hunk of it can be staged (with "b/./-x"
//       `git apply` would reject it).
//   (d) Conflict: prior is stage 2 (our side), said with `stage: 2`.
//   (e) The kinds of a side: binary (NUL), too large (above CONTENT_MAX), submodule (gitlink), link (text with `reference`).
//   (f) A commit: prior at the FIRST parent (under the old path of a rename), after in the commit; root without prior, deletion
//       without after.
//   (g) Hardening: `content`/`workingTree` only `true`; `content` at /git/show only with `file`; a path with "-", "..", absolute is an
//       error BEFORE the first git; "*" and ":(glob)x" are file names, not patterns.
//   (h) The diff is hardened: `diff.noprefix`, `diff.external` and a textconv of the configuration do not change it — a hunk of it can
//       be applied; also `diff.context=0` (without `-U3` the hunks would have no context, `git apply` would reject them).
//   (i) Discard a hunk: `workingTree` takes back EXACTLY the one hunk in the working tree, the index stays; without the option
//       unchanged against the index.
//   (j) The route: the options go through (200), nonsense is 400, without them the answer of today.
//   (k) `git stash show` is hardened like the other diffs: `diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`/`diff.dstPrefix`
//       and `color.ui=always` do not change the stash diff, a hunk of it can be applied — on every git: 2.54 drops the value of
//       `--src-prefix`/`--dst-prefix` in `stash show`, so git.js pins the prefixes through `-c`. Counter-test in the test itself: the
//       unhardened call is red. `diff.external`/textconv `stash show` survives on
//       git 2.50 by itself (measured) — the switches stay anyway, for other git versions; without them this check would stay green on
//       2.50, so the counter-test carries only prefixes and color.
//   (l) A conflict WITHOUT our side: "deleted by us" (DU, stages 1+3) and "added by them" (UA, only stage 3) are conflicts —
//       `conflict: true` (also staged), no diff against /dev/null (the tab showed "new file (untracked)", and staging a hunk silently
//       resolved the conflict); the status names all seven pairs "conflict".
//   (m) The status reads paths RAW: umlauts, spaces, quotes, backslash, " -> " in the name and a rename onto it — otherwise "ü.txt"
//       arrived as `"\303\274.txt"` and the diff tab found neither side.
//
// COUNTER-TESTS built in (test "Counter-test …"): the same checks over diffs from wrong versions of the argv — without the prefixes,
// without --no-ext-diff, without --no-textconv, without --literal-pathspecs — and over a version that reads prior from HEAD instead of
// the index. Each must throw; if one stays green the check measures nothing at that place.
// Sabotage on git.js for (l), (m) and -U3: status without -z ⇒ (l)(m) red · isConflict only with stage 2 (the old rule) ⇒ (l) red ·
// WITHOUT_PROGRAM without -U3 ⇒ (h)(k) and the counter-test red · classify without the seven pairs ⇒ (l) red.
//
// Alone:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//         CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test server/backend/test/git-diff-content.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  CONTENT_KINDS, CONTENT_MAX, classify, diffContentArgs, diffContentNewArgs, gitApply, gitDiff, gitShow, gitStashShow, contentTreeArgs, contentIndexArgs,
  isConflict, parseLsFiles, parseLsTree, parseStatusZ, readGitTree,
} from "../electron/server/git.js";
import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";

// ── Isolation (as in git-commit-files.test.js): no foreign ~/.gitconfig ──────────────────────────────────────────────────────────
const ISO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-content-")));
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
const raw = (cwd, args, input) => spawnSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const git = (cwd, args, input) => {
  const r = raw(cwd, args, input);
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout;
};
function commit(cwd, msg) {
  git(cwd, ["add", "-A"]);
  const d = `@${(clock += 60)} +0000`;
  const r = spawnSync("git", [...ID, "commit", "-q", "-m", msg], { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
  assert.equal(r.status, 0, r.stderr);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}
const write = (cwd, name, text) => { fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), text); };
const read = (cwd, name) => fs.readFileSync(path.join(cwd, name), "utf8");
let seq = 0;
function repo() {
  const w = path.join(ISO, `r${++seq}`);
  fs.mkdirSync(w);
  git(w, ["init", "-q", "-b", "main"]);
  return w;
}
const TWELVE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const twoChanges = (t) => t.replace("line 2\n", "line TWO\n").replace("line 11\n", "line ELEVEN\n");
// The patch of a hunk — as the diff tab builds it (web/src/lib/diff-tab.ts hunkPatch: head + hunk + line end).
function blocks(diff) {
  const rows = diff.split("\n");
  const at = rows.findIndex((l) => l.startsWith("@@"));
  const header = rows.slice(0, at).join("\n");
  const out = [];
  for (const l of rows.slice(at)) { if (l.startsWith("@@")) out.push([l]); else if (out.length) out.at(-1).push(l); }
  return out.map((b) => `${header}\n${b.join("\n").replace(/\n$/, "")}\n`);
}

// ── The checks over the ANSWER (so the counter-tests run through them too) ──────────────────────────────────────────────────────
function checkUnstaged(w, a) {
  assert.equal(a.path, "a.txt");
  assert.equal(a.staged, false);
  assert.deepEqual(a.after, { kind: "workingTree" }, "the tab reads the working tree itself (files/read)");
  assert.deepEqual(a.prior, { kind: "text", text: git(w, ["show", ":0:a.txt"]) }, "prior is the INDEX");
  assert.match(a.diff, /^diff --git a\/a\.txt b\/a\.txt$/m, "prefixes a/ b/");
  assert.equal(blocks(a.diff).length, 2, "two hunks");
  assert.match(a.diff, /^ line 1$/m, "three lines of context (diff.context=0 of the configuration does not apply)");
  assert.doesNotMatch(a.diff, /GROSS|LINE 1\b/, "no textconv");
  assert.doesNotMatch(a.diff, /EXTERN/, "no external diff program");
  assert.equal(a.clipped, false);
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(a) unstaged: prior = index (not HEAD), after = working tree, two hunks", async () => {
  const w = repo();
  write(w, "a.txt", TWELVE);
  commit(w, "one");
  write(w, "a.txt", TWELVE.replace("line 6\n", "line SIX\n"));
  git(w, ["add", "a.txt"]); // the index carries a change that HEAD does not have
  write(w, "a.txt", twoChanges(TWELVE.replace("line 6\n", "line SIX\n")));
  const a = await gitDiff(w, "", "a.txt", { content: true });
  assert.deepEqual(Object.keys(a), ["path", "staged", "diff", "clipped", "prior", "after"]);
  checkUnstaged(w, a);
  assert.match(a.prior.text, /line SIX/, "the index, not HEAD");
});

test("(b) staged: prior = HEAD, after = index; without a commit no prior", async () => {
  const w = repo();
  write(w, "a.txt", TWELVE);
  commit(w, "one");
  write(w, "a.txt", twoChanges(TWELVE));
  git(w, ["add", "a.txt"]);
  write(w, "a.txt", "otherwise\n"); // the working tree plays no role
  const a = await gitDiff(w, "", "a.txt", { staged: true, content: true });
  assert.equal(a.staged, true);
  assert.deepEqual(a.prior, { kind: "text", text: TWELVE });
  assert.deepEqual(a.after, { kind: "text", text: twoChanges(TWELVE) });
  assert.equal(blocks(a.diff).length, 2);
  const empty = repo();
  write(empty, "n.txt", "neu\n");
  git(empty, ["add", "n.txt"]);
  const b = await gitDiff(empty, "", "n.txt", { staged: true, content: true });
  assert.deepEqual(b.prior, { kind: "missing" }, "no commit: prior is missing (never an empty text)");
  assert.deepEqual(b.after, { kind: "text", text: "neu\n" });
});

test("(c) untracked: prior missing, diff against /dev/null, a hunk can be staged — also for \"-x\"", async () => {
  const w = repo();
  write(w, "a.txt", "a\n");
  commit(w, "one");
  write(w, "-x", "minus\ntwo\n");
  const a = await gitDiff(w, "", "./-x", { content: true });
  assert.deepEqual(a.prior, { kind: "missing" });
  assert.match(a.diff, /^--- \/dev\/null$/m);
  assert.match(a.diff, /^\+\+\+ b\/-x$/m, "the path without \"./\" in the head");
  await gitApply(w, "", blocks(a.diff)[0]);
  assert.equal(git(w, ["show", ":0:-x"]), "minus\ntwo\n", "the hunk is in the index");
});

test("(d) conflict: prior is our side (stage 2)", async () => {
  const w = repo();
  write(w, "k.txt", "base\n");
  commit(w, "base");
  git(w, ["checkout", "-q", "-b", "page"]);
  write(w, "k.txt", "side\n");
  commit(w, "page");
  git(w, ["checkout", "-q", "main"]);
  write(w, "k.txt", "main\n");
  commit(w, "main");
  assert.notEqual(raw(w, [...ID, "merge", "-q", "page"]).status, 0, "the merge ends in a conflict");
  const a = await gitDiff(w, "", "k.txt", { content: true });
  assert.deepEqual(a.prior, { kind: "text", text: "main\n", stage: 2 });
  assert.equal(a.conflict, true, "the conflict is said");
  assert.match(a.diff, /^diff --cc k\.txt$/m, "the diff of a conflict is combined (the tab offers no hunks there)");
});

// (l) A conflict without our side: DU via a real merge, UA and AU via the index itself (`update-index --index-info`).
test("(l) conflict without our side (DU, UA): conflict said, no diff against /dev/null, staged likewise; the status says conflict", async () => {
  const w = repo();
  write(w, "k.txt", "a\nb\nc\n");
  commit(w, "base");
  git(w, ["checkout", "-q", "-b", "page"]);
  write(w, "k.txt", "a\nPAGE\nc\n");
  commit(w, "page");
  git(w, ["checkout", "-q", "main"]);
  git(w, ["rm", "-q", "k.txt"]);
  commit(w, "way");
  assert.notEqual(raw(w, [...ID, "merge", "-q", "page"]).status, 0, "the merge ends in a conflict");
  assert.equal(git(w, ["status", "--porcelain"]), "DU k.txt\n");
  const du = await gitDiff(w, "", "k.txt", { content: true });
  assert.equal(du.conflict, true, "DU is a conflict");
  assert.deepEqual(du.prior, { kind: "missing" }, "our side does not have the file");
  assert.doesNotMatch(du.diff, /^--- \/dev\/null$/m, "no diff against /dev/null (the tab would take the file for untracked)");
  const dus = await gitDiff(w, "", "k.txt", { staged: true, content: true });
  assert.equal(dus.conflict, true, "staged likewise");
  // UA (only stage 3) and AU (only stage 2), built in the index.
  const oid = git(w, ["hash-object", "-w", "--stdin"], "theirs\n").trim();
  git(w, ["update-index", "--index-info"], `100644 ${oid} 3\tua.txt\n100644 ${oid} 2\tau.txt\n`);
  write(w, "ua.txt", "theirs\n");
  write(w, "au.txt", "theirs\n");
  const st = parseStatusZ(git(w, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  assert.deepEqual(st.map((e) => `${e.x}${e.y} ${e.path}`).sort(), ["AU au.txt", "DU k.txt", "UA ua.txt"]);
  const ua = await gitDiff(w, "", "ua.txt", { content: true });
  assert.deepEqual([ua.conflict, ua.prior.kind], [true, "missing"], "UA is a conflict, our side is missing");
  assert.doesNotMatch(ua.diff, /^--- \/dev\/null$/m);
  const au = await gitDiff(w, "", "au.txt", { content: true });
  assert.deepEqual([au.conflict, au.prior], [true, { kind: "text", text: "theirs\n", stage: 2 }], "AU: our side is stage 2");
  // The status of the git view: all seven pairs are "conflict" — none of them "new", "added" or "deleted".
  for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) assert.equal(classify(xy[0], xy[1]).kind, "conflict", xy);
  assert.equal(classify("A", " ").kind, "added");
  assert.equal(classify("D", " ").kind, "deleted");
  const tree = await readGitTree(w);
  assert.deepEqual(tree.repos[0].changes.map((c) => [c.path, c.kind]).sort(), [["au.txt", "conflict"], ["k.txt", "conflict"], ["ua.txt", "conflict"]]);
  // The rule itself: stage 0 never means conflict, each of the stages 1–3 without 0 does.
  assert.equal(isConflict([{ stage: 0 }]), false);
  assert.equal(isConflict([]), false, "not in the index is untracked, no conflict");
  for (const st3 of [[1, 3], [3], [2], [1, 2], [1, 2, 3]]) assert.equal(isConflict(st3.map((stage) => ({ stage }))), true, String(st3));
});

// (m) The status reads paths raw.
test("(m) status with -z: umlauts, spaces, quotes, backslash and \" -> \" arrive raw, a rename with its new path", async () => {
  const w = repo();
  const names = ["ü.txt", "a b.txt", 'q"t.txt', "b\\s.txt", "arrow -> x.txt", "tab\tx.txt"];
  write(w, "base.txt", "b\n");
  commit(w, "base");
  for (const n of names) write(w, n, "neu\n");
  let tree = await readGitTree(w);
  assert.deepEqual(tree.repos[0].changes.map((c) => c.path).sort(), [...names].sort(), "untracked: all paths raw");
  for (const c of tree.repos[0].changes) assert.ok(fs.existsSync(path.join(w, c.path)), `${c.path} exists in the working tree`);
  commit(w, "names");
  git(w, ["mv", "a b.txt", "new ü -> z.txt"]);
  write(w, "ü.txt", "geändert\n");
  tree = await readGitTree(w);
  assert.deepEqual(tree.repos[0].changes.map((c) => `${c.x}${c.y} ${c.path}`).sort(), [" M ü.txt", "R  new ü -> z.txt"].sort(), "rename: ONE entry with the new path");
  assert.equal(tree.repos[0].counts.total, 2);
  // And the diff tab finds both sides of the file with umlaut (otherwise both "missing").
  const a = await gitDiff(w, "", "ü.txt", { content: true });
  assert.deepEqual(a.prior, { kind: "text", text: "neu\n" });
  // The computation itself: R/C carry their old path as a field of its own, a remainder without "XY " is no entry.
  assert.deepEqual(parseStatusZ("R  new\0alt\0 M x\0?? y z\0"), [{ x: "R", y: " ", path: "new" }, { x: " ", y: "M", path: "x" }, { x: "?", y: "?", path: "y z" }]);
  assert.deepEqual(parseStatusZ(" C copy\0source\0"), [{ x: " ", y: "C", path: "copy" }]);
  assert.deepEqual(parseStatusZ(""), []);
  // Counter-test: the status without -z breaks exactly these names.
  const withoutZ = git(w, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.match(withoutZ, /"/, "without -z git quotes the names (otherwise this check measures nothing)");
});

test("(e) the kinds of a side: binary, too large, submodule, link", async () => {
  const w = repo();
  write(w, "bin.dat", Buffer.from([1, 0, 2, 3]).toString("latin1"));
  fs.writeFileSync(path.join(w, "bin.dat"), Buffer.from([1, 0, 2, 3]));
  write(w, "large.txt", "x".repeat(CONTENT_MAX + 10));
  fs.symlinkSync("target.txt", path.join(w, "reference"));
  const h = commit(w, "kinds");
  git(w, ["update-index", "--add", "--cacheinfo", `160000,${h},sub`]);
  const s = async (filePath) => (await gitDiff(w, "", filePath, { staged: true, content: true }));
  assert.deepEqual((await gitShow(w, "", h, { file: "bin.dat", content: true })).after, { kind: "binary" });
  assert.deepEqual((await gitShow(w, "", h, { file: "large.txt", content: true })).after, { kind: "large" });
  assert.deepEqual((await gitShow(w, "", h, { file: "reference", content: true })).after, { kind: "text", text: "target.txt", reference: true });
  assert.deepEqual((await s("sub")).after, { kind: "submodule" });
  for (const page of [(await s("sub")).prior, (await s("sub")).after]) assert.ok(CONTENT_KINDS.includes(page.kind), page.kind);
});

test("(f) a commit: prior at the first parent (old path on rename), root without prior, deletion without after", async () => {
  const w = repo();
  write(w, "a.txt", "a\n");
  write(w, "b c.txt", "b\ntwo\nthree\nfour\nfive\n");
  write(w, "way.txt", "gone\n");
  const c1 = commit(w, "root");
  write(w, "a.txt", "a\ntwo\n");
  fs.mkdirSync(path.join(w, "ü"));
  git(w, ["mv", "b c.txt", "ü/new.md"]);
  write(w, "ü/new.md", "b\ntwo\nthree\nfour\nfive\nsix\n");
  fs.rmSync(path.join(w, "way.txt"));
  const c2 = commit(w, "two");
  const a = await gitShow(w, "", c2, { file: "a.txt", content: true });
  assert.deepEqual(Object.keys(a), ["hash", "path", "old", "diff", "clipped", "prior", "after"]);
  assert.deepEqual([a.prior, a.after], [{ kind: "text", text: "a\n" }, { kind: "text", text: "a\ntwo\n" }]);
  const r = await gitShow(w, "", c2, { file: "ü/new.md", old: "b c.txt", content: true });
  assert.deepEqual(r.prior, { kind: "text", text: "b\ntwo\nthree\nfour\nfive\n" }, "prior under the OLD path");
  assert.match(r.diff, /^rename from b c\.txt$/m);
  assert.deepEqual((await gitShow(w, "", c1, { file: "a.txt", content: true })).prior, { kind: "missing" }, "the root has no prior");
  assert.deepEqual((await gitShow(w, "", c2, { file: "way.txt", content: true })).after, { kind: "missing" }, "deleted: no after");
  // A merge against its FIRST parent.
  git(w, ["checkout", "-q", "-b", "f"]);
  write(w, "a.txt", "a\ntwo\nf\n");
  commit(w, "f");
  git(w, ["checkout", "-q", "main"]);
  write(w, "x.txt", "x\n");
  commit(w, "m1");
  git(w, [...ID, "merge", "-q", "--no-ff", "-m", "M", "f"]);
  const M = git(w, ["rev-parse", "HEAD"]).trim();
  const m = await gitShow(w, "", M, { file: "a.txt", content: true });
  assert.deepEqual([m.prior.text, m.after.text], ["a\ntwo\n", "a\ntwo\nf\n"]);
});

const CHECK_ERROR = /Ungültiger Pfad|Invalid path|fehlt|missing/;
test("(g) hardening: only true, content at show only with file, paths before the first git, patterns literal", async () => {
  const w = repo();
  write(w, "*", "stern\n");
  write(w, ":(glob)x", "glob\n");
  write(w, "a.txt", "a\n");
  const h = commit(w, "one");
  write(w, "*", "stern\nzwei\n");
  write(w, ":(glob)x", "glob\nzwei\n");
  write(w, "a.txt", "a\ntwo\n");
  for (const value of [1, "yes", false, {}]) {
    await assert.rejects(gitDiff(w, "", "a.txt", { content: value }), /content ist true|content is true/, JSON.stringify(value));
    await assert.rejects(gitApply(w, "", "x", { workingTree: value }), /workingTree ist true|workingTree is true/, JSON.stringify(value));
  }
  await assert.rejects(gitShow(w, "", h, { content: true }), /content nur mit file|content only together with file/);
  await assert.rejects(gitShow(w, "", h, { info: true, content: true }), /content nur mit file|content only together with file/);
  for (const p of ["--output=x", "-x", "../x", "/etc/passwd", "a/../../x", ".", "", null]) {
    await assert.rejects(gitDiff(w, "", p, { content: true }), CHECK_ERROR, `„${p}“`);
  }
  assert.ok(!fs.existsSync(path.join(w, "x")), "--output=x wrote nothing");
  for (const [p, text] of [["*", "stern\n"], [":(glob)x", "glob\n"]]) {
    const a = await gitDiff(w, "", p, { content: true });
    assert.deepEqual(a.prior, { kind: "text", text }, `"${p}" is a file name`);
    assert.equal(a.diff.match(/^diff --git/gm)?.length, 1, `"${p}": exactly one file in the diff, no pattern`);
  }
  // The argv: the path last, behind `--`; a blob only via its object id.
  for (const argv of [diffContentArgs("p", false), diffContentArgs("p", true), contentTreeArgs("h", "p"), contentIndexArgs("p")]) {
    assert.deepEqual(argv.slice(-2), ["--", "p"], argv.join(" "));
    assert.ok(argv.includes("--literal-pathspecs"), argv.join(" "));
  }
  assert.deepEqual(diffContentNewArgs("./-x").slice(-3), ["--", "/dev/null", "-x"]);
  assert.equal(parseLsTree("100644 blob abc\tsrc/a.ts\0", "src"), null, "only EXACTLY the path");
  assert.deepEqual(parseLsFiles("100644 abc 0\tsrc/a.ts\0", "./src/a.ts"), [{ mode: "100644", oid: "abc", stage: 0 }]);
});

// A repo whose configuration spoils every unhardened diff: no prefixes, an external program, a textconv for *.txt.
function maliciousRepo() {
  const w = repo();
  const ext = path.join(w, ".git", "extern.sh");
  fs.writeFileSync(ext, "#!/bin/sh\necho EXTERN\n", { mode: 0o755 });
  git(w, ["config", "diff.noprefix", "true"]);
  git(w, ["config", "diff.external", ext]);
  git(w, ["config", "diff.large.textconv", "tr a-z A-Z <"]);
  git(w, ["config", "diff.context", "0"]); // without -U3 hunks without context — git apply would reject them
  write(w, ".gitattributes", "*.txt diff=large\n");
  write(w, "a.txt", TWELVE);
  commit(w, "one");
  write(w, "a.txt", twoChanges(TWELVE));
  return w;
}
test("(h) the diff is hardened: noprefix, diff.external and textconv do not change it — a hunk can be applied", async () => {
  const w = maliciousRepo();
  const a = await gitDiff(w, "", "a.txt", { content: true });
  checkUnstaged(w, a);
  await gitApply(w, "", blocks(a.diff)[0]);
  assert.match(git(w, ["show", ":0:a.txt"]), /line TWO\n/, "the first hunk is staged");
  assert.doesNotMatch(git(w, ["show", ":0:a.txt"]), /line ELEVEN/, "only the first");
});

// (k) A stash in the evil repo, plus `color.ui=always` — the check over the TEXT of a stash diff.
function checkStashDiff(diff) {
  assert.doesNotMatch(diff, /\u001b\[/, "no color (color.ui=always)");
  assert.match(diff, /^diff --git a\/a\.txt b\/a\.txt$/m, "prefixes a/ b/ (diff.noprefix)");
  assert.doesNotMatch(diff, /EXTERN/, "no external diff program");
  assert.doesNotMatch(diff, /LINE 1\b/, "no textconv");
  assert.equal(blocks(diff).length, 2, "two hunks");
  assert.match(diff, /^ line 1$/m, "three lines of context (diff.context=0)");
}
test("(k) git stash show is hardened: noprefix and color do not change the stash diff — a hunk can be applied", async () => {
  const w = maliciousRepo();
  git(w, ["config", "color.ui", "always"]);
  // The other prefix keys (srcPrefix/dstPrefix since git 2.45, ignored by older ones): only for the stash — (h) runs on the plain repo.
  git(w, ["config", "diff.mnemonicPrefix", "true"]);
  git(w, ["config", "diff.srcPrefix", "X/"]);
  git(w, ["config", "diff.dstPrefix", "Y/"]);
  git(w, ["stash", "-q"]);
  const r = await gitStashShow(w, "", "stash@{0}");
  assert.equal(r.ref, "stash@{0}");
  checkStashDiff(r.diff);
  await gitApply(w, "", blocks(r.diff)[0]);
  assert.match(git(w, ["show", ":0:a.txt"]), /line TWO\n/, "the first hunk of the stash is staged");
  assert.doesNotMatch(git(w, ["show", ":0:a.txt"]), /line ELEVEN/, "only the first");
  // Counter-test: the call without switches is red — otherwise the check measures nothing.
  assert.throws(() => checkStashDiff(raw(w, ["stash", "show", "-p", "stash@{0}"]).stdout), "the unhardened stash diff stays green");
  assert.throws(() => checkStashDiff(raw(w, ["-c", "color.ui=never", "stash", "show", "-p", "stash@{0}"]).stdout), "without prefixes it stays green");
});

test("(i) discard a hunk: workingTree takes back exactly the one hunk in the working tree, the index stays", async () => {
  const w = repo();
  write(w, "a.txt", TWELVE);
  commit(w, "one");
  write(w, "a.txt", twoChanges(TWELVE));
  const a = await gitDiff(w, "", "a.txt", { content: true });
  const [, second] = blocks(a.diff);
  await gitApply(w, "", second, { reverse: true, workingTree: true });
  assert.equal(read(w, "a.txt"), TWELVE.replace("line 2\n", "line TWO\n"), "only the second hunk is back");
  assert.equal(git(w, ["show", ":0:a.txt"]), TWELVE, "the index is untouched");
  // Without the option as before against the index (stage).
  const b = await gitDiff(w, "", "a.txt", { content: true });
  await gitApply(w, "", blocks(b.diff)[0]);
  assert.equal(git(w, ["show", ":0:a.txt"]), TWELVE.replace("line 2\n", "line TWO\n"));
});

test("(j) the route: content and workingTree go through, nonsense is 400, without them the answer of today", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    git(projPath, ["init", "-q", "-b", "main"]);
    write(projPath, "a.txt", TWELVE);
    const h = commit(projPath, "one");
    write(projPath, "a.txt", twoChanges(TWELVE));
    const ws = await makeWorkspace(base, "D", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const post = (way, body) => json(`${base}/api/projects/${proj.id}/git/${way}`, { method: "POST", body: JSON.stringify({ repo: "", ...body }) });
    const d = await post("diff", { file: "a.txt", content: true });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(Object.keys(d.body), ["path", "staged", "diff", "clipped", "prior", "after"]);
    assert.deepEqual(d.body.prior, { kind: "text", text: TWELVE });
    const old = await post("diff", { file: "a.txt" });
    assert.deepEqual(Object.keys(old.body), ["path", "staged", "diff"], "without content the answer of today");
    const s = await post("show", { hash: h, file: "a.txt", content: true });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.after, { kind: "text", text: TWELVE });
    for (const [way, body, pattern] of [
      ["diff", { file: "a.txt", content: 1 }, /content ist true|content is true/], ["diff", { file: "--output=x", content: true }, CHECK_ERROR],
      ["show", { hash: h, content: true }, /content nur mit file|content only together/], ["apply", { patch: "x", workingTree: "yes" }, /workingTree ist true|workingTree is true/],
    ]) {
      const r = await post(way, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, pattern);
    }
    const ap = await post("apply", { patch: blocks(d.body.diff)[1], reverse: true, workingTree: true });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal(read(projPath, "a.txt"), TWELVE.replace("line 2\n", "line TWO\n"), "the route discarded the hunk in the working tree");
  });
});

// ── Counter-tests: the same checks over wrong versions ──────────────────────────────────────────────────────────────────────
// A version of the unstaged diff with content (the same computation as gitDiff with `content`, via `raw`), with ONE place twisted each.
function revision(w, { without = [], priorFromHead = false } = {}) {
  const argv = diffContentArgs("a.txt", false).filter((a) => !without.includes(a));
  const diff = raw(w, argv).stdout;
  const source = priorFromHead ? "HEAD:a.txt" : ":0:a.txt";
  return { path: "a.txt", staged: false, diff, clipped: false, prior: { kind: "text", text: git(w, ["show", source]) }, after: { kind: "workingTree" } };
}
test("counter-test: without prefixes, without --no-ext-diff, without --no-textconv, prior from HEAD — every version turns the check red", async () => {
  const w = maliciousRepo();
  checkUnstaged(w, revision(w)); // the real version over the same way is green
  const fake = {
    "without --no-ext-diff (the external program writes the diff)": revision(w, { without: ["--no-ext-diff"] }),
    "without --no-textconv (the diff shows the converted text)": revision(w, { without: ["--no-textconv"] }),
    "without the prefixes (diff.noprefix)": revision(w, { without: ["--src-prefix=a/", "--dst-prefix=b/"] }),
    "without -U3 (diff.context=0)": revision(w, { without: ["-U3"] }),
  };
  for (const [name, a] of Object.entries(fake)) assert.throws(() => checkUnstaged(w, a), `version "${name}" stays green`);
  // Without -U3 (diff.context=0) no hunk can be applied — the reason it is in the argv.
  await assert.rejects(gitApply(w, "", blocks(revision(w, { without: ["-U3"] }).diff)[0]), "without -U3 git apply would accept the hunk");
  // Without the prefixes no hunk can be applied — the reason they are in the argv.
  await assert.rejects(gitApply(w, "", blocks(revision(w, { without: ["--src-prefix=a/", "--dst-prefix=b/"] }).diff)[0]), "without prefixes git apply would accept the hunk");
  // prior from HEAD instead of the index: red as soon as the index differs from HEAD.
  git(w, ["add", ".gitattributes"]);
  write(w, "a.txt", TWELVE.replace("line 6\n", "line SIX\n"));
  git(w, ["add", "a.txt"]);
  write(w, "a.txt", twoChanges(TWELVE.replace("line 6\n", "line SIX\n")));
  checkUnstaged(w, revision(w));
  assert.throws(() => checkUnstaged(w, revision(w, { priorFromHead: true })), "prior from HEAD stays green");
  // Without --literal-pathspecs "*" is a pattern: the diff would take every changed file.
  const m = repo();
  write(m, "*", "s\n");
  write(m, "b.txt", "b\n");
  commit(m, "one");
  write(m, "*", "s\nzwei\n");
  write(m, "b.txt", "b\nzwei\n");
  const real = raw(m, diffContentArgs("*", false)).stdout;
  const pattern = raw(m, diffContentArgs("*", false).filter((a) => a !== "--literal-pathspecs")).stdout;
  assert.equal(real.match(/^diff --git/gm)?.length, 1);
  assert.equal(pattern.match(/^diff --git/gm)?.length, 2, "without --literal-pathspecs \"*\" stays green");
});
