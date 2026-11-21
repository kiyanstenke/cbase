import { API_BASE } from "./api/core.js";
import { dateLocale } from "./i18n.js";

const attUrl = (chatId: string, file: string) => `${API_BASE}/api/chats/${chatId}/attachments/${encodeURIComponent(file)}`;

const fmtSize = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);

const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

// Time of day “14:32” in the UI language.
const clockTime = (ms: number) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

// `wallTimeIso`: “2026-09-04T09:00” in the zone: the form the datetime-local field and the server take. No imports.
function wallTimeIso(ms: number, tz: string) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  } catch { return ""; }
}
/** “in 5 min”, “in 2 h 10 min”, “in 3 days”, or “due”: the number one looks for in the list; also used for the next runs in overviews. */
function relative(ms: number, now: number, t: (s: string, p?: Record<string, string | number>) => string) {
  const d = ms - now;
  if (d <= 0) return t("due");
  const min = Math.round(d / 60_000);
  if (min < 60) return t("in {n} min", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("in {h} h {m} min", { h, m: min % 60 });
  const days = Math.round(h / 24);
  return t("in {n} days", { n: days });
}
export { attUrl, clockTime, fmtDur, fmtSize, relative, wallTimeIso };
