// The archive for chats and folders. The calculations (groups, search, hint, choice of the active conversation)
// live in the leaf `lib/archive.ts`; here only the paths to the server.
//
// The bodies are typed objects, not conditional spreads: `web/test/seams-fields.test.mjs` reads the fields via
// the type checker and holds them against `b.archived`/`b.dismissQuestion` of the routes.
import { API_BASE, api } from "./core.js";
import type { Chat, ChatFolder } from "./events.js";

/** A reason for open work as the server writes it (`text` is already translated). */
export interface ArchiveReasonDoc { reason: string; text: string }
/** Pre-check on the chat: `GET /api/chats/:id/archive`. */
export interface ArchivePrecheckChat { archived: boolean; archivedAt: number | null; open: ArchiveReasonDoc[]; terminals: number }
/**
 * Pre-check on the folder: `GET /api/chat-folders/:id/archive`. The numbers name what the NEXT action hits: on the
 * active folder `chats` is the number of chats that `PUT {archived:true}` would take along; on the ARCHIVED one exactly
 * those that `DELETE …?permanently=1` deletes; `contextFiles` are in both cases the files that go with the folder
 * (dissolving as well as permanent deletion). The confirmation questions take their numbers from HERE
 * (`folderDeleteQuestion`, `contextFilesSentence` in `lib/archive.ts`), never from a UI list.
 */
export interface ArchivePrecheckFolder {
  archived: boolean;
  archivedAt: number | null;
  chats: number;
  /** `null` if the server could not count the files — UNKNOWN, never 0. */
  contextFiles: number | null;
  open: { chatId: string; title: string; open: ArchiveReasonDoc[] }[];
  terminals: number;
}

const chatPath = (id: string) => `/api/chats/${encodeURIComponent(id)}/archive`;
const folderPath = (id: string) => `/api/chat-folders/${encodeURIComponent(id)}/archive`;

export const archivePrecheck = (chatId: string) => api<ArchivePrecheckChat>(chatPath(chatId));
export const folderArchivePrecheck = (folderId: string) => api<ArchivePrecheckFolder>(folderPath(folderId));

/**
 * Archive (`true`) or restore (`false`). With open work the call throws with the server text; the error object
 * carries `open` (the reasons). `dismissQuestion` applies only if the open question is the ONLY reason —
 * otherwise it stays 409.
 */
export function setArchive(chatId: string, archived: boolean, opts?: { dismissQuestion?: boolean }) {
  const body: { archived: boolean; dismissQuestion?: boolean } = { archived };
  if (opts?.dismissQuestion) body.dismissQuestion = true;
  return api<{ ok: boolean; unchanged?: boolean; chat: Chat; folderIds?: string[]; terminalsEnded?: number }>(chatPath(chatId), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Archive a folder with its content or bring it back (only the chats archived with it come back). */
export function setFolderArchive(folderId: string, archived: boolean) {
  const body: { archived: boolean } = { archived };
  return api<{ ok: boolean; unchanged?: boolean; chatIds: string[]; terminalsEnded: number }>(folderPath(folderId), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** An entry of the archive view — a Coding chat, brought to the common fields. */
export interface ArchiveChatEntry {
  id: string;
  title: string;
  folderId: string | null;
  projectId: string | null;
  archivedAt: number | null;
  /** "auto": the tick archived it (label "archived automatically"); "user" or unknown (null): by hand. */
  archiveReason: "user" | "auto" | null;
}

/**
 * The archive of the Coding chats: the archived chats (`archive=only`) and ALL folders (`archive=including` — the active ones
 * supply the label of a loose archived chat whose folder still stands). The kind is only "normal" — there is no
 * archive of manager conversations any more.
 */
export async function loadArchive(workspaceId: string, _kind: "normal"): Promise<{ chats: ArchiveChatEntry[]; folder: ChatFolder[] }> {
  const ws = encodeURIComponent(workspaceId);
  const [raw, folder] = await Promise.all([
    api<Chat[]>(`/api/chats?workspaceId=${ws}&archive=only`),
    api<ChatFolder[]>(`/api/chat-folders?workspaceId=${ws}&archive=including`),
  ]);
  const chats = raw.map((c) => ({
    id: c.id,
    title: c.title || "",
    folderId: c.folderId ?? null,
    projectId: c.projectId ?? null,
    archivedAt: c.archivedAt ?? null,
    archiveReason: c.archiveReason === "auto" || c.archiveReason === "user" ? c.archiveReason : null,
  }));
  return { chats, folder };
}

/**
 * Load a chat by id — also an archived one (every way that opens by id opens it too).
 * `null` ONLY on 404 (it does not exist); every other error throws — a network error is no answer "it does not exist".
 */
export async function loadArchiveChat(chatId: string): Promise<Chat | null> {
  const r = await fetch(`${API_BASE}/api/chats/${encodeURIComponent(chatId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET /api/chats/${chatId}: ${r.status}`);
  return (await r.json()) as Chat;
}

// ── Auto-archive chats ────────────────────────────────────────────────────────────────────
// ONE setting for all workspaces: on/off and the days without a new message. Nothing stored means on the server
// `{ enabled: false, days: 30 }` — the response says it, the client guesses nothing.

/** The setting as the server keeps it and returns it. */
export interface ChatAutoArchive { enabled: boolean; days: number }
const AUTO_ARCHIVE_ROUTE = "/api/chat-auto-archive";

/** A response without both fields is no setting — it throws instead of claiming "off, 30 days" (empty is not unknown). */
function readChatAutoArchive(r: unknown): ChatAutoArchive {
  const o = (r ?? {}) as { enabled?: unknown; days?: unknown };
  if (typeof o.enabled !== "boolean" || typeof o.days !== "number" || !Number.isInteger(o.days)) {
    throw new Error(`${AUTO_ARCHIVE_ROUTE}: unexpected response`);
  }
  return { enabled: o.enabled, days: o.days };
}

export const loadChatAutoArchive = () => api<unknown>(AUTO_ARCHIVE_ROUTE).then(readChatAutoArchive);

/** ALWAYS writes both fields — the route demands them (400 otherwise): a missing field is no statement. */
export function setChatAutoArchive(value: ChatAutoArchive) {
  const body: ChatAutoArchive = { enabled: value.enabled, days: value.days };
  return api<unknown>(AUTO_ARCHIVE_ROUTE, { method: "PUT", body: JSON.stringify(body) }).then(readChatAutoArchive);
}

/** An ARCHIVED folder permanently — with its archived chats and its context files. */
export const deleteFolderPermanently = (folderId: string) =>
  api<{ ok: boolean; chats: number; contextFiles: number | null }>(`/api/chat-folders/${encodeURIComponent(folderId)}?permanently=1`, { method: "DELETE" });
// The context-file count comes with the other numbers from the folder pre-check: ONE source for the confirmation
// question, the same count as on delete.
