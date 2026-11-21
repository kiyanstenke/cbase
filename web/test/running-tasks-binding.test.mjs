// Running tasks, bound: web and iOS compute the same (the "N running tasks" pill in the working row of both clients).
//
// Two versions of the same computation: `web/src/lib/running-tasks.ts` (coding chat on the web) and
// `mobile/CbaseMobile/Chat/RunningTasks.swift` (the same conversation on the iPhone). If one drifts -- the foreground agent
// counts, an unloaded tree counts as complete, the row arranges its parts differently -- iPhone and desktop show different
// numbers for the same chat, and "at least" would stand on one side only.
//
// The web side is compiled with `tsc`, iOS is REALLY compiled from the REAL source (the whole file -- it imports only
// Foundation, the test checks that) plus a driver with `xcrun swiftc`. Both sides get the same cases as JSON and write per
// case the list, the pill text and the stop question as JSON; also the parts of the row for every combination and the word
// per kind. If the toolchain is missing, the test fails LOUDLY (hence registered in `tools/check/latch.json` under `onlyMacOS`).
//
// COUNTER-TESTS (shown red, reverted): in RunningTasks.swift `where a.live && !a.foreground` -> `where a.live` => "list" red
// (the foreground agent counts on iOS); in running-tasks.ts `if (z.running && z.time)` -> `if (z.time)` => "row" red.
//
// The seventh kind `graph` (a graph workflow in the BACKGROUND in running, waiting, waiting_lock, waiting_storage) and
// `graphLoaded` (unloaded => "at least"). COUNTER-TESTS: in RunningTasks.swift `where g.background && ...` -> `where
// !g.startId.isEmpty && ...` => "list" red (the foreground run counts on iOS); `e.workflowsLoaded && e.graphLoaded` ->
// `e.workflowsLoaded` => "list" red.
//
// Run:  node --test web/test/running-tasks-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "running-tasks.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "RunningTasks.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-running-tasks-binding-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────
const agent = (o = {}) => ({ key: "tu-1", agentId: "a-1", name: "Update tests", live: true, foreground: false, startedAt: 1790000000000, parkedUntil: null, ...o });
const empty = { agents: [], workflows: [], workflowsLoaded: true, commands: [], monitors: [], wakeup: { at: 0, reason: "", prompt: "" } };
const CASES = [
  empty,
  { ...empty, workflowsLoaded: false },
  // foreground, finished, background, parked, without agentId (key falls back to the anchor or the index)
  { ...empty, agents: [
    agent({ key: "tu-v", agentId: "a-v", foreground: true }),
    agent({ key: "tu-f", agentId: "a-f", live: false }),
    agent(),
    agent({ key: "tu-p", agentId: "a-p", parkedUntil: 1790000600000.5 }),
    agent({ key: "tu-o", agentId: "", name: "" }),
    agent({ key: "", agentId: "", startedAt: 0 }),
    agent({ key: "tu-n", agentId: "a-n", startedAt: -5, parkedUntil: 0 }),
  ] },
  // the same agent twice => once
  { ...empty, agents: [agent(), agent({ key: "tu-1b", name: "different" })] },
  // workflows in all states, without id, duplicate; once loaded, once not
  ...[true, false].map((loaded) => ({ ...empty, workflowsLoaded: loaded, workflows: [
    { runId: "r-1", name: "Job → Ship", status: "running", startedAt: 1790000001000 },
    { runId: "r-2", name: "old", status: "finished", startedAt: 1 },
    { runId: "r-3", name: "interrupted", status: "interrupted", startedAt: 1 },
    { runId: "", name: "no id", status: "running", startedAt: 1 },
    { runId: "r-1", name: "duplicate", status: "running", startedAt: 1 },
    { runId: "r-4", name: "no start", status: "running", startedAt: null },
  ] })),
  // commands and monitors with and without taskId (iOS has none -- key via the index)
  { ...empty, commands: [{ taskId: "bg_dev", description: "Dev-Server" }, { taskId: "", description: "npm test" }, { taskId: "", description: "" }],
    monitors: [{ taskId: "", description: "Log" }, { taskId: "m1", description: "CI" }] },
  // monitors belong to the chat and carry their start time (since, stop with taskId) -- with, without, 0, negative
  { ...empty, monitors: [{ taskId: "m2", description: "Suite", startedAt: 1790000007000.5 }, { taskId: "m3", description: "", startedAt: 0 },
    { taskId: "m4", description: "neg", startedAt: -3 }, { taskId: "", description: "no id", startedAt: 1790000008000 }] },
  // wakeup alone, with text; wake time 0 and negative
  { ...empty, wakeup: { at: 1790001200000, reason: "The pipeline still needs time", prompt: "Check the pipeline and report" } },
  { ...empty, wakeup: { at: -1, reason: "g", prompt: "p" } },
  // graph workflows: background only, running/waiting only, without id, duplicate, without name (short name), without start
  ...[undefined, true, false].map((graphLoaded) => ({ ...empty, ...(graphLoaded === undefined ? {} : { graphLoaded }), graphRuns: [
    { startId: "g-1", name: "Job → Ship", shortName: "job-ship", state: "running", background: true, startedAt: 1790000003000 },
    { startId: "g-2", name: "", shortName: "review", state: "waiting", background: true, startedAt: 1790000004000.5 },
    { startId: "g-3", name: "Lock", shortName: "lock", state: "waiting_lock", background: true, startedAt: 1 },
    { startId: "g-4", name: "Storage", shortName: "storage", state: "waiting_storage", background: true, startedAt: null },
    { startId: "g-v", name: "front", shortName: "front", state: "running", background: false, startedAt: 1 },
    ...["earmarked", "finished", "failed", "stopped", "dismissed", "unknown"].map((state, i) =>
      ({ startId: `g-z${i}`, name: state, shortName: state, state, background: true, startedAt: 1 })),
    { startId: "", name: "no id", shortName: "", state: "running", background: true, startedAt: 1 },
    { startId: "g-1", name: "duplicate", shortName: "", state: "running", background: true, startedAt: 1 },
  ] })),
  // everything together, incomplete
  { agents: [agent(), agent({ key: "tu-v", agentId: "a-v", foreground: true })],
    workflows: [{ runId: "r-9", name: "Slice", status: "running", startedAt: 1790000002000 }], workflowsLoaded: false,
    commands: [{ taskId: "", description: "Dev-Server" }], monitors: [{ taskId: "", description: "Watch" }],
    wakeup: { at: 1790001200000, reason: "", prompt: "" },
    graphRuns: [{ startId: "g-9", name: "Graph", shortName: "graph", state: "waiting", background: true, startedAt: 1790000002500 }] },
];
const ROWS = [];
for (const running of [false, true]) for (const time of [false, true]) for (const tasks of [0, 1, 3]) ROWS.push({ running, time, tasks });

function writeCases() {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify({ cases: CASES, rows: ROWS }));
  return file;
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
function runWeb(cases) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import { runningTasks, pillsText, rowsParts, hasStop, TASK_KIND_WORD } from "./running-tasks.js";
const { cases, rows } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify({
  cases: cases.map((e) => { const res = runningTasks(e); const p = pillsText(res); return { res, pill: p ? [p.key, p.n] : null, stop: res.item.map(hasStop) }; }),
  rows: rows.map((z) => rowsParts(z)),
  words: TASK_KIND_WORD,
}));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, cases], { encoding: "utf8", env }).trim().split("\n").pop());
}

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
function runIos(cases) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  assert.deepEqual(source.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "RunningTasks.swift imports only Foundation -- otherwise it cannot be bound");
  assert.ok(!/\bL\(/.test(source.replace(/\/\/.*$/gm, "")), "RunningTasks.swift does not translate itself (no L(...)) -- the words are keys");
  const file = path.join(tmpDir(), "tasks.swift");
  fs.writeFileSync(file, `${source}

// ── Driver (web/test/running-tasks-binding.test.mjs) ──
func count(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
func text(_ v: Any?) -> String { v as? String ?? "" }
func truthy(_ v: Any?) -> Bool { (v as? NSNumber)?.boolValue ?? false }
func list(_ v: Any?) -> [[String: Any]] { v as? [[String: Any]] ?? [] }
func emptyOr(_ v: Double?) -> Any { v.map { $0 as Any } ?? NSNull() }
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
var casesFrom: [Any] = []
for f in list(root["cases"]) {
    let w = f["wakeup"] as? [String: Any] ?? [:]
    let e = RunningTasks.Input(
        agents: list(f["agents"]).map { a in
            RunningTasks.AgentInput(key: text(a["key"]), agentId: text(a["agentId"]), name: text(a["name"]),
                                       live: truthy(a["live"]), foreground: truthy(a["foreground"]),
                                       startedAt: count(a["startedAt"]), parkedUntil: count(a["parkedUntil"]))
        },
        workflows: list(f["workflows"]).map { x in
            RunningTasks.WorkflowInput(runId: text(x["runId"]), name: text(x["name"]), status: text(x["status"]), startedAt: count(x["startedAt"]))
        },
        workflowsLoaded: truthy(f["workflowsLoaded"]),
        commands: list(f["commands"]).map { RunningTasks.ItemInput(taskId: text($0["taskId"]), description: text($0["description"])) },
        monitors: list(f["monitors"]).map { RunningTasks.ItemInput(taskId: text($0["taskId"]), description: text($0["description"]), startedAt: count($0["startedAt"])) },
        wakeup: RunningTasks.Wakeup(at: count(w["at"]) ?? 0, reason: text(w["reason"]), prompt: text(w["prompt"])),
        graphRuns: list(f["graphRuns"]).map { g in
            RunningTasks.GraphInput(startId: text(g["startId"]), name: text(g["name"]), shortName: text(g["shortName"]),
                                       state: text(g["state"]), background: truthy(g["background"]), startedAt: count(g["startedAt"]))
        },
        graphLoaded: f["graphLoaded"] == nil ? true : truthy(f["graphLoaded"])
    )
    let res = RunningTasks.compute(e)
    let item: [Any] = res.item.map { p in
        ["kind": p.kind.rawValue, "key": p.key, "name": p.name, "since": emptyOr(p.since), "until": emptyOr(p.until),
         "reference": p.reference, "anchor": p.anchor, "reason": p.reason, "prompt": p.prompt] as [String: Any]
    }
    let pill: Any = RunningTasks.pillsText(res).map { [$0.key, $0.n] as [Any] } ?? NSNull()
    casesFrom.append(["res": ["item": item, "complete": res.complete] as [String: Any], "pill": pill,
                      "stop": res.item.map(RunningTasks.hasStop)] as [String: Any])
}
let rowsFrom: [Any] = list(root["rows"]).map { z in
    RunningTasks.rowsParts(running: truthy(z["running"]), time: truthy(z["time"]), tasks: Int(count(z["tasks"]) ?? 0)).map(\\.rawValue)
}
var words: [String: String] = [:]
for kind in RunningTasks.Kind.allCases { words[kind.rawValue] = RunningTasks.kindWord[kind] ?? "" }
let outData: [String: Any] = ["cases": casesFrom, "rows": rowsFrom, "words": words]
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "tasks");
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be compiled (xcrun swiftc): ${e.stderr || e.message}`);
  }
  return JSON.parse(execFileSync(bin, [cases], { encoding: "utf8" }).trim().split("\n").pop());
}

let result = null;
const both = () => {
  if (!result) { const f = writeCases(); result = { web: runWeb(f), ios: runIos(f) }; }
  return result;
};

test("list: per case the same items (kind, key, name, since, until, handles, wakeup text), same completeness, same pill, same stops", () => {
  const { web, ios } = both();
  assert.equal(web.cases.length, CASES.length);
  for (let i = 0; i < CASES.length; i++) {
    assert.deepEqual(ios.cases[i], web.cases[i], `case ${i}: iOS differs`);
  }
  // The cases did not run empty: the mixed list carries all kinds, the incomplete one says "at least".
  const mixed = web.cases.at(-1);
  assert.deepEqual(mixed.res.item.map((p) => p.kind), ["agent", "workflow", "graph", "command", "monitor", "wakeup"]);
  assert.deepEqual(mixed.pill, ["at least {n} running tasks", 6]);
  // The graph cases: four background runs count (running, waiting, waiting_lock, waiting_storage), the short name stands in
  // for the empty name, and an unloaded state says "at least" (unspecified: known).
  const graphCases = web.cases.filter((f) => f.res.item.some((p) => p.kind === "graph") && f.res.item.length === 4);
  assert.equal(graphCases.length, 3);
  assert.deepEqual(graphCases[0].res.item.map((p) => [p.key, p.name, p.reference]), [
    ["graph:g-1", "Job → Ship", "g-1"], ["graph:g-2", "review", "g-2"], ["graph:g-3", "Lock", "g-3"], ["graph:g-4", "Storage", "g-4"],
  ]);
  assert.deepEqual(graphCases.map((f) => f.res.complete), [true, true, false]);
  assert.ok(graphCases[0].stop.every(Boolean), "a graph workflow has a stop");
  console.log(`# running tasks: ${CASES.length} cases, ${web.cases.reduce((n, f) => n + f.res.item.length, 0)} items, web == iOS`);
});

test("row: the same parts for every combination of run, run start and tasks", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.rows, web.rows);
  assert.deepEqual(web.rows[ROWS.findIndex((z) => z.running && z.time && z.tasks === 3)], ["hex", "time", "pill", "word"]);
});

test("word per kind: the same keys", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.words, web.words);
});
