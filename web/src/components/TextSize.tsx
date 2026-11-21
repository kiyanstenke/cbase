"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TEXT_STANDARD,
  TEXT_LEVELS,
  getTextSize,
  percentOf,
  step,
  setTextSize,
  textPx,
  useTextSize,
  type TextLevel,
} from "@/lib/appearance";
import { hasTextShortcut, listenShellTextSize, inShell, reportTextSize } from "@/lib/shell-bridge";
import { useT } from "@/lib/i18n";

// ── The controls for the app-wide text size ─────────────────────────────────────────────────────
//
// Three places, one state (lib/appearance.ts): the slider in Settings → Appearance, the steps in the header's
// "Display" menu (ThemeToggle) and, in the client, ⌘+ / ⌘− / ⌘0 with a hint pill. No button in the composer: that
// would again mean "chat only".
//
// Principle: the app itself is the preview. While everything around the control reflows, the control itself must
// stand still — so every control row here sits in `cb-text-fixed` (globals.css: factor 1 for the subtree, the root
// carries its own size), and hence steps instead of a continuous slider: every change re-measures all memory brakes.

/** "Large" -> the translated name of the level. */
function useStagesName() {
  const t = useT();
  return (s: TextLevel) => t(TEXT_LEVELS.find((x) => x.key === s)?.label ?? "Normal");
}

function GlyphA({ px }: { px: number }) {
  // The "A" as a glyph in fixed size — it IS the symbol, not app text, and does not grow: the button sits in
  // `cb-text-fixed`, where `textPx(n)` is exactly n px.
  return (
    <span aria-hidden className="font-semibold leading-none" style={{ fontSize: textPx(px) }}>
      A
    </span>
  );
}

/**
 * The slider of the settings page: [A] ——o—— [A]  Large · 110 %  Reset.
 * A native `<input type="range">` (arrow keys, Home/End, screen reader), five snap points below, one step on each
 * side. "Reset" is always in the flow and only becomes invisible at "Normal" — if it appeared late, the track would
 * move away under the pointer.
 */
export function TextSizeSlider() {
  const t = useT();
  const name = useStagesName();
  const stage = useTextSize();
  const i = Math.max(0, TEXT_LEVELS.findIndex((s) => s.key === stage));
  const p = percentOf(stage);
  const fill = `${(i / (TEXT_LEVELS.length - 1)) * 100}%`;
  const buttonEl =
    "grid h-8 w-8 shrink-0 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35";
  return (
    <div data-text-size-slider className="cb-text-fixed flex items-center gap-2 text-[13px]">
      <button type="button" className={buttonEl} onClick={() => step(-1)} disabled={i === 0} aria-label={t("Smaller text")} title={t("Smaller text")}>
        <GlyphA px={11} />
      </button>
      <div className="relative min-w-[140px] flex-1 pb-2.5 pt-2">
        <input
          type="range"
          min={0}
          max={TEXT_LEVELS.length - 1}
          step={1}
          value={i}
          onChange={(e) => setTextSize(TEXT_LEVELS[Number(e.target.value)]?.key ?? TEXT_STANDARD)}
          aria-label={t("Text size")}
          aria-valuetext={t("{stage}, {p} percent", { stage: name(stage), p })}
          data-text-size-stage={stage}
          className="cb-slider block w-full"
          style={{ "--fill": fill } as React.CSSProperties}
        />
        {/* Snap points under the track: the thumb centre runs from 9 px to width − 9 px (thumb 18 px). */}
        <div aria-hidden className="pointer-events-none absolute inset-x-[9px] bottom-0 h-1">
          {TEXT_LEVELS.map((s, j) => (
            <span
              key={s.key}
              className={`absolute top-0 h-1 w-1 -translate-x-1/2 rounded-full ${j <= i ? "bg-accent" : "bg-dim/45"}`}
              style={{ left: `${(j / (TEXT_LEVELS.length - 1)) * 100}%` }}
            />
          ))}
        </div>
      </div>
      <button type="button" className={buttonEl} onClick={() => step(1)} disabled={i === TEXT_LEVELS.length - 1} aria-label={t("Larger text")} title={t("Larger text")}>
        <GlyphA px={19} />
      </button>
      {/* Fixed width: "Very large · 123 %" is the longest — otherwise the track would shift on every change. */}
      <span className="w-[112px] shrink-0 whitespace-nowrap text-[12.5px] tabular-nums text-fg" data-text-size-value={p}>
        {t("{stage} · {p}%", { stage: name(stage), p })}
      </span>
      <button
        type="button"
        onClick={() => setTextSize(TEXT_STANDARD)}
        className={`shrink-0 rounded-full px-2 py-1 text-[12px] text-dim transition-colors hover:bg-hover hover:text-fg ${stage === TEXT_STANDARD ? "invisible" : ""}`}
        tabIndex={stage === TEXT_STANDARD ? -1 : undefined}
        aria-hidden={stage === TEXT_STANDARD ? true : undefined}
      >
        {t("Reset")}
      </button>
    </div>
  );
}

/** The sentence under the slider: what the text size does — and what enlarges EVERYTHING instead. */
export function useTextSizeHint(): string {
  const t = useT();
  // Only after mount: prerendered there is no `window`, and a sentence that changes after hydration would be a mismatch.
  const [location, setLocation] = useState<"browser" | "client" | "shell">("browser");
  useEffect(() => {
    setLocation(hasTextShortcut(window) ? "client" : inShell(window) ? "shell" : "browser");
  }, []);
  const set = t("Applies to the whole app on this device: headings, lists, menus and chats grow in the same proportion. Icons and spacing stay the same.");
  const everything =
    location === "client" ? t("To enlarge everything at once, use ⌥⌘+.")
    : location === "shell" ? t("To enlarge everything at once, use ⌘+.")
    : t("To enlarge everything at once, use the browser’s zoom.");
  return `${set} ${everything}`;
}

/**
 * The row in the header's "Display" menu: Text size  [A−] 110 % [A+]. The buttons keep the menu open — you click
 * several times and watch the app reflow behind it.
 *
 * Accessibility: the menu is a `role="menu"` (ThemeToggle); this row is a named group in it ("Text size"), its three
 * buttons are `menuitem` — so ↑/↓ reach them like the colour schemes above, and ←/→ move within the row. The middle
 * button is not just called "123 %": its name says what it DOES (back to 100 %). The client's shortcuts are on the
 * button as `aria-keyshortcuts`; the line below is for the eye only.
 */
export function TextSizeSteps() {
  const t = useT();
  const stage = useTextSize();
  const i = Math.max(0, TEXT_LEVELS.findIndex((s) => s.key === stage));
  const p = percentOf(stage);
  const [shortcut, setShortcut] = useState(false);
  useEffect(() => { setShortcut(hasTextShortcut(window)); }, []);
  // At the limit `aria-disabled`, not `disabled`: a menu item stays reachable in the menu (WAI), and a button that
  // became `disabled` under focus would lose it to <body> — ↑/↓ would no longer arrive in the menu. A click at the
  // limit does nothing (`step` only sets what changes).
  const buttonEl =
    "grid h-6 w-6 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg aria-disabled:pointer-events-none aria-disabled:opacity-35";
  return (
    <div data-text-size-steps role="group" aria-labelledby="cb-text-size-steps-name" className="cb-text-fixed px-2.5 pb-1 pt-1.5 text-[13px]">
      <div className="flex items-center gap-2">
        <span id="cb-text-size-steps-name" className="flex-1 font-medium text-dim">{t("Text size")}</span>
        <button
          type="button"
          role="menuitem"
          className={buttonEl}
          onClick={() => step(-1)}
          aria-disabled={i === 0 || undefined}
          aria-label={t("Smaller text")}
          aria-keyshortcuts={shortcut ? "Meta+-" : undefined}
          title={t("Smaller text")}
        >
          <GlyphA px={10} />
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => step(0)}
          aria-label={t("{p}% · reset to 100%", { p })}
          aria-keyshortcuts={shortcut ? "Meta+0" : undefined}
          title={t("Reset")}
          className="w-[42px] rounded-md py-0.5 text-center text-[12px] tabular-nums text-fg transition-colors hover:bg-hover"
        >
          {p} %
        </button>
        <button
          type="button"
          role="menuitem"
          className={buttonEl}
          onClick={() => step(1)}
          aria-disabled={i === TEXT_LEVELS.length - 1 || undefined}
          aria-label={t("Larger text")}
          aria-keyshortcuts={shortcut ? "Meta+Plus" : undefined}
          title={t("Larger text")}
        >
          <GlyphA px={15} />
        </button>
      </div>
      {shortcut && <div aria-hidden className="mt-0.5 text-right text-[10.5px] tabular-nums text-dim">⌘+ / ⌘− · ⌘0</div>}
    </div>
  );
}

const PILL_MS = 1500;

/**
 * In the client: listens to ⌘+ / ⌘− / ⌘0 and the radio entries under "View → Text size" (client/main.js), reports the
 * level to the shell at start (afterwards every change is reported) and shows a pill under the header for 1.5 s
 * after each command.
 *
 * Sits OUTSIDE the GatewayGate (layout.tsx): even during sign-in ⌘+ should be the text size once the page has
 * reported. The pill hangs on the body via portal — never as a child of TopNav, where it would inherit the drag
 * region (`app-region` is inherited since Electron 44).
 */
export function TextSizeHint() {
  const t = useT();
  const [pill, setPill] = useState<{ stage: TextLevel; n: number; top: number } | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    let clock: ReturnType<typeof setTimeout> | undefined;
    const off = listenShellTextSize(window, (command) => {
      let fresh: TextLevel;
      if (command === "+1") fresh = step(1);
      else if (command === "-1") fresh = step(-1);
      else if (command === "0") fresh = step(0);
      else if (typeof command === "string" && TEXT_LEVELS.some((s) => s.key === command)) {
        fresh = command as TextLevel;
        // The level already chosen again: no re-measure (like `step` at the limit) — the pill only confirms.
        if (fresh !== getTextSize()) setTextSize(fresh);
      } else return; // a foreign command: do nothing, no pill either
      const header = document.querySelector("header");
      const top = Math.max(8, Math.round((header?.getBoundingClientRect().bottom ?? 48) + 10));
      counter.current += 1;
      setPill({ stage: fresh, n: counter.current, top });
      if (clock) clearTimeout(clock);
      clock = setTimeout(() => setPill(null), PILL_MS);
    });
    // Listen first, then report: from the report on the shell sends ⌘+ here instead of to the zoom.
    reportTextSize(window, getTextSize());
    return () => {
      off();
      if (clock) clearTimeout(clock);
    };
  }, []);

  if (!pill || typeof document === "undefined") return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 z-[90] flex justify-center" style={{ top: pill.top }}>
      <div
        key={pill.n}
        role="status"
        aria-live="polite"
        data-text-size-pill={pill.stage}
        className="cb-pop cb-pop-in-fast whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12.5px] font-medium tabular-nums text-fg"
      >
        {t("Text size {p}% · ⌘0 resets", { p: percentOf(pill.stage) })}
      </div>
    </div>,
    document.body,
  );
}
