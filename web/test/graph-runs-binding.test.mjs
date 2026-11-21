// Graph workflow starts, bound: web and iOS CALCULATE the same.
//
// The calculation exists twice: `web/src/lib/graph-runs.ts` and `mobile/CbaseMobile/Chat/GraphRuns.swift`. Both take the
// same run view of the server (workflows/graph-start.js graphRunView, route `GET …/graph-workflows` and event `graph_run`)
// and derive from it: the loading state (not loaded is not "no start", events during the request lie over the answer,
// newest first, a new start sits on top on a tie), the row above the input field (`foregroundRow`), the card of a
// background run (`cardOf`: title, state word, tone, warning dot, second row, worktree, stop), the response form per wait
// kind (`responseForm`: route, buttons with word and sent word, free text, questions of the question card) and the
// request for an input (`responseRequest`: path on the child chat and body). Two versions that LOOK right diverge at
// exactly such places — only running both shows it.
//
// Model: dyn-tree-binding.test.mjs. The Swift file is taken WHOLE (it imports only Foundation, the test checks that),
// assembled with a driver into one program and REALLY compiled with `xcrun swiftc`. Both sides get the same cases as
// JSON. The request path is encoded on the web (fetch), NOT on iOS (`APIClient.makeURL` encodes itself) — the decoded
// web path is compared. If the toolchain is missing, the test fails LOUDLY (hence under `onlyMacOS` in
// `tools/check/latch.json`).
//
// Counter-tests: in GraphRuns.swift `fresh.insert(run, at: 0)` → `fresh.append(run)` => "State" red (a new start on a
// tie sat at the bottom); the `guard !startId.isEmpty` removed => likewise; the short-name fallback
// (`l.name.isEmpty ? l.shortName : l.name`) dropped => likewise; `foregroundRow` as a loop over the newest start of
// ANY kind => likewise; in `responseForm` `case "done", "stopped"` → `case "done"` => "Card, form, request" red;
// `min(n, stillMax)` → `n` => likewise.
//
// Run:  node --test web/test/graph-runs-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "graph-runs.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "GraphRuns.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-graph-runs-binding-")));

// ── The inputs: views in the server's shape ──────────────────────────────────────────────────────────────────
const view = (startId, state, extra = {}) => ({
  startId, background: true, worktree: false, worktreePath: "", workflowId: `wf-${startId}`, name: `Job ${startId}`,
  shortName: `job-${startId}`, input: "", state, reason: "", chatId: `kind-${startId}`, run: null, wait: null,
  stoppedOf: "", startedAt: 100, updatedAt: 100, endedAt: null, ...extra,
});
const event = (runItem) => ({ type: "harness", subtype: "graph_run", run: runItem });
const run = (o = {}) => ({ id: "run-1", status: "running", step: 3, total: 7, nodeTitle: "Implement", pending: "", ...o });
const wait = (wait2, extra = {}) => view(extra.startId ?? `w-${wait2?.kind ?? "x"}`, "waiting", { run: run({ status: "waiting" }), wait: wait2, ...extra });
const QUESTIONS = [
  { header: "Way", question: "Which way?", multiSelect: false, options: [{ label: "A", description: "A first" }, { label: "B" }, { label: "" }, "broken"] },
  { header: "Parts", question: "Which parts?", multiSelect: true, options: [{ label: "C", description: "" }, { label: "D", description: "then D" }] },
  "no question",
];

// The procedure of the state: step by step, after each the state and the row above the input field.
const front = (startId, state, extra = {}) => view(startId, state, { background: false, chatId: "orch", ...extra });
const PROCEDURE = [
  { op: "afterEvent", event: event(front("early", "earmarked", { name: "", startedAt: 5 })) },
  { op: "loading" },
  { op: "afterEvent", event: event(front("a", "stopped", { startedAt: 50 })) },
  { op: "afterEvent", event: { type: "harness", subtype: "dynwf_tree", run: front("x", "earmarked") } },
  { op: "afterEvent", event: event({ startId: "", state: "earmarked" }) },
  { op: "loaded", response: { runs: [
    front("a", "earmarked", { startedAt: 50 }), front("b", "finished", { startedAt: 50, worktree: true, worktreePath: "/ws/.cbase-worktrees/b" }),
    view("h", "running", { startedAt: 60 }), { startId: "", state: "finished" }, { startId: "without-state" }, "broken",
  ] } },
  // same time as a and b: a NEW start sits on top
  { op: "afterEvent", event: event(front("c", "waiting_lock", { startedAt: 50, reason: "Project “web” is busy" })) },
  { op: "row", hidden: [] },
  { op: "afterEvent", event: event(front("c", "running", { startedAt: 50 })) },
  { op: "afterEvent", event: event(front("early", "dismissed", { startedAt: 5, name: "", worktreePath: "/ws/wt-early" })) },
  // an older open start takes precedence over a NEWER worktree notice
  { op: "afterEvent", event: event(front("new-wt", "finished", { startedAt: 70, worktree: true, worktreePath: "/ws/wt-new" })) },
  { op: "afterEvent", event: event(front("a", "waiting_lock", { startedAt: 50 })) },
  { op: "afterEvent", event: event(front("a", "stopped", { startedAt: 50 })) },
  { op: "row", hidden: ["b"] },
  { op: "row", hidden: ["b", "new-wt"] },
  { op: "row", hidden: ["b", "new-wt", "early"] },
  { op: "loading" },
  { op: "loaded", response: null },
  { op: "loading" },
  { op: "loaded", response: { error: "x", reason: "unknown" } },
  { op: "loading" },
  { op: "loaded", response: { runs: [] } },
];

// The views for card, form and request.
const VIEWS = [
  ...["earmarked", "waiting_lock", "waiting_storage", "running", "waiting", "finished", "failed", "stopped", "dismissed", "anything", ""]
    .map((z) => view(`z-${z || "empty"}`, z)),
  view("reason", "waiting_lock", { reason: "Project “web” is busy", run: run() }),
  view("step", "running", { run: run() }),
  view("without-total", "running", { run: run({ total: 0 }) }),
  view("without-title", "running", { run: run({ nodeTitle: "" }) }),
  view("only-title", "running", { run: run({ step: 0 }) }),
  view("comma", "running", { run: run({ step: 2.7, total: 9.2 }) }),
  view("run-broken", "running", { run: "broken" }),
  view("worktree", "finished", { worktree: true, worktreePath: "/ws/.cbase-worktrees/g1" }),
  view("without-name", "running", { name: "" }),
  view("front", "waiting", { background: false, wait: { kind: "question", question: "Which color?" } }),
  // Wait kinds
  wait({ kind: "question", question: "Which color?" }),
  wait({ kind: "cap", question: "Already 3 rounds." }),
  wait({ kind: "review", question: "Please review." }),
  wait({ kind: "done" }),
  wait({ kind: "stopped" }),
  wait({ kind: "agent_ask", requestId: "ask-1", questions: QUESTIONS }),
  wait({ kind: "agent_ask", requestId: "ask-2" }, { startId: "ask-empty" }),
  wait({ kind: "agent_ask", questions: "broken" }, { startId: "ask-broken" }),
  wait({ kind: "permission", requestId: "perm-1", tool: "Bash", input: "rm -rf build" }),
  wait({ kind: "permission" }, { startId: "perm-without" }),
  wait({ kind: "dyn_approval", requestId: "dyn-1", dynName: "sweep", dynDescription: "everything" }),
  wait({ kind: "dyn_approval", requestId: "" }, { startId: "dyn-without" }),
  wait({ kind: "unknown", requestId: "u" }),
  wait(null, { startId: "without-wait" }),
  wait({ question: "without kind" }, { startId: "without-kind" }),
  wait("broken", { startId: "wait-broken" }),
  wait({ kind: "question" }, { startId: "running-with-wait", state: "running" }),
  wait({ kind: "question" }, { startId: "without-kind", chatId: "" }),
  wait({ kind: "cap" }, { startId: "special-characters", chatId: "kind 1/ä-b" }),
];

const INPUTS = [
  {}, { text: "   " }, { text: " Make it blue \n" }, { button: "further" }, { button: "more" }, { button: "more", n: 5 },
  { button: "more", n: 500 }, { button: "more", n: 0 }, { button: "complete" }, { button: "matches", text: "whatever" },
  { button: "allow" }, { button: "reject" }, { button: "accept" }, { button: "foreign" }, { button: "", text: "empty button" },
  { selection: [["A", "B", "X", "A"]] }, { selection: [["A"], ["C", "D", "C"]] }, { selection: [[], ["D"]], texts: ["", " own "] },
  { selection: [["A"]], text: "alongside" }, { texts: ["  "] },
];

function writeCases() {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify({ procedure: PROCEDURE, views: VIEWS, inputs: INPUTS }));
  return file;
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
function runWeb(cases) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import * as G from "./graph-runs.js";
const { procedure, views, inputs } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const statusRow = (s) => ({ loaded: s.loaded, loading: s.loading, runs: s.runs.map((l) => [l.startId, l.state]),
  buffer: s.buffer.map((l) => l.startId), background: G.backgroundRuns(s).map((l) => l.startId) });
const rowNorm = (z) => z === null ? null : { startId: z.startId, kind: z.kind, name: z.kind === "worktree" ? "" : z.params.name ?? "",
  reason: z.params.reason ?? "", path: z.params.path ?? "" };
let s = G.GRAPH_UNLOADED;
const steps = [];
for (const a of procedure) {
  if (a.op === "loading") s = G.graphLoading(s);
  else if (a.op === "loaded") s = G.graphLoaded(s, a.response);
  else if (a.op === "afterEvent") s = G.graphApply(s, a.event);
  steps.push({ state: statusRow(s), row: rowNorm(G.foregroundRow(s, a.op === "row" ? a.hidden : [])) });
}
const request = (a) => a === null ? null : { path: decodeURIComponent(a.path), body: a.body };
console.log(JSON.stringify({ steps, views: views.map((l) => ({
  card: G.cardOf(l), form: G.responseForm(l), requests: inputs.map((e) => request(G.responseRequest(l, e))),
})) }));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, cases], { encoding: "utf8", env }).trim().split("\n").pop());
}

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
function runIos(cases) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  assert.deepEqual(source.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "GraphRuns.swift imports only Foundation — otherwise it cannot be bound");
  assert.ok(!/\bL\(/.test(source.replace(/\/\/.*$/gm, "")), "GraphRuns.swift does not translate itself (no L(…)) — the words are keys");
  const file = path.join(tmpDir(), "graph.swift");
  fs.writeFileSync(file, `${source}

// ── Driver (web/test/graph-runs-binding.test.mjs) ──
func data(_ v: Any) -> Data { try! JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]) }
func list(_ v: Any?) -> [[String: Any]] { v as? [[String: Any]] ?? [] }
func empty(_ v: Any?) -> Any { v ?? NSNull() }
func formJSON(_ f: GraphRuns.Form?) -> Any {
    guard let f else { return NSNull() }
    return ["kind": f.kind, "route": f.route, "requestId": f.requestId, "freeText": f.freeText, "placeholder": f.placeholder,
            "buttons": f.buttons.map { ["id": $0.id, "word": $0.word, "params": $0.params, "send": $0.send] as [String: Any] },
            "questions": f.questions.map { q in
                ["header": q.header, "question": q.question, "multiple": q.multiple,
                 "options": q.options.map { ["label": $0.label, "description": $0.description] }] as [String: Any]
            }] as [String: Any]
}
func cardJSON(_ k: GraphRuns.Card?) -> Any {
    guard let k else { return NSNull() }
    return ["title": k.title, "stateWord": k.stateWord, "tone": k.tone.rawValue, "warningDot": k.warningDot, "row2": k.row2,
            "worktree": k.worktree, "stop": k.stop, "response": formJSON(k.response)] as [String: Any]
}
func requestJSON(_ a: GraphRuns.Request?) -> Any {
    guard let a else { return NSNull() }
    let body = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(a.body))
    return ["path": a.path, "body": body] as [String: Any]
}
func rowJSON(_ z: GraphRuns.Row?) -> Any {
    guard let z else { return NSNull() }
    let kind: String
    switch z.kind {
    case .earmarked: kind = "earmarked"
    case .waitingLock: kind = "waiting_lock"
    case .worktreeStays: kind = "worktree"
    }
    return ["startId": z.startId, "kind": kind, "name": z.kind == .worktreeStays ? "" : z.name, "reason": z.reason, "path": z.path] as [String: Any]
}
func stateJSON(_ s: GraphRuns.Snapshot) -> Any {
    ["loaded": s.loaded, "loading": s.loading, "runs": s.runs.map { [$0.startId, $0.state] }, "buffer": s.buffer.map(\\.startId),
     "background": GraphRuns.backgroundRuns(s).map(\\.startId)] as [String: Any]
}
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
var s = GraphRuns.Snapshot()
var steps: [Any] = []
for a in list(root["procedure"]) {
    var hidden: Set<String> = []
    switch a["op"] as? String ?? "" {
    case "loading": s = GraphRuns.loading(s)
    case "loaded":
        let response = a["response"].flatMap { $0 is NSNull ? nil : data($0) }
        s = GraphRuns.loaded(s, response: response)
    case "afterEvent": s = GraphRuns.afterEvent(s, event: data(a["event"] ?? NSNull()))
    case "row": hidden = Set(a["hidden"] as? [String] ?? [])
    default: break
    }
    steps.append(["state": stateJSON(s), "row": rowJSON(GraphRuns.foregroundRow(s, hidden: hidden))] as [String: Any])
}
let inputs: [GraphRuns.Input] = list(root["inputs"]).map { e in
    GraphRuns.Input(button: e["button"] as? String, n: (e["n"] as? NSNumber)?.intValue, text: e["text"] as? String,
                        selection: e["selection"] as? [[String]], texts: e["texts"] as? [String])
}
var viewsFrom: [Any] = []
for raw in list(root["views"]) {
    let l = try! JSONDecoder().decode(GraphRuns.View.self, from: data(raw))
    viewsFrom.append(["card": cardJSON(GraphRuns.cardOf(l)), "form": formJSON(GraphRuns.responseForm(l)),
                       "requests": inputs.map { requestJSON(GraphRuns.responseRequest(l, $0)) }] as [String: Any])
}
let outData: [String: Any] = ["steps": steps, "views": viewsFrom]
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "graph");
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

test("State: loading, event, buffer, tie and the row above the input field — step by step the same", () => {
  const { web, ios } = both();
  assert.equal(web.steps.length, PROCEDURE.length);
  for (let i = 0; i < PROCEDURE.length; i++) assert.deepEqual(ios.steps[i], web.steps[i], `Step ${i} (${PROCEDURE[i].op}): iOS differs`);
  // The steps did not run empty: on a tie the new start c sits on top, the buffer lay over the answer,
  // and the row names the open start before the worktree.
  // (the start "early" came before the request and is missing from its answer — the answer is the state, only the buffer lies over it)
  assert.deepEqual(web.steps[5].state.runs, [["h", "running"], ["a", "stopped"], ["b", "finished"]]);
  assert.deepEqual(web.steps[6].state.runs.map(([id]) => id), ["h", "c", "a", "b"]);
  assert.deepEqual(web.steps[7].row, { startId: "c", kind: "waiting_lock", name: "Job c", reason: "Project “web” is busy", path: "" });
  assert.equal(web.steps[11].row.startId, "a", "an older open start before the newer worktree notice");
  assert.equal(web.steps[13].row.startId, "new-wt", "otherwise the newest worktree notice");
  assert.deepEqual(web.steps[14].row, { startId: "early", kind: "worktree", name: "", reason: "", path: "/ws/wt-early" });
  assert.equal(web.steps[15].row, null);
  assert.deepEqual(web.steps[5].state.background, ["h"]);
  assert.equal(web.steps[0].state.loaded, false);
  assert.equal(web.steps.at(-1).state.loaded, true);
  console.log(`# Graph starts: ${PROCEDURE.length} steps, web == iOS`);
});

test("Card, form, request: per view the same card, the same response form and per input the same request", () => {
  const { web, ios } = both();
  assert.equal(web.views.length, VIEWS.length);
  for (let i = 0; i < VIEWS.length; i++) assert.deepEqual(ios.views[i], web.views[i], `View ${VIEWS[i].startId}: iOS differs`);
  // Did not run empty: every route and every body shape occurs.
  const requests = web.views.flatMap((s) => s.requests).filter(Boolean);
  const routes = new Set(requests.map((a) => ["ask-answer", "dyn-workflows/approval", "permission-decision", "message"].find((r) => a.path.endsWith(`/${r}`))));
  assert.deepEqual([...routes].sort(), ["ask-answer", "dyn-workflows/approval", "message", "permission-decision"]);
  const forms = new Set(requests.map((a) => Object.keys(a.body).sort().join(",")));
  assert.deepEqual([...forms].sort(), ["answers,requestId", "behavior,requestId", "decision,requestId", "text"]);
  assert.ok(web.views.some((s) => s.card === null) && web.views.some((s) => s.card && s.card.response), "cards with and without a form, and none");
  assert.ok(requests.some((a) => a.path === "/api/chats/kind 1/ä-b/message"), "the path with special characters (compared decoded)");
  console.log(`# Card/form/request: ${VIEWS.length} views × ${INPUTS.length} inputs, ${requests.length} requests, web == iOS`);
});

test("Translated: every word of the card and form is in i18n-de.ts AND in the mobile dictionaries — loc-audit sees only literals", () => {
  const { web } = both();
  const words = new Set();
  for (const s of web.views) {
    if (s.card) words.add(s.card.stateWord);
    for (const f of [s.form, s.card?.response]) {
      if (!f) continue;
      if (f.placeholder) words.add(f.placeholder);
      for (const k of f.buttons) words.add(k.word);
    }
  }
  // An unknown state stands raw — it is not a key.
  for (const raw of ["anything", ""]) words.delete(raw);
  assert.ok(words.size >= 18, `too few words collected (${words.size})`);
  const en = fs.readFileSync(path.join(webDir, "src", "lib", "i18n-de.ts"), "utf8");
  const mobile = ["LocDEBase.swift", "LocDEMobile.swift"].map((d) => fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Kit", d), "utf8")).join("\n");
  const stands = (text, k) => text.split("\n").some((z) => z.trim().startsWith(`"${k}":`));
  assert.deepEqual([...words].filter((k) => !stands(en, k)), [], "without a German translation on the web");
  assert.deepEqual([...words].filter((k) => !stands(mobile, k)), [], "without a German translation on iOS (showed English)");
});
