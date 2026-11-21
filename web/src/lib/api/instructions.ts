// Instructions for agents per workspace and project: per level an ordered list of sections (title, text, on/off, scope) that every
// agent gets in the system prompt. `all` = main, sub and workflow agent, `main` = the main run only, `sub` = subagents and workflow
// agents only. Workspace sections apply in every project unless it deselects them per section (opt-out).
//
//   GET    /api/workspaces/:wid/instructions?projectId=      → { workspace, project | null, cap }      (`loadInstructions`)
//   POST   /api/workspaces/:wid/instructions                 { projectId, title, text, scope, enabled } (`createInstruction`)
//   PUT    /api/workspaces/:wid/instructions/:aid            { title, text, scope, enabled, version }  (`changeInstruction`, 409 = conflict)
//   DELETE /api/workspaces/:wid/instructions/:aid?version=   (`deleteInstruction`, 409 = conflict)
//   PUT    /api/workspaces/:wid/instructions/order           { projectId, ids }                        (`arrangeInstructions`)
//   PUT    /api/workspaces/:wid/instructions/:aid/takeover   { projectId, takenOver }                  (`setInstructionTakeover`)
//   GET    /api/workspaces/:wid/instructions/:aid/history    → { entries }                             (`loadInstructionHistory`)
//   SSE    `instructions` { workspaceId, projectId } after every write; the view reloads (components/AgentInstructions.tsx).
//
// Server: server/backend/electron/server/workspaces/instructions-routes.js. Leaf module (README there): imports only from lib/api/,
// with a `.js` ending. Every answer goes through `normAgentsSection` with a default per field; every body carries EVERY field (the
// server requires them: "a missing field is no statement"). The scopes are the server's (store/instructions.js `SECTION_SCOPES`).
import { api } from "./core.js";

export const INSTRUCTION_SCOPES = ["all", "main", "sub"] as const;
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number];

export interface AgentSection {
  id: string;
  title: string;
  text: string;
  scope: InstructionScope;
  enabled: boolean;
  pos: number;
  /** The state a change/delete is checked against (409 on a stale state). */
  version: number;
  updatedAt: number;
  /** Workspace sections only, when a project was asked for: does the section apply there? `null` = not said. */
  takenOver: boolean | null;
}

export interface InstructionsCap {
  text: number;
  title: number;
  sections: number;
}

export interface InstructionsStatus {
  workspace: AgentSection[];
  /** `null` on the workspace level (no project asked for). */
  project: AgentSection[] | null;
  cap: InstructionsCap;
}

/** What the human edits on a section: always all four fields. */
export interface InstructionFields {
  title: string;
  text: string;
  scope: InstructionScope;
  enabled: boolean;
}

/** Change/delete: done, or a conflict with the server's current state (`null` if it sent none). */
export type InstructionResult<T> = { ok: true; value: T } | { ok: false; conflict: AgentSection | null };

/** The default if the server names no cap; the same numbers as `INSTRUCTIONS_CAP` on the server. */
export const INSTRUCTIONS_CAP_DEFAULT: InstructionsCap = { text: 20_000, title: 80, sections: 30 };

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const count = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const countOrNull = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const positive = (v: unknown, preset: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : preset);

/** An unknown scope reads as "all": the row stays visible and says the widest thing instead of silently vanishing. */
export const asInstructionScope = (v: unknown): InstructionScope =>
  (INSTRUCTION_SCOPES as readonly string[]).includes(String(v)) ? (v as InstructionScope) : "all";

export function normAgentsSection(raw: unknown): AgentSection | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    title: str(r.title),
    text: str(r.text),
    scope: asInstructionScope(r.scope),
    enabled: r.enabled !== false,
    pos: count(r.pos),
    version: count(r.version),
    updatedAt: count(r.updatedAt),
    takenOver: typeof r.takenOver === "boolean" ? r.takenOver : null,
  };
}

const list = (v: unknown): AgentSection[] =>
  Array.isArray(v) ? v.map(normAgentsSection).filter((a): a is AgentSection => a !== null) : [];

const base = (wid: string) => `/api/workspaces/${encodeURIComponent(wid)}/instructions`;

/** Both levels at once: in a project the workspace sections with `takenOver` AND its own; otherwise only the workspace. */
export async function loadInstructions(workspaceId: string, projectId: string | null): Promise<InstructionsStatus> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const r = obj(await api(`${base(workspaceId)}${q}`));
  const d = obj(r.cap);
  return {
    workspace: list(r.workspace),
    project: Array.isArray(r.project) ? list(r.project) : null,
    cap: {
      text: positive(d.text, INSTRUCTIONS_CAP_DEFAULT.text),
      title: positive(d.title, INSTRUCTIONS_CAP_DEFAULT.title),
      sections: positive(d.sections, INSTRUCTIONS_CAP_DEFAULT.sections),
    },
  };
}

/** Create on a level; `projectId: null` = workspace. The server appends the section at the end. */
export async function createInstruction(workspaceId: string, projectId: string | null, fields: InstructionFields): Promise<AgentSection | null> {
  const body: InstructionFields & { projectId: string | null } = { projectId, title: fields.title, text: fields.text, scope: fields.scope, enabled: fields.enabled };
  const r = obj(await api(base(workspaceId), { method: "POST", body: JSON.stringify(body) }));
  return normAgentsSection(r.section);
}

/** An error with status 409: the section has changed meanwhile; the body carries the current state. */
function conflictOf(e: unknown): AgentSection | null | undefined {
  const r = obj(e);
  if (countOrNull(r.httpStatus) !== 409) return undefined;
  return normAgentsSection(r.section);
}

/** Change against the edited state (`version`). 409 comes back as `{ ok: false, conflict }`, any other error throws. */
export async function changeInstruction(workspaceId: string, id: string, fields: InstructionFields, version: number): Promise<InstructionResult<AgentSection | null>> {
  const body: InstructionFields & { version: number } = { title: fields.title, text: fields.text, scope: fields.scope, enabled: fields.enabled, version };
  try {
    const r = obj(await api(`${base(workspaceId)}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }));
    return { ok: true, value: normAgentsSection(r.section) };
  } catch (e) {
    const k = conflictOf(e);
    if (k === undefined) throw e;
    return { ok: false, conflict: k };
  }
}

/** Delete against the edited state. 409 as with change. */
export async function deleteInstruction(workspaceId: string, id: string, version: number): Promise<InstructionResult<true>> {
  try {
    await api(`${base(workspaceId)}/${encodeURIComponent(id)}?version=${encodeURIComponent(String(version))}`, { method: "DELETE" });
    return { ok: true, value: true };
  } catch (e) {
    const k = conflictOf(e);
    if (k === undefined) throw e;
    return { ok: false, conflict: k };
  }
}

/** New order of a level; `ids` names exactly all sections of this level (else 400). Answer: the level in the new order. */
export async function arrangeInstructions(workspaceId: string, projectId: string | null, ids: string[]): Promise<AgentSection[]> {
  const body: { projectId: string | null; ids: string[] } = { projectId, ids };
  const r = obj(await api(`${base(workspaceId)}/order`, { method: "PUT", body: JSON.stringify(body) }));
  return list(r.sections);
}

/** Take over or deselect a workspace section in a project. Answer: the state that was set. */
export async function setInstructionTakeover(workspaceId: string, id: string, projectId: string, takenOver: boolean): Promise<boolean> {
  const body: { projectId: string; takenOver: boolean } = { projectId, takenOver };
  const r = obj(await api(`${base(workspaceId)}/${encodeURIComponent(id)}/takeover`, { method: "PUT", body: JSON.stringify(body) }));
  return typeof r.takenOver === "boolean" ? r.takenOver : takenOver;
}

export interface InstructionHistoryEntry {
  kind: "create" | "change" | "erase" | "takeover";
  projectId: string | null;
  prior: unknown;
  after: unknown;
  at: number;
}

/** The history of a section, newest first (server cap 200). An unknown kind reads as "change". */
export async function loadInstructionHistory(workspaceId: string, id: string): Promise<InstructionHistoryEntry[]> {
  const r = obj(await api(`${base(workspaceId)}/${encodeURIComponent(id)}/history`));
  const kinds = ["create", "change", "erase", "takeover"] as const;
  return (Array.isArray(r.entries) ? r.entries : []).map((raw) => {
    const e = obj(raw);
    const kind = (kinds as readonly string[]).includes(str(e.kind)) ? (e.kind as InstructionHistoryEntry["kind"]) : "change";
    return { kind, projectId: strOrNull(e.projectId), prior: e.prior ?? null, after: e.after ?? null, at: count(e.at) };
  });
}

/** The text of an error; `api()` attaches `error` (the server's sentence) as the message. */
export function instructionsError(e: unknown): string {
  return e instanceof Error ? e.message : str(obj(e).error) || String(e);
}
