// "Stage change" in the editor's quick-diff peek: `POST …/git/stage-block` writes EXACTLY one hunk of the buffer into the index
// (electron/server/git.js "Stage a change", gitStageBlock — like VS Code git.stageChange: index + this one change ⇒ hash-object +
// update-index). Measured on REAL repos in a temp folder.
//
// What hangs here and why it is a guard:
//   (a) The computation `blockInIndex`: replaces exactly the lines [from, until) of the index, the index's line endings stay (CR LF, a
//       missing ending at the end), new lines carry the prevailing ending of the index (without one: that of the buffer, or LF when git
//       normalizes the file); appending after the last line, deleting to the end, an empty file.
//   (b) The index has moved ⇒ 409 INDEX_CHANGED, the index stays as it was — never a hunk in the wrong place. Checked via the checksum
//       of the WHOLE base (`baseSha`: a pure insertion at a shifted index of the same length would otherwise pass) and a second read of
//       the entry immediately before `update-index` (an index that moves BETWEEN reading and writing — measured with a git that stages
//       in between exactly there).
//   (c) Only THIS hunk: of two changes in the working tree exactly one is in the index afterwards, the other stays unstaged.
//   (d) The text comes from the BUFFER (the body), not from disk: an unsaved hunk is staged as it stands in the editor, and the file on
//       disk stays untouched.
//   (e) FILTER: a file with `filter`, `ident` or `working-tree-encoding` is 400 FILTER — no filter runs and no raw buffer goes past it
//       into the index (Git LFS); the line endings of new lines in an index without an ending follow `text`/`eol`/`core.autocrlf`.
//   (f) Rejected: conflict (409 CONFLICT), untracked (409 NOT_IN_INDEX), submodule/link/binary (400 NO_TEXT_FILE), above 2 MB in the index
//       (400 BLOCK_TOO_LARGE with the limit in the text); the mode 100755 stays.
//   (g) Path hardening: "-x" only as "./-x", ".." and absolute are 400 BEFORE the first git; "*" and ":(glob)*" are file names, not
//       patterns; umlauts and spaces go through raw.
//   (h) The route: 200 with the fresh tree, 400 with a code for an invalid body, 409 with a code for a moved index.
//   (i) No program from the repo's configuration: neither the hook `post-index-change` nor `core.fsmonitor` runs.
//
// COUNTER-TESTS built in (test "Counter-test …"): the same checks over wrong versions — a computation without the checksum, one without
// the check on `old` and checksum, one that turns all line endings into LF, one that writes new lines with LF instead of the index's
// ending; an index from `git add` (the whole file instead of the hunk), a `hash-object` WITH filters (`--path`), `update-index` and
// `ls-files` WITHOUT the switches (hook and fsmonitor run). Each must be red; if one stays green the check measures nothing.
// Sabotage on the source: without the old check ⇒ (a)(b)(h) red · `hash-object --path` instead of `--no-filters` ⇒ (e) red · new lines
//   always LF ⇒ (a) red (twice) · `git add -- <path>` instead of `update-index` ⇒ (c)(a)(e)(g)(h) red · mode fixed 100644 ⇒ (a) red ·
//   conflict not rejected ⇒ (f) red · the route always answers 400 ⇒ (h) red · checksum not compared ⇒ (a)(b) red · second read gone ⇒
//   (b) red · `needsFilter` always false ⇒ (e) red · `lfWithoutEnd` never set ⇒ (e) red · `WITHOUT_REPO_PROGRAMS` empty ⇒ (i) red ·
//   "large" as NO_TEXT_FILE ⇒ (f) red.
//
// Alone:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//         CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test server/backend/test/git-stage-block.test.js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { blockInIndex, needsFilter, gitStageBlock, indexChecksum, normalizedToLf, parseAttribute, stageBlockBody } from "../electron/server/git.js";
import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";

// ── Isolation (as in git-diff-content.test.js): no foreign ~/.gitconfig ──────────────────────────────────────────────────────────────
const ISO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-stage-block-")));
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
}
const write = (cwd, name, text) => { fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); fs.writeFileSync(path.join(cwd, name), text); };
const read = (cwd, name) => fs.readFileSync(path.join(cwd, name), "utf8");
const inIndex = (cwd, name) => git(cwd, ["show", `:0:${name}`]);
let seq = 0;
function repo() {
  const w = path.join(ISO, `r${++seq}`);
  fs.mkdirSync(w);
  git(w, ["init", "-q", "-b", "main"]);
  return w;
}
const ROWS = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const TWELVE = `${ROWS(12).join("\n")}\n`; // 13 lines in the sense of the margin (the last empty)
const block = (o) => ({ lineEnding: "\n", ...o });
const ANY = "0".repeat(64); // for cases rejected before the checksum
/** Stages against the index as it is NOW (the client computed against it): `baseSha` from the repo's index. */
const stage = (w, file, b, opts) => gitStageBlock(w, "", file, { ...b, baseSha: indexChecksum(inIndex(w, file.replace(/^\.\//, ""))) }, opts);
/** Does the computation throw with this status and code? */
const raises = (fn, status, code) => assert.throws(fn, (e) => e?.stageBlock === true && e.status === status && e.code === code, `expected ${status} ${code}`);

// ── (a) and (b): the computation, as a check over a given version (the counter-test runs the same over wrong ones) ────────────────────
function checkComputation(compute) {
  // The client computed against EXACTLY this text — its checksum goes along.
  const R = (text, b, o) => compute(text, { baseSha: indexChecksum(text), ...b }, o);
  // Replacing in the middle (index: 13 lines, the last empty).
  assert.equal(R(TWELVE, block({ from: 1, until: 2, old: ["line 2"], rows: ["TWO", "two b"], rowCount: 13 })),
    TWELVE.replace("line 2\n", "TWO\ntwo b\n"), "replaces exactly the lines [from, until)");
  // Inserting (from = until) and deleting (rows empty).
  assert.equal(R(TWELVE, block({ from: 3, until: 3, old: [], rows: ["new"], rowCount: 13 })), TWELVE.replace("line 4\n", "new\nline 4\n"));
  assert.equal(R(TWELVE, block({ from: 4, until: 6, old: ["line 5", "line 6"], rows: [], rowCount: 13 })), TWELVE.replace("line 5\nline 6\n", ""));
  // CR LF in the index stays — also on lines that are not in the hunk —, and new lines carry the prevailing ending of the index.
  const crlf = "a\r\nb\r\nc\r\n";
  assert.equal(R(crlf, block({ from: 1, until: 2, old: ["b"], rows: ["B", "B2"], rowCount: 4 })), "a\r\nB\r\nB2\r\nc\r\n", "CR LF des Index");
  // Mixed: every old line keeps ITS ending.
  assert.equal(R("a\r\nb\nc\r\nd\r\n", block({ from: 1, until: 2, old: ["b"], rows: ["X"], rowCount: 5 })), "a\r\nX\r\nc\r\nd\r\n");
  // No ending at the end: appending after the last line gives the old last one an ending, the new last one stays without.
  assert.equal(R("a\nb", block({ from: 2, until: 2, old: [], rows: ["c"], rowCount: 2 })), "a\nb\nc");
  // Deleting to the end: the new last line loses its ending (the margin counts "a\nb" as two lines, "a" as one).
  assert.equal(R("a\nb", block({ from: 1, until: 2, old: ["b"], rows: [], rowCount: 2 })), "a");
  // Replacing the last (empty) line: "ending added" as a hunk.
  assert.equal(R("a\n", block({ from: 1, until: 2, old: [""], rows: ["b", ""], rowCount: 2 })), "a\nb\n");
  // An empty file in the index has NO line; without an ending in the index that of the buffer applies — unless git normalizes the file (then LF).
  assert.equal(R("", block({ from: 0, until: 0, old: [], rows: ["x", ""], rowCount: 0 })), "x\n");
  assert.equal(R("", block({ from: 0, until: 0, old: [], rows: ["x", ""], rowCount: 0, lineEnding: "\r\n" })), "x\r\n");
  assert.equal(R("a", block({ from: 1, until: 1, old: [], rows: ["b"], rowCount: 1, lineEnding: "\r\n" }), { lfWithoutEnd: true }), "a\nb", "normalized: LF instead of buffer CR LF");
  assert.equal(R("a\r\n", block({ from: 1, until: 1, old: [], rows: ["b"], rowCount: 2 }), { lfWithoutEnd: true }), "a\r\nb\r\n", "with an ending in the index that of the index applies");
  // (b) The index has moved: old does not fit, the line count does not fit.
  raises(() => R(TWELVE, block({ from: 1, until: 2, old: ["line 3"], rows: ["x"], rowCount: 13 })), 409, "INDEX_CHANGED");
  raises(() => R(TWELVE, block({ from: 1, until: 1, old: [], rows: ["x"], rowCount: 12 })), 409, "INDEX_CHANGED");
  // (b) The client computed against "a b c d" and inserts "FRESH" after "b"; meanwhile someone staged "x" at the top and took "d" — the same
  // line count, no `old`. Only the checksum of the whole base sees it.
  const client = "a\nb\nc\nd\n", moved = "x\na\nb\nc\n";
  const insert = block({ from: 2, until: 2, old: [], rows: ["FRESH"], rowCount: 5, baseSha: indexChecksum(client) });
  assert.equal(compute(client, insert), "a\nb\nFRESH\nc\nd\n");
  raises(() => compute(moved, insert), 409, "INDEX_CHANGED");
  // The checksum is that of the NORMALIZED text (that is how the client holds the base): an index with CR LF fits a base with LF.
  assert.equal(indexChecksum("a\r\nb\rc"), indexChecksum("a\nb\nc"));
}

test("(a)(b) blockInIndex: exactly the rows of the hunk, line endings of the index stay, a moved index is 409", () => {
  checkComputation(blockInIndex);
});

test("(a) stageBlockBody: an invalid body is 400 with a code, a valid one comes back unchanged; the cap names itself", () => {
  const gut = { from: 1, until: 2, old: ["b"], rows: ["B"], rowCount: 3, lineEnding: "\n", baseSha: "a".repeat(64) };
  assert.deepEqual(stageBlockBody({ ...gut, repo: "", file: "a.txt" }), gut);
  for (const bad of [
    { ...gut, from: -1 }, { ...gut, from: 1.5 }, { ...gut, until: 0 }, { ...gut, until: 4 }, { ...gut, rowCount: "3" },
    { ...gut, old: ["b", "c"] }, { ...gut, old: "b" }, { ...gut, rows: ["a\nb"] }, { ...gut, rows: ["a\r"] }, { ...gut, rows: [1] },
    { ...gut, lineEnding: "\r" }, { ...gut, lineEnding: undefined }, null,
    { ...gut, baseSha: undefined }, { ...gut, baseSha: "A".repeat(64) }, { ...gut, baseSha: "a".repeat(63) },
  ]) raises(() => stageBlockBody(bad), 400, "BLOCK_INVALID");
  raises(() => stageBlockBody({ ...gut, rows: Array(60_001).fill("x") }), 400, "BLOCK_TOO_LARGE");
  assert.throws(() => stageBlockBody({ ...gut, rows: Array(60_001).fill("x") }), (e) => /60[.,]000/.test(e.message) && /2 MB/.test(e.message), "the cap does not say where it lies");
});

test("(e) attributes: needsFilter and normalizedToLf over the values of check-attr", () => {
  const A = (o) => ({ filter: "unspecified", "working-tree-encoding": "unspecified", ident: "unspecified", text: "unspecified", eol: "unspecified", ...o });
  assert.deepEqual(parseAttribute("a.txt\0filter\0lfs\0a.txt\0ident\0unset\0"), { filter: "lfs", ident: "unset" });
  assert.equal(needsFilter(A()), false);
  for (const o of [{ filter: "lfs" }, { filter: "set" }, { "working-tree-encoding": "UTF-16" }, { ident: "set" }]) assert.equal(needsFilter(A(o)), true, JSON.stringify(o));
  for (const o of [{ filter: "unset" }, { ident: "unset" }]) assert.equal(needsFilter(A(o)), false, JSON.stringify(o));
  assert.equal(normalizedToLf(A(), ""), false, "without attribute and autocrlf: the ending of the buffer");
  for (const [o, ac] of [[{ text: "set" }, ""], [{ text: "auto" }, ""], [{ eol: "crlf" }, ""], [{ eol: "lf" }, "false"], [{}, "true"], [{}, "input\n"]]) {
    assert.equal(normalizedToLf(A(o), ac), true, `${JSON.stringify(o)} autocrlf=${JSON.stringify(ac)}`);
  }
  assert.equal(normalizedToLf(A({ text: "unset" }), "true"), false, "-text is never converted");
  assert.equal(normalizedToLf(A(), "false"), false);
});

// ── (c)–(g) an echten Repos ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const twoChanges = (t) => t.replace("line 2\n", "line TWO\n").replace("line 10\n", "line TEN\n");
/** The state after "stage only the first hunk": index = TWO, working tree = both. */
function checkOnlyFirstBlock(w) {
  assert.equal(inIndex(w, "a.txt"), TWELVE.replace("line 2\n", "line TWO\n"), "exactly the one hunk is in the index");
  const unstaged = git(w, ["diff", "--no-color", "-U0", "--", "a.txt"]);
  assert.match(unstaged, /^-line 10$/m, "the other hunk stays unstaged");
  assert.doesNotMatch(unstaged, /line 2|TWO/, "the staged hunk is no longer unstaged");
}

test("(c)(d) only THIS hunk, and its text comes from the buffer — the disk stays untouched", async () => {
  const w = repo();
  write(w, "a.txt", TWELVE); commit(w, "one");
  write(w, "a.txt", twoChanges(TWELVE));
  await stage(w, "a.txt", block({ from: 1, until: 2, old: ["line 2"], rows: ["line TWO"], rowCount: 13 }));
  checkOnlyFirstBlock(w);
  assert.equal(read(w, "a.txt"), twoChanges(TWELVE), "the file on disk stays as it was");

  // (d) Unsaved: nothing of it is on disk, the text of the buffer is staged.
  const v = repo();
  write(v, "a.txt", TWELVE); commit(v, "one");
  await stage(v, "a.txt", block({ from: 4, until: 5, old: ["line 5"], rows: ["only in the editor"], rowCount: 13 }));
  assert.equal(inIndex(v, "a.txt"), TWELVE.replace("line 5\n", "only in the editor\n"));
  assert.equal(read(v, "a.txt"), TWELVE, "nothing is saved");
  assert.equal(git(v, ["status", "--porcelain", "--", "a.txt"]), "MM a.txt\n");
});

test("(a) CR LF in the index stays on real repos, the mode 100755 too", async () => {
  const w = repo();
  git(w, ["config", "core.autocrlf", "false"]);
  write(w, "a.txt", "one\r\ntwo\r\nthree\r\n");
  write(w, "x.sh", "#!/bin/sh\necho a\n");
  fs.chmodSync(path.join(w, "x.sh"), 0o755);
  commit(w, "one");
  await stage(w, "a.txt", block({ from: 1, until: 2, old: ["two"], rows: ["TWO", "two b"], rowCount: 4 }));
  assert.equal(inIndex(w, "a.txt"), "one\r\nTWO\r\ntwo b\r\nthree\r\n");
  await stage(w, "x.sh", block({ from: 1, until: 2, old: ["echo a"], rows: ["echo b"], rowCount: 3 }));
  assert.match(git(w, ["ls-files", "-s", "--", "x.sh"]), /^100755 /, "the mode stays");
  assert.equal(inIndex(w, "x.sh"), "#!/bin/sh\necho b\n");
});

test("(b) an index that has moved meanwhile is 409 INDEX_CHANGED — and stays as it was", async () => {
  const w = repo();
  write(w, "a.txt", TWELVE); commit(w, "one");
  write(w, "a.txt", twoChanges(TWELVE));
  git(w, ["add", "a.txt"]); // someone else staged everything meanwhile
  const prior = inIndex(w, "a.txt");
  await assert.rejects(gitStageBlock(w, "", "a.txt", block({ from: 1, until: 2, old: ["line 2"], rows: ["line TWO"], rowCount: 13, baseSha: indexChecksum(TWELVE) })),
    (e) => e.status === 409 && e.code === "INDEX_CHANGED");
  assert.equal(inIndex(w, "a.txt"), prior);

  // On a real repo: the same line count, no `old` — the client computed against "a b c d", the index holds "x a b c".
  const v = repo();
  write(v, "a.txt", "a\nb\nc\nd\n"); commit(v, "one");
  write(v, "a.txt", "x\na\nb\nc\n"); git(v, ["add", "a.txt"]);
  await assert.rejects(gitStageBlock(v, "", "a.txt", block({ from: 2, until: 2, old: [], rows: ["FRESH"], rowCount: 5, baseSha: indexChecksum("a\nb\nc\nd\n") })),
    (e) => e.status === 409 && e.code === "INDEX_CHANGED", "an insertion at a shifted place");
  assert.equal(inIndex(v, "a.txt"), "x\na\nb\nc\n");
});

/** A git in front of the real one that stages the whole file immediately BEFORE `hash-object` (an agent that stages between reading and writing). */
function withInBetween(file, fn) {
  const real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = fs.mkdtempSync(path.join(ISO, "bin-"));
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "hash-object" ]; then '${real}' -c core.hooksPath=/dev/null add -- '${file}' </dev/null; break; fi
done
exec '${real}' "$@"
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  return fn().finally(() => { process.env.PATH = saved; });
}
test("(b) an index that moves BETWEEN reading and writing is 409 — the second read before update-index", async () => {
  const w = repo();
  write(w, "a.txt", TWELVE); commit(w, "one");
  write(w, "a.txt", twoChanges(TWELVE));
  const b = block({ from: 1, until: 2, old: ["line 2"], rows: ["line TWO"], rowCount: 13, baseSha: indexChecksum(TWELVE) });
  await withInBetween("a.txt", () => assert.rejects(gitStageBlock(w, "", "a.txt", b), (e) => e.status === 409 && e.code === "INDEX_CHANGED"));
  assert.equal(inIndex(w, "a.txt"), twoChanges(TWELVE), "the index is that of the in-between — the hunk did not overwrite it");
});

/** A repo with a clean filter that writes a marker (and makes the content large). */
function repoWithFilter(attribute = "filter=malicious") {
  const w = repo();
  const marker = path.join(w, "..", `marke-${path.basename(w)}`);
  write(w, "a.txt", TWELVE); commit(w, "one");
  git(w, ["config", "filter.malicious.clean", `sh -c 'touch "${marker}"; tr a-z A-Z'`]);
  git(w, ["config", "filter.malicious.smudge", "cat"]);
  write(w, ".git/info/attributes", `a.txt ${attribute}\n`);
  return { w, marker };
}
test("(e) FILTER: filter, ident and working-tree-encoding are 400 — no filter runs, nothing goes past it", async () => {
  for (const attribute of ["filter=malicious", "ident", "working-tree-encoding=UTF-16"]) {
    const { w, marker } = repoWithFilter(attribute);
    await assert.rejects(stage(w, "a.txt", block({ from: 1, until: 2, old: ["line 2"], rows: ["line TWO"], rowCount: 13 })),
      (e) => e.status === 400 && e.code === "FILTER", attribute);
    assert.equal(fs.existsSync(marker), false, `${attribute}: the filter ran`);
    assert.equal(inIndex(w, "a.txt"), TWELVE, `${attribute}: the index did not stay as it was`);
  }
  // Git LFS via .gitattributes in the working tree (without an installed driver): likewise.
  const v = repo();
  write(v, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  write(v, "d.bin", "a\nb\n"); commit(v, "one");
  await assert.rejects(stage(v, "d.bin", block({ from: 0, until: 1, old: ["a"], rows: ["A"], rowCount: 3 })), (e) => e.status === 400 && e.code === "FILTER");
});

test("(e) an index without line ending: fresh rows LF when git normalizes (text, eol, core.autocrlf), otherwise the CR LF of the buffer", async () => {
  const fall = async (setUp, expected, name) => {
    const w = repo();
    git(w, ["config", "core.autocrlf", "false"]);
    write(w, "a.txt", "a"); commit(w, "one");
    setUp(w);
    await stage(w, "a.txt", block({ from: 1, until: 1, old: [], rows: ["b"], rowCount: 1, lineEnding: "\r\n" }));
    assert.equal(inIndex(w, "a.txt"), expected, name);
  };
  await fall(() => {}, "a\r\nb", "without normalization: the ending of the buffer");
  await fall((w) => write(w, ".git/info/attributes", "a.txt text\n"), "a\nb", "text");
  await fall((w) => write(w, ".git/info/attributes", "a.txt eol=crlf\n"), "a\nb", "eol=crlf");
  await fall((w) => git(w, ["config", "core.autocrlf", "true"]), "a\nb", "core.autocrlf=true");
  await fall((w) => { git(w, ["config", "core.autocrlf", "true"]); write(w, ".git/info/attributes", "a.txt -text\n"); }, "a\r\nb", "-text gewinnt");
});

test("(f) conflict, untracked, submodule, link, binary and too large are rejected", async () => {
  const w = repo();
  write(w, "a.txt", "a\n"); commit(w, "one");
  git(w, ["checkout", "-q", "-b", "beside"]); write(w, "a.txt", "beside\n"); commit(w, "beside");
  git(w, ["checkout", "-q", "main"]); write(w, "a.txt", "main\n"); commit(w, "main");
  raw(w, [...ID, "merge", "beside"]);
  const b = block({ from: 0, until: 1, old: ["a"], rows: ["x"], rowCount: 2, baseSha: ANY });
  await assert.rejects(gitStageBlock(w, "", "a.txt", b), (e) => e.status === 409 && e.code === "CONFLICT");
  write(w, "free.txt", "f\n");
  await assert.rejects(gitStageBlock(w, "", "free.txt", b), (e) => e.status === 409 && e.code === "NOT_IN_INDEX");

  const v = repo();
  write(v, "bin.dat", "a\0b\n");
  fs.symlinkSync("target.txt", path.join(v, "reference"));
  write(v, "target.txt", "z\n");
  write(v, "large.txt", `${"x".repeat(1023)}\n`.repeat(2 * 1024 + 1)); // 2 MB + 1 KB
  commit(v, "one");
  const sub = repo(); write(sub, "s.txt", "s\n"); commit(sub, "sub");
  git(v, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod"]);
  for (const file of ["bin.dat", "reference", "mod"]) {
    await assert.rejects(gitStageBlock(v, "", file, b), (e) => e.status === 400 && e.code === "NO_TEXT_FILE", file);
  }
  // Too large is not "no text" — and the text names the limit.
  await assert.rejects(gitStageBlock(v, "", "large.txt", b), (e) => e.status === 400 && e.code === "BLOCK_TOO_LARGE" && /2 MB/.test(e.message), "large.txt");
});

test("(g) paths: \"./-x\", \"*\", \":(glob)*\", umlauts and spaces go through raw; \"-x\", \"..\" and absolute are errors before git", async () => {
  const w = repo();
  for (const n of ["-x", "*", ":(glob)*", "ü ä.txt", "a.txt"]) write(w, n, "one\n");
  commit(w, "one");
  const b = block({ from: 0, until: 1, old: ["one"], rows: ["TWO"], rowCount: 2 });
  for (const [request, file] of [["./-x", "-x"], ["*", "*"], [":(glob)*", ":(glob)*"], ["ü ä.txt", "ü ä.txt"]]) {
    await stage(w, request, b);
    assert.equal(inIndex(w, file), "TWO\n", request);
  }
  assert.equal(inIndex(w, "a.txt"), "one\n", "\"*\" and \":(glob)*\" were no patterns");
  for (const bad of ["-x", "../a.txt", "/etc/passwd", "a/../a.txt", ""]) {
    await assert.rejects(gitStageBlock(w, "", bad, { ...b, baseSha: ANY }), (e) => !e.stageBlock && /Pfad|path|missing|missing/.test(e.message), bad);
  }
});

test("(h) Die Route: 200 including the frischen Tree, 400 and 409 including Code", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    git(projPath, ["init", "-q", "-b", "main"]);
    write(projPath, "a.txt", TWELVE);
    commit(projPath, "one");
    write(projPath, "a.txt", twoChanges(TWELVE));
    const ws = await makeWorkspace(base, "D", wsPath);
    const proj = await makeProject(base, ws.id, projPath);
    const post = (body) => json(`${base}/api/projects/${proj.id}/git/stage-block`, { method: "POST", body: JSON.stringify({ repo: "", ...body }) });
    const body = { file: "a.txt", ...block({ from: 1, until: 2, old: ["line 2"], rows: ["line TWO"], rowCount: 13, baseSha: indexChecksum(TWELVE) }) };
    const r = await post(body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const entry = r.body.repos[0].changes.find((c) => c.path === "a.txt");
    assert.deepEqual([entry.x, entry.y], ["M", "M"], "the tree of the answer knows the staged hunk");
    checkOnlyFirstBlock(projPath);
    const wrong = await post(body); // the same body against the index that has moved meanwhile
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, "INDEX_CHANGED");
    const invalid = await post({ file: "a.txt", from: 2, until: 1, old: [], rows: [], rowCount: 13, lineEnding: "\n", baseSha: ANY });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "BLOCK_INVALID");
    const withoutSha = await post({ ...body, baseSha: undefined });
    assert.equal(withoutSha.status, 400, "a body without baseSha (an old client) is not silently accepted");
    assert.equal(withoutSha.body.code, "BLOCK_INVALID");
    const filePath = await post({ file: "--output=x", ...block({ from: 0, until: 0, old: [], rows: [], rowCount: 13, baseSha: ANY }) });
    assert.equal(filePath.status, 400);
    assert.match(filePath.body.error, /Ungültiger Pfad|Invalid path/);
  });
});

/** A repo with the hook `post-index-change` and a `core.fsmonitor` that each write a marker. */
function repoWithHook() {
  const w = repo();
  write(w, "a.txt", TWELVE); commit(w, "one");
  const hook = path.join(w, "..", `hook-${path.basename(w)}`), fsm = path.join(w, "..", `fsm-${path.basename(w)}`);
  fs.writeFileSync(path.join(w, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch "${hook}"\n`, { mode: 0o755 });
  const fsmScript = path.join(w, "..", `fsm-${path.basename(w)}.sh`);
  fs.writeFileSync(fsmScript, `#!/bin/sh\ntouch "${fsm}"\nexit 1\n`, { mode: 0o755 });
  git(w, ["config", "core.fsmonitor", fsmScript]);
  for (const m of [hook, fsm]) fs.rmSync(m, { force: true });
  return { w, hook, fsm };
}
test("(i) no program from the repo's configuration: neither post-index-change nor core.fsmonitor runs", async () => {
  const { w, hook, fsm } = repoWithHook();
  // The checksum comes from the known text — the helper's `git show` would call the fsmonitor itself.
  await gitStageBlock(w, "", "a.txt", block({ from: 1, until: 2, old: ["line 2"], rows: ["line TWO"], rowCount: 13, baseSha: indexChecksum(TWELVE) }));
  assert.equal(fs.existsSync(hook), false, "the hook post-index-change ran");
  assert.equal(fs.existsSync(fsm), false, "core.fsmonitor lief");
  assert.equal(inIndex(w, "a.txt"), TWELVE.replace("line 2\n", "line TWO\n"));
});

// ── Counter-tests: the same checks over wrong versions ──────────────────────────────────────────────────────────────────────
test("counter-test: without checksum, without old check, all LF, new lines LF, git add instead of hunk, filter, hook — every version is red", async () => {
  const withoutChecksum = (text, b, o) => blockInIndex(text, { ...b, baseSha: indexChecksum(text) }, o);
  const withoutOldCheck = (text, b, o) => blockInIndex(text, { ...b, baseSha: indexChecksum(text), old: String(text).split(/\r\n|\r|\n/).slice(b.from, b.until), rowCount: String(text) === "" ? 0 : String(text).split(/\r\n|\r|\n/).length }, o);
  const everythingLf = (text, b, o) => blockInIndex(String(text).replace(/\r\n?/g, "\n"), b, o);
  const newLf = (text, b, o) => {
    const fresh = blockInIndex(text, b, o);
    return b.rows.length ? fresh.replace(`${b.rows[0]}\r\n`, `${b.rows[0]}\n`) : fresh;
  };
  const neverNormed = (text, b) => blockInIndex(text, b);
  for (const [name, wrong] of [["without checksum", withoutChecksum], ["without old check", withoutOldCheck], ["all LF", everythingLf], ["new lines LF", newLf], ["never normalized", neverNormed]]) {
    assert.throws(() => checkComputation(wrong), assert.AssertionError, `${name}: the check of the computation would stay green`);
  }
  // git add instead of hunk: the whole file lands in the index.
  const w = repo();
  write(w, "a.txt", TWELVE); commit(w, "one");
  write(w, "a.txt", twoChanges(TWELVE));
  git(w, ["add", "a.txt"]);
  assert.throws(() => checkOnlyFirstBlock(w), assert.AssertionError, "git add: the check \"only this hunk\" would stay green");
  // hash-object WITH filters (`--path`, like VS Code repository.stage): the filter runs, the marker stands.
  const { w: f, marker } = repoWithFilter();
  git(f, ["hash-object", "-w", "--stdin", "--path", "a.txt"], TWELVE);
  assert.equal(fs.existsSync(marker), true, "with filters the clean filter would run — otherwise (e) measures nothing");
  // Without the switches hook and fsmonitor run — otherwise (i) measures nothing.
  const { w: h, hook, fsm } = repoWithHook();
  git(h, ["ls-files", "-s", "--", "a.txt"]);
  assert.equal(fs.existsSync(fsm), true, "ls-files without core.fsmonitor=false does not call fsmonitor — (i) would measure nothing");
  const oid = git(h, ["hash-object", "-w", "--stdin", "--no-filters"], TWELVE).trim();
  git(h, ["update-index", "--cacheinfo", `100644,${oid},a.txt`]);
  assert.equal(fs.existsSync(hook), true, "update-index without core.hooksPath=/dev/null does not call the hook — (i) would measure nothing");
});
