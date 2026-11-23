// A chat's output location, read-only. Routes `GET /api/chats/:id/outputs` (list),
// `GET /api/chats/:id/outputs/file?path=…[&inline=1]` (file) and `GET /api/chats/:id/outputs/folder?path=…` (folder as ZIP); server chats/outputs-routes.js. The calculations over the list (tree,
// paths in the chat text) live in the leaf lib/outputs.ts. Leaf: nothing outside lib/api/ and lib/outputs.ts (README there).
import { API_BASE, api } from "./core.js";
import type { OutputEntry, OutputsList } from "../outputs.js";

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The list: every field with a default; an entry without a path drops out. */
export async function loadOutputs(chatId: string): Promise<OutputsList> {
  const r = await api<Partial<OutputsList>>(`/api/chats/${chatId}/outputs`);
  const entries: OutputEntry[] = (Array.isArray(r?.entries) ? r.entries : [])
    .filter((e) => e && typeof e.path === "string" && e.path)
    .map((e) => ({ path: e.path, size: count(e.size), changed: count(e.changed), internal: e.internal === true }));
  return {
    roots: (Array.isArray(r?.roots) ? r.roots : []).filter((w): w is string => typeof w === "string" && w.startsWith("/")),
    entries, total: count(r?.total), clipped: r?.clipped === true, max: count(r?.max),
  };
}

/** The address of a file (download, or `inline` for display). */
export const outputUrl = (chatId: string, path: string, inline = false) =>
  `${API_BASE}/api/chats/${chatId}/outputs/file?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`;

/** The address of a folder as ZIP download; `path` empty = the whole output location. */
export const outputFolderUrl = (chatId: string, path: string) =>
  `${API_BASE}/api/chats/${chatId}/outputs/folder?path=${encodeURIComponent(path)}`;
