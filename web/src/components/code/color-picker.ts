// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPickerWidget.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerHeader.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPickerParts/colorPickerBody.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/hoverColorPicker/hoverColorPickerParticipant.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPickerParticipantUtils.ts (MIT)
// Port of: microsoft/vscode src/vs/editor/contrib/colorPicker/browser/colorPicker.css (MIT)
//
// The colour picker as in VS Code 1.143: a click on the colour square (components/code/lsp-colors.ts) opens it at once, dwelling over the
// square or the colour value opens it after the hover time (VS Code `editor.colorDecoratorsActivatedOn: "clickAndHover"`, hover 300 ms).
// Layout and sizes from colorPicker.css: header 24 px (left the chosen colour with its notation and the codicon `color-mode`, right 74 px
// the original one), below it with an 8 px margin the saturation box (≥ 220 px, 150 px high, circle 9 px), the opacity and the hue strip
// (25 px each, slider 4 px) — 190 px in total. Behaviour as in VS Code (hoverColorPickerParticipant.ts): dragging changes the colour and
// asks the notations again (`textDocument/colorPresentation`, only the header label changes); RELEASING writes (`onColorFlushed` →
// `updateEditorModel`: the server's `textEdit`, otherwise the label over the range, plus `additionalTextEdits`; the range moves along). A
// click on the header takes the next notation and writes, a click on the original colour resets it and writes. Every FOREIGN change of the
// text closes the picker (`onDidChangeModelContent`, not by the picker), as do Esc, a click outside and the pointer leaving colour value and
// picker (except while dragging). The LSP hover is silent over a colour (lsp-hover.ts) — VS Code shows only the picker there. The
// computation is in lib/color-picker.ts.
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, showTooltip, type Tooltip, type TooltipView } from "@codemirror/view";
import { isNotSupported, lspOffsetOf, lspPosOf, type LspColorNotation } from "@/lib/api";
import {
  fromOpacity, fromHue, fromLsp, fromSaturation, cssColor, opacityHistory, opacityValue, hueValue, sameColor, indexAfterNewNotations,
  headerLight, nextNotation, rateNotation, rgba, saturationBackground, saturationMarker, sliderTop, stripValue, toLsp, type ColorValue,
} from "@/lib/color-picker";
import { tr } from "@/lib/i18n";
import { textPx } from "@/lib/appearance";
import { questions, can, lspFileOf } from "@/components/code/lsp-core";
import { colorAt } from "@/components/code/lsp-colors";
import { codiconNode } from "@/components/code/codicon";

/** VS Code `editor.hover.delay` (300 ms) — how long the pointer dwells until the picker opens; how long it may leave before it closes. */
export const PICKER_HOVER_MS = 300;
/** The origin of a change made by the picker (VS Code `executeEdits('colorpicker', …)`): it does not close it. */
export const PICKER_EVENT = "input.colorPicker";

type Open = { from: number; to: number; tooltip: Tooltip; source: "click" | "hover" };
const setPicker = StateEffect.define<Open | null>();
const setArea = StateEffect.define<{ from: number; to: number }>();
export const pickerField = StateField.define<Open | null>({
  create: () => null,
  update(v, t) {
    for (const e of t.effects) {
      if (e.is(setPicker)) return e.value;
      if (e.is(setArea) && v) return { ...v, from: e.value.from, to: e.value.to };
    }
    if (v && t.docChanged) return t.isUserEvent(PICKER_EVENT) ? v : null; // foreign change ⇒ closed (VS Code: hide + focus)
    return v;
  },
  provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
});

/** Is there a colour value at `pos` the picker is responsible for (server with `document_color`)? The LSP hover is silent there. */
export function colorForPicker(view: EditorView, pos: number): { from: number; to: number } | null {
  if (!can(lspFileOf(view.state), "document_color")) return null;
  return colorAt(view.state, pos);
}

/** Open the picker at the colour at `pos`. */
export function openColorPicker(view: EditorView, pos: number, source: "click" | "hover"): boolean {
  const d = lspFileOf(view.state);
  const f = can(d, "document_color") ? colorAt(view.state, pos) : null;
  if (!f || !d) return false;
  const open = view.state.field(pickerField, false);
  if (open && open.from === f.from && open.to === f.to) {
    if (source === "click" && open.source !== "click") view.dispatch({ effects: setPicker.of({ ...open, source }) });
    return true;
  }
  const original = fromLsp(f.color);
  const originalText = view.state.sliceDoc(f.from, f.to);
  const tooltip: Tooltip = { pos: f.from, above: true, arrow: false, create: (v) => new ColorPicker(v, original, originalText) };
  view.dispatch({ effects: setPicker.of({ from: f.from, to: f.to, tooltip, source }) });
  return true;
}
export function closeColorPicker(view: EditorView): void {
  if (view.state.field(pickerField, false)) view.dispatch({ effects: setPicker.of(null) });
}

/** The open picker per view (for "currently dragging" on leaving). */
const OPEN = new WeakMap<EditorView, ColorPicker>();

/** The widget (colorPickerWidget.ts with header and body of type "Hover"). */
class ColorPicker implements TooltipView {
  readonly dom: HTMLElement;
  private color: ColorValue;
  private notations: LspColorNotation[] = [];
  private index = 0;
  private askSeq = 0;
  private writeSeq = 0;
  private dragging = false;
  private destroyed = false;
  private afterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cancel the closing after leaving (the pointer is back in the picker or on its colour). */
  hold() { if (this.afterTimer) clearTimeout(this.afterTimer); this.afterTimer = null; }
  private readonly header: HTMLElement;
  private readonly label: HTMLElement;
  private readonly origin: HTMLElement;
  private readonly field: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ring: HTMLElement;
  private readonly deckStrip: HTMLElement;
  private readonly deckHistory: HTMLElement;
  private readonly deckSlider: HTMLElement;
  private readonly toneStrip: HTMLElement;
  private readonly toneSlider: HTMLElement;

  constructor(readonly view: EditorView, readonly original: ColorValue, readonly originalText: string) {
    this.color = original;
    const el = (kind: string, parent?: HTMLElement, tag = "div") => { const e = document.createElement(tag); e.className = kind; parent?.append(e); return e; };
    this.dom = el("cm-color-picker colorpicker-widget");
    this.dom.setAttribute("data-color-picker", "");
    // Focus stays in the editor (Esc closes via the view's keys, typing goes on into the text).
    this.dom.addEventListener("mousedown", (e) => e.preventDefault());
    // A picker opened by dwelling closes when the pointer leaves it (like the hover widget) — not while dragging; one opened by click stays
    // (VS Code: a `ColorPickerWidget` from the click on the square is "sticky"). The editor's events do not see the picker (they hang on
    // the content), hence here.
    this.dom.addEventListener("mouseenter", () => this.hold());
    this.dom.addEventListener("mouseleave", () => {
      this.hold();
      if (this.view.state.field(pickerField, false)?.source !== "hover") return;
      this.afterTimer = setTimeout(() => { this.afterTimer = null; if (!this.dragging) closeColorPicker(this.view); }, PICKER_HOVER_MS);
    });
    this.header = el("colorpicker-header", this.dom);
    const selected = el("picked-color", this.header);
    selected.title = tr("Click to toggle color options (rgb/hsl/hex)");
    selected.setAttribute("data-color-picker-selected", "");
    selected.append(codiconNode("color-mode", "codicon"));
    this.label = el("picked-color-presentation", selected, "span");
    this.origin = el("original-color", this.header);
    this.origin.setAttribute("data-color-picker-origin", "");
    this.origin.style.backgroundColor = cssColor(original);
    const body = el("colorpicker-body", this.dom);
    this.field = el("saturation-wrap", body);
    this.canvas = el("saturation-box", this.field, "canvas") as HTMLCanvasElement;
    this.ring = el("saturation-selection", this.field);
    this.deckStrip = el("strip opacity-strip", body);
    this.deckHistory = el("overlay", this.deckStrip);
    this.deckSlider = el("slider", this.deckStrip);
    this.toneStrip = el("strip hue-strip", body);
    this.toneSlider = el("slider", this.toneStrip);
    this.field.setAttribute("data-color-picker-field", "");
    this.deckStrip.setAttribute("data-color-picker-opacity", "");
    this.toneStrip.setAttribute("data-color-picker-hue", "");

    selected.addEventListener("mousedown", (e) => e.preventDefault());
    selected.addEventListener("click", () => this.next());
    this.origin.addEventListener("mousedown", (e) => e.preventDefault());
    this.origin.addEventListener("click", () => { this.set(this.original); void this.write(); });
    this.draggable(this.field, (x, y, b, h) => this.set(fromSaturation(this.color, x, y, b, h)));
    this.draggable(this.deckStrip, (_x, y, _b, h) => this.set(fromOpacity(this.color, stripValue(y, h))));
    this.draggable(this.toneStrip, (_x, y, _b, h) => this.set(fromHue(this.color, stripValue(y, h))));
    this.drawHeader();
    OPEN.set(view, this);
    void this.fetchNotations(original, true);
  }

  mount() { this.layout(); }
  destroy() { this.destroyed = true; this.hold(); if (OPEN.get(this.view) === this) OPEN.delete(this.view); }
  /** Is anyone dragging a part (then leaving does not close)? */
  get draggingCurrently(): boolean { return this.dragging; }

  /** Pointer drag like SaturationBox/Strip: press and every move changes, releasing writes (`onColorFlushed`). */
  private draggable(target: HTMLElement, change: (x: number, y: number, width: number, height: number) => void) {
    const at = (e: PointerEvent) => { const r = target.getBoundingClientRect(); change(e.clientX - r.left, e.clientY - r.top, r.width, r.height); };
    target.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragging = true;
      target.classList.add("grabbing");
      try { target.setPointerCapture(e.pointerId); } catch { /* works without capture too */ }
      at(e);
      const move = (m: PointerEvent) => at(m);
      const release = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", release);
        target.removeEventListener("pointercancel", release);
        target.classList.remove("grabbing");
        this.dragging = false;
        void this.write();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", release);
      target.addEventListener("pointercancel", release);
    });
  }

  /** `model.color = …` — equal stays equal (no event); otherwise draw and ask the notations again (only the label). */
  private set(fresh: ColorValue) {
    const toneDifferent = fresh.hsva.h !== this.color.hsva.h;
    if (sameColor(fresh, this.color) && fresh.hsva.h === this.color.hsva.h && fresh.hsva.s === this.color.hsva.s && fresh.hsva.v === this.color.hsva.v) return;
    this.color = fresh;
    if (toneDifferent) this.maleField();
    this.draw();
    void this.fetchNotations(fresh, false);
  }

  private area(): { from: number; to: number } | null {
    const o = this.view.state.field(pickerField, false);
    return o ? { from: o.from, to: o.to } : null;
  }

  /** `updateColorPresentations`: the notations of the colour at the current range; only the latest answer counts. */
  private async fetchNotations(color: ColorValue, guess: boolean): Promise<LspColorNotation[] | null> {
    const d = lspFileOf(this.view.state), b = this.area();
    if (!d || !b) return null;
    const seq = ++this.askSeq;
    const doc = this.view.state.doc;
    let r;
    try { r = await questions(d, "color_presentation", { color: toLsp(color), range: { start: lspPosOf(doc, b.from), end: lspPosOf(doc, b.to) } }); }
    catch { return null; }
    if (this.destroyed || seq !== this.askSeq || isNotSupported(r)) return null;
    this.notations = r.presentations ?? [];
    this.index = indexAfterNewNotations(this.index, this.notations.length);
    if (guess) this.index = rateNotation(this.notations.map((s) => s.label), this.originalText, this.index);
    this.drawHeader();
    return this.notations;
  }

  /** `selectNextColorPresentation` + `flushColor`. */
  private next() {
    if (!this.notations.length) return;
    this.index = nextNotation(this.index, this.notations.length);
    this.drawHeader();
    void this.write();
  }

  /** `onColorFlushed` → `updateColorPresentations` → `updateEditorModel`: the chosen notation into the text, the range moves along. */
  private async write() {
    const seq = ++this.writeSeq;
    const list = await this.fetchNotations(this.color, false);
    const view = this.view, b = this.area();
    if (this.destroyed || seq !== this.writeSeq || !list || !b || !view.dom.isConnected) return;
    const s = list[this.index];
    if (!s) return;
    const doc = view.state.doc;
    const main = s.textEdit
      ? { from: lspOffsetOf(doc, s.textEdit.range.start), to: lspOffsetOf(doc, s.textEdit.range.end), insert: s.textEdit.newText }
      : { from: b.from, to: b.to, insert: s.label };
    const addition = (s.additionalTextEdits ?? []).map((e) => ({ from: lspOffsetOf(doc, e.range.start), to: lspOffsetOf(doc, e.range.end), insert: e.newText }));
    if (view.state.readOnly || (main.insert === doc.sliceString(main.from, main.to) && !addition.length)) return;
    let changes;
    try { changes = view.state.changes([...addition, main]); } catch { return; } // overlapping changes from the server: nothing
    const from = changes.mapPos(main.from, -1), to = changes.mapPos(main.to, 1);
    view.dispatch({ changes, effects: setArea.of({ from, to }), userEvent: PICKER_EVENT, scrollIntoView: false });
  }

  private layout() {
    const r = this.field.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.maleField();
    this.draw();
  }

  /** SaturationBox.paint: base in the full hue, white from the left (1 → 0.5 → 0), black from below. */
  private maleField() {
    const c = this.canvas, ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height;
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, "rgba(255, 255, 255, 1)");
    white.addColorStop(0.5, "rgba(255, 255, 255, 0.5)");
    white.addColorStop(1, "rgba(255, 255, 255, 0)");
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, "rgba(0, 0, 0, 0)");
    black.addColorStop(1, "rgba(0, 0, 0, 1)");
    ctx.rect(0, 0, w, h);
    ctx.fillStyle = saturationBackground(this.color);
    ctx.fill();
    ctx.fillStyle = white;
    ctx.fill();
    ctx.fillStyle = black;
    ctx.fill();
  }

  /** Marks, slider, opacity gradient and the header. */
  private draw() {
    const f = this.field.getBoundingClientRect();
    const m = saturationMarker(this.color, f.width, f.height);
    this.ring.style.left = `${m.left}px`;
    this.ring.style.top = `${m.top}px`;
    const hd = this.deckStrip.getBoundingClientRect().height, ht = this.toneStrip.getBoundingClientRect().height;
    this.deckSlider.style.top = `${sliderTop(opacityValue(this.color), hd)}px`;
    this.toneSlider.style.top = `${sliderTop(hueValue(this.color), ht)}px`;
    this.deckHistory.style.background = opacityHistory(this.color);
    this.drawHeader();
  }

  private drawHeader() {
    const g = this.header.firstElementChild as HTMLElement;
    g.style.backgroundColor = cssColor(this.color);
    const background = this.view.state.facet(EditorView.darkTheme) ? rgba(0x20, 0x20, 0x20) : rgba(0xf8, 0xf8, 0xf8); // --cb-widget-background
    g.classList.toggle("light", headerLight(this.color, background));
    this.label.textContent = this.notations[this.index]?.label ?? "";
    this.dom.setAttribute("data-color-picker-color", cssColor(this.color));
  }
}

/** Click on a square, dwelling over square or colour value, leaving, Esc and a click outside. */
const opener = ViewPlugin.fromClass(class {
  private on: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly view: EditorView) {}
  private stop() { if (this.on) clearTimeout(this.on); if (this.closeTimer) clearTimeout(this.closeTimer); this.on = this.closeTimer = null; }
  private picker(): ColorPicker | null { return OPEN.get(this.view) ?? null; }
  /** The spot under the pointer when it is on a square or on a colour value. */
  place(e: MouseEvent): number | null {
    const t = e.target as HTMLElement | null;
    const q = t?.closest?.(".cm-color-square");
    if (q) { const p = this.view.posAtDOM(q); return p; }
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    if (pos == null) return null;
    const f = colorForPicker(this.view, pos);
    if (!f) return null;
    const a = this.view.coordsAtPos(f.from, 1), b = this.view.coordsAtPos(f.to, -1);
    return a && b && e.clientX >= a.left && e.clientX <= b.right && e.clientY >= a.top && e.clientY <= a.bottom ? pos : null;
  }
  moved(e: MouseEvent) {
    const open = this.view.state.field(pickerField, false);
    if ((e.target as HTMLElement | null)?.closest?.("[data-color-picker]")) { if (this.closeTimer) clearTimeout(this.closeTimer); this.closeTimer = null; return; }
    const pos = this.place(e);
    if (pos != null) {
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      const f = colorAt(this.view.state, pos);
      if (open && f && open.from === f.from) { this.picker()?.hold(); return; } // back on its own colour: stays open
      if (this.on) clearTimeout(this.on);
      this.on = setTimeout(() => { this.on = null; openColorPicker(this.view, pos, "hover"); }, PICKER_HOVER_MS);
      return;
    }
    if (this.on) { clearTimeout(this.on); this.on = null; }
    if (open?.source === "hover" && !this.closeTimer) this.closeTimer = setTimeout(() => { this.closeTimer = null; if (!this.picker()?.draggingCurrently) closeColorPicker(this.view); }, PICKER_HOVER_MS);
  }
  leave(e: MouseEvent) {
    if (this.on) { clearTimeout(this.on); this.on = null; }
    const next = e.relatedTarget as HTMLElement | null;
    if (next?.closest?.("[data-color-picker]")) return;
    if (this.view.state.field(pickerField, false)?.source === "hover" && !this.closeTimer) this.closeTimer = setTimeout(() => { this.closeTimer = null; if (!this.picker()?.draggingCurrently) closeColorPicker(this.view); }, PICKER_HOVER_MS);
  }
  destroy() { this.stop(); }
}, {
  eventHandlers: {
    mousemove(e) { this.moved(e); },
    mouseleave(e) { this.leave(e); },
    mousedown(e) {
      if ((e.target as HTMLElement | null)?.closest?.("[data-color-picker]")) return false;
      const q = (e.target as HTMLElement | null)?.closest?.(".cm-color-square");
      if (q && e.button === 0) {
        const pos = this.view.posAtDOM(q);
        if (openColorPicker(this.view, pos, "click")) { e.preventDefault(); return true; }
      }
      closeColorPicker(this.view);
      return false;
    },
    keydown(e) {
      if (e.key === "Escape" && this.view.state.field(pickerField, false)) { closeColorPicker(this.view); e.preventDefault(); return true; }
      return false;
    },
  },
});


// colorPicker.css (1.143.1) — sizes and colours verbatim; the frame and background come from the tooltip (cbase's hover widget).
const OPACITY_BACKGROUND = "repeating-conic-gradient(rgba(68, 68, 68, 0.098) 0 25%, rgba(187, 187, 187, 0.098) 0 50%) 0 0 / 9px 9px"; // opacity-background.png (4×4, 2×2 squares #444/#bbb, alpha 25)
const theme = EditorView.baseTheme({
  ".cm-tooltip:has(> .cm-color-picker)": { borderRadius: "8px", overflow: "hidden" },
  ".cm-color-picker": { height: "190px", width: "314px", userSelect: "none", WebkitUserSelect: "none" },
  ".cm-color-picker .colorpicker-header": { display: "flex", height: "24px", position: "relative", background: OPACITY_BACKGROUND },
  ".cm-color-picker .picked-color": {
    width: "240px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff", flex: "1",
    whiteSpace: "nowrap", overflow: "hidden", fontSize: textPx(13), fontFamily: "var(--font-sans)",
  },
  ".cm-color-picker .picked-color .picked-color-presentation": { whiteSpace: "nowrap", marginLeft: "5px", marginRight: "5px" },
  ".cm-color-picker .picked-color .codicon": { color: "inherit", width: "14px", height: "14px", flex: "none" },
  ".cm-color-picker .picked-color.light": { color: "#000" },
  ".cm-color-picker .original-color": { width: "74px", zIndex: "inherit", cursor: "pointer" },
  ".cm-color-picker .colorpicker-body": { display: "flex", padding: "8px", position: "relative" },
  ".cm-color-picker .saturation-wrap": { overflow: "hidden", height: "150px", position: "relative", minWidth: "220px", flex: "1" },
  ".cm-color-picker .saturation-box": { height: "150px", position: "absolute", left: "0", top: "0" },
  ".cm-color-picker .saturation-selection": {
    width: "9px", height: "9px", margin: "-5px 0 0 -5px", border: "1px solid rgb(255, 255, 255)", borderRadius: "100%", boxShadow: "0 0 2px #000c",
    position: "absolute", pointerEvents: "none",
  },
  ".cm-color-picker .strip": { width: "25px", height: "150px" },
  ".cm-color-picker .hue-strip": {
    position: "relative", marginLeft: "8px", cursor: "grab",
    background: "linear-gradient(to bottom, red, #ff0 17%, #0f0 33%, #0ff, #00f 67%, #f0f 83%, red)",
  },
  ".cm-color-picker .opacity-strip": { position: "relative", marginLeft: "8px", cursor: "grab", background: OPACITY_BACKGROUND },
  ".cm-color-picker .strip.grabbing": { cursor: "grabbing" },
  ".cm-color-picker .slider": {
    position: "absolute", top: "0", left: "-2px", width: "calc(100% + 4px)", height: "4px", boxSizing: "border-box",
    border: "1px solid rgba(255, 255, 255, .71)", boxShadow: "0 0 1px #000000d9", pointerEvents: "none",
  },
  ".cm-color-picker .strip .overlay": { height: "150px", pointerEvents: "none" },
});

/** The picker with opener and form — in every view with a language (lsp-extension.ts). */
export const colorPicker: Extension = [pickerField, opener, theme];
