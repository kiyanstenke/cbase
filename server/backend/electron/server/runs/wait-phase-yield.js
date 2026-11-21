// The hand-off of the wait phase.
//
// A turn stays in its instance. If the chat meanwhile stands in a DIFFERENT one (move into the copy, project change —
// runs/instance.js turnInstanceDifferent) and an input waits in its queue, the turn's process no longer begins a new turn: no
// input, no wakeup, no monitor event goes in, stdin closes, and the finally starts the queue as a follow-up turn in the instance
// of NOW (runs/do-run.js waitPhaseYield). Until then a wakeup (up to 24 h), a monitor (unbounded) or a background command kept the
// old process open, and their continuations ran as turns AFTER "ready" in the main instance. What the process may no longer deliver
// goes into the queue as an entry (cause "event", silent — a due wakeup, monitor events); what falls with it (a not yet due wakeup,
// schedules, running monitors, background commands) stands visibly in the history (role `hint`) and as a silent hint in the next
// turn — the text comes from here. The wakeup of cbase_wakeup does NOT fall with it: it belongs to the chat (runs/wakeup.js) and keeps
// no process open; `wakeup` here means only the provider's own (ScheduleWakeup, blocked), likewise the schedules (CronCreate). The
// monitors belong to the chat. Without an input in the queue the wait phase stays; it only accepts nothing more. LIMIT: if the run
// kind holds its subagents (runs/hooks.js `hold`) and one lives or a report is pending, the process does not end — its end would
// close the agents; the input then waits for its end.
//
// A leaf: imports only i18n. The wakeup's clock time is formatted by the caller (runs/limit-gate.js clockText) — no cycle over the
// hub. Guard: server/backend/test/stacks-inset.test.js.
import { T } from "../i18n.js";

const quote = (s) => (String(s || "").trim() ? ` („${String(s).trim().slice(0, 200)}“)` : "");

// `null` if nothing falls with the process; otherwise the text for the history row and the silent hint.
// wakeup: { clock, prompt } | null · crons: [{ expr, prompt }] · monitors/bgTasks: [{ description, taskId }]
export function yieldNotice({ identifier, wakeup = null, crons = [], monitors = [], bgTasks = [] }) {
  const dropped = [
    ...(wakeup ? [T`the wakeup at ${wakeup.clock}${quote(wakeup.prompt)}`] : []),
    ...crons.map((j) => T`the schedule ${j.expr}${quote(j.prompt)}`),
    ...monitors.map((m) => T`the monitor "${m.description || m.taskId}"`),
    ...bgTasks.map((b) => T`the background command "${b.description || b.taskId}"`),
  ];
  if (!dropped.length) return null;
  const where = identifier || "?";
  return T`This chat is now in a different instance than the previous turn (${where}) — its process ended instead of waiting. With it went: ${dropped.join("; ")}. Set up again here what is still needed (cbase_wakeup, cbase_monitor).`;
}
