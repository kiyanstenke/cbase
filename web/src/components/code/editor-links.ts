// Port of: microsoft/vscode src/vs/editor/contrib/links/browser/links.ts (MIT)
// Links in the editor as in VS Code 1.143:
//   - In EVERY file web addresses are links (lib/link-detection.ts, VS Code `LinkComputer` as a provider for all languages) — also without a
//     language service. ⌘ (otherwise Ctrl) over an address underlines it ENTIRELY (also over `/` and `.`), ⌘-click opens it (like a link in
//     the chat: http/https only, in the desktop client via the shell in the browser; `file://` opens nothing).
//   - The normal hover over a link says what ⌘-click does (links.ts `getHoverMessage`): "Follow link (cmd + click)"; with a known address
//     "Follow link" is itself a link; this also holds for a language server's links (`documentLink`, Markdown/CSS — there without an
//     address as long as the link is not resolved: VS Code then shows only the text). Texts are translated like the language pack
//     (vscode-loc `links.navigate.follow`, `links.navigate.kb.meta.mac`).
// A language server's links are underlined and opened by cmd-hover.ts / lsp-navigation.ts (they ask `link` at the position); over a
// recognised address both step back (`addressAt`).
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, hoverTooltip } from "@codemirror/view";
import { isNotSupported, lspOffsetOf, lspPosOf } from "@/lib/api";
import { linkAtPlace } from "@/lib/link-detection";
import { linkWay } from "@/lib/link-follow-ups";
import { modPressed } from "@/lib/cmd-link";
import { isMac } from "@/lib/chat-bar";
import { tr } from "@/lib/i18n";
import { questions, can, lspFileOf } from "@/components/code/lsp-core";

/** The recognised web address that contains the character at `pos` (range in the document) — only if ⌘-click follows it (http/https). */
export function addressAt(state: EditorState, pos: number): { from: number; to: number; url: string } | null {
  if (pos < 0 || pos > state.doc.length) return null;
  const z = state.doc.lineAt(pos);
  const l = linkAtPlace(z.text, pos - z.from);
  if (!l || !linkWay({ kind: "web", url: l.url })) return null;
  return { from: z.from + l.from, to: z.from + l.to, url: l.url };
}

/** The character under the pointer (not to the right of the line end). */
export function characterUnderPointer(view: EditorView, x: number, y: number): number | null {
  const pos = view.posAtCoords({ x, y }, false);
  if (pos == null) return null;
  const z = view.state.doc.lineAt(pos);
  for (const p of [pos, pos - 1]) {
    if (p < z.from || p >= z.to) continue;
    const a = view.coordsAtPos(p, 1), b = view.coordsAtPos(p + 1, -1);
    if (a && b && x >= a.left && x <= b.right && y >= a.top && y <= a.bottom) return p;
  }
  return null;
}

/** links.ts `getHoverMessage` (with ⌘ as the key): "Follow link" + " (cmd + click)" — with an address as a link. */
export function linkHintNode(url: string | null): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover cm-link-hint";
  const a = document.createElement("div");
  a.className = "cm-hover-section cm-hover-text";
  const followUps = tr("Follow link"), key = isMac() ? tr("cmd + click") : tr("ctrl + click");
  if (url) {
    const l = document.createElement("a");
    l.href = url;
    l.target = "_blank";
    l.rel = "noopener noreferrer";
    l.textContent = followUps;
    l.setAttribute("data-link-hint-target", url);
    a.append(l, ` (${key})`);
  } else a.textContent = `${followUps} (${key})`;
  dom.append(a);
  return dom;
}

/** The hover over a link: a recognised address at once, otherwise a language-server link (`link` at the position). */
const hint = hoverTooltip(async (view, pos, side) => {
  const p = side < 0 ? pos - 1 : pos;
  const a = addressAt(view.state, p);
  if (a) return { pos: a.from, end: a.to, above: true, create: () => ({ dom: linkHintNode(a.url) }) };
  const d = lspFileOf(view.state);
  if (!can(d, "document_link")) return null;
  const doc = view.state.doc;
  let r;
  try { r = await questions(d, "link", { position: lspPosOf(doc, p) }); } catch { return null; }
  if (isNotSupported(r) || !r.link || view.state.doc !== doc) return null;
  const way = linkWay(r.link.target);
  if (!way) return null;
  const from = lspOffsetOf(doc, r.link.range.start), to = lspOffsetOf(doc, r.link.range.end);
  return { pos: from, end: Math.max(from, to), above: true, create: () => ({ dom: linkHintNode(way.kind === "web" ? way.url : null) }) };
}, { hoverTime: 300 });

// ⌘ over a recognised address: underlined (entirely), ⌘-click opens.
const set = StateEffect.define<{ from: number; to: number } | null>();
const ACTIVE = Decoration.mark({ class: "cm-link-active" });
const activeField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(v, t) {
    for (const e of t.effects) if (e.is(set)) return e.value;
    return v && t.docChanged ? null : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v ? Decoration.set([ACTIVE.range(v.from, v.to)]) : Decoration.none)),
});

const pointer = ViewPlugin.fromClass(class {
  private mouse: { x: number; y: number } | null = null;
  private mod = false;
  private readonly release = (e: KeyboardEvent) => { if (e.key === (isMac() ? "Meta" : "Control")) { this.mod = false; this.check(); } };
  private readonly onBlur = () => { this.mod = false; this.check(); };
  constructor(readonly view: EditorView) {
    window.addEventListener("keyup", this.release, true);
    window.addEventListener("blur", this.onBlur);
  }
  moved(e: MouseEvent) { this.mouse = { x: e.clientX, y: e.clientY }; this.mod = modPressed(e, isMac()); this.check(); }
  key(e: KeyboardEvent) {
    const on = e.key === (isMac() ? "Meta" : "Control") && !e.altKey && !e.shiftKey;
    if (on !== this.mod) { this.mod = on; this.check(); }
  }
  leave() { this.mouse = null; this.check(); }
  check() {
    const v = this.view, m = this.mouse;
    const p = this.mod && m && v.dom.isConnected ? characterUnderPointer(v, m.x, m.y) : null;
    const a = p == null ? null : addressAt(v.state, p);
    const now = v.state.field(activeField, false) ?? null;
    if ((a?.from ?? -1) === (now?.from ?? -1) && (a?.to ?? -1) === (now?.to ?? -1)) return;
    v.dispatch({ effects: set.of(a ? { from: a.from, to: a.to } : null) });
  }
  destroy() { window.removeEventListener("keyup", this.release, true); window.removeEventListener("blur", this.onBlur); }
}, {
  eventHandlers: {
    mousemove(e) { this.moved(e); },
    mouseleave() { this.leave(); },
    keydown(e) { this.key(e); },
    mousedown(e, view) {
      if (e.button !== 0 || e.altKey || e.shiftKey || !(isMac() ? e.metaKey : e.ctrlKey)) return false;
      const p = characterUnderPointer(view, e.clientX, e.clientY);
      const a = p == null ? null : addressAt(view.state, p);
      if (!a) return false;
      e.preventDefault();
      window.open(a.url, "_blank", "noopener,noreferrer"); // in the desktop client the shell hands it to the browser (like a link in the chat)
      return true;
    },
  },
});

/** For every view with a buffer (lsp-extension.ts, also without a language): hint, underline, ⌘-click. */
export const editorLinks: Extension = [
  Prec.high(hint), activeField, Prec.highest(pointer),
  EditorView.baseTheme({
    ".cm-link-active": { color: "var(--cb-link-active)", textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer" },
    ".cm-link-active *": { color: "var(--cb-link-active)" },
    ".cm-link-hint a": { color: "var(--cb-link, var(--color-accent))" },
  }),
];
