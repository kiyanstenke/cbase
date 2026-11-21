// The git bar graph over all branches: the pure lane computation src/lib/git-graph.ts and the allowlist
// src/lib/api/git.ts `normGitGraphLog`, EXECUTED, not re-implemented: both sources are compiled with the local tsc and imported
// (model: git-bar.test.mjs).
//
// What the computation carries and why it is a latch:
// - Lanes (swimlanes like VS Code): column of the dot, passing lanes, merges (two children of one parent), further parents
//   (merge, octopus), two roots, parents outside the window (the line runs to the edge). A wrong column draws a commit on the
//   wrong branch, and nobody would see it because every row looks plausible on its own.
// - Colours: the HEAD branch lane is always cobalt (even where another lane to its left joins the same commit), a lane keeps
//   its colour over all its rows, "Load more" recolours nothing (the computation only depends on the rows above), a new lane
//   takes the colour of its name unless its neighbour already wears it; a remote branch and its local one share the colour.
// - A missing field is no statement: without parents (old server) the graph draws linearly; the allowlist drops unknown ref
//   kinds and says `null` where the server says nothing.
// - The cap says that it is one (`loadMore`), the geometry clips with a collecting column instead of silently cutting off, and
//   the badges fold the remote branch into the local one on the same commit.
// - The expanded commit: next to its file rows EXACTLY the lanes continue that pass between its row and the next
//   (`continuousLanes`), its own as a bar — a root only in a free column. The file rows (lib/git-files.ts) carry the colours
//   and letters of "Changes", bound to `classify` in the server; a path with "-" goes as ./-x. The allowlists
//   (`normGitCommitFiles`, `normGitCommitFileDiff`) never turn the answer of an old server into "no files" or into the diff of
//   the file.
// Plus the BINDING: GitGraph.tsx calls the computations, loads only through the path builder of the bar and without its own
// timer (only with the repo state, the extent, the "Refresh" button; the files of a commit on first expand), and GitSidebar.tsx
// mounts it in the "Graph" section.
//
// COUNTER-PROOFS built in: sabotages on copies of the source (one place each) are compiled along, the check `check` must throw
// on each; plus sabotages on the component source text for the binding.
//
// Run:  node --test web/test/git-graph.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const SOURCE = path.join(webDir, "src", "lib", "git-graph.ts");
const API = path.join(webDir, "src", "lib", "api", "git.ts");
const source = fs.readFileSync(SOURCE, "utf8");

const SABOTAGES = {
  "HEAD is not cobalt": { old: `const color: LaneColor = c.head || cobaltIncluded ? "accent"`, fresh: `const color: LaneColor = cobaltIncluded ? "accent"` },
  "cobalt lost on merge": { old: `const cobaltIncluded = one.some((s) => s.id === c.hash && s.color === "accent");`, fresh: `const cobaltIncluded = false;` },
  "a tip takes column 0": { old: `const column = hits >= 0 ? hits : one.length;`, fresh: `const column = hits >= 0 ? hits : 0;` },
  "further parent without lane": { old: `      branching.push({ to: outgoing.length, color: f });\n      outgoing.push({ id: p, color: f });`, fresh: `` },
  "second lane to the same parent": { old: `      if (present >= 0) { if (present !== column) branching.push({ to: present, color: outgoing[present].color }); continue; }\n`, fresh: `` },
  "neighbour colour not avoided": { old: `laneColorFor(tipsName(c), [...(one.length ? [one[one.length - 1].color] : []), ...(prior !== undefined ? [prior] : [])])`, fresh: `laneColorFor(tipsName(c), [])` },
  "merge lane in the colour of the ending one": { old: `, ...incoming.map((x) => x.color), ...(one[outgoing.length] ? [one[outgoing.length].color] : [])]`, fresh: `]` },
  "remote branch own colour": { old: `r.kind === "remote" ? r.name.slice(r.name.indexOf("/") + 1) : r.name`, fresh: `r.name` },
  "without parents not linear": { old: `const linear = commits.some((c) => parentOf(c) === null);`, fresh: `const linear = false;` },
  "merged lane keeps running": { old: `        else incoming.push({ from: k, color: s.color });\n        return;`, fresh: `        else { incoming.push({ from: k, color: s.color }); through.push({ from: k, to: outgoing.length, color: s.color }); outgoing.push(s); }\n        return;` },
  "remote not folded into the local one": { old: `      if (target && !target.remote) { target.remote = r.name; continue; }\n`, fresh: `` },
  "loadMore believes the length": { old: `const maybe = clipped === null ? loaded >= limit : clipped;`, fresh: `const maybe = loaded >= limit;` },
  "no clipping": { old: `  if (n * LANE_MIN_PX <= slot) return`, fresh: `  if (true) return` },
  "extent accepts nonsense": { old: `return raw === "current" ? "current" : "all";`, fresh: `return (raw || "all") as GraphExtent;` },
  "state without ahead/behind": { old: `r.upstream ?? "", Number(r.ahead) || 0, Number(r.behind) || 0].join`, fresh: `r.upstream ?? ""].join` },
  // The expanded commit: the lanes next to its file rows.
  "root without bar": { old: `  if (!z.bottom && z.column >= z.outgoing.length) outgoing.push({ column: z.column, color: z.color, own: true });\n`, fresh: `` },
  "root bar over a foreign lane": { old: `if (!z.bottom && z.column >= z.outgoing.length) outgoing.push(`, fresh: `if (!z.bottom) outgoing.push(` },
  "no own lane": { old: `own: z.bottom && k === z.column }));`, fresh: `own: false }));` },
  "only the own lane": { old: `own: z.bottom && k === z.column }));`, fresh: `own: z.bottom && k === z.column })).filter((s) => s.own);` },
  "lanes from above instead of downwards": { old: `const outgoing: ThroughLane[] = z.outgoing.map(`, fresh: `const outgoing: ThroughLane[] = z.one.map(` },
};
// The file rows (src/lib/git-files.ts) — one place each; `checkFiles` must throw on each.
const FILES = path.join(webDir, "src", "lib", "git-files.ts");
const filesSource = fs.readFileSync(FILES, "utf8");
const SABOTAGES_FILES = {
  "\"-x\" without ./": { old: "return path.startsWith(\"-\") ? `./${path}` : path;", fresh: "return path;" },
  "copy not like classify": { old: `C: { kind: "renamed", label: "copied" },`, fresh: `C: { kind: "added", label: "copied" },` },
  "lock file as JSON": { old: `if (LOCK_NAME.has(name) || name.endsWith(".lock"))`, fresh: `if (name.endsWith(".lock"))` },
  "extension by letter case": { old: `const name = partsPath(path).name.toLowerCase();`, fresh: `const name = partsPath(path).name;` },
  "deleted not struck through": { old: `deleted: a.kind === "deleted" };`, fresh: `deleted: false };` },
  "letter not like \"Changes\"": { old: `letter: KIND_LETTER[a.kind] ?? status,`, fresh: `letter: status,` },
};
// The allowlists of the expanded commit (src/lib/api/git.ts) — one place each; `checkCommitNorm` must throw on each.
const apiSource = fs.readFileSync(API, "utf8");
const SABOTAGES_API = {
  "old server as empty list": { old: `  if (!Array.isArray(o.files)) return null;\n  const files: GitCommitFile[] = [];`, fresh: `  const files: GitCommitFile[] = [];\n  if (!Array.isArray(o.files)) return { hash: "", parent: null, files, total: null, clipped: null, unreadable: 0 };` },
  "diff without path echo": { old: `if (!path || o.path !== path || typeof o.diff !== "string") return null;`, fresh: `if (typeof o.diff !== "string") return null;` },
  "unreadable silently dropped": { old: `{ unreadable += 1; continue; }`, fresh: `{ continue; }` },
};

// Compile: the real source, the allowlist and one copy per sabotage, in ONE tsc run (each file a leaf without imports).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-graph-"));
const src = path.join(tmp, "src");
const out = path.join(tmp, "out");
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, "real.ts"), source);
fs.writeFileSync(path.join(src, "api-git.ts"), apiSource);
fs.writeFileSync(path.join(src, "git-files.ts"), filesSource);
const copies = (sabotages, template, prefix) => Object.entries(sabotages).map(([name, { old, fresh }], i) => {
  const file = `${prefix}-${i}.ts`;
  fs.writeFileSync(path.join(src, file), template.replace(old, fresh));
  return { name, file, applies: template.includes(old) };
});
const sabotageFiles = copies(SABOTAGES, source, "sabotage");
const sabotageFileLines = copies(SABOTAGES_FILES, filesSource, "sabotage-files");
const sabotageApi = copies(SABOTAGES_API, apiSource, "sabotage-api");
execFileSync(process.execPath, [
  tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict",
], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("real.ts");
const apiGit = await load("api-git.ts");
const fileLines = await load("git-files.ts");
const sabotaged = await Promise.all(sabotageFiles.map(async (s) => ({ ...s, mod: await load(s.file) })));
const sabotagedFileLines = await Promise.all(sabotageFileLines.map(async (s) => ({ ...s, mod: await load(s.file) })));
const sabotagedApi = await Promise.all(sabotageApi.map(async (s) => ({ ...s, mod: await load(s.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed:", String(e?.message || e).slice(0, 120)); }

// ── Bausteine ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// One commit: `C("a", ["b"], { head: true, refs: [...] })`.
const C = (hash, parents, x = {}) => ({ hash, parents, ...x });
const columns = (r) => r.rows.map((z) => z.column);
const colors = (r) => r.rows.map((z) => z.color);
// The continuation: what a row passes down arrives at the top of the next (lane by lane, with colour).
function checkResumption(m, commits) {
  const r = m.computeLanes(commits);
  for (let i = 1; i < r.rows.length; i++) assert.deepEqual(r.rows[i].one, r.rows[i - 1].outgoing, `row ${i}: one ≠ outgoing of the row above`);
  r.rows.forEach((z, i) => {
    for (const d of z.through) assert.equal(z.outgoing[d.to].color, d.color, `row ${i}: a passing lane changes colour`);
    for (const d of z.through) assert.equal(z.one[d.from].color, d.color);
    if (z.top !== null) assert.equal(z.one[z.column].color, z.top);
    if (z.bottom) assert.equal(z.outgoing[z.column].color, z.color, `row ${i}: the first parent does not continue in the dot column`);
    assert.ok(z.through.every((d) => d.to <= d.from), `row ${i}: a lane moves to the right`);
  });
  return r;
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function checkLinear(m) {
  const r = checkResumption(m, [C("c", ["b"], { head: true }), C("b", ["a"]), C("a", [])]);
  assert.deepEqual(columns(r), [0, 0, 0]);
  assert.equal(r.width, 1);
  assert.equal(r.linear, false);
  assert.deepEqual(r.rows.map((z) => [z.top !== null, z.bottom]), [[false, true], [true, true], [true, false]], "the top row without a line upwards, the root without one downwards");
  assert.deepEqual(colors(r), ["accent", "accent", "accent"]);
  assert.deepEqual(r.rows.map((z) => z.kind), ["head", "node", "node"]);
}

// Branch point: feature (f2, f1) from b, main (HEAD m1) from b; topologically f2, f1, m1, b, a.
const BRANCH_POINT = [
  C("f2", ["f1"], { refs: [{ name: "feature", kind: "local" }] }), C("f1", ["b"]),
  C("m1", ["b"], { head: true, refs: [{ name: "main", kind: "head" }] }), C("b", ["a"]), C("a", []),
];
function checkBranchPoint(m) {
  const r = checkResumption(m, BRANCH_POINT);
  assert.deepEqual(columns(r), [0, 0, 1, 0, 0], "the second tip (m1) gets a new lane on the right");
  assert.equal(r.width, 2);
  const [f2, , m1, b] = r.rows;
  assert.equal(f2.top, null);
  assert.equal(m1.top, null, "m1 is a tip");
  assert.deepEqual(m1.through, [{ from: 0, to: 0, color: f2.color }]);
  assert.deepEqual(b.incoming, [{ from: 1, color: "accent" }], "the lane of m1 joins b");
  assert.deepEqual(b.outgoing.map((s) => s.id), ["a"], "one lane after b");
  assert.equal(m1.color, "accent");
  assert.equal(b.color, "accent", "below b it is the line of the HEAD branch — cobalt, although the feature lane joins from the left");
  assert.equal(b.top, f2.color, "the feature lane arrives at the top of b in its colour");
  assert.notEqual(f2.color, "accent", "the feature lane is not cobalt");
  assert.equal(f2.color, m.laneColorFor("feature"), "the colour of a tip comes from its branch name");
}

// Merge: M (HEAD) = merge of f2 into m1; topologically M, f2, f1, m1, b.
function checkMerge(m) {
  const r = checkResumption(m, [C("M", ["m1", "f2"], { head: true }), C("f2", ["f1"]), C("f1", ["b"]), C("m1", ["b"]), C("b", [])]);
  assert.deepEqual(columns(r), [0, 1, 1, 0, 0]);
  const [M, f2, , m1, b] = r.rows;
  assert.deepEqual(M.outgoing.map((s) => s.id), ["m1", "f2"]);
  assert.deepEqual(M.branching, [{ to: 1, color: M.outgoing[1].color }], "the second parent gets a lane on the right");
  assert.notEqual(M.outgoing[1].color, "accent", "the merged branch is not cobalt");
  assert.equal(M.outgoing[0].color, "accent");
  assert.equal(f2.top, M.outgoing[1].color);
  assert.deepEqual(m1.outgoing.map((s) => s.id), ["b", "b"], "two lanes wait for b");
  assert.deepEqual(b.incoming, [{ from: 1, color: M.outgoing[1].color }]);
  assert.equal(b.color, "accent");
  assert.deepEqual(r.rows.map((z) => z.kind), ["head", "node", "node", "node", "node"]);
  // Without HEAD the same commit is a merge point.
  assert.equal(m.computeLanes([C("M", ["a", "b"]), C("b", ["a"]), C("a", [])]).rows[0].kind, "merge");
}

function checkOctopus(m) {
  const r = checkResumption(m, [C("o", ["a", "b", "c"]), C("a", []), C("b", []), C("c", [])]);
  const [o, a, b] = r.rows;
  assert.deepEqual(o.outgoing.map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(o.branching.map((x) => x.to), [1, 2]);
  assert.equal(new Set(o.outgoing.map((s) => s.color)).size, 3, "three parents, three colours");
  assert.equal(r.width, 3);
  assert.deepEqual(columns(r), [0, 0, 0, 0], "each root ends, the others move left");
  assert.deepEqual(a.through, [{ from: 1, to: 0, color: o.outgoing[1].color }, { from: 2, to: 1, color: o.outgoing[2].color }]);
  assert.equal(a.bottom, false);
  assert.deepEqual(b.through, [{ from: 1, to: 0, color: o.outgoing[2].color }]);
  // A further parent a lane already waits for gets no second one: the curve runs into the existing one.
  const d = m.computeLanes([C("x", ["p"]), C("M", ["q", "p"]), C("q", ["p"]), C("p", [])]);
  assert.deepEqual(d.rows[1].outgoing.map((s) => s.id), ["p", "q"]);
  assert.deepEqual(d.rows[1].branching, [{ to: 0, color: d.rows[1].outgoing[0].color }], "the merge runs into the lane of x");
  assert.equal(d.width, 2);
}

function checkRoots(m) {
  // One after the other: two lines, each ends at its root.
  const a = checkResumption(m, [C("x2", ["x1"]), C("x1", []), C("y2", ["y1"]), C("y1", [])]);
  assert.deepEqual(columns(a), [0, 0, 0, 0]);
  assert.deepEqual(a.rows.map((z) => z.bottom), [true, false, true, false]);
  assert.equal(a.rows[2].top, null, "y2 is a new tip");
  // Interleaved: y gets the second column and moves left as soon as x ends.
  const b = checkResumption(m, [C("x2", ["x1"]), C("y2", ["y1"]), C("x1", []), C("y1", [])]);
  assert.deepEqual(columns(b), [0, 1, 0, 0]);
  assert.deepEqual(b.rows[2].through, [{ from: 1, to: 0, color: b.rows[1].color }]);
}

function checkWindow(m) {
  // Parents outside the window: the lanes stay open in the last row — they run to the bottom edge.
  const r = checkResumption(m, [C("M", ["a", "z"], { head: true }), C("a", ["y"])]);
  const last = r.rows.at(-1);
  assert.deepEqual(last.outgoing.map((s) => s.id), ["y", "z"]);
  assert.equal(last.bottom, true);
  assert.deepEqual(last.through, [{ from: 1, to: 1, color: r.rows[0].outgoing[1].color }]);
  // A child whose commit fell out of the window at the top does not exist (children before parents) — a lane never waits for something above.
}

function checkColors(m) {
  // HEAD anywhere — its lane is cobalt in every position; above it the colour of what lies above.
  const before = checkResumption(m, [C("r2", ["r1"], { refs: [{ name: "origin/main", kind: "remote" }] }), C("r1", ["h"]), C("h", ["b"], { head: true }), C("b", [])]);
  assert.deepEqual(colors(before).slice(2), ["accent", "accent"]);
  assert.notEqual(before.rows[0].color, "accent", "the remote branch that is ahead is not cobalt");
  assert.equal(before.rows[2].top, before.rows[0].color, "the lane of the remote branch arrives at the top of HEAD");
  // A remote branch and its local one share the colour (the name without the remote).
  assert.equal(m.computeLanes([C("t", [], { refs: [{ name: "origin/feature", kind: "remote" }] })]).rows[0].color, m.laneColorFor("feature"));
  // Stable against "Load more": every prefix computes the same rows.
  const lang = [
    C("M", ["m2", "f3"], { head: true }), C("f3", ["f2"]), C("x1", ["m2"], { refs: [{ name: "x", kind: "local" }] }), C("f2", ["f1"]),
    C("m2", ["m1"]), C("f1", ["m1"]), C("m1", ["w"]), C("t1", ["w"], { refs: [{ name: "v1", kind: "tag" }] }), C("w", ["v"]),
  ];
  const whole = m.computeLanes(lang);
  for (let k = 1; k < lang.length; k++) assert.deepEqual(m.computeLanes(lang.slice(0, k)).rows, whole.rows.slice(0, k), `prefix ${k} computes differently`);
  assert.deepEqual(m.computeLanes(lang), whole, "same input, same computation");
  checkResumption(m, lang);
  // Cobalt exists only on the line of HEAD (first parents from M): M, m2, m1, w.
  const cobalt = whole.rows.map((z, i) => (z.color === "accent" ? lang[i].hash : null)).filter(Boolean);
  assert.deepEqual(cobalt, ["M", "m2", "m1", "w"]);
  assert.ok(whole.rows.every((z) => [...z.outgoing, ...z.one].every((s) => s.color === "accent" || (Number.isInteger(s.color) && s.color >= 0 && s.color < m.LANE_COLORS))), "every colour is cobalt or a palette index");
  // A new lane next to one of the same colour takes the next colour — wanted: two names with the same colour.
  const names = Array.from({ length: 40 }, (_, i) => `b${i}`);
  const [n1, n2] = (() => { for (const a of names) for (const b of names) if (a !== b && m.laneColorFor(a) === m.laneColorFor(b)) return [a, b]; return []; })();
  assert.ok(n1 && n2, "two names with the same colour found");
  const nb = m.computeLanes([C("p", ["z"], { refs: [{ name: n1, kind: "local" }] }), C("q", ["z2"], { refs: [{ name: n2, kind: "local" }] })]);
  assert.equal(nb.rows[0].color, m.laneColorFor(n1));
  assert.notEqual(nb.rows[1].color, nb.rows[0].color, "two neighbours in the same colour");
  assert.equal(m.laneColorFor("x", [0, 1, 2, 3, 4]), m.laneColorFor("x"), "when the palette is exhausted, the colour of the name stays");
  // A merge a child joins from the right (a remote branch that is ahead): its second parent does NOT get the colour of the
  // ending lane — otherwise both would read as ONE line passing the dot.
  const t = "hotfix";
  const b = names.find((x) => m.laneColorFor(x) === m.laneColorFor(t));
  assert.ok(b, "a parent with the colour of the tip found");
  const mg = checkResumption(m, [C("X", ["M"], { head: true }), C("H", ["M"], { refs: [{ name: t, kind: "local" }] }), C("M", ["a", b]), C(b, ["a"]), C("a", [])]);
  const mz = mg.rows[2];
  assert.deepEqual(mz.incoming, [{ from: 1, color: m.laneColorFor(t) }]);
  assert.equal(mz.branching.length, 1);
  assert.notEqual(mz.branching[0].color, mz.incoming[0].color, "the second parent continues the ending lane");
}

function checkWithoutParent(m) {
  // A missing field is no statement: an old server sends no parents ⇒ linear, each commit attached to the next.
  const r = checkResumption(m, [C("c", undefined, { head: true }), C("b", null), C("a", ["x"])]);
  assert.equal(r.linear, true);
  assert.deepEqual(columns(r), [0, 0, 0]);
  assert.deepEqual(r.rows.map((z) => z.bottom), [true, true, false]);
  assert.equal(m.computeLanes([C("c", ["b", 7])]).linear, true, "nonsense in the parents is \"no parents\"");
  assert.deepEqual(m.computeLanes([]), { rows: [], width: 0, linear: false });
}

function checkGeometry(m) {
  const { laneGeometry, graphMaxPx, LANE_PX, LANE_MIN_PX } = m;
  assert.equal(LANE_PX, 11);
  assert.deepEqual(laneGeometry(3, 76), { w: 11, clipFrom: null, columns: 3 }, "three lanes fit at full width");
  assert.deepEqual(laneGeometry(10, 76), { w: 7, clipFrom: null, columns: 10 }, "ten get narrower");
  assert.deepEqual(laneGeometry(20, 76), { w: LANE_MIN_PX, clipFrom: 11, columns: 12 }, "twenty get clipped: eleven columns and a collecting column");
  assert.deepEqual(laneGeometry(0, 76), { w: 11, clipFrom: null, columns: 1 });
  assert.equal(graphMaxPx(272), 65);
  assert.equal(graphMaxPx(100), 56, "at least 56 px");
  assert.equal(graphMaxPx(2000), 132, "at most 132 px");
}

function checkBadges(m) {
  const { badges } = m;
  assert.deepEqual(badges([
    { name: "v1", kind: "tag" }, { name: "origin/main", kind: "remote" }, { name: "main", kind: "head" }, { name: "zz", kind: "local" },
    { name: "origin/foreign", kind: "remote" }, { name: "x", kind: "stash" }, { name: "", kind: "local" }, null,
  ]), [
    { name: "main", kind: "head", remote: "origin/main" }, { name: "zz", kind: "local" }, { name: "origin/foreign", kind: "remote" }, { name: "v1", kind: "tag" },
  ], "HEAD first, the remote on the same commit as a cloud, unknown kinds and empty names are dropped");
  const two = badges([{ name: "a", kind: "local" }, { name: "up/a", kind: "remote" }, { name: "origin/a", kind: "remote" }]);
  assert.equal(two.length, 2, "a local branch folds exactly one remote");
  assert.equal(two[0].remote, "up/a", "the first remote in git order");
  assert.deepEqual(two[1], { name: "origin/a", kind: "remote" });
  assert.deepEqual(badges(null), []);
  assert.deepEqual(badges([{ name: "origin/x", kind: "remote" }]), [{ name: "origin/x", kind: "remote" }], "without a local one the remote stays a badge");
}

function checkMoreAndStatus(m) {
  const { loadMore, graphState, readExtent, GRAPH_EXTENT_KEY } = m;
  assert.equal(loadMore(50, 50, true, 50, 500), 100, "clipped ⇒ more");
  assert.equal(loadMore(50, 50, false, 50, 500), null, "not clipped ⇒ done, even if the answer fills the limit");
  assert.equal(loadMore(50, 50, null, 50, 500), 100, "unknown (old server) ⇒ the length decides");
  assert.equal(loadMore(50, 49, null, 50, 500), null);
  assert.equal(loadMore(480, 480, true, 50, 500), 500);
  assert.equal(loadMore(500, 500, true, 50, 500), null, "at the cap it is over — the bar then says that older ones exist");
  const r = { lastCommit: { hash: "a" }, branch: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0 };
  const s = graphState(r);
  for (const x of [{ lastCommit: { hash: "b" } }, { branch: "x" }, { detached: true }, { upstream: null }, { ahead: 1 }, { behind: 2 }]) {
    assert.notEqual(graphState({ ...r, ...x }), s, `the state does not notice ${JSON.stringify(x)}`);
  }
  assert.equal(graphState({ ...r, changes: [1] }), s, "changes in the working tree do not reload the graph");
  assert.equal(graphState({}), graphState({ lastCommit: null, ahead: NaN }));
  assert.equal(GRAPH_EXTENT_KEY, "cbase-git-graph-extent");
  assert.equal(readExtent("current"), "current");
  for (const x of [null, undefined, "", "all", "Current", "{}", "colorful"]) assert.equal(readExtent(x), "all", `readExtent(${JSON.stringify(x)})`);
}

// The expanded commit: next to each file row EXACTLY the lanes passing between its row and the next (the outgoing ones — the
// next commit row gets them as incoming and continues seamlessly), plus at most ONE own (the bar).
function checkContinuous(m) {
  const { continuousLanes, computeLanes } = m;
  const MERGE = [C("M", ["m1", "f2"], { head: true }), C("f2", ["f1"]), C("f1", ["b"]), C("m1", ["b"]), C("b", [])];
  const INTERLEAVED = [C("x2", ["x1"]), C("y2", ["y1"]), C("x1", []), C("y1", [])];
  const OCTO = [C("o", ["a", "b", "c"]), C("a", []), C("b", []), C("c", [])];
  const WINDOW = [C("M", ["a", "z"], { head: true }), C("a", ["y"])];
  for (const [name, commits] of Object.entries({ BRANCH_POINT, MERGE, INTERLEAVED, OCTO, WINDOW })) {
    const r = computeLanes(commits);
    r.rows.forEach((z, i) => {
      const d = continuousLanes(z);
      const location = `${name}, row ${i} (${commits[i].hash})`;
      const further = d.filter((s) => !(s.own && !z.bottom)); // without the bar of a root: it does not run into the next row
      assert.deepEqual(further.map((s) => [s.column, s.color]), z.outgoing.map((s, k) => [k, s.color]), `${location}: the lanes next to the files are not the outgoing ones`);
      if (i + 1 < r.rows.length) assert.deepEqual(further.map((s) => s.color), r.rows[i + 1].one.map((s) => s.color), `${location}: the next commit row does not continue seamlessly`);
      const own = d.filter((s) => s.own);
      assert.ok(own.length <= 1, `${location}: more than one bar`);
      if (z.bottom || z.column >= z.outgoing.length) {
        assert.deepEqual(own, [{ column: z.column, color: z.color, own: true }], `${location}: the bar is not in the column and colour of the commit`);
      } else {
        assert.deepEqual(own, [], `${location}: a root in whose column a foreign lane continues gets no bar`);
      }
      assert.ok(d.every((s, k) => k === 0 || s.column > d[k - 1].column), `${location}: columns duplicated or not ascending`);
    });
  }
  // Named: the merge (HEAD) — the own lane cobalt in column 0, next to it that of the merged branch.
  const mg = computeLanes(MERGE);
  assert.deepEqual(continuousLanes(mg.rows[0]), [{ column: 0, color: "accent", own: true }, { column: 1, color: mg.rows[0].outgoing[1].color, own: false }]);
  assert.deepEqual(continuousLanes(mg.rows[1]).map((s) => [s.column, s.own]), [[0, false], [1, true]], "f2 expanded: cobalt passes thinly, the bar in column 1");
  assert.deepEqual(continuousLanes(mg.rows[4]), [{ column: 0, color: "accent", own: true }], "the root b: the bar to the end of the list");
  const v = computeLanes(INTERLEAVED);
  assert.deepEqual(continuousLanes(v.rows[2]), [{ column: 0, color: v.rows[1].color, own: false }], "the root x1: y moves into its column — no bar in a foreign colour");
}

function check(m) {
  checkContinuous(m);
  checkLinear(m);
  checkBranchPoint(m);
  checkMerge(m);
  checkOctopus(m);
  checkRoots(m);
  checkWindow(m);
  checkColors(m);
  checkWithoutParent(m);
  checkGeometry(m);
  checkBadges(m);
  checkMoreAndStatus(m);
}

test("linear: one column, HEAD cobalt, the root ends", () => checkLinear(real));
test("branch point: the second tip on the right, merge into the parent, cobalt below", () => checkBranchPoint(real));
test("merge: the second parent gets a lane that ends in the common ancestor", () => checkMerge(real));
test("octopus and a merge into an existing lane", () => checkOctopus(real));
test("two independent roots — one after the other and interleaved", () => checkRoots(real));
test("parents outside the window run to the bottom edge", () => checkWindow(real));
test("colours: HEAD branch always cobalt, prefix-stable, name instead of order, neighbours differ", () => checkColors(real));
test("linear without parents (old server)", () => checkWithoutParent(real));
test("geometry: 11 px, narrower, clipped with collecting column", () => checkGeometry(real));
test("badges: order, remote folded, unknown dropped", () => checkBadges(real));
test("\"Load more\" believes the server, the repo state, the stored choice", () => checkMoreAndStatus(real));

test("expanded commit: next to the files exactly the passing lanes, the bar of the own (root only in a free column)", () => checkContinuous(real));

// ── The file rows (lib/git-files.ts) and their binding to `classify` in the server ─────────────────────────────────────────────
// classify (server/backend/electron/server/git.js) maps the letters of `git status` to the kinds — the same mapping must hold for
// `diff-tree`, otherwise the same change would carry two colours under "Changes" and in the graph. Read from the source, not copied.
const GITJS = fs.readFileSync(path.join(webDir, "..", "server", "backend", "electron", "server", "git.js"), "utf8");
const classifyBody = GITJS.slice(GITJS.indexOf("function classify("), GITJS.indexOf("default:", GITJS.indexOf("function classify(")));
const CLASSIFY = Object.fromEntries([...classifyBody.matchAll(/case "([A-Z])": return \{ code: "\1", label: "([^"]+)", kind: "([a-z]+)" \};/g)].map((x) => [x[1], { kind: x[3], label: x[2] }]));
function checkFiles(m) {
  const { fileKind, diffPath, partsPath, commitStatusDisplay, KIND_COLOR, KIND_LETTER, COMMIT_STATUS_KIND } = m;
  assert.deepEqual(partsPath("src/lib/a.ts"), { name: "a.ts", folder: "src/lib" });
  assert.deepEqual(partsPath("a.ts"), { name: "a.ts", folder: "" });
  assert.equal(diffPath("-x"), "./-x", "a file starting with \"-\" goes as ./-x (the server rejects \"-…\")");
  assert.equal(diffPath("--output=x"), "./--output=x");
  assert.equal(diffPath("a/-x"), "a/-x");
  // The same colours and letters as the file rows under "Changes" (KIND_COLOR/KIND_LETTER).
  assert.deepEqual(commitStatusDisplay("M"), { color: KIND_COLOR.modified, letter: KIND_LETTER.modified, label: "modified", deleted: false });
  assert.deepEqual(commitStatusDisplay("D"), { color: "text-danger", letter: "D", label: "deleted", deleted: true }, "deleted: red and struck through");
  assert.deepEqual(commitStatusDisplay("A"), { color: "text-ok", letter: "A", label: "added", deleted: false });
  assert.equal(commitStatusDisplay("R").color, "text-accent");
  assert.equal(commitStatusDisplay("C").letter, "R", "a copy as under \"Changes\" (classify: kind renamed)");
  assert.equal(commitStatusDisplay("T").letter, "M");
  assert.deepEqual(commitStatusDisplay("X"), { color: "text-dim", letter: "X", label: "modified", deleted: false }, "unknown: dimmed, the letter itself");
  assert.equal(Object.keys(CLASSIFY).length, 7, `classify in the server: ${Object.keys(CLASSIFY).join(", ")} — the latch no longer reads the source`);
  assert.deepEqual(Object.keys(COMMIT_STATUS_KIND).sort(), Object.keys(CLASSIFY).sort());
  for (const [code, expected] of Object.entries(CLASSIFY)) assert.deepEqual(COMMIT_STATUS_KIND[code], expected, `letter ${code}: differs from classify in the server`);
  // The icon by file type.
  const kind = (p) => { const a = fileKind(p); return a.kind === "shortcut" ? a.shortcut : a.kind; };
  const expected = {
    "web/src/App.TSX": "TS", "types/x.d.ts": "TS", "a.mjs": "JS", "package.json": "{}", "package-lock.json": "lock", "yarn.lock": "lock",
    "README.md": "M", "logo.SVG": "image", "Dockerfile": "config", ".env.local": "config", "config.yaml": "config", ".gitignore": "config",
    "notes.txt": "text", "LICENSE": "file", ".bashrc": "file", "x.unknown": "file", "run.sh": ">_", "app/styles.css": "#", "index.html": "<>",
  };
  for (const [p, a] of Object.entries(expected)) assert.equal(kind(p), a, `fileKind(${JSON.stringify(p)})`);
  assert.equal(fileKind("a.ts").tone, "blue");
  assert.equal(fileKind("a.js").tone, "yellow");
  assert.equal(fileKind("LICENSE").tone, "gray");
}
test("file rows: name/folder, ./-x, colours and letters like \"Changes\" (bound to classify), icon by file type", () => checkFiles(fileLines));
test("sabotage file rows: every place turns the check red", () => {
  for (const s of sabotagedFileLines) {
    assert.ok(s.applies, `sabotage "${s.name}" no longer applies — its wording is not in src/lib/git-files.ts`);
    assert.throws(() => checkFiles(s.mod), `sabotage "${s.name}" stays green`);
  }
});

// ── The allowlists of the expanded commit (lib/api/git.ts) ────────────────────────────────────────────────────────────────
function checkCommitNorm(m) {
  const { normGitCommitFiles: nd, normGitCommitFileDiff: nf } = m;
  assert.equal(nd({ hash: "abc", diff: "commit abc\n…" }), null, "an old server (the whole commit) is \"not available\" — never an empty list");
  assert.equal(nd(null), null);
  assert.equal(nd({ files: "x" }), null);
  assert.deepEqual(nd({ hash: "h", files: [] }), { hash: "h", parent: null, files: [], total: null, clipped: null, unreadable: 0 }, "an empty list is an answer, missing numbers stay unknown");
  const n = nd({
    hash: "h", parent: ["p1", "p2"], total: 9, clipped: true,
    files: [{ path: "a", status: "M" }, { path: "b", old: "a0", status: "R" }, { path: "", status: "M" }, { path: "c", status: "X" }, "x", { path: "d", old: 7, status: "A" }],
  });
  assert.deepEqual(n.files, [{ path: "a", old: null, status: "M" }, { path: "b", old: "a0", status: "R" }, { path: "d", old: null, status: "A" }]);
  assert.equal(n.unreadable, 3, "what is unreadable is counted — the list does not shorten silently");
  assert.deepEqual([n.hash, n.parent, n.total, n.clipped], ["h", ["p1", "p2"], 9, true]);
  assert.equal(nd({ files: [], total: -1 }).total, null);
  assert.equal(nd({ files: [], total: 1.5 }).total, null);
  assert.equal(nd({ files: [], parent: [1] }).parent, null, "nonsense in the parents is \"unknown\"");
  assert.deepEqual(nd({ files: [], parent: [] }).parent, [], "no parents (root) is an answer");
  assert.equal(nf({ hash: "h", diff: "the whole commit" }, "a.txt"), null, "the whole commit of an old server is not the diff of the file");
  assert.equal(nf({ path: "b.txt", diff: "x" }, "a.txt"), null, "the answer for another file");
  assert.equal(nf({ path: "a.txt", diff: 5 }, "a.txt"), null);
  assert.deepEqual(nf({ hash: "h", path: "a.txt", diff: "d", clipped: true }, "a.txt"), { hash: "h", path: "a.txt", diff: "d", clipped: true });
  assert.deepEqual(nf({ path: "./-x", diff: "" }, "./-x"), { hash: "", path: "./-x", diff: "", clipped: null }, "an empty diff is an answer");
}
test("normGitCommitFiles / normGitCommitFileDiff: a missing field is no statement (with counter-proof)", () => {
  checkCommitNorm(apiGit);
  for (const s of sabotagedApi) {
    assert.ok(s.applies, `sabotage "${s.name}" no longer applies — its wording is not in src/lib/api/git.ts`);
    assert.throws(() => checkCommitNorm(s.mod), `sabotage "${s.name}" stays green`);
  }
});

test("sabotage: every place turns the check red (the built-in counter-proof)", () => {
  for (const s of sabotaged) {
    assert.ok(s.applies, `sabotage "${s.name}" no longer applies — its wording is not in src/lib/git-graph.ts (test outdated?)`);
    assert.throws(() => check(s.mod), `sabotage "${s.name}" stays green — the check does not measure this place`);
  }
});

// ── The allowlist (lib/api/git.ts normGitGraphLog) ─────────────────────────────────────────────────────────────────────────
test("normGitGraphLog: a missing field is no statement", () => {
  const { normGitGraphLog } = apiGit;
  assert.deepEqual(normGitGraphLog(null), { commits: [], clipped: null, extent: null });
  assert.deepEqual(normGitGraphLog({ commits: "x", clipped: "yes", extent: "colorful" }), { commits: [], clipped: null, extent: null });
  // An old server: today's answer — without parents, without clipped, without extent.
  const old = normGitGraphLog({ commits: [{ hash: "abc", short: "abc", subject: "s", author: "a", relative: "r" }] });
  assert.deepEqual(old, { commits: [{ hash: "abc", short: "abc", subject: "s", author: "a", relative: "r", parents: null, refs: [], head: false, time: null }], clipped: null, extent: null });
  const fresh = normGitGraphLog({
    clipped: false, extent: "current",
    commits: [
      { hash: "h1", parents: ["p1", "p2"], head: true, time: 1790000000, refs: [{ name: "main", kind: "head" }, { name: "s", kind: "stash" }, { name: "", kind: "tag" }, "x", { kind: "local" }] },
      { hash: "h2", parents: ["p1", 3] },
      { short: "no hash" },
      { hash: "h3", head: "true", time: -5 },
    ],
  });
  assert.equal(fresh.clipped, false);
  assert.equal(fresh.extent, "current");
  assert.deepEqual(fresh.commits.map((c) => c.hash), ["h1", "h2", "h3"], "no entry without a hash");
  assert.deepEqual(fresh.commits[0].parents, ["p1", "p2"]);
  assert.deepEqual(fresh.commits[0].refs, [{ name: "main", kind: "head" }], "only known kinds with names");
  assert.equal(fresh.commits[0].head, true);
  assert.equal(fresh.commits[0].time, 1790000000);
  assert.equal(fresh.commits[0].short, "h1", "without short the start of the hash");
  assert.equal(fresh.commits[1].parents, null, "nonsense in the parents is \"unknown\" — the graph then draws linearly");
  assert.equal(fresh.commits[2].head, false, "only a real true is HEAD");
  assert.equal(fresh.commits[2].time, null);
  // The computation takes the allowlist output directly.
  assert.equal(real.computeLanes(fresh.commits).linear, true);
});

// ── Binding: GitGraph.tsx and GitSidebar.tsx ────────────────────────────────────────────────────────────────────────────────
// On the source text without comment lines (like git-bar.test.mjs): a comment naming the call is not a call.
const code = (s) => s.split("\n").filter((z) => !/^\s*(\/\/|\/\*|\*)/.test(z)).join("\n").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
function checkBinding(graph, bar) {
  assert.ok(/from "@\/lib\/git-graph"/.test(graph), "GitGraph.tsx does not import the computation from @/lib/git-graph");
  for (const forbidden of ["setInterval(", "setTimeout(", "useGitState(", "EventSource", "requestAnimationFrame("]) {
    assert.ok(!graph.includes(forbidden), `GitGraph.tsx contains ${forbidden} — the graph reloads only on open and with the repo state`);
  }
  assert.ok(/const state = graphState\(repo\);/.test(graph), "the graph does not compute its state via graphState(repo)");
  assert.ok(/\}, \[path, rel, extent, limit, state, fresh\]\);/.test(graph), "the graph does not reload exactly with path, repo, extent, limit, state and \"Refresh\"");
  assert.ok(/body: JSON\.stringify\(\{ repo: rel, limit, graph: extent \}\)/.test(graph), "the graph does not request `graph: extent`");
  assert.ok(/setLog\(normGitGraphLog\(raw\)\)/.test(graph), "the answer does not pass the allowlist normGitGraphLog");
  assert.ok(/computeLanes\(log\.commits\)/.test(graph), "the lanes do not come from computeLanes");
  assert.ok(/loadMore\(limit, log\.commits\.length, log\.clipped, GRAPH_STEP, GRAPH_MAX\)/.test(graph), "\"Load more\" does not compute via loadMore with clipped");
  assert.ok(/badges\(c\.refs\)/.test(graph), "the badges do not come from badges(c.refs)");
  assert.ok(/localStorage\.getItem\(GRAPH_EXTENT_KEY\)/.test(graph) && /readExtent\(/.test(graph), "the choice does not come from storage via readExtent");
  // Every call through the path builder of the bar (with ?chat= / instance=) — otherwise a copy chat would see the graph of the main.
  const calls = [...graph.matchAll(/\bapi(?:<[^(]*?>)?\(/g)].map((x) => graph.slice(x.index + x[0].length, x.index + x[0].length + 40));
  // The graph loads no diff itself: it names the SOURCE (`onDiff`), the bar opens it — in the chat as a tab, otherwise in the
  // DiffModal with the loader `diffText` (GitSidebar.tsx). Latch of the paths: web/test/code-tabs-ways.test.mjs.
  assert.equal(calls.length, 2, `GitGraph.tsx: ${calls.length} api calls instead of two (log, the files of a commit)`);
  assert.deepEqual(calls.filter((a) => !a.startsWith("path(")), [], "GitGraph.tsx: an api call bypasses the path builder");
  assert.ok(!/fetch\(/.test(graph), "GitGraph.tsx calls fetch itself");
  // The expanded commit: files and diff only through the allowlists, loaded on first expand (and after an error or an old
  // server), kept per hash; rename with both paths, "-x" as ./-x; the lanes from the computation; colours shared.
  assert.ok(/JSON\.stringify\(\{ repo: rel, hash, files: true \}\)/.test(graph), "the files of a commit are not requested with `files: true`");
  assert.ok(/const w = normGitCommitFiles\(raw\);/.test(graph), "the file list does not pass the allowlist normGitCommitFiles");
  assert.ok(/if \(desired && \(!present \|\| present\.kind === "error" \|\| present\.kind === "unknown"\)\) loadFiles\(c\.hash\);/.test(graph), "the file list is not loaded exactly on first expand (or after an error)");
  // The source of a file carries the old path on a rename (otherwise git would show a creation); the whole commit is its own kind.
  assert.ok(/const old = d\.status === "R" && d\.old \? d\.old : null;/.test(graph), "a rename does not send the old path along");
  assert.ok(/onDiff\(\{ kind: "commit", repo: rel, hash: c\.hash, file: d\.path, old: old \}/.test(graph), "the file of a commit does not name repo, hash, path and old path");
  assert.ok(/onDiff\(\{ kind: "commit-whole", repo: rel, hash: c\.hash \}/.test(graph), "\"Show whole commit\" does not name its source");
  // The loader of the modal (GitSidebar.tsx diffText): `file`/`old` via diffPath ("-x" as ./-x), the path echo checked.
  assert.ok(/const file = diffPath\(q\.file\);/.test(bar) && /hash: q\.hash, file, \.\.\.\(old \? \{ old: old \} : \{\}\) \}/.test(bar), "the diff of a file does not request `file` (via diffPath) with `old`");
  assert.ok(/const old = q\.old \? diffPath\(q\.old\) : null;/.test(bar), "the old path of a rename does not go via diffPath");
  assert.ok(/const r = normGitCommitFileDiff\(raw, file\);/.test(bar), "the diff of a file does not check the path echo (normGitCommitFileDiff)");
  assert.ok(/aria-expanded=\{open\}/.test(graph), "the commit row does not carry aria-expanded");
  assert.ok((graph.match(/continuousLanes\(z\)/g) || []).length >= 2, "file rows and commit row do not take the lanes from continuousLanes");
  assert.ok(/commitStatusDisplay\(d\.status\)/.test(graph) && /fileKind\(d\.path\)/.test(graph), "the file row does not take letter/colour or icon from lib/git-files.ts");
  for (const file of [graph, bar]) assert.ok(!/const KIND_(COLOR|LETTER)\b/.test(file), "KIND_COLOR/KIND_LETTER are copied into a component again — they live in lib/git-files.ts");
  assert.ok(/import \{ KIND_COLOR, KIND_LETTER \} from "@\/lib\/git-files";/.test(bar), "GitSidebar.tsx does not take the file row colours from lib/git-files.ts");
  // GitSidebar.tsx mounts it in the "Graph" section and passes its path builder in.
  const start = bar.indexOf("function GraphSection(");
  assert.ok(start > 0, "GitSidebar.tsx: function GraphSection( is missing");
  const section = bar.slice(start, bar.indexOf("\n}\n", start));
  // `turn` (latch: web/test/git-card.test.mjs): no card during a drag in the stack.
  assert.ok(/<GitGraph key=\{`\$\{k\}\\u0000\$\{extent\}`\} repo=\{repo\} extent=\{extent\} fresh=\{fresh\} path=\{path\} onDiff=\{onDiff\} turn=\{turn\} \/>/.test(section), "the \"Graph\" section does not mount <GitGraph …> with repo, extent, path builder, turn and a new key per extent");
  assert.ok(/const \[extent, setExtent\] = useGraphExtent\(\);/.test(section) && /<GraphExtentChoice extent=\{extent\} onChoice=\{setExtent\} \/>/.test(section), "the choice \"All / Current branch\" is not in the section head");
  assert.ok(!/function GraphList\(|function GraphLane\(/.test(bar), "GitSidebar.tsx still contains the old linear list — two places for the same graph");
}
test("binding: GitGraph.tsx calls the computations, loads without its own timer via the path builder; GitSidebar mounts it (with counter-proof)", () => {
  const graph = code(fs.readFileSync(path.join(webDir, "src", "components", "git-bar", "GitGraph.tsx"), "utf8"));
  const bar = code(fs.readFileSync(path.join(webDir, "src", "components", "GitSidebar.tsx"), "utf8"));
  checkBinding(graph, bar);
  const sabotages = {
    "graph with its own timer": [graph.replace("  const state = graphState(repo);", "  const state = graphState(repo);\n  useEffect(() => { const u = setInterval(() => {}, 6000); return () => clearInterval(u); }, []);"), bar],
    "graph without state": [graph.replace("}, [path, rel, extent, limit, state, fresh]);", "}, [route, rel, scope, limit, fresh]);"), bar],
    "graph without extent": [graph.replace("JSON.stringify({ repo: rel, limit, graph: extent })", "JSON.stringify({ repo: rel, limit })"), bar],
    "graph bypassing the path builder": [graph.replace(`api<unknown>(path("/git/log")`, "api<unknown>(`/api/git/log`"), bar],
    "answer without allowlist": [graph.replace("setLog(normGitGraphLog(raw))", "setLog(raw as GitGraphLog)"), bar],
    "load more without clipped": [graph.replace("loadMore(limit, log.commits.length, log.clipped, GRAPH_STEP, GRAPH_MAX)", "loadMore(limit, log.commits.length, null, GRAPH_STEP, GRAPH_MAX)"), bar],
    "section without path builder": [graph, bar.replace(" path={path} onDiff={onDiff} turn={turn} />", " route={(r) => r} onDiff={onDiff} pull={pull} />")],
    "section without choice": [graph, bar.replace("<GraphExtentChoice extent={extent} onChoice={setExtent} />", "")],
    "files without allowlist": [graph.replace("const w = normGitCommitFiles(raw);", "const w = raw as GitCommitFiles;"), bar],
    "files reloaded on every expand": [graph.replace(`if (desired && (!present || present.kind === "error" || present.kind === "unknown")) loadFiles(c.hash);`, "if (wanted) loadFiles(c.hash);"), bar],
    "diff without echo check": [graph, bar.replace("const r = normGitCommitFileDiff(raw, file);", "const r = raw as { diff: string; truncated: boolean };")],
    "rename without old (source)": [graph.replace("hash: c.hash, file: d.path, old: old }", "hash: c.hash, filePath: d.path }"), bar],
    "rename without old (loader)": [graph, bar.replace("hash: q.hash, file, ...(old ? { old: old } : {}) }", "hash: q.hash, filePath }")],
    "\"-x\" without ./": [graph, bar.replace("const file = diffPath(q.file);", "const file = q.file;")],
    "whole commit as file": [graph.replace(`onDiff({ kind: "commit-whole", repo: rel, hash: c.hash }`, `onDiff({ kind: "history", repo: rel, hash: c.hash }`), bar],
    "commit row without aria-expanded": [graph.replace("aria-expanded={open}", ""), bar],
    "files bypassing the path builder": [graph.replace(`api<unknown>(path("/git/show"), { method: "POST", body: JSON.stringify({ repo: rel, hash, files: true }) })`, "api<unknown>(`/api/git/show`, { method: \"POST\", body: JSON.stringify({ repo: rel, hash, fileList: true }) })"), bar],
    "colours copied again": [graph, bar.replace(`import { KIND_COLOR, KIND_LETTER } from "@/lib/git-files";`, `const KIND_COLOR: Record<string, string> = {};\nconst KIND_LETTER: Record<string, string> = {};`)],
  };
  for (const [name, [g, l]] of Object.entries(sabotages)) {
    assert.ok(g !== graph || l !== bar, `sabotage "${name}" no longer applies (wording changed?)`);
    assert.throws(() => checkBinding(g, l), `sabotage "${name}" stays green`);
  }
});
