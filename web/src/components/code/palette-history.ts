// The command palette's history (quick input like VS Code): the most recently opened files per target (VS Code `IHistoryService`, 200 entries —
// ⌘P without input shows them under "recently opened", the newest first) and the most recently used commands (VS Code
// `workbench.commandPalette.history`, 50 — ⇧⌘P shows them under "recently used"). Both survive a reload (localStorage, every access in
// try/catch — without storage it stays the history of this session). The computations (put first, cap, read) live in lib/quick-input.ts; a
// file is remembered as soon as it is in front in an editor of the host (CodePane → `useFileHistory`).
import { useEffect } from "react";
import type { LspTarget } from "@/lib/api";
import { removeFromHistory, readHistory, rememberInHistory, HISTORY_COMMANDS_MAX, HISTORY_FILES_MAX } from "@/lib/quick-input";

const KEY_FILES = "cbase-quickopen-history:";
const KEY_COMMANDS = "cbase-commands-history";
const storage = new Map<string, string[]>();
const subscribers = new Set<() => void>();
let revision = 0;
const report = () => { revision++; for (const fn of [...subscribers]) fn(); };
/** Increments on every change (`useSyncExternalStore`). */
export const historyStatus = (): number => revision;
export const subscribeHistory = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };

function read(key: string, max: number): string[] {
  const present = storage.get(key);
  if (present) return present;
  let list: string[] = [];
  try { list = readHistory(JSON.parse(localStorage.getItem(key) ?? "null"), max); } catch { list = []; }
  storage.set(key, list);
  return list;
}
function write(key: string, list: string[]) {
  storage.set(key, list);
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* without storage: this session only */ }
  report();
}
/** The key of a target: the paths are relative to it (project or workspace, main or copy). */
export const targetKey = (z: LspTarget | null | undefined): string | null => (z ? `${KEY_FILES}${z.apiBase}|${z.instance ?? ""}` : null);

export function fileHistory(z: LspTarget | null | undefined): string[] {
  const k = targetKey(z);
  return k ? read(k, HISTORY_FILES_MAX) : [];
}
export function rememberFile(z: LspTarget | null | undefined, path: string): void {
  const k = targetKey(z);
  if (!k || !path || path.startsWith("/")) return; // a location outside the instance is in no history
  const old = read(k, HISTORY_FILES_MAX);
  if (old[0] === path) return;
  write(k, rememberInHistory(old, path, HISTORY_FILES_MAX));
}
export function forgetFile(z: LspTarget | null | undefined, path: string): void {
  const k = targetKey(z);
  if (k) write(k, removeFromHistory(read(k, HISTORY_FILES_MAX), path));
}
export const commandHistory = (): string[] => read(KEY_COMMANDS, HISTORY_COMMANDS_MAX);
export const rememberCommand = (id: string): void => write(KEY_COMMANDS, rememberInHistory(commandHistory(), id, HISTORY_COMMANDS_MAX));

/** Remembers the file in front in the host (VS Code: every active editor enters the history). */
export function useFileHistory(z: LspTarget | null | undefined, active: string | null | undefined): void {
  const k = targetKey(z);
  useEffect(() => { if (active) rememberFile(z, active); }, [k, active]); // eslint-disable-line react-hooks/exhaustive-deps
}
