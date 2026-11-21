// ⌥Z as VS Code (`editor.action.toggleWordWrap`): the toggle applies ONLY to the front file (VS Code: to the model, in every group that
// shows it) and only until the window reloads — the "Word wrap" setting (code settings) stays as it is. (⌥Z does not toggle the setting itself.)
//
// The override is per buffer key (lib/buffer.ts `bufferKey`) in the window; if it matches the setting again, it is dropped
// (VS Code: `wordWrapOverride` "inherit"). Tested by EXECUTION in web/test/editor-groups.test.mjs.
const OVER = new Map<string, boolean>();
const LISTENERS = new Set<() => void>();
let tick = 0;

/** Does file `key` wrap — its override, otherwise the setting. */
export function wrapOf(key: string | null | undefined, setting: boolean): boolean {
  if (!key) return setting;
  return OVER.get(key) ?? setting;
}
/** ⌥Z: toggle the file's wrapping (transient, only it). */
export function toggleWrap(key: string, setting: boolean): void {
  const fresh = !wrapOf(key, setting);
  if (fresh === setting) OVER.delete(key); else OVER.set(key, fresh);
  tick += 1;
  for (const h of [...LISTENERS]) h();
}
/** For `useSyncExternalStore`: changes on every toggle. */
export const wrapTick = (): number => tick;
export function subscribeWrap(h: () => void): () => void {
  LISTENERS.add(h);
  return () => { LISTENERS.delete(h); };
}
/** For tests only: forget everything. */
export function forgetWraps(): void { OVER.clear(); tick += 1; }
