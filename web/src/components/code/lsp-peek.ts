// Peek: an inline block under the line — on the left the target as an embedded editor, on the right the hits grouped by file
// (lib/navigation.ts `groupedByFile`, line preview via lsp-nav-core.ts `rowLoader`). Esc closes (in the editor as in the peek), Enter or double
// click opens the chosen hit as a tab (with a history entry), ↑/↓ move.
//
// EDITABLE (like VS Code): the embedded editor is a VIEW of the target file's buffer (lib/buffer.ts, components/code/buffer-view.ts) — what is
// typed there appears at once in every tab of the same file and lands unsaved in the buffer; if no tab holds the file, the editor opens it as an
// unsaved background tab (via the source's `EditorHolder`). It gets the same extensions as the source (language service, context menu, keys —
// `NavFile.build`). A target outside the instance is a read-only buffer: the editor in the peek is then read-only.
//
// A block widget in CodeMirror: the events inside do NOT belong to the source (`ignoreEvent`), the embedded editor has its own; CodeMirror
// assigns mutations and selection of an embedded view to itself (`Tile.owns`). The peek holds its buffers (`hold`) and releases them on close.
// ⌘S in the peek saves the PEEK's file and goes no further — otherwise CodePane would save the active tab.
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "@uiw/react-codemirror";
import { buffer as fetchBuffer, type EditorHolder, type Buffer, type BufferTarget } from "@/lib/buffer";
import { lspAreaOf, lspOffsetOf, type LspLocation } from "@/lib/api";
import { flatHits, groupedByFile, pathParts, previewParts, rowOf, type FileGroup } from "@/lib/navigation";
import { tr } from "@/lib/i18n";
import { textPx } from "@/lib/appearance";
import { loadLanguage } from "@/components/codeLang";
import { codeTheme, darkSyntax, fontSize } from "@/components/code/codeTheme";
import { editorFontSize } from "@/lib/code-settings";
import { overviewRuler } from "@/components/code/overviewRuler";
import { bufferView } from "@/components/code/buffer-view";
import { externalBuffer, rowLoader, type NavFile } from "@/components/code/lsp-nav-core";

/** What a peek shows. `open` opens a hit as a tab (false: the editor cannot — then the peek stays). */
export type PeekData = {
  title: string;
  locations: LspLocation[];
  target: BufferTarget;
  editor: EditorHolder | null;
  source: string;
  build: NavFile["build"];
  open: (location: LspLocation) => boolean;
};
type PeekState = { id: number; data: PeekData; pos: number };

const setPeek = StateEffect.define<PeekState | null>();
const peekField = StateField.define<PeekState | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPeek)) return e.value;
    return v && tr.docChanged ? { ...v, pos: tr.changes.mapPos(v.pos, 1) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v): DecorationSet =>
    v ? Decoration.set([Decoration.widget({ widget: new PeekWidget(v), block: true, side: 1 }).range(v.pos)]) : Decoration.none),
});

let peekSeq = 0;
/** Open the peek under the line of `at` (an open one is replaced). */
export function showPeek(view: EditorView, at: number, data: PeekData): void {
  if (!view.dom.isConnected || view.state.field(peekField, false) === undefined) return;
  const pos = view.state.doc.lineAt(Math.min(at, view.state.doc.length)).to;
  view.dispatch({ effects: [setPeek.of({ id: ++peekSeq, data, pos }), EditorView.scrollIntoView(pos, { y: "nearest" })] });
}
/** Closes this view's peek — false if none was open. */
export function closePeek(view: EditorView): boolean {
  if (!view.state.field(peekField, false)) return false;
  view.dispatch({ effects: setPeek.of(null) });
  return true;
}

const BODY = new WeakMap<HTMLElement, PeekBody>();
class PeekWidget extends WidgetType {
  constructor(readonly state: PeekState) { super(); }
  eq(o: PeekWidget): boolean { return o.state.id === this.state.id; }
  get estimatedHeight(): number { return HEIGHT + 10; }
  toDOM(view: EditorView): HTMLElement {
    const k = new PeekBody(view, this.state.data);
    BODY.set(k.dom, k);
    return k.dom;
  }
  destroy(dom: HTMLElement): void { BODY.get(dom)?.destroy(); }
  ignoreEvent(): boolean { return true; }
}

const HEIGHT = 300;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, kind: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = kind;
  if (text != null) e.textContent = text;
  return e;
};

/** Marks the target range in the embedded editor. */
const setMarker = StateEffect.define<{ from: number; to: number } | null>();
const markerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(d, tr) {
    for (const e of tr.effects) if (e.is(setMarker)) return e.value && e.value.to > e.value.from ? Decoration.set([MARKER.range(e.value.from, e.value.to)]) : Decoration.none;
    return d.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
const MARKER = Decoration.mark({ class: "cm-peek-target" });

class PeekBody {
  readonly dom: HTMLElement;
  private readonly list: HTMLElement;
  private readonly host: HTMLElement;
  private readonly headerName: HTMLElement;
  private readonly headerFolder: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly groups: FileGroup[];
  private readonly locations: LspLocation[];
  private readonly rows: HTMLElement[] = [];
  private readonly read: ReturnType<typeof rowLoader>;
  private view: EditorView | null = null;
  private shown: { p: Buffer; release: () => void } | null = null;
  private readonly language = new Compartment();
  private choice = 0;
  private run = 0;
  private alive = true;
  private readonly ro: ResizeObserver | null;

  constructor(private readonly main: EditorView, private readonly d: PeekData) {
    this.groups = groupedByFile(d.locations);
    this.locations = flatHits(this.groups);
    this.read = rowLoader(d.target, d.source);
    this.dom = el("div", "cm-peek");
    this.dom.setAttribute("role", "region");
    this.dom.setAttribute("aria-label", d.title);
    this.dom.dataset.peek = "";
    const header = el("div", "cm-peek-header");
    this.headerName = el("span", "cm-peek-name");
    this.headerFolder = el("span", "cm-peek-folder");
    const count = el("span", "cm-peek-count", `${d.title} · ${this.locations.length}`);
    const closeButton = el("button", "cm-peek-close");
    closeButton.type = "button";
    closeButton.title = tr("Close");
    closeButton.setAttribute("aria-label", tr("Close"));
    closeButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
    closeButton.addEventListener("click", () => this.close());
    header.append(this.headerName, this.headerFolder, el("span", "cm-peek-gap"), count, closeButton);
    const body = el("div", "cm-peek-body");
    this.host = el("div", "cm-peek-editor");
    this.hint = el("div", "cm-peek-hint");
    this.host.append(this.hint);
    this.list = el("div", "cm-peek-list");
    this.list.setAttribute("role", "tree");
    this.list.tabIndex = 0;
    this.buildList();
    body.append(this.host, this.list);
    this.dom.append(header, body);
    // Keys in the peek (the source does not see them — `ignoreEvent`): Esc closes (also from the embedded editor if it did not need it
    // itself), in the list ↑/↓ move, Enter opens.
    this.dom.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); this.close(); return; }
      if (!this.list.contains(e.target as Node)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.select(this.choice + (e.key === "ArrowDown" ? 1 : -1), true); }
      else if (e.key === "Enter") { e.preventDefault(); this.openTab(this.choice); }
    });
    this.ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.measure()) : null;
    this.ro?.observe(main.scrollDOM);
    this.measure();
    this.select(0, false);
    requestAnimationFrame(() => { if (this.alive) this.list.focus({ preventScroll: true }); });
  }

  /** Width = visible area right of the gutters; sticks to them on horizontal scroll (like VS Code: the peek does not scroll along). */
  private measure() {
    const margin = (this.main.dom.querySelector(".cm-gutters") as HTMLElement | null)?.offsetWidth ?? 0;
    this.dom.style.left = `${margin}px`;
    this.dom.style.width = `${Math.max(280, this.main.scrollDOM.clientWidth - margin - 12)}px`;
  }

  private buildList() {
    let i = 0;
    for (const g of this.groups) {
      const { name, folder } = pathParts(g.file);
      const header = el("div", "cm-peek-file");
      header.setAttribute("role", "treeitem");
      header.setAttribute("aria-expanded", "true");
      header.title = g.file;
      const arrow = el("span", "cm-peek-arrow", "▾");
      header.append(arrow, el("span", "cm-peek-dname", name), el("span", "cm-peek-dfolder", g.extern ? tr("outside the project") : folder), el("span", "cm-peek-dcount", String(g.locations.length)));
      const rows: HTMLElement[] = [];
      header.addEventListener("click", () => {
        const expanded = header.getAttribute("aria-expanded") === "true";
        header.setAttribute("aria-expanded", expanded ? "false" : "true");
        arrow.textContent = expanded ? "▸" : "▾";
        for (const z of rows) z.hidden = expanded;
      });
      this.list.append(header);
      for (const o of g.locations) {
        const n = i++;
        const z = el("div", "cm-peek-hits");
        z.setAttribute("role", "treeitem");
        z.setAttribute("aria-selected", "false");
        z.append(el("span", "cm-peek-row", String(rowOf(o.range))), el("span", "cm-peek-text"));
        z.addEventListener("mousedown", (e) => e.preventDefault()); // focus stays in the list (keys)
        z.addEventListener("click", () => { this.list.focus({ preventScroll: true }); this.select(n, false); });
        z.addEventListener("dblclick", () => this.openTab(n));
        rows.push(z);
        this.rows.push(z);
        this.list.append(z);
      }
      void this.read(g.file, g.extern).then((text) => {
        if (!this.alive || !text) return;
        g.locations.forEach((o, k) => {
          const row = text[o.range.start.line] ?? "";
          const end = o.range.end.line === o.range.start.line ? o.range.end.character : row.length;
          const t = previewParts(row, o.range.start.character, end);
          const target = rows[k]?.querySelector(".cm-peek-text");
          if (!target) return;
          target.replaceChildren(document.createTextNode(t.before), el("mark", "cm-peek-fund", t.hits), document.createTextNode(t.after));
        });
      });
    }
  }

  private select(i: number, roles: boolean) {
    if (!this.locations.length) return;
    const n = Math.max(0, Math.min(this.locations.length - 1, i));
    this.rows[this.choice]?.setAttribute("aria-selected", "false");
    this.choice = n;
    const z = this.rows[n];
    z?.setAttribute("aria-selected", "true");
    if (z && roles) z.scrollIntoView({ block: "nearest" });
    void this.show(this.locations[n]);
  }

  /** Show the hit on the left: same file ⇒ only the position; otherwise its buffer (loaded, held) in a new view. */
  private async show(location: LspLocation) {
    const { name, folder } = pathParts(location.file);
    this.headerName.textContent = name;
    this.headerFolder.textContent = location.external ? tr("outside the project · read-only") : folder;
    this.headerName.title = location.file;
    const seq = ++this.run;
    if (this.shown?.p.path === location.file && this.view) { this.jump(location); return; }
    this.hint.textContent = tr("Loading…##inline");
    this.hint.hidden = false;
    let fresh: { p: Buffer; release: () => void } | null = null;
    try {
      if (location.external?.token) fresh = await externalBuffer(this.d.target, location.file, location.external.token, this.d.source);
      else {
        const p = fetchBuffer(this.d.target, location.file);
        const release = p.hold("other");
        fresh = { p, release };
        const r = await p.load();
        if (r.kind !== "text") throw new Error(r.kind === "error" ? String((r.error as Error)?.message ?? r.error) : tr("Binary file — cannot be edited as text."));
      }
    } catch (e) {
      fresh?.release();
      if (this.alive && seq === this.run) this.hint.textContent = String((e as Error)?.message ?? e);
      return;
    }
    if (!this.alive || seq !== this.run) { fresh.release(); return; }
    const old = this.shown;
    this.shown = fresh;
    this.hint.hidden = true;
    const state = EditorState.create({ doc: fresh.p.text, extensions: this.extensions(fresh.p) });
    if (this.view) this.view.setState(state);
    else this.view = new EditorView({ state, parent: this.host });
    old?.release(); // only after the switch: the old view has let go
    void loadLanguage(name).then((ext) => { if (this.alive && ext && this.shown === fresh) this.view?.dispatch({ effects: this.language.reconfigure(ext) }); });
    this.jump(location);
  }

  private extensions(p: Buffer): Extension {
    const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
    return [
      basicSetup({ foldGutter: false, highlightActiveLine: true, highlightActiveLineGutter: true }),
      bufferView(p, { editor: this.d.editor }),
      Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, stopPropagation: true, run: () => { void p.save(); return true; } }])),
      codeTheme, fontSize(editorFontSize()), dark ? [darkSyntax, EditorView.darkTheme.of(true)] : [], this.language.of([]), markerField, PEEK_EDITOR,
      overviewRuler(2), // two lanes like VS Code's peek (`overviewRulerLanes: 2`)
      this.d.build(p),
    ];
  }

  private jump(location: LspLocation) {
    const v = this.view;
    if (!v) return;
    const b = lspAreaOf(v.state.doc, location.range);
    const beginning = lspOffsetOf(v.state.doc, location.range.start);
    v.dispatch({ selection: { anchor: beginning }, effects: [setMarker.of(b), EditorView.scrollIntoView(beginning, { y: "center" })] });
  }

  private openTab(i: number) {
    const location = this.locations[i];
    if (location && this.d.open(location)) this.close(false);
  }

  private close(focus = true) {
    if (!this.main.dom.isConnected) return;
    closePeek(this.main);
    if (focus) this.main.focus();
  }

  destroy() {
    this.alive = false;
    this.ro?.disconnect();
    this.view?.destroy();
    this.view = null;
    this.shown?.release();
    this.shown = null;
  }
}

const PEEK_EDITOR = EditorView.theme({
  "&": { height: "100%", fontSize: "inherit" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-peek-target": { backgroundColor: "color-mix(in srgb, var(--color-accent) 22%, transparent)", borderRadius: "2px" },
});

/** The shape: flat in the app's colour roles (like `cb-kit-pane` under `.cb-flat`), top/bottom edge in the accent like VS Code's peek,
 *  selection = `edge`. Standing inside the source's content, it resets font, wrapping and pointer of the lines. */
const PEEK_THEME = EditorView.baseTheme({
  ".cm-peek": {
    position: "sticky", boxSizing: "border-box", height: `${HEIGHT}px`, margin: "4px 0 6px", display: "flex", flexDirection: "column",
    border: "1px solid var(--color-edge)", borderTop: "2px solid color-mix(in srgb, var(--color-accent) 70%, transparent)",
    borderBottom: "2px solid color-mix(in srgb, var(--color-accent) 70%, transparent)", borderRadius: "6px", overflow: "hidden",
    backgroundColor: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-sans)", whiteSpace: "normal", lineHeight: "1.4", cursor: "default",
  },
  ".cm-peek-header": { display: "flex", alignItems: "center", gap: "8px", minHeight: "26px", padding: "0 6px 0 10px", borderBottom: "1px solid var(--color-edge)", fontSize: textPx(12) },
  ".cm-peek-name": { fontWeight: "600", whiteSpace: "nowrap" },
  ".cm-peek-folder": { color: "var(--color-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" },
  ".cm-peek-gap": { flex: "1" },
  ".cm-peek-count": { color: "var(--color-dim)", whiteSpace: "nowrap" },
  ".cm-peek-close": { display: "grid", placeItems: "center", width: "22px", height: "22px", border: "0", borderRadius: "6px", background: "none", color: "var(--color-dim)", cursor: "pointer" },
  ".cm-peek-close:hover": { backgroundColor: "var(--color-hover)", color: "var(--color-fg)" },
  ".cm-peek-body": { display: "flex", minHeight: "0", flex: "1" },
  ".cm-peek-editor": { position: "relative", minWidth: "0", flex: "1", backgroundColor: "var(--color-panel)" },
  ".cm-peek-hint": { padding: "10px 12px", color: "var(--color-dim)", fontSize: textPx(12) },
  ".cm-peek-list": { width: "38%", maxWidth: "360px", minWidth: "160px", overflow: "auto", borderLeft: "1px solid var(--color-edge)", padding: "4px", outline: "none", fontSize: textPx(12) },
  ".cm-peek-file": { display: "flex", alignItems: "center", gap: "6px", padding: "3px 6px", borderRadius: "6px", cursor: "pointer", whiteSpace: "nowrap" },
  ".cm-peek-file:hover, .cm-peek-hits:hover": { backgroundColor: "var(--color-hover)" },
  ".cm-peek-arrow": { width: "10px", color: "var(--color-dim)", fontSize: textPx(10) },
  ".cm-peek-dname": { fontWeight: "600" },
  ".cm-peek-dfolder": { color: "var(--color-dim)", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0", flex: "1" },
  ".cm-peek-dcount": { color: "var(--color-dim)", fontSize: textPx(10.5), fontVariantNumeric: "tabular-nums" },
  ".cm-peek-hits": { display: "flex", gap: "8px", padding: "2px 6px 2px 22px", borderRadius: "6px", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" },
  ".cm-peek-hits[aria-selected=true]": { backgroundColor: "var(--color-edge)" },
  ".cm-peek-row": { color: "var(--color-dim)", fontVariantNumeric: "tabular-nums", minWidth: "2.5em", textAlign: "right" },
  ".cm-peek-text": { fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-peek-fund": { backgroundColor: "color-mix(in srgb, var(--color-accent) 22%, transparent)", color: "inherit", borderRadius: "2px" },
});

/** Field, widget and shape — on every view with a buffer (components/code/lsp-navigation.ts). */
export const peekExtension: Extension = [peekField, PEEK_THEME];
