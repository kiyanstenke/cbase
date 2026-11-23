// The product version: one number for the whole tree, kept by tools/version.mjs (its table PLACES names every file), and the ids
// derived from it (VERSIONING.md).
//
// PROMISES:
//   (1) the real tree agrees on one SemVer version, and the gateway carries no literal of its own (it reads its package.json)
//   (2) a temp copy in which exactly ONE occurrence deviates is red, and the message names that file — for every occurrence
//       of every place (both versions of each lockfile, all four MARKETING_VERSION lines, the Info.plist link)
//   (3) `set` writes every place and changes nothing else (the number of changed lines per file is exact)
//   (4) `release` turns "## [Unreleased]" into the release section with a fresh empty one above it — byte-exact, with and
//       without link references
//   (5) a malformed or a lower version, a version already released, an empty Unreleased section and a bad date are refused, and
//       nothing is written
//   (6) `describe` gives the bare version only exactly on a clean tag v<version>; one commit later "+1.g<sha7>", uncommitted or
//       untracked changes ".dirty", a tag of another version is no release tag, no tag "+N" counted from the root commit, no git
//       "+unknown" with commit null
//   (7) `ios-build` is BUILD_OFFSET + the commit count, grows with every commit, and refuses a shallow clone and a tree without git
//   (8) the release preflight refuses — and writes nothing — off main, on a detached HEAD, with a dirty tree, with HEAD not equal
//       to origin/main, and outside a git repository; the same trees back on main, cleaned up or with HEAD == origin/main are
//       accepted (which number to raise is the maintainer's call — the tool enforces no bump)
//   (9) `release --commit` commits "Release x.y.z" and creates the annotated tag vx.y.z, leaves a clean tree and never pushes;
//       without --commit there is neither commit nor tag
//  (10) `notes` prints exactly the body of a release section and refuses a missing one
//  (11) `set` on a place it cannot update (a project file without MARKETING_VERSION) ends with an error that names the place —
//       not with a TypeError from its own message
//
// The release cases run in temp git repositories that satisfy the preflight (branch main, everything committed), so the tool
// has no switch that exists only for tests. The tool is run as a process (`--root` on a temp copy), not imported: tools/check
// reaches no other tool folder (public-closure.test.mjs), and the command line is the interface the maintainer uses anyway.
//
// COUNTER-PROOF: `check` in tools/version.mjs reporting no mismatches (`mismatches: []`) turns (2) red for every place; `describe`
// ignoring the dirty state turns (6) red; dropping the shallow check turns (7) red; each preflight reason removed turns its case
// in (8) red; `--commit` without the tag turns (9) red; the error path of `set` formatting its message with `describe` (which
// takes a root, not a list) instead of `describeList` turns (11) red.
//
// Run:  node --test --test-reporter=tap tools/check/version.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const TOOL = path.join(REPO, "tools", "version.mjs");

// Git for the temp repositories: no system or user configuration (no signing, no hooks, no template), a fixed identity, and a
// ceiling at the temp folder so a copy outside git never finds a repository above it.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
Object.assign(GIT_ENV, {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
});

function run(args, root) {
  const r = spawnSync(process.execPath, [TOOL, ...args, ...(root ? ["--root", root] : [])], { encoding: "utf8", env: GIT_ENV });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function git(dir, ...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
// Everything in the tree as one commit on the current branch; returns the commit.
function commitAll(dir, message = "change") {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}
// A temp copy that is a git repository on branch main with everything committed — the state the release preflight accepts.
function repo() {
  const dir = copy();
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "start");
  return dir;
}

const PLACES = run(["places"]).out.split("\n");
const VERSION = run([]).out;
// The versions the cases release are derived from the repo's current one, so the test holds after every real release: NEXT and
// AFTER lie above it (next two minors), BETWEEN above the current but below NEXT (for "not higher than the last release").
const [MAJOR, MINOR, PATCH] = VERSION.split(".").map(Number);
const NEXT = `${MAJOR}.${MINOR + 1}.0`;
const AFTER = `${MAJOR}.${MINOR + 2}.0`;
const BETWEEN = `${MAJOR}.${MINOR}.${PATCH + 1}`;

// A temp copy of exactly the files the tool touches.
function copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-version-"));
  for (const f of PLACES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  return dir;
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");
const write = (dir, f, text) => fs.writeFileSync(path.join(dir, f), text);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Where the version stands in each kind of file — the test's own knowledge, deliberately not the tool's.
function occurrences(file, v) {
  if (file.endsWith("package.json")) return [new RegExp(`^ {2}"version": "${esc(v)}"`, "m")];
  if (file.endsWith("package-lock.json")) return [new RegExp(`^ {2}"version": "${esc(v)}"`, "m"), new RegExp(`^ {6}"version": "${esc(v)}"`, "m")];
  if (file.endsWith(".pbxproj")) return [`MARKETING_VERSION = ${v};`];
  if (file.endsWith("Info.plist")) return ["<string>$(MARKETING_VERSION)</string>"];
  return [];
}

// The text with the n-th match of `pattern` replaced (a string pattern counts every occurrence, a regex only its first).
function sabotage(text, pattern, n, by) {
  if (typeof pattern !== "string") return text.replace(pattern, (m) => m.replace(/"[^"]*"$/, `"${by}"`));
  let at = -1;
  for (let i = 0; i <= n; i++) at = text.indexOf(pattern, at + 1);
  assert.ok(at >= 0, `occurrence ${n} of ${pattern} not found`);
  const replaced = pattern.includes("MARKETING_VERSION = ") ? `MARKETING_VERSION = ${by};` : `<string>${by}</string>`;
  return text.slice(0, at) + replaced + text.slice(at + pattern.length);
}

const changedLines = (a, b) => {
  const x = a.split("\n"), y = b.split("\n");
  assert.equal(x.length, y.length, "set must not add or remove lines");
  return x.filter((line, i) => line !== y[i]).length;
};

test("(1) the real tree agrees on one SemVer version; the gateway reads its version from package.json", () => {
  const r = run([]);
  assert.equal(r.code, 0, `the places disagree:\n${r.err}`);
  assert.match(r.out, /^\d+\.\d+\.\d+$/);
  assert.ok(PLACES.length >= 9 && PLACES.includes("CHANGELOG.md"), `places: ${PLACES.join(", ")}`);
  const gateway = fs.readFileSync(path.join(REPO, "server/gateway/index.js"), "utf8");
  assert.doesNotMatch(gateway, /\bVERSION\s*=\s*["'`]\d/, "the gateway carries a version literal again — it must read server/gateway/package.json");
  assert.match(gateway, /\bVERSION = JSON\.parse\(fs\.readFileSync\(path\.join\(__dirname, "package\.json"\)/);
});

test("(2) one deviating occurrence in a temp copy is red and named — for every occurrence of every place", () => {
  const dir = copy();
  try {
    let probes = 0;
    for (const file of PLACES) {
      const original = read(dir, file);
      const patterns = occurrences(file, VERSION);
      if (file === "CHANGELOG.md") continue;
      assert.ok(patterns.length, `${file}: the test does not know where the version stands`);
      for (const pattern of patterns) {
        const count = typeof pattern === "string" ? original.split(pattern).length - 1 : 1;
        assert.ok(count >= 1, `${file}: ${pattern} not found in the real file`);
        for (let n = 0; n < count; n++) {
          write(dir, file, sabotage(original, pattern, n, file.endsWith("Info.plist") ? VERSION : "0.0.9"));
          const r = run([], dir);
          assert.equal(r.code, 1, `${file} (occurrence ${n + 1} of ${pattern}) changed, yet the check is green`);
          assert.ok(r.err.includes(file), `${file}: the message does not name the file:\n${r.err}`);
          probes++;
          write(dir, file, original);
        }
      }
    }
    assert.ok(probes >= 13, `only ${probes} probes`);
    assert.equal(run([], dir).code, 0, "the restored copy is green again");
  } finally { clean(dir); }
});

test("(3) set writes every place and nothing else", () => {
  const dir = copy();
  try {
    const before = Object.fromEntries(PLACES.map((f) => [f, read(dir, f)]));
    const r = run(["set", NEXT], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(run([], dir).out, NEXT);
    const expected = { "package.json": 1, "package-lock.json": 2, "project.pbxproj": 4, "Info.plist": 0, "CHANGELOG.md": 0 };
    for (const f of PLACES) {
      assert.equal(changedLines(before[f], read(dir, f)), expected[path.basename(f)], `${f}: unexpected number of changed lines`);
    }
    assert.equal(run(["set", NEXT], dir).code, 0, "setting the same version again is allowed (no-op)");
  } finally { clean(dir); }
});

const ENTRY = "### Fixed\n- Something.\n";

test("(4) release turns Unreleased into the release section — byte-exact on the real CHANGELOG and with link references", () => {
  const dir = repo();
  try {
    // The real file's SHAPE is the subject here, not its momentary content. Its link footer is left out: the second half below
    // checks the rewriting of those links literally, so here only the body may change.
    const real = read(dir, "CHANGELOG.md")
      .replace(/\n\[Unreleased\]: .*$/s, "\n")
      .replace(/^## \[Unreleased\]\n\n/m, `## [Unreleased]\n\n${ENTRY}`);
    write(dir, "CHANGELOG.md", real);
    commitAll(dir);
    assert.match(real, /^## \[Unreleased\]\n\n### Fixed$/m, "the real CHANGELOG no longer has an empty line after '## [Unreleased]'");
    let r = run(["release", NEXT, "--date", "2026-12-01"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(read(dir, "CHANGELOG.md"), real.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${NEXT}] - 2026-12-01`));
    assert.equal(run([], dir).out, NEXT);

    const linked = [
      "# Changelog", "", "## [Unreleased]", "", ENTRY, `## [${NEXT}] - 2026-12-01`, "", "### Added", "- First.", "",
      `[Unreleased]: https://example.org/r/compare/v${NEXT}...HEAD`, `[${NEXT}]: https://example.org/r/releases/tag/v${NEXT}`, "",
    ].join("\n");
    write(dir, "CHANGELOG.md", linked);
    commitAll(dir);
    r = run(["release", AFTER, "--date", "2027-01-15"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(read(dir, "CHANGELOG.md"), [
      "# Changelog", "", "## [Unreleased]", "", `## [${AFTER}] - 2027-01-15`, "", ENTRY, `## [${NEXT}] - 2026-12-01`, "", "### Added", "- First.", "",
      `[Unreleased]: https://example.org/r/compare/v${AFTER}...HEAD`, `[${AFTER}]: https://example.org/r/compare/v${NEXT}...v${AFTER}`,
      `[${NEXT}]: https://example.org/r/releases/tag/v${NEXT}`, "",
    ].join("\n"));
    assert.equal(run([], dir).out, AFTER);
  } finally { clean(dir); }
});

test("(5) malformed, lower, already released, empty Unreleased and bad dates are refused — and nothing is written", () => {
  const dir = repo();
  try {
    const snapshot = () => PLACES.map((f) => read(dir, f)).join("\0");
    // A deterministic CHANGELOG: what the real one holds depends on whether a release was just prepared, and that would decide
    // WHICH refusal a too-low version gets ("lower than the current version" or "not higher than the last release").
    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n${ENTRY}`);
    commitAll(dir);
    const before = snapshot();
    const refused = (args, why) => {
      const r = run(args, dir);
      assert.equal(r.code, 1, `${args.join(" ")} was accepted`);
      assert.match(r.err, why, `${args.join(" ")}: ${r.err}`);
      assert.equal(snapshot(), before, `${args.join(" ")} wrote something although it was refused`);
    };
    for (const v of ["1.0", "v0.2.0", "0.2", "0.2.0-beta.1", "01.2.0", "0.2.0.1", ""]) refused(["set", v], /MAJOR\.MINOR\.PATCH|usage/);
    refused(["set", "0.0.9"], /lower than the current version/);
    refused(["release", "0.0.9", "--date", "2026-12-01"], /lower than the current version/);
    refused(["release", NEXT, "--date", "2026-13-45"], /YYYY-MM-DD/);
    refused(["release", NEXT, "--date", "1.12.2026"], /YYYY-MM-DD/);
    refused(["set", NEXT, "--date", "2026-12-01"], /usage/);

    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n## [${NEXT}] - 2026-12-01\n\n${ENTRY}`);
    commitAll(dir);
    const withRelease = snapshot();
    const refusedHere = (args, why) => {
      const r = run(args, dir);
      assert.equal(r.code, 1, `${args.join(" ")} was accepted`);
      assert.match(r.err, why, r.err);
      assert.equal(snapshot(), withRelease, `${args.join(" ")} wrote something although it was refused`);
    };
    refusedHere(["release", AFTER], /empty/);
    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n${ENTRY}\n## [${NEXT}] - 2026-12-01\n\n${ENTRY}`);
    commitAll(dir);
    const again = snapshot();
    for (const [v, why] of [[NEXT, /already has a section/], [BETWEEN, /not higher than the last release/]]) {
      const r = run(["release", v], dir);
      assert.equal(r.code, 1, `release ${v} was accepted`);
      assert.match(r.err, why, r.err);
      assert.equal(snapshot(), again);
    }
  } finally { clean(dir); }
});

const short = (dir) => git(dir, "rev-parse", "--short=7", "HEAD");
const json = (dir) => {
  const r = run(["describe", "--json"], dir);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

test("(6) describe: the bare version only exactly on a clean tag; distance, sha and dirty otherwise; +unknown without git", () => {
  const plain = copy();
  const dir = repo();
  try {
    // No git at all: no claim of a clean build.
    assert.deepEqual(json(plain), { version: VERSION, build: `${VERSION}+unknown`, commit: null, dirty: false });
    assert.equal(run(["describe"], plain).out, `${VERSION}+unknown`);

    // No tag yet: counted from the root commit (one commit so far).
    commitAll(dir, "second");
    assert.equal(run(["describe"], dir).out, `${VERSION}+2.g${short(dir)}`);

    // A tag of another version on HEAD is not the release tag of this version.
    git(dir, "tag", "-a", "v0.0.1", "-m", "old");
    assert.equal(run(["describe"], dir).out, `${VERSION}+0.g${short(dir)}`);

    // Exactly on the clean tag v<version>.
    git(dir, "tag", "-a", `v${VERSION}`, "-m", "release");
    const head = git(dir, "rev-parse", "HEAD");
    assert.deepEqual(json(dir), { version: VERSION, build: VERSION, commit: head, dirty: false });

    // On the tag, but with an uncommitted change: never the bare version.
    write(dir, "CHANGELOG.md", `${read(dir, "CHANGELOG.md")}\nedited\n`);
    assert.deepEqual(json(dir), { version: VERSION, build: `${VERSION}+0.g${short(dir)}.dirty`, commit: head, dirty: true });

    // One commit after the tag.
    const after = commitAll(dir, "after the tag");
    assert.deepEqual(json(dir), { version: VERSION, build: `${VERSION}+1.g${short(dir)}`, commit: after, dirty: false });

    // An untracked file counts as dirty too (it can end up in a build).
    write(dir, "new-file.txt", "x\n");
    assert.equal(run(["describe"], dir).out, `${VERSION}+1.g${short(dir)}.dirty`);
  } finally { clean(plain); clean(dir); }
});

test("(7) ios-build is BUILD_OFFSET + the commit count, grows with every commit, and refuses a shallow clone and no git", () => {
  const plain = copy();
  const dir = repo();
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-version-shallow-"));
  try {
    const offset = Number(fs.readFileSync(TOOL, "utf8").match(/^export const BUILD_OFFSET = (\d+);$/m)?.[1]);
    assert.ok(offset >= 100, "BUILD_OFFSET not found in tools/version.mjs");
    let previous = 0;
    for (let n = 1; n <= 3; n++) {
      if (n > 1) commitAll(dir, `commit ${n}`);
      const r = run(["ios-build"], dir);
      assert.equal(r.code, 0, r.err);
      assert.equal(Number(r.out), offset + n, `after ${n} commit(s)`);
      assert.ok(Number(r.out) > previous, "the build number must grow with every commit");
      previous = Number(r.out);
    }
    let r = run(["ios-build"], plain);
    assert.equal(r.code, 1, "ios-build without git was accepted");
    assert.match(r.err, /git repository/);

    git(shallow, "clone", "-q", "--depth", "1", `file://${dir}`, "clone");
    r = run(["ios-build"], path.join(shallow, "clone"));
    assert.equal(r.code, 1, `ios-build in a shallow clone was accepted: ${r.out}`);
    assert.match(r.err, /shallow/);
  } finally { clean(plain); clean(dir); clean(shallow); }
});

test("(8) the release preflight refuses every unsafe state and writes nothing; the safe twin of each state is accepted", () => {
  const releaseRefused = (dir, v, why) => {
    const before = git(dir, "status", "--porcelain");
    const bytes = PLACES.map((f) => read(dir, f)).join("\0");
    const r = run(["release", v, "--date", "2026-12-01"], dir);
    assert.equal(r.code, 1, `release ${v} was accepted`);
    assert.match(r.err, why, r.err);
    assert.equal(git(dir, "status", "--porcelain"), before, "a refused release changed the tree");
    assert.equal(PLACES.map((f) => read(dir, f)).join("\0"), bytes);
  };
  const releaseAccepted = (dir, v) => {
    const r = run(["release", v, "--date", "2026-12-01"], dir);
    assert.equal(r.code, 0, `release ${v} refused: ${r.err}`);
    assert.equal(run([], dir).out, v);
  };
  const withEntry = () => {
    const dir = repo();
    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n${ENTRY}`);
    commitAll(dir, "entry");
    return dir;
  };
  const dirs = [];
  const fresh = () => { const d = withEntry(); dirs.push(d); return d; };
  try {
    // Outside a git repository.
    const plain = copy();
    dirs.push(plain);
    write(plain, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n${ENTRY}`);
    const r = run(["release", NEXT, "--date", "2026-12-01"], plain);
    assert.equal(r.code, 1);
    assert.match(r.err, /not the top level of a git repository/);
    assert.equal(run([], plain).out, VERSION, "a refused release wrote the version");

    // Off main, and its twin back on main.
    let dir = fresh();
    git(dir, "checkout", "-q", "-b", "feature");
    releaseRefused(dir, NEXT, /not on branch main \(feature\)/);
    git(dir, "checkout", "-q", "main");
    releaseAccepted(dir, NEXT);

    // Detached HEAD.
    dir = fresh();
    git(dir, "checkout", "-q", "--detach");
    releaseRefused(dir, NEXT, /detached HEAD/);

    // A dirty tree (an untracked file), and its twin with the file removed.
    dir = fresh();
    write(dir, "stray.txt", "x\n");
    releaseRefused(dir, NEXT, /not clean/);
    fs.rmSync(path.join(dir, "stray.txt"));
    releaseAccepted(dir, NEXT);

    // HEAD ahead of origin/main, and the twin with origin/main == HEAD.
    dir = fresh();
    const first = git(dir, "rev-list", "--max-parents=0", "HEAD");
    git(dir, "update-ref", "refs/remotes/origin/main", first);
    releaseRefused(dir, NEXT, /HEAD is not origin\/main/);
    git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", "HEAD"));
    releaseAccepted(dir, NEXT);

  } finally { for (const d of dirs) clean(d); }
});

test("(9) release --commit commits and tags locally, leaves a clean tree, never pushes; without --commit neither", () => {
  const dir = repo();
  try {
    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n${ENTRY}`);
    const start = commitAll(dir, "entry");

    let r = run(["release", NEXT, "--date", "2026-12-01"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(git(dir, "rev-parse", "HEAD"), start, "release without --commit committed");
    assert.equal(git(dir, "tag", "--list", `v${NEXT}`), "", "release without --commit tagged");
    git(dir, "checkout", "-q", "--", ".");

    r = run(["release", NEXT, "--date", "2026-12-01", "--commit"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(git(dir, "log", "-1", "--format=%s"), `Release ${NEXT}`);
    assert.equal(git(dir, "rev-parse", "HEAD~1"), start);
    assert.equal(git(dir, "cat-file", "-t", `v${NEXT}`), "tag", "the release tag must be annotated");
    assert.equal(git(dir, "rev-parse", `v${NEXT}^{commit}`), git(dir, "rev-parse", "HEAD"));
    assert.equal(git(dir, "status", "--porcelain"), "", "--commit left changes behind");
    assert.equal(run(["describe"], dir).out, NEXT, "right after the release commit the build id is the bare version");

    // A second release onto an existing tag is refused before anything is written.
    write(dir, "CHANGELOG.md", read(dir, "CHANGELOG.md").replace("## [Unreleased]\n", `## [Unreleased]\n\n${ENTRY}`));
    commitAll(dir, "more");
    git(dir, "tag", "-a", `v${AFTER}`, "-m", "squatted");
    r = run(["release", AFTER, "--commit"], dir);
    assert.equal(r.code, 1);
    assert.match(r.err, /tag v\S+ exists already/);
    assert.equal(git(dir, "status", "--porcelain"), "");

    // Never pushes: the tool has no git push in it at all.
    assert.doesNotMatch(fs.readFileSync(TOOL, "utf8"), /["']push["']/);
  } finally { clean(dir); }
});

test("(10) notes prints exactly the body of a release section and refuses a missing or empty one", () => {
  const dir = copy();
  try {
    write(dir, "CHANGELOG.md", [
      "# Changelog", "", "## [Unreleased]", "", `## [${AFTER}] - 2027-01-15`, "", "### Added", "- Second.", "",
      `## [${NEXT}] - 2026-12-01`, "", "### Fixed", "- First.", "", `[Unreleased]: https://example.org/r/compare/v${AFTER}...HEAD`, "",
    ].join("\n"));
    assert.equal(run(["notes", AFTER], dir).out, "### Added\n- Second.");
    assert.equal(run(["notes", NEXT], dir).out, "### Fixed\n- First.");
    const missing = run(["notes", BETWEEN], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no "## \[.*\]" section/);
    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n## [${NEXT}] - 2026-12-01\n\n`);
    assert.match(run(["notes", NEXT], dir).err, /is empty/);
  } finally { clean(dir); }
});

test("(11) set on a place it cannot update fails with a message that names the place", () => {
  const dir = copy();
  try {
    const pbx = "mobile/CbaseMobile.xcodeproj/project.pbxproj";
    write(dir, pbx, read(dir, pbx).replace(/^.*\bMARKETING_VERSION = .*\n/gm, ""));
    const r = run(["set", NEXT], dir);
    assert.equal(r.code, 1, "set succeeded although a place carries no version");
    assert.match(r.err, /set \S+ left deviating places: /, r.err);
    assert.ok(r.err.includes(`${pbx} ((no version found)): missing`), r.err);
    assert.doesNotMatch(r.err, /TypeError|ERR_INVALID_ARG_TYPE/, r.err);
  } finally { clean(dir); }
});
