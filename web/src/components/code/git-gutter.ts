"use client";

// The editor's git margin as in VS Code: to the left of the line numbers a narrow bar per changed spot against the INDEX (like VS Code
// Quick Diff) — green = new lines, blue = changed, a red triangle = deleted (at the edge below, before the first line above). The
// computation is in lib/dirty-diff.ts (executed in web/test/dirty-diff.test.mjs); it runs 200 ms after the last key (`MARGIN_WAIT_MS`, as
// in VS Code — not per key), in between the marks move with the text; the marks stand finished in the state (built ONCE per computation,
// not per update).
//
// THE QUICK-DIFF PEEK (like VS Code 1.143 `QuickDiffController`/`QuickDiffWidget`): a click on a mark (mouse down and up on the same line,
// onEditorMouseUp) opens the peek zone (components/code/quick-diff-peek.ts) under the change — a click on the open one closes it;
// ⌥F3/⇧⌥F3 (`editor.action.dirtydiff.next`/`.previous`, lib/editor-commands.ts `QUICK_DIFF_COMMANDS`, so also in the palette) jump to the
// next/previous change and open it, also without an open peek; Esc/⇧Esc close. The computations (shape of the change, target, list change,
// measures) are in lib/quick-diff.ts (executed in web/test/quick-diff.test.mjs). In the peek's header:
// - "Revert Change" (git.revertChange): restores ONLY this block in the BUFFER — through the editor, like typing (⌘Z undoes it). It is not
//   saved (deviation: VS Code saves afterwards).
// - "Stage Change" (git.stageChange): writes ONLY this block into the index — `POST …/git/stage-block` (server git.js `gitStageBlock`), with
//   the BUFFER's lines (also unsaved, as in VS Code) and the base's checksum; afterwards the margin takes the new base at once and
//   fetches it again (also after a 409, otherwise every further attempt would be 409 again), the git tree (explorer, bar) comes with the
//   answer. While staging runs, the button is off (VS Code `enablement: !operationInProgress`).
// Both hit the SHOWN change (found again in the freshly computed list, `findAgain`), then set the cursor as VS Code does (one line below
// the start of the change) and close the peek as VS Code does (`onDidRun` closes after every error-free action except Next/Previous). If
// the list of changes moves while the peek is open and does not have focus, it jumps to the next one as in VS Code (or closes if none is
// left).
//
// THE BASE (the index, stage 0) per file lives in ONE stock in the window (lib/dirty-diff.ts `BaseInventory`, keyed like the buffer):
// `useGitBase` fetches it for the active file (`POST …/git/diff { staged: false, content: true }`, the old side; `gitBaseFrom`) — anew when
// file, repo, last commit or its index/working-tree state (`x`/`y`) change and when the window regains focus; a NON-active view writes
// nothing (`baseJob` — its `null` would otherwise delete the margin of the active view of the same file). A base is forgotten when its
// buffer closes or moves. No margin for: an untracked file, a file in conflict, a file outside a repo, a read-only buffer (a location
// outside the instance), binary/too large, and while the base is not read (unknown is not "unchanged").
import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { BaseInventory, MARGIN_WAIT_MS, baseJob, dirtyDiff, gitBaseFrom, reset, type DiffBlock } from "@/lib/dirty-diff";
import { normContent } from "@/lib/diff-tab";
import { QUICK_DIFF_COMMANDS, command, registerCommand } from "@/lib/editor-commands";
import { changes, cursorAfterAction, endRow, clickTarget, afterListSwitch, peekTarget, stageBody, findAgain, rowHits, type Change } from "@/lib/quick-diff";
import { atClose, atRename, renamedKey, type Buffer } from "@/lib/buffer";
import type { GitTree } from "@/lib/api";
import { rulerGit } from "@/components/code/overviewRuler";
import { PEEK_THEME, QuickDiffWidget, peekHasFocus, peekKeys, stageButtonStatus, type PeekData, type PeekControl } from "@/components/code/quick-diff-peek";
import { showHint, type EditorContext } from "@/components/code/lsp-core";

type T = (key: string, params?: Record<string, string | number>) => string;
type Calls = <R = unknown>(rest: string, opts?: RequestInit) => Promise<R>;

// ── The stock of bases (per buffer key; null = no margin) ────────────────────────────────────────────────────────────────────────
const BASES = new BaseInventory();
export function setGitBase(key: string, base: string | null): void { BASES.set(key, base); }
const baseOf = (key: string): string | null => BASES.from(key);
// Where "Stage Change" goes (per buffer key): the same call, the same repo and the same file the base was fetched against, who takes over
// the git tree of the answer and how the base is fetched anew (`fetchNew`). Set only by `useGitBase` (without a base no margin, without a
// margin no peek); removed when the view that set it goes (otherwise it would hold its call and state).
type Location = { calls: Calls; repo: string; file: string; gitTree: (t: GitTree) => void; fetchNew: () => void };
const LOCATIONS = new Map<string, Location>();
// A buffer that closes or moves takes its base and its location along. Once per window.
let registered = false;
function register() {
  if (registered || typeof window === "undefined") return;
  registered = true;
  atClose((p) => BASES.forget(p.key));
  atClose((p) => { LOCATIONS.delete(p.key); });
  atRename((target, old, fresh, newTarget) => BASES.forgetWhere((k) => renamedKey(k, target, old, fresh, newTarget) !== null));
  atRename((target, old, fresh, newTarget) => { for (const k of [...LOCATIONS.keys()]) if (renamedKey(k, target, old, fresh, newTarget) !== null) LOCATIONS.delete(k); });
}

/**
 * Fetches the base (the index) of the active file if it lies in a repo and is tracked (see the header). `relRepo`: the repo's path relative
 * to the view's root ("" = itself). `gitState`: index and working-tree state of the file (`x`/`y` from `git status`) — if it changes (a
 * stage, an unstage), it is fetched anew. `gitTree`: takes over the git tree after "Stage Change" (explorer decoration, bar).
 */
export function useGitBase(o: {
  calls: Calls;
  path: string | null;
  buffer: Buffer | null;
  repo: { relPath: string; lastCommit?: { hash: string } | null } | null;
  gitKind: string | null;
  gitState?: string | null;
  active: boolean;
  gitTree?: (t: GitTree) => void;
}): void {
  const { calls, path, buffer, repo, gitKind, gitState, active, gitTree } = o;
  register();
  const key = buffer && !buffer.readonly ? buffer.key : null;
  const relRepo = repo?.relPath ?? null, header = repo?.lastCommit?.hash ?? "";
  const gitTreeRef = useRef(gitTree);
  useEffect(() => { gitTreeRef.current = gitTree; });
  // Fetch anew on demand (after "Stage Change" and after a failure).
  const [catchUpSeq, setCatchUpSeq] = useState(0);
  // The location THIS view set — it releases it when it goes or the file changes (only if it is still its own: the same file can be open
  // in a second view).
  const ownRef = useRef<{ key: string; location: Location } | null>(null);
  useEffect(() => () => releaseLocation(ownRef), []);
  // The window regains focus (as in VS Code: staged outside, a checkout in the terminal) — fetch anew.
  const [focusSeq, setFocusSeq] = useState(0);
  useEffect(() => {
    if (!active) return;
    const fresh = () => setFocusSeq((n) => n + 1);
    window.addEventListener("focus", fresh);
    return () => window.removeEventListener("focus", fresh);
  }, [active]);
  useEffect(() => {
    const a = baseJob({ active, key, path, relRepo, gitKind, xy: gitState });
    if (a.kind === "nothing") return;
    if (ownRef.current && ownRef.current.key !== a.key) releaseLocation(ownRef);
    if (a.kind === "no") { LOCATIONS.delete(a.key); setGitBase(a.key, null); return; }
    const location: Location = { calls, repo: a.body.repo, file: a.body.file, gitTree: (t) => gitTreeRef.current?.(t), fetchNew: () => setCatchUpSeq((n) => n + 1) };
    LOCATIONS.set(a.key, location);
    ownRef.current = { key: a.key, location };
    let alive = true;
    calls<unknown>("/git/diff", { method: "POST", body: JSON.stringify(a.body) })
      .then((r) => { if (alive) setGitBase(a.key, gitBaseFrom(normContent(r, a.body.file))); })
      .catch(() => { if (alive) setGitBase(a.key, null); });
    return () => { alive = false; };
  }, [calls, path, key, relRepo, header, gitKind, gitState, active, focusSeq, catchUpSeq]);
}
/** Releases the location a view set — only if it is still its own. */
function releaseLocation(own: { current: { key: string; location: Location } | null }): void {
  const e = own.current;
  if (e && LOCATIONS.get(e.key) === e.location) LOCATIONS.delete(e.key);
  own.current = null;
}

// ── ⌥F3/⇧⌥F3 in the command table (keys in the editor, palette) ────────────────────────────────────────────────────────────────
// Execution looks for the view's steering — a view without a git margin has none, the command does nothing there (as VS Code without changes).
const STEERING = new WeakMap<EditorView, { navigate(direction: 1 | -1): void }>();
const DIRECTION: Record<string, 1 | -1> = { "editor.action.dirtydiff.next": 1, "editor.action.dirtydiff.previous": -1 };
for (const b of QUICK_DIFF_COMMANDS) {
  if (!command(b.id)) registerCommand<EditorContext>({ ...b, execute: (k) => { STEERING.get(k.view)?.navigate(DIRECTION[b.id]); } });
}

// ── The extension ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Margin = { base: string | null; blocks: DiffBlock[]; markers: RangeSet<GutterMarker>; open: number | null };
const setBase = StateEffect.define<string | null>();
const setBlocks = StateEffect.define<DiffBlock[]>();
const setOpen = StateEffect.define<number | null>();
// The peek as a block decoration under the change's last line: set (with a new place — showChange) or refreshed (in its place —
// refresh); in between it moves with the text.
const peekSet = StateEffect.define<{ data: PeekData; pos: number } | null>();
const peekRefresh = StateEffect.define<PeekData>();
const peekDeco = (d: PeekData) => Decoration.widget({ widget: new QuickDiffWidget(d), block: true, side: 1 });
// The same file in two groups computes its margin per view — the same text against the same base computes only once (the latest results
// per base, at most `MARGIN_REMEMBER`).
const MARGIN_REMEMBER = 8;
const COMPUTED = new Map<string, { text: string; blocks: DiffBlock[] }>();
function compute(base: string | null, state: EditorState): DiffBlock[] {
  if (base === null) return [];
  const text = state.doc.toString(), old = COMPUTED.get(base);
  if (old && old.text === text) return old.blocks;
  const blocks = dirtyDiff(base, text) ?? [];
  COMPUTED.delete(base);
  COMPUTED.set(base, { text, blocks });
  if (COMPUTED.size > MARGIN_REMEMBER) COMPUTED.delete(COMPUTED.keys().next().value as string);
  return blocks;
}

class MarginMarker extends GutterMarker {
  constructor(readonly kind: DiffBlock["kind"], readonly top: boolean, readonly seq: number) { super(); }
  eq(o: GutterMarker): boolean { return o instanceof MarginMarker && o.kind === this.kind && o.top === this.top && o.seq === this.seq; }
  toDOM(): Node {
    const el = document.createElement("div");
    el.className = `cm-gitMargin cm-gitMargin-${this.kind}${this.top ? " cm-gitMargin-top" : ""}`;
    el.dataset.gitMargin = this.kind;
    el.dataset.gitMarginSeq = String(this.seq);
    return el;
  }
}

const THEME = EditorView.baseTheme({
  ".cm-gitMarginColumn": { width: "4px", marginLeft: "2px" },
  ".cm-gitMarginColumn .cm-gutterElement": { padding: "0", cursor: "pointer", position: "relative" },
  ".cm-gitMargin": { position: "absolute", top: "0", bottom: "0", left: "0", width: "3px", transition: "width 80ms linear, left 80ms linear" },
  "&dark .cm-gitMargin-new": { backgroundColor: "#2ea043" },
  "&light .cm-gitMargin-new": { backgroundColor: "#2ea043" }, // editorGutter.addedBackground: Light Modern like Dark Modern
  "&dark .cm-gitMargin-changed": { backgroundColor: "#0078d4" },
  "&light .cm-gitMargin-changed": { backgroundColor: "#005fb8" },
  // Deleted: a triangle at the edge below the line (before the first line: at its top edge).
  ".cm-gitMargin-deleted": { top: "auto", left: "-1px", bottom: "-4px", width: "0", height: "0", borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "5px solid #f85149", zIndex: "1" },
  ".cm-gitMargin-deleted.cm-gitMargin-top": { bottom: "auto", top: "-4px" },
  // Hover (VS Code `.margin-view-overlays > div:hover > .dirty-diff-glyph`): the bar gets wider and shows it is clickable; a deletion's
  // mark becomes a bar over the line.
  ".cm-gitMarginColumn .cm-gutterElement:hover .cm-gitMargin": { width: "6px", left: "-3px" },
  ".cm-gitMarginColumn .cm-gutterElement:hover .cm-gitMargin-deleted": { top: "0", bottom: "0", height: "auto", border: "0", backgroundColor: "#f85149" },
});

/** The blocks' marks — built ONCE per computation (afterwards only shifted with the text). */
function markersFrom(blocks: readonly DiffBlock[], doc: Text): RangeSet<GutterMarker> {
  const markers: ReturnType<MarginMarker["range"]>[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "deleted") {
      const row = doc.line(Math.max(1, Math.min(b.from || 1, doc.lines)));
      markers.push(new MarginMarker("deleted", b.from === 0, i).range(row.from));
      continue;
    }
    for (let n = b.from; n <= b.until && n <= doc.lines; n++) markers.push(new MarginMarker(b.kind, false, i).range(doc.line(n).from));
  }
  return RangeSet.of(markers, true);
}

/** Show line `seq` centred if it lies outside the view (QuickDiffWidget.revealRange: revealLineInCenterIfOutsideViewport). Measured only
 *  after drawing — the peek above it is then already there. */
function showRowFallsOutside(view: EditorView, seq: number) {
  view.requestMeasure({
    key: "quickdiff-view",
    read(v) {
      const doc = v.state.doc, row = doc.line(Math.max(1, Math.min(seq, doc.lines)));
      const block = v.lineBlockAt(row.from), viewRect = v.scrollDOM.getBoundingClientRect();
      const top = v.documentTop + block.top, bottom = v.documentTop + block.bottom;
      return top < viewRect.top || bottom > viewRect.bottom ? row.from : null;
    },
    write(pos, v) { if (pos !== null) v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) }); },
  });
}

const fileName = (p: Buffer) => p.path.split("/").pop() || p.path;

/** The margin for a view's buffer — empty without a buffer and for a read-only one. */
export function gitMargin(p: Buffer | null, t: T): Extension {
  if (!p || p.readonly) return [];
  const field = StateField.define<Margin>({
    create: (state) => { const base = baseOf(p.key); const blocks = compute(base, state); return { base, blocks, markers: markersFrom(blocks, state.doc), open: null }; },
    update(v, tr) {
      let base = v.base, open = v.open;
      let blocks: DiffBlock[] | null = null;
      for (const e of tr.effects) {
        if (e.is(setBase)) { base = e.value; blocks = compute(base, tr.state); }
        else if (e.is(setBlocks)) blocks = e.value;
        else if (e.is(setOpen)) open = e.value;
      }
      if (blocks) return { base, blocks, markers: markersFrom(blocks, tr.state.doc), open: open !== null && open < blocks.length ? open : null };
      // One key: the marks move with the text, computation only after the pause (the plugin below).
      if (tr.docChanged) return { ...v, markers: v.markers.map(tr.changes), open };
      return open === v.open ? v : { ...v, open };
    },
  });
  const peekField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      if (tr.docChanged && deco.size) {
        // Shifted with the text — and always at the end of a line (a block widget never stands in the middle of one).
        const c = deco.map(tr.changes).iter();
        deco = c.value ? Decoration.set([c.value.range(tr.state.doc.lineAt(c.from).to)]) : Decoration.none;
      }
      for (const e of tr.effects) {
        if (e.is(peekSet)) deco = e.value ? Decoration.set([peekDeco(e.value.data).range(e.value.pos)]) : Decoration.none;
        else if (e.is(peekRefresh)) { const c = deco.iter(); if (c.value) deco = Decoration.set([peekDeco(e.value).range(c.from)]); }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // The peek for change `index` of a list: its data, the line it stands under and the effect (with place = showChange, without =
  // refresh). `show` counts every display with a place (the peek then computes its height anew).
  let show = 0;
  // The change the peek SHOWS per view, with the base it is computed against (the actions hit it, not the number in a list that has
  // meanwhile become another), and whether staging is running there.
  const shown = new WeakMap<EditorView, { a: Change; base: string }>();
  const stagesCurrently = new WeakSet<EditorView>();
  const controls = new WeakMap<EditorView, PeekControl>();
  const controlOf = (view: EditorView): PeekControl => {
    let s = controls.get(view);
    if (!s) {
      s = {
        next: () => navigate(view, 1),
        previous: () => navigate(view, -1),
        close: () => close(view),
        stage: () => stage(view),
        stages: () => stagesCurrently.has(view),
        reset: () => setBack(view),
      };
      controls.set(view, s);
    }
    return s;
  };
  const peekFor = (view: EditorView, base: string | null, blocks: readonly DiffBlock[], index: number, withPlace: boolean) => {
    const list = changes(blocks), a = list[index];
    if (!a || base === null) return null;
    const data: PeekData = { show: withPlace ? ++show : show, index, count: list.length, change: a, base, buffer: p, fileName: fileName(p), control: controlOf(view) };
    shown.set(view, { a, base });
    const doc = view.state.doc, row = doc.line(Math.max(1, Math.min(endRow(a), doc.lines)));
    return { a, row, effect: withPlace ? peekSet.of({ data, pos: row.to }) : peekRefresh.of(data) };
  };
  /** showChange(index): the peek under the change, the cursor at the start of its last line, view followed, focus into the editor. */
  const showBlock = (view: EditorView, index: number, upfront: readonly StateEffect<unknown>[] = [], list?: { base: string | null; blocks: readonly DiffBlock[] }) => {
    const v = view.state.field(field, false);
    if (!v) return;
    const pk = peekFor(view, list ? list.base : v.base, list ? list.blocks : v.blocks, index, true);
    if (!pk) { if (upfront.length) view.dispatch({ effects: [...upfront] }); return; }
    view.dispatch({ effects: [...upfront, setOpen.of(index), pk.effect], selection: { anchor: pk.row.from }, userEvent: "select" });
    showRowFallsOutside(view, endRow(pk.a) + 1);
    view.focus();
  };
  const close = (view: EditorView) => {
    view.dispatch({ effects: [peekSet.of(null), setOpen.of(null)] });
    view.focus();
  };
  /** ⌥F3/⇧⌥F3 (QuickDiffController.next/previous). */
  const navigate = (view: EditorView, direction: 1 | -1) => {
    const v = view.state.field(field, false);
    if (!v) return;
    const i = peekTarget({ list: changes(v.blocks), open: v.open, cursorRow: view.state.doc.lineAt(view.state.selection.main.head).number, direction });
    if (i !== null) showBlock(view, i);
  };
  /** The list of changes moves (a new base, a computation after the pause) — with an open peek like onDidModelChange. */
  const newList = (view: EditorView, effect: StateEffect<unknown>, base: string | null, blocks: readonly DiffBlock[]) => {
    const v = view.state.field(field, false);
    if (!v) return;
    if (v.open === null) { view.dispatch({ effects: effect }); return; }
    const after = changes(blocks);
    if (peekHasFocus(view)) {
      // VS Code does nothing while the peek has focus (one types in it). Only what no longer exists goes: no change ⇒ closed, the open one
      // beyond the end ⇒ the last (otherwise a peek without a change would stand there).
      if (!after.length) view.dispatch({ effects: [effect, peekSet.of(null), setOpen.of(null)] });
      else if (v.open >= after.length) { const pk = peekFor(view, base, blocks, after.length - 1, false); view.dispatch({ effects: pk ? [effect, setOpen.of(after.length - 1), pk.effect] : [effect] }); }
      else view.dispatch({ effects: effect });
      return;
    }
    const followUp = afterListSwitch(changes(v.blocks), after, v.open);
    if (followUp?.kind === "close") { view.dispatch({ effects: [effect, peekSet.of(null), setOpen.of(null)] }); return; }
    if (followUp?.kind === "jump") { showBlock(view, followUp.index, [effect], { base, blocks }); return; }
    const index = followUp ? followUp.index : v.open;
    const pk = followUp || base !== v.base ? peekFor(view, base, blocks, index, false) : null;
    view.dispatch({ effects: pk ? [effect, setOpen.of(index), pk.effect] : [effect] });
  };
  /** The SHOWN change in the freshly computed list — null: it does not exist like that any more (the list follows after the pause), or it
   *  is computed against another base (the spot in the index would then mean another line). */
  const shownChange = (view: EditorView, base: string) => {
    const g = shown.get(view);
    if (!g || g.base !== base) return null;
    const blocks = compute(base, view.state), list = changes(blocks), index = findAgain(list, g.a);
    return index < 0 ? null : { blocks, index, a: list[index] };
  };
  /** After an error-free action: the cursor as VS Code, then closed. */
  const afterAction = (view: EditorView, a: Change) => {
    const doc = view.state.doc;
    view.dispatch({ selection: { anchor: doc.line(cursorAfterAction(a, doc.lines)).from }, userEvent: "select" });
    close(view);
  };
  /** Revert Change (git.revertChange): only this block, in the buffer, through the editor — it is not saved. */
  const setBack = (view: EditorView) => {
    const v = view.state.field(field, false);
    if (!v || v.open === null || v.base === null) return;
    const g = shownChange(view, v.base), block = g?.blocks[g.index];
    if (!g || !block) return;
    const ae = reset(view.state.doc.toString(), block);
    view.dispatch({ changes: ae, userEvent: "input.gitRevert" });
    afterAction(view, g.a);
  };
  /** What the notice says after a failure — two cases with their own wording, otherwise the server's. */
  const stageError = (e: unknown): string => {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "FILTER") return t("This file goes through a Git filter when staged (such as Git LFS) — staging by block would bypass it. Please stage the whole file.");
    if (code === "INDEX_CHANGED") return t("The index has changed in the meantime — the gutter is being reloaded. Please stage the change again.");
    return t("The change could not be staged: {msg}", { msg: String((e as Error)?.message ?? e) });
  };
  /** Stage Change (git.stageChange): only this block into the index, with the buffer's text. At most one per view at a time. */
  const stage = async (view: EditorView): Promise<void> => {
    const v = view.state.field(field, false), location = LOCATIONS.get(p.key);
    if (!v || v.open === null || v.base === null || !location || stagesCurrently.has(view)) return;
    const g = shownChange(view, v.base);
    const r = g ? stageBody(v.base, view.state.doc.toString(), g.blocks, g.index, p.status.lineEnding) : null;
    if (!r || !g) return;
    let tree: GitTree;
    stagesCurrently.add(view);
    stageButtonStatus(view, true);
    try {
      tree = await location.calls<GitTree>("/git/stage-block", { method: "POST", body: JSON.stringify({ repo: location.repo, file: location.file, ...r.body }) });
    } catch (e) {
      showHint(view, stageError(e));
      location.fetchNew(); // the base anew — a moved index would otherwise be 409 again on every further attempt
      return;
    } finally {
      stagesCurrently.delete(view);
      stageButtonStatus(view, false);
    }
    if (view.dom.isConnected) afterAction(view, g.a);
    setGitBase(p.key, r.newBase); // the margin at once against the new index …
    location.fetchNew(); // … and read, not believed
    location.gitTree(tree); // explorer decoration and bar
  };

  let press: { view: EditorView; row: number } | null = null;
  return [
    field,
    peekField,
    rulerGit.from(field, (v) => v.blocks), // the blocks for the overview ruler (components/code/overviewRuler.ts)
    THEME,
    PEEK_THEME,
    peekKeys((view) => view.state.field(field, false)?.open != null, (view) => close(view)),
    gutter({
      class: "cm-gitMarginColumn",
      markers: (view) => view.state.field(field).markers,
      initialSpacer: () => new MarginMarker("fresh", false, -1),
      domEventHandlers: {
        // As VS Code onEditorMouseDown/-Up: mouse down on a mark, up on the same line — then open (or close the open one).
        mousedown(view, row, ev) {
          press = null;
          if ((ev as MouseEvent).button !== 0) return false;
          const n = view.state.doc.lineAt(row.from).number;
          if (!changes(view.state.field(field).blocks).some((a) => rowHits(n, a))) return false;
          press = { view, row: n };
          return true;
        },
        mouseup(view, row) {
          const d = press;
          press = null;
          if (!d || d.view !== view || view.state.doc.lineAt(row.from).number !== d.row) return false;
          const v = view.state.field(field);
          const z = clickTarget(changes(v.blocks), v.open, d.row);
          if (!z) return false;
          if (z.kind === "close") close(view);
          else showBlock(view, z.index);
          return true;
        },
      },
    }),
    // Follows the stock (a new base arrives as an effect in the state — never in the middle of an update) and computes anew 200 ms after the
    // last key (`MARGIN_WAIT_MS`, as in VS Code).
    ViewPlugin.define((view) => {
      STEERING.set(view, { navigate: (direction) => navigate(view, direction) });
      let scheduled = false, tot = false;
      let clock: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        scheduled = false;
        if (tot) return;
        const now = baseOf(p.key);
        if (view.state.field(field, false)?.base !== now) newList(view, setBase.of(now), now, compute(now, view.state));
      };
      const listener = () => { if (!scheduled) { scheduled = true; queueMicrotask(check); } };
      const release = BASES.listen(listener);
      listener();
      return {
        update(u) {
          if (!u.docChanged) return;
          clearTimeout(clock);
          clock = setTimeout(() => {
            const v = view.state.field(field, false);
            if (tot || !v || v.base === null) return;
            const blocks = compute(v.base, view.state);
            newList(view, setBlocks.of(blocks), v.base, blocks);
          }, MARGIN_WAIT_MS);
        },
        destroy: () => { tot = true; clearTimeout(clock); release(); STEERING.delete(view); },
      };
    }),
  ];
}
