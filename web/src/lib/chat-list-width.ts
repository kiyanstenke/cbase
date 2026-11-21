// The width of the docked chat list in the Coding chat: the same form as the right bar's width (lib/chat-bar.ts `clampWidth`): global
// per user, not per chat, in localStorage; nonsense becomes the default. 268 px was the fixed width before; below 220 px titles and the
// short-info row become unreadable, above 480 px too little is left for the stage next to an open right bar at the auto-collapse threshold.
export const LIST_WIDTH_MIN = 220;
export const LIST_WIDTH_MAX = 480;
export const LIST_WIDTH_DEFAULT = 268;
export const LIST_WIDTH_KEY = "cbase-chat-list-width";

/** Clamps a wanted chat-list width to the allowed range; nonsense (NaN, null, "") becomes the default. */
export function clampListWidth(n: unknown): number {
  // As with the right bar: `Number(null)` is 0 and would be clamped to MIN; without a saved width the default applies.
  if (n == null || n === "") return LIST_WIDTH_DEFAULT;
  const z = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(z)) return LIST_WIDTH_DEFAULT;
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, Math.round(z)));
}
