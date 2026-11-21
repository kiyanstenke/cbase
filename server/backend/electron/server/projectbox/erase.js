// The delete paths of the project containers: project and workspace. Callers: `projectDelete` (below — the ONE path for BOTH
// project delete routes, `DELETE /api/projects/:id` in projects/routes.js and `DELETE /api/workspaces/:wid/projects/:pid` in
// workspaces/routes.js) and `DELETE /api/workspaces/:id` (workspaces/routes.js), each BEFORE its ordinary path: if it fails here,
// the route deletes nothing. Whoever else calls `store.deleteProject` turns the guard in server/backend/test/projectbox-delete.test.js red.
//
// TWO RULES. After deletion no container of the project runs any more (otherwise a stack would keep running orphaned, known to no
// row). And "discarding is not deleting": the volume `cbase-p-<id>-docker` (the inner Docker with images, databases, stack
// volumes) and the runtime folder `<data>/projects/<id>/` (CLI home with transcripts, scratch, attachments, outputs) go ONLY with the
// same explicit option that deletes the project folder: `purge=1`.
//
// deleteProjectbox(projectIds, { purge, sessionsToB })  → one of
//   { fields: {} }                               no project has an instance row — the ordinary path, unchanged: no docker call, no
//                                                file, the answer of the route without a new field; only with purge the folders of the
//                                                copies go (step 9), if any, and with and without purge the relocation folder (step
//                                                9b), if any;
//   { fields: { projectContainer: [report] } }   removed; the route deletes afterwards as usual and attaches the field;
//   { response: { status, body } }               409 (see below) or 500 — the route answers with it and deletes NOTHING.
//   All projects with a row together, as the ONLY flow that creates or removes their containers (instance.js withProjectOccupancy,
//   held for all), in three phases (a failure at a later project must not leave the earlier ones already rolled back):
//     0. only when deleting ONE project (`sessionsToB`, projectDelete — its chats survive it, unlike with a workspace): every CLI
//        session in the home of the project to B (runs/session-location.js fetchSessionsOfTheProjectBack; without the row nobody
//        searches there any more, with purge it would go with the runtime folder);
//     PHASE 1, reversible — per project:
//     1. only with purge: the runtime folder while the container still runs — EVERY entry through the container itself (cleanUp.js
//        removeAsRoot, `rm -rf` as root: also what belongs to root; after its end that would not work). NEVER in B: B would delete
//        recursively over path names (`fs.rmSync` is a JS rimraf in Node 22) in a tree the running container writes at the same time
//        — a subfolder swapped for a link mid-delete would make B delete its target in B (DB, login, other projects). What the
//        container does not remove stays for step 6;
//     2. every container of the project — the id of the row AND every one with label `cbase.project=<id>` ON the container (also one
//        that a failed creation made but never wrote into the row; one that inherits the label only from its image is none and
//        stays, with a notice) — `stop -t 30`; a "No such container" is already done. Any other error aborts: the containers already
//        stopped that were running start again (`docker start` by id — the same way as after a server restart), 500 "nothing
//        removed"; rows, networks, volumes, all projects stay — only a runtime folder already emptied with purge does not (the
//        message says so);
//     PHASE 2, final — per project:
//     3. `rm -f` by id;
//     4. every network with the label of the project: `network rm` by id (a failure is a notice: the network only occupies its /24);
//     5. only with purge: `volume rm`;
//     6. only with purge: the rest of the runtime folder (what arose between 1 and 2 or what the container did not remove in 1) —
//        now in B, since no container of the project runs any more that could write into it; what remains (e.g. a rest that belongs
//        to root) goes into the report;
//     7. as a check: a container with the label that is still there now is an error (500);
//     If 3 or 7 fails, ALL rows stay (also those of the projects already removed — the message names them), so a second attempt does
//     not take the ordinary path (no row, no docker call) and lets the rest run;
//     PHASE 3 — 8. the rows of ALL projects, only when every check has passed: from here on every switch of the projects takes the
//        ordinary path again;
//     9. only with purge, only after success: the folders of the copies of the project — `<data>/copies-backup/<pid>/` (bundles of
//        new repos, `ignored.tar` with `.env` and keys; they survive the clearing away and go only "with the project and purge=1")
//        and `<data>/copies/<pid>`. The places come through the connector `setCopiesLocations` (server.js → stacks/location.js
//        projectCopiesLocation; projectbox/ never imports stacks/). Link-proof: a link in their place goes as a link (lstat, then
//        unlink), its target stays; deleted only when no container of the project stands any more (phase 2, check 7) and no copy
//        lives (copy step). What remains goes into the report (`leftBehind`, notice); without a row (`{ fields: {} }`) onto stderr —
//        the answer stays word for word. A 409/500 leaves both standing.
//     9b. WITH AND WITHOUT purge, only after success: `<data>/relocations/<pid>/` (journal.js relocationFolderOf) for EVERY project
//        of the list, also one without a row (a relocation that went back through the way back left the folder without a row). The
//        only exception from "discarding is not deleting": a deleted project no longer needs the way back of a relocation — without
//        purge its project folder stays with the rewritten `.env*`. Link-proof like step 9 (the folder is never mounted, creation.js
//        neverMounted). If a relocation journal is still OPEN (store.openRelocation), the folder stays with a notice — the way back
//        lies there. The rows in `project_relocations` stay. What remains goes into the report resp. onto stderr; a 409/500 leaves it.
//   After that, once for all: the block in /etc/hosts (names.js bringAlongNames — without the row the name goes).
//   409 before anything happens if an instance of one of the projects stands in `create`, `relocation` or `recreate`, a flow works
//   on it (instances.js procedureAlive — e.g. the restore) or a creation or another deletion of the project runs (instance.js
//   projectOccupied): otherwise the deletion would remove the container of an unsecured step, and that step would then write back a
//   row for which no project exists any more. FIRST: 409 while a copy of one of the projects lives (`store.liveStackCopies`, every
//   row in stack_copies except `removed` — also waiting or ready).
//   THE COPY STEP stands before that, HERE — both ways (project and workspace) call this function: if a copy of one of the projects
//   lives, the connector `setCopyDeleteStep` (server.js → stacks/remove.js copyDeleteStep) triggers the clearing away for EACH (with
//   fetch and backup, also with purge=1 — a way without fetching would be a second clearing-away path) and answers 409 "Copy <name>
//   is being cleared away — delete again afterwards" with the list; NOTHING is deleted. Without a living copy the deletion goes on as
//   before. Without the connector (tests without server) the 409 of deleteLock stays — never a deletion over a living copy.
//   WITHOUT the ops marker no docker call: there is then no inner Docker, so no container that could run; the row falls anyway
//   (otherwise it would hang without a project), with purge the runtime folder without the root fallback.
//   ONLY WHEN IDLE: a RELOCATED project (ops marker AND `converted_at`) is deleted only if nothing is working in it — the same lock
//   as relocation and recreation (idle.js projectLocks, reason "erase": set the lock, THEN check idle). If something is open (a turn,
//   a subagent, a workflow, a waiting row, … — idle.js projectIdle), the route answers 409 with the reasons (`open`) and deletes
//   NOTHING. FIRST lock and check ALL projects, THEN end the terminals of the project and its chats (with notice; a 409 at the second
//   project would otherwise leave the shells of the first already ended). The lock holds over the whole deletion (a start in the
//   meantime waits instead of going into a container that is just falling) and is released at the end — also after an abort and after
//   a throw while locking itself; the transition wakes what waited (afterwards without a row: in B). A project without a row or
//   without `converted_at` deletes as before.
//
// projectDelete({ workspaceId, projectId, project, purge })  → { status, body }  the way of both project delete routes:
//   deleteProjectbox (with `sessionsToB`), with `response` back, otherwise store.deleteProject and with purge the project folder —
//   without an instance row word for word the answer from before project containers. A project of ANOTHER workspace (only the
//   workspace sub-route can ask for it) is 404, and NOTHING is deleted: store.deleteProject(wid, pid) would otherwise delete context,
//   agents, skills, workflows, facts and services of the foreign project — only the row in `projects` checks the workspace —, with
//   purge=1 also its folder, and answer 200. Independent of row and ops marker: that is an error, no no-op question. An unknown
//   project stays as before (200, there is nothing foreign to hit).
//
// report = { projectId, instances: [identifier], ops, container: [id], networks: [id], volume: "removed"|"stays"|"missing",
//            runtime: "removed"|"partial"|"stays"|"missing", leftBehind: [path], notices: [sentence],
//            sessionsToB?: number (only when deleting a project: so many sessions moved to B) }
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { locationFor } from "../runs/runtime-location.js";
import { fetchSessionsOfTheProjectBack } from "../runs/session-location.js";
import { purgeProjectDir } from "../workspaces/git-auth.js";
import { LABEL_PROJECT, STOP_DEADLINE_S, copyInstance, volumeName } from "./creation.js";
import { removeAsRoot } from "./cleanUp.js";
import { projectboxOps } from "./ops.js";
import { DockerError, docker } from "./docker.js";
import { ownKey } from "./own-labels.js";
import { occupancyOfProject, occupancySentence, withProjectOccupancy } from "./instance.js";
import { procedureAlive } from "./instances.js";
import { relocationFolderOf } from "./journal.js";
import { projectLocks } from "./idle.js";
import { bringAlongNames } from "./names.js";
import { T } from "../i18n.js";
import { abortOuterLoop } from "../outerloop/abort.js";
import { forgetUpload } from "../runtime/upload-stamp.js";
import { removeArchiveFiles } from "./setup/archive.js";

/** The states in which nothing is deleted: an unsecured step belongs to its flow. Also `clearAway` — the clearing-away path of a copy
 *  fetches and backs up first, a deletion in between would lose both. */
export const DELETE_LOCK = Object.freeze(["create", "relocation", "recreate", "clearAway"]);
// Cap at `stop`: the deadline of the container (30 s) plus air for docker itself (it reports that it was a cap).
const STOP_CAP_MS = (STOP_DEADLINE_S + 30) * 1000;

class DeleteError extends Error {
  constructor(message, { projectId = null, removed = [] } = {}) {
    super(message);
    this.name = "DeleteError";
    this.status = 500;
    this.projectId = projectId;
    this.removed = removed; // the reports of the projects whose containers are already removed (phase 2)
  }
}

const missing = (e) => e instanceof DockerError && /No such (object|container|network|volume)|not found/i.test(`${e.stderr}\n${e.message}`);
const ids = (text) => String(text || "").split(/\s+/).filter(Boolean);
// Ids from two sources (the full one of the row, the one from `ps`): a prefix of one already named is the same.
function withoutDuplicates(list) {
  const out = [];
  for (const id of [...list].sort((a, b) => b.length - a.length)) if (!out.some((x) => x.startsWith(id))) out.push(id);
  return out;
}
const short = (id) => String(id).slice(0, 12);

// `--filter label=cbase.project=<pid>` also hits a container that only INHERITS the label from its image (e.g. from an image made by
// `docker commit` from a project container) — a user container, no project container. Only what carries `cbase.project` ON the
// container (own-labels.js) is stopped, removed and counted in the check (7.). A container that cannot be read stays in the set
// (nothing is ever overlooked). → { own, inherited }. The teardown of a copy (stacks/clearAway.js) also removes only what is so own —
// ONE filter.
export async function onlyOwn(idsList) {
  if (!idsList.length) return { own: idsList, inherited: [] };
  let text;
  try { text = (await docker(["inspect", "--type", "container", "--format", "{{.Id}} {{.Image}} {{json .Config.Labels}}", ...idsList])).stdout; }
  catch (e) { if (!missing(e)) throw e; text = e.stdout; }
  const info = [];
  for (const z of String(text || "").split("\n")) {
    const m = /^([0-9a-f]{64}) (\S*) (.*)$/.exec(z.trim());
    if (!m) continue;
    try { info.push({ id: m[1], image: m[2], labels: JSON.parse(m[3]) || {} }); } catch { /* unreadable: stays in the set */ }
  }
  const imageLabels = new Map();
  for (const b of [...new Set(info.map((x) => x.image).filter(Boolean))]) {
    try {
      const l = JSON.parse(String((await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", b])).stdout).trim() || "null");
      imageLabels.set(b, l && typeof l === "object" ? l : {});
    } catch (e) { if (!(e instanceof DockerError)) throw e; /* unknown: the label alone counts */ }
  }
  const inherited = idsList.filter((id) => {
    const i = info.find((x) => x.id === id || x.id.startsWith(id));
    return i && !ownKey(i.labels, imageLabels.has(i.image) ? imageLabels.get(i.image) : null).includes(LABEL_PROJECT);
  });
  return { own: idsList.filter((id) => !inherited.includes(id)), inherited };
}

// The instance of a copy for the sentence — a name outside the form (possible only directly through the store) locks all the same,
// instead of losing the verdict with a throw.
const copyIdentifier = (name) => { try { return copyInstance(name); } catch { return T`copy “${name}”`; } };

/** The verdict before every deletion: null = free, else `{ projectId, error }` (409). Only reads, changes nothing. */
export function deleteLock(projectIds) {
  for (const pid of projectIds.map(String)) {
    // A LIVING copy (row in stack_copies, `state != 'removed'`) locks — also waiting or ready, where no or no working instance row
    // stands yet. Before this the copy step triggers the clearing away (deleteProjectbox); a living copy arrives here only without
    // its connector — then it stays a 409. Identifiers and words, never a value.
    const copies = store.liveStackCopies(pid);
    if (copies.length) {
      const list = copies.map((k) => `${copyIdentifier(k.name)} (${k.state}${k.phase ? `, ${k.phase}` : ""})`).join(", ");
      return { projectId: pid, error: T`Project ${pid}: ${copies.length === 1 ? T("a copy is still alive") : T`${copies.length} copies are still alive`} — ${list}; delete only after clearing away` };
    }
    // Every occupation of any kind, named through the ONE sentence (instance.js occupancySentence). A layout job in `running` or
    // `error` after the turn is an occupation — the tree is (half) rebuilt. One in `waiting` is taken over by the delete lock
    // (projectLocks, `replaceLayout`) and withdrawn only after success (setupsGone, `setLayoutRevert`).
    const g = store.layoutJob(pid);
    if (g && (g.state === "running" || (g.state === "error" && g.turned))) {
      return { projectId: pid, code: "OCCUPIED", error: T`Project ${pid}: the layout is being adopted (${g.state}${g.step ? T`, step “${g.step}”` : ""}) — delete only afterwards` };
    }
    const occupied = occupancyOfProject(pid);
    if (occupied) {
      const where = occupied.instance ? T`at project container ${store.instanceIdentifier(pid, occupied.instance)}` : T("at the project container");
      const set = occupied.what === "erase" ? T("another deletion") : occupancySentence(occupied.what);
      // With `code` OCCUPIED — the row of the setup locks "delete" by it.
      return { projectId: pid, code: "OCCUPIED", error: T`Project ${pid}: ${where} ${set} is running — delete only afterwards` };
    }
    for (const z of store.projectInstancesOf(pid)) {
      if (DELETE_LOCK.includes(z.state)) return { projectId: pid, error: T`Project container ${z.identifier} is in “${z.state}”${z.phase ? T` (phase “${z.phase}”)` : ""} — delete only afterwards` };
      if (procedureAlive(pid, z.instance)) return { projectId: pid, error: T`A flow is working on project container ${z.identifier} (“${z.state}”) — delete only afterwards` };
    }
  }
  return null;
}

// The copy step (see header): fn(projectIds, { purge, way }) → null (no living copy) or `{ status, body }` (409, the clearing away is
// triggered). projectbox/ never imports stacks/ — a setter from server.js.
let copyDeleteStep = null;
export function setCopyDeleteStep(fn) { copyDeleteStep = typeof fn === "function" ? fn : null; }

// "One lock per project; deleting withdraws a waiting job only after success": fn(projectId) → whether a waiting layout job was
// withdrawn (projectbox/layout/job.js). A setter from server.js, so erase.js does not import the job. Called only AFTER success
// (setupsGone): withdrawing before the idle check would wake the held turns by its release, the check would find them and answer 409,
// and the confirmed job would be gone all the same. The reserved lock is taken over by that of the deletion (projectLocks
// `replaceLayout`: without waking, back on refusal or abort).
let layoutRevert = null;
export function setLayoutRevert(fn) { layoutRevert = typeof fn === "function" ? fn : null; }

// Step 9 (header): fn(projectId) → [path, …] — the folders of the copies of the project (`copies-backup/<pid>`, `copies/<pid>`).
// projectbox/ never imports stacks/ — a setter from server.js. Without the connector (tests without server) none of it goes.
let copiesLocations = null;
export function setCopiesLocations(fn) { copiesLocations = typeof fn === "function" ? fn : null; }

// What remains in step 9/9b: into the report, without a report (ordinary path, `{ fields: {} }`) onto stderr.
const reportFor = (pid, report) => (set, filePath) => {
  if (!report) { console.warn(`[projectbox] deletion ${pid}: ${set}`); return; }
  report.notices.push(set);
  if (filePath && !report.leftBehind.includes(filePath)) report.leftBehind.push(filePath);
};

// Remove ONE place in B, link-proof: a link (or a file) in its place goes itself — its target never; afterwards the check. Only for
// places no container mounts (step 9: only after phase 2; step 9b: never mounted). Never throws.
function removeLocationInB(location, report) {
  let st;
  try { st = fs.lstatSync(location); } catch (e) { if (e?.code !== "ENOENT") report(T`${location} not readable (${e?.code || e?.message}) — stays`, location); return; }
  try {
    if (st.isDirectory()) fs.rmSync(location, { recursive: true, force: true });
    else fs.unlinkSync(location);
  } catch (e) { report(T`${location} not removed entirely (${e?.code || e?.message}) — stays`, location); return; }
  try { fs.lstatSync(location); report(T`${location} still exists after the removal — stays`, location); } catch { /* gone */ }
}

/** Step 9 (header) for ONE project — link-proof, never throws. `report` null: what remains goes onto stderr (ordinary path). */
function copiesLocationsRemove(pid, report) {
  if (!copiesLocations) return;
  const report2 = reportFor(pid, report);
  let locations;
  try { locations = [...(copiesLocations(pid) || [])]; } catch (e) { report2(T`Folders of the copies cannot be determined: ${e?.message || e}`, null); return; }
  for (const location of locations) removeLocationInB(location, report2);
}

/**
 * Step 9b (header) for ONE project: its relocation folder `<data>/relocations/<pid>/` — independent of purge. If a still OPEN
 * relocation journal of the project exists, it stays with a notice: the way back with the `.env` backup lies there (the deletion
 * usually locks beforehand in this state, DELETE_LOCK "relocation"). The rows in `project_relocations` stay. Link-proof, never
 * throws. `report` null: what remains goes onto stderr (ordinary path).
 */
function relocationFolderRemove(pid, report) {
  const report2 = reportFor(pid, report);
  let location;
  try { location = relocationFolderOf({ data: DIRS.data, projectId: String(pid) }); } catch (e) { report2(T`Relocation folder cannot be determined: ${e?.message || e}`, null); return; }
  let open;
  try { open = store.openRelocation(pid); } catch (e) { report2(T`${location} stays — the relocation journal is not readable (${e?.message || e})`, location); return; }
  if (open) {
    try { fs.lstatSync(location); } catch { return; } // nothing there, nothing to report
    report2(T`${location} stays — a relocation of the project is still open (journal ${open.id}): its way back with the .env backup lies there`, location);
    return;
  }
  removeLocationInB(location, report2);
}

// Release every held lock — one whose waking throws does not hold up the others (its lock is gone by then).
function releaseAll(held) {
  for (const s of held) {
    try { s.resolve(); } catch (e) { console.error(`[projectbox] lock not released cleanly: ${e?.message || e}`); }
  }
}

/**
 * The lock of the RELOCATED projects (header, "Only when idle"): first per project `projectLocks(…, "erase")` WITHOUT ending the
 * terminals, then — when ALL are quiet — the terminals. `{ lock }` (to release when the deletion ends) or `{ response }` (409 with the
 * open reasons; locks already set are released, no shell ended). A throw releases all already held and flies on. Without the ops marker
 * none — then nothing starts in a project container.
 */
function idleLocks(projectIds) {
  const held = [];
  if (!projectboxOps()) return { lock: held };
  try {
    for (const pid of projectIds) {
      if (!store.converted(pid)) continue;
      const s = projectLocks(pid, { reason: "erase", terminalsLater: true, replaceLayout: true });
      if (s.ok) { held.push(s); continue; }
      releaseAll(held);
      const open = s.open || [];
      const reasons = open.map((o) => String(o.text || o.reason).trim()).filter(Boolean).join(" ");
      // A waiting layout job stays on refusal — the sentence says so (the held turns, which are often the reason for the refusal,
      // belong to it).
      let layout = "";
      try { if (store.layoutJob(pid)?.state === "waiting") layout = T(" The waiting layout job stays — whoever wants to delete now withdraws it first."); } catch { layout = ""; }
      return { response: { status: 409, body: {
        error: T`Project ${pid} is not idle${reasons ? ` — ${reasons}` : ""} Delete only when nothing is working there any more.${layout}`,
        projectId: pid, open,
      } } };
    }
    for (const s of held) s.endTerminals();
  } catch (e) {
    releaseAll(held);
    throw e;
  }
  return { lock: held };
}

// ── Runtime folder (only with purge) ───────────────────────────────────────────────────────────────────────────────

const permissionsError = (e) => e?.code === "EACCES" || e?.code === "EPERM";

/** Remove every entry of the runtime folder as the server; what belongs to root, back. ONLY without a running container of the
 *  project (step 6 and operation without a marker) — never while it runs (guard server/backend/test/projectbox-rm-in-b.test.js). */
function runtimeAsServer(root, lying) {
  let names;
  try { names = fs.readdirSync(root); } catch (e) {
    if (e?.code !== "ENOENT") lying.push(`${root} (${e?.code || e?.message})`);
    return [];
  }
  const rootOwn = [];
  for (const n of names) {
    const p = path.join(root, n);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {
      if (permissionsError(e)) rootOwn.push(p); else lying.push(`${p} (${e?.code || e?.message})`);
    }
  }
  return rootOwn;
}

/** The entries of the top level (for step 1 — names only, B deletes nothing). Unreadable: a notice, no entries. */
function runtimeEntries(root, notices) {
  try { return fs.readdirSync(root).map((n) => path.join(root, n)); } catch (e) {
    if (e?.code !== "ENOENT") notices.push(T`${root} not readable (${e?.code || e?.message}) — step 6 clears it after the container has ended`);
    return [];
  }
}

/** The last attempt, root included; what then still lies goes into the report (`runtime: "partial"`). */
function runtimeLast(root, report) {
  for (const p of runtimeAsServer(root, report.leftBehind)) report.notices.push(T`${p} belongs to root and stays — without a running project container nobody clears it as root`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* counted below */ }
  if (fs.existsSync(root)) {
    let rest;
    try { rest = fs.readdirSync(root).map((n) => path.join(root, n)); } catch { rest = [root]; }
    for (const p of rest.length ? rest : [root]) if (!report.leftBehind.some((x) => x === p || x.startsWith(`${p} `))) report.leftBehind.push(p);
  }
  if (report.leftBehind.length) report.runtime = "partial";
}

// ── The phases ─────────────────────────────────────────────────────────────────────────────────────────────────────

function plan(pid, { purge, ops }) {
  const rows = store.projectInstancesOf(pid);
  const location = locationFor({ projectId: pid, converted: true });
  const runtimeExists = fs.existsSync(location.root);
  return {
    pid, rows, location, runtimeExists, container: [], filter: `label=${LABEL_PROJECT}=${pid}`,
    report: {
      projectId: pid, instances: rows.map((z) => z.identifier), ops, container: [], networks: [],
      volume: purge ? "missing" : "stays", runtime: purge ? (runtimeExists ? "removed" : "missing") : "stays", leftBehind: [], notices: [],
    },
  };
}

// 0. The sessions to B (header) — the report counts what moved and names what did not.
function sessionsAfterBFetch(p) {
  const turns = fetchSessionsOfTheProjectBack(p.pid);
  p.report.sessionsToB = turns.filter((z) => z.status === "copied").length;
  for (const z of turns.filter((x) => x.status === "error")) p.report.notices.push(T`Session ${z.sid} (${z.kind}) not fetched to B: ${z.error}`);
}

// Way back of phase 1: start the stopped containers that were running before again. Returns: the sentence for the message.
async function againStart(stopped) {
  const ran = stopped.filter((c) => c.ran);
  if (!ran.length) return "";
  const not = [];
  for (const c of ran) {
    try { await docker(["start", c.id]); } catch (e) { not.push(`${short(c.id)} (${e?.message || e})`); }
  }
  const again = ran.length - not.length;
  return `${again ? T`, ${again} container(s) that were already stopped started again` : ""}${not.length ? T`, NOT started again: ${not.join(", ")}` : ""}`;
}

// PHASE 1 (header): per project find the containers, with purge the runtime folder, then stop — a failure starts again what ran, and
// throws.
async function stopAll(plans, { purge }) {
  const stopped = [];
  const cleared = [];
  for (const p of plans) {
    const found = await onlyOwn(ids((await docker(["ps", "-aq", "--no-trunc", "--filter", p.filter])).stdout));
    const all = found.own;
    for (const id of found.inherited) p.report.notices.push(T`Container ${short(id)} carries ${LABEL_PROJECT}=${p.pid} only from its image — no project container, stays`);
    // What RUNS (only its stop is taken back on the way back — one already ended stays ended).
    const running = ids((await docker(["ps", "-q", "--no-trunc", "--filter", p.filter])).stdout);
    p.container = withoutDuplicates([...p.rows.map((z) => z.containerId).filter(Boolean), ...all])
      .map((id) => ({ id, ran: running.some((l) => l.startsWith(id) || id.startsWith(l)) }));

    // 1. The runtime folder while the container runs — EVERY entry through the container, never in B (header). B reads only the names
    //    of the top level here (`<data>/projects/<pid>` itself cannot be replaced in the container: it is mounted, not its parent
    //    folder). What remains, step 6 tries once more after the container is removed.
    if (purge && p.runtimeExists) {
      const not = [];
      for (const filePath of runtimeEntries(p.location.root, p.report.notices)) {
        let ok = false;
        try { ok = await removeAsRoot({ projectId: p.pid, path: filePath }); } catch (e) { p.report.notices.push(`${filePath}: ${e?.message || e}`); }
        if (!ok) not.push(filePath);
      }
      if (not.length) p.report.notices.push(T`${not.join(", ")}: could not be removed through the project container (was it running?) — step 6 clears it in B after its end`);
      cleared.push(p.pid);
    }

    // 2. Stop the containers in order.
    for (const c of p.container) {
      try {
        await docker(["stop", "-t", String(STOP_DEADLINE_S), c.id], { capMs: STOP_CAP_MS });
        stopped.push(c);
      } catch (e) {
        if (missing(e)) continue;
        const back = await againStart(stopped);
        throw new DeleteError(T`Project container ${short(c.id)} of ${p.pid} not stopped: ${e.message} — nothing removed${back}; `
          + T`row, network and volume stay, the project too${cleared.length ? T` (the runtime folder of ${cleared.join(", ")} is already emptied — purge)` : ""}`, { projectId: p.pid });
      }
    }
  }
}

// PHASE 2 (header) for ONE project whose containers are all stopped. `removed`: those already removed completely before.
async function removeStopped(p, { purge, removed }) {
  const alreadyRemoved = () => `${T("the row stays")}${removed.length ? T` — also those of ${removed.map((x) => x.pid).join(", ")}, whose containers are already removed` : ""}`
    + T("; a second attempt clears on, the project stays too");
  const reports = () => removed.map((x) => x.report);

  // 3. Remove the containers by id.
  for (const c of p.container) {
    try { await docker(["rm", "-f", c.id]); } catch (e) {
      if (!missing(e)) throw new DeleteError(T`Project container ${short(c.id)} of ${p.pid} stopped but not removed: ${e.message} — ${alreadyRemoved()}`, { projectId: p.pid, removed: reports() });
    }
    p.report.container.push(c.id);
  }

  // 4. The networks of the project, by id.
  let networks = [];
  try { networks = ids((await docker(["network", "ls", "-q", "--no-trunc", "--filter", p.filter])).stdout); }
  catch (e) { p.report.notices.push(T`Networks not readable: ${e.message}`); }
  for (const id of networks) {
    try { await docker(["network", "rm", id]); p.report.networks.push(id); } catch (e) {
      if (missing(e)) p.report.networks.push(id);
      else p.report.notices.push(T`Network ${short(id)} stays: ${e.message}`);
    }
  }

  // 5. The volumes — only explicitly. Those of ALL instances: that of the main by its name (the report's `volume` means it), every
  //    further one (copies, `cbase-k-<pid>-<name>-docker`) by the label of the project; a further one that stays goes into the notices.
  if (purge) {
    let additional = [];
    try { additional = ids((await docker(["volume", "ls", "-q", "--filter", p.filter])).stdout).filter((n) => n !== volumeName(p.pid)); }
    catch (e) { p.report.notices.push(T`Volumes not readable: ${e.message}`); }
    try { await docker(["volume", "rm", volumeName(p.pid)]); p.report.volume = "removed"; } catch (e) {
      if (!missing(e)) { p.report.volume = "stays"; p.report.notices.push(T`Volume ${volumeName(p.pid)} stays: ${e.message}`); }
    }
    for (const name of additional) {
      try { await docker(["volume", "rm", name]); } catch (e) {
        if (!missing(e)) p.report.notices.push(T`Volume ${name} stays: ${e.message}`);
      }
    }
  }

  // 6. The rest of the runtime folder.
  if (purge && p.runtimeExists) runtimeLast(p.location.root, p.report);

  // 7. The check: no container of the project is there any more. BEFORE the rows — if a row fell first, a second attempt would take
  //    the ordinary path (no row, no docker call), and the remaining container would run forever.
  const rest = (await onlyOwn(ids((await docker(["ps", "-aq", "--no-trunc", "--filter", p.filter])).stdout))).own;
  if (rest.length) throw new DeleteError(T`After the deletion, containers of ${p.pid} are still there: ${rest.map(short).join(", ")} — ${alreadyRemoved()}`, { projectId: p.pid, removed: reports() });
}

async function removeAll(pids, { purge, sessionsToB }) {
  const ops = projectboxOps();
  const plans = pids.map((pid) => plan(pid, { purge, ops }));
  if (sessionsToB) for (const p of plans) sessionsAfterBFetch(p);
  if (!ops) {
    for (const p of plans) {
      p.report.notices.push(T("no server operation — no docker call (without an inner Docker no project container runs)"));
      store.deleteProjectInstance(p.pid);
      if (purge && p.runtimeExists) runtimeLast(p.location.root, p.report);
    }
    return plans.map((p) => p.report);
  }
  await stopAll(plans, { purge });
  const removed = [];
  for (const p of plans) {
    await removeStopped(p, { purge, removed });
    removed.push(p);
  }
  // 8. The rows — only now, for all.
  for (const p of plans) store.deleteProjectInstance(p.pid);
  return plans.map((p) => p.report);
}

// The four tables of the setup (setup, sources, archives, upload operations) go with the project — on BOTH ways (project and
// workspace), after success, also without an instance row. The archive files lie in the runtime folder of the project
// (setup/archive-<id>.zip); with purge it goes entirely, without it stays like every runtime folder — the archive files go here all
// the same, after their rows (deleteSetup returns the ids). If B dies in between, the restart-grace hook "project-archive"
// (setup/archive.js) clears the files without a row.
function setupsGone(list) {
  for (const pid of list) {
    try { removeArchiveFiles(pid, store.deleteSetup(pid)); } catch (e) { console.error(`[projectbox] deletion ${pid}: setup not removed: ${e?.message || e}`); }
    forgetUpload(pid);
    // The layout job and the superseded containers — with the project, after success. A waiting job goes through the withdrawal (it
    // releases its reservation and forgets its beat), THEN the rows.
    if (layoutRevert) {
      try { if (layoutRevert(pid)) console.log(`[projectbox] deletion ${pid}: waiting layout job withdrawn`); } catch (e) { console.error(`[projectbox] deletion ${pid}: layout job not withdrawn: ${e?.message || e}`); }
    }
    try { store.deleteLayout(pid); } catch (e) { console.error(`[projectbox] deletion ${pid}: layout not removed: ${e?.message || e}`); }
  }
}

// The occupation of ALL projects over the whole deletion (set synchronously: between deleteLock and here there is no await).
const withOccupancy = (pids, fn) => (pids.length ? withProjectOccupancy(pids[0], "erase", () => withOccupancy(pids.slice(1), fn)) : fn());

// ── The route entries ──────────────────────────────────────────────────────────────────────────────────────────────

/** See header. `projectIds`: the projects that are about to be deleted (one, resp. all of a workspace). */
export async function deleteProjectbox(projectIds, { purge = false, sessionsToB = false, way = "workspace", hold = null } = {}) {
  const list = [...new Set((projectIds || []).map(String))];
  // First the copies — if one lives, it is cleared away and the route answers 409 (nothing deleted).
  const copies = copyDeleteStep ? copyDeleteStep(list, { purge, way }) : null;
  if (copies) return { response: copies };
  const lock = deleteLock(list);
  if (lock) return { response: { status: 409, body: { error: lock.error, projectId: lock.projectId, ...(lock.code ? { code: lock.code } : {}) } } };
  const idle = idleLocks(list);
  if (idle.response) return { response: idle.response };
  try {
    const withRow = list.filter((pid) => store.projectInstancesOf(pid).length > 0);
    if (!withRow.length) {
      // Step 9 also without a row (e.g. after an earlier deletion without purge): no docker, no new answer field.
      if (purge) for (const pid of list) copiesLocationsRemove(pid, null);
      // Step 9b likewise — with and without purge: a relocation that went back through the way back left the folder without a row.
      for (const pid of list) relocationFolderRemove(pid, null);
      setupsGone(list);
      return { fields: {} };
    }
    let reports = [];
    let response = null;
    try {
      reports = await withOccupancy(withRow, () => removeAll(withRow, { purge, sessionsToB }));
    } catch (e) {
      console.error(`[projectbox] deletion ${e?.projectId || withRow.join(", ")}: ${e?.message || e}`);
      response = { status: e?.status || 500, body: { error: e?.message || String(e), projectId: e?.projectId || withRow[0], projectContainer: e?.removed || [] } };
    }
    // 9. The folders of the copies — only with purge, only after success (header): a 409/500 leaves them standing.
    if (purge && !response) for (const b of reports) copiesLocationsRemove(b.projectId, b);
    // 9b. The relocation folders — after success, with and without purge, for EVERY project of the list: also a workspace project
    //     without a row (it reports onto stderr, its answer stays word for word).
    if (!response) for (const pid of list) relocationFolderRemove(pid, reports.find((b) => b.projectId === pid) || null);
    if (!response) setupsGone(list);
    // The block in /etc/hosts — also after an abort (then it changes nothing: the rows still stand).
    try { bringAlongNames(); } catch (e) { console.warn(`[projectbox] deletion: names not brought along: ${e?.message || e}`); }
    return response ? { response } : { fields: { projectContainer: reports } };
  } finally {
    // Released when the rows are gone (or the deletion aborted): the transition wakes what waited during the deletion. `hold`: the
    // workspace deletion releases ITSELF, only after its close path — released here, the transition would wake a waiting turn before its
    // chats fall (it would run in B under a deleted chat). Whoever passes `hold` MUST call `hold.resolve()`, also after a refusal
    // (workspaces/routes.js, finally).
    if (hold) hold.resolve = () => releaseAll(idle.lock);
    else releaseAll(idle.lock);
  }
}

/**
/**
 * The ONE way to delete a project (header) — `DELETE /api/projects/:id` and `DELETE /api/workspaces/:wid/projects/:pid`.
 * @param {{ workspaceId: string, projectId: string, project: object|null, purge: boolean }} o  `project`: store.getProject
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function projectDelete({ workspaceId, projectId, project = null, purge = false }) {
  if (project && String(project.workspaceId) !== String(workspaceId)) return { status: 404, body: { error: "project not found" } };
  const box = await deleteProjectbox([projectId], { purge, sessionsToB: true, way: "project" });
  if (box.response) return box.response;
  // The running outer-loop runs of the project agents end BEFORE their rows (deleting ends them, no 409) — rows to "aborted", cores
  // silent; the rows are taken by store.deleteProject.
  abortOuterLoop({ agentIds: store.outerLoopAgentsOf(workspaceId).filter((a) => a.projectId === projectId).map((a) => a.id), reason: T("Project deleted") });
  store.deleteProject(workspaceId, projectId);
  const purged = purge && project ? purgeProjectDir(project.path) : false;
  return { status: 200, body: { ok: true, purged, note: purged ? T("Folder deleted.") : T("Folder is kept."), ...box.fields } };
}
