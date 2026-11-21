// The overview ruler at the right edge of the code editor like VS Code: ONE ruler in the vertical scrollbar's track, holding diagnostics
// (right), git changes (left), search hits and the occurrences of the word at the caret or selection (middle), the carets as a line across all
// lanes and the edge — above it the slider like in VS Code (visible while the pointer is over the editor or shortly after scrolling; a click
// in the track jumps with its middle there, dragging scrolls). The native vertical bar is invisible but keeps its width: the minimap sits to
// its left, the text does not run under the ruler.
//
// The computation lives purely in lib/overviewRuler.ts (lanes, colours, rectangles per colour, merging per pixel, slider). The ruler reads
// its sources, it builds none: diagnostics via `forEachDiagnostic` (@codemirror/lint), git via the facet `rulerGit` (which
// components/code/git-gutter.ts supplies from its state), search hits from `searchHits` (components/code/search-widget.ts — the widget has
// no strokes of its own any more), the occurrences from `occurrencesAreas` (components/code/lsp-occurrences.ts); only the occurrences of the
// selection it computes itself (lib `selectionSearchText`/`occurrencesIn`; not if the open search already shows the same text:
// `selectionAsSearch`). Mounted in components/CodePane.tsx (file tabs in Coding → Files, both editor groups, chat code tabs) and in the peek
// (components/code/lsp-peek.ts, two lanes as in VS Code there). Guard: web/test/overviewRuler.test.mjs.
import { Facet, type Extension, type Text } from "@codemirror/state";
import { BlockType, EditorView, ViewPlugin, type BlockInfo, type ViewUpdate } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import type { DiffBlock } from "@/lib/dirty-diff";
import {
  RULER_WIDTH, RULER_COLORS, SLIDER_COLORS, HORIZONTAL_HEIGHT, kindOfSeverity, selectionSearchText, selectionAsSearch, cursorRectangles, gitInRuler,
  edge, clampScroll, rulerRectangles, scrollTargetFromClick, scrollTargetFromDrag, slider, occurrencesIn, type RulerEntry, type RulerMeasure, type Slider,
} from "@/lib/overviewRuler";
import { searchHits } from "@/components/code/search-widget";
import { occurrencesAreas } from "@/components/code/lsp-occurrences";

/** The blocks of the git gutter — the ONE seam between gutter and ruler: components/code/git-gutter.ts supplies them from its state
 *  (`rulerGit.from(field, …)`); empty without a gutter. */
export const rulerGit = Facet.define<readonly DiffBlock[], readonly DiffBlock[]>({ combine: (w) => w[0] ?? [] });

/** The TEXT line at `pos`: `lineBlockAt` returns a line together with its block widgets (the peek, the quick-diff peek) as ONE
 *  block — a mark would otherwise span the whole zone; in VS Code's ruler zones do not appear in the marks. */
function rowsBlock(v: EditorView, pos: number): BlockInfo {
  const b = v.lineBlockAt(pos);
  return Array.isArray(b.type) ? (b.type as readonly BlockInfo[]).find((t) => t.type === BlockType.Text && t.from <= pos && pos <= t.to) ?? b : b;
}

/** How long the slider stays visible after scrolling (VS Code `ScrollableElement`, HIDE_TIMEOUT). */
const VISIBLE_MS = 500;

type Measurement = { mass: RulerMeasure; top: number; entries: RulerEntry[]; cursor: number[]; dark: boolean };

class Ruler {
  readonly dom: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly sliderEl: HTMLDivElement;
  private s: Slider = { needed: false, size: 0, situation: 0, ratio: 0 };
  private turn: { start: Slider; y: number; id: number } | null = null;
  private over = false;
  private clock: ReturnType<typeof setTimeout> | null = null;
  private selection: { doc: Text; from: number; to: number; search: string; locations: number[] } | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(readonly view: EditorView, readonly lanes: 1 | 2 | 3) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-ruler";
    this.dom.setAttribute("aria-hidden", "true");
    this.canvas = document.createElement("canvas");
    this.sliderEl = document.createElement("div");
    this.sliderEl.className = "cm-ruler-slider";
    this.dom.append(this.canvas, this.sliderEl);
    view.dom.appendChild(this.dom);
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, kind: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(kind, fn, o);
      this.disposers.push(() => el.removeEventListener(kind, fn, o));
    };
    on(this.dom, "pointerdown", (e) => this.press(e));
    on(this.dom, "pointermove", (e) => this.pull(e));
    on(this.dom, "pointerup", (e) => this.leave(e));
    on(this.dom, "pointercancel", (e) => this.leave(e));
    on(this.dom, "wheel", (e) => this.wheel(e), { passive: false });
    on(view.scrollDOM, "scroll", () => { this.sliderNew(); this.show(); }, { passive: true });
    on(view.dom, "mouseenter", () => { this.over = true; this.show(); });
    on(view.dom, "mouseleave", () => { this.over = false; this.show(); });
    // A different pixel ratio (zoom, another screen) is not a transaction: repaint when the window changes.
    const fresh = () => this.plane();
    window.addEventListener("resize", fresh);
    this.disposers.push(() => window.removeEventListener("resize", fresh));
    this.plane();
  }

  update(u: ViewUpdate) {
    // Every transaction can change a source (text, selection, diagnostics, git gutter base, search hits, occurrences, theme).
    if (u.transactions.length || u.geometryChanged || u.heightChanged) this.plane();
  }

  destroy() {
    for (const fn of this.disposers) fn();
    if (this.clock) clearTimeout(this.clock);
    this.dom.remove();
  }

  private plane() {
    this.view.requestMeasure({ key: this, read: (v) => this.read(v), write: (m) => this.draw(m) });
  }

  /** The entries as layers in the scroll area (they do not change while scrolling — only the slider moves). */
  private read(v: EditorView): Measurement {
    const sd = v.scrollDOM, st = v.state, doc = st.doc;
    const offset = v.documentTop - sd.getBoundingClientRect().top + sd.scrollTop;
    const entries: RulerEntry[] = [];
    const area = (kind: RulerEntry["kind"], from: number, to: number) => {
      const a = rowsBlock(v, Math.min(from, doc.length)), b = rowsBlock(v, Math.min(Math.max(from, to), doc.length));
      entries.push({ kind, top: offset + a.top, bottom: offset + b.bottom });
    };
    forEachDiagnostic(st, (d, from, to) => { const kind = kindOfSeverity(d.severity); if (kind) area(kind, from, to); });
    for (const b of st.facet(rulerGit)) {
      const g = gitInRuler(b, doc.lines);
      if (g) area(g.kind, doc.line(g.from).from, doc.line(g.until).from);
    }
    let row = -1;
    for (const p of st.field(searchHits, false) ?? []) {
      if (p > doc.length) continue;
      const b = rowsBlock(v, p);
      if (b.from === row) continue; // same line: same entry
      row = b.from;
      entries.push({ kind: "hits", top: offset + b.top, bottom: offset + b.bottom });
    }
    occurrencesAreas(v).between(0, doc.length, (from, to) => { area("word", from, to); });
    const search = selectionSearchText(st.selection.ranges, (a, b) => st.sliceDoc(a, b)), q = getSearchQuery(st);
    if (search && !selectionAsSearch(search, { open: searchPanelOpen(st), text: q.search, regexp: q.regexp, caseSensitive: q.caseSensitive })) {
      const { from, to } = st.selection.main;
      const a = this.selection;
      // Search once per text and selection — not the whole text on every transaction (diagnostics, hits).
      const locations = a && a.doc === doc && a.from === from && a.to === to && a.search === search ? a.locations : occurrencesIn(doc.toString(), search, from);
      this.selection = { doc, from, to, search, locations };
      for (const p of locations) area("selection", p, p + search.length);
    } else this.selection = null;
    const cursor = st.selection.ranges.map((r) => offset + v.lineBlockAt(r.head).top);
    return {
      mass: { width: RULER_WIDTH, height: sd.clientHeight, total: sd.scrollHeight, pixel: window.devicePixelRatio || 1, lanes: this.lanes },
      top: sd.offsetTop, entries, cursor, dark: st.facet(EditorView.darkTheme),
    };
  }

  private draw(m: Measurement) {
    const { mass } = m;
    this.dom.style.top = `${m.top}px`;
    this.dom.style.height = `${mass.height}px`;
    const cw = Math.round(mass.width * mass.pixel), ch = Math.round(mass.height * mass.pixel);
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, cw, ch);
      const f = RULER_COLORS[m.dark ? "dark" : "light"];
      for (const r of [...rulerRectangles(m.entries, mass, f), ...cursorRectangles(m.cursor, mass, f.cursor), ...edge(mass, f.edge)]) {
        ctx.fillStyle = r.color;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }
    this.sliderNew();
  }

  /** Position and size of the slider from the scroll area (while scrolling without new entries). */
  private sliderNew() {
    const sd = this.view.scrollDOM;
    this.s = slider(sd.clientHeight, sd.clientHeight, sd.scrollHeight, sd.scrollTop);
    this.sliderEl.hidden = !this.s.needed;
    this.sliderEl.style.height = `${this.s.size}px`;
    this.sliderEl.style.transform = `translateY(${this.s.situation}px)`;
  }

  /** Visible while the pointer is over the editor or dragging, otherwise briefly after scrolling; then it fades. */
  private show() {
    this.dom.toggleAttribute("data-visible", true);
    if (this.clock) clearTimeout(this.clock);
    this.clock = null;
    if (this.over || this.turn) return;
    this.clock = setTimeout(() => { this.clock = null; if (!this.over && !this.turn) this.dom.toggleAttribute("data-visible", false); }, VISIBLE_MS);
  }

  private press(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); // no focus change, no text selection
    this.sliderNew();
    if (!this.s.needed) return;
    const sd = this.view.scrollDOM, y = e.clientY - this.dom.getBoundingClientRect().top;
    if (y < this.s.situation || y >= this.s.situation + this.s.size) {
      // Clicked in the track: jump there, then the same press keeps dragging the slider (VS Code `_onMouseDown` → `_sliderMouseDown`).
      sd.scrollTop = clampScroll(scrollTargetFromClick(y, this.s), sd.clientHeight, sd.scrollHeight);
      this.sliderNew();
    }
    this.turn = { start: this.s, y: e.clientY, id: e.pointerId };
    this.dom.setPointerCapture(e.pointerId);
    this.dom.toggleAttribute("data-dragging", true);
    this.show();
  }
  private pull(e: PointerEvent) {
    if (!this.turn || e.pointerId !== this.turn.id) return;
    const sd = this.view.scrollDOM;
    sd.scrollTop = clampScroll(scrollTargetFromDrag(this.turn.start, e.clientY - this.turn.y), sd.clientHeight, sd.scrollHeight);
  }
  private leave(e: PointerEvent) {
    if (!this.turn || e.pointerId !== this.turn.id) return;
    this.turn = null;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    this.dom.toggleAttribute("data-dragging", false);
    this.show();
  }
  /** The wheel over the ruler scrolls the editor (the ruler lies above the scroll area, not in it). */
  private wheel(e: WheelEvent) {
    const sd = this.view.scrollDOM;
    const f = e.deltaMode === 1 ? this.view.defaultLineHeight : e.deltaMode === 2 ? sd.clientHeight : 1;
    e.preventDefault();
    sd.scrollBy({ top: e.deltaY * f, left: e.deltaX * f });
  }
}

const PLUGIN = { 2: ViewPlugin.define((v) => new Ruler(v, 2)), 3: ViewPlugin.define((v) => new Ruler(v, 3)) } as const;

// The slider colours as variables on the editor (light/dark), the rules themselves only for editors WITH a ruler (`cm-with-ruler`).
const sliderColors = EditorView.baseTheme({
  "&dark": { "--cb-slider": SLIDER_COLORS.dark.quiet, "--cb-slider-hover": SLIDER_COLORS.dark.hover, "--cb-slider-active": SLIDER_COLORS.dark.active },
  "&light": { "--cb-slider": SLIDER_COLORS.light.quiet, "--cb-slider-hover": SLIDER_COLORS.light.hover, "--cb-slider-active": SLIDER_COLORS.light.active },
});
const form = EditorView.theme({
  // The native vertical bar keeps its width (always, also without overflow — the minimap sits to its left) but is invisible: the
  // ruler lies above it. `scrollbar-color`/`-width` otherwise inherits from outside and switches off the WebKit rules (Chrome from 121).
  "&.cm-with-ruler .cm-scroller": { overflowY: "scroll", scrollbarWidth: "auto", scrollbarColor: "auto" },
  "&.cm-with-ruler .cm-scroller::-webkit-scrollbar": { width: `${RULER_WIDTH}px`, height: `${HORIZONTAL_HEIGHT}px` },
  "&.cm-with-ruler .cm-scroller::-webkit-scrollbar-track, &.cm-with-ruler .cm-scroller::-webkit-scrollbar-corner": { background: "transparent" },
  "&.cm-with-ruler .cm-scroller::-webkit-scrollbar-thumb:vertical": { background: "transparent" },
  "&.cm-with-ruler .cm-scroller::-webkit-scrollbar-thumb:horizontal": { background: "var(--cb-slider)" },
  "&.cm-with-ruler .cm-scroller::-webkit-scrollbar-thumb:horizontal:hover": { background: "var(--cb-slider-hover)" },
  "&.cm-with-ruler .cm-scroller::-webkit-scrollbar-thumb:horizontal:active": { background: "var(--cb-slider-active)" },
  ".cm-ruler": { position: "absolute", top: "0", right: "0", width: `${RULER_WIDTH}px`, zIndex: "5", touchAction: "none" },
  ".cm-ruler > canvas": { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" },
  ".cm-ruler-slider": {
    position: "absolute", top: "0", left: "0", width: "100%", background: "var(--cb-slider)", opacity: "0", transition: "opacity 800ms linear",
  },
  ".cm-ruler[data-visible] .cm-ruler-slider": { opacity: "1", transition: "opacity 100ms linear" },
  ".cm-ruler-slider:hover": { background: "var(--cb-slider-hover)" },
  ".cm-ruler[data-dragging] .cm-ruler-slider": { background: "var(--cb-slider-active)" },
});

/** The overview ruler; `lanes` like VS Code `overviewRulerLanes` (the editor 3, the peek 2). */
export function overviewRuler(lanes: 2 | 3 = 3): Extension {
  return [PLUGIN[lanes], EditorView.editorAttributes.of({ class: "cm-with-ruler" }), sliderColors, form];
}
