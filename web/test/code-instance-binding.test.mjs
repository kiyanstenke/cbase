// Binding of the instance choice of the Code tab: web/src/lib/code-instance.ts (web) and mobile/CbaseMobile/Code/CodeInstance.swift
// (iOS) are executed on the SAME cases (tsc and `xcrun swift`) and must produce the same choice (buttons, identifier, parameter,
// copy, hint, waiting, remembering), the same fallback after an error and the same query. The real states (create, start,
// recreate, clearAway, error) and `holdFallback` (per case with a shown copy or main, with and without unsaved changes) run along;
// so do the reason of a "held" (also the last held one, via a held display in SHOWN) and `hintBySituation` per hint x field x
// situation, including "clearAway -> removed" and "held during clearAway". macOS only (xcrun; latch.json `onlyMacOS`).
//
// Run:  node --test web/test/code-instance-binding.test.mjs
// COUNTER-TESTS: in CodeInstance.swift drop `k.state == "ready"` (every copy becomes a choice) => red; the fallback "not ready" as
// "gone" => red; `transient` without "start" => red; `holdFallback` without the check `unsaved > 0` => red; `fallbackBySituation`
// without "row gone => .gone" (passes `.notReady` on) => red; `holdFallback` without the recourse to the last held reason => red.
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
const SOURCE_TS = path.join(webDir, "src", "lib", "code-instance.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Code", "CodeInstance.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-code-instance-binding-")));

const P = "p1";
const k = (name, state = "ready") => ({ identifier: `${P}/copy-${name}`, state });
const FIELDS = [
  null,
  { identifier: `${P}/main`, converted: false, copies: [k("k1")] },
  { identifier: `${P}/main`, converted: true },
  { identifier: `${P}/main`, converted: true, copies: [] },
  { identifier: `${P}/main`, converted: true, copies: [k("k1")] },
  { identifier: `${P}/main`, converted: true, copies: [k("k1"), k("k2", "paused"), k("k3"), k("k1"), { identifier: "p2/copy-x", state: "ready" }, { identifier: "garbage", state: "ready" }, { state: "ready" }] },
  { identifier: `${P}/main`, converted: true, copies: [k("k2", "starts")] },
  // The real states (store/project-instances.js), next to a ready copy and alone.
  ...["create", "start", "recreate", "clearAway", "error"].flatMap((z) => [
    { identifier: `${P}/main`, converted: true, copies: [k("k1"), k("k2", z)] },
    { identifier: `${P}/main`, converted: true, copies: [k("k1", z), k("k2", z)] },
  ]),
  { identifier: `${P}/main`, converted: false, copies: [k("k1", "start")] },
  { identifier: `${P}/main`, converted: true, copies: [{ identifier: `${P}/copy-k1` }] },
  { identifier: "garbage", converted: true, copies: [k("k1")] },
  { identifier: `${P}/copy-k1`, converted: true, copies: [k("k1")] },
];
const REMEMBERED = [null, "", `${P}/main`, `${P}/copy-k1`, `${P}/copy-k2`, `${P}/copy-k3`, `${P}/copy-away`, "p2/copy-k1", "garbage", `${P}/`, `${P}/copy-`];
const STATES = ["loading", "error", "loaded"];
// What the editor currently shows: a ready copy, main, a held choice without a copy (waits).
const SHOWN = [
  { field: { identifier: `${P}/main`, converted: true, copies: [k("k1"), k("k3")] }, remembered: `${P}/copy-k1`, situation: "loaded" },
  { field: { identifier: `${P}/main`, converted: true, copies: [k("k1")] }, remembered: null, situation: "loaded" },
  { field: null, remembered: `${P}/copy-k1`, situation: "loading" },
  // An already HELD display (k1 in clearAway): its reason stays if the new choice names none.
  { field: { identifier: `${P}/main`, converted: true, copies: [k("k1")] }, remembered: `${P}/copy-k1`, situation: "loaded",
    hold: { field: { identifier: `${P}/main`, converted: true, copies: [k("k1", "clearAway")] }, remembered: `${P}/copy-k1`, situation: "loaded" } },
];
// The hints that `hintBySituation` tracks on every list, and those it leaves alone.
const HINTS = [
  null,
  { kind: "gone", name: "k1" }, { kind: "gone", name: "" },
  { kind: "not-ready", name: "k1", state: "clearAway" }, { kind: "not-ready", name: "k2", state: "clearAway" },
  { kind: "not-ready", name: "k2", state: "error" }, { kind: "not-ready", name: "k3", state: "" },
  { kind: "transient", name: "k2", state: "start" }, { kind: "unchecked", name: "k1" },
  { kind: "held", name: "k1", reason: { kind: "not-ready", name: "k1", state: "clearAway" } }, { kind: "held", name: "k1", reason: null },
];
const CASES = [];
for (const field of FIELDS) for (const remembered of REMEMBERED) for (const situation of STATES) CASES.push({ field, remembered, situation });
const ERROR = [
  { code: "UNKNOWN_INSTANCE", identifier: null }, { code: "UNKNOWN_INSTANCE", identifier: `${P}/copy-k1` },
  { code: "UNKNOWN_INSTANCE", identifier: `${P}/copy-k3` }, { code: "COPY_LOCKED", identifier: null }, { code: null, identifier: null },
];
// The output of both drivers is several MB (`hold` per case); the default of execFileSync (1 MB) is not enough.
const BUFFER = 64 * 1024 * 1024;
const PARTS = ["p1/main", "a/b/c", "/x", "x/", "", "no", "p/copy-", "p/copy-a-b"];

function runWeb(file) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import { selectInstance, afterError, holdFallback, hintBySituation, identifierParts, copyNameOf, rememberKey } from "./code-instance.js";
const { cases, error, parts, p, shown, hints, fields, states } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const displayed = shown.map((f) => {
  const a = selectInstance(p, f.field, f.remembered, f.situation);
  return f.hold ? holdFallback(a, selectInstance(p, f.hold.field, f.hold.remembered, f.hold.situation), 1) : a;
});
const norm = (w) => w && ({ options: w.options, identifier: w.identifier, param: w.param, copy: w.copy, hint: w.hint, waiting: w.waiting, remember: w.remember, query: w.param ? [["instance", w.param]] : [] });
const results = cases.map((f) => {
  const w = selectInstance(p, f.field ?? undefined, f.remembered, f.situation);
  return { choice: norm(w), afterError: error.map((e) => norm(afterError(w, e.identifier === null ? { code: e.code } : { code: e.code, identifier: e.identifier }))),
    hold: displayed.flatMap((a) => [0, 1, 3].map((n) => norm(holdFallback(a, w, n)))) };
});
const bySituation = hints.flatMap((h) => fields.flatMap((f) => states.map((l) => hintBySituation(h, f ?? undefined, l))));
console.log(JSON.stringify({ results, bySituation, parts: parts.map((t) => [identifierParts(t), copyNameOf(t)]), merk: rememberKey(p) }));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, file], { encoding: "utf8", env, maxBuffer: BUFFER }).trim().split("\n").pop());
}

function runIos(file) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  assert.deepEqual(source.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "CodeInstance.swift imports only Foundation, otherwise it cannot be bound");
  assert.ok(!/\bL\(/.test(source.replace(/\/\/.*$/gm, "")), "CodeInstance.swift does not translate itself (no L(...))");
  const swift = path.join(tmpDir(), "binding.swift");
  fs.writeFileSync(swift, `${source}

func text(_ v: Any?) -> String? { v as? String }
func list(_ v: Any?) -> [[String: Any]] { v as? [[String: Any]] ?? [] }
func empty(_ v: Any?) -> Any { v ?? NSNull() }
func fieldOf(_ v: Any?) -> CodeInstance.Field? {
    guard let d = v as? [String: Any] else { return nil }
    let copies: [CodeInstance.CopyRow]? = d["copies"] == nil ? nil : list(d["copies"]).map { CodeInstance.CopyRow(identifier: text($0["identifier"]), state: text($0["state"])) }
    return CodeInstance.Field(identifier: text(d["identifier"]), converted: (d["converted"] as? NSNumber)?.boolValue, copies: copies)
}
func hint(_ h: CodeInstance.Hint?) -> Any {
    switch h {
    case .none: return NSNull()
    case .gone(let n): return ["kind": "gone", "name": n]
    case .notReady(let n, let z): return ["kind": "not-ready", "name": n, "state": z]
    case .transient(let n, let z): return ["kind": "transient", "name": n, "state": z]
    case .unchecked(let n): return ["kind": "unchecked", "name": n]
    case .held(let n, let g): return ["kind": "held", "name": n, "reason": hint(g)]
    }
}
func hintOf(_ v: Any?) -> CodeInstance.Hint? {
    guard let d = v as? [String: Any] else { return nil }
    let n = d["name"] as? String ?? ""
    switch d["kind"] as? String {
    case "gone": return .gone(name: n)
    case "not-ready": return .notReady(name: n, state: d["state"] as? String ?? "")
    case "transient": return .transient(name: n, state: d["state"] as? String ?? "")
    case "unchecked": return .unchecked(name: n)
    case "held": return .held(name: n, reason: hintOf(d["reason"]))
    default: return nil
    }
}
func norm(_ w: CodeInstance.Choice?) -> Any {
    guard let w else { return NSNull() }
    return ["options": w.options.map { ["identifier": $0.identifier, "kind": $0.kind, "name": $0.name] }, "identifier": empty(w.identifier), "param": empty(w.param),
            "copy": empty(w.copy), "hint": hint(w.hint), "waiting": w.waiting, "remember": empty(w.remember),
            "query": CodeInstance.query(w.param).map { [$0.name, $0.value ?? ""] }] as [String: Any]
}
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let p = root["p"] as! String
let displayed: [CodeInstance.Choice] = list(root["shown"]).map {
    let a = CodeInstance.select(projectId: p, field: fieldOf($0["field"]), remembered: text($0["remembered"]), situation: CodeInstance.ListSituation(rawValue: $0["situation"] as! String)!)
    guard let h = $0["hold"] as? [String: Any] else { return a }
    let fresh = CodeInstance.select(projectId: p, field: fieldOf(h["field"]), remembered: text(h["remembered"]), situation: CodeInstance.ListSituation(rawValue: h["situation"] as! String)!)
    return CodeInstance.holdFallback(displayed: a, fresh: fresh, unsaved: 1)
}
var results: [Any] = []
for f in list(root["cases"]) {
    let w = CodeInstance.select(projectId: p, field: fieldOf(f["field"]), remembered: text(f["remembered"]), situation: CodeInstance.ListSituation(rawValue: f["situation"] as! String)!)
    let nf: [Any] = list(root["error"]).map { norm(CodeInstance.afterError(w, code: text($0["code"]), identifier: text($0["identifier"]))) }
    let hold: [Any] = displayed.flatMap { a in [0, 1, 3].map { norm(CodeInstance.holdFallback(displayed: a, fresh: w, unsaved: $0)) } }
    results.append(["choice": norm(w), "afterError": nf, "hold": hold] as [String: Any])
}
let parts: [Any] = (root["parts"] as! [String]).map { t in
    let kt: Any = CodeInstance.identifierParts(t).map { ["projectId": $0.projectId, "instance": $0.instance] } ?? NSNull()
    return [kt, empty(CodeInstance.copyNameOf(t))] as [Any]
}
var bySituation: [Any] = []
for h in (root["hints"] as! [Any]) {
    for f in (root["fields"] as! [Any]) {
        for l in (root["states"] as! [String]) {
            bySituation.append(hint(CodeInstance.hintBySituation(hintOf(h), field: fieldOf(f), situation: CodeInstance.ListSituation(rawValue: l)!)))
        }
    }
}
let result: [String: Any] = ["results": results, "bySituation": bySituation, "parts": parts, "merk": CodeInstance.rememberKey(p)]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "binding");
  execFileSync("xcrun", ["swiftc", "-O", swift, "-o", bin], { stdio: "pipe" });
  return JSON.parse(execFileSync(bin, [file], { encoding: "utf8", maxBuffer: BUFFER }).trim().split("\n").pop());
}

test("binding: web and iOS compute the instance choice of the Code tab the same: choice, fallback after error, query, identifiers", () => {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify({ cases: CASES, error: ERROR, parts: PARTS, p: P, shown: SHOWN, hints: HINTS, fields: FIELDS, states: STATES }));
  const web = runWeb(file);
  const ios = runIos(file);
  assert.equal(web.results.length, CASES.length);
  assert.ok(web.results.some((a) => a.choice.param), "no case chooses a copy; the binding measures nothing");
  assert.ok(web.results.some((a) => a.choice.hint?.kind === "not-ready") && web.results.some((a) => a.choice.waiting), "fallback and waiting are missing in the cases");
  assert.ok(web.results.some((a) => a.choice.hint?.kind === "transient" && a.choice.param), "no case holds a transiently not ready copy");
  assert.ok(web.results.some((a) => a.hold.some((h) => h.hint?.kind === "held")), "no case holds a fallback with unsaved changes");
  // "held during clearAway" (reason not-ready/clearAway), "gone" after removal, and the last held reason.
  const reasons = web.results.flatMap((a) => a.hold.map((h) => h.hint?.kind === "held" ? JSON.stringify(h.hint.reason) : null)).filter(Boolean);
  for (const g of [{ kind: "not-ready", name: "k1", state: "clearAway" }, { kind: "gone", name: "k1" }]) {
    assert.ok(reasons.includes(JSON.stringify(g)), `no case holds with the reason ${JSON.stringify(g)}`);
  }
  // "clearAway -> removed": not-ready(k1, clearAway) on a list without k1 becomes "gone"; ready again drops it.
  assert.equal(web.bySituation.length, HINTS.length * FIELDS.length * STATES.length);
  const kinds = new Set(web.bySituation.map((h) => h?.kind ?? null));
  for (const kind of ["gone", "not-ready", null]) assert.ok(kinds.has(kind), `hintBySituation never returns ${kind}; the cases measure nothing`);
  assert.deepEqual(ios.bySituation, web.bySituation, "hintBySituation: web and iOS track the hint differently");
  for (let i = 0; i < CASES.length; i++) assert.deepEqual(ios.results[i], web.results[i], `case ${i}: ${JSON.stringify(CASES[i])}`);
  assert.deepEqual(ios.parts, web.parts);
  assert.equal(ios.kept, web.kept);
});
