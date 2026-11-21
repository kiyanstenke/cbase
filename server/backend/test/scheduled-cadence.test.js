// The cadence of scheduled jobs, without a server: scheduled/cadence.js turns a form and plan into cron, next occurrence, period and
// plain text; scheduled/contract.js names the values. Every form yields the expected occurrence, also across the daylight-saving
// switches of March and October 2026 in Europe/Berlin (29.03. 02:00 -> 03:00, 25.10. 03:00 -> 02:00). Plus the binding contract <->
// computation: every cadence of the contract computes, no other, and the bounds of day-of-month and weekday are the same.
//
// Counter-tests (each shown red once):
//   bound `day > 28` in cadence.js set to `day > 31`                          => "monthly ..." and "contract ..." red
//   "monthly" removed from CADENCES in contract.js                            => "contract ..." red (the computation knows one cadence more)
//
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/scheduled-cadence.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nextOccurrence, periodMs, cadenceOff, cadenceText } from "../electron/server/scheduled/cadence.js";
import { DAY_OF_MONTH, CADENCES, WEEKDAY } from "../electron/server/scheduled/contract.js";
import { setUiLang } from "../electron/server/i18n.js";

/** The plain text in both UI languages: [German, English] — cadenceText picks the language at call time. */
function bothLanguages(a) {
  const de = cadenceText(a);
  setUiLang("en");
  try { return [de, cadenceText(a)]; } finally { setUiLang("de"); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULED = path.join(HERE, "../electron/server/scheduled");
const TZ = "Europe/Berlin";
const T = (iso) => Date.parse(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A job as store/scheduled.js delivers it, from a valid form. */
function job(cadence, plan, now = T("2026-03-01T00:00:00Z"), timeZone = TZ) {
  const r = cadenceOff(cadence, plan, { timeZone, now });
  assert.equal(r.ok, true, `${cadence} ${JSON.stringify(plan)}: ${r.error}`);
  return { cadence: r.cadence, plan: r.plan, cron: r.cron, oneTimeAt: r.oneTimeAt, timeZone };
}
const error = (cadence, plan, opts = {}) => {
  const r = cadenceOff(cadence, plan, { timeZone: TZ, now: T("2026-03-01T00:00:00Z"), ...opts });
  assert.equal(r.ok, false, `${cadence} ${JSON.stringify(plan)} should have been rejected`);
  assert.equal(typeof r.error, "string", "the error is the finished text");
  assert.ok(r.error.length > 0, "the error is the finished text");
  return r.error;
};

test("daily: 22:00 Berlin across both clock changes — occurrence in wall time, period 23 h in March and 25 h in October", () => {
  const a = job("daily", { clockTime: "22:00" });
  assert.equal(a.cron, "0 22 * * *");
  const march = T("2026-03-28T12:00:00Z");
  const m1 = nextOccurrence(a, march);
  assert.equal(m1, T("2026-03-28T21:00:00Z"), "Sat 28.03. 22:00 CET");
  assert.equal(nextOccurrence(a, m1), T("2026-03-29T20:00:00Z"), "Sun 29.03. 22:00 CEST — STRICTLY after the previous one");
  assert.equal(periodMs(a, march), 23 * HOUR, "the coming gap across the spring-forward");
  const october = T("2026-10-24T12:00:00Z");
  const o1 = nextOccurrence(a, october);
  assert.equal(o1, T("2026-10-24T20:00:00Z"), "Sat 24.10. 22:00 CEST");
  assert.equal(nextOccurrence(a, o1), T("2026-10-25T21:00:00Z"), "Sun 25.10. 22:00 CET");
  assert.equal(periodMs(a, october), 25 * HOUR, "the coming gap across the fall-back");
  assert.deepEqual(bothLanguages(a), ["Täglich um 22:00", "Daily at 22:00"]);
});

test("daily: a time in the gap fires an hour later, a duplicated one at one of the two; the time is zero-padded", () => {
  const a = job("daily", { clockTime: "2:30" });
  assert.deepEqual(a.plan, { clockTime: "02:30" });
  assert.equal(nextOccurrence(a, T("2026-03-28T12:00:00Z")), T("2026-03-29T01:30:00Z"), "29.03. 02:30 does not exist => 03:30 CEST");
  const duplicate = nextOccurrence(a, T("2026-10-24T12:00:00Z"));
  assert.ok([T("2026-10-25T00:30:00Z"), T("2026-10-25T01:30:00Z")].includes(duplicate), `25.10. 02:30 exists twice: ${new Date(duplicate).toISOString()}`);
});

test("workdays: Friday evening after the occurrence => Monday, across the fall-back into winter time", () => {
  const a = job("workdays", { clockTime: "22:00" });
  assert.equal(a.cron, "0 22 * * 1-5");
  assert.equal(nextOccurrence(a, T("2026-10-23T21:00:00Z")), T("2026-10-26T21:00:00Z"), "Fri 23.10. 23:00 CEST => Mon 26.10. 22:00 CET");
  assert.equal(periodMs(a, T("2026-10-23T21:00:00Z")), DAY, "Mon -> Tue");
  assert.deepEqual(bothLanguages(a), ["Werktags um 22:00", "Weekdays at 22:00"]);
});

test("weekly: days sorted and unique, period 1 or 6 days depending on position (Mon+Tue), at least one day 0-6", () => {
  const a = job("weekly", { clockTime: "22:00", days: [2, 1, 1] });
  assert.deepEqual(a.plan, { clockTime: "22:00", days: [1, 2] });
  assert.equal(a.cron, "0 22 * * 1,2");
  assert.equal(periodMs(a, T("2026-10-12T21:00:00Z")), 6 * DAY, "Mon 12.10. after the occurrence: Tue 13. -> Mon 19.");
  assert.equal(periodMs(a, T("2026-10-13T21:00:00Z")), DAY, "Tue 13.10. after the occurrence: Mon 19. -> Tue 20.");
  assert.equal(nextOccurrence(a, T("2026-10-20T21:00:00Z")), T("2026-10-26T21:00:00Z"), "across the fall-back: Mon 26.10. 22:00 CET");
  assert.deepEqual(bothLanguages(a), ["Wöchentlich montags und dienstags um 22:00", "Weekly on Mon, Tue at 22:00"]);
  assert.match(error("weekly", { clockTime: "22:00", days: [] }), /mindestens ein Wochentag/);
  assert.match(error("weekly", { clockTime: "22:00" }), /plan\.days/);
  assert.match(error("weekly", { clockTime: "22:00", days: [7] }), /plan\.days/);
  assert.match(error("weekly", { clockTime: "22:00", days: ["1"] }), /plan\.days/, "whole numbers only");
});

test("monthly: day 1-28, 29-31 are an error", () => {
  const a = job("monthly", { clockTime: "08:15", day: 15 });
  assert.equal(a.cron, "15 8 15 * *");
  assert.equal(nextOccurrence(a, T("2026-10-24T12:00:00Z")), T("2026-11-15T07:15:00Z"), "Sun 15.11. 08:15 CET");
  assert.deepEqual(bothLanguages(a), ["Monatlich am 15. um 08:15", "Monthly on day 15 at 08:15"]);
  for (const day of [1, 28]) job("monthly", { clockTime: "08:15", day });
  for (const day of [0, 29, 30, 31, 1.5, "15"]) assert.match(error("monthly", { clockTime: "08:15", day }), /plan\.day: 1 bis 28/, `day ${JSON.stringify(day)}`);
});

test("oneTime: ms or ISO (wall time in the zone, with offset as written), future only; afterwards no occurrence and no period", () => {
  const now = T("2026-10-24T12:00:00Z");
  const a = job("oneTime", { at: "2026-10-25T09:00" }, now);
  assert.equal(a.oneTimeAt, T("2026-10-25T08:00:00Z"), "09:00 CET on 25.10.");
  assert.deepEqual(a.plan, { at: a.oneTimeAt }, "the plan carries the point in time in ms");
  assert.equal(a.cron, "");
  assert.equal(nextOccurrence(a, now), a.oneTimeAt);
  assert.equal(nextOccurrence(a, a.oneTimeAt), 0, "strictly after it there is none");
  assert.equal(periodMs(a, now), 0);
  assert.equal(job("oneTime", { at: "2026-10-25T09:00Z" }, now).oneTimeAt, T("2026-10-25T09:00:00Z"), "with zone as written");
  assert.equal(job("oneTime", { at: T("2026-11-01T10:00:00Z") }, now).oneTimeAt, T("2026-11-01T10:00:00Z"), "ms");
  assert.deepEqual(bothLanguages(a), ["Einmalig am So 25.10.2026 09:00", "Once on Sun 25/10/2026 09:00"]);
  assert.match(error("oneTime", { at: "2026-10-24T09:00" }, { now }), /nicht in der Zukunft/);
  assert.match(error("oneTime", { at: "morgen" }), /plan\.at/);
  assert.match(error("oneTime", {}), /plan\.at/);
});

test("input: without cadence, with hours or cron, unknown form, without time or with unknown zone => error", () => {
  assert.match(error(undefined, { clockTime: "08:00" }), /cadence fehlt/);
  assert.match(error("", { clockTime: "08:00" }), /cadence fehlt/);
  assert.match(error("hours", { hours: 4 }), /gibt es nicht mehr/);
  assert.match(error("cron", { cron: "0 8 * * *" }), /gibt es nicht mehr/);
  assert.match(error("yearly", { clockTime: "08:00" }), /Unbekannter Rhythmus/);
  assert.match(error("daily", {}), /plan\.clockTime/, "a missing field is not a statement — no default 08:00");
  assert.match(error("daily", { clockTime: "24:00" }), /plan\.clockTime/);
  assert.match(error("daily", null), /plan muss ein Objekt/);
  assert.match(error("daily", { clockTime: "08:00" }, { timeZone: "Berlin" }), /Unbekannte Zeitzone/);
  assert.match(error("daily", { clockTime: "08:00" }, { timeZone: undefined }), /Unbekannte Zeitzone/);
});

test("contract <-> computation: every cadence of the contract computes, no other; day-of-month and weekday have the same bounds", () => {
  const example = {
    oneTime: { at: T("2026-12-24T17:00:00Z") },
    daily: { clockTime: "08:00" },
    workdays: { clockTime: "08:00" },
    weekly: { clockTime: "08:00", days: [WEEKDAY.min, WEEKDAY.max] },
    monthly: { clockTime: "08:00", day: DAY_OF_MONTH.max },
  };
  assert.deepEqual(Object.keys(example).sort(), [...CADENCES].sort(), "the example covers exactly the cadences of the contract");
  for (const r of CADENCES) job(r, example[r]);
  // The computation knows no cadence outside the contract: every form cadence.js queries in its source is in it.
  const source = fs.readFileSync(path.join(SCHEDULED, "cadence.js"), "utf8");
  const queried = [...new Set([...source.matchAll(/cadence === "(\w+)"/g)].map((m) => m[1]))].filter((n) => !["hours", "cron"].includes(n));
  assert.deepEqual(queried.sort(), [...CADENCES].sort(), "cadence.js queries other forms than the contract names");
  assert.match(error("monthly", { clockTime: "08:00", day: DAY_OF_MONTH.max + 1 }), /plan\.day/);
  assert.match(error("monthly", { clockTime: "08:00", day: DAY_OF_MONTH.min - 1 }), /plan\.day/);
  assert.match(error("weekly", { clockTime: "08:00", days: [WEEKDAY.max + 1] }), /plan\.days/);
});

test("leaves: contract.js imports nothing, cadence.js only cron.js and the translator i18n.js (itself a leaf)", () => {
  const imports = (file) => [...fs.readFileSync(path.join(SCHEDULED, file), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports("contract.js"), [], "the contract is a leaf without imports (web and iOS bind it)");
  assert.deepEqual(imports("cadence.js"), ["../cron.js", "../i18n.js"]);
  assert.deepEqual(imports("../i18n.js"), ["./i18n-de.js"], "the translator pulls in nothing but its table");
  assert.deepEqual(imports("../i18n-de.js"), []);
});
