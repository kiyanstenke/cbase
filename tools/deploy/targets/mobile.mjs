// The iOS app. It is still built by the proven .command scripts — this target only adds
// what used to have to come from memory:
//
//  · RIGHT USER CONTEXT. Xcode accounts, keychain certificates and provisioning data are
//    per user. As root xcodebuild reports "No Accounts" and "No profiles for
//    dev.cbase.mobile" although everything is fine in the open Xcode app.
//  · NO CREDENTIALS IN THE REPO. Server address, user name and password are entered at
//    runtime; a hit in the source tree aborts the deploy.
//  · TestFlight goes outward (upload to Apple) — always with a confirmation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, config, desktopUser } from "../config.mjs";
import { act, isDryRun, probe, shProbe, sleep } from "../../check/lib/sh.mjs";
import { confirm } from "../lib/prompt.mjs";
import { findIphones, xcrunCaller } from "../lib/iphone.mjs";
import * as log from "../../check/lib/log.mjs";
import {
  LIVE_WALKTHROUGH, NOT_IN_FULL_RUN, LOAD_LIMIT, WARMUP, WARMUP_DEADLINE_MS, deviationVerdict, bootTime, draftsResult,
  HW_KEYBOARD_PREDICATE, SIM_DOMAIN, hwKeyboardInDevice, hwKeyboardPreference, hwKeyboardKey, logShowTime,
  draftKey, draftPlist, expectation, loadGateDecision, loadVerdict, normIdentifiers,
  parseEnumeration, parseLsof,
  parseTestRun, resolveSimulator, warmupNextAttempt, warmupVerdict, summary,
} from "../../check/lib/uitests.mjs";

const SCRIPTS = {
  device: "refresh-on-iphone.command",
  testflight: "deploy-testflight.command",
  ipa: "make-ipa.command",
};

const MOBILE = path.join(REPO, "mobile");

export async function deployMobile({ mode = "device", force }) {
  const script = SCRIPTS[mode];
  if (!script) throw new Error(`Unknown mobile mode: ${mode} (device | testflight | ipa)`);

  const user = desktopUser();
  const me = os.userInfo().username;
  const needSudo = me !== user;

  log.step(`iOS app: ${mode}`);
  log.table([
    ["User context", needSudo ? `${me} → sudo -u ${user}` : me, null],
    ["Xcode", fs.existsSync(config.mobile.xcodeApp) ? config.mobile.xcodeApp : "MISSING", fs.existsSync(config.mobile.xcodeApp) ? "ok" : "bad"],
  ]);
  if (!fs.existsSync(config.mobile.xcodeApp)) {
    throw new Error(`Xcode not found: ${config.mobile.xcodeApp} (CBASE_XCODE_APP set)`);
  }
  if (needSudo && !process.stdin.isTTY) {
    throw new Error(`The mobile deploy needs the desktop user ${user}; without a terminal sudo cannot ask.`);
  }

  await preflight({ user, needSudo, mode, force });

  if (mode === "testflight") {
    await confirm("Archive and upload to App Store Connect?", {
      consequence: "This goes outward: the build lands at Apple and appears in TestFlight.",
    });
  }

  // Xcode location and device UDID come from the deploy configuration, not from the defaults in
  // the script — one source for all targets. `sudo` clears the environment, hence via `env`.
  const cmd = path.join(MOBILE, script);
  const vars = [`CBASE_XCODE_APP=${config.mobile.xcodeApp}`];
  if (config.mobile.udid) vars.push(`CBASE_DEVICE_UDID=${config.mobile.udid}`);
  // The signing team is personal (it names the Apple account): never in the project file, only in deploy.local.json `mobile.team`.
  if (config.mobile.team) vars.push(`CBASE_DEVELOPMENT_TEAM=${config.mobile.team}`);
  if (needSudo) await act("sudo", ["-u", user, "-H", "env", ...vars, cmd], { cwd: MOBILE, timeout: 3600000 });
  else {
    const env = { ...process.env };
    for (const v of vars) env[v.slice(0, v.indexOf("="))] = v.slice(v.indexOf("=") + 1);
    await act(cmd, [], { cwd: MOBILE, env, timeout: 3600000 });
  }

  if (isDryRun()) return;
  log.ok(mode === "testflight" ? "Upload finished — Apple is processing the build" : "iOS app updated");
}

/**
 * Is there REALLY an Apple account in Xcode?
 *
 * An earlier check, `accounts.stdout.trim().length > 0`, could NOT fail: `defaults read` returns a
 * complete skeleton even for an empty list:
 *
 *     { "IDE.Identifiers.Prod" =     ( ); }        ← 45 characters, i.e. "present"
 *
 * The preflight then reported "Xcode account present", `archive` ran through (it works with the
 * developer identity), and only the upload broke off with "Failed to Use Accounts — App Store
 * Connect access for … is required".
 *
 * What counts is what stands INSIDE the brackets. No `| head -5` either: it would cut off the
 * closing bracket of a longer list.
 *
 * Proven in `tools/deploy/mobile-preflight.test.mjs`, with the real output of the logged-out state as the probe.
 */
export function hatAppleAccount(output) {
  // Every "( … )" group; an account is only what in it is not mere whitespace.
  const groups = String(output || "").match(/\(([\s\S]*?)\)/g) || [];
  return groups.some((g) => g.slice(1, -1).trim().length > 0);
}

async function preflight({ user, needSudo, mode, force }) {
  // .plist with plutil, .json with a JSON parser. Not plutil for both: the plutil of the
  // command-line tools rejects JSON input at -lint ("Unexpected character { at line 1")
  // although the file is fine — the check would then ALWAYS fail.
  const files = [
    "CbaseMobile/Info.plist",
    "CbaseMobile/PrivacyInfo.xcprivacy",
    "CbaseMobile/Assets.xcassets/AppIcon.appiconset/Contents.json",
  ].map((p) => path.join(MOBILE, p));
  const bad = [];
  for (const p of files) {
    if (!fs.existsSync(p)) continue;
    if (p.endsWith(".json")) {
      try {
        JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (e) {
        bad.push(`${path.basename(p)}: ${e.message}`);
      }
    } else {
      const r = await probe("plutil", ["-lint", p]);
      if (r.code !== 0) bad.push(`${path.basename(p)}: ${(r.stdout || r.stderr).trim()}`);
    }
  }

  // Credentials must not end up in the source tree (not even in test schemes).
  const leak = await shProbe(
    `rg -n --hidden -g '!*.xcuserdatad' 'cbase\\.example\\.net|CBASE_MOBILE_TEST_PASSWORD' mobile || true`,
    { cwd: REPO },
  );
  const leaks = leak.stdout.split("\n").filter((l) => l.trim());

  // Signing works only with account + identity in the right user context.
  const asUser = (cmd) => (needSudo ? shProbe(`sudo -u ${user} -H sh -lc '${cmd}'`) : shProbe(cmd));
  const accounts = await asUser("defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists 2>/dev/null || true");
  const ident = await asUser("security find-identity -v -p codesigning 2>/dev/null || true");
  const hasIdentity = /Apple Development|Apple Distribution/.test(ident.stdout);
  const hasAccount = hatAppleAccount(accounts.stdout);
  // Only for the table: WHY the account counts or not is in `preflightVerdict`.
  const needsAccount = mode === "testflight";

  let device = null;
  let devices = [];
  if (mode === "device") {
    // The computation (JSON instead of table, wake first, then count; Wi-Fi like cable) is in
    // lib/iphone.mjs — shared with `status`. DEVELOPER_DIR and the user context (the PRE-QUERY
    // also runs as the desktop user) are in `xcrunCaller`.
    const xcrun = xcrunCaller({ probe, user, needSudo, developerDir: `${config.mobile.xcodeApp}/Contents/Developer` });
    ({ devices } = await findIphones({ xcrun, udid: config.mobile.udid }));
    device = devices.length > 0;
  }

  log.table([
    ["Info.plist / AppIcon Contents.json", bad.length ? bad.join("; ") : "clean", bad.length ? "bad" : "ok"],
    ["no credentials in the source tree", leaks.length ? `${leaks.length} hit(s)` : "yes", leaks.length ? "bad" : "ok"],
    // The account is needed ONLY for the upload (see `needsAccount`) — for building and
    // installing it is a hint here, not a verdict.
    ["Xcode account", hasAccount ? "present" : (needsAccount ? "NONE" : "none (not needed for this mode)"),
      hasAccount ? "ok" : (needsAccount ? "bad" : "warn")],
    ["Signing identity", hasIdentity ? "present" : "NONE", hasIdentity ? "ok" : "bad"],
    ...(mode === "device" ? [["iPhone connected", device ? devices.map((g) => g.text).join(", ") : "no", device ? "ok" : "bad"]] : []),
  ]);
  for (const l of leaks.slice(0, 5)) log.detail(l);

  const hold = preflightVerdict({ mode, hasAccount, hasIdentity, device, bad, leaks, force, user });
  if (hold) throw new Error(hold);
}

/**
 * The verdict of the preflight — separated and pure so it can be tested.
 *
 * Two errors deserve this separation:
 *   1. The account check could not fail (see `hatAppleAccount`) and let a hopeless upload
 *      archive for ten minutes.
 *   2. The repair then demanded the account for EVERY mode — and blocked the direct way to the
 *      iPhone, which has always worked without an account (identity and provisioning profile
 *      are local).
 *
 * A check that demands too much is the same evil as one that checks nothing — just the other
 * way round, and it is noticed later because it feels like diligence.
 *
 * @returns the error message, or null if nothing is in the way.
 */
export function preflightVerdict({ mode, hasAccount, hasIdentity, device, bad = [], leaks = [], force, user = "the desktop user" }) {
  // Broken files ALWAYS stop, even with --force: an invalid Info.plist is no discretion
  // but a build that fails anyway.
  if (bad.length) return "plutil reports faulty files.";
  if (force) return null;
  if (leaks.length) return "Credentials/server address found in the source tree — do not roll out.";
  if (!hasIdentity) {
    return `No signing identity for ${user}. Check Xcode → Settings → Accounts (as ${user}, not as root).`;
  }
  // ONLY the upload needs the account. `--device` and `--ipa` sign with the identity and
  // an already existing provisioning profile.
  if (mode === "testflight" && !hasAccount) {
    return `No Xcode account for ${user} — the upload needs a logged-in `
      + `App Store Connect session (Apple ID with two-factor), and only a human can `
      + `establish that: Xcode → Settings → Accounts. Building and installing on the device works without `
      + `(\`deploy mobile --device\`) as long as identity and provisioning profile are valid.`;
  }
  if (mode === "device" && !device) {
    return "No iPhone connected — plug it in, or `deploy mobile --ipa`.";
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// `mobile --tests` — the full XCUITest run with all preconditions. It used to be only a manual
// command in mobile/README.md, and every precondition came from memory: port 17718 free? Fixture
// fresh? Simulator warm (the software keyboard is missing the first ~4 minutes after boot)?
// Foreign load? And the count: an `-only-testing` on a path that does not exist reports SUCCEEDED
// with ZERO tests. Everything here went wrong once.
//
// Sequence (each step an act()/probe() so --dry-run shows it):
//   (1) port 17718 — taken ⇒ abort with PID and command line (a FOREIGN process, do not kill)
//   (2) start the fixture, wait for CBASE_MOBILE_FIXTURE_READY; ALWAYS end it at the end
//   (3) hardware keyboard: the DEVICE VALUE in the preferences of Simulator.app (not the global
//       key, not the menu) — unless it is explicitly "disconnected", the app is quit, the value
//       set and the app reopened; then open Simulator.app, boot the device (note the boot time)
//   (2b) delete persistent composer drafts in the simulator — AFTER the boot, because `simctl spawn`
//        needs a booted device. Deleted in the plist of the app's DATA CONTAINER (the first
//        version hit the user domain of the simulator and was a silent no-op)
//   (4) load gate: load < 3 and no foreign build processes, at most --wait s (default 600)
//   (5) build-for-testing into its own DerivedData
//   (6) expectation from -enumerate-tests (all identifiers minus live walkthrough; with --only exactly
//       those — deduplicated, a class identifier expands to its tests)
//   (7) warm-up test AAAWarmupUITests/testKeyboardAppears first on its own, up to 5 min with retries;
//       passed means "is in passed", a skip is no keyboard; after a red attempt the tool asks the
//       device (unified log) whether it saw a hardware keyboard, and then resets Simulator.app once
//   (8) full run test-without-building (or --only, --runs N times)
//   (9) Executed against expectation ⇒ exit 1 even on SUCCEEDED; every skip except the five
//       diagnostic skips ⇒ exit 1 (with --only: every skip); log .deploy-logs/uitests-<stamp>.{log,json}

const FIXTURE = path.join(MOBILE, "test-fixtures/chat-gateway.mjs");
const FIXTURE_PORT = 17718;
const FIXTURE_READY = `CBASE_MOBILE_FIXTURE_READY ${FIXTURE_PORT}`;

function xcodeEnv() {
  return { ...process.env, DEVELOPER_DIR: `${config.mobile.xcodeApp}/Contents/Developer` };
}

// The measurement probes (`uptime`, both `ps`) run with `LC_ALL=C`: with a German locale macOS writes
// `load averages: 2,95 3,15 3,31`, and `lstart` would come as "Di 15 Sep …" — `bootTime` does not
// read that (silently null, "boot age unknown"). The parser tolerates the comma anyway (unit case).
function cEnv() {
  return { ...process.env, LC_ALL: "C" };
}

function fmtDuration(s) {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

/** The fixture as a child process; stdout/stderr into a file of its own, READY line awaited. */
async function fixtureStart(logPath) {
  if (isDryRun()) {
    log.cmdLine(`[dry] node ${FIXTURE} > ${logPath} 2>&1 &   (waits for "${FIXTURE_READY}", end: SIGTERM)`);
    return null;
  }
  log.cmdLine(`node ${FIXTURE} > ${logPath} 2>&1 &`);
  const out = fs.openSync(logPath, "a");
  const child = spawn("node", [FIXTURE], { cwd: MOBILE, stdio: ["ignore", "pipe", out] });
  let seen = "";
  let ready = false;
  child.stdout.on("data", (d) => {
    fs.writeSync(out, d);
    if (!ready) {
      seen += d;
      if (seen.includes(FIXTURE_READY)) ready = true;
    }
  });
  let tot = false;
  child.on("exit", () => { tot = true; });
  const until = Date.now() + 30000;
  while (!ready && !tot && Date.now() < until) await sleep(200);
  if (!ready) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    throw new Error(`Fixture reported no "${FIXTURE_READY}" within 30 s (dead=${tot}) — log: ${logPath}`);
  }
  const handle = {
    pid: child.pid,
    ended: false,
    async end() {
      if (handle.ended) return;
      handle.ended = true;
      if (tot) return;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const deadline = Date.now() + 5000;
      while (!tot && Date.now() < deadline) await sleep(100);
      if (!tot) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
      try { fs.closeSync(out); } catch { /* ignore */ }
    },
  };
  // Safety net against a hard end of the tool (process.exit elsewhere): the child must not
  // stay on 17718 as an orphan — exactly that once let runs measure against an OLD fixture.
  process.on("exit", () => { if (!tot) { try { child.kill("SIGTERM"); } catch { /* ignore */ } } });
  return handle;
}

async function portCheck() {
  const r = await probe("lsof", ["-nP", `-iTCP:${FIXTURE_PORT}`, "-sTCP:LISTEN", "-Fpc"]);
  const occupied = parseLsof(r.stdout);
  if (!occupied.length) {
    log.ok(`Port ${FIXTURE_PORT} free`);
    return;
  }
  const rows = [];
  for (const b of occupied) {
    const ps = await probe("ps", ["-o", "command=", "-p", String(b.pid)]);
    rows.push(`pid ${b.pid} (${b.comm}): ${ps.stdout.trim() || "?"}`);
  }
  const notice = `Port ${FIXTURE_PORT} is taken — a FOREIGN process, do not kill: ${rows.join("; ")}. `
    + "An old fixture from another session would otherwise measure against the OLD state; whoever started it ends it.";
  // In a dry run this is a finding, not an abort — the command sequence should still become
  // visible. For real it aborts here, BEFORE anything is started.
  if (isDryRun()) {
    log.warn(`${notice} (real run: abort here)`);
    return;
  }
  throw new Error(notice);
}

const EMPTY_PLIST = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  + '<plist version="1.0">\n<dict/>\n</plist>\n';

// The hardware keyboard stands PER DEVICE in the preferences of Simulator.app (lib/uitests.mjs).
// Read via `defaults export`, i.e. through cfprefsd — the file under ~/Library/Preferences can lag behind cfprefsd.
async function hwKeyboardPreferenceRead(udid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-sim-"));
  const file = path.join(dir, "simulator.plist");
  try {
    const ex = await probe("defaults", ["export", SIM_DOMAIN, file]);
    const read = async (filePath) => {
      if (ex.code !== 0) return { output: "", code: ex.code };
      const r = await probe("plutil", ["-extract", filePath, "raw", "-o", "-", file]);
      return { output: r.stdout, code: r.code };
    };
    const k = hwKeyboardKey(udid);
    return hwKeyboardPreference({ device: await read(k.device), global: await read(k.global) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Quit Simulator.app (it shuts the device down with it; `simctl shutdown` makes sure if not).
// Wait until the process is gone: the app holds the keyboard value in memory, and what is
// written before it ends it can overwrite.
async function simulatorEnd(udid) {
  await act("killall", ["Simulator"], { check: false });
  if (!isDryRun()) {
    for (let i = 0; i < 40 && (await probe("pgrep", ["-x", "Simulator"])).code === 0; i += 1) await sleep(500);
  }
  await act("xcrun", ["simctl", "shutdown", udid], { env: xcodeEnv(), check: false });
}

// Device value AND default to "disconnected", with the app quit. Written via `defaults export` →
// `plutil` → `defaults import` so cfprefsd knows the state (a `plutil` directly on the file would
// be overwritten by cfprefsd on the next write). `-insert` creates missing dictionaries and
// fails harmlessly if they exist; `-replace` needs them.
async function hwKeyboardDisconnect(udid) {
  await simulatorEnd(udid);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-sim-"));
  const file = path.join(dir, "simulator.plist");
  try {
    if ((await probe("defaults", ["export", SIM_DOMAIN, file])).code !== 0) fs.writeFileSync(file, EMPTY_PLIST);
    const k = hwKeyboardKey(udid);
    await act("plutil", ["-insert", "DevicePreferences", "-dictionary", file], { check: false });
    await act("plutil", ["-insert", `DevicePreferences.${udid}`, "-dictionary", file], { check: false });
    await act("plutil", ["-replace", k.device, "-bool", "NO", file]);
    await act("plutil", ["-replace", k.global, "-bool", "NO", file]);
    await act("defaults", ["import", SIM_DOMAIN, file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function simulatorReady() {
  const env = xcodeEnv();
  const list = await probe("xcrun", ["simctl", "list", "-j", "devices", "available"], { env });
  let json = null;
  try { json = JSON.parse(list.stdout); } catch { json = null; }
  const sim = resolveSimulator(json, config.mobile.simulator);
  if (!sim) {
    throw new Error(`No simulator "${config.mobile.simulator}" in \`xcrun simctl list devices available\` — `
      + "check deploy.local.json → mobile.simulator (name or UDID).");
  }
  // Hardware keyboard BEFORE opening: if it is "connected" for this device, the software keyboard
  // never appears and no cold or device restart changes that — the value is in the file. Fixing it
  // here costs ~10 s instead of a red warm-up attempt (~100 s).
  const hwKeyboard = await hwKeyboardPreferenceRead(sim.udid);
  if (hwKeyboard.connected) {
    log.warn(`Hardware keyboard of Simulator.app connected for this device (${hwKeyboard.source}) — `
      + "quit Simulator.app, set to \"disconnected\", reopen");
    await hwKeyboardDisconnect(sim.udid);
  }
  const state = hwKeyboard.connected ? "Shutdown" : sim.state;
  // Simulator.app FIRST: without a running app xcodebuild boots with a hardware keyboard attached
  // and every keyboard test fails on "too much air". `-CurrentDeviceUDID` points at our device.
  await act("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", sim.udid]);
  let bootAt = null;
  if (state !== "Booted") {
    await act("xcrun", ["simctl", "boot", sim.udid], { env, check: false });
    bootAt = new Date();
  }
  await act("xcrun", ["simctl", "boot-status", sim.udid, "-b"], { env, timeout: 180000 });
  if (!bootAt) {
    const ps = await probe("ps", ["-Ao", "lstart=,pid=,command="], { env: cEnv() });
    bootAt = bootTime(ps.stdout, sim.udid);
  }
  return { ...sim, state, bootAt, hwKeyboard };
}

/**
 * Delete the persistent composer drafts of the app — in the plist of its DATA CONTAINER.
 *
 * Measured: `defaults read|delete dev.cbase.mobile` hits `data/Library/Preferences/<bundle>.plist`
 * of the simulator USER (165 bytes, only `server` + `ws` by hand), not `UserDefaults.standard` of the
 * sandboxed app. That one lies under
 * `$(simctl get_app_container <udid> <bundle> data)/Library/Preferences/<bundle>.plist`, and there
 * stood the drafts. `defaults delete <bundle> <key>` answered "Domain … not found" (exit 1) —
 * the step was a silent no-op with a green tick.
 *
 * Returns `{ deleted, remaining, reason, plist }`: `reason` is set when there was NOTHING to do
 * and why (app not installed, no plist) — it stands so in the log and the JSON, not as success.
 * `remaining` are keys that are still there when read back after deleting.
 */
async function draftsDelete(udid) {
  const env = xcodeEnv();
  const bundleId = config.mobile.bundleId;
  const c = await probe("xcrun", ["simctl", "get_app_container", udid, bundleId, "data"], { env });
  const { plist, reason } = draftPlist({ output: c.stdout || c.stderr, code: c.code, bundleId });
  if (!plist) return { deleted: [], remaining: [], reason, plist: null };
  const r = await probe("xcrun", ["simctl", "spawn", udid, "defaults", "read", plist], { env });
  const keys = draftKey(r.stdout);
  if (!keys.length) {
    const noPlist = r.code !== 0;
    return {
      deleted: [], remaining: [], plist,
      reason: noPlist
        ? `no drafts — the app has not written any settings yet (defaults read: ${(r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}`})`
        : "no drafts in the plist",
    };
  }
  for (const k of keys) {
    // "does not exist" is no error — the key was already gone between reading and deleting.
    await act("xcrun", ["simctl", "spawn", udid, "defaults", "delete", plist, k], { env, check: false });
  }
  // Read back: a deletion that does not take must not pass as success. In a dry run nothing
  // was deleted (the `act` above were only shown) — so there is nothing to read back, and what
  // is reported is what happened: nothing.
  const after = isDryRun() ? null : await probe("xcrun", ["simctl", "spawn", udid, "defaults", "read", plist], { env });
  return { ...draftsResult({ keys, dryRun: isDryRun(), byText: after?.stdout }), plist };
}

async function loadMeasure(derivedData) {
  const up = await probe("uptime", [], { env: cEnv() });
  const ps = await probe("ps", ["-Ao", "%cpu=,pid=,command="], { env: cEnv() });
  return loadVerdict({ uptime: up.stdout, ps: ps.stdout, derivedData });
}

async function loadGate({ derivedData, waitS, force = false }) {
  const start = Date.now();
  for (;;) {
    const u = await loadMeasure(derivedData);
    const elapsed = (Date.now() - start) / 1000;
    if (isDryRun() && !u.ok) {
      log.warn(`Load gate not met (${u.reason}) — a dry run does not wait.`);
      return { ...u, waitedS: 0, forced: false };
    }
    const e = loadGateDecision({ verdict: u, elapsedS: elapsed, waitS, force });
    if (e.action === "further") {
      log.ok(`Load ${u.load1.toFixed(2)} < ${LOAD_LIMIT}, no foreign build processes`);
      return { ...u, waitedS: Math.round((Date.now() - start) / 1000), forced: false };
    }
    if (e.action === "wait") {
      log.detail(`waiting for idle (${e.reason}) — ${Math.round(elapsed)}/${waitS} s`);
      await sleep(15000);
      continue;
    }
    // From here on the deadline is over: either abort or a LOGGED override.
    log.table([
      ["Load (1 min)", u.load1 == null ? "?" : u.load1.toFixed(2), u.load1 != null && u.load1 < LOAD_LIMIT ? "ok" : "bad"],
      ...u.foreign.map((f) => [`pid ${f.pid}`, `${f.reason} — ${f.cmd}`, "bad"]),
    ]);
    if (e.action === "force") {
      log.warn(`--force: load gate overridden after ${Math.round(elapsed)} s (${e.reason}). `
        + "The measurement is in the JSON as `loadPrior.forced` — a forced green is not a clean one.");
      return { ...u, waitedS: Math.round((Date.now() - start) / 1000), forced: true };
    }
    throw new Error(`Load gate not met after ${Math.round(elapsed)} s: ${e.reason}.`
      + (e.forceRefused
        ? " Only waiting helps here: `--wait 1200`, until the foreign build is done."
        : " Wait (`--wait 1200`), end the foreign load — or, if it cannot end (a foreign "
          + "`next dev` blocks forever without a CPU threshold), `--force`: the run then continues and the "
          + "measured load stands in the log. Never two xcodebuild on this machine."));
  }
}

/** Progress of a test run on the console — one line per test as soon as it arrives. */
function progress(line) {
  const m = line.match(/^Test Case '-\[[A-Za-z0-9_]+\.([A-Za-z0-9_]+) ([A-Za-z0-9_]+)\]' (passed|failed|skipped) \(([\d.]+) seconds\)/);
  if (!m) return;
  const text = `${m[1]}/${m[2]} (${Math.round(+m[4])} s)`;
  if (m[3] === "passed") log.ok(text);
  else if (m[3] === "failed") log.fail(text);
  else log.detail(`skipped: ${text}`);
}

async function xcodebuildRun(base, args, { logPath, timeout }) {
  const r = await act("xcodebuild", [...base, ...args], { env: xcodeEnv(), timeout, check: false, onLine: progress });
  if (!r.skipped) fs.appendFileSync(logPath, `\n=== xcodebuild ${args.join(" ")} — ${new Date().toISOString()} ===\n${r.stdout}${r.stderr}`);
  return r;
}

/**
 * @param {object} opts
 * @param {string[]} opts.only   identifiers `CbaseMobileUITests/<class>/<test>` (empty = full run)
 * @param {number}   opts.runs   repetitions of the run (for the 5x proofs)
 * @param {number}   opts.wait   seconds for the load gate (default 600)
 * @param {string}   opts.stamp  release identifier (file names of the logs)
 * @returns {Promise<{ok: boolean, runs: object[]}>} — sets process.exitCode, never calls process.exit
 */
export async function runMobileTests({ only = [], runs = 1, wait = 0, stamp, force = false }) {
  const user = desktopUser();
  const me = os.userInfo().username;
  if (me !== user && !isDryRun()) {
    throw new Error(`\`mobile --tests\` needs the desktop user ${user} (simulator and DerivedData are per user) — do not start it as ${me}.`);
  }
  if (!fs.existsSync(config.mobile.xcodeApp)) {
    throw new Error(`Xcode not found: ${config.mobile.xcodeApp} (CBASE_XCODE_APP set)`);
  }
  const waitS = wait > 0 ? wait : 600;
  const runsN = Math.max(1, Math.floor(runs || 1));
  // Deduplicated: the same identifier in two spellings would otherwise give expectation 2 against executed 1.
  const onlyList = normIdentifiers(only);
  const derivedData = config.mobile.testDerivedData;
  const logDir = path.join(REPO, ".deploy-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `uitests-${stamp}.log`);
  const fixtureLog = path.join(logDir, `uitests-${stamp}-fixture.log`);
  const start = Date.now();

  log.step("UITests: preconditions");
  log.table([
    ["Mode", onlyList.length ? `--only ${onlyList.join(" ")}` : "full run (without live walkthrough)", null],
    ["Runs", String(runsN), null],
    ["DerivedData", derivedData, null],
    ["Load gate", force ? `wait up to ${waitS} s, then --force (override and log)` : `wait up to ${waitS} s`, force ? "warn" : null],
    ["Log", logPath, null],
  ]);

  // (1) Port
  log.step(`UITests (1/9): Port ${FIXTURE_PORT}`);
  await portCheck();

  let fixture = null;
  const runsValue = [];
  let allOk = false;
  try {
    // (2) Fixture
    log.step("UITests (2/9): start fixture");
    fixture = await fixtureStart(fixtureLog);
    if (fixture) log.ok(`Fixture running (pid ${fixture.pid}, log ${fixtureLog})`);

    // (3) Simulator
    log.step("UITests (3/9): Simulator");
    const sim = await simulatorReady();
    const bootAgeS = sim.bootAt ? Math.round((Date.now() - sim.bootAt.getTime()) / 1000) : null;
    log.table([
      ["Device", `${sim.name} (${sim.runtime}) ${sim.udid}`, null],
      ["State", sim.state === "Booted" ? "was booted" : "booted now", null],
      ["Boot age", bootAgeS == null ? "unknown" : fmtDuration(bootAgeS), bootAgeS != null && bootAgeS < 240 ? "warn" : null],
      ["Hardware keyboard", sim.hwKeyboard.connected ? `was connected (${sim.hwKeyboard.source}) — disconnected, Simulator.app reopened` : `disconnected (${sim.hwKeyboard.source})`, sim.hwKeyboard.connected ? "warn" : "ok"],
    ]);
    if (bootAgeS != null && bootAgeS < 240) log.warn("Freshly booted — the software keyboard needs ~4 min; the warm-up test repeats until then.");

    // (2b) drafts — after the boot, because `simctl spawn` needs a booted device
    log.step("UITests (2b/9): delete persistent composer drafts (data container of the app)");
    const drafts = await draftsDelete(sim.udid);
    if (drafts.plist) log.detail(`Plist: ${drafts.plist}`);
    if (drafts.reason) log.warn(drafts.reason);
    else if (drafts.remaining.length) log.warn(`${drafts.remaining.length} draft(s) NOT deleted (still there when read back): ${drafts.remaining.join(", ")}`);
    if (drafts.deleted.length) log.ok(`${drafts.deleted.length} draft(s) deleted: ${drafts.deleted.join(", ")}`);

    // (4) Load-Gate
    log.step("UITests (4/9): load gate");
    const loadPrior = await loadGate({ derivedData, waitS, force });

    // (5) Build
    log.step("UITests (5/9): build-for-testing");
    log.detail(`DEVELOPER_DIR=${config.mobile.xcodeApp}/Contents/Developer for all xcodebuild/xcrun calls`);
    const base = [
      "-project", path.join(MOBILE, "CbaseMobile.xcodeproj"),
      "-scheme", config.mobile.scheme,
      "-destination", `platform=iOS Simulator,id=${sim.udid}`,
      "-derivedDataPath", derivedData,
    ];
    const buildStart = Date.now();
    const build = await act("xcodebuild", [...base, "build-for-testing"], { env: xcodeEnv(), timeout: 1800000, check: false });
    const buildS = Math.round((Date.now() - buildStart) / 1000);
    if (!build.skipped) {
      fs.appendFileSync(logPath, `=== xcodebuild build-for-testing — ${new Date().toISOString()} ===\n${build.stdout}${build.stderr}`);
      if (build.code !== 0 || !/\*\* TEST BUILD SUCCEEDED \*\*/.test(build.stdout)) {
        const error = build.stdout.split("\n").filter((l) => /error:/.test(l)).slice(0, 8);
        throw new Error(`build-for-testing failed (exit ${build.code}) — log: ${logPath}${error.length ? `\n  ${error.join("\n  ")}` : ""}`);
      }
      log.ok(`Build in ${fmtDuration(buildS)}`);
    }

    // (6) expectation
    log.step("UITests (6/9): expectation from -enumerate-tests");
    const en = await act("xcodebuild", [...base, "-enumerate-tests", "-test-enumeration-style", "flat", "-test-enumeration-format", "text", "test-without-building"], { env: xcodeEnv(), timeout: 300000, check: false });
    // A dry run has no enumeration: the arguments are then the (deduplicated) requests themselves,
    // a class identifier goes unexpanded to -only-testing.
    let expected = { list: [], unknown: [], args: onlyList, fromClass: [] };
    if (!en.skipped) {
      fs.appendFileSync(logPath, `\n=== xcodebuild -enumerate-tests — ${new Date().toISOString()} ===\n${en.stdout}${en.stderr}`);
      const identifiers = parseEnumeration(en.stdout);
      if (!identifiers.length) throw new Error(`-enumerate-tests returned no identifier (exit ${en.code}) — log: ${logPath}`);
      expected = expectation(identifiers, { only: onlyList });
      if (expected.unknown.length) {
        throw new Error(`Unknown identifier(s): ${expected.unknown.join(", ")} — identifiers are named `
          + "CbaseMobileUITests/<Class>/<test> (or CbaseMobileUITests/<Class> for all tests of the class); "
          + "an old path without a class would silently run into nothing (SUCCEEDED, 0 tests).");
      }
      const hatWarmup = identifiers.includes(WARMUP);
      log.table([
        ["Identifiers in total", String(identifiers.length), null],
        ["Live walkthrough", identifiers.includes(LIVE_WALKTHROUGH) ? "is skipped" : "not in the bundle", null],
        ["Warm-up test", hatWarmup ? "in the bundle" : "MISSING from the bundle", hatWarmup ? "ok" : "bad"],
        ["Expectation per run", String(expected.list.length), "ok"],
        ...(onlyList.length ? [["-only-testing", expected.args.join(" "), null]] : []),
        // What a CLASS identifier brings along is treated as in the full run: the
        // diagnostic skips may skip. Explicitly named tests may not.
        ...(expected.fromClass?.length ? [["of which from a class", `${expected.fromClass.length} — the diagnostic skips apply to them as in the full run`, null]] : []),
      ]);
      if (!hatWarmup) throw new Error(`${WARMUP} is missing from the test bundle — Tests/AAAWarmupUITests.swift not built?`);
    } else {
      log.detail("Dry run: expectation not determined (the run counts Executed against this list).");
    }

    // (7) Warm-up test. Passed means: the test is in `passed` — a skip (fixture dead, no
    // chat) is no keyboard, and an attempt starts only if the remaining deadline carries it.
    log.step("UITests (7/9): warm-up test (software keyboard)");
    const warmup = { attempts: 0, durationS: null, ok: false, reason: null, hardwareKeyboardUpfront: sim.hwKeyboard };
    const warmupStart = Date.now();
    for (;;) {
      const next = warmupNextAttempt({ elapsedMs: Date.now() - warmupStart });
      if (!next.start) {
        throw new Error(`Warm-up test not green after ${warmup.attempts} attempt(s) and ${Math.round(WARMUP_DEADLINE_MS / 60000)} min `
          + `(${warmup.reason}; ${next.reason}) — restart the simulator? Log: ${logPath}`);
      }
      warmup.attempts += 1;
      const attemptStart = new Date();
      const r = await xcodebuildRun(base, [`-only-testing:${WARMUP}`, "test-without-building"], { logPath, timeout: next.timeoutMs });
      if (r.skipped) { warmup.ok = true; break; }
      const u = warmupVerdict(parseTestRun(r.stdout + r.stderr));
      if (u.ok) { warmup.ok = true; break; }
      warmup.reason = u.reason;
      if (!u.ran) throw new Error(`Warm-up test did not run (${u.reason}) — log: ${logPath}`);
      log.warn(`Warm-up test not passed (${u.reason}) — attempt ${warmup.attempts}, again in 10 s`);
      // Hardware keyboard: ask the DEVICE (unified log since the start of this attempt) and the stored
      // preference — not the menu, which without focus reports "missing value" for every item and once
      // said "not connected" three times while the device had a hardware keyboard. If either saw it,
      // Simulator.app is reset ONCE per run (quit, preference "disconnected", open, boot).
      const logR = await probe("xcrun", ["simctl", "spawn", sim.udid, "log", "show", "--start", logShowTime(attemptStart),
        "--style", "compact", "--predicate", HW_KEYBOARD_PREDICATE], { env: xcodeEnv() });
      const inDevice = hwKeyboardInDevice({ output: logR.stdout, code: logR.code });
      const pref = await hwKeyboardPreferenceRead(sim.udid);
      const alreadyNew = !!warmup.hardwareKeyboard?.newlyStarted;
      warmup.hardwareKeyboard = { inDevice, preference: pref.connected ? `connected (${pref.source})` : "separated", newlyStarted: alreadyNew };
      if ((inDevice || pref.connected) && !alreadyNew) {
        log.warn(`Hardware keyboard ${inDevice ? "seen in the device (unified log)" : ""}${inDevice && pref.connected ? ", " : ""}`
          + `${pref.connected ? `connected in the preference (${pref.source})` : ""} — Simulator.app is reset`);
        if (pref.connected) await hwKeyboardDisconnect(sim.udid);
        else await simulatorEnd(sim.udid);
        await simulatorReady();
        warmup.hardwareKeyboard.newlyStarted = true;
      } else if (inDevice || pref.connected) {
        log.warn("Hardware keyboard back despite the Simulator.app restart — the source lies outside the app "
          + "(a tool that sends key events into the device?)");
      } else if (inDevice === null) {
        log.detail(`Device log not readable (exit ${logR.code}) — whether a hardware keyboard was involved is unknown`);
      } else {
        log.detail("No hardware keyboard, neither in the device nor in the preference — simulator probably not warm yet");
      }
      await sleep(10000);
    }
    warmup.durationS = Math.round((Date.now() - warmupStart) / 1000);
    log.ok(`Keyboard there (${warmup.attempts} attempt(s), ${fmtDuration(warmup.durationS)})`);

    // (8) runs
    const runArgs = onlyList.length
      ? expected.args.map((k) => `-only-testing:${k}`)
      : NOT_IN_FULL_RUN.map((k) => `-skip-testing:${k}`);
    for (let i = 1; i <= runsN; i += 1) {
      log.step(`UITests (8/9): run ${i}/${runsN}${onlyList.length ? ` — ${expected.args.join(", ")}` : " — all classes"}`);
      const runStart = Date.now();
      const r = await xcodebuildRun(base, [...runArgs, "test-without-building"], { logPath, timeout: 4 * 3600 * 1000 });
      if (r.skipped) continue;
      const totalDurationS = Math.round((Date.now() - runStart) / 1000);
      const parsed = parseTestRun(r.stdout + r.stderr);
      const verdict = deviationVerdict({ run: parsed, expected: expected.list, only: onlyList, fromClass: expected.fromClass });
      const loadAfter = await loadMeasure(derivedData);
      const json = summary({
        stamp, run: i, runs: runsN, only: onlyList, expected: expected.list, parsed, verdict, totalDurationS,
        loadPrior: { load1: loadPrior.load1, foreign: loadPrior.foreign, waitedS: loadPrior.waitedS, forced: !!loadPrior.forced },
        loadAfter: { load1: loadAfter.load1, foreign: loadAfter.foreign },
        bootAgeS, fixturePid: fixture?.pid ?? null, warmup, logPath, buildS, exitCode: r.code,
        drafts: { deleted: drafts.deleted, remaining: drafts.remaining, reason: drafts.reason },
      });
      const jsonPath = path.join(logDir, `uitests-${stamp}${runsN > 1 ? `-r${i}` : ""}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
      json.jsonPath = jsonPath;
      runsValue.push(json);

      // (9) verdict
      log.step(`UITests (9/9): verdict run ${i}/${runsN}`);
      const skipRow = (k) => (json.skipReasons[k] ? `${k} — ${json.skipReasons[k]}` : k);
      log.table([
        ["Executed / expected", `${json.executed ?? "?"} / ${json.expected}`, verdict.ok || (json.executed === json.expected) ? "ok" : "bad"],
        ["red", json.red.length ? `${json.red.length}: ${json.red.join(", ")}` : "0", json.red.length ? "bad" : "ok"],
        ["skipped", json.skips.length ? `${json.skips.length}${json.skipsDisallowed.length ? ` (${json.skipsDisallowed.length} not allowed)` : " (diagnostic skips only)"}: ${json.skips.map(skipRow).join("; ")}` : "0", json.skipsDisallowed.length ? "bad" : null],
        ["xcodebuild", parsed.succeeded ? "TEST EXECUTE SUCCEEDED" : parsed.failedMarker ? "TEST EXECUTE FAILED" : `no conclusion (exit ${r.code})`, parsed.succeeded ? "ok" : "bad"],
        ...(json.warn ? [["Warning", json.warn, "warn"]] : []),
        ["Duration", fmtDuration(totalDurationS), null],
        ["Load before / after", `${loadPrior.load1?.toFixed(2) ?? "?"} / ${loadAfter.load1?.toFixed(2) ?? "?"}${loadPrior.forced ? " — gate overridden with --force" : ""}`, loadAfter.ok && !loadPrior.forced ? null : "warn"],
        ["Boot age at start", bootAgeS == null ? "unknown" : fmtDuration(bootAgeS), null],
        ["Fixture", fixture ? `pid ${fixture.pid}` : "—", null],
        ["Drafts beforehand", drafts.reason || `${drafts.deleted.length} deleted${drafts.remaining.length ? `, ${drafts.remaining.length} remaining` : ""}`, drafts.remaining.length ? "warn" : null],
        ["xcresult", json.xcresult || "not named", null],
        ["Verdict", verdict.ok ? "green" : verdict.reason, verdict.ok ? "ok" : "bad"],
        ["JSON", jsonPath, null],
      ]);
    }
    allOk = isDryRun() ? true : runsValue.length === runsN && runsValue.every((l) => l.ok);
  } finally {
    // (2) end: the fixture ALWAYS goes with it — also after an error.
    if (fixture) {
      await fixture.end();
      log.detail(`Fixture pid ${fixture.pid} ended`);
    }
  }

  const totalS = Math.round((Date.now() - start) / 1000);
  log.section(isDryRun() ? "UITests: dry run ended" : allOk ? "UITests: green" : "UITests: NOT green");
  log.table([
    ["Runs", isDryRun() ? "(dry)" : `${runsValue.filter((l) => l.ok).length}/${runsN} green`, isDryRun() ? null : allOk ? "ok" : "bad"],
    ...(runsValue.some((l) => l.loadPrior?.forced) ? [["Load gate", "overridden with --force — run under measured foreign load", "warn"]] : []),
    ["Total duration", fmtDuration(totalS), null],
    ["Log", logPath, null],
  ]);
  if (!allOk) process.exitCode = 1;
  return { ok: allOk, runs: runsValue };
}
