// Core of navigation in the editor: the CONNECTION of an editor (`NavConnection` — one per CodePane, components/code/navigation-connection.tsx:
// open locations as a tab, back/forward, results into the "References" mode), the facet through which every view knows it and its buffer
// (`navFile`), a view's place (`locationOf`), the pending jump (`attemptsJump`: a location is remembered and the editor's view jumps there as
// soon as it shows the file — also one that is still loading), external targets as a read-only buffer (`externalBuffer`: read ONLY via `read`
// with the server's token) and the line preview of hits (`rowLoader`). Peek (lsp-peek.ts), the commands (lsp-navigation.ts) and the bar
// (ReferencesBar.tsx) read everything from here — none knows the other.
import { Facet, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findBuffer, buffer as fetchBuffer, type Buffer, type BufferTarget } from "@/lib/buffer";
import { isNotSupported, lspOffsetOf, lspPosOf, lspCalls, type LspCall, type LspCallItem, type LspLocation, type LspPos } from "@/lib/api";
import { tr } from "@/lib/i18n";
import type { NavLocation } from "@/lib/navigation";

/** What the "References" mode shows: Find All References/Implementations or the call hierarchy. `target`/`source` = target and path of the
 *  buffer in which the question was asked — canonical (lib/buffer-coordinates.ts): the locations are relative to `target`, the call hierarchy
 *  unfolds via `source`. */
export type ReferenceResult =
  | { seq: number; kind: "references" | "implementations"; symbol: string; target: BufferTarget; source: string; locations: LspLocation[] }
  | { seq: number; kind: "calls"; symbol: string; target: BufferTarget; source: string; root: LspCallItem; direction: "incoming" | "outgoing"; calls: LspCall[] };
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;

/** The connection of an editor (CodePane): ONE history, ONE "References" mode, tabs. */
export interface NavConnection {
  /** The view showing the file tabs — a jump lands there. */
  mainView(): EditorView | null;
  /** The path of a buffer in THIS editor (the buffer is canonical, the editor has its coordinates) — null: it does not live here. */
  pathOf(p: Buffer): string | null;
  /** Open a location as a tab, caret at the start of the range, with a history entry (`from`: where one stood; without: the active tab).
   *  `target`: the target the location is relative to — that of the buffer that asked (converted into the editor's coordinates). */
  open(target: BufferTarget, location: LspLocation, from?: NavLocation | null): Promise<void>;
  /** Remember a place (with a history entry) the view jumps to as soon as it shows the file — the caller opens the tab.
   *  `focus: false` (VS Code `preserveFocus`, a click in PROBLEMS): jump without taking focus. `until`: the selection extends to
   *  there (a search hit is selected like in VS Code). */
  rememberJump(path: string, pos: LspPos, from?: NavLocation | null, o?: { focus?: boolean; until?: LspPos | null }): void;
  back(from?: NavLocation | null): void;
  before(from?: NavLocation | null): void;
  showResult(e: WithoutSeq<ReferenceResult>): void;
  /** The main view reports its caret (where one stood when the tab switches). */
  reportPlace(path: string, pos: LspPos): void;
  /** The pending jump for this buffer (key) — null: none. */
  pending(key: string): LspPos | null;
  /** The end of the pending jump's selection (`rememberJump(…, { until })`) — null: only the caret. */
  pendingUntil?(key: string): LspPos | null;
  /** Takes the pending jump — false: it must not take focus (`rememberJump` with `focus: false`). */
  takePending(): boolean | void;
  /** The token of an opened external target — for the history. */
  tokenOf(path: string): { token: string } | null;
  /** Show a folder in the explorer (⌘-click on a folder link, VS Code `revealInExplorer`) — `path` relative to `target`.
   *  true: done (also with a hint if it is not in this editor). */
  showFolder?(target: BufferTarget, path: string): boolean;
}

/** Per view: its connection (null: without editor, e.g. a diff outside a CodePane), its buffer and how an embedded view
 *  (peek) gets its extensions — the same as the view itself (components/code/lsp-extension.ts). */
export type NavFile = { connection: NavConnection | null; buffer: Buffer; build: (p: Buffer) => Extension };
export const navFile = Facet.define<NavFile, NavFile | null>({ combine: (w) => w[0] ?? null });
export const navOf = (state: EditorState): NavFile | null => state.facet(navFile);

/** A view's place for the history (file, caret, token of an external target). */
export function locationOf(view: EditorView): NavLocation | null {
  const n = navOf(view.state);
  const path = !n ? null : n.connection ? n.connection.pathOf(n.buffer) : n.buffer.path;
  if (!n || path === null) return null;
  return { path, pos: lspPosOf(view.state.doc, view.state.selection.main.head), extern: n.connection?.tokenOf(path) ?? null };
}

/** Apply the pending jump if THIS view is the main view and shows its file. */
export function attemptsJump(view: EditorView): boolean {
  const n = navOf(view.state);
  if (!n?.connection || n.connection.mainView() !== view || !view.dom.isConnected) return false;
  const pos = n.connection.pending(n.buffer.key);
  if (!pos || view.state.doc.length !== n.buffer.text.length) return false;
  const until = n.connection.pendingUntil?.(n.buffer.key) ?? null;
  const focus = n.connection.takePending() !== false;
  const off = lspOffsetOf(view.state.doc, pos);
  const header = until ? lspOffsetOf(view.state.doc, until) : off;
  view.dispatch({ selection: { anchor: off, head: header }, effects: EditorView.scrollIntoView(header, { y: "center" }), userEvent: "select.navigation" });
  if (focus) view.focus();
  return true;
}

// ── External targets ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const normed = (t: string): string => String(t ?? "").replace(/\r\n?/g, "\n");
/** At workspace level B only knows the project from a file — there the file in which the question was asked goes along. */
const originField = (target: BufferTarget, origin: string | null | undefined): Record<string, string> =>
  origin && !origin.startsWith("/") && target.apiBase.startsWith("/api/workspaces/") ? { file: origin } : {};

/** A target outside the instance as a read-only buffer: held (`los` releases it), read via `read` with the token. */
export async function externalBuffer(target: BufferTarget, path: string, token: string, origin?: string | null): Promise<{ p: Buffer; release: () => void }> {
  const p = fetchBuffer(target, path, { readonly: true });
  const release = p.hold("other");
  try {
    if (p.status.state !== "loaded") {
      const r = await lspCalls(target, "read", { token, ...originField(target, origin) });
      if (isNotSupported(r)) throw new Error(tr("The language service is not available for this file right now."));
      await p.load({ disk: { disk: { text: normed(r.text), sha: null } } });
    }
    return { p, release };
  } catch (e) {
    release();
    throw e;
  }
}

// ── Line preview ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A preview reads at most this many files (the rest shows only "line N") — and at most this many at once. */
export const PREVIEW_FILES = 60;
const CONCURRENT = 4;

/** The lines of a result's files, each file read once: from an open buffer, otherwise from disk (held briefly) or, for an
 *  external target, via `read`. null: not readable (binary file, gone, token expired) or over the cap. */
export function rowLoader(target: BufferTarget, origin?: string | null): (file: string, extern: { token: string } | null) => Promise<string[] | null> {
  const cache = new Map<string, Promise<string[] | null>>();
  let running = 0;
  const wait: (() => void)[] = [];
  const slot = () => new Promise<void>((ok) => { if (running < CONCURRENT) { running += 1; ok(); } else wait.push(() => { running += 1; ok(); }); });
  const free = () => { running -= 1; wait.shift()?.(); };
  const read = async (file: string, extern: { token: string } | null): Promise<string[] | null> => {
    const open = findBuffer(target, file);
    if (open?.status.state === "loaded") return open.text.split("\n");
    await slot();
    try {
      if (extern) {
        const r = await lspCalls(target, "read", { token: extern.token, ...originField(target, origin) });
        return isNotSupported(r) ? null : normed(r.text).split("\n");
      }
      const p = fetchBuffer(target, file);
      const release = p.hold("other");
      try { const r = await p.load(); return r.kind === "text" ? p.text.split("\n") : null; } finally { release(); }
    } catch { return null; } finally { free(); }
  };
  return (file, extern) => {
    let p = cache.get(file);
    if (!p) {
      p = cache.size < PREVIEW_FILES ? read(file, extern) : Promise.resolve(null);
      cache.set(file, p);
    }
    return p;
  };
}
