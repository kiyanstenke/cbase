// Scheduled jobs in Coding: a job hangs on EXACTLY one coding chat, every appointment is a message to that chat. The contract is
// `server/backend/electron/server/scheduled/contract.js` (a leaf without imports); the lists appear here as constants of their own
// because the contract lies outside lib/api/ and must not be imported here. Both are bound in web/test/scheduled-binding.test.mjs:
// every list equal, every normalizer returns exactly the contract's fields; the types hang on the field lists via
// `SCHEDULED_TYPES_BOUND` (tsc).
//
// Leaf module (README there): imports only from lib/api/, with a `.js` ending. Every answer goes through `norm*` with a default per
// field: a missing field leaves the list readable; a job without an id drops out, and an unknown status does not read as "active"
// (a paused job shown as running would be a claim) but stays `null` and is not sorted in.
//
// The run values (name = title, project, instance, provider, model, effort, permission mode, notification choice) live on the CHAT:
// they are set with the POST here (the same calculation as POST /api/chats, only the permission mode is mandatory) and changed via
// PATCH /api/chats/:id. The job's PATCH takes only `SCHEDULED_PATCH_FIELDS`.
import { api } from "./core.js";

export const SCHEDULED_CADENCES = ["oneTime", "daily", "workdays", "weekly", "monthly"] as const;
export type ScheduledCadence = (typeof SCHEDULED_CADENCES)[number];
/** Monthly only day 1–28: Vixie cron would otherwise skip whole months. */
export const SCHEDULED_DAY_OF_MONTH = { min: 1, max: 28 } as const;
export const SCHEDULED_JOB_STATUS = ["active", "paused", "done"] as const;
export type ScheduledStatus = (typeof SCHEDULED_JOB_STATUS)[number];
export const SCHEDULED_RUN_CAUSES = ["tick", "hand", "caughtUp", "repetition"] as const;
export type ScheduledCause = (typeof SCHEDULED_RUN_CAUSES)[number];
export const SCHEDULED_RUN_STATUS = ["open", "ok", "error", "aborted", "missed", "failed", "dismissed"] as const;
export type ScheduledRunStatus = (typeof SCHEDULED_RUN_STATUS)[number];
/** The derived state (computed on the server, never stored); `null` means "none of them". */
export const SCHEDULED_STATES = ["queued", "running", "parked"] as const;
export type ScheduledState = (typeof SCHEDULED_STATES)[number];
export const SCHEDULED_INSTRUCTIONS_MAX = 20_000;
export const SCHEDULED_PATCH_FIELDS = ["instructions", "cadence", "plan", "timeZone", "status"] as const;
/** The fields of a job (contract.js JOB_FIELDS) and what the routes add (JOB_DERIVED). */
export const SCHEDULED_JOB_FIELDS = [
  "id", "workspaceId", "chatId", "instructions", "cadence", "plan", "timeZone",
  "status", "nextAt", "retryAt", "lastRunAt", "lastStatus", "lastError", "createdAt", "updatedAt",
] as const;
export const SCHEDULED_JOB_DERIVED = ["name", "projectId", "cadenceText", "state", "lastRun"] as const;
/** The fields of a run (contract.js RUN_FIELDS). */
export const SCHEDULED_RUN_FIELDS = [
  "id", "jobId", "workspaceId", "chatId", "cause", "scheduledAt", "queuedAt", "startedAt", "endedAt",
  "status", "error", "short", "question",
] as const;
/** The field `job` on a row of GET /api/chats (contract.js CHAT_JOB_FIELDS). */
export const SCHEDULED_CHAT_JOB_FIELDS = ["id", "name", "status", "nextAt"] as const;

/** The plan per cadence: `clockTime` "HH:MM" in the job's zone; `days` 0 = Sunday … 6 = Saturday; `at` ms. */
export type ScheduledPlan = { at?: number; clockTime?: string; days?: number[]; day?: number };

export interface ScheduledRun {
  id: string;
  jobId: string;
  workspaceId: string;
  chatId: string | null;
  cause: ScheduledCause | null;
  scheduledAt: number;
  /** 0 = not queued yet (the appointment waits). */
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  status: ScheduledRunStatus | null;
  error: string;
  short: string;
  question: boolean;
}

export interface ScheduledJob {
  id: string;
  workspaceId: string;
  chatId: string | null;
  instructions: string;
  cadence: ScheduledCadence | null;
  plan: ScheduledPlan;
  timeZone: string;
  /** `null` = a status this client does not know; it appears in no segment. */
  status: ScheduledStatus | null;
  /** 0 = no upcoming appointment. */
  nextAt: number;
  retryAt: number;
  lastRunAt: number;
  lastStatus: string;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  /** Derived: name and project of the chat, the cadence in the server's plain text, state and last run. */
  name: string;
  projectId: string | null;
  cadenceText: string;
  state: ScheduledState | null;
  lastRun: ScheduledRun | null;
}

/** The field `job` on a row of GET /api/chats (contract.js CHAT_JOB_FIELDS); `null` without a job. */
export interface ChatJob {
  id: string;
  name: string;
  status: ScheduledStatus | null;
  nextAt: number;
}

/** `true` if type `A` carries exactly the keys of list `L`; otherwise `false`, and the assignment below is a type error
 *  (pattern lib/api/preview.ts). */
type SameKeys<A, L extends readonly string[]> = [Exclude<keyof A, L[number]>, Exclude<L[number], keyof A>] extends [never, never] ? true : false;
/** `true` if every key of `A` is in list `L` (a body may carry fewer, never foreign ones). */
type OnlyKey<A, L extends readonly string[]> = [Exclude<keyof A, L[number]>] extends [never] ? true : false;
/** Binds the types to the lists (exported so no "unused" check removes it). */
export const SCHEDULED_TYPES_BOUND: [
  SameKeys<ScheduledJob, readonly [...typeof SCHEDULED_JOB_FIELDS, ...typeof SCHEDULED_JOB_DERIVED]>,
  SameKeys<ScheduledRun, typeof SCHEDULED_RUN_FIELDS>,
  SameKeys<ChatJob, typeof SCHEDULED_CHAT_JOB_FIELDS>,
  OnlyKey<ScheduledChange, typeof SCHEDULED_PATCH_FIELDS>,
] = [true, true, true, true];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
// A run's id is a number on the server (AUTOINCREMENT), a job's a UUID; both continue here as text.
const identifier = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : str(v));
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => ((list as readonly unknown[]).includes(v) ? (v as T) : null);

function normPlan(raw: unknown): ScheduledPlan {
  if (!isObj(raw)) return {};
  const p: ScheduledPlan = {};
  if (typeof raw.at === "number") p.at = raw.at;
  if (typeof raw.clockTime === "string") p.clockTime = raw.clockTime;
  if (Array.isArray(raw.days)) p.days = raw.days.filter((d): d is number => Number.isInteger(d));
  if (typeof raw.day === "number") p.day = raw.day;
  return p;
}

export function normScheduledRun(raw: unknown): ScheduledRun | null {
  if (!isObj(raw) || !identifier(raw.id)) return null;
  return {
    id: identifier(raw.id), jobId: str(raw.jobId), workspaceId: str(raw.workspaceId), chatId: str(raw.chatId) || null,
    cause: oneOf(SCHEDULED_RUN_CAUSES, raw.cause), scheduledAt: count(raw.scheduledAt), queuedAt: count(raw.queuedAt),
    startedAt: count(raw.startedAt),
    endedAt: count(raw.endedAt), status: oneOf(SCHEDULED_RUN_STATUS, raw.status), error: str(raw.error), short: str(raw.short),
    question: raw.question === true,
  };
}

export function normScheduledJob(raw: unknown): ScheduledJob | null {
  if (!isObj(raw) || !str(raw.id)) return null;
  return {
    id: str(raw.id), workspaceId: str(raw.workspaceId), chatId: str(raw.chatId) || null, instructions: str(raw.instructions),
    cadence: oneOf(SCHEDULED_CADENCES, raw.cadence), plan: normPlan(raw.plan), timeZone: str(raw.timeZone),
    status: oneOf(SCHEDULED_JOB_STATUS, raw.status), nextAt: count(raw.nextAt), retryAt: count(raw.retryAt), lastRunAt: count(raw.lastRunAt),
    lastStatus: str(raw.lastStatus), lastError: str(raw.lastError), createdAt: count(raw.createdAt), updatedAt: count(raw.updatedAt),
    name: str(raw.name), projectId: str(raw.projectId) || null, cadenceText: str(raw.cadenceText),
    state: oneOf(SCHEDULED_STATES, raw.state), lastRun: normScheduledRun(raw.lastRun),
  };
}

/** Read the field `job` of a chat row; if it is missing (older server) or broken, `null`. */
export function normChatJob(raw: unknown): ChatJob | null {
  if (!isObj(raw) || !str(raw.id)) return null;
  return { id: str(raw.id), name: str(raw.name), status: oneOf(SCHEDULED_JOB_STATUS, raw.status), nextAt: count(raw.nextAt) };
}

const base = (wid: string) => `/api/workspaces/${encodeURIComponent(wid)}/scheduled`;

/** The jobs of a workspace; in an entered project only the project's. */
export async function loadScheduledJobs(wid: string, projectId?: string | null): Promise<ScheduledJob[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const d = await api<{ items?: unknown[] }>(`${base(wid)}${q}`);
  return (Array.isArray(d?.items) ? d.items : []).map(normScheduledJob).filter((a): a is ScheduledJob => a !== null);
}

/** The body of creation: job AND chat in one go. Everything except the mandatory fields goes out only if set. */
export type ScheduledCreationBody = {
  instructions: string;
  cadence: ScheduledCadence;
  plan: ScheduledPlan;
  /** Mandatory: a missing or unknown permission mode is a 400 on the server. */
  permissionMode: string;
  name?: string;
  /** The job's zone (IANA). If absent, the server takes the workspace's remembered one, "UTC" if none; the web therefore sends the
   *  browser's (`ownTimeZone`, like iOS `TimeZone.current`), and the server remembers it as the workspace's zone. */
  timeZone?: string;
  projectId?: string;
  instance?: string;
  provider?: string;
  model?: string;
  effort?: string;
  notify?: Record<string, "on" | "off">;
};

export async function setUpScheduledJob(wid: string, body: ScheduledCreationBody): Promise<{ job: ScheduledJob; chatId: string }> {
  const d = await api<{ job?: unknown; chat?: { id?: unknown } }>(base(wid), { method: "POST", body: JSON.stringify(body) });
  const job = normScheduledJob(d?.job);
  if (!job) throw new Error("Response without a job");
  return { job, chatId: str(d?.chat?.id) || job.chatId || "" };
}

/** PATCH of the job: only the passed fields (a missing one means "unchanged"); name and run values are changed by the chat PATCH. */
export type ScheduledChange = Partial<{ instructions: string; cadence: ScheduledCadence; plan: ScheduledPlan; status: "active" | "paused" }>;

export async function changeScheduledJob(wid: string, id: string, fields: ScheduledChange): Promise<ScheduledJob> {
  const d = await api<unknown>(`${base(wid)}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(fields) });
  const a = normScheduledJob(d);
  if (!a) throw new Error("Response without a job");
  return a;
}

/** The job goes, the chat STAYS; 409 while a run is open. */
export async function deleteScheduledJob(wid: string, id: string): Promise<void> {
  await api(`${base(wid)}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** "Run now" (cause `hand`); 409 if an appointment of this job is already waiting. */
export async function executeScheduledJob(wid: string, id: string): Promise<ScheduledJob | null> {
  const d = await api<{ job?: unknown }>(`${base(wid)}/${encodeURIComponent(id)}/run`, { method: "POST" });
  return normScheduledJob(d?.job);
}

/** The runs, newest first; `before` pages (the id of the last one read), `next` is 0 at the end. */
export async function loadScheduledRuns(wid: string, id: string, { before, limit = 20 }: { before?: string; limit?: number } = {}): Promise<{ items: ScheduledRun[]; next: string | null }> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set("before", before);
  const d = await api<{ items?: unknown[]; next?: unknown }>(`${base(wid)}/${encodeURIComponent(id)}/runs?${q}`);
  const items = (Array.isArray(d?.items) ? d.items : []).map(normScheduledRun).filter((l): l is ScheduledRun => l !== null);
  return { items, next: items.length >= limit && (typeof d?.next === "string" || typeof d?.next === "number") && d.next ? String(d.next) : null };
}
