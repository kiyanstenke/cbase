// Scheduled jobs: the routes of `server/backend/electron/server/scheduled/routes.js` for Coding → Scheduled, and the field
// `job` on `GET /api/chats` (the clock in the chat list). The state lives HERE and not in `state.mjs` (that file sits at the
// 2,000-line guard); `/fixture/reset-run` clears it via `resetScheduled`, so the seed belongs in the `launchApp` setup closure.
//
//   POST /fixture/scheduled { seed: true }   an active job "Write weekly report" (weekdays 08:00, next run tomorrow 08:00) on
//                                            its own chat (`SCHEDULED_CHAT_ID`) and a paused one (`SCHEDULED_PAUSE_CHAT_ID`)
//   GET  /fixture/scheduled                  the state: jobs, runs and the record (`attachments` = POST bodies, `patches`,
//                                            `now` = calls of "Run now") — the tests check what was SENT
//
// The shapes are the lists of the contract `scheduled/contract.js` (JOB_FIELDS + JOB_DERIVED, RUN_FIELDS, CHAT_JOB_FIELDS),
// the rules those of the routes: 400 without `instructions`, without or with an unknown `cadence` or permission mode,
// PATCH only `PATCH_FIELDS` (`status` only active/paused), 409 on "Run now" while a run is open. The next run is computed
// plainly in the zone of this machine (simulator and fixture run on the same Mac), not via cron.
import { randomUUID } from "node:crypto";
import { S, json, body, workspaceId, NEXT } from "./state.mjs";

export const SCHEDULED_ID = "61000000-0000-4000-8000-000000000001";
export const SCHEDULED_CHAT_ID = "60000000-0000-4000-8000-000000000001";
export const SCHEDULED_PAUSE_ID = "61000000-0000-4000-8000-000000000002";
export const SCHEDULED_PAUSE_CHAT_ID = "60000000-0000-4000-8000-000000000002";

const CADENCES = ["oneTime", "daily", "workdays", "weekly", "monthly"];
const MODES = ["default", "acceptEdits", "bypassPermissions", "plan"];
const PATCH_FIELDS = ["instructions", "cadence", "plan", "timeZone", "status"];
const DAYS_DE = ["sonntags", "montags", "dienstags", "mittwochs", "donnerstags", "freitags", "samstags"];

let G = empty();
function empty() {
  return { jobs: [], chats: [], runs: [], attachments: [], patches: [], now: 0, nextRunId: 1 };
}
export function resetScheduled() {
  G = empty();
}

/// The chats of the jobs for `GET /api/chats` (routes-chat.mjs appends them to the list).
export function scheduledChats() {
  return G.chats;
}

/// The field `job` of a chat row (CHAT_JOB_FIELDS) — `null` without a job, as the server sends it on EVERY row.
export function withJob(chat) {
  const a = G.jobs.find((x) => x.chatId === chat.id);
  return { ...chat, job: a ? { id: a.id, name: chat.title || "", status: a.status, nextAt: a.nextAt } : null };
}

const pad = (n) => String(n).padStart(2, "0");

/// The next run strictly after `from` in the zone of this machine — daily/workdays/weekly/monthly, day by day.
function next(a, from = Date.now()) {
  if (a.cadence === "oneTime") return Number(a.plan.at) > from ? Number(a.plan.at) : 0;
  const [H, M] = String(a.plan.clockTime || "08:00").split(":").map(Number);
  const d = new Date(from);
  d.setHours(H, M, 0, 0);
  for (let i = 0; i < 400; i++, d.setDate(d.getDate() + 1)) {
    if (d.getTime() <= from) continue;
    const wt = d.getDay();
    if (a.cadence === "workdays" && (wt === 0 || wt === 6)) continue;
    if (a.cadence === "weekly" && !(a.plan.days || []).includes(wt)) continue;
    if (a.cadence === "monthly" && d.getDate() !== a.plan.day) continue;
    return d.getTime();
  }
  return 0;
}

// German on purpose: the app shows the text as sent, and ScheduledUITests reads "Werktags um 08:00".
function cadenceText(a) {
  const u = a.plan.clockTime || "";
  switch (a.cadence) {
    case "oneTime": {
      const d = new Date(Number(a.plan.at) || 0);
      return `Einmalig am ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    case "daily": return `Täglich um ${u}`;
    case "workdays": return `Werktags um ${u}`;
    case "weekly": return `Wöchentlich ${(a.plan.days || []).map((t) => DAYS_DE[t]).join(", ")} um ${u}`;
    case "monthly": return `Monatlich am ${a.plan.day}. um ${u}`;
    default: return `Rhythmus ${a.cadence}`;
  }
}

/// Shape and plan as in `scheduled/cadence.js` — returns the cleaned plan or `{ error }`.
function planFrom(cadence, plan) {
  if (!cadence) return { error: "rhythmus missing" };
  if (!CADENCES.includes(cadence)) return { error: `Unknown rhythm: ${cadence}` };
  const p = plan && typeof plan === "object" ? plan : {};
  if (cadence === "oneTime") {
    const at = Number(p.at);
    return at > Date.now() ? { plan: { at } } : { error: "plan.at: the point in time is not in the future" };
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(p.clockTime || ""));
  if (!m) return { error: "plan.clockTime: HH:MM required" };
  const clockTime = `${pad(Number(m[1]))}:${m[2]}`;
  if (cadence === "weekly") {
    const days = Array.isArray(p.days) ? [...new Set(p.days)].sort((a, b) => a - b) : [];
    if (!days.length) return { error: "plan.days: at least one weekday, 0 (Sun) to 6 (Sat)" };
    return { plan: { clockTime, days } };
  }
  if (cadence === "monthly") {
    if (!Number.isInteger(p.day) || p.day < 1 || p.day > 28) return { error: "plan.day: 1 to 28 — on the 29th, 30th or 31st whole months would be skipped" };
    return { plan: { clockTime, day: p.day } };
  }
  return { plan: { clockTime } };
}

const runField = (l) => l ? {
  id: l.id, jobId: l.jobId, workspaceId: l.workspaceId, chatId: l.chatId, cause: l.cause, scheduledAt: l.scheduledAt,
  queuedAt: l.queuedAt, startedAt: l.startedAt, endedAt: l.endedAt, status: l.status, error: l.error, short: l.short,
  question: l.question,
} : null;

/// A job in responses (JOB_FIELDS + JOB_DERIVED).
function publicJob(a) {
  const chat = G.chats.find((c) => c.id === a.chatId);
  const runs = G.runs.filter((l) => l.jobId === a.id);
  const open = runs.some((l) => l.status === "open");
  return {
    id: a.id, workspaceId: a.workspaceId, chatId: a.chatId, instructions: a.instructions, cadence: a.cadence, plan: a.plan,
    timeZone: a.timeZone, status: a.status, nextAt: a.nextAt, retryAt: 0, lastRunAt: a.lastRunAt, lastStatus: a.lastStatus,
    lastError: "", createdAt: a.createdAt, updatedAt: a.updatedAt,
    name: chat?.title || "", projectId: chat?.projectId || null, cadenceText: cadenceText(a),
    state: open ? "queued" : null, lastRun: runField(runs.at(-1)),
  };
}

function createOne({ id = randomUUID(), chatId = randomUUID(), title, instructions, cadence, plan, status = "active", projectId = null, chat = {}, age = 1_800_000 }) {
  const now = Date.now();
  const a = { id, workspaceId, chatId, instructions, cadence, plan, timeZone: "Europe/Berlin", status, nextAt: 0, lastRunAt: 0, lastStatus: "", createdAt: now, updatedAt: now };
  a.nextAt = status === "active" ? next(a) : 0;
  // Deliberately OLDER than the main chat: "Newest first" lists it further up, and `openFirstChat` keeps opening the main chat.
  G.chats.push({
    ...S.chat, id: chatId, projectId, title: title, kind: "normal", notify: {}, goal: "", pinned: false,
    createdAt: now - age, updatedAt: now - age, ...chat,
  });
  G.jobs.push(a);
  return a;
}

function seed() {
  createOne({ id: SCHEDULED_ID, chatId: SCHEDULED_CHAT_ID, title: "Write weekly report", instructions: "Write weekly report\nSummarize the commits of the week.", cadence: "workdays", plan: { clockTime: "08:00" } });
  createOne({ id: SCHEDULED_PAUSE_ID, chatId: SCHEDULED_PAUSE_CHAT_ID, title: "Check dependencies", instructions: "Check dependencies", cadence: "monthly", plan: { clockTime: "06:30", day: 1 }, status: "paused", age: 3_000_000 });
  // The active run is fixed at TOMORROW 08:00 for the tests — the clock of the chat row then shows "tomorrow 08:00" whatever
  // weekday the test runs on.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  G.jobs[0].nextAt = tomorrow.getTime();
}

export async function routesScheduled(ctx) {
  const { req, res, url, path, method } = ctx;

  if (path === "/fixture/scheduled" && method === "POST") {
    const b = await body(req);
    if (b.seed) seed();
    return json(res, 200, { ok: true });
  }
  if (path === "/fixture/scheduled" && method === "GET") {
    return json(res, 200, { jobs: G.jobs.map(publicJob), runs: G.runs, attachments: G.attachments, patches: G.patches, now: G.now });
  }

  // The job chats themselves (opened from "To chat" or the chat list) — like the extra chats in routes-chat.mjs: empty history.
  const chatMatch = path.match(/^\/api\/chats\/([0-9a-f-]+)(\/log|\/stream)?$/);
  const own = chatMatch && G.chats.find((c) => c.id === chatMatch[1]);
  if (own) {
    if (chatMatch[2] === "/log") return json(res, 200, url.searchParams.get("window") === "1" ? { total: 0, lastId: 0, older: false, rows: [] } : []);
    if (chatMatch[2] === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "harness", subtype: "connected", lastId: 0, total: 0, running: false, waiting: false, monitors: [], queued: [] })}\n\n`);
      return;
    }
    if (method === "GET") return json(res, 200, { ...own, archivedAt: null });
    if (method === "PATCH") {
      Object.assign(own, await body(req));
      return json(res, 200, { ...own, archivedAt: null });
    }
  }

  const m = path.match(/^\/api\/workspaces\/([0-9a-f-]+)\/scheduled(?:\/([0-9a-f-]+)(\/run|\/runs)?)?$/);
  if (!m) return NEXT;
  if (m[1] !== workspaceId) return json(res, 404, { error: "workspace not found" });

  if (!m[2] && method === "GET") {
    const status = url.searchParams.get("status");
    const projectId = url.searchParams.get("projectId");
    const items = G.jobs
      .filter((a) => !status || a.status === status)
      .filter((a) => !projectId || G.chats.find((c) => c.id === a.chatId)?.projectId === projectId)
      .map(publicJob);
    return json(res, 200, { items, now: Date.now() });
  }
  if (!m[2] && method === "POST") {
    const b = await body(req);
    G.attachments.push(b);
    if (typeof b.instructions !== "string" || !b.instructions.trim()) return json(res, 400, { error: "anweisungen missing" });
    const r = planFrom(b.cadence, b.plan);
    if (r.error) return json(res, 400, { error: r.error });
    if (!MODES.includes(b.permissionMode)) return json(res, 400, { error: `Unknown permission mode: ${b.permissionMode ?? "(missing)"}` });
    const instructions = b.instructions.trim();
    const title = (b.name || instructions.split("\n").map((z) => z.trim()).find(Boolean) || "Scheduled task").slice(0, 120);
    const a = createOne({
      title, instructions, cadence: b.cadence, plan: r.plan, projectId: b.projectId || null, age: 0,
      chat: { provider: b.provider || S.chat.provider, model: b.model || S.chat.model, effort: b.effort || S.chat.effort, permissionMode: b.permissionMode },
    });
    if (typeof b.timeZone === "string") a.timeZone = b.timeZone;
    return json(res, 201, { job: publicJob(a), chat: { ...G.chats.at(-1), archivedAt: null } });
  }

  const a = G.jobs.find((x) => x.id === m[2]);
  if (!a) return json(res, 404, { error: "Task not found" });

  if (!m[3] && method === "GET") return json(res, 200, publicJob(a));
  if (!m[3] && method === "PATCH") {
    const b = await body(req);
    G.patches.push({ id: a.id, ...b });
    const foreign = Object.keys(b).filter((k) => !PATCH_FIELDS.includes(k));
    if (foreign.length) return json(res, 400, { error: `Not changeable here: ${foreign.join(", ")} — name and run settings change via PATCH /api/chats/:id` });
    if ("instructions" in b) {
      if (typeof b.instructions !== "string" || !b.instructions.trim()) return json(res, 400, { error: "anweisungen missing" });
      a.instructions = b.instructions.trim();
    }
    if ("cadence" in b || "plan" in b) {
      const r = planFrom("cadence" in b ? b.cadence : a.cadence, "plan" in b ? b.plan : a.plan);
      if (r.error) return json(res, 400, { error: r.error });
      a.cadence = "cadence" in b ? b.cadence : a.cadence;
      a.plan = r.plan;
    }
    if ("status" in b) {
      if (b.status !== "active" && b.status !== "paused") return json(res, 400, { error: "status: aktiv or pausiert" });
      a.status = b.status;
    }
    a.nextAt = a.status === "active" ? next(a) : 0;
    a.updatedAt = Date.now();
    return json(res, 200, publicJob(a));
  }
  if (!m[3] && method === "DELETE") {
    G.jobs = G.jobs.filter((x) => x.id !== a.id);
    return json(res, 200, { ok: true, chatId: a.chatId });
  }
  if (m[3] === "/run" && method === "POST") {
    G.now += 1;
    if (G.runs.some((l) => l.jobId === a.id && l.status === "open")) {
      return json(res, 409, { error: "A run of this task is open — wait, stop it or discard the queued entry first" });
    }
    const now = Date.now();
    const run = {
      id: G.nextRunId++, jobId: a.id, workspaceId, chatId: a.chatId, cause: "hand", scheduledAt: now, queuedAt: now,
      startedAt: 0, endedAt: 0, status: "open", error: "", short: "", question: false,
    };
    G.runs.push(run);
    return json(res, 201, { run: runField(run), job: publicJob(a) });
  }
  if (m[3] === "/runs" && method === "GET") {
    const items = G.runs.filter((l) => l.jobId === a.id).reverse().map(runField);
    return json(res, 200, { items, next: items.length ? items.at(-1).id : 0 });
  }
  return NEXT;
}
