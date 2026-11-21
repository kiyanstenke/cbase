// New chat = draft: every “New chat” entry point only opens the empty view, and the chat is created on first send, with EXACTLY what
// the entry point chose. Otherwise all buttons except the hero created it at once, and every click left an empty chat in the list.
//
// The pure computations live here: which preselection an entry point sets (`draftPreselection`) and the window event through which a
// place outside the chat (the “Instances” tab) orders the draft (`NEW_CHAT_EVENT`). The effect (close chat, set preselection, focus)
// lives in components/chat/chatDraft.ts, the creation itself in `ensureChat` (ChatPane): ONE POST.
//
// A module without imports: web/test/chat-draft.test.mjs compiles it alone and runs it.

/**
 * What an entry point chooses. Without arguments it is PLAIN (“New chat” row, “+” of the collapsed list): no folder, in main, and in
 * the project of its own preselection (see `draftPreselection`).
 */
export type NewChatEntryPoint = {
  /** “New chat in folder” (folder menu, key N): the chat starts in this folder, and in its project. */
  folder?: { id: string; projectId?: string | null };
  /** “Start chat” on an instance: project AND instance (“main” or “copy-<name>”). */
  projectId?: string;
  instance?: string;
  /** The “New chat in …” sheet: the user has just chosen project and folder THERE; they apply as they stand. */
  sheet?: boolean;
};

/**
 * What an entry point with a folder or instance OVERWROTE in the project choice: `set` is its project, `prior` the own preselection
 * before it (sheet or project choice of the empty chat). `null`: nothing overwritten. The hook (chat/chatDraft.ts) keeps it from entry
 * point to entry point and forgets it on workspace and project change.
 */
export type EntryPointTrace = { set: string; prior: string } | null;

/** The draft's preselection. `instance: null` means main, the server's default; the POST then carries no field. */
export type DraftPreselection = { projectSel: string; folderSel: string; instance: string | null; lane: EntryPointTrace };

/**
 * The preselection an entry point sets. `focus` is the entered project: the project choice is fixed there, and an entry point for
 * ANOTHER project (only possible through an error: the “Instances” tab shows only the entered project's instances) keeps the focus
 * project and drops its instance, instead of preparing a chat in the wrong project.
 *
 * - Folder: the folder's project (except in focus), the folder, main. The draft names the project itself; otherwise the effect in
 *   ChatPane would reset the folder (it only fits folders of the chosen project).
 * - Instance: project and instance, no folder (a folder of the previous draft belonged to another project or none).
 * - Sheet: project and folder stay as the sheet just set them; the instance falls back to main.
 * - Plain (no arguments): NO folder, main, and the project of the own preselection. Folder and instance entry points write into the
 *   SAME preselection, and it would stay after creation, so a later “New chat” would land again in folder X, its project and the copy
 *   of the previous entry point. So such an entry point records what it overwrote (`lane`), and the plain one takes it back, unless
 *   the user has changed the project choice since: then the user's choice applies.
 */
export function draftPreselection(
  e: NewChatEntryPoint,
  { focus, projectSel, folderSel, lane = null }: { focus: string | null; projectSel: string; folderSel: string; lane?: EntryPointTrace },
): DraftPreselection {
  // The own preselection: what stood before the last folder/instance entry point, as long as the project choice is still the one it set.
  const own = lane && lane.set === projectSel ? lane.prior : projectSel;
  const overwrites = (p: string): EntryPointTrace => (p === own ? null : { set: p, prior: own });
  if (e.folder) {
    const p = focus ? projectSel : e.folder.projectId ?? "";
    return { projectSel: p, folderSel: e.folder.id, instance: null, lane: overwrites(p) };
  }
  if (e.projectId !== undefined) {
    const matches = !focus || focus === e.projectId;
    const p = focus ? projectSel : e.projectId;
    return { projectSel: p, folderSel: "", instance: matches && e.instance ? e.instance : null, lane: overwrites(p) };
  }
  if (e.sheet) return { projectSel, folderSel, instance: null, lane: null };
  return { projectSel: own, folderSel: "", instance: null, lane: null };
}

/**
 * The window event “open a draft”, from a place that does not hold the Coding chat (“Instances” tab, “Start chat”). The page
 * (app/workspaces/page.tsx) switches to the “Chats” tab, and ChatPane opens the draft.
 */
export const NEW_CHAT_EVENT = "cbase-new-chat";
export type NewChatJob = { workspaceId: string; projectId: string; instance: string };

export function showNewChat(job: NewChatJob): void {
  window.dispatchEvent(new CustomEvent<NewChatJob>(NEW_CHAT_EVENT, { detail: job }));
}

/** Read the event; only a complete job counts (“a missing field is no instruction”). */
export function readNewChatJob(detail: unknown): NewChatJob | null {
  const d = (detail ?? {}) as Record<string, unknown>;
  if (typeof d.workspaceId !== "string" || !d.workspaceId) return null;
  if (typeof d.projectId !== "string" || !d.projectId) return null;
  if (typeof d.instance !== "string" || !d.instance) return null;
  return { workspaceId: d.workspaceId, projectId: d.projectId, instance: d.instance };
}

/**
 * ONE creation at a time: until `ensureChat` (ChatPane) has set the new id, the POST round trip passes; attachment + immediate Enter
 * or a double Enter would create TWO chats in that time, and the attachment would hang on the orphan. Every call during a running
 * creation gets its promise; when it is done (success or error), the way is free again: afterwards the set id answers, and after an
 * error the next attempt may create anew.
 */
export function oneCreation<T>(): (create: () => Promise<T>) => Promise<T> {
  let running: Promise<T> | null = null;
  return (create) => (running ??= create().finally(() => { running = null; }));
}
