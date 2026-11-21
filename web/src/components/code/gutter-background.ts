// The opaque background under the editor and the opaque gutter.
//
// The editor is transparent (codeTheme.ts: it lies on its group's surface). The gutter on the left (line numbers, fold and git margin) sits
// in CodeMirror `position: sticky` at the left edge of the scroll area — transparent, horizontally scrolled text ran VISIBLY through the
// numbers. In VS Code the margin covers: `editorGutter.background` is by default `editor.background`
// (`src/vs/editor/common/core/editorColorRegistry.ts`), the text scrolls under it. The gutter therefore takes the first opaque background
// under the editor — the same computation as the sticky-scroll strip (sticky-scroll.ts), ONCE here.
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

/** The opacity of a computed colour ("rgb(…)", "rgba(…, a)", "color(srgb … / a)"). */
export function opacity(c: string): number {
  if (!c || c === "transparent") return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)\s*$/.exec(c);
  if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
  const rgba = /^rgba\(([^)]+)\)$/.exec(c);
  return rgba ? Number(rgba[1].split(",")[3] ?? 1) : 1;
}
/** The first opaque background under an element (the editor is transparent) — otherwise the surface's colour. */
export function backgroundUnder(el: HTMLElement | null): string {
  for (let e = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (opacity(c) > 0.98) return c;
  }
  return "var(--color-panel)";
}

/** The gutter covers: measured on mounting, on every change of the measures (a group moves, the surface changes) and on reconfiguring
 *  (theme light/dark). Written only when the colour changes. */
export const gutterCovers = ViewPlugin.fromClass(class {
  background = "";
  constructor(readonly view: EditorView) { this.measure(); }
  update(u: ViewUpdate) {
    if (u.geometryChanged || u.transactions.some((tr) => tr.reconfigured)) this.measure();
  }
  measure() {
    this.view.requestMeasure({
      key: this,
      read: (v) => backgroundUnder(v.dom.parentElement),
      write: (background, v) => {
        const gutter = v.dom.querySelector<HTMLElement>(".cm-gutters");
        if (!gutter || (background === this.background && gutter.style.backgroundColor)) return;
        this.background = background;
        gutter.style.backgroundColor = background;
      },
    });
  }
});
