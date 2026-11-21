// The tick of the scheduled jobs: who is due — catch up, book as missed, repeat or start, and move the occurrence on.
// An occurrence whose predecessor is still working is queued (FIFO in THE SAME chat), and if one is already waiting,
// scheduled/run.js startRun books the new one as `failed`. Every due occurrence goes to startRun. The names of the
// environment variables are fixed (golden runs and tests set them).
//
// Plus the cleanup at start (scheduledAtStart): an open run stays open when its chat has an active_runs entry
// (resumeInterruptedWork picks it up again right away), is parked at the limit (parked is like running — the wait row
// is its persistence) or its entry is in the restored queue (runInputsRestartGrace starts it); otherwise it ends
// `error` "Server restarted".

import * as store from "../store.js";
import { T } from "../i18n.js";
import { wallTimeText } from "../cron.js";
import { broadcast } from "../runtime/sse.js";
import { endRun, startRun, waitingInTheQueue } from "./run.js";
import { nextOccurrence, periodMs } from "./cadence.js";

// The knobs: tick 30 s, catch-up threshold 5 min.
export const SCHEDULED_CHECK_MS = () => Math.max(200, Number(process.env.CBASE_SCHEDULE_TICK_MS || 30_000));
const CATCH_UP_THRESHOLD_MS = () => Math.max(0, Number(process.env.CBASE_SCHEDULE_CATCH_UP_MS || 5 * 60_000));

// Test seam: how many ticks have run completely (counted at the end). The counter does not change behavior.
let ticks = 0;
export const scheduledTicks = () => ticks;

/** An occurrence beyond the limit: book as `missed` — the machine was not reachable. */
function missed(a, occurrence, now) {
  const text = T`Missed ${wallTimeText(occurrence, a.timeZone)} — the machine was not reachable`;
  const run = store.createScheduledRun({ jobId: a.id, workspaceId: a.workspaceId, chatId: a.chatId || "", cause: "tick", scheduledAt: occurrence, startedAt: now, status: "missed", error: text });
  store.updateScheduledRun(run.id, { endedAt: now });
  store.updateScheduledJob(a.id, { lastStatus: "missed", updatedAt: now, ...(a.cadence === "oneTime" ? { status: "done", nextAt: 0 } : {}) });
  broadcast({ type: "scheduled", workspaceId: a.workspaceId, jobId: a.id, runId: run.id, chatId: a.chatId || null, status: "missed" });
  console.log(`[scheduled] ${a.id}: occurrence ${new Date(occurrence).toISOString()} missed (${Math.round((now - occurrence) / 60_000)} min)`);
}

/** The tick: every due job once. An error with one job does not hold up the others. */
export function scheduledTick() {
  const now = Date.now();
  for (const a of store.dueScheduledJobs(now)) {
    try {
      // The repetition after the first error. Clear the marker first — a throw at start must not make the tick
      // try the same attempt every half minute.
      if (a.retryAt > 0 && a.retryAt <= now) {
        store.updateScheduledJob(a.id, { retryAt: 0, updatedAt: now });
        startRun({ ...a, retryAt: 0 }, "repetition", { scheduledAt: a.retryAt });
        continue;
      }
      const occurrence = a.nextAt;
      const lateness = now - occurrence;
      const period = periodMs(a, now);
      // Limit for catching up: half the period, six hours for one-time occurrences.
      const limit = period ? period / 2 : 6 * 3600_000;
      // Move the occurrence on first (for the same reason as above).
      const next = nextOccurrence(a, now);
      store.updateScheduledJob(a.id, { nextAt: next, updatedAt: now });
      if (lateness > limit) { missed(a, occurrence, now); continue; }
      startRun({ ...a, nextAt: next }, lateness > CATCH_UP_THRESHOLD_MS() ? "caughtUp" : "tick", { scheduledAt: occurrence });
    } catch (e) {
      console.error("[scheduled] tick", a.id, String(e?.message || e).slice(0, 300));
    }
  }
  ticks += 1;
}

/**
 * The cleanup at start: open runs of an earlier server life that nobody picks up any more end `error`
 * "Server restarted" — without repetition (the turn may already have had an effect). Runs BEFORE
 * resumeInterruptedWork (server.js, in the listen callback; the queue is already loaded from the DB then).
 */
export function scheduledAtStart() {
  const open = new Set(store.listActiveRuns().map((r) => r.chatId));
  const parked = (chatId) => { const pr = store.getPendingResume(chatId); return Boolean(pr) && (pr.kind || "run") === "run"; };
  // An open run with an active_runs row stays open: resumeInterruptedWork picks it up — or gives it up, then it ends there
  // (scheduled/run.js). In the queue an entry that only carries its marker counts too (run.js waitingInTheQueue).
  for (const l of store.allOpenScheduledRuns()) {
    if (l.chatId && (open.has(l.chatId) || parked(l.chatId) || waitingInTheQueue(l))) continue;
    endRun(l.id, { error: T("Server restarted"), repeatable: false });
  }
}
