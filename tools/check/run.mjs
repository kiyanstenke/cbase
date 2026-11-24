#!/usr/bin/env node
// The public gate as a command: `./check [--quick] [--recheck] [--skip-tests]`.
//
//   (none)         the full gate of the public plan: environment, syntax, import smoke test, the tree guards, line count, guard
//                  register, whitespace, then the suites (Backend, Gateway, Web, Client, Gate tool, Deploy tool, macOS). Takes the better part
//                  of ten minutes — start it in the background.
//   --quick        everything but the suites (a few seconds): what the pre-push hook runs
//   --skip-tests   the same as --quick, named for the case "I know, no suites now"
//   --short        all checks and the short suites, WITHOUT the long backend suite — the CI of every push and PR (a two-core runner
//                  needs an hour for the backend; the nightly CI runs the full gate). Writes no gate marker: it is never a full gate.
//   --recheck      run the suites even when a full gate was green on exactly this working tree within the last hour
//
// A green full gate writes a marker (lib/gate-marker.mjs: one per machine, scope "public"); the same key needs no second proof, so a
// repeated call within the hour runs only the quick checks and says why. Exit code 0 green, 1 red, 2 wrong call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./config-repo.mjs";
import * as log from "./lib/log.mjs";
import { check } from "./targets/check.mjs";
import { PUBLIC_PLAN, planSuiteNames } from "./lib/gate-plans.mjs";
import { gateKey, gateMarkerApplies, markerFile, readGateMarker } from "./lib/gate-marker.mjs";

export function parseArgs(argv) {
  const o = { quick: false, recheck: false, skipTests: false, short: false };
  for (const a of argv) {
    if (a === "--quick") o.quick = true;
    else if (a === "--recheck") o.recheck = true;
    else if (a === "--skip-tests") o.skipTests = true;
    else if (a === "--short") o.short = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`check: unknown argument ${a} — see ./check --help`);
  }
  if (o.recheck && (o.quick || o.skipTests)) throw new Error("check: --recheck forces the suites, --quick/--skip-tests leave them out");
  if (o.short && (o.quick || o.skipTests)) throw new Error("check: --short runs the short suites, --quick/--skip-tests leave all suites out");
  return o;
}

const USAGE = `Usage: ./check [--quick] [--short] [--recheck] [--skip-tests]
  (none)        the full public gate (suites included; run it in the background)
  --quick       checks without the test suites
  --skip-tests  same as --quick
  --short       checks and short suites, without the long backend suite (CI on push/PR; no gate marker)
  --recheck     run the suites even if this exact tree was green within the hour`;

export async function main(argv = process.argv.slice(2), plan = PUBLIC_PLAN) {
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return 0; }
  const logPath = log.openLog(path.join(REPO, ".deploy-logs"), `${Date.now()}-check`);
  let quick = o.quick || o.skipTests;
  let quickReason = o.skipTests ? "--skip-tests" : "--quick";
  if (!quick && !o.recheck && !o.short) {
    // The marker of the plan the gate would run (scope and suites).
    const m = gateMarkerApplies(readGateMarker(markerFile(plan.markerScope)), await gateKey(), { scope: plan.markerScope, suites: planSuiteNames(plan) });
    if (m.applies) { quick = true; quickReason = m.reason; }
  }
  await check({ quick, quickReason, plan, short: o.short && !quick });
  console.log(`\n${log.dim(`Log: ${logPath}`)}`);
  return 0;
}

function isMainModule() {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] || "")) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(async (code) => { await log.closeLog(); process.exit(code); }, async (e) => {
    log.fail(e.message);
    await log.closeLog();
    process.exit(/unknown argument|forces the suites|leave all suites out/.test(e.message) ? 2 : 1);
  });
}
