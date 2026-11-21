// Private half of the mobile UI test guards: everything that starts deploy.mjs itself, and the binding between its `parseArgs` and the
// leaf lib/mobile-args.mjs the public half drives.
//
// Run:  node --test --test-reporter=tap tools/deploy/uitests.ops.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./deploy.mjs";
import { parseMobileArgs } from "../check/lib/mobile-args.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("deploy.mjs parseArgs and lib/mobile-args.mjs parseMobileArgs agree on the mobile words", () => {
  for (const argv of [
    ["mobile", "--tests"],
    ["mobile", "--tests", "--wait"],
    ["mobile", "--tests", "--wait", "1200"],
    ["mobile", "--tests", "--wait=900"],
    ["mobile", "--tests", "--force", "--only", "CbaseMobileUITests/ShellUITests/testX", "--runs", "3"],
    ["mobile", "--tests", "--only=CbaseMobileUITests/ChatStageUITests"],
    ["web", "--wait"],
    ["server", "--wait", "120"],
  ]) {
    const a = parseArgs(argv);
    const b = parseMobileArgs(argv);
    for (const k of ["wait", "mobileTests", "only", "runs", "force", "targets"]) assert.deepEqual(a[k], b[k], `${argv.join(" ")}: ${k}`);
  }
  for (const argv of [["web", "--tests"], ["mobile", "--tests", "--runs", "0"], ["mobile", "--only", "x"], ["mobile", "--tests", "--only", " "]]) {
    assert.throws(() => parseArgs(argv), (e) => { assert.throws(() => parseMobileArgs(argv), (f) => f.message === e.message); return true; }, argv.join(" "));
  }
});

test("deploy.mjs: --tests/--only/--runs without `mobile` ⇒ exit 1 with a hint; --runs 0 ⇒ exit 1", () => {
  const deploy = path.join(HERE, "deploy.mjs");
  const run = (args) => spawnSync(process.execPath, [deploy, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const a = run(["web", "--tests", "--dry-run"]);
  assert.equal(a.status, 1);
  assert.match(a.stdout + a.stderr, /belong to `mobile` alone/);
  const b = run(["mobile", "--tests", "--runs", "0", "--dry-run"]);
  assert.equal(b.status, 1);
  assert.match(b.stdout + b.stderr, /--runs needs/);
  const c = run(["mobile", "--only", "ShellUITests/testX", "--dry-run"]);
  assert.equal(c.status, 1);
  assert.match(c.stdout + c.stderr, /only together with --tests/);
});

// The abort reason stood only on the console: `main().catch` calls `log.fail(…)` and immediately `process.exit(1)`, and the log stream is an
// asynchronous `createWriteStream` — the backlog is lost with the process. Measured on both REAL aborts: 0 FAIL lines, one ends in the middle
// of the lsof output; with a heavy backlog the file is missing entirely.
test("deploy.mjs: an abort writes its reason into the log file, not only onto the console", () => {
  const deploy = path.join(HERE, "deploy.mjs");
  const stamp = `n0c-abort-${process.pid}`;
  const logPath = path.join(HERE, "..", "..", ".deploy-logs", `${stamp}-mobile.log`);
  try {
    const r = spawnSync(process.execPath, [deploy, "mobile", "--tests", "--dry-run", "--release", stamp], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, NO_COLOR: "1", CBASE_XCODE_APP: "/not/existing/Xcode.app" },
    });
    assert.equal(r.status, 1, "an abort is exit 1");
    assert.match(r.stdout + r.stderr, /Xcode not found/);
    assert.ok(fs.existsSync(logPath), `the log file is missing: ${logPath}`);
    const text = fs.readFileSync(logPath, "utf8");
    assert.match(text, /FAIL .*Xcode not found/, "the reason for the abort belongs in the log");
  } finally {
    fs.rmSync(logPath, { force: true });
  }
});
