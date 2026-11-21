// The command line of the public gate (run.mjs, the root script `check`): the words it knows, the ones it refuses, and the script that
// starts it. The gate itself (rows, verdict, marker) is held by the tests of targets/check.mjs and lib/gate-marker.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./run.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("parseArgs: the four switches, none, and a refusal of anything else", () => {
  assert.deepEqual(parseArgs([]), { quick: false, recheck: false, skipTests: false, short: false });
  assert.equal(parseArgs(["--short"]).short, true);
  assert.throws(() => parseArgs(["--short", "--quick"]), /leave all suites out/);
  assert.throws(() => parseArgs(["--short", "--skip-tests"]), /leave all suites out/);
  assert.equal(parseArgs(["--quick"]).quick, true);
  assert.equal(parseArgs(["--skip-tests"]).skipTests, true);
  assert.equal(parseArgs(["--recheck"]).recheck, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--quik"]), /unknown argument --quik/, "a typo must not start the full gate");
  assert.throws(() => parseArgs(["--recheck", "--quick"]), /forces the suites/);
  assert.throws(() => parseArgs(["--recheck", "--skip-tests"]), /forces the suites/);
});

test("the root script `check` is executable, starts run.mjs and passes its arguments on", () => {
  const file = path.join(REPO, "check");
  assert.ok((fs.statSync(file).mode & 0o111) !== 0, "./check is not executable");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /exec node "\$\(dirname "\$0"\)\/tools\/check\/run\.mjs" "\$@"/);
  const r = spawnSync(file, ["--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--quick/);
  const bad = spawnSync(file, ["--nonsense"], { encoding: "utf8" });
  assert.equal(bad.status, 2, "a wrong call must exit 2 and start nothing");
  assert.equal(spawnSync(file, ["--short", "--quick"], { encoding: "utf8" }).status, 2, "--short with --quick is a wrong call");
});

// `--short` (the CI of every push and PR): the gate leaves out exactly the long suite (lib/gate-plan.mjs shortSelection, held in
// gate-plan.test.mjs), names it in a row, and writes NO marker — a short run must never pass for a full gate with ./deploy.
// COUNTER-TEST: drop `if (short) return;` in targets/check.mjs => red here.
test("check --short: the selection goes through shortSelection, the left-out suite gets a row, no marker after a short run", () => {
  const src = fs.readFileSync(path.join(REPO, "tools/check/targets/check.mjs"), "utf8");
  assert.match(src, /const selection = short \? shortSelection\(built\.suites\)/);
  assert.match(src, /for \(const name of selection\.leftOut\) log\.table/);
  const tail = src.slice(src.indexOf('log.ok("all checks passed")'));
  assert.ok(tail.indexOf("if (short) return;") >= 0 && tail.indexOf("if (short) return;") < tail.indexOf("writeGateMarker("), "a short run writes the gate marker");
});

test("the gate's default plan is the public one, with the public marker scope", async () => {
  const { PUBLIC_PLAN } = await import("./lib/gate-plans.mjs");
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "run.mjs"), "utf8");
  assert.match(src, /plan = PUBLIC_PLAN/);
  assert.equal(PUBLIC_PLAN.markerScope, "public");
});
