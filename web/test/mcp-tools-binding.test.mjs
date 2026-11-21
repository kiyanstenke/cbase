// The tool choice of a coding MCP server, bound: web and iOS calculate the same.
//
// The calculation exists ONCE per client: web/src/lib/mcp-tools.ts and mobile/CbaseMobile/Code/McpTools.swift. This test compiles the
// Swift file with a driver (`xcrun swiftc`), runs the same cases through both versions and demands the same answer: rows (label,
// selected, card, fresh), counter, the choice after a click, the markers after a click, the status. Plus the seam to the server: the
// iOS model decodes the server's answer (`mapMcp`) including `choice: null` and without the new fields (an older server) — a
// synthesised Decodable would demand EVERY key. If the toolchain is missing, the test fails LOUDLY (`latch.json` `onlyMacOS`).
//
// Counter-probes (each in a copy):
//   McpTools.swift: `toggleChoice` from nil => [name]    => equality red
//   McpTools.swift: `label(nil)` => "reads"              => equality red
//   McpTools.swift: `fresh` not decoded (always false)   => equality red (case with "fresh")
//
// Run:  node --test web/test/mcp-tools-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "mcp-tools.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Code", "McpTools.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-mcp-tools-binding-")));

const W = [
  { name: "read", description: "reads files", writing: false },
  { name: "send", description: "sends", writing: true },
  { name: "third", writing: null, fresh: true },
  { name: "without_hint" },
];
// [tools, choice, markers, clickName, now, toolsAt, error]
const CASES = [
  [W, null, [], "send", 1_792_000_000_000, 0, ""],
  [W, ["read", "send"], ["send"], "read", 1_792_000_000_000, 1_792_000_000_000 - 185_000, ""],
  [W, [], ["send"], "third", 1_792_000_000_000, 1_792_000_000_000 - 30_000, "timeout"],
  [W, ["gone", "third"], ["gone"], "gone", 1_792_000_000_000, 1_791_999_000_000, ""],
  [[], null, [], "x", 1_792_000_000_000, 0, "ECONNREFUSED"],
];

function writeCases() {
  const file = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(file, JSON.stringify(CASES));
  return file;
}

function runWeb(cases) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import { toolRows, counter as counterValue, toggleChoice, toggleMarker, statusOf } from "./mcp-tools.js";
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(cases.map(([w, choice, markers, click, now, at, error]) => {
  const tools = w.map((x) => ({ name: x.name, description: x.description, writing: x.writing ?? null, fresh: x.fresh }));
  return {
    rows: toolRows(tools, choice, markers),
    counter: counterValue(tools, choice, markers),
    choice: toggleChoice(tools, choice, click),
    markers: toggleMarker(markers, click),
    state: statusOf(at, error, now),
  };
})));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, cases], { encoding: "utf8", env }).trim().split("\n").pop());
}

function runIos(cases) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  assert.deepEqual(source.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "McpTools.swift imports only Foundation — otherwise it cannot be bound");
  assert.ok(!/\bL\(/.test(source.replace(/\/\/.*$/gm, "")), "McpTools.swift does not translate itself (no L(…)) — the labels are keys");
  const file = path.join(tmpDir(), "mcp.swift");
  fs.writeFileSync(file, `${source}

// ── driver (web/test/mcp-tools-binding.test.mjs) ──
let raw = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try! JSONSerialization.jsonObject(with: raw) as! [[Any]]
var outData: [Any] = []
for f in cases {
    // The tools go through the model's decoder (the seam): missing keys, null, fresh.
    let tools = try! JSONDecoder().decode([CodingMcpTool].self, from: JSONSerialization.data(withJSONObject: f[0]))
    let choice: [String]? = f[1] is NSNull ? nil : (f[1] as! [String])
    let markers = f[2] as! [String]
    let click = f[3] as! String
    let now = (f[4] as! NSNumber).intValue
    let at = (f[5] as! NSNumber).intValue
    let error = f[6] as! String
    let rows: [Any] = McpToolComputation.rows(tools, choice: choice, markers: markers).map { z in
        ["name": z.name, "description": z.description, "label": z.label, "selected": z.selected, "card": z.card, "fresh": z.fresh] as [String: Any]
    }
    let z = McpToolComputation.counter(tools, choice: choice, markers: markers)
    let s = McpToolComputation.status(toolsAt: at, error: error, now: now)
    outData.append([
        "rows": rows,
        "counter": ["free": z.free, "card": z.card, "total": z.total],
        "choice": McpToolComputation.toggleChoice(tools, choice: choice, name: click),
        "markers": McpToolComputation.toggleMarker(markers, name: click),
        "state": ["kind": s.kind, "minutes": s.minutes],
    ] as [String: Any])
}
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "mcp");
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be compiled (xcrun swiftc): ${e.stderr || e.message}`);
  }
  return JSON.parse(execFileSync(bin, [cases], { encoding: "utf8" }).trim().split("\n").pop());
}

test("web and iOS calculate the tool choice the same: rows, counter, click on tick and card, status (xcrun swiftc)", () => {
  const f = writeCases();
  const web = runWeb(f);
  const ios = runIos(f);
  assert.equal(web.length, CASES.length);
  for (let i = 0; i < CASES.length; i++) assert.deepEqual(ios[i], web[i], `case ${i}: iOS differs`);
  // The cases did not run empty: "fresh", a card, an error and a vanished name occur.
  assert.ok(web.some((x) => x.rows.some((z) => z.fresh)) && web.some((x) => x.counter.card > 0));
  assert.deepEqual(web[3].choice, ["third"], "the vanished name \"gone\" is deselected, \"third\" stays");
  assert.deepEqual(web[0].choice, ["read", "third", "without_hint"]);
  assert.equal(web[4].state.kind, "error");
  console.log(`# MCP tools: ${CASES.length} cases, ${web.reduce((n, x) => n + x.rows.length, 0)} rows, web == iOS`);
});

test("seam server <-> iOS: the model decodes the answer including choice null and without the new fields (older server)", () => {
  const model = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Models", "ContextModels.swift"), "utf8");
  const block = model.slice(model.indexOf("struct McpServer:"), model.indexOf("struct ProjectMcpServers"));
  for (const field of ["headers", "tools", "toolsAt", "toolsError", "choice", "markers", "subagentsInherit"]) {
    assert.match(block, new RegExp(`\\b${field} = `), `McpServer does not decode ${field}`);
  }
  assert.match(block, /choice = \(try\? c\.decodeIfPresent\(\[String\]\.self, forKey: \.choice\)\) \?\? nil/, "choice: null and missing => nil (all)");
  assert.match(block, /subagentsInherit = c\.bool\(\.subagentsInherit, true\)/, "an older server: inherit as before (on)");
  // The fields the server sends (mapMcp) are all in the model — and none beyond them is named differently.
  const server = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "store", "toolchain.js"), "utf8");
  for (const field of ["headers", "tools", "toolsAt", "toolsError", "choice", "markers", "subagentsInherit"]) {
    assert.match(server, new RegExp(`\\b${field}:`), `the server does not send ${field} (mapMcp) — seam torn`);
  }
  // And the UITest fixture delivers the same shape (otherwise the UITest would check its own invention).
  const fixture = fs.readFileSync(path.join(repo, "mobile", "test-fixtures", "chat-gateway", "routes-workspace.mjs"), "utf8");
  const seed = fixture.slice(fixture.indexOf("const mcpSeed = "), fixture.indexOf("let mcpServer = "));
  for (const field of ["headers", "tools", "toolsAt", "toolsError", "choice", "markers", "subagentsInherit"]) {
    assert.match(seed, new RegExp(`\\b${field}:`), `the fixture does not deliver ${field}`);
  }
  assert.doesNotMatch(seed, /Bearer|value:/i, "the fixture carries no header value — the server never sends one");
});
