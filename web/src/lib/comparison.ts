// "Select for Compare" — the ONE selection computation for the explorer and the time axis, window-wide (one selection per window, as in
// VS Code). Pure, no React: the state is held by components/code/comparison-connection.ts (ONE per window), the menus are drawn by
// components/code/explorer/ExplorerTree.tsx (plan in lib/explorer-actions.ts `menuPlan`) and components/code/explorer/TimeAxis.tsx
// (`timeAxisPlan`).
//
// VS CODE 1.143 (read off the bundle):
//   Explorer (workbench, `explorer/context`, group "3_compare") — the context key `resourceSelectedForCompare`:
//     20 "Compare with Selected" (`compareFiles`)      when a file is selected, not on folders, not with exactly two selected
//     30 "Select for Compare" (`selectForCompare`)     not on folders, not with exactly two selected (`!listDoubleSelection`)
//     30 "Compare Selected" (`compareSelected`)        only with exactly two selected, not on folders
//     "Compare with Selected" opens `{ original: selected, modified: clicked, pinned: true }` (also the file against itself);
//     "Compare Selected" `{ original: sel[0], modified: sel[1], pinned: true }` in selection order (⌘-click appends, a ⇧ range is
//     in tree order — `Explorer.selection` carries the same order, lib/explorer-actions.ts `select`).
//     The selection is a module variable of the workbench (`globalResourceToCompare`) and the key a GLOBAL context key: it applies in the
//     whole window, across all roots of a multi-folder workspace.
//   Time axis (git extension, `timeline/item/context`, group "3_compare") — `git.timeline.selectedForCompare`:
//     @1 "Compare with Selected" (`git.timeline.compareWithSelected`)   when an entry is selected (of any file)
//     @2 "Select for Compare" (`git.timeline.selectForCompare`)          always
//     "Compare with Selected" on an entry of ANOTHER file does nothing (the extension compares the time axis URI); otherwise
//     `vscode.diff(left = selected, right = clicked)` as a preview with focus, title "{0} ({1}) ↔ {0} ({2})" (lib/editor-inputs.ts
//     `diffName`). The selection stays until the next one — VS Code never resets it. It too applies window-wide (a field of the extension).
//   Both selections are SEPARATE (two context keys): selecting in the explorer does not change the time axis selection.
//
// CBASE: a window has several code areas (Coding → files, the code tabs of each chat) — each with ONE root, its target
// (`{ apiBase, instance }`). The selection therefore carries its target: selected in one area, compared in another, left the selected file from
// ITS target, right the clicked one from the target of the area where the diff opens (lib/chat-tabs.ts `DiffSource` "files"). Whether two
// time axis entries mean the same file (VS Code: the same URI) is decided by `sameFile` — the connection computes it via the
// canonical identity of the file (lib/buffer-coordinates.ts: the same file at workspace level and in the project is ONE file).
//
// Guard: web/test/comparison.test.mjs (executed, with sabotages).
import { targetEqual, type DiffSource, type TabTarget } from "./chat-tabs.js";

/** A file with its target: the path relative to the root of the target. */
export type Location = { target: TabTarget; path: string };
/** An entry of the time axis: `file` = the file of the time axis today (relative to the repo — the URI VS Code compares), `backThen` = its name
 *  in this commit (across a rename). `repo` relative to the root of the area. */
export type TimeAxisChoice = { repo: string; file: string; hash: string; backThen: string };
/** The selection of the time axis: the entry with the target of the area where it was selected. */
export type SelectedEntry = TimeAxisChoice & { target: TabTarget };
export type ComparisonStatus = { file: Location | null; timeAxis: SelectedEntry | null };
export const NO_CHOICE: ComparisonStatus = { file: null, timeAxis: null };
/** Do two locations mean the same file? (The URI VS Code compares — the connection computes via the canonical identity.) */
export type SameFile = (a: Location, b: Location) => boolean;
const onlySameLocation: SameFile = (a, b) => a.path === b.path && targetEqual(a.target, b.target);
const inRepo = (repo: string, file: string) => (repo ? `${repo}/${file}` : file);

/** The selection state with the workspace it applies in. VS Code holds the selection per WINDOW, and a window has one
 *  workspace: opening another reloads the window, the selection is empty afterwards. In cbase the workspace changes within the same
 *  window — so the selection applies only in the workspace where it was made. */
export type WindowChoice = { state: ComparisonStatus; workspace: string | null };
/** The workspace of the window is `id`: a DIFFERENT one than before clears the selection; the first known or the same changes nothing, `null` (not
 *  known yet) neither — empty is not unknown. Unchanged: the same object. */
export function toWorkspace(w: WindowChoice, id: string | null): WindowChoice {
  if (id === null || id === w.workspace) return w;
  return { state: w.workspace === null ? w.state : NO_CHOICE, workspace: id };
}

// ── Select ──
export const fileForComparison =(s: ComparisonStatus, here: TabTarget, path: string): ComparisonStatus => ({ ...s, file: { target: here, path } });
export const entryForComparison = (s: ComparisonStatus, here: TabTarget, w: TimeAxisChoice): ComparisonStatus => ({ ...s, timeAxis: { ...w, target: here } });

// ── Compare ──
/** "Compare with Selected": left the selected file (from its target), right `path` in the target `here` — null without a selection. */
export function withSelectedFile(s: ComparisonStatus, here: TabTarget, path: string): DiffSource | null {
  return s.file === null ? null : { kind: "files", repo: "", left: s.file.path, right: path, leftTarget: s.file.target, rightTarget: here };
}
/** "Compare Selected": exactly two selected of one area, in selection order — else null. */
export function selectedCompare(here: TabTarget, paths: readonly string[]): DiffSource | null {
  return paths.length === 2 ? { kind: "files", repo: "", left: paths[0], right: paths[1], leftTarget: here, rightTarget: here } : null;
}
/** "Compare with Selected" (time axis): left the selected entry, right `w` (in the area `here`) — null without a selection or for another
 *  file (VS Code then does nothing). The same file lies in the same repo, so the selected entry's name back then also applies in the repo of `w`. */
export function withSelectedEntry(s: ComparisonStatus, here: TabTarget, w: TimeAxisChoice, equal: SameFile = onlySameLocation): DiffSource | null {
  const g = s.timeAxis;
  if (!g || !equal({ target: g.target, path: inRepo(g.repo, g.file) }, { target: here, path: inRepo(w.repo, w.file) })) return null;
  return {
    kind: "comparison", repo: w.repo, left: { hash: g.hash, file: g.backThen }, right: { hash: w.hash, file: w.backThen },
    ...(w.file !== w.backThen ? { current: w.file } : {}),
  };
}

// ── Menus ──
export type TimeAxisPoint = "with-selection" | "for-comparison";
/** The group "3_compare" in the context menu of a time axis entry, in VS Code's order. */
export function timeAxisPlan(s: ComparisonStatus): TimeAxisPoint[] {
  return s.timeAxis ? ["with-selection", "for-comparison"] : ["for-comparison"];
}
