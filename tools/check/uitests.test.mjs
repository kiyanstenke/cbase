// The verdicts of the iOS UI test run (`mobile --tests`): per parser and per rule one green case AND one red one — the counter-test. The fragments
// are real xcodebuild/uptime/ps/defaults outputs of this Mac (a full run), shortened, not invented.
//
// What is shown red here has happened once each: `-only-testing` on an old path reported SUCCEEDED with 0 tests; a class line was taken
// for the overall result; foreign load (`next dev`, a second xcodebuild) turned deadline tests red; skipped tests counted as green (a
// dead fixture ⇒ 145 skips ⇒ "ok"), the draft deletion hit the wrong domain, the warm-up test counted as "keyboard there" with a skip,
// duplicate --only identifiers gave a false red, and a runner crash without a named red test had no counter-test. One case per rule.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DIAGNOSTIC_SKIPS, LIVE_WALKTHROUGH, LOAD_LIMIT, MODULE, WARMUP, WARMUP_DEADLINE_MS, WARMUP_ATTEMPT_MIN_MS,
  completionWarning, deviationVerdict, bootTime, draftsResult, draftKey, draftPlist, expectation,
  foreignProcesses, isClassIdentifier, loadGateDecision, loadVerdict, normIdentifier, normIdentifiers,
  parseEnumeration, parseLsof,
  HW_KEYBOARD_MARKER, HW_KEYBOARD_PREDICATE, hwKeyboardInDevice, hwKeyboardPreference, hwKeyboardKey, logShowTime,
  parseTestRun, parseUptime, resolveSimulator, warmupNextAttempt, warmupVerdict, summary,
} from "./lib/uitests.mjs";
import { parseMobileArgs as parseArgs } from "./lib/mobile-args.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Fragments ───────────────────────────────────────────────────────────────────────

const ENUM = `Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project … -enumerate-tests -test-enumeration-style flat -test-enumeration-format text test-without-building

2026-09-15 16:29:44.481205+0200 CbaseMobileUITests-Runner[11642:36845906] [Default] Running tests...
    t =      nans Interface orientation changed to Portrait
Plan CbaseMobile
\tCbaseMobileUITests/AAAWarmupUITests/testKeyboardAppears()
\tCbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady()
\tCbaseMobileUITests/ChatComposerUITests/testChatAskCardAnswersWithOneTap()
\tCbaseMobileUITests/ChatRowsUITests/testSubagentMatrixInLoadedHistory()
\tCbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe()
\tCbaseMobileUITests/CbaseMobileUITests/testFullCategorySweepAgainstLiveGateway()
\tCbaseMobileUITests/AdministratorChannelUITests/testAdministratorHistoryAmFactAndBack()
`;
const ENUM_N = 7; // identifiers in ENUM, one of them the live walkthrough

// Two classes, outer suite `Selected tests` (that is its name with -skip-testing/-only-testing).
const RUN_FULL = `Test Suite 'Selected tests' started at 2026-09-15 18:17:22.396.
Test Suite 'CbaseMobileUITests.xctest' started at 2026-09-15 18:17:22.397.
Test Suite 'ChatComposerUITests' started at 2026-09-15 18:17:22.397.
Test Case '-[CbaseMobileUITests.ChatComposerUITests testAttachPanelKeepsComposerSteady]' started.
Test Case '-[CbaseMobileUITests.ChatComposerUITests testAttachPanelKeepsComposerSteady]' passed (29.557 seconds).
Test Case '-[CbaseMobileUITests.ChatComposerUITests testSlashPickerShowsCommandsAndSkillsAndSetsIn]' started.
/Users/maintainer/Documents/cbase/mobile/CbaseMobileUITests/Tests/ChatComposerUITests.swift:900: error: -[CbaseMobileUITests.ChatComposerUITests testSlashPickerShowsCommandsAndSkillsAndSetsIn] : XCTAssertTrue failed - The picker is missing
Test Case '-[CbaseMobileUITests.ChatComposerUITests testSlashPickerShowsCommandsAndSkillsAndSetsIn]' failed (25.247 seconds).
Test Suite 'ChatComposerUITests' failed at 2026-09-15 18:25:01.333.
\t Executed 2 tests, with 1 failure (0 unexpected) in 54.804 (54.810) seconds
Test Suite 'ChatStageUITests' started at 2026-09-15 18:33:37.597.
Test Case '-[CbaseMobileUITests.ChatStageUITests testKeyboardMotionRecordingProbe]' started.
/Users/maintainer/Documents/cbase/mobile/CbaseMobileUITests/Tests/ChatStageUITests.swift:640: -[CbaseMobileUITests.ChatStageUITests testKeyboardMotionRecordingProbe] : Test skipped - For video diagnostics only (CBASE_KEYBOARD_PROBE=1).
Test Case '-[CbaseMobileUITests.ChatStageUITests testKeyboardMotionRecordingProbe]' skipped (0.061 seconds).
Test Case '-[CbaseMobileUITests.ChatStageUITests testRunIndicatorStaysForTheWholeRun]' started.
Test Case '-[CbaseMobileUITests.ChatStageUITests testRunIndicatorStaysForTheWholeRun]' passed (41.2 seconds).
Test Suite 'ChatStageUITests' passed at 2026-09-15 18:42:54.465.
\t Executed 2 tests, with 1 test skipped and 0 failures (0 unexpected) in 41.261 (41.270) seconds
Test Suite 'CbaseMobileUITests.xctest' failed at 2026-09-15 19:21:41.257.
\t Executed 4 tests, with 1 test skipped and 1 failure (0 unexpected) in 96.065 (96.080) seconds
Test Suite 'Selected tests' failed at 2026-09-15 19:21:41.258.
\t Executed 4 tests, with 1 test skipped and 1 failure (0 unexpected) in 96.065 (96.081) seconds
2026-09-15 19:21:52.097 xcodebuild[93954:27129250] [MT] IDETestOperationsObserverDebug: 3872.373 elapsed -- Testing started completed.
** TEST EXECUTE FAILED **
`;

// The same run, ONLY the class line — this is what an aborted runner (or a truncated log) looks like. That must not count as a result.
const RUN_ONLY_CLASS = RUN_FULL.split("Test Suite 'CbaseMobileUITests.xctest' failed")[0] + "** TEST EXECUTE SUCCEEDED **\n";

// The old identifier path: SUCCEEDED with zero tests (lines verbatim from a real run).
const RUN_NULL = `Test Suite 'Selected tests' started at 2026-09-15 11:30:56.165.
Test Suite 'CbaseMobileUITests.xctest' started at 2026-09-15 11:30:56.165.
Test Suite 'CbaseMobileUITests.xctest' passed at 2026-09-15 11:30:56.170.
\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.000) seconds
Test Suite 'Selected tests' passed at 2026-09-15 11:30:56.171.
\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds
** TEST EXECUTE SUCCEEDED **
`;

const RUN_ALL = `Test Suite 'All tests' started at 2026-09-15 11:30:56.165.
Test Suite 'CbaseMobileUITests.xctest' started at 2026-09-15 11:30:56.165.
Test Suite 'AAAWarmupUITests' started at 2026-09-15 11:30:56.165.
Test Case '-[CbaseMobileUITests.AAAWarmupUITests testKeyboardAppears]' started.
Test Case '-[CbaseMobileUITests.AAAWarmupUITests testKeyboardAppears]' passed (12.5 seconds).
Test Suite 'AAAWarmupUITests' passed at 2026-09-15 11:31:10.000.
\t Executed 1 test, with 0 failures (0 unexpected) in 12.500 (12.510) seconds
Test Suite 'CbaseMobileUITests.xctest' passed at 2026-09-15 11:31:10.000.
\t Executed 1 test, with 0 failures (0 unexpected) in 12.500 (12.510) seconds
Test Suite 'All tests' passed at 2026-09-15 11:31:10.001.
\t Executed 1 test, with 0 failures (0 unexpected) in 12.500 (12.511) seconds
** TEST EXECUTE SUCCEEDED **
`;

const UPTIME_MAC = "21:30  up 11 days, 20:24, 1 user, load averages: 2.41 2.32 2.32\n";
const UPTIME_LINUX = " 21:30:01 up 11 days, 20:24,  1 user,  load average: 3.50, 2.10, 1.90\n";

const DD = "/Users/maintainer/Library/Developer/Xcode/DerivedData/CbaseMobile-UITests";
const PS_QUIET = ` 84.8 59951 /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c
  3.1   512 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores
  0.5  9001 node /Users/maintainer/Documents/cbase/tools/deploy/deploy.mjs mobile --tests
  0.0  9002 ps -Ao %cpu=,pid=,command=
  0.0  1234 /Applications/Xcode.app/Contents/SharedFrameworks/XCBuild.framework/Versions/A/PlugIntoThe/XCBBuildService.bundle/Contents/MacOS/XCBBuildService
`;
const PS_NEXT = `${PS_QUIET} 12.0  7777 node /Users/maintainer/Documents/cbase/web/node_modules/.bin/next dev
  0.4  7778 next-server (v15.3.1)
`;
const PS_XCODEBUILD_FOREIGN = `${PS_QUIET} 40.0  8888 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project /Users/maintainer/Documents/cbase/mobile/CbaseMobile.xcodeproj -derivedDataPath /Users/maintainer/Library/Developer/Xcode/DerivedData/CbaseMobile-Codex build-for-testing
`;
const PS_XCODEBUILD_OWN = `${PS_QUIET} 40.0  8889 xcodebuild -project /Users/maintainer/Documents/cbase/mobile/CbaseMobile.xcodeproj -derivedDataPath ${DD} test-without-building
`;
const PS_MDS = `${PS_QUIET}142.3   513 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores
`;

const DEFAULTS = `{
    "cbase.mobile.draft:20000000-0000-4000-8000-000000000001" = "/Edge-testEdgetestrelease-notes";
    "cbase.mobile.draft:new:10000000-0000-4000-8000-000000000001:coding" = Codingdraft;
    "cbase.mobile.server" = "http://127.0.0.1:17718";
    "cbase.mobile.ws" = "10000000-0000-4000-8000-000000000001";
}
`;

const SIMCTL = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      { udid: "8084DFCF-B6F9-417D-986E-5B29DC292244", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
      { udid: "11111111-2222-4333-8444-555555555555", name: "iPhone 17", state: "Booted", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: "11111111-1111-4111-8111-111111111111", name: "iPhone 17", state: "Shutdown", isAvailable: true },
      { udid: "22222222-2222-4222-8222-222222222222", name: "iPhone 16", state: "Shutdown", isAvailable: false },
    ],
  },
};

const PS_LSTART = `Tue Sep 15 14:47:52 2026     55741 launchd_sim /Users/maintainer/Library/Developer/CoreSimulator/Devices/11111111-2222-4333-8444-555555555555/data/var/run/launchd_bootstrap.plist
Tue Sep 15 09:00:00 2026       512 /usr/libexec/something
`;

// ── Identifiers ────────────────────────────────────────────────────────────────────────

test("parseEnumeration: only the indented identifier lines, without `()`, without plan/runner lines", () => {
  assert.deepEqual(parseEnumeration(ENUM), [
    "CbaseMobileUITests/AAAWarmupUITests/testKeyboardAppears",
    "CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady",
    "CbaseMobileUITests/ChatComposerUITests/testChatAskCardAnswersWithOneTap",
    "CbaseMobileUITests/ChatRowsUITests/testSubagentMatrixInLoadedHistory",
    "CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe",
    "CbaseMobileUITests/CbaseMobileUITests/testFullCategorySweepAgainstLiveGateway",
    "CbaseMobileUITests/AdministratorChannelUITests/testAdministratorHistoryAmFactAndBack",
  ]);
  assert.ok(parseEnumeration(ENUM).includes(WARMUP), "the warm-up test is in the enumeration");
});

test("parseEnumeration (red): runner chatter without identifiers ⇒ empty list", () => {
  assert.deepEqual(parseEnumeration("Plan CbaseMobile\n   t = nans Interface orientation changed\n"), []);
  assert.deepEqual(parseEnumeration(""), []);
});

test("expectation: all identifiers minus the live walkthrough — the walkthrough is NOT in the expectation", () => {
  const e = expectation(parseEnumeration(ENUM));
  assert.equal(e.list.length, ENUM_N - 1);
  assert.ok(!e.list.includes(LIVE_WALKTHROUGH));
  assert.deepEqual(e.unknown, []);
});

test("expectation with --only: exactly the wanted ones, normalised; an unknown one is named", () => {
  const all = parseEnumeration(ENUM);
  const ok = expectation(all, { only: ["ChatComposerUITests/testAttachPanelKeepsComposerSteady()"] });
  assert.deepEqual(ok.list, ["CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"]);
  assert.deepEqual(ok.unknown, []);
  // The OLD path without a class: does not exist — and would silently "pass" with 0 tests.
  const old = expectation(all, { only: ["CbaseMobileUITests/CbaseMobileUITests/testAttachPanelKeepsComposerSteady"] });
  assert.deepEqual(old.unknown, ["CbaseMobileUITests/CbaseMobileUITests/testAttachPanelKeepsComposerSteady"]);
});

test("normIdentifier: add the module prefix, cut `()`, empty stays empty", () => {
  assert.equal(normIdentifier("ShellUITests/testX()"), "CbaseMobileUITests/ShellUITests/testX");
  assert.equal(normIdentifier("CbaseMobileUITests/ShellUITests/testX"), "CbaseMobileUITests/ShellUITests/testX");
  assert.equal(normIdentifier("  "), "");
});

// ── Test run parser ────────────────────────────────────────────────────────────────────────

test("parseTestRun: outer suite `Selected tests` counts — Executed, skips, red list, duration per test", () => {
  const p = parseTestRun(RUN_FULL);
  assert.ok(p.total, "the outer Executed line was found");
  assert.equal(p.total.suite, "Selected tests");
  assert.equal(p.total.executed, 4);
  assert.equal(p.total.skipped, 1);
  assert.equal(p.total.failures, 1);
  assert.equal(p.total.unexpected, 0);
  assert.equal(p.total.durationS, 96.065);
  assert.deepEqual(p.red, ["CbaseMobileUITests/ChatComposerUITests/testSlashPickerShowsCommandsAndSkillsAndSetsIn"]);
  assert.deepEqual(p.skips, ["CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe"]);
  assert.deepEqual(p.passed, [
    "CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady",
    "CbaseMobileUITests/ChatStageUITests/testRunIndicatorStaysForTheWholeRun",
  ]);
  assert.equal(p.durationPerTest["CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"], 29.557);
  assert.equal(p.durationPerTest["CbaseMobileUITests/ChatStageUITests/testRunIndicatorStaysForTheWholeRun"], 41.2);
  assert.equal(p.classes.length, 2, "the class lines stand beside it, not in the total");
  assert.equal(p.classes[0].suite, "ChatComposerUITests");
  assert.equal(p.succeeded, false);
  assert.equal(p.failedMarker, true);
});

test("parseTestRun: `All tests` (without -skip/-only) is also the outer suite; the singular \"1 test, 1 failure\" is read", () => {
  const p = parseTestRun(RUN_ALL);
  assert.equal(p.total?.suite, "All tests");
  assert.equal(p.total.executed, 1);
  assert.equal(p.succeeded, true);
  const s = parseTestRun("Test Suite 'Selected tests' failed at x.\n\t Executed 1 test, with 1 failure (0 unexpected) in 35.846 (35.848) seconds\n");
  assert.equal(s.total.executed, 1);
  assert.equal(s.total.failures, 1);
});

test("parseTestRun (red): a class line alone is NO result — total stays null", () => {
  const p = parseTestRun(RUN_ONLY_CLASS);
  assert.equal(p.total, null);
  assert.equal(p.classes.length, 2, "the class lines are read, but only as classes");
  assert.equal(p.classes[0].executed + p.classes[1].executed, 4, "the sum of the classes would be the right number — and still does not count");
  assert.equal(p.succeeded, true, "and a SUCCEEDED marker does not turn it into a result");
});

// ── Deviation verdict ───────────────────────────────────────────────────────────────────────

test("deviationVerdict: Executed == expectation and nothing red ⇒ ok", () => {
  const u = deviationVerdict({ run: parseTestRun(RUN_ALL), expected: [WARMUP] });
  assert.equal(u.ok, true);
  assert.equal(u.executed, 1);
  assert.equal(u.expected, 1);
  assert.equal(u.reason, null);
});

test("deviationVerdict (red): old identifier path — SUCCEEDED with 0 tests ≠ expected 1 ⇒ not ok", () => {
  const p = parseTestRun(RUN_NULL);
  assert.equal(p.succeeded, true, "xcodebuild itself reports success");
  const u = deviationVerdict({ run: p, expected: 1 });
  assert.equal(u.ok, false);
  assert.equal(u.executed, 0);
  assert.match(u.reason, /Executed 0 ≠ expected 1/);
  assert.match(u.reason, /wrong identifier/);
});

test("deviationVerdict (red): wrong number (143 instead of 144) ⇒ deviation, even without red", () => {
  const run = { total: { executed: 143, failures: 0, unexpected: 0, skipped: 5, durationS: 3800 }, red: [], succeeded: true, failedMarker: false };
  const u = deviationVerdict({ run, expected: new Array(144).fill("x") });
  assert.equal(u.ok, false);
  assert.match(u.reason, /Executed 143 ≠ expected 144/);
});

test("deviationVerdict (red): right number, but a red test ⇒ not ok, name in the reason", () => {
  const u = deviationVerdict({ run: parseTestRun(RUN_FULL), expected: 4 });
  assert.equal(u.ok, false);
  assert.equal(u.executed, 4);
  assert.match(u.reason, /1 red: CbaseMobileUITests\/ChatComposerUITests\/testSlashPickerShowsCommandsAndSkillsAndSetsIn/);
});

test("deviationVerdict (red): without an outer closing line ⇒ not ok, Executed null", () => {
  const u = deviationVerdict({ run: parseTestRun(RUN_ONLY_CLASS), expected: 2 });
  assert.equal(u.ok, false);
  assert.equal(u.executed, null);
  assert.match(u.reason, /no closing line/);
});

// ── Load gate ──────────────────────────────────────────────────────────────────────────

test("parseUptime: macOS (\"load averages: a b c\") and Linux (\"load average: a, b, c\"); garbage ⇒ null", () => {
  assert.equal(parseUptime(UPTIME_MAC), 2.41);
  assert.equal(parseUptime(UPTIME_LINUX), 3.5);
  assert.equal(parseUptime("nothing here"), null);
  assert.equal(parseUptime(""), null);
});

test("loadVerdict: load 2.41 and only own/harmless processes ⇒ ok", () => {
  const u = loadVerdict({ uptime: UPTIME_MAC, ps: PS_QUIET, derivedData: DD });
  assert.equal(u.ok, true, u.reason);
  assert.equal(u.load1, 2.41);
  assert.deepEqual(u.foreign, []);
});

test("loadVerdict (red): load 3.5 ⇒ wait (not ok), the reason names the limit", () => {
  const u = loadVerdict({ uptime: UPTIME_LINUX, ps: PS_QUIET, derivedData: DD });
  assert.equal(u.ok, false);
  assert.match(u.reason, new RegExp(`Load 3\\.50 ≥ ${LOAD_LIMIT}`));
});

test("loadVerdict (red): load low, but a foreign `next dev` ⇒ wait", () => {
  const u = loadVerdict({ uptime: UPTIME_MAC, ps: PS_NEXT, derivedData: DD });
  assert.equal(u.ok, false);
  assert.deepEqual(u.foreign.map((f) => [f.pid, f.reason]), [[7777, "next dev"], [7778, "next-server"]]);
  assert.match(u.reason, /2 foreign/);
});

// `foreignProcesses` discards `next dev`/`next-server` WITHOUT a CPU threshold. If the dev server of a FOREIGN project runs on the Mac
// (for hours, plus a parallel agent measuring it), the gate is not "not yet met" but NEVER satisfiable — `mobile --tests` would not be
// runnable on this machine. `--force` is the documented way out, WITH a log.
test("loadGateDecision: clean ⇒ go on (also with --force, and without the \"forced\" marker)", () => {
  const clean = loadVerdict({ uptime: UPTIME_MAC, ps: PS_QUIET, derivedData: DD });
  for (const force of [false, true]) {
    const e = loadGateDecision({ verdict: clean, elapsedS: 0, waitS: 600, force });
    assert.equal(e.action, "further");
    assert.equal(e.forced, false);
    assert.equal(e.reason, null);
  }
});

test("loadGateDecision: not clean, deadline running ⇒ wait (also with --force)", () => {
  const loud = loadVerdict({ uptime: UPTIME_MAC, ps: PS_NEXT, derivedData: DD });
  for (const force of [false, true]) {
    const e = loadGateDecision({ verdict: loud, elapsedS: 599, waitS: 600, force });
    assert.equal(e.action, "wait", `force=${force}`);
    assert.equal(e.forced, false);
    assert.match(e.reason, /2 foreign/);
  }
});

test("loadGateDecision (red): deadline over, NO --force ⇒ abort with the measured reason", () => {
  const loud = loadVerdict({ uptime: UPTIME_MAC, ps: PS_NEXT, derivedData: DD });
  const e = loadGateDecision({ verdict: loud, elapsedS: 600, waitS: 600, force: false });
  assert.equal(e.action, "abort");
  assert.equal(e.forced, false);
  assert.match(e.reason, /next dev \[7777\]/);
});

test("loadGateDecision: deadline over WITH --force ⇒ force, and the marker is set", () => {
  const loud = loadVerdict({ uptime: UPTIME_LINUX, ps: PS_NEXT, derivedData: DD });
  const e = loadGateDecision({ verdict: loud, elapsedS: 900, waitS: 600, force: true });
  assert.equal(e.action, "force");
  assert.equal(e.forced, true, "a forced green must never look like a clean one");
  assert.match(e.reason, /Load 3\.50/);
});

test("loadGateDecision (red): without a measurement (load not readable) it does not silently carry on", () => {
  const blind = loadVerdict({ uptime: "no uptime", ps: PS_QUIET, derivedData: DD });
  assert.equal(blind.ok, false);
  assert.equal(loadGateDecision({ verdict: blind, elapsedS: 700, waitS: 600, force: false }).action, "abort");
  // and `verdict: null` (measurement failed entirely) is no "go on" either
  const without = loadGateDecision({ verdict: null, elapsedS: 700, waitS: 600, force: false });
  assert.equal(without.action, "abort");
  assert.match(without.reason, /not measured/);
});

test("--force reaches `mobile --tests` (parseMobileArgs)", () => {
  const o = parseArgs(["mobile", "--tests", "--force", "--only", "CbaseMobileUITests/ShellUITests/testX"]);
  assert.equal(o.mobileTests, true);
  assert.equal(o.force, true);
  assert.deepEqual(o.only, ["CbaseMobileUITests/ShellUITests/testX"]);
  assert.equal(parseArgs(["mobile", "--tests"]).force, false);
});

test("foreignProcesses: xcodebuild of another tree is called \"foreign tree\", the own DerivedData \"second run?\"", () => {
  const foreign = foreignProcesses(PS_XCODEBUILD_FOREIGN, { derivedData: DD });
  assert.deepEqual(foreign.map((f) => [f.pid, f.reason]), [[8888, "xcodebuild (foreign tree)"]]);
  const own = foreignProcesses(PS_XCODEBUILD_OWN, { derivedData: DD });
  assert.deepEqual(own.map((f) => [f.pid, f.reason]), [[8889, "xcodebuild (own DerivedData — a second run?)"]]);
});

test("foreignProcesses: mds_stores counts only above 100 % CPU; swift-frontend/XCBBuildService never", () => {
  assert.deepEqual(foreignProcesses(PS_QUIET, { derivedData: DD }), []);
  const mds = foreignProcesses(PS_MDS, { derivedData: DD });
  assert.deepEqual(mds.map((f) => [f.pid, f.reason]), [[513, "mds_stores 142 % CPU"]]);
});

// ── Simulator, boot, drafts, port ──────────────────────────────────────────────────────────

test("resolveSimulator: name → the booted one among same-named; \"iPhone 17 Pro\" is another device", () => {
  const s = resolveSimulator(SIMCTL, "iPhone 17");
  assert.equal(s?.udid, "11111111-2222-4333-8444-555555555555");
  assert.equal(s.state, "Booted");
  assert.equal(s.runtime, "iOS-26-5");
});

test("resolveSimulator: UDID directly; unknown name ⇒ null; unavailable devices drop out", () => {
  assert.equal(resolveSimulator(SIMCTL, "11111111-1111-4111-8111-111111111111")?.name, "iPhone 17");
  assert.equal(resolveSimulator(SIMCTL, "iPhone 99"), null);
  assert.equal(resolveSimulator(SIMCTL, "iPhone 16"), null, "isAvailable:false does not count");
  assert.equal(resolveSimulator(null, "iPhone 17"), null);
});

test("bootTime: from the lstart of launchd_sim with our UDID; without a row ⇒ null", () => {
  const t = bootTime(PS_LSTART, "11111111-2222-4333-8444-555555555555");
  assert.ok(t instanceof Date);
  assert.equal(t.getTime(), new Date(2026, 8, 15, 14, 47, 52).getTime());
  assert.equal(bootTime(PS_LSTART, "11111111-1111-4111-8111-111111111111"), null);
  assert.equal(bootTime("", "11111111-2222-4333-8444-555555555555"), null);
});

test("draftKey: only the keys with the draft prefix — both forms (chat and new:…)", () => {
  assert.deepEqual(draftKey(DEFAULTS), [
    "cbase.mobile.draft:20000000-0000-4000-8000-000000000001",
    "cbase.mobile.draft:new:10000000-0000-4000-8000-000000000001:coding",
  ]);
});

test("draftKey (red): missing domain or foreign keys ⇒ nothing to delete", () => {
  assert.deepEqual(draftKey("2026-09-15 21:30:00.000 defaults[1234:5678]\nDomain dev.cbase.mobile does not exist\n"), []);
  assert.deepEqual(draftKey('{\n    "cbase.mobile.server" = "http://127.0.0.1:17718";\n}\n'), []);
});

test("parseLsof: `-Fpc` ⇒ PID and command; empty ⇒ nobody listens", () => {
  assert.deepEqual(parseLsof("p60183\ncnode\nf14\n"), [{ pid: 60183, comm: "node" }]);
  assert.deepEqual(parseLsof(""), []);
});

// ── Summary ──────────────────────────────────────────────────────────────────────────────────

test("summary: carries Executed, expectation, red list, skips, duration per test, mode", () => {
  const parsed = parseTestRun(RUN_FULL);
  const verdict = deviationVerdict({ run: parsed, expected: 4 });
  const z = summary({ stamp: "s", expected: ["a", "b", "c", "d"], parsed, verdict, totalDurationS: 100, fixturePid: 42 });
  assert.equal(z.mode, "full");
  assert.equal(z.executed, 4);
  assert.equal(z.expected, 4);
  assert.equal(z.ok, false);
  assert.equal(z.red.length, 1);
  assert.equal(z.skips.length, 1);
  assert.equal(z.passed, 2);
  assert.equal(z.totalDurationS, 100);
  assert.equal(z.fixturePid, 42);
  assert.equal(Object.keys(z.durationPerTest).length, 4);
  assert.equal(summary({ stamp: "s", only: [WARMUP], parsed, verdict }).mode, "only");
});

// ── deploy.mjs: the arguments belong to `mobile` ───────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Skips in the verdict, warm-up test, --only duplicates/classes, draft domain, runner crash, LC_ALL, xcresult, --wait default. Fragments
// from real runs, skip texts verbatim from the Swift tests.
// ═══════════════════════════════════════════════════════════════════════════════════

// One line per case in the baseline's format: skip reason line, then the test case line.
const skipRows = (kind, test, reason, file = "ChatStageUITests.swift", row = 640) =>
  `Test Case '-[CbaseMobileUITests.${kind} ${test}]' started.\n`
  + `/Users/maintainer/Documents/cbase/mobile/CbaseMobileUITests/Tests/${file}:${row}: -[CbaseMobileUITests.${kind} ${test}] : Test skipped - ${reason}\n`
  + `Test Case '-[CbaseMobileUITests.${kind} ${test}]' skipped (0.061 seconds).\n`;
const passRows = (kind, test, s = "20.0") =>
  `Test Case '-[CbaseMobileUITests.${kind} ${test}]' started.\n`
  + `Test Case '-[CbaseMobileUITests.${kind} ${test}]' passed (${s} seconds).\n`;
const completion = (n, skipped, failures, result = failures ? "failed" : "passed") =>
  `Test Suite 'CbaseMobileUITests.xctest' ${result} at 2026-09-16 10:00:00.000.\n`
  + `\t Executed ${n} test${n === 1 ? "" : "s"}, with ${skipped ? `${skipped} test${skipped === 1 ? "" : "s"} skipped and ` : ""}${failures} failure${failures === 1 ? "" : "s"} (0 unexpected) in 100.000 (100.010) seconds\n`
  + `Test Suite 'Selected tests' ${result} at 2026-09-16 10:00:00.001.\n`
  + `\t Executed ${n} test${n === 1 ? "" : "s"}, with ${skipped ? `${skipped} test${skipped === 1 ? "" : "s"} skipped and ` : ""}${failures} failure${failures === 1 ? "" : "s"} (0 unexpected) in 100.000 (100.011) seconds\n`
  + `** TEST EXECUTE ${failures ? "FAILED" : "SUCCEEDED"} **\n`;
const HEADER = "Test Suite 'Selected tests' started at 2026-09-16 10:00:00.000.\nTest Suite 'CbaseMobileUITests.xctest' started at 2026-09-16 10:00:00.000.\n";

// (a) The fixture dies after step 2: requireFixture() throws XCTSkip in EVERY test — three tests suffice to show the pattern (real: 145).
// xcodebuild: SUCCEEDED, 0 failures.
const FIXTURE_TOT = "Local fixture gateway is not running at http://127.0.0.1:17718.";
const RUN_FIXTURE_TOT = HEADER
  + "Test Suite 'AAAWarmupUITests' started at 2026-09-16 10:00:00.000.\n"
  + skipRows("AAAWarmupUITests", "testKeyboardAppears", FIXTURE_TOT, "CbaseUITestBase.swift", 480)
  + "Test Suite 'AAAWarmupUITests' passed at 2026-09-16 10:00:01.000.\n\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 0.100 (0.110) seconds\n"
  + "Test Suite 'ChatComposerUITests' started at 2026-09-16 10:00:01.000.\n"
  + skipRows("ChatComposerUITests", "testAttachPanelKeepsComposerSteady", FIXTURE_TOT, "CbaseUITestBase.swift", 480)
  + skipRows("ChatComposerUITests", "testChatAskCardAnswersWithOneTap", FIXTURE_TOT, "CbaseUITestBase.swift", 480)
  + "Test Suite 'ChatComposerUITests' passed at 2026-09-16 10:00:02.000.\n\t Executed 2 tests, with 2 tests skipped and 0 failures (0 unexpected) in 0.200 (0.210) seconds\n"
  + completion(3, 3, 0);

// (b) The software keyboard vanishes in the middle of the run: testAttachPanelKeepsComposerSteady skips itself (text from
// ChatComposerUITests.swift:363), next to it an ALLOWED diagnostic skip.
const KEYBOARD_WAY = "Without a software keyboard in the simulator the keyboard phase cannot be checked";
const RUN_KEYBOARD_SKIP = HEADER
  + "Test Suite 'ChatComposerUITests' started at 2026-09-16 10:00:00.000.\n"
  + skipRows("ChatComposerUITests", "testAttachPanelKeepsComposerSteady", KEYBOARD_WAY, "ChatComposerUITests.swift", 363)
  + passRows("ChatComposerUITests", "testChatAskCardAnswersWithOneTap")
  + "Test Suite 'ChatComposerUITests' passed at 2026-09-16 10:00:20.000.\n\t Executed 2 tests, with 1 test skipped and 0 failures (0 unexpected) in 20.000 (20.010) seconds\n"
  + "Test Suite 'ChatStageUITests' started at 2026-09-16 10:00:20.000.\n"
  + skipRows("ChatStageUITests", "testKeyboardMotionRecordingProbe", "For video diagnostics only (CBASE_KEYBOARD_PROBE=1).")
  + "Test Suite 'ChatStageUITests' passed at 2026-09-16 10:00:21.000.\n\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 0.100 (0.110) seconds\n"
  + completion(3, 2, 0);
// The same run, without the keyboard skip (the test ran): only the diagnostic skip remains ⇒ green.
const RUN_ONLY_DIAGNOSTIC_SKIP = HEADER
  + "Test Suite 'ChatComposerUITests' started at 2026-09-16 10:00:00.000.\n"
  + passRows("ChatComposerUITests", "testAttachPanelKeepsComposerSteady", "29.5")
  + passRows("ChatComposerUITests", "testChatAskCardAnswersWithOneTap")
  + "Test Suite 'ChatComposerUITests' passed at 2026-09-16 10:00:50.000.\n\t Executed 2 tests, with 0 failures (0 unexpected) in 49.500 (49.510) seconds\n"
  + "Test Suite 'ChatStageUITests' started at 2026-09-16 10:00:50.000.\n"
  + skipRows("ChatStageUITests", "testKeyboardMotionRecordingProbe", "For video diagnostics only (CBASE_KEYBOARD_PROBE=1).")
  + "Test Suite 'ChatStageUITests' passed at 2026-09-16 10:00:51.000.\n\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 0.100 (0.110) seconds\n"
  + completion(3, 1, 0);

// (c) The warm-up test itself skips (fixture dead) — xcodebuild: SUCCEEDED, Executed 1.
const RUN_WARMUP_SKIP = HEADER
  + "Test Suite 'AAAWarmupUITests' started at 2026-09-16 10:00:00.000.\n"
  + skipRows("AAAWarmupUITests", "testKeyboardAppears", FIXTURE_TOT, "CbaseUITestBase.swift", 480)
  + "Test Suite 'AAAWarmupUITests' passed at 2026-09-16 10:00:01.000.\n\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 0.100 (0.110) seconds\n"
  + completion(1, 1, 0);
const RUN_WARMUP_RED = HEADER
  + "Test Suite 'AAAWarmupUITests' started at 2026-09-16 10:00:00.000.\n"
  + "Test Case '-[CbaseMobileUITests.AAAWarmupUITests testKeyboardAppears]' started.\n"
  + "/Users/maintainer/Documents/cbase/mobile/CbaseMobileUITests/Tests/AAAWarmupUITests.swift:44: error: -[CbaseMobileUITests.AAAWarmupUITests testKeyboardAppears] : XCTAssertTrue failed - The software keyboard did not appear within 60 s — simulator freshly booted?\n"
  + "Test Case '-[CbaseMobileUITests.AAAWarmupUITests testKeyboardAppears]' failed (95.2 seconds).\n"
  + "Test Suite 'AAAWarmupUITests' failed at 2026-09-16 10:01:36.000.\n\t Executed 1 test, with 1 failure (0 unexpected) in 95.200 (95.210) seconds\n"
  + completion(1, 0, 1);

// (h4) Runner crash: the closing line counts a failure, but no test case line is "failed" (the runner died between start and result)
// — "1 unexpected" is possible then too.
const RUN_CRASH = HEADER
  + "Test Suite 'ChatComposerUITests' started at 2026-09-16 10:00:00.000.\n"
  + passRows("ChatComposerUITests", "testAttachPanelKeepsComposerSteady")
  + "Test Case '-[CbaseMobileUITests.ChatComposerUITests testChatAskCardAnswersWithOneTap]' started.\n"
  + "Test Suite 'ChatComposerUITests' failed at 2026-09-16 10:00:40.000.\n\t Executed 2 tests, with 1 failure (1 unexpected) in 40.000 (40.010) seconds\n"
  + "Test Suite 'CbaseMobileUITests.xctest' failed at 2026-09-16 10:00:40.000.\n\t Executed 2 tests, with 1 failure (1 unexpected) in 40.000 (40.010) seconds\n"
  + "Test Suite 'Selected tests' failed at 2026-09-16 10:00:40.001.\n\t Executed 2 tests, with 1 failure (1 unexpected) in 40.000 (40.011) seconds\n"
  + "** TEST EXECUTE FAILED **\n";

// A REAL --only run, shortened: Executed 1, xcresult line, SUCCEEDED.
const RUN_ONLY_REAL = `Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project /Users/maintainer/Documents/cbase/mobile/CbaseMobile.xcodeproj -scheme CbaseMobile -destination "platform=iOS Simulator,id=11111111-2222-4333-8444-555555555555" -derivedDataPath /Users/maintainer/Library/Developer/Xcode/DerivedData/CbaseMobile-UITests -resultBundlePath /private/tmp/claude-501/scratchpad/wackler/w1/finalMatrix-1.xcresult "-only-testing:CbaseMobileUITests/ChatRowsUITests/testSubagentMatrixInLoadedHistory" test-without-building

Writing result bundle at path:
\t/private/tmp/claude-501/scratchpad/wackler/w1/finalMatrix-1.xcresult

2026-09-16 01:38:49.820100+0200 CbaseMobileUITests-Runner[94407:38545584] [Default] Running tests...
    t =      nans Interface orientation changed to Portrait
Test Suite 'Selected tests' started at 2026-09-16 01:38:50.392.
Test Suite 'CbaseMobileUITests.xctest' started at 2026-09-16 01:38:50.392.
Test Suite 'ChatRowsUITests' started at 2026-09-16 01:38:50.392.
Test Case '-[CbaseMobileUITests.ChatRowsUITests testSubagentMatrixInLoadedHistory]' started.
    t =     0.00s Start Test at 2026-09-16 01:38:50.393
    t =     0.09s Set Up
Test Case '-[CbaseMobileUITests.ChatRowsUITests testSubagentMatrixInLoadedHistory]' passed (36.423 seconds).
Test Suite 'ChatRowsUITests' passed at 2026-09-16 01:39:26.817.
\t Executed 1 test, with 0 failures (0 unexpected) in 36.423 (36.425) seconds
Test Suite 'CbaseMobileUITests.xctest' passed at 2026-09-16 01:39:26.818.
\t Executed 1 test, with 0 failures (0 unexpected) in 36.423 (36.426) seconds
Test Suite 'Selected tests' passed at 2026-09-16 01:39:26.819.
\t Executed 1 test, with 0 failures (0 unexpected) in 36.423 (36.427) seconds
2026-09-16 01:39:37.123 xcodebuild[94391:38545432] [MT] IDETestOperationsObserverDebug: 47.891 elapsed -- Testing started completed.

Test session results, code coverage, and logs:
\t/tmp/claude-501/scratchpad/wackler/w1/finalMatrix-1.xcresult

** TEST EXECUTE SUCCEEDED **
`;

// (h1) German locale: macOS writes the comma — in `uptime` and in the %cpu column of `ps`.
const UPTIME_COMMA = "10:12  up 12 days,  9:06, 1 user, load averages: 2,95 3,15 3,31\n";
const PS_COMMA = ` 84,8 59951 /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c
142,3   513 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores
 12,0  7777 node /Users/maintainer/Documents/cbase/web/node_modules/.bin/next dev
`;

// `simctl get_app_container <udid> <bundle> data` — installed or not.
const BUNDLE = "dev.cbase.mobile";
const CONTAINER_OK = "/Users/maintainer/Library/Developer/CoreSimulator/Devices/11111111-2222-4333-8444-555555555555/data/Containers/Data/Application/0F0B2C7E-1A2B-4C3D-8E9F-0A1B2C3D4E5F\n";
const CONTAINER_MISSING = "No such file or directory\n";
const PLIST_OK = `${CONTAINER_OK.trim()}/Library/Preferences/${BUNDLE}.plist`;
// `defaults read <path>` with a missing file (the app has not written anything yet).
const DEFAULTS_NO_FILE = `2026-09-16 10:12:00.000 defaults[4242:7]\nDomain ${PLIST_OK} does not exist\n`;

// ── Skips in the verdict ──────────────────────────────────────────────────────────────────────────

test("DIAGNOSTIC_SKIPS: exactly the five env-gated tests of the baseline, as full identifiers", () => {
  assert.equal(DIAGNOSTIC_SKIPS.length, 5);
  for (const k of DIAGNOSTIC_SKIPS) assert.equal(k.split("/").length, 3, k);
  assert.ok(DIAGNOSTIC_SKIPS.includes("CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe"));
  assert.ok(DIAGNOSTIC_SKIPS.includes("CbaseMobileUITests/ChatTextUITests/testSendPerformanceProbe"));
  assert.ok(!DIAGNOSTIC_SKIPS.includes(WARMUP));
});

test("parseTestRun: the skip REASON is read (line before the test case line), per identifier", () => {
  const p = parseTestRun(RUN_KEYBOARD_SKIP);
  assert.deepEqual(p.skips, [
    "CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady",
    "CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe",
  ]);
  assert.equal(p.skipReasons["CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"], KEYBOARD_WAY);
  assert.equal(p.skipReasons["CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe"], "For video diagnostics only (CBASE_KEYBOARD_PROBE=1).");
  assert.equal(parseTestRun(RUN_FULL).skipReasons["CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe"], "For video diagnostics only (CBASE_KEYBOARD_PROBE=1).");
});

test("deviationVerdict (red, fixture skip): 3 tests, 3 skipped, 0 failures, SUCCEEDED ⇒ NOT ok, the reason names the dead fixture", () => {
  const p = parseTestRun(RUN_FIXTURE_TOT);
  assert.equal(p.succeeded, true, "xcodebuild itself reports success — that is exactly the trap");
  assert.equal(p.total.failures, 0);
  assert.equal(p.total.skipped, 3);
  const u = deviationVerdict({ run: p, expected: 3 });
  assert.equal(u.ok, false);
  assert.equal(u.executed, 3, "the number is right — the verdict falls on the skips");
  assert.equal(u.skipsDisallowed.length, 3);
  assert.match(u.reason, /3 skipped, but not a diagnostic skip/);
  assert.match(u.reason, /testKeyboardAppears — Local fixture gateway is not running at http:\/\/127\.0\.0\.1:17718\./);
});

test("deviationVerdict (red, keyboard skip): a product test skips itself in the full run ⇒ not ok; the same run with only the diagnostic skip ⇒ ok", () => {
  const red = deviationVerdict({ run: parseTestRun(RUN_KEYBOARD_SKIP), expected: 3 });
  assert.equal(red.ok, false);
  assert.deepEqual(red.skipsDisallowed, ["CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"]);
  assert.match(red.reason, /1 skipped, but not a diagnostic skip: CbaseMobileUITests\/ChatComposerUITests\/testAttachPanelKeepsComposerSteady — Without a software keyboard/);
  assert.ok(!/testKeyboardMotionRecordingProbe/.test(red.reason), "the diagnostic skip is not in the reason");
  const green = deviationVerdict({ run: parseTestRun(RUN_ONLY_DIAGNOSTIC_SKIP), expected: 3 });
  assert.equal(green.ok, true, green.reason);
  assert.deepEqual(green.skips, ["CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe"]);
  assert.deepEqual(green.skipsDisallowed, []);
});

// Wording: "named explicitly ⇒ no skip". The GUARANTEE is the same — a test someone names must run; what is new is only that a CLASS
// identifier may bring the diagnostic skips of its class along (own case further below).
test("deviationVerdict (red, --only skip): an EXPLICITLY named test counts no skip — not even a diagnostic test that skips itself", () => {
  const diag = "CbaseMobileUITests/ChatStageUITests/testKeyboardMotionRecordingProbe";
  const run = HEADER
    + "Test Suite 'ChatStageUITests' started at 2026-09-16 10:00:00.000.\n"
    + skipRows("ChatStageUITests", "testKeyboardMotionRecordingProbe", "For video diagnostics only (CBASE_KEYBOARD_PROBE=1).")
    + "Test Suite 'ChatStageUITests' passed at 2026-09-16 10:00:01.000.\n\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 0.100 (0.110) seconds\n"
    + completion(1, 1, 0);
  const p = parseTestRun(run);
  assert.equal(deviationVerdict({ run: p, expected: [diag] }).ok, true, "without only mode the diagnostic skip would be allowed");
  const u = deviationVerdict({ run: p, expected: [diag], only: [diag] });
  assert.equal(u.ok, false);
  assert.match(u.reason, /1 skipped instead of run \(named explicitly ⇒ no skip\): .*testKeyboardMotionRecordingProbe — For video diagnostics only/);
  // And the core case: --only on a product test, the fixture is dead ⇒ 5/5 would otherwise be "green".
  const w = deviationVerdict({ run: parseTestRun(RUN_WARMUP_SKIP), expected: [WARMUP], only: [WARMUP] });
  assert.equal(w.ok, false);
  assert.match(w.reason, /Local fixture gateway is not running/);
});

test("deviationVerdict (red): closing line counts more skips than skip lines read ⇒ not ok (names not read)", () => {
  const run = { total: { executed: 3, failures: 0, unexpected: 0, skipped: 2, durationS: 10 }, red: [], skips: [], skipReasons: {}, succeeded: true, failedMarker: false };
  const u = deviationVerdict({ run, expected: 3 });
  assert.equal(u.ok, false);
  assert.match(u.reason, /2 skipped according to the closing line, but only 0 skip line\(s\) read \(names not read\)/);
});

// ── Warm-up test ──────────────────────────────────────────────────────────────────────────────

test("warmupVerdict: passed means \"is in passed\" — not \"nothing red\"", () => {
  assert.deepEqual(warmupVerdict(parseTestRun(RUN_ALL)), { ok: true, ran: true, reason: null });
});

test("warmupVerdict (red, warm-up skip): skipped (fixture dead) ⇒ not ok WITH the reason — although deviationVerdict without a skip rule and Executed 1 would say ok", () => {
  const p = parseTestRun(RUN_WARMUP_SKIP);
  assert.equal(p.total.executed, 1);
  assert.equal(p.total.failures, 0);
  assert.equal(p.succeeded, true);
  const u = warmupVerdict(p);
  assert.equal(u.ok, false);
  assert.equal(u.ran, true, "it ran — repeating makes sense when the fixture comes back");
  assert.match(u.reason, /Warm-up test skipped: Local fixture gateway is not running at http:\/\/127\.0\.0\.1:17718\./);
});

test("warmupVerdict (red): red warm-up test ⇒ not ok, ran; Executed 0 (old path) ⇒ ran:false; no closing line ⇒ ran:false", () => {
  const red = warmupVerdict(parseTestRun(RUN_WARMUP_RED));
  assert.equal(red.ok, false);
  assert.equal(red.ran, true);
  assert.match(red.reason, /Warm-up test red/);
  const null0 = warmupVerdict(parseTestRun(RUN_NULL));
  assert.equal(null0.ok, false);
  assert.equal(null0.ran, false);
  assert.match(null0.reason, /Executed 0 — wrong identifier/);
  const empty = warmupVerdict(parseTestRun("xcodebuild: error: something\n"));
  assert.equal(empty.ran, false);
  assert.match(empty.reason, /no closing line/);
});

// Real outputs (`simctl spawn … log show --style compact`), shortened. The first line is the red warm-up attempt (keyboard at y 952); the second is the self line with
// which `log` records its own call including the predicate — it contains the marker and must never count.
const LOG_HW = `Timestamp               Ty Process[PID:TID]
2026-10-19 15:43:16.443 Df cbase[64059:2ebeb8] [com.apple.UIKit:KeyboardUI] -[_UIKeyboardStateManager initWithPresentationDelegateView:forCustomInputView:] UIDevice.currentDevice._hardwareKeyboardAvailable = YES
`;
const LOG_SELF = `Timestamp               Ty Process[PID:TID]
2026-10-19 20:36:35.511 Df log[99270:0] [com.apple.log:] log run noninteractively, parent: 63370 (launchd_sim), args: 'log' 'show' '--start' '2026-10-19 20:30:00' '--style' 'compact' '--predicate' 'eventMessage CONTAINS "_hardwareKeyboardAvailable = YES"'
`;

test("hwKeyboardPreference: the DEVICE VALUE decides, not the global key — how the checkmark stood behind a global 0", () => {
  const yes = { output: "true\n", code: 0 };
  const no = { output: "false\n", code: 0 };
  const missing = { output: "", code: 1 };
  // Red: global "false" (what `defaults read … ConnectHardwareKeyboard` showed), device "true".
  const w5 = hwKeyboardPreference({ device: yes, global: no });
  assert.equal(w5.connected, true);
  assert.equal(w5.source, "device value");
  // Green: device explicitly disconnected, whatever is global.
  assert.equal(hwKeyboardPreference({ device: no, global: yes }).connected, false);
  assert.equal(hwKeyboardPreference({ device: no, global: missing }).connected, false);
  // Without a device value the global default applies.
  assert.equal(hwKeyboardPreference({ device: missing, global: no }).connected, false);
  assert.equal(hwKeyboardPreference({ device: missing, global: yes }).source, "global default");
  // Empty is not unknown: if both are missing (or `defaults export` failed), the app's default applies, and that is "connected" — the tool then
  // writes "disconnected" explicitly once.
  const empty = hwKeyboardPreference({ device: missing, global: missing });
  assert.equal(empty.connected, true);
  assert.equal(empty.source, "default of Simulator.app");
  assert.equal(hwKeyboardPreference({}).connected, true);
  // `defaults` can also store a truth value as 0/1.
  assert.equal(hwKeyboardPreference({ device: { output: "0", code: 0 } }).connected, false);
});

test("hwKeyboardKey: the device value lies under DevicePreferences.<UDID>, the default above", () => {
  const k = hwKeyboardKey("11111111-2222-4333-8444-555555555555");
  assert.equal(k.device, "DevicePreferences.11111111-2222-4333-8444-555555555555.ConnectHardwareKeyboard");
  assert.equal(k.global, "ConnectHardwareKeyboard");
});

test("hwKeyboardImDevice: the UIKit row is called hardware keyboard; the `log` self line never counts; an error is unknown", () => {
  assert.equal(hwKeyboardInDevice({ output: LOG_HW, code: 0 }), true);
  // Counter-test: the same marker in the command line of `log` — without the exclusion EVERY query would be "yes".
  assert.equal(hwKeyboardInDevice({ output: LOG_SELF, code: 0 }), false);
  assert.equal(hwKeyboardInDevice({ output: "Timestamp               Ty Process[PID:TID]\n", code: 0 }), false);
  assert.equal(hwKeyboardInDevice({ output: LOG_HW, code: 1 }), null);
  // And the predicate itself excludes the process `log` and looks for exactly the marker.
  assert.match(HW_KEYBOARD_PREDICATE, /process != "log"/);
  assert.ok(HW_KEYBOARD_PREDICATE.includes(`"${HW_KEYBOARD_MARKER}"`));
  assert.ok(LOG_HW.includes(HW_KEYBOARD_MARKER), "the marker stands verbatim in the real UIKit row");
});

test("logShowTime: local time with leading zeros, as `log show --start` reads it", () => {
  assert.equal(logShowTime(new Date(2026, 9, 9, 7, 5, 3)), "2026-10-09 07:05:03");
  assert.equal(logShowTime(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31 23:59:59");
});

test("warmupNextAttempt: an attempt starts only when the remaining deadline is ≥ 120 s; otherwise the 5-min notice instead of SIGKILL", () => {
  const first = warmupNextAttempt({ elapsedMs: 0 });
  assert.equal(first.start, true);
  assert.equal(first.timeoutMs, WARMUP_DEADLINE_MS);
  const tight = warmupNextAttempt({ elapsedMs: WARMUP_DEADLINE_MS - WARMUP_ATTEMPT_MIN_MS });
  assert.equal(tight.start, true, "exactly 120 s remaining still carry an attempt");
  assert.equal(tight.timeoutMs, WARMUP_ATTEMPT_MIN_MS);
  // Red: 200 s passed ⇒ 100 s remaining ⇒ a red attempt (~100 s) would run into the SIGKILL — do not start.
  const toTight = warmupNextAttempt({ elapsedMs: 200_000 });
  assert.equal(toTight.start, false);
  assert.equal(toTight.timeoutMs, 0);
  assert.match(toTight.reason, /Remaining deadline 100 s carries no further attempt \(~120 s\)/);
  assert.equal(warmupNextAttempt({ elapsedMs: WARMUP_DEADLINE_MS + 5000 }).restMs, 0);
});

// ── --only: duplicates and classes ────────────────────────────────────────────────────────────

test("normIdentifiers / expectation (h3): the same identifier in two spellings counts ONCE — otherwise expectation 2 against Executed 1", () => {
  const all = parseEnumeration(ENUM);
  const duplicate = ["ShellUITests/testX()", "CbaseMobileUITests/ShellUITests/testX", "  CbaseMobileUITests/ShellUITests/testX  "];
  assert.deepEqual(normIdentifiers(duplicate), ["CbaseMobileUITests/ShellUITests/testX"]);
  const e = expectation(all, { only: ["ChatComposerUITests/testAttachPanelKeepsComposerSteady()", "CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"] });
  assert.equal(e.list.length, 1, "before: 2 — and the run with Executed 1 would have been red");
  assert.deepEqual(e.args, ["CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"]);
  assert.deepEqual(e.unknown, []);
});

test("expectation (h3): a CLASSES identifier expands to its enumerated tests; -only-testing gets the class; an unknown class is named", () => {
  const all = parseEnumeration(ENUM);
  assert.equal(isClassIdentifier("CbaseMobileUITests/ChatComposerUITests"), true);
  assert.equal(isClassIdentifier("ChatComposerUITests"), true);
  assert.equal(isClassIdentifier("ChatComposerUITests/testX"), false);
  const e = expectation(all, { only: ["CbaseMobileUITests/ChatComposerUITests"] });
  assert.deepEqual(e.list, [
    "CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady",
    "CbaseMobileUITests/ChatComposerUITests/testChatAskCardAnswersWithOneTap",
  ]);
  assert.deepEqual(e.args, ["CbaseMobileUITests/ChatComposerUITests"]);
  // Class AND one of its tests named: the test counts once, and only the class goes out as an argument — the test is contained in it, a second
  // -only-testing would be a duplicate.
  const mix = expectation(all, { only: ["ChatComposerUITests", "ChatComposerUITests/testChatAskCardAnswersWithOneTap"] });
  assert.equal(mix.list.length, 2);
  assert.deepEqual(mix.args, ["CbaseMobileUITests/ChatComposerUITests"]);
  // Red: a class that does not exist (typo) would silently run into the void — it is named.
  const wrong = expectation(all, { only: ["CbaseMobileUITests/ChatComposerUITest"] });
  assert.deepEqual(wrong.unknown, ["CbaseMobileUITests/ChatComposerUITest"]);
  assert.deepEqual(wrong.list, []);
});

// ── Runner crash, completion warning, xcresult ──────────────────────────────────────────────

test("deviationVerdict (red, h4): \"1 failure (1 unexpected)\" without a failed row (runner crash) ⇒ not ok, reason \"(names not read)\"", () => {
  const p = parseTestRun(RUN_CRASH);
  assert.deepEqual(p.red, [], "no test case line is failed");
  assert.equal(p.total.failures, 1);
  assert.equal(p.total.unexpected, 1);
  const u = deviationVerdict({ run: p, expected: 2 });
  assert.equal(u.ok, false);
  assert.equal(u.executed, 2);
  assert.match(u.reason, /^1 red: \(Names not read\)$/);
});

test("completionWarning (h5): exit ≠ 0 without SUCCEEDED/FAILED marker ⇒ warning in the JSON; with marker or exit 0 ⇒ none", () => {
  const aborted = parseTestRun(RUN_ONLY_CLASS.replace("** TEST EXECUTE SUCCEEDED **\n", ""));
  assert.equal(aborted.succeeded, false);
  assert.equal(aborted.failedMarker, false);
  assert.match(completionWarning(aborted, 137), /xcodebuild without completion \(exit 137, neither TEST EXECUTE SUCCEEDED nor FAILED\)/);
  assert.equal(completionWarning(aborted, 0), null);
  assert.equal(completionWarning(parseTestRun(RUN_FULL), 65), null, "FAILED marker ⇒ regular end");
  assert.equal(completionWarning(parseTestRun(RUN_ALL), 0), null);
  const z = summary({ stamp: "s", expected: 2, parsed: aborted, verdict: deviationVerdict({ run: aborted, expected: 2 }), exitCode: 137 });
  assert.match(z.warn, /exit 137/);
  assert.equal(z.exitCode, 137);
  assert.equal(z.ok, false);
  assert.equal(summary({ stamp: "s", expected: 1, parsed: parseTestRun(RUN_ALL), verdict: { ok: true }, exitCode: 0 }).warn, null);
});

test("parseTestRun (h6): the xcresult path from \"Test session results, code coverage, and logs:\" — not the one from \"Writing result bundle\"", () => {
  const p = parseTestRun(RUN_ONLY_REAL);
  assert.equal(p.xcresult, "/tmp/claude-501/scratchpad/wackler/w1/finalMatrix-1.xcresult");
  assert.equal(parseTestRun(RUN_FULL).xcresult, null, "without the line: null, not a random path");
  const z = summary({ stamp: "s", expected: 1, parsed: p, verdict: { ok: true }, exitCode: 0 });
  assert.equal(z.xcresult, "/tmp/claude-501/scratchpad/wackler/w1/finalMatrix-1.xcresult");
});

// ── The whole verdict chain on a real --only run ────────────────────────────────────────────────────────────

test("verdict chain --only on a real log: parseEnumeration → expectation → parseTestRun → deviationVerdict → summary ⇒ ok, Executed 1", () => {
  const only = ["CbaseMobileUITests/ChatRowsUITests/testSubagentMatrixInLoadedHistory"];
  const identifiers = parseEnumeration(ENUM);
  const expected = expectation(identifiers, { only });
  assert.deepEqual(expected.unknown, []);
  assert.deepEqual(expected.args, only);
  assert.equal(expected.list.length, 1);
  const parsed = parseTestRun(RUN_ONLY_REAL);
  const verdict = deviationVerdict({ run: parsed, expected: expected.list, only });
  assert.equal(verdict.ok, true, verdict.reason);
  const z = summary({ stamp: "n0a", only, expected: expected.list, parsed, verdict, exitCode: 0 });
  assert.equal(z.mode, "only");
  assert.equal(z.executed, 1);
  assert.equal(z.expected, 1);
  assert.equal(z.ok, true);
  assert.equal(z.reason, null);
  assert.equal(z.warn, null);
  assert.deepEqual(z.red, []);
  assert.deepEqual(z.skips, []);
  assert.equal(z.passed, 1);
  assert.equal(z.durationPerTest["CbaseMobileUITests/ChatRowsUITests/testSubagentMatrixInLoadedHistory"], 36.423);
  assert.equal(z.totalDurationS, 36.423);
  assert.match(z.xcresult, /finalMatrix-1\.xcresult$/);
});

test("verdict chain --only (red): the same log against expectation 2 ⇒ not ok \"1 ≠ 2\"", () => {
  const only = ["CbaseMobileUITests/ChatRowsUITests/testSubagentMatrixInLoadedHistory", "CbaseMobileUITests/ChatComposerUITests/testChatAskCardAnswersWithOneTap"];
  const expected = expectation(parseEnumeration(ENUM), { only });
  assert.equal(expected.list.length, 2);
  const parsed = parseTestRun(RUN_ONLY_REAL);
  const verdict = deviationVerdict({ run: parsed, expected: expected.list, only });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Executed 1 ≠ expected 2/);
  const z = summary({ stamp: "n0a", only, expected: expected.list, parsed, verdict, exitCode: 0 });
  assert.equal(z.ok, false);
  assert.equal(z.executed, 1);
  assert.equal(z.expected, 2);
});

// ── h1: comma locale ─────────────────────────────────────────────────────────────────────────

test("parseUptime / foreignProcesses (h1): German locale with comma — \"2,95 3,15 3,31\" ⇒ 2.95, \"142,3\" % CPU counts", () => {
  assert.equal(parseUptime(UPTIME_COMMA), 2.95);
  const u = loadVerdict({ uptime: UPTIME_COMMA, ps: PS_COMMA, derivedData: DD });
  assert.equal(u.load1, 2.95);
  assert.deepEqual(u.foreign.map((f) => [f.pid, f.reason]), [[513, "mds_stores 142 % CPU"], [7777, "next dev"]]);
  assert.equal(u.ok, false, "because of the foreign processes — not because of the comma");
  assert.equal(loadVerdict({ uptime: UPTIME_COMMA, ps: "  0,5  9001 node deploy.mjs\n", derivedData: DD }).ok, true);
});

// ── Drafts in the data container ────────────────────────────────────────────────────────────────────────────────

test("draftPlist: get_app_container exit 0 ⇒ plist path in the DATA CONTAINER (…/Library/Preferences/<bundle>.plist)", () => {
  const r = draftPlist({ output: CONTAINER_OK, code: 0, bundleId: BUNDLE });
  assert.equal(r.plist, PLIST_OK);
  assert.equal(r.reason, null);
  assert.ok(!r.plist.startsWith(BUNDLE), "no domain name — that would be the user domain of the simulator");
});

test("draftPlist (red): app not installed (exit ≠ 0) ⇒ no path, REASON \"not installed\" — no success", () => {
  const r = draftPlist({ output: CONTAINER_MISSING, code: 2, bundleId: BUNDLE });
  assert.equal(r.plist, null);
  assert.match(r.reason, /nothing to delete — app dev\.cbase\.mobile not installed \(get_app_container exit 2/);
  assert.equal(draftPlist({ output: "", code: 0, bundleId: BUNDLE }).plist, null, "exit 0 without a path is no container either");
});

test("draftKey: two draft keys next to foreign ones ⇒ exactly the two; missing plist file (defaults read <path>) ⇒ []", () => {
  const keys = draftKey(DEFAULTS);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.startsWith("cbase.mobile.draft:")));
  assert.deepEqual(draftKey(DEFAULTS.replace(/cbase\.mobile\.draft:[^"]*/g, "cbase.mobile.other")), [], "foreign keys alone ⇒ nothing");
  assert.deepEqual(draftKey(DEFAULTS_NO_FILE), []);
  assert.deepEqual(draftKey(""), []);
});

test("summary: carries drafts {deleted, remaining, reason} and skipReasons/skipsDisallowed", () => {
  const parsed = parseTestRun(RUN_KEYBOARD_SKIP);
  const verdict = deviationVerdict({ run: parsed, expected: 3 });
  const z = summary({
    stamp: "s", expected: 3, parsed, verdict, exitCode: 0,
    drafts: { deleted: [], remaining: [], reason: "nothing to delete — app dev.cbase.mobile not installed (get_app_container exit 2)" },
  });
  assert.match(z.drafts.reason, /not installed/);
  assert.deepEqual(z.skipsDisallowed, ["CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"]);
  assert.equal(z.skipReasons["CbaseMobileUITests/ChatComposerUITests/testAttachPanelKeepsComposerSteady"], KEYBOARD_WAY);
  assert.equal(z.ok, false);
});

// ── deploy.mjs: parseArgs ────────────────────────────────────────────────────────────────────

test("parseArgs (h6): `--wait` without a number ⇒ 600 for mobile --tests, 300 for the deploy targets; with a number the number; without --wait 0", () => {
  assert.equal(parseArgs(["mobile", "--tests", "--wait"]).wait, 600, "before: 300 from the server semantics, the usage said 600");
  assert.equal(parseArgs(["mobile", "--tests", "--wait", "1200"]).wait, 1200);
  assert.equal(parseArgs(["mobile", "--tests", "--wait=900"]).wait, 900);
  assert.equal(parseArgs(["mobile", "--tests"]).wait, 0, "0 means: the target's default (runMobileTests takes 600)");
  assert.equal(parseArgs(["web", "--wait"]).wait, 300);
  assert.equal(parseArgs(["server", "--wait", "120"]).wait, 120);
});

test("parseArgs: --only takes a class identifier too; the error message names both forms", () => {
  assert.deepEqual(parseArgs(["mobile", "--tests", "--only", "CbaseMobileUITests/ChatStageUITests"]).only, ["CbaseMobileUITests/ChatStageUITests"]);
  assert.throws(() => parseArgs(["mobile", "--tests", "--only", " "]), /CbaseMobileUITests\/<Class>\/<test> \(or CbaseMobileUITests\/<Class>\)/);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Rework of the first round: class expansion against the skip rule, abort reason in the log, dry-run drafts, `--force` only for reasons that do not pass by themselves.
// ═══════════════════════════════════════════════════════════════════════════════════

// `--only <class>` and "named with --only counts no skip" contradicted each other: two classes carry diagnostic skips (ChatStageUITests 2, ChatTextUITests 3), so `--only CbaseMobileUITests/ChatStageUITests` was ALWAYS red — the form DEPLOY.md gives as an example, and exactly the classes in which the flakiness lies. The rule belongs to the EXPLICITLY named tests: whoever runs a test five times wants to see it run five times; whoever runs a class gets it as it is in the full run.
const ENUM_CLASS = [
  `${MODULE}/ChatTextUITests/testMarkerPicksWord`,
  `${MODULE}/ChatTextUITests/testChatScrollPerformanceProbe`,
  `${MODULE}/ChatTextUITests/testSendPerformanceProbe`,
  `${MODULE}/ChatTextUITests/testDeviceMarkerDiagnosticOnRealChat`,
  `${MODULE}/ChatTextUITests/testMarkdownTablesRoles`,
  `${MODULE}/ShellUITests/testFirstLaunchOffersFreeServerEntry`,
];
const PERF_REASON = "Hand diagnostics only: set TEST_RUNNER_CBASE_PERF_PROBE to a path.";
const DIAG_REASON = "For device diagnostics only (CBASE_MARKER_DEVICE_DIAG=1).";
// What the class looks like in EVERY run: 5 executed, the 3 env-gated ones skipped.
const RUN_CLASS_WITH_DIAGNOSTIC = HEADER
  + "Test Suite 'ChatTextUITests' started at 2026-09-16 10:00:00.000.\n"
  + passRows("ChatTextUITests", "testMarkerPicksWord", "4.1")
  + skipRows("ChatTextUITests", "testChatScrollPerformanceProbe", PERF_REASON, "ChatTextUITests.swift", 252)
  + skipRows("ChatTextUITests", "testSendPerformanceProbe", PERF_REASON, "ChatTextUITests.swift", 323)
  + skipRows("ChatTextUITests", "testDeviceMarkerDiagnosticOnRealChat", DIAG_REASON, "ChatTextUITests.swift", 361)
  + passRows("ChatTextUITests", "testMarkdownTablesRoles", "3.0")
  + "Test Suite 'ChatTextUITests' passed at 2026-09-16 10:00:20.000.\n\t Executed 5 tests, with 3 tests skipped and 0 failures (0 unexpected) in 7.400 (7.401) seconds\n"
  + completion(5, 3, 0);

test("expectation/deviationVerdict: `--only <CLASS>` allows the diagnostic skips OF THIS class — before, the form was ALWAYS red", () => {
  const only = [`${MODULE}/ChatTextUITests`];
  const e = expectation(ENUM_CLASS, { only });
  assert.equal(e.list.length, 5, "the class has 5 tests");
  assert.deepEqual(e.args, only);
  // The new field: which identifiers came in ONLY via the class?
  assert.deepEqual([...e.fromClass].sort(), e.list.slice().sort(), "all five come from the class");
  const u = deviationVerdict({ run: parseTestRun(RUN_CLASS_WITH_DIAGNOSTIC), expected: e.list, only, fromClass: e.fromClass });
  assert.equal(u.ok, true, u.reason);
  assert.deepEqual(u.skipsDisallowed, []);
  assert.equal(u.skips.length, 3, "the three diagnostic skips are still in the log");
});

test("deviationVerdict (red): the same test named EXPLICITLY ⇒ no skip allowed — not even the diagnostic skip", () => {
  const diag = `${MODULE}/ChatTextUITests/testChatScrollPerformanceProbe`;
  const only = [diag];
  const e = expectation(ENUM_CLASS, { only });
  assert.deepEqual(e.list, [diag]);
  assert.deepEqual([...e.fromClass], [], "named explicitly is not \"fetched from a class\"");
  const run = HEADER
    + "Test Suite 'ChatTextUITests' started at 2026-09-16 10:00:00.000.\n"
    + skipRows("ChatTextUITests", "testChatScrollPerformanceProbe", PERF_REASON, "ChatTextUITests.swift", 252)
    + "Test Suite 'ChatTextUITests' passed at 2026-09-16 10:00:01.000.\n\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 0.100 (0.110) seconds\n"
    + completion(1, 1, 0);
  const u = deviationVerdict({ run: parseTestRun(run), expected: e.list, only, fromClass: e.fromClass });
  assert.equal(u.ok, false);
  assert.deepEqual(u.skipsDisallowed, [diag]);
  assert.match(u.reason, /1 skipped instead of run \(named explicitly ⇒ no skip\): .*testChatScrollPerformanceProbe — Hand diagnostics only/);
});

test("deviationVerdict (red): even with `--only <CLASS>` a FOREIGN skip (dead fixture, keyboard gone) is a finding", () => {
  const only = [`${MODULE}/ChatTextUITests`];
  const e = expectation(ENUM_CLASS, { only });
  const run = HEADER
    + "Test Suite 'ChatTextUITests' started at 2026-09-16 10:00:00.000.\n"
    + passRows("ChatTextUITests", "testMarkerPicksWord", "4.1")
    + skipRows("ChatTextUITests", "testChatScrollPerformanceProbe", PERF_REASON, "ChatTextUITests.swift", 252)
    + skipRows("ChatTextUITests", "testSendPerformanceProbe", PERF_REASON, "ChatTextUITests.swift", 323)
    + skipRows("ChatTextUITests", "testDeviceMarkerDiagnosticOnRealChat", DIAG_REASON, "ChatTextUITests.swift", 361)
    + skipRows("ChatTextUITests", "testMarkdownTablesRoles", FIXTURE_TOT, "CbaseUITestBase.swift", 549)
    + "Test Suite 'ChatTextUITests' passed at 2026-09-16 10:00:20.000.\n\t Executed 5 tests, with 4 tests skipped and 0 failures (0 unexpected) in 7.400 (7.401) seconds\n"
    + completion(5, 4, 0);
  const u = deviationVerdict({ run: parseTestRun(run), expected: e.list, only, fromClass: e.fromClass });
  assert.equal(u.ok, false);
  assert.deepEqual(u.skipsDisallowed, [`${MODULE}/ChatTextUITests/testMarkdownTablesRoles`]);
  assert.match(u.reason, /Local fixture gateway is not running/);
});

test("expectation: class AND one of its tests named — the explicitly named one drops out of `fromClass`", () => {
  const diag = `${MODULE}/ChatTextUITests/testChatScrollPerformanceProbe`;
  const e = expectation(ENUM_CLASS, { only: [`${MODULE}/ChatTextUITests`, diag] });
  assert.equal(e.list.length, 5);
  assert.deepEqual(e.args, [`${MODULE}/ChatTextUITests`], "a second -only-testing would be a duplicate");
  assert.ok(![...e.fromClass].includes(diag), "whoever names it explicitly wants to see it run");
  assert.equal([...e.fromClass].length, 4);
  // Reverse order: the same outcome.
  const reversed = expectation(ENUM_CLASS, { only: [diag, `${MODULE}/ChatTextUITests`] });
  assert.ok(![...reversed.fromClass].includes(diag));
});

// `--force` bypasses the load gate AFTER the deadline. The reason it exists is a foreign `next dev` that NEVER ends — a foreign `xcodebuild`
// does end, and two xcodebuild on one machine are exactly the situation the gate is meant to prevent.
test("loadGateDecision (red): deadline over, --force, but a foreign xcodebuild ⇒ ABORT, do not force", () => {
  const foreign = loadVerdict({ uptime: UPTIME_MAC, ps: PS_XCODEBUILD_FOREIGN, derivedData: DD });
  assert.equal(foreign.ok, false);
  const e = loadGateDecision({ verdict: foreign, elapsedS: 900, waitS: 600, force: true });
  assert.equal(e.action, "abort", "--force must never bypass a running xcodebuild");
  assert.equal(e.forced, false);
  assert.equal(e.forceRefused, true);
  assert.match(e.reason, /xcodebuild/);
});

test("loadGateDecision: the same for an xcodebuild in the OWN DerivedData; a plain `next dev` stays forceable", () => {
  const own = loadVerdict({ uptime: UPTIME_MAC, ps: PS_XCODEBUILD_OWN, derivedData: DD });
  const a = loadGateDecision({ verdict: own, elapsedS: 900, waitS: 600, force: true });
  assert.equal(a.action, "abort", "two runs on the same DerivedData are worse, not harmless");
  assert.equal(a.forceRefused, true);
  const next = loadVerdict({ uptime: UPTIME_LINUX, ps: PS_NEXT, derivedData: DD });
  const b = loadGateDecision({ verdict: next, elapsedS: 900, waitS: 600, force: true });
  assert.equal(b.action, "force");
  assert.equal(b.forced, true);
  assert.ok(!b.forceRefused);
});

// In the dry run the `defaults delete` are only SHOWN — "✓ N deleted" was reported anyway. A dry run that reports deleted data is none.
test("draftsResult (red): a dry run deletes NOTHING and says so — no \"N deleted\"", () => {
  const keys = ["cbase.mobile.draft:2000-0001", "cbase.mobile.draft:8200-0001"];
  const dry = draftsResult({ keys, dryRun: true });
  assert.deepEqual(dry.deleted, []);
  assert.deepEqual(dry.remaining, keys);
  assert.match(dry.reason, /dry run — nothing deleted/);
});

test("draftsResult: in a real run the READ-BACK decides — what still stands does not count as deleted", () => {
  const keys = ["cbase.mobile.draft:2000-0001", "cbase.mobile.draft:8200-0001"];
  const everything = draftsResult({ keys, dryRun: false, byText: "{\n}\n" });
  assert.deepEqual(everything.deleted, keys);
  assert.deepEqual(everything.remaining, []);
  assert.equal(everything.reason, null);
  const half = draftsResult({ keys, dryRun: false, byText: '{\n    "cbase.mobile.draft:8200-0001" = "Edge test";\n}\n' });
  assert.deepEqual(half.deleted, ["cbase.mobile.draft:2000-0001"]);
  assert.deepEqual(half.remaining, ["cbase.mobile.draft:8200-0001"]);
  assert.deepEqual(draftsResult({ keys: [], dryRun: false, byText: "" }).deleted, []);
});
