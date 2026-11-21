// The states of the history rows as ONE calculation — without React and without a single import. A leaf module because three
// histories (coding, agent dock), the right agent bar and the gate need the same answer: `web/test/history-without-points.test.mjs`
// transpiles the file with tsc and runs the matrix, and `web/test/history-binding.test.mjs` runs the SAME matrix through the iOS
// revision (mobile/CbaseMobile/Chat/HistoryState.swift) and demands the same answer line by line.
//
// Why a leaf module and not the components: four chains used to calculate the state of a subagent, each differently (marker in the
// history, bar, iOS marker, iOS sheet), and they contradicted each other at measured places — a background agent in an older bubble
// read "no result" at the marker and "running" in the bar next to it. As long as the row carried a dot, this hardly showed; with words
// instead of dots it would stand there.
//
// The words are also the i18n keys (i18n-de.ts, mobile LocDE*.swift). The table therefore carries the WORD, not the translation;
// translation happens at the place of display.

/** The states a subagent row names. Finished has NO identifier — it carries no word. */
export type AgentIdentifier = "running" | "stopped" | "error" | "without-result" | "waiting" | "skipped";
export type AgentTone = "accent" | "dim" | "danger";
export type AgentState = { identifier: AgentIdentifier; word: string; tone: AgentTone; pulses: boolean };

/** The ONE table identifier → word/tone. Identical in wording to `HistoryState.agentStates` (iOS);
 *  `history-without-points.test.mjs` reads both tables as text and compares them. */
export const AGENT_STATES: Readonly<Record<AgentIdentifier, AgentState>> = Object.freeze({
  running: Object.freeze({ identifier: "running", word: "running", tone: "accent", pulses: true }),
  stopped: Object.freeze({ identifier: "stopped", word: "stopped", tone: "dim", pulses: false }),
  error: Object.freeze({ identifier: "error", word: "Error", tone: "danger", pulses: false }),
  "without-result": Object.freeze({ identifier: "without-result", word: "no result", tone: "dim", pulses: false }),
  // Progress tree of the dynamic workflows: a workflow agent without a free slot (cap, stagger, usage limit) and a skipped one.
  // "skipped" is a DISPLAY state of its own — in the journal skipping still counts as failed.
  waiting: Object.freeze({ identifier: "waiting", word: "waiting", tone: "dim", pulses: false }),
  skipped: Object.freeze({ identifier: "skipped", word: "skipped", tone: "dim", pulses: false }),
} as const);

/** Tone → text class. Stands here (and nowhere else) so that a component never translates the tone of a state itself — otherwise the
 *  mapping would exist twice again. The classes stand as literals because Tailwind only generates classes it finds in the source. */
export const TONE_CLASS: Readonly<Record<AgentTone, string>> = Object.freeze({
  accent: "text-accent",
  dim: "text-dim",
  danger: "text-danger",
});

type ToolStatus = { done?: boolean; resultIsError?: boolean };

/** Is this tool call running? Only in a RUNNING turn and only as long as no result is there. `resultIsError` is included although
 *  `applyToolResult` also sets `done` on an error: the condition should not depend on that staying so. Without `live`, a call without
 *  a result in an ended run (stop, restart) would spin until reload. */
export function toolRunning(b: ToolStatus, live: boolean): boolean {
  return live && !b.done && !b.resultIsError;
}

/** Is a collective row running? Exactly when one of its calls runs. An empty group never runs. */
export function groupRunning(bs: ReadonlyArray<ToolStatus>, live: boolean): boolean {
  return bs.some((b) => toolRunning(b, live));
}

/** The state of a subagent — the chain, ONCE.
 *
 *  - `inStream`: `true` if the event stream lists the agent as alive; `false` if a list is known and it is not in it; `null` if there
 *    is no list at all (agent dock). Empty is not unknown: `null` is not `false`.
 *  - `turnRunning`: the turn the call stands in is still running.
 *
 *  `null` means finished — a finished subagent carries no word. */
export function agentState(e: {
  error: boolean;
  rawStatus: string;
  done: boolean;
  inStream: boolean | null;
  turnRunning: boolean;
}): AgentState | null {
  // 1. The server says it runs — the first rule of the bar, and it trumps every derivation.
  if (e.inStream === true) return AGENT_STATES.running;
  // 2. Error before everything else the report says.
  if (e.error || e.rawStatus === "failed") return AGENT_STATES.error;
  // 3. A stopped one has a result and no error — without the word it would look finished.
  if (e.rawStatus === "stopped") return AGENT_STATES.stopped;
  // 4. The background agent: its call is `done` (it returns immediately with "running"), the agent itself keeps working. Only
  //    without a list (`null`) may the running turn claim that; with a list the stream has already answered (rule 1), and it does not
  //    list it.
  if (e.rawStatus === "running") {
    return e.inStream === null && e.turnRunning ? AGENT_STATES.running : AGENT_STATES["without-result"];
  }
  // 5. Finished — no word.
  if (e.done) return null;
  // 6. Foreground call without a result in a running turn (also the CLI's native `Task`, which the stream does not list).
  if (e.turnRunning) return AGENT_STATES.running;
  // 7. The run is over, a result never came.
  return AGENT_STATES["without-result"];
}

/** The state of a WORKFLOW agent — the second input of the chain next to block, report, stream and turn. From the journal the server
 *  calculates ONE state word per agent() call (dynworkflows/tree.js `agentState`: "running", "waiting", "finished", "error",
 *  "skipped", "stopped", "without-result"); here the word is derived from it. `null` means finished (no word). An UNKNOWN state (a
 *  newer server) is neither finished nor "off": it stands with its own name, muted — like `HistoryState.state` on iOS (empty is not
 *  unknown). */
export function journalAgentState(state: string): AgentState | null {
  if (state === "finished") return null;
  const z = (AGENT_STATES as Readonly<Record<string, AgentState>>)[state];
  return z ?? { identifier: state as AgentIdentifier, word: state, tone: "dim", pulses: false };
}

/** Is the activity indicator ("Tinkering… (1m 04s · ↓ 3k tokens)") shown? Only in thinking and tool phases: while answer text
 *  streams in, it is off, and in the WAITING phase it rests — what is waited for is told there by the pill of the running tasks
 *  (chat/TasksPill.tsx). iOS has no `streamingText` parameter (the row stays there); the binding compares only the common part. */
export function runDisplayVisible(s: { busy: boolean; streamingText: boolean; waiting: boolean }): boolean {
  return s.busy && !s.streamingText && !s.waiting;
}

/** The class of the light effect of a running row — the ONLY place outside globals.css where its name stands. Empty if the row is
 *  not running. */
export function shimmerClass(running: boolean): string {
  return running ? "cb-shimmer" : "";
}

/** How far the veil of the base (`cb-kit-veil-bottom`) extends BEYOND its measured height — and thus how much the history keeps free
 *  at the bottom in addition to `dockH`. Keeping only 8 px free was too little: the bottom row (the activity indicator, scrolled all the
 *  way down) lay in the fade of the veil and looked cut off. ONE number for veil and padding, in the coding chat. */
export const BASE_VEIL_PX = 32;

/** Index of the last response bubble, −1 without one. Replaces identical loops, each with the same task: which bubble belongs to the
 *  running turn? */
export function lastResponseIdx(bubbles: ReadonlyArray<{ role: string }>): number {
  for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].role === "assistant") return i;
  return -1;
}

/** The ids of the tool blocks whose turn is running — exactly the bubbles the history gives `live` (`streaming` or the last response
 *  while `busy`). The agent bar thereby asks the same question as the marker in the history (`turnRunning`) instead of one of its own. */
export function runningBlockIds(
  bubbles: ReadonlyArray<{ role: string; streaming?: boolean; blocks: ReadonlyArray<{ kind: string; id?: string }> }>,
  busy: boolean,
): ReadonlySet<string> {
  const last = lastResponseIdx(bubbles);
  const ids = new Set<string>();
  bubbles.forEach((b, i) => {
    if (!(b.streaming === true || (busy && i === last))) return;
    for (const bl of b.blocks) if (bl.kind === "tool" && bl.id) ids.add(bl.id);
  });
  return ids;
}
