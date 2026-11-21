// The editor groups like VS Code, as a GRID — the pure computations for Coding → Files
// (CodePane uncontrolled; connection in components/code/editor-groups-connection.ts and editor-groups-commands.ts, drawing in
// components/code/EditorGroups.tsx). The reference is the default settings of VS Code 1.143:
// Port of: microsoft/vscode src/vs/workbench/browser/parts/editor/editorPart.ts (MIT)
// Port of: microsoft/vscode src/vs/workbench/browser/parts/editor/editorActions.ts (MIT)
// Port of: microsoft/vscode src/vs/workbench/browser/parts/editor/editorCommands.ts (MIT)
// Port of: microsoft/vscode src/vs/workbench/browser/parts/editor/editorDropTarget.ts (MIT)
//
//   - a group is a tab list as before (lib/tab-bar.ts `PathList`: paths, active, preview, lane) — opening, closing, pinning
//     go through THE SAME rules (`openInList` …), only per group; the same file in two groups shares the buffer, the view not;
//   - each group keeps its "most recently used" lane (VS Code `mru`): whoever stands in front stands in front in the lane (`withLane`, after
//     EVERY change of a list); after closing the active tab the most recently used one comes to the front, a new tab — also in the
//     background — comes right of the active one (`workbench.editor.openPositioning: right`); the lane survives reloads;
//   - the groups stand in a GRID (lib/editor-raster.ts): any number, splittable to the right, left, top and bottom, nested;
//     `groups` always stands in the order of the grid (VS Code `GRID_APPEARANCE`), `raster` carries tree and sizes. A state without a
//     (matching) grid counts as a row side by side (`rasterOf`) — so states built by hand in tests stay valid;
//   - the lane of the GROUPS (`lastActive`, VS Code `mostRecentActiveGroups`): the active one in front; one never active is not in it. If
//     the active group closes, the most recently active one before it becomes active; VS Code sorts neighbors per direction by it (`doFindGroupByDirection`);
//   - opening goes into the ACTIVE group; ⌘1–⌘8 focus the n-th group — if it is missing and is the next one, it is created empty right
//     of the last (VS Code `focusSecondEditorGroup` …);
//   - "Split Editor" (⌘\; plus up/down/left/right) copies the active editor into a new group next to it and makes it active; a
//     copied or moved editor is PINNED (VS Code "always pin moved editor");
//   - a group whose LAST tab leaves closes itself as long as another remains (VS Code `workbench.editor.closeEmptyGroups: true`);
//     one created empty (⌘2, split without an active editor) stays until it is closed; closing a group WITH editors puts them
//     into the most recently active one (`removeGroup` → `mergeGroup`);
//   - dragging: a tab into another group MOVES (with ⌥ copies), at the edge of a group it splits in that direction —
//     the LAST tab of a group at the edge of another moves the whole group (VS Code, `closeEmptyGroups`); not the ONLY tab
//     of a group onto its own area. Files from the explorer open pinned in the group under the pointer, at the edge in a new one;
//     the zone is computed by `dropZone` like VS Code (editorDropTarget: edge 10 %, left/right by thirds, otherwise top/bottom by halves);
//   - the state survives reloads (`storageText`/`fromStorage`, version 2 with grid; version 1 — two groups and a ratio — is still
//     read; empty is not unknown: what is not readable is null — not "empty");
//   - the keys of the groups (`GROUPS_COMMANDS`, `groupKey`) — ONE list for the command table, the palette, the menus and the keys
//     outside the editor (including the chords ⌘K … that CodeMirror cannot bind).
//
// Tested by execution in web/test/editor-groups.test.mjs (the grid itself in web/test/editor-raster.test.mjs), each computation with a
// sabotage its check must catch.
import { keepInList, openInList, closeInList, reorder, type PathList } from "./tab-bar.js";
import { matchesKey, keyLabel, type KeyPress } from "./commandPalette.js";
import * as R from "./editor-raster.js";

/** The smallest width of a group in px (VS Code `DEFAULT_EDITOR_MIN_DIMENSIONS`). */
export const MIN_WIDTH = R.MIN_WIDTH;
/** The edge of a group at which a drop splits (VS Code editorDropTarget: 10 % when dragging editors). */
export const MARGIN_SHARE = 0.1;

export type Direction = R.Direction;
/** Each of the four directions. */
export type Page = Direction;
export type Zone = "middle" | Direction;
export type Group = PathList & { id: string };
/** `maximized` (VS Code "Maximize Editor Group" ⌘K ⌘M): the group takes the whole area, the others are hidden — only with several
 *  groups and only the active one (if another becomes active, a new one is created, one is closed or the grid is rebuilt, it ends, as in VS Code). */
export type GroupsStatus = { groups: readonly Group[]; active: string; raster?: R.Raster; lastActive?: readonly string[]; maximized?: string };
/** Where a tab falls: before (or after) the tab `path` — null: as when opening (at the end). */
export type Before = { path: string; afterwards: boolean } | null;
/** A dragged tab: from which group, which file. */
export type TabTransaction = { group: string; path: string };
/** A drop: into which group, middle or edge, before which tab. */
export type Deposit = { group: string; zone: Zone; before?: Before };
/** A group by its position in the grid (VS Code `GroupLocation`). */
export type GroupsLocation = "first" | "last" | "next" | "previous";

const EMPTY_LIST: PathList = { paths: [], active: null, preview: null };
/** The beginning: ONE empty group. */
export const BEGINNING: GroupsStatus = { groups: [{ id: "g1", ...EMPTY_LIST }], active: "g1", raster: R.individual("g1"), lastActive: ["g1"] };

export const groupOf = (s: GroupsStatus, id: string): Group | null => s.groups.find((g) => g.id === id) ?? null;
/** The active group (an unknown `active` counts as the first). */
export const activeGroup = (s: GroupsStatus): Group => groupOf(s, s.active) ?? s.groups[0];
/** All open files, each ONCE, in the order of the groups — the load state and the buffer belong to the file, not the group. */
export function allOpen(s: GroupsStatus): string[] {
  const out: string[] = [];
  for (const g of s.groups) for (const p of g.paths) if (!out.includes(p)) out.push(p);
  return out;
}
/** The grid of the state — if it carries none that matches its groups, they stand side by side (equally wide). */
export function rasterOf(s: GroupsStatus): R.Raster {
  const r = s.raster, ids = s.groups.map((g) => g.id);
  if (r) { const b = R.sheets(r); if (b.length === ids.length && ids.every((id) => b.includes(id))) return r; }
  return R.queue(ids);
}
/** A new grid — the groups come in its order (`groups` from the list `stock`). */
function withRaster(s: GroupsStatus, r: R.Raster, stock: readonly Group[] = s.groups): GroupsStatus {
  const after = new Map(stock.map((g) => [g.id, g]));
  return { ...s, raster: r, groups: R.sheets(r).map((id) => after.get(id)).filter((g): g is Group => Boolean(g)) };
}
const withoutMaximization = (s: GroupsStatus): GroupsStatus => { if (s.maximized === undefined) return s; const { maximized: _m, ...rest } = s; return rest; };
/** The groups, most recently active first (VS Code `GroupsOrder.MOST_RECENTLY_ACTIVE`: the active one in front, one never active behind — there in the
 *  order of the grid, VS Code takes the order of creation). */
export function lastActiveGroups(s: GroupsStatus): string[] {
  const present = s.groups.map((g) => g.id);
  const mru = [s.active, ...(s.lastActive ?? [])].filter((id, i, a) => present.includes(id) && a.indexOf(id) === i);
  return [...mru, ...present.filter((id) => !mru.includes(id))];
}

const listOf = (g: PathList): PathList => ({ paths: g.paths, active: g.active, preview: g.preview, ...(g.last ? { last: g.last } : {}) });
const sameQueue = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((p, i) => p === b[i]);
const equal = (a: PathList, b: PathList) =>
  a.active === b.active && a.preview === b.preview && sameQueue(a.paths, b.paths) && sameQueue(a.last ?? [], b.last ?? []);
/** The lane after a change: the active one in front, only open paths, each once. */
function withLane(l: PathList): PathList {
  const rest = [...new Set(l.last ?? [])].filter((p) => p !== l.active && l.paths.includes(p));
  const last = l.active !== null && l.paths.includes(l.active) ? [l.active, ...rest] : rest;
  return sameQueue(last, l.last ?? []) && l.last ? l : { ...l, last };
}

/** Change the list of group `id` — unchanged: THE SAME state (no new render). If it becomes empty after having tabs,
 *  it closes as long as another remains (`closeEmptyGroups`). */
function withList(s: GroupsStatus, id: string, f: (l: PathList) => PathList): GroupsStatus {
  const i = s.groups.findIndex((g) => g.id === id);
  if (i < 0) return s;
  const old = s.groups[i], raw = f(listOf(old));
  if (equal(old, raw)) return s;
  const fresh = withLane(raw);
  const r = { ...s, groups: s.groups.map((g, j) => (j === i ? { id: g.id, ...listOf(fresh) } : g)) };
  if (!fresh.paths.length && old.paths.length && s.groups.length > 1) return removeGroup(r, id);
  return r;
}

/** Close a group (VS Code `removeGroup`; the only one stays). Empty: if it was active, the most recently active one before it becomes active, its place goes
 *  to the neighbor (lib/editor-raster.ts `remove`). With editors: they go into the most recently active group (`mergeGroup`). */
export function removeGroup(s: GroupsStatus, id: string): GroupsStatus {
  const g = groupOf(s, id);
  if (!g || s.groups.length < 2) return s;
  const mru = lastActiveGroups(s);
  if (g.paths.length) return joinTogether(s, id, s.active === id ? mru[1] : mru[0]);
  const r = withoutMaximization(s.active === id ? activateGroup(s, mru[1]) : s);
  const without = withRaster(r, R.remove(rasterOf(s), id), r.groups.filter((x) => x.id !== id));
  return { ...without, lastActive: (without.lastActive ?? [without.active]).filter((x) => x !== id) };
}

/** "Close All Editor Groups" (⌘K ⇧⌘W), after all editors are closed: every EMPTY group drops out, in reverse order of the grid
 *  (VS Code `CloseAllEditorGroupsAction.doCloseAll` → `groupsToClose`: GRID_APPEARANCE backwards, `count === 0 && removeGroup`) — the last
 *  one stays (`removeGroup` leaves the only one), so it is the first of the grid. A group with editors stays. */
export function removeEmptyGroups(s: GroupsStatus): GroupsStatus {
  let r = s;
  for (const id of R.sheets(rasterOf(s)).reverse()) if (groupOf(r, id)?.paths.length === 0) r = removeGroup(r, id);
  return r;
}

/** The groups in DOM order: by identifier, never by the grid. A rebuild of the tree (split, move, layout,
 *  flip) reorders `groups` — if the area were drawn in that order, React would move the nodes, and a moved node loses
 *  scroll position and focus (measured: 1,234 → 0). The number of a group ("Editor Group {n}", ⌘1–⌘8) stays that of the grid. */
export function domOrder(groups: readonly Group[]): Group[] {
  return [...groups].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** Make a group active (VS Code `doSetGroupActive`): it comes to the front of the lane of the groups; a maximization of another ends. */
export function activateGroup(s: GroupsStatus, id: string): GroupsStatus {
  if (s.active === id || !groupOf(s, id)) return s;
  const { maximized: _m, ...rest } = s;
  return { ...rest, active: id, lastActive: [id, ...[s.active, ...(s.lastActive ?? [])].filter((x, i, a) => x !== id && a.indexOf(x) === i)] };
}
/** ⌘K ⌘M (VS Code `workbench.action.toggleMaximizeEditorGroup`): maximize the active group — or undo the maximization. With one
 *  group there is nothing to maximize. */
export function toggleMaximize(s: GroupsStatus): GroupsStatus {
  if (s.maximized) { const { maximized: _m, ...rest } = s; return rest; }
  return s.groups.length > 1 ? { ...s, maximized: activeGroup(s).id } : s;
}
/** The group that stands maximized — null: none (also when the state no longer fits). */
export const maximizedGroup = (s: GroupsStatus): string | null => (s.maximized && s.groups.length > 1 && s.maximized === s.active && groupOf(s, s.maximized) ? s.maximized : null);
/** Bring a tab of a group to the front (click on the tab) — the group becomes active. */
export function activateTab(s: GroupsStatus, id: string, path: string): GroupsStatus {
  return activateGroup(withList(s, id, (l) => (l.paths.includes(path) ? { ...l, active: path } : l)), id);
}
/** Change the list of the active group (the path of CodePane `applyList`). */
export const changeActive = (s: GroupsStatus, f: (l: PathList) => PathList): GroupsStatus => withList(s, activeGroup(s).id, f);

/** Open: in the active group — or in `o.group` — by the rule of the tab bar (a preview replaces a preview …); the group becomes
 *  active. */
export function open(s: GroupsStatus, path: string, o: { fixed?: boolean; unsaved?: (path: string) => boolean; group?: string } = {}): GroupsStatus {
  const id = o.group && groupOf(s, o.group) ? o.group : activeGroup(s).id;
  return activateGroup(withList(s, id, (l) => openInList(l, path, { fixed: o.fixed, unsaved: o.unsaved })), id);
}
/** Add in the background (rename/peek changed a file without a tab): pinned right of the active tab of the active group like every new
 *  tab (VS Code `openPositioning: right`), nothing comes to the front — if it already stands in a group, everything stays. */
export function openInBackground(s: GroupsStatus, path: string): GroupsStatus {
  if (s.groups.some((g) => g.paths.includes(path))) return s;
  return withList(s, activeGroup(s).id, (l) => openInList(l, path, { fixed: true, background: true }));
}
/** Close a tab of a group (if it was active, the most recently used one of the group comes to the front, without a lane the right neighbor, otherwise the
 *  left — lib/tab-bar.ts `closeInList`); the last one closes the group (`closeEmptyGroups`). */
export const close = (s: GroupsStatus, id: string, path: string): GroupsStatus => withList(s, id, (l) => closeInList(l, path));
/** Pin — in group `id`, without: in every one where the file is a preview (typing; VS Code pins a changed editor). */
export function keep(s: GroupsStatus, path: string, id?: string): GroupsStatus {
  let r = s;
  for (const g of s.groups) if (!id || g.id === id) r = withList(r, g.id, (l) => keepInList(l, path));
  return r;
}
/** A preview with unsaved changes is pinned (VS Code) — in every group. */
export function tidyPreview(s: GroupsStatus, unsaved: (path: string) => boolean): GroupsStatus {
  let r = s;
  for (const g of s.groups) if (g.preview !== null && unsaved(g.preview)) r = withList(r, g.id, (l) => ({ ...l, preview: null }));
  return r;
}
/** Reorder WITHIN a group (dragging onto a tab of the same bar). */
export function reorderIn(s: GroupsStatus, id: string, from: string, to: string, afterwards: boolean): GroupsStatus {
  return withList(s, id, (l) => { const paths = reorder(l.paths, (x) => x, from, to, afterwards); return paths === l.paths ? l : { ...l, paths }; });
}
/** Renamed, moved, a layout adopted: every group moves its paths (`form` gives the new path, otherwise the same one). */
export function formPaths(s: GroupsStatus, form: (path: string) => string): GroupsStatus {
  let r = s;
  for (const g of s.groups) {
    r = withList(r, g.id, (l) => {
      const paths: string[] = [];
      for (const p of l.paths) { const n = form(p); if (!paths.includes(n)) paths.push(n); }
      const active = l.active === null ? null : form(l.active), preview = l.preview === null ? null : form(l.preview);
      return {
        paths, active: active !== null && paths.includes(active) ? active : paths[0] ?? null, preview: preview !== null && paths.includes(preview) ? preview : null,
        ...(l.last ? { last: l.last.map(form) } : {}), // the lane moves along
      };
    });
  }
  return r;
}
/** Replace a tab of group `id` IN ITS PLACE by `fresh` (a markdown preview follows another file, its lock
 *  toggles) — active, preview and lane move along. If `fresh` already stands there, `old` drops, and `fresh` comes to the front if `old` was in front. */
export function replaceIn(s: GroupsStatus, id: string, old: string, fresh: string): GroupsStatus {
  if (old === fresh || !fresh) return s;
  return withList(s, id, (l) => {
    if (!l.paths.includes(old)) return l;
    const present = l.paths.includes(fresh);
    const paths = present ? l.paths.filter((p) => p !== old) : l.paths.map((p) => (p === old ? fresh : p));
    const remap = (p: string | null) => (p === old ? fresh : p);
    return {
      paths, active: remap(l.active), preview: present && l.preview === old ? null : remap(l.preview),
      ...(l.last ? { last: [...new Set(l.last.map((p) => (p === old ? fresh : p)))] } : {}),
    };
  });
}
/** Deleted (a file, a folder): close their tabs — in every group, like a close. */
export function remove(s: GroupsStatus, hits: (path: string) => boolean): GroupsStatus {
  let r = s;
  for (const g of s.groups) for (const p of g.paths) if (hits(p)) r = close(r, g.id, p);
  return r;
}

// ── Neighbors and position ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** The group in `direction` of `id` (VS Code `findGroup({ direction })`: the adjacent ones, the most recently active first — one never active
 *  before that; `lap`: at the edge from the other side) — null: none. */
export function neighbor(s: GroupsStatus, id: string, direction: Direction, lap = false): Group | null {
  if (!groupOf(s, id)) return null;
  const lane = s.lastActive ?? [s.active];
  const n = R.neighbors(rasterOf(s), id, direction, lap).filter((x) => x !== id);
  n.sort((a, b) => lane.indexOf(a) - lane.indexOf(b));
  return n.length ? groupOf(s, n[0]) : null;
}
/** The first, last, next or previous group in the order of the grid (VS Code `findGroup({ location })`). */
export function groupAtLocation(s: GroupsStatus, id: string, location: GroupsLocation, lap = false): Group | null {
  const i = s.groups.findIndex((g) => g.id === id);
  if (i < 0) return null;
  if (location === "first") return s.groups[0];
  if (location === "last") return s.groups[s.groups.length - 1];
  const j = location === "next" ? i + 1 : i - 1;
  return s.groups[j] ?? (lap ? s.groups[location === "next" ? 0 : s.groups.length - 1] : null);
}
/** ⌘K ⌘← ⌘→ ⌘↑ ⌘↓ (VS Code `focusLeftGroup` …): the group in that direction active — at the edge from the other side (VS Code: `wrap`). */
export function focusNeighbor(s: GroupsStatus, direction: Direction): GroupsStatus {
  const n = neighbor(s, s.active, direction, true);
  return n ? activateGroup(s, n.id) : s;
}
/** "Focus First/Last/Next/Previous Editor Group" (next/previous with wrap-around like VS Code). */
export function focusLocation(s: GroupsStatus, location: GroupsLocation): GroupsStatus {
  const n = groupAtLocation(s, s.active, location, true);
  return n ? activateGroup(s, n.id) : s;
}

// ── Split ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Does "split" work on group `id`? Always if it exists (no cap). */
export const canShare = (s: GroupsStatus, id: string): boolean => groupOf(s, id) !== null;
const newId = (ids: readonly string[]): string => { let n = 1; while (ids.includes(`g${n}`)) n++; return `g${n}`; };
/** A new EMPTY group next to `id` in `direction` (VS Code `addGroup`: it does NOT become active; the size like `splitSizing: auto`; a
 *  maximization ends). Unknown group: null. */
export function createGroup(s: GroupsStatus, id: string, direction: Direction): { status: GroupsStatus; fresh: string } | null {
  if (!groupOf(s, id)) return null;
  const fresh = newId(s.groups.map((g) => g.id));
  return { status: withRaster(withoutMaximization(s), R.insertClipboard(rasterOf(s), fresh, id, direction), [...s.groups, { id: fresh, ...EMPTY_LIST }]), fresh };
}
/** Split (VS Code `splitEditor`): `path` (without it the active editor of the group) into a NEW group next to `id` in `direction`, pinned, and
 *  it becomes active. Without a file it is created empty (VS Code splits an empty group empty). */
export function parts(s: GroupsStatus, id: string, direction: Direction = "right", path?: string | null): GroupsStatus {
  const source = groupOf(s, id);
  if (!source) return s;
  const file = path === undefined ? source.active : path;
  const a = createGroup(s, id, direction)!;
  const r = file === null ? a.status : withList(a.status, a.fresh, (l) => ({ ...l, paths: [file], active: file, preview: null }));
  return activateGroup(r, a.fresh);
}
/** ⌘1–⌘8 (VS Code `focusFirstEditorGroup` … `focusEighthEditorGroup`): make group no. `seq` (order of the grid) active. The next one
 *  behind the last is created empty right of the last (VS Code); every further one is not. */
export function focus(s: GroupsStatus, seq: number): GroupsStatus {
  const g = s.groups[seq - 1];
  if (g) return activateGroup(s, g.id);
  if (seq - 1 !== s.groups.length) return s;
  const a = createGroup(s, s.groups[s.groups.length - 1].id, "right")!;
  return activateGroup(a.status, a.fresh);
}
/** Where an editor is moved: in a direction (VS Code `moveEditorToLeftGroup` …) or by position in the grid (`…ToNextGroup` …). */
export type EditorTarget = { direction: Direction } | { location: GroupsLocation };
/** Move an editor into another group (VS Code `moveCopyEditorsToGroup`, move): pinned, in front, the target group becomes active; the
 *  old one closes if it becomes empty. If the group in that direction is missing, it is created there; if the next one is missing, it is created on the right, if
 *  the previous one is missing, on the left (VS Code — both); the first and the last always exist. */
export function moveEditor(s: GroupsStatus, id: string, path: string, target: EditorTarget): GroupsStatus {
  const g = groupOf(s, id);
  if (!g || !g.paths.includes(path)) return s;
  let r = s;
  let to = "direction" in target ? neighbor(s, id, target.direction) : groupAtLocation(s, id, target.location);
  if (!to) {
    if ("location" in target && (target.location === "first" || target.location === "last")) return s;
    const a = createGroup(s, id, "direction" in target ? target.direction : target.location === "next" ? "right" : "left")!;
    r = a.status;
    to = groupOf(r, a.fresh);
  }
  if (!to || to.id === id) return s;
  return dropTab(r, { group: id, path }, { group: to.id, zone: "middle" });
}
/** Explorer "Open to the Side" (⌃↵, ⌥-click; VS Code `explorer.openToSide` → `SIDE_GROUP`): pinned in the group RIGHT of the active one — if
 *  it is missing, it is created there. The group becomes active. */
export function openBeside(s: GroupsStatus, path: string): GroupsStatus {
  const a = activeGroup(s);
  const n = neighbor(s, a.id, "right");
  if (n) return open(s, path, { fixed: true, group: n.id });
  const x = createGroup(s, a.id, "right")!;
  return open(x.status, path, { fixed: true, group: x.fresh });
}

// ── Move and merge groups, layouts ──────────────────────────────────────────────────────────────────────────────────────────────
/** Put group `id` next to `target` in `direction` (VS Code `moveGroup` → Grid.moveView; a maximization ends). */
export function moveGroupTo(s: GroupsStatus, id: string, target: string, direction: Direction): GroupsStatus {
  if (id === target || !groupOf(s, id) || !groupOf(s, target)) return s;
  return withRaster(withoutMaximization(s), R.move(rasterOf(s), id, target, direction));
}
/** ⌘K ← → ↑ ↓ (VS Code `moveActiveEditorGroupLeft` …): the group to the group in that direction — if there is none, across it (left/right:
 *  top, then bottom; top/bottom: left, then right) — and next to it in THAT direction; afterwards it is active. Without a target everything stays. */
export function moveGroup(s: GroupsStatus, id: string, direction: Direction): GroupsStatus {
  if (!groupOf(s, id)) return s;
  const queue: Direction[] = [direction, ...(R.orientationOfTheDirection(direction) === "sideBySide" ? (["top", "bottom"] as const) : (["left", "right"] as const))];
  for (const x of queue) {
    const z = neighbor(s, id, x);
    if (z) return activateGroup(moveGroupTo(s, id, z.id, direction), id);
  }
  return s;
}
/** Put the editors of `source` into `target` (VS Code `mergeGroup`): at the end, in their order, pinned; one that already stands there goes
 *  to the end. Only the active editor of the ACTIVE source comes to the front (then `target` becomes active), otherwise the active one of the target stays; an empty
 *  target group takes the first. The source closes. */
export function joinTogether(s: GroupsStatus, source: string, target: string): GroupsStatus {
  const q = groupOf(s, source);
  if (!q || !groupOf(s, target) || source === target) return s;
  const front = s.active === source ? q.active : null;
  let r = withList(s, target, (l) => {
    const paths = [...l.paths.filter((p) => !q.paths.includes(p)), ...q.paths];
    return { ...l, paths, active: front ?? l.active ?? paths[0] ?? null, preview: l.preview !== null && q.paths.includes(l.preview) ? null : l.preview };
  });
  if (front !== null) r = activateGroup(r, target);
  r = { ...r, groups: r.groups.map((g) => (g.id === source ? { id: g.id, ...EMPTY_LIST } : g)) };
  return removeGroup(r, source);
}
/** "Join Editor Group with Next Group" (VS Code `joinTwoGroups`): into the group on the right, otherwise below, left, top. */
export function connectWithNext(s: GroupsStatus, id: string = s.active): GroupsStatus {
  for (const x of ["right", "bottom", "left", "top"] as const) {
    const z = neighbor(s, id, x);
    if (z && z.id !== id) return joinTogether(s, id, z.id);
  }
  return s;
}
/** "Join All Editor Groups" (VS Code `joinAllGroups` → `mergeAllGroups(active)`: the others, most recently active first). */
export function connectAll(s: GroupsStatus): GroupsStatus {
  let r = s;
  for (const id of lastActiveGroups(s)) if (id !== s.active) r = joinTogether(r, id, s.active);
  return r;
}
/** The layouts of VS Code (`EditorLayout…Action`: `orientation` HORIZONTAL ⇒ "side by side"). */
export const LAYOUTS = {
  "workbench.action.editorLayoutSingle": { situation: "sideBySide", groups: [{}] },
  "workbench.action.editorLayoutTwoColumns": { situation: "sideBySide", groups: [{}, {}] },
  "workbench.action.editorLayoutThreeColumns": { situation: "sideBySide", groups: [{}, {}, {}] },
  "workbench.action.editorLayoutTwoRows": { situation: "mutually", groups: [{}, {}] },
  "workbench.action.editorLayoutThreeRows": { situation: "mutually", groups: [{}, {}, {}] },
  "workbench.action.editorLayoutTwoByTwoGrid": { situation: "sideBySide", groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }] },
  "workbench.action.editorLayoutTwoColumnsBottom": { situation: "mutually", groups: [{}, { groups: [{}, {}] }] },
  "workbench.action.editorLayoutTwoRowsRight": { situation: "sideBySide", groups: [{}, { groups: [{}, {}] }] },
} as const satisfies Record<string, R.Layout>;
export type LayoutId = keyof typeof LAYOUTS;
/** Apply a layout (VS Code `applyLayout`): too many groups go into the last one, which stays (order of the grid); then the grid is
 *  new — the existing groups in order, missing ones added empty, all equally sized; the active one stays active. */
export function applyLayout(s: GroupsStatus, l: R.Layout): GroupsStatus {
  const n = R.groupsIn(l);
  if (n < 1) return s;
  let r = s;
  const old = s.groups;
  if (n < old.length) for (const g of old.slice(n)) r = joinTogether(r, g.id, old[n - 1].id);
  const ids = r.groups.map((g) => g.id), alongside: Group[] = [];
  while (ids.length < n) { const id = newId(ids); ids.push(id); alongside.push({ id, ...EMPTY_LIST }); }
  const raster = R.byLayout(l, ids);
  return raster ? withRaster(withoutMaximization(r), raster, [...r.groups, ...alongside]) : s;
}
/** ⌥⌘0 (VS Code `toggleEditorGroupLayout`): the whole tree flips — side by side becomes stacked and vice versa. */
/** "Toggle Vertical/Horizontal Editor Layout" (⌥⌘0): the tree flips, the shares stay; a maximization ends (VS Code
 *  `set orientation` → `exitMaximizedView()`). */
export const flipLayout = (s: GroupsStatus): GroupsStatus => withRaster(withoutMaximization(s), R.flip(rasterOf(s)));

// ── Sizes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sameRaster = (a: R.Raster, b: R.Raster) => JSON.stringify(a) === JSON.stringify(b);
const withSizes = (s: GroupsStatus, r: R.Raster): GroupsStatus => (sameRaster(r, rasterOf(s)) ? s : { ...s, raster: r });
/** "Reset Editor Group Sizes" (VS Code `evenEditorWidths` → `arrangeGroups(EVEN)`: every branch equal; a maximization ends). */
export function distributeEqually(s: GroupsStatus): GroupsStatus {
  return s.groups.length < 2 ? s : withoutMaximization(withSizes(s, R.equalDistributed(rasterOf(s))));
}
/** Double-click on a separator: its branch equal (VS Code `onDidSashReset`). */
export const equalizeBranch = (s: GroupsStatus, branch: R.Location): GroupsStatus => withSizes(s, R.equallyDistributedAt(rasterOf(s), branch));
/** A separator is dragged (`way` px since the press, `length` that of the branch) — computed from the state at the press (`start`). */
export const pullSeparator = (start: GroupsStatus, branch: R.Location, index: number, distance: number, length: number): GroupsStatus =>
  withSizes(start, R.pull(rasterOf(start), branch, index, distance, length));
/** "Increase/Decrease Current View Width" (VS Code: 60 px per step) — the area measures `width` × `height`. */
export const changeWidth = (s: GroupsStatus, id: string, delta: number, width: number, height: number): GroupsStatus =>
  withSizes(s, R.changeSize(rasterOf(s), id, "sideBySide", delta, width, height));
/** After a change of the grid: what a minimum size forced becomes the share (`R.aligned`, VS Code `saveProportions`) — nothing to do: `s`. */
export const alignTo = (s: GroupsStatus, width: number, height: number): GroupsStatus => {
  const r = rasterOf(s), n = R.aligned(r, width, height);
  return n === r ? s : withSizes(s, n);
};

// ── Dragging ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** May a drop at the edge of `group` open a new group? Not with the ONLY tab of a group onto its own area (VS Code
 *  shows no area there). `turn` null: files. */
export function splittable(s: GroupsStatus, group: string, turn: TabTransaction | null): boolean {
  const g = groupOf(s, group);
  if (!g) return false;
  return !(turn && turn.group === group && g.paths.length <= 1);
}
/** The zone of a drop on the area of a group (pointer `x`/`y` relative to it) like VS Code (`openSideBySideDirection: right`): inside
 *  the edge (10 % of the width and height) the middle; in the edge left/right by thirds of the width, in between top/bottom by half
 *  of the height. Without splitting always the middle. */
export function dropZone(x: number, y: number, width: number, height: number, canSplit: boolean): Zone {
  if (!canSplit || !(width > 0) || !(height > 0)) return "middle";
  const ex = width * MARGIN_SHARE, ey = height * MARGIN_SHARE;
  if (x > ex && x < width - ex && y > ey && y < height - ey) return "middle"; // VS Code: truly inside — the boundary itself is edge
  if (x < width / 3) return "left";
  if (x > (width * 2) / 3) return "right";
  return y < height / 2 ? "top" : "bottom";
}
/** `path` pinned into the list — in place of `before` (without: at the end as when opening; already there: stays in its place) — and active. */
function place(l: PathList, path: string, before: Before): PathList {
  const preview = l.preview === path ? null : l.preview;
  if (!before || before.path === path || !l.paths.includes(before.path)) {
    return { ...l, paths: l.paths.includes(path) ? l.paths : [...l.paths, path], active: path, preview };
  }
  const without = l.paths.filter((p) => p !== path);
  const i = without.indexOf(before.path) + (before.afterwards ? 1 : 0);
  return { ...l, paths: [...without.slice(0, i), path, ...without.slice(i)], active: path, preview };
}
/** A tab drops (drag): at the edge (splittable) ⇒ a new group in that direction with it — if it was the LAST of its group and drops
 *  at the edge of another, the whole group moves there (VS Code `moveGroup`); otherwise into the group — the same one reorders (in the middle of
 *  its own area nothing changes), another gets it pinned and active in place of `before` and becomes active. Without `copy` (⌥) it leaves
 *  its group; if that is empty afterwards, it closes. */
export function dropTab(s: GroupsStatus, turn: TabTransaction, target: Deposit, copy = false): GroupsStatus {
  const from = groupOf(s, turn.group), destination = groupOf(s, target.group);
  if (!from || !destination || !from.paths.includes(turn.path)) return s;
  if (target.zone !== "middle" && splittable(s, destination.id, copy ? null : turn)) {
    if (!copy && from.id !== destination.id && from.paths.length === 1) return activateGroup(moveGroupTo(s, from.id, destination.id, target.zone), from.id);
    const r = parts(s, destination.id, target.zone, turn.path);
    return copy ? r : close(r, from.id, turn.path);
  }
  const before = target.before ?? null;
  if (from.id === destination.id) return before ? reorderIn(s, from.id, turn.path, before.path, before.afterwards) : s;
  // First it arrives in the target (it becomes active), then it leaves the source — like VS Code: the empty source closes as NOT active.
  const r = activateGroup(withList(s, destination.id, (l) => place(l, turn.path, before)), destination.id);
  return copy ? r : close(r, from.id, turn.path);
}
/** Files from the explorer drop: pinned into the group under the pointer (in place of `before`), at the edge into a new one; the
 *  FIRST is active afterwards (VS Code `openEditors`). */
export function dropFiles(s: GroupsStatus, paths: readonly string[], target: Deposit): GroupsStatus {
  const list = [...new Set(paths)].filter((p) => typeof p === "string" && p !== "");
  if (!list.length || !groupOf(s, target.group)) return s;
  let r = s, id = target.group, before: Before = target.before ?? null, rest = list;
  if (target.zone !== "middle" && splittable(s, target.group, null)) {
    r = parts(r, target.group, target.zone, list[0]);
    id = r.active;
    before = { path: list[0], afterwards: true };
    rest = list.slice(1);
  }
  for (const p of rest) { r = withList(r, id, (l) => place(l, p, before)); before = { path: p, afterwards: true }; }
  return activateGroup(withList(r, id, (l) => (l.paths.includes(list[0]) ? { ...l, active: list[0] } : l)), id);
}

// ── Reload ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The state as text for localStorage (version 2: with grid and the lane of the groups). */
export function storageText(s: GroupsStatus): string {
  const m = maximizedGroup(s);
  return JSON.stringify({
    v: 2, groups: s.groups.map((g) => ({ id: g.id, paths: g.paths, active: g.active, preview: g.preview, ...(g.last ? { last: g.last } : {}) })),
    active: s.active, raster: rasterOf(s), lastActive: lastActiveGroups(s).filter((id) => id === s.active || (s.lastActive ?? []).includes(id)), ...(m ? { maximized: m } : {}),
  });
}
/** A remembered state — null if nothing or something unreadable is remembered (then `BEGINNING` applies, "unknown" is not "empty"). Every
 *  field is checked: groups with a unique identifier, paths as non-empty strings without duplicates, active/preview only from the own list; the
 *  grid (version 2) carries exactly these groups (lib/editor-raster.ts `rasterFrom`), otherwise the state is unreadable. Version 1 (at most
 *  two side by side, `ratio` of the first) is read as a row. */
export function fromStorage(text: string | null | undefined): GroupsStatus | null {
  if (!text) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const o = raw as { v?: unknown; groups?: unknown; active?: unknown; ratio?: unknown; maximized?: unknown; raster?: unknown; lastActive?: unknown } | null;
  if (!o || typeof o !== "object" || (o.v !== 1 && o.v !== 2) || !Array.isArray(o.groups)) return null;
  const groups: Group[] = [];
  for (const x of o.groups as unknown[]) {
    const g = x as { id?: unknown; paths?: unknown; active?: unknown; preview?: unknown; last?: unknown } | null;
    if (!g || typeof g.id !== "string" || !g.id || groups.some((y) => y.id === g.id)) continue;
    const paths = Array.isArray(g.paths) ? [...new Set((g.paths as unknown[]).filter((p): p is string => typeof p === "string" && p !== ""))] : [];
    const active = typeof g.active === "string" && paths.includes(g.active) ? g.active : paths[0] ?? null;
    const preview = typeof g.preview === "string" && paths.includes(g.preview) ? g.preview : null;
    // The lane only from the own list; if it is missing (an older state), the neighbor applies.
    const last = Array.isArray(g.last) ? [...new Set((g.last as unknown[]).filter((p): p is string => typeof p === "string" && paths.includes(p)))] : null;
    groups.push({ id: g.id, paths, active, preview, ...(last ? { last } : {}) });
  }
  if (!groups.length) return null;
  const ids = groups.map((g) => g.id);
  const v1 = typeof o.ratio === "number" && o.ratio > 0 && o.ratio < 1 && ids.length === 2 ? [o.ratio, 1 - o.ratio] : undefined;
  const raster = o.v === 1 ? R.queue(ids, "sideBySide", v1) : R.rasterFrom(o.raster, ids);
  if (!raster) return null;
  const active = typeof o.active === "string" && ids.includes(o.active) ? o.active : R.sheets(raster)[0];
  const lane = Array.isArray(o.lastActive) ? (o.lastActive as unknown[]).filter((x): x is string => typeof x === "string" && ids.includes(x) && x !== active) : [];
  const s = withRaster({ groups, active, lastActive: [active, ...new Set(lane)] }, raster);
  return o.maximized === active && groups.length > 1 ? { ...s, maximized: active } : s;
}

// ── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The commands of the groups (identifiers, titles and Mac shortcuts like VS Code 1.143; the titles in VS Code's wording, with
 *  "View:" like the other commands of the palette). `keys` are also bound by the editor (command table, registered in
 *  components/code/editor-groups-connection.ts); `chord` is the second key after ⌘K — only the host (CodePane) catches it, CodeMirror binds
 *  no chords. `onlyKey`: in VS Code only a key rule, not in the palette (⌘2–⌘8). Whether a command is in the palette is asked by the host
 *  (`useGroupsKeys` `can` — "Markdown: …" only on a markdown file, "… Move" only with an editor in front). */
export const GROUPS_COMMANDS = [
  { id: "workbench.action.splitEditor", title: "View: Split Editor", shortcut: "⌘\\", keys: ["Mod-\\"] },
  // ⌘K ⌘\ is carried by all five in VS Code; the last registered wins (KeybindingResolver) — "Split Editor Down" (`groupKey`).
  { id: "workbench.action.splitEditorOrthogonal", title: "View: Split Editor Orthogonal", shortcut: "⌘K ⌘\\", chord: "Mod-\\" },
  { id: "workbench.action.splitEditorLeft", title: "View: Split Editor Left", shortcut: "⌘K ⌘\\", chord: "Mod-\\" },
  { id: "workbench.action.splitEditorRight", title: "View: Split Editor Right", shortcut: "⌘K ⌘\\", chord: "Mod-\\" },
  { id: "workbench.action.splitEditorUp", title: "View: Split Editor Up", shortcut: "⌘K ⌘\\", chord: "Mod-\\" },
  { id: "workbench.action.splitEditorDown", title: "View: Split Editor Down", shortcut: "⌘K ⌘\\", chord: "Mod-\\" },
  { id: "workbench.action.focusFirstEditorGroup", title: "View: Focus First Editor Group", shortcut: "⌘1", keys: ["Mod-1"] },
  { id: "workbench.action.focusSecondEditorGroup", shortcut: "⌘2", keys: ["Mod-2"], onlyKey: true },
  { id: "workbench.action.focusThirdEditorGroup", shortcut: "⌘3", keys: ["Mod-3"], onlyKey: true },
  { id: "workbench.action.focusFourthEditorGroup", shortcut: "⌘4", keys: ["Mod-4"], onlyKey: true },
  { id: "workbench.action.focusFifthEditorGroup", shortcut: "⌘5", keys: ["Mod-5"], onlyKey: true },
  { id: "workbench.action.focusSixthEditorGroup", shortcut: "⌘6", keys: ["Mod-6"], onlyKey: true },
  { id: "workbench.action.focusSeventhEditorGroup", shortcut: "⌘7", keys: ["Mod-7"], onlyKey: true },
  { id: "workbench.action.focusEighthEditorGroup", shortcut: "⌘8", keys: ["Mod-8"], onlyKey: true },
  { id: "workbench.action.focusLastEditorGroup", title: "View: Focus Last Editor Group" },
  { id: "workbench.action.focusNextGroup", title: "View: Focus Next Editor Group" },
  { id: "workbench.action.focusPreviousGroup", title: "View: Focus Previous Editor Group" },
  // The other ways of VS Code between the groups (identifiers and keys as there; `keysMac` applies on the Mac instead of `keys`).
  { id: "workbench.action.focusLeftGroup", title: "View: Focus Left Editor Group", shortcut: "⌘K ⌘←", chord: "Mod-ArrowLeft" },
  { id: "workbench.action.focusRightGroup", title: "View: Focus Right Editor Group", shortcut: "⌘K ⌘→", chord: "Mod-ArrowRight" },
  { id: "workbench.action.focusAboveGroup", title: "View: Focus Editor Group Above", shortcut: "⌘K ⌘↑", chord: "Mod-ArrowUp" },
  { id: "workbench.action.focusBelowGroup", title: "View: Focus Editor Group Below", shortcut: "⌘K ⌘↓", chord: "Mod-ArrowDown" },
  { id: "workbench.action.moveEditorToPreviousGroup", title: "View: Move Editor into Previous Group", shortcut: "⌃⌘←", keys: ["Ctrl-Alt-ArrowLeft"], keysMac: ["Ctrl-Meta-ArrowLeft"] },
  { id: "workbench.action.moveEditorToNextGroup", title: "View: Move Editor into Next Group", shortcut: "⌃⌘→", keys: ["Ctrl-Alt-ArrowRight"], keysMac: ["Ctrl-Meta-ArrowRight"] },
  { id: "workbench.action.moveEditorToLeftGroup", title: "View: Move Editor into Left Group" },
  { id: "workbench.action.moveEditorToRightGroup", title: "View: Move Editor into Right Group" },
  { id: "workbench.action.moveEditorToAboveGroup", title: "View: Move Editor into Group Above" },
  { id: "workbench.action.moveEditorToBelowGroup", title: "View: Move Editor into Group Below" },
  { id: "workbench.action.moveEditorToFirstGroup", title: "View: Move Editor into First Group", shortcut: "⌃⌘1", keys: ["Shift-Alt-1"], keysMac: ["Ctrl-Meta-1"] },
  { id: "workbench.action.moveEditorToLastGroup", title: "View: Move Editor into Last Group", shortcut: "⌃⌘9", keys: ["Shift-Alt-9"], keysMac: ["Ctrl-Meta-9"] },
  { id: "workbench.action.moveActiveEditorGroupLeft", title: "View: Move Editor Group Left", shortcut: "⌘K ←", chord: "ArrowLeft" },
  { id: "workbench.action.moveActiveEditorGroupRight", title: "View: Move Editor Group Right", shortcut: "⌘K →", chord: "ArrowRight" },
  { id: "workbench.action.moveActiveEditorGroupUp", title: "View: Move Editor Group Up", shortcut: "⌘K ↑", chord: "ArrowUp" },
  { id: "workbench.action.moveActiveEditorGroupDown", title: "View: Move Editor Group Down", shortcut: "⌘K ↓", chord: "ArrowDown" },
  { id: "workbench.action.joinTwoGroups", title: "View: Join Editor Group with Next Group" },
  { id: "workbench.action.joinAllGroups", title: "View: Join All Editor Groups" },
  { id: "workbench.action.toggleMaximizeEditorGroup", title: "View: Toggle Maximize Editor Group", shortcut: "⌘K ⌘M", chord: "Mod-m" },
  { id: "workbench.action.evenEditorWidths", title: "View: Reset Editor Group Sizes" },
  // VS Code lists these three without a category ("Increase/Decrease Editor Width", "Toggle Vertical/Horizontal Editor Layout").
  { id: "workbench.action.increaseViewWidth", title: "Increase Editor Width" },
  { id: "workbench.action.decreaseViewWidth", title: "Decrease Editor Width" },
  { id: "workbench.action.toggleEditorGroupLayout", title: "Toggle Vertical/Horizontal Editor Layout", shortcut: "⌥⌘0", keys: ["Shift-Alt-0"], keysMac: ["Mod-Alt-0"] },
  { id: "workbench.action.editorLayoutSingle", title: "View: Single Column Editor Layout" },
  { id: "workbench.action.editorLayoutTwoColumns", title: "View: Two Columns Editor Layout" },
  { id: "workbench.action.editorLayoutThreeColumns", title: "View: Three Columns Editor Layout" },
  { id: "workbench.action.editorLayoutTwoRows", title: "View: Two Rows Editor Layout" },
  { id: "workbench.action.editorLayoutThreeRows", title: "View: Three Rows Editor Layout" },
  { id: "workbench.action.editorLayoutTwoByTwoGrid", title: "View: Grid Editor Layout (2x2)" },
  { id: "workbench.action.editorLayoutTwoColumnsBottom", title: "View: Two Columns Bottom Editor Layout" },
  { id: "workbench.action.editorLayoutTwoRowsRight", title: "View: Two Rows Right Editor Layout" },
  { id: "workbench.action.closeEditorsInGroup", title: "View: Close All Editors in Group", shortcut: "⌘K W", chord: "w" },
  { id: "workbench.action.closeUnmodifiedEditors", title: "View: Close Saved Editors in Group", shortcut: "⌘K U", chord: "u" },
  { id: "workbench.action.keepEditor", title: "View: Keep Editor", shortcut: "⌘K Enter", chord: "Enter" },
  // ⌘K ⌘W closes ALL editors (VS Code `closeAllEditors`), ⌘K ⇧⌘W all groups (`closeAllGroups`).
  { id: "workbench.action.closeAllEditors", title: "View: Close All Editors", shortcut: "⌘K ⌘W", chord: "Mod-w" },
  { id: "workbench.action.closeAllGroups", title: "View: Close All Editor Groups", shortcut: "⌘K ⇧⌘W", chord: "Mod-Shift-w" },
  // The preview of a markdown file in the group next to it (VS Code `markdown.showPreviewToSide`, only on markdown).
  { id: "markdown.showPreviewToSide", title: "Markdown: Open Preview to the Side", shortcut: "⌘K V", chord: "v" },
] as const;
export type GroupsCommandId = (typeof GROUPS_COMMANDS)[number]["id"];
export const groupsCommand = (id: GroupsCommandId) => GROUPS_COMMANDS.find((b) => b.id === id)!;
/** The shortcut of a command (Mac symbols) — some have none (VS Code binds "Reset Sizes" to no key). */
export const shortcutOf = (id: GroupsCommandId): string | undefined => { const b = groupsCommand(id); return "shortcut" in b ? b.shortcut : undefined; };
/** ⌘1–⌘8: the number of the group of a focus command (VS Code `focusFirstEditorGroup` … `focusEighthEditorGroup`) — otherwise null. */
export const FOCUS_NUMBERS: readonly GroupsCommandId[] = [
  "workbench.action.focusFirstEditorGroup", "workbench.action.focusSecondEditorGroup", "workbench.action.focusThirdEditorGroup", "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup", "workbench.action.focusSixthEditorGroup", "workbench.action.focusSeventhEditorGroup", "workbench.action.focusEighthEditorGroup",
];
export const focusNumber = (id: GroupsCommandId): number | null => { const i = FOCUS_NUMBERS.indexOf(id); return i < 0 ? null : i + 1; };
/** Where a split command splits (VS Code: "Split Editor" by `workbench.editor.openSideBySideDirection` = right, "orthogonal" across it =
 *  down) — null: not a split command. */
export function partDirection(id: GroupsCommandId): Direction | null {
  switch (id) {
    case "workbench.action.splitEditor": case "workbench.action.splitEditorRight": return "right";
    case "workbench.action.splitEditorOrthogonal": case "workbench.action.splitEditorDown": return "bottom";
    case "workbench.action.splitEditorLeft": return "left";
    case "workbench.action.splitEditorUp": return "top";
    default: return null;
  }
}
/** Where a move command brings the active editor — null: no such command. */
export function editorTarget(id: GroupsCommandId): EditorTarget | null {
  switch (id) {
    case "workbench.action.moveEditorToPreviousGroup": return { location: "previous" };
    case "workbench.action.moveEditorToNextGroup": return { location: "next" };
    case "workbench.action.moveEditorToFirstGroup": return { location: "first" };
    case "workbench.action.moveEditorToLastGroup": return { location: "last" };
    case "workbench.action.moveEditorToLeftGroup": return { direction: "left" };
    case "workbench.action.moveEditorToRightGroup": return { direction: "right" };
    case "workbench.action.moveEditorToAboveGroup": return { direction: "top" };
    case "workbench.action.moveEditorToBelowGroup": return { direction: "bottom" };
    default: return null;
  }
}
/** The commands that change ONLY the state (focus, move and merge groups, layouts, sizes, maximize) as a step — `gid`
 *  is the group in which the command came. null: the command needs the host (split and move take the state of the view along,
 *  close asks about unsaved changes, "Width …" measures the area). */
export function statusStep(id: GroupsCommandId, gid: string): ((s: GroupsStatus) => GroupsStatus) | null {
  const seq = focusNumber(id);
  if (seq !== null) return (s) => focus(s, seq);
  if (id in LAYOUTS) return (s) => applyLayout(s, LAYOUTS[id as LayoutId]);
  switch (id) {
    case "workbench.action.focusLastEditorGroup": return (s) => focusLocation(s, "last");
    case "workbench.action.focusNextGroup": return (s) => focusLocation(s, "next");
    case "workbench.action.focusPreviousGroup": return (s) => focusLocation(s, "previous");
    case "workbench.action.focusLeftGroup": return (s) => focusNeighbor(s, "left");
    case "workbench.action.focusRightGroup": return (s) => focusNeighbor(s, "right");
    case "workbench.action.focusAboveGroup": return (s) => focusNeighbor(s, "top");
    case "workbench.action.focusBelowGroup": return (s) => focusNeighbor(s, "bottom");
    case "workbench.action.moveActiveEditorGroupLeft": return (s) => moveGroup(s, gid, "left");
    case "workbench.action.moveActiveEditorGroupRight": return (s) => moveGroup(s, gid, "right");
    case "workbench.action.moveActiveEditorGroupUp": return (s) => moveGroup(s, gid, "top");
    case "workbench.action.moveActiveEditorGroupDown": return (s) => moveGroup(s, gid, "bottom");
    case "workbench.action.joinTwoGroups": return (s) => connectWithNext(s, gid);
    case "workbench.action.joinAllGroups": return connectAll;
    case "workbench.action.toggleMaximizeEditorGroup": return toggleMaximize;
    case "workbench.action.evenEditorWidths": return distributeEqually;
    case "workbench.action.toggleEditorGroupLayout": return flipLayout;
    default: return null;
  }
}
/** The chord start (VS Code ⌘K). */
export const CHORD = "Mod-k";

/** What a key press means to the groups: a command, "chord" (⌘K — wait for the second key) or null. If a chord is waiting
 *  (`chordOpen`), only its second key counts; if several commands carry the same one, the last registered wins (VS Code
 *  KeybindingResolver); every other key ends it without a command (null). */
export function groupKey(e: KeyPress, chordOpen: boolean, mac: boolean): GroupsCommandId | "chord" | null {
  if (chordOpen) {
    for (let i = GROUPS_COMMANDS.length - 1; i >= 0; i--) { const b = GROUPS_COMMANDS[i]; if ("chord" in b && matchesKey(b.chord, e, mac)) return b.id; }
    return null;
  }
  if (matchesKey(CHORD, e, mac)) return "chord";
  for (const b of GROUPS_COMMANDS) if (keysOf(b, mac).some((t) => matchesKey(t, e, mac))) return b.id;
  return null;
}
/** The keys of a command on this platform (VS Code binds some differently on the Mac). */
export function keysOf(b: (typeof GROUPS_COMMANDS)[number], mac: boolean): readonly string[] {
  if (mac && "keysMac" in b) return b.keysMac;
  return "keys" in b ? b.keys : [];
}
/** A key press as text as VS Code names it in the chord ("⌘W", "X", "⇧⌘←") — for "The key combination (⌘K, X) is not a command." */
export function pressText(e: KeyPress, mac: boolean): string {
  const arrows: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
  const b = keyLabel(e);
  const name = b ? b.toUpperCase() : arrows[e.key] ?? (e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (mac) return `${e.ctrlKey ? "⌃" : ""}${e.altKey ? "⌥" : ""}${e.shiftKey ? "⇧" : ""}${e.metaKey ? "⌘" : ""}${name}`;
  return [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Meta", name].filter(Boolean).join("+");
}
/** The commands of the groups that act from the terminal (VS Code `DEFAULT_COMMANDS_TO_SKIP_SHELL`: ⌘1–⌘8 and "Focus Last
 *  Editor Group") — all other keys (⌘K clears there, ⌘\ splits the terminal, ⌃⌘←/→, ⌥Z) belong to the shell. */
export const TERMINAL_PASSTHROUGH: readonly GroupsCommandId[] = [...FOCUS_NUMBERS, "workbench.action.focusLastEditorGroup"];
/** Does the terminal leave this key to the workbench instead of giving it to the shell (xterm `attachCustomKeyEventHandler`, VS Code
 *  `commandsToSkipShell`)? Only the keys from `TERMINAL_PASSTHROUGH` — outside the Mac the shell would otherwise get Ctrl+2 as NUL. */
export function groupThroughTheTerminal(e: KeyPress, mac: boolean): boolean {
  const r = groupKey(e, false, mac);
  return r !== null && r !== "chord" && TERMINAL_PASSTHROUGH.includes(r);
}
/** How long a chord waits for its second key (VS Code: 5 s, then it is over). */
export const CHORD_DEADLINE_MS = 5000;
