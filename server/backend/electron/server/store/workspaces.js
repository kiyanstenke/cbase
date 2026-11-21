// Workspaces: settings, list, create/delete, git credentials, workspace credentials per project, variables
// (makeVarStore).
// Answers: how is a workspace created and deleted, where are its variables and credentials.

import { db, inOneTransaction } from "./db.js";
import { getProject, listProjects } from "./projects.js";
import { reportTargetRemoved } from "./project-instances.js";
import { dropOuterLoopMcpChoice } from "./outer-loop.js";
import { cleanAgentSectionsOfTheProject, cleanAgentSectionsOfTheWorkspace } from "./instructions.js";
import { dropAgentMcpChoice, removeSkillTrash, removeSkillResources } from "./toolchain.js";
import { withAllProjectItems } from "./_util.js";


// ── App settings (key/value) ──────────────────────────────────────────────────
export function getSetting(key, fallback = "") {
  const r = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return r ? r.value : fallback;
}
export function setSetting(key, value) {
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value ?? ""));
  return value;
}
export function getAllSettings() {
  const out = {};
  for (const r of db.prepare("SELECT key, value FROM app_settings").all()) out[r.key] = r.value;
  return out;
}

// ── Workspaces + projects ────────────────────────────────────────────────────
// `listProjects` lives in `projects.js` — `toolchain.js` and `workflows.js` take it from there too and pass it on
// to `withAllProjectItems`.
const mapWs = (r) => r && { id: r.id, name: r.name, path: r.path, createdAt: r.created_at, projects: listProjects(r.id) };

export const listWorkspaces = () => db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC").all().map(mapWs);

// ── Git credentials (workspace + host) ──────────────────────────────────────
export function setGitCred(workspaceId, host, username, secret) {
  db.prepare(`INSERT INTO workspace_git_creds (workspace_id, host, username, secret, updated_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(workspace_id, host) DO UPDATE SET username=excluded.username, secret=excluded.secret, updated_at=excluded.updated_at`)
    .run(workspaceId, host, username, secret, Date.now());
}
export const getGitCred = (workspaceId, host) =>
  db.prepare("SELECT username, secret FROM workspace_git_creds WHERE workspace_id = ? AND host = ?").get(workspaceId, host) || null;
/**
 * The credentials of several hosts in the list form of runtime/git-run.js accessAsEnvironment —
 * `[{ host, access: { username, secret } }]`. Per entry `host[:port]` (lower case) stays the key of the helper (git
 * compares the port); the lookup uses the HOST NAME without port, lower case — that is how the UI creates a
 * credential (`PUT …/git/creds`). A host without a credential is missing: public repos need none, and no token goes
 * to any host but its own.
 */
function gitAccessesFor(workspaceId, hosts) {
  if (!workspaceId) return [];
  const out = [];
  for (const raw of Array.isArray(hosts) ? hosts : []) {
    const host = String(raw ?? "").trim().toLowerCase();
    if (!host || out.some((e) => e.host === host)) continue;
    const c = getGitCred(workspaceId, host.replace(/:\d+$/, ""));
    if (c?.username) out.push({ host, access: { username: c.username, secret: c.secret || "" } });
  }
  return out;
}
export const listGitCreds = (workspaceId) =>
  db.prepare("SELECT host, username, updated_at AS updatedAt FROM workspace_git_creds WHERE workspace_id = ? ORDER BY host").all(workspaceId);
export const deleteGitCred = (workspaceId, host) =>
  db.prepare("DELETE FROM workspace_git_creds WHERE workspace_id = ? AND host = ?").run(workspaceId, host).changes > 0;
export const getWorkspace = (id) => mapWs(db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id));

export function createWorkspace({ id, name, path: wsPath, createdAt }) {
  db.prepare("INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(id, name, wsPath, createdAt);
  return getWorkspace(id);
}
export function renameWorkspace(id, name) {
  db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, id);
  return getWorkspace(id);
}
// A NEW project adopts the workspace agents: `ws_agents_default = 'on'` is explicit here — the column itself has
// DEFAULT 'off' so that every existing project stays as it was (toolchain.js, initWsAgentsSchema). In the server
// this is the only INSERT into `projects`.
export function addProject(workspaceId, { id, name, path: projPath, createdAt }) {
  db.prepare("INSERT INTO projects (id, workspace_id, name, path, created_at, ws_agents_default) VALUES (?, ?, ?, ?, ?, 'on')").run(id, workspaceId, name, projPath, createdAt);
  return { id, name, path: projPath, createdAt };
}
export function renameProject(projectId, name) {
  db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, projectId);
  return getProject(projectId);
}
// The timeline of a deleted project or workspace (store/timeline.js): first the four attachment tables (they only
// find their event while it exists), then the events. Only within the two delete paths and only once the projects
// are gone — before that the triggers block (append-only).
function timelineClean(condition, value) {
  const ids = `(SELECT id FROM timeline_events WHERE ${condition})`;
  db.prepare(`DELETE FROM timeline_tags WHERE event_id IN ${ids}`).run(value);
  db.prepare(`DELETE FROM timeline_parts WHERE collection_id IN ${ids} OR part_id IN ${ids}`).run(value, value);
  db.prepare(`DELETE FROM timeline_dismissals WHERE event_id IN ${ids}`).run(value);
  db.prepare(`DELETE FROM timeline_revisions WHERE event_id IN ${ids}`).run(value);
  db.prepare(`DELETE FROM timeline_events WHERE ${condition}`).run(value);
}
// The two delete lists below are hand-written lists — the database knows no foreign keys. Which table with
// `workspace_id`/`project_id` falls here, loses its reference or explicitly stays (with a reason) is held by
// `server/backend/test/schema-register.test.js` ("delete lists ↔ schema") against the schema of a fresh database:
// a new table that neither path names makes it fail. Both paths run in ONE transaction: if a statement throws
// midway, no half project or half workspace remains; the skill files only fall after the transaction (a rolled-back
// deletion would otherwise leave skills without their resources).
export function deleteProject(workspaceId, projectId) {
  const skillIds = db.prepare("SELECT id FROM skills WHERE project_id = ?").all(projectId).map((r) => r.id);
  const binIds = db.prepare("SELECT id FROM skill_history WHERE project_id = ? AND trash = 1").all(projectId).map((r) => r.id);
  const deleted = inOneTransaction(() => {
    db.prepare("DELETE FROM project_context WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM context_suggestions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_services WHERE project_id = ?").run(projectId);
    // What is meant to survive a re-scan (start instructions, corrected start commands with history — per project
    // and service name) does not survive the project: under a new project id nobody would find it again.
    db.prepare("DELETE FROM service_start_instructions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM service_start_commands WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM service_command_history WHERE project_id = ?").run(projectId);
    // Legacy: the architecture map is removed — no reader, no writer, no route. Its three tables stay (deliberately no
    // DROP, the DDL is still in db.js). These lines stay too: rows of a deleted project should go with it instead of
    // lying around without a project, because the database knows no foreign keys — nobody else would ever clear them.
    db.prepare("DELETE FROM project_architecture WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM architecture_snapshots WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM active_arch_scans WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_vars WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM agents WHERE project_id = ?").run(projectId);
    // The choice of the outer loop agents for the project-owned servers falls with them (as in deleteMcpServer).
    dropOuterLoopMcpChoice(db.prepare("SELECT id FROM mcp_servers WHERE project_id = ?").all(projectId).map((r) => r.id));
    dropAgentMcpChoice(db.prepare("SELECT id FROM mcp_servers WHERE project_id = ?").all(projectId).map((r) => r.id));
    db.prepare("DELETE FROM mcp_servers WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM skills WHERE project_id = ?").run(projectId);
    // History and deletion requests of the project skills: without the project none can be undone (undo requires the
    // project), and an open request would have no skill left. The trash folders are cleared after the transaction.
    db.prepare("DELETE FROM skill_history WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM skill_deletion_requests WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_agent_enabled WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_agent_excluded WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_mcp_enabled WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_mcp_excluded WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_var_excluded WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_skill_enabled WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_skill_excluded WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_workflow_enabled WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_dyn_workflow_enabled WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM workflow_trigger_state WHERE workflow_id IN (SELECT id FROM workflows WHERE project_id = ?)").run(projectId);
    db.prepare("DELETE FROM workflows WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_context_adopt WHERE project_id = ?").run(projectId);
    // The outer loop: the project agents with runs, notes and activation, plus the takeover of the workspace agents
    // into this project. The caller aborts running runs of these agents BEFORE (outerloop/abort.js).
    const projectAgents = "agent_id IN (SELECT id FROM outer_loop_agents WHERE project_id = ?)";
    db.prepare(`DELETE FROM outer_loop_runs WHERE ${projectAgents}`).run(projectId);
    db.prepare(`DELETE FROM outer_loop_notes WHERE ${projectAgents}`).run(projectId);
    db.prepare(`DELETE FROM outer_loop_active WHERE ${projectAgents}`).run(projectId);
    db.prepare(`DELETE FROM outer_loop_takeover WHERE project_id = ? OR ${projectAgents}`).run(projectId, projectId);
    db.prepare("DELETE FROM outer_loop_agents WHERE project_id = ?").run(projectId);
    // Chat folders of this project fall (a folder WITHOUT its scope would be unreachable) — the chats in them stay
    // and afterwards simply sit in the list without a folder.
    db.prepare("UPDATE chats SET folder_id = NULL WHERE folder_id IN (SELECT id FROM chat_folders WHERE project_id = ?)").run(projectId);
    db.prepare("DELETE FROM chat_folders WHERE project_id = ?").run(projectId);
    // The chats of the project survive it (projectbox/erase.js fetches their sessions first) — as chats WITHOUT a
    // project: otherwise `project_id` would keep pointing to the deleted project and every reader would stumble over
    // it (moving into a workspace folder 400, grouping by project lost the chat, cbase_vars_* 404, every turn pinned
    // the dead id).
    db.prepare("UPDATE chats SET project_id = NULL WHERE project_id = ?").run(projectId);
    const removed = db.prepare("DELETE FROM projects WHERE workspace_id = ? AND id = ?").run(workspaceId, projectId).changes > 0;
    // The instructions of the project (store/instructions.js) — only if it really fell in THIS workspace.
    if (removed) cleanAgentSectionsOfTheProject(projectId);
    // The timeline (store/timeline.js): append-only — its triggers allow a delete only once the project is gone, so
    // AFTER the project row and only if there is none left (a foreign workspace deletes nothing here and must not throw).
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) timelineClean("project_id = ?", projectId);
    return removed;
  });
  for (const sid of skillIds) removeSkillResources(sid);
  for (const vid of binIds) removeSkillTrash(vid);
  // After the transaction: whoever hung on the project learns it now — also without an instance row (store/project-instances.js).
  if (deleted) reportTargetRemoved({ kind: "project", projectId: String(projectId) });
  return deleted;
}

// Returns `{ chatIds, channelIds }`: what hangs on them outside the rows is cleared by the caller
// (workspaces/routes.js — the chats through the ONE close path chats/erase.js, the files of the channels under
// channel-files/<id>).
export function deleteWorkspace(id) {
  const chatIds = db.prepare("SELECT id FROM chats WHERE workspace_id = ?").all(id).map((r) => r.id);
  const channelIds = db.prepare("SELECT id FROM channels WHERE workspace_id = ?").all(id).map((r) => r.id);
  const skillIds = db.prepare("SELECT id FROM skills WHERE workspace_id = ?").all(id).map((r) => r.id);
  const binIds = db.prepare("SELECT id FROM skill_history WHERE workspace_id = ? AND trash = 1").all(id).map((r) => r.id);
  const inProjects = "IN (SELECT id FROM projects WHERE workspace_id = ?)";
  const projectIds = db.prepare("SELECT id FROM projects WHERE workspace_id = ?").all(id).map((r) => r.id);
  inOneTransaction(() => {
    for (const cid of chatIds) db.prepare("DELETE FROM messages WHERE chat_id = ?").run(cid);
    // Workflow runs with their step log hang on the chat — clean up before deleting the chats, afterwards no subquery
    // would find them again. With the WORKSPACE the history really falls (there is no place left for it); when a
    // single chat is deleted it stays.
    for (const cid of chatIds) {
      for (const r of db.prepare("SELECT id FROM workflow_runs WHERE chat_id = ?").all(cid)) {
        db.prepare("DELETE FROM workflow_run_steps WHERE run_id = ?").run(r.id);
      }
      db.prepare("DELETE FROM workflow_runs WHERE chat_id = ?").run(cid);
      db.prepare("DELETE FROM pending_resumes WHERE chat_id = ?").run(cid);
      db.prepare("DELETE FROM run_inputs WHERE chat_id = ?").run(cid);
    }
    // Plus the runs whose chat fell earlier (they stayed as history, `chat_gone`) — no chat id would find them any
    // more —, and the locks of the workflows of this workspace.
    db.prepare("DELETE FROM workflow_run_steps WHERE run_id IN (SELECT id FROM workflow_runs WHERE workspace_id = ?)").run(id);
    db.prepare("DELETE FROM workflow_runs WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM workflow_locks WHERE workspace_id = ?").run(id);
    // Scheduled jobs with their runs. The chats themselves are already in chatIds.
    cleanAgentSectionsOfTheWorkspace(id); // instructions (store/instructions.js), project level included
    db.prepare("DELETE FROM scheduled_runs WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM scheduled_jobs WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM chats WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM chat_folders WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM context_items WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM workspace_vars WHERE workspace_id = ?").run(id);
    // The stored git credentials: plain-text secrets that must not survive the workspace.
    db.prepare("DELETE FROM workspace_git_creds WHERE workspace_id = ?").run(id);
    db.prepare(`DELETE FROM project_context WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM context_suggestions WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_services WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM service_start_instructions WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM service_start_commands WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM service_command_history WHERE project_id ${inProjects}`).run(id);
    // Legacy of the removed architecture map — see deleteProject; both places clean up the same way, otherwise one
    // delete path orphans what the other keeps clean.
    db.prepare(`DELETE FROM project_architecture WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM architecture_snapshots WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM active_arch_scans WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_vars WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_agent_enabled WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_agent_excluded WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_mcp_enabled WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_mcp_excluded WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_var_excluded WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_skill_enabled WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_skill_excluded WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_workflow_enabled WHERE project_id ${inProjects}`).run(id);
    db.prepare(`DELETE FROM project_dyn_workflow_enabled WHERE project_id ${inProjects}`).run(id);
    db.prepare("DELETE FROM dyn_workflows WHERE workspace_id = ?").run(id);
    db.prepare(`DELETE FROM project_context_adopt WHERE project_id ${inProjects}`).run(id);
    db.prepare("DELETE FROM workflow_trigger_state WHERE workflow_id IN (SELECT id FROM workflows WHERE workspace_id = ?)").run(id);
    db.prepare("DELETE FROM workflows WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM mcp_servers WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM agents WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM skills WHERE workspace_id = ?").run(id);
    // History and deletion requests of the skills — as in deleteProject; the trash folders after the transaction.
    db.prepare("DELETE FROM skill_history WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM skill_deletion_requests WHERE workspace_id = ?").run(id);
    // The channels with participants and log: every participant is a chat of THIS workspace (channels/lifecycle.js
    // allows no other) — a channel surviving the workspace would only have dead ones. The caller clears the files
    // (channelIds).
    db.prepare("DELETE FROM channel_messages WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").run(id);
    db.prepare("DELETE FROM channel_participants WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").run(id);
    db.prepare("DELETE FROM channels WHERE workspace_id = ?").run(id);
    // The outer loop: all agents of the workspace with runs, notes, activation and takeover — also the takeover rows
    // of its projects. The route aborts running runs BEFORE (outerloop/abort.js).
    const wsAgents = "agent_id IN (SELECT id FROM outer_loop_agents WHERE workspace_id = ?)";
    db.prepare(`DELETE FROM outer_loop_runs WHERE ${wsAgents}`).run(id);
    db.prepare(`DELETE FROM outer_loop_notes WHERE ${wsAgents}`).run(id);
    db.prepare(`DELETE FROM outer_loop_active WHERE ${wsAgents}`).run(id);
    db.prepare(`DELETE FROM outer_loop_takeover WHERE ${wsAgents} OR project_id ${inProjects}`).run(id, id);
    db.prepare("DELETE FROM outer_loop_agents WHERE workspace_id = ?").run(id);
    // The log of the agenda keeper (store/agenda-upkeep.js) — its chats and its agent go here too.
    db.prepare("DELETE FROM agenda_upkeep WHERE workspace_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE workspace_id = ?").run(id);
    timelineClean("workspace_id = ?", id); // the timeline AFTER the projects (see deleteProject)
    // The settings PER workspace: they are not in a table with workspace_id but in app_settings under a key that ENDS
    // in `.<workspaceId>` — time zone and approval marks (workspaces/timeZone.js, toolchain/approval-marks.js). The
    // guard "delete lists ↔ schema" only sees columns. By suffix instead of a list of keys: a new key of the same form
    // falls too without anyone knowing this line (the ids are UUIDs — no foreign setting ends like that).
    // Guard: closePath.test.js (token through the real route, a neighboring workspace keeps its own).
    if (id) {
      const suffix = `.${id}`;
      db.prepare("DELETE FROM app_settings WHERE length(key) > ? AND substr(key, ?) = ?").run(suffix.length, -suffix.length, suffix);
    }
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  });
  for (const sid of skillIds) removeSkillResources(sid);
  for (const vid of binIds) removeSkillTrash(vid);
  // As in deleteProject, per project of the workspace.
  for (const pid of projectIds) reportTargetRemoved({ kind: "project", projectId: String(pid) });
  return { chatIds, channelIds };
}

// ── Workspace credentials per project: available everywhere, exceptions per project ────
export const listExcludedWorkspaceVarIds = (projectId) =>
  new Set(db.prepare("SELECT workspace_var_id FROM project_var_excluded WHERE project_id = ?").all(projectId).map((r) => r.workspace_var_id));
// available=true shows a workspace var in the project (again), false hides it.
export function setWorkspaceVarAvailable(projectId, wsVarId, available) {
  if (available) db.prepare("DELETE FROM project_var_excluded WHERE project_id = ? AND workspace_var_id = ?").run(projectId, Number(wsVarId));
  else db.prepare("INSERT OR IGNORE INTO project_var_excluded (project_id, workspace_var_id) VALUES (?, ?)").run(projectId, Number(wsVarId));
}
// Effective credentials for a project chat: own project vars PLUS all workspace vars the project has not hidden
// (on equal keys the project wins). Every entry carries `origin`.
export function effectiveProjectVars(projectId, workspaceId) {
  const byKey = new Map();
  if (workspaceId) {
    const excluded = listExcludedWorkspaceVarIds(projectId);
    for (const v of listVars(workspaceId)) if (!excluded.has(v.id)) byKey.set(v.key, { ...v, origin: "workspace" });
  }
  for (const v of listProjectVars(projectId)) byKey.set(v.key, { ...v, origin: "project" });
  return [...byKey.values()];
}
// Resolve an effective credential value per key (project first, then the workspace var unless hidden).
export function resolveProjectVar(projectId, workspaceId, key) {
  const own = getProjectVarByKey(projectId, key);
  if (own) return { ...own, origin: "project" };
  if (workspaceId) {
    const wv = getVarByKey(workspaceId, key);
    if (wv && !listExcludedWorkspaceVarIds(projectId).has(wv.id)) return { ...wv, origin: "workspace" };
  }
  return null;
}
// Effective credentials for a WORKSPACE chat: own workspace vars PLUS the vars of ALL projects (the workspace level
// sees everything). On equal keys the workspace wins, then the project created first. origin = "workspace" or the
// project name.
export function effectiveWorkspaceVars(workspaceId) {
  return withAllProjectItems(
    workspaceId,
    listVars(workspaceId).map((v) => ({ ...v, origin: "workspace" })),
    (pid, p) => listProjectVars(pid).map((v) => ({ ...v, origin: `project "${p.name}"` })),
    listProjects,
    (v) => v.key,
  );
}
// Resolve a credential value from the workspace view (workspace first, then projects in creation order).
export function resolveWorkspaceVar(workspaceId, key) {
  const wv = getVarByKey(workspaceId, key);
  if (wv) return { ...wv, origin: "workspace" };
  for (const p of listProjects(workspaceId)) {
    const pv = getProjectVarByKey(p.id, key);
    if (pv) return { ...pv, origin: `project "${p.name}"` };
  }
  return null;
}

// ── Credentials / variables / links (workspace OR project level) ──────────────
// Shared CRUD logic over workspace_vars (owner=workspace_id) and project_vars (owner=project_id).
// table/ownerCol are internal constants (no user input) — interpolation is safe here.
const mapVar = (r) => ({
  id: r.id, key: r.key, kind: r.kind, value: r.value, description: r.description,
  mcpAccess: Boolean(r.mcp_access), createdAt: r.created_at, updatedAt: r.updated_at,
});
function makeVarStore(table, ownerCol) {
  return {
    list: (owner) =>
      db.prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = ? ORDER BY kind, key`).all(owner).map(mapVar),
    count: (owner) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${ownerCol} = ?`).get(owner).n,
    getByKey: (owner, key) => {
      const r = db.prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = ? AND key = ?`).get(owner, key);
      return r ? mapVar(r) : null;
    },
    create: (owner, { key, kind, value, description, mcpAccess }) => {
      const now = Date.now();
      const info = db.prepare(
        `INSERT INTO ${table} (${ownerCol}, key, kind, value, description, mcp_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(owner, key, kind, value, description || "", mcpAccess ? 1 : 0, now, now);
      return mapVar(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid));
    },
    update: (id, fields) => {
      const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!cur) return null;
      const next = {
        key: fields.key ?? cur.key, kind: fields.kind ?? cur.kind, value: fields.value ?? cur.value,
        description: fields.description ?? cur.description,
        mcp_access: fields.mcpAccess === undefined ? cur.mcp_access : fields.mcpAccess ? 1 : 0,
      };
      db.prepare(`UPDATE ${table} SET key=?, kind=?, value=?, description=?, mcp_access=?, updated_at=? WHERE id=?`)
        .run(next.key, next.kind, next.value, next.description, next.mcp_access, Date.now(), id);
      return mapVar(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
    },
    remove: (id) => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0,
  };
}

const wsVars = makeVarStore("workspace_vars", "workspace_id");
const projVars = makeVarStore("project_vars", "project_id");

// Workspace credentials
export const listVars = wsVars.list;
export const countVars = wsVars.count;
export const getVarByKey = wsVars.getByKey;
export const createVar = wsVars.create;
export const updateVar = wsVars.update;
// When a workspace var is deleted, also remove its project exceptions (foreign-key cleanup).
export function deleteVar(id) {
  db.prepare("DELETE FROM project_var_excluded WHERE workspace_var_id = ?").run(Number(id));
  return wsVars.remove(id);
}

// Project credentials
export const listProjectVars = projVars.list;
export const countProjectVars = projVars.count;
export const getProjectVarByKey = projVars.getByKey;
export const createProjectVar = projVars.create;
export const updateProjectVar = projVars.update;
export const deleteProjectVar = projVars.remove;

// Wrapper export (store-facade.test.js requires this form for new names).
export { gitAccessesFor };
