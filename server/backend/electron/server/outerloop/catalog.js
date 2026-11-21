// What an outer loop agent may select, and the check of its body.
//
// SELECTABLE: the coding groups from toolchain/tool-catalog.js — knowledge and communication. `cbase_chat_analysis`
// is NEVER selectable: every run has it (outerloop/set.js).
// EXTERNAL SERVERS: the coding MCP servers of the workspace (Coding → MCP), `mcp` = `{ <serverId>: [tool, …] }`; a run
// reaches them through the airlock (set.js).
// AREA: the field is gone from check, response and UI. An old client still sends it — it is accepted and ignored; the dead
// column is only read by activation.js areaMatches as an exclusion.
// BUILT-IN: providers/contract.js BUILTIN_TOOLS without `Task` (locked natively), `Monitor`, `ScheduleWakeup`, `TaskStop`
// (bound to a chat: an outer loop run has no turn they could wake or hold), `ExitPlanMode`, `SlashCommand`.
// TRIGGERS: a list `[{ kind, … }]`, each kind at most once, at least one:
//   { kind: "quiet", minutes: 1–1440 } · { kind: "interval", minutes: 5–10080 } · { kind: "run_end" } ·
//   { kind: "clockTime", times: ["HH:MM", …] } (1–24 entries, time zone of the workspace — workspaces/timeZone.js).
// The list is stored in the order of TRIGGER_KINDS, times ascending and without duplicates — two forms with the same
// content yield the same row.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { CODING_GROUPS, CODING_TOOLS, TOOL_AREAS } from "../toolchain/tool-catalog.js";
import { BUILTIN_TOOLS } from "../providers/contract.js";
import { isProviderId } from "../providers/index.js";
import { effortSavable } from "../workflows.js";
import { approvalMarks } from "../toolchain/approval-marks.js";
import { FENCE_LOCKED } from "../../mcp/visibility.js";

/** The group keys of the selectable part, in catalog order. */
export const OUTER_LOOP_GROUPS = Object.freeze(CODING_GROUPS.map((g) => g.key));
/** The groups themselves, in catalog order — the same objects as on the coding side (toolchain/tool-catalog.js). */
export const OUTER_LOOP_CATALOG = CODING_GROUPS;
/** All selectable cbase tools, in catalog order. */
export const OUTER_LOOP_SELECTABLE = CODING_TOOLS;
/** Built-in tools an outer loop agent can NOT select. */
export const OUTER_LOOP_BUILTIN_FROM = Object.freeze(["Task", "Monitor", "ScheduleWakeup", "TaskStop", "ExitPlanMode", "SlashCommand"]);
/** The selectable built-in tools, in the order of BUILTIN_TOOLS. */
export const OUTER_LOOP_BUILTIN = Object.freeze(BUILTIN_TOOLS.filter((t) => !OUTER_LOOP_BUILTIN_FROM.includes(t)));

export const TRIGGER_KINDS = Object.freeze(["quiet", "interval", "run_end", "clockTime"]);
export const TRIGGER_LIMITS = Object.freeze({
  quiet: Object.freeze({ field: "minutes", min: 1, max: 1440 }),
  interval: Object.freeze({ field: "minutes", min: 5, max: 10080 }),
  clockTime: Object.freeze({ field: "times", min: 1, max: 24 }),
});
/** The limits of a field in characters. */
export const NAME_MAX = 120;
export const JOB_MAX = 20_000;
export const MODEL_MAX = 200;

/** Groups whose tools are ALL locked from a project container (mcp/visibility.js FENCE_LOCKED) — the editor marks them. */
export const OUTER_LOOP_FENCE_DROPPED = Object.freeze(OUTER_LOOP_CATALOG
  .filter((g) => g.tools.length && g.tools.every((t) => Object.hasOwn(FENCE_LOCKED, t))).map((g) => g.key));

/** The response for the editor (GET /api/workspaces/:wid/outer-loop). */
export function outerLoopCatalog(wid) {
  const areas = new Set(OUTER_LOOP_CATALOG.map((g) => g.area));
  const selectable = new Set(OUTER_LOOP_SELECTABLE);
  return {
    groups: OUTER_LOOP_CATALOG,
    toolAreas: TOOL_AREAS.filter((b) => areas.has(b.key)),
    builtin: OUTER_LOOP_BUILTIN,
    mcpServer: outerLoopMcpServer(wid),
    // Only the marks on selectable tools: a marked one is missing from a run's set — the editor says so at the tool.
    cbaseApproval: approvalMarks(wid, selectable),
    fenceDropped: OUTER_LOOP_FENCE_DROPPED,
  };
}

/**
 * The coding MCP servers of the workspace for the editor — in the shape both clients read for a selectable server (`key` =
 * name, `tools` = the cache without what is deselected at the server, `approval` = the marks). The workspace view: all
 * active servers including the project-owned ones (store.effectiveMcpServers without a project); which of them reaches a
 * chat is computed by set.js per run.
 */
export function outerLoopMcpServer(wid) {
  return store.effectiveMcpServers(wid, null).map((s) => ({
    id: s.id, workspaceId: s.workspaceId, key: s.name, name: s.name, url: s.url || "", tokenSet: false,
    // Only the tools of the server's choice — the outer loop cannot select others (the airlock locks them anyway).
    tools: (Array.isArray(s.tools) ? s.tools : []).filter((w) => !Array.isArray(s.choice) || s.choice.includes(w.name))
      .map((w) => ({ name: w.name, description: w.description || "", writing: w.writing ?? null })),
    toolsAt: Number(s.toolsAt) || 0, error: s.toolsError || "", approval: [...(s.markers || [])],
  }));
}

/**
 * Check the external selection of a body (`{ serverId: [tool, …] }`): only coding servers of this workspace, tool names in
 * the form of an MCP name, an empty list is dropped. A name the cache does not know (yet) stays — the selection is the
 * user's decision, the airlock checks every call. Throws 400 via `error`.
 */
export function normalizeMcpChoice(raw, workspaceId, error) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!obj) error(T("mcp: object { serverId: [tools] } required"));
  // Every coding server of the workspace and its projects, also a DISABLED one: its selection survives the disabling (a
  // run's set does not see it then — set.js asks store.effectiveMcpServers live), otherwise the agent could not be saved
  // at all while the server is off (the editor sends the selection back). A deleted server is removed from every selection
  // (store/outer-loop.js dropOuterLoopMcpChoice) — an id that does not exist stays a 400.
  const server = new Set([
    ...store.listMcpServers(workspaceId),
    ...store.listProjects(workspaceId).flatMap((p) => store.listProjectMcpServers(p.id)),
  ].map((x) => x.id));
  const mcp = {};
  for (const [id, list] of Object.entries(obj)) {
    if (!server.has(id)) error(T`Unknown MCP server: ${id}`);
    const names = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))];
    if (names.some((n) => !/^[A-Za-z0-9_.-]{1,120}$/.test(n))) error(T("Invalid tool name"));
    if (names.length) mcp[id] = names;
  }
  return mcp;
}

/** The response on the triggers for the editor. */
export const triggerCatalog = () => ({ kinds: TRIGGER_KINDS, limits: TRIGGER_LIMITS });

const errorWith = (status) => (text) => { const e = new Error(text); e.status = status; throw e; };
const error = errorWith(400);
const isWhole = (v) => typeof v === "number" && Number.isInteger(v);
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Check a trigger list and bring it into its stored form. Throws 400. */
export function checkTrigger(raw) {
  if (!Array.isArray(raw)) error(T("trigger: list required"));
  if (!raw.length) error(T("trigger: at least one trigger"));
  const byKey = new Map();
  for (const a of raw) {
    if (!a || typeof a !== "object" || Array.isArray(a)) error(T("trigger: each entry is an object { kind, … }"));
    const kind = a.kind;
    if (!TRIGGER_KINDS.includes(kind)) error(T`trigger: unknown kind "${String(kind).slice(0, 40)}" (${TRIGGER_KINDS.join(", ")})`);
    if (byKey.has(kind)) error(T`trigger: "${kind}" appears twice`);
    if (kind === "run_end") { byKey.set(kind, { kind }); continue; }
    const g = TRIGGER_LIMITS[kind];
    if (kind === "clockTime") {
      const times = a.times;
      if (!Array.isArray(times) || !times.every((z) => typeof z === "string" && CLOCK_TIME.test(z))) error(T("trigger clockTime: times as a list of \"HH:MM\""));
      const clean = [...new Set(times)].sort();
      if (clean.length < g.min || clean.length > g.max) error(T`trigger clockTime: ${g.min}–${g.max} times`);
      byKey.set(kind, { kind, times: clean });
      continue;
    }
    const minutes = a.minutes;
    if (!isWhole(minutes) || minutes < g.min || minutes > g.max) error(T`trigger ${kind}: minutes an integer ${g.min}–${g.max}`);
    byKey.set(kind, { kind, minutes });
  }
  return TRIGGER_KINDS.filter((x) => byKey.has(x)).map((x) => byKey.get(x));
}

/**
 * Check and clean the body of an agent (POST/PATCH of the routes). `part` = only the fields sent (PATCH): a missing field
 * stays unchanged, a sent one is checked as on create. On create `name`, `job`, `trigger`, `tools`, `builtin`, `mcp` and —
 * except for origin chat — `defaultNew` are required (a missing field is not an instruction); `provider`, `model`,
 * `effort`, `enabled` are optional. For origin chat `defaultNew` is a 400 (it does not apply). The legacy area field is
 * ignored for every origin.
 * The origin (`projectId`, `chatId`) is checked by the route, not this function.
 *
 * @param {object} b                body
 * @param {{ part?: boolean, workspaceId: string, origin?: "workspace"|"project"|"chat" }} opts
 * @returns {object}                fields in the shape of the store's create/update of an outer loop agent (camelCase)
 * @throws  Error with `status = 400`
 */
export function checkAgentBody(b, { part = false, workspaceId = "", origin = "workspace" } = {}) {
  if (!b || typeof b !== "object" || Array.isArray(b)) error(T("Body: object required"));
  const out = {};
  const required = (field) => !part || field in b;
  const missing = (field) => !(field in b) || b[field] === undefined;

  if (required("name")) {
    if (typeof b.name !== "string" || !b.name.trim()) error(T("Name required"));
    const name = b.name.trim();
    if (name.length > NAME_MAX) error(T`Name too long (at most ${NAME_MAX} characters)`);
    out.name = name;
  }
  if (required("job")) {
    if (typeof b.job !== "string") error(T("job: text required"));
    const job = b.job.trim();
    if (job.length > JOB_MAX) error(T`job too long: ${job.length} of at most ${JOB_MAX} characters`);
    out.job = job;
  }
  if (required("trigger")) out.trigger = checkTrigger(b.trigger);

  // The legacy area field: accepted and ignored for every origin — an old client sends it, it is no longer stored.
  if (origin === "chat") {
    if ("defaultNew" in b) error(T("defaultNew: not applicable to an agent of this chat"));
  } else {
    if (required("defaultNew")) {
      if (typeof b.defaultNew !== "boolean") error(T("defaultNew: true or false"));
      out.defaultNew = b.defaultNew;
    }
  }

  if ("provider" in b) {
    const p = b.provider === null ? "" : b.provider;
    if (typeof p !== "string") error(T("provider: text"));
    if (p.trim() && !isProviderId(p.trim())) error(T`Unknown provider: ${p.trim().slice(0, 60)}`);
    out.provider = p.trim();
  } else if (!part) out.provider = "";
  if ("model" in b) {
    const mo = b.model === null ? "" : b.model;
    if (typeof mo !== "string") error(T("model: text"));
    if (mo.trim().length > MODEL_MAX) error(T("model too long"));
    out.model = mo.trim();
  } else if (!part) out.model = "";
  // Effort level: '' = the provider's default level, resolved in the run; an unknown value is a 400, never silently "default".
  if ("effort" in b || !part) {
    const level = effortSavable(missing("effort") ? "" : b.effort);
    if (level.kind === "unknown") error(level.error);
    out.effort = level.level;
  }
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") error(T("enabled: true or false"));
    out.enabled = b.enabled;
  } else if (!part) out.enabled = true;
  // The switch "abort on new message": every agent has it — on: a turn in the observed chat aborts its open runs there
  // (outerloop/abort.js outerLoopTurnStart); off: the run keeps running, a trigger queues a follow-up run.
  if ("abortingTurn" in b) {
    if (typeof b.abortingTurn !== "boolean") error(T("abortingTurn: true or false"));
    out.abortingTurn = b.abortingTurn;
  }

  if (required("tools")) {
    if (!Array.isArray(b.tools) || !b.tools.every((t) => typeof t === "string")) error(T("tools: list of tool names"));
    const unknown = [...new Set(b.tools)].filter((t) => !OUTER_LOOP_SELECTABLE.includes(t));
    if (unknown.length) error(T`Not selectable for an outer-loop agent: ${unknown.join(", ")}`);
    out.tools = OUTER_LOOP_SELECTABLE.filter((t) => b.tools.includes(t));
  }
  if (required("builtin")) {
    if (!Array.isArray(b.builtin) || !b.builtin.every((t) => typeof t === "string")) error(T("builtin: list of tool names"));
    const unknown = [...new Set(b.builtin)].filter((t) => !OUTER_LOOP_BUILTIN.includes(t));
    if (unknown.length) error(T`Built-in tools not selectable: ${unknown.join(", ")}`);
    out.builtin = OUTER_LOOP_BUILTIN.filter((t) => b.builtin.includes(t));
  }
  if (required("mcp")) out.mcp = normalizeMcpChoice(b.mcp, workspaceId, error);
  return out;
}
