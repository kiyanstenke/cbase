// Port of: microsoft/vscode src/vs/base/common/htmlContent.ts (MIT)
// The sections of a hover — pure, without DOM: the markdown of the language service (server/backend/…/lsp/actions.js `markdownOf` joins the
// parts with blank lines) into sections that the widget separates with hairlines, like the VS Code hover widget: a rule (`---`, `***`,
// `___`) begins a new section, and so does text after a section consisting only of code blocks (the signature) — so the docs stand under
// a line even if the server sends no rule (typescript-language-server). Code blocks (``` and ~~~) come out with their language; they
// are colored with the editor's syntax highlighting (components/code/lsp-markdown.tsx), text goes through the chat's markdown.
//
// Tested EXECUTED in web/test/editor-look.test.mjs (with sabotage).

export type HoverPart = { kind: "code"; language: string; text: string } | { kind: "text"; text: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const SEPARATOR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'", nbsp: "\u00a0" };
/** What VS Code shows as a character in the markdown of a language server but the chat's markdown (components/Markdown.tsx) shows raw —
 *  outside code spans (`…`, where everything is literal): character references (CommonMark: `&lt;`, `&#60;`, `&#x3C;`) and backslash
 *  escapes (`\-`, `\.`, `\(` …) — except before the characters the chat's markdown interprets itself (asterisk, underscore, backtick,
 *  square brackets, hash, dash, tilde, backslash: those stay escaped). The CSS server sends "Syntax: &lt;line\-width&gt;" (hover and docs
 *  of a suggestion). */
const MASK = /\\([!"$%'()+,\-./:;=?@^{}])/g;
export function lspMarkdownText(text: string): string {
  return String(text ?? "").split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part
    .replace(MASK, "$1")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, n: string) => {
      if (n[0] === "#") { const c = n[1] === "x" || n[1] === "X" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : whole; }
      return ENTITIES[n.toLowerCase()] ?? whole;
    }))).join("");
}

export function hoverSections(md: string): HoverPart[][] {
  const rows = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections: HoverPart[][] = [[]];
  const now = () => sections[sections.length - 1];
  let text: string[] = [];
  const textTo = () => {
    const t = text.join("\n").trim();
    if (t) now().push({ kind: "text", text: lspMarkdownText(t) });
    text = [];
  };
  const fresh = () => { textTo(); if (now().length) sections.push([]); };
  for (let i = 0; i < rows.length; i++) {
    const z = rows[i];
    const f = FENCE.exec(z);
    if (f) {
      textTo();
      const character = f[1][0], length = f[1].length, body: string[] = [];
      let j = i + 1;
      for (; j < rows.length; j++) {
        const s = rows[j].trim();
        if (s.length >= length && [...s].every((c) => c === character)) break;
        body.push(rows[j]);
      }
      i = j;
      now().push({ kind: "code", language: f[2].toLowerCase(), text: body.join("\n").replace(/\n+$/, "") });
      continue;
    }
    if (SEPARATOR.test(z)) { fresh(); continue; }
    if (z.trim() && !text.some((x) => x.trim()) && now().length && now().every((t) => t.kind === "code")) { text = []; sections.push([]); }
    text.push(z);
  }
  textTo();
  return sections.filter((a) => a.length);
}

/** An image in the markdown of a language server: VS Code shows images in the hover — the CSS server sends its "Baseline" mark that way
 *  (`![Baseline icon](data:image/svg+xml;base64,…)`, vscode-css-languageservice `getEntryBaselineImage`). As in VS Code 1.143
 *  (`src/vs/base/browser/markdownRenderer.ts`): the renderer allows as image source `http, https, data, file, vscode-file,
 *  vscode-remote, vscode-remote-resource` (`allowedMediaProtocols`), a per-source checker (`remoteImageIsAllowed`) hangs ONLY on the
 *  chat — the editor hover therefore loads every image; the window's CSP (`src/vs/code/electron-browser/workbench/workbench.html`)
 *  allows `img-src 'self' data: blob: … https:`, not http. Here likewise: `data:` with an image type and `https:` (without credentials in
 *  the address); the `<img>` sends no referrer (components/Markdown.tsx). An SVG as `<img>` runs no script. VS Code's dimension suffix
 *  after `|` (`![](image.png|width=16,height=16)`) is split off — the dimensions are delivered by `hoverImageDimensions`. Anything else ⇒
 *  null (the markdown then shows only the text). */
const IMAGE_DATA = /^data:image\/(png|gif|jpe?g|webp|svg\+xml)(;[a-z0-9=.+-]+)*(;base64)?,/i;
export function hoverImageTarget(src: string): string | null {
  const s = String(src ?? "").split("|")[0];
  if (/\s/.test(s)) return null;
  if (IMAGE_DATA.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
}
/** The dimensions of an image like VS Code `parseHrefAndDimensions` (base/common/htmlContent.ts): after `|` come `width=<number>` and/or
 *  `height=<number>` — they become attributes of the `<img>`; without them the natural size. */
export function hoverImageDimensions(src: string): { width?: number; height?: number } {
  const p = String(src ?? "").split("|").map((t) => t.trim())[1];
  if (!p) return {};
  const b = /width=(\d+)/.exec(p), h = /height=(\d+)/.exec(p);
  return { ...(b ? { width: Number(b[1]) } : {}), ...(h ? { height: Number(h[1]) } : {}) };
}
