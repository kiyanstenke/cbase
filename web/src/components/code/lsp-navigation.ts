// Navigation on the view: attaches the execution to the entries of `W3_COMMANDS` (lib/navigation.ts — keys, context menu and later the palette
// come from the ONE command table, lib/editor-commands.ts) and brings per view with a buffer: the facet (connection, buffer — lsp-nav-core.ts),
// the peek (lsp-peek.ts), ⌘-click = Go to Definition, mouse side buttons = back/forward, Esc closes the peek, and the main view reports its
// place (history) and accepts pending jumps.
//
// - Go to …: exactly one hit jumps (as a tab, with a history entry), several open the peek; "Peek ▸" always shows the peek.
// - Find All References/Implementations, call hierarchy: the result goes to the editor's "References" mode.
// - Back/forward: the editor's history (components/code/navigation-connection.tsx).
// - ⌘-click without a definition follows a LINK at the position (`link`, VS Code: the editor's link provider) — a file opens as a tab, a
//   folder appears in the explorer, a web address in the browser (lib/link-follow-ups.ts). F12 (Go to Definition) follows no link:
//   like VS Code it reports "No definition found." there.
// Without a connection (a diff outside a CodePane) the peek remains; what needs an editor (bar, history) is hidden then.
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { W3_COMMANDS, hitsSelection } from "@/lib/navigation";
import { registerCommand } from "@/lib/editor-commands";
import { isNotSupported, lspPosOf, type LspLocation } from "@/lib/api";
import type { Buffer } from "@/lib/buffer";
import { tr } from "@/lib/i18n";
import { isMac } from "@/lib/chat-bar";
import { questions, can, lspFileOf, showHint, type EditorContext } from "@/components/code/lsp-core";
import { carryOutCommand } from "@/components/code/lsp-commands";
import { navFile, navOf, locationOf, attemptsJump, type NavConnection, type NavFile } from "@/components/code/lsp-nav-core";
import { peekExtension, closePeek, showPeek } from "@/components/code/lsp-peek";
import { linkWay } from "@/lib/link-follow-ups";

type LocationAction = "definition" | "type_definition" | "source_definition" | "implementations" | "references";
const TITLE: Record<LocationAction, string> = {
  definition: "Definition", type_definition: "Type Definition", source_definition: "Source Definition", implementations: "Implementations", references: "References",
};
const NO: Record<LocationAction, string> = {
  definition: "No definition found.", type_definition: "No type definition found.", source_definition: "No source definition found.",
  implementations: "No implementations found.", references: "No references found.",
};
const NOT_AVAILABLE = "The language service is not available for this file right now.";

/** Open a location as a tab — via the connection (history), otherwise via the file's `open` (W2). false: this editor cannot. */
export function openLocation(view: EditorView, location: LspLocation): boolean {
  const n = navOf(view.state);
  if (n?.connection) { void n.connection.open(n.buffer.target, location, locationOf(view)); return true; } // the location is relative to the buffer's target
  const d = lspFileOf(view.state);
  if (d?.open && !location.external) { d.open(location); return true; }
  return false;
}
/** Does the view still show the same file after the `await`? BufferEditor swaps the state in the SAME view on a tab switch —
 *  `isConnected` alone would let peek, result and history land in the wrong file. */
const stillPresent = (view: EditorView, p: Buffer): boolean => view.dom.isConnected && navOf(view.state)?.buffer === p;
const termAt = (view: EditorView, pos: number): string => {
  const w = view.state.wordAt(pos);
  return w ? view.state.sliceDoc(w.from, w.to) : "";
};

/** Follow the link at the position (⌘-click) — true: there was one that cbase follows. */
async function followUpLink(view: EditorView, d: NonNullable<EditorContext["file"]>, pos: number): Promise<boolean> {
  const n = navOf(view.state);
  if (!n || !can(d, "document_link")) return false;
  let r;
  try { r = await questions(d, "link", { position: lspPosOf(view.state.doc, pos) }); } catch { return false; }
  if (!stillPresent(view, n.buffer)) return false;
  if (isNotSupported(r)) return false;
  const way = linkWay(r.link?.target);
  if (!way) return false;
  if (way.kind === "file") return openLocation(view, way.location);
  if (way.kind === "folder") return Boolean(n.connection?.showFolder?.(d.buffer.target, way.path));
  window.open(way.url, "_blank", "noopener,noreferrer"); // in the desktop client the shell hands it to the browser (like a link in the chat)
  return true;
}

async function goTo(k: EditorContext, action: LocationAction, alwaysPeek: boolean, withLink = false) {
  const { view, file: d } = k;
  const n = navOf(view.state);
  if (!d || !n) return;
  const pos = view.state.selection.main.head;
  // ⌘-click in a file whose server only knows links (no definition): straight to the link.
  const r = withLink && !can(d, "definition") ? { locations: [] } : await questions(d, action, { position: lspPosOf(view.state.doc, pos) });
  if (!stillPresent(view, n.buffer)) return;
  if (isNotSupported(r)) { showHint(view, tr(NOT_AVAILABLE)); return; }
  const w = hitsSelection(r.locations, { alwaysPeek });
  if (w.kind === "none" && withLink && (await followUpLink(view, d, pos))) return;
  if (!stillPresent(view, n.buffer)) return;
  if (w.kind === "none") { showHint(view, tr(NO[action])); return; }
  if (w.kind === "jump" && openLocation(view, w.location)) return;
  showPeek(view, pos, {
    title: tr(TITLE[action]), locations: w.kind === "jump" ? [w.location] : w.locations, target: d.buffer.target, editor: d.editor, source: d.buffer.path, build: n.build,
    open: (location) => openLocation(view, location),
  });
}

async function findAll(k: EditorContext, action: "references" | "implementations") {
  const { view, file: d } = k;
  const a = navOf(view.state)?.connection;
  if (!d || !a) return;
  const pos = view.state.selection.main.head;
  const r = await questions(d, action, { position: lspPosOf(view.state.doc, pos) });
  if (!stillPresent(view, d.buffer)) return;
  if (isNotSupported(r)) { showHint(view, tr(NOT_AVAILABLE)); return; }
  if (!r.locations?.length) { showHint(view, tr(NO[action])); return; }
  a.showResult({ kind: action === "references" ? "references" : "implementations", symbol: termAt(view, pos), target: d.buffer.target, source: d.buffer.path, locations: r.locations });
}

async function callHierarchy(k: EditorContext) {
  const { view, file: d } = k;
  const a = navOf(view.state)?.connection;
  if (!d || !a) return;
  const pos = view.state.selection.main.head;
  const r = await questions(d, "call_hierarchy", { position: lspPosOf(view.state.doc, pos), direction: "incoming" });
  if (!stillPresent(view, d.buffer)) return;
  if (isNotSupported(r)) { showHint(view, tr(NOT_AVAILABLE)); return; }
  if (!r.root) { showHint(view, tr("No call hierarchy at this position.")); return; }
  a.showResult({ kind: "calls", symbol: r.root.name, target: d.buffer.target, source: d.buffer.path, root: r.root, direction: "incoming", calls: r.calls ?? [] });
}

const withConnection = (_l: unknown, k: EditorContext): boolean => Boolean(navOf(k.view.state)?.connection);
const EXECUTION: Record<string, (k: EditorContext) => unknown> = {
  "editor.action.revealDefinition": (k) => goTo(k, "definition", false),
  "editor.action.goToTypeDefinition": (k) => goTo(k, "type_definition", false),
  "typescript.goToSourceDefinition": (k) => goTo(k, "source_definition", false),
  "editor.action.goToImplementation": (k) => goTo(k, "implementations", false),
  "editor.action.goToReferences": (k) => goTo(k, "references", false),
  "editor.action.peekDefinition": (k) => goTo(k, "definition", true),
  "editor.action.peekTypeDefinition": (k) => goTo(k, "type_definition", true),
  "editor.action.peekImplementation": (k) => goTo(k, "implementations", true),
  "editor.action.referenceSearch.trigger": (k) => goTo(k, "references", true),
  "references-view.findReferences": (k) => findAll(k, "references"),
  "references-view.findImplementations": (k) => findAll(k, "implementations"),
  "references-view.showCallHierarchy": (k) => callHierarchy(k),
  "workbench.action.navigateBack": (k) => navOf(k.view.state)?.connection?.back(locationOf(k.view)),
  "workbench.action.navigateForward": (k) => navOf(k.view.state)?.connection?.before(locationOf(k.view)),
};
/** Hidden without a connection: what needs the editor's bar or history. */
const NEEDS_EDITOR = new Set(["references-view.findReferences", "references-view.findImplementations", "references-view.showCallHierarchy", "workbench.action.navigateBack", "workbench.action.navigateForward"]);

let entered = false;
/** The W3 commands into the table — once per window. Every id of `W3_COMMANDS` (except the submenu) has its execution here. */
function enterW3One() {
  if (entered) return;
  entered = true;
  for (const b of W3_COMMANDS) {
    if (b.submenu) { registerCommand<EditorContext>({ ...b }); continue; }
    const f = EXECUTION[b.id];
    if (!f) throw new Error(`W3 command ${b.id} has no execution`);
    registerCommand<EditorContext>({ ...b, ...(NEEDS_EDITOR.has(b.id) ? { condition: withConnection } : {}), execute: (k) => { void f(k); } });
  }
}

const BACK = "workbench.action.navigateBack", BEFORE = "workbench.action.navigateForward";
/** ⌘-click = Go to Definition (stays); mouse side buttons = back/forward — the page does not navigate. */
const mouse = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button === 3 || e.button === 4) { e.preventDefault(); return true; }
    if (e.button !== 0 || e.altKey || e.shiftKey || !(isMac() ? e.metaKey : e.ctrlKey)) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const d = lspFileOf(view.state);
    if (pos == null || !(can(d, "definition") || can(d, "document_link"))) return false; // otherwise ⌘-click stays what CodeMirror makes of it
    view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
    void goTo({ view, file: d }, "definition", false, true); // without a definition follow the link (VS Code: definition AND link provider)
    e.preventDefault();
    return true;
  },
  mouseup(e, view) {
    if (e.button !== 3 && e.button !== 4) return false;
    e.preventDefault();
    carryOutCommand(view, e.button === 3 ? BACK : BEFORE);
    return true;
  },
});

/** The main view reports its place and accepts a pending jump (also right when a file is mounted). */
const place = ViewPlugin.define((view) => {
  let alive = true;
  const attempts = () => {
    const n = navOf(view.state);
    if (n?.connection && n.connection.pending(n.buffer.key)) requestAnimationFrame(() => { if (alive) attemptsJump(view); });
  };
  const report = () => {
    const n = navOf(view.state);
    const pf = n?.connection && n.connection.mainView() === view ? n.connection.pathOf(n.buffer) : null;
    if (n?.connection && pf !== null) n.connection.reportPlace(pf, lspPosOf(view.state.doc, view.state.selection.main.head));
  };
  report();
  attempts();
  return {
    update(u) {
      if (u.selectionSet && !u.docChanged) report();
      if (u.docChanged || u.startState.facet(navFile) !== u.state.facet(navFile)) { report(); attempts(); } // also after the text is reconciled
    },
    destroy() { alive = false; },
  };
});

/** Per view with a buffer: facet, peek, mouse, Esc, place — and once per window the W3 commands. Without a buffer only the commands. */
export function navigationExtension(o: { connection: NavConnection | null; buffer: Buffer | null; build: NavFile["build"] }): Extension {
  enterW3One();
  if (!o.buffer) return [];
  return [
    navFile.of({ connection: o.connection, buffer: o.buffer, build: o.build }),
    peekExtension, Prec.high(mouse), place,
    keymap.of([{ key: "Escape", run: (v) => closePeek(v) }]),
  ];
}
