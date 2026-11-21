// The day separator in the history, bound: web and iOS put it before the same rows and name the same day.
//
// The time behind the figures carries only the time of day (web `endText`, iOS `locEndTime`); the separator says the
// day. The rule lives in web/src/lib/day-separator.ts (`dayMarkers`), its twin in
// mobile/CbaseMobile/Chat/DaySeparator.swift (`DaySeparator.markers`).
//
// Model: context-display-binding.test.mjs. The TS file is compiled with `tsc`, the Swift file is taken WHOLE (only
// Foundation) and run via `xcrun swift` — both in the time zone Europe/Berlin (TZ) so the daylight-saving cases
// bite: a calendar day is not 24 h. Without the toolchain the test fails LOUDLY (`latch.json` → `onlyMacOS`).
//
// COUNTER-TESTS:
//   (1) "yesterday" as `o.now - 86_400_000` in day-separator.ts turns the web test red ("DST start: yesterday is 29.03.");
//   (2) `let fresh = prior == nil ? true : …` in DaySeparator.swift (window forgotten) turns the iOS comparison red
//       ("window: …");
//   (3) the date put before the time again in RunDisplay.tsx turns the source-text contract red.
//
// Run:  node --test web/test/day-separator-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.TZ = "Europe/Berlin"; // before the first date computation — Node re-reads TZ at run time

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_TS = path.join(webDir, "src", "lib", "day-separator.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "DaySeparator.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...parts) => fs.readFileSync(path.join(repo, ...parts), "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-day-separator-")));

// Local time in Berlin → ms.
const L = (j, m, t, h = 12, min = 0) => new Date(j, m - 1, t, h, min).getTime();
const NOW = L(2026, 11, 10, 12);

// [title, times, olderBeforehand, now, expected: per row null or [tag, kind, withYear]]
const CASES = [
  ["empty", [], false, NOW, []],
  ["first row of the chat: separator \"today\"", [L(2026, 11, 10, 9)], false, NOW, [["2026-11-10", "today", false]]],
  ["same day: only once", [L(2026, 11, 10, 9), L(2026, 11, 10, 9, 5), L(2026, 11, 10, 11)], false, NOW, [["2026-11-10", "today", false], null, null]],
  ["three days: yesterday, today", [L(2026, 11, 4, 21), L(2026, 11, 9, 8), L(2026, 11, 9, 23, 59), L(2026, 11, 10, 0, 1)], false, NOW,
    [["2026-11-04", "date", false], ["2026-11-09", "yesterday", false], null, ["2026-11-10", "today", false]]],
  ["window: older ones on the server ⇒ the first loaded row without separator", [L(2026, 11, 9, 8), L(2026, 11, 9, 9), L(2026, 11, 10, 8)], true, NOW,
    [null, null, ["2026-11-10", "today", false]]],
  ["window: unknown rows before it change nothing either", [0, null, L(2026, 11, 9, 8), L(2026, 11, 10, 8)], true, NOW,
    [null, null, null, ["2026-11-10", "today", false]]],
  ["unknown time: no separator, the day continues", [L(2026, 11, 9, 8), 0, null, -5, L(2026, 11, 9, 9), L(2026, 11, 10, 1)], false, NOW,
    [["2026-11-09", "yesterday", false], null, null, null, null, ["2026-11-10", "today", false]]],
  ["first known time behind unknown ones: it opens the chat", [null, 0, L(2026, 11, 10, 7)], false, NOW, [null, null, ["2026-11-10", "today", false]]],
  ["previous year: with year", [L(2025, 12, 31, 23), L(2026, 1, 1, 0, 30)], false, NOW, [["2025-12-31", "date", true], ["2026-01-01", "date", false]]],
  ["seconds instead of ms (old servers)", [L(2026, 11, 9, 8) / 1000, L(2026, 11, 10, 8) / 1000], false, NOW, [["2026-11-09", "yesterday", false], ["2026-11-10", "today", false]]],
  ["shortly after midnight: 23:55 is yesterday", [L(2026, 11, 9, 23, 55), L(2026, 11, 10, 0, 2)], false, L(2026, 11, 10, 0, 5),
    [["2026-11-09", "yesterday", false], ["2026-11-10", "today", false]]],
  ["DST end (25-h day): 00:30 and 23:30 are the same day", [L(2026, 10, 25, 0, 30), L(2026, 10, 25, 23, 30), L(2026, 10, 26, 0, 10)], false, NOW,
    [["2026-10-25", "date", false], null, ["2026-10-26", "date", false]]],
  ["DST start: yesterday is 29.03.", [L(2026, 3, 28, 23), L(2026, 3, 29, 12), L(2026, 3, 30, 0, 10)], false, L(2026, 3, 30, 0, 30),
    [["2026-03-28", "date", false], ["2026-03-29", "yesterday", false], ["2026-03-30", "today", false]]],
  ["clock backwards (time jump): every change is a separator", [L(2026, 11, 10, 8), L(2026, 11, 9, 8), L(2026, 11, 10, 9)], false, NOW,
    [["2026-11-10", "today", false], ["2026-11-09", "yesterday", false], ["2026-11-10", "today", false]]],
];

const form = (markers) => markers.map((m) => (m ? [m.day, m.kind, m.withYear] : null));

async function loadWeb() {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  return import(pathToFileURL(path.join(out, "day-separator.js")).href);
}

function runIos() {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const imports = source.split("\n").filter((z) => /^import /.test(z));
  assert.deepEqual(imports, ["import Foundation"], "DaySeparator.swift imports only Foundation — otherwise it no longer runs alone here");
  const input = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(input, JSON.stringify(CASES.map(([, times, older, now]) => ({ times, older, now }))));
  const file = path.join(tmpDir(), "separator.swift");
  fs.writeFileSync(file, `${source}

// ── Driver (web/test/day-separator-binding.test.mjs) ──
let data = try! Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(input)}))
let cases = try! JSONSerialization.jsonObject(with: data) as! [[String: Any]]
var outData: [Any] = []
for f in cases {
    let times: [Double?] = (f["times"] as! [Any]).map { ($0 as? NSNumber)?.doubleValue }
    let m = DaySeparator.markers(times, olderBeforehand: f["older"] as! Bool, now: (f["now"] as! NSNumber).doubleValue)
    outData.append(m.map { x -> Any in x.map { [$0.day, $0.kind.rawValue, $0.withYear] as [Any] } ?? NSNull() })
}
print(String(data: try! JSONSerialization.data(withJSONObject: outData), encoding: .utf8)!)
`);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TZ: "Europe/Berlin" } });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  return JSON.parse(output.trim().split("\n").pop());
}

test("web: separators case by case — calendar day (DST), today/yesterday, year, window, unknown times", async () => {
  const web = await loadWeb();
  for (const [title, times, olderBeforehand, now, expected] of CASES) {
    const m = web.dayMarkers(times, { olderBeforehand, now });
    assert.equal(m.length, times.length, `${title}: one answer per row`);
    assert.deepEqual(form(m), expected, title);
  }
});

test("web: a shown separator never disappears when older rows are loaded (only the first row waits for the window)", async () => {
  const web = await loadWeb();
  const all = [L(2026, 11, 3, 8), L(2026, 11, 3, 9), L(2026, 11, 4, 8), L(2026, 11, 4, 9), L(2026, 11, 9, 8), L(2026, 11, 10, 8), L(2026, 11, 10, 9)];
  const full = web.dayMarkers(all, { olderBeforehand: false, now: NOW });
  for (let start = 1; start < all.length; start++) {
    const window = web.dayMarkers(all.slice(start), { olderBeforehand: true, now: NOW });
    window.forEach((m, i) => {
      if (m) assert.deepEqual(m, full[start + i], `window from ${start}, row ${i}: same separator as in the full history`);
      else if (i > 0) assert.equal(full[start + i], null, `window from ${start}, row ${i}: the full history has none here either`);
    });
    assert.equal(window[0], null, `window from ${start}: the first loaded row waits`);
  }
});

test("web: the time per bubble travels beside the bubbles (WeakMap) — new = now, replaced = inherited, without time stays without", async () => {
  const web = await loadWeb();
  const a = {}; const b = {}; const without = {};
  web.rememberTime(a, L(2026, 11, 9, 8));
  web.rememberTime(b, L(2026, 11, 10, 8) / 1000);
  web.rememberTime(a, L(2026, 11, 10, 9)); // the first report wins
  assert.equal(web.timeOfTheBubble(a), L(2026, 11, 9, 8));
  assert.equal(web.timeOfTheBubble(b), L(2026, 11, 10, 8), "seconds become ms");
  const prior = [a, without, b];
  const bCopy = { ...b }; const withoutCopy = { ...without }; const fresh = {};
  const afterValue = web.passOnTimes(prior, [a, withoutCopy, bCopy, fresh], NOW);
  assert.equal(web.timeOfTheBubble(afterValue[0]), L(2026, 11, 9, 8), "unchanged");
  assert.equal(web.timeOfTheBubble(withoutCopy), undefined, "a row without time does not retroactively get \"now\"");
  assert.equal(web.timeOfTheBubble(bCopy), L(2026, 11, 10, 8), "the copy at the same position inherits");
  assert.equal(web.timeOfTheBubble(fresh), NOW, "new behind the old end: now");
  assert.equal(web.passOnTimes(prior, prior, 1), prior, "same list: nothing to do");
});

test("iOS sets the same separators as the web, case by case (xcrun swift, TZ Europe/Berlin)", async () => {
  const web = await loadWeb();
  const ios = runIos();
  assert.equal(ios.length, CASES.length);
  CASES.forEach(([title, times, olderBeforehand, now], i) => {
    assert.deepEqual(ios[i], form(web.dayMarkers(times, { olderBeforehand, now })), `${title}: web and iOS differ`);
  });
});

test("the histories compute through these functions, and the time behind the figures carries no date any more", () => {
  const withoutComments = (q) => q.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const stage = withoutComments(read("web", "src", "components", "chat", "ChatStage.tsx"));
  assert.ok(stage.includes("dayMarkers(bubbles.map(timeOfTheBubble), { olderBeforehand: timeWindow.older, now: Date.now() })"), "ChatStage: separators over the loaded bubbles, with the window");
  assert.match(stage, /\{day && <DaySeparator key="day" marker=\{day\} \/>\}\s*<Contained key="row"/, "ChatStage: the separator stands BEFORE its bubble, outside the memory brake");
  const bubbles = withoutComments(read("web", "src", "components", "chat", "chatBubbles.ts"));
  assert.ok(bubbles.includes("rememberRow(bs[k], fromRow); rememberTime(bs[k], ofTime);"), "buildBubbles reports the time of the log row");
  assert.ok(bubbles.includes("return passOnTimes(bubbles, apply(bubbles, evt, ctx).bubbles, ctx.now);"), "the reducer passes the time on");
  const run = withoutComments(read("web", "src", "components", "chat", "RunDisplay.tsx"));
  assert.ok(run.includes("const endText = (at: number) => clockTime(at);"), "web: only the time of day behind the figures");
  assert.ok(!/toLocaleDateString/.test(run), "web: no date in the run display");
  const view = withoutComments(read("mobile", "CbaseMobile", "Chat", "ChatView.swift"));
  assert.ok(view.includes("DaySeparator.markers(visible.map(\\.at), olderBeforehand: model.logOlder, now: Date().timeIntervalSince1970 * 1000)"), "iOS: separators over the visible rows, with the window");
  assert.match(view, /rows\.append\(\.item\(item\)\)\s*if let day = days\[index\] \{ rows\.append\(\.day\(day, before: item\.id\)\) \}/, "iOS: in the inverted list BEHIND the row (= above it)");
  const timeline = withoutComments(read("mobile", "CbaseMobile", "Chat", "ChatViewModel+Timeline.swift"));
  assert.ok(timeline.includes("for k in fromRow..<result.count { result[k].at = ms }"), "iOS buildTimeline stamps the time of the log row");
  const loc = withoutComments(read("mobile", "CbaseMobile", "Kit", "Localization.swift"));
  const end = loc.slice(loc.indexOf("func locEndTime"), loc.indexOf("\n}\n", loc.indexOf("func locEndTime")));
  assert.ok(end.includes("\"HH:mm\"") && !/EEE|isDateInToday/.test(end), "iOS: only the time of day behind the figures");
  const en = read("web", "src", "lib", "i18n-de.ts");
  const enIos = fs.readdirSync(path.join(repo, "mobile", "CbaseMobile", "Kit")).filter((d) => /^LocDE.*\.swift$/.test(d)).map((d) => read("mobile", "CbaseMobile", "Kit", d)).join("\n");
  for (const k of ["Today", "Yesterday"]) {
    assert.ok(en.includes(`"${k}":`), `i18n-de.ts: ${k}`);
    assert.ok(enIos.includes(`"${k}":`), `LocDE*.swift: ${k}`);
  }
});
