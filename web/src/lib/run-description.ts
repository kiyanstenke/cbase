// What a running chat looks like in words: phase (word, color, status dot) and the chain of short details behind it
// ("Step 3/7 · Review · 2 agents · wakes at 14:32"). Both live here because the "Active Runs" pill (components/pills/ActiveRunsPill.tsx,
// RunRow) and the chat list's tooltip (components/chat/ChatTooltip.tsx) read the same sentence; two versions would be two places for the
// same answer.
import type { ActiveRun } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { isGateWaitRow } from "@/lib/credit";
import { fmtTokens } from "@/lib/agents";

type Translator = (key: string, params?: Record<string, string | number>) => string;

export type RunPhase = { label: string; text: string; point: string; pulse: boolean };

// Per phase: word, text color and the status dot. `puls`: the dot breathes (running or needs me); a run at a limit does not compute and
// stands still.
export const RUN_PHASES: Record<string, RunPhase> = {
  running: { label: "running", text: "text-accent", point: "bg-accent", pulse: true },
  waiting: { label: "waiting", text: "text-warn", point: "bg-warn", pulse: false },
  ask: { label: "question open", text: "text-warn", point: "bg-warn", pulse: true },
  // The server reports only running · waiting · ask · limit.
  // Parked at the usage limit: does not compute, but comes back by itself.
  limit: { label: "waiting for limit reset", text: "text-dim", point: "bg-fg/30", pulse: false },
};

// `clock` depends on dateLocale() from i18n.ts; lib/agents.ts must stay import-free (web/test/agents.test.mjs compiles the file alone
// with tsc), so the time lives here and not there.
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

/** The phase of a run. At the round cap or with a requested review the run does not wait for a question node; the mark must say WHAT
 *  it waits for, otherwise one looks for the question in the graph. */
export function runPhase(run: ActiveRun): RunPhase {
  return run.workflow?.pending === "cap"
    ? { ...RUN_PHASES.ask, label: "Round cap" }
    : run.workflow?.pending === "review"
      ? { ...RUN_PHASES.ask, label: "review open" }
      : RUN_PHASES[run.phase] ?? RUN_PHASES.running;
}

/** What the run is doing right now, as a chain of short details; the waiting reason ("monitor open", "wakes at 14:32") is the real
 *  answer when one looks. `context: false` omits the context fill (the chat list's tooltip does not show it). */
export function runDetails(run: ActiveRun, t: Translator, { context = true }: { context?: boolean } = {}): string[] {
  const bg = run.background;
  const bits: string[] = [];
  if (run.workflow) {
    const w = run.workflow;
    // Existing keys ("Step {step}/{total}" is already in the chat progress strip).
    bits.push(w.total ? t("Step {step}/{total}", { step: w.step, total: w.total }) : t("Step {pos}", { pos: w.step }));
    if (w.nodeTitle) bits.push(w.nodeTitle);
  }
  // A dynamic workflow: its own kind, its state instead of a graph step.
  if (run.dynWorkflow) {
    const d = run.dynWorkflow;
    if (d.phase) bits.push(t("Phase {name}", { name: d.phase }));
    bits.push(t("{done}/{total} agents done", { done: d.finished, total: d.agents }));
  }
  if (run.phase === "ask" && run.question) bits.push(run.question);
  if (run.limit) {
    bits.push(run.limit.limitText);
    // At the credit gate nothing has failed: the START is intercepted, and the button in the chat is the second way besides the reset.
    // The row used to say only "Continues {time}", the same line as at the time limit, and nothing pointed to the gate. A mark instead
    // of a text comparison, as everywhere (lib/credit.ts).
    bits.push(isGateWaitRow(run.limit)
      ? `${t("Credit gate")} — ${t("continues at {time} or when released", { time: clockTime(run.limit.dueAt) })}`
      : run.limit.reason === "probe"
        ? t("Reset time unknown — checking")
        : run.limit.kind === "compact"
          ? t("Compacting {time}", { time: clockTime(run.limit.dueAt) })
          : t("Continues {time}", { time: clockTime(run.limit.dueAt) }));
    if (run.limit.attempts) bits.push(t("Attempt {n}", { n: run.limit.attempts + 1 }));
  }
  if (bg.agents) bits.push(bg.agents === 1 ? t("1 agent") : t("{n} agents", { n: bg.agents }));
  if (bg.monitors) bits.push(bg.monitors === 1 ? t("monitor open") : t("{n} monitors open", { n: bg.monitors }));
  if (bg.tasks) bits.push(t("{n} in the background", { n: bg.tasks }));
  // On a waiting row `wakeupAt` is its `dueAt` (server.js, entry "limit"): otherwise the same time would stand twice in the row
  // ("continues at 23:55 … · wakes at 23:55").
  if (bg.wakeupAt && !run.limit) bits.push(t("wakes at {time}", { time: clockTime(bg.wakeupAt) }));
  if (run.queued) bits.push(t("{n} queued", { n: run.queued }));
  if (context && run.contextTokens) bits.push(t("context {tokens}", { tokens: fmtTokens(run.contextTokens) }));
  return bits;
}
