// cbase server — runs in the Electron main process.
// Serves the static UI (Next export) and implements the complete API (chats + SSE, workspaces, skills, context, chat-bound
// artifacts, application/port registry). Claude Code talks to the API through the cbase MCP server (electron/mcp/cbase-mcp.js).
// Only startServer lives here: initialization, the ROUTES table and the request callback as a shell (prelude, dispatcher, 404,
// catch); everything else is in app-state.js and the area folders (runtime/, runs/, chats/, workspaces/, projects/, devtools/,
// workflows/, channels/, store/ …).
// No import back to this file (guard: zero hits); headerBundle is a re-export.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setStartGate } from "./providers/index.js";
import { warmupEmbeddings } from "./embeddings.js";
import { warmContextIndex } from "./retrieval.js";
import { attachBrowserDevtools, closeAllUserBrowsers, onBrowsersChanged, startAgentScan } from "./browsers.js";
import { sweepOrphanedBrowsers } from "./browser-process.js";
import { chatProfileDir, reapUnusedChatProfiles, setProfileLockSeam } from "./browser-profiles.js";
import { initCaptures } from "./captures.js";
import { attachTunnel } from "./tunnel.js";
import { autostart as tunnelAutostart, stopTunnel } from "./vscode-tunnel.js";
import * as store from "./store.js";
import * as artifactStore from "./artifacts.js";
import { T, setUiLang, setUiZone } from "./i18n.js";
import { initServices, recordNotice, startMonitor } from "./services.js";
import { autoContinueSweepMs, gateVerdictHook } from "./runs/limit-gate.js";
import { BASE_URL, DIRS, HOST, setBaseUrl, setBootId, setDirs, setPickDirectoryFn } from "./app-state.js";
import { randomUUID } from "node:crypto";
import { NEXT, send, serveStatic } from "./runtime/http.js";
import { originVerdict } from "./runtime/origin.js";
import { requestBegin, requestEnd, startLoopWatch } from "./runtime/loop-watch.js";
import { SCHEDULED_CHECK_MS, scheduledAtStart, scheduledTick } from "./scheduled/tick.js";
import { accountRoutes, codexRoutes } from "./account/routes.js";
import { activeRunsGateRoute, activeRunsRoute } from "./runs/routes.js";
import { adjustRoutes, autocompactNotifyRoutes, settingsRoutes } from "./settings/routes.js";
import { broadcast, eventStreamRoute, setRunState, sse } from "./runtime/sse.js";
import { channelRoutes } from "./channels/routes.js";
import { chatCreateRoute, chatFolderRoutes, chatListRoute, chatRoutes } from "./chats/routes.js";
import { devtoolRoutes, vscodeTunnelRoutes } from "./devtools/routes.js";
import { describeProfile } from "./devtools/browser-names.js";
import { mcpCatalogRoutes } from "./toolchain/routes.js";
import { skillHistoryRoutes } from "./toolchain/skill-routes.js";
import { migrateFileSkillsToDb } from "./toolchain/skill-catalog.js";
import { playwrightConfigPath, prewarmPlaywrightMcp } from "./toolchain/playwright.js";
import { allLocations, attachmentLocation, serviceLogFile, flatRuntimeFolder, runtimeFolderOf, locationFor, playwrightProfileRoot, catchUpLanes } from "./runs/runtime-location.js";
import { removeAsRoot } from "./projectbox/cleanUp.js";
import { portRoutes, projectListRoutes, projectRoutes, serviceEventRoutes, serviceGlobalRoutes, servicePortRoutes } from "./projects/routes.js";
import { previewRoutes } from "./preview/routes.js";
import { previewRestartGrace, previewServerEnd, targetRemoved } from "./preview/links.js";
import { scheduleNextRoute } from "./scheduled/routes.js";
import { scheduledApprovalRequest, scheduledApprovalRuling } from "./scheduled/notification.js";
import { pushVerdictForNote, setGraphRunObserver, setTriggerWakeup } from "./workflows/run-state.js";
import { registerEmpty, registerHook, registerSwitch } from "./runs/hooks.js";
import { autoTitleHook } from "./runs/post-run.js";
import { followUpRunSwitch, graphHoldSwitch, verdictSwitch, workflowAbandonedHook, workflowFailedHook, workflowGateHook, workflowRunsHook, workflowLocksHook } from "./workflows/gates.js";
import { curateHook } from "./projects/context.js";
import { approvalRulingHook } from "./runs/approval-ruling.js";
import { channelInputHolds, channelHumanHook, channelRestartGraceHook, channelRestoredHook, channelDeliveryHook } from "./channels/delivery.js";
import { deliverUserPrompt, setInputHolds } from "./runs/queue.js";
import { chatSearchRestartGraceHook } from "./communication/search.js";
import { workflowDismissedHook, workflowContinueHook } from "./workflows/driver.js";
import { scheduledWorkEnd, scheduledAbandoned, scheduledChatClosed, scheduledInputDismissed, scheduledEndHook, scheduledTurnStart, scheduledDismissedHook, cadencePlainText } from "./scheduled/run.js";
import { setScheduledCadenceText } from "./runs/system-prompt.js";
import { migrateProviderAtStart } from "./account/provider-migration.js";
import { startCatalog, stopCatalog } from "./providers/openrouter-catalog.js";
import { startAmountTick } from "./account/openrouter-inquiry.js";
import { migrateRetiredModels } from "./account/model-migration.js";
import { migrateAutoChats, migrateRoleLevelsLater } from "./chats/auto-gone.js";
import { haltAutoArchive, autoArchiveCycle, autoArchiveTickMs } from "./chats/auto-archive.js";
import { seedMissingAgendaKeeper, seedMissingTimelineAgents, seedMissingSummarizer } from "./outerloop/seed.js";
import { migrateProfilesIntoInstructions } from "./workspaces/instructions-migration.js";
import { outerLoopTurnStart, setOuterLoopAborter } from "./outerloop/abort.js";
import { OUTER_LOOP_TICK_MS, outerLoopAborter, outerLoopAtServerEnd, outerLoopAtStart, outerLoopChatClosed, outerLoopEndHook, outerLoopRestartGrace, outerLoopTick } from "./outerloop/trigger.js";
import { dropCodingServer, dropRemovedTools, migrateToolLists } from "./toolchain/agent-tools.js";
import { migrateCommunicationCoding } from "./channels/migration-communication.js";
import { resumeInterruptedWork } from "./runs/resume.js";
import { openAskOf } from "./runs/ask.js";
import { loadRunInputs, running } from "./runs/state.js";
import { runInputsRestartGrace, sweepAutoContinues } from "./runs/auto-continue.js";
import { lateBookingRestartGrace } from "./runs/lateBooking.js";
import { agentsAtServerEnd, setWorkEmptyObserver, setWithoutTurn, reportOrphaned } from "./runs/agents.js";
import { monitorsAtServerEnd, monitorsRestartGrace, closeMonitors, setMonitorDelivery } from "./runs/monitors.js";
import { closeWakeup, setWakeupDelivery, wakeupAtServerEnd, loadWakeup, wakeupRestartGrace } from "./runs/wakeup.js";
import { setGraphSource, setBackgroundSource } from "./runs/background.js";
import { dynWorkflowSituation, dynWorkflowsAtServerEnd, dynWorkflowsAtStart, dynWorkflowsChatClosed, dynWorkflowsRestartGrace, dynWorkflowsOpen, stopDynWorkflow } from "./dynworkflows/run.js";
import { coreWithoutTurn, setTurnCompletion, setTurnPreamble, catchUpVerdict } from "./runs/do-run.js";
import { graphCandidates, graphRunsOpen, graphStartsRestartGrace, graphTickMs, graphTurnCompletion, setGraphRowsObserver } from "./workflows/graph-start.js";
// The shared arbiter of storage waiting (graph starts and copies), the copy queue and the heavy-load wake timer.
import { setStorageQueueSource, storageQueueSoon, wakeStorageQueue } from "./workflows/storage-queue.js";
import { wakeMainReady, copyCandidates, copiesRestartGrace, setCopyProcedure, setCopyDismantling, setQueueWakeup } from "./stacks/queue.js";
// The procedure and teardown of a copy (the queue enters them through the two connectors) and the main's native services at freeze.
import { copyBuild, readSnapshot } from "./stacks/build.js";
import { setCopyRepoSource } from "./git.js";
import { dismantleCopy } from "./stacks/dismantling.js";
import { setNativeServicesStatus } from "./stacks/freeze.js";
import { setServicesStopper } from "./stacks/clearAway.js";
import { setHeavyLoadWakeup } from "./projectbox/heavyLoad.js";
import { instancesRestartGrace, setRelocationDecider, setStateWakeup } from "./projectbox/instances.js";
import { helperRestartGrace } from "./projectbox/helper.js";
import { projectNamesRestartGrace } from "./projectbox/names.js";
import { afterOccupancy, projectLocked, projectLock, wakeProject, setErrorAttempt, setStoppedStart, setInstanceForChat, setLanguageServiceEnd, setLanguageServiceGroups } from "./projectbox/idle.js";
import { endAllSessions as endAllLanguageServer, endSessions as endLanguageServer, groupsInB as languageServerGroupsInB, setInterpreterSupplier, setStartLock as setLanguageServiceStartLock } from "./lsp/sessions.js";
import { setFormatter, setInterpreterMachine, setStatusAddition } from "./lsp/actions.js";
import { projectFormatter, statusAddition as languageServiceStatusAddition } from "./lsp/formatter.js";
import { interpreterAction, interpreterFor } from "./lsp/interpreter.js";
import { nudgeStopped, instanceStartCandidates } from "./projectbox/instance-stop.js";
import { projectStartGate, setProjectLock } from "./runs/project-lock.js";
import { detectionCandidates, runServicesScan, serviceScans } from "./projects/scans.js";
import { setServicesDetection } from "./projectbox/detection.js";
import { projectboxServerEnd } from "./projectbox/serverEnd.js";
// The observer: recovery past cbase, the desired state kept continuously.
import { resumptionRestartGrace, stopResumption } from "./projectbox/resumption.js";
import { mcpBaselineRestartGrace } from "./toolchain/mcp-load.js";
// Restoration after every start of B (restart-grace hook, the FIRST of its kind).
import { setNativeServicesStarter, restoreInstance, restoreRestartGrace } from "./projectbox/restore.js";
// Recreation (deviation from image/mounts, missing container) at the next idle, plus the follow-up to restoration (the window
// before the restart grace).
import { setRecreateRequest, setRecreateRestartGrace, earmarkRestore } from "./projectbox/restore.js";
import { recreateRequest, cleanUpRecreate, recreateErrorAttempt, recreateRestartGraceSeam, recreateTurnObserver, setRecreateFinished } from "./projectbox/recreate.js";
import { setTurnObserver } from "./runs/instance.js";
import { MAIN, copyNameOf } from "./projectbox/creation.js";
// The backups of the copies are never mounted — the literal lives in stacks/location.js and projectbox/ does not import stacks/,
// hence a setter.
import { setOccupancyEnd, setNeverMountedAddition } from "./projectbox/instance.js";
import { copyLocation, neverMountedCopies, projectCopiesLocation } from "./stacks/location.js";
// Triggers and lifetime of a copy (stacks/remove.js): deleting a project or workspace, the end of a turn and the restart grace; the
// binding of a chat (from `chats.instance`) and the hint on project switch. Setters only: projectbox/, runs/ and workflows/ never
// import stacks/. Deleting a chat and archiving are no triggers — a copy belongs to no chat.
import {
  copyWorkOf, copyAtProjectSwitch, copyOfTheChat, copyDeleteStep,
  copiesRemoveCleanUp, copiesRemoveRestartGrace, copiesRemoveTurnEnd, copiesRemoveWake,
} from "./stacks/remove.js";
import { setArchiveObserver, setCopyWork } from "./runs/archive.js";
import { instanceNameForChat, setCopySource } from "./runs/instance.js";
// The chat moves into its copy — the source of the child chats and the wake-up call in the restart grace; the transitions themselves
// (move-in, move-out) are called by the setter stacks/state.js.
import { copyKind, copiesWakeRestartGrace, migrateCopiesFree } from "./stacks/inset.js";
import { setLayoutRevert, setCopyDeleteStep, setCopiesLocations } from "./projectbox/erase.js";
import { setGitOverview, setGitWakeup } from "./devtools/code-route.js";
import { smallView } from "./gitView/small.js"; // branchesRunning/counters in GET …/git
import { gitViewTurnEnd } from "./gitView/cache.js"; // a project's cached reads are dropped at turn end
import { capturesShowHook } from "./chats/captures-show.js"; // agents' captures appear in the chat at turn end
import { containerOf, runInstance } from "./projectbox/run-instance.js";
import { writeGitProjects, gitProjectsIncomplete, createGitAccessKey, setGitLocksAddition } from "./projectbox/git-assignment.js";
import { dockerKind, dockerProgram } from "./projectbox/docker.js";
import { thawRestartGrace, dockerChildAfterThaw, isFrozen } from "./projectbox/docker.js";
import { setInstanceSource } from "./runs/instance.js";
import { projectCodexDir, projectCodexHomes } from "./runs/session-location.js";
import { setCodexHomeSource } from "./providers/connectors/codex.js";
import { setInProjectSeam } from "./runtime/inProject.js";
import { projectboxOps } from "./projectbox/ops.js";
// Follow-up of worktrees at the transition to `ready`, open teardown jobs at server end, git.path for VS Code at start.
import { atReady } from "./projectbox/restore.js";
// `~/.vscode-server` per project — an acceptor at `atReady` cleans up old versions (main only).
import { runningCleanUp, cleanUpVscodeServer } from "./projectbox/vscode-server.js";
// Fetch the VS Code server UPFRONT — at start, on a 6 h tick and per main after cleanup at `atReady`.
import { vscodeUpfrontForProject, vscodeUpfrontRestartGrace, stopVscodeUpfront } from "./projectbox/vscode-upfront.js";
import { gitPostWork, openGitJobsUntil } from "./runs/git-post-work.js";
import { enterGitPath } from "./vscode-tunnel.js";
// Restart grace of half relocations and continuing after the switchover.
import { relocationRestartGraceSeam } from "./projectbox/relocation/procedure.js";
// The ops status (compose in B, projects without an instance row) and the desired snapshot.
import { projectboxOpsRoutes } from "./projectbox/relocation/routes.js";
// Setup of new projects — continued at `atReady` and at the end of a recreate, source "setup" of the storage queue, the `detection`
// field per project, the rules route (also without ops). Service detection after the end triggers setup through
// projectbox/detection.js — ONE seam, setServicesDetection below.
import { resumeSetup, setupStorageCandidates, setSetupHint, setSetupSaveGate } from "./projectbox/setup/procedure.js";
// The restart-grace hook "project-archive" (archive files without a row, rows without a project).
import { archiveRestartGrace } from "./projectbox/setup/archive.js";
import { setupRunning, layoutWriteLock, setDetectionReader, setLayoutReader, setLayoutRowsReader, setUploadObserver } from "./projectbox/setup/status.js";
// A layout job: reader, quiet, restart grace, observers (projectbox/layout/).
import {
  layoutAtReady, layoutReader, layoutAfterChat, layoutRestartGrace, checkBackLayout, layoutRow, setDynWorkflowAccess,
  setLayoutExecution, revertWaiting,
} from "./projectbox/layout/job.js";
// The execution: journal, switchover, way back (projectbox/layout/procedure.js).
import { layoutProcedure } from "./projectbox/layout/procedure.js";
import { setTerminalEndObserver } from "./terminal.js";
import { projectCreationRoutes } from "./projectbox/setup/routes.js";
import { creationMode } from "./projectbox/setup/rules.js";
import { storageSituation } from "./workflows/storage-gate.js";
import { mcpAccessFor } from "./projectbox/token.js";
import { fenceRequest, fenceUpgrade } from "./projectbox/fence.js";
import { instanceTarget, instanceTargets } from "./projectbox/network-targets.js";
import { agentScanRoots, foreignProfileLock, setBrowserChatInstance } from "./projectbox/browser-network.js";
// The seam of the services in the project container (services.js is a leaf).
import { setSupersededSource, setServicesSeam, startDesiredServices, stopService } from "./services.js";
import { servicesSeam, nativeServicesStatus } from "./projectbox/services.js";
import { setBackendAccess } from "./runs/backend-access.js";
import { graphChatClosed, graphApprovalRequestHook, graphApprovalRulingHook, graphRunSeen, graphRowChanged, letExpire } from "./workflows/graph-background.js";
import { setExpiredConsumer } from "./workflows/graph-message.js";
import { ultracodePreamble } from "./dynworkflows/reminder.js";
import { wakeGateWaitingIfFree } from "./dynworkflows/gate-wakeup.js";
import { storageCandidates as dynWorkflowStorageCandidates } from "./dynworkflows/cap.js";
import { wakeOuterLoopAtGate } from "./outerloop/run.js";
import { scheduleTriggerDrain, startTriggerPoller } from "./workflows/triggers.js";
import { workflowRunRoutes } from "./workflows/routes.js";
import { workspaceListRoutes, workspaceRoutes } from "./workspaces/routes.js";
import { writeGitAskpass } from "./workspaces/git-auth.js";
export { headerBundle } from "./runs/queue.js";
// The orderly process end (hook "serverEnd" with a cap, then close, then exit) — callers server/backend/headless.js and the test
// entry server/backend/test/agent-server-child.mjs.
export { endServer } from "./runs/server-end.js";
import { trackUpgradeSocket } from "./runs/server-end.js";


// The hook registry's registration list (in startServer, behind setStartGate) runs once per process — see the comment there.

// ── Server ───────────────────────────────────────────────────────────────────
// Delay of the restart grace (interrupted runs, queue). 2.5 s in operation. A test that checks the "interrupted" state (active_runs
// row without a run) switches it off via CBASE_RESTART_GRACE_MS — otherwise it depends on the clock: under load the timer fires
// later, picks the row up and starts a run.
function restartGraceMs() {
  const raw = process.env.CBASE_RESTART_GRACE_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : 2500;
}
// Test seam: how often the restart-grace timer ran to its END in this process (both steps, even if one threw). Bookkeeping only:
// "nothing starts after the restart" is an absence and needs a restart grace that really ran — a slept duration does not say under
// load whether the timer has fired.
let restartGraces = 0;
export const restartGraceCycles = () => restartGraces;
// The acceptor of the worktree follow-up at `atReady` — one per process (see startServer).
let gitPostWorkUnregister = null;
// The acceptor "continue relocation after the switchover" at `atReady` — one per process.
let relocationReadyUnregister = null;
// The acceptor "continue setup" at `atReady` — one per process.
let setupReadyUnregister = null;
// The acceptor "layout: check quiet or continue the procedure" at `atReady` — one per process.
let layoutReadyUnregister = null;
// The acceptor "clean up old VS Code server versions" at `atReady` — one per process.
let vscodeServerReadyUnregister = null;

export function startServer({ port, dataRoot, webDir, pickDirectory, notify }) {
  setBaseUrl(`http://${HOST}:${port}`);
  // One value per startServer: the harness restarts in the SAME Node process (agent-harness.mjs restart), a module constant would
  // take the previous run's row for its own.
  setBootId(randomUUID());
  setPickDirectoryFn(pickDirectory || null);
  const dataDir = path.join(dataRoot, "data");
  setDirs({
    data: dataDir,
    scratch: path.join(dataDir, "scratch"),
    attachments: path.join(dataDir, "attachments"),
    // The output location per chat (runs/outputs.js): output files of subagents and scripts of dynamic workflows — durable and
    // readable for every run of the chat, unlike the scratch area.
    outputs: path.join(dataDir, "outputs"),
    // Files that go through a channel: stored ONCE per message, copied into the recipient's attachments on delivery.
    channelFiles: path.join(dataDir, "channel-files"),
    artifacts: path.join(dataDir, "artifacts"),
    profilesDir: path.join(dataRoot, "profiles"),
    ttsCache: path.join(dataDir, "tts-cache"),
    // A deliberately EMPTY directory as the working directory for derived tasks with foreign text. Without `cwd` a child process
    // inherits the server's — in the container that is `/home/agent`, where the database (with the GitLab tokens) and `~/.claude`
    // live. Together with the no-tools switch this is the second, independent half: if the switch is ever dropped or a provider
    // cannot honor it (Codex always brings its `shell`), there is still nothing to find here.
    empty: path.join(dataDir, "empty"),
  });
  for (const d of [DIRS.data, ...flatRuntimeFolder(), DIRS.artifacts, DIRS.ttsCache, DIRS.empty]) fs.mkdirSync(d, { recursive: true });
  // Preload the embedding model (dedup check) in the background — best effort, does not block the start.
  warmupEmbeddings();
  // Catch up vectors for existing knowledge (idempotent, in the background) — the FTS index itself is built in initStore.
  warmContextIndex();
  writeGitAskpass(DIRS.data);
  // The list for cbase-git counts as incomplete until the instances are read for the first time — the wrapper refuses every call
  // until then instead of deciding on an earlier start's list. Only with the ops marker; never throws.
  gitProjectsIncomplete();
  store.initStore(DIRS.data);
  // The queue from the DB: BEFORE the first access of any path — the stream delivers it in the `connected` event, the delivery
  // paths queue behind it. Starting from it only after resumeInterruptedWork (runInputsRestartGrace, see there).
  loadRunInputs();
  artifactStore.initArtifacts(DIRS.artifacts);
  initCaptures({ attachmentsOf: (chatId) => attachmentLocation(chatId) }); // at the chat's location (runs/runtime-location.js)
  setUiLang(store.getSetting("ui_lang"));
  setUiZone(store.getSetting("ui_zone")); // the human's time zone for server texts (i18n.js clockText)
  migrateFileSkillsToDb();
  // Tool list of a definition 1:1: existing definitions ONCE get what the Claude path silently gave them until now — before every
  // run.
  migrateToolLists();
  // `cbase_project_create` is gone — stored lists lose the name ONCE, otherwise the definition would no longer be savable. After
  // the migration above (whose existing rows then carry their JSON list).
  dropRemovedTools();
  // Coding MCP airlock: a subagent inherits coding servers only via "inherit subagents" — they drop ONCE from the stored tool lists
  // (managing names stay).
  dropCodingServer();
  // Agent communication: the seven old tool names in agent definitions and stored channel prompts move onto the tool pair — at
  // EVERY start, idempotent, before every run.
  migrateCommunicationCoding();
  // The OpenRouter catalog: at once from the file, renewed in the background when older than 6 h or missing — the start does not
  // wait for it (only the migration below, and only when needed).
  startCatalog({ file: path.join(DIRS.data, "openrouter-catalog.json") });
  // Only three providers: the storage migrates ONCE (account/provider-migration.js). If it need not wait for the catalog, it runs
  // through synchronously here — otherwise the `listen` below waits for it (10 s at most), and no run starts before `listen`. The
  // migrations built on it run as `afterwards` ALWAYS behind it:
  //   · retired models: stored references move ONCE onto the successor, the chats at every start — before the level migrations;
  //   · "Auto" is gone: chats without a level get ONCE the level they run with today — the clamp asks the providers' catalogs, so
  //     only once every chat carries one of the three; before every run and every tick. The follow-up migration of manager agents,
  //     pipeline and steward only sets its marker now (the manager kind is read-only).
  const providerMigration = migrateProviderAtStart({
    afterwards: () => {
      try { migrateRetiredModels(); } catch (e) { console.error("[providers] migration of retired models failed:", e?.message || e); }
      migrateRoleLevelsLater();
      migrateAutoChats();
    },
  });
  // The binding chat → copy moves from the copy (`stack_copies.chat_id`) to the chat (`chats.instance`) — ONCE per store (marker
  // `migration.copies_free`), before every run and every restart grace: whoever works in their copy today keeps working there
  // afterwards; every old row with a chat gets `inset` (move-in and wake-up call as before).
  try { migrateCopiesFree(); } catch (e) { console.error("[stacks] copies_free migration failed:", e?.message || e); }
  // The summarizer per workspace: the start migration for existing ones and a safety net for any that lacks one (a failed seed at
  // creation) — idempotent; new workspaces are seeded by POST /api/workspaces.
  try { seedMissingSummarizer(); } catch (e) { console.error("[outer-loop] summarizer seeding failed:", e?.message || e); }
  // The agenda keeper per workspace: the same pattern, right after.
  try { seedMissingAgendaKeeper(); } catch (e) { console.error("[outer-loop] agenda keeper seeding failed:", e?.message || e); }
  // The timeline agent: every existing workspace gets it at start too.
  try { seedMissingTimelineAgents(); } catch (e) { console.error("[outer-loop] timeline agents seeding failed:", e?.message || e); }
  // The persona of the profile files becomes ONE section of the instructions — before the first run, otherwise an early turn would
  // carry no persona.
  try { migrateProfilesIntoInstructions(DIRS.profilesDir); } catch (e) { console.error("[instructions] migration of the profiles failed:", e?.message || e); }
  // The oneshots' start gate: runOnce asks here before every connector. Installed after the store (the verdict reads settings and
  // the usage cache) and before the first tick — scheduled jobs would otherwise run past the gate.
  // In front of it the per-project lock (runs/project-lock.js): it answers for oneshots and subagents of a locked project
  // (relocation: reject; start/recreate/server end: the subagent waits or is rejected with a reason, see projectbox/idle.js) —
  // otherwise null, and the credit verdict decides as before.
  // A oneshot WITH an instance (service detection in the project container) passes `{ projectId, instance }` through
  // (providers/index.js runOnce) — projectStartGate then judges its project, even without a chat.
  setStartGate((o) => projectStartGate(o) || gateVerdictHook(o));
  // The domain side (setup, later upload) triggers detection through projectbox/detection.js — a setter, because projectbox/ never
  // imports projects/ (cycle guard).
  setServicesDetection((pid, o) => { const p = store.getProject(pid); if (p) runServicesScan(p, o); });
  // The lock on the turn (doRun, composer, wait row) asks the same domain side — a setter like the others, runs/ does not import
  // projectbox/. A transition of an instance to `ready`/`error` wakes what waits.
  setProjectLock(projectLock);
  // When a main becomes `ready` that a copy waits for, it also wakes the queue (stacks/queue.js) — likewise a copy serving as
  // template for a waiting copy. It also catches up the traces of deleted chats that the root fallback could not remove while the
  // container stood (runs/runtime-location.js catchUpLanes).
  setStateWakeup((pid, z) => {
    wakeProject(pid, z);
    wakeMainReady(pid, z);
    if (z?.state === "ready" && (z.instance || "main") === "main") catchUpLanes(pid, { rootFallback: removeAsRoot });
  });
  // BEFORE listening, every relocated instance in ready/error/start goes to `start` — the restart grace (restoration) fires
  // restartGrace ms after listen, and until then a message via inProject would go to a stopped container. The lock holds it; the
  // transition to `ready` wakes it. Without the ops marker nothing. Guard: projectbox-restore.test.js.
  earmarkRestore();
  // Recreate hooks into restoration (request on a memory cap and a missing container; in the restart grace the continuation of an
  // orphaned recreate and the check after every restoration) and into the turn (check at the start, attempt at the end). Setters,
  // not hooks: a new acceptor at "end" or "restartGrace" would write a line into every golden recording.
  setRecreateRequest(recreateRequest);
  setRecreateRestartGrace(recreateRestartGraceSeam);
  // After a successful recreate an open setup continues (a restart in the middle of the `container` step ends in `error`, the
  // recreate brings the row to `ready`); the connector calls fn({ projectId, instance }). Then the layout job too — a waiting one
  // checks its quiet, an open procedure drives.
  setRecreateFinished(({ projectId }) => { try { resumeSetup(projectId); } finally { layoutAtReady(projectId); } });
  // The end of a turn also wakes the queued copies (stacks/remove.js) — after the recreate attempt, in the same observer
  // (runs/instance.js knows ONE).
  setTurnObserver({
    beginning: recreateTurnObserver.beginning,
    // a waiting layout job of the project re-checks its quiet
    end: (a) => { try { recreateTurnObserver.end(a); } finally { try { copiesRemoveTurnEnd(a); } finally { layoutAfterChat(a?.chatId); } } },
  });
  // A turn or agent of a relocated project whose instance has been in `error` for longer than the look-again tick triggers ONE new
  // restoration attempt at the lock and waits as with `start` (projectbox/idle.js, recreate.js recreateErrorAttempt). Without the
  // ops marker nothing.
  setErrorAttempt(recreateErrorAttempt);
  // A turn, agent or workflow agent in a STOPPED instance starts it at the lock (through the storage gate), writes a divider into
  // its chat and waits until it is `ready` (projectbox/instance-stop.js).
  setStoppedStart(nudgeStopped);
  // If an occupancy rejects this start, the end of the occupancy catches it up (idle.js afterOccupancy).
  setOccupancyEnd((pid) => afterOccupancy(pid));
  // `<data>/copies-backup` belongs to "never mounted" of every setup (projectbox/instance.js context — unset it creates nothing).
  setNeverMountedAddition(neverMountedCopies);
  // The run state for runtime/sse.js: the same pattern — a setter at boot instead of an import of runs/ into runtime/. The first
  // three questions are the three reads: `running.has(id)`, `Boolean(openAskOf(id))` (asked only behind "running" — openAskOf reads
  // the whole history) and `[...running]` for the initial state. The fourth: the open dynamic workflows with a chat
  // (`dynWorkflowsOpen`, the same source as the background query) as `{ chatId, runId }` — a run without a chat has no row in the
  // list.
  setRunState({
    isRunning: (id) => running.has(id), question: (id) => Boolean(openAskOf(id)), running: () => [...running],
    workflows: () => (dynWorkflowsOpen() || []).filter((z) => z.chatId).map(({ chatId, runId }) => ({ chatId, runId })),
  });
  // The trigger wake-up for workflows/run-state.js (a setter instead of an import: a direct import closed an import cycle): a
  // finished run has released its lock, so look at once whether an event waited for it. Unset, the wake-up silently does nothing
  // (and the tick does not run either) — gitlab-trigger.test.js "the wake-up starts the event that waited for the lock" pins it.
  // The same wake-up also wakes the wait queue of the graph starts (workflows/graph-start.js): a start announced with /workflow:
  // that waits on a busy lock begins as soon as the holder ends. It is one pass of the shared arbiter (graph starts and stack
  // copies, workflows/storage-queue.js).
  setTriggerWakeup(() => { scheduleTriggerDrain(); wakeStorageQueue(); });
  // The two sources of the arbiter (at most ONE start per pass from storage waiting, the oldest first) and the occasions that wake
  // it batched on the next microtick: the end of a build or teardown of a copy (stacks/queue.js) and every release of the heavy
  // load (end of a relocation or volume clone, projectbox/heavyLoad.js). Setters, not hooks (workflows/ and projectbox/ never
  // import stacks/). Without a copy row the "copies" source is empty; without the procedure connector (stacks/queue.js
  // setCopyProcedure) it starts nothing.
  setStorageQueueSource("graph", graphCandidates);
  setStorageQueueSource("copies", copyCandidates);
  // Service detection in the project container waits for storage like graph starts and copies; its other waiters (cap, project
  // lock) the same pass tries as a fallback (projects/scans.js).
  setStorageQueueSource("detection", detectionCandidates);
  // Source "setup": setups waiting for storage (clone), `alt` = since when. The waiting detections stay the source "detection"
  // above: the queue orders ACROSS all sources by `alt` (workflows/storage-queue.js), so two sources are one queue. The gate is the
  // same as the graph starts'.
  setStorageQueueSource("setup", setupStorageCandidates);
  // The start of a stopped instance waiting for storage (phase `waiting_storage`, in the database — survives a restart of B) is
  // another source of the same queue (projectbox/instance-stop.js).
  setStorageQueueSource("instance-start", instanceStartCandidates);
  // The storage gate of dynamic workflows: an agent() waiting for storage is another candidate of the same queue
  // (dynworkflows/cap.js) — "one per pass" holds across graph starts, copies and workflow agents together.
  setStorageQueueSource("dyn-workflows", dynWorkflowStorageCandidates);
  setSetupSaveGate(() => storageSituation().free);
  // What was not created when unpacking a ZIP without the source failing (a link out of the project, a dead `.git` file) — into the
  // bell, with the project.
  setSetupHint(({ projectId, title, text }) => {
    const p = store.getProject(projectId);
    recordNotice({ kind: "info", title: title, body: text, projectId: String(projectId), projectName: p?.name || null, workspaceId: p?.workspaceId || null });
  });
  // `detection` per project (`{ status, since }` from `serviceScans`) — read by the setup field (workspace list, overview,
  // /api/projects); a setter because projectbox/ never imports projects/ (cycle guard).
  setDetectionReader((pid) => { const k = serviceScans.get(String(pid)); return k ? { status: k.status, since: k.startedAt ?? null } : null; });
  // The state of the layout job for upload and pieces (projectbox/setup/status.js) — `waiting` · `running` · `error` (after the
  // switchover) · null. Plus the observers that re-check the quiet of a waiting job (upload reported, background work empty,
  // terminal closed), the withdrawal of a waiting job before deletion and the access to dynamic workflows (projectbox/ does not
  // import dynworkflows/run.js).
  setLayoutReader(layoutReader);
  setLayoutRowsReader(layoutRow); // the project list's row (`layout`)
  setUploadObserver((pid) => checkBackLayout(pid));
  setWorkEmptyObserver((chatId) => layoutAfterChat(chatId));
  // The editor's language service: its servers end at the lock of a project or instance and at its stop (projectbox/idle.js, where
  // the terminals end with a message), and while a project is locked or relocating none starts (the same situation as for a new
  // terminal, devtools/routes.js). A relocation's plan takes their groups in B out of the process search
  // (projectbox/relocation/collect.js) — the lock ends them afterwards anyway.
  setLanguageServiceEnd((pid, instance, reason) => endLanguageServer(pid, instance, reason));
  setLanguageServiceGroups((pid) => languageServerGroupsInB(pid));
  // No language server starts while the project is locked, relocating, a server step of the setup runs or the layout writes (the
  // same predicates as the code view's write lock, devtools/routes.js).
  setLanguageServiceStartLock((pid, instance) => projectLocked(pid, instance || "main")?.reason
    || (store.openRelocation(pid) || store.projectInstancesOf(pid).some((i) => i.state === "relocation") ? "relocation" : null)
    || (setupRunning(pid) ? "setup" : null) || (layoutWriteLock(pid) ? "layout" : null));
  // The project's formatter before the server's, the choice of the Python interpreter per project (action `interpreter`; the
  // supplier gives `python.pythonPath` at the start of a Python session) and the fields `formatter`, `interpreter` and `format` in
  // the status `features` — lsp/ does not know the domain side, which registers here.
  setFormatter(projectFormatter);
  setInterpreterMachine(interpreterAction);
  setInterpreterSupplier(interpreterFor);
  setStatusAddition(languageServiceStatusAddition);
  setTerminalEndObserver(({ identifier }) => checkBackLayout(typeof identifier === "string" && identifier.includes("/") ? identifier.slice(0, identifier.lastIndexOf("/")) : null));
  setLayoutRevert(revertWaiting);
  setDynWorkflowAccess({ situation: dynWorkflowSituation, stop: (chatId, runId) => stopDynWorkflow(chatId, runId, { from: "human" })?.status === 200 });
  // The execution of a job after the quiet, at `ready` and after "Try again"; plus the superseded containers (`project_superseded`)
  // for the monitor — services.js does not read the store, a service never hits a superseded container (matchContainers
  // `excluded`).
  setLayoutExecution(layoutProcedure);
  setSupersededSource((pid) => store.supersededIds(pid));
  // The end of a build or teardown also wakes the removal jobs ("tear down right after ready").
  setQueueWakeup(() => { storageQueueSoon(); copiesRemoveWake(); });
  // What runs/archive.js (reason "copy" of open work), runs/instance.js (instanceForChat with project comparison; the hint on
  // project switch) and projectbox/erase.js (the copy step of both delete paths) know about copies.
  setCopyWork(copyWorkOf);
  // Archiving ends the chats' wakeups (runs/wakeup.js) silently — nothing runs in the archive. A live monitor is open work and holds
  // the archive (runs/archive.js); closing it here is the safety net if a path ever archives past that check.
  setArchiveObserver((chatIds) => {
    for (const id of chatIds) { closeMonitors(id); closeWakeup(id); }
  });
  // A chat's wakeup delivers its continuation through the ONE wake path — cause "wakeup", silent (no user row). runs/wakeup.js does
  // not import queue.js (cycle guard), hence this connector.
  setWakeupDelivery((chatId, text) => {
    const chat = store.getChat(chatId);
    if (!chat) return { ok: false, error: T("Chat deleted") };
    return deliverUserPrompt(chat, { prompt: text, display: text, cause: "wakeup", silent: true });
  });
  // A persistent monitor started again after a restart (runs/monitors.js) wakes its chat through the same path as in the turn
  // that started it (runs/do-run.js providerMonitorStart): cause "agent", like a completion notice.
  setMonitorDelivery((chatId, text) => {
    const chat = store.getChat(chatId);
    if (!chat) return { ok: false, error: T("Chat deleted") };
    return deliverUserPrompt(chat, { prompt: text, display: text, cause: "agent" });
  });
  setCopySource(copyOfTheChat, { atSwitch: copyAtProjectSwitch, kind: copyKind });
  // The lock and idle per identifier ask the chat's instance (copy, child pin, otherwise main), as does the agent browser scan.
  // Without a copy row both answer "main".
  setInstanceForChat(instanceNameForChat);
  setBrowserChatInstance(instanceNameForChat);
  setCopyDeleteStep(copyDeleteStep);
  // With purge=1 `copies-backup/<pid>` and `copies/<pid>` also go after deleting.
  setCopiesLocations((pid) => { const o = projectCopiesLocation({ data: DIRS.data, projectId: pid }); return [o.backup, o.copies]; });
  setHeavyLoadWakeup(() => storageQueueSoon());
  // The build (freeze, create, prepare, start — stacks/build.js) and the teardown of a half-built copy (stacks/dismantling.js:
  // restart grace and a procedure without an end state). Setters, not hooks: without a copy row nobody calls them; without the ops
  // marker the build ends in `error`, without docker.
  setCopyProcedure(copyBuild);
  setCopyDismantling(dismantleCopy);
  // A copy's repos for the git view and a copy chat's worktree (git.js projectRepos) are those of the snapshot the build wrote
  // (`repos[]`) — git.js does not import stacks/. Unreadable throws.
  setCopyRepoSource((inst) => readSnapshot(copyLocation({ data: DIRS.data, projectId: inst.projectId, name: copyNameOf(inst.instance) })).repos
    .map((r) => ({ rel: r.rel, projectRepo: r.projectRepo === true })));
  // The two connectors without a turn for runs/agents.js: the same pattern — agents.js must not import do-run.js. `openCore`: a
  // core without a turn in which the restart grace takes up a parked subagent; `catchUp`: the deferred verdict at work end when
  // background work becomes empty without a turn. Unset, a parked one is reported orphaned and a verdict never caught up —
  // agent-work-end.test.js pins it.
  setWithoutTurn({ openCore: coreWithoutTurn, catchUp: catchUpVerdict });
  // The second source of the ONE query for open background work: the running dynamic workflows — the same setter pattern, runs/
  // does not import the domain. As a switch, every query (asked at every turn end) would have changed the hook sequence of every
  // golden run.
  setBackgroundSource(dynWorkflowsOpen);
  // The third source: the graph workflows a chat started in the background — open while they wait or run. Archive (409
  // "graphworkflow") and work end (deferred) see them through it.
  setGraphSource(graphRunsOpen);
  // While a question or approval card is open in the chat, a queued entry of another agent (cause "message", "channel") enters
  // neither at the `result` nor as a follow-up run — the same setter pattern (channels/delivery.js channelInputHolds).
  setInputHolds(channelInputHolds);
  // The two observers: every change of a run (workflows/run-state.js emitWorkflowRun) and every change of a graph-start row
  // (workflows/graph-start.js) reach workflows/graph-background.js — the orchestrator's card stays current, a wait brings a silent
  // hint, bell and push, at the end of a background run the completion notice comes. Setters, not a hook kind: a hook kind would
  // appear in every hook sequence of the golden. Unset, the orchestrator stays without a report — graph-report.test.js pins it.
  setGraphRunObserver(graphRunSeen);
  setGraphRowsObserver(graphRowChanged);
  // An entry "message" that comes from a child chat's queue after the end of a background run expires like everything at the end
  // (note to the sender) — a setter because the channel path there goes through channels/ (a cycle with channels/delivery.js in
  // graph-message.js).
  setExpiredConsumer(letExpire);
  // The preamble of a user turn: ultracode reminders and the guide to writing workflows, into the user message (never into the
  // system prompt). Unset, no turn carries anything — dynworkflows-reminder.test.js pins it.
  setTurnPreamble(ultracodePreamble);
  // The plain text of the cadence in the system prompt of a job chat (runs/ does not import scheduled/).
  setScheduledCadenceText(cadencePlainText);
  // The turn completion: a graph workflow noted in the turn begins after its clean end, and the work end of this turn is dropped.
  // Unset, no noted workflow starts — graph-start-run.test.js pins it.
  setTurnCompletion(graphTurnCompletion);
  // The project containers: which instance a start has NOW (runs/instance.js — ops marker AND relocated project, otherwise null)
  // and how runtime/in-project.js reaches its container (the docker child, the program for the pty, the folder of the pgid files,
  // the container name). The same pattern: runs/ and runtime/ do not import projectbox/. Without an instance row nobody asks the
  // seam and every start stays `spawn` — inProject.test.js pins it, the golden proof the byte equality.
  setInstanceSource(runInstance);
  setCodexHomeSource(projectCodexHomes, projectCodexDir); // the rollout readers (codexSessionRoots) also see the projects' Codex homes; plus the home of ONE project (prefix proof)
  // Address and token of an instance for the MCP configuration of its runs (runs/backend-access.js; without an instance nobody
  // asks, and writeMcpConfig writes byte-identical to today).
  setBackendAccess(mcpAccessFor);
  setInProjectSeam({
    kind: dockerKind,
    program: dockerProgram,
    processLocation: (inst) => locationFor({ projectId: inst.projectId, converted: true }).processes,
    container: containerOf,
    // the pause barrier — a start into a frozen container waits for the thaw (cap with a message)
    frozen: isFrozen,
    childAfterThaw: dockerChildAfterThaw,
  });
  // The list of relocated projects for the `cbase-git` wrapper that VS Code in B gets as git.path (projectbox/git-assignment.js).
  // Anew at every start; afterwards by every path that sets `converted_at` or removes a relocated row. Only with the ops marker;
  // never throws, starts nothing. The list's lock rows (and the assignment's lock) need the copies' backup folder — the same
  // function as "never mounted" above (stacks/location.js; projectbox/ never imports stacks/).
  setGitLocksAddition(neverMountedCopies);
  writeGitProjects();
  // Afterwards after EVERY change of `converted_at` — the observer sits in the data layer (store/project-instances.js, all three
  // write paths), not at the individual paths (relocation, delete, …).
  store.setConvertedObserver(writeGitProjects);
  // Preview links: every delete path of the data layer (instance, project, workspace, service) reports SYNCHRONOUSLY what dropped —
  // a public ngrok listener on the IP of a removed instance closes before the IP can be reassigned (projectbox/creation.js
  // chooseSubnet). A setter, no import (store/ is domain-free); the tick is only the fallback net.
  store.setTargetRemovedObserver(targetRemoved);
  // Every `hint` row written outside the chat's own turn stream (subagent at the limit, dynamic workflow, graph background,
  // migrations, instance switch …) goes as `{ type: "row", row }` to the open streams of its chat. The observer sits in the data
  // layer (store/chats.js addMessage), not at the write sites; a client appends the row if `row.id` is above its state
  // (chat/chatBubbles.ts).
  store.setRowsObserver((chatId, row) => sse(chatId, { type: "row", row }));
  // The key with which cbase-project in B fetches the workspace's stored git access (POST /api/workspaces/:wid/git-access) — new
  // per start, 0600 under <data>. Only with the ops marker; never throws.
  createGitAccessKey();
  // ── Registration list of the hook registry (runs/hooks.js) ──
  // The same pattern as setStartGate above: the domain side registers HERE, `runs/` only asks — no module registers itself on load,
  // no priority numbers. The order of registration IS the order of the call. Kind and run-kind names stand as string literals
  // because the guard (tree-rules.mjs) holds them statically against the calls in `runs/`.
  // Run kinds: none registered any more (the mechanism — registerRunKind, runKindFor — stays): one provider per special run kind
  // `(chat, { cause }) → preparation` with its predicate `detects(chat)`; doRun asks `runKindFor(chat)` and takes the FIRST that
  // applies, so the order of registration is the precedence.
  // Hook kinds (time, order and `wait` measured; all acceptors `wait: false` because no site was awaited — a `wait: true` would
  // push a microtask into the order):
  //   afterExit           behind runChat, BEFORE evaluation, at EVERY exit code (no acceptor).
  //   afterRun            only code 0 without abort: curate → auto-title → workflow gate. The TARGET gate is no hook — it runs
  //   inside runs/ as a closure in the finally BEHIND "end" and behind compaction (do-run.js goalGateAfterRun).
  //   afterRunFailed      abort (code 0, aborted) or exit ≠ 0 (not parked): the workflow step fails.
  //   beforeRunBroadcast  in the finally BEFORE the broadcast, every outcome: scheduled end (the list should see the final state),
  //   then "git-view" (the git overview's reads drop), then "captures-show" (agents' captures as cards in the chat).
  //   end                 in the finally AFTER the broadcast, only without a follow-up run and without a running/waiting workflow:
  //   channel delivery, the outer loop and the scheduled end of an occurrence that ended with open background work; plus resume.js
  //   (abandoned resumption).
  //   turnEnd             in place of "end" while background work is open.
  //   afterLimitCancel    auto-continue.js cancelAutoContinue: scheduled end → workflow end (order measured).
  //   afterCompactResume  auto-continue.js, caught-up compaction: the workflow continues.
  //   beforeDeliver       queue.js deliverUserPrompt, BEFORE queueing: channel counter (only `cause === "user"`).
  //   beforePermission    permissions.js requestPermission, after pendingPermissions.set and BEFORE the card/SSE: a graph run's
  //   wait and a scheduled turn's note.
  //   afterPermission     permissions.js resolvePermission/clearChatPermissions, BEFORE p.resolve: report the decision.
  //   restartGrace        resume.js, before filtering the runs: report orphans, deliver channels after the restart, continue
  //   interrupted dynamic workflows (without a turn), set project instances without a procedure to `error`, write the instances'
  //   names into /etc/hosts; FIRST the restoration of the project containers.
  //   restartGraceWorkflows   resume.js, after the early exit: re-pull locks → drive interrupted runs (two acceptors, the order is
  //   that of the two blocks).
  //   restartGraceAbandoned   resume.js, abandoned run BEFORE the broadcast: close the workflow run, also end a scheduled job's
  //   run.
  // Auto-title (runs/post-run.js) is a hook out of runs/ — the title stands in the order BETWEEN two domain acceptors.
  // Switches (registerSwitch: responders WITH a result, synchronous, the first answer ≠ undefined counts):
  //   followUpRun         auto-continue.js: if a workflow waits, the queued message is its answer (true), otherwise runs/ starts
  //   the turn itself.
  //   verdict             auto-continue.js resumeJudge: parked workflow verdicts (workflow/gate/cap/review) — answer false
  //   (discarded) or a Promise (taken over, runs/ awaits it); `goal` stays in runs/.
  //   hold                do-run.js at the preparation: does an open graph workflow hold the turn although the run kind does not?
  //   (true = hold; nobody responsible ⇒ the run kind applies.)
  // The list runs while the registry is EMPTY — once per process, not per startServer: the registry is process-wide, and a second
  // registration of the same run kind throws (runs/hooks.js — two providers would mean one wins silently). In operation the server
  // starts once; the test harnesses (agent-harness.mjs, channel …) restart it per test in the same process and would get the throw
  // instead of a server without this guard. The guard reads the REGISTRY (registerEmpty), no mark of its own: a mark could diverge
  // from the registry (after a hooks reset in a test it would stay set, and a context chat would silently run as an ordinary one).
  if (registerEmpty()) {
    // No run kinds are registered any more — the mechanism stays.
    // Hooks (time, order and `wait` from the measurement, see above):
    registerHook("afterRun", curateHook, { name: "curate" });
    registerHook("afterRun", autoTitleHook, { name: "auto-title" });
    registerHook("afterRun", workflowGateHook, { name: "workflow-gate" });
    registerHook("afterRunFailed", workflowFailedHook, { name: "workflow-failed" });
    // The end of a scheduled job's run (scheduled/run.js); responsible only for cause "schedule" in a job chat.
    registerHook("beforeRunBroadcast", scheduledEndHook, { name: "scheduled-end" });
    // At the end of EVERY turn the server drops its project's cached reads (gitView/cache.js). On "beforeRunBroadcast" rather than
    // "end"/"turnEnd": those do not fire before a queued follow-up turn, this kind fires in the finally at every outcome.
    // Registered after "scheduled-end": its place stays.
    registerHook("beforeRunBroadcast", gitViewTurnEnd, { name: "git-view" });
    // Captures at turn end: what the chat's agents recorded with cbase_screenshot or cbase_recording_* stands as a card behind the
    // turn's last answer (chats/captures-show.js). On this kind because it fires at EVERY outcome, also before a queued follow-up
    // turn (like "git-view"); registered behind the two.
    registerHook("beforeRunBroadcast", capturesShowHook, { name: "captures-show" });
    // The real beginning of a scheduled run (do-run.js behind turnBegins) — `startedAt`.
    registerHook("turnStart", scheduledTurnStart, { name: "scheduled" });
    // Outer-loop agents with the switch "Cancel on new message": a turn in the observed chat cancels their open runs on this cha
    // (outerloop/abort.js).
    registerHook("turnStart", outerLoopTurnStart, { name: "outer-loop-turn" });
    // Channel delivery to the chat is its own acceptor "channel-delivery" (channels/delivery.js channelDeliveryHook).
    registerHook("end", channelDeliveryHook, { name: "channel-delivery" });
    // While background work is open, in place of "end": only the channel delivery to the chat; channel hooks and "child run done"
    // wait for "end".
    registerHook("turnEnd", channelDeliveryHook, { name: "channel-delivery" });
    // The outer loop listens at BOTH places of the work end — "after every run end" (with self-wake lock) and the quiet clocks;
    // synchronous, the run starts on the side (outerloop/trigger.js).
    registerHook("end", outerLoopEndHook, { name: "outer-loop" });
    registerHook("end", scheduledWorkEnd, { name: "scheduled" });                   // an occurrence that delegated closes at work end
    registerHook("turnEnd", outerLoopEndHook, { name: "outer-loop" });
    registerHook("afterLimitCancel", scheduledDismissedHook, { name: "scheduled-end" });    // the parked continuation of an occurrence
    registerHook("inputDismissed", scheduledInputDismissed, { name: "scheduled" });       // queue.js cancelRunInpu
    registerHook("afterLimitCancel", workflowDismissedHook, { name: "workflow-end" });
    registerHook("afterCompactResume", workflowContinueHook, { name: "workflow-continue" });
    // Switches:
    registerSwitch("followUpRun", followUpRunSwitch, { name: "workflow-response" });
    registerSwitch("verdict", verdictSwitch, { name: "workflow" });
    // Hooks on the approval, delivery and recovery side:
    registerHook("beforeDeliver", channelHumanHook, { name: "channel-human" });
    // An approval in the child chat of a background run is a wait for the human — the orchestrator's card says "waiting", hint and
    // notification; the decision ends the wait.
    registerHook("beforePermission", graphApprovalRequestHook, { name: "graph-workflow" });
    registerHook("afterPermission", approvalRulingHook, { name: "approval-ruling" });
    registerHook("beforePermission", scheduledApprovalRequest, { name: "scheduled-approval" });       // coding card in a scheduled turn → note
    registerHook("afterPermission", scheduledApprovalRuling, { name: "scheduled-approval" });      // its note is done
    registerHook("afterPermission", graphApprovalRulingHook, { name: "graph-workflow" });
    // Restart-grace order — the first hooks are deliberately first:
    //   · layout job (SYNCHRONOUS, FIRST, before any path that lets turns start again): the "layout" lock of open jobs. `running`
    //     before the switchover gets `backwards = 1` and keeps the lock; it is driven at `ready` (layoutAtReady).
    //   · thaw: every container with label `cbase.project` in state `paused` is thawed (only cbase pauses on level 2; after a
    //     restart of B nobody holds a pause). Asynchronous and without rows — restoration then enters its procedures synchronously
    //     and thaws what it finds paused instead of starting it. Without the ops marker nothing.
    //   · restoration — BEFORE "agent-orphaned", "channel-restart-grace" (starts turns) and "dyn-workflows" (starts workflow
    //     agents): its first action is synchronous — every relocated instance in `ready`/`error` becomes `start` — the lock then
    //     holds every turn and workflow agent of its project until it is `ready`; the rest is asynchronous. The rows already stand
    //     on `start` since the start (earmarkRestore) — the hook takes them and enters their procedure synchronously. It MUST stand
    //     before "project-instances": that sets a working row WITHOUT a living procedure to `error`, and every earmarked row would
    //     be one. Without the ops marker nothing. Guard: projectbox-restore.test.js.
    registerHook("restartGrace", layoutRestartGrace, { name: "project-layout" });
    registerHook("restartGrace", thawRestartGrace, { name: "project-thaw" });
    registerHook("restartGrace", restoreRestartGrace, { name: "project-restore" });
    // Preview links: every active link is reopened on its target (`names` on the same name, without a new reservation), then the
    // expiry tick. AFTER "project-restore": its first action (instances to `start`) is synchronous, the target IPs stand in the
    // rows. In the background — returns nothing (holds neither start nor quiet); without a link and without access only the tick.
    registerHook("restartGrace", previewRestartGrace, { name: "preview-links" });
    // Subagents still running at the end of the last server run are reported orphaned (silent hint, no turn) — BEFORE channel
    // delivery, so a turn it starts carries it. Late booking after a crash (runs/lateBooking.js) is NOT a restart-grace hook: i
    // runs synchronously before `listen` (below) — the restart grace comes only 2.5 s after `listen`, and a turn starting in those
    // 2.5 s would reset `started_at` and stand in `running`: the crashed turn's consumption was lost.
    registerHook("restartGrace", reportOrphaned, { name: "agent-orphaned" });
    // Monitors of the last server run: they died with it — a persistent one starts again (same id, same log), every other gets ONE
    // note to its chat (runs/monitors.js).
    registerHook("restartGrace", monitorsRestartGrace, { name: "monitors-restart-grace" });
    // Wakeups of the last server run: loaded before `listen` (loadWakeup, below), here the clocks are set and overdue ones
    // delivered — AFTER the orphans (their silent hint belongs in the turn a wakeup starts).
    registerHook("restartGrace", wakeupRestartGrace, { name: "wakeup-restart-grace" });
    registerHook("restartGrace", channelRestartGraceHook, { name: "channel-restart-grace" });
    // Catch-up of the chats' full-text index (communication/search.js) — in the background in batches, returns nothing (holds
    // neither start nor quiet), without stock a no-op.
    registerHook("restartGrace", chatSearchRestartGraceHook, { name: "chat-search" });
    registerHook("restartGraceWorkflows", workflowLocksHook, { name: "workflow-locks" });
    registerHook("restartGraceWorkflows", workflowRunsHook, { name: "workflow-runs" });
    registerHook("restartGraceAbandoned", workflowAbandonedHook, { name: "workflow-abandoned" });
    registerHook("restartGraceAbandoned", scheduledAbandoned, { name: "scheduled" });                  // the occurrence ends in `error`
    // Switch:
    // Switch "hold" (do-run.js, at the preparation, only where the run kind does not hold): an open graph workflow holds the turn
    // until the reports of its background agents are processed in the same turn. Dynamic workflows register BEHIND it — so this
    // responder without an open run answers `undefined`, not `false`.
    registerSwitch("hold", graphHoldSwitch, { name: "graph-workflow" });
    // The run lives in dynworkflows/ — runs/ and chats/ learn of it only here. Hook "chatClosed" (every delete path:
    // chats/delete.js → runs/agents.js): silently stop its workflows, delete rows. (Running workflows as open work — archive, work
    // end, holding a graph step — come through setBackgroundSource above, no longer through a switch.)
    registerHook("chatClosed", dynWorkflowsChatClosed, { name: "dyn-workflows" });
    // A child chat deleted by hand — its row becomes "stopped" (from "delete"), the orchestrator gets a silent hint, no completion
    // notice.
    registerHook("chatClosed", graphChatClosed, { name: "graph-workflows" });
    // The cores of outer-loop runs on this chat go silent, quiet clocks and follow-up marks are dropped — chats/delete.js cleanUp
    // deletes the rows afterwards; a returning run writes nothing.
    registerHook("chatClosed", outerLoopChatClosed, { name: "outer-loop" });
    // Deleting the chat deletes its scheduled job with its runs (the opposite direction).
    registerHook("chatClosed", scheduledChatClosed, { name: "scheduled" });
    // Hook "chatRestored" (runs/archive.js, per chat leaving the archive): what a channel's archive hold kept back now goes out.
    registerHook("chatRestored", channelRestoredHook, { name: "channel-archive" });
    // After the restart, continue every interrupted run (prefix from the journal, attempt cap) — starts only agents, no turn, and
    // therefore stands harmlessly BEFORE the filter of the chat runs.
    registerHook("restartGrace", dynWorkflowsRestartGrace, { name: "dyn-workflows" });
    // The wakeups of parked outer-loop runs and the quiet clocks anew from the database — starts no turn.
    registerHook("restartGrace", outerLoopRestartGrace, { name: "outer-loop" });
    // Orphaned helper containers (label `cbase.helper` of another server run, projectbox/helper.js) are removed by id — BEFORE
    // "project-instances", whose relocation decider waits for `helperCleanedUp()` before touching a half relocation. Only with the
    // ops marker; starts nothing.
    registerHook("restartGrace", helperRestartGrace, { name: "project-helper" });
    // An instance in `create`, `start` or `recreate` without a living procedure is a leftover of the last server run — it becomes
    // `error` with a reason, `busy` drops (the relocation journal decides `relocation`). Starts nothing, so it stands harmlessly
    // before the filter of the chat runs.
    registerHook("restartGrace", instancesRestartGrace, { name: "project-instances" });
    // SYNCHRONOUS and only in the runtime folder — an archive file without a row (crash between row and file, a delete path tha
    // died between the two) and an archive row whose project is gone. NO DEADLINE: the archive of an open source stays. Only with
    // the ops marker; starts nothing (returns undefined).
    registerHook("restartGrace", archiveRestartGrace, { name: "project-archive" });
    // /etc/hosts is rebuilt at every build of B — after the start the block `<ip> <slug>.cbase` per instance (projectbox/names.js).
    // Only with the ops marker; starts nothing, writes a file.
    registerHook("restartGrace", projectNamesRestartGrace, { name: "project-names" });
    // The airlock baseline at switchover day: every existing server with an open baseline is loaded once (what is seen is existing
    // stock, without an auto mark). AFTER restoration (a project server loads in the container of its main instance), BEFORE the
    // observer (it stays the last acceptor). In the background, returns undefined; without an open baseline a no-op.
    registerHook("restartGrace", mcpBaselineRestartGrace, { name: "mcp-baseline" });
    // Ask Microsoft for the newest VS Code server version, fetch it verified into B's cache and lay it down BEFORE the Mac — the
    // Dev Containers helper in B and `bin/<commit>` in every ready relocated main, plus the version the Mac last worked with
    // (projectbox/vscode-upfront.js). One pass now, then the tick (6 h, CBASE_VSCODE_UPFRONT_MS, 0 = off) — in the background:
    // returns undefined. Only with the ops marker; never fatal. BEFORE the observer below (it stays the last acceptor).
    registerHook("restartGrace", vscodeUpfrontRestartGrace, { name: "vscode-upfront" });
    // The observer (projectbox/resumption.js): `docker events` on the containers with label `cbase.project`; a project or copy
    // container that ends or starts past cbase gets restoration, and a tick pursues the target state. As LAST acceptor of
    // "restartGrace": AFTER restoration (its rows then stand in `start` with a living procedure, the reconciliation leaves them).
    // Only with the ops marker; starts nothing that holds the quiet (returns undefined).
    registerHook("restartGrace", resumptionRestartGrace, { name: "project-resumption" });
    // The open teardown jobs of the worktrees (runs/git-post-work.js — subagents, graph worktrees, delete paths) run in the projec
    // container and are awaited BEFORE the stop chain below stops the containers; what comes after finds a standing container and
    // goes into the follow-up. With its OWN, reported cap (CBASE_GIT_END_MS, default 10 s): the hooks share the 45 s of
    // runs/server-end.js, and a hanging teardown would otherwise hold the snapshot and `docker stop` below.
    // The language service (lsp/sessions.js): every language server ends at once (in B its own process group, in the projec
    // container via the wrapper's group) — before the stop chain, synchronous.
    // The own browsers (chat, workspace, project — browsers.js) end gently with their whole process group, before the stop chain
    // takes the project containers with the instance browsers in them. Awaited: B ends only after them (browser-process.js).
    registerHook("serverEnd", () => closeAllUserBrowsers(), { name: "own-browsers", wait: true });
    registerHook("serverEnd", () => { endAllLanguageServer("serverEnd"); }, { name: "language-service" });
    registerHook("serverEnd", () => openGitJobsUntil(), { name: "git-jobs", wait: true });
    // At process end (runs/server-end.js endServer, fired ONLY there) first the `desired` snapshot per instance, then `docker stop
    // -t 30` of every project container — awaited (`wait: true`) so B ends only after them. Without the ops marker no docker call
    // (the local server ends as before).
    registerHook("serverEnd", projectboxServerEnd, { name: "projectbox", wait: true });
    // The observer ends with the process — AFTER the stop chain (its `die` events carry the mark "cbase stops itself" and drop in
    // serverEnds(); the order git-jobs → projectbox is pinned by projectbox-git-worktree.test.js). Synchronous.
    registerHook("serverEnd", () => { stopResumption("server end"); }, { name: "project-resumption" });
    // Preview links ("server end"): the ngrok session closes, 5 s at most (own cap); rows and reservations stay so the restar
    // grace reopens them on the same name.
    registerHook("serverEnd", previewServerEnd, { name: "preview-links", wait: true });
  }
  // The aborter behind outerloop/abort.js abortOuterLoop: deleting an agent, project or workspace silences the cores of its runs
  // and takes clocks and marks (abortOuterLoop writes the rows).
  setOuterLoopAborter(outerLoopAborter);
  initServices({ dataDir, logFile: serviceLogFile, logAnchor: runtimeFolderOf, projectPath: (id) => store.getProject(id)?.path || "", onEvent: (notice) => broadcast({ type: "notice", notice }), pushGate: pushVerdictForNote });
  // The services of a relocated project start, run, stop and report in the project container — which instance a service has NOW
  // (ops marker AND instance row, otherwise null = the plain path), the `desired.services` snapshot at every start and stop through
  // cbase and the service rows for restoration (startDesiredServices). The same setter pattern as setInstanceSource: services.js
  // does not know the store.
  setServicesSeam(servicesSeam());
  // Restoration starts the native services from `desired.services` through the same path as the route.
  setNativeServicesStarter(startDesiredServices);
  // Which registered native services of the main are RUNNING when a copy freezes — only those the copy starts (never
  // `desired.services`, which keeps a crashed one). stacks/freeze.js asks before the pause.
  setNativeServicesStatus(nativeServicesStatus);
  // Tearing down a copy ends its running native services through the same path as the route.
  setServicesStopper(stopService);
  // If the project container stands while the git view asks, restoration brings it back. The view answers "starting" at once; a
  // throw (OCCUPIED, no instance) is only logged. A frozen main it never starts — restoration rejects it (FROZEN), and a pause does
  // not wake it at all (devtools/code-route.js). The git view of a copy chat wakes the COPY (second argument), never the main in
  // its place. The small view hangs on GET …/git (devtools/code-route.js) — a setter, no edge devtools/ → gitView/
  // (gitView/fetch.js reads devtools/). Without the ops marker it leaves the tree untouched.
  setGitOverview(smallView);
  setGitWakeup((projectId, instance = MAIN) => {
    restoreInstance(projectId, instance, { reason: "git view: container down" })
      .catch((e) => console.error(`[projectbox] git wake-up ${projectId}: ${e?.message || e}`));
  });
  // A worktree whose teardown found a standing project container stands in `<data>/git-post-work/<projectId>.jsonl` — after every
  // transition of the instance to `ready` through restoration (restart grace, git wake-up, recreate) it runs afterwards in the
  // container (checked: a worktree with changes stays). Registered once per process — a second startServer (tests) unregisters the
  // old acceptor.
  gitPostWorkUnregister?.();
  gitPostWorkUnregister = atReady(({ projectId, instance }) => gitPostWork(runInstance(projectId, instance)));
  // A relocation journal without a living procedure decides in the restart grace "project-instances" (before the switchover: way
  // back, from the switchover forward — start, re-check, only then remove); a journal after the switchover whose row restoration
  // brought to `ready` is driven to its end afterwards. Without the ops marker no docker.
  relocationReadyUnregister?.();
  const relocationSeam = relocationRestartGraceSeam();
  setRelocationDecider(relocationSeam.decider);
  relocationReadyUnregister = atReady(relocationSeam.afterReady);
  // An open setup continues as soon as its container is (again) ready — after a restart through restoration. No restart-grace hook
  // (server end stops the containers).
  setupReadyUnregister?.();
  setupReadyUnregister = atReady(({ projectId }) => resumeSetup(projectId));
  // A layout job whose container is (again) ready — a waiting one checks its quiet, an open procedure drives backward or forward.
  layoutReadyUnregister?.();
  layoutReadyUnregister = atReady(({ projectId, instance }) => { if (!instance || instance === MAIN) layoutAtReady(projectId); });
  // `~/.vscode-server` lies per project in the CLI home and survives every recreate — after every transition of the MAIN to `ready`
  // the old versions go (the two newest and every running one stay; projectbox/vscode-server.js). Never for a copy (it does not
  // mount the folder), never fatal (never throws, only warns), without occasion no docker call.
  vscodeServerReadyUnregister?.();
  // THEN (waited for the cleanup of the same `ready`) lay the protected newest version from B's cache down if it is missing there —
  // so a stopped project catches up what the tick fetched (projectbox/vscode-upfront.js; it downloads nothing here, without
  // occasion no docker call, never fatal). EVERY protected version — the newest and the one the Mac used last —, also into a main
  // in which VS Code never was (the script creates `bin`). If it lays something down it cleans up once more itself (same path as in
  // the tick; without occasion no docker).
  vscodeServerReadyUnregister = atReady(({ projectId, instance }) => {
    if (instance && instance !== MAIN) return undefined;
    const cleanUp = cleanUpVscodeServer(projectId);
    return vscodeUpfrontForProject(projectId, { after: runningCleanUp(projectId) ?? cleanUp });
  });
  // Background monitor: checks all known services every 30 s and reports outages/recoveries.
  startMonitor({ intervalMs: 30_000, getTargets: () => store.listMonitoredServices(), notify: notify || null });
  // Streamed browsers: push registry changes to all UI clients (pill "browser active") and scan Playwright profiles for running
  // agent browsers (DevToolsActivePort).
  onBrowsersChanged((list) => broadcast({ type: "browsers", list }));
  // The lock of a browser profile with a FOREIGN hostname: a Chromium in the project container (`cbp-<n>`) writes the pid of its
  // namespace — whether it lives only `docker exec <c> kill -0` knows. Without the ops marker and for any other hostname the seam
  // answers "as today" (projectbox/browser-network.js; browser-profiles.js is a leaf).
  setProfileLockSeam(foreignProfileLock);
  // Throw away long-unused chat browser profiles (~8.5 MB each). Harmless: the logins live in the workspace stock, a chat browsing
  // again clones its profile from there. At EVERY location: flat and in every runtime folder of a project. Asynchronous (a project
  // container's lock asks docker) — the start does not wait for it.
  (async () => {
    for (const location of allLocations()) {
      const root = playwrightProfileRoot(location);
      for (const chatId of await reapUnusedChatProfiles({ root: root })) {
        for (const hl of [true, false]) {
          try { fs.rmSync(playwrightConfigPath(chatProfileDir(root, chatId), hl), { force: true }); } catch {}
        }
      }
    }
  })().catch((e) => console.warn(`[profile] cleaning up old chat profiles failed: ${e?.message || e}`));
  // Browsers a killed backend left behind (SIGKILL, crash — on macOS nothing ends them): every process with the owner marker whose
  // owner is dead (browser-process.js). In the background, never fatal.
  void sweepOrphanedBrowsers();
  // Trigger nodes of armed workflows: polls GitLab and starts runs by itself.
  startTriggerPoller();
  // Load Playwright MCP (pinned version) into the npx cache — runs then start it without a network.
  prewarmPlaywrightMcp();
  // The profile roots anew at EVERY pass: a project being relocated gets its folder at runtime. An instance's root carries its IP
  // and identifier: its browsers run in the project container and are asked there.
  startAgentScan(agentScanRoots, {
    // Name chat profiles ("chat-<id>") with the chat title, subagent profiles ("chat-<id>-agent-<aid>") with the agent's name —
    // both in their chat's workspace (for the scope-dependent pill). devtools/browser-names.js.
    describeProfile: (dir) => { try { return describeProfile(dir); } catch { return null; } },
  });

  // The dispatcher: one table instead of one big handler. Order = former source order, first hit wins; the three owners
  // chatRoutes/workspaceRoutes/projectRoutes carry their sub-table in their file. Measured: all 37 top-level checks are pairwise
  // disjoint — the order is a safety net, not a functional condition.
  const ROUTES = [
    activeRunsGateRoute,
    activeRunsRoute,
    settingsRoutes,
    devtoolRoutes,
    eventStreamRoute,
    channelRoutes,
    chatFolderRoutes,
    chatListRoute,
    scheduleNextRoute, // the scheduled jobs' wake-up (scheduled/routes.js)
    chatCreateRoute,
    chatRoutes,
    accountRoutes,
    workflowRunRoutes,
    codexRoutes,
    workspaceListRoutes,
    workspaceRoutes,
    mcpCatalogRoutes,
    skillHistoryRoutes, // /api/skill-history/:id/revert, /api/skill-requests/:id[/decide]
    previewRoutes, // preview links: /api/preview-links, /api/integrations/ngrok
    projectListRoutes,
    serviceGlobalRoutes,
    projectRoutes,
    servicePortRoutes,
    adjustRoutes,
    autocompactNotifyRoutes,
    serviceEventRoutes,
    vscodeTunnelRoutes,
    portRoutes,
    projectboxOpsRoutes,
    projectCreationRoutes, // GET /api/projectCreation/rules (also without ops)
  ];

  // The outer skin. EVERYTHING inside the try — a throw here is an answer, never a process end:
  //   · `new URL(req.url, …)` must be inside the try: `GET //` (also `///`, `//x:99999`, `/\`, an absolute target with a broken
  //     port) throws, the async handler rejects, and without a listener B would end with exit 1 — with the inner dockerd and all
  //     project containers, triggerable from any project network without a token (the fence came only afterwards). Now 400.
  //   · the origin (runtime/origin.js) BEFORE everything else, also before the static files: locally (without a gateway) a foreign
  //     host name (DNS rebinding), a foreign Origin or Sec-Fetch-Site cross-site ⇒ 403; in server operation only the host name
  //     (browsers in B and rebinding — the gateway passes the public origin through).
  //   · the catcher itself does not throw: if the head is already out (a route threw mid-send) the connection is ended — a second
  //     `writeHead` would throw ERR_HTTP_HEADERS_SENT from the catch, again an unhandled rejection.
  const server = http.createServer(async (req, res) => {
    // The event-loop watch (runtime/loop-watch.js) names the open requests on a blockage.
    const requestId = requestBegin(req.method, String(req.url || "").split("?")[0]);
    res.once("close", () => requestEnd(requestId));
    try {
      const origin = originVerdict(req.headers);
      if (!origin.ok) return send(res, origin.status, { error: origin.reason });
      let url;
      try { url = new URL(req.url, BASE_URL); } catch { return send(res, 400, { error: T`Request target unreadable: ${String(req.url).slice(0, 100)}` }); }
      const p = url.pathname;
      const m = req.method;
      const ctx = { req, res, url, p, m };
      // The API fence: BEFORE everything else, also before the static files and /api/health — from a project network nothing passes
      // without the instance's token. Only with the ops marker (asked synchronously: without it no more await than today); it can
      // replace ctx.req (read body) and filter ctx.res (projectbox/fence.js).
      if (projectboxOps() && !(await fenceRequest(ctx))) return;
      if (!p.startsWith("/api/")) {
        if (m !== "GET") return send(res, 405, { error: "method not allowed" });
        return serveStatic(res, webDir, p === "/" ? "/index.html" : p);
      }

      // The `projectCreation` field — the same calculation as `mode` at GET /api/projectCreation/rules (projectbox/setup/rules.js
      // creationMode). In server operation the gateway answers /api/health itself: clients therefore read the mode at the rules
      // route.
      if (p === "/api/health" && m === "GET") return send(res, 200, { ok: true, projectCreation: creationMode() });
      for (const route of ROUTES) if ((await route(ctx)) !== NEXT) return;

      send(res, 404, { error: "not found" });
    } catch (err) {
      // A status code on the error wins (413 for too large a body, 400 for broken JSON) — otherwise the server reports an internal
      // error for a faulty request. NO `req.destroy()` beside it: `send` ends the response asynchronously, and destroying the
      // socket in the same turn discarded exactly the response to be delivered. The body is instead discarded empty in `readBody`
      // (see there).
      if (res.headersSent) {
        console.error(`[http] ${req.method} ${String(req.url).slice(0, 200)}: error after the head — connection ended: ${err?.message || err}`);
        try { res.destroy(); } catch { /* already closed */ }
        return;
      }
      try { send(res, Number(err?.status) || 500, { error: String((err && err.message) || err) }); }
      catch { try { res.destroy(); } catch { /* already closed */ } }
    }
  });

  // Every upgrade socket is remembered by runs/server-end.js, BEFORE the two upgrade paths — endServer destroys the open ones
  // before `server.close`, otherwise `close` would wait for an open tunnel and the serverEnd acceptors would never run.
  trackUpgradeSocket(server);
  // Port tunnel (WS→TCP) for client port forwarding — answers upgrades on /api/tunnel.
  // Both upgrade paths bypass the dispatcher — the fence therefore stands there too (fenceUpgrade asks the ops marker itself;
  // without it it is "as today"). `instance` chooses the target (projectbox/network-targets.js) — without an instance row there is
  // none, and the tunnel goes to 127.0.0.1 as before (tunnel.js, header).
  // The gate of both upgrade paths: FIRST the origin as in the dispatcher (runtime/origin.js — locally (without a gateway) a
  // foreign origin or host name ⇒ 403, in server operation a foreign host name; a WebSocket knows no same-origin policy, and the
  // DevTools proxy strips the origin afterwards), THEN the fence. Both listeners ask it exactly once per upgrade, before every
  // handshake.
  const upgradeGate = (req) => {
    const origin = originVerdict(req.headers);
    return origin.ok ? fenceUpgrade(req) : origin;
  };
  attachTunnel(server, { fence: upgradeGate, targets: { forIdentifier: instanceTarget, all: instanceTargets } });
  attachBrowserDevtools(server, { fence: upgradeGate });
  // VS Code Remote Tunnel: starts again if it was on last time (only in the container, CBASE_VSCODE_TUNNEL=1). Best effort — the
  // state is measurable via GET /api/vscode-tunnel.
  tunnelAutostart(store).catch((e) => console.error("[vscode-tunnel] Start:", e?.message || e));
  // `git.path` = the cbase-git wrapper also WITHOUT a tunnel — the Dev Containers path starts none. Only with the ops marker (the
  // local server writes no VS Code settings); enterGitPath never throws, an error goes to the console.
  if (projectboxOps()) {
    try {
      const gp = enterGitPath();
      if (gp.error) console.warn(`[vscode] ${gp.error}`);
    } catch (e) { console.warn(`[vscode] git.path not set: ${e?.message || e}`); }
  }
  // Also the marks of the recreate — they belong to the server run (in tests many servers run in one process; a new start re-checks
  // in the restart grace). In the SAME listener: an eleventh "close" listener triggered the MaxListenersExceededWarning at every
  // start (Node warns from the eleventh). Likewise the observer of the project containers (stream, restart, tick) and the
  // OpenRouter catalog tick — they belong to the server run like the ticks.
  // The event-loop watch: only in operation (ops marker) — the file lives on the volume (`<data>/logs/eventLoop.jsonl`) and
  // survives the gateway's replacement of the container. Not in the test bench: dozens of servers run under load in one process
  // there, and a blockage says nothing about operation.
  const watchStop = projectboxOps() ? startLoopWatch({ file: path.join(DIRS.data, "logs", "eventLoop.jsonl") }) : null;
  // The own browsers belong to the server run too (in tests many servers run in one process) — "serverEnd" has already closed them
  // in operation; here the close without endServer (test bench, measuring bench).
  server.on("close", () => { stopTunnel(null); cleanUpRecreate(); copiesRemoveCleanUp(); stopResumption("server closed"); stopVscodeUpfront(); stopCatalog(); watchStop?.(); void closeAllUserBrowsers(); });

  // Listen only after the provider migration (it waits at most 10 s for the catalog and never throws).
  // Before it, synchronously, the late booking after a crash (runs/lateBooking.js): what interrupted main turns and running
  // subagents consumed before the end of the last server run, from their session files. It reads only DB and files and never
  // throws. HERE, not as a restart-grace hook: before `listen` no path starts a turn (no route, no tick — those start in the
  // callback below), and it thus also lies before "agent-orphaned" (that sets the subagents to `orphaned`, afterwards they would
  // stand in no list). As a hook it came 2.5 s AFTER `listen`: a message in that window reset `started_at` of the crashed row, the
  // chat stood in `running`, and the late booking skipped it — forever.
  return providerMigration.then(() => {
    try { lateBookingRestartGrace(); } catch (e) { console.error("[consumption] late booking:", e?.message || e); }
    // Load the wakeups of the last server run into memory (runs/wakeup.js) — BEFORE `listen`: a wakeup set in the first seconds
    // would otherwise write the stock without the rows not yet loaded. The restart grace sets the clocks.
    try { const n = loadWakeup(); if (n) console.log(`[wakeup] ${n} wakeup(s) loaded from the last server run`); } catch (e) { console.error("[wakeup] loading:", e?.message || e); }
  }).then(() => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      console.log(`cbase running: ${BASE_URL}`);
      resolve(server);
      // After the start, continue interrupted runs/scans (briefly delayed so the provider registry, skills migration etc. are fully
      // ready). Best effort — errors here must never topple the server start. This timer too belongs to the SERVER RUN: in the test
      // bench dozens of servers run in a row in the same process and the store is module-wide. The timer of an already closed
      // server, not cleared, ran 2.5 s after its start against the DB of the NEXT one — saw a running workflow whose chat was
      // compacting (in `compacting`, not `running`), took it for interrupted and drove it: a step ran behind an abort that never
      // existed in this server life. In operation it is one server per process.
      const restartGrace = setTimeout(() => {
        try { resumeInterruptedWork(); } catch (e) { console.error("[resume] error:", e?.message || e); }
        // THEN the queue: resumeInterruptedWork has already started the interrupted runs (`running` stands), and their run end
        // takes over their entries itself.
        try { runInputsRestartGrace(); } catch (e) { console.error("[queue] restart grace:", e?.message || e); }
        // THEN the graph starts: if a chat runs again, the end of its turn redeems; a noted row without a turn is redeemed now,
        // then the wait queue. BEFORE: the stack copies — a build without a living procedure is dismantled and returns to the queue
        // with its old place (afterwards it wakes itself); `waiting_*` stays and is handled in the pass at the end of
        // graphStartsRestartGrace — ONE pass of the shared arbiter for both. After the restart-grace hooks (thaw, restore,
        // "project-instances"). Without a copy row a query.
        try { copiesRestartGrace(); } catch (e) { console.error("[stacks] restart grace:", e?.message || e); }
        // A teardown without a procedure continues, every removal job goes back into the timer — after cleaning up the helper
        // orphans —, then the orphaned objects of the copies. Without a copy row a query.
        try { copiesRemoveRestartGrace(); } catch (e) { console.error("[stacks] restart grace (removal):", e?.message || e); }
        // A "ready" wake-up call the server lost before sending is caught up (mark in the copy's journal).
        try { copiesWakeRestartGrace(); } catch (e) { console.error("[stacks] restart grace (wake-up call):", e?.message || e); }
        try { graphStartsRestartGrace(); } catch (e) { console.error("[graph-start] restart grace:", e?.message || e); }
        restartGraces += 1;
      }, restartGraceMs());
      restartGrace.unref?.();
      server.once("close", () => clearTimeout(restartGrace));
      // Waiting continuations at the usage limit: timers alone do not suffice over hours/days (suspend, time jumps) — hence
      // additionally a quiet tick. It belongs to the SERVER RUN like the three ticks below: `unref` alone lets it keep running
      // after server.close, and in a test file with fourteen server lives fourteen sweepers swept over the wait rows of the last
      // one — with runs from a server that never wrote the rows.
      // In the same tick the workflow agents and outer-loop runs at the gate: a newer measurement that shows the gate free (account
      // switch) wakes them before the window's reset — sweepAutoContinues wakes the chats' wait rows itself.
      const sweeper = setInterval(() => {
        try { sweepAutoContinues(); } catch (e) { console.error("[limit] Sweep:", e?.message || e); }
        try { wakeGateWaitingIfFree(); } catch (e) { console.error("[limit] gate wake-up (workflows):", e?.message || e); }
        try { wakeOuterLoopAtGate(); } catch (e) { console.error("[limit] gate wake-up (outer loop):", e?.message || e); }
      }, autoContinueSweepMs());
      sweeper.unref?.();
      server.once("close", () => clearInterval(sweeper));
      // The tick of the graph wait queue — like the sweeper on the server run. It catches locks that free without a run ending
      // (deleted holder chat, orphaned lock); the usual path is the wake-up above. Also the tick of the shared arbiter (graph
      // starts and copies) — for the storage gate the MAIN path.
      const graphTick = setInterval(() => { try { wakeStorageQueue(); } catch (e) { console.error("[storage-queue] tick:", e?.message || e); } }, graphTickMs());
      graphTick.unref?.();
      server.once("close", () => clearInterval(graphTick));
      // The wakeups of parked subagents also belong to the server run: at the end all open agent cores are closed, their agents
      // stopped, every wakeup gone.
      server.once("close", () => { try { agentsAtServerEnd(); } catch (e) { console.error("[agent] server end:", e?.message || e); } });
      // Likewise the clocks of the wakeups (runs/wakeup.js) — the stock stays, the next run sets them anew. ONE acceptor for both
      // (the number of close acceptors is at the edge of the MaxListeners warning).
      server.once("close", () => {
        try { monitorsAtServerEnd(); } catch (e) { console.error("[monitor] server end:", e?.message || e); }
        try { wakeupAtServerEnd(); } catch (e) { console.error("[wakeup] server end:", e?.message || e); }
      });
      // The dynamic workflows also belong to the server run: what an earlier run left as "running" is interrupted (the
      // "restartGrace" hook continues it — until then `busy` would not stand); at the end all runs are interrupted, their agents
      // ended, no sandbox timer remains.
      try { const n = dynWorkflowsAtStart(); if (n) console.log(`[dynworkflow] ${n} run(s) from the last server run interrupted`); } catch (e) { console.error("[dynworkflow] start:", e?.message || e); }
      server.once("close", () => { try { dynWorkflowsAtServerEnd(); } catch (e) { console.error("[dynworkflow] server end:", e?.message || e); } });
      // The outer loop: a run an earlier process left as `running` has no core any more — SYNCHRONOUSLY `aborted` (until the
      // restart grace `busy` would stand on it); `parked` stays, the restart grace sets the wakeup. At the end everything goes
      // silent (cores, clocks, wakeups); the rows stay. The tick (interval, times of day, safety net for parked ones) belongs to
      // the server run like the ticks below.
      try { const n = outerLoopAtStart(); if (n) console.log(`[outer-loop] ${n} run(s) from the last server run aborted`); } catch (e) { console.error("[outer-loop] start:", e?.message || e); }
      server.once("close", () => { try { outerLoopAtServerEnd(); } catch (e) { console.error("[outer-loop] server end:", e?.message || e); } });
      const outerLoopTimer = setInterval(() => { try { outerLoopTick(); } catch (e) { console.error("[outer-loop] tick:", e?.message || e); } }, OUTER_LOOP_TICK_MS());
      outerLoopTimer.unref?.();
      server.once("close", () => clearInterval(outerLoopTimer));
      // The tick of the OpenRouter amounts: ask for missing amounts (generation id) or estimate at the catalog price — every 10
      // min, on the server run like the ticks here (account/openrouter-inquiry.js).
      const amountTickFrom = startAmountTick();
      server.once("close", () => amountTickFrom());
      // The auto-archive tick — the same kind, on the SERVER RUN: a timer of an ended server would otherwise archive chats of the
      // next in a test. Hourly (CBASE_AUTO_ARCHIVE_MS); switched off (default) a pass does nothing. Once immediately only after a
      // PUT that switches it on — not at start, the first tick comes after an interval. The pass is asynchronous (in small
      // portions, ONE at a time — chats/auto-archive.js); a tick during a running one is noted there, not started alongside.
      const autoArchiveTimer = setInterval(() => {
        autoArchiveCycle().catch((e) => console.error("[auto-archive] tick:", e?.message || e));
      }, autoArchiveTickMs());
      autoArchiveTimer.unref?.();
      // ONE "close" listener for it and the tick of the scheduled jobs (below): an eleventh listener triggered the
      // MaxListenersExceededWarning at every start (see the shared listener before `server.listen`). A running pass of the
      // auto-archive stops at the next portion — it would otherwise keep writing after the server end.
      // The scheduled jobs: at start clean up runs an earlier server run left as "running" (parked counts as running), then the
      // tick. The "close" listener is the auto-archive's.
      try { scheduledAtStart(); } catch (e) { console.error("[scheduled] cleanup:", e?.message || e); }
      const scheduledTimer = setInterval(() => {
        try { scheduledTick(); } catch (e) { console.error("[scheduled] tick:", e?.message || e); }
      }, SCHEDULED_CHECK_MS());
      scheduledTimer.unref?.();
      server.once("close", () => { clearInterval(autoArchiveTimer); haltAutoArchive(); clearInterval(scheduledTimer); });
    });
  }));
}
