"use client";

// The diff tab of the code tabs in the chat. A self-contained building block (the tab bar and draft are held by lib/chat-tabs.ts). The
// calculations are purely in lib/diff-tab.ts (web/test/diff-tab.test.mjs runs them).
//
// WHAT IT SHOWS: a file as in VS Code, SIDE BY SIDE (@codemirror/merge `MergeView`, old on the left, new on the right) or INLINE
// (`unifiedMergeView`: one editor, deleted lines as an insert), with a switch; narrower than INLINE_UNDER_PX (the TAB, not the window,
// measured at its own root) it goes inline by itself. Language as in the editor (components/codeLang.ts), theme as the editor
// (components/code/codeTheme.ts). Several files (whole commit, history, stash) one below another, each collapsible, at the top the same
// counts line as the hover card in the graph (lib/git-card.ts `countsParts`); more than WHOLE_MAX files with an announcement. Never
// silently empty: binary, clipped, too big, submodule, conflict, rename (both paths), error appear as a line above the diff
// (lib/diff-tab.ts `display`). While loading the surface already stands at full size (no jumping).
//
// TWO PLACES, ONE BUILDING BLOCK: the same tab stands in the chat's code tabs (chat/DiffTabSwitch.tsx) and in the editor groups of the
// Files page (CodePane.tsx, key lib/editor-inputs.ts), opened from the timeline, from "Open Changes" (VS Code `git.openChange`) and from
// the git bar. As in VS Code: Next/Previous Change also via Alt+F5/Shift+Alt+F5 (`CHANGE_KEYS`, VS Code
// `workbench.action.compareEditor.nextChange`); before the buttons the number of changes ("3 changes", `data-diff-count`; VS Code does
// not show it, here it stands because cbase has no overview ruler).
//
// WRITING: only an unstaged change (`staged: false`): the right side is then the working tree, editable, as a VIEW OF THE FILE'S BUFFER
// (lib/buffer.ts): the same buffer as the file tab, so what is typed here stands there at once and vice versa. Cmd+S (Ctrl+S) saves
// through the buffer (`PUT …/files/write`, the same way as a file tab); no automatic saving. Staged, the right side is the index, a
// commit/stash is history: read-only.
//
// BLOCKS: per block (a git hunk) buttons in the right side's bar: unstaged "Stage Block" and "Discard Block", staged "Unstage Block".
// A block's patch is the SAME calculation as "stage hunk" in the DiffModal (lib/diff-tab.ts `parseDiff`/`hunkPatch`), applied via
// `POST …/git/apply` (discard with `worktree: true`, server git.js gitApply). Locked (reason in the title) while unsaved text is on the
// right, the diff is clipped or combined, or the blocks do not fit the shown texts (`blocksMatch`). Discard asks first. The answer (the
// fresh git tree) goes to the shared state (lib/git-state.ts `takeOverGitTree`): no second poller.
//
// DATA (everything via `path` = `instancePath(chatPath(apiBase, rest, chatId), instance)`, as GitSidebar.tsx and CodePane.tsx):
//   change     → POST /git/diff { repo, file, staged, content: true } (both sides as text, server git.js "content of both sides"); on the
//                right, if unstaged, the working tree via GET /files/read
//   commit     → POST /git/show { repo, hash, file, old?, content: true }
//   commit-whole, history → POST /git/show { hash, info: true } (header, counts) + { hash, files: true } (list), per file like `commit`
//                (loaded only when it is open AND in view); a server without `files` → the whole commit as a patch
//   stash      → POST /git/stash/show { repo, ref } (one patch over all files; the patch's places are shown)
//   A server without `content` (old state) → the patch alone, with an announcement; never an empty text in place of the unknown.
//
// THE INTERFACE (kept small):
//   source          the source (lib/diff-tab.ts `DiffSource`); its key `sourceKey` is the equality of two tabs
//   target          { apiBase, instance }: the target the tab carries; an instance switch in the chat header does not change it
//   chatId          optional, for `?chat=` (the chat's instance)
//   draft           the unsaved text of the right side with its BASE, held by the tabs' holder (survives chat switch and reload);
//                   null/undefined = none. Read ONLY on the first load (lib/file-status.ts `withDraft`): if the base is still the disk,
//                   it is simply unsaved; if the disk changed or the file is gone, it stands WITH the notice "reload / keep mine"
//                   (otherwise the base would be lost and the draft would apply against the new disk).
//   onDraft         every change of the draft (debounced, 250 ms; on unmount at once), null = nothing unsaved any more (saved or typed
//                   back); `base` = the text the draft rests on, `sha` its checksum. If the holder returns false (too big to remember),
//                   the tab says so.
//   onSaved         after every save the path (a file tab of the same file then rereads).
// STATE OF THE RIGHT SIDE: in the buffer (lib/buffer.ts, computed via lib/file-status.ts as in the file tab): normalised to "\n", the
// file's line ending remembered and restored on saving; saved with the precondition `base` (409 ⇒ notice); a buffer whose text differs
// from the saved one is never replaced, not even after a failed reread (the surface stays, the error stands as a line) or when the
// file was deleted.
//   onUnsaved       the dot in the tab (true at once on typing; false after saving or when the text equals the saved one again)
//   view/onView     the choice side by side/inline; without `view` the tab holds it itself (localStorage VIEW_KEY, for all tabs)
//   header          own header row (source, path, up/down to the previous/next block, switch); false if the code tabs' title row shows
//                   path and source: then up/down and the switch hang via portal on `buttonsIn` (the spot on the right of the title
//                   row, chat/ChatTabBar.tsx `ChatTabTitle`), preceded by `buttonsExtra` (e.g. "Open File")
//   onEffective     what really applies ({ view, forced }: narrow ⇒ inline forced)
//   stand           reread counter ("follow live"): every change rereads; if unsaved text is on the right, nothing is overwritten but
//                   asked ("The file was changed — reload / keep mine")
//   onError         every error of a route (as CodePane/GitSidebar: the holder falls back to the main one on 404 UNKNOWN_INSTANCE)
//   location        where the tab sits (components/code/view-locations.ts): Cmd+S outside the surface saves through it, and the scroll
//                   state and insertion mark return on remount (only the tab in front is mounted; VS Code keeps `editor.viewState`)

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk, originalDocChangeEffect, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, keymap, lineNumbers } from "@codemirror/view";
import { Annotation, ChangeSet, Compartment, EditorState, Prec, RangeSetBuilder, type Extension, type StateCommand } from "@codemirror/state";
import { basicSetup } from "@uiw/react-codemirror";
import {
  api, normGitCommitFiles, normGitCommitInfo, type FileContent, type GitCommitFile, type GitCommitInfo, type GitTree,
} from "@/lib/api";
import { useConfirm } from "@/components/Prompts";
import { loadLanguage } from "@/components/codeLang";
import { codeTheme, darkSyntax, fontSize } from "@/components/code/codeTheme";
import { CODE_DEFAULTS, subscribeCodeSettings, editorFontSize } from "@/lib/code-settings";
import { textSizeMeasurement } from "@/lib/text-size-cm";
import { textPx } from "@/lib/appearance";
import { useResolvedTheme } from "@/lib/theme";
import { dateLocale, useT } from "@/lib/i18n";
import { chatPath } from "@/lib/chat-instance";
import { instancePath } from "@/lib/code-instance";
import { takeOverGitTree } from "@/lib/git-state";
import { KIND_COLOR, commitStatusDisplay, diffPath, partsPath } from "@/lib/git-files";
import { relativeTime, countsParts, countsText, type CountsTone } from "@/lib/git-card";
import {
  VIEW_KEY, WHOLE_MAX, WHOLE_OPEN, INLINE_UNDER_PX, applyBody, blockActions, display as displayOf, diffKind, wholeCap, isMultiFile, readView,
  minimalChange, normContent, patchCounts, sourceLabel, sourceWritable, writeFile, splitFiles, effectiveView, targetPath,
  filesContent, comparisonContent,
  type Announcement, type Block, type BlockAction, type Display as DiffDisplay, type DiffView, type Input, type PatchDoc,
} from "@/lib/diff-tab";
import { diffPath as fileOfTheDiffs, targetEqual, type DiffSource, type SideStatus, type TabTarget } from "@/lib/chat-tabs";
import { rootName } from "@/lib/buffer-coordinates";
import { fromReading, norm, type Disk } from "@/lib/file-status";
import type { EditorHolder, Buffer } from "@/lib/buffer";
import { useBufferTabs } from "@/components/code/BufferEditor";
import { useCoordinates, waitingText } from "@/components/code/coordinates";
import { bufferView } from "@/components/code/buffer-view";
import { editorExtensions } from "@/components/code/lsp-extension";
import { NavContext } from "@/components/code/navigation-connection";
import { reportSave, rememberRole, roleOf } from "@/components/code/view-locations";

export type DiffTarget = { apiBase: string; instance: string | null };
/** The draft of the right side as the holder remembers it: its own text, the base it rests on, and that base's `sha` (if known). */
export type DiffDraft = { base: string; content: string; sha?: string | null };
export interface DiffTabProps {
  source: DiffSource;
  target: DiffTarget;
  /** The target under which the right side's buffer stands (lib/buffer.ts): the TAB's, as with the file tab (without: `target`). The
   *  holder asks with the chat (`target` without instance + `chatId`), the buffer writes like the file tab with the target's instance. */
  bufferTarget?: DiffTarget;
  /** The editor the tab sits in (rename/code action on the editable side open changed files as a background tab). */
  editor?: EditorHolder | null;
  chatId?: string | null;
  draft?: DiffDraft | null;
  /** false = the draft could not be remembered (too big); the tab says so. */
  onDraft?: (text: string | null, base: string, sha: string | null, buffer?: string) => boolean | void;
  /** After every save: the path relative to the target; the holder nudges the other tabs of the same target. */
  onSaved?: (path: string) => void;
  onUnsaved?: (unsaved: boolean) => void;
  view?: DiffView;
  onView?: (a: DiffView) => void;
  header?: boolean;
  buttonsIn?: HTMLElement | null;
  buttonsExtra?: React.ReactNode;
  onEffective?: (w: { view: DiffView; forced: boolean }) => void;
  state?: number;
  onError?: (e: unknown) => void;
  /** Where the tab sits (components/code/view-locations.ts): Cmd+S from outside the surface, the scroll state on remount. */
  location?: string;
}
/** Alt+F5 / Shift+Alt+F5 jump as in VS Code (`workbench.action.compareEditor.nextChange`/`previousChange`) to the next or previous change;
 *  bound on both sides, multi-file diffs excepted (there is no single surface). */
const CHANGE_KEYS = keymap.of([
  { key: "Alt-F5", run: goToNextChunk, preventDefault: true },
  { key: "Shift-Alt-F5", run: goToPreviousChunk, preventDefault: true },
]);
type T = ReturnType<typeof useT>;
type Path = (rest: string) => string;
const errorText = (e: unknown) => String((e as Error)?.message || e);

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function DiffTab(props: DiffTabProps) {
  const { source, target, chatId = null, header = true, onView, onEffective } = props;
  const t = useT();
  const path = useCallback<Path>((rest) => instancePath(chatPath(target.apiBase, rest, chatId), target.instance), [target.apiBase, target.instance, chatId]);
  // The choice: controlled (`view`) or its own, remembered for all tabs (in try/catch; without storage "side by side" applies).
  const [ownChoice, setOwnChoice] = useState<DiffView>("sideBySide");
  useEffect(() => { try { setOwnChoice(readView(localStorage.getItem(VIEW_KEY))); } catch { /* default */ } }, []);
  const choice = props.view ?? ownChoice;
  const select = useCallback((a: DiffView) => {
    if (props.view === undefined) { setOwnChoice(a); try { localStorage.setItem(VIEW_KEY, a); } catch { /* for this session only */ } }
    onView?.(a);
  }, [props.view, onView]);
  // The width of the TAB (container, not window): the same view stands in the chat beside tree and bars and on the page alone.
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((e) => { const b = e[0]?.contentRect.width; if (b) setWidth(Math.round(b)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const effective = effectiveView(choice, width);
  useEffect(() => { onEffective?.(effective); }, [effective.view, effective.forced]); // eslint-disable-line react-hooks/exhaustive-deps
  const control = useRef<Control | null>(null);
  // The number of changes (blocks) of the surface; shown beside up/down ("3 changes").
  const [count, setCount] = useState<number | null>(null);
  const label = sourceLabel(source, undefined, rootName);
  // The file's path: the file TODAY (across a rename, like the tab title; when comparing two files the right one).
  const title = fileOfTheDiffs(source);
  // As in VS Code in the diff editor's title: "Previous Change" (Shift+Alt+F5) and "Next Change" (Alt+F5), preceded by the number of changes.
  const nav = !isMultiFile(source) && <>
    {count !== null && <span className="shrink-0 px-1 text-[11.5px] text-dim" data-diff-count={count}>{t(count === 1 ? "{n} change" : "{n} changes", { n: count })}</span>}
    <HeaderButton title={`${t("Previous Change")} (⇧⌥F5)`} onClick={() => control.current?.previous()} data="previous"><ArrowUpIcon /></HeaderButton>
    <HeaderButton title={`${t("Next change")} (⌥F5)`} onClick={() => control.current?.next()} data="next"><ArrowDownIcon /></HeaderButton>
  </>;
  return (
    <div ref={root} className="flex h-full min-h-0 w-full min-w-0 flex-col" data-diff-tab={source.kind} data-diff-view={effective.view}>
      {header && (
        <div className="@container/diffheader flex h-[30px] shrink-0 items-center gap-2 border-b border-edge pl-3 pr-1.5 text-[12px]">
          <span className="shrink-0 text-dim" data-diff-source>{t(label.key, label.values)}</span>
          {title && <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={title}>{title}</span>}
          {!title && <span className="flex-1" />}
          {nav}
          <DiffViewSwitcher choice={choice} effective={effective.view} forced={effective.forced} onChoice={select} />
        </div>
      )}
      {/* Without its own header: the same buttons on the right of the code tabs' title row; the switch's label shows as soon as the
          TITLE ROW is wide enough (`location="title"`), otherwise the symbol with name and title. */}
      {!header && props.buttonsIn && createPortal(
        <div className="flex items-center gap-0.5" data-diff-buttons>
          {props.buttonsExtra}
          {nav}
          <DiffViewSwitcher choice={choice} effective={effective.view} forced={effective.forced} onChoice={select} location="title" />
        </div>,
        props.buttonsIn,
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {isMultiFile(source)
          ? <MultiFileDiff source={source} target={target} chatId={chatId} path={path} view={effective.view} t={t} onError={props.onError} />
          : <SingleDiff {...props} chatId={chatId} path={path} view={effective.view} height="fill" collect={false} control={control} onCount={setCount} t={t} />}
      </div>
    </div>
  );
}

/** The side-by-side/inline switch, for the own header (`location="header"`: label in the container `@container/diffheader` from 480 px)
 *  and for the code tabs' title row (`location="title"`: in the container `@container/chattitle` from 560 px; the title row carries the
 *  path on the left). Narrower, only the symbols show, with name (`aria-label`) and title. The classes are written out in full: Tailwind
 *  finds only whole words. `forced`: the tab is too narrow, "side by side" applies again only from INLINE_UNDER_PX (the button says so in its title). */
const LABEL = { header: "hidden @[480px]/diffheader:inline", title: "hidden @[560px]/chattitle:inline" } as const;
export function DiffViewSwitcher({ choice, effective, forced, onChoice, location = "header" }: { choice: DiffView; effective: DiffView; forced: boolean; onChoice: (a: DiffView) => void; location?: keyof typeof LABEL }) {
  const t = useT();
  const buttonEl = (a: DiffView, label: string, icon: React.ReactNode, title: string) => (
    <button type="button" onClick={() => onChoice(a)} aria-pressed={effective === a} aria-label={label} title={title} data-diff-view-choice={a}
      className={`flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors ${effective === a ? "bg-hover text-fg" : "text-dim hover:text-fg"}`}>
      {icon}<span className={LABEL[location]}>{label}</span>
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t("Diff view")} data-diff-choice={choice} data-diff-forced={forced ? "1" : undefined}>
      {buttonEl("sideBySide", t("Side by side"), <SideBySideIcon />, forced ? t("Too narrow — side by side from {px} px width", { px: INLINE_UNDER_PX }) : t("Side by side"))}
      {buttonEl("inline", t("Inline"), <InlineIcon />, t("Inline"))}
    </div>
  );
}

function HeaderButton({ title, onClick, data, children }: { title: string; onClick: () => void; data: string; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} title={title} aria-label={title} data-diff-nav={data} className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-fg">{children}</button>;
}

// ── One file ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Control = { next: () => void; previous: () => void };
type Situation = { kind: "loading" } | { kind: "error"; text: string } | { kind: "loaded"; d: DiffDisplay };
type Display = { old: string; oldRev: number; fresh: string; newRev: number };

function SingleDiff({ source, chatId, target, bufferTarget, editor = null, path, view, height, collect, control, onCount, t, draft, onDraft, onSaved, onUnsaved, state: revision, onError, location }: DiffTabProps & {
  path: Path; view: DiffView; height: "fill" | "content"; collect: boolean; control?: React.MutableRefObject<Control | null>; onCount?: (n: number | null) => void; t: T;
}) {
  const question = useConfirm();
  const [situation, setSituation] = useState<Situation>({ kind: "loading" });
  const situationRef = useRef(situation);
  situationRef.current = situation;
  const [display, setDisplay] = useState<Display>({ old: "", oldRev: 0, fresh: "", newRev: 0 });
  const [newError, setNewError] = useState(""); // a failed reread; the surface stays
  const [notRemembered, setNotRemembered] = useState(false); // the draft is too big to remember
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState("");
  const surface = useRef<SurfacesApi | null>(null);
  const loadSeq = useRef(0);
  const firstDraft = useRef(draft);
  // The remembered draft carries something other than the buffer that was already open in the window (`load` said "deviating"):
  // it stays remembered, this tab does not overwrite it with the buffer's text.
  const foreign = useRef(false);
  // A writable side without a buffer keeps loading until the buffer is there (effect under `load`).
  const withoutBuffer = useRef(false);
  const back = useRef({ onDraft, onSaved, onUnsaved, onError });
  back.current = { onDraft, onSaved, onUnsaved, onError };
  const key = JSON.stringify(source);
  const writeSource = sourceWritable(source);
  const file = writeFile(source) ?? "";
  // The right side of an unstaged change is the file's BUFFER (lib/buffer.ts): the same as the file tab in Coding → Files or in the chat;
  // text, saved state, checksum, line ending, the "reload / keep mine" choice and the save error live there (computed via
  // lib/file-status.ts). The tab holds it while mounted; the path is the TAB's, the buffer the canonical one (lib/buffer-coordinates.ts);
  // while the mapping is unknown the side waits (`waiting`) instead of loading without a buffer.
  // When comparing two files, the buffer of the RIGHT side's target (the clicked file, lib/chat-tabs.ts "files").
  const coord = useCoordinates(source.kind === "files" ? source.rightTarget : (bufferTarget ?? target));
  const { bufferOf, tick, change } = useBufferTabs(coord, writeSource && file ? [file] : []);
  const waiting = writeSource && Boolean(file) && !coord.ready;
  const bufRef = useRef<Buffer | null>(null);
  bufRef.current = writeSource && file ? bufferOf(file) : null;
  const buf = bufRef.current;
  const dirty = Boolean(buf?.dirty);
  const inquiry = buf?.status.inquiry ?? null;
  const rememberDraft = () => {
    const p = bufRef.current;
    if (!p || p.status.state !== "loaded" || foreign.current) return;
    const ok = back.current.onDraft?.(p.dirty ? p.text : null, p.status.saved, p.status.base, p.buffer);
    setNotRemembered(p.dirty && ok === false);
  };

  const fetchInput = useCallback(async (): Promise<{ e: Input; reading: ReturnType<typeof fromReading> }> => {
    if (source.kind === "change") {
      const file = diffPath(source.file);
      const raw = await api<unknown>(path("/git/diff"), { method: "POST", body: JSON.stringify({ repo: source.repo, file: file, staged: source.staged, content: true }) });
      const content = normContent(raw, file);
      if (!content) return { e: { source, content: null, patch: typeof (raw as { diff?: unknown })?.diff === "string" ? (raw as { diff: string }).diff : "" }, reading: null };
      if (content.after.kind !== "workingTree") return { e: { source, content, patch: null }, reading: null };
      // Renamed since opening: git sees `file` deleted, on the right the file stands under its new name (`current`).
      if (!source.current && diffKind(content.diff).deleted) return { e: { source, content, patch: null, workingTree: { missing: true } }, reading: null };
      try {
        const fc = await api<FileContent>(path(`/files/read?path=${encodeURIComponent(targetPath(source.repo, source.current ?? source.file))}`));
        const workingTree = typeof fc.content === "string" ? { text: fc.content } : fc.tooLarge ? { tooBig: true as const } : fc.binary ? { binary: true as const } : { error: t("no answer") };
        return { e: { source, content, patch: null, workingTree }, reading: fromReading(fc) };
      } catch (e) { return { e: { source, content, patch: null, workingTree: { error: errorText(e) } }, reading: null }; }
    }
    if (source.kind === "commit") {
      const file = diffPath(source.file);
      const raw = await api<unknown>(path("/git/show"), { method: "POST", body: JSON.stringify({ repo: source.repo, hash: source.hash, file, ...(source.old ? { old: diffPath(source.old) } : {}), content: true }) });
      const content = normContent(raw, file);
      if (content) return { e: { source, content, patch: null }, reading: null };
      const o = (raw ?? {}) as { path?: unknown; diff?: unknown; clipped?: unknown };
      if (o.path !== file || typeof o.diff !== "string") throw new Error(t("The server does not know the diff of a single file yet (after its next deploy) — \"Show whole commit\" works."));
      return { e: { source, content: null, patch: o.diff, patchClipped: o.clipped === true }, reading: null };
    }
    // Two entries of the timeline: per side the file in its commit (`/git/show` with content: `after` is the file IN the commit).
    // Which side goes where is computed by lib/diff-tab.ts `comparisonContent`/`filesContent`.
    if (source.kind === "comparison") {
      const page = async (x: SideStatus) => {
        const d = diffPath(x.file);
        return normContent(await api<unknown>(path("/git/show"), { method: "POST", body: JSON.stringify({ repo: source.repo, hash: x.hash, file: d, content: true }) }), d);
      };
      const content = await comparisonContent(source.left, source.right, page);
      if (!content) throw new Error(t("The server does not know how to compare two revisions yet (after its next deploy)."));
      return { e: { source, content, patch: null }, reading: null };
    }
    // Two files: the left one read, the right one the working tree (the buffer, editable like the file itself). Each side comes from ITS
    // target: the tab's via `path` (with the chat, where it belongs), another via its route and instance.
    if (source.kind === "files") {
      const pathIn = (z: TabTarget): Path => (targetEqual(z, bufferTarget ?? target) ? path : (rest) => instancePath(`${z.apiBase}${rest}`, z.instance));
      const read = (x: { target: TabTarget; path: string }) => api<FileContent>(pathIn(x.target)(`/files/read?path=${encodeURIComponent(x.path)}`));
      const { content, right: r } = await filesContent({ target: source.leftTarget, path: source.left }, { target: source.rightTarget, path: source.right }, read);
      const workingTree = typeof r.content === "string" ? { text: r.content } : r.tooLarge ? { tooBig: true as const } : r.binary ? { binary: true as const } : { error: t("no answer") };
      return { e: { source, content, patch: null, workingTree }, reading: fromReading(r) };
    }
    throw new Error("SingleDiff: source with several files");
  }, [source, path, t, bufferTarget?.apiBase, bufferTarget?.instance]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (reason: "first" | "fresh") => {
    const seq = ++loadSeq.current;
    if (reason === "first") setSituation({ kind: "loading" });
    // The buffer's read marker BEFORE reading: if it saves meanwhile, the disk just read is stale (lib/buffer.ts `takeDisk`).
    const p0 = bufRef.current, marker = p0?.readMarker();
    let h: Awaited<ReturnType<typeof fetchInput>>;
    try { h = await fetchInput(); }
    catch (e) {
      if (seq !== loadSeq.current) return;
      // A failed REread does not replace the surface (unsaved text may stand there); the error is a line.
      if (reason === "first" || situationRef.current.kind !== "loaded") setSituation({ kind: "error", text: errorText(e) });
      else setNewError(t("Reloading failed — showing the last state: {msg}", { msg: errorText(e) }));
      back.current.onError?.(e);
      return;
    }
    if (seq !== loadSeq.current) return;
    setNewError("");
    const d = displayOf(h.e);
    const oldDisplay = d.kind === "merge" ? norm(d.old) : null;
    const p = bufRef.current;
    // A writable side WITHOUT a buffer (the mapping is not known yet) is not shown: it would be editable without a buffer (no dot,
    // Cmd+S does nothing, no draft), and the first load with a buffer would rebuild it, losing what was typed.
    if (writeSource && file && !p) { withoutBuffer.current = true; setSituation({ kind: "loading" }); return; }
    if (!writeSource || !p) {
      if (d.kind === "merge") setDisplay((v) => ({ old: norm(d.old), oldRev: v.oldRev + 1, fresh: norm(d.fresh), newRev: v.newRev + 1 }));
      setSituation({ kind: "loaded", d });
      return;
    }
    // The disk of the right side: text with checksum, null = the file does not exist (any more), undefined = not comparable right now
    // (binary, too big, a link, a read error).
    const bothMissing = d.kind === "announcement" && h.e.content?.prior.kind === "missing" && h.e.workingTree !== undefined && h.e.workingTree !== null && "missing" in h.e.workingTree;
    const disk: Disk | undefined = d.kind === "merge" && d.writable ? { text: norm(d.fresh), sha: h.reading?.sha ?? null }
      : (d.kind === "merge" && d.newMissing) || bothMissing ? null : undefined;
    // A surface that stays writable as long as unsaved text stands on it (across a deleted file too).
    const withEditor = (): DiffDisplay => (d.kind === "merge"
      ? { ...d, writable: true, blocks: [], blocksLocked: null }
      : { kind: "merge", old: oldDisplay ?? "", fresh: "", oldMissing: true, newMissing: true, writable: true, blocks: [], blocksLocked: null, announcements: d.announcements });
    if (oldDisplay !== null) setDisplay((v) => ({ ...v, old: oldDisplay, oldRev: v.oldRev + 1 }));
    if (disk === undefined) {
      // Not comparable right now: with unsaved text the surface stays as it is (nothing is replaced), otherwise the new display.
      const isDirty = p.dirty;
      if (isDirty) { setNewError(t("The file cannot be compared right now — your text stays here until you save or discard it.")); return; }
      setSituation({ kind: "loaded", d });
      return;
    }
    // First load via the buffer (the draft comes back WITH its base, lib/file-status.ts `withDraft`); if it is already open in the window,
    // its state counts. On reread (`afterReread`): a buffer with its own text is NEVER replaced.
    if (reason === "first" || p.status.state !== "loaded") {
      const r = await p.load({ draft: firstDraft.current ?? null, disk: { disk, lineEnding: h.reading?.lineEnding, marker: p === p0 ? marker : undefined } });
      if (seq !== loadSeq.current) return;
      if (r.kind === "text" && r.draft === "deviating") foreign.current = true; // the buffer carries its own text: the draft stays remembered
      else if (r.kind === "text" && r.draft === "done" && firstDraft.current) rememberDraft(); // already open in the window: the draft follows the buffer
    } else p.takeDisk(disk, h.reading?.lineEnding, p === p0 ? marker : undefined);
    setSituation({ kind: "loaded", d: p.status.inquiry || (p.dirty && d.kind !== "merge") ? withEditor() : d });
  }, [fetchInput, writeSource, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (waiting) return; firstDraft.current = draft; setNewError(""); void load("first"); }, [key, target.apiBase, target.instance, waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstStatus = useRef(revision);
  // A new state, while the mapping is not known, loads nothing; the first load comes as soon as it is there.
  useEffect(() => { if (revision !== firstStatus.current) { firstStatus.current = revision; if (!waiting) void load("fresh"); } }, [revision, load, waiting]);
  useEffect(() => { if (buf && withoutBuffer.current && !waiting) { withoutBuffer.current = false; void load("first"); } }, [buf, load, waiting]);

  // The dot in the tab follows the buffer (at once); the draft is debounced (250 ms), at once on unmount, otherwise the last keystrokes would be lost.
  useEffect(() => { if (buf?.status.state === "loaded") back.current.onUnsaved?.(dirty); }, [dirty, buf]); // eslint-disable-line react-hooks/exhaustive-deps
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstTick = useRef(true);
  const rememberLater = useRef(() => {});
  rememberLater.current = () => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; rememberDraft(); }, 250);
  };
  useEffect(() => {
    if (firstTick.current) { firstTick.current = false; return; }
    rememberLater.current();
  }, [tick]);
  // Every change (every keystroke too); `tick` grows only with the buffer's shape (lib/buffer-shape.ts).
  useEffect(() => change.subscribe(() => rememberLater.current()), [change]);
  useEffect(() => () => { if (debounce.current) { clearTimeout(debounce.current); rememberDraft(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Saving via the buffer (lib/buffer.ts `save`, with `base`): 409 ⇒ nothing written, the choice stands; afterwards the tab rereads.
  const save = useCallback(async () => {
    const p = bufRef.current;
    if (!writeSource || !p) return;
    setActionError("");
    const r = await p.save({ onError: (e) => back.current.onError?.(e) });
    if (r.kind === "saved") back.current.onSaved?.(file); // a file tab of the same file rereads
    if (r.kind === "saved" || r.kind === "changed") await load("fresh");
  }, [writeSource, file, load]);
  // Cmd+S from outside the surface (tab bar, header): VS Code saves the active editor, for a diff its right side.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => (location ? reportSave(location, () => { void saveRef.current(); }) : undefined), [location]);

  const blockAction = useCallback(async (action: BlockAction, block: Block) => {
    if (running || source.kind !== "change") return;
    // An UNTRACKED file has exactly one block; discarding it deletes the whole file, and the question says so.
    const wholeFile = situationRef.current.kind === "loaded" && situationRef.current.d.kind === "merge" && situationRef.current.d.oldMissing;
    if (action === "dismiss" && !(await question(
      wholeFile ? t("This file is untracked — “Discard change” deletes the WHOLE file. Really delete it?") : t("Discard this change? The change in the file will be lost."),
      { ok: wholeFile ? t("Delete file") : t("Discard change"), danger: true },
    ))) return;
    setRunning(true);
    setActionError("");
    try {
      const tree = await api<GitTree>(path("/git/apply"), { method: "POST", body: JSON.stringify(applyBody(action, source.repo, block.patch)) });
      takeOverGitTree(target.apiBase, chatId, target.instance, tree);
      if (action === "dismiss") back.current.onSaved?.(file); // the working tree changed; other tabs look again
      await load("fresh");
    } catch (e) { setActionError(t("The change could not be applied: {msg}", { msg: errorText(e) })); back.current.onError?.(e); }
    finally { setRunning(false); }
  }, [running, source, path, question, t, target.apiBase, target.instance, chatId, load, file]);

  useEffect(() => {
    if (!control) return;
    control.current = { next: () => surface.current?.jump(goToNextChunk), previous: () => surface.current?.jump(goToPreviousChunk) };
    return () => { control.current = null; };
  }, [control]);

  // "Reload": the disk wins (for a deleted file: the text is dropped, the state without it is shown). "Keep mine": deliberately
  // overwrite; compared against the disk, saved WITHOUT precondition. The buffer computes both.
  const loadAgain = () => {
    const p = bufRef.current, n = p?.status.inquiry;
    if (!p || !n) return;
    p.loadAgain();
    if (n.kind === "deleted") void load("fresh");
    requestAnimationFrame(() => surface.current?.focus()); // the button disappears with the notice; focus back into the editor
  };
  const mineKeep = () => {
    bufRef.current?.keep();
    requestAnimationFrame(() => surface.current?.focus()); // so Cmd+S reaches the editor right afterwards
  };
  const storageError = buf?.status.storageError ?? null;
  const storageText = !storageError ? "" : storageError.kind === "first-select" ? t("Choose first: reload or keep your changes.")
    : storageError.kind === "changed" ? t("Not saved: the file has changed in the meantime.") : t("Saving failed: {msg}", { msg: storageError.text });

  const d = situation.kind === "loaded" ? situation.d : null;
  const announcements: Announcement[] = d ? d.announcements : [];
  const titleTo = (a: BlockAction) => t(a === "stage" ? "Stage change" : a === "revert" ? "Unstage change" : "Discard change");
  const locked = d?.kind === "merge"
    ? (d.blocksLocked ? t(d.blocksLocked.key, d.blocksLocked.values) : dirty || inquiry ? t("Save first (⌘S) — the changes refer to the file on disk.") : running ? t("Loading…##inline") : null)
    : null;
  return (
    <div className={`flex min-h-0 flex-col ${height === "fill" ? "h-full" : ""}`} data-diff-single={source.kind} data-diff-unsaved={dirty ? "1" : undefined}>
      {actionError && <RowError text={actionError} onWay={() => setActionError("")} t={t} />}
      {storageText && <RowError text={storageText} onWay={() => bufRef.current?.forgetStorageError()} t={t} data="save" />}
      {newError && <RowError text={newError} onWay={() => setNewError("")} t={t} data="new-read" />}
      {notRemembered && (
        <div className="shrink-0 border-b border-edge px-3 py-1 text-[11.5px] leading-snug text-warn" role="status" data-diff-not-remembered>
          {t("Too large for a draft — it will not survive a reload; save before closing.")}
        </div>
      )}
      {inquiry !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-[12px] text-warn" role="status" data-diff-changed={inquiry.kind}>
          <span className="min-w-0 flex-1">{inquiry.kind === "deleted" ? t("The file was deleted — your text is still here; “Keep mine” recreates it when you save.") : t("The file has changed.")}</span>
          <button type="button" onClick={loadAgain} className="rounded-md px-1.5 py-0.5 text-[11.5px] text-fg hover:bg-hover" data-diff-new-load>{inquiry.kind === "deleted" ? t("Dismiss") : t("Reload")}</button>
          <button type="button" onClick={mineKeep} className="rounded-md px-1.5 py-0.5 text-[11.5px] text-fg hover:bg-hover" data-diff-mine>{t("Keep mine")}</button>
        </div>
      )}
      {announcements.map((a, i) => <AnnouncementRow key={`${a.key}\u0000${i}`} a={a} t={t} />)}
      {situation.kind === "loading" && <Placeholder height={height} text={waiting ? waitingText(coord, t) : t("Loading…##inline")} />}
      {situation.kind === "error" && <Placeholder height={height} text={situation.text} error />}
      {d?.kind === "announcement" && d.raw !== null && <RawText text={d.raw} height={height} />}
      {d?.kind === "announcement" && d.raw === null && height === "fill" && <div className="min-h-0 flex-1" />}
      {d?.kind === "merge" && (
        <MergeSurface
          apiRef={surface} fileName={fileOfTheDiffs(source) ?? ""}
          old={display.old} oldRev={display.oldRev} fresh={display.fresh} newRev={display.newRev}
          view={view} height={height} collect={collect} writable={d.writable && buf?.status.state === "loaded"}
          blocks={d.blocks} actions={blockActions(source)} locked={locked} titleTo={titleTo}
          onAction={blockAction} onSave={save} buffer={d.writable && buf?.status.state === "loaded" ? buf : null} editor={editor}
          onCount={onCount} scrollKey={location ? `${location}|${key}` : undefined}
        />
      )}
      {d?.kind === "patch" && <PatchSurface doc={d.doc} fileName={fileOfTheDiffs(source) ?? ""} view={view} height={height} t={t} />}
    </div>
  );
}


function AnnouncementRow({ a, t }: { a: Announcement; t: T }) {
  const color = a.tone === "danger" ? "text-danger" : a.tone === "warn" ? "text-warn" : "text-dim";
  return <div className={`shrink-0 border-b border-edge px-3 py-1 text-[11.5px] leading-snug ${color}`} role={a.tone === "danger" ? "alert" : "status"} data-diff-announcement={a.key}>{t(a.key, a.values)}</div>;
}
function RowError({ text, onWay, t, data = "action" }: { text: string; onWay: () => void; t: T; data?: string }) {
  return (
    <div role="alert" className="flex shrink-0 items-start gap-1.5 border-b border-edge py-1 pl-3 pr-1.5 text-[11.5px] leading-snug text-danger" data-diff-error={data}>
      <span className="min-w-0 flex-1 whitespace-pre-line break-words">{text}</span>
      <button type="button" onClick={onWay} title={t("Dismiss##hide")} aria-label={t("Dismiss##hide")} className="grid h-4 w-4 shrink-0 place-items-center rounded text-dim hover:bg-edge hover:text-fg"><CrossIcon /></button>
    </div>
  );
}
function Placeholder({ height, text, error = false }: { height: "fill" | "content"; text: string; error?: boolean }) {
  return (
    <div className={`grid place-items-center px-6 text-center text-[12px] ${error ? "text-danger" : "text-dim"} ${height === "fill" ? "min-h-0 flex-1" : "h-[96px]"}`} data-diff-placeholder={error ? "error" : "loading"}>
      <span className="whitespace-pre-line">{text}</span>
    </div>
  );
}
function RawText({ text, height }: { text: string; height: "fill" | "content" }) {
  return <pre className={`cb-scroll overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.5] ${height === "fill" ? "min-h-0 flex-1" : "max-h-[480px]"}`} data-diff-raw>{text}</pre>;
}

// ── Several files: whole commit, history, stash ──────────────────────────────────────────────────────────────────────────────
type Entry = { path: string; old: string | null; status: string; plus?: number; minus?: number; binary?: boolean; patch?: string };
type List = { kind: "loading" } | { kind: "error"; text: string } | { kind: "loaded"; entries: Entry[]; total: number | null; clipped: boolean | null; counts: GitCommitInfo["counts"]; info: GitCommitInfo | null; parent: string[] | null; unreadable: number };

function MultiFileDiff({ source, target, chatId, path, view, t, onError }: { source: DiffSource; target: DiffTarget; chatId: string | null; path: Path; view: DiffView; t: T; onError?: (e: unknown) => void }) {
  const [list, setList] = useState<List>({ kind: "loading" });
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const key = JSON.stringify(source);
  useEffect(() => {
    let cancelled = false;
    setList({ kind: "loading" });
    (async () => {
      if (source.kind === "stash") {
        const r = await api<{ diff?: unknown }>(path("/git/stash/show"), { method: "POST", body: JSON.stringify({ repo: source.repo, ref: source.ref }) });
        const files = splitFiles(typeof r?.diff === "string" ? r.diff : "");
        return { kind: "loaded" as const, entries: files.map((x) => ({ path: x.path, old: x.old, status: x.status, plus: x.plus, minus: x.minus, binary: x.binary, patch: x.diff })), total: files.length, clipped: false, counts: patchCounts(files), info: null, parent: null, unreadable: 0 };
      }
      if (source.kind !== "commit-whole" && source.kind !== "history") throw new Error("MultiFileDiff: source with a single file");
      const body = (o: Record<string, unknown>) => ({ method: "POST", body: JSON.stringify({ repo: source.repo, hash: source.hash, ...o }) });
      const [rawList, rawInfo] = await Promise.all([api<unknown>(path("/git/show"), body({ files: true })), api<unknown>(path("/git/show"), body({ info: true })).catch(() => null)]);
      const info = normGitCommitInfo(rawInfo, source.hash);
      const l = normGitCommitFiles(rawList);
      if (l) return { kind: "loaded" as const, entries: l.files.map((x: GitCommitFile) => ({ path: x.path, old: x.old, status: x.status })), total: l.total, clipped: l.clipped, counts: info?.counts ?? null, info, parent: info?.parent ?? l.parent, unreadable: l.unreadable };
      // A server without `files`: the whole commit as ONE patch (as in the modal), split per file.
      const whole = await api<{ diff?: unknown }>(path("/git/show"), body({}));
      const files = splitFiles(typeof whole?.diff === "string" ? whole.diff : "");
      return { kind: "loaded" as const, entries: files.map((x) => ({ path: x.path, old: x.old, status: x.status, plus: x.plus, minus: x.minus, binary: x.binary, patch: x.diff })), total: files.length, clipped: false, counts: info?.counts ?? patchCounts(files), info, parent: info?.parent ?? null, unreadable: 0 };
    })().then((l) => { if (!cancelled) { setList(l); setClosed(new Set(l.entries.slice(WHOLE_OPEN).map((e) => e.path))); } })
      .catch((e) => { if (!cancelled) { setList({ kind: "error", text: errorText(e) }); onError?.(e); } });
    return () => { cancelled = true; };
  }, [key, path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (list.kind === "loading") return <Placeholder height="fill" text={t("Loading…##inline")} />;
  if (list.kind === "error") return <Placeholder height="fill" text={list.text} error />;
  const shown = list.entries.slice(0, WHOLE_MAX);
  const cap = wholeCap(list.entries.length, list.total, list.clipped);
  const merge = (list.parent?.length ?? 0) > 1;
  const locale = dateLocale();
  return (
    <div className="cb-scroll absolute inset-0 overflow-y-auto" data-diff-multi-file={list.entries.length}>
      <div className="border-b border-edge px-3 py-2 text-[12px]">
        {list.info && (
          <div className="mb-0.5 flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate font-medium" title={list.info.message}>{list.info.message.split("\n")[0]}</span>
            <span className="shrink-0 text-dim">{list.info.author}{list.info.time ? ` · ${relativeTime(list.info.time, Date.now(), locale)}` : ""}</span>
          </div>
        )}
        {list.counts ? <CountsRow z={list.counts} t={t} /> : <span className="text-dim">{t("Numbers unknown")}</span>}
        {merge && <div className="text-[11.5px] text-dim">{t("Against the first parent {short}", { short: (list.parent?.[0] ?? "").slice(0, 8) })}</div>}
      </div>
      {cap && <AnnouncementRow a={cap} t={t} />}
      {list.unreadable > 0 && <AnnouncementRow a={{ key: "{n} entries of the file list could not be read and are missing here.", values: { n: list.unreadable }, tone: "warn" }} t={t} />}
      {shown.length === 0 && <div className="px-3 py-3 text-[12px] text-dim">{merge ? t("No changes against the first parent.") : t("No files changed.")}</div>}
      {shown.map((e) => (
        <FileSection key={`${e.status}\u0000${e.old ?? ""}\u0000${e.path}`} e={e} open={!closed.has(e.path)} source={source} target={target} chatId={chatId} path={path} view={view} t={t}
          onToggle={() => setClosed((s) => { const n = new Set(s); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n; })} />
      ))}
    </div>
  );
}

const TONE: Record<CountsTone, string> = { files: "", binary: "text-dim", plus: KIND_COLOR.added, minus: KIND_COLOR.deleted };
function CountsRow({ z, t }: { z: NonNullable<GitCommitInfo["counts"]>; t: T }) {
  const parts = countsParts(z);
  return (
    <div className="text-[12px]" data-diff-counts={countsText(parts, t)}>
      {parts.map((x) => <span key={x.tone}>{x.before}<span className={`whitespace-nowrap ${TONE[x.tone]}`}>{t(x.key, { n: x.n })}</span></span>)}
    </div>
  );
}

function FileSection({ e, open, source, target, chatId, path, view, t, onToggle }: { e: Entry; open: boolean; source: DiffSource; target: DiffTarget; chatId: string | null; path: Path; view: DiffView; t: T; onToggle: () => void }) {
  // Loaded only when the section is open AND in view (a big commit does not ask for every file at once); once loaded, it stays.
  const box = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !open) return;
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) setSeen(true); }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, open]);
  const a = commitStatusDisplay(e.status);
  const { name, folder } = partsPath(e.path);
  const place = e.old ? `${e.old} → ${e.path}` : e.path;
  const single: DiffSource | null = source.kind === "commit-whole" || source.kind === "history" ? { kind: "commit", repo: source.repo, hash: source.hash, file: e.path, old: e.status === "R" ? e.old : null } : null;
  return (
    <section ref={box} className="border-b border-edge" data-diff-file={e.path} data-diff-file-open={open ? "1" : "0"}>
      <button type="button" onClick={onToggle} aria-expanded={open} title={place}
        className="sticky top-0 z-[1] flex h-[28px] w-full min-w-0 items-center gap-1.5 bg-panel px-2 text-left hover:bg-hover">
        <span className={`shrink-0 text-dim transition-transform ${open ? "rotate-90" : ""}`}><ChevronIcon /></span>
        <span className={`w-3 shrink-0 text-center font-mono text-[11px] font-bold ${a.color}`}>{a.letter}</span>
        <span className={`min-w-0 shrink truncate font-mono text-[12px] ${a.deleted ? "text-dim line-through" : ""}`}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{e.old ? `${e.old} → ${folder}` : folder}</span>
        {e.binary && <span className="shrink-0 text-[11px] text-dim">{t("binary")}</span>}
        {(e.plus ?? 0) > 0 && <span className={`shrink-0 font-mono text-[11px] ${KIND_COLOR.added}`}>+{e.plus}</span>}
        {(e.minus ?? 0) > 0 && <span className={`shrink-0 font-mono text-[11px] ${KIND_COLOR.deleted}`}>−{e.minus}</span>}
      </button>
      {open && (seen
        ? (single && !e.patch
          ? <SingleDiff source={single} target={target} chatId={chatId} path={path} view={view} height="content" collect t={t} />
          : <PatchSection patch={e.patch ?? ""} source={source} fileName={e.path} view={view} t={t} />)
        : <Placeholder height="content" text={t("Loading…##inline")} />)}
    </section>
  );
}

function PatchSection({ patch, source, fileName, view, t }: { patch: string; source: DiffSource; fileName: string; view: DiffView; t: T }) {
  const d = useMemo(() => displayOf({ source, content: null, patch }), [source, patch]);
  return (
    <div className="flex flex-col">
      {d.announcements.map((a, i) => <AnnouncementRow key={`${a.key}\u0000${i}`} a={a} t={t} />)}
      {d.kind === "patch" && <PatchSurface doc={d.doc} fileName={fileName} view={view} height="content" t={t} />}
      {d.kind === "announcement" && d.raw !== null && <RawText text={d.raw} height="content" />}
    </div>
  );
}

// ── The surface (CodeMirror) ─────────────────────────────────────────────────────────────────────────────────────────────────────
type SurfacesApi = { text: () => string | null; jump: (cmd: StateCommand) => void; focus: () => void };
// A change from outside (reread, discarded): no typing, hence not unsaved.
const fromOutside = Annotation.define<boolean>();

function MergeSurface(p: {
  apiRef?: React.MutableRefObject<SurfacesApi | null>;
  fileName: string; old: string; oldRev: number; fresh: string; newRev: number; view: DiffView; height: "fill" | "content"; collect: boolean;
  writable: boolean; blocks?: Block[]; actions?: BlockAction[]; locked?: string | null; titleTo?: (a: BlockAction) => string;
  onAction?: (a: BlockAction, b: Block) => void; onSave?: () => void;
  /** The number of changes (the surface's blocks, `getChunks`) on every change; null as soon as the surface unmounts. */
  onCount?: (n: number | null) => void;
  /** Under this key the surface remembers scroll state and insertion mark (components/code/view-locations.ts) and restores them on build. */
  scrollKey?: string;
  /** The writable right side as a view of this buffer (lib/buffer.ts): its text comes from there, and what is typed stands at once in every
   *  other view of the same file (file tab, a second diff); components/code/buffer-view.ts. */
  buffer?: Buffer | null;
  /** The tab's editor (background tabs from rename/code action). */
  editor?: EditorHolder | null;
  numbers?: { old: (number | null)[]; fresh: (number | null)[] }; gaps?: { rowOld: number; rowNew: number; count: number }[]; gapText?: (n: number) => string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dark = useResolvedTheme() === "dark";
  const t = useT();
  const navigation = useContext(NavContext); // the editor in whose place the diff stands (history, references, tabs)
  // The one text @codemirror/merge writes itself (the collapsed equal lines), in the interface language.
  const phrases = EditorState.phrases.of({ "$ unchanged lines": t("{n} unchanged lines", { n: "$" }) });
  const run = useRef(p);
  run.current = p;
  const bText = useRef<string | null>(null); // the right-hand text across a rebuild (switching); unsaved text is not lost
  const parts = useRef<{ mv: MergeView | null; b: EditorView | null; a: EditorView | null; language: Compartment; theme: Compartment; buttons: Compartment; font: Compartment } | null>(null);
  // The editor's font size (VS Code: the diff follows `editor.fontSize`); switched without rebuild.
  const size = useSyncExternalStore(subscribeCodeSettings, editorFontSize, () => CODE_DEFAULTS.fontSize);
  const sizeNow = useRef(size);
  sizeNow.current = size;
  const structure = `${p.view}\u0000${p.height}\u0000${p.collect}\u0000${p.writable}\u0000${p.fileName}\u0000${p.numbers ? "n" : ""}\u0000${p.buffer?.buffer ?? ""}`;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const language = new Compartment(), theme = new Compartment(), buttons = new Compartment(), font = new Compartment();
    const themeExt = (d: boolean): Extension => (d ? [darkSyntax, EditorView.darkTheme.of(true)] : []);
    const common = (page: "a" | "b"): Extension[] => [
      basicSetup({ lineNumbers: false, foldGutter: false, highlightActiveLine: page === "b" && run.current.writable, highlightActiveLineGutter: false, autocompletion: false, searchKeymap: true }),
      lineNumbers(run.current.numbers ? { formatNumber: (n) => { const x = run.current.numbers?.[page === "a" ? "old" : "fresh"][n - 1]; return x == null ? "" : String(x); } } : {}),
      codeTheme, font.of(fontSize(sizeNow.current)), diffTheme, textSizeMeasurement, phrases, language.of([]), theme.of(themeExt(dark)),
      ...(run.current.height === "content" ? [EditorView.theme({ "&": { height: "auto" }, ".cm-scroller": { overflow: "visible" } })] : []),
      ...(run.current.gaps?.length ? [gapsDeco(run.current.gaps, page, run.current.gapText ?? ((n) => `⋯ ${n}`))] : []),
    ];
    const reading = EditorState.readOnly.of(true);
    // The number of changes, reported when it changes (@codemirror/merge recomputes the blocks after every step).
    let reported = -1;
    const report = (st: EditorState) => { const n = getChunks(st)?.chunks.length ?? 0; if (n !== reported) { reported = n; run.current.onCount?.(n); } };
    // The scroll state and insertion mark, remembered on every scroll and selection (on unmount the surface is already gone).
    const rk = run.current.scrollKey;
    let remember = () => {};
    const bExtra: Extension[] = [
      CHANGE_KEYS, EditorView.updateListener.of((u) => { report(u.state); if (u.selectionSet) remember(); }),
      buttons.of(blockGutter(run)),
      run.current.writable
        ? [Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { run.current.onSave?.(); return true; } }])),
           ...(run.current.buffer ? [bufferView(run.current.buffer)] : [])]
        : reading,
      // The editable side gets everything the file tab has: language service, context menu, shortcuts (components/code/lsp-extension.ts).
      ...(run.current.writable && run.current.buffer ? [editorExtensions({ buffer: run.current.buffer, editor: run.current.editor ?? null, navigation })] : []),
    ];
    const collect = run.current.collect ? { collapseUnchanged: { margin: 3, minSize: 4 } } : {};
    const startB = () => run.current.buffer?.text ?? bText.current ?? run.current.fresh;
    let mv: MergeView | null = null, b: EditorView, a: EditorView | null = null;
    if (run.current.view === "sideBySide") {
      mv = new MergeView({
        a: { doc: run.current.old, extensions: [...common("a"), reading, CHANGE_KEYS] },
        b: { doc: startB(), extensions: [...common("b"), ...bExtra] },
        parent: el, gutter: true, highlightChanges: true, diffConfig: { scanLimit: 5000, timeout: 1500 }, ...collect,
      });
      a = mv.a; b = mv.b;
    } else {
      b = new EditorView({
        parent: el,
        doc: startB(),
        extensions: [
          ...common("b"), ...bExtra,
          unifiedMergeView({ original: run.current.old, gutter: true, highlightChanges: true, mergeControls: false, syntaxHighlightDeletions: true, allowInlineDiffs: false, diffConfig: { scanLimit: 5000, timeout: 1500 }, ...collect }),
        ],
      });
    }
    parts.current = { mv, a, b, language, theme, buttons, font };
    report(b.state);
    let alive = true;
    const roller = mv ? mv.dom : b.scrollDOM;
    if (rk) {
      const r = roleOf(rk);
      if (r?.header !== undefined && r.header <= b.state.doc.length) b.dispatch({ selection: { anchor: r.header } });
      if (r) requestAnimationFrame(() => { if (alive) roller.scrollTop = r.top; });
      remember = () => { if (alive) rememberRole(rk, { top: roller.scrollTop, header: b.state.selection.main.head }); };
      roller.addEventListener("scroll", remember, { passive: true });
    }
    if (run.current.fileName) {
      void loadLanguage(run.current.fileName).then((ext) => {
        if (!alive || !ext) return;
        for (const v of [a, b]) v?.dispatch({ effects: language.reconfigure(ext) });
      });
    }
    if (p.apiRef) {
      p.apiRef.current = {
        text: () => (parts.current?.b ? parts.current.b.state.doc.toString() : null),
        jump: (cmd) => { const v = parts.current?.b; if (v) { cmd({ state: v.state, dispatch: v.dispatch }); v.focus(); } },
        focus: () => parts.current?.b?.focus(),
      };
    }
    // Unmounted, the surface still yields its last text (the holder remembers a debounced draft on its own unmount; who cleans up
    // first is not guaranteed); a rebuild (switching) sets the interface anew right away.
    return () => {
      alive = false;
      roller.removeEventListener("scroll", remember);
      const last = b.state.doc.toString();
      bText.current = last;
      (mv ?? b).destroy();
      parts.current = null;
      run.current.onCount?.(null); // no surface, no number (otherwise the old one would stand beside up/down until a new surface reports)
      if (p.apiRef) p.apiRef.current = { text: () => last, jump: () => {}, focus: () => {} };
    };
  }, [structure]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const x = parts.current;
    if (x) for (const v of [x.a, x.b]) v?.dispatch({ effects: x.font.reconfigure(fontSize(size)) });
  }, [size]);

  // New texts from outside (reread, saved, block applied): only the smallest replacement; insertion mark and scroll state stay.
  useEffect(() => {
    const x = parts.current;
    if (!x) return;
    if (x.mv && x.a) {
      const c = minimalChange(x.a.state.doc.toString(), p.old);
      if (c) x.a.dispatch({ changes: c, annotations: fromOutside.of(true) });
    } else if (x.b) {
      const orig = getOriginalDoc(x.b.state);
      const c = minimalChange(orig.toString(), p.old);
      if (c) x.b.dispatch({ effects: originalDocChangeEffect(x.b.state, ChangeSet.of([c], orig.length)) });
    }
  }, [p.oldRev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = parts.current?.b;
    if (!v || run.current.buffer) return; // with a buffer the buffer brings the text in
    const c = minimalChange(v.state.doc.toString(), p.fresh);
    if (c) v.dispatch({ changes: c, annotations: fromOutside.of(true) });
  }, [p.newRev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const x = parts.current;
    if (!x) return;
    for (const v of [x.a, x.b]) v?.dispatch({ effects: x.theme.reconfigure(dark ? [darkSyntax, EditorView.darkTheme.of(true)] : []) });
  }, [dark]);
  const buttonsKey = `${(p.blocks ?? []).map((b) => b.patch).join("\u0000")}\u0001${p.locked ?? ""}\u0001${(p.actions ?? []).join()}`;
  useEffect(() => {
    const x = parts.current;
    if (x?.b) x.b.dispatch({ effects: x.buttons.reconfigure(blockGutter(run)) });
  }, [buttonsKey]);

  return <div ref={host} className={`min-w-0 ${p.height === "fill" ? "relative min-h-0 flex-1 overflow-hidden [&>*]:absolute [&>*]:inset-0" : ""}`} data-diff-surface={p.view} data-diff-blocks={p.blocks?.length ?? 0} data-diff-locked={p.locked ? "1" : undefined} />;
}

function PatchSurface({ doc, fileName, view, height, t }: { doc: PatchDoc; fileName: string; view: DiffView; height: "fill" | "content"; t: T }) {
  return (
    <MergeSurface fileName={fileName} old={doc.old} oldRev={0} fresh={doc.fresh} newRev={0} view={view} height={height} collect={false} writable={false}
      numbers={{ old: doc.oldNumbers, fresh: doc.newNumbers }} gaps={doc.gaps} gapText={(n) => t(n === 1 ? "⋯ {n} unchanged line" : "⋯ {n} unchanged lines", { n })} />
  );
}

// The buttons per block in the right side's bar (side by side: between the editors; inline: left). The callbacks come via the ref
// (`run`); the markers stay as long as blocks, lock and actions do not change.
const SVG: Record<BlockAction, string> = {
  stage: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  revert: '<path d="M5 12h14"/>',
  dismiss: '<path d="M3 3v6h6"/><path d="M3.5 9A9 9 0 1 1 3 15"/>',
};
class BlockMarker extends GutterMarker {
  constructor(readonly block: Block, readonly actions: readonly BlockAction[], readonly locked: string | null, readonly title: (a: BlockAction) => string, readonly run: (a: BlockAction, b: Block) => void) { super(); }
  eq(o: BlockMarker) { return o.block.patch === this.block.patch && o.locked === this.locked && o.actions.join() === this.actions.join(); }
  toDOM() {
    const box = document.createElement("span");
    box.className = "cm-blockButtons";
    box.dataset.diffBlock = String(this.block.seq);
    for (const a of this.actions) {
      const k = document.createElement("button");
      k.type = "button";
      k.className = `cm-blockButton${a === "dismiss" ? " cm-blockButton-cancelled" : ""}`;
      k.dataset.blockAction = a;
      k.title = this.locked ?? this.title(a);
      k.setAttribute("aria-label", this.title(a));
      k.disabled = this.locked !== null;
      k.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[a]}</svg>`;
      k.onmousedown = (e) => e.preventDefault();
      k.onclick = (e) => { e.stopPropagation(); if (!k.disabled) this.run(a, this.block); };
      box.append(k);
    }
    return box;
  }
}
function blockGutter(run: React.MutableRefObject<{ blocks?: Block[]; actions?: BlockAction[]; locked?: string | null; titleTo?: (a: BlockAction) => string; onAction?: (a: BlockAction, b: Block) => void }>): Extension {
  const { blocks = [], actions = [], locked = null } = run.current;
  if (!actions.length || !blocks.length) return [];
  const title = (a: BlockAction) => run.current.titleTo?.(a) ?? a;
  const execute = (a: BlockAction, b: Block) => run.current.onAction?.(a, b);
  return gutter({
    class: "cm-blockGutter",
    markers: (view) => {
      const build = new RangeSetBuilder<GutterMarker>();
      let last = -1;
      for (const b of [...blocks].sort((x, y) => x.firstNew - y.firstNew)) {
        const row = Math.max(1, Math.min(view.state.doc.lines, b.firstNew));
        if (row === last) continue;
        last = row;
        const pos = view.state.doc.line(row).from;
        build.add(pos, pos, new BlockMarker(b, actions, locked, title, execute));
      }
      return build.finish();
    },
    // The placeholder that holds the bar's width: without buttons, otherwise hidden buttons would stand a second time in the tree.
    initialSpacer: () => new EmptyMarker(actions.length * 19 + 5),
  });
}
class EmptyMarker extends GutterMarker {
  constructor(readonly width: number) { super(); }
  eq(o: EmptyMarker) { return o.width === this.width; }
  toDOM() { const s = document.createElement("span"); s.style.display = "inline-block"; s.style.width = `${this.width}px`; return s; }
}

// The gap between two blocks of a patch: the placeholder row becomes "⋯ n unchanged lines".
class GapWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: GapWidget) { return o.text === this.text; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-diffGap"; s.textContent = this.text; return s; }
}
function gapsDeco(gaps: { rowOld: number; rowNew: number; count: number }[], page: "a" | "b", text: (n: number) => string): Extension {
  return EditorView.decorations.compute([], (state) => {
    const build = new RangeSetBuilder<Decoration>();
    for (const l of gaps) {
      const seq = page === "a" ? l.rowOld : l.rowNew;
      if (seq < 1 || seq > state.doc.lines) continue;
      const z = state.doc.line(seq);
      build.add(z.from, z.from, Decoration.line({ class: "cm-diffGapRow" }));
      build.add(z.from, z.to, Decoration.replace({ widget: new GapWidget(text(l.count)) }));
    }
    return build.finish();
  });
}

// Colours from the app's roles (inserted like "A" green, deleted like "D" red; lib/git-files.ts KIND_COLOR), computed the same in both
// themes. The classes of @codemirror/merge carry `&light`/`&dark` in the base theme (three classes): doubled classes beat them.
const diffTheme = EditorView.theme({
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "color-mix(in srgb, var(--color-danger) 8%, transparent)" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "color-mix(in srgb, var(--color-ok) 8%, transparent)" },
  "&.cm-merge-a.cm-merge-a .cm-changedText, &.cm-editor.cm-editor .cm-deletedChunk .cm-deletedText": { background: "color-mix(in srgb, var(--color-danger) 26%, transparent)" },
  "&.cm-merge-b.cm-merge-b .cm-changedText": { background: "color-mix(in srgb, var(--color-ok) 24%, transparent)" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  "&.cm-merge-a.cm-merge-a .cm-changedLineGutter, &.cm-editor.cm-editor .cm-deletedLineGutter": { background: "var(--color-danger)" },
  "&.cm-merge-b.cm-merge-b .cm-changedLineGutter": { background: "var(--color-ok)" },
  "&.cm-editor .cm-collapsedLines": { color: "var(--color-dim)", background: "var(--color-hover)", fontFamily: "var(--font-sans)", fontSize: textPx(11.5), padding: "2px 10px" },
  ".cm-deletedChunk": { paddingLeft: "6px" },
  ".cm-blockGutter .cm-gutterElement": { display: "flex", justifyContent: "flex-end" },
  ".cm-blockButtons": { display: "flex", gap: "2px", justifyContent: "flex-end", paddingRight: "3px" },
  ".cm-blockButton": { display: "grid", placeItems: "center", width: "17px", height: "17px", marginTop: "1px", borderRadius: "4px", border: "1px solid var(--color-edge)", background: "var(--color-panel)", color: "var(--color-dim)", cursor: "pointer" },
  ".cm-blockButton:hover:not(:disabled)": { color: "var(--color-fg)", background: "var(--color-hover)" },
  ".cm-blockButton-cancelled:hover:not(:disabled)": { color: "var(--color-danger)" },
  ".cm-blockButton:disabled": { opacity: "0.45", cursor: "not-allowed" },
  ".cm-diffGapRow": { background: "var(--color-hover)" },
  ".cm-diffGap": { color: "var(--color-dim)", fontFamily: "var(--font-sans)", fontSize: textPx(11.5) },
});

// ── Symbols (24 viewBox, stroke 1.9, as GitSidebar.tsx) ─────────────────────────────────────────────────────────────────────
const svg = (children: React.ReactNode, size = 13) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>);
const ArrowUpIcon = () => svg(<path d="M12 19V5M6 11l6-6 6 6" />);
const ArrowDownIcon = () => svg(<path d="M12 5v14M6 13l6 6 6-6" />);
const SideBySideIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>);
const InlineIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></>);
const ChevronIcon = () => svg(<path d="M9 18l6-6-6-6" />, 12);
const CrossIcon = () => svg(<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>, 11);
