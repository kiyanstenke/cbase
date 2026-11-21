// Outer loop: the user-managed background agents per workspace, project and chat, plus the built-in summarizer.
//
// Every answer goes through a `norm*` function with a default per field: a field that an older (or unfinished) server does not send
// leaves the view readable, and a missing list becomes empty, never an `undefined` that a `.map` dies on.
//
// The bodies are typed objects (`OuterLoopBody`, `OuterLoopChatBody`), not conditional spreads: `web/test/seams-fields.test.mjs`
// reads their fields through the type checker and holds them against the route.
//
// The second built-in agent is the **agenda keeper**: `agendaKeeper` marks it, `fixed` (= summarizer OR keeper OR timeline agent)
// carries everything "built-in" means: not deletable, "Reset to template", "new template". Plus its switch `markUpkeep` and the tally of
// its changes (`upkeepTally` on the agent, `upkeep` per run), both `null` on any other agent.
//
// Leaf module of the facade: imports nothing outside lib/api/ (README there).

import { api } from "./core.js";

// ── Tool choice ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The shapes of the tool choice (`components/outerloop/ToolChoice.tsx`): catalog groups and areas, external MCP servers with their
// tools. The outer-loop editor is their only remaining user.
/** `read`: the reading subset of a mixed group; the editor then offers Off · Read · Maintain instead of a switch. */
export interface ToolGroup { key: string; area: string; label: string; tools: string[]; read?: string[]; description: string }
export interface ToolArea { key: string; label: string; description: string }
/** A tool of an external MCP server, as tools/list last reported it. `writing`: true = writes, false = reads, null = not classified by
 *  the server ("unclear"; "Read-only" leaves it out). */
export interface McpTool { name: string; description: string; writing: boolean | null }
/** An external MCP server (per workspace): Streamable HTTP with a bearer token. */
export interface ManagerMcpServer {
  id: string;
  workspaceId: string;
  /** The MCP name (calls are named mcp__<key>__<tool>). */
  key: string;
  name: string;
  url: string;
  tokenSet: boolean;
  tools: McpTool[];
  toolsAt: number;
  error: string;
  /** Approval marks: tools of this server that an agent runs only after the user's approval. */
  approval: string[];
  createdAt: number;
  updatedAt: number;
}

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The four trigger kinds an agent can choose. A follow-up run is no choice, only a run reason. */
export type OuterLoopTriggerKind = "quiet" | "interval" | "run_end" | "clockTime";
export const OUTER_LOOP_TRIGGER_KINDS: readonly OuterLoopTriggerKind[] = ["quiet", "interval", "run_end", "clockTime"];

/** A trigger. Quiet and interval in minutes, clock times as `HH:MM` in the workspace's time zone. */
export type OuterLoopTrigger =
  | { kind: "quiet"; minutes: number }
  | { kind: "interval"; minutes: number }
  | { kind: "run_end" }
  | { kind: "clockTime"; times: string[] }; // server outerloop/catalog.js: field `times`

export type OuterLoopOrigin = "workspace" | "project" | "chat";
/** The kind of an observed chat (server `chats/genus.js:chatKind`): "normal" is a coding chat, "special" any
 *  other kind, e.g. a legacy manager conversation that the web UI no longer opens. */
export type OuterLoopChatKind = "normal" | "special";
/** Why an agent does not run (effective = on ∧ provider ∧ model). Empty = it is effective. */
export type OuterLoopIneffective = "managing" | "off" | "without-model" | "without-provider" | "";

/** What became of the agenda keeper's changes: `open` = untouched, `confirmed` = the main agent kept working on the item afterwards,
 *  `corrected` = it took the change back. `changes` = the sum of the three. */
export interface OuterLoopUpkeepTally { changes: number; open: number; confirmed: number; corrected: number }
/** The tally of ONE run of the agenda keeper. */
export interface OuterLoopRunUpkeep { changes: number; corrected: number }

/** An outer-loop agent as `publicAgent` writes it (agent shape plus route additions). */
export interface OuterLoopAgent {
  id: string;
  workspaceId: string;
  projectId: string | null;
  chatId: string | null;
  origin: OuterLoopOrigin;
  name: string;
  job: string;
  trigger: OuterLoopTrigger[];
  // There is no area field: the server sends none in any answer, and a default "coding" here would silently show an agent with the
  // dead "managing" column as a coding agent (outerloop/activation.js areaMatches).
  provider: string;
  model: string;
  effort: string;
  defaultNew: boolean;
  defaultNewSince: number | null;
  tools: string[];
  builtin: string[];
  mcp: Record<string, string[]>;
  summarizer: boolean;
  /** The agenda keeper: exactly one per workspace, never also a summarizer. */
  agendaKeeper: boolean;
  /** The timeline agent: exactly one per workspace, only on chats of a project. */
  timeline: boolean;
  /** Built-in (summarizer, agenda keeper or timeline agent): not deletable, "Reset to template", "new template". */
  fixed: boolean;
  /** Agenda keeper only: does it mark the items it creates or sets (default on); otherwise `false`. */
  markUpkeep: boolean;
  /** "Abort on new message": a turn in the observed chat aborts its run there; off = it queues. */
  abortingTurn: boolean;
  /** Agenda keeper only: the tally of its changes over all runs; otherwise `null`. */
  upkeepTally: OuterLoopUpkeepTally | null;
  templateRevision: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // Route additions
  chatTitle: string;
  /** Chat origin: the kind of its chat ("normal" | "manager"); "Go to chat" jumps to Coding only for "normal". `null` without a chat or for
   *  a chat that is gone. */
  chatKind: OuterLoopChatKind | null;
  projectName: string;
  effective: boolean;
  ineffectiveReason: OuterLoopIneffective;
  /** Built-in: the cbase template is newer than the one it came from (each built-in agent has its own template). */
  templateNew: boolean;
  /** Workspace origin: projects in which it is switched off (no row = taken over). */
  notTakenOverIn: string[];
  /** Number of running runs. */
  running: number;
}

/** A built-in tool of the CLI. The server may send names or objects. */
export interface OuterLoopBuiltin { name: string; description: string }

/** The editor's catalog: cbase groups (excerpt), areas, built-ins, external MCP servers, approval marks. */
export interface OuterLoopCatalog {
  groups: ToolGroup[];
  toolAreas: ToolArea[];
  builtin: OuterLoopBuiltin[];
  mcpServer: ManagerMcpServer[];
  cbaseApproval: string[];
  /** Group keys whose tools ALL fall off the fence in project chats; the editor marks them. */
  fenceDropped: string[];
}

export interface OuterLoopSpan { min: number; max: number }
/** Limits of the triggers. Defaults if the server does not send them. */
export interface OuterLoopLimits { quiet: OuterLoopSpan; interval: OuterLoopSpan; clockTimes: OuterLoopSpan }
export const OUTER_LOOP_LIMITS: OuterLoopLimits = {
  quiet: { min: 1, max: 1440 },
  interval: { min: 5, max: 10080 },
  clockTimes: { min: 1, max: 24 },
};

/** `GET /api/workspaces/:wid/outer-loop`. */
export interface OuterLoopInventory {
  items: OuterLoopAgent[];
  catalog: OuterLoopCatalog;
  trigger: { kinds: OuterLoopTriggerKind[]; limits: OuterLoopLimits };
  template: { revision: number };
}

export type OuterLoopRunState = "running" | "finished" | "parked" | "aborted" | "error";

/** What a run really had, AFTER the fence cut. `dropped.locked`: chosen tools of a coding MCP server that are deselected on the server
 *  for coding chats (Coding → MCP); the run does not have them. */
export interface OuterLoopSet { cbase: string[]; builtin: string[]; extern: string[]; dropped: { fence: string[]; approval: string[]; locked: string[]; genus: string[] } }

/** A run (run shape plus `chatTitle`). */
export interface OuterLoopRun {
  id: string;
  agentId: string;
  chatId: string;
  chatTitle: string;
  /** The kind of the observed chat; `null` if it is gone. */
  chatKind: OuterLoopChatKind | null;
  trigger: string;
  state: OuterLoopRunState | string;
  startedAt: number;
  endedAt: number | null;
  parkedUntil: number | null;
  attempts: number;
  set: OuterLoopSet;
  error: string;
  provider: string;
  model: string;
  billing: string;
  input: number;
  output: number;
  cached: number;
  /** `null` = subscription or no price; never 0. */
  cost: number | null;
  /** Runs of the agenda keeper only: how many changes the run wrote and how many of them were taken back. */
  upkeep: OuterLoopRunUpkeep | null;
}

export interface OuterLoopSum { runs: number; input: number; output: number; cached: number; cost: number | null }
export interface OuterLoopRunsPage { items: OuterLoopRun[]; additional: boolean; sum: OuterLoopSum }

/** A run's note on (agent, chat). Immutable. */
export interface OuterLoopNote { id: number; agentId: string; agentName: string; chatId: string; runId: string; text: string; at: number }

/** Why an agent is active on a chat or not (`outerloop/activation.js`). */
export type OuterLoopSource =
  | "no-target-chat" | "archived" | "not-available" | "ineffective" | "row-on" | "row-off" | "chat" | "standard" | "timeline" | "no-default";

/** An agent in the chat info: the agent in short plus its activation on THIS chat. */
export interface OuterLoopChatAgent {
  id: string;
  name: string;
  origin: OuterLoopOrigin;
  summarizer: boolean;
  agendaKeeper: boolean;
  timeline: boolean;
  effective: boolean;
  ineffectiveReason: OuterLoopIneffective;
  provider: string;
  model: string;
  job: string;
  active: boolean;
  source: OuterLoopSource | string;
  since: number | null;
  toggleable: boolean;
  running: boolean;
  lastRun: OuterLoopRun | null;
}

/** `GET /api/chats/:id/outer-loop`. */
export interface OuterLoopChatState { targetChat: boolean; reason: string; agents: OuterLoopChatAgent[]; notes: OuterLoopNote[] }

/** The body of create/change in the workspace. With chat origin `defaultNew` is absent (the server answers 400 otherwise). */
export interface OuterLoopBody {
  name: string;
  job: string;
  trigger: OuterLoopTrigger[];
  provider: string;
  model: string;
  effort: string;
  defaultNew?: boolean;
  tools: string[];
  builtin: string[];
  mcp: Record<string, string[]>;
  enabled: boolean;
  /** On create only: a project agent. */
  projectId?: string;
  /** Agenda keeper only; on any other agent the server answers 400. */
  markUpkeep?: boolean;
  abortingTurn: boolean;
}

/** The body of `POST /api/chats/:id/outer-loop`, without `defaultNew`, `projectId`. */
export interface OuterLoopChatBody {
  name: string;
  job: string;
  trigger: OuterLoopTrigger[];
  provider: string;
  model: string;
  effort: string;
  tools: string[];
  builtin: string[];
  mcp: Record<string, string[]>;
  enabled: boolean;
  abortingTurn: boolean;
}

// ── Normalizing (default per field) ───────────────────────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown, preset = ""): string => (typeof v === "string" ? v : v == null ? preset : String(v));
const toCount = (v: unknown, preset = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : preset);
const countOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") as string[] : []);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** Only "normal" is a coding chat that "Go to chat" jumps to; any other value is "special"; missing stays `null`. */
const chatKindOf = (v: unknown): OuterLoopChatKind | null => (typeof v === "string" && v ? (v === "normal" ? "normal" : "special") : null);

/** A trigger list from the server (or a JSON text). Unknown entries drop out; the view stays readable. */
export function normTrigger(raw: unknown): OuterLoopTrigger[] {
  let list: unknown = raw;
  if (typeof raw === "string") { try { list = JSON.parse(raw); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  const out: OuterLoopTrigger[] = [];
  for (const x of list) {
    const a = obj(x);
    if (a.kind === "quiet" || a.kind === "interval") out.push({ kind: a.kind, minutes: toCount(a.minutes, a.kind === "quiet" ? 5 : 60) });
    else if (a.kind === "run_end") out.push({ kind: "run_end" });
    else if (a.kind === "clockTime") out.push({ kind: "clockTime", times: strList(a.times) });
  }
  return out;
}

function normMcpChoice(raw: unknown): Record<string, string[]> {
  const o = obj(raw);
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(o)) { const l = strList(o[k]); if (l.length) out[k] = l; }
  return out;
}

/** A count: integer as on iOS (`c.int` truncates a decimal), bound in web/test/outerloop-set-binding. */
const count = (v: unknown, preset = 0): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : preset);

/** A tally only if the server sends an object; if missing it is unknown (`null`), never "0 changes". iOS computes the same
 *  (`OuterLoopUpkeepTally` in Models/OuterLoopModels.swift, bound in web/test/outerloop-set-binding.test.mjs). */
function normUpkeepTally(raw: unknown): OuterLoopUpkeepTally | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Raw;
  const open = count(b.open);
  const confirmed = count(b.confirmed);
  const corrected = count(b.corrected);
  return { changes: count(b.changes, open + confirmed + corrected), open, confirmed, corrected };
}

function normRunUpkeep(raw: unknown): OuterLoopRunUpkeep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Raw;
  return { changes: count(b.changes), corrected: count(b.corrected) };
}

const ORIGINS: readonly OuterLoopOrigin[] = ["workspace", "project", "chat"];
const INEFFECTIVE: readonly OuterLoopIneffective[] = ["managing", "off", "without-model", "without-provider"];

export function normOuterLoopAgent(raw: unknown): OuterLoopAgent {
  const a = obj(raw);
  const projectId = strOrNull(a.projectId);
  const chatId = strOrNull(a.chatId);
  const origin = ORIGINS.includes(a.origin as OuterLoopOrigin)
    ? (a.origin as OuterLoopOrigin)
    : chatId ? "chat" : projectId ? "project" : "workspace";
  const on = a.enabled !== false;
  const provider = str(a.provider);
  const model = str(a.model);
  const summarizer = a.summarizer === true;
  const agendaKeeper = a.agendaKeeper === true;
  const timeline = a.timeline === true;
  // If `effective` is missing, apply the same rule as the server; never "runs" out of ignorance.
  const effective = typeof a.effective === "boolean" ? a.effective : on && Boolean(provider) && Boolean(model);
  const reason = INEFFECTIVE.includes(a.ineffectiveReason as OuterLoopIneffective)
    ? (a.ineffectiveReason as OuterLoopIneffective)
    : effective ? "" : !on ? "off" : !provider ? "without-provider" : "without-model";
  return {
    id: str(a.id),
    workspaceId: str(a.workspaceId),
    projectId,
    chatId,
    origin,
    name: str(a.name),
    job: str(a.job),
    trigger: normTrigger(a.trigger),
    provider,
    model,
    effort: str(a.effort),
    defaultNew: a.defaultNew === true,
    defaultNewSince: countOrNull(a.defaultNewSince),
    tools: strList(a.tools),
    builtin: strList(a.builtin),
    mcp: normMcpChoice(a.mcp),
    summarizer,
    agendaKeeper,
    timeline,
    // If `fixed` is missing (older server), the server's rule applies: fixed = summarizer, keeper or timeline agent.
    fixed: typeof a.fixed === "boolean" ? a.fixed : summarizer || agendaKeeper || timeline,
    markUpkeep: agendaKeeper && a.markUpkeep !== false,
    abortingTurn: a.abortingTurn === true,
    upkeepTally: agendaKeeper ? normUpkeepTally(a.upkeepTally) : null,
    templateRevision: countOrNull(a.templateRevision),
    enabled: on,
    createdAt: toCount(a.createdAt),
    updatedAt: toCount(a.updatedAt),
    chatTitle: str(a.chatTitle),
    chatKind: chatKindOf(a.chatKind),
    projectName: str(a.projectName),
    effective,
    ineffectiveReason: reason,
    templateNew: a.templateNew === true,
    notTakenOverIn: strList(a.notTakenOverIn),
    running: typeof a.running === "boolean" ? (a.running ? 1 : 0) : toCount(a.running),
  };
}

function normSpan(raw: unknown, preset: OuterLoopSpan): OuterLoopSpan {
  if (Array.isArray(raw) && raw.length === 2) return { min: toCount(raw[0], preset.min), max: toCount(raw[1], preset.max) };
  const o = obj(raw);
  return { min: toCount(o.min, preset.min), max: toCount(o.max, preset.max) };
}

function normLimits(raw: unknown): OuterLoopLimits {
  const g = obj(raw);
  return {
    quiet: normSpan(g.quiet, OUTER_LOOP_LIMITS.quiet),
    interval: normSpan(g.interval, OUTER_LOOP_LIMITS.interval),
    clockTimes: normSpan(g.clockTimes ?? g.clockTime, OUTER_LOOP_LIMITS.clockTimes),
  };
}

function normBuiltin(raw: unknown): OuterLoopBuiltin[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === "string" ? { name: x, description: "" } : { name: str(obj(x).name), description: str(obj(x).description ?? obj(x).description) }))
    .filter((x) => x.name);
}

export function normOuterLoopInventory(raw: unknown): OuterLoopInventory {
  const d = obj(raw);
  const k = obj(d.catalog);
  const au = obj(d.trigger);
  const kinds = strList(au.kinds).filter((x): x is OuterLoopTriggerKind => (OUTER_LOOP_TRIGGER_KINDS as readonly string[]).includes(x));
  return {
    items: Array.isArray(d.items) ? d.items.map(normOuterLoopAgent) : [],
    catalog: {
      groups: Array.isArray(k.groups) ? (k.groups as ToolGroup[]) : [],
      toolAreas: Array.isArray(k.toolAreas) ? (k.toolAreas as ToolArea[]) : [],
      builtin: normBuiltin(k.builtin),
      mcpServer: Array.isArray(k.mcpServer) ? (k.mcpServer as ManagerMcpServer[]) : [],
      cbaseApproval: strList(k.cbaseApproval),
      fenceDropped: strList(k.fenceDropped),
    },
    trigger: { kinds: kinds.length ? kinds : [...OUTER_LOOP_TRIGGER_KINDS], limits: normLimits(au.limits) },
    template: { revision: toCount(obj(d.template).revision, 1) },
  };
}

function normSet(raw: unknown): OuterLoopSet {
  let s: unknown = raw;
  if (typeof raw === "string") { try { s = JSON.parse(raw); } catch { s = {}; } }
  const o = obj(s);
  const ent = obj(o.dropped);
  // `extern` is a list `{key, name, tools}` in the run row (server outerloop/set.js:setRow) and becomes "<server>: <tool>" per tool;
  // fallbacks: a list of plain names or a map server → tools. iOS computes the same (Models/OuterLoopModels.swift, OuterLoopSetRaw).
  const extern = Array.isArray(o.extern)
    ? o.extern.flatMap((x) => {
      if (typeof x === "string") return [x];
      const e = obj(x);
      const srv = str(e.name) || str(e.key);
      const tools = strList(e.tools);
      return tools.length ? tools.map((w) => (srv ? `${srv}: ${w}` : w)) : [srv];
    }).filter(Boolean)
    // The map sorted by server, like iOS (a Swift dictionary has no order; bound in web/test/outerloop-set-binding).
    : Object.entries(obj(o.extern)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flatMap(([srv, l]) => strList(l).map((w) => `${srv}: ${w}`));
  return { cbase: strList(o.cbase), builtin: strList(o.builtin), extern, dropped: { fence: strList(ent.fence), approval: strList(ent.approval), locked: strList(ent.locked), genus: strList(ent.genus) } };
}

export function normOuterLoopRun(raw: unknown): OuterLoopRun {
  const l = obj(raw);
  return {
    id: str(l.id),
    agentId: str(l.agentId),
    chatId: str(l.chatId),
    chatTitle: str(l.chatTitle),
    chatKind: chatKindOf(l.chatKind),
    trigger: str(l.trigger),
    state: str(l.state),
    startedAt: toCount(l.startedAt),
    endedAt: countOrNull(l.endedAt),
    parkedUntil: countOrNull(l.parkedUntil),
    attempts: toCount(l.attempts, 1),
    set: normSet(l.set),
    error: str(l.error),
    provider: str(l.provider),
    model: str(l.model),
    billing: str(l.billing),
    input: toCount(l.input),
    output: toCount(l.output),
    cached: toCount(l.cached),
    cost: countOrNull(l.cost),
    upkeep: normRunUpkeep(l.upkeep),
  };
}

export function normOuterLoopNote(raw: unknown): OuterLoopNote {
  const n = obj(raw);
  return { id: toCount(n.id), agentId: str(n.agentId), agentName: str(n.agentName), chatId: str(n.chatId), runId: str(n.runId), text: str(n.text), at: toCount(n.at) };
}

function normChatAgent(raw: unknown): OuterLoopChatAgent {
  const a = obj(raw);
  const full = normOuterLoopAgent(a);
  const last = a.lastRun && typeof a.lastRun === "object" ? normOuterLoopRun(a.lastRun) : null;
  return {
    id: full.id,
    name: full.name,
    origin: full.origin,
    summarizer: full.summarizer,
    agendaKeeper: full.agendaKeeper,
    timeline: full.timeline,
    effective: full.effective,
    ineffectiveReason: full.ineffectiveReason,
    provider: full.provider,
    model: full.model,
    job: full.job,
    active: a.active === true,
    source: str(a.source),
    since: countOrNull(a.since),
    // A switch the server does not explicitly release stays locked.
    toggleable: a.toggleable === true,
    running: typeof a.running === "number" ? a.running > 0 : a.running === true,
    lastRun: last,
  };
}

export function normOuterLoopChatState(raw: unknown): OuterLoopChatState {
  const d = obj(raw);
  return {
    targetChat: d.targetChat === true,
    reason: str(d.reason),
    agents: Array.isArray(d.agents) ? d.agents.map(normChatAgent) : [],
    notes: Array.isArray(d.notes) ? d.notes.map(normOuterLoopNote) : [],
  };
}

// ── Routes to the server ───────────────────────────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;
const wsPath = (wid: string) => `/api/workspaces/${enc(wid)}/outer-loop`;
const agentPath = (wid: string, aid: string) => `${wsPath(wid)}/${enc(aid)}`;
const chatPath = (chatId: string) => `/api/chats/${enc(chatId)}/outer-loop`;

export async function outerLoopInventory(wid: string): Promise<OuterLoopInventory> {
  return normOuterLoopInventory(await api<unknown>(wsPath(wid)));
}

export async function outerLoopAgent(wid: string, aid: string): Promise<OuterLoopAgent> {
  return normOuterLoopAgent(await api<unknown>(agentPath(wid, aid)));
}

export async function createOuterLoop(wid: string, b: OuterLoopBody): Promise<OuterLoopAgent> {
  return normOuterLoopAgent(await api<unknown>(wsPath(wid), { method: "POST", body: JSON.stringify(b) }));
}

/** PATCH: only the passed fields (a missing field means "unchanged"). */
export async function changeOuterLoop(wid: string, aid: string, b: Partial<OuterLoopBody>): Promise<OuterLoopAgent> {
  return normOuterLoopAgent(await api<unknown>(agentPath(wid, aid), { method: "PATCH", body: JSON.stringify(b) }));
}

/** Delete. A running run is ended; a built-in one (summarizer, agenda keeper) answers 409. */
export function deleteOuterLoop(wid: string, aid: string) {
  return api<{ ok: boolean }>(agentPath(wid, aid), { method: "DELETE" });
}

/** Reset a built-in agent to ITS cbase template; provider, model, effort and "on" stay. */
export async function resetOuterLoop(wid: string, aid: string): Promise<OuterLoopAgent> {
  return normOuterLoopAgent(await api<unknown>(`${agentPath(wid, aid)}/reset`, { method: "POST" }));
}

/** The runs of an agent, newest first. Paging uses `after` = id of the LAST run of the previous page; the server resolves it to
 *  (startedAt, rowid); a cursor over `startedAt` alone lost runs started at the same time at the page boundary. */
export async function outerLoopRuns(wid: string, aid: string, q: { limit?: number; after?: string | null } = {}): Promise<OuterLoopRunsPage> {
  const p = new URLSearchParams();
  if (q.limit) p.set("limit", String(q.limit));
  if (q.after) p.set("after", q.after);
  const qs = p.toString();
  const d = obj(await api<unknown>(`${agentPath(wid, aid)}/runs${qs ? `?${qs}` : ""}`));
  const s = obj(d.sum);
  return {
    items: Array.isArray(d.items) ? d.items.map(normOuterLoopRun) : [],
    additional: d.additional === true,
    sum: { runs: toCount(s.runs), input: toCount(s.input), output: toCount(s.output), cached: toCount(s.cached), cost: countOrNull(s.cost) },
  };
}

/** The workspace agents in the project, each with `takenOver`. */
export async function outerLoopProject(pid: string): Promise<{ items: (OuterLoopAgent & { takenOver: boolean })[] }> {
  const d = obj(await api<unknown>(`/api/projects/${enc(pid)}/workspace-outer-loop`));
  const items = Array.isArray(d.items) ? d.items : [];
  return { items: items.map((x) => ({ ...normOuterLoopAgent(x), takenOver: obj(x).takenOver !== false })) };
}

export function outerLoopTakeover(pid: string, aid: string, takenOver: boolean) {
  const body: { takenOver: boolean } = { takenOver };
  return api<{ ok: boolean; agentId: string; takenOver: boolean }>(`/api/projects/${enc(pid)}/workspace-outer-loop/${enc(aid)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function outerLoopChat(chatId: string): Promise<OuterLoopChatState> {
  return normOuterLoopChatState(await api<unknown>(chatPath(chatId)));
}

/** An agent on or off on THIS chat (row on/off; three-valued with "no row"). */
export function outerLoopChatActive(chatId: string, aid: string, on: boolean) {
  const body: { enabled: boolean } = { enabled: on };
  return api<{ ok: boolean; agentId: string; enabled: boolean; active: boolean; source: string }>(`${chatPath(chatId)}/${enc(aid)}/active`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** A chat-owned agent (chat origin); only the human creates it. */
export async function createOuterLoopChat(chatId: string, b: OuterLoopChatBody): Promise<OuterLoopAgent> {
  return normOuterLoopAgent(await api<unknown>(chatPath(chatId), { method: "POST", body: JSON.stringify(b) }));
}

export async function outerLoopChatNotes(chatId: string, q: { agentId?: string | null; limit?: number; before?: number | null } = {}): Promise<{ items: OuterLoopNote[]; additional: boolean }> {
  const p = new URLSearchParams();
  if (q.agentId) p.set("agentId", q.agentId);
  if (q.limit) p.set("limit", String(q.limit));
  if (q.before != null) p.set("before", String(q.before));
  const qs = p.toString();
  const d = obj(await api<unknown>(`${chatPath(chatId)}/notes${qs ? `?${qs}` : ""}`));
  return { items: Array.isArray(d.items) ? d.items.map(normOuterLoopNote) : [], additional: d.additional === true };
}

// ── Approval marks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Which built-in cbase tools an agent runs only after the human's approval: per workspace, not per agent (server
// toolchain/approval-marks.js, route GET/PUT /api/workspaces/:id/approval-marks). Set here in the outer-loop area
// (components/outerloop/ApprovalMarks.tsx). An outer-loop run leaves a marked tool out (nobody is there to approve).

/** `tools`: the marks that are set; `markable`: the tools that can carry a mark, in catalog order. */
export interface ApprovalMarks { tools: string[]; markable: string[] }

const markersPath = (wid: string) => `/api/workspaces/${enc(wid)}/approval-marks`;
const normMarkers = (raw: unknown): ApprovalMarks => { const d = obj(raw); return { tools: strList(d.tools), markable: strList(d.markable) }; };

export async function loadApprovalMarks(wid: string): Promise<ApprovalMarks> {
  return normMarkers(await api<unknown>(markersPath(wid)));
}

/** Replaces the workspace's marks with `tools` (a missing `tools` would be a 400 on the server, not "no mark"). */
export async function setApprovalMarks(wid: string, tools: string[]): Promise<ApprovalMarks> {
  const body: { tools: string[] } = { tools };
  return normMarkers(await api<unknown>(markersPath(wid), { method: "PUT", body: JSON.stringify(body) }));
}
