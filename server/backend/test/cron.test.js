import assert from "node:assert/strict";
import test from "node:test";

import { cronPeriodMs, cronSteps, nextCronAt, parseCron } from "../electron/server/cron.js";

// Local time — this is how the CLI reads its expressions.
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const iso = (ms) => new Date(ms).toString();

test("The expression from the incident hits the scheduled minute", () => {
  // "42 19 21 8 *" — set on 21 Aug at 19:40:09, it must fire at 19:42:00.
  const from = at(2026, 8, 21, 19, 40) + 9_000;
  assert.equal(nextCronAt("42 19 21 8 *", from), at(2026, 8, 21, 19, 42), iso(nextCronAt("42 19 21 8 *", from)));
});

test("The current minute no longer counts", () => {
  const from = at(2026, 8, 21, 19, 42) + 500; // half a second after firing
  assert.equal(nextCronAt("42 19 * * *", from), at(2026, 8, 22, 19, 42));
});

test("Steps, ranges and lists", () => {
  const from = at(2026, 8, 21, 19, 41);
  assert.equal(nextCronAt("*/5 * * * *", from), at(2026, 8, 21, 19, 45));
  assert.equal(nextCronAt("0,30 * * * *", from), at(2026, 8, 21, 20, 0));
  assert.equal(nextCronAt("7 9-17 * * *", from), at(2026, 8, 22, 9, 7));
  assert.equal(nextCronAt("5/15 * * * *", from), at(2026, 8, 21, 19, 50));
});

test("Weekdays — 21.08.2026 is a Friday", () => {
  assert.equal(new Date(at(2026, 8, 21, 0, 0)).getDay(), 5);
  const from = at(2026, 8, 21, 19, 41);
  assert.equal(nextCronAt("0 9 * * 1-5", from), at(2026, 8, 24, 9, 0)); // Monday
  assert.equal(nextCronAt("0 9 * * mon", from), at(2026, 8, 24, 9, 0));
  assert.equal(nextCronAt("0 9 * * 0", from), at(2026, 8, 23, 9, 0));   // Sunday
  assert.equal(nextCronAt("0 9 * * 7", from), at(2026, 8, 23, 9, 0));   // 7 is Sunday too
});

// Vixie cron: when day-of-month AND weekday are both set, OR applies. Computing AND here keeps a
// run open days too long (or closes it too early).
test("Day-of-month and weekday are OR-ed", () => {
  const from = at(2026, 8, 21, 19, 41);
  assert.equal(nextCronAt("0 9 1 * 1", from), at(2026, 8, 24, 9, 0));  // the Monday first …
  assert.equal(nextCronAt("0 9 1 * 1", at(2026, 8, 25, 0, 0)), at(2026, 8, 31, 9, 0)); // … then Monday again
  assert.equal(nextCronAt("0 9 1 * 3", at(2026, 8, 28, 0, 0)), at(2026, 9, 1, 9, 0));  // the 1st comes before the Wednesday
});

test("Month names and the turn of the year", () => {
  assert.equal(nextCronAt("0 0 1 jan *", at(2026, 8, 21, 19, 41)), at(2027, 1, 1, 0, 0));
  assert.equal(nextCronAt("30 14 28 2 *", at(2026, 8, 21, 19, 41)), at(2027, 2, 28, 14, 30));
});

test("Impossible and nonsensical input give 0 instead of a made-up time", () => {
  assert.equal(nextCronAt("0 0 30 2 *"), 0);      // there is no 30 February
  assert.equal(nextCronAt("60 * * * *"), 0);
  assert.equal(nextCronAt("* * * *"), 0);         // only four fields
  assert.equal(nextCronAt("jeden Montag"), 0);
  assert.equal(nextCronAt(""), 0);
  assert.equal(nextCronAt("*/0 * * * *"), 0);
  assert.equal(parseCron("0 9 * * *")?.hour.has(9), true);
  assert.equal(parseCron("broken"), null);
});

// The period carries the surcharge on the hold deadline: the CLI fires recurring jobs up to
// 10 % of the period late.
test("Period between two firing times", () => {
  const from = at(2026, 8, 21, 19, 41);
  assert.equal(cronPeriodMs("*/5 * * * *", from), 5 * 60_000);
  assert.equal(cronPeriodMs("0 * * * *", from), 3600_000);
  assert.equal(cronPeriodMs("0 9 * * *", from), 24 * 3600_000);
  assert.equal(cronPeriodMs("broken", from), 0);
});

// One year of lookahead is the cap — the search must neither hang nor guess. What is checked is the
// MECHANISM "jump by day" (cron.js) as a STEP COUNT: an expression that does not occur within the
// year (29 Feb from a March) runs to the cap — by day that is 366 steps, by minute it would be
// 527,000. No duration is asserted; cron.js counts its steps.
test("The search jumps by day — 366 steps to the one-year cap, not 527,000", (t) => {
  const prior = cronSteps();
  assert.equal(nextCronAt("0 0 29 2 *", at(2026, 3, 1, 0, 0)), 0, "no 29 Feb within a year from March 2026");
  const counted = cronSteps() - prior;
  t.diagnostic(`Steps to the cap: ${counted} (by day ≈ 366, by minute ≈ 527,000)`);
  assert.ok(counted <= 400, `${counted} steps — does the search still jump by day?`);
});

// ── Time zones: schedules ────────────────────
// The user container runs in UTC; a schedule carries its own IANA zone. Computation is in the
// zone's wall time, DST included — fixed UTC timestamps so the test behaves the same whatever
// zone the machine is in.
import { cronPeriodMsZone, fromWallClock, nextCronAtZone, wallClock, wallTimeText, zoneValid } from "../electron/server/cron.js";
import { getUiLang, setUiLang } from "../electron/server/i18n.js";
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi, 0, 0);
const B = "Europe/Berlin";

test("Zone: weekdays 08:00 Berlin is 06:00 UTC in summer and 07:00 UTC in winter", () => {
  assert.equal(nextCronAtZone("0 8 * * 1-5", utc(2026, 9, 2, 20, 0), B), utc(2026, 9, 3, 6, 0), "Summer: Thu 03.09. 08:00 CEST");
  assert.equal(nextCronAtZone("0 8 * * 1-5", utc(2026, 12, 3, 20, 0), B), utc(2026, 12, 4, 7, 0), "Winter: Fri 04.12. 08:00 CET");
  // Friday 20:00 UTC → the next weekday is Monday.
  assert.equal(nextCronAtZone("0 8 * * 1-5", utc(2026, 9, 4, 20, 0), B), utc(2026, 9, 7, 6, 0));
});

test("Zone: without a zone like nextCronAt, with an unknown one 0", () => {
  const from = utc(2026, 9, 2, 20, 0);
  assert.equal(nextCronAtZone("0 8 * * *", from, ""), nextCronAt("0 8 * * *", from));
  assert.equal(nextCronAtZone("0 8 * * *", from, "Nirgendwo/Stadt"), 0);
  assert.equal(nextCronAtZone("broken", from, B), 0);
  assert.equal(zoneValid(B), true);
  assert.equal(zoneValid("Berlin"), false);
  assert.equal(zoneValid(""), false);
});

test("Zone: DST — the missing hour fires afterwards, the doubled one exactly once", () => {
  // 29.03.2026 02:00 CET → 03:00 CEST: "30 2" does not exist that day. The run is not skipped
  // but comes at the first moment after (03:30 CEST = 01:30 UTC).
  const spring = nextCronAtZone("30 2 * * *", utc(2026, 3, 28, 12, 0), B);
  assert.equal(spring, utc(2026, 3, 29, 1, 30), wallTimeText(spring, B));
  // And the day after is regular again: 02:30 CEST = 00:30 UTC.
  assert.equal(nextCronAtZone("30 2 * * *", spring, B), utc(2026, 3, 30, 0, 30));
  // 25.10.2026 03:00 CEST → 02:00 CET: 02:30 occurs twice, it fires ONCE — the next
  // occurrence lies on the next day, not an hour later.
  const autumn = nextCronAtZone("30 2 * * *", utc(2026, 10, 24, 12, 0), B);
  assert.equal(wallClock(autumn, B).H, 2);
  assert.equal(wallClock(autumn, B).M, 30);
  const afterwards = nextCronAtZone("30 2 * * *", autumn, B);
  assert.equal(wallClock(afterwards, B).d, 26, "not the second 02:30 of the same day");
});

test("Zone: period and plain text", () => {
  assert.equal(cronPeriodMsZone("0 8 * * 1-5", utc(2026, 9, 2, 12, 0), B), 24 * 3600_000, "Do→Fr");
  assert.equal(cronPeriodMsZone("0 8 * * 1-5", utc(2026, 9, 3, 12, 0), B), 72 * 3600_000, "Fr→Mo");
  assert.equal(cronPeriodMsZone("0 */4 * * *", utc(2026, 9, 4, 12, 0), "UTC"), 4 * 3600_000);
  assert.equal(wallTimeText(utc(2026, 9, 3, 6, 0), B), "Do 03.09.2026 08:00");
  assert.equal(wallTimeText(utc(2026, 9, 3, 6, 0), B, { withYear: false }), "Do 03.09 08:00");
  assert.equal(wallTimeText(utc(2026, 9, 3, 6, 0), B, { withYear: false, withClockTime: false }), "Do 03.09");
  assert.equal(wallTimeText(utc(2026, 9, 3, 6, 0), "broken"), "Do 03.09.2026 06:00", "unknown zone ⇒ UTC");
  // The weekday and the date follow the UI language, not a fixed German spelling.
  const before = getUiLang();
  setUiLang("en");
  try {
    assert.equal(wallTimeText(utc(2026, 9, 3, 6, 0), B), "Thu 03/09/2026 08:00");
    assert.equal(wallTimeText(utc(2026, 9, 3, 6, 0), B, { withYear: false, withClockTime: false }), "Thu 03/09");
  } finally { setUiLang(before); }
  // Wall time ↔ timestamp are inverses of each other.
  assert.equal(fromWallClock({ y: 2026, m: 9, d: 3, H: 8, M: 0 }, B), utc(2026, 9, 3, 6, 0));
  assert.equal(fromWallClock({ y: 2026, m: 12, d: 3, H: 8, M: 0 }, B), utc(2026, 12, 3, 7, 0));
});
