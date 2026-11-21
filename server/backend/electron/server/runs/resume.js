// Resumption after a restart: MAX_RESUME_ATTEMPTS and resumeInterruptedWork.
// The file imports no domain: channel, workflow locks and runs and closing an abandoned workflow run are the events
// restartGrace, restartGraceWorkflows and restartGraceAbandoned (subscribers at their domains, registered in
// server.js).

import * as store from "../store.js";
import { broadcast, sse } from "../runtime/sse.js";
import { causeFromRunKind, compacting, running } from "./state.js";
import { startRun } from "./do-run.js";
import { fireHooks } from "./hooks.js";
import { clearAwayOnlyReadable, scheduleAutoContinue, sweepAutoContinues } from "./auto-continue.js";
import { onlyReadable } from "./only-readable.js";
import { managerLocked } from "./manager-lock.js";
import { targetResumptionDropped } from "./post-run.js";
import { T } from "../i18n.js";


// Maximum number of automatic resumptions per run — prevents crash loops (in case the run itself caused the crash,
// e.g. an OOM). After that the run is marked as interrupted.
const MAX_RESUME_ATTEMPTS = 2;

// At backend start: continue persisted but orphaned runs (the in-memory state was lost in the restart). Makes chats
// crash- and restart-proof — together with the container restart policy (unless-stopped) work even survives a
// server reboot.
function resumeInterruptedWork() {
  let runs = [];
  // First clean up the locks: runs that did not survive the restart must not hold a key. A RESUMED run keeps its
  // own (it is still open) — which is why validity depends on the run and not on a deadline.
  try { const gone = store.reapStaleLocks(); if (gone) console.log(`[resume] ${gone} orphaned lock(s) released`); } catch {}
  try { runs = store.listActiveRuns(); } catch {}
  // Reschedule runs waiting at the usage limit. They have NO active_runs row (their turn was over) and would
  // otherwise lie there forever — a weekly limit can last days, a restart in that time is likely.
  try { sweepAutoContinues(); } catch (e) { console.error("[limit] rescheduling:", e?.message || e); }
  // Channels: what stayed unread in an open channel before the restart is delivered now — the cursor is the truth,
  // not the in-memory mark of the running delivery. This is the event "restartGrace" (subscriber in
  // channels/delivery.js, registered in server.js); all hooks here run without waiting, i.e. synchronously at this
  // place. The PLACE carries behaviour: the delivery starts turns (… → doRun), and doRun sets `running.add`
  // synchronously before its first await — the filter right below reads exactly that. If the hook fired only after
  // the filter, a chat with unread messages would run TWICE: as a channel turn and as the resumption of its
  // active_runs row (held by restart-grace-hooks.test.js).
  fireHooks("restartGrace", {});
  // If the chat is already running in THIS process, the row is not a leftover but the run in progress: the resume
  // comes 2.5 s after the start and would delete its fresh output and start it a second time. The run cleans up
  // such rows itself.
  runs = runs.filter((r) => !running.has(r.chatId));
  // A chat with a run wait row belongs to auto-continue, not to the resumption — as for `flows` below. Its
  // active_runs row is a leftover: the run is PARKED, not interrupted, and the wait row persists it. Started from
  // here, the same task would run a second time next to the continuation the sweeper scheduled above. A crash IN
  // THE MIDDLE of a continuation leaves both behind — then the row sits on the placeholder "six hours ahead"
  // (fireAutoContinueInner), and the continuation is made due NOW: it checks the limit itself before the start and
  // reschedules itself if it still stands. Nothing is lost, nothing runs twice, nothing waits six hours in vain.
  runs = runs.filter((r) => {
    const row = store.getPendingResume(r.chatId);
    if (!row || (row.kind || "run") !== "run") return true;
    // The rows of a manager chat (runs/manager-lock.js) stay as they are — neither is the active_runs row dropped
    // nor the wait row moved forward. Both would write after the extract, and its fingerprint would differ. The
    // loop below skips the chat without writing.
    if (managerLocked(store.getChat(r.chatId))) return true;
    try { store.clearActiveRun(r.chatId); } catch {}
    const now = Date.now();
    if (row.dueAt > now) {
      try {
        store.reschedulePendingResume(r.chatId, { dueAt: now, now });
        scheduleAutoContinue(store.getPendingResume(r.chatId), { now });
      } catch (e) { console.error("[resume] moving the wait row forward:", e?.message || e); }
    }
    console.log(`[resume] ${r.chatId}: parked (wait row) — no resumption, the continuation takes over`);
    return false;
  });
  // Workflow runs that were interrupted between two steps: there is NO active_runs row for them (the turn was
  // finished), so they would otherwise silently stand still. Runs with a running turn are taken by the loop below,
  // waiting ones belong to the user.
  // `compacting` counts like `running`: during a /compact start command the chat is in `compacting`, its driver
  // waits in the `await` for the compaction and continues itself afterwards. Driven from here, a SECOND driver
  // would run next to it — it sees the command as not done, finds the compaction already running and executes the
  // node before the first one is back.
  let flows = [];
  try {
    flows = store.listOpenWorkflowRuns()
      .filter((r) => r.status === "running" && !running.has(r.chatId) && !compacting.has(r.chatId) && !runs.some((x) => x.chatId === r.chatId)
        // If the chat waits at the usage limit, it belongs to auto-continue. DRIVING it here would mean running
        // the step again at once against the same exhausted window.
        && !store.getPendingResume(r.chatId)
        // A manager chat's run is not driven — the driver would write to workflow_runs (step, completion) before
        // doRun locks it. It stays `running`.
        && !managerLocked(store.getChat(r.chatId)));
  } catch (e) { console.error("[resume] workflow runs:", e?.message || e); }
  if (!runs.length && !flows.length) return;
  console.log(`[resume] continuing ${runs.length} interrupted run(s), ${flows.length} workflow(s)`);

  // Workflow side of the resumption (event "restartGraceWorkflows", subscribers in workflows/gates.js, registered
  // in server.js in THIS order): first catch up the locks of all open runs, then drive the interrupted runs via
  // `flows` — gate or driver, depending on whether the turn of the cursor node was already finished. The list
  // `flows` is computed here: it depends on `running`, `compacting` and `runs`, the states of the hub. Before the
  // runs loop.
  fireHooks("restartGraceWorkflows", { flows });

  for (const r of runs) {
    const chat = store.getChat(r.chatId);
    if (!chat) { try { store.clearActiveRun(r.chatId); } catch {} continue; }
    // A read-only chat (runs/only-readable.js) does not start again — the row is dropped, and BEFORE the partial
    // output is deleted: the history stays as it was (no resumption mark, no run_resumed).
    if (onlyReadable(chat)) { clearAwayOnlyReadable(r.chatId); continue; }
    // A manager chat (runs/manager-lock.js) does not start again — and its row stays (no write after the extract).
    if (managerLocked(chat)) continue;
    // The interrupted CONTINUATION of the target gate (`goalDepth > 0`) of a target that is paused or gone by now
    // does not start again (post-run.js targetResumptionDropped — doRun asks it too, but only AFTER the "resumed"
    // mark and the deletion of the partial output below). The partial output stays (the work happened), the row is
    // dropped, a separator says why, and the end of the run goes to the clients and to "end" as when giving up. The
    // chat's queue is started afterwards by server.js.
    if (targetResumptionDropped(r.chatId, { goalDepth: r.goalDepth || 0 })) {
      try { store.clearActiveRun(r.chatId); } catch {}
      try {
        store.addMessage(r.chatId, "hint", T(
          "Restart during the goal gate's continuation — the goal is paused or gone, so it is not resumed."));
      } catch {}
      broadcast({ type: "run", chatId: r.chatId, running: false, answered: false });
      fireHooks("end", { chat });
      continue;
    }
    if ((r.attempts || 0) >= MAX_RESUME_ATTEMPTS) {
      // Failed too often → do not try again; mark as interrupted and release.
      try {
        store.addMessage(r.chatId, "meta", JSON.stringify({ interrupted: true, at: Date.now(), gaveUp: true }));
        store.clearActiveRun(r.chatId);
      } catch {}
      // A workflow run of this chat would otherwise stay on "running" as a zombie: the flows list above was
      // computed while the active_runs row still existed, so nobody drives it in this process — and its LOCK blocks
      // every further start of the same workflow until someone aborts by hand. Event "restartGraceAbandoned"
      // (subscriber in workflows/gates.js), BEFORE the broadcast.
      // `cause`: the cause of the abandoned turn — an occurrence (cause "schedule") ends on it (scheduled/);
      // without the event its run would stay open forever.
      fireHooks("restartGraceAbandoned", { chat, attempts: MAX_RESUME_ATTEMPTS, cause: causeFromRunKind(r.kind) });
      broadcast({ type: "run", chatId: r.chatId, running: false, answered: false });
      // This end of a run is the event "end" too — otherwise its subscribers would never learn that the run was
      // abandoned after the resume attempts were used up.
      fireHooks("end", { chat, abandoned: true });
      continue;
    }
    // Remove the partial output of the aborted turn (everything from the run start on), then run it again cleanly.
    // Resume automatically uses the stored claudeSessionId (previous turn) if there is one — otherwise a fresh run
    // with the same prompt.
    try { if (r.startedAt) store.deleteMessagesFrom(r.chatId, r.startedAt); } catch {}
    try { store.bumpActiveRunAttempts(r.chatId); } catch {}
    store.addMessage(r.chatId, "meta", JSON.stringify({ resumed: true, at: Date.now() }));
    sse(r.chatId, { type: "harness", subtype: "run_resumed" });
    // No await: start all runs again in parallel (as in normal operation).
    // The announcements of the interrupted run go along as inputs — under the cause "resumption", NOT "user":
    // ultracode and budget do not count the resumption as new human input (runs/human-input.js). Without an
    // announcement it stays a run without inputs.
    const inputs = (r.announcements || []).map((announcement) => ({ cause: "resumption", text: "", announcement }));
    startRun(chat, r.prompt || "Please continue the interrupted task.", { goalDepth: r.goalDepth || 0, attachments: r.attachments || null, cause: causeFromRunKind(r.kind), inputs });
  }
}

export { resumeInterruptedWork };
