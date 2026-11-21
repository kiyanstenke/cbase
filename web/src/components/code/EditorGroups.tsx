"use client";

// The editor groups as in VS Code, as a GRID: the DRAWING for Coding → Files. The calculations are in lib/editor-groups.ts and
// lib/editor-raster.ts, the connection (state, commands, keys) in editor-groups-connection.ts; CodePane supplies header and content per
// group and executes the commands (`groupsCommand`).
//
//   - `EditorGroupsSurface`: the groups in the grid (lib/editor-raster.ts `layoutPx` over the measured surface), each with its own tab
//     bar (from the caller) and its own editor. Every group stands ABSOLUTE at its place and flat under ONE root, in id order
//     (lib/editor-groups.ts `domOrder`; in grid order React would move the nodes and scroll state and focus would be lost), so a
//     restructuring of the tree (split, move, layout, flip) mounts no editor anew and moves no node. Between two groups a line (1 px
//     `edge`, like VS Code `editorGroup.border` above the second's edge) and over it THE drag bar of the panel (panel/DragBar.tsx,
//     `.cb-sash`, 4 px): dragging moves the border, the groups before and behind give way down to their minimum size (VS Code
//     SplitView, 220 × 70 px), in the 2×2 grid the line of the other branch moves along; it is stored only on release, a double click
//     evens out the branch. A maximised group (Cmd+K Cmd+M) takes the whole surface, the others stay mounted (undo, scroll state).
//     A pointer press or focus in a group makes it active, IMMEDIATELY, so that a Cmd-click in another group already jumps within it.
//   - Dragging: a tab of this area or entries of its explorer over a group's surface show the zone as in VS Code
//     (`editorGroup.dropBackground`: dark #53595D80, light #2677CB2E; the whole surface or the half left, right, top or bottom onto
//     which it is split; lib/editor-groups.ts `dropZone`), faded in and moved as in VS Code (only with motion allowed: opacity 150 ms,
//     position and size 70 ms, `ease-out`); the drop goes to `onDeposit`. With Shift over a group whose front is a text editor, the zone
//     is dropped and the drop belongs to the editor (VS Code `editor.dropIntoEditor`: it inserts the path), for tabs and explorer
//     entries alike. An empty group beside others carries a top-right X "Close Group" (VS Code `EmptyEditorGroup`); its context menu
//     splits up/down/left/right and closes (VS Code `EmptyEditorGroupContext`).
//   - `GroupsButtons`: "Split Editor Right" (Cmd+\, with Alt, or Shift over the button, "Split Editor Down", as VS Code shows an
//     entry's `alt`) and "…" (the "…" menu through the ONE editor menu, EditorMenu.tsx: portal, `cb-pop`) on the right of every group's
//     tab bar. There is no cap.
//   - `GroupsEditor`: the editor of a group (BufferEditor) with the extensions of ITS file: every group has its own view (scroll state,
//     selection), the same file shares the buffer.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Extension } from "@codemirror/state";
import { useResolvedTheme } from "@/lib/theme";
import type { Buffer } from "@/lib/buffer";
import * as R from "@/lib/editor-raster";
import { domOrder, shortcutOf, maximizedGroup, rasterOf, splittable, dropZone, pullSeparator, type Group, type GroupsStatus, type Direction, type Before, type Zone } from "@/lib/editor-groups";
import { fileTab } from "@/lib/editor-inputs";
import { isMac } from "@/lib/chat-bar";
import { BufferEditor } from "@/components/code/BufferEditor";
import { DRAG_TYPE as TAB_TYPE } from "@/components/code/TabBar";
import { DRAG_TYPE as TREE_TYPE } from "@/components/code/explorer/ExplorerTree";
import { copyInTransaction, rememberDrag, pathsFrom, dragFrom } from "@/components/code/tab-transaction";
import { foreignFiles, foreignTabHere, type TabLocation } from "@/lib/tab-foreign";
import { DragBar } from "@/components/code/panel/DragBar";
import { openEditorMenu, type MenuItem } from "@/components/code/EditorMenu";
import { MoreButton, TitleSymbolSvg } from "@/components/code/EditorTitleSymbols";

type T = (key: string, params?: Record<string, string | number>) => string;

/** What a drag over the surface or bar of THIS area carries; null: nothing for the editor. "foreign" (foreign): a tab from ANOTHER window
 *  at the same location (lib/tab-foreign.ts); it opens its file like a drop from the explorer (VS Code `editorDropTarget`); likewise entries
 *  from the explorer of another window at the same location. */
export function transactionKind(e: React.DragEvent, area: string, location: TabLocation | null = null): "tab" | "tree" | "foreign" | null {
  const z = dragFrom(area);
  const types = e.dataTransfer.types;
  if (z?.kind === "tab" && types.includes(TAB_TYPE)) return "tab";
  if (z?.kind === "tree" && types.includes(TREE_TYPE)) return "tree";
  if (location && (types.includes(TAB_TYPE) || types.includes(TREE_TYPE)) && foreignTabHere(types, location)) return "foreign";
  return null;
}

/** Does a drag carry a tab or explorer entries (from any area, another window too)? */
export const cbaseTransaction = (e: { dataTransfer: { types: readonly string[] } }) => e.dataTransfer.types.includes(TAB_TYPE) || e.dataTransfer.types.includes(TREE_TYPE);
/** What the surface takes from a drag of its area: with groups (Coding → Files) tabs and explorer entries, in the chat (one group, whose
 *  tab bar the chat orders) only explorer entries; they open as in VS Code (`editorDropTarget`: files open in the group). */
export const acceptable = (kind: "tab" | "tree" | "foreign" | null, droppable: boolean): "tab" | "tree" | "foreign" | null => (kind === "tab" && !droppable ? null : kind);

/** Does a drop with Shift go to the group's editor instead of the group (VS Code `DropOverlay`: `enableDropIntoEditor &&
 *  isDropIntoEditorEvent(e)` ⇒ `dispose`)? Only if a text editor is in front (`isDropIntoActiveEditorEnabled`: the active editor can
 *  `CanDropIntoEditor`); over an empty group, a preview or a comparison Shift does not apply, the zone stays. For every drag, tab or explorer. */
const throwInTheEditor = (e: React.DragEvent, g: Group) => e.shiftKey && fileTab(g.active) !== null;

/** The drop's area per zone (VS Code `DropOverlay.positionOverlay`: halves in percent). */
const THROW_SURFACE: Record<Zone, React.CSSProperties> = {
  middle: { left: 0, top: 0, width: "100%", height: "100%" },
  left: { left: 0, top: 0, width: "50%", height: "100%" },
  right: { left: "50%", top: 0, width: "50%", height: "100%" },
  top: { left: 0, top: 0, width: "100%", height: "50%" },
  bottom: { left: 0, top: "50%", width: "100%", height: "50%" },
};

/** The context menu of an EMPTY group (VS Code `MenuId.EmptyEditorGroupContext`: "2_split" up/down/left/right, "5_close" Close only with
 *  several groups; cbase cannot do "New Window" and "Lock"). */
export function emptyGroupMenu(t: T, several: boolean, parts: (r: Direction) => void, close: () => void): MenuItem[][] {
  const groups: MenuItem[][] = [[
    { id: "workbench.action.splitEditorUp", label: t("Split Up"), execute: () => parts("top") },
    { id: "workbench.action.splitEditorDown", label: t("Split Down"), execute: () => parts("bottom") },
    { id: "workbench.action.splitEditorLeft", label: t("Split Left"), execute: () => parts("left") },
    { id: "workbench.action.splitEditorRight", label: t("Split Right"), execute: () => parts("right") },
  ]];
  if (several) groups.push([{ id: "workbench.action.closeActiveEditorGroup", label: t("Close"), execute: close }]);
  return groups;
}

export function EditorGroupsSurface({ t, status, load, area, location = null, droppable, onActivate, onPull, onBranchFrom, onAlign, onCloseGroup, onParts, onDeposit, header, content }: {
  t: T;
  status: GroupsStatus;
  /** Counts every restoration of the state (editor-groups-connection.ts); a restored state is no restructuring of the grid. */
  load: number;
  /** The area (ONE CodePane); only its drags are accepted (tab-transaction.ts). */
  area: string;
  /** The CodePane's location (origin, route, instance): a tab from another window at the same location opens its file here. */
  location?: TabLocation | null;
  /** Dragging and splitting work (Coding → Files); not in the chat (controlled), where only a drop from the explorer opens (centre). */
  droppable: boolean;
  onActivate: (group: string) => void;
  /** A divider was released: `way` px since the press at line `index` of branch `branch` (`length` px long). */
  onPull: (branch: R.Location, index: number, distance: number, length: number) => void;
  /** Double click on a divider: even out its branch. */
  onBranchFrom: (branch: R.Location) => void;
  /** The grid changed: align the proportions with what is drawn (`width` × `height` the surface, lib/editor-groups.ts `alignTo`). */
  onAlign: (width: number, height: number) => void;
  onCloseGroup: (group: string) => void;
  /** Split from the context menu of an empty group. */
  onParts: (group: string, direction: Direction) => void;
  /** A drop on a group's surface: `files` null means a tab (the current drag). */
  onDeposit: (group: string, zone: Zone, before: Before, files: string[] | null) => void;
  header: (g: Group, active: boolean) => ReactNode;
  content: (g: Group, active: boolean) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [mass, setMass] = useState({ w: 0, h: 0 });
  const [thrown, setDrop] = useState<{ group: string; zone: Zone } | null>(null);
  // While dragging only here (no state, no localStorage per movement); stored on release, computed from the state at the press.
  const [turn, setDrag] = useState<R.Raster | null>(null);
  const transactionStart = useRef<GroupsStatus | null>(null);
  const dark = useResolvedTheme() === "dark";
  const maximized = maximizedGroup(status);
  const several = status.groups.length > 1 && !maximized;
  // Measured BEFORE drawing (otherwise the grid would stand at 0 × 0 for one tick) and on every resize.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setMass((m) => (m.w === r.width && m.h === r.height ? m : { w: r.width, h: r.height })); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const raster = turn ?? rasterOf(status);
  const measured = mass.w > 0 && mass.h > 0;
  // After every change of the grid (not after a resize of the surface, not while dragging, not maximised) the proportions become what is
  // drawn (VS Code `saveProportions`): if a minimum size held a column wider, the grid would otherwise jump as soon as a group closes.
  // An insertion is also finished in pixels here (lib/editor-raster.ts `backfill`), BEFORE drawing, otherwise the halved source would stand
  // there for one tick. A restored state (`load`) is no restructuring: it becomes the basis without being aligned, otherwise a small
  // window would remember its clamps as proportions after a reload.
  const massNow = useRef(mass);
  massNow.current = mass;
  const alignedWith = useRef(status.raster);
  const loadedAt = useRef(load);
  useLayoutEffect(() => {
    if (loadedAt.current !== load) { loadedAt.current = load; alignedWith.current = status.raster; return; }
    if (alignedWith.current === status.raster) return;
    alignedWith.current = status.raster;
    const m = massNow.current;
    if (turn || maximized || !(m.w > 0 && m.h > 0)) return;
    onAlign(m.w, m.h);
  }, [status.raster, load, turn, maximized, onAlign]);
  // Unmeasured (the surface is hidden): proportions in percent, without drag bars.
  const situation = useMemo(() => (measured ? R.layoutPx(raster, mass.w, mass.h) : { boxes: R.boxes(raster), separator: [] as R.Separator[] }), [raster, measured, mass.w, mass.h]);
  const slot = (id: string): React.CSSProperties => {
    const k = situation.boxes.get(id);
    if (!several || !k) return { left: 0, top: 0, width: "100%", height: "100%" };
    return measured ? { left: k.x, top: k.y, width: k.w, height: k.h } : { left: `${k.x * 100}%`, top: `${k.y * 100}%`, width: `${k.w * 100}%`, height: `${k.h * 100}%` };
  };
  const zoneAt = (e: React.DragEvent, g: Group): Zone => {
    const z = dragFrom(area);
    const r = e.currentTarget.getBoundingClientRect();
    return dropZone(e.clientX - r.left, e.clientY - r.top, r.width, r.height, splittable(status, g.id, z?.kind === "tab" && !z.copy ? z : null));
  };
  return (
    <div ref={root} className="relative min-h-0 min-w-0 flex-1 overflow-hidden" data-editor-groups={status.groups.length}>
      {domOrder(status.groups).map((g) => {
        const active = !several || g.id === status.active;
        const hidden = maximized !== null && g.id !== maximized;
        const empty = g.paths.length === 0;
        return (
          <div
            key={g.id}
            role="group"
            aria-label={status.groups.length > 1 ? t("Editor Group {n}", { n: status.groups.indexOf(g) + 1 }) : undefined}
            tabIndex={-1}
            // An empty group with focus carries the focus border (VS Code `focusBorder`), otherwise none.
            className={`absolute flex min-h-0 min-w-0 flex-col overflow-hidden outline-none ${empty ? "focus:outline-1 focus:-outline-offset-1 focus:outline-accent" : ""} ${hidden ? "hidden" : ""}`}
            style={slot(g.id)}
            data-editor-group={g.id}
            data-editor-location={`${area}:${g.id}`}
            data-editor-group-active={active ? "" : undefined}
            data-editor-group-maximized={maximized === g.id ? "" : undefined}
            onMouseDownCapture={() => onActivate(g.id)}
            onFocusCapture={() => onActivate(g.id)}
            onContextMenu={droppable && empty ? (e) => {
              if (e.defaultPrevented) return;
              e.preventDefault();
              openEditorMenu({ x: e.clientX, y: e.clientY, groups: emptyGroupMenu(t, status.groups.length > 1, (r) => onParts(g.id, r), () => onCloseGroup(g.id)) });
            } : undefined}
          >
            {header(g, active)}
            <div
              className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
              // In the CAPTURE phase: the editor beneath (CodeMirror) would otherwise take a drag as text (explorer and tab carry text/plain) and
              // insert the paths; VS Code opens the file, and only with Shift over a text editor inserts its path (`editor.dropIntoEditor`).
              onDragOverCapture={(e) => {
                const kind = acceptable(transactionKind(e, area, location), droppable);
                // A tab or explorer entry THIS surface does not take (from another area: chat ↔ files, another window; or a tab in the chat,
                // which has only one group) NEVER falls into the editor as text (VS Code: only with Shift).
                if (!kind) { if (cbaseTransaction(e) && !throwInTheEditor(e, g)) { e.stopPropagation(); if (thrown) setDrop(null); } return; }
                if (throwInTheEditor(e, g)) { if (thrown) setDrop(null); return; }
                e.stopPropagation();
                if (kind === "tab") copyInTransaction(e.altKey);
                const zone = droppable ? zoneAt(e, g) : "middle", z = dragFrom(area);
                // A tab dropped in the middle of its own surface changes nothing: no zone, no drop (VS Code); the editor beneath shows no
                // insertion mark either (it would otherwise get the drag as text).
                if (zone === "middle" && z?.kind === "tab" && z.group === g.id && !e.altKey) {
                  e.stopPropagation();
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "none";
                  if (thrown) setDrop(null);
                  return;
                }
                e.preventDefault();
                e.dataTransfer.dropEffect = kind === "tab" && !e.altKey ? "move" : "copy";
                if (thrown?.group !== g.id || thrown.zone !== zone) setDrop({ group: g.id, zone });
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null); }}
              onDropCapture={(e) => {
                const kind = acceptable(transactionKind(e, area, location), droppable);
                setDrop(null);
                if (throwInTheEditor(e, g)) return;
                if (!kind) { if (cbaseTransaction(e)) { e.preventDefault(); e.stopPropagation(); } return; } // never as text into the editor
                e.preventDefault();
                e.stopPropagation();
                const zone = droppable ? zoneAt(e, g) : "middle";
                let files = kind === "tree" ? pathsFrom(e.dataTransfer.getData(TREE_TYPE)) : null;
                // A foreign tab names its location on the drop; only EXACTLY that one opens (the id in the type might coincide by chance).
                if (kind === "foreign") { const f = location ? foreignFiles((type) => e.dataTransfer.getData(type), e.dataTransfer.types, location, TREE_TYPE) : null; if (!f) return; files = f; }
                onDeposit(g.id, zone, null, files);
                rememberDrag(null); // The drag is over: its state must not interpret a later drop (dragend does not always come)
              }}
              data-editor-group-surface
            >
              {content(g, active)}
              {several && empty && (
                <button
                  type="button"
                  onClick={() => onCloseGroup(g.id)}
                  title={t("Close Group")}
                  aria-label={t("Close Group")}
                  className="absolute right-1.5 top-1.5 grid h-[22px] w-[22px] place-items-center rounded text-dim hover:bg-hover hover:text-fg"
                  data-group-close={g.id}
                >
                  <TitleSymbolSvg name="close" />
                </button>
              )}
              {thrown?.group === g.id && (
                // As in VS Code (`.monaco-enable-motion … .editor-group-overlay-indicator`): fades in over 150 ms (opacity 0 → 1, `ease-out`)
                // and moves between zones in 70 ms (`overlay-move-transition`: top/left/width/height), only if motion is allowed
                // (prefers-reduced-motion). The first appearance already stands at its place (VS Code attaches the motion only after
                // `setTimeout(0)`; a newly mounted node has no transition).
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-30 motion-safe:[animation:fade-in_150ms_ease-out] motion-safe:[transition:top_70ms_ease-out,left_70ms_ease-out,width_70ms_ease-out,height_70ms_ease-out]"
                  style={{ ...THROW_SURFACE[thrown.zone], background: dark ? "#53595d80" : "#2677cb2e" }}
                  data-group-throw={thrown.zone}
                />
              )}
            </div>
          </div>
        );
      })}
      {several && situation.separator.map((tr) => {
        const nb = tr.situation === "sideBySide", key = `${tr.branch.join(".")}:${tr.index}`;
        return (
          <div key={key}>
            <div
              aria-hidden
              className="pointer-events-none absolute z-20 bg-edge"
              style={nb ? { left: tr.x, top: tr.y, width: 1, height: tr.length } : { left: tr.x, top: tr.y, width: tr.length, height: 1 }}
              data-groups-separator={key}
            />
            <DragBar
              direction={nb ? "vertical" : "horizontal"}
              className="absolute z-20"
              label={nb ? t("Editor group width") : t("Editor group height")}
              data={{ "data-groups-handle": key }}
              onDrag={(distance, finished) => {
                const start = (transactionStart.current ??= status);
                if (!finished) { setDrag(rasterOf(pullSeparator(start, tr.branch, tr.index, distance, tr.lengthBranch))); return; }
                transactionStart.current = null;
                setDrag(null);
                onPull(tr.branch, tr.index, distance, tr.lengthBranch);
              }}
              onBack={() => onBranchFrom(tr.branch)}
              style={nb ? { left: tr.x - 2, top: tr.y, height: tr.length } : { left: tr.x, top: tr.y - 2, width: tr.length }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Which modifiers are currently pressed (VS Code `ModifierKeyEmitter`: keys and mouse in the whole window; focus lost ⇒ none). */
function useSwitcher(): { alt: boolean; shift: boolean } {
  const [s, setS] = useState({ alt: false, shift: false });
  useEffect(() => {
    const set = (e: KeyboardEvent | MouseEvent) => setS((v) => (v.alt === e.altKey && v.shift === e.shiftKey ? v : { alt: e.altKey, shift: e.shiftKey }));
    const release = () => setS((v) => (!v.alt && !v.shift ? v : { alt: false, shift: false }));
    window.addEventListener("keydown", set, true);
    window.addEventListener("keyup", set, true);
    window.addEventListener("mousedown", set, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", set, true);
      window.removeEventListener("keyup", set, true);
      window.removeEventListener("mousedown", set, true);
      window.removeEventListener("blur", release);
    };
  }, []);
  return s;
}

/** On the right of every group's tab bar: "Split Editor Right" and "…" (VS Code: split symbol, then "More Actions…"). With Alt in the
 *  window, or Shift while the pointer is on the button, it becomes "Split Editor Down" (VS Code `MenuEntryActionViewItem` with `alt`);
 *  its tooltip names both ("{0}\n[{1}] {2}"). `onShare(bottom)`. */
export function GroupsButtons({ t, onShare, menu }: { t: T; onShare: (bottom: boolean) => void; menu: () => MenuItem[][] }) {
  const buttonEl = "grid h-[22px] w-[22px] shrink-0 place-items-center rounded text-dim hover:bg-hover hover:text-fg";
  const u = useSwitcher();
  const [over, setOver] = useState(false);
  const bottom = u.alt || (u.shift && over);
  const right = `${t("Split Editor Right")} (${shortcutOf("workbench.action.splitEditor")})`;
  const down = `${t("Split Editor Down")} (${shortcutOf("workbench.action.splitEditorDown")})`;
  return (
    <>
      <button
        type="button"
        onClick={(e) => onShare(bottom || e.altKey)}
        onMouseEnter={() => setOver(true)}
        onMouseLeave={() => setOver(false)}
        aria-label={bottom ? t("Split Editor Down") : t("Split Editor Right")}
        title={bottom ? down : `${right}\n[${isMac() ? "⌥" : "Alt"}] ${down}`}
        className={buttonEl}
        data-group-share={bottom ? "bottom" : "right"}
      >
        <TitleSymbolSvg name={bottom ? "split-vertical" : "split-horizontal"} />
      </button>
      <MoreButton t={t} menu={menu} data={{ "data-group-more": "" }} />
    </>
  );
}

/** The editor of a group: the extensions of ITS file (`build`), otherwise BufferEditor unchanged. */
export function GroupsEditor({ build, path, file, ...rest }: Omit<React.ComponentProps<typeof BufferEditor>, "extensions"> & {
  build: (path: string | null, p: Buffer | null) => Extension;
  path: string | null;
  /** The file's buffer if loaded (otherwise null); for the extensions. */
  file: Buffer | null;
}) {
  const extensions = useMemo(() => build(path, file), [build, path, file]);
  return <BufferEditor {...rest} extensions={extensions} />;
}
