"use client";

import { ViewPlugin, type EditorView } from "@codemirror/view";
import { listenTextSize } from "@/lib/appearance";

// CodeMirror and the app's text size (lib/appearance.ts). The editor themes' font sizes are given as `textPx(n)` — a CSS
// value with `var(--cb-text-scale)` that takes effect live without rebuilding a theme. What does NOT follow by itself is
// CodeMirror's own measurement (line heights, character width, caret position): so after a change the editor measures once more.
export const textSizeMeasurement = ViewPlugin.fromClass(
  class {
    private off: () => void;
    constructor(view: EditorView) {
      this.off = listenTextSize(() => view.requestMeasure());
    }
    destroy() {
      this.off();
    }
  },
);
