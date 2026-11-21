"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DE } from "./i18n-de";

// Central language logic (English/German). The English UI strings are the dictionary KEYS;
// DE in i18n-de.ts supplies the German translation. A missing entry falls back to English
// (never to an empty string). A key may carry a context suffix "##<context>" where one English
// text needs two German ones ("Open" the verb vs. "Open##state"); the suffix is never shown.
// The language lives in localStorage and is additionally reported to the backend
// (PUT /api/ui-lang) so that server-side messages speak the same language.

export type Lang = "de" | "en";

const KEY = "cbase-lang";

// Inline script for layout.tsx: sets <html lang> BEFORE hydration so that
// getLang() returns the real language from the first client render.
export const LANG_INIT_SCRIPT =
  "(function(){try{var l=localStorage.getItem('" +
  KEY +
  "');if(l!=='en'&&l!=='de')l=/^de\\b/i.test(navigator.language||'')?'de':'en';document.documentElement.lang=l;}catch(e){}})();";

const listeners = new Set<() => void>();

export function getLang(): Lang {
  if (typeof document === "undefined") return "en";
  return document.documentElement.lang === "de" ? "de" : "en";
}

// Switch language: localStorage + <html lang> + re-render all useLang/useT users
// + inform the backend (fire-and-forget, best effort).
export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* private mode or similar — then only for this session */
  }
  document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
  syncLangToBackend(l);
}

// Backend sync (server-side error messages/auto titles). Also called at app
// start (TopNav) so DB setting and localStorage never drift. Carries the device's time zone:
// the server writes clock times in history and notifications (clockText in server/backend/electron/server/i18n.js) — in the
// container otherwise in UTC.
export function syncLangToBackend(l?: Lang) {
  try {
    let zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* without Intl: omit the field */ }
    fetch("/api/ui-lang", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(zone ? { lang: l ?? getLang(), zone } : { lang: l ?? getLang() }),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Reactive language for components. The server snapshot is always "en" (matches
// the prerendered HTML); after hydration the real value takes over.
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "en");
}

// The text shown for a key in English: the key without its context suffix.
function plain(key: string): string {
  const i = key.indexOf("##");
  return i < 0 ? key : key.slice(0, i);
}

// Replace {name} placeholders.
function fmt(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// Non-reactive translation — for code outside components (handlers,
// helper functions). In component render paths use useT() instead,
// otherwise the re-render on a language switch is missing.
export function tr(key: string, params?: Record<string, string | number>): string {
  const s = getLang() === "de" ? (DE[key] ?? plain(key)) : plain(key);
  return fmt(s, params);
}
// components/Markdown.tsx has no project imports (its test compiles it alone) and finds `tr` here instead.
(globalThis as Record<symbol, unknown>)[Symbol.for("cbase.tr")] = tr;

// Reactive translation function for components: const t = useT();
// The function is STABLE as long as the language stays the same: it travels as a prop into
// memoized components (chat history), and a new identity on every render would have
// silently defeated every memoization there.
export function useT() {
  const lang = useLang();
  return useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const s = lang === "de" ? (DE[key] ?? plain(key)) : plain(key);
      return fmt(s, params);
    },
    [lang],
  );
}

// Locale for date/number formatting (toLocaleString etc.).
export function dateLocale(): string {
  return getLang() === "en" ? "en-US" : "de-DE";
}
