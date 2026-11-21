// The graph-workflow starts of ONE chat as a pure calculation — without React and without imports, so the gate
// (web/test/graph-runs.test.mjs) can transpile and check it with tsc.
//
// The server delivers ONE run view per start (workflows/graph-start.js graphRunView, via `GET /api/chats/:id/graph-workflows` and the
// event `graph_run` — the same function, so the strip shows after ⌘R what it showed live). From it arises what the strip above the
// input says (`foregroundRow`): that an announced workflow starts as soon as the turn ends, or waits for a lock — with "Cancel" —,
// and that a worktree with changes remained — with "Dismiss". From `running` on, the existing workflow strip of the header (wfRun)
// speaks, not this one.
//
// The client state (`GraphRunsStatus`) knows "not loaded": a chat whose route has not answered yet (or answered with an error) is not
// "without start" (empty is not unknown). Events arriving while the route loads are remembered and laid over its answer — otherwise a
// message between request and answer would be lost (model lib/dyn-tree.ts). The iOS twin (Chat/GraphRuns.swift) is bound
// (web/test/graph-runs-binding.test.mjs: state, row, card, response form and request — both sides executed). The calculation of the card
// of a BACKGROUND run and its response (section at the end) is here too, as is where "Open" leads, the runtime of the card and "still
// open" (`childChatOf`, `graphDurationMs`, `graphOpen`).

/** The event in the chat's stream (harness subtype). */
export const GRAPH_EVENT = "graph_run";

/** The nine states of the run view, in the order of the contract. */
export const GRAPH_STATES = [
  "earmarked", "waiting_lock", "waiting_storage", "running", "waiting", "finished", "failed", "stopped", "dismissed",
] as const;
export type GraphState = (typeof GRAPH_STATES)[number];

/** The display word per state — the values are also the i18n keys (i18n-de.ts). */
export const STATE_WORD: Readonly<Record<GraphState, string>> = Object.freeze({
  earmarked: "Scheduled##earmarked",
  waiting_lock: "Waiting for lock",
  waiting_storage: "Waiting for memory",
  running: "Running",
  waiting: "Waiting for you",
  finished: "Done",
  failed: "Failed",
  stopped: "Stopped",
  dismissed: "Discarded",
});

/** The server's run view. `state` stays `string`: a state this client does not know stands in the list but appears in no strip. */
export type GraphRunView = {
  startId: string;
  background: boolean;
  worktree: boolean;
  worktreePath: string;
  workflowId: string;
  name: string;
  shortName: string;
  /** At most 400 characters — the full text is in the server's row. */
  input: string;
  state: string;
  reason: string;
  /** The chat the run runs in: the child chat in the background, otherwise this one. */
  chatId: string;
  /** The graph run itself (workflows/run-state.js workflowRunView), `null` before the start. Only the fields of the card are read —
   *  the rest of the view stays what the server sends. */
  run: WorkflowRunView | null;
  /** What a waiting run waits for (`null` otherwise). */
  wait: GraphWait | null;
  stoppedOf: string;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
};

/** The fields of the run that the card reads (`{step}/{total}: {nodeTitle}`). */
export type WorkflowRunView = { status?: string; step?: number; total?: number; nodeTitle?: string; [field: string]: unknown };

/** A question of an agent's follow-up question card (runs/ask.js normalizeAskQuestions). */
export type GraphAskQuestion = { header?: string; question?: string; multiSelect?: boolean; options?: { label?: string; description?: string }[] };

/** What is waited for (`waitDetail`): `kind` is question · cap · review · done · stopped · agent_ask · permission ·
 *  dyn_approval; `requestId` for agent_ask, permission, dyn_approval; `questions` for agent_ask; `tool` and `input` (≤ 2,000) for
 *  permission; `dynName`/`dynDescription`/`dynPhases` for dyn_approval. */
export type GraphWait = {
  kind: string;
  question?: string;
  requestId?: string;
  questions?: GraphAskQuestion[];
  tool?: string;
  input?: string;
  dynName?: string;
  dynDescription?: string;
  dynPhases?: unknown;
};

/** `loading`: a request to the route is under way — events then go ALSO into `buffer`. */
export type GraphRunsStatus = {
  loaded: boolean;
  loading: boolean;
  /** Newest first (`startedAt` descending). */
  runs: GraphRunView[];
  buffer: GraphRunView[];
};

export const GRAPH_UNLOADED: GraphRunsStatus = Object.freeze({ loaded: false, loading: false, runs: [], buffer: [] }) as GraphRunsStatus;

const isView = (x: unknown): x is GraphRunView =>
  Boolean(x) && typeof (x as GraphRunView).startId === "string" && (x as GraphRunView).startId !== ""
  && typeof (x as GraphRunView).state === "string";

const afterStart = (a: GraphRunView, b: GraphRunView) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0);

// A view into the list: replaces the one with the same startId, a new start is added; then by `startedAt` descending (stable — equal
// timestamps keep their order).
function place(runs: GraphRunView[], run: GraphRunView): GraphRunView[] {
  const i = runs.findIndex((l) => l.startId === run.startId);
  const fresh = i < 0 ? [run, ...runs] : runs.slice();
  if (i >= 0) fresh[i] = run;
  return fresh.sort(afterStart);
}

/** A request to the route begins (chat switch, reconnect): the shown state stays, events are remembered. */
export function graphLoading(s: GraphRunsStatus): GraphRunsStatus {
  return { ...s, loading: true, buffer: [] };
}

/** The route's answer: its starts, over them every event that came during the request. An answer without a list — and an error
 *  (`response` = null) — changes nothing about being loaded: it is not an empty list. */
export function graphLoaded(s: GraphRunsStatus, response: unknown): GraphRunsStatus {
  const a = response as { runs?: unknown } | null;
  if (!a || !Array.isArray(a.runs)) return { ...s, loading: false, buffer: [] };
  let runs = a.runs.filter(isView).sort(afterStart);
  for (const l of s.buffer) runs = place(runs, l);
  return { loaded: true, loading: false, runs, buffer: [] };
}

/** An event from the stream. Only `graph_run` counts; everything else leaves the state unchanged (same identity). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function graphApply(s: GraphRunsStatus, evt: Record<string, any>): GraphRunsStatus {
  if (evt?.type !== "harness" || evt.subtype !== GRAPH_EVENT || !isView(evt.run)) return s;
  const run = evt.run as GraphRunView;
  return {
    ...s,
    runs: place(s.runs, run),
    buffer: s.loading ? [...s.buffer, run] : s.buffer,
  };
}

/** Does the chat have graph starts? `null` = not yet loaded — NOT "no". */
export function hasGraphRuns(s: GraphRunsStatus): boolean | null {
  if (s.runs.length > 0) return true;
  return s.loaded ? false : null;
}

const TO_END: ReadonlySet<string> = new Set(["finished", "failed", "stopped", "dismissed"]);

/** The row of the strip. `text`/`button` are i18n keys, `params` their placeholders; `action` says what the button does: `abort`
 *  calls the stop (`from: "human"`), `hide` remembers the startId only in memory. */
export type GraphStripRow = {
  startId: string;
  kind: "earmarked" | "waiting_lock" | "worktree";
  text: string;
  params: Record<string, string>;
  button: string;
  action: "abort" | "hide";
};

/** Which row the strip above the input shows — only for FOREGROUND starts (`background: false`):
 *  - `earmarked`: the workflow starts as soon as the turn ends (Cancel);
 *  - `waiting_lock`: it waits for the lock of its project (Cancel), the reason comes from the server;
 *  - ended with `worktreePath`: the worktree with changes remains (Dismiss; `hidden` = the startIds already dismissed).
 *  An open start takes precedence over a worktree notice, otherwise the newest applies. An unknown state, `running` and `waiting`
 *  (shown by the workflow strip of the header) give no row. Without a matching start: `null`. */
export function foregroundRow(s: GraphRunsStatus, hidden: ReadonlySet<string> | readonly string[] = []): GraphStripRow | null {
  const hiddenSet = hidden instanceof Set ? hidden : new Set(hidden as readonly string[]);
  const front = s.runs.filter((l) => l.background !== true);
  const open = front.find((l) => l.state === "earmarked" || l.state === "waiting_lock");
  if (open) {
    const name = open.name || open.shortName;
    if (open.state === "earmarked") {
      return { startId: open.startId, kind: "earmarked", text: "Workflow “{name}” starts when the turn ends", params: { name }, button: "Cancel", action: "abort" };
    }
    // Without a reason from the server a sentence of its own — an empty "is waiting — " would be half a statement.
    return open.reason
      ? { startId: open.startId, kind: "waiting_lock", text: "Workflow “{name}” is waiting — {reason}", params: { name, reason: open.reason }, button: "Cancel", action: "abort" }
      : { startId: open.startId, kind: "waiting_lock", text: "Workflow “{name}” is waiting for a lock", params: { name }, button: "Cancel", action: "abort" };
  }
  const stale = front.find((l) => TO_END.has(l.state) && typeof l.worktreePath === "string" && l.worktreePath !== "" && !hiddenSet.has(l.startId));
  if (stale) {
    return { startId: stale.startId, kind: "worktree", text: "Worktree with changes remains: {path}", params: { path: stale.worktreePath }, button: "Dismiss##hide", action: "hide" };
  }
  return null;
}

// ── Card and response of a background run ───────────────────────────────────────────────────────────────────────────────────────────
// What the card under "Background Tasks" shows and which response it offers — only the calculation here; the iOS twin
// (`GraphRuns.cardOf`/`responseForm`/`responseRequest` in Chat/GraphRuns.swift) is bound in web/test/graph-runs-binding.test.mjs (both
// sides REALLY executed). Responses go through the EXISTING routes on the child chat (`run.chatId`), there is no route of its own:
// question, cap, review, finish and stop via `/message` (workflows/gates.js answerWorkflow interprets the word — "continue"/"more 2"
// hits GO_RE, "finish" STOP_RE, "looks good" OK_RE in workflows.js; web/test/graph-runs.test.mjs reads the patterns from there), an
// agent's follow-up question card via `/ask-answer`, the permission via `/permission-decision`, the approval of a dynamic workflow via
// `/dyn-workflows/approval`. Foreground runs have no card (strip and banner), an unknown wait kind no form (the card then offers only
// "Open").

/** The tone of the card: blue = running, warning = waiting for the human, quiet = not yet started, then the outcomes. */
export type GraphTone = "running" | "waiting" | "quiet" | "finished" | "error" | "muted";
const TONE: Readonly<Record<string, GraphTone>> = Object.freeze({
  running: "running", waiting: "waiting", earmarked: "quiet", waiting_lock: "quiet", waiting_storage: "quiet",
  finished: "finished", failed: "error", stopped: "muted", dismissed: "muted",
});
/** Stoppable is what has not ended yet: earmarked, waiting, running. */
const STOPPABLE: ReadonlySet<string> = new Set(["earmarked", "waiting_lock", "waiting_storage", "waiting", "running"]);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A button of the response form: `id` is the handle (`responseRequest`), `word` the i18n key with `params`, `send` the word the
 *  server receives (`text`, `behavior` or `decision`). */
export type GraphButton = { id: string; word: string; params: Record<string, string>; send: string };
/** A question of the follow-up question card as the form shows it: one button per option, multiple choice by `multiple`. */
export type GraphQuestionForm = { header: string; question: string; multiple: boolean; options: { label: string; description: string }[] };
/** The sub-route on the child chat (`/api/chats/:kind/<route>`). */
export type GraphResponseRoute = "message" | "ask-answer" | "permission-decision" | "dyn-workflows/approval";
/** The form per wait kind. `placeholder` is the i18n key of the free-text field, empty = no free text. `requestId` empty where the
 *  kind carries none. */
export type GraphResponseForm = {
  kind: string;
  route: GraphResponseRoute;
  requestId: string;
  buttons: GraphButton[];
  freeText: boolean;
  placeholder: string;
  questions: GraphQuestionForm[];
};

/** The card. `stateWord` is the i18n key (an unknown state stands raw), `row2` the reason or "{step}/{total}: {nodeTitle}" (without
 *  words — nothing to translate; empty = no row), `worktree` the path (empty = none), `stop`: whether the stop button shows,
 *  `response`: the form (`null` = none, only "Open"). */
export type GraphCard = {
  title: string;
  stateWord: string;
  tone: GraphTone;
  warningDot: boolean;
  row2: string;
  worktree: string;
  stop: boolean;
  response: GraphResponseForm | null;
};

/** The number of the cap button "{n} more" if the human chooses none (`responseRequest` with `n` chooses one). */
export const MORE_DEFAULT = 2;
/** The largest number for "{n} more" — the server caps more anyway (workflows.js capRounds, MAX_VISITS_LIMIT). */
export const MORE_MAX = 99;

const wholeNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : null);
const button = (id: string, word: string, send: string, params: Record<string, string> = {}): GraphButton => ({ id, word, params, send });
const moreButton = (n: number) => button("more", "{n} more", `more ${n}`, { n: String(n) });

/** The background runs of the state — the cards, in the order of the state (newest first). */
export function backgroundRuns(s: GraphRunsStatus): GraphRunView[] {
  return s.runs.filter((l) => l.background === true);
}

function questionsOf(raw: unknown): GraphQuestionForm[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is GraphAskQuestion => Boolean(q) && typeof q === "object").map((q) => ({
    header: typeof q.header === "string" ? q.header : "",
    question: typeof q.question === "string" ? q.question : "",
    multiple: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : [])
      .filter((o) => Boolean(o) && typeof o === "object" && typeof o.label === "string" && o.label !== "")
      .map((o) => ({ label: o.label as string, description: typeof o.description === "string" ? o.description : "" })),
  }));
}

/** The response form of a waiting run — `null` if it does not wait, `wait` is missing, the kind is unknown or a card without
 *  `requestId` (permission, approval) could not be answered. */
export function responseForm(run: GraphRunView): GraphResponseForm | null {
  if (run.state !== "waiting") return null;
  const w = run.wait;
  if (!w || typeof w !== "object" || typeof w.kind !== "string") return null;
  const requestId = typeof w.requestId === "string" ? w.requestId : "";
  const form = (route: GraphResponseRoute, buttons: GraphButton[], placeholder: string, questions: GraphQuestionForm[] = []): GraphResponseForm =>
    ({ kind: w.kind, route, requestId, buttons, freeText: placeholder !== "", placeholder, questions });
  switch (w.kind) {
    case "question": return form("message", [], "Answer …");
    case "cap": return form("message", [button("further", "Continue", "continue"), moreButton(MORE_DEFAULT), button("complete", "Finish", "finish")], "");
    case "review": return form("message", [button("matches", "Looks good", "looks good")], "Remarks …");
    case "done":
    case "stopped": return form("message", [button("further", "Continue", "continue")], "Instruction …");
    case "agent_ask": return form("ask-answer", [], "Own answer …", questionsOf(w.questions));
    case "permission":
      return requestId ? form("permission-decision", [button("allow", "Allow", "allow"), button("reject", "Deny", "deny")], "") : null;
    case "dyn_approval":
      return requestId ? form("dyn-workflows/approval", [button("accept", "Accept", "accept"), button("reject", "Deny", "reject")], "") : null;
    default: return null;
  }
}

/** What the human did in the form: a button (`button` = its `id`, with "more" with chosen number `n`), a free text (`text`), on the
 *  follow-up question card per question the chosen labels (`selection`) and per question a text of its own (`texts` — without it
 *  `text` goes to the first question). */
export type GraphInput = {
  button?: string;
  n?: number;
  text?: string;
  selection?: ReadonlyArray<ReadonlyArray<string>>;
  texts?: ReadonlyArray<string>;
};
/** The request to the server: `POST path` with `body` (JSON). The path is encoded (fetch); iOS does NOT pre-encode
 *  (`APIClient.makeURL` encodes itself). */
export type GraphRequest = { path: string; body: Record<string, unknown> };

/** The request for an input — `null` if there is nothing to send: no form, no child chat, a foreign button, an empty free text (or on
 *  the follow-up question neither selection nor text) or a free text where the form has none. A button takes precedence over a text.
 *  A selection that is not an option drops; without multiple choice the first counts. */
export function responseRequest(run: GraphRunView, input: GraphInput): GraphRequest | null {
  const f = responseForm(run);
  if (!f || typeof run.chatId !== "string" || run.chatId === "") return null;
  const path = `/api/chats/${encodeURIComponent(run.chatId)}/${f.route}`;
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (f.route === "ask-answer") {
    const answers = f.questions.length
      ? f.questions.map((q, i) => {
        const labels = new Set(q.options.map((o) => o.label));
        const selected: string[] = [];
        for (const l of input.selection?.[i] ?? []) if (labels.has(l) && !selected.includes(l)) selected.push(l);
        const ownText = input.texts?.[i];
        return { selected: q.multiple ? selected : selected.slice(0, 1), text: typeof ownText === "string" ? ownText.trim() : i === 0 ? text : "" };
      })
      // Without questions (a sparse view): the free text as the first answer (edge case).
      : [{ selected: [] as string[], text }];
    if (!answers.some((a) => a.selected.length > 0 || a.text !== "")) return null;
    return { path, body: { requestId: f.requestId, answers } };
  }
  if (typeof input.button === "string" && input.button !== "") {
    const k = f.buttons.find((x) => x.id === input.button);
    if (!k) return null;
    const n = wholeNumber(input.n);
    const send = k.id === "more" && n !== null ? `more ${Math.min(n, MORE_MAX)}` : k.send;
    if (f.route === "permission-decision") return { path, body: { requestId: f.requestId, behavior: send } };
    if (f.route === "dyn-workflows/approval") return { path, body: { requestId: f.requestId, decision: send } };
    return { path, body: { text: send } };
  }
  if (!f.freeText || text === "") return null;
  return { path, body: { text } };
}

function row2Of(runItem: GraphRunView): string {
  if (typeof runItem.reason === "string" && runItem.reason !== "") return runItem.reason;
  const run = runItem.run && typeof runItem.run === "object" ? runItem.run : null;
  if (!run) return "";
  const step = wholeNumber(run.step);
  const total = wholeNumber(run.total);
  const title = typeof run.nodeTitle === "string" ? run.nodeTitle : "";
  const count = step === null ? "" : total === null ? String(step) : `${step}/${total}`;
  if (count && title) return `${count}: ${title}`;
  return count || title;
}

/** The card of a run — `null` for a foreground run (it has strip and banner, no card). */
export function cardOf(run: GraphRunView): GraphCard | null {
  if (run.background !== true) return null;
  const z = typeof run.state === "string" ? run.state : "";
  return {
    title: run.name || run.shortName || "",
    stateWord: own(STATE_WORD, z) ? STATE_WORD[z as GraphState] : z,
    tone: own(TONE, z) ? TONE[z] : "muted",
    warningDot: z === "waiting",
    row2: row2Of(run),
    worktree: typeof run.worktreePath === "string" ? run.worktreePath : "",
    stop: STOPPABLE.has(z),
    response: responseForm(run),
  };
}

// ── The card in "Background Tasks" ────────────────────────────────────────────────────────────────────────────────────────────────────
// Three small calculations of the web card (chat/GraphRunCard.tsx) and the bar (AgentBar.tsx), here instead of in the component
// so the gate checks them (web/test/graph-runs.test.mjs): where "Open" leads, how long the run has been going and whether it is still
// open.

/** The child chat that "Open" shows — empty if there is none. The view carries the child chat as `chatId`, and where it is missing
 *  (deleted by hand: `child_chat_id` NULL, or stopped before the start), the chat of the start itself (workflows/graph-start.js
 *  graphRunView) — that one is already open, "Open" would be a button without effect. A foreground run has no card and thus no target. */
export function childChatOf(run: GraphRunView, orchestratorId: string | null): string {
  if (run.background !== true) return "";
  const c = typeof run.chatId === "string" ? run.chatId : "";
  return c !== "" && c !== orchestratorId ? c : "";
}

/** The runtime of the card in ms — `null` if none is known. Measured from the start of the graph run (`run.startedAt`), without it
 *  from the row (`startedAt`: a waiting start counts — the card is already there); until `endedAt`, otherwise until `now` (the
 *  per-second tick of the bar). Never negative. */
export function graphDurationMs(runItem: GraphRunView, now: number): number | null {
  const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const run = runItem.run && typeof runItem.run === "object" ? runItem.run : null;
  const begin = ms(run?.startedAt) ?? ms(runItem.startedAt);
  if (begin === null) return null;
  const end = ms(runItem.endedAt) ?? now;
  return Math.max(0, end - begin);
}

/** Is the run still open (the card stands under "Running", its clock ticks)? Everything that has not ended yet — the same set for
 *  which the card shows its stop (earmarked, waiting, running). */
export function graphOpen(run: GraphRunView): boolean {
  return STOPPABLE.has(typeof run.state === "string" ? run.state : "");
}
