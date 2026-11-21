// The procedure of a setup (the creation of a new project in server operation).
//
// SEQUENCE: `container` → `sources` (until every source is `staged` or `leftOut`) → `place` → `code-repos` →
// `project-repo` → row gone → event → service detection (not for an empty project). Without sources it goes from
// `container` straight to `code-repos` or `project-repo`.
//
//   startSetup(projectId)        after the POST (workspaces/routes.js through ./routes.js projectCreateInOps).
//   resumeSetup(projectId)       the consumer of `atReady` AND of the end of a successful recreate (both wired in
//                                server.js); also after `finished`, `leaveOut` and the conflict answer from ./routes.js.
//                                Starts when the setup is in `setUp`, does not wait and no procedure holds it.
//   setupAgain(projectId)        "Try again" (route `…/setup/again`) → `{ status, body }`.
//   conflictResponse(projectId, mode)  the conflict answer (route `…/setup/conflict`) → `{ status, body }`.
//   abortSource(projectId, seq)   route `…/setup/sources/:seq/abort` → `{ status, body }`.
//   setupStorageCandidates()     the source "setup" of the storage queue (server.js).
//   setSetupSaveGate(fn)         seam: fn() → true when the save gate allows a start NOW (a test puts a gate there).
//   setSetupHint(fn)             seam: fn({ projectId, title, text }) reports what unpacking did not create without the
//                                source failing (a link pointing out of the project; a dead `.git` file) — in server.js
//                                the bell. Unset: only the log. ./upload.js reports through the same seam
//                                (`reportSetupHint`) and with the same wording of a rejection (`deniedText`).
//   The service detection after the end is triggered through ../detection.js detectServices(pid). Its waiting runs are a
//   source of their OWN in the storage queue — see README "Storage queue".
//
// AT MOST ONE PROCEDURE PER PROJECT (own map `runs`): a second nudge while one runs sets `rerun`, and the running one
// does another round afterwards. A server step (`container`, `place`, `code-repos`, `project-repo`) writes `process` =
// the boot id of this process BEFOREHAND (app-state.js BOOT_ID, new per startServer) and runs under the project
// occupancy "setup" (../instance.js withProjectOccupancy) — deletion, relocation, recreate, restore and copy answer
// OCCUPIED meanwhile. A row whose server step carries a FOREIGN `process` is `INTERRUPTED` to the outside (store
// setupView) and does not hold `busy`; the resume takes it over (own boot id). The container step holds the occupancy
// "creation" through createInstance itself.
//
// ERRORS: every setter only writes while the project exists (store.getProject), the instance only CONDITIONALLY
// (`ifState: "create"`) — otherwise an orphaned instance row would appear after a deletion. If the server is ending
// (runs/server-end.js serverEnds: the stop chain takes the container), the row stays as it is: after the restart its
// `process` is foreign (INTERRUPTED), and the resume after `atReady` runs the step again (each is repeatable). No
// restartGrace hook: server end stops all project containers, a hook would run against a stopped container.
//
// ZIP. After `finished` (./routes.js: the archive is complete) a ZIP source goes into the state `unpack` — a server state
// OF THE SOURCE (store SOURCE_SERVER_STATES), not of the project: the step stays `sources`, the other sources keep
// uploading. `stepSources` unpacks each such source in turn (one at a time per project): `process` = the own boot id
// (holds `busy` and the chats), under the occupancy "setup", abort controller with the number of the source
// (`abortSource` only hits the running one). The way (`unpackSource`):
//   1. `archiveList` against the mapping of the source — `denied` (unsafe, encrypted, encoding, not a ZIP) ⇒ `error`
//      `UNPACK`; a `from` with nothing below it in the archive, or a file no `from` covers ⇒ `error` `PLAN_MATCHES_NOT`
//      with at most 5 paths. In both cases the ARCHIVE is no good (archive state `error`).
//   2. `checkSlot` with the declared size minus what an aborted pass already staged.
//   3. Empty the staging in the container (the rest of an aborted pass), create it anew, then `unpackArchive` into it.
//      `slot` ⇒ `error` `SLOT` (the archive stays `unpack`: "Try again" unpacks anew); an item error (bomb, damaged, a
//      link or folder in the way, duplicate, method, …) ⇒ `error` `UNPACK` with examples, the rest stays in the staging,
//      the archive stays `unpack` and the hints go to setSetupHint as after a success.
//   4. Success: source `staged`, THEN the archive gone (row, file) — if B dies in between, only a row is left that `end`
//      takes along. What was not created without the source failing goes to setSetupHint.
// An abort leaves staging and archive (source `aborted`) — but no half file: the provisioner writes under a part name.
// "Try again" unpacks every archive that is still there ANEW — also one in `error` (restartState: the archive stays; a
// deterministically unusable one simply fails again, visibly). "Take as is" (`finished` with `takeOver: true` in
// `error`/`aborted`, ./routes.js) takes what lies in the staging, and the archive falls; "Continue without this source"
// discards both. When placing, a ZIP source gets `references`: its links are brought to their place individually, and
// part names a KILL left behind fall. While `leaveOut` waits for the deletion (./status.js leaveOutRunning),
// `unpackSource` does not take the source, and "Try again" answers RUNNING.
// A source that is in `unpack` with a foreign boot id after a restart (INTERRUPTED to the outside) is taken over by the
// resume like a server step of the project — unpacking is repeatable because it starts with an emptied staging.
//
// CLONE. A clone source starts in `clone` (store createSetup) and goes through `clone` → `submodule` → `lfs` → `staged` —
// server states OF THE SOURCE like `unpack`, in the same loop of `stepSources`. `cloneSource` asks the save gate
// BEFOREHAND: if it is closed, the setup waits visibly (`waiting: "storage"`, `process` empty — does not hold `busy`),
// and the storage queue wakes it (setupStorageCandidates). The steps themselves are in ./clone.js `clones`; after each,
// `further` sets state and flag in ONE conditional move (state as last set, boot id the own one — an abort or leave-out
// in between wins). Errors carry their code (./clone.js CLONE_ERROR_CODES; otherwise CLONE) and, for
// NO_ACCESS/ACCESS_REJECTED/SUBMODULE_ACCESS, the host. "Try again" resumes by the flags (restartState) and resets `host`
// to that of the address.
// When PLACING (stepPlace) the clone is a whole: before any move the provisioner (`clone` with `onlyCheck`) checks the
// target on the real tree, and no other staging may bring it (TARGET_OCCUPIED with the source, nothing moved); its place
// counts in CODE_REPO_LOCATION; it is placed LAST with ONE rename. After the end, remoteHintsRead reads per code repo the
// remotes with an access in the address (./clone.js readRemoteHints → store setRemoteHints, the bell) — names only.
import path from "node:path";
import { BOOT_ID } from "../../app-state.js";
import { T } from "../../i18n.js";
import * as store from "../../store.js";
import * as access from "../../runtime/fileAccess.js";
import { commandRun } from "../../runtime/git-run.js";
import { broadcast } from "../../runtime/sse.js";
import { serverEnds } from "../../runs/server-end.js";
import { repoLocationVisible } from "../../git.js";
import { MAIN, LABEL_INSTANCE, LABEL_PROJECT, STOP_DEADLINE_S } from "../creation.js";
import { projectboxOps } from "../ops.js";
import { copyLocal, createCliHome, enterCodexTrust } from "../cli-home.js";
import { docker } from "../docker.js";
import { detectServices } from "../detection.js";
import { occupancyOfProject, createInstance, withProjectOccupancy } from "../instance.js";
import { procedureAlive, setInstanceState } from "../instances.js";
import { runInstance } from "../run-instance.js";
import { wakeProject } from "../idle.js";
import { onlyOwn } from "../erase.js";
import { creationOptionsFor } from "../recreate.js";
import { GIT_HARDENING, commitProjectRepo, createProjectRepo, carriesProjectRepoMarker } from "../projectRepo.js";
import { createCodeRepo } from "./code-repos.js";
import { removeArchive, archivePath } from "./archive.js";
import { unpackArchive, archiveList, stagedBytes, place, placeClone, countConflicts } from "./provisioner.js";
import { CLONE_ERROR_CODES, clones, readRemoteHints } from "./clone.js";
import { checkSlot } from "./slot.js";
import { under } from "./rules.js";
import { leaveOutRunning } from "./status.js";
import { stagingAbs, createStaging } from "./operation.js";

const SERVER_STEPS = store.SETUP_SERVER_STEPS;
const CLONE_STATES = Object.freeze(["clone", "submodule", "lfs"]); // the server states of a clone source
const CONFLICT_MODES = Object.freeze(["overwrite", "skip", "abort"]);
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ── Seams ──────────────────────────────────────────────────────────────────────────────────────────────────────────

let saveGate = () => true;
export function setSetupSaveGate(fn) { saveGate = typeof fn === "function" ? fn : () => true; }

let hintSeam = null;
/** Seam (header): fn({ projectId, title, text }). Without a function only the log. */
export function setSetupHint(fn) { hintSeam = typeof fn === "function" ? fn : null; }
/** ./upload.js reports through THE SAME seam (the bell) what the after-the-fact unpacking did not create. */
export function reportSetupHint(h) {
  if (!hintSeam) return;
  try { hintSeam(h); } catch (x) { console.warn(`[setup] ${h?.projectId}: hint not reported: ${x?.message || x}`); }
}

// ── Event ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `project/setup` to the global stream — only ids, states and codes, no name, no URL. */
function report(pid, source = null) {
  const e = store.setupOf(pid);
  const evt = { type: "project/setup", projectId: pid, state: e ? e.state : "finished", step: e ? e.step : "project-repo" };
  if (source) {
    const q = store.sourceOf(pid, source);
    if (q) evt.source = { seq: q.seq, state: q.state, ...(q.code ? { code: q.code } : {}) };
  }
  broadcast(evt);
}

/** For ./routes.js (POST, `finished`, `leaveOut`): the same event. */
export const reportSetup = (projectId, source = null) => report(String(projectId), source);

// `error` carries ONLY the reason: the prefix "Setup failed: …" is added by whoever shows the field to a human — both
// clients do; with the prefix here it would be there twice. Nobody in the server shows the field to a human.
const errorText = (reason) => short(reason);

/** The setup to `error` — only while the project exists. */
function setError(pid, code, reason, { when = null } = {}) {
  if (!store.getProject(pid)) return null;
  const z = store.changeSetup(pid, { state: "error", code, error: errorText(reason), process: "", waiting: "" }, when ? { when } : {});
  if (z) report(pid);
  return z;
}

// ── The runs ───────────────────────────────────────────────────────────────────────────────────────────────────────

const runs = new Map(); // projectId → { rerun, again, controller, source } — `source`: the number the controller works on

/** Is a procedure running for this project in THIS process right now? */
export const setupProcedureAlive = (projectId) => runs.has(String(projectId));

function nudge(pid, { again = false } = {}) {
  const found = runs.get(pid);
  if (found) { found.rerun = true; if (again) found.again = true; return; }
  const run = { rerun: false, again, controller: null, source: null };
  runs.set(pid, run);
  (async () => {
    try {
      do { run.rerun = false; await drive(pid, run); run.again = false; } while (run.rerun);
    } catch (e) {
      console.error(`[setup] ${pid}: ${e?.stack || e?.message || e}`);
      if (!serverEnds()) setError(pid, "SETUP", e?.message || e, { when: { state: "setUp" } });
    } finally {
      runs.delete(pid);
    }
  })();
}

export function startSetup(projectId) {
  if (!projectboxOps()) return;
  nudge(String(projectId));
}

export function resumeSetup(projectId) {
  try {
    if (!projectboxOps()) return undefined;
    const pid = String(projectId ?? "");
    if (!pid) return undefined;
    storageWaitFree(pid);
    const e = store.setupOf(pid);
    if (!e || e.state !== "setUp" || e.waiting) return undefined;
    nudge(pid);
  } catch (x) { console.error(`[setup] resume ${projectId}: ${x?.message || x}`); }
  return undefined;
}

// `waiting: "storage"` is set ONLY by a clone (cloneSource). If no clone source is in a server state any more (aborted,
// left out, failed), nobody waits for storage — otherwise the row would say "waiting for storage" until the storage
// queue happened to wake it, and the other sources would not go on. Conditional (same row in the same step), then the
// caller runs at once.
function storageWaitFree(pid) {
  const e = store.setupOf(pid);
  if (!e || e.waiting !== "storage" || e.state !== "setUp") return false;
  if (e.sources.some((q) => q.kind === "clone" && CLONE_STATES.includes(q.state))) return false;
  const z = store.changeSetup(pid, { waiting: "" }, { when: { step: e.step, state: "setUp" } });
  if (z) report(pid);
  return Boolean(z);
}

// One round: as many steps as go without waiting.
async function drive(pid, run) {
  for (let round = 0; round < 12; round++) {
    if (!store.getProject(pid)) return;
    const e = store.setupOf(pid);
    if (!e || e.state !== "setUp" || e.waiting) return;
    // "Try again" in a later step: make the instance `ready` first.
    if (e.step !== "container" && run.again && store.projectInstance(pid, MAIN)?.state !== "ready") {
      if (!(await saveContainer(pid, run))) return;
      run.again = false;
    }
    let further;
    if (e.step === "container") further = await stepContainer(pid, run);
    else if (e.step === "sources") further = await stepSources(pid, run);
    else if (SERVER_STEPS.includes(e.step)) further = await serverStep(pid, e.step, run);
    else return;
    if (!further) return;
  }
}

// After `container` or `sources`: the next step.
function nextAfterSources(e) {
  if (e.sources.some((q) => q.state === "staged")) return "place";
  return e.codeRepos.length ? "code-repos" : "project-repo";
}
function nextAfterContainer(e) {
  if (e.sources.length) return "sources";
  return e.codeRepos.length ? "code-repos" : "project-repo";
}

/** Change the step; a server step keeps the boot id (no gap in which `busy` would drop). */
function changeOver(pid, from, to) {
  const z = store.changeSetup(pid, { step: to, process: SERVER_STEPS.includes(to) ? BOOT_ID : "" }, { when: { step: from, state: "setUp" } });
  if (z) report(pid);
  return Boolean(z);
}

// ── Container ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Stop and remove a left-over project container of THIS project (label, main instance) by id (`rm` without `-f`) — only
// on "Try again", never silently.
async function removeRestContainer(pid) {
  const ids = (await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${LABEL_PROJECT}=${pid}`, "--filter", `label=${LABEL_INSTANCE}=${MAIN}`])).stdout
    .split(/\s+/).filter(Boolean);
  const { own } = await onlyOwn(ids);
  for (const id of own) {
    await docker(["stop", "-t", String(STOP_DEADLINE_S), id]);
    await docker(["rm", id]);
    console.log(`[setup] ${pid}: left-over project container ${id.slice(0, 12)} removed (try again)`);
  }
  return own.length;
}

// CLI home and trust entry BEFORE the creation (both idempotent), then createInstance with `newProject` (takes the row
// of the POST: stamped, without a container, without a procedure; otherwise like the own creation).
async function createContainerOn(pid, { again }) {
  const proj = store.getProject(pid);
  if (!proj) return null;
  const opts = creationOptionsFor(pid);
  createCliHome(pid, opts.home ? { home: opts.home } : {});
  const ws = store.getWorkspace(proj.workspaceId);
  enterCodexTrust({ ...(opts.home ? { configPath: path.join(opts.home, ".codex", "config.toml") } : {}), wsPath: ws?.path, projectPath: proj.path });
  const z = store.projectInstance(pid, MAIN);
  // A missing row (never in the product, only after an intervention) is created stamped before the creation touches it.
  if (!z) setInstanceState(pid, MAIN, "create", { phase: "prepare", convertedAt: Date.now() });
  if (again && (!z || z.state === "error")) await removeRestContainer(pid);
  // `~/.local` of B as in the relocation, without an assignment: `bin/` (uv, uvx and `env`, which `.profile` and
  // `.bashrc` of B load — without the file `sh -l` ends every service start) and `share/uv`; nothing from `state/`,
  // nothing project-bound from `share/`. Idempotent (an existing target stays). Only after removing a left-over
  // container: then no process of the project runs.
  copyLocal(pid, {}, opts.home ? { home: opts.home } : {});
  return createInstance(pid, { ...opts, newProject: true });
}

// Make the instance `ready` if THIS procedure may: the fresh row of the POST (`create`, stamped, without a container,
// without a procedure) always, `error` or a missing row only on "Try again". If another procedure works on it (restore,
// recreate, creation), the setup waits — its end wakes it (atReady, the end of the recreate).
// → `true` (ready), `false` (wait).
async function saveContainer(pid, run) {
  const z = store.projectInstance(pid, MAIN);
  if (z?.state === "ready") return true;
  const fresh = z?.state === "create" && Boolean(z.convertedAt) && !z.containerId && !procedureAlive(pid, MAIN);
  if (!fresh && !(run.again && (!z || z.state === "error"))) return false;
  if (occupancyOfProject(pid)) return false;
  try {
    const row = await createContainerOn(pid, { again: run.again });
    return row?.state === "ready";
  } catch (e) {
    if (serverEnds()) return false; // the stop chain: the restart sets the row to error, the recreate brings it back
    const reason = short(e?.message || e);
    console.error(`[setup] ${pid}: project container: ${reason}`);
    if (store.getProject(pid)) {
      try { setInstanceState(pid, MAIN, "error", { error: reason, ifState: "create" }); }
      catch (x) { if (x?.code !== "INSTANCE_STATE") throw x; }
    }
    setError(pid, "CONTAINER", reason);
    return false;
  }
}

async function stepContainer(pid, run) {
  const e = store.setupOf(pid);
  const z = store.projectInstance(pid, MAIN);
  if (z?.state !== "ready") {
    // A server step: the own boot id before anything happens (a row from an earlier process is taken over).
    if (!store.changeSetup(pid, { process: BOOT_ID }, { when: { step: "container", state: "setUp" } })) return false;
    if (e.process !== BOOT_ID) report(pid);
    const ok = await saveContainer(pid, run);
    if (!ok) {
      // If the setup waits for another procedure, it does not hold `busy`: `process` empty (a foreign row thus does not
      // stay INTERRUPTED — it visibly waits for the container).
      store.changeSetup(pid, { process: "" }, { when: { step: "container", state: "setUp", process: BOOT_ID } });
      return false;
    }
  }
  const now = store.setupOf(pid);
  if (!now || now.state !== "setUp") { wakeProject(pid); return false; }
  // The wakeup comes AFTER the change — before it the step `container` (own boot id) still holds the chats (../idle.js
  // reason "setup"), and a turn that woke at the instance's transition to `ready` would go back to sleep with nobody
  // waking it afterwards. After `sources` the chats run; after a server step its end wakes.
  const further = changeOver(pid, "container", nextAfterContainer(now));
  wakeProject(pid);
  return further;
}

// ── Sources (no server step of the project: uploads from the client go into their stagings; ZIP sources in `unpack`
//    are a server state OF THE SOURCE, see header "ZIP") ───────────────────────────────────────────────────────────

async function stepSources(pid, run) {
  if (store.projectInstance(pid, MAIN)?.state !== "ready") return false; // atReady wakes
  const e = store.setupOf(pid);
  const proj = store.getProject(pid);
  const inst = runInstance(pid);
  if (!proj || !inst) return false;
  // The stagings of the waiting sources in the container (idempotent; `begin` creates them too). A failure here is no
  // error of the setup — `begin` tries again with the answer to the client.
  for (const q of e.sources) {
    if (q.state !== "wait-upload") continue;
    try { await createStaging(inst, stagingAbs(proj.path, q.seq)); }
    catch (x) { console.warn(`[setup] ${pid}: staging ${q.seq} not created: ${short(x?.message || x)}`); }
  }
  // The ZIP sources in `unpack` and the clones in `clone`/`submodule`/`lfs` — one after the other, by `seq` (each at most
  // once per round — one that stays in its state waits for something else: the occupancy, the server end).
  const attempted = new Set();
  for (;;) {
    const q = store.setupOf(pid)?.sources.find((x) => !attempted.has(x.seq)
      && ((x.kind === "zip" && x.state === "unpack") || (x.kind === "clone" && CLONE_STATES.includes(x.state))));
    if (!q) break;
    attempted.add(q.seq);
    if (!(await (q.kind === "clone" ? cloneSource(pid, q, run) : unpackSource(pid, q, run)))) return false;
  }
  const fresh = store.setupOf(pid);
  if (!fresh || fresh.step !== "sources" || fresh.state !== "setUp") return false;
  if (fresh.sources.some((q) => !["staged", "leftOut"].includes(q.state))) return false;
  return changeOver(pid, "sources", nextAfterSources(fresh));
}

class StepError extends Error {
  constructor(code, message, fields = {}) { super(message); this.name = "StepError"; this.code = code; Object.assign(this, fields); }
}

// ── ZIP: unpack one source (header "ZIP") ──────────────────────────────────────────────────────────────────────────

// The codes a ZIP source fails with; everything else (a docker error, an error of the program) is UNPACK.
const ZIP_CODES = Object.freeze(["UNPACK", "PLAN_MATCHES_NOT", "SLOT", "INTERRUPTED", "STAGING"]);
const DENIED_TEXT = {
  unsafe: () => T("an unsafe name (absolute, drive letter, an empty or a “..” part)"),
  encrypted: () => T("an encrypted entry"),
  encoding: () => T("a name marked as UTF-8 that is not"),
  broken: () => T("not a readable ZIP"),
};
/** Also for ./upload.js (the after-the-fact archive): the same wording. */
export function deniedText(a) {
  const reason = Object.hasOwn(DENIED_TEXT, a?.reason ?? "") ? DENIED_TEXT[a.reason]() : String(a?.reason || "?");
  const names = (a?.names || []).slice(0, 5).map((n) => short(n, 120)).join(", ");
  const text = short(a?.text, 160);
  return T`The archive was rejected: ${reason}${names ? ` (${names})` : ""}${text ? ` — ${text}` : ""}. Nothing was unpacked.`;
}

function reportHints(pid, seq, r) {
  const hints = (r.hints || []).slice(0, 20);
  if (!hints.length && !(r.referenceOutside > 0)) return;
  console.log(`[setup] ${pid}: source ${seq}: ${r.referenceOutside || 0} link(s) pointing out not created, ${hints.length} hint(s), among them ${short(hints[0], 160)}`);
  if (!hintSeam) return;
  const list = hints.slice(0, 5).map((h) => short(h, 160)).join("; ");
  try {
    hintSeam({
      projectId: pid,
      title: T`ZIP unpacked — not everything created (source ${seq})`,
      text: T`${r.referenceOutside || 0} link(s) pointing out of the project not created; ${list}`,
    });
  } catch (x) { console.warn(`[setup] ${pid}: hint not reported: ${x?.message || x}`); }
}

// → `true`: go on with the next source (done, failed, aborted); `false`: the procedure waits (occupancy, server end).
async function unpackSource(pid, q, run) {
  // A source that is being left out right now (an interrupted one, ./routes.js) is not taken over — the end of
  // `leaveOut` nudges the procedure again.
  if (leaveOutRunning(pid, q.seq)) return true;
  const a = q.archiveId ? store.projectArchive(q.archiveId) : null;
  if (!a || a.projectId !== pid) {
    // Without an archive there is nothing to unpack — visible, never silent: "Try again" leads the source to `wait-upload`.
    store.changeSource(pid, q.seq, { state: "error", code: "UNPACK", error: T("The archive of this source is missing."), process: "" }, { when: { state: "unpack" } });
    report(pid, q.seq);
    return true;
  }
  // The server state of the source: the own boot id before anything happens (a source of an earlier process is taken over).
  if (!store.changeSource(pid, q.seq, { process: BOOT_ID }, { when: { state: "unpack" } })) return true;
  report(pid, q.seq);
  const controller = new AbortController();
  run.controller = controller;
  run.source = q.seq;
  let r;
  try {
    r = await withProjectOccupancy(pid, "setup", async () => {
      const proj = store.getProject(pid);
      const inst = runInstance(pid);
      if (!proj || !inst) throw new StepError("INTERRUPTED", T("project or instance gone"));
      const root = path.resolve(proj.path);
      const archive = archivePath(pid, a.archiveId);
      const mapping = Array.isArray(q.mapping) ? q.mapping : [];
      const signal = controller.signal;
      const l = await archiveList(inst, root, archive, mapping, { signal });
      if (l.denied) throw new StepError("UNPACK", deniedText(l.denied), { archiveError: true });
      if (l.missingCount > 0 || l.withoutTargetCount > 0) {
        const paths = [...(l.missing || []), ...(l.withoutTarget || [])].slice(0, 5).map((x) => short(x, 120)).join(", ");
        throw new StepError("PLAN_MATCHES_NOT", T`The archive does not match the preview: ${l.missingCount || 0} path(s) of the layout are missing in the archive, ${l.withoutTargetCount || 0} file(s) in the archive are in none (${paths}). Nothing was unpacked.`, { archiveError: true });
      }
      const target = stagingAbs(root, q.seq);
      const already = await stagedBytes(inst, root, target, { signal });
      await checkSlot(inst, root, Math.max(0, (Number(l.sizeDeclared) || 0) - already));
      try { await access.erase(inst, target, { withoutDeadline: true, signal }); } catch (x) { if (x?.code !== "ENOENT") throw x; }
      await createStaging(inst, target, { signal });
      const e = await unpackArchive(inst, root, archive, target, mapping, { signal });
      if (e.denied) throw new StepError("UNPACK", deniedText(e.denied), { archiveError: true });
      if (e.slot) {
        throw new StepError("SLOT", T("No space left on the server's disk — the archive is not fully unpacked. Free some space and try again."));
      }
      if (e.errorCount > 0) {
        // Item errors: the source visibly stops, the rest stays in the staging — "Take as is" (./routes.js `finished` with
        // `takeOver`) takes it, "Try again" unpacks anew (an entry an agent blocked in the staging then goes through),
        // "Continue without this source" discards. The archive as a whole is fine: it stays `unpack`.
        const examples = (e.error || []).slice(0, 3).map((f) => `${f.kind}: ${short(f.path, 120)}`).join("; ");
        throw new StepError("UNPACK", T`${e.errorCount} entr(y/ies) not unpacked${examples ? ` (${examples})` : ""} — the rest stays in the staging folder`, { result: e });
      }
      return e;
    });
  } catch (e) {
    if (e?.code === "OCCUPIED") {
      // Another procedure holds the project (restore, recreate, deletion): its end wakes the setup.
      store.changeSource(pid, q.seq, { process: "" }, { when: { state: "unpack" } });
      console.log(`[setup] ${pid}: unpacking of source ${q.seq} waits — ${short(e.message)}`);
      wakeProject(pid);
      return false;
    }
    if (serverEnds()) return false; // stays with this boot id: INTERRUPTED after the restart, resumed after atReady
    if (controller.signal.aborted || e?.code === "ABORTED") {
      // abortSource has already set the source to `aborted`; staging and archive stay.
      console.log(`[setup] ${pid}: unpacking of source ${q.seq} aborted`);
      wakeProject(pid);
      return true;
    }
    const code = typeof e?.code === "string" && ZIP_CODES.includes(e.code) ? e.code : "UNPACK";
    console.error(`[setup] ${pid}: unpacking of source ${q.seq}: ${code}: ${short(e?.message || e, 600)}`);
    if (e?.archiveError) store.changeProjectArchive(a.archiveId, { state: "error" }, { when: { state: "unpack" } });
    if (store.getProject(pid)) store.changeSource(pid, q.seq, { state: "error", code, error: errorText(e?.message || e), process: "" }, { when: { state: "unpack" } });
    // What unpacking did NOT create despite the item errors also matters for "Take as is": reported as after a success.
    if (e?.result) reportHints(pid, q.seq, e.result);
    report(pid, q.seq);
    wakeProject(pid);
    return true;
  } finally {
    run.controller = null;
    run.source = null;
  }
  const finishedCompleted = store.changeSource(pid, q.seq, { state: "staged", error: "", code: "", process: "" }, { when: { state: "unpack" } });
  if (finishedCompleted) {
    removeArchive(a);
    console.log(`[setup] ${pid}: source ${q.seq} unpacked — ${r.written} file(s), ${r.folder} folder(s), ${r.references} link(s), ${r.omitted} omitted, ${r.leftOut} left out`);
    reportHints(pid, q.seq, r);
  }
  report(pid, q.seq);
  wakeProject(pid);
  return true;
}

// ── Clone: clone one source (header "CLONE") ───────────────────────────────────────────────────────────────────────

// → `true`: go on with the next source (done, failed, aborted); `false`: the procedure waits (storage, occupancy,
// server end).
async function cloneSource(pid, q, run) {
  if (leaveOutRunning(pid, q.seq)) return true;
  // The save gate: closed ⇒ the setup waits visibly and does not hold `busy`; the storage queue wakes.
  if (!saveGate()) {
    store.changeSource(pid, q.seq, { process: "" }, { when: { state: q.state } });
    const z = store.changeSetup(pid, { waiting: "storage", process: "" }, { when: { step: "sources", state: "setUp" } });
    if (z) report(pid);
    console.log(`[setup] ${pid}: clone of source ${q.seq} waits for storage`);
    wakeProject(pid);
    return false;
  }
  if (!store.changeSource(pid, q.seq, { process: BOOT_ID }, { when: { state: q.state } })) return true;
  // The gate is open: a `waiting: "storage"` from before falls (if another nudge woke it instead of the storage queue,
  // the row would otherwise say "waiting for storage" while the clone runs).
  if (store.setupOf(pid)?.waiting === "storage") store.changeSetup(pid, { waiting: "" }, { when: { step: "sources", state: "setUp" } });
  report(pid, q.seq);
  const controller = new AbortController();
  run.controller = controller;
  run.source = q.seq;
  let last = q.state;
  let finishedCompleted = false;
  try {
    await withProjectOccupancy(pid, "setup", async () => {
      const proj = store.getProject(pid);
      const inst = runInstance(pid);
      if (!proj || !inst) throw new StepError("INTERRUPTED", T("project or instance gone"));
      const fresh = store.sourceOf(pid, q.seq);
      if (!fresh || fresh.state !== last) return;
      finishedCompleted = await clones(inst, fresh, {
        root: path.resolve(proj.path),
        signal: controller.signal,
        // Accesses per host from the workspace of the project — looked up by the host name, the helper carries the port.
        accessesFor: (hosts) => store.gitAccessesFor(proj.workspaceId, hosts),
        // State and flag in ONE conditional move, AFTER the effect (header "CLONE").
        further: (to, flags) => {
          const finished = to === "staged";
          const z = store.changeSource(pid, q.seq, { state: to, ...flags, ...(finished ? { process: "", error: "", code: "" } : {}) },
            { when: { state: last, process: BOOT_ID } });
          if (!z) return false;
          last = to;
          report(pid, q.seq);
          return true;
        },
      });
    });
  } catch (e) {
    if (e?.code === "OCCUPIED") {
      store.changeSource(pid, q.seq, { process: "" }, { when: { state: CLONE_STATES } });
      console.log(`[setup] ${pid}: clone of source ${q.seq} waits — ${short(e.message)}`);
      wakeProject(pid);
      return false;
    }
    if (serverEnds()) return false; // stays with this boot id: INTERRUPTED after the restart, resumed after atReady
    if (controller.signal.aborted || e?.code === "ABORTED") {
      // abortSource has already set the source to `aborted`; the staging stays.
      console.log(`[setup] ${pid}: clone of source ${q.seq} aborted`);
      wakeProject(pid);
      return true;
    }
    const code = typeof e?.code === "string" && CLONE_ERROR_CODES.includes(e.code) ? e.code : "CLONE";
    console.error(`[setup] ${pid}: clone of source ${q.seq}: ${code}: ${short(e?.message || e, 600)}`);
    if (store.getProject(pid)) {
      store.changeSource(pid, q.seq, { state: "error", code, error: errorText(e?.message || e), process: "", ...(e?.host ? { host: String(e.host) } : {}) },
        { when: { state: CLONE_STATES } });
    }
    report(pid, q.seq);
    wakeProject(pid);
    return true;
  } finally {
    run.controller = null;
    run.source = null;
  }
  if (finishedCompleted) console.log(`[setup] ${pid}: source ${q.seq} cloned (with submodules and LFS files)`);
  // If the source did not run to `staged` (an abort or leave-out between two steps), its state is already there.
  store.changeSource(pid, q.seq, { process: "" }, { when: { state: [...CLONE_STATES, "aborted", "leftOut"], process: BOOT_ID } });
  report(pid, q.seq);
  wakeProject(pid);
  return true;
}

// The host of a clone address (host name, lower case) — for "Try again" (at SUBMODULE_ACCESS the host of the submodule was there).
function cloneHost(q) {
  try { return new URL(String(q.cloneUrl || "")).hostname || ""; } catch { return ""; }
}

// ── The server steps place · code-repos · project-repo ─────────────────────────────────────────────────────────────

async function serverStep(pid, step, run) {
  if (store.projectInstance(pid, MAIN)?.state !== "ready") {
    // Restart: the restore brings the container back and wakes through atReady. Until then the row stays as it is — a
    // foreign boot id shows INTERRUPTED and does not hold `busy`; the OWN one falls (otherwise it would hold `busy` and
    // the chats with nothing running).
    store.changeSetup(pid, { process: "" }, { when: { step, process: BOOT_ID } });
    return false;
  }
  const prior = store.setupOf(pid);
  if (!store.changeSetup(pid, { process: BOOT_ID }, { when: { step, state: "setUp" } })) return false;
  if (prior?.process !== BOOT_ID) report(pid);
  const controller = new AbortController();
  run.controller = controller;
  let next;
  try {
    next = await withProjectOccupancy(pid, "setup", async () => {
      const proj = store.getProject(pid);
      const inst = runInstance(pid);
      if (!proj || !inst) throw new StepError("INTERRUPTED", T("project or instance gone"));
      const root = path.resolve(proj.path);
      if (step === "place") return stepPlace(pid, inst, root, controller.signal);
      if (step === "code-repos") return stepCodeRepos(pid, inst, root, controller.signal);
      return stepProjectRepo(pid, inst, root, controller.signal);
    });
  } catch (e) {
    if (e?.code === "OCCUPIED") {
      // Another procedure holds the project (restore, recreate, deletion): its end wakes the setup.
      store.changeSetup(pid, { process: "" }, { when: { step, process: BOOT_ID } });
      console.log(`[setup] ${pid}: ${step} waits — ${short(e.message)}`);
      wakeProject(pid); // without the own boot id the step no longer holds the chats (../idle.js reason "setup")
      return false;
    }
    if (serverEnds()) return false; // stays with this boot id: INTERRUPTED after the restart, resumed after atReady
    console.error(`[setup] ${pid}: ${step}: ${short(e?.message || e, 600)}`);
    if (e instanceof StepError && e.source) store.changeSource(pid, e.source, { state: "error", code: e.code, error: errorText(e.message), process: "" });
    // An error SEVERAL sources take part in (CODE_REPO_LOCATION) carries each source's share (`sourcesError`).
    const perSource = e instanceof StepError && Array.isArray(e.sourcesError) ? e.sourcesError : [];
    for (const { seq, text } of perSource) store.changeSource(pid, seq, { state: "error", code: e.code, error: errorText(text), process: "" });
    setError(pid, e?.code && typeof e.code === "string" ? e.code : "SETUP", e?.message || e, { when: { step, process: BOOT_ID } });
    if (e?.source) report(pid, e.source);
    for (const { seq } of perSource) report(pid, seq);
    wakeProject(pid);
    return false;
  } finally {
    run.controller = null;
  }
  wakeProject(pid);
  if (next === null) {
    // Waits for a human (conflict): `process` is already empty.
    return false;
  }
  if (next === "finished") {
    await remoteHintsRead(pid);
    return end(pid);
  }
  return changeOver(pid, step, next);
}

// The remote hint: BEFORE the end (the row still holds `busy`, the procedure lives — no reading after the end that
// nobody waits for), not for an empty project (it has no code repos from sources). Names only in store, log and bell.
// Never throws: a hint that could not be read is no error of the setup.
async function remoteHintsRead(pid) {
  try {
    const e = store.setupOf(pid);
    if (!e || !e.sources.some((q) => q.state === "staged")) return;
    const proj = store.getProject(pid);
    const inst = runInstance(pid);
    if (!proj || !inst) return;
    const hints = store.setRemoteHints(pid, await readRemoteHints(inst, path.resolve(proj.path)));
    if (!hints.length) return;
    const list = hints.slice(0, 5).map((h) => T`remote ${short(h.remote, 80)} in ${short(h.repo, 120)}`).join("; ");
    console.log(`[setup] ${pid}: ${hints.length} remote(s) with an access in the URL: ${list}`);
    if (hintSeam) {
      hintSeam({
        projectId: pid,
        title: T("Access in a remote address"),
        text: T`${list} — the address contains an access in the URL. cbase rewrites nothing.`,
      });
    }
  } catch (x) { console.warn(`[setup] ${pid}: remote hint not read: ${short(x?.message || x)}`); }
}

// Repo in repo and places the repo search does not see, on the REAL tree: the folders that bring a `.git` FOLDER.
// → `[{ text, sources: [seq] }]` — per error the sources that bring it (`gitSeqs` parallel to `gitFolder`, from
// `gitStaging` of the provisioner); for "repo in repo" BOTH (the inner and the outer one — only together are they
// wrong, leaving out either resolves it).
function codeRepoLocationError(gitFolder, gitSeqs = []) {
  const from = new Map();
  (gitFolder || []).forEach((raw, i) => {
    const g = String(raw);
    if (!from.has(g)) from.set(g, new Set());
    if (Number.isSafeInteger(gitSeqs[i])) from.get(g).add(gitSeqs[i]);
  });
  const list = [...from.keys()];
  const error = [];
  for (const g of list) {
    const sources = [...from.get(g)];
    if (g === "") { error.push({ text: T("the project root itself carries a .git"), sources }); continue; }
    if (!repoLocationVisible(g)) error.push({ text: T`${short(g, 120)}: in a place the repo search does not see`, sources });
    for (const h of list) {
      if (h !== g && h !== "" && under(g, h)) {
        error.push({ text: T`${short(g, 120)} lies inside ${short(h, 120)} (repo in repo)`, sources: [...new Set([...sources, ...from.get(h)])] });
      }
    }
  }
  return error;
}

// The conflict question: the setup waits for a human's answer (`process` empty — it holds neither `busy` nor the chats).
function questionConflict(pid, k) {
  const z = store.changeSetup(pid, { waiting: "conflict", conflict: { existing: k.existing, examples: (k.examples || []).slice(0, 5) }, process: "" },
    { when: { step: "place", process: BOOT_ID } });
  if (z) report(pid);
  return null;
}

// The target of a clone before ANY move — free on the real tree (provisioner `clone` with `onlyCheck`, without following
// a link) and in no other staging (its subtree = the target paths relative to the root, ./operation.js): one that brings
// the target or a part of its way as a non-folder would create it before the clone, and the rename would find it
// occupied — after the others had already been placed. ⇒ TARGET_OCCUPIED with the source, nothing moved.
async function checkCloneTarget(inst, root, q, other, signal) {
  const v = await placeClone(inst, root, stagingAbs(root, q.seq), q.target, { onlyCheck: true, signal });
  if (v.occupied) {
    throw new StepError("TARGET_OCCUPIED", T`Source ${q.seq}: something already exists at the target “${short(q.target, 160)}” — a clone is never merged or overwritten; nothing was placed.`, { source: q.seq });
  }
  const parts = String(q.target).split("/");
  for (const a of other) {
    const b = stagingAbs(root, a.seq);
    for (let i = 1; i <= parts.length; i++) {
      const st = await access.stat(inst, path.join(b, ...parts.slice(0, i)), { withoutDeadline: true, signal });
      if (!st) break;
      if (i === parts.length || st.kind !== "folder") {
        const rel = parts.slice(0, i).join("/");
        throw new StepError("TARGET_OCCUPIED", T`Source ${q.seq}: source ${a.seq} brings “${short(rel, 160)}” — that is where the clone goes; nothing was placed.`, { source: q.seq });
      }
    }
  }
}

async function stepPlace(pid, inst, root, signal) {
  const e = store.setupOf(pid);
  // A source that was not left out MUST be staged — otherwise it would silently drop out here (a clone that "Try again"
  // had reset to `lfs` after an error while placing would never be placed, and the setup would end without it). Named,
  // with the source; nothing is moved.
  const open = e.sources.filter((q) => !["staged", "leftOut"].includes(q.state)).sort((a, b) => a.seq - b.seq);
  if (open.length) {
    const q = open[0];
    throw new StepError("PLACE", T`Source ${q.seq} is not ready (${q.state}) — nothing placed. “Try again” or “Continue without this source”.`, { source: q.seq });
  }
  const sources = e.sources.filter((q) => q.state === "staged").sort((a, b) => a.seq - b.seq);
  // What is in no staging any more is done (repeatable): only what is still there. A clone IS its staging and never goes
  // through the counting and placing of the others.
  const present = [];
  const clones = [];
  for (const q of sources) {
    const st = await access.stat(inst, stagingAbs(root, q.seq), { withoutDeadline: true, signal });
    if (st) {
      if (st.kind !== "folder") throw new StepError("PLACE", T`staging ${q.seq} is not a folder (${st.kind})`, { source: q.seq });
      (q.kind === "clone" ? clones : present).push(q);
    }
  }
  for (const q of clones) await checkCloneTarget(inst, root, q, present, signal);
  let mode = e.conflict?.mode || null;
  if (!mode && (present.length || clones.length)) {
    const k = present.length ? await countConflicts(inst, root, present.map((q) => stagingAbs(root, q.seq)), { signal }) : { existing: 0, gitFolder: [], gitStaging: [] };
    // A clone is a code repo at its target: its location counts (repo in repo with an uploaded one, places of the repo search).
    const location = codeRepoLocationError([...(k.gitFolder || []), ...clones.map((q) => q.target)],
      [...(k.gitStaging || []).map((i) => present[i]?.seq), ...clones.map((q) => q.seq)]);
    if (location.length) {
      const perSource = new Map();
      for (const f of location) for (const seq of f.sources) perSource.set(seq, [...(perSource.get(seq) || []), f.text]);
      throw new StepError("CODE_REPO_LOCATION", location.slice(0, 5).map((f) => f.text).join("; "), {
        sourcesError: [...perSource].sort((a, b) => a[0] - b[0]).map(([seq, texts]) => ({ seq, text: texts.slice(0, 5).join("; ") })),
      });
    }
    if (k.existing > 0) return questionConflict(pid, k);
    // No conflicts counted: what an agent creates BETWEEN counting and placing is never silently overwritten — and
    // never silently discarded: `keep` leaves the file in the staging (provisioner header), below it is counted again
    // and asked. Only a human's explicit answer discards.
    mode = "keep";
  }
  let occupied = 0;
  for (const q of present) {
    // The staging of a ZIP source carries the links of the archive — they are placed individually (also into a folder an
    // agent already created in `wait-upload`, and into the root); the provisioner checks the out-of-project rule again.
    const zip = q.kind === "zip";
    const r = await place(inst, root, stagingAbs(root, q.seq), mode, { signal, ...(zip ? { references: true } : {}) });
    if (r.hints?.length) console.log(`[setup] ${pid}: source ${q.seq}: ${r.hints.length} hint(s), among them ${short(r.hints[0], 160)}`);
    if (zip && r.referenceOutside > 0) reportHints(pid, q.seq, r);
    const keep = Number(r.occupied) || 0;
    occupied += keep;
    if (r.errorCount > 0 || (r.rest && !keep)) {
      const examples = (r.error || []).slice(0, 3).map((f) => `${f.kind}: ${short(f.path, 120)}`).join("; ");
      throw new StepError("PLACE", T`Source ${q.seq}: ${r.errorCount} file(s) not placed${examples ? ` (${examples})` : ""} — the rest stays in the staging folder`, { source: q.seq });
    }
  }
  if (occupied > 0) {
    // Targets that only appeared after the count (a turn or agent kept running): count again over what is still staged,
    // and ask. If the target is gone again meanwhile, the step does another round (`place` → `place`, drive).
    const stillStaged = [];
    for (const q of present) if (await access.stat(inst, stagingAbs(root, q.seq), { withoutDeadline: true, signal })) stillStaged.push(q);
    const k = await countConflicts(inst, root, stillStaged.map((q) => stagingAbs(root, q.seq)), { signal });
    console.log(`[setup] ${pid}: ${occupied} target(s) appeared after the count — counted again: ${k.existing}`);
    if (k.existing > 0) return questionConflict(pid, k);
    return "place";
  }
  // The clones LAST, each with ONE rename (provisioner `clone`) — never mixed, never overwritten. `missing` means:
  // already placed (a pass died after the rename); `occupied`: the target appeared after the check above.
  for (const q of clones) {
    const r = await placeClone(inst, root, stagingAbs(root, q.seq), q.target, { signal });
    if (r.occupied) {
      throw new StepError("TARGET_OCCUPIED", T`Source ${q.seq}: something just appeared at the target “${short(q.target, 160)}” — the clone stays in its staging folder.`, { source: q.seq });
    }
    if (r.placed) console.log(`[setup] ${pid}: clone (source ${q.seq}) placed (${r.via})`);
  }
  // Done: the operations of the creation fall (their stagings are gone).
  for (const v of store.projectUploadsOf(pid)) if (v.purpose === "creation") store.deleteProjectUpload(v.operation);
  const after = store.setupOf(pid);
  return after.codeRepos.length ? "code-repos" : "project-repo";
}

async function stepCodeRepos(pid, inst, root, signal) {
  const e = store.setupOf(pid);
  const list = e.codeRepos.map((c) => ({ ...c }));
  const home = creationOptionsFor(pid).home;
  for (const c of list) {
    if (c.created || c.reason) continue;
    if (signal.aborted) throw new StepError("ABORTED", "aborted");
    const r = await createCodeRepo(inst, root, c.rel, { signal, permissionsFromIndex: true, ...(home ? { home } : {}) });
    if (r.created) c.created = true;
    else { c.reason = r.reason; c.notice = short(r.notice, 200); }
    store.changeSetup(pid, { codeRepos: list });
  }
  return "project-repo";
}

const headExists = async (inst, root, signal) => (await commandRun(inst, root, "git", [...GIT_HARDENING, "rev-parse", "--verify", "--quiet", "HEAD"], {
  withoutDeadline: true, signal, env: { GIT_TERMINAL_PROMPT: "0" }, envAlways: ["GIT_TERMINAL_PROMPT"],
})).code === 0;

// Repeatable in three stages: marker + HEAD ⇒ done; marker without HEAD ⇒ only the creation commit; a `.git` without
// marker and without HEAD (an own half `init`) ⇒ remove it in the container and start anew. A `.git` WITH HEAD and
// without marker ⇒ GIT.
async function stepProjectRepo(pid, inst, root, signal) {
  const git = await access.stat(inst, path.join(root, ".git"), { withoutDeadline: true, signal });
  if (git) {
    const marker = carriesProjectRepoMarker(root);
    const head = git.kind === "folder" && await headExists(inst, root, signal);
    if (marker && head) return "finished";
    if (marker) { await commitProjectRepo(root, "Creation", { empty: true, instance: inst, withoutDeadline: true, harden: true }); return "finished"; }
    if (head) throw new StepError("GIT", T("The project root carries a foreign Git repository (with commits, without the cbase mark)."));
    const r = await commandRun(inst, root, "rm", ["-rf", "--", path.join(root, ".git")], { withoutDeadline: true, signal });
    if (r.code !== 0) throw new StepError("GIT", `rm .git: exit ${r.code ?? r.signal} ${short(r.stderr, 200)}`);
  }
  // The git of the project repo runs in the container with GIT_HARDENING (../projectRepo.js) — like code-repos.js and
  // headExists above; the agent writes the `~/.gitconfig` of the project home.
  const r = await createProjectRepo(root, { instance: inst, message: "Creation", withoutDeadline: true, harden: true });
  if (r.created) return "finished";
  if (r.reason === "in-repo") {
    throw new StepError("IN_REPO", T`The project folder lies inside a Git repository (${short(r.repo, 200)}).`);
  }
  throw new StepError("GIT", T("The project repo could not be created (the root already is a repo)."));
}

function end(pid) {
  const e = store.setupOf(pid);
  // Empty means: no source made it to placing — a left-out one keeps its row, and "Continue without this source" for
  // every one would otherwise trigger a detection oneshot on an empty project. Only what was `staged` was placed;
  // placing does not change the state of the source.
  const empty = !e || !e.sources.some((q) => q.state === "staged");
  // Archives of the creation that still have a row (B died between `staged` and the removal) fall BEFORE the row of the
  // setup — afterwards nobody would ask for them (the restartGrace hook only cleans rows without a project).
  for (const a of store.projectArchiveOf(pid)) if (a.purpose === "creation") removeArchive(a);
  store.endSetup(pid);
  report(pid);
  console.log(`[setup] ${pid}: finished`);
  wakeProject(pid);
  // The service detection: after the end, not for an empty project — without `onlySupplement`: the creation reconciles.
  if (!empty && store.getProject(pid)) {
    try { detectServices(pid); } catch (x) { console.error(`[setup] ${pid}: service detection: ${x?.message || x}`); }
  }
  return false;
}

// ── Again, conflict, abort (the routes) ────────────────────────────────────────────────────────────────────────────

const response = (status, code, text, fields = {}) => ({ status, body: { code, error: text, ...fields } });
const view = (pid) => store.setupView(store.setupOf(pid), { bootId: BOOT_ID, instance: store.projectInstance(pid, MAIN) });

// The state a failed or aborted source goes back to: folder/files to `staged` when their operation was already reported
// finished (the error came from placing — the rest lies in the staging), otherwise `wait-upload`.
// ZIP, by its archive: if it is still there (`unpack` after abort, restart or SLOT; `error` after PLAN_MATCHES_NOT, a
// rejection or item errors), "Try again" unpacks ANEW — the archive stays (a fully uploaded archive must not fall
// without an explicit choice). If it fails again, "Take as is" and "Continue without this source" remain. No archive
// any more and a code of the unpacking or an abort ⇒ nothing to unpack and nothing to lose: `wait-upload` (`begin`
// assigns a new id); no archive and an operation that was reported finished ⇒ the error came from placing: `staged`.
// Clone: by the flags, each set AFTER the effect — the step that last succeeded is not repeated (an abort after
// `cloneFetched` resumes at `submodule`, a TARGET_OCCUPIED while placing at `staged`); in `clone` the rest falls.
// If the setup is already AFTER `sources` (the error came from placing — after "Take as is" without LFS files the later
// flags are false), a fetched clone stays `staged`: in the later steps nobody runs `clone`/`submodule`/`lfs` any more,
// and stepPlace would have passed it over.
const AFTER_SOURCES = Object.freeze(["place", "code-repos", "project-repo"]);
function restartState(pid, q, e = null) {
  if (q.kind === "clone") {
    if (q.cloneFetched && AFTER_SOURCES.includes(e?.step)) return "staged";
    if (q.lfsFetched) return "staged";
    if (q.submoduleFetched) return "lfs";
    if (q.cloneFetched) return "submodule";
    return "clone";
  }
  if (q.kind === "zip") {
    const a = q.archiveId ? store.projectArchive(q.archiveId) : null;
    if (a && a.projectId === pid && (a.state === "unpack" || a.state === "error")) {
      if (a.state === "error") store.changeProjectArchive(a.archiveId, { state: "unpack" }, { when: { state: "error" } });
      return "unpack";
    }
    const withoutArchive = !a && (q.state === "aborted" || ["UNPACK", "PLAN_MATCHES_NOT", "SLOT"].includes(q.code));
    if (withoutArchive) {
      if (q.operation) store.deleteProjectUpload(q.operation);
      store.changeSource(pid, q.seq, { archiveId: "", operation: "" });
      return "wait-upload";
    }
  }
  const v = q.operation ? store.projectUpload(q.operation) : null;
  return v && v.state !== "upload" ? "staged" : "wait-upload";
}

export function setupAgain(projectId) {
  const pid = String(projectId);
  const e = store.setupOf(pid);
  if (!e) return response(409, "NO_SETUP", T("No setup is open for this project."));
  // Also while a source is being left out (./status.js leaveOutRunning) — "Try again" would otherwise reset it (to
  // `unpack`) while `leaveOut` is about to discard its archive and its operation.
  if (runs.has(pid) || store.setupServerStepRunning(e, BOOT_ID) || occupancyOfProject(pid) || leaveOutRunning(pid)) {
    return response(409, "RUNNING", T("The setup is running."));
  }
  const z = store.projectInstance(pid, MAIN);
  if (z && (["start", "recreate", "relocation", "clearAway"].includes(z.state) || (z.state === "create" && procedureAlive(pid, MAIN)))) {
    return response(409, "RUNNING", T("The project container is being created or started."));
  }
  const interrupted = store.setupInterrupted(e, BOOT_ID);
  const failed = e.sources.filter((q) => q.state === "error" || q.state === "aborted"
    || (store.SOURCE_SERVER_STATES.includes(q.state) && q.process && q.process !== BOOT_ID));
  const containerMissing = !z || z.state !== "ready";
  if (e.state === "setUp" && !interrupted && !failed.length && !containerMissing && !e.waiting) {
    if (e.step === "sources") return response(409, "WAITING_FOR_UPLOAD", T("The setup is waiting for the sources to be uploaded."));
  }
  for (const q of failed) {
    store.changeSource(pid, q.seq, { state: restartState(pid, q, e), error: "", code: "", process: "", ...(q.kind === "clone" ? { host: cloneHost(q) } : {}) });
  }
  store.changeSetup(pid, { state: "setUp", error: "", code: "", waiting: "", conflict: null, process: "" });
  report(pid);
  nudge(pid, { again: containerMissing });
  return { status: 202, body: { ok: true, setup: view(pid) } };
}

export function conflictResponse(projectId, mode) {
  const pid = String(projectId);
  if (!CONFLICT_MODES.includes(mode)) {
    return response(400, "MODE", T`“mode” is required: ${CONFLICT_MODES.join(", ")}.`);
  }
  const e = store.setupOf(pid);
  if (!e) return response(409, "NO_SETUP", T("No setup is open for this project."));
  if (e.waiting !== "conflict" || e.state !== "setUp") return response(409, "NO_CONFLICT", T("The setup is not waiting for a conflict answer."));
  if (mode === "abort") {
    // "Abort" ⇒ TARGET_OCCUPIED with "Try again" (counts anew and asks anew) and "Delete"; the stagings stay.
    const n = e.conflict?.existing || 0;
    store.changeSetup(pid, { state: "error", code: "TARGET_OCCUPIED", waiting: "", conflict: null, process: "",
      error: T`${n} file(s) already exist at the target — placing cancelled.` },
    { when: { step: "place" } });
    report(pid);
    return { status: 202, body: { ok: true, setup: view(pid) } };
  }
  store.changeSetup(pid, { waiting: "", conflict: { ...(e.conflict || {}), mode } }, { when: { step: "place" } });
  report(pid);
  nudge(pid);
  return { status: 202, body: { ok: true, setup: view(pid) } };
}

/** Only in `unpack`/`clone`/`submodule`/`lfs`. The controller only falls if it works on THIS source (`run.source`) —
 *  never a step of the project (`saveContainer` after "Try again") and never another source; a second source in
 *  `unpack` that still waits only becomes `aborted` (its pass then no longer takes it: the condition
 *  `when: { state: "unpack" }` in unpackSource). */
export function abortSource(projectId, seq) {
  const pid = String(projectId);
  const q = store.sourceOf(pid, seq);
  if (!q) return response(404, "SOURCE_UNKNOWN", T("No such source."));
  if (!store.SOURCE_SERVER_STATES.includes(q.state)) {
    return response(409, "NOT_ABORTABLE", T("Cancelling only works while unpacking or cloning."));
  }
  const run = runs.get(pid);
  // First the row, then the signal: the running step already sees `aborted` at the abort (no error setter overwrites it).
  store.changeSource(pid, q.seq, { state: "aborted", code: "ABORTED", process: "" }, { when: { state: q.state } });
  if (run?.controller && run.source === q.seq) run.controller.abort();
  report(pid, q.seq);
  // The aborted clone may have been waiting for storage — if nobody else waits, the setup runs at once (the other
  // sources, the next step).
  if (!run && storageWaitFree(pid)) nudge(pid);
  return { status: 202, body: { ok: true, setup: view(pid) } };
}

// ── Storage queue (source "setup") ─────────────────────────────────────────────────────────────────────────────────

/** The candidates of THIS pass: waiting setups (clone). Waiting detections are the source "detection". */
export function setupStorageCandidates() {
  if (!projectboxOps()) return [];
  const list = store.setupsWaitForStorage().map((e) => ({
    waitingSince: e.stateSince,
    storage: true,
    attempts: () => {
      if (!saveGate()) return { started: false };
      const z = store.changeSetup(e.projectId, { waiting: "" }, { when: { step: e.step, state: "setUp" } });
      if (!z) return { started: false };
      report(e.projectId);
      nudge(e.projectId);
      return { started: true };
    },
  }));
  return list;
}
