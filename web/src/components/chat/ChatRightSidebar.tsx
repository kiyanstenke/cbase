"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, subscribeGlobalEvents, type BrowserInfo, type Project } from "@/lib/api";
import { useConfirm } from "@/components/Prompts";
import { CardsSplit } from "@/components/chat/CardsSplit";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { Chevron, field, Hint, Menu, MenuEntry } from "@/components/CbKit";
import { type Block } from "@/components/AssistantBlocks";
import { AgentBar } from "@/components/AgentBar";
import { type Agent, type BackgroundItem } from "@/lib/agents";
import { filesOf, readableFile, type UploadSource } from "@/lib/drop-files";
import type { WorkflowChoice } from "@/lib/agent-jump";
import type { DynTreeStatus } from "@/lib/dyn-tree";
import type { GraphRequest, GraphRunsStatus } from "@/lib/graph-runs";
import { useBackgroundTasks } from "@/components/chat/chatBackgroundTasks";
import { artifactDirPath, artifactKey, ArtifactTree, type ChatArtifact } from "@/components/ArtifactBrowser";
import { OutputsWindow, OutputsFolder } from "@/components/chat/OutputsFolder";
import { ChannelIcon, ChannelSidebar, useChannelStatus } from "@/components/ChannelSidebar";
import { GitSidebar, type DiffDisplay } from "@/components/GitSidebar";
import { draftChat, openDiffTab, type DiffSource, type TabTarget } from "@/lib/chat-tabs";
import { TerminalsPane, terminalScope } from "@/components/TerminalsPane";
import { BrowserPane } from "@/components/BrowserPane";
import { dateLocale } from "@/lib/i18n";
import { useGitState } from "@/lib/git-state";
import { ownCopySaid } from "@/lib/chat-instance";
import type { InstanceField, ListSituation } from "@/lib/code-instance";
import type { ProjectWithInstance } from "@/lib/services-status";
import { barGitChoice, barHintBySituation, afterErrorBar, selectInBar, type BarHint, type BarChoice } from "@/lib/bar-instance";
import { stateWord } from "@/lib/instance-state";
import {
  BAR_SECTIONS, BAR_ACTION_CLASS, BAR_WIDTH_KEY, BAR_WIDTH_MAX, BAR_WIDTH_MIN, BAR_WIDTH_DEFAULT,
  BAR_HEADER_CLASS, BAR_RAIL, BAR_TITLE_CLASS, BAR_TITLE_FULL_CLASS, badgeText, isMac, clampWidth, shortcutSection, barTooltip,
} from "@/lib/chat-bar";
import { CHOICE_OWN, agentNames, agentControlsOwn, ownBrowserApiBase, windowUrl, resolveChoice, nextExpiry, openBrowserWindow, choiceEntries } from "@/lib/browser-choice";
import { nativeAvailable, scopeFromApiBase } from "@/lib/browser-native";
import type { RightSidebarTab } from "@/lib/chat-bar";
import type { TabView } from "@/components/chat/chatTabs";
import { svg } from "@/components/chat/ChatIcons";
import { AgendaPanel } from "@/components/chat/AgendaPanel";
import { Timeline } from "@/components/timeline/Timeline";
import { TIMELINE_SYMBOL } from "@/components/timeline/TimelineForm";
import { showProjectTimeline } from "@/lib/project-jump";
import { artifactNameFromTitle } from "@/components/chat/ChatCatalog";

// The right bar of the Coding chat, in VS Code style: ONE flex rail `aside[data-chat-bar]` with the ACTIVITY BAR on the
// right (`nav[data-bar-rail]`, 40 px, six icons with counter badges, accent mark on the active one) and to its left the
// PANEL (`section[data-bar-panel]`, flush, hairline to the stage, draggable 280-640 px via the handle on its left edge,
// width global in localStorage). A click on the active icon closes the panel; Ctrl+` / Cmd+Shift+B / Cmd+Shift+G toggle
// terminal, browser and git (lib/chat-bar.ts computes that; here it is only called). The panel head is 32 px: title in
// capitals, actions on the right, NO close button. Six sections: `GitSidebar`, the artifact tree with upload, drop and
// text-artifact form, `ChannelSidebar`, `AgentBar`, `TerminalsPane` (variant "bar", own PTYs per chat) and `BrowserPane`
// (the scope's own browser or an agent browser of this chat as a spectator).
//
// What lives here: the state ONLY the bar sets and reads: the expanded folders of the tree (`openArtifactDirs`), upload and
// drop (`artifactUploading`, `artifactDragOver`), the text-artifact form (`textDraft*`) with the handlers
// `toggleArtifactDir`, `revealArtifact` (only from `uploadArtifacts`), `uploadArtifacts`, `saveTextArtifact`; plus the
// channel status (`useChannelStatus`: unread as a badge on the icon) and the counter `runningAgents`, which comes from the
// SAME list the agents section shows; also the panel width, the git state (`useGitState`, ONE poller per scope: the icon's
// badge and the git panel read the same tree) and the browser choice.
//
// What STAYS in ChatPane and arrives as a prop (rule: whatever touches the stage, chat switch, event stream or another
// place stays there: prop + setter, no context): `rightSidebarOpen`/`rightSidebarTab` (the raw setter hangs on
// `useAutoCollapse(1250, ...)`: the bar closes below 1250 px; the persisting setters and `openRightSidebar` are THIS
// state's setters, and `openRightSidebar` also calls `onAgentOpen` from the subagent mark in the history), the artifact
// LIST (`artifacts`: `open()` sets it from the cache on chat switch, `loadArtifacts` from the event stream),
// `agentSelected` (`onAgentOpen` picks the agent from the history).
//
// The ArtifactModal stays in ChatPane: its state (`artifactSelected`, `artifactContent`, `artifactLoading`) is reset on chat
// switch in `open()` and read and written by `loadArtifacts` (event stream "artifact_changed", run end, re-entry) via
// `artifactSelectedRef`/`selectArtifactRef` (deleted -> closed, overwritten -> reload); `saveArtifact` calls
// `loadArtifacts`. Moving the modal would drag half the stream tracking along, so the bar gets only the selection (mark in
// the tree) and `selectArtifact` (click on a file) as props. No handle (`forwardRef`) is needed: nothing in ChatPane
// triggers anything on the bar (`revealArtifact` is only called from `uploadArtifacts`, both here).
//
// Visibility: ChatPane stays MOUNTED when the page shows another tab (`hidden`). `useVisible` measures the root
// (ResizeObserver, width > 0) and decides whether the browser stream runs and whether the shortcuts apply; otherwise the
// screencast would keep running invisibly, and Ctrl+` on the code page (which has its own Ctrl+`) would toggle an invisible bar.
//
// Seams (not byte-equal, each named): `workspace.id` -> `wsId` (twice, the same value), `activeIdRef` duplicated as in the
// composer (set only in render; `uploadArtifacts` reads it in click and drop handlers, never in the window before
// `open()`), `field` straight from CbKit, `question` via `useConfirm()` as in 31 other components. The bar also
// takes `taskSequence` (arrival order of the "Background Tasks" list), `graphRuns`, `stopGraphStart` and `respondGraph`
// from `useGraphRuns` (the background graph-workflow cards in the same list, their stop, their answer to the child chat;
// they count in the icon's badge), and `waitWakeupAt`/`waitWakeup` (the wake-up timer). The "Background Tasks" list is
// computed by the hook chat/chatBackgroundTasks.ts HERE, AgentBar shows it, the tab counts from it. The tab is called
// "Background Tasks" and carries a mark of its own (stacked layers with a running dot).
//
// The INSTANCE of the chat: a chat that moved into its copy k1 works there; git calls (`useGitState(gitApiBase, activeId)`,
// `<GitSidebar chatId>`) and the ensure of the own browser (`<BrowserPane chatId>`) therefore carry the chat. Which instance
// that is, the server decides (devtools/routes.js targetInstance: the chat's copy if it belongs to THIS project, else the
// main). The terminal already carried it (tag `chat:<id>`). The git tree of a copy names it (`instance`, devtools/code-route.js
// gitResponse); `copy` comes from that: the head of git and browser says "Copy k1", and the own browser of a copy chat is
// the copy's STREAM (`onlyStream`); the client's native one is the page's tab (scope `proj:<id>`), not the copy; its key
// carries the copy so that move-in and move-out re-attach it. The browser still belongs to the entered project (without
// focus the workspace, which has no instance); until this project's git tree is there it does not start (empty is not
// unknown: a main browser nobody wanted, or the native tab for a copy chat).
//
// The INSTANCE CHOICE of the git section: the "Copy k1" mark is a choice button (`cb-pop` menu like the browser choice) as
// soon as the project has at least two instances: main, the own copy, further ready copies. The computation is in
// lib/bar-instance.ts (`barGitChoice`): without a choice the chat (`?chat=`), with a choice EXACTLY the chosen instance (copy
// `instance=`, main without a parameter, never both). Badge, title and panel read the same tree
// (`useGitState(gitApiBase, target.chatId, target.instance)`), and every panel action acts in the chosen instance. The choice
// is remembered per chat in the module map `barChoices` (not localStorage: after a reload the own instance is unknown).
// Terminal and own browser stay on the chat: the browser hangs on `ownCopy` (chat mode: the chat's tree; with a choice:
// the own instance at the time of the choice), never on the choice.
export type ChatRightSidebarProps = {
  t: (key: string, params?: Record<string, string | number>) => string;
  activeId: string | null;
  chatInstance: string | null; // binding of the open chat (`chats.instance`, null = main); the git choice's signature carries it (lib/bar-instance.ts)
  wsId: string; // workspace: channel bar, channel status, terminal and browser without a project
  focusProjectId: string | null; // entered project: git section and own browser; without a chat AND without focus the rail is 0 px wide
  focusProject: Project | null;
  activeProject: Project | undefined; // project of the open chat (git section if no project is entered; cwd of its terminal)
  animReady: boolean; // width/opacity transitions only after the first paint (ChatPane measures when)
  rightSidebarOpen: boolean;
  rightSidebarTab: RightSidebarTab;
  setRightSidebarTab: (tab: RightSidebarTab) => void; // persisted (localStorage); the setters of the state in ChatPane
  setRightSidebarOpen: (open: boolean) => void;
  openRightSidebar: (tab?: RightSidebarTab) => void;
  artifacts: ChatArtifact[];
  artifactSelected: ChatArtifact | null; // the file open in the modal; here only the mark in the tree
  selectArtifact: (artifact: ChatArtifact) => void | Promise<void>; // a click on a file opens the modal (ChatPane)
  loadArtifacts: (chatId: string) => Promise<ChatArtifact[]>; // refresh the list after upload (and the cache)
  addError: (text: string) => void; // error bubble in the history (upload failed)
  agents: Agent<Block>[]; // running and finished subagents, merged (ChatPane, useMemo)
  dynTree: DynTreeStatus; // progress tree of the dynamic workflows (hook chat/chatDynTree.ts), in the agents section
  agentSelected: string;
  setAgentSelected: React.Dispatch<React.SetStateAction<string>>;
  workflowChoice: WorkflowChoice | null; // the jump "agent in chat" to a workflow agent (hook chat/chatAgentJump.ts); its row in the tree
  taskSequence: readonly string[]; // arrival order from the history (hook chat/chatBackground.ts); order of the "Background Tasks" list
  graphRuns: GraphRunsStatus; // the chat's graph-workflow starts (hook chat/chatGraphRuns.ts); the background runs as cards under "Background Tasks"
  stopGraphStart: (startId: string) => Promise<void>; // stop of a graph card (POST .../graph-workflows/:startId/stop on the start's chat, from "human")
  respondGraph: (request: GraphRequest) => Promise<void>; // answer in a graph card (`responseRequest` to the child chat; "no longer open" reloads and throws)
  waitTasks: ReadonlyArray<BackgroundItem>; // running background commands of the run (runs/do-run.js `bgTasks`); "Running" section
  waitMonitors: ReadonlyArray<BackgroundItem>; // running monitors of the run; "Running" section
  waitWakeupAt: number; // the scheduled continuation (ScheduleWakeup/CronCreate) in ms, 0 = none; "Running" section
  waitWakeup: { reason: string; prompt: string }; // its reason; title of the card
  archived: boolean; // archive: terminal without a shell, artifacts without upload/paste, channels without handles
  // Terminal or browser as a tab in the main area (the ... menu of the tab bar, chat/chatTabs.ts): while one is in front, the
  // bar draws the SAME section via a portal into the stage's place and shows only a hint at its own place. A chat's
  // terminal thus never appears twice (two xterms on the same PTY would fight over its size); browser choice and copy logic stay here.
  tabView: TabView;
};

// The git section's instance choice per chat (see header): survives chat switch and re-mounting of the bar, not a reload.
const barChoices = new Map<string, BarChoice>();

// Visible <=> the root has width. A `display: none` ancestor (the page shows another tab) reports 0: exactly the case
// where stream and shortcuts must stay silent.
function useVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setVisible((entries[0]?.contentRect.width ?? 0) > 0));
    ro.observe(el);
    setVisible(el.getBoundingClientRect().width > 0);
    return () => ro.disconnect();
  }, [ref]);
  return visible;
}

/** The panel head (32 px): title on the left, the section's actions as children on the right. No close button. `titleFull`: the
 *  title keeps its width against a shrinking choice beside it (git: the instance); otherwise "GITLAB" becomes "GI..." at the minimum width. */
function Header({ title, titleFull = false, children }: { title: string; titleFull?: boolean; children?: React.ReactNode }) {
  return (
    <header data-bar-header className={BAR_HEADER_CLASS}>
      <h2 className={titleFull ? BAR_TITLE_FULL_CLASS : BAR_TITLE_CLASS}>{title}</h2>
      {children}
    </header>
  );
}

/** The empty form of a section without a subject (no chat, no project); the same as for the artifacts. */
function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-0 flex-1 place-items-center px-7 text-center text-[12px] leading-relaxed text-dim">{children}</div>;
}

/** The end of the render chain: `never`. If a section is added and its branch is missing, tsc says so. Unreachable at
 *  runtime (`isSection` holds the stored value to the list); no throw, a render must not die. */
function noSection(_tab: never): null {
  return null;
}

// The card's edge (1 px left + right, `border border-frame-edge`), added to the bar's width.
const CARDS_EDGE = 2;

export function ChatRightSidebar(props: ChatRightSidebarProps) {
  const {
    t, activeId, chatInstance, wsId, focusProjectId, focusProject, activeProject, animReady,
    rightSidebarOpen, rightSidebarTab, setRightSidebarTab, setRightSidebarOpen, openRightSidebar,
    artifacts, artifactSelected, selectArtifact, loadArtifacts, addError,
    agents, dynTree, agentSelected, setAgentSelected, workflowChoice, taskSequence, graphRuns, stopGraphStart, respondGraph, waitTasks, waitMonitors, archived,
    waitWakeupAt, waitWakeup, tabView,
  } = props;
  const question = useConfirm();
  // As in ChatPane: the upload reads the chat id from a ref.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // Expanded folders of the artifact tree (keys as in ArtifactBrowser: "issues/", "chat:<id>/"). Everything is closed by default.
  const [openArtifactDirs, setOpenArtifactDirs] = useState<Set<string>>(() => new Set());
  // Manual upload into the open chat's artifacts (button + drop on the list).
  const [artifactUploading, setArtifactUploading] = useState(false);
  const [artifactDragOver, setArtifactDragOver] = useState(false);
  // Artifact from pasted text: the title becomes the file name, the text the content.
  const [textDraftOpen, setTextDraftOpen] = useState(false);
  const [textDraftTitle, setTextDraftTitle] = useState("");
  const [textDraftBody, setTextDraftBody] = useState("");
  // Channels of the open chat: unread as a badge on the icon, also with the panel closed; otherwise one would never see that
  // the other chat wrote something.
  const channelStatus = useChannelStatus(activeId, wsId);
  // The counter on the icon comes from the SAME list the section shows: execution and description side must give the same
  // answer. Counting the event list PLUS every agent block without a result counted a foreground agent twice: `onStart`
  // reports EVERY living subagent, also the one whose call block is still open. ONE hook computes the "Background Tasks"
  // list, and the number on the tab is its rows under "Running" (`bg.running`, lib/bg-rows.ts `bgRunningCount`): a running
  // workflow counts once, not per agent in it.
  const bg = useBackgroundTasks({
    agents, dynTree, graphRuns, taskSequence, commands: waitTasks, monitors: waitMonitors,
    wakeup: waitWakeupAt, wakeupReason: waitWakeup.reason,
  });

  // Git scope: the entered project, else the chat's project. ONE poller (lib/git-state.ts) for the icon's badge AND the git
  // panel; two `git status` every six seconds would be double the load.
  const gitProjectId = focusProjectId ?? activeProject?.id ?? null;
  const gitApiBase = gitProjectId ? `/api/projects/${gitProjectId}` : null;
  // The instances of the git project (`/api/projects`, `instance.copies[]`): fresh on open, on every `project/instance` and
  // `project/copy` of this project (move-in and move-out, state change) and when the window returns; pattern CodeArea.tsx. A
  // list read once stays as it was on failure (empty is not unknown).
  const [instanceList, setInstanceList] = useState<{ pid: string | null; field: InstanceField; situation: ListSituation }>({ pid: null, field: undefined, situation: "loading" });
  useEffect(() => {
    if (!gitProjectId) return;
    let stale = false;
    const load = async () => {
      try {
        const list = await api<ProjectWithInstance[]>("/api/projects");
        if (!Array.isArray(list)) throw new Error("not a list");
        const fieldName = (list.find((p) => String(p?.id) === gitProjectId)?.instance ?? undefined) as InstanceField;
        if (!stale) setInstanceList({ pid: gitProjectId, field: fieldName, situation: "loaded" });
      } catch {
        if (!stale) setInstanceList((s) => (s.pid === gitProjectId && s.situation === "loaded" ? s : { pid: gitProjectId, field: undefined, situation: "error" }));
      }
    };
    void load();
    // `project/copy` too: the cleanup path silently deletes a copy's instance row and afterwards reports only `project/copy`;
    // the last `project/instance` still saw the row, and a choice kept its old own copy after move-out.
    const unsubscribe = subscribeGlobalEvents((evt) => {
      if ((evt.type === "project/instance" || evt.type === "project/copy") && String(evt.projectId ?? "") === gitProjectId) void load();
    });
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => { stale = true; unsubscribe(); window.removeEventListener("focus", focus); };
  }, [gitProjectId]);
  const instanceField = instanceList.pid === gitProjectId ? instanceList.field : undefined;
  const instanceSituation: ListSituation = instanceList.pid === gitProjectId ? instanceList.situation : "loading";

  // This chat's remembered choice (module map `barChoices`; the state only so that a click re-renders).
  const [choiceStatus, setChoiceStatus] = useState<{ chat: string | null; choice: BarChoice | null }>({ chat: null, choice: null });
  const rememberedChoice = choiceStatus.chat === activeId ? choiceStatus.choice : (activeId ? barChoices.get(activeId) ?? null : null);
  const rememberChoice = (choice: BarChoice | null) => {
    if (activeId) { if (choice) barChoices.set(activeId, choice); else barChoices.delete(activeId); }
    setChoiceStatus({ chat: activeId, choice });
  };
  // `pid`: the project whose list keeps the hint up to date; the hint applies to ONE project's copy.
  const [gitHint, setGitHint] = useState<{ chat: string | null; pid: string | null; hint: BarHint } | null>(null);
  // On every load of the list a shown hint follows it (`barHintBySituation`): "not ready (being cleaned up)" becomes "no
  // longer exists" once the row is missing, and drops when the copy is ready again; before, it froze at the first fallback.
  useEffect(() => {
    if (instanceList.situation !== "loaded") return;
    setGitHint((g) => {
      if (!g || g.pid !== instanceList.pid) return g;
      const h = barHintBySituation(g.hint, instanceList.field, "loaded");
      return h === g.hint ? g : h ? { ...g, hint: h } : null;
    });
  }, [instanceList]);
  // The target NEVER hangs on the tree (without a choice the chat, with a choice the choice with its remembered own instance); hence first without it.
  const choiceInput = { projectId: gitProjectId, field: instanceField, situation: instanceSituation, chatId: activeId, binding: chatInstance, choice: rememberedChoice };
  const raw = barGitChoice({ ...choiceInput, ownFromServer: undefined });
  const target = raw.target;
  // Without a choice: the server reads THIS chat's instance (its copy). With a choice: EXACTLY the chosen instance; the state is one per
  // target (lib/git-state.ts); the main without a chat shares it with the code tab, one poller.
  const git = useGitState(gitApiBase, target.chatId, target.instance);
  const inChatMode = target.chatId !== null;
  // The own copy as the server last NAMED it (also at the 409 of a locked copy); only the chat-bound tree knows it. Empty is not
  // unknown: `git.read` is read, never `git.tree`; a silent failure (network, 502/504 on restart of B) is an empty tree WITHOUT
  // `instance`, and "no answer" would read as "the main": in a copy chat's menu "Main - this chat", and a choice froze the wrong main
  // as the own instance (with the main's browser). Without an answer (`undefined`) there is no choice, as on iOS.
  const copySaid = inChatMode ? ownCopySaid(git.read) : undefined;
  const copy = copySaid ?? null;
  const gitChoice = inChatMode && copySaid !== undefined ? barGitChoice({ ...choiceInput, ownFromServer: copySaid }) : raw;
  // The copy this chat works in, for the browser, never the choice: with a choice the own instance at the time of the choice.
  const ownCopy = inChatMode ? copy : (rememberedChoice?.own ?? null);
  const gitTitle = git.tree?.repos.some((r) => r.remote?.isGitlab) ? t("GitLab") : t("Git");
  // Code tabs in the chat: every diff of the bar opens a tab in THIS chat's code area (also in a new chat's draft), with the target
  // the bar shows at that moment: in chat mode `null` (= the chat's target, computed in the hook chat/chatTabs.ts), with a
  // choice the chosen instance (tab name then with "- <instance>"). Via a ref so the callback stays stable.
  const diffTabTarget = useRef<{ chat: string; target: TabTarget | null }>({ chat: "", target: null });
  diffTabTarget.current = { chat: activeId ?? draftChat(wsId), target: inChatMode || !gitApiBase ? null : { apiBase: gitApiBase, instance: target.instance } };
  const openDiff = useCallback((q: DiffSource, a: DiffDisplay) => {
    const d = diffTabTarget.current;
    openDiffTab(d.chat, q, d.target, a);
  }, []);

  // A choice that drops at the read list (copy gone, cleaned up, failed, the chat moved in or out) or equals the own instance
  // is forgotten; the bar follows the chat again, visibly (hint), except when normalising silently.
  useEffect(() => {
    if (!rememberedChoice || gitChoice.remember) return;
    if (activeId) barChoices.delete(activeId);
    setChoiceStatus({ chat: activeId, choice: null });
    if (gitChoice.hint) setGitHint({ chat: activeId, pid: gitProjectId, hint: gitChoice.hint });
  }, [rememberedChoice, gitChoice.remember, gitChoice.hint, activeId, gitProjectId]);
  // The server calls the chosen copy unknown (404 at the tree or an action of the panel) => the same return to the chat.
  const choiceError = (e: unknown) => {
    const h = afterErrorBar(rememberedChoice, e);
    if (!h) return;
    rememberChoice(null);
    setGitHint({ chat: activeId, pid: gitProjectId, hint: h });
  };
  const choiceErrorRef = useRef(choiceError);
  choiceErrorRef.current = choiceError;
  const onGitError = useCallback((e: unknown) => choiceErrorRef.current(e), []);
  useEffect(() => {
    if (!inChatMode && git.tree?.code) choiceErrorRef.current(git.tree);
  }, [inChatMode, git.tree]);
  const showHint = gitHint && gitHint.chat === activeId ? gitHint.hint : gitChoice.hint?.kind === "transient" ? gitChoice.hint : null;
  const hintText = (h: BarHint) =>
    // "own": the copy rows of this chat in the list changed; while a copy is being built earlier than the server's binding
    // (which applies only once the copy is ready); the sentence therefore claims no completed switch.
    h.kind === "own" ? t("This chat's copy changed — Git follows the chat again.")
      : h.kind === "not-ready" ? t("The copy {name} is not ready ({state}) — Git shows this chat's instance again.", { name: h.name, state: stateWord(h.state, t) })
        : h.kind === "transient" ? t("The copy {name} is not ready right now ({state}) — Git stays with it.", { name: h.name, state: stateWord(h.state, t) })
          : h.name ? t("The copy {name} no longer exists — Git shows this chat's instance again.", { name: h.name })
            : t("The chosen instance no longer exists — Git shows this chat's instance again.");
  const instanceLabel = (name: string | null) => (name ? t("Copy {name}", { name }) : t("Main"));
  const copyMarker = (name: string) => (
    <span
      data-bar-instance={name}
      title={t("This chat works in its copy {name} — the sidebar shows the copy, not the main instance.", { name })}
      className="min-w-0 shrink truncate rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent"
    >
      {t("Copy {name}", { name })}
    </span>
  );
  // The instance in the git section's head: a choice button as soon as there are at least two instances; otherwise the mark as before
  // (the own copy), or, while the list reloads after a choice, the chosen instance as a mark (foreign, not clickable).
  const shownLabel = instanceLabel(gitChoice.shownName);
  const foreignTitle = t("Not this chat's instance — Git shows and acts on {instance}.", { instance: shownLabel });
  // The full text of the shown instance: name AND title of the choice button. `aria-label` replaces the visible content, a bare
  // "Choose instance" would not tell a screen reader which instance is shown and whether it is foreign; and the button truncates
  // long copy names, so the hover needs the whole text.
  const instanceText = gitChoice.foreign ? foreignTitle : `${shownLabel} · ${t("this chat")}`;
  const instanceHeader = gitChoice.options.length > 1 ? (
    <Menu
      label={t("Choose instance: {instance}", { instance: instanceText })}
      width={220}
      shrinks
      button={{
        // Only the NAME is truncated; "- this chat" marks the own instance and stands untruncated beside it (COPY_NAME allows
        // 24 characters: "Copy <24> - this chat" measures about 229 px at 10 px, the button at most 200).
        content: (open) => (
          <>
            <span className="min-w-0 truncate">{shownLabel}</span>
            {!gitChoice.foreign && <span className="shrink-0">· {t("this chat")}</span>}
            <Chevron open={open} size={11} />
          </>
        ),
        className: `${INSTANCE_CHOICE_CLASS} ${gitChoice.foreign ? "bg-warn/15 text-warn" : "bg-accent-soft text-accent"}`,
        data: {
          "data-bar-instance-choice": gitChoice.shownName ?? "main",
          ...(gitChoice.foreign ? { "data-bar-instance-foreign": "1" } : {}),
          ...(!gitChoice.foreign && gitChoice.shownName ? { "data-bar-instance": gitChoice.shownName } : {}),
        },
      }}
    >
      {/* A choice: `menuitemradio`, the shown instance with a tick (as on iOS); "this chat" stays the mark of the own one. */}
      {gitChoice.options.map((o) => (
        <MenuEntry
          key={o.identifier}
          label={instanceLabel(o.kind === "copy" ? o.name : null)}
          selected={o.identifier === gitChoice.shown}
          onClick={() => {
            if (!gitProjectId || !activeId) return;
            setGitHint(null);
            rememberChoice(selectInBar(gitChoice, o.identifier, { projectId: gitProjectId, field: instanceField, chatId: activeId, binding: chatInstance }));
          }}
          data={{ "data-bar-instance-entry": o.identifier, ...(o.identifier === gitChoice.shown ? { "data-bar-instance-active": "" } : {}) }}
          right={o.own ? <span className="shrink-0 text-[11px] text-dim">{t("this chat")}</span> : undefined}
        />
      ))}
    </Menu>
  ) : gitChoice.foreign ? (
    <span
      data-bar-instance-choice={gitChoice.shownName ?? "main"}
      data-bar-instance-foreign="1"
      title={foreignTitle}
      className="min-w-0 shrink truncate rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium text-warn"
    >
      {shownLabel}
    </span>
  ) : copy ? copyMarker(copy) : null;

  // Panel width: global per user (one handle, one preference), clamped to 280-640.
  const [width, setWidth] = useState<number>(() => {
    try { return clampWidth(localStorage.getItem(BAR_WIDTH_KEY)); } catch { return BAR_WIDTH_DEFAULT; }
  });
  const [drag, setDrag] = useState(false);
  const turn = useRef<{ x: number; width: number } | null>(null);
  const saveWidth = (b: number) => { try { localStorage.setItem(BAR_WIDTH_KEY, String(b)); } catch { /* a local preference is optional */ } };

  const root = useRef<HTMLElement>(null);
  const visible = useVisible(root);
  // Measured once: Cmd on the Mac, Ctrl otherwise; for shortcut and tooltip (the same detection as the commit field).
  const mac = useMemo(isMac, []);

  // A section is toggled: if it is open, the panel closes; if another is open, it switches; otherwise the panel opens with it.
  // Icon click and shortcut run through the same function.
  const toggle = (key: RightSidebarTab) => {
    if (rightSidebarOpen && rightSidebarTab === key) setRightSidebarOpen(false);
    else if (rightSidebarOpen) setRightSidebarTab(key);
    else openRightSidebar(key);
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  // Shortcuts: measured on the window, also from input fields (VS Code toggles the terminal from the editor). preventDefault,
  // because Cmd+Shift+G is the browser's "previous search result". Only when the bar is visible; the code page has its own Ctrl+`.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // held key: toggle once, do not flicker
      const key = shortcutSection(e, mac);
      if (!key) return;
      e.preventDefault();
      toggleRef.current(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, mac]);

  // Browser choice: "own" or the PROFILE of an agent browser (`profile:<folder>`, lib/browser-choice.ts), not the id: that is
  // a Chromium session's and changes with every run of the agent. Not persisted, and bound to the chat, since agent
  // browsers belong to it: another chat starts at "own".
  const [browserChoiceStatus, setBrowserChoiceStatus] = useState<{ chat: string | null; id: string }>({ chat: null, id: CHOICE_OWN });
  const browserChoice = browserChoiceStatus.chat === activeId ? browserChoiceStatus.id : CHOICE_OWN;
  const setBrowserChoice = (id: string) => setBrowserChoiceStatus({ chat: activeId, id });
  // The scope's own browser: the SAME as in the page's browser tab. Its stream is active only when that tab is open, ours only
  // when the chat tab is visible: never two. It goes with the chat: in a copy chat it is the COPY's browser (see header).
  // Whether the chat has a copy in the entered project is told by the git tree of the same project (gitProjectId ===
  // focusProjectId once a project is entered); without focus it is the workspace, which has no instance. Ready only after an
  // ANSWER (`git.read`): a silent first failure says nothing about the copy, and the main's browser for a copy chat would be wrong.
  const browserCopy = focusProjectId ? ownCopy : null;
  const browserReady = !focusProjectId || !activeId || !inChatMode || git.read !== null;

  // Terminal and browser built ONCE, drawn in the bar or, as a tab in front, in the stage's place (`tabView`, see props). The tab
  // is visible as long as its place has width (another tab of the page hides it); only then does the browser's stream run.
  // Own PTYs per chat: scopeKey `chat:<id>`, cwd is the CHAT's project, else the workspace; not focusProjectId, which is the
  // list, not the chat. The key attaches the panel to the new chat's PTYs on chat switch; TerminalsPane renders the head itself.
  const slotRef = useMemo(() => ({ current: tabView.slot }), [tabView.slot]);
  const slotVisible = useVisible(slotRef);
  const terminalContent = activeId && !archived ? (
    <TerminalsPane
      key={terminalScope(activeId)}
      variant="bar"
      apiBase={activeProject ? `/api/projects/${activeProject.id}` : `/api/workspaces/${wsId}`}
      scopeKey={terminalScope(activeId)}
    />
  ) : (
    <>
      <Header title={t("Terminal")} />
      {/* Archive: the shells were ended on archiving, and the server rejects a new one (409). */}
      <EmptyHint>{archived ? t("Archived — no shell. Restore it to open a terminal.") : t("Open a chat to see its terminal.")}</EmptyHint>
    </>
  );
  const browserContent = (active: boolean) => (
    <BrowserSection
      t={t}
      activeId={activeId}
      scope={{ focusProjectId, chatProjectId: activeProject?.id ?? null, wsId }}
      copy={browserCopy}
      ready={browserReady}
      copyMarker={copyMarker}
      choice={browserChoice}
      setChoice={setBrowserChoice}
      active={active}
      agents={agents}
      dynTree={dynTree}
    />
  );

  const toggleArtifactDir = (key: string) =>
    setOpenArtifactDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Make a file visible in the tree: expand all folders on its way. Opens NOTHING; the modal opens only on click.
  function revealArtifact(artifact: ChatArtifact) {
    setOpenArtifactDirs((prev) => {
      const next = new Set(prev);
      for (const key of artifactDirPath(artifact)) next.add(key);
      return next;
    });
  }

  // Upload artifacts by hand (button or drop on the list). The target is ALWAYS the open chat: shared files from neighbouring
  // chats of the same folder stay read-only. If the path exists, the server answers 409 + `exists`; here we ask and repeat with
  // ?overwrite=1 only after a yes. The server then sends "artifact_changed", and the list is also refreshed directly so the new
  // file shows up without a detour.
  async function uploadArtifacts(source: UploadSource) {
    const chatId = activeIdRef.current;
    if (!chatId) return;
    // Before the first await: a drop's entries are gone afterwards. A dropped folder keeps its path, artifacts may have subfolders.
    const pending = filesOf(source);
    setArtifactUploading(true);
    let lastPath = "";
    try {
      for (const d of await pending) {
        const name = d.rel;
        const file = await readableFile(d, (rel) => t("\"{name}\" could not be read on this computer. If it is a cloud-only file (OneDrive, iCloud Drive, Dropbox), make it available offline and try again.", { name: rel }));
        const put = (overwrite: boolean) =>
          api<ChatArtifact>(
            `/api/chats/${chatId}/artifacts/upload?path=${encodeURIComponent(name)}${overwrite ? "&overwrite=1" : ""}`,
            { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
          );
        try {
          lastPath = (await put(false)).path;
        } catch (e) {
          const conflict = e as Error & { exists?: boolean; path?: string };
          if (!conflict.exists) throw e;
          if (!(await question(t("\"{name}\" already exists in this chat. Overwrite?", { name: conflict.path || name }), { ok: t("Overwrite") }))) continue;
          lastPath = (await put(true)).path;
        }
      }
    } catch (e) {
      addError(t("Upload failed: {msg}", { msg: String((e as Error).message) }));
    } finally {
      setArtifactUploading(false);
    }
    const fresh = await loadArtifacts(chatId).catch(() => null);
    const shown = lastPath && fresh ? fresh.find((a) => a.own !== false && a.path === lastPath) : null;
    // Do not open the new file (nobody wants a modal in their face here); expand its folder in the tree, so it stands visibly where it belongs.
    if (shown) revealArtifact(shown);
  }

  // Store pasted text as an artifact. Deliberately goes through the same chain as an upload (File object -> uploadArtifacts), so the
  // same conflict question, the same list refresh and the same selection of the new file apply afterwards.
  async function saveTextArtifact() {
    const title = textDraftTitle.trim();
    const body = textDraftBody;
    if (!title || !body.trim() || artifactUploading) return;
    const name = artifactNameFromTitle(title);
    await uploadArtifacts([new File([body], name, { type: "text/plain" })]);
    setTextDraftOpen(false);
    setTextDraftTitle("");
    setTextDraftBody("");
  }

  // The handle: dragging left widens the panel (the rail is fixed on the right). Pointer capture keeps the drag also over the xterm
  // canvas or the browser image, but it only redirects the EVENTS, not the cursor: once the pointer leaves the gap it would show
  // that of the element below (text cursor over xterm). So for the length of the drag the cursor is set on `body` (as in VS Code),
  // with a lock on text selection. The width transition is off during the drag, otherwise the edge would trail the pointer.
  // Double click: default.
  const dragCursor = (on: boolean) => {
    document.body.style.cursor = on ? "col-resize" : "";
    document.body.style.userSelect = on ? "none" : "";
  };
  // If the bar disappears mid-drag (chat deleted), the cursor must not stick to the body.
  useEffect(() => () => { if (turn.current) dragCursor(false); }, []);
  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    turn.current = { x: e.clientX, width };
    setDrag(true);
    dragCursor(true);
  };
  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!turn.current) return;
    setWidth(clampWidth(turn.current.width + (turn.current.x - e.clientX)));
  };
  const handleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!turn.current) return;
    const b = clampWidth(turn.current.width + (turn.current.x - e.clientX));
    turn.current = null;
    setDrag(false);
    dragCursor(false);
    setWidth(b);
    saveWidth(b);
  };
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
    if (!step) return;
    e.preventDefault();
    const b = clampWidth(width + step);
    setWidth(b);
    saveWidth(b);
  };
  const handleReset = () => { setWidth(BAR_WIDTH_DEFAULT); saveWidth(BAR_WIDTH_DEFAULT); };

  // Without a chat and without an entered project there is nothing to show: the rail is 0 px wide, and then also without a card.
  // The bar is a card of its own beside the conversation, with a 3 px frame in front and an edge all around that adds
  // CARDS_EDGE to its width (border-box: otherwise `justify-end` would cut two pixels off the panel on the left).
  const present = Boolean(activeId || focusProjectId);
  const total = present ? BAR_RAIL + (rightSidebarOpen ? width : 0) : 0;
  const transition = animReady && !drag;

  // A Record over ALL keys, not an array: a seventh entry in BAR_SECTIONS without a row here is a type error (TS2741), not an
  // `undefined.label` in render. A foreign choice also shows on the rail: badge and name then count the changes of the CHOSEN
  // instance (`git` is the chosen tree); with the panel closed one would otherwise take the number for this chat's instance.
  // The name names the instance (tooltip and `aria-label`), the badge is in the warning colour like the choice in the head.
  const sections: Record<RightSidebarTab, { label: string; icon: React.ReactNode; badge: number; foreign?: boolean }> = {
    gitlab: {
      label: gitChoice.foreign ? t("{title} · {instance} (not this chat)", { title: gitTitle, instance: shownLabel }) : gitTitle,
      icon: GitIcon,
      badge: git.changes,
      foreign: gitChoice.foreign,
    },
    // The agenda without a badge: it counts no cause, it is a state (Coding tabs without numbers).
    agenda: { label: t("Agenda"), icon: AgendaIcon, badge: 0 },
    // The project's timeline, without a badge (a state, no cause).
    timeline: { label: t("Timeline"), icon: TIMELINE_SYMBOL(18), badge: 0 },
    artifacts: { label: t("Artifacts"), icon: ArtifactIcon, badge: artifacts.length },
    channels: { label: t("Channels"), icon: <ChannelIcon size={18} />, badge: channelStatus.unread },
    agents: { label: t("Background tasks"), icon: BackgroundTasksIcon, badge: bg.running },
    terminal: { label: t("Terminal"), icon: TerminalIcon, badge: 0 },
    browser: { label: t("Browser"), icon: BrowserIcon, badge: 0 },
  };

  return (
    // `data-chat-bar` is the stable hook for the test benches: the aria-label runs through t() and reads differently on an English
    // UI, so a selector on it would measure nothing there. `justify-end`: on collapse the rail shrinks from the right, the panel
    // is clipped at its LEFT edge and the activity bar stays where it is. At 0 px width the root is `inert`: otherwise the six
    // rail buttons (and, with a stored open state, the panel's head actions) would stay reachable invisibly by Tab.
    <>
    {/* The gap before the card (chat/CardsSplit.tsx): the 3 px frame to the conversation, with the three dots and the width handle
        while the panel is open; only the handle lights up while dragging. Without a chat and project there is neither card nor gap. */}
    {present && (
      <CardsSplit
        draggable={rightSidebarOpen}
        drag={drag}
        label={t("Sidebar width")}
        title={t("Drag to change the width, double-click to reset")}
        value={width}
        min={BAR_WIDTH_MIN}
        max={BAR_WIDTH_MAX}
        data={{ "data-bar-handle": "" }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onDoubleClick={handleReset}
        onKeyDown={handleKey}
      />
    )}
    <aside
      ref={root}
      data-chat-bar
      data-chat-bar-open={rightSidebarOpen ? "1" : "0"}
      data-chat-bar-section={rightSidebarTab}
      inert={!present}
      aria-label={t("Git, agenda, artifacts, channels, background tasks, terminal and browser")}
      className={`flex shrink-0 justify-end overflow-hidden ${present ? "rounded-[12px] border border-frame-edge bg-bg" : ""} ${transition ? "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]" : ""}`}
      style={{ width: present ? total + CARDS_EDGE : 0 }}
    >
      {/* The panel: flush, full height, no hairline of its own; its left edge is the card's edge. Closed it is `inert` (nothing in
          it is reachable by Tab) and hidden; the content stays mounted. The handle sits in the gap BEFORE the card. */}
      <section
        data-bar-panel
        inert={!rightSidebarOpen}
        className={`relative flex shrink-0 flex-col overflow-hidden bg-bg ${transition ? "transition-opacity duration-300" : ""} ${rightSidebarOpen ? "opacity-100" : "opacity-0"}`}
        style={{ width: width }}
      >

        {/* `fadeOnly`: opacity only on section switch; terminal and browser are full-height panels (globals.css). */}
        <AnimatedSwitch token={rightSidebarTab} fadeOnly className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {rightSidebarTab === "gitlab" ? (
            <>
              <Header title={gitTitle} titleFull>
                {gitApiBase && instanceHeader}
                {gitApiBase && (
                  <button type="button" onClick={() => void git.refresh()} title={t("Refresh")} aria-label={t("Refresh")} className={BAR_ACTION_CLASS}>
                    {svg(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></>, 14)}
                  </button>
                )}
              </Header>
              {gitApiBase && showHint && (
                <div className="flex shrink-0 items-start gap-2 px-3 pb-2" data-bar-instance-hint={showHint.kind}>
                  <div className="min-w-0 flex-1"><Hint tone="warn">{hintText(showHint)}</Hint></div>
                  {showHint.kind !== "transient" && (
                    <button type="button" onClick={() => setGitHint(null)} title={t("Dismiss##hide")} aria-label={t("Dismiss##hide")} className={BAR_ACTION_CLASS}>
                      {svg(<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>, 12)}
                    </button>
                  )}
                </div>
              )}
              {gitApiBase ? (
                <GitSidebar
                  key={`chat-git:${gitProjectId}:${activeId ?? ""}:${target.chatId ? "chat" : target.instance ?? "main"}`}
                  apiBase={gitApiBase}
                  chatId={target.chatId}
                  instance={target.instance}
                  onError={onGitError}
                  onDiffTab={openDiff}
                  projectName={focusProject?.name ?? activeProject?.name}
                  embedded
                />
              ) : (
                <EmptyHint>{t("This chat is not assigned to a project. Choose a project to show GitLab.")}</EmptyHint>
              )}
            </>
          ) : rightSidebarTab === "agenda" ? (
            // The open chat's agenda: read-only, live via `harness/agenda` (chat/chatAgenda.ts). The key re-mounts the section on chat
            // switch: no state of the old chat, no expanded "done".
            <>
              <Header title={t("Agenda")} />
              {activeId
                ? <AgendaPanel key={`agenda:${activeId}`} t={t} chatId={activeId} projectId={activeProject?.id ?? null} />
                : <EmptyHint>{t("Open a chat to see its agenda.")}</EmptyHint>}
            </>
          ) : rightSidebarTab === "timeline" ? (
            // The project's timeline of this chat, compact (components/timeline/Timeline.tsx); "Show all" opens the "Timeline" tab of the
            // project view. Without a project the rail has no button; a remembered section shows the sentence.
            <>
              <Header title={t("Timeline")} />
              {gitProjectId
                ? <Timeline key={`timeline:${gitProjectId}`} projectId={gitProjectId} workspaceId={wsId} compact onEverything={() => showProjectTimeline({ workspaceId: wsId, projectId: gitProjectId })} />
                : <EmptyHint>{t("This chat is not assigned to a project — the timeline belongs to a project.")}</EmptyHint>}
            </>
          ) : rightSidebarTab === "channels" ? (
            <>
              <Header title={t("Channels")} />
              <ChannelSidebar key={`channels:${activeId ?? ""}`} workspaceId={wsId} chatId={activeId} onlyRead={archived} />
            </>
          ) : rightSidebarTab === "agents" ? (
            <>
              <Header title={t("Background tasks")} />
              <AgentBar
                chatId={activeId}
                agents={agents}
                selected={agentSelected}
                onSelect={setAgentSelected}
                workflows={dynTree}
                workflowChoice={workflowChoice}
                bg={bg}
                onGraphStop={stopGraphStart}
                onGraphResponse={respondGraph}
              />
            </>
          ) : rightSidebarTab === "terminal" ? (
            tabView.kind === "terminal" ? (
              <>
                <Header title={t("Terminal")} />
                <EmptyHint>{t("The terminal is open as a tab in the chat.")}</EmptyHint>
              </>
            ) : terminalContent
          ) : rightSidebarTab === "browser" ? (
            tabView.kind === "browser" ? (
              <>
                <Header title={t("Browser")} />
                <EmptyHint>{t("The browser is open as a tab in the chat.")}</EmptyHint>
              </>
            ) : browserContent(rightSidebarOpen && visible)
          ) : rightSidebarTab !== "artifacts" ? (
            // tsc: a seventh section without a branch is a type error HERE, not a silent fallback to the artifacts.
            noSection(rightSidebarTab)
          ) : !activeId ? (
            <>
              <Header title={t("Artifacts")} />
              <EmptyHint>{t("Open a chat to view its artifacts.")}</EmptyHint>
            </>
          ) : (
            <section className="flex min-h-0 flex-1 flex-col">
              {/* The sidebar is ONLY the file system. A file opens as a modal in the middle of the screen (ArtifactModal). */}
              <Header title={artifacts.some((a) => a.own === false) ? t("Files of this chat and its folder") : t("Persistent files in this chat")}>
                <span className="rounded-full bg-hover px-2 py-0.5 text-[10px] tabular-nums text-dim">{artifacts.length}</span>
                {/* Paste text: an artifact from typed/pasted text, the title becomes the file name. In the archive paste and upload
                    are missing; the chat is read-only. */}
                {!archived && <>
                <button
                  type="button"
                  onClick={() => setTextDraftOpen((v) => !v)}
                  aria-expanded={textDraftOpen}
                  title={t("Paste text as an artifact")}
                  aria-label={t("Paste text as an artifact")}
                  // `text-accent!`: the action class carries `text-dim`, and Tailwind orders equal utilities by their value; without `!`
                  // `text-dim` wins, measured (the same trap as `py-1!`).
                  className={`${BAR_ACTION_CLASS} ${textDraftOpen ? "bg-accent-soft text-accent!" : ""}`}
                >
                  {svg(<><path d="M4 6h16" /><path d="M4 11h10" /><path d="M4 16h6" /><path d="M17 13v7" /><path d="M13.5 16.5h7" /></>, 14)}
                </button>
                {/* Upload by hand: the same file store the skills otherwise fill. The trigger is a <label> with the field INSIDE, not a
                    button calling input.click(): the programmatic click opened no file dialog in the client (drag and drop worked, the
                    button did not); the native label activation is independent of that. The field therefore stays RENDERED (1 px,
                    invisible) instead of display:none. */}
                <label
                  title={t("Upload files as artifacts")}
                  aria-label={t("Upload files as artifacts")}
                  className={`relative grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim transition-colors ${artifactUploading ? "pointer-events-none opacity-40" : "cursor-pointer hover:bg-hover hover:text-fg"}`}
                >
                  {artifactUploading
                    ? <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-edge border-t-accent" />
                    : svg(<><path d="M12 19V7" /><path d="m6 12 6-6 6 6" /><path d="M5 20h14" /></>, 14)}
                  <input
                    type="file"
                    multiple
                    disabled={artifactUploading}
                    className="absolute h-px w-px overflow-hidden opacity-0"
                    onChange={(e) => { const picked = e.target.files; e.target.value = ""; if (picked?.length) uploadArtifacts(picked); }}
                  />
                </label>
                </>}
              </Header>
              {/* Input field for a text artifact. Sits in the sidebar (no modal) so that the file tree beside it stays visible. */}
              {textDraftOpen && !archived && (
                <form
                  className="cb-kit-pane cb-kit-pane-dashed mx-2 mb-2 flex shrink-0 flex-col gap-1.5 rounded-xl p-2"
                  onSubmit={(e) => { e.preventDefault(); saveTextArtifact(); }}
                >
                  <input
                    value={textDraftTitle}
                    onChange={(e) => setTextDraftTitle(e.target.value)}
                    placeholder={t("Title, e.g. meeting notes")}
                    aria-label={t("Title of the artifact")}
                    autoFocus
                    className={`${field} w-full px-2.5 py-1 text-[12px]`}
                  />
                  <textarea
                    value={textDraftBody}
                    onChange={(e) => setTextDraftBody(e.target.value)}
                    placeholder={t("Paste your text here…")}
                    aria-label={t("Content of the artifact")}
                    rows={5}
                    className={`${field} w-full resize-y px-2.5 py-1 font-mono text-[11.5px] leading-[1.5]`}
                  />
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-dim" title={artifactNameFromTitle(textDraftTitle)}>
                      {textDraftTitle.trim() ? artifactNameFromTitle(textDraftTitle) : t("No title, no file name")}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setTextDraftOpen(false); setTextDraftTitle(""); setTextDraftBody(""); }}
                      className="rounded-lg px-2 py-1 text-[11px] text-dim transition-colors hover:bg-hover hover:text-fg"
                    >
                      {t("Cancel")}
                    </button>
                    <button
                      type="submit"
                      disabled={artifactUploading || !textDraftTitle.trim() || !textDraftBody.trim()}
                      className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
                    >
                      {t("Save")}
                    </button>
                  </div>
                </form>
              )}
              {/* Drop on the tree uploads too. stopPropagation, because the chat area beside it has its own drop target for ATTACHMENTS. */}
              <div
                className={`cb-scroll min-h-0 flex-1 overflow-y-auto p-2 pt-0 ${artifactDragOver ? "rounded-xl outline-dashed outline-2 -outline-offset-2 outline-accent/70" : ""}`}
                onDragOver={(e) => {
                  if (archived || !e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setArtifactDragOver(true);
                }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setArtifactDragOver(false); }}
                onDrop={(e) => {
                  if (archived || !e.dataTransfer.files.length) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setArtifactDragOver(false);
                  uploadArtifacts(e.dataTransfer);
                }}
              >
                {/* Outputs visible: the chat's output location as the first folder; always there, read-only. */}
                <OutputsFolder chatId={activeId} />
                {artifacts.length === 0 ? (
                  <p className="px-3 py-7 text-center text-[12px] leading-relaxed text-dim">{t("No artifacts yet. Skills can store specifications, tickets, and other durable files here — or you upload files yourself.")}</p>
                ) : (
                  <ArtifactTree
                    artifacts={artifacts}
                    openDirs={openArtifactDirs}
                    onToggleDir={toggleArtifactDir}
                    onOpenFile={selectArtifact}
                    selectedKey={artifactSelected ? artifactKey(artifactSelected) : null}
                    locale={dateLocale()}
                  />
                )}
              </div>
            </section>
          )}
        </AnimatedSwitch>
      </section>

      {/* The open file from "Outputs": always mounted; a path in the chat opens it together with the bar (Artifacts). */}
      <OutputsWindow chatId={activeId} onJump={() => openRightSidebar("artifacts")} />

      {/* The activity bar: 40 px, full height, far right. One 36 px button per section with an 18 px icon, counter badge top right and,
          on the shown section, the accent mark at the left edge. The order is BAR_SECTIONS; `aria-pressed` means "the panel shows
          this section", when closed none is pressed. */}
      {/* The hairline on the left separates panel and rail only when the panel is OPEN — when closed, the left edge of the card is there. */}
      <nav data-bar-rail aria-label={t("Sections of the sidebar")} className={`flex w-10 shrink-0 flex-col items-center gap-0.5 bg-bg pt-1 ${rightSidebarOpen ? "border-l border-edge" : ""}`}>
        {BAR_SECTIONS.map((key) => {
          // The timeline belongs to a project (E2): without a project of the chat there is no button.
          if (key === "timeline" && !gitProjectId) return null;
          const a = sections[key];
          const active = rightSidebarOpen && rightSidebarTab === key;
          const tip = barTooltip(a.label, key, mac);
          const badge = badgeText(a.badge);
          return (
            <button
              key={key}
              type="button"
              data-bar-section={key}
              {...(key === "agents" ? { "data-agent-rail": "" } : {})}
              aria-pressed={active}
              // `aria-label` replaces the content, so the badge's count belongs in the name; otherwise a screen reader hears
              // "Channels", never the three unread.
              aria-label={badge ? `${tip} · ${a.badge}` : tip}
              title={tip}
              onClick={() => toggle(key)}
              className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-colors hover:bg-hover ${active ? "text-fg" : "text-dim hover:text-fg"}`}
            >
              {active && <span data-bar-active aria-hidden className="absolute inset-y-0 left-0 w-0.5 rounded-r-full bg-accent" />}
              {a.icon}
              {badge && (
                <span
                  data-bar-badge={key}
                  {...(key === "channels" ? { "data-channel-pill-unread": "" } : {})}
                  {...(a.foreign ? { "data-bar-badge-foreign": "1" } : {})}
                  aria-hidden
                  className={`absolute right-0.5 top-0.5 grid min-w-3.5 place-items-center rounded-full px-0.5 text-[9px] font-semibold leading-[14px] ${a.foreign ? "bg-warn text-bg" : "bg-accent text-white"}`}
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
    {tabView.slot && createPortal(
      <div className="flex min-h-0 flex-1 flex-col" data-chat-view-content={tabView.kind ?? ""}>
        {tabView.kind === "terminal" ? terminalContent : browserContent(slotVisible)}
      </div>,
      tabView.slot,
    )}
    </>
  );
}

// ── Browser section ─────────────────────────────────────────────────────────
// Head with the choice (the scope's own browser, the running agent browsers of this chat: main agent, subagents, workflow
// agents) and below it the BrowserPane. The list of browsers comes, as in the "Browser active" pill, from GET /api/browsers
// plus the events "browsers"/"init", subscribed only while the section is shown. The computation (choice per PROFILE, names,
// "controlling now") is in lib/browser-choice.ts; here it is only called. An entry is a name with the tab count on the right
// and a dot while the agent is controlling the browser, no sentence beneath it. If the chosen profile has no session right
// now (the agent starts a new Chromium per run), it says "closed", and as soon as the agent browses on, the view attaches
// to the new session by itself. Not loaded is not empty: until the list is there, the head does not say "no agent browser"
// and the surface starts no own browser for a choice that belongs to an agent.
// To the right of the choice, the button "Open in own window": an icon, the word only in title and aria-label. It opens the
// same extra window as the head pill, via the same call; the address is computed by `windowUrl` (agent as profile, own
// browser as scope, and none at all for the native own browser, then the button is missing). Whether the bridge is there
// is known only after mount (SSR), as in BrowserPane.
// The own browser carries the chat (`chatId` -> `/browser/ensure?chat=`); in a copy chat (`copy`) it is the copy's stream
// with the mark "Copy k1" in the head, and the extra window shows the same copy. `ready` holds it back until it is known
// whether the chat has a copy in the entered project.
function BrowserSection({ t, activeId, scope, copy: copyThePage, ready, copyMarker, choice, setChoice, active, agents, dynTree }: {
  t: ChatRightSidebarProps["t"];
  activeId: string | null;
  scope: { focusProjectId: string | null; chatProjectId: string | null; wsId: string };
  copy: string | null;
  ready: boolean;
  copyMarker: (name: string) => React.ReactNode;
  choice: string;
  setChoice: (id: string) => void;
  active: boolean;
  agents: ChatRightSidebarProps["agents"];
  dynTree: DynTreeStatus;
}) {
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [native, setNative] = useState<boolean | null>(null);
  useEffect(() => { setNative(nativeAvailable(window)); }, []);
  useEffect(() => {
    let alive = true;
    const set = (list: BrowserInfo[]) => { setBrowsers(list); setLoaded(true); setNow(Date.now()); };
    void api<{ browsers: BrowserInfo[] }>("/api/browsers")
      .then((r) => { if (alive) set(r.browsers || []); })
      .catch(() => {});
    const off = subscribeGlobalEvents((d) => {
      if (d.type === "browsers") set((d.list as BrowserInfo[]) || []);
      else if (d.type === "init" && Array.isArray(d.browsers)) set(d.browsers as BrowserInfo[]);
    });
    return () => { alive = false; off(); };
  }, []);
  // The "controlling now" mark expires by itself: a timer on the earliest expiry, otherwise the dot would stay until the next event
  // happens to arrive.
  useEffect(() => {
    const until = nextExpiry(browsers, now);
    if (until === null) return;
    const w = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(w);
  }, [browsers, now]);

  // The CHAT's browser: one per chat, in which its main agent also works: `/api/chats/<id>/browser/ensure` (lib/browser-choice.ts).
  // Without a chat, the entered scope's browser. It is always the server's stream (the client's native browser is another one
  // that no agent reaches). A chat switch changes the pane's key (a new stream, never an image of the old one), and BrowserPane
  // discards an answer for the old target (ensureTarget).
  const scopeApiBase = ownBrowserApiBase({ chatId: activeId, ...scope });
  const inChat = Boolean(activeId);
  // The head names the copy only if the chat is in the entered project (its browser runs in the copy there).
  const copy = scope.chatProjectId === scope.focusProjectId ? copyThePage : null;
  const names = useMemo(() => agentNames(agents, dynTree.runs), [agents, dynTree.runs]);
  const texts = useMemo(() => ({ main: t("Main agent"), sub: t("Subagent") }), [t]);
  const entries = useMemo(
    () => (activeId ? choiceEntries(browsers, activeId, names, texts, now) : []),
    [browsers, activeId, names, texts, now],
  );
  const state = resolveChoice(choice, browsers, activeId ?? "", loaded);
  const selectedEntry = state.kind === "agent" ? entries.find((e) => e.browserId === state.browser.id) ?? null : null;
  // The name in the button: the entry while it lives; a closed one keeps the name it last carried.
  const lastName = useRef<{ choice: string; name: string }>({ choice: "", name: "" });
  if (selectedEntry) lastName.current = { choice, name: selectedEntry.name };
  const controlsOwn = agentControlsOwn(browsers, activeId ?? "");
  const ownName = inChat ? t("Chat browser") : t("Own browser");
  const label = state.kind === "own"
    ? ownName
    : selectedEntry?.name ?? (lastName.current.choice === choice ? lastName.current.name : t("Agent browser"));
  const choiceClass = "flex h-6 max-w-[200px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-dim transition-colors enabled:hover:bg-hover enabled:hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg disabled:opacity-60";
  const point = (isActive: boolean) => (isActive
    ? <span data-browser-controls className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t("in use##controlling")} aria-label={t("in use##controlling")} />
    : null);
  const timeWindow = windowUrl(state, inChat ? scopeFromApiBase(scopeApiBase) ?? `chat:${activeId}` : scopeFromApiBase(scopeApiBase), inChat || copy ? false : native, activeId);

  return (
    <>
      <Header title={t("Browser")}>
        {state.kind === "own" && copy && copyMarker(copy)}
        {entries.length > 0 || state.kind !== "own" ? (
          <Menu
            label={t("Choose browser")}
            width={240}
            button={{
              content: (open) => <>{point(state.kind === "own" ? controlsOwn : Boolean(selectedEntry?.active))}<span className="truncate">{label}</span><Chevron open={open} size={11} /></>,
              className: choiceClass,
              data: { "data-browser-choice": state.kind },
            }}
          >
            <MenuEntry label={ownName} onClick={() => setChoice(CHOICE_OWN)} data={{ "data-browser-entry": CHOICE_OWN }} right={point(controlsOwn)} />
            {entries.map((e) => (
              <MenuEntry
                key={e.choice}
                label={e.name}
                onClick={() => setChoice(e.choice)}
                data={{ "data-browser-entry": e.choice, ...(e.active ? { "data-browser-active": "" } : {}) }}
                right={<>{point(e.active)}<span className="shrink-0 text-[11px] tabular-nums text-dim" title={e.tabs === 1 ? "1 Tab" : `${e.tabs} Tabs`}>{e.tabs}</span></>}
              />
            ))}
          </Menu>
        ) : (
          <button
            type="button"
            data-browser-choice={loaded ? "empty" : "loading"}
            disabled
            title={loaded ? t("No agent browser is running in this chat") : t("Choose browser")}
            aria-label={loaded ? t("No agent browser is running in this chat") : t("Choose browser")}
            className={choiceClass}
          >
            {point(controlsOwn)}<span className="truncate">{ownName}</span>
            <Chevron open={false} size={11} />
          </button>
        )}
        {timeWindow && (
          <button
            type="button"
            data-browser-window={timeWindow}
            onClick={() => openBrowserWindow(window, timeWindow)}
            title={t("Open in its own window")}
            aria-label={t("Open in its own window")}
            className={BAR_ACTION_CLASS}
          >
            {WindowIcon}
          </button>
        )}
      </Header>
      {/* Flush: the "bar" variant comes without the page's glass surface, tab and address row lie on the panel; only the page image
          is inset (like the terminal tub). */}
      <div className="flex min-h-0 flex-1 flex-col">
        {state.kind === "agent" ? (
          <BrowserPane key={`agent:${state.browser.id}`} browserId={state.browser.id} active={active} variant="bar" />
        ) : state.kind === "own" && !ready ? (
          <div className="min-h-0 flex-1" />
        ) : state.kind === "own" ? (
          <BrowserPane key={`own:${scopeApiBase}:${copy ?? ""}`} apiBase={scopeApiBase} chatId={activeId} onlyStream={inChat || Boolean(copy)} active={active} variant="bar" />
        ) : state.kind === "closed" ? (
          <div data-browser-closed className="grid min-h-0 flex-1 place-items-center px-7 text-center text-[12px] leading-relaxed text-dim">
            {t("The agent's browser is closed.")}
          </div>
        ) : (
          <div className="min-h-0 flex-1" />
        )}
      </div>
    </>
  );
}

// The instance choice button in the 32 px head of the git section: the pill form of the old mark, with a chevron.
const INSTANCE_CHOICE_CLASS = "flex h-6 min-w-0 max-w-[200px] shrink items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-opacity hover:opacity-80 aria-expanded:opacity-80";

// ── Icons of the activity bar (18 px) ────────────────────────
const GitIcon = svg(<><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v3a3 3 0 0 0 3 3h3" /><path d="M18 7v3a3 3 0 0 1-3 3h-3v4" /></>, 18);
// Agenda: a clipboard with two lines and a tick (the same symbol as `list.bullet.clipboard` on iOS).
const AgendaIcon = svg(<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5V3h6v1.5" /><path d="M8.5 10.5l1.5 1.5 2.5-2.5" /><path d="M14.5 11h1.5" /><path d="M8.5 16h7.5" /></>, 18);
const ArtifactIcon = svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h8" /></>, 18);
// Background Tasks: three stacked layers (work that lies BEHIND the chat), the top one with a filled dot saying "something runs
// here". The same symbol as `square.stack.3d.up` on the iOS button.
const BackgroundTasksIcon = svg(<><path d="M12 3.5 3.5 8l8.5 4.5L20.5 8z" /><path d="M3.5 12l8.5 4.5 8.5-4.5" /><path d="M3.5 16l8.5 4.5 8.5-4.5" /><circle cx="12" cy="8" r="1.3" fill="currentColor" stroke="none" /></>, 18);
// Terminal: prompt chevron + underscore (the same symbol as on the page's terminal tab).
const TerminalIcon = svg(<><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>, 18);
// Open in own window: a window with an arrow pointing out of its corner (14 px, like the other head actions).
const WindowIcon = svg(<><path d="M14 4h6v6" /><path d="M20 4l-8 8" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>, 14);
// Browser: window with an address bar.
const BrowserIcon = svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /><circle cx="6.5" cy="6.5" r=".6" fill="currentColor" stroke="none" /><path d="M9.5 6.5h8" /></>, 18);
