// Routes: runs. Every function takes ctx = { req, res, url, p, m } (sub-slices of a family add id/sub/chat, wid/sub/ws
// or pid/sub/proj) and returns NEXT if it is not responsible; any other return means "answered". Order of the calls:
// ROUTES in server.js.
// Functions: activeRunsGateRoute (/api/runs/active, with `quiet`/`open` from openWork and `projectWork`) ·
// activeRunsRoute · runChatRoutes (stop, steer, permission-*, ask, ask-answer, fork, monitor, agent*, agents, wakeup,
// compact) · autoContinueChatRoutes · messageChatRoutes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { providerForChat } from "../providers/index.js";
import { ruleMatches } from "../providers/permission-gate.js";
import * as wf from "../workflows.js";
import * as store from "../store.js";
import * as artifactStore from "../artifacts.js";
import { T } from "../i18n.js";
import { resolveNotices } from "../services.js";
import { attachmentFolderToRead, fetchAttachmentAtLocation, locationForChat } from "./runtime-location.js";
import { instanceNameForChat, instanceOfChat } from "./instance.js";
import { depositHint } from "./hints.js";
import { NEXT, attachmentMime, readBody, readBodyOrEmpty, safeFileName, send } from "../runtime/http.js";
import { imageDimensionsFromFile, withImageDimensions } from "../runtime/image-dimensions.js";
import { answerWorkflow, holdWorkflow } from "../workflows/gates.js";
import { askAnswerDisplay, askAnswerPrompt, normalizeAskAnswers, normalizeAskQuestions, openAskOf, postAsk } from "./ask.js";
import { autoContinueEnabled } from "./limit-gate.js";
import { autoContinueView, cancelAutoContinue, fireAutoContinue } from "./auto-continue.js";
import { broadcast, sse } from "../runtime/sse.js";
import { cancelRunInput, deliverUserPrompt, freeEntries, publicPendingInputs, controlNow } from "./queue.js";
import { compactChatContext, maybeAutoTitle } from "./post-run.js";
import { emitWorkflowRun, logRunStep, withoutControlCharacters, countCalculator } from "../workflows/run-state.js";
import { channelHumanInvolved, channelAfterDelivery } from "../channels/delivery.js";
import { runningVerdicts } from "../workflows/driver.js";
import { loadPermissionRules, pendingPermissions, rememberPermissionRule, requestPermission, resolvePermission } from "./permissions.js";
import { resolveSkillSlash } from "../toolchain/skill-catalog.js";
import { dynSlashRefusal } from "../dynworkflows/slash.js";
import { graphSlash } from "../workflows/slash-workflow.js";
import { deleteChatPermanently } from "../chats/erase.js";
import { forkRefusal } from "../chats/genus.js";
import { resolveAgent, agentFromProfile, callerOf, coreWithAgent, sendIntoTheBackground, stopAgent, stopBackgroundAgents } from "./agents.js";
// Agent communication: the resolution of subagents, the send route and the "start" view — the only domain besides the
// others of this file (runs/ is domain-free except for routes.js).
import { FOREIGN_CHILD, FOREIGN_INSTANCE, NO_RUN, subagentHelper } from "../communication/target-subagent.js";
import { sendMessage } from "../communication/send.js";
import { startView } from "../communication/read.js";
import { backgroundWork } from "./background.js";
import { allWakeups, setWakeup, stopWakeup } from "./wakeup.js";
import { compacting, pendingRunInputs, runBackground, runContext, runMonitorControllers, runWaiting, running, stopRun, workflowDecides, targetCheck } from "./state.js";
import { stopMonitor } from "./monitors.js";
import { ultracodeFollowUp } from "../chats/ultracode.js";
import { openHooks } from "./hooks.js";
import { runningOneshots } from "../providers/index.js";
import { heavyLoadStatus } from "../projectbox/heavyLoad.js";
import { copyInstance } from "../projectbox/creation.js"; // only the naming rule (leaf, reads no state)
import { BOOT_ID } from "../app-state.js"; // this process's boot id (setup in work)
import { uploadsActive as uploadsNow } from "../runtime/upload-stamp.js"; // the upload stamp (leaf)
import { projectboxOps } from "../projectbox/ops.js";
import { withoutInstanceRow as withoutInstanceRowList } from "../projectbox/relocation/routes.js"; // ONE computation for count and names
import { episodesMultiple } from "./episodes-count.js"; // the episodes axis of the rollback lock (leaf)
import { supersededInWork } from "../projectbox/layout/superseded.js"; // a removal of old containers in work
import { runningActions } from "../projectbox/instance-action-status.js"; // actions on an instance (leaf)
import { progressOf } from "../projectbox/copy-progress.js"; // copies being created, in the "active runs" pill
import { managerLocked } from "./manager-lock.js";

// ── Open work: the ONE computation "is the server quiet?" ───────────────────────────────────────────────────────
// `busy` (below) is the deploy's gate and means "a turn runs or a background agent lives" — no more, and deploy and
// idle reaper hang on it. Tests need another question: does the server still do something ON ITS OWN? `busy`/`runs`
// miss everything that keeps working after the run end: verdicts, dynamic workflows, the queue, compaction, target
// gate, hooks not awaited (curator, auto title), oneshots. Here every such item stands as a number; `quiet` means all
// zero. The counters stand at their source (providers/index.js runningOneshots, runs/hooks.js openHooks) and change
// nothing about the behaviour there.
// NOT open is what waits for a CLOCK: a waiting row at the limit with the queue behind it (parked is like running —
// but it runs only at the reset), a wakeup, the ticks. Quiet means: without a clock expiring nothing happens any more.
// Channel delivery after the run end needs no item of its own — it runs synchronously in the run's finally
// (channelAfterDelivery → deliverUserPrompt) and lands in `runs` or `queue`. What an SSE reader has not read yet the
// server does not know: that is the tests' stream barrier (server/backend/test/quiet.mjs).
// `agents`/`dynWorkflows`/`projectInstances` come from the caller because the route reads them as lists anyway.
// `projectInstances`: instances in a working state (creating, start, recreating, relocation) — an unsecured step that
// continues on its own.

// The field `relocationContainer` of /api/runs/active: sha256 (hex) of every full container id in the backend that a
// relocation took over and that can still exist in the backend:
//   - per OPEN journal only the list from the step that stops the old containers. The plan stands from the journal's
//     creation — before that step its containers still belong to the backend, and the deploy's `restoreInner` must
//     start them again after a swap;
//   - per journal with end `finished` of a converted project plan and list, WITHOUT the containers the removal step
//     removed (name in `report.remove.container`) — they no longer exist, and the list would otherwise grow with every
//     relocation. What stayed (a one-off container `oneoff`, labels did not match, an error) belongs to the relocation
//     and must never start in the backend again. A finished journal without a report names everything.
// A journal that went back or was aborted does NOT count: there the way back started the old stack again, it belongs
// to the backend. Read from the data layer, never via projectbox/. Sorted, every fingerprint once — the answer does
// not depend on the order of the journals.

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const containerList = (x) => (Array.isArray(x) ? x : []);
function relocationContainerFingerprints(instances) {
  const mentions = [];
  for (const j of store.openRelocations()) mentions.push(...containerList(j.container?.list));
  for (const pid of new Set(instances.filter((i) => i.convertedAt).map((i) => i.projectId))) {
    for (const j of store.relocationsOf(pid)) {
      if (j.end !== "finished") continue;
      const removed = new Set(containerList(j.report?.remove?.container).filter((n) => typeof n === "string"));
      for (const c of [...containerList(j.plan?.container), ...containerList(j.container?.list)]) {
        if (c?.oneoff || !removed.has(c?.name)) mentions.push(c);
      }
    }
  }
  const ids = new Set();
  for (const c of mentions) if (typeof c?.id === "string" && CONTAINER_ID.test(c.id)) ids.add(c.id);
  return [...ids].map((id) => crypto.createHash("sha256").update(id).digest("hex")).sort();
}

function openWork({ agents, monitors = 0, dynWorkflows, projectInstances, outerLoop }) {
  let verdicts = 0;
  for (const n of runningVerdicts.values()) verdicts += n;
  let queue = 0;
  for (const [chatId, entries] of pendingRunInputs) {
    // The inherited queue of a manager chat (runs/manager-lock.js) stays but never starts — nothing happens with it on
    // its own (as with a parked one).
    try { if (managerLocked(store.getChat(chatId))) continue; } catch { /* display */ }
    let parked = false;
    try { parked = store.getPendingResume(chatId)?.kind === "run"; } catch { /* display */ }
    // An entry held by an open card (queue.js freeEntries) waits for the HUMAN — like the waiting row for its clock:
    // nothing happens with it on its own.
    if (!parked) queue += freeEntries(chatId, entries).length;
  }
  let targetCheck2 = 0;
  for (const n of targetCheck.values()) targetCheck2 += n;
  const open = {
    runs: running.size,
    agents,
    // Live monitors (runs/monitors.js): they survive their turn like a subagent — a test starting one stops it (or
    // awaits its end) before it has quiet.
    monitors,
    dynWorkflows,
    verdicts,
    queue,
    waitPhase: runWaiting.size,
    compaction: compacting.size,
    targetCheck: targetCheck2,
    hooks: openHooks(),
    oneshots: runningOneshots(),
    projectInstances,
    // Running outer-loop runs: an own core works — quiet clocks and parked runs do not count (a clock).
    outerLoop,
  };
  return { quiet: Object.values(open).every((n) => n === 0), open };
}

export async function activeRunsGateRoute(ctx) {
  const { req, res, url, p, m } = ctx;

      // Busy status (for the gateway idle reaper): running chats. That way the reaper never puts a container with an
      // active job to sleep. Unauthenticated like /api/health (the gateway asks directly at the container port; only
      // counters, no data).
      if (p === "/api/runs/active" && m === "GET") {
        const runs = running.size;
        // Waiting approvals: a run at a card counts as running — but the deploy's gate should be able to say WHERE it
        // waits instead of waiting for it mutely. EVERY waiting card — an airlock card or a permission question holds
        // the run too, and the gate names the chat it waits in.
        const approvals = [];
        for (const p of pendingPermissions.values()) {
          let title = "";
          try { title = store.getChat(p.chatId)?.title || ""; } catch { /* display */ }
          approvals.push({ chatId: p.chatId, title, toolName: p.toolName });
        }
        // Running VERDICTS (switch, list, completion gate) stand next to it, not in `busy`: `busy` means "an agent
        // turn runs" and is the deploy's gate. A verdict takes at most 60 s and is caught up after a restart — it
        // should not hold up a deploy, but it should not be invisible either.
        let verdicts = 0; for (const n of runningVerdicts.values()) verdicts += n;
        // Live background agents: an agent can survive its turn (run kind without holding) and has no journal — a swap
        // would lose its work. Hence it counts in `busy` (deploy gate AND the gateway's idle reaper read the same
        // field) and stands as a field of its own so the gate can say WHOM it waits for. The field ALWAYS stands,
        // empty too — a missing field would be no statement.
        const titleValue = new Map();
        const titleOf = (chatId) => {
          if (!titleValue.has(chatId)) {
            let t = "";
            try { t = store.getChat(chatId)?.title || ""; } catch { /* display */ }
            titleValue.set(chatId, t);
          }
          return titleValue.get(chatId);
        };
        const agents = backgroundWork().filter((h) => h.kind === "agent")
          .map((h) => ({ chatId: h.chatId, title: titleOf(h.chatId), agentId: h.agentId, name: h.name || h.description || "" }));
        // Live monitors: a monitor survives its turn like a subagent and likewise has no journal — a swap ends a monitor
        // with a time limit (the restart reports that to the chat); it counts in `busy` like an agent: the deploy waits
        // for it. A PERSISTENT one (no time limit — a watch that may stay open for days, e.g. on a WebSocket) does NOT:
        // waiting for it would hold every deploy; the restart starts it again by itself (runs/monitors.js
        // monitorsRestartGrace — one waiting for its next resume attempt stands here too, persistent). The
        // gateway's idle reaper counts EVERY monitor all the same (server/gateway/containers.js busyFrom) — nobody wakes
        // a backend put to sleep. The field says whom; ALWAYS stands, empty too. Only ids, title, description,
        // `persistent` and `resuming` — no command (the route is unauthenticated).
        const monitors = backgroundWork().filter((h) => h.kind === "monitor")
          .map((h) => ({ chatId: h.chatId, title: titleOf(h.chatId), taskId: h.taskId, name: h.name || "", report: h.report || "", startedAt: h.startedAt || 0, persistent: h.persistent === true, ...(h.resuming ? { resuming: true } : {}) }));
        const monitorsHolding = monitors.filter((h) => !h.persistent).length;
        // Running dynamic workflows (NOT in `busy`): they have a journal, and the restart continues them after a swap
        // — the deploy does not wait for them, it SHOWS them (count, name, state; the deploy tool's gates.mjs
        // dynWorkflowRow). The price: agents in the middle of the run at the swap start anew. The gateway's idle
        // reaper counts the field as activity all the same (server/gateway/containers.js busyFrom) — after putting it
        // to sleep nobody wakes the run. Read from the data layer (store/dynworkflow-runs.js), never via
        // dynworkflows/. The field ALWAYS stands, empty too.
        const dynWorkflows = store.dynRunsOpen()
          .map((l) => ({ chatId: l.chatId, title: titleOf(l.chatId), runId: l.runId, taskId: l.taskId, name: l.name, startedAt: l.startedAt, progress: store.dynRunStatus(l.runId) }));
        // Project instances in work: creation, start, recreation and relocation are unsecured steps — a swap midway
        // would leave half a container or half a relocation. Hence they count in `busy` (deploy gate AND idle reaper
        // read the same field; the deploy tool's gates.mjs projectWorkRow says WHOM it waits for). Error and ready are
        // no work. ONLY ids and states, no paths and no error texts: the route is unauthenticated and readable from
        // every project network. Read from the data layer (store/project-instances.js), never via projectbox/. The
        // field ALWAYS stands, empty too.
        const projectWork = store.projectInstancesInState(store.PROJECT_WORK_STATES)
          .map((i) => ({ projectId: i.projectId, instance: i.instance, state: i.state, phase: i.phase, since: i.stateSince }));
        // The heavy-load lock (projectbox/heavyLoad.js): a heavy disk operation (relocation, volume clone) holds `busy`
        // from the FIRST step — also before creation, when there is no instance row yet. The same five fields,
        // `state: "heavyLoad"`, the kind as the phase. It lives in this process's memory; after a restart the instance
        // row in the relocation state holds.
        const heavy = heavyLoadStatus();
        if (heavy) projectWork.push({ projectId: heavy.projectId, instance: heavy.instance, state: "heavyLoad", phase: heavy.kind, since: heavy.since });
        // Every server step of a setup (container, placing, repos; unpacking, cloning, submodules, lfs) — ONLY with
        // the boot id of THIS process: a row from an earlier process never holds (otherwise deploy gate and idle
        // reaper would hang on something that never runs again). Waiting for upload, conflict or storage does not
        // hold. If the instance already stands in `projectWork`, no second entry. The same five fields,
        // `state: "setUp"`, the step as the phase; only ids.
        const alreadyThere = new Set(projectWork.map((a) => store.instanceIdentifier(a.projectId, a.instance)));
        for (const e of store.setupsInWork(BOOT_ID)) {
          if (alreadyThere.has(store.instanceIdentifier(e.projectId, "main"))) continue;
          projectWork.push({ projectId: e.projectId, instance: "main", state: "setUp", phase: e.phase, since: e.since });
          alreadyThere.add(store.instanceIdentifier(e.projectId, "main"));
        }
        // A retroactive operation in placing with the boot id of THIS process (store/project-setup.js
        // retroactiveInWork) — phase `unpack` for an archive, otherwise `place`. An interrupted one (foreign or empty
        // boot id) and one still uploading do not hold (pieces are held by `uploadsActive`).
        for (const v of store.retroactiveInWork(BOOT_ID)) {
          if (alreadyThere.has(store.instanceIdentifier(v.projectId, "main"))) continue;
          alreadyThere.add(store.instanceIdentifier(v.projectId, "main"));
          projectWork.push({ projectId: v.projectId, instance: "main", state: "setUp", phase: v.kind === "archive" && store.projectArchiveOfOperation(v.operation) ? "unpack" : "place", since: v.since });
        }
        // A layout whose procedure runs IN THIS process (running with the boot id; store/project-layout.js
        // layoutsInWork) — its steps move, delete and stop in the project container; a swap midway would continue
        // them only after the restart. The same five fields, `state: "layout"`, the step as the phase; only ids.
        // Waiting and error do not hold (no work).
        for (const g of store.layoutsInWork(BOOT_ID)) {
          if (alreadyThere.has(store.instanceIdentifier(g.projectId, "main"))) continue;
          alreadyThere.add(store.instanceIdentifier(g.projectId, "main"));
          projectWork.push({ projectId: g.projectId, instance: "main", state: "layout", phase: g.step || "", since: g.since });
        }
        // A removal of old containers running IN THIS process (own boot id; in memory, without a table —
        // projectbox/layout/superseded.js supersededInWork) — it stops and removes in the project container; a swap
        // midway would leave the rows (the human presses once more) but an `rm` half done. The same five fields,
        // `state: "superseded"`, the step as the phase; only ids.
        for (const a of supersededInWork(BOOT_ID)) {
          if (alreadyThere.has(store.instanceIdentifier(a.projectId, "main"))) continue;
          alreadyThere.add(store.instanceIdentifier(a.projectId, "main"));
          projectWork.push({ projectId: a.projectId, instance: "main", state: "superseded", phase: a.step || "", since: a.since });
        }
        // A human's action on an instance (branch switch, discard, stack restart — projectbox/instance-actions.js,
        // state in the leaf projectbox/instance-action-status.js) while it runs. The stack restart is a
        // `compose up -d --build` of up to 30 min in the project container, a checkout would leave `.git/index.lock`
        // at a swap — without this entry `busy` would be wrong and the deploy would swap the backend over it. The
        // same five fields, `state: "action"`, the kind as the phase; only ids.
        for (const a of runningActions()) {
          if (alreadyThere.has(store.instanceIdentifier(a.projectId, a.instance))) continue;
          alreadyThere.add(store.instanceIdentifier(a.projectId, a.instance));
          projectWork.push({ projectId: a.projectId, instance: a.instance, state: "action", phase: a.kind, since: a.since });
        }
        // The three numbers without ids — open and failed (error or INTERRUPTED) setups and, in operation, the projects
        // without an instance row (0 without operation). None makes `busy` true. Plus `uploadsActive`: projects whose
        // last piece request is open or BEGAN less than the upload quiet time ago — that holds `busy`.
        const ez = store.setupCounts(BOOT_ID);
        const setupOpen = ez.open;
        const setupError = ez.error;
        // The number is the length of THE SAME list whose names GET /api/projectbox/ops-status names
        // (projectbox/relocation/routes.js withoutInstanceRow) — two computations could drift apart.
        const withoutInstanceRow = projectboxOps() ? withoutInstanceRowList().length : 0;
        const uploadsActive = uploadsNow();
        // The NUMBER of converted instances in error — no ids, no reasons (the route is unauthenticated; a reason
        // names names). They do NOT make `busy` true (an error is no work); the deploy says "all ready" only with
        // `projectWork` empty AND `projectError` 0 (the deploy tool's project-container.mjs).
        const projectError = store.projectInstancesInState(["error"]).filter((i) => i.convertedAt).length;
        // The NUMBER of converted instances a human STOPPED — no ids. Not in `busy` (stopped is quiet, stopping is
        // work and stands in `projectWork`); the deploy names them so a stopped project container does not look
        // forgotten after the swap (the deploy tool's project-container.mjs).
        const projectStopped = store.projectInstancesInState(["stopped"]).filter((i) => i.convertedAt).length;
        // Rollback lock: the NUMBER of converted projects (instance rows with `converted_at`, once per project) — no
        // ids. a rollback to an older release refuses a target release that does not know the relocation while the number
        // is > 0; the deploy reads a MISSING field as "unknown", never as 0 (the deploy tool's capabilities.mjs). Does
        // not make `busy` true. The field ALWAYS stands, 0 too.
        const instances = store.projectInstances();
        const converted = new Set(instances.filter((i) => i.convertedAt).map((i) => i.projectId)).size;
        // The NUMBER of relocations in work — once per instance: an open journal (`project_relocations`), an instance
        // in the relocation state (also without a journal) and the heavy load of kind "relocation" (from the first
        // step, before the journal). `converted` counts only from the turning point — a rollback to a release without
        // relocation would leave half a relocation it does not know (busy forever, the old stack off). No ids; the
        // field ALWAYS stands, 0 too (the deploy reads a missing one as "unknown").
        const relocationIn = new Set(store.openRelocations().map((j) => store.instanceIdentifier(j.projectId, j.instance)));
        for (const i of instances) if (i.state === "relocation") relocationIn.add(store.instanceIdentifier(i.projectId, i.instance));
        if (heavy?.kind === "relocation") relocationIn.add(store.instanceIdentifier(heavy.projectId, heavy.instance));
        const relocationsOpen = relocationIn.size;
        // The old containers in the backend that a relocation took over (open journal or finished) — the deploy's
        // `restoreInner` does NOT start them again after a swap (its snapshot is from before the swap; after the
        // turning point old and new stack would otherwise run side by side until the removal deletes the old ones with
        // their volumes). Only sha256 of the full container ids: the route is unauthenticated in the backend (every
        // process there reads it) — a fingerprint of a random 256-bit id reveals nothing, the deploy recomputes it
        // from `docker ps --no-trunc`. The field does not reach a project container: the fence hands out only the
        // allowlist `RUNS_COUNTER` there (projectbox/fence.js runsCounter); the fingerprints stay the second defence.
        // A NEW field here is visible in the project network only once it is on that allowlist. ALWAYS stands, empty too.
        const relocationContainer = relocationContainerFingerprints(instances);
        // The NUMBER of live stack copies (`stack_copies`, every state except removed — also waiting, ready and error:
        // their row, volume and layer live) and of those the waiting ones. No ids, no names. a rollback to an older release
        // refuses a target release that does not know the copy while `copies` > 0; the deploy reads a MISSING field as
        // "unknown", never as 0 (the deploy tool's capabilities.mjs). Does not make `busy` true — a build or clearing
        // away holds it via its instance row in `projectWork`. From the data layer, never via stacks/. ALWAYS stands, 0 too.
        // Waiting also means an ORPHANED build — a copy in the build state whose instance row is not in `projectWork`.
        // After a restart the "project-instances" hook sets it to error (`busy` falls), and until the restart's
        // dismantling (stacks/queue.js) puts the copy back in line, nothing else would keep the backend awake: the idle
        // reaper would put it to sleep mid-dismantling, and the copy would build only at the next waking.
        const inWork = new Set(projectWork.map((a) => store.instanceIdentifier(a.projectId, a.instance)));
        const orphanedInBuild = (k) => {
          try { return k.state === "build" && !inWork.has(store.instanceIdentifier(k.projectId, copyInstance(k.name))); }
          catch { return true; } // a name outside the form (never created): rather awake than asleep
        };
        const liveCopies = store.liveStackCopies();
        const copies = liveCopies.length;
        const copiesWaiting = liveCopies.filter((k) => store.STACK_COPY_WAITING.includes(k.state) || orphanedInBuild(k)).length;
        // The NUMBER of source identifiers carrying an episode in more than one workspace. A release before that
        // capability does not start with any such identifier (its `ux_episodes_ext` is unique over system,
        // external_id); a rollback to an older release refuses a target release without `episodes-per-workspace` while
        // the number is > 0, and reads a MISSING field as "unknown" (the deploy tool's capabilities.mjs episodesLock).
        // No identifiers. ALWAYS stands; if the count fails, it is `null` (= unknown, never 0) — and the rest of the
        // answer, on which the idle gate and the idle reaper hang, still comes. It does not go into the project
        // network (the fence's allowlist `RUNS_COUNTER`).
        // 0 while the store has no `episodes` table (runs/episodes-count.js).
        let episodesMultipleCount = null;
        try { episodesMultipleCount = episodesMultiple(); }
        catch (e) { console.warn("[runs/active] episodesMultiple:", String(e?.message || e).slice(0, 200)); }
        // Rollback lock: the NUMBER of layouts whose rebuild is open — running (before and after the turning point:
        // before it too containers are stopped and restart policies set to `no`) and error after the turning point
        // (the tree is half rebuilt). A release without the layout capability knows neither the journal nor the lock
        // — a rollback to an older release refuses it while the number is > 0, and reads a MISSING field as "unknown"
        // (the deploy tool's capabilities.mjs layoutLock). Plus the waiting ones (only the status line). No ids.
        // ALWAYS stands; if the count fails: `null`.
        let layoutsOpen = null;
        let layoutsWaiting = null;
        try { layoutsOpen = store.layoutsOpenCount(); layoutsWaiting = store.layoutsWaitingCount(); }
        catch (e) { console.warn("[runs/active] layouts:", String(e?.message || e).slice(0, 200)); }
        // Running outer-loop runs: a run is a core of its own (for Claude a CLI process) WITHOUT a journal — a swap
        // aborts it (the start marks it aborted, the next trigger catches up). Hence it counts in `busy` (deploy gate
        // and the gateway's idle reaper) — NOT via backgroundWork(): otherwise it would hold up compaction, archive
        // and graph steps of the observed chat. A LIST with agent and chat so the gate says WHOM it waits for
        // (the deploy tool's gates.mjs outerLoopRow). Quiet clocks and parked runs do not count (a clock). From the
        // data layer (store/outer-loop.js), never via outerloop/. ALWAYS stands, empty too.
        const outerLoop = store.outerLoopRunsOpen().map((l) => {
          let agentName = "";
          try { agentName = store.outerLoopAgent(l.agentId)?.name || ""; } catch { /* display */ }
          return { runId: l.id, agentId: l.agentId, agentName, chatId: l.chatId, title: titleOf(l.chatId), startedAt: l.startedAt };
        });
        // Set wakeups (runs/wakeup.js): NOT in `busy` and not in `open` — a wakeup waits for a clock, its record is in
        // `<data>/wakeup-open.json`, and the restart sets it anew (like a dynamic workflow it survives the swap). It
        // holds the idle reaper via the gateway's occurrence wakeup (`GET /api/schedules/next` names the
        // earliest, scheduled/routes.js). The field says who is woken when; only ids, title and time — no prompt (the
        // route is unauthenticated). ALWAYS stands, empty too.
        const wakeup = allWakeups().map((w) => ({ chatId: w.chatId, title: titleOf(w.chatId), at: w.at }));
        // `quiet`/`open` stand NEXT TO `busy` and do not change it — see openWork above.
        const { quiet, open } = openWork({ agents: agents.length, monitors: monitors.length, dynWorkflows: dynWorkflows.length, projectInstances: projectWork.length, outerLoop: outerLoop.length });
        return send(res, 200, {
          busy: runs > 0 || agents.length > 0 || monitorsHolding > 0 || projectWork.length > 0 || outerLoop.length > 0 || uploadsActive > 0, runs, verdicts, approvals, agents, monitors, dynWorkflows, projectWork, projectError, projectStopped, converted,
          relocationsOpen, relocationContainer, copies, copiesWaiting, episodesMultiple: episodesMultipleCount, layoutsOpen, layoutsWaiting, outerLoop, wakeup, quiet, open,
          setupOpen, setupError, withoutInstanceRow, uploadsActive,
        });
      }
  return NEXT;
}
export async function activeRunsRoute(ctx) {
  const { req, res, url, p, m } = ctx;

      // Active runs at a glance — for the header pill "runs" (global across ALL workspaces, hence without a scope
      // parameter). Unlike /api/runs/active (only counters for the reaper) this route delivers per run what one needs
      // to look: chat, workspace/project, duration, phase with waiting reason, workflow step.
      // Sources: `running` says what computes right now; the start time comes from active_runs (persisted, survives a
      // restart mid-run); waiting reasons from runWaiting/runBackground; the workflow context from workflow_runs.
      // One thing is on the list because it would otherwise lie invisible: workflow runs with an open question
      // (status "waiting") — they do not compute but wait for the user and stand forever without attention.
      if (p === "/api/active-runs" && m === "GET") {
        const startedAt = new Map();
        try { for (const r of store.listActiveRuns()) startedAt.set(r.chatId, r.startedAt); } catch {}
        const wsCache = new Map(), projCache = new Map();
        const wsName = (id) => {
          if (!id) return "";
          if (!wsCache.has(id)) wsCache.set(id, store.getWorkspace(id)?.name || "");
          return wsCache.get(id);
        };
        const projName = (id) => {
          if (!id) return "";
          if (!projCache.has(id)) projCache.set(id, store.getProject(id)?.name || "");
          return projCache.get(id);
        };
        // Who holds which lock right now? (A run holding one blocks others — that belongs in the overview, otherwise
        // one puzzles why a trigger does nothing.)
        const locks = new Map(store.listLocks().map((l) => [l.runId, l]));
        // The progress chip of the ACTIVE runs shows the same number as the history — including the marker whether
        // it is estimated. Same calculator, same cache per workflow.
        const countsOf = countCalculator();
        const items = [];
        const seenChats = new Set();
        for (const chatId of running) {
          const chat = store.getChat(chatId);
          if (!chat) continue;
          seenChats.add(chatId);
          // runBackground knows background work also WHILE the main agent keeps working; runWaiting only in the
          // waiting phase — hence the more comprehensive one first.
          const bg = runBackground.get(chatId) || runWaiting.get(chatId) || {};
          const flow = store.getWorkflowRun(chatId);
          items.push({
            id: chatId,
            kind: "chat",
            chatId,
            title: chat.title || "",
            chatKind: chat.kind || "normal",
            workspaceId: chat.workspaceId,
            workspaceName: wsName(chat.workspaceId),
            projectId: chat.projectId || "",
            projectName: projName(chat.projectId),
            provider: chat.provider || "",
            model: chat.model || "",
            startedAt: startedAt.get(chatId) || chat.updatedAt || 0,
            phase: runWaiting.has(chatId) ? "waiting" : "running",
            background: {
              monitors: (bg.monitors || []).length,
              agents: (bg.agents || []).length,
              tasks: (bg.tasks || []).length,
              wakeupAt: bg.wakeupAt || 0,
            },
            contextTokens: runContext.get(chatId) ?? chat.contextTokens ?? 0,
            queued: (pendingRunInputs.get(chatId) || []).length,
            workflow: store.workflowOpen(flow)
              ? { runId: flow.id, workflowId: flow.workflowId, name: flow.workflowName, status: flow.status,
                  step: flow.step, ...countsOf(flow), nodeTitle: flow.nodeTitle || "", origin: flow.origin || "" }
              : null,
            lockKey: (flow && locks.get(flow.id)?.key) || "",
            stoppable: true,
          });
        }
        // Open workflow runs without a computing turn: either a question to the user ("ask") or the transition between
        // two steps (verdict/gate) — for the user the workflow continues in both cases, only the question needs them.
        // Or PARKED at the usage limit: a step's turn, a verdict or a compaction waits for the reset or the credit
        // gate. Then THIS entry carries the waiting row (`phase: "limit"` + `limit`), and the limit loop below creates
        // no second one — otherwise the same chat would be on the list twice, on top as "running" (indistinguishable
        // from real work), below without any workflow reference.
        // The row belongs to this chat, and this chat drives this run — no more reference is needed; the row's
        // `workflow` marker is read by cancelAutoContinue (end the run on discarding), here it would be redundant.
        // For a running chat the view is empty anyway.
        for (const flow of store.listWorkflowRuns({ status: "open", limit: 200 })) {
          if (seenChats.has(flow.chatId) || flow.chatGone) continue;
          seenChats.add(flow.chatId);
          const chat = store.getChat(flow.chatId);
          const wait = autoContinueView(store.getPendingResume(flow.chatId));
          items.push({
            id: flow.id,
            kind: "workflow",
            chatId: flow.chatId,
            title: chat?.title || flow.workflowName || "",
            chatKind: chat?.kind || "normal",
            workspaceId: flow.workspaceId || chat?.workspaceId || "",
            workspaceName: wsName(flow.workspaceId || chat?.workspaceId || ""),
            projectId: flow.projectId || "",
            projectName: projName(flow.projectId || ""),
            provider: chat?.provider || "",
            model: chat?.model || "",
            startedAt: flow.startedAt,
            // "limit" beats "ask": an answer whose interpretation is parked at the limit is GIVEN — showing the
            // question again would invite the human to a second answer to the same round.
            phase: wait ? "limit" : flow.status === "waiting" ? "ask" : "running",
            question: flow.question || "",
            background: { monitors: 0, agents: 0, tasks: 0, wakeupAt: wait?.dueAt || 0 },
            contextTokens: chat?.contextTokens || 0,
            // "Parked is like running": a queue can stand behind a waiting row.
            queued: (pendingRunInputs.get(flow.chatId) || []).length,
            workflow: { runId: flow.id, workflowId: flow.workflowId, name: flow.workflowName, status: flow.status,
                        step: flow.step, ...countsOf(flow), nodeTitle: flow.nodeTitle || "", origin: flow.origin || "",
                        // "cap" = the run hangs on the round cap, not on a question node.
                        pending: wf.pendingOf(flow.cursor)?.kind || "" },
            limit: wait,
            lockKey: locks.get(flow.id)?.key || "",
            stoppable: false,
          });
        }
        // Runs waiting at the usage limit: they do not compute but come back on their own — without an entry it would
        // not be visible for hours (for the weekly limit for days) that work is still open. If the chat runs right
        // now (continuation started) or drives an open workflow (entry above, WITH the waiting row), the upper entry
        // counts.
        for (const row of store.listPendingResumes()) {
          if (seenChats.has(row.chatId) || running.has(row.chatId)) continue;
          const chat = store.getChat(row.chatId);
          if (!chat) continue;
          items.push({
            id: `limit:${row.chatId}`,
            kind: "limit",
            chatId: row.chatId,
            title: chat.title || "",
            chatKind: chat.kind || "normal",
            workspaceId: chat.workspaceId,
            workspaceName: wsName(chat.workspaceId),
            projectId: chat.projectId || "",
            projectName: projName(chat.projectId),
            provider: row.provider || chat.provider || "",
            model: chat.model || "",
            startedAt: row.createdAt || 0,
            phase: "limit",
            background: { monitors: 0, agents: 0, tasks: 0, wakeupAt: row.dueAt || 0 },
            contextTokens: chat.contextTokens || 0,
            // "Parked is like running": what arrived since parking waits in the queue.
            queued: (pendingRunInputs.get(row.chatId) || []).length,
            workflow: null,
            limit: autoContinueView(row),
            stoppable: false,
          });
        }
        // Chats with an open question card (cbase_ask): the run has ended, but the agent waits for a decision — the
        // same attention as a workflow question. Without this a question in a chat not opened would lie unnoticed.
        for (const ask of store.listOpenAsks()) {
          if (seenChats.has(ask.chatId)) continue; // still computing → already listed above
          const chat = store.getChat(ask.chatId);
          if (!chat) continue;
          let question = "";
          try { question = String(JSON.parse(ask.text)?.questions?.[0]?.question || ""); } catch { /* broken row */ }
          seenChats.add(ask.chatId);
          items.push({
            id: `ask:${ask.chatId}`,
            kind: "ask",
            chatId: ask.chatId,
            title: chat.title || "",
            chatKind: chat.kind || "normal",
            workspaceId: chat.workspaceId || "",
            workspaceName: wsName(chat.workspaceId || ""),
            projectId: chat.projectId || "",
            projectName: projName(chat.projectId || ""),
            provider: chat.provider || "",
            model: chat.model || "",
            startedAt: ask.ts || 0,
            phase: "ask",
            question,
            background: { monitors: 0, agents: 0, tasks: 0, wakeupAt: 0 },
            contextTokens: chat.contextTokens || 0,
            queued: 0,
            workflow: null,
            lockKey: "",
            stoppable: false,
          });
        }
        // Live background agents of IDLE chats too: an agent can survive its turn (run kind without holding). The
        // number comes from the ONE query for open background work (runs/background.js). A computing chat already
        // counts its agents above (runBackground); a chat standing there for another reason (question, workflow,
        // limit) gets the number on ITS row; otherwise a row of its own in the waiting phase.
        // Likewise the monitors (runs/monitors.js) — they belong to the chat and survive their turn.
        const agentsPerChat = new Map();
        const monitorsPerChat = new Map();
        for (const h of backgroundWork()) {
          if (h.kind === "agent") agentsPerChat.set(h.chatId, (agentsPerChat.get(h.chatId) || 0) + 1);
          else if (h.kind === "monitor") { monitorsPerChat.set(h.chatId, (monitorsPerChat.get(h.chatId) || 0) + 1); if (!agentsPerChat.has(h.chatId)) agentsPerChat.set(h.chatId, 0); }
        }
        for (const [chatId, n] of agentsPerChat) {
          if (running.has(chatId)) continue;
          const m = monitorsPerChat.get(chatId) || 0;
          const existing = items.find((it) => it.chatId === chatId);
          if (existing) { existing.background = { ...existing.background, agents: Math.max(existing.background.agents || 0, n), monitors: Math.max(existing.background.monitors || 0, m) }; continue; }
          const chat = store.getChat(chatId);
          if (!chat) continue;
          items.push({
            id: `agent:${chatId}`,
            kind: "chat",
            chatId,
            title: chat.title || "",
            chatKind: chat.kind || "normal",
            workspaceId: chat.workspaceId || "",
            workspaceName: wsName(chat.workspaceId || ""),
            projectId: chat.projectId || "",
            projectName: projName(chat.projectId || ""),
            provider: chat.provider || "",
            model: chat.model || "",
            startedAt: Math.min(...backgroundWork(chatId).map((h) => h.startedAt || Date.now())),
            phase: "waiting",
            background: { monitors: m, agents: n, tasks: 0, wakeupAt: 0 },
            contextTokens: chat.contextTokens || 0,
            queued: (pendingRunInputs.get(chatId) || []).length,
            workflow: null,
            lockKey: "",
            stoppable: false,
          });
        }
        // Running dynamic workflows: a kind of ITS OWN per run — `workflow` is the graph's kind here —, with chat, name
        // and state, also in an IDLE chat (a workflow lives outside every turn; via `running` it would fall through).
        // From the data layer as in /api/runs/active; the pill reloads on the global event `dyn_workflow` (start and end).
        for (const l of store.dynRunsOpen()) {
          const chat = store.getChat(l.chatId);
          if (!chat) continue;
          const state = store.dynRunStatus(l.runId);
          items.push({
            id: `dynworkflow:${l.runId}`,
            kind: "dynworkflow",
            chatId: l.chatId,
            title: chat.title || "",
            chatKind: chat.kind || "normal",
            workspaceId: chat.workspaceId || "",
            workspaceName: wsName(chat.workspaceId || ""),
            projectId: chat.projectId || "",
            projectName: projName(chat.projectId || ""),
            provider: chat.provider || "",
            model: chat.model || "",
            startedAt: l.startedAt || 0,
            phase: "running",
            background: { monitors: 0, agents: 0, tasks: 0, wakeupAt: 0 },
            contextTokens: 0,
            queued: 0,
            workflow: null,
            dynWorkflow: { runId: l.runId, taskId: l.taskId, name: l.name, phase: state.phase, agents: state.agents, finished: state.finished },
            lockKey: "",
            stoppable: false,
          });
        }
        // What needs attention is on top; below it the longest run first — exactly what one looks for when checking
        // what keeps the machine busy.
        const rank = { ask: 0, running: 1, waiting: 2, limit: 3 };
        items.sort((a, b) => (rank[a.phase] ?? 4) - (rank[b.phase] ?? 4) || a.startedAt - b.startedAt);
        const counts = { total: items.length, running: 0, waiting: 0, ask: 0, limit: 0 };
        for (const it of items) {
          // The counters stay disjoint (total = running + waiting + ask + limit).
          if (it.kind === "limit") { counts.limit++; continue; }
          if (it.phase === "ask") counts.ask++;
          else if (it.phase === "waiting") counts.waiting++;
          else counts.running++;
        }
        // Copies being created: a list of ITS OWN next to `items` — a copy is no run of a chat (it belongs to none),
        // and `counts` stays the count of runs that the chat list's short info reads too. Waiting or in build; the
        // progress (step, estimate from the project's last finished copy) comes from projectbox/copy-progress.js. The
        // pill reloads on the copy event.
        const copies = [];
        try {
          const now = Date.now();
          for (const k of store.stackCopiesInState(["waiting_queue", "waiting_storage", "build"])) {
            const proj = store.getProject(k.projectId);
            copies.push({
              id: `copy:${k.id}`,
              name: k.name,
              instance: `copy-${k.name}`,
              projectId: k.projectId,
              projectName: proj?.name || "",
              workspaceId: proj?.workspaceId || "",
              workspaceName: wsName(proj?.workspaceId || ""),
              state: k.state,
              baseInstance: k.baseInstance || "main",
              startedAt: k.requestedAt || 0,
              progress: progressOf(k, { now }),
            });
          }
        } catch (e) { console.error("[active-runs] copies:", e?.message || e); }
        return send(res, 200, { items, counts, copies, now: Date.now() });
      }
  return NEXT;
}

export async function runChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // Abort the running generation.
        if (sub === "/stop" && m === "POST") {
          if (!running.has(id)) {
            // No turn — but perhaps a VERDICT. The oneshot itself cannot be aborted; the run can. It halts at the same
            // node, and the returning verdict writes nothing more. Without this branch the whole workflow ran through
            // despite the stop, and the answer claimed nothing was running.
            const chatS = store.getChat(id);
            const runS = chatS ? store.getWorkflowRun(id) : null;
            if (chatS && runS?.status === "running" && runningVerdicts.get(id)) {
              holdWorkflow(chatS, runS);
              return send(res, 200, { ok: true, note: T("A verdict was still running — the workflow halts at this point.") });
            }
            return send(res, 200, { ok: false, note: T("no run is running") });
          }
          return send(res, 200, { ok: stopRun(id) });
        }
        // "Steer": abort AND send the queued messages at once as one run.
        // 409 instead of 200 if nothing steerable waits — "sent: 0" would read like a success.
        if (sub === "/control" && m === "POST") {
          const chat = store.getChat(id);
          if (!chat) return send(res, 404, { error: "chat not found" });
          const r = await controlNow(chat);
          if (!r.ok) {
            // For `running` and `workflow` the messages stay queued.
            const error = {
              compacted: T("The context is being compacted — the messages will start on their own afterwards"),
              running: T("The run has not ended yet after the stop — the messages stay queued and run after it"),
              workflow: T("The workflow is deciding on the next step right now — the messages run with it"),
            };
            return send(res, 409, { error: error[r.reason] || T("no queued message"), reason: r.reason });
          }
          return send(res, 200, r);
        }
        // Interactive permission prompt (called by the cbase MCP server): report the request to the frontend and keep
        // it OPEN until the user decides (or timeout → decline).
        if (sub === "/permission-request" && m === "POST") {
          const b = await readBody(req);
          // Permanent approvals apply on the CLI path too (the CLI asks through this tool), otherwise "do not ask
          // again" rules would only be effective in third-party chats.
          if (loadPermissionRules().some((r) => ruleMatches(r, String(b.toolName || ""), b.input || {}))) {
            return send(res, 200, { behavior: "allow", updatedInput: b.input || {} });
          }
          // The requesting agent comes from the request: a subagent's MCP server carries its profile
          // (`CBASE_PROFILE_KEY`), the main run's none.
          const decision = await requestPermission(id, { toolName: b.toolName, input: b.input, toolUseId: b.toolUseId, agent: agentFromProfile(id, b.profileKey) });
          return send(res, 200, decision);
        }
        // Ask a question with a choice card (from the cbase MCP server, tool cbase_ask). Returns IMMEDIATELY — the
        // agent then ends its turn, the choice arrives as a message.
        if (sub === "/ask" && m === "POST") {
          if (!running.has(id)) return send(res, 409, { error: "No active run — a question belongs in a running turn." });
          const b = await readBody(req);
          const pending = openAskOf(id);
          if (pending) {
            // The card may have survived an interim question of the user (openAskOf, sticky in the run). Then "wait" is
            // not only a rule but the way forward: the open card holds the workflow step until the user answers it.
            return send(res, 409, {
              error: "Your question from the last turn is still open — the workflow step stays put because of it. Do NOT ask a new question, end your turn; the user's choice reaches you as the next message.",
              requestId: pending.requestId,
            });
          }
          let questions;
          try { questions = normalizeAskQuestions(b.questions); }
          catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
          const posted = postAsk(id, questions);
          return send(res, 201, { ok: true, requestId: posted.requestId });
        }
        // The user's choice for a question (from the frontend). It is delivered as an ordinary user message: if a turn
        // still runs, it is queued/injected, otherwise it starts a new run (resume) — exactly like a typed answer.
        if (sub === "/ask-answer" && m === "POST") {
          const b = await readBody(req);
          const rid = String(b.requestId || "");
          const open = openAskOf(id);
          if (!open || (rid && open.requestId !== rid)) {
            return send(res, 409, { error: T("This question is no longer open.") });
          }
          const answers = normalizeAskAnswers(open.questions, b.answers);
          if (!answers.some((a) => a.selected.length || a.text)) {
            return send(res, 400, { error: T("Please pick an option or write your own answer.") });
          }
          store.addMessage(id, "ask_answer", JSON.stringify({ requestId: open.requestId, answers }));
          sse(id, { type: "harness", subtype: "ask_resolved", requestId: open.requestId, answers });
          resolveNotices({ id, requestId: open.requestId });
          channelHumanInvolved(id);
          const answerPrompt = askAnswerPrompt(answers);
          const answerDisplay = askAnswerDisplay(answers);
          // If the card comes from a workflow skill, the run waits for THIS answer at the same node. Set it back to
          // running before delivery; workflowGateAfterRun decides after the continuation turn whether the skill asks
          // again or is done.
          const waitingRun = store.getWorkflowRun(id);
          const waitingPending = waitingRun?.status === "waiting" ? wf.pendingOf(waitingRun.cursor) : null;
          if (waitingPending?.kind === "agent_ask") {
            store.updateWorkflowRun(id, {
              status: "running", cursor: wf.clearPending(waitingRun.cursor), question: "", note: "",
            });
            logRunStep(waitingRun, "answer", {
              nodeId: waitingPending.node, nodeTitle: waitingRun.nodeTitle, step: waitingRun.step,
              detail: {
                question: waitingRun.question, answer: answerDisplay.slice(0, 2000),
                requestId: open.requestId, agent: true,
              },
            });
            emitWorkflowRun(id, store.getWorkflowRun(id));
          }
          // Cause explicitly "user": the human gave the answer (without the statement it would not count).
          const delivery = deliverUserPrompt(chat, { prompt: answerPrompt, display: answerDisplay, cause: "user" });
          // Workflow chat: channel messages that waited at the card now go as a turn of their own after the answer.
          if (store.getWorkflowRun(id)) channelAfterDelivery(store.getChat(id));
          return send(res, 202, { ...delivery, requestId: open.requestId, answers });
        }
        // Fork a chat: a new chat with copied history + inherited Claude session; fork_pending makes the first run
        // split off a session of its own via --fork-session (the original chat stays untouched). Artifacts are copied
        // as a snapshot; message attachments deliberately stay with the original chat.
        if (sub === "/fork" && m === "POST") {
          // Only a Coding chat is forked — the same set as the archivable ones (chats/genus.js): an app agent or the
          // child chat of a background run is 400 with the reason, and nothing is created.
          const refusal = forkRefusal(chat);
          if (refusal) return send(res, 400, { error: refusal });
          const now = Date.now();
          const parentSession = chat.claudeSessionId || null;
          // The fork is a Coding chat like its original and stays in its folder — it keeps working on the same thing.
          // The schedule binding (`scheduleId`/`scheduleRunId`) does NOT go along: a fork is no run of the schedule —
          // otherwise it would stand as a second chat of the same run in its list, carry the clock marker and die
          // with the schedule. It stays in its folder as an ordinary conversation.
          // The folder goes along only if it is a Coding folder: a manager folder (legacy of a mixed folder) is not
          // continued — then the folder drops instead of refusing the fork (it was not chosen, only inherited).
          const inheritedFolder = chat.folderId ? store.getChatFolder(chat.folderId) : null;
          const forkFolder = inheritedFolder && inheritedFolder.kind !== "manager" ? inheritedFolder.id : null;
          // The fork inherits level and ultracode toggle each on its own — through the ONE rule.
          // Row, history and fork marker in ONE go (store/chats.js createFork): row by row in autocommit would be one
          // fsync per row, the event loop would stall linearly with the history's length, and an error midway would
          // leave half a fork without `fork_pending`.
          // The own choice of level goes along (`effortOwn`).
          // The target goes along with its pause (`goalPaused`): otherwise a paused target would wake in the fork at
          // the first run — in the system prompt, with judge and continuation — without the human having resumed it.
          const child = store.createFork(id, ultracodeFollowUp(null, {
            id: crypto.randomUUID(), workspaceId: chat.workspaceId, projectId: chat.projectId, folderId: forkFolder,
            title: `Fork: ${chat.title}`.slice(0, 120), profile: chat.profile, kind: "normal",
            model: chat.model, permissionMode: chat.permissionMode, effort: chat.effort, ultracode: !!chat.ultracode,
            provider: providerForChat(chat), createdAt: now, updatedAt: now,
          }), { claudeSessionId: parentSession, forkPending: parentSession ? 1 : 0, goal: chat.goal || "", goalPaused: chat.goalPaused && String(chat.goal || "").trim() ? 1 : 0, titled: 1, effortOwn: chat.effortOwn ? 1 : 0, updatedAt: now });
          // The agenda goes along as a copy: the fork keeps working on the same plan, and from here each keeps its own.
          try { artifactStore.copyChatArtifacts(id, child.id); store.copyAgenda(id, child.id); }
          catch (e) {
            // The half-created fork goes through the ONE closing path like every deleted chat — it has no shells and
            // no subagents yet, but a second, shorter list would be the one forgotten at the next attachment.
            deleteChatPermanently(child);
            throw e;
          }
          // A fork begins in main — even if the original works in a copy (it does not inherit `chats.instance`); the
          // silent hint says so (its files and git states are main's, not the copy's): where the original works, where
          // the fork works, and how it switches (cbase_switch_instance; the human via the instance choice in the chat).
          // A copy belongs to no chat — the fork agent must not take it for foreign property.
          try {
            const copy = chat.projectId ? instanceNameForChat(id, chat.projectId) : "main";
            if (copy !== "main") {
              const name = copy.replace(/^copy-/, "");
              depositHint(child.id, T`This chat is a fork of a chat that works in ${copy} (the project's copy "${name}"). This fork works in main; what is in the copy shows up there only after fetching (copy/${name}/… in the main instance). Switching into the copy works with cbase_switch_instance (instance "${copy}").`, { source: "stack-copy" });
            }
          } catch (e) { console.error(`[fork] ${child.id}: hint about the original's copy not deposited:`, e?.message || e); }
          return send(res, 201, store.getChat(child.id));
        }
        // The user's decision on a permission request (from the frontend).
        if (sub === "/permission-decision" && m === "POST") {
          const b = await readBody(req);
          const rid = String(b.requestId || "");
          const pend = pendingPermissions.get(rid);
          // The card belongs to the route's chat — a foreign one or one not open (any more) is "not decided" (200 with
          // ok:false, as for one already decided; the clients read exactly that), and without a card nothing is
          // remembered either: "remember" must not store the rule globally regardless of whether there was a card.
          if (!pend || pend.chatId !== id) return send(res, 200, { ok: false });
          const behavior = b.behavior === "allow" ? "allow" : "deny";
          // updatedInput: the user may change the call BEFORE approving (e.g. correct a shell command).
          const updatedInput = b.updatedInput && typeof b.updatedInput === "object"
            ? { ...(pend?.input ?? {}), ...b.updatedInput }
            : (pend?.input ?? {});
          // The card of the Coding MCP airlock knows no "remember": its setting is made in Coding → MCP, not in the
          // heat of the moment on the card — a remember sent along is discarded.
          const isApproval = pend?.airlock === true;
          const decision = behavior === "allow"
            ? { behavior: "allow", updatedInput, ...(isApproval ? {} : { remember: typeof b.remember === "string" ? b.remember : "" }) }
            // Free-text reason to the MODEL: otherwise "declined" cannot be told from "broken".
            : { behavior: "deny", message: String(b.message || "").trim() ? `Declined by the user: ${String(b.message).trim()}` : "Declined by the user" };
          // For native CLIs the approval goes through the MCP permission prompt — nobody can remember the rule there,
          // so the server does it at this one place for all.
          const ok = resolvePermission(rid, decision, { origin: "user", reason: String(b.message || "").trim() });
          if (ok && behavior === "allow" && !isApproval && typeof b.remember === "string" && b.remember.trim()) rememberPermissionRule(b.remember);
          if (ok) sse(id, { type: "harness", subtype: "permission_resolved", requestId: rid, behavior });
          return send(res, 200, { ok });
        }
        // Provider-neutral monitor core (cbase_monitor). STARTING only from a running turn of this chat (approval, cwd
        // and instance are there); afterwards the monitor belongs to the CHAT (runs/monitors.js) and survives the turn.
        if (sub === "/monitor" && m === "POST") {
          const ctl = runMonitorControllers.get(id);
          if (!running.has(id) || !ctl) return send(res, 409, { error: "No active run capable of monitors." });
          const b = await readBody(req);
          try {
            const task = await ctl.start(b, { permissionChecked: false });
            return send(res, 201, task);
          } catch (e) {
            return send(res, 400, { error: String(e?.message || e) });
          }
        }
        // Stopping works WITHOUT a turn: the agent via cbase_monitor_stop (`from: "agent"`), the human via the card
        // under background tasks (`from: "human"` — then the next turn gets a silent hint). `from` is mandatory (400),
        // as at the agents' stop routes: a missing field is no statement.
        if (sub === "/monitor/stop" && m === "POST") {
          const b = await readBody(req);
          const taskId = String(b.taskId || b.task_id || "");
          if (!taskId) return send(res, 400, { error: "taskId required" });
          if (b.from !== "agent" && b.from !== "human") return send(res, 400, { error: "from must be \"agent\" or \"human\"" });
          const ok = stopMonitor(id, taskId, { through: b.from });
          return send(res, ok ? 200 : 404, ok ? { ok, taskId } : { ok, taskId, error: T("No running monitor with this id in this chat.") });
        }
        // ── Native subagents (cbase_agent) ─────────────────────────────────────
        // Start, message, output and stop share the resolution (which core, which agent, which instance) — ONCE in
        // communication/target-subagent.js, because cbase_agent_send is distributed there over all targets (subagent,
        // channel, chat …).
        const { onlyInstanceOfTheFence, agentsCore, withTarget, onlyOwnChildren, agentInForeignInstance, startInForeignInstance } = subagentHelper(id, ctx.fence || null);
        if (sub === "/agent" && m === "POST") {
          // `callId` is set by the cbase MCP server from the request's `_meta` — not an argument of the model.
          const { callId, ofProfile, ...b } = await readBody(req);
          const { ctl, parent } = agentsCore({ ofProfile });
          if (!ctl) return send(res, 409, { error: NO_RUN });
          if (startInForeignInstance(ctl, parent)) return send(res, 403, { error: FOREIGN_INSTANCE });
          try {
            return send(res, 201, await ctl.start(b, { parentToolUseId: typeof callId === "string" && callId ? callId : null, parentAgent: parent || null }));
          } catch (e) {
            return send(res, 400, { error: String(e?.message || e) });
          }
        }
        // cbase_agent_send: ONE path for every target — own subagent, channel:<id>, chat:<id>, wf:<runId>:<n>. The
        // sender is the chat in the path; `from` is mandatory (400). With `from: "human"` (the "message" button)
        // WITHOUT a running turn — resolved like the stop (communication/send.js).
        if (sub === "/agent/send" && m === "POST") {
          // The fields EXPLICITLY: the seam guard (tools/check) reads what the route reads and does not follow a
          // body into an object property — `body: await readBody(req)` would mean "reads nothing" to it, and the human
          // button would stand as a dead seam. The route accepts no more fields either: to (agentId/name as alias),
          // message (text), from, ofProfile, workflowAgent (the MCP server's workflow marker), outerLoop (the marker of
          // an outer-loop run), files.
          const { to, agentId, name, message, text, from, ofProfile, workflowAgent, outerLoop, files } = await readBody(req);
          const r = await sendMessage({ chat, body: { to, agentId, name, message, text, from, ofProfile, workflowAgent, outerLoop, files }, fence: ctx.fence || null });
          return send(res, r.status, r.body);
        }
        if (sub === "/agent/output" && m === "POST") {
          const { ofProfile, ...b } = await readBody(req);
          const named = String(b.agentId || b.task_id || b.name || "");
          const { ctl, parent, target } = agentsCore({ ofProfile }, named);
          if (!ctl) return send(res, 409, { error: "No active run — the subagents of an ended run are gone." });
          if (agentInForeignInstance(ctl, target?.agentId || named)) return send(res, 403, { error: FOREIGN_INSTANCE });
          if (!onlyOwnChildren(ctl, parent, target?.agentId || String(b.agentId || ""))) return send(res, 400, { error: FOREIGN_CHILD });
          try {
            // Who asks ("" = the main agent): the main agent never waits (providers/agent-wait.js).
            return send(res, 200, await ctl.output(withTarget(b, target), { parentAgent: parent || "" }));
          } catch (e) {
            return send(res, 400, { error: String(e?.message || e) });
          }
        }
        // Stop per agent and "stop all background agents" ask the OWNER (runs/agents.js), not the running turn — a
        // background agent can live without a turn. Two causes over ONE path: the main agent stops via
        // `cbase_agent_stop` (`from: "agent"`), a human via the buttons in the agent bar or sheet (`from: "human"`).
        // Who it was is in the subagent's report — and ONLY a human stop that no turn delivers any more deposits the
        // silent hint for the next turn. The originator is mandatory: a missing field is no statement.
        if ((sub === "/agent/stop" || sub === "/agents/stop") && m === "POST") {
          const b = await readBody(req);
          if (b.from !== "human" && b.from !== "agent") return send(res, 400, { error: "from required: \"human\" or \"agent\"" });
          const ofHuman = b.from === "human";
          if (sub === "/agents/stop") return send(res, 200, { ok: true, stopped: stopBackgroundAgents(id, { ofHuman }) });
          const agentId = String(b.agentId || b.task_id || b.name || "");
          if (!agentId) return send(res, 400, { error: "agentId required" });
          // A subagent stops only ITS children; the human and the main agent anyone. Which agent the name means is
          // said by the same resolution as for send/output — own children first, ambiguous ⇒ 400 with the candidates.
          const caller = ofHuman ? null : callerOf(id, b.ofProfile);
          let target = null;
          try { target = resolveAgent(id, agentId, { parentAgent: caller ? caller.parentAgent : "", ...onlyInstanceOfTheFence() }); }
          catch (e) { return send(res, Number(e?.status) || 400, { error: String(e?.message || e), ...(e?.candidates ? { candidates: e.candidates } : {}) }); }
          const targetId = target?.agentId || agentId;
          // From a project network only an agent of the token's instance — also with `from: "human"` (a human never
          // comes through the fence). If no core knows the agent, stopAgent answers itself.
          if (agentInForeignInstance(target?.core || coreWithAgent(id, targetId), targetId)) return send(res, 403, { error: FOREIGN_INSTANCE });
          if (caller && !onlyOwnChildren(target?.core || caller.core, caller.parentAgent, targetId)) return send(res, 400, { error: FOREIGN_CHILD });
          const r = stopAgent(id, targetId, { ofHuman, core: target?.core || null });
          if (!r) return send(res, 409, { error: T("No living subagent in this chat.") });
          // If NO core and no record knows the name: 404 instead of 200 {ok:false} — also the agentId of a workflow
          // agent (its core is an own one, not among the chat's cores); it is halted at the workflow (skipping), never
          // via the subagent stop.
          if (!target && !r.ok) return send(res, 404, { error: T`No subagent "${agentId}" in this chat.` });
          return send(res, 200, r);
        }
        // "Into the background" (the Ctrl+B of Claude Code): a foreground agent switches IMMEDIATELY, its waiting tool
        // call returns with "keeps running in the background", and the chat is free. Only the human presses the
        // button (agent bar or sheet); without an agentId that is no statement (400). `ok:false` ⇒ it no longer ran.
        if (sub === "/agent/background" && m === "POST") {
          const b = await readBody(req);
          const agentId = typeof b.agentId === "string" ? b.agentId.trim() : "";
          if (!agentId) return send(res, 400, { error: "agentId required" });
          const r = sendIntoTheBackground(id, agentId);
          if (!r) return send(res, 409, { error: T("No living subagent in this chat.") });
          return send(res, 200, r);
        }
        // The CHOICE: agent types and providers/models. The catalog is not in the MCP server's (static) tool
        // description but here — it depends on workspace and project. The body is the "start" view of
        // cbase_agents_list (communication/read.js startView) — ONE version for both paths.
        if (sub === "/agents" && m === "GET") {
          return send(res, 200, startView(chat, ctx.fence || null));
        }

        // Provider-neutral wakeup (cbase_wakeup). It belongs to the CHAT (runs/wakeup.js): it is SET only from a turn
        // (the agent calls it there — like the monitor), the turn then ends regularly, and at the wake time the owner
        // delivers the continuation via the wake path.
        // It is CANCELLED without a turn too: `stop: true` (the agent, from a later turn) — without a hint, it knows.
        if (sub === "/wakeup" && m === "POST") {
          const b = await readBody(req);
          if (b.stop === true) return send(res, 200, stopWakeup(id, { through: "agent" }));
          if (!running.has(id)) return send(res, 409, { error: "No active run — a wakeup is set from a running turn." });
          try {
            return send(res, 201, setWakeup(id, b));
          } catch (e) {
            return send(res, 400, { error: String(e?.message || e) });
          }
        }
        // The HUMAN's stop (card under background tasks, web and iOS) — like `/monitor/stop`: `from` is mandatory (a
        // missing field is no statement); only "human" deposits the silent hint for the next turn. `cancelled:false`
        // ⇒ none was set (any more).
        if (sub === "/wakeup/stop" && m === "POST") {
          const b = await readBody(req);
          if (b.from !== "human" && b.from !== "agent") return send(res, 400, { error: "from required: \"human\" or \"agent\"" });
          return send(res, 200, stopWakeup(id, { through: b.from }));
        }
        // Compact the context (like /compact): summarise the history, discard the old Claude session; the summary is
        // injected once at the next prompt. Open background work does not hold it up — the first turn afterwards
        // carries it as an attachment (runs/after-compaction.js).
        if (sub === "/compact" && m === "POST") {
          if (running.has(id)) return send(res, 409, { error: T("Run active — please wait for the agent to finish.") });
          // Between two turns the chat can be occupied too — the target gate or the graph workflow is judging the last
          // one right now (the client releases `busy` already at `run_done`). A compaction now would start the queue
          // in its finally next to the continuation the verdict is about to launch.
          if (targetCheck.has(id) || workflowDecides.has(id)) {
            return send(res, 409, { error: T("The verdict on the last turn is still running — please wait a moment.") });
          }
          // `instruction`: "/compact <instruction>" — custom instructions appended to the summary's job. Without a
          // body no instruction.
          const b = await readBodyOrEmpty(req);
          const instruction = typeof b?.instruction === "string" ? b.instruction.trim().slice(0, 4000) : "";
          try {
            return send(res, 200, await compactChatContext(chat, { instruction }));
          } catch (e) {
            return send(res, 500, { error: e?.message || String(e) });
          }
        }
  return NEXT;
}

export async function autoContinueChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // Does this chat wait for the reset of a usage limit? (Strip above the history.)
        if (sub === "/auto-continue" && m === "GET") {
          return send(res, 200, { wait: autoContinueView(store.getPendingResume(id)), enabled: autoContinueEnabled() });
        }
        // "Try now" — deliberately without another limit check (the user may try).
        if (sub === "/auto-continue/now" && m === "POST") {
          if (!store.getPendingResume(id)) return send(res, 404, { error: T("no run is waiting") });
          if (running.has(id)) return send(res, 409, { error: T("the chat is already running") });
          // `anyway` = the button "start anyway (costs credit)". The body must be read — otherwise both buttons would
          // act the same (see fireAutoContinue).
          const b = await readBodyOrEmpty(req);
          const r = await fireAutoContinue(id, { manual: true, anyway: b?.anyway === true });
          return send(res, 200, { ok: r.ok === true, wait: autoContinueView(store.getPendingResume(id)) });
        }
        if (sub === "/auto-continue" && m === "DELETE") {
          const gone = cancelAutoContinue(id, { note: T("Waiting for the limit reset was cancelled.") });
          return send(res, 200, { ok: gone, wait: null });
        }
  return NEXT;
}
export async function messageChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;

        if (sub === "/message" && m === "POST") {
          const b = await readBody(req); const text = (b.text || "").trim();
          // Attachments: only files of this chat uploaded before via /attachments (referenced by basename). Searched
          // with a fallback (runs/runtime-location.js attachmentFolderToRead): after a project switch an attachment
          // still lies at the OLD location until the move at the beginning of the next turn — without the fallback it
          // would silently drop out of the message. The current location first.
          // If the turn runs in the project container, it does not see the old location: an attachment lying only
          // there is COPIED to the run's location (attachments are immutable), and the prompt names this path. In the
          // backend the place of finding stays (the run reads the old location via --add-dir). Asked only when an
          // attachment lies elsewhere.
          let folder = null; // asked only when an attachment arrives
          let inContainer; // asked only when an attachment lies only at another location
          const location = new Map(); // file → the folder it lies in
          const attachments = [];
          for (const a of Array.isArray(b.attachments) ? b.attachments : []) {
            const file = safeFileName(a?.file);
            if (!file) continue;
            folder ||= attachmentFolderToRead(id);
            let dir = folder.find((d) => fs.existsSync(path.join(d, file)));
            if (!dir) continue;
            if (dir !== folder[0]) {
              const location2 = locationForChat(id);
              if (inContainer === undefined) inContainer = Boolean(instanceOfChat(id, location2)); // the chat carries its copy
              if (inContainer) {
                try { dir = fetchAttachmentAtLocation(id, file, location2) || dir; } catch (e) { console.warn(`[runtime-location] ${id}: attachment ${file} not copied to the run's location — ${e?.code || e?.message || e}`); }
              }
            }
            location.set(file, dir);
            // Width and height of an image from the file's header (runtime/image-dimensions.js) — the server rewrites the
            // meta, a `w`/`h` from the client does not count; without a readable header the meta stays as it was.
            attachments.push(withImageDimensions({
              name: String(a?.name || file).slice(0, 200), file,
              mime: attachmentMime(file), size: fs.statSync(path.join(dir, file)).size,
            }, imageDimensionsFromFile(path.join(dir, file))));
          }
          const attDir = (a) => location.get(a.file);
          if (!text && !attachments.length) return send(res, 400, { error: "text required" });
          // `/workflow:<short name>` (workflows/slash-workflow.js): checked on sending — a refusal (400, 404, 409)
          // stores nothing, assigns no title, starts nothing; a hit rewrites the message for the model and carries the
          // announcement. `text` is read even if the client sends a display along. The check stands BEFORE the answer
          // to a waiting workflow: a mention is a 409 there, not an answer.
          const graph = graphSlash(chat, { text, attachments: attachments.map((a) => path.join(attDir(a), a.file)) });
          if (graph?.status) return send(res, graph.status, graph.body);
          // `/name` of a stored dynamic workflow starts nothing (dynworkflows/slash.js): the route refuses instead of
          // passing the line to the CLI (there "Unknown command" would swallow the message). It does not read the body
          // field `dynWorkflow`.
          const dynRefusal = graph ? null : dynSlashRefusal(chat, text);
          if (dynRefusal) return send(res, dynRefusal.status, dynRefusal.body);
          // A hit gives the chat the name of the (first) workflow — like the manual start POST /workflow; the title
          // oneshot is then skipped.
          const titleBase = graph ? graph.title : text || attachments[0].name;
          if (chat.title === "New chat") {
            const title = titleBase.length > 40 ? titleBase.slice(0, 40) + "…" : titleBase;
            store.updateChat(id, { title });
            // Immediate sidebar synchronisation: locally via the chat stream and also globally for all chat lists
            // visible right now.
            sse(id, { type: "harness", subtype: "title", chatId: id, title });
            broadcast({ type: "chat_title", chatId: id, title });
            // Produce the proper title IMMEDIATELY (small model, concurrently) instead of only at the run's end: a run
            // with background agents easily takes ten minutes, and for that long only the cut-off beginning of the
            // message would stand in the sidebar.
            if (!graph) maybeAutoTitle(chat, text, "");
          }
          // Optional differing display (e.g. "/goal <text>"): that way the slash command stands in the history while
          // the LLM gets only the actual job (text) as the prompt.
          const displayText = typeof b.display === "string" && b.display.trim() ? b.display.trim() : text;
          // If the client already sent a display of its own (such as "/goal <text>"), it has decided the case — then
          // the resolver touches nothing.
          // `text` is const and stays so: what the MODEL reads is a quantity of its own.
          // With `/workflow:` the model reads the rewritten prompt; the skill resolution then does not apply.
          const promptSource = graph ? graph.prompt
            : (typeof b.display === "string" && b.display.trim() ? null : resolveSkillSlash(chat, text)) || text;
          // Claude gets the attachments as file paths — the Read tool reads all types (images, PDFs, text, notebooks).
          const prompt = attachments.length
            ? [promptSource, "", "[Attached files — read them first with the Read tool:]",
               ...attachments.flatMap((a) => {
                 const row = `- ${path.join(attDir(a), a.file)}`;
                 // A text extract next to the attachment: without this note it would lie there and nobody would know of it.
                 const extract = path.join(attDir(a), `${a.file}.txt`);
                 return fs.existsSync(extract) ? [row, `  (text read from it: ${extract})`] : [row];
               })].join("\n").trim()
            : promptSource;
          // The route does not read the field `todos`: a Coding chat creates no tasks. An old client still sending it
          // is silently ignored — no 400, the message goes like any other.
          // If this chat waits for the reset of a usage limit, the user's message is QUEUED (deliverUserPrompt,
          // "parked is like running"). Whoever wants to get rid of the continuation presses "cancel" at the strip
          // (DELETE /auto-continue).
          // If this chat's workflow waits for an answer to a question, this message IS the answer: it continues the
          // run instead of starting a turn of its own.
          if (store.getWorkflowRun(id)?.status === "waiting") {
            store.addMessage(id, "user", displayText, Date.now(), attachments);
            sse(id, { type: "harness", subtype: "user_message", text: displayText, attachments: attachments || [] });
            // The answer carries its attachments ALONG: an answer consisting only of a file would otherwise be empty
            // — the run would move on with an empty answer placeholder, and the file would never reach the model.
            const response = withoutControlCharacters(attachments.length
              ? [text, "", "[Attached files — read them first with the Read tool:]",
                 ...attachments.map((a) => `- ${path.join(attDir(a), a.file)}`)].join("\n").trim()
              : text);
            answerWorkflow(chat, response)
              // Channel messages that waited at the gate now follow — as a turn of their own behind the continuation step.
              .then(() => { const c = store.getChat(id); if (c) channelAfterDelivery(c); })
              .catch((e) => console.error("[workflow] answer failed:", e?.message || e));
            return send(res, 202, { ok: true, workflow: true });
          }
          // During a turn deliverUserPrompt accepts on the server side (queue, or inject at once in the waiting
          // phase); otherwise it starts a new run.
          // Cause explicitly "user": the human typed (human input reads only the statement).
          // The announcement travels with the input — queued during a turn or directly into the new run.
          return send(res, 202, deliverUserPrompt(chat, { prompt, display: displayText, attachments, cause: "user", ...(graph ? { announcement: graph.announcement } : {}) }));
        }
        const qm = sub.match(/^\/message\/queue\/([0-9a-f-]+)$/);
        if (qm && m === "DELETE") {
          const dismissed = cancelRunInput(id, qm[1]);
          if (dismissed.status === 404) return send(res, 404, { error: "queued message not found" });
          if (dismissed.status === 409) {
            return send(res, 409, { error: T("A system message cannot be discarded — the main agent receives it with the next turn."), queue: publicPendingInputs(id) });
          }
          return send(res, 200, { ok: true, queue: publicPendingInputs(id) });
        }
  return NEXT;
}
