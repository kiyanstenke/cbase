// The explorer tree as ROWS. Pure calculations, a leaf module without imports — tested in web/test/explorer-tree.test.mjs (with
// sabotage), drawn in components/code/explorer/ExplorerTree.tsx.
//
// Why rows instead of a recursive drawing: keys (↑ ↓ ← → Home End), the range of the ⇧ selection and type-ahead navigation need the VISIBLE
// order — it is computed once here, the drawing only renders it.
//
//   visibleRows  the visible rows in order: expanded folders with their children, an open folder without loaded content as a "loading"
//                    row, the "new" field at its place in the target folder (a folder first, a file before the first file — as in
//                    VS Code), compact folders as ONE row with segments.
//   compactChain    the segments of a compact row: as long as a folder has EXACTLY one entry and that is a folder (and its content is
//                    known). `abort` stops the chain (a segment that is being renamed or gets a new field).
//   toggle            expand/collapse a row: ALL segments of a compact row at once (if the chain breaks later, every segment stays as open
//                    as the row was). Whether a row is open is decided by its FIRST segment — so a chain keeps growing while loading
//                    without the row collapsing (the chain loads on expand).
//   openSegments    a chain drawn OPEN puts all its segments into `open` — otherwise it collapses as soon as it breaks (a segment that
//                    only came in through loading was never in `open`).
//   missingOpen   which open folders still have to load their content.
//   chainsSeed       what a list with chains (`chain` per folder, server `chainsAlongside` in files.js) already says about the folders of
//                    the chain — "deep/a/b/c" is so already collapsed (VS Code `resolveSingleChildDescendants`).
//   showExcluded  VS Code `explorer.autoRevealExclude` (`**/node_modules`, `**/bower_components`) — if the path or an ancestor is one of
//                    them, "reveal active file" shows nothing (an explicit "Reveal in Explorer" does).
//   keyStep    ↑ ↓ ← → Home End PageUp PageDown as in VS Code; in a compact row ← → Home End first go through its segments (VS Code
//                    `explorer.compressedNavigation`).
//   typeNavigation    typing jumps to the next row that starts so.
//   area          the rows between anchor and target (⇧ click).
//   ancestors        the folders above a path (expanding on "reveal active file").

export type TreeEntry = { name: string; path: string; type: "dir" | "file"; heavy?: boolean; symlink?: boolean; chain?: readonly TreeEntry[] };
export type Children = Readonly<Record<string, readonly TreeEntry[] | undefined>>;

export type EntryRow = {
  kind: "entry";
  /** The segments (a compact row has several); the row stands for the LAST one. */
  chain: readonly TreeEntry[];
  /** The last segment — selection, keys and children hang on it. */
  path: string;
  type: "dir" | "file";
  depth: number;
  open: boolean;
  /** The folder the first segment lies in ("" = root). */
  parent: string;
  /** The folder rows above (their `path`), from outside in — one indent guide each. */
  ancestors: readonly string[];
};
export type NewRow = { kind: "fresh"; type: "dir" | "file"; depth: number; parent: string; path: string; ancestors: readonly string[] };
export type LoadingRow = { kind: "loading"; depth: number; parent: string; path: string; ancestors: readonly string[] };
export type TreeRow = EntryRow | NewRow | LoadingRow;

/** The key of the "new" field row in `parent` — no file name contains a NUL. */
export const newPath = (parent: string) => `${parent ? `${parent}/` : ""}\u0000new`;
const loadingPath = (parent: string) => `${parent ? `${parent}/` : ""}\u0000loading`;

/** Compact folders at most this deep (a symlink loop would otherwise be an endless chain as soon as its content is known). */
export const CHAIN_MAX = 64;

export function compactChain(children: Children, start: TreeEntry, abort: ReadonlySet<string> = new Set()): TreeEntry[] {
  const chain = [start];
  let cur = start;
  while (cur.type === "dir" && !abort.has(cur.path) && chain.length < CHAIN_MAX) {
    const k = children[cur.path];
    if (!k || k.length !== 1 || k[0].type !== "dir") break;
    cur = k[0];
    chain.push(cur);
  }
  return chain;
}

export function visibleRows(children: Children, open: ReadonlySet<string>, o: {
  compact?: boolean; fresh?: { parent: string; type: "dir" | "file" } | null; abort?: Iterable<string>;
} = {}): TreeRow[] {
  const compact = o.compact ?? true;
  const fresh = o.fresh ?? null;
  const abort = new Set(o.abort ?? []);
  if (fresh) abort.add(fresh.parent); // the field sits IN the target folder — it is the last segment of its row
  const rows: TreeRow[] = [];
  const level = (dir: string, depth: number, ancestors: readonly string[]) => {
    const list = children[dir];
    if (!list) {
      if (dir !== "") rows.push({ kind: "loading", depth, parent: dir, path: loadingPath(dir), ancestors });
      return;
    }
    const newHere = fresh !== null && fresh.parent === dir;
    let set = false;
    const setNew = () => { rows.push({ kind: "fresh", type: fresh!.type, depth, parent: dir, path: newPath(dir), ancestors }); set = true; };
    if (newHere && fresh.type === "dir") setNew();
    for (const e of list) {
      if (newHere && !set && e.type !== "dir") setNew();
      const chain = compact ? compactChain(children, e, abort) : [e];
      const last = chain[chain.length - 1];
      const isOpen = last.type === "dir" && open.has(e.path);
      rows.push({ kind: "entry", chain, path: last.path, type: last.type, depth, open: isOpen, parent: dir, ancestors });
      if (isOpen) level(last.path, depth + 1, [...ancestors, last.path]);
    }
    if (newHere && !set) setNew();
  };
  level("", 0, []);
  return rows;
}

/** All segments of chains drawn open into `open` — the same set if nothing is missing (no new state per drawing). */
export function openSegments(rows: readonly TreeRow[], open: ReadonlySet<string>): ReadonlySet<string> {
  let n: Set<string> | null = null;
  for (const z of rows) {
    if (z.kind !== "entry" || !z.open || z.chain.length < 2) continue;
    for (const g of z.chain) if (!open.has(g.path)) (n ??= new Set(open)).add(g.path);
  }
  return n ?? open;
}

/**
 * What a list with chains says about further folders: for each folder entry with `chain` [a, b, c], the entry has exactly `a`, `a` exactly `b`,
 * `b` exactly `c` (the content of `c` stays unknown — it loads on expand). → [folder, content] per known folder.
 */
export function chainsSeed(entries: readonly TreeEntry[]): [string, TreeEntry[]][] {
  const out: [string, TreeEntry[]][] = [];
  for (const e of entries) {
    if (e.type !== "dir" || e.symlink || !e.chain?.length) continue;
    let top = e.path;
    for (const g of e.chain) { out.push([top, [{ name: g.name, path: g.path, type: "dir", heavy: g.heavy, symlink: false }]]); top = g.path; }
  }
  return out;
}

/** VS Code `explorer.autoRevealExclude` (default): a path that is one of them itself or lies below one is not revealed. */
export const SHOW_EXCLUDED: readonly string[] = ["node_modules", "bower_components"];
export function showExcluded(path: string, names: readonly string[] = SHOW_EXCLUDED): boolean {
  return path.split("/").some((part) => names.includes(part));
}

/** The open folders whose content is still missing (the drawing shows "loading…" there). */
export function missingOpen(children: Children, rows: readonly TreeRow[]): string[] {
  const out: string[] = [];
  for (const z of rows) if (z.kind === "entry" && z.open && children[z.path] === undefined) out.push(z.path);
  return out;
}

/** Expand or collapse (without `on`: toggle) — all segments of a compact row. */
export function toggle(open: ReadonlySet<string>, row: Pick<EntryRow, "chain" | "open">, on?: boolean): Set<string> {
  const n = new Set(open);
  const target = on ?? !row.open;
  for (const g of row.chain) { if (target) n.add(g.path); else n.delete(g.path); }
  return n;
}

/** The folders above `path`, from outside in ("a/b/c.ts" → "a", "a/b"). */
export function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** The row that shows `path` — also as a middle segment of a compact row. -1: not visible. */
export function rowOf(rows: readonly TreeRow[], path: string | null): number {
  if (path === null) return -1;
  return rows.findIndex((z) => z.path === path || (z.kind === "entry" && z.chain.some((g) => g.path === path)));
}

export type Key = "up" | "down" | "left" | "right" | "beginning" | "end" | "pageUp" | "pageDown";
export type Step = { focus?: string; on?: string; close?: string };

/**
 * A key step as in VS Code. Only entry rows are selectable (not "loading", not the field). `page`: this many rows PageUp/PageDown jump
 * (the drawing knows the visible height).
 */
export function keyStep(rows: readonly TreeRow[], focus: string | null, key: Key, page = 10): Step {
  const entries = rows.map((z, i) => (z.kind === "entry" ? i : -1)).filter((i) => i >= 0);
  if (!entries.length) return {};
  const i = rowOf(rows, focus);
  const pathAt = (j: number) => rows[j].path;
  // A compact row: ← → Home End first go through the segments (VS Code previous/next/first/lastCompressedFolder).
  const kz = i >= 0 ? rows[i] : null;
  if (kz && kz.kind === "entry" && kz.chain.length > 1) {
    const g = kz.chain.findIndex((x) => x.path === focus), last = kz.chain.length - 1;
    if (g >= 0) {
      if (key === "left" && g > 0) return { focus: kz.chain[g - 1].path };
      if (key === "right" && g < last) return { focus: kz.chain[g + 1].path };
      if (key === "beginning" && g > 0) return { focus: kz.chain[0].path };
      if (key === "end" && g < last) return { focus: kz.chain[last].path };
    }
  }
  if (key === "beginning") return { focus: pathAt(entries[0]) };
  if (key === "end") return { focus: pathAt(entries[entries.length - 1]) };
  if (i < 0) return { focus: pathAt(entries[0]) };
  if (key === "up") { const j = [...entries].reverse().find((x) => x < i); return j === undefined ? {} : { focus: pathAt(j) }; }
  if (key === "down") { const j = entries.find((x) => x > i); return j === undefined ? {} : { focus: pathAt(j) }; }
  if (key === "pageUp" || key === "pageDown") {
    const k = entries.indexOf(i);
    const target = Math.max(0, Math.min(entries.length - 1, (k < 0 ? 0 : k) + (key === "pageUp" ? -1 : 1) * Math.max(1, page)));
    return entries[target] === i ? {} : { focus: pathAt(entries[target]) };
  }
  const z = rows[i];
  if (z.kind !== "entry") return {};
  if (key === "left") {
    if (z.type === "dir" && z.open) return { close: z.path };
    for (let j = i - 1; j >= 0; j--) if (rows[j].depth < z.depth && rows[j].kind === "entry") return { focus: pathAt(j) };
    return {};
  }
  // right
  if (z.type !== "dir") return {};
  if (!z.open) return { on: z.path };
  const n = rows[i + 1];
  return n && n.kind === "entry" && n.depth === z.depth + 1 ? { focus: n.path } : {};
}

/** The label of a row (compact: "src/components"). */
export const label = (z: EntryRow) => z.chain.map((g) => g.name).join("/");

/**
 * Type-ahead navigation: the next row from the focus on (with ONE character from the following one — repeated typing moves on) whose label
 * starts with `input`, case-insensitive, wrapping at the end. null: none.
 */
export function typeNavigation(rows: readonly TreeRow[], focus: string | null, input: string): string | null {
  const search = input.toLowerCase();
  if (!search) return null;
  const n = rows.length;
  if (!n) return null;
  const i = rowOf(rows, focus);
  const start = i < 0 ? 0 : search.length === 1 ? i + 1 : i;
  for (let k = 0; k < n; k++) {
    const z = rows[(start + k) % n];
    if (z.kind === "entry" && label(z).toLowerCase().startsWith(search)) return z.path;
  }
  return null;
}

/** The entry rows between `anchor` and `target` inclusive, in order (⇧ click). An invisible anchor: only the target. */
export function area(rows: readonly TreeRow[], anchor: string | null, target: string): string[] {
  const a = rowOf(rows, anchor), b = rowOf(rows, target);
  if (b < 0) return [];
  if (a < 0) return [rows[b].path];
  const [from, until] = a <= b ? [a, b] : [b, a];
  return rows.slice(from, until + 1).filter((z) => z.kind === "entry").map((z) => z.path);
}
