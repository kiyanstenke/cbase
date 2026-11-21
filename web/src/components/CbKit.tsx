"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/lib/i18n";
import { sheetTakesEscape } from "@/lib/escape-level";
import { scrollNeed, scrollsNow } from "@/lib/scrollBand";

// ── Shared vocabulary of all pages ──────────────────────────────────────────────────
//
// The same button and field classes used to exist in three copies, and on ONE screen "Cancel" looked different in one tab than
// in another. They are merged here; every page takes its look from this file.
//
// The color split follows the one-signal rule of DESIGN.md (repository root): accent means "something runs here" or "you are here" — nothing
// else. Three levels:
//
//   accent  — the action IS the signal: approve, ingest, trigger a run.
//   primary — the completion of something: save, create, adopt. Graphite.
//   ghost   — the normal case. Transparent with a paper edge.
//
// Geometry stays as it was (12 × 6 px): the page is dense, and DESIGN.md explicitly allows the compact form.
//
// ── Everything flat ──
// One form applies to every page of the app (`cb-flat` on the body, DESIGN.md "The flat form"), and the building blocks for it
// live here: fields are inset trays without a frame (`field`, `select`), search is a capsule (`Search`), filters are capsules
// with graphite for "selected" (`FilterChip`), menus are opaque sheets (`Menu`), and the empty state is a dashed card (`Empty`).

export const pill = "rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors";
export const accent = `${pill} bg-accent text-white hover:opacity-90`;
export const primary = `${pill} bg-dark text-white hover:opacity-90`;
export const ghost = `${pill} border border-edge text-dim hover:bg-hover hover:text-fg`;
/** Destructive or undoing: quiet until the pointer lies on it. */
export const quietDanger = `${pill} border border-edge text-dim hover:border-danger/40 hover:bg-danger/10 hover:text-danger`;

/** Compact form for toolbars and card headers that repeat often. */
export const pillSm = "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors";
export const ghostSm = `${pillSm} border border-edge text-dim hover:bg-hover hover:text-fg`;
export const quietDangerSm = `${pillSm} border border-edge text-dim hover:border-danger/40 hover:bg-danger/10 hover:text-danger`;

// Operable ⇒ capsule (DESIGN.md "capsule or card"): a <select> is a control, not an input field. Without a frame, on the `bg`
// level: on a card this reads as an inset capsule — the same form as the filter capsules beside it. `min-w-0`, because
// a <select> would otherwise grow as wide as its widest option.
export const select = "min-w-0 rounded-full bg-bg px-2.5 py-1 text-[12px] font-medium text-dim outline-none transition-colors hover:text-fg focus:text-fg focus-visible:ring-2 focus-visible:ring-accent/40";
// Fields carry typed content and therefore stand on the body level (13 px). As a tray without a frame: the `bg` level lies one
// step below the card in both designs, so the field is visible without needing an edge. Focus lifts it to `panel` and draws a
// ring — an edge that is only there when it says something.
export const field = "rounded-xl bg-bg px-3 py-1.5 text-[13px] outline-none transition-colors placeholder:text-dim focus:bg-panel focus:ring-1 focus:ring-accent/50";

// Reading width for running text. The number is not 74, because `ch` means the width of the zero — and Inter's zero is 1.275
// times as wide as an average character. Measured, 82ch gave 105 characters per line in the transcript, 74ch gave 94. 58ch land
// at about 74 and thereby in the window in which the eye still finds the start of the line.
export const measure = "max-w-[58ch]";

export const ic = (children: React.ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

export const SearchIcon = ({ size = 13 }: { size?: number }) => ic(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>, size);
export const DotsIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
  </svg>
);

const END_GAP = 8; // px behind the last button once the bar scrolls
const END_EDGE = 14;  // px soft edge on the side where content remains
/**
 * Segment bar: ONE control with a few positions, not a row of buttons. Filters used to be two rows of loose capsules — seven
 * identically looking pills that read like seven actions. They are two questions (where from, in which state) with one answer
 * each. A rail with a graphite capsule at the chosen position turns each question into a control; the dot before an origin
 * carries the same color as the mark on its row.
 *
 * Capsule as in `SlideTabBar`, but with a count at EVERY position: for a filter the count is the statement ("2 waiting"), not
 * decoration on the chosen tab.
 *
 * The capsule is carried by the chosen button ITSELF. A measured pill used to sit behind it and glide across the bar on a
 * change (left/width, 240 ms) — the left/right motion was unwanted. Now it sits at the new position at once; background and
 * text fade via `transition-colors` (150 ms), the page below fades in itself (globals.css, `--cb-switch`).
 *
 * It scrolls: measured in the right chat bar — four tabs need 269 px without counters and up to 333 px with counters on three,
 * 296 are available. Where it does not fit, scrolling is right; what was wrong was that NO inner padding remained at the end
 * (2 px) and nothing said that it continues.
 */
export function Segments({ items, value, onChange, label, className = "" }: {
// `data`: data attributes on the button (identifier for test rigs, e.g. `data-wf-kind`) — only spread, not measured.
  items: { key: string; label: string; n?: number | null; point?: string; tone?: "warn"; title?: string; data?: Record<`data-${string}`, string> }[];
  value: string;
  onChange: (key: string) => void;
  label?: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Map<string, HTMLButtonElement>>(new Map());
  // Does the bar scroll? Only THEN do end padding and fade edge apply. Without overflow the rendering stays pixel for pixel the
  // old one — the bar appears in over twenty places, and none of them should change because of a case it does not have.
  const [scrolls, setScrolls] = useState(false);
  const [edge, setEdge] = useState({ left: false, right: false });
  const sig = items.map((it) => `${it.key}:${it.n ?? ""}`).join("|");
  useLayoutEffect(() => {
    const el = root.current;
    const measureNow = () => {
      const b = buttons.current.get(value);
      if (!el) return;
      // The need is measured at the LAST BUTTON, not at `scrollWidth`: the spacer stands behind it and would otherwise enter its
      // own condition.
      //
      // And it is measured in FRACTIONS, not via `offsetLeft`/`clientWidth`. The spacer is a real child of an `inline-flex` bar
      // and enters its intrinsic width — with rounded measures a pixel that exists only in the rounding sufficed to claim
      // "scrolls" although the bar fits: it then grows by the spacer, refutes itself, loses it and starts over, once per frame.
      // That was the reported flicker (`clientWidth` jumped 391 ↔ 401 at an unchanged need of 392). Why the fractions close the
      // cycle is explained in `lib/scrollBand.ts`.
      const last = buttons.current.get(items[items.length - 1]?.key || "");
      const cs = getComputedStyle(el);
      const margin = parseFloat(cs.borderLeftWidth || "0");
      const box = el.getBoundingClientRect();
      const needed = last
        ? scrollNeed(box.left + margin, last.getBoundingClientRect().right, el.scrollLeft, parseFloat(cs.paddingRight || "0"))
        : 0;
      const view = box.width - margin - parseFloat(cs.borderRightWidth || "0");
      setScrolls(scrollsNow(needed, view));
      const over = el.scrollWidth - el.clientWidth;
      // The active button must be in view. Otherwise the bar shows a selection nobody sees, and the pill sits clipped at the
      // edge. The margin is END_EDGE, not END_GAP: "in view" is not enough while the soft edge lies over it — with an 8 px margin
      // the right rounding of the black pill lay in the last 14 px of the gradient and faded, again the reported "looks cut off"
      // image, just softer.
      // ONE target, clamped, and written only if it differs. Two branches used to stand here that could contradict each other: an
      // active button wider than the viewport pulls its right edge in with one branch and its left with the other — and since
      // writing `scrollLeft` fires a `scroll` event that triggers measuring again, that would be a pendulum. It did NOT occur on
      // the test rig (two forced geometries, both calm: the browser clamps the one target to the scroll end, so the second
      // branch never gets its turn). So it is not a fixed malfunction but a promise: if the button does not fit the viewport, its
      // left edge holds, and the computation repeats with the same result. For every fitting button — every case that occurs
      // today — the result is character for character the old one.
      if (b && over > 0) {
        const left = b.offsetLeft - END_EDGE;
        const right = b.offsetLeft + b.offsetWidth + END_EDGE;
        const matches = b.offsetWidth + 2 * END_EDGE <= el.clientWidth;
        const target = !matches ? left
          : right > el.scrollLeft + el.clientWidth ? right - el.clientWidth
          : left < el.scrollLeft ? left
          : el.scrollLeft;
        const clamped = Math.max(0, Math.min(target, over));
        if (Math.abs(clamped - el.scrollLeft) > 0.5) el.scrollLeft = clamped;
      }
      const l = over > 0 && el.scrollLeft > 1;
      const r = over > 0 && el.scrollLeft < over - 1;
      setEdge((k) => (k.left === l && k.right === r ? k : { left: l, right: r }));
    };
    measureNow();
    const ro = new ResizeObserver(measureNow);
    if (el) { ro.observe(el); el.addEventListener("scroll", measureNow, { passive: true }); }
    return () => { ro.disconnect(); el?.removeEventListener("scroll", measureNow); };
    // sig: measure again when positions come, go or their count (and thereby width) changes. `scrolls` is deliberately NOT in
    // the list: the effect must not retrigger itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, sig]);
  // Soft edge instead of a hard cut: it says "this continues" and stands only on the side where something really lies.
  const history = scrolls
    ? `linear-gradient(to right, transparent 0, #000 ${edge.left ? END_EDGE : 0}px, #000 calc(100% - ${edge.right ? END_EDGE : 0}px), transparent 100%)`
    : undefined;
  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      className={`cb-strip relative inline-flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-full bg-bg p-0.5 ${className}`}
      style={history ? { maskImage: history, WebkitMaskImage: history } : undefined}
    >
      {items.map((it) => {
        const active = it.key === value;
        const warn = it.tone === "warn" && !active && (it.n ?? 0) > 0;
        return (
          <button
            key={it.key}
            ref={(el) => { if (el) buttons.current.set(it.key, el); else buttons.current.delete(it.key); }}
            {...it.data}
            type="button"
            aria-pressed={active}
            title={it.title}
            onClick={() => onChange(it.key)}
            className={`relative flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ${
              active ? "bg-dark text-white" : warn ? "text-warn hover:text-warn" : "text-dim hover:text-fg"
            }`}
          >
            {it.point && <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: it.point }} />}
            {it.label}
            {it.n !== undefined && it.n !== null && <span className={`tabular-nums ${active ? "opacity-70" : "opacity-80"}`}>{it.n}</span>}
          </button>
        );
      })}
      {/* The inner padding of a horizontally scrolling flex container is unreliable at the scroll end: the last button stuck to
          the edge, the selection pill looked clipped. A `shrink-0` spacer as the last child is real content and scrolls along. */}
      {scrolls && <span aria-hidden data-cb-strip-end className="shrink-0" style={{ width: END_GAP }} />}
    </div>
  );
}

export function Chevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export const Spinner = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className="animate-spin">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" strokeOpacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

/**
 * Small remove button. Replaces the bare "×" on chips, search fields and assignments: the character came from no icon set, and
 * its hit area was as large as the glyph itself (about 9 px). Now a drawn cross in the same stroke as all other icons, in a
 * 20 px area.
 */
export function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-dim transition-colors hover:bg-danger/10 hover:text-danger"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

/**
 * Search as a capsule with a magnifier — the same on every page. The remove button appears as soon as something is in it.
 */
export function Search({
  value, onChange, placeholder, className = "", onSubmit, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
  /** Enter triggers the search (full text) — without it every character searches. */
  onSubmit?: () => void;
  autoFocus?: boolean;
}) {
  const t = useT();
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit?.(); }}
      className={`flex min-w-0 items-center gap-1.5 rounded-full bg-bg py-1 pl-3 pr-1 text-dim transition-colors focus-within:text-fg ${className}`}
    >
      <span className="shrink-0"><SearchIcon /></span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        className="min-w-0 flex-1 bg-transparent py-0.5 text-[12.5px] text-fg outline-none placeholder:text-dim"
      />
      {/* Clearing only calls onChange: an onSubmit in the same tick would still read the old value. */}
      {value
        ? <RemoveButton label={t("Clear search")} onClick={() => onChange("")} />
        : <span className="h-5 w-5 shrink-0" aria-hidden />}
    </form>
  );
}

/**
 * Filter capsule: selected means graphite. A state or origin filter is a neutral choice, not a signal — indigo would otherwise
 * stick to five capsules at once. The count behind it is half the information (how much lies behind each choice); a select
 * list withholds it. `warn` tints an unselected capsule while something waits behind it.
 */
export function FilterChip({ label, n, active, tone = "normal", onClick, title }: {
  label: string;
  n?: number | null;
  active: boolean;
  tone?: "normal" | "warn";
  onClick: () => void;
  title?: string;
}) {
  const warn = tone === "warn" && !active && (n ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
        active ? "bg-dark text-white" : warn ? "bg-warn/15 text-warn hover:bg-warn/25" : "bg-bg text-dim hover:bg-hover hover:text-fg"
      }`}
    >
      {label}
      {n !== undefined && n !== null && <span className={`tabular-nums ${active ? "opacity-70" : ""}`}>{n}</span>}
    </button>
  );
}

/**
 * State message as a tinted surface with full-color text (traffic-light rule): a state reports itself, it does not demand
 * anything. Every error line used to be bare colored text on the paper background — on a page with twelve lists that got lost.
 */
export function Hint({ tone, children }: { tone: "danger" | "warn" | "ok"; children: React.ReactNode }) {
  const cls =
    tone === "danger" ? "bg-danger/10 text-danger"
    : tone === "warn" ? "bg-warn/15 text-warn"
    : "bg-ok/15 text-ok";
  return <div role={tone === "ok" ? "status" : "alert"} className={`rounded-xl px-3 py-2 text-[12px] leading-relaxed ${cls}`}>{children}</div>;
}

/**
 * Flat overlays: every menu and modal in the Coding chat looks like the popover of the ChatGPT app. The form lives in
 * `globals.css` under `.cb-flat`: opaque instead of glass, fine edge, 16 px radius, no blur. In the chat's tree it applies via
 * the class at the root (`ChatPane`); a sheet portaled to the body lies OUTSIDE it and therefore asks this context — a portal
 * keeps the React context, but not the CSS ancestors. `useFlat()` returns the class with a leading space, or nothing.
 */
// The flat form is that of the WHOLE app (`cb-flat` on the body, app/layout.tsx) — the context therefore defaults to "flat"; the
// class on the sheet is redundant but harmless, and holds the form in an embedding without the app's body (tests, test rigs).
export const FlatContext = createContext(true);
export function useFlat(): string {
  return useContext(FlatContext) ? " cb-flat" : "";
}

/** The surface of a sheet WITHOUT inner padding — for a popover whose content runs to the edge (hairline lists, cards). */
export const popSurface = "cb-pop cb-pop-in-fast z-50 overflow-hidden rounded-xl text-[12.5px] text-fg";
/** The menu sheet itself — for menus that bring their own trigger (chat list, task row). With 6 px of inner padding all around:
 *  the rows (`menuRow`) do not touch the edge. */
export const popClass = `${popSurface} p-1.5`;
/** The same sheet for a menu IN the header (drag region): it fades in via opacity only. Electron computes the `no-drag` area from
 *  the layout, and the transform animation of `popClass` (12 px lower, 96 %) would not be seen by it — the region would stay at
 *  the start position (TopNav.tsx, at the centered slot). */
export const popClassHeader = popClass.replace("cb-pop-in-fast", "cb-fade-in-fast");

/**
 * A menu behind three dots. For actions that are rarely needed or undo something — they do not belong as a button in a
 * toolbar, where they would be as loud as what one does constantly.
 *
 * Deliberately kept small: a pointer press outside closes it (else it would stay open on a click elsewhere), Escape likewise. No
 * focus trap and no arrow-key navigation — it is too short for that, and a half-built focus prison is worse than none. Only as
 * much focus as the portal needs (below).
 *
 * `silent`: the trigger is a 24 px dots button without a capsule that shows itself only when the pointer is in the surrounding
 * `group` — for rows where it would otherwise stand twenty times in a column. It stays reachable by keyboard (focus shows it) —
 * and so do the entries: on opening, focus moves to the first, Escape returns it to the trigger, and if Tab leaves the sheet it
 * closes. Without that the entries would sit at the end of the tab order (the sheet is the last child of the body), and the
 * sheet would stay open.
 *
 * The sheet hangs on the body via a portal, in window coordinates. It used to lie `absolute` in the shell — and the shell sits
 * in eighteen lists inside an `overflow-hidden` surface (rounded corners) that cut it off at its lower edge: on the skills page
 * the menu of a one-line group was invisible, in every other list that of the last row. The `overflow-hidden` cannot go
 * (`.cb-row` is pinned unlayered to `border-radius: 0`), and `position: fixed` INSIDE the view does not help because
 * `@container` makes it the reference frame. `cb-kit` on the portal node is mandatory: the cool color roles (`--color-hover`,
 * `--color-edge`) apply only beneath it. Scrolling and window resize CLOSE the sheet instead of carrying it along — a sheet
 * that chases its trigger is never quite in place. Scrolling here means: an ancestor of the trigger scrolls (or the window). A
 * foreign scroll area — the streaming history beside it jumps to the end on every token and fires scroll — does not move the
 * sheet and therefore does not close it.
 */
export function Menu({
  label, children, width = 240, silent = false, alignment = "right", button: buttonEl, shrinks = false,
}: {
  /** Title AND name of the trigger (`title`, `aria-label`) — `aria-label` REPLACES the visible content: a choice button whose
   *  content shows a state therefore names it here too (else a screen reader hears only "Choose instance"). */
  label: string;
  children: React.ReactNode;
  width?: number;
  silent?: boolean;
  alignment?: "right" | "left";
  /** Own trigger instead of the three dots — the chevron half of a split button, a choice button in the panel header. Content,
   *  class and data attributes come from the caller; sheet, closing and focus stay the kit's, so no second menu behavior arises.
   *  The open state is on the button as `aria-expanded` (Tailwind: `aria-expanded:…`); whoever needs it in the CONTENT (a chevron
   *  that turns) passes a function `(open) => …`. */
  button?: { content: React.ReactNode | ((open: boolean) => React.ReactNode); className: string; data?: Record<string, string> };
  /** The shell may shrink in a flex row (`min-w-0 shrink` instead of `shrink-0`) — for a choice button that should shorten a long
   *  name instead of taking the space from the title beside it (instance choice in the chat bar's header). */
  shrinks?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const flat = useFlat();
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  // Position of the sheet in window coordinates. `null` = not measured yet: the sheet then stands invisible until the layout
  // effect puts it in place before the first frame.
  const [situation, setSituation] = useState<React.CSSProperties | null>(null);
  // Opened by keyboard (Enter/Space on the trigger: `click` with `detail === 0`)? Only then does focus land on an entry on
  // opening — see the focus effect below.
  const perKey = useRef(false);

  // Escape AND a pointer press outside close the menu. No `fixed inset-0` catcher: the content area is a container
  // (`@container`), and layout containment makes it the reference frame for `position: fixed` — the catcher would then cover only
  // the card. A document listener is the more honest way anyway: it does not swallow the click.
  // "Outside" means: the nearest `[data-kit-pop]` is neither the shell nor the sheet — the sheet hangs on the body, a
  // `box.contains` would not see it and would clear it on mousedown, before the click reaches the entry.
  useEffect(() => {
    if (!open) return;
 // Escape returns focus to the trigger — it stood in the sheet, which is about to disappear.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    const beside = (e: MouseEvent) => {
      const pop = (e.target as Element | null)?.closest?.("[data-kit-pop]") ?? null;
      if (pop !== box.current && pop !== sheet.current) setOpen(false);
    };
    // The capture listener on the document sees the scrolling of EVERY element. It closes only if the sheet's position is
    // disturbed: the scrolled element contains the trigger (or it is the document — window scroll). Scrolling in the sheet itself
    // (the submenu scrolls in itself) and in a foreign area (a streaming chat's history, which sets `scrollTop` on every token)
    // leave it standing — otherwise no menu was usable in the same window while a stream ran.
    const scrolled = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      if (sheet.current?.contains(el)) return;
      if (!el.contains(box.current)) return;
      setOpen(false);
    };
    const size = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", beside);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", size);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", beside);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", size);
    };
  }, [open]);

  // Measure the position before the sheet is drawn: below the trigger, aligned with its edge. If it sticks out at the bottom of
  // the window it opens UPWARD; room remains on the left for a submenu (220 px + bridge) if the window allows — the sheet stays
  // in the window in every case.
  useLayoutEffect(() => {
    if (!open) { setSituation(null); return; }
    const r = box.current?.getBoundingClientRect();
    const b = sheet.current?.getBoundingClientRect();
    if (!r || !b) return;
    const margin = 8;
    let left = alignment === "right" ? r.right - width : r.left;
    left = Math.min(left, window.innerWidth - width - margin);
    left = Math.max(left, margin);
    const upward = r.bottom + 4 + b.height > window.innerHeight - margin;
    setSituation(upward
      ? { left, bottom: Math.max(margin, window.innerHeight - r.top + 4) }
      : { left, top: r.bottom + 4 });
  }, [open, alignment, width]);

  // Focus into the sheet as soon as it is in place — before that it is `visibility: hidden`, and an invisible element takes no
  // focus. Opened by KEYBOARD onto the first entry (a choice menu, `MenuEntry selected`, onto the chosen one, like the
  // appearance choice ThemeToggle); with the MOUSE onto the sheet itself. Reason: Chromium counts a script's focus after a mouse
  // click as `:focus-visible` — the first entry stood highlighted on opening. On the sheet ↑/↓ still move into the entries
  // (`menuKeys`), Tab likewise.
  useEffect(() => {
    if (!open || !situation) return;
    const b = sheet.current;
    if (!perKey.current) { b?.focus({ preventScroll: true }); return; }
    (b?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ?? b?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'))?.focus({ preventScroll: true });
  }, [open, situation]);

  // If focus leaves sheet AND trigger (Tab past the last entry), the sheet closes; without a target (window switch, click on
  // something not focusable) it stays — the click outside is handled by the mousedown listener, and a sheet that disappears on
  // Alt-Tab surprises.
  const focusLost = (e: React.FocusEvent<HTMLDivElement>) => {
    const target = e.relatedTarget;
    if (!(target instanceof Node)) return;
    if (sheet.current?.contains(target) || box.current?.contains(target)) return;
    setOpen(false);
  };

  const sheetClass = `${popClass} cb-kit fixed ${alignment === "right" ? "origin-top-right" : "origin-top-left"}${flat}`;

  return (
    <div ref={box} className={shrinks ? "relative min-w-0 shrink" : "relative shrink-0"} data-kit-pop>
      <button
        ref={trigger}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); perKey.current = e.detail === 0; setOpen((v) => !v); }}
        {...(buttonEl?.data ?? {})}
        className={buttonEl
          ? buttonEl.className
          : silent
          ? `grid h-6 w-6 place-items-center rounded-md text-dim transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 ${open ? "bg-hover text-fg opacity-100" : "opacity-0"}`
          : `grid h-[30px] w-[30px] place-items-center rounded-full bg-bg text-dim transition-colors hover:bg-hover hover:text-fg ${open ? "bg-hover text-fg" : ""}`}
      >
        {buttonEl ? (typeof buttonEl.content === "function" ? buttonEl.content(open) : buttonEl.content) : <DotsIcon />}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={sheet}
          role="menu"
          tabIndex={-1}
          data-kit-pop
          style={{ width: width, ...(situation ?? { top: 0, left: 0, visibility: "hidden" }) }}
          className={sheetClass}
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
          onKeyDown={menuKeys}
          onBlur={focusLost}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}


// ── The menu row ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The form of the appearance choice (ThemeToggle): the sheet holds 6 px of inner padding (`popClass`), the row is rounded 10 px
// (concentric to the 16 px of the flat sheet) and stands 2 px from the neighbor row. Highlighting happens under the pointer AND
// under keyboard focus with the same surface — no focus ring (it ran as an accent bar across the sheet's edge). Rounding,
// spacing, highlight and the symbol's color live in globals.css (`.cb-menu-row`, `@layer components` — every utility on the
// element beats it, a marked row keeps its color under the pointer), only the switching off of the focus ring is unlayered. A
// row that cannot be a `MenuEntry` (own content, link, row in a sheet of its own) carries `menuRow` (or `menuRowDanger`) and
// `data-danger` for the red highlight; a symbol on the left in `menuSymbol`. A disabled row (`disabled`) is painted by the global
// rule `button:disabled` (globals.css, unlayered).
const MENU_ROW_FORM = "cb-menu-row flex w-full min-w-0 items-center gap-2.5 px-2.5 py-1.5 text-left cursor-pointer";
/** A row of a menu — form, spacing and highlight (see above). */
export const menuRow = `${MENU_ROW_FORM} transition-colors`;
/** A row of a PALETTE whose highlight follows the chosen index (slash, ⌘P — the palette sets it itself via `onMouseEnter` and the
 *  arrow keys): the same form, but no surface of its own under the pointer and no cross-fade — else two rows would stand
 *  highlighted when moving with ↑/↓ (the one under the resting pointer and the chosen one). */
export const menuRowGuided = `${MENU_ROW_FORM} cb-menu-guided`;
/** The same row for a destructive action (delete): red, red background — plus `data-danger` on the element. */
export const menuRowDanger = `${menuRow} text-danger`;
/** The symbol's place on the left of a menu row: 16 px, dimmed, in foreground color under pointer and focus. */
export const menuSymbol = "cb-menu-symbol grid h-4 w-4 shrink-0 place-items-center";
/** A heading of a group in the menu — aligned with the rows' text edge. */
export const menuHeader = "px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-dim";

/** ↑/↓ move over a menu's entries (wrapping at the end), Home/End to the ends — for a sheet that does not bring its own key
 *  behavior (the kit's `Menu` calls it; a custom sheet attaches it as `onKeyDown`). */
export function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const points = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(MENU_POINT));
  if (!points.length) return;
  const i = points.indexOf(document.activeElement as HTMLElement);
  const target = e.key === "Home" ? 0
    : e.key === "End" ? points.length - 1
    : e.key === "ArrowDown" ? (i + 1) % points.length
    : i < 0 ? points.length - 1 : (i - 1 + points.length) % points.length;
  e.preventDefault();
  points[target]?.focus();
}
const MENU_POINT = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"]), [role="menuitemradio"]:not([disabled]):not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([disabled]):not([aria-disabled="true"])';

export function MenuEntry({
  label, hint, onClick, disabled, danger, data, right, selected, icon,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** data attributes on the button (measuring marks of the test rigs), like `button.data` on `Menu`. */
  data?: Record<string, string>;
  /** A brief note on the right of the row (a number, a mark) — instead of a sentence below. */
  right?: React.ReactNode;
  /** An entry of a CHOICE (exactly one applies): when set (true/false) it becomes `menuitemradio` with `aria-checked`, and the
   *  chosen one carries a checkmark in the accent on the right (the form of the appearance choice, ThemeToggle). Unset: an
   *  ordinary `menuitem`. */
  selected?: boolean;
  /** A symbol on the left (SVG, 14–15 px, `currentColor`) — dimmed, in foreground color under pointer and focus. */
  icon?: React.ReactNode;
}) {
  const choice = selected !== undefined;
  // The checkmark's place is reserved for an unchosen entry too — else `right` and the checkmark would sit differently per row.
  const checkMark = choice ? (
    <span aria-hidden data-menu-check-mark={selected ? "1" : "0"} className={`grid h-3.5 w-3.5 shrink-0 place-items-center text-accent ${selected ? "" : "invisible"}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
    </span>
  ) : null;
  return (
    <button
      type="button"
      role={choice ? "menuitemradio" : "menuitem"}
      {...(choice ? { "aria-checked": Boolean(selected) } : {})}
      {...(danger ? { "data-danger": "" } : {})}
      disabled={disabled}
      onClick={onClick}
      {...(data ?? {})}
      className={`${danger ? menuRowDanger : menuRow}${hint ? " items-start" : ""}`}
    >
      {icon && <span aria-hidden className={`${menuSymbol}${hint ? " mt-px" : ""}`}>{icon}</span>}
      <span className="block min-w-0 flex-1">
        {right === undefined && !choice
          ? <span className="block">{label}</span>
          : <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{label}</span>{right}{checkMark}</span>}
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-dim">{hint}</span>}
      </span>
    </button>
  );
}

/** A separator between groups of a menu — indented like the rows. */
export const MenuSeparator = () => <div role="separator" className="mx-1 my-1.5 h-px bg-edge" />;

export function Loading() {
  const t = useT();
  return <div className="p-6 text-center text-[13px] text-dim">{t("Loading…")}</div>;
}

/** Empty state: dashed card, 32 px padding, centered pencil text. */
export function Empty({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="cb-kit-pane cb-kit-pane-dashed rounded-2xl p-8 text-center">
      {title && <div className="text-[15px] font-semibold">{title}</div>}
      {children && <p className={`mx-auto ${measure} text-[13px] leading-relaxed text-dim ${title ? "mt-1.5" : ""}`}>{children}</p>}
    </div>
  );
}

/**
 * The placeholder of the right column of a split view: centered, dimmed, without a box. A dashed box there would be the same
 * information twice beside the list.
 */
export function Placeholder({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="m-auto max-w-[340px] px-6 text-center">
      <div className="text-[13px] font-semibold text-dim">{title}</div>
      {children && <p className="mt-1 text-[12.5px] leading-relaxed text-dim">{children}</p>}
    </div>
  );
}

/** A way back, the same everywhere. */
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-fit items-center gap-1.5 rounded-full py-1 pr-2.5 text-[12px] font-medium text-dim transition-colors hover:text-fg"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M15 18l-6-6 6-6" />
      </svg>
      {label}
    </button>
  );
}

/** Section marker above a group: 10 px/600, uppercase, +0.05em (DESIGN.md "Overline"). */
export function Overline({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-dim">{children}</div>;
}


/**
 * List on the left, selection on the right — as soon as the content area is wide enough.
 *
 * Such pages used to be two-level: list, click, detail, "Back". On a wide window that meant a narrow column of text in a 1400 px
 * wide card — the inbox took about a third of the area, the rest stayed empty. Side by side the same page fills the area AND
 * saves the way back: the next item is one click, not back and forth.
 *
 * The threshold is a CONTAINER query, not a window width. The same view sat once alone and once beside an extended chat; the
 * window is equally wide in both cases, the view is not. An `lg:` rule would have split exactly where there is no room.
 *
 * The threshold lies at 64 rem (1024 px) of content width, not lower: below that the list would get a 17 rem column in which the
 * item kinds of a batch stand three lines high — measured at 812 px. Next to an extended chat (about 940 px) it was therefore
 * deliberately NOT split.
 *
 * Below the threshold it stays with the old way: either the list OR the detail, and the detail's back button leads back. Both
 * columns scroll on their own — so the list stays put while one reads on the right.
 *
 * No separator line between the columns: the list is a card and carries its own edge; a line beside it would be a
 * second border for the same boundary.
 *
 * `listWide`: the LIST is the wide one and the detail the narrow column — the branch timeline needs the area, its detail does
 * not. Threshold and behavior below stay the same.
 */
export function SplitPane({
  list,
  detail,
  placeholder,
  shared = true,
  listWide = false,
}: {
  list: React.ReactNode;
  /** The chosen object. `null` = nothing chosen; the placeholder then stands on the right. */
  detail: React.ReactNode | null;
  placeholder: React.ReactNode;
  /** `false` = one column across the full width (empty list, loading state). */
  shared?: boolean;
  /** The list fills the width, the detail stands as a fixed column on the right. */
  listWide?: boolean;
}) {
  if (!shared) {
    return <div className="cb-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{list}</div>;
  }
  const narrow = "@5xl/kit:w-[clamp(19rem,30%,26rem)] @5xl/kit:flex-none";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-4">
      <div
        className={`cb-scroll min-h-0 min-w-0 flex-1 flex-col overflow-y-auto ${listWide ? "" : narrow} ${
          detail ? "hidden @5xl/kit:flex" : "flex"
        }`}
      >
        {list}
      </div>
      <div
        className={`@container/detail cb-scroll min-h-0 min-w-0 flex-1 flex-col overflow-y-auto ${listWide ? narrow : ""} ${
          detail ? "flex" : "hidden @5xl/kit:flex"
        }`}
      >
        {detail ?? placeholder}
      </div>
    </div>
  );
}

/**
 * The back button of a split view: below the split threshold it is the only way back to the list, above it the list stands
 * beside it and it would be a claim of navigation that does not exist.
 */
export function SplitBackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="@5xl/kit:hidden">
      <BackButton label={label} onClick={onClick} />
    </div>
  );
}

/**
 * A tab of a tab row (`app/workspaces/page.tsx`). The Coding tabs stand as an icon rail on the left (`SymbolRail`).
 *
 * `separatorBeforehand` sets a stroke before the tab — the one statement of the row: administration on the left, tools on the
 * right.
 */
export type Tab = {
  key: string;
  label: string;
  n?: number | null;
  icon?: React.ReactNode;
  title?: string;
  separatorBeforehand?: boolean;
};

// The open kit modals in order of opening — Escape belongs to the last. Without the stack the one opened first would take the
// press (it listens longer on `document`), and a sheet that cannot close right now would keep the one above it open.
const modalStack: object[] = [];

/**
 * A modal as a flat sheet — via portal on the body, a darkening scrim, Escape and a click outside close it. `cb-kit` on the
 * overlay node is mandatory: the sheet hangs on the body, so OUTSIDE the cool-colored view, and would otherwise carry the
 * house's warm color roles. The width is a cap (`min(width, 92vw)`); the content brings its padding via `className` (default
 * `p-6`) and scrolls in itself if it is taller than the window.
 *
 * Escape (rule in lib/escape-level.ts): belongs to the TOPMOST open sheet, on `document` instead of `window`, and only if no
 * element inside has already taken it; taken means `preventDefault`, so the settings below (`window`) stay open.
 */
export function Modal({
  onClose, children, width = 520, className = "p-6", label, z = "z-50",
}: {
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  className?: string;
  label?: string;
  z?: string;
}) {
  // This sheet's id in the stack — an effect of its own WITHOUT `onClose`, so a new callback does not push the sheet to the top.
  const [me] = useState<object>(() => ({}));
  useEffect(() => {
    modalStack.push(me);
    return () => { const i = modalStack.indexOf(me); if (i >= 0) modalStack.splice(i, 1); };
  }, [me]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== me || !sheetTakesEscape(e)) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose, me]);
  // A click outside closes — but only if the POINTER PRESS was outside too. A text selection that starts in a field of the sheet
  // and ends over the scrim is, for the browser, a click on the scrim; without this check the sheet would close along with the
  // input.
  const pressOnVeil = useRef(false);
  const flat = useFlat();
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className={`cb-kit cb-overlay cb-overlay-in fixed inset-0 ${z} flex items-center justify-center p-3 sm:p-6${flat}`}
      onMouseDown={(e) => { pressOnVeil.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressOnVeil.current) onClose(); }}
    >
      <div
        className={`cb-sheet cb-pop-in flex max-h-full min-h-0 flex-col overflow-y-auto rounded-3xl text-fg ${className}`}
        style={{ width: `min(${width}px, 92vw)` }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** On/off switch (role=switch) — the same form for agents, skills, MCP and credentials. */
export function Toggle({ on, onClick, title, disabled }: { on: boolean; onClick: () => void; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-accent" : "bg-edge"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-[left] ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

/** The heading of a sheet: 15 px/600, optionally with a line below. */
export function ModalTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold tracking-tight">{children}</h2>
      {hint && <p className="mt-1 text-[12.5px] leading-relaxed text-dim">{hint}</p>}
    </div>
  );
}

/** Row header of a section or a page: title on the left, actions on the right, one line. */
export function Header({ title, hint, children, className = "" }: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 ${className}`}>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold tracking-tight">{title}</h3>
        {hint && <p className="mt-0.5 text-[12px] leading-relaxed text-dim">{hint}</p>}
      </div>
      {children && <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// ── The quiet page ──
// Only the FORM: color roles, accent and type stay those of the app. No surface around lists or rows — the rows stand directly
// on the stage, separated by hairlines in `edge`; a quiet page header; a state is a dot with a word instead of a badge; accent
// only for the chosen and the running; the empty state a sentence under a hairline instead of a dashed box. Used by projects,
// workflows (workflow/WorkflowsTab.tsx, WorkflowsPane.tsx, DynWorkflowsPane.tsx), agents (outerloop/AgentsTab.tsx, AgentsPane.tsx,
// outerloop/OuterLoopPane.tsx), MCP, context and credentials (McpServersPane.tsx, ProjectContextPane.tsx, VarsPane.tsx and the
// workspace context in app/workspaces/page.tsx). `SectionHeader` is the header of a section without an origin mark; `Word` is a
// dimmed word on the row, with a dot a state. The same pages carry the form of instances (section below): the hairlines are
// gone there.

/** The width of the shared column, without the top spacing — for content above which a row already stands in the same column
 *  (the kind bar of the workflows and agents tabs). */
export const COLUMN_WIDTH = "mx-auto w-full max-w-[1200px] @3xl/kit:px-4";
/** The page's shared column: list and view stand at the same width, the title does not jump on opening. */
export const COLUMN = `${COLUMN_WIDTH} @3xl/kit:pt-3`;
/** Page title: larger and lighter than the kit's header, set slightly tighter. */
export const TITLE = "text-[24px] font-normal leading-[1.2] tracking-[-0.02em] text-fg";

/** The page header: title, below it dimmed the hint (or short info), on the right the actions. */
export function PagesHeader({ title, under, children, top }: {
  title: React.ReactNode;
  under?: React.ReactNode;
  children?: React.ReactNode;
  /** Above the title (the way back of the project view). */
  top?: React.ReactNode;
}) {
  return (
    <header className="shrink-0 pb-7">
      {top && <div className="mb-3">{top}</div>}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 className={`truncate ${TITLE}`}>{title}</h2>
          {under && <div className="mt-1.5 flex max-w-[64ch] flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-relaxed text-dim">{under}</div>}
        </div>
        {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}

/** A small dot in the state's color, before a word or without one. */
export function Point({ color }: { color: string }) {
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}

/** The empty state of a quiet list: under a hairline the sentence at the size of a name, below it dimmed the way forward. */
export function EmptySentence({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="border-t border-edge py-12">
      <div className="text-[15px] font-medium tracking-[-0.01em]">{title}</div>
      {children && <p className="mt-1.5 max-w-[58ch] text-[13px] leading-relaxed text-dim">{children}</p>}
    </div>
  );
}

/** A dimmed word on a row; with `point` a state as a dot with a word. `loud` lifts the word to `fg` — a state one must not
 *  overlook; `mono` for identifiers (transport, model). */
export function Word({ children, point, title, loud = false, mono = false }: {
  children: React.ReactNode;
  point?: string;
  title?: string;
  loud?: boolean;
  mono?: boolean;
}) {
  return (
    <span title={title} className={`flex min-w-0 items-center gap-1.5 ${mono ? "font-mono text-[11.5px]" : "text-[12px]"} ${loud ? "text-fg" : "text-dim"}`}>
      {point && <Point color={point} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The arrow at the end of a row that opens something: subtle, it brightens with the row (`group` on the row). */
export function RowsArrow() {
  return (
    <span aria-hidden className="flex -rotate-90 pl-1 text-dim transition-colors group-hover:text-fg">
      <Chevron open={false} size={13} />
    </span>
  );
}

// ── The form of instances ──
// The language of the Coding pages:
//
// - no surface (`cb-kit-pane`) around a list, no hairlines (`border-y`, `divide-y`); rows are rounded and light up under the
//   pointer (`hover:bg-hover`), the chosen or expanded one carries the accent tint `SELECTED` — never `cb-row`: globals.css sets
//   `border-radius: 0` there unlayered and would beat every rounding and every `bg-*` on the element;
// - in front a tile with the thing's symbol in the color of its state (`Tile`: green runs/on, accent in transition, yellow waits
//   or warns, red error, dimmed off; without a state `text-fg/80`), one step lighter under the row's pointer
//   (`group-hover:bg-edge`);
// - the name 14 px medium, below it the facts line with 12 px symbols (`FACTS`/`Fact`); a state word only if it is not the normal
//   case;
// - above a list the summary ("3 subagents · 2 with skills") beside the first action — in the `PagesHeader` in place of the
//   explanatory sentence, which stays while the list is empty (otherwise it stands as short info at the summary);
// - a section has a small tile with the category's symbol before the title, the rows stand below it indented (`Section`); an
//   empty list or section is ONE dimmed sentence at row height (`EmptyRow`);
// - symbols with stroke 1.8 and round ends (`symbol`, the Coding symbols `SYM`), the same as the Coding rail
//   (app/workspaces/page.tsx `TabIcon`).

export const symbol = (children: React.ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

/** The symbols of the Coding pages (tiles, sections, facts). The first five are those of the Coding rail (`TabIcon`) — a row's
 *  tile carries the same sign as the tab it stands in. */
export const SYM = {
  // An agent: head with antenna and two eyes (tab "Agents").
  agent: (s?: number) => symbol(<><rect x="4" y="8" width="16" height="12" rx="3.5" /><path d="M12 8V4.5" /><path d="M10.5 4.5h3" /><path d="M9.5 13.2v1.6" /><path d="M14.5 13.2v1.6" /></>, s),
  // Two nodes, connected — a graph (tab "Workflows").
  workflow: (s?: number) => symbol(<><rect x="3" y="3.5" width="7" height="7" rx="2" /><rect x="14" y="13.5" width="7" height="7" rx="2" /><path d="M10 7h3.5a2 2 0 0 1 2 2v4.5" /></>, s),
  // Plug (tab "MCP").
  plug: (s?: number) => symbol(<><path d="M9 3v4.5" /><path d="M15 3v4.5" /><path d="M6 7.5h12V11a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>, s),
  // Open book (tab "Context").
  ledger: (s?: number) => symbol(<><path d="M12 6.5C10.4 5 8 4.5 4 4.5v13c4 0 6.4.5 8 2 1.6-1.5 4-2 8-2v-13c-4 0-6.4.5-8 2z" /><path d="M12 6.5v13" /></>, s),
  // Key (tab "Credentials", the secret).
  key: (s?: number) => symbol(<><circle cx="7.5" cy="15.5" r="4" /><path d="M10.4 12.6 20 3" /><path d="M16.5 6.5 19 9" /><path d="M14 9l2 2" /></>, s),
  // A script: sheet with angle brackets (the dynamic workflow).
  script: (s?: number) => symbol(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="m10 12.5-2 2 2 2" /><path d="m14 12.5 2 2-2 2" /></>, s),
  // An eye — the outer-loop agent watches chats.
  eye: (s?: number) => symbol(<><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>, s),
  // Three shortening lines — the summarizer.
  summarize: (s?: number) => symbol(<><path d="M4 6h16" /><path d="M4 12h11" /><path d="M4 18h6" /></>, s),
  chat: (s?: number) => symbol(<path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 3.5v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" />, s),
  project: (s?: number) => symbol(<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />, s),
  // Stacked layers — the workspace (like the header).
  workspace: (s?: number) => symbol(<><path d="M12 3 3 7.5 12 12l9-4.5L12 3z" /><path d="M3 12.5 12 17l9-4.5" /></>, s),
  // A chip — the model.
  model: (s?: number) => symbol(<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9.5 2.5v3.5" /><path d="M14.5 2.5v3.5" /><path d="M9.5 18v3.5" /><path d="M14.5 18v3.5" /><path d="M2.5 9.5H6" /><path d="M2.5 14.5H6" /><path d="M18 9.5h3.5" /><path d="M18 14.5h3.5" /></>, s),
  // A wrench — tools.
  tool: (s?: number) => symbol(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.3-.6-.6-2.3z" />, s),
  // A spark — skills.
  skill: (s?: number) => symbol(<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />, s),
  // A bolt — a trigger.
  blitz: (s?: number) => symbol(<path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z" />, s),
  // A list with dots — steps.
  steps: (s?: number) => symbol(<><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4.5 6h.01" /><path d="M4.5 12h.01" /><path d="M4.5 18h.01" /></>, s),
  // A lock — a barrier, a built-in server.
  padlock: (s?: number) => symbol(<><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>, s),
  // Four boxes — a catalog.
  catalog: (s?: number) => symbol(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>, s),
  // Curly braces — a variable.
  brackets: (s?: number) => symbol(<><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" /><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" /></>, s),
  // Two chain links — a link.
  link: (s?: number) => symbol(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>, s),
  // A block with lines — free text.
  block: (s?: number) => symbol(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h7" /><path d="M7 13h10" /><path d="M7 17h5" /></>, s),
  // A light bulb — a suggestion of the curator.
  suggestion: (s?: number) => symbol(<><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></>, s),
  // A clock — a date.
  clock: (s?: number) => symbol(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>, s),
  // A pin — pinned.
  pin: (s?: number) => symbol(<><path d="M9 3.5h6l-1 5 3 3v2H7v-2l3-3z" /><path d="M12 13.5V21" /></>, s),
  // A checkmark in a box — verified.
  check: (s?: number) => symbol(<><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>, s),
  // Arrow into a tray — adopted from the workspace.
  takenOver: (s?: number) => symbol(<><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /></>, s),
};

/** The chosen or expanded row: the same accent tint as `data-active` on a `cb-row` (globals.css), only rounded — the rule there
 *  sets `border-radius: 0` unlayered and would beat every `rounded-*` on the element. */
export const SELECTED = "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]";
/** A row in a section: without a separator line, highlighted rounded under the pointer. */
// The overhang (-mx-2) belongs on the list element, never on a button with w-full: there the width is over-determined, the right
// edge lapses, and the row ends 16 px before those of the other sections. The page root carries pr-2 so the overhang does not
// stick out over the scroll column (else sideways scrollable and cut off angular on the right).
export const ROW_INSIDE = "flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-hover";
export const ROW = `-mx-2 ${ROW_INSIDE}`;
/** A row of a top-level list (projects, instances, services, agents, workflows, MCP, context, credentials): tile in front,
 *  rounded, light under the pointer (`hover:bg-hover` or `SELECTED` is set by the caller). */
export const LIST_ROW = "group flex w-full min-w-0 gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors";
/** The facts line under a name: dimmed, with small symbols (12 px) before each fact. */
export const FACTS = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-dim";

/** A fact of the facts line: symbol and text. */
export function Fact({ symbol: sym, children, className = "", title, data }: {
  symbol?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  title?: string;
  data?: Record<string, string>;
}) {
  return (
    <span className={`flex min-w-0 items-center gap-1 ${className}`} title={title} {...data}>
      {sym && <span className="shrink-0 opacity-80">{sym}</span>}
      {children}
    </span>
  );
}

/** The tile in front of a row: the symbol in the color of the state (`color` as `text-*`). Under the row's pointer (`group`) it
 *  lifts one step. `large` for a header, `small` before a tab. */
export function Tile({ color = "text-fg/80", large = false, small = false, title, data, children }: {
  color?: string;
  large?: boolean;
  small?: boolean;
  title?: string;
  data?: Record<string, string>;
  children: React.ReactNode;
}) {
  const size = large ? "h-10 w-10 rounded-xl" : small ? "h-7 w-7 rounded-lg" : "h-8 w-8 rounded-[10px]";
  return (
    <span className={`flex shrink-0 items-center justify-center bg-hover transition-colors group-hover:bg-edge ${color} ${size}`} title={title} aria-hidden={title ? undefined : true} {...data}>
      {children}
    </span>
  );
}

/** A section: tile with the category's symbol, title, on the right a figure or a button; the rows below stand under the title
 *  (indented by tile + gap), without separator lines — the tile is the anchor by which one recognizes the category. `tile`
 *  tints the small tile (the origin: project in accent, workspace neutral — Origin.tsx `OriginSection`). */
export function Section({ symbol: sym, title, right, data, under, tile, children, className = "" }: {
  symbol: React.ReactNode;
  title: React.ReactNode;
  right?: React.ReactNode;
  data?: Record<string, string | number | undefined>;
  /** A dimmed sentence under the title (indented like the rows). */
  under?: React.ReactNode;
  tile?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col gap-1.5 ${className}`} {...data}>
      <SectionHeader symbol={sym} title={title} right={right} tile={tile} />
      {(under || children) && (
        <div className="min-w-0 pl-[38px]">
          {under && <p className="pb-1 text-[12px] leading-relaxed text-dim">{under}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/** Only the header of a section — for content that fills the height itself and scrolls (the structure tree), and therefore cannot
 *  stand under the indented rows of a `Section`. */
export function SectionHeader({ symbol: sym, title, right, tile = "bg-hover text-fg/80" }: {
  symbol: React.ReactNode;
  title: React.ReactNode;
  right?: React.ReactNode;
  tile?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tile}`} aria-hidden>{sym}</span>
      <h4 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h4>
      {right && <div className="flex shrink-0 items-center gap-2 text-[12px] text-dim">{right}</div>}
    </div>
  );
}

/** An empty list or an empty section: ONE dimmed sentence at the height of a row, on the right optionally the quiet way to
 *  create — no hairline, no box (for the empty PAGE `EmptySentence` remains). */
export function EmptyRow({ children, create }: { children: React.ReactNode; create?: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-2.5 py-2 text-[13px] text-dim">
      <span className="min-w-0 flex-1">{children}</span>
      {create && (
        <button type="button" onClick={create} className={`${ghostSm} shrink-0`}>{t("Create")}</button>
      )}
    </div>
  );
}
