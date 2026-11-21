// "waiting until HH:MM" of a parked subagent, bound: web and iOS compute the same.
//
// Two computations of the same line: the web reads `parkedUntil` in `agentsList` (only with status "parked", only a number > 0)
// and writes it with `waitingUntilText` (web/src/lib/agents.ts); iOS reads it in `SubagentLive.init(json:)` (same condition,
// milliseconds → `Date`) and writes it with `SubagentEntry.waitingUntilText` (mobile/CbaseMobile/Chat/ChatViewModel.swift).
// Both claimed "the same computation", nothing was bound — if one drifts (UTC instead of local time, 12 h, rounded instead of
// truncated, a different instant for seconds), iPhone and desktop show different times for the same agent.
//
// Model: completion-notice-binding.test.mjs / geometry-binding.test.mjs. The web is compiled with `tsc`, iOS is assembled from the
// REAL source: `JSONValue.swift` whole, from ChatViewModel.swift the whole `struct SubagentLive` and `static func
// waitingUntilText` (into a shell `enum SubagentEntry`), plus a stub for `L` — and REALLY compiled with `xcrun swiftc`. Both
// sides run as their own process per time zone (environment `TZ`), the same cases in as JSON, the lines out as JSON. If the
// toolchain is missing the test fails LOUDLY (hence under `onlyMacOS` in `latch.json`).
//
// Counter-tests: in ChatViewModel.swift replace `Calendar.current` by a UTC calendar ⇒ "time zones" red (Kathmandu, St. John's
// differ); in agents.ts `getHours()` by `getUTCHours()` ⇒ the same check red; in `SubagentLive.init` `until > 0` by
// `until >= 0` ⇒ "condition" red (parkedUntil 0 shows "waiting until 01:00" on iOS).
// Run:  node --test web/test/waiting-until-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "agents.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel.swift");
const SOURCE_JSON = path.join(repo, "mobile", "CbaseMobile", "Models", "JSONValue.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-waiting-until-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────
// Instants that each hit one form of the computation: a minute, the last millisecond of a minute (truncate, not round),
// midnight, both daylight-saving switches in Central Europe, fractions of a millisecond, start of the epoch, far future.
const Z = (iso, extra = 0) => Date.parse(iso) + extra;
const MOMENTS = [
  Z("2026-09-25T12:05:00Z"),
  Z("2026-09-25T21:59:59.999Z"),
  Z("2026-09-25T22:00:00Z"),
  Z("2026-09-25T23:30:30.500Z"),
  Z("2026-10-25T00:30:00Z"), // Berlin 02:30 summer time
  Z("2026-10-25T01:30:00Z"), // Berlin 02:30 winter time
  Z("2026-03-29T01:00:00Z"), // Berlin 03:00, the hour before does not exist
  1790327956504.7,
  1,
  Z("2100-01-01T00:00:00Z"),
];
// Zones with whole, half and three-quarter hours, daylight saving in the north and the south (Chatham is still +12:45 on 2026-09-25).
const ZONES = ["Europe/Berlin", "UTC", "America/St_Johns", "Asia/Kathmandu", "Pacific/Chatham", "America/Los_Angeles"];
// The payload of a running agent (status, parkedUntil) — the same JSON row for both sides.
const PAYLOADS = [
  ...MOMENTS.map((until) => ({ status: "parked", parkedUntil: until })),
  { status: "parked", parkedUntil: 0 },
  { status: "parked", parkedUntil: -60000 },
  { status: "parked" },
  { status: "parked", parkedUntil: null },
  { status: "parked", parkedUntil: "1790327956504" },
  { status: "running", parkedUntil: MOMENTS[0] },
  { status: "", parkedUntil: MOMENTS[0] },
  { parkedUntil: MOMENTS[0] },
].map((n) => ({ taskId: "t-1", agentId: "a-1", description: "On the side", provider: "claude", model: "", startedAt: 1, tokens: 0, toolUses: 0, ...n }));

function writeCases() {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify(PAYLOADS));
  return file;
}

// ── Web: compiled, then one process per zone ────────────────────────────────────────────────
function runWeb(cases) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  // The same placeholder substitution as `fmt` in src/lib/i18n.ts — English is the key.
  fs.writeFileSync(driver, `import fs from "node:fs";
import { agentsList, waitingUntilText } from "./agents.js";
const t = (k, p) => (p ? k.replace(/\\{(\\w+)\\}/g, (m, x) => (x in p ? String(p[x]) : m)) : k);
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(cases.map((n) => {
  const [a] = agentsList([n], [], new Set());
  return a && a.parkedUntil !== undefined ? waitingUntilText(a.parkedUntil, t) : null;
})));
`);
  const result = {};
  for (const zone of ZONES) {
    const env = { ...process.env, TZ: zone };
    delete env.NODE_TEST_CONTEXT;
    result[zone] = JSON.parse(execFileSync(process.execPath, [driver, cases], { encoding: "utf8", env }).trim().split("\n").pop());
  }
  return result;
}

// ── iOS: assembled from the real source, compiled ONCE, run per zone ────────────────────────
function cut(source, re, what) {
  const m = re.exec(source);
  assert.ok(m, `${what} is no longer in ChatViewModel.swift — the binding must be updated`);
  return m[0];
}
function runIos(cases) {
  const vm = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const json = fs.readFileSync(SOURCE_JSON, "utf8");
  assert.deepEqual(json.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "JSONValue.swift imports only Foundation");
  // The whole type up to its closing brace in column 0; the function up to its closing brace (4 spaces).
  const live = cut(vm, /^struct SubagentLive: [^\n]*\{\n[^]*?\n\}\n/m, "struct SubagentLive");
  const fmt = cut(vm, /^ {4}static func waitingUntilText\(_ until: Date\) -> String \{\n[^]*?\n {4}\}\n/m, "SubagentEntry.waitingUntilText");
  assert.match(live, /init\(json: JSONValue\)/);
  assert.match(live, /parkedUntil = /, "SubagentLive reads parkedUntil itself");
  const file = path.join(tmpDir(), "waiting.swift");
  fs.writeFileSync(file, `${json}

${live}
enum SubagentEntry {
${fmt}}

// ── Stub and driver (web/test/waiting-until-binding.test.mjs) ──
func L(_ key: String) -> String { key }
func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var s = key
    for (k, v) in params { s = s.replacingOccurrences(of: "{\\(k)}", with: v.description) }
    return s
}
let data = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try! JSONDecoder().decode([JSONValue].self, from: data)
var outData: [Any] = []
for f in cases {
    if let until = SubagentLive(json: f).parkedUntil { outData.append(SubagentEntry.waitingUntilText(until)) } else { outData.append(NSNull()) }
}
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "waiting");
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be compiled (xcrun swiftc): ${e.stderr || e.message}`);
  }
  const result = {};
  for (const zone of ZONES) result[zone] = JSON.parse(execFileSync(bin, [cases], { encoding: "utf8", env: { ...process.env, TZ: zone } }).trim().split("\n").pop());
  return result;
}

let both = null;
const compute = () => {
  if (both) return both;
  const cases = writeCases();
  both = { web: runWeb(cases), ios: runIos(cases) };
  return both;
};

// ── The checks ──────────────────────────────────────────────────────────────────────────────
test("time zones: for every instant and zone iOS writes the same line as the web — in local time", () => {
  const { web, ios } = compute();
  for (const zone of ZONES) {
    PAYLOADS.forEach((n, i) => {
      assert.equal(ios[zone][i], web[zone][i], `${zone}, ${JSON.stringify({ status: n.status, parkedUntil: n.parkedUntil })}: web and iOS differ`);
    });
  }
  // The expectation spelled out, not just equality — else two sides that both overlook the zone would be green.
  const first = (zone) => web[zone][0];
  assert.deepEqual(ZONES.map(first), ["waiting until 14:05", "waiting until 12:05", "waiting until 09:35", "waiting until 17:50", "waiting until 00:50", "waiting until 05:05"]);
  assert.equal(web["Europe/Berlin"][1], "waiting until 23:59", "the last millisecond of a minute is truncated, not rounded");
  assert.equal(web["Europe/Berlin"][2], "waiting until 00:00");
  assert.deepEqual([web["Europe/Berlin"][4], web["Europe/Berlin"][5]], ["waiting until 02:30", "waiting until 02:30"], "both 02:30 on the day of the switch");
  assert.equal(web["Europe/Berlin"][6], "waiting until 03:00");
});

test("condition: only a parked agent with a number > 0 waits — the same in both", () => {
  const { web, ios } = compute();
  const zone = "Europe/Berlin";
  const expected = PAYLOADS.map((n) => n.status === "parked" && typeof n.parkedUntil === "number" && n.parkedUntil > 0);
  PAYLOADS.forEach((n, i) => {
    assert.equal(web[zone][i] !== null, expected[i], `web ${JSON.stringify({ status: n.status, parkedUntil: n.parkedUntil })}`);
    assert.equal(ios[zone][i] !== null, expected[i], `iOS ${JSON.stringify({ status: n.status, parkedUntil: n.parkedUntil })}`);
  });
});
