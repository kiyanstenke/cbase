"use client";

// The connection of navigation to an editor: per CodePane (Coding → Files and every target of the code tabs in the chat) ONE history for
// back/forward across files (lib/navigation.ts `NavHistory`), ONE result for the "References" mode and the way to open a location as a tab —
// also a target outside the instance as a read-only tab (read via `read` with the server's token; the buffer stays held while the editor lives).
//
// CodePane stays small: it calls `useNavigation` once, passes `connection` to `editorExtensions` (and via `NavContext` to the diff tab that
// stands in its place), shows `result` in the bar's fourth mode (ReferencesBar.tsx) and, for an external target, the `WriteProtectionRow`.
// A jump with a line from CodePane itself (search, problems, debug: `openFile(path, line)`) goes through `rememberJump` — it too records a
// history entry, and it also jumps in the file that is already in front.
//
// What records an entry: Go to …, opening from the peek, a hit click in the bar or the search, a tab switch (also by clicking the tab).
// Back/forward themselves record nothing (the history already stands on the file that appears in front). A rename in the tree (also an
// adopted outline) moves history and remembered places along (lib/buffer.ts `atRename` — the same move as the buffers).
//
// COORDINATES (lib/buffer-coordinates.ts): the history, the remembered places and the tabs speak paths OF THIS view; what comes from below —
// locations of the language service, a buffer's path, a rename — is canonical (relative to the asking buffer's target) and is converted
// HERE (`inView`): at workspace level a hit `src/x.ts` of the project lands in the tab `<project folder>/src/x.ts`. A target outside the instance
// stays a read-only buffer OF THIS view (it has no canonical form; read via the file in which the question was asked).
import { createContext, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { atRename, type Buffer, type BufferTarget } from "@/lib/buffer";
import { inView, keyInView, type Coordinates } from "@/lib/buffer-coordinates";
import type { LspPos } from "@/lib/api";
import { NavHistory, tabSwitched, type NavLocation } from "@/lib/navigation";
import { tr, useT } from "@/lib/i18n";
import { showHint } from "@/components/code/lsp-core";
import { externalBuffer, attemptsJump, type NavConnection, type ReferenceResult } from "@/components/code/lsp-nav-core";

/** The connection of the editor a building block sits in (the diff tab in place of the editor in CodePane). */
export const NavContext = createContext<NavConnection | null>(null);

/** A pending jump is valid this long (after that it would be surprising — the file never came to the front). */
const JUMP_APPLIES_MS = 15_000;

export function useNavigation(o: {
  /** The editor's coordinates (components/code/coordinates.ts `useCoordinates`). */
  coordinates: Coordinates;
  /** The active file tab (null: none, a diff, "Files"). */
  activePath: string | null;
  /** Open a file tab and bring it to the front (CodePane `openFile` without a line). */
  openTab: (path: string) => void;
  /** The view of the file tabs (BufferEditor). */
  mainView: () => EditorView | null;
  /** Show the "References" mode (reveal the bar). */
  showBar: () => void;
  /** Show a folder in the explorer (CodePane's show-in-explorer) — path of this view. */
  showFolder?: (path: string) => void;
}): { connection: NavConnection; result: ReferenceResult | null; empty: () => void } {
  const run = useRef(o);
  run.current = o;
  const [result, setResult] = useState<ReferenceResult | null>(null);
  const z = useRef({
    history: new NavHistory(),
    last: new Map<string, LspPos>(),
    pending: null as { path: string; pos: LspPos; until?: LspPos | null; at: number; focus?: boolean } | null,
    extern: new Map<string, { token: string }>(),
    holders: new Map<string, () => void>(),
    seq: 0,
  }).current;

  const connection = useMemo<NavConnection>(() => {
    const locationFrom = (path: string): NavLocation => ({ path, pos: z.last.get(path) ?? { line: 0, character: 0 }, extern: z.extern.get(path) ?? null });
    const now = (): NavLocation | null => (run.current.activePath ? locationFrom(run.current.activePath) : null);
    const hint = (e: unknown) => {
      const v = run.current.mainView();
      if (v) showHint(v, String((e as Error)?.message ?? e));
    };
    /** Provide an external target as a read-only buffer — held while the editor lives. */
    const loadExtern = async (path: string, token: string, origin: string | null) => {
      const { p, release } = await externalBuffer(run.current.coordinates.target, path, token, origin);
      if (z.holders.has(p.key)) release(); else z.holders.set(p.key, release);
      z.extern.set(path, { token });
    };
    const targets = (path: string, pos: LspPos, focus = true, until: LspPos | null = null) => {
      z.pending = { path, pos, until, at: Date.now(), focus };
      requestAnimationFrame(() => { const v = run.current.mainView(); if (v) attemptsJump(v); });
    };
    /** Back/forward: to the place, without a new entry. */
    const go = async (location: NavLocation | null) => {
      if (!location) return;
      if (location.extern?.token && !z.extern.has(location.path)) {
        try { await loadExtern(location.path, location.extern.token, null); } catch (e) { hint(e); return; }
      }
      targets(location.path, location.pos);
      run.current.openTab(location.path);
    };
    const a: NavConnection = {
      mainView: () => run.current.mainView(),
      pathOf: (p: Buffer) => inView(run.current.coordinates, p.target, p.path),
      async open(target, location, from = now()) {
        const path = inView(run.current.coordinates, target, location.file); // the location is relative to the asking buffer's target
        if (path === null) { hint(tr("The target is not in this editor.")); return; }
        if (location.external?.token) {
          try { await loadExtern(path, location.external.token, from && !from.extern ? from.path : null); } catch (e) { hint(e); return; }
        }
        a.rememberJump(path, location.range.start, from);
        run.current.openTab(path);
      },
      rememberJump(path, pos, from = now(), o) {
        z.history.jump(from, { path, pos, extern: z.extern.get(path) ?? null });
        targets(path, pos, o?.focus !== false, o?.until ?? null);
      },
      back(from = now()) { void go(z.history.back(from)); },
      before(from = now()) { void go(z.history.before(from)); },
      showResult(e) {
        z.seq += 1;
        setResult({ ...e, seq: z.seq } as ReferenceResult);
        run.current.showBar();
      },
      reportPlace(path, pos) { z.last.set(path, pos); },
      pending(k) {
        const s = z.pending;
        return s && keyInView(run.current.coordinates, s.path) === k && Date.now() - s.at < JUMP_APPLIES_MS ? s.pos : null;
      },
      pendingUntil(k) { return a.pending(k) ? z.pending?.until ?? null : null; },
      takePending() { const focus = z.pending?.focus !== false; z.pending = null; return focus; },
      tokenOf: (path) => z.extern.get(path) ?? null,
      showFolder(target, path0) {
        const path = inView(run.current.coordinates, target, path0);
        const f = run.current.showFolder;
        if (path === null || !f) { hint(tr("The target is not in this editor.")); return true; }
        f(path);
        return true;
      },
    };
    return a;
  }, [z]);

  // Tab switch: whoever switches the tab jumps — unless the history already stands on the new file (go to, back/forward).
  const prior = useRef<string | null>(null);
  useEffect(() => {
    const fresh = o.activePath, old = prior.current;
    if (!fresh || fresh === old) return;
    prior.current = fresh;
    const location = (path: string): NavLocation => ({ path, pos: z.last.get(path) ?? { line: 0, character: 0 }, extern: z.extern.get(path) ?? null });
    tabSwitched(z.history, old ? location(old) : null, location(fresh));
  }, [o.activePath, z]);

  // A file or folder that lives in THIS editor was renamed (reported canonically, converted here) — history and
  // remembered places move along.
  useEffect(() => atRename((target, alt0, new0, newTarget) => {
    const k = run.current.coordinates;
    const old = k.ofCanon(target, alt0), fresh = k.ofCanon(newTarget, new0);
    if (old === null || fresh === null || !old || old === fresh) return;
    z.history.renamed(old, fresh);
    const under = (p: string) => p === old || p.startsWith(`${old}/`);
    for (const [p, pos] of [...z.last]) if (under(p)) { z.last.delete(p); z.last.set(fresh + p.slice(old.length), pos); }
    if (prior.current && under(prior.current)) prior.current = fresh + prior.current.slice(old.length);
  }), [z]);

  // Another target (instance choice): history, places and external buffers belong to the old one.
  const targetKey = JSON.stringify([o.coordinates.target.apiBase, o.coordinates.target.instance ?? ""]);
  useEffect(() => () => {
    for (const release of z.holders.values()) release();
    z.holders.clear();
    z.extern.clear();
    z.last.clear();
    z.history = new NavHistory();
    z.pending = null;
    prior.current = null;
    setResult(null);
  }, [targetKey, z]);

  return { connection, result, empty: () => setResult(null) };
}

/** Above the editor of a target outside the instance: lock, "read-only" and the path in the container. */
export function WriteProtectionRow({ path: filePath }: { path: string }) {
  const t = useT();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1 text-[12px]" data-code-read-only={filePath}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-dim" aria-hidden>
        <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <span className="shrink-0 font-medium">{t("read-only")}</span>
      <span className="shrink-0 text-dim">{t("outside the project")}</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-dim" title={filePath}>{filePath}</span>
    </div>
  );
}
