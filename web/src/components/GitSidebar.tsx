"use client";

import { Fragment, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api, gitHints, normGitCommitFileDiff,
  type GitBranches, type GitChange, type GitDiff, type GitLog, type GitRepo, type GitStashList, type GitTree,
} from "@/lib/api";
import type { DiffSource } from "@/lib/chat-tabs";
import { useConfirm, usePrompt } from "@/components/Prompts";
import { DotsIcon, SELECTED, Menu, MenuEntry, MenuSeparator, Modal, ghostSm, menuHeader, menuRow, useFlat } from "@/components/CbKit";
import { type GitAccess, GitAccessForm } from "@/components/projects/GitAccessForm";
import { useT } from "@/lib/i18n";
import { useAutoCollapse } from "@/lib/viewport";
import { useGitState } from "@/lib/git-state";
import { chatPath } from "@/lib/chat-instance";
import { instancePath } from "@/lib/code-instance";
import { isMac } from "@/lib/chat-bar";
import { GitGraph, GraphExtentChoice, useGraphExtent } from "@/components/git-bar/GitGraph";
import { KIND_COLOR, KIND_LETTER } from "@/lib/git-files";
import { diffPath } from "@/lib/git-files";
import { hunkPatch, parseDiff } from "@/lib/diff-tab";
import {
  SECTIONS_KEY, GIT_SECTIONS, GRAPH_REPO_KEY, readGraphChoice, HEIGHTS_KEY, HEADER_HEIGHT, MIN_BODY, ORDER_KEY, SPLIT_STEP, asShares, tidySelection,
  insertPlace, shownRepos, graphRepo, isFolderEntry, hasChanges, hasSomethingToDo, readShares, readOrder, readCollapsed,
  primaryButton, toggleCollapsed as toggleCollapsedIn, column, syncSteps, availableHeight, move as moveInOrder, distribute, selectRepo, pull, targetFromPlace,
  targetStep, type Shares, type GitSection, type Heights,
} from "@/lib/git-bar";

// Git bar in the style of the VS Code source control view. Three collapsible sections one below the other, each with a 22 px
// header (chevron, title in capitals, actions on the right only on hover or with focus inside); resizable in height and
// movable like the views in VS Code (see "stack" below):
//   Repositories: only with more than one repo: ONE row per repo (name; on the right branch with "*" on changes, sync button
//                 (circular arrows, the cloud for an unpublished branch), "..." with the repo actions). The row chooses which repos
//                 "Changes" shows.
//   Changes:      a head per shown repo (with ONE repo the section header itself carries branch, sync and actions, no repeated
//                 head), the growing commit field, the wide primary button with split menu (which one applies is computed by
//                 lib/git-bar.ts `primaryButton`: commit, publish branch, sync, greyed out), the groups Merge/Staged/Changes,
//                 below them stashes, worktrees, submodules.
//   Graph:        all branches like VS Code (lanes, merge curves, ref badges; choice "All" / "Current branch" in the head); the
//                 list is components/git-bar/GitGraph.tsx; loaded only while open, no timer of its own.
// The big view under Projects > Project > Git stays; iOS reads `branchesRunning`/counters per repo (lib/api/git.ts).
//
// DECISIONS:
// - Selection: the default is "all repos" and NO row is highlighted (nothing explicitly chosen). A click chooses exactly this
//   repo, a second click on the solely chosen one returns to the default, Cmd/Ctrl-click adds or removes it; "show all" in the
//   head. NOT "all with changes": a repo would vanish from "Changes" as soon as its commit is done, under the pointer, in the middle
//   of the flow. So that clean repos do not each span a commit field, they start COLLAPSED (only their head, like a node in the
//   VS Code tree); the default is fixed at first sight per repo (`hasSomethingToDo`), afterwards only the user decides.
// - Scrolling: EVERY open section scrolls within itself, like VS Code, with no shared scroll area. So all heads stay put and the
//   graph does not slide behind three hundred file rows. The DEFAULT (no drag saved) distributes at 360 x ~800 px like this:
//   Repositories is short and keeps its height (capped at ~7 rows), "Changes" is as tall as its content, at most 65 % (priority:
//   commit field and files are what one opens the bar for), the graph fills the rest (at least ~4 rows); if the graph is closed,
//   "Changes" fills. Rejected: equal split (with two files half the height stood empty) and shrinking by content (the long section
//   pushed the short ones to zero).
// - Collapsed sections are remembered in localStorage (`SECTIONS_KEY`, in try/catch; without storage everything is open), per user,
//   the same in chat bar and code tab. The message in the commit field survives collapsing and selection changes (drafts, per target + repo).
// - Stack (`SectionStack` below, computations in lib/git-bar.ts):
//   - HEIGHT: under every open section that is followed by another open one, a gap (4 px grab zone over the hairline, invisible
//     until hovered, then after 300 ms, when dragging at once, a 2 px accent line). It divides the height between this and the next
//     open section, neither below head + two rows (`MIN_BODY`); same mechanics as the width of the chat list (ChatListPane.tsx):
//     pointer capture, cursor and selection lock on the body for the duration of the drag, up/down arrows in 16 px steps, double
//     click = default. SHARES are stored (`HEIGHTS_KEY`), not pixels, so the ratio stays at another panel height; the first drag
//     measures the default distribution and computes from there.
//   - MOVE: the head of a section (title and empty area) can be dragged above or below another, from 4 px of movement; below that
//     it stays a click (open/close). Pointer events on the window, NO HTML5 drag and drop (the Electron shell). At the target a
//     2 px accent insertion line, the dragged section half transparent, Escape cancels. Without a mouse: "Move up"/"Move down" in
//     the "..." of every section head. Order in localStorage (`ORDER_KEY`); unknown ids drop out, missing ones are appended.
//   Nothing of this floats (`fixed`) or hangs on the body: line and grab zones lie `absolute` in the bar (web/test/drag-region.test.mjs).
// - The branch switcher hangs on the body (portal) and is anchored to the row that opens it: in a scrolling section its edge would
//   cut it off. Click catchers via document listeners, never `fixed inset-0` (layout containment, see there).
// - An action's error shows as ONE line at the top of the bar (`data-git-error`), not only in the tooltip.
//
// The status comes from `useGitState`: ONE timer per scope, read jointly by the activity bar (badge on the git icon) and this bar;
// nothing is polled here. Two users: the chat bar (`embedded`, head comes from the bar, panel 280-640 px) and the code page
// (272 px column with its own head, collapsible to the 40 px rail). The code page's column is borderless on the stage next to the
// editor, with a hairline in `edge` on its left, collapsed or expanded.
//
// `chatId`: the chat bar passes its chat in, and EVERY call in this file (tree, actions, diff, branches, history, graph, stash,
// worktrees, submodules, access) goes through `path` with `?chat=<id>`: the server then works in the instance of THIS chat (its
// copy, if it has moved in). Without the chat the bar of a copy chat would see main, and commit/discard/stash/checkout would run
// there. The code page passes no chat: there it stays the project (main).

const COLLAPSE_KEY = "cbase-git-collapsed";

// Colour and letter of a file row (KIND_COLOR, KIND_LETTER) live in lib/git-files.ts; the graph uses them for the
// files of an expanded commit.

// The commit field: one 20 px row plus 3 px padding above and below = 26 px (plus the hairline); it grows with its content up to ten
// rows (VS Code: 1-10), then scrolls.
const COMMIT_ROW = 20;
const COMMIT_MAX = COMMIT_ROW * 10 + 8;

const repoKey = (r: GitRepo) => r.relPath || r.root || r.name;
const canPush = (r: GitRepo) => (r.ahead ?? 0) > 0 || (!!r.remote && !r.upstream);
const stagedOf = (r: GitRepo) => (r.changes ?? []).filter((c) => c.x !== " " && c.x !== "?" && c.kind !== "conflict");
const unstagedOf = (r: GitRepo) => (r.changes ?? []).filter((c) => c.y !== " " && c.kind !== "conflict");
const conflictsOf = (r: GitRepo) => (r.changes ?? []).filter((c) => c.kind === "conflict");
const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
const dir = (p: string) => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : ""; };

type Act = (endpoint: string, body: Record<string, unknown>) => Promise<void>;
// The path builder of the view: `path("/git/...")` is `<apiBase>/git/...`, in the chat bar with `?chat=<id>` (lib/chat-instance.ts). EVERY
// call in this file goes through it; a call bypassing it would go from a copy chat into main (web/test/chat-bar.test.mjs (e2)).
type Path = (rest: string) => string;
// A diff route (code tabs in the chat): the source in the form of the tab model (lib/chat-tabs.ts `DiffSource`, paths raw relative to the
// repo) and what it displays: `title` (subject, name of a stash, "old -> new") and `short` (the graph's short hash).
/** Display only (title, short hash); and `fixed`: a double click opens the tab in the chat fixed instead of as a preview. */
export type DiffDisplay = { title?: string; short?: string; fixed?: boolean };
type ShowDiff = (q: DiffSource, a?: DiffDisplay) => void;
type Modal =
  | { kind: "diff"; title: string; badge: string; hunk?: { repoRel: string; staged: boolean }; diff?: string; error?: string; seq?: number }
  | { kind: "history"; repo: GitRepo };

// The message in the commit field per target and repo (`path("")` + repo): it survives collapsing a repo, a selection change and
// detaching and attaching the bar while the page lives (VS Code keeps it too). A successful commit clears it.
const DRAFTS = new Map<string, string>();

// What the bar's building blocks need from the shell: ONE context instead of ten passed-through props. `control`: the commit field
// registers its main button here so the check mark in a repo's head (or the section's) takes the same path.
type Control = { main: () => void; focus: () => void };
type GitContext = {
  path: Path;
  act: Act;
  performAction: (fn: () => Promise<unknown>) => Promise<void>;
  synchronize: (r: GitRepo) => Promise<void>;
  refresh: () => Promise<void>;
  openBranch: (r: GitRepo, anchor: Element | null) => void;
  showHistory: (r: GitRepo) => void;
  draft: (r: GitRepo) => string;
  control: Map<string, Control>;
};
const GitK = createContext<GitContext | null>(null);
function useGit(): GitContext {
  const k = useContext(GitK);
  if (!k) throw new Error("GitSidebar: building block outside the bar");
  return k;
}
type ToContext = { close: Partial<Record<GitSection, true>>; toggle: (id: GitSection) => void };
const SectionTo = createContext<ToContext>({ close: {}, toggle: () => {} });

// Whether Cmd or Ctrl appears in the commit field's placeholder: the SAME detection as the bar's shortcuts
// (`isMac`, lib/chat-bar.ts). Measured only after mounting: the page is built statically, and there is no `navigator` while hydrating.
function useMac() {
  const [mac, setMac] = useState(true);
  useEffect(() => { setMac(isMac()); }, []);
  return mac;
}

// MEMOIZED (all props are primitive). The sidebar hangs in the chat window, which re-renders on every token during a run. Without
// this guard every SSE event also rebuilt the complete git tree (up to 300 file rows, branch panel, sections), which was the jank
// as soon as the git sidebar was open.
// `instance`: the chosen copy of the code tab (`instance=<identifier>`, web/src/lib/code-instance.ts); the code tab belongs to no
// chat; without it main. `path` appends it behind the chat, the store is one per instance. Also the instance choice of the chat bar
// (lib/bar-instance.ts): it passes EXACTLY one, the chat or the chosen instance, never both.
// `onError` (keep stable, the view is memoized): every failed action goes there first; the bar falls back to the chat on a 404
// `UNKNOWN_INSTANCE` of the chosen copy. The error is then thrown as before.
// `active`: the code tab stays mounted on tab switch; hidden, the column does not read the git status (no reader, no timer; the store
// stays in the register) and keeps showing the last state so commit text and expansions remain.
// `onDiffTab` (keep stable like `onError`): only the chat bar passes it; every diff route then opens a tab in the chat instead of the
// modal (`showDiff`); the tab's target (what the bar currently shows) is known to the bar, not to this view.
export const GitSidebar = memo(function GitSidebar({ apiBase, chatId = null, instance = null, onError, onDiffTab, flush, embedded = false, active = true }: { apiBase: string; chatId?: string | null; instance?: string | null; onError?: (e: unknown) => void; onDiffTab?: (q: DiffSource, a: DiffDisplay) => void; projectName?: string; flush?: boolean; embedded?: boolean; active?: boolean }) {
  const t = useT();
  const wrap = flush ? "" : "mb-3 mr-3";
  const live = useGitState(active ? apiBase : null, chatId, instance);
  const last = useRef(live);
  if (active) last.current = live;
  const { tree, loaded, changes, refresh, setTree } = active ? live : last.current;
  const path = useCallback<Path>((rest) => instancePath(chatPath(apiBase, rest, chatId), instance), [apiBase, chatId, instance]);
  const [collapsed, setCollapsed] = useState(false);
  // The 272 px column falls back to the 40 px rail below 1100 px and expands again when enlarged. Deliberately setCollapsed directly
  // instead of toggleCollapsed: the user's saved choice must not be overwritten by the window width.
  useAutoCollapse(1100, !collapsed, useCallback((open: boolean) => setCollapsed(!open), []));
  const [modal, setModal] = useState<Modal | null>(null);
  // The sections: collapsed per section from storage (default: all open).
  const [folded, setFolded] = useState<Partial<Record<GitSection, true>>>({});
  // The selection in the "Repositories" section (`null` = default, all) and the explicit choice in the graph head.
  const [selection, setSelection] = useState<string[] | null>(null);
  const [graphChoice, setGraphChoiceRaw] = useState<string | null>(null);
  // The graph repo choice applies per scope and survives reloads; a scope change rereads it.
  const graphKey = `${GRAPH_REPO_KEY}:${path("")}`;
  useEffect(() => {
    try { setGraphChoiceRaw(readGraphChoice(localStorage.getItem(graphKey))); } catch { setGraphChoiceRaw(null); }
  }, [graphKey]);
  const setGraphChoice = useCallback((k: string) => {
    setGraphChoiceRaw(k);
    try { localStorage.setItem(graphKey, k); } catch { /* local preference; without storage it holds until reload */ }
  }, [graphKey]);
  // Expanded per repo under "Changes" (only with several): the user's choice, otherwise the default fixed at first sight.
  const [repoOpen, setRepoOpen] = useState<Record<string, boolean>>({});
  const defaultOpen = useRef(new Map<string, boolean>());
  const [error, setError] = useState("");
  const [branchChoice, setBranchChoice] = useState<{ key: string; anchor: Element } | null>(null);
  const control = useRef(new Map<string, Control>()).current;

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
      setFolded(readCollapsed(localStorage.getItem(SECTIONS_KEY)));
    } catch { /* without storage: expanded, all sections open */ }
  }, []);
  useEffect(() => {
    for (const r of tree?.repos ?? []) {
      const k = repoKey(r);
      if (!defaultOpen.current.has(k)) defaultOpen.current.set(k, hasSomethingToDo(r));
    }
  }, [tree]);
  function toggleCollapsed() {
    setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? "1" : "0"); } catch { /* only for this session */ } return n; });
  }
  const toggle = useCallback((id: GitSection) => {
    setFolded((v) => {
      const n = toggleCollapsedIn(v, id);
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(n)); } catch { /* only for this session */ }
      return n;
    });
  }, []);
  const toContext = useMemo<ToContext>(() => ({ close: folded, toggle }), [folded, toggle]);

  // An action answers with the fresh tree, which goes through `setTree` to ALL readers of the scope (also the bar's badge),
  // otherwise it would show the old number for six seconds.
  const takeOver = useCallback((result: GitTree | null) => {
    if (result && Array.isArray(result.repos)) setTree(result);
    else refresh().catch(() => {});
  }, [setTree, refresh]);

  // If auth is missing (private remote, no credentials), a modal opens that saves credentials for the WORKSPACE and repeats the action
  // afterwards. `authAsked` stops a sequence of steps (sync: pull, then push) as soon as the modal stands; otherwise the second step
  // would ask again and displace the retry of the first.
  const [authAsk, setAuthAsk] = useState<null | { host: string; ssh: boolean; endpoint: string; body: Record<string, unknown> }>(null);
  const authAsked = useRef(false);
  const act = useCallback<Act>(async (endpoint, body) => {
    try {
      const result = await api<GitTree>(path(`/git/${endpoint}`), { method: "POST", body: JSON.stringify(body) });
      takeOver(result);
    } catch (e) {
      const err = e as Error & { authRequired?: boolean; host?: string; ssh?: boolean };
      if (err.authRequired) { authAsked.current = true; setAuthAsk({ host: err.host || "", ssh: !!err.ssh, endpoint, body }); return; }
      onError?.(e);
      throw e;
    }
  }, [path, takeOver, onError]);

  const performAction = useCallback(async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); } catch (e) { setError(String((e as Error)?.message || e)); }
  }, []);
  // Sync like VS Code (lib/git-bar.ts `syncSteps`): first pull, then push; nothing to do means fetch; without upstream push (publish).
  const synchronize = useCallback(async (r: GitRepo) => {
    authAsked.current = false;
    for (const step of syncSteps(r)) {
      await act(step, { repo: r.relPath });
      if (authAsked.current) return;
    }
  }, [act]);
  const refreshNow = useCallback(async () => { await refresh(); }, [refresh]);
  const openBranch = useCallback((r: GitRepo, anchor: Element | null) => {
    if (!anchor) return;
    const k = repoKey(r);
    setBranchChoice((cur) => (cur?.key === k && cur.anchor === anchor ? null : { key: k, anchor }));
  }, []);
  const closeBranch = useCallback(() => setBranchChoice(null), []);
  const showHistory = useCallback((r: GitRepo) => setModal({ kind: "history", repo: r }), []);
  const draft = useCallback((r: GitRepo) => `${path("")}\u0000${repoKey(r)}`, [path]);
  const context = useMemo<GitContext>(
    () => ({ path, act, performAction, synchronize, refresh: refreshNow, openBranch, showHistory, draft, control }),
    [path, act, performAction, synchronize, refreshNow, openBranch, showHistory, draft, control],
  );

  const openFileDiff = useCallback((repoRel: string, file: string, staged: boolean) => {
    setModal({ kind: "diff", title: file, badge: staged ? "staged" : "changes", hunk: { repoRel, staged } });
    api<GitDiff>(path("/git/diff"), { method: "POST", body: JSON.stringify({ repo: repoRel, file, staged }) })
      .then((d) => setModal((cur) => (cur?.kind === "diff" && cur.title === file ? { ...cur, diff: d.diff } : cur)))
      .catch((e) => setModal((cur) => (cur?.kind === "diff" && cur.title === file ? { ...cur, error: String((e as Error).message) } : cur)));
  }, [path]);

  // Every opening carries a number: the response only lands in the sheet that asked for it (two files with the same name in two
  // commits of the graph would otherwise have been swapped).
  const textDiffSeq = useRef(0);
  const openTextDiff = useCallback((title: string, badge: string, load: () => Promise<string>) => {
    const seq = ++textDiffSeq.current;
    setModal({ kind: "diff", title, badge, seq });
    load().then((diff) => setModal((cur) => (cur?.kind === "diff" && cur.seq === seq ? { ...cur, diff } : cur)))
      .catch((e) => setModal((cur) => (cur?.kind === "diff" && cur.seq === seq ? { ...cur, error: String((e as Error).message) } : cur)));
  }, []);
  // The text of a diff for the modal, from its source: the same bodies as on the individual routes (graph: file with
  // `file`/`old` checked via diffPath and the echo, whole commit and history via /git/show, stash via /git/stash/show).
  const diffText = useCallback(async (q: DiffSource): Promise<string> => {
    if (q.kind === "stash") return (await api<{ diff: string }>(path("/git/stash/show"), { method: "POST", body: JSON.stringify({ repo: q.repo, ref: q.ref }) })).diff;
    if (q.kind === "commit") {
      const file = diffPath(q.file);
      const old = q.old ? diffPath(q.old) : null;
      const raw = await api<unknown>(path("/git/show"), { method: "POST", body: JSON.stringify({ repo: q.repo, hash: q.hash, file, ...(old ? { old: old } : {}) }) });
      const r = normGitCommitFileDiff(raw, file);
      if (!r) throw new Error(t("The server does not know the diff of a single file yet (after its next deploy) — \"Show whole commit\" works."));
      return r.clipped ? `${r.diff}\\ ${t("Cut at 2 MB — the rest of this file is not shown here.")}\n` : r.diff;
    }
    if (q.kind === "change") throw new Error("diffText: a change goes through openFileDiff");
    // The comparisons (explorer, time axis) never come from the bar: they are tabs (lib/comparison.ts).
    if (q.kind === "comparison" || q.kind === "files") throw new Error("diffText: a comparison can only be seen as a tab");
    return (await api<{ diff: string }>(path("/git/show"), { method: "POST", body: JSON.stringify({ repo: q.repo, hash: q.hash }) })).diff;
  }, [path, t]);
  // EVERY diff route of the bar goes through here: changes (conflict, staged, unstaged), stash, history, in the graph a commit's file
  // and the whole commit. With `onDiffTab` (the chat bar) it becomes a tab in the chat, and an open history sheet closes, otherwise it
  // would stand over the tab; without (Coding > Files, Projects > Git) the modal as before, with title and badge as on the old routes.
  const diffTab = useRef(onDiffTab);
  diffTab.current = onDiffTab;
  const showDiff = useCallback<ShowDiff>((q, a = {}) => {
    if (diffTab.current) { diffTab.current(q, a); setModal(null); return; }
    if (a.fixed) return; // in the modal a double click is just the two clicks before it
    if (q.kind === "change") { openFileDiff(q.repo, q.file, q.staged); return; }
    if (q.kind === "comparison" || q.kind === "files") return; // never from the bar (see diffText)
    const title = q.kind === "stash" ? q.ref : a.title || (q.kind === "commit" ? q.file : q.hash);
    const badge = q.kind === "stash" ? "stash" : q.kind === "history" ? q.hash.slice(0, 8) : a.short ?? q.hash.slice(0, 7);
    openTextDiff(title, badge, () => diffText(q));
  }, [openFileDiff, openTextDiff, diffText]);

  const repos = tree?.repos ?? [];
  const hints = gitHints(tree);
  const anyGitlab = repos.some((r) => r.remote?.isGitlab);
  const multi = repos.length > 1;
  if (!loaded) {
    return embedded ? <div className="grid min-h-0 flex-1 place-items-center text-[12px] text-dim">{t("Loading…")}</div> : null;
  }
  if (repos.length === 0) {
    return embedded ? <div className="grid min-h-0 flex-1 place-items-center whitespace-pre-line px-6 text-center text-[12px] leading-relaxed text-dim">{hints.length ? hints.join("\n") : t("No Git repository was found in the project.")}</div> : null;
  }

  if (collapsed && !embedded) {
    return (
      <aside className={`${wrap} flex w-[40px] shrink-0 flex-col items-center gap-3 border-l border-edge py-3`}>
        <button onClick={toggleCollapsed} title={t("Expand Git sidebar")} className="grid h-7 w-7 place-items-center rounded-lg text-dim hover:bg-hover hover:text-fg"><ChevronLeftIcon /></button>
        <span className={anyGitlab ? "text-accent" : "text-dim"}><GitBranchIcon /></span>
        {multi && <span className="font-mono text-[11px] font-semibold text-dim">{repos.length}×</span>}
        {changes > 0 && <span className="grid min-h-[20px] min-w-[20px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">{changes > 99 ? "99+" : changes}</span>}
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-dim [writing-mode:vertical-rl]">{anyGitlab ? "GitLab" : "Git"}</span>
      </aside>
    );
  }

  const keys = repos.map(repoKey);
  const choice = tidySelection(selection, keys);
  const shown = shownRepos(repos, repoKey, choice);
  const sole = repos[0];
  const isOpen = (r: GitRepo) => repoOpen[repoKey(r)] ?? defaultOpen.current.get(repoKey(r)) ?? hasSomethingToDo(r);
  const countShown = shown.reduce((n, r) => n + (r.counts?.total ?? 0), 0);
  const branchRepo = branchChoice ? repos.find((r) => repoKey(r) === branchChoice.key) ?? null : null;

  const hintRow = hints.length > 0 && <div className="shrink-0 whitespace-pre-line border-b border-edge px-3 py-1.5 text-[11px] leading-snug text-dim">{hints.join("\n")}</div>;
  const errorRow = error && (
    <div role="alert" className="flex shrink-0 items-start gap-1.5 border-b border-edge py-1.5 pl-3 pr-1.5 text-[11px] leading-snug text-danger" data-git-error>
      <span className="cb-scroll max-h-[64px] min-w-0 flex-1 overflow-y-auto whitespace-pre-line break-words">{error}</span>
      <button type="button" onClick={() => setError("")} title={t("Dismiss##hide")} aria-label={t("Dismiss##hide")} className="grid h-4 w-4 shrink-0 place-items-center rounded text-dim hover:bg-edge hover:text-fg"><CloseIcon size={11} /></button>
    </div>
  );
  // The sections go to the stack as elements: it orders, measures and distributes; a drag at the gap or head only rerenders it and the
  // heads, the contents (up to 300 file rows) are the same elements and stay put.
  const sections = (
    <SectionStack existing={multi ? GIT_SECTIONS : WITHOUT_REPOS} closed={folded} content={{
      repos: multi ? (
        <Section
          id="repos" title={t("Repositories")} role="fixed" cap="max-h-[min(32%,176px)]" data={{ "data-git-repositories": "" }}
          right={choice ? <span className="shrink-0 pr-0.5 text-[11px] tabular-nums text-dim">{t("{n} of {m}", { n: choice.length, m: repos.length })}</span> : undefined}
          actions={<>
            {choice && <button type="button" onClick={() => setSelection(null)} className="rounded px-1 text-[11px] text-accent hover:bg-edge">{t("Show all")}</button>}
            <SectionMenu id="repos" title={t("Repositories")} />
          </>}
        >
          {repos.map((r) => {
            const k = repoKey(r);
            return <RepoRow key={k} repo={r} selected={choice?.includes(k) ?? false} onChoice={(addition) => { setSelection((a) => selectRepo(tidySelection(a, keys), k, addition)); setGraphChoice(k); }} />;
          })}
        </Section>
      ) : null,
      changes: (
        <Section
          id="changes" title={t("Changes")} role={folded.graph ? "fills" : "precedence"} countTo={countShown || undefined} data={{ "data-git-changes": "" }}
          right={multi ? undefined : <RepoState repo={sole} />}
          actions={multi
            ? <><HeaderAction title={t("Refresh")} onRun={refreshNow}><ReloadIcon /></HeaderAction><SectionMenu id="changes" title={t("Changes")} /></>
            : <><CommitHeaderAction repo={sole} /><HeaderAction title={t("Refresh")} onRun={refreshNow}><ReloadIcon /></HeaderAction><RepoMenu repo={sole} section="changes" /></>}
        >
          {multi
            ? shown.map((r) => {
                const k = repoKey(r);
                const open = isOpen(r);
                return <RepoChanges key={k} repo={r} open={open} onToggle={() => setRepoOpen((v) => ({ ...v, [k]: !open }))} onDiff={showDiff} />;
              })
            : <RepoBody repo={sole} indented={false} onDiff={showDiff} />}
        </Section>
      ),
      graph: <GraphSection repos={repos} shown={shown} choice={graphChoice} onChoice={setGraphChoice} onDiff={showDiff} />,
    }} />
  );
  const body = <>{hintRow}{errorRow}{sections}</>;

  return (
    <GitK.Provider value={context}>
      <SectionTo.Provider value={toContext}>
        {embedded ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-git-bar>{body}</div>
        ) : (
        // Without a surface: head and sections stand one below the other on the stage, separated only by hairlines; on the left a hairline
        // separates the column from the editor.
        <aside className={`${wrap} flex w-[272px] min-w-[272px] shrink-0 flex-col overflow-hidden border-l border-edge`} data-git-bar>
          <header className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2.5">
            <span className={anyGitlab ? "text-accent" : "text-dim"}><GitBranchIcon /></span>
            <span className="text-[13px] font-semibold tracking-tight">{multi ? `Git · ${repos.length}` : anyGitlab ? "GitLab" : "Git"}</span>
            <span className="flex-1" />
            <button onClick={toggleCollapsed} title={t("Collapse")} className="grid h-7 w-7 place-items-center rounded-lg text-dim hover:bg-hover hover:text-fg"><ChevronRightIcon /></button>
          </header>
          {body}
        </aside>
        )}

        {branchChoice && branchRepo && <BranchSwitcher key={branchChoice.key} repo={branchRepo} path={path} act={act} anchor={branchChoice.anchor} onClose={closeBranch} />}
        {modal?.kind === "diff" && <DiffModal title={modal.title} badge={modal.badge} diff={modal.diff} error={modal.error} hunk={modal.hunk} act={act} onClose={() => setModal(null)} />}
        {authAsk && (
          <GitAuthModal
            path={path}
            ask={authAsk}
            onClose={() => setAuthAsk(null)}
            onSuccess={(result) => { takeOver(result); setAuthAsk(null); }}
          />
        )}
        {modal?.kind === "history" && <HistoryModal repo={modal.repo} path={path} act={act} onClose={() => setModal(null)} onShow={(hash, subject) => showDiff({ kind: "history", repo: modal.repo.relPath, hash }, { title: subject || undefined })} />}
      </SectionTo.Provider>
    </GitK.Provider>
  );
});

// ── Section (header 22 px + its own scroll area) ─────────────────────────────
// The role decides how an OPEN section divides the height in the DEFAULT (see the head of the file, "Scrolling"); if the user has
// dragged at the gap, the stack gives every open body its height (`height`) and the role does not apply. Collapsed shows only the head.
// `header` stands right behind the title (the graph's repo choice), `right` at the right edge (branch and sync with one repo), both
// always visible; `actions` only on hover, with focus in the head or while their menu is open. The empty area between title and right
// edge folds with the mouse (like VS Code); with the keyboard the title button does it. Title button and empty area are also the
// handle for moving (`headerDown`); a click after a drag does not fold (`afterDrag`).
type Role = "fixed" | "precedence" | "fills" | "graph";
const ROLE: Record<Role, string> = {
  fixed: "shrink-0", // short: keeps its height up to the cap, scrolls within itself above it
  precedence: "min-h-[22px] max-h-[65%]", // as tall as the content, at most 65 %, shrinks under pressure
  fills: "min-h-[22px] flex-1", // fills the rest
  graph: "min-h-[110px] flex-1", // fills the rest, at least head + four rows
};
function Section({ id, title, role, cap = "", count, countTo, header, right, actions, data, children }: {
  id: GitSection; title: string; role: Role; cap?: string; count?: number; countTo?: number;
  header?: React.ReactNode; right?: React.ReactNode; actions?: React.ReactNode; data?: Record<string, string>; children: React.ReactNode;
}) {
  const { close: closed, toggle } = useContext(SectionTo);
  const stack = useContext(StackK);
  const open = !closed[id];
  const shownCount = count ?? (open ? undefined : countTo);
  const height = open ? stack.height(id) : null;
  const pulled = stack.dragging === id;
  const fold = (e: React.MouseEvent) => { if (!stack.afterDrag(e)) toggle(id); };
  const grab = (e: React.PointerEvent) => stack.headerDown(e, id);
  return (
    <section data-git-section={id} data-git-open={open ? "1" : "0"} data-git-pulled={pulled ? "1" : undefined} {...(data ?? {})}
      className={`flex flex-col overflow-hidden border-t border-edge first:border-t-0 ${open && height == null ? `${ROLE[role]} ${cap}` : "shrink-0"} ${pulled ? "opacity-50" : ""}`}>
      <div className="group flex h-[22px] shrink-0 items-center gap-0.5 pr-1.5" data-git-row-anchor data-git-header={id}>
        <button type="button" onClick={fold} onPointerDown={grab} aria-expanded={open} className="flex h-full shrink-0 items-center gap-1 pl-1.5 text-left">
          <span className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}><ChevronRightIcon size={12} /></span>
          <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-dim">{title}</span>
          {shownCount != null && <Counter n={shownCount} />}
        </button>
        {header && <div className="ml-1 flex min-w-0 shrink items-center">{header}</div>}
        <span className="h-full min-w-2 flex-1 cursor-pointer" onClick={fold} onPointerDown={grab} aria-hidden data-git-header-surface />
        {right && <div className="flex min-w-0 shrink items-center gap-0.5">{right}</div>}
        {actions && <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex has-[[aria-expanded=true]]:flex">{actions}</span>}
      </div>
      {open && <div className="cb-scroll min-h-0 overflow-y-auto px-1 pb-1.5" style={height != null ? { height: height } : undefined} data-git-body={id}>{children}</div>}
    </section>
  );
}

// ── Stack: order and heights of the sections ────────────────
// The stack holds, separate from the bar: the order (`ORDER_KEY`), the shares (`HEIGHTS_KEY`, `null` = default by role), the measured
// height of the bar and the drag, all in localStorage, in try/catch: without storage the default holds for this session. The
// computations are in lib/git-bar.ts (`distribute`, `pull`, `asShares`, `column`, `insertPlace`, `targetFromPlace`, `targetStep`,
// `move`); here it is only measured, drawn and stored. Measured with ONE ResizeObserver on the bar and on every section (the body
// height is the section's minus head; in the default the body itself is as tall as its content, not as its space).
type StackContext = {
  height: (id: GitSection) => number | null;
  dragging: GitSection | null;
  /** Some drag is running (section by head OR gap): the graph then shows no hover card (CommitCard.tsx). */
  turn: boolean;
  headerDown: (e: React.PointerEvent, id: GitSection) => void;
  afterDrag: (e: React.MouseEvent) => boolean;
  can: (id: GitSection, direction: -1 | 1) => boolean;
  shift: (id: GitSection, direction: -1 | 1) => void;
};
const StackK = createContext<StackContext>({ height: () => null, dragging: null, turn: false, headerDown: () => {}, afterDrag: () => false, can: () => false, shift: () => {} });
const WITHOUT_REPOS: readonly GitSection[] = GIT_SECTIONS.filter((id) => id !== "repos");
// From this much movement (px) a press on the head is a drag, below it a click.
const TRANSACTION_THRESHOLD = 4;
const save = (key: string, value: unknown) => {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* only for this session */ }
};
// Cursor and selection lock on the body for the duration of a drag (like the chat list's gap); otherwise the cursor flickers over every
// element the pointer crosses, and the drag selects text.
const dragCursor = (cursor: string | null) => { document.body.style.cursor = cursor ?? ""; document.body.style.userSelect = cursor ? "none" : ""; };
const sameHeights = (a: Heights, b: Heights) => {
  const keysA = Object.keys(a), keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((k) => a[k as GitSection] === b[k as GitSection]);
};
const sectionsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(":scope > section[data-git-section]")];

function SectionStack({ existing, closed: collapsed, content }: {
  existing: readonly GitSection[]; closed: Partial<Record<GitSection, true>>; content: Partial<Record<GitSection, React.ReactNode>>;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useState<GitSection[]>(() => {
    try { return readOrder(localStorage.getItem(ORDER_KEY)); } catch { return [...GIT_SECTIONS]; }
  });
  const [shares, setShares] = useState<Shares | null>(() => {
    try { return readShares(localStorage.getItem(HEIGHTS_KEY)); } catch { return null; }
  });
  const [bar, setBar] = useState(0);
  const [measured, setMeasured] = useState<Heights>({});
  const [splitDrag, setSplitDrag] = useState<number | null>(null);
  const [dragging, setDragging] = useState<GitSection | null>(null);
  const [line, setLine] = useState<number | null>(null);

  const visible = order.filter((id) => existing.includes(id));
  const open = visible.filter((id) => !collapsed[id]);
  const available = availableHeight(bar, visible.length);
  const px = shares && bar > 0 ? distribute(open, shares, available) : null;
  const state = useRef({ visible, open, available, shares, measured, order });
  state.current = { visible, open, available, shares, measured, order };

  const key = `${visible.join()}|${open.join()}`;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const miss = () => {
      setBar(el.clientHeight);
      const m: Heights = {};
      for (const s of sectionsIn(el)) if (s.dataset.gitOpen === "1") m[s.dataset.gitSection as GitSection] = Math.max(0, s.clientHeight - HEADER_HEIGHT);
      setMeasured((v) => (sameHeights(v, m) ? v : m));
    };
    miss();
    const ro = new ResizeObserver(miss);
    ro.observe(el);
    for (const s of sectionsIn(el)) ro.observe(s);
    return () => ro.disconnect();
  }, [key]);

  // ── Gap: the height between two open neighbours ──
  // The drag computes from the pixels at press (in the default: measured, brought to shares of the available height); a press without
  // movement changes and stores nothing (otherwise the first click of a double click would already fix the default).
  const turn = useRef<{ y0: number; start: Heights; top: GitSection; bottom: GitSection; base: Shares; moved: boolean } | null>(null);
  const baseNow = () => { const s = state.current; return s.shares ?? asShares(s.measured, s.open, null); };
  const pulledShares = (z: NonNullable<typeof turn.current>, y: number) => asShares(pull(z.start, z.top, z.bottom, y - z.y0), state.current.open, z.base);
  const splitDown = (e: React.PointerEvent<HTMLDivElement>, after: number, top: GitSection, bottom: GitSection) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const currentBase = baseNow();
    turn.current = { y0: e.clientY, start: distribute(state.current.open, currentBase, state.current.available), top, bottom, base: currentBase, moved: false };
    setSplitDrag(after);
    dragCursor("row-resize");
  };
  const splitMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const z = turn.current;
    if (!z) return;
    if (e.clientY !== z.y0) z.moved = true;
    if (z.moved) setShares(pulledShares(z, e.clientY));
  };
  const splitUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const z = turn.current;
    if (!z) return;
    turn.current = null;
    setSplitDrag(null);
    dragCursor(null);
    if (!z.moved) return;
    const fresh = pulledShares(z, e.clientY);
    setShares(fresh);
    save(HEIGHTS_KEY, fresh);
  };
  const splitKey = (e: React.KeyboardEvent<HTMLDivElement>, top: GitSection, bottom: GitSection) => {
    const step = e.key === "ArrowDown" ? SPLIT_STEP : e.key === "ArrowUp" ? -SPLIT_STEP : 0;
    if (!step) return;
    e.preventDefault();
    const s = state.current;
    const currentBase = baseNow();
    const fresh = asShares(pull(distribute(s.open, currentBase, s.available), top, bottom, step), s.open, currentBase);
    setShares(fresh);
    save(HEIGHTS_KEY, fresh);
  };
  const splitDefault = () => { setShares(null); save(HEIGHTS_KEY, null); };

  // ── Moving: dragging the header ──
  // Listeners on the window (no pointer capture: the head stays an ordinary button, and a press on it closes open menus like any other,
  // hence no preventDefault on press). The insertion place is computed from the middles of the sections in the DOM, the line stands at
  // the edge there; if the section is already there, there is no line and no movement.
  const headerTransaction = useRef<{ running: boolean; cancel: () => void } | null>(null);
  const afterHeaderTransaction = useRef(false);
  const headerDown = useCallback((e: React.PointerEvent, id: GitSection) => {
    if (e.button !== 0 || headerTransaction.current) return;
    afterHeaderTransaction.current = false;
    const pid = e.pointerId, x0 = e.clientX, y0 = e.clientY;
    let place: number | null = null;
    const ids = () => (box.current ? sectionsIn(box.current).map((s) => s.dataset.gitSection as GitSection) : []);
    const situation = (y: number) => {
      const el = box.current;
      if (!el) return;
      const rects = sectionsIn(el).map((s) => s.getBoundingClientRect());
      const k = insertPlace(rects.map((r) => (r.top + r.bottom) / 2), y);
      place = targetFromPlace(ids(), id, k) ? k : null;
      if (place == null || rects.length === 0) { setLine(null); return; }
      const edge = place < rects.length ? rects[place].top : rects[rects.length - 1].bottom;
      setLine(Math.max(1, Math.min(el.clientHeight - 1, Math.round(edge - el.getBoundingClientRect().top))));
    };
    const z = { running: false, cancel: () => {} };
    const end = (takeOver: boolean) => {
      z.cancel();
      headerTransaction.current = null;
      if (!z.running) return;
      afterHeaderTransaction.current = true;
      setDragging(null);
      setLine(null);
      dragCursor(null);
      const target = takeOver && place != null ? targetFromPlace(ids(), id, place) : null;
      if (!target) return;
      const fresh = moveInOrder(state.current.order, id, target);
      setOrder(fresh);
      save(ORDER_KEY, fresh);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (!z.running) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < TRANSACTION_THRESHOLD) return;
        z.running = true;
        setDragging(id);
        dragCursor("grabbing");
        window.getSelection()?.removeAllRanges();
      }
      situation(ev.clientY);
    };
    const release = (ev: PointerEvent) => { if (ev.pointerId === pid) end(true); };
    const abort = (ev: PointerEvent) => { if (ev.pointerId === pid) end(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape" && z.running) { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("keydown", onKey, true);
    z.cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("keydown", onKey, true);
    };
    headerTransaction.current = z;
  }, []);
  useEffect(() => () => {
    const ran = Boolean(turn.current) || Boolean(headerTransaction.current?.running);
    headerTransaction.current?.cancel();
    if (ran) dragCursor(null);
  }, []);
  // The click after a drag (it follows the pointerup on the same button) does not fold; a keyboard click (`detail` 0) always does.
  const afterTransactionClick = useCallback((e: React.MouseEvent) => {
    if (!afterHeaderTransaction.current || e.detail === 0) return false;
    afterHeaderTransaction.current = false;
    return true;
  }, []);
  const shift = useCallback((id: GitSection, direction: -1 | 1) => {
    const target = targetStep(state.current.visible, id, direction);
    if (!target) return;
    const fresh = moveInOrder(state.current.order, id, target);
    setOrder(fresh);
    save(ORDER_KEY, fresh);
  }, []);

  const pxKey = px ? open.map((id) => px[id]).join() : "";
  const viewKey = visible.join();
  const context = useMemo<StackContext>(() => ({
    height: (id) => (px ? px[id] ?? null : null),
    dragging,
    turn: dragging !== null || splitDrag !== null,
    headerDown,
    afterDrag: afterTransactionClick,
    can: (id, direction) => targetStep(visible, id, direction) !== null,
    shift,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `px` and `visible` enter through their keys (new objects every render)
  }), [pxKey, viewKey, dragging, splitDrag, headerDown, afterTransactionClick, shift]);

  const title: Record<GitSection, string> = { repos: t("Repositories"), changes: t("Changes"), graph: t("Graph") };
  const columns = column(visible, (id) => !collapsed[id]);
  return (
    <StackK.Provider value={context}>
      <div ref={box} className="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-git-sections
        data-git-order={visible.join(",")} data-git-heights={shares ? "pulled" : "preset"}>
        {visible.map((id, i) => {
          const sp = columns.find((x) => x.after === i);
          const value = (k: GitSection) => px?.[k] ?? measured[k] ?? 0;
          return (
            <Fragment key={id}>
              {content[id]}
              {sp && (
                <SplitHandle
                  top={sp.top} bottom={sp.bottom} drag={splitDrag === i}
                  label={t("Height of “{top}” and “{bottom}”", { top: title[sp.top], bottom: title[sp.bottom] })}
                  title={t("Drag to change the height, double-click to reset")}
                  value={value(sp.top)} max={Math.max(MIN_BODY, value(sp.top) + value(sp.bottom) - MIN_BODY)}
                  onPointerDown={(e) => splitDown(e, i, sp.top, sp.bottom)} onPointerMove={splitMove} onPointerUp={splitUp}
                  onDoubleClick={splitDefault} onKeyDown={(e) => splitKey(e, sp.top, sp.bottom)}
                />
              )}
            </Fragment>
          );
        })}
        {line != null && (
          <div aria-hidden data-git-insert={line} style={{ top: line }}
            className="pointer-events-none absolute inset-x-0 z-20 h-[2px] -translate-y-1/2 rounded-full bg-accent" />
        )}
      </div>
    </StackK.Provider>
  );
}

// The gap between two sections (like VS Code's sash): a shell without height exactly at the hairline of the next section, inside it the
// grab zone (4 px, two above, two below the edge) with `row-resize` and the line (2 px, on the hairline). The line is invisible until the
// pointer rests on it for 300 ms (VS Code: `workbench.sash.hoverDelay`) or it is dragged, then accent; with keyboard focus dimmed.
// `relative z-10`: the grab zone lies OVER the neighbours' edges (they are not positioned).
function SplitHandle({ top, bottom, drag, label, title, value, max, onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onKeyDown }: {
  top: GitSection; bottom: GitSection; drag: boolean; label: string; title: string; value: number; max: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="relative z-10 h-0 shrink-0" data-git-gap={`${top}|${bottom}`}>
      <div
        role="separator" aria-orientation="horizontal" aria-label={label} aria-valuemin={MIN_BODY} aria-valuemax={max} aria-valuenow={value}
        tabIndex={0} title={title} data-drag={drag ? "1" : undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}
        className="group absolute inset-x-0 -top-[2px] h-[4px] cursor-row-resize outline-none"
      >
        <span aria-hidden className={`pointer-events-none absolute inset-x-0 top-[1px] h-[2px] transition-colors ${
          drag ? "bg-accent duration-0" : "bg-transparent duration-150 group-hover:bg-accent group-hover:delay-300 group-focus-visible:bg-accent/60"}`} />
      </div>
    </div>
  );
}

// The "..." of a section head with "Move up"/"Move down" (the way to move without a mouse); `children` come before them (the graph:
// "History ..."). With ONE repo "Changes" carries no menu of its own but the repo's "..." (RepoMenu `section`), like VS Code, where
// the view of a single source keeps its commands and those of the view in ONE menu.
function SectionMenu({ id, title, children }: { id: GitSection; title: string; children?: React.ReactNode }) {
  const t = useT();
  return (
    <Menu label={t("More actions: {name}", { name: title })} width={220} button={{ content: <DotsIcon />, className: MENU_BUTTON.replace("opacity-0 ", ""), data: { "data-git-section-menu": id } }}>
      {children}
      {children && <MenuSeparator />}
      <MoveEntries id={id} />
    </Menu>
  );
}
function MoveEntries({ id }: { id: GitSection }) {
  const t = useT();
  const { can, shift } = useContext(StackK);
  return (
    <>
      <MenuEntry label={t("Move Up")} disabled={!can(id, -1)} onClick={() => shift(id, -1)} data={{ "data-git-to": "top" }} />
      <MenuEntry label={t("Move Down")} disabled={!can(id, 1)} onClick={() => shift(id, 1)} data={{ "data-git-to": "bottom" }} />
    </>
  );
}

// ── Repositories: one row per repo ──────────────────────────────
function RepoRow({ repo, selected, onChoice }: { repo: GitRepo; selected: boolean; onChoice: (addition: boolean) => void }) {
  const t = useT();
  const title = [
    repo.relPath || repo.name,
    repo.lastCommit ? `${repo.lastCommit.hash} · ${repo.lastCommit.subject} · ${repo.lastCommit.relative}` : null,
    t("Click: show only this repository · ⌘/Ctrl-click: add or remove"),
  ].filter(Boolean).join("\n");
  return (
    <div data-git-row-anchor data-git-repo={repoKey(repo)} data-git-selected={selected ? "1" : "0"}
      className={`group flex h-[22px] items-center gap-0.5 rounded-md pr-0.5 transition-colors ${selected ? SELECTED : "hover:bg-hover"}`}>
      <button type="button" onClick={(e) => onChoice(e.metaKey || e.ctrlKey)} aria-pressed={selected} title={title} className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left">
        <span className="shrink-0 text-dim"><RepoIcon /></span>
        <span className="min-w-0 truncate text-[12px]">{repo.name || "/"}</span>
      </button>
      <RepoState repo={repo} />
      <RepoMenu repo={repo} />
    </div>
  );
}

// Branch (icon, name, "*" on changes) and sync button: in the repo row, in the head of a repo under "Changes" and, with ONE repo, in
// the section head. A click on the branch opens the switcher at the row.
function RepoState({ repo }: { repo: GitRepo }) {
  return <><BranchLabel repo={repo} /><SyncButton repo={repo} /></>;
}

function BranchLabel({ repo }: { repo: GitRepo }) {
  const t = useT();
  const { openBranch } = useGit();
  // Without upstream a symbol of its own (the branch is local only); a detached HEAD is no branch and does not get it.
  const local = !repo.upstream && !repo.detached && Boolean(repo.branch);
  const marker = repo.statusError ? "!" : hasChanges(repo) ? "*" : "";
  const title = [
    repo.detached ? t("Detached HEAD") : repo.branch,
    repo.upstream ? `→ ${repo.upstream}` : local ? t("Local only (no upstream)") : null,
    repo.statusError || null,
    t("Click: switch, create, merge, rebase branches"),
  ].filter(Boolean).join("\n");
  return (
    <button type="button" onClick={(e) => openBranch(repo, e.currentTarget.closest("[data-git-row-anchor]"))} title={title}
      className="flex h-[18px] min-w-0 shrink items-center gap-1 rounded px-1 font-mono text-[11px] text-dim transition-colors hover:bg-edge hover:text-fg" data-git-branch={repo.branch ?? ""}>
      <span className="shrink-0">{local ? <BranchLocalIcon /> : <GitBranchIcon size={12} />}</span>
      <span className="min-w-0 truncate">{repo.branch || "—"}</span>
      {marker && <span className={`-ml-0.5 shrink-0 ${marker === "!" ? "text-warn" : ""}`}>{marker}</span>}
    </button>
  );
}

function SyncButton({ repo }: { repo: GitRepo }) {
  const t = useT();
  const { synchronize, performAction } = useGit();
  const [busy, setBusy] = useState(false);
  if (syncSteps(repo).length === 0) return null;
  const publish = !repo.upstream;
  const ahead = repo.ahead ?? 0;
  const behind = repo.behind ?? 0;
  const title = publish ? t("Publish Branch") : t("Sync Changes ({behind}↓ {ahead}↑)", { behind, ahead });
  return (
    <button type="button" disabled={busy} title={title} aria-label={title} data-git-sync={publish ? "publish" : "sync"}
      onClick={async () => { setBusy(true); await performAction(() => synchronize(repo)); setBusy(false); }}
      className="flex h-[18px] shrink-0 items-center gap-0.5 rounded px-1 text-[11px] tabular-nums text-dim transition-colors hover:bg-edge hover:text-fg disabled:opacity-50">
      <span className={busy ? "animate-spin" : ""}>{publish ? <CloudUpIcon /> : <RefreshIcon />}</span>
      {!publish && behind > 0 && <span>{behind}↓</span>}
      {!publish && ahead > 0 && <span>{ahead}↑</span>}
    </button>
  );
}

// The "..." of a repo: the repo actions that used to be buttons on the branch row and the "History" section. With `section` (with ONE
// repo in the head of "Changes") "Move up"/"Move down" of this section stand below (see SectionMenu).
const MENU_BUTTON = "grid h-5 w-5 shrink-0 place-items-center rounded text-dim opacity-0 transition-opacity hover:bg-edge hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:bg-edge aria-expanded:text-fg aria-expanded:opacity-100";
function RepoMenu({ repo, section }: { repo: GitRepo; section?: GitSection }) {
  const t = useT();
  const { act, performAction, openBranch, showHistory } = useGit();
  const here = useRef<HTMLSpanElement>(null);
  const rel = repo.relPath;
  const run = (endpoint: string, body: Record<string, unknown> = {}) => () => { void performAction(() => act(endpoint, { repo: rel, ...body })); };
  const ahead = repo.ahead ?? 0;
  const behind = repo.behind ?? 0;
  const count = (s: string) => <span className="shrink-0 font-mono text-[11px] tabular-nums text-dim">{s}</span>;
  return (
    <span ref={here} className="contents">
      <Menu label={t("More actions: {name}", { name: repo.name || "/" })} width={240} button={{ content: <DotsIcon />, className: MENU_BUTTON, data: { "data-git-repo-menu": repoKey(repo) } }}>
        <MenuEntry label={t("Switch branch…")} hint={t("Switch, create, merge, rebase")} onClick={() => openBranch(repo, here.current?.closest("[data-git-row-anchor]") ?? null)} />
        <MenuSeparator />
        <MenuEntry label="Pull" right={behind > 0 ? count(`${behind}↓`) : undefined} disabled={!repo.remote} onClick={run("pull")} />
        <MenuEntry label="Push" right={ahead > 0 ? count(`${ahead}↑`) : undefined} hint={repo.remote && !repo.upstream ? t("Sets the upstream (publishes the branch)") : undefined} disabled={!canPush(repo)} onClick={run("push")} />
        <MenuEntry label="Fetch" disabled={!repo.remote} onClick={run("fetch")} />
        <MenuSeparator />
        <MenuEntry label={t("Stash changes")} hint={t("Including new files")} disabled={!hasChanges(repo)} onClick={run("stash", { includeUntracked: true })} />
        <MenuEntry label={t("History…")} hint={t("A hundred commits, with cherry-pick")} onClick={() => showHistory(repo)} />
        {conflictsOf(repo).length > 0 && <MenuEntry danger label={t("Abort merge")} onClick={run("merge-abort")} />}
        {repo.remote?.webUrl && (
          <>
            <MenuSeparator />
            <MenuEntry label={t("Open in browser")} right={count(repo.remote.projectPath || repo.remote.host)} onClick={() => { window.open(repo.remote!.webUrl, "_blank", "noopener,noreferrer"); }} />
          </>
        )}
        {section && <><MenuSeparator /><MoveEntries id={section} /></>}
      </Menu>
    </span>
  );
}

// Check mark in the head: the same path as the commit field's primary button (registered there); if the field is not there (repo collapsed), it expands.
function CommitHeaderAction({ repo, open }: { repo: GitRepo; open?: () => void }) {
  const t = useT();
  const { control, draft } = useGit();
  return (
    <HeaderAction title={t("Commit")} onRun={async () => {
      const s = control.get(draft(repo));
      if (s) s.main();
      else open?.();
    }}><CheckIcon /></HeaderAction>
  );
}

// An icon button in the head (20 px): stopPropagation (otherwise the head folds too), errors go to the bar's error line.
function HeaderAction({ title, onRun, disabled, children }: { title: string; onRun: () => Promise<unknown>; disabled?: boolean; children: React.ReactNode }) {
  const { performAction } = useGit();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" title={title} aria-label={title} disabled={busy || disabled}
      onClick={async (e) => { e.stopPropagation(); setBusy(true); await performAction(onRun); setBusy(false); }}
      className="grid h-5 w-5 shrink-0 place-items-center rounded text-dim transition-colors hover:bg-edge hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-dim">
      {busy ? <span className="text-[10px]">…</span> : children}
    </button>
  );
}

// ── Changes: head + body per repo ───────────────────────────
// The expanded body hangs on a vertical line under the head's chevron, the indentation guide of the VS Code tree: always there in the
// hairline colour, stronger while pointer or focus is in the repo (there: the "active" guide), so the section a repo owns is easier to assign.
function RepoChanges({ repo, open, onToggle, onDiff }: {
  repo: GitRepo; open: boolean; onToggle: () => void; onDiff: ShowDiff;
}) {
  const t = useT();
  const { refresh } = useGit();
  const n = repo.counts?.total ?? 0;
  return (
    <div className="group/repo" data-git-repo-changes={repoKey(repo)}>
      <div data-git-row-anchor className="group flex h-[22px] items-center gap-0.5 rounded-md pr-0.5 transition-colors hover:bg-hover">
        <button type="button" onClick={onToggle} aria-expanded={open} title={repo.relPath || repo.name} className="flex h-full min-w-0 flex-1 items-center gap-1 pl-0.5 text-left">
          <span className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}><ChevronRightIcon size={12} /></span>
          <span className="shrink-0 text-dim"><RepoIcon /></span>
          <span className="min-w-0 truncate text-[12px] font-medium">{repo.name || "/"}</span>
          {!open && n > 0 && <Counter n={n} />}
        </button>
        <RepoState repo={repo} />
        <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
          <CommitHeaderAction repo={repo} open={open ? undefined : onToggle} />
          <HeaderAction title={t("Refresh")} onRun={refresh}><ReloadIcon /></HeaderAction>
        </span>
        <RepoMenu repo={repo} />
      </div>
      {open && <RepoBody repo={repo} indented onDiff={onDiff} />}
    </div>
  );
}

function RepoBody({ repo, indented, onDiff }: {
  repo: GitRepo; indented: boolean; onDiff: ShowDiff;
}) {
  const t = useT();
  const { path, act } = useGit();
  const staged = stagedOf(repo);
  const unstaged = unstagedOf(repo);
  const conflicts = conflictsOf(repo);
  const rel = repo.relPath;
  const [stashes, setStashes] = useState<GitStashList | null>(null);
  const [stashOpen, setStashOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<{ path: string; branch: string; head: string }[] | null>(null);
  const [wtOpen, setWtOpen] = useState(false);
  const [submodules, setSubmodules] = useState<{ path: string; sha: string; state: string; describe: string }[] | null>(null);
  const [smOpen, setSmOpen] = useState(false);
  const ask = usePrompt();

  // Stashes are always loaded (the counter shows on the collapsed section too), the other sections only on opening. The history is shown
  // by the "Graph" section.
  const loadStashes = useCallback(() => {
    api<GitStashList>(path(`/git/stashes?repo=${encodeURIComponent(rel)}`)).then(setStashes).catch(() => setStashes({ stashes: [] }));
  }, [path, rel]);
  useEffect(() => { loadStashes(); }, [loadStashes, repo.lastCommit?.hash, repo.counts?.total]);
  const stashCount = stashes?.stashes.length ?? 0;
  const loadWorktrees = useCallback(() => {
    api<{ worktrees: { path: string; branch: string; head: string }[] }>(path(`/git/worktrees?repo=${encodeURIComponent(rel)}`)).then((r) => setWorktrees(r.worktrees)).catch(() => setWorktrees([]));
  }, [path, rel]);
  const loadSubmodules = useCallback(() => {
    api<{ submodules: { path: string; sha: string; state: string; describe: string }[] }>(path(`/git/submodules?repo=${encodeURIComponent(rel)}`)).then((r) => setSubmodules(r.submodules)).catch(() => setSubmodules([]));
  }, [path, rel]);
  useEffect(() => { if (wtOpen && !worktrees) loadWorktrees(); }, [wtOpen, worktrees, loadWorktrees]);
  useEffect(() => { if (smOpen && !submodules) loadSubmodules(); }, [smOpen, submodules, loadSubmodules]);

  const allClean = staged.length === 0 && unstaged.length === 0 && conflicts.length === 0;

  return (
    // Indented: 7 px + 1 px line + 8 px = the same 16 px as before (`pl-4`); the line stands centred under the head's chevron
    // (button `pl-0.5` + half the 12 px icon = 8 px).
    <div className={`flex flex-col gap-0.5 ${indented
      ? "ml-[7px] border-l border-edge pb-2 pl-2 pt-0.5 transition-colors group-focus-within/repo:border-dim/50 group-hover/repo:border-dim/50"
      : "pb-1 pl-1 pt-1"}`}>
      <CommitArea repo={repo} act={act} stagedCount={staged.length} />

      {/* Conflicts are a group like the others (VS Code: "Merge Changes"), not a red field: the files carry their "!", and below them
      ONE button to abort. */}
      {conflicts.length > 0 && (
        <Group title="Merge Changes" count={conflicts.length} actions={<IconAct title={t("Mark all as resolved (stage)")} onRun={() => act("stage", { repo: rel, files: conflicts.map((c) => c.path) })}><CheckIcon /></IconAct>}>
          {conflicts.map((c) => <FileRow key={"c:" + c.path} change={c} onOpen={(fixed) => onDiff({ kind: "change", repo: rel, file: c.path, staged: false }, { fixed })} actions={<IconAct title={t("Mark as resolved (stage)")} onRun={() => act("stage", { repo: rel, files: [c.path] })}><CheckIcon /></IconAct>} />)}
          <ActionButton title={t("Abort merge/rebase")} onRun={() => act("merge-abort", { repo: rel })} className="mt-0.5 w-full justify-center text-danger hover:bg-danger/10">{t("Abort merge")}</ActionButton>
        </Group>
      )}

      {staged.length > 0 && (
        <Group title="Staged Changes" count={staged.length} actions={<IconAct title={t("Unstage all")} onRun={() => act("unstage", { repo: rel, all: true })}><MinusIcon /></IconAct>}>
          {staged.map((c) => <FileRow key={"s:" + c.path} change={c} onOpen={(fixed) => onDiff({ kind: "change", repo: rel, file: c.path, staged: true }, { fixed })} actions={<IconAct title={t("Unstage")} onRun={() => act("unstage", { repo: rel, files: [c.path] })}><MinusIcon /></IconAct>} />)}
        </Group>
      )}

      {/* "Changes" also carries the untracked files (U); there is no group "Untracked" of its own. Empty only if EVERYTHING is clean;
      then it stays as an empty line. */}
      {(unstaged.length > 0 || allClean) && (
        <Group title="Changes" count={unstaged.length || undefined} actions={unstaged.length > 0 ? (
          <>
            <IconAct title={t("Discard all changes")} danger confirm={t("Discard all {n} changes? Untracked files will be deleted. This cannot be undone.", { n: unstaged.length })} onRun={() => act("discard", { repo: rel, all: true })}><DiscardIcon /></IconAct>
            <IconAct title={t("Stage all")} onRun={() => act("stage", { repo: rel, all: true })}><PlusIcon /></IconAct>
          </>
        ) : undefined}>
          {unstaged.length === 0
            ? <BlankLine>{repo.statusError || t("Working tree clean")}</BlankLine>
            : unstaged.map((c) => <FileRow key={"u:" + c.path} change={c} onOpen={(fixed) => onDiff({ kind: "change", repo: rel, file: c.path, staged: false }, { fixed })} actions={<>
                <IconAct title={t("Discard changes")} danger confirm={t("Discard \"{name}\"? This cannot be undone.", { name: base(c.path) })} onRun={() => act("discard", { repo: rel, file: c.path, untracked: c.kind === "untracked" })}><DiscardIcon /></IconAct>
                <IconAct title={t("Stage")} onRun={() => act("stage", { repo: rel, files: [c.path] })}><PlusIcon /></IconAct>
              </>} />)}
        </Group>
      )}

      {/* Stash, worktrees, submodules: the same row form as the groups, closed and quiet by default (VS Code does not have them here; they
      should not stand as loud as the changes). "Stashes" only if there are any; creating one is in the repo's "..." ("Stash changes"). */}
      <div className="mt-1 flex flex-col border-t border-edge pt-1">
        {stashCount > 0 && <Group title="Stashes" silent count={stashCount} open={stashOpen} onToggle={() => setStashOpen((v) => !v)} actions={<IconAct title={t("Stash current changes (incl. new files)")} onRun={async () => { await act("stash", { repo: rel, includeUntracked: true }); loadStashes(); }}><PlusIcon /></IconAct>}>
          {stashes?.stashes.map((s) => (
            <div key={s.ref} className="group flex h-[22px] items-center gap-1.5 rounded-md pl-[22px] pr-1 transition-colors hover:bg-hover">
              <button type="button" onClick={() => onDiff({ kind: "stash", repo: rel, ref: s.ref }, { title: s.message || undefined })} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={s.message} data-git-stash={s.ref}>
                <span className="shrink-0 font-mono text-[11px] text-dim">{s.ref}</span><span className="min-w-0 flex-1 truncate text-[12px]">{s.message}</span>
              </button>
              <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
                <IconAct title={t("Apply (pop)")} onRun={async () => { await act("stash/op", { repo: rel, op: "pop", ref: s.ref }); loadStashes(); }}><DownIcon /></IconAct>
                <IconAct title={t("Discard (drop)")} danger confirm={t("Discard stash {ref}?", { ref: s.ref })} onRun={async () => { await act("stash/op", { repo: rel, op: "drop", ref: s.ref }); loadStashes(); }}><TrashIcon /></IconAct>
              </span>
            </div>
          ))}
        </Group>}

        <Group title="Worktrees" silent open={wtOpen} onToggle={() => setWtOpen((v) => !v)} actions={<IconAct title={t("Add worktree")} onRun={async () => {
          const p = await ask(t("Path of the new worktree:"), ""); if (!p || !p.trim()) return;
          const b = await ask(t("Branch (empty = new branch from HEAD):"), "");
          try { await api(path("/git/worktree"), { method: "POST", body: JSON.stringify({ repo: rel, path: p.trim(), branch: b?.trim() || undefined, newBranch: b?.trim() ? undefined : `wt-${Date.now()}` }) }); loadWorktrees(); } catch (e) { alert(t("Error: {msg}", { msg: (e as Error).message })); }
        }}><PlusIcon /></IconAct>}>
          {!worktrees && <BlankLine>{t("Loading…##inline")}</BlankLine>}
          {worktrees?.map((w) => (
            <div key={w.path} className="group flex h-[22px] items-center gap-1.5 rounded-md pl-[22px] pr-1 transition-colors hover:bg-hover">
              <span className="min-w-0 flex-1 truncate text-[12px]" title={w.path}><span className="font-mono text-[11px] text-accent">{w.branch}</span> <span className="text-[11px] text-dim">{w.path.split("/").pop()}</span></span>
              <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
                <IconAct title={t("Remove worktree")} danger confirm={t("Remove worktree \"{path}\"?", { path: w.path })} onRun={async () => { await api(path("/git/worktree"), { method: "DELETE", body: JSON.stringify({ repo: rel, path: w.path }) }); loadWorktrees(); }}><TrashIcon /></IconAct>
              </span>
            </div>
          ))}
        </Group>

        <Group title={t("Submodules")} silent open={smOpen} onToggle={() => setSmOpen((v) => !v)} actions={<IconAct title={t("Update submodules (init --recursive)")} onRun={async () => { await api(path("/git/submodule/update"), { method: "POST", body: JSON.stringify({ repo: rel }) }); loadSubmodules(); }}><RefreshIcon /></IconAct>}>
          {!submodules && <BlankLine>{t("Loading…##inline")}</BlankLine>}
          {submodules && submodules.length === 0 && <BlankLine>{t("No submodules.")}</BlankLine>}
          {submodules?.map((s) => (
            <div key={s.path} className="flex h-[22px] items-center gap-1.5 rounded-md pl-[22px] pr-1" title={s.describe}>
              <span className={`shrink-0 font-mono text-[11px] ${s.state === "ok" ? "text-ok" : s.state === "uninitialized" ? "text-dim" : "text-warn"}`}>{s.sha}</span>
              <span className="min-w-0 flex-1 truncate text-[12px]">{s.path}</span>
              <span className="shrink-0 text-[11px] text-dim">{s.state}</span>
            </div>
          ))}
        </Group>
      </div>
    </div>
  );
}

type CommitKind = "commit" | "push" | "all" | "amend";

// Commit field and primary button like VS Code: ONE field (grows up to ten rows), Cmd/Ctrl+Enter commits; the placeholder names the branch.
// Below it the wide button, whose kind lib/git-bar.ts `primaryButton` computes: "Commit" (takes the staged changes; if none are
// staged, all: smart commit, the tooltip says so), with nothing to commit "Publish branch" (without upstream) or
// "Sync down m up n", otherwise greyed out. Separated on the right the menu: commit & push, commit all, amend; it stays reachable in
// every kind (amend changes the message even without changes).
function CommitArea({ repo, act, stagedCount }: { repo: GitRepo; act: Act; stagedCount: number }) {
  const t = useT();
  const mac = useMac();
  const { draft, control, synchronize } = useGit();
  const ek = draft(repo);
  const [msg, setMsgRaw] = useState(() => DRAFTS.get(ek) ?? "");
  const setMsg = (v: string) => { setMsgRaw(v); if (v) DRAFTS.set(ek, v); else DRAFTS.delete(ek); };
  const [busy, setBusy] = useState<CommitKind | "sync" | "">("");
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const smartAll = stagedCount === 0;
  const text = msg.trim();
  const p = primaryButton(repo);

  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    // scrollHeight does not count the hairline (border-box); without it even the first row would scroll.
    el.style.height = `${Math.min(el.scrollHeight + (el.offsetHeight - el.clientHeight), COMMIT_MAX)}px`;
  }
  // A restored draft with several rows stands at its height right away.
  useLayoutEffect(() => { if (field.current && field.current.value) grow(field.current); }, []);
  async function commit(kind: CommitKind) {
    if (busy) return;
    if (kind !== "amend" && !text) return;
    setBusy(kind); setError("");
    try {
      // Amend takes ONLY staged changes, never the main button's smart-commit fallback: on a dirty tree without staging that folded the
      // whole tree into HEAD although the user only wanted to change the message (back only via the reflog). Without a message the last
      // commit keeps its own (server: --no-edit); without staged changes it is a pure message change.
      const all = kind === "all" || (kind !== "amend" && smartAll);
      await act("commit", { repo: repo.relPath, message: text, push: kind === "push", all, amend: kind === "amend" });
      setMsg("");
      if (field.current) field.current.style.height = "auto";
    } catch (e) { setError(String((e as Error).message)); } finally { setBusy(""); }
  }
  const main = () => {
    if (p.kind !== "commit") { setError(t("Nothing to commit.")); return; }
    if (!text) { setError(t("Please enter a commit message.")); field.current?.focus(); return; }
    void commit(smartAll ? "all" : "commit");
  };
  async function sync() {
    if (busy) return;
    setBusy("sync"); setError("");
    try { await synchronize(repo); } catch (e) { setError(String((e as Error).message)); } finally { setBusy(""); }
  }
  const primary = () => { if (p.kind === "publish" || p.kind === "synchronize") void sync(); else main(); };
  // The check mark in the head takes the same path, registered through a ref so the registration does not change on every keystroke.
  const mainRef = useRef(main);
  mainRef.current = main;
  useEffect(() => {
    control.set(ek, { main: () => mainRef.current(), focus: () => field.current?.focus() });
    return () => { control.delete(ek); };
  }, [control, ek]);

  // The amend hint says what moves into HEAD: staged changes (with or without a new message) or only the message. With neither
  // there is nothing to amend and the entry is disabled.
  const amendEmpty = smartAll && !text;
  const amendHint = smartAll
    ? (text ? t("Nothing staged — only replace the last commit's message") : t("Nothing staged and no message — nothing to amend"))
    : (text ? t("Staged changes into the last commit, with this message") : t("Staged changes into the last commit, keep its message"));
  const branchName = repo.branch && !repo.detached ? repo.branch : "";
  const placeholder = branchName
    ? (mac ? t("Message (⌘⏎ to commit on \"{branch}\")", { branch: branchName }) : t("Message (Ctrl+⏎ to commit on \"{branch}\")", { branch: branchName }))
    : (mac ? t("Message (⌘⏎ to commit)") : t("Message (Ctrl+⏎ to commit)"));
  const active = p.kind !== "off";
  const comesNothing = p.kind !== "commit";
  const content = p.kind === "publish"
    ? <><CloudUpIcon size={13} /><span className="truncate">{t("Publish Branch")}</span></>
    : p.kind === "synchronize"
    ? <><RefreshIcon size={13} /><span className="truncate">{t("Sync Changes")}</span>{p.behind > 0 && <span className="tabular-nums opacity-85">{p.behind}↓</span>}{p.ahead > 0 && <span className="tabular-nums opacity-85">{p.ahead}↑</span>}</>
    : <><CheckIcon size={13} /><span>Commit</span></>;
  const mainTitle = p.kind === "publish" ? t("Nothing to commit — push the branch and set its upstream")
    : p.kind === "synchronize" ? t("Nothing to commit — pull, then push")
    : p.kind === "off" ? t("Nothing to commit")
    : smartAll ? t("Nothing staged — commits all changes") : t("Commit staged changes");
  return (
    <div className="flex flex-col gap-1.5 pb-1 pr-1">
      <textarea
        ref={field}
        value={msg}
        rows={1}
        onChange={(e) => { setMsg(e.target.value); if (error) setError(""); }}
        onInput={(e) => grow(e.currentTarget)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); main(); } }}
        placeholder={placeholder}
        spellCheck={false}
        // The upper limit as a style from COMMIT_MAX, not as a second literal in a class.
        style={{ maxHeight: COMMIT_MAX }}
        className="cb-scroll min-h-[28px] w-full resize-none overflow-y-auto rounded-lg border border-edge bg-panel px-2 py-[3px] text-[12px] leading-5 outline-none transition-colors placeholder:text-dim focus:border-accent/70"
        data-git-commit-field
      />
      <div className="flex h-[26px] w-full">
        <button
          type="button"
          onClick={primary}
          disabled={!active || !!busy}
          title={mainTitle}
          data-git-primary={p.kind}
          // "off" carries its grey itself (bg-hover, text-dim): the global rule `button:disabled` (0,45, unlayered, no utility beats it)
          // would otherwise only dim the left half, and the button would stand two-coloured beside the arrow.
          style={!active && !busy ? { opacity: 1 } : undefined}
          className={`flex h-[26px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-lg px-2.5 text-[12px] font-medium transition-[opacity,background-color] disabled:cursor-default ${active ? "bg-accent text-white hover:opacity-90" : "bg-hover text-dim"} ${busy ? "opacity-70" : ""}`}
        >
          {busy ? "…" : content}
        </button>
        <Menu
          label={t("More commit actions")}
          width={230}
          button={{
            content: (open) => <span className={`transition-transform ${open ? "rotate-180" : ""}`}><CaretDownIcon /></span>,
            className: `grid h-[26px] w-7 shrink-0 place-items-center rounded-r-lg border-l transition-opacity hover:opacity-90 aria-expanded:opacity-80 ${active ? "border-white/25 bg-accent text-white" : "border-edge bg-hover text-dim hover:text-fg"}`,
            data: { "data-git-commit-menu": "" },
          }}
        >
          <MenuEntry label="Commit & Push" hint={t("Commit, then push")} disabled={!text || !!busy || comesNothing} onClick={() => void commit("push")} />
          <MenuEntry label="Commit All" hint={t("Stage everything, then commit")} disabled={!text || !!busy || comesNothing} onClick={() => void commit("all")} />
          <MenuEntry label="Amend" hint={amendHint} disabled={!!busy || amendEmpty} onClick={() => void commit("amend")} />
        </Menu>
      </div>
      {error && <div className="cb-scroll max-h-[64px] overflow-y-auto text-[10.5px] text-danger" role="alert">{error}</div>}
    </div>
  );
}

// Counter badge (round, `edge`, 10 px tabular), like the number behind "Changes" in VS Code.
const Counter = ({ n }: { n: number }) => (
  <span className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-edge px-1 text-[10px] font-semibold tabular-nums text-fg/75">{n}</span>
);
const BlankLine = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-[22px] items-center px-2 text-[12px] text-dim">{children}</div>
);

// A collapsible group (22 px, VS Code: "Staged Changes", "Changes"): chevron, title, on the right the actions only on hover (and on focus,
// otherwise they would be unreachable by keyboard), at the far right the count badge. Without `open`/`onToggle` it keeps its state
// itself (default open); stashes, worktrees, submodules keep it outside because they load on opening, and are `quiet` (title dimmed).
function Group({ title, count, actions, open: openProp, onToggle, openDefault = true, silent = false, children }: {
  title: string; count?: number; actions?: React.ReactNode;
  open?: boolean; onToggle?: () => void; openDefault?: boolean; silent?: boolean;
  children: React.ReactNode;
}) {
  const [own, setOwn] = useState(openDefault);
  const open = openProp ?? own;
  const toggle = onToggle ?? (() => setOwn((v) => !v));
  return (
    <div>
      {/* The row is a div with ONE button that reaches to the actions: no button around buttons (nested controls are not valid HTML,
      and a click on an action would otherwise fold the group too). */}
      <div className="group flex h-[22px] items-center gap-1 rounded-md pr-1 transition-colors hover:bg-hover">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-1 pl-0.5 text-left">
          <span className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}><ChevronRightIcon size={12} /></span>
          <span className={`truncate text-[12px] ${silent ? "text-dim" : "font-medium text-fg/85"}`}>{title}</span>
        </button>
        {actions && <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">{actions}</span>}
        {count != null && <Counter n={count} />}
      </div>
      {open && children}
    </div>
  );
}

// File row 22 px, indented under the group's title: name (mono 12 px), behind it the path dimmed, actions on hover, on the right the
// status letter. Click = diff.
// `onOpen(fixed)`: a click opens the diff (in the chat as a preview tab), a double click fixed, like VS Code's source control.
function FileRow({ change, onOpen, actions }: { change: GitChange; onOpen: (fixed: boolean) => void; actions: React.ReactNode }) {
  const t = useT();
  const color = KIND_COLOR[change.kind] ?? "text-dim";
  const path = dir(change.path);
  // `git status` shows an untracked folder (often an embedded repository) as ONE entry ending in "/": there is no diff to open.
  const folder = isFolderEntry(change.path);
  return (
    <div onClick={folder ? undefined : () => onOpen(false)} onDoubleClick={folder ? undefined : () => onOpen(true)} title={folder ? t("{path} is a folder (untracked, or an embedded repository) — Git shows it as one entry and has no diff for it.", { path: change.path }) : t("{label}: {path} — click for diff", { label: t(change.label), path: change.path })} className={`group flex h-[22px] ${folder ? "cursor-default" : "cursor-pointer"} items-center gap-1.5 rounded-md pl-[22px] pr-1 transition-colors hover:bg-hover`} data-git-change={change.path}>
      <span className={`min-w-0 truncate font-mono text-[12px] ${change.kind === "deleted" ? "text-dim line-through" : ""}`}>{base(change.path)}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={change.path}>{path}</span>
      <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex" onClick={(e) => e.stopPropagation()}>{actions}</span>
      <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${color}`}>{KIND_LETTER[change.kind] ?? change.code}</span>
    </div>
  );
}

// ── Graph ─────────────────────────────────────────────────────────────────────
// The graph over all branches like VS Code (lanes, forks, merge curves, ref badges): the list is components/git-bar/GitGraph.tsx
// (loading, computation lib/git-graph.ts), here only the section with its head. Which repo: the choice in the head (with several),
// otherwise the first that "Changes" shows (lib/git-bar.ts `graphRepo`); beside it the scope choice "All" / "Current branch"
// (VS Code: "Auto"), remembered in localStorage. Loaded only while the section is open, no timer of its own.
function GraphSection({ repos, shown, choice, onChoice, onDiff }: {
  repos: GitRepo[]; shown: GitRepo[]; choice: string | null; onChoice: (k: string) => void; onDiff: ShowDiff;
}) {
  const t = useT();
  const { path, act, refresh, showHistory } = useGit();
  const { turn } = useContext(StackK); // no hover card in the graph during a drag
  const [fresh, setNew] = useState(0);
  const [extent, setExtent] = useGraphExtent();
  const k = graphRepo(repos.map(repoKey), choice, shown.map(repoKey), repos.filter((r) => r.remote).map(repoKey));
  const repo = repos.find((r) => repoKey(r) === k) ?? null;
  if (!repo || !k) return null;
  const rel = repo.relPath;
  const repoChoice = repos.length > 1 ? (
    <Menu label={t("Graph repository: {name}", { name: repo.name || "/" })} width={240} alignment="left" shrinks
      button={{
        content: <span className="block min-w-0 truncate">{repo.name || "/"}</span>,
        className: "flex h-[18px] min-w-0 max-w-full items-center rounded px-1 text-[11px] text-fg/80 underline decoration-dim/60 underline-offset-[3px] transition-colors hover:bg-edge hover:text-fg aria-expanded:bg-edge",
        data: { "data-git-graph-repo": k },
      }}>
      {repos.map((r) => (
        <MenuEntry key={repoKey(r)} label={r.name || "/"} right={<span className="shrink-0 font-mono text-[11px] text-dim">{r.branch || "—"}</span>} selected={repoKey(r) === k} onClick={() => onChoice(repoKey(r))} />
      ))}
    </Menu>
  ) : <span className="min-w-0 truncate px-1 text-[11px] text-dim" title={repo.relPath || repo.name}>{repo.name || "/"}</span>;
  const header = <span className="flex min-w-0 items-center gap-0.5">{repoChoice}<GraphExtentChoice extent={extent} onChoice={setExtent} /></span>;
  const actions = (
    <>
      <HeaderAction title={t("Fetch (update remote)")} disabled={!repo.remote} onRun={() => act("fetch", { repo: rel })}><CloudDownIcon /></HeaderAction>
      <HeaderAction title={(repo.behind ?? 0) > 0 ? t("Pull ({behind} behind)", { behind: repo.behind! }) : "Pull"} disabled={!repo.remote} onRun={() => act("pull", { repo: rel })}><DownIcon /></HeaderAction>
      <HeaderAction title={repo.upstream ? t("Push") : t("Push (set upstream)")} disabled={!canPush(repo)} onRun={() => act("push", { repo: rel })}><UpIcon /></HeaderAction>
      <HeaderAction title={t("Refresh")} onRun={async () => { setNew((n) => n + 1); await refresh(); }}><ReloadIcon /></HeaderAction>
      <SectionMenu id="graph" title={t("Graph")}>
        <MenuEntry label={t("History…")} hint={t("A hundred commits, with cherry-pick")} onClick={() => showHistory(repo)} />
      </SectionMenu>
    </>
  );
  return (
    <Section id="graph" title={t("Graph")} role="graph" header={header} actions={actions} data={{ "data-git-graph": k }}>
      <GitGraph key={`${k}\u0000${extent}`} repo={repo} extent={extent} fresh={fresh} path={path} onDiff={onDiff} turn={turn} />
    </Section>
  );
}

// ── Branch switcher (+ merge/rebase per branch) ────────────────────────────
// A sheet on the body (portal), anchored to the row that opens it (repo row, head of a repo, head of the section): the bar consists of
// scrolling sections, and an `absolute` sheet inside would cut off their edge. Position like the kit menu (CbKit `Menu`): below the row,
// as wide as it (at least 260 px), kept inside the window, upward if there is no room below. Closing: Escape, a pointer press outside
// (document listener, no `fixed inset-0` catcher: layout containment of a `@container` made it the reference frame), scrolling an
// ancestor of the row, window size.
function BranchSwitcher({ repo, path, act, anchor, onClose }: { repo: GitRepo; path: Path; act: Act; anchor: Element; onClose: () => void }) {
  const t = useT();
  const flat = useFlat();
  const sheet = useRef<HTMLDivElement>(null);
  const [situation, setSituation] = useState<React.CSSProperties | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(window.innerWidth - 2 * margin, Math.max(260, Math.round(r.width)));
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
    const height = sheet.current?.getBoundingClientRect().height ?? 320;
    const upward = r.bottom + 4 + height > window.innerHeight - margin && r.top - 4 - height > margin;
    setSituation(upward ? { left, width: width, bottom: window.innerHeight - r.top + 4 } : { left, width: width, top: r.bottom + 4 });
  }, [anchor, branches]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const beside = (e: MouseEvent) => {
      const el = e.target as Node | null;
      if (el && (sheet.current?.contains(el) || anchor.contains(el))) return;
      onClose();
    };
    const scrolled = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      if (sheet.current?.contains(el)) return;
      if (el.contains(anchor)) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", beside);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", beside);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);
  useEffect(() => {
    api<GitBranches>(path(`/git/branches?repo=${encodeURIComponent(repo.relPath)}`)).then(setBranches).catch((e) => setError(String((e as Error).message)));
  }, [path, repo.relPath]);

  async function run(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); onClose(); } catch (e) { setError(String((e as Error).message)); } finally { setBusy(false); } }
  const checkout = (branch: string, create = false) => run(() => act("checkout", { repo: repo.relPath, branch, create }));
  const merge = (branch: string) => run(() => act("merge", { repo: repo.relPath, branch }));
  const rebase = (branch: string) => run(() => act("rebase", { repo: repo.relPath, branch }));
  const locals = (branches?.locals ?? []).filter((b) => b.toLowerCase().includes(filter.toLowerCase()));
  const remotes = (branches?.remotes ?? []).filter((b) => b.toLowerCase().includes(filter.toLowerCase()));

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={sheet} role="dialog" aria-label={t("Switch branch / merge / rebase")} data-git-branch-choice={repoKey(repo)}
      style={situation ?? { top: 0, left: 0, visibility: "hidden" }}
      className={`cb-pop cb-pop-in-fast cb-kit fixed z-50 origin-top rounded-xl p-1.5 text-fg${flat}`}>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus placeholder={t("Filter branches…")} className="mb-0.5 w-full rounded-lg bg-bg px-2.5 py-1.5 text-[12px] outline-none placeholder:text-dim focus:ring-1 focus:ring-accent/50" />
      <div className="cb-scroll max-h-[220px] overflow-y-auto">
        {!branches && !error && <div className="px-2.5 py-1.5 text-[11px] text-dim">{t("Loading…##inline")}</div>}
        {/* The rows in the form of the menu row (CbKit `menuRow`): rounded, indented, 2 px gap. The local row is a div with buttons inside;
        only these are clicked, hence no pointer hand at the row's edge. */}
        {locals.length > 0 && <div className={menuHeader}>{t("Local")}</div>}
        {locals.map((b) => (
          <div key={b} className={`group ${menuRow} cursor-default!`}>
            <button onClick={() => checkout(b)} disabled={busy} className="flex min-w-0 flex-1 items-center gap-1.5 text-left"><span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{b}</span>{b === branches?.current && <span className="shrink-0 text-accent"><CheckIcon /></span>}</button>
            {b !== branches?.current && <span className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
              <IconAct title={t("Merge \"{branch}\" into current branch", { branch: b })} onRun={() => merge(b)}><MergeIcon /></IconAct>
              <IconAct title={t("Rebase onto \"{branch}\"", { branch: b })} onRun={() => rebase(b)}><RebaseIcon /></IconAct>
            </span>}
          </div>
        ))}
        {remotes.length > 0 && <div className={menuHeader}>Remote</div>}
        {remotes.map((r) => <button key={r} onClick={() => checkout(r.replace(/^[^/]+\//, ""))} disabled={busy} title={t("Check out from {remote}", { remote: r })} className={menuRow}><span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-dim">{r}</span></button>)}
      </div>
      <div className="mt-0.5 border-t border-edge pt-1">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) checkout(newName.trim(), true); }} placeholder={t("New branch… (Enter creates)")} className="w-full rounded-lg bg-bg px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-dim" />
      </div>
      {error && <div className="cb-scroll mt-1 max-h-[60px] overflow-y-auto px-1 text-[10.5px] text-danger">{error}</div>}
    </div>,
    document.body,
  );
}

// ── Diff modal (with hunk staging) ──────────────────────────
// The patch computation (`parseDiff`, a block's patch `hunkPatch`) lives in lib/diff-tab.ts; the diff tab of the code tabs in the chat
// stages its blocks with the same one (web/test/diff-tab.test.mjs asserts there is no second one here).
function DiffLine({ ln }: { ln: string }) {
  let cls = "text-fg";
  if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ") || ln.startsWith("index ") || ln.startsWith("new file") || ln.startsWith("deleted file") || ln.startsWith("rename ")) cls = "text-dim";
  else if (ln.startsWith("@@")) cls = "bg-accent-soft text-accent";
  else if (ln.startsWith("+")) cls = "bg-ok/10 text-ok";
  else if (ln.startsWith("-")) cls = "bg-danger/10 text-danger";
  return <div className={`whitespace-pre px-4 ${cls}`}>{ln || " "}</div>;
}
// Exported for the git overview (components/projects/git/GitViewDetail.tsx, diff of a file `<main>...<branch>`): there without `hunk`
// and without `act`, read-only, no hunk staging.
export function DiffModal({ title, badge, diff, error, hunk, act, onClose }: { title: string; badge: string; diff?: string; error?: string; hunk?: { repoRel: string; staged: boolean }; act?: Act; onClose: () => void }) {
  const t = useT();
  const [split, setSplit] = useState(false);
  const parsed = useMemo(() => (diff ? parseDiff(diff) : null), [diff]);
  async function applyHunk(hunkText: string) {
    if (!parsed || !hunk || !act) return;
    const patch = hunkPatch(parsed.header, hunkText);
    try { await act("apply", { repo: hunk.repoRel, patch, reverse: hunk.staged }); onClose(); }
    catch (e) { alert(t("Hunk could not be applied: {msg}", { msg: (e as Error).message })); }
  }
  // Glass sheet from the kit; the diff itself stays monospace: the content IS code.
  return (
    <Modal onClose={onClose} width={1080} z="z-[60]" className="p-0" label={title}>
      <div className="flex h-[80vh] max-h-full min-h-0 flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
          <span className="text-dim"><DiffIcon /></span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium" title={title}>{title}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge === "staged" ? "bg-ok text-white" : "bg-bg text-dim"}`}>{badge}</span>
          {parsed && parsed.hunks.length > 0 && (
            <button onClick={() => setSplit((v) => !v)} title={t("Switch view")} className={ghostSm}>{split ? "Inline" : t("Side by side")}</button>
          )}
          <button onClick={onClose} title={t("Close")} aria-label={t("Close")} className="grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"><CloseIcon /></button>
        </header>
        <div className="cb-scroll min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-[1.5]">
          {error && <div className="px-4 py-2 text-danger">{error}</div>}
          {diff === undefined && !error && <div className="px-4 py-2 text-dim">{t("Loading…##inline")}</div>}
          {diff !== undefined && diff.trim() === "" && !error && <div className="px-4 py-2 text-dim">{t("No text differences.")}</div>}
          {parsed && parsed.hunks.length > 0 ? (
            <>
              {parsed.header.split("\n").map((ln, i) => <DiffLine key={"h" + i} ln={ln} />)}
              {parsed.hunks.map((h, i) => (
                <div key={i} className="border-t border-edge/60">
                  {hunk && act && (
                    <div className="flex justify-end px-3 py-1">
                      <button onClick={() => applyHunk(h)} className={ghostSm}>{hunk.staged ? t("Unstage hunk") : t("Stage hunk")}</button>
                    </div>
                  )}
                  {split ? <SplitHunk hunk={h} /> : h.split("\n").map((ln, j) => <DiffLine key={j} ln={ln} />)}
                </div>
              ))}
            </>
          ) : (
            parsed && diff !== undefined && diff.split("\n").map((ln, i) => <DiffLine key={i} ln={ln} />)
          )}
        </div>
      </div>
    </Modal>
  );
}

// A hunk as two columns (old | new).
function SplitHunk({ hunk }: { hunk: string }) {
  const lines = hunk.split("\n");
  const left: string[] = [], right: string[] = [];
  for (const ln of lines) {
    if (ln.startsWith("@@")) { left.push(ln); right.push(ln); }
    else if (ln.startsWith("-")) left.push(ln);
    else if (ln.startsWith("+")) right.push(ln);
    else { left.push(ln); right.push(ln); }
  }
  return (
    <div className="grid grid-cols-2 divide-x divide-edge/60">
      <div>{left.map((ln, i) => <DiffLine key={i} ln={ln} />)}</div>
      <div>{right.map((ln, i) => <DiffLine key={i} ln={ln} />)}</div>
    </div>
  );
}

// ── History-Modal ────────────────────────────────────────────────────────────
function HistoryModal({ repo, path, act, onClose, onShow }: { repo: GitRepo; path: Path; act: Act; onClose: () => void; onShow: (hash: string, subject: string) => void }) {
  const t = useT();
  const [log, setLog] = useState<GitLog | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<GitLog>(path("/git/log"), { method: "POST", body: JSON.stringify({ repo: repo.relPath, limit: 100 }) }).then(setLog).catch((e) => setError(String((e as Error).message))); }, [path, repo.relPath]);
  return (
    <Modal onClose={onClose} width={760} z="z-[60]" className="p-0" label={t("History")}>
      <div className="flex h-[80vh] max-h-full min-h-0 flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
          <span className="text-dim"><HistoryIcon /></span>
          <span className="flex-1 text-[13px] font-semibold tracking-tight">{t("History")} · {repo.name}</span>
          <button onClick={onClose} title={t("Close")} aria-label={t("Close")} className="grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"><CloseIcon /></button>
        </header>
        <div className="cb-scroll min-h-0 flex-1 overflow-auto">
          {error && <div className="p-4 text-[13px] text-danger">{error}</div>}
          {!log && !error && <div className="p-4 text-[13px] text-dim">{t("Loading…##inline")}</div>}
          {log?.commits.map((c) => (
            <div key={c.hash} className="group flex w-full items-center gap-3 border-b border-edge px-4 py-2 transition-colors last:border-b-0 hover:bg-hover">
              <button onClick={() => onShow(c.hash, c.subject)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <span className="shrink-0 font-mono text-[11px] text-accent">{c.short}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.subject}</span>
                <span className="shrink-0 text-[11px] text-dim">{c.author}</span>
                <span className="shrink-0 text-[11px] text-dim">{c.relative}</span>
              </button>
              <IconAct title={t("Cherry-pick onto current branch")} onRun={async () => { await act("cherry-pick", { repo: repo.relPath, hash: c.hash }); }}><CherryIcon /></IconAct>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ── Action buttons ────────────────────────────────────────────────────────────
// Button with a word (24 px, pill): "Abort merge" under the conflicts; an error message moves into the tooltip.
function ActionButton({ title, onRun, disabled, className = "", children }: { title: string; onRun: () => Promise<void>; disabled?: boolean; className?: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return <button title={err || title} disabled={busy || disabled} onClick={async () => { setBusy(true); setErr(""); try { await onRun(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); } }} className={`flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-colors hover:opacity-90 disabled:opacity-50 ${err ? "ring-1 ring-danger" : ""} ${className}`}>{busy ? "…" : children}</button>;
}
// Access modal: appears when a git network operation fails for missing auth. Saves username + token for the WORKSPACE
// (backend: workspace_git_creds) and repeats the failed action directly; errors stay visible in the modal.
function GitAuthModal({ path, ask, onClose, onSuccess }: {
  path: Path;
  ask: { host: string; ssh: boolean; endpoint: string; body: Record<string, unknown> };
  onClose: () => void;
  onSuccess: (tree: GitTree | null) => void;
}) {
  const t = useT();

  async function saveAccess(z: GitAccess) {
    await api(path("/git/creds"), { method: "PUT", body: JSON.stringify(z) });
    const result = await api<GitTree>(path(`/git/${ask.endpoint}`), { method: "POST", body: JSON.stringify(ask.body) });
    onSuccess(result && Array.isArray(result.repos) ? result : null);
  }

  return (
    <Modal onClose={onClose} width={400} z="z-[70]" label={t("Git access for {host}", { host: ask.host || t("Remote") })}>
        <h2 className="text-[15px] font-semibold tracking-tight">{t("Git access for {host}", { host: ask.host || t("Remote") })}</h2>
        {ask.ssh ? (
          <>
            <p className="mt-2 text-[12.5px] leading-relaxed text-dim">
              {t("SSH remote detected. Add an SSH key (Terminal tab, ~/.ssh) or switch the remote to HTTPS — then token access works.")}
            </p>
            <div className="mt-4 flex justify-end">
              <button onClick={onClose} className={ghostSm}>{t("Close")}</button>
            </div>
          </>
        ) : (
          // With the host from the error message it is fixed (no field); without it the form asks for it.
          <GitAccessForm host={ask.host} hostFixed={Boolean(ask.host)} save={saveAccess} abort={onClose}
                             button={t("Save & retry")} buttonBusy={t("Trying…")} />
        )}
    </Modal>
  );
}

// Action icon of a row (16 px): stopPropagation so the click does not hit the row (diff);
// with `confirm` the kit's confirmation first.
function IconAct({ title, onRun, danger, confirm: confirmMsg, children }: { title: string; onRun: () => Promise<void>; danger?: boolean; confirm?: string; children: React.ReactNode }) {
  const t = useT();
  const question = useConfirm();
  const [busy, setBusy] = useState(false);
  return <button type="button" title={title} aria-label={title} disabled={busy} onClick={async (e) => { e.stopPropagation(); if (confirmMsg && !(await question(confirmMsg, { ok: title, danger: true }))) return; setBusy(true); try { await onRun(); } catch (err) { alert(t("Error: {msg}", { msg: (err as Error).message })); } finally { setBusy(false); } }} className={`grid h-4 w-4 place-items-center rounded text-dim hover:bg-edge ${danger ? "hover:text-danger" : "hover:text-fg"}`}>{busy ? <span className="text-[10px]">…</span> : children}</button>;
}

// ── Icons ───────────────────────────────────────────────────────────────────
// 24 viewBox, stroke 1.9; the newer ones (repo, clouds, ring, local branch, reload) in the same style.
const svg = (children: React.ReactNode, size = 14) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>);
const GitBranchIcon = ({ size = 14 }: { size?: number }) => svg(<><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>, size);
// The branch without upstream: the same sign, the upper node (the counterpart at the remote) only dashed.
const BranchLocalIcon = () => svg(<><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" strokeDasharray="2.4 2.3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" strokeDasharray="2.4 2.6" /></>, 12);
const RepoIcon = () => svg(<><path d="M5 19.5A2.5 2.5 0 0 1 7.5 17H19" /><path d="M7.5 3H19v18H7.5A2.5 2.5 0 0 1 5 18.5v-13A2.5 2.5 0 0 1 7.5 3z" /><path d="M9 7h6" /></>, 13);
const ChevronRightIcon = ({ size = 14 }: { size?: number }) => svg(<path d="M9 18l6-6-6-6" />, size);
const ChevronLeftIcon = () => svg(<path d="M15 18l-6-6 6-6" />);
const CaretDownIcon = () => svg(<path d="M6 9l6 6 6-6" />, 12);
const UpIcon = () => svg(<><path d="M5 3h14" /><path d="M12 21V8" /><path d="M7 12l5-5 5 5" /></>, 12);
const DownIcon = () => svg(<><path d="M5 21h14" /><path d="M12 3v13" /><path d="M7 12l5 5 5-5" /></>, 12);
const RefreshIcon = ({ size = 12 }: { size?: number }) => svg(<><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></>, size);
const ReloadIcon = () => svg(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></>, 12);
const CloudUpIcon = ({ size = 12 }: { size?: number }) => svg(<><path d="M16 16l-4-4-4 4" /><path d="M12 12v9" /><path d="M20.4 18.4A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 3 16.3" /></>, size);
const CloudDownIcon = () => svg(<><path d="M8 17l4 4 4-4" /><path d="M12 12v9" /><path d="M20.9 18.1A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 3 16.3" /></>, 12);
const PlusIcon = () => svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>, 12);
const MinusIcon = () => svg(<path d="M5 12h14" />, 12);
const DiscardIcon = () => svg(<><path d="M3 3v6h6" /><path d="M3.5 9A9 9 0 1 1 3 15" /></>, 12);
const TrashIcon = () => svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h12l1-14" /></>, 12);
const CheckIcon = ({ size = 12 }: { size?: number }) => svg(<path d="M20 6L9 17l-5-5" />, size);
const DiffIcon = () => svg(<><path d="M12 3v18" /><path d="M5 8h4" /><path d="M7 6v4" /><path d="M15 15h4" /></>, 14);
const CloseIcon = ({ size = 14 }: { size?: number }) => svg(<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>, size);
const HistoryIcon = () => svg(<><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 3" /></>, 13);
const MergeIcon = () => svg(<><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="12" r="3" /><path d="M6 9v6" /><path d="M6 12h6a3 3 0 0 1 3 3v-3" /></>, 12);
const RebaseIcon = () => svg(<><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M6 15V9a3 3 0 0 1 3-3h6" /></>, 12);
const CherryIcon = () => svg(<><path d="M2 17a4 4 0 1 0 8 0 4 4 0 0 0-8 0z" /><path d="M14 17a4 4 0 1 0 8 0 4 4 0 0 0-8 0z" /><path d="M6 13C6 6 12 6 18 4" /><path d="M18 13C18 8 16 6 18 4" /></>, 12);
