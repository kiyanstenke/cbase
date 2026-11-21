// Searching in the tree styled like VS Code — the PURE computation of the find widget of VS Code's trees (abstractTree.ts
// `FindController`/`FindFilter`, ⌥⌘F or Ctrl+Alt+F `list.find`). Drawn in components/code/explorer/TreeSearch.tsx.
//
//   nameHits   where the pattern stands in the name: fuzzy (VS Code `workbench.list.defaultFindMatchType: fuzzy` — the characters in
//                   order, a contiguous hit first) or contiguous; case-insensitive. → ranges [from, to).
//   treeSearch       over the LOADED tree (as in VS Code: what was never expanded, the tree does not know — `unloaded` says such a thing
//                   exists): per segment its hits, the number of hits and the view's rows. Highlight (default, VS Code
//                   `workbench.list.defaultFindMode: highlight`) shows all rows; filter only what matches, and the folders under which
//                   something matches (VS Code `TreeVisibility.Recurse` — a collapsed folder stays collapsed and is shown because something
//                   below it matches; the children of a matching folder that do not match are dropped).
//                   The folders above the hits are in a set ONCE (otherwise every row would check every hit).
//   nextHit  the first row from the focus (wrapping) in whose chain a segment matches — VS Code `FindController` jumps there while
//                   typing (`focusNext(0, true, …)` + `reveal`), ↓/↵ then give the focus to the tree.
//   isSearchKey    ⌥⌘F (Mac) or Ctrl+Alt+F (otherwise) — via `code`, so ⌥ on the Mac (ƒ) does not change the key.
// A leaf module apart from the rows' type. Guard: web/test/tree-search.test.mjs (with counter-proofs).
import type { TreeEntry, TreeRow, Children } from "./explorer-tree.js";

export type SearchMode = "highlight" | "filter";
export type Area = readonly [number, number];

export function nameHits(name: string, pattern: string, fuzzy: boolean): Area[] | null {
  const m = pattern.toLowerCase();
  if (!m) return null;
  const n = name.toLowerCase();
  const i = n.indexOf(m);
  if (i >= 0) return [[i, i + m.length]];
  if (!fuzzy) return null;
  const out: [number, number][] = [];
  let k = 0;
  for (let j = 0; j < n.length && k < m.length; j++) {
    if (n[j] !== m[k]) continue;
    const last = out[out.length - 1];
    if (last && last[1] === j) last[1] = j + 1; else out.push([j, j + 1]);
    k++;
  }
  return k === m.length ? out : null;
}

export type SearchResult = {
  /** Per path (of a segment) its hits in the name. */
  hits: ReadonlyMap<string, Area[]>;
  /** How many entries of the loaded tree match. */
  count: number;
  /** The view's rows (highlight: all; filter: the matching ones and the folders above). */
  rows: TreeRow[];
  /** There are folders whose content was never loaded — they are not searched. */
  unloaded: boolean;
};

/** The search over the loaded tree `children` and the visible rows `rows` (lib/explorer-tree.ts `visibleRows`). */
export function treeSearch(children: Children, rows: readonly TreeRow[], pattern: string, mode: SearchMode, fuzzy: boolean): SearchResult {
  const hits = new Map<string, Area[]>();
  let unloaded = false;
  const seen = new Set<string>();
  const go = (list: readonly TreeEntry[] | undefined) => {
    for (const e of list ?? []) {
      if (seen.has(e.path)) continue; // a link in a cycle, a seeded chain twice
      seen.add(e.path);
      const t = nameHits(e.name, pattern, fuzzy);
      if (t) hits.set(e.path, t);
      if (e.type === "dir" && !e.symlink) {
        if (children[e.path] === undefined) unloaded = true;
        else go(children[e.path]);
      }
    }
  };
  go(children[""]);
  if (!pattern || mode === "highlight") return { hits, count: hits.size, rows: [...rows], unloaded };
  // The folders above all hits, per hit only up to the first already known one (its ancestors are then already in).
  const ancestors = new Set<string>();
  for (const p of hits.keys()) {
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
      const v = p.slice(0, i);
      if (ancestors.has(v)) break;
      ancestors.add(v);
    }
  }
  const filtered = rows.filter((z) => z.kind === "entry" && (z.chain.some((g) => hits.has(g.path)) || ancestors.has(z.path)));
  return { hits, count: hits.size, rows: filtered, unloaded };
}

/** The first row from `start` (wrapping) in whose chain a segment matches, and that segment — or null (VS Code `focusNext(0, true, filter)`). */
export function nextHit(rows: readonly TreeRow[], hits: ReadonlyMap<string, Area[]>, start: number): { index: number; path: string } | null {
  const n = rows.length;
  for (let k = 0; k < n; k++) {
    const i = (Math.max(0, start) + k) % n;
    const z = rows[i];
    if (z.kind !== "entry") continue;
    const g = z.chain.find((x) => hits.has(x.path));
    if (g) return { index: i, path: g.path };
  }
  return null;
}

/** ⌥⌘F (Mac) or Ctrl+Alt+F: open the tree's find widget (VS Code `list.find`). */
export function isSearchKey(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean {
  if (e.code !== "KeyF" || !e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
