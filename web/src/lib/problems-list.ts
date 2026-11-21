// The computations of the Problems view in the bottom panel, styled like VS Code; pure, without DOM and without network:
//
//   FILTER   as in VS Code (`FilterOptions` in markersFilterOptions.ts, `Filter` in markersTreeViewer.ts): the WHOLE input is the text filter
//            (a leading "!" negates it), every comma-separated term is also a glob: without "!" it includes files, with "!" it
//            excludes; a term ".ts" means "*.ts", and every term counts as `**/<term>` and `**/<term>/**` (a name matches the file and
//            everything under a folder of that name). A file hit by an exclusion is dropped entirely; one hit by an inclusion or (un-negated)
//            by the text on its NAME (fuzzy, as a subsequence) shows all its problems; otherwise the text decides per problem: on message
//            (substring, `*` as wildcard, case-insensitive), source or code (fuzzy). Negated, a problem that matches is dropped and one that
//            does not match stays. The toggles Errors/Warnings/Infos and "Show Active File Only" (filter menu) act first. VS Code never shows
//            hints (severity 4) in "Problems".
//   ORDER    as in VS Code (`compareMarkers`, `compareResourceMarkers`): per file the most severe first, then by position; the files by the
//            severity of their first problem, then by path.
//   ROWS     the visible rows with collapsed files (keyboard up/down, left/right), multi-line messages as in VS Code (`MarkersViewModel`:
//            ALL lines by default, switchable to one line per problem), the position of every row and the visible window (the list draws
//            only that; VS Code virtualizes), stable keys per problem (the selection follows the problem, not its place in the list), the
//            badge on the tab ("1K+" from a thousand, like VS Code) and the source behind the message ("ts(2304)").
//   EMPTY    what the view says without a row (VS Code `renderMessage`): not loaded yet ⇒ nothing (empty is not unknown), no problems,
//            none in the active file, or filtered; "n of m" only if filtering happened (`updateBadge` of the filter box).
//
// An invalid glob ("[z-a]") yields an expression that never matches (VS Code glob.ts `NULL`), never an exception while drawing.
// Tested EXECUTED in web/test/problems-list.test.mjs, every computation with a sabotage its check must catch.

export type ProblemSeverity = "error" | "warning" | "info" | "hint";
/** A problem as the panel receives it (components/code/layout-problems.ts): line and column 1-based as in the editor. */
export type ProblemEntry = {
  file: string;
  line: number;
  column?: number;
  message: string;
  severity: string;
  source?: string | null;
  code?: string | number | null;
};
/** The severity as a number like VS Code `MarkerSeverity` (error 8, warning 4, info 2, hint 1). */
export const SEVERITY_VALUE: Readonly<Record<ProblemSeverity, number>> = { error: 8, warning: 4, info: 2, hint: 1 };
const valueOf = (s: string): number => SEVERITY_VALUE[s as ProblemSeverity] ?? SEVERITY_VALUE.info;

// ── Filter ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type ProblemFilter = {
  /** The text filter: the whole input without a leading "!", trimmed. */
  text: string;
  negated: boolean;
  inclusion: readonly RegExp[];
  exclusion: readonly RegExp[];
  error: boolean;
  warnings: boolean;
  infos: boolean;
  onlyActiveFile: boolean;
  excludedShow: boolean;
};
export type FilterToggle = { error?: boolean; warnings?: boolean; infos?: boolean; onlyActiveFile?: boolean; excludedShow?: boolean };
/** VS Code's `files.exclude` default. "Show Excluded Files" is ON by default as in VS Code (`excludedFiles` off, markersView.ts
 *  `!!panelState.useFilesExclude`); switched off, it hides problems in those files. */
export const FILES_EXCLUDED: readonly string[] = ["**/.git", "**/.svn", "**/.hg", "**/.DS_Store", "**/Thumbs.db"];

/** A comma separates, except inside `{…}` and `[…]` (VS Code `splitGlobAware`). */
export function partsGlobs(input: string): string[] {
  const out: string[] = [];
  let inBracket = false, inCorner = false, cur = "";
  for (const c of String(input ?? "")) {
    if (c === "," && !inBracket && !inCorner) { out.push(cur); cur = ""; continue; }
    if (c === "{") inBracket = true;
    else if (c === "}") inBracket = false;
    else if (c === "[") inCorner = true;
    else if (c === "]") inCorner = false;
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** A glob as a regular expression over a path with "/": `**` any number of segments (also none), `*` and `?` within a segment,
 *  `{a,b}` choice, `[…]` character class (`[!…]` negates). Case counts (the files live in the Linux container). */
export function globToRegExp(glob: string): RegExp {
  return remembered(`g:${String(glob ?? "")}`, () => globBuild(String(glob ?? "")));
}
/** Never matches: an invalid glob, like VS Code glob.ts (`NULL`). */
const NEVER = /.^/;
// The expressions once per input (VS Code `fuzzyRegExpCache`): per draw the list asks every file and every message. If building throws
// (invalid character class "[z-a]"), it NEVER matches; otherwise one input in the filter box would take down the whole page (no error boundary).
const CACHE = new Map<string, RegExp>();
function remembered(key: string, build: () => RegExp): RegExp {
  let re = CACHE.get(key);
  if (!re) {
    try { re = build(); } catch { re = NEVER; }
    if (CACHE.size >= 2000) CACHE.clear();
    CACHE.set(key, re);
  }
  return re;
}
function globBuild(g: string): RegExp {
  let re = "", depth = 0, i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 2;
        if (g[i] === "/") { re += "(?:[^/]*/)*"; i++; } else re += ".*";
        continue;
      }
      re += "[^/]*"; i++; continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") { re += "(?:"; depth++; i++; continue; }
    if (c === "}" && depth > 0) { re += ")"; depth--; i++; continue; }
    if (c === "," && depth > 0) { re += "|"; i++; continue; }
    if (c === "[") {
      const end = g.indexOf("]", i + 1);
      if (end > i + 1) {
        let content = g.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (content[0] === "!") content = `^${content.slice(1)}`;
        re += `[${content}]`;
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    i++;
  }
  while (depth-- > 0) re += ")";
  return new RegExp(`^${re}$`);
}

// A term of the input as a pattern like VS Code `setPattern`: ".ts" → "*.ts", then `**/x` and `**/x/**` (file or folder at any depth).
function pattern(segment: string): RegExp[] {
  const p = segment[0] === "." ? `*${segment}` : segment;
  return [globToRegExp(`**/${p}/**`), globToRegExp(`**/${p}`)];
}

/** The filter box input with the filter menu's toggles (unspecified: all severities, all files). */
export function problemFilter(input: string, toggle: FilterToggle = {}): ProblemFilter {
  const raw = String(input ?? "").trim();
  const negated = raw.startsWith("!");
  const inclusion: RegExp[] = [], exclusion: RegExp[] = [];
  for (const segment of partsGlobs(raw).map((s) => s.trim()).filter(Boolean)) {
    if (segment.startsWith("!")) { const rest = segment.replace(/^!+/, ""); if (rest) exclusion.push(...pattern(rest)); }
    else inclusion.push(...pattern(segment));
  }
  return {
    text: (negated ? raw.replace(/^!+/, "") : raw).trim(), negated, inclusion, exclusion,
    error: toggle.error ?? true, warnings: toggle.warnings ?? true, infos: toggle.infos ?? true, onlyActiveFile: toggle.onlyActiveFile ?? false,
    excludedShow: toggle.excludedShow ?? true,
  };
}
/** Does a filter deviate from the default (text or a toggle)? Then the funnel carries its mark and "Clear Filters" appears. */
export const filterActive = (f: ProblemFilter): boolean => Boolean(f.text) || !f.error || !f.warnings || !f.infos || f.onlyActiveFile || !f.excludedShow;
const excluded = (file: string): boolean => FILES_EXCLUDED.some((p) => globToRegExp(p).test(file) || globToRegExp(`${p}/**`).test(file));

/** Message: substring of the text, case-insensitive, `*` as wildcard (VS Code `matchesFuzzy` via `convertSimple2RegExpPattern`). */
export function matchesNotice(text: string, notice: string): boolean {
  if (!text) return false;
  const re = remembered(`m:${text}`, () => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*"), "i"));
  return re.test(String(notice ?? ""));
}
/** Name, source, code: fuzzy; the characters of the text in order, case-insensitive (VS Code `matchesFuzzy2`). */
export function matchesFuzzy(text: string, target: string): boolean {
  const a = String(text ?? "").toLowerCase(), b = String(target ?? "").toLowerCase();
  if (!a || a.length > b.length) return false;
  let j = 0;
  for (const c of b) if (c === a[j]) j++;
  return j === a.length;
}

const baseName = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;
const folderOf = (p: string): string => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : ""; };
const showsSeverity = (f: ProblemFilter, s: string): boolean => (s === "error" ? f.error : s === "warning" ? f.warnings : s === "hint" ? false : f.infos);

// ── Groups ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `key[i]` belongs to `entries[i]`: stable across reloading and filtering (file, position, severity, source, code, message; equal ones counted). */
export type ProblemGroup = { file: string; name: string; folder: string; entries: ProblemEntry[]; key: string[] };
/** `loaded: false`: the list has not arrived yet (empty is not unknown). `activeFileHasProblems`: unfiltered (for the empty text). */
export type ProblemList = { loaded: boolean; groups: ProblemGroup[]; total: number; shown: number; activeFileHasProblems: boolean };

/** Per file the most severe first, then by position (VS Code `compareMarkers`). */
export function compareProblems(a: ProblemEntry, b: ProblemEntry): number {
  return valueOf(b.severity) - valueOf(a.severity) || a.line - b.line || (a.column ?? 1) - (b.column ?? 1);
}

/** The problems per file, filtered and ordered like VS Code. `total` counts all (without hints), `shown` the ones let through. */
export function problemList(problems: readonly ProblemEntry[] | null, filter: ProblemFilter, o: { activeFile?: string | null } = {}): ProblemList {
  if (problems === null) return { loaded: false, groups: [], total: 0, shown: 0, activeFileHasProblems: false };
  const perFile = new Map<string, ProblemEntry[]>();
  let total = 0;
  for (const p of problems ?? []) {
    if (!p || p.severity === "hint") continue;
    total++;
    const l = perFile.get(p.file);
    if (l) l.push(p); else perFile.set(p.file, [p]);
  }
  const all = [...perFile.entries()].map(([file, l]) => {
    const entries = [...l].sort(compareProblems);
    return { file, name: baseName(file), folder: folderOf(file), entries, key: problemKey(file, entries) };
  });
  // The files by the severity of their first (most severe) problem, then by path and name (VS Code `compareResourceMarkers`).
  all.sort((a, b) => valueOf(b.entries[0].severity) - valueOf(a.entries[0].severity) || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const groups: ProblemGroup[] = [];
  let shown = 0;
  for (const g of all) {
    if (filter.onlyActiveFile && g.file !== (o.activeFile ?? null)) continue;
    if (!filter.excludedShow && excluded(g.file)) continue;
    if (filter.exclusion.some((r) => r.test(g.file))) continue;
    const whole = filter.inclusion.some((r) => r.test(g.file)) || Boolean(filter.text && !filter.negated && matchesFuzzy(filter.text, g.name));
    const keep = g.entries.map((p) => {
      if (!showsSeverity(filter, p.severity)) return false;
      if (!filter.text) return true;
      const code = p.code === null || p.code === undefined ? "" : String(p.code);
      const matches = (p.source ? matchesFuzzy(filter.text, p.source) : false) || (code ? matchesFuzzy(filter.text, code) : false)
        || String(p.message ?? "").split(/\r\n|\r|\n/).some((z) => matchesNotice(filter.text, z));
      if (matches && !filter.negated) return true;
      if (filter.negated && !whole) return !matches;
      return whole;
    });
    const entries = g.entries.filter((_, i) => keep[i]);
    if (!entries.length) continue;
    shown += entries.length;
    groups.push({ ...g, entries, key: g.key.filter((_, i) => keep[i]) });
  }
  return { loaded: true, groups, total, shown, activeFileHasProblems: Boolean(o.activeFile && perFile.has(o.activeFile)) };
}

// The keys of a file: from the problem itself, equal ones counted in order, so a new problem before them shifts none.
function problemKey(file: string, entries: readonly ProblemEntry[]): string[] {
  const count = new Map<string, number>();
  return entries.map((p) => {
    const base = `${file}#${p.line}:${p.column ?? 1}:${p.severity}:${p.source ?? ""}:${p.code ?? ""}:${p.message}`;
    const n = count.get(base) ?? 0;
    count.set(base, n + 1);
    return n ? `${base}~${n}` : base;
  });
}

/** What the view says without a row (VS Code `renderMessage`); null: there are rows. "loading": show nothing, the list has not arrived yet. */
export type EmptyState = "loading" | "no" | "activeFile" | "filtered" | null;
export function emptyState(list: ProblemList, filter: ProblemFilter): EmptyState {
  if (!list.loaded) return "loading";
  if (list.shown > 0) return null;
  if (filter.onlyActiveFile) return list.activeFileHasProblems ? "filtered" : "activeFile";
  return list.total > 0 ? "filtered" : "no";
}
/** "n of m shown" appears only if something is really missing (VS Code: `total === filtered || total === 0` ⇒ nothing). */
export const showsFilterCount = (list: ProblemList): boolean => list.loaded && list.total !== 0 && list.shown !== list.total;

// ── Rows of the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `height` in rows of 22 px. A problem carries the lines of its message that it shows (`multiline`: the message HAS more than one). */
export type ProblemRow =
  | { kind: "file"; key: string; group: ProblemGroup; open: boolean; height: number }
  | { kind: "problem"; key: string; group: ProblemGroup; entry: ProblemEntry; rows: string[]; multiline: boolean; height: number };

const noticeRows = (m: string): string[] => String(m ?? "").split(/\r\n|\r|\n/);

/** The visible rows: per file its row, below it (expanded) its problems, multi-line like VS Code unless `singleLine` names the
 *  problem (its key). Key: the file or the problem's stable key (`ProblemGroup.key`). */
export function visibleRows(groups: readonly ProblemGroup[], closed: ReadonlySet<string>, singleLine: ReadonlySet<string> = new Set()): ProblemRow[] {
  const out: ProblemRow[] = [];
  for (const g of groups) {
    const open = !closed.has(g.file);
    out.push({ kind: "file", key: g.file, group: g, open, height: 1 });
    if (open) g.entries.forEach((entry, i) => {
      const all = noticeRows(entry.message), key = g.key[i];
      const rows = singleLine.has(key) ? all.slice(0, 1) : all;
      out.push({ kind: "problem", key, group: g, entry, rows, multiline: all.length > 1, height: rows.length });
    });
  }
  return out;
}

/** The top edge of every row in px and the total height (per row `height` × `row` px). */
export function rowPositions(rows: readonly { height: number }[], row = 22): { top: number[]; total: number } {
  const top: number[] = [];
  let y = 0;
  for (const z of rows) { top.push(y); y += z.height * row; }
  return { top, total: y };
}
/** The window [from, until) of the rows that lie between the scroll offset `roles` and `roles + view` px, with `margin` rows of reserve per side;
 *  the list draws only it (VS Code virtualizes every list). */
export function excerpt(positions: { top: readonly number[] }, roles: number, view: number, margin = 8): { from: number; until: number } {
  const n = positions.top.length;
  if (!n) return { from: 0, until: 0 };
  // The last row that does not start below the scroll offset `roles`, found by binary search.
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (positions.top[m] <= roles) lo = m; else hi = m - 1; }
  let until = lo + 1;
  while (until < n && positions.top[until] < roles + Math.max(0, view)) until++;
  return { from: Math.max(0, lo - margin), until: Math.min(n, until + margin) };
}

/** How a problem is opened (VS Code, list `onDidOpen`): click and space as preview, focus STAYS in the list (`preserveFocus`);
 *  double-click and Enter fixed, focus goes to the editor. The jump carries the choice itself; no focus grabbing back afterwards (that
 *  used to snatch focus from the editor again after a double-click). */
export function jumpKind(like: "click" | "spacebar" | "double-click" | "enter"): { fixed: boolean; focus: boolean } {
  return like === "double-click" || like === "enter" ? { fixed: true, focus: true } : { fixed: false, focus: false };
}

/** Where left-arrow leads from a row: an open file collapses (same row), a problem jumps to its file. */
export function leftOf(rows: readonly ProblemRow[], i: number): { index: number; collapse: string | null } {
  const z = rows[i];
  if (!z) return { index: i, collapse: null };
  if (z.kind === "file") return { index: i, collapse: z.open ? z.group.file : null };
  const parent = rows.findIndex((x) => x.kind === "file" && x.group.file === z.group.file);
  return { index: parent < 0 ? i : parent, collapse: null };
}

/** The number on a badge like VS Code (the panel's tab): from a thousand "1K", "1K+". Zero and less: no badge. */
export function badgesText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const whole = Math.floor(n);
  if (whole <= 999) return String(whole);
  const thousand = whole / 1000, bottom = Math.floor(thousand);
  return thousand > bottom ? `${bottom}K+` : `${bottom}K`;
}

/** Source and code behind the message like VS Code: "ts(2304)", source only "eslint", code only "(E501)"; neither: "". */
export function sourceText(source: string | null | undefined, code: string | number | null | undefined): string {
  const q = source ? String(source) : "";
  const c = code === null || code === undefined || code === "" ? "" : `(${String(code)})`;
  return `${q}${c}`;
}

/** The first line of a message (VS Code shows multi-line messages collapsed; the rest is in the title). */
export const firstRow = (notice: string): string => String(notice ?? "").split(/\r\n|\r|\n/)[0];
