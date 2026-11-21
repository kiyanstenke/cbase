// What can stand in a tab of the editor groups — the PURE computation. VS Code calls it "editor input": a
// file, the markdown preview of a file, a diff. Preview and time axis diff used to lie as a view OVER the editor of a group;
// now each is a tab of its own — closable with ✕/⌘W, movable, splittable, remembered across reloads.
//
// THE KEY. A group (lib/editor-groups.ts) holds strings. A file stays its path (a remembered state from before still applies);
// the other two begin with MARKER (U+0001 — in no path the server delivers; not U+0000, `CSS.escape` turns that into
// U+FFFD):
//   ␁preview␁<path>             the preview that follows the active markdown editor (VS Code "dynamic" preview)
//   ␁preview-locked␁<path>    the locked one (VS Code `markdown.preview.toggleLock`, title "[Preview] README.md")
//   ␁diff␁<JSON>                 a diff: `{ q }` with the source in a fixed form (lib/chat-tabs.ts `checkSource` — same source ⇒ same
//                                 key ⇒ the same tab), for a whole commit/stash plus `t` (the subject — the title of the tab)
// `inputOf` reads every key back and checks it (reload: localStorage is foreign text); what does not fit is null and drops out when
// reading (`tidy`) — empty is not unknown: an unreadable tab is no file tab.
//
// VS CODE (1.143, markdown extension and Git):
//   - ⇧⌘V opens the preview as a tab in THE SAME group right of the source, ⌘K V in the group next to it (right, otherwise a new one on the right —
//     VS Code `ViewColumn.Beside`; focus stays in the editor). A preview is pinned (a webview editor is never italic). At most ONE unlocked
//     one per group: a new one takes its place (`openPreview`), and it follows the active markdown editor (`followUpPreviews`); ⇧⌘V on the
//     preview leads back to the source (`toSource`).
//   - Diffs are named like in VS Code: "app.ts (Working Tree)" (index ↔ working tree), "app.ts (Index)" (HEAD ↔ index), "README.md (prev1234) ↔
//     README.md (abcd1234)" (a commit of the time axis, VS Code `git.timeline.openDiff` — the name is that of the file TODAY, also across a
//     rename) — `diffName`, the same computation for the tabs in the chat (chat/ChatTabBar.tsx `tabName`). "Open Changes" on
//     an UNTRACKED file opens the file itself (VS Code `resolveChangeCommand`: without a left side `vscode.open` with the title
//     "{0} (Untracked)") — `changeSource` then says "untracked".
//   - At most ONE unlocked preview per group, after EVERY step (VS Code: if a dynamic preview changes its place or comes to the
//     front, the others of the same column drop — `onDidChangeViewState` → `matches`): splitting, moving and dragging would otherwise bring a
//     second one — `oneDynamicPreview`, called in components/code/editor-groups-connection.ts after every step.
//   - On a rename EVERY input moves along — file, preview and diff (`formKey`; the diff via
//     lib/chat-tabs.ts `renameSource`: title, key, time axis, "open file" name the file today). VS Code 1.143 closes a
//     diff with a file: side there and leaves a git: diff under the old name — here we decide differently. On deleting IN the
//     explorer, file, preview and the diffs without unsaved changes whose side is the file ITSELF fall (the unstaged change, the
//     comparison of two files — `hitsDeleted`, like VS Code `handleDeletedFile` via `getAllNonDirtyEditors`); if the file is gone
//     from outside, only file and preview fall (`hitsFile`; VS Code `closeOnFileDelete` off). Index, commit and time axis diffs keep
//     showing what was.
//   - Comparisons (lib/comparison.ts): "README.md (abcd1234) ↔ README.md (ef567890)" for two time axis entries (VS Code
//     `git.timeline.compareWithSelected`, per side "{0} ({1})" with the short ref), "a.ts ↔ b.ts" for two explorer files (VS Code
//     DiffEditorInput: the two names, the hint the full paths).
//   - The buffer: a file tab and a diff of the unstaged change (right the working tree, editable) show THE SAME buffer
//     (`bufferFile`) — the view holds it as long as one of the two is open (`heldFiles`); only whoever closes the last one is asked.
//
// Guard: web/test/editor-inputs.test.mjs (EXECUTED, each computation with a sabotage its check must catch).
import {
  baseName, diffPath, shortHash, withRoot, checkSource, sourceFalls, renameSource, targetIdentifier, twoRoots,
  type CodeTab, type DiffSource, type EventLocation, type TabTarget, type RootName,
} from "./chat-tabs.js";
import { isMarkdown, previewTitle } from "./md-preview.js";
import { diffTitle, shortRef } from "./timeAxis.js";
import { isMultiFile, sourceLabel, writeFile, targetPath } from "./diff-tab.js";
import * as G from "./editor-groups.js";

type T = (key: string, params?: Record<string, string | number>) => string;

export const MARKER = "\u0001";
const PREVIEW = `${MARKER}preview${MARKER}`;
const LOCKED = `${MARKER}preview-locked${MARKER}`;
const DIFF = `${MARKER}diff${MARKER}`;

export type Input =
  | { kind: "file"; path: string }
  | { kind: "preview"; path: string; locked: boolean }
  | { kind: "diff"; source: DiffSource; title?: string };

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const previewKey = (path: string, locked = false): string => `${locked ? LOCKED : PREVIEW}${path}`;
/** The key of a diff: the source in a fixed form; the subject (`title`) only where it is the name of the tab (whole commit, stash). */
export function diffKey(q: DiffSource, title?: string | null): string {
  const fixed = checkSource(q) ?? q;
  return `${DIFF}${JSON.stringify(isMultiFile(fixed) && title ? { q: fixed, t: title } : { q: fixed })}`;
}
/** A key as input — null if it names nothing valid (a preview of a non-markdown file, a diff in a foreign form). */
export function inputOf(k: unknown): Input | null {
  if (typeof k !== "string" || !k) return null;
  if (!k.startsWith(MARKER)) return { kind: "file", path: k };
  for (const [before, locked] of [[PREVIEW, false], [LOCKED, true]] as const) {
    if (!k.startsWith(before)) continue;
    const path = k.slice(before.length);
    return path && !path.startsWith(MARKER) && isMarkdown(path) ? { kind: "preview", path, locked } : null;
  }
  if (!k.startsWith(DIFF)) return null;
  let o: { q?: unknown; t?: unknown } | null;
  try { o = JSON.parse(k.slice(DIFF.length)); } catch { return null; }
  const source = checkSource(o?.q);
  if (!source) return null;
  const title = typeof o?.t === "string" && o.t ? o.t : undefined;
  if (diffKey(source, title) !== k) return null; // not in the fixed form: no duplicate of the same tab
  return title ? { kind: "diff", source, title } : { kind: "diff", source };
}
export const isFileTab = (k: string): boolean => !k.startsWith(MARKER);
/** The file of a file tab — null for every other input (and for no tab). */
export const fileTab = (k: string | null | undefined): string | null => (k && !k.startsWith(MARKER) ? k : null);
/** The file of a diff (relative to the target: repo + file) — a whole commit, a stash, the history have none. The file TODAY
 *  (`current`, across a rename), otherwise the one in the commit; for the comparison of two files the right one (VS Code: the modified side). */
export function diffFile(q: DiffSource): string | null {
  const d = diffPath(q);
  return d === null ? null : targetPath(q.repo, d);
}
/** The key a tab of the chat (lib/chat-tabs.ts `CodeTab`) would have in the groups — for the computations that read a key
 *  (`timeAxisFile`: in the chat too the time axis shows the file of the diff). */
export function inputFromTab(tab: CodeTab): string {
  if (tab.kind === "file") return tab.path;
  if (tab.kind === "preview") return previewKey(tab.path, Boolean(tab.locked));
  return diffKey(tab.source, tab.title);
}
/** What a tab is about (relative to the target): the file, the source of a preview, the file of a diff. */
export function fileOf(k: string): string | null {
  const e = inputOf(k);
  if (!e) return null;
  return e.kind === "diff" ? diffFile(e.source) : e.path;
}
/** Whose time axis a tab shows (VS Code `TimelinePane`: the resource of the active editor, for a diff the right side — a git: resource
 *  counts like the file with the same path, so the time axis stays when an entry opens its diff): the file of a file tab,
 *  that of a diff; a preview (a webview) and a diff without a single file none — there "The active editor cannot provide …". */
export function timeAxisFile(k: string | null | undefined): string | null {
  const e = k ? inputOf(k) : null;
  if (!e || e.kind === "preview") return null;
  return e.kind === "file" ? e.path : diffFile(e.source);
}
/** Whose buffer a tab shows: a file tab that of its file, a diff of the UNSTAGED change that of the working tree (right, editable —
 *  components/code/DiffTab.tsx); everything else none. */
export function bufferFile(k: string): string | null {
  const e = inputOf(k);
  if (!e || e.kind === "preview") return null;
  if (e.kind === "file") return e.path;
  return writeFile(e.source);
}

/** "Open Changes" (VS Code `git.openChange`, button of the title bar of a changed file) — the source of the diff of the file `path` (relative
 *  to the target) in the repo `repo` (its relPath, "" = the root) with the git state `xy` (index, working tree — `git status --porcelain`) and the kind
 *  `kind` (null: no change). If the working tree carries a change, it is the unstaged one (index ↔ working tree, "(Working Tree)"), otherwise
 *  the staged one (HEAD ↔ index, "(Index)"); without a readable `xy` (an older server) the unstaged one. "untracked": an untracked file has
 *  no left side — VS Code then opens the file itself, title "{0} (Untracked)" (`untrackedTitle`). Null: no change, not in
 *  this repo. */
export function changeSource(path: string, repo: string, xy: string | null, kind: string | null): DiffSource | "untracked" | null {
  if (!kind || !path || path.startsWith(MARKER)) return null;
  if (repo && path !== repo && !path.startsWith(`${repo}/`)) return null;
  const file = repo ? path.slice(repo.length + 1) : path;
  if (!file) return null;
  if (kind === "untracked" || xy === "??") return "untracked";
  const x = xy && xy.length === 2 ? xy[0] : null, y = xy && xy.length === 2 ? xy[1] : null;
  if (x === " " && y === " ") return null;
  return { kind: "change", repo, file, staged: y === " " };
}
/** The title of an untracked file opened via "Open Changes" (VS Code "{0} (Untracked)"). */
export const untrackedTitle = (path: string, t: T): string => t("{name} (Untracked)", { name: baseName(path) });

// ── Sets over all groups ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** The open file TABS, each once, in the order of the groups. */
export const openFiles = (s: G.GroupsStatus): string[] => G.allOpen(s).filter(isFileTab);
/** The files whose buffer the view holds (file tabs and diffs of the unstaged change), each once. */
export function heldFiles(s: G.GroupsStatus): string[] {
  const out: string[] = [];
  for (const k of G.allOpen(s)) { const d = bufferFile(k); if (d !== null && !out.includes(d)) out.push(d); }
  return out;
}
/** Besides the tab `key` of group `gid`, does another tab (in any group) hold the same buffer? Then closing does not ask. */
export function otherHolds(s: G.GroupsStatus, gid: string, key: string): boolean {
  const d = bufferFile(key);
  return d !== null && s.groups.some((g) => g.paths.some((k) => !(g.id === gid && k === key) && bufferFile(k) === d));
}
/** Renamed/moved: file tabs, previews and diffs move along (`form` gives the new path; a diff via
 *  `renameSource`). A diff that FALLS in the process (its file leaves its repo) stays here — `followRename` closes it. */
export function formKey(form: (path: string) => string, location: EventLocation, onlyCompare = false): (k: string) => string {
  return (k) => {
    const e = inputOf(k);
    if (!e || (onlyCompare && !isComparison(e))) return k;
    if (e.kind === "diff") { const q = renameSource(e.source, form, location); return q === null || q === e.source ? k : diffKey(q, e.title); }
    return e.kind === "file" ? form(k) : previewKey(form(e.path), e.locked);
  };
}
/** A comparison of two files — the only tab whose sides can come from another area of the window. */
const isComparison = (e: Input): boolean => e.kind === "diff" && e.source.kind === "files";
/** Renaming over all groups: what falls closes like a close, everything else moves along (`formKey`).
 *  `location`: the target of this area, in whose paths `form` computes, with the mapping for the sides of a comparison from another
 *  target; `onlyCompare`: a rename in ANOTHER area of the window — then only the comparisons of two files move along.
 *  `unsaved`: a diff that would fall but carries unsaved changes stays as it is — as on deleting
 *  (`hitsDeleted`, VS Code `getAllNonDirtyEditors`). */
export function followRename(s: G.GroupsStatus, form: (path: string) => string, location: EventLocation, onlyCompare = false, unsaved: (k: string) => boolean = () => false): G.GroupsStatus {
  const falls = (k: string) => { const e = inputOf(k); return e?.kind === "diff" && (!onlyCompare || isComparison(e)) && renameSource(e.source, form, location) === null && !unsaved(k); };
  return G.formPaths(G.remove(s, falls), formKey(form, location, onlyCompare));
}
/** The file is gone without cbase having deleted it (not there any more when restoring after a reload, "Reload" on a file deleted from
 *  outside): only the file tab and preview of the file fall — a diff stays, as in VS Code (`workbench.editor.closeOnFileDelete`
 *  is off). */
export function hitsFile(hits: (path: string) => boolean): (k: string) => boolean {
  return (k) => { const e = inputOf(k); return e !== null && e.kind !== "diff" && hits(e.path); };
}
/** Deleted in cbase (the explorer): file tab and preview fall, also a diff with the file as a side (lib/chat-tabs.ts
 *  `sourceFalls`: the unstaged change, the comparison of two files) — unless it carries unsaved changes (`unsaved`, the key
 *  of the tab): VS Code `handleDeletedFile` goes only via `getAllNonDirtyEditors`. A diff in Git stays (it shows what was). */
export function hitsDeleted(hits: (path: string) => boolean, unsaved: (k: string) => boolean, location: EventLocation, onlyCompare = false): (k: string) => boolean {
  return (k) => {
    const e = inputOf(k);
    if (e === null || (onlyCompare && !isComparison(e))) return false;
    return e.kind === "diff" ? sourceFalls(e.source, hits, location) && !unsaved(k) : hits(e.path);
  };
}
/** Reload: what is no valid tab drops (like a close — a group made empty by it too). Whether the file of a tab is still there is said
 *  only by the reading (components/code/editor-groups-connection.ts `restored`: a file tab AND a preview drop if their file is missing). */
export const tidy = (s: G.GroupsStatus): G.GroupsStatus => oneDynamicPreview(G.remove(s, (k) => inputOf(k) === null));
/** A remembered comparison of two files in the form from before targets existed (without targets) as a key of today: both sides
 *  in the target of the groups (`target`, both lay there then — lib/chat-tabs.ts `checkSource` with the old form). Every other key stays as it
 *  is. Called BEFORE `tidy`, otherwise it would fall as "no input". */
export function migrateComparison(k: string, target: TabTarget): string {
  if (!k.startsWith(DIFF) || inputOf(k) !== null) return k;
  let o: { q?: unknown } | null;
  try { o = JSON.parse(k.slice(DIFF.length)); } catch { return k; }
  const q = checkSource(o?.q, target);
  return q?.kind === "files" ? diffKey(q) : k;
}
/** The same over all groups (active and preview move along, lib/editor-groups.ts `formPaths`). */
export const migrateCompare = (s: G.GroupsStatus, target: TabTarget): G.GroupsStatus => G.formPaths(s, (k) => migrateComparison(k, target));
/** The tabs whose file must first be read when restoring (file tabs and previews; a diff shows a source in Git). */
export const toRestore = (s: G.GroupsStatus): string[] => G.allOpen(s).filter((k) => { const e = inputOf(k); return e !== null && e.kind !== "diff"; });

// ── Titles ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What a diff is called — ONE computation for the groups and the tabs in the chat. `short` = the short hash as the source knows it. */
export function diffName(q: DiffSource, t: T, o: { title?: string; short?: string } = {}): string {
  switch (q.kind) {
    case "change": { const name = baseName(q.current ?? q.file); return q.staged ? t("{name} (Index)", { name }) : t("{name} (Working Tree)", { name }); }
    case "commit": return diffTitle(q.current ?? q.file, q.hash, q.prior);
    // VS Code `git.timeline.compareWithSelected`: per side "{0} ({1})" (the name of the file today, the short ref), joined with " ↔ ".
    case "comparison": { const n = baseName(q.current ?? q.right.file); return `${n} (${shortRef(q.left.hash)}) ↔ ${n} (${shortRef(q.right.hash)})`; }
    // VS Code DiffEditorInput: "{0} ↔ {1}" from the two names.
    case "files": return `${baseName(q.left)} ↔ ${baseName(q.right)}`;
    case "stash": return o.title || q.ref;
    default: return o.title || t("Commit {hash}", { hash: o.short || shortHash(q.hash) });
  }
}
/** Name and hint (on hover) of a tab: the name as above, the hint the path — for a diff plus the side (like the title row in the chat). */
export function tabTitle(k: string, t: T, root: RootName = targetIdentifier): { name: string; hint: string } {
  const e = inputOf(k);
  if (!e) return { name: k, hint: k };
  if (e.kind === "file") return { name: baseName(e.path), hint: e.path };
  if (e.kind === "preview") { const v = previewTitle(e.path, e.locked); return { name: t(v.key, v.values), hint: e.path }; }
  const et = sourceLabel(e.source, undefined, root);
  const name = diffName(e.source, t, { title: e.title });
  // The comparison of two files like VS Code (the long title of the diff: both paths, " ↔ ") — from two targets each with its root.
  if (e.source.kind === "files") {
    const q = e.source, two = twoRoots(q);
    const page = (z: TabTarget, p: string) => (two ? withRoot(root(z), p) : p);
    return { name, hint: `${page(q.leftTarget, q.left)} ↔ ${page(q.rightTarget, q.right)}` };
  }
  return { name, hint: [diffFile(e.source) ?? name, t(et.key, et.values)].join(" · ") };
}

// ── Markdown preview ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The unlocked preview of a group (at most one) — null: none. */
export const followingPreview = (g: { paths: readonly string[] } | null | undefined): string | null => g?.paths.find((k) => k.startsWith(PREVIEW)) ?? null;
/** At most ONE unlocked preview per group (VS Code `onDidChangeViewState` → the others of the same column drop): the one in front
 *  stays (it just moved), otherwise the most recently used, otherwise the first. Unchanged: the same state (no new object). */
export function oneDynamicPreview(s: G.GroupsStatus): G.GroupsStatus {
  let r = s;
  for (const g of s.groups) {
    const dyn = g.paths.filter((k) => k.startsWith(PREVIEW));
    if (dyn.length < 2) continue;
    const stays = g.active !== null && dyn.includes(g.active) ? g.active : g.last?.find((k) => dyn.includes(k)) ?? dyn[0];
    for (const k of dyn) if (k !== stays) r = G.close(r, g.id, k);
  }
  return r;
}

/** ⇧⌘V (`beside` false) and ⌘K V (`beside` true) on the markdown file `path` of group `gid`. In the target group the preview takes the
 *  unlocked one that already stands there (in its place), otherwise it comes pinned right of the active tab; beside, `gid` stays active. */
export function openPreview(s: G.GroupsStatus, gid: string, path: string, o: { beside?: boolean } = {}): G.GroupsStatus {
  if (!isMarkdown(path) || path.startsWith(MARKER) || !G.groupOf(s, gid)) return s;
  const key = previewKey(path);
  let r = s, target = gid;
  if (o.beside) {
    // VS Code `ViewColumn.Beside` → SIDE_GROUP: the group on the RIGHT, otherwise a NEW, empty one on the right — the
    // source does not open there.
    const n = G.neighbor(s, gid, "right");
    if (n) target = n.id;
    else {
      const fresh = G.createGroup(s, gid, "right");
      if (!fresh) return s;
      r = fresh.status;
      target = fresh.fresh;
    }
  }
  const dyn = followingPreview(G.groupOf(r, target));
  if (dyn && dyn !== key) r = G.replaceIn(r, target, dyn, key);
  r = G.open(r, key, { fixed: true, group: target });
  return o.beside ? G.activateGroup(r, gid) : r;
}
/** The unlocked previews follow the markdown file `path` that is currently in front (in every group; a locked one stays). */
export function followUpPreviews(s: G.GroupsStatus, path: string | null): G.GroupsStatus {
  if (!path || path.startsWith(MARKER) || !isMarkdown(path)) return s;
  const key = previewKey(path);
  let r = s;
  for (const g of s.groups) { const dyn = followingPreview(g); if (dyn && dyn !== key) r = G.replaceIn(r, g.id, dyn, key); }
  return r;
}
/** "Toggle Preview Lock" for the preview `key` of group `gid`; unlocked, a second unlocked one of the same group drops. */
export function toggleLock(s: G.GroupsStatus, gid: string, key: string): G.GroupsStatus {
  const e = inputOf(key);
  if (e?.kind !== "preview") return s;
  const fresh = previewKey(e.path, !e.locked);
  let r = G.replaceIn(s, gid, key, fresh);
  if (e.locked) for (const k of G.groupOf(r, gid)?.paths ?? []) if (k !== fresh && k.startsWith(PREVIEW)) r = G.close(r, gid, k);
  return r;
}
/** "Open as Preview" (VS Code `markdown.reopenAsPreview`) on the markdown file `path` of group `gid`: in its place the LOCKED
 *  preview (VS Code opens the static preview there, which follows no other file — cbase knows no third kind). `keep`: the file
 *  carries unsaved changes that no other tab holds — it stays, and the preview comes pinned right of it (nothing is lost). */
export function asPreview(s: G.GroupsStatus, gid: string, path: string, keep: boolean): G.GroupsStatus {
  const g = G.groupOf(s, gid);
  if (!g || !g.paths.includes(path) || !isMarkdown(path)) return s;
  const k = previewKey(path, true);
  return keep ? G.open(s, k, { fixed: true, group: gid }) : G.replaceIn(s, gid, path, k);
}
/** ⇧⌘V on the preview (VS Code `markdown.togglePreview`): back to the source — if it stands in the group, the preview closes and the source
 *  comes to the front; otherwise the source takes the place of the preview. */
export function toSource(s: G.GroupsStatus, gid: string, key: string): G.GroupsStatus {
  const e = inputOf(key), g = G.groupOf(s, gid);
  if (e?.kind !== "preview" || !g || !g.paths.includes(key)) return s;
  if (g.paths.includes(e.path)) return G.activateTab(G.close(s, gid, key), gid, e.path);
  return G.replaceIn(s, gid, key, e.path);
}
