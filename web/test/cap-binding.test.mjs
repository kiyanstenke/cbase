// The effective round cap in the step sheet: ONE computation, two clients.
//
// The web labels the cap field from `effectiveCaps` (src/lib/workflow-node-form.ts), the iOS sheet from
// `capPlaceholder(_:)` (mobile/…/Workflows/WorkflowCanvasEditor.swift) — both as a "mirror" of `effectiveCap` in
// workflows.js. Nothing bound them, and the first iOS revision deviated twice without anything turning red: with EQUALLY high caps
// it named the giver from the node order instead of the breadth-first search ("from C" instead of "from B"), and it counted the node
// ITSELF as giver ("7 · from <own title>" as soon as one steps to 0 in the sheet). Both are results of a computation that looks
// right — only a comparison with the same computation in the other language sees it.
//
// The contract measured here: for every node n
//     iOS.capPlaceholder(n)  ==  Web.effectiveCaps(graph with n.maxVisits := 0).get(n)
// — the iOS sheet labels the stepper at value 0, i.e. the case "without an own value", and the web never derives exactly that from the
// group with an own value that jumps back early.
//
// Model: `web/test/geometry-binding.test.mjs` — cut out the Swift body, assemble it with stand-ins into one program and REALLY run it
// with `xcrun swift`. Without the toolchain the test fails LOUDLY (hence under `onlyMacOS` in `latch.json`).
//
// `capPlaceholder` does not compute itself but calls `WorkflowRules.capEffective` (mobile/…/Workflows/WorkflowRules.swift) with an own
// value of 0 — the group computation exists ONCE on the iPhone. The program here therefore gets the WHOLE rules file (a pure leaf) plus
// the two helper properties `ruleNode`/`ruleEdges` from the editor; `wfe-ios-binding.test.mjs` binds the `auto` side of the same computation.
//
// Run:  node --test web/test/cap-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "workflow-node-form.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Workflows", "WorkflowCanvasEditor.swift");
const SOURCE_RULES = path.join(repo, "mobile", "CbaseMobile", "Workflows", "WorkflowRules.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const STANDARD = 5;

// ── The cases. Both sides compute EXACTLY these; EVERY node of every graph is asked. ──────
// Nodes: [id, title, maxVisits]; edges: "a>b". The node order is part of the case — it is the order the first iOS revision took the giver from.
const CASES = [
  ["chain", [["s", "Start##noun", 0], ["a", "A", 0], ["b", "B", 0]], ["s>a", "a>b"]],
  ["chain-with-value", [["s", "Start##noun", 0], ["a", "A", 7], ["b", "B", 3]], ["s>a", "a>b"]],
  ["cycle-without-value", [["a", "A", 0], ["b", "B", 0]], ["a>b", "b>a"]],
  ["cycle-inherits", [["a", "A", 0], ["b", "Review", 20]], ["a>b", "b>a"]],
  // The reviewers' case: b = c, nodes in the order [a, c, b] — the breadth-first search from a
  // sees b BEFORE c, the node list c before b.
  ["tie", [["a", "A", 0], ["c", "C", 5], ["b", "B", 5]], ["a>b", "b>c", "c>a"]],
  ["tie-higher", [["a", "A", 0], ["c", "C", 9], ["b", "B", 9], ["d", "D", 4]], ["a>b", "b>c", "c>d", "d>a"]],
  // The own node carries a value: at 0 in the sheet it must not name itself.
  ["itself", [["a", "A", 7], ["b", "B", 0]], ["a>b", "b>a"]],
  ["self-and-neighbor", [["a", "A", 7], ["b", "B", 20]], ["a>b", "b>a"]],
  // Two separate cycles joined by an edge — the giver comes from the OWN cycle.
  ["two-cycles", [["a", "A", 0], ["b", "B", 8], ["c", "C", 0], ["d", "D", 30]], ["a>b", "b>a", "b>c", "c>d", "d>c"]],
  // The largest value wins, not the first.
  ["largest", [["a", "A", 0], ["b", "B", 3], ["c", "C", 12], ["d", "D", 6]], ["a>b", "b>c", "c>d", "d>a"]],
  // Without a title the id is shown.
  ["without-title", [["a", "A", 0], ["b", "", 4]], ["a>b", "b>a"]],
  // A step that only reaches the cycle without belonging to it.
  ["adjacent", [["x", "X", 0], ["a", "A", 0], ["b", "B", 6]], ["x>a", "a>b", "b>a"]],
];

// ── Web: compile the TS file and import it ────────────────────────────────────────────────
let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleaning up says nothing about the product */ } });
function tmpDir() {
  if (!tmp) tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-cap-binding-"));
  return tmp;
}
async function loadWeb() {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  return import(pathToFileURL(path.join(out, "workflow-node-form.js")).href);
}
const graphOf = (nodes, edges) => ({
  nodes: nodes.map(([id, title, maxVisits]) => ({ id, type: "instruction", title, maxVisits })),
  edges: edges.map((s) => { const [from, to] = s.split(">"); return { from, to, branch: null }; }),
});
// The label as the web builds it from `effectiveCaps` ("{n} · from {from}" / "{n} · default").
function webLabel(effectiveCaps, nodes, edges, id) {
  const withoutOwn = graphOf(nodes.map(([nid, t, mv]) => [nid, t, nid === id ? 0 : mv]), edges);
  const d = effectiveCaps(withoutOwn, STANDARD, { doneAll: true, doneCapAuto: false, loopCapAuto: false }).get(id);
  assert.ok(d, `effectiveCaps does not know ${id}`);
  return d.from ? `${d.cap} · from ${d.from}` : `${d.cap} · default`;
}

// ── iOS: cut out the body and run it with stand-ins ────────────────────────────────────────
function iosBody() {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const rows = source.split("\n");
  const start = rows.findIndex((z) => /^    private func capPlaceholder\(_ node: WorkflowNode\) -> String \{$/.test(z));
  assert.ok(start >= 0, "`private func capPlaceholder(_ node: WorkflowNode) -> String {` is missing in WorkflowCanvasEditor.swift — update the anchor, do not delete the test");
  const end = rows.findIndex((z, i) => i > start && z === "    }");
  assert.ok(end > start, "the end of capPlaceholder (a `    }` line) is missing");
  // The two helper properties the body reads — ONE line each in the editor.
  const help = ["    private var ruleNode: [WorkflowRules.Node] ", "    private var ruleEdges: [WorkflowRules.Edge] "].map((header) => {
    const z = rows.find((x) => x.startsWith(header));
    assert.ok(z, `"${header.trim()}" is missing in WorkflowCanvasEditor.swift — update the anchor`);
    return z;
  });
  return [...help, ...rows.slice(start, end + 1)].join("\n");
}
function runIos() {
  const body = iosBody();
  const file = path.join(tmpDir(), "cap.swift");
  const swiftCases = CASES.map(([name, nodes, edges]) => {
    const n = nodes.map(([id, t, mv]) => `WorkflowNode(id: ${JSON.stringify(id)}, title: ${JSON.stringify(t)}, maxVisits: ${mv})`).join(", ");
    const e = edges.map((s) => { const [from, to] = s.split(">"); return `WorkflowEdge(from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)})`; }).join(", ");
    return `    (${JSON.stringify(name)}, WorkflowGraph(nodes: [${n}], edges: [${e}])),`;
  }).join("\n");
  const rules = fs.readFileSync(SOURCE_RULES, "utf8");
  fs.writeFileSync(file, `${rules}
// Stand-ins: only the fields the body reads.
struct WorkflowNode {
    let id: String; let title: String; let maxVisits: Int
    var ruleNode: WorkflowRules.Node { WorkflowRules.Node(id: id, type: "instruction", title: title, maxVisits: maxVisits) }
}
struct WorkflowEdge { let from: String; let to: String }
struct WorkflowGraph { let nodes: [WorkflowNode]; let edges: [WorkflowEdge] }
struct WorkflowLimits { let maxVisits: Int }
struct WorkflowDetail { let limits: WorkflowLimits }
struct WorkflowRunSettings { var rule: WorkflowRules.Rule { WorkflowRules.Rule() } }
// \`L\` like Kit/Localization.swift, only the substitution — the label is checked in English.
func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var s = key
    for (k, v) in params { s = s.replacingOccurrences(of: "{\\(k)}", with: v.description) }
    return s
}
struct Editor {
    let graph: WorkflowGraph
    let detail: WorkflowDetail
    let run = WorkflowRunSettings()
${body}
    func question(_ id: String) -> String { capPlaceholder(graph.nodes.first { $0.id == id }!) }
}
let cases: [(String, WorkflowGraph)] = [
${swiftCases}
]
for (name, graph) in cases {
    let editor = Editor(graph: graph, detail: WorkflowDetail(limits: WorkflowLimits(maxVisits: ${STANDARD})))
    for node in graph.nodes { print("F\\t" + name + "\\t" + node.id + "\\t" + editor.question(node.id)) }
}
`);
  // `xcrun swift` instead of a fixed path (see effort-ios.test.mjs). Without the toolchain
  // the test fails LOUDLY.
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  const result = new Map();
  for (const z of output.split("\n").filter(Boolean)) {
    const t = z.split("\t");
    if (t[0] === "F") result.set(`${t[1]}|${t[2]}`, t[3] ?? "");
  }
  return result;
}

test("The effective cap is ONE label: iOS (value 0) == web (without own value), node by node", async (t) => {
  const { effectiveCaps } = await loadWeb();
  const ios = runIos();
  let pairs = 0;
  const deviations = [];
  for (const [name, nodes, edges] of CASES) {
    for (const [id] of nodes) {
      const web = webLabel(effectiveCaps, nodes, edges, id);
      const mobile = ios.get(`${name}|${id}`);
      assert.ok(mobile !== undefined, `${name}/${id}: the Swift side delivered no answer`);
      pairs++;
      if (mobile !== web) deviations.push(`${name}/${id}: iOS "${mobile}" ≠ web "${web}"`);
    }
  }
  t.diagnostic(`[cap binding] ${pairs} node questions over ${CASES.length} graphs, ${deviations.length} deviation(s)`);
  assert.deepEqual(deviations, [], "the iPhone labels the cap differently from the desktop:\n  " + deviations.join("\n  "));
  // The two cases the first version lost — named so that a regression carries the name.
  assert.equal(ios.get("tie|a"), "5 · from B", "on a tie the breadth-first search counts (like giver[0]/governing[0]), not the node order");
  assert.equal(ios.get("itself|a"), "5 · default", "the node itself is no giver at value 0");
});
