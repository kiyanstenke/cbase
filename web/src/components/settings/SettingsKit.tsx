"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Overline } from "@/components/CbKit";
import { useT } from "@/lib/i18n";

// ── The building blocks of the settings ──────────────────────────────────────────────────────
//
// The basic form is the ROW: title, up to THREE lines of explanation below it, control on the right. The explanatory
// text was too much, not wrong: before, every page carried an extra sentence under its heading, and the longest single
// hints ran nine lines.
//
// Nothing is cut silently: if the hint does not fit in three lines, the row measures that itself (scrollHeight >
// clientHeight) and puts an (i) next to the title that shows the full wording. The (i) IS thereby the announcement
// "there is more here" — an invisible cut could not be told from a complete text. No wording is rewritten and no
// dictionary key invented: it is the same string, once clipped and once whole.
//
// What is NOT here: toggle, segments, overline, `field`/`ghost`/`primary`/`select`. They come from `CbKit` and are not
// re-exported here either — two ways to one building block are two building blocks as soon as one of them changes.

export type Tone = "accent" | "warn" | "danger" | "ok";

// Utilization → tone. The same thresholds (70/90) as the header's usage ring and the old remainder bar of the usage
// page: the same number must not give three colors in three places.
function toneFor(percent: number): Tone {
  return percent >= 90 ? "danger" : percent >= 70 ? "warn" : "accent";
}
const STROKE: Record<Tone, string> = { accent: "text-accent", warn: "text-warn", danger: "text-danger", ok: "text-ok" };
const SURFACE: Record<Tone, string> = { accent: "bg-accent", warn: "bg-warn", danger: "bg-danger", ok: "bg-ok" };
// A NaN from a response that has not loaded yet would otherwise be a bar width `NaN%` — the row would stand empty and
// look like "nothing used".
const clamp = (p: number) => Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));

// ── Info ─────────────────────────────────────────────────────────────────────────────────────

const INFO_WIDTH = 320; // px cap: beyond it the bubble becomes a second wall of text
const INFO_MARGIN = 8;     // px distance to the window edge
const INFO_CLEARANCE = 6;     // px between (i) and bubble
const INFO_AFTER_RUN = 120; // ms grace period on leaving — see `hide`

function InfoCharacter() {
  // Only the "i" — the circle around it is drawn by the button's edge.
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 11v6" /><path d="M12 7.2h.01" />
    </svg>
  );
}

/**
 * The (i) on a row. The text comes as a property and is NOT translated here — the caller writes `info={t("…")}`, so the
 * English key lies literally in the source, where every i18n tool and every reader expects it.
 *
 * Hovering shows the bubble, a click HOLDS it until the next click or a click elsewhere: tablets and touch screens have
 * no hover, and the same button must not be dead there.
 *
 * The bubble hangs on the body through a portal. Inside the modal it would sit in a surface with `overflow-y-auto` and
 * be cut at its edge — and `position: fixed` does not help there, because the content area is a `@container` and thus
 * the reference frame for `fixed`. `cb-kit` on the portal node is mandatory: the cool color roles apply only below it.
 */
export function Info({ text }: { text?: ReactNode }) {
  const t = useT();
  const id = useId();
  const buttonEl = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const afterRun = useRef<number | null>(null);
  const [held, setHeld] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [situation, setSituation] = useState<CSSProperties | null>(null);
  const open = held || hovered;

  const release = () => { setHeld(false); setHovered(false); };

  const show = () => {
    if (afterRun.current !== null) { clearTimeout(afterRun.current); afterRun.current = null; }
    setHovered(true);
  };
  // On leaving, close only after a grace period: between (i) and bubble lie six pixels without an element, and a long
  // bubble scrolls within itself — whoever wants to reach it must cross the gap. Without the grace period it would be
  // readable but not usable while hovering.
  const hide = () => {
    if (afterRun.current !== null) clearTimeout(afterRun.current);
    afterRun.current = window.setTimeout(() => { afterRun.current = null; setHovered(false); }, INFO_AFTER_RUN);
  };
  useEffect(() => () => { if (afterRun.current !== null) clearTimeout(afterRun.current); }, []);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") release(); };
    // No `fixed inset-0` click catcher: the modal's content area is a `@container`, and layout containment makes it the
    // reference frame for `position: fixed` — the catcher would cover only the card. A document listener does not
    // swallow the click anyway.
    const beside = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-set-info]") ?? null;
      if (el !== buttonEl.current && el !== bubble.current) release();
    };
    // Scrolling and window resizing CLOSE the bubble instead of carrying it along — the same rule as for the kit menu:
    // what trails its trigger is never quite in its place. Scrolling inside the bubble itself and in a foreign area does
    // not count.
    const scrolled = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      if (bubble.current?.contains(el)) return;
      if (!el.contains(buttonEl.current)) return;
      release();
    };
    window.addEventListener("keydown", esc);
    document.addEventListener("mousedown", beside);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", release);
    return () => {
      window.removeEventListener("keydown", esc);
      document.removeEventListener("mousedown", beside);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", release);
    };
  }, [open]);

  // Measure the position before the bubble is drawn: centered below the (i), but clamped at the window edge. A bubble
  // that runs out is unreadable at its end — and for a row at the right edge the text stands there, not the edge.
  useLayoutEffect(() => {
    if (!open) { setSituation(null); return; }
    const r = buttonEl.current?.getBoundingClientRect();
    const b = bubble.current?.getBoundingClientRect();
    if (!r || !b) return;
    let left = r.left + r.width / 2 - b.width / 2;
    left = Math.min(left, window.innerWidth - b.width - INFO_MARGIN);
    left = Math.max(left, INFO_MARGIN);
    const upward = r.bottom + INFO_CLEARANCE + b.height > window.innerHeight - INFO_MARGIN;
    setSituation(upward
      ? { left, bottom: Math.max(INFO_MARGIN, window.innerHeight - r.top + INFO_CLEARANCE) }
      : { left, top: r.bottom + INFO_CLEARANCE });
  }, [open, text]);

  if (text === undefined || text === null || text === "") return null;

  return (
    <>
      <span ref={buttonEl} data-set-info className="inline-flex shrink-0" onMouseEnter={show} onMouseLeave={hide}>
        <button
          type="button"
          aria-label={t("Explanation")}
          aria-expanded={open}
          aria-describedby={open ? id : undefined}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // On closing also withdraw the hover: after a tap the pointer "stays" on the button on touch devices, so the
            // bubble would never close.
            if (held) release(); else setHeld(true);
          }}
          className={`grid h-[18px] w-[18px] place-items-center rounded-full border transition-colors ${
            open ? "border-accent/60 bg-accent/10 text-accent" : "border-edge text-dim hover:border-accent/50 hover:text-accent"
          }`}
        >
          <InfoCharacter />
        </button>
      </span>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={bubble}
          id={id}
          role="tooltip"
          data-set-info
          onMouseEnter={show}
          onMouseLeave={hide}
          // z-85: above the settings modal (z-60) AND above a sheet on top of it (z-70/75/80), below the splash (z-100).
          // An explanation behind what it explains is none.
          style={{ maxWidth: INFO_WIDTH, ...(situation ?? { top: 0, left: 0, visibility: "hidden" }) }}
          className="cb-kit cb-pop cb-pop-in-fast fixed z-[85] max-h-[70vh] w-max overflow-y-auto whitespace-pre-line rounded-xl px-3 py-2 text-[12.5px] leading-relaxed text-fg"
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Row and group ─────────────────────────────────────────────────────────────────────────────

/**
 * The basic form of every setting: title, below it the hint (up to three lines), the control on the right.
 *
 * `hint` is the visible explanatory text. If it runs beyond three lines, the row clips it and shows an (i) next to the
 * title with the full wording — measured, not guessed, so a cut is never silent. `info` overrides what this (i) shows
 * (for the rare case that the full text stands elsewhere than the sketched one).
 *
 * `wide` moves the control into a second line below — for text fields and inputs that need the full width. Otherwise a
 * field would stand on the right in a column as wide as its neighbor is tall.
 */
export function Row({ title, hint, info, children, wide = false }: {
  title: ReactNode;
  hint?: ReactNode;
  info?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
}) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  // The clipping measures itself: the text width depends on the control beside it and on the window width, so a
  // character count as threshold would be wrong for every second row.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) { setTruncated(false); return; }
    const measure = () => setTruncated(el.scrollHeight - el.clientHeight > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hint]);

  const character = info != null || truncated;
  const header = (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 text-[13.5px] leading-snug">{title}</span>
      {character && <Info text={info ?? hint} />}
    </div>
  );
  const text = hint != null && hint !== false && (
    <p
      ref={textRef}
      data-set-hint
      className="mt-0.5 overflow-hidden text-[12px] leading-[1.45] text-dim"
      style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3 }}
    >
      {hint}
    </p>
  );
  return (
    <div data-set-row className="px-3.5 py-2.5">
      {wide ? (
        <>
          {header}
          {text}
          {children != null && children !== false && <div className="mt-2">{children}</div>}
        </>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {header}
            {text}
          </div>
          {children != null && children !== false && (
            <div className="flex shrink-0 items-center gap-2">{children}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Overline plus ONE surface with hairlines between the rows — never a card per row. `hint` is the case where something
 * stands above the whole group and fits no single row; like the row hint it is clamped to three lines and then gets its
 * (i) — otherwise the wall of text simply moves from the rows to the top.
 */
export function Group({ title, hint, children }: { title?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const [truncated, setTruncated] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) { setTruncated(false); return; }
    const measure = () => setTruncated(el.scrollHeight - el.clientHeight > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hint]);
  return (
    <section data-set-group className="mt-5 first:mt-0">
      {title != null && (
        <div className="flex items-center gap-1.5">
          <Overline>{title}</Overline>
          {truncated && <div className="-mt-1.5"><Info text={hint} /></div>}
        </div>
      )}
      {hint != null && (
        <p
          ref={textRef}
          data-set-group-hint
          className="-mt-0.5 mb-2 overflow-hidden text-[11.5px] leading-relaxed text-dim"
          style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3 }}
        >
          {hint}
        </p>
      )}
      <div className="cb-kit-pane divide-y divide-edge/60 overflow-hidden rounded-2xl">{children}</div>
    </section>
  );
}

// ── Choice card ────────────────────────────────────────────────────────────────────────────────

function CheckMarkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * The card from the former "Appearance", pulled out: icon, title, small hint, check badge at the top right. It is the
 * model of the whole conversion — a choice with three to four options reads faster as a card than in a select, because
 * all options are there at once.
 *
 * `children` takes an embedded preview (a sentence in the chosen language, a ring with the provider's remaining quota).
 */
export function ChoiceCard({ icon, title, hint, active, onClick, children, data}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  active: boolean;
  onClick: () => void;
  children?: ReactNode;
  /** Probe marks for the test rigs (e.g. data-design) — they belong on the button itself. */
  data?: Record<string, string>;
}) {
  return (
    <button {...data}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-set-choice={active ? "1" : "0"}
      className={`flex flex-col items-start gap-2.5 rounded-2xl border p-3.5 text-left transition-colors ${
        active ? "border-accent/60 bg-hover" : "border-edge bg-bg hover:bg-hover"
      }`}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className={active ? "text-accent" : "text-dim"}>{icon}</span>
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${active ? "bg-accent text-white" : "border border-edge text-transparent"}`}>
          <CheckMarkIcon />
        </span>
      </span>
      <span className="block w-full min-w-0">
        <span className="block text-[13.5px] font-semibold">{title}</span>
        {hint != null && <span className="block text-[11.5px] leading-snug text-dim">{hint}</span>}
      </span>
      {children != null && <span className="block w-full min-w-0">{children}</span>}
    </button>
  );
}

// ── Numbers: ring and bar ─────────────────────────────────────────────────────────────────────

/**
 * Percent ring. The same statement as `ProgressBar`, only for a card instead of a list: on a provider card the ring is
 * the first thing one sees, a bar would be a row there.
 *
 * `tone` forces the color — needed where the number does not speak for itself (an exhausted window without a percentage
 * is red although it reports 0).
 */
export function Ring({ percent, label, tone, size = 44 }: {
  percent: number;
  label?: ReactNode;
  tone?: Tone;
  size?: number;
}) {
  const p = clamp(percent);
  const extent = 2 * Math.PI * 16;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" className="text-edge" />
          <circle
            cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round"
            strokeDasharray={`${(p / 100) * extent} ${extent}`} transform="rotate(-90 20 20)"
            className={`${STROKE[tone ?? toneFor(p)]} transition-[stroke-dasharray] duration-700`}
          />
        </svg>
        <span
          className="absolute inset-0 grid place-items-center font-semibold tabular-nums leading-none"
          style={{ fontSize: Math.max(10, Math.round(size * 0.25)) }}
          data-set-ring={Math.round(p)}
        >
          <span>{Math.round(p)}<span className="text-[0.72em]"> %</span></span>
        </span>
      </div>
      {label != null && <span className="text-center text-[11px] leading-tight text-dim">{label}</span>}
    </div>
  );
}

/** The same value as a flat bar — for lists in which several stand below each other. */
export function ProgressBar({ percent, tone }: { percent: number; tone?: Tone }) {
  const p = clamp(percent);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-edge" data-set-progress-bar={Math.round(p)}>
      <div
        className={`h-full rounded-full ${SURFACE[tone ?? toneFor(p)]} transition-[width] duration-700`}
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

// ── Preview and chain ─────────────────────────────────────────────────────────────────────────

/**
 * Framed box with the overline "Preview". It shows what a setting DOES — with the same classes as the real thing, not
 * as a replica with its own computation; otherwise the preview eventually shows something other than the application.
 */
export function Preview({ children, title }: { children: ReactNode; title?: ReactNode }) {
  const t = useT();
  return (
    <div data-set-preview className="rounded-2xl border border-edge bg-bg px-5 py-4">
      <Overline>{title ?? t("Preview")}</Overline>
      {children}
    </div>
  );
}

export type ChainPlace = {
  label: ReactNode;
  /** Is there something at this place? Otherwise it is an empty dot. */
  occupied?: boolean;
  /** How many — the number stands IN the dot. Without a number it stays a full dot. */
  n?: number | null;
  title?: string;
};

/**
 * Horizontal event chain: per place a dot with a label below, occupied places in the accent color, empty ones muted,
 * connected by a hairline.
 *
 * Built for the hooks page: a list of groups does not say that the places have an ORDER and that an empty one lies
 * between two occupied ones.
 */
export function Chain({ places }: { places: ChainPlace[] }) {
  const count = places.length;
  if (!count) return null;
  // The line runs from the middle of the first to the middle of the last place, not over the full width: the columns are
  // equally wide, so half a column is 50/n percent. Over the full width it would stick out into the void on both sides.
  const inset = `${50 / count}%`;
  return (
    <div data-set-chain className="relative">
      <span aria-hidden className="absolute top-[10px] h-px bg-edge" style={{ left: inset, right: inset }} />
      <div className="relative flex items-start">
        {places.map((s, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5" title={s.title}>
            {s.occupied ? (
              <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-[10.5px] font-semibold leading-none text-white">
                {s.n != null && s.n > 0 ? s.n : null}
              </span>
            ) : (
              <span className="grid h-5 w-5 place-items-center rounded-full border border-edge bg-bg">
                <span className="h-1.5 w-1.5 rounded-full bg-dim/50" />
              </span>
            )}
            <span className={`text-center text-[11px] leading-tight ${s.occupied ? "text-fg" : "text-dim"}`}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
