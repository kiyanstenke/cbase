"use client";

// The quick-diff peek in the git gutter like VS Code 1.143 (`QuickDiffWidget`): a click on a gutter mark (or ⌥F3/⇧⌥F3) opens a zone across the
// whole editor width directly under the change — on top an arrow in the change's colour, a frame in the same colour, inside it the header (file
// name, "Git Local Changes (Working Tree) - n of m changes", on the right revert change · stage change · next · previous · close — VS Code's
// order, NO "…" menu: VS Code has none) and below it the embedded diff (index against the buffer, inline, editable as in VS Code: a view of the
// buffer, components/code/buffer-view.ts), scrolled to centre on the change. Height, arrow, frame and header are computed by lib/quick-diff.ts
// `peekDimensions` like ZoneWidget/PeekViewWidget; at the bottom a handle drags the height in whole lines (isResizeable, 5 < lines < 35).
//
// What a button DOES is decided by components/code/git-gutter.ts (`PeekControl`); only the shape is here. A block widget in CodeMirror: its
// events do not belong to the editor (`ignoreEvent`), the embedded editor has its own (Esc and ⇧Esc close, ⌥F3/⇧⌥F3 move, ⌘S saves the file —
// like VS Code's commands, which in the embedded editor mean the outer one). `peekKeys` attaches Esc/⇧Esc to the outer editor
// (closeQuickDiff, precedence above the other Esc bindings).
import { ChangeSet, Compartment, EditorSelection, EditorState, Prec, Text, type Extension } from "@codemirror/state";
import { completionStatus } from "@codemirror/autocomplete";
import { EditorView, WidgetType, keymap } from "@codemirror/view";
import { getOriginalDoc, unifiedMergeView, updateOriginalDoc } from "@codemirror/merge";
import { basicSetup } from "@uiw/react-codemirror";
import { tr } from "@/lib/i18n";
import { textPx } from "@/lib/appearance";
import { editorFontSize } from "@/lib/code-settings";
import { kindOf, peekDimensions, peekView, titleKey, dragHeight, type Change } from "@/lib/quick-diff";
import type { Buffer } from "@/lib/buffer";
import type { GlyphName } from "@/lib/codicons";
import { loadLanguage } from "@/components/codeLang";
import { codeTheme, darkSyntax, fontSize } from "@/components/code/codeTheme";
import { codiconNode } from "@/components/code/codicon";
import { bufferView } from "@/components/code/buffer-view";

/** What the peek's buttons and keys do (components/code/git-gutter.ts). `stages`: a staging is currently running in this view — then the
 *  button is off (VS Code `enablement: !operationInProgress`). */
export type PeekControl = {
  next(): void;
  previous(): void;
  close(): void;
  stage(): Promise<void>;
  stages(): boolean;
  reset(): void;
};
/** What the peek shows. `show` counts every display WITH a position (showChange): only then does it recompute its height and reset a dragged
 *  handle; a refresh keeps it. */
export type PeekData = {
  show: number;
  index: number;
  count: number;
  change: Change;
  /** The index as text (normalised) — the left side of the diff. */
  base: string;
  buffer: Buffer;
  fileName: string;
  control: PeekControl;
};

/** The actions in VS Code's order: the git extension's menu entries (scm/change/title, reversed), then next, previous, finally close.
 *  Titles like VS Code's commands (git.revertChange "Revert Change", git.stageChange "Stage Change",
 *  editor.action.dirtydiff.next/previous "Show Next/Previous Change", peekview.close "Close"). */
export const PEEK_ACTIONS = [
  { id: "reset", title: "Revert Change", symbol: "discard" },
  { id: "stage", title: "Stage Change", symbol: "add" },
  { id: "next", title: "Show Next Change", symbol: "arrow-down" },
  { id: "previous", title: "Show Previous Change", symbol: "arrow-up" },
  { id: "close", title: "Close", symbol: "close" },
] as const satisfies readonly { id: keyof PeekControl; title: string; symbol: GlyphName }[];

/** The source of the quick diff (VS Code: the name of the git extension's provider, "Git Local Changes (Working Tree)"). */
export const SOURCE = "Git Local Changes (Working Tree)";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, kind: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = kind;
  if (text != null) e.textContent = text;
  return e;
};

const BODY = new WeakMap<HTMLElement, PeekBody>();
export class QuickDiffWidget extends WidgetType {
  constructor(readonly d: PeekData) { super(); }
  eq(o: WidgetType): boolean {
    if (!(o instanceof QuickDiffWidget)) return false;
    const a = o.d, b = this.d;
    return a.show === b.show && a.index === b.index && a.count === b.count && a.base === b.base && a.buffer === b.buffer && a.fileName === b.fileName
      && a.change.originalStart === b.change.originalStart && a.change.originalEnd === b.change.originalEnd
      && a.change.modifiedStart === b.change.modifiedStart && a.change.modifiedEnd === b.change.modifiedEnd;
  }
  toDOM(view: EditorView): HTMLElement {
    const k = new PeekBody(view, this.d);
    BODY.set(k.dom, k);
    return k.dom;
  }
  updateDOM(dom: HTMLElement): boolean {
    const k = BODY.get(dom);
    if (!k || k.d.buffer !== this.d.buffer) return false;
    k.take(this.d);
    return true;
  }
  destroy(dom: HTMLElement): void { BODY.get(dom)?.destroy(); }
  ignoreEvent(): boolean { return true; }
}

/** Switches "Stage Change" off in every peek of this view (`off`) or back on — a newly built peek asks `stages()` itself. */
export function stageButtonStatus(view: EditorView, off: boolean): void {
  for (const b of view.dom.querySelectorAll<HTMLButtonElement>(".cm-quickdiff-action[data-quick-diff-action=stage]")) b.disabled = off;
}

/** Does this view's peek currently have focus (QuickDiffWidget.hasFocus — then VS Code does not refresh it)? */
export function peekHasFocus(view: EditorView): boolean {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  return !!a && !!(a as Element).closest?.(".cm-quickdiff") && view.dom.contains(a);
}

class PeekBody {
  readonly dom: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly holder: HTMLElement;
  private readonly header: HTMLElement;
  private readonly name: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly body: HTMLElement;
  private readonly handle: HTMLElement;
  private view: EditorView | null = null;
  private readonly language = new Compartment();
  private pulled: number | null = null; // lines the handle set (until the next display)
  private alive = true;
  private readonly ro: ResizeObserver | null;
  d: PeekData;

  constructor(private readonly main: EditorView, d: PeekData) {
    this.d = d;
    this.dom = el("div", "cm-quickdiff");
    this.dom.setAttribute("role", "region");
    this.dom.dataset.quickDiff = "";
    this.arrow = el("div", "cm-quickdiff-arrow");
    this.holder = el("div", "cm-quickdiff-holder");
    this.header = el("div", "cm-quickdiff-header");
    const title = el("div", "cm-quickdiff-title");
    this.name = el("span", "cm-quickdiff-name");
    this.detail = el("span", "cm-quickdiff-detail");
    title.append(this.name, this.detail);
    const actions = el("div", "cm-quickdiff-actions");
    const bar = el("div", "cm-quickdiff-bar");
    for (const a of PEEK_ACTIONS) {
      const b = el("button", "cm-quickdiff-action");
      b.type = "button";
      b.title = tr(a.title);
      b.setAttribute("aria-label", tr(a.title));
      b.dataset.quickDiffAction = a.id;
      b.appendChild(codiconNode(a.symbol, "cm-quickdiff-symbol"));
      b.addEventListener("mousedown", (e) => e.preventDefault()); // focus stays where it was
      if (a.id === "stage") b.disabled = this.d.control.stages();
      b.addEventListener("click", (e) => { e.preventDefault(); void this.d.control[a.id](); });
      bar.appendChild(b);
    }
    actions.appendChild(bar);
    this.header.append(title, actions);
    this.body = el("div", "cm-quickdiff-body");
    this.holder.append(this.header, this.body);
    this.handle = el("div", "cm-quickdiff-handle");
    this.handle.addEventListener("mousedown", (e) => this.pull(e));
    this.dom.append(this.arrow, this.holder, this.handle);
    this.dom.addEventListener("keydown", (e) => {
      if ((e.key === "Escape") && !e.defaultPrevented) { e.preventDefault(); this.d.control.close(); }
    });
    this.view = new EditorView({ state: EditorState.create({ doc: d.buffer.text, extensions: this.extensions(d) }), parent: this.body });
    void loadLanguage(d.fileName).then((ext) => { if (this.alive && ext) this.view?.dispatch({ effects: this.language.reconfigure(ext) }); });
    this.ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.measure()) : null;
    this.ro?.observe(main.scrollDOM);
    this.draw(true);
  }

  /** New data (updateDOM): a new display recomputes height and view; a refresh only title, colour, base and view. */
  take(d: PeekData) {
    const fresh = d.show !== this.d.show;
    const baseNew = d.base !== this.d.base;
    this.d = d;
    if (fresh) this.pulled = null;
    if (baseNew && this.view) {
      const old = getOriginalDoc(this.view.state);
      const doc = Text.of(d.base.split("\n"));
      this.view.dispatch({ effects: updateOriginalDoc.of({ doc, changes: ChangeSet.of([{ from: 0, to: old.length, insert: d.base }], old.length) }) });
    }
    this.draw(fresh);
  }

  private extensions(d: PeekData): Extension {
    const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
    const p = d.buffer;
    return [
      basicSetup({ foldGutter: false, highlightActiveLine: true, highlightActiveLineGutter: true }),
      bufferView(p),
      // In the embedded editor the quick diff's commands mean the outer one (VS Code: `this.outerEditor`); ⌘S saves the file.
      Prec.highest(keymap.of([
        { key: "Escape", run: () => { this.d.control.close(); return true; } },
        { key: "Shift-Escape", run: () => { this.d.control.close(); return true; } },
        { key: "Alt-F3", preventDefault: true, run: () => { this.d.control.next(); return true; } },
        { key: "Shift-Alt-F3", preventDefault: true, run: () => { this.d.control.previous(); return true; } },
        { key: "Mod-s", preventDefault: true, stopPropagation: true, run: () => { void p.save(); return true; } },
      ])),
      codeTheme, fontSize(editorFontSize()), dark ? darkSyntax : [], this.language.of([]),
      unifiedMergeView({ original: d.base, gutter: false, highlightChanges: true, mergeControls: false, syntaxHighlightDeletions: true, allowInlineDiffs: false, diffConfig: { scanLimit: 5000, timeout: 1500 } }),
      DIFF_IN_PEEK, dark ? CHANGED_DARK : CHANGED_LIGHT,
    ];
  }

  /** Width and position: across the editor's whole width (gutters included, without minimap and vertical bar — ZoneWidget), sticks to the
   *  left on horizontal scroll. The arrow stands over column 2 of the line. */
  private measure() {
    if (!this.alive) return;
    const m = this.main;
    const margin = (m.dom.querySelector(".cm-gutters") as HTMLElement | null)?.offsetWidth ?? 0;
    const minimap = (m.dom.querySelector(".cm-minimap-gutter") as HTMLElement | null)?.offsetWidth ?? 0;
    this.dom.style.marginLeft = `${-margin}px`;
    this.dom.style.width = `${Math.max(200, m.scrollDOM.clientWidth - minimap)}px`;
    const character = m.defaultCharacterWidth;
    const rowsLeft = parseFloat(getComputedStyle(m.contentDOM.querySelector(".cm-line") ?? m.contentDOM).paddingLeft) || 0;
    this.arrow.style.left = `${margin + rowsLeft + character}px`;
  }

  private draw(newDisplay: boolean) {
    const d = this.d, m = this.main;
    const kind = kindOf(d.change);
    this.dom.dataset.quickDiffKind = kind;
    this.name.textContent = d.fileName;
    this.name.title = d.fileName;
    this.detail.textContent = tr(titleKey(d.count), { source: tr(SOURCE), n: d.index + 1, m: d.count });
    this.dom.setAttribute("aria-label", `${d.fileName} — ${this.detail.textContent}`);
    const dimensions = peekDimensions(d.change, m.defaultLineHeight, m.scrollDOM.clientHeight, this.pulled ?? undefined);
    if (newDisplay || this.pulled !== null || !this.dom.style.height) {
      this.dom.style.height = `${dimensions.height}px`;
      this.dom.style.setProperty("--qd-arrow", `${dimensions.arrow}px`);
      this.holder.style.top = `${dimensions.arrow}px`;
      this.holder.style.height = `${dimensions.holder}px`;
      this.holder.style.borderTopWidth = this.holder.style.borderBottomWidth = `${dimensions.frame}px`;
      this.header.style.height = this.header.style.lineHeight = `${dimensions.header}px`;
      this.body.style.height = `${dimensions.body}px`;
      this.handle.style.top = `${dimensions.height - (2 * dimensions.arrow + 2 * dimensions.frame) / 2 - 2}px`;
      this.dom.dataset.quickDiffRows = String(dimensions.rows);
    }
    this.measure();
    this.showChange();
  }

  /** revealChange: the change centred in the embedded diff. */
  private showChange() {
    const v = this.view;
    if (!v) return;
    const { from, until } = peekView(this.d.change);
    const doc = v.state.doc;
    const z = (n: number) => doc.line(Math.max(1, Math.min(n, doc.lines)));
    const beginning = z(from).from, end = z(until).to;
    requestAnimationFrame(() => {
      if (!this.alive || !this.view) return;
      this.view.dispatch({ effects: EditorView.scrollIntoView(EditorSelection.range(end, beginning), { y: "center" }) });
    });
  }

  /** The handle at the bottom (ZoneWidget sash): height in whole lines. */
  private pull(e: MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const lh = this.main.defaultLineHeight;
    const start = Number(this.dom.dataset.quickDiffRows) || 0;
    const y0 = e.clientY;
    const move = (ev: MouseEvent) => {
      const n = dragHeight(start, ev.clientY - y0, lh);
      if (n === null || n === this.pulled) return;
      this.pulled = n;
      this.draw(false);
      this.main.requestMeasure();
    };
    const release = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", release); this.dom.classList.remove("cm-quickdiff-dragging"); };
    this.dom.classList.add("cm-quickdiff-dragging");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", release);
  }

  destroy() {
    this.alive = false;
    this.ro?.disconnect();
    this.view?.destroy();
    this.view = null;
  }
}

/** Esc and ⇧Esc close the open peek from the outer editor (closeQuickDiff, weight EditorContrib + 50 — above the editor's other Esc bindings,
 *  below the open suggestion). */
export function peekKeys(open: (view: EditorView) => boolean, close: (view: EditorView) => void): Extension {
  // An open suggestion goes first (VS Code: hideSuggestWidget weighs EditorContrib + 90, closeQuickDiff EditorContrib + 50).
  const run = (view: EditorView) => { if (!open(view) || completionStatus(view.state) === "active") return false; close(view); return true; };
  return Prec.highest(keymap.of([{ key: "Escape", run }, { key: "Shift-Escape", run }]));
}

// The embedded diff in VS Code's colours (diffEditor.insertedLineBackground #9bb95533, insertedTextBackground #9ccc2c33 / light
// #9ccc2c40, removedLineBackground and removedTextBackground #ff000033). The classes of @codemirror/merge carry `&light`/`&dark` in the base
// theme — doubled classes beat them (like DiffTab.tsx). `EditorView.theme` does not know `&dark` (only the base theme), which is why the
// extension picks the colour of the changed text per mode.
const DIFF_IN_PEEK = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  "&.cm-merge-b.cm-merge-b .cm-changedLine": { backgroundColor: "#9bb95533" },
  "&.cm-editor.cm-editor .cm-deletedChunk": { backgroundColor: "#ff000033", paddingLeft: "6px" },
  "&.cm-editor.cm-editor .cm-deletedChunk .cm-deletedText": { background: "#ff000033" },
});
const CHANGED_DARK = EditorView.theme({ "&.cm-merge-b.cm-merge-b .cm-changedText": { background: "#9ccc2c33" } });
const CHANGED_LIGHT = EditorView.theme({ "&.cm-merge-b.cm-merge-b .cm-changedText": { background: "#9ccc2c40" } });

/** The shape (VS Code: .zone-widget, .peekview-widget, .head, .peekview-title, .peekview-actions, .monaco-action-bar, colours of Dark/Light
 *  Modern: peekViewTitle.background #252526/#f3f3f3, peekViewTitleLabel.foreground #ffffff/#000000, peekViewTitleDescription.foreground
 *  #ccccccb3/#616161, icon.foreground #cccccc/#3b3b3b, toolbar.hoverBackground #5a5d5e50/#b8b8b850, border and arrow in the change's colour
 *  — editorGutter.addedBackground #2ea043, modifiedBackground #0078d4/#005fb8, deletedBackground #f85149). */
export const PEEK_THEME = EditorView.baseTheme({
  "&dark .cm-quickdiff": { "--qd-header": "#252526", "--qd-title": "#ffffff", "--qd-description": "#ccccccb3", "--qd-symbol": "#cccccc", "--qd-symbol-off": "#cccccc80", "--qd-symbol-hover": "#5a5d5e50", "--qd-new": "#2ea043", "--qd-changed": "#0078d4", "--qd-deleted": "#f85149", "--qd-handle": "#0078d4" },
  "&light .cm-quickdiff": { "--qd-header": "#f3f3f3", "--qd-title": "#000000", "--qd-description": "#616161", "--qd-symbol": "#3b3b3b", "--qd-symbol-off": "#61616180", "--qd-symbol-hover": "#b8b8b850", "--qd-new": "#2ea043", "--qd-changed": "#005fb8", "--qd-deleted": "#f85149", "--qd-handle": "#005fb8" },
  ".cm-quickdiff": {
    position: "sticky", left: "0", zIndex: "201", boxSizing: "border-box", display: "block", whiteSpace: "normal", cursor: "default",
    fontFamily: "var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif)", lineHeight: "normal", "--qd-color": "var(--qd-changed)",
  },
  ".cm-quickdiff[data-quick-diff-kind=fresh]": { "--qd-color": "var(--qd-new)" },
  ".cm-quickdiff[data-quick-diff-kind=deleted]": { "--qd-color": "var(--qd-deleted)" },
  // The arrow (ZoneWidget arrow): a triangle pointing up, the tip at the lower edge of the line, the base on the frame.
  ".cm-quickdiff-arrow": {
    position: "absolute", top: "calc(-1 * var(--qd-arrow))", width: "0", height: "0", marginLeft: "calc(-1 * var(--qd-arrow))",
    borderStyle: "solid", borderColor: "transparent", borderWidth: "var(--qd-arrow)", borderBottomColor: "var(--qd-color)",
  },
  ".cm-quickdiff-holder": {
    position: "absolute", left: "0", right: "0", borderTopStyle: "solid", borderBottomStyle: "solid", borderLeft: "0", borderRight: "0",
    borderColor: "var(--qd-color)", boxShadow: "0 0 12px rgba(0, 0, 0, .14)", overflow: "hidden", boxSizing: "content-box",
  },
  ".cm-quickdiff-header": { boxSizing: "border-box", display: "flex", justifyContent: "space-between", flexWrap: "nowrap", backgroundColor: "var(--qd-header)" },
  ".cm-quickdiff-title": { display: "flex", alignItems: "baseline", fontSize: textPx(13), marginLeft: "20px", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-quickdiff-name": { color: "var(--qd-title)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ".cm-quickdiff-detail": { color: "var(--qd-description)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ".cm-quickdiff-detail:not(:empty)": { fontSize: "0.9em", marginLeft: "0.5em" },
  ".cm-quickdiff-actions": { flex: "1", textAlign: "right", paddingRight: "2px" },
  ".cm-quickdiff-bar": { display: "inline-flex", alignItems: "center", height: "100%", verticalAlign: "top" },
  ".cm-quickdiff-action": {
    display: "flex", alignItems: "center", justifyContent: "center", padding: "3px", margin: "0", border: "0", borderRadius: "6px",
    background: "transparent", color: "var(--qd-symbol)", cursor: "pointer", lineHeight: "0",
  },
  ".cm-quickdiff-action:not(:disabled):hover": { backgroundColor: "var(--qd-symbol-hover)" },
  // Off (`.monaco-action-bar .action-item.disabled`: disabledForeground, no pointer, no hover).
  ".cm-quickdiff-action:disabled": { color: "var(--qd-symbol-off)", cursor: "default" },
  ".cm-quickdiff-action:focus-visible": { outline: "1px solid var(--cb-focus, #0078d4)", outlineOffset: "-1px" },
  ".cm-quickdiff-symbol": { width: "16px", height: "16px", display: "block" },
  ".cm-quickdiff-body": { position: "relative", borderTop: "1px solid var(--qd-color)", backgroundColor: "var(--color-panel)" },
  // The handle (ZoneWidget sash, horizontal): 4 px, with the colour of sash.hoverBorder after a short dwell.
  ".cm-quickdiff-handle": { position: "absolute", left: "0", right: "0", height: "4px", cursor: "ns-resize", zIndex: "1", transition: "background-color .1s ease-out" },
  ".cm-quickdiff-handle:hover, .cm-quickdiff-dragging .cm-quickdiff-handle": { backgroundColor: "var(--qd-handle)", transitionDelay: ".3s" },
});
