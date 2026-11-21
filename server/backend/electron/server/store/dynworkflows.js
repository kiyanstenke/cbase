// The library of dynamic workflows.
//
// A stored workflow is a script in the format of Claude Code's Workflow tool — `export const meta = {…}` as a pure
// literal up front, then the body. The script is stored BYTE-EQUAL in `script` (that makes it interchangeable
// between Claude Code and cbase); `meta` is what dynworkflows/script.js:checkScript read from it (name, description,
// title, whenToUse, phases) — a derivation, stored so that the list does not re-parse the script on every call.
//
// The library belongs to the WORKSPACE (there are no project-bound workflows); a project ADOPTS it by name like
// skills and graph workflows (`project_dyn_workflow_enabled`, default: off). Names are unique per workspace
// REGARDLESS of case (`COLLATE NOCASE`): the slash call `/name` does not distinguish them. There is no rename — a
// name is never silently overwritten, a new name is a new entry.
//
// This folder is domain-free: the script is checked in dynworkflows/routes.js, here it is only stored.
// Registration "dyn-workflows" in store.js.
import { db, inOneTransaction } from "./db.js";

function initDynWorkflowSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dyn_workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      script TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dyn_workflows_ws_name ON dyn_workflows(workspace_id, name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS project_dyn_workflow_enabled (
      project_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      PRIMARY KEY (project_id, workflow_name)
    );
  `);
}

const read = (raw) => { try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const mapDynWorkflow = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, name: r.name, meta: read(r.meta), script: r.script,
  createdAt: r.created_at, updatedAt: r.updated_at,
};

/** All stored workflows of a workspace, by name. */
function listDynWorkflows(workspaceId) {
  return db.prepare("SELECT * FROM dyn_workflows WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").all(workspaceId).map(mapDynWorkflow);
}
function getDynWorkflow(id) {
  return mapDynWorkflow(db.prepare("SELECT * FROM dyn_workflows WHERE id = ?").get(id));
}
/** The entry of this name in the workspace — regardless of case. */
function getDynWorkflowByName(workspaceId, name) {
  return mapDynWorkflow(db.prepare("SELECT * FROM dyn_workflows WHERE workspace_id = ? AND name = ? COLLATE NOCASE").get(workspaceId, String(name)));
}

/**
 * Store a workflow — and, if `projectId` is set, adopt it in that project (saved from a project chat it would
 * otherwise be invisible there via `/name`, the default being "off"). Both in ONE transaction. A name the workspace
 * already carries throws (UNIQUE) — never a silent overwrite.
 */
function createDynWorkflow({ id, workspaceId, name, meta, script, projectId = null, at = Date.now() }) {
  inOneTransaction(() => {
    db.prepare(`INSERT INTO dyn_workflows (id, workspace_id, name, meta, script, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, name, JSON.stringify(meta || {}), String(script), at, at);
    if (projectId) db.prepare("INSERT OR IGNORE INTO project_dyn_workflow_enabled (project_id, workflow_name) VALUES (?, ?)").run(projectId, name);
  });
  return getDynWorkflow(id);
}

/** Remove the entry AND its adoptions in all projects of the workspace — in one transaction (no entry without its adoptions). */
function deleteDynWorkflow(id) {
  const w = getDynWorkflow(id);
  if (!w) return false;
  inOneTransaction(() => {
    db.prepare("DELETE FROM dyn_workflows WHERE id = ?").run(id);
    db.prepare("DELETE FROM project_dyn_workflow_enabled WHERE workflow_name = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)").run(w.name, w.workspaceId);
  });
  return true;
}

// ── Adoption per project (by name, like project_skill_enabled) ─────────────────────────────────
function listEnabledDynWorkflowNames(projectId) {
  return new Set(db.prepare("SELECT workflow_name FROM project_dyn_workflow_enabled WHERE project_id = ?").all(projectId).map((r) => r.workflow_name));
}
function setDynWorkflowEnabled(projectId, name, on) {
  if (on) db.prepare("INSERT OR IGNORE INTO project_dyn_workflow_enabled (project_id, workflow_name) VALUES (?, ?)").run(projectId, name);
  else db.prepare("DELETE FROM project_dyn_workflow_enabled WHERE project_id = ? AND workflow_name = ?").run(projectId, name);
}

/**
 * The workflows effective in the chat: in a workspace chat all of the workspace, in a project chat only those
 * adopted in that project.
 */
function effectiveDynWorkflows(workspaceId, projectId = null) {
  const all = listDynWorkflows(workspaceId);
  if (!projectId) return all;
  const enabled = listEnabledDynWorkflowNames(projectId);
  return all.filter((w) => enabled.has(w.name));
}

/** Does a skill (workspace or project skill) in the workspace carry this name? Regardless of case. */
function skillCarriesNames(workspaceId, name) {
  return !!db.prepare("SELECT 1 FROM skills WHERE workspace_id = ? AND name = ? COLLATE NOCASE LIMIT 1").get(workspaceId, String(name));
}

export {
  initDynWorkflowSchema, listDynWorkflows, getDynWorkflow, getDynWorkflowByName, createDynWorkflow, deleteDynWorkflow,
  listEnabledDynWorkflowNames, setDynWorkflowEnabled, effectiveDynWorkflows, skillCarriesNames,
};
