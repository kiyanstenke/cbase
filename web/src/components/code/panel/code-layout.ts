"use client";
// The connection of the Coding → Files layout like VS Code. The computations live purely in lib/panel-layout.ts; here is only what connects
// them to CodePane:
//
//   useCodeLayout       the state of the lower panel (open, tab, maximised, height) and the sidebar width — height, tab, maximised and
//                       width remembered PER DEVICE (localStorage, every access in try/catch: private, full, blocked ⇒ default); open or
//                       closed is NOT remembered (a page starts without a panel — a remembered TERMINAL would otherwise start a shell on every
//                       load). Read BEFORE the first frame (useLayoutEffect) together with the refs, so that a step in the same pass does not
//                       overwrite the remembered values with the default. `bottom`/`setBottom` are the form in which CodePane knew the panel
//                       before (tab or null). The terminals stay mounted once they ran (VS Code: closing a panel ends no shell); one is gone after
//                       "Kill Terminal" or when its process ends. A LIST (lib/terminal-list.ts): `newTerminal(folder)` is the explorer's "Open
//                       in Integrated Terminal" — a new terminal in that folder, in front, the panel open on TERMINAL (the new xterm takes focus on
//                       start).
//   useLayoutConnection  the keys ⌘B ⌘J ⇧⌘E ⇧⌘F ⇧⌘D ⇧⌘M ⌃` — REGISTERED in the command table (lib/editor-commands.ts: in the editor the table binds
//                       them, in the palette they appear as commands) and outside the editor via `key` at CodePane's root; on the Files page
//                       also when focus is nowhere (document). Where focus goes afterwards is told by the computation (`panelStep`, `pagesStep`).
//   usePagesWidth     the sidebar width: while dragging directly on the element (at most once per frame, no CodePane redraw), remembered on
//                       release; below half the minimum width it snaps off (hidden, the width stays remembered).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { command, registerCommand } from "@/lib/editor-commands";
import { isMac } from "@/lib/chat-bar";
import { paletteCommandToKey } from "@/lib/commandPalette";
import {
  EDITOR_MIN_WIDTH, snap, LAYOUT_COMMANDS, layoutCommandToKey, optimalWidthFrom, panelRemembered, panelStep, SIDEBAR_MIN, sidebarWidth,
  sidebarBack, pagesStep, searchSeed,
  type LayoutAction, type PanelAction, type PanelTab, type PanelState, type PagesMode,
} from "@/lib/panel-layout";
import type { EditorContext } from "@/components/code/lsp-core";
import type { PaletteCommand } from "@/components/code/palette-modes";
import { TERMINAL_EMPTY, terminalStep, type TerminalAction, type TerminalState } from "@/lib/terminal-list";

const PANEL_KEY = "cbase-code-panel";
const PAGE_KEY = "cbase-code-sidebar";

function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function write(key: string, value: Record<string, unknown>): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered — the size applies until reload */ }
}

export type CodeLayout = ReturnType<typeof useCodeLayout>;

export function useCodeLayout() {
  const [status, setStatus] = useState<PanelState>({ open: false, tab: "problems", maximized: false });
  const [height, setHeightRaw] = useState<number | null>(null);
  const [width, setWidthRaw] = useState<number | null>(null);
  const [terminals, setTerminals] = useState<TerminalState>(TERMINAL_EMPTY);
  const terminal = useCallback((a: TerminalAction) => setTerminals((x) => terminalStep(x, a)), []);
  const [seed, setSeed] = useState<{ seq: number; text: string } | null>(null);
  const seedSeq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(status), heightRef = useRef(height);
  stateRef.current = status;
  heightRef.current = height;
  // Read the remembered values after mounting but BEFORE the first frame (built statically — there is no localStorage while hydrating); the refs
  // at once too, otherwise a step in the same pass (`setBottom` on debug start) would write the default over the remembered values.
  useLayoutEffect(() => {
    const p = panelRemembered(read(PANEL_KEY));
    const s = read(PAGE_KEY) as { width?: unknown } | null;
    heightRef.current = p.height;
    setHeightRaw(p.height);
    const fresh = { ...stateRef.current, tab: p.tab ?? stateRef.current.tab, maximized: p.maximized };
    stateRef.current = fresh;
    setStatus(fresh);
    const b = s?.width;
    if (typeof b === "number" && Number.isFinite(b) && b > 0) setWidthRaw(b);
  }, []);
  const rememberPanel = useCallback((s: PanelState, h: number | null) => write(PANEL_KEY, { height: h, tab: s.tab, maximized: s.maximized }), []);
  /** Set a new state (remembered: tab, maximised); if it shows TERMINAL without a terminal, one starts in the root. */
  const set = useCallback((s: PanelState) => {
    if (s.open && s.tab === "terminal") terminal({ kind: "safe" });
    const old = stateRef.current;
    stateRef.current = s;
    setStatus(s);
    if (old.tab !== s.tab || old.maximized !== s.maximized) rememberPanel(s, heightRef.current);
  }, [rememberPanel, terminal]);
  /** The height after dragging (on release and on double click — while dragging the panel sets it itself on the element). */
  const setHeight = useCallback((h: number, remember: boolean) => {
    heightRef.current = h;
    setHeightRaw(h);
    if (remember) rememberPanel(stateRef.current, h);
  }, [rememberPanel]);
  const setWidth = useCallback((b: number, remember: boolean) => {
    setWidthRaw(b);
    if (remember) write(PAGE_KEY, { width: b });
  }, []);
  // The form from before: the open tab or null. A tab shows the panel on it (without taking focus), null closes.
  const bottom: PanelTab | null = status.open ? status.tab : null;
  const setBottom = useCallback((v: PanelTab | null | ((b: PanelTab | null) => PanelTab | null)) => {
    const s = stateRef.current;
    const fresh = typeof v === "function" ? v(s.open ? s.tab : null) : v;
    set(fresh === null ? { ...s, open: false } : { ...s, open: true, tab: fresh });
  }, [set]);
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  /** A terminal goes away — "Kill Terminal" (the active or the named one) or its process ended. true if the LAST one went: then
   *  `useLayoutConnection().terminalWay` closes the panel if it showed TERMINAL (VS Code `terminal.integrated.hideOnLastClosed`). */
  const endTerminal = useCallback((seq?: number): boolean => {
    const old = terminalsRef.current;
    const fresh = terminalStep(old, { kind: "end", seq });
    if (fresh === old) return false; // already gone (a second way to the same end)
    terminalsRef.current = fresh;
    setTerminals(fresh);
    return !fresh.list.length;
  }, []);
  /** "Open in Integrated Terminal": a NEW terminal in the folder (project-relative, "" = the root), in front, the panel on TERMINAL. */
  const newTerminal = useCallback((folder: string) => {
    terminal({ kind: "fresh", cwd: folder });
    const s = stateRef.current;
    set({ ...s, open: true, tab: "terminal" });
  }, [terminal, set]);
  const selectTerminal = useCallback((seq: number) => terminal({ kind: "select", seq }), [terminal]);
  /** ⇧⌘F: a new seed for the search (the number grows, even after consumption). */
  const seedSearch = useCallback((text: string) => { seedSeq.current += 1; setSeed({ seq: seedSeq.current, text }); }, []);
  /** The search has taken the seed — mounting the search again does not repeat it. */
  const seedConsumed = useCallback(() => setSeed(null), []);
  return { state: status, set, stateRef, bottom, setBottom, height, setHeight, width, setWidth, terminals, endTerminal, newTerminal, selectTerminal, seed, seedSearch, seedConsumed, panelRef, pagesRef };
}

// ── The commands in the table ───────────────────────────────────────────────────────────────────────────────────────────────────
type Host = { root: () => HTMLElement | null; performAction: (a: LayoutAction) => void };
const HOSTS = new Set<Host>();
const hostOf = (view: EditorView): Host | null => { for (const w of HOSTS) if (w.root()?.contains(view.dom)) return w; return null; };
let entered = false;
/** The layout commands into the command table once per window — apply only in an editor that stands in a layout (otherwise the key stays free). */
function enterLayoutOne() {
  if (entered) return;
  entered = true;
  for (const b of LAYOUT_COMMANDS) {
    if (command(b.id)) continue;
    registerCommand<EditorContext>({
      id: b.id, title: b.title, shortcut: b.shortcut, keys: b.keys,
      condition: (_situation, k) => Boolean(hostOf(k.view)),
      execute: (k) => { hostOf(k.view)?.performAction(b.action); },
    });
  }
}

const inDocument = (t: EventTarget | null): boolean => !(t instanceof Element) || t === document.body || t === document.documentElement;
const nextFrame = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));
/** What a terminal lets through in the layout (VS Code `commandsToSkipShell`): the layout and palette keys — outside the Mac the shell would
 *  otherwise take Ctrl+B, Ctrl+J, Ctrl+Shift+P. */
export const keyForTheWorkbench = (e: KeyboardEvent): boolean => Boolean(layoutCommandToKey(e, isMac()) || paletteCommandToKey(e, isMac()));

export function useLayoutConnection(lay: CodeLayout, o: {
  root: React.RefObject<HTMLElement | null>;
  active: boolean;
  /** The Files page (not a chat's code area): the keys also apply when focus is nowhere. */
  pageFiles: boolean;
  page: { visible: boolean; mode: PagesMode; setMode: (m: PagesMode) => void; toggle: () => void; show: () => void };
  editor: () => EditorView | null;
}) {
  const oRef = useRef(o);
  oRef.current = o;
  const focus = useCallback((target: "panel" | "page" | "editor" | null) => {
    if (!target) return;
    nextFrame(() => {
      if (target === "editor") { oRef.current.editor()?.focus(); return; }
      if (target === "panel") {
        const p = lay.panelRef.current, r = lay.stateRef.current.tab;
        const content = p?.querySelector<HTMLElement>(`[data-panel-content="${r}"]`);
        // The view itself (list, empty text, input, the FRONT terminal — a hidden one carries `data-terminal-inactive`); if it has
        // nothing focusable, its content — focus is then IN the panel, and a second ⇧⌘M closes (otherwise it would reopen forever).
        (content?.querySelector<HTMLElement>("[data-panel-focus], textarea:not([data-terminal-inactive] textarea)") ?? content)?.focus({ preventScroll: true });
        return;
      }
      const s = lay.pagesRef.current;
      const field = s?.querySelector<HTMLInputElement>("[data-search-field]");
      if (field) { field.focus(); field.select(); return; }
      s?.querySelector<HTMLElement>(".cb-tree, [tabindex='0']")?.focus({ preventScroll: true });
    });
  }, [lay.panelRef, lay.pagesRef, lay.stateRef]);
  const panelStepFrom = useCallback((a: PanelAction, focusTake = false) => {
    const inPanel = Boolean(lay.panelRef.current?.contains(document.activeElement));
    const f = panelStep(lay.stateRef.current, a, inPanel);
    lay.set(f.state);
    focus(focusTake ? "panel" : f.focus);
  }, [lay, focus]);
  /** A terminal is gone (process end or "Kill Terminal"; without `seq` the active one): unmount it, and if it was the last and the
   *  panel showed TERMINAL, it closes (hideOnLastClosed). */
  const terminalWay = useCallback((seq?: number) => { if (lay.endTerminal(seq)) panelStepFrom({ kind: "terminalWay" }); }, [lay, panelStepFrom]);
  const performAction = useCallback((a: LayoutAction) => {
    const { page, editor } = oRef.current;
    if (a === "panel") return panelStepFrom({ kind: "panel" });
    if (a === "problems") return panelStepFrom({ kind: "view", tab: "problems" });
    if (a === "terminal") return panelStepFrom({ kind: "view", tab: "terminal" });
    if (a === "maximize") return panelStepFrom({ kind: "maximize" });
    const active = document.activeElement;
    const s = { visible: page.visible, mode: page.mode };
    const situation = {
      inPage: Boolean(lay.pagesRef.current?.contains(active)),
      inPanel: Boolean(lay.panelRef.current?.contains(active)),
      panelOpen: lay.stateRef.current.open,
      editorHidden: lay.stateRef.current.open && lay.stateRef.current.maximized,
    };
    const f = pagesStep(s, a === "sidebar" ? { kind: "toggle" } : a === "explorer" ? { kind: "view", mode: "explorer" } : a === "debug" ? { kind: "view", mode: "debug" } : { kind: "search" }, situation);
    if (a === "search") {
      // ⇧⌘F: the editor's selection (single-line, non-empty) becomes the search term — not if focus is already in the search.
      const v = editor(), sel = v?.state.selection.main;
      const text = v && sel ? searchSeed(v.state.sliceDoc(sel.from, sel.to), situation.inPage && page.mode === "search") : null;
      if (text !== null) lay.seedSearch(text);
    }
    if (f.state.visible !== s.visible) { if (f.state.visible) page.show(); else page.toggle(); }
    if (f.state.mode !== s.mode) page.setMode(f.state.mode);
    focus(f.focus);
  }, [lay, panelStepFrom, focus]);
  const executeFromRef = useRef(performAction);
  executeFromRef.current = performAction;

  // The host for the command table (the keys in the editor go through it).
  useEffect(() => {
    enterLayoutOne();
    const w: Host = { root: () => oRef.current.root.current, performAction: (a) => executeFromRef.current(a) };
    HOSTS.add(w);
    return () => { HOSTS.delete(w); };
  }, []);

  /** For `onKeyDown` at the root: true if the key belongs to the layout (executed, unless the editor already took it). */
  const key = useCallback((e: React.KeyboardEvent | KeyboardEvent): boolean => {
    const b = layoutCommandToKey(e, isMac());
    if (!b) return false;
    if (e.defaultPrevented) return true; // the command table in the editor already executed it
    e.preventDefault();
    executeFromRef.current(b.action);
    return true;
  }, []);
  // On the Files page also without focus (after a click into the void it sits on the document) — like VS Code in the whole window.
  useEffect(() => {
    if (!o.active || !o.pageFiles) return;
    const h = (e: KeyboardEvent) => { if (inDocument(e.target)) key(e); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [o.active, o.pageFiles, key]);

  /** For the palette (`addition` of the host): the same commands — without an open file, where the table does not speak. */
  const paletteCommands = useMemo<PaletteCommand[]>(() => LAYOUT_COMMANDS.map((b) => ({ id: b.id, title: b.title, shortcut: b.shortcut, execute: () => executeFromRef.current(b.action) })), []);
  return { key, performAction, panelStep: panelStepFrom, terminalWay, paletteCommands };
}

/** The optimal sidebar width for the double click (VS Code `getOptimalWidth`): per name the width of its TEXT (range over the
 *  content — the name's box is stretched in the row), computed in lib/panel-layout.ts `optimalWidthFrom`. */
export function optimalWidth(page: HTMLElement | null): number {
  if (!page) return 0;
  const r = document.createRange();
  const names: { left: number; width: number }[] = [];
  for (const el of page.querySelectorAll<HTMLElement>(".cb-tree-name")) {
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect();
    names.push({ left: b.left, width: b.width });
  }
  return optimalWidthFrom(page.getBoundingClientRect().left, names);
}

/** The sidebar width next to the editor — measured at the root (sidebar + editor) before the first frame, clamped like VS Code.
 *  Dragged on the element itself (one frame, one write), state and storage only on release; below half the minimum width it snaps
 *  off (`hide`). Double click: the preferred width (lib/panel-layout.ts). */
export function usePagesWidth(lay: CodeLayout, root: React.RefObject<HTMLElement | null>, hide: () => void) {
  const [slot, setSlot] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setSlot(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [root]);
  const width = sidebarWidth(lay.width, slot);
  const turn = useRef<{ start: number; wish: number; frame: number } | null>(null);
  const drag = (distance: number, finished: boolean) => {
    const z = turn.current ?? (turn.current = { start: width, wish: width, frame: 0 });
    z.wish = z.start + distance;
    const el = lay.pagesRef.current;
    if (!finished) {
      if (!z.frame) z.frame = requestAnimationFrame(() => {
        z.frame = 0;
        if (!el) return;
        const off = snap(z.wish, SIDEBAR_MIN) === "off";
        el.style.display = off ? "none" : "";
        el.style.width = `${sidebarWidth(z.wish, slot)}px`;
      });
      return;
    }
    if (z.frame) cancelAnimationFrame(z.frame);
    turn.current = null;
    if (el) el.style.display = "";
    if (snap(z.wish, SIDEBAR_MIN) === "off") { if (el) el.style.width = `${width}px`; hide(); return; } // the width stays remembered
    lay.setWidth(sidebarWidth(z.wish, slot), true);
  };
  const back = () => lay.setWidth(sidebarBack(optimalWidth(lay.pagesRef.current), slot), true);
  /** For assistive technology (`aria-valuenow/min/max` of the drag bar). */
  const value = { now: width, min: SIDEBAR_MIN, max: Math.max(SIDEBAR_MIN, slot - EDITOR_MIN_WIDTH) };
  return { width, slot, drag, back, value };
}
