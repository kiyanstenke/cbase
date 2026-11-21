// The hover card of a commit in the graph of the git bar (shows the info as VS Code does and the dot in the graph grows slightly) — the
// PURE calculations: the relative time and the full date in the language of the UI, what the card shows (the server's answer or, without
// it, what the graph already knows), the numbers line ("1 file changed, 92 insertions(+), 79 deletions(−)") with singular and plural, the
// position of the card against the bar and the window edge, and the timers of hovering. Drawn in components/git-bar/CommitCard.tsx.
//
// A LEAF module without imports (web/test/git-graph.test.mjs transpiles it alone and runs it) — the shapes of the inputs are therefore
// their own narrow types here; lib/api/git.ts `GitGraphEntry` and `GitCommitInfo` fit in.
//
// NOT here: there was no helper for "10 months ago" yet — lib/chat-format.ts `relative` counts forward ("in 3 days", scheduled),
// lib/git-view-time.ts `shortAge` is the short form of the git overview ("9 d"), the server writes "vor 3 Mon." only in German
// (git.js relativeDe). The card needs the long form in both languages — `Intl.RelativeTimeFormat`, steps like VS Code `fromNow`.

// ── The timers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** How long the pointer rests on a row until the card comes — only THEN is the server asked (a quick move over many rows asks
 *  nothing). */
export const CARD_DWELL_MS = 400;
/** If a card is open (or just gone, CARD_WARM_MS), the next row's card comes faster — like VS Code, which shows the next card after one
 *  without the full delay; short enough that a move over the list still does not ask per row. */
export const CARD_SWITCH_MS = 150;
export const CARD_WARM_MS = 300;
/** How long the card stays after leaving the row — time to move the mouse into it (to copy the hash). */
export const CARD_GRACE_MS = 250;
/** How long a card waits for its answer after the dwell before it comes with what the graph knows (otherwise it would visibly grow). */
export const CARD_WAIT_MS = 250;
/** How long "Copied" stays on the button. */
export const CARD_COPIED_MS = 1500;

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;
/** "10 months ago" — the steps like VS Code (`fromNow`): seconds, minutes, hours, days, weeks, months (30 days), years (365 days),
 *  rounded down; under 30 seconds "now". A time in the future (the author's clock ran ahead) reads "in …". */
export function relativeTime(ms: number, now: number, locale: string): string {
  const d = now - ms;
  const a = Math.abs(d);
  if (a < 30 * SEC) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] =
    a < MIN ? [a / SEC, "second"] : a < HOUR ? [a / MIN, "minute"] : a < DAY ? [a / HOUR, "hour"] : a < WEEK ? [a / DAY, "day"]
      : a < MONTH ? [a / WEEK, "week"] : a < YEAR ? [a / MONTH, "month"] : [a / YEAR, "year"];
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format((d >= 0 ? -1 : 1) * Math.floor(n), unit);
}
/** "December 15, 2025 at 2:32 PM" — as in VS Code (year, month long, day, hour, minute). `zone` only for tests (without it the
 *  device's). */
export function fullDate(ms: number, locale: string, zone?: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) }).format(new Date(ms));
}

// ── What the card shows ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CardCommit { hash: string; short: string; subject: string; author: string; time: number | null; parents: readonly string[] | null }
export interface CardCounts { files: number; plus: number; minus: number; binary: number }
export interface CardInfo {
  hash: string; parent: readonly string[] | null; author: string; email: string | null; time: number | null; message: string;
  messageClipped: boolean | null; counts: CardCounts | null; countsClipped: boolean | null;
}
export interface CardData {
  hash: string; short: string; author: string; email: string | null;
  /** ms; null = unknown (then no time in the card). */
  time: number | null;
  message: string; messageClipped: boolean;
  /** null = unknown: NO numbers line (never "0 files changed"). */
  counts: CardCounts | null;
  countsClipped: boolean;
  /** A merge counts against the FIRST parent — the line says so. */
  merge: boolean;
}
/** The server's answer (`info`, only if it belongs to THIS commit) or, without it, what the graph already knows: author, commit time
 *  (the line carries %ct in seconds), subject, hash — and no numbers. */
export function cardsData(c: CardCommit, info: CardInfo | null): CardData {
  const i = info && info.hash.startsWith(c.hash) ? info : null;
  const parent = i?.parent ?? c.parents ?? null;
  return {
    hash: c.hash,
    short: c.short || c.hash.slice(0, 8),
    author: i?.author || c.author,
    email: i?.email ?? null,
    time: i?.time ?? (c.time ? c.time * 1000 : null),
    message: i ? i.message || c.subject : c.subject,
    messageClipped: i?.messageClipped === true,
    counts: i?.counts ?? null,
    countsClipped: i?.countsClipped === true,
    merge: (parent?.length ?? 0) > 1,
  };
}

// ── The numbers line ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// As in VS Code (and git --shortstat): the files always, insertions and deletions only if there are any. DEVIATION: binary files are
// included ("2 files changed (1 binary)") — they have no lines, and without the addition a changed image would read like a file without
// change. The keys are English UI strings (i18n-de.ts translates them, the test holds both languages); `before` is the separator to the
// previous part, `tone` the color role (insertions like "A" green, deletions like "D" red — lib/git-files.ts KIND_COLOR).
export type CountsTone = "files" | "binary" | "plus" | "minus";
export interface CountsPart { key: string; n: number; tone: CountsTone; before: string }
export function countsParts(z: CardCounts): CountsPart[] {
  if (z.files === 0) return [{ key: "No files changed.", n: 0, tone: "files", before: "" }];
  const parts: CountsPart[] = [{ key: z.files === 1 ? "{n} file changed" : "{n} files changed", n: z.files, tone: "files", before: "" }];
  if (z.binary > 0) parts.push({ key: "({n} binary)", n: z.binary, tone: "binary", before: " " });
  if (z.plus > 0) parts.push({ key: z.plus === 1 ? "{n} insertion(+)" : "{n} insertions(+)", n: z.plus, tone: "plus", before: ", " });
  if (z.minus > 0) parts.push({ key: z.minus === 1 ? "{n} deletion(−)" : "{n} deletions(−)", n: z.minus, tone: "minus", before: ", " });
  return parts;
}
/** The line as text (title, read aloud) — `t` is the UI translation. */
export function countsText(parts: readonly CountsPart[], t: (s: string, p?: Record<string, string | number>) => string): string {
  return parts.map((x) => `${x.before}${t(x.key, { n: x.n })}`).join("");
}

// ── The position ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// As in VS Code: to the LEFT of the bar, top aligned with the hovered row (kept inside the window — a row at the bottom of the window
// pushes the card up). If there is not enough room on the left (narrow window), it sits below the row, otherwise above, right aligned
// with the bar; if it fits nowhere completely, where there is more room, and kept inside the window. Never out of the window (margin
// `margin`), never wider than it.
export interface Box { left: number; top: number; right: number; bottom: number }
export interface CardsSituation { left: number; top: number; width: number; maxHeight: number; page: "left" | "bottom" | "top" }
export function cardsSituation(row: Box, bar: Box, card: { w: number; h: number }, window: { w: number; h: number }, margin = 8, gap = 6): CardsSituation {
  const width = Math.max(0, Math.min(card.w, window.w - 2 * margin));
  const maxHeight = Math.max(0, window.h - 2 * margin);
  const h = Math.min(card.h, maxHeight);
  const holdX = (x: number) => Math.max(margin, Math.min(x, window.w - margin - width));
  const holdY = (y: number) => Math.max(margin, Math.min(y, window.h - margin - h));
  const left = bar.left - gap - width;
  if (left >= margin) return { left, top: holdY(row.top), width, maxHeight, page: "left" };
  const x = holdX(bar.right - width);
  const bottom = row.bottom + gap;
  if (bottom + h <= window.h - margin) return { left: x, top: bottom, width, maxHeight, page: "bottom" };
  const top = row.top - gap - h;
  if (top >= margin) return { left: x, top: top, width, maxHeight, page: "top" };
  const moreBelow = window.h - row.bottom >= row.top;
  return { left: x, top: holdY(moreBelow ? bottom : top), width, maxHeight, page: moreBelow ? "bottom" : "top" };
}
