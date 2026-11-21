// History, deletion requests and switches of skills (the routes and JSON shapes are the contract with server and iOS). The main agents
// of coding chats write skills themselves (`cbase_skill_write`): creating and changing take effect at once, deleting is a request that
// the human approves. Every change is in the history and can be reverted as long as the skill has not changed since; the SERVER
// computes that (`revertible`), the UI only shows the button.
//
// Every answer goes through a `read*` function with a default per field: an entry without an id or with an unknown kind drops out, a
// missing `revertible` means NO (no button that asserted a state nobody knew), a missing switch value is `null` ("not said"), never "on".
//
// Leaf module: imports only from lib/api/ (README there).
import { api } from "./core.js";
import type { SkillLastChange, SkillOpenRequest } from "./events.js";

const enc = encodeURIComponent;

export type SkillHistoryKind = "create" | "change" | "erase";
export type SkillActor = "human" | "agent";
export type SkillRequestStatus = "open" | "approved" | "rejected" | "expired";
export const SKILL_REQUEST_STATUS: readonly SkillRequestStatus[] = ["open", "approved", "rejected", "expired"];

/** A state of a skill in the history (`prior`/`after`). On a 409 of the revert the server may send only `version`; the other fields
 *  are then `null` ("not said"), never empty. */
export interface SkillStatusImage {
  name: string | null;
  description: string | null;
  body: string | null;
  version: string | null;
  hasResources: boolean | null;
  hiddenIn: string[];
}

export interface SkillHistoryEntry {
  id: string;
  skillId: string;
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  kind: SkillHistoryKind;
  /** `null` = the server did not say. */
  who: SkillActor | null;
  chatId: string | null;
  chatTitle: string | null;
  prior: SkillStatusImage | null;
  after: SkillStatusImage | null;
  trash: boolean;
  requestId: string | null;
  at: number;
  revertedAt: number | null;
  revertible: boolean;
}

export interface SkillRequest {
  id: string;
  skillId: string;
  skillName: string;
  workspaceId: string;
  projectId: string | null;
  version: string;
  chatId: string | null;
  chatTitle: string | null;
  reason: string | null;
  status: SkillRequestStatus;
  at: number;
  decidedAt: number | null;
  /** Skill present AND version equal; if the field is missing, NO (no approval on a guess). */
  current: boolean;
}

/** What an event `{type:"skills", …}` of the global stream says. */
export interface SkillsEvent {
  workspaceId: string;
  projectId: string | null;
  skillId: string | null;
  kind: string;
  requestId: string | null;
}

export type SkillSettings = { agentsWrite: boolean | null };
export type SkillSettingsBody = { agentsWrite: boolean };
export type SkillDecisionBody = { approve: boolean };

type Raw = Record<string, unknown>;
const obj = (x: unknown): Raw | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Raw) : null);
const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
/** A point in time in ms. A number below 10^12 reads as seconds (a server writing `at` in seconds would otherwise stand in 1970). */
const time = (x: unknown): number | null => {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return null;
  return x < 1e12 ? Math.round(x * 1000) : x;
};

export function readStatusImage(raw: unknown): SkillStatusImage | null {
  const r = obj(raw);
  if (!r) return null;
  const text = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    name: text(r.name),
    description: text(r.description),
    body: text(r.body),
    version: str(r.version),
    hasResources: typeof r.hasResources === "boolean" ? r.hasResources : null,
    hiddenIn: Array.isArray(r.hiddenIn) ? r.hiddenIn.filter((p): p is string => typeof p === "string") : [],
  };
}

const KINDS: readonly SkillHistoryKind[] = ["create", "change", "erase"];

export function readHistoryEntry(raw: unknown): SkillHistoryEntry | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id);
  const kind = KINDS.find((a) => a === r.kind);
  const at = time(r.at);
  if (!id || !kind || at === null) return null;
  return {
    id,
    skillId: str(r.skillId) ?? "",
    workspaceId: str(r.workspaceId) ?? "",
    projectId: str(r.projectId),
    projectName: str(r.projectName),
    kind,
    who: r.who === "agent" || r.who === "human" ? r.who : null,
    chatId: str(r.chatId),
    chatTitle: str(r.chatTitle),
    prior: readStatusImage(r.prior),
    after: readStatusImage(r.after),
    trash: r.trash === true || r.trash === 1,
    requestId: str(r.requestId),
    at,
    revertedAt: time(r.revertedAt),
    revertible: r.revertible === true,
  };
}

export function readRequest(raw: unknown): SkillRequest | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id);
  const status = SKILL_REQUEST_STATUS.find((s) => s === r.status);
  if (!id || !status) return null;
  return {
    id,
    skillId: str(r.skillId) ?? "",
    skillName: str(r.skillName) ?? "",
    workspaceId: str(r.workspaceId) ?? "",
    projectId: str(r.projectId),
    version: str(r.version) ?? "",
    chatId: str(r.chatId),
    chatTitle: str(r.chatTitle),
    reason: str(r.reason),
    status,
    at: time(r.at) ?? 0,
    decidedAt: time(r.decidedAt),
    current: r.current === true,
  };
}

/** `lastChange` of a list row: `null` for "none" AND for "not said"; the row stays silent in both cases. */
export function readLastChange(raw: unknown): SkillLastChange | null {
  const r = obj(raw);
  const at = r ? time(r.at) : null;
  if (!r || at === null || (r.who !== "agent" && r.who !== "human")) return null;
  return { who: r.who, chatId: str(r.chatId), chatTitle: str(r.chatTitle), at };
}

/** `openRequest` of a list row. */
export function readOpenRequest(raw: unknown): SkillOpenRequest | null {
  const r = obj(raw);
  const id = r ? str(r.id) : null;
  if (!r || !id) return null;
  return { id, chatTitle: str(r.chatTitle), at: time(r.at) ?? 0 };
}

/** The three history fields of a skill answer, read; the rest of the entry stays as it came. */
export function withHistoryFields<T extends object>(s: T): T {
  const r = s as Raw;
  return {
    ...s,
    version: str(r.version) ?? undefined,
    lastChange: readLastChange(r.lastChange),
    openRequest: readOpenRequest(r.openRequest),
  };
}

/** An event `skills` of the global stream; otherwise `null`. */
export function skillsEvent(evt: unknown): SkillsEvent | null {
  const r = obj(evt);
  if (!r || r.type !== "skills") return null;
  const workspaceId = str(r.workspaceId);
  if (!workspaceId) return null;
  return { workspaceId, projectId: str(r.projectId), skillId: str(r.skillId), kind: typeof r.kind === "string" ? r.kind : "", requestId: str(r.requestId) };
}

const entries = (raw: unknown): SkillHistoryEntry[] => {
  const list = obj(raw)?.entries;
  return (Array.isArray(list) ? list : []).map(readHistoryEntry).filter((e): e is SkillHistoryEntry => e !== null);
};

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The history of a workspace or a skill, newest first (`GET …/skill-history?skillId=&limit=`). */
export async function loadSkillHistory(workspaceId: string, opts: { skillId?: string | null; limit?: number } = {}): Promise<SkillHistoryEntry[]> {
  const q = new URLSearchParams();
  if (opts.skillId) q.set("skillId", opts.skillId);
  if (opts.limit) q.set("limit", String(opts.limit));
  const s = q.toString();
  return entries(await api<unknown>(`/api/workspaces/${enc(workspaceId)}/skill-history${s ? `?${s}` : ""}`));
}

/** "Recently deleted": delete entries, not reverted, skill missing (`GET …/skill-deleted`). */
export async function loadDeletedSkills(workspaceId: string): Promise<SkillHistoryEntry[]> {
  return entries(await api<unknown>(`/api/workspaces/${enc(workspaceId)}/skill-deleted`));
}

/** Revert an entry (also "Restore" of a deleted skill). Throws on 409; `skillWriteError` reads the fields. */
export function takeSkillChangeBack(entryId: string): Promise<{ ok: true; skill?: unknown }> {
  return api(`/api/skill-history/${enc(entryId)}/revert`, { method: "POST" });
}

/** A reference: an agent definition that carries the skill in its `skills` list. */
export interface SkillReference { id: string; name: string; level: string | null }

export interface SkillWriteError {
  text: string;
  /** Stale version: the skill has changed since; both states, as far as the server names them. */
  conflict: { current: SkillStatusImage | null; expected: SkillStatusImage | null } | null;
  references: SkillReference[] | null;
  existing: { id: string | null; name: string; level: string | null } | null;
}

/** The fields of a thrown error of the history and request routes (core.ts attaches the body to the Error). */
export function skillWriteError(e: unknown): SkillWriteError {
  const f = (e ?? {}) as Raw;
  const references = Array.isArray(f.references)
    ? f.references.flatMap((v) => {
      const r = obj(v);
      const name = r ? str(r.name) : null;
      return r && name ? [{ id: str(r.id) ?? "", name, level: str(r.level) }] : [];
    })
    : null;
  const existing = obj(f.existing);
  const statusOrVersion = (x: unknown): SkillStatusImage | null =>
    typeof x === "string" ? { name: null, description: null, body: null, version: x, hasResources: null, hiddenIn: [] } : readStatusImage(x);
  return {
    text: e instanceof Error ? e.message : String(f.error ?? e ?? ""),
    conflict: f.conflict === true ? { current: statusOrVersion(f.current), expected: statusOrVersion(f.expected) } : null,
    references,
    existing: existing && str(existing.name) ? { id: str(existing.id), name: str(existing.name) as string, level: str(existing.level) } : null,
  };
}

/** The requests of a workspace, default the open ones (`GET …/skill-requests?status=`). */
export async function loadSkillRequests(workspaceId: string, status: SkillRequestStatus | null = "open"): Promise<SkillRequest[]> {
  const raw = await api<unknown>(`/api/workspaces/${enc(workspaceId)}/skill-requests${status ? `?status=${status}` : ""}`);
  const list = obj(raw)?.requests;
  return (Array.isArray(list) ? list : []).map(readRequest).filter((a): a is SkillRequest => a !== null);
}

/** A request (`GET /api/skill-requests/:id`). Throws if the answer is none; an invented card would be worse than an error. */
export async function loadSkillRequest(id: string): Promise<SkillRequest> {
  const a = readRequest(await api<unknown>(`/api/skill-requests/${enc(id)}`));
  if (!a) throw new Error("Response without a request");
  return a;
}

/** Approve (the skill is deleted) or reject. The body ALWAYS carries the boolean; without it the server answers 400. */
export async function decideSkillRequest(id: string, approve: boolean): Promise<SkillRequest | null> {
  const body: SkillDecisionBody = { approve };
  const r = await api<unknown>(`/api/skill-requests/${enc(id)}/decide`, { method: "POST", body: JSON.stringify(body) });
  return readRequest(obj(r)?.request);
}

const settings = (raw: unknown): SkillSettings => {
  const v = obj(raw)?.agentsWrite;
  return { agentsWrite: typeof v === "boolean" ? v : null };
};

/** The switch "Agents may change skills" (`GET …/skill-settings`). */
export async function loadSkillSettings(workspaceId: string): Promise<SkillSettings> {
  return settings(await api<unknown>(`/api/workspaces/${enc(workspaceId)}/skill-settings`));
}

export async function setSkillSettings(workspaceId: string, agentsWrite: boolean): Promise<SkillSettings> {
  const body: SkillSettingsBody = { agentsWrite };
  return settings(await api<unknown>(`/api/workspaces/${enc(workspaceId)}/skill-settings`, { method: "PUT", body: JSON.stringify(body) }));
}
