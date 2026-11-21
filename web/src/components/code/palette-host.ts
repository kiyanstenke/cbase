// The command palette's host: who opens the palette, with which files, which view and which own toggles.
//
// THE KEYS live ONCE in lib/commandPalette.ts (`PALETTE_COMMANDS`: ⇧⌘P ⌘P ⇧⌘O ⌘T ⌃G). In the editor the command table binds them
// (lib/editor-commands.ts, registered here in `enterW4One` — "Command Palette …" is in the context menu in the group "palette", like in VS
// Code); outside the editor (tree, search, bar) the host catches them itself (`usePaletteHost` → CodePane `onKeyDown`). What the editor
// already took (`defaultPrevented`) the host does not take again. ⌘P in the chat is caught earlier by the tab bar (chat/chatTabs.ts) and
// opens the same window via chat/ChatCodeArea.tsx.
//
// THE VIEW: the host's own (that of the ACTIVE editor group) while it is visible, otherwise the most recently focused editor view in the
// host (also the editable side of a diff tab in the chat) — without a visible view only files and toggles.
import { useCallback, useEffect, useRef } from "react";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { LspTarget } from "@/lib/api";
import { command, registerCommand } from "@/lib/editor-commands";
import { PALETTE_COMMANDS, paletteCommandToKey } from "@/lib/commandPalette";
import { isMac } from "@/lib/chat-bar";
import { lspFileOf, type EditorContext } from "@/components/code/lsp-core";
import { openPalette } from "@/components/code/CommandPalette";
import type { PaletteCommand, PaletteSource } from "@/components/code/palette-modes";
import { interpreterPossible, selectInterpreter } from "@/components/code/interpreter-choice";

/** A host toggle: state and setter. */
export type Toggle = readonly [boolean, (on: boolean) => void];
/** What a host (CodePane) gives the palette. */
export type HostDetails = {
  target: LspTarget;
  targetName: string;
  open: readonly string[];
  view: () => EditorView | null;
  /** `o.focus: false` (→ in ⌘P, VS Code `preserveFocus`): open and jump without taking focus. */
  openFile: (path: string, row?: number, column?: number, o?: { focus?: boolean }) => void;
  /** ⌘↵ in ⌘P and the "Open to the Side" button — into the group on the right; if missing (code tabs in the chat), ⌘↵ opens like Enter. */
  openFileBeside?: ((path: string, row?: number, column?: number) => void) | null;
  commands?: {
    save?: (() => void) | null;
    allSave?: (() => void) | null;
    blame?: Toggle;
    minimap?: Toggle;
    wrap?: Toggle;
    /** Further commands of the host (the layout, components/code/panel/code-layout.ts). If a command with the same id is in the
     *  command table, the palette lists it with a view there — here only without a view (otherwise it would appear twice). */
    addition?: readonly PaletteCommand[];
  };
};
type Host = { root: () => HTMLElement | null; details: () => HostDetails };
const HOSTS = new Set<Host>();
let last: EditorView | null = null;
const visible = (el: Element | null | undefined): boolean => Boolean(el && el.isConnected && el.getClientRects().length > 0);

/** ⌥Z toggles word wrap like VS Code (`editor.action.toggleWordWrap`) — caught at CodePane's root (`onKeyDown`; CodeMirror
 *  does not bind ⌥Z), in the palette with this shortcut. */
export const WRAP_KEY = "Alt-z";
/** The host's toggles as palette commands (blame, minimap, word wrap, save, terminal — the terminal via the layout, `addition`;
 *  a dedicated toggle for it was dropped, it was dead). */
function hostCommands(b: HostDetails["commands"], withView: boolean): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  if (!b) return out;
  const toggle = (id: string, title: string, s: Toggle | undefined, shortcut?: string) => { if (s) out.push({ id, title, shortcut, execute: () => s[1](!s[0]) }); };
  if (b.save) out.push({ id: "workbench.action.files.save", title: "File: Save", shortcut: "⌘S", execute: b.save });
  if (b.allSave) out.push({ id: "workbench.action.files.saveAll", title: "File: Save All", shortcut: "⌥⌘S", execute: b.allSave });
  toggle("gitlens.toggleFileBlame", "Git: Toggle Blame", b.blame);
  toggle("editor.action.toggleMinimap", "View: Toggle Minimap", b.minimap);
  toggle("editor.action.toggleWordWrap", "View: Toggle Word Wrap", b.wrap, "⌥Z");
  for (const z of b.addition ?? []) if (!withView || !command(z.id)) out.push(z);
  return out;
}

function sourceOf(w: Host, view: EditorView | null): PaletteSource {
  const a = w.details(), root = w.root(), own = a.view();
  // The ACTIVE group first (`own` — VS Code: the palette works in the active editor), only without it the most recently focused one.
  const v = view
    ?? (own && visible(own.dom) ? own : null)
    ?? (last && root?.contains(last.dom) && visible(last.dom) ? last : null);
  return { target: a.target, targetName: a.targetName, open: a.open, view: v, openFile: a.openFile, openFileBeside: a.openFileBeside ?? null, anchor: root,
    commands: hostCommands(a.commands, Boolean(v)) };
}
/** The source for a view (keys in the editor): its host — without a host only the view itself. */
export function sourceForView(view: EditorView): PaletteSource {
  for (const w of HOSTS) if (w.root()?.contains(view.dom)) return sourceOf(w, view);
  return { target: lspFileOf(view.state)?.buffer.target ?? null, targetName: "", open: [], view: view, openFile: null };
}
/** The source of the visible host in an area (⌘P in the chat) — null if none is visible. */
export function visibleSource(within?: Element | null): PaletteSource | null {
  for (const w of HOSTS) {
    const r = w.root();
    if (r && (!within || within.contains(r)) && visible(r)) return sourceOf(w, null);
  }
  return null;
}

/** The word at the cursor or the single-line selection (VS Code `getSelectionTextFromEditor(allowUnselectedWord: true)`) — ⌘T enters it after
 *  the `#`, selected so that typing replaces it. A multi-line selection enters nothing. */
export function wordAtCursor(view: EditorView | null): string {
  if (!view) return "";
  const r = view.state.selection.main;
  if (!r.empty) {
    const t = view.state.sliceDoc(r.from, r.to);
    return t.includes("\n") ? "" : t;
  }
  const w = view.state.wordAt(r.head);
  return w ? view.state.sliceDoc(w.from, w.to) : "";
}
/** The view if IT has focus (VS Code `getFocusedCodeEditor()`), otherwise none. */
export function inFocus(view: EditorView | null): EditorView | null {
  return view && (view.root as Document | ShadowRoot).activeElement === view.contentDOM ? view : null;
}
/** Open the palette with a palette command's prefix — ⌘T with the word at the cursor of the FOCUSED editor (VS Code
 *  `SymbolsQuickAccessProvider.defaultFilterValue`): if focus is in the tree, ⌘T takes no word from the active group. */
function openWithPrefix(id: string, prefix: string, source: PaletteSource) {
  const word = id === "workbench.action.showAllSymbols" ? wordAtCursor(inFocus(source.view)) : "";
  openPalette({ input: prefix + word, ...(word ? { markFrom: prefix.length } : {}), source });
}

/** Register a host (CodePane). Returns: the key catcher for `onKeyDown` at the root. */
export function usePaletteHost(root: React.RefObject<HTMLElement | null>, details: HostDetails): (e: React.KeyboardEvent) => void {
  const ref = useRef(details);
  ref.current = details;
  const host = useRef<Host | null>(null);
  if (!host.current) host.current = { root: () => root.current, details: () => ref.current };
  useEffect(() => {
    // Already BEFORE the first editor in the table — the watermark of an empty group (components/code/Watermark.tsx) names
    // "Show All Commands" and "Go to File" with their key from it, like VS Code from the first frame.
    enterW4One();
    const w = host.current!;
    HOSTS.add(w);
    return () => { HOSTS.delete(w); };
  }, []);
  return useCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented || !host.current) return;
    const b = paletteCommandToKey(e, isMac());
    if (!b) return;
    e.preventDefault();
    openWithPrefix(b.id, b.prefix, sourceOf(host.current, null));
  }, []);
}

// ── In the command table ───────────────────────────────────────────────────────────────────────────────────────────────────
let entered = false;
/** The palette's commands and "Python: Select Interpreter" into the table — once per window (at the first host or editor). */
function enterW4One() {
  if (entered) return;
  entered = true;
  for (const b of PALETTE_COMMANDS) {
    registerCommand<EditorContext>({
      id: b.id, title: b.title, shortcut: b.shortcut, keys: b.keys, ...("group" in b ? { group: b.group, rank: b.rank } : {}),
      execute: (k) => openWithPrefix(b.id, b.prefix, sourceForView(k.view)),
    });
  }
  registerCommand<EditorContext>({
    id: "python.setInterpreter", title: "Python: Select Interpreter",
    condition: (_situation, k) => Boolean(k.file && interpreterPossible(k.file.buffer.target, k.file.buffer.path)),
    execute: (k) => { if (k.file) selectInterpreter(k.file.buffer.target, k.file.buffer.path); },
  });
}

/** Remembers the most recently focused view (the palette works in it). */
const focus = ViewPlugin.define((view) => {
  if (view.hasFocus) last = view;
  return {
    update(u) { if (u.focusChanged && u.view.hasFocus) last = u.view; },
    destroy() { if (last === view) last = null; },
  };
});
/** For EVERY file of the editor (components/code/lsp-extension.ts): the palette's commands in the table, the focus. */
export function paletteExtension(): Extension {
  enterW4One();
  return focus;
}
