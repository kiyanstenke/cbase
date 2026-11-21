// The pure parts of the right chat bar (activity bar in VS Code style): the sections in their order (agenda right after git, then the
// project's timeline, whose button only appears for a chat with a project), the width clamp of the draggable panel, the mapping of a
// key press to a section, and the text of a counter badge. No DOM and no React, so `web/test/chat-bar.test.mjs` can check it without a
// browser; the bar itself (ChatRightSidebar.tsx) recomputes none of it, it calls in here.
//
// Why the sections stand HERE and not in ChatCatalog.tsx: the list is the truth for the bar, the persistence allowlist (ChatPane only
// reads the saved tab if it is listed here) and the test benches; a tab added only in the JSX chain would silently fall back to
// “gitlab” on the next load.

export const BAR_SECTIONS = ["gitlab", "agenda", "timeline", "artifacts", "channels", "agents", "terminal", "browser"] as const;
export type RightSidebarTab = (typeof BAR_SECTIONS)[number];

export const isSection = (v: unknown): v is RightSidebarTab =>
  typeof v === "string" && (BAR_SECTIONS as readonly string[]).includes(v);

// Panel width (without the 40 px activity rail): VS Code allows its sidebar from 170 px, here 280 is the lower limit because git rows
// and the terminal tab strip become unreadable below it; 640 the upper limit so that the stage next to chat list and panel still keeps
// 300 px at 1250 px (the auto-collapse threshold).
export const BAR_WIDTH_MIN = 280;
export const BAR_WIDTH_MAX = 640;
export const BAR_WIDTH_DEFAULT = 360;
export const BAR_RAIL = 40; // width of the activity rail
export const BAR_WIDTH_KEY = "cbase-chat-bar-width"; // global per user, not per chat

/** Clamps a wanted width to the allowed range; nonsense (NaN, null) becomes the default. */
export function clampWidth(n: unknown): number {
  // `Number(null)` and `Number("")` are 0, and 0 would be clamped to MIN: every user without a saved width (localStorage returns
  // null) would get 280 instead of the default.
  if (n == null || n === "") return BAR_WIDTH_DEFAULT;
  const z = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(z)) return BAR_WIDTH_DEFAULT;
  return Math.min(BAR_WIDTH_MAX, Math.max(BAR_WIDTH_MIN, Math.round(z)));
}

/** Whether ⌘ is the modifier key (shortcuts, tooltips, the commit field's placeholder): ONE detection for bar and git panel; false
 *  without `navigator` (SSR). Whoever needs the value in render calls it only after mount: the page is built statically, and there is
 *  no navigator while hydrating. */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

// Shortcuts (named in the icon's tooltip): Ctrl+` terminal, ⌘⇧B browser, ⌘⇧G git; on Windows/Linux Ctrl instead of ⌘. `code` is
// measured, not `key`: on the German Mac keyboard the Backquote key sits on “^”, and `key` would be a dead character there.
export type Shortcut = { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };
export const SHORTCUT: Partial<Record<RightSidebarTab, { code: string; mod: "ctrl" | "mod"; shift: boolean; text: string }>> = {
  terminal: { code: "Backquote", mod: "ctrl", shift: false, text: "Ctrl+`" },
  browser: { code: "KeyB", mod: "mod", shift: true, text: "⌘⇧B" },
  gitlab: { code: "KeyG", mod: "mod", shift: true, text: "⌘⇧G" },
};

/** Which section a key press switches, or null. `mac` decides whether ⌘ or Ctrl is “mod”. */
export function shortcutSection(e: Shortcut, mac: boolean): RightSidebarTab | null {
  if (e.altKey) return null;
  for (const key of BAR_SECTIONS) {
    const k = SHORTCUT[key];
    if (!k || k.code !== e.code || k.shift !== e.shiftKey) continue;
    if (k.mod === "ctrl") { if (e.ctrlKey && !e.metaKey) return key; continue; }
    const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod) return key;
  }
  return null;
}

/** The text of a counter badge on the icon: nothing at 0, “9+” from ten (VS Code shows up to 99, which does not fit in 36 px). */
export function badgeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 9 ? "9+" : String(Math.floor(n));
}

/** An icon's tooltip: the label, followed by the shortcut in brackets if there is one. */
export function barTooltip(label: string, key: RightSidebarTab, mac: boolean): string {
  const k = SHORTCUT[key];
  if (!k) return label;
  const text = mac ? k.text : k.text.replace("⌘⇧", "Ctrl+Shift+");
  return `${label} (${text})`;
}

// The shape of the panel header (32 px: title in 11 px caps on the left, actions on the right) stands ONCE here because two parts
// render it: the bar for five sections, `TerminalsPane` in the bar variant for its own (title + tabs + “+”). Two copies drifted apart.
export const BAR_HEADER_CLASS = "flex h-8 shrink-0 items-center gap-1 pl-3 pr-1.5";
export const BAR_TITLE_CLASS = "min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-dim";
/** The title of a header next to which a SHRINKING choice stands (the instance in the git section): it keeps its width (`min-w-fit`;
 *  with `truncate` the automatic minimum width is 0, and the choice would otherwise take its space down to “GI…”), the choice shortens
 *  its name. An own literal instead of a replacement: `min-w-0` and `min-w-fit` together would be decided by CSS order. */
export const BAR_TITLE_FULL_CLASS = "min-w-fit flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-dim";
/** An action in the panel header: 24 px, icon, no capsule. */
export const BAR_ACTION_CLASS = "grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-dim";

// Whether an agent browser of the registry belongs to a chat. Its `scopeKey` is `agent:<profile folder>:<port>` (browsers.js,
// `startAgentScan`); the profile folder is `chat-<chatId>` for the main agent and `chat-<chatId>-agent-<n>` for a subagent
// (browser-profiles.js, do-run.js). The SEGMENT is compared, not a prefix: “chat-ab” would otherwise also hit “chat-abc”, and
// `findAgentBrowser` in the backend computes it the same way.
export function browserBelongsToChat(scopeKey: string, chatId: string): boolean {
  if (!chatId) return false;
  const folder = scopeKey.split(":")[1] ?? "";
  return folder === `chat-${chatId}` || folder.startsWith(`chat-${chatId}-agent-`);
}
