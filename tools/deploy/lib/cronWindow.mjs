// The cleanup-cron guard: a host may run a daily docker cleanup (remote.cleanupCronUtcHour, e.g. 4 for 04:00 UTC) that prunes unused
// images and stopped containers — exactly the candidate image under construction, the one that is checked but not yet repointed,
// and the stopped container between `rm -f` and `run`. An image build or switch that runs across that hour is refused. Without a
// configured hour there is no guard.
//
// The duration is a NAMED assumption (`DEPLOY_DURATION_ASSUMPTION_MIN`) — it is not measured, and the error text says so. Override
// only with the dedicated switch `--cron-window-ignore`, never with --yes or --force. Applies to every run that builds an image or
// switches a container: `server` (also inside `all`) and `rollback server` — `cronWindowTargets`. The clock is injectable (`now`).
// Guard: tools/deploy/cronWindow.test.mjs.

export const DEPLOY_DURATION_ASSUMPTION_MIN = 45;
export const CRON_WINDOW_TOGGLE = "--cron-window-ignore";
const MINUTE = 60_000;

const utc = (ms) => new Date(ms).toISOString().slice(11, 16);

const hourText = (hour) => `${String(hour).padStart(2, "0")}:00 UTC`;

/** Pure: does the interval [begin, end] (borders included) contain `hour`:00 UTC — the daily docker-cleanup cron of the host? */
function crossesCron(begin, end, hour) {
  const tag = new Date(begin);
  let cron = Date.UTC(tag.getUTCFullYear(), tag.getUTCMonth(), tag.getUTCDate(), hour, 0, 0);
  if (cron < begin) cron += 24 * 60 * MINUTE;
  return cron <= end;
}

/** Pure: does a run that starts at `begin` and (assumed) lasts `durationMin` run across `hour`:00 UTC? → `{ locked, reason, begin, end, durationMin }`. */
export function cronWindowVerdict(begin, { durationMin = DEPLOY_DURATION_ASSUMPTION_MIN, hour = 4 } = {}) {
  const end = begin + durationMin * MINUTE;
  const locked = crossesCron(begin, end, hour);
  const reason = locked
    ? `the run would span ${hourText(hour)} (start ${utc(begin)}Z, end about ${utc(end)}Z; assumed duration ${durationMin} min — an assumption, not a measurement): the daily docker-cleanup cron of the host then removes unused images and stopped containers, among them the candidate image and the container under swap`
    : "";
  return { locked, reason, begin, end, durationMin };
}

/** Pure: does the run build an image or switch a container (parseArgs result)? */
export function cronWindowTargets(o) {
  if (o.command === "rollback") return o.rollbackWhat === "server";
  if (o.command) return false;
  return o.targets.includes("server");
}

/**
 * The check in the deploy (deploy.mjs, before the gate / the rollback). Throws when the run would span the configured cleanup hour
 * (`hour`, remote.cleanupCronUtcHour) — except with `ignore` or in a dry run (a red row: "a real run would abort here"). Returns the row
 * for log.table, or null when the run builds and switches nothing or no cleanup hour is configured.
 */
export function checkCronWindow({ relevant, hour = null, ignore = false, dry = false, now = Date.now, durationMin = DEPLOY_DURATION_ASSUMPTION_MIN }) {
  if (!relevant || hour === null || hour === undefined) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`remote.cleanupCronUtcHour must be an hour from 0 to 23 or null, not ${JSON.stringify(hour)}`);
  const label = `${hourText(hour)} guard (docker cleanup)`;
  const v = cronWindowVerdict(now(), { durationMin, hour });
  if (!v.locked) return [label, `start ${utc(v.begin)}Z, end about ${utc(v.end)}Z (assumption ${v.durationMin} min) — clear of ${hourText(hour)}`, "ok"];
  if (ignore) return [label, `overridden with ${CRON_WINDOW_TOGGLE}: ${v.reason}`, "warn"];
  if (dry) return [label, `a real run would abort here: ${v.reason}`, "bad"];
  throw new Error(`${v.reason}. Start earlier or later — override only with ${CRON_WINDOW_TOGGLE} (--yes and --force do not override it).`);
}
