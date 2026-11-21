// Skills: the routes to the server, nothing else (the routes are the contract with server and iOS). The UI lives in
// components/SkillsPane.tsx (Coding, both levels), the small calculations in the leaf lib/skills.ts.
//
// Two lists, strictly separate: a coding list per workspace AND per project. Every route that needs an area demands it as an
// argument: a missing field is no statement, and the server answers 400 without it. Nothing is ever moved: a PUT carries only
// description and content.
//
// The bodies are typed objects (`SkillCreationBody`, `SkillChangeBody`, `SkillAvailableBody`), not conditional spreads;
// web/test/skills.test.mjs checks the wire against a fake `fetch`.
//
// Leaf module: imports only from lib/api/ (README there).
import { api } from "./core.js";
import type { Skill, SkillArea, SkillMeta } from "./events.js";
import { withHistoryFields } from "./skill-history.js";

/** Whom a skill belongs to: a project (always coding) or the workspace. It is addressed through ITS owner; a shared route would be a
 *  third place where the ownership stands. */
export type SkillOwner = { kind: "workspace"; workspaceId: string } | { kind: "project"; projectId: string };

/** A project in which a workspace coding skill is hidden. */
export interface SkillProjectName { id: string; name: string }

/** A workspace skill of the list `GET /api/workspaces/:wid/skills?area=…`. Only coding entries carry `hiddenIn`; `null` means "the
 *  server did not say" (e.g. an older server), never "hidden in no project". */
export interface WorkspaceSkill extends SkillMeta {
  hiddenIn: SkillProjectName[] | null;
}

/** A workspace CODING skill from a project's view (`GET /api/projects/:pid/workspace-skills`): `enabled` = NOT hidden in this project
 *  (opt-out). THREE-VALUED: `null` means "the server did not say"; the row then shows no switch state and locks the switch instead of
 *  claiming "hidden" (a missing field is no statement). */
export interface ProjectWorkspaceSkill extends SkillMeta {
  enabled: boolean | null;
}

/** Count and cost of a level's catalog (`GET /api/workspaces/:wid/skill-catalog`): the same calculation as the catalog in the system
 *  prompt, computed on the SERVER. */
export interface SkillCatalog { count: number; token: number }

/** What the dialog delivers. The area never comes from the dialog but from the place where it is created. */
export interface SkillDraft { name: string; description: string; body: string }

export type SkillCreationBody = { name: string; description: string; body: string; area: SkillArea };
export type SkillChangeBody = { description: string; body: string };
export type SkillAvailableBody = { enabled: boolean };

const enc = encodeURIComponent;

/** The skill collection of an owner: `/api/workspaces/:wid/skills` or `/api/projects/:pid/skills`. */
export function skillCollection(b: SkillOwner): string {
  return b.kind === "project" ? `/api/projects/${enc(b.projectId)}/skills` : `/api/workspaces/${enc(b.workspaceId)}/skills`;
}

const projectNames = (raw: unknown): SkillProjectName[] | null => {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((p): p is { id: unknown; name: unknown } => !!p && typeof p === "object")
    .filter((p) => typeof p.id === "string" && p.id !== "")
    .map((p) => ({ id: p.id as string, name: typeof p.name === "string" && p.name ? p.name : (p.id as string) }));
};

/**
 * Only the entries of THIS area. Every list here is an area list (the workspace list via `?area=`, the two project lists are always
 * coding); an entry with a foreign or missing `area` drops out. The case: new web against an older server (a rollback to an older release
 * server`) that ignores `?area=` and sends both areas in one list; otherwise skills of another area would stand under Coding.
 */
function onlyArea<T extends { area?: unknown }>(raw: unknown, area: SkillArea, location: string): T[] {
  const list = (Array.isArray(raw) ? raw : []) as T[];
  const matches = list.filter((s) => !!s && s.area === area);
  if (matches.length < list.length) console.warn(`[skills] ${location}: ${list.length - matches.length} entries without area "${area}" dropped`);
  return matches;
}

/** The workspace skills of ONE area. */
export async function loadWorkspaceSkills(workspaceId: string, area: SkillArea): Promise<WorkspaceSkill[]> {
  const raw = await api<unknown>(`/api/workspaces/${enc(workspaceId)}/skills?area=${area}`);
  return onlyArea<SkillMeta & { hiddenIn?: unknown }>(raw, area, "Workspace skills")
    .map((s) => withHistoryFields({ ...s, hiddenIn: area === "coding" ? projectNames(s.hiddenIn) : null }));
}

/** A project's own skills (always coding). */
export async function loadProjectSkills(projectId: string): Promise<SkillMeta[]> {
  const raw = await api<unknown>(`/api/projects/${enc(projectId)}/skills`);
  return onlyArea<SkillMeta>(raw, "coding", "Project skills").map(withHistoryFields);
}

/** The workspace coding skills from a project's view, each with `enabled` (not hidden; `null` = not said). */
export async function loadProjectWorkspaceSkills(projectId: string): Promise<ProjectWorkspaceSkill[]> {
  const raw = await api<unknown>(`/api/projects/${enc(projectId)}/workspace-skills`);
  return onlyArea<SkillMeta & { enabled?: unknown }>(raw, "coding", "Workspace skills in project")
    .map((s) => withHistoryFields({ ...s, enabled: typeof s.enabled === "boolean" ? s.enabled : null }));
}

/** A skill with its content, for editing. */
export function loadSkill(b: SkillOwner, id: string): Promise<Skill> {
  return api<Skill>(`${skillCollection(b)}/${enc(id)}`);
}

/** Create: the area is ALWAYS in the body (a project takes only `coding`; the server answers 400 otherwise). */
export function setUpSkill(b: SkillOwner, area: SkillArea, e: SkillDraft): Promise<SkillMeta> {
  const body: SkillCreationBody = { name: e.name.trim(), description: e.description, body: e.body, area };
  return api<SkillMeta>(skillCollection(b), { method: "POST", body: JSON.stringify(body) });
}

/** Change: only description and content; name, area and level stay. */
export function changeSkill(b: SkillOwner, id: string, e: Pick<SkillDraft, "description" | "body">): Promise<SkillMeta> {
  const body: SkillChangeBody = { description: e.description, body: e.body };
  return api<SkillMeta>(`${skillCollection(b)}/${enc(id)}`, { method: "PUT", body: JSON.stringify(body) });
}

export function deleteSkill(b: SkillOwner, id: string): Promise<unknown> {
  return api(`${skillCollection(b)}/${enc(id)}`, { method: "DELETE" });
}

/** Show or hide a workspace coding skill in a project; addressed by the skill ID, never by the name. */
export function setSkillAvailable(projectId: string, skillId: string, enabled: boolean): Promise<unknown> {
  const body: SkillAvailableBody = { enabled };
  return api(`/api/projects/${enc(projectId)}/workspace-skills/${enc(skillId)}/enabled`, { method: "PATCH", body: JSON.stringify(body) });
}

/**
 * Count and cost of this level's catalog: Coding without a project = what a workspace chat gets (workspace + all projects), Coding with
 * a project = own + not hidden. `null` if the answer does not carry two numbers; an invented 0 would claim an empty catalog.
 */
export async function loadSkillCatalog(workspaceId: string, area: SkillArea, projectId?: string | null): Promise<SkillCatalog | null> {
  const project = area === "coding" && projectId ? `&projectId=${enc(projectId)}` : "";
  const r = await api<{ count?: unknown; token?: unknown }>(`/api/workspaces/${enc(workspaceId)}/skill-catalog?area=${area}${project}`);
  const count = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
  return r && count(r.count) && count(r.token) ? { count: r.count as number, token: r.token as number } : null;
}
