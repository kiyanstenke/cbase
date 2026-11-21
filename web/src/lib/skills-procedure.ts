// The procedure behind the skill pages: load, cost line, hide, delete — without React, so web/test/skills.test.mjs can
// RUN it against a fake `fetch` (the gate tests render no components). The page (components/SkillsPane.tsx) only holds the state (`useState<SkillsState>`) and pass its setter in as `change`.
//
// Four rules:
//  1. An error survives the reload it triggers. If hiding (PATCH) or deleting fails, the procedure reloads (the toggle
//     snaps back to the server's state) — and the message stays (`load({ keepError: true })`). Otherwise the reload
//     would clear it at once and the toggle would snap back without a reason.
//  2. The cost line takes only the NEWEST answer (sequence counter): two quick toggles send two catalog queries, and the
//     slower, older one would overwrite the newer.
//  3. "Busy" is a SET of skill ids, not a single one: two toggles in a row would otherwise release the first while it
//     is still running.
//  4. If the catalog fails, that is a state (`error`, with the message) — not the same as "still loading".
//
// Leaf module: imports only from lib/ and lib/api/ with `.js` specifiers (the test compiles it with tsc without tsconfig).
import {
  loadProjectSkills, loadProjectWorkspaceSkills, loadSkillCatalog, loadWorkspaceSkills, deleteSkill, setSkillAvailable,
  type ProjectWorkspaceSkill, type SkillOwner, type SkillCatalog, type SkillProjectName,
} from "./api/skills.js";
import type { SkillArea, SkillMeta } from "./api/events.js";
import { byName } from "./skills.js";

/** State of the cost line: still loading, loaded ("loaded"), or unreadable (`text` = message; `null` = answer without two numbers). */
export type CatalogStatus = { kind: "loading" } | { kind: "loaded"; value: SkillCatalog } | { kind: "error"; text: string | null };

export interface SkillsState {
  /** The skills of this level itself (workspace or project) — `null` means "not loaded yet". */
  own: (SkillMeta & { hiddenIn?: SkillProjectName[] | null })[] | null;
  /** Project only: the workspace coding skills with `enabled`; otherwise `null`. */
  workspace: ProjectWorkspaceSkill[] | null;
  catalog: CatalogStatus;
  error: string | null;
  /** Skill ids whose toggle is in flight. */
  busy: readonly string[];
}

export const SKILLS_BEGINNING: SkillsState = { own: null, workspace: null, catalog: { kind: "loading" }, error: null, busy: [] };

/** Which list: coding in the workspace or coding in a project. */
export interface SkillsLevel { area: SkillArea; workspaceId: string; projectId: string | null }

/** The message of an error. A delete can fail with 409 and the list of agent definitions that carry the skill — their
 *  names go into the message unless the server's sentence already names them. */
const notice = (e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  const v = (e as { references?: unknown } | null)?.references;
  const names = Array.isArray(v)
    ? v.flatMap((x) => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" ? [(x as { name: string }).name] : []))
    : [];
  return names.length && !names.every((n) => text.includes(n)) ? `${text} (${names.join(", ")})` : text;
};

export function skillsProcedure(level: SkillsLevel, change: (f: (s: SkillsState) => SkillsState) => void) {
  const project = level.area === "coding" ? level.projectId : null;
  let catalogSeq = 0;
  let listSeq = 0;

  async function loadCatalog(): Promise<void> {
    const seq = ++catalogSeq;
    let fresh: CatalogStatus;
    try {
      const k = await loadSkillCatalog(level.workspaceId, level.area, project);
      fresh = k ? { kind: "loaded", value: k } : { kind: "error", text: null };
    } catch (e) { fresh = { kind: "error", text: notice(e) }; }
    if (seq === catalogSeq) change((s) => ({ ...s, catalog: fresh }));
  }

  /** Reload list(s) and cost line. Without `keepError` a successful list clears the message (a new attempt succeeded). */
  async function load(opts: { keepError?: boolean } = {}): Promise<void> {
    const seq = ++listSeq;
    try {
      if (project) {
        const [e, w] = await Promise.all([loadProjectSkills(project), loadProjectWorkspaceSkills(project)]);
        if (seq === listSeq) change((s) => ({ ...s, own: byName(e), workspace: byName(w), error: opts.keepError ? s.error : null }));
      } else {
        const e = await loadWorkspaceSkills(level.workspaceId, level.area);
        if (seq === listSeq) change((s) => ({ ...s, own: byName(e), workspace: null, error: opts.keepError ? s.error : null }));
      }
    } catch (e) {
      if (seq === listSeq) change((s) => ({ ...s, error: notice(e) }));
    }
    await loadCatalog();
  }

  /** Show or hide a workspace skill in this project. An unknown state (`enabled: null`) does not toggle. */
  async function toggle(skill: ProjectWorkspaceSkill): Promise<void> {
    if (!project || skill.enabled === null) return;
    const target = !skill.enabled;
    change((s) => ({
      ...s,
      busy: [...s.busy.filter((id) => id !== skill.id), skill.id],
      workspace: s.workspace?.map((x) => (x.id === skill.id ? { ...x, enabled: target } : x)) ?? s.workspace,
    }));
    try {
      await setSkillAvailable(project, skill.id, target);
      await loadCatalog();
    } catch (e) {
      change((s) => ({ ...s, error: notice(e) }));
      await load({ keepError: true });
    } finally {
      change((s) => ({ ...s, busy: s.busy.filter((id) => id !== skill.id) }));
    }
  }

  /** Delete; if it fails, reload anyway (the server's state wins) and keep the message. */
  async function erase(owner: SkillOwner, id: string): Promise<void> {
    try {
      await deleteSkill(owner, id);
      await load();
    } catch (e) {
      change((s) => ({ ...s, error: notice(e) }));
      await load({ keepError: true });
    }
  }

  const setError = (error: string | null) => change((s) => ({ ...s, error }));

  return { load, loadCatalog, toggle, erase, setError };
}

export type SkillsProcedure = ReturnType<typeof skillsProcedure>;
