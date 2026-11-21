// Core of the language service's editor extensions: WHICH file a view shows (the facet `lspFile` — buffer, language, editor), the call with
// buffer reconciliation (`questions`), the capabilities of this file's server (`featuresOf`, lib/lsp-status.ts), the situation for the command
// table (`situationOf`, lib/editor-commands.ts) and the short hint at the caret (`showHint`). Every extension under components/code/lsp-*.ts
// reads the file from the facet, never from its own argument: so a view points to the new path at once after a buffer is renamed (`renameBuffer`).
//
// `close`: when a buffer is closed in the window (lib/buffer.ts `atClose`), this module reports it to the server — registered once per window,
// on first load.
import { Facet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, showTooltip, type Tooltip } from "@codemirror/view";
import { atClose, type EditorHolder, type Buffer } from "@/lib/buffer";
import { lspQuestion, lspClose, type LspAction, type LspResponse, type LspTrigger, type LspCapability, type LspLocation, type LspLanguage } from "@/lib/api";
import { subscribeLspStatus, refreshLspStatus, lspFeatures, lspStatusOf } from "@/lib/lsp-status";
import type { CommandSituation } from "@/lib/editor-commands";

/** The file of a view with a language service. */
export type LspFile = {
  buffer: Buffer;
  language: LspLanguage;
  /** The editor of the view — opens background tabs for files a rename/code action changes. */
  editor: EditorHolder | null;
  /** Open a location (go-to, peek "open as tab") — the editor the view sits in; without: not possible. */
  open?: ((location: LspLocation) => void) | null;
};
/** What every command receives (lib/editor-commands.ts `EditorCommand<EditorContext>`). */
export type EditorContext = { view: EditorView; file: LspFile | null };

export const lspFile = Facet.define<LspFile, LspFile | null>({ combine: (w) => w[0] ?? null });
export const lspFileOf = (state: EditorState): LspFile | null => state.facet(lspFile);

let closeRegistered = false;
function registerClose() {
  if (closeRegistered) return;
  closeRegistered = true;
  atClose((p) => { void lspClose(p).catch(() => {}); });
}

/** An action on a buffer (with reconciliation) — also for parts without a view (outline, problems in CodePane). If it starts the
 *  server (`diagnostics`), the status follows. */
export async function questionBuffer<A extends LspAction>(p: Buffer, action: A, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<LspResponse<A>> {
  registerClose();
  // The same file in two groups asks diagnostics and outline per view — equal questions on the same state share ONE answer
  // (per buffer, version, action and body while it runs; a cancellable question belongs to its caller alone).
  const k = signal ? null : `${p.key}\u0000${p.version}\u0000${action}\u0000${JSON.stringify(body)}`;
  const running = k ? RUNNING.get(k) : undefined;
  if (running) return running as Promise<LspResponse<A>>;
  const question = (async () => {
    const r = await lspQuestion(p, action, body, signal);
    if (action === "diagnostics") void refreshLspStatus(p.target, p.path, { onlyIfNotReady: true });
    return r;
  })();
  if (k) { RUNNING.set(k, question); void question.finally(() => { if (RUNNING.get(k) === question) RUNNING.delete(k); }).catch(() => undefined); }
  return question;
}
const RUNNING = new Map<string, Promise<unknown>>();
/** An action on the view's file; `signal` cancels it. */
export const questions = <A extends LspAction>(d: LspFile, action: A, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<LspResponse<A>> => questionBuffer(d.buffer, action, body, signal);
/** The capabilities of this file's server — empty without a server or before the status is read. */
export const featuresOf = (d: LspFile | null): ReadonlySet<LspCapability> => (d ? lspFeatures(d.buffer.target, d.buffer.path) : new Set());
export const can = (d: LspFile | null, f: LspCapability): d is LspFile => Boolean(d) && featuresOf(d).has(f);
const NO_TRIGGER: LspTrigger = Object.freeze({ completion: [], signature: [], signatureRetrigger: [] });
/** The trigger characters of this file's server (from its capabilities, like VS Code) — empty without a ready server. */
export const triggerOf = (d: LspFile | null): LspTrigger => (d ? lspStatusOf(d.buffer.target, d.buffer.path).status?.triggers : null) ?? NO_TRIGGER;
export const situationOf = (view: EditorView): CommandSituation => {
  const d = lspFileOf(view.state);
  return { features: featuresOf(d), language: Boolean(d), writable: !view.state.readOnly };
};

/** The triggering view as the way for ITS file (lib/lsp-change.ts option `view`): one step in its history, ⌘Z undoes it. If it does not show
 *  exactly the buffer's text (should never happen), the change goes through the buffer. */
export const overView = (view: EditorView, d: LspFile, userEvent: string) => ({
  buffer: d.buffer,
  apply: (b: readonly { from: number; to: number; insert: string }[]): boolean => {
    if (!view.dom.isConnected || view.state.doc.length !== d.buffer.text.length || view.state.doc.toString() !== d.buffer.text) return false;
    view.dispatch({ changes: [...b], userEvent });
    return true;
  },
});

/** While a view lives, the status of its file follows the events (lib/lsp-status.ts) — otherwise the capabilities would stay empty. */
export const statusFollowUps = ViewPlugin.define((view) => {
  let path = "", off = () => {};
  const followUp = () => {
    const d = lspFileOf(view.state);
    const k = d ? `${d.buffer.key}` : "";
    if (k === path) return;
    off();
    path = k;
    off = d ? subscribeLspStatus(d.buffer.target, d.buffer.path, () => {}) : () => {};
  };
  followUp();
  return { update: followUp, destroy: () => off() };
});

// ── The short hint at the caret ────────────────────────────────────────────────────────────────────────────────────────────────────
const setHint = StateEffect.define<{ pos: number; text: string } | null>();
const hintField = StateField.define<Tooltip | null>({
  create: () => null,
  update(t, tr) {
    for (const e of tr.effects) if (e.is(setHint)) return e.value ? hintTooltip(e.value.pos, e.value.text) : null;
    return t && (tr.docChanged || tr.selection) ? null : t;
  },
  provide: (f) => showTooltip.from(f),
});
function hintTooltip(pos: number, text: string): Tooltip {
  return {
    pos, above: true, strictSide: false, arrow: false,
    create: () => { const dom = document.createElement("div"); dom.className = "cm-lsp-hint"; dom.setAttribute("role", "status"); dom.textContent = text; return { dom }; },
  };
}
/** Show one sentence at the caret; it goes away on the next movement or after 5 s. */
export function showHint(view: EditorView, text: string): void {
  if (!view.dom.isConnected || view.state.field(hintField, false) === undefined) return;
  const pos = view.state.selection.main.head;
  view.dispatch({ effects: setHint.of({ pos, text }) });
  const shown = view.state.field(hintField, false);
  setTimeout(() => { if (view.dom.isConnected && shown && view.state.field(hintField, false) === shown) view.dispatch({ effects: setHint.of(null) }); }, 5000);
}
export const hintExtension: Extension = hintField;
