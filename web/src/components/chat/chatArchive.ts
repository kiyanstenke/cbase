// The archive in the coding chat as a hook:
// `useArchive(…)` → `{ archived, archivedAt, archiveChat, archive, restore, openTarget, holdOpen }`.
// It holds EVERY open chat the list does not carry, including the empty, just-created one (the server shows it only after
// the first message); `holdOpen` sets it from the answer of the POST. ChatPane sits near the 2,000-line guard: only the
// wiring stays there, everything else is here.
//
// - An archived chat is NOT in the list (`/api/chats` returns only active ones). The hook fetches its metadata (title,
//   project, `archivedAt`) once via `GET /api/chats/:id` (`archiveChat`); ChatPane reads `activeChat = chats.find(…) ??
//   archiveChat`.
// - `archive`/`restore` set immediately after their own 200 (metadata from the answer, list reloaded), without waiting for
//   the event. Before archiving, `draft.flush()` saves the last typed state; the draft stays under its key and is back in
//   the composer after restoring.
// - `chat_archive` (ONE broadcast) reloads the list and, if it concerns the open chat, its metadata: a second window shows the
//   bar without reload, a run that restores gives the composer back. It is BUNDLED when it does not concern the open chat:
//   the first pass of the automatic archive sends one event per chat, and each would reload chats and folders
//   (`archiveEventImmediately`, `bundler` in lib/archive.ts, 300 ms like `afterRunTimer` in ChatPane). If it concerns the
//   open one, it acts immediately (bar, composer).
// - `openTarget(id, list, way?)`: every route that opens by id (`?chat=`, the saved preselection, the event
//   `cbase-open-chat` from bell, channel bar, workflow runs and the archive view) also opens an archived chat: same
//   workspace, kind `normal` (`archiveTargetMatches` in lib/archive.ts). Only the preselection checks the project (address
//   and event also open an ACTIVE chat in any project). The metadata stand BEFORE switching (`setMeta` before `open`):
//   otherwise the composer with its draft would show for one fetch, and an Enter would run into the write lock. The same
//   holds for the CHILD chat of a background run (`parentChatId`): not archived, in no list; metadata before switching, the
//   composer stays open (`archived` asks only `archivedAt`).
// - `CHATS_DELETED`: an archived folder was removed for good (archive view); for each deleted id the hook calls `chatAway`
//   from ChatPane (cache, terminal layout, draft, and the open chat closes), as after deleting a single chat. The server
//   reports a deletion to no window; a SECOND window learns of it through the recheck (next point).
// - Recheck: a second window would keep the deleted archived chat with its bar until it reloaded, and "Restore" would end in
//   404. The hook therefore rechecks the open ARCHIVED chat (`recheckArchive`: on open, every 15 s while the page is
//   visible, and on window focus); 404 ⇒ `chatAway`, as after one's own deletion. A network error is "unknown", never "gone".
// - `openTarget` takes its marker AT THE MOMENT OF THE CALL (`lastWins`) and also accepts the list as a promise: clicking X,
//   then Y in the archive view must not end with X open if X's fetches arrive later. The last wish wins (and any other
//   switch in between): an older one switches nothing any more.
// - A wish for the OPEN chat (`way.openId`/`alreadyOpen`, git overview) opens nothing anew: the receiver of `cbase-open-chat`
//   (ChatPane) passes `activeIdRef.current`, and `openTargetProcedure` compares: ONE place for all senders. A waiting jump
//   "agent in the chat" (chatAgentJump.ts) is then served directly: its chat is already loaded.
//
// The event name `"chat_archive"` stands here as a literal: `web/test/archive.test.mjs` holds it against the server
// (`runs/archive.js`) and the iOS shell.
import { useCallback, useEffect, useRef, useState } from "react";
import { loadArchiveChat, setArchive, subscribeGlobalEvents, type Chat } from "@/lib/api";
import { CHATS_DELETED, archiveEventImmediately, recheckArchive, bundler, lastWins, openTargetProcedure } from "@/lib/archive";

export type ArchiveDeps = {
  wsId: string;
  focusProjectId: string | null;
  activeId: string | null;
  chats: Chat[];
  loadList: () => Promise<Chat[]>;
  open: (id: string) => Promise<void>;
  draft: { flush: () => void };
  /** What a deleted chat leaves behind in ChatPane, cleaned up, and the open one closed. */
  chatAway: (id: string) => void;
};

export function useArchive(deps: ArchiveDeps) {
  const { activeId, chats } = deps;
  // The callbacks run after the render (click, event) and read the state of THIS render through the ref; `open` is a function
  // per render in ChatPane, a captured state would be stale.
  const d = useRef(deps);
  d.current = deps;
  const [meta, setMeta] = useState<Chat | null>(null);
  const inList = activeId ? chats.some((c) => c.id === activeId) : false;

  // If the open chat is not in the list, its metadata come from the server, fresh on every switch so that an earlier fetched
  // state (other window, restored in between) does not stay. 404: it no longer exists (another window deleted it); `chatAway` closes it.
  const recheck = useCallback(async (id: string, alive: () => boolean = () => true) => {
    const n = await recheckArchive(id, loadArchiveChat);
    if (!alive() || d.current.activeId !== id) return null;
    if (n.state === "deleted") d.current.chatAway(id);
    else if (n.chat) setMeta(n.chat);
    return n.state;
  }, []);
  useEffect(() => {
    if (!activeId || inList) return;
    let alive = true;
    recheck(activeId, () => alive).catch(console.error);
    return () => { alive = false; };
  }, [activeId, inList, recheck]);
  // Since the server shows EMPTY chats in no list, the open, just-created chat also stands here while it has no message (an
  // attachment creates it). A PATCH from header or picker (model, level, permissions, instance) then reloads the LIST, which
  // does not carry it, so every reload of the list pulls its metadata after; otherwise header and picker would show the state
  // from opening. Only the own trigger (`chats`), not the switch (above).
  useEffect(() => {
    const id = d.current.activeId;
    if (!id || chats.some((c) => c.id === id)) return;
    let alive = true;
    recheck(id, () => alive).catch(console.error);
    return () => { alive = false; };
  }, [chats, recheck]);
  // While an ARCHIVED chat is open: every 15 s while the page is visible and on window focus.
  const archiveOpenId = !inList && activeId && meta?.id === activeId && meta.archivedAt != null ? activeId : null;
  useEffect(() => {
    if (!archiveOpenId) return;
    // Restored elsewhere and the event missed ("back"): reload the list, where it stands again.
    const check = () => {
      if (document.visibilityState !== "visible") return;
      recheck(archiveOpenId).then((s) => { if (s === "back") d.current.loadList().catch(console.error); }).catch(console.error);
    };
    const iv = setInterval(check, 15_000);
    window.addEventListener("focus", check);
    return () => { clearInterval(iv); window.removeEventListener("focus", check); };
  }, [archiveOpenId, recheck]);

  // Reload list and folders bundled, unless the event concerns the open chat (then immediately, with metadata).
  const [reload] = useState(() => bundler(() => { d.current.loadList().catch(console.error); }));
  useEffect(() => () => reload.abort(), [reload]);
  useEffect(() => subscribeGlobalEvents((evt) => {
    const m = evt as { type?: string; workspaceId?: string; kind?: string; chatIds?: string[] };
    if (m.type !== "chat_archive" || m.kind !== "normal" || m.workspaceId !== d.current.wsId) return;
    const a = d.current.activeId;
    if (!a || !archiveEventImmediately(m.chatIds, a)) { reload.nudge(); return; }
    reload.immediately();
    loadArchiveChat(a).then((c) => { if (c && d.current.activeId === a) setMeta(c); }).catch(console.error);
  }), [reload]);

  useEffect(() => {
    const onDeleted = (e: Event) => { for (const id of (e as CustomEvent<string[]>).detail ?? []) d.current.chatAway(id); };
    window.addEventListener(CHATS_DELETED, onDeleted);
    return () => window.removeEventListener(CHATS_DELETED, onDeleted);
  }, []);

  const archive = useCallback(async (opts: { dismissQuestion?: boolean } = {}) => {
    const id = d.current.activeId;
    if (!id) return;
    d.current.draft.flush();
    const r = await setArchive(id, true, opts);
    setMeta(r.chat);
    await d.current.loadList();
  }, []);

  const restore = useCallback(async () => {
    const id = d.current.activeId;
    if (!id) return;
    const r = await setArchive(id, false);
    setMeta(r.chat);
    await d.current.loadList();
  }, []);

  // If the id is in the list, it is an ordinary open. Otherwise, if the chat exists, is archived and belongs here
  // (`archiveTargetMatches`), it is opened (with bar). 404 and any other error mean "not opened"; the caller falls back to
  // its next route, and an error triggers no further switch. `way.projectCheck: false` (address, event): the project does not
  // count, as for an active chat. `way.openOtherwise` (event `cbase-open-chat`): what does not fit opens anyway. The metadata
  // come BEFORE switching; `open` sets `activeId` synchronously, both arrive in ONE render. The marker applies from THIS call;
  // `list` may be a promise (the caller calls here before loading the list). A younger call or another switch of the open chat
  // in between makes this one ineffective.
  const turns = useRef(lastWins());
  const openTarget = useCallback(async (id: string, list: Chat[] | Promise<Chat[]>, opts: { projectCheck?: boolean; openOtherwise?: boolean; openId?: string | null; alreadyOpen?: () => void } = {}) => {
    const marker = turns.current();
    const { wsId, focusProjectId, open, activeId: prior } = d.current;
    return openTargetProcedure(id, list, {
      applies: () => marker() && d.current.activeId === prior,
      loadChat: loadArchiveChat, setMeta: setMeta, open: open, wsId,
      project: opts.projectCheck === false ? null : focusProjectId, openOtherwise: opts.openOtherwise, openId: opts.openId ?? null, alreadyOpen: opts.alreadyOpen,
    });
  }, []);

  // The chat `ensureChat` just created (answer of the POST), held BEFORE switching like an archived chat's metadata: otherwise
  // a chat without settings would stand there until the recheck answers, and header, model, level and project choice would
  // jump to the defaults and back for one fetch.
  const holdOpen = useCallback((c: Chat) => setMeta(c), []);

  // `archiveChat` is every open chat the list does not carry: archived (read-only, with bar), child chat of a graph run, or
  // still empty; `archived` asks only `archivedAt`.
  const archiveChat: Chat | undefined = !inList && activeId && meta?.id === activeId ? meta : undefined;
  return {
    archived: archiveChat?.archivedAt != null,
    archivedAt: archiveChat?.archivedAt ?? null,
    archiveChat,
    archive,
    restore,
    openTarget,
    holdOpen,
  };
}
