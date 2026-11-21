// Editor navigation: the pure computations, without CodeMirror and without network:
//
// - `W3_COMMANDS`: the entries of the go-to family, the "Preview ▸" submenu (VS Code "Peek"), search (Find All References/
//   Implementations, call hierarchy) and back/forward. Data for the ONE command table (lib/editor-commands.ts); the execution is attached
//   by components/code/lsp-navigation.ts (every id here has exactly one there). Shortcuts mirror VS Code on the Mac; hidden without the
//   server's capability, so "Go to Source Definition" appears only where `features` lists `source_definition`.
// - `hitsSelection`: exactly one hit jumps, several open Peek (equal places count once).
// - `groupedByFile`: hits per file, instance files by path, targets outside the instance last, within a file by position.
// - `previewParts`: the line preview of a hit (before / hit / after), truncated with indentation removed.
// - `NavHistory`: back/forward per editor across files. A jump cuts off the forward part, back remembers the place one stood at (forward
//   returns exactly there), at most `max` entries.
//
// A leaf except for types: web/test/lsp-navigation.test.mjs compiles it with tsc and runs every computation with counter-checks.
import type { LspLocation, LspPos, LspRange } from "./api/lsp.js";
import type { EditorCommand } from "./editor-commands.js";

// ── Commands (data) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const PEEK_MENU = "editor.action.peekMenu";
/** The entries in the order of VS Code's context menu (group "navigation", then "search"); without a group: key/palette only. */
export const W3_COMMANDS: readonly Omit<EditorCommand, "execute" | "condition">[] = [
  { id: "editor.action.revealDefinition", title: "Go to Definition", group: "navigation", rank: 10, shortcut: "F12", keys: ["F12"], needs: "definition" },
  { id: "editor.action.goToTypeDefinition", title: "Go to Type Definition", group: "navigation", rank: 20, needs: "type_definition" },
  { id: "typescript.goToSourceDefinition", title: "Go to Source Definition", group: "navigation", rank: 30, needs: "source_definition" },
  { id: "editor.action.goToImplementation", title: "Go to Implementations", group: "navigation", rank: 40, shortcut: "⌘F12", keys: ["Mod-F12"], needs: "implementation" },
  { id: "editor.action.goToReferences", title: "Go to References", group: "navigation", rank: 50, shortcut: "⇧F12", keys: ["Shift-F12"], needs: "references" },
  { id: PEEK_MENU, title: "Preview", group: "navigation", rank: 60, submenu: true },
  { id: "editor.action.peekDefinition", title: "Peek Definition", parent: PEEK_MENU, rank: 10, shortcut: "⌥F12", keys: ["Alt-F12"], needs: "definition" },
  { id: "editor.action.peekTypeDefinition", title: "Peek Type Definition", parent: PEEK_MENU, rank: 20, needs: "type_definition" },
  { id: "editor.action.peekImplementation", title: "Peek Implementations", parent: PEEK_MENU, rank: 30, shortcut: "⇧⌘F12", keys: ["Shift-Mod-F12"], needs: "implementation" },
  { id: "editor.action.referenceSearch.trigger", title: "Peek References", parent: PEEK_MENU, rank: 40, needs: "references" },
  { id: "references-view.findReferences", title: "Find All References", group: "search", rank: 10, shortcut: "⌥⇧F12", keys: ["Shift-Alt-F12"], needs: "references" },
  { id: "references-view.findImplementations", title: "Find All Implementations", group: "search", rank: 20, needs: "implementation" },
  { id: "references-view.showCallHierarchy", title: "Show Call Hierarchy", group: "search", rank: 30, shortcut: "⌥⇧H", keys: ["Shift-Alt-h"], needs: "call_hierarchy" },
  { id: "workbench.action.navigateBack", title: "Go Back", shortcut: "⌃-", keys: ["Ctrl--"] },
  { id: "workbench.action.navigateForward", title: "Go Forward", shortcut: "⌃⇧-", keys: ["Ctrl-Shift--"] },
];

// ── Hits ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const beforePos = (a: LspPos, b: LspPos): number => (a.line - b.line) || (a.character - b.character);
/** The identity of a hit: file and range. */
export const locationKey = (o: LspLocation): string =>
  `${o.file}\u0000${o.range.start.line}:${o.range.start.character}-${o.range.end.line}:${o.range.end.character}`;
/** Equal places once (the first mention wins), order kept. A place without file or range is dropped. */
export function uniqueLocations(locations: readonly LspLocation[] | null | undefined): LspLocation[] {
  const seen = new Set<string>(), out: LspLocation[] = [];
  for (const o of locations ?? []) {
    if (!o || typeof o.file !== "string" || !o.file || !o.range?.start || !o.range?.end) continue;
    const k = locationKey(o);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

export type HitsChoice = { kind: "none" } | { kind: "jump"; location: LspLocation } | { kind: "peek"; locations: LspLocation[] };
/** No hit: nothing; exactly one jumps; several open Peek. `alwaysPeek` (the entries under "Preview ▸") shows even a single one in Peek. */
export function hitsSelection(locations: readonly LspLocation[] | null | undefined, o: { alwaysPeek?: boolean } = {}): HitsChoice {
  const e = uniqueLocations(locations);
  if (e.length === 0) return { kind: "none" };
  if (e.length === 1 && !o.alwaysPeek) return { kind: "jump", location: e[0] };
  return { kind: "peek", locations: e };
}

export type FileGroup = { file: string; extern: { token: string } | null; locations: LspLocation[] };
/** The hits per file (right side of Peek, "References" mode): instance files by path, external targets after them; within each file by
 *  position. Equal places count once. */
export function groupedByFile(locations: readonly LspLocation[] | null | undefined): FileGroup[] {
  const m = new Map<string, FileGroup>();
  for (const o of uniqueLocations(locations)) {
    let g = m.get(o.file);
    if (!g) { g = { file: o.file, extern: null, locations: [] }; m.set(o.file, g); }
    if (!g.extern && o.external?.token) g.extern = { token: o.external.token };
    g.locations.push(o);
  }
  const groups = [...m.values()];
  for (const g of groups) g.locations.sort((a, b) => beforePos(a.range.start, b.range.start) || beforePos(a.range.end, b.range.end));
  return groups.sort((a, b) => Number(Boolean(a.extern)) - Number(Boolean(b.extern)) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
/** The hits in group order (the arrow keys in Peek walk this way). */
export const flatHits = (groups: readonly FileGroup[]): LspLocation[] => groups.flatMap((g) => g.locations);

/** Name and folder of a path (for the rows: "file.ts  src/lib"). */
export function pathParts(file: string): { name: string; folder: string } {
  const i = file.lastIndexOf("/");
  return i < 0 ? { name: file, folder: "" } : { name: file.slice(i + 1), folder: file.slice(0, i) };
}

/** The preview of a hit in its line: leading blanks are dropped, a long lead is cut to `leadTime` characters (with "…").
 *  `start`/`end` are characters of the line (a range past the line ends at its end). */
export function previewParts(row: string, start: number, end: number, leadTime = 40): { before: string; hits: string; after: string } {
  const z = String(row ?? "");
  const a = Math.max(0, Math.min(z.length, Math.floor(start) || 0));
  const b = Math.max(a, Math.min(z.length, Math.floor(end) || 0));
  let from = z.length - z.trimStart().length;
  if (from > a) from = a;
  let before = z.slice(from, a);
  if (before.length > leadTime) before = `…${before.slice(before.length - leadTime)}`;
  return { before, hits: z.slice(a, b), after: z.slice(b).trimEnd() };
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A place in the history: file (as the tab names it), position (0-based) and, for a target outside the instance, its token. */
export type NavLocation = { path: string; pos: LspPos; extern?: { token: string } | null };
/** The same place for the history: same file and line (the column does not count; VS Code keeps one entry per line). */
export const samePlace = (a: NavLocation | null | undefined, b: NavLocation | null | undefined): boolean =>
  Boolean(a && b && a.path === b.path && a.pos.line === b.pos.line);

export class NavHistory {
  private list: NavLocation[] = [];
  private i = -1;
  constructor(private readonly max = 50) {}
  /** The place the history stands at (visited last). */
  current(): NavLocation | null { return this.i >= 0 ? this.list[this.i] ?? null : null; }
  get canBack(): boolean { return this.i > 0; }
  get canForward(): boolean { return this.i >= 0 && this.i < this.list.length - 1; }
  /** For tests and display only. */
  entries(): readonly NavLocation[] { return [...this.list]; }
  get index(): number { return this.i; }
  /** A jump from `from` (where one stood; null: unknown) to `to`. If the history stands in the same file as `from`, its entry becomes
   *  `from` (one returns to where one last was); everything forward is dropped. A jump to the same place adds nothing. */
  jump(from: NavLocation | null, to: NavLocation): void {
    if (from) {
      if (this.i >= 0 && this.list[this.i].path === from.path) this.list[this.i] = from;
      else { this.list.length = this.i + 1; this.list.push(from); this.i += 1; }
    }
    this.list.length = this.i + 1;
    if (samePlace(this.current(), to)) { this.list[this.i] = to; return; }
    this.list.push(to);
    this.i += 1;
    while (this.list.length > this.max) { this.list.shift(); this.i -= 1; }
  }
  /** Back: the place before; `now` replaces the current entry (forward returns exactly there). null at the start. */
  back(now: NavLocation | null = null): NavLocation | null {
    if (this.i <= 0) return null;
    if (now && this.list[this.i].path === now.path) this.list[this.i] = now;
    this.i -= 1;
    return this.list[this.i];
  }
  /** Forward: the place after (only after a back). null at the end. */
  before(now: NavLocation | null = null): NavLocation | null {
    if (this.i < 0 || this.i >= this.list.length - 1) return null;
    if (now && this.list[this.i].path === now.path) this.list[this.i] = now;
    this.i += 1;
    return this.list[this.i];
  }
  /** A file was renamed (lib/buffer.ts `renameBuffer`): its entries move along. */
  renamed(old: string, fresh: string): void {
    for (let k = 0; k < this.list.length; k++) {
      const p = this.list[k].path;
      if (p === old || p.startsWith(`${old}/`)) this.list[k] = { ...this.list[k], path: fresh + p.slice(old.length) };
    }
  }
}

/** A tab switch (also by clicking the tab) is a jump, unless the history already stands on the new file: then the switch came from its
 *  own jump (go to, back/forward) and has its entry. true: recorded. */
export function tabSwitched(v: NavHistory, old: NavLocation | null, fresh: NavLocation): boolean {
  if (v.current()?.path === fresh.path) return false;
  v.jump(old, fresh);
  return true;
}

// ── Range as text (hints, titles) ─────────────────────────────────────────────────────────────────────────────────────────────
/** "Line 12": 1-based, as the bar shows it. */
export const rowOf = (r: LspRange | null | undefined): number => (Number(r?.start?.line) || 0) + 1;
