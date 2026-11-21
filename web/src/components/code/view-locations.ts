// What a diff or preview tab keeps beyond being detached, and how it is reached from outside. Only the front tab is mounted; switching
// tabs unmounts diff and preview. VS Code keeps a view state per editor (`editor.viewState`: scroll, caret) and saves the ACTIVE editor
// on Cmd+S even when focus is not inside it (tab bar, header).
//
// THE LOCATION: the place a tab lives — `${area}|${group}` in the editor groups (CodePane `diffLocation`), `chat:${chatKey}` in the chat
// (ChatCodeArea). At most ONE diff is mounted per location (the front one).
//   reportSave / saveLocation   Cmd+S outside the surface: CodePane (groups) and chat/chatTabs.ts (focus in the chat's tab bar) save the
//                                   diff mounted at that location (its right side — components/code/DiffTab.tsx).
//   rememberRole / roleOf           the scroll position (and caret) per tab — restored when the tab is mounted again. Capped
//                                   (`ROLES_CAP`, oldest drops) — a long-lived window would otherwise collect without end.
// Guard: web/test/editor-inputs.test.mjs (sources).

const SAVE = new Map<string, () => void>();
/** The diff at `location` saves via `f` — the return value unregisters it (only if it is still the registered one). */
export function reportSave(location: string, f: () => void): () => void {
  SAVE.set(location, f);
  return () => { if (SAVE.get(location) === f) SAVE.delete(location); };
}
/** Cmd+S for the diff at `location` — false: none is mounted there. */
export function saveLocation(location: string): boolean {
  const f = SAVE.get(location);
  if (!f) return false;
  f();
  return true;
}

export type ScrollStatus = { top: number; header?: number };
export const ROLES_CAP = 200;
const ROLES = new Map<string, ScrollStatus>();
/** Remember the scroll position of tab `k` (the newest sits last; over the cap the oldest drops). */
export function rememberRole(k: string, r: ScrollStatus): void {
  ROLES.delete(k);
  ROLES.set(k, r);
  if (ROLES.size > ROLES_CAP) { const first = ROLES.keys().next().value; if (first !== undefined) ROLES.delete(first); }
}
export const roleOf = (k: string): ScrollStatus | undefined => ROLES.get(k);
