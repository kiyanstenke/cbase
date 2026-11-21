"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Chat, type ChatFolder, type Project, type Workspace } from "@/lib/api";
import { useConfirm, usePrompt } from "@/components/Prompts";
import { AnimatedSwitch } from "@/components/AnimatedSwitch";
import { accent, field, menuRow } from "@/components/CbKit";
import { NotifySheet } from "@/components/NotifySheet";
import { useAutoCollapse } from "@/lib/viewport";
import { LIST_WIDTH_KEY, LIST_WIDTH_MAX, LIST_WIDTH_MIN, LIST_WIDTH_DEFAULT, clampListWidth } from "@/lib/chat-list-width";
import { CardsSplit } from "@/components/chat/CardsSplit";
import { CaretDown, CheckIcon, FolderIcon, FolderPlusIcon, PanelCloseIcon, PanelOpenIcon, PencilIcon, SearchIcon } from "@/components/chat/ChatIcons";
import { SORTINGS } from "@/components/chat/ChatCatalog";
import { ChatMenu, ChatRow, FolderMenu, FolderRow, buildSections } from "@/components/chat/ChatListRows";
import { ArchiveView } from "@/components/ArchiveView";
import { ArchiveIcon } from "@/components/ArchiveEntry";
import { folderArchivePrecheck, type ActiveRun } from "@/lib/api";
import { RailChats } from "@/components/chat/ChatRail";
import { ChatTooltipCard, useRowsTooltip, type TooltipContent } from "@/components/chat/ChatTooltip";
import type { ModelRow } from "@/components/chat/chatModelChoice";
import { copyText, lastActivity, stateSet } from "@/lib/chat-tooltip";
import { chatCopyLocation } from "@/lib/chat-location";
import { normChatJob } from "@/lib/api";
import { jobClock } from "@/lib/scheduled";
import { relative } from "@/lib/chat-format";
import { dateLocale } from "@/lib/i18n";
import { chatWorking, type WorkflowChats } from "@/lib/workflow-chats";
import { contextFilesSentence } from "@/lib/archive";

// The chat list of the Coding chat: the WHOLE left side as ONE fragment: the docked list (`<aside>`, animated width), the rail of
// the collapsed list (expand with hover preview, new chat) and the preview as a floating overlay, plus the three sheets that
// depend on the list state (`ChatMenu`, `NotifySheet`, `FolderMenu`; all three are portals on the body, so their place in the
// tree does not matter for the DOM).
//
// What lives here: the collapse state (`listCollapsed` with `useAutoCollapse(900, …)`; the whole state lives here, so nobody needs
// the raw setter from outside), the hover preview (`listPeek`, `peekTimer`, `pointerRef`, `overlayRef`, `menuOpenRef`,
// `peekOpen`/`peekClose`/`toggleList`, the pointer tracking and the re-evaluation after the menu closes), the sort mode
// (`sortMode`, and with it `looseChats`/`sections`, computed from it), the expanded search field (`listSearchOpen`), the three
// menu states (`menu`, `notifyFor`, `folderMenu`) with `openMenu`/`openFolderMenu`, and the handlers called ONLY from the list
// and its menus: `forkChat`, `createFolder`, `renameFolder`, `deleteFolder`, `moveToFolder`.
//
// What STAYS in ChatPane and arrives as a prop (rule: whatever touches the stage, creation, header, event stream or the global
// popover closer stays there; prop + setter, no context):
// - `chats`/`setChats`, `folders`, `activeId`, `runningChats`/`unreadChats`: the global event stream and `open()` write them; the
//   notification sheet writes `setChats`.
// - `scopedChats`/`visibleFolders`/`folderChats`: the stage reads `folderChats` (folder view), and `scopedChats` is its source;
//   that is why the SEARCH (`listSearch`) also stays there: it filters `scopedChats`, hence the folder view too. Only
//   `looseChats`/`sections` (sorting, used only by the list) live here.
// - `sortOpen`, `newChatOpen`: the global popover closer (`anyPopOpen`) reads and closes them.
// - `openFolders`/`toggleFolder`/`revealFolder`: `createChat`/`ensureChat` (sending from the hero) expand the target folder via
//   `revealFolder`.
// - `projectSel`/`folderSel` (+ setters) and `newChatFolders`: the preselection of the next chat; `createChat`, `ensureChat`,
//   `pickHeroProject` read them; the effect that resets `folderSel` on scope change is setter logic of this state and stays with it.
// - `createChat`/`createChatInFolder`: they only open the draft: `createChat("sheet")` with the sheet's choice, `createChat()`
//   plain (row, rail: without folder); the chat is created on the first send (`ensureChat`); `renameChat`/`togglePin`/`deleteChat`:
//   the header's ⋯ menu calls them too; `moveToProject`: `pickHeroProject` too.
// - `loadList`/`loadFolders`: the event stream, window focus, `open()` and the pickers call `loadList`, and `loadList` calls
//   `loadFolders`.
// - `setFolderView`: the folder view sits on the stage; `onChanged`: the workspace detail's counter.
// No handle (`forwardRef`): nothing in ChatPane triggers anything on the list (`toggleList` is only called from the list and the
// rail, both here).
//
// Seams: `wsId` comes from `workspace.id` (as in ChatPane), `field` straight from CbKit, `ask` via `usePrompt()` and `question`
// via `useConfirm()` (the same context as in ChatPane).
export type ChatListPaneProps = {
  t: (key: string, params?: Record<string, string | number>) => string;
  workspace: Workspace; // projects (new-chat sheet, folder row, menu) and the id (create folder)
  focusProjectId: string | null; // entered project: no project field, no sorting, folders inside the project
  focusProject: Project | null;
  animReady: boolean; // width/opacity transitions only after the first paint (ChatPane measures the moment)
  activeId: string | null;
  chats: Chat[]; // the whole list of the workspace ("No chats yet.")
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>; // the notification sheet writes the choice into the row
  folders: ChatFolder[]; // all folders of the workspace (the "To folder" menu filters by scope)
  scopedChats: Chat[]; // chats in scope, filtered by the search (ChatPane: the folder view reads them too)
  visibleFolders: ChatFolder[];
  folderChats: Map<string, Chat[]>;
  runningChats: Set<string>; // hexagon spins (global event stream)
  workflowChats: WorkflowChats; // hexagon also spins while a dynamic workflow is open (lib/workflow-chats.ts)
  unreadChats: Set<string>; // hexagon glows
  listSearch: string; // the search filters scopedChats, hence ChatPane's state
  setListSearch: React.Dispatch<React.SetStateAction<string>>;
  sortOpen: boolean; // sort dropdown; the global popover closer reads it
  setSortOpen: React.Dispatch<React.SetStateAction<boolean>>;
  newChatOpen: boolean; // "New chat in …" sheet, likewise
  setNewChatOpen: React.Dispatch<React.SetStateAction<boolean>>;
  openFolders: Set<string>; // expanded folders (remembered per workspace; createChat/ensureChat expand)
  toggleFolder: (id: string) => void;
  revealFolder: (id: string) => void;
  projectSel: string; // preselection of the next chat: project, folder
  setProjectSel: React.Dispatch<React.SetStateAction<string>>;
  folderSel: string;
  setFolderSel: React.Dispatch<React.SetStateAction<string>>;
  newChatFolders: ChatFolder[]; // folders of the chosen scope (ChatPane resets folderSel with it)
  open: (id: string) => Promise<void>; // open a chat (row, fork)
  createChat: (out?: "sheet") => Promise<void>; // open a draft: plain (row "New chat", rail) or with the sheet's choice
  createChatInFolder: (folder: ChatFolder) => Promise<void>;
  renameChat: (chat: Chat) => Promise<void>; // the header's ⋯ menu too
  togglePin: (chat: Chat) => Promise<void>;
  moveToProject: (chat: Chat, projectId: string | null) => Promise<void>; // pickHeroProject too
  deleteChat: (chat: Chat) => Promise<void>;
  loadList: () => Promise<Chat[]>; // chats + folders (event stream, focus, open: ChatPane)
  loadFolders: () => Promise<ChatFolder[]>;
  setFolderView: React.Dispatch<React.SetStateAction<ChatFolder | null>>; // folder view on the stage
  onChanged: (() => void) | undefined; // counter in the workspace detail (fork, delete folder)
  describeModel: (chat: Chat, t: (key: string, params?: Record<string, string | number>) => string) => ModelRow | null; // tooltip: model and level (useModelChoice)
};

// What the tooltip fetches fresh from the server on appearing: the goal (with pause) and the last activity of that ONE chat.
type ChatFresh = { goal: string; goalPaused: boolean; updatedAt: number };
const freshChat = (id: string): Promise<ChatFresh> =>
  api<Chat>(`/api/chats/${id}`).then((c) => ({ goal: c.goal || "", goalPaused: c.goalPaused === true, updatedAt: c.updatedAt || 0 }));

export function ChatListPane(props: ChatListPaneProps) {
  const {
    t, workspace, focusProjectId, focusProject, animReady, activeId,
    chats, setChats, folders, scopedChats, visibleFolders, folderChats, runningChats, workflowChats, unreadChats,
    listSearch, setListSearch, sortOpen, setSortOpen, newChatOpen, setNewChatOpen,
    openFolders, toggleFolder, revealFolder, projectSel, setProjectSel, folderSel, setFolderSel, newChatFolders,
    open, createChat, createChatInFolder, renameChat, togglePin, moveToProject, deleteChat, loadList, loadFolders, setFolderView, onChanged,
    describeModel,
  } = props;
  const ask = usePrompt();
  const question = useConfirm();
  const wsId = workspace.id;
  const [sortMode, setSortMode] = useState<"recent" | "project">("recent");
  const [menu, setMenu] = useState<{ chat: Chat; x: number; y: number } | null>(null);
  // A chat's notification sheet: five three-way toggles, hence a sheet.
  const [notifyFor, setNotifyFor] = useState<Chat | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: ChatFolder; x: number; y: number } | null>(null);
  // Chat list collapsible. Read the initial state DIRECTLY from storage (lazy init) so the list does not flash open briefly on
  // navigation (e.g. Apps → Workspaces) and then animate shut. Mounting in the final state fires no CSS transition.
  const [listCollapsed, setListCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("cbase-chatlist-collapsed") === "1"; } catch { return false; }
  });
  // The chat list (272 px) collapses below 900 px, otherwise the history would get less than 600 px. Again the raw setter, so the
  // stored choice stays untouched; the list stays reachable in a narrow window via the expand button and the hover preview.
  useAutoCollapse(900, !listCollapsed, useCallback((open: boolean) => setListCollapsed(!open), []));
  // Hover peek of the collapsed chat list (like the workspace sidebar): hovering the expand button shows the list as a floating
  // overlay; the timer bridges the mouse gap between button and panel (otherwise the overlay shuts again immediately).
  const [listPeek, setListPeek] = useState(false);
  // Width of the docked list: dragged at the gutter to the right of the card (CardsSplit), the same mechanism as the handle of the
  // right bar (ChatRightSidebar.tsx handleDown …): pointer capture on the gutter, cursor and selection lock on the body for the
  // duration of the drag, no width transition meanwhile, double click = default, ←/→ in 16 px steps. The width is global
  // (localStorage), like the right bar's.
  const [listWidth, setListWidth] = useState<number>(() => {
    try { return clampListWidth(localStorage.getItem(LIST_WIDTH_KEY)); } catch { return LIST_WIDTH_DEFAULT; }
  });
  const [listDrag, setListDrag] = useState(false);
  const listTransaction = useRef<{ x: number; width: number } | null>(null);
  const saveListWidth = (b: number) => { try { localStorage.setItem(LIST_WIDTH_KEY, String(b)); } catch { /* local preference is optional */ } };
  const listTransactionCursor = (on: boolean) => {
    document.body.style.cursor = on ? "col-resize" : "";
    document.body.style.userSelect = on ? "none" : "";
  };
  useEffect(() => () => { if (listTransaction.current) listTransactionCursor(false); }, []);
  const listHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    listTransaction.current = { x: e.clientX, width: listWidth };
    setListDrag(true);
    listTransactionCursor(true);
  };
  const listHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!listTransaction.current) return;
    setListWidth(clampListWidth(listTransaction.current.width + (e.clientX - listTransaction.current.x)));
  };
  const listHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!listTransaction.current) return;
    const b = clampListWidth(listTransaction.current.width + (e.clientX - listTransaction.current.x));
    listTransaction.current = null;
    setListDrag(false);
    listTransactionCursor(false);
    setListWidth(b);
    saveListWidth(b);
  };
  const listHandleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
    if (!step) return;
    e.preventDefault();
    const b = clampListWidth(listWidth + step);
    setListWidth(b);
    saveListWidth(b);
  };
  const listHandleReset = () => { setListWidth(LIST_WIDTH_DEFAULT); saveListWidth(LIST_WIDTH_DEFAULT); };
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Live pointer position + overlay rect: closing the kebab menu fires no mouseenter on the preview (the menu backdrop lay over
  // it), so we check by hit point ourselves whether the mouse is still over the preview.
  const pointerRef = useRef({ x: -1, y: -1 });
  const overlayRef = useRef<HTMLDivElement>(null);
  const menuOpenRef = useRef(false);
  const peekOpen = useCallback(() => {
    clearTimeout(peekTimer.current);
    setListPeek(true);
  }, []);
  const peekClose = useCallback(() => {
    clearTimeout(peekTimer.current);
    // An open context menu puts a full-screen backdrop over the preview and triggers a spurious mouseleave: do not close then (the
    // menu closing decides anew).
    if (menuOpenRef.current) return;
    peekTimer.current = setTimeout(() => setListPeek(false), 250);
  }, []);
  const toggleList = useCallback(() => {
    setListPeek(false);
    setListCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem("cbase-chatlist-collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  // Track the pointer globally, also over the menu backdrop, so the hit test against the preview has a current position when the
  // menu closes.
  useEffect(() => {
    const track = (e: MouseEvent) => { pointerRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener("mousemove", track, true);
    window.addEventListener("mousedown", track, true);
    return () => {
      window.removeEventListener("mousemove", track, true);
      window.removeEventListener("mousedown", track, true);
    };
  }, []);
  const [listSearchOpen, setListSearchOpen] = useState(false);
  // The archive view: the header button toggles the column, the normal list shows none of it.
  const [archiveOpen, setArchiveOpen] = useState(false);
  // … and everything that is in no (visible) folder stays in the normal sections.
  const looseChats = useMemo(() => {
    const known = new Set(visibleFolders.map((f) => f.id));
    return scopedChats.filter((c) => !c.folderId || !known.has(c.folderId));
  }, [scopedChats, visibleFolders]);
  // In project focus there is only one project, so grouping by project makes no sense.
  const sections = useMemo(
    () => buildSections(looseChats, focusProjectId ? "recent" : sortMode, workspace.projects),
    [looseChats, sortMode, focusProjectId, workspace.projects],
  );
  // The rail of the collapsed list: the same chats in the same order, without sections.
  const railChats = useMemo(() => sections.flatMap((sec) => sec.chats), [sections]);

  // Fork a chat: a new chat with copied history that splits off its own Claude session from the origin on the first prompt (the
  // original stays untouched). Then open it.
  async function forkChat(chat: Chat) {
    try {
      const child = await api<Chat>(`/api/chats/${chat.id}/fork`, { method: "POST" });
      await loadList();
      onChanged?.();
      open(child.id);
    } catch (e) {
      alert(t("Fork failed: {msg}", { msg: (e as Error).message }));
    }
  }

  // ── Chat folders ───────────────────────────────────────────────────────────
  // A folder is pure grouping of the list; in project focus it is created in the project.
  async function createFolder() {
    const name = await ask(t("Folder name:"), t("New folder"));
    if (!name?.trim()) return;
    try {
      const folder = await api<ChatFolder>("/api/chat-folders", {
        method: "POST",
        body: JSON.stringify({ workspaceId: wsId, name: name.trim(), projectId: focusProjectId }),
      });
      revealFolder(folder.id);
      await loadFolders();
    } catch (e) {
      alert(t("Creating the folder failed: {msg}", { msg: (e as Error).message }));
    }
  }

  async function renameFolder(folder: ChatFolder) {
    const name = await ask(t("New name:"), folder.name);
    if (!name?.trim()) return;
    await api(`/api/chat-folders/${folder.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
    loadFolders().catch(console.error);
  }

  async function deleteFolder(folder: ChatFolder) {
    // The context files belong to the folder and go with it (server); the question names them. The server counts them
    // (`contextFiles`); if the call fails, the sentence says so WITHOUT a number.
    const n = await folderArchivePrecheck(folder.id).then((z) => z.contextFiles, () => null);
    const set = contextFilesSentence(n, t);
    const files = set ? ` ${set}` : "";
    if (!(await question(t("Delete folder \"{name}\"? The chats inside are kept and simply move out of the folder.", { name: folder.name }) + files, { ok: t("Delete"), danger: true }))) return;
    await api(`/api/chat-folders/${folder.id}`, { method: "DELETE" });
    setFolderView((cur) => (cur?.id === folder.id ? null : cur));
    await loadList();
    onChanged?.();
  }

  async function moveToFolder(chat: Chat, folderId: string | null) {
    try {
      await api(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ folderId }) });
    } catch (e) {
      alert((e as Error).message || t("Move failed"));
      return;
    }
    if (folderId) revealFolder(folderId);
    loadList().catch(console.error);
  }

  function openFolderMenu(folder: ChatFolder, x: number, y: number) {
    const left = Math.min(x, window.innerWidth - 232);
    const top = Math.min(y, window.innerHeight - 220);
    menuOpenRef.current = true;
    setFolderMenu({ folder, x: left, y: top });
  }

  // Open the context menu (right click or kebab button), clamped to the viewport.
  function openMenu(chat: Chat, x: number, y: number) {
    const left = Math.min(x, window.innerWidth - 232);
    const top = Math.min(y, window.innerHeight - 300);
    // Set synchronously BEFORE the backdrop triggers a spurious mouseleave on the preview.
    menuOpenRef.current = true;
    setMenu({ chat, x: left, y: top });
  }
  // When the kebab menu closes, re-evaluate the peek state: the preview stays open only if the mouse is actually still over it
  // (otherwise it would get stuck or vanish at once despite the mouse being over the list).
  const prevMenuRef = useRef(false);
  useEffect(() => {
    const what = prevMenuRef.current;
    const now = !!(menu || folderMenu);
    prevMenuRef.current = now;
    menuOpenRef.current = now;
    if (!(what && !now) || !listCollapsed) return; // only on the open→closed transition with the list collapsed
    clearTimeout(peekTimer.current);
    const r = overlayRef.current?.getBoundingClientRect();
    const p = pointerRef.current;
    const inside = !!r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
    setListPeek(inside);
  }, [menu, folderMenu, listCollapsed]);

  // The row tooltip (components/chat/ChatTooltip.tsx): ONE store for dock and preview, outside React, so hovering does not
  // re-render the list. While a menu or the notification sheet is open, none appears: it would sit exactly where the ⋯ menu opens.
  const short = useRowsTooltip(Boolean(menu || folderMenu || notifyFor));
  const tooltipContent = (id: string, runs: ActiveRun[] | null, now: number, fresh: ChatFresh | null): TooltipContent | null => {
    const c = chats.find((x) => x.id === id);
    if (!c) return null;
    const live = runningChats.has(id);
    // The project only where the list does not show it already: at workspace level, sorted by "Recently active", outside a folder.
    const inFolder = Boolean(c.folderId && visibleFolders.some((f) => f.id === c.folderId));
    const project = !focusProjectId && sortMode === "recent" && !inFolder && c.projectId
      ? workspace.projects.find((p) => p.id === c.projectId)?.name ?? null
      : null;
    // Goal and last activity: the newer state wins, the list (reloaded after a run) or the fresh fetch on appearing (the target
    // gate clears a reached goal AFTER the run, without an event to the list).
    const newer = fresh && fresh.updatedAt >= c.updatedAt ? fresh : c;
    // The chat's scheduled job: the row's clock, with the next occurrence.
    const job = normChatJob(c.job);
    const clock = jobClock(job);
    return {
      title: c.title,
      time: live ? null : lastActivity(newer.updatedAt, now, t, dateLocale()),
      model: describeModel(c, t),
      // The copy the chat works IN (`chats.instance`), not the one it created (lib/chat-location.ts).
      location: [project, copyText(chatCopyLocation(c), t)].filter(Boolean).join(" · ") || null,
      state: stateSet({ live, unread: unreadChats.has(id), runs, now, t }),
      // A resting goal says so, like the goal line in the base ("Goal paused").
      target: !newer.goal ? null : newer.goalPaused ? t("Goal (paused): {text}", { text: newer.goal }) : t("Goal: {text}", { text: newer.goal }),
      schedule: clock && job ? t(clock.key, clock.withWhen ? { when: relative(job.nextAt, now, t) } : undefined) : null,
      ticking: live,
    };
  };

  // Content of the chat list, defined once and rendered twice: docked (expanded) and as the hover-peek overlay (collapsed). State
  // (dropdown, sorting) is shared. The list is one surface on `bg`, no card. Header with collapse, search on demand and folders;
  // below it the row "New chat": one click CREATES (with the current preselection), the arrow next to it opens project and folder.
  //
  // WHY a function with `where` instead of one shared element: both instances are ALWAYS in the DOM (the docked one with width 0,
  // the preview with opacity 0). If the search field carried `autoFocus` in both, React would focus one, then the other on
  // showing; the first lost focus, its `onBlur` closed the empty search again, and no field ever appeared. Focus and
  // blur-closing belong only to the VISIBLE instance.
  const renderList = (location: "dock" | "peek") => {
    const active = listCollapsed ? location === "peek" : location === "dock";
    // The archive appears only in the VISIBLE instance: two views would load and listen twice.
    if (archiveOpen) {
      return active ? (
        <ArchiveView
          kind="normal"
          workspaceId={wsId}
          projectId={focusProjectId}
          activeId={activeId}
          // Via `cbase-open-chat`: the same path as every open by id (ChatPane → `openTarget`): the archived chat's metadata is in
          // place BEFORE switching, so the composer with its draft never appears.
          onOpen={(id) => { window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: id })); }}
          onBack={() => setArchiveOpen(false)}
          onChanged={() => { loadList().catch(console.error); }}
          deleteChat={(c) => deleteChat({ id: c.id, title: c.title } as Chat)}
        />
      ) : null;
    }
    return (
    <>
        {/* Header in the style of the ChatGPT sidebar: on the left the frame of the list (project or workspace), on the right
            search, archive and collapse. Collapse sits on the right as there; when collapsed its counterpart is on the left in the
            rail. Create folder and sort moved into their sections; the row "New chat" stays the first action. */}
        <header className="shrink-0 px-2 pb-1 pt-2">
          <div className="flex h-10 items-center gap-0.5">
            <span
              className="min-w-0 flex-1 truncate pl-2.5 text-[15px] font-semibold tracking-tight"
              title={focusProject ? t("Project · {name}", { name: focusProject.name }) : workspace.name}
            >
              {focusProject?.name ?? workspace.name}
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setListSearchOpen((v) => !v); if (listSearchOpen) setListSearch(""); }}
              title={t("Search chats…")}
              aria-label={t("Search chats…")}
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-hover hover:text-fg ${
                listSearchOpen || listSearch ? "text-fg" : "text-dim"
              }`}
            >
              <SearchIcon />
            </button>
            {/* Archive: a button without a count; Coding tabs carry no counters. */}
            <button
              type="button"
              data-archive-open="normal"
              onClick={() => { setArchiveOpen(true); setListSearch(""); setListSearchOpen(false); }}
              title={t("Archive##noun")}
              aria-label={t("Archive##noun")}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
            >
              <ArchiveIcon size={16} />
            </button>
            <button
              type="button"
              onClick={toggleList}
              title={t("Collapse chat list")}
              aria-label={t("Collapse chat list")}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
            >
              <PanelCloseIcon />
            </button>
          </div>
          {/* Search over the titles only: full text belongs in a search over the HISTORY, which does not exist here. */}
          {(listSearchOpen || listSearch) && (
            <label className="mt-1 flex items-center gap-2.5 rounded-lg bg-hover px-2.5 py-2 focus-within:ring-1 focus-within:ring-accent/50">
              <span className="shrink-0 text-dim"><SearchIcon /></span>
              <input
                autoFocus={active}
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setListSearch(""); setListSearchOpen(false); } }}
                onBlur={() => { if (active && !listSearch) setListSearchOpen(false); }}
                placeholder={t("Search chats…")}
                className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-dim"
              />
            </label>
          )}
          <div className="relative mt-1" data-pop="fresh">
            <div className={`flex items-center rounded-lg transition-colors ${newChatOpen ? "bg-hover" : "hover:bg-hover"}`}>
              <button
                type="button"
                onClick={() => { setNewChatOpen(false); void createChat(); }}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]"
              >
                <span className="shrink-0 text-fg/80"><PencilIcon /></span>
                {t("New chat")}
              </button>
              <button
                type="button"
                onClick={() => setNewChatOpen((v) => !v)}
                title={t("Choose project and folder")}
                aria-label={t("Choose project and folder")}
                className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-edge hover:text-fg"
              >
                <span className={`transition-transform duration-200 ${newChatOpen ? "rotate-180" : ""}`}>
                  <CaretDown />
                </span>
              </button>
            </div>
            {newChatOpen && (
              <div className="cb-pop-in-fast cb-pop absolute left-0 right-0 top-full z-40 mt-1 origin-top rounded-xl p-3 text-fg">
                  <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-dim">{t("New chat in")}</div>
                  {focusProject ? (
                    <div className="mb-3 flex items-center gap-1.5 rounded-full bg-bg px-3 py-1.5 text-[12.5px] font-medium">
                      <span className="text-accent"><FolderIcon /></span>
                      {t("Project · {name}", { name: focusProject.name })}
                    </div>
                  ) : (
                    <label className="mb-2 block text-[12px] font-medium text-dim">
                      {t("Project")}
                      <select
                        value={projectSel}
                        onChange={(e) => setProjectSel(e.target.value)}
                        className={`${field} mt-1 w-full text-[13px]`}
                      >
                        <option value="">{t("entire workspace")}</option>
                        {workspace.projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {/* Folders of the chosen scope: the new chat starts inside right away (and thereby shares read access to the
                      artifacts of the other chats in this folder). */}
                  {newChatFolders.length > 0 && (
                    <label className="mb-2 block text-[12px] font-medium text-dim">
                      {t("Folder")}
                      <select
                        value={folderSel}
                        onChange={(e) => setFolderSel(e.target.value)}
                        className={`${field} mt-1 w-full text-[13px]`}
                      >
                        <option value="">{t("No folder")}</option>
                        {newChatFolders.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      createChat("sheet");
                      setNewChatOpen(false);
                    }}
                    className={`${accent} mt-1 w-full py-2 text-sm`}
                  >
                    {t("Start chat")}
                  </button>
              </div>
            )}
          </div>
        </header>
        <AnimatedSwitch token={sortMode} className="cb-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {/* Folders always sit at the top: they are structure, not history (ChatGPT "Projects"). The section starts with "New
              folder" as there with "New project"; expanded, a folder's chats run indented to its name below. While searching,
              creating is omitted. */}
          {(visibleFolders.length > 0 || !listSearch) && (
            <div className="mt-2">
              <div className="px-2.5 pb-1 pt-1.5 text-[13px] font-medium text-dim">{t("Folder")}</div>
              {!listSearch && (
                <button
                  type="button"
                  onClick={createFolder}
                  title={focusProject ? t("Create a folder in this project") : t("Create folder")}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] text-fg/90 transition-colors hover:bg-hover"
                >
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-fg/75"><FolderPlusIcon /></span>
                  {t("New folder")}
                </button>
              )}
              {visibleFolders.map((folder) => {
                const inside = folderChats.get(folder.id) ?? [];
                const expanded = openFolders.has(folder.id);
                return (
                  <div key={folder.id}>
                    <FolderRow
                      folder={folder}
                      expanded={expanded}
                      // At workspace level project folders appear in the list too; the row then says which project the folder
                      // belongs to.
                      projectName={!focusProjectId && folder.projectId ? workspace.projects.find((p) => p.id === folder.projectId)?.name ?? null : null}
                      hasActive={inside.some((c) => c.id === activeId)}
                      running={inside.some((c) => chatWorking(c.id, runningChats, workflowChats))}
                      unread={inside.some((c) => unreadChats.has(c.id))}
                      onToggle={() => toggleFolder(folder.id)}
                      onOpen={() => setFolderView(folder)}
                      onMenu={(x, y) => openFolderMenu(folder, x, y)}
                    />
                    {expanded && (
                      <div className="pl-[26px]">
                        {inside.length === 0 ? (
                          <div className="px-2.5 py-1.5 text-[13px] text-dim">{t("Folder is empty")}</div>
                        ) : (
                          inside.map((c) => (
                            <ChatRow
                              key={c.id}
                              chat={c}
                              active={c.id === activeId}
                              running={chatWorking(c.id, runningChats, workflowChats)}
                              unread={unreadChats.has(c.id)}
                              onOpen={() => open(c.id)}
                              onMenu={(x, y) => openMenu(c, x, y)}
                              tooltip={short.handles(c.id)}
                              tooltipButton={active ? short.buttonHandles(c.id) : undefined}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {/* The chats (ChatGPT "Recents"): a heading with the sort control next to it, only at workspace level; in project focus
              all chats belong to the same project. The sheet lays itself `absolute` OVER the list instead of pushing it down. */}
          {(sections.length > 0 || chats.length === 0 || (listSearch && scopedChats.length === 0)) && (
            <div className="relative mt-4 flex items-center gap-1 px-2.5 pb-1" data-pop="sort">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-dim">{t("Chats")}</span>
              {!focusProjectId && (
                <>
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={sortOpen}
                    onClick={() => setSortOpen((v) => !v)}
                    title={t("Sort")}
                    className={`-mr-1.5 flex max-w-[60%] items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] transition-colors hover:bg-hover hover:text-fg ${sortOpen ? "bg-hover text-fg" : "text-dim"}`}
                  >
                    <span className="truncate">{t(SORTINGS.find((o) => o.key === sortMode)?.label ?? "Recently active")}</span>
                    <span className={`shrink-0 transition-transform duration-200 ${sortOpen ? "rotate-180" : ""}`}><CaretDown /></span>
                  </button>
                  {sortOpen && (
                    <div role="listbox" aria-label={t("Sort")} className="cb-pop-in-fast cb-pop absolute right-1 top-full z-40 mt-1 w-52 origin-top-right rounded-xl p-1.5 text-fg">
                      {SORTINGS.map((o) => {
                        const on = sortMode === o.key;
                        return (
                          <button
                            key={o.key}
                            type="button"
                            role="option"
                            aria-selected={on}
                            onClick={() => { setSortMode(o.key); setSortOpen(false); }}
                            className={`${menuRow} text-[12.5px] ${on ? "text-fg" : "text-dim hover:text-fg"}`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block">{t(o.label)}</span>
                              <span className="block text-[11px] leading-snug text-dim">{t(o.hint)}</span>
                            </span>
                            <span className={`shrink-0 text-accent ${on ? "" : "invisible"}`}><CheckIcon /></span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {chats.length === 0 && visibleFolders.length === 0 && <div className="px-2.5 py-2 text-[13px] text-dim">{t("No chats yet.")}</div>}
          {chats.length > 0 && scopedChats.length === 0 && listSearch && (
            <div className="px-2.5 py-2 text-[13px] text-dim">{t("No chat matches “{q}”.", { q: listSearch.trim() })}</div>
          )}
          {sections.map((sec, si) => (
            <div key={sec.key} className={si > 0 ? "mt-3" : ""}>
              {/* Sub-headings (Pinned/History, per project) one step quieter than "Chats". */}
              {sec.label && (
                <div className="px-2.5 pb-0.5 pt-1 text-[12px] text-dim/80">
                  {t(sec.label)}
                </div>
              )}
              {sec.chats.map((c) => (
                <ChatRow
                  key={c.id}
                  chat={c}
                  active={c.id === activeId}
                  running={chatWorking(c.id, runningChats, workflowChats)}
                  unread={unreadChats.has(c.id)}
                  onOpen={() => open(c.id)}
                  onMenu={(x, y) => openMenu(c, x, y)}
                  tooltip={short.handles(c.id)}
                  tooltipButton={active ? short.buttonHandles(c.id) : undefined}
                />
              ))}
            </div>
          ))}
        </AnimatedSwitch>
    </>
    );
  };

  return (
    <>
      {/* The left card: the docked list AND the rail of the collapsed list in ONE card; its width follows the two animated widths
          inside (the dragged width `listWidth` or 52 px, plus edge), and the gutter behind it (CardsSplit, 3 px frame with the
          three dots) separates it from the conversation and is the handle of its width. The preview below deliberately sits
          OUTSIDE: it floats over the conversation and would be clipped here. */}
      <div className="flex shrink-0 overflow-hidden rounded-[12px] border border-frame-edge bg-bg">
      {/* Chat list, collapsible (width animated, content keeps a fixed width; no transition while dragging) */}
      <div
        className={`flex shrink-0 overflow-hidden ${animReady && !listDrag ? "transition-[width] duration-300 ease-in-out" : ""}`}
        style={{ width: listCollapsed ? 0 : listWidth }}
      >
      {/* `inert` while the variant is invisible (the docked one with the list collapsed, the preview while it is not open): both
          are ALWAYS in the DOM, and their buttons were reachable by Tab, so the ⋯ tooltip appeared next to a foreign row or none.
          Never with the mouse: invisible means width 0 or `pointer-events-none` there. */}
      <aside inert={listCollapsed} className="flex shrink-0 flex-col overflow-hidden bg-bg" style={{ width: listWidth }}>
        {renderList("dock")}
      </aside>
      </div>
      {/* Expand button in a width-animated rail: it grows 0→48 px in sync with the sidebar shrinking (272→0). So the total width
          on the left moves monotonically 272→48; the button reserves its space from the start and nothing "jumps" when it
          appears. The button itself fades in slightly delayed (after the width). Hover shows the list as a peek overlay (click
          expands permanently). */}
      <div className={`flex shrink-0 overflow-hidden ${animReady ? "transition-[width] duration-300 ease-in-out" : ""} ${listCollapsed ? "w-[52px]" : "w-0"}`}>
        {/* The rail of the collapsed list: expand (hover: preview) and a new chat. */}
        <div
          className={`flex min-h-0 w-[52px] shrink-0 flex-col items-center gap-0.5 pt-2.5 ${animReady ? "transition-opacity duration-200" : ""} ${
            listCollapsed ? "opacity-100 delay-150" : "opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={toggleList}
            onMouseEnter={peekOpen}
            onMouseLeave={peekClose}
            title={t("Expand chat list (hover: preview)")}
            aria-label={t("Expand chat list (hover: preview)")}
            tabIndex={listCollapsed ? 0 : -1}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
          >
            <PanelOpenIcon />
          </button>
          <button
            type="button"
            onClick={() => { void createChat(); }}
            title={t("New chat")}
            aria-label={t("New chat")}
            tabIndex={listCollapsed ? 0 : -1}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-hover hover:text-fg"
          >
            <PencilIcon />
          </button>
          {/* One shortcut per chat; hovering shows the tooltip as on a row (components/chat/ChatRail.tsx). */}
          <RailChats
            chats={railChats}
            activeId={activeId}
            working={(id) => chatWorking(id, runningChats, workflowChats)}
            unread={(id) => unreadChats.has(id)}
            handles={short.handles}
            onOpen={(id) => { void open(id); }}
            onMenu={openMenu}
            visible={listCollapsed}
          />
        </div>
      </div>
      </div>
      <CardsSplit
        draggable={!listCollapsed}
        drag={listDrag}
        label={t("Chat list width")}
        title={t("Drag to change the width, double-click to reset")}
        value={listWidth}
        min={LIST_WIDTH_MIN}
        max={LIST_WIDTH_MAX}
        data={{ "data-list-handle": "" }}
        onPointerDown={listHandleDown}
        onPointerMove={listHandleMove}
        onPointerUp={listHandleUp}
        onDoubleClick={listHandleReset}
        onKeyDown={listHandleKey}
      />
      {/* Preview of the collapsed list: slides in when the expand button is hovered. It starts BELOW both rail buttons (10 + 32 + 2
          + 32 = 76 px, plus air): starting at the top edge, it would lie over the button, and the mouseup would hit it instead of
          the button, so a click would never arrive. */}
      <div
        ref={overlayRef}
        style={{ width: listWidth + 8 }}
        className={`pointer-events-none absolute bottom-3 left-2 top-[84px] z-30 flex items-start transition-opacity duration-300 ${
          listCollapsed ? "opacity-100" : "opacity-0"
        }`}
        onMouseEnter={peekOpen}
        onMouseLeave={peekClose}
      >
        <aside
          inert={!((listPeek || menu || folderMenu) && listCollapsed)}
          style={{ width: listWidth }}
          className={`flex max-h-full flex-col overflow-hidden rounded-xl border border-edge bg-bg shadow-card transition-all duration-200 ease-out ${
            // An open context menu (kebab) puts a full-screen backdrop over the peek preview; its mouseleave would close the
            // preview. While a menu is open, the preview therefore stays visible and closes only when the menu is dismissed.
            (listPeek || menu || folderMenu) && listCollapsed ? "pointer-events-auto translate-x-0 opacity-100" : "-translate-x-2 opacity-0"
          }`}
        >
          {renderList("peek")}
        </aside>
      </div>

      <ChatTooltipCard storage={short} content={tooltipContent} loadFresh={freshChat} remeasureAt={scopedChats} />

      {menu && (
        <ChatMenu
          chat={menu.chat}
          x={menu.x}
          y={menu.y}
          projects={workspace.projects}
          // "To folder" shows only folders of the SAME scope: the server would not allow anything else anyway, and a menu with
          // unselectable entries explains nothing.
          folders={folders.filter((f) => (f.projectId ?? null) === (menu.chat.projectId ?? null))}
          onClose={() => setMenu(null)}
          onPin={togglePin}
          onRename={renameChat}
          onFork={forkChat}
          onMove={moveToProject}
          onMoveToFolder={moveToFolder}
          onDelete={deleteChat}
          onNotify={(c) => setNotifyFor(c)}
          onArchived={() => { loadList().catch(console.error); }}
        />
      )}

      {notifyFor && (
        <NotifySheet
          chatId={notifyFor.id}
          title={notifyFor.title}
          choice={notifyFor.notify || {}}
          job={normChatJob(notifyFor.job) !== null}
          onClose={() => setNotifyFor(null)}
          onSaved={(w) => {
            setChats((cs) => cs.map((c) => (c.id === notifyFor.id ? { ...c, notify: w } : c)));
            setNotifyFor((c) => (c ? { ...c, notify: w } : c));
          }}
        />
      )}

      {folderMenu && (
        <FolderMenu
          folder={folderMenu.folder}
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          onNewChat={createChatInFolder}
          onRename={renameFolder}
          onDelete={deleteFolder}
          onArchived={() => { setFolderView((cur) => (cur?.id === folderMenu.folder.id ? null : cur)); loadList().catch(console.error); }}
        />
      )}
    </>
  );
}
