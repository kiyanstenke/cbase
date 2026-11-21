// The git read paths of the editor and the explorer call NO program from the repo's configuration (code electron/server/runtime/git-run.js
// `readingArgs`, applied in electron/server/git.js `git()` — the one starter in B and in the project container — and in the read bundle
// `BUNDLE_SCRIPT`).
//
// What hangs here and why it is a guard:
//   (a) A REAL throwaway repo whose configuration points at scripts that write a marker: `core.fsmonitor`, the hook `post-index-change`,
//       `diff.external`, `diff.<driver>.command`, `diff.<driver>.textconv` and `gpg.program` and `gpg.x509.program` via
//       `log.showSignature=true` on two commits with a forged signature (`hash-object -t commit -w`, no gpg needed: git calls the program
//       already to verify). Every read path of the routes — status (tree), ignored, diff (working tree, staged, untracked), diff with
//       content (all three), show (diff, files, file, info, content), log, time axis, blame, stash (list, diff) and the read bundle of
//       the git view — runs through the real functions of git.js; the marker stays empty. The file search (⌘P, `files/find`,
//       `files/search`) calls no git and is therefore not here.
//   (b) Every reading call these paths send to git (recorded by a `git` on the PATH) carries the switches first; every path sends at
//       least one such call (otherwise (a) measures nothing for it).
//   (c) The computation `readingArgs`: only the reading subcommands, global options stay, nothing twice, writing commands unchanged.
//
// COUNTER-TEST built in (test "Counter-test …"): EVERY recorded call is run once more WITHOUT the switches against the same repo —
// then fsmonitor, hook, external diff, diff command and textconv write their marker, each at least once; the paths for which a
// program runs are EXACTLY the table `UNPROTECTED_FIRES`. If the marker stayed empty for a path, (a) would measure nothing for it.
// Sabotage on the source: `args = readingArgs(args);` in git.js `git()` dropped ⇒ (a)(b) red · `readingArgs(READ_COMMANDS[n])` in the
// bundle back to `READ_COMMANDS[n]` ⇒ (a)(b) red · `READ_TOGGLE` without `core.fsmonitor=false` ⇒ (a)(b)(c) red · `blame` without
// `--no-textconv` ⇒ (a)(c) red · `diff-tree` not listed as reading ⇒ (a)(b) red · `READ_TOGGLE` without `log.showSignature=false` ⇒
// (a) red with "Tree (status): gpg" (`last` in readRepoInfo), "Show: gpg", "Log: gpg, gpgx509", "Read bundle: gpg".
// The `sh -c` bundles of the git overview (gitView/read.js READ_SCRIPT, gitView/detail.js DETAIL_SCRIPT/DIFF_SCRIPT) too — they call
// git by name, the first line `READ_SH` (runtime/git-run.js) is a shell function `git` with the switches. Sabotage: `READ_SH` dropped
// in READ_SCRIPT ⇒ (a) "Git overview read: fsmonitor, gpg", (b) `status --porcelain`, `log -1` red · dropped in HEADER_SCRIPT ⇒ (a)
// "Git overview detail: gpg", (b) red · `--no-ext-diff --no-textconv` dropped in DIFF_SCRIPT ⇒ (a) "Git overview diff: extern" red.
//
// Alone:  CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000 \
//         CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test server/backend/test/git-read-paths.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import * as g from "../electron/server/git.js";
import { READ_TOGGLE, READ_SH, readingArgs } from "../electron/server/runtime/git-run.js";
import { DETAIL_SCRIPT, DIFF_SCRIPT } from "../electron/server/gitView/detail.js";
import { READ_SCRIPT } from "../electron/server/gitView/read.js";

// ── Isolation (as in git-stage-block.test.js): no foreign ~/.gitconfig ─────────────────────────────────────────────────────────────
const ISO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-read-paths-")));
after(() => {
  try { fs.rmSync(ISO, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (e) { console.warn(`[test] ${ISO} was left behind (${e.code || e.message}) — test unaffected.`); }
});
for (const d of ["home", "xdg", "prog", "bin"]) fs.mkdirSync(path.join(ISO, d));
Object.assign(process.env, { HOME: path.join(ISO, "home"), XDG_CONFIG_HOME: path.join(ISO, "xdg"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) delete process.env[k];

const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const ID = ["-c", "user.name=Testerin", "-c", "user.email=t@example.com"];
// Setup without any program of the repo (the configuration comes only afterwards, see situation()).
const raw = (cwd, args) => execFileSync(REAL_GIT, [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ── The `git` on the PATH: records location, count and argv, each field NUL-terminated (an argument cannot carry a NUL — the
// separators \036 \037 would collide with the format of gitLog and `last` themselves: `US` is \037, the counter-test would run these
// calls torn apart and measure nothing there), then the real git ─────────────────────────────────────────────────────────────────────────────
const LOG = path.join(ISO, "argv.log");
fs.writeFileSync(path.join(ISO, "bin", "git"), [
  "#!/bin/sh",
  `{ printf '%s\\000' "$(pwd -P)" "$#"; for a in "$@"; do printf '%s\\000' "$a"; done; } >> '${LOG}'`,
  `exec '${REAL_GIT}' "$@"`,
].join("\n") + "\n", { mode: 0o755 });
process.env.PATH = `${path.join(ISO, "bin")}:${process.env.PATH}`;
const calls = () => {
  const f = (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "").split("\0");
  const out = [];
  for (let i = 0; i + 1 < f.length;) {
    const n = Number(f[i + 1]);
    out.push({ location: f[i], argv: f.slice(i + 2, i + 2 + n) });
    i += 2 + n;
  }
  return out;
};

// ── The programs: each writes its name into the marker ───────────────────────────────────────────────────────────────────────
const MARKER = path.join(ISO, "marker");
const program = (name, body = "") => {
  const p = path.join(ISO, "prog", name);
  fs.writeFileSync(p, `#!/bin/sh\necho ${name} >> '${MARKER}'\n${body}exit 0\n`, { mode: 0o755 });
  return p;
};
const markers = () => (fs.existsSync(MARKER) ? [...new Set(fs.readFileSync(MARKER, "utf8").split("\n").filter(Boolean))].sort() : []);

/** Project P with code repo P/app: two commits, a stash, changes in the working tree and in the index, untracked, ignored — then the
 *  programs in the configuration. */
function situation() {
  const P = path.join(ISO, "project");
  const A = path.join(P, "app");
  fs.mkdirSync(path.join(A, "deep"), { recursive: true });
  raw(A, ["init", "-q", "-b", "main"]);
  const write = (n, t) => fs.writeFileSync(path.join(A, n), t);
  write(".gitattributes", "*.txt diff=tc\n*.cm diff=cm\n");
  write(".gitignore", "*.log\nbuild/\n");
  write("a.txt", "a\n");
  write("b.cm", "b\n");
  write("c.txt", "c\n");
  write("deep/d.txt", "d\n");
  raw(A, ["add", "-A"]);
  raw(A, ["commit", "-q", "-m", "first state"]);
  write("a.txt", "a\nzwei\n");
  write("z.txt", "z\n");
  raw(A, ["add", "-A"]);
  raw(A, ["commit", "-q", "-m", "second state"]);
  // Two commits with a forged signature on top (the same tree): x509 below, PGP as HEAD — gitLog sees both, show and `last` HEAD.
  const tree = raw(A, ["rev-parse", "HEAD^{tree}"]).trim();
  for (const [kind, header] of [["x509", "-----BEGIN SIGNED MESSAGE-----\n MIAG\n -----END SIGNED MESSAGE-----"], ["pgp", "-----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----"]]) {
    const headers = `tree ${tree}\nparent ${raw(A, ["rev-parse", "HEAD"]).trim()}\nauthor Testerin <t@example.com> 1700000000 +0000\ncommitter Testerin <t@example.com> 1700000000 +0000\n`;
    const oid = execFileSync(REAL_GIT, ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: A, input: `${headers}gpgsig ${header}\n\nsigned (${kind})\n`, encoding: "utf8" }).trim();
    raw(A, ["update-ref", "refs/heads/main", oid]);
  }
  // A branch for the git overview detail: one commit ahead, on it one with a forged signature; then back to main.
  raw(A, ["checkout", "-q", "-b", "feature"]);
  write("a.txt", "a\nzwei\nfeature\n");
  raw(A, ["commit", "-q", "-am", "feature"]);
  {
    const k = `tree ${raw(A, ["rev-parse", "HEAD^{tree}"]).trim()}\nparent ${raw(A, ["rev-parse", "HEAD"]).trim()}\nauthor Testerin <t@example.com> 1700000001 +0000\ncommitter Testerin <t@example.com> 1700000001 +0000\n`;
    const oid = execFileSync(REAL_GIT, ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: A, input: `${k}gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----\n\nfeature signed\n`, encoding: "utf8" }).trim();
    raw(A, ["update-ref", "-m", "feature signed", "refs/heads/feature", oid]);
  }
  raw(A, ["checkout", "-q", "main"]);
  write("c.txt", "c\nstashed\n");
  raw(A, ["stash", "push", "-q", "-m", "a stash"]);
  write("a.txt", "a\nzwei\ndrei\n");     // changed in the working tree (diff=tc)
  write("b.cm", "b\nbb\n");              // changed in the working tree (diff=cm)
  write("c.txt", "c\nstaged\n");
  raw(A, ["add", "c.txt"]);                 // changed in the index
  write("fresh.txt", "new\n");             // untracked
  write("x.log", "log\n");               // ignored
  fs.mkdirSync(path.join(A, "build"));
  fs.writeFileSync(path.join(A, "build", "y"), "y\n");
  // Only now the programs (the setup above ran without them).
  // fsmonitor reads no stdin (the starter's pipe would stay open, a `cat` would wait until the deadline).
  raw(A, ["config", "core.fsmonitor", program("fsmonitor")]);
  fs.writeFileSync(path.join(A, ".git", "hooks", "post-index-change"), `#!/bin/sh\necho hook >> '${MARKER}'\n`, { mode: 0o755 });
  raw(A, ["config", "diff.external", program("extern")]);
  raw(A, ["config", "diff.cm.command", program("diff-command")]);
  raw(A, ["config", "diff.tc.textconv", program("textconv", "cat \"$1\"\n")]);
  raw(A, ["config", "log.showSignature", "true"]);
  raw(A, ["config", "gpg.program", program("gpg")]);
  raw(A, ["config", "gpg.x509.program", program("gpgx509")]);
  return { P, A };
}
const { P, A } = situation();
const HASH = raw(A, ["rev-parse", "HEAD"]).trim();

// ── The read paths of the routes (devtools/code-route.js → git.js), each with the name under which a finding appears ────────────────────
const WAYS = [
  ["Tree (status)", () => g.readGitTree(P, {})],
  ["Ignored", () => g.gitIgnored(P, {})],
  ["Diff working tree", () => g.gitDiff(P, "app", "a.txt", {})],
  ["Diff working tree (command)", () => g.gitDiff(P, "app", "b.cm", {})],
  ["Diff staged", () => g.gitDiff(P, "app", "c.txt", { staged: true })],
  ["Diff untracked", () => g.gitDiff(P, "app", "fresh.txt", {})],
  ["Diff content", () => g.gitDiff(P, "app", "a.txt", { content: true })],
  ["Diff content staged", () => g.gitDiff(P, "app", "c.txt", { staged: true, content: true })],
  ["Diff content untracked", () => g.gitDiff(P, "app", "fresh.txt", { content: true })],
  ["Show", () => g.gitShow(P, "app", HASH, {})],
  ["Show files", () => g.gitShow(P, "app", HASH, { files: true })],
  ["Show file", () => g.gitShow(P, "app", HASH, { file: "a.txt" })],
  ["Show Info", () => g.gitShow(P, "app", HASH, { info: true })],
  ["Show content", () => g.gitShow(P, "app", HASH, { file: "a.txt", content: true })],
  ["Log", () => g.gitLog(P, "app", { limit: 5 })],
  ["TimeAxis", () => g.gitTimeAxis(P, "app", "a.txt", {})],
  ["Blame", () => g.gitBlame(P, "app", "a.txt", {})],
  ["Stash list", () => g.gitStashList(P, "app", {})],
  ["Stash diff", () => g.gitStashShow(P, "app", "stash@{0}", {})],
  // The read bundle otherwise runs only in the project container; here the same script in B, against the same repo.
  ["Read bundle", () => execFileSync("/bin/sh", ["-c", g.BUNDLE_SCRIPT, "sh", "cbase-marker", A], { encoding: "utf8" })],
  // The git overview: its `sh -c` bundles otherwise run in the project container or in B — here the same script in B with the same
  // environment (GIT_OPTIONAL_LOCKS=0), against the same repo.
  ["Git overview read", () => execFileSync("/bin/sh", ["-c", READ_SCRIPT, "sh", "cbase-marker", A, "50", "0"], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })],
  ["Git overview detail", () => execFileSync("/bin/sh", ["-c", DETAIL_SCRIPT, "sh", "cbase-marker", "feature", "", "50"], { cwd: A, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })],
  ["Git overview diff", () => execFileSync("/bin/sh", ["-c", DIFF_SCRIPT, "sh", "cbase-marker", "feature", "", "a.txt"], { cwd: A, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })],
];
// Without the switches at least one program runs for EXACTLY these paths (measured with git 2.50.1, the counter-test holds the set) —
// "Log" via `log.showSignature` (gpg.program, gpg.x509.program); the others only read objects (time axis with `--no-show-signature`,
// `stash list`) or carry the switches of the diff already (`stash show` with WITHOUT_PROGRAM); there is nothing to protect today
// (they carry the switches anyway), and (a) shows that they call nothing even so.
const UNPROTECTED_FIRES = ["Tree (status)", "Ignored", "Diff working tree", "Diff working tree (command)", "Diff staged", "Diff untracked",
  "Diff content", "Diff content staged", "Diff content untracked", "Show", "Show files", "Show file", "Show Info", "Show content", "Log",
  "Blame", "Read bundle", "Git overview read", "Git overview detail", "Git overview diff"];

// One run per way: empty the marker, empty the recording, run, read both.
const runs = [];
for (const [name, run] of WAYS) {
  fs.writeFileSync(MARKER, "");
  fs.writeFileSync(LOG, "");
  let error = null;
  try { await run(); } catch (e) { error = e; }
  runs.push({ name, error, markers: markers(), calls: calls() });
}
const READING = new Set(["status", "ls-files", "check-attr", "check-ignore", "blame", "diff", "diff-tree", "show", "log", "stash show"]);
const subcommand = (argv) => {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) i += argv[i] === "-c" || argv[i] === "-C" ? 2 : 1;
  return argv[i] === "stash" && argv[i + 1] === "show" ? "stash show" : argv[i];
};
const withoutToggle = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-c" && READ_TOGGLE.includes(argv[i + 1])) { i++; continue; }
    if (argv[i] === "--no-ext-diff" || argv[i] === "--no-textconv") continue;
    out.push(argv[i]);
  }
  return out;
};

test("(a) no read path calls a program from the repo's configuration (fsmonitor, hook, external diff, diff command, textconv, gpg)", () => {
  const findings = [];
  for (const l of runs) {
    if (l.error) findings.push(`${l.name}: error ${l.error.message}`);
    if (l.markers.length) findings.push(`${l.name}: ${l.markers.join(", ")}`);
  }
  assert.deepEqual(findings, []);
});

test("(b) every reading call carries the switches first, and every path sends a call to git", () => {
  const without = [];
  for (const l of runs) {
    assert.ok(l.calls.length > 0, `${l.name}: no call to git — the recording measures nothing`);
    const reading = l.calls.filter((a) => READING.has(subcommand(a.argv)));
    for (const a of reading) if (JSON.stringify(a.argv.slice(0, READ_TOGGLE.length)) !== JSON.stringify(READ_TOGGLE)) without.push(`${l.name}: ${a.argv.join(" ")}`);
  }
  assert.deepEqual(without, []);
});

test("counter-test: the same calls WITHOUT the switches call the repo's programs", () => {
  const fired = new Map();
  const all = new Set();
  for (const l of runs) {
    fs.writeFileSync(MARKER, "");
    for (const a of l.calls) {
      try { execFileSync(REAL_GIT, withoutToggle(a.argv), { cwd: a.location, stdio: ["ignore", "pipe", "pipe"] }); } catch { /* exit ≠ 0 does not count */ }
    }
    fired.set(l.name, markers());
    for (const m of markers()) all.add(m);
  }
  // The paths for which a program runs without the switches are EXACTLY the table: if one is missing, (a) would measure nothing for it;
  // if one is added, the table (and the measurement in the header of runtime/git-run.js) is out of date.
  const fires = [...fired].filter(([, m]) => m.length > 0).map(([n]) => n);
  assert.deepEqual(fires, UNPROTECTED_FIRES, JSON.stringify(Object.fromEntries(fired)));
  // Each of the seven ways to start a program went at least once without the switches — otherwise one of the switches is unchecked.
  assert.deepEqual([...all].sort(), ["diff-command", "extern", "fsmonitor", "gpg", "gpgx509", "hook", "textconv"]);
});

test("(c) readingArgs: only reading subcommands, global options stay, nothing twice, writing ones unchanged", () => {
  const S = [...READ_TOGGLE];
  assert.deepEqual(readingArgs(["status", "-z"]), [...S, "status", "-z"]);
  assert.deepEqual(readingArgs(["-c", "core.quotePath=false", "--literal-pathspecs", "diff", "--staged", "--", "a"]),
    [...S, "-c", "core.quotePath=false", "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--staged", "--", "a"]);
  assert.deepEqual(readingArgs(["log", "--no-ext-diff", "-1"]), [...S, "log", "--no-textconv", "--no-ext-diff", "-1"], "no switch twice");
  assert.deepEqual(readingArgs(["blame", "--porcelain", "--", "a"]), [...S, "blame", "--no-textconv", "--porcelain", "--", "a"]);
  assert.deepEqual(readingArgs(["stash", "show", "-p", "stash@{0}"]), [...S, "stash", "show", "--no-ext-diff", "--no-textconv", "-p", "stash@{0}"]);
  assert.deepEqual(readingArgs([...S, "ls-files", "-s"]), [...S, "ls-files", "-s"], "the prefix does not come twice (WITHOUT_REPO_PROGRAMS)");
  assert.deepEqual(readingArgs(["-C", "/x", "show", "HEAD"]), [...S, "-C", "/x", "show", "--no-ext-diff", "--no-textconv", "HEAD"]);
  for (const writing of [["commit", "-m", "x"], ["add", "-A"], ["checkout", "x"], ["stash", "push"], ["stash", "list"], ["rev-parse", "HEAD"], ["config", "--get", "x"], ["cat-file", "-p", "x"]]) {
    assert.equal(readingArgs(writing), writing, writing.join(" "));
  }
  assert.equal(g.WITHOUT_REPO_PROGRAMS, READ_TOGGLE, "\"stage change\" and the read paths carry ONE set");
});
