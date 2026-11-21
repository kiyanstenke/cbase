"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { reportThemeMode } from "./shell-bridge.js";

// Central theme logic. The mode is kept in localStorage; "system" follows the macOS appearance. The resolved theme
// (light|dark) is set as <html data-theme="…">, which the CSS variables in globals.css switch on.
//
// In the Electron shell the main process learns the CHOSEN mode too (`cbaseShell.setTheme`, lib/shell-bridge.ts): it sets
// `nativeTheme.themeSource`, and AppKit colors the native window buttons to match the page. Left unset, the window sat on
// DarkAqua with a dark system, and on a light page the buttons had contrast 1.00 without focus — invisible. The report happens
// in TWO places, both below: in the init script (before the first paint, also on the client's login page where no header
// exists yet) and in applyMode (start and switching).

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const KEY = "cbase-theme";

// Inline script for the start of <head>/body: sets data-theme BEFORE the first paint so dark users see no light flash.
// Deliberately a compact string.
// Afterwards it reports the chosen mode to the shell — the same mapping as getStoredMode (anything but light/dark is "system")
// and the same contract as reportThemeMode; a copy, because the script runs before any module (preload.cjs exposes the bridge
// BEFORE the page scripts).
// The mapping applies to data-theme too: otherwise the script painted an unknown stored value light while getStoredMode read it
// as "system" — with a dark system the page jumped after mount (caught by the guard that runs both against each other).
// Why here and not only in applyMode: in the client the header (and with it ThemeToggle) sits behind the GatewayGate — during
// login and "starting server environment…" nobody would report otherwise, and the shell would keep hiding the window buttons
// on focus loss for this window. The report comes AFTER data-theme: a throw from the bridge then costs only the report.
// web/test/window-buttons-theme.test.mjs runs the script against getStoredMode/resolveMode.
export const THEME_INIT_SCRIPT =
  "(function(){try{var m=localStorage.getItem('" +
  KEY +
  "');m=m==='light'||m==='dark'?m:'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';" +
  "var s=window.cbaseShell;if(s&&typeof s.setTheme==='function')s.setTheme(m);}catch(e){}})();";

export function getStoredMode(): ThemeMode {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveMode(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode;
}

// Apply the resolved theme to the <html> element — and report the CHOSEN mode to the shell.
// Callers: setThemeMode (switching) and ThemeToggle (start after mount, OS switch in "System" mode). No other path sets
// data-theme — the guard for that is in web/test/window-buttons-theme.test.mjs.
//
// The offset afterwards is measured (throwaway window with Electron 37.10.3 AND 44.4.4, system dark): right after `setTheme`
// matchMedia still returns the OLD forced value — the report goes out as IPC —, 10–19 ms later the `change` event fires with
// the new one. On a switch light → system with a dark system resolveMode thus still computes "light" here, and only the
// matchMedia listener in ThemeToggle catches up to "dark" (it asks getStoredMode, which already says "system") — the same
// situation at start when the shell still holds a different mode than this origin. light/dark do not read matchMedia at all;
// an OS switch in light/dark mode no longer changes matchMedia (the shell pins it) and so fires nothing.
export function applyMode(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveMode(mode);
  reportThemeMode(typeof window === "undefined" ? null : window, mode);
}

// Save + apply the mode (used by the header switch and Settings → Appearance). Both show the chosen mode — so all
// `useThemeMode` users learn of the change, otherwise the header switch would still show the old check mark.
export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private mode or similar — then only for this session */
  }
  applyMode(mode);
  listeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Reactive CHOSEN mode (light|dark|system) — not the resolved theme. The server snapshot is "system" (matches the
// pre-rendered HTML), after hydration the stored value takes over; see the hydration note at useResolvedTheme.
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getStoredMode, () => "system");
}

// Reactive, resolved theme for components that cannot take colors via CSS variable (xterm, CodeMirror syntax).
// Observes data-theme directly, so it catches both the switch and system changes.
export function useResolvedTheme(): ResolvedTheme {
  // IMPORTANT: initially ALWAYS "light" — that matches the server-side pre-rendered HTML (no document/data-theme there).
  // Reading the real data-theme here would give dark users a hydration mismatch (React #418): the server renders e.g.
  // the sun icon, the client the moon icon → React discards the tree and removes data-theme in the process. The real
  // theme is only taken over after mount in the effect.
  const [theme, setTheme] = useState<ResolvedTheme>("light");
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setTheme(el.dataset.theme === "dark" ? "dark" : "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}
