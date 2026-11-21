"use client";

import { useEffect, useRef, useState } from "react";
import { applyMode, getStoredMode, setThemeMode, useResolvedTheme, useThemeMode, type ThemeMode } from "@/lib/theme";
import { useT } from "@/lib/i18n";
import { TextSizeSteps } from "@/components/TextSize";
import { MenuSeparator, menuSymbol, menuRow } from "@/components/CbKit";

export function SunIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
export function MoonIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
export function SystemIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

const OPTIONS: { mode: ThemeMode; label: string; Icon: typeof SunIcon }[] = [
  { mode: "light", label: "Light", Icon: SunIcon },
  { mode: "dark", label: "Dark", Icon: MoonIcon },
  { mode: "system", label: "System", Icon: SystemIcon },
];

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

// The "Display" menu: the three colour schemes, below them the text size of the whole app in steps ([A−] 110 % [A+],
// `TextSizeSteps`). The steps keep the menu open — you click several times and watch the app reflow behind it.
//
// Accessibility (WAI menu): every control in it is a `menuitem…` in a named group (Theme · Text size), with a
// `separator` between. On open the focus is on the chosen colour scheme; ↑/↓ move across all entries (Home/End to the
// ends), ←/→ within the row, Escape closes and returns focus to the button, Tab leaves the menu and closes it.
const MENU_ITEM = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';

export function ThemeToggle() {
  const t = useT();
  // The chosen mode comes from theme.ts (reactive): Settings → Appearance writes the same value,
  // and the check mark here must follow.
  const mode = useThemeMode();
  const [open, setOpen] = useState(false);
  const resolved = useResolvedTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Apply the stored mode once more after mount: this restores data-theme if it was removed from <html>
  // (e.g. by an earlier hydration error) — otherwise it would say "Dark" while the app stayed light.
  // applyMode also reports the chosen mode to the Electron shell (lib/theme.ts) — the start path next to the init script.
  useEffect(() => {
    applyMode(getStoredMode());
  }, []);

  // In system mode follow the OS switch (the toggle itself writes data-theme directly).
  // Second job: after a message to the shell, matchMedia flips only 10–19 ms LATER (see applyMode) — when switching
  // to "System", applyMode read the old, forced value, and only this listener recomputes with the new one.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (getStoredMode() === "system") applyMode("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Close via document `mousedown` outside `[data-display-pop]` (house rule: no `fixed inset-0` catcher) — and with Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-display-pop]")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // On open, move focus into the menu, to the chosen colour scheme (else the first entry).
  useEffect(() => {
    if (!open) return;
    const m = menuRef.current;
    (m?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? m?.querySelector<HTMLElement>(MENU_ITEM))?.focus();
  }, [open]);

  function choose(m: ThemeMode) {
    setThemeMode(m);
    setOpen(false);
    buttonRef.current?.focus();
  }

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") { setOpen(false); return; }
    const points = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? []);
    if (!points.length) return;
    const i = points.indexOf(document.activeElement as HTMLElement);
    const inRow = (el: HTMLElement | undefined) => !!el?.closest("[data-text-size-steps]");
    let target = -1;
    if (e.key === "ArrowDown") target = (i + 1) % points.length;
    else if (e.key === "ArrowUp") target = i < 0 ? points.length - 1 : (i - 1 + points.length) % points.length;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = points.length - 1;
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && inRow(points[i])) {
      const n = i + (e.key === "ArrowRight" ? 1 : -1);
      if (inRow(points[n])) target = n;
    }
    if (target < 0) return;
    e.preventDefault();
    points[target]?.focus();
  };

  const current = OPTIONS.find((o) => o.mode === mode) ?? OPTIONS[2];
  const TriggerIcon = resolved === "dark" ? MoonIcon : SunIcon;

  return (
    <div ref={boxRef} data-display-pop className="relative" style={noDrag}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={t("Display · {label}", { label: t(current.label) })}
        aria-label={t("Display")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-8 w-8 place-items-center rounded-full text-dim transition-colors hover:bg-hover hover:text-fg"
      >
        <TriggerIcon />
      </button>
      {open && (
        <div
          ref={menuRef}
          data-overlay
          role="menu"
          aria-label={t("Display")}
          onKeyDown={keys}
          className="cb-pop absolute right-0 top-full z-50 mt-1.5 w-48 rounded-2xl p-1.5"
        >
          <div role="group" aria-label={t("Theme")}>
            {OPTIONS.map(({ mode: m, label, Icon }) => (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={mode === m}
                onClick={() => choose(m)}
                className={`${menuRow} text-[13px] font-medium ${
                  mode === m ? "bg-hover text-fg" : "text-dim hover:text-fg focus-visible:text-fg"
                }`}
              >
                {/* The icon of the chosen row in foreground colour like its text (`.cb-menu-symbol` dims it otherwise). */}
                <span aria-hidden className={`${menuSymbol}${mode === m ? " text-fg" : ""}`}><Icon size={14} /></span>
                <span className="flex-1">{t(label)}</span>
                {mode === m && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
          <MenuSeparator />
          <TextSizeSteps />
        </div>
      )}
    </div>
  );
}
