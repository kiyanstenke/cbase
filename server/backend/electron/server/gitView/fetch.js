// The fetch of the Git overview.
//
//   POST /api/projects/:pid/gitView/fetch  { repo, instance, auto }  (route: routes.js)
//     → 200 { skipped: false, remoteState }                fetch ran
//     → 200 { skipped: true, remoteState, nextNotBefore }  `auto: true` within the throttle — no git, no docker
//     → 409 with `code` (INSTANCE_NOT_READY, SETUP_RUNNING, LAYOUT_RUNNING, …) or the situation; 400 with git's error
//       (`authRequired`/`host` like the existing fetch, workspaces/git-auth.js gitErrPayload)
//
// THROTTLE: per (project, repo, instance) at most one fetch in FETCH_GAP_MS, but only for `auto: true` (on opening the
// clients send that for main and every ready copy); the button sends `auto: false` and bypasses it. Counted from the end
// of a fetch that ran (a failed one too — otherwise every opening would ask again with wrong credentials); a lock, a
// not-ready instance or a stopped container do not count (no git ran). In this process's memory: after a restart the
// first opening fetches once. The clock is a seam (setFetchClock) — tests jump instead of waiting. Two concurrent fetches
// of the same key share the one run (the button during the auto-fetch starts no second git process).
//
// THE SAME LOCKS as the existing fetch of the code view (devtools/code-route.js `POST /git/fetch`), through its functions
// — no copy: the write lock of setup and layout (devtools/routes.js setupLockOf, BEFORE any reading and once more in the
// situation of the action), the situation of the instance (code-route.js gitSituation → runs/project-lock.js startLock —
// including the relocation and every project lock) and the access (workspaces/git-auth.js gitAuthCtx + the accesses of
// the submodule hosts, git.js gitFetch). The write lock of a copy (devtools/routes.js writeLockCopy: its instance row is
// not `ready`) is taken stricter up front here: instance-choice.js readyInstance lets ONLY a ready instance through, main
// included.
// NEVER WAKES: unlike the code view (code-route.js notReady → gitStandsSituation starts a stopped container) a stopped or
// paused container is a 409 with a reason here — nothing is started.
//
// THE READING IS DROPPED: after every fetch that ran (a failed one too) fetch.js drops the entry of this (project, repo,
// instance) in the cache (cache.js dismissReading) — otherwise the view would show the numbers against the
// remote from before for up to 30 s although the button just fetched. repos.js repoChoice checks the repo (400
// REPO_INVALID, 404 UNKNOWN_REPO).
//
// remoteState = `{ at, source }` — `at` the time of FETCH_HEAD (ms), `source` "fetch-head"; without the file
// `{ at: null, source: "unknown" }`. Read IN the container (REMOTE_STATUS_SCRIPT; a copy has its own opaque .git). The
// script is exported so the reading (read.js) can fold it into its ONE `sh -c` instead of repeating the rule.
//
// Guard: server/backend/test/git-view-fetch.test.js.
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { commandRun } from "../runtime/git-run.js";
import { gitFetch } from "../git.js";
import { gitAuthCtx, gitErrPayload, wsForCode } from "../workspaces/git-auth.js";
import { setupRunningResponse, gitSituation } from "../devtools/code-route.js";
import { setupLockOf } from "../devtools/routes.js";
import { FETCH_GAP_MS } from "./contract.js";
import { readyInstance } from "./instance-choice.js";
import { repoChoice } from "./repos.js";
import { dismissReading } from "./cache.js";

let clock = () => Date.now();
/** Test seam: the clock of the throttle (`null` = Date.now). */
export function setFetchClock(fn) { clock = typeof fn === "function" ? fn : () => Date.now(); }

// Key `<pid>\0<repo>\0<instance, internal>` → `{ at, remoteState }` (the last fetch that ran) or the running fetch.
const last = new Map();
const running = new Map();
/** For tests: forget throttle and running fetches. */
export function forgetFetchDrossel() { last.clear(); running.clear(); }

/** The time of FETCH_HEAD in the repo of the working folder: one line, seconds since 1970 or `-` (no file). GNU stat in
 *  the container, BSD stat as fallback (test benches on macOS). */
export const REMOTE_STATUS_SCRIPT = 'f=$(git rev-parse --git-path FETCH_HEAD) || exit 3\n'
  + 'if [ -f "$f" ]; then stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"; else echo -; fi\n';

/** The output of REMOTE_STATUS_SCRIPT → `{ at, source }`. */
export function remoteStateOf(text) {
  const z = String(text ?? "").trim().split("\n").pop()?.trim() || "";
  const s = /^\d+$/.test(z) ? Number(z) : NaN;
  return Number.isSafeInteger(s) && s > 0 ? { at: s * 1000, source: "fetch-head" } : { at: null, source: "unknown" };
}

const response = (status, body) => ({ status, body });
const errorResponse = (status, text, extra = {}) => response(status, { error: text, ...extra });

/**
 * The fetch of a repo in an instance (see header). `proj` = the project row, `body` = `{ repo, instance, auto }`.
 * → `{ status, body }`. Never throws (an error of the instance choice is a response).
 */
export async function gitViewFetch(proj, body = {}) {
  // The repo BEFORE the throttle: only a code repo of the project (repos.js repoChoice — the same check as large view, detail, diff).
  let repo;
  try { repo = repoChoice(proj, body.repo, { required: true }).rel; } catch (e) {
    return errorResponse(Number(e?.status) || 500, String(e?.message || e), e?.code ? { code: e.code } : {});
  }
  if (typeof body.auto !== "boolean") return errorResponse(400, T("auto is missing (true when opening, false for the button)"), { code: "AUTO_MISSING" });
  let choice;
  try { choice = readyInstance(proj.id, body.instance); } catch (e) {
    return errorResponse(Number(e?.status) || 500, String(e?.message || e), { ...(e?.code ? { code: e.code } : {}), ...(e?.state !== undefined ? { state: e.state } : {}) });
  }
  const key = `${proj.id}\0${repo}\0${choice.internalName}`;
  const previous = last.get(key);
  if (body.auto && previous && clock() - previous.at < FETCH_GAP_MS) {
    return response(200, { skipped: true, remoteState: previous.remoteState, nextNotBefore: previous.at + FETCH_GAP_MS });
  }
  if (running.has(key)) return running.get(key);
  const run = fetch(proj, repo, choice, key).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

async function fetch(proj, repo, { inst, internalName }, key) {
  // The write lock of setup/layout BEFORE any docker call — and once more in the situation git.js asks for before its
  // first call (the same pattern as code-route.js).
  const lock = () => setupLockOf(proj);
  const s0 = lock();
  if (s0) return response(409, setupRunningResponse(s0));
  const g = {
    instance: inst,
    situation: (i) => { const s = lock(); return s ? { setupLock: s, error: setupRunningResponse(s).error } : gitSituation(i); },
  };
  const ws = wsForCode(proj.path, proj.workspaceId);
  const accessesFor = (hosts) => (ws ? store.gitAccessesFor(ws.id, hosts) : []);
  const ctx = await gitAuthCtx(proj.path, repo, g, { workspaceId: proj.workspaceId });
  try {
    await gitFetch(proj.path, repo, ctx.auth, { ...g, accessesFor });
  } catch (e) {
    if (e?.situation?.setupLock) return response(409, setupRunningResponse(e.situation.setupLock));
    if (e?.situation) { const { projectId: _p, ...situation } = e.situation; return response(409, { error: String(situation.error || situation.notice || ""), ...situation }); }
    if (e?.containerStands || e?.containerPaused) {
      const reason = e?.containerStands ? "stopped" : "frozen";
      return errorResponse(409, T`The project container is not running (${reason}) — the Git overview does not wake it.`, { code: "INSTANCE_NOT_READY", reason });
    }
    // git ran and failed (access, network, no repo): that counts for the throttle — and the reading is dropped (an aborted
    // fetch may already have moved individual remote refs).
    last.set(key, { at: clock(), remoteState: last.get(key)?.remoteState ?? null });
    dismissReading(proj.id, repo, internalName);
    return response(400, gitErrPayload(e, ctx.host));
  }
  // The fetch ran: the remote refs are different — the reading of this (project, repo, instance) is dropped.
  dismissReading(proj.id, repo, internalName);
  const remoteState = await remoteStatusRead(inst, path.join(proj.path, repo));
  last.set(key, { at: clock(), remoteState });
  return response(200, { skipped: false, remoteState });
}

// One exec in the container after the fetch. If it fails the status is unknown — the fetch itself ran.
async function remoteStatusRead(inst, cwd) {
  try {
    const r = await commandRun(inst, cwd, "sh", ["-c", REMOTE_STATUS_SCRIPT], { env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, envAlways: ["GIT_OPTIONAL_LOCKS"], timeout: 10_000 });
    return r.code === 0 ? remoteStateOf(r.stdout) : { at: null, source: "unknown" };
  } catch { return { at: null, source: "unknown" }; }
}
