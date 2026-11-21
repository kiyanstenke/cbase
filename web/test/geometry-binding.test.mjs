// The geometry of the workflow canvas: ONE computation, two languages.
//
// `web/src/lib/graph-geometry.ts` and `mobile/…/Workflows/WorkflowGeometry.swift` are the same computation: the same building
// blocks (`anchorAt`, `spread`/`outSlots`, `branchKey`, `route`, `cycleEdges`, docks), the same numbers (232/84, 24, 28, 12, 0.15).
// Nothing of it was bound: `web/test/graph-geometry.test.mjs` compiles only the TS file. If one of the two runs away, the same
// graph shows different paths on the iPhone than on the desktop — and nobody notices because both sides look plausible on their
// own.
//
// The Swift version is NOT "byte-equal" with the TS file and cannot be — they are two languages. What holds instead: **the
// numbers are the same, measured on the same cases.**
//
// Model: `web/test/effort-ios.test.mjs` — cut out a Swift block, assemble it with stand-ins into one program and REALLY run it
// with `xcrun swift`. If the toolchain is missing, the test fails LOUDLY; a silent skip would count as passed for xcodebuild as
// for `./check`.
//
// Two halves:
//   1. the TYPES table (which kind is compact, entry, fixed; which outputs it carries) — on the web it lives in
//      `components/workflow/WorkflowEditor.tsx` (FIXED, COMPACT_*, `outPorts`) and ENTRIES in the leaf `WorkflowBadge.tsx`; on
//      mobile IN the geometry file. Two places, the same statement.
//   2. the COMPUTATION — constants, `anchorAt`, `outSlots`, `route` over a matrix of positions, `cycleEdges`, and the wiring of
//      a whole graph.
//
// Run:  node --test web/test/geometry-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "graph-geometry.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Workflows", "WorkflowGeometry.swift");
const SOURCE_EDITOR = path.join(webDir, "src", "components", "workflow", "WorkflowEditor.tsx");
const SOURCE_BADGE = path.join(webDir, "src", "components", "workflow", "WorkflowBadge.tsx");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// ── The cases. Both sides compute EXACTLY these, in this order. ──────────────────────
const R = (x, y, w = 232, h = 84) => ({ x, y, w, h });
// Positions that each trigger one form of routing: side by side (stairs), barely side by side
// (under stairMin ⇒ detour), on top of each other (bracket), overlapping, and backwards (target on the left).
const PAIRS = [
  ["sideBySide", R(0, 0), R(400, 0)],
  ["side-by-side-staggered", R(0, 0), R(400, 200)],
  ["tight", R(0, 0), R(232 + 8, 0)],
  ["tight-under-stairMin", R(0, 0), R(232 + 11, 140)],
  ["exactly-stairMin", R(0, 0), R(232 + 12, 140)],
  ["stacked", R(0, 0), R(0, 300)],
  ["stacked-tight", R(0, 0), R(0, 90)],
  ["backward", R(600, 0), R(0, 0)],
  ["backward-up", R(600, 300), R(0, 0)],
  ["overlapping", R(0, 0), R(60, 40)],
  ["same-situation", R(120, 120), R(120, 120)],
  ["compact-after-large", R(0, 0, 160, 44), R(400, 20)],
  ["large-after-compact", R(0, 0), R(400, 20, 160, 44)],
  ["negative", R(-1104, -280), R(-700, -120)],
];
const PAGES = ["left", "right"];
const SLOTS = [0.5, 0.2, 0.8];
const INSETS = [0, 6];
const cases = [];
for (const [name, s, d] of PAIRS) {
  for (const fs_ of PAGES) for (const ts_ of PAGES) for (const slot of SLOTS) for (const inset of INSETS) {
    cases.push({ name: `${name}|${fs_}${slot}|${ts_}|${inset}`, s, d, from: { side: fs_, slot }, to: { side: ts_, slot: 0.5 }, inset });
  }
}
// Cycles: none, simple, two separate, self edge.
const EDGE_SETS = [
  ["without", [["a", "b"], ["b", "c"]]],
  ["simple", [["a", "b"], ["b", "c"], ["c", "a"]]],
  ["two", [["a", "b"], ["b", "a"], ["c", "d"], ["d", "c"], ["a", "c"]]],
  ["itself", [["a", "a"], ["a", "b"]]],
];
// A graph with fixed and free nodes, stored docks and an edge into nothing.
const GRAPH = {
  nodes: [
    { id: "n1", type: "start", x: 0, y: 0 },
    { id: "n2", type: "instruction", x: 300, y: 0 },
    { id: "n3", type: "condition", x: 700, y: 0 },
    { id: "n4", type: "loop", x: 700, y: 300 },
    { id: "n5", type: "review", x: 1100, y: 0 },
    { id: "n6", type: "end", x: 1500, y: 0 },
  ],
  edges: [
    { from: "n1", to: "n2", branch: null, fromSide: "", toSide: "" },
    { from: "n2", to: "n3", branch: null, fromSide: "left", toSide: "right" },
    { from: "n3", to: "n5", branch: "true", fromSide: "", toSide: "" },
    { from: "n3", to: "n4", branch: "false", fromSide: "", toSide: "left" },
    { from: "n4", to: "n2", branch: "each", fromSide: "", toSide: "right" },
    { from: "n5", to: "n6", branch: "ok", fromSide: "", toSide: "" },
    { from: "n5", to: "n2", branch: "issues", fromSide: "", toSide: "" },
    { from: "n2", to: "missing", branch: null, fromSide: "", toSide: "" },
  ],
};
const KINDS = ["trigger", "start", "instruction", "condition", "loop", "parallel", "ask", "review", "end"];

const z = (n) => (Math.round(n * 1e6) / 1e6).toString();
const points = (ps) => ps.map((p) => `${z(p.x)},${z(p.y)}`).join(" ");

// ── The TS side: compile and import (modelled on graph-geometry.test.mjs) ──────────────
let tmpTs = null;
async function geometryTs() {
  tmpTs = fs.mkdtempSync(path.join(webDir, "node_modules", ".geobind-"));
  execFileSync(process.execPath, [
    tsc, SOURCE_TS, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", tmpTs,
  ], { cwd: webDir, stdio: "pipe" });
  fs.writeFileSync(path.join(tmpTs, "package.json"), '{"type":"module"}');
  return import(pathToFileURL(path.join(tmpTs, "graph-geometry.js")).href);
}

// The types table of the WEB lives in the editor, not in the geometry — read by path and anchored at the
// name of the declaration (a missed anchor THROWS instead of delivering an empty set).
function editorTable() {
  const src = fs.readFileSync(SOURCE_EDITOR, "utf8");
  const fixed = src.match(/const FIXED = new Set<WorkflowNodeType>\(\[([^\]]*)\]\);/);
  const entries = fs.readFileSync(SOURCE_BADGE, "utf8").match(/^export const ENTRIES: WorkflowNodeType\[\] = \[([^\]]*)\];$/m);
  const cw = src.match(/^const COMPACT_W = (\d+);$/m);
  const ch = src.match(/^const COMPACT_H = (\d+);$/m);
  const compact = src.match(/^const compact = \(type: WorkflowNodeType\) => ([^;]+);$/m);
  for (const [n, m] of [["FIXED", fixed], ["ENTRIES", entries], ["COMPACT_W", cw], ["COMPACT_H", ch], ["compact", compact]]) {
    assert.ok(m, `${n} not found in WorkflowEditor.tsx (ENTRIES: WorkflowBadge.tsx) — renamed? Follow up the anchor, do not delete the test`);
  }
  const list = (s) => s.split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
  const compactValue = [...compact[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  // The branches per kind from `outPorts` — order included, it IS the position of the outputs.
  const op = src.slice(src.indexOf("function outPorts(type: WorkflowNodeType)"));
  const body = op.slice(0, op.indexOf("\n}\n") + 2);
  const branches = {};
  for (const m of body.matchAll(/if \(type === "([a-z]+)"\) \{\s*return \[([\s\S]*?)\];/g)) {
    branches[m[1]] = [...m[2].matchAll(/branch: "([a-z]+)"/g)].map((b) => b[1]);
  }
  branches.end = [];
  assert.ok(Object.keys(branches).length >= 4, "outPorts delivers no branches any more — does the regex still match?");
  return { fixed: list(fixed[1]), entries: list(entries[1]), compact: compactValue, compactW: Number(cw[1]), compactH: Number(ch[1]), branches };
}

// ── The Swift side: stand-ins + the real file + a main program ─────────────────────────
let tmpSwift = null;
function measurementSwift() {
  tmpSwift = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-geobind-"));
  const geometry = fs.readFileSync(SOURCE_SWIFT, "utf8");
  // Stand-ins: exactly the foreign types the geometry touches. Deliberately MINIMAL — anything extra here
  // could hide a difference.
  const mocks = `import Foundation

enum WorkflowNodeType: String { case trigger, start, instruction, condition, loop, parallel, ask, review, end }
enum WorkflowBranch: String { case yes = "true", no = "false", each, done, ok, issues }
struct WorkflowNode { var id: String; var type: WorkflowNodeType; var x: Double; var y: Double }
struct WorkflowEdge { var from: String; var to: String; var branch: WorkflowBranch?; var fromSide: String?; var toSide: String? }
struct WorkflowGraph { var nodes: [WorkflowNode] = []; var edges: [WorkflowEdge] = [] }
`;
  const casesSwift = cases.map((f) => `    ("${f.name}", CGRect(x: ${f.s.x}, y: ${f.s.y}, width: ${f.s.w}, height: ${f.s.h}), CGRect(x: ${f.d.x}, y: ${f.d.y}, width: ${f.d.w}, height: ${f.d.h}), WorkflowGeometry.Port(side: .${f.from.side}, slot: ${f.from.slot}), WorkflowGeometry.Port(side: .${f.to.side}, slot: ${f.to.slot}), CGFloat(${f.inset})),`).join("\n");
  const edgesSwift = EDGE_SETS.map(([n, es]) => `    ("${n}", [${es.map(([a, b]) => `(from: "${a}", to: "${b}")`).join(", ")}]),`).join("\n");
  const nodeSwift = GRAPH.nodes.map((n) => `        WorkflowNode(id: "${n.id}", type: .${n.type}, x: ${n.x}, y: ${n.y}),`).join("\n");
  const edgesGraph = GRAPH.edges.map((e) => `        WorkflowEdge(from: "${e.from}", to: "${e.to}", branch: ${e.branch ? `WorkflowBranch(rawValue: "${e.branch}")` : "nil"}, fromSide: "${e.fromSide}", toSide: "${e.toSide}"),`).join("\n");
  const main = `
// Output form like the JS side: rounded to six decimal places, whole numbers without a dot.
// \`String(CGFloat)\` does not exist on this toolchain (CGFloat is not LosslessStringConvertible) —
// hence the detour via Double.
func z(_ v: CGFloat) -> String {
    let g = (Double(v) * 1e6).rounded() / 1e6
    return g == g.rounded() && abs(g) < 1e15 ? String(Int(g)) : String(g)
}
func pkte(_ ps: [CGPoint]) -> String { ps.map { "\\(z($0.x)),\\(z($0.y))" }.joined(separator: " ") }

print("K\\tnodeW\\t" + z(WorkflowGeometry.nodeSize.width))
print("K\\tnodeH\\t" + z(WorkflowGeometry.nodeSize.height))
print("K\\tcompactW\\t" + z(WorkflowGeometry.compactSize.width))
print("K\\tcompactH\\t" + z(WorkflowGeometry.compactSize.height))
print("K\\tportStub\\t" + z(WorkflowGeometry.portStub))
print("K\\trouteGap\\t" + z(WorkflowGeometry.routeGap))
print("K\\tstairMin\\t" + z(WorkflowGeometry.stairMin))

for kind in [${KINDS.map((a) => `WorkflowNodeType.${a}`).join(", ")}] {
    let gr = WorkflowGeometry.size(of: kind)
    let branches = WorkflowGeometry.outPorts(kind).map { WorkflowGeometry.branchKey($0) }.joined(separator: ",")
    print("T\\t\\(kind.rawValue)\\t\\(WorkflowGeometry.isCompact(kind))\\t\\(WorkflowGeometry.isEntry(kind))\\t\\(WorkflowGeometry.isFixed(kind))\\t\\(z(gr.width))x\\(z(gr.height))\\t\\(branches)")
}

for n in 0...8 { print("S\\t\\(n)\\t" + WorkflowGeometry.outSlots(n).map { z($0) }.joined(separator: ",")) }

let anchorRect = CGRect(x: 10, y: 20, width: 232, height: 84)
for page in [WorkflowGeometry.Side.left, .right] {
    for slot in [CGFloat(0), 0.15, 0.5, 0.85, 1] {
        let a = WorkflowGeometry.anchorAt(anchorRect, page, slot: slot)
        print("A\\t\\(page.rawValue)\\t\\(z(slot))\\t\\(z(a.p.x))\\t\\(z(a.p.y))\\t\\(z(a.nx))")
    }
}

let cases: [(String, CGRect, CGRect, WorkflowGeometry.Port, WorkflowGeometry.Port, CGFloat)] = [
${casesSwift}
]
for f in cases { print("R\\t\\(f.0)\\t" + pkte(WorkflowGeometry.route(from: f.1, f.3, to: f.2, f.4, inset: f.5))) }

let edgeSets: [(String, [(from: String, to: String)])] = [
${edgesSwift}
]
for k in edgeSets { print("C\\t\\(k.0)\\t" + WorkflowGeometry.cycleEdges(k.1).sorted().map(String.init).joined(separator: ",")) }

let graph = WorkflowGraph(nodes: [
${nodeSwift}
    ], edges: [
${edgesGraph}
    ])
let wiring = WorkflowWiring(graph: graph, rect: { WorkflowGeometry.rect(of: $0) })
for i in wiring.edges.keys.sorted() {
    let e = wiring.edges[i]!
    print("W\\t\\(i)\\t\\(e.from.side.rawValue)\\t\\(z(e.from.slot))\\t\\(e.to.side.rawValue)\\t\\(z(e.to.slot))")
}
for id in wiring.ports.keys.sorted() {
    for key in wiring.ports[id]!.keys.sorted() {
        let p = wiring.ports[id]![key]!
        print("P\\t\\(id)\\t\\(key)\\t\\(p.side.rawValue)\\t\\(z(p.slot))\\t\\(p.occupied)")
    }
}
for id in wiring.docks.keys.sorted() {
    let d = wiring.docks[id]!
    print("D\\t\\(id)\\t\\(d.left)\\t\\(d.right)")
}
`;
  const file = path.join(tmpSwift, "measurement.swift");
  fs.writeFileSync(file, mocks + geometry + main);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift geometry could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  const out = { K: new Map(), T: new Map(), S: new Map(), A: new Map(), R: new Map(), C: new Map(), W: new Map(), P: new Map(), D: new Map() };
  for (const row of output.split("\n").filter(Boolean)) {
    const t = row.split("\t");
    if (t[0] === "T") out.T.set(t[1], t.slice(2).join("\t"));
    else if (t[0] === "A") out.A.set(`${t[1]}|${t[2]}`, t.slice(3).join("\t"));
    else if (t[0] === "P") out.P.set(`${t[1]}|${t[2]}`, t.slice(3).join("\t"));
    else if (t[0] === "W" || t[0] === "D") out[t[0]].set(t[1], t.slice(2).join("\t"));
    else out[t[0]].set(t[1], t.slice(2).join("\t"));
  }
  return out;
}

after(() => {
  for (const d of [tmpTs, tmpSwift]) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } }
});

let measured = null;
const measure = async () => (measured ??= { swift: measurementSwift(), ts: await geometryTs(), editor: editorTable() });

test("geometry: the same constants in both languages", async () => {
  const { swift, ts, editor } = await measure();
  assert.equal(swift.K.get("nodeW"), String(ts.NODE_W), "node width");
  assert.equal(swift.K.get("nodeH"), String(ts.NODE_H), "node height");
  assert.equal(swift.K.get("portStub"), String(ts.PORT_STUB), "length of the stub");
  assert.equal(swift.K.get("routeGap"), String(ts.ROUTE_GAP), "gap of the detour");
  assert.equal(swift.K.get("stairMin"), String(ts.STAIR_MIN), "threshold for the stairs");
  // The compact size lives in the EDITOR on the web, in the geometry on mobile.
  assert.equal(swift.K.get("compactW"), String(editor.compactW), "compact width (web: WorkflowEditor.tsx)");
  assert.equal(swift.K.get("compactH"), String(editor.compactH), "compact height (web: WorkflowEditor.tsx)");
  console.log(`  [geometry] constants: ${[...swift.K].map(([k, v]) => `${k}=${v}`).join(" ")}`);
});

test("geometry: the same types table — compact, entry, fixed, size, branches", async () => {
  const { swift, ts, editor } = await measure();
  assert.equal(swift.T.size, KINDS.length, `the Swift side answered ${swift.T.size} of ${KINDS.length} kinds`);
  for (const kind of KINDS) {
    const compact = editor.compact.includes(kind);
    const entryPoint = editor.entries.includes(kind);
    const fixed = editor.fixed.includes(kind);
    const size = compact ? `${editor.compactW}x${editor.compactH}` : `${ts.NODE_W}x${ts.NODE_H}`;
    const branches = (editor.branches[kind] ?? [""]).join(",");
    assert.equal(swift.T.get(kind), `${compact}\t${entryPoint}\t${fixed}\t${size}\t${branches}`,
      `kind "${kind}": the table of the editor and that of the Swift geometry differ`);
  }
  console.log(`  [geometry] ${KINDS.length} kinds: compact=${editor.compact.join("/")} · fixed=${editor.fixed.join("/")} · entry=${editor.entries.join("/")}`);
});

test("geometry: the same heights of the outputs (spread/outSlots), also at the edge from six", async () => {
  const { swift, ts } = await measure();
  for (let n = 0; n <= 8; n++) {
    assert.equal(swift.S.get(String(n)), ts.outSlots(n).map(z).join(","), `outSlots(${n})`);
  }
});

test("geometry: the same anchor point with its normal", async () => {
  const { swift, ts } = await measure();
  const r = { x: 10, y: 20, w: 232, h: 84 };
  for (const page of ["left", "right"]) for (const slot of [0, 0.15, 0.5, 0.85, 1]) {
    const a = ts.anchorAt(r, page, slot);
    assert.equal(swift.A.get(`${page}|${z(slot)}`), `${z(a.x)}\t${z(a.y)}\t${z(a.nx)}`, `anchorAt(${page}, ${slot})`);
  }
});

test("geometry: the same edge path in all measured layouts", async () => {
  const { swift, ts } = await measure();
  assert.equal(swift.R.size, cases.length, `the Swift side delivered ${swift.R.size} of ${cases.length} paths`);
  const deviations = [];
  for (const f of cases) {
    const web = points(ts.route(f.s, f.from, f.d, f.to, f.inset));
    if (swift.R.get(f.name) !== web) deviations.push(`${f.name}\n    Web:   ${web}\n    Swift: ${swift.R.get(f.name)}`);
  }
  console.log(`  [geometry] ${cases.length} paths over ${PAIRS.length} positions checked`);
  assert.deepEqual(deviations, [], `edge paths diverge:\n  ${deviations.join("\n  ")}`);
});

test("geometry: the same circle edges", async () => {
  const { swift, ts } = await measure();
  for (const [name, es] of EDGE_SETS) {
    const web = [...ts.cycleEdges(es.map(([from, to]) => ({ from, to })))].sort((a, b) => a - b).join(",");
    assert.equal(swift.C.get(name), web, `cycleEdges(${name})`);
  }
});

test("geometry: the same wiring of a whole graph — ends, fixed outputs, occupied docks", async () => {
  const { swift, ts, editor } = await measure();
  const rectOf = (n) => (editor.compact.includes(n.type)
    ? { x: n.x, y: n.y, w: editor.compactW, h: editor.compactH }
    : { x: n.x, y: n.y, w: ts.NODE_W, h: ts.NODE_H });
  const wireNodes = GRAPH.nodes.map((n) => ({
    id: n.id,
    rect: rectOf(n),
    branches: (editor.branches[n.type] ?? [null]).length ? (editor.branches[n.type] ?? [null]) : [],
    fixed: editor.fixed.includes(n.type),
  }));
  const w = ts.wire(wireNodes, GRAPH.edges);
  assert.ok(swift.W.size, "the Swift side wired no edge");
  assert.equal(swift.W.size, w.edges.size, "number of wired edges (the edge into nothing counts for neither)");
  for (const [i, e] of w.edges) {
    assert.equal(swift.W.get(String(i)), `${e.from.side}\t${z(e.from.slot)}\t${e.to.side}\t${z(e.to.slot)}`, `Kante ${i}`);
  }
  for (const [id, m] of w.ports) for (const [key, p] of m) {
    assert.equal(swift.P.get(`${id}|${key}`), `${p.side}\t${z(p.slot)}\t${p.occupied}`, `fester Ausgang ${id}/${key || "(empty)"}`);
  }
  assert.equal(swift.P.size, [...w.ports.values()].reduce((n, m) => n + m.size, 0), "number of fixed outputs");
  for (const [id, d] of w.docks) {
    assert.equal(swift.D.get(id), `${d.left}\t${d.right}`, `docks of ${id}`);
  }
  console.log(`  [geometry] graph: ${swift.W.size} edges, ${swift.P.size} fixed outputs, ${swift.D.size} nodes`);
});
