// The code editor's settings (font size, tab width, wrap, minimap, format on save, preview editors): ONE place for defaults, saving and
// reading.
//
// Like VS Code's settings.json: ONLY what deviates from the default is saved (plus the marker `v`), so a new default applies to everyone
// who never chose the value. The WHOLE object used to be stored in the browser; the font size 13 in it was the then default, not a
// choice, so in a state without the marker it drops when read (otherwise every earlier user would stay on 13 instead of VS Code's 12).
//
// Who reads: CodePane (the editor), DiffTab and the definition preview (components/code/lsp-peek.ts); VS Code draws diff and peek in
// `editor.fontSize`. All follow changes through `subscribeCodeSettings`, also from another window (`storage`).
//
// Pure except for localStorage/window (both guarded by try/typeof): `fromStorage`/`forStorage` are run in web/test/suggestion-list.test.mjs
// (the “settings” check, with sabotage), the readers there among the bindings.
import { EDITOR_FONT_SIZE } from "./editor-defaults";

export type CodeSettings = { fontSize: number; tabSize: number; wordWrap: boolean; minimap: boolean; formatOnSave: boolean; preview: boolean };
/** The defaults (font size like VS Code on the Mac, lib/editor-defaults.ts). */
export const CODE_DEFAULTS: Readonly<CodeSettings> = Object.freeze({
  fontSize: EDITOR_FONT_SIZE, tabSize: 2, wordWrap: false, minimap: true, formatOnSave: false, preview: true,
});
export const CODE_SETTINGS_KEY = "cbase-code-settings";
/** The marker of a state that only carries deviations. */
const REVISION = 2;
/** The font-size default of the earlier version: in a state without the marker it was not chosen. */
const OLD_FONT_SIZE = 13;
const KEY = Object.keys(CODE_DEFAULTS) as (keyof CodeSettings)[];
const matches = (k: keyof CodeSettings, v: unknown) =>
  typeof CODE_DEFAULTS[k] === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === typeof CODE_DEFAULTS[k];

/** Stored → settings. Missing, unknown and wrongly typed fields count as the default. */
export function fromStorage(raw: unknown): CodeSettings {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...CODE_DEFAULTS };
  for (const k of KEY) if (matches(k, s[k])) out[k] = s[k];
  if (s.v !== REVISION && s.fontSize === OLD_FONT_SIZE) out.fontSize = CODE_DEFAULTS.fontSize;
  return out as CodeSettings;
}
/** Settings → stored: the marker and only what deviates from the default. */
export function forStorage(e: CodeSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { v: REVISION };
  for (const k of KEY) if (e[k] !== CODE_DEFAULTS[k]) out[k] = e[k];
  return out;
}

let state: CodeSettings | null = null;
const subscribers = new Set<() => void>();
let listens = false;
const report = () => { for (const f of [...subscribers]) f(); };

/** The state now (read once, then remembered; without a browser the defaults). The same object until the next change. */
export function readCodeSettings(): CodeSettings {
  if (typeof window === "undefined") return CODE_DEFAULTS;
  if (!state) {
    try { state = fromStorage(JSON.parse(localStorage.getItem(CODE_SETTINGS_KEY) || "null")); } catch { state = { ...CODE_DEFAULTS }; }
  }
  return state;
}
/** Change and remember (only the deviations); every subscriber learns of it. */
export function saveCodeSettings(part: Partial<CodeSettings>): CodeSettings {
  state = { ...readCodeSettings(), ...part };
  try { localStorage.setItem(CODE_SETTINGS_KEY, JSON.stringify(forStorage(state))); } catch { /* for this session only */ }
  report();
  return state;
}
/** Subscribe (`useSyncExternalStore` form); another window that saves reports through `storage`. */
export function subscribeCodeSettings(fn: () => void): () => void {
  subscribers.add(fn);
  if (!listens && typeof window !== "undefined") {
    listens = true;
    window.addEventListener("storage", (ev) => {
      if (ev.key !== CODE_SETTINGS_KEY) return;
      try { state = fromStorage(JSON.parse(ev.newValue || "null")); } catch { state = { ...CODE_DEFAULTS }; }
      report();
    });
  }
  return () => { subscribers.delete(fn); };
}
/** Only the font size (for `useSyncExternalStore`: a number is stable as a snapshot). */
export const editorFontSize = (): number => readCodeSettings().fontSize;
