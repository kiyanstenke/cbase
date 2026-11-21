"use client";

import { useSyncExternalStore } from "react";
import { reportTextSize } from "./shell-bridge.js";

// ── Appearance: the text size of the WHOLE app ──────────────────────────────────────────────────
//
// A device preference like the color scheme (theme.ts): it lives in localStorage and does not go to the server; the desktop screen
// and the laptop do not want the same size, and a value from the DB would only be there after the first fetch.
//
// Mechanism: the factor stands as `--cb-text-scale` on <html>. It is inserted AT BUILD TIME: the PostCSS plugin
// `web/postcss-text-scale.cjs` rewrites every absolute font size and line height of the CSS to `… * var(--cb-text-scale, 1)` (fonts
// with a lower bound of 9 px, see `textPx`). Every size thus grows in the same ratio: a heading stays larger than its paragraph, a
// meta line smaller. Spacing, icons and fixed heights stay. At "Normal" the variable is not on <html> at all (the 1 from the fallback
// applies), so the app is character-identical to the old one there.
//
// What the plugin does not see (inline styles of CodeMirror, the number xterm gets) is computed by `textPx`/`textCount` here; a guard
// in web/test/textScale.test.mjs holds every numeric `fontSize` in TSX to these two helpers.
//
// No `zoom`: it would shift the measured block heights of the memory brake (lib/contain) and put `fixed` menus beside their triggers.
// And no continuous slider: every change re-measures all memory brakes (2–16 ms plus two frames).

export type TextLevel = "compact" | "small" | "normal" | "large" | "veryLarge";

/** The selectable levels, ascending. `label` is the dictionary key, `factor` the ratio to today's size. The factors are exactly the old
 *  chat levels divided by 15.5 px, so whoever had "Large" keeps chat prose of exactly 17 px. The raw values (`key`) are the same as on iOS
 *  (`TextSizeStore`, `cbase.mobile.textSize`). */
export const TEXT_LEVELS: { key: TextLevel; label: string; factor: number }[] = [
  { key: "compact", label: "Compact##adjective", factor: 13.5 / 15.5 },
  { key: "small", label: "Small", factor: 14.5 / 15.5 },
  { key: "normal", label: "Normal", factor: 1 },
  { key: "large", label: "Large", factor: 17 / 15.5 },
  { key: "veryLarge", label: "Extra large", factor: 19 / 15.5 },
];
export const TEXT_STANDARD: TextLevel = "normal";

export const TEXT_SIZE_KEY = "cbase-text-size";
/** The legacy key: the chat prose in px (12…24). It stays for ONE release so that a a rollback to an older release still reads it harmlessly;
 *  a follow-up removes it. */
export const LEGACY_CHAT_FS_KEY = "cbase-chat-fs";
const LEGACY_BASE = 15.5;
const LEGACY_MIN = 12;
const LEGACY_MAX = 24;

/** Lower bound of the font in px; applies only at a factor < 1 (the same number as in the plugin). */
export const TEXT_LOWER_LIMIT = 9;

/** Event on `window` after every change. The memory brake (lib/contain) listens to it centrally; CodeMirror and xterm re-measure. */
export const TEXT_SIZE_EVENT = "cbase-text-size";

function isStage(v: unknown): v is TextLevel {
  return typeof v === "string" && TEXT_LEVELS.some((s) => s.key === v);
}

/** The nearest level to an old px value (13.5 → compact, 17 → large, 16 → normal). On a tie the smaller wins. Nonsense yields null. */
export function stageFromOldPx(px: number): TextLevel | null {
  if (!Number.isFinite(px) || px < LEGACY_MIN || px > LEGACY_MAX) return null;
  let best: TextLevel = TEXT_STANDARD;
  let gap = Infinity;
  for (const s of TEXT_LEVELS) {
    const d = Math.abs(s.factor * LEGACY_BASE - px);
    if (d < gap - 1e-9) { gap = d; best = s.key; }
  }
  return best;
}

export function factorOf(stage: TextLevel): number {
  return TEXT_LEVELS.find((s) => s.key === stage)?.factor ?? 1;
}

/** Percent for display ("110 %"), rounded; the factors themselves are uneven. */
export function percentOf(stage: TextLevel): number {
  return Math.round(factorOf(stage) * 100);
}

// Inline script for layout.tsx: sets the variable BEFORE the first paint so a user with a large font sees no jump on load (the same
// construction as THEME_INIT_SCRIPT). It reads the new key first, without it the old one (with the same mapping as `stageFromOldPx`),
// and WRITES nothing: the migration is done by the first getter call after hydration.
export const APPEARANCE_INIT_SCRIPT =
  "(function(){try{var S=" +
  JSON.stringify(TEXT_LEVELS.map((s) => [s.key, s.factor])) +
  ",k=localStorage.getItem('" + TEXT_SIZE_KEY + "'),f=null,i;" +
  "for(i=0;i<S.length;i++)if(S[i][0]===k)f=S[i][1];" +
  "if(f===null&&k===null){var v=parseFloat(localStorage.getItem('" + LEGACY_CHAT_FS_KEY + "'));" +
  "if(v>=" + LEGACY_MIN + "&&v<=" + LEGACY_MAX + "){var d=1/0;for(i=0;i<S.length;i++){var a=Math.abs(S[i][1]*" + LEGACY_BASE + "-v);if(a<d-1e-9){d=a;f=S[i][1];}}}}" +
  "if(f!==null&&f!==1)document.documentElement.style.setProperty('--cb-text-scale',String(f));}catch(e){}})();";

/** The stored level. If the new key is missing, the old chat value applies, and the first call writes it as a level under the new
 *  key (the old one stays, see LEGACY_CHAT_FS_KEY). */
export function getTextSize(): TextLevel {
  if (typeof localStorage === "undefined") return TEXT_STANDARD;
  try {
    const fresh = localStorage.getItem(TEXT_SIZE_KEY);
    if (isStage(fresh)) return fresh;
    if (fresh !== null) return TEXT_STANDARD; // nonsense under the new key: do not fall back to the old one
    const old = stageFromOldPx(parseFloat(localStorage.getItem(LEGACY_CHAT_FS_KEY) ?? ""));
    if (!old) return TEXT_STANDARD;
    try { localStorage.setItem(TEXT_SIZE_KEY, old); } catch { /* private mode: then it stays read-only */ }
    return old;
  } catch {
    return TEXT_STANDARD;
  }
}

/** Write the factor to <html>; "Normal" clears the variable instead of setting "1". */
export function applyTextSize(stage: TextLevel) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (stage === TEXT_STANDARD) root.style.removeProperty("--cb-text-scale");
  else root.style.setProperty("--cb-text-scale", String(factorOf(stage)));
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setTextSize(stage: TextLevel) {
  const s = isStage(stage) ? stage : TEXT_STANDARD;
  try {
    localStorage.setItem(TEXT_SIZE_KEY, s);
  } catch {
    /* private mode or similar: then only for this session */
  }
  applyTextSize(s);
  listeners.forEach((fn) => fn());
  if (typeof window !== "undefined") {
    // The shell (client) uses it to set the check mark in the menu "View → Text size".
    reportTextSize(window, s);
    window.dispatchEvent(new Event(TEXT_SIZE_EVENT));
    // For resize listeners outside the memory brake (popover positions, measured bars): a font reflow is the same situation for them as
    // another window size.
    window.dispatchEvent(new Event("resize"));
  }
}

/** One level larger (+1), smaller (−1) or back to Normal (0). It stops at the edge. Returns the new level.
 *
 *  If nothing changes (⌘+ at "Extra large", ⌘− at "Compact", ⌘0 at "Normal"), nothing is set either: `setTextSize` re-measures every
 *  memory brake and reports a `resize`, and that closes every open kit menu. */
export function step(direction: 1 | -1 | 0): TextLevel {
  const now = getTextSize();
  let fresh: TextLevel = TEXT_STANDARD;
  if (direction !== 0) {
    const i = TEXT_LEVELS.findIndex((s) => s.key === now);
    const j = Math.max(0, Math.min(TEXT_LEVELS.length - 1, (i < 0 ? 2 : i) + direction));
    fresh = TEXT_LEVELS[j].key;
  }
  if (fresh !== now) setTextSize(fresh);
  return fresh;
}

/** Reactive level. The server snapshot is "Normal" (matches the prerendered HTML); after hydration the stored value takes over. */
export function useTextSize(): TextLevel {
  return useSyncExternalStore(subscribe, getTextSize, () => TEXT_STANDARD);
}

/** Listen for text-size changes; returns the unsubscriber. For targets that are not in CSS (xterm gets a number, CodeMirror measures
 *  its lines). */
export function listenTextSize(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(TEXT_SIZE_EVENT, fn);
  return () => window.removeEventListener(TEXT_SIZE_EVENT, fn);
}

/** The same formula as the plugin, as a CSS value for inline styles: at factor 1 exactly `n` px, below that never smaller than 9 px
 *  (and what is already below it never smaller than it is). Works LIVE: the browser resolves the variable, a style using it need not
 *  be rebuilt. */
export function textPx(n: number): string {
  const v = `${n}px`;
  return `max(min(${v}, ${TEXT_LOWER_LIMIT}px), calc(${v} * var(--cb-text-scale, 1)))`;
}

/** The same calculation as a number, for targets without CSS (xterm, canvas): rounded to whole px. Reads the STORED level; whoever
 *  holds it listens for changes via `listenTextSize`. */
export function textCount(n: number, stage: TextLevel = getTextSize()): number {
  const f = factorOf(stage);
  return Math.round(Math.max(Math.min(n, TEXT_LOWER_LIMIT), n * f));
}
