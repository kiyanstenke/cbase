// Project containers among the inner containers of a user container. A leaf, pure (only import: node:crypto for the
// fingerprint in `relocationDeduction`).
//
// A project container (`cbase-p-<projectId>`, label `cbase.project=<projectId>`, server/backend/electron/server/projectbox/
// creation.js) is NOT an inner container of the user that the deploy brings back after the swap: after every start of B the
// backend brings it back itself (restart hook "project-restore", projectbox/restore.js) — only after a valid network
// separation marker, then its inner stack in the order of depends_on, with a cap per stage. A `docker start` by the deploy
// would bypass all that: before the marker (without network separation) and alongside the restoration.
//
// Hence: `innerFrom` (lib/gates.mjs) marks it (`project`), `restoreInner` (lib/remote.mjs) brings back only
// `retrievalList`, gate and status show it in a row of its own "backend brings back" (no warn), and after the settle
// observation the deploy checks via `projectWork` (/api/runs/active) whether the restoration is done
// (`projectRetrievalRow`).
//
// It is recognized by the label OR the name — one suffices (a hand-renamed container with label, a container of an older
// state without label). The way back: `restoreInner` without the filter.
//
// Guarded by the maintainer's private suite.
import crypto from "node:crypto";

export const PROJECT_LABEL = "cbase.project";
export const PROJECT_PREFIX = "cbase-p-";
// The copy of a project is called `cbase-k-<projectId>-<name>` — the backend brings it back itself as well.
export const COPY_PREFIX = "cbase-k-";

// The project id from name and label list (`{{.Labels}}` of the CLI: `k=v,k=v`; a value with a comma falls apart, the
// segment `cbase.project=…` still stands on its own) — the label takes precedence, otherwise the name; no project
// container ⇒ null. A copy without label is a project container with unknown id ("?"): project id and copy name both
// contain hyphens, the name alone does not separate them.
export function projectOf(name, labels = "") {
  const segment = String(labels ?? "").split(",").map((g) => g.trim()).find((g) => g.startsWith(`${PROJECT_LABEL}=`));
  if (segment) return segment.slice(PROJECT_LABEL.length + 1) || "?";
  const n = String(name ?? "").trim();
  if (n.startsWith(COPY_PREFIX) && n.length > COPY_PREFIX.length) return "?";
  return n.startsWith(PROJECT_PREFIX) && n.length > PROJECT_PREFIX.length ? n.slice(PROJECT_PREFIX.length) : null;
}

export const isProjectContainer = (c) => Boolean(c?.project) || projectOf(c?.name) !== null;

// A list of inner containers ({ name, status, project? }) into those of the user and the project containers.
export function partsInner(list) {
  const user = [];
  const projects = [];
  for (const c of Array.isArray(list) ? list : []) (isProjectContainer(c) ? projects : user).push(c);
  return { user, projects };
}

// What `restoreInner` starts: the names of the user's inner containers — never a project container.
export const retrievalList = (wanted) => partsInner(wanted).user.map((c) => c.name);

// The old containers of a relocation. After a swap `restoreInner` starts by name what ran in the snapshot BEFORE the swap
// — on a `--force` swap (confirmation, several B) and in the settle observation (up to 150 s, the gateway replaces B itself)
// also containers that a relocation has stopped SINCE (step 4, restart=no). After the cutover the old stack in B and the new
// one inside would then run side by side until `remove` deletes the old ones with their volumes — writes in between lost,
// workers doubled. So `restoreInner` asks the backend of B BEFORE the start: `relocationContainer` (/api/runs/active,
// server/backend/electron/server/runs/routes.js) gives the sha256 of the full id of every container that an open or finished
// relocation journal took over; `id` comes from `innerFrom` (`docker ps --no-trunc`).
//   runs null (unreachable)   ⇒ start nothing, each with a reason — unknown is not "no relocation"; the caller names the
//                               command to run by hand.
//   field missing             ⇒ a backend from before relocation: it knows no relocation and can run none (the field came with
//                               the capability) ⇒ all as before, `beforeE` says so.
//   otherwise                 ⇒ every one whose fingerprint is in the list stays off; one without a full `id` on a NON-empty
//                               list as well (cannot be matched). An empty list starts all.
// `beforeSwap` is the answer the idle gate read immediately BEFORE the swap of this B (lib/gates.mjs → `row.runs`). If the
// backend is silent AFTER the swap, this snapshot applies — but only if it carried `relocationsOpen === 0` (no relocation in
// progress that would have continued since) AND a field `relocationContainer` (a backend that knows relocations). Then whoever
// is not in ITS list starts; `snapshot` says so. Without such a snapshot it stays unknown (start nothing). The fingerprints of
// finished relocations do not change over a swap — new ones arise only from a relocation in progress, and `relocationsOpen
// === 0` rules that out.
// → { start: [name], omitted: [{ name, reason }], beforeE, snapshot }
export const fingerprint = (id) => crypto.createHash("sha256").update(String(id)).digest("hex");
export const snapshotCarries = (v) => Boolean(v) && typeof v === "object" && v.relocationsOpen === 0 && Array.isArray(v.relocationContainer);
export function relocationDeduction(runs, wanted, { beforeSwap = null } = {}) {
  const user = partsInner(wanted).user;
  if (!runs || typeof runs !== "object") {
    if (snapshotCarries(beforeSwap)) return { ...relocationDeduction(beforeSwap, wanted), snapshot: true };
    return { start: [], omitted: user.map((c) => ({ name: c.name, reason: "backend unreachable — whether a relocation took it over is unknown" })), beforeE: false, snapshot: false };
  }
  if (!Array.isArray(runs.relocationContainer)) return { start: user.map((c) => c.name), omitted: [], beforeE: true, snapshot: false };
  const set = new Set(runs.relocationContainer.filter((x) => typeof x === "string"));
  const start = [];
  const omitted = [];
  for (const c of user) {
    if (!set.size) start.push(c.name);
    else if (!c.id) omitted.push({ name: c.name, reason: "without full id — cannot be matched, and a relocation is running or ran" });
    else if (set.has(fingerprint(c.id))) omitted.push({ name: c.name, reason: "a relocation took it over (journal open or finished) — it does not start again in B" });
    else start.push(c.name);
  }
  return { start, omitted, beforeE: false, snapshot: false };
}

// The row for gate and status (null without project containers): which exist, which run — and that the backend brings them
// back. Deliberately `ok`, not `warn`: a stopped project container after a swap is the normal case.
export function projectContainerRow(all, running = []) {
  const { projects } = partsInner(all);
  if (!projects.length) return null;
  const on = new Set(partsInner(running).projects.map((c) => c.name));
  const names = projects.map((c) => `${c.name} (${on.has(c.name) ? "running" : "stopped"})`);
  return ["Project containers", `${names.join(", ")} — backend brings them back (restart), the deploy does not start them`, "ok"];
}

// The NUMBER of converted instances in `error` (field `projectError` of /api/runs/active — only a number, no ids, no
// reasons: the route is unauthenticated). `null` = the backend does not give it (older) — "unknown", never 0 (empty is not
// unknown). "All ready" is said by gate, status and settle observation only with `projectWork` empty AND `projectError` 0;
// otherwise the number is shown. An instance in `error` does not turn the deploy red (a message, no abort): its reason is in
// the log of B, runs there end visibly, the next start tries it anew.
export function projectErrorCount(runs) {
  const n = runs?.projectError;
  return Number.isInteger(n) && n >= 0 ? n : null;
}
export const projectErrorSet = (n) => `${n} in \`error\` (reason in the log of B; runs there end visibly, the next start tries them anew)`;
const ERROR_UNKNOWN = "whether one is in `error`, this backend does not say (without field `projectError`)";

// The NUMBER of converted instances that a human stopped (field `projectStopped`). Calm, no error: it changes no verdict, it
// is only added — otherwise a standing project container after the swap would look forgotten. Without the field (older
// backend) and at 0 no addition.
export function projectStoppedCount(runs) {
  const n = runs?.projectStopped;
  return Number.isInteger(n) && n >= 0 ? n : null;
}
export const projectStoppedAddition = (runs) => {
  const n = projectStoppedCount(runs);
  return n ? `, ${n} stopped (by hand — starts in the tab "Instances" or with the next run in it)` : "";
};

// After the settle observation: does the backend bring back the project containers of this B? `projectWork` names only
// instances IN PROGRESS (create · start · recreate · relocation · clear away · stop); those in `error` are counted by
// `projectError` (above). "All ready" means: none in progress AND none in `error`. Unreachable and without field mean
// "unknown", never "none". The stopped instances are added in EVERY branch — precisely when another instance hangs or is
// missing, "1 stopped" is the answer to "why does this project not run".
export const projectStoppedAttachment = (runs) => {
  const z = projectStoppedAddition(runs);
  return z ? `;${z.slice(1)}` : "";
};
export function projectRetrievalRow(runs, prior = []) {
  const label = "Project containers after the swap";
  const names = prior.map((c) => c.name).join(", ");
  if (!runs) return [label, `unknown (backend unreachable) — running before: ${names}`, "warn"];
  if (!Array.isArray(runs.projectWork)) return [label, `unknown (backend without field \`projectWork\`) — running before: ${names}`, "warn"];
  const p = runs.projectWork;
  const f = projectErrorCount(runs);
  if (!p.length) {
    if (f === 0) return [label, `all ready${projectStoppedAddition(runs)} — the restoration is done; running before: ${names}`, "ok"];
    if (f === null) return [label, `no instance in progress any more${projectStoppedAddition(runs)} — ${ERROR_UNKNOWN}; running before: ${names}`, "warn"];
    return [label, `no instance in progress any more, ${projectErrorSet(f)}${projectStoppedAddition(runs)} — running before: ${names}`, "warn"];
  }
  const perInstance = p.map((x) => [`${x?.projectId || "?"}/${x?.instance || "?"}`, x?.state || "?", x?.phase ? `phase "${x.phase}"` : ""].filter(Boolean).join(" · "));
  const alongside = f ? `; plus ${projectErrorSet(f)}` : "";
  return [label, `${p.length} still in progress: ${perInstance.join("; ")}${alongside}${projectStoppedAttachment(runs)} — the backend brings them back; state with \`./deploy status\``, "warn"];
}

// The row "setups: N open, M failed; without instance row: K" per B. Every project is created WITH its instance row in
// operation, the relocation tick is gone. The three numbers come from /api/runs/active (`setupOpen`, `setupError`,
// `withoutInstanceRow` — only numbers, it is readable from any project network), the NAMES for K from GET
// /api/projectbox/ops-status (`withoutInstanceRow: [{ projectId, name }]`, lib/remote.mjs remoteOpsStatus; the fence rejects
// it from project networks). `ok` only with M = K = 0 — a project without an instance row is a violation of the invariant, a
// failed setup waits for "Try again". Unreachable and a missing field (backend from before project creation) mean
// "unknown", never 0.
const NAMES_MAX = 12;
const countFrom = (runs, field) => (Number.isSafeInteger(runs?.[field]) && runs[field] >= 0 ? runs[field] : null);
export function setupRow(runs, opsStatus) {
  const label = "Setups";
  if (!runs || typeof runs !== "object") return [label, "unknown (backend unreachable)", "warn"];
  const fields = ["setupOpen", "setupError", "withoutInstanceRow"];
  const missing = fields.filter((f) => countFrom(runs, f) === null);
  if (missing.length) return [label, `unknown (backend without field ${missing.map((f) => `\`${f}\``).join(", ")} — from before project creation with container)`, "warn"];
  const [open, error, without] = fields.map((f) => countFrom(runs, f));
  let text = `${open} open, ${error} failed; without instance row: ${without}`;
  if (without > 0) {
    const list = opsStatus && typeof opsStatus === "object" && Array.isArray(opsStatus.withoutInstanceRow) ? opsStatus.withoutInstanceRow : null;
    if (!list) text += " — names unknown (GET /api/projectbox/ops-status not readable or without field `withoutInstanceRow`)";
    else if (list.length) {
      const names = list.slice(0, NAMES_MAX).map((x) => `${String(x?.name || "").trim() || "?"} (${x?.projectId || "?"})`);
      text += ` — ${names.join("; ")}${list.length > NAMES_MAX ? `; and ${list.length - NAMES_MAX} more` : ""}`;
    } else text += " — the list of names is empty by now (read again)";
  }
  return [label, text, error === 0 && without === 0 ? "ok" : "warn"];
}

// Compose containers that run IN B next to a converted project (backend: projectbox/relocation/compose-in-b.js, field
// `composeInB` of the route GET /api/projectbox/ops-status): its stack belongs in the project container since the
// relocation, a `docker compose up` in B would bypass it. Read via lib/remote.mjs remoteOpsStatus: `composeInB` is
// `[{ projectId, name, container, running }]` per project with a main instance; `null` means "docker in B not readable", a
// MISSING field "older backend" — both "unknown", never 0. A message, no abort: what runs there is stopped by hand.
// The backend reads `ps -a`, so the list also carries STOPPED containers — the relocation deliberately leaves one-shot
// containers and containers with changed labels in B. Only `running: true` means "run … (stop by hand)" (warn); `running:
// false` is added as a note "stopped, remainder in B" (no state as long as nothing runs); an entry WITHOUT the field (older
// backend) means "state unknown" (warn) — never "running", never "stopped".
export function composeInBRow(opsStatus) {
  const label = "Compose in B (converted)";
  if (!opsStatus || typeof opsStatus !== "object") return [label, "unknown (backend unreachable)", "warn"];
  if (!Object.hasOwn(opsStatus, "composeInB")) return [label, "unknown (backend without field `composeInB`)", "warn"];
  const list = opsStatus.composeInB;
  if (list === null) return [label, "unknown (the backend could not read docker in B)", "warn"];
  if (!Array.isArray(list)) return [label, "unknown (field `composeInB` is no list)", "warn"];
  if (!list.length) return [label, "0", "ok"];
  const group = (part) => {
    const perProject = new Map();
    for (const x of part) {
      const who = x?.name ? `${x.name} (${x?.projectId || "?"})` : String(x?.projectId || "?");
      const names = (Array.isArray(x?.container) ? x.container : [x?.container]).map((c) => String(c || "").trim()).filter(Boolean);
      perProject.set(who, [...(perProject.get(who) || []), ...(names.length ? names : ["?"])]);
    }
    const count = [...perProject.values()].reduce((n, l) => n + l.length, 0);
    return `${count} — ${[...perProject].map(([who, names]) => `${who}: ${names.join(", ")}`).join("; ")}`;
  };
  const running = list.filter((x) => x?.running === true);
  const stopped = list.filter((x) => x?.running === false);
  const withoutState = list.filter((x) => typeof x?.running !== "boolean");
  const parts = [];
  if (running.length) parts.push(`${group(running)} — running in B next to the project container (stop by hand)`);
  if (withoutState.length) parts.push(`${group(withoutState)} — state unknown (backend without field \`running\`), possibly active in B next to the project container (check)`);
  if (stopped.length) parts.push(`${running.length || withoutState.length ? "plus " : "0 running; "}${group(stopped)} — stopped, remainder in B (e.g. a one-shot container of the relocation; remove at will)`);
  return [label, parts.join("; "), running.length || withoutState.length ? "warn" : null];
}
