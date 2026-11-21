"use client";
// The connection of "Select for Compare" to the code areas: the state of the choice (lib/comparison.ts — the computation) lives ONCE per
// window, as in VS Code (`globalResourceToCompare` and the global context key `resourceSelectedForCompare`; the git extension holds
// `git.timeline.selectedForCompare` the same way) — chosen in Coding → Files, compared in a chat's code tabs and the other way round,
// across projects, levels and copies. The paths for the explorer (components/code/explorer/ExplorerTree.tsx `comparison`) and the time axis
// (components/code/explorer/TimeAxis.tsx `comparison`) apply per area (its target, its `open`), opened by the SAME way as a time-axis
// diff (`open` = CodePane `openTimeAxis`: in the chat a diff tab of its bar, on the page a tab of the active editor group). As in VS Code:
// a comparison from the explorer opens PINNED (`pinned: true`), one from the time axis as a preview with focus (`vscode.diff` without options).
//
// THE SIDES FOLLOW: a comparison of two files can carry a side from another area. If that area renames or deletes the file, the others learn
// it through `reportFileFollowUp` (CodePane `followUpRenamed`/`followUpDeleted`) — the editor groups of the Files page through
// `useComparison` (`followUpCompare`), each chat's tabs in chat/chatTabs.ts. An area follows ONLY the comparisons (everything else
// belongs to its target and follows there as usual). Mapping goes through the canonical identity of a file (`mapInWindow`,
// lib/buffer-coordinates.ts): the same file on the workspace level and in the project is ONE.
//
// A save anywhere in the window re-reads the LEFT side of a comparison (`useLeftSaved`). The choice belongs to the workspace the window
// shows — a change clears it (`useWorkspaceTheChoice`, lib/comparison.ts `toWorkspace`).
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { targetEqual, type PathMapper, type DiffSource, type TabTarget } from "@/lib/chat-tabs";
import * as E from "@/lib/editor-inputs";
import { diffName } from "@/lib/editor-inputs";
import * as G from "@/lib/editor-groups";
import { coordinatesOf } from "@/lib/buffer-coordinates";
import { atSave } from "@/lib/buffer";
import { useActiveScope } from "@/lib/active-scope";
import { leftSaved } from "@/lib/diff-tab";
import * as V from "@/lib/comparison";
import type { TimeAxisOpen } from "@/components/code/explorer/TimeAxis";

type T = (key: string, params?: Record<string, string | number>) => string;

// ── The state: ONE per window ────────────────────────────────────────────────────────────────────────────────────────────────────
let choice: V.WindowChoice = { state: V.NO_CHOICE, workspace: null };
const listeners = new Set<() => void>();
const setChoice = (f: (w: V.WindowChoice) => V.WindowChoice) => {
  const fresh = f(choice);
  if (fresh === choice) return;
  choice = fresh;
  for (const h of [...listeners]) h();
};
const set = (f: (s: V.ComparisonStatus) => V.ComparisonStatus) => setChoice((w) => ({ ...w, state: f(w.state) }));
const subscribe = (h: () => void) => { listeners.add(h); return () => { listeners.delete(h); }; };
const read = () => choice.state;
const empty = () => V.NO_CHOICE;
/** The workspace the page shows (lib/active-scope.ts, the tab's live scope; unknown before reading) — a change clears the choice
 *  (lib/comparison.ts `toWorkspace`; VS Code reloads the window then). Every area calls it (`useComparison`). */
function useWorkspaceTheChoice(): void {
  const scope = useActiveScope();
  const id = scope.loaded ? scope.workspaceId : null;
  useEffect(() => { setChoice((w) => V.toWorkspace(w, id)); }, [id]);
}

/** A file, seen from `from`, in the paths of `after` — via the canonical identity; null: it does not live there, or the mapping is not known
 *  yet (the workspace's projects are not read). */
export const mapInWindow: PathMapper = (from, path, to) => {
  if (targetEqual(from, to)) return path;
  const o = coordinatesOf(from).toCanon(path);
  return o ? coordinatesOf(to).ofCanon(o.target, o.path) : null;
};
/** The same file? (The URI VS Code compares in the timeline.) Canonical where the mapping is known, otherwise target and path. */
export const sameFileInWindow: V.SameFile = (a, b) => {
  if (targetEqual(a.target, b.target)) return a.path === b.path;
  return mapInWindow(a.target, a.path, b.target) === b.path;
};

// ── The sides follow ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Renamed or deleted in an area (`from`: its id, so it does not apply it again; `target`: its target, in whose paths `old`/`fresh`/`path`
 *  stand). From the explorer only — a deletion is never "from outside". */
export type FileFollowUp =
  | { kind: "renamed"; from: string; target: TabTarget; old: string; fresh: string }
  | { kind: "deleted"; from: string; target: TabTarget; path: string };
const followUpListeners = new Set<(e: FileFollowUp) => void>();
export function reportFileFollowUp(e: FileFollowUp): void { for (const h of [...followUpListeners]) { try { h(e); } catch { /* one listener does not stop the others */ } } }
/** Listens to every follow-up in the window (its own too — whoever has applied it already checks `from`). */
export function useFileFollowUp(fn: (e: FileFollowUp) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: FileFollowUp) => ref.current(e);
    followUpListeners.add(h);
    return () => { followUpListeners.delete(h); };
  }, []);
}

/** `fn` when the LEFT side of the comparison `source` was saved anywhere in the window — in any area and target (lib/buffer.ts `atSave`,
 *  compared canonically via `sameFileInWindow`; lib/diff-tab.ts `leftSaved`). That is how Coding → Files and the chats reach each other:
 *  the diff block re-reads the left side instead of showing the state from opening. */
export function useLeftSaved(source: DiffSource, fn: () => void): void {
  const ref = useRef({ source, fn });
  ref.current = { source, fn };
  useEffect(() => atSave((p) => { if (leftSaved(ref.current.source, { target: p.target, path: p.path }, sameFileInWindow)) ref.current.fn(); }), []);
}

/** The path mapping of a rename in the tree: the file or everything under the folder. */
export const underForm = (old: string, fresh: string) => (a: string): string => (a === old ? fresh : a.startsWith(`${old}/`) ? fresh + a.slice(old.length) : a);
/** A follow-up from ANOTHER area, applied to the editor groups of the Files page: only comparisons of two files follow or fall (except
 *  with unsaved changes, as in the own area — VS Code `getAllNonDirtyEditors`; the same for renaming). */
export function compareInGroups(e: FileFollowUp, unsaved: (k: string) => boolean): (s: G.GroupsStatus) => G.GroupsStatus {
  const location = { target: e.target, map: mapInWindow };
  if (e.kind === "renamed") return (s) => E.followRename(s, underForm(e.old, e.fresh), location, true, unsaved);
  const p = e.path;
  return (s) => G.remove(s, E.hitsDeleted((a) => a === p || a.startsWith(`${p}/`), unsaved, location, true));
}

/** What the explorer needs from the comparison. `selected`: the file chosen for comparison in the window (or null). */
export type ExplorerComparison = {
  selected: V.Location | null;
  select: (path: string) => void;
  withSelectedPath: (path: string) => void;
  compareSelected: (paths: readonly string[]) => void;
};
/** What the time axis needs from the comparison. */
export type TimeAxisComparison = {
  status: V.ComparisonStatus;
  select: (w: V.TimeAxisChoice) => void;
  withSelected: (w: V.TimeAxisChoice) => void;
};

/** An area's comparison with the target `target`: choose and compare against the window's ONE choice. `followUp` (the Files page, uncontrolled):
 *  a follow-up from ANOTHER area (`area` ≠ `from`) makes this area's comparisons follow. */
export function useComparison(target: TabTarget, open: TimeAxisOpen, t: T, o: { area?: string; followUp?: (e: FileFollowUp) => void } = {}): {
  explorer: ExplorerComparison; timeAxis: TimeAxisComparison;
} {
  const s = useSyncExternalStore(subscribe, read, empty);
  useWorkspaceTheChoice();
  const ref = useRef({ target, open, t });
  ref.current = { target, open, t };
  useFileFollowUp((e) => { if (o.followUp && e.from !== o.area) o.followUp(e); });
  return useMemo(() => {
    const on = (q: DiffSource | null, fixed: boolean) => { if (q) ref.current.open(q, { title: diffName(q, ref.current.t), short: "", fixed }); };
    return {
      explorer: {
        selected: s.file,
        select: (path) => set((x) => V.fileForComparison(x, ref.current.target, path)),
        withSelectedPath: (path) => on(V.withSelectedFile(read(), ref.current.target, path), true),
        compareSelected: (paths) => on(V.selectedCompare(ref.current.target, paths), true),
      },
      timeAxis: {
        status: s,
        select: (w) => set((x) => V.entryForComparison(x, ref.current.target, w)),
        withSelected: (w) => on(V.withSelectedEntry(read(), ref.current.target, w, sameFileInWindow), false),
      },
    };
  }, [s]);
}
