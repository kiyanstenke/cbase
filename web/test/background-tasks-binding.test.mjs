// The order of the "Background Tasks" list, bound: web and iOS order alike (the ONE list in the agents tab of the right
// chat bar and in the agents sheet on the iPhone).
//
// Two versions of the same computation: `web/src/lib/background-tasks.ts` (coding chat and manager in the web) and
// `mobile/CbaseMobile/Chat/BackgroundTasks.swift` (the agents sheet of both chats on the iPhone). If one drifts — a
// finished subagent lands at the end instead of in its place, a tie flips, a 0 counts as a time — iPhone and desktop
// show the same chat in different order. Web is compiled with `tsc`; iOS is REALLY compiled from the REAL source (the
// whole file — it imports only Foundation, which the test checks) plus a driver with `xcrun swiftc`. Both sides get the
// same cases as JSON and write out, per case, the arrival sequence, the core indices and the list. Without the
// toolchain the test fails LOUDLY (hence `onlyMacOS` in `tools/check/latch.json`).
//
// Counter-test (which sabotage turns which test red): in BackgroundTasks.swift `eff[i] = s ?? last` → `eff[i] = s ??
// -.infinity` turns "list" red; `guard let v, v.isFinite, v > 0` → `guard let v, v.isFinite` turns "list" red (the 0
// counted). Third source `graph` (graph workflows in the background, `graph:<startId>`, always with a start time, in the
// input behind the dyn runs): `for g in graph.reversed()` → `for g in graph` turns "list" red (a tie flips).
//
// Run:  node --test web/test/background-tasks-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_TS = path.join(webDir, "src", "lib", "background-tasks.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "BackgroundTasks.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-background-tasks-binding-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────
// Times as integers AND with decimals (iOS computes in Double from `Date.timeIntervalSince1970 * 1000`), plus
// everything that is no time (null, 0, negative). NaN and Infinity cannot be written in JSON — the unit test on the web
// side covers them, and the Swift version has the same condition (`isFinite`), which the test below reads.
const ag = (id, start = null) => ({ key: `agent:${id}`, start });
const wf = (id, start = null) => ({ key: `workflow:${id}`, start });
const gr = (id, start) => ({ key: `graph:${id}`, start });
const CASES = [
  { rows: [], agents: [], runs: [] },
  // mixed by start time, no history
  { rows: [], agents: [ag("a-old", 1790000001000), ag("a-new", 1790000004000)], runs: [wf("w-new", 1790000003000), wf("w-old", 1790000002000)] },
  // the probe's case: finished ones by their place, running on top
  { rows: [
      { agents: ["f-old"] }, { agents: [], workflowStart: "w1" }, { agents: ["f-middle"] },
      { agents: [], workflowStart: "w2" }, { agents: ["k"] }, { agents: ["l"] },
    ],
    agents: [ag("l", 1790000300000.5), ag("f-old"), ag("f-middle"), ag("k")],
    runs: [wf("w2", 1790000200000), wf("w1", 1790000100000)] },
  // tie, same time twice, plus duplicate arrival and empty ids
  { rows: [
      { agents: [], workflowStart: "w1" }, { agents: [], workflowStart: "w2" }, { agents: ["a1", "", "a2"] },
      { agents: ["a1"], workflowStart: "w1" }, { agents: [], workflowStart: "" },
    ],
    agents: [ag("a1"), ag("a2")], runs: [wf("w2", 700), wf("w1", 700)] },
  // not a number is not a time
  { rows: [{ agents: [], workflowStart: "w1" }, { agents: ["a0", "anull", "aneg"] }],
    agents: [ag("a0", 0), ag("anull", null), ag("aneg", -5)], runs: [wf("w1", 100)] },
  // unknown in the history: with time, without time; duplicate keys in the input
  { rows: [{ agents: [], workflowStart: "w1" }],
    agents: [ag("fresh", 900), ag("f"), ag("fresh", 5)], runs: [wf("w1", 100), wf("w0", 50), wf("w1", 1)] },
  // no history and no time: reversed list order
  { rows: [], agents: [ag("x1"), ag("x2"), ag("x3")], runs: [wf("y1"), wf("y2")] },
  // Graph workflows: by their time between subagents and runs; tie with a dyn run and among themselves
  // (the later arrival on top — in the input they stand old to new behind the runs); duplicates; next to finished ones
  { rows: [{ agents: ["f-old"] }, { agents: [], workflowStart: "w1" }],
    agents: [ag("f-old"), ag("l", 1790000500000)],
    runs: [wf("w1", 1790000100000)],
    graph: [gr("g-new", 1790000400000.5), gr("g-equal", 1790000100000), gr("g-old", 1790000050000), gr("g-new", 1)] },
  { rows: [], agents: [], runs: [wf("w", 300)], graph: [gr("b", 300), gr("a", 300)] },
  { rows: [], agents: [], runs: [], graph: [gr("n", 900), gr("m", 100)] },
];

function writeCases() {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify({ cases: CASES }));
  return file;
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
function runWeb(cases) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import { taskSequence, arrangeTasks, backgroundTasks } from "./background-tasks.js";
const { cases } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(cases.map((f) => {
  const followUp = taskSequence(f.rows);
  return { followUp, core: arrangeTasks([...f.agents, ...f.runs], followUp), list: backgroundTasks(f.agents, f.runs, followUp, f.graph ?? []) };
})));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, cases], { encoding: "utf8", env }).trim().split("\n").pop());
}

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
function runIos(cases) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  assert.deepEqual(source.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "BackgroundTasks.swift imports only Foundation — otherwise it cannot be bound");
  assert.ok(!/\bL\(/.test(source.replace(/\/\/.*$/gm, "")), "BackgroundTasks.swift translates nothing (no L(…))");
  const file = path.join(tmpDir(), "tasks.swift");
  fs.writeFileSync(file, `${source}

// ── Driver (web/test/background-tasks-binding.test.mjs) ──
func count(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
func text(_ v: Any?) -> String { v as? String ?? "" }
func list(_ v: Any?) -> [[String: Any]] { v as? [[String: Any]] ?? [] }
func sources(_ v: Any?) -> [BackgroundTasks.Source] {
    list(v).map { BackgroundTasks.Source(key: text($0["key"]), start: count($0["start"])) }
}
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
var outData: [Any] = []
for f in list(root["cases"]) {
    let rows = list(f["rows"]).map { z in
        BackgroundTasks.SequenceRow(agents: (z["agents"] as? [String]) ?? [], workflowStart: z["workflowStart"] as? String)
    }
    let followUp = BackgroundTasks.followUp(rows)
    let agents = sources(f["agents"]), runs = sources(f["runs"]), graph = sources(f["graph"])
    outData.append(["followUp": followUp, "core": BackgroundTasks.arrange(agents + runs, followUp: followUp),
                "list": BackgroundTasks.list(agents: agents, runs: runs, graph: graph, followUp: followUp)] as [String: Any])
}
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "tasks");
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source did not compile (xcrun swiftc): ${e.stderr || e.message}`);
  }
  return JSON.parse(execFileSync(bin, [cases], { encoding: "utf8" }).trim().split("\n").pop());
}

let result = null;
const both = () => {
  if (!result) { const f = writeCases(); result = { web: runWeb(f), ios: runIos(f) }; }
  return result;
};

test("list: per case the same arrival sequence, the same core indices, the same list", () => {
  const { web, ios } = both();
  assert.equal(web.length, CASES.length);
  for (let i = 0; i < CASES.length; i++) assert.deepEqual(ios[i], web[i], `case ${i}: iOS differs`);
  // The cases did not run empty: the probe's case mixes subagents and runs.
  assert.deepEqual(web[2].list, ["agent:l", "agent:k", "workflow:w2", "agent:f-middle", "workflow:w1", "agent:f-old"]);
  // …and the graph cases: mixed by time, on a tie the graph run (later arrival) above the dyn run.
  // Duplicates: as with runs the LAST entry of the (newest-first delivered) list counts — it is reversed.
  assert.deepEqual(web[7].list, ["agent:l", "graph:g-equal", "workflow:w1", "graph:g-old", "graph:g-new", "agent:f-old"]);
  assert.deepEqual(web[8].list, ["graph:b", "graph:a", "workflow:w"]);
  assert.deepEqual(web[9].list, ["graph:n", "graph:m"]);
  console.log(`# Background Tasks: ${CASES.length} cases, ${web.reduce((n, f) => n + f.list.length, 0)} entries, web == iOS`);
});

test("The same condition for \"is a time\" — finite and greater than zero, on both sides", () => {
  const swift = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const ts = fs.readFileSync(SOURCE_TS, "utf8");
  assert.match(swift, /guard let v, v\.isFinite, v > 0 else \{ return nil \}/);
  assert.match(ts, /Number\.isFinite\(v\) && v > 0 \? v : null/);
});
