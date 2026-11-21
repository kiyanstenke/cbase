// The margins of the Files page's editor that only CodePane attaches (CodePane `buildExtensions`): breakpoints, the paused line and git
// blame. Guard: web/test/editor-look.test.mjs (the order of the margins in CodePane).
import { Decoration, EditorView, gutter, GutterMarker } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { textPx } from "@/lib/appearance";
import type { GitBlameLine } from "@/lib/api";

// Breakpoint gutter: a click toggles a breakpoint on the line; red dots mark it.
const bpMarker = new (class extends GutterMarker { toDOM() { const s = document.createElement("span"); s.className = "cm-bpDot"; return s; } })();
export function breakpointGutter(lines: number[], onToggle: (line: number) => void): Extension {
  const set = new Set(lines);
  return [
    gutter({
      class: "cm-bpGutter",
      lineMarker: (view, block) => (set.has(view.state.doc.lineAt(block.from).number) ? bpMarker : null),
      lineMarkerChange: () => true,
      domEventHandlers: { mousedown: (view, block) => { onToggle(view.state.doc.lineAt(block.from).number); return true; } },
    }),
    EditorView.theme({
      ".cm-bpGutter": { width: "16px", cursor: "pointer" },
      ".cm-bpGutter:hover": { backgroundColor: "rgba(185,28,28,0.06)" },
      ".cm-bpDot": { display: "block", width: "10px", height: "10px", borderRadius: "50%", backgroundColor: "var(--color-danger)", margin: "3px auto" },
    }),
  ];
}
// Highlight of the currently paused line.
export function pausedLineDeco(line: number): Extension {
  return [
    EditorView.decorations.compute([], (state) => {
      if (line < 1 || line > state.doc.lines) return Decoration.none;
      return Decoration.set([Decoration.line({ class: "cm-pausedLine" }).range(state.doc.line(line).from)]);
    }),
    EditorView.theme({ ".cm-pausedLine": { backgroundColor: "rgba(228,180,60,0.28)" } }),
  ];
}

// Blame gutter (GitLens-like): per line author · relative time, tooltip with commit + summary.
class BlameMarker extends GutterMarker {
  constructor(private label: string, private tip: string) { super(); }
  toDOM() { const s = document.createElement("span"); s.textContent = this.label; s.title = this.tip; s.className = "cm-blameEntry"; return s; }
}
export function blameGutter(lines: GitBlameLine[]): Extension {
  return [
    gutter({
      class: "cm-blameGutter",
      lineMarker(view, block) {
        const n = view.state.doc.lineAt(block.from).number;
        const b = lines[n - 1];
        if (!b) return null;
        const author = (b.author || "").split(" ")[0];
        return new BlameMarker(`${author} · ${b.relative}`.slice(0, 22), `${b.sha}  ${b.author}\n${b.summary}`);
      },
      lineMarkerChange: () => true,
    }),
    EditorView.theme({
      ".cm-blameGutter": { minWidth: "150px", backgroundColor: "transparent", borderRight: "1px solid var(--color-edge)" },
      ".cm-blameEntry": { display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "150px", padding: "0 8px", color: "var(--color-dim)", fontSize: textPx(10.5) },
    }),
  ];
}
