// lib/sleep-watch.mjs: the gate names a system sleep during the suites instead of leaving confusing red rows (targets/check.mjs).
// COUNTER-TEST: sleptBetween always false (or check.mjs without the call) => (2) resp. (3) red.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SLEPT_REASON, lastSleep, sleptBetween } from "./lib/sleep-watch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const reading = (sec) => () => `{ sec = ${sec}, usec = 457295 } Sat Nov 21 19:24:23 2026\n`;

test("(1) lastSleep reads kern.sleeptime on macOS, null elsewhere or on an unreadable answer", () => {
  assert.equal(lastSleep({ platform: "darwin", read: reading(1795285463) }), 1795285463);
  assert.equal(lastSleep({ platform: "linux", read: reading(1) }), null);
  assert.equal(lastSleep({ platform: "darwin", read: () => "" }), null);
  if (process.platform === "darwin") assert.equal(typeof lastSleep(), "number", "the real sysctl answers on this Mac");
});

test("(2) a changed reading is a sleep; equal or missing readings are not", () => {
  assert.equal(sleptBetween(1, 2), true);
  assert.equal(sleptBetween(5, 5), false);
  assert.equal(sleptBetween(null, 2), false);
  assert.equal(sleptBetween(1, null), false);
});

test("(3) the gate reads it around the suites and turns a sleep into its own failure row", () => {
  const src = fs.readFileSync(path.join(HERE, "targets", "check.mjs"), "utf8");
  const before = src.indexOf("const sleepBefore = lastSleep();"), run = src.indexOf("results = await runSuites("), after = src.indexOf("if (sleptBetween(sleepBefore, lastSleep()))");
  assert.ok(before >= 0 && run > before && after > run, "lastSleep must be read before and after runSuites");
  assert.match(src.slice(after, after + 300), /failures\.push\(SLEPT_REASON\)/);
  assert.match(SLEPT_REASON, /slept while the suites ran/);
});
