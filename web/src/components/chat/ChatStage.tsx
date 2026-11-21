"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { runNoteShown } from "@/lib/workflow-note";
import { api, type Chat, type ChatFolder, type LimitWait, type Project, type WorkflowRun, type Workspace } from "@/lib/api";
import { FileTabContext, NativeTaskBar, nativeTaskList } from "@/components/AssistantBlocks";
import { isGateWaitRow } from "@/lib/credit";
import { LimitStrip, useGateThreshold } from "@/components/LimitStrip";
import { ComposerBase } from "@/components/ComposerStrip";
import { ChatFolderView } from "@/components/ChatFolderView";
import { PermissionPrompt, type PermReq } from "@/components/PermissionPrompt";
import { type AskAnswer } from "@/components/AskCard";
import { SelectionMenu } from "@/components/SelectionMenu";
import { menuRow, menuRowDanger, useFlat } from "@/components/CbKit";
import { Contained, ContainScope, useHeightMemory } from "@/lib/contain";
import { memoryKey, rowOfTheBubble } from "@/lib/bubbles-key";
import { dayMarkers, timeOfTheBubble } from "@/lib/day-separator";
import { DaySeparator } from "@/components/chat/DaySeparator";
import { useRowsJump } from "@/components/chat/chatRowsJump";
import { useOlderReload } from "@/components/chat/chatOlder";
import { EndAnchor, useUserInput } from "@/lib/scroll";
import { useMarginWheel } from "@/lib/margin-wheel";
import { dateLocale } from "@/lib/i18n";
import { AutocompactMenu, ThresholdsMarker, workflowCompactionHint } from "@/components/Autocompact";
import { BubbleRow, ChatSkeleton } from "@/components/chat/ChatBubbleRow";
import { RunDisplay } from "@/components/chat/RunDisplay";
import { useRunningTasks } from "@/components/chat/chatTasks";
import type { Agent } from "@/lib/agents";
import type { DynTreeStatus } from "@/lib/dyn-tree";
import { foregroundRow, type GraphRunsStatus } from "@/lib/graph-runs";
import type { TaskItem } from "@/lib/running-tasks";
import type { Bubble, QueuedMessage } from "@/components/chat/chatBubbles";
import { BASE_VEIL_PX, lastResponseIdx, type AgentState } from "@/lib/history-state";
import { ChatInstanceChoice } from "@/components/chat/ChatInstanceChoice";
import { targetRoot } from "@/components/chat/ChatTabBar";
import type { InstanceOption } from "@/lib/instances-tree";
import { CaretDown, CheckIcon, CompressIcon, FolderIcon, KebabIcon, PinIcon } from "@/components/chat/ChatIcons";
import { contextWindowFor, fmtRunTime, fmtTokens, greeting } from "@/components/chat/ChatCatalog";
import type { ProviderMeta } from "@/components/chat/ChatCatalog";
import { clockTime } from "@/lib/chat-format";
import { contextDisplay, contextTitleText } from "@/lib/context-display";
import { ArchiveEntry } from "@/components/ArchiveEntry";
import { OuterLoopChatSheet } from "@/components/outerloop/OuterLoopChatSheet";
import { SkillToolWorkspace } from "@/components/SkillToolCard";
import { ChatTabBar, ChatTabTitle } from "@/components/chat/ChatTabBar";
import { ChatCodeArea } from "@/components/chat/ChatCodeArea";
import type { ChatTabsState } from "@/components/chat/chatTabs";

// The stage of the Coding chat: the chat area's root `div` as ONE tree: drop target for attachments, the folder view above
// it, the header as a glass plate (title, ... menu, focus, the three banners: limit, workflow, tasks), hero (greeting and
// project choice around the field in the middle) OR history (memory brake, `BubbleRow`, run indicator, approval cards,
// menu on the text selection), and the dock (task list, jump arrow, strip dock with the compaction row, toast,
// the composer SLOT, context bar). The call in ChatPane sits where the old root `div` was, in the `cb-kit-stage` surface in
// front of the right bar.
//
// What lives here: everything ONLY the stage reads: scroll sticking (`msgsInnerRef`, `heights`, `anchor` with `useUserInput`,
// `jumpDown`, the `useLayoutEffect` follow-up, the ResizeObserver on the content, the width and text-size re-measurement of the
// memory brake, `historyPresent`), the measurement of header and dock (`headerRef`/`headerH`, `dockRef`/`dockH`: the scroll area keeps
// exactly their height free), the gate threshold of the limit strip (`useGateThreshold`), the agent's task list
// (`nativeTasks`), the project binding in the hero (`heroProjectId`/`heroProjectLabel`), the last assistant bubble
// (`lastAssistantIdx`) and the stable handler identities for the memoised history row (`onCopyBubble`, `onAnswerAsk`,
// `onDecideApproval` via refs: they belong where `BubbleRow` is rendered; the handlers themselves arrive as props and are new on every render).
//
// What STAYS in ChatPane and arrives as a prop (rule: whatever open(), send, onEvent, the effects, composer, list or bar also
// read or set stays there: prop + setter, no context, no store):
// - `stickRef`: open() (chat switch), send() and answerAsk() set it to true: three writers outside; the stage reads and writes
//   it in the scroll handler, the sticking effect and the jump arrow. `msgsRef`: selectionInMessages() (the selection menu)
//   checks whether the selection is in the history. Both stay in ChatPane and arrive as a REF OBJECT (stable, one identity); no
//   handle (`forwardRef`): nothing in ChatPane triggers anything on the stage.
// - `activeIdRef` (the context bar reads the chat id on click) and `runStartRef` (run indicator and goal seconds read the run start
//   in render): also ref objects from ChatPane.
// - `empty`: the composer call in ChatPane reads it as `hero`, so ChatPane computes it and passes it in; `historyPresent` is read only by the stage.
// - `dragOver` is also toggled by the composer: the state stays in ChatPane, the stage only gets `setDragOver` and `addFiles`
//   (drop target; sabotage: drop without addFiles => red, composer-contract.test.mjs).
// - `headerMenu`, `projPickerOpen` (+ setters): the global popover closer `anyPopOpen` reads and closes them.
// - `selMenu`/`setSelMenu` (the Escape/mousedown effect, askAboutSelection, copySelection), `autoCopied` (copySelection sets it),
//   `copiedIdx` (copyBubble): prop + setter.
// - `folderView`/`setFolderView`/`folderContextTick`/`folderChats`: the event stream and the list write them.
// - `wfRun`/`wfTicking`/`wfNow`/`wfBusy`, `limitWait`, `queued`, `permReqs`, `busy`/`waiting`/`compacting`/`controlRunning`/
//   `streamingText`/`statusPair`, `wait*`, `goal`/`goalPaused`, `ctxTokens`/`inTokens`/`outTokens`, `bubbles`/`chatLoading`/
//   `activeId`/`activeChat`: stream state (onEvent, open()).
// - the handlers (`retryLimitNow`, `cancelLimitWait`, `skipWorkflowStep`, `cancelWorkflow`, `clearGoal`, `pauseGoal`, `control`,
//   `dismissQueued`, `compact`, `decidePermission`, `answerAsk`, `copyBubble`, `renameChat`/`togglePin`/`deleteChat`, which the list
//   menu also uses, `open`, `pickHeroProject`, `pushInfo`, `onAgentOpen`, which picks the agent for the right bar; `agentStates`, the
//   subagents' states from the agent list, which the right bar also reads) and the provider derivations (`currentProvider`,
//   `currentModel`, `providerDefault`, `providers`; composer, bar and runSlash read them too).
// - `setChats` (the context bar writes the auto-compaction into the list).
//
// The composer is a SLOT (`children`, required): the `<ChatComposer .../>` call sits in ChatPane between `<ChatStage ...>` and
// `</ChatStage>`, and the stage renders `{children}` at its old place in the dock. Its 54 props do NOT pass through the stage.
//
// Seams: in the body only the slot; in the shell `wsId` from `workspace.id` (as in ChatPane; the stage also reads
// `workspace.projects` and `workspace.name`). Timing: the five moved effects (measurement, sticking, follow-up, width, text size,
// plus those in `useUserInput` and `useGateThreshold`) now run as child effects BEFORE all ChatPane effects of the same commit
// (the `useLayoutEffect` before paint as before); none is read synchronously by a ChatPane effect. The stage is rendered
// unconditionally, its mount is ChatPane's mount, so the `[]` effects run equally often.
export type ChatStageProps = {
  t: (key: string, params?: Record<string, string | number>) => string;
  workspace: Workspace; // projects (project choice in the hero), name (label "Whole workspace")
  focusProject: Project | null; // entered project: header without a chat, focus mark, hero without project choice
  projectSel: string; // preselection of the next chat; the project binding in the hero reads it
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>; // the context bar writes the auto-compaction into the row
  activeId: string | null;
  bubbles: Bubble[];
  chatLoading: boolean; // history in flight: loading animation instead of hero
  timeWindow: { older: boolean; firstRow: number }; // the history window (chat/chatCache.ts `windowOf`): older rows before it?
  loadOlder: (until?: number) => Promise<void>; // appends the next older page (chat/chatOlder.ts); with `until` everything up to there
  busy: boolean;
  waiting: boolean; // wait phase: no run indicator in the history
  waitMonitors: { taskId?: string; description?: string }[];
  waitTasks: { taskId?: string; description?: string }[];
  waitWakeupAt: number;
  waitWakeup: { reason: string; prompt: string };
  agents: ReadonlyArray<Agent<unknown>>; // subagents (useBackground); the work row's pill counts the ones running in the background
  dynTree: DynTreeStatus; // progress tree of the dynamic workflows (useDynTree); the pill counts the running ones
  graphRuns: GraphRunsStatus; // graph-workflow starts (useGraphRuns); the strip "starts when the turn ends" in the dock
  graphHidden: ReadonlySet<string>; // startIds whose worktree hint was clicked away (memory only)
  stopGraphStart: (startId: string) => Promise<void>; // "Cancel" in the strip (POST .../graph-workflows/:startId/stop, from "human")
  fadeGraphOut: (startId: string) => void; // "Hide" on the worktree hint
  copiedIdx: number | null; // "copied" tick on a bubble (copyBubble)
  autoCopied: boolean; // "Copied" toast and the mark in the selection menu (copySelection)
  selMenu: { text: string; rect: DOMRect } | null; // menu on the text selection; ChatPane holds it (Escape effect, quoting)
  setSelMenu: React.Dispatch<React.SetStateAction<{ text: string; rect: DOMRect } | null>>;
  queued: QueuedMessage[]; // queued messages (strip dock, limit strip)
  setDragOver: React.Dispatch<React.SetStateAction<boolean>>; // drop target; the composer shows dragOver
  folderView: ChatFolder | null; // folder view ABOVE the chat area
  setFolderView: React.Dispatch<React.SetStateAction<ChatFolder | null>>;
  folderContextTick: number; // nudge to reload the folder view (event stream)
  projPickerOpen: boolean; // project choice in the hero; the global popover closer reads it
  setProjPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  ctxTokens: number; // context bar
  outTokens: number; // run indicator
  inTokens: number;
  statusPair: { run: string; done: string }; // status word of the run indicator
  streamingText: boolean; // visible answer text is arriving: no run indicator
  controlRunning: boolean;
  compacting: boolean;
  goal: string; // the set goal (strip dock)
  goalPaused: boolean; // the goal is paused (`chat.goalPaused`); the goal row says "Goal paused" and offers resume
  wfRun: WorkflowRun | null; // running workflow (banner)
  limitWait: LimitWait | null; // run parked at the limit (strip)
  wfBusy: boolean;
  wfNow: number; // one-second tick of the workflow banner (ChatPane ticks)
  wfTicking: boolean;
  permReqs: PermReq[]; // open interactive approvals
  providers: ProviderMeta[]; // context window per model
  runStartRef: React.RefObject<number | null>; // run start; read in render (run indicator, goal seconds)
  msgsRef: React.RefObject<HTMLDivElement | null>; // the scroll area; selectionInMessages reads it in ChatPane
  stickRef: React.RefObject<boolean>; // "stick to the end": open(), send(), answerAsk() set it in ChatPane
  headerMenu: boolean; // ... menu of the header; the global popover closer reads it
  setHeaderMenu: React.Dispatch<React.SetStateAction<boolean>>;
  activeIdRef: React.RefObject<string | null>; // the context bar reads the chat id on click
  folderChats: Map<string, Chat[]>; // chats per folder (folder view)
  open: (id: string) => Promise<void>; // open a chat (from the folder view)
  addFiles: (list: FileList | File[]) => Promise<void>; // drop target
  pushInfo: (title: string, body: string) => void; // info bubble (context bar)
  retryLimitNow: (anyway?: boolean) => Promise<void>; // limit strip
  cancelLimitWait: () => Promise<void>;
  skipWorkflowStep: () => Promise<void>; // workflow banner
  cancelWorkflow: () => Promise<void>;
  copyBubble: (i: number, text: string) => Promise<void>; // history row (via a stable ref)
  selectionInMessages: () => { text: string; rect: DOMRect } | null; // follow the selection on scroll
  onMessagesMouseUp: () => void;
  askAboutSelection: () => void; // selection menu
  copySelection: () => Promise<void>;
  clearGoal: () => Promise<void>; // strip dock
  pauseGoal: (p: boolean) => Promise<void>; // pause/resume of the goal row (PATCH { goalPaused })
  compact: () => Promise<void>; // context bar
  control: () => Promise<void>;
  dismissQueued: (q: { id: string; text: string }) => Promise<void>;
  decidePermission: (requestId: string, behavior: "allow" | "deny", extras?: { updatedInput?: Record<string, unknown>; message?: string; remember?: string }) => Promise<void>; // approval cards
  answerAsk: (requestId: string, answers: AskAnswer[]) => Promise<void>; // question card (via a stable ref)
  renameChat: (chat: Chat) => Promise<void>; // ... menu of the header (also the list's menu)
  togglePin: (chat: Chat) => Promise<void>;
  deleteChat: (chat: Chat) => Promise<void>;
  activeChat: Chat | undefined; // the open chat (header, context bar, project binding)
  pickHeroProject: (id: string | null) => void; // project choice in the hero
  instanceOptions: InstanceOption[]; // the project's selectable instances (chat/chatInstance.ts); empty: no choice
  activeInstance: string; // the current one: the open chat's, else the preselection of the next
  pickInstance: (name: string) => void; // choice in the hero (preselection) or switch in the head (PATCH { instance })
  copyCreate: () => void; // "Create copy ..." under the choice: the project's "Instances" tab, dialog with the current instance as base
  currentProvider: string; // context window of the current model
  providerDefault: (prov: string) => string;
  currentModel: string;
  onAgentOpen: (id: string) => void; // subagent mark in the history -> right bar
  agentStates: ReadonlyMap<string, AgentState | null>; // block id -> state, computed ONCE in the agent list
  empty: boolean; // no history: hero instead of scroll area, no jump arrow (ChatPane also gives it to the composer)
  archived: boolean; // archive: read-only; no drop, no project choice, no "Reply", mark in the head
  archive: (opts: { dismissQuestion?: boolean }) => Promise<void>; // ... of the header: the open chat shows the bar at once
  restore: () => Promise<void>; // ... of the header of an archived chat
  draftFolder: ChatFolder | null; // the draft's folder (chat/chatDraft.ts); the strip under the field names it
  chatTabs: ChatTabsState; // code tabs in the chat (chat/chatTabs.ts): tab bar and title row in the head, the code area above history and dock
  children: React.ReactNode; // the composer, at its old place in the dock
};

// Where the empty chat's project choice opens (it hangs on the body): downward as long as at least 240 px are free there or
// more than above, otherwise upward, and never taller than the free space instead of being cut off at the window edge.
function projectSituation(r: DOMRect): React.CSSProperties {
  const MARGIN = 12, CLEARANCE = 6, WIDTH = 260;
  const bottom = window.innerHeight - r.bottom - CLEARANCE - MARGIN;
  const top = r.top - CLEARANCE - MARGIN;
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - WIDTH - MARGIN));
  return bottom >= 240 || bottom >= top
    ? { left, top: r.bottom + CLEARANCE, maxHeight: bottom, transformOrigin: "top left" }
    : { left, bottom: window.innerHeight - r.top + CLEARANCE, maxHeight: top, transformOrigin: "bottom left" };
}

export function ChatStage(props: ChatStageProps) {
  const {
    t, workspace, focusProject, projectSel, setChats, activeId, bubbles, chatLoading, timeWindow, loadOlder, busy, waiting,
    waitMonitors, waitTasks, waitWakeupAt, waitWakeup, agents, dynTree, graphRuns, graphHidden, stopGraphStart, fadeGraphOut, copiedIdx, autoCopied,
    selMenu, setSelMenu, queued, setDragOver, folderView, setFolderView, folderContextTick,
    projPickerOpen, setProjPickerOpen, ctxTokens, outTokens, inTokens, statusPair, streamingText, controlRunning,
    compacting, goal, goalPaused, wfRun, limitWait, wfBusy, wfNow, wfTicking, permReqs, providers,
    runStartRef, msgsRef, stickRef, headerMenu, setHeaderMenu, activeIdRef, folderChats,
    open, addFiles, pushInfo, retryLimitNow, cancelLimitWait, skipWorkflowStep, cancelWorkflow,
    copyBubble, selectionInMessages, onMessagesMouseUp, askAboutSelection, copySelection, clearGoal, pauseGoal, compact,
    control, dismissQueued, decidePermission, answerAsk, renameChat, togglePin, deleteChat, activeChat,
    pickHeroProject, instanceOptions, activeInstance, pickInstance, copyCreate, currentProvider, providerDefault, currentModel, onAgentOpen, agentStates, empty,
    archived, archive, restore, draftFolder, chatTabs, children,
  } = props;
  const flat = useFlat();
  // The Outer Loop's chat info: a sheet from the header's ... menu, open for THIS chat.
  const [outerLoopChat, setOuterLoopChat] = useState<string | null>(null);
  const wsId = workspace.id;
  // The agent's task list: derived from ALL blocks of the history (the state only arises from the sequence of Task* calls);
  // subagent blocks are left out, they carry their own lists.
  const nativeTasks = useMemo(() => nativeTaskList(bubbles.filter((b) => !b.dimmed).flatMap((b) => b.blocks)), [bubbles]);
  // What runs beside the main agent (background subagents, dynamic workflows, background commands, monitors, wake-up timer) as ONE
  // list for the work row's pill (chat/chatTasks.ts, computation lib/running-tasks.ts). The background graph workflows
  // count too (`graphRuns`).
  const runningTasks = useRunningTasks({ agents, tasks: waitTasks, monitors: waitMonitors, wakeupAt: waitWakeupAt, wakeup: waitWakeup, dynTree, graphRuns });
  // "Open" in the pill's sheet: the agent bar on the right with a subagent selected (the same path as the mark in the history);
  // a workflow, dynamic or a background graph workflow, opens the bar without a choice, its card stands there under
  // "Background Tasks" (and its "Open" shows the child chat).
  const onTaskOpen = useCallback((p: TaskItem) => onAgentOpen(p.kind === "agent" ? p.anchor : ""), [onAgentOpen]);
  // The strip of the queued graph-workflow start (computation lib/graph-runs.ts): "starts when the turn ends" / "waits: {reason}" with
  // Cancel, "worktree with changes stays" with Hide. From `running` on the header's workflow strip speaks. A failed stop (409:
  // the run was just starting) arrives as a hint.
  const graphStrip = foregroundRow(graphRuns, graphHidden);
  const graphRow = graphStrip && {
    startId: graphStrip.startId,
    kind: graphStrip.kind,
    text: t(graphStrip.text, graphStrip.params),
    button: t(graphStrip.button),
    onButton: graphStrip.action === "abort"
      ? () => stopGraphStart(graphStrip.startId).catch((e) => pushInfo("Note", String((e as Error).message)))
      : () => fadeGraphOut(graphStrip.startId),
  };
  // The gate's percentage mark comes from the server (one number, one source; see LimitStrip.tsx).
  const gateThreshold = useGateThreshold(isGateWaitRow(limitWait));
  // Inner reading column: its height is the TRUE content height (the ResizeObserver hangs on it).
  const msgsInnerRef = useRef<HTMLDivElement>(null);
  // Height memory of the memory brake (lib/contain.tsx). Lives as long as this view and thereby survives chat switches; on
  // jumping back the scroll height is right at once.
  const heights = useHeightMemory();
  // Mark own jumps to the end; otherwise the scroll handler takes them for the user (lib/scroll).
  const anchor = useMemo(() => new EndAnchor(), []);
  // The jump "row in chat" (a timeline hit, lib/rows-jump.ts): scrolls to the row's bubble as soon as the chat is loaded.
  useRowsJump({ activeId, chatLoading, count: bubbles.length, msgsRef, stickRef, window: timeWindow, loadOlder });
  // Older pages on scrolling up, scroll position kept (chat/chatOlder.ts).
  useOlderReload({ msgsRef, bubbles, activeId, chatLoading, older: timeWindow.older, loadOlder });
  useUserInput(anchor);
  const bringAlongRef = useRef(0); // the one pending follow-up after a layout scroll (onScroll)
  // User intent at the wheel, ONE version for the wheel over the history (`onWheel`) and the one over the empty margin beside it
  // (`useMarginWheel`, lib/margin-wheel.ts): up means "stop sticking to the end"; otherwise the next answer would tear down a
  // history the user scrolled up at the margin. The margin surface itself is a callback ref from the helper.
  const userWheel = useCallback((dy: number) => { anchor.userInput(); if (dy < 0) stickRef.current = false; }, [anchor, stickRef]);
  const marginRef = useMarginWheel(msgsRef, userWheel);
  // Arrow "jump to end" above the composer: visible as soon as the reader has left the lower edge. Deliberately a more generous
  // threshold than stick (80), so it does not flicker at the edge.
  const [jumpDown, setJumpDown] = useState(false);
  // Header and dock lie as glass plates OVER the scrolling history; the scroll area keeps exactly their MEASURED height free at
  // top and bottom. The dock grows with the text field, attachments and hint rows, the head with the banners (limit, workflow,
  // tasks); a guessed number would be wrong for both.
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockH, setDockH] = useState(104);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(44);
  // Where the project choice button stood when it opened: its sheet hangs on the body and aligns to it.
  const [projAnchor, setProjAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    const observe = (el: HTMLElement | null, set: (h: number) => void) => {
      if (!el) return () => {};
      const measure = () => set(el.getBoundingClientRect().height);
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      measure();
      return () => ro.disconnect();
    };
    const a = observe(dockRef.current, setDockH);
    const b = observe(headerRef.current, setHeaderH);
    return () => { a(); b(); };
  }, []);
  // While a code tab is in front, history and dock lie UNDER the code area: unreachable for the Tab key and focus (`inert`);
  // otherwise a covered input field would keep typing, and Tab would jump into a surface nobody sees. `codeFront`: the chat is
  // covered (code area, terminal or browser as a tab); history and dock are then unreachable.
  const codeFront = chatTabs.chatObscured;
  // The file name of an Edit/Write row in the history opens a file tab (AssistantBlocks.tsx `FileTabContext`).
  const fileRoot = targetRoot(workspace, chatTabs.chatTarget);
  const fileTab = useMemo(() => ({ chatKey: chatTabs.chatKey, root: fileRoot, cwd: workspace.path }), [chatTabs.chatKey, fileRoot, workspace.path]);
  useEffect(() => {
    for (const el of [msgsRef.current, dockRef.current]) if (el) el.inert = codeFront;
  }, [codeFront, empty, activeId, msgsRef]);

  // BEFORE paint (useLayoutEffect): with useEffect the browser drew the grown content at the old scrollTop first and then jumped
  // to the end, a visible twitch.
  useLayoutEffect(() => {
    const m = msgsRef.current;
    if (!m) return;
    // Follow to the end while the user "sticks" at the bottom, and always when opening a chat: open() sets stick. A remembered scroll
    // position per chat is gone, because an opened chat should ALWAYS stand at the end, even if one left it further up.
    if (stickRef.current) anchor.toEnd(m);
    // Follow the arrow's visibility too: if scrollTop happens to stay equal on a chat switch, no scroll event fires; the arrow
    // would show the previous chat's state.
    setJumpDown(m.scrollHeight - m.scrollTop - m.clientHeight > 160);
    // dockH belongs here: when the input grows, the lower padding grows; whoever stuck to the end would otherwise be 40 px off.
  }, [bubbles, dockH]);

  // STICK to the bottom even when the content grows without a state change. The scroll area exists only with a history (otherwise
  // the hero image stands): the two observers below must attach AGAIN once it appears. With `[]` they ran into the void at the first
  // render on the hero and never attached afterwards: after opening a chat the content shrank by 11 px (re-measurement of the
  // memory brake), nobody followed, and the history stood 2.5 px above the edge. It keys on `!empty` itself (ChatPane computes it),
  // not an own copy of the condition that did not know the first-message mark (`firstInFlight`).
  const historyPresent = !empty;

  // The effect above fires only when `bubbles` changes. But the height also grows afterwards: indented subagent rows are added,
  // a collapsed row expands, Markdown re-wraps after the font loads, an image gets its dimensions. Such growth triggers NO scroll
  // event; the reader then stood a bit above the end and the last message was clipped. The ResizeObserver follows exactly these cases.
  useEffect(() => {
    const m = msgsRef.current;
    const inner = msgsInnerRef.current;
    if (!m || !inner) return;
    // Compute the arrow here too: after a clamp on opening it stood at the clamped layout's distance (about 0) and was never
    // recomputed; the history stood above the end and the arrow was missing.
    const pin = () => {
      if (stickRef.current) anchor.toEnd(m);
      setJumpDown(m.scrollHeight - m.scrollTop - m.clientHeight > 160);
    };
    const ro = new ResizeObserver(pin);
    ro.observe(inner);
    ro.observe(m); // window height/composer growth shrinks the scroll view
    return () => ro.disconnect();
  }, [historyPresent, anchor]);

  // If the reading column gets NARROWER or WIDER, the text wraps differently; the memory brake's remembered heights then no longer
  // fit and the scroll height would drift. So after a width change, release everything once, re-measure and lock again.
  // Debounced, so that this does not happen per pixel when dragging the window edge (the history would then be drawn
  // completely throughout, exactly what is to be avoided).
  useEffect(() => {
    const inner = msgsInnerRef.current;
    if (!inner) return;
    let width = inner.getBoundingClientRect().width;
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? width;
      if (Math.abs(w - width) < 1) return;
      width = w;
      clearTimeout(timer);
      timer = setTimeout(() => heights.remeasure(msgsInnerRef.current), 250);
    });
    ro.observe(inner);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, [heights, historyPresent]);

  // After a text-size change `useHeightMemory` re-measures itself (lib/contain, central for every brake in the app); so only the
  // width is here.

  // Project binding in the hero: without a chat the preselection (projectSel), else the open chat's.
  const heroProjectId = activeId ? (activeChat?.projectId ?? null) : projectSel || null;
  const heroProject = workspace.projects.find((p) => p.id === heroProjectId);
  const heroProjectLabel = heroProject ? t("Project · {name}", { name: heroProject.name }) : t("Entire workspace · {name}", { name: workspace.name });

  // Which bubble counts as LIVE? The streaming one and, while the run is busy, the last assistant bubble: whoever joins a running chat
  // (reload, chat switch) gets the history without a `streaming` mark, and the call that is really running would otherwise lose its
  // spinner. Accepted: between `run_started` and the first new bubble the previous answer counts as live for a moment; visible only
  // if there is a call without a result.
  const lastAssistantIdx = lastResponseIdx(bubbles);
  // The day divider before the first row of a calendar day (lib/day-separator.ts): computed over the LOADED rows; if older ones are
  // still on the server (`window.older`), the first loaded gets none, so a shown one never disappears again.
  const days = useMemo(() => dayMarkers(bubbles.map(timeOfTheBubble), { olderBeforehand: timeWindow.older, now: Date.now() }), [bubbles, timeWindow.older]);

  // Stable handler identities for the memoised history row. The handlers themselves are function declarations in the component
  // body and thus new on EVERY render; passed as props they would have silently defeated BubbleRow's memoisation.
  const copyBubbleRef = useRef(copyBubble);
  copyBubbleRef.current = copyBubble;
  const answerAskRef = useRef(answerAsk);
  answerAskRef.current = answerAsk;
  const onCopyBubble = useCallback((i: number, text: string) => { void copyBubbleRef.current(i, text); }, []);
  const onAnswerAsk = useCallback((requestId: string, answers: AskAnswer[]) => { void answerAskRef.current(requestId, answers); }, []);
  const decidePermissionRef = useRef(decidePermission);
  decidePermissionRef.current = decidePermission;
  const onDecideApproval = useCallback((requestId: string, behavior: "allow" | "deny", extras?: { updatedInput?: Record<string, unknown>; message?: string }) => { void decidePermissionRef.current(requestId, behavior, extras); }, []);

  return (
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (activeId && !archived && e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!activeId) return;
          e.preventDefault();
          setDragOver(false);
          if (archived) return; // read-only: in the archive the stage accepts no attachment
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
      >
        {/* Folder view: lies OVER the chat area (absolute inset-0), so that the open chat with its event stream stays and a click on
            a chat leads straight back. z-30, ABOVE the conversation's header (z-20): it comes later in the DOM and would
            otherwise paint over the folder view's head at the same z-index. */}
        {folderView && (
          <div className="absolute inset-0 z-30">
            <ChatFolderView
              folder={folderView}
              chats={folderChats.get(folderView.id) ?? []}
              reloadToken={folderContextTick}
              locale={dateLocale()}
              onOpenChat={(id) => { void open(id); }}
              onClose={() => setFolderView(null)}
            />
          </div>
        )}
        {/* The conversation's header: which chat, whether it runs, its three actions, and below it the fixed hints (usage limit,
            workflow, tasks). It lies as a plate OVER the history; its height is measured (`headerH`) and given to the history as
            top padding. It is ALWAYS there, so the view does not jump on load. The veil covers this measured height FULLY and fades
            out 10 px BELOW (`bottom-[-10px]`, mask in globals.css); the history's padding leaves 12 px free (`headerH + 12`), so the
            first message stands free when scrolled to the very top, and what scrolls through underneath fades out, in every text
            size (both hang on the same measurement). */}
        {/* Both veils carry the card's own inner rounding (11 px = 12 px rounding - 1 px edge; whoever rounds the card differently
            adjusts both). It dates from the blurred veils: the card's `overflow-hidden rounded-[12px]` (ChatPane.tsx) did not clip a
            `backdrop-filter` round everywhere. The veils are opaque now and need no blur; the rounding stays as a safe edge. */}
        {/* Code tabs in the chat: above the title row the tab bar: `[Chat · Name]` (the run mark stands there, no longer before the
            title), the open views, files and diffs, then the ... menu (Explorer · Browser · Terminal) and far right the instance
            choice. The title row changes with the tab: in the chat the head as before, in the code area path and buttons; terminal
            and browser bring their own head. In the code area the veil is dropped: nothing scrolls under the head there. */}
        <div ref={headerRef} className="absolute inset-x-0 top-0 z-20">
          <div className={`cb-kit-veil-top pointer-events-none absolute inset-x-0 top-0 bottom-[-10px] rounded-t-[11px] ${codeFront ? "hidden" : ""}`} aria-hidden />
          <ChatTabBar
            t={t}
            tabs={chatTabs}
            chatName={activeChat?.title || t("New chat")}
            right={activeChat && !archived && instanceOptions.length > 0 ? (
              /* The open chat's instance: switch from the next turn on; without focus the button names the project itself. */
              <ChatInstanceChoice t={t} location="header" options={instanceOptions} active={activeInstance} onPick={pickInstance} onCopyCreate={copyCreate} preamble={focusProject ? undefined : heroProject?.name} />
            ) : null}
          />
          {/* Terminal and browser as a tab bring their own head (the right bar's): no second title row above. */}
          {chatTabs.tabView.kind ? null : codeFront ? <ChatTabTitle t={t} tabs={chatTabs} workspace={workspace} /> : (
          <div className="relative flex h-9 items-center gap-1 px-3">
            {activeChat?.pinned && <span className="shrink-0 text-dim"><PinIcon /></span>}
            <h2 className="min-w-0 truncate text-[13.5px] font-medium">
              {activeChat ? activeChat.title || t("New chat") : focusProject ? focusProject.name : ""}
            </h2>
            {archived && <span data-archive-marker className="shrink-0 rounded-full bg-edge px-1.5 py-[1px] text-[10px] font-semibold text-dim">{t("Archived")}</span>}
            {activeChat && (
              <div className="relative shrink-0" data-pop="header">
                <button
                  type="button"
                  onClick={() => setHeaderMenu((v) => !v)}
                  title={t("More")}
                  aria-label={t("More")}
                  className={`grid h-7 w-7 place-items-center rounded-lg transition-colors hover:bg-hover hover:text-fg ${headerMenu ? "bg-hover text-fg" : "text-dim"}`}
                >
                  <KebabIcon />
                </button>
                {headerMenu && (
                  <div className="cb-pop-in-fast cb-pop absolute left-0 top-full z-40 mt-1 w-[208px] origin-top-left overflow-hidden rounded-xl p-1.5 text-fg">
                    {/* Archived: only Restore and Delete; Rename/Pin would change it. */}
                    {archived ? (
                      <button type="button" data-archive-restore={activeChat.id} onClick={() => { setHeaderMenu(false); restore().catch((e) => alert((e as Error).message)); }} className={`${menuRow} text-[12.5px]`}>
                        {t("Restore")}
                      </button>
                    ) : (
                      <>
                    <button type="button" onClick={() => { setHeaderMenu(false); renameChat(activeChat); }} className={`${menuRow} text-[12.5px]`}>
                      {t("Rename")}
                    </button>
                    <button type="button" onClick={() => { setHeaderMenu(false); togglePin(activeChat); }} className={`${menuRow} text-[12.5px]`}>
                      {activeChat.pinned ? t("Unpin") : t("Pin")}
                    </button>
                    <button type="button" data-outerloop-open={activeChat.id} onClick={() => { setHeaderMenu(false); setOuterLoopChat(activeChat.id); }} className={`${menuRow} text-[12.5px]`}>
                      {t("Outer loop")}
                    </button>
                    <ArchiveEntry target={{ kind: "chat", id: activeChat.id }} execute={archive} prior={() => setHeaderMenu(false)} />
                      </>
                    )}
                    {/* Branch, project and folder stay in the list's menu: that is where the targets to move to are. */}
                    <button type="button" onClick={() => { setHeaderMenu(false); deleteChat(activeChat); }} data-danger className={`${menuRowDanger} text-[12.5px]`}>
                      {t("Delete")}
                    </button>
                  </div>
                )}
              </div>
            )}
            {focusProject && activeChat && (
              <span className="ml-auto flex min-w-0 shrink items-center gap-1 truncate pl-2 text-[11.5px] text-dim" title={t("Focus · {name}", { name: focusProject.name })}>
                <FolderIcon />
                <span className="truncate">{focusProject.name}</span>
              </span>
            )}
          </div>
          )}
          {/* The fixed hints in the same column as the dock: the reading column itself, 784 px minus its own side padding (2 x 24 px) = 736;
              on a narrow stage the same width as the dock. They belong to the conversation: they are not shown in the code area
              (the chat tab carries the mark). */}
          {!codeFront && activeId && (limitWait || wfRun) && (
            <div className="relative mx-auto flex w-full max-w-[784px] flex-col gap-1.5 px-4 pb-2 sm:px-6">
        {/* Run parked at the usage limit: reason, time, countdown and the buttons. It stands ABOVE everything else, as the answer to
            "why is nothing happening?". `queued`: what was sent while parked waits BEHIND the continuation. */}
        {activeId && (
          <LimitStrip
            wait={limitWait}
            threshold={gateThreshold}
            onNow={() => retryLimitNow()}
            onAnyway={() => retryLimitNow(true)}
            onAbort={cancelLimitWait}
            queued={queued.length > 0}
          />
        )}
        {/* Running workflow: progress as a fixed head above the history, with Skip and Cancel. Finished/aborted runs stay as a quiet
            row so that one can see later that this chat ran a workflow. */}
        {activeId && wfRun && (
          <div className="cb-kit-pane flex items-center gap-2 overflow-hidden rounded-xl px-2.5 py-1.5 text-[12px]">
            {/* Without state colour, like the limit strip and the status lines (chat/StatusLine.tsx). */}
            <span className="shrink-0 text-dim">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="2.5" y="3.5" width="7" height="5" rx="1.5" />
                <rect x="14.5" y="3.5" width="7" height="5" rx="1.5" />
                <path d="M9.5 6h5" />
                <path d="M6 8.5V16a2 2 0 0 0 2 2h8" />
              </svg>
            </span>
            <span className="shrink-0 text-dim">{t("Workflow")}</span>
            <span className="min-w-0 flex-1 truncate">
              {wfRun.name}
              {wfRun.status === "running" || wfRun.status === "waiting" ? (
                <span className="text-dim">
                  {" · "}
                  {t("Step {step}/{total}", { step: wfRun.step, total: (wfRun.approx ? "ca. " : "") + wfRun.total })}
                  {wfRun.nodeTitle ? ` · ${wfRun.nodeTitle}` : ""}
                  {wfRun.loop ? ` · ${t("Item {i}/{n}", { i: wfRun.loop.index, n: wfRun.loop.total })}` : ""}
                </span>
              ) : (
                <span className="text-dim">
                  {" · "}
                  {wfRun.status === "done" ? t("completed") : wfRun.status === "cancelled" ? t("cancelled") : t("failed")}
                  {wfRun.note ? ` · ${runNoteShown(wfRun.note, t)}` : ""}
                </span>
              )}
            </span>
            {wfRun.status === "waiting" && (
              <span className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] text-fg/80">
                {wfRun.pending === "review" ? t("waiting for your review") : t("waiting for your answer")}
              </span>
            )}
            {/* Total runtime of the run: ticking while it runs or waits. A workflow consists of many turns; the runtime per answer
                does not tell how long the run has been going IN TOTAL. */}
            {wfRun.startedAt > 0 && (
              <span
                className="shrink-0 tabular-nums text-dim"
                title={t("Total runtime of this run (since {start})", { start: clockTime(wfRun.startedAt) })}
              >
                {fmtRunTime((wfRun.endedAt || (wfTicking ? wfNow : wfRun.updatedAt)) - wfRun.startedAt)}
              </span>
            )}
            {(wfRun.status === "running" || wfRun.status === "waiting") && (
              <>
                <button
                  type="button"
                  onClick={skipWorkflowStep}
                  disabled={wfBusy}
                  title={t("Skip this step and continue with the next")}
                  className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-fg disabled:opacity-40"
                >
                  {t("Skip")}
                </button>
                <button
                  type="button"
                  onClick={cancelWorkflow}
                  disabled={wfBusy}
                  title={t("Cancel the workflow (the chat stays)")}
                  className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-dim hover:bg-hover hover:text-fg disabled:opacity-40"
                >
                  {t("Cancel")}
                </button>
              </>
            )}
          </div>
        )}
            </div>
          )}
        </div>
        {/* The code area: covers history AND dock, below the head with tab bar and title row (z-20). Mounted only once a code tab was in
            front in this chat (or Cmd+P is open), afterwards kept hidden: content, terminal and unsaved content survive the switch to
            the chat tab; new per chat (`key`), because the drafts belong to the chat. */}
        {chatTabs.codeMounted && (
          <div className={`absolute inset-0 z-[15] flex flex-col rounded-[11px] bg-panel ${chatTabs.codeVisible ? "" : "hidden"}`} style={{ paddingTop: headerH }} data-chat-code>
            <ChatCodeArea key={chatTabs.chatKey} t={t} tabs={chatTabs} workspace={workspace} />
          </div>
        )}
        {/* Terminal or browser as a tab (the bar's ... menu): only the PLACE; the right bar draws the content into it via a portal
            (ChatRightSidebar, `tabView`); it owns both with choice and copy logic. Mounted only while the view is in front; the terminals
            keep running on a switch and re-attach next time. */}
        {chatTabs.tabView.kind && (
          <div ref={chatTabs.setViewSlot} className="absolute inset-0 z-[15] flex flex-col overflow-hidden rounded-[11px] bg-panel" style={{ paddingTop: headerH }} data-chat-view={chatTabs.tabView.kind} />
        )}
        {/* `chatLoading` belongs in the condition: while loading, `bubbles` is still empty, and without it the view jumped to the hero image
            first and straight back. */}
        {empty ? (
          /* No message yet: greeting, input field and project choice stand as ONE group in the middle of the stage. They live in the dock,
             which moves to the middle for it (see `dockRef`), so the input field stays the same element and keeps focus and draft when it
             jumps down after the first send. Only the empty surface remains here. */
          <div className="min-h-0 flex-1" aria-hidden />
        ) : (
          <>
        {/* The history scrolls UNDER header and dock: top and bottom padding exactly as tall as the two glass plates (measured, not guessed:
            the dock grows with the text field, the header with the hints in it). Prose in sans, 15.5 px on 1.7; code blocks bring their own
            monospace. The scrollbar stands at the RIGHT EDGE OF THE STAGE: the scroll area fills the stage, the reading column in it stays
            736 px and centred, as wide as the composer. `useMarginWheel` and the margin surface `@container/history` stay: the margin
            is now empty except for header and dock, over which the helper passes nothing on. */}
        <div ref={marginRef} className="@container/history flex min-h-0 flex-1 flex-col" data-history-margin>
        <div
          ref={msgsRef}
          onMouseUp={onMessagesMouseUp}
          onScroll={(e) => {
            const m = e.currentTarget;
            // On scrolling the selection moves; the menu follows instead of staying at the old place (the same promise as in the iOS app).
            if (selMenu) {
              const found = selectionInMessages();
              setSelMenu(found ? { text: found.text, rect: found.rect } : null);
            }
            // Follow only whoever REALLY stands at the end (lib/scroll), not "almost at the bottom". And only a scroll by the USER
            // decides: own jump, scroll anchoring and clamping after a shrink arrive as "2 px above" and would otherwise unstick.
            const k = anchor.sticks(m);
            if (k !== null) stickRef.current = k;
            // A layout scroll (anchoring, clamping) with a sticking history: back to the end. The ResizeObserver does not help here:
            // if the content shrinks and grows in the same frame it reports nothing, but the anchoring has already moved the position
            // (2 px). And once more in the NEXT frame: a clamp occurs when the memory brake applies a remembered height and the content
            // only afterwards gets its real height; the jump in the same frame still landed at the old edge.
            else if (stickRef.current) {
              anchor.toEnd(m);
              if (!bringAlongRef.current) bringAlongRef.current = requestAnimationFrame(() => {
                bringAlongRef.current = 0;
                if (stickRef.current) anchor.toEnd(m);
                setJumpDown(m.scrollHeight - m.scrollTop - m.clientHeight > 160);
              });
            }
            if (k && anchor.toEdge(m)) anchor.toEnd(m); // sticks, but a fraction above the edge, without input (lib/end-anchor.ts)
            setJumpDown(m.scrollHeight - m.scrollTop - m.clientHeight > 160);
          }}
          // `cb-chat-text`: 15.5 px x text size from Settings -> Appearance (lib/appearance).
          onWheel={(e) => userWheel(e.deltaY)}
          onTouchMove={() => anchor.userInput()}
          onPointerDown={() => anchor.pointerBottom()}
          className="cb-scroll cb-chat-text min-h-0 flex-1 overflow-y-auto px-4 leading-[1.7] sm:px-6"
          style={{ paddingTop: headerH + 12, paddingBottom: dockH + BASE_VEIL_PX }}
        >
          {/* Reading column instead of surface: 736 px at 15.5 px sans is about 82 characters. */}
          <div ref={msgsInnerRef} className="mx-auto flex w-full max-w-[736px] flex-col gap-6">
          <ContainScope memory={heights}>
          <FileTabContext.Provider value={fileTab}>
          {/* The switch swaps this block as a WHOLE (key): that resets the fade-in animation while the outer node with the ResizeObserver
              stays. The key also changes from "loading" to "done": so first the loading animation fades in and then the arrived
              history, instead of jumping hard. */}
          <div
            key={`${activeId ?? ""}:${chatLoading && bubbles.length === 0 ? "load" : "ready"}`}
            className="cb-chat-in flex flex-col gap-6"
            data-history-column
          >
          {chatLoading && bubbles.length === 0 ? <ChatSkeleton /> : (<>
          {/* Every bubble sits in a memory brake (lib/contain.tsx): outside the picture it is not drawn but keeps its MEASURED height, so the
              scroll height and with it scrollbar, remembered scroll position and the jump arrow stay exact. The key names the CONTENT
              (lib/bubbles-key.ts: first log line + fingerprint; a bubble created live is never served from memory); with chat id +
              position a finished answer got the height of the half-streamed one on coming back. */}
          {/* The workspace for the tool block of cbase_skill_write (SkillToolCard.tsx: Undo reads the workspace's history); a context creates
              no element, the column's spacing stays. */}
          <SkillToolWorkspace.Provider value={wsId}>
          {bubbles.map((b, i) => { const ck = memoryKey(activeId ?? "", b, i); const day = days[i]; return (
            <Fragment key={i}>
            {day && <DaySeparator key="day" marker={day} />}
            <Contained key="row" ck={ck} row={rowOfTheBubble(b)}>
              <BubbleRow
                b={b}
                index={i}
                chatId={activeId}
                ck={ck}
                copied={copiedIdx === i}
                onCopy={onCopyBubble}
                onAnswerAsk={onAnswerAsk}
                onDecideApproval={onDecideApproval}
                liveApproval={b.role === "approval" && !!b.approval?.open && !b.approval.ruling && permReqs.some((r) => r.requestId === b.approval!.requestId)}
                liveRun={busy && i === lastAssistantIdx}
                onAgentOpen={onAgentOpen}
                agentStates={agentStates}
                t={t}
              />
            </Contained>
            </Fragment>
          ); })}
          </SkillToolWorkspace.Provider>
          {/* The work row (chat/RunIndicator.tsx) as in Claude Code: turning hexagon at the text edge, runtime and tokens, the pill "N running
              tasks", the status word. The work itself only in thinking/tool phases; hidden while visible answer text arrives. In the WAIT
              PHASE (and after the turn, as long as something runs in the background) only the resting hexagon and the pill stand: it says
              what is being waited for. */}
          <RunDisplay
            word={statusPair.run}
            startedAt={runStartRef.current}
            inTokens={inTokens}
            outTokens={outTokens}
            busy={busy}
            streamingText={streamingText}
            waiting={waiting}
            tasks={runningTasks}
            chatId={activeId}
            onTaskOpen={onTaskOpen}
          />
          {/* Interactive tool approvals (permission mode "Ask"/"Auto-Edit"): the run waits here. */}
          {permReqs.map((r) => (
            <PermissionPrompt key={r.requestId} req={r} onDecide={(behavior, extras) => decidePermission(r.requestId, behavior, extras)} />
          ))}
          </>)}
          </div>
          </FileTabContext.Provider>
          </ContainScope>
          </div>
        </div>
        </div>
        {/* Menu on the text selection in the history (hangs on document.body via a portal). */}
        {selMenu && (
          <SelectionMenu
            rect={selMenu.rect}
            copied={autoCopied}
            onAsk={archived ? undefined : askAboutSelection}
            onCopy={() => { copySelection().catch(console.error); }}
          />
        )}
          </>
        )}
        {/* The dock: status line, tasks, hints, input field and context bar, as a glass plate OVER the history, with a measured height
            (`dockH`) that the history reserves as lower padding. */}
        {/* In the empty chat it stands in the MIDDLE (greeting above, project choice below): pulled up by half its own height, but never
            below the header; `dockH` is exactly this height. Inline instead of a class: the dock's classes are an anchor
            (chat-scrollbar.test.mjs works with their side padding). The veil belongs only to the scrolling history; in the middle of
            the empty stage it would be a band. */}
        <div ref={dockRef} className="absolute inset-x-0 bottom-0 z-10 px-4 pb-1.5 sm:px-6"
          style={empty ? { top: `max(50%, ${headerH + 16 + dockH / 2}px)`, bottom: "auto", transform: "translateY(-50%)" } : undefined}>
          {!empty && <div className="cb-kit-veil-bottom pointer-events-none absolute inset-x-0 bottom-0 rounded-b-[11px]" style={{ top: -BASE_VEIL_PX }} aria-hidden />}
          {/* The composer column IS the reading column (736 px): 16 px beyond the text on each side would make it wider than the chat. */}
          <div className="relative mx-auto flex w-full max-w-[736px] flex-col">
        {/* The greeting above the field, without a name: in server operation every user has their own container, and a fixed name in the
            JSX would greet everyone with the same foreign name. Guard: the private-name scan of tools/check/cleanliness.mjs. */}
        {empty && (
          <div className="cb-tab-enter mb-7 flex flex-col items-center px-4 text-center">
            <h1 className="text-[28px] font-medium tracking-[-0.02em]">{t(greeting())}</h1>
            {/* In the archive nothing invites writing. */}
            {archived && <p className="mt-3 text-[13.5px] leading-relaxed text-dim">{t("This chat is archived.")}</p>}
          </div>
        )}
        {/* The agent's task list (the CLI's own Task* tools): the technical step sequence of the running job. Stays here instead of
            moving with the history. */}
        {activeId && <NativeTaskBar tasks={nativeTasks} />}
        {/* Dock, strips and input field as ONE unit: the jump arrow hangs on its top edge (`bottom-full`) and thus stands above the
            strips, not on them. */}
        <div className="relative flex w-full flex-col">
        {!empty && (
          <button
            type="button"
            onClick={() => {
              const m = msgsRef.current;
              if (!m) return;
              stickRef.current = true; // from now on follow the end again (as if scrolled there by hand)
              m.scrollTo({ top: m.scrollHeight, behavior: "smooth" });
            }}
            title={t("Jump to latest")}
            aria-label={t("Jump to latest")}
            tabIndex={jumpDown ? 0 : -1}
            // Form: a circle in the reading surface's ground with a fine ring, an arrow with a shaft in foreground colour; no `cb-pop`.
            // iOS likewise (`ChatArrowOverlay` in Chat/ChatView.swift).
            className={`absolute bottom-full left-1/2 z-30 mb-2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-fg/20 bg-panel text-fg transition-all duration-200 hover:bg-hover ${
              jumpDown ? "opacity-100" : "pointer-events-none translate-y-1.5 opacity-0"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
          </button>
        )}
        {/* The docked strip dock: the running compaction (the first row), the set goal (with delete, pause, expand), the queued
            graph-workflow start and the queued messages (what runs on the side is in the work row's pill in the history), all in the same
            form, pushed under the composer glass (see globals.css). The task list stays expressly ABOVE: it is multi-line and has
            a form of its own. */}
        {activeId && !archived && (
          <ComposerBase
            chatId={activeId}
            compressed={compacting}
            goal={goal}
            goalSeconds={busy && runStartRef.current !== null
              ? Math.max(1, Math.round((Date.now() - runStartRef.current) / 1000))
              : null}
            goalPaused={goalPaused}
            onGoalEnd={clearGoal}
            onGoalPause={pauseGoal}
            queued={queued}
            onControl={control}
            onDismiss={dismissQueued}
            graphRow={graphRow}
            // During compaction "Control" is locked: there is no running turn to cancel, and the messages start by themselves after
            // the summary (the server rejects it with 409). The compaction row in the dock says why.
            controlRunning={controlRunning || compacting}
          />
        )}
        {/* Auto-copy hint: a short "Copied" toast after a text selection in the message area. Via a portal on the body: the content area
            is a `@container`, and `fixed` would otherwise refer to it instead of the window. */}
        {autoCopied && createPortal(
          <div className={`cb-pop-in-fast cb-pop pointer-events-none fixed bottom-28 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-fg${flat}`}>
            <CheckIcon />
            {t("Copied")}
          </div>,
          document.body,
        )}
        {/* The input field is ALWAYS here, also without a chat: the first message creates it (ensureChat). `empty` only controls what
            is offered IN it (workflow start). */}
        {children}
        </div>
        {/* Under the field in the empty chat: the project choice (as in Claude Desktop) as a strip peeking out from under the input field;
            see `.cb-strip-below` in globals.css. Binds the future chat (projectSel) or moves the existing empty chat; fixed under project focus. */}
        {empty && !archived && (
          <div className="cb-strip-bottom flex items-center gap-1 px-2 text-[12.5px]">
            {focusProject ? (
              <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 font-medium text-dim">
                <span className="text-accent"><FolderIcon /></span>
                {t("Focus · {name}", { name: focusProject.name })}
              </span>
            ) : (
              <div className="relative" data-pop="project">
                <button
                  type="button"
                  onClick={(e) => { setProjAnchor(e.currentTarget.getBoundingClientRect()); setProjPickerOpen((v) => !v); }}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition-colors hover:bg-hover hover:text-fg ${projPickerOpen ? "bg-hover text-fg" : "text-dim"}`}
                >
                  <FolderIcon />
                  {heroProjectLabel}
                  {heroProject?.setup && <span className="text-[11px] text-dim">· {t("being set up")}</span>}
                  <CaretDown />
                </button>
                {/* On the body, not in the strip: there the stage's edge cut off the list, and opened upward it would lie UNDER the input field
                    (the strip is a stack of its own below it). `data-pop` on the sheet too, otherwise the popover closer would take a click in
                    it for one outside. */}
                {projPickerOpen && projAnchor && createPortal(
                  <div data-pop="project" style={projectSituation(projAnchor)} className={`cb-kit cb-pop-in-fast cb-pop fixed z-50 w-[260px] overflow-y-auto rounded-2xl p-1.5 text-fg${flat}`}>
                    <button
                      type="button"
                      onClick={() => pickHeroProject(null)}
                      className={`${menuRow} text-[13px] ${
                        heroProjectId ? "" : "font-medium"
                      }`}
                    >
                      {t("Entire workspace")}
                      {!heroProjectId && <span className="ml-auto text-dim"><CheckIcon /></span>}
                    </button>
                    {workspace.projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => pickHeroProject(p.id)}
                        className={`${menuRow} text-[13px] ${
                          heroProjectId === p.id ? "font-medium" : ""
                        }`}
                      >
                        <span className="truncate">{p.name}</span>
                        {/* "Chats wait": selectable in every state; a turn then waits until the server step is through. */}
                        {p.setup && <span className="shrink-0 text-[11px] text-dim">{t("being set up")}</span>}
                        {heroProjectId === p.id && <span className="ml-auto shrink-0 text-dim"><CheckIcon /></span>}
                      </button>
                    ))}
                  </div>,
                  document.body,
                )}
              </div>
            )}
            {/* The instance beside the project choice: for every converted project (also without a copy: then main and "Create copy ...").
                */}
            <ChatInstanceChoice t={t} location="hero" options={instanceOptions} active={activeInstance} onPick={pickInstance} onCopyCreate={copyCreate} />
            {/* The draft's folder: "New chat in folder" no longer creates at once; without this label the click would look like any other
                empty chat. Display only: the choice is made via the list's folder menu. */}
            {draftFolder && (
              <span data-draft-folder className="flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-dim">
                <span className="truncate">{t("Folder · {name}", { name: draftFolder.name })}</span>
              </span>
            )}
          </div>
        )}
        {/* Context-window usage: directly under the input field. Visible in every open chat (also at 0 %, e.g. fresh or after a provider
            switch); fills with the next run. */}
        {activeId && !archived && !empty && (() => {
          const win = contextWindowFor(currentModel || providerDefault(currentProvider), currentProvider, providers);
          // Denominator, share and the provider of the last answer (lib/context-display.ts): shown against that window, computed
          // (menu, threshold) with `win`, the catalogue number.
          const display = contextDisplay({ tokens: ctxTokens, catalogWindow: win, provider: activeChat?.upstreamProvider, providerWindow: activeChat?.upstreamWindow });
          // Both sliders of the auto menu take the same path: a partial PATCH, then the same row in the cache; written separately
          // the two values would drift apart.
          const setAutocompact = async (fields: { autocompact?: number | null; autocompactMax?: number | null }) => {
            const id = activeIdRef.current;
            if (!id) return;
            try {
              await api(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
              setChats((cs) => cs.map((c) => (c.id === id ? { ...c, ...fields } : c)));
            } catch (e) { pushInfo("Note", String((e as Error).message)); }
          };
          const frac = display.share;
          // While a workflow run is OPEN (`wfTicking`: running or waiting), its own compaction values apply before the chat's:
          // workflow value if not default; else chat value; else global. The mark therefore shows the workflow value, the menu keeps
          // the chat choice (it applies after the run) and says in one line what applies right now.
          const wfCompaction = wfTicking ? (wfRun?.compaction ?? null) : null;
          const markerShare = typeof wfCompaction?.percent === "number" ? wfCompaction.percent : activeChat?.autocompact;
          const markerCap = typeof wfCompaction?.max === "number" ? wfCompaction.max : activeChat?.autocompactMax;
          const wfHint = wfCompaction && (wfCompaction.percent !== null || wfCompaction.max !== null)
            ? workflowCompactionHint(wfCompaction, t)
            : null;
          return (
            /* Half-quiet: a 2 px track, fully there only on hover. At 0 % NO bar: a minimum width left a blue dot that looks like lint.
               `relative z-[2]`: the opacity makes the bar its own stacking context, and the auto menu in it (z-40) opens upward over the
               composer glass (z-[1]); without its own z-index it lay UNDER it, both lists covered (autocompact.mjs measures the hit). */
            <div className="relative z-[2] mb-2 flex w-full items-center gap-2 px-4 opacity-70 transition-opacity duration-200 hover:opacity-100">
              {/* `relative` without overflow-hidden: the threshold mark protrudes 2 px beyond the track. */}
              <div className="relative h-[2px] flex-1 rounded-full bg-edge">
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    frac > 0.85 ? "bg-danger" : frac > 0.6 ? "bg-warn" : "bg-accent"
                  }`}
                  style={{ width: ctxTokens > 0 ? `${Math.max(1, Math.min(100, frac * 100))}%` : "0%" }}
                />
                <ThresholdsMarker chatValue={markerShare} chatMax={markerCap} window={win} denominator={display.denominator} />
              </div>
              <span className="shrink-0 text-[10.5px] tabular-nums text-dim" title={contextTitleText(display, t, fmtTokens) || undefined}>
                {t("Context")} {fmtTokens(ctxTokens)} / {fmtTokens(display.denominator)}{display.provider ? ` · ${display.provider}` : ""} · {display.percent} %
              </span>
              {/* Compact context (like /compact): only useful if there is already context. */}
              {ctxTokens > 0 && (
                <button
                  type="button"
                  onClick={() => compact()}
                  disabled={busy || compacting}
                  title={t("Compact the context — summarize the history so less context is carried along (/compact)")}
                  className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
                >
                  <CompressIcon />
                  {compacting ? t("compacting…") : t("Compact")}
                </button>
              )}
              {/* Auto-compact per chat: Default · Off · Level. */}
              <AutocompactMenu
                chatValue={activeChat?.autocompact}
                chatMax={activeChat?.autocompactMax}
                window={win}
                disabled={compacting}
                workflowHint={wfHint}
                onSelect={(w) => setAutocompact({ autocompact: w })}
                onSelectMax={(w) => setAutocompact({ autocompactMax: w })}
              />
            </div>
          );
        })()}
          </div>
        </div>
        {outerLoopChat && <OuterLoopChatSheet chatId={outerLoopChat} workspaceId={wsId} onClose={() => setOuterLoopChat(null)} />}
      </div>
  );
}
