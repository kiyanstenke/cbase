import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Chat, type ChatFolder, type Project, normChatJob } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { NotifyMarker } from "@/components/NotifySheet";
import { chatMarker } from "@/lib/notify";
import { BubblePlusIcon, CheckIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, FolderSolidIcon, ForkIcon, CbIcon, KebabIcon, PencilIcon, PinIcon, TrashIcon } from "@/components/chat/ChatIcons";
import { ArchiveEntry } from "@/components/ArchiveEntry";
import { MenuSeparator, menuHeader, menuSymbol, menuRow, menuRowDanger } from "@/components/CbKit";
import type { TooltipHandles, TooltipButtonHandles } from "@/components/chat/ChatTooltip";

/** The clock on the row of a job chat: the same icon as the "Scheduled" tab (app/workspaces/page.tsx `TabIcon`). */
const ClockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
  </svg>
);

// ── Grouping of the chat list ──────────────────────────────────────────────────
interface Section {
  key: string;
  label: string;
  chats: Chat[];
}

function buildSections(chats: Chat[], mode: "recent" | "project", projects: Project[]): Section[] {
  const byDate = (a: Chat, b: Chat) => b.updatedAt - a.updatedAt;
  const pinnedFirst = (a: Chat, b: Chat) => Number(b.pinned) - Number(a.pinned) || byDate(a, b);

  if (mode === "recent") {
    const pinned = chats.filter((c) => c.pinned).sort(byDate);
    const rest = chats.filter((c) => !c.pinned).sort(byDate);
    const secs: Section[] = [];
    if (pinned.length) secs.push({ key: "pinned", label: "Pinned", chats: pinned });
    if (rest.length) secs.push({ key: "recent", label: pinned.length ? "History" : "", chats: rest });
    return secs;
  }

  // Grouped by project. A chat whose project no longer exists (deleted, the chat outlived it: legacy data) goes under
  // "No project" instead of in no section, so it does not vanish from the list.
  // `projects` is the project list of the loaded workspace (ChatListPane: workspace.projects), never a half-loaded state.
  const secs: Section[] = [];
  const known = new Set(projects.map((p) => p.id));
  for (const p of projects) {
    const cs = chats.filter((c) => c.projectId === p.id).sort(pinnedFirst);
    if (cs.length) secs.push({ key: p.id, label: p.name, chats: cs });
  }
  const none = chats.filter((c) => !c.projectId || !known.has(c.projectId)).sort(pinnedFirst);
  if (none.length) secs.push({ key: "none", label: "No project", chats: none });
  return secs;
}

function ChatRow({
  chat,
  active,
  running,
  unread,
  onOpen,
  onMenu,
  tooltip,
  tooltipButton,
}: {
  chat: Chat;
  active: boolean;
  running: boolean;
  unread: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  /** The list's tooltip (components/chat/ChatTooltip.tsx): pointer and press on the row, focus on the ⋯. Only the VISIBLE
   *  variant of the list (docked or preview) gets the keyboard handles (`tooltipButton`): the other one sits invisibly in
   *  the DOM, and its ⋯ would show the card next to a foreign row or none via Tab. */
  tooltip: TooltipHandles;
  tooltipButton?: TooltipButtonHandles;
}) {
  const t = useT();
  const job = normChatJob(chat.job);
  // Hover marquee: if the title overflows, it slides left on hover (speed ~ length) and eases back on leave. At rest it
  // keeps the ellipsis (…).
  const clipRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [marquee, setMarquee] = useState(false);
  const runMarquee = () => {
    const clip = clipRef.current, inner = innerRef.current;
    if (!clip || !inner) return;
    const overflow = inner.scrollWidth - clip.clientWidth;
    if (overflow <= 2) return; // fits anyway → nothing to do
    setMarquee(true);
    const dur = Math.min(6, Math.max(1.2, overflow / 45)); // ~45 px/s, capped
    inner.style.transition = `transform ${dur}s linear`;
    inner.style.transform = `translateX(-${overflow}px)`;
  };
  const startMarquee = () => {
    if (delayRef.current) clearTimeout(delayRef.current);
    delayRef.current = setTimeout(runMarquee, 500); // only after hovering 0.5 s
  };
  const stopMarquee = () => {
    if (delayRef.current) { clearTimeout(delayRef.current); delayRef.current = null; }
    setMarquee(false);
    const inner = innerRef.current;
    if (inner) { inner.style.transition = "transform 0.35s ease"; inner.style.transform = "translateX(0)"; }
  };
  return (
    <div
      data-tooltip-row={chat.id}
      onClick={onOpen}
      onMouseEnter={startMarquee}
      onMouseLeave={stopMarquee}
      onPointerEnter={tooltip.onPointerEnter}
      onPointerLeave={tooltip.onPointerLeave}
      onMouseDown={tooltip.onMouseDown}
      onContextMenu={(e) => {
        e.preventDefault();
        tooltip.onContextMenu();
        onMenu(e.clientX, e.clientY);
      }}
      // One line, no little box. The active chat is filled neutrally (`edge`), not with the accent: `edge` is the right step in
      // both themes, and the accent stays reserved for signals (run, unread, focus, send). Sized like the ChatGPT sidebar: 14 px,
      // 36 px high, titles flush left. The working indicator sits LEFT before the title: only a row that is working or has
      // unread content indents its title; pin, clock and notification mark stay on the right.
      className={`group relative flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors ${active ? "bg-edge" : "hover:bg-hover"}`}
    >
      {/* Working indicator: running → spinning hexagon; finished, unread reply → glowing hexagon. No `title`: the row's tooltip
          says what it means, and two hints on top of each other would be one too many. It does not yield on hover: the ⋯ is on
          the right. */}
      {(running || unread) && (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-accent">
          {running ? (
            <span className="inline-flex animate-[spin_2.6s_linear_infinite]" data-row-running>
              <CbIcon size={13} />
            </span>
          ) : (
            <span className="inline-flex drop-shadow-[0_0_4px_currentColor]">
              <CbIcon size={13} filled />
            </span>
          )}
        </span>
      )}
      {/* The title fades out to the right (`cb-fade-r`) instead of ending in "…", and the fade is dropped during the hover
          marquee, otherwise the end of the title would stay blurred. */}
      <span
        ref={clipRef}
        className={`min-w-0 flex-1 overflow-hidden text-[14px] leading-5 ${marquee ? "" : "cb-fade-r"} ${active ? "text-fg" : "text-fg/90"}`}
      >
        <span ref={innerRef} className="block whitespace-nowrap will-change-transform">
          {chat.title}
        </span>
      </span>
      {/* Pinned → pin, on the right; on hover it yields to the ⋯. */}
      {chat.pinned && (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-dim transition-opacity group-hover:opacity-0">
          <PinIcon />
        </span>
      )}
      {/* The clock of a job chat (Coding → Scheduled): fed from `job` of GET /api/chats; the next occurrence is in the row's
          tooltip. Dimmed when the job is paused or done. */}
      {job && (
        <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center transition-opacity group-hover:opacity-0 ${job.status === "active" ? "text-fg/70" : "text-dim/60"}`}
          data-row-job={job.status ?? ""}>
          <ClockIcon />
        </span>
      )}
      <NotifyMarker marker={chatMarker(chat.notify)} className="group-hover:opacity-0" />
      <button
        onFocus={tooltipButton?.onFocus}
        onBlur={tooltipButton?.onBlur}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(r.right, r.bottom + 4);
        }}
        // No `title`: the row's tooltip sits above the ⋯, and the native hint "More" would fall into it after a second.
        // Screen readers read the `aria-label`.
        aria-label={t("More")}
        className={`absolute right-1 grid h-6 w-6 place-items-center rounded-md text-dim opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 ${active ? "bg-edge" : "bg-hover"}`}
      >
        <KebabIcon />
      </button>
    </div>
  );
}

// Folder row of the chat list (sized like the ChatGPT sidebar): folder icon and name, no count. The icon shows open/closed; on
// hover the arrow replaces it, saying the row expands. The list renders the chats inside itself, indented to the name.
function FolderRow({
  folder,
  expanded,
  projectName,
  hasActive,
  running,
  unread,
  onToggle,
  onOpen,
  onMenu,
}: {
  folder: ChatFolder;
  expanded: boolean;
  projectName: string | null;
  hasActive: boolean;
  running: boolean;
  unread: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();
  return (
    <div
      // Two targets in one row, like a file manager: the ARROW expands the chats below, the NAME opens the folder itself
      // (context + artifacts). The rest of the row expands, the more common intent.
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={projectName ? t("Folder · project {name}", { name: projectName }) : t("Folder")}
      className={`group relative flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
        hasActive && !expanded ? "bg-edge" : "hover:bg-hover"
      }`}
    >
      <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <span className={`inline-flex transition-opacity group-hover:opacity-0 ${running || unread ? "text-accent" : "text-fg/75"}`}>
          {expanded ? <FolderOpenIcon /> : <FolderIcon />}
        </span>
        <span className={`absolute inset-0 grid place-items-center text-dim opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-100 ${expanded ? "rotate-90" : ""}`}>
          <ChevronRightIcon />
        </span>
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        title={t("Open folder (context and artifacts)")}
        className="min-w-0 flex-1 truncate text-left text-[14px] leading-5 text-fg/90 hover:text-fg"
      >
        {folder.name}
      </button>
      {projectName && (
        <span className="max-w-[84px] shrink-0 truncate text-[12px] text-dim transition-opacity group-hover:opacity-0">{projectName}</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(r.right, r.bottom + 4);
        }}
        title={t("More")}
        aria-label={t("More")}
        className={`absolute right-1 grid h-6 w-6 place-items-center rounded-md text-dim opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 ${hasActive && !expanded ? "bg-edge" : "bg-hover"}`}
      >
        <KebabIcon />
      </button>
    </div>
  );
}

// Context menu of a folder: same language as the chat menu.
function FolderMenu({
  folder,
  x,
  y,
  onClose,
  onNewChat,
  onRename,
  onDelete,
  onArchived,
}: {
  folder: ChatFolder;
  x: number;
  y: number;
  onClose: () => void;
  onNewChat: (f: ChatFolder) => void;
  onRename: (f: ChatFolder) => void;
  onDelete: (f: ChatFolder) => void;
  /** Archive: reload the list after archiving. */
  onArchived: () => void;
}) {
  const t = useT();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if (e.key === "Escape") onClose();
      else if (k === "n") { onClose(); onNewChat(folder); }
      else if (k === "r") { onClose(); onRename(folder); }
      else if (k === "d") { onClose(); onDelete(folder); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [folder, onClose, onNewChat, onRename, onDelete]);

  // Via portal on the body: the coordinates are window coordinates (clientX/Y), and the page's content area is a `@container`,
  // where `fixed` would refer to IT.
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="cb-pop cb-flat cb-pop-in-fast fixed z-50 w-[224px] rounded-xl p-1.5 text-[13px] text-fg"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`${menuHeader} truncate`}>{folder.name}</div>
        <MenuItem
          icon={<BubblePlusIcon />}
          label={t("New chat in folder")}
          shortcut="N"
          onClick={() => { onClose(); onNewChat(folder); }}
        />
        <MenuItem
          icon={<PencilIcon />}
          label={t("Rename")}
          shortcut="R"
          onClick={() => { onClose(); onRename(folder); }}
        />
        {/* Archive with content: the entry pre-checks, names open items, and then locks itself. */}
        <ArchiveEntry target={{ kind: "folder", id: folder.id }} icon prior={onClose} after={onArchived} />
        <MenuSeparator />
        <MenuItem
          icon={<TrashIcon />}
          label={t("Delete folder")}
          shortcut="D"
          danger
          onClick={() => { onClose(); onDelete(folder); }}
        />
      </div>
    </>,
    document.body,
  );
}

function BellSmallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

// ── Context menu of the chat row: glass (`cb-pop`), icons left, shortcuts right ──
function ChatMenu({
  chat,
  x,
  y,
  projects,
  folders,
  onClose,
  onPin,
  onRename,
  onFork,
  onMove,
  onMoveToFolder,
  onDelete,
  onNotify,
  onArchived,
}: {
  chat: Chat;
  x: number;
  y: number;
  projects: Project[];
  folders: ChatFolder[];
  onClose: () => void;
  onPin: (c: Chat) => void;
  onRename: (c: Chat) => void;
  onFork: (c: Chat) => void;
  onMove: (c: Chat, projectId: string | null) => void;
  onMoveToFolder: (c: Chat, folderId: string | null) => void;
  onDelete: (c: Chat) => void;
  onNotify: (c: Chat) => void;
  /** Archive: reload the list after archiving. */
  onArchived: () => void;
}) {
  const t = useT();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if (e.key === "Escape") onClose();
      else if (k === "p") { onPin(chat); onClose(); }
      else if (k === "r") { onClose(); onRename(chat); }
      else if (k === "f" && chat.provider !== "codex") { onClose(); onFork(chat); } // fork only for Claude
      else if (k === "d") { onClose(); onDelete(chat); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat, onClose, onPin, onRename, onFork, onDelete]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      {/* No `overflow-hidden` on the sheet: the submenus (project, folder) open sideways and must be allowed past the edge. */}
      <div
        className="cb-pop cb-flat cb-pop-in-fast fixed z-50 w-[220px] rounded-xl p-1.5 text-[13px] text-fg"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <MenuItem
          icon={<PinIcon />}
          label={chat.pinned ? t("Unpin") : t("Pin")}
          shortcut="P"
          onClick={() => { onPin(chat); onClose(); }}
        />
        <MenuItem
          icon={<PencilIcon />}
          label={t("Rename")}
          shortcut="R"
          onClick={() => { onClose(); onRename(chat); }}
        />
        <MenuItem
          icon={<BellSmallIcon />}
          label={t("Notifications…")}
          onClick={() => { onClose(); onNotify(chat); }}
        />
        {chat.provider !== "codex" && (
          <MenuItem
            icon={<ForkIcon />}
            label={t("Fork")}
            shortcut="F"
            onClick={() => { onClose(); onFork(chat); }}
          />
        )}
        {/* `my-0.5`: the gap between two menu rows hangs on the sibling selector (`.cb-menu-row + …`), and the submenu wrapper
            interrupts it, so it holds the 2 px itself (the margins collapse).
            `pl-2.5`: the wrapper ends 6 px before the sheet's edge (`p-1.5`); with `pl-1` the submenu would sit 2 px OVER the
            sheet instead of 4 px beside it; `min-w-[196px]` keeps the submenu's width (border-box). */}
        <div className="group relative my-0.5">
          <MenuItem icon={<FolderIcon />} label={t("To project")} trailing={<ChevronRightIcon />} />
          <div className="absolute left-full top-0 hidden min-w-[196px] pl-2.5 group-hover:block">
            <div className="cb-pop cb-scroll max-h-[260px] overflow-y-auto rounded-xl p-1.5">
              <MenuItem
                label={t("No project")}
                trailing={!chat.projectId ? <CheckIcon /> : null}
                onClick={() => { onMove(chat, null); onClose(); }}
              />
              {projects.length > 0 && <MenuSeparator />}
              {projects.map((p) => (
                <MenuItem
                  key={p.id}
                  label={p.name}
                  trailing={chat.projectId === p.id ? <CheckIcon /> : null}
                  onClick={() => { onMove(chat, p.id); onClose(); }}
                />
              ))}
            </div>
          </div>
        </div>
        {/* To folder: only folders of the same scope (workspace chat → workspace folder, project chat → its project's folder).
            Chats of a folder share their artifacts. */}
        <div className="group relative my-0.5">
          <MenuItem icon={<FolderSolidIcon />} label={t("To folder")} trailing={<ChevronRightIcon />} />
          <div className="absolute left-full top-0 hidden min-w-[196px] pl-2.5 group-hover:block">
            <div className="cb-pop cb-scroll max-h-[260px] overflow-y-auto rounded-xl p-1.5">
              <MenuItem
                label={t("No folder")}
                trailing={!chat.folderId ? <CheckIcon /> : null}
                onClick={() => { onMoveToFolder(chat, null); onClose(); }}
              />
              {folders.length > 0 && <MenuSeparator />}
              {folders.map((f) => (
                <MenuItem
                  key={f.id}
                  label={f.name}
                  trailing={chat.folderId === f.id ? <CheckIcon /> : null}
                  onClick={() => { onMoveToFolder(chat, f.id); onClose(); }}
                />
              ))}
              {folders.length === 0 && (
                <div className="px-2.5 py-1.5 text-[12px] text-dim">{t("No folders yet.")}</div>
              )}
            </div>
          </div>
        </div>
        {/* Archive: pre-check on display, reasons in grey below, only an open question allows it. */}
        <ArchiveEntry target={{ kind: "chat", id: chat.id }} icon prior={onClose} after={onArchived} />
        <MenuSeparator />
        <MenuItem
          icon={<TrashIcon />}
          label={t("Delete")}
          shortcut="D"
          danger
          onClick={() => { onClose(); onDelete(chat); }}
        />
      </div>
    </>,
    document.body,
  );
}

function MenuItem({
  icon,
  label,
  shortcut,
  trailing,
  danger,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  shortcut?: string;
  trailing?: React.ReactNode;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      {...(danger ? { "data-danger": "" } : {})}
      className={`${danger ? menuRowDanger : `${menuRow} text-fg`} text-[12.5px]`}
    >
      <span aria-hidden className={menuSymbol}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && <span className="text-[11px] text-dim">{shortcut}</span>}
      {trailing && <span className="text-dim">{trailing}</span>}
    </button>
  );
}
export { ChatMenu, ChatRow, FolderMenu, FolderRow, buildSections };
