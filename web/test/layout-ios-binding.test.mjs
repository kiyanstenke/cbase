// A project's layout on the iPhone: the same computation as on the web, bound through the SAME fixture set.
//
// `mobile/CbaseMobile/Code/ProjectLayout.swift` is the Swift twin of `web/src/lib/project-layout.ts`. If it computed
// differently, the preview on the iPhone would show a different final tree than the upload then builds — a file would
// silently land elsewhere or be missing. No UI test covers this: a swapped target path looks the same in the list as the right one.
//
// Design of `wfe-ios-binding.test.mjs`: the Swift file is read as a WHOLE (plain Foundation), extended by a driver and
// REALLY executed with `xcrun swift` — against every case in `server/backend/test/fixtures/layout-plan/` and its
// expectation, field by field (the same expectation `project-layout-plan.test.mjs` holds against the web). Without the
// toolchain the test fails LOUDLY; on Linux the file does not run at all (`onlyMacOS` in tools/check/latch.json).
//
// Counter-test: the built-in sabotage swaps two target paths of an expectation. Run against the Swift code: `targetOf`
// with the SHORTEST prefix => four cases red (child-from-moved-parent-folder, longest-prefix, steps-and-names,
// leave-out-in-parent); `find` taking the LAST instead of the first of two nodes on one path => "same-names" red
// (only there do two nodes lie on one path).
//
// Run:  node --test web/test/layout-ios-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Code", "ProjectLayout.swift");
const FIX = path.join(repo, "server", "backend", "test", "fixtures", "layout-plan");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

const rules = JSON.parse(fs.readFileSync(path.join(FIX, "_rules.json"), "utf8"));
const cases = fs.readdirSync(FIX).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8")));

const DRIVER = String.raw`

// ── Driver (layout-ios-binding.test.mjs) ──
struct StepOne: Decodable { let kind: String; let from: String?; let to: String?; let path: String?
  enum CodingKeys: String, CodingKey { case kind, from, to, path } }
struct FileOne: Decodable { let rel: String; let size: Int }
struct SelectionOne: Decodable { let seq: Int; let kind: String; let name: String; let files: [FileOne] }
struct TargetOne: Decodable { let source: Int; let origin: String }
struct FallOne: Decodable {
    let name: String; let mode: String
    let selection: [SelectionOne]?; let gitFiles: [String: String]?; let tree: [LayoutNode]?
    let steps: [StepOne]; let targets: [TargetOne]
}
struct Input: Decodable { let rules: LayoutRules; let cases: [FallOne] }
struct TargetFrom: Encodable {
    let source: Int; let origin: String; let target: String??
    enum K: String, CodingKey { case source, origin, target }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(source, forKey: .source); try c.encode(origin, forKey: .origin)
        if let z = target { try c.encode(z, forKey: .target) }
    }
}
struct OutData: Encodable {
    let name: String
    var tree: [LayoutNode]? = nil; var hints: [LayoutNotice]? = nil; var omitted: Int? = nil; var upload: [String: [String]]? = nil
    let finalTree: [LayoutNode]; let mapping: [String: [MappingEntry]]; let finalMapping: FinalMapping
    let codeRepos: [String]; let repos: [String]; let error: [LayoutNotice]; let warnings: [LayoutNotice]
    let targets: [TargetFrom]
}
let raw = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let one = try! JSONDecoder().decode(Input.self, from: raw)
let enc = JSONEncoder()
for f in one.cases {
    var tree = f.tree ?? []
    var outData: ProjectLayout.SelectionTree? = nil
    if let a = f.selection {
        let r = ProjectLayout.treeFromSelection(a.map { .init(seq: $0.seq, kind: $0.kind, name: $0.name, files: $0.files.map { .init(rel: $0.rel, size: $0.size) }) }, one.rules, f.gitFiles ?? [:])
        outData = r; tree = r.node
    }
    let steps: [LayoutStep] = f.steps.map { s in
        switch s.kind {
        case "move": return .move(from: s.from ?? "", to: s.to ?? "")
        case "leaveOut": return .leaveOut(path: s.path ?? "")
        case "code-repo": return .codeRepo(path: s.path ?? "")
        default: return .codeRepoFrom(path: s.path ?? "")
        }
    }
    let plan = ProjectLayout.computePlan(tree, steps, one.rules, f.mode == "creation" ? .creation : .inventory)
    var o = OutData(name: f.name, finalTree: plan.finalTree, mapping: plan.mapping, finalMapping: plan.finalMapping, codeRepos: plan.codeRepos,
                repos: plan.repos, error: plan.error, warnings: plan.warnings,
                targets: f.targets.map { TargetFrom(source: $0.source, origin: $0.origin, target: ProjectLayout.targetOf(plan.mapping[String($0.source)] ?? [], $0.origin)) })
    if let r = outData {
        o.tree = r.node; o.hints = r.hints; o.omitted = r.omitted
        o.upload = r.upload.mapValues { $0.map(\.origin) }
    }
    print("F\t" + String(data: try! enc.encode(o), encoding: .utf8)!)
}
print("Z\t" + [
    ProjectLayout.freeName("README.md", ["README.md", "README-2.md"], false),
    ProjectLayout.freeName(".env", [".env"], false),
    ProjectLayout.freeName("a.tar.gz", ["a.tar.gz"], false),
    ProjectLayout.freeName("src", ["src"], true),
].joined(separator: ","))
`;

let measured = null;
function iosPage() {
  if (measured) return measured;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-layout-ios-"));
  const json = path.join(tmp, "cases.json");
  fs.writeFileSync(json, JSON.stringify({
    rules,
    cases: cases.map((f) => ({
      name: f.name, mode: f.mode, selection: f.selection, gitFiles: f.gitFiles, tree: f.tree, steps: f.steps,
      targets: f.expected.targets.map(({ source, origin }) => ({ source, origin })),
    })),
  }));
  const file = path.join(tmp, "layout.swift");
  fs.writeFileSync(file, fs.readFileSync(SOURCE_SWIFT, "utf8") + DRIVER);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file, json], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  }
  const rows = output.split("\n").filter(Boolean);
  measured = {
    cases: new Map(rows.filter((z) => z.startsWith("F\t")).map((z) => { const o = JSON.parse(z.slice(2)); return [o.name, o]; })),
    freeName: (rows.find((z) => z.startsWith("Z\t")) ?? "Z\t").slice(2).split(","),
  };
  return measured;
}

function compare(fall, holds) {
  assert.ok(holds, `${fall.name}: the Swift side did not compute the case`);
  for (const field of Object.keys(fall.expected)) {
    assert.deepStrictEqual(holds[field], fall.expected[field], `${fall.name}: ${field} (iOS ≠ Fixture)`);
  }
}

test("the driver computes every case of the fixture set", () => {
  const ios = iosPage();
  assert.ok(cases.length >= 12, `too few cases (${cases.length}) — does the glob still match?`);
  assert.deepEqual([...ios.cases.keys()].sort(), cases.map((f) => f.name).sort());
});

for (const fall of cases) {
  test(`iOS case ${fall.name}: ${fall.description}`, () => {
    compare(fall, iosPage().cases.get(fall.name));
  });
}

test("freeName computes on iOS as on the web (suffix before the last extension, dotfiles and folders at the end)", () => {
  assert.deepEqual(iosPage().freeName, ["README-3.md", ".env-2", "a.tar-2.gz", "src-2"]);
});

test("built-in sabotage: an expectation with swapped target paths turns the comparison red", () => {
  const fall = structuredClone(cases.find((f) => f.name === "longest-prefix"));
  const list = fall.expected.mapping["1"];
  assert.ok(list.length >= 2, "the case needs two entries to swap");
  [list[0].to, list[1].to] = [list[1].to, list[0].to];
  assert.throws(() => compare(fall, iosPage().cases.get(fall.name)), /longest-prefix: mapping/);
});
