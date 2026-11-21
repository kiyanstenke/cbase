// "New chat" = draft in the coding chat, as a hook: `useNewChat(…)` → `{ newChat, draftFolder }`.
//
// Every entry point "New chat" (row and sheet "New chat in …" in ChatListPane, "+" of the collapsed list, folder menu with
// key N (ChatListRows → `createChatInFolder`), and "Start chat" on an instance (tab "Instances", via the window event
// `NEW_CHAT_EVENT`)) opens the EMPTY view, without a POST. The draft is the hero that already existed (`activeId === null`):
// its preselection (project, folder, provider/model/level/ultracode, permissions, instance) lives in ChatPane and in the
// hooks `useModelChoice`/`useChatInstance`, and `ensureChat` creates the chat on first send (or attach) with EXACTLY these
// values. Here stands only what an entry point changes in that preselection (`draftPreselection`, lib/chat-draft.ts), and
// that it closes the open chat (`toDraft`, ChatPane: the same clean-up as in `open()`, which touches twenty states).
//
// Trap: the folder and instance entry points write into the SAME preselection as the sheet, and it stayed after creation, so
// a later plain "New chat" (row, "+") landed in folder X again, in its project and in the previous entry's copy. A plain
// entry therefore starts without a folder and in main, and takes the project back from its own preselection: the `lane`
// (what a folder or instance entry overwrote) is kept by the hook from entry to entry and forgotten on workspace and project
// switch (ChatPane resets the preselection there anyway).
//
// Why the folder is returned: the hero never showed it (the sheet "New chat in …" set it silently). Since "new chat in
// folder" only opens a draft, the click would be without a response: no chat appears in the folder, the empty view looks like
// any other. The stage therefore names it in the strip under the field.
import { useEffect, useRef } from "react";
import type { ChatFolder } from "@/lib/api";
import { MAIN } from "@/lib/instances-tree";
import { NEW_CHAT_EVENT, draftPreselection, readNewChatJob, type EntryPointTrace, type NewChatEntryPoint } from "@/lib/chat-draft";

export type NewChatDeps = {
  wsId: string;
  focusProjectId: string | null;
  activeId: string | null;
  folders: ChatFolder[];
  projectSel: string;
  folderSel: string;
  setProjectSel: (v: string) => void;
  setFolderSel: (v: string) => void;
  /** The instance preselection of the next chat (useChatInstance), NOT `pickInstance`: that would write into the chat being closed. */
  selectInstancePreselection: (name: string) => void;
  revealFolder: (id: string) => void;
  /** Close the open chat and show the empty view (ChatPane). */
  toDraft: () => void;
  taRef: { readonly current: HTMLTextAreaElement | null };
};

export function useNewChat(deps: NewChatDeps) {
  // The callbacks run after the render (click, event) and read the state of THIS render; `toDraft` is a function per render in
  // ChatPane, a captured state would be stale (same pattern as `useArchive`).
  const d = useRef(deps);
  d.current = deps;
  const lane = useRef<EntryPointTrace>(null);
  useEffect(() => { lane.current = null; }, [deps.wsId, deps.focusProjectId]);

  const newChat = useRef((e: NewChatEntryPoint) => {
    const { focusProjectId, projectSel, folderSel, setProjectSel, setFolderSel, selectInstancePreselection, revealFolder, toDraft, taRef } = d.current;
    const v = draftPreselection(e, { focus: focusProjectId, projectSel, folderSel, lane: lane.current });
    lane.current = v.lane;
    toDraft();
    setProjectSel(v.projectSel);
    setFolderSel(v.folderSel);
    selectInstancePreselection(v.instance ?? MAIN);
    if (v.folderSel) revealFolder(v.folderSel);
    // The draft waits for text: the field gets focus as soon as the empty view stands.
    requestAnimationFrame(() => taRef.current?.focus());
  }).current;

  // "Start chat" on an instance (projects/InstancesPage.tsx): only a job for THIS workspace; the page holds exactly one
  // ChatPane, the one of another workspace is not mounted.
  useEffect(() => {
    const on = (ev: Event) => {
      const a = readNewChatJob((ev as CustomEvent).detail);
      if (a && a.workspaceId === d.current.wsId) newChat({ projectId: a.projectId, instance: a.instance });
    };
    window.addEventListener(NEW_CHAT_EVENT, on);
    return () => window.removeEventListener(NEW_CHAT_EVENT, on);
  }, [newChat]);

  const { activeId, folderSel, folders } = deps;
  const draftFolder = !activeId && folderSel ? folders.find((f) => f.id === folderSel) ?? null : null;
  return { newChat, draftFolder };
}
