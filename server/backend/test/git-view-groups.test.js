// Guards for the rows of the git overview — gitView/groups.js, pure: the readings are written here by hand (shape like gitView/read.js
// parseReading; that the real reading looks like this is held by git-view-read.test.js).
//
// What it proves, each with the sabotage that breaks it:
//   (1) All four groups in contract order, each by last commit descending: checkedOut (folder itself, foreign worktree, detached HEAD as
//       "detached @ <short-sha>"), branches, cbase (also checked out and as a remote row), remote; the ref of the main branch is no row.
//   (2) Pairing via the upstream configuration: a differing name and a second remote are ONE row, a same-named branch without upstream
//       stays two rows — broken by any pairing via the name.
//   (3) Copy: only new and moved against the snapshot; a branch moved in main does NOT appear as a copy row; the moved one sits
//       directly under the main row (its group), with sinceCreation; the unchanged checked-out one of the copy hangs on the main row; a
//       remote ref both fetched identically is no duplicate.
//   (4) Points and not-fetched at the boundary POINTS_MAX (15 points, 16 bars).
//   (5) Search before the cap ROWS_MAX, `clipped` says so.
//   (6) Fields exactly per contract.js; user, state and chats stay null.
import test from "node:test";
import assert from "node:assert/strict";
import { lineFrom, rowsFrom, LINE_MAX } from "../electron/server/gitView/groups.js";
import { CHECKED_OUT_FIELDS, GROUPS, POINTS_MAX, ROWS_MAX, ROW_FIELDS } from "../electron/server/gitView/contract.js";

const H = "refs/remotes/origin/main";
let n = 0;
const oid = () => (++n).toString(16).padStart(40, "0");

// A tip as parseReading delivers it.
function sp(ref, { t = 1000, kind, upstream = null, toUpstream = null, ahead = 1, back = 0, points, notFetched = null, o = oid(), old, sinceCreation = null } = {}) {
  const a = kind || (ref.startsWith("refs/heads/") ? "local" : "remote");
  return {
    ref, name: ref.replace(/^refs\/(heads|remotes)\//, ""), kind: a, oid: o, upstream,
    toUpstream: upstream ? toUpstream || { ahead: 0, back: 0 } : null,
    last: { t, author: "Ada", subject: `for ${ref}` },
    toMain: { ahead, back, merged: ahead === 0 }, branchPoint: t - 500,
    points: points ?? Array.from({ length: Math.min(ahead, POINTS_MAX + 1) }, (_, i) => ({ t: t - i, pushed: true })).reverse(),
    count: ahead, notFetched, inSnapshot: old, sinceCreation,
  };
}
const detachedRef = (o, t = 1000) => ({ ...sp("x", { t, o }), ref: null, name: o, kind: "detached", upstream: null, toUpstream: null });
const reading = (tips, worktrees = []) => ({
  read: true, deep: false, mainBranch: { name: "main", source: "origin/HEAD", ref: H, oid: "a".repeat(40) },
  remoteState: { at: null, source: "unknown" }, tips, worktrees, line: { commits: [1, 2, 3], count: 3 },
});
const wt = (branch, { main = false, path = main ? "/p/repo" : `/run/${branch}`, oid: o = null, notBackedUp = 0 } = {}) => ({
  path, main, branch: o ? null : branch, oid: o, detached: Boolean(o), notBackedUp,
});
const row = (rows, name, instance = "main") => rows.find((z) => z.name === name && z.instance === instance);

test("(1)(2) four groups, sorting, pairing via the configuration", () => {
  const detachedOid = "abcdef1234567890abcdef1234567890abcdef12";
  const l = reading([
    sp(H, { t: 9999 }),
    sp("refs/heads/main", { t: 9000, upstream: H, ahead: 0 }),
    sp("refs/heads/feature/a", { t: 500 }),
    sp("refs/heads/feature/wt", { t: 600 }),
    sp("refs/heads/feature/c", { t: 700, upstream: "refs/remotes/origin/c-new", toUpstream: { ahead: 2, back: 1 } }),
    sp("refs/remotes/origin/c-new", { t: 650 }),
    sp("refs/heads/x2", { t: 710, upstream: "refs/remotes/second/x" }),
    sp("refs/remotes/second/x", { t: 705 }),
    sp("refs/remotes/origin/x", { t: 300 }),
    sp("refs/heads/feature/d", { t: 800 }),
    sp("refs/remotes/origin/feature/d", { t: 790 }),
    sp("refs/heads/cbase/agent-1", { t: 100 }),
    sp("refs/heads/copy/k1/feature", { t: 900 }),
    sp("refs/remotes/origin/cbase/agent-2", { t: 50 }),
    sp("refs/remotes/origin/spike", { t: 400 }),
    detachedRef(detachedOid, 1200),
  ], [
    wt("refs/heads/feature/a", { main: true, notBackedUp: 4 }),
    wt("refs/heads/feature/wt", { notBackedUp: 1 }),
    wt("refs/heads/cbase/agent-1"),
    wt(null, { oid: detachedOid, path: "/run/los" }),
  ]);
  const { rows, clipped } = rowsFrom({ main: l });
  assert.equal(clipped, null);
  const names = (g) => rows.filter((z) => z.group === g).map((z) => z.name);
  assert.deepEqual(names("checkedOut"), ["detached @ abcdef1", "feature/wt", "feature/a"]);
  assert.deepEqual(names("branches"), ["main", "feature/d", "x2", "feature/c"]);
  assert.deepEqual(names("cbase"), ["copy/k1/feature", "cbase/agent-1", "origin/cbase/agent-2"]);
  assert.deepEqual(names("remote"), ["origin/feature/d", "origin/spike", "origin/x"]);
  assert.deepEqual([...new Set(rows.map((z) => z.group))], GROUPS.filter((g) => names(g).length), "groups in contract order");
  assert.ok(!rows.some((z) => z.name === "origin/main"), "the main branch is the line, not a row");
  assert.ok(!rows.some((z) => z.name === "origin/c-new" || z.name === "second/x"), "paired");
  // Pairing
  const c = row(rows, "feature/c");
  assert.deepEqual([c.local, c.remote, c.toRemote], [true, "origin/c-new", { ahead: 2, back: 1 }]);
  assert.equal(row(rows, "x2").remote, "second/x");
  assert.equal(row(rows, "origin/x").remote, "origin/x");
  assert.deepEqual([row(rows, "feature/d").remote, row(rows, "feature/d").toRemote], [null, null], "same name without upstream is no pairing");
  assert.equal(row(rows, "origin/feature/d").local, false);
  assert.equal(row(rows, "main").remote, "origin/main", "the local main stays a row");
  // checkedOut entries
  assert.deepEqual(row(rows, "feature/a").checkedOut, [{ instance: "main", worktree: null, notBackedUp: 4, chats: null }]);
  assert.deepEqual(row(rows, "feature/wt").checkedOut, [{ instance: "main", worktree: "/run/refs/heads/feature/wt", notBackedUp: 1, chats: null }]);
  assert.equal(row(rows, "cbase/agent-1").checkedOut.length, 1, "checked out and still cbase");
  const l0 = row(rows, "detached @ abcdef1");
  assert.deepEqual([l0.detached, l0.local, l0.remote], [{ sha: detachedOid }, true, null]);
});

test("(3) copy: only new and moved against the snapshot, under the main row", () => {
  const A1 = oid(); const A2 = oid(); const B1 = oid(); const B2 = oid(); const C = oid(); const R1 = oid(); const R2 = oid();
  const main = reading([
    sp("refs/heads/feature/a", { t: 3000, o: A2 }), // moved in main since the freeze (A1 -> A2)
    sp("refs/heads/feature/b", { t: 1000, o: B1 }),
    sp("refs/heads/feature/c", { t: 500, o: C }),
    sp("refs/heads/feature/d", { t: 400 }),
    sp("refs/remotes/origin/fetched", { t: 200, o: R2 }),
  ], [wt("refs/heads/main", { main: true })]);
  const copy = reading([
    sp("refs/heads/feature/a", { t: 2000, o: A1, old: A1 }), // unchanged in the copy
    sp("refs/heads/feature/b", { t: 2500, o: B2, old: B1, sinceCreation: { ahead: 1, back: 0 } }),
    sp("refs/heads/feature/c", { t: 500, o: C, old: C }), // unchanged, but checked out in the copy
    sp("refs/heads/fresh/x", { t: 2600, old: null }),
    sp("refs/heads/back", { t: 100, old: oid(), sinceCreation: { ahead: 0, back: 2 } }),
    sp("refs/remotes/origin/fetched", { t: 200, o: R2, old: R1 }), // fetched in the copy, the same state in main
    sp("refs/remotes/origin/only-copy", { t: 210, old: null }),
  ], [wt("refs/heads/feature/c", { main: true, path: "/p/repo", notBackedUp: 3 })]);
  const { rows } = rowsFrom({ main, copies: [{ name: "k1", reading: copy }] });
  const k = rows.filter((z) => z.instance === "k1").map((z) => z.name);
  assert.ok(!k.includes("feature/a"), "a branch moved in main is no copy row");
  assert.ok(!k.includes("origin/fetched"), "the same fetched state is no duplicate");
  assert.deepEqual(k.sort(), ["back", "feature/b", "fresh/x", "origin/only-copy"].sort());
  // the moved one directly under the main row, in its group, with sinceCreation
  const i = rows.findIndex((z) => z.name === "feature/b" && z.instance === "main");
  assert.deepEqual([rows[i + 1].name, rows[i + 1].instance, rows[i + 1].group], ["feature/b", "k1", rows[i].group]);
  assert.deepEqual(rows[i + 1].sinceCreation, { ahead: 1, back: 0 });
  assert.equal(rows[i].sinceCreation, null, "the main row carries no sinceCreation");
  // new refs: own row in their group, sinceCreation null
  assert.deepEqual([row(rows, "fresh/x", "k1").group, row(rows, "fresh/x", "k1").sinceCreation], ["branches", null]);
  assert.deepEqual(row(rows, "back", "k1").sinceCreation, { ahead: 0, back: 2 });
  assert.equal(row(rows, "origin/only-copy", "k1").group, "remote");
  // the unchanged checked-out one of the copy hangs on the main row and makes it "checkedOut"
  const c = row(rows, "feature/c");
  assert.equal(c.group, "checkedOut");
  assert.deepEqual(c.checkedOut, [{ instance: "k1", worktree: null, notBackedUp: 3, chats: null }]);
  // without a read main: the copy rows stand alone
  const alone = rowsFrom({ main: { read: false, reason: "stopped" }, copies: [{ name: "k1", reading: copy }] }).rows;
  assert.ok(alone.every((z) => z.instance === "k1"));
  assert.deepEqual(row(alone, "feature/c", "k1").checkedOut.map((e) => e.instance), ["k1"], "checked out without a main row: own row");
  // order of the copies under the same main row
  const k2 = reading([sp("refs/heads/feature/b", { t: 2700, old: B1, sinceCreation: { ahead: 2, back: 0 } })]);
  const two = rowsFrom({ main, copies: [{ name: "k1", reading: copy }, { name: "k2", reading: k2 }] }).rows;
  const j = two.findIndex((z) => z.name === "feature/b" && z.instance === "main");
  assert.deepEqual(two.slice(j, j + 3).map((z) => z.instance), ["main", "k1", "k2"]);
});

test("(4) points and not-fetched at the boundary POINTS_MAX", () => {
  const g = Array.from({ length: POINTS_MAX }, (_, i) => i);
  const l = reading([
    sp("refs/heads/fifteen", { ahead: POINTS_MAX, upstream: "refs/remotes/origin/fifteen", notFetched: g }),
    sp("refs/remotes/origin/fifteen"),
    sp("refs/heads/sixteen", { ahead: POINTS_MAX + 1, upstream: "refs/remotes/origin/sixteen", notFetched: [...g, 99] }),
    sp("refs/remotes/origin/sixteen"),
  ]);
  const { rows } = rowsFrom({ main: l });
  const f = row(rows, "fifteen").commits;
  assert.equal(f.points.length, POINTS_MAX);
  assert.equal(f.count, POINTS_MAX);
  assert.deepEqual(f.notFetched, g);
  const s = row(rows, "sixteen").commits;
  assert.deepEqual([s.points, s.count, s.notFetched], [null, POINTS_MAX + 1, null]);
  // without a main branch: points and count null
  const without = { ...reading([{ ...sp("refs/heads/dev"), toMain: null, branchPoint: null, points: null, count: null }]), mainBranch: null };
  const d = rowsFrom({ main: without }).rows[0];
  assert.deepEqual([d.toMain, d.branchPoint, d.commits], [null, null, { points: null, count: null, notFetched: null }]);
});

test("(5) search before the cap ROWS_MAX", () => {
  const many = [];
  for (let i = 0; i < ROWS_MAX + 50; i++) many.push(sp(`refs/heads/x-${i}`, { t: i }));
  for (let i = 0; i < 10; i++) many.push(sp(`refs/heads/Search-${i}`, { t: 10_000 + i }));
  const l = reading(many);
  const all = rowsFrom({ main: l });
  assert.equal(all.rows.length, ROWS_MAX);
  assert.deepEqual(all.clipped, { shown: ROWS_MAX, total: ROWS_MAX + 60 });
  assert.equal(all.rows[0].name, "Search-9", "the youngest first");
  const s = rowsFrom({ main: l, search: "  sEARCH " });
  assert.equal(s.clipped, null);
  assert.deepEqual(s.rows.map((z) => z.name), Array.from({ length: 10 }, (_, i) => `Search-${9 - i}`));
  const x = rowsFrom({ main: l, search: "x-" });
  assert.deepEqual(x.clipped, { shown: ROWS_MAX, total: ROWS_MAX + 50 });
  assert.deepEqual(rowsFrom({ main: l, search: "exists-not" }), { rows: [], clipped: null });
});

test("(6) fields exactly per contract.js; user, state, chats stay null; line", () => {
  const l = reading([sp("refs/heads/a", { upstream: "refs/remotes/origin/a" }), sp("refs/remotes/origin/a")], [wt("refs/heads/a", { main: true })]);
  const [z] = rowsFrom({ main: l }).rows;
  assert.deepEqual(Object.keys(z), [...ROW_FIELDS]);
  assert.deepEqual(Object.keys(z.checkedOut[0]), [...CHECKED_OUT_FIELDS]);
  assert.deepEqual([z.user, z.state, z.checkedOut[0].chats], [null, null, null]);
  assert.ok(!("_sp" in z) && !("_ref" in z));
  assert.deepEqual(Object.keys(z.commits), ["points", "count", "notFetched"]);
  assert.deepEqual(Object.keys(z.last), ["t", "author", "subject"]);
  // Line
  assert.deepEqual(lineFrom(l), { commits: [1, 2, 3], count: 3, from: 1, until: 3 });
  assert.deepEqual(lineFrom({ read: false, reason: "time" }), { commits: null, count: 0, from: null, until: null });
  assert.deepEqual(lineFrom({ ...l, mainBranch: null }).commits, null);
  const lang = { ...l, line: { commits: Array.from({ length: LINE_MAX + 5 }, (_, i) => i), count: LINE_MAX + 5 } };
  const li = lineFrom(lang);
  assert.deepEqual([li.commits.length, li.count, li.from, li.until], [LINE_MAX, LINE_MAX + 5, 5, LINE_MAX + 4]);
});
