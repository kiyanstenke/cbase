// The markdown preview as in VS Code — the PURE calculations. Drawn in components/code/MarkdownPreview.tsx with the app's markdown
// rendering (components/Markdown.tsx, via `MarkdownReferenceContext`).
//
//   isMarkdown      whether a path is a markdown file (the extensions of the language "markdown" in VS Code, extensions/markdown-basics).
//   previewTitle     the tab title: "Preview README.md" (VS Code "Preview README.md"), locked "[Preview] README.md".
//   isPreviewKey     ⇧⌘V on the Mac, Ctrl+⇧+V otherwise (VS Code `markdown.showPreview`) — never with ⌥ or the respective other key.
//   resolveReference a reference of the file, resolved relative to IT as in VS Code: http(s)/mailto outward, `#anchor` in the preview, a
//                    path (with `/` from the root of the target, otherwise from the file's folder) as a file including the line from `#L12`.
//                    What leads beyond the root, a foreign scheme (`file:`, `smb:` — a program launch) and a badly encoded path are NOT a
//                    reference (text only), never a guess.
//   imagePath        an image of the file: only a path in the target (the same resolution) — only what lies in the project is loaded;
//                    `data:image` is passed through by the rendering itself, an image from outside stays a reference as in the chat
//                    (nothing foreign loaded).
//   anchorSlug       the id of a heading as in VS Code (`githubSlugifier`): lower case, whitespace → "-", punctuation dropped.
//   anchorIds /      the ids of ALL headings in order as in VS Code (`githubSlugifier.createBuilder`: a duplicate gets "-1", "-2" …) and
//   anchorIndex      which one an `#anchor` means. Searched via the marker of the rendering (components/Markdown.tsx `HEADING_MARKER` —
//                    it draws headings as <div>, not as h1–h6).
//   positionForLine / lineForPosition
//                    the sync of editor and preview as in VS Code (`markdown.preview.scrollPreviewWithEditor` /
//                    `scrollEditorWithPreview`, preview-src/scroll-sync.ts): over the source lines of the blocks (`data-line`), between two
//                    blocks proportionally, within a block by its fraction.
// Guard: web/test/md-preview.test.mjs (with counter-proofs), web/test/markdown.test.mjs (the markers in the rendered HTML).

export const MARKDOWN_SUFFIXES = [".md", ".mkd", ".mdwn", ".mdown", ".markdown", ".markdn", ".mdtxt", ".mdtext", ".workbook"] as const;

export function isMarkdown(path: string | null | undefined): boolean {
  if (!path) return false;
  const p = path.toLowerCase();
  return MARKDOWN_SUFFIXES.some((e) => p.endsWith(e) && p.length > e.length && !p.endsWith(`/${e}`));
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The title of the preview tab (UI key with value): "Preview {name}", locked "[Preview] {name}" (VS Code "[Preview] …"). */
export function previewTitle(path: string, locked = false): { key: "Preview {name}" | "[Preview] {name}"; values: { name: string } } {
  return { key: locked ? "[Preview] {name}" : "Preview {name}", values: { name: nameOf(path) } };
}

/** ⇧⌘V (Mac) or Ctrl+⇧+V. */
export function isPreviewKey(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): boolean {
  const v = e.code === "KeyV" || e.key.toLowerCase() === "v";
  if (!v || !e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export type Reference =
  | { kind: "extern"; href: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string; row: number | null; markdown: boolean }
  | { kind: "none" };

/** A path (without `#`/`?`) relative to `folder` in the target — normalized, or null (beyond the root, badly encoded, empty). */
function inTarget(folder: string, raw: string): string | null {
  let part: string;
  try { part = decodeURI(raw); } catch { return null; }
  const base = part.startsWith("/") ? [] : folder.split("/").filter(Boolean);
  const out = [...base];
  for (const s of part.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(s);
  }
  return out.length ? out.join("/") : null;
}

const folderOf = (file: string) => { const i = file.lastIndexOf("/"); return i > 0 ? file.slice(0, i) : ""; };
const SCHEMA = /^[a-z][a-z0-9+.-]*:/i;

/** A reference of the file `file` (relative to the target), resolved as in VS Code. */
export function resolveReference(file: string, href: string): Reference {
  const h = href.trim();
  if (!h) return { kind: "none" };
  if (/^(https?:|mailto:)/i.test(h)) return { kind: "extern", href: h };
  if (h.startsWith("#")) {
    let id: string;
    try { id = decodeURIComponent(h.slice(1)); } catch { return { kind: "none" }; }
    return id ? { kind: "anchor", id } : { kind: "none" };
  }
  if (SCHEMA.test(h) || h.startsWith("//")) return { kind: "none" }; // foreign scheme or a foreign host
  const hash = h.indexOf("#");
  const withoutHash = hash >= 0 ? h.slice(0, hash) : h;
  const question = withoutHash.indexOf("?");
  const raw = question >= 0 ? withoutHash.slice(0, question) : withoutHash;
  const path = inTarget(folderOf(file), raw);
  if (path === null) return { kind: "none" };
  const m = hash >= 0 ? /^L(\d+)/i.exec(h.slice(hash + 1)) : null;
  const row = m ? Math.max(1, Number(m[1])) : null;
  return { kind: "file", path, row, markdown: isMarkdown(path) };
}

/** The image `src` of the file as a path in the target — or null (from outside, foreign scheme, beyond the root). */
export function imagePath(file: string, src: string): string | null {
  const v = resolveReference(file, src);
  return v.kind === "file" ? v.path : null;
}

/** The ids of all headings (texts in order) like VS Code `githubSlugifier.createBuilder`: the first of its name like `anchorSlug`, every
 *  further one with "-1", "-2" … appended. */
export function anchorIds(headings: readonly string[]): string[] {
  const counter = new Map<string, number>();
  return headings.map((h) => {
    const slug = anchorSlug(h);
    const n = counter.get(slug);
    if (n === undefined) { counter.set(slug, 0); return slug; }
    counter.set(slug, n + 1);
    return anchorSlug(`${slug}-${n + 1}`);
  });
}
/** Which heading an `#anchor` means (index) — or -1. */
export function anchorIndex(headings: readonly string[], anchor: string): number {
  return anchorIds(headings).indexOf(anchorSlug(anchor));
}

/** A block of the preview: its source line (0-based, `data-line`) and where it stands (relative to the start of the content). */
export type RowsBlock = { row: number; top: number; height: number };

/** Where the preview scrolls so that the source line `row` (0-based, fractional) stands at the top (VS Code `scrollToRevealSourceLine`). */
export function positionForLine(blocks: readonly RowsBlock[], row: number): number {
  if (!blocks.length || row <= 0) return 0;
  const whole = Math.floor(row);
  let prior = blocks[0];
  let next: RowsBlock | null = null;
  for (const b of blocks) {
    if (b.row === whole) { prior = b; next = null; break; }
    if (b.row > whole) { next = b; break; }
    prior = b;
  }
  // Between two blocks: proportionally over the GAP from the end of the previous one to the start of the next (VS Code:
  // `previousEnd + betweenProgress * betweenHeight`); within a block: its fraction.
  if (next && next.row !== prior.row) {
    const end = prior.top + prior.height;
    return end + ((row - prior.row) / (next.row - prior.row)) * (next.top - end);
  }
  return prior.top + prior.height * (row - Math.floor(row));
}

/** Which source line (fractional) stands at the top when the preview is at `y` (VS Code `getEditorLineNumberForPageOffset`); null: no blocks. */
export function lineForPosition(blocks: readonly RowsBlock[], y: number): number | null {
  if (!blocks.length) return null;
  let i = blocks.findIndex((b) => b.top + b.height > y);
  if (i < 0) i = blocks.length - 1;
  const b = blocks[i];
  if (b.top > y) {
    if (i === 0) return b.row;
    const v = blocks[i - 1];
    return v.row + ((y - v.top) / Math.max(1, b.top - v.top)) * (b.row - v.row);
  }
  const n = blocks[i + 1];
  if (n) return b.row + ((y - b.top) / Math.max(1, n.top - b.top)) * (n.row - b.row);
  return b.row + Math.min(1, (y - b.top) / Math.max(1, b.height));
}

/** The id of a heading (VS Code `githubSlugifier`). */
export function anchorSlug(text: string): string {
  return text.trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[\][!'#$%&()*+,./:;<=>?@\\^{|}~`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝"]/g, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
