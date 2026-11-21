// The rules of the search/replace widget; pure, without DOM; drawn in components/code/search-widget.ts. Every rule is modelled on VS Code
// (src/vs/editor/contrib/find):
//
// - `searchSeed` (`getSelectionSearchString`, `StartFindAction`, `StartFindReplaceAction`): Cmd+F takes the selection as search text, without
//   a selection the word at the caret; a selection across several lines takes NOTHING (the previous search text stays). Alt+Cmd+F (Ctrl+H)
//   takes only a non-empty selection within one line and puts focus into the replace field if it came from the search field or something
//   was taken over. If focus is already in the widget, NOTHING is taken over (otherwise `fo+` would become the hit `fooo`). In regex mode
//   the text is escaped.
// - `searchKey`: what a key does in the widget: Enter / Shift+Enter in the search field, Enter / Cmd+Enter (Ctrl+Enter) in the replace
//   field, Esc, the toggles (Alt+Cmd+C/W/R/L/P, otherwise Alt+…), Tab from search to replace field and Shift+Tab back, Up/Down page through
//   the history.
// - `SearchHistory` (`HistoryInputBox`): Up fetches the previous entry (a new text enters the history itself in the process), Down the
//   next, behind the last stands an empty field. At most HISTORY_MAX entries, each once.
// - `regexError`: the message of an invalid regular expression as VS Code shows it (`new RegExp(value, "gu")`).
// - `replacementFor`: the replacement text of a hit: `$&`, `$$`, `$1…` in regex mode like @codemirror/search, otherwise literal.
//
// Tested EXECUTED in web/test/editor-look.test.mjs (with sabotages).

/** VS Code `SEARCH_STRING_MAX_LENGTH`: longer selections are not taken over. */
export const SEED_MAX = 524288;
export const HISTORY_MAX = 50;

export const maskRegex = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

export type SeedSituation = {
  /** The selected text; null for an empty selection. */
  selection: string | null;
  multiline: boolean;
  /** The word at the caret (asked only for an empty selection). */
  word: string | null;
  /** Focus is in the widget (search or replace field, button). */
  inWidget: boolean;
  /** Focus is in the search field. */
  inSearchField: boolean;
  regexp: boolean;
};
/** `seed`: the new search text (null = the previous one stays); `focus`: where focus goes. */
export function searchSeed(l: SeedSituation, replace: boolean): { seed: string | null; focus: "search" | "replace" } {
  let raw: string | null = null;
  if (!l.inWidget && !l.multiline) {
    if (replace) raw = l.selection;
    else raw = l.selection ?? l.word;
  }
  if (raw != null && (!raw || raw.length >= SEED_MAX)) raw = null;
  const seed = raw == null ? null : l.regexp ? maskRegex(raw) : raw;
  return { seed, focus: replace && (l.inSearchField || seed != null) ? "replace" : "search" };
}

export type Toggle = "caseSensitive" | "wholeWord" | "regexp" | "inSelection" | "preserveCase";
/** The letters of the toggles (Alt+Cmd + letter, otherwise Alt + letter). */
export const TOGGLE_KEYS: Record<Toggle, string> = { caseSensitive: "C", wholeWord: "W", regexp: "R", inSelection: "L", preserveCase: "P" };

export type SearchAction =
  | { kind: "further" } | { kind: "back" } | { kind: "replace" } | { kind: "allReplace" } | { kind: "close" }
  | { kind: "toggle"; toggle: Toggle } | { kind: "toReplace" } | { kind: "toSearch" } | { kind: "historyBack" } | { kind: "historyBefore" };
type Press = { key: string; code: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean };

export function searchKey(e: Press, field: "search" | "replace" | "other", mac: boolean, replaceOpen: boolean): SearchAction | null {
  const option = mac ? e.altKey && e.metaKey && !e.ctrlKey : e.altKey && !e.metaKey && !e.ctrlKey;
  if (option && !e.shiftKey) {
    for (const [s, b] of Object.entries(TOGGLE_KEYS) as [Toggle, string][]) if (e.code === `Key${b}`) return { kind: "toggle", toggle: s };
  }
  if (e.key === "Escape") return { kind: "close" };
  const mod = mac ? e.metaKey : e.ctrlKey;
  const without = !e.altKey && !e.metaKey && !e.ctrlKey;
  if (e.key === "Enter" && field === "search" && without) return { kind: e.shiftKey ? "back" : "further" };
  if (e.key === "Enter" && field === "replace" && !e.shiftKey && !e.altKey) return mod ? { kind: "allReplace" } : without ? { kind: "replace" } : null;
  if (e.key === "Tab" && without && !e.shiftKey && field === "search" && replaceOpen) return { kind: "toReplace" };
  if (e.key === "Tab" && without && e.shiftKey && field === "replace") return { kind: "toSearch" };
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && without && !e.shiftKey && field !== "other") return { kind: e.key === "ArrowUp" ? "historyBack" : "historyBefore" };
  return null;
}

export class SearchHistory {
  private readonly e: string[] = [];
  /** The entry currently in the field; `e.length` means: behind the last. */
  private i = 0;
  constructor(readonly max = HISTORY_MAX) {}
  get entries(): readonly string[] { return this.e; }
  add(value: string): void {
    if (!value) return;
    const k = this.e.indexOf(value);
    if (k >= 0) this.e.splice(k, 1);
    this.e.push(value);
    if (this.e.length > this.max) this.e.shift();
    this.i = this.e.length - 1;
  }
  /** Up: the previous entry; null if there is none (the field stays). */
  back(current: string): string | null {
    if (current && !this.e.includes(current)) this.add(current);
    let i = Math.min(this.i, this.e.length);
    if (this.e[i] === current) i -= 1;
    else if (i >= this.e.length) i = this.e.length - 1;
    if (i < 0) return null;
    this.i = i;
    return this.e[i];
  }
  /** Down: the next entry; behind the last an empty field; null if the field already stands empty behind the last. */
  before(current: string): string | null {
    if (current && !this.e.includes(current)) this.add(current);
    if (this.i >= this.e.length) return null;
    const i = this.e[this.i] === current ? this.i + 1 : this.i;
    this.i = Math.min(i, this.e.length);
    return this.i >= this.e.length ? "" : this.e[this.i];
  }
}

/** The message of an invalid regular expression (VS Code: `new RegExp(value, "gu")`); null: valid or not regex mode. */
export function regexError(value: string, regexp: boolean): string | null {
  if (!regexp || !value) return null;
  try { new RegExp(value, "gu"); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** The replacement text of a hit: in regex mode `$&` (the hit), `$$` ($), `$n` (group: the longest number that is a group), like
 *  @codemirror/search; otherwise literal. */
export function replacementFor(replacement: string, regexp: boolean, hits: readonly string[] | null): string {
  if (!regexp || !hits) return replacement;
  return replacement.replace(/\$([$&]|\d+)/g, (m, i: string) => {
    if (i === "&") return hits[0];
    if (i === "$") return "$";
    for (let l = i.length; l > 0; l--) {
      const n = +i.slice(0, l);
      if (n > 0 && n < hits.length) return (hits[n] ?? "") + i.slice(l);
    }
    return m;
  });
}
