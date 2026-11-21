// The subagents of ONE chat as ONE list — running ones (from the SSE event) and finished ones (from
// the history the client has anyway). No React, so the gate (web/test/agents.test.mjs) can compile and
// test the merge with tsc. The ONLY import is the leaf ./history-state.js (relative, with the `.js`
// ending: the test compiles without tsconfig, a `@/` would not resolve there) — a subagent's state is
// computed here ONCE per agent, and the mark in the history and the row in the bar read the same value.
//
// Why a merge at all: a subagent shows up in TWO places — as a running entry in the event and as a tool
// block in the history. Whoever does not match by the tool-call id shows it twice. Live wins: for a
// background agent the block carries only "Async agent launched" for seconds, while the event knows
// status and tokens.
//
// The numbers of the FINISHED ones come from the subagent's report (totalTokens, totalDurationMs,
// totalToolUseCount) — it lies as tool_result in the block. No server state, no table, no column.
import { agentState, type AgentState } from "./history-state.js";

/** Does the provider report input AND output ("full") or only the output ("only_output", Codex and
 *  loop engine)? An understated number is otherwise indistinguishable from a complete one. */
export type TokenKind = "full" | "only_output";

/** What the number consists of (server `providers/connectors/consumption.js` tokenParts): the shown number is
 *  `input + cacheWrite + output`; `cacheRead` does not count (it only repeats what was counted) and appears only in
 *  the breakdown on hover (tree of a dynamic workflow). Missing as long as nothing is counted, and in older journals. */
export type TokenParts = { input: number; cacheWrite: number; cacheRead: number; output: number };

/** A running subagent as the SSE event reports it. */
export type LiveAgent = {
  taskId?: string;
  agentId?: string;
  /** The tool call the agent belongs to — the matching key when it comes along. */
  toolUseId?: string;
  parentToolUseId?: string;
  description?: string;
  name?: string;
  provider?: string;
  model?: string;
  status?: string;
  startedAt?: number;
  tokens?: number;
  tokenKind?: TokenKind;
  toolUses?: number;
  /** Only on a parked agent (status "parked"): when it continues after the usage limit (ms). */
  parkedUntil?: number;
  resetsAt?: number;
  /** A call is waiting for it: only then the "To the background" button shows. Missing = background. */
  foreground?: boolean;
  /** "CPU saver": a bash command waits for CPU before starting. Missing = not waiting. */
  waitingForCpu?: boolean;
};

/** The minimum a tool block must provide — `Block` from AssistantBlocks.tsx satisfies it
 *  structurally. `C` is the child block type so the steps can be passed on unchanged without this
 *  file knowing React types. */
export type AgentBlock<C = unknown> = {
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  result?: string;
  resultIsError?: boolean;
  done?: boolean;
  children?: C[];
};

export type AgentStatus = "running" | "finished" | "error";

export type Agent<C = unknown> = {
  /** Stable key for selection and React — the tool call when it is known. */
  id: string;
  /** The agentId for the stop path (POST /agent/stop) — empty if only the block is known. */
  agentId: string;
  job: string;
  model: string;
  provider: string;
  status: AgentStatus;
  /** Does this entry come from the event (then tokens and pace are current)? */
  live: boolean;
  /** The raw status of the report ("completed", "stopped", "failed") — for the word on the row. */
  rawStatus: string;
  startedAt?: number;
  durationMs?: number;
  tokens?: number;
  tokenKind?: TokenKind;
  tools?: number;
  /** Parked at the usage limit: when it continues (ms) — missing while it works. */
  parkedUntil?: number;
  /** "CPU saver": a command waits for CPU before starting — only on the live agent. */
  waitingForCpu?: boolean;
  /** The subagent's child calls — the justification below the report. */
  steps: C[];
  /** What the main agent read. Missing while the agent runs. */
  report?: string;
  /** The run is over and a report never came (stop, restart). Not the same as "failed". */
  withoutResult: boolean;
  /** The state that the bar AND the mark in the history show — computed ONCE, via the chain in
   *  lib/history-state.ts (`agentState`). `null` means finished: no word. `status`, `live` and
   *  `withoutResult` stay alongside (the bar's bands read `live`) but say nothing more about the
   *  word — whoever shows one reads THIS field. */
  state: AgentState | null;
  /** A running foreground agent — its call is still waiting (button "To the background"). */
  foreground?: boolean;
};

/** A subagent's report as agent-runtime.js writes it as tool_result. */
type Report = {
  status?: string;
  agentId?: string;
  name?: string;
  description?: string;
  provider?: string;
  resolvedModel?: string;
  report?: string;
  totalTokens?: number;
  /** Full or lower bound — missing in old data. */
  tokenKind?: string;
  totalToolUseCount?: number;
  totalDurationMs?: number;
  error?: string;
  notes?: string;
};

/** The token kind of a FINISHED agent, from its report. Only the two known values count; if the field is missing
 *  (old data) or holds something foreign, it is unknown (`undefined`) — the display then sets the mark "at least"
 *  (`tokenLowerLimit`): unknown is not full. */
export function tokenKindFromReport(rep: { tokenKind?: unknown } | null | undefined): TokenKind | undefined {
  const kind = rep?.tokenKind;
  return kind === "full" || kind === "only_output" ? kind : undefined;
}

function parseReport(result?: string): Report | null {
  if (!result) return null;
  try {
    const r = JSON.parse(result) as Report;
    return r && typeof r === "object" ? r : null;
  } catch {
    // Not (complete) JSON — then there is simply no report. The block stays valid.
    return null;
  }
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Model as "provider::model" — ONE spelling, as everywhere in the app. Without an explicit
 *  model the provider stays with its default; "(provider default)" is not a model. */
export function modelText(provider: string, model: string): string {
  const m = model.startsWith("(") ? "" : model;
  if (m && provider) return `${provider}::${m}`;
  return m || provider;
}

/** The same model for a NARROW column: the provider already stands in front, so it drops out of the
 *  model name — "claude::claude-opus-5" becomes "claude::opus-5", "codex::gpt-6-astra" stays.
 *  Only the display shortens; `modelText` stays the spelling that applies everywhere else.
 *
 *  Why at all: in the right bar about 159 px remain for the row after dot, token column and time
 *  column. "claude::claude-opus-5" gets cut off in the middle of the doubled word
 *  ("claude::claud…") and says less than nothing. */
export function modelShort(full: string): string {
  // The input is the FINISHED spelling ("provider::model"), not its two parts: `Agent.model` already
  // carries it, and whoever calls `modelText` once more here gets "claude::claude::opus-5".
  const i = full.indexOf("::");
  if (i < 0) return full;
  const header = full.slice(0, i);
  const tail = full.slice(i + 2);
  return `${header}::${tail.startsWith(`${header}-`) ? tail.slice(header.length + 1) : tail}`;
}

/** All ids under which a running agent can be found. The tool-call id first: it is the matching
 *  key, the others are the fallback as long as it does not come along. */
const idsLive = (a: LiveAgent) =>
  [a.toolUseId, a.parentToolUseId, a.taskId, a.agentId].filter((x): x is string => Boolean(x));

/** Merge: running ones first, then the finished ones in history order, every agent EXACTLY ONCE.
 *  `blocks` are the tool blocks the caller has already filtered with `isAgentCall` — the list of
 *  agent tools lives in AssistantBlocks.tsx and should not exist twice.
 *
 *  `running`: the ids of the tool blocks whose turn is running (`runningBlockIds` from
 *  lib/history-state.ts) — the same question the mark in the history asks with `live`. Without it no
 *  turn runs (fallback for callers that need only task and report). */
export function agentsList<C>(live: LiveAgent[], blocks: AgentBlock<C>[], running?: ReadonlySet<string>): Agent<C>[] {
  const turnRunning = (bl?: AgentBlock<C>) => Boolean(bl?.id && running?.has(bl.id));
  const open = [...(live ?? [])];
  const toLive = new Map<LiveAgent, AgentBlock<C>>();
  const onlyBlock: AgentBlock<C>[] = [];

  for (const bl of blocks ?? []) {
    const rep = parseReport(bl.result);
    const key = new Set([bl.id, rep?.agentId].filter((x): x is string => Boolean(x)));
    const hits = key.size
      ? open.find((a) => !toLive.has(a) && idsLive(a).some((id) => key.has(id)))
      : undefined;
    if (hits) toLive.set(hits, bl);
    else onlyBlock.push(bl);
  }

  const fromLive = open.map((a) => {
    const bl = toLive.get(a);
    const rep = parseReport(bl?.result);
    // The report exists only once the agent is finished — a running one delivers only its
    // progress message ("status: running"). Only a real report is shown.
    const finished = rep?.status && rep.status !== "running";
    return {
      id: bl?.id || idsLive(a)[0] || "",
      agentId: a.agentId || a.taskId || "",
      job: a.description || a.name || jobFromBlock(bl),
      model: modelText(text(a.provider), text(a.model)),
      provider: text(a.provider),
      status: "running" as AgentStatus,
      live: true,
      rawStatus: a.status || "running",
      startedAt: a.startedAt,
      // The run time of a running agent ticks — computed in the view from startedAt.
      durationMs: undefined,
      tokens: typeof a.tokens === "number" ? a.tokens : undefined,
      tokenKind: a.tokenKind,
      tools: typeof a.toolUses === "number" ? a.toolUses : undefined,
      parkedUntil: a.status === "parked" && typeof a.parkedUntil === "number" && a.parkedUntil > 0 ? a.parkedUntil : undefined,
      ...(a.waitingForCpu === true ? { waitingForCpu: true } : {}),
      steps: bl?.children ?? [],
      report: finished ? text(rep?.report) || undefined : undefined,
      withoutResult: false,
      ...(a.foreground === true ? { foreground: true } : {}),
      // The stream leads it: that is the first rule of the chain (`inStream: true` ⇒ "running").
      state: agentState({
        error: bl?.resultIsError === true, rawStatus: text(rep?.status), done: bl?.done === true,
        inStream: true, turnRunning: turnRunning(bl),
      }),
    };
  });

  const fromBlocks = onlyBlock.map((bl) => {
    const rep = parseReport(bl.result);
    const raw = text(rep?.status);
    // Without a report and without a live entry the agent is neither finished nor running: its run
    // is over, a result never came. That is a state of its own — "finished" would be a lie.
    const withoutResult = !raw || raw === "running";
    const status: AgentStatus = withoutResult || bl.resultIsError || (raw && raw !== "completed") ? "error" : "finished";
    return {
      id: bl.id || text(rep?.agentId) || "",
      agentId: text(rep?.agentId),
      job: text(rep?.description) || jobFromBlock(bl),
      model: modelText(text(rep?.provider), text(rep?.resolvedModel)),
      provider: text(rep?.provider),
      status,
      live: false,
      rawStatus: raw,
      startedAt: undefined,
      durationMs: typeof rep?.totalDurationMs === "number" ? rep.totalDurationMs : undefined,
      tokens: typeof rep?.totalTokens === "number" ? rep.totalTokens : undefined,
      // From the report (agent-runtime.js writes `tokenKind` next to `totalTokens`) — as with the running agent.
      // A report WITHOUT the field (old data) stays `undefined` = unknown — not "full": nobody measured it
      // there (`tokenKindFromReport`).
      tokenKind: tokenKindFromReport(rep),
      tools: typeof rep?.totalToolUseCount === "number" ? rep.totalToolUseCount : undefined,
      steps: bl.children ?? [],
      report: text(rep?.report) || text(rep?.error) || undefined,
      withoutResult,
      // The list is known and it is not in the stream: `inStream: false`. A background agent whose
      // call stands `done` with "running" then reads "without result" — the stream would have led it
      // if it still ran (rule 1).
      state: agentState({
        error: bl.resultIsError === true, rawStatus: raw, done: bl.done === true,
        inStream: false, turnRunning: turnRunning(bl),
      }),
    };
  });

  return [...fromLive, ...fromBlocks];
}

// ── The background state of a conversation ───────────────────────────────────────
// Pure, so the gate can test the transitions: the hook useBackground (components/chat/chatBackground.ts) holds
// EXACTLY this state and advances it with `backgroundAfter`. A background agent survives its turn —
// `run_started` and `run_done` therefore clear only the FOREGROUND (wait phase, commands); monitors and wakeups
// belong to the chat, not the turn, and so do the agents, which stay until the server reports their end (a
// `background` without them). An abort or error clears everything; if an agent survives there, the server
// reports it once more after the turn (runs/do-run.js).

/** A background command or monitor as the server reports it (`waitingState()` in runs/do-run.js). A monitor carries
 *  more (server runs/monitors.js `liveMonitors`): report kind, start, command or WebSocket and the path of its
 *  log file in the output location. */
export type BackgroundItem = {
  taskId?: string; description?: string;
  report?: "rows" | "end" | string; startedAt?: number; kind?: string; command?: string; ws?: string; logPath?: string;
  timeoutMs?: number; persistent?: boolean;
};

export type BackgroundStatus = {
  waiting: boolean;
  monitors: BackgroundItem[];
  agents: LiveAgent[];
  tasks: BackgroundItem[];
  wakeupAt: number;
  wakeup: { reason: string; prompt: string };
};

export const BACKGROUND_EMPTY: BackgroundStatus = Object.freeze({
  waiting: false, monitors: [], agents: [], tasks: [], wakeupAt: 0, wakeup: Object.freeze({ reason: "", prompt: "" }),
}) as BackgroundStatus;

/** The harness kinds that change the state — all others leave it alone (same identity). */
export const BACKGROUND_KINDS: ReadonlySet<string> = new Set([
  "connected", "run_started", "run_done", "run_aborted", "run_error", "run_waiting", "run_busy", "background",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Event = Record<string, any>;

// The situation as an event reports it — `connected`, `run_waiting` and `background` carry the same five fields.
const situationFrom = (evt: Event) => ({
  monitors: Array.isArray(evt.monitors) ? evt.monitors : [],
  agents: Array.isArray(evt.agents) ? evt.agents : [],
  tasks: Array.isArray(evt.tasks) ? evt.tasks : [],
  wakeupAt: typeof evt.wakeupAt === "number" ? evt.wakeupAt : 0,
  wakeup: { reason: String(evt.wakeupReason || ""), prompt: String(evt.wakeupPrompt || "") },
});

/** The state after an event. Unknown events return the state itself (React then bails out). */
export function backgroundAfter(s: BackgroundStatus, evt: Event): BackgroundStatus {
  if (evt?.type !== "harness" || !BACKGROUND_KINDS.has(evt.subtype)) return s;
  switch (evt.subtype) {
    // Whoever joins in the middle of a run — or after it, with live background agents — gets the situation in `connected`.
    case "connected": return { ...situationFrom(evt), waiting: Boolean(evt.waiting) };
    // The foreground belongs to the turn; the agents stay (see above) — and so do the monitors and the wakeup:
    // they belong to the CHAT (server runs/monitors.js, runs/wakeup.js) and survive every outcome of the turn,
    // abort and error included. Their end is reported by a `background` without them (the wakeup: `wakeupAt` 0).
    case "run_started":
    case "run_done": return { ...BACKGROUND_EMPTY, agents: s.agents, monitors: s.monitors, wakeupAt: s.wakeupAt, wakeup: s.wakeup };
    case "run_aborted":
    case "run_error": return s.monitors.length || s.wakeupAt ? { ...BACKGROUND_EMPTY, monitors: s.monitors, wakeupAt: s.wakeupAt, wakeup: s.wakeup } : BACKGROUND_EMPTY;
    // Main agent idle (monitor, background agent, background command or wakeup open): messages are injected.
    case "run_waiting": return { ...situationFrom(evt), waiting: true };
    case "run_busy": return s.waiting ? { ...s, waiting: false } : s;
    // Running background work, independent of the wait state — also without a turn (core of a past turn).
    case "background": return { ...situationFrom(evt), waiting: s.waiting };
    default: return s;
  }
}

/** "waits until 14:05" — the time at which a parked agent continues, in the device's local time (24 h). */
export function waitingUntilText(parkedUntil: number, t: Translator): string {
  const d = new Date(parkedUntil);
  const two = (n: number) => String(n).padStart(2, "0");
  return t("waiting until {time}", { time: `${two(d.getHours())}:${two(d.getMinutes())}` });
}

// ── The states as a map for the history ──────────────────────────────────────────
// The mark in the history reads its agent's state from a map block id → state instead of computing it
// itself. The map arises from the list above; its IDENTITY may only jump when a state really changes —
// the agent tick reports new tokens every 2 s, and every new map would otherwise redraw every memoised
// history row. Hence the content key alongside: the caller memoises the map by it.

/** Block id → state (`null` = finished). Entries without an id are missing — the mark then has no
 *  key under which it could look up. */
export function stateCard(agents: ReadonlyArray<{ id: string; state: AgentState | null }>): ReadonlyMap<string, AgentState | null> {
  const card = new Map<string, AgentState | null>();
  for (const a of agents) if (a.id) card.set(a.id, a.state);
  return card;
}

/** The content of the map as a string — `id:identifier` per agent, finished as "finished". Same
 *  key ⇒ same map. */
export function stateKey(agents: ReadonlyArray<{ id: string; state: AgentState | null }>): string {
  return agents.filter((a) => a.id).map((a) => `${a.id}:${a.state?.identifier ?? "finished"}`).join("|");
}

/** The part of the map that ONE history row reads: the states of its own tool blocks (top level —
 *  subagent calls stand there). A row compares its old and new map with it: only when ITS part
 *  changes does it redraw. Blocks the map does not know (discarded bubbles, ordinary tools)
 *  contribute nothing — for them every map is equal. */
export function bubblesKey(
  blocks: ReadonlyArray<{ kind: string; id?: string }>,
  card: ReadonlyMap<string, AgentState | null> | undefined,
): string {
  if (!card) return "";
  let s = "";
  for (const bl of blocks) {
    if (bl.kind !== "tool" || !bl.id || !card.has(bl.id)) continue;
    s += `${bl.id}:${card.get(bl.id)?.identifier ?? "finished"}|`;
  }
  return s;
}

/** The task as it stood in the tool call — the fallback when no report exists. */
function jobFromBlock(bl?: AgentBlock<unknown>): string {
  const inp = bl?.input ?? {};
  return text(inp.description) || text(inp.prompt).slice(0, 120) || text(bl?.name);
}

// ── Display helpers ──────────────────────────────────────────────────────────────
// elapsed/fmtTokens live here because the agent list writes the same numbers as the pill; the pill
// imports them from here.

/** Run time long: "12 s", "4 m 05 s", "1 h 12 m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} m`;
}

/** Run time short for the list: m:ss, from one hour h:mm:ss. */
export function durationShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}:${two(s % 60)}`;
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** Token count short: 940, "1.2k", "48k", "1M", "1.3M". From 999,500 in millions — otherwise "1000k" would
 *  show there. */
export function fmtTokens(n: number): string {
  if (n >= 999_500) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "").replace(".", ",")}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(".", ",")}k` : String(n);
}

type Translator = (k: string, p?: Record<string, string | number>) => string;

/** Does the number carry the mark "at least"? For every kind except "full": for the lower bound ("only_output") AND for
 *  an unknown kind (old data without `tokenKind`) — nobody measured there whether it is complete, and
 *  "at least that many" holds for every counted number. The ONE rule for word and sign; iOS computes it in
 *  `ChatViewModel.tokenLowerLimit` (binding `web/test/token-kind-binding.test.mjs`). */
export function tokenLowerLimit(kind: TokenKind | undefined): boolean {
  return kind !== "full";
}

/** The number with its origin: if it is not reported as complete, "at least" stands before it. Without
 *  this word an understated number would be indistinguishable from a complete one. */
export function tokenText(n: number | undefined, kind: TokenKind | undefined, t: Translator): string {
  if (typeof n !== "number") return "";
  const count = fmtTokens(n);
  return tokenLowerLimit(kind) ? t("at least {tokens}", { tokens: count }) : count;
}

/** The title (hover) of a token count: the number like `tokenText`, below it — when known — what it consists of. Cache read
 *  comes last and explicitly outside the sum: otherwise the breakdown would look like an arithmetic error. */
export function tokenTitle(n: number | undefined, kind: TokenKind | undefined, parts: TokenParts | undefined, t: Translator): string {
  const header = tokenText(n, kind, t);
  if (!header || !parts) return header;
  return [
    header,
    t("Input: {n}", { n: fmtTokens(parts.input) }),
    t("Cache written: {n}", { n: fmtTokens(parts.cacheWrite) }),
    t("Output: {n}", { n: fmtTokens(parts.output) }),
    t("Cache read: {n} (not counted)", { n: fmtTokens(parts.cacheRead) }),
  ].join("\n");
}

/** The same statement for a COLUMN: "≥" instead of "at least ", so the digits of the rows stay
 *  flush one below the other. "at least 46.7k" is twice as wide as "46.7k" — in a 50 px narrow
 *  column that would shift every second number depending on the provider.
 *
 *  The sign does NOT replace the word, it stands in for it: where there is room for a sentence (the
 *  report header of the bar, the agent page on the iPhone), "at least …" still stands. */
export function tokenShort(n: number | undefined, kind: TokenKind | undefined): string {
  if (typeof n !== "number") return "";
  return tokenLowerLimit(kind) ? `≥${fmtTokens(n)}` : fmtTokens(n);
}

// ── Pace of a running agent ──────────────────────────────────────────────────────
// Computed from two measuring points and smoothed over a sliding window. With too few measuring
// points the pace stays EMPTY instead of lying: from two values 0.4 s apart any number per minute
// could be extrapolated.

export type MeasurementPoint = { time: number; tokens: number };

export const TEMPO_WINDOW_MS = 60_000;
/** Shorter than this, the extrapolation to a minute is noise. */
const TEMPO_MIN_SPAN_MS = 8_000;

/** Append a measuring point and trim the window. Pure — the caller holds the list. */
export function appendMeasurementPoint(points: MeasurementPoint[], time: number, tokens: number, windowMs = TEMPO_WINDOW_MS): MeasurementPoint[] {
  const last = points[points.length - 1];
  // The same number at the same time contributes nothing; a step back (new run) starts afresh.
  if (last && tokens < last.tokens) return [{ time, tokens }];
  const all = last && last.time === time ? [...points.slice(0, -1), { time, tokens }] : [...points, { time, tokens }];
  const limit = time - windowMs;
  // Keep the last point BEFORE the limit, otherwise the span shrinks with every cut.
  let start = 0;
  for (let i = 0; i < all.length; i++) if (all[i].time < limit) start = i;
  return all.slice(start);
}

/** Tokens per minute over the window — or null if too little was measured. */
export function tempoProMinute(points: MeasurementPoint[]): number | null {
  if (!points || points.length < 2) return null;
  const a = points[0];
  const b = points[points.length - 1];
  const span = b.time - a.time;
  if (span < TEMPO_MIN_SPAN_MS) return null;
  const delta = b.tokens - a.tokens;
  if (delta < 0) return null;
  return Math.round((delta / span) * 60_000);
}
