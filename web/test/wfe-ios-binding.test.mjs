// The workflow-settings rules: ONE computation, three places — here iOS against web (and the lists against the server).
//
// Server (`workflows.js`), web (`web/src/lib/workflow-node-form.ts`) and iOS (`mobile/CbaseMobile/Workflows/WorkflowRules.swift`)
// compute the same rules: whether a node checks effectively (rule 1), whether the check cap continues without asking (rule 2), the
// effective round cap including `auto` (rule 3), which rows the node sheet carries, and how legacy data (`doneCheck`/`capAuto`) is
// read. Server ↔ web is bound by `workflow-settings-binding.test.mjs`; THIS file binds iOS to the web — else the iPhone would hang
// on nothing: no UI test drives the matrix, and a swapped "ask"/"continue" in Swift would look in the sheet exactly like the
// right one.
//
// Built like `archive-binding.test.mjs`/`cap-binding.test.mjs`: the Swift file is read WHOLE (a pure sheet, only Foundation),
// extended by a driver and REALLY run with `xcrun swift` — against the same matrix that runs here through the tsc-compiled
// `workflow-node-form.ts`. The cases go in as a JSON file (a Swift literal with hundreds of cases floors the type checker). If
// the toolchain is missing the test fails LOUDLY; on Linux the file does not run at all (`onlyMacOS` in tools/check/latch.json).
//
// Plus three lists that stand in three places: the categories of the settings sheet (`WFE_CATEGORIES` ↔ `WorkflowSettingCategory`),
// the lock ranges (`LOCK_AREAS` ↔ `WorkflowRules.lockRanges` ↔ the server's `LOCK_SCOPES`) and the kinds with their own turn
// (`WorkflowRules.stepKinds` ↔ the server's `countsAsStep` — the step counter "{n} steps" in the sheet).
//
// Counter-tests (each shown red once): in Swift swap "continue" and "ask" in `groupsAuto` ⇒ red; `checksEffective` without
// `wf.doneAll` ⇒ red; legacy `capAuto` only for the check cap ⇒ red; one category reordered ⇒ red.
//
// Run:  node --test web/test/wfe-ios-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCK_SCOPES, NODE_TYPES, countsAsStep } from "../../server/backend/electron/server/workflows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Workflows", "WorkflowRules.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const STANDARD = 5;

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
function tmpDir() {
  if (!tmp) tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wfe-ios-"));
  return tmp;
}

// ── Web: compile both sheets ────────────────────────────────────────────────────────────────────
let web = null;
async function loadWeb() {
  if (web) return web;
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "lib", "workflow-node-form.ts"), path.join(webDir, "src", "lib", "workflow-settings.ts"),
    "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
  ], { stdio: "pipe" });
  const form = await import(pathToFileURL(path.join(out, "workflow-node-form.js")).href);
  const former = await import(pathToFileURL(path.join(out, "workflow-settings.js")).href);
  web = { ...form, ...former };
  return web;
}

// ── The matrix ──────────────────────────────────────────────────────────────────────────────────
// Graphs: [name, nodes [id, type, title, maxVisits], edges "a>b"]. Chain, cycles with and without explicit caps, a tie (giver
// from the breadth-first search), two cycles, entry points/end, all kinds with "done".
const GRAPHS = [
  ["chain", [["s", "start", "Start##noun", 0], ["a", "instruction", "A", 0], ["p", "parallel", "P", 0], ["e", "end", "End", 0]], ["s>a", "a>p", "p>e"]],
  ["cycle-without-value", [["a", "instruction", "A", 0], ["b", "condition", "B", 0]], ["a>b", "b>a"]],
  ["cycle-inherits", [["s", "start", "Start##noun", 0], ["a", "instruction", "A", 0], ["b", "review", "Review", 20]], ["s>a", "a>b", "b>a"]],
  ["tie", [["a", "instruction", "A", 0], ["c", "parallel", "C", 5], ["b", "loop", "B", 5]], ["a>b", "b>c", "c>a"]],
  ["own-value", [["a", "instruction", "A", 7], ["b", "ask", "B", 0], ["c", "instruction", "", 9]], ["a>b", "b>c", "c>a"]],
  ["two-cycles", [["a", "instruction", "A", 0], ["b", "condition", "B", 8], ["c", "parallel", "C", 0], ["d", "instruction", "D", 30]], ["a>b", "b>a", "b>c", "c>d", "d>c"]],
  ["entry-points", [["t", "trigger", "Trigger", 0], ["s", "start", "Start##noun", 0], ["a", "instruction", "A", 0], ["e", "end", "End", 0]], ["t>a", "s>a", "a>e"]],
  ["adjacent", [["x", "instruction", "X", 0], ["a", "parallel", "A", 0], ["b", "instruction", "B", 6]], ["x>a", "a>b", "b>a"]],
];
const DONE = ["inherit", "on", "off"];
const CAP = ["inherit", "ask", "continue"];
// Deterministic mode assignment: several occupancies per graph, every combination of a node occurs spread over the occupancies
// (no randomness — a red run must be just as red the second time).
function occupancies(node) {
  const out = [];
  for (let b = 0; b < 9; b++) {
    out.push(node.map((_, i) => {
      const k = b * 7 + i * 5;
      return { doneMode: DONE[k % 3], doneCapMode: CAP[Math.floor(k / 3) % 3], loopCapMode: CAP[Math.floor(k / 9) % 3] };
    }));
  }
  // All "like workflow" — the most common case in existing data.
  out.push(node.map(() => ({ doneMode: "inherit", doneCapMode: "inherit", loopCapMode: "inherit" })));
  return out;
}
const WFS = [];
for (const doneAll of [true, false]) for (const doneCapAuto of [false, true]) for (const loopCapAuto of [false, true]) WFS.push({ doneAll, doneCapAuto, loopCapAuto });

function cases(webMod) {
  const out = [];
  for (const [gname, node, edgeList] of GRAPHS) {
    occupancies(node).forEach((modes, bi) => {
      WFS.forEach((wf, wi) => {
        const nodes = node.map(([id, type, title, maxVisits], i) => ({ id, type, title, maxVisits, ...modes[i] }));
        const edges = edgeList.map((s) => { const [from, to] = s.split(">"); return { from, to, branch: null }; });
        const cycle = [...webMod.nodesOnCycle({ nodes, edges })];
        out.push({ name: `${gname}#${bi}#${wi}`, nodes, edges, wf, cycle });
      });
    });
  }
  return out;
}

// Legacy data: every combination of valid/invalid/missing new value and old checkmark (true/false/missing/not a boolean).
const OLD = [];
{
  const newDone = [undefined, "inherit", "on", "off", "enabled", ""];
  const newCap = [undefined, "inherit", "ask", "continue", "further"];
  const old = [undefined, true, false, "yes"];
  let i = 0;
  for (const doneMode of newDone) for (const doneCheck of old) OLD.push({ name: `d${i++}`, doneMode, doneCheck });
  for (const doneCapMode of newCap) for (const loopCapMode of newCap) for (const capAuto of old) OLD.push({ name: `c${i++}`, doneCapMode, loopCapMode, capAuto });
}

const ROWS_KEY = ["trigger", "text", "list", "command", "cap", "loopCap", "doneMode", "doneCap", "scale", "notification"];

function webRows(w, f) {
  const rows = [];
  const caps = w.effectiveCaps({ nodes: f.nodes, edges: f.edges }, STANDARD, f.wf);
  const cycle = new Set(f.cycle);
  for (const n of f.nodes) {
    const d = caps.get(n.id);
    const z = w.rowsFor(cycle, n, f.wf);
    rows.push([f.name, n.id, w.checksEffective(n, f.wf) ? 1 : 0, w.checkCapContinue(n, f.wf) ? 1 : 0,
      d.cap, d.auto ? 1 : 0, d.from, ROWS_KEY.map((k) => (z[k] ? 1 : 0)).join("")].join("\t"));
  }
  return rows;
}

// ── iOS: the file plus a driver, ONE run for all cases ──────────────────────────────────────────
let measured = null;
function iosPage(fs_, input) {
  if (measured) return measured;
  const dir = tmpDir();
  const json = path.join(dir, "cases.json");
  fs_.writeFileSync(json, JSON.stringify(input));
  const file = path.join(dir, "wfe.swift");
  fs_.writeFileSync(file, `${fs_.readFileSync(SOURCE_SWIFT, "utf8")}

// ── Driver (wfe-ios-binding.test.mjs) ──
let raw = try! Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(json)}))
let input = try! JSONSerialization.jsonObject(with: raw) as! [String: Any]
func b(_ x: Bool) -> String { x ? "1" : "0" }
print("K\\t" + WorkflowSettingCategory.allCases.map(\\.rawValue).joined(separator: ","))
print("S\\t" + WorkflowRules.lockRanges.joined(separator: ","))
print("T\\t" + WorkflowRules.stepKinds.sorted().joined(separator: ","))
for f in input["cases"] as! [[String: Any]] {
    let name = f["name"] as! String
    let w = f["wf"] as! [String: Bool]
    let wf = WorkflowRules.Rule(doneAll: w["doneAll"]!, doneCapAuto: w["doneCapAuto"]!, loopCapAuto: w["loopCapAuto"]!)
    let node = (f["nodes"] as! [[String: Any]]).map { n in
        WorkflowRules.Node(
            id: n["id"] as! String, type: n["type"] as! String, title: n["title"] as! String, maxVisits: n["maxVisits"] as! Int,
            doneMode: WorkflowDoneMode(rawValue: n["doneMode"] as! String)!,
            doneCapMode: WorkflowCapMode(rawValue: n["doneCapMode"] as! String)!,
            loopCapMode: WorkflowCapMode(rawValue: n["loopCapMode"] as! String)!
        )
    }
    let edgeList = (f["edges"] as! [[String: Any]]).map { WorkflowRules.Edge(from: $0["from"] as! String, to: $0["to"] as! String) }
    let cycle = Set(f["cycle"] as! [String])
    let caps = WorkflowRules.capEffective(node, edgeList, fallback: ${STANDARD}, wf: wf)
    for k in node {
        let d = caps[k.id]!
        let z = WorkflowRules.rows(cycle, k, wf)
        let bits = [z.trigger, z.text, z.list, z.command, z.cap, z.loopCap, z.doneMode, z.doneCap, z.scale, z.notification].map(b).joined()
        print(["C", name, k.id, b(WorkflowRules.checksEffective(k, wf)), b(WorkflowRules.checkCapContinue(k, wf)), String(d.cap), b(d.auto), d.from, bits].joined(separator: "\\t"))
    }
}
for a in input["old"] as! [[String: Any]] {
    let m = WorkflowRules.nodeModes(
        doneMode: a["doneMode"] as? String, doneCapMode: a["doneCapMode"] as? String, loopCapMode: a["loopCapMode"] as? String,
        doneCheck: a["doneCheck"] as? Bool, capAuto: a["capAuto"] as? Bool
    )
    print(["M", a["name"] as! String, m.doneMode.rawValue, m.doneCapMode.rawValue, m.loopCapMode.rawValue].joined(separator: "\\t"))
}
`);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  const rows = output.split("\n").filter(Boolean);
  measured = {
    categories: (rows.find((z) => z.startsWith("K\t")) ?? "K\t").slice(2).split(","),
    lock: (rows.find((z) => z.startsWith("S\t")) ?? "S\t").slice(2).split(","),
    stepKinds: (rows.find((z) => z.startsWith("T\t")) ?? "T\t").slice(2).split(","),
    cases: rows.filter((z) => z.startsWith("C\t")).map((z) => z.slice(2)),
    old: new Map(rows.filter((z) => z.startsWith("M\t")).map((z) => { const t = z.split("\t"); return [t[1], t.slice(2).join("\t")]; })),
  };
  return measured;
}

let matrix = null;
async function measure() {
  const w = await loadWeb();
  if (!matrix) matrix = cases(w);
  // `undefined` drops out of JSON — exactly that is "missing"; a non-boolean stays a string.
  const ios = iosPage(fs, { cases: matrix, old: OLD });
  return { w, ios };
}

test("rules 1–3 and the sheet's rows: iOS computes node by node the same as the web", async (t) => {
  const { w, ios } = await measure();
  const expected = matrix.flatMap((f) => webRows(w, f));
  assert.ok(expected.length > 1500, `the matrix is too small (${expected.length}) — does the occupancy still apply?`);
  assert.equal(ios.cases.length, expected.length, "the Swift side did not answer every node question");
  const deviations = [];
  for (let i = 0; i < expected.length; i++) {
    if (ios.cases[i] !== expected[i]) deviations.push(`iOS "${ios.cases[i]}" ≠ web "${expected[i]}"`);
  }
  t.diagnostic(`[WFE binding iOS] ${expected.length} node questions over ${matrix.length} cases (${GRAPHS.length} graphs × occupancies × ${WFS.length} workflow rules), ${deviations.length} deviation(s)`);
  assert.deepEqual(deviations.slice(0, 20), [], "the iPhone computes the workflow rules differently from the desktop (columns: case, node, checks, check cap continues, cap, auto, giver, rows):\n  " + deviations.slice(0, 20).join("\n  "));
  // The matrix must enter both sides of every rule — else the equality would be one over nothing but zeros.
  const column = (i) => new Set(expected.map((z) => z.split("\t")[i]));
  for (const [i, what] of [[2, "checks effectively"], [3, "check cap continues"], [5, "round cap auto"]]) {
    assert.deepEqual([...column(i)].sort(), ["0", "1"], `the matrix enters "${what}" on one side only`);
  }
});

test("legacy data: doneCheck/capAuto are read on iOS exactly as on the web (nodeModes)", async () => {
  const { w, ios } = await measure();
  const deviations = [];
  for (const a of OLD) {
    const m = w.nodeModes({ id: "x", type: "instruction", ...a });
    const web = [m.doneMode, m.doneCapMode, m.loopCapMode].join("\t");
    if (ios.old.get(a.name) !== web) deviations.push(`${JSON.stringify(a)}: iOS "${ios.old.get(a.name)}" ≠ web "${web}"`);
  }
  assert.deepEqual(deviations, [], "the legacy reading deviates:\n  " + deviations.join("\n  "));
  // The two rules, named: the old checkmark applied to BOTH caps; an old `false` is "like workflow".
  assert.equal(ios.old.get(OLD.find((a) => a.doneMode === undefined && a.doneCheck === true).name).split("\t")[0], "on");
  assert.equal(ios.old.get(OLD.find((a) => a.doneMode === undefined && a.doneCheck === false).name).split("\t")[0], "inherit");
  const both = OLD.find((a) => a.doneCapMode === undefined && a.loopCapMode === undefined && a.capAuto === true);
  assert.equal(ios.old.get(both.name).split("\t").slice(1).join(","), "continue,continue", "capAuto: true must set BOTH caps to \"continue\"");
});

test("three lists in three places: categories (web ↔ iOS), lock ranges (web ↔ iOS ↔ server), step kinds (iOS ↔ server)", async () => {
  const { w, ios } = await measure();
  assert.deepEqual(ios.categories, w.WFE_CATEGORIES.map((k) => k.key), "the categories of the settings sheet differ on iOS (set or order) from the web");
  assert.deepEqual([...w.LOCK_AREAS], [...LOCK_SCOPES], "web lock ranges ≠ server LOCK_SCOPES");
  assert.deepEqual(ios.lock, [...LOCK_SCOPES], "iOS lock ranges ≠ server LOCK_SCOPES");
  const server = NODE_TYPES.filter((type) => countsAsStep({ type: type })).sort();
  assert.deepEqual(ios.stepKinds, server, "the step counter of the iOS sheet counts other kinds than the server");
});
