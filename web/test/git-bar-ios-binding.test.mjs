// The git sheet on iOS computes like the git bar on the desktop: ONE computation, two languages.
//
//   web/src/lib/git-graph.ts    ↔ mobile/CbaseMobile/Code/GitGraphComputation.swift   (lanes, colours, badges, geometry, "Load more")
//   web/src/lib/git-bar.ts      ↔ mobile/CbaseMobile/Code/GitBarComputation.swift     (primary button, synchronise, selection, graph
//   web/src/lib/git-files.ts    ↔        (same file)                                   repo, remembered choice, collapsed sections;
//   web/src/lib/api/git.ts      ↔        (same file)                                   files of a commit; the allowlists of the graph answers)
//
// Model web/test/geometry-binding.test.mjs: really run BOTH sides — the TS leaves compiled with tsc and imported, the Swift files
// with `xcrun swift` as one program (plus Models/JSONValue.swift, nothing else from the app) — over the SAME cases, which go to
// both as ONE JSON file: randomised graphs (merges up to three parents, tips, roots, parents outside the window), hand cases (empty,
// linear without parents, octopus, merge into an existing lane, two children, HEAD in the middle), names with umlaut and emoji (FNV
// counts UTF-16 units), the bar computations over a randomised matrix of repo states, all extensions and names of the icon table
// (read from git-files.ts) and raw answers with missing, wrong and surplus fields. Compared line by line. If the toolchain is
// missing, the test fails LOUDLY (`onlyMacOS` in tools/check/latch.json).
//
// BUILT-IN SABOTAGE (runs on every run): the same Swift program carries copies of both files under a renamed namespace
// (`GitGraph_S0…`, `GitBar_S0…`), each with EXACTLY ONE deviation (`SABOTAGES` below: FNV factor, merge into the existing lane,
// accent at the confluence, linear fallback, cloud on the local badge, bar of the root, clip, colour of the column above, "Load
// more"; remote preference of the graph repo, status error, strict `true`, UTF-16 length, empty parents, "copied", path check of the
// diff, order of pull/push, `.lock`, second tap). Each must deviate from the web on at least one line — otherwise the case set does
// not check it. Its anchor must occur exactly once in the Swift file (renamed ⇒ the test says so instead of silently sabotaging
// nothing).
//
// Plus the execution side: the git sheet CALLS these computations (Code/GitPane.swift, Code/GitGraphSection.swift) — a twin
// computation nobody calls would bind nothing.
//
// Run:  node --test web/test/git-bar-ios-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(here, "..", "..");
const lib = path.join(webDir, "src", "lib");
const app = path.join(repo, "mobile", "CbaseMobile");
const SWIFT_GRAPH = path.join(app, "Code", "GitGraphComputation.swift");
const SWIFT_BAR = path.join(app, "Code", "GitBarComputation.swift");
const SWIFT_JSON = path.join(app, "Models", "JSONValue.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// ── The sabotages: [namespace, name, anchor, replacement] — every anchor occurs exactly once in its file ─────────────────────────────
const SABOTAGES = [
  ["graph", "FNV-Factor", "h = h &* 0x01000193", "h = h &* 0x01000197"],
  ["graph", "merge always into a new lane", "if let present = outgoing.firstIndex(where: { $0.id == p }) {", "if let present = Optional<Int>.none {"],
  ["graph", "accent forgotten at a merge", "if c.head || accentIncluded {", "if c.head {"],
  ["graph", "no linear fallback", "let linear = commits.contains { $0.parents == nil }", "let linear = commits.isEmpty && commits.contains { $0.parents == nil }"],
  ["graph", "remote never becomes the cloud of the local badge", "if let i = place[localName], outgoing[i].remote == nil {", "if let i = place[localName], outgoing[i].remote == \"never\" {"],
  ["graph", "bar of a root also over a foreign lane", "if !z.bottom && z.column >= z.outgoing.count {", "if !z.bottom {"],
  ["graph", "clip one column too early", "(slot / Double(LANE_MIN_PX)).rounded(.down) - 1)", "(slot / Double(LANE_MIN_PX)).rounded(.down) - 2)"],
  ["graph", "new lane does not avoid the column above", " + (prior.map { [$0] } ?? [])", ""],
  ["graph", "\"Load more\" only above the limit", "clipped ?? (loaded >= limit)", "clipped ?? (loaded > limit)"],
  ["bar", "graph repo without remote preference", "present.first { withRemote.contains($0) } ?? present.first ?? existing.first", "present.first ?? existing.first"],
  ["bar", "status error does not mean \"commit\"", "if set(r.statusError) { return .commit(unknown: true) }", ""],
  ["bar", "collapsed without strict true", "object[id] == .bool(true)", "object[id] != nil"],
  ["bar", "length of the choice in characters instead of UTF-16", "raw.utf16.count < 2048", "raw.count < 2048"],
  ["bar", "empty parents count", "guard case .string(let s) = e, !s.isEmpty else { return nil }", "guard case .string(let s) = e else { return nil }"],
  ["bar", "\"copied\" as added", "\"C\": (\"renamed\", \"copied\"),", "\"C\": (\"added\", \"copied\"),"],
  ["bar", "diff without path check", "o[\"path\"] == .string(path), ", ""],
  ["bar", "synchronise pushes before pulling", "return s.isEmpty ? [\"fetch\"] : s", "return s.isEmpty ? [\"fetch\"] : Array(s.reversed())"],
  ["bar", "lock file at \".lck\"", "name.hasSuffix(\".lock\")", "name.hasSuffix(\".lck\")"],
  ["bar", "second tap does not return to the default", "$0.count == 1 && $0[0] == key", "$0.count == 2 && $0[0] == key"],
];

// ── The cases ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function prng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NAMES = ["main", "fn/till", "cbase/agent-3f2a", "release", "feature/a", "Feature/B", "ä-branch", "🌿-leaf", "v1.0", "v1.10", "v1.9", "dev", "fix-12", "fix_12"];
function randomRefs(r, head) {
  const refs = [];
  if (head) refs.push({ name: NAMES[Math.floor(r() * 4)], kind: "head" });
  const n = r() < 0.55 ? 0 : 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const name = NAMES[Math.floor(r() * NAMES.length)];
    const w = r();
    if (w < 0.35) refs.push({ name, kind: "local" });
    else if (w < 0.7) refs.push({ name: `origin/${name}`, kind: "remote" });
    else if (w < 0.85) refs.push({ name, kind: "tag" });
    else if (w < 0.92) refs.push({ name, kind: "branch" });
    else refs.push({ name: "", kind: "local" });
  }
  return refs;
}
function randomGraph(seed) {
  const r = prng(seed);
  const n = 1 + Math.floor(r() * 40);
  const generated = [];
  for (let i = 0; i < n; i++) {
    const hash = `${(seed * 7919 + i * 104729).toString(16).padStart(8, "0")}${"c0ffee".repeat(6)}`.slice(0, 40);
    const parent = [];
    if (generated.length && r() > 0.05) {
      const k = r() < 0.25 ? (r() < 0.2 ? 3 : 2) : 1;
      const pool = generated.slice(-8);
      for (let v = 0; parent.length < k && v < 20; v++) {
        const p = pool[Math.floor(r() * pool.length)].hash;
        if (!parent.includes(p)) parent.push(p);
      }
    }
    generated.push({ hash, parents: parent });
  }
  let commits = generated.slice().reverse();
  if (r() < 0.5) commits = commits.slice(0, Math.max(1, commits.length - Math.floor(r() * 5)));
  const h = r() < 0.85 ? Math.floor(r() * commits.length) : -1;
  return commits.map((c, i) => ({ hash: c.hash, parents: c.parents, head: i === h, refs: randomRefs(r, i === h) }));
}
const C = (hash, parents, extra = {}) => ({ hash, parents, head: false, refs: [], ...extra });
const GRAPHS = [
  { name: "empty", commits: [] },
  { name: "root", commits: [C("r00t", [], { head: true, refs: [{ name: "main", kind: "head" }] })] },
  { name: "linear-without-parent", commits: [C("l1", ["l2"]), C("l2", null), C("l3", ["l4"]), C("l4", [])] },
  {
    // Like the fixture of the git sheet (mobile/test-fixtures/chat-gateway/routes-git.mjs): HEAD behind the remote, a merge, main, tags.
    name: "fixture",
    commits: [
      C("h1", ["a2"], { refs: [{ name: "cbase/agent-3f2a", kind: "local" }] }),
      C("a1", ["a2"], { head: true, refs: [{ name: "fn/till", kind: "head" }] }),
      C("r1", ["a3"], { refs: [{ name: "origin/fn/till", kind: "remote" }] }),
      C("a2", ["a3"]),
      C("a3", ["a4", "b1"]),
      C("b1", ["b2"], { refs: [{ name: "fn/proofs", kind: "local" }, { name: "origin/fn/proofs", kind: "remote" }] }),
      C("m1", ["a4"], { refs: [{ name: "main", kind: "local" }, { name: "origin/main", kind: "remote" }, { name: "v1.2", kind: "tag" }] }),
      C("b2", ["a4"]),
      C("a4", ["a5"]),
      C("a5", ["a6"], { refs: [{ name: "v1.1", kind: "tag" }] }),
      C("a6", []),
    ],
  },
  { name: "octopus", commits: [C("o", ["p1", "p2", "p3"], { head: true }), C("p1", ["w"]), C("p2", ["w"]), C("p3", ["w"]), C("w", [])] },
  { name: "merge-in-existing-lane", commits: [C("x", ["y"]), C("m", ["y", "z"]), C("y", ["w"]), C("z", ["w"]), C("w", [])] },
  { name: "two-children", commits: [C("k1", ["e"], { refs: [{ name: "a", kind: "local" }] }), C("k2", ["e"], { refs: [{ name: "b", kind: "local" }] }), C("e", [])] },
  { name: "head-in-the-middle", commits: [C("s1", ["s2"]), C("s2", ["s3"]), C("s3", ["s4"], { head: true }), C("s4", [])] },
  { name: "window", commits: [C("f1", ["f2", "outside1"]), C("f2", ["outside2"])] },
  { name: "duplicates-parent", commits: [C("d1", ["d2", "d2"]), C("d2", [])] },
  { name: "two-roots", commits: [C("u1", ["u2", "v1"]), C("u2", []), C("v1", [])] },
  {
    name: "badges",
    commits: [C("pl", ["pz"], {
      head: true,
      refs: [
        { name: "main", kind: "head" }, { name: "main", kind: "local" }, { name: "origin/main", kind: "remote" }, { name: "upstream/main", kind: "remote" },
        { name: "feature/a", kind: "local" }, { name: "Feature/B", kind: "local" }, { name: "origin/feature/a", kind: "remote" }, { name: "v1.10", kind: "tag" },
        { name: "v1.9", kind: "tag" }, { name: "/main", kind: "remote" }, { name: "broken", kind: "branch" }, { name: "", kind: "tag" }, { name: "origin", kind: "remote" },
      ],
    }), C("pz", [])],
  },
];
for (let s = 1; s <= 70; s++) GRAPHS.push({ name: `zufall-${s}`, commits: randomGraph(s) });

const COLORS = [];
for (const name of ["", "main", "a", "ä", "🌿", "fn/till", "c0ffee00", "cbase/agent-3f2a", "Ω-branch", "x".repeat(300)]) {
  for (const avoid of [[], [0], ["accent", 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4]]) COLORS.push({ name, avoid });
}
const GEOMETRY = [];
for (const width of [0, 0.5, 1, 1.9, 2, 3, 5, 8, 12, 20, 40, -3]) for (const maxPx of [0, 11, 12, 20, 33, 56, 60.7, 87, 94, 132, 200, -5]) GEOMETRY.push({ width, maxPx });
const MAX_PX = [0, -10, 100, 233, 234, 235, 272, 280.4, 361, 391, 393, 550, 551, 1000, 2.0833333];
const MORE = [];
for (const limit of [50, 100, 450, 499, 500, 600]) for (const loaded of [0, 49, 50, 100, 500]) for (const clipped of [true, false, null]) MORE.push({ limit, loaded, clipped });
const STATUSES = [
  {}, { hash: "abc", branch: "main", detached: false, upstream: "origin/main", ahead: 2, behind: 1 },
  { hash: "", branch: "", detached: true, upstream: null, ahead: 0, behind: 0 }, { branch: "x" }, { ahead: 3 },
];
const EXTENTS = [null, "", "all", "current", "Aktuell", " aktuell", "aktuell "];

const STATES = [];
{
  const r = prng(4242);
  const choice = (xs) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < 360; i++) {
    const l = {};
    const set = (k, xs) => { const v = choice(xs); if (v !== undefined) l[k] = v; };
    set("branch", [undefined, "", "main", "fn/till"]);
    set("detached", [undefined, false, true]);
    set("upstream", [undefined, null, "", "origin/main"]);
    set("ahead", [undefined, 0, 2, -1, 1.7, 0.4]);
    set("behind", [undefined, 0, 3, -2, 2.9]);
    set("remote", [undefined, false, true, true]);
    set("statusError", [undefined, "", "index unreadable"]);
    set("counts", [undefined, null, {}, { total: 0 }, { total: 3 }]);
    set("changes", [undefined, [], [{ path: "a" }], [{}, {}]]);
    STATES.push(l);
  }
}
const SELECT = [];
for (const selection of [null, [], ["a"], ["b"], ["a", "b"], ["c"]]) for (const k of ["a", "b"]) for (const addition of [false, true]) SELECT.push({ selection, k, addition });
const SHOWN = [
  { repos: ["", "a", "b"], selection: null }, { repos: ["", "a", "b"], selection: ["b", "a"] }, { repos: ["", "a", "b"], selection: ["way"] },
  { repos: ["", "a", "b"], selection: ["way", "b"] }, { repos: [], selection: ["a"] }, { repos: ["a"], selection: [] },
];
const GRAPH_REPOS = [
  { existing: ["", "frontend", "backend"], choice: null, shown: ["", "frontend", "backend"], withRemote: ["frontend", "backend"] },
  { existing: ["", "frontend", "backend"], choice: "backend", shown: ["", "frontend"], withRemote: ["frontend"] },
  { existing: ["", "frontend"], choice: "way", shown: [""], withRemote: ["frontend"] },
  { existing: ["", "frontend"], choice: "", shown: ["frontend"], withRemote: [] },
  { existing: ["", "frontend"], choice: null, shown: ["", "frontend"], withRemote: [] },
  { existing: ["", "frontend"], choice: null, shown: ["way"], withRemote: [] },
  { existing: [], choice: null, shown: [], withRemote: [] },
  { existing: ["x"], choice: null, shown: [], withRemote: ["x"] },
];
const CHOICES = [null, "", "a", "x".repeat(2047), "x".repeat(2048), "ä".repeat(2047), "🙂".repeat(1024), `${"🙂".repeat(1023)}a`, "/api/projects/p1?chat=c1"];
const COLLAPSED = [
  null, "", "{}", "[]", "null", "true", "1", "\"x\"", "{\"repos\":true}", "{\"repos\":1}", "{\"repos\":\"true\"}", "{\"graph\":true,\"aenderungen\":true}",
  "{\"branches\":true}", "{\"repos\":true,\"unknown\":true}", "{bad json", "{\"repos\":false,\"graph\":true}", " {\"graph\" : true } ", "{\"repos\":[true]}",
  "{\"__proto__\":{\"repos\":true}}", "{\"aenderungen\":true,\"graph\":null}",
];
const TOGGLE = [];
for (const closed of [[], ["repos"], ["graph", "changes"], ["repos", "changes", "graph"]]) for (const id of ["repos", "changes", "graph"]) TOGGLE.push({ closed, id });
const STATUS = ["M", "A", "D", "R", "C", "T", "U", "X", "", "m", "MM", "?"];

// All extensions and names of the icon table, read from the source — every entry is run, also one added later.
function filePaths() {
  const q = fs.readFileSync(path.join(lib, "git-files.ts"), "utf8");
  const block = (anchor) => {
    const i = q.indexOf(anchor);
    assert.ok(i >= 0, `git-files.ts: "${anchor}" is missing — follow up the anchor, do not delete the test`);
    return q.slice(i, q.indexOf(";", i));
  };
  const suffixes = [...block("const SHORTCUT").matchAll(/^\s*([a-z0-9]+):|, ([a-z0-9]+):/gm)].map((m) => m[1] ?? m[2]);
  const set = (anchor) => [...block(anchor).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const image = set("const IMAGE"), configSuffix = set("const CONFIG_SUFFIX"), configName = set("const CONFIG_NAME"), lock = set("const LOCK_NAME"), text = set("const TEXT");
  assert.ok(suffixes.length >= 40 && image.length >= 10 && configName.length >= 10 && lock.length >= 8, "the icon table was not read (regex)");
  const paths = [
    ...suffixes.map((e) => `src/file.${e}`), ...suffixes.map((e) => `DATEI.${e.toUpperCase()}`),
    ...image.map((e) => `images/a.${e}`), ...configSuffix.map((e) => `konfig.${e}`), ...configName, ...configName.map((n) => `deep/${n.toUpperCase()}`),
    ...lock.map((n) => `packages/${n}`), ...text.map((e) => `notiz.${e}`),
    "", "/", "a/", "README", ".env", ".env.local", "dockerfile.dev", "Dockerfile", "x.lock", "a.b.c.ts", ".hidden", "folder/.ts", "-dash.ts", "--", "ä/ö.md",
    "deep/very/deep/file", "no-point.", "Makefile", "go.sum", "foo.LOCK",
  ];
  return paths;
}

const RAW_LOG = [
  null, 1, "x", [], {}, { commits: "x" }, { commits: [null, 1, "a", [], {}] },
  { commits: [{ hash: "h1", short: "", subject: 5, author: "A", relative: "1 h ago", parents: ["p"], refs: [{ name: "main", kind: "head" }], head: true, time: 1761480000 }], clipped: true, extent: "all" },
  { commits: [{ hash: "h2", parents: null, refs: null, head: "true", time: "1" }], clipped: "yes", extent: "All" },
  { commits: [{ hash: "h3", parents: ["", "p"], refs: [{ name: "", kind: "local" }, { name: "x", kind: "branch" }, [], "r", { name: "t", kind: "tag", extra: 1 }], time: -3 }] },
  { commits: [{ hash: "h4", parents: [], refs: [{ name: "origin/x", kind: "remote" }], time: 1.5 }, { hash: "h4b", short: "short", parents: ["a", 3] }], clipped: false, extent: "current" },
  { commits: [{ hash: "ä-hash-longer-than-eight-is", head: false, time: 0 }] },
];
const RAW_FILES = [
  null, [], {}, { diff: "whole commit" }, { files: "x" }, { files: [] },
  { hash: "c1", parent: ["p1", "p2"], files: [{ path: "a.ts", status: "M" }, { path: "b.ts", old: "a.ts", status: "R" }, { path: "", status: "M" }, { path: "x", status: "Q" }, { path: "y" }, null, "z"], total: 7, clipped: true },
  { hash: 3, parent: [], files: [{ path: "fresh", old: "", status: "A" }], total: 2.5, clipped: "no" },
  { parent: ["", "p"], files: [{ path: "d", status: "D" }, { path: "k", old: "q", status: "C" }], total: -1 },
  { parent: null, files: [{ path: "t", status: "T" }, { path: "u", status: "U" }], total: 0 },
];
const RAW_DIFF = [
  [null, "a.ts"], [{ path: "a.ts", diff: "x" }, ""], [{ path: "a.ts", diff: "x" }, "a.ts"], [{ path: "b.ts", diff: "x" }, "a.ts"],
  [{ path: "a.ts", diff: 5 }, "a.ts"], [{ hash: "h", path: "./-x.ts", diff: "--- a\n+++ b\t\\", clipped: true }, "./-x.ts"], [{ diff: "whole" }, "a.ts"],
  [{ path: "a.ts", diff: "", clipped: "yes" }, "a.ts"],
];

const INPUT = {
  graphs: GRAPHS, colors: COLORS, geometry: GEOMETRY, maxPx: MAX_PX, more: MORE, statuses: STATUSES, extents: EXTENTS,
  states: STATES, select: SELECT, shown: SHOWN, graphRepos: GRAPH_REPOS, choices: CHOICES, collapsed: COLLAPSED, toggle: TOGGLE,
  status: STATUS, paths: filePaths(), rawLog: RAW_LOG, rawFiles: RAW_FILES, rawDiff: RAW_DIFF,
};

// ── output form (both sides exactly equal) ──────────────────────────────────────────────────────────────────────────────────
const e = (s) => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
const flag = (b) => (b ? "1" : "0");
const count = (n) => String(n);
const color = (f) => (f === "accent" ? "a" : String(f));
const lanes = (xs) => xs.map((s) => `${e(s.id)}:${color(s.color)}`).join(",");
const rowText = (z) => `s=${z.column};f=${color(z.color)};${z.kind};in=[${lanes(z.one)}];outgoing=[${lanes(z.outgoing)}];top=${z.top === null ? "-" : color(z.top)};bottom=${flag(z.bottom)};through=[${z.through.map((d) => `${d.from}>${d.to}:${color(d.color)}`).join(",")}];incoming=[${z.incoming.map((d) => `${d.from}:${color(d.color)}`).join(",")}];branching=[${z.branching.map((d) => `${d.to}:${color(d.color)}`).join(",")}]`;
const list = (xs) => (xs === null || xs === undefined ? "-" : `[${xs.map(e).join(",")}]`);
const optText = (x) => (x === null || x === undefined ? "-" : e(x));
const optBool = (b) => (b === null || b === undefined ? "-" : flag(b));

async function webRows() {
  const tmp = fs.mkdtempSync(path.join(webDir, "node_modules", ".gitleiste-binding-"));
  cleanUp.push(tmp);
  execFileSync(process.execPath, [
    tsc, path.join(lib, "git-graph.ts"), path.join(lib, "git-bar.ts"), path.join(lib, "git-files.ts"), path.join(lib, "api", "git.ts"),
    "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", tmp,
  ], { cwd: webDir, stdio: "pipe" });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  const g = await import(pathToFileURL(path.join(tmp, "git-graph.js")).href);
  const l = await import(pathToFileURL(path.join(tmp, "git-bar.js")).href);
  const d = await import(pathToFileURL(path.join(tmp, "git-files.js")).href);
  const a = await import(pathToFileURL(path.join(tmp, "api", "git.js")).href);
  const z = [];
  const emit = (...t) => z.push(t.join("\t"));
  emit("K", "LANE_COLORS", g.LANE_COLORS); emit("K", "LANE_PX", g.LANE_PX); emit("K", "LANE_MIN_PX", g.LANE_MIN_PX);
  emit("K", "GRAPH_EXTENT_KEY", g.GRAPH_EXTENT_KEY); emit("K", "GRAPH_REPO_KEY", l.GRAPH_REPO_KEY); emit("K", "SECTIONS_KEY", l.SECTIONS_KEY);
  emit("K", "GRAPH_STEP", l.GRAPH_STEP); emit("K", "GRAPH_MAX", l.GRAPH_MAX); emit("K", "GIT_SECTIONS", l.GIT_SECTIONS.join(","));
  for (const sz of INPUT.graphs) {
    const r = g.computeLanes(sz.commits);
    emit("B", sz.name, r.width, flag(r.linear));
    r.rows.forEach((zz, i) => {
      emit("G", `${sz.name}#${i}`, rowText(zz));
      emit("D", `${sz.name}#${i}`, g.continuousLanes(zz).map((s) => `${s.column}:${color(s.color)}:${flag(s.own)}`).join(","));
    });
    sz.commits.forEach((c, i) => emit("P", `${sz.name}#${i}`, g.badges(c.refs).map((p) => `${p.kind}:${e(p.name)}${p.remote ? `@${e(p.remote)}` : ""}`).join("|")));
  }
  INPUT.colors.forEach((f, i) => emit("F", String(i), g.laneColorFor(f.name, f.avoid)));
  INPUT.geometry.forEach((x, i) => { const s = g.laneGeometry(x.width, x.maxPx); emit("S", String(i), `${s.w}|${s.clipFrom === null ? "-" : s.clipFrom}|${s.columns}`); });
  INPUT.maxPx.forEach((x, i) => emit("M", String(i), count(g.graphMaxPx(x))));
  INPUT.more.forEach((x, i) => { const n = g.loadMore(x.limit, x.loaded, x.clipped, l.GRAPH_STEP, l.GRAPH_MAX); emit("L", String(i), n === null ? "-" : count(n)); });
  INPUT.statuses.forEach((x, i) => emit("T", String(i), e(g.graphState({ lastCommit: x.hash === undefined ? undefined : { hash: x.hash }, ...x }))));
  INPUT.extents.forEach((x, i) => emit("U", String(i), g.readExtent(x)));
  INPUT.states.forEach((x, i) => {
    const p = l.primaryButton(x);
    const pt = p.kind === "commit" ? `commit:${flag(p.unknown)}` : p.kind === "synchronize" ? `sync:${p.ahead},${p.behind}` : p.kind;
    emit("R", String(i), `${pt}|${l.syncSteps(x).join(",")}|${flag(l.hasChanges(x))}|${flag(l.hasSomethingToDo(x))}`);
  });
  INPUT.select.forEach((x, i) => emit("W", String(i), list(l.selectRepo(x.selection, x.k, x.addition))));
  INPUT.shown.forEach((x, i) => emit("Z", String(i), `${list(l.shownRepos(x.repos, (k) => k, x.selection))}|${list(l.tidySelection(x.selection, x.repos))}`));
  INPUT.graphRepos.forEach((x, i) => emit("Q", String(i), optText(l.graphRepo(x.existing, x.choice, x.shown, x.withRemote))));
  INPUT.choices.forEach((x, i) => { const w = l.readGraphChoice(x); emit("V", String(i), w === null ? "-" : w === x ? "=" : `?${e(w)}`); });
  const toText = (o) => l.GIT_SECTIONS.filter((id) => o[id] === true).join(",");
  INPUT.collapsed.forEach((x, i) => emit("A", String(i), toText(l.readCollapsed(x))));
  INPUT.toggle.forEach((x, i) => emit("Y", String(i), toText(l.toggleCollapsed(Object.fromEntries(x.closed.map((k) => [k, true])), x.id))));
  INPUT.status.forEach((s, i) => {
    const display = d.commitStatusDisplay(s);
    const kind = d.COMMIT_STATUS_KIND[s]?.kind ?? null;
    // The colour of the web follows from the kind alone — the Swift side colours by the same kind (Code/GitPane.swift).
    assert.equal(display.color, kind ? d.KIND_COLOR[kind] : "text-dim", `commitStatusDisplay(${s}): the colour does not follow from the kind`);
    emit("C", String(i), `${kind ?? "-"}|${e(display.letter)}|${e(display.label)}|${flag(display.deleted)}`);
  });
  INPUT.paths.forEach((p, i) => {
    const t = d.partsPath(p);
    const kind = d.fileKind(p);
    emit("X", String(i), `${e(t.name)}|${e(t.folder)}|${e(d.diffPath(p))}|${kind.kind}|${kind.kind === "shortcut" ? e(kind.shortcut) : "-"}|${kind.tone}`);
  });
  INPUT.rawLog.forEach((x, i) => {
    const log = a.normGitGraphLog(x);
    const cs = log.commits.map((c) => [c.hash, c.short, c.subject, c.author, c.relative, list(c.parents), c.refs.map((r) => `${r.kind}:${e(r.name)}`).join(","), flag(c.head), c.time === null ? "-" : count(c.time)].map((v, k) => (k <= 4 ? e(v) : v)).join("|")).join(";");
    emit("NG", String(i), `${cs}#${optBool(log.clipped)}#${optText(log.extent)}`);
  });
  INPUT.rawFiles.forEach((x, i) => {
    const w = a.normGitCommitFiles(x);
    emit("ND", String(i), w === null ? "-" : `${e(w.hash)}|${list(w.parent)}|${w.files.map((f) => `${f.status}:${e(f.path)}<${optText(f.old)}`).join(",")}|${w.total === null ? "-" : count(w.total)}|${optBool(w.clipped)}|${w.unreadable}`);
  });
  INPUT.rawDiff.forEach(([x, p], i) => {
    const w = a.normGitCommitFileDiff(x, p);
    emit("NF", String(i), w === null ? "-" : `${e(w.hash)}|${e(w.path)}|${e(w.diff)}|${optBool(w.clipped)}`);
  });
  return { rows: z, bar: l };
}

// ── The Swift side: JSONValue + the two files + their sabotages + a main program ─────────────────────────────────────
// The main program per namespace (NS_G and NS_L are replaced); P is the prefix of the output ("" real, "S3:" sabotage 3).
const DRIVER_HEADER = String.raw`
import Foundation

func s(_ v: JSONValue?) -> String? { if case .string(let x)? = v { return x }; return nil }
func n(_ v: JSONValue?) -> Double? { if case .number(let x)? = v { return x }; return nil }
func b(_ v: JSONValue?) -> Bool? { if case .bool(let x)? = v { return x }; return nil }
func a(_ v: JSONValue?) -> [JSONValue] { if case .array(let x)? = v { return x }; return [] }
func strs(_ v: JSONValue?) -> [String]? { if case .array(let x)? = v { return x.compactMap { s($0) } }; return nil }
func e(_ x: String) -> String { x.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\t", with: "\\t") }
func flag(_ x: Bool) -> String { x ? "1" : "0" }
func count(_ d: Double) -> String { d == d.rounded(.down) && abs(d) < 1e15 ? String(Int(d)) : "\(d)" }
func list(_ xs: [String]?) -> String { xs.map { "[" + $0.map(e).joined(separator: ",") + "]" } ?? "-" }
func optText(_ x: String?) -> String { x.map(e) ?? "-" }
func optBool(_ x: Bool?) -> String { x.map(flag) ?? "-" }
func emitRow(_ t: String...) { print(t.joined(separator: "\t")) }
let input: JSONValue = try! JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: "INPUT_PATH")))
`;
const DRIVER_GRAPH = String.raw`
func color_NS_G(_ f: NS_G.LaneColor) -> String { switch f { case .accent: return "a"; case .palette(let i): return String(i) } }
func commits_NS_G(_ v: JSONValue?) -> [NS_G.Commit] {
    a(v).map { c in
        NS_G.Commit(hash: s(c["hash"]) ?? "", parents: strs(c["parents"]), head: b(c["head"]) ?? false,
                    refs: a(c["refs"]).map { NS_G.Ref(name: s($0["name"]) ?? "", kind: s($0["kind"]) ?? "") })
    }
}
func lanes_NS_G(_ xs: [NS_G.Lane]) -> String { xs.map { "\(e($0.id)):\(color_NS_G($0.color))" }.joined(separator: ",") }
func row_NS_G(_ z: NS_G.Row) -> String {
    let through = z.through.map { "\($0.from)>\($0.to):\(color_NS_G($0.color))" }.joined(separator: ",")
    let incoming = z.incoming.map { "\($0.from):\(color_NS_G($0.color))" }.joined(separator: ",")
    let branching = z.branching.map { "\($0.to):\(color_NS_G($0.color))" }.joined(separator: ",")
    return "s=\(z.column);f=\(color_NS_G(z.color));\(z.kind.rawValue);in=[\(lanes_NS_G(z.one))];outgoing=[\(lanes_NS_G(z.outgoing))];top=\(z.top.map(color_NS_G) ?? "-");bottom=\(flag(z.bottom));through=[\(through)];incoming=[\(incoming)];branching=[\(branching)]"
}
func runGraph_NS_G(_ P: String) {
    emitRow(P + "K", "LANE_COLORS", String(NS_G.LANE_COLORS)); emitRow(P + "K", "LANE_PX", String(NS_G.LANE_PX)); emitRow(P + "K", "LANE_MIN_PX", String(NS_G.LANE_MIN_PX))
    emitRow(P + "K", "GRAPH_EXTENT_KEY", NS_G.GRAPH_EXTENT_KEY)
    for sz in a(input["graphs"]) {
        let name = s(sz["name"]) ?? ""
        let cs = commits_NS_G(sz["commits"])
        let r = NS_G.computeLanes(cs)
        emitRow(P + "B", name, String(r.width), flag(r.linear))
        for (i, z) in r.rows.enumerated() {
            emitRow(P + "G", "\(name)#\(i)", row_NS_G(z))
            emitRow(P + "D", "\(name)#\(i)", NS_G.continuousLanes(z).map { "\($0.column):\(color_NS_G($0.color)):\(flag($0.own))" }.joined(separator: ","))
        }
        for (i, c) in cs.enumerated() {
            emitRow(P + "P", "\(name)#\(i)", NS_G.badges(c.refs).map { "\($0.kind):\(e($0.name))\($0.remote.map { "@" + e($0) } ?? "")" }.joined(separator: "|"))
        }
    }
    for (i, f) in a(input["colors"]).enumerated() {
        let avoid: [NS_G.LaneColor] = a(f["avoid"]).map { m in s(m) == "accent" ? .accent : .palette(Int(n(m) ?? -1)) }
        emitRow(P + "F", String(i), String(NS_G.laneColorFor(s(f["name"]) ?? "", avoid: avoid)))
    }
    for (i, x) in a(input["geometry"]).enumerated() {
        let g = NS_G.laneGeometry(n(x["width"]) ?? 0, n(x["maxPx"]) ?? 0)
        emitRow(P + "S", String(i), "\(g.w)|\(g.clipFrom.map(String.init) ?? "-")|\(g.columns)")
    }
    for (i, x) in a(input["maxPx"]).enumerated() { emitRow(P + "M", String(i), count(NS_G.graphMaxPx(n(x) ?? 0))) }
    for (i, x) in a(input["more"]).enumerated() {
        let m = NS_G.loadMore(Int(n(x["limit"]) ?? 0), Int(n(x["loaded"]) ?? 0), b(x["clipped"]), GitBar.GRAPH_STEP, GitBar.GRAPH_MAX)
        emitRow(P + "L", String(i), m.map(String.init) ?? "-")
    }
    for (i, x) in a(input["statuses"]).enumerated() {
        emitRow(P + "T", String(i), e(NS_G.graphState(hash: s(x["hash"]), branch: s(x["branch"]), detached: b(x["detached"]), upstream: s(x["upstream"]),
                                                 ahead: n(x["ahead"]).map { Int($0) }, behind: n(x["behind"]).map { Int($0) })))
    }
    for (i, x) in a(input["extents"]).enumerated() { emitRow(P + "U", String(i), NS_G.readExtent(s(x)).rawValue) }
}
`;
const DRIVER_BAR = String.raw`
func situation_NS_L(_ v: JSONValue) -> NS_L.RepoSituation {
    var counts: Double?
    if case .object(let o)? = v["counts"] { counts = n(o["total"]) }
    var changes: Int?
    if case .array(let xs)? = v["changes"] { changes = xs.count }
    return NS_L.RepoSituation(branch: s(v["branch"]), detached: b(v["detached"]), upstream: s(v["upstream"]), ahead: n(v["ahead"]), behind: n(v["behind"]),
                         remote: b(v["remote"]) ?? false, statusError: s(v["statusError"]), countsTotal: counts, changes: changes)
}
func closedText_NS_L(_ closed: Set<String>) -> String { NS_L.GIT_SECTIONS.filter(closed.contains).joined(separator: ",") }
func runBar_NS_L(_ P: String) {
    emitRow(P + "K", "GRAPH_REPO_KEY", NS_L.GRAPH_REPO_KEY); emitRow(P + "K", "SECTIONS_KEY", NS_L.SECTIONS_KEY)
    emitRow(P + "K", "GRAPH_STEP", String(NS_L.GRAPH_STEP)); emitRow(P + "K", "GRAPH_MAX", String(NS_L.GRAPH_MAX)); emitRow(P + "K", "GIT_SECTIONS", NS_L.GIT_SECTIONS.joined(separator: ","))
    for (i, x) in a(input["states"]).enumerated() {
        let l = situation_NS_L(x)
        let pt: String
        switch NS_L.primaryButton(l) {
        case .commit(let u): pt = "commit:\(flag(u))"
        case .synchronize(let ah, let be): pt = "sync:\(ah),\(be)"
        case .publish: pt = "publish"
        case .nothing: pt = "off"
        }
        emitRow(P + "R", String(i), "\(pt)|\(NS_L.syncSteps(l).joined(separator: ","))|\(flag(NS_L.hasChanges(l)))|\(flag(NS_L.hasSomethingToDo(l)))")
    }
    for (i, x) in a(input["select"]).enumerated() {
        emitRow(P + "W", String(i), list(NS_L.selectRepo(strs(x["selection"]), s(x["k"]) ?? "", b(x["addition"]) ?? false)))
    }
    for (i, x) in a(input["shown"]).enumerated() {
        let repos = strs(x["repos"]) ?? []
        emitRow(P + "Z", String(i), "\(list(NS_L.shownRepos(repos, { $0 }, strs(x["selection"]))))|\(list(NS_L.tidySelection(strs(x["selection"]), repos)))")
    }
    for (i, x) in a(input["graphRepos"]).enumerated() {
        emitRow(P + "Q", String(i), optText(NS_L.graphRepo(strs(x["existing"]) ?? [], s(x["choice"]), strs(x["shown"]) ?? [], strs(x["withRemote"]) ?? [])))
    }
    for (i, x) in a(input["choices"]).enumerated() {
        let w = NS_L.readGraphChoice(s(x))
        emitRow(P + "V", String(i), w == nil ? "-" : w == s(x) ? "=" : "?" + e(w!))
    }
    for (i, x) in a(input["collapsed"]).enumerated() { emitRow(P + "A", String(i), closedText_NS_L(NS_L.readCollapsed(s(x)))) }
    for (i, x) in a(input["toggle"]).enumerated() {
        emitRow(P + "Y", String(i), closedText_NS_L(NS_L.toggleCollapsed(Set(strs(x["closed"]) ?? []), s(x["id"]) ?? "")))
    }
    for (i, x) in a(input["toggle"]).enumerated() {
        emitRow(P + "J", String(i), NS_L.writeCollapsed(NS_L.toggleCollapsed(Set(strs(x["closed"]) ?? []), s(x["id"]) ?? "")))
    }
    for (i, x) in a(input["status"]).enumerated() {
        let anz = NS_L.commitStatusDisplay(s(x) ?? "")
        emitRow(P + "C", String(i), "\(anz.kind ?? "-")|\(e(anz.letter))|\(e(anz.label))|\(flag(anz.deleted))")
    }
    for (i, x) in a(input["paths"]).enumerated() {
        let p = s(x) ?? ""
        let t = NS_L.partsPath(p)
        let kind = NS_L.fileKind(p)
        emitRow(P + "X", String(i), "\(e(t.name))|\(e(t.folder))|\(e(NS_L.diffPath(p)))|\(kind.kind)|\(kind.shortcut.map(e) ?? "-")|\(kind.tone)")
    }
    for (i, x) in a(input["rawLog"]).enumerated() {
        let log = NS_L.normGitGraphLog(x)
        let cs = log.commits.map { c in
            [e(c.hash), e(c.short), e(c.subject), e(c.author), e(c.relative), list(c.parents), c.refs.map { "\($0.kind):\(e($0.name))" }.joined(separator: ","),
             flag(c.head), c.time.map(count) ?? "-"].joined(separator: "|")
        }.joined(separator: ";")
        emitRow(P + "NG", String(i), "\(cs)#\(optBool(log.clipped))#\(optText(log.extent))")
    }
    for (i, x) in a(input["rawFiles"]).enumerated() {
        if let w = NS_L.normGitCommitFiles(x) {
            let ds = w.files.map { "\($0.status):\(e($0.path))<\(optText($0.old))" }.joined(separator: ",")
            emitRow(P + "ND", String(i), "\(e(w.hash))|\(list(w.parent))|\(ds)|\(w.total.map(String.init) ?? "-")|\(optBool(w.clipped))|\(w.unreadable)")
        } else { emitRow(P + "ND", String(i), "-") }
    }
    for (i, x) in a(input["rawDiff"]).enumerated() {
        let paar = a(x)
        if let w = NS_L.normGitCommitFileDiff(paar.first, s(paar.count > 1 ? paar[1] : nil) ?? "") {
            emitRow(P + "NF", String(i), "\(e(w.hash))|\(e(w.path))|\(e(w.diff))|\(optBool(w.clipped))")
        } else { emitRow(P + "NF", String(i), "-") }
    }
}
`;

const cleanUp = [];
after(() => { for (const d of cleanUp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } } });

const once = (text, anchor, file) => {
  const n = text.split(anchor).length - 1;
  assert.equal(n, 1, `sabotage anchor occurs ${n}× instead of exactly once in ${file}: ${anchor}`);
};

function swiftRows() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gitleiste-binding-"));
  cleanUp.push(tmp);
  const inputPath = path.join(tmp, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(INPUT));
  const graph = fs.readFileSync(SWIFT_GRAPH, "utf8");
  const bar = fs.readFileSync(SWIFT_BAR, "utf8");
  const parts = [fs.readFileSync(SWIFT_JSON, "utf8").replace(/^import Foundation$/m, ""), graph.replace(/^import Foundation$/m, ""), bar.replace(/^import Foundation$/m, "")];
  const main = [DRIVER_HEADER.replace("INPUT_PATH", inputPath), DRIVER_GRAPH.replaceAll("NS_G", "GitGraph"), DRIVER_BAR.replaceAll("NS_L", "GitBar")];
  const calls = ['runGraph_GitGraph("")', 'runBar_GitBar("")'];
  SABOTAGES.forEach(([ns, name, anchor, replacement], k) => {
    const source = ns === "graph" ? graph : bar;
    once(source, anchor, ns === "graph" ? "GitGraphComputation.swift" : "GitBarComputation.swift");
    const copyNs = ns === "graph" ? `GitGraph_S${k}` : `GitBar_S${k}`;
    const copy = source.replace(anchor, replacement).replace(/^import Foundation$/m, "").replace(ns === "graph" ? /\bGitGraph\b/g : /\bGitBar\b/g, copyNs);
    parts.push(`// sabotage ${k}: ${name}\n${copy}`);
    if (ns === "graph") { main.push(DRIVER_GRAPH.replaceAll("NS_G", copyNs)); calls.push(`runGraph_${copyNs}("S${k}:")`); }
    else { main.push(DRIVER_BAR.replaceAll("NS_L", copyNs)); calls.push(`runBar_${copyNs}("S${k}:")`); }
  });
  const file = path.join(tmp, "binding.swift");
  fs.writeFileSync(file, ["import Foundation", ...parts, ...main, ...calls].join("\n"));
  const bin = path.join(tmp, "binding");
  try {
    // Compiled instead of interpreted: nineteen copies are noticeably slower in the JIT of `xcrun swift` than a swiftc run.
    execFileSync("xcrun", ["swiftc", "-Onone", "-suppress-warnings", file, "-o", bin], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    assert.fail(`the Swift computation could not be compiled (xcrun swiftc): ${err.stderr || err.message}`);
  }
  return execFileSync(bin, [], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
}

let measured = null;
const measure = async () => (measured ??= { web: await webRows(), swift: swiftRows() });

const asCard = (rows) => {
  const m = new Map();
  for (const z of rows) {
    const t = z.split("\t");
    m.set(`${t[0]}\t${t[1]}`, t.slice(2).join("\t"));
  }
  return m;
};

test("binding: lanes, colours, badges, geometry and \"Load more\" compute in Swift like in git-graph.ts", async () => {
  const { web, swift } = await measure();
  const w = asCard(web.rows);
  const real = asCard(swift.filter((z) => !/^S\d+:/.test(z)));
  const kinds = ["B", "G", "D", "P", "F", "S", "M", "L", "T", "U"];
  const deviations = [];
  let n = 0;
  for (const [k, v] of w) {
    if (!kinds.includes(k.split("\t")[0]) && !(k.startsWith("K\t") && ["LANE_COLORS", "LANE_PX", "LANE_MIN_PX", "GRAPH_EXTENT_KEY"].includes(k.split("\t")[1]))) continue;
    n++;
    if (real.get(k) !== v) deviations.push(`${k}\n    Web:   ${v}\n    Swift: ${real.get(k)}`);
  }
  const rows = web.rows.filter((z) => z.startsWith("G\t")).length;
  console.log(`# git graph: ${GRAPHS.length} graphs (${rows} rows), ${COLORS.length} colours, ${GEOMETRY.length} geometries, ${MORE.length} "Load more" — ${n} comparisons`);
  assert.ok(rows > 500, `too few graph rows (${rows}) — the case set no longer measures anything`);
  assert.deepEqual(deviations.slice(0, 12), [], `Swift ≠ git-graph.ts (${deviations.length} Abweichungen):\n  ${deviations.slice(0, 12).join("\n  ")}`);
});

test("binding: primary button, synchronise, selection, graph repo, remembered choice, sections, files and allowlists like on the web", async () => {
  const { web, swift } = await measure();
  const w = asCard(web.rows);
  const real = asCard(swift.filter((z) => !/^S\d+:/.test(z)));
  const kinds = ["R", "W", "Z", "Q", "V", "A", "Y", "C", "X", "NG", "ND", "NF"];
  const deviations = [];
  let n = 0;
  for (const [k, v] of w) {
    const kind = k.split("\t")[0];
    if (!kinds.includes(kind) && !(kind === "K" && ["GRAPH_REPO_KEY", "SECTIONS_KEY", "GRAPH_STEP", "GRAPH_MAX", "GIT_SECTIONS"].includes(k.split("\t")[1]))) continue;
    n++;
    if (real.get(k) !== v) deviations.push(`${k}\n    Web:   ${v}\n    Swift: ${real.get(k)}`);
  }
  console.log(`# git bar: ${STATES.length} repo states, ${INPUT.paths.length} paths, ${RAW_LOG.length + RAW_FILES.length + RAW_DIFF.length} raw answers — ${n} comparisons`);
  assert.deepEqual(deviations.slice(0, 12), [], `Swift ≠ git-bar.ts/git-files.ts/api/git.ts (${deviations.length} Abweichungen):\n  ${deviations.slice(0, 12).join("\n  ")}`);
  // The stored state of the sections: what Swift writes, the web reads back as the same state (one key, two readers).
  const toText = (o) => web.bar.GIT_SECTIONS.filter((id) => o[id] === true).join(",");
  for (const [k, v] of asCard(swift)) {
    if (!k.startsWith("J\t")) continue;
    const i = k.split("\t")[1];
    assert.equal(toText(web.bar.readCollapsed(v)), w.get(`Y\t${i}`), `Swift writes the state ${v}, the web reads something else`);
  }
});

test("sabotage (built in): every deviation in a copy of the Swift files shows on at least one line", async () => {
  const { web, swift } = await measure();
  const w = asCard(web.rows);
  const silent = [];
  SABOTAGES.forEach(([, name], k) => {
    const prefix = `S${k}:`;
    const copy = asCard(swift.filter((z) => z.startsWith(prefix)).map((z) => z.slice(prefix.length)));
    assert.ok(copy.size > 20, `sabotage ${k} (${name}) printed nothing`);
    let different = 0;
    for (const [key, v] of copy) if (w.has(key) && w.get(key) !== v) different++;
    if (different === 0) silent.push(`${k}: ${name}`);
  });
  console.log(`# sabotages: ${SABOTAGES.length} copies, ${SABOTAGES.length - silent.length} are noticed`);
  assert.deepEqual(silent, [], `the case set does not notice these sabotages — so it does not check them:\n  ${silent.join("\n  ")}`);
});

test("execution side: the git sheet calls the bound computations instead of keeping its own", () => {
  const code = (rel) => fs.readFileSync(path.join(app, rel), "utf8").replace(/\/\/[^\n]*/g, "");
  const pane = code("Code/GitPane.swift");
  const graph = code("Code/GitGraphSection.swift");
  const model = pane.slice(pane.indexOf("final class GitModel"), pane.indexOf("\nstruct GitStashEntry"));
  const missing = [];
  for (const [location, text, calls] of [
    ["GitModel", model, ["GitBar.normGitGraphLog(", "GitBar.normGitCommitFiles(", "GitBar.normGitCommitFileDiff(", "GitBar.readCollapsed(", "GitBar.writeCollapsed(", "GitBar.readGraphChoice(", "GitGraph.readExtent(", "GitBar.graphRepo(", "GitBar.shownRepos(", "GitBar.selectRepo(", "GitBar.tidySelection(", "GitBar.syncSteps("]],
    ["GitPane", pane, ["GitBar.primaryButton(", "GitBar.hasSomethingToDo("]],
    ["GitGraphSection", graph, ["GitGraph.computeLanes(", "GitGraph.continuousLanes(", "GitGraph.badges(", "GitGraph.laneGeometry(", "GitGraph.graphMaxPx(", "GitGraph.loadMore(", "GitGraph.graphState(", "GitBar.commitStatusDisplay(", "GitBar.fileKind(", "GitBar.partsPath(", "GitBar.diffPath("]],
  ]) for (const r of calls) if (!text.includes(r)) missing.push(`${location} does not call ${r}…)`);
  assert.deepEqual(missing, [], "the git sheet computes past the bound twins");
  // The lane computation exists exactly ONCE: no second `computeLanes` and no own FNV in the app.
  const all = [];
  const run = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) run(p); else if (f.name.endsWith(".swift")) all.push(p); } };
  run(app);
  const duplicate = all.filter((p) => p !== SWIFT_GRAPH && /func computeLanes\(|0x01000193/.test(fs.readFileSync(p, "utf8")));
  assert.deepEqual(duplicate.map((p) => path.relative(app, p)), [], "a second lane computation in the app");
});
