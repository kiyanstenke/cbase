"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ── The symbol rail at the left edge ────────────────────────────────────────────────────────────
//
// The second row under the header (the tabs of Coding: Chats … Browser) stands as a narrow column on the left, symbols
// only, like the rail of the ChatGPT app (52 px wide, icons ≈ 20 px, centres 44 px apart, the active entry on a 36 px
// square with radius ≈ 10 px).
//
// The column itself is not part of this file: it lives in the layout frame (`app/layout.tsx`, id `cbase-rail`), so it
// stays put on page changes and the content card next to it does not jump — also on pages without their own tabs
// (Skills, Apps, Profiles). Every page with tabs portals its entries into it.
//
// The column is NOT in the header, so not in its drag region either: since Electron 44 `app-region` is inherited by
// every DOM child (web/test/drag-region.test.mjs), and a rail inside would swallow every click. The tooltip hangs on the
// body via portal — the column scrolls on its own (short windows), and a tooltip inside would be clipped at its edge.
//
// Accessibility: every entry is a button with `aria-label` (name) and `aria-current="page"` for the active one; Tab
// reaches each, ↑/↓ (and Home/End) move within the rail. The tooltip appears on hover and keyboard focus, not on mouse click.

export const RAIL_SLOT = "cbase-rail";

export type RailEntry = {
  key: string;
  /** The name — `aria-label` and first line of the tooltip. */
  label: string;
  icon: React.ReactNode;
  /** A short phrase under the name in the tooltip (optional). */
  hint?: string;
  /** A hairline BEFORE the entry — the grouping of the old tab row (Coding: administration │ tools). */
  separatorBeforehand?: boolean;
  /** Additional data attributes on the button (Coding: `data-tab` for the test rigs). */
  data?: Record<string, string>;
};

type Tap = { label: string; hint?: string; x: number; y: number };

export function SymbolRail({
  entries, active, onSelect, label,
}: {
  entries: RailEntry[];
  active: string;
  onSelect: (key: string) => void;
  /** Name of the navigation for screen readers ("Areas", "Categories"). */
  label: string;
}) {
  // The slot lives in the layout and already exists in the DOM at this page's first render — read BEFORE the first
  // paint, otherwise the rail would stand empty for a blink.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setSlot(document.getElementById(RAIL_SLOT)); }, []);
  const navRef = useRef<HTMLElement | null>(null);
  const tap = useTooltip();

  // ↑/↓ move between the rail's buttons, Home/End jump to the ends.
  const keys = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-rail]") ?? []);
    if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const target = e.key === "Home" ? 0
      : e.key === "End" ? buttons.length - 1
        : e.key === "ArrowDown" ? (i + 1) % buttons.length
          : (i - 1 + buttons.length) % buttons.length;
    e.preventDefault();
    buttons[target]?.focus();
  };

  if (!slot) return null;
  return (
    <>
      {createPortal(
        // ONE tooltip for the whole rail (`tap`, passed to each button as `k`): only so it moves from button to button
        // without a pause — two separate tooltips would close and open separately, with a gap between.
        <nav ref={navRef} aria-label={label} onKeyDown={keys} className="flex w-full shrink-0 grow flex-col items-center gap-2 px-2 pb-3 pt-1.5">
          {entries.map((e) => {
            const enabled = e.key === active;
            return (
              <Fragment key={e.key}>
                {e.separatorBeforehand && <span aria-hidden className="my-0.5 h-px w-5 shrink-0 bg-fg/15" />}
                <RailButton
                  label={e.label}
                  active={enabled}
                  data={{ ...e.data, "data-rail-key": e.key }}
                  onClick={() => { tap.close(); onSelect(e.key); }}
                  tooltip={{ label: e.label, hint: e.hint }}
                  k={tap}
                >
                  {e.icon}
                </RailButton>
              </Fragment>
            );
          })}
        </nav>,
        slot,
      )}
      {tap.state && typeof document !== "undefined" && createPortal(<Tooltip tap={tap.state} />, document.body)}
    </>
  );
}

/** One button of the rail: 36 × 36, radius 10, the active one on `frame-active`. It shares the rail's tooltip (`k`). */
function RailButton({
  label, active = false, onClick, children, data, tooltip, k,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  data?: Record<string, string>;
  /** What the tooltip shows; the name if omitted. */
  tooltip?: { label: string; hint?: string };
  k: TooltipControl;
}) {
  const content = tooltip ?? { label };
  const show = (el: HTMLElement, immediately: boolean) => {
    const r = el.getBoundingClientRect();
    k.on({ ...content, x: r.right + 10, y: r.top + r.height / 2 }, immediately);
  };
  return (
      <button
        type="button"
        data-rail=""
        {...data}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        onMouseEnter={(e) => show(e.currentTarget, false)}
        onMouseLeave={k.leave}
        onMouseDown={k.close}
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget, true); }}
        onBlur={k.leave}
        className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-[10px] transition-colors [&_svg]:h-5 [&_svg]:w-5 ${
          active ? "bg-frame-active text-fg" : "text-fg/65 hover:bg-frame-hover hover:text-fg"
        }`}
      >
        {children}
      </button>
  );
}

type TooltipControl = {
  state: Tap | null;
  on: (t: Tap, immediately: boolean) => void;
  /** Close at once (click, scroll, window change). */
  close: () => void;
  /** Pointer (or focus) leaves a button: close after the linger time unless another button takes over. */
  leave: () => void;
};

// The tooltip appears after a short pause (120 ms) — sweeping over the rail must not flicker. If one is already open,
// it moves to the next button without a pause, like ChatGPT. Therefore leaving a button does NOT close it at once
// (`way`): it stays open for a linger time (100 ms), and the next button takes it over in that time with no pause and
// no empty frame in between (closing on `mouseleave` would always be too late across the 8 px gap to the neighbour).
// Click, scroll, window resize and window change close it at once (`close`): it is pinned to a spot on the screen, not to the button.
const LAG_MS = 120;
const LINGER_MS = 100;
function useTooltip(): TooltipControl {
  const [status, setStatus] = useState<Tap | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const open = useRef(false);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    open.current = false;
    setStatus(null);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(timer.current); // a tooltip not yet shown no longer appears
    if (open.current) timer.current = setTimeout(close, LINGER_MS);
  }, [close]);
  const on = useCallback((t: Tap, immediately: boolean) => {
    clearTimeout(timer.current); // also the linger timer: the next button takes over
    if (immediately || open.current) { open.current = true; setStatus(t); return; }
    timer.current = setTimeout(() => { open.current = true; setStatus(t); }, LAG_MS);
  }, []);
  useEffect(() => {
    if (!status) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [status, close]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { state: status, on, close, leave };
}

// Dark on both themes like ChatGPT (`bg-dark`, white text), right of the button, vertically centred on it. Silent for
// screen readers: the button's `aria-label` already carries the name.
function Tooltip({ tap }: { tap: Tap }) {
  return (
    <div aria-hidden className="pointer-events-none fixed z-[90] -translate-y-1/2" style={{ left: tap.x, top: tap.y }}>
      <div className="cb-overlay-in max-w-[260px] rounded-lg bg-dark px-2.5 py-1.5 text-[12px] leading-snug text-white shadow-card">
        <div className="font-medium">{tap.label}</div>
        {tap.hint && <div className="mt-0.5 text-white/70">{tap.hint}</div>}
      </div>
    </div>
  );
}
