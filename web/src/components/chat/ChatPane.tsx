"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, loadWindow, type Attachment, type Chat, type ChatFolder, type LimitWait, type LogEntry,
  subscribeGlobalEvents, type WorkflowRun, type Workspace,
} from "@/lib/api";
import { useConfirm, usePrompt } from "@/components/Prompts";
import { FlatContext } from "@/components/CbKit";
import { resultToText } from "@/components/AssistantBlocks";
import { isGateWaitRow } from "@/lib/credit";
import { artifactIsText, artifactKey, ArtifactModal, afterTheSave, type ChatArtifact, type ChatArtifactContent } from "@/components/ArtifactBrowser";
import { type PermReq } from "@/components/PermissionPrompt";
import { type AskAnswer } from "@/components/AskCard";
import { type ApprovalRuling } from "@/components/ApprovalCard";
import { draftKey, draftKeyNew, readDraft, deleteDraft, useDraft, moveDraft } from "@/lib/draft";
import { useT } from "@/lib/i18n";
import { filesOf, readableFile, type UploadSource } from "@/lib/drop-files";
import { useAutoCollapse } from "@/lib/viewport";
import { isSection } from "@/lib/chat-bar";
import { terminalLayoutKey, terminalScope } from "@/components/TerminalsPane";
import { PASTE_PREVIEW_CHARS, pastedFileName, pastedPreviews } from "@/components/chat/ChatBubbleRow";
import {
  addError as addErrorPure, applyClear as applyClearPure, buildBubbles, markAskAnswered as markAskAnsweredPure,
  markApprovalDecided as markApprovalDecidedPure, reduceChatEvent, streamAfterEvent,
} from "@/components/chat/chatBubbles";
import type { AskBubble, Bubble, QueuedMessage, ReducerCtx } from "@/components/chat/chatBubbles";
import { PERM_MODES, PROVIDER_SWITCH_NOWARN, RIGHT_SIDEBAR_OPEN_KEY, RIGHT_SIDEBAR_TAB_KEY, STATUS_WORDS, artifactUrl, contextWindowFor, fmtTokens } from "@/components/chat/ChatCatalog";
import type { RightSidebarTab } from "@/components/chat/ChatCatalog";
import { ChatComposer, type ChatComposerHandle } from "@/components/chat/ChatComposer";
import { ChatRightSidebar } from "@/components/chat/ChatRightSidebar";
import { ChatListPane } from "@/components/chat/ChatListPane";
import { ChatStage } from "@/components/chat/ChatStage";
import { useChatStream } from "@/components/chat/chatStream";
import { useHistoryCache } from "@/components/chat/chatCache";
import { useModelChoice } from "@/components/chat/chatModelChoice";
import { useBackground } from "@/components/chat/chatBackground";
import { useDynTree } from "@/components/chat/chatDynTree";
import { useGraphRuns } from "@/components/chat/chatGraphRuns";
import { agendaEvent } from "@/components/chat/chatAgenda";
import { useArchive } from "@/components/chat/chatArchive";
import { useChatInstance } from "@/components/chat/chatInstance";
import { chatDeleted, rememberCreationFromDraft, useChatTabs } from "@/components/chat/chatTabs";
import { useAgentJump } from "@/components/chat/chatAgentJump";
import { useAgendaJump } from "@/components/chat/chatAgendaJump";
import { useNewChat } from "@/components/chat/chatDraft";
import { oneCreation } from "@/lib/chat-draft";
import { instanceSwitchFromEvent } from "@/lib/instances-tree";
import { ArchiveBar } from "@/components/ArchiveBar";
import { runSlash as runSlashPure } from "@/components/chat/chatSlash";
import { ProviderSwitchModal } from "@/components/chat/ProviderSwitchModal";
import { fmtDur } from "@/lib/chat-format";
import { SCHEDULED_CHANGED } from "@/lib/scheduled";
import { applyCopyEvent } from "@/lib/chat-location";
import { NO_WORKFLOW_CHATS, WORKFLOW_EVENT, workflowChatsFromInit, workflowChatsApply, type WorkflowChats } from "@/lib/workflow-chats";
import { withQuotes } from "@/lib/quotes";

// Chat UI in the style of the Claude desktop app, scoped to a workspace: the chat list + creation on the left, the chat window on
// the right. Lives in the "Chats" tab of the workspace detail. onChanged() reports creation/deletion to the detail (counter).
export function ChatPane({
  workspace,
  focusProjectId = null,
  onChanged,
  onlyChat = null,
}: {
  workspace: Workspace;
  // If set: the chat area has "entered" this project; list, preselection and new chats are scoped to it. The agent still starts
  // in the workspace (skills) but gets the project focus via the system prompt (server side via resolveCwd/projectFocusPrompt).
  focusProjectId?: string | null;
  onChanged?: () => void;
  /** Mode `onlyChat` (Coding → Scheduled): exactly THIS chat, without a chat list; it opens it instead of the remembered one, does
   *  not remember it as the scope's last open chat and follows no foreign "open chat" (the Chats tab next to it takes that). The
   *  caller sets `key` to the id; another chat is a new pane. */
  onlyChat?: string | null;
}) {
  const ask = usePrompt();
  const question = useConfirm();
  const t = useT();
  const wsId = workspace.id;
  // Remember the last open chat per scope (workspace level vs. entered project kept apart).
  const chatKey = `cbase-chat:${wsId}:${focusProjectId ?? "ws"}`;
  const focusProject = workspace.projects.find((p) => p.id === focusProjectId) ?? null;
  const [projectSel, setProjectSel] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  // Sidebar hexagon: running chats (spins) and chats with a finished, unread reply (glows).
  const [runningChats, setRunningChats] = useState<Set<string>>(() => new Set());
  // Chats with an open dynamic workflow (runs outside the turn, `runningChats` does not know it); the list's hexagon spins then
  // too (lib/workflow-chats.ts).
  const [workflowChats, setWorkflowChats] = useState<WorkflowChats>(NO_WORKFLOW_CHATS);
  const [unreadChats, setUnreadChats] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  // The switch has happened but this chat's history is still on its way (only on the FIRST open; afterwards it is in the cache and
  // the switch has no loading state). Drives the loading animation and tells "still loading" from "really empty chat".
  const [chatLoading, setChatLoading] = useState(false);
  // The first message of an empty chat is on its way: from sending until the first row in the history the chat no longer counts
  // as empty, so the field moves down ONCE on send and stays there. Without the mark it sat in the middle during that time
  // (creation, stream, POST), and `open()` of the creation switched it back and forth (loading = not empty, loaded without rows
  // = empty). Reset on the first row, on error, on switching to another chat or workspace and on the draft.
  const [firstInFlight, setFirstInFlight] = useState(false);
  useEffect(() => { if (bubbles.length) setFirstInFlight(false); }, [bubbles.length]);
  const [busy, setBusy] = useState(false);
  // Background state (chat/chatBackground.ts): waiting phase, the five wait states, their setters from the stream
  // (`backgroundEvent`) and the agents derived from them.
  const { waiting, waitMonitors, waitTasks, waitWakeupAt, waitWakeup, agents, agentStates, backgroundEvent, taskSequence } = useBackground(bubbles, busy);
  const { dynTree, treeEvent } = useDynTree(activeId); // progress tree of the dynamic workflows
  // Graph workflow starts of the chat: the strip "starts when the turn ends" / "waits for lock" above the field.
  const { graphRuns, graphEvent, stopGraphStart, respondGraph, graphHidden, fadeGraphOut } = useGraphRuns(activeId);
  const [input, setInput] = useState("");
  // Draft per chat: the text survives tab, page and chat switches and ⌘R (localStorage). On a chat switch it stays with the chat
  // being left (it used to move along to the next one). Without a chat (hero) one key per scope applies; ensureChat re-keys it
  // to the new id on creation. open() saves and loads explicitly because it knows before switching which chat is being left.
  const currentDraftKey = activeId ? draftKey(activeId) : draftKeyNew(wsId, focusProjectId);
  const draft = useDraft(currentDraftKey, input, setInput);
  const [files, setFiles] = useState<Attachment[]>([]);
  // Quotes from the history ("reply" on selected text): a list of their own next to the text: card above the field, mark inside
  // it (chat/ChatQuotes.tsx); `send` prepends them as "> …" to the message (lib/quotes.ts). They belong to the open chat like
  // the waiting attachments and go with every chat switch (effect below).
  const [quotes, setQuotes] = useState<string[]>([]);
  useEffect(() => { setQuotes([]); }, [activeId]);
  const [artifacts, setArtifacts] = useState<ChatArtifact[]>([]);
  const [rightSidebarTab, setRightSidebarTabState] = useState<RightSidebarTab>(() => {
    // Allowlist: whatever is missing from BAR_SECTIONS (lib/chat-bar.ts) silently falls back to "gitlab"; a new section belongs
    // THERE in the list, not here.
    try { const v = localStorage.getItem(RIGHT_SIDEBAR_TAB_KEY); return isSection(v) ? v : "gitlab"; }
    catch { return "gitlab"; }
  });
  const [rightSidebarOpen, setRightSidebarOpenState] = useState<boolean>(() => {
    try { return localStorage.getItem(RIGHT_SIDEBAR_OPEN_KEY) !== "0"; }
    catch { return true; }
  });
  // The right chat sidebar (artifacts/GitLab, up to 372 px) closes below 1250 px and reopens on enlarging. Deliberately the RAW
  // setter, not setRightSidebarOpen: an automatic reaction to the window width must not overwrite the user's stored choice,
  // otherwise the sidebar would stay "closed" after shrinking once.
  useAutoCollapse(1250, rightSidebarOpen, setRightSidebarOpenState);
  const [artifactSelected, setArtifactSelected] = useState<ChatArtifact | null>(null);
  const [artifactContent, setArtifactContent] = useState<ChatArtifactContent | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Copying a bubble (index → brief "copied" check mark).
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [autoCopied, setAutoCopied] = useState(false); // "Copied" hint after copying
  // Menu on the text selection in the history ("Reply / Copy"), rectangle in window coordinates.
  const [selMenu, setSelMenu] = useState<{ text: string; rect: DOMRect } | null>(null);
  const autoCopyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Server-side message queue of the active run. This way it survives tab/view switches and is injected provider-neutrally at the
  // next safe turn boundary.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The composer (chat/ChatComposer.tsx): its handle for `send` (clear); the picker flags and the text field stay here because
  // the stage, `send` and the global closer touch them.
  const composerRef = useRef<ChatComposerHandle>(null);
  const [sortOpen, setSortOpen] = useState(false);
  // Chat folders of the list with their expanded state (remembered per workspace: a folder left open is open again next visit).
  const [folders, setFolders] = useState<ChatFolder[]>([]);
  // The open FOLDER VIEW (context files + artifacts of all chats in the folder). It lays itself over the chat surface instead of
  // replacing it: the open chat stays with its event stream.
  const [folderView, setFolderView] = useState<ChatFolder | null>(null);
  // Counter as a nudge to reload the folder view (event "folder_context_changed").
  const [folderContextTick, setFolderContextTick] = useState(0);
  const [folderSel, setFolderSel] = useState(""); // folder for the next (not yet created) chat
  const openFoldersKey = `cbase-open-folders:${wsId}`;
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(`cbase-open-folders:${wsId}`) || "[]");
      setOpenFolders(new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []));
    } catch { setOpenFolders(new Set()); }
  }, [wsId]);
  const toggleFolder = (id: string) =>
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(openFoldersKey, JSON.stringify([...next])); } catch { /* local preference is optional */ }
      return next;
    });
  const revealFolder = (id: string) =>
    setOpenFolders((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev).add(id);
      try { localStorage.setItem(openFoldersKey, JSON.stringify([...next])); } catch { /* local preference is optional */ }
      return next;
    });
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [projPickerOpen, setProjPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [permSel, setPermSel] = useState("bypassPermissions"); // new chats: full access automatically
  const [permPickerOpen, setPermPickerOpen] = useState(false);
  const [ctxTokens, setCtxTokens] = useState(0);
  const [outTokens, setOutTokens] = useState(0);
  const [inTokens, setInTokens] = useState(0);
  const [statusPair, setStatusPair] = useState(STATUS_WORDS[0]);
  // Is visible reply text streaming in? Then we hide the run indicator, since the text is visibly being produced. The indicator
  // shows only the thinking/tool phases.
  const [streamingText, setStreamingText] = useState(false);
  const [stopping, setStopping] = useState(false); // abort requested, waiting for run_aborted
  const [controlRunning, setControlRunning] = useState(false); // "steer" in flight: the button locks so a second click does not trigger the same abort twice
  const [compacting, setCompacting] = useState(false); // /compact (compacting) is running
  // Provider switch of an existing chat: warning modal (target remembered) + execution state.
  const [providerSwitch, setProviderSwitch] = useState<{ providerId: string; model: string; label: string } | null>(null);
  const [switchNoWarn, setSwitchNoWarn] = useState(false); // checkbox "do not show again"
  const [switching, setSwitching] = useState(false); // compact + switch is running
  const [goal, setGoalText] = useState(""); // overarching goal of the open chat (via /goal)
  const [goalPaused, setGoalPaused] = useState(false); // the goal is paused (button in the goal line)
  // Goal and pause go together: every set or clear lifts the pause (like the server on PATCH { goal }); only loading a chat row
  // brings its state along: `setGoal(chat.goal ?? "", chat.goalPaused)`. `targetStatusRef` counts every set: a response sent
  // BEFORE the last set (GET in open/revalidateChat/reloadOpenChatLog, PATCH of pause or trash) no longer shows its goal, since
  // it would otherwise overwrite a just-set pause.
  const targetStatusRef = useRef(0);
  const setGoal = useCallback((target: string, paused?: boolean) => { targetStatusRef.current++; setGoalText(target); setGoalPaused(paused === true); }, []);
  // The todo bar above the history is gone: there is no task list any more; a Coding chat plans through its agenda.
  // Workflows: the running one. A graph workflow starts via `/workflow:<shortName>` in an ordinary message; the selectable list
  // is state of the slash picker in the composer.
  const [wfRun, setWfRun] = useState<WorkflowRun | null>(null);
  // Read inside the bubble updates (setBubbles closures), hence a ref: decides whether a user row invalidates an open question
  // card (see closeAsks).
  const wfRunRef = useRef<WorkflowRun | null>(null);
  wfRunRef.current = wfRun;
  // Run of this chat parked at the usage limit (auto-continue): strip above the history.
  const [limitWait, setLimitWait] = useState<LimitWait | null>(null);
  const applyLimitWait = useCallback((next: LimitWait | null) => {
    // Take over only forward: the answer of a slow GET must not turn back a newer SSE state (same trap as with workflow
    // progress).
    setLimitWait((prev) => (prev && next && next.updatedAt < prev.updatedAt ? prev : next));
  }, []);
  // No `run_started` has arrived since the last `send()`: the start is still pending. If the credit gate intercepts it, only
  // `limit_wait` comes instead of `run_started`, and `busy` would stay true forever (permanent spinner, send button in stop mode,
  // /clear rejected).
  const startPendingRef = useRef(false);
  // Take over states of the same run ONLY forward: the HTTP response of the start still carries step 0 and REGULARLY arrives
  // AFTER the first SSE events (measured); without this barrier the strip jumped back to "step 0" and stayed there.
  const applyWfRun = useCallback((next: WorkflowRun | null) => {
    setWfRun((prev) => (prev && next && prev.id === next.id && next.updatedAt < prev.updatedAt ? prev : next));
  }, []);
  const [wfBusy, setWfBusy] = useState(false); // skip/abort is running
  // One-second tick ONLY while a workflow runs or waits, for the total runtime in the strip. Deliberately not hung on the run
  // ticker: a workflow also waits between two steps and on a question, and then no turn runs at all.
  const [wfNow, setWfNow] = useState(() => Date.now());
  const wfTicking = wfRun?.status === "running" || wfRun?.status === "waiting";
  useEffect(() => {
    if (!wfTicking) return;
    setWfNow(Date.now());
    const id = setInterval(() => setWfNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [wfTicking, wfRun?.id]);
  const [permReqs, setPermReqs] = useState<PermReq[]>([]); // open interactive tool approvals
  // Enable width/opacity transitions only after the first paint, so a possible initial correction (hydration) does not animate
  // visibly; user clicks afterwards do.
  const [animReady, setAnimReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const [, tickRender] = useState(0); // 1 s tick so the runtime counts up
  const runStartRef = useRef<number | null>(null);
  const outTokensRef = useRef(0);
  const inTokensRef = useRef(0);
  // Output tokens arrive cumulatively PER API call (message_delta); baseline per message_start.
  const msgOutBaseRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const openSeqRef = useRef(0); // running open() sequence: only the latest switch may apply
  const streamRef = useRef({ open: false, gotText: false });
  const msgsRef = useRef<HTMLDivElement>(null);
  // Scroll to the end automatically only if the user is at the bottom anyway (no forced jump).
  const stickRef = useRef(true);
  // Search over the list's titles (on demand) and the ⋯ of the header.
  const [listSearch, setListSearch] = useState("");
  const [headerMenu, setHeaderMenu] = useState(false);
  // Returned into a running run? Then reload the history from the DB after run_done.
  const joinedMidRunRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // Is a turn running? Then the reconciliation from the cache must not write into the live history: it would enter a state from
  // seconds ago.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // The chat's event stream (chat/chatStream.ts): refs and the three healers.
  const { esRef, streamSeenRef, streamReadyRef, esRetryRef, esWatchdogRef, awaitChatStream, attachChatStream } = useChatStream({ activeIdRef, onEvent });

  // ── History cache per chat ──────────────────────────────────────────────────
  // History cache (chatCache.ts; the hook sits at THIS place: the hook position of the ref and two useCallbacks). What the
  // reconcile functions read goes in as a GETTER (`loadArtifacts` is declared further down, an object would hit the TDZ).
  const { chatCacheRef, putChatCache, dropChatCache, syncChatCache, reloadOpenChatLog, revalidateChat, applyReconcile, reconcileAfterConnected, afterTheLoad, loadOlder, windowOf } = useHistoryCache(() => ({ activeIdRef, setBubbles, setCtxTokens, setGoal, openSeqRef, busyRef, loadArtifacts, targetStatusRef, joinedMidRunRef }));
  const timeWindow = windowOf(activeId); // the open chat's window (older rows before it? chat/chatOlder.ts, chatRowsJump.ts)

  // Project of a chat to be created: in project focus the focus project, otherwise the preselection.
  const newChatProjectId = () => focusProjectId ?? (projectSel || null);
  // Folders that match the chosen project scope; only those may be given to the new chat.
  const newChatFolders = useMemo(
    () => folders.filter((f) => (f.projectId ?? null) === (focusProjectId ?? (projectSel || null))),
    [folders, focusProjectId, projectSel],
  );
  // When the project preselection changes, the remembered folder often no longer fits → reset.
  useEffect(() => {
    setFolderSel((cur) => (cur && !newChatFolders.some((f) => f.id === cur) ? "" : cur));
  }, [newChatFolders]);

  // In project focus show only the chats of this project.
  const scopedChats = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    const inScope = focusProjectId ? chats.filter((c) => c.projectId === focusProjectId) : chats;
    // Deliberately over the TITLES only: a search pretending to find content would be worse than none.
    return q ? inScope.filter((c) => (c.title || "").toLowerCase().includes(q)) : inScope;
  }, [chats, focusProjectId, listSearch]);
  // Visible folders: in project focus only those of the project, otherwise ALL of the workspace (the list shows all chats there
  // too; a folder chat must appear "loose" nowhere).
  const visibleFolders = useMemo(
    () => (focusProjectId ? folders.filter((f) => f.projectId === focusProjectId) : folders),
    [folders, focusProjectId],
  );
  // Chats per folder (pinned first, then by last activity) …
  const folderChats = useMemo(() => {
    const known = new Set(visibleFolders.map((f) => f.id));
    const byFolder = new Map<string, Chat[]>();
    for (const c of scopedChats) {
      if (!c.folderId || !known.has(c.folderId)) continue;
      const bucket = byFolder.get(c.folderId);
      if (bucket) bucket.push(c); else byFolder.set(c.folderId, [c]);
    }
    for (const list of byFolder.values()) list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    return byFolder;
  }, [scopedChats, visibleFolders]);

  const loadFolders = useCallback(async () => {
    const list = await api<ChatFolder[]>(`/api/chat-folders?workspaceId=${encodeURIComponent(wsId)}`);
    setFolders(list);
    return list;
  }, [wsId]);
  // Chats and folders belong together: a half-updated list would briefly show chats outside their folder. An error loading the
  // folders must not drag the chat list down with it.
  const loadList = useCallback(async () => {
    const [list] = await Promise.all([
      api<Chat[]>(`/api/chats?workspaceId=${encodeURIComponent(wsId)}`),
      loadFolders().catch(console.error),
    ]);
    setChats(list);
    return list;
  }, [wsId, loadFolders]);
  // Archive: metadata of the open archived chat, switching, opening by id; also those of the open EMPTY chat, which the list
  // only carries after the first message.
  const { archived, archivedAt, archiveChat, archive, restore, openTarget, holdOpen } = useArchive({ wsId, focusProjectId, activeId, chats, loadList, open, draft, chatAway });
  // Current state for the event stream: loadArtifacts depends on EMPTY deps (the stream is attached once per chat and must not
  // capture a stale version), so it reads the selection and selectArtifact through refs.
  const artifactSelectedRef = useRef<ChatArtifact | null>(null);
  artifactSelectedRef.current = artifactSelected;
  const selectArtifactRef = useRef<(artifact: ChatArtifact, reload?: boolean) => void>(() => {});

  // Refetch a chat's artifact list. Runs from three directions: "artifact_changed" from the event stream, re-entry after a
  // stream gap, and end of run. It therefore ALSO updates the chat cache (otherwise switching away and back would show the state
  // from before the write) and refreshes the open preview when the displayed file was overwritten.
  const loadArtifacts = useCallback(async (chatId: string) => {
    const list = await api<ChatArtifact[]>(`/api/chats/${chatId}/artifacts`);
    const cached = chatCacheRef.current.get(chatId);
    if (cached) cached.artifacts = list;
    if (activeIdRef.current !== chatId) return list;
    setArtifacts(list);
    const open = artifactSelectedRef.current;
    const still = open ? list.find((a) => artifactKey(a) === artifactKey(open)) ?? null : null;
    if (open && !still) {
      setArtifactSelected(null); // deleted
      setArtifactContent(null);
    } else if (open && still && still.sha256 !== open.sha256) {
      selectArtifactRef.current(still, true); // overwritten → reload the content in place
    } else if (still) {
      setArtifactSelected(still); // only update size/timestamp
    }
    return list;
  }, []);

  // `reload`: the OPEN file was overwritten; refresh the content in place, without an intermediate step through null and without
  // "loading". Otherwise the editor gave way to a "Loading…" in the window and was recreated (cursor, scroll position, undo lost);
  // the server reports it as "artifact_changed". Only content for the state of the selection is then accepted: a later older
  // answer writes nothing back.
  async function selectArtifact(artifact: ChatArtifact, reload = false) {
    setArtifactSelected(artifact);
    artifactSelectedRef.current = artifact;
    if (!reload) setArtifactContent(null);
    if (!activeIdRef.current || !artifactIsText(artifact.mime)) return;
    if (!reload) setArtifactLoading(true);
    try {
      // Shared artifacts (chat folders) belong to another chat: the server checks via the folder whether this chat may see them.
      const from = artifact.chatId && artifact.chatId !== activeIdRef.current ? `&chatId=${encodeURIComponent(artifact.chatId)}` : "";
      const content = await api<ChatArtifactContent>(`/api/chats/${activeIdRef.current}/artifacts/file?path=${encodeURIComponent(artifact.path)}${from}&maxBytes=1048576`);
      const isOpen = artifactSelectedRef.current;
      if (!reload || (isOpen && artifactKey(isOpen) === artifactKey(artifact) && isOpen.sha256 === content.sha256)) setArtifactContent(content);
    } catch (e) {
      if (!reload) setArtifactContent({ ...artifact, offset: 0, nextOffset: null, truncated: false, encoding: "utf8", content: String(e) });
    } finally {
      if (!reload) setArtifactLoading(false);
    }
  }
  selectArtifactRef.current = selectArtifact;

  function closeArtifact() {
    setArtifactSelected(null);
    setArtifactContent(null);
  }

  // Change an open artifact BY HAND (markdown editor in the window). Only its own: the files of neighbouring chats in the same
  // folder are readable, not writable; the server rejects them anyway, and an editor that fails on save would be a promise
  // nobody keeps. `expectedSha256` is the state the human had in front of them.
  async function saveArtifact(text: string, expectedSha256: string) {
    const chatId = activeIdRef.current;
    const artifact = artifactSelectedRef.current;
    if (!chatId || !artifact) throw new Error(t("No artifact open"));
    const saved = await api<ChatArtifact>(`/api/chats/${chatId}/artifacts/file`, {
      method: "PUT",
      body: JSON.stringify({ path: artifact.path, content: text, encoding: "utf8", expectedSha256 }),
    });
    // Take file and content from the response instead of reloading: `loadArtifacts` then sees no foreign state any more.
    const isOpen = artifactSelectedRef.current;
    if (activeIdRef.current === chatId && isOpen && artifactKey(isOpen) === artifactKey(artifact)) {
      const { file, content } = afterTheSave(isOpen, saved, text);
      artifactSelectedRef.current = file;
      setArtifactSelected(file);
      setArtifactContent(content);
    }
    await loadArtifacts(chatId);
    return saved.sha256;
  }

  function setRightSidebarTab(tab: RightSidebarTab) {
    setRightSidebarTabState(tab);
    try { localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, tab); } catch { /* local preference is optional */ }
  }
  function setRightSidebarOpen(open: boolean) {
    setRightSidebarOpenState(open);
    try { localStorage.setItem(RIGHT_SIDEBAR_OPEN_KEY, open ? "1" : "0"); } catch { /* local preference is optional */ }
  }
  function openRightSidebar(tab = rightSidebarTab) {
    setRightSidebarTab(tab);
    setRightSidebarOpen(true);
  }
  // The global event stream runs ONCE (deps []), so it must not close over loadList directly, otherwise it keeps loading the old
  // list after a workspace switch.
  const loadListRef = useRef(loadList);
  loadListRef.current = loadList;

  // On workspace switch: reload the list, reset the open chat + stream, then restore the last open chat OF THIS workspace
  // (survives tab, workspace and page switches via localStorage).
  useEffect(() => {
    esWatchdogRef.current?.stop();
    esRef.current?.close();
    esRef.current = null;
    setActiveId(null);
    setBubbles([]);
    setFirstInFlight(false); // the first message belonged to the old workspace's chat
    setGoal("");
    setProjectSel("");
    chatCacheRef.current.clear(); // do not carry the old workspace's histories along
    loadList()
      .then(async (list) => {
        // A chat addressed from outside: ?chat=… wins over the last open one. This lets the runs overview in the header also jump
        // into a chat of ANOTHER workspace (it reloads the page with ?ws=&chat= for that). The parameter is removed from the address
        // afterwards, otherwise every ⌘R jumps there again. Both paths via `openTarget`: an ARCHIVED chat opens too, read-only,
        // with the bar.
        if (onlyChat) return void (await openTarget(onlyChat, list, { projectCheck: false, openOtherwise: true }));
        const wanted = new URLSearchParams(window.location.search).get("chat");
        if (wanted && (await openTarget(wanted, list, { projectCheck: false }))) {
          const u = new URL(window.location.href);
          u.searchParams.delete("chat");
          return window.history.replaceState({}, "", u.toString());
        }
        const saved = localStorage.getItem(chatKey);
        // Restore only if the chat still exists and matches the current scope.
        if (saved) await openTarget(saved, list.filter((x) => !focusProjectId || x.projectId === focusProjectId));
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList]);

  useEffect(
    () => () => {
      esWatchdogRef.current?.stop();
      esRef.current?.close();
      clearTimeout(esRetryRef.current.timer);
      clearInterval(tickerRef.current);
    },
    [],
  );

  // Window focus: refresh the chat list; changes can come from outside (HTTP API, MCP).
  useEffect(() => {
    const onFocus = () => loadList().catch(console.error);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadList]);

  // Global event stream: keeps the sidebar hexagons of ALL chats live (spins during a run; glows on a finished, unread reply).
  // Runs once, across chats. When a run of ANOTHER chat in this list ends, it reloads the list (batched, 300 ms): the server sets
  // `updatedAt` only at the end of the turn, and the row's tooltip (chat/ChatTooltip.tsx) would otherwise show the time from
  // before next to "New reply". The open chat reloads itself on its `run_done` (onEvent). `chatsRef`: the stream runs once and
  // reads the list as it is now.
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const afterRunTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(afterRunTimer.current), []);
  useEffect(() => {
    const off = subscribeGlobalEvents((evt) => {
      const msg = evt as { type?: string; chatId?: string; running?: boolean; answered?: boolean; title?: string; name?: string; state?: string };
      if (msg.type === "init") {
        setRunningChats(new Set((msg as { running?: string[] }).running || []));
        setWorkflowChats(workflowChatsFromInit((msg as { dynWorkflows?: unknown }).dynWorkflows));
      } else if (msg.type === WORKFLOW_EVENT) {
        setWorkflowChats((prev) => workflowChatsApply(prev, msg as { chatId?: unknown; runId?: unknown; open?: unknown }));
      } else if (msg.type === "chat_created") {
        // A trigger created a chat without the user's doing. The list must show it at once, otherwise the running agent seems to
        // come out of nowhere.
        loadListRef.current().catch(console.error);
      } else if (msg.type === "chat_title" && msg.chatId && typeof msg.title === "string") {
        // Take over the auto/first title at once even when the chat stream is not active right now.
        setChats((prev) => prev.map((c) => (c.id === msg.chatId ? { ...c, title: msg.title! } : c)));
      } else if (msg.type === "chat_meta" && msg.chatId) {
        // A chat's settings changed on the server (e.g. a workflow set model/permissions) → reload the list so header and
        // pickers are right.
        loadListRef.current().catch(console.error);
      } else if (msg.type === "run" && msg.chatId) {
        const id = msg.chatId;
        setRunningChats((prev) => {
          const next = new Set(prev);
          if (msg.running) next.add(id); else next.delete(id);
          return next;
        });
        // A finished reply in a chat that is NOT currently open → mark as unread.
        if (!msg.running && msg.answered && id !== activeIdRef.current) {
          setUnreadChats((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
        }
        if (!msg.running && id !== activeIdRef.current && chatsRef.current.some((c) => c.id === id)) {
          clearTimeout(afterRunTimer.current);
          afterRunTimer.current = setTimeout(() => { loadListRef.current().catch(console.error); }, 300);
        }
      } else if (msg.type === "project/copy" && typeof msg.state === "string") {
        // A copy changes state (stacks/state.js): the rows WORKING in it carry it for their tooltip; without this event "being
        // created" would stay there until the list reloads for another reason. Assigned via project + `chats.instance`, never via
        // `msg.chatId` (the creator; lib/chat-location.ts).
        setChats((prev) => applyCopyEvent(prev, msg));
      } else if (msg.type === "scheduled" && !onlyChat) {
        // An occurrence of a scheduled job: the clock and next occurrence on the row come from `job` of the list, and a freshly
        // created job chat only appears in it after reloading; batched like the run end above.
        clearTimeout(afterRunTimer.current);
        afterRunTimer.current = setTimeout(() => { loadListRef.current().catch(console.error); }, 300);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An action of its own in the Scheduled tab (lib/scheduled.ts `reportScheduledChanged`): creating and PATCH report nothing on the server.
  useEffect(() => {
    if (onlyChat) return;
    const reload = () => loadListRef.current().catch(console.error);
    window.addEventListener(SCHEDULED_CHANGED, reload);
    return () => window.removeEventListener(SCHEDULED_CHANGED, reload);
  }, [onlyChat]);

  // Chat opening requested by other views (e.g. port-conflict chat after a service scan).
  useEffect(() => {
    const onOpenChat = (e: Event) => {
      const chatId = (e as CustomEvent<string>).detail;
      if (!chatId || onlyChat) return;
      openTarget(chatId, loadList(), { projectCheck: false, openOtherwise: true, openId: activeIdRef.current, alreadyOpen: () => setFolderView(null) }).catch(console.error); // mark on click; the open chat does not reopen
    };
    window.addEventListener("cbase-open-chat", onOpenChat);
    return () => window.removeEventListener("cbase-open-chat", onOpenChat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList]);

  // ── Streaming state ──
  // The mutators of the live stream and the event switch live as a PURE reducer in chat/chatBubbles.ts (`reduceChatEvent`,
  // `streamAfterEvent`). What stays here is the shell: the snapshot of the refs at the time of the event, the one setBubbles
  // call, and per event type the side effects (setState, reload, cache, clocks).
  const reducerCtx = (): ReducerCtx => ({
    stream: streamRef.current, now: Date.now(), wfStatus: wfRunRef.current?.status, activeId: activeIdRef.current,
    joined: joinedMidRunRef.current, runStart: runStartRef.current, inTok: inTokensRef.current, outTok: outTokensRef.current,
    t, resultToText, lastId: chatCacheRef.current.get(activeIdRef.current ?? "")?.lastId ?? 0,
  });
  // The four mutators that are also called outside the stream (send, runSlash, clearContext, decidePermission, answerAsk,
  // sidebar), as shells over the pure versions.
  function addError(text: string) {
    setBubbles((prev) => addErrorPure(prev, text));
  }
  function applyClear(at: number) {
    setCtxTokens(0);
    setBubbles((prev) => applyClearPure(prev, at));
  }
  const markAskAnswered = (requestId: string, answers: AskAnswer[], overChannel: AskBubble["overChannel"] = null) =>
    setBubbles((prev) => markAskAnsweredPure(prev, requestId, answers, overChannel));
  function markApprovalDecided(requestId: string, ruling: ApprovalRuling | null) {
    setBubbles((prev) => markApprovalDecidedPure(prev, requestId, ruling));
  }

  function onEvent(evt: Record<string, any>) {
    // First the snapshot (before any ref mutation of this switch), then the bubbles via the reducer and the stream state AT ONCE,
    // both from the same ctx (React batches the updater until render and computes it twice in StrictMode; so it must not write a ref).
    const ctx = reducerCtx();
    setBubbles((prev) => reduceChatEvent(prev, evt, ctx));
    streamRef.current = streamAfterEvent(evt, ctx);
    backgroundEvent(evt); // waiting phase and wait states (connected, run_*, background): chat/chatBackground.ts
    treeEvent(evt); // progress tree (connected loads the route, the tree event updates it): chat/chatDynTree.ts
    graphEvent(evt); // graph workflow starts (connected loads the route, the graph run event updates it): chat/chatGraphRuns.ts
    agendaEvent(evt); // agenda of the right bar (connected reloads, agenda updates it): chat/chatAgenda.ts
    if (evt.type === "harness") {
      if (evt.subtype === "connected") {
        // From here this stream is registered with the server: waiting senders may send.
        const pending = streamReadyRef.current;
        if (pending) {
          pending.ready = true;
          const waiters = pending.waiters;
          pending.waiters = [];
          for (const w of waiters) w();
        }
        setBusy(Boolean(evt.running));
        // Compacting also survives a reload: it keeps running on the server and the chat accepts only queued messages meanwhile;
        // the new view must show that at once.
        setCompacting(Boolean(evt.compacting));
        setQueued(Array.isArray(evt.queued) ? evt.queued : []);
        // Context state of the RUNNING run (the server tracks it continuously). Without this, a reload in the middle of a run showed
        // "0 / 1M" until the next usage event; in the waiting phase (background agents) that could be minutes.
        if (typeof evt.contextTokens === "number" && evt.contextTokens > 0) setCtxTokens(evt.contextTokens);
        // The already streamed text of the running turn (`streamText` → reducer, seedStreamedText).
        joinedMidRunRef.current = Boolean(evt.running);
        // A SECOND (and every further) "connected" message means: the stream was interrupted (EventSource reconnects silently). The
        // server keeps no backlog; everything from the gap was missing forever, typically the rows BETWEEN two turns ("/compact
        // before <node>", "Context compacted"). Reconcile only when no turn is running: otherwise the live stream leads, and
        // joinedMidRun catches up at the end of the run.
        const reconnected = streamSeenRef.current;
        streamSeenRef.current = true;
        if (reconnected && activeIdRef.current) {
          // Artifacts do NOT hang on the history and are therefore also refreshed during a running turn: an "artifact_changed" from
          // the gap is gone forever, and exactly that made a just-written file appear only after a page reload.
          loadArtifacts(activeIdRef.current).catch(console.error);
        }
        // Every "connected" reconciles against the server's state (`lastId`/`total`): also the FIRST one after opening, and also when
        // an earlier reconciliation could not apply its result. In the middle of a run only the first one (chatCache.ts).
        if (activeIdRef.current) reconcileAfterConnected(activeIdRef.current, evt, !reconnected);
      }
      else if (evt.subtype === "run_started") {
        setBusy(true);
        startPendingRef.current = false;
        // startAssistant → reducer.
        joinedMidRunRef.current = false;
        runStartRef.current = Date.now();
        outTokensRef.current = 0;
        inTokensRef.current = 0;
        msgOutBaseRef.current = 0;
        setOutTokens(0);
        setInTokens(0);
        setStatusPair(STATUS_WORDS[Math.floor(Math.random() * STATUS_WORDS.length)]);
        setStreamingText(false);
        clearInterval(tickerRef.current);
        tickerRef.current = setInterval(() => tickRender((t) => t + 1), 1000);
      } else if (evt.subtype === "run_done" || evt.subtype === "run_aborted") {
        clearInterval(tickerRef.current);
        setStreamingText(false);
        setStopping(false);
        setPermReqs([]); // clear open approval cards
        // The runtime/token summary is computed by the reducer from ctx (runStart, inTok, outTok, now).
        runStartRef.current = null;
        setBusy(false); // finish(); the rest of it is in the reducer
        const doneId = activeIdRef.current;
        // Reconcile once at the end of the run: events lost in a stream gap during the run are caught up here; one call per run,
        // independent of the history path below.
        if (doneId) loadArtifacts(doneId).catch(console.error);
        if (joinedMidRunRef.current && doneId) {
          // Joined during the run: the live stream was incomplete, so load the history fresh (incl. meta). Deliberately NOT via
          // open(): that tore down the event stream and redrew the chat from the still-old cache in between, a visible flicker.
          joinedMidRunRef.current = false;
          reloadOpenChatLog(doneId).catch(console.error);
        } else {
          // attachSummaryToLast → reducer (the same branch there, from ctx.joinedMidRun/activeId). The history is now complete in
          // the DB → update the cache so a later switch back to this chat shows the right thing at once.
          if (doneId) syncChatCache(doneId).catch(console.error);
        }
        loadList().catch(console.error);
        onChanged?.();
      } else if (evt.subtype === "run_error") {
        clearInterval(tickerRef.current);
        setStreamingText(false);
        setStopping(false);
        setPermReqs([]);
        runStartRef.current = null;
        // addError + finish → reducer.
        setBusy(false); // finish()
        // Like run_done: if joined mid-run, the stream was incomplete; the history comes from the DB, the error bubble behind it.
        if (joinedMidRunRef.current && activeIdRef.current) { joinedMidRunRef.current = false; reloadOpenChatLog(activeIdRef.current, { keepError: true }).catch(console.error); }
      } else if (evt.subtype === "compacting") {
        setCompacting(true);
      } else if (evt.subtype === "compacted") {
        setCompacting(false);
        setCtxTokens(0);
        // Separator "Context compacted" → reducer.
        syncChatCache(activeIdRef.current ?? "").catch(console.error);
      } else if (evt.subtype === "cleared") {
        setCtxTokens(0); // applyClear(); the reducer does the bubbles
        syncChatCache(activeIdRef.current ?? "").catch(console.error);
      } else if (evt.subtype === "compact_failed") {
        setCompacting(false);
      } else if (evt.subtype === "permission_request") {
        // The agent wants to use a sensitive tool → show an approval card (avoid duplicates via requestId).
        setPermReqs((prev) => [
          ...prev.filter((r) => r.requestId !== evt.requestId),
          { requestId: evt.requestId, toolName: String(evt.toolName || ""), input: (evt.input ?? {}) as Record<string, unknown>, toolUseId: evt.toolUseId ?? null, suggestedRule: String(evt.suggestedRule || "") },
        ]);
        // … and as a (still hidden) card into the history (pushApproval → reducer); as there: without requestId nothing happens,
        // not even at the run indicator.
        if (String(evt.requestId || "")) setStreamingText(false);
      } else if (evt.subtype === "approval_ruling") {
        // markApprovalDecided → reducer.
      } else if (evt.subtype === "permission_resolved") {
        setPermReqs((prev) => prev.filter((r) => r.requestId !== evt.requestId));
        // Fall back to the history card → reducer.
      } else if (evt.subtype === "ask_request") {
        // Question with choices → clickable card in the history (pushAsk → reducer).
        setStreamingText(false);
      } else if (evt.subtype === "ask_resolved") {
        // Also answered by ANOTHER client (phone): follow along with the card (markAskAnswered → reducer).
      } else if (evt.subtype === "channel_message") {
        // Message from a channel (sent or received) → card in the history (pushChannel → reducer).
        if (evt.card) setStreamingText(false);
      } else if (evt.subtype === "capture_message") {
        // Capture of an agent (shown at turn end) → card in the history (pushCapture → reducer).
        setStreamingText(false);
      } else if (evt.subtype === "message_queue") {
        setQueued(Array.isArray(evt.queued) ? evt.queued : []);
      } else if (evt.subtype === "message_injected") {
        setQueued(Array.isArray(evt.queued) ? evt.queued : []);
        // "Channel phantom": a silent delivery creates no user bubble (startInjectedTurn → reducer, same condition).
        if (evt.silent !== true) setStreamingText(false);
      } else if (evt.subtype === "user_message") {
        // appendUserMessage → reducer.
      } else if (evt.subtype === "title" && evt.title) {
        // Automatically generated chat title → update the sidebar row at once.
        const title = String(evt.title);
        const chatId = String(evt.chatId || activeIdRef.current || "");
        setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title } : c)));
      } else if (evt.subtype === "provider") {
        // The provider of the last reply and its window (runs/do-run.js); the context bar reads them from the chat.
        const chatId = activeIdRef.current;
        setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, upstreamProvider: String(evt.provider || ""), upstreamWindow: Number(evt.window) || 0 } : c)));
      } else if (evt.subtype === "goal_check") {
        // Verdict of the target gate (arrives shortly after run_done) → row under the reply (reducer). Reached = goal done (the
        // server cleared it, the indicator disappears), also in the cache and the list.
        if (evt.achieved === true && activeIdRef.current) takeOverTarget(activeIdRef.current, "", false);
      } else if (evt.subtype === "target") {
        // Goal or pause changed via PATCH (also from another client): row, cache and list follow; no bubble.
        const id = activeIdRef.current;
        if (id) takeOverTarget(id, String(evt.goal ?? ""), evt.goalPaused === true);
      } else if (evt.subtype === "run_waiting") {
        // Main agent idle: the background hook sets waiting phase and lists. The turn is over, so no text streams any more; without
        // this reset the waiting row would stay hidden behind the streaming state.
        setStreamingText(false);
      } else if (evt.subtype === "monitor") {
        // Monitor lifecycle row → reducer.
      } else if (evt.subtype === "workflow_step") {
        // Row of the workflow driver → reducer.
      } else if (evt.subtype === "workflow_run") {
        // Progress of the run → strip above the history.
        applyWfRun((evt.run as WorkflowRun) ?? null);
      } else if (evt.subtype === "limit_wait") {
        // Run parked at the usage limit, or free again (null).
        const wait = (evt.wait as LimitWait) ?? null;
        applyLimitWait(wait);
        // The gate intercepted the START: there is no run, hence no `run_started` and no `run_done`. `busy` drops here, on the same
        // condition that `send()` set it under; otherwise the hexagon spins until someone reloads the page.
        if (isGateWaitRow(wait) && startPendingRef.current) {
          startPendingRef.current = false;
          setBusy(false);
        }
      } else if (evt.subtype === "limit_line") {
        // Row about the usage limit → reducer.
      } else if (evt.subtype === "artifact_changed") {
        const id = activeIdRef.current;
        if (id) loadArtifacts(id).catch(console.error);
      } else if (evt.subtype === "chat_settings") {
        // An instance switch (runs/instance-switch.js), from the header, another client or the agent. The separator "now working in
        // …" is written by the server as a `hint` message (also as a line in the stream; reloading stays as a safety net): without a
        // run at once (delta via `revalidateChat`, rule in chatCache.ts), with a run at its end (the "joined mid-run" path). No
        // setBubbles of its own here: onEvent stays the shell (composer contract).
        const changeover = instanceSwitchFromEvent(evt);
        const id = activeIdRef.current;
        if (changeover && id) {
          setChats((cs) => cs.map((c) => (c.id === id ? { ...c, instance: changeover.instance } : c)));
          if (busyRef.current) joinedMidRunRef.current = true;
          else revalidateChat(id, openSeqRef.current).catch(console.error);
        }
      } else if (evt.subtype === "folder_context_changed") {
        // The folder view loads on opening; a change elsewhere (another window, another chat of the folder) reaches it only through
        // this nudge.
        setFolderContextTick((n) => n + 1);
      }
      return;
    }
    if (evt.type === "stream_event") {
      const ev = evt.event ?? {};
      // Subagent events carry the id of the parent task call; they are rendered indented there and NOT counted in the context/token
      // display.
      const parentId: string | null = evt.parent_tool_use_id ?? null;
      if (ev.type === "message_start") {
        // New API call of the main stream: set the output baseline, take over the input side (= context).
        if (!parentId) {
          msgOutBaseRef.current = outTokensRef.current;
          const u = ev.message?.usage;
          if (u) {
            inTokensRef.current = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            setInTokens(inTokensRef.current);
          }
        }
      } else if (ev.type === "message_delta" && ev.usage?.output_tokens) {
        // Cumulative per API call; add onto the baseline of the running call.
        if (!parentId) {
          outTokensRef.current = msgOutBaseRef.current + ev.usage.output_tokens;
          setOutTokens(outTokensRef.current);
          setCtxTokens(inTokensRef.current + outTokensRef.current - msgOutBaseRef.current);
        }
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        if (!parentId) setStreamingText(true);
        // appendText → reducer.
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
        if (!parentId) setStreamingText(false); // thinking/reasoning phase → show the run indicator
        // appendThinking → reducer.
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        if (!parentId) setStreamingText(false);
        // addTool → reducer.
      }
      return;
    }
    if (evt.type === "user") {
      // tool_result: assign the output to the matching tool call (setToolResult → reducer).
      return;
    }
    if (evt.type === "assistant") {
      const parentId: string | null = evt.parent_tool_use_id ?? null;
      // Complete assistant event: add the tool input afterwards (upsertTool → reducer).
      let hasTool = false;
      for (const b of evt.message?.content ?? []) {
        if (b.type === "tool_use") hasTool = true;
      }
      // With Codex, tool calls arrive ONLY as an assistant event (no content_block_start), so show the run indicator again here:
      // no reply text is being produced right now.
      if (hasTool && !parentId) setStreamingText(false);
      const u = evt.message?.usage;
      if (u && !parentId) {
        inTokensRef.current = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        setInTokens(inTokensRef.current);
        setCtxTokens(inTokensRef.current);
      }
    }
    // `result` (result fallback without streamed text) → reducer, on ctx.stream.
  }

  // ── Actions ──
  // Open a chat. IMPORTANT: selection + history are set ATOMICALLY: only when the log is loaded do activeId and bubbles change
  // TOGETHER. Otherwise the old chat renders briefly under the new selection (looked like a remount). openSeqRef discards stale
  // switches when switching quickly several times.
  // `afterCreation`: `ensureChat` opens the chat it just created for the first message; the `firstInFlight` mark then belongs to
  // IT and stays; every other switch takes it back.
  async function open(id: string, { afterCreation = false }: { afterCreation?: boolean } = {}) {
    if (!afterCreation) setFirstInFlight(false);
    // The text stays with the chat being left: pending writes happen NOW, while the key is still the old one. The goal's draft is
    // loaded after switching.
    draft.flush();
    esWatchdogRef.current?.stop();
    esRef.current?.close();
    setFolderView(null); // a chat wins over the folder view above it
    // Opening = read → switch off this chat's sidebar glow.
    setUnreadChats((prev) => (prev.has(id) ? (() => { const n = new Set(prev); n.delete(id); return n; })() : prev));
    streamRef.current = { open: false, gotText: false };
    setStreamingText(false);
    setStopping(false);
    setPermReqs([]); // approval cards belong to the previous chat
    setFiles([]); // waiting attachments belong to the previous chat
    setArtifactSelected(null);
    setArtifactContent(null);
    setQueued([]); // the new chat stream delivers its server-side queue in the connected event
    if (!onlyChat) localStorage.setItem(chatKey, id);
    const seq = ++openSeqRef.current;
    // The run state belongs to the chat being LEFT: until the new one's "connected" reports it, it is unknown; with the old `busy`
    // the reconciliation behind it discarded its result, and the new message was missing until the chat was reopened. Not after
    // creation: `send()` just set `busy` for the first message, and a new chat is not running.
    if (!afterCreation) { setBusy(false); busyRef.current = false; joinedMidRunRef.current = false; }

    // An open chat ALWAYS sits at the end: applies to the instant switch as to reloading.
    stickRef.current = true;

    // ── Switch at once if the history was loaded before ──
    // The switch used to wait for the COMPLETE log: for large chats two to three seconds during which the old chat still stood.
    // Now the cache shows the state from a moment ago and the reconciliation runs behind it; if nothing was added, nothing
    // re-renders at all.
    const cached = chatCacheRef.current.get(id);
    if (cached) {
      activeIdRef.current = id;
      setActiveId(id);
      setInput(readDraft(draftKey(id)));
      setBubbles(cached.bubbles);
      setArtifacts(cached.artifacts);
      setCtxTokens(cached.chat?.contextTokens ?? 0);
      setGoal(cached.chat?.goal ?? "", cached.chat?.goalPaused);
      setChatLoading(false); // a still-running load belongs to the previous target
      // The stream must not wait for the reconciliation: events missed until then would be gone forever (the server keeps no
      // backlog).
      attachChatStream(id);
      // Not after creation: the POST response IS the state, and a reconciliation behind it would overwrite, with its GET, the goal
      // that `/goal X` had just set in the fresh chat. The basis is the cache entry (chatCache.ts).
      if (!afterCreation) revalidateChat(id, seq, cached.bubbles).catch(console.error);
      return;
    }

    // ── Without cache: switch at once ANYWAY ──
    // The switch used to wait for history AND metadata; on first opening a large chat the old one stood there meanwhile and the
    // click looked swallowed. Now selection, empty surface and loading animation appear in the same frame as the click; the
    // content follows. Counters and goal belong to the OLD chat and are cleared at once, otherwise the new chat shows foreign
    // values while loading.
    activeIdRef.current = id;
    setActiveId(id);
    setInput(readDraft(draftKey(id)));
    const empty: Bubble[] = []; // the basis of the reconciliation after loading: whatever came live meanwhile sits behind it
    setBubbles(empty);
    setArtifacts([]);
    setCtxTokens(0);
    setGoal("");
    const targetBefore = targetStatusRef.current; // a /goal during loading is newer than the answer
    setChatLoading(true);
    // The stream FIRST: it used to wait for /log AND /artifacts, and whatever happened in between never arrived. The gap between
    // reading the history and "connected" is closed by the reconciliation over its state (`reconcileAfterConnected`).
    attachChatStream(id);
    const artifactsRequest = api<ChatArtifact[]>(`/api/chats/${id}/artifacts`).catch(() => [] as ChatArtifact[]);
    const [chat, log] = await Promise.all([
      api<Chat>(`/api/chats/${id}`).catch(() => null),
      loadWindow(id).catch(() => ({ total: 0, lastId: 0, older: false, rows: [] as LogEntry[] })), // only the end (lib/api/log-window.ts)
    ]);
    // A newer switch took over: this state is outdated. The loading indicator then belongs to the new target; do NOT touch it here.
    if (openSeqRef.current !== seq) return;
    const bs = buildBubbles(log.rows);
    putChatCache(id, { ...log, bubbles: bs, chat, artifacts: [] });
    setChatLoading(false);
    applyReconcile(id, empty, bs);
    setCtxTokens(chat?.contextTokens ?? 0);
    if (targetStatusRef.current === targetBefore) setGoal(chat?.goal ?? "", chat?.goalPaused);
    afterTheLoad(id); // "connected" already arrived and reports more than /log brought: catch up
    const loadedArtifacts = await artifactsRequest;
    if (openSeqRef.current !== seq) return;
    const e = chatCacheRef.current.get(id);
    if (e) e.artifacts = loadedArtifacts;
    setArtifacts(loadedArtifacts);
  }

  // The hero draft belongs to the newly created chat from now on. Flush first (the last keystroke may still be in the throttle),
  // then re-key; otherwise open() wiped the just-typed text because it loads the (empty) draft of the new id. Only `ensureChat`
  // creates: "+" of the sidebar and "+" of a folder open the hero instead of creating from it. With an open chat there is
  // nothing to re-key: the text in the field belongs to the chat being left, and open() saves it there.
  function heroDraftReattach(chatId: string) {
    if (activeIdRef.current) return;
    draft.flush();
    moveDraft(draftKeyNew(wsId, focusProjectId), draftKey(chatId)); rememberCreationFromDraft(wsId, chatId); // the draft's code tabs go to THIS chat
  }

  // New chat = draft: every entry (row and sheet "New chat in …", "+" of the collapsed list, folder menu with key N, "Start chat" on
  // an instance) opens the empty view WITHOUT a POST; the chat is created on the first send (`ensureChat`, with the draft's
  // preselection). What an entry changes in the preselection is in chat/chatDraft.ts. `from = "sheet"`: "Start chat" in the sheet
  // "New chat in …": the user has just chosen project and folder there. Without it (row "New chat", "+") the entry is plain: no
  // folder, in `main`, in its own project (lib/chat-draft.ts).
  async function createChat(from?: "sheet") {
    newChat(from === "sheet" ? { sheet: true } : {});
  }

  // Without an open chat, one is created lazily on the first action (send/attach), with the draft's preselection. Returns the chat
  // id (state updates of open() have not rendered yet here, hence do not read the ref). The list does NOT reload here: it only
  // carries the chat after its first message; until then `useArchive` holds its metadata (`holdOpen` before switching), and `send`
  // reloads. `creation` (`oneCreation` in lib/chat-draft.ts): ONE promise per creation. Until `open()` sets the id in `activeIdRef`
  // the POST round trip passes, and an attachment + immediate Enter, or a double Enter, created TWO chats in that time (the
  // attachment hung on the orphan). Every further caller gets the same promise; after success or error the way is free again
  // (then `activeIdRef` answers).
  const [creation] = useState(() => oneCreation<string>());
  async function ensureChat(): Promise<string> {
    if (activeIdRef.current) return activeIdRef.current;
    return creation(async () => {
      const chat = await api<Chat>("/api/chats", {
        method: "POST",
        body: JSON.stringify({ workspaceId: wsId, projectId: newChatProjectId(), folderId: folderSel || undefined, model: modelSel, permissionMode: permSel, ...effortForCreation, ...instanceForCreation, provider: providerSel || undefined }),
      });
      if (folderSel) revealFolder(folderSel);
      onChanged?.();
      heroDraftReattach(chat.id);
      holdOpen(chat);
      // A freshly created chat has no history; as an empty cache entry it opens on `open()`'s instant path, without a loading phase.
      // With one, it counted as "not empty" for the duration of loading and as empty afterwards: the field jumped down and back to
      // the middle once before the first message took it down for good.
      putChatCache(chat.id, { rows: [], bubbles: [], chat, artifacts: [] });
      await open(chat.id, { afterCreation: true });
      return chat.id;
    });
  }

  // Close the open chat and show the empty view: the draft. What `open()` clears on switching, this clears too; plus the run
  // state that the next stream's `connected` would otherwise set: without a chat none arrives, and from a running chat the composer
  // would otherwise stand in stop mode. Without a remembered chat a reload shows the draft again.
  function toDraft() {
    draft.flush(); // the text stays with the chat being left
    esWatchdogRef.current?.stop();
    esRef.current?.close();
    esRef.current = null;
    ++openSeqRef.current; // a still-loading open() applies nothing any more
    activeIdRef.current = null;
    setActiveId(null);
    setFirstInFlight(false);
    setInput(readDraft(draftKeyNew(wsId, focusProjectId)));
    setBubbles([]); setArtifacts([]); setCtxTokens(0); setGoal(""); setChatLoading(false); setFolderView(null);
    setBusy(false); setCompacting(false); setStreamingText(false); setStopping(false); setPermReqs([]); setQueued([]);
    setFiles([]); setArtifactSelected(null); setArtifactContent(null);
    startPendingRef.current = false; joinedMidRunRef.current = false; runStartRef.current = null;
    streamRef.current = { open: false, gotText: false };
    clearInterval(tickerRef.current);
    backgroundEvent({ type: "harness", subtype: "run_aborted" }); // waiting phase and agents belong to the chat being left
    if (!onlyChat) try { localStorage.removeItem(chatKey); } catch { /* local preference is optional */ }
  }

  // Upload files (raw body, name as query) and queue them as waiting attachments. A drop comes as its DataTransfer: `filesOf`
  // takes its entries before the first await and walks dropped folders into their files (drop-files.ts says why);
  // `readableFile` turns an unreadable file into a named error instead of "Failed to fetch".
  async function addFiles(source: UploadSource) {
    const pending = filesOf(source);
    setUploading(true);
    try {
      const list = await pending;
      if (!list.length) return;
      const chatId = await ensureChat();
      for (const d of list) {
        const f = await readableFile(d, (rel) => t("\"{name}\" could not be read on this computer. If it is a cloud-only file (OneDrive, iCloud Drive, Dropbox), make it available offline and try again.", { name: rel }));
        const att = await api<Attachment>(
          `/api/chats/${chatId}/attachments?name=${encodeURIComponent(f.name || "image.png")}`,
          { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f },
        );
        setFiles((prev) => [...prev, att]);
      }
    } catch (e) {
      addError(t("Upload failed: {msg}", { msg: String((e as Error).message) }));
    } finally {
      setUploading(false);
    }
  }

  // Store a large paste as an attachment (instead of writing it into the composer). The text is already known here, so the
  // preview is stored at once, without reloading.
  async function addPastedText(text: string) {
    setUploading(true);
    try {
      const chatId = await ensureChat();
      const name = pastedFileName();
      // artifact=0: pasted text is an attachment but not an uploaded FILE; it does not belong permanently in the chat's artifacts
      // (see /attachments on the server).
      const att = await api<Attachment>(
        `/api/chats/${chatId}/attachments?artifact=0&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new File([text], name, { type: "text/plain" }) },
      );
      pastedPreviews.set(`${chatId}:${att.file}`, text.slice(0, PASTE_PREVIEW_CHARS));
      setFiles((prev) => [...prev, att]);
    } catch (e) {
      addError(t("Upload failed: {msg}", { msg: String((e as Error).message) }));
    } finally {
      setUploading(false);
    }
  }

  // Push an info/divider bubble into the history (client side only, not persisted).
  const pushInfo = (title: string, body: string) =>
    setBubbles((prev) => [...prev, { role: "info", label: title, blocks: [{ kind: "text", text: body }] }]);

  // /cost: derive this chat's token usage from the existing run summaries.
  function showCost() {
    const runs = bubbles.filter((b) => b.role === "assistant" && b.summary).map((b) => b.summary!);
    const totalOut = runs.reduce((s, r) => s + (r.outTok || 0), 0);
    const totalSecs = runs.reduce((s, r) => s + (r.secs || 0), 0);
    const win = contextWindowFor(effectiveModel, currentProvider, providers);
    const subscriptionLine = currentProvider === "codex"
      ? t("_Runs via your ChatGPT/Codex subscription._")
      : currentProvider === "claude"
        ? t("_Runs via your Claude plan — the 5-hour usage is shown in the ring at the top right._")
        : t("_Runs via this provider's API key._");
    const body = [
      t("Replies: **{n}**", { n: runs.length }),
      t("Context now: **{used}** / {win} ({pct} %)", { used: fmtTokens(ctxTokens), win: fmtTokens(win), pct: Math.min(100, Math.round((ctxTokens / win) * 100)) }),
      t("Total output: **~{n}** tokens", { n: fmtTokens(totalOut) }),
      t("Total runtime: **{dur}**", { dur: fmtDur(totalSecs) }),
      "",
      subscriptionLine,
    ].join("\n\n");
    pushInfo("Cost & usage", body);
  }

  // Intercept native slash commands: the switch lives in chatSlash.ts; what stays here is the shell with the handler map: each
  // value under its name, built at call time (state of this render, like the closure).
  async function runSlash(text: string, attachments: Attachment[] = []): Promise<boolean | { send: string; display: string }> {
    return runSlashPure(text, attachments, { t, pushInfo, showCost, clearContext, goal, clearGoal, activeIdRef, ensureChat, goalPaused, setGoal, loadList, compact, pickerProviders, currentModelLabel, currentProvider, pickModel, effectiveModel, allProviders, currentEffort, ultracode, setUltracode, pickEffort, currentPermLabel, pickPerm });
  }

  // `preset`: the text comes straight from the caller instead of the state: on Enter the slash picker inserts the hit AND sends in
  // the same keypress, and `input` still carries the half-typed "/rel" at that moment, not "/release-notes ".
  async function send(preset?: string) {
    const trimmedInput = (preset ?? input).trim();
    // Waiting quotes go FIRST (lib/quotes.ts): with them the text never starts with "/", so it is no command, and a `/workflow:x`
    // in a quote line is no mention for the server (workflows/shortName.js:mentions).
    const quoteList = quotes;
    let text = withQuotes(quoteList, trimmedInput);
    let display = ""; // differing display (/goal prompts show the input with its prefix)
    const attachments = files;
    if (!text && !attachments.length) return;
    // Slash commands: run known ones locally and do NOT send them to the LLM, unless the command returns {send} (/goal): then the
    // text continues as an ordinary task, attachments included. A command handled locally leaves the attachments in the composer;
    // they belong to the next message, not to the command.
    if (text.startsWith("/")) {
      const r = await runSlash(text, attachments);
      if (r === true) { composerRef.current?.clear(); draft.erase(); return; }
      if (r && typeof r === "object") { text = r.send; display = r.display; }
    }
    composerRef.current?.clear();
    draft.erase(); // What was sent is no draft any more, including whatever the throttle still held
    setFiles([]);
    setQuotes([]);
    const wasBusy = busy;
    // During compaction nobody answers the message, so it is queued. "busy" would mean "the agent is working on your message" here
    // and would simply be wrong; the state is shown by the compaction row of the strip base, with the queue.
    if (!compacting) { setBusy(true); startPendingRef.current = true; }
    stickRef.current = true;
    // The first message of an empty chat: the field moves down NOW, not only when it appears in the history.
    if (!activeIdRef.current || !bubbles.length) setFirstInFlight(true);
    try {
      const chatId = await ensureChat();
      // Send only once this chat's event stream is up. Otherwise, with a just-created chat, the POST wins the race against the
      // connection setup and the message's own run stays invisible (the server sends nothing afterwards).
      const streaming = await awaitChatStream(chatId);
      // `/workflow:<shortName>` goes this way too: an ordinary message that the server reads (mention, announcement, start after
      // the turn); a refusal (unknown name, a workflow already open) is a 4xx and lands in the `catch` below: error row, text and
      // attachments back into the field.
      const r = await api<{ queued?: boolean; parked?: boolean }>(`/api/chats/${chatId}/message`, {
        method: "POST",
        body: JSON.stringify({ text, ...(display ? { display } : {}), attachments }),
      });
      // `parked`: the chat waits at the limit, the message is queued BEHIND the continuation; nobody is working on it, so `busy`
      // would be a lie. The state is shown by the limit strip and the queue.
      if (r?.parked) { startPendingRef.current = false; setBusy(false); }
      // A just-created chat appears in the list after its first message: it reloads now, not only at the end of the run.
      if (!chatsRef.current.some((c) => c.id === chatId)) loadList().catch(console.error);
      // If the deadline passed instead of the stream arriving: pull the history from the DB once. The row IS there; only the live
      // path was closed, and without it the view would stay on the empty hero image. If the stream is there after all, it leads again.
      if (!streaming) await reloadOpenChatLog(chatId).catch(console.error);
    } catch (e) {
      setBusy(wasBusy);
      setFirstInFlight(false);
      // With quotes back into their card and the typed text into the field, not the composed one.
      const back = quoteList.length ? trimmedInput : (display || text);
      setInput((cur) => cur || back);
      if (quoteList.length) setQuotes((cur) => (cur.length ? cur : quoteList));
      setFiles((cur) => cur.length ? cur : attachments);
      addError(String((e as Error).message));
    }
  }

  // Workflow state of the open chat: the running workflow for the strip and the wait row at the limit. The selectable list is
  // fetched by the slash picker itself on every opening.
  const loadWorkflowState = useCallback(async () => {
    const id = activeIdRef.current;
    try {
      applyWfRun(id ? (await api<{ run: WorkflowRun | null }>(`/api/chats/${id}/workflow`)).run : null);
    } catch { applyWfRun(null); }
    try {
      setLimitWait(id ? (await api<{ wait: LimitWait | null }>(`/api/chats/${id}/auto-continue`)).wait : null);
    } catch { setLimitWait(null); }
  }, [applyWfRun]);
  useEffect(() => { loadWorkflowState(); }, [activeId, loadWorkflowState]);

  // "Try now": the user may knowingly try even if the limit still stands. `anyway` additionally releases the credit gate, for
  // EXACTLY THIS one turn: the global setting stays as it is. The strip itself locks its buttons against double clicks while the
  // call runs.
  async function retryLimitNow(anyway = false) {
    if (!activeId) return;
    try {
      const r = await api<{ ok: boolean; wait: LimitWait | null }>(`/api/chats/${activeId}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway }) });
      applyLimitWait(r.wait);
    } catch (e) { addError(String((e as Error).message)); }
  }
  async function cancelLimitWait() {
    if (!activeId) return;
    try {
      await api(`/api/chats/${activeId}/auto-continue`, { method: "DELETE" });
      setLimitWait(null);
    } catch (e) { addError(String((e as Error).message)); }
  }

  async function skipWorkflowStep() {
    const id = activeIdRef.current;
    if (!id) return;
    setWfBusy(true);
    try { applyWfRun((await api<{ run: WorkflowRun | null }>(`/api/chats/${id}/workflow/skip`, { method: "POST", body: "{}" })).run); }
    catch (e) { addError(String((e as Error).message)); }
    finally { setWfBusy(false); }
  }
  async function cancelWorkflow() {
    const id = activeIdRef.current;
    if (!id) return;
    setWfBusy(true);
    try { applyWfRun((await api<{ run: WorkflowRun | null }>(`/api/chats/${id}/workflow/cancel`, { method: "POST", body: "{}" })).run); }
    catch (e) { addError(String((e as Error).message)); }
    finally { setWfBusy(false); }
  }
  // Bubble content (text blocks only) to the clipboard.
  async function copyBubble(i: number, text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1200);
    } catch { /* clipboard not available */ }
  }

  // Selected text in the history: the same small menu as at the text marker of the iOS app: "Reply" (selection as a quote via the
  // composer) and "Copy". Not every selection silently copies to the clipboard: that overwrote the clipboard on mere selecting,
  // and the Copy button would have had no job beside it. The "Copied" hint stays, now as feedback to the explicit click.
  function selectionInMessages(): { text: string; rect: DOMRect } | null {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    if (!text.trim() || !sel || sel.rangeCount === 0) return null;
    const container = msgsRef.current;
    const range = sel.getRangeAt(0);
    if (!container || !container.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { text, rect };
  }

  function onMessagesMouseUp() {
    const found = selectionInMessages();
    setSelMenu(found ? { text: found.text, rect: found.rect } : null);
  }

  // "Reply": the selection becomes a quote above the field; the user types the answer itself into the field.
  function askAboutSelection() {
    const text = (selMenu?.text ?? "").trim();
    if (!text) return;
    setQuotes((cur) => [...cur, text]);
    setSelMenu(null);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  // Close the menu again: Escape, or a click that starts a new selection (a click INSIDE the bar is exempt; it prevents the
  // default behaviour itself).
  useEffect(() => {
    if (!selMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelMenu(null); };
    const onDown = () => {
      // Check only after the click: mousedown does not clear the selection yet.
      requestAnimationFrame(() => {
        if (!selectionInMessages()) setSelMenu(null);
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
    // selectionInMessages only reads refs: the dependency on selMenu is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selMenu]);

  // Chat switch: discard the selection menu (the selection belongs to the old history).
  useEffect(() => { setSelMenu(null); }, [activeId]);

  async function copySelection() {
    const text = selMenu?.text ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setAutoCopied(true);
      clearTimeout(autoCopyTimer.current);
      autoCopyTimer.current = setTimeout(() => setAutoCopied(false), 1200);
    } catch { /* clipboard not available */ }
    setSelMenu(null);
  }

  // The server's state after a goal change (PATCH response, the goal harness event, "reached"): cache and list follow; otherwise
  // switching back into the chat and the list's tooltip showed the old state. The row only in the open chat; an answer (`revision`)
  // is outdated there if someone has set the goal since it was sent; their state counts.
  function takeOverTarget(id: string, target: string, paused: boolean, revision?: number) {
    const isOpen = activeIdRef.current === id;
    if (isOpen && revision !== undefined && targetStatusRef.current !== revision) return;
    if (isOpen) setGoal(target, paused);
    const e = chatCacheRef.current.get(id);
    if (e?.chat) e.chat = { ...e.chat, goal: target, goalPaused: paused };
    setChats((cs) => (cs.some((c) => c.id === id) ? cs.map((c) => (c.id === id ? { ...c, goal: target, goalPaused: paused } : c)) : cs));
  }

  // Remove the goal (/goal clear, trash; for "goal reached" the server clears it itself). The answer is the state.
  async function clearGoal() {
    const id = activeIdRef.current;
    if (!id) return;
    setGoal("");
    const revision = targetStatusRef.current;
    try {
      const r = await api<Chat>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ goal: "" }) });
      takeOverTarget(id, r.goal ?? "", r.goalPaused ?? false, revision);
      loadList().catch(console.error);
    } catch {
      /* silent: the banner is already gone, the server follows next time */
    }
  }

  // Pause or resume the goal (button in the goal line of the base): at once in the picture, then the answer counts. A server
  // without the field does not read it; nothing is paused there. A new /goal or clearing lifts the pause (setGoal).
  async function pauseGoal(p: boolean) {
    const id = activeIdRef.current;
    const target = goal;
    if (!id || !target.trim()) return;
    setGoal(target, p);
    const revision = targetStatusRef.current;
    try {
      const r = await api<Chat>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ goalPaused: p }) });
      takeOverTarget(id, r.goal ?? "", r.goalPaused ?? false, revision);
    } catch (e) {
      // The judge clears a reached goal before `goal_check` arrives here; the server answers pausing it with 400 ("There is no goal
      // to pause."). If the chat has no goal there any more, this state silently applies.
      const c = await api<Chat>(`/api/chats/${id}`).catch(() => null);
      if (c && !String(c.goal || "").trim()) return takeOverTarget(id, "", false, revision);
      if (targetStatusRef.current === revision) setGoal(target, !p);
      if (activeIdRef.current === id) addError(String((e as Error).message));
    }
  }

  // Compact the context (/compact or button). The server summarises and sends compacting/compacted via SSE, which set the state
  // + the divider.
  async function compact(instruction = "") { // `/compact <instruction>`: as in Claude Code, appended to the summarisation task
    const id = activeIdRef.current;
    if (!id || compacting || busy) return;
    setCompacting(true);
    try {
      const r = await api<{ ok: boolean; note?: string }>(`/api/chats/${id}/compact`, { method: "POST", body: JSON.stringify({ instruction }) });
      if (!r.ok) {
        setCompacting(false);
        if (r.note) pushInfo("Compact", r.note);
      }
    } catch (e) {
      setCompacting(false);
      addError(t("Compaction failed: {msg}", { msg: (e as Error).message }));
    }
  }

  // /clear resets only the model context. The stored bubbles stay as a slightly greyed history; the persisted server marker
  // restores that after a reload too.
  async function clearContext() {
    const id = activeIdRef.current;
    if (!id) { pushInfo("Note", t("There is no history to clear yet.")); return; }
    if (busy) { pushInfo("Note", t("The current run must finish before /clear.")); return; }
    const r = await api<{ ok: boolean; at: number }>(`/api/chats/${id}/clear`, { method: "POST" });
    applyClear(r.at);
  }

  // Abort the running generation. The server ends the process and sends run_aborted, which cleans up the editing state.
  async function stop() {
    const id = activeIdRef.current;
    if (!id || stopping) return;
    setStopping(true);
    try {
      await api(`/api/chats/${id}/stop`, { method: "POST" });
    } catch {
      setStopping(false);
    }
  }

  // "Steer": abort the running turn and send ALL queued messages at once, each as its own row in the history, together ONE run.
  // Without confirmation, as in the Codex app; the button deliberately sits next to the trash, and its tooltip says what it
  // destroys (minutes of work of the running turn).
  //
  // The queue is NOT cleared beforehand: the server clears it itself and sends message_queue: []; if we cleared it here too, the
  // strips would vanish before the abort is even through, and a failure would leave us with no display and no text.
  async function control() {
    const id = activeIdRef.current;
    if (!id || controlRunning) return;
    setControlRunning(true);
    try {
      await api(`/api/chats/${id}/control`, { method: "POST" });
    } catch {
      /* silent: the queue is still there, the user can try again */
    } finally {
      setControlRunning(false);
    }
  }

  // Discard a queued message. Its text goes back into the input field IF that is empty; otherwise taking it back would overwrite
  // a started draft, which weighs more than the second route to the same text (the user has just written it).
  async function dismissQueued(q: { id: string; text: string }) {
    const id = activeIdRef.current;
    if (!id) return;
    setQueued((cur) => cur.filter((x) => x.id !== q.id));
    try {
      await api(`/api/chats/${id}/message/queue/${q.id}`, { method: "DELETE" });
      setInput((cur) => cur || q.text);
    } catch {
      // If it was injected at that very moment, taking it back is no longer possible.
    }
  }

  // Report the decision on an interactive tool approval to the server (remove the card at once). `extras` carries what the card
  // additionally offers: changed input, a refusal reason for the model and the rule to remember for "do not ask again".
  async function decidePermission(
    requestId: string,
    behavior: "allow" | "deny",
    extras?: { updatedInput?: Record<string, unknown>; message?: string; remember?: string },
  ) {
    const id = activeIdRef.current;
    setPermReqs((prev) => prev.filter((r) => r.requestId !== requestId));
    // Optimistic: the history card flips at once; the server sends the real decision right afterwards and overwrites it.
    markApprovalDecided(requestId, {
      behavior, reason: extras?.message ?? "", origin: "user", updatedInput: behavior === "allow" ? (extras?.updatedInput ?? null) : null, at: Date.now(),
      ...(behavior === "allow" && extras?.remember ? { remember: extras.remember } : {}),
    });
    if (!id) return;
    try {
      await api(`/api/chats/${id}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId, behavior, ...(extras || {}) }) });
    } catch { /* ignore: the request is resolved at the end of the run at the latest */ }
  }

  // Submit the choice in a question card. The server delivers it as an ordinary user message: if a turn is still running it is
  // queued/injected, otherwise it starts a new run. Optimistic; on an error the card becomes clickable again.
  async function answerAsk(requestId: string, answers: AskAnswer[]) {
    const id = activeIdRef.current;
    if (!id) return;
    markAskAnswered(requestId, answers);
    stickRef.current = true;
    try {
      await api(`/api/chats/${id}/ask-answer`, { method: "POST", body: JSON.stringify({ requestId, answers }) });
    } catch (e) {
      setBubbles((prev) => prev.map((b) => (
        b.role === "ask" && b.ask?.requestId === requestId
          ? { ...b, ask: { ...b.ask, answers: null, answerable: true } }
          : b
      )));
      addError(String((e as Error).message));
    }
  }

  async function renameChat(chat: Chat) {
    const title = await ask(t("New title:"), chat.title);
    if (!title) return;
    await api(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
    loadList().catch(console.error);
  }

  async function togglePin(chat: Chat) {
    await api(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ pinned: !chat.pinned }) });
    loadList().catch(console.error);
  }

  async function moveToProject(chat: Chat, projectId: string | null) {
    await api(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId }) });
    loadList().catch(console.error);
  }

  // Start a new chat IN a folder (folder menu, key N): a draft with the folder and its project; created on the first send, via
  // `ensureChat`.
  async function createChatInFolder(folder: ChatFolder) {
    newChat({ folder: folder });
  }

  async function deleteChat(chat: Chat) {
    if (!(await question(t("Delete chat? History, attachments, and artifacts will be permanently removed."), { ok: t("Delete"), danger: true }))) return;
    try {
      await api(`/api/chats/${chat.id}`, { method: "DELETE" });
    } catch (e) {
      // A running chat is protected on the server (409): inform the user instead of failing silently.
      alert((e as Error).message || t("Delete failed"));
      return;
    }
    chatAway(chat.id);
    loadList().catch(console.error);
    onChanged?.();
  }
  function chatAway(id: string) { // what a deleted chat leaves behind here, also from a deleted folder (useArchive)
    dropChatCache(id); chatDeleted(id); // whatever unsaved state only this chat held goes with it
    // The server ended its PTYs on DELETE (tag "chat:<id>"); the terminal bar's layout for them would otherwise be an orphan.
    try { localStorage.removeItem(terminalLayoutKey(terminalScope(id))); } catch { /* local storage is optional */ }
    if (activeIdRef.current === id) {
      esWatchdogRef.current?.stop();
      esRef.current?.close();
      draft.erase(); // via the handle: a plain removal would be written straight back by the throttle
      setActiveId(null);
      setBubbles([]);
    } else {
      deleteDraft(draftKey(id));
    }
  }

  const activeChat = chats.find((c) => c.id === activeId) ?? archiveChat;
  const activeProject = workspace.projects.find((p) => p.id === activeChat?.projectId);
  // The binding of the open chat (`chat.instance`): the bar's git choice drops when it changes.
  const chatInstance = activeChat?.instance ?? null;
  function pickHeroProject(id: string | null) {
    setProjPickerOpen(false);
    if (activeIdRef.current) {
      // Also the empty, already created chat (an attachment creates it) that the list does not carry yet: `activeChat` holds it.
      const chat = activeChat?.id === activeIdRef.current ? activeChat : undefined;
      if (chat) moveToProject(chat, id);
    } else {
      setProjectSel(id ?? "");
    }
  }
  // Model and effort choice (chat/chatModelChoice.ts): provider lists (all for the levels, connected ones for the model picker),
  // preselection of the next chat, provider default, EFFECTIVE model with its label, level with its label, and `pickEffort`.
  // `pickModel` and the provider switch stay here.
  const { describeModel, providers, providerSel, setProviderSel, modelSel, setModelSel, effortPickerOpen, setEffortPickerOpen, currentProvider, allProviders, pickerProviders, providerDefault, currentModel, effectiveModel, currentModelLabel, currentEffort, currentEffortLabel, pickEffort, ultracode, setUltracode, effortForCreation } = useModelChoice({ activeId, activeChat, activeIdRef, loadList });
  // Instance of the chat (chat/chatInstance.ts): choice in the empty chat next to the project choice, switch in the header via PATCH.
  const { instanceOptions, activeInstance, pickInstance, instanceForCreation, copyCreate, selectInstancePreselection } = useChatInstance({ workspace, projectId: activeChat ? activeChat.projectId : newChatProjectId(), activeChat, setChats, pushInfo });
  // Code tabs in the chat (chat/chatTabs.ts): tab bar, code area, shortcuts; the stage gets the state as ONE prop.
  const chatTabs = useChatTabs({ activeId, activeChat, workspaceId: wsId, projectId: activeChat ? focusProjectId ?? activeChat.projectId : newChatProjectId(), activeInstance, busy, bubbles, permReqs, chats, taRef });
  const { tabView } = chatTabs;
  // New chat = draft (chat/chatDraft.ts): the entries only set the preselection and show the empty view.
  const { newChat, draftFolder } = useNewChat({ wsId, focusProjectId, activeId, folders, projectSel, folderSel, setProjectSel, setFolderSel, selectInstancePreselection, revealFolder, toDraft, taRef });
  // Model choice sets model AND provider (without a settings switch). Persist directly for the open chat. Special case provider
  // switch of a chat WITH history: the resume session is provider-specific and is discarded on the server → the new model would
  // otherwise have no memory. So first warn (confirmable once), then compact, then switch (see doProviderSwitch). Returns:
  // "applied" = switched at once; "deferred" = warning modal open, the switch follows only after confirmation (relevant for
  // /model, which would otherwise report "model set" prematurely).
  async function pickModel(providerId: string, id: string): Promise<"applied" | "deferred"> {
    setModelPickerOpen(false);
    if (!activeIdRef.current) {
      setProviderSel(providerId);
      setModelSel(id);
      return "applied";
    }
    const switchesProvider = providerId !== currentProvider;
    const hasConvo = bubbles.some((b) => b.role === "user" || b.role === "assistant");
    if (switchesProvider && hasConvo) {
      const pv = pickerProviders.find((p) => p.id === providerId);
      const moLabel = pv?.models.find((mm) => mm.id === id)?.label ?? (id || "Default");
      const label = `${pv?.label ?? providerId} · ${t(moLabel)}`;
      const noWarn = typeof window !== "undefined" && localStorage.getItem(PROVIDER_SWITCH_NOWARN) === "1";
      if (noWarn) { await doProviderSwitch(providerId, id); return "applied"; }
      setSwitchNoWarn(false);
      setProviderSwitch({ providerId, model: id, label });
      return "deferred";
    }
    // Pure model switch (same provider) or chat without history → switch directly.
    await api(`/api/chats/${activeIdRef.current}`, { method: "PATCH", body: JSON.stringify({ model: id, provider: providerId }) });
    loadList().catch(console.error);
    return "applied";
  }

  // Compact the history → then switch provider (+model). The order is decisive: /compact stores the summary as contextSummary and
  // discards the session; the following provider PATCH discards the (provider-specific) session too but leaves contextSummary in
  // place → on the new provider's first run it is injected once.
  async function doProviderSwitch(providerId: string, id: string) {
    const chatId = activeIdRef.current;
    if (!chatId || switching) return;
    setSwitching(true);
    try {
      try {
        // "Too little history" returns { ok:false } (no error) → then there is nothing to preserve, and we switch anyway. Only a
        // real error aborts (no silent context loss).
        await api(`/api/chats/${chatId}/compact`, { method: "POST" });
      } catch (e) {
        addError(t("Switch cancelled — compaction failed: {msg}", { msg: (e as Error).message }));
        return;
      }
      await api(`/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: id, provider: providerId }) });
      loadList().catch(console.error);
    } finally {
      setSwitching(false);
    }
  }
  const currentPerm = activeId ? (activeChat?.permissionMode ?? "") : permSel;
  // Show old chats without a set mode ('') as full access (profiles no longer carry permissions).
  const currentPermLabel = PERM_MODES.find((m) => m.id === (currentPerm || "bypassPermissions"))?.label ?? currentPerm;
  async function pickPerm(id: string) {
    setPermPickerOpen(false);
    if (activeIdRef.current) {
      await api(`/api/chats/${activeIdRef.current}`, { method: "PATCH", body: JSON.stringify({ permissionMode: id }) });
      loadList().catch(console.error);
    } else {
      setPermSel(id);
    }
  }
  // A click elsewhere closes every open popover. Behind each there used to be a `fixed inset-0` click catcher; that no longer
  // works: the content area of the Coding page is an `@container`, and layout containment makes it the reference frame for
  // `position: fixed`; the catcher then covered only the view, and a click into the header left the menu open. Now every trigger
  // and its sheet carry `data-pop` with its name; a mousedown outside closes everything, inside only the OTHERS: a click on the next
  // picker opens it without two being open side by side.
  const anyPopOpen = newChatOpen || projPickerOpen || modelPickerOpen || permPickerOpen || effortPickerOpen || headerMenu || sortOpen;
  useEffect(() => {
    if (!anyPopOpen) return;
    const beside = (e: MouseEvent) => {
      const inside = (e.target as Element | null)?.closest?.("[data-pop]")?.getAttribute("data-pop") ?? "";
      if (inside !== "fresh") setNewChatOpen(false);
      if (inside !== "project") setProjPickerOpen(false);
      if (inside !== "model") setModelPickerOpen(false);
      if (inside !== "permissions") setPermPickerOpen(false);
      if (inside !== "effort") setEffortPickerOpen(false);
      if (inside !== "header") setHeaderMenu(false);
      if (inside !== "sort") setSortOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setNewChatOpen(false); setProjPickerOpen(false); setModelPickerOpen(false); setPermPickerOpen(false);
      setEffortPickerOpen(false); setHeaderMenu(false); setSortOpen(false);
    };
    document.addEventListener("mousedown", beside);
    window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", beside); window.removeEventListener("keydown", esc); };
  }, [anyPopOpen]);

  // Click on the subagent mark in the history (AssistantBlocks): the right bar opens on the Agents tab and selects EXACTLY this
  // agent. The key is the tool call id, the same one by which the bar merges a live-reported agent with its block in the history.
  // Stable via refs because AssistantBlocks and BubbleRow are memoised: a function new on every render would have redrawn the
  // whole history while streaming.
  const openRightRef = useRef(openRightSidebar);
  openRightRef.current = openRightSidebar;
  const [agentSelected, setAgentSelected] = useState("");
  const onAgentOpen = useCallback((id: string) => {
    setAgentSelected(id);
    openRightRef.current("agents");
  }, []);
  // The jump "agent in chat" from outside (lib/agent-jump.ts): opens the chat, then via the same handle the bar with the agent.
  const { workflowChoice } = useAgentJump({ off: Boolean(onlyChat), activeId, chatLoading, agents, dynTree, onAgentOpen });
  useAgendaJump({ off: Boolean(onlyChat), activeId, chatLoading, open: () => openRightRef.current("agenda") }); // timeline → agenda item

  // Empty chat = hero image instead of history. `chatLoading` belongs in the condition: without it the view jumped briefly into
  // the hero and straight back on a chat switch. `firstInFlight`: from sending the first message on, no longer empty (see there).
  const empty = !firstInFlight && (!activeId || (bubbles.length === 0 && !chatLoading));

  return (
    // min-w-0: as a flex child next to the git sidebar (in the Chats tab) the ChatPane must be allowed to shrink below its content
    // width, otherwise wide content (code blocks/tool output) pushes the row past the window edge and the 272 px sidebar is cut off on the right.
    // `cb-kit`: the cool colour roles (first those of the manager chat, light theme only). THREE cards on the frame: chat list
    // (ChatListPane), conversation (the stage below) and right bar (ChatRightSidebar) each draw their own card, the root has no
    // surface any more, and the layout's content card steps back (`data-three-cards`, globals.css).
    // `cb-flat` + `FlatContext`: every menu and modal of the chat in the flat form (CbKit `useFlat`); the class hits the sheets in
    // the tree, the context those via portal on the body.
    <FlatContext.Provider value>
    <div className="cb-kit cb-flat relative flex min-h-0 min-w-0 flex-1">
      {/* Chat list, rail and preview (chat/ChatListPane.tsx): the docked list, the rail of the collapsed list and the hover preview
          as ONE fragment, with the chat, notification and folder menus (portals on the body). Collapse/expand, preview, sorting and
          the menus live there; list, folders, search, preselection of the next chat, creation and the loaders stay here (event
          stream, open(), header, stage and the global popover closer touch them) and go in as prop + setter. */}
      {!onlyChat && <ChatListPane
        t={t}
        workspace={workspace}
        focusProjectId={focusProjectId}
        focusProject={focusProject}
        animReady={animReady}
        activeId={activeId}
        chats={chats}
        setChats={setChats}
        folders={folders}
        scopedChats={scopedChats}
        visibleFolders={visibleFolders}
        folderChats={folderChats}
        runningChats={runningChats}
        workflowChats={workflowChats}
        unreadChats={unreadChats}
        listSearch={listSearch}
        setListSearch={setListSearch}
        sortOpen={sortOpen}
        setSortOpen={setSortOpen}
        newChatOpen={newChatOpen}
        setNewChatOpen={setNewChatOpen}
        openFolders={openFolders}
        toggleFolder={toggleFolder}
        revealFolder={revealFolder}
        projectSel={projectSel}
        setProjectSel={setProjectSel}
        folderSel={folderSel}
        setFolderSel={setFolderSel}
        newChatFolders={newChatFolders}
        open={open}
        createChat={createChat}
        createChatInFolder={createChatInFolder}
        renameChat={renameChat}
        togglePin={togglePin}
        moveToProject={moveToProject}
        deleteChat={deleteChat}
        loadList={loadList}
        loadFolders={loadFolders}
        setFolderView={setFolderView}
        onChanged={onChanged}
        describeModel={describeModel}
      />}

      {/* The middle card: it carries the opaque stage surface (`cb-kit-stage`, `bg-panel`), rounded and with the frame's hairline like
          the layout's content card; between it and the neighbouring cards lie 3 px of frame, as an element of its own
          (chat/CardsSplit.tsx: three dots, handle of the width, only this gutter glows while dragging), rendered by the chat list
          BEHIND its card and by the right bar BEFORE its (without a chat and a project, no card and no gutter). `overflow-hidden`
          keeps header and base inside the rounded corners; menus and modals hang on the body via portal. */}
      <div className="cb-kit-stage flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[12px] border border-frame-edge bg-panel">
      {/* The stage. `relative`, because header and base lie as plates OVER the scrolling history, which fades out under their veils.
          The whole surface is a drop target for file attachments (not only the input field). */}
      {/* Stage (chat/ChatStage.tsx): drop target, folder view, header with the three banners, hero or history (memory brake, run
          indicator, approval cards, selection menu), jump arrow and base (strip base with the compaction row, toast, context bar) as
          ONE tree. Scroll sticking, the measurement of header and base and the derivations only it reads live there; the composer
          stays here and goes in as a child (its props do not run through the stage); whatever open(), send, onEvent, the effects, list,
          bar or composer also touch stays here and goes in as prop + setter (refs as an object). */}
      <ChatStage
        t={t}
        workspace={workspace}
        focusProject={focusProject}
        projectSel={projectSel}
        setChats={setChats}
        activeId={activeId}
        bubbles={bubbles}
        chatLoading={chatLoading}
        timeWindow={timeWindow}
        loadOlder={loadOlder}
        busy={busy}
        waiting={waiting}
        waitMonitors={waitMonitors}
        waitTasks={waitTasks}
        waitWakeupAt={waitWakeupAt}
        waitWakeup={waitWakeup}
        agents={agents}
        dynTree={dynTree}
        graphRuns={graphRuns}
        graphHidden={graphHidden}
        stopGraphStart={stopGraphStart}
        fadeGraphOut={fadeGraphOut}
        copiedIdx={copiedIdx}
        autoCopied={autoCopied}
        selMenu={selMenu}
        setSelMenu={setSelMenu}
        queued={queued}
        setDragOver={setDragOver}
        folderView={folderView}
        setFolderView={setFolderView}
        folderContextTick={folderContextTick}
        projPickerOpen={projPickerOpen}
        setProjPickerOpen={setProjPickerOpen}
        ctxTokens={ctxTokens}
        outTokens={outTokens}
        inTokens={inTokens}
        statusPair={statusPair}
        streamingText={streamingText}
        controlRunning={controlRunning}
        compacting={compacting}
        goal={goal}
        goalPaused={goalPaused}
        wfRun={wfRun}
        limitWait={limitWait}
        wfBusy={wfBusy}
        wfNow={wfNow}
        wfTicking={wfTicking}
        permReqs={permReqs}
        providers={providers}
        runStartRef={runStartRef}
        msgsRef={msgsRef}
        stickRef={stickRef}
        headerMenu={headerMenu}
        setHeaderMenu={setHeaderMenu}
        activeIdRef={activeIdRef}
        folderChats={folderChats}
        open={open}
        addFiles={addFiles}
        pushInfo={pushInfo}
        retryLimitNow={retryLimitNow}
        cancelLimitWait={cancelLimitWait}
        skipWorkflowStep={skipWorkflowStep}
        cancelWorkflow={cancelWorkflow}
        copyBubble={copyBubble}
        selectionInMessages={selectionInMessages}
        onMessagesMouseUp={onMessagesMouseUp}
        askAboutSelection={askAboutSelection}
        copySelection={copySelection}
        clearGoal={clearGoal}
        pauseGoal={pauseGoal}
        compact={compact}
        control={control}
        dismissQueued={dismissQueued}
        decidePermission={decidePermission}
        answerAsk={answerAsk}
        renameChat={renameChat}
        togglePin={togglePin}
        deleteChat={deleteChat}
        activeChat={activeChat}
        pickHeroProject={pickHeroProject}
        instanceOptions={instanceOptions}
        activeInstance={activeInstance}
        pickInstance={pickInstance}
        copyCreate={copyCreate}
        currentProvider={currentProvider}
        providerDefault={providerDefault}
        currentModel={currentModel}
        onAgentOpen={onAgentOpen}
        agentStates={agentStates}
        empty={empty}
        archived={archived}
        archive={archive}
        restore={restore}
        draftFolder={draftFolder}
        chatTabs={chatTabs}
      >
        {archived ? <ArchiveBar archivedAt={archivedAt} onRestore={restore} /> : (
        <ChatComposer
          ref={composerRef}
          t={t}
          hero={empty}
          activeId={activeId}
          wsId={wsId}
          focusProjectId={focusProjectId}
          input={input}
          setInput={setInput}
          files={files}
          setFiles={setFiles}
          quotes={quotes}
          setQuotes={setQuotes}
          uploading={uploading}
          dragOver={dragOver}
          busy={busy}
          stopping={stopping}
          send={send}
          stop={stop}
          addFiles={addFiles}
          addPastedText={addPastedText}
          wfRun={wfRun}
          taRef={taRef}
          currentProvider={currentProvider}
          effectiveModel={effectiveModel}
          currentModelLabel={currentModelLabel}
          pickerProviders={pickerProviders}
          providerDefault={providerDefault}
          pickModel={pickModel}
          modelPickerOpen={modelPickerOpen}
          setModelPickerOpen={setModelPickerOpen}
          currentPerm={currentPerm}
          currentPermLabel={currentPermLabel}
          pickPerm={pickPerm}
          permPickerOpen={permPickerOpen}
          setPermPickerOpen={setPermPickerOpen}
          currentEffort={currentEffort}
          currentEffortLabel={currentEffortLabel}
          ultracode={ultracode} setUltracode={setUltracode}
          effortCatalog={allProviders}
          pickEffort={pickEffort}
          effortPickerOpen={effortPickerOpen}
          setEffortPickerOpen={setEffortPickerOpen}
        />
        )}
      </ChatStage>
      </div>

      {/* Right bar (chat/ChatRightSidebar.tsx): activity bar + draggable panel with seven sections (Git, Agenda, Artifacts,
          Channels, Agents, Terminal, Browser) as ONE flex rail. Section and open state stay here (useAutoCollapse and onAgentOpen
          touch them), as do the artifact list and the selection (open(), loadArtifacts and the ArtifactModal below); the bar holds
          only what it alone sets and reads (the width too). */}
      <ChatRightSidebar
        t={t}
        activeId={activeId}
        chatInstance={chatInstance}
        wsId={wsId}
        focusProjectId={focusProjectId}
        focusProject={focusProject}
        activeProject={activeProject}
        animReady={animReady}
        rightSidebarOpen={rightSidebarOpen}
        rightSidebarTab={rightSidebarTab}
        setRightSidebarTab={setRightSidebarTab}
        setRightSidebarOpen={setRightSidebarOpen}
        openRightSidebar={openRightSidebar}
        artifacts={artifacts}
        artifactSelected={artifactSelected}
        selectArtifact={selectArtifact}
        loadArtifacts={loadArtifacts}
        addError={addError}
        agents={agents}
        dynTree={dynTree}
        agentSelected={agentSelected}
        setAgentSelected={setAgentSelected}
        workflowChoice={workflowChoice}
        taskSequence={taskSequence}
        graphRuns={graphRuns}
        stopGraphStart={stopGraphStart}
        respondGraph={respondGraph}
        waitTasks={waitTasks}
        waitMonitors={waitMonitors}
        waitWakeupAt={waitWakeupAt} waitWakeup={waitWakeup}
        archived={archived}
        tabView={tabView}
      />

      {/* Open artifact: large in the middle of the screen instead of squeezed into the sidebar. */}
      {artifactSelected && activeId && (
        <ArtifactModal
          artifact={artifactSelected}
          content={artifactContent}
          loading={artifactLoading}
          downloadUrl={artifactUrl(activeId, artifactSelected.path, false, artifactSelected.chatId)}
          inlineUrl={artifactUrl(activeId, artifactSelected.path, true, artifactSelected.chatId)}
          onClose={closeArtifact}
          onSave={artifactSelected.own === false || archived ? undefined : saveArtifact}
        />
      )}

      {/* Provider switch warning modal (ProviderSwitchModal.tsx): confirm → compact → switch. */}
      {providerSwitch && (
        <ProviderSwitchModal
          providerSwitch={providerSwitch}
          switching={switching}
          switchNoWarn={switchNoWarn}
          setSwitchNoWarn={setSwitchNoWarn}
          setProviderSwitch={setProviderSwitch}
          doProviderSwitch={doProviderSwitch}
          t={t}
        />
      )}
    </div>
    </FlatContext.Provider>
  );
}
