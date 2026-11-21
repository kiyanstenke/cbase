// Instructions for agents per workspace and project: ordered SECTIONS (title, text, on/off, scope) that every agent
// carries in its system prompt according to its scope (computed in toolchain/instructions.js). Here only rows and
// the hard limits of the schema; caps and mandatory fields are checked by the routes
// (workspaces/instructions-routes.js).
//
//   agents_sections          one section; `project_id` NULL = workspace level. `version` counts every change
//                            (conflict protection).
//   agents_sections_from     opt-out of a workspace section in a project — no row means adopted.
//   agents_sections_history  every change with before/after (JSON); stays after deletion (no foreign key).
//
// Delete paths: store/workspaces.js deleteProject/deleteWorkspace clean up too. Registered in store.js.
import { db, inOneTransaction } from "./db.js";

const SECTION_SCOPES = Object.freeze(["all", "main", "sub"]);
const SCOPE_SQL = SECTION_SCOPES.map((g) => `'${g}'`).join(", ");

function initInstructionsSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents_sections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL CHECK (scope IN (${SCOPE_SQL})),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      pos INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_sections_level ON agents_sections(workspace_id, project_id, pos);
    CREATE TABLE IF NOT EXISTS agents_sections_from (
      section_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      opted_out INTEGER NOT NULL CHECK (opted_out IN (0, 1)),
      changed_at INTEGER NOT NULL,
      PRIMARY KEY (section_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS agents_sections_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'change', 'erase', 'takeover')),
      prior TEXT,
      after TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_sections_history ON agents_sections_history(section_id, at);
  `);
}

const mapSection = (r) => (r ? {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id ?? null, title: r.title, text: r.text, scope: r.scope,
  enabled: r.enabled === 1, pos: r.pos, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
} : null);
// The state in the history: only what the user sets (without ids and times).
const historyStatus = (a) => (a ? JSON.stringify({ title: a.title, text: a.text, scope: a.scope, enabled: a.enabled, pos: a.pos }) : null);
function history(a, kind, prior, after, at, projectId = a.projectId) {
  db.prepare(`INSERT INTO agents_sections_history (section_id, workspace_id, project_id, kind, prior, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(a.id, a.workspaceId, projectId ?? null, kind, prior, after, at);
}

/** A section or null. */
const agentSection = (id) => mapSection(db.prepare("SELECT * FROM agents_sections WHERE id = ?").get(String(id ?? "")));

/** The sections of ONE level in their order (`projectId` null = workspace level). */
function agentSectionsOfTheLevel(workspaceId, projectId = null) {
  const rows = projectId
    ? db.prepare("SELECT * FROM agents_sections WHERE workspace_id = ? AND project_id = ? ORDER BY pos, created_at, id").all(String(workspaceId), String(projectId))
    : db.prepare("SELECT * FROM agents_sections WHERE workspace_id = ? AND project_id IS NULL ORDER BY pos, created_at, id").all(String(workspaceId));
  return rows.map(mapSection);
}

/** The ids of the workspace sections a project has opted out of. */
function agentSectionsOffInProject(projectId) {
  return new Set(db.prepare("SELECT section_id AS a FROM agents_sections_from WHERE project_id = ? AND opted_out = 1").all(String(projectId ?? "")).map((r) => r.a));
}

/** Create at the end of the level. `a` = { id, workspaceId, projectId, title, text, scope, enabled }. → the section. */
function createAgentSection(a, at = Date.now()) {
  return inOneTransaction(() => {
    const pos = (a.projectId
      ? db.prepare("SELECT MAX(pos) AS m FROM agents_sections WHERE workspace_id = ? AND project_id = ?").get(String(a.workspaceId), String(a.projectId))
      : db.prepare("SELECT MAX(pos) AS m FROM agents_sections WHERE workspace_id = ? AND project_id IS NULL").get(String(a.workspaceId)))?.m;
    db.prepare(`INSERT INTO agents_sections (id, workspace_id, project_id, title, text, scope, enabled, pos, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(String(a.id), String(a.workspaceId), a.projectId ? String(a.projectId) : null, String(a.title),
      String(a.text ?? ""), String(a.scope), a.enabled === false ? 0 : 1, (pos ?? -1) + 1, at, at);
    const fresh = agentSection(a.id);
    history(fresh, "create", null, historyStatus(fresh), at);
    return fresh;
  });
}

/**
 * Change with conflict protection: only if `version` still matches (the condition is in the UPDATE). →
 * `{ section }` or `{ conflict: current state }` or null (missing).
 */
function changeAgentSection(id, fields, version, at = Date.now()) {
  return inOneTransaction(() => {
    const prior = agentSection(id);
    if (!prior) return null;
    const r = db.prepare(`UPDATE agents_sections SET title = ?, text = ?, scope = ?, enabled = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`).run(String(fields.title), String(fields.text), String(fields.scope), fields.enabled ? 1 : 0, at, String(id), Number(version));
    if (!r.changes) return { conflict: prior };
    const after = agentSection(id);
    history(after, "change", historyStatus(prior), historyStatus(after), at);
    return { section: after };
  });
}

/** Delete with conflict protection. → `{ deleted: true }`, `{ conflict }` or null. The opt-out rows fall with it. */
function deleteAgentSection(id, version, at = Date.now()) {
  return inOneTransaction(() => {
    const prior = agentSection(id);
    if (!prior) return null;
    const r = db.prepare("DELETE FROM agents_sections WHERE id = ? AND version = ?").run(String(id), Number(version));
    if (!r.changes) return { conflict: prior };
    db.prepare("DELETE FROM agents_sections_from WHERE section_id = ?").run(String(id));
    history(prior, "erase", historyStatus(prior), null, at);
    return { deleted: true };
  });
}

/** Set the order of a level; `ids` must name exactly the sections of the level (otherwise false, nothing written). */
function arrangeAgentSections(workspaceId, projectId, ids, at = Date.now()) {
  return inOneTransaction(() => {
    const existing = agentSectionsOfTheLevel(workspaceId, projectId).map((a) => a.id);
    const fresh = (Array.isArray(ids) ? ids : []).map(String);
    if (fresh.length !== existing.length || new Set(fresh).size !== fresh.length || fresh.some((x) => !existing.includes(x))) return false;
    const set = db.prepare("UPDATE agents_sections SET pos = ?, updated_at = ? WHERE id = ?");
    fresh.forEach((id, i) => set.run(i, at, id));
    return true;
  });
}

/** Set the adoption of a workspace section in a project. Writes the history only on a real change. */
function setAgentSectionTakeover(section, projectId, takenOver, at = Date.now()) {
  return inOneTransaction(() => {
    const what = !agentSectionsOffInProject(projectId).has(section.id);
    db.prepare(`INSERT INTO agents_sections_from (section_id, project_id, opted_out, changed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(section_id, project_id) DO UPDATE SET opted_out = excluded.opted_out, changed_at = excluded.changed_at`)
      .run(String(section.id), String(projectId), takenOver ? 0 : 1, at);
    if (what !== Boolean(takenOver)) history(section, "takeover", JSON.stringify({ takenOver: what }), JSON.stringify({ takenOver: Boolean(takenOver) }), at, projectId);
    return Boolean(takenOver);
  });
}

/** The history of a section, newest first (at most 200). */
function agentSectionHistory(id) {
  return db.prepare("SELECT * FROM agents_sections_history WHERE section_id = ? ORDER BY at DESC, id DESC LIMIT 200").all(String(id ?? ""))
    .map((r) => ({ kind: r.kind, projectId: r.project_id ?? null, prior: r.prior ? JSON.parse(r.prior) : null, after: r.after ? JSON.parse(r.after) : null, at: r.at }));
}

/** Delete path of a project (store/workspaces.js): its sections with history and its opt-out rows. */
function cleanAgentSectionsOfTheProject(projectId) {
  db.prepare("DELETE FROM agents_sections_from WHERE project_id = ? OR section_id IN (SELECT id FROM agents_sections WHERE project_id = ?)").run(String(projectId), String(projectId));
  db.prepare("DELETE FROM agents_sections_history WHERE project_id = ?").run(String(projectId));
  db.prepare("DELETE FROM agents_sections WHERE project_id = ?").run(String(projectId));
}
/** Delete path of a workspace. */
function cleanAgentSectionsOfTheWorkspace(workspaceId) {
  // Also the opt-out rows of its PROJECTS (delete-list guard, schema-register.test.js) — called while the project rows still stand.
  db.prepare(`DELETE FROM agents_sections_from WHERE section_id IN (SELECT id FROM agents_sections WHERE workspace_id = ?)
    OR project_id IN (SELECT id FROM projects WHERE workspace_id = ?)`).run(String(workspaceId), String(workspaceId));
  db.prepare("DELETE FROM agents_sections_history WHERE workspace_id = ?").run(String(workspaceId));
  db.prepare("DELETE FROM agents_sections WHERE workspace_id = ?").run(String(workspaceId));
}

export {
  SECTION_SCOPES, initInstructionsSchema, agentSection, agentSectionsOfTheLevel, agentSectionsOffInProject, createAgentSection,
  changeAgentSection, deleteAgentSection, arrangeAgentSections, setAgentSectionTakeover, agentSectionHistory,
  cleanAgentSectionsOfTheProject, cleanAgentSectionsOfTheWorkspace,
};
