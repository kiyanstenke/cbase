// The agenda per Coding chat: the plan that the agent of a Coding chat keeps for itself — title, description
// (Markdown) and the steps with status. It is written ONLY by the chat's main agent (tool cbase_agenda_write,
// server `server/backend/electron/server/agenda/`); the UI only reads: `GET /api/chats/:id/agenda` and the event
// `harness/agenda` in the chat's stream (the wrapper in ChatPane hands it to `components/chat/chatAgenda.ts`).
//
// Leaf module (README there): imports only from lib/api/, with the `.js` ending. Every response and every event
// goes through `normAgenda` with a default per field — a missing field leaves the bar readable instead of tearing
// it down; a step without an id drops out, an unknown status reads as "open" as on the server (store/agenda.js:
// better one open step too many than a silently vanished one). The status list is bound to the server
// (web/test/agenda.test.mjs reads store/agenda.js).
//
// It is a TREE: `steps` stays a flat list in PRE-ORDER (every point stands immediately before its subtree), with
// per point `parent`, `depth`, `subitems`, `done`/`total` (leaves in the subtree) and `project`. The status of a
// point with sub-points is the one COMPUTED on the server — the UI does not recompute it, it shows it. An older
// server does not send the new fields: then every point is a leaf of the top level (`parent` null, `depth` 0, no
// sub-points).
//
// A point carries `upkeep`: the mark of the agenda keeper — a built-in outer-loop agent that catches up on what
// the main agent forgot. Display only. The mark STAYS when the main agent or the server touches the point
// afterwards, and carries `afterwards` — what has happened since, from the keeper's log; only a later change by
// the keeper replaces it. The server deliberately does NOT send `upkeepLock` (internals), so it is not here.
import { api } from "./core.js";

export const AGENDA_STATUS = ["open", "in_work", "done"] as const;
export type AgendaStatus = (typeof AGENDA_STATUS)[number];

/** The project of a top-level point, resolved at read time — a deleted project comes as `null`. */
export interface AgendaProject {
  id: string;
  name: string;
}

/** What the agenda keeper did to a point: created it (`fresh`) or advanced the status (`status`). */
export type AgendaUpkeepKind = "fresh" | "status";

/** What happened after the mark (server agenda/operations.js AGENDA_UPKEEP_AFTERWARDS, bound in server/backend/test/agenda.test.js):
 *  `open` nobody (or only the server), `confirmed` edited by the main agent, `corrected` taken back by it,
 *  `outdated` taken over by it. */
export const AGENDA_UPKEEP_AFTERWARDS = ["open", "confirmed", "corrected", "outdated"] as const;
export type AgendaUpkeepAfterwards = (typeof AGENDA_UPKEEP_AFTERWARDS)[number];

/** The agenda keeper's mark — `null` on a point means: the keeper did not create or set it (or
 *  the "mark changes" switch was off). */
export interface AgendaUpkeep {
  agentId: string;
  runId: string;
  /** Time of the change (ms); 0 = unknown (then without "… ago"). */
  at: number;
  kind: AgendaUpkeepKind;
  /** For `status` the status before, otherwise `null`. */
  prior: AgendaStatus | null;
  /** What happened afterwards — `null` = unknown (an older server, no log line), not "nothing". */
  afterwards: AgendaUpkeepAfterwards | null;
}

export interface AgendaStep {
  id: string;
  /** Id of the parent point; `null` = top level. */
  parent: string | null;
  /** 0 = top level. */
  depth: number;
  /** Heading (≤ 80 characters for newly written texts; older ones can be longer). */
  text: string;
  /** Markdown; in the bar visible only via the note sign. */
  note: string;
  /** Leaf: its own; with sub-points: computed on the server from the leaves. */
  status: AgendaStatus;
  /** Number of DIRECT children — only a point with sub-points can be collapsed. */
  subitems: number;
  /** Done leaves in the subtree (0 without sub-points). */
  done: number;
  /** Leaves in the subtree (0 without sub-points). */
  total: number;
  /** Only on top-level points; `null` = none or deleted. */
  project: AgendaProject | null;
  createdAt: number;
  changedAt: number;
  doneAt: number | null;
  /** Created or set by the agenda keeper — stays after other writers (`afterwards`); otherwise `null`. */
  upkeep: AgendaUpkeep | null;
}

export interface Agenda {
  chatId: string;
  title: string;
  description: string;
  steps: AgendaStep[];
  /** 0 = never written; every change counts one up — the bar accepts only a NEWER revision (event against load response). */
  version: number;
  /** null = never written (not "0 ms ago"). */
  changedAt: number | null;
  /** How many finished subtrees lie in the chat's archive (the "Archive (n)" row) — 0 on an older server. */
  archived: number;
}

export interface AgendaState {
  agenda: Agenda;
  /** false: the chat keeps no agenda (not a Coding chat) — the bar says so instead of showing "none yet". */
  keepsAgenda: boolean;
}

const isStatus = (v: unknown): v is AgendaStatus => typeof v === "string" && (AGENDA_STATUS as readonly string[]).includes(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
/** A count or depth: integer ≥ 0, anything else 0 (like `Int(…)` in the Swift twin: truncated, not rounded). */
const whole = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function normProject(raw: unknown): AgendaProject | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  return typeof p.id === "string" && p.id ? { id: p.id, name: text(p.name) } : null;
}

/** A mark needs a known kind — an unknown one (a newer server) rather shows nothing than something wrong. */
function normUpkeep(raw: unknown): AgendaUpkeep | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.kind !== "fresh" && p.kind !== "status") return null;
  return {
    agentId: text(p.agentId),
    runId: text(p.runId),
    at: count(p.at) > 0 ? count(p.at) : 0, // 0 = unknown, as in the Swift twin
    kind: p.kind,
    prior: p.kind === "status" && isStatus(p.prior) ? p.prior : null,
    afterwards: typeof p.afterwards === "string" && (AGENDA_UPKEEP_AFTERWARDS as readonly string[]).includes(p.afterwards) ? (p.afterwards as AgendaUpkeepAfterwards) : null,
  };
}

function normStep(raw: unknown): AgendaStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id) return null;
  const status = isStatus(s.status) ? s.status : "open";
  const done = count(s.doneAt);
  return {
    id: s.id,
    parent: typeof s.parent === "string" && s.parent ? s.parent : null,
    depth: whole(s.depth),
    text: text(s.text),
    note: text(s.note),
    status,
    subitems: whole(s.subitems),
    done: whole(s.done),
    total: whole(s.total),
    project: normProject(s.project),
    createdAt: count(s.createdAt),
    changedAt: count(s.changedAt) || count(s.createdAt),
    doneAt: status === "done" && done ? done : null,
    upkeep: normUpkeep(s.upkeep),
  };
}

/** An agenda from a response or event — `chatId` is the chat that was asked for (if the response lacks it, it applies). */
export function normAgenda(raw: unknown, chatId: string): Agenda {
  const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    chatId: typeof a.chatId === "string" && a.chatId ? a.chatId : chatId,
    title: text(a.title),
    description: text(a.description),
    steps: Array.isArray(a.steps) ? a.steps.map(normStep).filter((s): s is AgendaStep => s !== null) : [],
    version: count(a.version),
    changedAt: count(a.changedAt) || null,
    archived: whole(a.archived),
  };
}

/** A chat's agenda. Throws like every call (`api`); `keepsAgenda` is missing only on an older server — then "yes" applies. */
export async function loadAgenda(chatId: string): Promise<AgendaState> {
  const r = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(chatId)}/agenda`);
  return { agenda: normAgenda(r?.agenda, chatId), keepsAgenda: r?.keepsAgenda !== false };
}

// ── The archive ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A finished subtree leaves the active tree (by the main agent or the server's sweep) and becomes ONE archive entry: its root
// text, its leaf count, when it was done and archived, and by whom. The rail lists them read-only behind "Archive (n)"
// (`GET …/agenda/archive`, newest first, paged by entry id) and opens one via `GET …/agenda?point=<rootId>`. With `q` the
// same route also answers the search hits over the active tree AND the archive.

/** Who archived: the main agent (`main`) or the server's sweep of long-finished subtrees (`auto`). */
export type AgendaArchiveBy = "main" | "auto";

export interface AgendaArchiveEntry {
  /** Entry id (a number, newest = highest) — `before` pages with it. */
  id: number;
  /** The archived subtree's root point — `?point=` opens it. */
  rootId: string;
  text: string;
  leaves: number;
  doneAt: number | null;
  archivedAt: number;
  by: AgendaArchiveBy;
}

/** A search hit from the server: `path` = the ancestor texts, `entryId` and `rootId` (the archived subtree's root) only on an
 *  archived hit. */
export interface AgendaArchiveHit {
  id: string;
  text: string;
  status: AgendaStatus;
  path: string[];
  archived: boolean;
  entryId: number | null;
  rootId: string | null;
}

export interface AgendaArchivePage {
  entries: AgendaArchiveEntry[];
  more: boolean;
  total: number;
  hits: AgendaArchiveHit[];
  hitsMore: boolean;
}

function normEntry(raw: unknown): AgendaArchiveEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const id = whole(e.id);
  if (!id || typeof e.rootId !== "string" || !e.rootId) return null;
  return {
    id, rootId: e.rootId, text: text(e.text), leaves: whole(e.leaves),
    doneAt: count(e.doneAt) || null, archivedAt: count(e.archivedAt), by: e.by === "auto" ? "auto" : "main",
  };
}

function normHit(raw: unknown): AgendaArchiveHit | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.id !== "string" || !h.id) return null;
  return {
    id: h.id, text: text(h.text), status: isStatus(h.status) ? h.status : "open",
    path: Array.isArray(h.path) ? h.path.map(text) : [], archived: h.archived === true, entryId: whole(h.entryId) || null,
    rootId: typeof h.rootId === "string" && h.rootId ? h.rootId : null,
  };
}

/** An archive page (and search hits) from a response — every field with a default, an entry without id or root drops out. */
export function normArchivePage(raw: unknown): AgendaArchivePage {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = <X,>(v: unknown, f: (x: unknown) => X | null): X[] => (Array.isArray(v) ? v.map(f).filter((x): x is X => x !== null) : []);
  return { entries: list(r.entries, normEntry), more: r.more === true, total: whole(r.total), hits: list(r.hits, normHit), hitsMore: r.hitsMore === true };
}

/** One page of a chat's archive — `before` the last entry id of the page before, `q` adds the search hits. */
export async function loadAgendaArchive(chatId: string, opts: { before?: number; limit?: number; q?: string } = {}): Promise<AgendaArchivePage> {
  const qs = new URLSearchParams();
  if (opts.before) qs.set("before", String(opts.before));
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.q?.trim()) qs.set("q", opts.q.trim());
  const tail = qs.toString();
  const r = await api<unknown>(`/api/chats/${encodeURIComponent(chatId)}/agenda/archive${tail ? `?${tail}` : ""}`);
  return normArchivePage(r);
}

/** The subtree of one point, every status — active or archived (`archived`); the steps in preorder, the root first. */
export async function loadAgendaPoint(chatId: string, pointId: string): Promise<{ agenda: Agenda; archived: boolean }> {
  const r = await api<Record<string, unknown>>(`/api/chats/${encodeURIComponent(chatId)}/agenda?point=${encodeURIComponent(pointId)}`);
  const point = r?.point && typeof r.point === "object" ? (r.point as Record<string, unknown>) : {};
  return { agenda: normAgenda(r?.agenda, chatId), archived: point.archived === true };
}
