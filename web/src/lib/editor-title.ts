// Port of: microsoft/vscode src/vs/workbench/contrib/debug/browser/debug.contribution.ts (MIT)
// The title bar of an editor (MenuId.EditorTitle) like VS Code 1.143. Pure (no imports), EXECUTED in web/test/editor-title.test.mjs.
//
//   titleActions   which icon buttons a text file carries in `editor/title` and in which order: "Run or Debug…" first
//                  (VS Code attaches the submenu `EditorTitleRun` with `group: "navigation", order: -1` and the codicon `run`), then
//                  "Open Preview to the Side" (navigation@1), "Open Preview" (navigation@2), "Open Changes". There are no text pills
//                  there: Save and Blame do not stand in the title bar (see `fileMenu`).
//   titleSlot      how many of these buttons have room next to the tabs. VS Code scrolls the tabs and leaves the actions standing (the toolbar
//                  of the title bar has no `responsiveBehavior`) — with three groups of 320 px only one letter of the title was left. cbase
//                  therefore keeps the width of ONE tab free (VS Code `.tab.sizing-fit`: 120 px) and moves what then does not fit, from the back, into
//                  "…" (like a toolbar with `responsiveBehavior: { kind: "last" }`). Split and "…" themselves never move.
//   fileMenu      what a text file carries in the "…" menu (More Actions…): "Save" (`workbench.action.files.save`, ⌘S; gray when nothing
//                  is unsaved) and "Toggle Git Blame Editor Decoration" (`git.blame.toggleEditorDecoration`, a switch with a
//                  check mark). VS Code lists both only in the command palette; cbase puts them in "…" so they stay reachable without a keyboard.

/** An icon button of the title bar of a text file — the VS Code command as identifier. */
export type TitleAction = "debug.run" | "markdown.showPreviewToSide" | "markdown.reopenAsPreview" | "git.openChange";

/** What the file can do up front (computed by the caller). */
export type TitleSituation = { debug: boolean; preview: boolean; asPreview: boolean; change: boolean };

export function titleActions(l: TitleSituation): TitleAction[] {
  const out: TitleAction[] = [];
  if (l.debug) out.push("debug.run"); // order -1: before all others
  if (l.preview) out.push("markdown.showPreviewToSide");
  if (l.asPreview) out.push("markdown.reopenAsPreview");
  if (l.change) out.push("git.openChange");
  return out;
}

/** A button of the title bar: 22 px (VS Code `.action-item .action-label` 16 px + 3 px padding per side), plus 2 px gap (gap-0.5). */
export const BUTTON_WIDTH = 22;
export const BUTTON_GAP = 2;
/** The padding of the actions (px-1.5 left and right). */
export const ACTIONS_MARGIN = 12;
/** What stays for the tabs at least: the width of a tab in VS Code (`.tab.sizing-fit { width: 120px }`). */
export const TAB_MINIMUM = 120;

/** How many of `count` buttons stay visible when the bar measures `width` px and `fixed` buttons (split, "…") always stand.
 *  `width` 0: not measured yet — all. */
export function titleSlot(width: number, count: number, fixed: number): number {
  if (!(width > 0) || count <= 0) return Math.max(0, count);
  const perButton = BUTTON_WIDTH + BUTTON_GAP;
  const free = width - TAB_MINIMUM - ACTIONS_MARGIN - fixed * perButton;
  return Math.max(0, Math.min(count, Math.floor(free / perButton)));
}

/** The buttons split: the first `slot` stand in the bar, the rest moves into "…" (on top, in the same order). */
export function splitActions<T>(actions: readonly T[], slot: number): { visible: T[]; overflow: T[] } {
  const n = Math.max(0, Math.min(actions.length, slot));
  return { visible: actions.slice(0, n), overflow: actions.slice(n) };
}

/** An entry of the file in the "…" menu. */
export type FileMenuEntry =
  | { id: "workbench.action.files.save"; inactive: boolean }
  | { id: "git.blame.toggleEditorDecoration"; on: boolean };

export function fileMenu(d: { dirty: boolean; deleted: boolean; blameOn: boolean }): FileMenuEntry[] {
  return [
    { id: "workbench.action.files.save", inactive: !d.dirty || d.deleted },
    { id: "git.blame.toggleEditorDecoration", on: d.blameOn },
  ];
}
