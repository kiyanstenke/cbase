// The progress tree of a dynamic workflow as a pure computation — without React, so the guard (web/test/dyn-tree.test.mjs) can transpile it
// with tsc and check it. Imports only leaves, relative with a `.js` ending (the test transpiles without a tsconfig).
//
// The server delivers ONE view per run (dynworkflows/tree.js, via `GET /api/chats/:id/dyn-workflows/tree` and the
// event `dynwf_tree` — the same function, so after ⌘R the tree shows what it showed live): header, the phases in
// their order, the agents FLAT with phase and journal state, the log() lines. From that this file builds what the
// bar shows: the bands (one per phase), n/m and per agent the display word via the bound table
// (`journalAgentState`, web ↔ iOS in web/test/history-binding.test.mjs). n/m is computed ONLY by this file.
//
// The view is like Claude Code's workflow view — phases as cards with one tile per agent, expanded a table
// agent · model · tokens · time — so this file also computes what the cards and the table show: n/m per phase (`TreeBand.finished`), whether a
// phase stands open by itself (`bandDefaultOpen`), the kind of tile per agent (`tileKind`), the time per agent and per run
// (`agentDurationMs`, `runDurationMs`), the sum of tokens (`runTokens`) and the short name of the model for the column
// (`modelShortName`). The twin is iOS `Chat/DynTree.swift`, bound in web/test/dyn-tree-binding.test.mjs (both sides REALLY executed).
//
// This file also computes the WAIT REASON as text (`waitText` per row, `bandWaitText` per phase): a phase with six dashed circles
// without tokens and time would look skipped, while the cap per run (2) holds the agents back. “waiting · 2 at a time” in the row,
// “waiting for a free slot · 2 at a time” at the phase header. The number comes from the server (`DynTreeRun.cap`), the kind from the journal
// (`DynTreeAgent.cap`); if one of the two is missing (an older server), the text stands without a number — none is invented.
// The number stands in the short version FIRST (“waiting · 8 per user”, not “waiting · user cap 8” — the narrow cell
// cuts at the end, and truncated exactly the number would drop). Where the short text stands is decided by `waitCell`: in the place of model,
// tokens and time ONLY while the waiting one has nothing yet (no start, no tokens); an agent that already ran and is parked at the
// usage limit keeps its columns, and the reason stands briefly next to the label — as on iOS, where it stands in the
// secondary line and tokens and time always stay.
//
// The state of the tree in the client (`DynTreeStatus`) knows “not loaded”: a chat whose route has not answered yet
// is not “without workflow” (empty is not unknown). Events that arrive while the route loads are
// remembered and laid over after its answer — otherwise a message between request and answer would be lost, and at the
// end of a run no further one would come to heal it.
import { journalAgentState, type AgentState } from "./history-state.js";

/** The event in the chat stream (harness subtype) — not “workflow…”: that is the graph. */
export const TREE_EVENT = "dynwf_tree";

export type DynTokenParts = { input: number; cacheWrite: number; cacheRead: number; output: number };

export type DynTreeAgent = {
  /** The number of the agent() call in the run (1…). */
  n: number;
  label: string;
  phase: string | null;
  /** Journal state (dynworkflows/tree.js agentState): running · waiting · finished · error · skipped · stopped · without-result. */
  status: string;
  /** Only for “waiting”: cap · storage · stagger · limit · credit-gate · project. */
  reason?: string;
  /** Only for reason “cap”: the cap that held it when it was queued (journal) — run · user. The number stands on the run. */
  cap?: string;
  provider: string;
  model: string;
  effort?: string;
  agentId: string;
  tokens?: number;
  tokenKind?: "full" | "only_output";
  /** What `tokens` consists of (same form as `TokenParts` in lib/agents.ts) — only for the title on hover. */
  tokenParts?: DynTokenParts;
  fromCache?: boolean;
  workflow?: string;
  /** Restarts by the human — missing without a restart. */
  restarts?: number;
  /** First start of its process (journal `started`, ms) — missing while it waits, and for a result from the journal. */
  startedAt?: number;
  /** Its end (journal `result`/`failed`, ms) — missing while it runs or waits. */
  endedAt?: number;
};

export type DynTreeRun = {
  runId: string;
  taskId: string;
  name: string;
  /** running · finished · stopped · failed · interrupted */
  status: string;
  stoppedOf: string;
  error: string;
  startedAt: number;
  endedAt: number | null;
  /** The current phase: the last phase() line of the script, `null` before the first. */
  phase: string | null;
  phases: string[];
  agents: DynTreeAgent[];
  logs: { text: string; phase: string | null; at: number }[];
  /** The server left out this many older log() lines (cap). */
  logsTruncated: number;
  warning?: string;
  /** meta.description of the script — missing for an older server, empty without. */
  description?: string;
  /** The numbers of the caps that apply NOW (dynworkflows/cap.js runCap/userCap) — only on a running
   *  run; missing for an older server and on a finished run. */
  cap?: DynCap;
};

export type DynCap = { run?: number; user?: number };

/** `loading`: a request to the route is under way — events then go ALSO into `buffer`. */
export type DynTreeStatus = {
  loaded: boolean;
  loading: boolean;
  runs: DynTreeRun[];
  /** The route does not show this many older runs (cap). */
  additional: number;
  buffer: DynTreeRun[];
};

export const TREE_UNLOADED: DynTreeStatus = Object.freeze({ loaded: false, loading: false, runs: [], additional: 0, buffer: [] }) as DynTreeStatus;

const isRun = (x: unknown): x is DynTreeRun =>
  Boolean(x) && typeof (x as DynTreeRun).runId === "string" && Array.isArray((x as DynTreeRun).agents);

// Put a run into the list: replaces the one with the same run id in its place, a new one stands first (newest first).
function place(runs: DynTreeRun[], run: DynTreeRun): DynTreeRun[] {
  const i = runs.findIndex((l) => l.runId === run.runId);
  if (i < 0) return [run, ...runs];
  const fresh = runs.slice();
  fresh[i] = run;
  return fresh;
}

/** A request to the route begins (chat switch, reconnection): the state shown stays, events are remembered. */
export function treeLoading(s: DynTreeStatus): DynTreeStatus {
  return { ...s, loading: true, buffer: [] };
}

/** The answer of the route: its runs, over them every event that came during the request. An answer without a list
 *  changes nothing (it is not an empty one). */
export function treeLoaded(s: DynTreeStatus, response: unknown): DynTreeStatus {
  const a = response as { runs?: unknown; additional?: unknown } | null;
  if (!a || !Array.isArray(a.runs)) return { ...s, loading: false, buffer: [] };
  let runs = a.runs.filter(isRun);
  for (const l of s.buffer) runs = place(runs, l);
  return { loaded: true, loading: false, runs, additional: typeof a.additional === "number" ? a.additional : 0, buffer: [] };
}

/** An event from the stream. Only `dynwf_tree` counts; everything else leaves the state unchanged (same identity). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function treeAfterEvent(s: DynTreeStatus, evt: Record<string, any>): DynTreeStatus {
  if (evt?.type !== "harness" || evt.subtype !== TREE_EVENT || !isRun(evt.tree)) return s;
  const run = evt.tree as DynTreeRun;
  return {
    ...s,
    runs: place(s.runs, run),
    buffer: s.loading ? [...s.buffer, run] : s.buffer,
  };
}

/** Does the chat carry a workflow? `null` = not loaded yet — NOT “no”. */
export function carriesWorkflow(s: DynTreeStatus): boolean | null {
  if (s.runs.length > 0) return true;
  return s.loaded ? false : null;
}

/** The running workflow agents of all runs — the contribution to the agent badge of the rail. Waiting ones do not run. */
export function runningWorkflowAgents(s: DynTreeStatus): number {
  let n = 0;
  for (const l of s.runs) if (l.status === "running") for (const a of l.agents) if (a.status === "running") n++;
  return n;
}

export type TreeRow = DynTreeAgent & { state: AgentState | null };
/** A phase without an agent() call — known from meta.phases (the server sends them along so one sees what is
 *  still to come) or entered without an agent starting in it: `running` = the current phase, still without agents;
 *  `without_agents` = already passed (it lies before the current one or before a phase with agents); `pending` = it
 *  is still to come; `not_reached` = the run ended before it. */
export type BandEmpty = "running" | "without_agents" | "pending" | "not_reached";
/** The word of an empty phase — key for `t()` (web) or `L()` (iOS, `DynTree`). */
export const BAND_EMPTY_WORD: Record<BandEmpty, string> = {
  running: "running", without_agents: "no agents", pending: "pending", not_reached: "not reached",
};
/** A phase as a card: title (`null` = the agents without a phase), its rows and n/m of the card — n = “finished” as at the
 *  header, m = its rows. `empty` stands exactly at a phase without rows. */
export type TreeBand = { title: string | null; rows: TreeRow[]; finished: number; empty?: BandEmpty };
export type TreeHeader = {
  runId: string;
  name: string;
  phase: string | null;
  /** n/m: n = agents with a result (only “finished” — skipped, failed, stopped do NOT count), m = agent() calls. */
  finished: number;
  started: number;
  status: string;
  running: boolean;
  stoppedOf: string;
  logs: DynTreeRun["logs"];
  logsTruncated: number;
  warning?: string;
  /** meta.description — empty without (an older server delivers none). */
  description: string;
};

/** What the bar shows of ONE run: header and bands (one per phase, in the order of the phases — also those in
 *  which no agent ran yet, with `empty`; agents without a phase in the last band without a title), per agent the display word. */
export function treeModel(run: DynTreeRun): { header: TreeHeader; bands: TreeBand[] } {
  const rows: TreeRow[] = run.agents.map((a) => ({ ...a, state: journalAgentState(a.status) }));
  const title = [...run.phases];
  for (const z of rows) if (z.phase !== null && !title.includes(z.phase)) title.push(z.phase);
  const finished = (rowList: TreeRow[]) => rowList.filter((z) => z.status === "finished").length;
  const running = run.status === "running";
  const current = run.phase === null ? -1 : title.indexOf(run.phase);
  // How far the run got: the current phase or the last one with an agent, whichever lies further back.
  const reached = title.reduce((m, t, i) => (rows.some((z) => z.phase === t) ? Math.max(m, i) : m), current);
  const bands: TreeBand[] = title.map((t, i) => {
    const rowList = rows.filter((z) => z.phase === t);
    if (rowList.length) return { title: t as string | null, rows: rowList, finished: finished(rowList) };
    const empty: BandEmpty = i === current && running ? "running" : i <= reached ? "without_agents" : running ? "pending" : "not_reached";
    return { title: t as string | null, rows: rowList, finished: 0, empty };
  });
  const without = rows.filter((z) => z.phase === null);
  if (without.length) bands.push({ title: null, rows: without, finished: finished(without) });
  return {
    header: {
      runId: run.runId,
      name: run.name,
      phase: run.phase,
      finished: run.agents.filter((a) => a.status === "finished").length,
      started: run.agents.length,
      status: run.status,
      running: run.status === "running",
      stoppedOf: run.stoppedOf,
      logs: run.logs,
      logsTruncated: run.logsTruncated,
      ...(run.warning ? { warning: run.warning } : {}),
      description: typeof run.description === "string" ? run.description.trim() : "",
    },
    bands,
  };
}

/** Does a phase card stand open by itself? Only in a running run, and only while something in it runs or
 *  waits — the running phase is open, a finished one closed. A click of the human takes precedence over this default (the view
 *  holds its choice); a finished run no longer toggles anything by itself. Twin: iOS `DynTree.bandDefaultOpen`. */
export function bandDefaultOpen(band: Pick<TreeBand, "rows">, runRunning: boolean): boolean {
  return runRunning && band.rows.some((z) => z.status === "running" || z.status === "waiting");
}

/** The tile of an agent in the row of its phase, colored by state: blue = running, green = finished, gray outlined =
 *  waiting, red = error, amber = aborted (stopped, without a result), muted = skipped or unknown.
 *  Twin: iOS `DynTree.tileKind`. */
export type TileKind = "running" | "finished" | "waiting" | "error" | "aborted" | "muted";
export function tileKind(status: string): TileKind {
  switch (status) {
    case "running": return "running";
    case "finished": return "finished";
    case "waiting": return "waiting";
    case "error": return "error";
    case "stopped": case "without-result": return "aborted";
    default: return "muted";
  }
}

/** The time of ONE agent in ms: from the first start to its end; without an end it runs until `now` while the run
 *  runs, otherwise until the end of the run (an agent the run left behind without an end of its own). `null` = never started
 *  (waiting, from the journal, failed before the start) — the column then shows a dash, not a zero. */
export function agentDurationMs(a: Pick<DynTreeAgent, "startedAt" | "endedAt">, run: Pick<DynTreeRun, "status" | "endedAt">, now: number): number | null {
  if (typeof a.startedAt !== "number") return null;
  const end = typeof a.endedAt === "number" ? a.endedAt
    : run.status === "running" ? now
    : typeof run.endedAt === "number" ? run.endedAt : null;
  return end === null ? null : Math.max(0, end - a.startedAt);
}

/** The run time of the workflow in ms — until `now` while it runs; `null` without a start time (an older server, a
 *  sparse view) or without the end of a finished one. */
export function runDurationMs(run: Pick<DynTreeRun, "status" | "startedAt" | "endedAt">, now: number): number | null {
  if (typeof run.startedAt !== "number" || !(run.startedAt > 0)) return null;
  const end = run.status === "running" ? now : run.endedAt;
  return typeof end === "number" ? Math.max(0, end - run.startedAt) : null;
}

/** The tokens of the whole run: the sum of the reported numbers, as a lower bound (“only_output”) as soon as ONE of them is not
 *  reported as complete (the same rule as `tokenLowerLimit` in lib/agents.ts). `null` if no agent carries a
 *  number — no zero. */
export function runTokens(run: Pick<DynTreeRun, "agents">): { tokens: number; tokenKind: "full" | "only_output" } | null {
  let tokens = 0;
  let counted = 0;
  let full = true;
  for (const a of run.agents) {
    if (typeof a.tokens !== "number") continue;
    tokens += a.tokens;
    counted++;
    if (a.tokenKind !== "full") full = false;
  }
  return counted ? { tokens, tokenKind: full ? "full" : "only_output" } : null;
}

/** The parts of the run sum — only if EVERY agent with a number also carries its parts; otherwise `null`, and the title
 *  shows only the number (a breakdown that does not match the sum would be worse than none). Display only in the web, so
 *  not bound to iOS like `runTokens`. */
export function runTokenParts(run: Pick<DynTreeRun, "agents">): DynTokenParts | null {
  const sum: DynTokenParts = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let counted = 0;
  for (const a of run.agents) {
    if (typeof a.tokens !== "number") continue;
    if (!a.tokenParts) {
      if (a.tokens === 0) continue; // an agent at 0 (Codex until the turn ends, stopped before the first call) contributes nothing
      return null;
    }
    sum.input += a.tokenParts.input;
    sum.cacheWrite += a.tokenParts.cacheWrite;
    sum.cacheRead += a.tokenParts.cacheRead;
    sum.output += a.tokenParts.output;
    counted++;
  }
  return counted ? sum : null;
}

/** The model for the NARROW column of the table: without the provider (it stands in the title of the cell, `modelText`), without
 *  the path of a router and without the doubled prefix — “claude” + “claude-opus-5-5” becomes “opus-5-5”, “codex” +
 *  “gpt-5.6-sol” stays “gpt-5.6-sol”. Without a model (or with a placeholder in brackets) the provider. */
export function modelShortName(provider: string, model: string): string {
  const m = model.startsWith("(") ? "" : model;
  if (!m) return provider;
  const name = m.slice(m.lastIndexOf("/") + 1);
  return provider && name.startsWith(`${provider}-`) && name.length > provider.length + 1 ? name.slice(provider.length + 1) : name;
}

/** The word for the outcome of a run at the header — an i18n key; “running” is the state word of the table. */
export function runWord(status: string): string {
  switch (status) {
    case "running": return "running";
    case "finished": return "done";
    case "stopped": return "stopped";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    default: return status;
  }
}

/** What a waiting agent waits for, as text. Three versions, each an i18n key (`t(…, values)` in the web,
 *  `L(…, values)` on iOS): `short` stands in the row (in the place of model, tokens and time while it has none of them —
 *  otherwise next to the label, `waitCell`; the number first so that truncation does not hit it), `lang` at the phase header, read aloud
 *  and in the “Message” sheet, `explanation` in the title. `values.n` is the number of the cap that holds (only if kind AND number are
 *  known), `values.reason` an unknown reason verbatim. */
export type WaitText = { short: string; lang: string; explanation: string; values: { n?: number; reason?: string } };

/** The texts of ONE version — short, long, explanation — in this order. */
const WAIT_TEXTS = {
  run: ["waiting · {n} at a time", "waiting for a free slot · {n} at a time",
    "Cap per workflow: {n} at a time. The agent starts as soon as a slot frees up."],
  user: ["waiting · {n} per user", "waiting for a free slot · {n} per user",
    "Cap across all workflows: {n} at a time (setting “Concurrent workflow agents”). The agent starts as soon as a slot frees up."],
  cap: ["waiting for a slot", "waiting for a free slot", "All slots are taken — the agent starts as soon as one frees up."],
  stagger: ["waiting · prompt cache", "waiting for the prompt cache",
    "Agents with the same model start staggered: the first writes the prompt cache, the others read it afterwards."],
  limit: ["waiting · limit", "waiting at the usage limit", "The provider is at its usage limit — it continues after the reset."],
  "credit-gate": ["waiting · credit gate", "waiting at the credit gate", "The credit gate holds back new starts — the agent starts after the window resets."],
  project: ["waiting · project", "waiting for the project", "The project's container is not ready yet — the agent starts as soon as it is."],
  storage: ["waiting · memory", "waiting for free memory",
    "Memory is tight (container above 80 % of its limit or host below 20 % free) — the agents start one after another as soon as there is room again."],
  without: ["waiting", "waiting", "waiting"],
  otherwise: ["waiting · {reason}", "waiting · {reason}", "waiting · {reason}"],
} as const satisfies Record<string, readonly [string, string, string]>;
/** The reasons the server writes into the journal (dynworkflows/run.js; “limit” also tree.js for a parked one) — each
 *  has its own version above. Bound to the server in web/test/dyn-tree.test.mjs: a new reason there that is missing here
 *  would otherwise stand verbatim (“waiting · credit-gate”) in the row. */
export const WAIT_REASONS: readonly string[] = ["cap", "stagger", "limit", "credit-gate", "project", "storage"];
/** The kinds of cap that hold a waiting one (dynworkflows/cap.js: per run · per user) — each has its own
 *  version above with a number and on the run its number (`DynCap`). Bound to the server in web/test/dyn-tree.test.mjs; from both
 *  lists web/test/dyn-tree-binding.test.mjs generates the flow “wait reason visible”, which iOS must follow step by step
 *  — a new reason or kind without an iOS text is red there. */
export const CAP_KINDS = ["run", "user"] as const;
type CapKind = (typeof CAP_KINDS)[number];
const isCapKind = (x: unknown): x is CapKind => (CAP_KINDS as readonly unknown[]).includes(x);
/** Every key `waitText` can return — for the test that every one is translated (web and iOS). */
export const WAIT_KEY: readonly string[] = Object.values(WAIT_TEXTS).flat();

const wholeNumber = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1;
const revision = (f: keyof typeof WAIT_TEXTS, values: WaitText["values"] = {}): WaitText =>
  ({ short: WAIT_TEXTS[f][0], lang: WAIT_TEXTS[f][1], explanation: WAIT_TEXTS[f][2], values });

/** The wait reason of ONE row — `null` if the agent does not wait. For reason “cap” with a number only if the kind (journal)
 *  AND its number (on the run) are known; otherwise without a number. Twin: iOS `DynTree.waitText`. */
export function waitText(a: Pick<DynTreeAgent, "status" | "reason" | "cap">, cap: DynCap | undefined): WaitText | null {
  if (a.status !== "waiting") return null;
  const reason = typeof a.reason === "string" ? a.reason : "";
  switch (reason) {
    case "cap": {
      const kind = isCapKind(a.cap) ? a.cap : null;
      const n = kind ? cap?.[kind] : undefined;
      return kind && wholeNumber(n) ? revision(kind, { n }) : revision("cap");
    }
    case "stagger": case "limit": case "credit-gate": case "project": case "storage": return revision(reason);
    case "": return revision("without");
    default: return revision("otherwise", { reason });
  }
}

/** Does the wait reason of a row stand in the place of model, tokens and time (`true`) — or do the columns stay, and the
 *  reason stands briefly next to the label (`false`)? The cell only while the waiting one has NOTHING of that: no `startedAt` and
 *  no tokens (an agent waiting for a slot, the prompt cache, the gate or the project). An agent that already ran
 *  and is parked at the usage limit (dynworkflows/tree.js agentState: parked ⇒ waiting, reason “limit” — with `startedAt` and
 *  tokens) keeps model, tokens and time; otherwise what it already consumed would disappear behind the word. For one that does not wait, `false`.
 *  iOS always shows tokens and time and the reason in the secondary line — the same statement, without a cell. */
export function waitCell(a: Pick<DynTreeAgent, "status" | "startedAt" | "tokens">): boolean {
  return a.status === "waiting" && typeof a.startedAt !== "number" && typeof a.tokens !== "number";
}

/** The wait reason at the header of a PHASE: only in a running run, only if something in it waits and nothing runs — then that of the
 *  first waiting one (in call order: the one that starts next). Otherwise `null`: if one runs, the phase has not
 *  stalled. Twin: iOS `DynTree.bandWaitText`. */
export function bandWaitText(band: Pick<TreeBand, "rows">, runRunning: boolean, cap: DynCap | undefined): WaitText | null {
  if (!runRunning || band.rows.some((z) => z.status === "running")) return null;
  const first = band.rows.find((z) => z.status === "waiting");
  return first ? waitText(first, cap) : null;
}

/** The two actions on ONE agent row — 1:1 Claude Code's view: skip and restart,
 *  no third word “stop per agent” (the stop of the WHOLE workflow stands at the header). Only in a running run and
 *  only on a started agent (with agentId): skip while it runs or is parked at the usage limit
 *  (“waiting” WITH agentId — a waiting one without has no process yet); restart only in the middle of an attempt (“running”). The
 *  server checks the same (409) — the rule here only decides which button stands. Twin: iOS `DynTree.handles`. */
export type AgentHandles = { skip: boolean; restart: boolean };
export function agentHandles(a: Pick<DynTreeAgent, "status" | "agentId">, runRunning: boolean): AgentHandles {
  const started = runRunning && Boolean(a.agentId);
  return { skip: started && (a.status === "running" || a.status === "waiting"), restart: started && a.status === "running" };
}

/** The path of an action (`POST`, no body). */
export function interventionPath(chatId: string, runId: string, n: number, kind: "skip" | "restart"): string {
  return `/api/chats/${encodeURIComponent(chatId)}/dyn-workflows/runs/${encodeURIComponent(runId)}/agents/${n}/${kind}`;
}
