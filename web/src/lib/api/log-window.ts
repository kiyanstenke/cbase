// A chat's history in a WINDOW: the client part of the contract in server chats/log-window.js (window size, boundary, truncation and
// the parameters live there; here only their names, bound in the guard server/backend/test/log-window.test.js):
//   `loadWindow(chatId, { before?, from? })` → `GET …/log?window=1[&before=][&from=]`: the latest rows (before `before`); with `from`
//     everything from the boundary at or before `from`. If a server without the window answers with the full list, it counts as a
//     complete window.
//   `deltaPath(chatId, since)` → the delta, truncated like the window.
//   `loadRowFull(chatId, row)` → ONE row untruncated (expanding a truncated tool result).
// Leaf: nothing outside lib/api/ (README there).
import { api } from "./core.js";
import type { LogEntry } from "./workspace.js";

/** Answer of `GET …/log?window=1`: the rows, whether older ones exist, and the server's state (as on the delta). */
export interface LogWindow {
  total: number;
  lastId: number;
  older: boolean;
  rows: LogEntry[];
}

/** The parameter names; the same as `WINDOW_PARAM` on the server. */
export const WINDOW_PARAM = { window: "window", before: "before", from: "from", truncate: "truncate" } as const;

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A chat's window; `before`: only rows before it (older page), `from`: everything from this row (jump, reload of the same range). */
export async function loadWindow(chatId: string, opt: { before?: number; from?: number } = {}): Promise<LogWindow> {
  const q = new URLSearchParams({ [WINDOW_PARAM.window]: "1" });
  if (opt.before) q.set(WINDOW_PARAM.before, String(opt.before));
  if (opt.from) q.set(WINDOW_PARAM.from, String(opt.from));
  const r = await api<LogWindow | LogEntry[]>(`/api/chats/${chatId}/log?${q}`);
  if (Array.isArray(r)) return { total: r.length, lastId: r.length ? r[r.length - 1].id : 0, older: false, rows: r };
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  return { total: count(r?.total), lastId: count(r?.lastId), older: r?.older === true, rows };
}

/** The path of the delta from `since`, truncated like the window. */
export const deltaPath = (chatId: string, since: number) => `/api/chats/${chatId}/log/delta?since=${since}&${WINDOW_PARAM.truncate}=1`;

/** One row untruncated. */
export const loadRowFull = (chatId: string, row: number) => api<LogEntry>(`/api/chats/${chatId}/log/row/${row}`);

/** The event by which an expanded tool row requests its truncated result (`detail`: the row id). */
export const ROW_FULL_EVENT = "cbase-row-full";
