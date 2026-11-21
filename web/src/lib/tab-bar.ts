// Port of: microsoft/vscode src/vs/base/common/labels.ts (MIT)
// The tab bar styled like VS Code — the pure computations for ONE component (components/code/TabBar.tsx) that Coding → Files
// (CodePane, uncontrolled) and the code tabs in the chat (chat/ChatTabBar.tsx) draw:
//   - equal names ⇒ a dimmed folder suffix (VS Code `workbench.editor.labelFormat: default`: the folders of same-named tabs, shortened
//     as in VS Code base/common/labels.ts `shorten` — the shortest unique part, "…" for what is left out, "./" for the root);
//   - the sets of the tab context menu (Close Others / to the Right / Saved / All) and their shortcuts as in VS Code (⌥⌘T, ⌘K U, ⌘K W,
//     ⌘K Enter, ⌥⌘C, ⌥⇧⌘C — `menuShortcut`, `shortcutText`);
//   - dragging reorders (before or after the tab under the pointer);
//   - the name's color: a problem (error before warning) before the git state — as a CSS variable from the SAME table as the
//     explorer (lib/explorer-decoration.ts `GIT_COLOR`/`PROBLEM_COLOR`, light/dark values in app/globals.css): one source for tree and tabs;
//   - the list of the Files page as preview/pinned: the SAME rule as in the chat — `open`/`close`/`keep`/`activate`/`rename`/
//     `removeFiles` from lib/chat-tabs.ts (new to the right of the active one, after closing the most recently used),
//     only mapped here onto a path list (two versions of the same rule would be two places for the same list).
//
// Tested by EXECUTION in web/test/tab-bar.test.mjs, each computation with a sabotage its check must catch.
import {
  CHAT, activate as activateStatus, removeFiles, keep as keepStatus, withRoot, open as openStatus, close as closeStatus, key as keyName,
  rename as renameStatus, targetIdentifier, twoRoots, type DiffSource, type TabState, type TabTarget, type KeyPress, type RootName,
} from "./chat-tabs.js";
import { GIT_COLOR, PROBLEM_COLOR, type GitKind } from "./explorer-decoration.js";

// ── Colors ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The git states of the tree (lib/api/git.ts `GitChange.kind`) — the explorer's type. */
export type { GitKind };
export type ProblemKind = keyof typeof PROBLEM_COLOR;
/** A known git state (own keys of the table — "toString" is none). */
export const isGitKind = (x: unknown): x is GitKind => typeof x === "string" && Object.prototype.hasOwnProperty.call(GIT_COLOR, x);

/** The color of a tab name (a CSS variable): an error before a warning before the git state — with neither, null (the tab's color). */
export function tabColor(git: GitKind | string | null | undefined, problem: ProblemKind | null | undefined): string | null {
  return problem ? PROBLEM_COLOR[problem] : git && isGitKind(git) ? GIT_COLOR[git] : null;
}
/** From counts, a tab's problem: error before warning, else none. */
export function problemKind(z: { error: number; warnings: number } | null | undefined): ProblemKind | null {
  if (!z) return null;
  return z.error > 0 ? "error" : z.warnings > 0 ? "warning" : null;
}

// ── Equal names ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const OMISSION = "…";
/**
 * VS Code base/common/labels.ts `shorten` (for relative paths with "/"): per path the shortest part of consecutive segments that appears
 * in no other path (searched from the end, short parts first; a part at the end counts as contained only if another path ends on it
 * as a WHOLE segment), with "…" for what is left out before and after. The empty path (the root) becomes "./"; without a unique part the
 * whole path.
 */
export function truncate(paths: readonly string[]): string[] {
  return paths.map((path, i) => {
    if (path === "") return "./";
    const segments = path.split("/");
    for (let length = 1; length <= segments.length; length++) {
      for (let start = segments.length - length; start >= 0; start--) {
        const part = segments.slice(start, start + length).join("/");
        const atEnd = start + length === segments.length;
        const contained = paths.some((other, j) => {
          if (j === i || !other || !other.includes(part)) return false;
          const withSeparator = start > 0 && other.includes("/") ? `/${part}` : part;
          return !atEnd || other.endsWith(withSeparator);
        });
        if (contained) continue;
        return `${start > 0 ? `${OMISSION}/` : ""}${part}${atEnd ? "" : `/${OMISSION}`}`;
      }
    }
    return path;
  });
}
/**
 * Per entry the folder suffix behind the name as in VS Code (`multiEditorTabsControl` → `shortenTabLabelDescriptions`): empty if the name
 * occurs only once, no path stands behind it (a whole commit) or all same-named entries carry the same folder (the same file in two
 * instances — the instance names itself there); otherwise the folders shortened via `truncate` (`src/a` next to `src/b` ⇒ "…/a" and "…/b"; the root
 * "./").
 */
export function nameAdditions(entries: readonly { name: string; path: string | null }[]): string[] {
  const out = entries.map(() => "");
  const groups = new Map<string, number[]>();
  entries.forEach((e, i) => { if (e.path) groups.set(e.name, [...(groups.get(e.name) ?? []), i]); });
  for (const idx of groups.values()) {
    const folder = idx.map((i) => (entries[i].path ?? "").split("/").filter(Boolean).slice(0, -1).join("/"));
    const different = [...new Set(folder)];
    if (different.length < 2) continue; // a single name or all in the same folder
    const truncated = truncate(different);
    const short = new Map(different.map((o, j) => [o, truncated[j]]));
    idx.forEach((i, j) => { out[i] = short.get(folder[j]) ?? ""; });
  }
  return out;
}
/**
 * The suffix of a comparison of two SAME-NAMED files from different folders, as VS Code `DiffEditorInput.computeLabels`: same name left
 * and right and both folders (the middle description, relative) non-empty and different ⇒ `forceDescription` — the tab shows the folders,
 * shortened via `truncate` (labels.ts `shorten`), joined as `computeLabel` does ("{left} - {right}", only one if equal after shortening).
 * Otherwise undefined: then the bar's ordinary suffix applies (`nameAdditions`).
 */
export function filesAddition(q: DiffSource, root: RootName = targetIdentifier): string | undefined {
  if (q.kind !== "files") return undefined;
  const parts = (p: string) => p.split("/").filter(Boolean);
  const l = parts(q.left), r = parts(q.right);
  if (!l.length || !r.length || l[l.length - 1] !== r[r.length - 1]) return undefined;
  // With two targets each side carries its root (VS Code, multiple roots: "{root} • {folder}", at the root the name alone) — then
  // no description is empty, and same-named files in equally named folders of two projects differ at the root.
  const two = twoRoots(q);
  const a = two ? withRoot(root(q.leftTarget), l.slice(0, -1).join("/")) : l.slice(0, -1).join("/");
  const b = two ? withRoot(root(q.rightTarget), r.slice(0, -1).join("/")) : r.slice(0, -1).join("/");
  if (!a || !b || a === b) return undefined;
  const [keysA, keysB] = truncate([a, b]);
  return keysA === keysB ? keysA : `${keysA} - ${keysB}`;
}

// ── Context menu ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CloseKind = "other" | "right" | "saved" | "all";
/**
 * Which tabs "Close Others" (all but this one), "Close to the Right" (those right of it), "Close Saved" (those without
 * unsaved changes) and "Close All" hit — in the bar's order. `queue` = the closable tabs (the chat is not among them). An unknown key:
 * "Right" hits nothing.
 */
export function closeSet(kind: CloseKind, queue: readonly string[], key: string, clean: (k: string) => boolean): string[] {
  switch (kind) {
    case "other": return queue.filter((k) => k !== key);
    case "right": { const i = queue.indexOf(key); return i < 0 ? [] : queue.slice(i + 1); }
    case "saved": return queue.filter((k) => clean(k));
    case "all": return [...queue];
  }
}

// ── Dragging ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The tab menu's shortcuts as in VS Code (macOS; otherwise Ctrl/Alt): what a key press does — `chord` = ⌘K was pressed, the next
 *  press belongs to it (⌘K U Close Saved, ⌘K W Close All, ⌘K Enter Keep Open — the second without modifier, as VS Code
 *  `cmd+k u`); ⌥⌘T Close Others. `code` is measured (⌥T yields "†" on a Mac). */
export type MenuKey = { kind: "chord" } | { kind: "set"; set: CloseKind } | { kind: "fixed" } | null;
export function menuShortcut(e: KeyPress, o: { mac: boolean }, chord: boolean): MenuKey {
  const mod = o.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (chord) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
    if (e.code === "KeyU") return { kind: "set", set: "saved" };
    if (e.code === "KeyW") return { kind: "set", set: "all" };
    if (e.code === "Enter") return { kind: "fixed" };
    return null;
  }
  if (mod && !e.altKey && !e.shiftKey && e.code === "KeyK") return { kind: "chord" };
  if (mod && e.altKey && !e.shiftKey && e.code === "KeyT") return { kind: "set", set: "other" };
  return null;
}
/** ⌥⌘C Copy Path, ⌥⇧⌘C Copy Relative Path — on the tab with focus (VS Code: outside the text). */
export function copyShortcut(e: KeyPress, o: { mac: boolean }): "path" | "relative" | null {
  const mod = o.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || !e.altKey || e.code !== "KeyC") return null;
  return e.shiftKey ? "relative" : "path";
}
/** The shortcuts as they appear in the menu (macOS order ⌃⌥⇧⌘ as in VS Code) — bound ones only; "Close to the Right" has none (as in VS Code). */
export function shortcutText(o: { mac: boolean }): { other: string; saved: string; all: string; fixed: string; path: string; relative: string } {
  return o.mac
    ? { other: "⌥⌘T", saved: "⌘K U", all: "⌘K W", fixed: "⌘K Enter", path: "⌥⌘C", relative: "⌥⇧⌘C" }
    : { other: "Ctrl+Alt+T", saved: "Ctrl+K U", all: "Ctrl+K W", fixed: "Ctrl+K Enter", path: "Ctrl+Alt+C", relative: "Ctrl+Alt+Shift+C" };
}

/** Dragging reorders: `from` before (`after` false) or after `to`. Unknown, onto itself or to the same place: the same list. */
export function reorder<T>(list: readonly T[], key: (x: T) => string, from: string, to: string, afterwards: boolean): readonly T[] {
  const i = list.findIndex((x) => key(x) === from);
  if (i < 0 || from === to || !list.some((x) => key(x) === to)) return list;
  const without = list.filter((_, j) => j !== i);
  const target = without.findIndex((x) => key(x) === to) + (afterwards ? 1 : 0);
  const fresh = [...without.slice(0, target), list[i], ...without.slice(target)];
  return fresh.every((x, j) => x === list[j]) ? list : fresh;
}
/** The side of a drop: after the tab if the pointer is in its right half. */
export const dropAfter = (pointerX: number, left: number, width: number): boolean => pointerX > left + width / 2;

// ── The Files page's list as preview/pinned (same rule as in the chat) ──────────────────────────────────────────────────────────
/** The tabs of the Files page: paths in order, the active one and the preview (at most one each), `last` the paths most recently used
 *  first (VS Code `mru`; if missing, the neighbor applies). */
export type PathList = { paths: readonly string[]; active: string | null; preview: string | null; last?: readonly string[] };
const LIST_TARGET: TabTarget = { apiBase: "/api/workspaces/list", instance: null };
const k = (path: string) => keyName({ kind: "file", target: LIST_TARGET, path });
const asState = (l: PathList): TabState => ({
  tabs: l.paths.map((path) => ({ kind: "file" as const, target: LIST_TARGET, path })),
  active: l.active !== null && l.paths.includes(l.active) ? k(l.active) : CHAT,
  preview: l.preview !== null && l.paths.includes(l.preview) ? k(l.preview) : null,
  views: [],
  ...(l.last ? { last: l.last.filter((p) => l.paths.includes(p)).map(k) } : {}),
});
function fromState(s: TabState): PathList {
  const paths = s.tabs.map((t) => (t.kind === "file" ? t.path : ""));
  const ofKey = (key: string | null) => (key === null || key === CHAT ? null : paths.find((p) => k(p) === key) ?? null);
  const l: PathList = { paths, active: ofKey(s.active), preview: ofKey(s.preview) };
  // The trail without the chat (the Files page has none): after the last tab nothing is active.
  return s.last ? { ...l, last: s.last.map(ofKey).filter((p): p is string => p !== null) } : l;
}
/** Open (lib/chat-tabs.ts `open`): without `fixed` the file replaces the preview in its place (unless it carries unsaved changes), otherwise
 *  it comes to the right of the active one; `background`: pinned as well, without coming to the front. */
export function openInList(l: PathList, path: string, o: { fixed?: boolean; background?: boolean; unsaved?: (path: string) => boolean } = {}): PathList {
  const prior = asState(l);
  const after = openStatus(prior, { kind: "file", target: LIST_TARGET, path }, {
    fixed: o.fixed, background: o.background, unsaved: (key) => { const p = l.paths.find((x) => k(x) === key); return p !== undefined && Boolean(o.unsaved?.(p)); },
  });
  return fromState(after);
}
/** Close (lib/chat-tabs.ts `close`): if the tab was active, the most recently used comes to the front, without a trail the right neighbor, else
 *  the left. The chat, which the computation falls back to in the chat, is "nothing active" here. */
export function closeInList(l: PathList, path: string): PathList {
  return fromState(closeStatus(asState(l), k(path)));
}
/** Activate (a click on the tab) — the path moves to the front of the trail. */
export function activateInList(l: PathList, path: string): PathList {
  return fromState(activateStatus(asState(l), k(path)));
}
/** After a rename in the tree (file or folder): the paths below move along, active, preview and trail likewise. */
export function renameInList(l: PathList, old: string, fresh: string): PathList {
  return fromState(renameStatus(asState(l), LIST_TARGET, old, fresh));
}
/** After a delete in the tree: close the tabs below (like closing, without asking — the file is gone). The list carries
 *  only files (diffs live in the editor groups), so `diffFalls` never hits anything. */
export function removeFromList(l: PathList, path: string): PathList {
  return fromState(removeFiles(asState(l), LIST_TARGET, path, () => false));
}
/** Pin (double click, typing, "Keep Open"). */
export function keepInList(l: PathList, path: string): PathList {
  return fromState(keepStatus(asState(l), k(path)));
}
