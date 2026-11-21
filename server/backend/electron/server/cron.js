// Cron expressions as the CronCreate tool of the Claude CLI accepts them: five fields in LOCAL time — minute hour
// day-of-month month weekday. Needed because such a job lives only in the running CLI session: if cbase closes stdin, it dies
// with the process. So the server must know WHEN it would fire next, to keep the run open until then (and to show the user the time).
//
// Semantics as in Vixie cron. The one special case that is easy to miss: if day-of-month AND weekday are both restricted, OR
// applies — "30 4 1 * 1" is the first of the month *and* every Monday, not "Mondays on the first only".

import { T, getUiLang } from "./i18n.js";

const FIELDS = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 7 },   // weekday (0 and 7 are both Sunday)
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function fieldValue(token, index) {
  const t = token.toLowerCase();
  if (index === 3) { const i = MONTHS.indexOf(t); if (i >= 0) return i + 1; }
  if (index === 4) { const i = DAYS.indexOf(t); if (i >= 0) return i; }
  return /^\d{1,2}$/.test(t) ? Number(t) : NaN;
}

// Resolve a field ("*", "*/5", "1-5", "0,30", "mon-fri") to a set. null = invalid.
function parseField(spec, index) {
  const { min, max } = FIELDS[index];
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo, hi;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = fieldValue(a, index); hi = fieldValue(b, index);
    } else {
      lo = fieldValue(range, index);
      // "5/15" means from 5 in steps of 15 to the end of the field, "5" only the 5.
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(index === 4 && v === 7 ? 0 : v);
  }
  return out.size ? out : null;
}

/** Parse a five-field expression. Returns null if it is not understood. */
export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, i));
  if (sets.some((s) => !s)) return null;
  const [minute, hour, dom, month, dow] = sets;
  return {
    minute, hour, month,
    dom, dow,
    // "Restricted" means the field was not "*". Only then does it count for the OR rule.
    domAny: parts[2] === "*",
    dowAny: parts[4] === "*",
  };
}

function dayMatches(f, d) {
  const dom = f.dom.has(d.getDate());
  const dow = f.dow.has(d.getDay());
  if (f.domAny && f.dowAny) return true;
  if (f.domAny) return dow;
  if (f.dowAny) return dom;
  return dom || dow; // both set → OR (Vixie cron)
}

/**
 * Next fire time STRICTLY after `from` (ms). 0 if the expression is invalid or no longer matches within the
 * next year (e.g. "0 0 30 2 *"). Computed in local time — that is how the CLI understands its expressions, and the
 * server runs in the same time zone context as it.
 */
// Steps of the search, across all calls — a count, not a behavior. Whether the search jumps by day is a step
// count (366 versus 527,000), not a duration, so the test checks the count, never the time.
let steps = 0;
export const cronSteps = () => steps;
export function nextCronAt(expr, from = Date.now()) {
  const f = parseCron(expr);
  if (!f) return 0;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // the running minute is over
  const limit = from + 366 * 24 * 3600_000;
  // Jump by day where the day does not match anyway — otherwise it would be up to 527,000 steps.
  while (d.getTime() <= limit) {
    steps++;
    if (!f.month.has(d.getMonth() + 1) || !dayMatches(f, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!f.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return 0;
}

/**
 * Distance between two fire times (ms) — the basis for the surcharge on the deadline: by its own description the CLI
 * fires recurring jobs up to 10 % of the period late (at most 15 min). 0 if there is no second time.
 */
export function cronPeriodMs(expr, from = Date.now()) {
  const first = nextCronAt(expr, from);
  if (!first) return 0;
  const second = nextCronAt(expr, first);
  return second ? second - first : 0;
}

// ── Time zones: schedules ────────────────────
// The functions above compute in the process's LOCAL time — right for the CLI jobs, which live in the same process
// context. A schedule, by contrast, carries its OWN IANA zone (default: the client's), and the user container runs in UTC.
// "Weekdays at 8" would mean 8 UTC there, i.e. 10 o'clock in Berlin — and 9 in winter. So the wall time is computed via
// Intl in the desired zone; daylight-saving jumps are accounted for (see fromWallClock).

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    dtfCache.set(tz, f);
  }
  return f;
}
/** Is this a zone Intl knows? ("Europe/Berlin" yes, "Berlin" no.) */
export function zoneValid(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try { dtf(tz.trim()); return true; } catch { return false; }
}
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Wall time of a timestamp in the zone: {y,m(1-12),d,H,M,S,dow(0=Sun)}. */
export function wallClock(ms, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const H = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), H, M: Number(parts.minute), S: Number(parts.second), dow: DOW[parts.weekday] ?? new Date(ms).getUTCDay() };
}
/**
 * Timestamp of a wall time in the zone. Iterative: the deviation between desired and actual wall time is added to the
 * candidate; three rounds suffice for any real offset. Daylight-saving special cases: a wall time that does NOT exist (02:30
 * when clocks go forward) yields the moment after; one that exists TWICE (when clocks go back) yields one of the two —
 * for a schedule either is right enough.
 */
export function fromWallClock({ y, m, d, H = 0, M = 0 }, tz) {
  const desired = Date.UTC(y, m - 1, d, H, M, 0, 0);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(guess, tz);
    const actual = Date.UTC(w.y, w.m - 1, w.d, w.H, w.M, 0, 0);
    if (actual === desired) return guess;
    guess += desired - actual;
  }
  return guess;
}
/**
 * Next fire time STRICTLY after `from`, computed in the zone `tz`. Without a zone (or "local") like nextCronAt. 0 for an
 * invalid expression, an unknown zone, or if the expression no longer matches within the next year.
 */
export function nextCronAtZone(expr, from = Date.now(), tz = "") {
  if (!tz || tz === "local") return nextCronAt(expr, from);
  const f = parseCron(expr);
  if (!f || !zoneValid(tz)) return 0;
  let t = Math.floor(from / 60_000) * 60_000 + 60_000; // the running minute is over
  const limit = from + 366 * 24 * 3600_000;
  let guard = 0;
  while (t <= limit && guard++ < 1_000_000) {
    steps++;
    const w = wallClock(t, tz);
    if (!f.month.has(w.m) || !dayMatches(f, { getDate: () => w.d, getDay: () => w.dow })) {
      // Next day, 00:00 wall time. Normalized via Date.UTC (month change, year change).
      const n = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
      const next = fromWallClock({ y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate(), H: 0, M: 0 }, tz);
      t = next > t ? next : t + 3600_000;
      continue;
    }
    if (!f.hour.has(w.H)) {
      const next = fromWallClock({ y: w.y, m: w.m, d: w.d, H: w.H + 1, M: 0 }, tz);
      const nt = next > t ? next : t + 3600_000;
      // Daylight-saving jump: the hour in between does not exist. If IT was meant, the schedule fires in the first
      // moment after — otherwise "30 2 * * *" would be skipped entirely on that day.
      const w2 = wallClock(nt, tz);
      if (w2.d === w.d && w2.H > w.H + 1) {
        for (let h = w.H + 1; h < w2.H; h++) {
          if (f.hour.has(h)) { const m0 = Math.min(...f.minute); return nt + m0 * 60_000; }
        }
      }
      t = nt;
      continue;
    }
    if (!f.minute.has(w.M)) { t += 60_000; continue; }
    return t;
  }
  return 0;
}
/** Distance between two fire times in the zone (ms), 0 if there is no second. */
export function cronPeriodMsZone(expr, from = Date.now(), tz = "") {
  const first = nextCronAtZone(expr, from, tz);
  if (!first) return 0;
  const second = nextCronAtZone(expr, first, tz);
  return second ? second - first : 0;
}
// Weekday abbreviations in the UI language (German from i18n-de.js); a function, so the language is chosen at the call.
const weekdays = () => [T("Sun##weekday"), T("Mon##weekday"), T("Tue##weekday"), T("Wed##weekday"), T("Thu##weekday"), T("Fri##weekday"), T("Sat##weekday")];
/**
 * Wall time in the zone, in the UI language — for chat titles, the schedule block and notifications.
 * English "Thu 03/09/2026 08:00" (day/month like clockText's en-GB), German "Do 03.09.2026 08:00".
 */
export function wallTimeText(ms, tz = "UTC", { withYear = true, withClockTime = true } = {}) {
  const z = zoneValid(tz) ? tz : "UTC";
  const w = wallClock(ms, z);
  const pad = (n) => String(n).padStart(2, "0");
  const sep = getUiLang() === "de" ? "." : "/";
  const date = `${weekdays()[w.dow]} ${pad(w.d)}${sep}${pad(w.m)}${withYear ? `${sep}${w.y}` : ""}`;
  return withClockTime ? `${date} ${pad(w.H)}:${pad(w.M)}` : date;
}
