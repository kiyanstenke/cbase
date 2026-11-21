// The shadow at the top of the editor once it is scrolled — like VS Code (scrollDecoration.css, `scrollbar.shadow`; values in
// lib/editor-defaults.ts): 6 px across the whole width of the scroll area without the scrollbar, at its top edge (below the panels above).
// None when unscrolled. A pinned sticky strip lies above it (it has its own shadow).
import { EditorView, ViewPlugin } from "@codemirror/view";
import { SCROLL_SHADOW_HEIGHT, scrollShadowVisible } from "@/lib/editor-defaults";

export const scrollShadow = [
  ViewPlugin.fromClass(class {
    dom: HTMLDivElement;
    listen = () => this.show();
    constructor(readonly view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-scroll-shadow";
      this.dom.setAttribute("aria-hidden", "true");
      view.dom.appendChild(this.dom);
      view.scrollDOM.addEventListener("scroll", this.listen, { passive: true });
      this.show();
    }
    update() { this.show(); }
    show() {
      this.view.requestMeasure({
        key: this,
        read: (v) => ({ on: scrollShadowVisible(v.scrollDOM.scrollTop), top: v.scrollDOM.offsetTop, right: v.scrollDOM.offsetWidth - v.scrollDOM.clientWidth }),
        write: (m) => {
          this.dom.style.display = m.on ? "block" : "none";
          this.dom.style.top = `${m.top}px`;
          this.dom.style.right = `${Math.max(0, m.right)}px`;
        },
      });
    }
    destroy() { this.view.scrollDOM.removeEventListener("scroll", this.listen); this.dom.remove(); }
  }),
  EditorView.baseTheme({
    ".cm-scroll-shadow": {
      position: "absolute", left: "0", height: `${SCROLL_SHADOW_HEIGHT}px`, zIndex: "210", pointerEvents: "none",
      boxShadow: `var(--cb-scroll-shadow, #000000) 0 ${SCROLL_SHADOW_HEIGHT}px ${SCROLL_SHADOW_HEIGHT}px -${SCROLL_SHADOW_HEIGHT}px inset`,
    },
  }),
];
