import { API_BASE, api } from "./core.js";
import type { ChatJob } from "./scheduled.js";

// ── Global event stream (/api/events) ────────────────────────────────────────
// ONE connection for ALL consumers, deliberately a module singleton.
//
// Why: a browser allows only SIX concurrent HTTP/1.1 connections per host and an SSE stream holds
// one permanently. With one stream per component plus the open chat's own stream the window was
// practically full, and the next ORDINARY request waited indefinitely for a free slot (visible as
// a chat that appears in the sidebar while the view stays on the empty hero: the send never
// reached the server).
export type GlobalEvent = { type?: string } & Record<string, unknown>;
let eventSource: EventSource | null = null;
const eventSubs = new Set<(evt: GlobalEvent) => void>();
// On connect the server sends "init" ONCE (running chats, open browsers). Late subscribers missed it,
// so the state is remembered and replayed.
//
// Remembering alone is not enough: the connection lives as long as ANY consumer holds it, and the
// header (runs pill) holds it on every page, so the remembered "init" would age for hours and a
// late subscriber would get that stale snapshot (a spinning hexagon for a finished chat, none for
// a new one). So the state is KEPT CURRENT: every run/browsers event updates it, and a late
// subscriber gets the CURRENT state instead of an old photo.
let lastInit: GlobalEvent | null = null;
const runningChats = new Set<string>();
// Same for open dynamic workflows: "init" carries `dynWorkflows: [{ chatId, runId }]` (the chat list's
// busy icon, lib/workflow-chats.ts), afterwards `dyn_workflow` reports start and end. The key is the
// runId (a chat can have two runs), the value the chatId. The event rule is duplicated here instead of
// imported from lib/workflow-chats.ts because lib/api/ is a leaf (global-events.test.mjs compiles it
// without a tsconfig); the check is the same: string ids, boolean `open`.
const openWorkflows = new Map<string, string>();

// An "init" carrying the current state, deliberately the same shape as the server frame so a
// consumer need not know whether it is the first or the tenth.
function initState(): GlobalEvent {
  return {
    ...lastInit, type: "init", running: [...runningChats],
    dynWorkflows: [...openWorkflows].map(([runId, chatId]) => ({ chatId, runId })),
  };
}

// Self-healing: delay before the next reconnect attempt (doubles up to 15 s).
let eventRetry: ReturnType<typeof setTimeout> | null = null;
let eventDelay = 1000;
let eventHealerOn = false;
let eventWatchdog: Watchdog | null = null;

// ── Watchdog against silently hanging streams ───────────────────────────────
// An EventSource reports only two states: events arrive, or the connection FAILED (`onerror`). A
// third exists: the connection stands and nothing arrives anymore (half-open TCP after sleep or a
// network change, a middlebox that stops forwarding). readyState stays OPEN, no `onerror`, no
// reconnect. So the server sends a named `ping` event every 25 s (an SSE COMMENT would be invisible
// to the EventSource API) and this watchdog rebuilds the stream when neither event nor heartbeat
// arrived within a deadline. Re-entry fetches the history via "connected".
export const HEARTBEAT_DEADLINE_MS = 70_000; // just under three server beats (25 s)
export type Watchdog = { stop: () => void; silence: () => number };
// Test rig only: a shorter deadline so "stream hangs silently" is measurable in seconds
// (a browser probe sets it before page load).
export function heartbeatDeadline(): number {
  const w = typeof window !== "undefined" ? (window as unknown as { __CBASE_SSE_DEADLINE?: number }).__CBASE_SSE_DEADLINE : undefined;
  return typeof w === "number" && w > 0 ? w : HEARTBEAT_DEADLINE_MS;
}
export function watch(es: EventSource, onStall: () => void, deadline = heartbeatDeadline()): Watchdog {
  let last = Date.now();
  const pulse = () => { last = Date.now(); };
  const kinds = ["open", "message", "ping"];
  for (const a of kinds) es.addEventListener(a, pulse);
  const stop = () => { clearInterval(timer); for (const a of kinds) es.removeEventListener(a, pulse); };
  // CONNECTING counts too: if the EventSource reconnects by itself after a clean abort and the peer
  // accepts and stays silent, it hangs just as silently. Only CLOSED is excluded (`onerror` handles
  // it). A background tab throttles the tick to a minute, so the focus healer also polls `silence()`.
  const timer = setInterval(() => {
    if (es.readyState === EventSource.CLOSED) return;
    if (Date.now() - last <= deadline) return;
    stop();
    onStall();
  }, Math.min(10_000, Math.max(1000, Math.round(deadline / 4))));
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop, silence: () => Date.now() - last };
}

// An EventSource reconnects by itself after an ordinary network drop. It becomes finally CLOSED only
// when the response was not 200/text-event-stream (gateway restart, container recreate, a proxy's
// error page); then the stream stayed dead forever. Hence this own rebuild.
function openGlobalStream(): void {
  if (eventRetry) { clearTimeout(eventRetry); eventRetry = null; }
  eventSource?.close();
  const es = new EventSource(`${API_BASE}/api/events`);
  es.onmessage = (e) => {
    let msg: GlobalEvent;
    try { msg = JSON.parse(e.data); } catch { return; } // a broken SSE frame must not throw
    eventDelay = 1000; // something arrived again → reset the delay
    if (msg.type === "init") {
      lastInit = msg;
      runningChats.clear();
      for (const id of Array.isArray(msg.running) ? (msg.running as string[]) : []) runningChats.add(id);
      // An older backend sends no `dynWorkflows` (= none known); later events are still correct.
      openWorkflows.clear();
      for (const z of Array.isArray(msg.dynWorkflows) ? (msg.dynWorkflows as unknown[]) : []) {
        const { chatId, runId } = (z ?? {}) as { chatId?: unknown; runId?: unknown };
        if (typeof chatId === "string" && chatId && typeof runId === "string" && runId) openWorkflows.set(runId, chatId);
      }
    } else if (msg.type === "run" && typeof msg.chatId === "string") {
      if (msg.running) runningChats.add(msg.chatId); else runningChats.delete(msg.chatId);
    } else if (msg.type === "dyn_workflow" && typeof msg.chatId === "string" && msg.chatId && typeof msg.runId === "string" && msg.runId
      && typeof msg.open === "boolean") {
      if (msg.open) openWorkflows.set(msg.runId, msg.chatId); else openWorkflows.delete(msg.runId);
    } else if (msg.type === "browsers" && Array.isArray(msg.list) && lastInit) {
      lastInit = { ...lastInit, browsers: msg.list };
    }
    // Dispatch over a copy: a consumer may unsubscribe meanwhile.
    for (const sub of [...eventSubs]) {
      try { sub(msg); } catch (err) { console.error(err); }
    }
  };
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return; // CONNECTING: the EventSource carries on by itself
    if (eventSource !== es || eventSubs.size === 0) return;
    if (eventRetry) clearTimeout(eventRetry);
    eventRetry = setTimeout(() => {
      eventRetry = null;
      if (eventSource === es && eventSubs.size > 0) openGlobalStream();
    }, eventDelay);
    eventDelay = Math.min(eventDelay * 2, 15_000);
  };
  eventSource = es;
  // Third healer: the watchdog against a silently hanging stream (see `watch`).
  eventWatchdog?.stop();
  eventWatchdog = watch(es, () => {
    if (eventSource !== es || eventSubs.size === 0) return;
    eventDelay = 1000;
    openGlobalStream();
  });
  // Second healer, no deadline: when the window returns or the network is back, look at once. A
  // retry timer may be throttled in a background tab, and after waking from sleep that is exactly
  // when the user looks again; a stream silent for minutes is as dead as a closed one.
  if (!eventHealerOn && typeof window !== "undefined") {
    eventHealerOn = true;
    const check = () => {
      if (eventSubs.size === 0) return;
      const silent = (eventWatchdog?.silence() ?? 0) > heartbeatDeadline();
      if (!eventSource || eventSource.readyState === EventSource.CLOSED || silent) { eventDelay = 1000; openGlobalStream(); }
    };
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
  }
}

export function subscribeGlobalEvents(fn: (evt: GlobalEvent) => void): () => void {
  eventSubs.add(fn);
  if (!eventSource) {
    eventDelay = 1000;
    openGlobalStream();
  } else if (lastInit) {
    fn(initState());
  }
  return () => {
    eventSubs.delete(fn);
    if (eventSubs.size === 0) {
      if (eventRetry) { clearTimeout(eventRetry); eventRetry = null; }
      eventWatchdog?.stop();
      eventWatchdog = null;
      eventSource?.close();
      eventSource = null;
      lastInit = null; // the next connection brings its own initial state
      runningChats.clear();
      openWorkflows.clear();
    }
  };
}

// File/folder download from the code viewer. `inline` returns the same bytes for display (image
// preview) instead of saving. `instance` (lib/code-instance.ts): the copy chosen in the code tab;
// without it the address is the default one.
export function fileDownloadUrl(apiBase: string, path: string, inline = false, instance: string | null = null): string {
  return `${API_BASE}${apiBase}/files/download?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}${instance ? `&instance=${encodeURIComponent(instance)}` : ""}`;
}

// Deliberately an anchor instead of fetch+Blob: the browser (and Electron) then streams straight to
// disk with its own download dialog; a GB-sized folder ZIP would otherwise sit entirely in renderer
// memory. The file name comes from Content-Disposition.
export function startFileDownload(apiBase: string, path: string, instance: string | null = null): void {
  const a = document.createElement("a");
  a.href = fileDownloadUrl(apiBase, path, false, instance);
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Claude connection (from `claude auth status --json`).
export interface AccountStatus {
  connected: boolean;
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
  error?: string;
}


export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** Server mode: the main instance (`projectbox/names.js` projectInstanceField). Per copy, `state` is the instance row's,
   *  `copyState` that of the copy row in stack_copies ("" without a live row). */
  instance?: { identifier: string; state: string; converted: boolean; name: string; container: string; copies?: { identifier: string; name: string; chatId: string; state: string; copyState: string }[] };
  /** Open setup (`projectbox/setup/status.js`); absent once finished. Display: lib/project-setup.ts. */
  setup?: Setup;
  /** Service detection (`{ status, since }`) while a state exists. */
  detection?: Detection;
  /** Remotes of a code repo that carry a credential in the URL: names only, never the value; stays after setup ends. */
  remoteHints?: { repo: string; remote: string }[];
  /** Open retroactive uploads (server `projectbox/setup/status.js` uploadView); absent when none is open. */
  uploads?: RetroactiveUpload[];
  /** The layout job (server `projectbox/layout/job.js` layoutRow) until it is done; absent without a job. `holders` counts
   *  only in `waiting`. Display: lib/project-setup.ts layoutRow. */
  layout?: LayoutRow;
  /** Old containers of renamed stacks that can still be removed (server `projectbox/setup/status.js`); absent at 0.
   *  Display: projects/OldContainerRemove.tsx on the services page. */
  superseded?: number;
  /** Number of code repos: the "Git" sub-item shows only for `repos > 0`. `null` = not read (does not show it and does not
   *  hide one already shown); a missing field (old server) keeps the sub-item as before. Reading: components/projects/ProjectsPane.tsx `hatGitRepos`. */
  repos?: number | null;
}

export interface LayoutRow {
  state: "waiting" | "running" | "error";
  /** The turning point (`docker-away`) is passed; from then on it only goes forward. */
  turned: boolean;
  /** A way back is pending (after a restart before the turning point) or failed. */
  backward: boolean;
  step: string;
  error: string | null;
  since: number;
  holders: number;
}

/** A retroactive operation. `state` `unpack` occurs only for an archive being placed; `interrupted`: no process works on it (in
 *  `upload`: no chunk younger than the upload idle time; otherwise a foreign boot id or "Abort"). */
export interface RetroactiveUpload {
  operation: string;
  kind: "files" | "archive";
  state: "upload" | "place" | "unpack" | "error";
  since?: number;
  newFolders?: string[];
  archiveId?: string;
  lastChunk?: number;
  conflict?: "overwrite" | "skip";
  interrupted?: true;
  /** Archive in `upload` only: the announced size. */
  bytes?: number;
  /** Files in `upload` without an open chunk only: how many files sit in staging (`capped`: at least that many). */
  staged?: number;
  capped?: true;
  code?: string;
  error?: string;
  /** `error` with `code: "CONFLICT"` only. */
  existing?: number;
  examples?: string[];
}

// The setup of a new project as seen from outside (server `store/project-setup.js` setupView). Here and not in
// lib/project-setup.ts because lib/api/ is a leaf (import nothing from outside, global-events.test.mjs).
export type SourceKind = "files" | "folder" | "zip" | "clone";
export type SourceState =
  | "wait-upload" | "staged" | "unpack" | "clone" | "submodule" | "lfs" | "error" | "aborted" | "leftOut";
export type SetupStep = "container" | "sources" | "place" | "code-repos" | "project-repo";
export interface SetupSource {
  seq: number;
  kind: SourceKind;
  target: string;
  state: SourceState;
  /** ZIP only: file name and last announced size of the archive (identity on resume). */
  name?: string;
  bytes?: number;
  code?: string;
  error?: string;
  host?: string;
  /** Clone only: the address without user info and the branch (absent = the repository default). */
  url?: string;
  branch?: string;
  /** Clone only: the repository itself is fetched (server `cloneFetched`); "Take as is" accepts it without missing submodules/LFS. */
  fetched?: boolean;
  /** START of the last chunk request (ms). */
  lastChunk?: number;
}
export interface Setup {
  state: "setUp" | "error";
  step: SetupStep;
  phase?: string;
  error?: string;
  code?: string;
  waiting?: "container" | "storage" | "conflict";
  conflict?: { existing: number; examples: string[] };
  sources: SetupSource[];
}
export interface Detection { status: "running" | "done" | "error"; since: number | null }

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  projects: Project[];
}

export interface Chat {
  id: string;
  workspaceId: string;
  projectId: string | null;
  // Chat folder: purely logical grouping of the chat list (not a file-system folder). Chats of the
  // same folder read each other's artifacts while they sit together.
  folderId: string | null;
  title: string;
  model: string;
  permissionMode: string;
  effort: string;
  /** Ultracode: a SWITCH next to the effort level, not a level, independent of `effort`. Absent (old server) = off. */
  ultracode?: boolean;
  provider?: string;
  browserMode?: string;
  contextTokens: number;
  goal: string;
  /** The goal is paused: set via PATCH /api/chats/:id { goalPaused } (400 without a goal or on a non-boolean); any set or clear of
   *  `goal` lifts the pause on the server. Absent on an older server = nothing paused. */
  goalPaused?: boolean;
  contextSummary: string;
  claudeSessionId: string | null;
  pinned: boolean;
  /** Notification choice per kind; empty = follows the default everywhere. */
  notify?: Record<string, "on" | "off">;
  /** Auto-compact: null/absent = default, 0 = off, else the stage in percent. */
  autocompact?: number | null;
  /** The cap in tokens per chat, same three-valued logic. */
  autocompactMax?: number | null;
  /** Kind (normal · manager · …); `GET /api/chats/:id` returns it, the list only `normal`. */
  kind?: string;
  /** Archive: ms, null = active. Archived means read-only until "Restore". */
  archivedAt?: number | null;
  /** Who archived: "user" (by hand) or "auto" (the "Archive chats automatically" tick); null = active. Absent on an older
   *  server: then unknown, never "auto". */
  archiveReason?: "user" | "auto" | null;
  /** Graph workflows: the chat that started this one as a background run; only `GET /api/chats/:id` of a child chat carries it;
   *  child chats appear in no list (lib/archive.ts `openTargetProcedure` sets their metadata). */
  parentChatId?: string | null;
  /** The provider BEHIND a router that delivered the last answer, and its window (0 = unknown); only for the context bar
   *  (`lib/context-display.ts`); the catalog number is used for calculation. Live: `harness/provider`. */
  upstreamProvider?: string;
  upstreamWindow?: number;
  /** The copy this chat works IN, with its state (from `chats.instance`, not the one it was created in); only `GET /api/chats`
   *  carries it; null = main, `state: "removed"` = binding without a live row. Read via `chatCopyLocation`
   *  (lib/chat-location.ts): the name always comes from `instance`. */
  copy?: { name: string; state: string } | null;
  /** The instance the chat works in: null/absent = main, else the identifier of a copy (`copy-<name>`).
   *  Changed via PATCH /api/chats/:id { instance } (lib/api/instances.ts), read via `chatInstanceName`. */
  instance?: string | null;
  /** This chat's scheduled job: only `GET /api/chats` carries it, `null` without a job; absent on an older server. Raw; read via
   *  `normChatJob` (lib/api/scheduled.ts). */
  job?: ChatJob | null;
  createdAt: number;
  updatedAt: number;
}

// Auto-compact: the global stage and the allowed stages; the server is the source of the list, the UI only draws it. 0 means off.
// `maxTokens` is the absolute cap: compaction happens at the EARLIER of share and cap. 0 means "no cap"; with `percent` at 0
// the rule is off entirely.
export interface AutocompactDoc { percent: number; stages: number[]; maxTokens: number; maxStages: number[] }
export const loadAutocompact = () => api<AutocompactDoc>("/api/autocompact");
// Both fields can be set individually; whoever moves one slider does not send the other.
export const saveAutocompact = (values: { percent?: number; maxTokens?: number }) =>
  api<AutocompactDoc & { ok: boolean }>("/api/autocompact", { method: "PUT", body: JSON.stringify(values) });

// Chat-list folder. It belongs to a workspace and optionally ONE project; only chats of the same scope may go in (the server
// rejects others).
export interface ChatFolder {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  /** Folder kind: "normal" (coding chats). The web UI queries only coding folders. */
  kind?: "normal";
  chatCount?: number;
  /** Archive: ms, null = active. An archived folder is listed only with `archive=only|including`. */
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The area of a skill: the web client shows and creates only coding skills (workspace or project); a skill of another area that
 *  a server still sends drops out in `lib/api/skills.ts:onlyArea`. */
export type SkillArea = "coding";

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  hasResources?: boolean;
  /** The truth the UI reads. A coding skill is maintained under Coding → Skills. */
  area: SkillArea;
  /** State as 16 hex characters, the latest change not taken back, and an open deletion request. Read via lib/api/skill-history.ts
   *  (`readLastChange`, `readOpenRequest`); an older server does not send them, then `undefined` and the row stays silent. */
  version?: string;
  lastChange?: SkillLastChange | null;
  openRequest?: SkillOpenRequest | null;
}

/** The latest change of a skill not taken back. `chatId`/`chatTitle` only for `who: "agent"`. */
export interface SkillLastChange { who: "human" | "agent"; chatId: string | null; chatTitle: string | null; at: number }
/** An open deletion request of a skill. */
export interface SkillOpenRequest { id: string; chatTitle: string | null; at: number }

export interface Skill extends SkillMeta {
  body: string;
  raw?: string;
}

