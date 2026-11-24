#!/usr/bin/env node
// One deploy path for all applications (web, server, client, iOS).
//
//   tools/deploy status                  measure only: what runs where, what deviates
//   tools/deploy check                   checks (syntax, tests, whitespace)
//   tools/deploy web                     web UI to the server (uninterrupted)
//   tools/deploy server                  backend image + container swap
//   tools/deploy client                  client app
//   tools/deploy all                     web → server → client
//   tools/deploy mobile --device         iOS to the connected iPhone
//   tools/deploy mobile --testflight     iOS to App Store Connect
//   tools/deploy mobile --tests          XCUITests in the simulator (fixture, load gate, warm-up test,
//                                        Executed against expectation); --only <id>, --runs N
//   tools/deploy rollback server         to the release that was active before (else --to)
//   tools/deploy init                    first installation on the host: root folders + systemd user unit (not started)
//
// The order is wired in, however the targets appear on the command line: first the uninterrupted part (web-out),
// then the container, then the client. The client comes last because its `/gw/env/ensure` at start lets an unhealthy
// container be replaced — which costs the inner services a second time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, assertOwnInstallation, config, newReleaseId, requireSsh } from "./config.mjs";
import * as log from "../check/lib/log.mjs";
import { setDryRun, isDryRun } from "../check/lib/sh.mjs";
import { setAssumeYes, Aborted } from "./lib/prompt.mjs";
import { assertMainBranch, commitAndPush } from "./lib/git-rollout.mjs";
import { check } from "../check/targets/check.mjs";
import { gateKey, gateMarkerApplies, readGateMarker, markerFile } from "../check/lib/gate-marker.mjs";
import { PUBLIC_PLAN, planSuiteNames } from "../check/lib/gate-plans.mjs";
import { importPrivate, needsPrivatePart } from "./lib/private-part.mjs";
import { buildWeb, deployWebOut } from "./targets/web.mjs";
import { deployServer, deployGateway } from "./targets/server.mjs";
import { clientShellChanged, deployClient } from "./targets/client.mjs";
import { deployMobile, runMobileTests } from "./targets/mobile.mjs";
import { status } from "./targets/status.mjs";
import { rollback } from "./targets/rollback.mjs";
import { mobileDefaults, applyMobileArg, finishMobileArgs, mobileOnlyNeedsTests } from "../check/lib/mobile-args.mjs";
import { CRON_WINDOW_TOGGLE, checkCronWindow, cronWindowTargets } from "./lib/cronWindow.mjs";
import { assertRolloutCheckout, isRolloutRun } from "./lib/rollout-checkout.mjs";
import { init } from "./targets/init.mjs";
import { buildStamp, describeBuild, dirtyWarning, writeStampFile } from "./lib/build-stamp.mjs";

// The gate plan: the merged plan of the private part (public suites + the private ones, both
// registers, the manifest step, the ops marker scope) where the tree carries it, else the public plan — the same one `./check` runs.
const opsGate = await importPrivate("lib/ops-gate.mjs");
export const DEFAULT_PLAN = opsGate ? opsGate.DEFAULT_PLAN : PUBLIC_PLAN;

const ORDER = ["web", "server", "client", "mobile"];
const ALL = ["web", "server", "client"]; // not mobile on purpose: an Apple upload or a cabled iPhone
                                                       // does not belong in a collective command.

function usage() {
  console.log(`cbase Deploy

  tools/deploy <targets…> [options]

Targets
  status                Measure without changing (deviations, runs, inner containers)
  check                 Checks: node --check, tests, git diff --check
  web                   Build the web UI and put it on the server (no restart, no downtime)
  server                Release + backend image + container swap + inner containers
  client                Client shell (only if changed) + restart
  mobile                iOS — choose a mode: --device (default) | --testflight | --ipa
                        or --tests: XCUITests in the simulator (see DEPLOY.md "mobile --tests")
  all                   web, server, client (without mobile)
  rollback <what>       server | client   (--to <release|backup>; server without --to: the release active before)
  init                  First installation on the host: root folders and the systemd user unit from the template
                        (not started); refuses an existing root/unit unless --force. Rollout commands (server, web,
                        client, rollback, all, init) run only from a rollout checkout (see the head of the file deploy).
  baseline [<version>]   pull the workflow tool's reference from the Claude binary (default: the pin in the
                        image), print the difference to the last state, write the state
                        (-n: print only; only in the maintainer's tree)
  baseline --diff <a> <b>  compare two checked-in reference states

Options
  -c, --commit          after a successful deploy commit EVERYTHING and push
  -m, --message <text>  subject line for that commit
  -n, --dry-run         only show what would run; measurements still run
  -y, --yes             no questions (for unattended runs)
      --force           bypass gates (running work is lost)
      --wait [s]        wait for idle before destructive steps (default 300)
      --skip-tests      skip the checks
      --quick           checks without the test suites
      --recheck         run the test suites even if a full gate was already green on the same
                        working tree within an hour (gate marker)
      --gateway         roll out the gateway code too (restart: SSE connections break)
      --settle <s>      post-observation after the container swap (default 150, 0 = off)
      --cron-window-ignore
                        "server"/"all"/"rollback server": bypass the cleanup-cron guard (remote.cleanupCronUtcHour: a daily
                        docker cleanup on the host removes unused images and stopped containers; a build or switch that would span it —
                        assumed 45 min — aborts). --yes and --force do not bypass it.
      --release <id>    set the release id
      --to <id>         target for rollback
      --rollback-without-relocation
                        only "rollback server": the rollback lock bypasses ONLY unknown relocation counts
                        (B stopped, unreachable, backend without the field) — you assert that
                        no project is switched over there and no relocation is running
      --rollback-without-copy
                        only "rollback server": likewise ONLY an unknown copy count (the
                        database in the volume was unreadable too) — you assert that no copy
                        lives there. A known count (switched over, relocation in progress, copies) is bypassed by no
                        switch; --force never bypasses the lock.
      --rollback-without-episodes
                        only "rollback server": likewise ONLY an unknown count of source ids with
                        episodes in two workspaces (target without "episodes-per-workspace")
                        — you assert that no source id lies in two workspaces there. A
                        known count is not bypassed either.
      --rollback-without-lfs
                        only "rollback server": bypasses ONLY the fourth axis (target without "lfs": its projectbox
                        has no git-lfs) — there is no count there; you assert that no repo
                        of a project container carries git-lfs hooks or the target already has git-lfs.
                        --force never bypasses this lock.
      --rollback-without-layout
                        only "rollback server": likewise ONLY an unknown count of outlines under rebuild (target without
                        "layout") — you assert that no outline is under rebuild
                        there. A known count is not bypassed either.
      --rollback-without-instance-stopped
                        only "rollback server": likewise ONLY an unknown count of stopped instances (target without
                        "instance-stopped") — you assert that no instance is stopped
                        there and none is being stopped right now. A known count is not bypassed either (start first).
      --rollback-without-bridge-cbp
                        only "rollback server": likewise ONLY an unknown count of converted projects at the bridge axis
                        (target without "bridge-cbp": its entry.sh guards only the old bridge prefix) — you assert that
                        no project is converted there. A known count is not bypassed either (repair forward).

mobile --tests
      --only <id>       only this test (CbaseMobileUITests/<class>/<test>; repeatable,
                        duplicates count once; CbaseMobileUITests/<class> = all tests of the class)
      --runs <n>        run n times in a row (for the 5x proofs)
      --wait <s>        load gate: wait this long for load < 3 and idle (default 600, also without a number)
      --force           after --wait expires BYPASS the load gate instead of aborting; the measured
                        foreign load then appears in the table and as loadPrior.forced in the JSON
                        (a foreign next-dev server would otherwise block forever — it is dropped
                        without a CPU threshold)
  Exit 1 if "Executed N tests" deviates from the expectation of -enumerate-tests — also with
  "TEST EXECUTE SUCCEEDED" (an old id path silently runs 0 tests) —, on every red
  test and on every skipped one except the five diagnostic skips (with --only: on every skip).
  Logs: .deploy-logs/uitests-<stamp>.log (full xcodebuild output) and .json (numbers,
  red list, skips with reason, xcresult path).

Work always happens on main — from another branch the tool refuses service
(--force bypasses that, --commit does not). --commit takes the WHOLE working tree,
foreign changes included; what should not go along belongs in .gitignore.
`);
}

export function parseArgs(argv) {
  const o = {
    targets: [],
    dryRun: false,
    yes: false,
    force: false,
    ...mobileDefaults(), // wait, mobileTests, only, runs
    skipTests: false,
    quick: false,
    recheck: false,
    gateway: false,
    settle: 150,
    release: null,
    to: null,
    rollbackWithoutRelocation: false,
    rollbackWithoutCopy: false,
    rollbackWithoutEpisodes: false, // only the episode count per workspace
    rollbackWithoutLfs: false, // only the fourth axis (git-lfs in the projectbox)
    rollbackWithoutLayout: false, // only the count of outlines under rebuild (fifth axis)
    rollbackWithoutInstanceStopped: false, // only the count of stopped instances (sixth axis)
    rollbackWithoutBridge: false, // only the count of converted projects at the bridge axis (eighth axis)
    ignoreCronWindow: false, // bypass the cleanup-cron guard — only this switch
    commit: false,
    message: null,
    mobileMode: "device",
    command: null,
    rollbackWhat: null,
    baselineVersion: null,
    baselineDiff: null,
  };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case "-h": case "--help": usage(); process.exit(0); break;
      case "-n": case "--dry-run": o.dryRun = true; break;
      case "-y": case "--yes": o.yes = true; break;
      case "-c": case "--commit": o.commit = true; break;
      case "-m": case "--message": o.message = args.shift(); break;
      case "--force": o.force = true; break;
      case "--skip-tests": o.skipTests = true; break;
      case "--quick": o.quick = true; break;
      case "--recheck": o.recheck = true; break;
      case "--gateway": o.gateway = true; break;
      case "--device": o.mobileMode = "device"; break;
      case "--testflight": o.mobileMode = "testflight"; break;
      case "--ipa": o.mobileMode = "ipa"; break;
      case "--settle": o.settle = +(args.shift() || 0); break;
      case "--release": o.release = args.shift(); break;
      case "--to": o.to = args.shift(); break;
      case "--rollback-without-relocation": o.rollbackWithoutRelocation = true; break;
      case "--rollback-without-copy": o.rollbackWithoutCopy = true; break; // only the copy count
      case "--rollback-without-episodes": o.rollbackWithoutEpisodes = true; break; // only the episode count
      case "--rollback-without-lfs": o.rollbackWithoutLfs = true; break; // only the fourth axis
      case "--rollback-without-layout": o.rollbackWithoutLayout = true; break; // only the count of outlines under rebuild
      case "--rollback-without-instance-stopped": o.rollbackWithoutInstanceStopped = true; break;
      case "--rollback-without-bridge-cbp": o.rollbackWithoutBridge = true; break; // only the bridge axis
      case CRON_WINDOW_TOGGLE: o.ignoreCronWindow = true; break;
      case "status": case "check": case "init": o.command = a; break;
      case "rollback": o.command = "rollback"; o.rollbackWhat = args.shift(); break;
      case "baseline": o.command = "baseline"; break;
      case "--diff": o.baselineDiff = [args.shift(), args.shift()]; break;
      case "all": o.targets.push(...ALL); break;
      default:
        if (ORDER.includes(a)) o.targets.push(a);
        else if (o.command === "baseline" && /^\d+\.\d+\.\d+$/.test(a)) o.baselineVersion = a;
        else if (applyMobileArg(o, a, args)) { /* --tests, --only, --runs, --wait */ }
        else if (a.startsWith("--settle=")) o.settle = +a.split("=")[1];
        else if (a.startsWith("--release=")) o.release = a.split("=")[1];
        else if (a.startsWith("--to=")) o.to = a.split("=")[1];
        else if (a.startsWith("--message=")) o.message = a.slice("--message=".length);
        else throw new Error(`Unknown argument: ${a}`);
    }
  }
  o.targets = ORDER.filter((t) => o.targets.includes(t)); // canonical order, deduplicated
  finishMobileArgs(o); // the default of --wait and the rules that bind --tests/--only/--runs to `mobile`
  if (o.baselineDiff && (o.command !== "baseline" || o.baselineDiff.some((v) => !/^\d+\.\d+\.\d+$/.test(v || "")))) throw new Error("--diff belongs to `baseline` and needs two versions (`deploy baseline --diff 2.1.280 2.1.282`).");
  mobileOnlyNeedsTests(o);
  // The switch belongs to `rollback server` alone — on another command it would silently do nothing.
  for (const [an, name] of [[o.rollbackWithoutRelocation, "--rollback-without-relocation"], [o.rollbackWithoutCopy, "--rollback-without-copy"], [o.rollbackWithoutEpisodes, "--rollback-without-episodes"], [o.rollbackWithoutLfs, "--rollback-without-lfs"], [o.rollbackWithoutLayout, "--rollback-without-layout"], [o.rollbackWithoutInstanceStopped, "--rollback-without-instance-stopped"], [o.rollbackWithoutBridge, "--rollback-without-bridge-cbp"]]) {
    if (an && !(o.command === "rollback" && o.rollbackWhat === "server")) throw new Error(`${name} belongs to \`rollback server\` only.`);
  }
  // On another command the switch would silently do nothing: it applies where the guard is checked (cronWindowTargets).
  if (o.ignoreCronWindow && !cronWindowTargets(o)) throw new Error(`${CRON_WINDOW_TOGGLE} belongs to "server", "all" and "rollback server" only.`);
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.command && !o.targets.length) {
    usage();
    process.exit(1);
  }

  const release = o.release || newReleaseId();
  setDryRun(o.dryRun);
  setAssumeYes(o.yes);

  const name = `${release}-${o.command || o.targets.join("+")}`;
  const logPath = log.openLog(path.join(REPO, ".deploy-logs"), name);

  if (o.command === "status") {
    await status();
    console.log(`\n${log.dim(`Log: ${logPath}`)}`);
    return;
  }
  if (o.command === "baseline") {
    // Private: it pulls the reference out of the Claude Code binary and writes it into the private part of the tree.
    const target = await importPrivate("targets/baseline.mjs");
    if (!target) throw new Error(needsPrivatePart("`deploy baseline`", "targets/baseline.mjs"));
    await target.baseline({ version: o.baselineVersion, diff: o.baselineDiff });
    return;
  }
  if (o.command === "check") {
    await check({ quick: o.quick, plan: DEFAULT_PLAN });
    return;
  }
  // Rollout commands: only from a rollout checkout (second half of the lock in the root script) and never against the old
  // installation (root, port, container prefix, images).
  if (isRolloutRun(o)) {
    assertRolloutCheckout(REPO);
    await assertOwnInstallation();
  }
  if (o.command === "init") {
    requireSsh();
    await init({ force: o.force, release });
    console.log(`\n${log.dim(`Log: ${logPath}`)}`);
    return;
  }
  if (o.command === "rollback") {
    if (["server"].includes(o.rollbackWhat)) requireSsh();
    const cron = checkCronWindow({ relevant: cronWindowTargets(o), hour: config.remote.cleanupCronUtcHour, ignore: o.ignoreCronWindow, dry: isDryRun() });
    if (cron) log.table([cron]);
    await rollback(o.rollbackWhat, { to: o.to, force: o.force, withoutRelocation: o.rollbackWithoutRelocation, withoutCopy: o.rollbackWithoutCopy, withoutEpisodes: o.rollbackWithoutEpisodes, withoutLfs: o.rollbackWithoutLfs, withoutLayout: o.rollbackWithoutLayout, withoutInstanceStopped: o.rollbackWithoutInstanceStopped, withoutBridge: o.rollbackWithoutBridge });
    return;
  }
  // `mobile --tests` rolls nothing out: no branch rule (bisect worktrees may measure), no `check` (the backend
  // suite on 14 cores and the simulator do not get along), no "rolled out" table. runMobileTests sets the exit code;
  // main simply ends here.
  if (o.mobileTests) {
    log.section(`cbase UITests — ${release}`);
    log.table([
      ["Mode", isDryRun() ? "DRY RUN (measurements run, commands are only shown)" : "real", isDryRun() ? "warn" : null],
      ["Log", logPath, null],
    ]);
    await runMobileTests({ only: o.only, runs: o.runs, wait: o.wait, stamp: release, force: o.force });
    console.log(`\n${log.dim(`Log: ${logPath}`)}`);
    return;
  }

  if (o.targets.some((t) => t === "web" || t === "server")) requireSsh();

  // The branch rule applies BEFORE the first step: nothing is built from a wrong branch. With --commit it is not negotiable.
  const branch = await assertMainBranch({ force: o.force, strict: o.commit });

  // The build stamp (lib/build-stamp.mjs): computed ONCE per run, the same build.json for web-out and the release (never the image).
  let stamp = null;
  if (o.targets.some((t) => t === "web" || t === "server")) {
    const described = await describeBuild();
    stamp = buildStamp(described.describe, { release });
    stamp.file = writeStampFile(stamp);
    if (described.warning) log.warn(described.warning);
    const dirty = dirtyWarning(stamp);
    if (dirty) log.warn(dirty);
  }

  log.section(`cbase Deploy — Release ${release}`);
  log.table([
    ["Targets", o.targets.join(" → "), null],
    ["Branch", branch, branch === "main" ? "ok" : "warn"],
    ...(stamp ? [["Build", stamp.build, /unknown$/.test(stamp.build) || stamp.dirty ? "warn" : "ok"]] : []),
    ["Mode", isDryRun() ? "DRY RUN (nothing is changed)" : o.yes ? "without questions" : "with questions", isDryRun() ? "warn" : null],
    ...(o.commit ? [["after the deploy", "commit everything and push", null]] : []),
    ...(o.force ? [["--force", "gates are bypassed", "warn"]] : []),
    ...(o.targets.includes("mobile") ? [["iOS-Mode", o.mobileMode, null]] : []),
    ["Log", logPath, null],
  ]);

  // The cleanup-cron guard: no image build or container switch across a configured daily docker cleanup of the host — BEFORE the
  // gate, so a forbidden start costs nothing; bypass only with its own switch (lib/cronWindow.mjs).
  const cron = checkCronWindow({ relevant: cronWindowTargets(o), hour: config.remote.cleanupCronUtcHour, ignore: o.ignoreCronWindow, dry: isDryRun() });
  if (cron) log.table([cron]);

  // The expensive gate belongs BEHIND the cheap decision. A client with an unchanged shell ships no code, it only
  // restarts — the test suites then check nothing that is rolled out. Syntax and whitespace checks still run.
  const relevant = o.targets.filter((t) => t !== "mobile");
  const suppliesCode = relevant.some((t) => (t === "client" ? clientShellChanged() : true));
  if (!o.skipTests && relevant.length) {
    // The same bytes need no second proof: if a full gate was green on exactly this working tree within an hour
    // (gate marker from `./deploy check` or an earlier deploy), only the quick checks run. The reason goes to the
    // log; `--recheck` forces the suites.
    let marker = { applies: false, reason: "" };
    if (!o.quick && !o.recheck && suppliesCode) {
      // The marker of the plan the gate would run (scope and suites): a smaller plan's marker does not skip a larger one.
      marker = gateMarkerApplies(readGateMarker(markerFile(DEFAULT_PLAN.markerScope)), await gateKey(), {
        scope: DEFAULT_PLAN.markerScope, suites: planSuiteNames(DEFAULT_PLAN),
      });
    }
    await check({
      plan: DEFAULT_PLAN,
      quick: o.quick || !suppliesCode || marker.applies,
      quickReason: o.quick ? "--quick" : !suppliesCode ? "nothing to ship, restart only" : marker.reason,
    });
    if (!o.quick && !marker.applies && suppliesCode && marker.reason) log.detail(`Gate marker: ${marker.reason} — suites run.`);
  }

  // Post-observations may keep running in the background (the server settle, 150 s) while another target runs
  // after it (the client). Every one is awaited before "Done" — what turns red there is red, just without 150 s of
  // idle before it. Also when a later target fails (`runTargets`).
  const done = await runTargets(o.targets, async (t, { laterTargets, afterRun }) => {
    if (t === "web") {
      await buildWeb();
      await deployWebOut({ release, stamp });
    } else if (t === "server") {
      const r = await deployServer({ release, stamp, force: o.force, wait: o.wait, settleSeconds: o.settle, settleBackground: laterTargets.length > 0 });
      if (r?.postObservation) afterRun(r.postObservation, "server post-observation");
      if (o.gateway) await deployGateway({ force: o.force });
    } else if (t === "client") {
      await deployClient({ release, force: o.force });
    } else if (t === "mobile") {
      await deployMobile({ mode: o.mobileMode, force: o.force });
    }
  });

  // Only after the last successful target — what is not rolled out is not pushed either. If something fails before,
  // the working tree stays untouched.
  if (o.commit) await commitAndPush({ release, targets: done, message: o.message });

  log.section(isDryRun() ? "Dry run finished" : "Done");
  log.table([
    ["Release", release, null],
    ...(stamp ? [["Build", stamp.build, null]] : []),
    ["rolled out", done.join(", "), "ok"],
    ["Log", logPath, null],
  ]);
  log.section("Duration per step");
  log.table(log.durationTable());
  if (!isDryRun() && done.some((t) => ["server", "client"].includes(t))) {
    console.log(
      `\n  ${log.dim("Rollback:")} ${done
        .filter((t) => ["server", "client"].includes(t))
        .map((t) => `tools/deploy rollback ${t}`)
        .join("  |  ")}`,
    );
    console.log(`  ${log.dim("Check again in a few minutes:")} tools/deploy status`);
  }
}

// The targets one after another, the post-observations alongside. `runTarget(t, { done, laterTargets, afterRun })`
// runs ONE target; `afterRun(promise, what)` registers a post-observation that keeps running in the background (the
// server settle, 150 s, while another target runs after it). A bare promise in an array would be lost silently on two
// paths: a later target failing (main ended with `process.exit`, the running observation died wordlessly), or the
// observation itself turning red WHILE a later target still built (an unhandledRejection ending the process at once,
// say in the middle of an app-bundle swap). So the handler hangs on at registration and every one is awaited — also
// after an error; its result then stands at the error. Thrown afterwards: first a target's error, else an
// observation's. Returns the targets that ran. Guard: tools/deploy/deploy-targets.test.mjs.
export async function runTargets(targets, runTarget) {
  const done = [];
  const afterRuns = [];
  const afterRun = (p, what = "post-observation") => {
    const h = { what, error: null, red: false };
    h.finished = Promise.resolve(p).then(() => {}, (e) => { h.red = true; h.error = e; });
    afterRuns.push(h);
  };
  let error = null;
  let failed = false;
  try {
    for (const t of targets) {
      const laterTargets = targets.slice(targets.indexOf(t) + 1).filter((z) => z !== "mobile");
      await runTarget(t, { done, laterTargets, afterRun });
      done.push(t);
    }
  } catch (e) {
    failed = true;
    error = e;
  }
  if (afterRuns.length) {
    log.step(failed ? "Awaiting post-observation (a target failed — its result belongs to the error)" : "Awaiting post-observation");
    await Promise.all(afterRuns.map((h) => h.finished));
  }
  const red = afterRuns.filter((h) => h.red);
  const set = red.map((h) => `${h.what}: ${h.error?.message ?? h.error}`).join("; ");
  if (failed) {
    if (afterRuns.length && error instanceof Error) {
      error.message += red.length ? ` — plus RED ${set}` : ` — ${afterRuns.map((h) => h.what).join(", ")}: ran to the end, green`;
    }
    throw error;
  }
  if (red.length) {
    const e = red[0].error instanceof Error ? red[0].error : new Error(String(red[0].error));
    if (red.length > 1) e.message = set;
    throw e;
  }
  return done;
}

// Run only as the main module — `import { parseArgs }` from a test must not start a deploy. Both sides via realpath, so
// a symlink in the path (./deploy execs the real path) does not silently produce a second behavior.
function isMainModule() {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] || "")) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// The reason for an abort belongs in the LOG, not only on the console: the log stream is an asynchronous
// `createWriteStream`, and `process.exit` does not wait for its backlog — an abort would carry no FAIL line, and an
// early abort left no file at all. So await `closeLog()` first, then end. The exit code stays as it was (Aborted 2,
// else 1): a `process.exitCode` + return would hang on every handle a target leaves open on failure.
if (isMainModule()) main().catch(async (e) => {
  const where = log.logFile() ? `\n  ${log.dim(`Log: ${log.logFile()}`)}` : "";
  const aborted = e instanceof Aborted;
  if (aborted) log.warn(e.message);
  else log.fail(e.message);
  if (!aborted && process.env.CBASE_DEPLOY_DEBUG) console.error(e);
  console.log(where);
  await log.closeLog();
  process.exit(aborted ? 2 : 1);
});
