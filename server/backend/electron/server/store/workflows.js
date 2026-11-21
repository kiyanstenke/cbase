// Workflows (definitions), trigger state, GitLab accounts, runs, locks and step log — the data layer next to
// ../workflows.js (the graph library).
// Answers: which run holds which lock, and where is the step log.

import { T } from "../i18n.js";
import { db, nowMs } from "./db.js";
import { safeJson, withAllProjectItems } from "./_util.js";
import { listProjects } from "./projects.js";


// ── Workflows (node/edge graph, worked through step by step by the agent) ──────────────────────
const mapWorkflow = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id || null, name: r.name,
  description: r.description || "", graph: parseGraph(r.graph), active: !!r.active,
  lock: { scope: r.lock_scope || "project", template: r.lock_key || "" },
  run: safeJson(r.run_settings, {}),
  createdAt: r.created_at, updatedAt: r.updated_at,
};
function parseGraph(raw) {
  try {
    const g = JSON.parse(raw || "{}");
    return { nodes: Array.isArray(g.nodes) ? g.nodes : [], edges: Array.isArray(g.edges) ? g.edges : [] };
  } catch { return { nodes: [], edges: [] }; }
}
export const listWorkspaceWorkflows = (wsId) =>
  db.prepare("SELECT * FROM workflows WHERE workspace_id = ? AND project_id IS NULL ORDER BY name").all(wsId).map(mapWorkflow);
export const listProjectWorkflows = (projectId) =>
  db.prepare("SELECT * FROM workflows WHERE project_id = ? ORDER BY name").all(projectId).map(mapWorkflow);
export const getWorkflow = (id) => mapWorkflow(db.prepare("SELECT * FROM workflows WHERE id = ?").get(id));
export const getWorkflowByName = (wsId, projectId, name) =>
  mapWorkflow(projectId
    ? db.prepare("SELECT * FROM workflows WHERE project_id = ? AND name = ?").get(projectId, name)
    : db.prepare("SELECT * FROM workflows WHERE workspace_id = ? AND project_id IS NULL AND name = ?").get(wsId, name));
export function createWorkflow({ id, workspaceId, projectId = null, name, description = "", graph = { nodes: [], edges: [] }, createdAt, updatedAt }) {
  db.prepare(`INSERT INTO workflows (id, workspace_id, project_id, name, description, graph, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, projectId, name, description, JSON.stringify(graph), createdAt, updatedAt);
  return getWorkflow(id);
}
export function updateWorkflow(id, fields) {
  const sets = [], vals = [];
  if (typeof fields.name === "string") { sets.push("name = ?"); vals.push(fields.name); }
  if (typeof fields.description === "string") { sets.push("description = ?"); vals.push(fields.description); }
  if (fields.graph) { sets.push("graph = ?"); vals.push(JSON.stringify(fields.graph)); }
  if (typeof fields.active === "boolean") { sets.push("active = ?"); vals.push(fields.active ? 1 : 0); }
  if (fields.lock) {
    sets.push("lock_scope = ?"); vals.push(String(fields.lock.scope || "project"));
    sets.push("lock_key = ?"); vals.push(String(fields.lock.template || ""));
  }
  if (fields.run) { sets.push("run_settings = ?"); vals.push(JSON.stringify(fields.run)); }
  if (fields.updatedAt) { sets.push("updated_at = ?"); vals.push(fields.updatedAt); }
  if (!sets.length) return getWorkflow(id);
  vals.push(id);
  db.prepare(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getWorkflow(id);
}
export function deleteWorkflow(id) {
  const w = getWorkflow(id);
  // A run without a workflow can do nothing any more. A RUNNING one notices that by itself at the next drive (the
  // driver ends it with the same reason) — a WAITING one never: nobody ever drives it again, it would stay in
  // "waiting" forever and hold its lock, which then blocks every other workflow with the same key.
  const open = db.prepare("SELECT id FROM workflow_runs WHERE workflow_id = ? AND status = 'waiting'").all(id);
  const now = nowMs();
  for (const r of open) {
    db.prepare("UPDATE workflow_runs SET status = 'failed', note = ?, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(T("The workflow was deleted."), now, now, r.id);
    releaseLock(r.id);
  }
  db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  db.prepare("DELETE FROM workflow_trigger_state WHERE workflow_id = ?").run(id);
  if (w) db.prepare("DELETE FROM project_workflow_enabled WHERE workflow_name = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)").run(w.name, w.workspaceId);
  return true;
}
// Armed workflows — the basis of the trigger poller (it runs globally, not per workspace).
export const listActiveWorkflows = () =>
  db.prepare("SELECT * FROM workflows WHERE active = 1").all().map(mapWorkflow);

// ── Trigger state per node ─────────────────────────────────────────────────────────────────────
const jsonObject = (raw) => {
  try { const o = JSON.parse(raw || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
};
const mapTriggerState = (r) => r && {
  workflowId: r.workflow_id, nodeId: r.node_id, since: r.since,
  seen: (() => { try { const a = JSON.parse(r.seen || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })(),
  // The waterline per event kind (workflows/triggers.js:waterlineFor) — only applies where it lies above `since`.
  sinceKind: jsonObject(r.since_kind),
  // The read pointer of a kind with a backlog (workflows/triggers.js:readPointerFor) — empty without a backlog.
  continueKind: jsonObject(r.continue_kind),
  lastPollAt: r.last_poll_at, lastFireAt: r.last_fire_at, lastError: r.last_error || "", fires: r.fires,
};
export const getTriggerState = (workflowId, nodeId) =>
  mapTriggerState(db.prepare("SELECT * FROM workflow_trigger_state WHERE workflow_id = ? AND node_id = ?").get(workflowId, nodeId));
export const listTriggerStates = (workflowId) =>
  db.prepare("SELECT * FROM workflow_trigger_state WHERE workflow_id = ?").all(workflowId).map(mapTriggerState);
// Creates the row if needed. `since` = from when events count: NOW when arming, so that half the project history
// does not start runs after the fact.
export function ensureTriggerState(workflowId, nodeId, since) {
  db.prepare(`INSERT INTO workflow_trigger_state (workflow_id, node_id, since) VALUES (?, ?, ?)
              ON CONFLICT(workflow_id, node_id) DO NOTHING`).run(workflowId, nodeId, since);
  return getTriggerState(workflowId, nodeId);
}
export function updateTriggerState(workflowId, nodeId, fields) {
  const sets = [], vals = [];
  if (Number.isFinite(fields.since)) { sets.push("since = ?"); vals.push(fields.since); }
  // Whoever sets the waterline WITHOUT kinds (arming: "from now on") sets it for all kinds — and discards every read
  // pointer of a backlog that would lie before "now".
  const withKinds = !!fields.sinceKind && typeof fields.sinceKind === "object";
  const arm = Number.isFinite(fields.since) && !withKinds;
  if (withKinds) { sets.push("since_kind = ?"); vals.push(JSON.stringify(fields.sinceKind)); }
  else if (arm) sets.push("since_kind = '{}'");
  if (fields.continueKind && typeof fields.continueKind === "object") { sets.push("continue_kind = ?"); vals.push(JSON.stringify(fields.continueKind)); }
  else if (arm) sets.push("continue_kind = '{}'");
  if (Array.isArray(fields.seen)) { sets.push("seen = ?"); vals.push(JSON.stringify(fields.seen.slice(-400))); }
  if (Number.isFinite(fields.lastPollAt)) { sets.push("last_poll_at = ?"); vals.push(fields.lastPollAt); }
  if (Number.isFinite(fields.lastFireAt)) { sets.push("last_fire_at = ?"); vals.push(fields.lastFireAt); }
  if (typeof fields.lastError === "string") { sets.push("last_error = ?"); vals.push(fields.lastError.slice(0, 400)); }
  if (Number.isFinite(fields.fires)) { sets.push("fires = ?"); vals.push(fields.fires); }
  if (!sets.length) return getTriggerState(workflowId, nodeId);
  vals.push(workflowId, nodeId);
  db.prepare(`UPDATE workflow_trigger_state SET ${sets.join(", ")} WHERE workflow_id = ? AND node_id = ?`).run(...vals);
  return getTriggerState(workflowId, nodeId);
}
// Clean up rows of deleted trigger nodes (the editor can remove nodes).
export function pruneTriggerStates(workflowId, keepNodeIds) {
  const keep = new Set(keepNodeIds);
  for (const r of listTriggerStates(workflowId)) {
    if (!keep.has(r.nodeId)) db.prepare("DELETE FROM workflow_trigger_state WHERE workflow_id = ? AND node_id = ?").run(workflowId, r.nodeId);
  }
}

// ── GitLab accounts (global; the token is a secret and never leaves the server) ─────────────────
const mapGitlabAccount = (r) => r && {
  id: r.id, label: r.label || "", host: r.host, userName: r.user_name || "", userId: r.user_id || 0,
  hasToken: !!(r.token && r.token.length), status: r.status || "", checkedAt: r.checked_at,
  createdAt: r.created_at, updatedAt: r.updated_at,
};
export const listGitlabAccounts = () =>
  db.prepare("SELECT * FROM gitlab_accounts ORDER BY created_at ASC").all().map(mapGitlabAccount);
export const getGitlabAccount = (id) => mapGitlabAccount(db.prepare("SELECT * FROM gitlab_accounts WHERE id = ?").get(id));
// Only for the server: account WITH token (for the API calls).
export function getGitlabAccountWithToken(id) {
  const r = db.prepare("SELECT * FROM gitlab_accounts WHERE id = ?").get(id);
  return r ? { ...mapGitlabAccount(r), token: r.token || "" } : null;
}
export function createGitlabAccount({ id, label = "", host, token = "", userName = "", userId = 0, createdAt, updatedAt }) {
  db.prepare(`INSERT INTO gitlab_accounts (id, label, host, token, user_name, user_id, status, checked_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`)
    .run(id, label, host, token, userName, userId, updatedAt, createdAt, updatedAt);
  return getGitlabAccount(id);
}
export function updateGitlabAccount(id, fields) {
  const sets = [], vals = [];
  if (typeof fields.label === "string") { sets.push("label = ?"); vals.push(fields.label); }
  if (typeof fields.host === "string" && fields.host) { sets.push("host = ?"); vals.push(fields.host); }
  if (typeof fields.token === "string" && fields.token) { sets.push("token = ?"); vals.push(fields.token); }
  if (typeof fields.userName === "string") { sets.push("user_name = ?"); vals.push(fields.userName); }
  if (Number.isFinite(fields.userId)) { sets.push("user_id = ?"); vals.push(fields.userId); }
  if (typeof fields.status === "string") { sets.push("status = ?"); vals.push(fields.status.slice(0, 400)); }
  if (Number.isFinite(fields.checkedAt)) { sets.push("checked_at = ?"); vals.push(fields.checkedAt); }
  if (Number.isFinite(fields.updatedAt)) { sets.push("updated_at = ?"); vals.push(fields.updatedAt); }
  if (!sets.length) return getGitlabAccount(id);
  vals.push(id);
  db.prepare(`UPDATE gitlab_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getGitlabAccount(id);
}
export const deleteGitlabAccount = (id) =>
  db.prepare("DELETE FROM gitlab_accounts WHERE id = ?").run(id).changes > 0;
// Effective workflows for a chat — the same rule as for skills: a workspace chat sees the workspace workflows PLUS
// those of all projects (with origin), a project chat its own PLUS the workspace workflows adopted in the project.
// On equal names the project wins.
export function effectiveWorkflows(workspaceId, projectId = null) {
  const wsAll = listWorkspaceWorkflows(workspaceId);
  if (!projectId) {
    return withAllProjectItems(workspaceId, wsAll,
      (pid, p) => listProjectWorkflows(pid).map((w) => ({ ...w, originProject: p.name })), listProjects);
  }
  const enabled = listEnabledWorkflowNames(projectId);
  const byName = new Map();
  for (const w of wsAll) if (enabled.has(w.name)) byName.set(w.name, w);
  for (const w of listProjectWorkflows(projectId)) byName.set(w.name, w);
  return [...byName.values()];
}
export const listEnabledWorkflowNames = (projectId) =>
  new Set(db.prepare("SELECT workflow_name FROM project_workflow_enabled WHERE project_id = ?").all(projectId).map((r) => r.workflow_name));
// When a workspace workflow is renamed, carry the name-based adoption of the projects along.
export function renameWorkflowAdoptions(workspaceId, oldName, newName) {
  db.prepare(`UPDATE OR REPLACE project_workflow_enabled SET workflow_name = ?
              WHERE workflow_name = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)`)
    .run(newName, oldName, workspaceId);
}
export function setWorkflowEnabled(projectId, workflowName, on) {
  if (on) db.prepare("INSERT OR IGNORE INTO project_workflow_enabled (project_id, workflow_name) VALUES (?, ?)").run(projectId, workflowName);
  else db.prepare("DELETE FROM project_workflow_enabled WHERE project_id = ? AND workflow_name = ?").run(projectId, workflowName);
}

// ── Workflow runs (one row per run; this is what the history consists of) ──────────────────────
const RUN_HISTORY_CAP = Number(process.env.CBASE_RUN_HISTORY_CAP) || 400; // per workspace
const mapWorkflowRun = (r) => r && {
  id: r.id, chatId: r.chat_id, workflowId: r.workflow_id, workflowName: r.workflow_name,
  status: r.status, cursor: safeJson(r.cursor, {}), input: r.input || "",
  step: r.step || 0, total: r.total || 0, nodeId: r.node_id || "", nodeTitle: r.node_title || "",
  question: r.question || "", note: r.note || "",
  origin: r.origin || "", triggerEvent: r.trigger_event ? safeJson(r.trigger_event, null) : null,
  workspaceId: r.workspace_id || "", projectId: r.project_id || null, chatGone: !!r.chat_gone,
  startedAt: r.started_at, updatedAt: r.updated_at, endedAt: r.ended_at || 0,
};
// ── The term "open" ────────────────────────────────────────────────────────────────────────────
// A workflow run is OPEN as long as it still belongs to somebody: `running` means "a driver moves it forward",
// `waiting` means "a human is up" (question node, round cap, review). It has ended as `done` | `failed` |
// `cancelled` (the status set is in store/db.js at the column). "Open" is thus NOT "running" — confusing the two
// once marked a waiting row at the limit as having no workflow although one hung on it (a verdict parked at the
// limit arises exactly when the run stands on `waiting`), and a row marked wrongly once never heals.
//
// Two forms, ONE term: `workflowOpen` asks about a row already read (the caller has it anyway), `workflowOpenFor`
// reads it itself. And the SQL is built from the same list — otherwise the data layer would be the next copy.
// Deliberately not "running" in the name: that word carried the confusion.
const WORKFLOW_OPEN = ["running", "waiting"];
const workflowOpen = (run) => Boolean(run) && WORKFLOW_OPEN.includes(run.status);
const workflowOpenFor = (chatId) => workflowOpen(getWorkflowRun(chatId));
// The same list as an SQL condition — the column is not called `status` everywhere (in a JOIN it is `wr.status`),
// hence a parameter and not a constant.
const workflowOpenSql = (column = "status", negated = false) =>
  `${column} ${negated ? "NOT IN" : "IN"} (${WORKFLOW_OPEN.map((s) => `'${s}'`).join(", ")})`;
const OPEN_SQL = workflowOpenSql();
const TO_SQL = workflowOpenSql("status", true);

// The RUNNING (or most recent) run of a chat. All callers of the driver think in chats — the resolution to the run
// id happens here so that nothing changes at the call sites.
export const getWorkflowRun = (chatId) =>
  mapWorkflowRun(db.prepare("SELECT * FROM workflow_runs WHERE chat_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(chatId));
export const getWorkflowRunById = (id) => mapWorkflowRun(db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id));
export function startWorkflowRun({ id, chatId, workflowId, workflowName, input = "", total = 0, cursor = {}, origin = "", triggerEvent = null, workspaceId = "", projectId = null }) {
  const now = nowMs();
  db.prepare(`INSERT INTO workflow_runs (id, chat_id, workflow_id, workflow_name, status, cursor, input,
                step, total, node_id, node_title, question, note, origin, trigger_event, workspace_id,
                project_id, started_at, updated_at)
              VALUES (?, ?, ?, ?, 'running', ?, ?, 0, ?, '', '', '', '', ?, ?, ?, ?, ?, ?)`)
    .run(id, chatId, workflowId, workflowName, JSON.stringify(cursor), input, total, origin,
      triggerEvent ? JSON.stringify(triggerEvent) : "", workspaceId, projectId, now, now);
  pruneRunHistory(workspaceId);
  return getWorkflowRunById(id);
}
// Updates the running run OF THE CHAT (not all its runs) — the driver addresses via the chat, the history must not
// be touched by it.
export function updateWorkflowRun(chatId, fields) {
  const run = getWorkflowRun(chatId);
  if (!run) return null;
  return updateWorkflowRunById(run.id, fields);
}
export function updateWorkflowRunById(id, fields) {
  const map = {
    status: "status", input: "input", step: "step", total: "total",
    nodeId: "node_id", nodeTitle: "node_title", question: "question", note: "note",
  };
  const sets = ["updated_at = ?"], vals = [nowMs()];
  // `undefined` is not a value but "not set" — a caller that writes `{ cursor, note }` with a note it does not have
  // does not mean the field. Bound to SQLite, however, `undefined` is a bind error ("Cannot bind undefined"), which
  // once tore down the whole driver at the completion gate: the run stayed on "running" without completion and held
  // its lock. A `null` stays a value (NULL in the column).
  for (const k in fields) if (map[k] && fields[k] !== undefined) { sets.push(`${map[k]} = ?`); vals.push(fields[k]); }
  if (fields.cursor) { sets.push("cursor = ?"); vals.push(JSON.stringify(fields.cursor)); }
  // A final status stamps the end — the basis of the duration in the history.
  const ending = typeof fields.status === "string" && ["done", "failed", "cancelled"].includes(fields.status);
  if (ending) { sets.push("ended_at = ?"); vals.push(nowMs()); }
  vals.push(id);
  db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  // Release of the lock EXACTLY HERE — at the one place every final state passes through (end, error, abort). A
  // release at the call sites would be forgotten at some point and the trigger would stand still forever.
  if (ending) releaseLock(id);
  return getWorkflowRunById(id);
}
// The note of a run closed by the deletion of its chat: stored in English as it is (the views translate it for display;
// workflows/graph-background.js compares it). Old German rows are rewritten by the private migration tool.
const CHAT_DELETED_NOTE = "Chat deleted";
// The chat is gone (deleted), the run stays as a record: mark the reference as dead and complete an open run so
// that resumeInterruptedWork does not want to pick it up forever.
export function abandonWorkflowRuns(chatId, note = "") {
  const now = nowMs();
  db.prepare(`UPDATE workflow_runs SET chat_gone = 1,
                status = CASE WHEN ${OPEN_SQL} THEN 'cancelled' ELSE status END,
                note = CASE WHEN ${OPEN_SQL} THEN ? ELSE note END,
                ended_at = CASE WHEN ended_at = 0 THEN ? ELSE ended_at END,
                updated_at = ?
              WHERE chat_id = ?`).run(String(note).slice(0, 200), now, now, chatId);
  // The run has thereby ended → its lock must not hold anybody up any more.
  db.prepare("DELETE FROM workflow_locks WHERE chat_id = ?").run(chatId);
}

// ── Locks (concurrency) ────────────────────────────────────────────────────────────────────────
const mapLock = (r) => r && {
  key: r.key, runId: r.run_id, chatId: r.chat_id || "", workflowId: r.workflow_id || "",
  workflowName: r.workflow_name || "", workspaceId: r.workspace_id || "", at: r.at,
};
// A lock only holds as long as its run is open. Everything else is orphaned (crash, restart, deleted history) and
// is removed here — hence no time limit and no heartbeat are needed: after a restart a resumed run keeps its lock,
// a dead one does not.
export function reapStaleLocks() {
  return db.prepare(`DELETE FROM workflow_locks
                     WHERE run_id NOT IN (SELECT id FROM workflow_runs WHERE ${OPEN_SQL})`).run().changes;
}
export const getLock = (key) => mapLock(db.prepare("SELECT * FROM workflow_locks WHERE key = ?").get(String(key || "")));
export const listLocks = () => db.prepare("SELECT * FROM workflow_locks ORDER BY at ASC").all().map(mapLock);
export const lockOfRun = (runId) => mapLock(db.prepare("SELECT * FROM workflow_locks WHERE run_id = ?").get(String(runId || "")));
// Who holds the key right now? (cleans up first so that an orphaned lock does not block)
export function lockHolder(key) {
  if (!key) return null;
  reapStaleLocks();
  return getLock(key);
}
// Acquiring is REENTRANT: the same run may acquire several times (the trigger secures the lock before the chat
// exists, the driver checks it again later).
export function acquireLock(key, { runId, chatId = "", workflowId = "", workflowName = "", workspaceId = "" } = {}) {
  if (!key || !runId) return { ok: true, lock: null };
  reapStaleLocks();
  const r = db.prepare(`INSERT OR IGNORE INTO workflow_locks (key, run_id, chat_id, workflow_id, workflow_name, workspace_id, at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(String(key), runId, chatId, workflowId, String(workflowName || "").slice(0, 120), workspaceId, nowMs());
  if (r.changes) return { ok: true, lock: getLock(key) };
  const holder = getLock(key);
  if (holder?.runId !== runId) return { ok: false, lock: holder };
  // Reentry: fill in missing details (e.g. the chat that did not exist yet at the first acquisition) — the message
  // "chat X holds the lock" needs them.
  if (chatId && !holder.chatId) db.prepare("UPDATE workflow_locks SET chat_id = ? WHERE key = ?").run(chatId, String(key));
  return { ok: true, lock: getLock(key) };
}
// Deliberately a function DECLARATION: updateWorkflowRunById stands further up in the file and calls it — as a
// const arrow it would still lie in the temporal dead zone there.
export function releaseLock(runId) {
  return db.prepare("DELETE FROM workflow_locks WHERE run_id = ?").run(String(runId || "")).changes;
}
// Runs that were still open at the restart (running/waiting) — resumeInterruptedWork picks them up.
export const listOpenWorkflowRuns = () =>
  db.prepare(`SELECT * FROM workflow_runs WHERE ${OPEN_SQL}`).all().map(mapWorkflowRun);
// History: newest first, without cursor/input (the list shows header data).
export function listWorkflowRuns({ workspaceId = "", projectId = "", workflowId = "", chatId = "", status = "", limit = 100 } = {}) {
  const where = [], vals = [];
  if (workspaceId) { where.push("workspace_id = ?"); vals.push(workspaceId); }
  if (projectId) { where.push("project_id = ?"); vals.push(projectId); }
  if (workflowId) { where.push("workflow_id = ?"); vals.push(workflowId); }
  if (chatId) { where.push("chat_id = ?"); vals.push(chatId); }
  if (status === "open") where.push(OPEN_SQL);
  else if (status) { where.push("status = ?"); vals.push(status); }
  // Integer: a decimal from the URL ("limit=10.5") went to SQLite as REAL and ended in "datatype mismatch" — a 500
  // for an input that deserves a 400 at most. And 0 explicitly means "no rows", not "take the default".
  const raw = Number(limit);
  vals.push(Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), 500) : 100);
  return db.prepare(`SELECT * FROM workflow_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                     ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(...vals).map(mapWorkflowRun);
}
// Retention is capped: the oldest runs of a workspace fall together with their steps. Open runs are exempt — they
// must never disappear.
export function pruneRunHistory(workspaceId) {
  if (!workspaceId) return;
  const old = db.prepare(`SELECT id FROM workflow_runs
                          WHERE workspace_id = ? AND ${TO_SQL}
                          ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?`).all(workspaceId, RUN_HISTORY_CAP);
  for (const r of old) {
    db.prepare("DELETE FROM workflow_run_steps WHERE run_id = ?").run(r.id);
    db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(r.id);
  }
}

// ── Step log of a run ──────────────────────────────────────────────────────────────────────────
const mapRunStep = (r) => r && {
  id: r.id, runId: r.run_id, at: r.at, durationMs: r.duration_ms || 0, kind: r.kind,
  nodeId: r.node_id || "", nodeTitle: r.node_title || "", step: r.step || 0,
  detail: safeJson(r.detail, {}),
};
export function addRunStep(runId, { kind, nodeId = "", nodeTitle = "", step = 0, detail = {}, at = null }) {
  if (!runId) return null;
  const info = db.prepare(`INSERT INTO workflow_run_steps (run_id, at, kind, node_id, node_title, step, detail)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, at || nowMs(), String(kind), nodeId, String(nodeTitle).slice(0, 200), step, JSON.stringify(detail || {}));
  return Number(info.lastInsertRowid);
}
// Addendum as soon as the turn has ended: duration and result excerpt belong to the step ALREADY written (it is
// logged at the start so that a crash in the middle of the turn stays visible).
export function finishRunStep(stepRowId, { durationMs = 0, detail = null } = {}) {
  if (!stepRowId) return;
  const row = db.prepare("SELECT detail FROM workflow_run_steps WHERE id = ?").get(stepRowId);
  if (!row) return;
  const merged = detail ? { ...safeJson(row.detail, {}), ...detail } : safeJson(row.detail, {});
  db.prepare("UPDATE workflow_run_steps SET duration_ms = ?, detail = ? WHERE id = ?")
    .run(Math.max(0, Math.round(durationMs)), JSON.stringify(merged), stepRowId);
}
// Remove a run with its steps from the history (cleanup by hand).
export function deleteWorkflowRun(id) {
  db.prepare("DELETE FROM workflow_run_steps WHERE run_id = ?").run(id);
  releaseLock(id); // without a run there is nothing left to lock
  return db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(id).changes > 0;
}
export const listRunSteps = (runId) =>
  db.prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY id ASC").all(runId).map(mapRunStep);
export const lastRunStepId = (runId) => {
  const r = db.prepare("SELECT id FROM workflow_run_steps WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(runId);
  return r ? Number(r.id) : null;
};

// Wrapper export: the term "open" belongs to the data layer of these runs but is needed outside (runs/, workflows/,
// chats/) — hence it goes out via the facade. Guard: server/backend/test/workflow-open.test.js.
export { CHAT_DELETED_NOTE, WORKFLOW_OPEN, workflowOpen, workflowOpenFor, workflowOpenSql };
