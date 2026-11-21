// The "at least" marker on a token count, bound: web and iOS compute it the same way.
//
// A report from old data carries no `tokenKind` (agent-runtime.js report() writes it now). It used to count as unknown
// internally, yet the display showed it like a measured full number. Every kind except "full" carries the marker:
// the lower bound and the unknown one (missing, empty, foreign). The rule exists ONCE per client: `tokenLowerLimit` in
// web/src/lib/agents.ts (behind it `tokenKindFromReport` for the report) and `ChatViewModel.tokenLowerLimit` in
// mobile/CbaseMobile/Chat/ChatViewModel+Subagents.swift (behind it `onlyOutput`).
//
// Model: completion-notice-binding.test.mjs. The Swift function is cut out, assembled with the constant from
// ChatViewModel.swift into one program and REALLY run with `xcrun swift`. Without the toolchain the test fails
// LOUDLY (hence under `onlyMacOS` in latch.json).
//
// COUNTER-TEST: in ChatViewModel+Subagents.swift the old rule `kind == "only_output"` instead of
// `kind != SubagentLive.tokenKindFull` makes "missing", "empty", "foreign" differ from the web (the equality
// test turns red); in the web `kind === "only_output"` turns the expectation test red.
//
// Run:  node --test web/test/token-kind-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "agents.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+Subagents.swift");
const SOURCE_CONSTANT = path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-token-kind-binding-")));

// The cases: the value of the `tokenKind` field (null = the field is missing) and the expectation "marker?".
const CASES = [
  ["full", false],
  ["only_output", true],
  [null, true],
  ["", true],
  ["estimated", true],
  ["Voll", true],
];

async function loadWeb() {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  return import(pathToFileURL(path.join(out, "agents.js")).href);
}

function runIos() {
  const rows = fs.readFileSync(SOURCE_SWIFT, "utf8").split("\n");
  const start = rows.findIndex((z) => z === "    static func tokenLowerLimit(_ kind: String?) -> Bool {");
  assert.ok(start >= 0, "`static func tokenLowerLimit(_ kind: String?) -> Bool {` is missing in ChatViewModel+Subagents.swift: update the anchor, do not drop the test");
  const end = rows.findIndex((z, i) => i > start && z === "    }");
  assert.ok(end > start, "the end of tokenLowerLimit (a `    }` line) is missing");
  const constant = fs.readFileSync(SOURCE_CONSTANT, "utf8").split("\n").find((z) => /^    static let tokenKindFull = /.test(z));
  assert.ok(constant, "`static let tokenKindFull = …` is missing in ChatViewModel.swift (SubagentLive)");
  const file = path.join(tmpDir(), "tokenKind.swift");
  const swiftCases = CASES.map(([kind]) => (kind === null ? "nil" : JSON.stringify(kind))).join(", ");
  fs.writeFileSync(file, `struct SubagentLive {
${constant}
}
enum ChatViewModel {
${rows.slice(start, end + 1).join("\n")}
}
let cases: [String?] = [${swiftCases}]
for f in cases { print(ChatViewModel.tokenLowerLimit(f) ? "1" : "0") }
`);
  let output = "";
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  return output.trim().split("\n").map((z) => z === "1");
}

test("Web: every kind except \"full\" carries the marker, including the unknown one from old data", async () => {
  const { tokenLowerLimit, tokenKindFromReport, tokenShort } = await loadWeb();
  for (const [kind, marker] of CASES) {
    const report = kind === null ? {} : { tokenKind: kind };
    assert.equal(tokenLowerLimit(tokenKindFromReport(report)), marker, `report ${JSON.stringify(report)}`);
  }
  assert.equal(tokenShort(16_180, tokenKindFromReport({})), "≥16k", "the column shows the sign");
});

test("Web and iOS compute the marker equally (xcrun swift)", async () => {
  const { tokenLowerLimit, tokenKindFromReport } = await loadWeb();
  const web = CASES.map(([kind]) => tokenLowerLimit(tokenKindFromReport(kind === null ? {} : { tokenKind: kind })));
  const ios = runIos();
  console.log(`# Token kind: ${CASES.length} cases, web ${web.map(Number).join("")} · iOS ${ios.map(Number).join("")}`);
  assert.deepEqual(ios, web, "iOS differs from the web");
});
