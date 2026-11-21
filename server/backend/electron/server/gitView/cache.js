// The cache of the readings. ONE reading (read.js) per (project, repo, instance), shared by the large view (overview.js:
// GET …/gitView and the `row` of the detail) and the small one (small.js: `branchesRunning`/`counter` in GET …/git) — so
// the 6 s tick of the bar costs no second run.
//
//   reading(proj, rel, inst, { fresh, valid })  → promise: reading | { read: false, reason, error }   (the large view WAITS)
//     rel      the repo relative to the project folder ("" = the folder itself)
//     inst     the instance row (projectbox/run-instance.js runInstance) — the run in the project container via
//              commandRun. `null` = a project WITHOUT a project container (not converted): the same script in the backend
//              via `sh -c` (runInB), where GET …/git already runs git in the backend. Whoever passes `inst` has found the
//              instance readable — nothing is asked here (the large view asks only `ready` ones, the small one only what
//              GET …/git has just read).
//     fresh    reads anew (`?fresh=1`, after a git action on the repo) — ALWAYS a new reading, never the one already
//              running (see GENERATION)
//     valid    (reading) → bool: an entry the caller considers outdated (small.js: the checked-out state does not match
//              the fresh tree) is read anew
//   readingWithoutWait(proj, rel, inst, { fresh, valid })  → reading | null   (the small view, GET …/git, NEVER waits)
//     A valid entry (the same rules) comes at once; from half its validity on it triggers its successor in the background
//     so the clients' 6 s tick does not answer without fields once every STORAGE_MS. If it is missing (cold, expired,
//     dropped, invalid), the answer is `null` ("unknown" — small.js omits the fields) and the reading starts in the
//     background, AT MOST ONE per key (a running one is not doubled). `fresh` starts a new one (generation) and answers
//     `null`: the old entry belongs to a state the action has just changed.
//   A copy reads with the refs of its snapshot (read.js copyComparison; stacks/code-snapshot.js readSnapshot) — its
//   reading is the same for both views.
//
// GENERATION per key: `fresh` and `dismissReading` increment the generation of the key, `dismissProject` that of the
// project. A reading stores only if both are still the same at its end as at its start — an older one that ends later
// never overwrites a younger one, and `fresh` never attaches to a reading that began before the action.
// fetch.js calls `dismissReading` after every fetch that ran (the remote refs are different afterwards).
//
// VALID is an entry for at most STORAGE_MS (tunable CBASE_GIT_VIEW_STORAGE_MS, clock seam setStorageClock) and only for
// the same marker: the same instance row (`createdAt`) in the same state (`updatedAt` — every state and phase change
// stamps it, store/project-instances.js changeProjectInstance), like the instances tree (projectbox/instances-tree.js).
// That is the dropping "when an instance changes its state" — without a hook into projectbox/instances.js, on every path
// that changes the row. Without an instance (backend) the marker is "B": when the project is relocated, the old entry no
// longer applies.
// DROPPED are all entries of a project at the end of EVERY turn there (gitViewTurnEnd, registered in server.js on
// "beforeRunBroadcast" — that kind fires in the finally of doRun on every outcome, also before a queued follow-up turn,
// for which the end hooks stay silent). A reading that began before the dropping still delivers to its callers but is no
// longer stored (generation). There is no hook kind for the end of a subagent: the view shows it after the entry expires.
// A failed reading is stored too (a broken container is not asked again on the clients' tick); its marker goes with the
// next state change, `fresh` reads it anew. Two concurrent requests for the same entry share the run (except `fresh`).
//
// Guard: server/backend/test/gitView.test.js.
import { spawn } from "node:child_process";
import path from "node:path";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { readSnapshot } from "../stacks/code-snapshot.js";
import { copyLocation } from "../stacks/location.js";
import { OUTPUT_CAP, READ_CAP_MS, copyComparison, readInstance } from "./read.js";
import { instanceDisplay } from "./instance-choice.js";
import { forgetRepoCount } from "./repos.js";

/** The maximum age of an entry (see header). */
export const STORAGE_MS = 30_000;
const MAIN = "main";
const slider = (name, preset) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : preset;
};

let clock = () => Date.now();
/** Test seam: the clock of the cache (`null` = Date.now). */
export function setStorageClock(fn) { clock = typeof fn === "function" ? fn : () => Date.now(); }

// Key `<pid>\0<rel>\0<instance, internal>` → `{ time, marker, reading }`; the running readings → `{ gen, marker, time, promise }`.
const storage = new Map();
const inFlight = new Map();
const projectGen = new Map(); // pid → number, rises with every dropping of the project
const keyGen = new Map(); // key → number, rises with `fresh` and dismissReading (header, "GENERATION")
const open = new Set(); // every running reading (readingsFinished)
const key = (pid, rel, internalName) => `${pid}\0${rel}\0${internalName}`;
const genOf = (pid, k) => `${projectGen.get(pid) || 0}:${keyGen.get(k) || 0}`;

/** For tests: forget everything (the read seam too). */
export function forgetReadings() { storage.clear(); inFlight.clear(); projectGen.clear(); keyGen.clear(); readSeam = null; }

/** For tests: waits until every running reading (also those triggered in the background) has ended. */
export async function readingsFinished() {
  while (open.size) await Promise.all([...open]);
}

/** Drop all entries of a project (header, "DROPPED"). */
export function dismissProject(projectId) {
  const pid = String(projectId);
  projectGen.set(pid, (projectGen.get(pid) || 0) + 1);
  for (const k of [...storage.keys()]) if (k.startsWith(`${pid}\0`)) storage.delete(k);
  for (const k of [...inFlight.keys()]) if (k.startsWith(`${pid}\0`)) inFlight.delete(k);
  forgetRepoCount(pid);
}

/** Drop the entry of ONE repo in ONE instance (fetch.js after a fetch that ran; header, "GENERATION"). `internalName` = `main` |
 *  `copy-<name>`. */
export function dismissReading(projectId, rel, internalName = MAIN) {
  const k = key(String(projectId), String(rel ?? ""), String(internalName || MAIN));
  keyGen.set(k, (keyGen.get(k) || 0) + 1);
  storage.delete(k);
  inFlight.delete(k);
}

/** The hook at turn end (kind "beforeRunBroadcast", registered in server.js): drops the entries of this chat's project. */
export function gitViewTurnEnd({ chat } = {}) {
  const pid = chat?.projectId;
  if (pid) dismissProject(pid);
}

// The marker of an entry (header, "VALID").
function markerOf(pid, internalName, inst) {
  if (!inst) return "B";
  const z = store.projectInstance(pid, internalName);
  return z ? `${z.createdAt}:${z.updatedAt}` : "without-row";
}

// Key, marker and the valid entry (or null) of a request. Throws if the marker cannot be read.
function situation(proj, rel, inst, valid) {
  const pid = String(proj.id);
  const r = String(rel ?? "");
  const internalName = inst ? String(inst.instance || MAIN) : MAIN;
  const k = key(pid, r, internalName);
  const m = markerOf(pid, internalName, inst);
  const old = storage.get(k);
  const ok = old && old.marker === m && clock() - old.time < slider("CBASE_GIT_VIEW_STORAGE_MS", STORAGE_MS)
    && (typeof valid !== "function" || valid(old.reading));
  return { pid, r, internalName, k, m, prev: ok ? old : null };
}

// The running reading of this key if it belongs to today's generation and marker — else null.
function running(pid, k, m) {
  const existing = inFlight.get(k);
  return existing && existing.gen === genOf(pid, k) && existing.marker === m ? existing : null;
}

let readSeam = null;
/** Test seam: wraps the run of a reading — `fn({ proj, rel, internalName, read })` → reading, `read()` is the real run (`null` =
 *  none). With it the guard holds a reading at a gate (GET …/git must not wait) or lets it fail. */
export function setReadSeam(fn) { readSeam = typeof fn === "function" ? fn : null; }

// Starts ONE reading (see header). `fresh` increments the generation of the key first: no running and no older one counts any more.
function start(proj, inst, { pid, r, internalName, k, m }, fresh) {
  if (fresh) keyGen.set(k, (keyGen.get(k) || 0) + 1);
  const gen = genOf(pid, k);
  const time = clock();
  const real = () => read(proj, r, inst, internalName);
  const seam = readSeam;
  const promise = (seam ? (async () => seam({ proj, rel: r, internalName, read: real }))() : real())
    .catch((e) => ({ read: false, reason: "error", error: String(e?.message || e) }))
    .then((l) => {
      if (genOf(pid, k) === gen) storage.set(k, { time, marker: m, reading: l });
      return l;
    })
    .finally(() => { open.delete(promise); if (inFlight.get(k)?.promise === promise) inFlight.delete(k); });
  open.add(promise);
  inFlight.set(k, { gen, marker: m, time, promise });
  return promise;
}

/** The reading of a repo in an instance, awaited (see header). Does not throw. */
export function reading(proj, rel, inst, { fresh = false, valid = null } = {}) {
  let l;
  try { l = situation(proj, rel, inst, valid); } catch (e) { return Promise.resolve({ read: false, reason: "error", error: String(e?.message || e) }); }
  if (fresh) return start(proj, inst, l, true);
  if (l.prev) return Promise.resolve(l.prev.reading);
  return running(l.pid, l.k, l.m)?.promise || start(proj, inst, l, false);
}

/** The reading of a repo in an instance, WITHOUT waiting (see header): the valid entry or null. Does not throw. */
export function readingWithoutWait(proj, rel, inst, { fresh = false, valid = null } = {}) {
  let l;
  try { l = situation(proj, rel, inst, valid); } catch (e) {
    console.error(`[gitView] marker ${proj?.id} ${rel}:`, e?.message || e);
    return null;
  }
  if (fresh) { start(proj, inst, l, true); return null; }
  const existing = running(l.pid, l.k, l.m);
  if (l.prev) {
    // From half its validity on trigger the successor — one, and only if no younger one is already running.
    const half = slider("CBASE_GIT_VIEW_STORAGE_MS", STORAGE_MS) / 2;
    if (!existing && clock() - l.prev.time >= half) start(proj, inst, l, false);
    return l.prev.reading;
  }
  if (!existing) start(proj, inst, l, false);
  return null;
}

async function read(proj, rel, inst, internalName) {
  const filePath = rel ? path.join(proj.path, rel) : proj.path;
  let snapshot = null;
  if (internalName !== MAIN) {
    try {
      snapshot = copyComparison(readSnapshot(copyLocation({ data: DIRS.data, projectId: String(proj.id), name: instanceDisplay(internalName) })), rel);
    } catch (e) {
      return { read: false, reason: "error", error: `snapshot of copy ${instanceDisplay(internalName)} not readable: ${e?.message || e}` };
    }
  }
  return readInstance(inst, { path: filePath, snapshot, ...(inst ? {} : { run: runInB }) });
}

/**
 * The run IN the backend for a project without a project container — the same shape as runtime/git-run.js commandRun
 * (`{ code, stdout, stderr, cap }`, does not throw), so read.js readInstance knows nothing about it. The deadline hits the
 * PROCESS GROUP (`detached` + `kill(-pid)`): the script starts git, a killed `sh` alone would let it keep running. No
 * stdin (snapshots exist only in copies, and those have a container).
 */
export function runInB(_inst, cwd, cmd, args, { env, timeout, maxBuffer } = {}) {
  const deadline = Number(timeout) > 0 ? Number(timeout) : READ_CAP_MS;
  const limit = Number(maxBuffer) > 0 ? Number(maxBuffer) : OUTPUT_CAP;
  return new Promise((resolve) => {
    let subprocess;
    try {
      subprocess = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: "", stderr: String(e?.message || e), cap: null });
      return;
    }
    const out = []; const err = [];
    let set = 0; let cap = null; let finished = false;
    const end = (reason) => {
      if (cap) return;
      cap = reason;
      try { process.kill(-subprocess.pid, "SIGKILL"); } catch { try { subprocess.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    const take = (target) => (d) => {
      set += d.length;
      if (set > limit) { end("output"); return; }
      target.push(d);
    };
    subprocess.stdout.on("data", take(out));
    subprocess.stderr.on("data", take(err));
    const tick = setTimeout(() => end("deadline"), deadline);
    tick.unref?.();
    const end2 = (code, sig, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(tick);
      let stderr = Buffer.concat(err).toString("utf8");
      if (error) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${error}`;
      if (cap === "deadline") stderr += `\n${cmd} in the backend: cap of ${deadline / 1000} s reached — terminated (gitView/cache.js)`;
      if (cap === "output") stderr += `\n${cmd} in the backend: output cap (${limit} bytes) reached — terminated (gitView/cache.js)`;
      resolve({ code: cap ? null : code, signal: sig || null, stdout: Buffer.concat(out).toString("utf8"), stderr, cap });
    };
    subprocess.once("error", (e) => end2(null, null, String(e?.message || e)));
    subprocess.once("close", (code, sig) => end2(code, sig, null));
  });
}
