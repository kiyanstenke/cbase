// Toolchain per workspace/project: custom subagents, effective agent set, MCP servers and their activation, skills
// and skill adoption.
// Answers: which agents/MCP servers/skills apply to a chat, and in which project is a workspace skill hidden.
// Registered schemas (names in store.js):
//   `initWsAgentsSchema` ("ws-agents-default") — the default of the workspace agents per project (column
//     `projects.ws_agents_default`) and the exceptions of a project that adopts them (`project_agent_excluded`).
//   `initSkillAreaSchema` ("skills-area") — every skill belongs to exactly ONE area, a workspace Coding skill
//     applies in every project until the project hides it (`project_skill_excluded`), and the one-time migration.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, inOneTransaction, skillResRoot } from "./db.js";
import { safeJson, withAllProjectItems } from "./_util.js";
import { listProjects } from "./projects.js";
import { dropOuterLoopMcpChoice } from "./outer-loop.js";


// ── Custom subagents (app managed) ───────────────────────────────────────────
// The tool list: the JSON column if set; otherwise the old comma list (a row from before the migration) — `null`
// means not set, `[]` empty.
function toolListOf(r) {
  if (r.tool_list != null) {
    try { const v = JSON.parse(r.tool_list); if (Array.isArray(v)) return v.map(String); } catch { /* unreadable ⇒ like the comma list */ }
  }
  const old = String(r.tools || "").split(",").map((x) => x.trim()).filter(Boolean);
  return old.length ? old : null;
}
// The Coding MCP servers of the type: `{ <serverId>: null | [tool, …] }`, `{}` = none. An unreadable row reads as
// none — the narrower set (a subagent then only gets what it has through "subagents inherit").
function mcpChoiceOf(r) {
  try {
    const v = JSON.parse(r.mcp ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out = {};
    for (const [id, w] of Object.entries(v)) {
      if (w === null) out[id] = null;
      else if (Array.isArray(w) && w.length) out[id] = w.map(String);
    }
    return out;
  } catch { return {}; }
}
const mapAgent = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, name: r.name,
  description: r.description, tools: r.tools, toolList: toolListOf(r), model: r.model, body: r.body,
  // Comma list like `tools` — one notation for both lists of the definition.
  skills: r.skills || "",
  mcp: mcpChoiceOf(r),
  createdAt: r.created_at, updatedAt: r.updated_at,
};
export const listWorkspaceAgents = (wsId) =>
  db.prepare("SELECT * FROM agents WHERE workspace_id = ? AND project_id IS NULL ORDER BY name").all(wsId).map(mapAgent);
export const listProjectAgents = (projectId) =>
  db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY name").all(projectId).map(mapAgent);
export const getAgent = (id) => mapAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(id));
// The tool list migration: existing definitions with a comma list and without a JSON list, and whether there are
// any definitions at all (an empty store gets no marker — the golden fixtures are empty stores).
const agentsBeforeToolMigration = () =>
  db.prepare("SELECT * FROM agents WHERE tool_list IS NULL AND trim(tools) <> '' ORDER BY created_at, id").all().map(mapAgent);
const agentsExist = () => Boolean(db.prepare("SELECT 1 FROM agents LIMIT 1").get());
// The migration of removed tools: every definition with a JSON list set. Also the comma list without the JSON
// column: an old row with `*` skips the first migration and keeps `tools`.
const agentsWithToolList = () =>
  db.prepare("SELECT * FROM agents WHERE tool_list IS NOT NULL OR trim(tools) <> '' ORDER BY created_at, id").all().map(mapAgent);
// `toolList` (list or null) is the truth; `tools` is written from it as a comma list (display).
const listColumns = (list) => (Array.isArray(list) ? { tools: list.join(", "), toolList: JSON.stringify(list) } : { tools: "", toolList: null });
const mcpColumn = (mcp) => JSON.stringify(mcp && typeof mcp === "object" && !Array.isArray(mcp) ? mcp : {});
export function createAgent({ id, workspaceId, projectId = null, name, description = "", toolList = null, model = "", body = "", skills = "", mcp = {}, createdAt, updatedAt }) {
  const w = listColumns(toolList);
  db.prepare(`INSERT INTO agents (id, workspace_id, project_id, name, description, tools, tool_list, model, body, skills, mcp, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, projectId, name, description, w.tools, w.toolList, model, body, skills, mcpColumn(mcp), createdAt, updatedAt);
  return getAgent(id);
}
export function updateAgent(id, fields) {
  const map = { name: "name", description: "description", tools: "tools", toolList: "tool_list", model: "model", body: "body", skills: "skills", mcp: "mcp", updatedAt: "updated_at" };
  const f = { ...fields };
  if (Object.hasOwn(f, "toolList")) Object.assign(f, listColumns(f.toolList));
  else delete f.tools; // nobody writes the comma list alone any more — it follows the list
  if (Object.hasOwn(f, "mcp")) f.mcp = mcpColumn(f.mcp);
  const sets = [], vals = [];
  for (const k in f) if (map[k]) { sets.push(`${map[k]} = ?`); vals.push(f[k]); }
  if (!sets.length) return getAgent(id);
  vals.push(id);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getAgent(id);
}
/**
 * Strike the choice of deleted Coding MCP servers from every agent type — the same pattern as store/outer-loop.js
 * dropOuterLoopMcpChoice, called from the same delete paths (deleteMcpServer, store/workspaces.js deleteProject).
 * Without it the dialog would send the dead id back on every save, and every save would be a 400.
 * → number of changed types.
 */
function dropAgentMcpChoice(serverIds, at = Date.now()) {
  const ids = new Set([...(serverIds || [])].map(String));
  if (!ids.size) return 0;
  let n = 0;
  for (const r of db.prepare("SELECT id, mcp FROM agents WHERE mcp IS NOT NULL AND mcp <> '{}'").all()) {
    const choice = mcpChoiceOf(r);
    if (!Object.keys(choice).some((k) => ids.has(k))) continue;
    const rest = Object.fromEntries(Object.entries(choice).filter(([k]) => !ids.has(k)));
    db.prepare("UPDATE agents SET mcp = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(rest), Number(at), r.id);
    n++;
  }
  return n;
}
export function deleteAgent(id) {
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  db.prepare("DELETE FROM project_agent_enabled WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM project_agent_excluded WHERE agent_id = ?").run(id);
  return true;
}

// ── Workspace agents in a project ────────────────────────────────────────────
// Two defaults, ONE per project, stored as a column on the project:
//   'on'  — every newly created project (addProject writes it explicitly): every workspace agent applies, including
//           one created later, until the project switches it off. The exceptions are in `project_agent_excluded`.
//   'off' — older projects: none applies until the project switches it on (`project_agent_enabled`). The column came
//           with DEFAULT 'off' — the ALTER gives every old project exactly this value; an existing project is not
//           reinterpreted.
// "Empty is not unknown": whatever is not explicitly 'on' (also a project without a row) reads as 'off' — the old,
// narrower set. A project NEVER silently switches on; the value only comes from addProject.
// The column with its CHECK and the exceptions table; a second run is a no-op. Asked through table_info instead of
// a swallowed ALTER: an error in the ALTER itself would otherwise make every addProject fail silently on the
// missing column.
function initWsAgentsSchema() {
  const columns = db.prepare("PRAGMA table_info(projects)").all().map((r) => r.name);
  if (!columns.includes("ws_agents_default")) {
    db.exec("ALTER TABLE projects ADD COLUMN ws_agents_default TEXT NOT NULL DEFAULT 'off' CHECK (ws_agents_default IN ('on', 'off'))");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS project_agent_excluded (
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    PRIMARY KEY (project_id, agent_id)
  )`);
}
/** The default of the workspace agents in a project: "on" (adopts all, switching off is the exception) or "off". */
function wsAgentsDefault(projectId) {
  const r = db.prepare("SELECT ws_agents_default AS s FROM projects WHERE id = ?").get(projectId);
  return r?.s === "on" ? "on" : "off";
}
// The ONE calculation "which workspace agent applies in this project" — the list of the UI
// (GET /api/projects/:id/agents, field `enabled`) and the agent set of every run (effectiveAgents: spawn, core,
// cbase_agent, selection in the system prompt, /api/chats/:id/agents) both read HERE. Two calculations could give
// two answers: the toggle showed it, the run did not get it.
function wsAgentsInProject(projectId, workspaceId) {
  const standard = wsAgentsDefault(projectId);
  const ws = workspaceId ?? db.prepare("SELECT workspace_id AS w FROM projects WHERE id = ?").get(projectId)?.w;
  if (!ws) return [];
  const choice = new Set(db.prepare(standard === "on"
    ? "SELECT agent_id FROM project_agent_excluded WHERE project_id = ?"
    : "SELECT agent_id FROM project_agent_enabled WHERE project_id = ?").all(projectId).map((r) => r.agent_id));
  return listWorkspaceAgents(ws).map((a) => ({ ...a, enabled: standard === "on" ? !choice.has(a.id) : choice.has(a.id) }));
}
export const listEnabledAgentIds = (projectId) =>
  new Set(wsAgentsInProject(projectId).filter((a) => a.enabled).map((a) => a.id));
// A workspace agent in the project on or off — written into the list the project's default reads.
export function setAgentEnabled(projectId, agentId, on) {
  if (wsAgentsDefault(projectId) === "on") {
    if (on) db.prepare("DELETE FROM project_agent_excluded WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
    else db.prepare("INSERT OR IGNORE INTO project_agent_excluded (project_id, agent_id) VALUES (?, ?)").run(projectId, agentId);
    return;
  }
  if (on) db.prepare("INSERT OR IGNORE INTO project_agent_enabled (project_id, agent_id) VALUES (?, ?)").run(projectId, agentId);
  else db.prepare("DELETE FROM project_agent_enabled WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
}

// Effective agent set for a run: workspace chat → workspace agents + agents of ALL projects; project chat →
// project agents + the workspace agents that APPLY in the project (wsAgentsInProject — isolated from other
// projects). On equal names the project agent wins.
export function effectiveAgents(workspaceId, projectId = null) {
  const wsAgents = listWorkspaceAgents(workspaceId);
  if (!projectId) {
    // Mark project agents with their origin for the workspace view — the selection (agentSelectionPurpose) and the
    // core (origin sentence in the agent's prompt) name it so that it is clear which project they belong to.
    return withAllProjectItems(workspaceId, wsAgents,
      (pid, p) => listProjectAgents(pid).map((a) => ({ ...a, originProject: p.name, originProjectPath: p.path })), listProjects);
  }
  const byName = new Map();
  for (const { enabled, ...a } of wsAgentsInProject(projectId, workspaceId)) if (enabled) byName.set(a.name, a);
  for (const a of listProjectAgents(projectId)) byName.set(a.name, a);
  return [...byName.values()];
}

// ── MCP servers (per workspace) ────────────────────────────────────────────────
// With the Coding MCP airlock: the tool choice (`tools` cache, `toolsAt`, `toolsError`, `choice` null|list,
// `markers`, `subagentsInherit`) and the NAMES of the headers (`headers: [{ name, set: true }]`). The VALUES of
// the headers are in no response and in no file — only `mcpHeadersValues` reads them, for forwarding in the
// backend (toolchain/airlock-routes.js, loading the tools).
const mapMcp = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id || null, name: r.name, transport: r.transport || "stdio",
  command: r.command || "", args: safeJson(r.args, []), env: safeJson(r.env, {}), url: r.url || "",
  enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at,
  headers: Object.keys(safeJson(r.headers, {})).sort().map((name) => ({ name, set: true })),
  tools: safeJson(r.tools, []), toolsAt: Number(r.tools_at) || 0, toolsError: r.tools_error || "",
  choice: r.choice == null ? null : safeJson(r.choice, []), markers: safeJson(r.markers, []), subagentsInherit: r.subagents_inherit !== 0,
};
// The airlock columns on `mcp_servers` (registration "mcp-airlock" in store.js): PRAGMA-checked ADD COLUMN,
// idempotent. The defaults are those of EXISTING rows: no choice (NULL = all), "subagents inherit" on, baseline
// open (`auto_marker_first = 0`). A newly created server writes both explicitly (createMcpServer). Without this
// every list of the MCP servers would fail (no such column).
function initMcpAirlockSchema() {
  const have = new Set(db.prepare("PRAGMA table_info(mcp_servers)").all().map((c) => c.name));
  if (!have.has("headers")) db.exec("ALTER TABLE mcp_servers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'");
  if (!have.has("tools")) db.exec("ALTER TABLE mcp_servers ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'");
  if (!have.has("tools_at")) db.exec("ALTER TABLE mcp_servers ADD COLUMN tools_at INTEGER NOT NULL DEFAULT 0");
  if (!have.has("tools_error")) db.exec("ALTER TABLE mcp_servers ADD COLUMN tools_error TEXT NOT NULL DEFAULT ''");
  if (!have.has("choice")) db.exec("ALTER TABLE mcp_servers ADD COLUMN choice TEXT");
  if (!have.has("markers")) db.exec("ALTER TABLE mcp_servers ADD COLUMN markers TEXT NOT NULL DEFAULT '[]'");
  if (!have.has("subagents_inherit")) db.exec("ALTER TABLE mcp_servers ADD COLUMN subagents_inherit INTEGER NOT NULL DEFAULT 1");
  if (!have.has("auto_marker_first")) db.exec("ALTER TABLE mcp_servers ADD COLUMN auto_marker_first INTEGER NOT NULL DEFAULT 0");
}
// The server with the inner baseline marker (for toolchain/mcp-tools.js carryForward) — never send it as a response.
function getMcpServerInternal(id) {
  const r = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
  return r ? { ...mapMcp(r), autoMarkerFirst: r.auto_marker_first === 1 } : null;
}
// The values of the headers `{ name: value }` — ONLY for forwarding in the backend.
function mcpHeadersValues(id) {
  const r = db.prepare("SELECT headers FROM mcp_servers WHERE id = ?").get(id);
  return r ? safeJson(r.headers, {}) : {};
}
// All servers whose baseline is still open (restart-grace hook "mcp-baseline").
const mcpServerWithoutBaseline = () =>
  db.prepare("SELECT id FROM mcp_servers WHERE tools_at = 0 AND auto_marker_first = 0").all().map((r) => r.id);

// Workspace servers (project_id NULL) — the workspace-wide list + the catalog stock.
export const listMcpServers = (workspaceId) =>
  db.prepare("SELECT * FROM mcp_servers WHERE workspace_id = ? AND project_id IS NULL ORDER BY name ASC").all(workspaceId).map(mapMcp);
// Project-owned servers (isolated per project).
export const listProjectMcpServers = (projectId) =>
  db.prepare("SELECT * FROM mcp_servers WHERE project_id = ? ORDER BY name ASC").all(projectId).map(mapMcp);
export const getMcpServer = (id) => mapMcp(db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id));

// A NEWLY created server: "subagents inherit" off, auto-marker from the first load — both explicit, the column
// defaults are for existing rows (`auto_marker_first = 0`: the first load sets the baseline WITHOUT markers,
// toolchain/mcp-tools.js baselineOpen).
export function createMcpServer({ id, workspaceId, projectId = null, name, transport = "stdio", command = "", args = [], env = {}, url = "", enabled = true, headers = {}, createdAt, updatedAt }) {
  db.prepare(`INSERT INTO mcp_servers (id, workspace_id, project_id, name, transport, command, args, env, url, enabled, created_at, updated_at, headers, subagents_inherit, auto_marker_first)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`)
    .run(id, workspaceId, projectId, name, transport, command, JSON.stringify(args || []), JSON.stringify(env || {}), url, enabled ? 1 : 0, createdAt, updatedAt, JSON.stringify(headers || {}));
  return getMcpServer(id);
}
export function updateMcpServer(id, fields) {
  const map = { name: "name", transport: "transport", command: "command", url: "url" };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  if ("args" in fields) { sets.push("args = ?"); vals.push(JSON.stringify(fields.args || [])); }
  if ("env" in fields) { sets.push("env = ?"); vals.push(JSON.stringify(fields.env || {})); }
  if ("enabled" in fields) { sets.push("enabled = ?"); vals.push(fields.enabled ? 1 : 0); }
  // The airlock fields: `headers` is the FULL object { name: value }, `choice` null or a list.
  if ("headers" in fields) { sets.push("headers = ?"); vals.push(JSON.stringify(fields.headers || {})); }
  if ("tools" in fields) { sets.push("tools = ?"); vals.push(JSON.stringify(fields.tools || [])); }
  if ("toolsAt" in fields) { sets.push("tools_at = ?"); vals.push(Number(fields.toolsAt) || 0); }
  if ("toolsError" in fields) { sets.push("tools_error = ?"); vals.push(String(fields.toolsError || "")); }
  if ("choice" in fields) { sets.push("choice = ?"); vals.push(Array.isArray(fields.choice) ? JSON.stringify(fields.choice) : null); }
  if ("markers" in fields) { sets.push("markers = ?"); vals.push(JSON.stringify(fields.markers || [])); }
  if ("subagentsInherit" in fields) { sets.push("subagents_inherit = ?"); vals.push(fields.subagentsInherit ? 1 : 0); }
  sets.push("updated_at = ?"); vals.push(Date.now());
  vals.push(id);
  db.prepare(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getMcpServer(id);
}
// The choice of the outer loop agents for this server falls with it (store/outer-loop.js dropOuterLoopMcpChoice) — in ONE transaction.
export function deleteMcpServer(id) {
  return inOneTransaction(() => {
    db.prepare("DELETE FROM project_mcp_enabled WHERE mcp_server_id = ?").run(id);
    db.prepare("DELETE FROM project_mcp_excluded WHERE mcp_server_id = ?").run(id);
    dropOuterLoopMcpChoice([id]);
    dropAgentMcpChoice([id]);
    return db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
  });
}

// ── Workspace MCP servers per project: available everywhere, exceptions per project ──────────────────────────
// Like the workspace credentials (project_var_excluded) and the Coding skills (project_skill_excluded): a
// workspace server applies in every project until the project hides it. The table only carries the exceptions, by
// server id. `project_mcp_enabled` (the former opt-in) is no longer read; it only stays for a rollback (like
// `project_skill_enabled`) and is still cleared. The old state is NOT translated: under opt-in "not adopted" could
// not be told from "deliberately left out".
function initMcpHiddenSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS project_mcp_excluded (
    project_id TEXT NOT NULL,
    mcp_server_id TEXT NOT NULL,
    PRIMARY KEY (project_id, mcp_server_id)
  )`);
}
export const listExcludedMcpServerIds = (projectId) =>
  new Set(db.prepare("SELECT mcp_server_id FROM project_mcp_excluded WHERE project_id = ?").all(projectId).map((r) => r.mcp_server_id));
// available=true shows a workspace server in the project (again), false hides it.
export function setMcpServerAvailable(projectId, mcpServerId, available) {
  if (available) db.prepare("DELETE FROM project_mcp_excluded WHERE project_id = ? AND mcp_server_id = ?").run(projectId, mcpServerId);
  else db.prepare("INSERT OR IGNORE INTO project_mcp_excluded (project_id, mcp_server_id) VALUES (?, ?)").run(projectId, mcpServerId);
}
// Effective additional MCP servers for a run:
//  • workspace chat (no project) → all workspace-wide ENABLED servers (mcp_servers.enabled) PLUS the enabled
//    project-owned servers of ALL projects (the workspace level sees everything).
//  • project chat → the project-owned servers (with their own enabled toggle) PLUS every workspace-wide ENABLED
//    server the project has not hidden (project_mcp_excluded, opt-out). A server switched off workspace-wide is
//    missing everywhere — the toggle on the server applies in the project too. On equal names the project server
//    wins.
// Built-in servers (cbase/playwright) are always attached by writeMcpConfig anyway.
export function effectiveMcpServers(workspaceId, projectId = null) {
  if (!workspaceId) return [];
  const wsAll = listMcpServers(workspaceId);
  if (!projectId) {
    // Mark project servers with their origin for the workspace view — MCP configs know no description, so doRun
    // appends the mapping as a section to the system prompt.
    return withAllProjectItems(workspaceId, wsAll.filter((s) => s.enabled),
      (pid, p) => listProjectMcpServers(pid).filter((s) => s.enabled).map((s) => ({ ...s, originProject: p.name })), listProjects);
  }
  const hidden = listExcludedMcpServerIds(projectId);
  const byName = new Map();
  for (const s of wsAll) if (s.enabled && !hidden.has(s.id)) byName.set(s.name, s);
  for (const s of listProjectMcpServers(projectId)) if (s.enabled) byName.set(s.name, s);
  return [...byName.values()];
}

// ── Skills (provider agnostic, DB = source of truth) ───────────────────────────────────────────
export const skillResourceDir = (skillId) => path.join(skillResRoot, skillId);
function removeSkillResources(skillId) {
  try { fs.rmSync(skillResourceDir(skillId), { recursive: true, force: true }); } catch {}
}
// The trash of the resources: `<data>/skill-trash/<historyId>/` next to `skill-resources`. It lives HERE and not
// with its history (store/skill-history.js) because the delete paths of workspace and project
// (store/workspaces.js) clear it too — an import from there would close the cycle skill-history → workspaces.
const skillTrashDir = (historyId) => path.join(path.dirname(skillResRoot), "skill-trash", String(historyId));
function removeSkillTrash(historyId) {
  try { fs.rmSync(skillTrashDir(historyId), { recursive: true, force: true }); } catch {}
}
// The two areas: every skill belongs to EXACTLY ONE — Coding or Managing. The truth stays in the columns
// `for_coding`/`for_managing` with the invariant "exactly one is 1" (no new column: a rolled-back release reads
// the same columns). Read through the derived `area` — `for_managing = 1` means managing, everything else coding.
// The two markers of the response are DERIVED, not read: an older iOS app only decodes the list with both fields.
// No path changes the area (created wrongly ⇒ delete and create anew) — `updateSkill` does not know it.
// Since the removal of Managing no route creates, changes or deletes a Managing skill (toolchain/routes.js) — the
// area stays anyway for the skills of an old store: the Coding lists filter them out, the lock recognizes them.
// `createSkill` still accepts `managing` (restoring a history entry, toolchain/skill-change.js, and test seeds), and
// the ordering at start stays: a rollback to an old release would create skills with both markers again.
const SKILL_AREAS = Object.freeze(["coding", "managing"]);
const areaOf = (r) => (r.for_managing ? "managing" : "coding");
// The version of a skill: the first 16 hex characters of sha256(name \0 description \0 body) — stateless, no
// column. Changing and deleting through the tool require the version that was read (conflict otherwise), undo
// compares it with the after-state of the history (store/skill-history.js).
const skillVersion = (s) => crypto.createHash("sha256")
  .update(`${s?.name ?? ""}\0${s?.description ?? ""}\0${s?.body ?? ""}`).digest("hex").slice(0, 16);
const mapSkill = (r) => r && {
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id || null, name: r.name,
  description: r.description || "", body: r.body || "", hasResources: !!r.has_resources,
  version: skillVersion({ name: r.name, description: r.description || "", body: r.body || "" }),
  // Frontmatter as in Claude Code: allowedTools restricts the tools while the skill is active; model (optionally)
  // selects a different model for its work.
  allowedTools: r.allowed_tools || "", model: r.model || "",
  area: areaOf(r),
  forCoding: areaOf(r) === "coding", forManaging: areaOf(r) === "managing",
  createdAt: r.created_at, updatedAt: r.updated_at,
};
export const listWorkspaceSkills = (wsId) =>
  db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND project_id IS NULL ORDER BY name").all(wsId).map(mapSkill);
export const listProjectSkills = (projectId) =>
  db.prepare("SELECT * FROM skills WHERE project_id = ? ORDER BY name").all(projectId).map(mapSkill);
export const getSkill = (id) => mapSkill(db.prepare("SELECT * FROM skills WHERE id = ?").get(id));
export const getSkillByName = (wsId, projectId, name) =>
  mapSkill(projectId
    ? db.prepare("SELECT * FROM skills WHERE project_id = ? AND name = ?").get(projectId, name)
    : db.prepare("SELECT * FROM skills WHERE workspace_id = ? AND project_id IS NULL AND name = ?").get(wsId, name));
// Created with `area` (default coding). The old markers as input THROW instead of silently becoming Coding: a
// caller still sending `forManaging: true` meant Managing — and would otherwise get a skill in the wrong area. A
// Managing skill has no project level.
export function createSkill({ id, workspaceId, projectId = null, name, description = "", body = "", hasResources = false, allowedTools = "", model = "", area = "coding", createdAt, updatedAt, ...rest }) {
  if ("forCoding" in rest || "forManaging" in rest) throw new Error("createSkill: the markers forCoding/forManaging no longer exist as input — `area` (coding | managing)");
  if (!SKILL_AREAS.includes(area)) throw new Error(`createSkill: unknown area "${area}" (coding | managing)`);
  if (area === "managing" && projectId) throw new Error("createSkill: a Managing skill has no project level");
  db.prepare(`INSERT INTO skills (id, workspace_id, project_id, name, description, body, has_resources, allowed_tools, model, for_coding, for_managing, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, projectId, name, description, body, hasResources ? 1 : 0, allowedTools, model, area === "coding" ? 1 : 0, area === "managing" ? 1 : 0, createdAt, updatedAt);
  return getSkill(id);
}
export function updateSkill(id, fields) {
  const map = { description: "description", body: "body", allowedTools: "allowed_tools", model: "model", updatedAt: "updated_at" };
  const sets = [], vals = [];
  for (const k in fields) if (map[k]) { sets.push(`${map[k]} = ?`); vals.push(fields[k]); }
  if ("hasResources" in fields) { sets.push("has_resources = ?"); vals.push(fields.hasResources ? 1 : 0); }
  if (!sets.length) return getSkill(id);
  vals.push(id);
  db.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getSkill(id);
}
// Rename: ONLY through the one mutation path (toolchain/skill-change.js — name rule and uniqueness live there);
// `updateSkill` deliberately does not know `name`. `project_skill_enabled` is name based (only read for a
// rollback) and follows.
function setSkillName(id, name, updatedAt = Date.now()) {
  const s = getSkill(id);
  if (!s) return null;
  db.prepare("UPDATE skills SET name = ?, updated_at = ? WHERE id = ?").run(name, updatedAt, id);
  db.prepare("UPDATE project_skill_enabled SET skill_name = ? WHERE skill_name = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)").run(name, s.name, s.workspaceId);
  return getSkill(id);
}
// The projects that hide a workspace skill (ids) — for the before-state of a deletion (undo restores them).
const skillHiddenIn = (skillId) =>
  db.prepare("SELECT project_id AS p FROM project_skill_excluded WHERE skill_id = ? ORDER BY project_id").all(skillId).map((r) => r.p);
// The delete path still clears `project_skill_enabled` (name based): the table is only read by the migration
// below, but a rollback to an older release should find no remains of a deleted skill.
export function deleteSkill(id) {
  const s = getSkill(id);
  db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  db.prepare("DELETE FROM project_skill_excluded WHERE skill_id = ?").run(id);
  if (s) db.prepare("DELETE FROM project_skill_enabled WHERE skill_name = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)").run(s.name, s.workspaceId);
  removeSkillResources(id);
  return true;
}

// ── Hiding per project (opt-out — like the workspace credentials, project_var_excluded) ────────────────────────
// A workspace CODING skill applies in every project until the project hides it. The table only carries the
// exceptions, by skill id — a name can belong to another skill after delete and re-create. Managing skills have no
// project level and are never hidden.
function initSkillAreaSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS project_skill_excluded (
    project_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    PRIMARY KEY (project_id, skill_id)
  )`);
  // Ordering and migration belong in the SAME registration: they write into the table that was just created. An
  // error in them does NOT stop the start — the transaction rolls back and the next start tries again (the resource
  // copy can no longer fail it, see copySkillResources; what remains is an error of the database itself). Until then
  // the store is as it was, and that does NOT just mean "more": every project sees all workspace Coding skills
  // (without the marker no opt-out), but a skill with both markers reads as Managing and is MISSING in every Coding
  // chat, and a project skill with the Managing marker shows up nowhere — hence reported loudly.
  try { cleanOrphanedSkillCopies(); }
  catch (e) { console.error("[skills] orphaned resource copies not cleaned up:", e?.message || e); }
  try { arrangeSkillAreas(); }
  catch (e) { console.error("[skills] areas/opt-out not put in order — the next start tries again:", e?.message || e); }
}
const listExcludedSkillIds = (projectId) =>
  new Set(db.prepare("SELECT skill_id FROM project_skill_excluded WHERE project_id = ?").all(projectId).map((r) => r.skill_id));
function setSkillExcluded(projectId, skillId, excluded) {
  if (excluded) db.prepare("INSERT OR IGNORE INTO project_skill_excluded (project_id, skill_id) VALUES (?, ?)").run(projectId, skillId);
  else db.prepare("DELETE FROM project_skill_excluded WHERE project_id = ? AND skill_id = ?").run(projectId, skillId);
}
// The ONE calculation "which workspace skill applies in this project" — the list of the project view
// (GET /api/projects/:id/workspace-skills, field `enabled`) and the set of every run (effectiveSkills) both read
// HERE (pattern wsAgentsInProject: two calculations could give two answers).
function wsSkillsInProject(projectId, workspaceId = null) {
  const ws = workspaceId ?? db.prepare("SELECT workspace_id AS w FROM projects WHERE id = ?").get(projectId)?.w;
  if (!ws) return [];
  const out = listExcludedSkillIds(projectId);
  return listWorkspaceSkills(ws).filter((s) => s.area === "coding").map((s) => ({ ...s, enabled: !out.has(s.id) }));
}
// "Hidden in: A, B" on the workspace row: skill id → projects of this workspace that hide it, by name — the way
// the server orders names for humans (`localeCompare(…, "de")`, equal names by id; pattern store/outer-loop.js):
// a binary `ORDER BY p.name` would put "beta" behind "Zeta" and "Ärzte" at the end.
const sortByName = (a, b) => a.name.localeCompare(b.name, "de") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function skillHides(workspaceId) {
  const out = new Map();
  for (const r of db.prepare(`SELECT e.skill_id AS skill, p.id, p.name FROM project_skill_excluded e
                              JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = ?`).all(workspaceId)) {
    if (!out.has(r.skill)) out.set(r.skill, []);
    out.get(r.skill).push({ id: r.id, name: r.name });
  }
  for (const list of out.values()) list.sort(sortByName);
  return out;
}

// Effective skills for a run — Coding skills only: a Managing skill never enters the assembly and displaces
// nothing even on equal names.
//
//  · workspace chat: workspace Coding skills + Coding skills of ALL projects;
//  · project chat: own project skills + the workspace Coding skills NOT hidden in the project (wsSkillsInProject;
//    isolated from other projects). On equal names the project wins. A workspace agent that applies in the project
//    additionally brings its SUBAGENT the workspace skills of its definition, even hidden ones
//    (toolchain/skill-catalog.js skillStock) — the catalog of the chat stays this set.
export function effectiveSkills(workspaceId, projectId = null) {
  const coding = (s) => s.area === "coding";
  if (!projectId) {
    // Mark project skills with their origin — the catalog in the system prompt names it so that the agent knows for
    // work on WHICH project a skill applies.
    return withAllProjectItems(workspaceId, listWorkspaceSkills(workspaceId).filter(coding),
      (pid, p) => listProjectSkills(pid).filter(coding).map((s) => ({ ...s, originProject: p.name, originProjectPath: p.path })), listProjects);
  }
  const byName = new Map();
  for (const { enabled, ...s } of wsSkillsInProject(projectId, workspaceId)) if (enabled) byName.set(s.name, s);
  for (const s of listProjectSkills(projectId).filter(coding)) byName.set(s.name, s);
  return [...byName.values()];
}

// ── Ordering of the areas — the invariant on EVERY start, opt-in → opt-out ONCE ─────────────────────────────────────
// Steps 1–3 establish the invariant "exactly one marker, Managing never on a project" and run on EVERY start: a
// rolled-back old release creates skills with BOTH markers again and Managing skills on projects; after rolling
// forward again such a skill would read as Managing and be missing in every Coding chat, a project skill with the
// Managing marker would show up nowhere, and the area cannot be changed by PUT. Without a finding the three steps
// are a no-op (three queries) and write no log line. ONLY step 4 depends on the migration marker: if it ran a
// second time it would turn every workspace skill created SINCE into a hide in every project (opt-out would then
// mean opt-in). All in ONE transaction; the resource folders of the Managing copies are created in the
// transaction and fall with it. Order:
//   1. both markers → the skill stays Coding (id, level, name); a Managing COPY on workspace level (new id,
//                     resources copied) under `<name>-managing`, taken ⇒ `-2`, `-3`, …
//   2. no marker    → Coding (log line with the name)
//   3. project skill with Managing only → to the workspace level; name taken there ⇒ `<name>-<n>` (first free
//      number from 2)
//   4. (only without the migration marker) opt-in → opt-out: per project P and workspace Coding skill S of the same
//      workspace WITHOUT a row (P, S.name) in `project_skill_enabled` a hide (P, S.id) — on the day of the change
//      every chat sees the same skills as before
//   5. (only without the migration marker) the marker; ONE log line with the numbers — only if something migrated
//      (a fresh store stays silent).
// Timestamps stay: a migration is not a user change (the copy carries those of the original).
const SKILL_AREA_MARKER = "migration.skills_area_optout";
// The same limit as `skills.js:validName` (64 characters, a-z 0-9 -); store/ must not import the domain side, the
// number is bound in the test (skills-area-migration.test.js checks every generated name with validName).
const SKILL_NAME_MAX = 64;
// Name from stem + suffix, at most SKILL_NAME_MAX characters: the STEM is shortened (the suffix says what the name
// is), and a hyphen at the cut falls, otherwise there would be "--".
function skillNameWithSuffix(stem, suffix) {
  if (stem.length + suffix.length <= SKILL_NAME_MAX) return stem + suffix;
  const short = stem.slice(0, Math.max(1, SKILL_NAME_MAX - suffix.length));
  return (suffix ? short.replace(/-+$/, "") || short.slice(0, 1) : short) + suffix;
}
// The resources of a Managing copy. NOT `fs.cpSync`: an unreadable SUBFOLDER aborts the whole process there
// (SIGABRT in the native part — no catch applies), and because the ordering runs on every start that would be a
// start loop. Copied by hand the errors throw normally (readdirSync/copyFileSync). Copied are folders, regular
// files and links (literally, as in the original); everything else (FIFO, socket, device) is skipped and counted
// — `copyFileSync` on a FIFO would hang.
function copySkillResources(from, to) {
  let skipped = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), z = path.join(to, e.name);
    if (e.isDirectory()) skipped += copySkillResources(a, z);
    else if (e.isFile()) fs.copyFileSync(a, z);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(a), z);
    else skipped++;
  }
  return skipped;
}
// The copy journal: the ids of the Managing copies whose folders the running transaction created. If the process
// ends in the middle of the transaction (crash, SIGKILL), SQLite rolls the rows back on the next open, but the
// folders would stay without a skill — invisible (reads only go through a skill id), but taking space. The next
// start clears EXACTLY these folders (only without a row in `skills`; never a folder this transaction did not
// create — a general "delete folders without a skill" would hit foreign resources after restoring an older
// database).
const copiesJournal = () => path.join(skillResRoot, ".area-copies.json");
function cleanOrphanedSkillCopies() {
  let ids;
  try { ids = JSON.parse(fs.readFileSync(copiesJournal(), "utf8")); }
  catch (e) { if (e?.code === "ENOENT") return 0; ids = []; }
  let cleaned = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) continue; // only what this transaction assigned itself (randomUUID)
    if (db.prepare("SELECT 1 FROM skills WHERE id = ?").get(id)) continue;
    fs.rmSync(skillResourceDir(id), { recursive: true, force: true });
    cleaned++;
  }
  fs.rmSync(copiesJournal(), { force: true });
  if (cleaned) console.log(`[skills] ${cleaned} orphaned resource copy/copies of an aborted ordering cleaned up`);
  return cleaned;
}
function arrangeSkillAreas() {
  const firstMigration = !db.prepare("SELECT 1 FROM app_settings WHERE key = ?").get(SKILL_AREA_MARKER);
  const copied = [];
  let tally;
  try {
    tally = inOneTransaction(() => {
      const b = { split: 0, withoutResources: [], withoutMarker: [], reattached: 0, renamed: 0, hides: 0 };
      const free = (ws, name) => !db.prepare("SELECT 1 FROM skills WHERE workspace_id = ? AND project_id IS NULL AND name = ?").get(ws, name);
      const freeName = (ws, stem, suffix = "") => {
        const first = skillNameWithSuffix(stem, suffix);
        if (free(ws, first)) return first;
        for (let n = 2; ; n++) { const k = skillNameWithSuffix(stem, `${suffix}-${n}`); if (free(ws, k)) return k; }
      };
      // 1.
      for (const r of db.prepare("SELECT * FROM skills WHERE for_coding = 1 AND for_managing = 1 ORDER BY rowid").all()) {
        db.prepare("UPDATE skills SET for_managing = 0 WHERE id = ?").run(r.id);
        const fresh = crypto.randomUUID();
        const from = skillResourceDir(r.id);
        let withResources = false;
        if (r.has_resources && fs.existsSync(from)) {
          const to = skillResourceDir(fresh);
          // If the copy fails, the Managing copy is created WITHOUT resources (the original keeps its own) — the start
          // must never fail on it; reported loudly.
          try {
            copied.push(fresh);
            fs.mkdirSync(skillResRoot, { recursive: true });
            fs.writeFileSync(copiesJournal(), JSON.stringify(copied));
            const skipped = copySkillResources(from, to);
            if (skipped) console.warn(`[skills] resources of "${r.name}": ${skipped} entry/entries neither folder, file nor link — not copied`);
            withResources = true;
          } catch (e) {
            try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* stays in the journal, the next start clears it */ }
            b.withoutResources.push(`"${r.name}" (${e?.code || e?.message || e})`);
          }
        }
        db.prepare(`INSERT INTO skills (id, workspace_id, project_id, name, description, body, has_resources, allowed_tools, model, for_coding, for_managing, created_at, updated_at)
                    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`)
          .run(fresh, r.workspace_id, freeName(r.workspace_id, r.name, "-managing"), r.description, r.body, withResources ? 1 : 0, r.allowed_tools, r.model, r.created_at, r.updated_at);
        b.split++;
      }
      // 2.
      for (const r of db.prepare("SELECT id, name FROM skills WHERE for_coding = 0 AND for_managing = 0 ORDER BY rowid").all()) {
        db.prepare("UPDATE skills SET for_coding = 1 WHERE id = ?").run(r.id);
        b.withoutMarker.push(r.name);
      }
      // 3. (after 1 no skill carries both markers any more)
      for (const r of db.prepare("SELECT id, workspace_id, name FROM skills WHERE project_id IS NOT NULL AND for_managing = 1 ORDER BY rowid").all()) {
        const name = freeName(r.workspace_id, r.name);
        db.prepare("UPDATE skills SET project_id = NULL, name = ? WHERE id = ?").run(name, r.id);
        b.reattached++;
        if (name !== r.name) b.renamed++;
      }
      if (firstMigration) {
        // 4.
        b.hides = Number(db.prepare(`INSERT OR IGNORE INTO project_skill_excluded (project_id, skill_id)
          SELECT p.id, s.id FROM projects p
          JOIN skills s ON s.workspace_id = p.workspace_id AND s.project_id IS NULL AND s.for_managing = 0
          WHERE NOT EXISTS (SELECT 1 FROM project_skill_enabled e WHERE e.project_id = p.id AND e.skill_name = s.name)`).run().changes);
        // 5.
        db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(SKILL_AREA_MARKER, new Date().toISOString());
      }
      return b;
    });
  } catch (e) {
    for (const id of copied) { try { fs.rmSync(skillResourceDir(id), { recursive: true, force: true }); } catch { /* the journal stays, the next start clears it */ } }
    if (copied.length) try { fs.rmSync(copiesJournal(), { force: true }); } catch { /* ditto */ }
    throw e;
  }
  if (copied.length) try { fs.rmSync(copiesJournal(), { force: true }); } catch { /* the next start finds all rows and clears nothing */ }
  const cause = firstMigration ? "migration" : "ordering at start — an older release wrote in the old pattern";
  for (const n of tally.withoutMarker) console.log(`[skills] "${n}" carried no marker — now Coding (${cause})`);
  for (const t of tally.withoutResources) console.warn(`[skills] Managing copy of ${t} created WITHOUT resources — the original keeps them (${cause})`);
  if (tally.split || tally.withoutMarker.length || tally.reattached || tally.hides) {
    console.log(`[skills] areas${firstMigration ? " and opt-out" : ""} (${cause}): ${tally.split} split, ${tally.withoutMarker.length} without marker → Coding, ${tally.reattached} moved to the workspace level (${tally.renamed} renamed)${firstMigration ? `, ${tally.hides} hides` : ""}`);
  }
  return tally;
}

export { initMcpAirlockSchema, initMcpHiddenSchema, getMcpServerInternal, mcpHeadersValues, mcpServerWithoutBaseline, agentsBeforeToolMigration, agentsWithToolList, agentsExist, removeSkillResources, removeSkillTrash, skillTrashDir, initWsAgentsSchema, wsAgentsDefault, wsAgentsInProject, initSkillAreaSchema, listExcludedSkillIds, setSkillExcluded, wsSkillsInProject, skillHides, SKILL_AREAS, SKILL_AREA_MARKER, skillVersion, setSkillName, skillHiddenIn, dropAgentMcpChoice };
