// The context bar, bound: web and iOS compute denominator, share, percent, title and marker identically.
//
// OpenRouter picks the provider anew PER REQUEST; the bar names the provider of the LAST response and computes against ITS
// window ("Context 26k / 1.05 M · DeepInfra · 2 %"), while the server keeps computing (transcript budget, compaction) with
// the catalog figure. The rule lives in web/src/lib/context-display.ts (`contextDisplay`, `markerOnDenominator`), its twin in
// mobile/CbaseMobile/Chat/ContextDisplay.swift (`ContextDisplay.compute`, `.markerOnDenominator`); the fields come from the
// server (`upstreamProvider`/`upstreamWindow` on the chat, `harness/provider` in the stream — server/backend/test/upstream-provider.test.js).
//
// The TS file is compiled with `tsc`, the Swift file is taken WHOLE (it imports only
// Foundation) and REALLY executed by a driver via `xcrun swift`; cases go in as JSON, results come out as JSON. Without the
// toolchain the test fails LOUDLY (hence `onlyMacOS` in `latch.json`).
// The third test is a source-text contract: the bars (coding chat, iOS) compute through these functions, the visible text
// without a provider stays literally the old one, and both streams take up `provider`.
//
// COUNTER-TESTS (each sabotage turns the named test red):
//   (1) in ContextDisplay.swift take the provider's window even without a name (`let own = max(0, providerWindow)`)
//       => only the iOS comparison is red ("without a name the window does not count: web and iOS differ");
//   (2) in context-display.ts make the denominator always the catalog figure => web test AND comparison red
//       ("Reka, smaller window: the share rises");
//   (3) in ChatStage.tsx drop `denominator={display.denominator}` from the ThresholdsMarker => the source contract is red
//       ("ChatStage.tsx: the marker computes on the catalog and stands on the displayed denominator").
//
// Run:  node --test web/test/context-display-binding.test.mjs
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
const SOURCE_TS = path.join(webDir, "src", "lib", "context-display.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "ContextDisplay.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...parts) => fs.readFileSync(path.join(repo, ...parts), "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-context-display-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────
// [title, tokens, catalogWindow, provider, providerWindow, expected {denominator, provider, percent, title} | null]
// (`null` = web against iOS only, no hand-written value).
const CASES = [
  ["without provider: the catalog is the denominator", 26000, 1048576, "", 0, { denominator: 1048576, provider: "", percent: 2, title: "" }],
  ["DeepInfra, known window: its window is the denominator", 26000, 1048576, "DeepInfra", 1048576, { denominator: 1048576, provider: "DeepInfra", percent: 2, title: "window" }],
  ["Reka, smaller window: the share rises", 131072, 1048576, "Reka", 262144, { denominator: 262144, provider: "Reka", percent: 50, title: "window" }],
  ["provider with unknown window: catalog as denominator, the name shows", 26000, 1048576, "Novita", 0, { denominator: 1048576, provider: "Novita", percent: 2, title: "unknown" }],
  ["without a name the window does not count", 131072, 1048576, "", 262144, { denominator: 1048576, provider: "", percent: 13, title: "" }],
  ["name of spaces only => no provider", 131072, 1048576, "   ", 262144, { denominator: 1048576, provider: "", percent: 13, title: "" }],
  ["name with padding => trimmed", 1000, 200000, "  Z.AI ", 100000, { denominator: 100000, provider: "Z.AI", percent: 1, title: "window" }],
  ["above the window => 100 %", 300000, 1048576, "Reka", 262144, { denominator: 262144, provider: "Reka", percent: 100, title: "window" }],
  ["half percents round up", 5, 1000, "", 0, { denominator: 1000, provider: "", percent: 1, title: "" }],
  ["just below half", 4, 1000, "", 0, { denominator: 1000, provider: "", percent: 0, title: "" }],
  ["no denominator => 0 %", 5000, 0, "", 0, { denominator: 0, provider: "", percent: 0, title: "" }],
  ["no catalog, but the provider's window", 5000, 0, "Reka", 10000, { denominator: 10000, provider: "Reka", percent: 50, title: "window" }],
  ["no tokens", 0, 1048576, "DeepInfra", 1048576, { denominator: 1048576, provider: "DeepInfra", percent: 0, title: "window" }],
  ["negative window counts as unknown", 1000, 200000, "X", -5, { denominator: 200000, provider: "X", percent: 1, title: "unknown" }],
  ["Unicode in the name", 50000, 100000, "Größe „groß“", 100000, { denominator: 100000, provider: "Größe „groß“", percent: 50, title: "window" }],
  ...[1, 7, 99, 1234, 65535, 262143, 262144, 999999].map((tok) => [`Grid ${tok}`, tok, 1048576, "Reka", 262144, null]),
  ...[1, 7, 99, 1234, 65535].map((tok) => [`Grid without provider ${tok}`, tok, 272000, "", 0, null]),
];
// [title, shareOnCatalog, catalogWindow, denominator, expected]
const MARKERS = [
  ["same denominator => unchanged", 0.8, 1048576, 1048576, 0.8],
  ["smaller window => the marker moves right, clamped", 0.8, 1048576, 262144, 1],
  ["half window => twice as far", 0.3, 1000, 500, 0.6],
  ["larger window => to the left", 0.5, 1000, 2000, 0.25],
  ["without catalog => unchanged", 0.4, 0, 500, 0.4],
  ["without denominator => unchanged", 0.4, 1000, 0, 0.4],
  ["no marker", 0, 1000, 500, 0],
];

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
async function loadWeb() {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  return import(pathToFileURL(path.join(out, "context-display.js")).href);
}
const webState = (web, [, tokens, catalogWindow, provider, providerWindow]) => {
  const a = web.contextDisplay({ tokens, catalogWindow, provider, providerWindow });
  return { denominator: a.denominator, provider: a.provider, share: a.share, percent: a.percent, catalogWindow: a.catalogWindow, title: a.title };
};

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
function runIos() {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const imports = source.split("\n").filter((z) => /^import /.test(z));
  assert.deepEqual(imports, ["import Foundation"], "ContextDisplay.swift imports only Foundation — otherwise it no longer runs standalone here");
  const input = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(input, JSON.stringify({ cases: CASES.map(([, t, k, a, f]) => [t, k, a, f]), markers: MARKERS.map(([, a, k, n]) => [a, k, n]) }));
  const file = path.join(tmpDir(), "display.swift");
  fs.writeFileSync(file, `${source}

// ── Driver (web/test/context-display-binding.test.mjs) ──
let data = try! Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(input)}))
let root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
var cases: [Any] = []
for f in root["cases"] as! [[Any]] {
    let s = ContextDisplay.compute(tokens: (f[0] as! NSNumber).intValue, catalogWindow: (f[1] as! NSNumber).intValue, provider: f[2] as! String, providerWindow: (f[3] as! NSNumber).intValue)
    cases.append(["denominator": s.denominator, "provider": s.provider, "share": s.share, "percent": s.percent, "catalogWindow": s.catalogWindow, "title": s.title.rawValue] as [String: Any])
}
var markers: [Any] = []
for m in root["markers"] as! [[NSNumber]] {
    markers.append(ContextDisplay.markerOnDenominator(m[0].doubleValue, catalogWindow: m[1].intValue, denominator: m[2].intValue))
}
print(String(data: try! JSONSerialization.data(withJSONObject: ["cases": cases, "markers": markers]), encoding: .utf8)!)
`);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  }
  return JSON.parse(output.trim().split("\n").pop());
}

// ── The checks ───────────────────────────────────────────────────────────────────────────
test("Web: denominator, provider, percent and title case by case — and the marker on the displayed denominator", async () => {
  const web = await loadWeb();
  for (const f of CASES) {
    if (!f[5]) continue;
    const s = webState(web, f);
    assert.deepEqual({ denominator: s.denominator, provider: s.provider, percent: s.percent, title: s.title }, f[5], f[0]);
    assert.ok(s.share >= 0 && s.share <= 1, `${f[0]}: share within [0, 1]`);
    assert.equal(s.catalogWindow, Math.max(0, f[2]), `${f[0]}: the catalog figure passes through unchanged (cbase computes with it)`);
  }
  for (const [title, a, k, n, expected] of MARKERS) assert.equal(web.markerOnDenominator(a, k, n), expected, `Marker: ${title}`);
  // The title: "window" and "unknown" name provider AND catalog figure; without provider there is none.
  const t = (key, p = {}) => key.replace(/\{(\w+)\}/g, (_, k) => String(p[k]));
  const fmt = (n) => `${n}T`;
  assert.equal(web.contextTitleText(web.contextDisplay({ tokens: 1, catalogWindow: 1048576, provider: "Reka", providerWindow: 262144 }), t, fmt),
    "Window of Reka, the provider of the last response. cbase calculates with 1048576T.");
  assert.equal(web.contextTitleText(web.contextDisplay({ tokens: 1, catalogWindow: 1048576, provider: "Novita", providerWindow: 0 }), t, fmt),
    "Novita delivered the last response; its window is unknown. cbase calculates with 1048576T.");
  assert.equal(web.contextTitleText(web.contextDisplay({ tokens: 1, catalogWindow: 1048576 }), t, fmt), "");
});

test("iOS computes the same as web case by case — denominator, provider, share, percent, title and marker (xcrun swift)", async () => {
  const web = await loadWeb();
  const ios = runIos();
  assert.equal(ios.cases.length, CASES.length);
  CASES.forEach((f, i) => {
    assert.deepEqual(ios.cases[i], webState(web, f), `${f[0]}: web and iOS differ`);
  });
  MARKERS.forEach(([title, a, k, n], i) => {
    assert.equal(ios.markers[i], web.markerOnDenominator(a, k, n), `Marker ${title}: web and iOS differ`);
  });
});

test("The bars compute through these functions, without provider the text stays literal, and the stream takes up `provider`", () => {
  const withoutComments = (q) => q.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Coding chat (ChatStage). Two bars remain: web (ChatStage) and iOS (ContextBar).
  for (const [file, window, chat] of [
    [["web", "src", "components", "chat", "ChatStage.tsx"], "win", "activeChat"],
  ]) {
    const q = withoutComments(read(...file));
    const name = file.at(-1);
    assert.ok(q.includes(`contextDisplay({ tokens: ctxTokens, catalogWindow: ${window}, provider: ${chat}?.upstreamProvider, providerWindow: ${chat}?.upstreamWindow })`), `${name}: the bar computes through contextDisplay, with the catalog figure as catalogWindow`);
    assert.ok(q.includes("const frac = display.share;"), `${name}: the bar follows the displayed share`);
    assert.ok(q.includes("{t(\"Context\")} {fmtTokens(ctxTokens)} / {fmtTokens(display.denominator)}{display.provider ? ` · ${display.provider}` : \"\"} · {display.percent} %"),
      `${name}: the visible text — without provider literally "Context {used} / {total} · {pct} %"`);
    assert.ok(q.includes("title={contextTitleText(display, t, fmtTokens) || undefined}"), `${name}: the title says whose window it is`);
    assert.match(q, /<ThresholdsMarker[^>]*window=\{win\}[^>]*denominator=\{display\.denominator\}/, `${name}: the marker computes on the catalog and stands on the displayed denominator`);
    assert.ok(!q.includes("fmtTokens(win)"), `${name}: no second denominator beside the computation`);
  }
  // The shell takes up the event; the reducer does not know it (composer-contract: ONLY_WRAPPER).
  const pane = withoutComments(read("web", "src", "components", "chat", "ChatPane.tsx"));
  assert.match(pane, /evt\.subtype === "provider"[^]*?upstreamProvider: String\(evt\.provider \|\| ""\), upstreamWindow: Number\(evt\.window\) \|\| 0/, "ChatPane: harness/provider sets the two fields on the chat");
  // The marker: ThresholdsMarker positions via markerOnDenominator.
  const auto = withoutComments(read("web", "src", "components", "Autocompact.tsx"));
  assert.ok(auto.includes("markerOnDenominator(share / 100, window, denominator || window) * 100"), "Autocompact.tsx: the marker stands on the displayed denominator");
  // iOS: ONE display (ContextBar), fed from contextDisplay; the stream takes up the event; the chat decodes both fields.
  const bar = withoutComments(read("mobile", "CbaseMobile", "Chat", "ChatSheets.swift"));
  const barBody = bar.slice(bar.indexOf("struct ContextBar"), bar.indexOf("\n}\n", bar.indexOf("struct ContextBar")));
  assert.ok(barBody.includes("let display = model.contextDisplay"), "ContextBar reads contextDisplay");
  assert.ok(barBody.includes("L(\"{used} / {total} · {pct} %\""), "ContextBar without provider: without the word Context (model button beside it)");
  assert.ok(barBody.includes("L(\"{used} / {total} · {provider} · {pct} %\""), "ContextBar with provider");
  assert.ok(barBody.includes("model.autocompactMarker"), "ContextBar: the marker on the displayed denominator");
  const prov = withoutComments(read("mobile", "CbaseMobile", "Chat", "ChatViewModel+Provider.swift"));
  assert.ok(prov.includes("ContextDisplay.compute(tokens: contextTokens, catalogWindow: contextWindow, provider: chat.upstreamProvider, providerWindow: chat.upstreamWindow)"), "iOS: contextDisplay from catalog and the two fields");
  assert.ok(prov.includes("ContextDisplay.markerOnDenominator(autocompactShare, catalogWindow: contextWindow, denominator: contextDisplay.denominator)"), "iOS: the marker on the displayed denominator");
  assert.match(prov, /let model = chat\.model\.isEmpty \? \(provider\?\.defaultModel \?\? ""\) : chat\.model/, "iOS: the default model of an empty chat.model is resolved (as on web)");
  const stream = withoutComments(read("mobile", "CbaseMobile", "Chat", "ChatViewModel+Stream.swift"));
  assert.match(stream, /case "provider":\s*chat\.upstreamProvider = event\["provider"\]\?\.stringValue \?\? ""\s*chat\.upstreamWindow = event\["window"\]\?\.intValue \?\? 0/, "iOS: harness/provider sets the two fields");
  const models = withoutComments(read("mobile", "CbaseMobile", "Models", "Models.swift"));
  assert.ok(models.includes("upstreamProvider = (try? c.decodeIfPresent(String.self, forKey: .upstreamProvider)) ?? \"\""), "iOS: chat decodes upstreamProvider (missing = none)");
  assert.ok(models.includes("upstreamWindow = (try? c.decodeIfPresent(Int.self, forKey: .upstreamWindow)) ?? 0"), "iOS: chat decodes upstreamWindow");
  // The sentences are in both dictionaries.
  const en = read("web", "src", "lib", "i18n-de.ts");
  const enIos = read("mobile", "CbaseMobile", "Kit", "LocDEBase.swift");
  for (const k of ["Window of {provider}, the provider of the last response. cbase calculates with {catalog}.", "{provider} delivered the last response; its window is unknown. cbase calculates with {catalog}."]) {
    assert.ok(en.includes(`"${k}":`), `i18n-de.ts: ${k}`);
    assert.ok(enIos.includes(`"${k}":`), `LocDEBase.swift: ${k}`);
  }
});
