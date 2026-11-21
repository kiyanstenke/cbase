// The shape of the timeline: kind → symbol and word ONCE here (`KIND_FORM`), plus the small computations that list and
// row share — day dividers (wall time of the browser), clock time, the word of the citation, the short anchor. Symbols
// in the stroke of the coding pages (CbKit `symbol`, 1.8, round ends), no emojis.
import { symbol } from "@/components/CbKit";
import { dateLocale } from "@/lib/i18n";
import type { TimelineAnchor, TimelineKind, TimelineEvent, TimelineCitation } from "@/lib/api";

type Symbol = (s?: number) => React.ReactNode;

/** The mark of the timeline itself (tab of the project view, section of the right chat rail): a vertical line with three
 *  dots and a stroke beside each. */
export const TIMELINE_SYMBOL: Symbol = (s) => symbol(<>
  <path d="M6 3v18" /><circle cx="6" cy="6" r="1.8" /><circle cx="6" cy="12" r="1.8" /><circle cx="6" cy="18" r="1.8" />
  <path d="M11 6h9" /><path d="M11 12h7" /><path d="M11 18h8" />
</>, s);

/** Per kind word (English key for `t`) and symbol — the ONE table. */
export const KIND_FORM: Record<TimelineKind, { word: string; icon: Symbol }> = {
  // Angle brackets with a slash — code.
  code: { word: "Code", icon: (s) => symbol(<><path d="m8 7-5 5 5 5" /><path d="m16 7 5 5-5 5" /><path d="m13.5 5-3 14" /></>, s) },
  // A branch — git.
  git: { word: "Git", icon: (s) => symbol(<><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6.5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10" /><path d="M18 8.5a6 6 0 0 1-6 6H6" /></>, s) },
  // A flask — a test.
  test: { word: "Test", icon: (s) => symbol(<><path d="M9 3h6" /><path d="M10 3v6.5L4.8 18.2A1.8 1.8 0 0 0 6.4 21h11.2a1.8 1.8 0 0 0 1.6-2.8L14 9.5V3" /><path d="M7.5 15h9" /></>, s) },
  // A speech bubble — communication.
  communication: { word: "Communication", icon: (s) => symbol(<path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 3.5v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" />, s) },
  // Two server slots — operations.
  ops: { word: "Operations", icon: (s) => symbol(<><rect x="3.5" y="4" width="17" height="7" rx="1.8" /><rect x="3.5" y="13" width="17" height="7" rx="1.8" /><path d="M7.5 7.5h.01" /><path d="M7.5 16.5h.01" /></>, s) },
  // A circle with a dot — other.
  other: { word: "Other", icon: (s) => symbol(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="1.6" /></>, s) },
};

/** A subagent as origin of the citation: `subagent:<id>` → the id, else null. */
export const subagentOf = (f: TimelineCitation): string | null => (f.from.startsWith("subagent:") ? f.from.slice(9) || null : null);

/** The word of the citation (English key for `t`): executed (tool call) · reported (message). */
export const citationWord = (f: TimelineCitation): string =>
  f.kind === "tool" ? "executed" : "reported";

/** The anchor in short: branch, SHA (8), MR (!n) — empty ⇒ []. */
export function anchorParts(a: TimelineAnchor | null): string[] {
  if (!a) return [];
  const parts: string[] = [];
  if (a.branch) parts.push(a.branch);
  if (a.sha) parts.push(a.sha.slice(0, 8));
  if (a.mrIid != null) parts.push(`!${a.mrIid}`);
  return parts;
}

/** The calendar day in the browser's wall time (key of the day dividers). */
const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** The events (newest first) grouped by calendar day — the order stays. */
export function byDays(list: readonly TimelineEvent[]): { day: string; at: number; events: TimelineEvent[] }[] {
  const groups: { day: string; at: number; events: TimelineEvent[] }[] = [];
  for (const e of list) {
    const day = dayKey(e.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(e);
    else groups.push({ day, at: e.at, events: [e] });
  }
  return groups;
}

/** The word of the day divider: "Today", "Yesterday" (key for `t`) or the date with weekday. */
export function dayWord(at: number, t: (k: string) => string, now = Date.now()): string {
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1); // a calendar day is not 24 h
  if (dayKey(at) === dayKey(now)) return t("Today");
  if (dayKey(at) === dayKey(yesterday.getTime())) return t("Yesterday");
  const d = new Date(at);
  return d.toLocaleDateString(dateLocale(), {
    weekday: "short", day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

/** Date and time in full ("7 November 2026, 14:05") — the header of the card. */
export const timeFull = (at: number): string =>
  new Date(at).toLocaleString(dateLocale(), { weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
