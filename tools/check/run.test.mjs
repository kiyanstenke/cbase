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

test("parseArgs: the three switches, none, and a refusal of anything else", () => {
  assert.deepEqual(parseArgs([]), { quick: false, recheck: false, skipTests: false });
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
});

test("the gate's default plan is the public one, with the public marker scope", async () => {
  const { PUBLIC_PLAN } = await import("./lib/gate-plans.mjs");
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "run.mjs"), "utf8");
  assert.match(src, /plan = PUBLIC_PLAN/);
  assert.equal(PUBLIC_PLAN.markerScope, "public");
});
