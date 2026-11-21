// The tab bar of the Coding chat. Like VS Code: `[Chat]` fixed on the left, next to it every open file and every diff as its own tab; a
// click opens a preview tab (italic) that the next click replaces; typing, double-click in the tree or on the tab makes it fixed. The
// list belongs to the chat and survives a reload (localStorage `cbase-chat-tabs:<chatId>`).
//
// This is the ONE computation for it: pure, no React, no import (web/test/chat-tabs.test.mjs compiles this module alone with tsc and runs
// it). The hook components/chat/chatTabs.ts holds the state and writes it; the bar (chat/ChatTabBar.tsx) and the code area
// (chat/ChatCodeArea.tsx → CodePane, controlled) show it. There is no second tab list in the chat: CodePane gets its file tabs from here.
//
// Terms:
//   - A tab carries its TARGET: `{ apiBase, instance }`: `apiBase` the route (`/api/projects/<id>` or `/api/workspaces/<id>`),
//     `instance` the identifier of a copy (`<projectId>/copy-<name>`, the value for `?instance=`, lib/code-instance.ts `instancePath`)
//     or null for main. The same form as code page and git bar. An instance switch in the chat header changes no open tab.
//   - A tab's key (`key`) is its equality: the same key = the same tab (opening only makes it active). Display fields (`title`,
//     `short`) do not belong to it.
//   - The VIEWS (a tab in the main area instead of a folder button: a small menu opens Explorer/Browser/Terminal): `FILES` (explorer:
//     the code area without a file: tree on the left, empty editor), `TERMINAL` and `BROWSER` (the chat's terminal and browser, the
//     same as in the right bar). An open view stands as a tab right after the chat (`views`, opening order), before the code tabs; it
//     carries no target and no draft. Its key is its name; no code-tab key starts like that (`file:`/`diff:`).
//   - The diff sources have the forms of today's calls: `change` = GitSidebar `openFileDiff(repo, file, staged)` (POST /git/diff
//     `{repo, file, staged}`), `commit` = GitGraph `openFile` (POST /git/show `{repo, hash, file, old?}`), `commit-whole` = GitGraph
//     `openWhole` (POST /git/show `{repo, hash}`), `stash` = the stash entry (POST /git/stash/show `{repo, ref}`; `ref` like
//     “stash@{0}”, not the index: that is how the bar calls it), `history` = HistoryModal `onShow` (POST /git/show `{repo, hash}`).
//     Plus the two COMPARISONS (lib/comparison.ts): `comparison` = “Compare with selected” of the timeline (twice POST /git/show
//     `{repo, hash, file, content}`, per side the file in its commit) and `files` = “Compare with selected file”/“Compare selected” of
//     the explorer (twice files/read; `repo` stays "": the paths are relative to the target, like a file in the repo at the root).
//   - A diff MOVES ALONG when its file is renamed or moved (`renameSource`): `current` names the file today (title, key, timeline, “open
//     file”, the right side's buffer), the content still comes from the source. On deletion a diff falls whose side is the file ITSELF
//     (the unstaged change, the comparison of two files; `sourceFalls`); what stands in Git (index, commit, timeline comparison)
//     stays, like VS Code (`handleDeletedFile` only closes editors with a file: side).
//
// The interface for opening from outside (diffs from the git bar and files from Edit/Write rows open tabs): a window event like the
// jump “agent in chat” (lib/agent-jump.ts): `openDiffTab(chatId, source, target, …)` and `openFileTab(chatId, path, …)` send
// `cbase-chat-tab`, the open chat's hook hears it (`chatTabJumpFrom` checks the detail) and opens the tab. An event for a chat other
// than the open one lapses silently.

export const CHAT = "chat";
export const FILES = "files";
export const TERMINAL = "terminal";
export const BROWSER = "browser";
/** The views without a file, in the order of the ⋯ menu. */
export const VIEWS = [FILES, BROWSER, TERMINAL] as const;
export type View = (typeof VIEWS)[number];
export const isView = (k: unknown): k is View => typeof k === "string" && (VIEWS as readonly string[]).includes(k);

export type TabTarget = { apiBase: string; instance: string | null };

export type DiffSource =
  // `current` = the file TODAY (relative to the repo) if it was renamed since opening: the left side still comes from the index of
  // `file`, the right (unstaged: the working tree, the buffer) from `current`; staging hunks then no longer works (git sees a deletion
  // and a new file).
  | { kind: "change"; repo: string; file: string; staged: boolean; current?: string }
  // `current` = the file TODAY (relative to the repo) if it had a different name in the commit: title, timeline and “open file” mean
  // it, the content comes from `file`/`old`; `prior` = the predecessor in the timeline (VS Code `previousRef`, lib/timeAxis.ts); it
  // stands in the title and, as in VS Code (the left side is `<file>@<prior>`), belongs to the equality.
  | { kind: "commit"; repo: string; hash: string; file: string; old?: string | null; current?: string; prior?: string }
  | { kind: "commit-whole"; repo: string; hash: string }
  | { kind: "stash"; repo: string; ref: string }
  | { kind: "history"; repo: string; hash: string }
  // Two timeline entries of the same file (VS Code `git.timeline.compareWithSelected`): per side the commit and the file's name IN it
  // (across a rename), `current` = the file today if it is named differently than on the right.
  | { kind: "comparison"; repo: string; left: SideStatus; right: SideStatus; current?: string }
  // Two files (VS Code `compareFiles`/`compareSelected` of the explorer): the selected one on the left, the clicked one on the right,
  // editable on the right as in VS Code's diff editor. `repo` is always "" (the paths are relative to their target). EACH side carries
  // its target (`leftTarget`, `rightTarget`): the choice applies in the whole window like VS Code `resourceSelectedForCompare`, so the
  // left side can come from another project, another level or a copy. Each side is read from ITS target, the editable right one holds
  // the buffer of ITS target; on the right is the clicked file, i.e. the target of the area the tab opens in. A stored source from
  // before (without the targets) migrates losslessly when read (`checkSource` with `beforeW`): both sides then lay in the target of
  // their tab or editor group; its draft moves under the new key (`comparisonMigration`, `migrateDrafts`).
  | { kind: "files"; repo: ""; left: string; right: string; leftTarget: TabTarget; rightTarget: TabTarget };
/** One side of a timeline comparison: the commit and the path of the file in it (relative to the repo). */
export type SideStatus = { hash: string; file: string };

export type TabChat = { kind: "chat" };
export type TabFile = { kind: "file"; target: TabTarget; path: string };
/** `title` (subject of a commit, name of a stash) and `short` (short hash) are display only. */
export type TabDiff = { kind: "diff"; target: TabTarget; source: DiffSource; title?: string; short?: string };
/** The markdown preview of a file as its own tab (⇧⌘V): “Preview README.md”, locked “[Preview] README.md”. An UNLOCKED one follows the
 *  markdown file that is in front (`followUpPreview`; VS Code: a dynamic preview follows the active markdown editor); at most one of
 *  them per target (`openPreview` takes it again). */
export type TabPreview = { kind: "preview"; target: TabTarget; path: string; locked?: boolean };
export type CodeTab = TabFile | TabDiff | TabPreview;
export type ChatTab = TabChat | CodeTab;

/** The state of a chat's bar: the code tabs in bar order (the chat tab always stands in front and not in the list), the active key
 *  (`CHAT`, an open view or a tab's), the preview tab (at most one), the open views (explorer, terminal, browser, each at most once,
 *  in opening order) and `last`: the keys, most recently used first (VS Code `mru`); if the active tab closes, the most recently used
 *  comes to the front (`workbench.editor.focusRecentEditorAfterClose`). If `last` is missing (an older state), the empty trace
 *  applies: then the neighbor. */
export type TabState = { tabs: CodeTab[]; active: string; preview: string | null; views: View[]; last?: string[] };

export const emptyState = (): TabState => ({ tabs: [], active: CHAT, preview: null, views: [] });

// ── Target ────────────────────────────────────────────────────────────────────────────────────

/** Same target = same route and same instance (null and missing are the same: main). */
export function targetEqual(a: TabTarget, b: TabTarget): boolean {
  return a.apiBase === b.apiBase && (a.instance ?? null) === (b.instance ?? null);
}
export const targetKey = (z: TabTarget): string => JSON.stringify([z.apiBase, z.instance ?? ""]);

/**
 * The chat's target: its project in its instance (`instance` = the name as chat/chatInstance.ts `activeInstance` carries it: “main” or
 * “copy-k1”), without a project the workspace root.
 */
export function chatTarget(e: { workspaceId: string; projectId: string | null | undefined; instance: string | null | undefined }): TabTarget {
  if (!e.projectId) return { apiBase: `/api/workspaces/${e.workspaceId}`, instance: null };
  const name = typeof e.instance === "string" ? e.instance.trim() : "";
  return { apiBase: `/api/projects/${e.projectId}`, instance: name && name !== "main" ? `${e.projectId}/${name}` : null };
}

/** The project of a route; null for the workspace level. */
export function projectIdOf(z: TabTarget): string | null {
  return /^\/api\/projects\/([^/?#]+)$/.exec(z.apiBase)?.[1] ?? null;
}

/** The name of a target's copy (“k1” from `<p>/copy-k1`); null for main. */
export function copyOf(z: TabTarget): string | null {
  const m = /\/copy-([^/]+)$/.exec(z.instance ?? "");
  return m ? m[1] : null;
}

// ── The roots of a comparison ────────────────────────────────────────────────────────────────────────────────────────────────
/** What a root (a target) is called. The window knows the name (lib/buffer-coordinates.ts `rootName`, from `/api/workspaces`). */
export type RootName = (z: TabTarget) => string;
/** Without a name giver: the identifier from the route, a copy with its name in brackets. */
export const targetIdentifier: RootName = (z) => {
  const id = z.apiBase.split("/").filter(Boolean).pop() ?? z.apiBase, k = copyOf(z);
  return k ? `${id} (${k})` : id;
};
/** A path together with its root, like VS Code in a window with several roots (labelService `getUriLabel(…, { relative: true })`):
 *  “{root} • {path}”, without a path the root alone. */
export const withRoot = (name: string, rel: string): string => (rel ? `${name} • ${rel}` : name);
/** Do the sides of a two-file comparison lie in different targets? Only then does each side name its root; a comparison in ONE target
 *  is named as before (an area has one root; the multi-root window only arises through the second side). */
export const twoRoots = (q: DiffSource): boolean => q.kind === "files" && !targetEqual(q.leftTarget, q.rightTarget);

// ── Validation per row (localStorage is foreign text) ────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const text = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);
const ROUTE = /^\/api\/(projects|workspaces)\/[^/?#\s]+$/;

/** A relative path in the target: not empty, no leading slash, no “..” and no empty segment. */
export function pathValid(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.startsWith("/") || p.includes("\\") || p.includes("\u0000")) return false;
  return p.split("/").every((g) => g !== "" && g !== "." && g !== "..");
}

function checkTarget(x: unknown): TabTarget | null {
  if (!isObj(x)) return null;
  const apiBase = text(x.apiBase);
  if (!apiBase || !ROUTE.test(apiBase)) return null;
  // Empty is not unknown: the instance stands explicitly (null = main); a missing one is no statement, the row falls.
  if (x.instance === null) return { apiBase, instance: null };
  const instance = text(x.instance);
  if (!instance || !/^[^/\s]+\/[^/\s]+$/.test(instance)) return null;
  // A copy belongs to its route's project.
  const pid = /^\/api\/projects\/([^/?#]+)$/.exec(apiBase)?.[1];
  if (!pid || !instance.startsWith(`${pid}/`)) return null;
  return { apiBase, instance };
}

/** A diff source from foreign text (localStorage, a remembered key of the editor groups, lib/editor-inputs.ts): in fixed form (fields
 *  always in the same order: same source ⇒ same text) or null. `beforeW`: the target of the tab or editor group the row comes from;
 *  a two-file comparison from before the per-side targets (WITHOUT both targets) gets it for both sides, since both lay there then;
 *  without `beforeW` it falls (a key without a location would not know where its sides lie). */
export function checkSource(x: unknown, beforeW?: TabTarget): DiffSource | null {
  if (!isObj(x) || typeof x.repo !== "string") return null;
  const repo = x.repo; // "" = the repo at the root
  // `current`: missing or a valid path; the same as `file` is dropped (fixed form: same source ⇒ same text).
  const currentOf = (equal: string): string | null | false => (x.current === undefined ? null : !pathValid(x.current) ? false : x.current === equal ? null : x.current);
  switch (x.kind) {
    case "change": {
      const file = text(x.file);
      if (!file || typeof x.staged !== "boolean") return null;
      const current = currentOf(file);
      return current === false ? null : { kind: "change", repo, file, staged: x.staged, ...(current ? { current } : {}) };
    }
    case "comparison": {
      const left = sideStatus(x.left), right = sideStatus(x.right);
      if (!left || !right) return null;
      const current = currentOf(right.file);
      return current === false ? null : { kind: "comparison", repo, left, right, ...(current ? { current } : {}) };
    }
    case "files": {
      // Per side its target, explicitly. If BOTH are missing (stored before the per-side targets), the tab's target applies to both
      // sides; if only one is missing, the row is broken (empty is not unknown) and falls.
      const prior = x.leftTarget === undefined && x.rightTarget === undefined && beforeW ? checkTarget(beforeW) : null;
      const leftTarget = prior ?? checkTarget(x.leftTarget), rightTarget = prior ?? checkTarget(x.rightTarget);
      return repo === "" && pathValid(x.left) && pathValid(x.right) && leftTarget && rightTarget
        ? { kind: "files", repo: "", left: x.left, right: x.right, leftTarget, rightTarget } : null;
    }
    case "commit": {
      const hash = text(x.hash); const file = text(x.file);
      if (!hash || !file) return null;
      if (x.old !== undefined && x.old !== null && !text(x.old)) return null;
      if (x.current !== undefined && !text(x.current)) return null;
      if (x.prior !== undefined && !(typeof x.prior === "string" && /^[0-9a-f]{7,64}\^?$/.test(x.prior))) return null;
      const current = text(x.current) && x.current !== file ? x.current as string : null; // the same file: without `current` (fixed form)
      return { kind: "commit", repo, hash, file, ...(text(x.old) ? { old: x.old as string } : {}), ...(current ? { current } : {}), ...(x.prior ? { prior: x.prior as string } : {}) };
    }
    case "commit-whole":
    case "history": {
      const hash = text(x.hash);
      return hash ? { kind: x.kind, repo, hash } : null;
    }
    case "stash": {
      const ref = text(x.ref);
      return ref ? { kind: "stash", repo, ref } : null;
    }
    default:
      return null;
  }
}

function sideStatus(x: unknown): SideStatus | null {
  if (!isObj(x) || typeof x.hash !== "string" || !/^[0-9a-f]{7,64}$/.test(x.hash)) return null;
  const file = text(x.file);
  return file ? { hash: x.hash, file } : null;
}

/** A stored row as a tab, or null. The chat tab is never stored. */
export function checkTab(x: unknown): CodeTab | null {
  if (!isObj(x)) return null;
  const target = checkTarget(x.target);
  if (!target) return null;
  if (x.kind === "file") return pathValid(x.path) ? { kind: "file", target, path: x.path } : null;
  if (x.kind === "preview") return pathValid(x.path) ? { kind: "preview", target, path: x.path, ...(x.locked === true ? { locked: true } : {}) } : null;
  if (x.kind === "diff") {
    const source = checkSource(x.source, target); // a comparison from before the per-side targets lay entirely in its tab's target
    if (!source) return null;
    return { kind: "diff", target, source, ...(text(x.title) ? { title: x.title as string } : {}), ...(text(x.short) ? { short: x.short as string } : {}) };
  }
  return null;
}

// ── Key ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The equality of a diff source: its kind and the fields the route asks with, no display. ONE computation for a diff tab's key (`key`)
 * and for the equality of two sources (`sourceKey`; the diff module lib/diff-tab.ts has none of its own): same source in the same
 * target ⇒ the same tab.
 */
export function sourceParts(q: DiffSource): (string | number)[] {
  switch (q.kind) {
    case "change": return [q.kind, q.repo, q.file, q.staged ? 1 : 0, ...(q.current ? [q.current] : [])];
    // `current`/`prior` only if present: an older source keeps its key (a remembered tab stays the same).
    case "commit": return [q.kind, q.repo, q.hash, q.file, q.old ?? "", ...(q.current || q.prior ? [q.current ?? "", q.prior ?? ""] : [])];
    case "stash": return [q.kind, q.repo, q.ref];
    case "comparison": return [q.kind, q.repo, q.left.hash, q.left.file, q.right.hash, q.right.file, ...(q.current ? [q.current] : [])];
    case "files": return [q.kind, q.left, q.right, q.leftTarget.apiBase, q.leftTarget.instance ?? "", q.rightTarget.apiBase, q.rightTarget.instance ?? ""];
    default: return [q.kind, q.repo, q.hash];
  }
}
export const sourceKey = (q: DiffSource): string => JSON.stringify(sourceParts(q));

/** A tab's equality: kind, target and source, no display fields. */
export function key(tab: ChatTab): string {
  if (tab.kind === "chat") return CHAT;
  const z = [tab.target.apiBase, tab.target.instance ?? ""];
  if (tab.kind === "file") return `file:${JSON.stringify([...z, tab.path])}`;
  if (tab.kind === "preview") return `preview:${JSON.stringify([...z, tab.path, tab.locked ? 1 : 0])}`;
  return `diff:${JSON.stringify([...z, ...sourceParts(tab.source)])}`;
}

export const fileKey = (target: TabTarget, path: string): string => key({ kind: "file", target, path });

/** The tab for a key; null for `CHAT`, a view and unknown ones. */
export function tabOf(state: TabState, keyName: string): CodeTab | null {
  return state.tabs.find((t) => key(t) === keyName) ?? null;
}

// ── The actions ───────────────────────────────────────────────────────────────────────────────

/** The active key comes to the front of the trace `last` (VS Code `mru`); what is no longer in the row drops out. If it is already in
 *  front: the same state. */
function used(s: TabState): TabState {
  const old = s.last ?? [];
  if (old[0] === s.active) return s;
  const present = new Set(queue(s));
  return { ...s, last: [s.active, ...old.filter((k) => k !== s.active && present.has(k))] };
}
/** A new tab comes right of the active one (VS Code `workbench.editor.openPositioning: right`); if the chat or a view is in front,
 *  before the first code tab. */
function rightFromActive(state: TabState, tab: CodeTab): CodeTab[] {
  const i = state.tabs.findIndex((t) => key(t) === state.active) + 1;
  return [...state.tabs.slice(0, i), tab, ...state.tabs.slice(i)];
}

/**
 * Open a tab, like VS Code. Already open ⇒ only active (and with `fixed` fixed). Otherwise: `fixed` puts it right next to the active
 * one; without `fixed` it replaces the preview tab IN ITS PLACE and is the preview itself; if there is none, it goes right next to
 * the active one. A preview tab never carries unsaved text: unsaved text makes it fixed, wherever it comes from (typing, rename, peek,
 * diff, another editor; the hook calls `keep`), and `unsaved(key)` says here whether it carries it NOW: then it is NEVER replaced
 * (replacing would let go of the buffer with `dismiss`), the new one is appended. `background` (rename/peek changed a file without a
 * tab): fixed right next to the active one, WITHOUT coming to the front; an open tab stays as it is.
 */
export function open(state: TabState, tab: CodeTab, opt: { fixed?: boolean; background?: boolean; unsaved?: (keyName: string) => boolean } = {}): TabState {
  const k = key(tab);
  const i = state.tabs.findIndex((t) => key(t) === k);
  if (opt.background) return i >= 0 ? state : { ...state, tabs: rightFromActive(state, tab) };
  if (i >= 0) {
    // A new title (the subject arrived later) replaces the old one; the equality stays the same.
    const tabs = tab.kind === "diff" && (tab.title || tab.short) ? state.tabs.map((t, j) => (j === i ? tab : t)) : state.tabs;
    return used({ ...state, tabs, active: k, preview: opt.fixed && state.preview === k ? null : state.preview });
  }
  if (!opt.fixed && state.preview && !opt.unsaved?.(state.preview)) {
    const v = state.tabs.findIndex((t) => key(t) === state.preview);
    if (v >= 0) return used({ ...state, tabs: state.tabs.map((t, j) => (j === v ? tab : t)), active: k, preview: k });
  }
  const preview = opt.fixed ? (state.preview && state.tabs.some((t) => key(t) === state.preview) ? state.preview : null) : k;
  return used({ ...state, tabs: rightFromActive(state, tab), active: k, preview });
}

/** ⇧⌘V: the preview of `path` as its own tab, FIXED (a webview preview is never italic in VS Code) right next to the active one. If
 *  the target already has an unlocked preview, THAT one is taken (in its place; VS Code keeps at most one dynamic one per column). */
export function openPreview(state: TabState, target: TabTarget, path: string): TabState {
  const tab: TabPreview = { kind: "preview", target, path };
  const k = key(tab);
  const dyn = state.tabs.find((t) => t.kind === "preview" && !t.locked && targetEqual(t.target, target));
  if (dyn && key(dyn) !== k) return open(replaceTab(state, key(dyn), tab), tab, { fixed: true });
  return open(state, tab, { fixed: true });
}
/** An unlocked preview of the target follows the markdown file `path` that is in front (the caller checks “markdown”; this module
 *  stays without imports). Locked ones stay where they are. */
export function followUpPreview(state: TabState, target: TabTarget, path: string): TabState {
  const dyn = state.tabs.find((t) => t.kind === "preview" && !t.locked && targetEqual(t.target, target));
  if (!dyn || dyn.kind !== "preview" || dyn.path === path || !pathValid(path)) return state;
  return replaceTab(state, key(dyn), { kind: "preview", target, path });
}
/** “Toggle preview lock” (VS Code `markdown.preview.toggleLock`) for the preview tab `key`. */
export function toggleLock(state: TabState, keyName: string): TabState {
  const t = tabOf(state, keyName);
  if (!t || t.kind !== "preview") return state;
  const fresh: TabPreview = { kind: "preview", target: t.target, path: t.path, ...(t.locked ? {} : { locked: true }) };
  let s = replaceTab(state, keyName, fresh);
  // Unlocked: a second unlocked preview of the same target falls (at most one follows).
  if (t.locked) for (const x of s.tabs) if (x.kind === "preview" && !x.locked && targetEqual(x.target, t.target) && key(x) !== key(fresh)) s = close(s, key(x));
  return s;
}
/** “Reopen as preview” (VS Code `markdown.reopenAsPreview`) on the file tab `key`: in its place the LOCKED preview (as in the groups,
 *  lib/editor-inputs.ts `asPreview`); `keep` (unsaved text): the file tab stays, the preview comes fixed next to it. The caller checks
 *  “markdown” (this module stays without imports). */
export function asPreview(state: TabState, keyName: string, keep: boolean): TabState {
  const t = tabOf(state, keyName);
  if (!t || t.kind !== "file") return state;
  const fresh: TabPreview = { kind: "preview", target: t.target, path: t.path, locked: true };
  if (keep) return open(state, fresh, { fixed: true });
  const s = replaceTab(state, keyName, fresh), k = key(fresh);
  return used({ ...s, active: k, preview: s.preview === k ? null : s.preview });
}
/** A link in the preview `key` to the markdown file `path` (VS Code `openPreviewLinkToMarkdownFile` → `this.update`): THIS preview
 *  shows it, locked or not, in its place, as in the editor groups (lib/editor-inputs.ts via `replaceIn`). */
export function switchPreview(state: TabState, keyName: string, path: string): TabState {
  const t = tabOf(state, keyName);
  if (!t || t.kind !== "preview" || !pathValid(path)) return state;
  const fresh: TabPreview = { kind: "preview", target: t.target, path, ...(t.locked ? { locked: true } : {}) };
  return used(replaceTab(state, keyName, fresh));
}
/** ⇧⌘V on the preview `key` and “Open source file” (VS Code `markdown.showSource`): back to the source. If its file tab is in the
 *  bar, the preview closes and it comes to the front; otherwise the file tab takes the preview's place (fixed). */
export function toSource(state: TabState, keyName: string): TabState {
  const v = tabOf(state, keyName);
  if (!v || v.kind !== "preview") return state;
  const source: TabFile = { kind: "file", target: v.target, path: v.path };
  const k = key(source);
  if (state.tabs.some((x) => key(x) === k)) return activate(close(state, keyName), k);
  const s = replaceTab(state, keyName, source);
  return { ...s, active: k, preview: s.preview === k ? null : s.preview };
}
/** Replace the tab `old` IN ITS PLACE with `fresh` (active, preview and trace move along); if `fresh` is already there, `old` drops. */
function replaceTab(state: TabState, old: string, fresh: CodeTab): TabState {
  const k = key(fresh);
  if (old === k || !state.tabs.some((t) => key(t) === old)) return state;
  const present = state.tabs.some((t) => key(t) === k);
  const tabs = present ? state.tabs.filter((t) => key(t) !== old) : state.tabs.map((t) => (key(t) === old ? fresh : t));
  const remap = (x: string | null) => (x === old ? k : x);
  const s: TabState = { tabs, active: remap(state.active) ?? CHAT, preview: present && state.preview === old ? null : remap(state.preview), views: state.views };
  if (state.last) s.last = [...new Set(state.last.map((x) => remap(x) ?? x))];
  return s;
}

/** Open a view (the ⋯ menu): already open ⇒ only active, otherwise appended to the open views and active. */
export function openView(state: TabState, a: View): TabState {
  const views = state.views.includes(a) ? state.views : [...state.views, a];
  return views === state.views && state.active === a ? state : used({ ...state, views, active: a });
}

/** Make a preview tab fixed (typing, double-click). Any other key leaves the state as it is. */
export function keep(state: TabState, keyName: string): TabState {
  return state.preview === keyName ? { ...state, preview: null } : state;
}

/** Make active: the chat, an open view or an open tab; anything else changes nothing (a closed view is opened by
 *  `openView`). */
export function activate(state: TabState, keyName: string): TabState {
  if (keyName === state.active) return state;
  if (keyName === CHAT || (isView(keyName) && state.views.includes(keyName)) || state.tabs.some((t) => key(t) === keyName)) return used({ ...state, active: keyName });
  return state;
}

/** The bar's row together with chat and views: the order of the tabs and of ⌃Tab. */
export const queue = (state: TabState): string[] => [CHAT, ...state.views, ...state.tabs.map(key)];

/**
 * Close a tab or a view. The chat tab is never closable. If it was active, the most recently used comes to the front (VS Code
 * `focusRecentEditorAfterClose`); without a trace its neighbor: the right one, otherwise the left; at the latest the chat stands on the
 * left. Closing a view ends nothing: the chat's terminals keep running (the right bar shows them), the explorer has no content of its own.
 */
export function close(state: TabState, keyName: string): TabState {
  if (keyName === CHAT) return state;
  const r = queue(state);
  const i = r.indexOf(keyName);
  if (i < 0) return state;
  const tabs = state.tabs.filter((t) => key(t) !== keyName);
  const views = state.views.filter((a) => a !== keyName);
  const stays = new Set([CHAT, ...views, ...tabs.map(key)]);
  const last = (state.last ?? []).filter((x) => x !== keyName && stays.has(x));
  const active = state.active === keyName ? (last[0] ?? r[i + 1] ?? r[i - 1] ?? CHAT) : state.active;
  return used({ tabs, active, preview: state.preview === keyName ? null : state.preview, views, last });
}

/** ⌃Tab (`1`) and ⌃⇧Tab (`-1`): cycle, including chat and views. An unknown active key goes forward to the first tab, backward to the
 *  chat. */
export function paginate(state: TabState, direction: 1 | -1): TabState {
  const r = queue(state);
  const i = r.indexOf(state.active);
  if (i < 0) return used({ ...state, active: direction > 0 ? (r[1] ?? CHAT) : CHAT });
  if (r.length < 2) return state;
  return used({ ...state, active: r[(i + direction + r.length) % r.length] });
}

const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
const inRepo = (repo: string, file: string) => (repo ? `${repo}/${file}` : file);

/** The file of a diff today (relative to the repo; for `files` the right side); null for a whole commit, a stash, the history. */
function todayOf(q: DiffSource): string | null {
  switch (q.kind) {
    case "change": case "commit": return q.current ?? q.file;
    case "comparison": return q.current ?? q.right.file;
    case "files": return q.right;
    default: return null;
  }
}

/**
 * A diff moves along when its file is renamed or moved (`form`: a path relative to the target → its new one, every other unchanged).
 * The unstaged and the staged change, a timeline commit and its comparison get `current` (the file today; the content still comes from
 * index or commit), the two-file comparison both new paths; a folder ABOVE the repo takes the repo along (the paths in it stay). If the
 * file leaves its repo, that is a deletion for the repo: null if the diff then falls (`sourceFalls`), otherwise it stays as it is.
 * Unchanged: the same source (no new object).
 *
 * VS Code 1.143 does NOT do this: `handleMovedFile` only renames editors whose two sides are the same resource (SideBySideEditorInput
 * `rename`), and `handleDeletedFile` (which also runs on a move) closes every diff with a file: side, the working-tree diff and the
 * two-file comparison; index, commit and timeline diffs (git: sides only) stay with the old name. cbase deliberately differs: every
 * diff moves along, like a file tab.
 */
export function renameSource(q: DiffSource, form: (path: string) => string, location: EventLocation): DiffSource | null {
  if (q.kind === "files") {
    // Per side computed in the event's coordinates (`location`) and back into those of its target; if a side leaves its target's view,
    // that is a deletion for it, and the comparison falls (like a file above that leaves its repo).
    const mapPath = location.map ?? onlySameTarget;
    const page = (z: TabTarget, p: string): string | null | undefined => {
      const here = mapPath(z, p, location.target);
      if (here === null) return undefined;
      const n = form(here);
      return n === here ? undefined : mapPath(location.target, n, z);
    };
    const left = page(q.leftTarget, q.left), right = page(q.rightTarget, q.right);
    if (left === undefined && right === undefined) return q;
    if (left === null || right === null) return null;
    return { ...q, left: left ?? q.left, right: right ?? q.right };
  }
  const repo = q.repo ? form(q.repo) : "";
  if (repo !== q.repo) return checkSource({ ...q, repo }) ?? q; // the repo moves as a whole; the paths in it stay
  const today = todayOf(q);
  if (today === null) return q;
  const full = inRepo(repo, today), fresh = form(full);
  if (fresh === full) return q;
  const rel = repo === "" ? fresh : fresh.startsWith(`${repo}/`) ? fresh.slice(repo.length + 1) : null;
  if (rel === null) return sourceFalls(q, (p) => p === full, location) ? null : q;
  return checkSource({ ...q, current: rel }) ?? q;
}

/**
 * Does the diff fall if `hits` recognizes the deleted paths (relative to the target)? Like VS Code `handleDeletedFile`: a diff whose
 * side is the file ITSELF: the unstaged change (the working tree on the right) and the two-file comparison (either of them). What
 * stands in Git (the index, a commit, the timeline comparison, a whole commit, a stash) stays and shows what was.
 */
export function sourceFalls(q: DiffSource, hits: (path: string) => boolean, location: EventLocation): boolean {
  if (q.kind === "files") {
    // Per side in the event's coordinates: a side that does not lie there (another target) is not hit by the deletion.
    const mapPath = location.map ?? onlySameTarget;
    const hitsPage = (z: TabTarget, p: string) => { const here = mapPath(z, p, location.target); return here !== null && hits(here); };
    return hitsPage(q.leftTarget, q.left) || hitsPage(q.rightTarget, q.right);
  }
  return q.kind === "change" && !q.staged && hits(inRepo(q.repo, q.current ?? q.file));
}

/** A file, seen from the target `from`, in the paths of the target `to` (null: it does not lie there). For the same target the path
 *  itself; across levels (the same file at workspace level and in the project) the window's mapping computes it
 *  (components/code/comparison-connection.ts, via lib/buffer-coordinates.ts). */
export type PathMapper = (from: TabTarget, path: string, to: TabTarget) => string | null;
export const onlySameTarget: PathMapper = (from, path, to) => (targetEqual(from, to) ? path : null);
/** Where a rename or deletion happened: the target of the area in whose paths `form`/`hits` compute, and the mapping for the sides of
 *  a two-file comparison from another target (if missing: only the same target). */
export type EventLocation = { target: TabTarget; map?: PathMapper };

/** After a rename in the tree (file or folder): the file tabs of this target move along, and so do preview and diffs (`renameSource`;
 *  a diff that falls with it closes like a close); a duplicate after the move drops. A two-file comparison moves along per SIDE,
 *  whatever target its tab stands in (`map`); `onlyCompare`: only those (a rename in another area of the window,
 *  components/code/comparison-connection.ts). If nothing changes, the state stays the same. A diff that WOULD fall but carries unsaved
 *  text (`unsaved`, the tab's key) stays as it is, as on deletion (`removeFiles`, VS Code `getAllNonDirtyEditors`): closing silently
 *  would lose what was typed. */
export function rename(state: TabState, target: TabTarget, old: string, fresh: string, o: { map?: PathMapper; onlyCompare?: boolean; unsaved?: (k: string) => boolean } = {}): TabState {
  if (!pathValid(old) || !pathValid(fresh) || old === fresh) return state;
  const form = (p: string) => (under(p, old) ? fresh + p.slice(old.length) : p);
  const location: EventLocation = { target, map: o.map };
  const projection = new Map<string, string>();
  const seen = new Set<string>();
  const tabs: CodeTab[] = [];
  const fallen: string[] = [];
  let changed = false;
  for (const t of state.tabs) {
    const prior = key(t);
    let n: CodeTab = t;
    if (t.kind === "diff" && t.source.kind === "files") {
      const q = renameSource(t.source, form, location);
      if (q === null) { if (!o.unsaved?.(prior)) fallen.push(prior); }
      else if (q !== t.source) n = { ...t, source: q };
    } else if (!o.onlyCompare && targetEqual(t.target, target)) {
      if (t.kind !== "diff") { if (under(t.path, old)) n = { ...t, path: form(t.path) }; }
      else {
        const q = renameSource(t.source, form, location);
        if (q === null) { if (!o.unsaved?.(prior)) fallen.push(prior); }
        else if (q !== t.source) n = { ...t, source: q };
      }
    }
    if (n !== t) changed = true;
    const k = key(n);
    projection.set(prior, k);
    if (seen.has(k)) { changed = true; continue; }
    seen.add(k);
    tabs.push(n);
  }
  if (!changed && !fallen.length) return state;
  const remap = (k: string | null) => (k === null ? null : projection.get(k) ?? k);
  let s: TabState = { tabs, active: remap(state.active) ?? CHAT, preview: remap(state.preview), views: state.views };
  if (state.last) s.last = [...new Set(state.last.map((k) => remap(k) ?? k))];
  for (const k of fallen) s = close(s, k);
  return s;
}

/** After a deletion: the file tabs and previews of this target below it drop (like closing, without a question: the file is gone),
 *  and the diffs with the file as a side (`sourceFalls`), but only those for which `diffFalls(key)` is true (like VS Code: deleted in
 *  the explorer a diff without unsaved text falls, via `handleDeletedFile` over `getAllNonDirtyEditors`; deleted from outside none,
 *  since `workbench.editor.closeOnFileDelete` is off). */
export function removeFiles(state: TabState, target: TabTarget, path: string, diffFalls: (k: string) => boolean, o: { map?: PathMapper; onlyCompare?: boolean } = {}): TabState {
  let s = state;
  const location: EventLocation = { target, map: o.map };
  for (const t of state.tabs) {
    // A two-file comparison per side, whatever target its tab stands in; everything else only in this target.
    const comparison = t.kind === "diff" && t.source.kind === "files";
    if (!comparison && (o.onlyCompare || !targetEqual(t.target, target))) continue;
    if (t.kind === "diff" ? sourceFalls(t.source, (p) => under(p, path), location) && diffFalls(key(t)) : under(t.path, path)) s = close(s, key(t));
  }
  return s;
}

// ── Storage ───────────────────────────────────────────────────────────────────────────────────

export const STORAGE_PREFIX = "cbase-chat-tabs:";
export const DRAFT_PREFIX = "cbase-chat-tab-draft:";
/** The collapse state of the file tree: ONCE for all chats. */
export const TREE_TO_KEY = "cbase-chat-code-tree-closed";
/** The state key of a draft (new chat before the first send): `@` appears in no chat id. */
export const draftChat = (workspaceId: string): string => `draft@${workspaceId}`;
export const storageKey = (chatKey: string): string => `${STORAGE_PREFIX}${chatKey}`;
/** A tab's draft: `|` separates because no chat id carries it; the tab's key behind it is JSON. */
export const draftKey = (chatKey: string, tabId: string): string => `${DRAFT_PREFIX}${chatKey}|${tabId}`;

/**
 * The two-file comparisons of a stored state that still carry the form from before the per-side targets (without targets): per their old
 * key (`[kind, left, right]` behind the tab's target) → the one after the migration (`checkTab`: both sides in the tab's target). The
 * active key, the preview, the trace (`readStatus`) and the draft (`migrateDrafts`) move along with it.
 */
export function comparisonMigration(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  let o: unknown;
  try { o = raw ? JSON.parse(raw) : null; } catch { return out; }
  if (!isObj(o) || !Array.isArray(o.tabs)) return out;
  for (const row of o.tabs) {
    if (!isObj(row) || row.kind !== "diff" || !isObj(row.source) || row.source.kind !== "files") continue;
    if (row.source.leftTarget !== undefined || row.source.rightTarget !== undefined) continue;
    const t = checkTab(row);
    if (!t || t.kind !== "diff" || t.source.kind !== "files") continue;
    out.set(`diff:${JSON.stringify([t.target.apiBase, t.target.instance ?? "", "files", t.source.left, t.source.right])}`, key(t));
  }
  return out;
}

/** The drafts of this chat's migrated comparisons under their new key (`comparisonMigration`). If one is already there, the old one
 *  stays where it is (nothing is overwritten); if storage does not take the new one (full), the old one stays too.
 *  Returns how many migrated. */
export function migrateDrafts(chatKey: string, raw: string | null | undefined, sp: { read: (k: string) => string | null; write: (k: string, v: string | null) => boolean }): number {
  let n = 0;
  for (const [old, fresh] of comparisonMigration(raw)) {
    const e = sp.read(draftKey(chatKey, old));
    if (e === null || sp.read(draftKey(chatKey, fresh)) !== null) continue;
    if (sp.write(draftKey(chatKey, fresh), e)) { sp.write(draftKey(chatKey, old), null); n++; }
  }
  return n;
}

/**
 * Read the stored state, row by row checked: an unreadable or duplicate row drops, not the list (empty is not unknown). An active key
 * without a tab becomes the chat, a preview without a tab none. Views: only known ones, each once; a state from before the views
 * (without the field) whose active key was “files” gets the explorer as an open view, otherwise it would stand on “files” without a tab
 * and nothing in the bar would show what is in front. A comparison from before the per-side targets migrates (`comparisonMigration`):
 * in front stays in front, the preview stays the preview, the trace keeps it.
 */
export function readStatus(raw: string | null | undefined): TabState {
  if (!raw) return emptyState();
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return emptyState(); }
  if (!isObj(o) || !Array.isArray(o.tabs)) return emptyState();
  const migrates = comparisonMigration(raw);
  const today = (k: unknown): unknown => (typeof k === "string" ? migrates.get(k) ?? k : k);
  o = { ...o, active: today(o.active), preview: today(o.preview), ...(Array.isArray(o.last) ? { last: o.last.map(today) } : {}) };
  if (!isObj(o) || !Array.isArray(o.tabs)) return emptyState();
  const tabs: CodeTab[] = [];
  const keys = new Set<string>();
  for (const row of o.tabs) {
    const t = checkTab(row);
    if (!t) continue;
    const k = key(t);
    if (keys.has(k)) continue;
    keys.add(k);
    tabs.push(t);
  }
  const views: View[] = [];
  for (const a of Array.isArray(o.views) ? o.views : []) if (isView(a) && !views.includes(a)) views.push(a);
  if (!Array.isArray(o.views) && o.active === FILES) views.push(FILES);
  const active = typeof o.active === "string" && (o.active === CHAT || (isView(o.active) && views.includes(o.active)) || keys.has(o.active)) ? o.active : CHAT;
  const preview = typeof o.preview === "string" && keys.has(o.preview) ? o.preview : null;
  const s: TabState = { tabs, active, preview, views };
  // The trace: only keys of the row, each once; if it is missing, the field stays absent.
  if (Array.isArray(o.last)) {
    const present = new Set(queue(s));
    s.last = [...new Set(o.last.filter((k): k is string => typeof k === "string" && present.has(k)))];
  }
  return s;
}

/** The state as text: `null` for the empty state (the entry then drops instead of lying around as an empty list). */
export function writeStatus(s: TabState): string | null {
  if (s.tabs.length === 0 && s.views.length === 0 && s.active === CHAT) return null;
  return JSON.stringify({ v: 1, tabs: s.tabs, active: s.active, preview: s.preview, views: s.views, ...(s.last ? { last: s.last } : {}) });
}

/** Unsaved content of a tab: `base` = the file state it rests on, `content` = the own text, `sha` = the checksum of the base as
 *  `files/read` named it (the precondition of saving, lib/file-status.ts; missing in older drafts), `buffer` = the buffer it was
 *  written from (lib/buffer.ts `BufferDraft`; missing in older drafts). */
export type FileDraft = { base: string; content: string; at: number; sha?: string; buffer?: string };
/** A draft is not remembered beyond this size: localStorage has a few MB for the whole app. The code area says so when it applies. */
export const DRAFT_MAX_CHARACTERS = 1_000_000;

export function readDraft(raw: string | null | undefined): FileDraft | null {
  if (!raw) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!isObj(o) || typeof o.base !== "string" || typeof o.content !== "string" || typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  return {
    base: o.base, content: o.content, at: o.at, ...(typeof o.sha === "string" && /^[0-9a-f]{64}$/.test(o.sha) ? { sha: o.sha } : {}),
    ...(typeof o.buffer === "string" && o.buffer ? { buffer: o.buffer } : {}),
  };
}

/** The draft as text; null if it cannot be remembered (too large). */
export function writeDraft(e: FileDraft): string | null {
  if (e.content.length + e.base.length > DRAFT_MAX_CHARACTERS) return null;
  return JSON.stringify({ base: e.base, content: e.content, at: e.at, ...(e.sha ? { sha: e.sha } : {}), ...(e.buffer ? { buffer: e.buffer } : {}) });
}

/** A chat was deleted: does it discard the buffer of one of its tabs that lies unsaved without a holder? Only if THIS chat's draft
 *  carries exactly this text: then the unsaved text comes from it. Without a draft or with another text it came from elsewhere (the
 *  same file in Coding → Files or another chat; ONE buffer): it stays. */
export function dismissesDeletedChat(p: { dirty: boolean; holders: number; text: string } | null | undefined, draft: FileDraft | null): boolean {
  return Boolean(p && p.dirty && p.holders === 0 && draft && draft.content.replace(/\r\n?/g, "\n") === p.text);
}

/**
 * Cleanup: which chats from the stored keys are NOT in the loaded list? Only candidates: deletion happens only when the server does not
 * know the chat (404): archived and empty chats are in no list and keep their tabs. `loaded` false ⇒ no candidates (a list not loaded
 * does not mean “there is no chat”). Nobody cleans up drafts.
 */
export function cleanupCandidates(keys: readonly string[], known: ReadonlySet<string>, loaded: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!loaded) return out;
  for (const k of keys) {
    let chat: string | null = null;
    if (k.startsWith(STORAGE_PREFIX)) chat = k.slice(STORAGE_PREFIX.length);
    else if (k.startsWith(DRAFT_PREFIX)) chat = k.slice(DRAFT_PREFIX.length).split("|")[0];
    if (!chat || chat.includes("@") || known.has(chat)) continue;
    out.set(chat, [...(out.get(chat) ?? []), k]);
  }
  return out;
}

// ── Tool paths (the file name of an Edit/Write row opens the file as a tab) ──────────────────────────────────────────────────

/**
 * A tool's path relative to the target's root; null if it lies outside (a worktree in the runtime folder, another project, home) or
 * is no valid path. Tools report absolute paths as the run sees them, and it sees them like B: the project container's mounts are
 * source = target (projectbox mount rules), and a copy lays its layers over the project folder at ITS original path, so `root` is the
 * project path in every instance (without a project the workspace path). A relative path (Codex) is taken against `cwd`, the runs'
 * working directory (the workspace root); without `cwd` it is none.
 */
export function relativeToRoot(path: unknown, root: string, cwd: string): string | null {
  if (typeof path !== "string" || !path || path.includes("\u0000") || path.startsWith("~")) return null;
  const abs = path.startsWith("/") ? path : cwd.startsWith("/") ? `${cwd}/${path}` : null;
  if (!abs || !root.startsWith("/")) return null;
  const segments = (p: string): string[] | null => {
    const out: string[] = [];
    for (const g of p.split("/")) {
      if (g === "" || g === ".") continue;
      if (g === "..") { if (!out.length) return null; out.pop(); } else out.push(g);
    }
    return out;
  };
  const a = segments(abs), w = segments(root);
  if (!a || !w || a.length <= w.length || w.some((g, i) => a[i] !== g)) return null;
  const rel = a.slice(w.length).join("/");
  return pathValid(rel) ? rel : null;
}

// ── Following live ────────────────────────────────────────────────────────────────────────────

/**
 * Does a reported path (absolute from a tool; rooted differently in the container, in B or in a copy) match a tab path (relative to
 * the target)? Compared at the end: a too generous hit only reloads a clean tab, and that only reloads if the content changed; a missed
 * one would leave a stale file standing.
 */
export function pathMatches(tabPath: string, reported: string): boolean {
  const g = reported.replace(/\\/g, "/");
  return g === tabPath || g.endsWith(`/${tabPath}`);
}

type BlockLike = { kind: string; id?: string; name?: string; input?: Record<string, unknown>; done?: boolean; resultIsError?: boolean; children?: BlockLike[] };
/** The tools whose result wrote a file (lib/tool-summary.ts `buildDiff` knows the same ones). */
export const WRITE_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"];

/** The files that completed, error-free write tools in the history wrote (also in subagents), per call id. */
export function writtenFiles(bubbles: ReadonlyArray<{ blocks: ReadonlyArray<BlockLike> }>): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  const go = (bs: ReadonlyArray<BlockLike>) => {
    for (const b of bs) {
      if (b.kind !== "tool") continue;
      if (b.children?.length) go(b.children);
      if (!b.id || !b.done || b.resultIsError || !b.name || !WRITE_TOOLS.includes(b.name)) continue;
      const i = b.input ?? {};
      const paths = b.name === "apply_patch"
        ? (Array.isArray(i.changes) ? (i.changes as unknown[]).map((c) => (isObj(c) ? text(c.path) : null)) : [])
        : [text(i.file_path) ?? text(i.notebook_path)];
      paths.forEach((p, n) => { if (p) out.push({ id: `${b.id}#${n}`, path: p }); });
    }
  };
  for (const b of bubbles) go(b.blocks);
  return out;
}

/** Is the chat waiting for the human: an open question or an open approval in the history? The running approvals of the stream
 *  (`permReqs`) are added by the caller. */
export function waitingForHuman(bubbles: ReadonlyArray<{ role: string; ask?: { answerable?: boolean; answers?: unknown } | null; approval?: { open?: boolean; ruling?: unknown } | null; dimmed?: boolean }>): boolean {
  return bubbles.some((b) => !b.dimmed && ((b.role === "ask" && Boolean(b.ask?.answerable) && !b.ask?.answers)
    || (b.role === "approval" && Boolean(b.approval?.open) && !b.approval?.ruling)));
}

/** The sign on the chat tab: the same ranking as the chat list's short info: an open question before the run, the run before the new
 *  answer. */
export type ChatSign = "question" | "running" | "fresh" | null;
export function chatSign(e: { waiting: boolean; running: boolean; fresh: boolean }): ChatSign {
  return e.waiting ? "question" : e.running ? "running" : e.fresh ? "fresh" : null;
}

// ── Shortcuts ─────────────────────────────────────────────────────────────────────────────────

export type KeyPress = { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };
export type TabShortcut = "find" | "close" | "next" | "previous" | "chat";

/**
 * What a key press in the bar does, or null. `code` (the key) is measured, not `key` (⌥W gives “∑” on the Mac). ⌘W only in the desktop
 * client (`shell`): in the browser ⌘W closes the browser tab before the page sees it; there ⌥W. On Windows/Linux Ctrl is what ⌘ is on
 * the Mac.
 */
export function tabShortcut(e: KeyPress, o: { mac: boolean; shell: boolean }): TabShortcut | null {
  const mod = o.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (e.code === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? "previous" : "next";
  if (e.shiftKey) return null;
  if (mod && !e.altKey && e.code === "KeyP") return "find";
  if (mod && !e.altKey && e.code === "Digit1") return "chat";
  if (e.code === "KeyW") {
    if (o.shell && mod && !e.altKey) return "close";
    if (!o.shell && e.altKey && !e.metaKey && !e.ctrlKey) return "close";
  }
  return null;
}

/** The shortcut for closing, as it stands in the tooltip. */
export function closeShortcutText(o: { mac: boolean; shell: boolean }): string {
  if (o.shell) return o.mac ? "⌘W" : "Ctrl+W";
  return o.mac ? "⌥W" : "Alt+W";
}

/**
 * The keyboard IN the tab bar (WAI-ARIA “Tabs” with manual activation): ←/→ cycle (at the end back to the front), Home/End jump to the
 * edge, Enter/Space open the tab with focus, Delete closes it (every one except the chat). `queue` = [CHAT, …views, …code tabs], `now` =
 * the tab with focus. Null: the key is not ours.
 */
export type TabKey = { kind: "focus" | "activate" | "close"; target: string };
export function tabKey(pressedKey: string, queue: readonly string[], now: string): TabKey | null {
  const i = queue.indexOf(now);
  if (i < 0 || queue.length === 0) return null;
  const n = queue.length;
  switch (pressedKey) {
    case "ArrowRight": return { kind: "focus", target: queue[(i + 1) % n] };
    case "ArrowLeft": return { kind: "focus", target: queue[(i - 1 + n) % n] };
    case "Home": return { kind: "focus", target: queue[0] };
    case "End": return { kind: "focus", target: queue[n - 1] };
    case "Enter": case " ": return { kind: "activate", target: now };
    case "Delete": return now === CHAT ? null : { kind: "close", target: now };
    default: return null;
  }
}

/**
 * The nudge “re-read” for the tabs of ONE target: a nudge with a target (saved in a tab) only concerns the tabs of the same target; for
 * every other the number stays but without paths (it reads nothing). Without a target (end of turn, Edit/Write) it applies to all.
 */
export function nudgeFor<A extends { seq: number; paths: readonly string[] | null; target?: TabTarget | null }>(a: A, z: TabTarget): { seq: number; paths: readonly string[] | null } {
  return { seq: a.seq, paths: a.target && !targetEqual(a.target, z) ? [] : a.paths };
}

/**
 * ⌘P: the finder's rows and what Enter does. The hits only count for the input they were fetched for: an answer for “pre” while
 * “prices.ts” already stands there is STALE (shown, but dimmed, not selectable); Enter then WAITS for the fresh answer instead of
 * opening an old hit. Without input the open tabs stand there, Enter opens the chosen row.
 */
export function finderSituation(query: string, response: { q: string; results: readonly string[] } | null, openPaths: readonly string[], choice: number):
  { rows: readonly string[]; stale: boolean; enter: { kind: "open"; path: string } | { kind: "wait" } | null } {
  const q = query.trim();
  if (!q) return { rows: openPaths, stale: false, enter: openPaths[choice] !== undefined ? { kind: "open", path: openPaths[choice] } : null };
  if (!response || response.q !== q) return { rows: response?.results ?? [], stale: Boolean(response), enter: { kind: "wait" } };
  const p = response.results[choice];
  return { rows: response.results, stale: false, enter: p !== undefined ? { kind: "open", path: p } : null };
}

// ── Display ───────────────────────────────────────────────────────────────────────────────────

export const baseName = (p: string): string => p.split("/").filter(Boolean).pop() || p;
export const breadcrumbs = (p: string): string[] => p.split("/").filter(Boolean);
/** The path a diff is about (relative to the repo, for a two-file comparison the right one): the file TODAY, across a rename
 *  (`current`); null for a whole commit or stash. */
export const diffPath = (q: DiffSource): string | null => todayOf(q);
/** A commit's short hash (seven characters like `git log --oneline`). */
export const shortHash = (h: string): string => h.slice(0, 7);

// ── The jump from outside (git bar and history open tabs) ─────────────────────────────────

export const CHAT_TAB_EVENT = "cbase-chat-tab";

/**
 * The event's detail. `target: null` means “the chat's target”: the caller does not know it (an Edit row) or should not recompute it
 * (the git bar in chat mode: ONE place computes the chat's target, the hook; otherwise the same place would be named two different
 * ways, and the tab would carry “· Main” for its own instance).
 */
export type ChatTabJump =
  | { chatId: string; kind: "file"; path: string; target: TabTarget | null; fixed: boolean }
  | { chatId: string; kind: "diff"; source: DiffSource; target: TabTarget | null; title?: string; short?: string; fixed: boolean };

/**
 * Opens a diff tab in chat `chatId` (the git bar in the chat, `embedded`). `target` = the target the bar shows at this moment
 * (lib/bar-instance.ts `barGitChoice`): `null` in chat mode (the chat's), with a choice the chosen instance. Without `fixed` a
 * preview tab like a click in VS Code's explorer.
 */
export function openDiffTab(chatId: string, source: DiffSource, target: TabTarget | null, o: { fixed?: boolean; title?: string; short?: string } = {}): void {
  if (!chatId) return;
  const detail: ChatTabJump = { chatId, kind: "diff", source, target, ...(o.title ? { title: o.title } : {}), ...(o.short ? { short: o.short } : {}), fixed: Boolean(o.fixed) };
  window.dispatchEvent(new CustomEvent<ChatTabJump>(CHAT_TAB_EVENT, { detail }));
}

/** Opens a file tab in chat `chatId`: `path` relative to the target (without `target`: the chat's). */
export function openFileTab(chatId: string, path: string, o: { target?: TabTarget; fixed?: boolean } = {}): void {
  if (!chatId) return;
  window.dispatchEvent(new CustomEvent<ChatTabJump>(CHAT_TAB_EVENT, { detail: { chatId, kind: "file", path, target: o.target ?? null, fixed: Boolean(o.fixed) } }));
}

/** The detail checked: a body without a chat, with an invalid path, target or source is no jump. */
export function chatTabJumpFrom(detail: unknown): ChatTabJump | null {
  if (!isObj(detail)) return null;
  const chatId = typeof detail.chatId === "string" ? detail.chatId.trim() : "";
  if (!chatId) return null;
  const fixed = detail.fixed === true;
  // A missing target is the chat's; a given one that does not hold is no jump (never silently “the chat's”).
  const withoutTarget = detail.target === null || detail.target === undefined;
  const target = withoutTarget ? null : checkTarget(detail.target);
  if (!withoutTarget && !target) return null;
  if (detail.kind === "file") {
    if (!pathValid(detail.path)) return null;
    return { chatId, kind: "file", path: detail.path, target, fixed };
  }
  if (detail.kind === "diff") {
    const source = checkSource(detail.source);
    if (!source) return null;
    return { chatId, kind: "diff", source, target, ...(text(detail.title) ? { title: detail.title as string } : {}), ...(text(detail.short) ? { short: detail.short as string } : {}), fixed };
  }
  return null;
}

/** A checked jump's tab: without a target in the chat's target. */
export function tabFromJump(s: ChatTabJump, chatTargetNow: TabTarget): CodeTab {
  const target = s.target ?? chatTargetNow;
  if (s.kind === "file") return { kind: "file", target, path: s.path };
  return { kind: "diff", target, source: s.source, ...(s.title ? { title: s.title } : {}), ...(s.short ? { short: s.short } : {}) };
}
