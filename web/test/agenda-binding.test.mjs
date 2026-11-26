// The agenda, bound: web and iOS read and compute alike (the "Agenda" section of the right chat rail on the web,
// the sheet behind the "Agenda" header button on the iPhone).
//
// Two versions of the same computation: `web/src/lib/api/agenda.ts` + `web/src/lib/agenda.ts` (shape, groups, empty,
// which version applies, "updated … ago") and `mobile/CbaseMobile/Chat/Agenda.swift` (the same for the sheet). If one
// drifts (the server gets a fourth status, a step without id stays on one side, a late load response overwrites the
// newer event on one side, the thresholds of "… min ago" move), iPhone and desktop show different plans for the same
// chat. `web/test/agenda.test.mjs` binds the web to the server, this file iOS to the web.
//
// Model: running-tasks-binding.test.mjs. The web is compiled with `tsc`, iOS is REALLY compiled from the real source
// (all of Agenda.swift, plus Models/DecodeHelpers.swift, whose helpers it uses, and Models/JSONValue.swift, which
// those know; all three import only Foundation, which the test checks) plus a driver with `xcrun swiftc`. Both sides
// get the same cases as JSON (load responses, version pairs, events, times, trees, click sequences, stored memo
// notes) and write per case the read agenda, the visible rows, "empty", "in work", the progress, the memo note and
// the time text as JSON.
// If the toolchain is missing, the test fails LOUDLY (hence registered in `tools/check/latch.json` under `onlyMacOS`).
//
// Counter-tests, in Agenda.swift: `static let status = ["open", "in_work", "done"]` extended by "blocked" turns
// "status" red; `return fresh.version > oldApplies.version ? fresh : oldApplies` changed to `return fresh` turns "version"
// red; `if min < 60` changed to `if min < 90` turns "time" red.
//
// Tree fields are bound per point (parent, depth, subitems, done, total, project, with nonsense), the visible rows
// with stage and fold state (depth 5, collapsed middle point, deviation from the default, done subtree, unknown
// parent), folding and the memo note from storage, progress and "in work" (leaves only), the key of the memo note.
// Counter-tests tree: `stage: min(p.depth, stages)` changed to `stage: p.depth` turns "tree" and "shape" red;
// `hidden.insert(p.id)` missing in the hidden branch turns "tree" red; `if open != foldDefault(…) { fresh[…] = open }`
// changed to always remember turns "folding" red; `project = (try? …) ?? nil` changed to `project = nil` turns "shape"
// red; `Int(d.rounded(.down))` changed to `Int(d.rounded())` turns "shape" red; `inWork` without
// `$0.subitems == 0 &&` turns "shape" red.
//
// The agenda keeper's ring stays: `afterwards` on the marking (known values, otherwise nil/null; the marking stays)
// and its words (test "afterwards"). Counter-tests, each RED: Agenda.swift `self.afterwards = nil` turns "shape" red; one
// word in upkeepAfterwardsWord changed turns "afterwards" red; upkeepAfterwards without outdated turns "shape" +
// "afterwards" red; web normUpkeep `afterwards: null` turns "shape" red; one word in UPKEEP_AFTERWARDS_WORD changed
// turns "afterwards" red.
//
// Run:  node --test web/test/agenda-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "agenda.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "Agenda.swift");
const HELPER_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Models", "DecodeHelpers.swift");
const JSON_VALUE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Models", "JSONValue.swift"); // DecodeHelpers also knows JSONValue
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-agenda-binding-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────
const CHAT = "c1";
const step = (o = {}) => ({ id: "s1", text: "Measure", note: "", status: "open", createdAt: 10, changedAt: 20, doneAt: null, ...o });
const agenda = (o = {}) => ({ chatId: CHAT, title: "Auth rework", description: "## Goal\n\nLogin via OIDC.", steps: [], version: 1, changedAt: 100, ...o });

// Load responses (`GET /api/chats/:id/agenda`): shape with defaults, steps without id/as a number drop out, an unknown
// status is open, doneAt only when done, changedAt falls back to createdAt, a foreign chat never applies, a missing one is the asked one.
const RESPONSES = [
  { agenda: agenda({
    version: 3, changedAt: 500, archived: 4,
    steps: [
      step({ id: "s1", text: "One", status: "in_work", note: "running since today" }),
      { text: "without id", status: "open" },
      step({ id: "s3", text: "Three", status: "finished" }),
      step({ id: "s4", text: "Four", status: "done", doneAt: 400 }),
      step({ id: "s5", text: "Five", status: "done" }),
      step({ id: "s6", text: "Six", status: "open", doneAt: 300 }),
      { id: "s7", text: "without times", status: "open", createdAt: 7 },
      5,
      step({ id: "s8", text: "Eight", status: "in_work" }),
    ],
  }), keepsAgenda: true },
  { agenda: { title: "without chatId", steps: [step()], version: 2, changedAt: 50 } },
  { agenda: agenda({ chatId: "c2" }), keepsAgenda: true },
  { agenda: { chatId: CHAT, version: 0 }, keepsAgenda: false },
  { agenda: agenda({ title: "  ", description: "\n\t ", steps: [], changedAt: 0 }) },
  { agenda: agenda({ steps: "broken", changedAt: "yesterday" }), keepsAgenda: "no" },
  // The tree: all fields, plus nonsense in every new field.
  { agenda: agenda({ steps: [
    step({ id: "s1", parent: null, depth: 0, status: "in_work", subitems: 2, done: 1, total: 2, project: { id: "p1", name: "Shop", color: "x" } }),
    step({ id: "s2", parent: "s1", depth: 1, status: "done", doneAt: 30, subitems: 0, done: 0, total: 0, project: null }),
    step({ id: "s3", parent: "s1", depth: 1, status: "open", note: "**Markdown**" }),
    step({ id: "s4", parent: "", depth: -2, subitems: "3", done: 2.9, total: true, project: { name: "without id" } }),
    step({ id: "s5", parent: 7, depth: 4.6, project: { id: "p2" } }),
    step({ id: "s6", project: "p3", depth: null }),
  ] }), keepsAgenda: true },
  // The agenda keeper's marking: both kinds, `prior` only with `status` and only a known status, an unknown kind and
  // nonsense read as no marking, a time <= 0 as unknown.
  { agenda: agenda({ steps: [
    step({ id: "s1", upkeep: { agentId: "w1-a9e0da", runId: "l1", at: 900, kind: "fresh", prior: "open", afterwards: "confirmed" } }),
    step({ id: "s2", status: "done", doneAt: 30, upkeep: { agentId: "w1-a9e0da", runId: "l2", at: 901, kind: "status", prior: "in_work", afterwards: "outdated" } }),
    step({ id: "s3", upkeep: { agentId: "a", runId: "l3", at: -5, kind: "status", prior: "finished", afterwards: "deleted" } }),
    step({ id: "s9", upkeep: { agentId: "a", runId: "l9", at: 5, kind: "status", prior: "open", afterwards: "corrected" } }),
    step({ id: "s10", upkeep: { agentId: "a", runId: "l10", at: 5, kind: "fresh", afterwards: "open" } }),
    step({ id: "s4", upkeep: { agentId: 7, runId: null, kind: "status" } }),
    step({ id: "s5", upkeep: { agentId: "a", runId: "l5", at: 1, kind: "erase" } }),
    step({ id: "s6", upkeep: "fresh" }),
    step({ id: "s7", upkeep: null }),
    step({ id: "s8" }),
  ] }), keepsAgenda: true },
];

// Version pairs: the higher version wins, the same version leaves the existing one, a foreign chat never applies.
const PAIRS = [
  [agenda({ version: 2 }), agenda({ version: 3, title: "fresh" })],
  [agenda({ version: 3 }), agenda({ version: 2, title: "old" })],
  [agenda({ version: 2 }), agenda({ version: 2, title: "equal" })],
  [agenda({ chatId: "c2", version: 9 }), agenda({ version: 1 })],
  [agenda({ version: 1 }), agenda({ chatId: "c2", version: 9 })],
  [null, agenda({ version: 1 })],
  [agenda({ chatId: "c2" }), null],
  [null, null],
];

// `harness/agenda` events against an existing state.
const STATE = agenda({ version: 4, steps: [step({ status: "in_work" })] });
const EVENTS = [
  { type: "harness", subtype: "agenda", chatId: CHAT, agenda: agenda({ version: 5, title: "fresh" }) },
  { type: "harness", subtype: "agenda", chatId: CHAT, agenda: agenda({ version: 3, title: "older" }) },
  { type: "harness", subtype: "agenda", chatId: "c2", agenda: agenda({ chatId: "c2", version: 9 }) },
  { type: "harness", subtype: "agenda", agenda: agenda({ version: 9 }) },
  { type: "harness", subtype: "agenda", chatId: CHAT, agenda: { title: "without chatId", version: 6, steps: [step({ id: "s2" })] } },
];

// Trees in pre-order, as the server sends them (the status of the parent points is the COMPUTED one), each with a memo note.
const point = (id, parent, depth, status, subitems = 0, o = {}) =>
  step({ id, parent, depth, text: id, status, subitems, done: 0, total: 0, project: null, ...o });
// t1 → t2 → t3 → t4 → t5 → t6: depth 5 sits on stage 3; plus a done subtree e1 and a leaf b1.
const DEEP = [
  point("t1", null, 0, "in_work", 2, { done: 1, total: 2 }),
  point("t2", "t1", 1, "open", 1, { total: 1 }),
  point("t3", "t2", 2, "open", 1, { total: 1 }),
  point("t4", "t3", 3, "open", 1, { total: 1 }),
  point("t5", "t4", 4, "open", 1, { total: 1 }),
  point("t6", "t5", 5, "open"),
  point("t7", "t1", 1, "done"),
  point("e1", null, 0, "done", 2, { done: 2, total: 2 }),
  point("e2", "e1", 1, "done"),
  point("e3", "e1", 1, "done"),
  point("b1", null, 0, "in_work"),
];
const TREES = [
  [DEEP, {}],
  [DEEP, { t3: false }],                 // collapsed middle point: t4, t5, t6 missing
  [DEEP, { t3: false, t5: true }],       // an open point under a collapsed one stays hidden
  [DEEP, { e1: true, t1: false }],       // deviation from the default in both directions
  [DEEP, { t6: true, b1: false, way: false }], // on a leaf and on unknown ids it means nothing
  [[point("x1", "missing", 2, "open"), point("x2", null, 0, "done", 1), point("x3", "x2", 1, "done")], { missing: false }],
  [[step({ id: "f1", status: "done" }), step({ id: "f2", status: "in_work" })], {}], // flat, older server
];
// Click sequences: [tree, memo note before, id of the clicked point] → memo note after.
const CLICKS = [
  [DEEP, {}, "t1"],
  [DEEP, { t1: false }, "t1"],
  [DEEP, {}, "e1"],
  [DEEP, { way: true, e1: true }, "t3"],
  [DEEP, { e1: true }, "t7"],
  [DEEP, { t3: false }, "t4"],           // a hidden point: no row, no click
];
const MEMO = [null, "", "broken", "[true]", "null", "5", '"s1"', '{"s1":true,"s2":"ja","s3":false,"":true,"s4":1,"s5":null}', '{"__proto__":true,"a":false}'];

const NOW = 1_800_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TIMES = [null, 0, NOW, NOW + 5000, NOW - 59_999, NOW - MIN, NOW - (HOUR - 1), NOW - HOUR,
  NOW - (DAY - 1), NOW - DAY, NOW - 2 * DAY, NOW - 40 * DAY];

function writeCases() {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify({ chatId: CHAT, responses: RESPONSES, pairs: PAIRS, state: STATE, events: EVENTS, now: NOW, times: TIMES,
    trees: TREES.map(([steps, deviation]) => [agenda({ steps }), deviation]), clicks: CLICKS.map(([steps, deviation, id]) => [agenda({ steps }), deviation, id]),
    memo: MEMO }));
  return file;
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
function runWeb(cases) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--lib", "es2022,dom"], { cwd: webDir, stdio: "pipe" }); // from web/: that is where tsc finds the Node types (core.ts reads process)
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import { agendaEmpty, effectiveAgenda, agendaFromEvent, sinceText, visibleRows, toggleFold, readDeviations, agendaProgress, agendaInWork, foldKey } from "./agenda.js";
import { normAgenda, AGENDA_STATUS, AGENDA_UPKEEP_AFTERWARDS } from "./api/agenda.js";
import { UPKEEP_AFTERWARDS_WORD } from "./agenda.js";
const f = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rowsOf = (a, deviation) => visibleRows(a?.steps ?? [], deviation).map((z) => [z.point.id, z.stage, z.open]);
const view = (a) => ({ agenda: a, empty: agendaEmpty(a), inWork: agendaInWork(a), progress: agendaProgress(a), rows: rowsOf(a, {}) });
const read = (raw) => (raw ? normAgenda(raw, f.chatId) : null);
const click = ([raw, deviation, id]) => { const a = read(raw); const z = visibleRows(a.steps, deviation).find((x) => x.point.id === id); return z ? toggleFold(deviation, z, a.steps) : null; };
console.log(JSON.stringify({
  status: AGENDA_STATUS,
  afterwards: AGENDA_UPKEEP_AFTERWARDS.map((d) => [d, UPKEEP_AFTERWARDS_WORD[d]]),
  responses: f.responses.map((r) => ({ ...view(effectiveAgenda(null, normAgenda(r.agenda, f.chatId), f.chatId)), keepsAgenda: r.keepsAgenda !== false })),
  pairs: f.pairs.map(([old, fresh]) => view(effectiveAgenda(read(old), read(fresh), f.chatId))),
  events: f.events.map((e) => view(effectiveAgenda(read(f.state), agendaFromEvent(e, f.chatId), f.chatId))),
  times: f.times.map((ms) => { const s = sinceText(ms, f.now); return s ? [s.key, s.n] : null; }),
  trees: f.trees.map(([raw, deviation]) => rowsOf(read(raw), deviation)),
  clicks: f.clicks.map(click),
  memo: f.memo.map((raw) => readDeviations(raw)),
  key: foldKey(f.chatId),
}));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, cases], { encoding: "utf8", env }).trim().split("\n").pop());
}

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
function runIos(cases) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const helper = fs.readFileSync(HELPER_SWIFT, "utf8");
  const jsonValue = fs.readFileSync(JSON_VALUE_SWIFT, "utf8");
  for (const [name, text] of [["Agenda.swift", source], ["DecodeHelpers.swift", helper], ["JSONValue.swift", jsonValue]]) {
    assert.deepEqual(text.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], `${name} imports only Foundation; otherwise it cannot be bound`);
  }
  assert.ok(!/\bL\(/.test(source.replace(/\/\/.*$/gm, "")), "Agenda.swift does not translate itself (no L(…)); the words are keys");
  const file = path.join(tmpDir(), "agenda.swift");
  fs.writeFileSync(file, `${jsonValue}
${helper.replace(/^import Foundation\n/m, "")}
${source.replace(/^import Foundation\n/m, "")}

// ── Driver (web/test/agenda-binding.test.mjs) ──
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let chatId = root["chatId"] as! String
func data(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o, options: [.fragmentsAllowed]) }
func read(_ o: Any?) -> Agenda? {
    guard let o, !(o is NSNull) else { return nil }
    return try? JSONDecoder().decode(Agenda.self, from: data(o))
}
func emptyOr(_ v: Double?) -> Any { v.map { $0 as Any } ?? NSNull() }
func rowsOf(_ a: Agenda?, _ deviation: [String: Bool]) -> [Any] {
    Agenda.visibleRows(a?.steps ?? [], deviations: deviation).map { [$0.point.id, $0.stage, $0.open] as [Any] }
}
func view(_ a: Agenda?) -> [String: Any] {
    let agendaOut: Any = a.map { a in
        ["chatId": a.chatId, "title": a.title, "description": a.description, "version": a.version, "changedAt": emptyOr(a.changedAt), "archived": a.archived,
         "steps": a.steps.map { s in
            ["id": s.id, "parent": s.parent.map { $0 as Any } ?? NSNull(), "depth": s.depth, "text": s.text, "note": s.note,
             "status": s.status, "subitems": s.subitems, "done": s.done, "total": s.total,
             "project": s.project.map { ["id": $0.id, "name": $0.name] as Any } ?? NSNull(),
             "createdAt": s.createdAt, "changedAt": s.changedAt, "doneAt": emptyOr(s.doneAt),
             "upkeep": s.upkeep.map { p in ["agentId": p.agentId, "runId": p.runId, "at": p.at, "kind": p.kind,
                                            "prior": p.prior.map { $0 as Any } ?? NSNull(),
                                            "afterwards": p.afterwards.map { $0 as Any } ?? NSNull()] as Any } ?? NSNull()] as [String: Any]
         }] as [String: Any]
    } ?? NSNull()
    let f = Agenda.progress(a)
    return ["agenda": agendaOut, "empty": Agenda.empty(a), "inWork": Agenda.inWork(a),
            "progress": ["done": f.done, "total": f.total], "rows": rowsOf(a, [:])]
}
var responses: [Any] = []
for r in root["responses"] as! [[String: Any]] {
    let response = try! JSONDecoder().decode(Agenda.Response.self, from: data(r))
    let snapshot = Agenda.loaded(Agenda.Snapshot(), response: response, chatId: chatId)
    var b = view(snapshot.agenda)
    b["keepsAgenda"] = snapshot.keepsAgenda
    responses.append(b)
}
let pairs: [Any] = (root["pairs"] as! [[Any]]).map { p in view(Agenda.effective(old: read(p[0]), fresh: read(p[1]), chatId: chatId)) }
let snapshot = Agenda.Snapshot(agenda: read(root["state"]), loaded: true)
let events: [Any] = (root["events"] as! [Any]).map { e in view(Agenda.afterEvent(snapshot, event: data(e), chatId: chatId).agenda) }
let now = (root["now"] as! NSNumber).doubleValue
let times: [Any] = (root["times"] as! [Any]).map { z in
    let ms: Double? = (z as? NSNumber)?.doubleValue
    return Agenda.sinceText(ms, now: now).map { [$0.key, $0.n] as [Any] } ?? NSNull()
}
let trees: [Any] = (root["trees"] as! [[Any]]).map { b in rowsOf(read(b[0]), b[1] as! [String: Bool]) }
let clicks: [Any] = (root["clicks"] as! [[Any]]).map { k in
    let a = read(k[0])!
    let deviation = k[1] as! [String: Bool]
    guard let z = Agenda.visibleRows(a.steps, deviations: deviation).first(where: { $0.point.id == k[2] as! String }) else { return NSNull() }
    return Agenda.toggleFold(deviation, row: z, steps: a.steps)
}
let memo: [Any] = (root["memo"] as! [Any]).map { Agenda.readDeviations($0 as? String) }
let afterwards: [Any] = Agenda.upkeepAfterwards.map { d in [d, Agenda.upkeepAfterwardsWord[d].map { $0 as Any } ?? NSNull()] as [Any] }
let outData: [String: Any] = ["status": Agenda.status, "afterwards": afterwards, "responses": responses, "pairs": pairs, "events": events, "times": times,
                          "trees": trees, "clicks": clicks, "memo": memo, "key": Agenda.foldKey(chatId)]
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "agenda");
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

test("status: the same three in the same order", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.status, web.status);
  assert.deepEqual(web.status, ["open", "in_work", "done"]);
});

// The ring stays: the same values of `afterwards` and per value the same explanation word (open: none); the values
// themselves are bound to the server by server/backend/test/agenda.test.js (8).
test("afterwards: the same values and the same explanation words", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.afterwards, web.afterwards);
  assert.deepEqual(web.afterwards.map(([d]) => d), ["open", "confirmed", "corrected", "outdated"]);
  assert.equal(web.afterwards[0][1], null, "open says nothing about it");
  assert.ok(web.afterwards.slice(1).every(([, w]) => typeof w === "string" && w.endsWith(" afterwards")), "every other value has a word");
});

test("shape: per load response the same agenda including tree fields, the same rows, the same empty/in work/progress, the same keepsAgenda", () => {
  const { web, ios } = both();
  assert.equal(web.responses.length, RESPONSES.length);
  for (let i = 0; i < RESPONSES.length; i++) assert.deepEqual(ios.responses[i], web.responses[i], `response ${i}: iOS deviates`);
  // The cases did not run empty: the mixed response carries all points with an id in the order of the plan.
  assert.deepEqual(web.responses[0].rows.map((z) => z[0]), ["s1", "s3", "s4", "s5", "s6", "s7", "s8"]);
  assert.deepEqual(web.responses[0].progress, { done: 2, total: 7 });
  assert.deepEqual(web.responses.map((a) => a.agenda?.chatId ?? null), [CHAT, CHAT, null, CHAT, CHAT, CHAT, CHAT, CHAT]);
  assert.deepEqual(web.responses.map((a) => a.empty), [false, false, true, true, true, false, false, false]);
  // The tree: every field arrived, nonsense fell back to the default; the same on BOTH sides (above), here against the expectation.
  const tree = web.responses[6].agenda.steps;
  assert.deepEqual(tree.map((s) => [s.id, s.parent, s.depth, s.subitems, s.done, s.total, s.project]), [
    ["s1", null, 0, 2, 1, 2, { id: "p1", name: "Shop" }],
    ["s2", "s1", 1, 0, 0, 0, null],
    ["s3", "s1", 1, 0, 0, 0, null],
    ["s4", null, 0, 0, 2, 0, null],
    ["s5", null, 4, 0, 0, 0, { id: "p2", name: "" }],
    ["s6", null, 0, 0, 0, 0, null],
  ]);
  assert.equal(tree[2].note, "**Markdown**");
  assert.equal(web.responses[6].inWork, false, "s1 is computed as \"in work\"; there is no leaf in work");
  // The agenda keeper's marking arrived, and only the readable one (against the expectation; both sides being equal is checked above).
  assert.deepEqual(web.responses[7].agenda.steps.map((s) => [s.id, s.upkeep]), [
    ["s1", { agentId: "w1-a9e0da", runId: "l1", at: 900, kind: "fresh", prior: null, afterwards: "confirmed" }],
    ["s2", { agentId: "w1-a9e0da", runId: "l2", at: 901, kind: "status", prior: "in_work", afterwards: "outdated" }],
    ["s3", { agentId: "a", runId: "l3", at: 0, kind: "status", prior: null, afterwards: null }],
    ["s9", { agentId: "a", runId: "l9", at: 5, kind: "status", prior: "open", afterwards: "corrected" }],
    ["s10", { agentId: "a", runId: "l10", at: 5, kind: "fresh", prior: null, afterwards: "open" }],
    ["s4", { agentId: "", runId: "", at: 0, kind: "status", prior: null, afterwards: null }],
    ["s5", null], ["s6", null], ["s7", null], ["s8", null],
  ]);
});

test("tree: the same visible rows with the same stage and the same fold state", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.trees, web.trees);
  const short = (rows) => rows.map(([id, stage, open]) => `${id}:${stage}${open ? "+" : ""}`);
  assert.deepEqual(short(web.trees[0]), ["t1:0+", "t2:1+", "t3:2+", "t4:3+", "t5:3+", "t6:3", "t7:1", "e1:0", "b1:0"], "depth 5 on stage 3, done subtree closed");
  assert.deepEqual(short(web.trees[1]), ["t1:0+", "t2:1+", "t3:2", "t7:1", "e1:0", "b1:0"], "collapsed middle point");
  assert.deepEqual(short(web.trees[2]), short(web.trees[1]), "open under collapsed stays hidden");
  assert.deepEqual(short(web.trees[3]), ["t1:0", "e1:0+", "e2:1", "e3:1", "b1:0"], "deviation from the default in both directions");
  assert.deepEqual(short(web.trees[4]), short(web.trees[0]), "on leaves and unknown ids a deviation means nothing");
  assert.deepEqual(short(web.trees[5]), ["x1:2", "x2:0"], "unknown parent point hides nothing");
  assert.deepEqual(short(web.trees[6]), ["f1:0", "f2:0"], "flat like an older server");
});

test("folding: the same memo note after every click, the same reading of the storage, the same key", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.clicks, web.clicks);
  assert.deepEqual(web.clicks, [{ t1: false }, {}, { e1: true }, { e1: true, t3: false }, { e1: true }, null]);
  assert.deepEqual(ios.memo, web.memo);
  assert.deepEqual(web.memo, [{}, {}, {}, {}, {}, {}, {}, { s1: true, s3: false }, { a: false }]);
  assert.equal(ios.key, web.key);
  assert.equal(web.key, `cbase-agenda-fold:${CHAT}`);
});

test("version: the same one applies when load response and event cross", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.pairs, web.pairs);
  assert.deepEqual(web.pairs.map((p) => p.agenda?.version ?? null), [3, 3, 2, 1, 1, 1, null, null]);
  assert.equal(web.pairs[2].agenda.title, "Auth rework", "same version: the existing one stays");
  assert.deepEqual(ios.events, web.events);
  assert.deepEqual(web.events.map((e) => e.agenda?.title), ["fresh", "Auth rework", "Auth rework", "Auth rework", "without chatId"]);
});

test("time: the same \"updated … ago\" text at every threshold", () => {
  const { web, ios } = both();
  assert.deepEqual(ios.times, web.times);
  assert.deepEqual(web.times.slice(4, 12), [["just now", 0], ["{n} min ago", 1], ["{n} min ago", 59], ["{n} h ago", 1],
    ["{n} h ago", 23], ["1 day ago", 1], ["{n} days ago", 2], ["{n} days ago", 40]]);
});
