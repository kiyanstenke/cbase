// The product version: one number for the whole tree, kept by tools/version.mjs (its table PLACES names every file).
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
//
// The tool is run as a process (`--root` on a temp copy), not imported: tools/check reaches no other tool folder
// (public-closure.test.mjs), and the command line is the interface the maintainer uses anyway.
//
// COUNTER-PROOF: `check` in tools/version.mjs reporting no mismatches (`mismatches: []`) turns (2) red for every place.
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

function run(args, root) {
  const r = spawnSync(process.execPath, [TOOL, ...args, ...(root ? ["--root", root] : [])], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const PLACES = run(["places"]).out.split("\n");
const VERSION = run([]).out;

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
    const r = run(["set", "0.2.0"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(run([], dir).out, "0.2.0");
    const expected = { "package.json": 1, "package-lock.json": 2, "project.pbxproj": 4, "Info.plist": 0, "CHANGELOG.md": 0 };
    for (const f of PLACES) {
      assert.equal(changedLines(before[f], read(dir, f)), expected[path.basename(f)], `${f}: unexpected number of changed lines`);
    }
    assert.equal(run(["set", "0.2.0"], dir).code, 0, "setting the same version again is allowed (no-op)");
  } finally { clean(dir); }
});

const ENTRY = "### Fixed\n- Something.\n";

test("(4) release turns Unreleased into the release section — byte-exact on the real CHANGELOG and with link references", () => {
  const dir = copy();
  try {
    const real = read(dir, "CHANGELOG.md");
    let r = run(["release", "0.2.0", "--date", "2026-12-01"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(read(dir, "CHANGELOG.md"), real.replace(/^## \[Unreleased\]$/m, "## [Unreleased]\n\n## [0.2.0] - 2026-12-01"));
    assert.equal(run([], dir).out, "0.2.0");

    const linked = [
      "# Changelog", "", "## [Unreleased]", "", ENTRY, "## [0.2.0] - 2026-12-01", "", "### Added", "- First.", "",
      "[Unreleased]: https://example.org/r/compare/v0.2.0...HEAD", "[0.2.0]: https://example.org/r/releases/tag/v0.2.0", "",
    ].join("\n");
    write(dir, "CHANGELOG.md", linked);
    r = run(["release", "0.3.0", "--date", "2027-01-15"], dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(read(dir, "CHANGELOG.md"), [
      "# Changelog", "", "## [Unreleased]", "", "## [0.3.0] - 2027-01-15", "", ENTRY, "## [0.2.0] - 2026-12-01", "", "### Added", "- First.", "",
      "[Unreleased]: https://example.org/r/compare/v0.3.0...HEAD", "[0.3.0]: https://example.org/r/compare/v0.2.0...v0.3.0",
      "[0.2.0]: https://example.org/r/releases/tag/v0.2.0", "",
    ].join("\n"));
    assert.equal(run([], dir).out, "0.3.0");
  } finally { clean(dir); }
});

test("(5) malformed, lower, already released, empty Unreleased and bad dates are refused — and nothing is written", () => {
  const dir = copy();
  try {
    const snapshot = () => PLACES.map((f) => read(dir, f)).join("\0");
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
    refused(["release", "0.2.0", "--date", "2026-13-45"], /YYYY-MM-DD/);
    refused(["release", "0.2.0", "--date", "1.12.2026"], /YYYY-MM-DD/);
    refused(["set", "0.2.0", "--date", "2026-12-01"], /usage/);

    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-12-01\n\n${ENTRY}`);
    const withRelease = snapshot();
    const refusedHere = (args, why) => {
      const r = run(args, dir);
      assert.equal(r.code, 1, `${args.join(" ")} was accepted`);
      assert.match(r.err, why, r.err);
      assert.equal(snapshot(), withRelease, `${args.join(" ")} wrote something although it was refused`);
    };
    refusedHere(["release", "0.3.0"], /empty/);
    write(dir, "CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n${ENTRY}\n## [0.2.0] - 2026-12-01\n\n${ENTRY}`);
    const again = snapshot();
    for (const [v, why] of [["0.2.0", /already has a section/], ["0.1.5", /not higher than the last release/]]) {
      const r = run(["release", v], dir);
      assert.equal(r.code, 1, `release ${v} was accepted`);
      assert.match(r.err, why, r.err);
      assert.equal(snapshot(), again);
    }
  } finally { clean(dir); }
});
