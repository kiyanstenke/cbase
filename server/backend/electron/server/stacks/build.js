// The build of a copy — the procedure the queue enters. Wired in server.js via stacks/queue.js setCopyProcedure; the
// queue holds the project occupancy "copy", the procedure marker and the heavy load "copy-clone" and has set the copy
// to `build`/`clone1` (with the instance row `copy-<name>` in `create`).
//
// copyBuild({ copy, instance, journal, releaseHeavyLoad }, { home, system, data, root, addresses })
//   The test seams in the second argument as for the freeze and createInstance (default: the home of the user container,
//   SYSTEM_PATHS, DIRS.data, `/`, the addresses of the user container). The steps, each as a step of the copy's journal
//   (`journal.step`, see projectbox/journal.js):
//     freeze       stacks/freeze.js: volume clone, code snapshot, policy protection. Afterwards — also after an error —
//                  the build releases the heavy load (the heavy disk operation is over). If it fails, it has dismantled
//                  itself and set the copy to `error`; otherwise (a precondition) the build dismantles.
//     creation     stacks/creation.js createCopy: overlays.tsv and the copy container until `phase=prepare`.
//     prepare      stacks/prepare.js: every git in the copy container, last `.prepared`.
//     start        stacks/start.js: wait, check, desired state, stages, native services, policies.
//     ready        the result (stacks/result.js collectResult) and `setCopyState(…, "ready", { result })` — the ONLY
//                  transition to `ready` in the build: stacks/state.js sets the instance row to `ready` with
//                  `converted_at` in the SAME step, ONE UPDATE conditioned on `create`, and reports the copy event (the
//                  wake call).
//   FAILING after the freeze: stacks/dismantling.js (container, network, volume by id, layer via the root helper, last
//   the instance row), then `error` with the step in the reason ("<step>: … (<CODE>)", the code also in the journal
//   under `dismantling.rootCause`) — with the sentence of what stayed if the dismantling was incomplete. The main
//   instance has been thawed since the freeze.
//   SERVER END: if a step fails while the server ends (runs/server-end.js serverEnds — the stop chain also halts the
//   copy container), no dismantling and no `error`: the copy stays in `build`, the restart of the next process
//   dismantles and puts it back in its old place (stacks/queue.js). If the freeze failed (it dismantles itself and sets
//   `error`), the copy goes straight back to `waiting_queue` (old place) after its complete dismantling; if something
//   stayed, `error` stays.
//   WITHOUT THE OPS MARKER: no docker call — the instance row drops, the copy is set to `error` with NO_OPS.
//   Returns the copy's row afterwards (`ready` or `error`; at server end also `build` or `waiting_queue`). Throws only
//   if not even `error` could be set — then the queue dismantles itself (stacks/queue.js runProcedure).
// Guard: server/backend/test/stacks-creation.test.js.
import os from "node:os";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { DIRS } from "../app-state.js";
import { projectboxOps } from "../projectbox/ops.js";
import { locationFor } from "../runs/runtime-location.js";
import { serverEnds } from "../runs/server-end.js";
import { readSnapshot } from "./code-snapshot.js";
import { freeze } from "./freeze.js";
import { createCopy } from "./creation.js";
import { wakeCopyError } from "./inset.js";
import { collectResult } from "./result.js";
import { copyLocation } from "./location.js";
import { dismantleCopy } from "./dismantling.js";
import { startCopy } from "./start.js";
import { prepareCopy } from "./prepare.js";
import { CopyError, setCopyState } from "./state.js";

const REASON_MAX = 800;
const text = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, REASON_MAX);

// Also for fetch and clearing away (stacks/fetch.js copyContext) — ONE reader of the snapshot. It lives in
// code-snapshot.js (a copy from a copy reads its template's snapshot there) and is re-exported here.
export { readSnapshot };

// The error's code (CopyError, CreationError, ObjectError: UPPER_WITH_UNDERSCORE) is in the reason and in the journal
// (section `dismantling`, `rootCause`) — a sentence alone does not say which check hit.
const codeOf = (e) => (typeof e?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : null);

async function fail(copy, instance, journal, step, e, data) {
  const code = codeOf(e);
  const reason = `${step}: ${text(e)}${code ? ` (${code})` : ""}`;
  let rest = "";
  try {
    await journal.step("dismantling", () => dismantleCopy({ copy: store.stackCopy(copy.id) || copy, instance, journal, reason: "error", rootCause: { step, code } }, { data }), { direction: "backward" });
  } catch (x) { rest = ` — ${text(x)}`; }
  return setCopyState(copy.id, "error", { error: `${reason}${rest}`.slice(0, REASON_MAX * 2) });
}

// The freeze failed WHILE the server ends (at the lock, or a main instance stopped by the stop chain) — it has
// dismantled itself and set `error`. If its dismantling was complete and the instance row is gone, the copy goes back
// into the queue to its old place (`error` → `waiting_queue`, the request time stays) instead of staying in `error`,
// which would hold the name. If something stayed: `error`.
// At server end the transition to `error` set by the freeze does NOT wake the chat (it announces the return path —
// `returnPathAtServerEnd`, stacks/inset.js copyTransition; ONLY this setter, every other `error` wakes at server end
// too, e.g. the one from `fail` above) — the return into the queue releases the marker of the wake call and leaves a
// silent notice (ibid.); if it stays `error`, it wakes here (wakeCopyError). Exported for the guard
// server/backend/test/stacks-inset.test.js.
export function backAfterServerEnd(now, instance, e, step) {
  if (e?.dismantled !== true || store.projectInstance(now.projectId, instance)) {
    wakeCopyError(now);
    return now;
  }
  return setCopyState(now.id, "waiting_queue", {
    reason: T`Server end in the middle of the build (${step}) — dismantled, back in the queue (old place)`,
  });
}

export async function copyBuild({ copy, instance, journal, releaseHeavyLoad }, opts = {}) {
  const pid = copy.projectId;
  if (!projectboxOps()) {
    // Without the ops marker no docker — nothing is created except the instance row from the head.
    // The error shows in the copy row (through T()).
    store.deleteProjectInstance(pid, instance);
    return setCopyState(copy.id, "error", { error: T`copies exist only in server mode (NO_OPS) — nothing created` });
  }
  const { home = os.homedir(), system = null, data = null, root, addresses } = opts;
  const dataFolder = data || DIRS.data;

  // freeze
  let res;
  try {
    res = await journal.step("freeze", () => freeze(copy.id, { home, system, data: dataFolder }));
  } catch (e) {
    const now = store.stackCopy(copy.id);
    if (now?.state === "error") { // the freeze dismantled itself
      return serverEnds() ? backAfterServerEnd(now, instance, e, "freeze") : now;
    }
    if (serverEnds()) return now; // stays in `build`, the restart dismantles
    return fail(copy, instance, journal, "freeze", e, dataFolder);
  } finally {
    try { releaseHeavyLoad?.(); } catch (x) { console.error(`[stacks] heavy load ${pid}/${instance}:`, text(x)); }
  }

  let step = "creation";
  try {
    const location = copyLocation({ data: dataFolder, projectId: pid, name: copy.name });
    const projectPath = store.getProject(pid)?.path;
    if (!projectPath) throw new CopyError(T`Project ${pid} has no path`, { code: "COPY_CREATION", status: 500 });
    const snapshot = readSnapshot(location);

    // creation
    setCopyState(copy.id, "build", { phase: "creation" });
    const runtimeHome = locationFor({ projectId: pid, converted: true }).home;
    const created = await journal.step("creation", () => createCopy(copy, { location, projectPath, snapshot, home, system, root, addresses, data: dataFolder, runtimeHome }));
    await journal.note({ creation: { containerId: created.row.containerId, network: created.row.network, subnet: created.row.subnet, overlays: created.rows.length } });

    // prepare
    step = "prepare";
    setCopyState(copy.id, "build", { phase: "prepare" });
    const code = await journal.step("prepare", () => prepareCopy({
      copy, inst: store.projectInstance(pid, instance), location, projectPath, snapshot, base: copy.base ?? null,
      note: (d) => journal.note(d),
      // What is below a target of the overlays came with the layer (from a template: its worktrees there stay).
      ownRoots: created.rows.map((z) => z.target),
    }));

    // start
    step = "start";
    setCopyState(copy.id, "build", { phase: "start" });
    const start = await journal.step("start", () => startCopy({ copy, inst: store.projectInstance(pid, instance), desired: res.desired, policy: res.policy, services: res.services }));
    await journal.note({ start: { policy: start.policy, findings: start.findings, notices: start.notices } });

    // ready
    step = "ready";
    const inst = store.projectInstance(pid, instance);
    const result = await collectResult({
      copy: store.stackCopy(copy.id), project: store.getProject(pid), instance: inst, containerId: inst?.containerId || "",
      code: { ...(res.code || {}), preparation: code }, desired: start.desired, services: start.services, data: dataFolder,
    });
    return await journal.step("ready", () => setCopyState(copy.id, "ready", { result }));
  } catch (e) {
    const now = store.stackCopy(copy.id);
    if (now && now.state !== "build") return now; // already in a final state (e.g. a throw after `ready`)
    // If the server ends, the step mostly fails only because the stop chain halted the copy container. No dismantling
    // next to the stop chain and no `error`: the copy stays in `build`, the restart of the next process dismantles and
    // puts it back in its old place (stacks/queue.js).
    if (serverEnds()) {
      console.log(`[stacks] copy ${pid}/${instance}: ${step} ends with the server (${text(e)}) — the restart dismantles`);
      return now;
    }
    return fail(copy, instance, journal, step, e, dataFolder);
  }
}
