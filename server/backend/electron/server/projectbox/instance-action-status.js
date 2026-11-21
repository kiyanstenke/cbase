// The status of the actions of a human on an instance. A leaf without imports — read by the action itself
// (projectbox/instance-actions.js), by the tree (projectbox/instances-tree.js) and by /api/runs/active (runs/routes.js), without any of
// the three having to import another.
//
// WHAT STANDS HERE: per identifier `<projectId>/<instance>` the LAST action — `{ kind, running, since, end, ok, error, stacks }`:
//   kind     "branch" | "dismiss" | "stack-restart" (the same words as the occupancies in projectbox/instance.js OCCUPANCY_SET);
//   running  true from the first step to the end; as long as it holds, it counts in `/api/runs/active` as project work (`state:
//            "action"`, the kind as phase) — deploy gate and idle reaper wait for it, like for a stop. Before, a `compose up -d --build`
//            of up to 30 min ran under `busy: false`, and a swap of B tore it off in the middle;
//   since/end  milliseconds; `end` null while it runs;
//   ok/error   the result (`error` the sentence of the failure, else "");
//   stacks   only at the stack restart: `[{ project, ok, error }]` — a failed stack does not drag the others along.
// Only in the memory of this process: after a restart of B there is no status (the action did not continue — the swap waited for it,
// except under `--force`). "Empty is not unknown" does not apply here: no status means "no action in this process". The status of a
// copy that was cleared away and created anew under the same name stays — so the tree shows it only if the action began after the
// instance row was created (projectbox/instances-tree.js).
//
// The LOCK against a second action is not here but the instance occupancy (projectbox/instance.js withInstanceOccupancy) — this leaf is
// only the information. A beginning without an end (crash of the action) does not exist: instance-actions.js ends in the `finally`.

const statuses = new Map(); // identifier → { kind, running, since, end, ok, error, stacks }

const identifierOf = (projectId, instance) => `${String(projectId ?? "")}/${String(instance || "main")}`;
const copy = (s) => (s ? { ...s, stacks: Array.isArray(s.stacks) ? s.stacks.map((x) => ({ ...x })) : null } : null);

/** An action begins (synchronously, under the occupancy). → the status. */
export function actionBegins(projectId, instance, kind, now = Date.now()) {
  const s = { kind: String(kind), running: true, since: now, end: null, ok: false, error: "", stacks: null };
  statuses.set(identifierOf(projectId, instance), s);
  return copy(s);
}

/** An intermediate status (the stack restart after every stack): `stacks` so far. */
export function actionBetween(projectId, instance, { stacks } = {}) {
  const s = statuses.get(identifierOf(projectId, instance));
  if (!s || !s.running) return null;
  if (Array.isArray(stacks)) s.stacks = stacks.map((x) => ({ ...x }));
  return copy(s);
}

/** The action ends: `ok`, `error` (sentence), `stacks`. → the status. */
export function actionEnds(projectId, instance, { ok = false, error = "", stacks = null } = {}, now = Date.now()) {
  const k = identifierOf(projectId, instance);
  const s = statuses.get(k);
  if (!s) return null;
  Object.assign(s, { running: false, end: now, ok: ok === true, error: String(error || ""), ...(Array.isArray(stacks) ? { stacks: stacks.map((x) => ({ ...x })) } : {}) });
  return copy(s);
}

/** The status of the last action of this instance in this process, else null (tree, event). */
export const actionStatus = (projectId, instance) => copy(statuses.get(identifierOf(projectId, instance)) || null);

/** The RUNNING actions of all instances → `[{ projectId, instance, kind, since }]` (for /api/runs/active). */
export function runningActions() {
  const out = [];
  for (const [k, s] of statuses) {
    if (!s.running) continue;
    const i = k.lastIndexOf("/");
    out.push({ projectId: k.slice(0, i), instance: k.slice(i + 1), kind: s.kind, since: s.since });
  }
  return out;
}
