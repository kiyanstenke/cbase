// The cleanup-cron guard against a host's nightly docker-cleanup cron (remote.cleanupCronUtcHour; 4 in these tests) — lib/cronWindow.mjs and its wiring in deploy.mjs.
//
// GUARANTEES:
//   (1) cronWindowVerdict at fixed instants: a run (assumed 45 min) across 04:00 UTC locks, the edges lie where they should (borders
//       count), also on a night the clocks change (the guard is UTC, independent of local time). The text
//       names the duration as an assumption.
//   (5) checkCronWindow: an image build or switch (`server`, `all`, `rollback server`) that would span 04:00 UTC throws with the override
//       switch in the sentence; the switch `--cron-window-ignore` turns it into a warning, the dry run into a red row; --yes and --force do
//       not override it. COUNTER-PROOF: a clear start passes; a run that does not build or switch (web, client, status, rollback client) is
//       not checked. deploy.mjs checks after the branch rule, BEFORE the gate and the targets, and before the rollback.
//
// Run:  node --test --test-reporter=tap tools/deploy/cronWindow.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CRON_WINDOW_TOGGLE, DEPLOY_DURATION_ASSUMPTION_MIN, checkCronWindow, cronWindowTargets, cronWindowVerdict } from "./lib/cronWindow.mjs";
import { parseArgs } from "./deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const t = (iso) => Date.parse(iso);

test("(1) cronWindowVerdict: across 04:00 UTC at fixed instants, also on a night the clocks change", () => {
  assert.equal(DEPLOY_DURATION_ASSUMPTION_MIN, 45);
  const cases = [
    // [start (UTC), locked, reason pattern]
    ["2026-10-22T03:20:00Z", true, /span 04:00 UTC \(start 03:20Z, end about 04:05Z; assumed duration 45 min — an assumption/],
    ["2026-10-22T03:14:00Z", false], // end 03:59Z
    ["2026-10-22T04:00:00Z", true, /04:00 UTC/], // the edge counts
    ["2026-10-22T04:01:00Z", false],
    ["2026-10-25T03:30:00Z", true, /04:00 UTC/], // on the night of the change
    ["2026-10-25T01:30:00Z", false], // shortly after the change
    ["2026-10-21T10:00:00Z", false], // noon
    ["2026-10-21T19:31:00Z", false], // the evening is free
  ];
  for (const [iso, locked, pattern] of cases) {
    const v = cronWindowVerdict(t(iso));
    assert.equal(v.locked, locked, `${iso}: ${v.reason}`);
    if (pattern) assert.match(v.reason, pattern, iso);
  }
  // A different duration moves the limit (the assumption is a parameter, not a hidden number).
  assert.equal(cronWindowVerdict(t("2026-10-22T03:00:00Z"), { durationMin: 60 }).locked, true);
  assert.equal(cronWindowVerdict(t("2026-10-22T03:00:00Z"), { durationMin: 30 }).locked, false);
});

test("(5) 04:00 UTC guard: a build or switch spanning the cleanup cron is refused, a clear one passes, the switch and the dry run soften it", () => {
  // Start 03:30Z + 45 min = 04:15Z: across the cron. Start 04:01Z: the cron has passed. Start 03:15Z ends 04:00Z exactly: borders count.
  assert.equal(cronWindowVerdict(t("2026-11-16T03:30:00Z")).locked, true);
  assert.equal(cronWindowVerdict(t("2026-11-16T03:15:00Z")).locked, true, "the end on 04:00Z is inside");
  assert.equal(cronWindowVerdict(t("2026-11-16T03:14:00Z")).locked, false);
  assert.equal(cronWindowVerdict(t("2026-11-16T04:01:00Z")).locked, false);
  assert.equal(cronWindowVerdict(t("2026-11-16T12:00:00Z")).locked, false);
  assert.equal(cronWindowVerdict(t("2026-11-16T23:30:00Z")).locked, false, "ends 00:15Z, the next cron is still hours away");
  assert.equal(cronWindowVerdict(t("2026-11-16T23:30:00Z"), { durationMin: 5 * 60 }).locked, true, "a long run across midnight reaches the cron of the next day");
  assert.match(cronWindowVerdict(t("2026-11-16T03:30:00Z")).reason, /04:00 UTC.*assumption, not a measurement.*docker-cleanup/s);
  const inside = () => t("2026-11-16T03:30:00Z");
  assert.throws(() => checkCronWindow({ hour: 4, relevant: true, now: inside }), (e) => e.message.includes(CRON_WINDOW_TOGGLE) && /--yes and --force do not override/.test(e.message));
  assert.equal(checkCronWindow({ hour: 4, relevant: true, now: () => t("2026-11-16T12:00:00Z" )})[2], "ok");
  assert.equal(checkCronWindow({ hour: 4, relevant: true, now: inside, ignore: true })[2], "warn");
  assert.equal(checkCronWindow({ hour: 4, relevant: true, now: inside, dry: true })[2], "bad");
  assert.equal(checkCronWindow({ hour: 4, relevant: false, now: inside }), null, "nothing to build or switch: no check");
  assert.equal(checkCronWindow({ relevant: true, hour: null, now: inside }), null, "no cleanup hour configured: no guard");
  assert.equal(checkCronWindow({ relevant: true, now: inside }), null, "the hour defaults to none");
  assert.throws(() => checkCronWindow({ relevant: true, hour: 25, now: inside }), /cleanupCronUtcHour must be an hour/);
  assert.throws(() => checkCronWindow({ relevant: true, hour: 22, now: () => t("2026-11-16T21:30:00Z") }), /span 22:00 UTC/, "another configured hour is guarded the same way");
  assert.equal(checkCronWindow({ relevant: true, hour: 22, now: inside })[2], "ok", "03:30Z is clear of 22:00 UTC");
  assert.doesNotMatch(read("tools/deploy/lib/cronWindow.mjs").slice(read("tools/deploy/lib/cronWindow.mjs").indexOf("export function checkCronWindow(")), /(?<!-)\b(force|yes)\b/, "checkCronWindow reads force or yes");
});

test("(5) the 04:00 UTC guard applies to server, all and rollback server only — and only its own switch sets the override", () => {
  const z = (argv) => cronWindowTargets(parseArgs(argv));
  assert.equal(z(["server"]), true);
  assert.equal(z(["all"]), true);
  assert.equal(z(["rollback", "server"]), true);
  for (const argv of [["web"], ["client"], ["web", "client"], ["status"], ["rollback", "client"], ["init"]]) assert.equal(z(argv), false, argv.join(" "));
  assert.equal(parseArgs(["server", CRON_WINDOW_TOGGLE]).ignoreCronWindow, true);
  assert.equal(parseArgs(["server", "--yes", "--force"]).ignoreCronWindow, false);
  assert.throws(() => parseArgs(["web", CRON_WINDOW_TOGGLE]), /belongs to/);
  // deploy.mjs checks before the gate (deploy) and before the rollback, and hands over only this switch.
  const src = read("tools/deploy/deploy.mjs");
  assert.ok(src.includes("checkCronWindow({ relevant: cronWindowTargets(o), hour: config.remote.cleanupCronUtcHour, ignore: o.ignoreCronWindow, dry: isDryRun() })"));
  assert.ok(src.indexOf("checkCronWindow(") < src.indexOf("await rollback(o.rollbackWhat"), "the guard stands before the rollback");
  assert.ok(src.lastIndexOf("checkCronWindow(") < src.indexOf("await check({\n      plan: DEFAULT_PLAN,\n      quick: o.quick ||"), "the guard stands before the gate");
  const main = src.slice(src.indexOf("async function main("), src.indexOf("\n}\n", src.indexOf("async function main(")));
  const check = main.lastIndexOf("checkCronWindow({");
  assert.ok(check > main.indexOf("const branch = await assertMainBranch(") && check < main.indexOf("await runTargets("), "the guard stands after the branch rule and before the targets");
  assert.match(src, /--cron-window-ignore\n\s+"server"/, "the help does not name the switch");
  assert.match(read("DEPLOY.md"), /--cron-window-ignore/);
  assert.match(read("tools/deploy/README.md"), /lib\/cronWindow\.mjs/);
});
