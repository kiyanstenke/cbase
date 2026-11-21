"use client";

// The building blocks of the subpages of Settings → Usage.
// NOT a page (web/test/settings-form.test.mjs lists the file under NO_PAGE): only shapes that several subpages share —
// the window bar, the token surface, the equivalent with its breakdown, the lists (per model, chat, role) and the
// history per day. Every list is ONE surface with hairlines (`Group` + `Row` from the kit), never a card per row.
//
// What the numbers must NOT claim: a number the server did not send is "—", never 0 (lib/api/usage.ts then delivers
// `null`); an equivalent that does not cover all models says "incomplete"; a day without an amount in the history is
// drawn dashed, not as an empty bar. The history is a plain bar chart without a library: ONE series (no legend — the
// title names it), thin bars with 2 px gap and a rounded end at the baseline, a tooltip per day over the full column height.

import { type ReactNode } from "react";
import { Segments } from "@/components/CbKit";
import { ProgressBar, Group, Ring, Row, type Tone } from "@/components/settings/SettingsKit";
import type { RingWindow } from "@/components/TopNav";
import { dateLocale, useT } from "@/lib/i18n";
import {
  WINDOW_LABEL, WINDOW_SLIDING_LABEL, EQUIVALENT_HINT, roleLabel,
  type ClaudeLimits, type LimitWindow, type UsageChat, type UsageWindow, type UsageBackground, type UsageModel,
  type UsageSums, type HistoryPoint,
} from "@/lib/api";

/** US dollars as everywhere in usage: under 1 four decimals (otherwise token amounts would read "0.00"), else two. */
export function usd(n: number | null | undefined, loc: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const places = n > 0 && n < 1 ? 4 : 2;
  return `$ ${n.toLocaleString(loc, { minimumFractionDigits: places, maximumFractionDigits: places })}`;
}

/** A token count in short form: "1.3M", "48k", "120" — the same shape as every other token display; `null` is "—". */
export function tok(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 999_500) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "").replace(".", ",")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** The sum of known parts — `null` if NONE is known (then the sum is unknown too, not 0). */
export function sumKnown(...values: (number | null | undefined)[]): number | null {
  const present = values.filter((w): w is number => typeof w === "number" && Number.isFinite(w));
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/** "3 min ago" / "2 h ago" / "just now" — for "measured … ago". */
export function beforeText(ms: number, now: number, t: ReturnType<typeof useT>): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 1) return t("just now");
  if (min < 90) return t("{n} min ago", { n: min });
  return t("{n} h ago", { n: Math.round(min / 60) });
}

/**
 * The bar of windows. `known` per window: did the server last say that it knows the REAL window? If NO, the choice reads
 * "Last 5 h"/"Last 7 days" — sliding over the same length; without an answer (undefined) the window's default.
 */
export function WindowBar({ window, value, onChoice, known }: {
  window: readonly UsageWindow[];
  value: UsageWindow;
  onChoice: (f: UsageWindow) => void;
  known?: Partial<Record<UsageWindow, boolean>>;
}) {
  const t = useT();
  const name = (f: UsageWindow) =>
    (f === "session" || f === "week") && known?.[f] === false ? t(WINDOW_SLIDING_LABEL[f]) : t(WINDOW_LABEL[f]);
  return (
    <Segments
      label={t("Time window")}
      items={window.map((f) => ({ key: f, label: name(f), data: { "data-usage-window": f } }))}
      value={value}
      onChange={(k) => onChoice(k as UsageWindow)}
    />
  );
}

/** "since 14:20" (session) or "since Mon 09:00" (week) — only if the server knows the real window. */
export function sinceText(f: UsageWindow, from: number | null, known: boolean, loc: string, t: ReturnType<typeof useT>): string | null {
  if (!known || from === null || (f !== "session" && f !== "week")) return null;
  const d = new Date(from);
  const time = f === "session"
    ? d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(loc, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return t("since {time}", { time: time });
}

/**
 * The equivalent as the main number, below it its breakdown (one row per part with its own bar — a share of the same
 * sum, no color code) and the hint that it is an estimate. `incomplete` as soon as the server does not explicitly call it complete.
 */
export function EquivalentSurface({ sums, under }: { sums: UsageSums | null; under?: ReactNode }) {
  const t = useT();
  const loc = dateLocale();
  const parts = sums?.partsUsd;
  const item: { title: string; value: number | null }[] = [
    { title: t("Input"), value: parts?.input ?? null },
    { title: t("Output"), value: parts?.output ?? null },
    { title: t("Cache read"), value: parts?.cacheRead ?? null },
    { title: t("Cache write"), value: parts?.cacheWrite ?? null },
  ];
  const whole = sumKnown(...item.map((p) => p.value));
  return (
    <Group title={t("API equivalent")} hint={t(EQUIVALENT_HINT)}>
      <div className="px-3.5 py-3" data-usage-equivalent>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[22px] font-semibold tabular-nums tracking-tight">{usd(sums?.equivalentUsd, loc)}</span>
          {sums && !sums.equivalentComplete && <span className="text-[11.5px] text-warn" data-usage-incomplete>{t("incomplete")}</span>}
        </div>
        {under && <div className="mt-0.5 text-[11.5px] text-dim">{under}</div>}
      </div>
      {item.map((p) => (
        <Row key={p.title} title={p.title}>
          <span className="flex w-[180px] items-center gap-2.5">
            <span className="min-w-0 flex-1">{whole && p.value !== null ? <ProgressBar percent={(p.value / whole) * 100} tone="accent" /> : null}</span>
            <span className="w-[76px] shrink-0 text-right text-[12.5px] tabular-nums">{usd(p.value, loc)}</span>
          </span>
        </Row>
      ))}
    </Group>
  );
}

/** The tokens of a window as ONE surface: input · output · cache read · cache write (+ unsplit, only > 0) · runs. */
export function TokenSurface({ sums, subagentsShare }: { sums: UsageSums | null; subagentsShare?: number | null }) {
  const t = useT();
  const loc = dateLocale();
  const full = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Math.round(n).toLocaleString(loc));
  const rows: { title: string; value: string; hint?: string }[] = [
    { title: t("Input"), value: full(sums?.input) },
    { title: t("Output"), value: full(sums?.output) },
    { title: t("Cache read"), value: full(sums?.cacheRead) },
    { title: t("Cache write"), value: full(sums?.cacheWrite) },
  ];
  if ((sums?.cacheUnsplit ?? 0) > 0) {
    rows.push({ title: t("Cache, not split"), value: full(sums?.cacheUnsplit), hint: t("Runs from before reads and writes were split") });
  }
  rows.push({ title: t("runs"), value: full(sums?.runs) });
  return (
    <Group title={t("tokens")}>
      {rows.map((z) => (
        <Row key={z.title} title={z.title} hint={z.hint}>
          <span className="text-[13px] font-semibold tabular-nums">{z.value}</span>
        </Row>
      ))}
      {subagentsShare !== undefined && subagentsShare !== null && (
        <Row title={t("of which subagents")}>
          <span className="flex w-[180px] items-center gap-2.5" data-usage-subagents>
            <span className="min-w-0 flex-1"><ProgressBar percent={subagentsShare * 100} tone="accent" /></span>
            <span className="shrink-0 text-[12.5px] tabular-nums">{t("{pct} % of output", { pct: Math.round(subagentsShare * 100) })}</span>
          </span>
        </Row>
      )}
    </Group>
  );
}

/** The tokens of a list row in one sentence (input · output · cache). */
function tokenSet(z: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; runs?: number | null }, t: ReturnType<typeof useT>): string {
  const parts = [
    `${tok(z.input)} ${t("Input")}`,
    `${tok(z.output)} ${t("Output")}`,
    `${tok(sumKnown(z.cacheRead, z.cacheWrite))} ${t("Cache")}`,
  ];
  if (z.runs !== null && z.runs !== undefined) parts.push(t("{runs} runs", { runs: z.runs }));
  return parts.join(" · ");
}

/** The amount of a row — equivalent (subscription) or cost (OpenRouter). */
type Amount = "equivalent" | "cost";
const amountOf = (z: { equivalentUsd: number | null; costUsd: number | null }, kind: Amount) => (kind === "cost" ? z.costUsd : z.equivalentUsd);

export function ModelList({ models, kind, subline }: {
  models: readonly UsageModel[];
  kind: Amount;
  /** A second row per model (for OpenRouter the price range per provider). */
  subline?: (m: UsageModel) => ReactNode;
}) {
  const t = useT();
  const loc = dateLocale();
  if (!models.length) return null;
  return (
    <Group title={t("By model")}>
      {models.map((m) => (
        <div key={m.model} data-usage-model={m.model}>
          <Row title={<span className="font-medium">{m.model || t("(unknown)")}</span>} hint={<>{tokenSet(m, t)}{subline?.(m)}</>}>
            <span className="text-right text-[12.5px] tabular-nums">
              {kind === "equivalent" && !m.priceKnown ? <span className="text-dim">{t("Price unknown")}</span> : usd(amountOf(m, kind), loc)}
            </span>
          </Row>
        </div>
      ))}
    </Group>
  );
}

export function BackgroundList({ rows, kind }: { rows: readonly UsageBackground[]; kind: Amount }) {
  const t = useT();
  const loc = dateLocale();
  if (!rows.length) return null;
  return (
    <Group title={t("Background tasks")}>
      {rows.map((z) => (
        <div key={z.role} data-usage-role={z.role}>
          <Row title={t(roleLabel(z.role))} hint={tokenSet(z, t)}>
            <span className="text-right text-[12.5px] tabular-nums">{usd(amountOf(z, kind), loc)}</span>
          </Row>
        </div>
      ))}
    </Group>
  );
}

/** The chats of a window — at most 25; what is missing is told by the last row ("N more"), never cut silently. */
export function ChatList({ chats, additional, kind }: { chats: readonly UsageChat[]; additional: number | null; kind: Amount }) {
  const t = useT();
  const loc = dateLocale();
  if (!chats.length) return null;
  return (
    <Group title={t("By chat")}>
      {chats.map((c) => (
        <div key={c.chatId} data-usage-chat={c.chatId}>
          <Row
            title={<span className={`font-medium ${c.deleted ? "text-dim line-through" : ""}`} title={c.title || c.chatId}>{c.title || t("(untitled)")}</span>}
            hint={c.deleted ? `${t("deleted")} · ${tokenSet(c, t)}` : tokenSet(c, t)}
          >
            <span className="text-right text-[12.5px] tabular-nums">{usd(amountOf(c, kind), loc)}</span>
          </Row>
        </div>
      ))}
      {additional !== null && additional > 0 && (
        <div data-usage-chats-additional={additional}>
          <Row title={<span className="text-dim">{t("and {n} more", { n: additional })}</span>} />
        </div>
      )}
    </Group>
  );
}

/**
 * The history per day as bars (one series). `value` reads the amount of a day; a day without an amount (`null`) is drawn
 * dashed. Axis: only the baseline and three day marks (first, middle, last) — the rest is in the tooltip per bar.
 */
export function HistoryProgressBar({ title, points, value, format }: {
  title: string;
  points: readonly HistoryPoint[];
  value: (p: HistoryPoint) => number | null;
  format: (n: number | null) => string;
}) {
  const t = useT();
  const loc = dateLocale();
  if (!points.length) return null;
  const values = points.map(value);
  const max = Math.max(0, ...values.filter((w): w is number => w !== null));
  const dayText = (day: string) => {
    const d = new Date(`${day}T12:00:00`);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit" }) : day;
  };
  const middle = points[Math.floor((points.length - 1) / 2)];
  return (
    <Group title={title}>
      <div className="px-3.5 pb-2.5 pt-3" data-usage-history role="img" aria-label={`${title}: ${points.map((p, i) => `${dayText(p.day)} ${format(values[i])}`).join(", ")}`}>
        <div className="flex h-[96px] items-end gap-[2px] border-b border-edge">
          {points.map((p, i) => {
            const w = values[i];
            const height = w === null ? 0 : max > 0 ? Math.max(w > 0 ? 2 : 0, (w / max) * 100) : 0;
            return (
              <div key={p.day} className="group flex h-full min-w-0 flex-1 items-end" title={`${dayText(p.day)} · ${format(w)}`} data-usage-day={p.day}>
                {w === null
                  ? <div className="h-[6px] w-full rounded-t-[4px] border border-dashed border-dim/50" />
                  : <div className="w-full rounded-t-[4px] bg-accent/80 transition-colors group-hover:bg-accent" style={{ height: `${height}%` }} />}
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between whitespace-nowrap text-[10.5px] tabular-nums text-dim">
          <span>{dayText(points[0].day)}</span>
          {points.length > 2 && <span>{dayText(middle.day)}</span>}
          {points.length > 1 && <span>{dayText(points[points.length - 1].day)}</span>}
        </div>
        {max > 0 && <div className="mt-0.5 text-[11px] text-dim">{t("Highest day: {value}", { value: format(max) })}</div>}
      </div>
    </Group>
  );
}

// ── Quotas (rings) ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Claude from `/api/usage/claude-limits` (the stored snapshot — no fetch, no `claude doctor`), Codex from
// `/api/usage/codex` (the local rate-limit snapshot of the rollouts). A credit pot (`group: "credits"`) is NOT a window:
// its 100 mean "not open", not "used up" — treated as a window it would win the ring.

/** A quota window as card and list draw it: `used` in percent, `resetsAt` in ms. */
export type QuotaWindow = { key: string; label: string; used: number; resetsAt: number | null };

/** The name of a Claude window: scope (model name) before group; credits and spend cap have no time window. */
export function limitName(f: LimitWindow, t: ReturnType<typeof useT>): string {
  if (f.group === "credits") return t("Credits");
  if (f.group === "spend") return t("Spend limit");
  if (f.area) return t("{name} limit", { name: f.area });
  return f.group === "weekly" ? t("7-day limit") : t("5-hour limit");
}

export function claudeWindow(l: ClaudeLimits | null, t: ReturnType<typeof useT>): QuotaWindow[] {
  return (l?.window ?? [])
    .filter((f) => f.group !== "credits" && f.percent !== null)
    .map((f) => ({ key: f.id, label: limitName(f, t), used: f.percent as number, resetsAt: f.resetsAt }));
}

export type CodexWindowRaw = { usedPercent: number | null; windowMinutes: number | null; resetsAt: string | null };
/** The response of `/api/usage/codex`, as far as usage reads it. */
export type CodexState = {
  connected: boolean;
  primary?: CodexWindowRaw | null;
  secondary?: CodexWindowRaw | null;
  planType?: string;
  // The same type as in the header's ring — the response is the same route. The edge is `import type` and thus none at
  // runtime (web/test/import-cycles.test.mjs holds exactly that at this place: TopNav → SettingsModal → UsageSettings →
  // UsageKit → TopNav is closed only through types).
  ring?: RingWindow | null;
};

export function codexWindow(c: CodexState | null, t: ReturnType<typeof useT>): QuotaWindow[] {
  if (!c?.connected) return [];
  const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || null : null);
  const out: QuotaWindow[] = [];
  if (c.primary?.usedPercent != null) out.push({ key: "primary", label: t("Short window"), used: c.primary.usedPercent, resetsAt: ms(c.primary.resetsAt) });
  if (c.secondary?.usedPercent != null) out.push({ key: "secondary", label: t("Long window"), used: c.secondary.usedPercent, resetsAt: ms(c.secondary.resetsAt) });
  // At the limit the Codex CLI sometimes delivers NO window at all — then `ring` carries the state alone.
  if (!out.length && c.ring && c.ring.group !== "credits") {
    const r = c.ring;
    const label = r.group === "spend" ? t("Spend limit") : r.scope ? t("{name} limit", { name: r.scope }) : r.group === "weekly" ? t("7-day limit") : t("5-hour limit");
    out.push({ key: "ring", label, used: r.percent, resetsAt: ms(r.resetsAt) });
  }
  return out;
}

/** The ring shows the REMAINDER, the color follows the CONSUMPTION (8% left is red) — thresholds of the kit (70/90). */
export const restTone = (used: number): Tone => (used >= 90 ? "danger" : used >= 70 ? "warn" : "accent");

export const resetText = (ms: number | null, loc: string) =>
  ms !== null ? new Date(ms).toLocaleString(loc, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;

/** A window as a row: name, remainder, bar, reset. */
export function WindowRow({ f }: { f: QuotaWindow }) {
  const t = useT();
  const loc = dateLocale();
  const rest = Math.round(100 - Math.max(0, Math.min(100, f.used)));
  const reset = resetText(f.resetsAt, loc);
  return (
    <div className="mt-3" data-usage-limit={f.key}>
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="min-w-0 truncate text-dim">{f.label}</span>
        <span className="shrink-0 font-semibold tabular-nums">{t("{rem} % left", { rem: rest })}</span>
      </div>
      <div className="mt-1.5"><ProgressBar percent={f.used} /></div>
      {reset && <div className="mt-1 text-[11px] text-dim">{t("resets {reset}", { reset })}</div>}
    </div>
  );
}

/**
 * The card of a subscription provider: mark, ring with the remainder of the BINDING window (the fullest — the question is
 * "when is it over"), the others as bars below. `onOpen` makes the header a jump into the subpage.
 */
export function SubscriptionCard({ marker, name, window, empty, bottom, onOpen }: {
  marker: ReactNode;
  name: string;
  window: QuotaWindow[];
  empty: ReactNode;
  bottom?: ReactNode;
  onOpen?: () => void;
}) {
  const t = useT();
  const loc = dateLocale();
  const binding = window.length ? window.reduce((a, b) => (b.used > a.used ? b : a)) : null;
  const additional = binding ? window.filter((f) => f !== binding) : [];
  const reset = binding ? resetText(binding.resetsAt, loc) : null;
  return (
    <div className="cb-kit-pane rounded-2xl p-4" data-usage-card={name}>
      <button type="button" onClick={onOpen} disabled={!onOpen} className="flex w-full items-center justify-between gap-2 rounded-lg text-left enabled:hover:opacity-80">
        <span className="flex min-w-0 items-center gap-2">{marker}<span className="truncate text-[13.5px] font-semibold">{name}</span></span>
        <span className="shrink-0 rounded-full bg-panel px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-dim">{t("Plan##subscription")}</span>
      </button>
      {binding ? (
        <>
          <div className="mt-3 flex items-center gap-3.5">
            <Ring percent={100 - binding.used} tone={restTone(binding.used)} label={t("left")} size={52} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium leading-snug">{binding.label}</div>
              {reset && <div className="mt-0.5 text-[11.5px] text-dim">{t("resets {reset}", { reset })}</div>}
            </div>
          </div>
          {additional.map((f) => <WindowRow key={f.key} f={f} />)}
        </>
      ) : (
        <div className="mt-3 text-[12.5px] text-dim">{empty}</div>
      )}
      {bottom}
    </div>
  );
}
