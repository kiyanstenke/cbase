"use client";

// THE one model picker with search: OpenRouter carries the whole tool-capable catalog (several
// hundred models), and every place that offers models searches through this component.
//
//   * `ModelSearchList`: search field and list (groups per provider as an accordion, all open
//     while searching). The composers (Coding and agent chat) put it into their own dropdown,
//     because that one opens upward and animates its height.
//   * `ModelChoice`: the replacement for a `<select>`: a button in the shape of the kit `select`,
//     below it (or above, where there is no room below) the list in a `cb-pop` on the body. Via a
//     portal, because the settings modal and the sheets are scrolling surfaces at whose edge an
//     absolutely positioned menu would be clipped. Closed by a document `mousedown` plus
//     `closest("[data-model-choice-pop]")` (click catchers are never `fixed inset-0`), by Escape,
//     scrolling or resizing.
//
// The computation (words, hits, first hit, label) lives in the module `lib/model-search.ts`. A value
// that no group lists shows in the button as itself, never as "nothing selected" (the same rule as
// the default-model row of the provider page).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { menuRow, select as selectClass } from "@/components/CbKit";
import { useT } from "@/lib/i18n";
import { firstHit, groupOf, labelOf, modelHits, popSituation, type ModelGroup, type ModelOption, type PopSituation } from "@/lib/model-search";

export type { ModelGroup, ModelOption } from "@/lib/model-search";

function Caret() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function CheckMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * Search field and list. `top` are rows without a group above the list ("Inherits (as chat)", "Provider default"); they are
 * filtered too. Without a search ONE group is open (`startGroup`, else that of the value, with a single group that one); while
 * searching all hits are open. Enter picks the first hit and is ALWAYS intercepted; in the composer it would otherwise submit.
 */
export function ModelSearchList({ groups, value, onChoice, top = [], startGroup, onEscape, scrollClass = "", scrollStyle, contentRef, large = false }: {
  groups: readonly ModelGroup[];
  value: string;
  onChoice: (option: ModelOption, group: ModelGroup | null) => void;
  top?: readonly ModelOption[];
  startGroup?: string;
  onEscape?: () => void;
  scrollClass?: string;
  scrollStyle?: CSSProperties;
  contentRef?: Ref<HTMLDivElement>;
  /** The font size of the Coding composer (13 px); otherwise that of the menus (12.5 px). */
  large?: boolean;
}) {
  const t = useT();
  const [question, setQuestion] = useState("");
  const [open, setOpen] = useState(() => startGroup ?? groupOf(groups, value)?.key ?? (groups.length === 1 ? groups[0].key : ""));
  const searches = question.trim().length > 0;
  const topGroup: ModelGroup = { key: "", label: "", options: [...top] };
  const topHits = modelHits([topGroup], question)[0]?.options ?? [];
  const hits = modelHits(groups, question);
  const first = firstHit(topHits.length ? [{ ...topGroup, options: topHits }, ...hits] : hits);
  const headerShow = groups.length > 1;
  // The kit menu row (CbKit `menuRow`): rounding, gap to the neighbouring row and highlight as in every menu.
  const row = `${menuRow} ${large ? "text-[13px]" : "text-[12.5px]"}`;

  const optionButton = (o: ModelOption, g: ModelGroup | null) => {
    const enabled = o.value === value;
    return (
      <button
        key={`${g?.key ?? ""}:${o.value}`}
        type="button"
        onClick={() => onChoice(o, g)}
        title={o.title}
        data-model-option={o.value}
        aria-current={enabled ? "true" : undefined}
        className={`${row} ${enabled ? "font-medium" : ""} ${o.warn ? "text-warn" : ""}`}
      >
        <span className="min-w-0 flex-1 truncate">{t(o.label)}</span>
        {(o.markers ?? []).map((m) => <span key={m} className={`shrink-0 text-[10px] font-normal ${o.warn ? "" : "text-dim"}`}>({m})</span>)}
        {enabled && <span className="shrink-0 text-dim"><CheckMark /></span>}
      </button>
    );
  };

  return (
    <>
      <div className="shrink-0 border-b border-edge p-1.5">
        <input
          autoFocus
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); if (searches && first) onChoice(first.option, first.group.key ? first.group : null); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onEscape?.(); }
          }}
          placeholder={t("Search model…")}
          aria-label={t("Search model…")}
          data-model-search
          className="w-full rounded-xl bg-bg px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-dim focus:ring-1 focus:ring-accent/50"
        />
      </div>
      <div className={`overflow-y-auto ${scrollClass}`} style={scrollStyle}>
        <div ref={contentRef} className="p-1.5">
          {topHits.map((o) => optionButton(o, null))}
          {topHits.length > 0 && hits.length > 0 && <div className="my-1 border-t border-edge" />}
          {hits.length === 0 && topHits.length === 0 && <div className="px-3 py-5 text-center text-[12px] text-dim">{t("No matches")}</div>}
          {hits.map((g, i) => {
            const on = searches || !headerShow || open === g.key;
            return (
              <div key={g.key} className={i > 0 && headerShow ? "mt-1 border-t border-edge pt-1" : ""} data-model-group={g.key}>
                {headerShow && (
                  <button
                    type="button"
                    onClick={() => { if (!searches) setOpen(on ? "" : g.key); }}
                    className={`${menuRow} text-[10px] font-semibold uppercase tracking-wider text-dim`}
                  >
                    <span className="truncate">{g.label}</span>
                    <span className="shrink-0 rounded-full bg-bg px-1.5 py-px text-[9px] tabular-nums">{g.options.length}</span>
                    {!searches && <span className={`ml-auto shrink-0 transition-transform duration-200 ${on ? "" : "-rotate-90"}`}><Caret /></span>}
                  </button>
                )}
                {on && g.options.map((o) => optionButton(o, g))}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// The height of the search field above the list; the list's scroll height is the height of the placement minus this header.
const SEARCH_HEADER = 48;

/**
 * The replacement for a `<select>` over models. `value` is the stored value, `top` the rows without a group (empty entry etc.).
 * `warn` sets the button's warning ring (a stored value that the list does not carry).
 */
export function ModelChoice({ groups, value, onChoice, top = [], label, className = "", base = selectClass, disabled = false, warn = false, data, id }: {
  groups: readonly ModelGroup[];
  value: string;
  onChoice: (value: string, group: ModelGroup | null) => void;
  top?: readonly ModelOption[];
  /** aria-label of the button. */
  label: string;
  className?: string;
  /** The base shape of the button; otherwise the kit `select`. A sheet with its own field shape (workflow settings: dense field) passes
   *  its own instead of layering it ON TOP: Tailwind orders two equal utilities by their value, not by source order. */
  base?: string;
  disabled?: boolean;
  warn?: boolean;
  /** Measurement markers for test benches (e.g. `data-outerloop-model`); they belong on the button. */
  data?: Record<`data-${string}`, string>;
  /** For a preceding `<label htmlFor>`: a button is labellable like a `<select>`. */
  id?: string;
}) {
  const t = useT();
  const buttonEl = useRef<HTMLButtonElement>(null);
  const [situation, setSituation] = useState<PopSituation | null>(null);
  const isOpen = situation !== null;
  const displayed = labelOf([{ key: "", label: "", options: [...top] }, ...groups], value);

  const open = () => {
    const el = buttonEl.current;
    if (!el) return;
    // Direction and height follow the free space (lib/model-search.ts `popSituation`): the list never extends past the window edge.
    setSituation(popSituation(el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
  };

  useLayoutEffect(() => { if (disabled) setSituation(null); }, [disabled]);
  useEffect(() => {
    if (!isOpen) return;
    const close = () => setSituation(null);
    const beside = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-model-choice-pop]") || buttonEl.current?.contains(target)) return;
      close();
    };
    const roles = (e: Event) => { if (!(e.target as Element | null)?.closest?.("[data-model-choice-pop]")) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", beside);
    window.addEventListener("scroll", roles, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", beside);
      window.removeEventListener("scroll", roles, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", key, true);
    };
  }, [isOpen]);

  return (
    <>
      <button
        ref={buttonEl}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => (isOpen ? setSituation(null) : open())}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={displayed === null && value ? value : undefined}
        {...data}
        className={`${base} inline-flex max-w-full cursor-pointer items-center gap-1.5 text-left disabled:cursor-default disabled:opacity-50 ${warn ? "ring-1 ring-warn" : ""} ${className}`}
      >
        <span className="min-w-0 flex-1 truncate">{displayed !== null ? t(displayed) : value}</span>
        <span className="shrink-0 opacity-70"><Caret /></span>
      </button>
      {situation && typeof document !== "undefined" && createPortal(
        <div
          className="cb-kit fixed z-[80]"
          style={{ left: situation.left, width: situation.width, top: situation.top, bottom: situation.bottom }}
          data-model-choice-pop
        >
          <div className="cb-pop cb-pop-in-fast flex flex-col overflow-hidden rounded-2xl text-fg" style={{ maxHeight: situation.height }}>
            <ModelSearchList
              groups={groups}
              value={value}
              top={top}
              onChoice={(o, g) => { setSituation(null); onChoice(o.value, g); }}
              onEscape={() => setSituation(null)}
              scrollStyle={{ maxHeight: Math.max(0, situation.height - SEARCH_HEADER) }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
