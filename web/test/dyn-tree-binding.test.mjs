// The progress tree, bound: web and iOS COMPUTE the same.
//
// The computation exists twice: `web/src/lib/dyn-tree.ts` and `mobile/CbaseMobile/Chat/DynTree.swift`. Both take the same
// view of the server (dynworkflows/tree.js treeView, route and event `dynwf_tree`) and make from it the loading state
// (not loaded is not "no workflow", events during the request lie over the answer), the bands per phase, n/m and per
// agent the display word, the handles per row, the tile kind, the time per agent and run against a fixed clock, the token
// sum, the description, and per run the wait text (`bandWaitText` at the phase head, `waitText` per row). Two versions that
// LOOK right differ at exactly such places — only someone who executes both sees it.
//
// Model: history-binding.test.mjs. The Swift files are taken WHOLE (they import only Foundation), assembled with a driver
// into one program and REALLY executed with `xcrun swift` — step by step the same procedure, row by row against the web.
// Without the toolchain the test fails LOUDLY (hence in `latch.json` under `onlyMacOS`).
//
// The procedure "visible wait reason" is GENERATED from the lists of the web (`WAIT_REASONS`, `CAP_KINDS`;
// `waitReasonProcedure` below): per reason one waiting agent in a phase of its own, for "cap" per kind and one without a
// kind, once in a run WITH the cap numbers and once WITHOUT (an older server) — plus the fixed cases. A new reason the web
// gets therefore cannot make iOS show the fallback "waiting · <reason>" while the binding stays green.
//
// COUNTER-TESTS:
// - `finished` counted as `state != "running"` in DynTree.swift ⇒ the procedures differ at n/m; `if s.loading { … }`
//   removed in `afterEvent` ⇒ the procedure "event during the request" differs; `restart` without the running check ⇒ the
//   procedure "handles per row" differs.
// - `agentDurationMs` without the fallback to the end of the run ⇒ "time, tiles and cards" differs; `bandDefaultOpen`
//   without `waiting` ⇒ likewise.
// - `waitText` without `n >= 1` ⇒ "visible wait reason" differs (zero becomes a number); `bandWaitText` without the
//   condition "nothing runs" ⇒ likewise and five more procedures; `cap` not decoded in Run.init ⇒ "visible wait reason"
//   differs (iOS never shows a number); the reason "project" removed from the list in `waitText` ⇒ likewise; a new reason
//   with its own wording in the web only ⇒ likewise (the fixed cases alone carry no waiting agent with that reason).
//
// Run:  node --test web/test/dyn-tree-binding.test.mjs
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
const ios = (...parts) => path.join(repo, "mobile", "CbaseMobile", ...parts);
const SOURCES_SWIFT = [ios("Chat", "DynTree.swift"), ios("Chat", "HistoryState.swift")];
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dyn-tree-binding-")));

// ── The inputs: views in the shape of the server ────────────────────────────────────────────────────────────
// Optional fields (reason, tokens, tokenKind, fromCache, warning, effort, workflow) are missing on purpose on some agents —
// exactly there a synthesised Decodable would break.
const agent = (n, status, phase, extra = {}) => ({ n, label: `A${n}`, phase, status, provider: "claude", model: "claude-opus-5-5", agentId: status === "waiting" ? "" : `ag-${n}`, ...extra });
const run = (runId, agents, extra = {}) => ({
  runId, taskId: `t-${runId}`, name: `tree-${runId}`, status: "running", stoppedOf: "", error: "", startedAt: 1, endedAt: null,
  phase: "Read", phases: ["Read", "Check"], agents, logs: [{ text: "go", phase: "Read", at: 2 }], logsTruncated: 0, ...extra,
});
const event = (b) => ({ type: "harness", subtype: "dynwf_tree", tree: b });
const ALL_STATUSES = ["running", "waiting", "finished", "error", "skipped", "stopped", "without-result", "whatever"];
/** The fixed clock of the procedures: every time "until now" is computed against it, on both sides. */
const NOW = 10_000_000;

const full = run("wf_full", [
  agent(1, "finished", "Read", { tokens: 18400, tokenKind: "full" }),
  agent(2, "skipped", "Read", { tokens: 2100 }),
  agent(3, "running", "Check", { tokens: 5300, tokenKind: "only_output", effort: "high" }),
  agent(4, "waiting", "Check", { reason: "cap", cap: "run" }),
  agent(5, "error", "Addendum"),
  agent(6, "running", null, { fromCache: true, workflow: "under" }),
  agent(7, "finished", ""),
], { logs: [1, 2, 3, 4, 5].map((i) => ({ text: `log ${i}`, phase: i < 3 ? "Read" : "Check", at: i })), logsTruncated: 7, warning: "large" });

const PROCEDURES = {
  "loaded empty": [["loading"], ["loaded", { runs: [], additional: 0 }]],
  "answer without list is not empty": [["loading"], ["loaded", { error: "x" }], ["loaded", null]],
  "failed stays unloaded": [["loading"], ["failed"]],
  "full run, bands and n/m": [["loading"], ["loaded", { runs: [full, run("wf_two", [], { status: "finished", phase: null, phases: [], logs: [], warning: "" })], additional: 3 }]],
  "every journal state": [["loading"], ["loaded", { runs: [run("wf_st", ALL_STATUSES.map((s, i) => agent(i + 1, s, "Read")))] }]],
  "events replace in place, new ones in front": [
    ["loading"], ["loaded", { runs: [run("wf_a", [agent(1, "running", "Read")]), run("wf_b", [])], additional: 0 }],
    ["afterEvent", event(run("wf_a", [agent(1, "finished", "Read")], { status: "finished" }))],
    ["afterEvent", event(run("wf_c", []))],
    ["afterEvent", { type: "harness", subtype: "workflow_run" }],
    ["afterEvent", { type: "harness", subtype: "dynwf_tree", tree: { name: "without run id", agents: [] } }],
    ["afterEvent", { type: "assistant", subtype: "dynwf_tree", tree: run("wf_d", []) }],
  ],
  "event during the request": [
    ["loading"],
    ["afterEvent", event(run("wf_a", [agent(1, "stopped", "Read")], { status: "stopped", stoppedOf: "human" }))],
    ["loaded", { runs: [run("wf_a", [agent(1, "running", "Read")])], additional: 0 }],
    ["afterEvent", event(run("wf_e", [agent(1, "running", "Read")]))],
    ["loading"], ["failed"],
  ],
  "invalid runs drop out": [["loading"], ["loaded", { runs: [{ runId: "wf_without_agents" }, { agents: [] }, 7, run("wf_ok", [agent(1, "running", "Read")])], additional: "many" }]],
  // Time per agent and run, tile kind, n/m and default per card, token sum, description.
  "time, tiles and cards": [["loading"], ["loaded", { runs: [
    run("wf_z1", [
      agent(1, "finished", "Read", { startedAt: 100, endedAt: 5100, tokens: 1000, tokenKind: "full" }),
      agent(2, "skipped", "Read", { startedAt: 200, endedAt: 300, tokens: 50, tokenKind: "full" }),
      agent(3, "running", "Check", { startedAt: 9_000_000, tokens: 7, tokenKind: "full" }),
      agent(4, "waiting", "Check", { reason: "cap" }),
      agent(5, "error", "Addendum", { endedAt: 400 }),
      agent(6, "finished", null, { fromCache: true, endedAt: 12, tokens: 3 }),
      agent(7, "stopped", "Addendum", { startedAt: 500 }),
    ], { description: "  Checks the findings.  ", startedAt: 50 }),
    run("wf_z2", [agent(1, "stopped", "Read", { startedAt: 50 }), agent(2, "without-result", "Read", { startedAt: 60, endedAt: 70, tokens: 5, tokenKind: "full" })],
      { status: "stopped", startedAt: 10, endedAt: 9000, description: "" }),
    run("wf_z3", [agent(1, "finished", "Read", { startedAt: 5 })], { status: "finished", startedAt: 0, endedAt: null }),
    run("wf_z4", [agent(1, "running", "Read", { startedAt: 5 })], { startedAt: undefined, description: 7 }),
    // A phase in which only waiting remains (cap) stands open — it is the running one, not a finished one.
    run("wf_z5", [agent(1, "finished", "Read"), agent(2, "waiting", "Wait", { reason: "cap" }), agent(3, "finished", "Wait")]),
  ] }]],
  // Which handles stand per row, and the restart count.
  "handles per row": [["loading"], ["loaded", { runs: [
    run("wf_g", [agent(1, "running", "Read"), agent(2, "waiting", "Read", { reason: "limit", agentId: "ag-2", restarts: 2 }), agent(3, "waiting", "Read"),
      agent(4, "finished", "Read", { restarts: 1 }), agent(5, "running", "Read", { agentId: "" }), agent(6, "skipped", "Read")]),
    run("wf_h", [agent(1, "running", "Read")], { status: "stopped" }),
  ] }]],
  // "visible wait reason" is generated from WAIT_REASONS and CAP_KINDS (`waitReasonProcedure`, in the section "Web" — only
  // the compiled module knows the lists) and is therefore added to this table only there.
  "badge over two runs": [["loading"], ["loaded", { runs: [
    run("wf_x", [agent(1, "running", "Read"), agent(2, "waiting", "Read"), agent(3, "running", "Check"), agent(4, "finished", "Check")]),
    run("wf_y", [agent(1, "running", "Read")], { status: "stopped" }),
  ] }]],
};
const STATUS = ["running", "finished", "stopped", "failed", "interrupted", "whatever"];
const MODELS = [["claude", "claude-opus-5-5"], ["codex", "gpt-5.6-sol"], ["", "gpt-5.6-sol"], ["claude", ""], ["claude", "(Standard)"], ["", ""],
  ["openrouter", "anthropic/claude-sonnet-5"], ["claude", "claude-"], ["claude", "claude"], ["glm", "z-ai/glm-5/"], ["codex", "codex-mini"]];
const DURATIONS = [0, 499, 500, 1499, 59_499, 59_500, 61_000, 3_599_499, 3_600_000, 3_661_000, 86_399_000, -2500];

// ── The canonical line of a state (both sides write it the same) ───────────────────────────────────
const emptyZ = (x) => (x === null || x === undefined ? "∅" : x);
const msZ = (x) => (x === null || x === undefined ? "∅" : String(Math.round(x)));
const wtZ = (w) => (w ? [w.short, w.lang, w.explanation, emptyZ(w.values.n), emptyZ(w.values.reason)].join("§") : "∅");
function stateText(s, b) {
  const header = [`G=${s.loaded}`, `L=${s.loading}`, `W=${s.additional}`, `T=${emptyZ(b.carriesWorkflow(s))}`, `A=${b.runningWorkflowAgents(s)}`,
    `R=${s.runs.map((l) => l.runId).join(",")}`, `P=${s.buffer.map((l) => l.runId).join(",")}`].join(" ");
  const runs = s.runs.map((l) => {
    const { header: k, bands } = b.treeModel(l);
    const tok = b.runTokens(l);
    const kt = [k.runId, k.name, emptyZ(k.phase), `${k.finished}/${k.started}`, k.status, k.running, k.stoppedOf,
      k.logs.map((z) => z.text).join("¦"), k.logsTruncated, emptyZ(k.warning), k.description, msZ(b.runDurationMs(l, NOW)),
      tok ? `${tok.tokens}${tok.tokenKind}` : "∅"].join("|");
    const handles = (z) => { const g = b.agentHandles(z, k.running); return `${g.skip ? "U" : ""}${g.restart ? "N" : ""}^${z.restarts ?? 0}`; };
    const time = (z) => `~${b.tileKind(z.status)}@${msZ(b.agentDurationMs(z, l, NOW))}`;
    const bt = bands.map((band) => `${emptyZ(band.title)}(${band.finished}/${band.rows.length}${b.bandDefaultOpen(band, k.running) ? "+" : "-"})${band.empty ? `!${band.empty}/${b.BAND_EMPTY_WORD[band.empty]}` : ""}:${band.rows.map((z) => `${z.n}=${z.state ? `${z.state.identifier}/${z.state.word}` : "finished"}+${handles(z)}${time(z)}`).join(",")}`).join(";");
    // The wait reason per band (phase head) and per row.
    const wt = bands.map((band) => `${emptyZ(band.title)}?${wtZ(b.bandWaitText(band, k.running, l.cap))}:${band.rows.map((z) => `${z.n}?${wtZ(b.waitText(z, l.cap))}`).join(",")}`).join(";");
    return `${kt} [${bt}] W[${wt}]`;
  });
  return [header, ...runs].join(" ‖ ");
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────────────────────
let webMod = null;
async function loadWeb() {
  if (webMod) return webMod;
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, path.join(webDir, "src", "lib", "dyn-tree.ts"), path.join(webDir, "src", "lib", "agents.ts"),
    "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const tree = await import(pathToFileURL(path.join(out, "dyn-tree.js")).href);
  const agents = await import(pathToFileURL(path.join(out, "agents.js")).href);
  webMod = { tree, agents };
  return webMod;
}
function webProcedure(b, steps) {
  let s = b.TREE_UNLOADED;
  return steps.map(([op, data]) => {
    if (op === "loading") s = b.treeLoading(s);
    else if (op === "failed") s = { ...s, loading: false, buffer: [] }; // the error path of the hook (chat/chatDynTree.ts)
    else if (op === "loaded") s = b.treeLoaded(s, data);
    else if (op === "afterEvent") s = b.treeAfterEvent(s, data);
    return stateText(s, b);
  });
}

// ── The procedure "visible wait reason", generated from the lists of the web ──────────────────
// Per reason from `WAIT_REASONS` one waiting agent in a phase of its OWN (so the phase head speaks per reason), for "cap"
// per kind from `CAP_KINDS` and one without a kind; per kind an own number (3, 4, …) so that a swapped kind shows. The runs
// once WITH the cap numbers (`wf_wg_with`) and once WITHOUT (`wf_wg_without`, an older server). Before them the fixed cases —
// a phase that waits entirely at the cap per run while two others run, a phase with a running agent (no head text), the
// FIRST waiting agent decides, an unknown reason, numbers that are none, a finished run; afterwards an event with new numbers.
function waitReasonCases(reasons, kinds) {
  return reasons.flatMap((reason) => (reason === "cap"
    ? [...kinds.map((kind) => ({ reason, cap: kind, phase: `cap/${kind}` })), { reason, phase: "cap/without kind" }]
    : [{ reason, phase: reason }]));
}
function waitReasonProcedure(reasons, kinds) {
  const cases = waitReasonCases(reasons, kinds);
  const counts = Object.fromEntries(kinds.map((kind, i) => [kind, i + 3]));
  const waiting = () => cases.map((f, i) => agent(i + 1, "waiting", f.phase, { reason: f.reason, ...(f.cap ? { cap: f.cap } : {}) }));
  return [["loading"], ["loaded", { runs: [
    run("wf_w1", [
      agent(1, "running", "Checks", { startedAt: 9_000_000 }), agent(2, "running", "QA", { startedAt: 9_000_000 }),
      ...[3, 4, 5, 6, 7, 8].map((n) => agent(n, "waiting", "Verify", { reason: "cap", cap: "run" })),
    ], { phase: "Verify", phases: ["Checks", "QA", "Verify"], cap: { run: 2, user: 8 } }),
    run("wf_w2", [
      agent(1, "waiting", "A", { reason: "cap", cap: "user" }), agent(2, "waiting", "B", { reason: "stagger" }),
      agent(3, "waiting", "C", { reason: "limit", agentId: "ag-3", startedAt: 5, tokens: 40, tokenKind: "full" }),
      agent(4, "waiting", "D", { reason: "credit-gate" }), agent(5, "waiting", "E", { reason: "project" }), agent(6, "waiting", "F"),
      agent(7, "waiting", "G", { reason: "new-reason" }), agent(8, "waiting", "H", { reason: "cap" }),
      agent(9, "waiting", "I", { reason: "cap", cap: "other" }), agent(10, "waiting", "J", { reason: "stagger", cap: "run" }),
      agent(11, "waiting", null, { reason: "cap", cap: "run" }), agent(12, "finished", "K"), agent(13, "waiting", "K", { reason: "limit" }),
      agent(14, "running", "L"), agent(15, "waiting", "L", { reason: "cap", cap: "run" }),
      agent(16, "waiting", "M", { reason: "stagger" }), agent(17, "waiting", "M", { reason: "cap", cap: "run" }),
      agent(18, "waiting", "N", { reason: 7 }), agent(19, "finished", "O", { reason: "cap", cap: "run" }),
    ], { phase: "A", phases: [], cap: { run: 3, user: 5 } }),
    run("wf_w3", [agent(1, "waiting", "A", { reason: "cap", cap: "run" }), agent(2, "waiting", "B", { reason: "cap", cap: "user" })], { phase: "A", phases: [] }),
    run("wf_w4", [agent(1, "waiting", "A", { reason: "cap", cap: "run" }), agent(2, "waiting", "B", { reason: "cap", cap: "user" })], { phase: "A", phases: [], cap: { run: 0, user: 2.5 } }),
    run("wf_w5", [agent(1, "waiting", "A", { reason: "cap", cap: "run" }), agent(2, "waiting", "B", { reason: "cap", cap: "user" })], { phase: "A", phases: [], cap: { run: "2", user: 1 } }),
    run("wf_w6", [agent(1, "waiting", "A", { reason: "cap", cap: "run" })], { phase: "A", phases: [], cap: "many" }),
    run("wf_w7", [agent(1, "waiting", "A", { reason: "cap", cap: "run" })], { status: "stopped", phase: "A", phases: [], cap: { run: 2 } }),
    run("wf_wg_with", waiting(), { phase: cases[0].phase, phases: [], cap: counts }),
    run("wf_wg_without", waiting(), { phase: cases[0].phase, phases: [] }),
  ] }], ["afterEvent", event(run("wf_w1", [agent(1, "finished", "Checks"), agent(3, "running", "Verify"), agent(4, "waiting", "Verify", { reason: "cap", cap: "run" })],
    { phase: "Verify", phases: ["Checks", "QA", "Verify"], cap: { run: 4, user: 8 } }))]];
}
// Only the compiled module knows the lists — hence here, before the first test (the Swift driver reads PROCEDURES when it is built).
const { tree: WEB_TREE } = await loadWeb();
PROCEDURES["visible wait reason"] = waitReasonProcedure(WEB_TREE.WAIT_REASONS, WEB_TREE.CAP_KINDS);

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────────────────────
const rawSwift = (text) => {
  assert.ok(!text.includes("\"#"), "an input contains the end marker of a Swift raw string");
  return `#"${text}"#`;
};
let iosResult = null;
function runIos() {
  if (iosResult) return iosResult;
  const sources = SOURCES_SWIFT.map((d) => {
    const q = fs.readFileSync(d, "utf8");
    assert.deepEqual(q.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], `${path.basename(d)} imports only Foundation — otherwise it no longer runs alone here`);
    return q;
  });
  const cases = Object.entries(PROCEDURES).map(([name, steps]) =>
    `    (${rawSwift(name)}, [${steps.map(([op, data]) => `(${rawSwift(op)}, ${rawSwift(JSON.stringify(data ?? null))})`).join(", ")}]),`).join("\n");
  const file = path.join(tmpDir(), "tree.swift");
  fs.writeFileSync(file, `${sources.join("\n")}

// ── Driver (web/test/dyn-tree-binding.test.mjs) ──
func empty(_ x: String?) -> String { x ?? "∅" }
func msZ(_ x: Double?) -> String { x.map { String(Int($0.rounded())) } ?? "∅" }
func wtZ(_ w: DynTree.WaitText?) -> String {
    guard let w else { return "∅" }
    return [w.short, w.lang, w.explanation, w.n.map { String($0) } ?? "∅", w.reason ?? "∅"].joined(separator: "§")
}
let NOW: Double = ${NOW}
func stateText(_ s: DynTree.Snapshot) -> String {
    let t = DynTree.carriesWorkflow(s).map { $0 ? "true" : "false" } ?? "∅"
    let header = "G=\\(s.loaded) L=\\(s.loading) W=\\(s.additional) T=\\(t) A=\\(DynTree.runningWorkflowAgents(s)) R=\\(s.runs.map(\\.runId).joined(separator: ",")) P=\\(s.buffer.map(\\.runId).joined(separator: ","))"
    let runs = s.runs.map { l -> String in
        let (k, bands) = DynTree.model(l)
        let tok = DynTree.runTokens(l).map { "\\($0.tokens)\\($0.tokenKind)" } ?? "∅"
        let kt = [k.runId, k.name, empty(k.phase), "\\(k.finished)/\\(k.started)", k.status, "\\(k.running)", k.stoppedOf,
                  k.logs.map(\\.text).joined(separator: "¦"), "\\(k.logsTruncated)", empty(k.warning), k.description,
                  msZ(DynTree.runDurationMs(l, now: NOW)), tok].joined(separator: "|")
        let bt = bands.map { b in
            empty(b.title) + "(\\(b.finished)/\\(b.rows.count)" + (DynTree.bandDefaultOpen(b, runRunning: k.running) ? "+" : "-") + ")" + (b.empty.map { "!\\($0.rawValue)/\\($0.word)" } ?? "") + ":" + b.rows.map { z in
                let g = DynTree.handles(z.agent, runRunning: k.running)
                let time = "~\\(DynTree.tileKind(z.agent.status))@" + msZ(DynTree.agentDurationMs(z.agent, run: l, now: NOW))
                return "\\(z.agent.n)=" + (z.state.map { "\\($0.identifier)/\\($0.word)" } ?? "finished") + "+" + (g.skip ? "U" : "") + (g.restart ? "N" : "") + "^\\(z.agent.restarts)" + time
            }.joined(separator: ",")
        }.joined(separator: ";")
        let wt = bands.map { b in
            empty(b.title) + "?" + wtZ(DynTree.bandWaitText(b, runRunning: k.running, cap: l.cap)) + ":" + b.rows.map { z in
                "\\(z.agent.n)?" + wtZ(DynTree.waitText(z.agent, cap: l.cap))
            }.joined(separator: ",")
        }.joined(separator: ";")
        return "\\(kt) [\\(bt)] W[\\(wt)]"
    }
    return ([header] + runs).joined(separator: " ‖ ")
}
let cases: [(String, [(String, String)])] = [
${cases}
]
for (name, steps) in cases {
    var s = DynTree.Snapshot()
    for (i, (op, data)) in steps.enumerated() {
        let d = data.data(using: .utf8)!
        switch op {
        case "loading": s = DynTree.loading(s)
        case "failed": s = DynTree.failed(s)
        case "loaded": s = DynTree.loaded(s, response: data == "null" ? nil : d)
        case "afterEvent": s = DynTree.afterEvent(s, event: d)
        default: break
        }
        print("S\\t\\(name)#\\(i)\\t" + stateText(s))
    }
}
for st in [${STATUS.map((x) => rawSwift(x)).join(", ")}] { print("W\\t\\(st)\\t" + DynTree.runWord(st)) }
for (i, (a, m)) in [${MODELS.map(([a, m]) => `(${rawSwift(a)}, ${rawSwift(m)})`).join(", ")}].enumerated() { print("M\\t\\(i)\\t" + DynTree.modelText(provider: a, model: m)) }
for (i, (a, m)) in [${MODELS.map(([a, m]) => `(${rawSwift(a)}, ${rawSwift(m)})`).join(", ")}].enumerated() { print("K\\t\\(i)\\t" + DynTree.modelShortName(provider: a, model: m)) }
for ms in [${DURATIONS.map((d) => `${d}.0`).join(", ")}] as [Double] { print("D\\t\\(Int(ms))\\t" + DynTree.durationShort(ms)) }
`);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  const r = { S: new Map(), W: new Map(), M: new Map(), K: new Map(), D: new Map() };
  for (const z of output.split("\n").filter(Boolean)) {
    const [kind, k, ...rest] = z.split("\t");
    if (r[kind]) r[kind].set(k, rest.join("\t"));
  }
  iosResult = r;
  return r;
}

test("every procedure from route and event — iOS holds the same state and model as the web, step by step", async (t) => {
  const { tree } = await loadWeb();
  const r = runIos();
  const deviations = [];
  let n = 0;
  for (const [name, steps] of Object.entries(PROCEDURES)) {
    webProcedure(tree, steps).forEach((w, i) => {
      n++;
      const m = r.S.get(`${name}#${i}`);
      if (w !== m) deviations.push(`${name} #${i}:\n    Web  ${w}\n    iOS  ${m}`);
    });
  }
  t.diagnostic(`[tree binding] ${Object.keys(PROCEDURES).length} procedures, ${n} steps, ${deviations.length} deviation(s)`);
  assert.equal(r.S.size, n, `the Swift side answered ${r.S.size} of ${n} steps`);
  assert.deepEqual(deviations, [], "The sheet on the iPhone showed something other than the bar on the desktop:\n  " + deviations.join("\n  "));
  // The places where a version is most likely to tip — named so that a regression carries their name.
  assert.match(r.S.get("full run, bands and n/m#1"), /\|2\/7\|/, "n/m: only \"finished\" counts");
  assert.match(r.S.get("loaded empty#1"), /T=false/, "a read empty list is \"no workflow\"");
  assert.match(r.S.get("answer without list is not empty#2"), /G=false .*T=∅/, "an answer without a list is not \"no workflow\"");
  // Behind every row stands `~tile@time`, behind every title `(n/m±)` — not meant here.
  assert.match(r.S.get("handles per row#1"), /\[Read\([^)]*\):1=running\/running\+UN\^0~[^,]*,2=waiting\/waiting\+U\^2~[^,]*,3=waiting\/waiting\+\^0~[^,]*,4=finished\+\^1~[^,]*,5=running\/running\+\^0~[^,]*,6=skipped\/skipped\+\^0~[^\]]*\]/,
    "handles: skip on running and parked ones, restart only on running ones, nothing without agentId");
  assert.match(r.S.get("handles per row#1"), /wf_h\|.*\[Read\([^)]*\):1=running\/running\+\^0~[^\]]*\]/, "no handles in a finished run");
  assert.match(r.S.get("event during the request#2"), /wf_a\|[^|]*\|[^|]*\|0\/1\|stopped/, "the older answer does not overwrite the event");
  // Times, tiles and cards — named where a version is most likely to tip.
  const z = r.S.get("time, tiles and cards#1");
  assert.match(z, /\|Checks the findings\.\|9999950\|1060only_output \[/, "head: description trimmed, run time until now, token sum with lower bound (an agent without kind)");
  assert.match(z, /Read\(1\/2-\):1=finished\+\^0~finished@5000,2=skipped\/skipped\+\^0~muted@100/, "finished phase: closed, n/m 1/2, time start to end");
  assert.match(z, /Check\(0\/2\+\):3=running\/running\+UN\^0~running@1000000,4=waiting\/waiting\+\^0~waiting@∅/, "running phase: open, time until now, the waiting one without time");
  assert.match(z, /∅\(1\/1-\):6=finished\+\^0~finished@∅/, "from the journal: no time; the group without a phase last");
  assert.match(z, /wf_z2\|.*\|8990\|5full \[Read\(0\/2-\):1=stopped\/stopped\+\^0~aborted@8950,2=without-result\/no result\+\^0~aborted@10;Check\(0\/0-\)!not_reached\/not reached:\]/,
    "finished run: nothing open, an agent without an own end counts until the end of the run, the never entered phase is \"not reached\"");
  assert.match(z, /wf_z3\|.*\|∅\|∅ \[Read\(1\/1-\):1=finished\+\^0~finished@∅;Check\(0\/0-\)!not_reached\/not reached:\]/, "without a start time no run time, without an end of the run no time");
  assert.match(z, /wf_z4\|.*\|\|∅\|∅ \[/, "without startedAt no run time; a description that is not a string is empty");
  assert.match(z, /wf_z5\|.*\[Read\(1\/1-\):[^;]*;Check\(0\/0-\)!without_agents\/no agents:;Wait\(1\/2\+\):2=waiting/,
    "a phase in which only waiting remains stands open; a phase without agents BEFORE one with agents is passed, not pending");
  // The wait reason — named where a version is most likely to tip.
  const w = r.S.get("visible wait reason#1");
  const run2 = "waiting · {n} at a time§waiting for a free slot · {n} at a time§Cap per workflow: {n} at a time. The agent starts as soon as a slot frees up.§2§∅";
  assert.ok(w.includes(`W[Checks?∅:1?∅;QA?∅:2?∅;Verify?${run2}:3?${run2},4?${run2}`),
    `the waiting phase says "waiting for a free slot · 2 at a time", the running ones nothing — ${w}`);
  assert.match(w, /wf_w2\|.*?W\[A\?waiting · \{n\} per user§[^§]*§[^§]*§5§∅:1\?waiting · \{n\} per user/, "kind \"user\" takes the number of the cap per user");
  assert.match(w, /;L\?∅:14\?∅,15\?waiting · \{n\} at a time§[^§]*§[^§]*§3§∅/, "if one runs in the phase, its head is silent — the row is not");
  assert.match(w, /;M\?waiting · prompt cache§/, "at the phase head the FIRST waiting agent counts");
  assert.match(w, /;K\?waiting · limit§[^§]*§[^§]*§∅§∅:12\?∅,13\?waiting · limit§/, "finished and waiting, nothing runs: the head says what for");
  assert.match(w, /;O\?∅:19\?∅/, "a finished one with an old reason does not wait");
  assert.match(w, /;H\?waiting for a slot§waiting for a free slot§[^§]*§∅§∅:8\?/, "\"cap\" without kind: without a number, none invented");
  assert.match(w, /;G\?waiting · \{reason\}§[^§]*§[^§]*§∅§new-reason:/, "an unknown reason verbatim");
  assert.match(w, /;N\?waiting§waiting§waiting§∅§∅:/, "a reason that is not a string is none");
  for (const id of ["wf_w3", "wf_w4", "wf_w6"]) assert.match(w, new RegExp(`${id}\\|.*?W\\[A\\?waiting for a slot§`), `${id}: no (valid) number ⇒ without a number`);
  assert.match(w, /wf_w5\|.*?W\[A\?waiting for a slot§.*?;B\?waiting · \{n\} per user§[^§]*§[^§]*§1§∅/, "\"2\" as text is no number, 1 is one");
  assert.match(w, /wf_w7\|.*?W\[A\?∅:1\?waiting · \{n\} at a time§/, "no head text in a finished run");
  assert.match(r.S.get("visible wait reason#2"), /wf_w1\|.*?Verify\?∅:3\?∅,4\?waiting · \{n\} at a time§[^§]*§[^§]*§4§∅/, "an event brings the new number");
  // The generated part — per reason from WAIT_REASONS (for "cap" per kind from CAP_KINDS and one without a kind) a phase,
  // with and without numbers. That iOS says the same is held by the comparison above; here that the part is there and
  // none falls back to "waiting · {reason}", and that the number stands only with kind AND number on the run.
  const cases = waitReasonCases(tree.WAIT_REASONS, tree.CAP_KINDS);
  assert.ok(tree.WAIT_REASONS.length >= 5 && tree.CAP_KINDS.length >= 2 && cases.length === tree.WAIT_REASONS.length + tree.CAP_KINDS.length,
    `the generated part is too small: ${cases.length} cases`);
  const segment = (runId) => w.split(" ‖ ").find((x) => x.startsWith(`${runId}|`)) ?? "";
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  tree.CAP_KINDS.forEach((kind, i) => assert.ok(cases.some((f) => f.cap === kind), `kind ${kind} is missing in the generated part (${i})`));
  for (const [runId, withCount] of [["wf_wg_with", true], ["wf_wg_without", false]]) {
    const seg = segment(runId);
    assert.ok(seg, `${runId} is missing`);
    cases.forEach((f, i) => {
      const m = seg.match(new RegExp(`(?:W\\[|;)${esc(f.phase)}\\?([^§]*)§([^§]*)§([^§]*)§([^§]*)§([^:]*):${i + 1}\\?`));
      assert.ok(m, `${runId}: the phase "${f.phase}" does not speak — ${seg}`);
      assert.notEqual(m[1], "waiting · {reason}", `${runId}: "${f.reason}" falls back`);
      const count = withCount && f.cap ? String(tree.CAP_KINDS.indexOf(f.cap) + 3) : "∅";
      assert.equal(m[4], count, `${runId}: "${f.phase}" carries the number ${count}`);
    });
  }
  // A phase from meta.phases in which no agent has run yet stands there.
  assert.match(r.S.get("every journal state#1"), /wf_st\|.*;Check\(0\/0-\)!pending\/pending:\]/, "in a running run the coming phase is \"pending\"");
});

test("short model name and time format of the column — iOS writes the same as the web", async () => {
  const { tree, agents } = await loadWeb();
  const r = runIos();
  MODELS.forEach(([a, m], i) => assert.equal(r.K.get(String(i)), tree.modelShortName(a, m), `modelShortName(${a}, ${m})`));
  for (const ms of DURATIONS) assert.equal(r.D.get(String(ms)), agents.durationShort(ms), `durationShort(${ms})`);
  // Named: the two cases the function exists for.
  assert.equal(r.K.get("0"), "opus-5-5");
  assert.equal(r.K.get("6"), "claude-sonnet-5", "the path of a router drops out");
  assert.equal(r.D.get("3661000"), "1:01:01");
});

test("run word, wait reason and \"provider::model\" — iOS says the same as the web, and every word is translated", async () => {
  const { tree, agents } = await loadWeb();
  const r = runIos();
  for (const st of STATUS) assert.equal(r.W.get(st), tree.runWord(st), `runWord(${st})`);
  // The wait reason (`waitText`, short/long/explanation with number) stands in the canonical line of every procedure
  // (`W[…]`) — that iOS delivers the same keys is held by the first test; here only that every one is translated.
  MODELS.forEach(([a, m], i) => assert.equal(r.M.get(String(i)), agents.modelText(a, m), `modelText(${a}, ${m})`));
  // `L(DynTree.runWord(…))` is no literal call — loc-audit.sh does not see it. Hence here: every word has a German entry
  // in one of the two tables.
  const tables = ["LocDEBase.swift", "LocDEMobile.swift"].map((d) => fs.readFileSync(ios("Kit", d), "utf8")).join("\n");
  const key = new Set([...tables.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"/gm)].map((m) => m[1]));
  // Plus the words of the phases without agents (`L(empty.word)`) — that iOS says the same is held by the row `!kind/word`.
  const words = [...STATUS.filter((s) => s !== "whatever").map((s) => r.W.get(s)), ...tree.WAIT_KEY,
    ...Object.values(tree.BAND_EMPTY_WORD)];
  const missing = words.filter((w) => !key.has(w));
  assert.deepEqual(missing, [], `without a German entry: ${missing.join(", ")}`);
});

// ── Only in coding chats ──────────────────────────────────────────────────────────────────────────────────────
// The sheet loads and shows the tree only if its model carries `withDynWorkflows` — and only the coding chat (`ChatView`)
// sets it. Other chat models are built without. Counter-test: `withDynWorkflows: true` in another Swift file turns it red.
test("only the coding chat builds its model with the tree", () => {
  const hits = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (e.name.endsWith(".swift") && /withDynWorkflows:\s*true/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ios(), p));
    }
  };
  run(ios());
  assert.deepEqual(hits, [path.join("Chat", "ChatView.swift")]);
  const sheet = fs.readFileSync(ios("Chat", "ChatDetailSheet.swift"), "utf8");
  // The runs stand as cards in the ONE list "Background Tasks" — only under `withDynWorkflows` do they get into the list at all.
  assert.match(sheet, /let runs = model\.withDynWorkflows \? model\.dynTree\.runs : \[\]/, "the agent sheet takes the runs into the list only under `withDynWorkflows`");
  const load = fs.readFileSync(ios("Chat", "ChatViewModel+DynTree.swift"), "utf8");
  assert.match(load, /guard withDynWorkflows, !isDraft else/, "the tree is loaded only under `withDynWorkflows`");
});
