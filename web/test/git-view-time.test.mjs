// The timeline of the git overview. The leaf web/src/lib/git-view-time.ts is compiled with tsc and EXECUTED. The promises,
// each with the way that breaks it:
//   (a) Window: "7d"/"30d" end now and reach back 7 or 30 days; "everything" from the oldest branch point to now (at least one day);
//       the windows are EXACTLY those of the contract (server/backend/electron/server/gitView/contract.js WINDOW); a foreign value
//       is no window. Window change: the same point in time moves to the right in the longer window;
//   (b) Time → x always lies in [0, 1] (before 0, after 1);
//   (c) Clipping: a branch point before the window stands at the edge (x0 = 0) and carries the mark (`clipped`) — not in the longer window;
//   (d) Points/bars: `points === null` ⇒ one bar over the lane with the count; otherwise one point per commit in the window (unpushed
//       stays unpushed), those before it counted, not drawn; not-fetched separately; WITHOUT a main branch (the server then sends
//       `line: { commits: null, count: 0 }` and per row `points: null, count: null`) no main line and no bar — before, a bar over the
//       whole width with "0" stood there, and every row looked like "more than 15";
//   (e) Axis and age: at most `max` marks, ascending, in [0, 1]; the age in min/h/d.
// COUNTER-PROOF (built in, (f)): a copy of the leaf with clipping removed (`clipped` always false, x0 without clamp), one with
// points instead of a bar at `points === null` and one with the old bar without a main branch — the checks from (c)/(d) throw against
// each, otherwise they measure nothing.
//
// Run:  node --test web/test/git-view-time.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as V from "../../server/backend/electron/server/gitView/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const lib = path.join(webDir, "src", "lib");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const source = fs.readFileSync(path.join(lib, "git-view-time.ts"), "utf8");

const temps = [];
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } } });

// Compiles a version of the leaf in its own folder — together with the types it reads from lib/api/ (`import type`), so that a
// sabotage copy is also checked against the real contract type.
async function load(text, name) {
  assert.ok(fs.existsSync(tsc), "web/node_modules is missing (tsc) — the leaf cannot be checked without the compiler");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cbase-git-view-time-${name}-`));
  temps.push(d);
  fs.mkdirSync(path.join(d, "src", "api"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "git-view-time.ts"), text);
  for (const f of ["gitView.ts", "core.ts"]) fs.copyFileSync(path.join(lib, "api", f), path.join(d, "src", "api", f));
  execFileSync(process.execPath, [
    tsc, path.join(d, "src", "git-view-time.ts"), "--rootDir", path.join(d, "src"), "--outDir", path.join(d, "out"),
    "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  return import(pathToFileURL(path.join(d, "out", "git-view-time.js")).href);
}

const Z = await load(source, "real");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

// The checks from (c) and (d) as functions — green against the real leaf, red against every sabotage (f).
function checkClip(M) {
  const b7 = M.windowArea("7d", NOW);
  const b30 = M.windowArea("30d", NOW);
  const s = M.laneOf(NOW - 10 * DAY, NOW - DAY, b7);
  assert.equal(s.x0, 0, "a branch point before the window stands at the edge");
  assert.equal(s.clipped, true, "a branch point before the window carries the mark «");
  assert.equal(s.branchPoint, NOW - 10 * DAY, "the mark knows the date of the branch point");
  assert.ok(s.x1 > 0.8 && s.x1 < 1, `the lane reaches to the last commit (x1 = ${s.x1})`);
  const s30 = M.laneOf(NOW - 10 * DAY, NOW - DAY, b30);
  assert.equal(s30.clipped, false, "in the longer window the same branch point lies inside");
  assert.ok(Math.abs(s30.x0 - 20 / 30) < 1e-9, `x0 in the 30-day window (${s30.x0})`);
  const inside = M.laneOf(NOW - 3 * DAY, null, b7);
  assert.equal(inside.clipped, false);
  assert.ok(Math.abs(inside.x0 - 4 / 7) < 1e-9 && inside.x1 === inside.x0, "without a last commit the lane ends at the branch point");
}
function checkPointsProgressBar(M) {
  const b7 = M.windowArea("7d", NOW);
  const lane = M.laneOf(NOW - 5 * DAY, NOW - DAY, b7);
  const progressBar = M.displayOf({ points: null, count: 40, notFetched: null }, lane, b7);
  assert.deepEqual(progressBar, { kind: "progressBar", x0: lane.x0, x1: lane.x1, count: 40 }, "points === null ⇒ bar with count over the lane");
  const points = M.displayOf({
    points: [{ t: NOW - 9 * DAY, pushed: true }, { t: NOW - 4 * DAY, pushed: true }, { t: NOW - DAY, pushed: false }],
    count: 3, notFetched: [NOW - 2 * DAY, NOW - 20 * DAY],
  }, lane, b7);
  assert.equal(points.kind, "points");
  assert.equal(points.points.length, 2, "only the commits in the window become points");
  assert.equal(points.prior, 1, "the commit before the window is counted");
  assert.deepEqual(points.points.map((p) => p.pushed), [true, false], "an unpushed commit stays hollow");
  assert.equal(points.notFetched.length, 1, "not-fetched before the window drops out");
  assert.ok(Math.abs(points.notFetched[0] - 5 / 7) < 1e-9);
  assert.equal(M.displayOf(null, lane, b7), null, "nothing without commits — never an empty bar");
}
// Without a main branch: no line, no bar (neither at the top nor on a row) — the timeline says "no main branch detected".
function checkWithoutMainBranch(M) {
  const b = M.windowArea("30d", NOW);
  assert.equal(M.lineOf(false, null, 0, b), null, "no line without a main branch — never a bar over the whole width with \"0\"");
  assert.equal(M.lineOf(false, [NOW - DAY], 1, b), null, "no line without a main branch, even if times came along");
  assert.equal(M.lineOf(true, null, 0, b), null, "a line without points and without a count is no bar");
  const lane = M.laneOf(null, NOW - DAY, b);
  assert.equal(M.displayOf({ points: null, count: null, notFetched: null }, lane, b), null,
    "`points: null, count: null` (without a main branch) is no bar like \"more than 15\"");
}

test("(a) window: 7d/30d end now, \"everything\" from the oldest branch point, exactly the windows of the contract", () => {
  assert.deepEqual(Object.keys(Z.WINDOW_DAYS), [...V.WINDOW], "WINDOW_DAYS ≠ WINDOW of the contract");
  assert.equal(Z.windowFrom(V.WINDOW_DEFAULT), V.WINDOW_DEFAULT);
  for (const foreign of ["14t", "", null, 7, "toString", "constructor"]) assert.equal(Z.windowFrom(foreign), null, `"${String(foreign)}" is no window`);
  // A window remembered in this browser before the rename (the "t" of the German "Tage") keeps applying as its new key.
  assert.deepEqual([Z.windowFrom("7t"), Z.windowFrom("30t")], ["7d", "30d"], "an old remembered window is lost");
  assert.deepEqual(Z.windowArea("7d", NOW), [NOW - 7 * DAY, NOW]);
  assert.deepEqual(Z.windowArea("30d", NOW), [NOW - 30 * DAY, NOW]);
  const old = NOW - 90 * DAY;
  assert.equal(Z.oldestBranchPoint([NOW - DAY, null, old, undefined, NOW - 3 * DAY]), old);
  assert.equal(Z.oldestBranchPoint([null, undefined]), null);
  assert.deepEqual(Z.windowArea("everything", NOW, old), [old, NOW], "\"everything\" begins at the oldest branch point");
  assert.deepEqual(Z.windowArea("everything", NOW, null), [NOW - DAY, NOW], "without a branch point one day");
  assert.deepEqual(Z.windowArea("everything", NOW, NOW - 3_600_000), [NOW - DAY, NOW], "at least one day wide");
  // Window change: the same point in time (3 days ago) stands further left in the 7-day window than in the 30-day window.
  const t = NOW - 3 * DAY;
  const x7 = Z.xOf(t, Z.windowArea("7d", NOW));
  const x30 = Z.xOf(t, Z.windowArea("30d", NOW));
  assert.ok(Math.abs(x7 - 4 / 7) < 1e-9 && Math.abs(x30 - 27 / 30) < 1e-9 && x30 > x7, `Fensterwechsel: ${x7} → ${x30}`);
});

test("(b) time → x: before 0, after 1, an area without width is 1", () => {
  const b = [1000, 2000];
  assert.equal(Z.xOf(500, b), 0);
  assert.equal(Z.xOf(1500, b), 0.5);
  assert.equal(Z.xOf(5000, b), 1, "a clock in the future pushes nothing over the edge");
  assert.equal(Z.xOf(1500, [2000, 2000]), 1);
});

test("(c) clipping: branch point before the window ⇒ edge with mark «, not in the longer window", () => {
  checkClip(Z);
  assert.equal(Z.laneOf(null, null, Z.windowArea("7d", NOW)), null, "no lane without a branch point and commit");
});

test("(d) Points and ProgressBar: `points === null` ⇒ ProgressBar including Count; Mainline ebenso; without MainBranch beides not", () => {
  checkPointsProgressBar(Z);
  checkWithoutMainBranch(Z);
  const b = Z.windowArea("30d", NOW);
  assert.deepEqual(Z.lineOf(true, null, 812, b), { kind: "progressBar", x0: 0, x1: 1, count: 812 }, "main line without points: one bar over the window");
  const l = Z.lineOf(true, [NOW - 40 * DAY, NOW - 10 * DAY, NOW], 3, b);
  assert.equal(l.kind, "points");
  assert.deepEqual(l.points.map((p) => p.x), [20 / 30, 1]);
  assert.equal(l.prior, 1);
});

test("(e) axis at most max marks, ascending, in [0, 1]; age in min/h/d", () => {
  for (const [window, oldest] of [["7d", null], ["30d", null], ["everything", NOW - 400 * DAY], ["everything", NOW - 3 * DAY]]) {
    const b = Z.windowArea(window, NOW, oldest);
    const m = Z.axisMarkers(b, 6);
    assert.ok(m.length >= 2 && m.length <= 6, `${window}: ${m.length} Marken`);
    for (let i = 0; i < m.length; i++) {
      assert.ok(m[i].x >= 0 && m[i].x <= 1 && m[i].t >= b[0] && m[i].t <= b[1], `${window}: mark ${i} outside`);
      if (i > 0) assert.ok(m[i].t > m[i - 1].t, `${window}: not ascending`);
    }
  }
  assert.deepEqual(Z.axisMarkers([5, 5]), []);
  assert.equal(Z.shortAge(null, NOW), null);
  assert.deepEqual(Z.shortAge(NOW + 60_000, NOW), { key: "just now", n: 0 });
  assert.deepEqual(Z.shortAge(NOW - 10 * 60_000, NOW), { key: "{n} min", n: 10 });
  assert.deepEqual(Z.shortAge(NOW - 2 * 3_600_000, NOW), { key: "{n} h", n: 2 });
  assert.deepEqual(Z.shortAge(NOW - 9 * DAY, NOW), { key: "{n} d", n: 9 });
});

test("(f) counter-proof: the checks throw against a leaf without clipping or with points instead of a bar", async () => {
  const withoutClip = source
    .replace("clipped: branchPoint !== null && branchPoint < area[0]", "clipped: false")
    .replace("const x0 = xOf(beginning, area);", "const x0 = (beginning - area[0]) / (area[1] - area[0]);");
  assert.notEqual(withoutClip, source, "the sabotage no longer applies (wording in laneOf changed?)");
  const withoutProgressBar = source.replace("if (commits.points === null) {", "if (commits.points === undefined) {");
  assert.notEqual(withoutProgressBar, source, "the sabotage no longer applies (wording in displayOf changed?)");
  // The old state without a main branch: a bar even without a count, and the main line does not ask for the main branch.
  let oldProgressBar = source;
  for (const [old, fresh] of [
    ["if (!lane || commits.count === null) return null;", "if (!lane) return null;"],
    ["count: commits.count };", "count: commits.count ?? 0 };"],
    ["  if (!mainBranch) return null;\n", ""],
    ["return count !== null && count > 0 ? { kind: \"progressBar\", x0: 0, x1: 1, count } : null;", "return { kind: \"progressBar\", x0: 0, x1: 1, count: count ?? 0 };"],
  ]) {
    assert.ok(oldProgressBar.includes(old), `the sabotage "old bar" no longer applies (${old})`);
    oldProgressBar = oldProgressBar.replace(old, fresh);
  }
  const [A, B, C] = await Promise.all([
    load(withoutClip, "without-clip"),
    load(withoutProgressBar.replace("commits.points.filter", "(commits.points ?? []).filter").replace("commits.points.length", "(commits.points ?? []).length"), "without-progress-bar"),
    load(oldProgressBar, "old-progress-bar"),
  ]);
  assert.throws(() => checkClip(A), "check (c) does not measure the clipping");
  assert.throws(() => checkPointsProgressBar(B), "check (d) does not measure the bar");
  assert.throws(() => checkWithoutMainBranch(C), "check (d) does not measure \"without a main branch\"");
});
