// The browser choice in the right chat bar: no DOM, no React, so `web/test/browser-choice.test.mjs` checks it without a browser;
// ChatRightSidebar only calls in here.
//
// Why: the choice used to hang on the browser `id`, which belongs to one Chromium SESSION. An agent starts its own @playwright/mcp
// per run (turn, workflow step) and thus a new Chromium in the same profile: new debug port, new session, new id. The old one vanished
// from the list, the choice did not find it and the bar fell back SILENTLY to its own browser (about:blank) while the agent kept
// browsing next to it. So the choice is now the PROFILE (`profile:<folder>`): it survives every restart, and the view attaches to the
// currently live session of that profile. If there is none right now, that means “closed”, not “own browser”.
//
// Names: main agent instead of chat title (the bar already sits in the chat), a subagent under its job, a workflow agent under its
// label, taken from the lists the bar already has (agents section, tree). And “controls now”: the server stamps `activeAt` as soon as
// the agent opens a tab or changes an address.
import type { BrowserInfo } from "./api/devtools.js";
import { browserBelongsToChat } from "./chat-bar.js";

export const CHOICE_OWN = "own";
const PREFIX = "profile:";
export const choiceForProfile = (profile: string) => `${PREFIX}${profile}`;
export const profileOfTheChoice = (choice: string) => (choice.startsWith(PREFIX) ? choice.slice(PREFIX.length) : "");

/** How long after the last activity an agent browser counts as “controls now”. */
export const ACTIVE_MS = 30_000;

/** The profile folder of a browser: from the server (`profile`), for an older one from the `scopeKey` (`agent:<folder>:<port>`). */
export function profileOf(b: Pick<BrowserInfo, "scopeKey"> & { profile?: string }): string {
  return b.profile || (b.scopeKey.startsWith("agent:") ? b.scopeKey.split(":")[1] ?? "" : "");
}

/** The agentId from the profile: `agentId` from the server, else from “chat-<chat>-agent-<id>”; empty = main agent. */
function agentIdOf(b: BrowserInfo, chatId: string): string {
  if (typeof b.agentId === "string") return b.agentId;
  const p = profileOf(b);
  const prefix = `chat-${chatId}-agent-`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : "";
}

/** Does the agent control this browser right now (last activity younger than ACTIVE_MS)? `now` comes from the caller. */
export function controlsCurrently(b: Pick<BrowserInfo, "activeAt">, now: number): boolean {
  const activeAt = Number(b.activeAt) || 0;
  return activeAt > 0 && now - activeAt >= 0 && now - activeAt < ACTIVE_MS;
}

/** When the “controls now” mark of the earliest active browser expires; null if none is active. */
export function nextExpiry(browsers: Pick<BrowserInfo, "activeAt">[], now: number): number | null {
  let min: number | null = null;
  for (const b of browsers) {
    if (!controlsCurrently(b, now)) continue;
    const until = (Number(b.activeAt) || 0) + ACTIVE_MS;
    if (min === null || until < min) min = until;
  }
  return min;
}

/**
 * The agent browsers of a chat, one per PROFILE: if two sessions of the same profile are present (the old one is dying, the new one
 * already discovered), the later one wins (the list is in discovery order, like `findAgentBrowser` in the backend). The main agent
 * first, the rest in order of first appearance: a menu sorted by activity would jump under the pointer.
 */
export function agentBrowserOfTheChat(browsers: BrowserInfo[], chatId: string): BrowserInfo[] {
  if (!chatId) return [];
  const byProfile = new Map<string, BrowserInfo>();
  for (const b of browsers) {
    if (b.kind !== "agent") continue;
    const profile = profileOf(b);
    if (!profile || !browserBelongsToChat(`agent:${profile}:0`, chatId)) continue;
    byProfile.set(profile, b); // insertion order stays that of the first appearance, the value becomes the newest
  }
  const list = [...byProfile.values()];
  return [...list.filter((b) => !agentIdOf(b, chatId)), ...list.filter((b) => agentIdOf(b, chatId))];
}

/** Names per agentId from what the bar already has: subagents (job) and workflow agents (label, else “name #n”). */
export function agentNames(
  agents: { agentId: string; job: string }[],
  runs: { name: string; agents: { agentId: string; label: string; n: number }[] }[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const l of runs) {
    for (const a of l.agents) {
      if (!a.agentId) continue;
      const name = a.label.trim() || `${l.name} #${a.n}`;
      if (name.trim()) names.set(a.agentId, name);
    }
  }
  for (const a of agents) if (a.agentId && a.job.trim()) names.set(a.agentId, a.job.trim());
  return names;
}

/** The short name of an agent browser. `texts` are the translated words (the computation knows no i18n). */
export function browserName(b: BrowserInfo, chatId: string, names: Map<string, string>, texts: { main: string; sub: string }): string {
  const agentId = agentIdOf(b, chatId);
  if (!agentId) return texts.main;
  const known = names.get(agentId);
  if (known) return known;
  // An older server listed the subagent browser under its folder name, which is no name.
  return b.label && b.label !== profileOf(b) ? b.label : texts.sub;
}

export type ChoiceEntry = { choice: string; name: string; tabs: number; active: boolean; browserId: string };

/** The menu entries (without “Own browser”, which the bar renders first): name, tab count, “controls now”. */
export function choiceEntries(
  browsers: BrowserInfo[], chatId: string, names: Map<string, string>, texts: { main: string; sub: string }, now: number,
): ChoiceEntry[] {
  return agentBrowserOfTheChat(browsers, chatId).map((b) => ({
    choice: choiceForProfile(profileOf(b)),
    name: browserName(b, chatId, names, texts),
    tabs: b.tabs,
    active: controlsCurrently(b, now),
    browserId: b.id,
  }));
}

/**
 * What the stored choice shows NOW:
 *   own    → the scope's own browser
 *   agent  → the live session of the chosen profile (`browser`)
 *   closed → the profile has no session right now: the agent has closed its browser (end of turn, next step starts soon);
 *            NOT silently the own browser
 *   unknown→ the list is not loaded yet: claim neither “closed” nor start the own browser
 */
export type ChoiceStatus =
  | { kind: "own" }
  | { kind: "agent"; browser: BrowserInfo }
  | { kind: "closed"; profile: string }
  | { kind: "unknown"; profile: string };

export function resolveChoice(choice: string, browsers: BrowserInfo[], chatId: string, loaded: boolean): ChoiceStatus {
  const profile = profileOfTheChoice(choice);
  if (!profile) return { kind: "own" };
  if (!loaded) return { kind: "unknown", profile };
  const b = agentBrowserOfTheChat(browsers, chatId).find((x) => profileOf(x) === profile);
  return b ? { kind: "agent", browser: b } : { kind: "closed", profile };
}

// ── The extra window ─────────────────────────────────────────────────────────────────────────────────────────────────
// Bar and pill open the SAME window through the SAME call (`openBrowserWindow`); the page is `web/src/app/browser/page.tsx`.
//
// An agent browser goes out as PROFILE (`?profile=<folder>`), for the same reason as the bar's choice: the id belongs to one Chromium
// session, the agent's next run starts a new Chromium, and the window would show “gone” and stall. With the profile it says “closed”
// and attaches to the next session.
// The own browser goes out as SCOPE (`?scope=proj:<id>` | `ws:<id>`, the keys from browser-native): the page calls the scope's
// `/browser/ensure`, which returns the running session (no second one) and starts a new one after the idle stop, where a session id
// would be left dangling. NOT offered while the own browser is native (cbase client with bridge): a child window from window.open gets
// no preload (measured on Electron 44.4.4, with and without setWindowOpenHandler) and would show the server's stream, a DIFFERENT
// browser than the bar's WebContentsView under the same name.

/** The size of the extra window (window.open features). */
export const WINDOW_DIMENSIONS = "width=1280,height=860";

/** Opens the extra window. The one call for bar and pill; `w` is `window` (this module knows no DOM). */
export function openBrowserWindow(w: { open: (url: string, target: string, dimensions: string) => unknown }, url: string): void {
  w.open(url, "_blank", WINDOW_DIMENSIONS);
}

/** The scope key (“proj:<id>” | “ws:<id>” | “chat:<id>”) back into the pane's apiBase; null for anything else. */
export function apiBaseFromScope(scope: string): string | null {
  const m = /^(proj|ws|chat):([^/?#]+)$/.exec(String(scope || ""));
  // The browser normalized “.” and “..” to a DIFFERENT ensure path (`/api/browser/ensure`): not an id.
  if (!m || /^\.+$/.test(m[2])) return null;
  return `/api/${m[1] === "proj" ? "projects" : m[1] === "chat" ? "chats" : "workspaces"}/${encodeURIComponent(m[2])}`;
}

/**
 * The address of the extra window for what the bar shows right now; null if there is none (the button is then missing): own without
 * scope, own while it is still open whether the bridge exists (`native` null), and own with a native browser.
 * `scope` is the key of the own browser (`scopeFromApiBase` of the bar).
 */
export function windowUrl(status: ChoiceStatus, scope: string | null, native: boolean | null, chat?: string | null): string | null {
  if (status.kind === "own") {
    if (native !== false || !scope || !apiBaseFromScope(scope)) return null;
    // The own browser of a PROJECT carries the bar's chat: the page calls `/browser/ensure?chat=`, so the window of a copy chat shows
    // the copy, never the main one. The workspace has no instance.
    const withChat = chat && scope.startsWith("proj:") ? `&chat=${encodeURIComponent(chat)}` : "";
    return `/browser/?scope=${encodeURIComponent(scope)}${withChat}`;
  }
  const profile = status.kind === "agent" ? profileOf(status.browser) : status.profile;
  return profile ? `/browser/?profile=${encodeURIComponent(profile)}` : null;
}

/** The address for a pill entry: the profile, else (older server without profile) the session. */
export function windowForSession(b: BrowserInfo): string {
  const profile = b.kind === "agent" ? profileOf(b) : "";
  return profile ? `/browser/?profile=${encodeURIComponent(profile)}` : `/browser/?id=${encodeURIComponent(b.id)}`;
}

/** What the extra window's address asks for. Precedence: profile, scope, session (`?id=`). */
export type WindowTarget =
  | { kind: "profile"; profile: string }
  | { kind: "scope"; apiBase: string; chat?: string }
  | { kind: "id"; id: string }
  | { kind: "missing" };

export function windowTarget(search: string): WindowTarget {
  const q = new URLSearchParams(search);
  const profile = (q.get("profile") || "").trim();
  if (profile) return { kind: "profile", profile };
  const apiBase = apiBaseFromScope(q.get("scope") || "");
  // The chat only on a project (see windowUrl); on the workspace it is not read.
  const chat = (q.get("chat") || "").trim();
  if (apiBase) return chat && apiBase.startsWith("/api/projects/") ? { kind: "scope", apiBase, chat } : { kind: "scope", apiBase };
  const id = (q.get("id") || "").trim();
  return id ? { kind: "id", id } : { kind: "missing" };
}

/** The live session of a profile across all browsers (the window knows no chat); of two, the later. */
export function resolveProfile(profile: string, browsers: BrowserInfo[], loaded: boolean): ChoiceStatus {
  if (!loaded) return { kind: "unknown", profile };
  let hits: BrowserInfo | null = null;
  for (const b of browsers) if (b.kind === "agent" && profileOf(b) === profile) hits = b;
  return hits ? { kind: "agent", browser: hits } : { kind: "closed", profile };
}

// ── The browser of a chat ────────────────────────────────────────────────────────────────────────────────────────────
// Every chat has its own browser, and it follows the chat: in a chat's bar the own browser is the CHAT's (`/api/chats/<id>/browser/ensure`,
// server side `chatBrowserTarget`), and its main agent works in it. Without a chat it is the entered project's, else the workspace's.

/** The apiBase of the own browser in the bar: the chat's browser, without a chat that of the entered scope. */
export function ownBrowserApiBase(a: { chatId: string | null; focusProjectId: string | null; wsId: string }): string {
  if (a.chatId) return `/api/chats/${encodeURIComponent(a.chatId)}`;
  return a.focusProjectId ? `/api/projects/${a.focusProjectId}` : `/api/workspaces/${a.wsId}`;
}

/** Does this chat's main agent currently hold an own browser (`agentChat`, browsers.js summarize)? */
export function agentControlsOwn(browsers: Pick<BrowserInfo, "kind" | "agentChat">[], chatId: string): boolean {
  return Boolean(chatId) && browsers.some((b) => b.kind === "user" && b.agentChat === chatId);
}
