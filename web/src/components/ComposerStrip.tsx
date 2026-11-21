"use client";

// The docked strip base above the input field: ONE source for the coding chat. Modelled on the Codex app; the glass
// form is in globals.css under "Docked strip".
//
// The base is ONE element: the container carries the glass (border, rounding, surface); the parts inside are bare rows
// separated by hairlines, like every list in the app. The mechanics: one slot per part that grows to its height, and
// `useExit` for leaving.
//
// What lives here and what does NOT: the running compaction (FIRST row, `compressed`), the set goal (in the form of the
// ChatGPT app: icon, "Pursuing goal", text, runtime, on the right trash, pause, expand), the earmarked start of a graph
// workflow ("starts when the turn ends" / "waits for a lock" with cancel, the leftover worktree with dismiss; coding chat
// only, the row is computed by lib/graph-runs.ts) and the queued messages. What runs next to the main agent shows as the
// pill "N running tasks" in the work row at the end of the history (chat/RunDisplay.tsx, chat/TasksPill.tsx). The agent's
// task list deliberately stays where it is: it is multi-line and has a form of its own.
//
// The measure of all rows (set against the ChatGPT screenshot: 14 px row to 15 px field): font 1 px below the input
// field (14.5 to 15.5 px in chat/ChatComposer.tsx; whoever changes the field updates `ROW`), a row is about 34 px above
// the field, icons 14 px in a slot of equal width, icon buttons 24 px with 28 px centre distance.

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { queueEntry } from "@/lib/completionNotice";
import { fmtDur } from "@/lib/chat-format";

export interface StripQueue {
  id: string;
  text: string;
  /** Only user messages can be steered; see publicPendingInputs on the server. */
  controllable?: boolean;
  /** The queued completion notice of a subagent: name and state instead of XML, no trash button. */
  systemNotice?: boolean;
}

const svg = (children: React.ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const ClockIcon = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
const ControlIcon = () => svg(<><path d="M4 7h9a4 4 0 0 1 4 4v6" /><path d="m14 14 3 3 3-3" /></>);
const TrashIcon = () => svg(<><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6.5 7 7 20h10l.5-13" /></>);
const AgentIcon = () => svg(<><rect x="5" y="7" width="14" height="11" rx="3" /><path d="M12 3v4" /><circle cx="9.5" cy="12.5" r="1" /><circle cx="14.5" cy="12.5" r="1" /></>);
const WorkflowIcon = () => svg(<><rect x="3" y="4" width="7" height="6" rx="1.5" /><rect x="14" y="14" width="7" height="6" rx="1.5" /><path d="M6.5 10v3a2 2 0 0 0 2 2H14" /></>);
// The goal icon of the ChatGPT app: a circular arrow around a dot.
const TargetIcon = () => svg(<><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6l2.5 2.5" /><path d="M20.5 3.5v5h-5" /><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" /></>);
const PauseIcon = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>);
const ResumeIcon = () => svg(<><circle cx="12" cy="12" r="9" /><path d="m10.2 8.8 5 3.2-5 3.2z" /></>);
const ExpandIcon = () => svg(<><path d="M14.5 4H20v5.5" /><path d="m20 4-6.5 6.5" /><path d="M9.5 20H4v-5.5" /><path d="m4 20 6.5-6.5" /></>);
const CollapseIcon = () => svg(<><path d="M19 10.5h-5.5V5" /><path d="m13.5 10.5 6.5-6.5" /><path d="M5 13.5h5.5V19" /><path d="m10.5 13.5-6.5 6.5" /></>);
const ChevronIcon = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
    className={`transition-transform ${on ? "rotate-180" : ""}`} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
);

// One row: at least 34 px (8 px padding around at most 26 px content), text 14.5 px on 20 px line height. 10 px on the
// right so the last icon button (24 px) has its centre 22 px from the edge (ChatGPT). The expanded goal row aligns to
// the top: with 7 px padding its first text line sits where it sat centred when collapsed.
const ROW_FORM = "flex min-h-[34px] gap-2 pl-3 pr-2.5 text-[14.5px] leading-5";
const ROW = `${ROW_FORM} items-center py-1`;
// The icon slot on the left: as wide as an icon so the texts of all rows start on one edge. `h-5` = one text line, so in an
// expanded (top-aligned) row the icon sits beside the first line.
const SymbolSlot = ({ children, className = "text-dim" }: { children: React.ReactNode; className?: string }) => (
  <span className={`flex h-5 w-[14px] shrink-0 items-center justify-center ${className}`}>{children}</span>
);
// A text button in the row ("Steer", "Cancel"): same font as the row, dimmed.
const TEXT_BUTTON = "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-50";
// An icon button: 24 px, dimmed, foreground colour on hover (ChatGPT).
// `open`: only on the expand button; then `aria-expanded` says whether the row is expanded (a screen reader otherwise only hears "Expand goal").
function SymbolButton({ title, action, onClick, open, children }: { title: string; action: string; onClick: () => void; open?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-strip-action={action}
      title={title}
      aria-label={title}
      aria-expanded={open}
      className="-my-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:text-fg focus-visible:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
    >{children}</button>
  );
}

/**
 * One row of the base. It slides out from behind the composer when it appears and back under it when it
 * disappears; the height runs through the slot (see globals.css), the content is anchored at the bottom and
 * clipped. It has no surface of its own; the hairline to its predecessor hangs on the slot pair (`data-open`)
 * so it comes and goes with the row.
 *
 * `finished` lifts the clipping once the slide is over: anything hung `absolute bottom-full` in a row would
 * otherwise stay cut off. During the slide it must clip, or there is nothing to reveal.
 */
function Strip({
  children, last = false, leaving = false, identifier,
}: {
  children: React.ReactNode;
  last?: boolean;
  leaving?: boolean;
  identifier: string;
}) {
  const [inside, setInside] = useState(false);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    // Two frames: in the first the slot is at 0fr, only in the second it grows. A single rAF is not
    // reliable: the browser merges mount and class change into one style change without a transition.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setInside(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, []);
  const open = inside && !leaving;
  useEffect(() => {
    if (!open) { setFinished(false); return; }
    const t = setTimeout(() => setFinished(true), 200);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <div className="cb-strip-slot" data-open={open ? "1" : "0"} data-finished={finished ? "1" : "0"} data-strip={identifier}>
      <div className="cb-strip-clip">
        <div className={`cb-strip-row ${last ? "cb-strip-last" : ""}`}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Keeps vanished entries on screen for as long as their exit takes. Without it a message that was picked up
 * would vanish abruptly, losing half the motion that the slide-in tells.
 */
function useExit(items: StripQueue[], ms = 200) {
  const [list, setList] = useState<(StripQueue & { leaving?: boolean })[]>(() => items.map((i) => ({ ...i })));
  const clocks = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const current = useRef(items);
  current.current = items;
  // The dependency is the CONTENT, not the array reference: the caller rebuilds the list on every render (the goal
  // clock ticks every second), and the reference would cause an extra render per tick.
  const signature = items.map((i) => `${i.id}\u0000${i.text}\u0000${i.controllable === false ? 0 : 1}\u0000${i.systemNotice === true ? 1 : 0}`).join("\u0001");
  useEffect(() => {
    const now = current.current;
    setList((cur) => {
      const present = new Map(now.map((i) => [i.id, i]));
      const together: (StripQueue & { leaving?: boolean })[] = cur.map((c) => {
        const still = present.get(c.id);
        return still ? { ...still, leaving: false } : { ...c, leaving: true };
      });
      for (const i of now) if (!cur.some((c) => c.id === i.id)) together.push({ ...i, leaving: false });
      return together;
    });
  }, [signature]);
  useEffect(() => {
    for (const e of list) {
      if (!e.leaving || clocks.current.has(e.id)) continue;
      const clock = setTimeout(() => {
        clocks.current.delete(e.id);
        setList((cur) => cur.filter((c) => !(c.id === e.id && c.leaving)));
      }, ms);
      clocks.current.set(e.id, clock);
    }
  }, [list, ms]);
  useEffect(() => {
    const map = clocks.current;
    return () => { for (const t of map.values()) clearTimeout(t); };
  }, []);
  return list;
}

/** The row of the earmarked graph workflow start, already translated (ChatStage computes it from `foregroundRow` in
 *  lib/graph-runs.ts). `onButton` may return a promise; while it runs the button is locked. */
export interface StripGraphRow {
  startId: string;
  kind: "earmarked" | "waiting_lock" | "worktree";
  text: string;
  button: string;
  onButton: () => unknown;
}

/** At most two messages are visible: the OLDEST, i.e. the ones that are next. */
export const STRIP_VISIBLE = 2;

export function ComposerBase({
  compressed = false,
  goal = "",
  goalSeconds = null,
  goalPaused = false,
  onGoalEnd,
  onGoalPause,
  queued,
  onControl,
  onDismiss,
  controlRunning = false,
  graphRow = null,
  chatId = null,
}: {
  /** Compaction is running: the chat accepts messages but answers them only afterwards; without the row one would only
   *  see that "nothing happens" and send again. */
  compressed?: boolean;
  goal?: string;
  /** Runtime in seconds, or null when nothing is running. */
  goalSeconds?: number | null;
  /** The goal is paused (`chat.goalPaused`): the row says "Goal paused", without runtime; the button resumes. */
  goalPaused?: boolean;
  /** The trash button of the goal row: delete the goal. */
  onGoalEnd?: () => void;
  /** Pause/resume of the goal row; without a handler no button. */
  onGoalPause?: (paused: boolean) => void;
  queued: StripQueue[];
  onControl: () => void;
  onDismiss: (q: StripQueue) => void;
  controlRunning?: boolean;
  /** Provided by the coding chat. */
  graphRow?: StripGraphRow | null;
  /** The chat the base belongs to: a change collapses the goal row again, even with identical goal text. */
  chatId?: string | null;
}) {
  const t = useT();
  const [on, setOn] = useState(false);
  // Goal row expanded: full text, wrapped. Another goal or another chat starts collapsed again.
  const target = goal.trim();
  const [targetOpen, setTargetOn] = useState(false);
  useEffect(() => { setTargetOn(false); }, [target, chatId]);
  // The graph strip's button while its stop is in flight (per startId; a new row is free).
  const [graphAtThe, setGraphAtThe] = useState<string | null>(null);
  const list = useExit(queued);
  // The cap applies ONLY to messages: the goal is always shown in addition.
  const remaining = list.filter((q) => !q.leaving);
  const hidden = Math.max(0, remaining.length - STRIP_VISIBLE);
  const show = on || hidden === 0 ? list : list.filter((q, i) => q.leaving || i < STRIP_VISIBLE);
  const controllable = remaining.filter((q) => q.controllable !== false).length;

  // An expanded stack stays expanded until clicked again, but closes once there is nothing left to hide,
  // otherwise a button without effect would remain.
  useEffect(() => { if (hidden === 0) setOn(false); }, [hidden]);

  // Each part is a named entry, not raw JSX with a key: the strip needs the identifier itself (guard, exit clock),
  // and reading it back from element.key would depend on React's internal key spelling.
  const parts: { identifier: string; leaving?: boolean; content: React.ReactNode }[] = [];
  if (compressed) {
    const title = t("Compacting the context…");
    const set = t("Messages are queued and start right after.");
    parts.push({
      identifier: "compress",
      content: (
        <div className={ROW} role="status">
          {/* The dot pulses only without "reduce motion"; otherwise it stands still. */}
          <SymbolSlot>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
          </SymbolSlot>
          <span className="cb-fade-r min-w-0 flex-1 overflow-hidden whitespace-nowrap" title={`${title} ${set}`}>
            <span className="font-medium text-fg">{title}</span>
            <span className="text-dim"> {set}</span>
          </span>
        </div>
      ),
    });
  }
  if (target) {
    // "Pursuing goal" · text · "• 3s" (from one minute "1m 20s"); paused without runtime, since nothing runs then.
    const label = goalPaused ? t("Goal paused") : t("Pursuing goal");
    const runtime = !goalPaused && goalSeconds !== null ? fmtDur(goalSeconds) : null;
    parts.push({
      identifier: "goal",
      content: (
        <div className={targetOpen ? `${ROW_FORM} items-start py-[7px]` : ROW} data-target-paused={goalPaused ? "1" : "0"}>
          <SymbolSlot><TargetIcon /></SymbolSlot>
          {targetOpen ? (
            <div className="min-w-0 flex-1">
              <span className="font-medium text-fg">{label}</span>
              {runtime && <span className="tabular-nums text-dim"> • {runtime}</span>}
              <div className="mt-0.5 max-h-[min(40vh,320px)] overflow-y-auto whitespace-pre-wrap break-words text-dim" data-target-text>{target}</div>
            </div>
          ) : (
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={target}>
              <span className="shrink-0 font-medium text-fg">{label}</span>
              <span className="min-w-0 truncate text-dim" data-target-text>{target}</span>
              {runtime && <span className="shrink-0 tabular-nums text-dim">• {runtime}</span>}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1">
            {onGoalEnd && (
              <SymbolButton title={t("Delete goal")} action="target-end" onClick={onGoalEnd}><TrashIcon /></SymbolButton>
            )}
            {onGoalPause && (
              <SymbolButton title={goalPaused ? t("Resume goal") : t("Pause goal")} action="target-pause" onClick={() => onGoalPause(!goalPaused)}>
                {goalPaused ? <ResumeIcon /> : <PauseIcon />}
              </SymbolButton>
            )}
            <SymbolButton title={targetOpen ? t("Collapse goal") : t("Expand goal")} action="target-expand" open={targetOpen} onClick={() => setTargetOn((c) => !c)}>
              {targetOpen ? <CollapseIcon /> : <ExpandIcon />}
            </SymbolButton>
          </span>
        </div>
      ),
    });
  }
  if (graphRow) {
    const gz = graphRow;
    parts.push({
      identifier: "graph-start",
      content: (
        <div className={ROW} data-graph-start={gz.kind}>
          <SymbolSlot className={gz.kind === "worktree" ? "text-dim" : "text-accent"}><WorkflowIcon /></SymbolSlot>
          <span className="cb-fade-r min-w-0 flex-1 overflow-hidden whitespace-nowrap text-fg" title={gz.text}>{gz.text}</span>
          <button
            type="button"
            disabled={graphAtThe === gz.startId}
            onClick={() => {
              setGraphAtThe(gz.startId);
              Promise.resolve(gz.onButton()).finally(() => setGraphAtThe((c) => (c === gz.startId ? null : c)));
            }}
            data-strip-action={gz.kind === "worktree" ? "graph-hide" : "graph-abort"}
            className={TEXT_BUTTON}
          >{gz.button}</button>
        </div>
      ),
    });
  }
  const topmostId = show.find((q) => !q.leaving)?.id;
  for (const q of show) {
    const first = q.id === topmostId;
    // Two kinds in one list: a subagent's completion notice is a system message. It shows name and state and has no
    // trash button (if discarded, the main agent would never get the report; the server rejects it with 409).
    // "Steer" does not take it along anyway (`controllable: false`).
    const entry = queueEntry(q);
    if (entry.systemNotice) {
      const row = t(entry.label, entry.labelParams);
      parts.push({
        identifier: `q:${q.id}`,
        leaving: q.leaving,
        content: (
          <div className={ROW} data-strip-system-notice>
            <SymbolSlot><AgentIcon /></SymbolSlot>
            <span className="cb-fade-r min-w-0 flex-1 overflow-hidden whitespace-nowrap text-dim" title={row}>{row}</span>
          </div>
        ),
      });
      continue;
    }
    parts.push({
      identifier: `q:${q.id}`,
      leaving: q.leaving,
      content: (
        <div className={ROW}>
          <SymbolSlot><ClockIcon /></SymbolSlot>
          <span className="cb-fade-r min-w-0 flex-1 overflow-hidden whitespace-nowrap text-fg" title={q.text}>{q.text}</span>
          {first && controllable > 0 && (
            <button
              type="button"
              onClick={onControl}
              disabled={controlRunning}
              data-strip-action="control"
              title={t("Aborts the running turn and sends immediately")}
              className={`${TEXT_BUTTON} font-medium`}
            >
              <ControlIcon />
              {controllable > 1 ? t("Steer ({n})", { n: controllable }) : t("Steer")}
            </button>
          )}
          <SymbolButton title={t("Dismiss")} action="dismiss" onClick={() => onDismiss(q)}><TrashIcon /></SymbolButton>
        </div>
      ),
    });
  }
  if (hidden > 0) {
    parts.push({
      identifier: "more",
      content: (
        <button
          type="button"
          onClick={() => setOn((c) => !c)}
          data-strip-action="more"
          className={`${ROW} w-full text-dim transition-colors hover:text-fg`}
        >
          <SymbolSlot className=""><ChevronIcon on={on} /></SymbolSlot>
          {on ? t("Show less") : t("+{n} more", { n: hidden })}
        </button>
      ),
    });
  }
  if (!parts.length) return null;

  // The base carries the glass; each part gets its own slot (row), and the BOTTOM one carries the covered zone
  // so the composer glass lies exactly over it.
  return (
    <div className="cb-strip-base" data-base>
      {parts.map((part, i) => (
        <Strip
          key={part.identifier}
          identifier={part.identifier.startsWith("q:") ? "queue" : part.identifier}
          leaving={part.leaving}
          last={i === parts.length - 1}
        >
          {part.content}
        </Strip>
      ))}
    </div>
  );
}
