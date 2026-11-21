#!/usr/bin/env node
// The public gate as a command: `./check [--quick] [--recheck] [--skip-tests]`.
//
//   (none)         the full gate of the public plan: environment, syntax, import smoke test, the tree guards, line count, guard
//                  register, whitespace, then the suites (Backend, Gateway, Web, Client, Gate tool, Deploy tool, macOS). Takes the better part
//                  of ten minutes — start it in the background.
//   --quick        everything but the suites (a few seconds): what the pre-push hook runs
//   --skip-tests   the same as --quick, named for the case "I know, no suites now"
//   --recheck      run the suites even when a full gate was green on exactly this working tree within the last hour
//
// A green full gate writes a marker (.deploy-logs/gate-ok.json, scope "public"); the same bytes need no second proof, so a repeated
// call within the hour runs only the quick checks and says why. Exit code 0 green, 1 red, 2 wrong call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./config-repo.mjs";
import * as log from "./lib/log.mjs";
import { check } from "./targets/check.mjs";
import { PUBLIC_PLAN, planSuiteNames } from "./lib/gate-plans.mjs";
import { gateMarkerApplies, markerFile, readGateMarker, workingTreeHash } from "./lib/gate-marker.mjs";

export function parseArgs(argv) {
  const o = { quick: false, recheck: false, skipTests: false };
  for (const a of argv) {
    if (a === "--quick") o.quick = true;
    else if (a === "--recheck") o.recheck = true;
    else if (a === "--skip-tests") o.skipTests = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`check: unknown argument ${a} — see ./check --help`);
  }
  if (o.recheck && (o.quick || o.skipTests)) throw new Error("check: --recheck forces the suites, --quick/--skip-tests leave them out");
  return o;
}

const USAGE = `Usage: ./check [--quick] [--recheck] [--skip-tests]
  (none)        the full public gate (suites included; run it in the background)
  --quick       checks without the test suites
  --skip-tests  same as --quick
  --recheck     run the suites even if this exact tree was green within the hour`;

export async function main(argv = process.argv.slice(2), plan = PUBLIC_PLAN) {
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return 0; }
  const logPath = log.openLog(path.join(REPO, ".deploy-logs"), `${Date.now()}-check`);
  let quick = o.quick || o.skipTests;
  let quickReason = o.skipTests ? "--skip-tests" : "--quick";
  if (!quick && !o.recheck) {
    // The marker of the plan the gate would run (scope and suites).
    const m = gateMarkerApplies(readGateMarker(markerFile(plan.markerScope)), await workingTreeHash(), { scope: plan.markerScope, suites: planSuiteNames(plan) });
    if (m.applies) { quick = true; quickReason = m.reason; }
  }
  await check({ quick, quickReason, plan });
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
    process.exit(/unknown argument|forces the suites/.test(e.message) ? 2 : 1);
  });
}
