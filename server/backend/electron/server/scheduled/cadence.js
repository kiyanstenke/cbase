// The cadence of a scheduled job: from form and plan the cron expression, the next occurrence, the period and the plain
// text. A LEAF that imports only `cron.js` and `i18n.js` — the values themselves (cadences, day of month, weekday) are in
// the contract `contract.js`, and `server/backend/test/scheduled-cadence.test.js` holds both together (every cadence of
// the contract computes here, no other). Texts go out through `T` (i18n.js).
//
// | cadence        | plan                      | cron            |
// |----------------|---------------------------|-----------------|
// | oneTime        | {at} (ms or ISO)          | —               |
// | daily          | {clockTime}               | M H * * *       |
// | workdays       | {clockTime}               | M H * * 1-5     |
// | weekly         | {clockTime, days:[0..6]}  | M H * * d1,d2,… |
// | monthly        | {clockTime, day 1–28}     | M H D * *       |
//
// Every clock time applies in the job's zone. Computed with `nextCronAtZone`/`cronPeriodMsZone` (cron.js): the period is
// the UPCOMING distance — for Mon+Tue 1 or 6 days depending on position; daylight saving time is handled by computing
// the wall time via Intl (a clock time in the gap when clocks go forward fires an hour later at the same minute —
// 02:30 becomes 03:30 —, a doubled clock time when clocks go back fires at one of the two).
import { cronPeriodMsZone, fromWallClock, nextCronAtZone, wallTimeText, zoneValid } from "../cron.js";
import { T } from "../i18n.js";

// Read at the moment of display: T("Sun##weekly") … (German: the adverb, "sonntags").
const WEEKDAY_NAMES = [() => T("Sun##weekly"), () => T("Mon##weekly"), () => T("Tue##weekly"), () => T("Wed##weekly"), () => T("Thu##weekly"), () => T("Fri##weekly"), () => T("Sat##weekly")];
const pad = (n) => String(n).padStart(2, "0");
const no = (error) => ({ ok: false, error });

/** "HH:MM" (also "8:05") → {H, M} or null. */
function clockTimeParts(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof t === "string" ? t.trim() : "");
  if (!m) return null;
  const H = Number(m[1]), M = Number(m[2]);
  return H <= 23 && M <= 59 ? { H, M } : null;
}

/** The moment of a one-time occurrence: ms, or ISO — with zone/offset as written, without one as wall time in `tz`. 0 = unreadable. */
function moment(raw, tz) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (/^\d+$/.test(s)) return Number(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!iso) return 0;
  if (iso[6]) { const t = Date.parse(s.replace(" ", "T")); return Number.isFinite(t) ? t : 0; }
  return fromWallClock({ y: +iso[1], m: +iso[2], d: +iso[3], H: +iso[4], M: +iso[5] }, tz);
}

/**
 * Check and derive form and plan. `timeZone` is the job's zone, `now` the clock (a one-time occurrence must lie after it).
 * @returns {{ok: true, cadence: string, plan: object, cron: string, oneTimeAt: number} | {ok: false, error: string}}
 *   `plan` is cleaned (only the keys of the form, clock time two-digit, days sorted and unique); `cron` is empty for
 *   `oneTime`, `oneTimeAt` otherwise 0.
 */
export function cadenceOff(cadence, plan, { timeZone, now = Date.now() } = {}) {
  if (cadence === undefined || cadence === null || cadence === "") return no(T("cadence missing"));
  if (cadence === "hours" || cadence === "cron") {
    return no(T`Rhythm "${cadence}" no longer exists — oneTime, daily, workdays, weekly or monthly`);
  }
  if (!zoneValid(timeZone)) return no(T`Unknown time zone: ${timeZone ?? "(empty)"}`);
  const tz = timeZone.trim();
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return no(T("plan must be an object"));

  if (cadence === "oneTime") {
    const at = moment(plan.at, tz);
    if (!at) return no(T("plan.at: a point in time (ms or ISO) is required"));
    if (at <= now) return no(T("plan.at: the point in time is not in the future"));
    return { ok: true, cadence, plan: { at }, cron: "", oneTimeAt: at };
  }

  const u = clockTimeParts(plan.clockTime);
  if (!u) return no(T("plan.clockTime: HH:MM required"));
  const clockTime = `${pad(u.H)}:${pad(u.M)}`;
  let cron, clean;
  if (cadence === "daily") { cron = `${u.M} ${u.H} * * *`; clean = { clockTime }; }
  else if (cadence === "workdays") { cron = `${u.M} ${u.H} * * 1-5`; clean = { clockTime }; }
  else if (cadence === "weekly") {
    const days = Array.isArray(plan.days) ? plan.days : null;
    if (!days || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return no(T("plan.days: at least one weekday, 0 (Sun) to 6 (Sat)"));
    }
    const unique = [...new Set(days)].sort((a, b) => a - b);
    cron = `${u.M} ${u.H} * * ${unique.join(",")}`; clean = { clockTime, days: unique };
  } else if (cadence === "monthly") {
    const day = plan.day;
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return no(T("plan.day: 1 to 28 — on the 29th, 30th or 31st whole months would be skipped"));
    }
    cron = `${u.M} ${u.H} ${day} * *`; clean = { clockTime, day };
  } else {
    return no(T`Unknown rhythm: ${cadence}`);
  }
  if (!nextCronAtZone(cron, now, tz)) return no(T`No date for ${cron}`);
  return { ok: true, cadence, plan: clean, cron, oneTimeAt: 0 };
}

/** Next occurrence STRICTLY after `from` — 0 when there is none (one-time and past). Takes a job (store/scheduled.js). */
export function nextOccurrence(a, from = Date.now()) {
  if (a.cadence === "oneTime") return a.oneTimeAt > from ? a.oneTimeAt : 0;
  return nextCronAtZone(a.cron, from, a.timeZone);
}

/** The upcoming distance between two occurrences from `from` (ms), 0 for one-time — the basis of catching up (half the period). */
export function periodMs(a, from = Date.now()) {
  return a.cadence === "oneTime" ? 0 : cronPeriodMsZone(a.cron, from, a.timeZone);
}

/** Plain text of the cadence for list, prompt and notification, in the UI language: "Weekdays at 22:00". */
export function cadenceText(a) {
  const u = a.plan?.clockTime || "";
  switch (a.cadence) {
    case "oneTime": {
      const when = wallTimeText(a.oneTimeAt || a.plan?.at || 0, a.timeZone);
      return T`Once on ${when}`;
    }
    case "daily": return T`Daily at ${u}`;
    case "workdays": return T`Weekdays at ${u}`;
    case "weekly": {
      const days = (a.plan?.days || []).map((d) => WEEKDAY_NAMES[d]).filter(Boolean).map((name) => name());
      const list = days.length > 1 ? `${days.slice(0, -1).join(", ")}${T(", ##lastWeekday")}${days.at(-1)}` : days.join("");
      return T`Weekly on ${list} at ${u}`;
    }
    case "monthly": return T`Monthly on day ${a.plan?.day} at ${u}`;
    default: return T`Rhythm ${a.cadence}`;
  }
}
