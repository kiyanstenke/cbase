// The computations of the preview links: ONE fixture table, two languages.
//
// `PreviewRules` in `mobile/CbaseMobile/Shell/PreviewLinks.swift` is the Swift twin of `remainingTime`, `linkOfTheRow` and
// `shareSituation` ("limit") in `web/src/lib/preview-links.ts`. Two deviations used to exist unbound:
//   · the remaining time: the web switches to days from TWO days on, iOS switched already at one ("1 d left" against "47 h left").
//     The web rule is authoritative: ≥ 2 days → days, ≥ 1 h → hours, otherwise minutes (at least 1), ≤ 0 expired.
//   · the assignment of a link to its service row: the web via (project, instance, service), iOS only via (project, service) — a link
//     on `copy-k1` sat under the main row and hid "Share link" there. Now `PreviewRules.assignment`: `own` = the same link as
//     `linkOfTheRow` in the web (the newest on exactly this target; on a tie the first), `additional` = the others of the same
//     service, which name their instance if it is not the row's (`foreignInstance`; "" = B, the view says "not switched").
// Plus `limitReached` (at the limit the iOS menu offers the active links for revoking) against `shareSituation` = "limit".
//
// Built like `archive-binding.test.mjs`: the block `enum PreviewRules` is CUT out of the Swift source, assembled with minimal mocks
// (`ProjectServiceRow`, `Project`, `PreviewLink`) into a program and REALLY executed with `xcrun swift`; the TS page runs compiled by
// tsc against the same table. If the toolchain is missing the test fails LOUDLY; on Linux the file does not run at all (`onlyMacOS`
// in tools/check/latch.json).
//
// Counter-tests (run against the Swift code, then reverted): `rest >= 2 * tag` → `rest >= tag` (the old behavior) ⇒ "remainingTime"
// red (iOS {days 1} instead of {hours 24}/{hours 47}); in `hits` `case .instance: return true` (without the instance comparison,
// only via project and service) ⇒ "assignment" red (under `copy-k1` h2 stood instead of k). Plus the built-in sabotage below: two
// swapped expectations ⇒ exactly two deviations per side.
//
// Run:  node --test --test-reporter=tap web/test/preview-rules-binding.test.mjs
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
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Shell", "PreviewLinks.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const folder = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-preview-rules-")));

// ── The table ────────────────────────────────────────────────────────────────────────────────
const MIN = 60_000, H = 60 * MIN, T = 24 * H, NOW = 1_791_450_000_000;
const REMAINING_TIME = [
  { rest: null, desired: { kind: "unlimited" } },
  { rest: -1, desired: { kind: "expired" } },
  { rest: 0, desired: { kind: "expired" } },
  { rest: 10_000, desired: { kind: "minutes", n: 1 } },
  { rest: 30 * MIN, desired: { kind: "minutes", n: 30 } },
  { rest: H - 1, desired: { kind: "minutes", n: 59 } },
  { rest: H, desired: { kind: "hours", n: 1 } },
  { rest: T - MIN, desired: { kind: "hours", n: 23 } },
  { rest: T, desired: { kind: "hours", n: 24 } },
  { rest: T + 23 * H + 59 * MIN, desired: { kind: "hours", n: 47 } },
  { rest: 2 * T - 1, desired: { kind: "hours", n: 47 } },
  { rest: 2 * T, desired: { kind: "days", n: 2 } },
  { rest: 7 * T - MIN, desired: { kind: "days", n: 6 } },
  { rest: 30 * T, desired: { kind: "days", n: 30 } },
];

const L = (id, projectId, instance, serviceId, createdAt) => ({ id, projectId, instance, serviceId, createdAt });
const ACTIVE = [
  L("h1", "p1", "main", 1, 10), L("k", "p1", "copy-k1", 1, 15), L("h2", "p1", "main", 1, 20), L("b", "p2", null, 1, 5),
  L("x", "p1", "main", 2, 30), L("t1", "p3", "main", 1, 7), L("t2", "p3", "main", 1, 7),
];
// `instance`: undefined = unknown, null = B, otherwise the name. `additional`: [id, foreign instance (null = hits the row)].
const ASSIGNMENT = [
  { projectId: "p1", instance: "main", serviceId: 1, own: "h2", additional: [["h1", null], ["k", "copy-k1"]] },
  { projectId: "p1", instance: "copy-k1", serviceId: 1, own: "k", additional: [["h1", "main"], ["h2", "main"]] },
  { projectId: "p1", instance: null, serviceId: 1, own: null, additional: [["h1", "main"], ["k", "copy-k1"], ["h2", "main"]] },
  { projectId: "p1", instance: undefined, serviceId: 1, own: null, additional: [["h1", "main"], ["k", "copy-k1"], ["h2", "main"]] },
  { projectId: "p2", instance: null, serviceId: 1, own: "b", additional: [] },
  { projectId: "p2", instance: "main", serviceId: 1, own: null, additional: [["b", ""]] },
  { projectId: "p1", instance: "main", serviceId: 2, own: "x", additional: [] },
  { projectId: "p1", instance: "main", serviceId: 9, own: null, additional: [] },
  { projectId: "p3", instance: "main", serviceId: 1, own: "t1", additional: [["t2", null]] },
];
const LIMIT = [
  { active: 0, limit: 0, desired: false }, { active: 0, limit: 1, desired: false }, { active: 1, limit: 1, desired: true },
  { active: 2, limit: 3, desired: false }, { active: 3, limit: 3, desired: true }, { active: 4, limit: 3, desired: true },
];

// ── TS page ───────────────────────────────────────────────────────────────────────────────────
let web = null;
async function tsPage() {
  if (web) return web;
  assert.ok(fs.existsSync(tsc), "web/node_modules missing (tsc) — the binding cannot be checked without the compiler");
  const out = path.join(folder(), "ts");
  execFileSync(process.execPath, [
    tsc, path.join(webDir, "src", "lib", "preview-links.ts"), "--outDir", out, "--module", "es2022", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  const m = await import(pathToFileURL(path.join(out, "preview-links.js")).href);
  const link = (l) => ({ ...l, projectName: "", serviceName: "", port: 1, mode: "dev", url: "", state: "online", error: "", runningSinceAt: null, endedAt: null, endedReason: null });
  web = {
    remainingTime: REMAINING_TIME.map((f) => m.remainingTime(f.rest == null ? null : NOW + f.rest, NOW)),
    own: ASSIGNMENT.map((f) => m.linkOfTheRow(ACTIVE.map(link), f.projectId, f.instance, f.serviceId)?.id ?? null),
    limit: LIMIT.map((f) => m.shareSituation({ active: Array.from({ length: f.active }, (_, i) => link(L(`g${i}`, "p", "main", i, i))), history: [], mode: "names", limit: f.limit, sdk: true }) === "limit"),
  };
  return web;
}

// ── Swift side ────────────────────────────────────────────────────────────────────────────────
function swiftBlock(header) {
  const rows = fs.readFileSync(SOURCE_SWIFT, "utf8").split("\n");
  const start = rows.findIndex((z) => z.startsWith(header));
  assert.ok(start >= 0, `"${header}" is no longer in PreviewLinks.swift — moved or renamed? Then update this line.`);
  const end = rows.findIndex((z, i) => i > start && z === "}");
  assert.ok(end > start, `the closing brace of "${header}" is not in column 0`);
  return rows.slice(start, end + 1).join("\n");
}

const MOCKS = String.raw`
import Foundation
// ── Mocks (preview-rules-binding.test.mjs): only what PreviewRules touches ──
struct ServiceInstanceMock { let identifier: String; let running: Bool }
struct ProjectServiceRow { let id: Int; let projectId: String; var instances: [ServiceInstanceMock]? = nil }
struct ProjectInstanceMock { var converted: Bool?; var identifier: String? }
struct Project { var instance: ProjectInstanceMock? }
struct PreviewLink: Equatable, Decodable { let id: String; var projectId: String; var instance: String?; var serviceId: Int; var createdAt: Double }
`;

const DRIVER = String.raw`

// ── Driver ──
struct Input: Decodable {
    struct R: Decodable { let runningSinceAt: Double? }
    struct Z: Decodable { let projectId: String; let kind: String; let name: String?; let serviceId: Int }
    struct G: Decodable { let active: Int; let limit: Int }
    let now: Double; let remainingTime: [R]; let active: [PreviewLink]; let assignment: [Z]; let limit: [G]
}
struct Further: Encodable { let id: String; let foreign: String? }
struct OutData: Encodable { var remainingTime: [[String: Int]] = []; var remainingTimeKind: [String] = []; var own: [String?] = []; var additional: [[Further]] = []; var limit: [Bool] = [] }
let one = try! JSONDecoder().decode(Input.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var outData = OutData()
for r in one.remainingTime {
    switch PreviewRules.remainingTime(runningSinceAt: r.runningSinceAt, now: one.now) {
    case .unlimited: outData.remainingTimeKind.append("unlimited"); outData.remainingTime.append([:])
    case .expired: outData.remainingTimeKind.append("expired"); outData.remainingTime.append([:])
    case .minutes(let n): outData.remainingTimeKind.append("minutes"); outData.remainingTime.append(["n": n])
    case .hours(let n): outData.remainingTimeKind.append("hours"); outData.remainingTime.append(["n": n])
    case .days(let n): outData.remainingTimeKind.append("days"); outData.remainingTime.append(["n": n])
    }
}
for z in one.assignment {
    let target: PreviewRules.Target = z.kind == "b" ? .b : z.kind == "unknown" ? .unknown : .instance(z.name ?? "")
    let r = PreviewRules.assignment(projectId: z.projectId, serviceId: z.serviceId, target: target, in: one.active)
    outData.own.append(r.own?.id)
    outData.additional.append(r.additional.map { Further(id: $0.id, foreign: PreviewRules.foreignInstance($0, target: target)) })
}
for g in one.limit { outData.limit.append(PreviewRules.limitReached(active: g.active, limit: g.limit)) }
print(String(data: try! JSONEncoder().encode(outData), encoding: .utf8)!)
`;

let swift = null;
function swiftPage() {
  if (swift) return swift;
  const json = path.join(folder(), "input.json");
  fs.writeFileSync(json, JSON.stringify({
    now: NOW,
    remainingTime: REMAINING_TIME.map((f) => ({ runningSinceAt: f.rest == null ? null : NOW + f.rest })),
    active: ACTIVE,
    assignment: ASSIGNMENT.map((f) => ({ projectId: f.projectId, serviceId: f.serviceId, kind: f.instance === undefined ? "unknown" : f.instance === null ? "b" : "instance", name: f.instance ?? null })),
    limit: LIMIT.map(({ active, limit }) => ({ active, limit })),
  }));
  const file = path.join(folder(), "rules.swift");
  fs.writeFileSync(file, MOCKS + "\n" + swiftBlock("enum PreviewRules {") + DRIVER);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file, json], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  }
  const r = JSON.parse(output.trim().split("\n").at(-1));
  swift = {
    remainingTime: r.remainingTimeKind.map((kind, i) => (r.remainingTime[i].n === undefined ? { kind } : { kind, n: r.remainingTime[i].n })),
    own: r.own,
    additional: r.additional.map((w) => w.map((x) => [x.id, x.foreign ?? null])),
    limit: r.limit,
  };
  return swift;
}

// ── Verdict ─────────────────────────────────────────────────────────────────────────────────────
function deviations(page, holds, table = { REMAINING_TIME, ASSIGNMENT, LIMIT }) {
  const result = [];
  const compare = (a, b, what) => { try { assert.deepStrictEqual(a, b); } catch { result.push(`${page} ${what}: actual ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); } };
  table.REMAINING_TIME.forEach((f, i) => compare(holds.remainingTime[i], f.desired, `remainingTime(${f.rest})`));
  table.ASSIGNMENT.forEach((f, i) => {
    compare(holds.own[i], f.own, `assignment ${f.projectId}/${f.instance}/${f.serviceId} own`);
    if (holds.additional) compare(holds.additional[i], f.additional, `assignment ${f.projectId}/${f.instance}/${f.serviceId} additional`);
  });
  table.LIMIT.forEach((f, i) => compare(holds.limit[i], f.desired, `limit(${f.active}/${f.limit})`));
  return result;
}

test("remainingTime, assignment (linkOfTheRow) and limit: the web computes like the table", async () => {
  const result = deviations("Web", await tsPage());
  assert.deepEqual(result, [], result.join("\n"));
});

test("remainingTime, assignment and limit: iOS (PreviewRules, executed with xcrun swift) computes like the table", () => {
  const result = deviations("iOS", swiftPage());
  assert.deepEqual(result, [], result.join("\n"));
});

test("counter-test: two swapped expectations are noticed on both sides", async () => {
  const swap = (list, i, j, field) => list.map((f, k) => (k === i ? { ...f, [field]: list[j][field] } : k === j ? { ...f, [field]: list[i][field] } : f));
  const sabotaged = { REMAINING_TIME: swap(REMAINING_TIME, 9, 11, "desired"), ASSIGNMENT, LIMIT };
  assert.equal(deviations("Web", await tsPage(), sabotaged).length, 2);
  assert.equal(deviations("iOS", swiftPage(), sabotaged).length, 2);
  const sabotaged2 = { REMAINING_TIME, ASSIGNMENT: swap(ASSIGNMENT, 0, 1, "own"), LIMIT };
  assert.equal(deviations("iOS", swiftPage(), sabotaged2).length, 2);
});
