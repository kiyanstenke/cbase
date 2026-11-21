"use client";
// The explorer as in VS Code. This file holds the DRAWING and the interaction:
//   - the root's section as a header row (RootHeader) and below it the rows from lib/explorer-tree.ts `visibleRows`;
//   - keys on the tree's surface (`role="tree"`, focusable): ↑ ↓ ← → Home End, Space, ⌘↓, ↵/F2, ⌘⌫, ⌘C ⌘X ⌘V, ⌥⌘C ⌥⇧⌘C, ⌘A, Esc,
//     typing (type-ahead); ⌘S, ⌘P etc. pass on to CodePane;
//   - multi-selection: ⌘-click, ⇧-click, ⇧↑/⇧↓;
//   - dragging: inside the tree it moves, with ⌥ it copies; a folder under the pointer opens after 500 ms; the target (folder with its
//     contents) is highlighted; files from outside still upload (`depositEntries`/`depositFiles`);
//   - the context menu (TreeMenu.tsx) with shortcuts on the right; on the empty area the root's menu;
//   - "Reveal Active File": the explorer's reveal request scrolls the row into view as soon as it exists — by hand, not `scrollIntoView`
//     (which also scrolls ancestors with `overflow: hidden`, see the tab bar in CodePane).
// Which key does what and what the menu shows is computed by lib/explorer-actions.ts (`keyToAction`, `menuPlan`, executed in
// web/test/explorer-actions.test.mjs); every action hits the element with FOCUS — in a compact row the segment, not the whole row. After
// ↵/Esc in the field, a menu action, deleting and pasting, focus returns to the tree (`ex.treeFocus`). A drag carries explorer and instance:
// nothing is dropped from ANOTHER explorer (another project, another copy — also in another window), otherwise this tree would rename its
// own same-named files (copying between explorers does not exist). The tree is a `tree` with `aria-activedescendant`.
// "Open in Terminal" is in the menu as soon as the view supplies `onInTerminal` — a new terminal in the lower panel. The root's header can
// be controlled from outside (`closed`/`onTo` — the explorer's sections); sticky scroll (TreeSticky.tsx, computed by lib/tree-sticky.ts) and
// the search widget ⌥⌘F/Ctrl+Alt+F (TreeSearch.tsx, computed by lib/tree-search.ts) — in filter mode the tree shows the filtered rows, and
// keys, Page Up/Down and type-ahead go over THESE rows.
// ONLY the rows in the viewport are drawn (TreeWindow.tsx, computed by lib/tree-window.ts, VS Code `ListView`); scrolling does not render
// the tree: the window swaps only the rows that enter or leave, and sticky scroll sets its state only when the sticky folders change.
// Measures (row height, view, scrollbar) change only on resize; "reveal" and Page Up/Down compute from the index (the row may not be in the
// DOM); `aria-setsize`/`aria-posinset` per row from `ariaSet` (once per row state).
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fromOtherWindow, treeDragTypes, foreignTreePaths, foreignTabHere, tabLocation } from "@/lib/tab-foreign";
import { useT } from "@/lib/i18n";
import { startFileDownload } from "@/lib/api";
import { depositFiles, depositEntries } from "@/lib/project-upload";
import { keyStep, typeNavigation, rowOf, type TreeRow as Row, type EntryRow } from "@/lib/explorer-tree";
import { treeSearch, isSearchKey, nextHit, type SearchMode } from "@/lib/tree-search";
import { stickyNode, stickyTarget, type StickyNode } from "@/lib/tree-sticky";
import { isMac } from "@/lib/chat-bar";
import { TreeSearch } from "@/components/code/explorer/TreeSearch";
import { TreeSticky } from "@/components/code/explorer/TreeSticky";
import { TreeWindow } from "@/components/code/explorer/TreeWindow";
import { ariaSet, scrollTarget, ROW_PX } from "@/lib/tree-window";
import { TEXT_SIZE_EVENT } from "@/lib/appearance";
import { menuPlan, keyToAction, type MenuAction } from "@/lib/explorer-actions";
import { isMarkdown } from "@/lib/md-preview";
import { decoration, type Decoration, type Cards } from "@/lib/explorer-decoration";
import { TreeRow, inset, lineAt } from "@/components/code/explorer/TreeRow";
import { TreeMenu, type MenuEntryKind, type MenuItem } from "@/components/code/explorer/TreeMenu";
import { InlineField } from "@/components/code/explorer/InlineField";
import { RootHeader } from "@/components/code/explorer/ExplorerHeader";
import { FileSymbol } from "@/components/code/FileSymbol";
import type { Explorer } from "@/components/code/explorer/useExplorer";
import type { ExplorerComparison } from "@/components/code/comparison-connection";

/** The data type of a drag INSIDE the tree (`{ apiBase, instance, paths }` as JSON) — from outside comes "Files". */
export const DRAG_TYPE = "application/x-cbase-tree";
type DragData = { origin?: string; apiBase: string; instance: string | null; paths: string[] };
/** After these menu actions focus returns to the tree (the others open a field, a search, a dialog or ask themselves). */
const FOCUS_BACK: ReadonlySet<MenuAction> = new Set(["cut", "copy", "path", "relative", "download", "for-comparison"]);
/** How long the pointer rests over a collapsed folder until it opens while dragging (VS Code). */
export const EXPAND_MS = 500;
/** For this long typed text belongs to ONE type-ahead. */
const TAP_PAUSE_MS = 800;
const WITHOUT_DECORATION: Decoration = { color: null, character: null, point: false, dimmed: false, through: false };

const parentOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** The height of a row, FRACTIONAL (22 px × text size — at "Small" 20.58 px): `offsetHeight` rounds to whole pixels, and from about row 50
 *  sticky scroll stuck the wrong row. Measured on an entry row in the window (not on the field). */
const rowHeight = (el: HTMLElement | null) => el?.querySelector<HTMLElement>(".cb-tree-window > .cb-tree-row[data-tree-path]")?.getBoundingClientRect().height || ROW_PX;
type Dimensions = { h: number; view: number; margin: number };
const sameNode = (a: readonly StickyNode[], b: readonly StickyNode[]) => a.length === b.length && a.every((k, i) => k.index === b[i].index && k.top === b[i].top);

/** The target folder of a drop in the tree: the row (the segment) under the pointer — a folder itself, a file its folder —, otherwise the root. */
export function depositTarget(target: EventTarget | null): string {
  const row = target instanceof Element ? target.closest<HTMLElement>("[data-tree-path]") : null;
  if (!row) return "";
  const path = row.dataset.treePath ?? "";
  return row.dataset.treeKind === "dir" ? path : parentOf(path);
}

// The hidden upload field as its own memoised component — React 19 rewrites `name`/`type` of an `<input>` on EVERY render (measured: three
// DOM changes per key in the editor, because CodePane renders per key); with stable props it never renders again.
const UploadField = memo(function UploadField({ field, onChoice }: { field: React.RefObject<HTMLInputElement | null>; onChoice: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return <input ref={field} type="file" multiple className="pointer-events-none absolute h-px w-px opacity-0" onChange={onChoice} />;
});

export function ExplorerTree({ ex, name, copy, instance, apiBase, cards, onSearchInFolder, onInTerminal, closed: collapsed, onTo, comparison, onPreview }: {
  ex: Explorer;
  name: string;
  copy: string | null;
  instance: string | null;
  apiBase: string;
  cards: Cards;
  /** "Find in Folder…": open the search and enter the folder under "files to include". */
  onSearchInFolder: (path: string) => void;
  /** "Open in Integrated Terminal" (VS Code `openInTerminal`): without it the item is missing. The folder is project-relative ("" = root). */
  onInTerminal?: (folder: string) => void;
  /** Controlled (the explorer's sections): the tree is collapsed, `onTo` toggles. Without: own state. */
  closed?: boolean;
  onTo?: () => void;
  /** "Select for Compare" and the comparisons (components/code/comparison-connection.ts) — without: no group in the menu. */
  comparison?: ExplorerComparison;
  /** "Open Preview" on a Markdown file (VS Code `markdown.showPreview`, explorer/context) — without: no entry. */
  onPreview?: (path: string) => void;
}) {
  const t = useT();
  const uid = useId();
  const rowsId = (i: number) => `${uid}-z${i}`;
  const surface = useRef<HTMLDivElement>(null);
  const fileField = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef("");
  const [focused, setFocused] = useState(false);
  const [ownTo, setOwnTo] = useState(false);
  const rootTo = collapsed ?? ownTo;
  const setRootTo = (v: boolean | ((x: boolean) => boolean)) => {
    const fresh = typeof v === "function" ? v(rootTo) : v;
    if (collapsed === undefined) setOwnTo(fresh); else if (fresh !== collapsed) onTo?.();
  };
  // The search widget (open, pattern, mode) — closed, the pattern is empty (VS Code clears it on closing).
  const [searchState, setSearch] = useState<{ open: boolean; text: string; mode: SearchMode; fuzzy: boolean }>({ open: false, text: "", mode: "highlight", fuzzy: true });
  const search = useMemo(() => (searchState.open && searchState.text ? treeSearch(ex.children, ex.rows, searchState.text, searchState.mode, searchState.fuzzy) : null), [searchState, ex.children, ex.rows]);
  /** The view's rows: in filter mode the filtered ones, otherwise the tree's. */
  const rows: readonly Row[] = search && searchState.mode === "filter" ? search.rows : ex.rows;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [menu, setMenu] = useState<{ x: number; y: number; target: string | null } | null>(null);
  const [deposit, setDeposit] = useState<string | null>(null);
  const dragSources = useRef<string[] | null>(null);
  /** The row a drag started on — it stays drawn even when it scrolls out of the window (otherwise `dragend` would not fire). */
  const [pullsOf, setDraggingOf] = useState<string | null>(null);
  const expand = useRef<{ path: string; h: ReturnType<typeof setTimeout> } | null>(null);
  const tap = useRef({ text: "", time: 0 });
  // The rows' handlers read the explorer through a ref — stable across renders so `memo` on TreeRow works.
  const exRef = useRef(ex);
  exRef.current = ex;
  const drag = useRef({ apiBase, instance });
  drag.current = { apiBase, instance };
  // While typing, the tree's focus jumps to the first hit from the focus on and scrolls it into view (VS Code FindController
  // `focusNext(0, true, …)` + `reveal`) — the selection stays, the page's focus stays in the field.
  useEffect(() => {
    if (!search) return;
    const z = rowsRef.current, e = exRef.current;
    const target = nextHit(z, search.hits, Math.max(0, rowOf(z, e.focus)));
    if (target) { e.focusOn(target.path); e.scrollTo(target.path); }
  }, [searchState.text, searchState.mode, searchState.fuzzy]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable — a new listener per render made React rewrite the field on every key in the editor (`name`/`type`, measured).
  const filesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).map((file) => ({ rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));
    e.target.value = "";
    void exRef.current.uploadIn(uploadTarget.current, files);
  }, []);
  const selectFiles = useCallback((dir: string) => {
    uploadTarget.current = dir;
    if (fileField.current) { fileField.current.value = ""; fileField.current.click(); }
  }, []);

  // ── Decoration and state per row (computed once per state) ──
  const decos = useMemo(() => {
    const m = new Map<string, Decoration>();
    for (const z of ex.rows) if (z.kind === "entry") m.set(z.path, decoration(z.path, z.type, cards, { symlink: Boolean(z.chain[z.chain.length - 1].symlink) }));
    return m;
  }, [ex.rows, cards]);
  const focusIndex = useMemo(() => rowOf(rows, ex.focus), [rows, ex.focus]); // not through all rows on every key in the editor
  const focusRow = focusIndex >= 0 && rows[focusIndex].kind === "entry" ? (rows[focusIndex] as EntryRow) : null;
  // The lighter line: that of the selection's folder — an open folder itself, otherwise the folder above it.
  const activeFolder = focusRow ? (focusRow.type === "dir" && focusRow.open ? focusRow.path : focusRow.ancestors[focusRow.ancestors.length - 1] ?? null) : null;
  const cut = ex.clipboard?.kind === "cut" ? ex.clipboard.paths : [];

  // Focus back into the tree (after the paint — a field that just vanished gave it to the body).
  useEffect(() => {
    if (!ex.treeFocus) return;
    const h = requestAnimationFrame(() => surface.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(h);
  }, [ex.treeFocus]);
  // ── Measures of the surface: row height, view, scrollbar — ONLY on resize, never per scroll event ──
  const [dimensions, setDimensions] = useState<Dimensions>({ h: ROW_PX, view: 0, margin: 0 });
  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;
  const measure = useCallback(() => {
    const el = surface.current;
    if (!el) return;
    const fresh = { h: rowHeight(el), view: el.clientHeight, margin: el.offsetWidth - el.clientWidth };
    setDimensions((m) => (m.h === fresh.h && m.view === fresh.view && m.margin === fresh.margin ? m : fresh));
  }, []);
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener(TEXT_SIZE_EVENT, measure); // the text scale changes the row height, not the surface
    return () => { ro.disconnect(); window.removeEventListener(TEXT_SIZE_EVENT, measure); };
  }, [measure, rootTo]);
  useLayoutEffect(measure, [rows, measure, rootTo]); // a first drawn row measures the real height

  // ── "Reveal Active File" / keys: the row into view as soon as it exists — from the INDEX (it may not be in the window) ──
  const scrolled = useRef(0);
  useEffect(() => {
    const z = ex.show, el = surface.current;
    if (!z || !el || z.seq === scrolled.current || rootTo) return;
    const i = rowOf(rows, z.path);
    if (i < 0) return; // it is still loading — the next row state tries again
    scrolled.current = z.seq;
    const target = scrollTarget(i, dimensions.h, el.scrollTop, el.clientHeight); // near: to the edge; far away: centred as in VS Code
    if (target !== null) el.scrollTop = target;
  }, [ex.show, rows, rootTo, dimensions.h]);

  // ── Sticky scroll: the scroll position (reported by the window per scroll event) → the sticky folders; state only on a change ──
  const stickyRows = useMemo(() => rows.map((z) => ({ depth: z.depth, open: z.kind === "entry" && z.type === "dir" && z.open })), [rows]);
  const stickyState = useRef({ stickyRows, dimensions });
  stickyState.current = { stickyRows, dimensions };
  // The scroll position lives in a ref; a new row state computes in the same render (never an index past the end), a scroll event only
  // when the sticky folders change (`stickyTick`).
  const scrollTop = useRef(0);
  const [stickyTick, setStickyTick] = useState(0);
  const sticky = useMemo(() => stickyNode(stickyRows, scrollTop.current, dimensions.h, dimensions.view), [stickyRows, dimensions, stickyTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;
  const computeSticky = useCallback((top: number) => {
    scrollTop.current = top;
    const { stickyRows: sz, dimensions: m } = stickyState.current;
    if (sameNode(stickyNode(sz, top, m.h, m.view), stickyRef.current)) return;
    setStickyTick((n) => n + 1);
  }, []);
  const stickyClick = useCallback((k: StickyNode, slot: number) => {
    const el = surface.current, z = rowsRef.current[k.index];
    if (!el || !z || z.kind !== "entry") return;
    el.scrollTop = stickyTarget(k.index, slot, dimensionsRef.current.h);
    exRef.current.select(z.path);
    el.focus({ preventScroll: true });
  }, []);
  const searchClose = useCallback(() => { setSearch((s) => ({ ...s, open: false, text: "" })); requestAnimationFrame(() => surface.current?.focus({ preventScroll: true })); }, []);
  // ↓/↵ in the field: focus goes into the tree, to the hit from the focus on (while typing it is already there).
  const searchInTheTree = useCallback(() => {
    const ex = exRef.current, z = rowsRef.current;
    const target = search ? nextHit(z, search.hits, Math.max(0, rowOf(z, ex.focus))) : null;
    if (target) { ex.focusOn(target.path); ex.scrollTo(target.path); }
    surface.current?.focus({ preventScroll: true });
  }, [search]);

  // ── Clicks ──
  const onClick = useCallback((e: React.MouseEvent, path: string, row: EntryRow) => {
    const ex = exRef.current;
    const meta = e.metaKey || e.ctrlKey;
    // ⌥-click on a file opens it to the side (VS Code with `workbench.list.multiSelectModifier: ctrlCmd`).
    if (e.altKey && !meta && !e.shiftKey && ex.openBeside && row.type === "file") { ex.select(path); ex.openBeside(path); return; }
    if (meta && e.shiftKey) { ex.select(path, { meta: true, shift: true }); return; } // ⌘⇧-click: ADD the range (VS Code)
    if (meta) { ex.select(path, { meta: true }); return; }
    if (e.shiftKey) { ex.select(path, { shift: true }); return; }
    ex.select(path);
    if (row.type === "dir" || ex.isFolder(path)) ex.toggle(row);
    else ex.openPath(path, false);
  }, []);
  const onDouble = useCallback((path: string, row: EntryRow) => { if (row.type === "file") exRef.current.openPath(path, true); }, []);
  const onMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    const ex = exRef.current;
    if (!ex.selection.has(path)) ex.select(path);
    setMenu({ x: e.clientX, y: e.clientY, target: path });
  }, []);

  // ── Dragging ──
  const onDrag = useCallback((e: React.DragEvent, path: string) => {
    const ex = exRef.current;
    const q = ex.selection.has(path) ? [...ex.selection] : [path];
    if (!ex.selection.has(path)) ex.select(path);
    dragSources.current = q;
    setDraggingOf(path);
    // With origin, window and id of the location — another window at the same location accepts the entries (lib/tab-foreign.ts).
    const location = tabLocation(drag.current.apiBase, drag.current.instance);
    const data: DragData = { origin: location.origin, apiBase: location.apiBase, instance: location.instance, paths: q };
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(data));
    for (const [type, value] of treeDragTypes(location)) e.dataTransfer.setData(type, value);
    e.dataTransfer.setData("text/plain", q.join("\n"));
    e.dataTransfer.effectAllowed = "copyMove";
  }, []);
  const expandFrom = () => { if (expand.current) clearTimeout(expand.current.h); expand.current = null; };
  const dragEnd = () => { setDeposit(null); dragSources.current = null; setDraggingOf(null); expandFrom(); };
  const onDragOver = (e: React.DragEvent) => {
    const internalDrag = e.dataTransfer.types.includes(DRAG_TYPE);
    const externalDrag = !internalDrag && e.dataTransfer.types.includes("Files");
    if (!internalDrag && !externalDrag) return;
    // From the explorer of ANOTHER window only at the same location (origin, route, instance) — then it copies (VS Code: a drop from
    // another window is `NativeDragAndDropData`, `handleDragOver` always shows "Copy" for it, even without ⌥); otherwise no drop.
    const foreign = internalDrag && fromOtherWindow(e.dataTransfer.types);
    if (foreign && !foreignTabHere(e.dataTransfer.types, tabLocation(apiBase, instance ?? null))) { e.dataTransfer.dropEffect = "none"; if (deposit !== null) setDeposit(null); return; }
    const z = depositTarget(e.target);
    if (internalDrag && (dragSources.current ?? []).some((p) => z === p || z.startsWith(`${p}/`))) {
      e.dataTransfer.dropEffect = "none"; // never into itself
      if (deposit !== null) setDeposit(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = internalDrag && !foreign ? (e.altKey ? "copy" : "move") : "copy";
    if (z !== deposit) setDeposit(z);
    // A collapsed folder under the pointer opens after EXPAND_MS.
    const under = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tree-path]") : null;
    const path = under?.dataset.treeKind === "dir" ? under.dataset.treePath ?? null : null;
    if (expand.current?.path === path) return;
    expandFrom();
    if (path === null) return;
    const i = rowOf(ex.rows, path);
    const row = i >= 0 ? ex.rows[i] : null;
    if (!row || row.kind !== "entry" || row.open) return;
    expand.current = { path, h: setTimeout(() => { expand.current = null; ex.toggle(row, true); }, EXPAND_MS) };
  };
  const onDrop = (e: React.DragEvent) => {
    const internalDrag = e.dataTransfer.types.includes(DRAG_TYPE);
    if (!internalDrag && !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const z = depositTarget(e.target);
    const sources = dragSources.current;
    dragEnd();
    if (internalDrag && fromOtherWindow(e.dataTransfer.types)) {
      const q = foreignTreePaths(e.dataTransfer.getData(DRAG_TYPE), tabLocation(apiBase, instance ?? null));
      if (!q) { alert(t("Items from another Explorer (another project or copy) cannot be dropped here.")); return; }
      void ex.importing(q, z); // like VS Code `ExternalFileImport` — copy under the own name, taken ⇒ "Replace?"
      return;
    }
    if (internalDrag) {
      let d: DragData | null = null;
      try { d = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragData; } catch { d = null; }
      // Only from THIS explorer (same address, same instance) — the paths are relative and would otherwise mean own files.
      if (!d || !Array.isArray(d.paths) || d.apiBase !== apiBase || (d.instance ?? null) !== (instance ?? null)) {
        alert(t("Items from another Explorer (another project or copy) cannot be dropped here."));
        return;
      }
      const q = d.paths.length ? d.paths : sources ?? [];
      void ex.deposit(q, z, e.altKey ? "copy" : "move", e.altKey ? {} : { questions: { targetName: z ? nameOf(z) : name } });
      return;
    }
    void depositFiles(depositEntries(e.dataTransfer))
      .then((files) => ex.uploadIn(z, files))
      .catch((x) => alert(t("Upload failed: {msg}", { msg: (x as Error).message })));
  };

  // ── Keys (which key does what: lib/explorer-actions.ts `keyToAction`) ──
  /** How many rows Page Up/Page Down jump: one visible height minus one row (like a list in VS Code). */
  const page = () => {
    const el = surface.current;
    return el ? Math.max(1, Math.floor(el.clientHeight / dimensions.h) - 1) : 10;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (ex.editing || e.target !== e.currentTarget) return; // the field (and everything in it) has its own keys
    if (isSearchKey(e, isMac())) { e.preventDefault(); e.stopPropagation(); setSearch((s) => ({ ...s, open: true })); return; } // ⌥⌘F
    const a = keyToAction({ key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
    if (!a) return; // ⌘S, ⌘P, ⌃` … belong to CodePane
    e.preventDefault();
    e.stopPropagation();
    // The element with focus — in a compact row the SEGMENT, not the row.
    const f = ex.focus;
    const fKind = f === null ? null : ex.kindOf(f);
    const targets = ex.selection.size ? [...ex.selection] : f !== null ? [f] : [];
    const go = (p: string | undefined, shift = false) => { if (!p) return; ex.select(p, shift ? { shift: true } : {}); ex.scrollTo(p); };
    const fold = () => { if (focusRow) ex.toggle(focusRow); };
    switch (a.kind) {
      case "path-copy": void ex.copyPath(targets, a.relative); return;
      case "copy": ex.copy(); return;
      case "cut": ex.cut(); return;
      case "insert": void ex.insert(); return;
      case "all": ex.selectAll(); return;
      case "erase": void ex.erase(); return;
      case "open-fixed": if (f !== null) { if (fKind === "dir") fold(); else if (fKind === "file") ex.openPath(f, true); } return;
      case "open-beside": if (f !== null && fKind === "file" && ex.openBeside) ex.openBeside(f); return;
      case "search-in-folder": if (f !== null && fKind === "dir") onSearchInFolder(f); return; // VS Code: on folders only
      case "rename": if (f !== null && targets.length <= 1) ex.startRename(f); return;
      case "spacebar": if (f !== null) { if (fKind === "dir") fold(); else if (fKind === "file") ex.openPath(f, false); } return;
      case "esc": ex.emptyClipboard(); if (f !== null) ex.select(f); return;
      case "typing": {
        const now = Date.now();
        const text = now - tap.current.time > TAP_PAUSE_MS ? a.character : tap.current.text + a.character;
        tap.current = { text, time: now };
        go(typeNavigation(rows, f, text) ?? undefined);
        return;
      }
      case "step": {
        const s = keyStep(rows, f, a.key, page());
        const target = s.on ?? s.close;
        if (target !== undefined) {
          const i = rowOf(rows, target);
          const row = i >= 0 ? rows[i] : null;
          if (row?.kind === "entry") ex.toggle(row, Boolean(s.on));
        }
        go(s.focus, a.expand);
      }
    }
  };

  // ── The context menu (content and order: lib/explorer-actions.ts `menuPlan`) ──
  const menuItems = (target: string | null): MenuEntryKind[] => {
    const kind = target === null ? "dir" : ex.kindOf(target);
    const folder = kind === "dir";
    const dir = target === null ? "" : folder ? target : parentOf(target);
    const paths = target === null ? [] : ex.selection.has(target) ? [...ex.selection] : [target];
    const plan = menuPlan({ target, kind: target === null ? "dir" : kind, several: paths.length > 1, clipboard: Boolean(ex.clipboard), terminal: Boolean(onInTerminal), beside: Boolean(ex.openBeside),
      preview: Boolean(onPreview) && target !== null && isMarkdown(target),
      ...(comparison ? { comparison: { selected: comparison.selected !== null, count: paths.length } } : {}) });
    const point = (action: MenuAction): Omit<MenuItem, "inactive" | "data"> => {
      switch (action) {
        case "to-page": return { label: t("Open to the Side"), shortcut: "⌃↵", run: () => { for (const p of paths) ex.openBeside?.(p); } };
        case "preview": return { label: t("Open Preview"), run: () => { if (target !== null) onPreview?.(target); } };
        case "new-file": return { label: t("New File…"), run: () => { setRootTo(false); ex.restart("file", dir); } };
        case "new-folder": return { label: t("New Folder…"), run: () => { setRootTo(false); ex.restart("dir", dir); } };
        case "in-terminal": return { label: t("Open in Integrated Terminal"), run: () => onInTerminal?.(dir) };
        case "search": return { label: t("Find in Folder…"), shortcut: "⌥⇧F", run: () => onSearchInFolder(dir) };
        case "cut": return { label: t("Cut"), shortcut: "⌘X", run: ex.cut };
        case "copy": return { label: t("Copy"), shortcut: "⌘C", run: ex.copy };
        // The menu's element (VS Code `pasteFileHandler`): the source itself ⇒ its folder, an own subfolder ⇒ error.
        case "insert": return { label: t("Paste"), shortcut: "⌘V", run: () => void ex.insert(target ?? "") };
        case "path": return { label: t("Copy Path"), shortcut: "⌥⌘C", run: () => void ex.copyPath(target === null ? [""] : paths, false) };
        case "relative": return { label: t("Copy Relative Path"), shortcut: "⌥⇧⌘C", run: () => void ex.copyPath(paths, true) };
        case "rename": return { label: t("Rename…"), shortcut: "↵", run: () => { if (target !== null) ex.startRename(target); } };
        // VS Code does not colour "Delete" in the explorer menu (`moveFileToTrash`/`deleteFile` without own colour) — the confirmation warns.
        case "erase": return { label: t("Delete"), shortcut: "⌘⌫", run: () => void ex.erase(paths) };
        // Folders come as ZIP (name from Content-Disposition), files raw — through the choice of instance (`instance=`).
        case "download": return { label: folder ? t("Download as ZIP") : t("Download…"), run: () => { if (target !== null) startFileDownload(apiBase, target, instance); } };
        // The target is EXACTLY this folder, not the selection — otherwise it lands elsewhere.
        case "upload": return { label: t("Upload…"), run: () => selectFiles(dir) };
        // VS Code "3_compare": the file under the pointer is chosen, compared left the chosen one, right this one.
        case "comparison-with-selection": return { label: t("Compare with Selected"), run: () => { if (target !== null) comparison?.withSelectedPath(target); } };
        case "for-comparison": return { label: t("Select for Compare"), run: () => { if (target !== null) comparison?.select(target); } };
        case "selection-compare": return { label: t("Compare Selected"), run: () => comparison?.compareSelected(paths) };
      }
    };
    return plan.map((x): MenuEntryKind => {
      if (x === "separator") return "separator";
      const p = point(x.action);
      const run = FOCUS_BACK.has(x.action) ? () => { p.run(); ex.toTree(); } : p.run;
      return { ...p, run, data: x.action, inactive: x.disabled };
    });
  };

  // The icon in the field follows the typed extension (VS Code: the row shows the new name's icon while typing).
  const fieldSymbol = (w: string) => <FileSymbol path={w} className="ml-0.5 mr-1.5" />;
  // ── Per row up front: aria-setsize/-posinset once per row state; what always stays drawn (focus, field, source of the drag) ──
  const aria = useMemo(() => ariaSet(rows), [rows]);
  const fieldIndex = ex.editing ? (ex.editing.kind === "fresh" ? rows.findIndex((z) => z.kind === "fresh") : rowOf(rows, ex.editing.path)) : -1;
  const dragIndex = pullsOf === null ? -1 : rowOf(rows, pullsOf);
  const always = [focusIndex, fieldIndex, dragIndex].filter((i) => i >= 0);
  const draw = (i: number, top: number) => {
    const z = rows[i];
    const set = { "aria-setsize": aria.size[i], "aria-posinset": aria.position[i] };
    if (z.kind === "loading") {
      return <div key={z.path} id={rowsId(i)} role="treeitem" aria-level={z.depth + 1} {...set} aria-busy className="cb-tree-row text-dim" style={{ top, paddingLeft: inset(z.depth) + 22 }} data-tree-loading>{t("Loading…##inline")}</div>;
    }
    if (z.kind === "fresh") {
      return (
        <div key={z.path} id={rowsId(i)} role="treeitem" aria-level={z.depth + 1} {...set} className="cb-tree-row" data-tree-new={z.type} style={{ top, paddingLeft: inset(z.depth) }}>
          {z.ancestors.map((a, k) => <span key={a} aria-hidden className="cb-tree-line" style={{ left: lineAt(k) }} />)}
          <span className="w-4 shrink-0" />
          {z.type === "dir" && <span className="w-1.5 shrink-0" />}
          <InlineField beginning="" isFolder={z.type === "dir"} symbol={z.type === "file" ? fieldSymbol : undefined} check={ex.check} error={ex.editingError} onConfirm={ex.confirm} onAbort={ex.abort} onFinished={ex.toTree} />
        </div>
      );
    }
    const rename = ex.editing?.kind === "rename" && ex.editing.path === z.path;
    return (
      <TreeRow
        key={z.path}
        id={rowsId(i)}
        top={top}
        setsize={aria.size[i]}
        posinset={aria.position[i]}
        row={z}
        selected={z.chain.some((g) => ex.selection.has(g.path))}
        focus={z.chain.some((g) => g.path === ex.focus)}
        cut={cut.some((p) => z.path === p || z.path.startsWith(`${p}/`))}
        deposit={deposit !== null && deposit !== "" && (z.path === deposit || z.path.startsWith(`${deposit}/`) || z.chain.some((g) => g.path === deposit))}
        deco={decos.get(z.path) ?? WITHOUT_DECORATION}
        activeFolder={activeFolder}
        hits={search && z.chain.some((g) => search.hits.has(g.path)) ? search.hits : null}
        field={rename ? (
          <InlineField beginning={z.chain[z.chain.length - 1].name} isFolder={z.type === "dir"} symbol={z.type === "file" ? fieldSymbol : undefined} check={ex.check} error={ex.editingError} onConfirm={ex.confirm} onAbort={ex.abort} onFinished={ex.toTree} />
        ) : undefined}
        onClick={onClick}
        onDouble={onDouble}
        onMenu={onMenu}
        onDrag={onDrag}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RootHeader
        name={name}
        collapsed={rootTo}
        onToggle={() => setRootTo((v) => !v)}
        onNewFile={() => { setRootTo(false); ex.restart("file"); }}
        onNewFolder={() => { setRootTo(false); ex.restart("dir"); }}
        onRefresh={ex.loadAgain}
        onCollapseAll={ex.collapseAll}
        onUpload={() => { const dir = ex.targetFolder(); if (dir === null) ex.unknownLocation(); else selectFiles(dir); }}
        upload={ex.upload}
      />
      {/* A single hidden field for all upload triggers; the target is in uploadTarget. Not display:none but rendered and invisible —
          display:none fields did not open a file dialog in the client on a programmatic click. */}
      <UploadField field={fileField} onChoice={filesSelected} />
      {copy && <div className="px-3 pb-0.5 text-[11px] text-dim" data-code-instance={instance ?? ""}>{t("Copy {name}", { name: copy })}</div>}
      {ex.error && <div className="px-3 py-1 text-[11px] text-danger">{ex.error}</div>}
      {ex.hint && (
        <div role="status" className="flex items-start gap-2 px-3 py-1 text-[11px] text-dim" data-tree-hint>
          <span className="min-w-0 flex-1">{ex.hint}</span>
          <button type="button" className="shrink-0 hover:text-fg" onClick={ex.closeHint} aria-label={t("Dismiss##notice")}>×</button>
        </div>
      )}
      {ex.ignoredClipped && (
        <div className="px-3 py-1 text-[11px] text-dim" data-tree-clipped title={t("Git reports more ignored items than the Explorer reads (cap).")}>
          {t("Not all ignored items are dimmed (cap).")}
        </div>
      )}
      {!rootTo && (
        <div className="relative flex min-h-0 flex-1 flex-col" data-tree-wrapper>
        {searchState.open && (
          <TreeSearch t={t} text={searchState.text} setText={(text) => setSearch((s) => ({ ...s, text }))} mode={searchState.mode} setMode={(mode) => setSearch((s) => ({ ...s, mode }))}
            fuzzy={searchState.fuzzy} setFuzzy={(fuzzy) => setSearch((s) => ({ ...s, fuzzy }))} count={search?.count ?? 0} unloaded={Boolean(search?.unloaded)}
            onClose={searchClose} onIntoTheTree={searchInTheTree} />
        )}
        <TreeSticky node={sticky} rows={sticky.map((k) => rows[k.index] as EntryRow)} h={dimensions.h} margin={dimensions.margin} deco={(p) => decos.get(p)} onClick={stickyClick} />
        <div
          ref={surface}
          role="tree"
          aria-label={name}
          aria-multiselectable
          aria-activedescendant={focusIndex >= 0 ? rowsId(focusIndex) : undefined}
          tabIndex={0}
          className="cb-tree cb-scroll min-h-0 flex-1 overflow-auto pb-2 outline-none"
          data-tree-focus={focused ? "" : undefined}
          data-deposit-root={deposit === "" ? "" : undefined}
          onFocus={() => setFocused(true)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
          onKeyDown={onKey}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, target: null }); }}
          onDragOver={onDragOver}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDeposit(null); expandFrom(); } }}
          onDrop={onDrop}
          onDragEnd={dragEnd}
        >
          <TreeWindow surface={surface} count={rows.length} h={dimensions.h} view={dimensions.view} always={always} draw={draw} onScroll={computeSticky} />
          {ex.rows.length === 0 && !ex.error && ex.children[""] && <div className="px-5 py-2 text-[12px] text-dim">{t("The folder is empty.")}</div>}
        </div>
        </div>
      )}
      {menu && <TreeMenu x={menu.x} y={menu.y} entries={menuItems(menu.target)} onClose={() => setMenu(null)} />}
    </div>
  );
}
