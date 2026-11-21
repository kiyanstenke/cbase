// The handling of the explorer as pure computations (explorer and editor styled like VS Code). They used to stand in
// components/code/explorer/ExplorerTree.tsx (`onKey`, `menuItems`) and useExplorer.ts (`select`, `insertTargets`, `targetFolder`) — where
// web/test/explorer-sources.test.mjs only checked strings. Here they are COMPUTED: web/test/explorer-actions.test.mjs (with sabotages).
//
//   keyToAction   which key does what — ⌘C ⌘X ⌘V ⌘A ⌘⌫ ⌘↓ ⌥⌘C ⌥⇧⌘C ⌥⇧F, ↑ ↓ ← → Home End PgUp PgDn, ↵/F2, Space, Esc, typing.
//                   `code` instead of `key` for letters with ⌥ (⌥C is "ç" on the Mac, ⌥⇧F "Ï").
//   menuPlan       content and order of the context menu like VS Code: "Paste" only on folders and the root, "Open in Terminal" only if
//                   the view has a terminal for it. The group "3_compare" on a file (lib/comparison.ts): "Compare with Selected" (one selected, not
//                   exactly two marked), "Select for Compare" (not exactly two), "Compare Selected" (exactly two).
//   select          the selection after a click: click, ⌘-click (toggle), ⇧-click (range from the anchor), ⌘⇧-click (range ADDED).
//   insertTargets   where "Paste" puts things — VS Code `pasteFileHandler`: the target is the folder of the element (a folder itself); if the element
//                   is the source itself, its folder ("src copy" next to "src"); if the element lies UNDER a source, it is an error
//                   ("… is an ancestor of the target folder").
//   targetFolder      the folder of an element for "New File", "Upload" — a folder itself, a file its folder, the root without an
//                   element; an element of UNKNOWN kind is null (never silently counted as a file).
import { area, type TreeRow, type Key } from "./explorer-tree.js";

const parentOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };

// ── Tasten ──
export type KeysEvent = { key: string; code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };
export type KeysAction =
  | { kind: "path-copy"; relative: boolean }
  | { kind: "copy" } | { kind: "cut" } | { kind: "insert" } | { kind: "all" } | { kind: "erase" }
  | { kind: "open-fixed" } | { kind: "open-beside" } | { kind: "search-in-folder" }
  | { kind: "step"; key: Key; expand: boolean }
  | { kind: "rename" } | { kind: "spacebar" } | { kind: "esc" }
  | { kind: "typing"; character: string };

const STEPS: Readonly<Record<string, Key>> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "beginning", End: "end", PageUp: "pageUp", PageDown: "pageDown",
};

/** What a key does on the area of the tree — null: nothing (it passes on, ⌘S, ⌘P, ⌃` belong to CodePane). */
export function keyToAction(e: KeysEvent): KeysAction | null {
  const mod = e.meta || e.ctrl;
  if (mod && e.alt && e.code === "KeyC") return { kind: "path-copy", relative: e.shift };
  if (mod && !e.alt && !e.shift && e.code === "KeyC") return { kind: "copy" };
  if (mod && !e.alt && e.code === "KeyX") return { kind: "cut" };
  if (mod && !e.alt && e.code === "KeyV") return { kind: "insert" };
  if (mod && !e.alt && e.code === "KeyA") return { kind: "all" };
  if ((mod && e.key === "Backspace") || (!mod && !e.alt && e.key === "Delete")) return { kind: "erase" };
  if (mod && e.key === "ArrowDown") return { kind: "open-fixed" };
  // "Open to the Side" — VS Code `explorer.openToSide`: ⌃↵ (on the Mac WinCtrl, otherwise CtrlCmd — both the Ctrl key).
  if (e.ctrl && !e.meta && !e.alt && !e.shift && e.key === "Enter") return { kind: "open-beside" };
  if (!mod && e.alt && e.shift && e.code === "KeyF") return { kind: "search-in-folder" };
  if (mod || e.alt) return null;
  const key = STEPS[e.key];
  if (key) return { kind: "step", key, expand: e.shift && (key === "up" || key === "down") };
  if (e.key === "Enter" || e.key === "F2") return { kind: "rename" };
  if (e.key === " ") return { kind: "spacebar" };
  if (e.key === "Escape") return { kind: "esc" };
  if (e.key.length === 1) return { kind: "typing", character: e.key };
  return null;
}

// ── Context menu ──
export type MenuAction =
  | "to-page" | "preview" | "new-file" | "new-folder" | "in-terminal" | "search" | "cut" | "copy" | "insert" | "path" | "relative"
  | "rename" | "erase" | "download" | "upload"
  | "comparison-with-selection" | "for-comparison" | "selection-compare";
export type MenuPlanPoint = { action: MenuAction; disabled?: boolean };
export type MenuContext = {
  /** The element under the pointer — null: the empty area (the root). */
  target: string | null;
  /** Its kind — null: unknown (then only what applies to every kind). */
  kind: "dir" | "file" | null;
  /** Does the menu apply to several selected entries? */
  several: boolean;
  clipboard: boolean;
  /** Does the view have a terminal that can open in a folder? */
  terminal: boolean;
  /** Is there "Open to the Side" (editor groups)? */
  beside?: boolean;
  /** Is the element a markdown file whose preview the view can open (VS Code `markdown.showPreview` in `explorer/context`,
   *  group "navigation", `resourceLangId == markdown`)? */
  preview?: boolean;
  /** Can the view compare (open a diff)? `selected`: a file is selected for comparison (VS Code
   *  `resourceSelectedForCompare`); `count`: how many entries the menu means (exactly two = VS Code `listDoubleSelection`). Without: no group. */
  comparison?: { selected: boolean; count: number };
};

/** Content and order like VS Code (folder, file, empty area); at the end download/upload of cbase. */
export function menuPlan(k: MenuContext): (MenuPlanPoint | "separator")[] {
  const folder = k.target === null || k.kind === "dir";
  const disabled: (MenuPlanPoint | "separator")[] = [];
  if (k.beside && k.kind === "file") disabled.push({ action: "to-page" }); // VS Code: "Open to the Side" at the very top (navigation 10)
  if (k.preview && k.kind === "file") disabled.push({ action: "preview" }); // "Open Preview" after it (navigation, without an order number)
  disabled.push("separator");
  if (folder) disabled.push({ action: "new-file" }, { action: "new-folder" });
  if (k.terminal) disabled.push({ action: "in-terminal" });
  disabled.push("separator");
  // VS Code "3_compare" (after "navigation", before "4_search"): only on a file (`!explorerResourceIsFolder`).
  if (k.comparison && k.target !== null && k.kind === "file") {
    const double = k.comparison.count === 2;
    if (k.comparison.selected && !double) disabled.push({ action: "comparison-with-selection" });
    disabled.push({ action: double ? "selection-compare" : "for-comparison" }, "separator");
  }
  if (folder) disabled.push({ action: "search" }, "separator");
  if (k.target !== null) disabled.push({ action: "cut" }, { action: "copy" });
  if (folder) disabled.push({ action: "insert", disabled: !k.clipboard });
  disabled.push("separator");
  disabled.push({ action: "path" });
  if (k.target !== null) {
    disabled.push({ action: "relative" }, "separator");
    disabled.push({ action: "rename", disabled: k.several }, { action: "erase" }, "separator");
    disabled.push({ action: "download", disabled: k.several || k.kind === null });
  }
  if (folder) disabled.push({ action: "upload" });
  // No separators at the edge, no two in a row.
  const clean: (MenuPlanPoint | "separator")[] = [];
  for (const p of disabled) {
    if (p === "separator" && (!clean.length || clean[clean.length - 1] === "separator")) continue;
    clean.push(p);
  }
  while (clean[clean.length - 1] === "separator") clean.pop();
  return clean;
}

// ── Selection ──
export type SelectionStatus = { selection: ReadonlySet<string>; focus: string | null; anchor: string | null };

/** The selection after a click (or ⇧↑/⇧↓) like VS Code: the anchor stays with the ⇧ range. */
export function select(status: SelectionStatus, rows: readonly TreeRow[], path: string, mod: { meta?: boolean; shift?: boolean } = {}): SelectionStatus {
  if (mod.shift) {
    const b = area(rows, status.anchor, path);
    const fresh = b.length ? b : [path];
    return { selection: new Set(mod.meta ? [...status.selection, ...fresh] : fresh), focus: path, anchor: status.anchor ?? path };
  }
  if (mod.meta) {
    const n = new Set(status.selection);
    if (n.has(path)) n.delete(path); else n.add(path);
    return { selection: n, focus: path, anchor: path };
  }
  return { selection: new Set([path]), focus: path, anchor: path };
}

// ── Paste ──
export type InsertGroup = { target: string; sources: string[] };
export type InsertPlan = { error: "ancestor" | "unknown" } | { groups: InsertGroup[] };

/**
 * Where "Paste" puts things (VS Code `pasteFileHandler`). `element`: the element of the menu or the focus ("" = the root), `kind` its kind.
 * One target per source; sources with the same target stand in one group (one drop per group).
 */
export function insertTargets(element: string, kind: "dir" | "file" | null, sources: readonly string[]): InsertPlan {
  const groups: InsertGroup[] = [];
  for (const q of sources) {
    if (element !== q && element.startsWith(`${q}/`)) return { error: "ancestor" };
    let target: string;
    if (element === q) target = parentOf(q);
    else if (element === "" || kind === "dir") target = element;
    else if (kind === "file") target = parentOf(element);
    else return { error: "unknown" };
    const g = groups.find((x) => x.target === target);
    if (g) g.sources.push(q); else groups.push({ target, sources: [q] });
  }
  return { groups };
}

/** The folder of an element: the root without an element, a folder itself, a file its folder — unknown kind: null. */
export function targetFolder(path: string | null, kind: "dir" | "file" | null): string | null {
  if (path === null || path === "") return "";
  if (kind === "dir") return path;
  if (kind === "file") return parentOf(path);
  return null;
}

// ── Delete with unsaved changes ──
/** Which warning deleting needs when unsaved buffers lie below — VS Code `deleteFiles` (fileActions): several entries ⇒
 *  "files", a folder ⇒ "folder {0} … in 1 file" or "in {1} files", a file ⇒ "{0}"; plus the sentence "Your changes will be lost if you
 *  don't save them." and ONLY this one confirmation (`skipConfirm`). Without unsaved changes: null (then the ordinary confirmation). Each
 *  unsaved path under one of the entries is counted once. */
export type DeleteWarning = { kind: "files" } | { kind: "file"; name: string } | { kind: "folder"; name: string; count: number };
export function deleteWarning(list: readonly string[], unsaved: readonly string[]): DeleteWarning | null {
  const under = (e: string) => unsaved.filter((p) => p === e || p.startsWith(`${e}/`));
  const affected = new Set(list.flatMap(under));
  if (affected.size === 0) return null;
  if (list.length > 1) return { kind: "files" };
  const e = list[0], name = e.slice(e.lastIndexOf("/") + 1);
  return affected.has(e) ? { kind: "file", name } : { kind: "folder", name, count: affected.size };
}
