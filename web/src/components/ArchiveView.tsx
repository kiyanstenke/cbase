"use client";

// The archive view in the list column. The normal list shows nothing of it and its search does not search the archive;
// this is its own view.
//
// Archived folders come first, expanded with their chats; below them loose archived chats, each with the name of its (still
// active) folder as a label (`archiveGroups` in the leaf `lib/archive.ts`). Every row carries ⋯ with "Restore" and
// "Delete permanently"; the confirmation names what is lost (on a folder the numbers come from the SERVER,
// `folderDeleteQuestion`; the row may count search hits, the confirmation must not). A click on a chat opens it read-only,
// with the archive bar instead of the input.
//
// Loads on open and on `chat_archive`/`chat_created` (another window, a run that restores) — `chat_archive` is batched
// (`bundler`, 300 ms) unless it concerns the open chat: the first pass of the automatic archive sends one event per chat,
// and each one used to reload the whole archive with folders. After permanently deleting a folder it reports the ids of the
// deleted chats as `CHATS_DELETED` — whoever has one of them open lets go of it.
//
// The "Delete permanently" flow (numbers, confirmation, delete, which ids are gone) lives in `lib/archive.ts`
// (`folderPermanentlyProcedure`); only the effects are here, and the API ways go in UNWRAPPED — a catch with guessed numbers
// ("0 chats will be lost" when all were deleted) or an inverted filter (the survivors were reported) passed the gate.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, loadArchive, deleteFolderPermanently, folderArchivePrecheck, setArchive, setFolderArchive, subscribeGlobalEvents,
  type ArchiveChatEntry, type ChatFolder,
} from "@/lib/api";
import { CHATS_DELETED, archiveEventImmediately, archiveGroups, archiveSearch, archiveRowLabel, bundler, folderPermanentlyProcedure } from "@/lib/archive";
import { dateLocale, useT } from "@/lib/i18n";
import { useConfirm } from "@/components/Prompts";
import { BackButton, Chevron, DotsIcon, Menu, MenuEntry, MenuSeparator, Search } from "@/components/CbKit";

export function ArchiveView({
  kind, workspaceId, activeId, onOpen, onBack, onChanged, projectId = null, deleteChat,
}: {
 kind: "normal"; // only Coding remains
  workspaceId: string;
  activeId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  /** After restore/delete: reload the normal list. */
  onChanged: () => void;
  /** Entered project (Coding): only its chats and folders — like the normal list. */
  projectId?: string | null;
  /** The page's delete way (confirmation, cache, draft, open chat) — without it the view asks itself. */
  deleteChat?: (chat: ArchiveChatEntry) => Promise<unknown>;
}) {
  const t = useT();
  const question = useConfirm();
  const [status, setStatus] = useState<{ chats: ArchiveChatEntry[]; folder: ChatFolder[] } | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  // The UNFILTERED state (no project, no search): which chats a folder held before deletion.
  const raw = useRef<{ chats: ArchiveChatEntry[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await loadArchive(workspaceId, kind);
      raw.current = r;
      setStatus(projectId
        ? { chats: r.chats.filter((c) => c.projectId === projectId), folder: r.folder.filter((o) => o.projectId === projectId) }
        : r);
      setError("");
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [workspaceId, kind, projectId]);
  useEffect(() => { load().catch(console.error); }, [load]);
  const loadRef = useRef(load);
  loadRef.current = load;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const [reload] = useState(() => bundler(() => { loadRef.current().catch(console.error); }));
  useEffect(() => () => reload.abort(), [reload]);
  useEffect(() => subscribeGlobalEvents((evt) => {
    const m = evt as { type?: string; workspaceId?: string; kind?: string; chatIds?: string[] };
    if (m.type === "chat_archive" && m.workspaceId === workspaceId && m.kind === kind) {
      if (archiveEventImmediately(m.chatIds, activeRef.current)) reload.immediately(); else reload.nudge();
    } else if (m.type === "chat_created" && (!m.workspaceId || m.workspaceId === workspaceId)) load().catch(console.error);
  }), [load, workspaceId, kind, reload]);

  const groups = useMemo(() => archiveSearch(search, archiveGroups(status?.chats ?? [], status?.folder ?? [])), [status, search]);
  const empty = status !== null && groups.folder.length === 0 && groups.loose.length === 0;

  const after = async () => { await load(); onChanged(); };
  async function fetchBack(kindName: "chat" | "folder", id: string) {
    try {
      if (kindName === "chat") await setArchive(id, false);
      else await setFolderArchive(id, false);
    } catch (e) { setError((e as Error).message); return; }
    await after();
  }
  async function deleteEntry(c: ArchiveChatEntry) {
    if (deleteChat) await deleteChat(c);
    else {
      if (!(await question(t("Delete chat \"{title}\" permanently? History, artifacts and attachments will be lost.", { title: c.title || t("Untitled") }), { ok: t("Delete permanently"), danger: true }))) return;
      try { await api(`/api/chats/${encodeURIComponent(c.id)}`, { method: "DELETE" }); }
      catch (e) { setError((e as Error).message); return; }
    }
    await after();
  }
  // The confirmation's numbers come from the SERVER — `chats` is the same set the DELETE deletes, the context files
  // that go along. NEVER from this view's group: it is filtered by search (for "invoice" the confirmation named 1 chat, 3 were
  // deleted). Without a number no delete — retry. `r.ids` is what stood in the folder before and is no longer in the archive
  // after reload (a foreign chat is only detached by the server). Reported BEFORE `onChanged` — the list then reloads
  // without the open conversation.
  async function deleteFolder(o: ChatFolder) {
    let r;
    try {
      r = await folderPermanentlyProcedure(o, {
        counts: folderArchivePrecheck,
        question: (text) => question(text, { ok: t("Delete permanently"), danger: true }),
        erase: deleteFolderPermanently,
        prior: () => (raw.current?.chats ?? []).filter((c) => c.folderId === o.id).map((c) => c.id),
        loadAgain: load,
        t,
      });
    } catch (e) { setError((e as Error).message); return; }
    if (r.status === "without-counts") { setError(t("The numbers for the confirmation could not be loaded — nothing was deleted. Please try again.")); return; }
    if (r.status !== "deleted") return;
    if (r.ids.length) window.dispatchEvent(new CustomEvent<string[]>(CHATS_DELETED, { detail: r.ids }));
    onChanged();
  }

  const datum = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString(dateLocale(), { day: "2-digit", month: "2-digit" }) : "");
  const rowMenu = (onBackFetch: () => void, onDelete: () => void, id: string) => (
    <Menu
      label={t("More")}
      width={200}
      button={{
        content: <DotsIcon />,
        className: "grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:bg-hover aria-expanded:opacity-100",
        data: { "data-archive-pop": id },
      }}
    >
      <MenuEntry label={t("Restore")} onClick={onBackFetch} data={{ "data-archive-restore": id }} />
      <MenuSeparator />
      <MenuEntry label={t("Delete permanently")} danger onClick={onDelete} data={{ "data-archive-delete": id }} />
    </Menu>
  );
  // The gray row: the loose chat's folder and "archived automatically" when the tick put it away (`archiveRowLabel`).
  const chatRow = (c: ArchiveChatEntry, folderName: string, indented: boolean) => {
    const label = archiveRowLabel(folderName, c.archiveReason, t);
    return (
    <div
      key={c.id}
      data-archive-row={c.id}
      onClick={() => onOpen(c.id)}
      className={`group flex cursor-pointer items-center gap-2 rounded-lg py-[7px] pr-1 transition-colors ${indented ? "pl-7" : "pl-2.5"} ${
        activeId === c.id ? "bg-edge" : "hover:bg-hover"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${activeId === c.id ? "font-medium text-fg" : "text-fg/85"}`}>{c.title || t("Untitled")}</span>
        {label && <span className="block truncate text-[11px] text-dim">{label}</span>}
      </span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-dim group-hover:hidden">{datum(c.archivedAt)}</span>
      {/* The ⋯ swallows the click: a menu is not an open of the row. */}
      <span onClick={(e) => e.stopPropagation()}>
        {rowMenu(() => { void fetchBack("chat", c.id); }, () => { void deleteEntry(c); }, c.id)}
      </span>
    </div>
    );
  };

  return (
    <div data-archive-view={kind} className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-2 pb-1 pt-2.5">
        <div className="flex items-center gap-1">
          <span data-archive-back><BackButton label={t("Back")} onClick={onBack} /></span>
          <span className="flex-1" />
          <span className="pr-2 text-[12.5px] font-semibold">{t("Archive##noun")}</span>
        </div>
        <div className="mt-1.5" data-archive-search>
          <Search value={search} onChange={setSearch} placeholder={t("Search the archive…")} />
        </div>
      </header>
      <div className="cb-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {error && <div className="px-2.5 py-1.5 text-[11.5px] text-danger">{error}</div>}
        {status === null && !error && <div className="px-2.5 py-2 text-[12px] text-dim">{t("Loading…")}</div>}
        {groups.folder.map(({ folder: o, chats }) => {
          const open = !closed.has(o.id);
          return (
            <div key={o.id} className="mt-1">
              <div
                data-archive-folder={o.id}
                onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}
                className="group flex cursor-pointer items-center gap-1.5 rounded-lg py-1 pl-2.5 pr-1 text-[12px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg"
              >
                <Chevron open={open} size={11} />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="shrink-0 tabular-nums group-hover:hidden">{chats.length}</span>
                <span onClick={(e) => e.stopPropagation()}>
                  {rowMenu(() => { void fetchBack("folder", o.id); }, () => { void deleteFolder(o); }, o.id)}
                </span>
              </div>
              {open && chats.map((c) => chatRow(c, "", true))}
              {open && chats.length === 0 && <div className="py-1 pl-7 text-[11.5px] text-dim">{t("Folder is empty")}</div>}
            </div>
          );
        })}
        {groups.loose.length > 0 && groups.folder.length > 0 && <div className="mx-2.5 my-2 border-t border-edge" />}
        {groups.loose.map(({ chat, label }) => chatRow(chat, label, false))}
        {empty && (
          <div className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-dim">
            {search.trim() ? t("Nothing in the archive matches the search.") : t("Nothing archived.")}
          </div>
        )}
      </div>
    </div>
  );
}
