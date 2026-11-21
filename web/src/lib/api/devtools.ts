
// ── Debugger ─────────────────────────────────────────────────────────────────
export interface DebugFrame { callFrameId: string; name: string; file: string; line: number; }
export interface DebugVar { name: string; value: string; type: string; }
export interface DebugScope { type: string; name: string; vars: DebugVar[]; }
export interface DebugPaused { reason: string; frames: DebugFrame[]; topFile?: string; topLine?: number; scopes: DebugScope[]; }

// ── File editor ──────────────────────────────────────────────────────────────
export interface FileEntry {
  name: string;
  path: string;               // project-relative, with /
  type: "dir" | "file";
  size: number;
  symlink: boolean;
  heavy: boolean;             // heavy folder (node_modules etc.) — leave collapsed
  /** A folder: the chain of single subfolders below it (server/backend/…/files.js `chainsAlongside`) — missing: none known. */
  chain?: FileEntry[];
}
export interface DirListing {
  path: string;
  entries: FileEntry[];
}
export interface FileContent {
  path: string;
  content?: string;
  size: number;
  tooLarge?: boolean;
  binary?: boolean;
  /** Image file: binary, but displayable as a preview (mime comes from the server). */
  image?: boolean;
  mime?: string;
}
export interface FileSearchMatch {
  line: number;
  text: string;
  /** The columns of each hit in the WHOLE line (missing on an old server). */
  hits?: [number, number][];
}
export interface FileSearchResult {
  path: string;
  matches: FileSearchMatch[];
}
export interface FileSearchResponse {
  results: FileSearchResult[];
  count: number;
  files: number;
  truncated: boolean;
  /** Of the sent-along open buffers (unsaved), those that lie within the search area. */
  openMatches?: string[];
}
/** `POST …/files/find {query}` (⌘P): paths relative to the target, sorted like VS Code's Quick Open. At most `cap` hits; `truncated`
 *  if there were more (also at the walk's hit cap); `aborted` + `searched` if the walk stopped at its safety cap
 *  (this many files it saw — files.js `quickOpenFiles`, devtools/code-route.js FIND_CAP). */
export interface FileFindResponse {
  results: string[];
  truncated: boolean;
  cap: number;
  aborted?: boolean;
  searched?: number;
}

// ── Browser registry ─────────────────────────────────────────────────────────
/**
 * A running browser (`GET /api/browsers`, events "browsers" and "init" of the global stream): `kind`
 * "user" is a scope's own browser, "agent" the Playwright of a chat run. For the agent browser
 * `scopeKey` is `agent:<profile folder>:<port>`, the profile folder `chat-<chatId>` or
 * `chat-<chatId>-agent-<n>` (see `browserBelongsToChat` in lib/chat-bar).
 *
 * An agent browser carries its identity beyond the process (browsers.js, `summarize`): `profile` is the
 * profile folder, `chatId`/`agentId` its parts (`agentId` empty = main agent). The `id` is that of a
 * Chromium SESSION and changes with every run of the agent — so the profile is what gets chosen
 * (lib/browser-choice.ts). `activeAt` (ms, 0 = never) is the agent's last activity (new tab, new
 * address), `agentTab` the tab for it. Optional because an older server does not send them.
 */
export interface BrowserInfo {
  id: string; kind: string; label: string; workspaceId: string; scopeKey: string; tabs: number;
  profile?: string; chatId?: string; agentId?: string; activeAt?: number; agentTab?: string;
  /** Only `kind` "user": the chat whose main agent currently holds this own browser ("" = none). */
  agentChat?: string;
}

