// The layout of Coding → Files, styled like VS Code; pure, without DOM:
//
//   SIZES    Sidebar and bottom panel with VS Code's limits: sidebar at least 170 px (`SidebarPart.minimumWidth`), the editor keeps 220 px
//            width and 70 px height below its header (`DEFAULT_EDITOR_MIN_DIMENSIONS`, the group measures title + 70), the panel at
//            least 77 px high (`PanelPart.minimumHeight`). Without a remembered value the default at first start (sidebar min(300, width/4),
//            panel a third of the work area); a double-click on the drag bar sets the preferred size (sidebar max(300, longest name + 16),
//            `SidebarPart.preferredWidth`, `ViewPaneContainer.getOptimalWidth`; panel 40 % of the work area, `PanelPart.preferredHeight`).
//            VS Code has no fixed upper limit. Below half the minimum size a part snaps off (SplitView `snap`: it disappears, the remembered
//            size stays). The work area is CodePane, not the window.
//   STEPS    what Cmd+B, Cmd+J, Shift+Cmd+E/F/M/D, Ctrl+` and the panel's buttons do, as in VS Code (layout.ts, panelActions.ts,
//            viewsService.ts): open a view and focus it, OR, if it is visible AND its part has focus, close it (panel) or return to the editor
//            (sidebar). Cmd+J opens with focus; EVERY closing of the panel gives focus to the editor (`setPanelHidden`). Cmd+B shows
//            without focus; when hiding, focus goes to the panel if it had it or the editor is hidden, otherwise to the editor
//            (`focusPanelOrEditor`). "Toggle Maximized Panel" opens a closed panel maximized. A maximized panel stays maximized across
//            closing (`workbench.panel.opensMaximized: preserve`). When the last terminal ends, the panel closes if it showed the terminal
//            (`terminal.integrated.hideOnLastClosed`).
//   SEED     Shift+Cmd+F takes the editor's one-line selection as the search term, not when focus is already in the search, and escaped in
//            regex mode (searchView.ts `updateTextFromSelection`).
//   KEYS     the commands with id, title and key as in VS Code (Mac shortcuts, `Mod` = Ctrl off the Mac): ONE list for the command table
//            (components/code/panel/code-layout.ts registers it: keys in the editor, palette), the keys outside the editor and the keys a
//            terminal lets through (VS Code `terminal.integrated.commandsToSkipShell`).
//
// Tested EXECUTED in web/test/panel-layout.test.mjs, every computation with a sabotage its check must catch.
import { matchesKey, type KeyPress } from "./commandPalette.js";

// ── Sizes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const SIDEBAR_MIN = 170;
export const SIDEBAR_PREFERRED = 300;
export const EDITOR_MIN_WIDTH = 220;
export const EDITOR_MIN_HEIGHT = 70;
export const PANEL_MIN_HEIGHT = 77;
/** VS Code `ViewPaneContainer.getOptimalWidth`: the longest name plus this margin. */
export const OPTIMAL_MARGIN = 16;
/** What counts beside the sidebar without measurement. */
export const SIDEBAR_WITHOUT_SLOT = 240;

/** x within [min, max]; if there is not enough room (max < min), the minimum wins. */
export function clamp(x: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(Number.isFinite(x) ? x : min, Math.max(min, max))));
}
/** The width of the sidebar: remembered or (null) the default min(300, slot/4), clamped to [170, slot − 220]. `slot` = the width
 *  that sidebar and editor share; 0 = not measured yet. */
export function sidebarWidth(remembered: number | null, slot: number): number {
  if (!(slot > 0)) return remembered ?? SIDEBAR_WITHOUT_SLOT;
  const wish = remembered ?? Math.min(SIDEBAR_PREFERRED, slot / 4);
  return clamp(wish, SIDEBAR_MIN, slot - EDITOR_MIN_WIDTH);
}
/** Double-click on the sidebar's drag bar: max(300, optimal width of the view), clamped. */
export function sidebarBack(optimal: number, slot: number): number {
  return sidebarWidth(Math.max(SIDEBAR_PREFERRED, Number.isFinite(optimal) ? optimal : 0), slot);
}
/** The optimal width (VS Code `getLargestChildWidth` + `OPTIMAL_MARGIN`): the right edge of the widest NAME, measured on the text, not on
 *  its box (which is stretched in a row, and every double-click would add the margin once more). 0: nothing measured. */
export function optimalWidthFrom(pageLeft: number, names: readonly { left: number; width: number }[]): number {
  let max = 0;
  for (const n of names) max = Math.max(max, n.left - pageLeft + n.width);
  return max > 0 ? Math.ceil(max) + OPTIMAL_MARGIN : 0;
}

/** What editor and panel share: `slot` (editor area + panel), `work` (the full height of CodePane; default and double-click
 *  compute with it, like VS Code with the workbench height), `editorMin` (editor group header + 70). 0 = not measured yet. */
export type PanelMass = { slot: number; work: number; editorMin: number };
/** The height of the panel: remembered or (null) a third of the work area, clamped to [77, slot − editor minimum]. */
export function panelHeight(remembered: number | null, m: PanelMass): number {
  if (!(m.slot > 0)) return remembered ?? 260;
  return clamp(remembered ?? (m.work > 0 ? m.work : m.slot) / 3, PANEL_MIN_HEIGHT, m.slot - Math.max(EDITOR_MIN_HEIGHT, m.editorMin));
}
/** Double-click on the panel's drag bar: 40 % of the work area (VS Code `PanelPart.preferredHeight`), clamped. */
export function panelBack(m: PanelMass): number {
  return panelHeight((m.work > 0 ? m.work : m.slot) * 0.4, m);
}
/** Snapping as in VS Code (SplitView `snap`): below half the minimum size the part disappears ("off"), above it the clamped size applies. */
export function snap(wish: number, min: number): "off" | "on" {
  return wish < min / 2 ? "off" : "on";
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const PANEL_TAB = ["problems", "debug", "terminal"] as const;
export type PanelTab = (typeof PANEL_TAB)[number];
export type PanelState = { open: boolean; tab: PanelTab; maximized: boolean };
/** The panel takes the whole editor area (VS Code "Maximize" area): only when open. ONE rule for the panel (`data-maximized`) and the
 *  column above it (`data-panel-maximized`, globals.css hides the panel's siblings there). */
export const panelMaximized = (s: PanelState): boolean => s.maximized && s.open;
export type PanelAction =
  /** Cmd+J: panel on/off. */
  | { kind: "panel" }
  /** Shift+Cmd+M, Ctrl+`: open the view and focus it; if it is visible and the panel has focus, close. */
  | { kind: "view"; tab: PanelTab }
  /** Status bar (VS Code `toggleProblems`): visible ⇒ close, otherwise open and focus. */
  | { kind: "toggle"; tab: PanelTab }
  /** A debug start, a view from outside: show without taking focus. */
  | { kind: "show"; tab: PanelTab }
  | { kind: "close" }
  | { kind: "maximize" }
  /** The last terminal is gone (process end, "Kill Terminal"): if the panel showed it, it closes. */
  | { kind: "terminalWay" };
/** The new state and where focus goes (null: stays). */
export type LayoutFollowUp<S> = { state: S; focus: "panel" | "page" | "editor" | null };

export function panelStep(s: PanelState, a: PanelAction, focusInPanel: boolean): LayoutFollowUp<PanelState> {
  // Every closing gives focus to the editor (VS Code `setPanelHidden`: `activeGroup.focus()`), wherever it was.
  const close = (): LayoutFollowUp<PanelState> => ({ state: { ...s, open: false }, focus: "editor" });
  switch (a.kind) {
    case "panel": return s.open ? close() : { state: { ...s, open: true }, focus: "panel" };
    case "view":
      if (s.open && s.tab === a.tab && focusInPanel) return close();
      return { state: { ...s, open: true, tab: a.tab }, focus: "panel" };
    case "toggle":
      if (s.open && s.tab === a.tab) return close();
      return { state: { ...s, open: true, tab: a.tab }, focus: "panel" };
    case "show": return { state: { ...s, open: true, tab: a.tab }, focus: null };
    case "close": return s.open ? close() : { state: s, focus: null };
    // Closed: open AND maximize (panelActions.ts; an already remembered "maximized" stays), with focus like any opening.
    case "maximize": return s.open ? { state: { ...s, maximized: !s.maximized }, focus: null } : { state: { ...s, open: true, maximized: true }, focus: "panel" };
    case "terminalWay": return s.open && s.tab === "terminal" ? close() : { state: s, focus: null };
  }
}

export type PagesMode = "explorer" | "search" | "debug" | "outline" | "references";
export type PagesStatus = { visible: boolean; mode: PagesMode };
/** Where focus is and what is visible; `focusPanelOrEditor` needs the panel. */
export type PagesSituation = { inPage: boolean; inPanel: boolean; panelOpen: boolean; editorHidden: boolean };
export type PagesAction =
  /** Cmd+B: sidebar on/off. */
  | { kind: "toggle" }
  /** Shift+Cmd+E, Shift+Cmd+D: show the view and focus it; if it is visible and the sidebar has focus, back to the editor. */
  | { kind: "view"; mode: PagesMode }
  /** Shift+Cmd+F (Find in Files): show the search and focus its field, always. */
  | { kind: "search" };

export function pagesStep(s: PagesStatus, a: PagesAction, l: PagesSituation): LayoutFollowUp<PagesStatus> {
  switch (a.kind) {
    case "toggle":
      if (!s.visible) return { state: { ...s, visible: true }, focus: null };
      return { state: { ...s, visible: false }, focus: l.panelOpen && (l.inPanel || l.editorHidden) ? "panel" : "editor" };
    case "view":
      if (s.visible && s.mode === a.mode && l.inPage) return { state: s, focus: "editor" };
      return { state: { visible: true, mode: a.mode }, focus: "page" };
    case "search": return { state: { visible: true, mode: "search" }, focus: "page" };
  }
}

/** The search term from the editor's selection (Shift+Cmd+F, `search.seedWithNearestWord: false`): only a non-empty, one-line selection, and
 *  not when focus is already in the search (`getSearchTextFromEditor`); otherwise null (the field keeps what it has). */
export function searchSeed(selection: string | null | undefined, focusInSearch = false): string | null {
  const t = String(selection ?? "");
  return !focusInSearch && t && !/[\r\n]/.test(t) ? t : null;
}
/** The seed in the field: escaped in regex mode (`strings.escapeRegExpCharacters`), otherwise literal. */
export function seedForField(text: string, regex: boolean): string {
  return regex ? text.replace(/[\\{}*+?|^$.[\]()]/g, "\\$&") : text;
}

/** The panel's remembered state from storage (JSON, may be missing or broken): height > 0, a known tab, maximized only if true. */
export function panelRemembered(raw: unknown): { height: number | null; tab: PanelTab | null; maximized: boolean } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const h = o.height;
  return {
    height: typeof h === "number" && Number.isFinite(h) && h > 0 ? h : null,
    tab: (PANEL_TAB as readonly unknown[]).includes(o.tab) ? (o.tab as PanelTab) : null,
    maximized: o.maximized === true,
  };
}

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type LayoutAction = "sidebar" | "panel" | "explorer" | "search" | "debug" | "problems" | "terminal" | "maximize";
export type LayoutCommandData = { id: string; title: string; shortcut?: string; keys?: readonly string[]; action: LayoutAction };

/** The commands with id, title and shortcut as in VS Code (English titles, German in lib/i18n-de.ts). */
export const LAYOUT_COMMANDS: readonly LayoutCommandData[] = [
  { id: "workbench.action.toggleSidebarVisibility", title: "View: Toggle Primary Side Bar Visibility", shortcut: "⌘B", keys: ["Mod-b"], action: "sidebar" },
  { id: "workbench.action.togglePanel", title: "View: Toggle Panel Visibility", shortcut: "⌘J", keys: ["Mod-j"], action: "panel" },
  { id: "workbench.view.explorer", title: "View: Show Explorer", shortcut: "⇧⌘E", keys: ["Mod-Shift-e"], action: "explorer" },
  { id: "workbench.action.findInFiles", title: "Search: Find in Files", shortcut: "⇧⌘F", keys: ["Mod-Shift-f"], action: "search" },
  { id: "workbench.view.debug", title: "View: Show Run and Debug", shortcut: "⇧⌘D", keys: ["Mod-Shift-d"], action: "debug" },
  { id: "workbench.actions.view.problems", title: "View: Toggle Problems", shortcut: "⇧⌘M", keys: ["Mod-Shift-m"], action: "problems" },
  { id: "workbench.action.terminal.toggleTerminal", title: "View: Toggle Terminal", shortcut: "⌃`", keys: ["Ctrl-`"], action: "terminal" },
  { id: "workbench.action.toggleMaximizedPanel", title: "View: Toggle Maximized Panel", action: "maximize" },
];

/** Does the press match the key? Like `matchesKey` (lib/commandPalette.ts); the key "`" also counts by its position (`Backquote`): on the
 *  German Mac keyboard `key` is a dead character there (same rule as lib/chat-bar.ts). */
export function matchesLayoutKey(name: string, e: KeyPress, mac: boolean): boolean {
  if (matchesKey(name, e, mac)) return true;
  if (!name.endsWith("-`") || e.code !== "Backquote") return false;
  // The position matches; the same computation checks the modifiers, with a substitute key in its place.
  return matchesKey(`${name.slice(0, -1)}x`, { ...e, code: "KeyX", key: "x" }, mac);
}
/** The command for a key press; null: the key does not belong to the layout. A terminal lets exactly these keys through (otherwise the
 *  shell would take Ctrl+B and Ctrl+J off the Mac). */
export function layoutCommandToKey(e: KeyPress, mac: boolean): LayoutCommandData | null {
  return LAYOUT_COMMANDS.find((b) => (b.keys ?? []).some((t) => matchesLayoutKey(t, e, mac))) ?? null;
}
