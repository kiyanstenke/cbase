"use client";

// Tabs styled like VS Code: ONE building block (`TabTile`) for the tabs of the Coding → Files page (`CodeTabBar`, CodePane uncontrolled) and
// for the file/diff tabs and views in the chat (chat/ChatTabBar.tsx — the [Chat · Name] tab stays there). Two versions of the same shape
// had drifted apart.
//
// Look (Dark/Light Modern): 35 px high, 13 px, a hairline on the right of each tab; the active tab carries the editor surface (`bg-panel`)
// and an accent line on top, the others sit on the bar background (`bg-bg`). A preview is italic (double-click or typing pins it), the ✕
// always shows on the active tab and on hover otherwise; unsaved changes are a dot in its place. Middle click closes. The name takes the
// colour of the git state or of a problem (lib/tab-bar.ts `tabColor`), equal names get a dimmed folder suffix (`nameAdditions`), dragging
// reorders. The icon comes ONLY from components/code/FileSymbol.tsx.
//
// The context menu is the ONE editor menu (EditorMenu.tsx: portal on the body, `cb-pop`, document mousedown, no `fixed inset-0`):
// Close · Close Others · Close to the Right · Close Saved · Close All | Copy Path · Copy Relative Path | Open Preview (Markdown only) |
// Reveal in Explorer | Keep Open. A shortcut is shown only where it is bound (the caller passes `shortcut`), an entry that would hit nothing
// is greyed, and "Copy Path" writes the clipboard inside the click itself — the bar reads the root ahead of time (`useRootsUpfront`).
// The bar itself computes nothing: sets, colours, suffixes and the preview rule live in lib/tab-bar.ts (executed in web/test/tab-bar.test.mjs,
// together with the guards over this source).
//
// A tab of the Files page can also carry a Markdown preview or a diff: `display` (computed in CodePane.tsx `displayOf` via
// lib/editor-inputs.ts `tabTitle`) gives name, hint, icon (file or own icon), the relative path for the copy shortcuts and whether
// "Reveal in Explorer View" applies; only file tabs get folder suffixes (VS Code titles such as "README.md (Layout)" carry none).
//
// ACCESS (WAI-ARIA "Tabs"): the role=tab is the label, the ✕ sits NEXT to it and is no tab stop — the caller passes `tabProps` (role,
// roving tabIndex, ref, keys) through.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "@/lib/api";
import { subscribeDiagnostics, diagnosticVersion, diagnosticsOf } from "@/lib/diagnostic-status";
import { bufferKey } from "@/lib/buffer";
import { coordinatesOf } from "@/lib/buffer-coordinates";
import { FileSymbol } from "@/components/code/FileSymbol";
import { openEditorMenu, type MenuItem } from "@/components/code/EditorMenu";
import { tabKey } from "@/lib/chat-tabs";
import { fileTab } from "@/lib/editor-inputs";
import { rememberDrag, copyInTransaction, pathsFrom, dragFrom } from "@/components/code/tab-transaction";
import { fromOtherWindow, foreignFiles, foreignTabHere, tabDragData, type TabLocation } from "@/lib/tab-foreign";
import { DRAG_TYPE as TREE_TYPE } from "@/components/code/explorer/ExplorerTree";
import {
  copyShortcut, nameAdditions, problemKind, closeSet, tabColor, dropAfter, type GitKind, type ProblemKind, type CloseKind,
} from "@/lib/tab-bar";

type T = (key: string, params?: Record<string, string | number>) => string;
type Data = Record<string, string | undefined>;
type DataAttribute = { [k: `data-${string}`]: string | undefined };

/** The data type of a dragged tab (accepted only within ONE bar). */
export const DRAG_TYPE = "application/x-cbase-tab";

/** What a tab's context menu can do — a missing action drops its entry (the chat tab has no "Reveal in Explorer View"). */
export type TabMenuActions = {
  close: () => void;
  closeSet?: (kind: CloseKind) => void;
  /** How many tabs a set would hit — 0 greys its entry (as in VS Code). */
  setCount?: (kind: CloseKind) => number;
  /** The path relative to the target root (file tabs); without it both copy entries are missing. */
  relPath?: string | null;
  /** The root on disk (for "Copy Path"), read AHEAD of time (`useRootsUpfront`, `rootNow`): the clipboard is written inside the click with no
   *  await before it (Safari and Firefox require the gesture there). Unknown: the entry is grey. */
  root?: string | null;
  showInExplorer?: () => void;
  /** "Open Preview" (VS Code `markdown.showPreview`, group `1_open`) — Markdown files only; without it the entry is missing. */
  openPreview?: () => void;
  /** "Keep Open" — previews only. */
  keep?: () => void;
  preview?: boolean;
  /** The BOUND shortcuts — a missing one is not shown. */
  shortcut?: Partial<Record<"close" | "other" | "saved" | "all" | "fixed" | "path" | "relative", string>>;
  /** "Split …" and "Move to …" with this tab, in all four directions; without it the whole block is missing. */
  parts?: TabShare;
};
export type TabDirection = "top" | "bottom" | "left" | "right";
export type TabShare = { parts: (r: TabDirection) => void; move: (r: TabDirection) => void };

/** To the clipboard — synchronously from the click or key. */
export function copyText(text: string): void { void navigator.clipboard?.writeText(text).catch(() => undefined); }
export const fullPath = (root: string, rel: string): string => `${root.replace(/\/+$/, "")}/${rel}`;

/** The entries of a tab's context menu. */
export function tabMenu(t: T, h: TabMenuActions): MenuItem[][] {
  const k = h.shortcut ?? {};
  const empty = (kind: CloseKind) => (h.setCount ? h.setCount(kind) === 0 : false);
  const set = (id: CloseKind, label: string, right?: string): MenuItem => ({ id, label, right, disabled: empty(id), execute: () => h.closeSet?.(id) });
  const groups: MenuItem[][] = [[
    { id: "close", label: t("Close"), right: k.close, execute: h.close },
    ...(h.closeSet ? [
      set("other", t("Close Others"), k.other),
      set("right", t("Close to the Right")),
      set("saved", t("Close Saved"), k.saved),
      set("all", t("Close All"), k.all),
    ] : []),
  ]];
  const rel = h.relPath, w = h.root;
  if (rel) {
    groups.push([
      { id: "path", label: t("Copy Path"), right: k.path, disabled: !w, execute: () => { if (w) copyText(fullPath(w, rel)); } },
      { id: "rel-path", label: t("Copy Relative Path"), right: k.relative, execute: () => copyText(rel) },
    ]);
  }
  if (h.openPreview) groups.push([{ id: "markdown.showPreview", label: t("Open Preview"), execute: h.openPreview }]);
  if (h.showInExplorer) groups.push([{ id: "explorer", label: t("Reveal in Explorer View"), execute: h.showInExplorer }]);
  // VS Code "Keep Open" appears only on a preview (`when: !activeEditorIsPinned`) — otherwise the entry is missing.
  if (h.keep && h.preview) groups.push([{ id: "fixed", label: t("Keep Open"), right: k.fixed, execute: h.keep }]);
  // Like VS Code "Split Right" (group `5_split`) and the "Split & Move" submenu (`1_split` up, down, left, right | `2_move` up, down,
  // left, right); "Split in Group", "Pin", "Reopen Editor With…", "Move into New Window" and "Share" are not supported.
  const parts = h.parts;
  if (parts) {
    groups.push([
      { id: "workbench.action.splitEditor", label: t("Split Right"), execute: () => parts.parts("right") },
      { id: "share-and-move", label: t("Split & Move"), children: [
        [
          { id: "workbench.action.splitEditorUp", label: t("Split Up"), execute: () => parts.parts("top") },
          { id: "workbench.action.splitEditorDown", label: t("Split Down"), execute: () => parts.parts("bottom") },
          { id: "workbench.action.splitEditorLeft", label: t("Split Left"), execute: () => parts.parts("left") },
          { id: "workbench.action.splitEditorRight", label: t("Split Right"), execute: () => parts.parts("right") },
        ],
        [
          { id: "workbench.action.moveEditorToAboveGroup", label: t("Move Above"), execute: () => parts.move("top") },
          { id: "workbench.action.moveEditorToBelowGroup", label: t("Move Below"), execute: () => parts.move("bottom") },
          { id: "workbench.action.moveEditorToLeftGroup", label: t("Move Left"), execute: () => parts.move("left") },
          { id: "workbench.action.moveEditorToRightGroup", label: t("Move Right"), execute: () => parts.move("right") },
        ],
      ] },
    ]);
  }
  return groups;
}

/** The problem of a target's file — asked under the canonical buffer key (the same file in Coding → Files and in a chat has ONE count;
 *  lib/diagnostic-status.ts). Unknown: null. */
export function problemOfTheFile(target: { apiBase: string; instance: string | null }, path: string): ProblemKind | null {
  const k = coordinatesOf(target).toCanon(path);
  return k ? problemKind(diagnosticsOf(bufferKey(k.target, k.path))) : null;
}
/** Redraws when a file's problems change. */
export const useDiagnosticTick = (): number => useSyncExternalStore(subscribeDiagnostics, diagnosticVersion, () => 0);

// The root of a target on disk (for "Copy Path"): `/api/workspaces` read ONCE per window and again whenever a menu opens (a relocated
// project). A copy lives in the run at its original path (as in chat/ChatTabBar.tsx `targetRoot`).
type WsRow = { id: string; path: string; projects?: { id: string; path: string }[] | null };
let wsList: Promise<WsRow[]> | null = null;
const ROOTS = new Map<string, string | null>();
export function rootOf(apiBase: string, fresh = false): Promise<string | null> {
  if (!wsList || fresh) wsList = api<WsRow[]>("/api/workspaces").catch(() => { wsList = null; return []; });
  const wid = /^\/api\/workspaces\/([^/?#]+)$/.exec(apiBase)?.[1];
  const pid = /^\/api\/projects\/([^/?#]+)$/.exec(apiBase)?.[1];
  return wsList.then((l) => {
    let w: string | null = null;
    if (wid) w = l.find((x) => x.id === wid)?.path ?? null;
    else for (const x of l) { const p = x.projects?.find((y) => y.id === pid); if (p) { w = p.path; break; } }
    ROOTS.set(apiBase, w);
    return w;
  });
}
/** The root as known NOW (null: not read yet, or none) — for the clipboard without await. */
export const rootNow = (apiBase: string): string | null => ROOTS.get(apiBase) ?? null;
/** Reads the roots of a bar's targets ahead of time (once per set of targets, the first one fresh — a relocated project). */
export function useRootsUpfront(apiBases: readonly string[]): void {
  const key = [...new Set(apiBases)].sort().join("\n");
  useEffect(() => { (key ? key.split("\n") : []).forEach((a, i) => { void rootOf(a, i === 0); }); }, [key]);
}

export type TabTileProps = {
  t: T;
  name: string;
  /** The dimmed folder suffix of equal names. */
  addition?: string;
  /** The path the icon is chosen by (FileSymbol) — null: `icon`. */
  symbolPath?: string | null;
  icon?: ReactNode;
  active: boolean;
  preview?: boolean;
  dirty?: boolean;
  /** The colour of the name (git, problem) — null: the tab's own. */
  color?: string | null;
  strikethrough?: boolean;
  /** After the name (the instance, "deleted"). */
  byName?: ReactNode;
  hint?: string;
  /** Role, roving tabIndex, ref, keys — onto the role=tab. */
  tabProps: React.ComponentPropsWithRef<"span"> & DataAttribute;
  data?: { wrapper?: Data; close?: Data; point?: Data };
  closeTitle: string;
  onActivate: () => void;
  onKeep?: () => void;
  onClose: () => void;
  menu?: () => MenuItem[][];
  /** `foreign`: location and path of a file — another window at the same location opens it when the tab drops there (lib/tab-foreign.ts). */
  drag?: { key: string; onDropped: (from: string, afterwards: boolean) => void; foreign?: { location: TabLocation; path: string } | null };
  /** The tab is in a NON-active editor group — label dimmed, top edge neutral (VS Code `tab.unfocused*`). */
  dimmed?: boolean;
};

/** A tab styled like VS Code. */
export function TabTile({
  t, name, addition, symbolPath, icon, active, preview = false, dirty = false, color, strikethrough, byName, hint, tabProps, data,
  closeTitle, onActivate, onKeep, onClose, menu, drag, dimmed = false,
}: TabTileProps) {
  const [thrown, setDrop] = useState<null | "beforehand" | "afterwards">(null);
  return (
    <div
      role="presentation"
      onClick={onActivate}
      onDoubleClick={onKeep}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); /* no autoscroll on middle click */ }}
      onContextMenu={menu ? (e) => { e.preventDefault(); e.stopPropagation(); openEditorMenu({ x: e.clientX, y: e.clientY, groups: menu() }); } : undefined}
      draggable={Boolean(drag)}
      // A file tab also carries its path as text (VS Code `fillEditorsDragData`: DataTransfers.TEXT) — with ⇧ over a text editor the editor
      // inserts it like an explorer entry (EditorGroups.tsx drop into the editor); without ⇧ the group catches the drop first.
      onDragStart={drag ? (e) => {
        e.dataTransfer.setData(DRAG_TYPE, drag.key);
        const path = fileTab(drag.key);
        if (path) e.dataTransfer.setData("text/plain", path);
        for (const [type, value] of tabDragData(drag.foreign ?? null)) e.dataTransfer.setData(type, value); // window, location and path
        e.dataTransfer.effectAllowed = "move";
      } : undefined}
      onDragOver={drag ? (e) => {
        // A tab from another window reorders nothing here — the bar opens it (CodeTabBar) or rejects it.
        if (!e.dataTransfer.types.includes(DRAG_TYPE) || fromOtherWindow(e.dataTransfer.types)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDrop(dropAfter(e.clientX, r.left, r.width) ? "afterwards" : "beforehand");
      } : undefined}
      onDragLeave={drag ? () => setDrop(null) : undefined}
      onDrop={drag ? (e) => {
        const from = e.dataTransfer.getData(DRAG_TYPE);
        setDrop(null);
        if (!from || fromOtherWindow(e.dataTransfer.types)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        drag.onDropped(from, dropAfter(e.clientX, r.left, r.width));
      } : undefined}
      className={`group relative flex h-[35px] max-w-[240px] shrink-0 cursor-pointer select-none items-center border-r border-edge pl-2.5 pr-1 text-[13px] ${
        active ? `bg-panel text-fg before:absolute before:inset-x-0 before:top-0 before:h-px ${dimmed ? "before:bg-edge" : "before:bg-accent"}` : "text-dim hover:text-fg"
      }`}
      data-tab-wrapper=""
      data-tab-active={active ? "" : undefined}
      {...data?.wrapper}
    >
      {/* The marker of a drop: a line on the side the tab drops onto. */}
      {thrown && <span aria-hidden className={`pointer-events-none absolute inset-y-1 w-0.5 rounded bg-fg ${thrown === "beforehand" ? "-left-px" : "-right-px"}`} />}
      <span
        {...tabProps}
        title={hint}
        className={`flex min-w-0 items-center gap-1.5 rounded pr-1 outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${dimmed ? "opacity-50" : ""}`}
      >
        {symbolPath ? <FileSymbol path={symbolPath} /> : <span className="inline-grid h-4 w-4 shrink-0 place-items-center">{icon}</span>}
        <span className={`truncate ${preview ? "italic" : ""} ${strikethrough ? "line-through" : ""}`} style={color ? { color: color } : undefined} data-tab-name>{name}</span>
        {addition && <span className="min-w-0 shrink truncate text-[12px] text-dim/80" data-tab-addition>{addition}</span>}
        {byName}
        {/* Unsaved: the dot takes the place of the ✕ (on hover the ✕ is there), as text for screen readers. */}
        {dirty && <span className="pointer-events-none absolute right-[9px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-current group-hover:hidden" data-tab-unsaved aria-hidden {...data?.point} />}
        {dirty && <span className="sr-only">{t("unsaved")}</span>}
      </span>
      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label={t("Close")}
        title={closeTitle}
        className={`ml-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-dim hover:bg-hover hover:text-fg ${dirty || !active ? "opacity-0 group-hover:opacity-100" : ""}`}
        data-tab-close
        {...data?.close}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

// ── The bar of the Coding → Files page ──────────────────────────────────────────────────────────────────────────────────────────
export type CodeTabEntry = {
  /** The tab's key — a file's path, otherwise an input (lib/editor-inputs.ts: Markdown preview, diff). */
  path: string;
  deleted?: boolean;
  /** How a tab that is not a file looks: name, hint, icon (`symbolPath` picks it like a file's, otherwise `icon`), the path for "Copy Path"
   *  (null: the block is missing), "Reveal in Explorer View"; `addition`: the forced suffix of a comparison of equal-named files
   *  (lib/tab-bar.ts `filesAddition`). Without it: a file (name from the path). */
  display?: { name: string; hint: string; symbolPath: string | null; icon?: ReactNode; relPath: string | null; explorer: boolean; kind: string; addition?: string };
};

/**
 * The tab bar of the Files page (CodePane uncontrolled): the same tiles as in the chat, keyboard as there (roving tabIndex,
 * lib/chat-tabs.ts `tabKey`), the editor's buttons on the right (`right`). The state (order, active, preview) belongs to CodePane.
 */
export function CodeTabBar({
  t, tabs, active, preview, apiBase, dirty, git, problem, right, shortcut, mac, onActivate, onKeep, onClose, onCloseSet, onReorder, onShowInExplorer,
  group, onDeposit, onParts, onPreview, location,
}: {
  t: T;
  tabs: readonly CodeTabEntry[];
  active: string | null;
  preview: string | null;
  apiBase: string;
  dirty: (path: string) => boolean;
  git: (path: string) => GitKind | null;
  problem: (path: string) => ProblemKind | null;
  /** The buttons on the right. As a function they get the width of the whole bar (0: not measured yet): whatever has no room next to a tab
   *  (lib/editor-title.ts) moves into "…". */
  right?: ReactNode | ((width: number) => ReactNode);
  /** The bound shortcuts (CodePane binds them) — see `TabMenuActions.shortcut`. */
  shortcut: NonNullable<TabMenuActions["shortcut"]>;
  mac: boolean;
  onActivate: (path: string) => void;
  onKeep: (path: string) => void;
  /** Closes a tab (asks about unsaved changes) — false: cancelled. */
  onClose: (path: string) => Promise<boolean | void> | boolean | void;
  /** Close a menu set (one after the other, a cancel leaves the rest open) — the same as ⌥⌘T, ⌘K U, ⌘K W in CodePane. */
  onCloseSet: (kind: CloseKind, path: string) => void;
  onReorder: (from: string, to: string, afterwards: boolean) => void;
  onShowInExplorer: (path: string) => void;
  /** The group of this bar — `active` false dims it, `area` is the CodePane (only its drags count, components/code/tab-transaction.ts).
   *  Without it: a plain bar. */
  group?: { id: string; active: boolean; area: string };
  /** The location of this bar (origin, route, instance) — a tab from another window at the same location drops here as a file. */
  location?: TabLocation;
  /** A drop on the bar — a tab of ANOTHER group (`files` null, the drag in progress) or explorer entries; `before`: before/after which
   *  tab (on the empty area behind the last). */
  onDeposit?: (before: { path: string; afterwards: boolean } | null, files: string[] | null) => void;
  /** "Split …" and "Move to …" in the tab menu (four directions). */
  onParts?: (path: string) => TabShare;
  /** "Open Preview" in the tab menu of a Markdown file (VS Code `markdown.showPreview`) — undefined: no entry for this tab. */
  onPreview?: (path: string) => (() => void) | undefined;
}) {
  useDiagnosticTick();
  useRootsUpfront([apiBase]);
  // The marker of a drop no tile takes (explorer entries, a tab on the empty area) — x relative to the bar.
  const [marker, setMarker] = useState<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // The width of the whole bar (tabs + buttons) — independent of how many buttons there are, so no back and forth.
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const measures = typeof right === "function";
  useEffect(() => {
    const el = wrapper.current;
    if (!measures || !el || typeof ResizeObserver === "undefined") return;
    const miss = () => setWidth(Math.round(el.getBoundingClientRect().width));
    miss();
    const ro = new ResizeObserver(miss);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measures]);
  const buttons = typeof right === "function" ? right(width) : right;
  const [focus, setFocus] = useState<string | null>(null);
  const node = useRef(new Map<string, HTMLElement>());
  const queue = tabs.map((x) => x.path);
  // The folder suffix of equal names only among files (a tab that is not one carries its own name — "README.md (Layout)").
  const files = tabs.filter((x) => !x.display);
  const additionOf = new Map(nameAdditions(files.map((x) => ({ name: x.path.split("/").pop() || x.path, path: x.path }))).map((z, i) => [files[i].path, z] as const));
  const relOf = (k: string): string | null => { const a = tabs.find((x) => x.path === k)?.display; return a ? a.relPath : k; };
  const carrier = focus !== null && queue.includes(focus) ? focus : active !== null && queue.includes(active) ? active : queue[0] ?? null;
  // Make the active tab visible IN its bar — by hand instead of `scrollIntoView` (which scrolled the ancestors too).
  // Also when the bar gets narrower (a group next to it, the splitter dragged) — VS Code scrolls the active tab along.
  useEffect(() => {
    const bar = scroll.current;
    if (!bar) return;
    const show = () => {
      const el = bar.querySelector<HTMLElement>("[data-tab-active]");
      if (!el) return;
      const e = el.getBoundingClientRect(), l = bar.getBoundingClientRect();
      if (e.left < l.left) bar.scrollLeft -= l.left - e.left;
      else if (e.right > l.right) bar.scrollLeft += Math.min(e.right - l.right, e.left - l.left);
    };
    show();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(show);
    ro?.observe(bar);
    return () => ro?.disconnect();
  }, [active, tabs.length]);
  const key = (e: React.KeyboardEvent, k: string) => {
    const copy = copyShortcut(e, { mac });
    const rel = relOf(k);
    if (copy && rel) { e.preventDefault(); const w = rootNow(apiBase); if (copy === "relative") copyText(rel); else if (w) copyText(fullPath(w, rel)); return; }
    const r = tabKey(e.key, queue, k);
    if (!r) return;
    e.preventDefault();
    if (r.kind === "focus") { setFocus(r.target); node.current.get(r.target)?.focus(); }
    else if (r.kind === "activate") onActivate(r.target);
    else void onClose(r.target);
  };
  // Where a drop lands that no tile takes: before/after the tab under the pointer, otherwise after the last.
  const throwAt = (e: React.DragEvent<HTMLDivElement>): { before: { path: string; afterwards: boolean } | null; x: number } => {
    const bar = e.currentTarget.getBoundingClientRect();
    const wrapper = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tab-wrapper]");
    const path = wrapper?.querySelector<HTMLElement>("[data-code-tab]")?.dataset.codeTab;
    if (wrapper && path) {
      const r = wrapper.getBoundingClientRect(), afterwards = dropAfter(e.clientX, r.left, r.width);
      return { before: { path, afterwards }, x: (afterwards ? r.right : r.left) - bar.left };
    }
    const last = queue[queue.length - 1];
    const el = last ? node.current.get(last)?.closest<HTMLElement>("[data-tab-wrapper]") : null;
    return { before: last ? { path: last, afterwards: true } : null, x: el ? el.getBoundingClientRect().right - bar.left : 0 };
  };
  const transactionHere = (e: React.DragEvent): "tab" | "tree" | "foreign" | null => {
    if (!group || !onDeposit) return null;
    const z = dragFrom(group.area);
    if (z?.kind === "tab" && e.dataTransfer.types.includes(DRAG_TYPE)) return "tab";
    if (z?.kind === "tree" && e.dataTransfer.types.includes(TREE_TYPE)) return "tree";
    if (location && foreignTabHere(e.dataTransfer.types, location)) return "foreign"; // a tab from another window at the same location
    return null;
  };
  return (
    <div
      ref={wrapper}
      className="relative flex h-[35px] min-w-0 shrink-0 items-stretch overflow-hidden bg-bg shadow-[inset_0_-1px_0_var(--color-edge)]"
      data-code-tabs
      data-tab-group={group?.id}
      // A tab of this group is dragged — remember where from (the browser hands out the data only at the drop); ⌥ copies.
      onDragStart={group ? (e) => {
        const path = (e.target as Element | null)?.querySelector?.<HTMLElement>("[data-code-tab]")?.dataset.codeTab;
        if (!path) return;
        rememberDrag({ area: group.area, kind: "tab", group: group.id, path, copy: false });
        e.dataTransfer.effectAllowed = "copyMove";
      } : undefined}
      onDragEnd={group ? () => { rememberDrag(null); setMarker(null); } : undefined}
      onDragOverCapture={group ? (e) => copyInTransaction(e.altKey) : undefined}
      onDragOver={group && onDeposit ? (e) => {
        if (e.defaultPrevented) { if (marker !== null) setMarker(null); return; } // a tile takes the drop (and shows its marker)
        const kind = transactionHere(e);
        if (!kind) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = kind === "tab" && !e.altKey ? "move" : "copy";
        const x = throwAt(e).x;
        if (x !== marker) setMarker(x);
      } : undefined}
      onDragLeave={group ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMarker(null); } : undefined}
      onDrop={group && onDeposit ? (e) => {
        setMarker(null);
        if (e.defaultPrevented) return;
        const kind = transactionHere(e);
        if (!kind) return;
        e.preventDefault();
        let files: string[] | null = null;
        if (kind === "tree") files = pathsFrom(e.dataTransfer.getData(TREE_TYPE));
        if (kind === "foreign") { const f = location ? foreignFiles((type) => e.dataTransfer.getData(type), e.dataTransfer.types, location, TREE_TYPE) : null; if (!f) return; files = f; }
        onDeposit(throwAt(e).before, files);
      } : undefined}
    >
      {marker !== null && <span aria-hidden className="pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded bg-fg" style={{ left: Math.max(0, marker - 1) }} data-tab-bar-marker />}
      <div
        ref={scroll}
        role="tablist"
        aria-label={t("Tabs")}
        className="cb-tabs-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto"
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(null); }}
      >
        {tabs.map((tab) => {
          const p = tab.path, a = tab.display;
          const isActive = p === active;
          const isPreview = p === preview;
          const name = a ? a.name : p.split("/").pop() || p;
          return (
            <TabTile
              key={p}
              t={t}
              name={name}
              addition={a ? a.addition : additionOf.get(p)}
              symbolPath={a ? a.symbolPath : p}
              icon={a?.icon}
              active={isActive}
              preview={isPreview}
              dirty={dirty(p)}
              color={tabColor(git(p), problem(p))}
              strikethrough={tab.deleted}
              byName={tab.deleted ? <span className="shrink-0 text-[11px] font-medium text-danger">{t("deleted")}</span> : null}
              hint={a ? a.hint : p}
              tabProps={{
                role: "tab", "aria-selected": isActive, "aria-keyshortcuts": "Delete", tabIndex: carrier === p ? 0 : -1,
                ref: (el: HTMLElement | null) => { if (el) node.current.set(p, el); else node.current.delete(p); },
                onFocus: () => setFocus(p), onKeyDown: (e) => key(e, p),
                "data-code-tab": p, "data-code-tab-preview": isPreview ? "" : undefined, "data-code-tab-kind": a?.kind,
              }}
              closeTitle={shortcut.close ? `${t("Close")} (${shortcut.close})` : t("Close")}
              onActivate={() => onActivate(p)}
              onKeep={() => onKeep(p)}
              onClose={() => { void onClose(p); }}
              menu={() => tabMenu(t, {
                close: () => { void onClose(p); },
                closeSet: (kind) => onCloseSet(kind, p),
                setCount: (kind) => closeSet(kind, queue, p, (x) => !dirty(x)).length,
                relPath: a ? a.relPath : p, root: rootNow(apiBase),
                showInExplorer: a && !a.explorer ? undefined : () => onShowInExplorer(a?.relPath ?? p),
                openPreview: onPreview?.(p),
                keep: () => onKeep(p), preview: isPreview,
                shortcut,
                parts: onParts?.(p),
              })}
              // A tab from the OTHER group of this area drops here (moves, ⌥ copies); from the same group it reorders.
              drag={{ key: p, foreign: location && fileTab(p) ? { location, path: p } : null, onDropped: (from, afterwards) => {
                const z = group ? dragFrom(group.area) : null;
                if (group && onDeposit && z?.kind === "tab" && z.group !== group.id) onDeposit({ path: p, afterwards }, null);
                else onReorder(from, p, afterwards);
              } }}
              dimmed={group ? !group.active : false}
            />
          );
        })}
      </div>
      {buttons && <div className="relative z-10 flex shrink-0 items-center gap-0.5 bg-bg px-1.5" data-tab-bar-actions>{buttons}</div>}
    </div>
  );
}
