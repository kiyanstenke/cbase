// The computations of the "Scheduled" tab: from the form the server's plan and back, which segment a job has, how the list is sorted and
// what a run is called as a word. A leaf WITHOUT imports (the tests compile it with tsc alone, web/test/scheduled-form.test.mjs); the contract
// lists are in lib/api/scheduled.ts, and the values here are bound there in the type. The texts go out as English keys; the caller translates
// with `t()` (i18n-de.ts).
//
// What the server checks, it checks (scheduled/cadence.js: time, days, day of month 1–28, point in time in the future); here is only what
// the form can say BEFORE sending, so a typo does not come back as a 400: the same limits, none of its own.

/** The forms of repetition in the order of the choice; the same values as `SCHEDULED_CADENCES` (lib/api/scheduled.ts). */
export const CADENCE_CHOICE = [
  { value: "daily", label: "Daily" },
  { value: "workdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "oneTime", label: "Once" },
] as const;
export type CadenceValue = (typeof CADENCE_CHOICE)[number]["value"];

/** The weekdays in the order of the bar (Monday first), with the value cron and the server take (0 = Sunday). */
export const WEEKDAYS = [
  { value: 1, short: "Mon" }, { value: 2, short: "Tue" }, { value: 3, short: "Wed" }, { value: 4, short: "Thu" },
  { value: 5, short: "Fri" }, { value: 6, short: "Sat" }, { value: 0, short: "Sun" },
] as const;

/** Monthly only 1–28; the same limit as `SCHEDULED_DAY_OF_MONTH`. */
export const DAYS_OF_MONTH: readonly number[] = Array.from({ length: 28 }, (_, i) => i + 1);

/** The form of a repetition. `oneTime` is the value of a datetime-local field ("2026-10-21T22:00", browser time). */
export type CadenceForm = { cadence: CadenceValue; clockTime: string; days: number[]; day: number; oneTime: string };

export type Plan = { at?: number; clockTime?: string; days?: number[]; day?: number };

/** The default of a new job: daily at 08:00, on Mondays (if one switches to weekly), on the 1st of the month. */
export function emptyCadenceForm(): CadenceForm {
  return { cadence: "daily", clockTime: "08:00", days: [1], day: 1, oneTime: "" };
}

const CLOCK_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * From the form the server's plan, or an error as an English key. A one-time occurrence goes out as a point in time in ms: the field shows
 * the BROWSER's time, and an ISO string without offset would be read by the server in the job's zone.
 */
export function planFromForm(f: CadenceForm, now = Date.now()): { cadence: CadenceValue; plan: Plan } | { error: string } {
  if (f.cadence === "oneTime") {
    const at = f.oneTime ? new Date(f.oneTime).getTime() : NaN;
    if (!Number.isFinite(at)) return { error: "Point in time missing" };
    if (at <= now) return { error: "The point in time is not in the future" };
    return { cadence: "oneTime", plan: { at } };
  }
  const m = CLOCK_TIME.exec(f.clockTime.trim());
  if (!m) return { error: "Time missing" };
  const clockTime = `${m[1].padStart(2, "0")}:${m[2]}`;
  if (f.cadence === "weekly") {
    const days = [...new Set(f.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (!days.length) return { error: "Choose at least one weekday" };
    return { cadence: "weekly", plan: { clockTime, days } };
  }
  if (f.cadence === "monthly") {
    if (!DAYS_OF_MONTH.includes(f.day)) return { error: "Day of the month 1 to 28" };
    return { cadence: "monthly", plan: { clockTime, day: f.day } };
  }
  return { cadence: f.cadence, plan: { clockTime } };
}

/** "2026-10-21T22:00" in the browser's time: the form of the datetime-local field. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}

/** Back: the form of an existing job. Unknown things fall back to the default (an unreadable plan is not an empty one). */
export function formFromJob(a: { cadence: string | null; plan: Plan }): CadenceForm {
  const f = emptyCadenceForm();
  const r = CADENCE_CHOICE.find((x) => x.value === a.cadence)?.value;
  if (!r) return f;
  f.cadence = r;
  if (typeof a.plan.clockTime === "string") f.clockTime = a.plan.clockTime;
  if (Array.isArray(a.plan.days) && a.plan.days.length) f.days = [...a.plan.days];
  if (typeof a.plan.day === "number") f.day = a.plan.day;
  if (typeof a.plan.at === "number") f.oneTime = localIso(a.plan.at);
  return f;
}

/** The parts of a form that count for its cadence; equal means "the repetition was not touched". */
function formCore(f: CadenceForm): string {
  if (f.cadence === "oneTime") return JSON.stringify([f.cadence, f.oneTime]);
  const days = f.cadence === "weekly" ? [...new Set(f.days)].sort((a, b) => a - b) : null;
  return JSON.stringify([f.cadence, f.clockTime.trim(), days, f.cadence === "monthly" ? f.day : null]);
}

/**
 * The PATCH of an existing job from the dialog: only what changed. Cadence and plan are only CHECKED and sent if the repetition form
 * differs from when it was opened; otherwise a finished one-time job (occurrence in the past) could not even be renamed: the form
 * rejected "The point in time is not in the future" before the chat PATCH (name, project, model) went out, and the server answered the
 * plan sent along with 400.
 */
export function jobChange(
  a: { instructions: string; cadence: string | null; plan: Plan }, instructions: string, form: CadenceForm, now = Date.now(),
): { change: { instructions?: string; cadence?: CadenceValue; plan?: Plan } } | { error: string } {
  const change: { instructions?: string; cadence?: CadenceValue; plan?: Plan } = {};
  if (instructions.trim() !== a.instructions) change.instructions = instructions;
  if (formCore(form) !== formCore(formFromJob(a))) {
    const r = planFromForm(form, now);
    if ("error" in r) return r;
    if (r.cadence !== a.cadence || JSON.stringify(r.plan) !== JSON.stringify(a.plan)) {
      change.cadence = r.cadence;
      change.plan = r.plan;
    }
  }
  return { change };
}

/** The three segments of the list: "Upcoming" (active), "Paused", "Done" (a one-time job after its run). */
export const SEGMENTS = [
  { key: "active", label: "Upcoming" },
  { key: "paused", label: "Paused" },
  { key: "done", label: "Done" },
] as const;
export type Segment = (typeof SEGMENTS)[number]["key"];

/**
 * The jobs of a segment: "Upcoming" by the next occurrence (without one last), the others by last change, newest first. A job with an
 * unknown status (`null`) is in NO segment; it would otherwise be a claim.
 */
export function jobsIn<A extends { status: string | null; nextAt: number; updatedAt: number }>(list: readonly A[], s: Segment): A[] {
  const inside = list.filter((a) => a.status === s);
  if (s === "active") return inside.sort((a, b) => (a.nextAt || Infinity) - (b.nextAt || Infinity));
  return inside.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The segment of a job; `null` for an unknown status (it is in none). */
export function segmentOf(a: { status: string | null } | null | undefined): Segment | null {
  return SEGMENTS.find((s) => s.key === a?.status)?.key ?? null;
}

/**
 * The row whose detail stands on the right: the chosen one if it is IN the segment, otherwise the segment's first. Searching the choice in
 * the whole list would show, after a segment switch, the detail of a job from the old segment; letting the segment follow the choice would
 * throw back to the old segment on every reload (every `chat_title` in the workspace). The segment therefore changes along only after the
 * user's OWN action (ScheduledTab `followUp`) and once on first load for the remembered choice.
 */
export function selectedRow<A extends { id: string }>(inSegment: readonly A[], choice: string | null): A | null {
  return inSegment.find((a) => a.id === choice) ?? inSegment[0] ?? null;
}

/** How a run ended, as a key; `open` means queued or running. */
export function runWord(status: string | null): string {
  switch (status) {
    case "open": return "open";
    case "ok": return "done";
    case "error": return "Error";
    case "aborted": return "cancelled";
    case "missed": return "missed";
    case "failed": return "skipped";
    case "dismissed": return "discarded";
    default: return "unknown";
  }
}

/** Why a run came about, as a key; the beat is the normal case and has no word. */
export function causeWord(cause: string | null): string | null {
  if (cause === "hand") return "manual";
  if (cause === "caughtUp") return "caught up";
  if (cause === "repetition") return "retry";
  return null;
}

/** The derived state as a key (only if there is one). */
export function stateWord(z: string | null): string | null {
  if (z === "running") return "running";
  if (z === "queued") return "queued";
  if (z === "parked") return "waiting for the limit";
  return null;
}

/** Is the result of a run one that must be seen (color of the row)? */
export function runTone(status: string | null): "ok" | "warn" | "danger" | "dim" {
  if (status === "ok") return "ok";
  if (status === "error") return "danger";
  if (status === "missed" || status === "failed") return "warn";
  return "dim";
}

/**
 * The notification kinds the "Notifications" sheet of a job chat offers: those of a chat and those of a schedule, each once, in this order;
 * the same set the server accepts for it (`scheduled/chat-field.js` JOB_NOTIFICATIONS) and the sheet shows on iOS
 * (`NotifyChatSheet(job:)`). Bound in web/test/scheduled-binding.test.mjs.
 */
export function jobNotificationKinds(chatKinds: readonly string[], scheduleKinds: readonly string[]): string[] {
  return [...new Set([...chatKinds, ...scheduleKinds])];
}

/**
 * The local window event after the user's OWN action in the Scheduled tab (create, pause, resume, change, delete, "Run now"). The server
 * reports `scheduled` only from run and tick (scheduled/run.js, tick.js), not on creating or on a PATCH; but the chat list in Coding → Chats
 * stays mounted (only hidden, app/workspaces/page.tsx) and would otherwise not show the new job chat, and on its row the clock from
 * before.
 */
export const SCHEDULED_CHANGED = "cbase-scheduled-changed";
export function reportScheduledChanged(workspaceId: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SCHEDULED_CHANGED, { detail: { workspaceId } }));
}

/**
 * What the clock says on a row of the chat list, as a key with the placeholder `{when}`: active with an occurrence → "Scheduled ·
 * {when}", otherwise the status. `null` without a job.
 */
export function jobClock(a: { status: string | null; nextAt: number } | null | undefined): { key: string; withWhen: boolean } | null {
  if (!a) return null;
  if (a.status === "active" && a.nextAt > 0) return { key: "Scheduled · next run {when}", withWhen: true };
  if (a.status === "paused") return { key: "Scheduled · paused", withWhen: false };
  if (a.status === "done") return { key: "Scheduled · done", withWhen: false };
  return { key: "Scheduled", withWhen: false };
}

/** The browser's zone (IANA): the zone in which a job created on the web runs (like iOS `TimeZone.current.identifier`). Without it the
 *  server would take the workspace's remembered one, without a remembered one "UTC": a typed "08:00" would then run at 08:00 UTC. */
export function ownTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The job's zone if it differs from one's own; the dialog and header then name it (the plan's clock time applies there, the next
 *  occurrence stands in the browser's time). Equal or unknown: `null`. iOS: `ScheduledZone.foreign`. */
export function foreignZone(zone: string | null | undefined, own = ownTimeZone()): string | null {
  const z = (zone ?? "").trim();
  return z && z !== own ? z : null;
}

/**
 * The level that "Save" sends to the chat when CHANGING; `null` means "send nothing". "Default" (empty) is no value on the chat: an empty
 * level would be a 400 in PATCH /api/chats/:id, a missing one would leave the old one: the dialog would show a choice it did not save,
 * and after a model change the old model's level would remain. So "Default" resolves to the chosen model's default level
 * (`effortDefaultLevel`, like iOS `EffortLevels.standard`). If the model has none (no levels), nothing goes out.
 */
export function levelToSave(choice: string, old: string, standard: string): string | null {
  if (choice === old) return null;
  const level = choice || standard;
  return level && level !== old ? level : null;
}
