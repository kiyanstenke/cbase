// The history states, bound: web and iOS CALCULATE the same.
//
// `history-without-points.test.mjs` keeps the table (identifier, word, tone) equal as text in both languages. That is not
// enough: the chain that turns block, report, stream and turn into ONE word exists twice — `agentState` in
// web/src/lib/history-state.ts and `HistoryState.agent` in mobile/CbaseMobile/Chat/HistoryState.swift. Two versions that
// LOOK right diverge exactly at the order (error first, then stopped?), and only running both shows it.
//
// Model: effort-ios.test.mjs / cap-binding.test.mjs. The Swift file is taken WHOLE (it imports only Foundation), assembled
// with a driver into one program and REALLY run with `xcrun swift` — against the full cross product of the inputs, row by
// row against the web. If the toolchain is missing, the test fails LOUDLY (hence under `onlyMacOS` in `latch.json`; on Linux
// it does not run at all).
//
// Bound are `agent`, `toolRunning`, `groupRunning` and `runRowVisible` (with `streamingText = false` — iOS leaves the run
// row in place while text streams). NOT bound is the rule of the running response (iOS knows no running response behind a
// user row, the web does); it is checked below against its own spelled-out expectation.
//
// Counter-test: in HistoryState.swift check `stopped` BEFORE `error` => "error AND stopped" deviates, the matrix is red.
//
// Run:  node --test web/test/history-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_TS = path.join(webDir, "src", "lib", "history-state.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "HistoryState.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-history-binding-")));

// ── The matrix: the FULL cross product, not a selection ───────────────────────────────────
// A raw status outside the known ones ("whatever") and the empty one belong in it: there `done` or the turn
// decides, and exactly there lie the cases without a report.
const RAW = ["", "completed", "running", "stopped", "failed", "whatever"];
const B = [true, false];
const AGENT = [];
for (const error of B) for (const rawStatus of RAW) for (const done of B) for (const inStream of [true, false, null]) for (const turnRunning of B) {
  AGENT.push({ error, rawStatus, done, inStream, turnRunning });
}
const TOOL = [];
for (const done of B) for (const error of B) for (const live of B) TOOL.push({ done, error, live });
// Groups of length 0…3 from the four (done, error) pairs, each in both turns — 85 × 2.
const PAIRS = [[false, false], [true, false], [false, true], [true, true]];
const GROUPS = [[]];
for (let n = 1; n <= 3; n++) {
  const prior = GROUPS.filter((g) => g.length === n - 1);
  for (const g of prior) for (const p of PAIRS) GROUPS.push([...g, p]);
}
const ROW = [];
for (const busy of B) for (const waiting of B) ROW.push({ busy, waiting });
// The state words of a workflow agent (dynworkflows/tree.js agentState) — every known one, plus an unknown one and the empty
// one (a newer server): on them neither side may say "finished".
const STATUSES = ["running", "waiting", "finished", "error", "skipped", "stopped", "without-result", "whatever", ""];

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
async function loadWeb() {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  return import(pathToFileURL(path.join(out, "history-state.js")).href);
}
const agentText = (z) => (z ? `${z.identifier}|${z.word}|${z.tone}|${z.pulses}` : "finished");

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
const swiftBool = (b) => (b ? "true" : "false");
const swiftOpt = (b) => (b === null ? "nil" : swiftBool(b));
let iosResult = null;
function runIos() {
  if (iosResult) return iosResult;
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  // The file is a leaf (Foundation only) — it is taken over unchanged. The guard against that:
  const imports = source.split("\n").filter((z) => /^import /.test(z));
  assert.deepEqual(imports, ["import Foundation"], "HistoryState.swift imports only Foundation — otherwise it no longer runs alone here");
  const file = path.join(tmpDir(), "history.swift");
  fs.writeFileSync(file, `${source}

// ── Driver (web/test/history-binding.test.mjs) ──
func text(_ z: HistoryState.Agent?) -> String {
    guard let z else { return "finished" }
    return "\\(z.identifier)|\\(z.word)|\\(z.tone.rawValue)|\\(z.pulses)"
}
let agentCases: [(Bool, String, Bool, Bool?, Bool)] = [
${AGENT.map((f) => `    (${swiftBool(f.error)}, ${JSON.stringify(f.rawStatus)}, ${swiftBool(f.done)}, ${swiftOpt(f.inStream)}, ${swiftBool(f.turnRunning)}),`).join("\n")}
]
for (i, f) in agentCases.enumerated() {
    print("A\\t\\(i)\\t" + text(HistoryState.agent(error: f.0, rawStatus: f.1, done: f.2, inStream: f.3, turnRunning: f.4)))
}
let toolCases: [(Bool, Bool, Bool)] = [
${TOOL.map((f) => `    (${swiftBool(f.done)}, ${swiftBool(f.error)}, ${swiftBool(f.live)}),`).join("\n")}
]
for (i, f) in toolCases.enumerated() {
    print("W\\t\\(i)\\t\\(HistoryState.toolRunning(done: f.0, error: f.1, live: f.2))")
}
let groups: [[(done: Bool, error: Bool)]] = [
${GROUPS.map((g) => `    [${g.map(([d, f]) => `(done: ${swiftBool(d)}, error: ${swiftBool(f)})`).join(", ")}],`).join("\n")}
]
for (i, g) in groups.enumerated() {
    print("G\\t\\(i)\\t\\(HistoryState.groupRunning(g, live: true))\\t\\(HistoryState.groupRunning(g, live: false))")
}
let rows: [(Bool, Bool)] = [
${ROW.map((f) => `    (${swiftBool(f.busy)}, ${swiftBool(f.waiting)}),`).join("\n")}
]
for (i, f) in rows.enumerated() {
    print("Z\\t\\(i)\\t\\(HistoryState.runRowVisible(busy: f.0, waiting: f.1))")
}
let statuses: [String] = [${STATUSES.map((x) => JSON.stringify(x)).join(", ")}]
for (i, st) in statuses.enumerated() {
    print("J\\t\\(i)\\t" + text(HistoryState.journalAgent(status: st)))
}
for k in HistoryState.agentStates.keys.sorted() {
    print("T\\t\\(k)\\t" + text(HistoryState.agentStates[k]))
}
// The iOS-own rule of the running response (not bound) — rows NEWEST FIRST.
let responses: [(String, [(role: String, id: String)], Bool)] = [
    ("empty", [], true),
    ("not-busy", [(role: "assistant", id: "a2")], false),
    ("mostRecent", [(role: "assistant", id: "a2"), (role: "user", id: "u1"), (role: "assistant", id: "a1")], true),
    ("user-beforehand", [(role: "user", id: "u2"), (role: "assistant", id: "a1")], true),
    ("other-roles-in-between", [(role: "limit", id: "l1"), (role: "ask", id: "k1"), (role: "assistant", id: "a3")], true),
    ("only-user", [(role: "user", id: "u1")], true),
]
for (name, rows, busy) in responses {
    print("L\\t" + name + "\\t" + (HistoryState.runningResponseId(newestFirst: rows, busy: busy) ?? "-"))
}
`);
  // `xcrun swift` instead of a fixed path (see effort-ios.test.mjs). If the toolchain is missing,
  // the test fails LOUDLY — a silent skip would count as passed.
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  const r = { A: new Map(), W: new Map(), G: new Map(), Z: new Map(), T: new Map(), L: new Map(), J: new Map() };
  for (const z of output.split("\n").filter(Boolean)) {
    const [kind, k, ...rest] = z.split("\t");
    if (r[kind]) r[kind].set(k, rest.join("\t"));
  }
  iosResult = r;
  return r;
}

const describe = (f) => Object.entries(f).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");

test("agent state: the state of a subagent — iOS calculates the same as the web, case by case", async (t) => {
  const web = await loadWeb();
  const ios = runIos();
  assert.equal(ios.A.size, AGENT.length, `the Swift side answered ${ios.A.size} of ${AGENT.length} cases`);
  const deviations = [];
  AGENT.forEach((f, i) => {
    const w = agentText(web.agentState(f));
    const m = ios.A.get(String(i));
    if (w !== m) deviations.push(`${describe(f)}: web “${w}” ≠ iOS “${m}”`);
  });
  t.diagnostic(`[history binding] agent: ${AGENT.length} cases, ${deviations.length} deviation(s)`);
  assert.deepEqual(deviations, [], "badge and sheet on the iPhone said something different from the desktop:\n  " + deviations.join("\n  "));
  // The places where a version is most likely to tip over — named so that a regression carries their name.
  const question = (f) => ios.A.get(String(AGENT.findIndex((g) => describe(g) === describe(f))));
  assert.equal(question({ error: true, rawStatus: "stopped", done: true, inStream: false, turnRunning: false }).split("|")[0], "error", "error before stopped");
  assert.equal(question({ error: false, rawStatus: "running", done: true, inStream: false, turnRunning: true }).split("|")[0], "without-result", "report running, the stream does not carry it: no “running” from the turn");
  assert.equal(question({ error: false, rawStatus: "running", done: true, inStream: null, turnRunning: true }).split("|")[0], "running", "without a list the running turn counts");
});

test("tool row: tool row, group row and run row — iOS calculates the same as the web", async () => {
  const web = await loadWeb();
  const ios = runIos();
  const diffs = [];
  TOOL.forEach((f, i) => {
    const w = String(web.toolRunning({ done: f.done, resultIsError: f.error }, f.live));
    if (w !== ios.W.get(String(i))) diffs.push(`toolRunning ${describe(f)}: web ${w} ≠ iOS ${ios.W.get(String(i))}`);
  });
  GROUPS.forEach((g, i) => {
    const bs = g.map(([done, resultIsError]) => ({ done, resultIsError }));
    const w = `${web.groupRunning(bs, true)}\t${web.groupRunning(bs, false)}`;
    if (w !== ios.G.get(String(i))) diffs.push(`groupRunning ${JSON.stringify(g)}: web ${w} ≠ iOS ${ios.G.get(String(i))}`);
  });
  ROW.forEach((f, i) => {
    // Only the shared part: iOS deliberately does not know `streamingText`.
    const w = String(web.runDisplayVisible({ busy: f.busy, streamingText: false, waiting: f.waiting }));
    if (w !== ios.Z.get(String(i))) diffs.push(`runRowVisible ${describe(f)}: web ${w} ≠ iOS ${ios.Z.get(String(i))}`);
  });
  assert.equal(ios.W.size + ios.G.size + ios.Z.size, TOOL.length + GROUPS.length + ROW.length, "the Swift side did not answer every case");
  assert.deepEqual(diffs, [], diffs.join("\n  "));
});

test("workflow agent state: from its journal state — iOS calculates state by state the same as the web, and only “finished” carries no word", async () => {
  const web = await loadWeb();
  const ios = runIos();
  assert.equal(ios.J.size, STATUSES.length, `the Swift side answered ${ios.J.size} of ${STATUSES.length} states`);
  const diffs = [];
  STATUSES.forEach((st, i) => {
    const w = agentText(web.journalAgentState(st));
    if (w !== ios.J.get(String(i))) diffs.push(`“${st}”: web “${w}” ≠ iOS “${ios.J.get(String(i))}”`);
  });
  assert.deepEqual(diffs, [], diffs.join("\n  "));
  const identifier = (st) => ios.J.get(String(STATUSES.indexOf(st))).split("|")[0];
  assert.equal(identifier("finished"), "finished");
  assert.equal(identifier("waiting"), "waiting");
  assert.equal(identifier("skipped"), "skipped", "skipped is a display state of its own, not “error”");
  assert.equal(identifier("whatever"), "whatever", "an unknown state is not “finished”");
  assert.notEqual(identifier(""), "finished", "an empty state is not “finished”");
});

test("table: the table as it REALLY runs on the iPhone is AGENT_STATES", async () => {
  const web = await loadWeb();
  const ios = runIos();
  const desired = new Map(Object.entries(web.AGENT_STATES).map(([k, z]) => [k, agentText(z)]));
  assert.deepEqual(new Map([...ios.T].sort()), new Map([...desired].sort()), "the executed table differs");
});

test("iOS rule of the running response (NOT bound): the newest response, none behind a user row", () => {
  const ios = runIos();
  assert.deepEqual(Object.fromEntries(ios.L), {
    "empty": "-",
    "not-busy": "-",
    "mostRecent": "a2",
    "user-beforehand": "-",
    "other-roles-in-between": "a3",
    "only-user": "-",
  });
});
