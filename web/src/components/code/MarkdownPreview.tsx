"use client";
// The Markdown preview as in VS Code: Shift+Cmd+V on a .md file, Cmd+K V beside it. Drawn with the app's Markdown rendering
// (components/Markdown.tsx, the same as in the chat, not rebuilt; with `preview` its headings carry the mark HEADING_MARKER and the
// blocks their source line `data-line`); images and links are resolved by the context `MarkdownReferenceContext` RELATIVE TO THE FILE
// (lib/md-preview.ts): an image in the project shows as an image (via files/download), a link to a file opens it (a .md file in the
// preview, like VS Code `markdown.preview.openMarkdownLinks: inPreview`; `#L12` jumps to the line), an `#anchor` scrolls to the heading
// with that id (found via the mark, since the rendering draws <div>, not h1–h6, and `anchorIndex`; duplicate headings as in VS Code
// with "-1", "-2"), http(s) opens externally. The text comes from the file's buffer, live, unsaved too (CodePane passes `text` anew
// on every buffer step).
//
// Focus: the surface is focusable (`tabIndex={-1}`) and takes focus when opened with Shift+Cmd+V (`focus`); the editor beneath is then
// `inert` (CodePane), so typing never goes invisibly into it; Cmd+K V leaves focus in the editor (VS Code `preserveFocus`).
// Sync (VS Code `markdown.preview.scrollPreviewWithEditor`/`scrollEditorWithPreview`): on open the preview stands at the line that was
// at the top of the editor (`row`); if the editor of the same file is visible beside it (`editor`), both scroll together via the source
// lines (lib/md-preview.ts `positionForLine`/`lineForPosition`, components/code/md-sync.ts); the echo of the other side is briefly ignored.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { Markdown, MarkdownReferenceContext, HEADING_MARKER, type MarkdownReferences } from "@/components/Markdown";
import { anchorIndex, imagePath, resolveReference, positionForLine, lineForPosition, type RowsBlock } from "@/lib/md-preview";
import { editorRow, setEditorLine } from "@/components/code/md-sync";
import { rememberRole, roleOf } from "@/components/code/view-locations";

type T = (key: string, params?: Record<string, string | number>) => string;

const ECHO_MS = 120;

/** The preview's blocks with their source line, measured relative to the start of the scrolling surface's content. */
export function previewBlocks(surface: HTMLElement): RowsBlock[] {
  const top = surface.getBoundingClientRect().top - surface.scrollTop;
  const out: RowsBlock[] = [];
  for (const el of surface.querySelectorAll<HTMLElement>("[data-line]")) {
    const row = Number(el.dataset.line);
    if (!Number.isFinite(row)) continue;
    const r = el.getBoundingClientRect();
    out.push({ row, top: r.top - top, height: r.height });
  }
  return out;
}

/** The heading an `#anchor` means (via the rendering's mark), or null. */
export function anchorTarget(surface: HTMLElement, anchor: string): HTMLElement | null {
  const headings = [...surface.querySelectorAll<HTMLElement>(`[${HEADING_MARKER}]`)];
  const i = anchorIndex(headings.map((h) => h.textContent || ""), anchor);
  return i >= 0 ? headings[i] : null;
}

export function MarkdownPreview({ t, path, text, imageUrl, onFile, focus = false, row, editor, editorKey = "", jump, scrollKey }: {
  t: T;
  /** The file (relative to the target). */
  path: string;
  /** Its text (the buffer); null: not loaded yet. */
  text: string | null;
  /** The address of an image in the target (files/download, inline). */
  imageUrl: (path: string) => string;
  /** A link to a file in the target. */
  onFile: (path: string, row: number | null, markdown: boolean) => void;
  /** Take focus on open (Shift+Cmd+V; not Cmd+K V). */
  focus?: boolean;
  /** The source line (0-based, fractional) the preview starts at on open. */
  row?: number;
  /** The visible editor of THIS file beside it; then both scroll together. */
  editor?: () => EditorView | null;
  /** Changes when `editor` means another view. */
  editorKey?: string;
  /** Jump to a line while mounted (Cmd+K V on the already mounted preview); every new `seq` once. */
  jump?: { seq: number; row: number };
  /** The scroll state is stored under this key (components/code/view-locations.ts); without a line and without an editor it returns on mount. */
  scrollKey?: string;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const echo = useRef({ preview: 0, editor: 0 }); // until when a scroll of the page is only the echo of our own setting
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const ready = text !== null;

  useEffect(() => { if (focus) surface.current?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On open (and when the preview follows another file): to the editor's line or to `row`.
  const beginning = useRef(row);
  useLayoutEffect(() => {
    const f = surface.current;
    if (!ready || !f) return;
    const v = editorRef.current?.() ?? null;
    const z = v ? editorRow(v) : beginning.current;
    beginning.current = undefined;
    if (z === undefined) { f.scrollTop = (scrollKey ? roleOf(scrollKey)?.top : undefined) ?? 0; return; }
    echo.current.preview = performance.now() + ECHO_MS;
    f.scrollTop = positionForLine(previewBlocks(f), z);
  }, [ready, path]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cmd+K V on the already mounted preview: to the editor's line (VS Code `update(line)`).
  useLayoutEffect(() => {
    const f = surface.current;
    if (!jump || !ready || !f) return;
    echo.current.preview = performance.now() + ECHO_MS;
    f.scrollTop = positionForLine(previewBlocks(f), jump.row);
  }, [jump?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  // The scroll state per tab (on unmount the surface is already gone, so it is stored on every scroll).
  useEffect(() => {
    const f = surface.current;
    if (!f || !scrollKey || !ready) return;
    const remember = () => rememberRole(scrollKey, { top: f.scrollTop });
    f.addEventListener("scroll", remember, { passive: true });
    return () => f.removeEventListener("scroll", remember);
  }, [scrollKey, ready]);

  // Sync with the visible editor beside it.
  useEffect(() => {
    const f = surface.current;
    const v = editorRef.current?.() ?? null;
    if (!ready || !f || !v) return;
    const onEditorScroll = () => {
      if (performance.now() < echo.current.editor) return;
      echo.current.preview = performance.now() + ECHO_MS;
      f.scrollTop = positionForLine(previewBlocks(f), editorRow(v));
    };
    const onPreviewScroll = () => {
      if (performance.now() < echo.current.preview) return;
      const z = lineForPosition(previewBlocks(f), f.scrollTop);
      if (z === null) return;
      echo.current.editor = performance.now() + ECHO_MS;
      setEditorLine(v, z);
    };
    v.scrollDOM.addEventListener("scroll", onEditorScroll, { passive: true });
    f.addEventListener("scroll", onPreviewScroll, { passive: true });
    return () => { v.scrollDOM.removeEventListener("scroll", onEditorScroll); f.removeEventListener("scroll", onPreviewScroll); };
  }, [ready, path, editorKey]);

  const references = useMemo<MarkdownReferences>(() => ({
    image: (src) => { const p = imagePath(path, src); return p ? imageUrl(p) : null; },
    link: (href) => {
      const v = resolveReference(path, href);
      if (v.kind === "extern") return { href: v.href }; // as in the chat: a new window (target _blank)
      if (v.kind === "anchor") return { href: `#${v.id}`, onClick: (e) => {
        e.preventDefault();
        const f = surface.current;
        if (f) anchorTarget(f, v.id)?.scrollIntoView({ block: "start" });
      } };
      if (v.kind === "file") return { href: "#", onClick: (e) => { e.preventDefault(); onFile(v.path, v.row, v.markdown); } };
      return null; // foreign scheme, beyond the root: the rendering's own way (text only)
    },
  }), [path, imageUrl, onFile]);
  return (
    <div ref={surface} tabIndex={-1} className="cb-scroll h-full min-h-0 overflow-auto outline-none" data-md-preview={path}>
      {text === null ? <div className="p-4 text-[13px] text-dim">{t("Loading…##inline")}</div> : (
        <div className="mx-auto max-w-[880px] px-[26px] py-4 text-[14px] leading-relaxed text-fg">
          <MarkdownReferenceContext.Provider value={references}>
            <Markdown src={text} preview />
          </MarkdownReferenceContext.Provider>
        </div>
      )}
    </div>
  );
}
