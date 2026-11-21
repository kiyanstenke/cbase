import type { Project } from "./events.js";
// Copies being created, in the "Active runs" pill: type and allowlist in the leaf copy-progress.ts (the tree reads it too).
import type { ActiveCopy } from "./copy-progress.js";

// ── Workflows (node/edge graph the agent works through step by step) ──
export type WorkflowNodeType = "trigger" | "start" | "instruction" | "condition" | "loop" | "parallel" | "ask" | "review" | "end";
export type WorkflowBranch = "true" | "false" | "each" | "done" | "ok" | "issues" | null;
// Event kinds of the GitLab trigger: order and names exactly as in workflows.js (GITLAB_EVENTS); the server checks them again on save.
export type GitlabEventKind =
  | "mr_opened" | "mr_updated" | "mr_merged" | "mr_closed" | "mr_review_requested"
  | "issue_opened" | "issue_closed" | "issue_assigned"
  | "comment" | "push" | "pipeline_failed" | "pipeline_succeeded";
export interface WorkflowTrigger {
  source: "gitlab";
  accountId: string;
  scope: "all" | "group" | "project";
  projectId: string;
  projectPath: string;
  groupId: string;
  groupPath: string;
  events: GitlabEventKind[];
  labels: string;
  branch: string;
  skipMine: boolean;
  intervalSec: number;
}
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  text: string;
  command?: string;         // optional message before the node's actual work
  x: number;
  y: number;
  items?: string[];        // loop only: fixed list (empty = the model generates it)
  maxIterations?: number;  // loop only: at most N elements
  maxVisits?: number;      // round cap of this step per run (0 = the run's default)
  notify?: boolean;        // send a notification on REACHING this node (review: default on)
  // Three-valued: "inherit" = like the workflow (`run.doneAll`/`run.doneCapAuto`/`run.loopCapAuto`). The server always delivers them;
  // a node freshly created in the editor does not carry them yet (missing = "inherit", see `nodeModes`).
  doneMode?: "inherit" | "on" | "off";                 // have the turn judged: is the step done
  doneCapMode?: "inherit" | "ask" | "continue";        // at the check cap: ask or continue
  loopCapMode?: "inherit" | "ask" | "continue";        // at a cycle's round cap: ask or continue
  doneText?: string;       // the criterion for it (empty = the node's task)
  // LEGACY (input only, the server no longer delivers them): a graph in client state or a test graph may carry them. Read only in
  // `nodeModes` (lib/workflow-node-form.ts).
  capAuto?: boolean;
  doneCheck?: boolean;
  trigger?: WorkflowTrigger; // trigger only
}
// Operating state of a trigger (short form of the configuration + last poll/firing).
export interface TriggerView {
  nodeId: string;
  title: string;
  source: string;
  scope: "all" | "group" | "project";
  target: string;
  events: GitlabEventKind[];
  intervalSec: number;
  missing: "" | "account" | "events" | "project" | "group" | "scope";
  account: { id: string; label: string; host: string; userName: string } | null;
  lastPollAt: number;
  lastFireAt: number;
  fires: number;
  lastError: string;
}
export interface GitlabAccount {
  id: string;
  label: string;
  host: string;
  userName: string;
  userId: number;
  hasToken: boolean;
  status: string;
  checkedAt: number;
}
export interface GitlabTarget { id: string; path: string; name: string; webUrl: string }
export interface TriggerTestResult {
  nodeId: string;
  fired: number;
  error: string;
  events: { kind: GitlabEventKind; summary: string; url: string; at: number; author: string }[];
}
// `fromSide`/`toSide`: leftovers of the old two-flank model. Since the switch to the n8n convention (input left, output right) the
// editor neither reads nor writes them; they stay in the type so old graphs load and save unchanged. The driver never read them.
export interface WorkflowEdge { id?: string; from: string; to: string; branch?: WorkflowBranch; fromSide?: "" | "left" | "right"; toSide?: "" | "left" | "right" }
export interface WorkflowGraph { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
export interface WorkflowProblem { level: "error" | "warn"; nodeId?: string; text: string }
// The route `/effective-workflows` remains: the slash picker in the composer calls it itself (with `?projectId=`).
export interface WorkflowMeta {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  originProject?: string;   // in the workspace view: origin of a project workflow
  shortName?: string;        // `/workflow:<shortName>`, only in `/api/chats/:id/workflows` and `/effective-workflows` (the server computes it over the effective set)
  nodeCount: number;
  steps: { total: number; approx: boolean };
  active: boolean;          // trigger armed (the server polls)
  triggers: TriggerView[];
  lock: WorkflowLock;       // concurrency: what excludes what?
  run: WorkflowRunSettings; // provider/model/permissions/effort for this workflow's runs
  holding: { key: string; chatId: string; at: number }[]; // locks this workflow currently holds
  updatedAt: number;
  enabled?: boolean;        // only in a project's takeover list
}
// Lock scope of a workflow. "project" (default) = one run per project/repo; "workflow" = one per workflow; "event" = one per
// triggering issue/MR; "custom" = own template; "off" = parallel.
export interface WorkflowLock {
  scope: "project" | "workflow" | "event" | "custom" | "off";
  template: string;
}
// With which settings does this workflow run? Empty fields = "as usual" (global provider, default model, the chat's setting).
// A stored `todos: true` is ignored by the server.
export interface WorkflowRunSettings {
  provider: string;
  model: string;
  permissionMode: "" | "bypassPermissions" | "acceptEdits" | "plan" | "default";
  // Five levels; a stored legacy value migrates to `max` at start. Which levels a model really carries is stated on the model
  // (`efforts` in /api/providers); here only what MAY be stored (backend: EFFORT_LEVELS in workflows.js; bound in web/test/effort.test.mjs).
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  // Ultracode: the SWITCH as on the chat; on means every step runs with Ultracode; the level above applies unchanged (independent).
  // Missing means off.
  ultracode: boolean;
  // What the completion gate ("check completion") judges with: only this oneshot, not the chat. Empty = the internal task
  // "Workflow verdicts" (Settings → Models).
  doneProvider: string;
  doneModel: string;
  // Auto-compact during a run: null = default (chat value, else global), 0 = off, else a level. Applies only while the run is open and
  // is never written to the chat. Compaction happens only between two steps.
  autocompact: number | null;
  autocompactMax: number | null;
  // "Check all work steps" (missing means on), check rounds 1…10, and what happens at the check or round cap (false = ask,
  // true = continue without asking). A node overrides.
  doneAll: boolean;
  doneRounds: number;
  doneCapAuto: boolean;
  loopCapAuto: boolean;
}
export interface Workflow extends WorkflowMeta {
  graph: WorkflowGraph;
  problems: WorkflowProblem[];
  // Limits of the machinery (default round count, step limit …); the editor labels its fields with them instead of maintaining the
  // numbers a second time. `doneRounds` is this workflow's STORED number (for old clients); the editor reads the edit state
  // `run.doneRounds`. `doneRoundsMax` is the upper bound (server DONE_ROUNDS_MAX).
  limits?: { maxVisits: number; maxVisitsLimit: number; maxSteps: number; maxIterations: number; doneRounds?: number; doneRoundsMax?: number };
}
// A run in the HISTORY (one row per run, survives deletion of the chat too).
export interface WorkflowRunView {
  id: string;
  chatId: string;
  chatGone: boolean;
  workflowId: string;
  name: string;
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  step: number;
  total: number;
  // Is `total` only estimated? Loops, branches and variable start commands make the number indeterminate.
  approx: boolean;
  nodeId: string;
  nodeTitle: string;
  question: string;
  note: string;
  origin: "" | "trigger";
  trigger: { kind: string; summary: string; url: string; project: string; author: string; ref?: string; node?: string; source?: string } | null;
  workspaceId: string;
  projectId: string | null;
  startedAt: number;
  updatedAt: number;
  endedAt: number;
  durationMs: number;
}
// A row of the step log. `detail` is deliberately open: other fields per kind (prompt/output/ok/error for steps, yes/note/tries for
// verdicts, items for loops …).
export interface WorkflowRunStep {
  id: number;
  runId: string;
  at: number;
  durationMs: number;
  kind: "trigger" | "start" | "step" | "decision" | "loop" | "ask" | "review" | "answer" | "skip" | "cap" | "end" | string;
  nodeId: string;
  nodeTitle: string;
  step: number;
  detail: Record<string, unknown> & {
    prompt?: string; output?: string; input?: string; ok?: boolean; error?: string;
    yes?: boolean; note?: string; tries?: string[]; failed?: boolean;
    items?: string[]; question?: string; answer?: string; status?: string; ms?: number;
    rounds?: number; cap?: number | boolean; granted?: number; auto?: boolean; exit?: string;
    verdict?: "ok" | "issues"; round?: number; todoId?: string;
    event?: { summary?: string; url?: string };
  };
}
// A chat's running (or last run) workflow: basis of the progress strip.
export interface WorkflowRun {
  id: string;
  chatId: string;
  workflowId: string;
  name: string;
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  step: number;
  total: number;
  approx: boolean;
  nodeId: string;
  nodeTitle: string;
  question: string;
  note: string;
  // What a waiting run waits for: "" = ask node, "cap" = decision at the round cap.
  pending?: "" | "cap" | string;
  loop: { index: number; total: number; item: string } | null;
  startedAt: number;
  updatedAt: number;
  // 0 = still running. The client computes the total duration: (endedAt || now) − startedAt.
  endedAt: number;
  // The workflow's OWN compaction values (null = default). While the run is open they take precedence over the chat's (hint line in
  // the auto menu, threshold mark). Optional because an event from an older server does not carry them; missing = both default.
  compaction?: { percent: number | null; max: number | null };
}

// An active run for the header overview (GET /api/active-runs). Two kinds in ONE list: a chat whose agent computes or waits
// ("chat"), and a workflow between two steps or with an open question ("workflow").
// A run that hangs on the provider's usage limit and is continued automatically.
export interface LimitWait {
  chatId: string;
  // What is made up: the turn, the compaction or a verdict (goal gate, workflow branch, interpretation of an answer). "judge" reads
  // like "run" in the UI: the flow continues.
  kind: "run" | "compact" | "judge";
  provider: string;
  group: "session" | "weekly" | "credits" | "spend" | "";
  label: string;        // language-neutral, e.g. "weekly:Opus"
  limitText: string;    // finished text from the server (translated)
  // reset = the window's clock runs out · probe = reset unknown, it is checked · credit = the credit gate refused the START (99 %
  // reached, credit would apply). Read via the `gate` mark below (`isGateWaitRow` in lib/credit.ts); the string stands here only as evidence.
  reason: "reset" | "probe" | "credit";
  /** Explicit mark of the server (autoContinueView): the credit gate parked, nothing failed. Label and button hang on this, never on
   *  a text comparison. */
  gate: boolean;
  resetsAt: number | null;
  dueAt: number;
  attempts: number;
  probes: number;
  maxAttempts: number;
  evidence: string;
  workflow: boolean;
  createdAt: number;
  updatedAt: number;
  text: string;
}

export interface ActiveRun {
  id: string;
  // ask = chat with an open question card (cbase_ask): the run is over, the agent waits for the user's decision.
  // dynworkflow = a running dynamic workflow; `workflow` is the graph's kind.
  kind: "chat" | "workflow" | "limit" | "ask" | "dynworkflow";
  chatId: string | null;
  title: string;
  chatKind?: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  provider?: string;
  model?: string;
  startedAt: number;
  // running = computing · waiting = waiting phase (monitor/background/wake time) · ask = question open ·
  // limit = parked until the usage limit resets (does not compute, comes back by itself)
  phase: "running" | "waiting" | "ask" | "limit";
  question?: string;
  background: { monitors: number; agents: number; tasks: number; wakeupAt: number };
  contextTokens?: number;
  queued?: number;
  workflow: { runId: string; workflowId: string; name: string; status: string; step: number; total: number; nodeTitle: string; origin: string; pending?: string } | null;
  // Only for kind "dynworkflow": name and state (latest phase(), finished/begun agent() calls).
  dynWorkflow?: { runId: string; taskId: string; name: string; phase: string | null; agents: number; finished: number } | null;
  lockKey?: string;         // lock this run holds (others wait for it)
  limit?: LimitWait | null;
  stoppable: boolean;
}
export interface ActiveRunsView {
  items: ActiveRun[];
  counts: { total: number; running: number; waiting: number; ask: number; limit: number };
  /** Absent on an older server (then no copies; not "there are none", only "not reported"). */
  copies?: ActiveCopy[];
  now: number;
}

export interface AgentMeta {
  id: string;
  name: string;
  description: string;
  tools: string;
  model: string;
  /** Comma list of skill names loaded COMPLETELY into the subagent's system prompt at start; the same notation as `tools`. */
  skills: string;
  /** Coding MCP servers a subagent of this type gets: serverId → null (all tools) | list. An older server does not send the field. */
  mcp?: Record<string, string[] | null>;
  enabled?: boolean; // only relevant for workspace agents in the project view
}
export interface Agent extends AgentMeta {
  body: string;
}
export interface ProjectAgents {
  projectAgents: Agent[];
  workspaceAgents: Agent[]; // each with .enabled
  /** The default of the workspace agents in THIS project: "on": a new project takes all, also later-created ones, switching off is the
   *  exception; "off": an existing project, each is switched on deliberately. If the field is missing (older server), "off" applies. */
  wsAgentsDefault?: "on" | "off";
}

export interface ContextItem {
  id: number;
  workspace_id: string;
  category: string;
  title: string;
  summary: string;
  tags: string;
  body: string;
  source: string;
  created_at: number;
  // OKF light (workspace knowledge has no git anchors)
  slug?: string;
  status?: string;
  owners?: string;
  confidence?: string;
  updated_at?: number;
}

export interface Category {
  category: string;
  n: number;
}

export interface Overview {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  hasClaudeMd: boolean;
  agents: AgentMeta[];
  projects: Project[];
  categories: Category[];
  contextCount: number;
  varsCount: number;
  mcpCount: number;
  workflowCount?: number;
}

