"use client";

// The category bar of the context pages: ONE horizontally scrolling bar, each category with its own icon and its count; the
// selected one sits on `edge` (the "selected" step in both designs) with the icon in the accent, empty categories recede. The
// scroll bar is invisible (`cb-strip`), the edges fade out as soon as there is more beyond them.
//
// Used by the project context page (fixed categories, `components/ProjectContextPane.tsx`) and the workspace memory (free
// categories, `app/workspaces/page.tsx`) — free names get a neutral icon.

import { useCallback, useEffect, useRef, useState } from "react";

export type CategoryEntry = { key: string; label: string; n?: number | null };

export function CategoryBar({ entries, value, onChoice, label }: {
  entries: CategoryEntry[];
  /** The selected key; `null` is "All" — the first entry must then carry the key "". */
  value: string | null;
  onChoice: (key: string | null) => void;
  label: string;
}) {
  const role = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState({ left: false, right: false });
  const miss = useCallback(() => {
    const el = role.current;
    if (!el) return;
    setMargin({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    miss();
    const el = role.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(miss);
    ro.observe(el);
    return () => ro.disconnect();
  }, [miss, entries.length]);
  // Scroll the selected category into view (chosen by keyboard or set from outside).
  useEffect(() => {
    const el = role.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);
  const mask = margin.left && margin.right
    ? "linear-gradient(to right, transparent 0, #000 2rem, #000 calc(100% - 2rem), transparent 100%)"
    : margin.right
      ? "linear-gradient(to right, #000 calc(100% - 2rem), transparent 100%)"
      : margin.left
        ? "linear-gradient(to right, transparent 0, #000 2rem)"
        : undefined;
  return (
    <div
      ref={role}
      role="tablist"
      aria-label={label}
      onScroll={miss}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      className="cb-strip -mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1 py-0.5"
    >
      {entries.map((e) => {
        const on = (value ?? "") === e.key;
        const empty = e.key !== "" && (e.n ?? 0) === 0;
        return (
          <button
            key={e.key || "_all"}
            type="button"
            role="tab"
            aria-selected={on}
            data-category={e.key || "all"}
            onClick={() => onChoice(e.key || null)}
            className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-3 text-[13px] transition-colors ${
              on ? "bg-edge text-fg" : `text-dim hover:bg-hover hover:text-fg ${empty ? "opacity-55" : ""}`
            }`}
          >
            <span className={`inline-flex shrink-0 ${on ? "text-accent" : ""}`}><CategorySymbol slug={e.key} /></span>
            <span className="whitespace-nowrap">{e.label}</span>
            {e.n != null && (
              <span className={`min-w-[1.25rem] rounded-full px-1.5 text-center text-[11px] font-medium tabular-nums leading-[18px] ${
                on ? "bg-fg/10 text-fg" : "bg-fg/[0.06] text-dim"
              }`}>{e.n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const s = (children: React.ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

// One icon per fixed category of the project context (server: `projects/context.js` PROJECT_CATEGORIES); "All" is the grid,
// every other (free workspace category) the label. Also the tile of every context row (ProjectContextPane.tsx, workspace
// context in app/workspaces/page.tsx) — `size` 16 there, 15 in the bar.
export function CategorySymbol({ slug, size = 15 }: { slug: string; size?: number }) {
  const s2 = (children: React.ReactNode) => s(children, size);
  switch (slug) {
    case "": return s2(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>);
    case "overview": return s2(<><circle cx="12" cy="12" r="8.5" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></>);
    case "domain": return s2(<><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" /></>);
    case "architecture": return s2(<><path d="M12 3 3 7.5 12 12l9-4.5L12 3z" /><path d="M3 12.5 12 17l9-4.5" /><path d="M3 17 12 21.5 21 17" /></>);
    case "repositories": return s2(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10" /><path d="M18 10a6 6 0 0 1-6 6H6" /></>);
    case "setup": return s2(<><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.3-.6-.6-2.3z" /></>);
    case "decisions": return s2(<><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-4.8" /></>);
    case "pitfalls": return s2(<><path d="M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4" /><path d="M12 16.8h.01" /></>);
    case "open-points": return s2(<><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.6" /><path d="M12 17h.01" /></>);
    case "deliverables": return s2(<><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5" /><path d="M12 13v8" /></>);
    case "references": return s2(<><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>);
    default: return s2(<><path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1a1 1 0 0 1 .7.3l7.2 7.2a1 1 0 0 1 0 1.4l-8.1 8.1a1 1 0 0 1-1.4 0l-7.2-7.2a1 1 0 0 1-.3-.7z" /><circle cx="8" cy="8" r="1.2" /></>);
  }
}
