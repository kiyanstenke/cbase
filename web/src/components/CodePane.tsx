"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { showMinimap } from "@replit/codemirror-minimap";
import { minimapFont } from "@/components/code/minimap-font";
import { useResolvedTheme } from "@/lib/theme";
import { instancePath } from "@/lib/code-instance";
import { tabLocation } from "@/lib/tab-foreign";
import { textSizeMeasurement } from "@/lib/text-size-cm";
import { useT } from "@/lib/i18n";
import { useAutoCollapse } from "@/lib/viewport";
import { codeTheme, darkSyntax, fontSize } from "@/components/code/codeTheme";
import { EDITOR_FONT_SIZE } from "@/lib/editor-defaults";
import { CODE_DEFAULTS, subscribeCodeSettings, readCodeSettings, saveCodeSettings, type CodeSettings as StoredCodeSettings } from "@/lib/code-settings";
import { foldMargin } from "@/components/code/fold-margin";
import { glyphMargin } from "@/components/code/gutters";
import { overviewRuler } from "@/components/code/overviewRuler";
import { api, API_BASE, fileDownloadUrl, startFileDownload, subscribeGlobalEvents, type DebugPaused, type FileSearchResponse, type GitBlame, type GitBlameLine, type GitRepo, type GitTree, type Workspace } from "@/lib/api";
import { useConfirm } from "@/components/Prompts";
import { Modal, ModalTitle, Overline, field, ghostSm, pillSm } from "@/components/CbKit";
import { createPortal } from "react-dom";
import { loadLanguage } from "@/components/codeLang";
import { editorExtensions, usePaletteHost } from "@/components/code/lsp-extension";
import { useLayoutAndProblems } from "@/components/code/layout-problems";
import { formattedText } from "@/components/code/lsp-format";
import { LspStatusLine } from "@/components/code/LspStatusLine";
import { lspLanguageOf } from "@/lib/api";
import { TerminalPanel } from "@/components/TerminalPanel";
import { terminalTitle } from "@/lib/terminal-list";
import { DebugView, DebugConsole } from "@/components/DebugPanel";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { type LayoutEnd, endFromEvent, newPath } from "@/lib/layout-paths";
import { CODE_INSTANCE_EVENT, takeCodeTarget, takeTerminalTarget } from "@/lib/code-show";
import { takeOverGitTree, useGitState } from "@/lib/git-state";
import { pathMatches, closeShortcutText, tabShortcut, type FileDraft, type DiffSource } from "@/lib/chat-tabs";
import { isMac } from "@/lib/chat-bar";
import { inShell } from "@/lib/shell-bridge";
import { allBuffers, draftForeign, saveAll, loadBuffer, type EditorHolder, type Buffer, type SaveError } from "@/lib/buffer";
import { inView, renameInView, useCoordinates, waitingText } from "@/components/code/coordinates";
import { BufferEditor, useBufferTabs, type BufferEditorRef, type StatusStorage } from "@/components/code/BufferEditor";
import { NavContext, WriteProtectionRow, useNavigation } from "@/components/code/navigation-connection";
import { ReferencesBar } from "@/components/code/ReferencesBar";
// The explorer like VS Code: state, drawing, header and problems in components/code/explorer/, the computations in
// lib/explorer-{tree,names,decoration}.ts; this file only connects it (tabs follow, git status, "reveal active file").
import { useExplorer } from "@/components/code/explorer/useExplorer";
import { ExplorerTree } from "@/components/code/explorer/ExplorerTree";
import { ActivityBar, type Mode } from "@/components/code/explorer/ExplorerHeader";
import { useTreeProblems } from "@/components/code/explorer/tree-problems";
import { cards as explorerCards } from "@/lib/explorer-decoration";
// Tabs, git margin, outline, search.
import { CodeTabBar, problemOfTheFile } from "@/components/code/TabBar";
import { LayoutContent } from "@/components/code/LayoutContent";
import { LayoutActions, useLayoutChoice } from "@/components/code/LayoutActions";
import { editorRow } from "@/components/code/md-sync";
import { ExplorerSections } from "@/components/code/explorer/ExplorerSections";
import { TimeAxisView, type TimeAxisOpen } from "@/components/code/explorer/TimeAxis";
import { SECTIONS_DEFAULT, type SectionId } from "@/lib/explorer-sections";
// What a tab holds (a file, the markdown preview of a file, a diff) is computed by lib/editor-inputs.ts; preview, diff,
// title buttons and the "..." menu are drawn by components/code/InputParts.tsx (preview via components/code/PreviewTab.tsx,
// the diff with the SAME building block as in the chat, components/code/DiffTab.tsx), an empty group shows the watermark like
// VS Code (components/code/Watermark.tsx); Cmd+S outside the surface and the scroll position live in components/code/view-locations.ts.
import * as E from "@/lib/editor-inputs";
import { rememberStartLine } from "@/components/code/PreviewTab";
import { DiffInput, EditorTitleButtons, PreviewInput, fileActions, inputDisplay, groupMenuItems, titleMenuItems, type FileTitle } from "@/components/code/InputParts";
import { titleSlot } from "@/lib/editor-title";
import { mapInWindow, reportFileFollowUp, useComparison, compareInGroups } from "@/components/code/comparison-connection";
import { saveLocation } from "@/components/code/view-locations";
import { Watermark, newThrow } from "@/components/code/Watermark";
import { isMarkdown, isPreviewKey } from "@/lib/md-preview";
import { SearchView, type SearchJump } from "@/components/code/SearchView";
import { globMasked } from "@/lib/file-search";
/** A jump from one line (1-based, column 0) or from start and end. */
const jumpFrom = (goto: number | SearchJump): SearchJump => (typeof goto === "number" ? { from: { line: goto - 1, character: 0 } } : goto);
import { Breadcrumbs, PathCrumbs } from "@/components/code/Breadcrumbs";
import { CursorEntry, FileDetails, ProblemCounter, StatusEntry, StatusBar } from "@/components/code/StatusBar";
import { gitMargin, useGitBase } from "@/components/code/git-gutter";
import { isGitKind, shortcutText, menuShortcut, openInList, closeSet as closeSetOf, type PathList, type CloseKind } from "@/lib/tab-bar";
import { cursorReporter } from "@/components/code/cursor-position";
// Panel and layout like VS Code: the lower panel (PROBLEMS, DEBUG CONSOLE, TERMINAL), the draggable side bar and the keys
// Cmd+B Cmd+J Shift+Cmd+E Shift+Cmd+F Shift+Cmd+M Ctrl+`; state and keys in components/code/panel/code-layout.ts, computations in lib/{panel-layout,problems-list}.ts.
import { keyForTheWorkbench, useCodeLayout, useLayoutConnection, usePagesWidth } from "@/components/code/panel/code-layout";
import { panelMaximized } from "@/lib/panel-layout";
import { LowerPanel } from "@/components/code/panel/LowerPanel";
import { DragBar } from "@/components/code/panel/DragBar";
import { useProblemCount } from "@/components/code/StatusBar";
// Editor groups like VS Code: computations in lib/editor-groups.ts, state/commands/keys in
// components/code/editor-groups-connection.ts, drawing in components/code/EditorGroups.tsx; this file only connects them.
import * as G from "@/lib/editor-groups";
import { useEditorGroups, useGroupsKeys } from "@/components/code/editor-groups-connection";
import { EditorGroupsSurface, GroupsEditor, GroupsButtons } from "@/components/code/EditorGroups";
import { rememberDrag, dragFrom } from "@/components/code/tab-transaction";
import { openEditorMenu, type MenuItem } from "@/components/code/EditorMenu";
import { matchesKey } from "@/lib/commandPalette";
import { WRAP_KEY } from "@/components/code/palette-host";
import { useFileHistory } from "@/components/code/palette-history";
import { isMissingReading } from "@/lib/file-status";
import { subscribeWrap, toggleWrap, wrapTick, wrapOf } from "@/lib/wrap-per-file";
import { rememberStatus, onlyGroups, statusesFrom, statusesText, type ViewStatuses, type ViewStatus } from "@/lib/view-status";
import { inTerminal } from "@/components/code/editor-groups-connection";
import { blameGutter, breakpointGutter, pausedLineDeco } from "@/components/code/editor-margins";
import { ImagePreview } from "@/components/code/ImagePreview";

// Editor settings: defaults, saving (only deviations) and reading in lib/code-settings.ts.
// `preview`: VS Code `workbench.editor.enablePreview` ("..." menu "Enable preview editors"); off: every file opens fixed.
type CodeSettings = StoredCodeSettings;

// Full code editor of a project: file explorer (lazy), several editor tabs, CodeMirror with syntax highlighting, multi-cursor,
// search and folding, saving (Cmd/Ctrl+S), create/rename/delete and full-text search over the project. Git status colours
// changed files.
//
// Layout: explorer and editor are not two glass surfaces. They sit borderless on the stage (the page gives the code tab no
// padding, app/workspaces/page.tsx), the editor is transparent (`codeTheme`) and so shows the page background; a hairline in
// `edge` separates explorer and editor, likewise tab row and editor surface, editor and lower panel, editor and status bar.
// In a narrow window the explorer still lies as a drawer over the editor, but flat: in the stage colour (`bg-panel`) with a
// hairline on the right instead of edge, rounding and shadow.

// A tab: what the file IS (image, binary, too large, read error). Its text, saved state, checksum, the "reload / keep mine"
// choice and the save error live in the file's BUFFER (lib/buffer.ts: ONE buffer per file in the window; the same file in
// Coding > Files and in a chat shows the same unsaved changes; the file-state computations of lib/file-status.ts are applied there).
type OpenFile = {
  path: string;
  loaded: boolean;
  error?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** Images are binary but are shown as a preview instead of being rejected as "binary file". */
  image?: boolean;
  mime?: string;
  size?: number;
  /** An adopted outline deleted the file: the tab stays (unsaved content), saving is blocked. */
  deleted?: boolean;
  /** The draft was too large to remember (`draft.write` returned false): the dot stays, the hint says so. */
  notRemembered?: boolean;
};

/**
 * The controlled form (code tabs in the chat): the tab list belongs to the chat (components/chat/chatTabs.ts, computation
 * lib/chat-tabs.ts). CodePane receives the open file paths of ITS target and the active one, reports open, keep, rename,
 * delete and unsaved back, and hides its own tab row. The content of open files stays here (`tabs`). Without `controlled`
 * (the Coding > Files page) everything stays as it was; web/test/chat-tabs.test.mjs asserts that the page stays
 * uncontrolled and that the controlled git status has no timer of its own.
 */
export type CodePaneControl = {
  /** The open file tabs of this target in order (paths relative to the target). */
  paths: readonly string[];
  /** The active file path of this target; null if no file tab of this target is in front ("Files", a diff). */
  active: string | null;
  /** Instead of the editor (a diff tab of this target, chat/DiffTabSwitch.tsx); the tree stays on the left. */
  content: React.ReactNode | null;
  /** Open a file: without `fixed` as a preview (one click in the tree), fixed on double click, new file and typing; `background`:
  *  fixed without coming to the front (rename/peek changed a file that had no tab here). */
  open: (path: string, o: { fixed: boolean; background?: boolean }) => void;
  keep: (path: string) => void;
  renamed: (old: string, fresh: string) => void;
  /** Deleted; `fromOutside`: the file was gone on "reload" (then every diff stays), otherwise deleted in the explorer. */
  deleted: (path: string, fromOutside: boolean) => void;
  /** The paths with their own unsaved changes (the dot on the tab). */
  reportUnsaved: (paths: string[]) => void;
  /** The git status of this target (path to kind); the chat bar uses it to colour the names of the file tabs. */
  reportGit?: (status: Readonly<Record<string, string>>) => void;
  /** Drafts per path: unsaved content survives chat switches and reloads. `write` returns false if it could not be remembered
  *  (too large, storage full). */
  draft: { read: (path: string) => FileDraft | null; write: (path: string, e: FileDraft | null) => boolean };
  /** Follow live: when `seq` grows, clean tabs reread (all if `paths` is null, otherwise the affected ones). */
  nudge: { seq: number; paths: readonly string[] | null };
  /** After every save: the holder nudges the other tabs of the SAME target; a diff tab of the same file rereads. */
  saved?: (path: string) => void;
  /** The tree is collapsed; remembered ONCE for all chats. In a narrow area it lies above as a drawer. */
  treeClosed: boolean;
  setTreeClosed: (closed: boolean) => void;
  /** The "Files" folder button of the bar: show or toggle (`seq` grows). */
  treeCommand: { seq: number; kind: "show" | "toggle"; at: number };
  /** Where the buttons of the active tab belong (the title row); null: they are nowhere. */
  actions: HTMLElement | null;
  /** The chat used to ask for the git status (`useGitState(apiBase, gitChat)`, the same data as the right bar); null: use
  *  the instance of this target. */
  gitChat: string | null;
  /** An entry of the time axis opens the diff tab of its commit for the file (a diff tab of the chat bar); `fixed`: double click. */
  openDiff?: (source: DiffSource, o: { title: string; short: string; fixed?: boolean }) => void;
  /** The markdown preview as a chat tab: Shift+Cmd+V on a .md file opens it (`open`), on the preview it returns to the source
  *  (`toSource`); `front` = the file of the preview currently in front (null: none); `lock` = "toggle preview lock" for it;
  *  `asPreview` = "open as preview" for the file in front (VS Code `markdown.reopenAsPreview`). */
  preview?: { front: string | null; open: (path: string) => void; toSource: () => void; lock: () => void; asPreview?: () => void };
  /** The chat's front tab as the key of the groups (lib/editor-inputs.ts `inputFromTab`); also a diff, so the time axis stays
  *  with its file on a diff (`timeAxisFile`); null: no tab of this target in front. */
  input?: string | null;
};

const GIT_COLOR: Record<string, string> = {
  modified: "text-warn",
  added: "text-ok",
  deleted: "text-danger",
  renamed: "text-accent",
  untracked: "text-ok",
  conflict: "text-danger",
};

const basename = (p: string) => p.split("/").filter(Boolean).pop() || p;
const parentDir = (p: string) => { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : ""; };

// `instance` is the chosen COPY of the code tab (the value for `instance=`, web/src/lib/code-instance.ts), `copy` its name;
// without both it is main. EVERY address in this file goes through `path` (or `call`); a call bypassing it would run from the
// copy into main (web/test/code-instance.test.mjs (f)). `onError` receives every error of a route: the area (CodeArea.tsx)
// visibly falls back to main on 404 `UNKNOWN_INSTANCE`. `onUnsaved` reports the number of tabs with unsaved changes (the choice
// asks before switching). The language service also applies in a copy: extensions, context menu, status line and command
// palette come from components/code/ (lsp-extension.ts, LspStatusLine.tsx, palette-host.ts).
// `active`: the code tab stays mounted on tab switch (workspaces/page.tsx); hidden, the git timer pauses, and on becoming
// visible CodeMirror measures again (in a hidden parent it measures 0 x 0).
export function CodePane({ apiBase, projectName, instance = null, copy = null, onError, onUnsaved, active: isActive = true, controlled = null, dismiss }: {
  apiBase: string; projectName: string; instance?: string | null; copy?: string | null; dismiss?: () => boolean; // `dismiss`: discard on unmount?
  onError?: (e: unknown) => void; onUnsaved?: (n: number) => void; active?: boolean;
  /** Code tabs in the chat: the tab list comes from outside; see `CodePaneControl`. The Files page passes nothing. */
  controlled?: CodePaneControl | null;
}) {
  const t = useT();
  const question = useConfirm();
  const resolvedTheme = useResolvedTheme();
  const [mode, setMode] = useState<Mode>("explorer");
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  // The tabs of the Files page live per GROUP (lib/editor-groups.ts): the active group provides the active tab and the preview
  // (italic; one click in the tree replaces it, double click, typing and unsaved content make it fixed; same rule as in the chat,
  // lib/tab-bar.ts over lib/chat-tabs.ts). `tabs` stays the set of open FILES (each once: load state, buffer).
  // Remembered per target; controlled (in the chat) there are no groups: the tab list belongs to the chat.
  const gr = useEditorGroups(controlled ? null : [apiBase, instance ?? ""].join("|")); // one key, no address (code-instance.test.mjs)
  const applyGroups = gr.apply;
  // A tab is a key (lib/editor-inputs.ts); `activePath` stays the FILE in front (null for a preview or a diff).
  const activeKeyIntern = G.activeGroup(gr.state).active;
  const activePathIntern = E.fileTab(activeKeyIntern);
  const area = useId(); // this CodePane: only its transactions (tabs, explorer) count (components/code/tab-transaction.ts)
  // Controlled, the chat decides which tab is in front; the own setters (rename, delete, outline) then only act internally.
  const activePath = controlled ? controlled.active : activePathIntern;
  // The time axis shows the file of the tab in front, also that of a diff (an entry opens its diff, the time axis stays);
  // in the chat taken from the key of its front tab (`controlled.input`).
  const timeAxisFile = E.timeAxisFile(controlled ? (controlled.input ?? activePath) : activeKeyIntern);
  // The file tabs that "open changes" came to on an UNTRACKED file (VS Code "{0} (Untracked)"), until their tab closes.
  const [untracked, setUntracked] = useState<ReadonlySet<string>>(() => new Set());
  const st = controlled;
  const stRef = useRef(st);
  stRef.current = st;
  // For each open tab the buffer of its file (held, subscribed; `bufferTick` grows per change); tabs name paths of THIS view, the buffer is canonical.
  const target = useMemo(() => ({ apiBase, instance: instance ?? null }), [apiBase, instance]);
  const location = useMemo(() => tabLocation(apiBase, instance ?? null), [apiBase, instance]); // tabs from another window (lib/tab-foreign.ts)
  const coord = useCoordinates(target), coordRef = useRef(coord);
  coordRef.current = coord;
  const { bufferOf, tick: bufferTick, change } = useBufferTabs(coord, tabs.map((x) => x.path), { dismiss });
  const pa = activePath ? bufferOf(activePath) : null;
  // Rename/peek changes a file that has no tab here: it joins as an unsaved tab in the background.
  const editorHolder = useMemo<EditorHolder>(() => ({
    openInBackground: (p: Buffer) => {
      const pf = inView(coordRef.current, p.target, p.path); if (pf === null) return; // another project, another instance
      if (stRef.current) stRef.current.open(pf, { fixed: true, background: true });
      else applyGroups((s) => G.openInBackground(s, pf)); // right of the active tab of the active group, without coming to the front
    },
  }), []);
  const [langByPath, setLangByPath] = useState<Record<string, Extension | null>>({});
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  // Index and working-tree status per file (`x`/`y`): the git margin fetches its base (the index) again when it changes.
  const [gitXY, setGitXY] = useState<Record<string, string>>({});
  const [gitRepos, setGitRepos] = useState<GitRepo[]>([]);
  // The repos have been read (also "none"); before that "the file lies in no repo" is UNKNOWN (empty is not unknown).
  const [gitRead, setGitRead] = useState(false);
  // Which sections of the explorer are open (ExplorerSections reports it); the outline only loads when it is visible.
  const [sectionOpen, setSectionOpen] = useState<Readonly<Record<SectionId, boolean>>>(SECTIONS_DEFAULT.open);
  // `fileStatus` grows on every save and every new git status: a preview without a buffer rereads the disk, a diff tab
  // rereads (follow live; a diff with unsaved content asks instead of overwriting, components/code/DiffTab.tsx).
  const [fileStatus, setFileStatus] = useState(0);
  // Where a group's diff tab puts its buttons (previous/next change, side by side/inline): right into the group's tab bar.
  // One stable callback per group; a new one per render would make React call it with null and the element every time, and the state would loop.
  const [diffLocations, setDiffLocations] = useState<Record<string, HTMLElement | null>>({});
  const diffLocationBack = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const diffLocationOf = (gid: string) => {
    let f = diffLocationBack.current.get(gid);
    if (!f) { f = (el) => setDiffLocations((m) => (m[gid] === el ? m : { ...m, [gid]: el })); diffLocationBack.current.set(gid, f); }
    return f;
  };
  // The shell name per terminal (the server reports it at start): the title like VS Code `${process}`.
  const [shellNames, setShellNames] = useState<Record<number, string>>({});
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<{ path: string; lines: GitBlameLine[] } | null>(null);
  const lay = useCodeLayout(); // the lower panel; `bottom` is the open tab (or null), `setBottom` shows or closes it
  const { bottom, setBottom } = lay;
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  const [debugId, setDebugId] = useState<string | null>(null);
  const [debugStatus, setDebugStatus] = useState<"starting" | "running" | "paused" | "terminated">("terminated");
  const [paused, setPaused] = useState<DebugPaused | null>(null);
  const [debugOutput, setDebugOutput] = useState<string[]>([]);
  const [watches, setWatches] = useState<{ expr: string; value?: string; error?: string }[]>([]);
  const debugIdRef = useRef<string | null>(null);
  const { outline, problems } = useLayoutAndProblems({ outlineOn: mode === "outline" || (mode === "explorer" && sectionOpen.layout), activePath, pa, problemsOn: bottom === "problems", tabs, bufferOf, bufferTick, change }); // bundled
  const [zen, setZen] = useState(false);
  // Below 900 px the explorer hides itself (and shows again when enlarged);
  // while it is open it lies as an overlay over the editor.
  const narrowCode = useAutoCollapse(900, !zen, useCallback((open: boolean) => setZen(!open), []));
  // Controlled (in the chat) the tree depends on the AREA, not the window: the code area sits next to the chat list and the
  // right bar, a window query would see 1,400 px where there are 700 (container instead of window). Below 640 px it lies above as a
  // drawer; otherwise the remembered collapse of all chats applies.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const isControlled = Boolean(controlled);
  useEffect(() => {
    const el = rootRef.current;
    if (!isControlled || !el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [isControlled]);
  const [treeDrawer, setTreeDrawer] = useState(false);
  const narrowControlled = isControlled && width > 0 && width < 640;
  const narrowRef = useRef(narrowControlled);
  narrowRef.current = narrowControlled;
  const treeHidden = controlled ? (narrowControlled ? !treeDrawer : controlled.treeClosed) : zen;
  const treeAsDrawer = controlled ? narrowControlled : narrowCode;
  // "Zen" pressed means the human switched the explorer off. In the narrow drawer form the collapsed tree is the
  // normal state, not Zen; there the button is never pressed.
  const zenPressed = controlled ? !narrowControlled && controlled.treeClosed : zen;
  const treeToggle = () => {
    if (!controlled) setZen((v) => !v);
    else if (narrowControlled) setTreeDrawer((v) => !v);
    else controlled.setTreeClosed(!controlled.treeClosed);
  };
  const treeShow = () => {
    if (!controlled) setZen(false);
    else if (narrowControlled) setTreeDrawer(true);
    else controlled.setTreeClosed(false);
  };
  const treeShowRef = useRef(treeShow); // for callbacks that outlive a render (the debug session stream)
  treeShowRef.current = treeShow;
  const commandSeq = controlled?.treeCommand.seq ?? 0;
  const commandSeen = useRef(commandSeq);
  useEffect(() => {
    const b = stRef.current?.treeCommand;
    const fresh = commandSeq !== commandSeen.current;
    commandSeen.current = commandSeq;
    if (!b || !isActive || !commandSeq) return;
    // On mounting only a "show" just given takes effect (the button is only now mounting the area), never an old command.
    if (!fresh && !(b.kind === "show" && Date.now() - b.at < 1500)) return;
    if (b.kind === "show") treeShow(); else treeToggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandSeq]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<CodeSettings>(CODE_DEFAULTS);
  // One view per group (own scroll position, own selection); `cmRef` is that of the ACTIVE group, read through the ref of the state, which
  // switches IMMEDIATELY on pointer down in a group (a Cmd-click in the other group already jumps in it).
  const views = useRef(new Map<string, React.MutableRefObject<BufferEditorRef | null>>());
  const viewOf = useCallback((gid: string) => {
    let r = views.current.get(gid);
    if (!r) { r = { current: null }; views.current.set(gid, r); }
    return r;
  }, []);
  const cmRef = useMemo(() => ({ get current(): BufferEditorRef | null { return viewOf(gr.ref.current.active).current; } }), [viewOf, gr.ref]);
  // Where the editor's cursor is, for the status bar and the outline that follows it (components/code/cursor-position.ts).
  // CodePane does NOT read the cursor itself (it would render per key); the parts that show it read it through this view.
  const activeView = useCallback(() => cmRef.current?.view ?? null, [cmRef]);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const filePath = useCallback((rest: string) => instancePath(`${apiBase}${rest}`, instance), [apiBase, instance]);
  const calls = useCallback(<T = unknown,>(rest: string, opts?: RequestInit): Promise<T> => api<T>(filePath(rest), opts).catch((e: unknown): never => {
    try { onErrorRef.current?.(e); } catch { /* the error stays that of the call */ }
    throw e;
  }), [filePath]);

  useEffect(() => {
    const read = () => { const s = readCodeSettings(); settingsRef.current = s; setSettings(s); };
    read();
    return subscribeCodeSettings(read); // another window or a second view changes it
  }, []);
  // Set and remember apart: never localStorage inside the updater (it runs twice in Strict Mode) and in try/catch (private window).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const updateSettings = (patch: Partial<CodeSettings>) => {
    const next = saveCodeSettings(patch); // only what deviates from the default is remembered
    settingsRef.current = next;
    setSettings(next);
  };
  // Alt+Z toggles wrapping ONLY for the file in front, transient (lib/wrap-per-file.ts); every group showing it rewraps.
  const wrapStatus = useSyncExternalStore(subscribeWrap, wrapTick, wrapTick);
  // The state of every view (selection, scroll position, folds) per group and file: it moves along on split and move and
  // survives reloads (lib/view-status.ts; remembered per target like the groups).
  const statusKey = controlled ? null : `cbase-code-views:${[apiBase, instance ?? ""].join("|")}`;
  const statuses = useRef<{ k: string | null; all: ViewStatuses } | null>(null);
  const statusesNow = () => {
    if (!statuses.current || statuses.current.k !== statusKey) {
      let all: ViewStatuses = {};
      try { all = statusKey ? statusesFrom(localStorage.getItem(statusKey)) : {}; } catch { /* without storage: none */ }
      statuses.current = { k: statusKey, all };
    }
    return statuses.current;
  };
  const statusStorageFor = (gid: string): StatusStorage => ({
    read: (s) => statusesNow().all[gid]?.[s] ?? null,
    remember: (s, st) => {
      const x = statusesNow();
      x.all = onlyGroups(rememberStatus(x.all, gid, s, st), gr.ref.current.groups.map((g) => g.id));
      try { if (x.k) localStorage.setItem(x.k, statusesText(x.all)); } catch { /* only for this session */ }
    },
  });
  /** The state of the file `path` if group `gid` is currently showing it. */
  const statusInGroup = (gid: string, path: string | null): ViewStatus | null =>
    path && E.isFileTab(path) && G.groupOf(gr.ref.current, gid)?.active === path ? viewOf(gid).current?.status?.() ?? null : null;
  /** ... and hand it to group `gid` (it is about to show the file for the first time). */
  const giveState = (gid: string, path: string | null, st: ViewStatus | null) => {
    const p = path && E.isFileTab(path) ? bufferOf(path) : null;
    if (st && p) statusStorageFor(gid).remember(p.key, st);
  };

  // ── File tree (explorer like VS Code, components/code/explorer/useExplorer.ts) ──
  // Renamed, moved or deleted in the tree: the feedback runs through arrows that only call on the event; the functions behind them
  // are further below (tabs, git).
  const gitKey = useMemo(() => Object.entries(gitStatus).map(([p, k]) => `${k} ${p}`).sort().join("\n"), [gitStatus]);
  const ex = useExplorer({
    apiBase, instance, calls, active: isActive, gitKey,
    onOpen: (p, fixed) => void openFile(p, undefined, fixed),
    onOpenBeside: controlled ? undefined : (p) => openBeside(p),
    onRenamed: (old, fresh) => followUpRenamed(old, fresh),
    onDeleted: (p) => followUpDeleted(p),
    onChanged: () => void refreshGit(),
    // Unsaved buffers in paths of this view: deleting then warns like VS Code (the buffer applies window-wide).
    unsaved: () => allBuffers().filter((p) => p.dirty).map((p) => inView(coordRef.current, p.target, p.path)).filter((p): p is string => p !== null),
  });
  // The tree selection: a tab that comes to the front selects its file.
  const setSelected = ex.select;
  const showInTree = ex.reveal, rehomeTree = ex.rehome;
  // "Find in folder..." opens the search: it opens, and `searchFolder` (a new `seq` per request) is the folder for
  // "files to include" (`./folder` = from the root; SearchView `preset`).
  const [searchFolder, setSearchFolder] = useState<{ path: string; seq: number } | null>(null);
  const searchInFolder = useCallback((p: string) => { setSearchFolder((s) => ({ path: p, seq: (s?.seq ?? 0) + 1 })); setMode("search"); }, []);

  const applyGitTree = useCallback((t: GitTree) => {
    const map: Record<string, string> = {}, xy: Record<string, string> = {};
    for (const repo of t.repos || []) {
      for (const c of repo.changes || []) {
        const key = repo.relPath ? `${repo.relPath}/${c.path}` : c.path;
        map[key] = c.kind;
        xy[key] = `${c.x ?? ""}${c.y ?? ""}`;
      }
    }
    setGitStatus(map);
    setGitXY(xy);
    setGitRepos(t.repos || []);
    setGitRead(true);
  }, []);
  // Controlled (in the chat) the area reads the git status from the shared store (lib/git-state.ts), that of the chat if this is its target,
  // so the same fetch as the right bar: NO timer of its own (the setInterval below only runs uncontrolled). Hidden, it does not ask.
  const gitState = useGitState(controlled && isActive ? apiBase : null, controlled?.gitChat ?? null, controlled?.gitChat ? null : instance);
  const gitRefresh = useRef(gitState.refresh);
  gitRefresh.current = gitState.refresh;
  const refreshGit = useCallback(async () => {
    if (stRef.current) { await gitRefresh.current(); return; }
    try {
      applyGitTree(await calls<GitTree>(`/git`));
    } catch { /* no git, no decoration */ }
  }, [calls, applyGitTree]);
  // "Stage change" in the quick-diff peek returns the fresh tree; margin, explorer and (in the chat) the right bar adopt it.
  const gitChat = controlled?.gitChat ?? null;
  const afterGitAction = useCallback((t: GitTree) => {
    if (stRef.current) takeOverGitTree(apiBase, gitChat, gitChat ? null : instance, t);
    else applyGitTree(t);
  }, [apiBase, gitChat, instance, applyGitTree]);

  useEffect(() => { stRef.current?.reportGit?.(gitStatus); }, [gitStatus]); // the chat bar colours its tabs with it
  // File (project-relative) to responsible repo (longest matching relPath).
  const repoForPath = useCallback((p: string): GitRepo | null => {
    let best: GitRepo | null = null;
    for (const r of gitRepos) {
      if (r.relPath === "" || p === r.relPath || p.startsWith(r.relPath + "/")) {
        if (!best || (r.relPath?.length ?? 0) > (best.relPath?.length ?? 0)) best = r;
      }
    }
    return best;
  }, [gitRepos]);

  // The repos' state (a new commit rereads the time axis) and opening an entry: a diff tab, in the chat in its bar, on the page in the
  // active group; a click as preview (italic, the next replaces it), a double click fixed.
  const gitReposState = gitRepos.map((r) => `${r.relPath}@${r.lastCommit?.hash ?? ""}`).join("|");
  /** Does tab `k` carry unsaved content? A file and a diff of the unstaged change show their buffer. */
  const dirtyOf = useCallback((k: string) => { const d = E.bufferFile(k); return d !== null && Boolean(bufferOfRef.current(d)?.dirty); }, []);
  const openTimeAxis = useCallback<TimeAxisOpen>((source, o) => {
    if (stRef.current) { stRef.current.openDiff?.(source, o); return; }
    const fixed = Boolean(o.fixed) || !settingsRef.current.preview; // VS Code `enablePreview: false`: every editor opens fixed
    applyGroups((s) => G.open(s, E.diffKey(source, o.title), { fixed, unsaved: dirtyOf }));
  }, [applyGroups, dirtyOf]);
  // "Select for compare" in explorer and time axis, opened like a time-axis diff; ONE selection in the window; a rename/delete in another
  // area updates the groups' comparisons (in the chat chat/chatTabs.ts does that).
  const comparison = useComparison(target, openTimeAxis, t, { area, followUp: controlled ? undefined : (e) => applyGroups(compareInGroups(e, dirtyOf)) });
  const followUpLocation = { target, map: mapInWindow };
  // The markdown preview is a TAB (lib/editor-inputs.ts). Shift+Cmd+V (VS Code `markdown.showPreview`): on a .md file the preview
  // right next to it in the SAME group, at the line at the top of the editor, with focus; on the preview back to the source
  // (`markdown.showSource`). An unlocked preview of the group takes the new file in its place (at most one per group).
  const editorRowIn = (gid: string): number | undefined => {
    const v = viewOf(gid).current?.view;
    return v && v.dom.getClientRects().length > 0 ? editorRow(v) : undefined;
  };
  // "Open preview" in the explorer on a markdown file (VS Code `markdown.showPreview`, explorer/context): the preview as a tab; in the
  // chat through the control, otherwise in the ACTIVE group (like Shift+Cmd+V).
  function previewFromExplorer(path: string) {
    const st = stRef.current;
    if (st) { st.preview?.open(path); return; }
    const s0 = gr.ref.current;
    if (applyGroups((x) => E.openPreview(x, x.active, path)) !== s0) focusWish.current = gr.ref.current.active;
  }
  function previewToggle() {
    const st = stRef.current;
    if (st) {
      if (st.preview?.front) st.preview.toSource();
      else if (activePath && isMarkdown(activePath)) { rememberStartLine(E.previewKey(activePath), editorRowIn(G.BEGINNING.groups[0].id)); st.preview?.open(activePath); }
      return;
    }
    const s = gr.ref.current, gid = s.active, k = G.groupOf(s, gid)?.active ?? null, e = k ? E.inputOf(k) : null;
    if (!k || !e) return;
    if (e.kind === "preview") { if (applyGroups((x) => E.toSource(x, gid, k)) !== s) focusWish.current = gid; return; }
    if (e.kind !== "file" || !isMarkdown(e.path)) return;
    rememberStartLine(E.previewKey(e.path), editorRowIn(gid));
    if (applyGroups((x) => E.openPreview(x, gid, e.path)) !== s) focusWish.current = gid;
    else rememberStartLine(E.previewKey(e.path), null); // nothing opened: no entry stays that would later jump to an old place
  }
  /** "Open source file" (VS Code `markdown.showSource`, title bar button of a preview), in the preview's group. */
  const sourceOpen = (gid: string, key: string) => {
    const prior = gr.ref.current; // `apply` sets the ref immediately; compare with the state before
    if (applyGroups((x) => E.toSource(G.activateGroup(x, gid), gid, key)) !== prior) focusWish.current = gid;
  };
  // "Markdown: toggle preview lock" (VS Code `markdown.preview.toggleLock`): the preview in front in the active group, otherwise the first one
  // that follows (the most recently used, like VS Code `activePreview`).
  const lockTargetIn = (s: G.GroupsStatus): { gid: string; key: string } | null => {
    const a = G.groupOf(s, s.active)?.active;
    if (a && E.inputOf(a)?.kind === "preview") return { gid: s.active, key: a };
    for (const g of s.groups) { const d = E.followingPreview(g); if (d) return { gid: g.id, key: d }; }
    return null;
  };
  const toggleLock = (z: { gid: string; key: string }) => applyGroups((s) => E.toggleLock(s, z.gid, z.key));

  // Load the blame of the active file when switched on.
  useEffect(() => {
    if (!blameOn || !activePath) { return; }
    const t = tabs.find((x) => x.path === activePath);
    if (!t || !t.loaded || t.binary || t.tooLarge) return;
    const repo = repoForPath(activePath);
    if (!repo) { setBlame({ path: activePath, lines: [] }); return; }
    const relFile = repo.relPath ? activePath.slice(repo.relPath.length + 1) : activePath;
    let alive = true;
    calls<GitBlame>(`/git/blame`, { method: "POST", body: JSON.stringify({ repo: repo.relPath, file: relFile }) })
      .then((b) => { if (alive) setBlame({ path: activePath, lines: b.lines }); })
      .catch(() => { if (alive) setBlame({ path: activePath, lines: [] }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blameOn, activePath, calls, repoForPath, tabs.find((x) => x.path === activePath)?.loaded]);
  useEffect(() => {
    // Hidden: no timer; on becoming visible a fresh state at once. Never when controlled: there `gitState` reads the store.
    if (!isActive || isControlled) return;
    refreshGit();
    const onFocus = () => refreshGit();
    window.addEventListener("focus", onFocus);
    const t = setInterval(refreshGit, 8000);
    return () => { window.removeEventListener("focus", onFocus); clearInterval(t); };
  }, [refreshGit, isActive, isControlled]);
  // On becoming visible CodeMirror measures again; hidden, its parent had no size.
  useEffect(() => { if (isActive) for (const r of views.current.values()) r.current?.view?.requestMeasure(); }, [isActive]); // every group

  // After an adopted outline (project setup): tabs, selection, expanded folders and breakpoints move to the new paths; a tab of a
  // deleted file stays as "deleted" (its unsaved content would otherwise be lost) and no longer saves, otherwise `files/write` would
  // silently recreate the old place. At workspace level the project lies under its folder in the workspace (`projects[].path` relative
  // to `path`); there is no copy during a job. The final mapping comes from `GET .../outline/job` (`report.end` with `at`), applied once
  // per end, even if the stream lost the event (on reconnect and on becoming visible the project area asks again).
  const projectId = /^\/api\/projects\/([^/]+)$/.exec(apiBase)?.[1] ?? null;
  const workspaceId = /^\/api\/workspaces\/([^/]+)$/.exec(apiBase)?.[1] ?? null;
  // Per project the most recently applied end (or the one already present on open); `undefined` = not read yet.
  const layoutEnd = useRef<Record<string, number | undefined>>({});
  const applyLayout = useCallback((end: LayoutEnd, prefix: string) => {
    const form = (p: string): string | null => {
      if (!prefix) return newPath(p, end);
      if (p !== prefix && !p.startsWith(`${prefix}/`)) return p;
      const n = newPath(p === prefix ? "" : p.slice(prefix.length + 1), end);
      return n === null ? null : n ? `${prefix}/${n}` : prefix;
    };
    for (const x of tabsRef.current) { const n = form(x.path); if (n && n !== x.path) renameInView(coordRef.current, x.path, n); } // the buffer moves along
    setTabs((prev) => prev.map((x) => {
      const n = form(x.path);
      if (n === null) return x.deleted ? x : { ...x, deleted: true };
      return n === x.path ? x : { ...x, path: n };
    }));
    applyGroups((s) => E.followRename(s, (p) => form(p) ?? p, followUpLocation, false, dirtyOf)); // every group follows (a deleted file stays as a tab; previews and diffs follow)
    setBreakpoints((prev) => {
      const n: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(prev)) { const z = form(k); if (z !== null) n[z] = v; }
      return n;
    });
    setLangByPath((prev) => {
      const n: Record<string, Extension | null> = {};
      for (const [k, v] of Object.entries(prev)) { const z = form(k); if (z !== null) n[z] = v; }
      return n;
    });
    rehomeTree(form); // selection and expanded folders to the new paths, the tree rereads
    setBlame(null);
    refreshGit();
  }, [rehomeTree, refreshGit, applyGroups]);
  /** Read the end of the job of `pid` and apply it if newer than the last one seen. `firstTime` = only remember. */
  const bringAlongLayout = useCallback(async (pid: string, firstTime: boolean) => {
    let prefix = "";
    if (workspaceId) {
      try {
        const ws = (await api<Workspace[]>("/api/workspaces")).find((w) => w.id === workspaceId);
        const proj = ws?.projects.find((x) => x.id === pid);
        if (!ws || !proj) return; // a project of another workspace
        const root = ws.path.replace(/\/+$/, "");
        if (!proj.path.startsWith(`${root}/`)) return;
        prefix = proj.path.slice(root.length + 1).replace(/\/+$/, "");
      } catch { return; }
    }
    let end: { at?: number; ways?: { old: string; fresh: string }[]; gone?: string[] } | null | undefined;
    try {
      const r = await api<{ job: { state: string; report?: { end?: typeof end } | null } }>(`/api/projects/${pid}/layout/job`);
      end = r.job?.state === "finished" ? r.job.report?.end : null;
    } catch (e) {
      if ((e as { code?: string }).code === "NO_JOB") end = null;
      else return;
    }
    const at = typeof end?.at === "number" ? end.at : 0;
    const soFar = layoutEnd.current[pid];
    layoutEnd.current[pid] = Math.max(at, soFar ?? 0);
    if (firstTime && soFar === undefined) return;
    if (!end || at <= (soFar ?? 0)) return;
    applyLayout(endFromEvent({ mapping: end.ways, gone: end.gone }), prefix);
  }, [workspaceId, applyLayout]);
  // Controlled (in the chat) the area does not yet follow an adopted outline (the tab list belongs to the chat there and
  // would have to follow); the Files page does.
  const withoutLayout = Boolean(instance) || (!projectId && !workspaceId) || isControlled;
  // Project area: remember the state on open (an older end does not belong to the tabs open now).
  useEffect(() => {
    if (withoutLayout || !projectId) return;
    void bringAlongLayout(projectId, true);
  }, [withoutLayout, projectId, bringAlongLayout]);
  useEffect(() => {
    if (withoutLayout) return;
    const off = subscribeGlobalEvents((evt) => {
      // Reconnected: an end may have fallen into the gap.
      if (evt.type === "init") { if (projectId && layoutEnd.current[projectId] !== undefined) void bringAlongLayout(projectId, false); return; }
      if (evt.type !== "project/layout" || evt.kind !== "finished") return;
      const pid = String(evt.projectId ?? "");
      if (!pid || (projectId && pid !== projectId)) return;
      void bringAlongLayout(pid, false);
    });
    const visible = () => { if (document.visibilityState === "visible" && projectId) void bringAlongLayout(projectId, false); };
    document.addEventListener("visibilitychange", visible);
    return () => { off(); document.removeEventListener("visibilitychange", visible); };
  }, [withoutLayout, projectId, bringAlongLayout]);
  // "Open in code tab" from the outline (lib/code-show.ts): expand the folders down to the repo (and the repo itself) and select it.
  useEffect(() => {
    if (!projectId || !isActive || isControlled) return; // the request is for the Files page, not for the code area of a chat
    const show = () => {
      const target = takeCodeTarget(projectId);
      if (target === null) return;
      showInTree(target, true, true); // explicitly: also under node_modules (VS Code `select(..., "force")`)
      setMode("explorer");
    };
    show();
    window.addEventListener("cbase-code-show", show);
    return () => window.removeEventListener("cbase-code-show", show);
  }, [projectId, isActive, isControlled, showInTree]);
  // "Terminal" from the "Instances" tab (lib/code-show.ts): open the lower terminal, only if the request is for THIS instance
  // (a CodePane of the old instance sees the event before the switch and leaves it; the new one picks it up on mounting).
  useEffect(() => {
    if (!projectId || !isActive || isControlled) return;
    const terminal = () => { if (takeTerminalTarget(projectId, instance ?? null)) setBottom("terminal"); };
    terminal();
    window.addEventListener(CODE_INSTANCE_EVENT, terminal);
    return () => window.removeEventListener(CODE_INSTANCE_EVENT, terminal);
  }, [projectId, isActive, instance, isControlled]);

  // ── Open file ──
  // `fixed` (controlled): double click in the tree and a new file open a fixed tab, everything else a preview.
  // `goto`: a line (1-based, column 0) or a jump with column and end; the search hit is marked, the outline jumps
  // to the symbol's name.
  // `focus: false` (VS Code `preserveFocus`, Cmd+P in the background): the jump does not take focus.
  const openFile = useCallback(async (path: string, goto?: number | SearchJump, fixedDesired = false, focus = true) => {
    const fixed = fixedDesired || !settingsRef.current.preview; // VS Code `enablePreview: false`: every file opens fixed
    if (goto) nav.connection.rememberJump(path, jumpFrom(goto).from, undefined, { until: jumpFrom(goto).until ?? null, focus }); // with a history entry; the jump happens as soon as it is in front
    if (stRef.current) {
      setSelected(path);
      stRef.current.open(path, { fixed });
      if (narrowRef.current) setTreeDrawer(false); // the drawer frees the editor as soon as something is open
      return;
    }
    setSelected(path);
    // Without `fixed` a preview (replaces the old one in its place unless it carries unsaved content), fixed on double click and new
    // file. Loading happens below (`loadTab`, both forms); an already open tab (and its buffer) stays as it is.
    applyList((l) => openInList(l, path, { fixed, unsaved: dirtyOf }));
  }, []);
  // Navigation (components/code/navigation-connection.tsx): back/forward history, "references" mode, places (also external) as a tab.
  const nav = useNavigation({ coordinates: coord, activePath, openTab: (p) => void openFile(p), mainView: () => cmRef.current?.view ?? null, showBar: () => { setMode("references"); treeShow(); }, showFolder: (p) => showInExplorer(p) });

  const active = tabs.find((t) => t.path === activePath) || null;
  // The number of tabs with unsaved changes; the instance choice asks before switching (CodeArea.tsx).
  const unsaved = tabs.filter((x) => x.loaded && bufferOf(x.path)?.dirty).length;
  useEffect(() => { onUnsaved?.(unsaved); }, [unsaved, onUnsaved]);
  const textFront = Boolean(!controlled?.content && active?.loaded && !active.binary && !active.tooLarge && !active.error && pa?.status.state === "loaded");

  // ── Controlled (code tabs in the chat) ──
  // (1) The tab list comes from outside: a new path gets an empty tab (it loads below), a closed one drops out with its content;
  //     the chat asked beforehand (chat/chatTabs.ts), and forgets the draft in doing so.
  const pathsKey = controlled ? controlled.paths.join("\n") : null;
  useEffect(() => {
    const s = stRef.current;
    if (!s) return;
    setTabs((prev) => {
      const old = new Map(prev.map((x) => [x.path, x]));
      const next = s.paths.map((p) => old.get(p) ?? { path: p, content: "", saved: "", loaded: false });
      return next.length === prev.length && next.every((x, i) => x === prev[i]) ? prev : next;
    });
  }, [pathsKey]);
  // "Reveal active file" (VS Code `explorer.autoReveal`, both forms): when the tab changes (also after Cmd+P, a jump, a search),
  // the tree expands the parent folders, selects the file and scrolls it into view.
  useEffect(() => {
    if (!activePath || activePath.startsWith("/")) return; // a target outside the instance is in no tree
    showInTree(activePath);
  }, [activePath, showInTree]);
  // (2) Loading (both forms) through the file's buffer (lib/buffer.ts, inside it lib/file-status.ts): if it is already open in the
  //     window (the same file in Coding > Files or another chat), its state counts and a remembered draft is done. Otherwise a draft
  //     comes back WITH its base: if it still rests on the disk it is simply unsaved; otherwise the "reload / keep mine" choice
  //     stands; if the file is gone it stays with the "deleted" hint.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // The tabs of the Files page as a list (order, active, preview): every change through lib/tab-bar.ts so the preview rule exists
  // ONCE; the list of the ACTIVE group (lib/editor-groups.ts).
  const bufferOfRef = useRef(bufferOf);
  bufferOfRef.current = bufferOf;
  const applyList = useCallback((f: (l: PathList) => PathList) => { applyGroups((s) => G.changeActive(s, f)); }, [applyGroups]);
  // The open files of all groups: a new path gets an empty tab (it loads below), a dropped one falls away with its content.
  // Before painting (`useLayoutEffect`), otherwise a just-opened tab would stand there for one frame without a file. Held are
  // the files of the file tabs AND of the diffs of the unstaged change (they show the same buffer: its unsaved content survives a
  // tab switch, and only whoever closes the last one is asked); a preview holds nothing (lib/editor-inputs.ts `heldFiles`).
  const openKey = controlled ? null : E.heldFiles(gr.state).join("\n");
  useLayoutEffect(() => {
    if (openKey === null) return;
    const desired = openKey ? openKey.split("\n") : [];
    setTabs((prev) => {
      const old = new Map(prev.map((x) => [x.path, x]));
      const next = desired.map((p) => old.get(p) ?? { path: p, loaded: false });
      return next.length === prev.length && next.every((x, i) => x === prev[i]) ? prev : next;
    });
    const files = new Set(E.openFiles(gr.ref.current));
    setUntracked((m) => ([...m].every((p) => files.has(p)) ? m : new Set([...m].filter((p) => files.has(p)))));
  }, [openKey]);
  // A preview with unsaved content is fixed (VS Code), in every group.
  useEffect(() => {
    if (!isControlled) applyGroups((s) => G.tidyPreview(s, dirtyOf));
  }, [bufferTick, gr.state, isControlled, applyGroups]);
  const langRef = useRef(langByPath);
  langRef.current = langByPath;
  const loading = useRef(new Set<string>());
  const written = useRef(new Map<string, { base: string; content: string; sha: string | null }>());
  const loadTab = useCallback(async (path: string) => {
    const k = coordRef.current.toCanon(path); if (!k) return; // mapping not known yet (empty is not unknown); loaded as soon as it is there
    loading.current.add(path);
    if (!(path in langRef.current)) loadLanguage(basename(path)).then((ext) => setLangByPath((p) => ({ ...p, [path]: ext })));
    try {
      const r = await loadBuffer(k.target, k.path, { draft: stRef.current?.draft.read(path) ?? null, onError: (e) => onErrorRef.current?.(e) });
      // A file restored from storage that no longer exists loses its tab (with a draft no error comes).
      if (r.kind === "error" && isMissingReading(r.error) && gr.restored.current.delete(path)) { applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path))); return; }
      gr.restored.current.delete(path);
      if (r.kind === "text" && r.draft === "done") { stRef.current?.draft.write(path, null); written.current.delete(path); }
      if (r.kind === "text" && r.draft === "takenOver") written.current.set(path, { base: r.buffer.status.saved, content: r.buffer.text, sha: r.buffer.status.base });
      setTabs((prev) => prev.map((x) => x.path !== path ? x
        : r.kind === "file" ? { ...x, loaded: true, binary: r.binary, tooLarge: r.tooLarge, image: r.image, mime: r.mime, size: r.size, error: undefined }
          : r.kind === "error" ? { ...x, loaded: true, error: String((r.error as Error)?.message ?? r.error) } : { ...x, loaded: true, error: undefined }));
    } finally {
      loading.current.delete(path);
    }
  }, []);
  useEffect(() => {
    if (!isActive) return;
    for (const x of tabs) if (!x.loaded && !loading.current.has(x.path)) void loadTab(x.path);
  }, [tabs, isActive, loadTab, coord.state]);
  // (3) Remember drafts: one per tab with own changes (base + content + their checksum), a clean tab forgets its own.
  //     Bundled after a short pause, immediately on unmount (chat switch) and on leaving the page (reload).
  const saveDrafts = useCallback(() => {
    const s = stRef.current;
    if (!s) return;
    const notRemembered = new Map<string, boolean>();
    for (const x of tabsRef.current) {
      const p = bufferOf(x.path);
      if (!x.loaded || x.binary || x.tooLarge || x.image || x.error || p?.status.state !== "loaded") continue;
      const last = written.current.get(x.path);
      const { saved, text, base: sha } = p.status;
      if (p.dirty) {
        if ((last && last.base === saved && last.content === text && last.sha === sha) || (!last && draftForeign(s.draft.read(x.path), p))) continue; // a foreign draft stays
        // false = not remembered (too large, storage full): the dot stays, the hint stands (chat/chatTabs.ts then keeps it
        // in the page's memory: it survives a chat switch, not a reload).
        const ok = s.draft.write(x.path, { base: saved, content: text, at: Date.now(), buffer: p.buffer, ...(sha ? { sha } : {}) });
        written.current.set(x.path, { base: saved, content: text, sha });
        notRemembered.set(x.path, !ok);
      } else if (last) {
        s.draft.write(x.path, null);
        written.current.delete(x.path);
        notRemembered.set(x.path, false);
      }
    }
    if (notRemembered.size) setTabs((prev) => prev.map((x) => (notRemembered.has(x.path) && Boolean(x.notRemembered) !== notRemembered.get(x.path)
      ? { ...x, notRemembered: notRemembered.get(x.path) || undefined } : x)));
  }, [bufferOf]);
  useEffect(() => {
    if (!isControlled) return;
    let h = setTimeout(saveDrafts, 300);
    const off = change.subscribe(() => { clearTimeout(h); h = setTimeout(saveDrafts, 300); }); // per key, without rendering
    return () => { off(); clearTimeout(h); };
  }, [tabs, bufferTick, isControlled, saveDrafts, change]);
  useEffect(() => {
    if (!isControlled) return;
    const flush = () => saveDrafts();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); saveDrafts(); stRef.current?.reportUnsaved([]); };
  }, [isControlled, saveDrafts]);
  // (4) The dot on the tab: the paths whose buffer carries unsaved content, immediately (the draft follows bundled).
  const dirtyKey = isControlled ? tabs.filter((x) => bufferOf(x.path)?.dirty).map((x) => x.path).join("\n") : ""; // also unloaded ones (rename/peek)
  useEffect(() => { stRef.current?.reportUnsaved(dirtyKey ? dirtyKey.split("\n") : []); }, [dirtyKey]);
  // (5) Follow live: a nudge (turn end, edit/write with this path) or a new git status makes the affected buffers look again
  //     (lib/buffer.ts, lib/file-status.ts): a clean one takes over silently, one with its own text is NEVER replaced; another
  //     disk or a deleted file waits as a choice. Hidden, it is collected and looked at on becoming visible; no timer of its own.
  const checkBack = useRef<{ all: boolean; paths: Set<string> }>({ all: false, paths: new Set() });
  const readNew = useCallback(async () => {
    const open = checkBack.current;
    if (!open.all && open.paths.size === 0) return;
    checkBack.current = { all: false, paths: new Set() };
    const affected = tabsRef.current.filter((x) => x.loaded && !x.binary && !x.tooLarge && !x.image && !x.error && !x.deleted
      && (open.all || [...open.paths].some((g) => pathMatches(x.path, g))));
    await Promise.all(affected.map((x) => bufferOf(x.path)?.checkBack({ onError: (e) => onErrorRef.current?.(e) })));
  }, [bufferOf]);
  const nudgeSeq = controlled?.nudge.seq ?? 0;
  useEffect(() => {
    const a = stRef.current?.nudge;
    if (!a || !nudgeSeq) return;
    if (a.paths === null) checkBack.current.all = true;
    else for (const p of a.paths) checkBack.current.paths.add(p);
    if (isActive) void readNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudgeSeq]);
  useEffect(() => { if (isActive && isControlled) void readNew(); }, [isActive, isControlled, readNew]);
  const gitTreeFirst = useRef(true);
  useEffect(() => {
    if (!isControlled || !gitState.tree) return;
    applyGitTree(gitState.tree);
    if (gitTreeFirst.current) { gitTreeFirst.current = false; return; }
    checkBack.current.all = true; // the target's state changed; the open tabs look again
    if (isActive) void readNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitState.tree]);
  // "Reload" takes the disk including its checksum; "keep mine" is deliberate overwriting (lib/buffer.ts).
  // For a deleted file: "discard" closes the tab, "keep mine" recreates it on save.
  const keepChanged = (path: string, loadAgain: boolean) => {
    const p = bufferOf(path);
    if (!p) return;
    const deleted = p.status.inquiry?.kind === "deleted";
    if (loadAgain) p.loadAgain(); else p.keep();
    if (deleted && loadAgain) {
      if (stRef.current) { stRef.current.draft.write(path, null); stRef.current.deleted(path, true); }
      else applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path))); // in every group (with the preview; a diff stays)
      return;
    }
    // The button disappears with the hint; without this focus would fall to the document and Cmd+S would go nowhere.
    requestAnimationFrame(() => cmRef.current?.view?.focus());
  };

  // Typed in THIS view (not an echo of the buffer): a preview tab becomes fixed.
  const onEditorInput = useCallback((p: Buffer) => {
    const pf = inView(coordRef.current, p.target, p.path);
    if (pf === null) return;
    if (stRef.current) stRef.current.keep(pf);
    else applyGroups((s) => G.keep(s, pf)); // typing makes the preview fixed (in every group where it is a preview)
  }, [applyGroups]);
  // The buffer's save error as a line above the editor (the text stays visible).
  const storageErrorText = (f: SaveError) => (f.kind === "first-select" ? t("Choose first: reload or keep your changes.")
    : f.kind === "changed" ? t("Not saved: the file has changed in the meantime.") : t("Saving failed: {msg}", { msg: f.text }));

  // Saving through the buffer (lib/buffer.ts): with `base` (409 means nothing written, reread, the choice stands), an open
  // choice holds Cmd+S back, keys between Cmd+S and the response stay unsaved. Format on save (same path as Alt+Shift+F,
  // components/code/lsp-format.ts) only applies while the buffer still shows what was formatted.
  const saveFile = useCallback(async (path: string) => {
    const t0 = tabsRef.current.find((x) => x.path === path), p = bufferOf(path);
    if (!t0 || !t0.loaded || t0.binary || t0.tooLarge || t0.deleted || !p) return;
    const r = await p.save({
      prior: settings.formatOnSave ? (content) => formattedText(p, content, { tabSize: settings.tabSize }) : undefined,
      onError: (e) => onErrorRef.current?.(e),
    });
    if (r.kind !== "saved") return;
    stRef.current?.saved?.(path); // the other tabs of this target (a diff of the same file) reread
    setFileStatus((n) => n + 1); // likewise the diffs and previews of the groups
    refreshGit();
  }, [refreshGit, settings.formatOnSave, settings.tabSize, bufferOf]);
  // Alt+Cmd+S: every unsaved buffer of the window, per file with `base`; a 409 leaves only that file unsaved, its hint stands.
  const allSave = useCallback(async () => {
    const r = await saveAll({ onError: (e) => onErrorRef.current?.(e) });
    for (const { buffer: p, result } of r) { const pf = inView(coordRef.current, p.target, p.path); if (result.kind === "saved" && pf !== null) stRef.current?.saved?.(pf); }
    if (r.length) { setFileStatus((n) => n + 1); refreshGit(); }
  }, [refreshGit]);
  // The side bar width and the layout keys (entered in the command table, in the palette, at the root).
  const pagesWidth = usePagesWidth(lay, rootRef, treeToggle); // hidden below half the minimum width
  const layConn = useLayoutConnection(lay, { root: rootRef, active: isActive, pageFiles: !isControlled, editor: () => cmRef.current?.view ?? null,
    page: { visible: !treeHidden, mode: mode, setMode: setMode, toggle: treeToggle, show: treeShow } });
  // The layout commands and, on a .md file, "Markdown: open preview" ("... to the side" is a group command, Cmd+K V); on a
  // preview "Markdown: open source file", and as long as one exists "Markdown: toggle preview lock".
  const lockTarget = controlled ? null : lockTargetIn(gr.state);
  const previewFront = controlled ? Boolean(controlled.preview?.front) : E.inputOf(activeKeyIntern ?? "")?.kind === "preview";
  const paletteAddition = [
    ...layConn.paletteCommands,
    ...(isMarkdown(activePath) ? [{ id: "markdown.showPreview", title: t("Markdown: Open Preview"), shortcut: "⇧⌘V", execute: previewToggle }] : []),
    ...(previewFront ? [{ id: "markdown.showSource", title: t("Markdown: Open Source File"), shortcut: "⇧⌘V", execute: previewToggle }] : []),
    ...(lockTarget ? [{ id: "markdown.togglePreviewLock", title: t("Markdown: Toggle Preview Locking"), execute: () => toggleLock(lockTarget) }] : []),
    ...(controlled?.preview?.front ? [{ id: "markdown.togglePreviewLock", title: t("Markdown: Toggle Preview Locking"), execute: controlled.preview.lock }] : []),
  ];
  // `open`: the open file TABS (controlled those of the chat); a file held only by a diff is not an open editor.
  const paletteKey = usePaletteHost(rootRef, { target, targetName: projectName, open: isControlled ? tabs.map((x) => x.path) : E.openFiles(gr.state), view: () => (textFront ? cmRef.current?.view ?? null : null), openFile: (p, z, sp, o) => void openFile(p, z ? { from: { line: z - 1, character: (sp ?? 1) - 1 } } : undefined, true, o?.focus !== false),
    openFileBeside: isControlled ? null : (p, z, sp) => { if (z) nav.connection.rememberJump(p, { line: z - 1, character: (sp ?? 1) - 1 }); openBeside(p); },
    commands: { save: activePath && textFront ? () => saveFile(activePath) : null, allSave, blame: [blameOn, setBlameOn], minimap: [settings.minimap, (v) => updateSettings({ minimap: v })], wrap: [wrapOf(activePath ? bufferOf(activePath)?.key : null, settings.wordWrap), () => wrapToggle()], addition: paletteAddition } });
  useFileHistory(target, activePath); // Cmd+P "recently opened" (VS Code: every active editor enters the history)
  // Closing: unsaved AND the last holder (no other editor shows the file) means ask; afterwards letting go discards the buffer.
  // The dot on the tab comes from the buffer: the same question for every tab of the bar.
  const tabDirty = (k: string) => dirtyOf(k); // also a diff of the unstaged change carries its buffer's dot
  // "Reveal in explorer view" (tab context menu): the same path as the tree's "reveal active file" (useExplorer: expand the folders above,
  // select, scroll into view), plus showing the explorer.
  const showInExplorer = (path: string) => {
    if (path.startsWith("/")) return; // a place outside the instance is in no tree
    showInTree(path, false, true); // explicitly: also under node_modules (VS Code `select(..., "force")`)
    setMode("explorer");
    treeShow();
  };
  // Afterwards the most recently used tab of the group comes to the front, without a trail the right neighbour, otherwise the left (as in the chat, lib/tab-bar.ts
  // `closeInList`); false = cancelled.
  // In group `gid` (default: the active one); if the same file is still in the other group, its buffer stays and VS Code does not ask.
  // `key` is a tab (lib/editor-inputs.ts). Asked only if its buffer carries unsaved content and NOBODY else holds it:
  // no other tab (in any group; a file and the diff of its unstaged change share it, `otherHolds`) and no other
  // holder than this area (1) and, if the diff is in front, its mounted diff tab (1). A preview holds nothing.
  async function closeTab(key: string, gid: string = gr.ref.current.active): Promise<boolean> {
    const d = E.bufferFile(key), p = d !== null ? bufferOf(d) : null;
    const own = 1 + (d !== key && G.groupOf(gr.ref.current, gid)?.active === key ? 1 : 0);
    if (p?.dirty && p.holders <= own && !E.otherHolds(gr.ref.current, gid, key) && !(await question(t("\"{name}\" has unsaved changes. Close anyway?", { name: E.tabTitle(key, t).name }), { ok: t("Close"), danger: true }))) return false;
    const prior = gr.ref.current, inTheir = groupEl(gid)?.contains(document.activeElement) ?? false;
    const after = applyGroups((s) => G.close(s, gid, key));
    // If the group dropped out or focus was in it, focus goes to the active group, never to the body.
    if (after !== prior && (after.groups.length < prior.groups.length || inTheir)) focusWish.current = after.active;
    return true;
  }
  // The sets of the tab menu (and Alt+Cmd+T) in group `gid`: one after another, a cancel leaves the rest open (like VS Code).
  async function closeSet(kind: CloseKind, path: string, gid: string = gr.ref.current.active) {
    for (const p of closeSetOf(kind, G.groupOf(gr.ref.current, gid)?.paths ?? [], path, (x) => !dirtyOf(x))) {
      if (!(await closeTab(p, gid))) return;
    }
  }
  // The shortcuts of the tabs on the Files page (controlled they belong to the chat, chat/chatTabs.ts): Alt+W (desktop client Cmd+W) closes, those of the
  // menu like VS Code (lib/tab-bar.ts `menuShortcut`); a shortcut shows in the menu only if it is bound here.
  const [environment, setEnvironment] = useState<{ mac: boolean; shell: boolean }>({ mac: false, shell: false });
  useEffect(() => { setEnvironment({ mac: isMac(), shell: inShell(window) }); }, []);
  const tabShortcutTexts = { close: closeShortcutText(environment), ...shortcutText(environment) };
  const chord = useRef(false);
  function tabKeys(e: React.KeyboardEvent): boolean {
    // In the terminal Cmd+K and Alt+W belong to the shell (VS Code `commandsToSkipShell` does not list them).
    const front = controlled ? null : G.activeGroup(gr.ref.current).active; // every tab (also preview and diff)
    // The same key in an EMPTY group closes it as long as others remain (VS Code Cmd+W -> `workbench.action.closeGroup`).
    if (!controlled && !front && !inTerminal(e) && gr.ref.current.groups.length > 1 && tabShortcut(e, environment) === "close") {
      e.preventDefault();
      const gid = gr.ref.current.active;
      applyWithFocus((s) => G.removeGroup(s, gid));
      return true;
    }
    if (!front || inTerminal(e) || ["Meta", "Control", "Alt", "Shift"].includes(e.key)) return false;
    const m = menuShortcut(e, environment, chord.current);
    chord.current = m?.kind === "chord";
    if (m) {
      e.preventDefault();
      if (m.kind === "set") void closeSet(m.set, front);
      else if (m.kind === "fixed") { const gid = gr.ref.current.active; applyGroups((s) => G.keep(s, front, gid)); }
      return true;
    }
    if (tabShortcut(e, environment) !== "close") return false;
    e.preventDefault();
    void closeTab(front);
    return true;
  }
  const groupEl = (gid: string) => rootRef.current?.querySelector<HTMLElement>(`[data-editor-group="${CSS.escape(gid)}"]`) ?? null;

  // ── Editor groups ──
  // After split and Cmd+1/Cmd+2 focus goes to the editor of the (new) active group; a group without a text editor in front takes it itself (VS Code).
  const focusWish = useRef<string | null>(null);
  // If the tab in front is not there yet (a file loads, a diff reads its sides), focus first lies on the group and moves into
  // the editor as soon as it exists, unless someone has meanwhile put it elsewhere (`focusOpen`, observed in the effect below).
  const focusOpen = useRef<string | null>(null);
  /** Focus the editor in front in the group; false: it is not there (yet). */
  const focusIn = (gid: string): boolean => {
    const v = viewOf(gid).current?.view;
    // If a preview or a diff is in front, its surface takes the focus: the preview, on a diff the right (new) side.
    const k = stRef.current ? null : G.groupOf(gr.ref.current, gid)?.active ?? null, el = groupEl(gid);
    const view = k && !E.isFileTab(k) && el
      ? el.querySelector<HTMLElement>("[data-preview-tab] [data-md-preview]") ?? [...el.querySelectorAll<HTMLElement>("[data-diff-tab] .cm-content")].pop() ?? null
      : null;
    if (view) { view.focus({ preventScroll: true }); return true; }
    if (v && v.dom.getClientRects().length > 0 && (!k || E.isFileTab(k))) { v.focus(); return true; }
    return false;
  };
  const focusGroup = (gid: string) => {
    focusOpen.current = null;
    if (focusIn(gid)) return;
    groupEl(gid)?.focus();
    if (G.groupOf(gr.ref.current, gid)?.active) focusOpen.current = gid;
  };
  /** Change, and focus follows the active group (a drop that removes a group: VS Code focuses the editor there). */
  const applyWithFocus = (f: (s: G.GroupsStatus) => G.GroupsStatus) => {
    const prior = gr.ref.current, after = applyGroups(f);
    if (after !== prior) focusWish.current = after.active;
    return after;
  };
  useEffect(() => {
    const gid = focusWish.current;
    if (gid) { focusWish.current = null; focusGroup(gid); }
    // Focus waits on the group for its editor (`focusOpen`): every change in the group's DOM checks again until it is there or
    // focus has left the group.
    const open = focusOpen.current, el = open ? groupEl(open) : null;
    if (!open || !el) return;
    const done = () => {
      if (document.activeElement === el && !focusIn(open)) return false;
      focusOpen.current = null;
      return true;
    };
    if (done()) return;
    const observer = new MutationObserver(() => { if (done()) observer.disconnect(); });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  });
  // The new editor gets selection, scroll position and folds of the old one (VS Code passes the state on when splitting).
  // In each of the four directions, without cap (lib/editor-groups.ts `parts`).
  const partsGroup = (gid: string, direction: G.Direction = "right", path?: string | null) => {
    const prior = gr.ref.current, file = path === undefined ? G.groupOf(prior, gid)?.active ?? null : path;
    const st = statusInGroup(gid, file);
    const after = applyGroups((s) => G.parts(s, gid, direction, path));
    if (after === prior) return;
    giveState(after.active, file, st);
    focusWish.current = after.active;
  };
  // Ctrl+Cmd+Left/Right, "move editor into ... group" and "move left/right/up/down": the editor moves with its state into the other group;
  // if there is none, it is created.
  const moveEditor = (gid: string, target: G.EditorTarget, path?: string) => {
    const file = path ?? G.groupOf(gr.ref.current, gid)?.active ?? null;
    if (!file) return;
    const st = statusInGroup(gid, file), prior = gr.ref.current;
    const after = applyGroups((s) => G.moveEditor(s, gid, file, target));
    if (after === prior) return;
    giveState(after.active, file, st);
    focusWish.current = after.active;
  };
  // Explorer "open to the side" (Ctrl+Enter, Alt-click, context menu).
  function openBeside(path: string) {
    const prior = gr.ref.current, after = applyGroups((s) => G.openBeside(s, path));
    if (after === prior) return;
    setSelected(path);
    focusWish.current = after.active;
  }
  // Cmd+K Cmd+W closes all editors (empty groups stay); Cmd+K Shift+Cmd+W then also every empty group (VS Code `closeAllGroups`:
  // lib/editor-groups.ts `removeEmptyGroups`). A cancel leaves the rest open, and the groups stand.
  const closeAll = async (groupsAlso: boolean) => {
    for (const g of [...gr.ref.current.groups]) for (const p of [...g.paths]) if (!(await closeTab(p, g.id))) return;
    if (groupsAlso) applyWithFocus(G.removeEmptyGroups);
  };
  // "Increase/decrease current view width" (VS Code: 60 px per step): the divider by keyboard (VS Code GridView
  // `resizeView`: first the branch above, then its own; lib/editor-raster.ts).
  const changeWidth = (gid: string, by: number) => {
    const r = rootRef.current?.querySelector<HTMLElement>("[data-editor-groups]")?.getBoundingClientRect();
    if (!r || !(r.width > 0)) return;
    applyGroups((s) => G.changeWidth(s, gid, by, r.width, r.height));
  };
  // "Close all" / "Close saved" of a group (Cmd+K W / Cmd+K U): as in the tab menu; a cancel leaves the rest open.
  const closeInGroup = async (gid: string, kind: "all" | "saved") => {
    for (const p of [...(G.groupOf(gr.ref.current, gid)?.paths ?? [])]) {
      if (kind === "saved" && bufferOf(p)?.dirty) continue;
      if (!(await closeTab(p, gid))) return;
    }
  };
  const groupsCommand = (id: G.GroupsCommandId, group: string | null) => {
    const gid = group && G.groupOf(gr.ref.current, group) ? group : gr.ref.current.active;
    // What only changes the state (focus, move/join groups, layouts, sizes, maximise; lib/editor-groups.ts),
    // afterwards focus is in the active group (VS Code): immediately if it already was, otherwise after rendering.
    const step = G.statusStep(id, gid);
    if (step) {
      const prior = gr.ref.current, after = applyGroups(step);
      if (after === prior) focusGroup(after.active);
      else focusWish.current = after.active;
      return;
    }
    const direction = G.partDirection(id), target = G.editorTarget(id);
    if (direction) partsGroup(gid, direction);
    else if (target) moveEditor(gid, target);
    else if (id === "workbench.action.closeEditorsInGroup") void closeInGroup(gid, "all");
    else if (id === "workbench.action.closeUnmodifiedEditors") void closeInGroup(gid, "saved");
    else if (id === "workbench.action.keepEditor") { const a = G.groupOf(gr.ref.current, gid)?.active; if (a) applyGroups((s) => G.keep(s, a, gid)); }
    else if (id === "markdown.showPreviewToSide") previewBeside(gid);
    else if (id === "workbench.action.increaseViewWidth" || id === "workbench.action.decreaseViewWidth") changeWidth(gid, id === "workbench.action.increaseViewWidth" ? 60 : -60);
    else if (id === "workbench.action.closeAllEditors" || id === "workbench.action.closeAllGroups") void closeAll(id === "workbench.action.closeAllGroups");
  };
  // "Markdown: open preview to the side" is in the palette only on a markdown file (VS Code `when: editorLangId == markdown`);
  // maximise, widths and moving the editor only where they do something.
  const groupsCan = (id: G.GroupsCommandId, group: string | null) => {
    const s = gr.ref.current, g = G.groupOf(s, group ?? s.active);
    if (id === "markdown.showPreviewToSide") return isMarkdown(E.fileTab(g?.active));
    if (id === "workbench.action.toggleMaximizeEditorGroup") return s.groups.length > 1;
    if (id === "workbench.action.evenEditorWidths" || id === "workbench.action.increaseViewWidth" || id === "workbench.action.decreaseViewWidth") return s.groups.length > 1 && !G.maximizedGroup(s);
    if (G.editorTarget(id)) return Boolean(g?.active);
    return true;
  };
  const groupsKeys = useGroupsKeys(rootRef, !isControlled, groupsCommand, groupsCan);
  // Cmd+K V (VS Code `markdown.showPreviewToSide`): the preview of the file in front as a tab in the group BESIDE it: the right one,
  // otherwise a NEW group on the right (VS Code `ViewColumn.Beside`; the source file does not open there; lib/editor-inputs.ts `openPreview`).
  // Focus stays in the editor (VS Code `preserveFocus`). The preview FOLLOWS the active markdown editor (`followUpPreviews`) until it is
  // locked, and scrolls in step with the editor (MarkdownPreview `editor`).
  function previewBeside(gid: string) {
    const a = E.fileTab(G.groupOf(gr.ref.current, gid)?.active);
    if (!a || !isMarkdown(a)) return;
    rememberStartLine(E.previewKey(a), editorRowIn(gid));
    applyGroups((s) => E.openPreview(s, gid, a, { beside: true }));
  }
  // The editor a preview runs in step with: that of the active group, otherwise another that has the same file visible in front.
  const syncSource = (gid: string, path: string): string | null => {
    const st = gr.ref.current, ok = (x: G.Group | null | undefined) => Boolean(x && x.id !== gid && x.active === path);
    const a = G.groupOf(st, st.active);
    return ok(a) ? st.active : st.groups.find((x) => ok(x))?.id ?? null;
  };
  // The "..." menu of a group modelled on VS Code: only entries and order (behaviour), no code (the entries in components/code/InputParts.tsx).
  // Before them, whatever of the front file's buttons does not fit in the bar (`room`), then save and the blame switch.
  const groupsMenu = (gid: string, slot: number): MenuItem[][] => {
    const s = gr.ref.current, front = G.groupOf(s, gid)?.active ?? null;
    return [...titleMenuItems(t, fileTitleFor(front, gid), slot), ...groupMenuItems(t, {
      previewFront: Boolean(front && E.inputOf(front)?.kind === "preview"), several: s.groups.length > 1, maximized: G.maximizedGroup(s) === gid,
      previewEditors: settingsRef.current.preview, refresh: () => setFileStatus((n) => n + 1), lock: () => { if (front) toggleLock({ gid, key: front }); },
      opened: () => showOpened(gid), allClose: () => void closeInGroup(gid, "all"), closeSaved: () => void closeInGroup(gid, "saved"),
      togglePreviewEditors: () => updateSettings({ preview: !settingsRef.current.preview }),
      maximize: () => { applyGroups((x) => G.toggleMaximize(G.activateGroup(x, gid))); focusWish.current = gid; },
      configure: () => setSettingsOpen(true),
    })];
  };
  // "Show opened editors": the group's tabs as a list at the place of the "..." button (VS Code: a quick pick).
  const showOpened = (gid: string) => {
    const g = G.groupOf(gr.ref.current, gid);
    const r = groupEl(gid)?.querySelector<HTMLElement>("[data-group-more]")?.getBoundingClientRect();
    if (!g || !g.paths.length) return;
    openEditorMenu({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 2, title: t("Opened Editors"), groups: [g.paths.map((p) => ({
      id: p, label: E.tabTitle(p, t).name, right: dirtyOf(p) ? "●" : undefined, on: p === g.active,
      execute: () => { applyGroups((x) => G.activateTab(x, gid, p)); if (E.isFileTab(p)) setSelected(p); focusWish.current = gid; },
    }))] });
  };
  // "Split" and "move" in all four directions in the tab menu with THIS tab; a drop (a tab of this area, files of its explorer;
  // folders do not open in the editor).
  const splitFor = (gid: string) => (path: string) => ({
    parts: (r: G.Direction) => partsGroup(gid, r, path),
    move: (r: G.Direction) => moveEditor(gid, { direction: r }, path),
  });
  const createAt = (gid: string, zone: G.Zone, before: G.Before, files: string[] | null) => {
    if (files) {
      const d = files.filter((p) => !ex.isFolder(p));
      // In the chat (one group, the tabs belong to the chat) a drop from the explorer opens the files fixed as tabs of the chat.
      if (stRef.current) { for (const p of d) void openFile(p, undefined, true); return; }
      if (d.length) { applyWithFocus((s) => G.dropFiles(s, d, { group: gid, zone, before })); setSelected(d[0]); }
      return;
    }
    const z = dragFrom(area);
    rememberDrag(null); // the drag ends with the drop (the tab's source may already be gone, its dragend never comes)
    if (z?.kind !== "tab") return;
    const st = z.group !== gid ? statusInGroup(z.group, z.path) : null;
    const after = applyWithFocus((s) => G.dropTab(s, { group: z.group, path: z.path }, { group: gid, zone, before }, z.copy));
    if (after.active !== z.group) giveState(after.active, z.path, st); // the state moves along
  };

  // Alt+Z (key and palette): wrapping of the front file in the active group, transient.
  function wrapToggle() {
    const p = activePath ? bufferOf(activePath) : null;
    if (p) toggleWrap(p.key, settingsRef.current.wordWrap);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (groupsKeys.key(e)) return; // Cmd+\ Cmd+1 Cmd+2 and the chords Cmd+K W / U / Enter / V (lib/editor-groups.ts)
    if (tabKeys(e)) return; // Alt+W and Alt+Cmd+T "close others"
    if (mod && e.altKey && e.code === "KeyS") { e.preventDefault(); void allSave(); } // `code`, because Alt+S is "ß" on the Mac
    // Cmd+S saves the active editor, also with focus outside its surface (tab bar, header); a diff in front its right side
    // (components/code/view-locations.ts); if the surface itself saved (CodeMirror), nothing more.
    else if (mod && e.key.toLowerCase() === "s") { if (e.nativeEvent.defaultPrevented) return; e.preventDefault(); if (activePath) saveFile(activePath); else if (!stRef.current) saveLocation(diffLocation(gr.ref.current.active)); }
    else if (!inTerminal(e) && matchesKey(WRAP_KEY, e, isMac())) { e.preventDefault(); wrapToggle(); } // Alt+Z like VS Code: only the file in front (in the terminal the shell)
    else if (isPreviewKey(e, isMac()) && (previewFront || isMarkdown(activePath))) { e.preventDefault(); if (stRef.current) e.stopPropagation(); previewToggle(); } // Shift+Cmd+V (a tab)
    else if (layConn.key(e)) { if (stRef.current) e.stopPropagation(); } // Cmd+B Cmd+J Shift+Cmd+E Shift+Cmd+F Shift+Cmd+M Ctrl+`; in the chat not also the bar's terminal
    else paletteKey(e); // Shift+Cmd+P Cmd+P Shift+Cmd+O Cmd+T Ctrl+G outside the editor (inside it the command table binds them)
  }
  // ── Debugger ──
  const allBreakpoints = useCallback(() => Object.entries(breakpoints).flatMap(([file, lines]) => lines.map((line) => ({ file, line }))), [breakpoints]);
  // `file`: the margin belongs to the editor of ITS group (a click in the other group comes before the active one changes).
  function toggleBreakpoint(line: number, file: string | null = activePath) {
    if (!file) return;
    setBreakpoints((prev) => {
      const cur = prev[file] || [];
      const next = cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b);
      const map = { ...prev, [file]: next };
      if (debugIdRef.current) api(`/api/debug/${debugIdRef.current}/breakpoints`, { method: "POST", body: JSON.stringify({ file: file, lines: next }) }).catch(() => {});
      return map;
    });
  }
  const stopDebug = useCallback(() => {
    if (debugIdRef.current) api(`/api/debug/${debugIdRef.current}`, { method: "DELETE" }).catch(() => {});
    debugIdRef.current = null; setDebugId(null); setDebugStatus("terminated"); setPaused(null);
  }, []);
  const startDebug = useCallback(async (file: string | null = activePath) => { // the file of the group whose button was pressed
    if (!file) return;
    if (debugIdRef.current) stopDebug();
    setDebugOutput([]); setPaused(null); setDebugStatus("starting"); layConn.panelStep({ kind: "show", tab: "debug" }); // show the console without taking focus
    try {
      const r = await calls<{ id: string; available: boolean; error?: string }>(`/debug/launch`, { method: "POST", body: JSON.stringify({ file: file, breakpoints: allBreakpoints() }) });
      if (!r.available) { setDebugOutput([t("Debugger not available: {msg}", { msg: r.error || "" })]); setDebugStatus("terminated"); return; }
      debugIdRef.current = r.id; setDebugId(r.id); setDebugStatus("running");
    } catch (e) { setDebugOutput([t("Start failed: {msg}", { msg: (e as Error).message })]); setDebugStatus("terminated"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, calls, allBreakpoints, stopDebug, layConn]);
  const debugCmd = useCallback((cmd: string) => { if (debugIdRef.current) api(`/api/debug/${debugIdRef.current}/command`, { method: "POST", body: JSON.stringify({ cmd }) }).catch(() => {}); }, []);

  // SSE of the debug session
  useEffect(() => {
    if (!debugId) return;
    const es = new EventSource(`${API_BASE}/api/debug/${debugId}/stream`);
    es.addEventListener("started", () => setDebugStatus("running"));
    es.addEventListener("resumed", () => { setDebugStatus("running"); setPaused(null); });
    es.addEventListener("paused", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as DebugPaused;
      setPaused(data); setDebugStatus("paused");
      setMode("debug"); treeShowRef.current(); // VS Code `debug.openDebug: openOnDebugBreak`: on a break "Run and Debug" shows in the side bar
      if (data.topFile && data.topLine) openFile(data.topFile, data.topLine);
    });
    es.addEventListener("terminated", () => { setDebugStatus("terminated"); setPaused(null); });
    es.addEventListener("output", (e) => { const d = JSON.parse((e as MessageEvent).data); setDebugOutput((prev) => [...prev.slice(-500), (d.text || "").replace(/\n$/, "")]); });
    es.onerror = () => {};
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugId]);

  // Re-evaluate watch expressions on every pause
  useEffect(() => {
    if (debugStatus !== "paused" || !debugIdRef.current || watches.length === 0) return;
    let alive = true;
    Promise.all(watches.map((wt) => api<{ value?: string; error?: string }>(`/api/debug/${debugIdRef.current}/evaluate`, { method: "POST", body: JSON.stringify({ expr: wt.expr }) }).then((r) => ({ expr: wt.expr, ...r })).catch(() => ({ expr: wt.expr, error: t("Error") }))))
      .then((res) => { if (alive) setWatches(res); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, debugStatus]);
  function addWatch(expr: string) {
    setWatches((prev) => (prev.some((w) => w.expr === expr) ? prev : [...prev, { expr }]));
    if (debugStatus === "paused" && debugIdRef.current) api<{ value?: string; error?: string }>(`/api/debug/${debugIdRef.current}/evaluate`, { method: "POST", body: JSON.stringify({ expr }) }).then((r) => setWatches((prev) => prev.map((w) => (w.expr === expr ? { expr, ...r } : w)))).catch(() => {});
  }
  const removeWatch = (expr: string) => setWatches((prev) => prev.filter((w) => w.expr !== expr));
  // The REPL of the debug console (like VS Code): input and result stand in the output; evaluated in the top frame of the pause.
  const evaluate = useCallback((expr: string) => {
    const row = (z: string) => setDebugOutput((prev) => [...prev.slice(-500), z]);
    row(`› ${expr}`);
    const id = debugIdRef.current;
    if (!id) { row(t("No active debug session.")); return; }
    api<{ value?: string; error?: string }>(`/api/debug/${id}/evaluate`, { method: "POST", body: JSON.stringify({ expr }) })
      .then((r) => row(r.error ? r.error : r.value ?? ""))
      .catch((e) => row(String((e as Error)?.message ?? e)));
  }, [t]);

  // ── What the tree reports ──
  // Renamed or moved: open tabs (and their buffers) move to the new path, also those under a folder and across a project
  // boundary; the active file moves along, also under a renamed folder. Uncontrolled through the ONE rule of the list (active,
  // preview and trail move along); controlled the list belongs to the chat.
  function followUpRenamed(path: string, to: string) {
    renameInView(coord, path, to);
    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, path: to } : (t.path.startsWith(path + "/") ? { ...t, path: to + t.path.slice(path.length) } : t)));
    // A diff that would fall in the process (a side leaves its target) stays with unsaved content, as with deleting.
    applyGroups((s) => E.followRename(s, (a) => (a === path ? to : a.startsWith(`${path}/`) ? to + a.slice(path.length) : a), followUpLocation, false, dirtyOf)); // every group (previews and diffs follow)
    stRef.current?.renamed(path, to);
    reportFileFollowUp({ kind: "renamed", from: area, target, old: path, fresh: to }); // the comparisons of the other areas
  }
  // Deleted: close the tabs of the file (or of everything below it); the most recently used then comes to the front, as with closing.
  function followUpDeleted(path: string) {
    setTabs((prev) => prev.filter((t) => t.path !== path && !t.path.startsWith(path + "/")));
    // In every group, like a close (with the preview; a diff with the file as a side too, except with unsaved content;
    // one in git shows what was).
    applyGroups((s) => G.remove(s, E.hitsDeleted((a) => a === path || a.startsWith(path + "/"), dirtyOf, followUpLocation)));
    stRef.current?.deleted(path, false);
    reportFileFollowUp({ kind: "deleted", from: area, target, path: path }); // the comparisons of the other areas
  }

  const paLoaded = pa?.status.state === "loaded" ? pa : null;
  // The base (HEAD) of the git margin of the active file (components/code/git-gutter.ts); untracked, without repo, read-only: none.
  useGitBase({ calls, path: activePath, buffer: paLoaded, repo: activePath ? repoForPath(activePath) : null, gitKind: activePath ? gitStatus[activePath] ?? null : null, gitState: activePath ? gitXY[activePath] ?? "" : null, active: isActive, gitTree: afterGitAction });
  // The same base for the file in front in EVERY other group (it has its git margin, even if never active, e.g. after a reload);
  // the same file in front in several groups asks ONCE (the first base applies to all views). One `GitBase` per file below.
  const otherBases = controlled ? [] : [...new Set(gr.state.groups.filter((g) => g.id !== gr.state.active).map((g) => E.fileTab(g.active)))].filter((p): p is string => Boolean(p) && p !== activePath);
  // The extensions PER editor, for the file in front in ITS group (`activePath`/`paLoaded` here are those of the group;
  // components/code/EditorGroups.tsx `GroupsEditor` remembers them per file).
  const buildExtensions = useCallback((activePath: string | null, paLoaded: Buffer | null): Extension => {
    // The code setting's font size is the size at 100%: the app's text size acts on it like on any other size (`textPx`),
    // and `textSizeMeasurement` makes CodeMirror measure again afterwards.
    const list: Extension[] = [codeTheme, fontSize(settings.fontSize), textSizeMeasurement];
    if (resolvedTheme === "dark") list.push(darkSyntax);
    const lang = activePath ? langByPath[activePath] : null;
    if (lang) list.push(lang);
    list.push(foldMargin); // fold arrows like VS Code, instead of basicSetup's fold gutter (`foldGutter: false` below)
    if (wrapOf(paLoaded?.key, settings.wordWrap)) list.push(EditorView.lineWrapping); // Alt+Z overrides per file
    // Its font store stays; BEFORE the minimap, so its text side already arises with the editor's syntax tree.
    if (settings.minimap) list.push(minimapFont, showMinimap.compute([], () => ({ create: () => ({ dom: document.createElement("div") }), displayText: "blocks", showOverlay: "always" })));
    list.push(overviewRuler()); // overview ruler right of the minimap, in the scroll bar's track (like VS Code)
    // Margin columns like VS Code (components/code/editor-margins.ts): breakpoints in the glyph margin before the line numbers (basicSetup), then git margin, fold arrows at the text.
    if (activePath) list.push(glyphMargin(breakpointGutter(breakpoints[activePath] || [], (line) => toggleBreakpoint(line, activePath))));
    if (paused && paused.topFile === activePath && paused.topLine) list.push(pausedLineDeco(paused.topLine));
    // Commands, context menu, occurrences; with a language also completion, hover, diagnostics, signature, rename, light bulb.
    list.push(editorExtensions({ buffer: paLoaded, editor: editorHolder, navigation: nav.connection }));
    list.push(gitMargin(paLoaded, t), cursorReporter); // git margin against HEAD, cursor reporter for the status bar and the outline
    if (blameOn && blame && blame.path === activePath && blame.lines.length) list.push(blameGutter(blame.lines));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langByPath, blameOn, blame, editorHolder, nav.connection, settings.fontSize, settings.wordWrap, wrapStatus, settings.minimap, breakpoints, paused, resolvedTheme]);

  // The buttons of the active tab: uncontrolled in the own tab row, controlled in the chat's title row: the SAME buttons
  // (components/code/InputParts.tsx). Per group for ITS tab in front (VS Code shows the editor's actions in every group); a diff
  // places its own buttons itself. Only icons like VS Code: save and blame are in "..." (of the group: `groupMenu`; in the chat its own, `more`);
  // `room` says how many are shown.
  const fileTitleFor = (key: string | null, gid: string | null): FileTitle | null => {
    const e = key ? E.inputOf(key) : null;
    const p = e?.kind === "file" ? e.path : null, a = tabs.find((x) => x.path === p);
    if (!p || !a || a.binary || a.tooLarge || !a.loaded) return null;
    const md = isMarkdown(p) && Boolean(gid || controlled?.preview), change = gid ? changeOf(p) : null;
    return {
      dirty: Boolean(bufferOf(p)?.dirty), deleted: Boolean(a.deleted), debug: lspLanguageOf(p)?.language === "ts", blameOn,
      onBlame: () => setBlameOn((v) => !v), onSave: () => saveFile(p), onDebug: () => void startDebug(p),
      preview: !md ? null : gid ? { kind: "beside", open: (old) => { if (old) { applyGroups((x) => G.activateGroup(x, gid)); previewToggle(); } else previewBeside(gid); } }
        : { kind: "here", open: previewToggle },
      asPreview: md ? () => asPreview(gid) : null,
      change: change && gid ? () => changeOpen(gid, p, change) : null,
    };
  };
  const buttonsFor = (key: string | null, gid: string | null = null, slot?: number) => {
    const e = key ? E.inputOf(key) : null;
    if (e?.kind === "preview") return gid && key ? <EditorTitleButtons t={t} kind="preview" onSource={() => sourceOpen(gid, key)} /> : null;
    if (e?.kind === "diff") return gid ? <EditorTitleButtons t={t} kind="diff" diffLocation={diffLocationOf(gid)} /> : null;
    const d = fileTitleFor(key, gid);
    return d ? <EditorTitleButtons t={t} kind="file" file={d} slot={slot} more={!gid} /> : null;
  };
  // How many of the front file's buttons fit in a bar of `width` px; split and "..." always show (lib/editor-title.ts).
  const slotIn = (g: G.Group, width: number) => { const d = fileTitleFor(g.active, g.id); return titleSlot(width, d ? fileActions(t, d).length : 0, 2); };
  const actionsButtons = buttonsFor(activePath);
  // "Open changes": the source of a file's change (the unstaged one if the working tree has one, otherwise the staged one) as a diff tab
  // in the group, as a preview (like VS Code `git.openChange`), with focus. An UNTRACKED file has no left side: VS Code opens
  // the file itself, its tab then reads "README.md (Untracked)" (here "(Not tracked)"), until it closes.
  function changeOf(path: string): DiffSource | "untracked" | null {
    const repo = repoForPath(path);
    return repo ? E.changeSource(path, repo.relPath ?? "", gitXY[path] ?? null, gitStatus[path] ?? null) : null;
  }
  function changeOpen(gid: string, path: string, q: DiffSource | "untracked") {
    if (q === "untracked") setUntracked((m) => (m.has(path) ? m : new Set([...m, path])));
    applyGroups((x) => q === "untracked" ? G.activateTab(G.activateGroup(x, gid), gid, path)
      : G.open(G.activateGroup(x, gid), E.diffKey(q), { fixed: !settingsRef.current.preview, unsaved: dirtyOf, group: gid }));
    focusWish.current = gid;
  }
  // "Open as preview" (VS Code `markdown.reopenAsPreview`): the file in front becomes a locked preview in its place (it does not follow);
  // if it carries unsaved content nobody else holds, it stays and the preview comes beside it (lib/editor-inputs.ts `asPreview`).
  function asPreview(gid: string | null) {
    if (stRef.current) { stRef.current.preview?.asPreview?.(); return; }
    const g = gid ? G.groupOf(gr.ref.current, gid) : null, path = E.fileTab(g?.active);
    const prior = gr.ref.current;
    if (g && path && applyGroups((x) => E.asPreview(x, g.id, path, dirtyOf(path) && !E.otherHolds(x, g.id, path))) !== prior) focusWish.current = g.id;
  }

  // The tree's decoration: git status, ignored paths and the problems of open buffers; asked only while the tree is visible.
  const treeProblems = useTreeProblems({ on: isActive && mode === "explorer" && !treeHidden, tabs, bufferOf, bufferTick, change });
  const treeCards = useMemo(() => explorerCards(gitRepos, ex.ignored, treeProblems), [gitRepos, ex.ignored, treeProblems]);
  const problemCount = useProblemCount(target, tabs.map((x) => x.path)); // the badge on the PROBLEMS tab, the same data as the status bar
  // The outline ONCE: in the outline tab and in the OUTLINE section of the explorer (components/code/LayoutContent.tsx).
  const layoutChoice = useLayoutChoice(); // order, follow cursor, collapse all: for tab AND section
  const layoutContent = <LayoutContent t={t} active={activePath} layout={outline} view={activeView} choice={layoutChoice} onJump={(from) => { if (activePath) void openFile(activePath, { from }); }} />;

  // ── Per group: head (tab bar, breadcrumbs) and content (hint lines, editor surface) for the file in front in THIS group ──
  // `activePath`, `active`, `pa` and the front text are those of the group. Controlled (in the chat) there is ONE group from the chat's tabs, without head.
  const groupsStatus: G.GroupsStatus = controlled
    ? { ...G.BEGINNING, groups: [{ ...G.BEGINNING.groups[0], paths: tabs.map((x) => x.path), active: activePath }] } : gr.state;
  // The unlocked previews (at most one per group) follow the markdown file in front in the active group
  // (VS Code: a dynamic preview shows the active markdown editor; lib/editor-inputs.ts `followUpPreviews`).
  useEffect(() => {
    if (!isControlled && activePathIntern && isMarkdown(activePathIntern)) applyGroups((s) => E.followUpPreviews(s, activePathIntern));
  }, [activePathIntern, isControlled, applyGroups]);
  // A new git status (index, working tree, a commit) makes the diffs and the previews without a buffer reread.
  const gitStateText = `${gitKey}\n${Object.entries(gitXY).map(([p, xy]) => `${xy} ${p}`).sort().join("\n")}\n${gitReposState}`;
  useEffect(() => { setFileStatus((n) => n + 1); }, [gitStateText]);
  // The preview and the diff as tabs (components/code/InputParts.tsx). Their location (`diffLocation`) carries Cmd+S and the scroll position
  // (components/code/view-locations.ts). A link in the preview to another markdown file (without a jump target) makes THIS preview show it
  // (VS Code `markdown.preview.openMarkdownLinks: inPreview`); otherwise the file opens (at the line) in its group. A restored preview whose
  // file is missing drops out (like a file tab).
  const diffLocation = (gid: string) => `${area}|${gid}`;
  const previewFor = (g: G.Group, key: string, path: string) => {
    const q = syncSource(g.id, path);
    return <PreviewInput t={t} tabKey={key} path={path} target={target} buffer={bufferOf(path)} status={fileStatus} imageUrl={(x) => fileDownloadUrl(apiBase, x, true, instance)}
      location={diffLocation(g.id)} editor={q ? { view: () => viewOf(q).current?.view ?? null, key: q } : null} onError={(e) => onErrorRef.current?.(e)}
      onFile={(x, row, markdown) => {
        const e = E.inputOf(key);
        if (markdown && row === null && e?.kind === "preview") { applyGroups((s) => G.replaceIn(s, g.id, key, E.previewKey(x, e.locked))); focusWish.current = g.id; return; }
        applyGroups((s) => G.activateGroup(s, g.id));
        void openFile(x, row ?? undefined);
      }}
      onDisk={(missing) => { if (gr.restored.current.delete(key) && missing) applyGroups((s) => G.remove(s, (k) => k === key)); }} />;
  };
  const diffFor = (g: G.Group, key: string, source: DiffSource) => {
    const file = E.diffFile(source);
    return <DiffInput t={t} tabKey={key} source={source} target={target} editor={editorHolder} buttonsIn={diffLocations[g.id] ?? null} location={diffLocation(g.id)} status={fileStatus}
      onFileOpen={file ? () => { applyGroups((s) => G.activateGroup(s, g.id)); void openFile(file, undefined, true); focusWish.current = g.id; } : null}
      onSaved={refreshGit} onFixed={() => applyGroups((s) => G.keep(s, key, g.id))} onError={(e) => onErrorRef.current?.(e)} />;
  };
  // The watermark's draw per group (shuffled ONCE as long as the group lives; components/code/Watermark.tsx).
  const thrown = useRef(new Map<string, number[]>());
  const throwOf = (gid: string) => { let w = thrown.current.get(gid); if (!w) thrown.current.set(gid, (w = newThrow())); return w; };
  const groupsIds = gr.state.groups.map((x) => x.id).join("|");
  useEffect(() => { for (const k of [...thrown.current.keys()]) if (!groupsIds.split("|").includes(k)) thrown.current.delete(k); }, [groupsIds]);
  const groupsHeader = (g: G.Group, groupActive: boolean) => {
    const activePath = E.fileTab(g.active), active = tabs.find((x) => x.path === activePath) ?? null;
    return (<>
        {g.paths.length > 0 && !controlled && (
        // The tabs like VS Code: the SAME building block as the code tabs in the chat (components/code/TabBar.tsx); the buttons stand to the right
        // beside them and do not scroll along. The dot on the tab comes from the buffer (`tabDirty`).
        <CodeTabBar
          t={t}
          tabs={g.paths.map((p) => ({ path: p, deleted: E.isFileTab(p) ? tabs.find((x) => x.path === p)?.deleted : undefined, display: inputDisplay(p, t, untracked.has(p)) }))}
          active={g.active}
          preview={g.preview}
          apiBase={apiBase}
          dirty={tabDirty}
          git={(p) => { const d = E.timeAxisFile(p), a = d ? gitStatus[d] : undefined; return isGitKind(a) ? a : null; }}
          problem={(p) => { const d = E.timeAxisFile(p); return d ? problemOfTheFile(target, d) : null; }}
          right={(width) => { const slot = slotIn(g, width); return <>{buttonsFor(g.active, g.id, slot)}<GroupsButtons t={t} onShare={(below) => partsGroup(g.id, below ? "bottom" : "right")} menu={() => groupsMenu(g.id, slot)} /></>; }}
          shortcut={tabShortcutTexts}
          mac={environment.mac}
          onActivate={(p) => { applyGroups((s) => G.activateTab(s, g.id, p)); if (E.isFileTab(p)) setSelected(p); }}
          onKeep={(p) => applyGroups((s) => G.keep(s, p, g.id))}
          onClose={(p) => closeTab(p, g.id)}
          onCloseSet={(kind, p) => { void closeSet(kind, p, g.id); }}
          onReorder={(from, to, afterwards) => applyGroups((s) => G.reorderIn(s, g.id, from, to, afterwards))}
          onShowInExplorer={showInExplorer}
          // "Open preview" in the context menu of a markdown tab (VS Code `markdown.showPreview`, editor/title/context 1_open): in ITS group.
          onPreview={(p) => (E.isFileTab(p) && isMarkdown(p) ? () => { const s0 = gr.ref.current; if (applyGroups((x) => E.openPreview(G.activateGroup(x, g.id), g.id, p)) !== s0) focusWish.current = g.id; } : undefined)}
          group={{ id: g.id, active: groupActive, area }}
          location={location}
          onDeposit={(before, files) => createAt(g.id, "middle", before, files)}
          onParts={splitFor(g.id)}
        />
        )}
        {/* The breadcrumbs below the tabs like VS Code: path (a folder segment lists its entries) > symbols at the caret. */}
        {active && !controlled && (
          <PathCrumbs target={target} path={active.path} open={(p) => openFile(p)} after={<Breadcrumbs target={target} path={active.path} location={`${area}:${g.id}`} />} />
        )}
    </>);
  };
  const groupsContent = (g: G.Group) => {
    const input = controlled || !g.active ? null : E.inputOf(g.active);
    const activePath = E.fileTab(g.active), active = tabs.find((x) => x.path === activePath) ?? null, pa = activePath ? bufferOf(activePath) : null;
    const textFront = Boolean(!controlled?.content && active?.loaded && !active.binary && !active.tooLarge && !active.error && pa?.status.state === "loaded");
    return (<>
        {/* The file changed under own changes: nothing is silently overwritten, the human chooses. */}
        {active && pa?.readonly && !controlled?.content && <WriteProtectionRow path={active.path} />}
        {active && pa?.status.inquiry?.kind === "deleted" && !controlled?.content && (
          <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-[12px]" data-code-deleted={active.path}>
            <span className="min-w-0 flex-1 text-dim">{t("The file was deleted — your text is still here; “Keep mine” recreates it when you save.")}</span>
            <button type="button" onClick={() => keepChanged(active.path, true)} className={ghostSm} data-code-deleted-dismiss>{t("Dismiss")}</button>
            <button type="button" onClick={() => keepChanged(active.path, false)} className={ghostSm} data-code-deleted-keep>{t("Keep mine")}</button>
          </div>
        )}
        {active && (pa?.status.storageError || active.notRemembered) && !controlled?.content && (
          <div className="flex shrink-0 flex-col gap-0.5 border-b border-edge px-3 py-1.5 text-[12px]">
            {pa?.status.storageError && <span className="text-danger" role="alert" data-code-save-error>{storageErrorText(pa.status.storageError)}</span>}
            {active.notRemembered && <span className="text-dim" data-code-not-remembered>{t("Too large for a draft — it will not survive a reload; save before closing.")}</span>}
          </div>
        )}
        {active && pa?.status.inquiry?.kind === "changed" && !controlled?.content && (
          <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-[12px]" data-code-changed={active.path}>
            <span className="min-w-0 flex-1 text-dim">{t("The file was changed — reload it or keep your changes?")}</span>
            <button type="button" onClick={() => keepChanged(active.path, true)} className={ghostSm} data-code-changed-new>{t("Reload")}</button>
            <button type="button" onClick={() => keepChanged(active.path, false)} className={ghostSm} data-code-changed-keep>{t("Keep mine")}</button>
          </div>
        )}
        {/* Editor surface */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {controlled?.content ? <NavContext.Provider value={nav.connection}>{controlled.content}</NavContext.Provider> : (<>
          {/* The markdown preview and the diff are tabs of their own: if one is in front, it takes the editor's place. */}
          {input?.kind === "preview" && g.active && previewFor(g, g.active, input.path)}
          {input?.kind === "diff" && g.active && diffFor(g, g.active, input.source)}
          {/* An empty group like VS Code: the emblem (the lens) and the shortcuts (components/code/Watermark.tsx). */}
          {!g.active && <Watermark t={t} thrown={throwOf(g.id)} othersWithEditors={groupsStatus.groups.some((x) => x.id !== g.id && x.paths.length > 0)} />}
          {active && !active.loaded && <div className="p-4 text-[13px] text-dim" data-code-loading>{waitingText(coord, t)}</div>}
          {active && active.error && <div className="p-4 text-[13px] text-danger">{t("Error: {msg}", { msg: active.error })}</div>}
          {active && active.loaded && active.image && (
            <ImagePreview
              key={active.path}
              src={fileDownloadUrl(apiBase, active.path, true, instance)}
              name={basename(active.path)}
              size={active.size ?? 0}
              onDownload={() => startFileDownload(apiBase, active.path, instance)}
            />
          )}
          {active && active.loaded && active.binary && !active.image && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-dim">
              <div className="text-[13px]">{t("Binary file — cannot be edited as text.")}</div>
              <button
                onClick={() => startFileDownload(apiBase, active.path, instance)}
                className={`${pillSm} bg-dark text-white hover:opacity-90`}
              >
                {t("Download")}
              </button>
            </div>
          )}
          {active && active.loaded && active.tooLarge && <div className="p-4 text-[13px] text-dim">{t("File too large for the editor.")}</div>}
          </>)}
          {/* The editor is a view of the buffer (components/code/BufferEditor.tsx) and stays mounted as long as file tabs are open;
          behind a preview, a diff, an image or "loading..." it is only hidden (`hidden`: focus cannot stay in it):
          undo and scroll position per file live in it. */}
          {g.paths.some(E.isFileTab) && (
            <GroupsEditor
              viewRef={viewOf(g.id)}
              buffer={textFront ? pa : null}
              hidden={!textFront}
              open={g.paths.filter(E.isFileTab).map((p) => bufferOf(p)?.key ?? "")}
              build={buildExtensions}
              path={activePath}
              file={pa?.status.state === "loaded" ? pa : null}
              editor={editorHolder}
              onInput={onEditorInput}
              basicSetup={{ tabSize: settings.tabSize, highlightActiveLine: true, foldGutter: false }}
              state={statusStorageFor(g.id)}
            />
          )}
        </div>
    </>);
  };

  return (
    // Explorer and editor side by side on the stage, separated by a hairline.
    // `min-w-0`: without it the root's minimum width is the width of all tabs, and everything to its right (git column,
    // blame, save) ran out of the window; with it the tab bar scrolls within itself.
    <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1" onKeyDown={onKeyDown} onKeyDownCapture={groupsKeys.capture} data-code-controlled={controlled ? "" : undefined}>
      {/* Explorer / search / outline (hidden in Zen mode).
      Below 900 px the column lies as an overlay OVER the editor instead of beside it: in a
      row only 180 px of a 420 px window would be left for the code. The
      Zen button in the status bar still shows and hides it. */}
      {!treeHidden && (
      <div className={treeAsDrawer
        // As a drawer over the editor: opaque in the stage colour (`bg-panel`), flat: a hairline on the right instead of
        // edge, rounding and shadow. Transparent over code would be unreadable.
        ? "absolute inset-y-0 left-0 z-20 flex w-[min(240px,80vw)] flex-col overflow-hidden border-r border-edge bg-panel"
        : "flex shrink-0 flex-col overflow-hidden border-r border-edge"} ref={lay.pagesRef} style={treeAsDrawer ? undefined : { width: pagesWidth.width }} data-sidebar>
        {/* The activity bar on top like VS Code: explorer, search, outline, references; the chosen one underlined. */}
        <ActivityBar mode={mode} setMode={setMode} onSettings={() => setSettingsOpen(true)} />

        <AnimatedSwitch token={mode} className="flex min-h-0 flex-1 flex-col">
        {/* "Open in integrated terminal": a NEW terminal in the folder, in front in the lower panel
        (components/code/panel/code-layout.ts `newTerminal`, lib/terminal-list.ts).
        The explorer in sections like VS Code: the folder (the tree), OUTLINE (the same view as the outline tab) and
        TIMELINE, collapsible, with drag handles (components/code/explorer/ExplorerSections.tsx). */}
        {mode === "explorer" && (
          // A drag from THIS explorer may fall into the editor groups (components/code/tab-transaction.ts).
          <div className="contents" onDragStart={() => rememberDrag({ area, kind: "tree" })} onDragEnd={() => rememberDrag(null)}>
            <ExplorerSections
              t={t}
              tree={({ collapsed: closed, toggle }) => (
                <ExplorerTree ex={ex} name={projectName} copy={copy} instance={instance} apiBase={apiBase} cards={treeCards} onSearchInFolder={searchInFolder} onInTerminal={lay.newTerminal} comparison={comparison.explorer} closed={closed} onTo={toggle} onPreview={previewFromExplorer} />
              )}
              layout={layoutContent}
              layoutActions={<LayoutActions t={t} choice={layoutChoice} />}
              activeFile={isActive && timeAxisFile && !timeAxisFile.startsWith("/") ? timeAxisFile : null}
              timeAxis={({ seq, file, gitOn }) => (
                <TimeAxisView t={t} calls={calls} file={file} repos={gitRead ? gitRepos.map((r) => r.relPath) : null}
                  state={gitReposState} comparison={comparison.timeAxis} seq={seq} gitOn={gitOn} onOpen={openTimeAxis} />
              )}
              onOpen={setSectionOpen}
            />
          </div>
        )}
        {mode === "search" && <SearchView calls={calls} t={t} target={target} preset={searchFolder && { seq: searchFolder.seq, include: `./${globMasked(searchFolder.path)}` }} editor={editorHolder} onOpen={(p, jump) => openFile(p, jump)} afterReplace={refreshGit} seed={lay.seed} onSeedConsumed={lay.seedConsumed} />}
        {/* "Run and Debug" like VS Code: step buttons, variables, watch, call stack, breakpoints (the console below). */}
        {mode === "debug" && (
          <DebugView
            status={debugStatus} paused={paused} watches={watches} breakpoints={breakpoints}
            onCmd={debugCmd} onStop={stopDebug} onJump={(f, line) => openFile(f, line)}
            onAddWatch={addWatch} onRemoveWatch={removeWatch}
            onStart={activePath && lspLanguageOf(activePath)?.language === "ts" ? () => void startDebug(activePath) : null}
          />
        )}
        {mode === "references" && <ReferencesBar result={nav.result} connection={nav.connection} onClear={nav.empty} />}
        {mode === "outline" && (
          <div className="flex min-h-0 flex-1 flex-col py-1">
            <div className="flex items-center px-3 pt-1"><Overline>{t("Outline")}</Overline><span className="flex-1" /><LayoutActions t={t} choice={layoutChoice} /></div>
            {layoutContent}
          </div>
        )}
        </AnimatedSwitch>
      </div>
      )}
      {/* The side bar's drag handle like VS Code (width remembered, double click: the preferred width); not on the drawer. */}
      {!treeHidden && !treeAsDrawer && (
        <div className="relative w-0 shrink-0">
          <DragBar direction="vertical" className="absolute inset-y-0 -left-[2px] z-30" onDrag={pagesWidth.drag} onBack={pagesWidth.back} data={{ "data-pages-drag-bar": "" }}
            label={t("Primary Side Bar width")} value={pagesWidth.value} />
        </div>
      )}

      {/* Editor on the stage, without a surface of its own. The editor groups side by side (components/code/EditorGroups.tsx,
      per group `groupHead`/`groupContent` above); panel and status bar stand below, across all groups (VS Code). */}
      {/* `data-panel-maximized`: the panel takes the column (globals.css), an attribute instead of `:has()` (load after opening). */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-panel-maximized={panelMaximized(lay.state) ? "" : undefined}>
        {controlled && isActive && controlled.actions && !controlled.content && actionsButtons && createPortal(
          <div className="flex items-center gap-0.5" data-code-actions>{actionsButtons}</div>,
          controlled.actions,
        )}
        {otherBases.map((p) => {
          const pp = bufferOf(p);
          return <GitBase key={p} calls={calls} path={p} buffer={pp?.status.state === "loaded" ? pp : null} repo={repoForPath(p)} gitKind={gitStatus[p] ?? null} gitState={gitXY[p] ?? ""} active={isActive} gitTree={afterGitAction} />;
        })}
        <EditorGroupsSurface
          t={t}
          status={groupsStatus}
          load={gr.load}
          area={area}
          location={location}
          droppable={!controlled}
          onActivate={(gid) => applyGroups((s) => G.activateGroup(s, gid))}
          onPull={(branch, index, distance, length) => applyGroups((s) => G.pullSeparator(s, branch, index, distance, length))}
          onBranchFrom={(branch) => applyGroups((s) => G.equalizeBranch(s, branch))}
          onAlign={(b, h) => applyGroups((s) => G.alignTo(s, b, h))}
          onCloseGroup={(gid) => applyWithFocus((s) => G.removeGroup(s, gid))}
          onParts={(gid, r) => partsGroup(gid, r)}
          onDeposit={createAt}
          header={groupsHeader}
          content={groupsContent}
        />

        {/* The lower panel like VS Code (components/code/panel/LowerPanel.tsx): ONE place for problems, debug console and terminal; a
        problem jumps to line AND column (with a history entry). */}
        <LowerPanel
          t={t} panelRef={lay.panelRef} state={lay.state} height={lay.height} setHeight={lay.setHeight} onAction={layConn.panelStep}
          problems={problems} activeFile={activePath} badge={problemCount.error + problemCount.warnings + (problemCount.infos ?? 0)}
          // A click jumps WITHOUT taking focus (VS Code `preserveFocus`), double click and Enter give it to the editor.
          onJump={(p, o) => { nav.connection.rememberJump(p.file, { line: p.line - 1, character: (p.column ?? 1) - 1 }, undefined, { focus: o.focus }); void openFile(p.file, undefined, o.fixed); }}
          debug={<DebugConsole output={debugOutput} onEvaluate={evaluate} />}
          terminals={lay.terminals.list.map((x) => ({ seq: x.seq, title: terminalTitle(x.cwd, projectName, shellNames[x.seq]), node: <TerminalPanel apiBase={apiBase} instance={instance} cwd={x.cwd} onEnded={() => layConn.terminalWay(x.seq)} onShell={(n) => setShellNames((m) => (m[x.seq] === n ? m : { ...m, [x.seq]: n }))} letThrough={(e) => keyForTheWorkbench(e) || G.groupThroughTheTerminal(e, isMac())} /> }))}
          activeTerminal={lay.terminals.active}
          onTerminalSelect={lay.selectTerminal}
          onTerminalEnd={layConn.terminalWay}
          onNewTerminal={() => lay.newTerminal("")}
        />

        {/* Status bar like VS Code (components/code/StatusBar.tsx): every entry in the same form; a pressed switch shows
        bright, the accent stays for the run state (debug running/paused). */}
        <StatusBar
          left={<>
            {/* The waiting chord (VS Code: "(Cmd+K) was pressed ..."), its second key without a command, a hint like the cap. */}
            {groupsKeys.notice && (
              <span className="truncate px-1.5 text-dim" role="status" data-chord-notice={groupsKeys.notice.kind}>
                {groupsKeys.notice.kind === "waiting"
                  ? t("({k}) was pressed. Waiting for second key of chord...", { k: isMac() ? "⌘K" : "Ctrl+K" })
                  : t("The key combination ({k}, {second}) is not a command.", { k: isMac() ? "⌘K" : "Ctrl+K", second: groupsKeys.notice.combo })}
              </span>
            )}
            <ProblemCounter t={t} target={target} paths={tabs.map((x) => x.path)} on={bottom === "problems"} onClick={() => layConn.panelStep({ kind: "toggle", tab: "problems" })} />
            {(debugStatus !== "terminated" || debugId) && (
              <StatusEntry title={t("Debug panel")} on={bottom === "debug"} onClick={() => layConn.panelStep({ kind: "toggle", tab: "debug" })} className={bottom !== "debug" && debugStatus === "paused" ? "text-warn" : bottom !== "debug" && debugStatus === "running" ? "text-accent" : ""}>
                Debug{debugStatus === "paused" ? ` · ${t("paused")}` : debugStatus === "running" ? ` · ${t("running")}` : ""}
              </StatusEntry>
            )}
          </>}
          right={<>
            {textFront && pa && active && (<>
              <CursorEntry t={t} view={activeView} />
              <FileDetails t={t} path={active.path} view={activeView} lineEnding={pa.status.lineEnding} onIndentation={() => setSettingsOpen(true)} />
            </>)}
            <LspStatusLine apiBase={pa?.target.apiBase ?? apiBase} instance={pa ? pa.target.instance : instance} path={textFront && pa ? pa.path : null} />
            <StatusEntry title={t("Zen mode (explorer off)")} on={zenPressed} onClick={treeToggle}>Zen</StatusEntry>
            <StatusEntry title={t("Toggle terminal (Ctrl+`)")} on={bottom === "terminal"} onClick={() => layConn.panelStep({ kind: "toggle", tab: "terminal" })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></svg>
              Terminal
            </StatusEntry>
          </>}
        />
      </div>

      {settingsOpen && <SettingsModal settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** The git base of the file in front in a NON-active group (any number of groups: one hook per file, components/code/git-gutter.ts). */
function GitBase(o: Parameters<typeof useGitBase>[0]) { useGitBase(o); return null; }

function SettingsModal({ settings, onChange, onClose }: { settings: CodeSettings; onChange: (p: Partial<CodeSettings>) => void; onClose: () => void }) {
  const t = useT();
  const row = "flex items-center justify-between gap-4 py-2 text-[13px]";
  // Number fields as a well (kit `field`), ticks in the accent colour: from the role, not as hex.
  const num = `${field} w-16 text-right`;
  return (
    <Modal onClose={onClose} width={380} z="z-[60]" label={t("Editor settings")}>
      <ModalTitle>{t("Editor settings")}</ModalTitle>
      <div className="divide-y divide-edge">
        <label className={row}><span>{t("Font size")}</span><input type="number" min={9} max={28} value={settings.fontSize} onChange={(e) => onChange({ fontSize: Math.max(9, Math.min(28, Number(e.target.value) || EDITOR_FONT_SIZE)) })} className={num} /></label>
        <label className={row}><span>{t("Tab size")}</span><input type="number" min={1} max={8} value={settings.tabSize} onChange={(e) => onChange({ tabSize: Math.max(1, Math.min(8, Number(e.target.value) || 2)) })} className={num} /></label>
        <label className={row}><span>{t("Word wrap")}</span><input type="checkbox" checked={settings.wordWrap} onChange={(e) => onChange({ wordWrap: e.target.checked })} className="h-4 w-4 accent-accent" /></label>
        <label className={row}><span>{t("Enable Preview Editors")}</span><input type="checkbox" checked={settings.preview} onChange={(e) => onChange({ preview: e.target.checked })} className="h-4 w-4 accent-accent" /></label>
        <label className={row}><span>Minimap</span><input type="checkbox" checked={settings.minimap} onChange={(e) => onChange({ minimap: e.target.checked })} className="h-4 w-4 accent-accent" /></label>
        <label className={row}><span>{t("Format on save")}</span><input type="checkbox" checked={settings.formatOnSave} onChange={(e) => onChange({ formatOnSave: e.target.checked })} className="h-4 w-4 accent-accent" /></label>
      </div>
    </Modal>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────
const svg = (children: React.ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
const FileIcon = () => svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>, 13);
