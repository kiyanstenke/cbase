"use client";
// The tree's search widget as in VS Code — VS Code `FindWidget` of the trees (⌥⌘F or Ctrl+Alt+F): top right over the tree, a field "Type to
// search" with the toggles "Fuzzy Match" and "Filter" INSIDE the field (inside right, like the toggles of VS Code's search fields; off:
// highlight, VS Code's default), then Close. Without hits the field takes the error colour and below it "No results". While typing, the
// tree's focus jumps to the first hit and scrolls it into view (ExplorerTree, lib/tree-search.ts `nextHit`). Esc closes (and clears, as in
// VS Code), ↓ and ↵ hand focus to the tree. The computation is in lib/tree-search.ts; only what is loaded is searched — if there are
// folders that were never loaded, the widget says so (`unloaded`).
import { useEffect, useRef } from "react";
import type { SearchMode } from "@/lib/tree-search";

type T = (key: string, params?: Record<string, string | number>) => string;

const svg = (children: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
// The codicons: search-fuzzy (dots between letters), list-filter (funnel), close.
const FuzzySymbol = () => svg(<><path d="M2 11.5l2.5-7 2.5 7M2.9 9h3.2" /><circle cx="9.5" cy="10.5" r="0.6" fill="currentColor" /><path d="M12 4.5v7M12 4.5h2.2M12 8h1.8" /></>);
const FilterSymbol = () => svg(<path d="M2.5 3.5h11l-4.2 5v4.5l-2.6-1.3V8.5z" />);
const CloseSymbol = () => svg(<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />);

const TOGGLE = "grid h-[20px] w-[20px] shrink-0 place-items-center rounded-[3px] transition-colors";

export function TreeSearch({ t, text, setText, mode, setMode, fuzzy, setFuzzy, count, unloaded, onClose, onIntoTheTree }: {
  t: T;
  text: string;
  setText: (s: string) => void;
  mode: SearchMode;
  setMode: (m: SearchMode) => void;
  fuzzy: boolean;
  setFuzzy: (u: boolean) => void;
  count: number;
  unloaded: boolean;
  onClose: () => void;
  onIntoTheTree: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  const no = text !== "" && count === 0;
  const on = (truthy: boolean) => (truthy ? "bg-accent/25 text-fg outline outline-1 -outline-offset-1 outline-accent" : "text-dim hover:bg-hover hover:text-fg");
  return (
    <div className="cb-pop absolute right-3 top-0 z-30 w-[min(260px,calc(100%-24px))] p-1" role="search" data-tree-search>
      <div className="flex items-center gap-0.5">
        {/* The field with its toggles: ONE frame (VS Code `.monaco-inputbox` with `.controls` inside right). */}
        <div className={`flex h-[24px] min-w-0 flex-1 items-center rounded-[2px] border bg-panel pr-0.5 ${no ? "border-[var(--problem-error)] focus-within:border-[var(--problem-error)]" : "border-edge focus-within:border-accent"}`} data-tree-search-frame>
        <input
          ref={field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
            else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onIntoTheTree(); }
          }}
          placeholder={t("Type to search")}
          aria-label={t("Type to search")}
          aria-invalid={no}
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-fg outline-none"
          data-tree-search-field
        />
        <button type="button" className={`${TOGGLE} ${on(fuzzy)}`} aria-pressed={fuzzy} title={t("Fuzzy Match")} aria-label={t("Fuzzy Match")}
          onClick={() => setFuzzy(!fuzzy)} data-tree-search-toggle="fuzzy"><FuzzySymbol /></button>
        <button type="button" className={`${TOGGLE} ${on(mode === "filter")}`} aria-pressed={mode === "filter"} title={t("Filter")} aria-label={t("Filter")}
          onClick={() => setMode(mode === "filter" ? "highlight" : "filter")} data-tree-search-toggle="filter"><FilterSymbol /></button>
        </div>
        <button type="button" className={`${TOGGLE} text-dim hover:bg-hover hover:text-fg`} title={t("Close")} aria-label={t("Close")} onClick={onClose} data-tree-search-close><CloseSymbol /></button>
      </div>
      {no && <div role="status" className="px-1 pt-1 text-[12px] text-dim" data-tree-search-empty>{t("No results")}</div>}
      {unloaded && text !== "" && <div className="px-1 pt-1 text-[11px] text-dim" data-tree-search-unloaded>{t("Searches loaded folders only — folders never expanded are missing.")}</div>}
    </div>
  );
}
