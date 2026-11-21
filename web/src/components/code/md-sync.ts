// Editor and Markdown preview scroll in sync like VS Code (`markdown.preview.scrollPreviewWithEditor` / `scrollEditorWithPreview`) — the
// EditorView side: which source line is at the top (fractional, 0-based) and how the editor scrolls so that a line is at the top. The
// preview side is computed by lib/md-preview.ts (`positionForLine`, `lineForPosition`) over the source lines of the blocks (`data-line`,
// components/Markdown.tsx). Wired in components/code/MarkdownPreview.tsx.
import type { EditorView } from "@codemirror/view";

/** The source line (0-based, fractional) at the top edge of the editor. */
export function editorRow(view: EditorView): number {
  const height = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top);
  const block = view.lineBlockAtHeight(height);
  const row = view.state.doc.lineAt(block.from).number - 1;
  return row + (block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0);
}

/** Scrolls the editor so that source line `row` (0-based, fractional) is at the top. */
export function setEditorLine(view: EditorView, row: number): void {
  const n = Math.max(0, Math.min(view.state.doc.lines - 1, Math.floor(row)));
  const block = view.lineBlockAt(view.state.doc.line(n + 1).from);
  view.scrollDOM.scrollTop = block.top + (row - n) * block.height + view.documentPadding.top;
}
