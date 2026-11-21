"use client";

import { useEffect, useRef, useState } from "react";
import { loadAutocompact, saveAutocompact, type AutocompactDoc } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { markerOnDenominator } from "@/lib/context-display";
import { Group, Row } from "@/components/settings/SettingsKit";

// Auto-compact — the UI for the rule in autocompact.js (server).
//
// TWO peer triggers, compaction happens at the earlier one: a share of the context window and an absolute cap in tokens. Both
// exist on two levels — a global default (Settings → Models) and a THREE-VALUED value per chat (Default · Off · Stage) in the
// menu on the context bar. "Default" is the absence of a value (null), never a stored number: that way every chat nobody
// touched follows a changed default by itself.
//
// Both controls are SELECT LISTS. One row per stage reads like an action; it is ONE value on a scale, and the select list is
// the form for that.
//
// The stages come from the server; the numbers here only serve as a fallback until it answers.

export const AUTOCOMPACT_EVENT = "cbase-autocompact";
// Exported for the workflow settings (tab "Context"): the same selection with the same fallback stages as on the chat — a
// second version would drift apart.
export const STAGES_FALLBACK = [30, 40, 50, 60, 70, 80, 90];
export const MAX_FALLBACK = Array.from({ length: 20 }, (_, i) => (i + 1) * 50_000);

// ONE fetch for all readers (context bars, settings); the settings page announces a change via the event, then everyone
// re-reads.
let cache: Promise<AutocompactDoc> | null = null;
export function useAutocompactGlobal(): AutocompactDoc | null {
  const [doc, setDoc] = useState<AutocompactDoc | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      cache ??= loadAutocompact();
      cache.then((d) => { if (alive) setDoc(d); }).catch(() => { cache = null; });
    };
    load();
    const fresh = () => { cache = null; load(); };
    window.addEventListener(AUTOCOMPACT_EVENT, fresh);
    return () => { alive = false; window.removeEventListener(AUTOCOMPACT_EVENT, fresh); };
  }, []);
  return doc;
}

// What holds for this chat: its own choice, else the global one. 0 = off.
export function effectiveStage(chatValue: number | null | undefined, global: AutocompactDoc | null): number {
  if (typeof chatValue === "number") return chatValue;
  return global?.percent ?? 0;
}
export function effectiveCap(chatMax: number | null | undefined, global: AutocompactDoc | null): number {
  if (typeof chatMax === "number") return chatMax;
  return global?.maxTokens ?? 0;
}

// Short form for token counts: "350k". The same spelling as in the context bar. From 999,500 in millions ("1M", "1.3M")
// instead of "1000k" — like all token displays.
export const tokenText = (n: number) => (n >= 999_500 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "").replace(".", ",")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * The hint row in the auto menu while a workflow run is open that carries its OWN compaction values. `null` = the workflow
 * follows the default (then the chat's choice applies and there is nothing to say — the caller does not show the row).
 */
export function workflowCompactionHint(
  v: { percent: number | null; max: number | null },
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  if (v.percent === 0 && v.max === 0) return t("While the workflow runs, nothing is compacted automatically. Your choice here applies again afterwards.");
  const value = (n: number | null, form: (n: number) => string) => (n === null ? t("as the chat") : n === 0 ? t("off") : form(n));
  return t("While the workflow runs: share {share}, at the latest at {max}. Your choice here applies again afterwards.", {
    share: value(v.percent, (n) => `${n} %`),
    max: value(v.max, tokenText),
  });
}

// Where the threshold really lies, as a share of the window in percent — the earlier of the two triggers. The same computation
// as `threshold()` in autocompact.js; it stands here a second time because the marker would otherwise draw a number at which
// no compaction happens. 0 = no marker.
export function thresholdsShare(
  chatValue: number | null | undefined,
  chatMax: number | null | undefined,
  global: AutocompactDoc | null,
  window: number,
): number {
  const p = effectiveStage(chatValue, global);
  const max = effectiveCap(chatMax, global);
  const fromShare = p > 0 ? p : 0;
  const fromCap = max > 0 && window > 0 ? (max / window) * 100 : 0;
  if (fromShare && fromCap) return Math.min(fromShare, fromCap);
  return fromShare || fromCap;
}

// The menu's label: the EFFECTIVE point. "Auto 60 %" beside a marker at 35 % would be a number contradicting the picture — and
// "Auto off" with a cap set was exactly the bug that left a 652k chat uncompacted.
export function thresholdsText(
  chatValue: number | null | undefined,
  chatMax: number | null | undefined,
  global: AutocompactDoc | null,
  window: number,
  fallback: string,
): string {
  const p = effectiveStage(chatValue, global);
  const max = effectiveCap(chatMax, global);
  if (!p && !max) return fallback;
  const share = thresholdsShare(chatValue, chatMax, global, window);
// If the cap bites earlier (or there is no share at all), the token count shows.
  if (max > 0 && (!p || (window > 0 && share < p - 0.5))) return tokenText(max);
  return `${p} %`;
}

const AutoIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 12a8 8 0 0 1 13.7-5.7" />
    <path d="M20 12a8 8 0 0 1-13.7 5.7" />
    <path d="M18 3v4h-4" />
    <path d="M6 21v-4h4" />
  </svg>
);

// The marker on the context track: where the threshold lies. The track must be `relative`. `window` is this chat's context
// window — without it the cap cannot be converted into a share, then the marker sits at the plain share.
export function ThresholdsMarker({ chatValue, chatMax, window = 0, threshold = 0, denominator = 0 }: {
  chatValue: number | null | undefined;
  chatMax: number | null | undefined;
  window?: number;
  /**
   * The denominator the bar DRAWS on: the window of the provider of the last answer if known — else `window`. The threshold
   * itself still computes with `window` (the catalog number, which is what the server computes with); here it is only
   * POSITIONED on the displayed denominator (`markerOnDenominator`). `data-threshold` stays the share of the catalog.
   */
  denominator?: number;
  /**
   * The threshold in TOKENS, computed by the server. Whoever passes it skips the computation here — an extraction follows a
   * rule of its own (300k, clamped to 80 % of the window, no global value), and keeping that a second time in the client would
   * mean keeping it correct twice.
   */
  threshold?: number;
}) {
  const global = useAutocompactGlobal();
  const share = threshold > 0
    ? (window > 0 ? Math.min(100, (threshold / window) * 100) : 0)
    : thresholdsShare(chatValue, chatMax, global, window);
  if (!share) return null;
  const pos = markerOnDenominator(share / 100, window, denominator || window) * 100;
  return (
    <span
      aria-hidden
      data-threshold={Math.round(share * 10) / 10}
      className="absolute -top-[2px] -bottom-[2px] w-px bg-dim/70"
      style={{ left: `${Math.min(100, Math.max(0, pos))}%` }}
    />
  );
}

// A three-valued select list (Default · Off · Stages). The default entry names the value it currently follows — else one has
// to open the settings to know what it means.
export const CHOICE_CLASS =
  "w-[142px] shrink-0 cursor-pointer rounded-lg border border-edge bg-panel py-1 pl-2 pr-1 text-[12px] text-fg outline-none transition-colors hover:bg-hover focus:border-accent disabled:opacity-50";
export function Choice({ value, stages, text, standardText, onSelect, label, identifier, disabled = false }: {
  value: number | null | undefined;
  stages: number[];
  text: (n: number) => string;
  standardText: string;
  onSelect: (value: number | null) => void;
  label: string;
  identifier: string;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <select
      value={typeof value === "number" ? String(value) : ""}
      onChange={(e) => onSelect(e.target.value === "" ? null : Number(e.target.value))}
      disabled={disabled}
      aria-label={label}
      data-autocompact-choice={identifier}
      className={CHOICE_CLASS}
    >
      <option value="">{t("Default")} · {standardText}</option>
      <option value="0">{t("Off")}</option>
      {stages.map((s) => <option key={s} value={String(s)}>{text(s)}</option>)}
    </select>
  );
}

// The menu on a chat's context bar. Opens UPWARD — the bar sits at the bottom. Click-outside via `contains`, like the Kit's
// other floating windows; it hangs on none of the chats' `data-pop` listeners.
export function AutocompactMenu({
  chatValue, chatMax, onSelect, onSelectMax, disabled = false, window = 0, workflowHint = null,
}: {
  chatValue: number | null | undefined;
  chatMax: number | null | undefined;
  onSelect: (value: number | null) => void | Promise<void>;
  onSelectMax: (value: number | null) => void | Promise<void>;
  disabled?: boolean;
  window?: number;
  /**
   * A text row at the top of the menu while a workflow run with its own compaction is open: its values currently take
   * precedence over the chat's. The choice here stays changeable and applies after the run. `null` = no row.
   */
  workflowHint?: string | null;
}) {
  const t = useT();
  const global = useAutocompactGlobal();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const beside = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", beside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", beside); document.removeEventListener("keydown", esc); };
  }, [open]);

  const own = typeof chatValue === "number" || typeof chatMax === "number";
  const eff = effectiveStage(chatValue, global);
  const stages = global?.stages ?? STAGES_FALLBACK;
  const maxStages = global?.maxStages ?? MAX_FALLBACK;
  // Shows the EFFECTIVE point: on 1M models the cap usually bites, not the share.
  const text = thresholdsText(chatValue, chatMax, global, window, t("off"));
  const globalPercent = global?.percent ?? 0;
  const globalMax = global?.maxTokens ?? 0;
  const fullyOff = chatValue === 0 && chatMax === 0;

  return (
    <div ref={root} className="relative shrink-0" data-autocompact>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        data-autocompact-value={eff}
        data-autocompact-text={text}
        title={t("Auto-compact — when cbase summarizes the history on its own and continues with a fresh session. Two marks: a share of the context window and a cap in tokens; compaction happens at whichever comes first. Applies to this chat; “Standard” follows the settings.")}
        className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
      >
        <AutoIcon />
        {t("Auto")} {text}
        {/* A dot says: an OWN choice applies here, not the default. */}
        {own && <span aria-hidden className="ml-0.5 h-1 w-1 rounded-full bg-accent" />}
      </button>
      {open && (
        <div role="menu" className="cb-pop-in-fast absolute bottom-full right-0 z-40 mb-1 w-[300px] origin-bottom-right cb-pop overflow-hidden rounded-xl py-1.5 text-fg">
          <div className="px-3 pb-0.5 text-[10.5px] font-medium uppercase tracking-wider text-dim">{t("Auto-compact")}</div>
          {workflowHint && (
            <div data-autocompact-workflow className="mx-3 mb-1.5 rounded-lg bg-accent/10 px-2 py-1.5 text-[11px] leading-snug text-fg">{workflowHint}</div>
          )}
          <div className="px-3 pb-2 text-[11px] leading-snug text-dim">
            {t("Compaction happens at whichever point comes first.")}
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-1">
            <span className="min-w-0 text-[12.5px]">{t("Share of the window")}</span>
            <Choice
              value={chatValue}
              stages={stages}
              text={(s) => `${s} %`}
              standardText={globalPercent > 0 ? `${globalPercent} %` : t("off")}
              onSelect={(w) => { setOpen(false); void onSelect(w); }}
              label={t("Share of the window")}
              identifier="percent"
            />
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-1">
            <span className="min-w-0 text-[12.5px]">{t("No later than")}</span>
            <Choice
              value={chatMax}
              stages={maxStages}
              text={tokenText}
              standardText={globalMax > 0 ? tokenText(globalMax) : t("off")}
              onSelect={(w) => { setOpen(false); void onSelectMax(w); }}
              label={t("No later than")}
              identifier="max"
            />
          </div>
          {/* Two controls mean two moves for "not at all" and "like everywhere again" — the two cases one really wants with one
              click. */}
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-edge px-3 pb-0.5 pt-1.5">
            <button
              type="button"
              data-autocompact-whole-from
              disabled={fullyOff}
              onClick={() => { setOpen(false); void onSelect(0); void onSelectMax(0); }}
              className="rounded-md px-1.5 py-0.5 text-[11.5px] text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {t("Off for this chat")}
            </button>
            <button
              type="button"
              data-autocompact-standard
              disabled={!own}
              onClick={() => { setOpen(false); void onSelect(null); void onSelectMax(null); }}
              className="rounded-md px-1.5 py-0.5 text-[11.5px] text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {t("Reset to standard")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The section in the settings (Models): the two global markers, one select list each.
export function AutocompactSetting() {
  const t = useT();
  const global = useAutocompactGlobal();
  const [error, setError] = useState("");
  const [value, setValue] = useState<number | null>(null);
  const [max, setMax] = useState<number | null>(null);
  useEffect(() => { if (global) { setValue(global.percent); setMax(global.maxTokens); } }, [global]);
  const stages = global?.stages ?? STAGES_FALLBACK;
  const maxStages = global?.maxStages ?? MAX_FALLBACK;
  // ONE save path for both controls: set visibly at once, roll back on error.
  const save = async (
    field: "percent" | "maxTokens",
    n: number,
    set: (v: number | null) => void,
    prior: number | null,
  ) => {
    set(n); // visible at once, like the color scheme
    try {
      await saveAutocompact({ [field]: n });
      setError("");
      cache = null;
      window.dispatchEvent(new Event(AUTOCOMPACT_EVENT));
    } catch (e) {
      set(prior);
      setError(String((e as Error).message || e));
    }
  };
  // Both controls are SELECT LISTS: seven or twenty stages are not seven or twenty actions but a value on a scale — and two
  // differently built controls side by side would look like two different kinds of rule.
  const queue = (
    title: string, set: string, identifier: string, choice: number | null,
    stagesList: number[], text: (n: number) => string, field: "percent" | "maxTokens",
    setChoice: (v: number | null) => void,
  ) => (
    <Row key={identifier} title={title} hint={set}>
      <select
        value={choice === null ? "" : String(choice)}
        onChange={(e) => save(field, Number(e.target.value), setChoice, choice)}
        disabled={choice === null}
        aria-label={title}
        data-autocompact-global={identifier}
        className="w-[150px] shrink-0 cursor-pointer rounded-xl border border-edge bg-panel px-3 py-2 text-[12.5px] outline-none transition-colors hover:bg-hover disabled:opacity-50"
      >
        <option value="0">{t("Off")}</option>
        {stagesList.map((s) => <option key={s} value={String(s)}>{text(s)}</option>)}
      </select>
    </Row>
  );
  // The block sits on the "Models" settings page and carries the same building blocks as it — else it would be the last wall of
  // text on a page that has none left. The marker `data-autocompact-setting` stays on the shell: a DOM probe in a real browser
  // counts the two select lists in it.
  return (
    <div data-autocompact-setting>
      <Group
        title={t("Auto-compact")}
        hint={`${t("When a chat's context reaches either mark, cbase summarises the history after the run and continues with a fresh session — the same for Claude Code, Codex and third parties. The providers only compact at around 95 % themselves.")} ${t("Overridable per chat: the “Auto” menu on the context bar below the composer. Third-party providers additionally compact within a run at the same mark.")}`}
      >
        {queue(
          t("Share of the context window"),
          t("Measured against the window of the model the chat runs on."),
          "percent", value, stages, (s) => `${s} %`, "percent", setValue,
        )}
        {/* The cap in tokens. A share alone hangs on the context window, and that is 1,000,000 for almost all Claude models — 60 %
            there meant 600,000 tokens per request. */}
        {queue(
          t("No later than"),
          t("Absolute cap in tokens, independent of the share above. Compaction happens at whichever point comes first; with both set to “Off”, nothing is compacted automatically."),
          "max", max, maxStages, tokenText, "maxTokens", setMax,
        )}
      </Group>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
