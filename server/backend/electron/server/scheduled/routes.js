// The routes of the scheduled jobs and the gateway's wakeup.
//
//   scheduledWorkspaceRoutes  (sub-slice of workspaces/routes.js workspaceRoutes, before tailWorkspaceRoutes)
//     GET    /api/workspaces/:ws/scheduled?status=&projectId=   list: job, name, project, next occurrence, state, last run
//     POST   /api/workspaces/:ws/scheduled                      chat AND job in one go (store setUpScheduledJob)
//     GET    /api/workspaces/:ws/scheduled/:id                  one job
//     PATCH  /api/workspaces/:ws/scheduled/:id                  only contract.js PATCH_FIELDS; a missing field means unchanged
//     DELETE /api/workspaces/:ws/scheduled/:id                  the job falls, the chat STAYS — with a `hint` row
//     POST   /api/workspaces/:ws/scheduled/:id/run              "Run now", cause `hand` (409 when an occurrence is waiting)
//     GET    /api/workspaces/:ws/scheduled/:id/runs?before=&limit=   the runs, newest first
//   scheduleNextRoute       GET /api/schedules/next — the earliest occurrence for the gateway wakeup, response
//                           `{nextAt, in, running}`; without an occurrence `nextAt: 0`
//                           (the gateway reads `Number(nextAt) || 0`, server/gateway/containers.js).
//
// The run values (name = title, project, instance, provider, model, effort level, permission mode, notification choice)
// are on the CHAT: the creation normalizes them with THE SAME computation as POST /api/chats (chats/creation.js,
// `modeRequired` — a missing or unknown permission mode is a 400 here), they are changed via PATCH /api/chats/:id.
// No MCP tool creates one.

import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { broadcast } from "../runtime/sse.js";
import { chatCreation } from "../chats/creation.js";
import { ultracodeFollowUp } from "../chats/ultracode.js";
import * as notifications from "../notify.js";
import { runCause } from "../runs/state.js";
import { nextWakeup } from "../runs/wakeup.js";
import { rememberTimeZone, timeZoneDefault } from "../workspaces/timeZone.js";

import { INSTRUCTIONS_MAX, JOB_DERIVED, JOB_FIELDS, JOB_STATUS, RUN_FIELDS, PATCH_FIELDS } from "./contract.js";
import { nextOccurrence, cadenceOff, cadenceText } from "./cadence.js";
import { startRun, waitingInTheQueue } from "./run.js";
import { JOB_NOTIFICATIONS } from "./chat-field.js";

const take = (o, fields) => Object.fromEntries(fields.map((k) => [k, o[k]]));
const no = (res, status, error) => send(res, status, { error });

/** The derived state (contract.js STATES) — computed, never stored; `null` means "none of these". */
export function stateOf(a) {
  if (!a?.chatId) return null;
  if (runCause.get(a.chatId)?.cause === "schedule") return "running";
  const pr = store.getPendingResume(a.chatId);
  if (pr && (pr.kind || "run") === "run" && pr.payload?.cause === "schedule") return "parked";
  if (store.openScheduledRuns(a.id).some(waitingInTheQueue)) return "queued";
  return null;
}

/** A job in responses: the contract's fields, plus name and project of its chat, cadence in plain text, state, last run. */
export function publicJob(a) {
  const chat = a.chatId ? store.getChat(a.chatId) : null;
  const last = store.listScheduledRuns(a.id, { limit: 1 })[0] || null;
  const derived = {
    name: chat?.title || "", projectId: chat?.projectId || null, cadenceText: cadenceText(a),
    state: stateOf(a), lastRun: last ? take(last, RUN_FIELDS) : null,
  };
  return { ...take(a, JOB_FIELDS), ...take(derived, JOB_DERIVED) };
}

/** Check the instructions: required, text, at most INSTRUCTIONS_MAX characters. Returns the trimmed text or the error text. */
function instructionsFrom(v) {
  if (typeof v !== "string" || !v.trim()) return { error: T("instructions missing") };
  if (v.length > INSTRUCTIONS_MAX) return { error: T`instructions: at most ${INSTRUCTIONS_MAX} characters` };
  return { text: v.trim() };
}

/** The suggested name: the first line of the instructions, shortened — renamable like any chat. */
const titleFrom = (b, instructions) => {
  const own = typeof b.name === "string" ? b.name.trim() : "";
  const first = instructions.split("\n").map((z) => z.trim()).find(Boolean) || "";
  const n = (own || first).slice(0, 120);
  return n || T("Scheduled task");
};

// The global event `scheduled` as in scheduled/run.js and tick.js — also for creating, changing and deleting by hand: a
// second client (the list under Coding → Scheduled, the chat list with its clock) would otherwise only follow the next run.
const report = (a, status, chatId = a.chatId || null) => broadcast({ type: "scheduled", workspaceId: a.workspaceId, jobId: a.id, runId: null, chatId, status });

export async function scheduledWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;

  if (sub === "/scheduled" && m === "GET") {
    const status = url.searchParams.get("status") || null;
    if (status && !JOB_STATUS.includes(status)) return no(res, 400, T`Unknown status: ${status}`);
    const projectId = url.searchParams.get("projectId") || null;
    if (projectId && !(ws.projects || []).some((pr) => pr.id === projectId)) return no(res, 400, T("Project does not belong to this workspace"));
    return send(res, 200, { items: store.listScheduledJobs(wid, { status, projectId }).map(publicJob), now: Date.now() });
  }

  if (sub === "/scheduled" && m === "POST") {
    const b = (await readBody(req)) || {};
    const enabled = instructionsFrom(b.instructions);
    if (enabled.error) return no(res, 400, enabled.error);
    const timeZone = b.timeZone === undefined ? timeZoneDefault(wid) : b.timeZone;
    const now = Date.now();
    const r = cadenceOff(b.cadence, b.plan ?? {}, { timeZone, now });
    if (!r.ok) return no(res, 400, r.error);
    const creation = chatCreation({ ...b, workspaceId: wid }, { modeRequired: true });
    if (creation.error) return send(res, creation.error.status, creation.error.body);
    const notify = b.notify === undefined ? null : notifications.normalizeChoice(b.notify, JOB_NOTIFICATIONS);
    const id = crypto.randomUUID();
    const raw = { id, workspaceId: wid, instructions: enabled.text, cadence: r.cadence, plan: r.plan, cron: r.cron, oneTimeAt: r.oneTimeAt, timeZone: timeZone.trim(), createdAt: now };
    const nextAt = nextOccurrence(raw, now);
    const chat = ultracodeFollowUp(null, { id: crypto.randomUUID(), ...creation.fields, title: titleFrom(b, enabled.text), createdAt: now, updatedAt: now });
    const fresh = store.setUpScheduledJob({ job: { ...raw, nextAt, updatedAt: now }, chat, notify });
    if (b.timeZone !== undefined) rememberTimeZone(wid, raw.timeZone);
    report(fresh.job, "created", fresh.chat?.id || null);
    return send(res, 201, { job: publicJob(fresh.job), chat: fresh.chat });
  }

  const gm = sub.match(/^\/scheduled\/([0-9a-f-]+)(\/run|\/runs)?$/);
  if (!gm) return NEXT;
  const a = store.getScheduledJob(gm[1]);
  if (!a || a.workspaceId !== wid) return no(res, 404, T("Task not found"));

  if (!gm[2] && m === "GET") return send(res, 200, publicJob(a));

  if (!gm[2] && m === "PATCH") {
    const b = (await readBody(req)) || {};
    const unknown = Object.keys(b || {}).filter((k) => !PATCH_FIELDS.includes(k));
    // "A missing field is not an instruction" — and a foreign field is not a change: name, project, model … are changed by the chat PATCH.
    if (unknown.length) return no(res, 400, T`Not changeable here: ${unknown.join(", ")} — name and run settings change via PATCH /api/chats/:id`);
    const fields = {};
    if ("instructions" in b) {
      const enabled = instructionsFrom(b.instructions);
      if (enabled.error) return no(res, 400, enabled.error);
      fields.instructions = enabled.text;
    }
    const now = Date.now();
    if ("cadence" in b || "plan" in b || "timeZone" in b) {
      const timeZone = "timeZone" in b ? b.timeZone : a.timeZone;
      const r = cadenceOff("cadence" in b ? b.cadence : a.cadence, "plan" in b ? b.plan : a.plan, { timeZone, now });
      if (!r.ok) return no(res, 400, r.error);
      Object.assign(fields, { cadence: r.cadence, plan: r.plan, cron: r.cron, oneTimeAt: r.oneTimeAt, timeZone: String(timeZone).trim() });
    }
    if ("status" in b) {
      // `done` is set only by the run end of a one-time job; by hand there are active and paused.
      if (b.status !== "active" && b.status !== "paused") return no(res, 400, T("status: active or paused"));
      fields.status = b.status;
    }
    const planChanged = ["cadence", "cron", "oneTimeAt", "timeZone"].some((k) => k in fields && fields[k] !== a[k])
      || ("plan" in fields && JSON.stringify(fields.plan) !== JSON.stringify(a.plan));
    if (a.status === "done" && !("status" in fields) && planChanged) fields.status = "active";
    const againActive = fields.status === "active" && a.status !== "active";
    // Recompute strictly after NOW: resuming catches up on nothing (reaching for the button is not an unannounced run).
    if (planChanged || againActive) { fields.nextAt = nextOccurrence({ ...a, ...fields }, now); fields.retryAt = 0; }
    // Active without an upcoming occurrence would never run: a done ONE-TIME job whose moment has passed only becomes
    // active again with a new moment — 400, and nothing is changed.
    if ((planChanged || againActive) && (fields.status ?? a.status) === "active" && !(fields.nextAt > 0)) {
      return no(res, 400, T("No upcoming run — give a new time (plan)"));
    }
    if (fields.status === "paused") fields.retryAt = 0;
    const fresh = store.updateScheduledJob(a.id, { ...fields, updatedAt: now });
    if ("timeZone" in b) rememberTimeZone(wid, fresh.timeZone);
    report(fresh, "changed");
    return send(res, 200, publicJob(fresh));
  }

  if (!gm[2] && m === "DELETE") {
    // An open run (queued, running, parked) holds up the deletion — its end would otherwise find no job any more, and
    // the queued occurrence would run without instructions. Stop or dismiss first.
    if (store.openScheduledRuns(a.id).length) return no(res, 409, T("A run of this task is open — wait, stop it or discard the queued entry first"));
    const { chatId } = store.deleteScheduledJob(a.id);
    report(a, "deleted", chatId || null);
    if (chatId) {
      try { store.addMessage(chatId, "hint", T("The scheduled task of this chat was deleted — the chat stays.")); }
      catch (e) { console.error("[scheduled] hint on deletion:", e?.message || e); }
    }
    return send(res, 200, { ok: true, chatId });
  }

  if (gm[2] === "/run" && m === "POST") {
    try {
      const { run } = startRun(a, "hand");
      return send(res, 201, { run: take(run, RUN_FIELDS), job: publicJob(store.getScheduledJob(a.id)) });
    } catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }

  if (gm[2] === "/runs" && m === "GET") {
    const before = Number(url.searchParams.get("before") || 0) || 0;
    const limit = Number(url.searchParams.get("limit") || 20) || 20;
    const items = store.listScheduledRuns(a.id, { before, limit }).map((l) => take(l, RUN_FIELDS));
    return send(res, 200, { items, next: items.length ? items[items.length - 1].id : 0 });
  }
  return NEXT;
}

export async function scheduleNextRoute(ctx) {
  const { res, p, m } = ctx;
  // The earliest upcoming occurrence across all workspaces — for the gateway wakeup, which starts the container in time
  // (the gateway asks at the container port, without a session).
  if (p === "/api/schedules/next" && m === "GET") {
    // Plus the earliest wakeup of a chat (runs/wakeup.js): it neither holds `busy` nor wakes a sleeping container
    // itself — the gateway does so at this time (lead 2 min), and its reaper leaves a container with an occurrence
    // in the next ten minutes standing.
    const termine = [store.nextScheduledOccurrence() || 0, nextWakeup()].filter((t) => t > 0);
    const nextAt = termine.length ? Math.min(...termine) : 0;
    // A running scheduled turn: cause "schedule" in a job chat.
    const scheduledRunning = [...runCause].filter(([chatId, l]) => l?.cause === "schedule" && store.getChat(chatId)?.jobId).length;
    return send(res, 200, { nextAt, in: nextAt ? Math.max(0, nextAt - Date.now()) : null, running: scheduledRunning });
  }
  return NEXT;
}
