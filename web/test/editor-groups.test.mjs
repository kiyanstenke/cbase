// The editor groups as in VS Code (a GRID of groups, no cap on their number):
//
// (1) The computations (lib/editor-groups.ts), EXECUTED: opening into the ACTIVE group, closing with `closeEmptyGroups` (the last tab
//     closes its group) and the trail of groups (the most recently active one becomes active), splitting in all four directions without a
//     cap with a FIXED editor, ⌘1–⌘8 (the next one is created empty right of the last), dragging a tab (move, ⌥ copies, at the edge splits
//     in that direction, the last tab of a group takes the group along), files from the explorer, the zone of a drop as in VS Code
//     (top/bottom by halves), sizes (drag, reset, width ±60), reload (version 2 with grid, version 1 is read; unreadable is unknown, not
//     empty), rename/fix in EVERY group, the keys with their chords, neighbours and locations, moving editors and groups, joining, the
//     eight layouts, flipping — and that every command of the table has a way.
// (2) The sources: CodePane draws the groups (EditorGroupsSurface, one view per group), catches keys and chords, does not ask on close
//     if the file stays open in the other group; the "…" menu as in VS Code via the ONE editor menu; the split button splits downwards
//     with ⌥; tab menu and menu of the empty group with the split entries of VS Code; a pointer press activates a group at once, the
//     inactive bar is dimmed; the surface takes drops in the capture phase (otherwise CodeMirror inserted the paths of an explorer drag as
//     text); separators from the grid computation; every new text has an English version. Also: maximize, neighbours, move, "Open to the
//     Side", chord timeout and status bar, terminal rule, focus after closing, the "…" menu and the tab menu exactly as in VS Code, the
//     drag bar of the panel, scrolling tabs, breadcrumbs per group, view state on split/reload, duplicate prompts for the same file in two
//     groups; groups sit in the DOM by id (a rebuild moves no node), ⌘K ⇧⌘W then closes the empty groups, ⌥⌘0 ends maximizing, a
//     restored state does not equalise, ⇧ hands a drop over a text editor to the editor (for tabs too), the zone fades in and moves as in
//     VS Code (only with allowed movement).
// (3) View state (lib/view-status.ts) and wrap per file (lib/wrap-per-file.ts), EXECUTED.
//
// Contract: there is no cap of two groups (`MAX_GROUPS`, `clampRatio`, `setRatio`, `moveToGroup`/`ToPage` are gone — `raster`,
// `pullSeparator`, `distributeEqually`, `moveEditor` instead); when the active group closes the most recently active one becomes active
// instead of the neighbour; ⌃⌘← in the first group creates one on the left (VS Code `addGroup(LEFT)`); ⌘K ⌘←/→ wrap around at the edge
// (VS Code `wrap`); a drop at the top/bottom edge splits upwards/downwards; "Open to the Side" and ⌘K V never fall back to the left, a new
// group is created on the right; the state is version 2; the split button is never disabled; from the terminal ⌘1–⌘8 and "Focus Last
// Editor Group" work (VS Code `commandsToSkipShell`).
//
// The grid itself (tree, sizes, neighbours, layouts) is checked by web/test/editor-raster.test.mjs.
//
// Each sabotage is a copy of the source with ONE changed spot (the spot appears exactly once, otherwise the sabotage is stale);
// the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/editor-groups.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

const SOURCE = read("src", "lib", "editor-groups.ts");
const SABOTAGES = {
  // Open
  "open into the first instead of the active group": { old: "const id = o.group && groupOf(s, o.group) ? o.group : activeGroup(s).id;", fresh: "const id = o.group && groupOf(s, o.group) ? o.group : s.groups[0].id;", catches: "open" },
  "open does not activate the group": { old: "unsaved: o.unsaved })), id);", fresh: "unsaved: o.unsaved })), s.active);", catches: "open" },
  "background brings to front": { old: "(l) => openInList(l, path, { fixed: true, background: true })", fresh: "(l) => openInList(l, path, { fixed: true })", catches: "open" },
  "background appended at the end": { old: "(l) => openInList(l, path, { fixed: true, background: true })", fresh: "(l) => ({ ...l, paths: [...l.paths, path] })", catches: "lane" },
  "trail dropped within the group": { old: "const listOf = (g: PathList): PathList => ({ paths: g.paths, active: g.active, preview: g.preview, ...(g.last ? { last: g.last } : {}) });", fresh: "const listOf = (g: PathList): PathList => ({ paths: g.paths, active: g.active, preview: g.preview });", catches: "lane" },
  "trail not maintained": { old: "  const fresh = withLane(raw);", fresh: "  const fresh = raw;", catches: "lane" },
  "rename loses the trail": { old: "...(l.last ? { last: l.last.map(form) } : {}), ", fresh: "", catches: "lane" },
  "drag loses the trail": { old: "return { ...l, paths: [...without.slice(0, i), path, ...without.slice(i)], active: path, preview };", fresh: "return { paths: [...without.slice(0, i), path, ...without.slice(i)], active: path, preview };", catches: "lane" },
  "reload forgets the trail": { old: "groups.push({ id: g.id, paths, active, preview, ...(last ? { last } : {}) });", fresh: "groups.push({ id: g.id, paths, active, preview });", catches: "lane" },
  "trail from foreign paths": { old: "typeof p === \"string\" && paths.includes(p)))] : null;", fresh: "typeof p === \"string\"))] : null;", catches: "lane" },
  "background opens twice": { old: "if (s.groups.some((g) => g.paths.includes(path))) return s;", fresh: "", catches: "open" },
  // Close
  "empty group stays": { old: "if (!fresh.paths.length && old.paths.length && s.groups.length > 1) return removeGroup(r, id);", fresh: "", catches: "close" },
  "delete only in the active group": { old: "for (const g of s.groups) for (const p of g.paths) if (hits(p))", fresh: "for (const g of [activeGroup(s)]) for (const p of g.paths) if (hits(p))", catches: "close" },
  "neighbour instead of the most recently active": { old: "activateGroup(s, mru[1])", fresh: "activateGroup(s, s.groups[s.groups.findIndex((x) => x.id === id) - 1]?.id ?? mru[1])", catches: "close" },
  "the closed one stays in the trail": { old: "lastActive: (without.lastActive ?? [without.active]).filter((x) => x !== id) }", fresh: "lastActive: without.lastActive ?? [without.active] }", catches: "close" },
  "closing throws the editors away": { old: "if (g.paths.length) return joinTogether(s, id, s.active === id ? mru[1] : mru[0]);", fresh: "", catches: "close" },
  "closing moves into itself": { old: "s.active === id ? mru[1] : mru[0]", fresh: "mru[0]", catches: "close" },
  "space does not go to the neighbour": { old: "const without = withRaster(r, R.remove(rasterOf(s), id), r.groups.filter((x) => x.id !== id));", fresh: "const without = { ...r, groups: r.groups.filter((x) => x.id !== id) };", catches: "close" },
  // Split
  "direction forgotten when splitting": { old: "const a = createGroup(s, id, direction)!;", fresh: "const a = createGroup(s, id, \"right\")!;", catches: "share" },
  "split editor as preview": { old: "(l) => ({ ...l, paths: [file], active: file, preview: null })", fresh: "(l) => ({ ...l, paths: [file], active: file, preview: file })", catches: "share" },
  "new group stays in the background": { old: "return activateGroup(r, a.fresh);", fresh: "return r;", catches: "share" },
  "created group becomes active": { old: "return { status: withRaster(withoutMaximization(s), R.insertClipboard(rasterOf(s), fresh, id, direction), [...s.groups, { id: fresh, ...EMPTY_LIST }]), fresh };", fresh: "return { state: { ...withRaster(withoutMaximization(s), R.insertClipboard(rasterOf(s), fresh, id, direction), [...s.groups, { id: fresh, ...EMPTY_LIST }]), active: fresh }, fresh };", catches: "share" },
  "new id collides": { old: "const newId = (ids: readonly string[]): string => { let n = 1; while (ids.includes(`g${n}`)) n++; return `g${n}`; };", fresh: "const newId = (ids: readonly string[]): string => `g${ids.length + 1}`;", catches: "share" },
  "the cap is back": { old: "export const canShare = (s: GroupsStatus, id: string): boolean => groupOf(s, id) !== null;", fresh: "export const canShare = (s: GroupsStatus, id: string): boolean => groupOf(s, id) !== null && s.groups.length < 2;", catches: "share" },
  "grid does not follow": { old: "  return { ...s, raster: r, groups: R.sheets(r).map((id) => after.get(id)).filter((g): g is Group => Boolean(g)) };", fresh: "  return { ...s, raster: r, groups: [...stock].filter((g) => R.sheets(r).includes(g.id)) };", catches: "share" },
  // Focus
  "⌘2 creates no group": { old: "if (seq - 1 !== s.groups.length) return s;", fresh: "return s;", catches: "focus" },
  "⌘4 also creates further away": { old: "if (seq - 1 !== s.groups.length) return s;", fresh: "", catches: "focus" },
  "⌘n beside the active instead of the last": { old: "createGroup(s, s.groups[s.groups.length - 1].id, \"right\")!", fresh: "createGroup(s, s.active, \"right\")!", catches: "focus" },
  "⌘n is ⌘1": { old: "if (seq !== null) return (s) => focus(s, seq);", fresh: "if (seq !== null) return (s) => focus(s, 1);", catches: "focus" },
  "tab click leaves the group inactive": { old: "return activateGroup(withList(s, id, (l) => (l.paths.includes(path) ? { ...l, active: path } : l)), id);", fresh: "return withList(s, id, (l) => (l.paths.includes(path) ? { ...l, active: path } : l));", catches: "focus" },
  "trail of groups not maintained": { old: "return { ...rest, active: id, lastActive: [id, ...[s.active, ...(s.lastActive ?? [])].filter((x, i, a) => x !== id && a.indexOf(x) === i)] };", fresh: "return { ...rest, active: id };", catches: "focus" },
  // Dragging a tab
  "move leaves the source": { old: "destination.id);\n  return copy ? r : close(r, from.id, turn.path);", fresh: "destination.id);\n  return r;", catches: "dragTab" },
  "⌥ moves": { old: "destination.id);\n  return copy ? r : close(r, from.id, turn.path);", fresh: "destination.id);\n  return close(r, from.id, turn.path);", catches: "dragTab" },
  "edge leaves the source": { old: "const r = parts(s, destination.id, target.zone, turn.path);\n    return copy ? r : close(r, from.id, turn.path);", fresh: "const r = parts(s, destination.id, target.zone, turn.path);\n    return r;", catches: "dragTab" },
  "edge splits only to the right": { old: "const r = parts(s, destination.id, target.zone, turn.path);", fresh: "const r = parts(s, destination.id, \"right\", turn.path);", catches: "dragTab" },
  "only tab splits its group": { old: "return !(turn && turn.group === group && g.paths.length <= 1);", fresh: "return true;", catches: "dragTab" },
  "edge does not split": { old: "if (target.zone !== \"middle\" && splittable(s, destination.id, copy ? null : turn)) {", fresh: "if (false) {", catches: "dragTab" },
  "last tab does not take the group along": { old: "if (!copy && from.id !== destination.id && from.paths.length === 1) return activateGroup(moveGroupTo(s, from.id, destination.id, target.zone), from.id);", fresh: "", catches: "dragTab" },
  "⌥ takes the group along": { old: "if (!copy && from.id !== destination.id && from.paths.length === 1)", fresh: "if (from.id !== destination.id && from.paths.length === 1)", catches: "dragTab" },
  "drop position ignored": { old: "const i = without.indexOf(before.path) + (before.afterwards ? 1 : 0);", fresh: "const i = without.length;", catches: "dragTab" },
  "target stays in the background": { old: "const r = activateGroup(withList(s, destination.id, (l) => place(l, turn.path, before)), destination.id);", fresh: "const r = withList(s, destination.id, (l) => place(l, turn.path, before));", catches: "dragTab" },
  // Files from the explorer
  "the last file in front": { old: "(l.paths.includes(list[0]) ? { ...l, active: list[0] } : l)), id);", fresh: "l), id);", catches: "dragFiles" },
  "edge opens no group": { old: "if (target.zone !== \"middle\" && splittable(s, target.group, null)) {", fresh: "if (false) {", catches: "dragFiles" },
  "files at the edge only to the right": { old: "r = parts(r, target.group, target.zone, list[0]);", fresh: "r = parts(r, target.group, \"right\", list[0]);", catches: "dragFiles" },
  "dropped preview stays preview": { old: "const preview = l.preview === path ? null : l.preview;", fresh: "const preview = l.preview;", catches: "dragFiles" },
  "order reversed": { old: "before = { path: p, afterwards: true }; }", fresh: "before = { path: p, afterwards: false }; }", catches: "dragFiles" },
  "duplicates stay": { old: "const list = [...new Set(paths)].filter(", fresh: "const list = [...paths].filter(", catches: "dragFiles" },
  // Zone
  "edge too wide": { old: "const ex = width * MARGIN_SHARE, ey = height * MARGIN_SHARE;", fresh: "const ex = width * 0.4, ey = height * 0.4;", catches: "zone" },
  "splits without permission": { old: "if (!canSplit || !(width > 0) || !(height > 0)) return \"middle\";", fresh: "if (!(width > 0) || !(height > 0)) return \"middle\";", catches: "zone" },
  "top and bottom missing": { old: "return y < height / 2 ? \"top\" : \"bottom\";", fresh: "return \"middle\";", catches: "zone" },
  "top and bottom swapped": { old: "y < height / 2 ? \"top\" : \"bottom\"", fresh: "y < height / 2 ? \"bottom\" : \"top\"", catches: "zone" },
  "the boundary is middle": { old: "if (x > ex && x < width - ex && y > ey && y < height - ey) return \"middle\";", fresh: "if (x >= ex && x <= width - ex && y >= ey && y <= height - ey) return \"middle\";", catches: "zone" },
  // Sizes
  "same state becomes new": { old: "const withSizes = (s: GroupsStatus, r: R.Raster): GroupsStatus => (sameRaster(r, rasterOf(s)) ? s : { ...s, raster: r });", fresh: "const withSizes = (s: GroupsStatus, r: R.Raster): GroupsStatus => ({ ...s, raster: r });", catches: "sizes" },
  "reset keeps the maximization": { old: "withoutMaximization(withSizes(s, R.equalDistributed(rasterOf(s))))", fresh: "withSizes(s, R.equalDistributed(rasterOf(s)))", catches: "sizes" },
  "reset does nothing": { old: "R.equalDistributed(rasterOf(s))", fresh: "rasterOf(s)", catches: "sizes" },
  "double click does not equalise": { old: "withSizes(s, R.equallyDistributedAt(rasterOf(s), branch))", fresh: "s", catches: "sizes" },
  "drag without pull": { old: "withSizes(start, R.pull(rasterOf(start), branch, index, distance, length))", fresh: "start", catches: "sizes" },
  "equalising without effect": { old: "return n === r ? s : withSizes(s, n);", fresh: "return s;", catches: "sizes" },
  "equalising always rewrites": { old: "return n === r ? s : withSizes(s, n);", fresh: "return { ...s, raster: n };", catches: "sizes" },
  "width on the wrong axis": { old: "R.changeSize(rasterOf(s), id, \"sideBySide\", delta, width, height)", fresh: "R.changeSize(rasterOf(s), id, \"mutually\", delta, width, height)", catches: "sizes" },
  // Reload
  "unreadable as empty": { old: "if (!groups.length) return null;", fresh: "if (!groups.length) return BEGINNING;", catches: "storage" },
  "foreign active": { old: "const active = typeof g.active === \"string\" && paths.includes(g.active) ? g.active : paths[0] ?? null;", fresh: "const active = typeof g.active === \"string\" ? g.active : paths[0] ?? null;", catches: "storage" },
  "version unchecked": { old: "(o.v !== 1 && o.v !== 2) || ", fresh: "", catches: "storage" },
  "duplicate id": { old: "|| groups.some((y) => y.id === g.id)) continue;", fresh: ") continue;", catches: "storage" },
  "grid not remembered": { old: "const raster = o.v === 1 ? R.queue(ids, \"sideBySide\", v1) : R.rasterFrom(o.raster, ids);", fresh: "const raster = R.queue(ids);", catches: "storage" },
  "ratio of version 1 forgotten": { old: "R.queue(ids, \"sideBySide\", v1)", fresh: "R.queue(ids, \"sideBySide\")", catches: "storage" },
  "broken grid as a row": { old: "R.rasterFrom(o.raster, ids);", fresh: "(R.rasterFrom(o.raster, ids) ?? R.queue(ids));", catches: "storage" },
  "trail of groups gone after reload": { old: "lastActive: [active, ...new Set(lane)]", fresh: "lastActive: [active]", catches: "storage" },
  "trail of groups not remembered": { old: "lastActive: lastActiveGroups(s).filter(", fresh: "lastActiveX: lastActiveGroups(s).filter(", catches: "storage" },
  // Paths
  "only the active group moves": { old: "for (const g of s.groups) {\n    r = withList(r, g.id, (l) => {", fresh: "for (const g of [activeGroup(s)]) {\n    r = withList(r, g.id, (l) => {", catches: "paths" },
  "active does not follow": { old: "const active = l.active === null ? null : form(l.active),", fresh: "const active = l.active,", catches: "paths" },
  "typing fixes only the active group": { old: "if (!id || g.id === id)", fresh: "if (g.id === (id ?? s.active))", catches: "paths" },
  "unsaved preview stays": { old: "if (g.preview !== null && unsaved(g.preview))", fresh: "if (false)", catches: "paths" },
  // Keys
  "chord with modifier": { old: "if (\"chord\" in b && matchesKey(b.chord, e, mac)) return b.id;", fresh: "if (\"chord\" in b && matchesKey(b.chord, { ...e, metaKey: false, ctrlKey: false }, mac)) return b.id;", catches: "keys" },
  "no ⌘K": { old: "if (matchesKey(CHORD, e, mac)) return \"chord\";", fresh: "", catches: "keys" },
  "chord takes the editor keys": { old: "    return null;\n  }\n  if (matchesKey(CHORD", fresh: "  }\n  if (matchesKey(CHORD", catches: "keys" },
  "keys missing": { old: "for (const b of GROUPS_COMMANDS) if (keysOf(b, mac).some((t) => matchesKey(t, e, mac))) return b.id;", fresh: "", catches: "keys" },
  "in a chord the first wins": { old: "for (let i = GROUPS_COMMANDS.length - 1; i >= 0; i--) { const b = GROUPS_COMMANDS[i];", fresh: "for (let i = 0; i < GROUPS_COMMANDS.length; i++) { const b = GROUPS_COMMANDS[i];", catches: "keys" },
  "Mac keys everywhere": { old: "if (mac && \"keysMac\" in b) return b.keysMac;", fresh: "if (\"keysMac\" in b) return b.keysMac;", catches: "keys" },
  "⌘K ⌘W swallowed": { old: "chord: \"Mod-w\" }", fresh: "chord: \"Mod-F24\" }", catches: "keys" },
  "terminal takes ⌘\\\\": { old: "TERMINAL_PASSTHROUGH: readonly GroupsCommandId[] = [", fresh: "TERMINAL_PASSTHROUGH: readonly GroupsCommandId[] = [\"workbench.action.splitEditor\", ", catches: "keys" },
  "terminal only ⌘1/⌘2": { old: "[...FOCUS_NUMBERS, \"workbench.action.focusLastEditorGroup\"]", fresh: "[\"workbench.action.focusFirstEditorGroup\", \"workbench.action.focusSecondEditorGroup\"]", catches: "keys" },
  "chord text without label": { old: "const name = b ? b.toUpperCase() :", fresh: "const name = false ? \"\" :", catches: "keys" },
  "terminal lets everything through": { old: "return r !== null && r !== \"chord\" && TERMINAL_PASSTHROUGH.includes(r);", fresh: "return r !== null;", catches: "keys" },
  // Commands
  "layouts without a way": { old: "if (id in LAYOUTS) return (s) => applyLayout(s, LAYOUTS[id as LayoutId]);", fresh: "", catches: "commands" },
  "flipping without a way": { old: "case \"workbench.action.toggleEditorGroupLayout\": return flipLayout;", fresh: "", catches: "commands" },
  "orthogonal splits right": { old: "case \"workbench.action.splitEditorOrthogonal\": case \"workbench.action.splitEditorDown\": return \"bottom\";", fresh: "case \"workbench.action.splitEditorOrthogonal\": return \"right\"; case \"workbench.action.splitEditorDown\": return \"bottom\";", catches: "commands" },
  "previous is next": { old: "case \"workbench.action.moveEditorToPreviousGroup\": return { location: \"previous\" };", fresh: "case \"workbench.action.moveEditorToPreviousGroup\": return { location: \"next\" };", catches: "commands" },
  "above focuses below": { old: "case \"workbench.action.focusAboveGroup\": return (s) => focusNeighbor(s, \"top\");", fresh: "case \"workbench.action.focusAboveGroup\": return (s) => focusNeighbor(s, \"bottom\");", catches: "commands" },
  "group to the left goes right": { old: "case \"workbench.action.moveActiveEditorGroupLeft\": return (s) => moveGroup(s, gid, \"left\");", fresh: "case \"workbench.action.moveActiveEditorGroupLeft\": return (s) => moveGroup(s, gid, \"right\");", catches: "commands" },
  // The remaining ways of VS Code
  "maximization stays on group change": { old: "const { maximized: _m, ...rest } = s;\n  return { ...rest, active: id, lastActive:", fresh: "const rest = s;\n  return { ...rest, active: id, lastActive:", catches: "ways" },
  "maximizing with one group": { old: "return s.groups.length > 1 ? { ...s, maximized: activeGroup(s).id } : s;", fresh: "return { ...s, maximized: activeGroup(s).id };", catches: "ways" },
  "maximization forgotten": { old: ", ...(m ? { maximized: m } : {})", fresh: "", catches: "ways" },
  "neighbour instead of direction": { old: "const n = neighbor(s, s.active, direction, true);\n  return n ? activateGroup(s, n.id) : s;", fresh: "const n = s.groups.find((g) => g.id !== s.active) ?? null;\n  return n ? activateGroup(s, n.id) : s;", catches: "ways" },
  "no wrap-around": { old: "neighbor(s, s.active, direction, true)", fresh: "neighbor(s, s.active, direction)", catches: "ways" },
  "neighbours not by trail": { old: "n.sort((a, b) => lane.indexOf(a) - lane.indexOf(b));", fresh: "", catches: "ways" },
  "locations without wrap-around": { old: "const n = groupAtLocation(s, s.active, location, true);", fresh: "const n = groupAtLocation(s, s.active, location);", catches: "ways" },
  "previous creates on the right": { old: "target.location === \"next\" ? \"right\" : \"left\"", fresh: "\"right\"", catches: "ways" },
  "direction as location": { old: "let to = \"direction\" in target ? neighbor(s, id, target.direction) : groupAtLocation(s, id, target.location);", fresh: "let to = \"direction\" in target ? groupAtLocation(s, id, \"next\") : groupAtLocation(s, id, target.location);", catches: "ways" },
  "move copies": { old: "return dropTab(r, { group: id, path }, { group: to.id, zone: \"middle\" });", fresh: "return dropTab(r, { group: id, path }, { group: to.id, zone: \"middle\" }, true);", catches: "ways" },
  "beside as preview": { old: "if (n) return open(s, path, { fixed: true, group: n.id });", fresh: "if (n) return open(s, path, { group: n.id });", catches: "ways" },
  "beside in the active one": { old: "const x = createGroup(s, a.id, \"right\")!;\n  return open(x.status, path, { fixed: true, group: x.fresh });", fresh: "return open(s, path, { fixed: true });", catches: "ways" },
  "beside falls back to the left": { old: "const n = neighbor(s, a.id, \"right\");", fresh: "const n = neighbor(s, a.id, \"right\") ?? neighbor(s, a.id, \"left\");", catches: "ways" },
  "moving a group without fallback": { old: "const queue: Direction[] = [direction, ...(R.orientationOfTheDirection(direction) === \"sideBySide\" ? ([\"top\", \"bottom\"] as const) : ([\"left\", \"right\"] as const))];", fresh: "const queue: Direction[] = [direction];", catches: "ways" },
  "group into the fallback direction": { old: "if (z) return activateGroup(moveGroupTo(s, id, z.id, direction), id);", fresh: "if (z) return activateGroup(moveGroupTo(s, id, z.id, x), id);", catches: "ways" },
  "joins to the left first": { old: "[\"right\", \"bottom\", \"left\", \"top\"] as const", fresh: "[\"left\", \"bottom\", \"right\", \"top\"] as const", catches: "ways" },
  "active editor of the source not in front": { old: "active: front ?? l.active ?? paths[0] ?? null", fresh: "active: l.active ?? paths[0] ?? null", catches: "ways" },
  "joining duplicates": { old: "...l.paths.filter((p) => !q.paths.includes(p)), ...q.paths", fresh: "...l.paths, ...q.paths", catches: "ways" },
  "only one joined": { old: "for (const id of lastActiveGroups(s)) if (id !== s.active) r = joinTogether(r, id, s.active);", fresh: "const id = lastActiveGroups(s)[1]; if (id) r = joinTogether(r, id, s.active);", catches: "ways" },
  "joins by grid instead of trail": { old: "for (const id of lastActiveGroups(s)) if (id !== s.active)", fresh: "for (const id of s.groups.map((g) => g.id)) if (id !== s.active)", catches: "ways" },
  "layout loses the surplus ones": { old: "if (n < old.length) for (const g of old.slice(n)) r = joinTogether(r, g.id, old[n - 1].id);", fresh: "", catches: "ways" },
  "layout moves into the first": { old: "r = joinTogether(r, g.id, old[n - 1].id);", fresh: "r = joinTogether(r, g.id, old[0].id);", catches: "ways" },
  "layout creates none": { old: "while (ids.length < n) { const id = newId(ids); ids.push(id); alongside.push({ id, ...EMPTY_LIST }); }", fresh: "", catches: "ways" },
  "flipping does not flip": { old: "R.flip(rasterOf(s))", fresh: "rasterOf(s)", catches: "ways" },
  // Drawing
  "flipping keeps the maximization": { old: "withRaster(withoutMaximization(s), R.flip(", fresh: "withRaster(s, R.flip(", catches: "ways" },
  "empty groups closed forwards": { old: "R.sheets(rasterOf(s)).reverse()", fresh: "R.sheets(rasterOf(s))", catches: "close" },
  "groups with editors drop": { old: "if (groupOf(r, id)?.paths.length === 0) r = removeGroup(r, id);", fresh: "r = removeGroup(r, id);", catches: "close" },
  "DOM in grid order": { old: "return [...groups].sort((a, b) => a.id.localeCompare(b.id, \"en\", { numeric: true }));", fresh: "return [...groups];", catches: "ways" },
  "id by characters": { old: "{ numeric: true }", fresh: "{ numeric: false }", catches: "ways" },
};

// ── Compile: the source, its dependencies (lib/editor-raster.ts, lib/tab-bar.ts with lib/chat-tabs.ts and lib/explorer-decoration.ts,
//    lib/commandPalette.ts with lib/api/lsp.ts and a network-free stand-in for core.ts) and one copy per sabotage, in ONE tsc run. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-editor-groups-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
for (const d of ["editor-raster.ts", "tab-bar.ts", "chat-tabs.ts", "explorer-decoration.ts", "commandPalette.ts"]) fs.writeFileSync(path.join(src, d), read("src", "lib", d));
fs.writeFileSync(path.join(src, "api", "lsp.ts"), read("src", "lib", "api", "lsp.ts"));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in test: ${p}`); }\n");
fs.writeFileSync(path.join(src, "editor-groups.ts"), SOURCE);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `editor-groups-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...files(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "editor-groups.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("editor-groups.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── The checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const L = (id, paths, active = paths[0] ?? null, preview = null) => ({ id, paths, active, preview });
const ids = (s) => s.groups.map((g) => g.id);
const pathsOf = (s) => s.groups.map((g) => g.paths);
// The grid in shorthand (lib/editor-raster.ts): B = sheet, Z = branch, W = grid.
const B = (id, share) => ({ kind: "sheet", id, share });
const Z = (share, ...children) => ({ kind: "branch", share, children });
const W = (situation, ...children) => ({ situation, root: Z(1, ...children) });
const NB = "sideBySide", UN = "mutually";
// The "most recently used" trail is checked by `lane` on its own; the other checks compare states and lists without it. Shares rounded to
// six places (the computation divides by 3).
const withoutLane = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x, (k, v) => (k === "last" ? undefined : typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v))));
const equal = (a, b, m) => assert.deepEqual(withoutLane(a), withoutLane(b), m);
const CHECKS = {
  open(G) {
    let s = G.open(G.BEGINNING, "a.ts");
    equal(s.groups, [L("g1", ["a.ts"], "a.ts", "a.ts")], "a click opens as a preview in the only group");
    s = G.parts(s, "g1");
    s = G.open(s, "b.ts");
    equal(G.groupOf(s, "g2").paths, ["a.ts", "b.ts"], "opening goes into the ACTIVE group");
    equal(G.groupOf(s, "g1").paths, ["a.ts"], "the other group stays");
    s = G.open(s, "c.ts", { group: "g1" });
    assert.equal(s.active, "g1", "opening in a group activates it");
    equal(G.groupOf(s, "g1"), L("g1", ["c.ts"], "c.ts", "c.ts"), "the preview of THIS group is replaced");
    equal(G.allOpen(s), ["c.ts", "a.ts", "b.ts"], "each file once, in group order");
    const h = G.openInBackground(s, "d.ts");
    equal(G.groupOf(h, "g1"), L("g1", ["c.ts", "d.ts"], "c.ts", "c.ts"), "in the background: right of the active tab of the active group, nothing comes to the front");
    assert.equal(G.openInBackground(s, "b.ts"), s, "already open (in any group): same state");
    equal(G.open(G.BEGINNING, "a.ts", { group: "gx" }).groups[0].paths, ["a.ts"], "an unknown group: the active one");
  },
  close(G) {
    const two = { groups: [L("g1", ["a.ts"]), L("g2", ["a.ts", "b.ts"], "b.ts")], active: "g1" };
    let s = G.close(two, "g1", "a.ts");
    equal(ids(s), ["g2"], "the last tab closes its group (closeEmptyGroups)");
    assert.equal(s.active, "g2", "the other one becomes active");
    equal(s.groups[0].paths, ["a.ts", "b.ts"], "the same file stays open in the other group");
    equal(G.rasterOf(s), W(NB, B("g2", 1)), "its space goes to the neighbour");
    s = G.close(G.close(s, "g2", "a.ts"), "g2", "b.ts");
    equal(s.groups, [L("g2", [])], "the only group stays, empty");
    const r = G.close(two, "g2", "b.ts");
    equal(G.groupOf(r, "g2"), L("g2", ["a.ts"]), "only in THIS group; the neighbour comes to the front");
    equal(G.groupOf(r, "g1"), two.groups[0]);
    // ⌘2 creates an empty group — it stays until it is closed.
    const empty = G.focus(G.open(G.BEGINNING, "a.ts"), 2);
    assert.equal(G.formPaths(empty, (p) => p), empty, "a group created empty stays");
    equal(ids(G.removeGroup(empty, "g2")), ["g1"]);
    assert.equal(G.removeGroup(empty, "g2").active, "g1", "the closed one was active: the previously active one");
    assert.equal(G.removeGroup(G.BEGINNING, "g1"), G.BEGINNING, "the only group stays");
    const way = G.remove(two, (p) => p === "a.ts");
    equal(way.groups, [L("g2", ["b.ts"])], "deleted: closed in EVERY group, the empty one closes itself");
    assert.equal(way.active, "g2");
    // When the active one closes, the MOST RECENTLY active one becomes active (VS Code `mostRecentActiveGroups`) — not the neighbour; the closed
    // one drops out of the group trail, its space goes to the neighbour before it.
    const three = { groups: [L("g1", ["a.ts"]), L("g2", ["b.ts"]), L("g3", [])], active: "g3", lastActive: ["g3", "g1", "g2"] };
    const without3 = G.removeGroup(three, "g3");
    assert.equal(without3.active, "g1", "the most recently active one becomes active, not the neighbour");
    assert.deepEqual(without3.lastActive, ["g1", "g2"], "the closed one stays in the group trail");
    equal(G.rasterOf(without3), W(NB, B("g1", 0.5), B("g2", 0.5)));
    const four = { groups: [L("g1", ["a.ts"]), L("g2", ["b.ts"]), L("g3", ["c.ts"]), L("g4", ["d.ts"])], active: "g1", raster: W(NB, Z(0.5, B("g1", 0.5), B("g2", 0.5)), Z(0.5, B("g3", 0.5), B("g4", 0.5))) };
    equal(G.rasterOf(G.close(four, "g2", "b.ts")), W(NB, B("g1", 0.5), Z(0.5, B("g3", 0.5), B("g4", 0.5))), "one leaves the 2×2: its column stays with the other");
    // Closing a group WITH editors: they move into the most recently active one, the active one in front (VS Code `removeGroup` → `mergeGroup`).
    const full = { groups: [L("g1", ["a.ts"]), L("g2", ["b.ts", "c.ts"], "c.ts")], active: "g2", lastActive: ["g2", "g1"] };
    const to = G.removeGroup(full, "g2");
    equal([to.groups, to.active], [[L("g1", ["a.ts", "b.ts", "c.ts"], "c.ts")], "g1"], "\"Close Group\" with editors does not lose them");
    // ⌘K ⇧⌘W (VS Code `CloseAllEditorGroupsAction.doCloseAll`): after the editors every EMPTY group drops, backwards in the grid
    // (`groupsToClose`) — the only one stays, i.e. the first of the grid; a group with editors (an abort left it open) stays.
    const allEmpty = G.removeEmptyGroups({ groups: [L("g1", []), L("g2", []), L("g3", [])], active: "g2", lastActive: ["g2", "g3", "g1"] });
    assert.deepEqual([ids(allEmpty), allEmpty.active], [["g1"], "g1"], "all empty: the first of the grid stays");
    const mixed = G.removeEmptyGroups({ groups: [L("g1", []), L("g2", ["a.ts"]), L("g3", [])], active: "g1" });
    assert.deepEqual([ids(mixed), mixed.active, pathsOf(mixed)], [["g2"], "g2", [["a.ts"]]], "the one with editors stays, the empty ones drop");
    assert.equal(G.removeEmptyGroups(G.BEGINNING), G.BEGINNING, "the only group stays");
  },
  share(G) {
    const one = { groups: [L("g1", ["a.ts", "b.ts"], "b.ts", "b.ts")], active: "g1" };
    const s = G.parts(one, "g1");
    equal(s.groups, [one.groups[0], L("g2", ["b.ts"])], "⌘\\: the active editor FIXED into a new group on the right; the old one keeps it");
    assert.equal(s.active, "g2", "the new one becomes active");
    equal(G.rasterOf(s), W(NB, B("g1", 0.5), B("g2", 0.5)), "half and half");
    const left = G.parts(one, "g1", "left", "a.ts");
    equal(left.groups, [L("g2", ["a.ts"]), one.groups[0]], "split left: the new group is on the left, with THIS tab");
    assert.equal(left.active, "g2");
    equal(G.rasterOf(G.parts(one, "g1", "bottom")), W(UN, B("g1", 0.5), B("g2", 0.5)), "split down: the groups lie one below the other");
    const top = G.parts(one, "g1", "top");
    equal([ids(top), G.rasterOf(top)], [["g2", "g1"], W(UN, B("g2", 0.5), B("g1", 0.5))], "split up: the new one above");
    equal(G.parts(G.BEGINNING, "g1").groups[1], L("g2", []), "an empty group splits empty (VS Code)");
    // No cap: a third column, all equal (splitSizing auto); nested to the 2×2.
    const three = G.parts(s, "g2");
    equal([ids(three), G.rasterOf(three)], [["g1", "g2", "g3"], W(NB, B("g1", 1 / 3), B("g2", 1 / 3), B("g3", 1 / 3))], "three columns");
    assert.equal(G.canShare(three, "g3"), true, "splitting always works");
    assert.equal(G.canShare(three, "gx"), false, "an unknown group does not split");
    assert.equal(G.parts(three, "gx"), three);
    const four = G.parts(G.parts(s, "g1", "bottom"), "g2", "bottom");
    equal([ids(four), G.rasterOf(four)], [["g1", "g3", "g2", "g4"], W(NB, Z(0.5, B("g1", 0.5), B("g3", 0.5)), Z(0.5, B("g2", 0.5), B("g4", 0.5)))], "2×2: the groups in grid order");
    // "New group" (VS Code addGroup): empty, NOT active; the id is the smallest free one; a maximization ends.
    const on = G.createGroup(s, "g1", "bottom");
    assert.deepEqual([on.fresh, on.status.active, G.groupOf(on.status, on.fresh)?.paths], ["g3", "g2", []], "addGroup: empty and not active");
    assert.equal(G.createGroup(s, "gx", "right"), null);
    assert.deepEqual(ids(G.parts({ groups: [L("g1", ["a.ts"]), L("g3", ["b.ts"])], active: "g1" }, "g1")), ["g1", "g2", "g3"], "the smallest free id");
    assert.equal(G.parts({ ...s, maximized: "g2" }, "g2").maximized, undefined, "splitting ends the maximization");
  },
  focus(G) {
    const one = G.open(G.BEGINNING, "a.ts");
    assert.equal(G.focus(one, 1), one, "⌘1 on the already active one: same state");
    const two = G.focus(one, 2);
    equal(two.groups.map((g) => [g.id, g.paths]), [["g1", ["a.ts"]], ["g2", []]], "⌘2 without a second group: it is created empty on the right (VS Code)");
    assert.equal(two.active, "g2");
    assert.equal(G.focus(one, 3), one, "⌘3 without a second: nothing (only the next one is created)");
    const three = G.focus(G.activateGroup(two, "g1"), 3);
    assert.deepEqual([ids(three), three.active], [["g1", "g2", "g3"], "g3"], "⌘3: right of the LAST group, not beside the active one");
    assert.equal(G.focus(two, 1).active, "g1");
    assert.deepEqual(G.lastActiveGroups(G.activateGroup(three, "g2")), ["g2", "g3", "g1"], "the group trail: most recently active first (VS Code MOST_RECENTLY_ACTIVE)");
    // ⌘1–⌘8: the n-th group in grid order.
    let eight = one;
    for (let n = 2; n <= 8; n++) eight = G.focus(eight, n);
    assert.equal(eight.groups.length, 8, "eight groups");
    G.FOCUS_NUMBERS.forEach((id, i) => assert.equal(G.statusStep(id, "g1")(G.activateGroup(eight, "g1")).active, eight.groups[i].id, `⌘${i + 1}`));
    assert.equal(G.focusNumber("workbench.action.focusFifthEditorGroup"), 5);
    const s = G.parts(G.open(G.open(G.BEGINNING, "a.ts", { fixed: true }), "b.ts"), "g1");
    const t = G.activateTab(s, "g1", "a.ts");
    assert.equal(t.active, "g1", "a click on the tab of a group activates it");
    assert.equal(G.groupOf(t, "g1").active, "a.ts");
    equal(G.groupOf(t, "g2"), G.groupOf(s, "g2"), "the other group stays");
    assert.equal(G.activateGroup(two, "gx"), two, "an unknown group: same state");
  },
  dragTab(G) {
    const two = { groups: [L("g1", ["a.ts", "b.ts"], "a.ts", "b.ts"), L("g2", ["c.ts"])], active: "g1" };
    const s = G.dropTab(two, { group: "g1", path: "b.ts" }, { group: "g2", zone: "middle", before: { path: "c.ts", afterwards: false } });
    equal(s.groups, [L("g1", ["a.ts"]), L("g2", ["b.ts", "c.ts"], "b.ts")], "moved: before c, fixed and in front; the source loses it");
    assert.equal(s.active, "g2", "the target group becomes active");
    const k = G.dropTab(two, { group: "g1", path: "b.ts" }, { group: "g2", zone: "middle" }, true);
    equal(G.groupOf(k, "g1"), two.groups[0], "⌥: copies — the source stays");
    equal(G.groupOf(k, "g2").paths, ["c.ts", "b.ts"], "without a position: at the end");
    const to = G.dropTab(two, { group: "g2", path: "c.ts" }, { group: "g1", zone: "middle", before: { path: "a.ts", afterwards: true } });
    equal(to.groups, [L("g1", ["a.ts", "c.ts", "b.ts"], "c.ts", "b.ts")], "the last tab leaves: its group closes");
    assert.equal(to.active, "g1");
    equal(G.dropTab(two, { group: "g1", path: "b.ts" }, { group: "g1", zone: "middle", before: { path: "a.ts", afterwards: false } }).groups[0].paths, ["b.ts", "a.ts"], "in the same group: reorder");
    assert.equal(G.dropTab(two, { group: "g1", path: "b.ts" }, { group: "g1", zone: "middle" }), two, "onto the middle of its own surface: nothing");
    assert.equal(G.dropTab(two, { group: "g1", path: "x.ts" }, { group: "g2", zone: "middle" }), two, "a tab that does not exist there: nothing");
    // At the edge: a new group in THAT direction.
    const one = { groups: [L("g1", ["a.ts", "b.ts"], "b.ts")], active: "g1" };
    const right = G.dropTab(one, { group: "g1", path: "b.ts" }, { group: "g1", zone: "right" });
    equal(right.groups, [L("g1", ["a.ts"]), L("g2", ["b.ts"])], "at the right edge: a new group with the tab, moved");
    assert.equal(right.active, "g2");
    const bottom = G.dropTab(one, { group: "g1", path: "b.ts" }, { group: "g1", zone: "bottom" });
    equal([bottom.groups, G.rasterOf(bottom)], [[L("g1", ["a.ts"]), L("g2", ["b.ts"])], W(UN, B("g1", 0.5), B("g2", 0.5))], "at the bottom edge: a group below");
    const alone = { groups: [L("g1", ["a.ts"])], active: "g1" };
    assert.equal(G.splittable(alone, "g1", { group: "g1", path: "a.ts" }), false, "the ONLY tab of a group does not split onto its own surface");
    assert.equal(G.splittable(alone, "g1", null), true, "files do");
    assert.equal(G.dropTab(alone, { group: "g1", path: "a.ts" }, { group: "g1", zone: "right" }), alone);
    equal(G.dropTab(alone, { group: "g1", path: "a.ts" }, { group: "g1", zone: "right" }, true).groups.map((g) => g.paths), [["a.ts"], ["a.ts"]], "with ⌥ it does (a copy)");
    // No cap: at the edge of the second one a third is created.
    equal(G.dropTab(two, { group: "g1", path: "b.ts" }, { group: "g2", zone: "right" }).groups, [L("g1", ["a.ts"]), L("g2", ["c.ts"]), L("g3", ["b.ts"])], "at the edge of the second: a third");
    // The LAST tab of a group at the edge of another: the whole group moves there (VS Code: it would be empty and close).
    const pair = { groups: [L("g1", ["a.ts"]), L("g2", ["c.ts"])], active: "g1" };
    const migrates = G.dropTab(pair, { group: "g1", path: "a.ts" }, { group: "g2", zone: "bottom" });
    equal([migrates.groups, G.rasterOf(migrates), migrates.active], [[L("g2", ["c.ts"]), L("g1", ["a.ts"])], W(UN, B("g2", 0.5), B("g1", 0.5)), "g1"], "the group moves below the other");
    const copied = G.dropTab(pair, { group: "g1", path: "a.ts" }, { group: "g2", zone: "bottom" }, true);
    equal(G.rasterOf(copied), W(NB, B("g1", 0.5), Z(0.5, B("g2", 0.5), B("g3", 0.5))), "with ⌥ the group stays, the copy gets a new one");
  },
  dragFiles(G) {
    const one = { groups: [L("g1", ["a.ts"], "a.ts", "a.ts")], active: "g1" };
    const s = G.dropFiles(one, ["x.ts", "y.ts", "x.ts", ""], { group: "g1", zone: "middle", before: { path: "a.ts", afterwards: false } });
    equal(s.groups, [L("g1", ["x.ts", "y.ts", "a.ts"], "x.ts", "a.ts")], "fixed at the position, in their order, each once; the FIRST in front");
    assert.equal(G.groupOf(G.dropFiles(one, ["a.ts"], { group: "g1", zone: "middle" }), "g1").preview, null, "a preview that drops becomes fixed");
    const margin = G.dropFiles(one, ["x.ts", "y.ts"], { group: "g1", zone: "right" });
    equal(margin.groups, [one.groups[0], L("g2", ["x.ts", "y.ts"], "x.ts")], "at the edge: a new group with them");
    assert.equal(margin.active, "g2");
    equal(ids(G.dropFiles(one, ["x.ts"], { group: "g1", zone: "left" })), ["g2", "g1"], "at the left edge: left");
    const top = G.dropFiles(one, ["x.ts"], { group: "g1", zone: "top" });
    equal([ids(top), G.rasterOf(top)], [["g2", "g1"], W(UN, B("g2", 0.5), B("g1", 0.5))], "at the top edge: above");
    const two = G.parts(one, "g1");
    const third = G.dropFiles(two, ["x.ts"], { group: "g1", zone: "right" });
    equal(third.groups.map((g) => [g.id, g.paths]), [["g1", ["a.ts"]], ["g3", ["x.ts"]], ["g2", ["a.ts"]]], "no cap: a new group between the two");
    assert.equal(third.active, "g3");
    assert.equal(G.dropFiles(one, [], { group: "g1", zone: "middle" }), one, "nothing: same state");
    assert.equal(G.dropFiles(one, ["x.ts"], { group: "gx", zone: "middle" }), one, "an unknown group: nothing");
  },
  zone(G) {
    const Zn = (x, y, t = true) => G.dropZone(x, y, 1000, 600, t);
    assert.equal(G.MARGIN_SHARE, 0.1);
    assert.equal(Zn(500, 300), "middle");
    assert.equal(Zn(200, 300), "middle", "within the margin (10 %) the middle");
    assert.equal(Zn(50, 300), "left");
    assert.equal(Zn(960, 300), "right");
    assert.equal(Zn(200, 20), "left", "in the top margin left/right by thirds");
    assert.equal(Zn(800, 590), "right");
    assert.equal(Zn(500, 20), "top", "top in the middle: a group above");
    assert.equal(Zn(500, 590), "bottom");
    assert.equal(Zn(100, 300), "left", "the boundary itself is margin (VS Code: strictly inside)");
    assert.equal(Zn(500, 60), "top");
    assert.equal(Zn(50, 300, false), "middle", "without splitting always the middle");
    assert.equal(G.dropZone(10, 10, 0, 0, true), "middle", "without dimensions the middle");
  },
  sizes(G) {
    const two = G.parts({ groups: [L("g1", ["a.ts"])], active: "g1" }, "g1");
    assert.equal(G.MIN_WIDTH, 220, "VS Code DEFAULT_EDITOR_MIN_DIMENSIONS");
    const z = G.pullSeparator(two, [], 0, 100, 1000);
    equal(G.rasterOf(z), W(NB, B("g1", 0.6), B("g2", 0.4)), "the separator follows the pull");
    equal(G.rasterOf(G.pullSeparator(two, [], 0, 900, 1000)), W(NB, B("g1", 0.78), B("g2", 0.22)), "never below 220 px");
    assert.equal(G.pullSeparator(two, [], 0, 0, 1000), two, "no distance: same state");
    equal(G.rasterOf(G.distributeEqually(z)), W(NB, B("g1", 0.5), B("g2", 0.5)), "\"Reset Editor Group Sizes\"");
    assert.equal(G.distributeEqually(two), two, "already equal: same state");
    assert.equal(G.distributeEqually({ ...z, maximized: "g2" }).maximized, undefined, "resetting ends the maximization (VS Code distributeViewSizes)");
    equal(G.rasterOf(G.equalizeBranch(z, [])), W(NB, B("g1", 0.5), B("g2", 0.5)), "double click on the separator");
    assert.equal(G.equalizeBranch(two, []), two);
    equal(G.rasterOf(G.changeWidth(two, "g1", 60, 1000, 600)), W(NB, B("g1", 0.56), B("g2", 0.44)), "\"Increase Width\": 60 px");
    equal(G.rasterOf(G.changeWidth(two, "g2", -60, 1000, 600)), W(NB, B("g1", 0.56), B("g2", 0.44)), "\"Decrease Width\"");
    // What a minimum size forced becomes the share (saveProportions) — g1 g2 g3 g4 at 1000 with 1/2 · 1/6 · 1/6 · 1/6: three × 220, g1 340.
    const clamps = { ...two, groups: [...two.groups, L("g3", []), L("g4", [])], raster: W(NB, B("g1", 0.5), B("g2", 1 / 6), B("g3", 1 / 6), B("g4", 1 / 6)) };
    const on = G.alignTo(clamps, 1000, 600);
    equal(G.rasterOf(on), W(NB, B("g1", 0.34), B("g2", 0.22), B("g3", 0.22), B("g4", 0.22)), "aligned to what is drawn");
    assert.equal(G.alignTo(on, 1000, 600), on, "nothing to do: same state");
    assert.equal(G.alignTo(two, 1000, 600), two, "no minimum size applies: same state");
  },
  storage(G) {
    let s = G.open(G.open(G.BEGINNING, "a.ts", { fixed: true }), "b.ts");
    s = G.parts(s, "g1", "bottom");
    s = G.parts(s, "g2", "right", "a.ts");
    s = G.pullSeparator(s, [], 0, 150, 600);
    s = G.activateGroup(s, "g1");
    equal(G.rasterOf(s), W(UN, B("g1", 0.75), Z(0.25, B("g2", 0.5), B("g3", 0.5))));
    const again = G.fromStorage(G.storageText(s));
    equal(again, s, "the state comes back after reload: grid, sizes, tabs, the group trail");
    const v3 = JSON.stringify({ v: 3, active: "g1", groups: [{ id: "g1", paths: ["a"] }], raster: W(NB, B("g1", 1)) });
    const missing = JSON.stringify({ v: 2, active: "g1", groups: [{ id: "g1", paths: ["a"] }, { id: "g2", paths: [] }], raster: W(NB, B("g1", 1)) });
    for (const raw of [null, undefined, "", "{", "[]", "null", "{\"v\":1}", "{\"v\":1,\"groups\":[]}", "{\"v\":1,\"groups\":[{\"paths\":[\"a\"]}]}", v3, "{\"v\":2,\"groups\":[{\"id\":\"g1\",\"paths\":[\"a\"]}]}", missing]) {
      assert.equal(G.fromStorage(raw), null, `unreadable is unknown, not empty: ${raw}`);
    }
    // Version 1 (groups side by side, the ratio of the first) is read — every field checked.
    const foreign = G.fromStorage(JSON.stringify({ v: 1, active: "gx", ratio: 7, groups: [
      { id: "g1", paths: ["a.ts", "a.ts", 3, "", "b.ts"], active: "zz.ts", preview: "c.ts" },
      { id: "g1", paths: ["d.ts"] },
      { id: "g2", paths: ["e.ts"], active: "e.ts", preview: "e.ts" },
      { id: "g3", paths: ["f.ts"] },
    ] }));
    equal([foreign.groups, foreign.active, G.rasterOf(foreign)], [[L("g1", ["a.ts", "b.ts"]), L("g2", ["e.ts"], "e.ts", "e.ts"), L("g3", ["f.ts"])], "g1", W(NB, B("g1", 1 / 3), B("g2", 1 / 3), B("g3", 1 / 3))],
      "paths without duplicates, active/preview only from the own list, an id once (a third group is read)");
    const v1 = G.fromStorage(JSON.stringify({ v: 1, active: "g2", ratio: 0.35, groups: [{ id: "g1", paths: ["a.ts"] }, { id: "g2", paths: ["b.ts"] }] }));
    equal([ids(v1), v1.active, G.rasterOf(v1)], [["g1", "g2"], "g2", W(NB, B("g1", 0.35), B("g2", 0.65))], "version 1: two side by side in the remembered ratio");
  },
  paths(G) {
    const two = { groups: [L("g1", ["src/a.ts", "b.ts"], "src/a.ts", "src/a.ts"), L("g2", ["src/a.ts", "src/c.ts"], "src/c.ts", "src/a.ts")], active: "g2" };
    const renamed = G.formPaths(two, (p) => (p.startsWith("src/") ? `lib/${p.slice(4)}` : p));
    equal(renamed.groups, [L("g1", ["lib/a.ts", "b.ts"], "lib/a.ts", "lib/a.ts"), L("g2", ["lib/a.ts", "lib/c.ts"], "lib/c.ts", "lib/a.ts")], "renamed: every group follows, active and preview too");
    assert.equal(G.formPaths(two, (p) => p), two, "nothing renamed: same state");
    equal(G.formPaths(two, (p) => (p === "b.ts" ? "src/a.ts" : p)).groups[0].paths, ["src/a.ts"], "two paths become one: one tab");
    equal(G.keep(two, "src/a.ts").groups.map((g) => g.preview), [null, null], "typing fixes the file in EVERY group where it is a preview");
    equal(G.keep(two, "src/a.ts", "g1").groups.map((g) => g.preview), [null, "src/a.ts"], "with a group only there");
    equal(G.tidyPreview(two, (p) => p === "src/a.ts").groups.map((g) => g.preview), [null, null], "an unsaved preview is fixed, in every group");
    assert.equal(G.tidyPreview(two, () => false), two);
  },
  keys(G) {
    const d = (code, key, m = {}) => ({ code, key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
    const mac = (e, open = false) => G.groupKey(e, open, true);
    assert.equal(mac(d("Backslash", "\\", { metaKey: true })), "workbench.action.splitEditor", "⌘\\");
    for (let n = 1; n <= 8; n++) assert.equal(mac(d(`Digit${n}`, String(n), { metaKey: true })), G.FOCUS_NUMBERS[n - 1], `⌘${n}`);
    assert.equal(mac(d("Digit1", "1", { ctrlKey: true })), null, "on the Mac ⌃1 is not ⌘1");
    assert.equal(G.groupKey(d("Backslash", "\\", { ctrlKey: true }), false, false), "workbench.action.splitEditor", "otherwise Ctrl");
    assert.equal(mac(d("KeyK", "k", { metaKey: true })), "chord", "⌘K starts a chord");
    assert.equal(mac(d("KeyW", "w"), true), "workbench.action.closeEditorsInGroup", "⌘K W");
    assert.equal(mac(d("KeyU", "u"), true), "workbench.action.closeUnmodifiedEditors", "⌘K U");
    assert.equal(mac(d("Enter", "Enter"), true), "workbench.action.keepEditor", "⌘K Enter");
    assert.equal(mac(d("KeyV", "v"), true), "markdown.showPreviewToSide", "⌘K V");
    // ⌘K ⌘\ carries five commands in VS Code — the last registered one wins: "Split Editor Down".
    assert.equal(mac(d("Backslash", "\\", { metaKey: true }), true), "workbench.action.splitEditorDown", "⌘K ⌘\\");
    // ⌘K ⌘W is VS Code `closeAllEditors`, ⌘K ⇧⌘W `closeAllGroups`.
    assert.equal(mac(d("KeyW", "w", { metaKey: true }), true), "workbench.action.closeAllEditors", "⌘K ⌘W");
    assert.equal(mac(d("KeyW", "W", { metaKey: true, shiftKey: true }), true), "workbench.action.closeAllGroups", "⌘K ⇧⌘W");
    assert.equal(mac(d("ArrowLeft", "ArrowLeft", { metaKey: true }), true), "workbench.action.focusLeftGroup", "⌘K ⌘←");
    assert.equal(mac(d("ArrowRight", "ArrowRight", { metaKey: true }), true), "workbench.action.focusRightGroup", "⌘K ⌘→");
    assert.equal(mac(d("ArrowUp", "ArrowUp", { metaKey: true }), true), "workbench.action.focusAboveGroup", "⌘K ⌘↑");
    assert.equal(mac(d("ArrowDown", "ArrowDown", { metaKey: true }), true), "workbench.action.focusBelowGroup", "⌘K ⌘↓");
    assert.equal(mac(d("ArrowLeft", "ArrowLeft"), true), "workbench.action.moveActiveEditorGroupLeft", "⌘K ←");
    assert.equal(mac(d("ArrowDown", "ArrowDown"), true), "workbench.action.moveActiveEditorGroupDown", "⌘K ↓");
    assert.equal(mac(d("KeyM", "m", { metaKey: true }), true), "workbench.action.toggleMaximizeEditorGroup", "⌘K ⌘M");
    assert.equal(mac(d("ArrowLeft", "ArrowLeft", { metaKey: true, ctrlKey: true })), "workbench.action.moveEditorToPreviousGroup", "⌃⌘← (Mac)");
    assert.equal(mac(d("ArrowRight", "ArrowRight", { metaKey: true, ctrlKey: true })), "workbench.action.moveEditorToNextGroup", "⌃⌘→ (Mac)");
    assert.equal(mac(d("Digit1", "1", { metaKey: true, ctrlKey: true })), "workbench.action.moveEditorToFirstGroup", "⌃⌘1");
    assert.equal(mac(d("Digit9", "9", { metaKey: true, ctrlKey: true })), "workbench.action.moveEditorToLastGroup", "⌃⌘9");
    assert.equal(G.groupKey(d("Digit1", "!", { shiftKey: true, altKey: true }), false, false), "workbench.action.moveEditorToFirstGroup", "otherwise ⇧⌥1");
    assert.equal(mac(d("Digit0", "0", { metaKey: true, altKey: true })), "workbench.action.toggleEditorGroupLayout", "⌥⌘0");
    assert.equal(G.groupKey(d("Digit0", ")", { shiftKey: true, altKey: true }), false, false), "workbench.action.toggleEditorGroupLayout", "otherwise ⇧⌥0");
    assert.equal(mac(d("ArrowLeft", "ArrowLeft", { ctrlKey: true, altKey: true })), null, "on the Mac ⌃⌥← is not ⌃⌘←");
    assert.equal(G.groupKey(d("ArrowLeft", "ArrowLeft", { ctrlKey: true, altKey: true }), false, false), "workbench.action.moveEditorToPreviousGroup", "otherwise Ctrl+Alt+← (VS Code)");
    assert.equal(mac(d("ArrowLeft", "ArrowLeft", { metaKey: true })), null, "⌘← alone stays with the editor (line start)");
    // From the terminal ⌘1–⌘8 and "Focus Last Editor Group" work (VS Code `DEFAULT_COMMANDS_TO_SKIP_SHELL`) — ⌘K clears there, ⌘\ splits the
    // terminal.
    assert.deepEqual([...G.TERMINAL_PASSTHROUGH].sort(), [...G.FOCUS_NUMBERS, "workbench.action.focusLastEditorGroup"].sort(), "other group keys work from the terminal than in VS Code");
    assert.equal(G.groupThroughTheTerminal(d("Digit2", "2", { metaKey: true }), true), true, "⌘2 gets stuck in the shell");
    assert.equal(G.groupThroughTheTerminal(d("Digit7", "7", { metaKey: true }), true), true, "⌘7 gets stuck in the shell");
    assert.equal(G.groupThroughTheTerminal(d("Digit1", "1", { ctrlKey: true }), false), true, "Ctrl+1 gets stuck in the shell");
    assert.equal(G.groupThroughTheTerminal(d("Backslash", "\\", { metaKey: true }), true), false, "⌘\\ belongs to the shell in the terminal");
    assert.equal(G.groupThroughTheTerminal(d("KeyK", "k", { metaKey: true }), true), false, "⌘K belongs to the shell in the terminal");
    // The text of the second key (VS Code: "The key combination (⌘K, X) is not a command.")
    assert.equal(G.pressText(d("KeyX", "x"), true), "X");
    assert.equal(G.pressText({ ...d("KeyY", "z", { metaKey: true }), keyCode: 90 }, true), "⌘Z", "the key label, not its position");
    assert.equal(G.pressText({ ...d("KeyY", "Ω", { altKey: true }), keyCode: 90 }, true), "⌥Z", "⌥ changes key (Ω) — the label stays Z");
    assert.equal(G.pressText(d("ArrowLeft", "ArrowLeft", { shiftKey: true, metaKey: true }), true), "⇧⌘←");
    assert.equal(G.pressText(d("KeyQ", "q", { ctrlKey: true }), false), "Ctrl+Q");
    assert.equal(G.CHORD_DEADLINE_MS, 5000, "VS Code waits 5 s for the second key");
    assert.equal(mac(d("KeyX", "x"), true), null, "another second key: no command");
    assert.equal(mac(d("KeyW", "w")), null, "W without ⌘K: nothing");
    assert.equal(mac(d("Digit1", "1", { metaKey: true }), true), null, "in a chord only its second key counts (⌘K ⌘1 is not a groups command)");
    // The table: unambiguous; every palette command with a title (VS Code "View: …" resp. "Markdown: …"; "Toggle Vertical/Horizontal Editor
    // Layout" and "Increase/Decrease Editor Width" have no category in VS Code), with key or chord also with a shortcut; ⌘2–⌘8 are only keys
    // (VS Code). web/test/vscode-de-wordings.test.mjs binds the wordings themselves to the language pack.
    const withoutCategory = { "workbench.action.toggleEditorGroupLayout": /^Toggle Vertical\/Horizontal Editor Layout$/, "workbench.action.increaseViewWidth": /^Increase Editor /, "workbench.action.decreaseViewWidth": /^Decrease Editor / };
    const identifiers = G.GROUPS_COMMANDS.map((b) => b.id);
    assert.equal(new Set(identifiers).size, identifiers.length, "an id twice");
    for (const b of G.GROUPS_COMMANDS) {
      if ("onlyKey" in b) { assert.ok(!("title" in b) && "keys" in b && b.shortcut, `${b.id}: a key-only command with a title or without a key`); continue; }
      assert.match(b.title, b.id.startsWith("markdown.") ? /^Markdown: / : withoutCategory[b.id] ?? /^View: /, `${b.id}: palette title not as in VS Code`);
      // Without a key a command appears only in the palette (VS Code binds "Reset Editor Group Sizes" to none) — then without a shortcut.
      if ("keys" in b || "chord" in b) assert.ok(b.shortcut, `${b.id}: key without shortcut`);
      else assert.equal(G.shortcutOf(b.id), undefined, `${b.id}: a shortcut without a key`);
    }
    assert.deepEqual(G.GROUPS_COMMANDS.filter((b) => "onlyKey" in b).map((b) => b.id), G.FOCUS_NUMBERS.slice(1), "only ⌘2–⌘8 are missing in the palette (VS Code)");
  },
  // Every command of the table has a way — a step on the state, splitting, moving an editor, or the host (CodePane, which asks, measures or
  // supplies the view state).
  commands(G) {
    const HOST = ["workbench.action.closeEditorsInGroup", "workbench.action.closeUnmodifiedEditors", "workbench.action.keepEditor", "workbench.action.closeAllEditors",
      "workbench.action.closeAllGroups", "markdown.showPreviewToSide", "workbench.action.increaseViewWidth", "workbench.action.decreaseViewWidth"];
    const withoutWay = G.GROUPS_COMMANDS.filter((b) => !G.statusStep(b.id, "g1") && !G.partDirection(b.id) && !G.editorTarget(b.id) && !HOST.includes(b.id)).map((b) => b.id);
    assert.deepEqual(withoutWay, [], "commands without a way");
    assert.deepEqual(["splitEditor", "splitEditorOrthogonal", "splitEditorLeft", "splitEditorRight", "splitEditorUp", "splitEditorDown"].map((x) => G.partDirection(`workbench.action.${x}`)),
      ["right", "bottom", "left", "right", "top", "bottom"], "splitting (orthogonal to \"right\" is down)");
    assert.deepEqual(["Previous", "Next", "First", "Last", "Left", "Right", "Above", "Below"].map((x) => G.editorTarget(`workbench.action.moveEditorTo${x}Group`)),
      [{ location: "previous" }, { location: "next" }, { location: "first" }, { location: "last" }, { direction: "left" }, { direction: "right" }, { direction: "top" }, { direction: "bottom" }]);
    assert.equal(G.statusStep("workbench.action.splitEditor", "g1"), null, "splitting needs the host (view state)");
    const three = { groups: [L("g1", ["a.ts"]), L("g2", ["b.ts"]), L("g3", ["c.ts"])], active: "g2" };
    const rows = G.statusStep("workbench.action.editorLayoutThreeRows", "g2")(three);
    equal([ids(rows), rows.active, G.rasterOf(rows)], [["g1", "g2", "g3"], "g2", W(UN, B("g1", 1 / 3), B("g2", 1 / 3), B("g3", 1 / 3))], "\"Editor Layout: Three Rows\"");
    assert.equal(G.statusStep("workbench.action.focusAboveGroup", "g2")(rows).active, "g1", "⌘K ⌘↑");
    assert.equal(G.statusStep("workbench.action.focusBelowGroup", "g2")(rows).active, "g3", "⌘K ⌘↓");
    equal(G.rasterOf(G.statusStep("workbench.action.toggleEditorGroupLayout", "g2")(rows)), W(NB, B("g1", 1 / 3), B("g2", 1 / 3), B("g3", 1 / 3)), "⌥⌘0 flips");
    assert.deepEqual(ids(G.statusStep("workbench.action.moveActiveEditorGroupLeft", "g2")(three)), ["g2", "g1", "g3"], "⌘K ←");
    assert.equal(Object.keys(G.LAYOUTS).length, 8, "the eight layouts of VS Code");
  },
  lane(G) {
    // VS Code per group: new right of the active one, after closing the active one the most recently used; the trail follows renaming and
    // dragging and survives reload.
    let s = G.open(G.BEGINNING, "a.ts", { fixed: true });
    s = G.open(s, "b.ts", { fixed: true });
    s = G.open(s, "c.ts", { fixed: true });
    s = G.activateTab(s, "g1", "a.ts");
    s = G.open(s, "d.ts", { fixed: true });
    assert.deepEqual(G.groupOf(s, "g1").paths, ["a.ts", "d.ts", "b.ts", "c.ts"], "new right of the active one");
    assert.deepEqual(G.groupOf(s, "g1").last, ["d.ts", "a.ts", "c.ts", "b.ts"], "the trail: most recently used first");
    assert.equal(G.groupOf(G.close(s, "g1", "d.ts"), "g1").active, "a.ts", "after closing, the most recently used (not the right neighbour)");
    const h = G.openInBackground(G.activateTab(s, "g1", "a.ts"), "e.ts");
    assert.deepEqual([G.groupOf(h, "g1").paths, G.groupOf(h, "g1").active], [["a.ts", "e.ts", "d.ts", "b.ts", "c.ts"], "a.ts"], "in the background right of the active one, without coming to the front");
    const renamed = G.formPaths(s, (p) => (p === "a.ts" ? "z.ts" : p));
    assert.equal(G.groupOf(G.close(renamed, "g1", "d.ts"), "g1").active, "z.ts", "renamed: the trail follows");
    assert.deepEqual(G.groupOf(G.fromStorage(G.storageText(s)), "g1").last, ["d.ts", "a.ts", "c.ts", "b.ts"], "the trail survives reload");
    const foreign = G.fromStorage(JSON.stringify({ v: 1, active: "g1", ratio: 0.5, groups: [{ id: "g1", paths: ["a.ts", "b.ts"], active: "a.ts", last: ["zz.ts", "b.ts", "b.ts", 3] }] }));
    assert.deepEqual(foreign.groups[0].last, ["b.ts"], "the remembered trail only from the own list");
    // Dragged into a group with its own trail: in front there, the group's trail stays.
    let z = G.parts(s, "g1");
    z = G.open(G.open(z, "x.ts", { fixed: true }), "y.ts", { fixed: true });
    z = G.activateTab(z, "g2", "d.ts");
    z = G.dropTab(z, { group: "g1", path: "b.ts" }, { group: "g2", zone: "middle", before: { path: "d.ts", afterwards: true } });
    assert.deepEqual(G.groupOf(z, "g2").paths, ["d.ts", "b.ts", "x.ts", "y.ts"]);
    assert.equal(G.groupOf(G.close(z, "g2", "b.ts"), "g2").active, "d.ts", "after dragging the trail of the target group still applies");
  },
  // Maximizing, focusing neighbours and locations, moving editors and groups, "Open to the Side", joining, layouts.
  ways(G) {
    const two = { groups: [L("g1", ["a.ts", "b.ts"], "a.ts"), L("g2", ["c.ts"])], active: "g1" };
    const maxi = G.toggleMaximize(two);
    assert.equal(G.maximizedGroup(maxi), "g1", "⌘K ⌘M maximizes the active group");
    assert.equal(G.maximizedGroup(G.toggleMaximize(maxi)), null, "once more: undone");
    assert.equal(G.toggleMaximize(G.BEGINNING), G.BEGINNING, "one group maximizes nothing");
    assert.equal(G.maximizedGroup(G.activateGroup(maxi, "g2")), null, "when the other one becomes active the maximization ends (VS Code)");
    assert.equal(G.maximizedGroup(G.activateGroup(G.activateGroup(maxi, "g2"), "g1")), null, "back into the first: the maximization does not return");
    assert.equal(G.maximizedGroup(G.removeGroup(maxi, "g2")), null, "one group fewer: nothing maximized any more");
    assert.equal(G.maximizedGroup(G.fromStorage(G.storageText(maxi))), "g1", "the maximization survives reload");
    assert.equal(G.fromStorage(G.storageText(two)).maximized, undefined);
    // Neighbours: ⌘K ⌘→; at the edge from the other side (VS Code `wrap`); several beside: the most recently active one.
    assert.equal(G.focusNeighbor(two, "right").active, "g2", "⌘K ⌘→");
    assert.equal(G.focusNeighbor(two, "left").active, "g2", "⌘K ⌘← in the first: from the right");
    const rightTwo = { groups: [L("g1", ["a.ts"]), L("g2", ["b.ts"]), L("g3", ["c.ts"])], active: "g1", lastActive: ["g1", "g3", "g2"], raster: W(NB, B("g1", 0.5), Z(0.5, B("g2", 0.5), B("g3", 0.5))) };
    assert.equal(G.focusNeighbor(rightTwo, "right").active, "g3", "two beside: the most recently active one (VS Code doFindGroupByDirection)");
    assert.equal(G.neighbor(rightTwo, "g2", "bottom")?.id, "g3");
    assert.equal(G.neighbor(rightTwo, "g2", "top"), null, "without wrap-around: none");
    assert.equal(G.neighbor(rightTwo, "g2", "top", true)?.id, "g3", "with wrap-around: from below");
    assert.equal(G.focusLocation(rightTwo, "last").active, "g3");
    assert.equal(G.focusLocation({ ...rightTwo, active: "g3" }, "next").active, "g1", "the next after the last: the first");
    assert.equal(G.focusLocation(rightTwo, "previous").active, "g3", "the previous before the first: the last");
    // Moving an editor: ⌃⌘→ into the next one (fixed, active); if missing it is created on the right — ⌃⌘← on the left (VS Code
    // `addGroup(LEFT)`); in a direction, if there is none, it is created there.
    const v = G.moveEditor(two, "g1", "b.ts", { location: "next" });
    assert.deepEqual([pathsOf(v), v.active, v.groups[1].active], [[["a.ts"], ["c.ts", "b.ts"]], "g2", "b.ts"], "⌃⌘→ moves into the next group");
    const vl = G.moveEditor(two, "g1", "b.ts", { location: "previous" });
    assert.deepEqual([pathsOf(vl), vl.active], [[["b.ts"], ["a.ts"], ["c.ts"]], vl.groups[0].id], "⌃⌘← in the first: one is created on the left");
    const one = G.open(G.open(G.BEGINNING, "a.ts", { fixed: true }), "b.ts", { fixed: true });
    const downward = G.moveEditor(one, "g1", "b.ts", { direction: "bottom" });
    equal([pathsOf(downward), G.rasterOf(downward)], [[["a.ts"], ["b.ts"]], W(UN, B("g1", 0.5), B("g2", 0.5))], "\"Move Down\" creates below");
    assert.equal(G.moveEditor(one, "g1", "b.ts", { location: "first" }), one, "into the first from the first: nothing");
    assert.deepEqual(pathsOf(G.moveEditor(two, "g1", "b.ts", { location: "last" })), [["a.ts"], ["c.ts", "b.ts"]]);
    const clears = G.moveEditor(two, "g2", "c.ts", { direction: "left" });
    assert.deepEqual([ids(clears), pathsOf(clears)], [["g1"], [["a.ts", "b.ts", "c.ts"]]], "the last editor moves left: its group closes");
    // "Open to the Side": right of the active one, fixed; if missing it is created there (VS Code SIDE_GROUP).
    const d1 = G.openBeside(two, "x.ts");
    assert.deepEqual([d1.active, d1.groups[1].paths, d1.groups[1].preview], ["g2", ["c.ts", "x.ts"], null], "to the side: fixed in the right group");
    const d2 = G.openBeside(one, "x.ts");
    assert.deepEqual([d2.groups.length, d2.groups[1].paths, d2.active], [2, ["x.ts"], d2.groups[1].id], "to the side without a right group: one is created on the right");
    const d3 = G.openBeside({ ...two, active: "g2" }, "x.ts");
    assert.deepEqual([ids(d3), d3.groups[2].paths, d3.active], [["g1", "g2", "g3"], ["x.ts"], "g3"], "from the right one: a third on the right, never the left one");
    // Moving a group (⌘K ←/→/↑/↓): beside the group in that direction — if missing, beside the one across it, in THAT direction.
    const g = G.moveGroup(two, "g1", "right");
    assert.deepEqual([ids(g), g.active], [["g2", "g1"], "g1"], "⌘K →");
    assert.equal(G.moveGroup(two, "g1", "left"), two, "there is none on the left, nor across: nothing");
    const stack = G.parts(one, "g1", "bottom");
    const landscape = G.moveGroup(stack, "g2", "left");
    equal([ids(landscape), G.rasterOf(landscape)], [["g2", "g1"], W(NB, B("g2", 0.5), B("g1", 0.5))], "there is none on the left: it goes left of the upper one");
    // Joining (mergeGroup): right, otherwise below, left, above; the editors at the end, the active one of the ACTIVE source in front.
    const j = G.connectWithNext(two, "g1");
    equal([j.groups, j.active], [[L("g2", ["c.ts", "a.ts", "b.ts"], "a.ts")], "g2"], "into the right one");
    const j2 = G.connectWithNext(two, "g2");
    equal([j2.groups, j2.active], [[L("g1", ["a.ts", "b.ts", "c.ts"], "a.ts")], "g1"], "none on the right or below: into the left one, its active editor stays in front");
    const three = { groups: [L("g1", ["a.ts"]), L("g2", ["b.ts"]), L("g3", ["c.ts"])], active: "g2", lastActive: ["g2", "g3", "g1"] };
    assert.deepEqual(pathsOf(G.connectWithNext(three, "g2")), [["a.ts"], ["c.ts", "b.ts"]], "the middle one: into the right one, not the left one");
    assert.equal(G.connectWithNext(one, "g1"), one, "one group: nothing");
    equal(G.joinTogether({ groups: [L("g1", ["a.ts", "b.ts"], "b.ts"), L("g2", ["b.ts", "c.ts"], "c.ts")], active: "g2" }, "g1", "g2").groups, [L("g2", ["c.ts", "a.ts", "b.ts"], "c.ts")],
      "a file already there goes to the end; the source was not active: the active one of the target stays");
    const all = G.connectAll(three);
    equal([all.groups, all.active], [[L("g2", ["b.ts", "c.ts", "a.ts"])], "g2"], "\"Join All Editor Groups\": into the active one, the most recently active first");
    // Layouts (applyLayout): surplus groups go into the last one, which stays; missing ones are created empty; the active one stays active.
    const four = G.applyLayout(one, G.LAYOUTS["workbench.action.editorLayoutTwoByTwoGrid"]);
    equal([four.groups.map((x) => [x.id, x.paths]), four.active, G.rasterOf(four)], [[["g1", ["a.ts", "b.ts"]], ["g2", []], ["g3", []], ["g4", []]], "g1",
      W(NB, Z(0.5, B("g1", 0.5), B("g2", 0.5)), Z(0.5, B("g3", 0.5), B("g4", 0.5)))], "2×2");
    equal([G.applyLayout(three, G.LAYOUTS["workbench.action.editorLayoutSingle"]).groups], [[L("g1", ["a.ts", "b.ts", "c.ts"], "b.ts")]], "single: all into the one");
    assert.deepEqual(pathsOf(G.applyLayout(three, G.LAYOUTS["workbench.action.editorLayoutTwoColumns"])), [["a.ts"], ["b.ts", "c.ts"]], "two columns: the third into the second");
    equal(G.rasterOf(G.applyLayout(three, G.LAYOUTS["workbench.action.editorLayoutTwoRowsRight"])), W(NB, B("g1", 0.5), Z(0.5, B("g2", 0.5), B("g3", 0.5))), "two rows right");
    equal(G.rasterOf(G.flipLayout(G.pullSeparator(two, [], 0, 100, 1000))), W(UN, B("g1", 0.6), B("g2", 0.4)), "⌥⌘0: the tree flips, the sizes stay");
    // Flipping ends the maximization (VS Code `set orientation` → `exitMaximizedView()`).
    assert.equal(G.maximizedGroup(G.flipLayout(maxi)), null, "⌥⌘0 with a maximized group: the maximization ends");
    // The surface draws by id, never by grid — a rebuild of the tree moves no node (scroll position, focus).
    const rotated = G.moveGroup(two, "g1", "right");
    assert.deepEqual([ids(rotated), G.domOrder(rotated.groups).map((x) => x.id)], [["g2", "g1"], ["g1", "g2"]], "the grid turns, the DOM does not");
    assert.deepEqual(G.domOrder([L("g10", []), L("g9", []), L("g2", [])]).map((x) => x.id), ["g2", "g9", "g10"], "by the number of the id, not by characters");
  },
};

test("(1) computations: open, close, split, focus, drag, zone, sizes, reload, paths, keys, commands, ways — as in VS Code", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});
test("(1) counter-tests: each sabotage appears exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot is not exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages no check catches");
  console.log(`  [editor-groups] ${sabotaged.length} sabotages on the computations, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  css: read("src", "app", "globals.css"),
  pane: read("src", "components", "CodePane.tsx"),
  input: read("src", "components", "code", "InputParts.tsx"),
  groups: read("src", "components", "code", "EditorGroups.tsx"),
  title: read("src", "components", "code", "EditorTitleSymbols.tsx"),
  connection: read("src", "components", "code", "editor-groups-connection.ts"),
  tile: read("src", "components", "code", "TabBar.tsx"),
  palette: read("src", "components", "code", "palette-host.ts"),
  tree: read("src", "components", "code", "explorer", "ExplorerTree.tsx"),
  lib: SOURCE,
  en: read("src", "lib", "i18n-de.ts"),
  turn: read("src", "components", "code", "tab-transaction.ts"),
  editor: read("src", "components", "code", "BufferEditor.tsx"),
  former: read("src", "lib", "code-settings.ts"),
  crumbs: read("src", "components", "code", "lsp-layout.ts"),
  core: read("src", "components", "code", "lsp-core.ts"),
  margin: read("src", "components", "code", "git-gutter.ts"),
};
// tab-transaction.ts (no imports) EXECUTED from the (possibly sabotaged) source text: a leaf that only strips types, synchronously.
const ts = createRequire(import.meta.url)(path.join(webDir, "node_modules", "typescript"));
const loadTransaction = (source) => {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} };
  new Function("exports", "module", js)(m.exports, m);
  return m.exports;
};
const SOURCE_CHECKS = {
  connection(q) {
    const p = withoutComments(q.pane);
    // The load list is ALL open files (every group), not just those of the active one. A tab is a file, a preview or a diff — the buffers of
    // the file tabs AND of the diffs of the unstaged change are held (lib/editor-inputs.ts `heldFiles`, executed in web/test/editor-inputs.test.mjs).
    assert.ok(p.includes("const openKey = controlled ? null : E.heldFiles(gr.state).join(\"\\n\");"), "loading only the files of the active group (the other showed \"loading…\")");
    assert.ok(p.includes("useEditorGroups(controlled ? null : [apiBase, instance ?? \"\"].join(\"|\"))"), "the group state is not remembered per target");
    assert.ok(p.includes("<EditorGroupsSurface"), "the files page draws no editor groups");
    assert.ok(p.includes("<GroupsEditor") && !/<BufferEditor[\s/>]/.test(p), "there is no editor per group");
    assert.ok(p.includes("viewRef={viewOf(g.id)}"), "the groups share ONE view (scroll position, selection)");
    assert.ok(p.includes("onKeyDownCapture={groupsKeys.capture}"), "the second key of a chord would go into the editor");
    assert.ok(p.includes("if (groupsKeys.key(e)) return;"), "⌘\\ ⌘1 ⌘2 and ⌘K are missing outside the editor");
    assert.ok(p.includes("useGroupsKeys(rootRef, !isControlled, groupsCommand, groupsCan)"), "the group keys would also apply in the chat");
    assert.ok(p.includes("rememberDrag({ area, kind: \"tree\" })"), "a drag from the explorer is not remembered");
    const a = withoutComments(q.connection);
    assert.ok(a.includes("condition: (_situation, k) => hostOf(k.view) !== null"), "the group commands would also apply outside a group (chat)");
    assert.ok(a.includes("localStorage.setItem(STORAGE + key, storageText(ref.current))"), "the state does not survive reload");
    assert.ok(a.includes("if (!key || read.current !== key) return;"), "the empty start would overwrite the remembered state");
    // Read BEFORE the first paint (no flash of the empty start).
    assert.ok(a.includes("useLayoutEffect(() => {\n    read.current = null;"), "the remembered state comes only after the first paint (the empty start flashes)");
    // The chord ends as in VS Code (5 s, window loses focus or is hidden), the status bar says what it waits for and what is not a
    // combination; keys in the terminal belong to the terminal, except ⌘1/⌘2.
    assert.ok(a.includes("report({ kind: \"waiting\" }, CHORD_DEADLINE_MS);"), "the chord waits forever (or the status bar says nothing)");
    assert.ok(a.includes("window.addEventListener(\"blur\", onBlur);") && a.includes("document.addEventListener(\"visibilitychange\", view);"), "the chord survives the window's focus change");
    assert.ok(a.includes("else report({ kind: \"no\", combo: pressText(e, isMac()) }, NO_COMMAND_MS);"), "a second key without a command vanishes silently");
    assert.ok(a.includes("if (r === null || (inTerminal(e) && (r === \"chord\" || !TERMINAL_PASSTHROUGH.includes(r)))) return false;"), "⌘K/⌘\\ in the terminal go to the groups (or ⌘1/⌘2 no longer do)");
    assert.ok(a.includes("if (inTerminal(e)) { report(null); return; }"), "a key in the terminal does not end the chord");
    assert.ok(p.includes("else if (!inTerminal(e) && matchesKey(WRAP_KEY, e, isMac()))"), "⌥Z in the terminal toggles wrapping (VS Code: the shell gets it)");
    assert.ok(p.includes("letThrough={(e) => keyForTheWorkbench(e) || G.groupThroughTheTerminal(e, isMac())}"), "the terminal keeps ⌘1/⌘2 for the shell");
    assert.ok(p.includes("if (!front || inTerminal(e) || "), "⌘K in the terminal starts the chord of the tab shortcuts");
    assert.ok(p.includes("groupsKeys.notice.kind === \"waiting\""), "the status bar does not show the chord");
  },
  close(q) {
    const p = withoutComments(q.pane);
    assert.ok(p.includes("p.holders <= own && !E.otherHolds(gr.ref.current, gid, key) &&"), "a file that stays open in the other group asks on closing");
    assert.ok(p.includes("const after = applyGroups((s) => G.close(s, gid, key));"), "closing does not hit the tab's group");
    // If a group drops (or the focus was in it), it goes to the active one — never to the body; likewise ✕ and a drop.
    assert.ok(p.includes("if (after !== prior && (after.groups.length < prior.groups.length || inTheir)) focusWish.current = after.active;"), "the focus falls to the body when a group drops");
    assert.ok(p.includes("onCloseGroup={(gid) => applyWithFocus((s) => G.removeGroup(s, gid))}"), "✕ on the empty group drops the focus");
    assert.ok(p.includes("const after = applyWithFocus((s) => G.dropTab(s, { group: z.group, path: z.path }, { group: gid, zone, before }, z.copy));"), "a drop does not focus (or ⌥ does not copy)");
    // A restored file that has meanwhile been deleted loses its tab on loading.
    assert.ok(p.includes("if (r.kind === \"error\" && isMissingReading(r.error) && gr.restored.current.delete(path)) { applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path))); return; }"), "a tab of a deleted file comes back as an error after reload");
    assert.ok(p.includes("onClose={(p) => closeTab(p, g.id)}"), "the ✕ of a tab closes in the active group instead of its own");
    assert.ok(p.includes("applyGroups((s) => G.remove(s, E.hitsDeleted((a) => a === path || a.startsWith(path + \"/\"), dirtyOf, followUpLocation)));"), "a deleted file would stay open in a group");
    assert.ok(p.includes("if (kind === \"saved\" && bufferOf(p)?.dirty) continue;"), "\"Close Saved\" would close unsaved ones");
    // ⌘K ⇧⌘W closes the empty groups after all editors (⌘K ⌘W does not); an abort leaves the groups.
    assert.ok(p.includes("for (const g of [...gr.ref.current.groups]) for (const p of [...g.paths]) if (!(await closeTab(p, g.id))) return;\n    if (groupsAlso) applyWithFocus(G.removeEmptyGroups);"),
      "⌘K ⇧⌘W leaves the empty groups (or closes them despite an abort)");
    assert.ok(p.includes("void closeAll(id === \"workbench.action.closeAllGroups\")"), "⌘K ⌘W would also close the groups");
  },
  menu(q) {
    const p = withoutComments(q.pane), one = withoutComments(q.input);
    // The "…" menu exactly as in VS Code (MenuId.EditorTitle) — "Show Opened Editors" | Close All, Close Saved | "Enable Preview Editors" |
    // Maximize | "Configure Editors"; "Keep Open" is in the tab's context menu (VS Code), "Lock Group" is not available in cbase. The items live
    // in components/code/InputParts.tsx (`groupMenuItems`), CodePane supplies conditions and actions.
    const start = one.indexOf("export function groupMenuItems("), end = one.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, "no \"…\" menu of the group");
    const menu = one.slice(start, end);
    let at = 0;
    // With a Markdown preview in front, first the group "1_markdown" of the Markdown extension (Refresh, Lock) — ONLY then.
    assert.ok(menu.includes("p.previewFront ? ["), "the preview entries appear in the \"…\" menu even without a preview");
    for (const w of ["label: t(\"Refresh Preview\")", "label: t(\"Toggle Preview Locking\")", "label: t(\"Show Opened Editors\")", "label: t(\"Close All\")", "label: t(\"Close Saved\")", "label: t(\"Enable Preview Editors\"), on: p.previewEditors", "t(\"Unmaximize Group\") : t(\"Maximize Group\")", "label: t(\"Configure Editors\")"]) {
      const i = menu.indexOf(w, at);
      assert.ok(i > at, `"${w}" is missing in the "…" menu or at the wrong place`);
      at = i;
    }
    assert.equal((menu.match(/label:/g) ?? []).length, 8, "the \"…\" menu has more or fewer entries than VS Code (6 + 2 of the preview)");
    assert.ok(menu.includes("p.several ? [{"), "\"Maximize Group\" is shown with a single group too");
    assert.ok(!menu.includes("Keep Open"), "\"Keep Open\" is in the \"…\" menu (VS Code: in the tab menu)");
    // The wiring in CodePane: the conditions (preview in front, several groups, maximized) and the group actions.
    const a0 = p.indexOf("const groupsMenu = "), connection = a0 < 0 ? "" : p.slice(a0, p.indexOf("\n  };", a0));
    // In front of them: the overflow of the title buttons and Save/Blame of the file in front (web/test/editor-title.test.mjs).
    assert.ok(connection.includes("return [...titleMenuItems(t, fileTitleFor(front, gid), slot), ...groupMenuItems(t, {")
      && connection.includes("previewFront: Boolean(front && E.inputOf(front)?.kind === \"preview\"), several: s.groups.length > 1, maximized: G.maximizedGroup(s) === gid,")
      && connection.includes("previewEditors: settingsRef.current.preview,") && connection.includes("opened: () => showOpened(gid), allClose: () => void closeInGroup(gid, \"all\"), closeSaved: () => void closeInGroup(gid, \"saved\"),")
      && connection.includes("maximize: () => { applyGroups((x) => G.toggleMaximize(G.activateGroup(x, gid))); focusWish.current = gid; },"), "CodePane does not pass conditions or actions to the \"…\" menu");
    // ⌥Z toggles wrapping of the file in front, transiently (not the setting) — and remembering the settings happens outside the updater, in
    // try/catch. lib/code-settings.ts remembers (only the deviations from the default).
    assert.ok(p.includes("e.preventDefault(); wrapToggle(); }") && p.includes("if (p) toggleWrap(p.key, settingsRef.current.wordWrap);"), "⌥Z does not toggle wrapping of the file in front");
    assert.ok(p.includes("if (wrapOf(paLoaded?.key, settings.wordWrap)) list.push(EditorView.lineWrapping);"), "wrapping per file has no effect");
    assert.ok(!p.includes("updateSettings({ wordWrap: !settings.wordWrap })"), "⌥Z toggles the remembered setting again");
    assert.ok(p.includes("    const next = saveCodeSettings(patch);") && p.includes("    settingsRef.current = next;\n    setSettings(next);\n  };")
      && q.former.includes("  try { localStorage.setItem(CODE_SETTINGS_KEY, JSON.stringify(forStorage(state))); } catch"), "localStorage in the setState updater or without try/catch");
    // The palette works in the active group first.
    const pw0 = withoutComments(q.palette);
    assert.ok(/\?\? \(own && visible\(own\.dom\) \? own : null\)\s*\?\? \(last && /.test(pw0), "the palette works in the most recently focused group instead of the active one");
    const pw = withoutComments(q.palette);
    assert.ok(pw.includes("export const WRAP_KEY = \"Alt-z\";") && pw.includes("b.wrap, \"⌥Z\");"), "the palette does not name ⌥Z (or names another key)");
    assert.ok(pw.includes("toggle(\"editor.action.toggleMinimap\""), "minimap is missing in the palette");
    const g = withoutComments(q.groups);
    // "…" is ONE button (EditorTitleSymbols.tsx `MoreButton`) for the group and the title row of the chat.
    assert.ok(g.includes("<MoreButton t={t} menu={menu} data={{ \"data-group-more\": \"\" }} />")
      && withoutComments(q.title).includes("openEditorMenu({ x: r.left, y: r.bottom + 2, groups: menu() })"), "the \"…\" menu is not the ONE editor menu (portal, cb-pop)");
    // The split button splits to the right — with ⌥ (or ⇧ while the pointer is on it) downwards, like the `alt` of a VS Code
    // MenuEntryActionViewItem; its hint names both ("{0}\n[⌥] {2}"). Never disabled (the cap and its hint "At most two editor groups side by
    // side" are gone).
    assert.ok(g.includes("const bottom = u.alt || (u.shift && over);") && g.includes("data-group-share={bottom ? \"bottom\" : \"right\"}"), "the split button does not split downwards with ⌥");
    assert.ok(g.includes("title={bottom ? down : `${right}\\n[${isMac() ? \"⌥\" : \"Alt\"}] ${down}`}"), "the hint of the split button does not name the ⌥");
    assert.ok(g.includes("<TitleSymbolSvg name={bottom ? \"split-vertical\" : \"split-horizontal\"} />"), "the button does not show the symbol of its direction (codicon split-horizontal/-vertical)");
    assert.ok(p.includes("onShare={(below) => partsGroup(g.id, below ? \"bottom\" : \"right\")}"), "CodePane does not split downwards on ⌥-click");
    assert.ok(!/aria-disabled=\{!canShare/.test(g) && !p.includes("At most two editor groups") && !q.en.includes("At most two editor groups") && !q.en.includes("Höchstens zwei Editorgruppen"), "the cap of two groups is back");
    // The context menu of the EMPTY group (VS Code EmptyEditorGroupContext: split up, down, left, right | Close with several groups).
    const lm0 = g.indexOf("export function emptyGroupMenu("), lm = lm0 < 0 ? "" : g.slice(lm0, g.indexOf("\n}\n", lm0));
    let at2 = 0;
    for (const w of ["splitEditorUp\", label: t(\"Split Up\")", "splitEditorDown\", label: t(\"Split Down\")", "splitEditorLeft\", label: t(\"Split Left\")", "splitEditorRight\", label: t(\"Split Right\")", "if (several) groups.push([{ id: \"workbench.action.closeActiveEditorGroup\", label: t(\"Close\")"]) {
      const i = lm.indexOf(w, at2);
      assert.ok(i >= at2 && i >= 0, `"${w}" is missing in the menu of the empty group or at the wrong place`);
      at2 = i;
    }
    assert.ok(g.includes("openEditorMenu({ x: e.clientX, y: e.clientY, groups: emptyGroupMenu(t, status.groups.length > 1, (r) => onParts(g.id, r), () => onCloseGroup(g.id)) });"), "the empty group has no context menu");
    assert.ok(p.includes("onParts={(gid, r) => partsGroup(gid, r)}"), "the menu of the empty group does not split");
    assert.ok(!/fixed inset-0/.test(g), "a fixed inset-0 catcher");
  },
  drawing(q) {
    const g = withoutComments(q.groups);
    assert.ok(g.includes("onMouseDownCapture={() => onActivate(g.id)}") && g.includes("onFocusCapture={() => onActivate(g.id)}"), "a pointer press or focus does not activate the group AT ONCE");
    // THE drag bar of the panel (.cb-sash), no copy; remembered only on release. One per separator of the grid (lib/editor-raster.ts
    // `layoutPx`), vertical or horizontal; the drag computes from the state at press time (`pullSeparator`, minimum sizes there); the double
    // click equalises the branch of the line.
    assert.ok(g.includes("<DragBar") && g.includes("direction={nb ? \"vertical\" : \"horizontal\"}") && g.includes("onBack={() => onBranchFrom(tr.branch)}") && !/function SeparatorBar/.test(g), "the separator bar is a copy of the drag bar (or does not equalise)");
    assert.ok(g.includes("R.layoutPx(raster, mass.w, mass.h)") && g.includes("situation.separator.map("), "the groups and separators do not follow the grid computation");
    assert.ok(g.includes("const start = (transactionStart.current ??= status);") && g.includes("pullSeparator(start, tr.branch, tr.index, distance, tr.lengthBranch)"), "dragging does not compute from the state at press time (or not via lib/editor-groups.ts)");
    assert.ok(g.includes("if (!finished) { setDrag(rasterOf(pullSeparator(start,") && g.includes("onPull(tr.branch, tr.index, distance, tr.lengthBranch);"), "the separator bar writes the state (and localStorage) on every movement");
    assert.ok(withoutComments(q.pane).includes("onPull={(branch, index, distance, length) => applyGroups((s) => G.pullSeparator(s, branch, index, distance, length))}"), "releasing does not remember the sizes");
    // Alignment happens after EVERY change of the grid (VS Code saveProportions), never after a resize of the surface (the dimensions are not
    // among the dependencies), never during a drag, never maximized — and via lib/editor-groups.ts.
    assert.ok(g.includes("if (alignedWith.current === status.raster) return;") && g.includes("onAlign(m.w, m.h);")
      && g.includes("}, [status.raster, load, turn, maximized, onAlign]);"), "the grid does not align its shares to what is drawn after every change (or also after a resize)");
    // BEFORE painting (an insertion is finished in pixels there — otherwise the halved source would show for one tick). A restored state becomes
    // the baseline without being aligned — counted in the connection, passed on by CodePane.
    assert.ok(g.includes("useLayoutEffect(() => {\n    if (loadedAt.current !== load) { loadedAt.current = load; alignedWith.current = status.raster; return; }"),
      "a restored state is aligned (or alignment happens only after painting)");
    assert.ok(withoutComments(q.connection).includes("if (s) { ref.current = s; setStatus(s); setLoad((n) => n + 1); "), "restoring is not counted");
    assert.ok(withoutComments(q.pane).includes("load={gr.load}"), "the surface does not learn that a restore happened");
    // The groups sit in the DOM by id (lib/editor-groups.ts `domOrder`), their number stays that of the grid.
    assert.ok(g.includes("{domOrder(status.groups).map((g) => {") && !g.includes("current.groups.map((g"), "the groups sit in the DOM in grid order (a rebuild moves nodes)");
    assert.ok(g.includes("t(\"Editor Group {n}\", { n: status.groups.indexOf(g) + 1 })"), "the number of a group is not that of the grid");
    // ⇧ over a group with a text editor in front: no zone, the drop belongs to the editor — for tabs as for the explorer; over an empty group
    // (or preview, comparison) ⇧ does not apply. A file tab carries its path as text (the editor inserts it).
    assert.ok(g.includes("const throwInTheEditor = (e: React.DragEvent, g: Group) => e.shiftKey && fileTab(g.active) !== null;")
      && g.includes("if (throwInTheEditor(e, g)) { if (thrown) setDrop(null); return; }") && g.includes("setDrop(null);\n                if (throwInTheEditor(e, g)) return;\n")
      && !g.includes("kind === \"tree\" && e.shiftKey"), "⇧ does not hand the drop to the editor as in VS Code (only for the explorer, also over an empty group, or not on drop)");
    // A tab or explorer entry that the surface does not accept (another area — chat ↔ files, another window — or a tab in the chat that has a
    // group) NEVER falls into the editor as text (measured: the path ended up in the text); in the chat a drop from the explorer opens the
    // files as chat tabs (VS Code `editorDropTarget`).
    assert.ok(g.includes("export const cbaseTransaction = (e: { dataTransfer: { types: readonly string[] } }) => e.dataTransfer.types.includes(TAB_TYPE) || e.dataTransfer.types.includes(TREE_TYPE);")
      && g.includes("export const acceptable = (kind: \"tab\" | \"tree\" | \"foreign\" | null, droppable: boolean): \"tab\" | \"tree\" | \"foreign\" | null => (kind === \"tab\" && !droppable ? null : kind);")
      && (g.match(/const kind = acceptable\(transactionKind\(e, area, location\), droppable\);/g) ?? []).length === 2
      && g.includes("if (!kind) { if (cbaseTransaction(e) && !throwInTheEditor(e, g)) { e.stopPropagation(); if (thrown) setDrop(null); } return; }")
      && g.includes("if (!kind) { if (cbaseTransaction(e)) { e.preventDefault(); e.stopPropagation(); } return; }")
      && g.includes("onDragOverCapture={(e) => {") && g.includes("onDropCapture={(e) => {")
      && (g.match(/const zone = droppable \? zoneAt\(e, g\) : "middle"/g) ?? []).length === 2,
      "a foreign tab/explorer drag falls into the editor as text, or the chat splits/accepts tabs on the surface");
    assert.ok(withoutComments(q.pane).includes("if (stRef.current) { for (const p of d) void openFile(p, undefined, true); return; }"), "an explorer drop opens nothing in the chat");
    assert.ok(withoutComments(q.tile).includes("const path = fileTab(drag.key);\n        if (path) e.dataTransfer.setData(\"text/plain\", path);"), "a dragged file tab does not carry its path as text");
    // The zone fades in within 150 ms and moves within 70 ms (top/left/width/height, `ease-out`) — only with motion allowed.
    assert.ok(g.includes("motion-safe:[animation:fade-in_150ms_ease-out] motion-safe:[transition:top_70ms_ease-out,left_70ms_ease-out,width_70ms_ease-out,height_70ms_ease-out]"),
      "the zone does not fade in as in VS Code, does not move within 70 ms, or also moves without allowed motion");
    assert.match(q.css, /@keyframes fade-in \{\s*from \{ opacity: 0; \}\s*to\s+\{ opacity: 1; \}\s*\}/, "the fade-in does not go from 0 to 1");
    assert.ok(g.includes("if (turn || maximized || !(m.w > 0 && m.h > 0)) return;"), "alignment also happens during a drag, maximized or unmeasured");
    assert.ok(withoutComments(q.pane).includes("onAlign={(b, h) => applyGroups((s) => G.alignTo(s, b, h))}"), "the alignment does not reach the state");
    // No insertion line of the editor under a tab in the middle of its own surface; the empty group with focus carries the border.
    assert.ok(g.includes("e.dataTransfer.dropEffect = \"none\";"), "a tab in the middle of its own surface shows the editor's insertion line");
    assert.ok(g.includes("focus:outline-accent"), "a focused empty group has no focus border");
    assert.ok(g.includes("data-editor-location={`${area}:${g.id}`}"), "the group does not name its location (breadcrumbs per group)");
    assert.ok(g.includes("${hidden ? \"hidden\" : \"\"}"), "a maximized group does not hide the other");
    assert.ok(g.includes("onDragOverCapture=") && g.includes("onDropCapture=") && (g.match(/e\.stopPropagation\(\);/g) ?? []).length >= 2,
      "the surface does not take drops in the capture phase — CodeMirror would insert the paths of an explorer drag as text");
    assert.ok(g.includes("splittable(status, g.id,") && g.includes("dropZone("), "the zone does not use lib/editor-groups.ts");
    assert.ok(g.includes("data-group-throw={thrown.zone}"), "no display of the zone");
    const k = withoutComments(q.tile);
    assert.ok(k.includes("${dimmed ? \"opacity-50\" : \"\"}") && k.includes("${dimmed ? \"before:bg-edge\" : \"before:bg-accent\"}"), "the tabs of an inactive group are not dimmed");
    assert.ok(k.includes("dimmed={group ? !group.active : false}"), "the bar does not pass the group focus to its tabs");
    // Insertion markers in `tab.dragAndDropBorder` (Dark Modern: the foreground of the active tab).
    assert.ok(k.includes("w-0.5 rounded bg-fg ${thrown") && k.includes("w-0.5 rounded bg-fg\" style={{ left: Math.max(0, marker - 1) }}"), "the insertion marker uses the accent colour instead of tab.dragAndDropBorder");
    // The tabs scroll horizontally, the actions sit beside them and never cover; the active tab stays in view, also when narrowing.
    assert.ok(k.includes("className=\"cb-tabs-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto\""), "the tabs do not scroll (or without a thin scrollbar)");
    assert.ok(k.includes("<div className=\"relative z-10 flex shrink-0 items-center gap-0.5 bg-bg px-1.5\" data-tab-bar-actions>"), "the actions cover the tabs (transparent or under them)");
    assert.ok(k.includes("ro?.observe(bar);"), "the active tab does not scroll along when the bar narrows");
    // Breadcrumbs per group.
    assert.ok(withoutComments(q.pane).includes("<Breadcrumbs target={target} path={active.path} location={`${area}:${g.id}`} />"), "the breadcrumbs hang on the file, not on the group's editor");
    assert.ok(withoutComments(q.crumbs).includes("if (location) set(locationKey(k, location), view, chain);"), "the chain is not per location");
  },
  drag(q) {
    const k = withoutComments(q.tile);
    assert.ok(k.includes("rememberDrag({ area: group.area, kind: \"tab\", group: group.id, path, copy: false })"), "a dragged tab is not remembered");
    assert.ok(k.includes("if (group && onDeposit && z?.kind === \"tab\" && z.group !== group.id) onDeposit({ path: p, afterwards }, null);"), "a tab from the other group only reordered instead of moving over");
    assert.ok(k.includes("data-tab-bar-marker"), "no insertion marker on the bar");
    assert.ok(k.includes("{ id: \"workbench.action.splitEditor\", label: t(\"Split Right\"), execute: () => parts.parts(\"right\") },"), "\"Split Right\" is missing in the tab menu");
    assert.ok(/export const DRAG_TYPE = "application\/x-cbase-tree";/.test(q.tree), "the data type of the explorer is not shared");
    // The explorer carries `{ apiBase, instance, paths }` — the groups read the paths from it, unreadable data yields none.
    assert.match(withoutComments(q.tree), /type DragData = \{[^}]*\bpaths: string\[\] \};/, "the explorer no longer supplies a `paths` list");
    const { pathsFrom } = loadTransaction(q.turn);
    assert.deepEqual(pathsFrom(JSON.stringify({ apiBase: "/api/projects/p", instance: null, paths: ["a.ts", "", 3, "b/c.ts"] })), ["a.ts", "b/c.ts"],
      "a drop from the explorer does not open its files");
    assert.deepEqual(pathsFrom("not JSON"), [], "unreadable data yielded paths");
    assert.deepEqual(pathsFrom(JSON.stringify({ apiBase: "/api/projects/p" })), [], "a drop without paths yielded paths");
    assert.ok(withoutComments(q.pane).includes("const d = files.filter((p) => !ex.isFolder(p));"), "a folder from the explorer opened as a tab");
    // Tab menu as in VS Code — "Split Right" and the submenu "Split & Move" (EditorSplitMoveSubmenu: split up, down, left, right | move up,
    // down, left, right, in this order); "Keep Open" only on a preview.
    const split0 = k.indexOf("{ id: \"share-and-move\", label: t(\"Split & Move\"), children: [");
    assert.ok(split0 > 0, "\"Split & Move ▸\" is missing in the tab menu");
    let at3 = split0;
    for (const [id, label, way] of [["splitEditorUp", "Split Up", "parts.parts(\"top\")"], ["splitEditorDown", "Split Down", "parts.parts(\"bottom\")"], ["splitEditorLeft", "Split Left", "parts.parts(\"left\")"],
      ["splitEditorRight", "Split Right", "parts.parts(\"right\")"], ["moveEditorToAboveGroup", "Move Above", "parts.move(\"top\")"], ["moveEditorToBelowGroup", "Move Below", "parts.move(\"bottom\")"],
      ["moveEditorToLeftGroup", "Move Left", "parts.move(\"left\")"], ["moveEditorToRightGroup", "Move Right", "parts.move(\"right\")"]]) {
      const w = `{ id: "workbench.action.${id}", label: t("${label}"), execute: () => ${way} },`, i = k.indexOf(w, at3);
      assert.ok(i > at3, `"${label}" is missing in "Split & Move ▸", at the wrong place or does something else`);
      at3 = i;
    }
    const pn0 = withoutComments(q.pane);
    assert.ok(pn0.includes("parts: (r: G.Direction) => partsGroup(gid, r, path),") && pn0.includes("move: (r: G.Direction) => moveEditor(gid, { direction: r }, path),"), "the tab menu does not split or move THIS tab");
    assert.ok(k.includes("if (h.keep && h.preview) groups.push("), "\"Keep Open\" also appears on a fixed tab");
    // A drag also ends when its source vanished with the drop (its dragend never comes) — EXECUTED against a stand-in document.
    const z = loadTransaction(q.turn), old = globalThis.document;
    globalThis.document = new EventTarget();
    try {
      z.rememberDrag({ area: "b", kind: "tab", group: "g1", path: "a.ts", copy: false });
      z.copyInTransaction(true);
      globalThis.document.dispatchEvent(new Event("dragend"));
      assert.equal(z.runningDrag(), null, "a drag survives its end at the document");
      z.rememberDrag({ area: "b", kind: "tree" });
      const second = z.runningDrag();
      z.rememberDrag({ area: "b", kind: "tree" });
      assert.notEqual(second, null);
    } finally { z.rememberDrag(null); globalThis.document = old; }
    assert.ok(withoutComments(q.pane).includes("rememberDrag(null);") && withoutComments(q.groups).includes("rememberDrag(null);"), "the drop does not forget the drag");
    // Splitting, moving and a drop carry the view state along.
    const pn = withoutComments(q.pane);
    assert.equal((pn.match(/giveState\(after\.active, /g) ?? []).length, 3, "splitting, moving or a drop lose selection and scroll position");
    assert.ok(pn.includes("state={statusStorageFor(g.id)}"), "the editor of a group does not remember its state");
    const pe = withoutComments(q.editor);
    assert.ok(pe.includes("if (remembered) applyState(v, remembered);") && pe.includes("window.addEventListener(\"pagehide\", rememberAll);"), "the state does not survive reload");
    // "Open to the Side" in the explorer (⌃↵, ⌥-click, context menu).
    const b = withoutComments(q.tree);
    assert.ok(b.includes("case \"open-beside\": if (f !== null && fKind === \"file\" && ex.openBeside) ex.openBeside(f); return;"), "⌃↵ does not open to the side");
    assert.ok(b.includes("if (e.altKey && !meta && !e.shiftKey && ex.openBeside && row.type === \"file\")"), "⌥-click does not open to the side");
    assert.ok(b.includes("case \"to-page\": return { label: t(\"Open to the Side\"), shortcut: \"⌃↵\""), "\"Open to the Side\" is missing in the context menu");
    assert.ok(pn.includes("onOpenBeside: controlled ? undefined : (p) => openBeside(p),"), "the explorer does not know \"Open to the Side\"");
    // The same file in front in several groups asks once (git base, LSP, gutter) — per file in front in ANOTHER group one `GitBase`, each
    // once, never that of the active one.
    assert.ok(pn.includes("[...new Set(gr.state.groups.filter((g) => g.id !== gr.state.active).map((g) => E.fileTab(g.active)))].filter((p): p is string => Boolean(p) && p !== activePath)"), "the same file in two groups fetches its git base twice");
    assert.ok(pn.includes("{otherBases.map((p) => {") && pn.includes("return <GitBase key={p} "), "the groups beside the active one get no git base (no gutter)");
    assert.ok(withoutComments(q.core).includes("if (running) return running as Promise<LspResponse<A>>;"), "identical LSP requests for the same state run twice");
    assert.ok(withoutComments(q.margin).includes("if (old && old.text === text) return old.blocks;"), "the git gutter recomputes per view");
  },
  texts(q) {
    // Every new text has a German entry in i18n-de.ts (otherwise the German UI shows English) — the palette titles too.
    const keys = new Set();
    const from = q.pane.indexOf("// ── Editor groups ──"), until = q.pane.indexOf("function onKeyDown(", from);
    assert.ok(from > 0 && until > from, "the editor groups section in CodePane is missing");
    for (const text of [q.groups, q.tile, q.connection, q.pane.slice(from, until)]) for (const m of text.matchAll(/\bt\("([^"]+)"/g)) keys.add(m[1]);
    for (const m of q.lib.matchAll(/title: "([^"]+)"/g)) keys.add(m[1]);
    for (const k of ["({k}) was pressed. Waiting for second key of chord...", "The key combination ({k}, {second}) is not a command.", "Open to the Side"]) keys.add(k);
    assert.ok(keys.size >= 20, `too few texts found (${keys.size})`);
    const missing = [...keys].filter((k) => !q.en.includes(`${JSON.stringify(k)}:`));
    assert.deepEqual(missing, [], "texts without a German entry (web/src/lib/i18n-de.ts)");
  },
};
const SOURCE_SABOTAGES = {
  "state not per instance": { file: "pane", old: "useEditorGroups(controlled ? null : [apiBase, instance ?? \"\"].join(\"|\"))", fresh: "useEditorGroups(controlled ? null : apiBase)", catches: "connection" },
  // Connection
  "only the active group loads": { file: "pane", old: "E.heldFiles(gr.state).join(\"\\n\")", fresh: "G.activeGroup(gr.stand).paths.join(\"\\n\")", catches: "connection" },
  "flashing": { file: "connection", old: "useLayoutEffect(() => {\n    read.current = null;", fresh: "useEffect(() => {\n    read.current = null;", catches: "connection" },
  "chord without deadline": { file: "connection", old: "report({ kind: \"waiting\" }, CHORD_DEADLINE_MS);", fresh: "report({ kind: \"waiting\" });", catches: "connection" },
  "chord survives the window change": { file: "connection", old: "window.addEventListener(\"blur\", onBlur);", fresh: "", catches: "connection" },
  "second key silent": { file: "connection", old: "else report({ kind: \"no\", combo: pressText(e, isMac()) }, NO_COMMAND_MS);", fresh: "else report(null);", catches: "connection" },
  "⌘K in the terminal": { file: "connection", old: "(inTerminal(e) && (r === \"chord\" || !TERMINAL_PASSTHROUGH.includes(r)))", fresh: "(inTerminal(e) && !TERMINAL_PASSTHROUGH.includes(r as never))", catches: "connection" },
  "⌘1 not from the terminal": { file: "connection", old: "(inTerminal(e) && (r === \"chord\" || !TERMINAL_PASSTHROUGH.includes(r)))", fresh: "inTerminal(e)", catches: "connection" },
  "⌥Z in the terminal": { file: "pane", old: "else if (!inTerminal(e) && matchesKey(WRAP_KEY", fresh: "else if (matchesKey(WRAP_KEY", catches: "connection" },
  "terminal without group keys": { file: "pane", old: "letThrough={(e) => keyForTheWorkbench(e) || G.groupThroughTheTerminal(e, isMac())}", fresh: "letThrough={keyForTheWorkbench}", catches: "connection" },
  "tab chord in the terminal": { file: "pane", old: "if (!front || inTerminal(e) || ", fresh: "if (!front || ", catches: "connection" },
  "focus drops on closing": { file: "pane", old: "if (after !== prior && (after.groups.length < prior.groups.length || inTheir)) focusWish.current = after.active;", fresh: "", catches: "close" },
  "✕ without focus": { file: "pane", old: "onCloseGroup={(gid) => applyWithFocus(", fresh: "onCloseGroup={(gid) => applyGroups(", catches: "close" },
  "⌥ does not copy": { file: "pane", old: "{ group: gid, zone, before }, z.copy));", fresh: "{ group: gid, zone, before }));", catches: "close" },
  "deleted file stays after reload": { file: "pane", old: "&& gr.restored.current.delete(path)) { applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path))); return; }", fresh: "&& false) { return; }", catches: "close" },
  "\"…\" without Show Opened Editors": { file: "input", old: "label: t(\"Show Opened Editors\")", fresh: "label: t(\"Editors\")", catches: "menu" },
  "maximizing also with one group": { file: "pane", old: "several: s.groups.length > 1,", fresh: "several: true,", catches: "menu" },
  "maximizing without condition": { file: "input", old: "p.several ? [{", fresh: "true ? [{", catches: "menu" },
  "⌥Z toggles the setting": { file: "pane", old: "e.preventDefault(); wrapToggle(); }", fresh: "e.preventDefault(); updateSettings({ wordWrap: !settings.wordWrap }); }", catches: "menu" },
  "wrapping not per file": { file: "pane", old: "if (wrapOf(paLoaded?.key, settings.wordWrap)) list.push", fresh: "if (settings.wordWrap) list.push", catches: "menu" },
  "localStorage in the updater": { file: "pane", old: "    setSettings(next);\n  };", fresh: "    setSettings(() => { saveCodeSettings(patch); return next; });\n  };", catches: "menu" },
  "localStorage without try/catch": { file: "former", old: "  try { localStorage.setItem(CODE_SETTINGS_KEY, JSON.stringify(forStorage(state))); } catch { /* for this session only */ }", fresh: "  localStorage.setItem(CODE_SETTINGS_KEY, JSON.stringify(forStorage(state)));", catches: "menu" },
  "palette in the most recently focused": { file: "palette", old: "?? (own && visible(own.dom) ? own : null)\n    ?? (last", fresh: "?? null\n    ?? (last", catches: "menu" },
  "⌥ splits right": { file: "groups", old: "const bottom = u.alt || (u.shift && over);", fresh: "const bottom = false;", catches: "menu" },
  "⇧ splits down even without the pointer": { file: "groups", old: "(u.shift && over)", fresh: "u.shift", catches: "menu" },
  "hint without ⌥": { file: "groups", old: "`${right}\\n[${isMac() ? \"⌥\" : \"Alt\"}] ${down}`", fresh: "right", catches: "menu" },
  "⌥-click splits right": { file: "pane", old: "onShare={(below) => partsGroup(g.id, below ? \"bottom\" : \"right\")}", fresh: "onShare={() => partsGroup(g.id)}", catches: "menu" },
  "separator bar remembers on every movement": { file: "groups", old: "if (!finished) { setDrag(rasterOf(pullSeparator(start,", fresh: "if (!finished) { onPull(tr.branch, tr.index, distance, tr.lengthBranch); setDrag(rasterOf(pullSeparator(start,", catches: "drawing" },
  "no alignment": { file: "groups", old: "onAlign(m.w, m.h);", fresh: "", catches: "drawing" },
  "alignment after every resize": { file: "groups", old: "}, [status.raster, load, turn, maximized, onAlign]);", fresh: "}, [status.raster, load, turn, maximized, onAlign, mass]);", catches: "drawing" },
  // Drawing
  "restoring aligns": { file: "groups", old: "if (loadedAt.current !== load) { loadedAt.current = load; alignedWith.current = status.raster; return; }", fresh: "", catches: "drawing" },
  "alignment after painting": { file: "groups", old: "useLayoutEffect(() => {\n    if (loadedAt.current", fresh: "useEffect(() => {\n    if (loadedAt.current", catches: "drawing" },
  "restoring not counted": { file: "connection", old: "setLoad((n) => n + 1); ", fresh: "", catches: "drawing" },
  "load does not reach the surface": { file: "pane", old: "load={gr.load}", fresh: "load={0}", catches: "drawing" },
  "DOM in grid order": { file: "groups", old: "{domOrder(status.groups).map((g) => {", fresh: "{stand.groups.map((g) => {", catches: "drawing" },
  "number by the DOM": { file: "groups", old: "n: status.groups.indexOf(g) + 1", fresh: "n: domOrder(stand.groups).indexOf(g) + 1", catches: "drawing" },
  "⇧ only for the explorer": { file: "groups", old: "if (throwInTheEditor(e, g)) { if (thrown) setDrop(null); return; }", fresh: "if (kind === \"tree\" && e.shiftKey) { if (thrown) setDrop(null); return; }", catches: "drawing" },
  "⇧ also over an empty group": { file: "groups", old: "e.shiftKey && fileTab(g.active) !== null", fresh: "e.shiftKey", catches: "drawing" },
  "⇧ drop goes to the group": { file: "groups", old: "setDrop(null);\n                if (throwInTheEditor(e, g)) return;\n", fresh: "setDrop(null);\n", catches: "drawing" },
  // A drag the surface does not accept never falls into the editor as text; in the chat an explorer drop opens the files.
  "foreign drag falls as text (drag)": { file: "groups", old: "if (!kind) { if (cbaseTransaction(e) && !throwInTheEditor(e, g)) { e.stopPropagation(); if (thrown) setDrop(null); } return; }", fresh: "if (!kind) return;", catches: "drawing" },
  "foreign drag falls as text (drop)": { file: "groups", old: "if (!kind) { if (cbaseTransaction(e)) { e.preventDefault(); e.stopPropagation(); } return; }", fresh: "if (!kind) return;", catches: "drawing" },
  "protection only with groups": { file: "groups", old: "onDropCapture={(e) => {", fresh: "onDropCapture={droppable ? (e) => {", catches: "drawing" },
  "protection recognises only tabs": { file: "groups", old: "e.dataTransfer.types.includes(TAB_TYPE) || e.dataTransfer.types.includes(TREE_TYPE)", fresh: "e.dataTransfer.types.includes(TAB_TYPE)", catches: "drawing" },
  "chat accepts tabs on the surface": { file: "groups", old: "(kind === \"tab\" && !droppable ? null : kind)", fresh: "kind", catches: "drawing" },
  "chat splits": { file: "groups", old: "const zone = droppable ? zoneAt(e, g) : \"middle\";\n", fresh: "const zone = zoneAt(e, g);\n", catches: "drawing" },
  "explorer drop in the chat does not open": { file: "pane", old: "if (stRef.current) { for (const p of d) void openFile(p, undefined, true); return; }", fresh: "", catches: "drawing" },
  "tab without text": { file: "tile", old: "if (path) e.dataTransfer.setData(\"text/plain\", path);", fresh: "", catches: "drawing" },
  "zone without fade-in": { file: "groups", old: "motion-safe:[animation:fade-in_150ms_ease-out] ", fresh: "", catches: "drawing" },
  "zone jumps": { file: "groups", old: "motion-safe:[transition:top_70ms_ease-out,left_70ms_ease-out,width_70ms_ease-out,height_70ms_ease-out]", fresh: "transition-[left,top,width,height] duration-100", catches: "drawing" },
  "zone moves despite reduce": { file: "groups", old: "motion-safe:[transition:", fresh: "[transition:", catches: "drawing" },
  "fade-in without start 0": { file: "css", old: "@keyframes fade-in {\n  from { opacity: 0; }", fresh: "@keyframes fade-in {\n  from { opacity: 0.6; }", catches: "drawing" },
  "⌘K ⇧⌘W leaves empty groups": { file: "pane", old: "if (groupsAlso) applyWithFocus(G.removeEmptyGroups);", fresh: "", catches: "close" },
  "⌘K ⌘W closes groups": { file: "pane", old: "void closeAll(id === \"workbench.action.closeAllGroups\")", fresh: "void closeAll(true)", catches: "close" },
  "abort closes the groups": { file: "pane", old: "if (!(await closeTab(p, g.id))) return;\n    if (groupsAlso)", fresh: "if (!(await closeTab(p, g.id))) break;\n    if (groupsAlso)", catches: "close" },
  "alignment during a drag": { file: "groups", old: "if (turn || maximized || !(m.w > 0 && m.h > 0)) return;", fresh: "if (!(m.w > 0 && m.h > 0)) return;", catches: "drawing" },
  "alignment does not reach the state": { file: "pane", old: "onAlign={(b, h) => applyGroups((s) => G.alignTo(s, b, h))}", fresh: "onAlign={() => {}}", catches: "drawing" },
  "drag from the running state": { file: "groups", old: "const start = (transactionStart.current ??= status);", fresh: "const start = state;", catches: "drawing" },
  "insertion line of the editor": { file: "groups", old: "e.dataTransfer.dropEffect = \"none\";", fresh: "", catches: "drawing" },
  "empty group without focus border": { file: "groups", old: "focus:outline-accent", fresh: "", catches: "drawing" },
  "group without location": { file: "groups", old: "data-editor-location={`${area}:${g.id}`}", fresh: "", catches: "drawing" },
  "maximization hides nothing": { file: "groups", old: "${hidden ? \"hidden\" : \"\"}", fresh: "", catches: "drawing" },
  "marker in accent colour": { file: "tile", old: "w-0.5 rounded bg-fg ${thrown", fresh: "w-0.5 rounded bg-accent ${thrown", catches: "drawing" },
  "tabs scroll without a bar": { file: "tile", old: "className=\"cb-tabs-scroll flex", fresh: "className=\"cb-strip flex", catches: "drawing" },
  "actions over the tabs": { file: "tile", old: "relative z-10 flex shrink-0 items-center gap-0.5 bg-bg px-1.5", fresh: "absolute right-0 flex items-center gap-0.5 px-1.5", catches: "drawing" },
  "active tab does not scroll along": { file: "tile", old: "ro?.observe(bar);", fresh: "", catches: "drawing" },
  "breadcrumbs per file": { file: "pane", old: " location={`${area}:${g.id}`} />", fresh: " />", catches: "drawing" },
  "chain not per location": { file: "crumbs", old: "if (location) set(locationKey(k, location), view, chain);", fresh: "", catches: "drawing" },
  "Split & Move without left": { file: "tile", old: "{ id: \"workbench.action.moveEditorToLeftGroup\", label: t(\"Move Left\"), execute: () => parts.move(\"left\") },", fresh: "", catches: "drag" },
  "Split Down splits right": { file: "tile", old: "execute: () => parts.parts(\"bottom\") },", fresh: "execute: () => parts.parts(\"right\") },", catches: "drag" },
  "tab menu moves the active one": { file: "pane", old: "move: (r: G.Direction) => moveEditor(gid, { direction: r }, path),", fresh: "move: (r: G.Direction) => moveEditor(gid, { direction: r }),", catches: "drag" },
  "Keep Open on a fixed tab": { file: "tile", old: "if (h.keep && h.preview) groups.push(", fresh: "if (h.keep) groups.push(", catches: "drag" },
  "drag survives its end": { file: "turn", old: "document.addEventListener(\"dragend\", past, true);", fresh: "", catches: "drag" },
  "drag counted per object": { file: "turn", old: "const past = () => { if (seq === mine) turn = null; };", fresh: "const past = () => { if (turn === z) turn = null; };", catches: "drag" },
  "splitting without state": { file: "pane", old: "    giveState(after.active, file, st);\n    focusWish.current = after.active;\n  };\n  // Ctrl+Cmd+Left", fresh: "    focusWish.current = after.active;\n  };\n  // Ctrl+Cmd+Left", catches: "drag" },
  "editor without state": { file: "pane", old: "state={statusStorageFor(g.id)}", fresh: "", catches: "drag" },
  "state not restored": { file: "editor", old: "if (remembered) applyState(v, remembered);", fresh: "", catches: "drag" },
  "⌃↵ missing": { file: "tree", old: "case \"open-beside\": if (f !== null && fKind === \"file\" && ex.openBeside) ex.openBeside(f); return;", fresh: "", catches: "drag" },
  "git base twice": { file: "pane", old: ".filter((p): p is string => Boolean(p) && p !== activePath)", fresh: ".filter((p): p is string => Boolean(p))", catches: "drag" },
  "groups without git base": { file: "pane", old: "{otherBases.map((p) => {", fresh: "{[].map((p) => {", catches: "drag" },
  "LSP twice": { file: "core", old: "if (running) return running as Promise<LspResponse<A>>;", fresh: "", catches: "drag" },
  "gutter twice": { file: "margin", old: "if (old && old.text === text) return old.blocks;", fresh: "", catches: "drag" },
  "chord without capture": { file: "pane", old: "onKeyDownCapture={groupsKeys.capture} ", fresh: "", catches: "connection" },
  "keys only in the editor": { file: "pane", old: "if (groupsKeys.key(e)) return;", fresh: "", catches: "connection" },
  "one view for all groups": { file: "pane", old: "viewRef={viewOf(g.id)}", fresh: "viewRef={cmRef}", catches: "connection" },
  "explorer drag not remembered": { file: "pane", old: "rememberDrag({ area, kind: \"tree\" })", fresh: "void 0", catches: "connection" },
  "keys also in the chat": { file: "pane", old: "useGroupsKeys(rootRef, !isControlled, groupsCommand, groupsCan)", fresh: "useGroupsKeys(rootRef, true, groupsCommand, groupsCan)", catches: "connection" },
  "commands everywhere": { file: "connection", old: "condition: (_situation, k) => hostOf(k.view) !== null", fresh: "condition: () => true", catches: "connection" },
  "start overwrites remembered state": { file: "connection", old: "if (!key || read.current !== key) return;", fresh: "if (!key) return;", catches: "connection" },
  "asks despite a second group": { file: "pane", old: "p.holders <= own && !E.otherHolds(gr.ref.current, gid, key) &&", fresh: "p.holders <= own &&", catches: "close" },
  "preview entries always": { file: "pane", old: "previewFront: Boolean(front && E.inputOf(front)?.kind === \"preview\"),", fresh: "previewFront: Boolean(front),", catches: "menu" },
  "preview entries without condition": { file: "input", old: "p.previewFront ? [", fresh: "true ? [", catches: "menu" },
  "✕ in the active group": { file: "pane", old: "onClose={(p) => closeTab(p, g.id)}", fresh: "onClose={(p) => closeTab(p)}", catches: "close" },
  "Close Saved closes everything": { file: "pane", old: "if (kind === \"saved\" && bufferOf(p)?.dirty) continue;", fresh: "", catches: "close" },
  "word wrap back in the \"…\" menu": { file: "input", old: "execute: p.closeSaved },", fresh: "execute: p.closeSaved }, { id: \"editor.action.toggleWordWrap\", label: t(\"Word wrap\"), execute: () => undefined },", catches: "menu" },
  "⌥Z does nothing": { file: "pane", old: "matchesKey(WRAP_KEY, e, isMac())", fresh: "false", catches: "connection" },
  "palette without ⌥Z": { file: "palette", old: "b.wrap, \"⌥Z\");", fresh: "b.wrap);", catches: "menu" },
  "own menu": { file: "title", old: "openEditorMenu({ x: r.left, y: r.bottom + 2, groups: menu() })", fresh: "void menu()", catches: "menu" },
  "own \"…\" button of the group": { file: "groups", old: "<MoreButton t={t} menu={menu} data={{ \"data-group-more\": \"\" }} />", fresh: "<button data-group-more />", catches: "menu" },
  "the cap in the button": { file: "groups", old: "data-group-share={bottom ? \"bottom\" : \"right\"}", fresh: "data-group-share={bottom ? \"bottom\" : \"right\"} aria-disabled={!canShare || undefined}", catches: "menu" },
  "empty menu without Up": { file: "groups", old: "{ id: \"workbench.action.splitEditorUp\", label: t(\"Split Up\"), execute: () => parts(\"top\") },", fresh: "", catches: "menu" },
  "empty menu also closes the last one": { file: "groups", old: "if (several) groups.push([{ id: \"workbench.action.closeActiveEditorGroup\"", fresh: "groups.push([{ id: \"workbench.action.closeActiveEditorGroup\"", catches: "menu" },
  "empty group without menu": { file: "groups", old: "openEditorMenu({ x: e.clientX, y: e.clientY, groups: emptyGroupMenu(", fresh: "void ({ x: e.clientX, y: e.clientY, groups: emptyGroupMenu(", catches: "menu" },
  "empty menu does not split": { file: "pane", old: "onParts={(gid, r) => partsGroup(gid, r)}", fresh: "onParts={() => undefined}", catches: "menu" },
  "activating only on release": { file: "groups", old: "onMouseDownCapture={() => onActivate(g.id)}", fresh: "onMouseUp={() => onActivate(g.id)}", catches: "drawing" },
  "double click does not equalise": { file: "groups", old: "onBack={() => onBranchFrom(tr.branch)}", fresh: "onBack={() => undefined}", catches: "drawing" },
  "vertical lines only": { file: "groups", old: "direction={nb ? \"vertical\" : \"horizontal\"}", fresh: "direction=\"vertical\"", catches: "drawing" },
  "groups not by the grid": { file: "groups", old: "R.layoutPx(raster, mass.w, mass.h)", fresh: "R.layoutPx(R.queue(R.sheets(raster)), mass.w, mass.h)", catches: "drawing" },
  "releasing does not remember": { file: "pane", old: "onPull={(branch, index, distance, length) => applyGroups((s) => G.pullSeparator(s, branch, index, distance, length))}", fresh: "onPull={() => undefined}", catches: "drawing" },
  "drop only after the editor": { file: "groups", old: "onDropCapture=", fresh: "onDrop=", catches: "drawing" },
  "drag only after the editor": { file: "groups", old: "onDragOverCapture=", fresh: "onDragOver=", catches: "drawing" },
  "inactive tabs not dimmed": { file: "tile", old: "${dimmed ? \"opacity-50\" : \"\"}", fresh: "", catches: "drawing" },
  "bar does not pass the focus on": { file: "tile", old: "dimmed={group ? !group.active : false}", fresh: "dimmed={false}", catches: "drawing" },
  "tab not remembered": { file: "tile", old: "rememberDrag({ area: group.area, kind: \"tab\", group: group.id, path, copy: false })", fresh: "void 0", catches: "drag" },
  "foreign tab only reorders": { file: "tile", old: "if (group && onDeposit && z?.kind === \"tab\" && z.group !== group.id) onDeposit({ path: p, afterwards }, null);", fresh: "if (false) onDeposit({ path: p, afterwards }, null);", catches: "drag" },
  "Split Right missing": { file: "tile", old: "{ id: \"workbench.action.splitEditor\", label: t(\"Split Right\")", fresh: "{ id: \"workbench.action.splitEditor\", label: t(\"Split\")", catches: "drag" },
  "folder as tab": { file: "pane", old: "const d = files.filter((p) => !ex.isFolder(p));", fresh: "const d = files;", catches: "drag" },
  "explorer drop read as a bare list": { file: "turn", old: "(raw as { paths?: unknown }).paths : null", fresh: "null : raw", catches: "drag" },
  "explorer drop without filter": { file: "turn", old: "list.filter((p): p is string => typeof p === \"string\" && p !== \"\")", fresh: "(list as string[])", catches: "drag" },
  "explorer supplies no paths": { file: "tree", old: "paths: string[] };", fresh: "files: string[] };", catches: "drag" },
  "German entry missing": { file: "en", old: "\"Split Editor Right\": ", fresh: "\"Split Editor Right (old)\": ", catches: "texts" },
  "palette title without German entry": { file: "lib", old: "title: \"View: Split Editor\"", fresh: "title: \"View: Split the Editor\"", catches: "texts" },
};

test("(2) sources: groups in CodePane, keys and chords, closing, \"…\" menu, focus, separator bar, dragging, texts", () => {
  for (const [name, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(2) counter-tests on the sources: every sabotage appears exactly once and is caught", () => {
  const stale = [], notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    const n = Q[s.file].split(s.old).length - 1;
    if (n !== 1) { stale.push(`${name} (${n}×)`); continue; }
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(stale, [], "sabotages whose spot is not exactly once");
  assert.deepEqual(notCaught, [], "sabotages no check catches");
  console.log(`  [editor-groups] ${Object.keys(SOURCE_SABOTAGES).length} sabotages on the sources, each caught`);
});

// ── (3) The state of a view and wrapping per file, EXECUTED ─────────────────────────────────────────────────
// lib/view-status.ts and lib/wrap-per-file.ts have no imports — every version (the sabotaged one too) is loaded fresh.
const SOURCES = { source: read("src", "lib", "view-status.ts"), wrap: read("src", "lib", "wrap-per-file.ts") };
const STATUS_CHECKS = {
  state(q) {
    const A = loadTransaction(q.source);
    const st = { selection: [{ anchor: 3, header: 9 }, { anchor: 20, header: 20 }], main: 1, top: 12, margin: 4.5, folds: [[30, 50], [60, 90]] };
    assert.deepEqual(A.stateFrom(JSON.parse(JSON.stringify(st))), st, "a readable state comes back unchanged");
    for (const broken of [null, {}, { ...st, selection: [] }, { ...st, main: 2 }, { ...st, top: -1 }, { ...st, selection: [{ anchor: 1.5, header: 2 }] }, { ...st, margin: "x" }]) {
      assert.equal(A.stateFrom(broken), null, `unreadable is null, never "empty": ${JSON.stringify(broken)}`);
    }
    assert.deepEqual(A.stateFrom({ ...st, folds: [[5, 2], [1, 4], "x"] }).folds, [[1, 4]], "a reversed fold drops on its own");
    // A remembered state applied to a shorter text: clamped, folds beyond the end drop.
    const k = A.matchingFor(st, 55);
    assert.deepEqual([k.selection, k.top, k.folds], [[{ anchor: 3, header: 9 }, { anchor: 20, header: 20 }], 12, [[30, 50]]]);
    assert.deepEqual(A.matchingFor(st, 10).selection, [{ anchor: 3, header: 9 }, { anchor: 10, header: 10 }], "beyond the end falls back to the end");
    assert.equal(A.matchingFor(st, 10).top, 10);
    // Per group, per file; at most CAP per group, the most recently remembered stay; a newly remembered one moves to the back.
    let all = {};
    for (let i = 0; i < A.CAP + 5; i++) all = A.rememberStatus(all, "g1", `d${i}`, st);
    assert.equal(Object.keys(all.g1).length, A.CAP, "the cap per group does not hold");
    assert.ok(!all.g1.d0 && all.g1[`d${A.CAP + 4}`], "the cap drops the newest instead of the oldest");
    all = A.rememberStatus(all, "g1", "d5", { ...st, top: 1 });
    all = A.rememberStatus(all, "g1", "fresh", st);
    assert.equal(all.g1.d5?.top, 1, "a just-remembered state drops out on the next one");
    all = A.rememberStatus(all, "g2", "d1", st);
    assert.deepEqual(Object.keys(A.onlyGroups(all, ["g2"])), ["g2"], "a closed group keeps its states");
    // Storage: version 1, unreadable entries drop individually.
    const text = A.statusesText({ g1: { a: st } });
    assert.deepEqual(A.statusesFrom(text), { g1: { a: st } });
    assert.deepEqual(A.statusesFrom(JSON.stringify({ v: 1, g: { g1: { a: st, b: { selection: "x" } } } })), { g1: { a: st } });
    assert.deepEqual(A.statusesFrom(JSON.stringify({ v: 2, g: { g1: { a: st } } })), {}, "a foreign version yields nothing");
    assert.deepEqual(A.statusesFrom("{broken"), {});
    // Reload clears the keys of vanished copies — only from the READ list, the main instance stays.
    const b = "/api/projects/p1";
    const storeKeys = [`cbase-code-groups:${b}|`, `cbase-code-groups:${b}|k1`, `cbase-code-views:${b}|k2`, `cbase-code-views:${b}|k1`, `cbase-code-groups:/api/projects/p2|k9`, "other"];
    assert.deepEqual(A.orphanedKey(storeKeys, b, new Set(["k1"])), [`cbase-code-views:${b}|k2`], "orphaned keys determined wrongly");
  },
  wrap(q) {
    const U = loadTransaction(q.wrap);
    let reported = 0;
    const off = U.subscribeWrap(() => { reported += 1; });
    assert.equal(U.wrapOf("a", false), false);
    const t0 = U.wrapTick();
    U.toggleWrap("a", false);
    assert.deepEqual([U.wrapOf("a", false), U.wrapOf("b", false), reported], [true, false, 1], "⌥Z does not toggle ONLY the file in front");
    assert.notEqual(U.wrapTick(), t0, "useSyncExternalStore does not see the toggle");
    assert.equal(U.wrapOf("a", true), true, "the override does not apply independently of the setting");
    U.toggleWrap("a", false);
    assert.equal(U.wrapOf("a", true), true, "toggled back: the setting again (VS Code \"inherit\")");
    assert.equal(U.wrapOf(null, true), true, "without a file the setting applies");
    off();
    U.toggleWrap("a", false);
    assert.equal(reported, 2, "an unsubscribed listener keeps listening");
  },
};
const STATUS_SABOTAGES = {
  "state without check of the main selection": { file: "source", old: "if (o.main >= selection.length) return null;", fresh: "", catches: "state" },
  "state not clamped": { file: "source", old: "selection: st.selection.map((r) => ({ anchor: k(r.anchor), header: k(r.header) })),", fresh: "selection: st.selection,", catches: "state" },
  "fold beyond the end": { file: "source", old: "folds: st.folds.filter(([a, b]) => b <= length && a < b),", fresh: "folds: st.folds,", catches: "state" },
  "cap drops the newest": { file: "source", old: "entries.slice(Math.max(0, entries.length - (CAP - 1)))", fresh: "entries.slice(0, CAP - 1)", catches: "state" },
  "version unchecked": { file: "source", old: "o.v !== 1 ||", fresh: "", catches: "state" },
  "main instance orphaned": { file: "source", old: "if (identifier !== \"\" && !copies.has(identifier)) out.push(k);", fresh: "if (!copies.has(identifier)) out.push(k);", catches: "state" },
  "wrapping for all files": { file: "wrap", old: "return OVER.get(key) ?? setting;", fresh: "return OVER.size ? !setting : setting;", catches: "wrap" },
  "wrapping without tick": { file: "wrap", old: "  tick += 1;\n  for (const h", fresh: "  for (const h", catches: "wrap" },
  "override stays": { file: "wrap", old: "if (fresh === setting) OVER.delete(key); else OVER.set(key, fresh);", fresh: "OVER.set(key, fresh);", catches: "wrap" },
  "listener stays": { file: "wrap", old: "return () => { LISTENERS.delete(h); };", fresh: "return () => {};", catches: "wrap" },
};
test("(3) state per view and wrapping per file, executed (with counter-tests)", () => {
  for (const [name, check] of Object.entries(STATUS_CHECKS)) {
    try { check(SOURCES); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  const stale = [], notCaught = [];
  for (const [name, s] of Object.entries(STATUS_SABOTAGES)) {
    const n = SOURCES[s.file].split(s.old).length - 1;
    if (n !== 1) { stale.push(`${name} (${n}×)`); continue; }
    let caught = false;
    try { STATUS_CHECKS[s.catches]({ ...SOURCES, [s.file]: SOURCES[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(stale, [], "sabotages whose spot is not exactly once");
  assert.deepEqual(notCaught, [], "sabotages no check catches");
  console.log(`  [editor-groups] ${Object.keys(STATUS_SABOTAGES).length} sabotages on state and wrapping, each caught`);
});
