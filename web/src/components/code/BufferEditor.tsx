"use client";

// The editor of a file tab as a view of its buffer (lib/buffer.ts): Coding → Files AND the code tabs in the chat
// (components/CodePane.tsx). Instead of @uiw/react-codemirror with `value`: its reconciliation replaced the whole text IN THE HISTORY on
// a tab switch (Cmd+Z after switching brought back the previous file's text) and it knows no buffer.
//
// ONE EditorView per editor; one EditorState per file. On a switch the old one rests (with selection, folds and scroll state) and stays
// a view on the buffer (foreign changes flow in), the new one comes back. Undo belongs to the buffer (lib/buffer-history.ts, as in VS
// Code on the model): a resting state keeps the file's history alive across tab switches and groups. Resting states of files the editor
// no longer has open (`open`) are dropped. Without a buffer (a diff, an image, "Loading…") the view stays as it is; the holder hides it
// (`hidden`).
//
// `useBufferTabs`: the holder side: for each open tab the buffer of its file (held, subscribed); a tab that goes away lets go with
// `dismiss` (closed means the human was asked beforehand), unmounting does so without (an unmounted chat keeps its unsaved text in the
// buffer), unless the holder says `dismiss()` on unmount (after "Switch anyway?"/"Close anyway?" or a deleted chat; otherwise the
// discarded text would stay without a holder). The tabs name paths of THEIR view; which buffer belongs to them is told by the
// coordinates (lib/buffer-coordinates.ts: at workspace level that of the project). Holding is per path of the view; a tab keeps its
// buffer even when the mapping changes (a project created or deleted: the buffer moves or stays), and while the mapping is unknown it
// holds none.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { matchingFor, type ViewStatus } from "@/lib/view-status";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup, type BasicSetupOptions } from "@uiw/react-codemirror";
import type { View, EditorHolder, Buffer } from "@/lib/buffer";
import { findInView, tabBufferFor, type Coordinates } from "@/lib/buffer-coordinates";
import { shapeOf, sameShape, type Shape } from "@/lib/buffer-shape";
import { echoSpec, hereChanged, bufferView } from "@/components/code/buffer-view";
import { indentation } from "@/components/code/indentation";
import { BufferHistory } from "@/lib/buffer-history";

type Dormant = { state: EditorState; scroll: ReturnType<EditorView["scrollSnapshot"]> | null; release: () => void; top: number; margin: number };
const HEIGHT = EditorView.theme({ "&": { height: "100%" }, "& .cm-scroller": { height: "100% !important" } });

/** `state`: the state of the shown file (selection, scroll state, folds); splitting and moving carry it along. */
export type BufferEditorRef = { view?: EditorView; status?: () => ViewStatus | null };
/** Where a file's state is remembered in THIS editor (CodePane per group): read when a file opens without a resting state, stored when it
 *  rests, the editor goes away or the page (reload). */
export type StatusStorage = { read: (key: string) => ViewStatus | null; remember: (key: string, st: ViewStatus) => void };

/** The scroll state as first visible position and offset (like CodeMirror `scrollSnapshot`, but as numbers). */
function scrollPosition(v: EditorView): { top: number; margin: number } {
  const top = v.scrollDOM.scrollTop, pad = v.documentPadding.top;
  const b = v.lineBlockAtHeight(Math.max(0, top - pad));
  return { top: b.from, margin: b.top + pad - top };
}
function statusFromState(s: EditorState, scroll: { top: number; margin: number }): ViewStatus {
  const folds: [number, number][] = [];
  foldedRanges(s).between(0, s.doc.length, (a, b) => { folds.push([a, b]); });
  return { selection: s.selection.ranges.map((r) => ({ anchor: r.anchor, header: r.head })), main: s.selection.mainIndex, top: scroll.top, margin: scroll.margin, folds };
}
const statusOf = (v: EditorView): ViewStatus => statusFromState(v.state, scrollPosition(v));
/** Apply a remembered state (clamped to the text). */
function applyState(v: EditorView, raw: ViewStatus) {
  const st = matchingFor(raw, v.state.doc.length);
  v.dispatch({
    selection: EditorSelection.create(st.selection.map((r) => EditorSelection.range(r.anchor, r.header)), st.main),
    effects: st.folds.map(([from, to]) => foldEffect.of({ from, to })),
  });
  v.requestMeasure({ read: (x) => x.lineBlockAt(st.top).top + x.documentPadding.top - st.margin, write: (top, x) => { x.scrollDOM.scrollTop = top; } });
}

export function BufferEditor({ buffer, open, extensions, basicSetup: setup, editor = null, onInput, viewRef: outerViewRef, hidden = false, state: status }: {
  /** The buffer the view should show (loaded); null: it stays as it is. */
  buffer: Buffer | null;
  /** The keys of the buffers whose tabs this editor still has; resting states of all others are dropped. */
  open: readonly string[];
  /** What changes per file (language, gutter, theme …); reconfigured, not rebuilt. */
  extensions: Extension;
  basicSetup: BasicSetupOptions;
  editor?: EditorHolder | null;
  /** Typed in THIS view (not an echo of the buffer). */
  onInput?: (p: Buffer) => void;
  /** For the places that need the EditorView (focus, jump, measuring): `viewRef.current?.view`. */
  viewRef?: React.MutableRefObject<BufferEditorRef | null>;
  hidden?: boolean;
  state?: StatusStorage;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const current = useRef<Buffer | null>(null);
  const dormant = useRef(new Map<string, Dormant>());
  const parts = useRef(new Compartment());
  const setupKey = JSON.stringify(setup);
  const run = useRef({ onInput, editor, extensions, setup, state: status });
  run.current = { onInput, editor, extensions, setup, state: status };
  // The file's indentation as facets and tab as in VS Code (components/code/indentation.ts), before basicSetup and indentWithTab.
  const config = (): Extension => [basicSetup(run.current.setup), keymap.of([indentWithTab]), indentation(run.current.setup.tabSize ?? 4), run.current.extensions];
  const set = useRef<{ ext: Extension; setup: string } | null>(null);

  useLayoutEffect(() => {
    const v = new EditorView({ parent: host.current! });
    viewRef.current = v;
    if (outerViewRef) outerViewRef.current = { view: v, status: () => (current.current ? statusOf(v) : null) };
    const r = dormant.current;
    // Before reload (and when the editor goes away) remember each file's state.
    const rememberAll = () => {
      const sp = run.current.state;
      if (!sp) return;
      if (current.current) sp.remember(current.current.key, statusOf(v));
      for (const [k, x] of r) sp.remember(k, statusFromState(x.state, x));
    };
    window.addEventListener("pagehide", rememberAll);
    return () => {
      window.removeEventListener("pagehide", rememberAll);
      rememberAll();
      for (const x of r.values()) x.release();
      r.clear();
      v.destroy(); // the view of the shown buffer detaches itself (buffer-view.ts destroy)
      viewRef.current = null;
      current.current = null;
      set.current = null;
      if (outerViewRef) outerViewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch: the shown state rests (stays a view of its buffer); the new file's state comes back or is created.
  const state = buffer?.status.state;
  useLayoutEffect(() => {
    const v = viewRef.current;
    const p = buffer && state === "loaded" ? buffer : null;
    if (!v || !p || p === current.current) return;
    const old = current.current;
    if (old?.open) {
      const e: Dormant = { state: v.state, scroll: v.scrollSnapshot(), release: () => {}, ...scrollPosition(v) };
      run.current.state?.remember(old.key, statusFromState(e.state, e));
      const take = (spec: ReturnType<typeof echoSpec>) => {
        const tr = e.state.update(spec);
        e.state = tr.state;
        e.scroll = e.scroll?.map(tr.changes) ?? null;
        e.top = tr.changes.mapPos(e.top);
      };
      // A resting state stays a view of its buffer (foreign changes as an echo) and keeps the file's history alive (it belongs to the
      // buffer: Cmd+Z after switching back also undoes what another group typed meanwhile).
      const view: View = { apply: (b) => take(echoSpec(b)) };
      const connected = old.connect(view), unregister = BufferHistory.of(old).logIn(run.current.editor);
      e.release = () => { connected(); unregister(); };
      dormant.current.set(old.key, e);
    }
    const r = dormant.current.get(p.key);
    if (r) { r.release(); dormant.current.delete(p.key); }
    const back = r && r.state.doc.length === p.text.length && r.state.doc.toString() === p.text ? r : null;
    v.setState(back ? back.state : EditorState.create({
      doc: p.text,
      extensions: [
        bufferView(p, { editor: run.current.editor }),
        HEIGHT,
        EditorView.updateListener.of((u) => { if (hereChanged(u)) run.current.onInput?.(p); }),
        parts.current.of([]),
      ],
    }));
    current.current = p;
    set.current = { ext: extensions, setup: setupKey };
    v.dispatch({ effects: [parts.current.reconfigure(config()), ...(back?.scroll ? [back.scroll] : [])] });
    // Without a resting state, the remembered state of this file in THIS editor (split, moved, reloaded).
    const remembered = back ? null : run.current.state?.read(p.key) ?? null;
    if (remembered) applyState(v, remembered);
  }, [buffer, state]); // eslint-disable-line react-hooks/exhaustive-deps

  // New extensions (language loaded, settings, theme): reconfigure.
  useLayoutEffect(() => {
    const v = viewRef.current, g = set.current;
    if (!v || !current.current || (g && g.ext === extensions && g.setup === setupKey)) return;
    set.current = { ext: extensions, setup: setupKey };
    v.dispatch({ effects: parts.current.reconfigure(config()) });
  }, [extensions, setupKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resting states of closed tabs are dropped; if the shown buffer is no longer open, the view shows nothing (it detaches).
  const openKey = open.join("\n");
  useEffect(() => {
    const desired = new Set(open);
    for (const [k, r] of dormant.current) if (!desired.has(k)) { r.release(); dormant.current.delete(k); }
    const v = viewRef.current, a = current.current;
    if (v && a && a !== buffer && (!a.open || !desired.has(a.key))) {
      v.setState(EditorState.create({ doc: "" }));
      current.current = null;
      set.current = null;
    }
  }, [openKey, buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!hidden) viewRef.current?.requestMeasure(); }, [hidden]);

  return <div ref={host} className={hidden ? "hidden" : "h-full"} data-buffer-editor />;
}

type Held = { p: Buffer; release: (o?: { dismiss?: boolean }) => void; off: () => void; targetK: string };
/** The changes of the held buffers: whoever needs text (outline, problems, drafts, only after a pause) listens here instead of making the
 *  holder render per keystroke. `subscribe` returns the unsubscribe; the object stays the same while the holder lives. */
export type BufferChange = { subscribe(fn: () => void): () => void };
/** For each open tab the buffer of its file: held and subscribed (`tick` grows when the shape of one of them changes, `change` reports
 *  every change). A tab that goes away lets go with `dismiss`; unmounting does so without, unless `o.dismiss()` says yes on unmount.
 *  Hold first, then let go, so a renamed buffer is never briefly without a holder. `k`: the view's coordinates
 *  (components/code/coordinates.ts `useCoordinates`). Which buffer belongs to a tab is told by lib/buffer-coordinates.ts `tabBufferFor`:
 *  if the mapping changes or a held buffer merges into another, the tab switches to the canonical one, checked after EVERY render but only
 *  when no unsaved text drops out of sight; the old one is let go without `dismiss` (it yields itself when its text is in the new one). */
export function useBufferTabs(k: Coordinates, paths: readonly string[], o: { dismiss?: () => boolean } = {}): { bufferOf: (path: string) => Buffer | null; tick: number; change: BufferChange } {
  const [tickCount, tick] = useReducer((n: number) => n + 1, 0);
  // `tick` grows only when the SHAPE of a held buffer changes (lib/buffer-shape.ts: dirty, state, prompt, save error …, not the text);
  // every change, every keystroke included, goes to `change`. Otherwise the holder (CodePane with explorer, tab bars, status bar)
  // would render per keystroke.
  const listeners = useRef(new Set<() => void>());
  const [change] = useState<BufferChange>(() => ({ subscribe: (fn) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; } }));
  const shape = useRef(new WeakMap<Buffer, Shape>());
  const report = useCallback((p: Buffer) => {
    const fresh = shapeOf(p);
    const old = shape.current.get(p);
    shape.current.set(p, fresh);
    if (!sameShape(old, fresh)) tick();
    for (const fn of [...listeners.current]) fn();
  }, []);
  const subscription = (p: Buffer) => { shape.current.set(p, shapeOf(p)); return p.subscribe(() => report(p)); };
  const held = useRef(new Map<string, Held>());
  const kRef = useRef(k);
  kRef.current = k;
  const dismissRef = useRef(o.dismiss);
  dismissRef.current = o.dismiss;
  const targetKey = JSON.stringify([k.target.apiBase, k.target.instance ?? ""]);
  const pathsKey = paths.join("\n");
  useEffect(() => {
    const m = held.current, desired = new Set(paths), released: [Held, boolean][] = [];
    // Dismissed only if the TAB went away (same target); if the target changes, it is an unmount.
    for (const [pf, e] of m) if (!desired.has(pf) || e.targetK !== targetKey) { m.delete(pf); released.push([e, e.targetK === targetKey]); }
    for (const pf of desired) {
      if (m.has(pf)) continue;
      const p = tabBufferFor(kRef.current, pf); // null: the mapping is not known yet, so create no (second) one
      if (p) m.set(pf, { p, release: p.hold("tab"), off: subscription(p), targetK: targetKey });
    }
    for (const [e, dismiss] of released) { e.off(); e.release(dismiss ? { dismiss: true } : undefined); }
    tick();
  }, [targetKey, pathsKey, k.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // After every render: if a tab holds another buffer than the one it should hold now (the mapping changed, a superseded one is clean
  // or its text is in the new one), it switches: hold first, then let go without `dismiss`.
  useEffect(() => {
    const m = held.current;
    let switched = false;
    for (const [pf, e] of m) {
      const n = tabBufferFor(kRef.current, pf, e.p);
      if (!n || n === e.p) continue;
      m.set(pf, { p: n, release: n.hold("tab"), off: subscription(n), targetK: e.targetK });
      e.off(); e.release();
      switched = true;
    }
    if (switched) tick();
  });
  useEffect(() => {
    const m = held.current;
    return () => { const dismissAll = dismissRef.current?.() === true; for (const e of m.values()) { e.off(); e.release(dismissAll ? { dismiss: true } : undefined); } m.clear(); };
  }, []);
  const bufferOf = useCallback((pf: string): Buffer | null => held.current.get(pf)?.p ?? findInView(kRef.current, pf), [targetKey, k.state]); // eslint-disable-line react-hooks/exhaustive-deps
  return { bufferOf, tick: tickCount, change };
}
