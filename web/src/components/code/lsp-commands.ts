// The editor's commands on the view: attaches the execution to the entries of `W2_COMMANDS` (lib/editor-commands.ts), binds EVERY key of the
// command table in the editor (also those registered later via `registerCommand`; the key bindings follow the table through a compartment) and
// opens the context menu from the same table: right click (at the position; a click outside the selection puts the caret there, like VS Code),
// ⇧F10 and the context-menu key (at the caret). What the file/position/server cannot do is not in the menu and does nothing via the key.
//
// CLIPBOARD: cut/copy/paste from the menu via the Clipboard API (without a selection: the whole line, like VS Code). If the browser refuses
// (paste asks for permission there or denies it), a hint says "use ⌘V"; the desktop client grants the permission without asking
// (client/main.js). ⌘X/⌘C/⌘V themselves stay with the browser — the table only displays them.
import { Compartment, EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type KeyBinding } from "@codemirror/view";
import { nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import {
  W2_COMMANDS, subscribeCommands, allCommands, command, commandVisible, childrenOf, menuGroups, registerCommand, type EditorCommand,
} from "@/lib/editor-commands";
import { tr } from "@/lib/i18n";
import { situationOf, lspFileOf, showHint, type EditorContext } from "@/components/code/lsp-core";
import { openEditorMenu, type MenuItem } from "@/components/code/EditorMenu";
import { startRename } from "@/components/code/lsp-rename";
import { changeAllOccurrences } from "@/components/code/lsp-occurrences";
import { formatDocument } from "@/components/code/lsp-format";
import { showCodeActions } from "@/components/code/lsp-actions";

// ── Clipboard ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The selected text — without a selection the whole lines of the carets including the line break (VS Code). */
function selectionText(view: EditorView): { text: string; areas: { from: number; to: number }[] } {
  const s = view.state;
  if (s.selection.ranges.some((r) => !r.empty)) {
    const r = s.selection.ranges.filter((x) => !x.empty);
    return { text: r.map((x) => s.sliceDoc(x.from, x.to)).join(s.lineBreak), areas: r.map((x) => ({ from: x.from, to: x.to })) };
  }
  const rows = [...new Set(s.selection.ranges.map((r) => s.doc.lineAt(r.head).number))].map((n) => s.doc.line(n));
  return {
    text: rows.map((l) => l.text + s.lineBreak).join(""),
    areas: rows.map((l) => ({ from: l.from, to: Math.min(s.doc.length, l.to + 1) })),
  };
}
async function copy(view: EditorView, cut: boolean) {
  const { text, areas } = selectionText(view);
  try { await navigator.clipboard.writeText(text); } catch {
    showHint(view, tr(cut ? "The browser does not allow cutting from the menu here — use ⌘X." : "The browser does not allow copying from the menu here — use ⌘C."));
    return;
  }
  if (cut && !view.state.readOnly) view.dispatch({ changes: areas, userEvent: "delete.cut", scrollIntoView: true });
  view.focus();
}
async function insertClipboard(view: EditorView) {
  let text: string;
  try { text = await navigator.clipboard.readText(); } catch {
    showHint(view, tr("The browser does not allow pasting from the menu — use ⌘V."));
    return;
  }
  if (view.state.readOnly) return;
  view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  view.focus();
}

// ── Execution of the W2 commands ─────────────────────────────────────────────────────────────────────────────────────────────────
const EXECUTION: Record<string, (k: EditorContext) => unknown> = {
  "editor.action.rename": (k) => startRename(k.view),
  "editor.action.changeAll": (k) => changeAllOccurrences(k.view),
  "editor.action.formatDocument": (k) => formatDocument(k.view, k.file),
  "editor.action.refactor": (k) => showCodeActions(k.view, "refactor"),
  "editor.action.sourceAction": (k) => showCodeActions(k.view, "source"),
  "editor.action.quickFix": (k) => showCodeActions(k.view, "quickfix"),
  "editor.action.clipboardCutAction": (k) => copy(k.view, true),
  "editor.action.clipboardCopyAction": (k) => copy(k.view, false),
  "editor.action.clipboardPasteAction": (k) => insertClipboard(k.view),
  "editor.action.marker.next": (k) => nextDiagnostic(k.view),
  "editor.action.marker.prev": (k) => previousDiagnostic(k.view),
  "editor.action.showContextMenu": (k) => showContextMenu(k.view, null),
};
let entered = false;
/** The W2 commands into the table — once per window (at the first editor). Every id of `W2_COMMANDS` has its execution here. */
function enterW2One() {
  if (entered) return;
  entered = true;
  for (const b of W2_COMMANDS) {
    const f = EXECUTION[b.id];
    if (!f) throw new Error(`W2 command ${b.id} has no execution`);
    registerCommand<EditorContext>({ ...b, execute: (k) => { void f(k); } });
  }
}

const contextOf = (view: EditorView): EditorContext => ({ view, file: lspFileOf(view.state) });

/** Run a command of the table on this view — false if it does not exist or does not apply here. */
export function carryOutCommand(view: EditorView, id: string): boolean {
  const b = command(id) as EditorCommand<EditorContext> | null;
  const k = contextOf(view);
  if (!b?.execute || !commandVisible(b, situationOf(view), k)) return false;
  void Promise.resolve(b.execute(k)).catch((e) => showHint(view, String((e as Error)?.message ?? e)));
  return true;
}

// ── Context menu ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function point(view: EditorView, b: EditorCommand<EditorContext>): MenuItem {
  const situation = situationOf(view), k = contextOf(view);
  const children = b.submenu ? [childrenOf(b.id, situation, k).map((c) => point(view, c))] : undefined;
  return { id: b.id, label: tr(b.title), right: b.shortcut, children, execute: () => { carryOutCommand(view, b.id); } };
}
/** The context menu at `at` (window coordinates) or — without — at the caret (⇧F10, context-menu key: by keyboard). */
export function showContextMenu(view: EditorView, at: { x: number; y: number } | null): void {
  const groups = menuGroups(situationOf(view), contextOf(view)).map((g) => g.commands.map((b) => point(view, b as EditorCommand<EditorContext>)));
  let x = at?.x ?? 0, y = at?.y ?? 0;
  if (!at) {
    const c = view.coordsAtPos(view.state.selection.main.head);
    const r = view.dom.getBoundingClientRect();
    x = c?.left ?? r.left + 24; y = (c?.bottom ?? r.top + 24) + 4;
  }
  openEditorMenu({ x, y, groups, perKey: !at, back: () => view.focus() });
}
const contextMenu = EditorView.domEventHandlers({
  contextmenu(e, view) {
    e.preventDefault();
    const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
    if (!keyboard) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null && !view.state.selection.ranges.some((r) => r.from <= pos && pos <= r.to)) view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: "select.pointer" });
    }
    view.focus();
    showContextMenu(view, keyboard ? null : { x: e.clientX, y: e.clientY });
    return true;
  },
});

// ── Keys from the table ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const keysPart = new Compartment();
function occupancy(): readonly KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of allCommands()) for (const key of b.keys ?? []) out.push({ key, preventDefault: false, run: (view) => carryOutCommand(view, b.id) });
  return out;
}
/** The key bindings follow the table: when W3/W4 register later, every live view is updated. */
const keysFollowUps = ViewPlugin.define((view) => {
  const off = subscribeCommands(() => queueMicrotask(() => {
    if (view.dom.isConnected) view.dispatch({ effects: keysPart.reconfigure(keymap.of(occupancy())) });
  }));
  return { destroy: off };
});

/** Commands, keys and context menu — for EVERY file of the editor (without a language, what works without a server stays). */
export function commandExtension(): Extension {
  enterW2One();
  return [Prec.high(keysPart.of(keymap.of(occupancy()))), keysFollowUps, contextMenu];
}
