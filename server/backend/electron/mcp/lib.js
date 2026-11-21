// Helpers of the cbase MCP server: HTTP (api), resolution of project/workspace/chat (resolve, need*), scope checks
// (assertInScope … serviceInScope), read helpers (pidFor, varsBase), time (TIME_ZONE, timeText, parseSince), schema
// building blocks (str, int, obj) and text blocks (CONTEXT_FORM, CAPTURE_HINT).
// A file of its own because the tool modules build their schemas FROM str/int/obj AT LOAD TIME — inside the entry point
// that would be a TDZ in the import cycle. `let resolved` is only assigned in resolve().

import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

const BASE_URL = process.env.CBASE_BASE_URL || "http://127.0.0.1:7718";
// The instance token: set by writeMcpConfig only for a run inside a project container. Every request carries it as the
// header `x-cbase-token`; the backend's fence (server/projectbox/fence.js) lets a request from a project network through only
// with it, and then only into the scope of its instance. "" = no token, the request as usual.
const TOKEN = String(process.env.CBASE_TOKEN || "");
// The marker of a filtered response (header `x-cbase-fenced: 1`) per TOOL CALL: calls overlap (the server answers tools/call
// concurrently), so each call keeps it in its own async context — `withFenceMarker` (cbase-mcp.js) opens it, `api()` sets the
// marker, the response body stays unchanged.
const fenceMarker = new AsyncLocalStorage();
async function withFenceMarker(fn) {
  const marker = { fenced: false };
  const result = await fenceMarker.run(marker, fn);
  return { result, fenced: marker.fenced };
}
const FENCE_HINT = "filtered: only the project of this container and the workspace-wide items without a project reference";
// An AUXILIARY QUERY runs outside the marker: resolution (resolve) and the scope checks (assertInScope, assertServiceInScope,
// serviceInScope) read filtered lists, but their result is no part of the answer — inside the marker the first tool call of a
// process (or any call that checks a project) would carry the "filtered …" hint although its own data was complete. What the
// call reads AS its answer (scopedProjects …) stays inside the marker.
const auxQuery = (fn) => fenceMarker.exit(fn);
const SERVER_INFO = { name: "cbase", version: "1.0.0" };
// The own marker of a workflow agent: its agent id, set by writeMcpConfig. It cuts the toolset (cbase-mcp.js, visibility.js
// lockedForWorkflowAgent) and rejects approval requests without a card (tools/app.js). "" = no workflow agent.
const WORKFLOW_AGENT = String(process.env.CBASE_WORKFLOW_AGENT || "");
// The marker of an outer-loop run: `<agentId>:<runId>`, set by writeMcpConfig. It cuts the toolset (cbase-mcp.js,
// visibility.js lockedForOuterLoop), is the access marker of the analysis tool (tools/outerloop.js) and goes along AFTER the
// arguments when sending (tools/agents.js — the route derives the role "outer_loop" from it, communication/sender.js).
// "" = no outer-loop run.
const OUTER_LOOP = String(process.env.CBASE_OUTER_LOOP || "");

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = { ...(body ? { "Content-Type": "application/json" } : {}), ...(TOKEN ? { "x-cbase-token": TOKEN } : {}) };
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.headers.get("x-cbase-fenced") === "1") { const m = fenceMarker.getStore(); if (m) m.fenced = true; }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(errorText(data, res.status)), { status: res.status, response: data });
  return data;
}

// The text of an error to the model: `error` plus whatever the response carries as a list — `problems` (OKF validation of
// cbase_context_create/_update and cbase_workspace_context_update: WHAT is invalid) and `formHints` — and the fields of the 409
// of cbase_skill_write (toolchain/skill-change.js): `references` (the agent definitions that name the skill), `existing` (the skill
// that already carries the name — its id leads to change) and `current` (the current version on a conflict). Without them the model
// read only the sentence and had to read again to find the id. A caller that wants to pass a rejection on 1:1 catches the error and
// uses `status` and `response`; everyone else sees only the text.
// Guards: context-form.test.js ("problems reach the model"), skills-write.test.js ("the fields of the errors reach the model").
const ERROR_LIST = ["problems", "formHints", "references"];
const ERROR_OBJECTS = ["existing", "current"];
function errorText(data, status) {
  if (!data || typeof data !== "object") return `HTTP ${status}`;
  const parts = [data.error ? String(data.error) : `HTTP ${status}`];
  for (const field of ERROR_LIST) {
    const list = Array.isArray(data[field]) ? data[field].filter((x) => x != null && x !== "") : [];
    if (list.length) parts.push(`${field}:\n${list.map((x) => `- ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n")}`);
  }
  for (const field of ERROR_OBJECTS) {
    const v = data[field];
    if (v && typeof v === "object" && !Array.isArray(v)) parts.push(`${field}: ${JSON.stringify(v)}`);
  }
  return parts.join("\n");
}

// The report of a subagent (POST /agent, /agent/send, /agent/output) as a tool result. The routes answer 2xx REGARDLESS of the
// subagent's status — a report with `status:"failed"` (the subagent's CLI died at the usage limit, which agent-runtime reports
// this way) would arrive as an ORDINARY result, and only the parent run (server.js) takes a subagent report as evidence of a limit
// when the tool_result block carries `is_error`. The marker `__isError` turns the report into an error result (tools/call reads
// and strips it); the report itself goes along IN FULL — the main agent should be able to read the reason, not just "failed".
// "stopped" is no error: that was a deliberate abort (human or main agent), its result is in the report.
function agentReport(rep) {
  return rep && typeof rep === "object" && !Array.isArray(rep) && rep.status === "failed" ? { ...rep, __isError: true } : rep;
}

// ── Project/workspace resolution ────────────────────────────────────────────
let resolved;
async function resolve() {
  if (resolved) return resolved;
  let projectId = process.env.CBASE_PROJECT_ID || null;
  let workspaceId = process.env.CBASE_WORKSPACE_ID || null;
  const cwd = process.cwd();
  try {
    const projects = await auxQuery(() => api("GET", "/api/projects"));
    if (!projectId) {
      // the longest path-prefix match wins
      const match = projects
        .filter((p) => cwd === p.path || cwd.startsWith(p.path + "/"))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (match) { projectId = match.id; workspaceId = workspaceId || match.workspaceId; }
    }
    if (projectId && !workspaceId) {
      const p = projects.find((x) => x.id === projectId);
      if (p) workspaceId = p.workspaceId;
    }
    if (!workspaceId) {
      const wss = await auxQuery(() => api("GET", "/api/workspaces"));
      const match = wss
        .filter((w) => cwd === w.path || cwd.startsWith(w.path + "/"))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (match) workspaceId = match.id;
    }
  } catch {}
  resolved = { projectId, workspaceId };
  return resolved;
}

// A chat without a project focus (workspace chat) has no project from its working directory — the project tools then need
// `projectId`. ONE wording for the error and the field; guard: server/backend/test/prompt-audit.test.js.
const PROJECT_ID_FIELD = "Project ID (from cbase_projects_list) — required in a chat without a project focus; otherwise the project of this chat applies";
const NO_PROJECT = "This chat has no project focus — pass projectId (the id from cbase_projects_list).";
async function needProject() {
  const { projectId } = await resolve();
  if (!projectId) throw new Error(NO_PROJECT);
  return projectId;
}
async function needWorkspace() {
  const { workspaceId } = await resolve();
  if (!workspaceId) throw new Error("No workspace found for this directory.");
  return workspaceId;
}
function needChat() {
  const chatId = process.env.CBASE_CHAT_ID;
  if (!chatId) throw new Error("No chat context (CBASE_CHAT_ID is missing) — artifacts are always bound to exactly one cbase chat.");
  return chatId;
}
// Capture tools hit the browser of their OWN profile: subagents browse separately (CBASE_PROFILE_KEY, set by writeMcpConfig),
// the main agent under the chat id.
const captureProfileKey = () => process.env.CBASE_PROFILE_KEY || needChat();
// At the end of the turn the capture is shown by itself (server/chats/captures-show.js).
const CAPTURE_HINT = "This capture appears by itself as a card in the user's chat at the end of your turn — no further step needed.";
// ── Workspace scope ───────────────────────────────────────────────────────────
// Chats with a workspace see ONLY projects of that workspace — even with an explicitly passed projectId (otherwise an agent
// could read or change foreign projects through a guessed/remembered id). Without a resolvable workspace (cwd outside all
// workspaces, no CBASE_WORKSPACE_ID) the view stays over all workspaces.
async function scopeWorkspace() {
  return (await resolve()).workspaceId || null;
}
async function scopedProjects() {
  const projects = await api("GET", "/api/projects");
  const ws = await scopeWorkspace();
  return ws ? projects.filter((p) => p.workspaceId === ws) : projects;
}
async function assertInScope(projectId) {
  if (!projectId) return projectId;
  const ws = await scopeWorkspace();
  if (!ws) return projectId;
  const projects = await auxQuery(() => api("GET", "/api/projects"));
  const p = projects.find((x) => x.id === projectId);
  if (!p || p.workspaceId !== ws) throw new Error("This project does not belong to this chat's workspace — access denied. cbase_projects_list shows the available projects.");
  return projectId;
}
// Services (project_services) hang on a project — for id-based changes the project membership is checked through the port
// list (the only global service overview).
async function assertServiceInScope(id) {
  const ws = await scopeWorkspace();
  if (!ws) return id; // no workspace → full view
  // /api/project-services (listAllProjectServices) lists ALL services including portless ones, with workspaceId — unlike
  // /api/ports (only services WITH a port). Unknown id ⇒ reject: a scoped chat has no legitimate id for a service it cannot
  // even see (otherwise the scope could be bypassed).
  const services = await auxQuery(() => api("GET", "/api/project-services"));
  const svc = services.find((s) => s.id === Number(id));
  if (!svc || svc.workspaceId !== ws) throw new Error("This service belongs to a project outside this chat's workspace — access denied. cbase_ports_list shows the available services.");
  return id;
}
// Like assertServiceInScope, but returns the whole service row (start/stop/log need the project-bound routes, so projectId +
// serviceId).
async function serviceInScope(id) {
  const services = await auxQuery(() => api("GET", "/api/project-services"));
  const svc = services.find((s) => s.id === Number(id));
  if (!svc) throw new Error("Service not found — cbase_ports_list shows the available services.");
  const ws = await scopeWorkspace();
  if (ws && svc.workspaceId !== ws) throw new Error("This service belongs to a project outside this chat's workspace — access denied. cbase_ports_list shows the available services.");
  return svc;
}
// The effort levels a chat may store, in their ORDER (low < … < max). The TRUTH is `server/workflows.js:EFFORT_LEVELS` — this
// is a second copy because the MCP server is a SEPARATE PROCESS and must not import the server tree (guard:
// server/backend/test/import-direction.test.js). It appears as an ENUMERATION in the schema (cbase_agent `effort`). Bound to the
// order via tools/list: server/backend/test/mcp-schema.test.js — the name snapshot of the catalog (mcp-catalog.test.js) does not
// see an enumeration.
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Target project for context tools: an explicitly passed projectId beats the project derived from the working directory —
// needed for chats without a project (workspace chat, context agent) that record knowledge about specific projects. Always
// runs through the workspace scope check.
async function pidFor(a) {
  return assertInScope((a && a.projectId) || (await needProject()));
}
// API base for credentials/variables: if the chat is focused on a project (projectId resolved), its project credentials apply;
// otherwise those of the workspace. A project that no longer exists (deleted, the chat outlived it) is no focus: then the
// workspace credentials apply, as for any chat without a project. Only a READ absence counts: if the query fails, the project
// stays (an unknown list is not empty — the workspace set is the wider one, a read error must not open it).
async function varsBase() {
  const { projectId, workspaceId } = await resolve();
  let projectMissing = false;
  if (projectId && workspaceId) {
    try { const ps = await auxQuery(() => api("GET", "/api/projects")); projectMissing = Array.isArray(ps) && !ps.some((p) => p.id === projectId); }
    catch { projectMissing = false; }
  }
  if (projectId && !projectMissing) return `/api/projects/${projectId}`;
  if (workspaceId) return `/api/workspaces/${workspaceId}`;
  throw new Error("No project or workspace found for this directory.");
}

const enc = (v) => encodeURIComponent(v);
const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ── Tool definitions ──────────────────────────────────────────────────────────
// Wall time for models: timestamps come as "YYYY-MM-DD HH:MM" in the zone of the run (CBASE_TIME_ZONE — the zone of the
// schedule or the most recently chosen one of the workspace; the container runs UTC). An epoch value is a number to a model,
// not a point in time.
const TIME_ZONE = (() => {
  const tz = process.env.CBASE_TIME_ZONE || "";
  try { if (tz) Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz || undefined; } catch { return undefined; }
})();
const timeText = (ms) => {
  const n = Number(ms);
  if (!n || !Number.isFinite(n)) return null;
  try { return new Date(n).toLocaleString("sv-SE", { timeZone: TIME_ZONE, hour12: false }).slice(0, 16); }
  catch { return new Date(n).toISOString().slice(0, 16).replace("T", " "); }
};
const wandParts = (ms) => {
  const s = new Date(ms).toLocaleString("sv-SE", { timeZone: TIME_ZONE, hour12: false }); // 2026-09-03 21:15:00
  return { y: +s.slice(0, 4), mo: +s.slice(5, 7), d: +s.slice(8, 10), h: +s.slice(11, 13), mi: +s.slice(14, 16) };
};
// Epoch of a wall time of the zone — the offset is measured at exactly that moment (daylight saving).
const wallTimeEpoch = (y, mo, d, h = 0, mi = 0) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t = wandParts(guess);
  return guess - (Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi) - guess);
};
// "since" values: today | yesterday | 24h | 7d | YYYY-MM-DD | YYYY-MM-DDTHH:MM — as wall time of the zone.
function parseSince(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return 0;
  const now = Date.now();
  if (v === "today" || v === "yesterday") {
    const t = wandParts(now);
    return wallTimeEpoch(t.y, t.mo, v === "today" ? t.d : t.d - 1);
  }
  let m = v.match(/^(\d+)\s*([hd])$/);
  if (m) return now - Number(m[1]) * (m[2] === "h" ? 3600_000 : 86_400_000);
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?$/);
  if (m) return wallTimeEpoch(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  const p = Date.parse(String(s));
  if (Number.isFinite(p)) return p;
  throw new Error(`since "${s}" not understood — allowed: today, yesterday, 24h, 7d, YYYY-MM-DD, YYYY-MM-DDTHH:MM`);
}
// Whether `cbase_skill` exists is decided by offering.js alone (catalog not empty OR CBASE_SKILL_WRITE); the skill name is a free string.

// The schema of an `agent(prompt, {schema})`: only a workflow agent with a schema carries it, together with the reference
// under which the backend validates it (server/dynworkflows/structured.js). It IS the input schema of the messenger
// StructuredOutput and at the same time its existence: without a readable schema (missing, not an object, unreadable) the tool
// is not offered at all.
const STRUCTURE_SCHEMA = (() => {
  try { const v = JSON.parse(process.env.CBASE_SCHEMA || ""); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
})();
const STRUCTURE_REFERENCE = String(process.env.CBASE_SCHEMA_REFERENCE || "");

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

// The FORM of a context entry as ONE line right after the purpose sentence of cbase_context_create/_update. It sits there, not
// at the end of the descriptions, because the Claude CLI truncates long descriptions — at the end the model never saw it. The
// main carrier of the rules stays the system prompt of the coding chat (runs/system-prompt.js, WRITING/FORM/LEVEL); this line
// also reaches subagents and workflow agents, which do not get that block. What a field means (slug, summary, codePaths, links,
// status) stands at the fields; what a violation triggers, the server says in its response (`formHints`,
// server/projects/context-form.js). Every rule comes from an error measured on real entries.
const CONTEXT_FORM = "FORM: the title IS the statement (one per entry), summary 1–2 sentences, body short (under 1,500 characters); no "
  + "issue/MR numbers in the title, no branch names, commit hashes, status sections or checkboxes; open items only as an entry of "
  + "the category `open-points`; what applies to ALL projects goes to the workspace level via cbase_workspace_context_add.";

export { FENCE_HINT, withFenceMarker };
// The environment of THIS run, from which the descriptions of the communication tools are built (the description follows the
// execution): depth, workflow marker, special marker, write permission to chats (CBASE_WRITE_PERMISSION, set by
// toolchain/mcp-config.js from the same computation as the send route; if missing, "no") — and whether `cbase_agent` is in the
// offered set. The latter is only known to the entry point after filtering: cbase-mcp.js sets it with `setRunEnvironment`
// before tools/list answers for the first time.
const RUN_ENVIRONMENT = {
  depth: Number(process.env.CBASE_AGENT_DEPTH) || 0,
  workflowAgent: WORKFLOW_AGENT,
  // An outer-loop run: its marker — agent_send then names only `chat:<id>`, agents_list only three views.
  outerLoop: OUTER_LOOP,
  writePermission: String(process.env.CBASE_WRITE_PERMISSION || "") === "free" ? "free" : "no",
  // A run of the role "special" (app-agent chats): with cbase_agent_send it reaches only its own subagents. Set by
  // toolchain/mcp-config.js (communication/sender.js sendPermissionsOfTheRun).
  onlySubagents: process.env.CBASE_ONLY_SUBAGENTS === "1",
  // A subagent or workflow agent of a coding chat: with to = "main" it reaches the main agent of its chat. Set by
  // toolchain/mcp-config.js from the same role as the send route (communication/send.js).
  mainAddress: process.env.CBASE_MAIN_ADDRESS === "1",
  // Is there a skill catalog (server/toolchain/skill-catalog.js skillCatalog) in the system prompt of this run? Only with skills
  // (CBASE_SKILLS) — but cbase_skill is also offered without them when the run may write skills (offering.js), and its description
  // would then point to a list that does not exist.
  withSkillCatalog: (() => { try { const v = JSON.parse(process.env.CBASE_SKILLS || "[]"); return Array.isArray(v) && v.length > 0; } catch { return false; } })(),
  withAgent: true,
};
const runEnvironment = () => RUN_ENVIRONMENT;
function setRunEnvironment(part = {}) { Object.assign(RUN_ENVIRONMENT, part); }
export { runEnvironment, setRunEnvironment };

// Project and instance of a job chat (`chats.job_id`) are changed only by the human — the run values live on the chat, so a
// change by the agent would move EVERY later occurrence there. cbase_chat_set_project and cbase_switch_instance ask the chat
// afresh (a job can be deleted mid-run) and answer in a job chat with this sentence instead of changing anything. The server-side
// counterpart is JOB_ONLY_HUMAN in runs/instance-switch.js — same wording.
const JOB_SENTENCE = "Project and instance of a scheduled job are changed only by the user under Coding → Scheduled";
async function inJobChat(chatId) {
  const chat = await api("GET", `/api/chats/${enc(chatId)}`);
  return Boolean(chat?.jobId);
}
export { JOB_SENTENCE, inJobChat };
export { NO_PROJECT, PROJECT_ID_FIELD };
export { WORKFLOW_AGENT, OUTER_LOOP, STRUCTURE_REFERENCE, STRUCTURE_SCHEMA, CAPTURE_HINT, EFFORT_LEVELS, CONTEXT_FORM, SERVER_INFO, TIME_ZONE, agentReport, api, assertInScope, assertServiceInScope, captureProfileKey, enc, int, needChat, needWorkspace, obj, parseSince, pidFor, qs, resolve, scopeWorkspace, scopedProjects, serviceInScope, str, varsBase, timeText };
