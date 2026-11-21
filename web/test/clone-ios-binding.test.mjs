// The address of a clone on the iPhone: the same check as in the web, bound through the SAME fixture set
// (`server/backend/test/fixtures/clone-check/`).
//
// `mobile/CbaseMobile/Code/ProjectCloneCheck.swift` is the Swift twin of `web/src/lib/project-clone.ts`. If it deviated, the error
// would show up on the iPhone only after "Create", or the credentials would lie under a different key (IDN host as Unicode).
// Same build as `layout-ios-binding.test.mjs`: the Swift file (plain Foundation) is read as a WHOLE, extended by a driver and REALLY
// executed with `xcrun swift`. Without the toolchain the test fails LOUDLY; on Linux the file does not run at all (`onlyMacOS` in
// tools/check/latch.json).
//
// Counter-test: the built-in sabotage swaps two expectations. Run against the Swift code: `URLComponents.host` instead of the raw
// text => "xn--bcher-kva.example" red (Foundation returns the Unicode host); without the port limit => ":99999" red; without resolving
// "." / ".." => ".../repo/." red.
//
// Run:  node --test web/test/clone-ios-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Code", "ProjectCloneCheck.swift");
const FIX = path.join(repo, "server", "backend", "test", "fixtures", "clone-check", "cases.json");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

const { cases } = JSON.parse(fs.readFileSync(FIX, "utf8"));

const DRIVER = String.raw`

// ── Driver (clone-ios-binding.test.mjs) ──
struct FallOne: Decodable { let url: String; let branch: String }
struct Output: Encodable { var host: String? = nil; var name: String? = nil; var code: String? = nil }
let raw = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let one = try! JSONDecoder().decode([FallOne].self, from: raw)
let codes: [ProjectClone.CheckError: String] = [.empty: "EMPTY", .onlyHttps: "ONLY_HTTPS", .withUser: "WITH_USER", .withQuery: "WITH_QUERY",
    .withFragment: "WITH_FRAGMENT", .character: "CHARACTER", .hostUnclear: "HOST_UNCLEAR", .branch: "BRANCH", .invalid: "INVALID"]
let enc = JSONEncoder()
for f in one {
    var o = Output()
    switch ProjectClone.check(f.url, f.branch) {
    case .success(let a): o.host = a.host; o.name = a.name
    case .failure(let e): o.code = codes[e]
    }
    print(String(data: try! enc.encode(o), encoding: .utf8)!)
}
`;

let measured = null;
function iosPage() {
  if (measured) return measured;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clone-ios-"));
  const json = path.join(tmp, "cases.json");
  fs.writeFileSync(json, JSON.stringify(cases.map(({ url, branch }) => ({ url, branch }))));
  const file = path.join(tmp, "clone.swift");
  fs.writeFileSync(file, fs.readFileSync(SOURCE_SWIFT, "utf8") + DRIVER);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file, json], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  }
  measured = output.split("\n").filter(Boolean).map((z) => JSON.parse(z));
  return measured;
}

function deviations(list, holds) {
  const out = [];
  list.forEach((f, i) => {
    try { assert.deepStrictEqual(holds[i], f.client); } catch { out.push(`${JSON.stringify(f.url)} (${JSON.stringify(f.branch)}): expected ${JSON.stringify(f.client)}, iOS ${JSON.stringify(holds[i])}`); }
  });
  return out;
}

test("ProjectClone.check gives the client's expectation for every case", () => {
  const holds = iosPage();
  assert.equal(holds.length, cases.length, "the driver did not compute every case");
  const out = deviations(cases, holds);
  assert.deepEqual(out, [], `iOS differs from fixture:\n${out.join("\n")}`);
});

test("counter-test: two swapped expectations are noticed", () => {
  const holds = iosPage();
  const i = cases.findIndex((f) => f.client.host);
  const j = cases.findIndex((f) => f.client.code === "HOST_UNCLEAR");
  const sabotaged = cases.map((f, k) => (k === i ? { ...f, client: cases[j].client } : k === j ? { ...f, client: cases[i].client } : f));
  assert.equal(deviations(sabotaged, holds).length, 2);
});
