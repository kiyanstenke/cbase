"use client";
// The working line at the end of the history ("⬡ 12s · 5k tokens [3 running tasks] Pondering…") and the metric row
// after the run. ONE building block for the coding chat.
//
// - The hexagon sits in a 1-em box at the TEXT EDGE; the size is inherited.
// - The measuring marker sits on the BOX, not on the spinning wrapper (the box is measurable, the rotating rectangle
//   is not); each marker appears exactly once in the web.
// - Whether the display RUNS is decided by `runDisplayVisible` (lib/history-state.ts): in the waiting phase it rests.
//   `waiting` is therefore required.
//
// The line carries the running tasks: [hexagon] "12s · 5k tokens" [pill "3 running tasks"] "Pondering…". Order and
// which parts show is computed by `rowsParts` (lib/running-tasks.ts, bound to iOS): without a running turn but with
// tasks (the waiting phase, or a background agent after the turn) only the RESTING hexagon and the pill show; the pill
// says what is being waited on. Tokens show the OUTPUT in chat format (same number as the metric row below); input and
// output together are in the title of the time.
//
// The edge: the hexagon of `CbIcon` has circumradius 9.5 on the 24 grid; its ink starts 0.1125 em inside the box, the
// first baseline stroke of a paragraph at about 0.09 em, so the hexagon sat 0.35-0.5 px right of the text.
// `RowsHexIcon` draws the same hexagon on circumradius 10 (the key line of the 24 grid), ink starts at 0.093 em, and the
// hexagon stays centred in the box (it spins without wobble).
//
// The resting hexagon carries the SAME ink as the metric row's (`text-accent/70`): at /55 it looked smaller although
// both measure 21 x 25 px.
//
// The second ticks in the parent (`tickRender`); `Date.now()` is read while rendering here.
//
// Imports only from lib/, chat/ and the kit (cycle guard, web/test/import-cycles.test.mjs).
import { useT } from "@/lib/i18n";
import { clockTime, fmtDur } from "@/lib/chat-format";
import { runDisplayVisible } from "@/lib/history-state";
import { rowsParts, type RunningTasks, type TaskItem } from "@/lib/running-tasks";
import { fmtTokens, verbFor } from "@/components/chat/ChatCatalog";
import { TasksPill } from "@/components/chat/TasksPill";
import type { RunSummary } from "@/components/chat/chatBubbles";

// The row's hexagon: corners on circumradius 10 around (12, 12). Stroke 2.2 like `CbIcon`.
const RowsHexIcon = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden>
    <path d="M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z" />
  </svg>
);

export function RunDisplay(p: {
  word: string;
  startedAt: number | null;
  inTokens: number;
  outTokens: number;
  busy: boolean;
  streamingText: boolean;
  waiting: boolean;
  /** The chat's running tasks (chatTasks.ts). */
  tasks?: RunningTasks | null;
  /** The chat for the stop paths in the pill's sheet. */
  chatId?: string | null;
  /** "Open" of a subagent or workflow, only where the conversation has an agent bar. */
  onTaskOpen?: (p: TaskItem) => void;
}) {
  const t = useT();
  const running = runDisplayVisible(p);
  const parts = rowsParts({ running, time: p.startedAt !== null, tasks: p.tasks?.item.length ?? 0 });
  if (parts.length === 0) return null;
  return (
    // Wrap instead of overflow (at 390 px the line ran 40 px past the column). The min height 1lh keeps both forms equally
    // tall; resting (hexagon + pill) was 3.7 px lower, so every switch between turn and waiting phase made the history jump.
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5" style={{ minHeight: "1lh" }} data-run-display data-run-running={running ? "1" : "0"}>
      {parts.map((part) => {
        if (part === "hex") {
          return (
            <span key={part} className={`inline-flex size-[1em] shrink-0 ${running ? "text-accent" : "text-accent/70"}`} data-run-hex data-run-part="hex">
              <span className={running ? "inline-flex animate-[spin_2.6s_linear_infinite] motion-reduce:animate-none" : "inline-flex"}><RowsHexIcon /></span>
            </span>
          );
        }
        if (part === "time") {
          return (
            <span key={part} className="whitespace-nowrap tabular-nums text-dim" data-run-part="time"
              title={`↑ ${fmtTokens(p.inTokens)} · ↓ ${fmtTokens(p.outTokens)} ${t("tokens")}`}>
              {fmtDur(Math.round((Date.now() - (p.startedAt ?? Date.now())) / 1000))} · {fmtTokens(p.outTokens)} {t("tokens")}
            </span>
          );
        }
        if (part === "pill") {
          return (
            <span key={part} className="inline-flex" data-run-part="pill">
              <TasksPill tasks={p.tasks!} chatId={p.chatId ?? null} onOpen={p.onTaskOpen} />
            </span>
          );
        }
        return (
          <span key={part} className="animate-pulse font-medium text-accent motion-reduce:animate-none" data-run-part="word">{t(p.word)}…</span>
        );
      })}
    </div>
  );
}

// The clock time after the metrics, always just "21:03": the day separator above the first row of the day names the day
// (chat/DaySeparator.tsx). Twin: iOS `locEndTime`.
const endText = (at: number) => clockTime(at);

// Duration and tokens of a reply, below it and BEFORE the action icons.
export function MetricRow({ summary: s }: { summary: RunSummary }) {
  const t = useT();
  const dur = fmtDur(s.secs);
  return (
    <div className="mt-1 flex items-center gap-1.5 text-dim" data-metric-row>
      <span className="inline-flex size-[1em] shrink-0 text-accent/70" data-metric-hex><RowsHexIcon /></span>
      <span>
        {s.aborted ? t("Aborted after {dur}", { dur }) : t("{verb} for {dur}", { verb: t(verbFor(s)), dur })}
        {s.inTok > 0 && <> · ↑ {fmtTokens(s.inTok)}</>} · ↓ {fmtTokens(s.outTok)} {t("tokens")}
        {Number(s.at) > 0 && <span data-metric-time> · {endText(Number(s.at))}</span>}
      </span>
    </div>
  );
}
