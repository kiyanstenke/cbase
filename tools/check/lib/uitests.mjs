// Pure functions for the iOS UI test run (`mobile --tests`).
// No process, no file system — everything here takes text (xcodebuild output, `uptime`, `ps`,
// `defaults`, `simctl list -j`, `simctl get_app_container`) and returns a verdict; the flow
// lives in `targets/mobile.mjs`. Every rule has a green AND a red case in `tools/check/uitests.test.mjs`.
//
// The traps this module models (all measured):
//  · An `-only-testing` on a path that does not exist (old identifier path) reports
//    `TEST EXECUTE SUCCEEDED` with ZERO tests. So not the exit code counts, but
//    `Executed N tests` against the expectation from `-enumerate-tests`.
//  · The `Executed` line stands per CLASS and once for the outer suite (`All tests`, or with
//    `-skip-testing`/`-only-testing`: `Selected tests`). Only the outer one counts — a class line
//    alone is no result.
//  · A SKIPPED test counts as passed for xcodebuild: if the fixture dies after the start,
//    `requireFixture()` throws XCTSkip in EVERY test — "Executed 145, 145 skipped, 0 failures",
//    and without the skip rule that would be a green run without a single test. The same if the
//    software keyboard vanishes mid-run (three tests skip themselves). In the full run only the five
//    diagnostic skips are allowed (`DIAGNOSTIC_SKIPS`); with `--only` NO skip.
//  · Foreign load (`next dev`, a second `xcodebuild`, `mds_stores`) turns deadline tests red
//    without the product being to blame. Load < 3 and no foreign build processes are the gate.
//  · `defaults read <bundle>` reads the USER domain of the simulator; `UserDefaults.standard` of the
//    sandboxed app lives in the DATA CONTAINER (`simctl get_app_container … data`). The first version
//    therefore never deleted anything and still reported green.
//  · The hardware keyboard is stored PER DEVICE in the preferences of Simulator.app, not in the global
//    key, and the menu reports `missing value` for everything without focus (see below).

export const MODULE = "CbaseMobileUITests";
export const LIVE_WALKTHROUGH = `${MODULE}/${MODULE}/testFullCategorySweepAgainstLiveGateway`;
export const WARMUP = `${MODULE}/AAAWarmupUITests/testKeyboardAppears`;
export const DRAFT_PREFIX = "cbase.mobile.draft:";
export const LOAD_LIMIT = 3;
export const MDS_CPU_LIMIT = 100;
export const WARMUP_DEADLINE_MS = 5 * 60 * 1000;
// A red warm-up attempt takes ~100 s (app start + 60 s waiting for the keyboard + teardown).
// An attempt that would not finish in the remaining deadline would run into the tool's SIGKILL and
// report "did not run — identifier/build error?" instead of the truth "not green for 5 min".
export const WARMUP_ATTEMPT_MIN_MS = 120 * 1000;

/**
 * The five tests that ALWAYS skip themselves in the full run — each is switched by an environment
 * variable and meant only for manual, video or device diagnosis ("Executed 144 tests, with 5 tests
 * skipped"). As a list, not via the reason text: a list is checkable. Every OTHER skip in the full
 * run is a finding (fixture dead, keyboard gone, no chat).
 */
export const DIAGNOSTIC_SKIPS = [
  `${MODULE}/ChatStageUITests/testKeyboardMotionRecordingProbe`,   // CBASE_KEYBOARD_PROBE=1
  `${MODULE}/ChatStageUITests/testKeyboardOpenTraceWhileScrolledUp`, // TEST_RUNNER_CBASE_KEYBOARD_TRACE
  `${MODULE}/ChatTextUITests/testChatScrollPerformanceProbe`,       // TEST_RUNNER_CBASE_PERF_PROBE
  `${MODULE}/ChatTextUITests/testDeviceMarkerDiagnosticOnRealChat`, // CBASE_MARKER_DEVICE_DIAG=1
  `${MODULE}/ChatTextUITests/testSendPerformanceProbe`,             // TEST_RUNNER_CBASE_PERF_PROBE
];

// ── Identifiers ─────────────────────────────────────────────────────────────────────────────

/** `CbaseMobileUITests/Class/test` — with or without module prefix, with or without `()`. */
export function normIdentifier(k) {
  let s = String(k || "").trim().replace(/\(\)$/, "");
  if (!s) return "";
  if (!s.startsWith(`${MODULE}/`)) s = `${MODULE}/${s}`;
  return s;
}

/**
 * Normalize AND deduplicate, order of first mention. `ShellUITests/testX()` and
 * `CbaseMobileUITests/ShellUITests/testX` are the same test — named twice they would otherwise
 * give the expectation 2 against an `Executed 1`: a false red.
 */
export function normIdentifiers(list) {
  const out = [];
  const seen = new Set();
  for (const k of list || []) {
    const n = normIdentifier(k);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** A CLASS identifier has two segments (`Module/Class`), a test three. */
export function isClassIdentifier(k) {
  return normIdentifier(k).split("/").length === 2;
}

/**
 * Output of `xcodebuild … -enumerate-tests -test-enumeration-style flat
 * -test-enumeration-format text test-without-building`: one line per test, indented, with
 * `()` at the end. Everything else (plan line, runner chatter) drops out.
 */
export function parseEnumeration(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const m = raw.trim().match(/^([A-Za-z0-9_]+\/[A-Za-z0-9_]+\/test[A-Za-z0-9_]*)(?:\(\))?$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * The expectation of a run: all identifiers without the live walkthrough — or, with `only`, exactly the
 * desired ones. An `only` identifier that does not exist stands in `unknown`: it would otherwise run
 * silently into nothing (SUCCEEDED, 0 tests).
 *
 * `only` is deduplicated (see `normIdentifiers`), and a CLASS identifier
 * (`CbaseMobileUITests/ChatStageUITests`) is expanded to its enumerated tests: the
 * expectation is the number of tests, `args` (what goes to `-only-testing:`) keeps the
 * class. A test named next to its class counts once.
 *
 * `fromClass` says which identifiers came in ONLY via a class — the difference decides the skip
 * rule: "with --only no skip counts" holds for what someone named EXPLICITLY, not for what a class
 * brings along. Two classes carry diagnostic skips (ChatStageUITests 2, ChatTextUITests 3), and
 * without this distinction `--only CbaseMobileUITests/ChatStageUITests` was ALWAYS red. Whoever
 * names one of these tests explicitly wants to see it run: then its skip counts.
 */
export function expectation(identifiers, { only = [] } = {}) {
  const all = normIdentifiers(identifiers);
  const desired = normIdentifiers(only);
  if (desired.length) {
    const known = new Set(all);
    const list = [];
    const unknown = [];
    const args = [];
    const taken = new Set();
    const fromClass = new Set();
    const explicit = new Set();
    for (const k of desired) {
      if (isClassIdentifier(k)) {
        const tests = all.filter((t) => t.startsWith(`${k}/`));
        if (!tests.length) { unknown.push(k); continue; }
        args.push(k);
        for (const t of tests) {
          fromClass.add(t);
          if (!taken.has(t)) { taken.add(t); list.push(t); }
        }
        continue;
      }
      if (!known.has(k)) { unknown.push(k); continue; }
      explicit.add(k);
      if (taken.has(k)) continue;
      taken.add(k);
      list.push(k);
      args.push(k);
    }
    // Named explicitly beats "fetched from a class" — in both orders.
    for (const k of explicit) fromClass.delete(k);
    return { list, unknown, args, fromClass: [...fromClass] };
  }
  const list = all.filter((k) => k !== LIVE_WALKTHROUGH);
  return { list, unknown: [], args: [], fromClass: [] };
}

// ── xcodebuild test run ─────────────────────────────────────────────────────────────────────

const EXECUTED_RE =
  /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures? \((\d+) unexpected\) in ([\d.]+) \(([\d.]+)\) seconds/;
const SUITE_RE = /^Test Suite '([^']+)' (started|passed|failed) at /;
const CASE_RE = /^Test Case '-\[([A-Za-z0-9_]+)\.([A-Za-z0-9_]+) ([A-Za-z0-9_]+)\]' (passed|failed|skipped) \(([\d.]+) seconds\)/;
// The reason of a skip stands in the line BEFORE the `Test Case … skipped` line:
//   <path>:<line>: -[Class test] : Test skipped - <reason>
const SKIP_REASON_RE = /: -\[([A-Za-z0-9_]+)\.([A-Za-z0-9_]+) ([A-Za-z0-9_]+)\] : Test skipped - (.*)$/;
const XCRESULT_RE = /^\s*(\/.*\.xcresult)\s*$/;
const OUTSIDE = new Set(["All tests", "Selected tests"]);

function executedRow(line) {
  const m = line.match(EXECUTED_RE);
  if (!m) return null;
  return {
    executed: +m[1],
    skipped: m[2] ? +m[2] : 0,
    failures: +m[3],
    unexpected: +m[4],
    durationS: +m[5],
  };
}

/**
 * Reads the full xcodebuild output of a test run (stdout AND stderr — the caller passes both,
 * so an abort with its message is not lost).
 *
 * `total` is ONLY the Executed line of the outer suite (`All tests` / `Selected tests`) — the
 * first `Executed` line after its completion. If the outer suite is missing (output truncated,
 * runner crashed, or someone takes a class line for the result), `total` is null.
 * The class lines stand next to it in `classes`, but nothing computes with them.
 *
 * `skips` are the identifiers, `skipReasons` the text behind "Test skipped - " per identifier
 * (without it a dead fixture cannot be told from a diagnostic switch). `xcresult` is the path from
 * "Test session results, code coverage, and logs:" (one per run), null if xcodebuild named none.
 */
export function parseTestRun(text) {
  const lines = String(text || "").split("\n");
  const classes = [];
  const red = [];
  const skips = [];
  const skipReasons = {};
  const passed = [];
  const durationPerTest = {};
  let total = null;
  let open = null; // the suite finished last whose Executed line is still pending
  let succeeded = false;
  let failedMarker = false;
  let xcresult = null;
  let xcresultExpected = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (xcresultExpected) {
      const x = line.match(XCRESULT_RE);
      if (x) { xcresult = x[1]; xcresultExpected = false; continue; }
      if (line.trim()) xcresultExpected = false;
    }
    if (/^Test session results, code coverage, and logs:/.test(line)) { xcresultExpected = true; continue; }
    const s = line.match(SUITE_RE);
    if (s) {
      // Three levels: outer suite (All/Selected tests), the bundle (`….xctest`) and the classes.
      // The bundle only repeats the outer number — it counts neither as a class nor as the total.
      open = s[2] === "started" || s[1].endsWith(".xctest") ? null : { name: s[1], result: s[2] };
      continue;
    }
    const e = executedRow(line);
    if (e && open) {
      const entry = { suite: open.name, result: open.result, ...e };
      if (OUTSIDE.has(open.name)) {
        if (!total) total = entry;
      } else {
        classes.push(entry);
      }
      open = null;
      continue;
    }
    const g = line.match(SKIP_REASON_RE);
    if (g) {
      skipReasons[`${g[1]}/${g[2]}/${g[3]}`] = g[4].trim();
      continue;
    }
    const c = line.match(CASE_RE);
    if (c) {
      const identifier = `${c[1]}/${c[2]}/${c[3]}`;
      const duration = +c[5];
      durationPerTest[identifier] = duration;
      if (c[4] === "failed") red.push(identifier);
      else if (c[4] === "skipped") skips.push(identifier);
      else passed.push(identifier);
      continue;
    }
    if (/\*\* TEST EXECUTE SUCCEEDED \*\*/.test(line)) succeeded = true;
    if (/\*\* TEST EXECUTE FAILED \*\*/.test(line)) failedMarker = true;
  }
  return { total, classes, red, skips, skipReasons, passed, durationPerTest, succeeded, failedMarker, xcresult };
}

/** "Identifier — reason" for the messages; without a reason read, just the identifier. */
function skipText(identifier, reasons) {
  const g = reasons?.[identifier];
  return g ? `${identifier} — ${g}` : identifier;
}

/**
 * The verdict on a run: ok ONLY if the outer Executed line is there, its number matches the
 * expectation, nothing is red and nothing was skipped ILLEGALLY. `SUCCEEDED` alone is not enough
 * (0 tests are also "succeeded"), `executed` alone is not enough (a red run has the right number),
 * and `failures 0` alone is not enough (145 skips are also 0 failures).
 *
 * Skips: with `only` (mode "only") the skip of an EXPLICITLY named test is a finding —
 * whoever runs a test five times wants to see it run five times. What a CLASS identifier
 * brings along (`fromClass`, from `expectation`) is treated like in the full run: the
 * `DIAGNOSTIC_SKIPS` may skip themselves, every other skip is a finding.
 * In the full run only the `DIAGNOSTIC_SKIPS` are allowed; every other skip ⇒ not ok, with name
 * and reason from the xcodebuild line. If the closing line reports more skips than names were
 * read, the same holds as for red without names: not ok.
 */
export function deviationVerdict({ run, expected, only = [], fromClass = [] }) {
  const desired = Array.isArray(expected) ? expected.length : Number(expected);
  const g = run?.total || null;
  const red = run?.red || [];
  const skips = run?.skips || [];
  const reasons = run?.skipReasons || {};
  const mode = (only || []).length ? "only" : "full";
  const diagnostic = new Set(DIAGNOSTIC_SKIPS);
  const inherited = new Set(fromClass || []);
  const allowed = (k) => diagnostic.has(k) && (mode === "full" || inherited.has(k));
  const skipsDisallowed = skips.filter((k) => !allowed(k));
  const base = { executed: g ? g.executed : null, expected: desired, red, skips, skipsDisallowed };
  if (!g) {
    return {
      ok: false, ...base,
      reason: "no closing line of the outer suite (All tests/Selected tests) — run aborted or output incomplete",
    };
  }
  if (g.executed !== desired) {
    return {
      ok: false, ...base,
      reason: `Executed ${g.executed} ≠ expected ${desired}${g.executed === 0 ? " — wrong identifier? (old path without class reports SUCCEEDED with 0 tests)" : ""}`,
    };
  }
  if (red.length || g.failures > 0) {
    return {
      ok: false, ...base,
      reason: `${red.length || g.failures} red: ${red.join(", ") || "(Names not read)"}`,
    };
  }
  if (skipsDisallowed.length) {
    const what = mode === "full" || skipsDisallowed.every((k) => inherited.has(k))
      ? "skipped, but not a diagnostic skip"
      : "skipped instead of run (named explicitly ⇒ no skip)";
    return {
      ok: false, ...base,
      reason: `${skipsDisallowed.length} ${what}: ${skipsDisallowed.map((k) => skipText(k, reasons)).join("; ")}`,
    };
  }
  if (g.skipped > skips.length) {
    return {
      ok: false, ...base,
      reason: `${g.skipped} skipped according to the closing line, but only ${skips.length} skip line(s) read (names not read)`,
    };
  }
  if (!run.succeeded && run.failedMarker) {
    return { ok: false, ...base, reason: "TEST EXECUTE FAILED without a named red test" };
  }
  return { ok: true, ...base, reason: null };
}

/**
 * The verdict on ONE warm-up attempt: passed means the warm-up test stands in `passed` —
 * not "nothing red". A skipped warm-up test (fixture dead, no chat) would otherwise be "keyboard
 * there (1 attempt)" without a keyboard. `ran:false` means: not executed at all (identifier or build) —
 * repeating does not help then.
 */
export function warmupVerdict(run) {
  const p = run || {};
  const g = p.total || null;
  if (p.passed?.includes(WARMUP)) return { ok: true, ran: true, reason: null };
  if (p.skips?.includes(WARMUP)) {
    return { ok: false, ran: true, reason: `Warm-up test skipped: ${p.skipReasons?.[WARMUP] || "(reason not read)"}` };
  }
  if (p.red?.includes(WARMUP)) return { ok: false, ran: true, reason: "Warm-up test red (keyboard did not appear)" };
  if (!g) return { ok: false, ran: false, reason: "no closing line of the outer suite — xcodebuild aborted?" };
  if (g.executed === 0) return { ok: false, ran: false, reason: "Executed 0 — wrong identifier? (old path without class reports SUCCEEDED with 0 tests)" };
  return { ok: false, ran: false, reason: `Warm-up test not in the output (Executed ${g.executed})` };
}

// ── Hardware keyboard of Simulator.app ──────────────────────────────────────────────────────
//
// Whether the software keyboard appears is decided by the menu item "I/O → Keyboard → Connect
// Hardware Keyboard", and Simulator.app stores it PER DEVICE under
// `DevicePreferences.<UDID>.ConnectHardwareKeyboard` in `com.apple.iphonesimulator`. The global
// key `ConnectHardwareKeyboard` (which `defaults read` used to read and take for 0) is only the
// default for devices without a value of their own. That is why the checkmark survived cold start
// and device restart: it stands in the file, not only in the memory of the app. A click writes it
// immediately, the app reads it at start.
//
// The menu is no good as a measurement: as long as the app has not been in front since the last new
// device window, System Events reports `missing value` for ALL three items with exit 0, even for "Use
// the Same Keyboard Language as macOS", which otherwise carries a checkmark. That produced "not
// connected" three times although the device had a hardware keyboard. So measurement happens in two
// places that need no focus: the stored preference and the device itself (unified log, see below).

export const SIM_DOMAIN = "com.apple.iphonesimulator";

/** The two key paths (`plutil` notation) for a device: its own value and the default. */
export function hwKeyboardKey(udid) {
  return { device: `DevicePreferences.${udid}.ConnectHardwareKeyboard`, global: "ConnectHardwareKeyboard" };
}

function plistBool({ output, code } = {}) {
  if (code !== 0) return null;
  const t = String(output || "").trim();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return null;
}

/**
 * The verdict on the stored preference from two `plutil -extract <path> raw` outputs (exit ≠ 0 =
 * key missing). The device value takes precedence over the default. If BOTH are missing, the default of
 * Simulator.app applies, and that is "connected" (without `ConnectHardwareKeyboard false`
 * the software keyboard never appeared). So `connected` means "not explicitly disconnected", because
 * empty is not unknown.
 */
export function hwKeyboardPreference({ device, global } = {}) {
  const g = plistBool(device);
  const v = plistBool(global);
  const source = g != null ? "device value" : v != null ? "global default" : "default of Simulator.app";
  const value = g ?? v;
  return { device: g, global: v, source, connected: value !== false };
}

/**
 * What the DEVICE itself believes. UIKit writes this line to the unified log when creating the keyboard
 * if it sees a hardware keyboard (afterwards `Setting keyboard minimized = YES`, the keyboard sits
 * at y 952). Without a hardware keyboard the line is missing entirely.
 */
export const HW_KEYBOARD_MARKER = "_hardwareKeyboardAvailable = YES";
// `log show` logs its own invocation including the predicate. Without `process != "log"` the
// search would find the marker in its own command line.
export const HW_KEYBOARD_PREDICATE = `process != "log" AND eventMessage CONTAINS "${HW_KEYBOARD_MARKER}"`;

/** `log show --start` wants local time as `YYYY-MM-DD hh:mm:ss`. */
export function logShowTime(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

/**
 * The output of `simctl spawn <udid> log show … --predicate HW_KEYBOARD_PREDICATE`: `true` means
 * the device had a hardware keyboard in the time window. `false` only means "not seen" (also
 * if the app never created the keyboard). An error is `null`. The self line of
 * `log` never counts, even if the predicate did not exclude it.
 */
export function hwKeyboardInDevice({ output, code } = {}) {
  if (code !== 0) return null;
  return String(output || "").split("\n").some((z) => z.includes(HW_KEYBOARD_MARKER) && !z.includes("log run noninteractively"));
}

/**
 * May a further warm-up attempt start? Only if the remaining deadline carries a whole attempt
 * (≥ `WARMUP_ATTEMPT_MIN_MS`). `timeoutMs` is the remaining deadline — never shorter than an attempt.
 */
export function warmupNextAttempt({ elapsedMs, deadlineMs = WARMUP_DEADLINE_MS, minMs = WARMUP_ATTEMPT_MIN_MS }) {
  const rest = deadlineMs - elapsedMs;
  if (rest < minMs) {
    return {
      start: false, timeoutMs: 0, restMs: Math.max(0, rest),
      reason: `Remaining deadline ${Math.max(0, Math.round(rest / 1000))} s carries no further attempt (~${Math.round(minMs / 1000)} s)`,
    };
  }
  return { start: true, timeoutMs: rest, restMs: rest, reason: null };
}

/**
 * An xcodebuild that ends without `** TEST EXECUTE SUCCEEDED/FAILED **` and reports exit ≠ 0 was
 * aborted (SIGKILL by the deadline, crash) — that belongs in the JSON as a warning, even if
 * the verdict is already not ok for another reason.
 */
export function completionWarning(run, code) {
  const p = run || {};
  if (p.succeeded || p.failedMarker) return null;
  if (code == null || code === 0) return null;
  return `xcodebuild without completion (exit ${code}, neither TEST EXECUTE SUCCEEDED nor FAILED) — aborted or crashed`;
}

// ── Load gate ───────────────────────────────────────────────────────────────────────────────

/**
 * macOS `uptime`: `… load averages: 2.41 2.32 2.32` (Linux: `load average: 2.41, 2.32, 2.32`).
 * With a German locale macOS writes `2,95 3,15 3,31` — so the probe runs with `LC_ALL=C`,
 * and the parser accepts the comma anyway.
 */
export function parseUptime(text) {
  const m = String(text || "").match(/load averages?:\s*(\d+(?:[.,]\d+)?)[\s,]+(\d+(?:[.,]\d+)?)[\s,]+(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const count = (s) => Number(s.replace(",", "."));
  const load1 = count(m[1]);
  return Number.isFinite(load1) ? load1 : null;
}

/**
 * Foreign build processes from `ps -Ao %cpu=,pid=,command=`.
 *
 * Counted is what demonstrably turns deadline tests red: `next dev` / `next-server` / a
 * `node …next…` (the web dev server of another session), EVERY `xcodebuild` (the gate runs
 * BEFORE the own build — what runs now belongs to someone else; a foreign DerivedData is
 * named), and `mds_stores` above 100 % CPU (Spotlight is indexing a DerivedData).
 */
export function foreignProcesses(psText, { derivedData = "" } = {}) {
  const out = [];
  for (const raw of String(psText || "").split("\n")) {
    const m = raw.match(/^\s*([\d.,]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const cpu = Number(m[1].replace(",", "."));
    const pid = +m[2];
    const cmd = m[3].trim();
    const short = cmd.length > 140 ? `${cmd.slice(0, 140)}…` : cmd;
    let reason = null;
    if (/next-server|next-router-worker/.test(cmd)) {
      reason = "next-server";
    } else if (/(^|\/|\s)next\s+(dev|start)(\s|$)/.test(cmd)) {
      reason = "next dev";
    } else if (/(^|\/)node\s+.*\bnext\b/.test(cmd)) {
      reason = "node …next…";
    } else if (/(^|\/)xcodebuild(\s|$)/.test(cmd)) {
      reason = derivedData && cmd.includes(derivedData)
        ? "xcodebuild (own DerivedData — a second run?)"
        : "xcodebuild (foreign tree)";
    } else if (/(^|\/)mds_stores(\s|$)/.test(cmd) && cpu > MDS_CPU_LIMIT) {
      reason = `mds_stores ${cpu.toFixed(0)} % CPU`;
    }
    if (reason) out.push({ pid, cpu, cmd: short, reason });
  }
  return out;
}

/**
 * What does the load gate do after ONE measurement? Four outcomes, so the flow in `mobile.mjs` carries
 * no logic of its own and the rule stays checkable:
 *
 *   `further` — the measurement is clean.
 *   `wait`    — not clean, the deadline is still running.
 *   `force`   — deadline expired AND `--force`: the run goes on, but with `forced: true`
 *               in message, table and JSON. A forced green must never look like a clean one.
 *   `abort`   — deadline expired, no `--force`.
 *
 * Why `force` exists at all: `foreignProcesses` flags `next dev`/`next-server` WITHOUT a CPU
 * threshold. If the dev server of ANOTHER project runs on the Mac for hours, the gate is not "not yet
 * met" but NEVER satisfiable: waiting does not help in principle, and `mobile --tests` would not be
 * runnable on this machine. `--force` is the documented way out with a log, not a shortcut:
 * `--force` means "skip gates" everywhere.
 *
 * And why `--force` does NOT skip everything: the reason it was built for does not go away by itself.
 * A running `xcodebuild` does go away — it is the one state the gate is really meant to prevent
 * (two builds on one machine; on the same DerivedData even more so). For that the abort still applies,
 * with `forceRefused: true` as the reason.
 */
export function loadGateDecision({ verdict, elapsedS, waitS, force = false }) {
  if (verdict?.ok) return { action: "further", forced: false, reason: null };
  const reason = verdict?.reason ?? "Load not measured";
  if (elapsedS < waitS) return { action: "wait", forced: false, reason };
  const xcode = (verdict?.foreign || []).filter((f) => /^xcodebuild/.test(f.reason || ""));
  if (force && xcode.length) {
    return {
      action: "abort", forced: false, forceRefused: true,
      reason: `${reason} — --force does NOT apply here: ${xcode.map((f) => `${f.reason} [${f.pid}]`).join(", ")}. `
        + "A second xcodebuild ends by itself; it is waited for, not walked past.",
    };
  }
  if (force) return { action: "force", forced: true, reason };
  return { action: "abort", forced: false, reason };
}

/** Load verdict: load (1 min) under the limit AND no foreign build processes. */
export function loadVerdict({ uptime, ps, derivedData = "" }) {
  const load1 = parseUptime(uptime);
  const foreign = foreignProcesses(ps, { derivedData });
  const reasons = [];
  if (load1 == null) reasons.push("Load not readable");
  else if (load1 >= LOAD_LIMIT) reasons.push(`Load ${load1.toFixed(2)} ≥ ${LOAD_LIMIT}`);
  if (foreign.length) reasons.push(`${foreign.length} foreign process(es): ${foreign.map((f) => `${f.reason} [${f.pid}]`).join(", ")}`);
  return { ok: reasons.length === 0, load1, foreign, reason: reasons.join("; ") || null };
}

// ── Simulator ───────────────────────────────────────────────────────────────────────────────

const UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * Determine the simulator from `xcrun simctl list -j devices available`: `wanted` is a UDID
 * or a device name ("iPhone 17" — exact, `iPhone 17 Pro` is another device). With
 * several devices of the same name (different runtimes) the booted one wins, otherwise the first.
 */
export function resolveSimulator(listJson, wanted) {
  const devices = [];
  for (const [runtime, ds] of Object.entries(listJson?.devices || {})) {
    for (const d of ds || []) {
      if (d?.isAvailable === false) continue;
      devices.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtime.split(".").pop() });
    }
  }
  const w = String(wanted || "").trim();
  if (!w) return null;
  if (UDID_RE.test(w)) return devices.find((d) => d.udid.toUpperCase() === w.toUpperCase()) || null;
  const equal = devices.filter((d) => d.name === w);
  return equal.find((d) => d.state === "Booted") || equal[0] || null;
}

/**
 * Boot time of a booted simulator from `ps -Ao lstart=,pid=,command=`: `simctl list`
 * knows no boot date, but the device's `launchd_sim` carries the UDID in its command line and
 * `lstart` says when it began. null if the device is not booted.
 * `lstart` is read only in the English format ("Tue Sep 15 14:47:52 2026") — so the probe runs
 * with `LC_ALL=C`; a German output ("Di 15 Sep …") would silently give null.
 */
export function bootTime(psText, udid) {
  if (!udid) return null;
  for (const raw of String(psText || "").split("\n")) {
    if (!raw.includes("launchd_sim") || !raw.includes(udid)) continue;
    // `lstart` = 24 characters fixed ("Tue Sep 15 14:47:52 2026"), then PID and command.
    const m = raw.match(/^\s*([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+\d+\s+/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) return new Date(t);
  }
  return null;
}

// ── Drafts, port ────────────────────────────────────────────────────────────────────────────

/**
 * Where the app's `UserDefaults.standard` lives: in the DATA CONTAINER that `xcrun simctl
 * get_app_container <udid> <bundle> data` names — `<path>/Library/Preferences/<bundle>.plist`.
 * NOT `defaults read <bundle>`: that is the user domain of the simulator (there stand `server`
 * and `ws` from a manual attempt, never a draft), and `defaults delete <bundle> <key>`
 * answers "Domain … not found" — the first version therefore ALWAYS reported "no drafts".
 *
 * Exit ≠ 0 means: the app is not installed (first run, or the device is fresh) — then there
 * is nothing to delete, and that stands there as a REASON, not as a success.
 */
export function draftPlist({ output, code, bundleId }) {
  const path = String(output || "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  if (code !== 0 || !path.startsWith("/")) {
    return {
      plist: null,
      reason: `nothing to delete — app ${bundleId} not installed (get_app_container exit ${code ?? "?"}${path ? `: ${path}` : ""})`,
    };
  }
  return { plist: `${path}/Library/Preferences/${bundleId}.plist`, reason: null };
}

/**
 * Keys with the draft prefix from `defaults read <plist-path>`:
 *     "cbase.mobile.draft:2000…-0001" = "edge test";
 * A missing file/domain ("does not exist") is no error: then there is nothing to delete.
 */
export function draftKey(defaultsText) {
  const out = [];
  const re = new RegExp(`^\\s*"(${DRAFT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*)"\\s*=`);
  for (const raw of String(defaultsText || "").split("\n")) {
    const m = raw.match(re);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * What happened to the draft keys found? `byText` is the SECOND `defaults read` (after
 * deleting) — a delete that does not take effect must not pass as success.
 *
 * In a DRY RUN no `defaults delete` is executed, so nothing is deleted either: the function used
 * to return the found keys as `deleted` and the tool reported "2 deleted" for a run that touched
 * nothing. A dry run that reports deleted data is none.
 */
export function draftsResult({ keys = [], dryRun = false, byText = null }) {
  if (!keys.length) return { deleted: [], remaining: [], reason: "no drafts in the plist" };
  if (dryRun) {
    return {
      deleted: [], remaining: keys,
      reason: `dry run — nothing deleted (${keys.length} draft(s) found that a real run would delete)`,
    };
  }
  const remaining = draftKey(byText).filter((k) => keys.includes(k));
  return { deleted: keys.filter((k) => !remaining.includes(k)), remaining, reason: null };
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` → [{pid, comm}]. Empty if nobody listens. */
export function parseLsof(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === "p") {
      cur = { pid: +line.slice(1), comm: "" };
      out.push(cur);
    } else if (line[0] === "c" && cur) {
      cur.comm = line.slice(1);
    }
  }
  return out;
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────

/** The JSON of a run — what the next agent and the skeptic read. */
export function summary({
  stamp, run = 1, runs = 1, only = [], expected = [], parsed, verdict, totalDurationS = null,
  loadPrior = null, loadAfter = null, bootAgeS = null, fixturePid = null, warmup = null,
  logPath = null, buildS = null, exitCode = null, drafts = null,
}) {
  const g = parsed?.total || null;
  return {
    stamp,
    run,
    runs,
    mode: only.length ? "only" : "full",
    only,
    executed: g ? g.executed : null,
    expected: Array.isArray(expected) ? expected.length : expected,
    ok: !!verdict?.ok,
    reason: verdict?.reason ?? null,
    warn: completionWarning(parsed, exitCode),
    red: parsed?.red || [],
    skips: parsed?.skips || [],
    skipReasons: parsed?.skipReasons || {},
    skipsDisallowed: verdict?.skipsDisallowed || [],
    passed: (parsed?.passed || []).length,
    unexpected: g ? g.unexpected : null,
    durationPerTest: parsed?.durationPerTest || {},
    totalDurationS: totalDurationS ?? (g ? g.durationS : null),
    buildS,
    loadPrior,
    loadAfter,
    bootAgeS,
    fixturePid,
    warmup,
    drafts,
    succeeded: !!parsed?.succeeded,
    exitCode,
    xcresult: parsed?.xcresult ?? null,
    log: logPath,
  };
}
