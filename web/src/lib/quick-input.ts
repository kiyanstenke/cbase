// Quick Input, styled like VS Code: the pure computations of the command palette window, without DOM and without network, read in VS Code 1.143
// (`quickInput.ts`, `quickInputList.ts`, `anythingQuickAccess.ts`, `commandsQuickAccess.ts`, `gotoLineQuickAccess.ts`,
// `gotoSymbolQuickAccess.ts`, `symbolsQuickAccess.ts`, `helpQuickAccess.ts`):
//
//   Position      width `min(window × 0.62, 600)`, at the top of the area, horizontally centered over it; the list at most `min(window × 0.4, 440)`.
//   Key caps      "⇧⌘P" → [⇧][⌘][P], "⌘K ⌘S" → two chords (macOS: every modifier its own cap).
//   Keys          Down/Up (also Ctrl+N/Ctrl+P and Ctrl+Down/Ctrl+Up) round-robin, PageDown/PageUp by page, Ctrl+Home/Ctrl+End to the ends (the bare
//                 keys belong to the input field), Cmd+Down/Cmd+Up to the next/previous group.
//   History       recently opened files (200, `workbench.editor.history`), recently used commands (50, `workbench.commandPalette.history`).
//   Cmd+P         the input split (`file:12:4`, `file@symbol`), the rows from history and file results with separators.
//   Commands (`>`) filter `matchesContiguousSubString` or `matchesWords`, history first, then by name; separators "recently used" and
//                 "other commands".
//   Line (`:`)    the computation of `parsePosition` (row, column in visible columns with tab, negative numbers from the end, `::` characters).
//   Symbols (`@`) flat by position, "Symbols (n)", `@:` by category with counts; an empty input selects the symbol at the cursor.
//   Help (`?`)    the prefixes with their description, sorted by prefix, "…" for none.
//
// EXECUTED in web/test/quick-input.test.mjs, every computation with a sabotage its check must catch.
import {
  prepareRequest, evaluateEntry, FILE_ACCESS, FILE_ACCESS_NAME, scoreFuzzy, compareEntries, wordFilter,
  type Request, type Storage, type Hits,
} from "./fuzzy-scorer.js";

// ── Position and shape ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const QI_WIDTH_SHARE = 0.62;
export const QI_WIDTH_MAX = 600;
export const QI_ROW = 22;
export const QI_LIST_SHARE = 0.4;
export const QI_LIST_MAX = 440;
/** The progress under the input only after this much work (VS Code `QuickInput.busy`: `busyDelay` 800 ms), so a quick answer does not flicker. */
export const QI_PROGRESS_MS = 800;
/** Where the window stands: `anchor` = the area over which it is centered and at whose top edge it begins (VS Code: below the window's
 *  title bar). Without an anchor the window's middle at the top. Never beyond the edge. */
export function quickInputSituation(window: { width: number; height: number }, anchor: { top: number; left: number; width: number } | null):
  { top: number; left: number; width: number; listMax: number } {
  const width = Math.floor(Math.min(window.width * QI_WIDTH_SHARE, QI_WIDTH_MAX));
  const middle = anchor ? anchor.left + anchor.width / 2 : window.width / 2;
  const left = Math.round(Math.max(0, Math.min(middle - width / 2, window.width - width)));
  const top = Math.round(Math.max(0, anchor ? anchor.top : 0));
  const listMax = Math.floor(Math.min(window.height * QI_LIST_SHARE, QI_LIST_MAX));
  return { top, left, width, listMax };
}

/** The key caps of a shortcut (macOS notation of the command table): per chord the modifiers singly, then the key. */
export function clipKeys(shortcut: string | null | undefined): string[][] {
  const out: string[][] = [];
  for (const chord of String(shortcut ?? "").trim().split(/\s+/).filter(Boolean)) {
    const clip: string[] = [];
    let i = 0;
    while (i < chord.length && "⌃⌥⇧⌘".includes(chord[i])) clip.push(chord[i++]);
    if (i < chord.length) clip.push(chord.slice(i));
    out.push(clip);
  }
  return out;
}

// ── Keys in the list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Movement = "next" | "previous" | "pageBefore" | "pageBack" | "first" | "last" | "nextGroup" | "previousGroup";
type Press = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };
/** The movement for a key press in the input (VS Code `quickInput.*`, `workbench.action.quickOpenSelectNext/Previous`); null: the
 *  key belongs to the input field. */
export function movementToKey(e: Press, mac: boolean): Movement | null {
  const k = e.key;
  // To the next/previous group: Cmd+Down/Cmd+Up on the Mac, otherwise Alt+Down/Alt+Up (VS Code `quickInput.nextSeparatorWithQuickAccessFallback`).
  const group = mac ? e.metaKey : e.altKey;
  if (k === "ArrowDown" && group && !e.shiftKey) return "nextGroup";
  if (k === "ArrowUp" && group && !e.shiftKey) return "previousGroup";
  if (k === "ArrowDown") return "next";
  if (k === "ArrowUp") return "previous";
  if (mac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (k === "n" || k === "N")) return "next";
  if (mac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (k === "p" || k === "P")) return "previous";
  if (k === "PageDown") return "pageBefore";
  if (k === "PageUp") return "pageBack";
  // Ctrl+Home/Ctrl+End (VS Code `quickInput.first`/`.last`: WinCtrl on the Mac, Ctrl otherwise); the bare keys stay in the input field.
  if (k === "Home" && e.ctrlKey) return "first";
  if (k === "End" && e.ctrlKey) return "last";
  return null;
}
/** The new selection: Down/Up round-robin, by page and to the ends without wrapping; groups via `groupsBeginnings` (indices of the
 *  rows that begin a group). Without rows it stays at 0. */
export function moveChoice(choice: number, count: number, b: Movement, page: number, groupsBeginnings: readonly number[] = []): number {
  if (count <= 0) return 0;
  const w = Math.max(0, Math.min(choice, count - 1));
  const s = Math.max(1, Math.floor(page));
  switch (b) {
    case "next": return (w + 1) % count;
    case "previous": return (w - 1 + count) % count;
    case "pageBefore": return Math.min(w + s, count - 1);
    case "pageBack": return Math.max(w - s, 0);
    case "first": return 0;
    case "last": return count - 1;
    case "nextGroup": { const n = groupsBeginnings.find((i) => i > w); return n ?? (groupsBeginnings.length ? groupsBeginnings[0] : w); }
    case "previousGroup": {
      // If the selection is inside a group (not at its start), it goes to that group's start; otherwise to the start of the group before.
      const before = [...groupsBeginnings].reverse().find((i) => i < w);
      return before ?? (groupsBeginnings.length ? groupsBeginnings[groupsBeginnings.length - 1] : w);
    }
  }
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const HISTORY_FILES_MAX = 200;
export const HISTORY_COMMANDS_MAX = 50;
/** An entry to the front (newest first, none twice), capped. */
export function rememberInHistory(list: readonly string[], entry: string, max: number): string[] {
  if (!entry) return [...list].slice(0, max);
  return [entry, ...list.filter((x) => x !== entry)].slice(0, Math.max(0, max));
}
export const removeFromHistory = (list: readonly string[], entry: string): string[] => list.filter((x) => x !== entry);
/** A history read back (localStorage): only strings, no duplicates, capped; anything else is empty. */
export function readHistory(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) if (typeof x === "string" && x && !out.includes(x)) out.push(x);
  return out.slice(0, max);
}

// ── Cmd+P: the input ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// VS Code `extractRangeFromFilter(filter, ["@"])`: at the end `:12`, `#12`, `(12)`, `:12:4`, `:12,4` (also "line 12"); a suffix WITHOUT a number
// (`app.ts:`, `app.ts(`) means row 1. If an `@` stands at the front, none applies; if one stands further back, only if the part behind it ends that way too.
const ROWS_PATTERN = /\s?[#:(](?:line )?(\d*)(?:[#:,](\d*))?(?:-(\d*)(?:[#:,](\d*))?)?\)?:?\s*$/;
export type FileInput = { filter: string; row: number | null; column: number | null; symbol: string | null };
/** What an input in file mode means: the filter, a row (and column) or a symbol of the selected file (`file@symbol`).
 *  `selected`: the file that was selected BEFORE this input came (VS Code `lastGlobalPicks.active`); only with it are there symbols: the
 *  LAST part behind an `@` is its filter (`getEditorSymbolPicks`); if its path itself carries an `@` (`icon@2x.png`, `src/@core/…`),
 *  only from the second `@`. Otherwise the `@` is part of the file filter. */
export function fileInput(input: string, selected: string | null = null): FileInput {
  const raw = String(input ?? "");
  const parts = raw.split("@");
  if (parts.length > 1 && selected && (!selected.includes("@") || parts.length > 2)) {
    return { filter: parts.slice(0, -1).join("@").trim(), row: null, column: null, symbol: parts[parts.length - 1].trim() };
  }
  const at = raw.indexOf("@");
  if (at === 0 || (at > 0 && !ROWS_PATTERN.test(raw.slice(at + 1)))) return { filter: raw.trim(), row: null, column: null, symbol: null };
  const m = ROWS_PATTERN.exec(raw);
  if (m) {
    const z = parseInt(m[1] ?? "", 10);
    if (Number.isFinite(z)) {
      const s = parseInt(m[2] ?? "", 10);
      return { filter: raw.slice(0, m.index).trim(), row: z, column: Number.isFinite(s) ? s : null, symbol: null };
    }
    if (m[1] === "") return { filter: raw.slice(0, m.index).trim(), row: 1, column: null, symbol: null };
  }
  return { filter: raw.trim(), row: null, column: null, symbol: null };
}

/** A pasted link (VS Code `AnythingQuickAccessProvider._getLinkPick`): `scheme://…` opens Cmd+P as a link; null: no link; `valid:
 *  false`: "Invalid link" (whitespace or "\\", the schemes command/data/javascript/private, http(s) without a host). */
export function linkTarget(input: string): { valid: true; url: string } | { valid: false } | null {
  const e = String(input ?? "");
  if (!/^[a-z][a-z0-9+.-]+:\/\//i.test(e)) return null;
  if (/\s|\\/.test(e)) return { valid: false };
  const schema = e.slice(0, e.indexOf(":")).toLowerCase();
  if (["command", "data", "javascript", "private"].includes(schema)) return { valid: false };
  // http(s) needs a host (VS Code: `URI.parse(…).authority`, not the WHATWG parser's, which reads "https:///path" as host "path").
  if (schema === "http" || schema === "https") {
    try { new URL(e); } catch { return { valid: false }; }
    if (!/^[a-z][a-z0-9+.-]+:\/\/[^/?#]/i.test(e)) return { valid: false };
  }
  return { valid: true, url: e };
}

export type FileHits = { label?: Hits[]; description?: Hits[] };
export type FileRow = { path: string; group?: string; history: boolean; hits: FileHits };
export const GROUP_LAST_OPENED = "recently opened";
export const GROUP_FILE_RESULTS = "file results";
/** The rows of Cmd+P (VS Code `AnythingQuickAccessProvider`): without a filter the history ("recently opened"); with a filter the matching history
 *  entries (scored on the name only, unless the filter contains "/", and only contiguously), sorted like Quick Open, below them "file results":
 *  the server's hits that are not already in the history (its order stays). Every row carries its highlights. */
export function fileRows(filter: string, history: readonly string[], results: readonly string[] | null, storage?: Storage): FileRow[] {
  const a = prepareRequest(filter);
  const rows: FileRow[] = [];
  if (!a.normalized) {
    history.forEach((p, i) => rows.push({ path: p, history: true, hits: {}, ...(i === 0 ? { group: GROUP_LAST_OPENED } : {}) }));
    return rows;
  }
  // VS Code `getEditorHistoryPicks`: `scoreItemFuzzy(…, allowNonContiguousMatches = false, …)`, on the name only without a path separator.
  const access = a.containsPathSeparator ? FILE_ACCESS : FILE_ACCESS_NAME;
  const inHistory = history
    .map((p) => ({ p, w: evaluateEntry(p, a, false, access, storage) }))
    .filter((x) => x.w.score > 0)
    .sort((x, y) => compareEntries(x.p, y.p, a, false, access, storage));
  inHistory.forEach((x, i) => rows.push({ path: x.p, history: true, hits: { label: x.w.labelMatch, description: x.w.descriptionMatch }, ...(i === 0 ? { group: GROUP_LAST_OPENED } : {}) }));
  const already = new Set(inHistory.map((x) => x.p));
  let first = true;
  for (const p of results ?? []) {
    if (already.has(p)) continue;
    const w = evaluateEntry(p, a, true, FILE_ACCESS, storage);
    rows.push({ path: p, history: false, hits: { label: w.labelMatch, description: w.descriptionMatch }, ...(first ? { group: GROUP_FILE_RESULTS } : {}) });
    first = false;
  }
  return rows;
}

// ── Commands (`>`) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CommandEntry = { id: string; label: string };
export type CommandRow<T extends CommandEntry> = { e: T; hits: Hits[] | undefined; group?: string; duplicate: boolean };
export const GROUP_LAST_USED = "recently used";
export const GROUP_OTHER_COMMANDS = "other commands";
/** The rows of `>` (VS Code `AbstractCommandsQuickAccessProvider`): the name matches (WORD_FILTER) or the filter is the id; first the
 *  history (newest first), then by name; "recently used" above the first one if it is in the history, "other commands" above the first one
 *  after it. Two equal names get their id as description (`duplicate`). */
export function commandRows<T extends CommandEntry>(commands: readonly T[], filter: string, history: readonly string[]): CommandRow<T>[] {
  const f = String(filter ?? "").trim();
  const rank = new Map(history.map((id, i) => [id, i]));
  const matching: { e: T; hits: Hits[] | undefined }[] = [];
  for (const e of commands) {
    const t = wordFilter(f, e.label);
    if (t) matching.push({ e, hits: f ? t : undefined });
    else if (f && f === e.id) matching.push({ e, hits: undefined });
  }
  const count = new Map<string, number>();
  for (const x of matching) count.set(x.e.label, (count.get(x.e.label) ?? 0) + 1);
  matching.sort((x, y) => {
    const rx = rank.get(x.e.id), ry = rank.get(y.e.id);
    if (rx !== undefined && ry !== undefined) return rx - ry;
    if (rx !== undefined) return -1;
    if (ry !== undefined) return 1;
    return x.e.label.localeCompare(y.e.label);
  });
  const out: CommandRow<T>[] = [];
  let other = false;
  matching.forEach((x, i) => {
    const inHistory = rank.has(x.e.id);
    let group: string | undefined;
    if (i === 0 && inHistory) { group = GROUP_LAST_USED; other = true; }
    if (other && !inHistory) { group = GROUP_OTHER_COMMANDS; other = false; }
    out.push({ e: x.e, hits: x.hits, duplicate: (count.get(x.e.label) ?? 0) > 1, ...(group ? { group } : {}) });
  });
  return out;
}

// ── Line (`:`) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What the computation needs from a document (CodeMirror `Text` satisfies it through a small adapter, see palette-modes.ts). */
export type RowsDocument = { rows: number; row: (n: number) => string; length: number; locationOf: (offset: number) => { row: number; column: number } };
/** A notice: the English text is the key (lib/i18n.ts `tr`), `values` fills the placeholders. */
export type Notice = { text: string; values?: Record<string, number> };
export type RowsTarget = { row?: number; column?: number; offsetMode: boolean; notice: Notice };
const nextTabStop = (view: number, tab: number) => view + tab - (view % tab);
/** VS Code `CursorColumns.visibleColumnFromColumn` (tabs jump to the next stop). */
export function viewColumn(text: string, column: number, tab: number): number {
  const n = Math.min(column - 1, text.length);
  let s = 0;
  for (let i = 0; i < n; i++) s = text[i] === "\t" ? nextTabStop(s, tab) : s + 1;
  return s;
}
/** VS Code `CursorColumns.columnFromVisibleColumn`: the column (1-based) closest to a visible column. */
export function columnFromView(text: string, view: number, tab: number): number {
  if (view <= 0) return 1;
  let beforeS = 0, beforeColumn = 1;
  for (let i = 0; i < text.length; i++) {
    const afterS = text[i] === "\t" ? nextTabStop(beforeS, tab) : beforeS + 1;
    const afterColumn = i + 2;
    if (afterS >= view) return afterS - view < view - beforeS ? afterColumn : beforeColumn;
    beforeS = afterS;
    beforeColumn = afterColumn;
  }
  return text.length + 1;
}
export const ROW_EMPTY = "Type a line number to go to (from 1 to {n}).";
export const ROW_ENTER = "Press 'Enter' to go to line {z} or enter colon : to add a column number.";
export const LINE_COLUMN_MISSING = "Press 'Enter' to go to line {z} or enter a column number (from 1 to {s}).";
export const LINE_COLUMN = "Press 'Enter' to go to line {z} at column {s}.";
export const CHARACTER_EMPTY = "Type a character position to go to (from 1 to {n}).";
export const ROW_WITHOUT_EDITOR = "Open a text editor first to go to a line or an offset.";
/** VS Code `GotoLineQuickAccessProvider.parsePosition`; `rest` = the input without the first `:` (trimmed). */
export function rowsTarget(doc: RowsDocument | null, rest: string, tab = 4): RowsTarget {
  if (!doc) return { offsetMode: false, notice: { text: ROW_WITHOUT_EDITOR } };
  const e = String(rest ?? "").trim();
  if (e.startsWith(":")) {
    let i = parseInt(e.slice(1), 10);
    const n = doc.length;
    if (Number.isNaN(i)) return { offsetMode: true, notice: { text: CHARACTER_EMPTY, values: { n } } };
    const neg = i < 0;
    i -= Math.sign(i);
    if (neg) i += n;
    const o = doc.locationOf(Math.max(0, Math.min(i, n)));
    const s = viewColumn(doc.row(o.row), o.column, tab) + 1;
    return { row: o.row, column: o.column, offsetMode: true, notice: { text: LINE_COLUMN, values: { z: o.row, s } } };
  }
  const parts = e.split(/,|:|#/);
  const n = doc.rows;
  let z = parseInt((parts[0] ?? "").trim(), 10);
  if (parts.length < 1 || Number.isNaN(z)) return { offsetMode: false, notice: { text: ROW_EMPTY, values: { n } } };
  z = z >= 0 ? z : n + 1 + z;
  z = Math.min(Math.max(1, z), n);
  const text = doc.row(z);
  const maxView = viewColumn(text, text.length + 1, tab) + 1;
  let s = parseInt((parts[1] ?? "").trim(), 10);
  if (parts.length < 2 || Number.isNaN(s)) {
    return { row: z, column: 1, offsetMode: false, notice: parts.length < 2 ? { text: ROW_ENTER, values: { z } } : { text: LINE_COLUMN_MISSING, values: { z, s: maxView } } };
  }
  s = s >= 0 ? s : maxView + s;
  s = Math.min(Math.max(1, s), maxView);
  return { row: z, column: columnFromView(text, s - 1, tab), offsetMode: false, notice: { text: LINE_COLUMN, values: { z, s } } };
}

// ── Symbols (`@`, `#`) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Pos = { line: number; character: number };
type Area = { start: Pos; end: Pos };
/** A symbol of the outline in the shape of LSP `DocumentSymbol` (kind = LSP count). */
export type LayoutSymbol = { name: string; kind: number | string; range: Area; selectionRange?: Area; children?: LayoutSymbol[] };
export type FlatSymbol = { name: string; kind: number; container: string; range: Area; selection: Area; index: number };
const NAMES = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface",
  "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event",
  "operator", "type parameter"];
const kindCount = (k: number | string) => (typeof k === "number" ? k : Math.max(0, NAMES.indexOf(String(k).toLowerCase())));
const beforePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;
/** VS Code `OutlineModel.asListOfDocumentSymbols`: flat, per symbol its parent symbol's name as container, sorted by start. */
export function flatSymbols(symbols: readonly LayoutSymbol[] | null | undefined): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  const go = (list: readonly LayoutSymbol[], parent: string) => {
    for (const s of list) {
      if (!s?.range) continue;
      out.push({ name: String(s.name ?? ""), kind: kindCount(s.kind), container: parent, range: s.range, selection: s.selectionRange ?? s.range, index: 0 });
      if (Array.isArray(s.children) && s.children.length) go(s.children, String(s.name ?? ""));
    }
  };
  go(symbols ?? [], "");
  out.sort((a, b) => beforePos(a.range.start, b.range.start) || beforePos(a.range.end, b.range.end));
  out.forEach((s, i) => { s.index = i; });
  return out;
}
// The categories of `@:` (VS Code `FALLBACK_NLS_SYMBOL_KIND`/`NLS_SYMBOL_KIND_CACHE`), by LSP count; unknown: properties.
export const CATEGORY: Readonly<Record<number, string>> = {
  1: "files ({n})", 2: "modules ({n})", 3: "namespaces ({n})", 4: "packages ({n})", 5: "classes ({n})", 6: "methods ({n})",
  7: "properties ({n})", 8: "fields ({n})", 9: "constructors ({n})", 10: "enumerations ({n})", 11: "interfaces ({n})",
  12: "functions ({n})", 13: "variables ({n})", 14: "constants ({n})", 15: "strings ({n})", 16: "numbers ({n})", 17: "booleans ({n})",
  18: "arrays ({n})", 19: "objects ({n})", 20: "keys ({n})", 22: "enumeration members ({n})", 23: "structs ({n})", 24: "events ({n})",
  25: "operators ({n})", 26: "type parameters ({n})",
};
export const CATEGORY_ELSE = "properties ({n})";
export const SYMBOLS_GROUP = "symbols ({n})";
export type SymbolRow = { s: FlatSymbol; hits: Hits[] | undefined; containerHits: Hits[] | undefined; group?: Notice };
/** The score of a name (Quick Open's matrix, see lib/fuzzy-scorer.ts; VS Code uses `fuzzyScore` here). */
function nameScore(name: string, a: Request): { score: number; hits: Hits[] } | null {
  const values = a.values && a.values.length > 1 ? a.values : [a];
  let sum = 0;
  const hits: Hits[] = [];
  for (const w of values) {
    const [p, pos] = scoreFuzzy(name, w.normalized, w.normalizedLowercase, !w.expectContiguousMatch);
    if (!p) return null;
    sum += p;
    let last: Hits | undefined;
    for (const x of pos) { if (last && last.end === x) last.end++; else { last = { start: x, end: x + 1 }; hits.push(last); } }
  }
  return { score: sum, hits: hits.sort((x, y) => x.start - y.start) };
}
/** The rows of `@` (VS Code `AbstractGotoSymbolQuickAccessProvider.doGetSymbolPicks`): `input` = the text behind `@`. A `:` at the front
 *  (`@:`) orders by category (a separator per category with count, by its name; `translate` supplies the displayed text), otherwise a
 *  separator "Symbols (n)" above all. Several words: the first on the name, the rest on the container. Without a filter in document order. */
export function symbolRows(symbols: readonly FlatSymbol[], input: string, translate: (m: Notice) => string = (m) => m.text): SymbolRow[] {
  const raw = String(input ?? "");
  const afterKind = raw.startsWith(":");
  const filter = (afterKind ? raw.slice(1) : raw).trim();
  const a = prepareRequest(filter);
  let first = a, rest: Request | null = null;
  if (a.values && a.values.length > 1) { first = prepareRequest(a.values[0].original); rest = prepareRequest(a.values.slice(1).map((v) => v.original).join(" ")); }
  const hits: (SymbolRow & { score: number | null })[] = [];
  for (const s of symbols) {
    let score: number | null = null, t: Hits[] | undefined, ct: Hits[] | undefined;
    if (a.original.length > 0) {
      let whole = false;
      if (rest) { const w = nameScore(s.name, { ...a, values: undefined }); if (w) { score = w.score; t = w.hits; whole = true; } }
      if (score === null) { const w = nameScore(s.name, first); if (!w) continue; score = w.score; t = w.hits; }
      if (!whole && rest) {
        if (!s.container || !rest.original.length) continue;
        const c = nameScore(s.container, rest);
        if (!c) continue;
        score += c.score;
        ct = c.hits;
      }
    }
    hits.push({ s, hits: t, containerHits: ct, score });
  }
  const byScore = (x: { score: number | null; s: FlatSymbol }, y: { score: number | null; s: FlatSymbol }) => {
    if (x.score === null && y.score !== null) return 1;
    if (x.score !== null && y.score === null) return -1;
    if (x.score !== null && y.score !== null && x.score !== y.score) return x.score > y.score ? -1 : 1;
    return x.s.index - y.s.index;
  };
  const categoryText = (k: number) => CATEGORY[k] ?? CATEGORY_ELSE;
  if (afterKind) {
    const name = (k: number) => translate({ text: categoryText(k), values: { n: 0 } });
    hits.sort((x, y) => name(x.s.kind).localeCompare(name(y.s.kind)) || byScore(x, y));
    const count = new Map<string, number>();
    for (const x of hits) count.set(categoryText(x.s.kind), (count.get(categoryText(x.s.kind)) ?? 0) + 1);
    let previous: string | null = null;
    return hits.map(({ score: _s, ...x }) => {
      const k = categoryText(x.s.kind);
      const fresh = k !== previous;
      previous = k;
      return fresh ? { ...x, group: { text: k, values: { n: count.get(k) ?? 0 } } } : x;
    });
  }
  hits.sort(byScore);
  return hits.map(({ score: _s, ...x }, i) => (i === 0 ? { ...x, group: { text: SYMBOLS_GROUP, values: { n: hits.length } } } : x));
}
/** The innermost symbol whose range contains the position (VS Code: `findLast` over the rows; the selection when opening without a filter). */
export function symbolAtLocation<T extends { s: FlatSymbol }>(rows: readonly T[], pos: Pos): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i].s.range;
    if (beforePos(r.start, pos) <= 0 && beforePos(pos, r.end) <= 0) return i;
  }
  return -1;
}

export type WorkSymbol = { name: string; kind: number | string; container?: string; file: string };
/** What `#` asks the language server (VS Code `SymbolsQuickAccessProvider.getSymbolPicks`: `getWorkspaceSymbols(symbolQuery.original)`): with
 *  several words ONLY the first; the others filter the answer here (`workRows`, on "container • path"). */
export function symbolRequest(input: string): string {
  const a = prepareRequest(String(input ?? "").trim());
  return a.values && a.values.length > 1 ? a.values[0].original : a.original;
}
export type WorkRow<T extends WorkSymbol> = { s: T; description: string; hits: Hits[] | undefined; descriptionHits: Hits[] | undefined };
/** The rows of `#` (VS Code `SymbolsQuickAccessProvider.doGetSymbolPicks`): description "container • path", the first word on the name,
 *  the rest on the description; sorted by score, then name, then kind. */
export function workRows<T extends WorkSymbol>(symbols: readonly T[], input: string): WorkRow<T>[] {
  const a = prepareRequest(String(input ?? "").trim());
  let first = a, rest: Request | null = null;
  if (a.values && a.values.length > 1) { first = prepareRequest(a.values[0].original); rest = prepareRequest(a.values.slice(1).map((v) => v.original).join(" ")); }
  const out: (WorkRow<T> & { score: number | null })[] = [];
  for (const s of symbols) {
    const description = s.container ? `${s.container} • ${s.file}` : s.file;
    let score: number | null = null, t: Hits[] | undefined, bt: Hits[] | undefined, whole = false;
    if (a.original.length > 0) {
      if (rest) { const w = nameScore(s.name, { ...a, values: undefined }); if (w) { score = w.score; t = w.hits; whole = true; } }
      if (score === null) { const w = nameScore(s.name, first); if (!w) continue; score = w.score; t = w.hits; }
    }
    if (!whole && rest && rest.original.length > 0) {
      const c = nameScore(description, rest);
      if (!c) continue;
      if (score !== null) score += c.score;
      bt = c.hits;
    }
    out.push({ s, description, hits: t, descriptionHits: bt, score });
  }
  out.sort((x, y) => {
    if (x.score !== null && y.score !== null && x.score !== y.score) return x.score > y.score ? -1 : 1;
    const n = x.s.name.toLowerCase().localeCompare(y.s.name.toLowerCase());
    if (n !== 0) return n;
    return kindCount(x.s.kind) - kindCount(y.s.kind);
  });
  return out.map(({ score: _s, ...x }) => x);
}

// ── Help (`?`) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type HelpEntry = { prefix: string; text: string; command: string | null };
/** The providers of this palette with their help (VS Code `helpEntries`); `command`: its shortcut stands on the right. */
export const HELP: readonly HelpEntry[] = [
  { prefix: "", text: "Go to File", command: "workbench.action.quickOpen" },
  { prefix: "#", text: "Go to Symbol in Workspace", command: "workbench.action.showAllSymbols" },
  { prefix: ":", text: "Go to Line/Column", command: "workbench.action.gotoLine" },
  { prefix: ">", text: "Show and Run Commands", command: "workbench.action.showCommands" },
  { prefix: "@", text: "Go to Symbol in Editor", command: "workbench.action.gotoSymbol" },
  { prefix: "@:", text: "Go to Symbol in Editor by Category", command: null },
];
/** The rows of `?`: sorted by prefix (`localeCompare` like VS Code), name = the prefix or "…". */
export function helpRows(entries: readonly HelpEntry[] = HELP): (HelpEntry & { label: string })[] {
  return [...entries].sort((a, b) => a.prefix.localeCompare(b.prefix)).map((e) => ({ ...e, label: e.prefix || "…" }));
}
/** If someone types a known prefix behind `?`, the palette switches there (VS Code `HelpQuickAccessProvider`: `quickAccess.show(prefix,
 *  { preserveValue: true })`; the new input is the PREFIX, what stood behind it is dropped). Null: no switch. */
export function helpSwitch(rest: string, entries: readonly HelpEntry[] = HELP): string | null {
  const r = String(rest ?? "");
  // The longest matching provider (VS Code `getQuickAccessProvider`: `@:` before `@`); "…" (none) does not switch.
  const candidates = entries.filter((e) => e.prefix && r.startsWith(e.prefix)).sort((a, b) => b.prefix.length - a.prefix.length);
  return candidates.length ? candidates[0].prefix : null;
}

// ── Switching by key ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A palette command (Cmd+P, Shift+Cmd+P, Shift+Cmd+O, Cmd+T, Ctrl+G) in the OPEN palette (VS Code `QuickAccessController.doShowOrPick`): the same
 *  provider keeps the input; another takes over the filter behind the old prefix (`${newPrefix}${oldValue.substr(oldPrefix.length)}`); without a
 *  filter the new prefix stays alone. The filter is selected (`adjustValueSelection`: from the prefix to the end). */
export function switchInput(old: string, oldPrefix: string, newPrefix: string): { input: string; markFrom: number } {
  // The same provider (same prefix) thus keeps the input by itself.
  return { input: `${newPrefix}${String(old ?? "").slice(oldPrefix.length)}`, markFrom: newPrefix.length };
}

// ── Highlighting ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A text in pieces: highlighted or not (ranges may be unsorted and overlap; whatever goes beyond the text is dropped). */
export function chunks(text: string, hits: readonly Hits[] | null | undefined): { text: string; on: boolean }[] {
  const t = String(text ?? "");
  const b = [...(hits ?? [])].map((x) => ({ start: Math.max(0, x.start), end: Math.min(t.length, x.end) })).filter((x) => x.end > x.start).sort((x, y) => x.start - y.start);
  const out: { text: string; on: boolean }[] = [];
  let i = 0;
  for (const x of b) {
    const s = Math.max(x.start, i);
    if (s >= x.end) continue;
    if (s > i) out.push({ text: t.slice(i, s), on: false });
    out.push({ text: t.slice(s, x.end), on: true });
    i = x.end;
  }
  if (i < t.length || !out.length) out.push({ text: t.slice(i), on: false });
  return out.filter((x) => x.text.length > 0 || out.length === 1);
}
