// The guard against regrowth: no source file over 2,000 lines, exceptions only with a reason and a follow-up, and the list
// may only shrink.
//
// The costliest failure would be a guard that silently waves things through: an entry for a file long since under the limit
// would cover the NEXT overrun without anyone having decided it. So every guard here turns red once.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { execFileSync } from "node:child_process";

import { LOC_EXTENSIONS, LOC_LIMIT, LOC_ROOTS, SKIP_DIRS, countLines, locGate, locScan, locVerdict, readAllow } from "./lib/loc-gate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALLOW_FILE = path.join(REPO, "tools/check/loc-allow.json");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbase-deploytest-"));
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const entry = (file) => ({ file, reason: "Test", fallsOutWith: "Test-End" });
const allow = (...entries) => ({ limit: LOC_LIMIT, entries });

// ── countLines ───────────────────────────────────────────────────────────────────────────────
//
// Counted like `wc -l` PLUS an incomplete last line — "a" is one line, not zero.
test("countLines: empty → 0, \"a\" → 1, \"a\\n\" → 1, \"a\\nb\" → 2", () => {
  assert.equal(countLines(Buffer.from("")), 0);
  assert.equal(countLines(Buffer.from("a")), 1);
  assert.equal(countLines(Buffer.from("a\n")), 1);
  assert.equal(countLines(Buffer.from("a\nb")), 2);
  assert.equal(countLines(Buffer.from("a\nb\n")), 2);
  assert.equal(countLines(Buffer.from("\n")), 1);
});

// ── locVerdict ───────────────────────────────────────────────────────────────────────────────

test("locVerdict: 2001 lines without an exception are a violation — covered with one", () => {
  const files = [{ rel: "a/large.js", rows: 2001 }, { rel: "a/small.js", rows: 2000 }];
  const without = locVerdict(files, allow());
  assert.equal(without.ok, false);
  assert.deepEqual(without.violations.map((f) => f.rel), ["a/large.js"], "exactly 2000 is still allowed, 2001 is not");
  assert.deepEqual(without.covered, []);
  assert.deepEqual(without.tot, []);

  const including = locVerdict(files, allow(entry("a/large.js")));
  assert.equal(including.ok, true);
  assert.deepEqual(including.violations, []);
  assert.equal(including.covered.length, 1);
  // The covered item carries lines AND the reason — the guard prints both.
  assert.equal(including.covered[0].rows, 2001);
  assert.equal(including.covered[0].reason, "Test");
  assert.equal(including.covered[0].fallsOutWith, "Test-End");
});

// The list may only shrink: an entry whose file is under the limit is DEAD — and a dead entry is an error, not silence.
test("locVerdict: an exception for a file with 1999 lines is dead → not ok", () => {
  const v = locVerdict([{ rel: "a/fast.js", rows: 1999 }], allow(entry("a/fast.js")));
  assert.equal(v.ok, false);
  assert.deepEqual(v.violations, []);
  assert.deepEqual(v.tot.map((e) => [e.file, e.rows]), [["a/fast.js", 1999]]);
});

test("locVerdict: an exception for a missing file is dead (rows null) → not ok", () => {
  const v = locVerdict([{ rel: "a/da.js", rows: 10 }], allow(entry("a/way.js")));
  assert.equal(v.ok, false);
  assert.deepEqual(v.tot.map((e) => [e.file, e.rows]), [["a/way.js", null]]);
});

test("locVerdict: the limit comes from the list, else LOC_LIMIT", () => {
  const files = [{ rel: "x.js", rows: 150 }];
  assert.equal(locVerdict(files, { limit: 100, entries: [] }).violations.length, 1);
  assert.equal(locVerdict(files, { entries: [] }).limit, LOC_LIMIT);
  assert.equal(locVerdict(files, { entries: [] }).violations.length, 0);
});

// ── readAllow ────────────────────────────────────────────────────────────────────────────────
//
// An exception without a reason cannot be told from a forgotten one — so reading throws instead of silently waving it through.
function withAllowFile(content, fn) {
  const tmp = tmpDir();
  try {
    const file = path.join(tmp, "loc-allow.json");
    fs.writeFileSync(file, JSON.stringify(content));
    return fn(file);
  } finally {
    clean(tmp);
  }
}

test("readAllow: a missing reason or fallsOutWith throws — reason and follow-up are mandatory", () => {
  withAllowFile({ entries: [{ file: "a.js", fallsOutWith: "x" }] }, (file) =>
    assert.throws(() => readAllow(file), /a\.js without "reason"/));
  withAllowFile({ entries: [{ file: "a.js", reason: "x" }] }, (file) =>
    assert.throws(() => readAllow(file), /a\.js without "fallsOutWith"/));
  // Whitespace is no reason.
  withAllowFile({ entries: [{ file: "a.js", reason: "   ", fallsOutWith: "x" }] }, (file) =>
    assert.throws(() => readAllow(file), /without "reason"/));
  withAllowFile({ entries: [{ reason: "x", fallsOutWith: "x" }] }, (file) =>
    assert.throws(() => readAllow(file), /without "file"/));
  withAllowFile({ limit: 2000 }, (file) =>
    assert.throws(() => readAllow(file), /field "entries" missing/));
  // And a complete list is read — with its limit.
  withAllowFile({ limit: 1500, entries: [entry("a.js")] }, (file) => {
    const a = readAllow(file);
    assert.equal(a.limit, 1500);
    assert.deepEqual(a.entries, [entry("a.js")]);
  });
  withAllowFile({ entries: [] }, (file) => assert.equal(readAllow(file).limit, LOC_LIMIT));
});

// ── locScan ──────────────────────────────────────────────────────────────────────────────────

test("locScan: only source extensions, node_modules/out/dist stay out, largest first", () => {
  const tmp = tmpDir();
  try {
    const write = (rel, rows) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), "x\n".repeat(rows));
    };
    write("src/a.js", 3);
    write("src/deep/b.swift", 5);
    write("src/c.ts", 1);
    write("src/README.md", 100);
    write("src/node_modules/x.js", 100);
    write("src/out/y.js", 100);
    write("src/dist/z.js", 100);
    write("elsewhere/d.js", 100);
    const scan = locScan(tmp, ["src", "missing"]);
    assert.deepEqual(scan, [
      { rel: "src/deep/b.swift", rows: 5 },
      { rel: "src/a.js", rows: 3 },
      { rel: "src/c.ts", rows: 1 },
    ]);
  } finally {
    clean(tmp);
  }
});

// ── The root list itself ─────────────────────────────────────────────────────────────────────
//
// A file the guard does not SEE cannot exceed it. The assertion is deliberately NOT a second copy of the list (that would
// only be a third truth aging with it) but a COVERAGE check against an independent source: whatever Git tracks as a source
// file must lie under one of the roots. Untracked artifacts do not count. A tracked file that is DELETED in the working tree
// (not yet committed) does not count either: `git ls-files` still lists it, `locScan` does not find it — a deletion is the
// normal form BEFORE a commit.
test("LOC_ROOTS covers EVERY tracked source file of the repo", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((f) => LOC_EXTENSIONS.has(path.extname(f)))
    .filter((f) => !f.split("/").slice(0, -1).some((seg) => SKIP_DIRS.has(seg)))
    .filter((f) => fs.existsSync(path.join(REPO, f)));
  assert.ok(tracked.length > 400, `only ${tracked.length} tracked source files — is git ls-files working?`);

  const seen = new Set(locScan(REPO).map((f) => f.rel));
  const blind = tracked.filter((f) => !seen.has(f));
  console.log(`  [guard] ${seen.size} files under ${LOC_ROOTS.length} roots, ${tracked.length} tracked sources — ${blind.length} of them unseen`);
  assert.deepEqual(
    blind,
    [],
    "These tracked source files lie outside LOC_ROOTS — the guard does not see them, " +
      "so they can never grow past the limit: " + blind.slice(0, 10).join(", "),
  );

  // `ops` is the private part of a clone: a public clone has no such folder, and a root that is not there scans nothing.
  const OPTIONAL = new Set(["ops"]);
  for (const r of LOC_ROOTS) {
    if (OPTIONAL.has(r)) continue;
    assert.ok(fs.existsSync(path.join(REPO, r)), `Root "${r}" no longer exists — update the list`);
  }
});

// ── The real repo ────────────────────────────────────────────────────────────────────────────
//
// The guard is green and EVERY list entry covers a real overrun: number of covered files == number of entries. If one of
// the files is cut, its entry falls over — and this test says which.
test("locGate(REPO): ok today, and the exception list covers exactly its entries", () => {
  const entries = readAllow(ALLOW_FILE).entries;
  const v = locGate(REPO);
  assert.deepEqual(v.violations.map((f) => `${f.rel} (${f.rows})`), [], "file over the limit without an exception");
  assert.deepEqual(v.tot.map((e) => `${e.file} (${e.rows})`), [], "dead entry — shorten the list");
  assert.equal(v.ok, true);
  assert.equal(v.covered.length, entries.length);
  assert.deepEqual(v.covered.map((f) => f.rel).sort(), entries.map((e) => e.file).sort());
  // Counter-proof on the real stock: without the list every covered item would be a violation.
  const without = locVerdict(locScan(REPO), { limit: LOC_LIMIT, entries: [] });
  assert.equal(without.ok, false);
  assert.equal(without.violations.length, entries.length);
});
