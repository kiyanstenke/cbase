// Binding of the instance choice of a chat's git view: web/src/lib/bar-instance.ts (web, right chat bar) and
// mobile/CbaseMobile/Chat/BarInstance.swift (iOS, the chat's git sheet) are run on the SAME cases — tsc and `xcrun swiftc` —
// and must deliver the same: options, target (never chat AND instance), shown instance, foreign, hint, what stays remembered,
// the target's query, the choice after a tap and the fallback after an error. Both sides compile their sheet together with
// the code tab's choice sheet that they import (code-instance.ts / CodeInstance.swift). macOS only (xcrun; latch.json
// `onlyMacOS`).
//
// Run:  node --test web/test/bar-instance-binding.test.mjs
// Counter-test (which sabotage turns which test red; each ONE place in BarInstance.swift):
//   deleting the normalisation `if choice.identifier == ownIdentifier { return chatState(nil) }`          => red
//   `ownSignature` without the filter on the chat (every copy row counts)                                  => red
//   `selectedStatus` with `chatId: chat` instead of `chatId: nil` (chat and instance at once)              => red
//   the check "own copy without row" as `if false, let e = choice.own, …`                                  => red (case 1)
//   `hintBySituation` returns `.notReady` unchanged (branch `default: return h` for everything)            => red
//   (it runs per hint x field x situation: "clearAway -> removed" becomes "gone", ready again drops it,
//   "own" and "transient" stay)
// The signature carries the chat's binding (`chats.instance`, field `binding` per case) — an instance change in the head
// changes no copy row. The cases additionally run with every binding (main, "main" as text, two copies, whitespace) on a
// read list; "main" and whitespace must compute like no binding. In BarInstance.swift `guard let b = bindingOf(binding)`
// replaced by `guard let b = nil as String?` (iOS ignores the binding) turns it red (web and iOS differ).
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
const SOURCE_TS = path.join(webDir, "src", "lib", "bar-instance.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "BarInstance.swift");
const NEIGHBOR_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Code", "CodeInstance.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bar-instance-binding-")));

const P = "p1";
const C = "c1";
const H = `${P}/main`;
const K = (n) => `${P}/copy-${n}`;
const z = (name, state = "ready", chatId = "other") => ({ identifier: K(name), state, chatId });
const converted = (copies, o = {}) => ({ identifier: H, converted: true, ...(copies ? { copies } : {}), ...o });
const FIELDS = [
  null,
  { identifier: H, converted: false, copies: [z("k1", "ready", C), z("k2")] },
  converted(undefined),
  converted([]),
  converted([z("k2")]),
  converted([z("k1", "ready", C)]),
  converted([z("k1", "ready", C), z("k2")]),
  converted([z("k1", "ready", C), z("k2"), z("k3", "create", C)]),
  // A child chat works in copy k1 of its PARENT chat (no row carries its chatId, signature empty) —
  // with k1 its choice holds, without k1 (the fields above with only k2) it drops (hint "own").
  converted([z("k1", "ready", "parent"), z("k2")]),
  ...["create", "start", "recreate", "clearAway", "error", "relocation"].flatMap((state) => [
    converted([z("k1", "ready", C), z("k2", state)]),
    converted([z("k1", state, C), z("k2")]),
  ]),
  converted([z("k1", "ready", C), z("k2"), z("k2"), { identifier: "p2/copy-k4", state: "ready", chatId: C }, { identifier: "murks", state: "ready" }, { state: "ready" }]),
  converted([z("k1", "ready", C), { identifier: K("k2") }]),
  { identifier: "murks", converted: true, copies: [z("k1", "ready", C), z("k2")] },
  { identifier: "p2/main", converted: true, copies: [z("k1", "ready", C), z("k2")] },
];
const STATES = ["loaded", "loading", "error"];
const CHATS = [C, null, ""];
const OWN = [{ kind: "unknown" }, { kind: "main" }, { kind: "copy", name: "k1" }, { kind: "copy", name: "k9" }];
// The last two carry a binding (`#copy-<name>`).
const SIGNATURES = ["", K("k1"), `${K("k1")}|${K("k3")}`, "zz", "#copy-k2", `${K("k1")}#copy-k1`];
// The chat's binding (`chats.instance`) — the base cases run without (null), the extra cases on a read list with each.
const BINDINGS = ["main", "copy-k1", "copy-k2", " "];
const CHOICES = [
  null,
  ...SIGNATURES.flatMap((signature) => [
    { identifier: H, projectId: P, own: "k1", signature },
    { identifier: K("k2"), projectId: P, own: "k1", signature },
    { identifier: K("k2"), projectId: P, own: null, signature },
    { identifier: K("k1"), projectId: P, own: null, signature },
  ]),
  { identifier: K("k1"), projectId: P, own: "k1", signature: K("k1") },
  { identifier: H, projectId: P, own: null, signature: "" },
  { identifier: K("k5"), projectId: P, own: "k1", signature: K("k1") },
  { identifier: "p2/copy-k1", projectId: "p2", own: "k1", signature: K("k1") },
  { identifier: "murks", projectId: P, own: "k1", signature: K("k1") },
];
const ERROR = [
  { code: "UNKNOWN_INSTANCE", identifier: null }, { code: "UNKNOWN_INSTANCE", identifier: K("k2") }, { code: "UNKNOWN_INSTANCE", identifier: K("k3") },
  { code: "INSTANCE_INVALID", identifier: "" }, { code: "COPY_LOCKED", identifier: null }, { code: null, identifier: null },
];
// The hints the bar tracks on every read list (`barHintBySituation`) — and those it leaves alone.
const HINTS = [
  null, { kind: "gone", name: "k2" }, { kind: "gone", name: "" }, { kind: "own" },
  { kind: "not-ready", name: "k2", state: "clearAway" }, { kind: "not-ready", name: "k2", state: "error" },
  { kind: "not-ready", name: "k3", state: "clearAway" }, { kind: "transient", name: "k2", state: "start" },
];
const CASES = [];
for (const field of FIELDS) for (const situation of STATES) for (const chatId of CHATS) for (const own of OWN) for (const choice of CHOICES) {
  CASES.push({ field, situation, chatId, binding: null, own, choice });
}
const BASE_CASES = CASES.length;
for (const field of FIELDS) for (const binding of BINDINGS) for (const own of OWN) for (const choice of CHOICES) {
  CASES.push({ field, situation: "loaded", chatId: C, binding, own, choice });
}
// The output of both drivers is several MB — execFileSync's default (1 MB) is not enough.
const BUFFER = 128 * 1024 * 1024;

function runWeb(file) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import { barGitChoice, selectInBar, afterErrorBar, ownSignature, barHintBySituation } from "./bar-instance.js";
const { cases, error, p, hints, fields, states } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ownOf = (e) => (e.kind === "unknown" ? undefined : e.kind === "main" ? null : e.name);
const hint = (h) => (h ? { kind: h.kind, ...(h.kind === "own" ? {} : { name: h.name }), ...(h.state !== undefined ? { state: h.state } : {}) } : null);
const choice = (w) => (w ? { identifier: w.identifier, projectId: w.projectId, own: w.own ?? null, signature: w.signature } : null);
const results = cases.map((f) => {
  const s = barGitChoice({ projectId: p, field: f.field ?? undefined, situation: f.situation, chatId: f.chatId, binding: f.binding, ownFromServer: ownOf(f.own), choice: f.choice });
  const taps = [...s.options.map((o) => o.identifier), "${P}/copy-unknown"].map((k) => (f.chatId ? choice(selectInBar(s, k, { projectId: p, field: f.field ?? undefined, chatId: f.chatId, binding: f.binding })) : null));
  return {
    options: s.options.map((o) => ({ identifier: o.identifier, kind: o.kind, name: o.name, own: o.own })),
    target: { chatId: s.target.chatId, instance: s.target.instance },
    query: [...(s.target.chatId ? [["chat", s.target.chatId]] : []), ...(s.target.instance ? [["instance", s.target.instance]] : [])],
    shown: s.shown, shownName: s.shownName, foreign: s.foreign, hint: hint(s.hint), remember: choice(s.remember),
    signature: ownSignature(f.field ?? undefined, f.chatId, f.binding),
    taps,
    afterError: error.map((e) => hint(afterErrorBar(s.remember, e.identifier === null ? { code: e.code } : { code: e.code, identifier: e.identifier }))),
  };
});
const bySituation = hints.flatMap((h) => fields.flatMap((f) => states.map((l) => hint(barHintBySituation(h, f ?? undefined, l)))));
console.log(JSON.stringify({ results, bySituation }));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, file], { encoding: "utf8", env, maxBuffer: BUFFER }).trim().split("\n").pop());
}

function runIos(file) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const neighbor = fs.readFileSync(NEIGHBOR_SWIFT, "utf8");
  for (const [name, q] of [["BarInstance.swift", source], ["CodeInstance.swift", neighbor]]) {
    assert.deepEqual(q.split("\n").filter((row) => /^import /.test(row)), ["import Foundation"], `${name} imports only Foundation — otherwise it cannot be bound`);
    assert.ok(!/\bL\(/.test(q.replace(/\/\/.*$/gm, "")), `${name} does not translate itself (no L(…))`);
  }
  const swift = path.join(tmpDir(), "binding.swift");
  fs.writeFileSync(swift, `import Foundation
${neighbor.replace(/^import Foundation$/m, "")}
${source.replace(/^import Foundation$/m, "")}

func text(_ v: Any?) -> String? { v as? String }
func list(_ v: Any?) -> [[String: Any]] { v as? [[String: Any]] ?? [] }
func empty(_ v: Any?) -> Any { v ?? NSNull() }
func fieldOf(_ v: Any?) -> CodeInstance.Field? {
    guard let d = v as? [String: Any] else { return nil }
    let copies: [CodeInstance.CopyRow]? = d["copies"] == nil ? nil : list(d["copies"]).map {
        CodeInstance.CopyRow(identifier: text($0["identifier"]), state: text($0["state"]), chatId: text($0["chatId"]))
    }
    return CodeInstance.Field(identifier: text(d["identifier"]), converted: (d["converted"] as? NSNumber)?.boolValue, copies: copies)
}
func ownOf(_ v: Any?) -> BarInstance.Own {
    let d = v as? [String: Any] ?? [:]
    switch d["kind"] as? String {
    case "main": return .main
    case "copy": return .copy(d["name"] as? String ?? "")
    default: return .unknown
    }
}
func choiceOf(_ v: Any?) -> BarInstance.Choice? {
    guard let d = v as? [String: Any] else { return nil }
    return BarInstance.Choice(identifier: d["identifier"] as! String, projectId: d["projectId"] as! String, own: text(d["own"]), signature: d["signature"] as! String)
}
func choice(_ w: BarInstance.Choice?) -> Any {
    guard let w else { return NSNull() }
    return ["identifier": w.identifier, "projectId": w.projectId, "own": empty(w.own), "signature": w.signature] as [String: Any]
}
func hint(_ h: BarInstance.Hint?) -> Any {
    switch h {
    case .none: return NSNull()
    case .gone(let n): return ["kind": "gone", "name": n]
    case .notReady(let n, let z): return ["kind": "not-ready", "name": n, "state": z]
    case .transient(let n, let z): return ["kind": "transient", "name": n, "state": z]
    case .own: return ["kind": "own"]
    }
}
func hintOf(_ v: Any?) -> BarInstance.Hint? {
    guard let d = v as? [String: Any] else { return nil }
    let n = d["name"] as? String ?? ""
    switch d["kind"] as? String {
    case "gone": return .gone(name: n)
    case "not-ready": return .notReady(name: n, state: d["state"] as? String ?? "")
    case "transient": return .transient(name: n, state: d["state"] as? String ?? "")
    case "own": return .own
    default: return nil
    }
}
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let p = root["p"] as! String
var results: [Any] = []
for f in list(root["cases"]) {
    let field = fieldOf(f["field"])
    let chatId = text(f["chatId"])
    let binding = text(f["binding"])
    let s = BarInstance.snapshot(projectId: p, field: field, situation: CodeInstance.ListSituation(rawValue: f["situation"] as! String)!, chatId: chatId,
                                binding: binding, ownFromServer: ownOf(f["own"]), choice: choiceOf(f["choice"]))
    let taps: [Any] = (s.options.map(\\.identifier) + ["${P}/copy-unknown"]).map { k in
        guard let chatId, !chatId.isEmpty else { return NSNull() }
        return choice(BarInstance.select(s, identifier: k, projectId: p, field: field, chatId: chatId, binding: binding))
    }
    let nf: [Any] = list(root["error"]).map { hint(BarInstance.afterError(s.remember, code: text($0["code"]), identifier: text($0["identifier"]))) }
    results.append([
        "options": s.options.map { ["identifier": $0.identifier, "kind": $0.kind, "name": $0.name, "own": $0.own] as [String: Any] },
        "target": ["chatId": empty(s.target.chatId), "instance": empty(s.target.instance)] as [String: Any],
        "query": BarInstance.query(s.target).map { [$0.name, $0.value ?? ""] },
        "shown": empty(s.shown), "shownName": empty(s.shownName), "foreign": s.foreign, "hint": hint(s.hint), "remember": choice(s.remember),
        "signature": BarInstance.ownSignature(field, chatId: chatId, binding: binding),
        "taps": taps,
        "afterError": nf,
    ] as [String: Any])
}
var bySituation: [Any] = []
for h in (root["hints"] as! [Any]) {
    for f in (root["fields"] as! [Any]) {
        for l in (root["states"] as! [String]) {
            bySituation.append(hint(BarInstance.hintBySituation(hintOf(h), field: fieldOf(f), situation: CodeInstance.ListSituation(rawValue: l)!)))
        }
    }
}
print(String(data: try! JSONSerialization.data(withJSONObject: ["results": results, "bySituation": bySituation]), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "binding");
  execFileSync("xcrun", ["swiftc", "-O", swift, "-o", bin], { stdio: "pipe" });
  return JSON.parse(execFileSync(bin, [file], { encoding: "utf8", maxBuffer: BUFFER }).trim().split("\n").pop());
}

test("Binding: web and iOS compute a chat's git-view instance choice alike — options, target, hint, remembering, tap, fallback", () => {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify({ cases: CASES, error: ERROR, p: P, hints: HINTS, fields: FIELDS, states: STATES }));
  const web = runWeb(file);
  const ios = runIos(file);
  assert.equal(web.results.length, CASES.length);
  assert.equal(ios.results.length, CASES.length);
  // The cases must hit every situation of the computation — otherwise the binding measures nothing.
  const kind = (a) => a.hint?.kind ?? null;
  for (const [what, ok] of [
    ["a choice with a menu", web.results.some((a) => a.options.length > 1)],
    ["a chosen copy (instance=)", web.results.some((a) => a.target.instance && !a.target.chatId)],
    ["the chosen main (no parameter)", web.results.some((a) => a.foreign && !a.target.instance && !a.target.chatId)],
    ["fallback \"way\"", web.results.some((a) => kind(a) === "gone")],
    ["fallback \"not-ready\"", web.results.some((a) => kind(a) === "not-ready")],
    ["\"transient\" holds", web.results.some((a) => kind(a) === "transient" && a.remember)],
    ["move in/out \"own\"", web.results.some((a) => kind(a) === "own")],
    // The own copy without a row with the SAME signature (child chat) — if the choice drops there on one side only, it shows here.
    ["child chat: own copy without a row", CASES.some((f, i) => f.situation === "loaded" && f.chatId === C && f.choice?.projectId === P && f.choice.own === "k1" && f.choice.signature === "" && !(f.field?.copies ?? []).some((zz) => zz.identifier === K("k1")) && (f.field?.copies ?? []).every((zz) => zz.chatId !== C) && kind(web.results[i]) === "own")],
    ["child chat: own copy of the parent chat holds", CASES.some((f, i) => f.situation === "loaded" && f.chatId === C && f.choice?.identifier === K("k2") && f.choice.own === "k1" && f.choice.signature === "" && (f.field?.copies ?? []).some((zz) => zz.identifier === K("k1") && zz.chatId === "parent") && web.results[i].remember)],
    ["a tap remembers a choice", web.results.some((a) => a.taps.some((w) => w))],
    ["an error drops the choice", web.results.some((a) => a.afterError.some((h) => h))],
    // The chat switches in the head from main to the chosen copy k2 — no copy row changes, the
    // choice (remembered without binding) drops anyway, with hint "own".
    ["instance change without a copy row drops the choice", CASES.some((f, i) => f.situation === "loaded" && f.chatId === C && f.binding === "copy-k2" && f.choice?.identifier === K("k2") && f.choice.own === null && f.choice.signature === "" && (f.field?.copies ?? []).every((zz) => zz.chatId !== C) && kind(web.results[i]) === "own" && !web.results[i].remember)],
    ["a choice with a binding holds as long as the binding stays", CASES.some((f, i) => f.binding === "copy-k2" && f.choice?.signature === "#copy-k2" && web.results[i].remember)],
    ["a tap remembers the binding in the signature", web.results.some((a, i) => CASES[i].binding === "copy-k1" && a.taps.some((w) => w?.signature.endsWith("#copy-k1")))],
  ]) assert.ok(ok, `no case: ${what}`);
  // "main" (and an empty text) is no binding: the same answer as without.
  const key = (f) => JSON.stringify([f.field, f.situation, f.chatId, f.own, f.choice]);
  const without = new Map(CASES.slice(0, BASE_CASES).map((f, i) => [key(f), i]));
  let compared = 0;
  for (let i = BASE_CASES; i < CASES.length; i++) {
    if (CASES[i].binding !== "main" && CASES[i].binding !== " ") continue;
    assert.deepEqual(web.results[i], web.results[without.get(key(CASES[i]))], `binding ${JSON.stringify(CASES[i].binding)} computes differently from none: case ${i}`);
    compared++;
  }
  assert.ok(compared > 0, "no case with binding \"main\"");
  for (const a of web.results) assert.ok(!(a.target.chatId && a.target.instance), "chat and instance at once");
  for (let i = 0; i < CASES.length; i++) assert.deepEqual(ios.results[i], web.results[i], `case ${i}: ${JSON.stringify(CASES[i])}`);
  // The hint of a dropped choice follows the list alike on web and iOS — and the cases hit every answer.
  assert.equal(web.bySituation.length, HINTS.length * FIELDS.length * STATES.length);
  const nl = new Set(web.bySituation.map((h) => h?.kind ?? null));
  for (const a of ["gone", "not-ready", "own", "transient", null]) assert.ok(nl.has(a), `barHintBySituation never yields ${a}`);
  const start = HINTS.findIndex((h) => h?.kind === "not-ready" && h.state === "clearAway" && h.name === "k2");
  const withoutK2 = FIELDS.findIndex((f) => f?.converted === true && Array.isArray(f.copies) && f.copies.length && !f.copies.some((x) => x.identifier === K("k2")));
  assert.deepEqual(web.bySituation[(start * FIELDS.length + withoutK2) * STATES.length + STATES.indexOf("loaded")], { kind: "gone", name: "k2" }, "clearAway → removed does not become \"way\"");
  assert.deepEqual(ios.bySituation, web.bySituation, "barHintBySituation: web and iOS track the hint differently");
});
