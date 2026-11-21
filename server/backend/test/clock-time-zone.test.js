// The clock time of server texts in the HUMAN's zone (i18n.js clockText).
//
// The user container runs in UTC. clockText (runs/limit-gate.js) used to format in the process zone - the log said
// "Continuing at 04/10, 17:40", the push too, while the strip in the browser showed "continues at 07:50 PM". A push
// text cannot be converted again in the client; the server must know the zone. It gets it from the client
// (PUT /api/ui-lang, field `zone`; route test in credit-wake-check.test.js).
//
// Fallback, in this order: argument `zone` -> reported zone -> outside the container the process zone (a local server
// runs on the human's Mac) -> in the container UTC WITH " UTC" behind it, never silently wrong.
//
// Counter-test: a clockText that formats in the process zone gives 17:40 instead of 19:40 and turns the first test
// red; dropping the " UTC" mark turns the container fallback red.
import assert from "node:assert/strict";
import test from "node:test";

import * as i18n from "../electron/server/i18n.js";
import { clockText } from "../electron/server/runs/limit-gate.js";

process.env.TZ = "UTC";   // the process zone of the user container (Node picks it up at runtime)
const TS = Date.parse("2026-10-04T17:40:44Z");   // the wake time of the incident

function withEnvironment(container, fn) {
  const saved = process.env.CBASE_CONTAINER;
  if (container) process.env.CBASE_CONTAINER = "1"; else delete process.env.CBASE_CONTAINER;
  try { return fn(); } finally { if (saved === undefined) delete process.env.CBASE_CONTAINER; else process.env.CBASE_CONTAINER = saved; }
}

test("clockText (all limit sentences, notice, wait sentence) writes in the human's reported zone", () => {
  assert.equal(typeof i18n.setUiZone, "function", "the human's zone has no place");
  i18n.setUiLang("de");
  assert.equal(i18n.setUiZone("Europe/Berlin"), "Europe/Berlin");
  withEnvironment(true, () => {
    assert.equal(clockText(TS), "04.10., 19:40", "Berlin in October is UTC+2");
    i18n.setUiLang("en");
    assert.equal(clockText(TS), "04/10, 19:40");
    i18n.setUiLang("de");
  });
  assert.equal(clockText(0), "", "no time, no text");
});

test("clockText: zone fallback - argument, reported zone, process zone, in the container UTC with a mark", () => {
  i18n.setUiLang("de");
  i18n.setUiZone("Europe/Berlin");
  // 1. The argument comes first (a caller that knows the zone of its subject).
  assert.equal(i18n.clockText(TS, { zone: "America/New_York" }), "04.10., 13:40");
  assert.equal(i18n.clockText(TS, { zone: "Mars/Olympus" }), "04.10., 19:40", "an invalid argument falls back to the reported zone");
  assert.equal(i18n.clockText(TS, { withDate: false }), "19:40");
  // 2./3./4. Without a reported zone.
  assert.equal(i18n.setUiZone("Mars/Olympus"), "", "an invalid zone is not adopted");
  assert.equal(i18n.getUiZone(), "");
  withEnvironment(false, () => assert.equal(i18n.clockText(TS), "04.10., 17:40", "local: the process zone, without a suffix"));
  withEnvironment(true, () => assert.equal(i18n.clockText(TS), "04.10., 17:40 UTC", "container without a zone: UTC, and it says so"));
  assert.equal(i18n.zoneValid("Europe/Berlin"), true);
  assert.equal(i18n.zoneValid(""), false);
  assert.equal(i18n.zoneValid(42), false);
  i18n.setUiZone("");
});
