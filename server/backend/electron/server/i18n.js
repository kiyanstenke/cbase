// UI language of the backend (German/English). The source of truth is the renderer (localStorage), mirrored via
// PUT /api/ui-lang and persisted in app_settings.ui_lang. T() localizes server-side, USER-VISIBLE texts (error messages,
// notifications, auto titles). LLM-/MCP-facing prompts are written in English directly and never go through T().
import { DE } from "./i18n-de.js";

// The language until a client reports its own (web and iOS follow the system language and sync it via PUT /api/ui-lang):
// English, or what the operator sets with CBASE_UI_LANG=de. The test runner sets de, because the backend tests read the German
// output of the translation table.
const DEFAULT_LANG = process.env.CBASE_UI_LANG === "de" ? "de" : "en";
let uiLang = DEFAULT_LANG;

// Whoever must hear a CHANGE of language: lsp/sessions.js restarts the language servers whose messages still speak the old
// language immediately (like VS Code, which restarts the app when the display language changes). Only on a real change —
// the sync at app start (PUT /api/ui-lang with the same language) calls nobody.
const switchListeners = new Set();
export function atUiLangSwitch(fn) {
  switchListeners.add(fn);
  return () => switchListeners.delete(fn);
}

export function setUiLang(l) {
  const prior = uiLang;
  uiLang = l === "de" || l === "en" ? l : DEFAULT_LANG;
  if (uiLang === prior) return;
  for (const fn of [...switchListeners]) {
    try { fn(uiLang, prior); } catch (e) { console.warn("[ui-lang] language switch listener:", e?.message || e); }
  }
}

export function getUiLang() {
  return uiLang;
}

/** The text shown for a key in English: the key without its context suffix ("Open##state" → "Open"). */
const plain = (key) => { const i = key.indexOf("##"); return i < 0 ? key : key.slice(0, i); };

/**
 * Localizes a user-visible server text. English is the source, German comes from i18n-de.js.
 *   T("Chat not found")            plain text
 *   T`Port ${port} is taken`       template: the key is "Port {} is taken", the German text names the values as {0}, {1} …
 *   T("Open##state")               context suffix where one English text needs two German ones; it is never shown
 * The language is chosen at the call: a module constant holds a function that calls T, never a translated text.
 */
export function T(first, ...values) {
  if (Array.isArray(first) && Array.isArray(first.raw)) {
    const de = uiLang === "de" ? DE[first.join("{}")] : undefined;
    if (de !== undefined) return de.replace(/\{(\d+)\}/g, (m, i) => String(values[Number(i)]));
    let out = first[0];
    for (let i = 0; i < values.length; i++) out += String(values[i]) + first[i + 1];
    return out;
  }
  return uiLang === "de" ? (DE[first] ?? plain(first)) : plain(first);
}

// The human's time zone — for every clock time the SERVER writes into a text (history rows, notification/push, wait sentence,
// hints). The user container runs in UTC; a time in the process's zone was wrong there for the human by the zone offset, and a
// push text cannot be converted in the client any more. Source: the client reports it with the language (PUT /api/ui-lang, field
// `zone` — a missing field means "unchanged", an invalid one is ignored and does not tip the language switch, `zoneRejected`),
// persisted in app_settings.ui_zone and loaded at start (server.js), like ui_lang.
let uiZone = "";

export function zoneValid(z) {
  if (!z || typeof z !== "string") return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; }
}
export function setUiZone(z) {
  const v = String(z || "").trim();
  uiZone = zoneValid(v) ? v : "";
  return uiZone;
}
export const getUiZone = () => uiZone;

// The ONE formatting of a clock time for server texts. Fallback of the zone, in this order:
//   1. the argument `zone` (a caller that knows the zone of its subject — schedule, workspace),
//   2. the zone of the human reported by the client (uiZone),
//   3. outside the container the process's zone — in the local server that is the Mac's zone, hence right,
//   4. in the container (CBASE_CONTAINER=1) without a known zone UTC WITH the label " UTC": never silently wrong.
// Spelling as clockText always had: day.month and time, locale from the UI language (de-DE or en-GB).
export function clockText(ts, { withDate = true, zone = "" } = {}) {
  if (!ts) return "";
  const z = zoneValid(zone) ? zone : uiZone;
  const inContainer = process.env.CBASE_CONTAINER === "1";
  const opts = { ...(withDate ? { day: "2-digit", month: "2-digit" } : {}), hour: "2-digit", minute: "2-digit" };
  if (z) opts.timeZone = z;
  else if (inContainer) opts.timeZone = "UTC";
  const text = new Date(ts).toLocaleString(uiLang === "en" ? "en-GB" : "de-DE", opts);
  return !z && inContainer ? `${text} UTC` : text;
}
