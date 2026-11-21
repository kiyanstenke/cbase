// Branch counter-check: the code view of a folder exists on TWO levels - workspace
// (workspaces/routes.js:tailWorkspaceRoutes) and project (devtools/routes.js:codeProjectRoutes). They used to be two
// versions of the SAME thing, 43 branches here and there; this test compared them branch by branch and thereby proved
// the merge. Since then the project level calls the same function (devtools/code-route.js:codeRoute) - and the test
// stays the guard above it, because the CALL still differs (root, wording for a missing root), and exactly there the
// two levels can drift apart again. It also holds that the copies do not return (test 3).
//
// ── TWO ANCHORS, and why one alone is not enough ─────────────────────────────────────────────
// As long as both levels run through the SAME function, a level-against-level comparison is code against itself:
// `done(201, createEntry)` -> `done(200, createEntry)` in code-route.js fails equally on both sides and stays green
// (measured; before the merge the same sabotage was red). With the anchor it is red again, and the message says WHO
// catches it: "38 POST /files/create [Project]: status 200 ≠ anchor 201". So each level is measured first against a
// RECORDED anchor - fixtures/code-scopes/responses.json, shaped like the golden harness (golden-harness.mjs), one
// number smaller. The level comparison stays BESIDE it: it catches an asymmetry the anchor does not see, because both
// could run against the same value.
//
// Re-record (only on explicit request, see the head of the fixture):
//   CBASE_CODE_SCOPES_RECORD=1 CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 \
//     node --test server/backend/test/code-scopes.test.js
// Re-recording means: set the promise "this is how the code view answers" to a new state. The `git diff` of the
// fixture is the reading aid - every line is a behavior difference or a gap of the normalization. A red test is NEVER
// made green by re-recording (snapshots are an alarm, not a lock).
//
// 45 (method, branch) pairs are shared. The language service of the editor (`/lsp/*`, devtools/code-route.js) is NOT a
// shared branch in the sense of this test: the workspace level goes to the server of the project under the file, else
// `no_project` - the two levels answer differently there on purpose; it is measured in lsp-core.test.js and
// language-service-fifo.test.js. Beside them stands `/upload POST` with its own test (test 4): on project level it was
// answered by itemProjectRoutes with a second, substantively equal body, now it is answered by codeRoute, and exactly
// that is measured. `/browser/ensure POST` stands only in codeProjectRoutes (on workspace level it stands BEFORE the
// codeRoute call and is workspace business, with its own profile per scope - hence not comparable).
//
// THE ONE ALLOWED DEVIATION: if the root folder is missing, the project level says "Project path not found" at
// /files/tree, /terminal and /debug/launch, the workspace level "Path not found" (the German wordings of the
// server texts under the German UI language the test runs with). Both wordings are intended and stand in their OWN
// test that pins them individually. In the main run the root exists, so there are ZERO allowed deviations there.
//
// MIRROR BUILD (why the two levels can see the same thing at all):
//   root/a/spiegel  <- path of workspace A                  -> measured as /api/workspaces/<A>
//   root/b          <- path of workspace B (NOT measured)
//   root/b/spiegel  <- path of the project inside            -> measured as /api/projects/<P>
// Two separate folders with the SAME base name ("spiegel"): separate, because otherwise a write branch of one level
// rebuilds the state of the other; same-named, because readGitTree builds the repo name from the base name. The
// project lies in a SUBFOLDER of its workspace - not on its path: wsForPath (workspaces/git-auth.js) finds the
// workspace anyway (`abs.startsWith(ws.path + sep)`), so /git/creds answers equally on both levels - but the ROOT,
// the only parameter in which the two callers differ, becomes measurable: it now carries different content than the
// workspace folder above it (only .mcp.json and this subfolder lie there). Counter-test: with the project ON the
// workspace path, a sabotage that replaces `proj.path` with the workspace path stayed invisible - tests 1, 2 and 4
// stay green, the anchor even fits unchanged, only test 3 turns red, and it reads source text, so it measures
// nothing. With the subfolder test 1 fails at the first branch: "00 GET /git [Project]: body deviates from the
// anchor" (relPath "spiegel" instead of "" - seen from the workspace folder the project is a NESTED repo, and that
// changes the answer).
//
// SEED PER BRANCH: before EVERY branch both roots are deleted and copied anew from ONE template (fs.cpSync with
// preserveTimestamps). So no branch measures the traces of its predecessor, and both levels start byte-equal -
// including git objects, so with identical commit hashes. The template is built with fixed author/committer dates AND
// fixed file timestamps; everything about it is deterministic, also across RUNS (the anchor needs that, the level
// comparison alone does not). What stays in the DB state (git accesses from /git/creds PUT) belongs per level to its
// own workspace and develops mirrored, because every branch is driven on BOTH levels in the same order. The same
// fixed values apply to the SERVER process (see GIT_ENVIRONMENT): the commits during the run are created by the
// route, not the test - and it used to inherit `user.name` from the ~/.gitconfig of THIS Mac.
//
// NORMALIZED is as little as possible; every smoothing stands at its function with its MEASURED reason - what does
// not demonstrably flutter is not smoothed, because every smoothing is a blind spot. Flutter probe: recorded three
// times in a row, the three fixtures `diff` pairwise EMPTY. Each smoothing was switched off singly and the entry that
// then falls was measured; the numbers stand below at the functions and at fixedTimes(). What a probe of three runs
// does NOT see is the slow pace of the calendar - for that stands the smoothing of relative time, measured
// separately. Explicitly unsmoothed stay: ALL commit hashes (also those created during the run - the smoothing for
// that fell away with GIT_ENVIRONMENT, number 2 below says why), the commit DATE (git/show), the sizes of FILES (not
// of FOLDERS - they belong to the file system, see smoothing 5), line numbers and the ZIP bytes.
//
// AND THE GUARD NO MEASUREMENT REPLACES (test 3): a byte-equal copy of a shared branch in a file that runs BEFORE the
// codeRoute call is invisible - it answers the same. So it is excluded at the SOURCE: projects/routes.js and
// workspaces/routes.js may have no intersection with the shared (method, branch) pairs.
//
// Test data (file contents, names, commit messages, the author) stays German on purpose: it is part of the recorded
// anchor in fixtures/code-scopes/responses.json (commit hashes cover content, author and date).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../electron/server/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// `POST /terminal` names the shell - fixed, otherwise the anchor would hang on the login shell of this machine (zsh, bash ...).
process.env.SHELL = "/bin/sh";

// ── The recorded anchor ───────────────────────────────────────────────────────────────────────
const FIXTURE = path.join(here, "fixtures", "code-scopes", "responses.json");
const RECORD = process.env.CBASE_CODE_SCOPES_RECORD === "1";
// Stands as the first key IN the fixture (JSON has no comment) - whoever opens it reads first under which condition it
// may be rewritten. Every re-recording was intended and named; the `git diff` of the fixture is exactly the changed
// entries (new entries are appended at the END: the key carries the position).
const HEADER = [
  "Recorded answers of the shared code branches - the anchor of server/backend/test/code-scopes.test.js.",
  "Per request pair the NORMALIZED answer: status, Content-Type, Content-Disposition, Cache-Control,",
  "X-Content-Type-Options, body.",
  "BOTH levels (project and workspace) are measured against THIS value, and additionally against each other.",
  "",
  "Re-record ONLY if a change in behavior is INTENDED and NAMED:",
  "  CBASE_CODE_SCOPES_RECORD=1 CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 node --test server/backend/test/code-scopes.test.js",
  "Then READ the `git diff` of this file: every line is a behavior difference or a gap of the normalization.",
  "A red test is NEVER made green by re-recording (snapshots are an alarm, not a lock).",
  "",
  "── WHAT THIS RECORDING STAYS BOUND TO ───────────────────────────────────────────────────────────────────",
  "Recorded with git 2.50.1 (Apple Git-155), node v22.17.1 and typescript 5.9.3.",
  "What the test itself pins (GIT_ENVIRONMENT): the git identity, the git dates, the git configuration",
  "(GIT_CONFIG_GLOBAL/-SYSTEM on /dev/null) with the TWO path defaults that switching it off does not cover",
  "(core.excludesFile and core.attributesFile, via GIT_CONFIG_COUNT), plus LC_ALL=C and TZ=UTC - also",
  "for the SERVER process that creates the commits",
  "during the run; the anchor used to carry `user.name` from ~/.gitconfig and was thereby an imprint of ONE Mac.",
  "Pinned likewise: file timestamps (ZIP bytes) and the template. ALL",
  "commit hashes stand unsmoothed, also those created during the run.",
  "What could NOT be pinned, and what a red should therefore check first:",
  "  * git's OWN error and hint texts are passed through (pull, push, rebase, merge) - another git REVISION",
  "    words them differently. A red there is no product failure, but no reason for silent",
  "    re-recording either: first look at WHAT changed. The LANGUAGE is fixed with LC_ALL=C, but",
  "    this could not be proven here: this Apple git ships no translations.",
  "  * The commit hashes presuppose git's object format (SHA-1). A repo format with SHA-256 would rewrite them.",
  "  * `42 POST /debug/launch` depends on a module (answers available:true only with an installed `ws`).",
  "  * `43 POST /terminal` depends on node-pty, and that is a NATIVE module (pty.node, built for the ABI,",
  "    platform and architecture of this machine). If it drops out, the branch answers 200 {available:false}",
  "    instead of 201 - measured by renaming pty.node. A red there means: check `npm rebuild` first.",
  "",
  "── WHAT THIS ANCHOR DOES NOT HOLD (measured by the skeptic, not assumed) ─────────────────────────────────",
  "  (a) One payload per branch, the options of the branches are never varied (no `regex`, no `staged`,",
  "      no `push`, no `type:\"dir\"`).",
  "  (b) `42 POST /debug/launch` answers {id, available}, `43 POST /terminal` {id, shell, available} - the shell",
  "      is fixed to /bin/sh (process.env.SHELL in the test), otherwise the anchor would hang on the login shell of the machine.",
  "  (c) The smoothing of the relative time keeps only the language family",
  "      (a complete replacement of the own renderer relativeDe stayed green).",
];

// ── The shared branch list ────────────────────────────────────────────────────────────────────
// [method, path (with query), body?, smoothings?]. The path without query IS the branch name; the guard further down
// holds this list against the two source files. Several entries may point to the same branch (e.g. /git/creds PUT
// complete and incomplete) - every entry is checked individually, and the key in the fixture therefore carries the
// number in front.
const TS_CONTENT = "export const count: number = 41;\nexport function plus(a: number) { return a + count; }\n";

// Placeholders that stand only with the template (commit hashes, the patch text).
const S = { seed: "", extra: "", patch: "" };

const branches = () => [
  ["GET", "/git"],
  ["GET", "/git/branches?repo="],
  ["GET", "/git/creds"],
  ["PUT", "/git/creds", { host: "gitlab.example", username: "u", secret: "s" }],
  ["PUT", "/git/creds", { host: "gitlab.example", username: "u" }], // missing field -> 400 with its wording
  ["DELETE", "/git/creds?host=gitlab.example"],
  ["POST", "/git/commit", { message: "Zweiter", all: true }],
  ["POST", "/git/stage", { files: ["README.md"] }],
  ["POST", "/git/unstage", { all: true }],
  ["POST", "/git/discard", { file: "README.md" }],
  ["POST", "/git/diff", { file: "README.md" }],
  ["POST", "/git/pull", {}],
  ["POST", "/git/fetch", {}],
  ["POST", "/git/apply", { patch: S.patch }],
  ["GET", "/git/stashes?repo="],
  ["POST", "/git/stash", { message: "way", includeUntracked: true }],
  ["POST", "/git/stash/op", { op: "pop", ref: "stash@{0}" }],
  ["POST", "/git/stash/show", { ref: "stash@{0}" }],
  ["POST", "/git/merge", { branch: "extra" }],
  ["POST", "/git/rebase", { branch: "extra" }],
  ["POST", "/git/merge-abort", {}],
  ["POST", "/git/blame", { file: "README.md" }],
  ["POST", "/git/log", { limit: 5 }],
  ["POST", "/git/show", { hash: S.seed }],
  ["POST", "/git/cherry-pick", { hash: S.extra }],
  ["GET", "/git/worktrees?repo="],
  ["POST", "/git/worktree", { path: "wt", newBranch: "branch" }],
  ["DELETE", "/git/worktree?path=wt"],
  ["GET", "/git/submodules?repo="],
  ["POST", "/git/submodule/update", {}],
  ["POST", "/git/push", {}],
  ["POST", "/git/checkout", { branch: "fresh", create: true }],
  ["GET", "/files/tree"],
  ["GET", "/files/tree?path=code"],
  ["GET", "/files/read?path=README.md"],
  ["GET", "/files/download?path=README.md"],
  ["GET", "/files/download?path=code"], // folder -> ZIP; the bytes are compared too
  ["PUT", "/files/write", { path: "fresh.txt", content: "content" }],
  ["POST", "/files/create", { path: "fresh.txt", type: "file" }],
  ["POST", "/files/rename", { from: "notiz.txt", to: "note2.txt" }],
  ["DELETE", "/files?path=notiz.txt"],
  ["POST", "/files/search", { query: "const" }],
  ["POST", "/debug/launch", { file: "code/app.ts" }, ["session"]],
  ["POST", "/terminal", { cols: 80, rows: 24 }, ["session"]],
  // Quick open of the code tabs in chat: files by NAME. Appended at the END - the key of the fixture carries the
  // position, an insert in the middle would have renamed every following entry.
  ["POST", "/files/find", { query: "app" }],
  // Explorer like VS Code: copy (file, folder, existing target => 409 TARGET_EXISTS) and the ignored paths per repo.
  // Also appended at the END (see above).
  ["POST", "/files/copy", { from: "notiz.txt", to: "notiz copy.txt" }],
  ["POST", "/files/copy", { from: "code", to: "code copy" }],
  ["POST", "/files/copy", { from: "notiz.txt", to: "README.md" }],
  ["GET", "/git/ignored"],
  // Quick-diff peek: ONE block into the index - the appended line "Geaendert." of the README (index: four lines, the
  // last empty). Appended at the END (see above). With `baseSha` = sha256 of the index text "# Spiegel\\n\\nEine Zeile.\\n"
  // - a body without it is 400; the fixture row (200) stays byte-equal.
  ["POST", "/git/stage-block", { file: "README.md", from: 3, until: 3, old: [], rows: ["Geaendert."], rowCount: 4, lineEnding: "\n",
    baseSha: "dc293d5350bdc6a603683c0efd00da0c51e9b71ca1e927078fd183769fe498ab" }],
];

// The four body shapes of the /upload test (test 4) - up here because, like the branch list, they point into the
// fixture and their order thus forms the key.
const UPLOADS = () => [
  { dir: "code", files: [{ path: "fresh.txt", dataB64: Buffer.from("hallo", "utf8").toString("base64") }] },
  { dir: "", files: [{ path: "deep/a.txt", dataB64: "eA==" }] },
  { dir: "nonexistent", files: [{ path: "a.txt", dataB64: "eA==" }] },
  { dir: "", files: [{ path: "../escape.txt", dataB64: "eA==" }] },
];

// ── Template: a small, fully deterministic working directory ───────────────────────────────────
// Fixed author/committer dates and switched-off user/system configuration: the commit hash of the template is thus
// fixed and the same in BOTH copies - and equal across runs, so it stays UNSMOOTHED in the fixture. That is the most
// valuable part of the anchor: a hash covers content, tree, author and date of a commit in one field.
const FESTE_TIME = new Date("2026-01-02T03:04:05Z");

// The same fixed values for EVERY git call of this test run - also for those issued not by the test but by the
// SERVER process. That is no cosmetics but the difference between an anchor and an imprint of THIS Mac. Measured:
// `06 POST /git/commit` carried the author from `user.name` in ~/.gitconfig, because the commit during the run is
// created by the route, not by buildTemplate; with another GIT_AUTHOR_NAME the entry fell from character 295, with a
// foreign GIT_CONFIG_GLOBAL (core.excludesfile=*.txt) already the FIRST branch (`notiz.txt` vanished from the status).
// On any other machine the anchor would have been red - and an anchor that is redrawn the first time is none.
// GIT_CONFIG_SYSTEM/-GLOBAL on /dev/null: not only name and mail decide, but every setting that colors output or
// behavior (core.excludesfile, core.autocrlf, init.defaultBranch, color.ui, diff.*, merge.*) - a whitelist of single
// keys would be guessed, switching off is measured. The fixed DATES come along so that a commit created during the
// run is determined too; smoothing 2 below says why no smoothing is needed for it.
const GIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: "Testerin", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Testerin", GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00", GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  // Several branches pass git's OWN messages through (pull, push, rebase, merge) - those are translatable. NOT provable
  // on this machine: the Apple git 2.50.1 ships no translations (measured: `LC_ALL=de_DE.UTF-8 LANGUAGE=de git pull`
  // answers in English word for word like under C). The line is therefore a no-op here - the fixture stayed byte-equal
  // after re-recording -, but on a git WITH NLS (most Linux distributions) the difference between an anchor and a
  // statement about the language setting of the machine. It is set only in the `before` hook, long after node
  // started: ICU and Intl of the test process are untouched, it hits only the git children.
  LC_ALL: "C",
  // Two gaps that `GIT_CONFIG_GLOBAL=/dev/null` does NOT cover (measured): `core.excludesFile` and
  // `core.attributesFile` have a PATH DEFAULT ($XDG_CONFIG_HOME/git/ignore or $HOME/.config/git/{ignore,attributes}).
  // That is no configuration value, so switching off the configuration files does not switch it off. Measured, both
  // with a foreign HOME: `*.txt` in the ignore file drops notiz.txt from the status (red at "00 GET /git", anchor 523
  // characters against 429), and `*.ts text eol=crlf` in the attributes file makes help.ts one byte larger on
  // checkout - which strikes through to a pure FILE-SYSTEM response (red at "33 GET /files/tree", size 27 against 28).
  // The way against it is git's own configuration-from-the-environment; it lies in `process.env` and thus reaches the
  // git children of the server exactly like the rest of this block.
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.attributesFile", GIT_CONFIG_VALUE_1: "/dev/null",
  // The ZIP bytes are a function of the process TIMEZONE: `zip.js:dosTime` computes with the LOCAL-time getters
  // (`getHours`, `getMonth`, ...) - right for the DOS time field of a ZIP, but it makes the bytes location-dependent.
  // The template pins the mtime absolutely (FESTE_TIME), its REPRESENTATION in the local field it does not. Measured:
  // `TZ=UTC` (the zone of every CI runner) => red at "36 GET /files/download?path=code", byte 0x20 against 0x18;
  // without this line the anchor would be an imprint of Europe/Berlin and red on the FIRST foreign run. UTC, because a
  // zone MUST be chosen and this is the only one that belongs to nobody.
  TZ: "UTC",
};
// Set in `process.env`, because the server starts its git children with `{...process.env}` (git.js) - a parameter
// does not lead there. Hence also the cleanup: a test run that hands another file a changed environment would be
// exactly the kind of action at a distance this test stands against.
let gitEnvironmentBack = null;
before(() => {
  const old = {};
  for (const [k, v] of Object.entries(GIT_ENVIRONMENT)) { old[k] = process.env[k]; process.env[k] = v; }
  gitEnvironmentBack = () => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
});
after(() => { gitEnvironmentBack?.(); gitEnvironmentBack = null; });

function buildTemplate(template) {
  // `before` has long put the values into process.env; they stand here once more explicitly so the template is
  // determined even if someone calls buildTemplate alone.
  const env = { ...process.env, ...GIT_ENVIRONMENT };
  const g = (...args) => execFileSync("git", args, { cwd: template, encoding: "utf8", env });

  fs.mkdirSync(path.join(template, "code"), { recursive: true });
  fs.writeFileSync(path.join(template, "README.md"), "# Spiegel\n\nEine Zeile.\n");
  fs.writeFileSync(path.join(template, "code/app.ts"), TS_CONTENT);
  fs.writeFileSync(path.join(template, "code/help.ts"), "export const help = \"da\";\n");
  g("init", "-q", "-b", "main");
  g("add", "-A"); g("commit", "-q", "-m", "Saat");
  S.seed = g("rev-parse", "HEAD").trim();
  // A second branch with a commit of its own - so merge, rebase and cherry-pick do not stick at an input check but
  // really reach git.
  g("checkout", "-q", "-b", "extra");
  fs.writeFileSync(path.join(template, "extra.md"), "Nur im Zweig.\n");
  g("add", "-A"); g("commit", "-q", "-m", "Extra");
  S.extra = g("rev-parse", "HEAD").trim();
  g("checkout", "-q", "main");
  // A stash on a file that is NOT touched afterwards: /git/stash/op pop thereby runs conflict-free and deterministic.
  fs.appendFileSync(path.join(template, "code/help.ts"), "// beiseite\n");
  g("stash", "push", "-q", "-m", "aside");
  fs.appendFileSync(path.join(template, "README.md"), "Geaendert.\n"); // unstaged change
  S.patch = g("diff", "--", "README.md");                            // real patch for /git/apply
  fs.writeFileSync(path.join(template, "notiz.txt"), "frei herumliegend\n"); // untracked
  fs.mkdirSync(path.join(template, "empty"));
  festeTimes(template);
}

// Fixed timestamps on everything except `.git`: the folder download packs the mtime of EVERY entry into the ZIP bytes
// (zip.js:dosTime), and cpSync(preserveTimestamps) carries them into both mirrors. That is DETERMINACY AT THE
// SOURCE, no smoothing - smoothed, the whole ZIP body would be a blind spot. Measured (two recordings without this
// step): exactly ONE entry deviates, "36 GET /files/download?path=code", from byte 10 of 357 - the DOS date in the
// local header; all other 55 entries stay equal. `.git` stays out: only git itself reads there, and no answer holds
// its bytes.
function festeTimes(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) festeTimes(abs);
    else fs.utimesSync(abs, FESTE_TIME, FESTE_TIME);
  }
  fs.utimesSync(dir, FESTE_TIME, FESTE_TIME);
}

// ── Server + two mirrored roots ───────────────────────────────────────────────────────────────
async function withSpiegel(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-scopes-"));
  let server;
  try {
    const template = path.join(root, "template");
    const wsRoot = path.join(root, "a", "spiegel");   // workspace level: the workspace path itself
    const wsBFolder = path.join(root, "b");             // workspace of the project - NOT measured
    const projRoot = path.join(root, "b", "spiegel"); // project level: a subfolder in it
    fs.mkdirSync(template, { recursive: true });
    buildTemplate(template);
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.mkdirSync(wsBFolder, { recursive: true });

    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = (u, b) => fetch(base + u, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    }).then((r) => r.json());

    const wsA = await create("/api/workspaces", { name: "A", path: wsRoot });
    const wsB = await create("/api/workspaces", { name: "B", path: wsBFolder });
    // Creating a workspace puts a .mcp.json with ITS id and absolute paths into the folder. On the workspace level it
    // lies IN the measured root - it must go, otherwise the two mirrors would be unequal from the start. At the
    // workspace of the project it stays: it stands one level ABOVE the measured root and gives the workspace folder
    // exactly the different content at which a swapped root gets caught.
    fs.rmSync(wsRoot, { recursive: true, force: true }); fs.mkdirSync(wsRoot);
    // The project is created in an EMPTY folder (which incidentally prevents the service scan).
    fs.mkdirSync(projRoot, { recursive: true });
    const proj = await create(`/api/workspaces/${wsB.id}/projects`, { name: "spiegel", path: projRoot });

    const seed = () => {
      for (const d of [wsRoot, projRoot]) {
        fs.rmSync(d, { recursive: true, force: true });
        // preserveTimestamps: otherwise the two copies would get different mtimes, and a folder download (ZIP)
        // carries the mtime of every entry in its bytes.
        fs.cpSync(template, d, { recursive: true, preserveTimestamps: true });
      }
    };
    seed();

    await run({
      base, root, seed,
      wsRoot, projRoot, wsBFolder,
      project: `/api/projects/${proj.id}`,
      workspace: `/api/workspaces/${wsA.id}`,
    });
  } finally {
    // Open connections first: otherwise server.close() waits for every single one and turns a failure into a hang
    // without a word.
    try { server?.closeAllConnections?.(); } catch { /* whatever */ }
    if (server) await new Promise((resolve) => server.close(resolve));
    // A test must not fail on cleanup (ENOTEMPTY from children still writing) - but it is not concealed either,
    // otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
}

// Send a request. The body comes back as latin1 so that ZIP bytes are comparable too, without invalid UTF-8 being
// flattened on the way.
async function question(base, scope, [m, filePath, body]) {
  const opt = { method: m };
  if (body !== undefined) {
    opt.headers = { "Content-Type": "application/json" };
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(base + scope + filePath, opt);
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get("content-type") || "",
    attachment: res.headers.get("content-disposition") || "",
    // Cache-Control and X-Content-Type-Options belong to the ANSWER, not to decoration: both could fall out of
    // runtime/http.js:serveDownload without anything turning red (measured). A cache header WITHOUT `private` once
    // made a route public at the Cloudflare edge (cf-cache-status HIT without a session cookie). They are recorded
    // for EVERY branch, not only for the download: a header that appears NEWLY somewhere is the same statement as one
    // that vanishes, and "empty" is a value here, not a missing field.
    cache: res.headers.get("cache-control") || "",
    nosniff: res.headers.get("x-content-type-options") || "",
    body: bytes.toString("latin1"),
  };
}

// ── Smoothings. There are FOUR, and each has its measured reason. The numbers stay as they were: number 2 fell away,
//    and the gap carries the reasoning. The placeholders (<ROOT> ...) are part of the recorded anchor: renaming one means renaming it there too. ────
// 1. The root itself: readGitTree and the worktree list return the ABSOLUTE folder path. Exactly this path is the
//    difference between the two levels - it is the question, not the answer. And across runs it wanders anyway
//    (mkdtemp). Only the two measured roots are replaced (and their realpath form, because /var on macOS is a link to
//    /private/var), nothing else - the folder of the workspace above explicitly NOT: if it appears in an answer, the
//    root is swapped, and that should shout. Measured: without it "00 GET /git" already fails from character 129 (the
//    absolute repo path in the tree).
//    TWO placeholders, not one: smoothing is done from the view of the MEASURED level - its own root becomes
//    "<ROOT>", that of the sister level "<FOREIGN ROOT>". In the healthy case both answers hold "<ROOT>", so the
//    level comparison stays possible; but if a level reaches for the root of the other, the betrayal stands at the PATH
//    itself. Counter-test (sabotage `proj.path.replace("/b/", "/a/")` in codeProjectRoutes): with TWO placeholders the
//    first affected branch fails, "00 GET /git [Project]: body deviates from the anchor", and the message shows
//    `"root":"<FOREIGN ROOT>"` - the cause stands there. With ONE placeholder both views collapsed into the same text,
//    and the same betrayal showed only six entries later through a side effect: "06 POST /git/commit [Workspace]:
//    status 400 ≠ anchor 200", because then both levels commit into the same folder and the second finds nothing to
//    commit - a message that points everywhere except at the cause.
function withoutRoot(text, own, foreign) {
  let t = text;
  for (const w of foreign) t = t.split(w).join("<FOREIGN ROOT>");
  for (const w of own) t = t.split(w).join("<ROOT>");
  return t;
}
// 2. REMOVED - this says why, so nobody rebuilds it out of caution. It replaced the SHA of the two branches that
//    CREATE a commit during the run (commit, cherry-pick) with "<FRESH>". Its reason was the clock: the SHA carries
//    the second of creation, the two levels committed milliseconds apart and between two RUNS it was always different
//    (measured: "24 POST /git/cherry-pick" fell from character 435 already WITHIN a run). That reason is gone with
//    GIT_ENVIRONMENT: since the SERVER process also works with fixed GIT_AUTHOR_DATE and GIT_COMMITTER_DATE, nothing
//    temporal hangs on the commit - tree, parents, message, author, committer and both dates are fixed, so the SHA is
//    fixed. Not statistically but by construction; the probe confirms it (three recordings in a row without the
//    smoothing, pairwise `diff` EMPTY). And a smoothing without a reason is only a blind spot: the two hashes now cover
//    content, tree, parents, author and date in ONE field each - exactly like those of the template, which stood
//    unsmoothed from the start.
// 3. Terminal and debug sessions get a random UUID (crypto.randomUUID). Only for these two branches, and only at the
//    id field. Measured: without it "42 POST /debug/launch" fails from character 8 - the UUID stands right behind
//    `{"id":"`.
const withoutSessionId = (t) => t.replace(/"id":"[0-9a-f-]{36}"/g, '"id":"<SESSION>"');
// 4. Relative times compute against the WALL CLOCK, not against the (fixed) commit date: without this smoothing the
//    fixture would turn red by itself on some future day without a line having changed - a flutter probe of three
//    runs in a row does NOT see that. Measured: two templates with the same content, the commit date shifted by a
//    month (the same as a clock running on by a month) => "vor 8 Mon." becomes "vor 9 Mon." and "9 months ago"
//    becomes "10 months ago"; 15 of the 52 branches are affected. The LANGUAGE FAMILY stays in the placeholder,
//    because it is a statement about the product: tree, blame, stash list and log render German (git.js:relativeDe).
//    Stash list and log used to pass git's own %cr through - English depending on locale and gettext build, always in
//    the project container ("29 minutes ago" above "vor 28 Min." in the same bar); since then %ct + relativeDe, the
//    anchor stands on <RELATIVE de>. A <RELATIVE en> in the anchor would mean: a read path passes git's wording through
//    again. The calendar day of the commit itself stands unsmoothed in "23 POST /git/show".
const withoutRelativeTime = (t) => t.replace(/"relative":"([^"]*)"/g, (_, v) => `"relative":"<RELATIVE ${/ago$/.test(v) ? "en" : "de"}>"`);
// 5. The SIZE of a DIRECTORY belongs to the FILE SYSTEM, not to the product: APFS reports 128 for the folder `code`
//    and 64 bytes for the empty one, ext4 4096 for both. Measured on the CI runner: "32 GET /files/tree [Project]:
//    body deviates from the anchor - from character 72 (anchor 378, measured 381 characters)", "size":128 against 4096
//    - the only red entry of this suite there, and it says nothing about cbase. The size of a FILE stays unsmoothed:
//    it is the content this test writes itself (18, 34, 85, 27 bytes), and the proof hangs on it that no foreign
//    attributes file bends the line endings (see GIT_CONFIG_COUNT - the same sabotage made `size` 27 into 28 back
//    then). Bound to the FIELD ORDER of listDir (files.js - name, path, type, size, symlink, heavy): if anything else
//    stands between `type` and `size`, the smoothing no longer applies and the branch turns red. That is the right
//    direction - only what really is the folder size is smoothed.
const withoutFolderSize = (t) => t.replace(/"type":"dir","size":\d+/g, '"type":"dir","size":"<FOLDER>"');

function smooth(text, { own, foreign }, which = []) {
  let t = withoutFolderSize(withoutRelativeTime(withoutRoot(text, own, foreign)));
  if (which.includes("session")) t = withoutSessionId(t);
  return t;
}

// The two views of the same two roots - one per level. `realpathSync` comes along because /var on macOS is a link to
// /private/var and some answers carry the resolved form; longest first, otherwise a prefix eats the rest.
function rootViews(wsRoot, projRoot) {
  const both = (p) => [p, fs.realpathSync(p)].sort((a, b) => b.length - a.length);
  const ws = both(wsRoot);
  const proj = both(projRoot);
  return { Project: { own: proj, foreign: ws }, Workspace: { own: ws, foreign: proj } };
}

// End terminal/debug sessions right away: otherwise they keep a child process (PTY or `node --inspect-brk`) open, and
// a running child keeps the event loop of the test process alive.
async function endSession(base, response) {
  let id = "";
  try { id = JSON.parse(response.body)?.id || ""; } catch { /* no JSON, no session */ }
  if (!/^[0-9a-f-]{36}$/.test(id)) return;
  await fetch(`${base}/api/terminal/${id}`, { method: "DELETE" }).catch(() => {});
  await fetch(`${base}/api/debug/${id}`, { method: "DELETE" }).catch(() => {});
}

// ── Read, write, compare the fixture ──────────────────────────────────────────────────────────
// Two sections, one per test ("branches", "upload"); writing merges with what is read, so a run with only one of the
// two tests does not throw away the other section.
function loadFixture() {
  try { return JSON.parse(fs.readFileSync(FIXTURE, "utf8")); } catch { return null; }
}
function writeSection(name, data) {
  const old = loadFixture() || {};
  const fresh = { _header: HEADER, branches: old.branches || {}, upload: old.upload || {}, [name]: data };
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify({ _header: fresh._header, branches: fresh.branches, upload: fresh.upload }, null, 2) + "\n");
}
// First deviating spot of two bodies - a message that SHOWS the difference: position and 60 characters of context on
// both sides. A ZIP body is over 700 characters long; printing its beginning twice said nothing (the same lesson as in
// the golden gate).
function deviation(desired, holds) {
  let i = 0;
  while (i < desired.length && i < holds.length && desired[i] === holds[i]) i += 1;
  const window = (s) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
  return `from character ${i + 1} (anchor ${desired.length}, measured ${holds.length} characters)\n    anchor:   ${window(desired)}\n    measured: ${window(holds)}`;
}
// One level against the anchor. Four fields individually, so the message says WHICH deviates.
function againstAnchor(desired, holds, where, level) {
  assert.ok(desired, `${where}: the entry is missing in the anchor - fixture outdated? (re-record only deliberately, see head)`);
  assert.equal(holds.status, desired.status, `${where} [${level}]: status ${holds.status} ≠ anchor ${desired.status}`);
  assert.equal(holds.type, desired.type, `${where} [${level}]: Content-Type "${holds.type}" ≠ anchor "${desired.type}"`);
  assert.equal(holds.attachment, desired.attachment, `${where} [${level}]: Content-Disposition "${holds.attachment}" ≠ anchor "${desired.attachment}"`);
  assert.equal(holds.cache, desired.cache, `${where} [${level}]: Cache-Control "${holds.cache}" ≠ anchor "${desired.cache}"`);
  assert.equal(holds.nosniff, desired.nosniff, `${where} [${level}]: X-Content-Type-Options "${holds.nosniff}" ≠ anchor "${desired.nosniff}"`);
  if (holds.body !== desired.body) assert.fail(`${where} [${level}]: body deviates from the anchor - ${deviation(desired.body, holds.body)}`);
}

test("every shared branch answers as recorded - and equally on both levels", async () => {
  await withSpiegel(async ({ base, seed, wsRoot, projRoot, project, workspace }) => {
    const view = rootViews(wsRoot, projRoot);
    const list = branches();
    const anchor = RECORD ? {} : (loadFixture()?.branches || null);
    assert.ok(anchor, "fixtures/code-scopes/responses.json is missing or has no section \"branches\" - CBASE_CODE_SCOPES_RECORD=1 records");
    const capture = {};
    let checked = 0;

    for (const [i, branch] of list.entries()) {
      const [m, filePath, , which = [], truncation = null] = branch;
      seed(); // both levels start byte-equal into this one branch
      const p = await question(base, project, branch);
      const w = await question(base, workspace, branch);
      await endSession(base, p);
      await endSession(base, w);

      const where = `${String(i).padStart(2, "0")} ${m} ${filePath}`;
      const fixed = (a, level) => ({
        status: a.status, type: a.type, attachment: a.attachment, cache: a.cache, nosniff: a.nosniff,
        body: smooth(a.body, view[level], which),
      });
      const pn = fixed(p, "Project");
      const wn = fixed(w, "Workspace");
      // Truncated ONLY for the anchor, and only where a truncation is registered (see the fifth column of the branch
      // list; currently none). The level comparison below keeps running on pn/wn, i.e. on the full body.
      const forAnchor = (x) => (truncation ? { ...x, body: truncation(x.body) } : x);

      // 1. Each level against the RECORDED anchor. The project level is recorded; the workspace level is measured
      //    against the same value - if they drift apart, one falls here and the level comparison below.
      if (RECORD) capture[where] = forAnchor(pn);
      else {
        againstAnchor(anchor[where], forAnchor(pn), where, "Project");
        againstAnchor(anchor[where], forAnchor(wn), where, "Workspace");
      }

      // 2. And the levels against each other - the anchor does not see an asymmetry if both levels could run against
      //    the same value; this comparison does.
      assert.equal(pn.status, wn.status, `${where}: status project ${pn.status} ≠ workspace ${wn.status}`);
      assert.equal(pn.type, wn.type, `${where}: Content-Type differs`);
      assert.equal(pn.attachment, wn.attachment, `${where}: Content-Disposition differs`);
      assert.equal(pn.cache, wn.cache, `${where}: Cache-Control differs (project "${pn.cache}", workspace "${wn.cache}")`);
      assert.equal(pn.nosniff, wn.nosniff, `${where}: X-Content-Type-Options differs (project "${pn.nosniff}", workspace "${wn.nosniff}")`);
      if (pn.body !== wn.body) assert.fail(`${where}: body differs - ${deviation(wn.body, pn.body)}`);
      checked++;
    }

    if (RECORD) { writeSection("branches", capture); console.warn(`[code-scopes] anchor rewritten: ${Object.keys(capture).length} branches -> ${FIXTURE}`); }

    // The number stands here so that a silent shrinking of the list is noticed. A branch that is missing entirely
    // turns red only in the coverage guard below - this comparison only says that the loop really drove everything
    // that stands in the list.
    assert.equal(checked, list.length, "not every entry of the list was driven");
    assert.equal(checked, 50, `branch list is ${checked} entries long, expected 50`);
    // And the anchor covers exactly this list: one entry too many means a branch fell out of the list without anyone
    // following up the fixture.
    if (!RECORD) {
      assert.equal(Object.keys(anchor).length, list.length,
        `the anchor carries ${Object.keys(anchor).length} entries, the list ${list.length} - fixture and list drift apart`);
    }
  });
});

test("if the root is missing, the project level says \"Project path not found\" and the workspace level \"Path not found\"", async () => {
  // The ONLY allowed deviation of the two levels. It survived the rebuild: the wording is a parameter of codeRoute
  // (`opts.notFound`), no common denominator.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-scopes-missing-"));
  let server;
  try {
    const wsRoot = path.join(root, "a", "way");
    const wsBFolder = path.join(root, "b");
    const projRoot = path.join(root, "b", "way"); // as above: subfolder of its workspace
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.mkdirSync(wsBFolder, { recursive: true });
    server = await startServer({
      port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"),
      pickDirectory: null, notify: null,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const create = (u, b) => fetch(base + u, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    }).then((r) => r.json());
    const wsA = await create("/api/workspaces", { name: "A", path: wsRoot });
    const wsB = await create("/api/workspaces", { name: "B", path: wsBFolder });
    fs.mkdirSync(projRoot, { recursive: true });
    const proj = await create(`/api/workspaces/${wsB.id}/projects`, { name: "way", path: projRoot });
    // Now the test pulls the folder out from under both levels.
    for (const d of [wsRoot, projRoot]) fs.rmSync(d, { recursive: true, force: true });

    for (const branch of [
      ["GET", "/files/tree"],
      ["POST", "/terminal", { cols: 80, rows: 24 }],
      ["POST", "/debug/launch", { file: "app.js" }],
    ]) {
      const where = `${branch[0]} ${branch[1]}`;
      const p = await question(base, `/api/projects/${proj.id}`, branch);
      const w = await question(base, `/api/workspaces/${wsA.id}`, branch);
      assert.equal(p.status, 400, `${where}: project level answers ${p.status}`);
      assert.equal(w.status, 400, `${where}: workspace level answers ${w.status}`);
      assert.deepEqual(JSON.parse(p.body), { error: "Projekt-Pfad nicht gefunden" }, `${where}: project wording`);
      assert.deepEqual(JSON.parse(w.body), { error: "Pfad nicht gefunden" }, `${where}: workspace wording`);
    }
  } finally {
    try { server?.closeAllConnections?.(); } catch { /* whatever */ }
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("the branch list covers exactly the shared branches of the ONE version", () => {
  // Without this guard an omitted branch would not be red, only unnoticed less checking. The sources themselves are
  // read - comments removed first, otherwise an example in running text counts as a branch.
  const read = (rel) => fs.readFileSync(path.join(here, "..", "electron", "server", rel), "utf8")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const pairs = (source) => {
    const out = new Set();
    for (const [, s, m] of source.matchAll(/sub === "([^"]+)" && m === "([A-Z]+)"/g)) out.add(`${m} ${s}`);
    return out;
  };
  const routes = read("devtools/routes.js");
  const from = routes.indexOf("export async function codeProjectRoutes");
  assert.notEqual(from, -1, "codeProjectRoutes not found - was the function renamed?");
  const until = routes.indexOf("\nexport async function", from + 10);
  const projectSource = routes.slice(from, until === -1 ? undefined : until);

  // The project level delegates. A body of its own there would be the relapse into exactly the state this test once
  // measured; `/browser/ensure` is the only line that belongs there (profile per project - codeRoute knows only one
  // folder).
  assert.deepEqual([...pairs(projectSource)].sort(), ["POST /browser/ensure"], "codeProjectRoutes carries branches of its own again");
  assert.match(projectSource, /await codeRoute\(proj\.path, sub, m, req, res, url,/, "codeProjectRoutes no longer calls codeRoute");
  // The own wording of the project level goes along as a parameter - the test for it stands above.
  assert.match(projectSource, /notFound:/, "codeProjectRoutes no longer passes its not-found wording");
  const fromRoute = pairs(read("devtools/code-route.js"));

  // ── The guard against the invisible copy ─────────────────────────────────────────────────────
  // A BYTE-EQUAL copy of a shared branch in a file that runs BEFORE the codeRoute call is visible to no measurement:
  // it answers the branch, its answer is the same, anchor and level comparison stay green. Measured: a `/files/read`
  // branch with the same arguments in projects/routes.js:itemProjectRoutes - 4/4 GREEN. Exactly the state the whole
  // rebuild was built against, and the only place where it shows is the SOURCE. Two files lie on this path:
  // itemProjectRoutes (before codeProjectRoutes) and tailWorkspaceRoutes (the call stands there at the end of its own
  // branches). So the empty intersection with the shared pairs is required of BOTH - /upload included, in which the
  // single case that used to stand here ("itemProjectRoutes carries an own /upload copy again") is absorbed. Today:
  // projects/routes.js has 26 pairs of its own, workspaces/routes.js 13 (among them `POST /browser/ensure` - known and
  // NOT a shared branch: the browser profile hangs on the scope, codeRoute knows only one folder), the intersection
  // empty both times.
  for (const file of ["projects/routes.js", "workspaces/routes.js"]) {
    const duplicate = [...pairs(read(file))].filter((k) => fromRoute.has(k)).sort();
    assert.deepEqual(duplicate, [],
      `${file} answers shared branches itself: ${duplicate.join(", ")} - a copy BEFORE the codeRoute call `
      + "hides the common version without anchor or level comparison being able to see it");
  }

  assert.ok(fromRoute.has("POST /upload"), "/upload is missing in codeRoute");
  // 45 shared pairs. /upload stands beside them (test 4), because it takes different ways up to here on the two
  // levels; `/lsp/*` is no `sub ===` branch (head).
  const shared = [...fromRoute].filter((k) => k !== "POST /upload").sort();
  assert.equal(shared.length, 45, `shared branches: ${shared.length}, expected 45`);

  const covered = [...new Set(branches().map(([m, pathValue]) => `${m} ${pathValue.split("?")[0]}`))].sort();
  assert.deepEqual(covered, shared, "branch list and source drift apart");
});

test("/upload delivers as recorded - and the same on both levels, from ONE function", async () => {
  // Not part of the 45, because the way there differs: on workspace level tailWorkspaceRoutes catches the branch, on
  // project level it used to run through its own copy in itemProjectRoutes and now through codeProjectRoutes ->
  // codeRoute. A promise, so measure it too - the test is older than the merge and survived it unchanged.
  await withSpiegel(async ({ base, seed: seedValue, wsRoot, projRoot, project: projectValue, workspace }) => {
    const viewValue = rootViews(wsRoot, projRoot);
    const forms = UPLOADS();
    const anchor = RECORD ? {} : (loadFixture()?.upload || null);
    assert.ok(anchor, "fixtures/code-scopes/responses.json is missing or has no section \"upload\" - CBASE_CODE_SCOPES_RECORD=1 records");
    const captureValue = {};

    for (const [i, bodyValue] of forms.entries()) {
      seedValue();
      const branchValue = ["POST", "/upload", bodyValue];
      const p = await question(base, projectValue, branchValue);
      const w = await question(base, workspace, branchValue);
      const where = `${String(i).padStart(2, "0")} POST /upload dir=${JSON.stringify(bodyValue.dir)}`;
      const fest = (a, levelValue) => ({
        status: a.status, type: a.type, attachment: a.attachment, cache: a.cache, nosniff: a.nosniff,
        body: smooth(a.body, viewValue[levelValue]),
      });
      const pn = fest(p, "Project");
      const wn = fest(w, "Workspace");

      if (RECORD) captureValue[where] = pn;
      else {
        againstAnchor(anchor[where], pn, where, "Project");
        againstAnchor(anchor[where], wn, where, "Workspace");
      }
      assert.equal(pn.status, wn.status, `${where}: status project ${pn.status} ≠ workspace ${wn.status}`);
      if (pn.body !== wn.body) assert.fail(`${where}: body differs - ${deviation(wn.body, pn.body)}`);
    }

    if (RECORD) { writeSection("upload", captureValue); console.warn(`[code-scopes] anchor rewritten: ${Object.keys(captureValue).length} /upload shapes -> ${FIXTURE}`); }
    else assert.equal(Object.keys(anchor).length, forms.length,
      `the anchor carries ${Object.keys(anchor).length} /upload entries, the test ${forms.length}`);
  });
});

// ── A dead symlink is an entry ─────────────────────────────────────────────────────────────────
// deleteEntry asked `existsSync` without a boundary - that follows the symlink, and a dead symlink "did not exist":
// the code view showed it (lstat) and could not delete it. Since then `lstat`: the symlink itself is removed (rmSync
// follows no symlink), never its target. With a boundary it was already so (removeInArea). Counter-test: files.js
// with `existsSync` again => red ("Not found" - the server text, German under the German UI language).
test("deleteEntry removes a dead symlink - without and with boundary; what does not exist is \"Not found\" on both ways", async () => {
  const { deleteEntry } = await import("../electron/server/files.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-nb14-")));
  try {
    for (const [variant, opts] of [["without boundary", {}], ["with boundary", { limitValue: () => [root] }]]) {
      fs.symlinkSync(path.join(root, "missing"), path.join(root, "dead"));
      assert.deepEqual(deleteEntry(root, "dead", opts), { ok: true }, variant);
      assert.throws(() => fs.lstatSync(path.join(root, "dead")), { code: "ENOENT" }, `${variant}: the symlink still stands`);
      assert.throws(() => deleteEntry(root, "exists-not", opts), /Nicht gefunden/, variant);
    }
    // A living symlink falls itself, its target stays.
    fs.writeFileSync(path.join(root, "target.txt"), "z");
    fs.symlinkSync(path.join(root, "target.txt"), path.join(root, "alive"));
    deleteEntry(root, "alive");
    assert.equal(fs.readFileSync(path.join(root, "target.txt"), "utf8"), "z");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── codeProjectRoutes computes the target instance only for paths codeRoute answers ────────────────
// It used to compute the instance (targetInstance) for EVERY sub - a route of a later family (`/context/...`) whose
// instance was just not readable answered 409 instead of its own answer. code-route.js names ONE list of prefixes
// (CODE_ROUTE_PREFIXES); this guard holds that every branch of codeRoute lies under one of them (otherwise it would be
// unreachable on the project level). The path itself stands in projectbox-git.test.js "(O)". Counter-test: dropping
// a prefix (e.g. `/lsp`, the editor's language service) from the list => red (the branches without a prefix).
test("every branch of codeRoute lies under a prefix from CODE_ROUTE_PREFIXES", async () => {
  const { CODE_ROUTE_PREFIXES, liesUnderCodeRoute } = await import("../electron/server/devtools/code-route.js");
  assert.ok(Array.isArray(CODE_ROUTE_PREFIXES) && Object.isFrozen(CODE_ROUTE_PREFIXES), "CODE_ROUTE_PREFIXES is missing");
  const sourceValue = fs.readFileSync(path.join(here, "..", "electron", "server", "devtools", "code-route.js"), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  const subs = new Set();
  for (const [, s] of sourceValue.matchAll(/sub === "(\/[^"]*)"/g)) subs.add(s);
  for (const [, s] of sourceValue.matchAll(/sub\.startsWith\("(\/[^"]*)"\)/g)) subs.add(s);
  assert.ok(subs.size >= 40, `too few branches found: ${subs.size}`);
  const without = [...subs].filter((s) => !liesUnderCodeRoute(s)).sort();
  assert.deepEqual(without, [], `branches of codeRoute without a prefix (unreachable on the project level): ${without.join(", ")}`);
  for (const s of ["/context/categories", "/gitx", "/filesystem", "/browser/ensure", ""]) assert.equal(liesUnderCodeRoute(s), false, s);
  for (const s of ["/git", "/git/stage", "/files", "/files/read", "/upload", "/terminal", "/debug/launch", "/lsp/rename"]) assert.equal(liesUnderCodeRoute(s), true, s);
});

// ── The workspace of the git accesses is the caller's ──────────────────────────────────────────────
// It used to assign /git/creds (and the askpass of push/pull/fetch/commit) to the FIRST workspace whose folder
// contains the path (wsForPath, workspaces/git-auth.js): with nested workspaces ("dev" and "dev/private") the access of
// a project of "private" landed at "dev", and a project outside every workspace folder got 404 "workspace not found".
// Now the caller passes the id along (project: proj.workspaceId, workspace: ws.id). Counter-test: the old code-route.js
// and git-auth.js with the two callers => red (the access lands at "dev"; external 404).
test("/git/creds saves, reads and deletes at the workspace of the project or of the view - not at the first matching path", async () => {
  const store = await import("../electron/server/store.js");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-n34-")));
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const calls = async (m, u, b) => {
      const r = await fetch(base + u, { method: m, headers: { "Content-Type": "application/json", Connection: "close" }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return { status: r.status, body: await r.json() };
    };
    const dev = (await calls("POST", "/api/workspaces", { name: "dev", path: path.join(root, "dev") })).body;
    const personal = (await calls("POST", "/api/workspaces", { name: "private", path: path.join(root, "dev", "private") })).body;
    assert.deepEqual(store.listWorkspaces().map((w) => w.id), [dev.id, personal.id], "\"dev\" stands first in the list - the case of the finding");
    const projectValue = async (ws, ...parts) => (await calls("POST", `/api/workspaces/${ws.id}/projects`, { name: parts.at(-1), path: path.join(root, ...parts) })).body;
    const app = await projectValue(personal, "dev", "private", "app");     // project of "private" in its folder
    const middleValue = await projectValue(dev, "dev", "private", "middle");    // project of "dev" - but lies in the folder of "private"
    const extern = await projectValue(personal, "external", "app");         // project of "private" outside every workspace folder
    const hosts = (ws) => store.listGitCreds(ws.id).map((c) => c.host).sort();
    const access = (host) => ({ host, username: "u", secret: "s" });

    assert.equal((await calls("PUT", `/api/projects/${app.id}/git/creds`, access("app.example"))).status, 200);
    assert.equal((await calls("PUT", `/api/projects/${middleValue.id}/git/creds`, access("middle.example"))).status, 200);
    const ext = await calls("PUT", `/api/projects/${extern.id}/git/creds`, access("external.example"));
    assert.equal(ext.status, 200, `project outside the workspace folder: ${JSON.stringify(ext.body)}`);
    assert.deepEqual(hosts(personal), ["app.example", "external.example"]);
    assert.deepEqual(hosts(dev), ["middle.example"]);
    // Read: per project the accesses of ITS workspace; the workspace view of "private" those of "private".
    const readValue = async (u) => (await calls("GET", u)).body.creds.map((c) => c.host).sort();
    assert.deepEqual(await readValue(`/api/projects/${app.id}/git/creds`), ["app.example", "external.example"]);
    assert.deepEqual(await readValue(`/api/projects/${middleValue.id}/git/creds`), ["middle.example"]);
    assert.deepEqual(await readValue(`/api/workspaces/${personal.id}/git/creds`), ["app.example", "external.example"]);
    assert.deepEqual(await readValue(`/api/workspaces/${dev.id}/git/creds`), ["middle.example"]);
    // Delete: at the right workspace.
    assert.equal((await calls("DELETE", `/api/projects/${extern.id}/git/creds?host=external.example`)).status, 200);
    assert.deepEqual(hosts(personal), ["app.example"]);
    assert.equal((await calls("DELETE", `/api/workspaces/${personal.id}/git/creds?host=app.example`)).status, 200);
    assert.deepEqual([hosts(personal), hosts(dev)], [[], ["middle.example"]]);
  } finally {
    try { server?.closeAllConnections?.(); } catch { /* whatever */ }
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message})`); }
  }
});
