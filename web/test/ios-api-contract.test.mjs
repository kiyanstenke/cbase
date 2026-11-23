// The iOS app's side of the API contract (mobile/CbaseMobile/Models/ApiContract.swift), EXECUTED with `xcrun swift`:
// - the header every request carries, `X-Cbase-Client: ios/<CFBundleShortVersionString> (<CFBundleVersion>); api=<n>`, and the
//   `User-Agent: CbaseMobile/<CFBundleShortVersionString>` (VERSIONING.md, "5. The client header");
// - the three outcomes of a server range `{ level, oldest }` against the app's level: blocking (`needsNewerApp`), soft notice
//   (`olderServer`), nothing (`compatible` — also for a server that sends no `api`, i.e. level 1);
// - by path: `APIClient.makeRequest` (the one place every request is built) sets both headers from `ApiContract`, and the old
//   fixed `CbaseMobile/1.0` is gone; `GatewayInfo` decodes the new `/gw/info` fields as optionals (an old server lacks them);
// - the app's level equals the server's `API_LEVEL.level` (the backend module `api-level.js`); a missing module is red, not a
//   skip.
//
// Counter-tests: `if serverOldest > appLevel` → `>=` turns "server level 1 / oldest 1" red; dropping the `X-Cbase-Client` line in
// makeRequest turns the path binding red; `api=\(appLevel)` → `api=\(level + 1)` turns the header case red.
//
// macOS only (latch.json `onlyMacOS`). Run:  node --test web/test/ios-api-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE = path.join(repo, "mobile", "CbaseMobile", "Models", "ApiContract.swift");
const API = path.join(repo, "mobile", "CbaseMobile", "Models", "APIClient.swift");
const MODELS = path.join(repo, "mobile", "CbaseMobile", "Models", "Models.swift");
const APP = path.join(repo, "mobile", "CbaseMobile");
const SERVER_LEVEL = path.join(repo, "server", "backend", "electron", "server", "api-level.js");

/** The header grammar of the contract. */
const HEADER = /^ios\/([^\s()]+) \((\d+)\); api=(\d+)$/;

// [server level, server oldest, expected outcome] against the app's level 1. `null` = field not sent.
const RANGES = [
  [null, null, "compatible"], // a server from before the contract: level 1
  [1, 1, "compatible"],
  [2, 1, "compatible"], // newer server that still accepts level 1
  [2, 2, "needsNewerApp"],
  [3, 2, "needsNewerApp"],
  [0, 0, "olderServer"],
  [null, 2, "needsNewerApp"], // half range: level follows oldest
  [0, null, "olderServer"], // half range: oldest follows level (never above it)
];

/** The pure part of the file: everything before `// MARK: - Bundle`, closed again. */
function pureSource() {
  const text = fs.readFileSync(SOURCE, "utf8");
  const cut = text.indexOf("    // MARK: - Bundle");
  assert.ok(cut > 0, "ApiContract.swift lost its `// MARK: - Bundle` divider — the pure part can no longer be cut out");
  return `${text.slice(0, cut)}}\n`;
}

let run = null;
function swiftRun() {
  if (run) return run;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-api-contract-"));
  const file = path.join(tmp, "contract.swift");
  const opt = (v) => (v === null ? "nil" : String(v));
  const program = `${pureSource()}
func word(_ c: ApiContract.Compatibility) -> String {
    switch c {
    case .compatible: return "compatible"
    case .needsNewerApp: return "needsNewerApp"
    case .olderServer: return "olderServer"
    }
}
let outcomes: [String] = [
    ${RANGES.map(([l, o]) => `word(ApiContract.compatibility(serverLevel: ${opt(l)}, serverOldest: ${opt(o)}))`).join(",\n    ")}
]
let result: [String: Any] = [
    "level": ApiContract.level,
    "store": ApiContract.storeAddress,
    "header": ApiContract.clientHeader(version: "0.3.0", build: "131"),
    "userAgent": ApiContract.userAgent(version: "0.3.0"),
    "outcomes": outcomes,
]
let json = try! JSONSerialization.data(withJSONObject: result)
print(String(decoding: json, as: UTF8.self))
`;
  fs.writeFileSync(file, program);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`ApiContract.swift could not be executed (xcrun swift): ${e.stderr || e.message}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  run = JSON.parse(output.trim().split("\n").at(-1));
  return run;
}

test("X-Cbase-Client and User-Agent follow the contract", () => {
  const { header, userAgent, level } = swiftRun();
  assert.equal(level, 1, "the app speaks API level 1 (frozen by release 0.2.0)");
  assert.equal(header, "ios/0.3.0 (131); api=1");
  const m = HEADER.exec(header);
  assert.ok(m, `header outside the grammar: ${header}`);
  assert.equal(Number(m[3]), level, "api= must name the app's own level");
  assert.equal(userAgent, "CbaseMobile/0.3.0");
});

RANGES.forEach(([l, o, expected], i) => {
  test(`server level ${l ?? "–"} / oldest ${o ?? "–"} → ${expected}`, () => {
    assert.equal(swiftRun().outcomes[i], expected);
  });
});

test("The App Store address is the app's store page", () => {
  assert.equal(swiftRun().store, "https://apps.apple.com/app/id6838276587");
});

test("APIClient.makeRequest sets both headers from ApiContract; the fixed User-Agent is gone", () => {
  const api = fs.readFileSync(API, "utf8");
  const start = api.indexOf("private func makeRequest(");
  assert.ok(start > 0, "makeRequest is missing in APIClient.swift");
  const body = api.slice(start, api.indexOf("private func makeURL(", start));
  assert.match(body, /setValue\(ApiContract\.currentUserAgent, forHTTPHeaderField: "User-Agent"\)/);
  assert.match(body, /setValue\(ApiContract\.currentClientHeader, forHTTPHeaderField: "X-Cbase-Client"\)/);
  // Every request of the app is built there: no other `URLRequest(` in the app code.
  const others = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".swift")) continue;
      const text = fs.readFileSync(p, "utf8");
      if (text.includes("CbaseMobile/1.0")) others.push(`${path.relative(repo, p)}: CbaseMobile/1.0`);
      const n = (text.replace(/\/\/.*$/gm, "").match(/URLRequest\(/g) || []).length;
      if (n && p !== API) others.push(`${path.relative(repo, p)}: URLRequest( ×${n}`);
    }
  };
  walk(APP);
  assert.deepEqual(others, [], "a request built outside makeRequest would not name the app");
  assert.equal((api.replace(/\/\/.*$/gm, "").match(/URLRequest\(/g) || []).length, 1, "APIClient builds a URLRequest outside makeRequest");
});

test("GatewayInfo decodes the version fields as optionals (an old server lacks them)", () => {
  const models = fs.readFileSync(MODELS, "utf8");
  const start = models.indexOf("struct GatewayInfo:");
  const block = models.slice(start, models.indexOf("\n}\n", start));
  for (const [field, type] of [["build", "String"], ["commit", "String"], ["release", "String"], ["api", "GatewayApiLevel"], ["gatewayVersion", "String"]]) {
    assert.match(block, new RegExp(`let ${field}: ${type}\\?`), `GatewayInfo.${field} is missing or not optional`);
  }
  const level = models.slice(models.indexOf("struct GatewayApiLevel:"));
  assert.match(level, /let level: Int\?/);
  assert.match(level, /let oldest: Int\?/);
});

test("The app's level is the server's API_LEVEL.level", async () => {
  assert.ok(fs.existsSync(SERVER_LEVEL), `${path.relative(repo, SERVER_LEVEL)} is missing — the app's level has nothing to be held against`);
  const { API_LEVEL } = await import(SERVER_LEVEL);
  assert.equal(swiftRun().level, API_LEVEL.level, "raise ApiContract.level together with the server's level");
});
