// ⌘-hover — the "Go to Definition" link as in VS Code. While ⌘ (otherwise Ctrl) is held and the pointer is over an identifier the language
// service knows a definition for, the identifier is underlined (link colour `editorLink.activeForeground`, hand cursor), and after a short
// time the PREVIEW of the definition appears: the source lines at the target (lib/definition-preview.ts — the range, otherwise up to the
// end of the block, at most 8 lines, dedented) in the syntax colours of the target language (code-colorize.ts); with several targets only
// "Click to show n definitions." (VS Code). ⌘-click jumps (lsp-navigation.ts `maus`). Releasing ⌘, another key, the pointer leaving or
// typing removes underline and preview. Without a language service or without a definition: nothing (no dead link) — except on a LINK:
// then, as in VS Code, the whole link is underlined (the server's range from `link`, no preview) and ⌘-click follows it (lsp-navigation.ts).
//
// ⌘ counts, as in VS Code, only in THIS view: as a key only when focus is in it (keydown on its DOM — a ⌘V in the chat while the pointer
// is over the code does nothing), and with the mouse via the move event that carries the modifier. Release and window switch are heard by
// ONE shared window listener for all views (diff left/right, peek): keyup, and `blur` of the window itself only (in the capture phase the
// blur events of every element would come along).
//
// NO AVALANCHE: a question is asked only once the pointer rests briefly on a word (DEBOUNCE_MS); a running question is aborted as soon as
// the pointer leaves the word (AbortController up to the server call). Only non-empty answers are remembered, and only briefly
// (lib/cmd-link.ts `LocationsStorage`); an answer applies only while question and text are the same (`responseApplies`). The lines at the
// target are read by `rowLoader` (lsp-nav-core.ts) on every show: open buffer first, otherwise from disk, an external target via `read` with
// the token, like peek.
//
// FAST (the question travels via gateway and container): (1) an identifier according to the syntax tree (`looksLikeTarget`) is underlined
// at once and freed again if no definition comes; (2) if the pointer rests on a word WITHOUT ⌘ (UPFRONT_MS), its definition is already
// fetched — ⌘ then finds it in memory or attaches to the running question.
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, closeHoverTooltips, showTooltip, type Tooltip } from "@codemirror/view";
import { isNotSupported, lspOffsetOf, lspPosOf, type LspLocation } from "@/lib/api";
import { linkWay } from "@/lib/link-follow-ups";
import { definitionsPreview } from "@/lib/definition-preview";
import { LocationsStorage, responseApplies, modPressed, looksLikeTarget } from "@/lib/cmd-link";
import { isMac } from "@/lib/chat-bar";
import { tr } from "@/lib/i18n";
import { questions, can, lspFileOf, type LspFile } from "@/components/code/lsp-core";
import { rowLoader } from "@/components/code/lsp-nav-core";
import { addressAt, characterUnderPointer } from "@/components/code/editor-links";
import { colorize, appendTo, languageForFile } from "@/components/code/code-colorize";

/** How long the pointer rests on a word before a question is asked — and how long after that until the preview appears. */
const DEBOUNCE_MS = 80;
const PREVIEW_MS = 300;
/** How long the pointer rests on a word WITHOUT ⌘ before its definition is fetched up front. */
const UPFRONT_MS = 150;

type Link = { from: number; to: number; tooltip: Tooltip | null };
const setLink = StateEffect.define<Link | null>();
const LINK = Decoration.mark({ class: "cm-cmd-link" });
const linkField = StateField.define<Link | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value;
    return v && tr.docChanged ? null : v;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => (v ? Decoration.set([LINK.range(v.from, v.to)]) : Decoration.none)),
    showTooltip.from(f, (v) => v?.tooltip ?? null),
  ],
});

type Language = Parameters<typeof colorize>[2];
/** The preview as nodes: the lines coloured — with several targets only the hint (VS Code). Tabs at the editor's tab width. */
function previewNode(view: EditorView, rows: string[] | null, language: Language, count: number): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover cm-cmd-preview";
  dom.style.tabSize = String(view.state.tabSize);
  const section = document.createElement("div");
  if (count > 1 || !rows) {
    section.className = "cm-hover-section cm-cmd-more";
    section.textContent = tr("Click to show {n} definitions.", { n: count });
  } else {
    section.className = "cm-hover-section";
    const pre = document.createElement("pre");
    pre.className = "cm-hover-code";
    const code = document.createElement("code");
    appendTo(code, colorize(view.state, rows.join("\n"), language));
    pre.append(code);
    section.append(pre);
  }
  dom.append(section);
  return dom;
}

const modKey = () => (isMac() ? "Meta" : "Control");

// ONE window listener for all views: ⌘ released (wherever focus is) or the window lost.
const views = new Set<CmdHover>();
const released = (e: KeyboardEvent) => { for (const a of views) a.released(e); };
const windowWay = (e: FocusEvent) => { if (e.target === window) for (const a of views) a.lost(); };
function report(a: CmdHover, on: boolean) {
  if (typeof window === "undefined") return;
  const prior = views.size;
  if (on) views.add(a);
  else views.delete(a);
  if (!prior && views.size) { window.addEventListener("keyup", released, true); window.addEventListener("blur", windowWay); }
  if (prior && !views.size) { window.removeEventListener("keyup", released, true); window.removeEventListener("blur", windowWay); }
}

class CmdHover {
  /** ⌘ (otherwise Ctrl) held, without ⌥/⇧. */
  mod = false;
  private mouse: { x: number; y: number } | null = null;
  /** The word currently asked about or shown. */
  private word: { from: number; to: number } | null = null;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private readonly locations = new LocationsStorage<LspLocation>();
  /** Running up-front questions per word — ⌘ attaches instead of asking a second time. */
  private readonly running = new Map<string, Promise<readonly LspLocation[]>>();
  private upfrontTimer: ReturnType<typeof setTimeout> | null = null;
  private upfrontAbort: AbortController | null = null;
  private readonly off: (() => void)[] = [];

  constructor(readonly view: EditorView) {
    const onEditor = <K extends keyof HTMLElementEventMap>(kind: K, f: (e: HTMLElementEventMap[K]) => void) => {
      view.dom.addEventListener(kind, f);
      this.off.push(() => view.dom.removeEventListener(kind, f));
    };
    onEditor("keydown", (e) => this.key(e));
    onEditor("mousemove", (e) => {
      if ((e.target as Element | null)?.closest?.(".cm-cmd-preview")) return; // everything stays put over the preview
      this.mouse = { x: e.clientX, y: e.clientY };
      this.mod = modPressed(e, isMac());
      if (!this.mod) this.upfrontSchedule();
      this.check();
    });
    onEditor("mouseleave", () => { this.mouse = null; this.upfrontStop(); this.clear(); });
    onEditor("mousedown", () => { this.clear(); });
    const roles = () => this.check();
    view.scrollDOM.addEventListener("scroll", roles, { passive: true });
    this.off.push(() => view.scrollDOM.removeEventListener("scroll", roles));
    report(this, true);
  }

  update(u: { docChanged: boolean }) {
    if (!u.docChanged) return;
    // Typed: the field clears underline and preview itself (no dispatch in the middle of an update), here only asking and remembering.
    this.locations.empty();
    this.upfrontStop();
    this.cancel();
    this.word = null;
  }
  destroy() {
    report(this, false);
    this.upfrontStop();
    this.cancel();
    for (const f of this.off) f();
  }

  /** keydown in the editor: ⌘ alone switches the link on; another key with ⌘ (⌘S, ⌘Z …) removes it until the mouse moves. */
  private key(e: KeyboardEvent) {
    if (e.key === modKey()) {
      const mod = !e.altKey && !e.shiftKey;
      if (mod !== this.mod) { this.mod = mod; this.check(); }
      return;
    }
    if (this.mod) { this.mod = false; this.clear(); }
  }
  released(e: KeyboardEvent) {
    if (e.key === modKey() && this.mod) { this.mod = false; this.clear(); }
  }
  lost() {
    this.mod = false;
    this.clear();
  }

  /** Fetch up front as soon as the pointer rests briefly without ⌘ — every movement postpones it. */
  private upfrontSchedule() {
    if (this.upfrontTimer) clearTimeout(this.upfrontTimer);
    this.upfrontTimer = setTimeout(() => { this.upfrontTimer = null; this.upfront(); }, UPFRONT_MS);
  }
  private upfrontStop() {
    if (this.upfrontTimer) clearTimeout(this.upfrontTimer);
    this.upfrontTimer = null;
    this.upfrontAbort?.abort();
    this.upfrontAbort = null;
    this.running.clear();
  }
  private upfront() {
    const view = this.view, d = lspFileOf(view.state);
    if (this.mod || !d || !can(d, "definition") || !view.dom.isConnected) return;
    const w = this.wordUnderPointer();
    if (!w) return;
    const k = `${w.from}:${w.to}`;
    if (this.locations.fetch(k, Date.now()) || this.running.has(k)) return;
    this.upfrontAbort?.abort(); // at most ONE up-front question: the old word has been left
    this.running.clear();
    const abort = new AbortController();
    this.upfrontAbort = abort;
    const doc = view.state.doc;
    const question: Promise<readonly LspLocation[]> = questions(d, "definition", { position: lspPosOf(doc, w.from) }, abort.signal)
      .then((r) => {
        const locations = isNotSupported(r) ? [] : r.locations ?? [];
        if (!abort.signal.aborted && view.state.doc === doc) this.locations.remember(k, locations, Date.now());
        return locations;
      })
      .catch(() => [])
      .finally(() => {
        if (this.running.get(k) === question) this.running.delete(k);
        if (this.upfrontAbort === abort) this.upfrontAbort = null;
      });
    this.running.set(k, question);
  }

  /** Is the word an identifier according to the syntax tree? Then the underline may appear before the answer. */
  private identifier(w: { from: number; to: number }): boolean {
    const n = syntaxTree(this.view.state).resolveInner(w.from, 1);
    return n.from <= w.from && n.to >= w.to && looksLikeTarget(n.name);
  }

  private cancel() {
    this.seq += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
  }
  private clear() {
    this.cancel();
    this.word = null;
    this.isLink = false;
    if (this.view.state.field(linkField, false)) this.view.dispatch({ effects: setLink.of(null) });
  }

  /** The word under the pointer — only if the pointer really is on it (not to the right of the line end). */
  private wordUnderPointer(): { from: number; to: number } | null {
    const view = this.view, m = this.mouse;
    if (!m) return null;
    const pos = view.posAtCoords(m);
    if (pos == null) return null;
    const w = view.state.wordAt(pos);
    if (!w) return null;
    const a = view.coordsAtPos(w.from, 1), b = view.coordsAtPos(w.to, -1);
    if (!a || !b || m.x < a.left || m.x > b.right || m.y < a.top || m.y > a.bottom) return null;
    return { from: w.from, to: w.to };
  }

  private check() {
    const view = this.view;
    const d = lspFileOf(view.state);
    const on = this.mod && view.dom.isConnected && (can(d, "definition") || can(d, "document_link"));
    // Over a recognised web address editor-links.ts applies (fully underlined, ⌘-click opens) — nothing here.
    const character = on && this.mouse ? characterUnderPointer(view, this.mouse.x, this.mouse.y) : null;
    if (character != null && addressAt(view.state, character)) { if (this.word || view.state.field(linkField, false)) this.clear(); return; }
    // Without a word under the pointer (the `/` or `.` of a path) the character counts — there is only the link, no definition.
    const word = on ? this.wordUnderPointer() : null;
    const w = word ?? (on && character != null && can(d, "document_link") ? { from: character, to: character + 1 } : null);
    const onlyLink = !word;
    if (!w || !d) { if (this.word || view.state.field(linkField, false)) this.clear(); return; }
    if (this.word && this.word.from === w.from && this.word.to === w.to) return; // same word: already running or showing
    // The same link, only another character in it: it stays underlined.
    const stands = view.state.field(linkField, false);
    if (stands && !stands.tooltip && this.isLink && w.from >= stands.from && w.to <= stands.to) return;
    this.clear();
    this.word = w;
    const question = { seq: this.seq, doc: view.state.doc };
    const applies = () => responseApplies(question, { seq: this.seq, doc: view.state.doc, mounted: view.dom.isConnected });
    const remembered = !onlyLink && this.locations.fetch(`${w.from}:${w.to}`, Date.now());
    // At once: remembered or an identifier — the underline does not wait for the server.
    const beforehand = !onlyLink && (Boolean(remembered) || this.identifier(w));
    if (beforehand) view.dispatch({ effects: setLink.of({ ...w, tooltip: null }) });
    this.timer = setTimeout(async () => {
      const locations = onlyLink ? [] : await this.definitions(d, w);
      if (!applies()) return;
      if (!locations.length) { if (beforehand) view.dispatch({ effects: setLink.of(null) }); void this.showLink(d, w, applies); return; } // no definition, no link — except on a link
      if (!beforehand) view.dispatch({ effects: setLink.of({ ...w, tooltip: null }) });
      this.timer = setTimeout(async () => {
        const tip = await this.preview(d, locations, w).catch(() => null);
        if (!applies() || !tip) return;
        view.dispatch({ effects: [setLink.of({ ...w, tooltip: tip }), closeHoverTooltips] });
      }, PREVIEW_MS);
    }, remembered ? 0 : DEBOUNCE_MS);
  }

  /** Underline the link under the word (its whole range, no preview) — only if ⌘-click follows it. */
  private async showLink(d: LspFile, w: { from: number; to: number }, applies: () => boolean) {
    const l = await this.link(d, w);
    if (applies() && l) { this.isLink = true; this.view.dispatch({ effects: setLink.of({ ...l, tooltip: null }) }); }
  }
  /** Is a link (not a definition) currently underlined? */
  private isLink = false;
  /** The range of a link under the word that ⌘-click follows — or null. */
  private async link(d: LspFile, w: { from: number; to: number }): Promise<{ from: number; to: number } | null> {
    if (!can(d, "document_link")) return null;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const doc = this.view.state.doc;
      const position = lspPosOf(doc, w.from);
      const r = await questions(d, "link", { position }, abort.signal);
      if (abort.signal.aborted || isNotSupported(r) || !r.link || !linkWay(r.link.target)) return null;
      const from = lspOffsetOf(doc, r.link.range.start), to = lspOffsetOf(doc, r.link.range.end);
      return to > from ? { from, to } : null;
    } catch {
      return null;
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private async definitions(d: LspFile, w: { from: number; to: number }): Promise<readonly LspLocation[]> {
    if (!can(d, "definition")) return [];
    const k = `${w.from}:${w.to}`;
    const remembered = this.locations.fetch(k, Date.now());
    if (remembered) return remembered;
    const upfront = this.running.get(k);
    if (upfront) return upfront; // the up-front question is already running — do not ask a second time
    const abort = new AbortController();
    this.abort = abort;
    try {
      const r = await questions(d, "definition", { position: lspPosOf(this.view.state.doc, w.from) }, abort.signal);
      const locations = isNotSupported(r) ? [] : r.locations ?? [];
      if (!abort.signal.aborted) this.locations.remember(k, locations, Date.now());
      return locations;
    } catch {
      return []; // not remembered: asked again on the next rest
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private async preview(d: LspFile, locations: readonly LspLocation[], w: { from: number; to: number }): Promise<Tooltip | null> {
    const tooltip = (rows: string[] | null, language: Language): Tooltip => ({
      pos: w.from, end: w.to, above: true,
      create: (view) => ({ dom: previewNode(view, rows, language, locations.length) }),
    });
    if (locations.length > 1) return tooltip(null, null);
    const location = locations[0];
    const [rows, language] = await Promise.all([
      rowLoader(d.buffer.target, d.buffer.path)(location.file, location.external ?? null),
      languageForFile(location.file),
    ]);
    if (!rows) return null;
    const v = definitionsPreview(rows, location.range);
    return v.rows.length ? tooltip(v.rows, language) : null;
  }
}

const cmdPlugin = ViewPlugin.fromClass(CmdHover);

/** Is ⌘ (otherwise Ctrl) currently held in this view? The normal hover (lsp-hover.ts) is silent then. */
export const cmdPressed = (view: EditorView): boolean => Boolean(view.plugin(cmdPlugin)?.mod);

export const cmdHover: Extension = [
  linkField, cmdPlugin,
  EditorView.theme({
    ".cm-cmd-link": { color: "var(--cb-link-active)", textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer" },
    ".cm-cmd-link *": { color: "var(--cb-link-active)" },
  }),
];
