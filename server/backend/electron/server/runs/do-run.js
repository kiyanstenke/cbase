// doRun in one piece — the run of a turn (the subagent spec lives in runs/agents.js). The file sits close to the
// line-count guard — new things go into a building block of their own.
// The run-kind-dependent preparation (prompt additions, tool lists, special model, external MCP, approvals, schedule
// tools, builtinTools, addDirs, permissionMode, time zone, subagent set) comes from the registered run-kind provider
// (runs/hooks.js: runKindFor/runKindDefault; currently none is registered).
// The completion and event side fires hooks (afterExit behind the process end, afterRun behind `run_done`,
// afterRunFailed on abort/exit ≠ 0, beforeRunBroadcast in the finally, the end hook after it); the consumers are
// registered in server.js. No domain folder is imported.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, agentHosts, effortRunning, getConnector, providerForChat, resolveModelFor, runChat } from "../providers/index.js";
import { liveMonitors, startMonitor, stopMonitor } from "./monitors.js";
import { wakeupOf } from "./wakeup.js"; // the CHAT's wakeup — only reported, never held
import { cronPeriodMs, nextCronAt } from "../cron.js";
import { createUsageTally } from "../usage-tally.js";
import { saveChatLogins } from "../browser-profiles.js";
import { CHAT_BROWSER_SENTENCE, userBrowserForRun, userBrowserApplies } from "../devtools/user-browser.js";
import * as limits from "../limits.js";
import * as store from "../store.js";
import * as artifactStore from "../artifacts.js";
import { T } from "../i18n.js";
import * as notifications from "../notify.js";
import * as autocompact from "../autocompact.js";
import { loadAgentHooks } from "../toolchain/profiles.js";
import { instructionsFor } from "../toolchain/instructions.js";
import { outputLocation, outputsSentence, createOutputLocation } from "./outputs.js";
import { clearChatPermissions, loadPermissionRules, loadWebSearchConfig, rememberPermissionRule, requestPermission, toolsearchThreshold } from "./permissions.js";
import { CAUSES, RUN_STREAM_MAX, SUBAGENT_TOOLS, abortedRuns, compacting, runCause, pendingRunInputs, runBackground, runChildren, runContext, runMonitorControllers, runStreamText, runWaiting, runWaitPhaseYield, running, workflowDecides } from "./state.js";
import { chatSkills, definitionsSkills, skillCatalog } from "../toolchain/skill-catalog.js";
import { teaser, autoCompactionDue, autocompactMax, autocompactPercent, compactChatContext, goalGateAfterRun, contextWindowForChat, targetResumptionDropped, targetNow } from "./post-run.js";
import { upstreamReporter } from "./upstream-display.js";
import { boundResult, boundToolInput, buildEngineTranscript, buildSystemPrompt, focusedProject, scheduledPrompt, folderContextPrompt, goalPrompt, pathInside, projectFocus, projectMemory, projectInContainer, resolveCwd, subagentChoicePrompt, toolDetail, wakeupFor, worktreePrompt } from "./system-prompt.js";
import { broadcast, sse } from "../runtime/sse.js";
import { defaultModelFor } from "../account/providers.js";
import { emitAutoContinue, startFollowUpRun, limitLine, maybeAutoContinue, clearAwayOnlyReadable, clearAwayRunRow } from "./auto-continue.js";
import { onlyReadable } from "./only-readable.js";
import { managerLocked } from "./manager-lock.js";
import { autoContinueEnabled, clockText, clearAwayGateWithoutTurn, creditGateHolds, detectCreditSwitch, runOverruled, limitWindowsFor, projectLockHolds, wordingAround } from "./limit-gate.js";
import { deliverUserPrompt, enqueueRunInput, injectNextRunInput, controlActive, takeNextRunInput } from "./queue.js";
import { fireHooks, runKindFor, runKindDefault, turnout } from "./hooks.js";
import { openAskOf } from "./ask.js";
import { coresElsewhereWithAgents, liveRows, reportAgentsElsewhere, reportBackground, reportTurnElsewhere, openAgents, closeAgents, tickMarker } from "./agents.js";
import { observeBackground, backgroundWork } from "./background.js";
import { afterCompactionAttachment } from "./after-compaction.js";
import { staysInArchive, fetchBack } from "./archive.js";
import { depositHint, hintPreamble, hintsConsumed, isProviderCompaction, withHints, earmarkCompaction } from "./hints.js";
import { runWritesAgenda, agendaPreamble, withAgenda } from "./agenda-block.js"; // the agenda: fixed sentence in the prompt, content once per new session
import { attachmentLocation, attachmentPath, deferralHint, foreignChatFolder, copyAttachmentsTo, createLocation, mcpFile, locationForChat, playwrightProfileRoot, relocationHint, bringAlongChat } from "./runtime-location.js";
import { announcementsFrom, turnBegins, turnPast } from "./human-input.js";
import { instanceFromIdentifier, instanceOfChat, pinTurn, turnInstanceDifferent, turnIdentifier, releaseTurn, turnCheckOpen } from "./instance.js";
import { yieldNotice } from "./wait-phase-yield.js";
import { sessionConfirmed, sessionForStart, sessionTransferHint, sessionLostText } from "./session-location.js";
import { serverEnds } from "./server-end.js";
import { backendAccessFor } from "./backend-access.js";
import { lfsLockForStdio } from "./lfs-environment.js";
import { countMainOutput } from "./turn-output.js";
import { bookTurn, rememberTurnSession } from "./booking.js";
import { loginStockRoot, resolveChatHeadless } from "../toolchain/playwright.js";
import { approvalOverMcp, writeMcpConfig } from "../toolchain/mcp-config.js";
import { expiry as airlockExpiry } from "../toolchain/airlock-token.js";
import { saverField, saverForChat } from "./saver.js"; // CPU saver

// ── The preamble of a user turn ─────────────────────────────────────────────────────────────────────────────────
// The ultracode reminders and the guide for writing workflows belong in the USER MESSAGE of a turn that begins with
// human input — never in the system prompt. The domain side (dynworkflows/reminder.js) registers through this setter
// (server.js, the same pattern as setStartGate): `fn({ chat, toolset, inputs })` → `{ text, confirm() }` or null;
// `confirm` writes its counter once the turn really begins. Two places begin a user turn: the start of a run (doRun,
// below) and the handover of the queue into the running process (queue.js injectNextRunInput → injectionPreamble).
// Unset, no turn carries anything.
let turnPreambleProvider = null;
export function setTurnPreamble(fn) { turnPreambleProvider = typeof fn === "function" ? fn : null; }
// chatId → toolset of the running run ("" = the full one) — for the queue handover, which does not know the set.
const runToolset = new Map();
// Chats whose running process was compacted by the provider since the last user turn (runs/hints.js
// isProviderCompaction) — for the queue handover: the handed-over turn continues in THIS process and carries nothing
// of the session's beginning any more. The open hint applies to the next run (doRun), this flag to the process.
const runCompacted = new Set();
// `resumed`: does this turn's context still carry the session's beginning (see `preambleResumed` in doRun)?
function turnPreamble(chat, toolset, inputs, resumed = true) {
  if (!turnPreambleProvider) return null;
  try { return turnPreambleProvider({ chat, toolset: toolset || "", inputs, resumed }) || null; } catch (e) {
    console.error("[run] turn preamble:", e?.message || e);
    return null;
  }
}
/** The preamble of a turn that begins at the handover of the queue into the running process (queue.js). */
export function injectionPreamble(chatId, inputs) {
  if (!runToolset.has(chatId)) return null;
  const chat = store.getChat(chatId);
  const v = chat ? turnPreamble(chat, runToolset.get(chatId), inputs, !runCompacted.has(chatId)) : null;
  // The fresh start is carried only when the turn really begins — with `confirm` (queue.js after a successful handover).
  return v ? { ...v, confirm: () => { v.confirm?.(); runCompacted.delete(chatId); } } : null;
}
/** The user message with the preamble in front (like the silent hints: in front, separated from the typed text by the divider). */
export const withTurnPreamble = (text, preamble) => (preamble ? `${preamble}\n\n---\n\n${text}` : text);

// ── The turn completion ─────────────────────────────────────────────────────────────────────────────────────────
// A graph workflow the model earmarked in this turn with cbase_workflow_start begins as soon as the run has ended
// cleanly — in the finally, AFTER `running` has fallen and BEFORE the end-of-work verdict. The same setter pattern as
// setTurnPreamble: the domain side (workflows/graph-start.js) registers in server.js; a hook kind would be one more
// line in every golden `hooks.jsonl`. `fn(chat, { clean, aborted, parked })` → `{ started: true }` or null; unset or
// throwing the result is null (logged, never thrown).
let turnCompletionProvider = null;
export function setTurnCompletion(fn) { turnCompletionProvider = typeof fn === "function" ? fn : null; }
function turnCompletion(chat, u) {
  if (!turnCompletionProvider) return null;
  try { return turnCompletionProvider(chat, u) || null; } catch (e) {
    console.error("[run] turn completion:", chat?.id, e?.message || e);
    return null;
  }
}


// `overruled`: "start anyway" for EXACTLY this start — comes only from fireAutoContinueInner.
// `resumption`: this run is the turn of the chat's waiting row.
// `parentSince`: only the graph driver — the start time of its run, for the "layout" lock.
// `turnBegin`: only the resume retry below — the beginning of THE SAME turn, so its new core asks the "layout" lock in
// `waits` with the turn's beginning, not with the time of the retry (otherwise its subagents would wait for the
// takeover that waits for the turn).
async function doRun(chat, text, { noResume = false, goalDepth = 0, attachments = null, cause = "user", overruled = false, resumption = false, inputs = [], turnPreambleText = null, parentSince = null, turnBegin = null } = {}) {
  // A chat that is only readable begins no turn (runs/only-readable.js) — the catch for every path without its own check.
  if (onlyReadable(chat)) { clearAwayOnlyReadable(chat.id); return; }
  if (managerLocked(chat)) return; // no turn of a manager chat (runs/manager-lock.js), on any path — the catch
  if (staysInArchive(chat.id, cause)) return; // channel/message to an archived chat — no turn (runs/archive.js)
  running.add(chat.id);
  fetchBack(chat.id, { cause }); // archive: every run fetches its chat back — BEFORE the gate, never throws
  const turnSince = Math.min(Number.isFinite(turnBegin) && turnBegin > 0 ? turnBegin : Date.now(), Number.isFinite(parentSince) && parentSince > 0 ? parentSince : Infinity);
  pinTurn(chat.id, { projectId: chat.projectId }); // the turn runs in the project of its chat row (runs/instance.js)
  if (!CAUSES.has(cause)) cause = "user";
  // Credit gate: the one place where all RUNS converge (composer, schedule, channel, workflow driver, auto-resume …) —
  // and the only one where cause, chat and provider are fixed at once. Oneshots check at the spawn layer; subagents
  // are asked by their core before every start (runs/agents.js).
  //
  // The check stands AFTER `running.add` and cleans up itself on a hit. Before the add it would be an open window:
  // `running` is the only lock against two simultaneous runs of the same chat, and between the first `await` and the
  // add a second message would get through. Broadcasting and active_runs come further down — so this call has nothing
  // to take back but the marker; what it clears is inherited (see below).
  //
  // NOT on the resume retry (`noResume` — doRun calls itself that way below, and only there): that is the same turn
  // with a fresh session, its gate is passed. A second verdict could park it mid-job or write a second "started
  // anyway" into the history.
  //
  // BEFORE it, in the same expression, the per-project lock (runs/limit-gate.js projectLockHolds): synchronous, same
  // return, same cleanup — a locked turn waits in the waiting row or ends visibly at once on an error. HERE and not in
  // the run start: drivers, gates, target gate and app agents call doRun directly, past the composer, channel,
  // auto-continue and resume paths. Without an instance row and ops marker it answers `false`.
  // If the turn does not get past the gate — held OR thrown (it lies BEFORE the try) —, limit-gate.js
  // clearAwayGateWithoutTurn clears what it carried until then; a throw then continues to the caller. BEFORE that: the
  // continuation of the target gate (goalDepth > 0) begins only with an effective target, fresh from the row
  // (post-run.js targetResumptionDropped), cleared like a held turn.
  if (!noResume && targetResumptionDropped(chat.id, { goalDepth, row: resumption })) { clearAwayGateWithoutTurn(chat); return; }
  let held = false;
  try {
    if (!noResume && (projectLockHolds(chat, text, { goalDepth, attachments, cause, resumption, parentSince, inputs })
      || await creditGateHolds(chat, text, { goalDepth, attachments, cause, overruled, resumption, inputs }))) held = true;
  } catch (e) { // the run start turns this into the error row; a continuation takes its 6-h row along, the queue runs
    // The run end goes along ("beforeRunBroadcast" with the wording of the throw): a scheduled occurrence would never end otherwise.
    try { clearAwayGateWithoutTurn(chat, { thrown: true, resumption, cause, inputs, error: String(e?.message || e) }); } catch {}
    throw e;
  }
  if (held) { clearAwayGateWithoutTurn(chat); return; }
  // The gate is passed. If the human overruled it ("start anyway"), the run carries the marker: the queue is then NOT
  // injected into this process (see runOverruled) — exactly this one turn is released, a queued job asks the gate
  // itself. Removed in the finally; on the resume retry the recursive call enters it again.
  if (overruled) runOverruled.add(chat.id);
  // This turn's inputs each with their STATED cause (runs/human-input.js) — not `cause` above, which is "user" when
  // missing or unknown. A run without `inputs` has no human input.
  turnBegins(chat.id, inputs);
  // Hook "turnStart": the turn is past the gate, its inputs are fixed — a scheduled run begins NOW (real start).
  fireHooks("turnStart", { chat, cause, inputs });
  // A turn begins: ITS end judges — a deferred verdict of an earlier turn lapses. Behind the gate: a turn the gate
  // catches never judges, then the old one stays.
  try { store.dismissVerdict(chat.id); } catch { /* a verdict is information about the end, no reason to abort */ }
  // The continuation of a waiting row COUNTS as an attempt only now: an attempt is a start, not a waking. Counting
  // before the start would spend an attempt whenever the gate caught the turn again without a model being called, and
  // after twelve such cycles the job would count as given up. For verdict and compaction the wakeup still counts
  // (there the waking is the start). `resumption` stands only on the doRun the wakeup itself launches — and a resume
  // retry (`noResume`) is the same turn, not a second attempt.
  if (resumption && !noResume) { try { store.bumpPendingResumeAttempts(chat.id); } catch {} }
  // Scheduled run: the result that goes into the run row at the end. `parked` means usage limit — then the run has
  // not ended but waits, and is concluded later.
  let scheduleError = "";
  let scheduleParked = false;
  let scheduleResult = "";
  // The same text, but for the "answer ready" notification of every run — not only the scheduled ones.
  let lastResponse = "";
  const runBegin = Date.now(); // for the run duration in the hook message
  // Mark the run persistently (survives a backend/container restart). startedAt lies AFTER the previously stored user
  // message and BEFORE this run's blocks → on auto-resume the partial output can be removed cleanly from startedAt.
  // prompt/goalDepth allow re-execution, `announcements` carries the inputs' announcements into the restart
  // (runs/resume.js).
  const activeStartedAt = Date.now();
  try { store.setActiveRun(chat.id, { kind: cause === "user" ? "chat" : `chat:${cause}`, prompt: text, goalDepth, attachments, announcements: announcementsFrom(inputs), startedAt: activeStartedAt }); } catch {}
  broadcast({ type: "run", chatId: chat.id, running: true }); // sidebar: hexagon spins
  let answered = false; // was a complete answer produced? → sidebar "unread"
  // Ended cleanly (code 0, not parked at the limit): only then may automatic compaction follow — an aborted or parked
  // run still needs its session.
  let runCleanEnded = false;
  // This run's target gate, if one is due — started in the finally, AFTER a possible automatic compaction. Running
  // next to it, the continuation would start with the OLD session and the full history while compactChatContext
  // writes `claudeSessionId: null` into the middle of the new turn. The gate only checks `running`, and no turn runs
  // during compaction. As DATA: a deferred verdict is stored and caught up later.
  let target = null;
  // Like providerMonitorController: declared here because the finally block removes it again.
  let waitPhaseYield = null; // likewise here, because the finally block removes it from runWaitPhaseYield
  let handedOff = false; // the resume retry hands the run to a recursive doRun call
  let hintIds = []; // the silent hints this turn carries (runs/hints.js)
  let providerMonitorStart = null;
  let providerMonitorStop = null;
  let providerMonitorController = null;
  let backgroundUnregister = null; // the observer of ending background work outside the core (see holdMs)
  let agentController = null; // subagent core (cbase_agent) of this turn — survives it if the run kind does not hold
  // Does a live background agent keep this turn open? A question to the run kind (runs/hooks.js `hold`), not to the
  // core; set from the preparation. Default yes.
  let holdAgents = true;
  let runAborted = false; // `/stop`: the turn ends with its foreground agents, see finally
  let atServerEnd = false; // the turn died at the server's end: active_runs stays, the restart continues it
  let drainTimer = null; // deadline after which stdin is closed despite open wake reasons (see below)
  // Delivery of the scheduled continuation (ScheduleWakeup, see below). HERE and not in the try block because the
  // cleanup at the run end (finally) must cancel it.
  let wakeupTimer = null;
  const clearWakeupTimer = () => {
    if (!wakeupTimer) return;
    clearTimeout(wakeupTimer);
    wakeupTimer = null;
  };
  // The same for the tick of the agent bar (armAgentTick, see below): set in the try, cleared in the finally.
  let agentTickTimer = null;
  const clearAgentTick = () => {
    if (!agentTickTimer) return;
    clearInterval(agentTickTimer);
    agentTickTimer = null;
  };
  // This turn's runtime folder (runs/runtime-location.js): fixed at the turn's beginning — the location of the current
  // project, flat as long as it is not converted. Declared here because the finally reads it (mirroring browser
  // logins back).
  let runLocation = null;
  let userBrowser = null; // this chat's browser for the main agent (devtools/user-browser.js), released in the finally
  try {
    runLocation = createLocation(locationForChat(chat));
    // This turn's instance: fixed ONCE, from the same project as the location; it travels along (spec, monitor,
    // subagent core). null ⇒ every start without an instance (no instance row or no server operation).
    // The chat's copy if it carries one (that of its current project) — a child chat that of its start. If its
    // instance row is missing, this throws: no turn in main instead of in the copy.
    const instance = instanceOfChat(chat, runLocation);
    pinTurn(chat.id, { projectId: chat.projectId, instance }); // from here with the instance: idle state and fence
    reportAgentsElsewhere(chat.id, instance); // running subagents of another instance stay there (silent hint)
    reportTurnElsewhere(chat.id, instance); // the previous turn ran elsewhere after a switch midway (silent hint)
    // Project switch: the chat's files follow at the beginning of the first turn at the new location — BEFORE the
    // prompt is built, so the silent hint about the old paths already reaches this turn (hintPreamble, below).
    runtimeBringAlong(chat, runLocation, { instance });
    // The user's instructions for the main run.
    const instructions = instructionsFor({ workspaceId: chat.workspaceId, projectId: chat.projectId || null, role: "main" });
    // If the turn runs in the project container, the project folder is its cwd (without an instance the workspace).
    const cwd = resolveCwd(chat, { instance });
    const inContainer = Boolean(projectInContainer(chat, { instance }));

    // This chat's RUN KIND: what the run needs per special run kind — prompt additions, tool lists, special model,
    // external MCP servers, approvals, schedule tools, builtinTools, addDirs, permissionMode, time zone, subagent set —
    // is supplied by the registered provider (server.js: registration list; currently none is registered). An
    // ordinary chat gets the default. The shape is in runs/hooks.js (runKindDefault).
    // The provider runs SYNCHRONOUSLY and BEFORE the prompt is built, because `toolset` already decides on the tool
    // lore in the prompt (buildSystemPrompt); it may return the chat row anew.
    const runKind = runKindFor(chat);
    const preparation = runKind ? runKind.provider(chat, { cause }) : runKindDefault(chat);
    chat = preparation.chat;
    // If the run kind does not hold, the core asks the domain side (switch "hold"): an open graph workflow holds
    // anyway — its step is finished only when its agents' reports are processed in the same turn.
    // Asked only here, not per tick: the answer is a property of the run (the driver sets "running" before it calls
    // doRun), and a holding run kind does not ask at all — hence the golden runs do not see the switch.
    holdAgents = preparation.hold !== false || turnout("hold", { chat }) === true;
    // This chat's named toolset ('' = the full one). It decides further down on MCP offering, builtinTools and
    // allowedTools — and here on the tool lore in the prompt, so description and execution do not drift apart.
    const { toolset, builtinTools, permissionMode, timeZone } = preparation;
    runToolset.set(chat.id, toolset || ""); // for injectionPreamble
    runCause.set(chat.id, { cause, causeBound: cause === "schedule" }); // read by state.js when deciding whether an input fits into the run
    // This run's skill set — the same computation as behind the slash picker. It decides two things: whether the
    // catalog goes into the system prompt and whether `cbase_skill` is offered at all (empty set = neither block nor
    // tool, hence no cost either).
    const runSkills = chatSkills(chat);
    const runSkillNames = runSkills.map((s) => s.name);
    // Special agents: the role is (invisibly) in the system prompt, not a chat message — BEFORE the project focus
    // (promptBeforeFocus; currently nobody sets it).
    // The agenda belongs to the main run of a Coding chat.
    const mainRun = runWritesAgenda(chat, toolset);
    let systemPrompt = buildSystemPrompt(instructions, { full: !toolset, agenda: mainRun });
    // The main agent works in the chat's browser the human sees — ONE fixed sentence per chat (in front,
    // cache-friendly). The same question as the execution side (userBrowserForRun); if the start fails there, a hint
    // in this turn says so.
    if (userBrowserApplies(chat, { toolset })) systemPrompt += "\n\n" + CHAT_BROWSER_SENTENCE;
    // Visible outputs: the same run as agenda and watch gets the fixed paragraph with the output location at THIS
    // turn's location — the path runAddDirs passes as --add-dir.
    if (mainRun) systemPrompt += "\n\n" + outputsSentence(outputLocation(chat.id, runLocation || undefined));
    if (preparation.promptBeforeFocus) systemPrompt += "\n\n" + preparation.promptBeforeFocus;
    // Project focus: cwd stays the workspace, the focus comes via the system prompt.
    const focusProj = focusedProject(chat);
    // If the turn runs in the chat's copy, the copy paragraph hangs on the focus (name, branch space, fetching/clearing
    // away, state, real targets); a copy made from a copy names its template.
    // Its subagents and workflow agents get the same computation (system-prompt.js projectFocus, runs/agents.js) — the
    // main run without a tool cut.
    const focus = projectFocus(chat, { instance });
    if (focus) systemPrompt += "\n\n" + focus;
    // A graph workflow in its own worktree: the path rule, as long as its run is open and the folder exists — in the
    // foreground (this chat drives it, the worktree comes via runAddDirs) as in the child chat (cwd, resolveCwd).
    const runWorktree = activeGraphWorktree(chat.id);
    if (runWorktree) systemPrompt += "\n\n" + worktreePrompt(runWorktree.info, { foreground: !runWorktree.background, project: focusProj });
    // This chat's scheduled job: its instructions apply EVERY turn, without a time of day (prompt cache).
    const jobValue = chat.jobId ? store.jobOfTheChat(chat.id) : null;
    if (jobValue) systemPrompt += "\n\n" + scheduledPrompt(jobValue, { name: chat.title });
    // Overarching target (via /goal) — passed on every run unless it is paused.
    // Target AND pause FRESH from the row (post-run.js targetNow): `chat` can be an older state (continuation, queue, restart).
    { const z = targetNow(chat.id); if (z.applies) systemPrompt += "\n\n" + goalPrompt(z.text); }
    // Context files of the chat folder: the directory belongs in the system prompt so the agent KNOWS of the basis —
    // without it it could not read them purposefully.
    if (chat.folderId) {
      try {
        const ctxFiles = artifactStore.listContextFiles(chat.folderId);
        if (ctxFiles.length) {
          const folder = store.getChatFolder(chat.folderId);
          systemPrompt += "\n\n" + folderContextPrompt(folder?.name || "", ctxFiles);
        }
      } catch { /* folder context is optional — errors must not prevent the run */ }
    }
    // This chat's provider — determines CLI/engine and event translation.
    const providerId = providerForChat(chat);
    // Does the provider drive its own tool loop (Claude/Codex CLI)? Otherwise the loop engine takes over.
    const ownsLoop = PROVIDERS[providerId]?.caps?.ownsAgentLoop !== false;
    // The server itself prepends CLAUDE.md/AGENTS.md for EVERY provider, Claude too: with `--setting-sources user` the
    // CLI does not read them (see projectMemoryPrompt) — otherwise the same project rule would apply or not depending
    // on the provider.
    {
      // In the project container the workspace is no longer above the cwd — its file comes along explicitly.
      // In a copy its container reads the files under the project folder (projectMemoryPromptIn).
      // The same computation as for subagents and workflow agents (system-prompt.js projectMemory).
      const mem = await projectMemory(chat, { cwd, instance });
      if (mem) systemPrompt += "\n\n" + mem;
    }
    // Additionally accessible directories (provider-neutral, translated to --add-dir per CLI) — ONE computation with
    // the core without a turn (see runAddDirs).
    const addDirs = runAddDirs(chat, cwd, focusProj, preparation, runLocation, { instance });
    // Permission mode (`permissionMode`, from the preparation): purely chat level (profiles carry NO permissions).
    // Default full access.
    // Attach the cbase MCP server (instead of curl): own config per chat with project/workspace context.
    // writeMcpConfig supplies the config file (Claude: --mcp-config) AND the server map (Codex: -c).
    const mcpConfigPath = mcpFile(chat, runLocation);
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    // Mount this chat's activated MCP servers. In an entered project its own plus the workspace-wide active ones the
    // project has not hidden (project_mcp_excluded); without a project the workspace-wide active ones.
    const extraServers = store.effectiveMcpServers(chat.workspaceId, focusProj?.id ?? null);
    // The MAIN AGENT works in this chat's browser — the same one the human sees in the right rail; if it is not
    // running, it starts here, held until the finally. If the start fails, the turn runs in the chat's Playwright
    // profile, and model and human both learn of it. Subagents, workflow and outer-loop agents do not come here (null).
    userBrowser = await userBrowserForRun(chat, { instance, toolset });
    // The permission prompt: ONE computation for the CLI flag (spec.permissionPromptTool below) and the tool's
    // offering — without it cbase_permission_prompt would stand in every run, also for Codex and the engine.
    const approvalTool = approvalOverMcp(PROVIDERS[providerId]?.caps, permissionMode);
    const { names: extraNames, servers: mcpServers, assignment } = writeMcpConfig(mcpConfigPath, { projectId: chat.projectId, workspaceId: chat.workspaceId, chatId: chat.id, extraServers, setProject: focusProj?.id ?? null, headless: resolveChatHeadless(chat), toolset, skills: runSkillNames, vision: PROVIDERS[providerId]?.caps?.vision !== false,
      timeZone: jobValue?.timeZone || timeZone, runtime: runLocation, // a job chat: its job's time zone
      approval: approvalTool,
      // With an instance the backend's address from its project network and its token; without an instance nothing.
      ...backendAccessFor(instance),
      // The stdio servers of a Claude CLI with an LFS environment do not inherit its access (runs/lfs-environment.js).
      ...(lfsLockForStdio(instance, providerId) ? { lfsLock: true } : {}),
      ...(userBrowser?.cdpEndpoint ? { userBrowser: userBrowser.cdpEndpoint } : {}) });
    // Workspace chat: project assignment of the project MCP servers — from the same list as the configuration (toolchain/mcp-config.js).
    systemPrompt += assignment;
    // Always allow MCP tools (the app settles approvals interactively, see below). Profiles carry no tools.
    // With a cut toolset (named set) only the cbase server is in the config — allow nothing else, plus ToolSearch.
    // An outer-loop agent removes marked tools from its set.
    const allowed = toolset ? ["mcp__cbase", "ToolSearch"] : ["mcp__cbase", "mcp__playwright", ...extraNames.map((n) => `mcp__${n}`)];
    // ToolSearch on the CLI path. `--tools` is an allowlist over the BUILTIN tools — and the Claude CLI carries its own
    // ToolSearch as a builtin tool. A cut set ("Read,Glob,Grep") would silently cut it away too: the CLI could no
    // longer load the MCP schemas on demand and would put all of them into EVERY request. A Coding chat is not
    // affected — there builtinTools is null, so no `--tools` is on the line and the CLI has its full set.
    //
    // The threshold mirrors DEFER_ABOVE of the loop engine (45): below it reloading costs more rounds than the schemas
    // save in tokens. Counted is what the model sees in this turn — builtins plus the run's MCP tools; whether they
    // are really deferred is then decided by the CLI itself.
    const toolCount = Array.isArray(builtinTools) ? builtinTools.length : 0;
    const toolSearchNeeded = Array.isArray(builtinTools) && toolCount > toolsearchThreshold();
    // The agent definitions (app-managed, per workspace/project) are agent types of the core: for EVERY provider they
    // are started exclusively via `cbase_agent` — with role, origin, skills, model and tools from the definition
    // (providers/agent-runtime.js start). The Claude CLI's own agent tool would start them past the core (no cap, no
    // depth, no credit gate, no counting) — Agent/Task are blocked.
    let agentDefsRaw = [];
    try { agentDefsRaw = store.effectiveAgents(chat.workspaceId, focusProj?.id ?? null); }
    catch { /* agents are optional — errors must not prevent the run */ }
    // Choice for the NATIVE agent tool. It deliberately stands in the system prompt and not only in cbase_agents_list:
    // a foreign model should know the choice before it reaches for its own subagent tool. A run with a named (cut) set
    // does not get it.
    if (!toolset) {
      // The skills per type with THE SAME resolution as at the start (skill-catalog.js definitionsSkills).
      try { systemPrompt += "\n\n" + subagentChoicePrompt(agentDefsRaw, agentHosts(), { skillState: (d) => definitionsSkills(chat, d, runSkills) }); }
      catch (e) { console.error("[agents] choice not added to the prompt:", e?.message || e); }
    }

    // Skills: ONE path for all providers: the catalog stands in the system prompt (built above), loading goes via
    // `cbase_skill`; all providers speak MCP.
    if (runSkills.length) systemPrompt += "\n\n" + skillCatalog(runSkills);
    // `--setting-sources user` stays WITHOUT a plugin directory: it also is the isolation against a `.claude/skills`
    // in the working directory. Without it a foreign repo directory would show through again.
    const settingSources = ownsLoop && providerId !== "codex" ? "user" : "";

    // Completion providers (loop engine): history (resume via transcript) + in-process approval callback.
    let engineCtx = null;
    let engineTranscript = null;
    let engineImageAttachments = null;
    if (!ownsLoop) {
      // Lookback budget at the context window of THIS model (see buildEngineTranscript).
      const ctxWindow = (PROVIDERS[providerId]?.models || [])
        .find((mo) => mo.id === resolveModelFor(providerId, chat.model || defaultModelFor(providerId)))?.context || 0;
      engineTranscript = buildEngineTranscript(chat.id, { contextWindow: ctxWindow });
      engineCtx = {
        requestPermission: (a) => requestPermission(chat.id, a),
        hooks: loadAgentHooks(),
        // Permanent approvals ("do not ask again") — the same source as on the CLI path.
        allowRules: loadPermissionRules(),
        rememberRule: (rule) => rememberPermissionRule(rule),
        webSearch: loadWebSearchConfig(), // real search API if configured (otherwise DuckDuckGo)
        // No startMonitor/stopMonitor/startAgent: the engine provides neither Monitor, TaskStop, ScheduleWakeup nor
        // Task — monitor and subagent go, as for Claude and Codex, via cbase_monitor (route /monitor, the same runtime
        // `providerMonitorStart` below) and cbase_agent (the same core).
      };
      // Image attachments of this turn for vision-capable connectors. With a fallback to the old location
      // (runs/runtime-location.js attachmentPath): if the move of the chat files is deferred, the image still lies there.
      if (Array.isArray(attachments) && attachments.length) {
        engineImageAttachments = attachments
          .filter((a) => /^image\//.test(a.mime || ""))
          .map((a) => ({ path: attachmentPath(chat, a.file, runLocation), mime: a.mime }));
      }
    }

    // Before the spawn the session lies in the home of THIS run's CLI (in the project container the project's home,
    // otherwise the backend's) — after a project switch or relocation it moves here (runs/session-location.js).
    // Without an instance and without any instance row a no-op without file access.
    const sessionTransaction = noResume ? null : sessionForStart({ sid: chat.claudeSessionId, provider: providerId, instance, cwd });
    // If the folder `<sid>/` moved along (tool results), the history names it under the old path — deposited BEFORE
    // hintPreamble so this turn already carries it.
    { const t = sessionTransferHint(sessionTransaction); if (t) depositHint(chat.id, t, { source: "session_transfer" }); }
    const useResume = !noResume && chat.claudeSessionId;

    // After /compact: prepend the compacted summary once to the fresh run (without resume there is no session context
    // any more). It is cleared afterwards.
    const injectSummary = !useResume && chat.contextSummary && chat.contextSummary.trim();
    // Silent hints (runs/hints.js): fenced BEFORE the input, never in `text` (that stays what was typed) and never in
    // the system prompt. Consumed in the finally — that way a resume retry carries them again.
    const hints = hintPreamble(chat.id);
    hintIds = hints.ids;
    // "Resumed" means: the model already has the preambles from the session's beginning (agenda, full ultracode
    // reminder with guide) in its context. For Claude and Codex the CLI's resumed session carries them. The loop engine
    // has none — its memory is the lookback from the DB, which reproduces every input as it went out (role `input`,
    // see below). An engine chat is therefore resumed only if the lookback contains the input that carried the
    // preambles (`beginningPreserved`, providers/transcript.js); the engine's session id (a synthetic UUID) is no
    // proof. If the input with the agenda falls out of the lookback (budget cut, compaction), it stands in front again
    // in the next turn.
    // Also NOT resumed: a session the provider itself compacted since the last turn (the open hint of the compaction
    // source, runs/hints.js) — the same answer applies to the ultracode reminder.
    const preambleResumed = !hints.compacted
      && (ownsLoop ? Boolean(useResume) : Boolean(useResume) && engineTranscript?.beginningPreserved === true);
    // Ultracode reminder and guide: computed once per turn — a resume retry gets the text passed (`turnPreambleText`)
    // and does not count again; unless it was computed for a resumed session (see there).
    if (turnPreambleText === null) {
      const v = turnPreamble(chat, toolset, inputs, preambleResumed);
      v?.confirm();
      turnPreambleText = v?.text || "";
    }
    const inputValue = withAgenda(agendaPreamble(chat, { toolset, resumed: preambleResumed }), withHints(hints.preamble, withTurnPreamble(text, turnPreambleText)));
    // After a compaction (modelled on Claude Code): the summary as a message (contextSummary, runs/post-run.js), then
    // the attachments — files, background work, skills (runs/after-compaction.js) —, then the input.
    const attachment = injectSummary && !preambleResumed
      ? afterCompactionAttachment(chat, { withFiles: providerId !== "codex", instance, location: runLocation || undefined }) : "";
    const rawInput = [injectSummary ? chat.contextSummary.trim() : "", attachment, inputValue].filter(Boolean).join("\n\n---\n\n");
    const input = rawInput;

    sse(chat.id, { type: "harness", subtype: "run_started", resume: Boolean(useResume), provider: providerId });

    // Provider-neutral run spec — the provider registry builds the CLI arguments from it and (for Codex) translates the
    // event stream into the Claude-shaped stream-json events below.
    const runModel = chat.model || defaultModelFor(providerId);
    const spec = {
      cwd,
      instance, // start in the project container; null = in the backend
      ...saverField(saverForChat(chat)), // CPU saver: only the child chat of a background graph workflow (runs/saver.js)
      // Trimmed: the prompt is assembled from conditional parts with `+= "\n\n" + …`, and if the first drops out it
      // begins with blank lines. Meaningless to the model, but a frozen prompt snapshot would keep them forever.
      systemPrompt: systemPrompt.trim(),
      addDirs,
      permissionMode,
      mcpConfigPath,
      mcpServers,
      allowedTools: allowed,
      // The provider's builtin tools: null = full set, list = exactly these ([] = none).
      builtinTools,
      permissionPromptTool: approvalTool,
      settingSources,
      // Unsubscribe the CLI's NATIVE skill tool: skills come exclusively via `cbase_skill`. Without this line two
      // tools doing the same would stand side by side — one with the cbase catalog, one with the account's personal
      // skills, which cbase knows nothing of and cannot measure. `--disallowedTools` instead of enumerating all the
      // rest: a positive list would have to follow every new CLI capability and would silently remove it until then.
      disallowedTools: ["Skill"],
      model: runModel,
      // The level that really thinks: set ⇒ default ⇒ clamp to the model (providers/index.js).
      effort: effortRunning(providerId, runModel, chat.effort, { report: true }),
      sessionId: useResume ? chat.claudeSessionId : null,
      forkPending: Boolean(chat.forkPending),
      input,
      // Claude CLI: its builtin ToolSearch added to the `--tools` allowlist (see toolSearchNeeded).
      toolSearch: toolSearchNeeded,
      // Only completion providers (loop engine); native connectors ignore these fields.
      transcript: engineTranscript,
      engine: engineCtx,
      attachments: engineImageAttachments,
      // Autocompact: the engine compacts WITHIN a run from this share of its window — the same stage as the harness
      // after the run. 0 = its own safety valve (COMPACT_AT); the CLIs know no such switch and ignore the field.
      // With an open workflow its values take precedence over the chat's: both helpers read them via `store`
      // (post-run.js), not via workflows.js.
      compactAt: autocompact.engineShare(autocompactPercent(chat), 0, {
        window: contextWindowForChat(chat),
        absolute: autocompactMax(chat),
      }),
    };

    const runStart = Date.now();
    // Workflow assignment for consumption tracking — read HERE, not at the run end. The driver writes the step number
    // BEFORE it sends the turn off (see driveWorkflow), so it is already fixed. Reading at the run end would be
    // harmful: there the driver decides on the next step, and an extra query in this transition measurably made the
    // round cap take effect one round too late.
    const usageRun = (() => {
      try {
        const r = store.getWorkflowRun(chat.id);
        return r && !r.endedAt ? { runId: r.id, step: r.step || 0 } : { runId: "", step: 0 };
      } catch { return { runId: "", step: 0 }; }
    })();
    // Persist every block IMMEDIATELY (texts as assistant rows, tool calls as tool rows): the CLI delivers exactly one
    // assistant event per content block, hence free of duplicates. That way the history including tool calls survives
    // tab switches and leaving mid-run.
    // Context = input side of the last API call + its output (from message_delta).
    let ctxIn = 0;       // input side of the last API call (= context size)
    let lastOut = 0;     // output of the last API call (for the context display)
    let runOutBase = 0;  // output of this run's previous API calls
    let runOut = 0;      // cumulative output over the whole run (for the summary)
    let persistedText = false;
    // Save the context size CONTINUOUSLY, not only at the run end: a reload mid-run would read the still empty column
    // and show "0 / 1M" although the context was long six-digit (especially in the waiting phase, where no usage
    // event arrives for minutes). An aborted or crashed run leaves the right state that way too.
    let ctxPersisted = 0;
    const bumpContext = () => {
      const tok = ctxIn + lastOut;
      if (!tok || tok === ctxPersisted) return;
      ctxPersisted = tok;
      runContext.set(chat.id, tok);
      try { store.updateChat(chat.id, { contextTokens: tok }); } catch { /* the display must never disturb a run */ }
    };
    // The provider BEHIND a router that delivered the last answer, and its context window — DISPLAY ONLY, computing
    // continues with the catalog number. The rules (the youngest resolution per chat wins, write nothing after a
    // model/provider switch, every run begins empty) are in runs/upstream-display.js.
    const upstreamConn = getConnector(providerId); // the connector itself — `PROVIDERS` is only a view without methods
    const upstreamReport = upstreamReporter({
      chatId: chat.id, model: chat.model || "", provider: chat.provider || "",
      resolve: (name) => (typeof upstreamConn?.providerWindow === "function" ? upstreamConn.providerWindow(runModel, name) : 0),
      getChat: (cid) => store.getChat(cid),
      write: (name, window) => {
        store.updateChat(chat.id, { upstreamProvider: name, upstreamWindow: window });
        sse(chat.id, { type: "harness", subtype: "provider", provider: name, window });
      },
    });
    // If the chat runs via a connector that never reports a provider (Claude, Codex, …), an old name with its window
    // would otherwise stand in the bar forever — e.g. an old chat with provider "" after a global switch.
    if (chat.upstreamProvider && typeof upstreamConn?.providerWindow !== "function") {
      try {
        store.updateChat(chat.id, { upstreamProvider: "", upstreamWindow: 0 });
        sse(chat.id, { type: "harness", subtype: "provider", provider: "", window: 0 });
      } catch { /* the display must never disturb a run */ }
    }
    // Consumption of the whole run (all API calls, main stream AND subagents) — unlike ctxIn/lastOut, which describe
    // only the last call. Details in usage-tally.js.
    const tally = createUsageTally();
    // Monitor lifecycle (Claude CLI): monitor tool_use ids → their background tasks. If a result arrives while
    // monitors are open, the process stays alive (stdin open) and the run enters the waiting phase — the user can keep
    // writing (injection via /message).
    const monitorUses = new Set(); // tool_use ids of monitor calls
    const monitors = new Map();    // task_id -> { taskId, description }
    // The call blocks of the OWN subagents (cbase_agent & co.): for assigning their result to the block (blockTo).
    // They are not limit evidence — such an agent parks at the limit itself.
    const subagentUses = new Set(); // tool_use ids of cbase_agent
    const limitEvidence = [];      // error texts that could evidence a usage limit
    // Model/credit switches of this run already reported. The CLI likes to repeat its message (the result event
    // carries the same sentence once more) — without this set the row would be in the history twice. Checked is the
    // WORDING, not the model: the same model can be chosen twice for different reasons in a long run.
    const modelSwitchReported = new Set();
    const modelSwitchReport = (raw) => {
      const text = String(raw || "");
      if (!text) return;
      const changeover = limits.detectModelSwitch(text);
      const set = changeover
        ? wordingAround(text, Math.max(0, text.search(/[\w.\-]{2,24}\s+limit\s+reached/i)))
        : detectCreditSwitch(text);
      if (!set || modelSwitchReported.has(set)) return;
      modelSwitchReported.add(set);
      limitLine(chat.id, {
        kind: "model_switch", model: changeover?.model || "", limitName: changeover?.limit || "",
        source: "cli", set,
        text: changeover
          ? T`${changeover.limit} limit reached — the provider switched to "${changeover.model}" on its own: "${set}"`
          : T`The provider changed how it bills from here on: "${set}"`,
      });
    };
    // The CLI has no background agents (Agent/Task with run_in_background): Claude's Agent/Task is blocked in every
    // run. The subagents are led by their owner (runs/agents.js: liveCount, rows, reportsOpen) — not this run.
    // SECOND reason: background BASH. On `task_updated {status:"completed"}` a `system/init` follows within ~100 ms,
    // the CLI evaluates the output on its own — closing stdin too early loses the job. But `npm run dev` never ends,
    // hence capped (BG_TASK_IDLE_MS).
    const bashUses = new Map();    // tool_use id -> description of the background command
    const bgTasks = new Map();     // task_id -> { taskId, description }
    // The THIRD and FOURTH reason do not apply in normal operation: no provider provides ScheduleWakeup, CronCreate or
    // Monitor; cbase wakes via cbase_wakeup/cbase_monitor. The branches stay for a binary without the block.
    // THIRD reason: ScheduleWakeup. The CLI begins a turn with the scheduled prompt on its own at the wake time; that
    // too only needs open stdin. TRAP: the wake time is ROUNDED UP to the full minute (measured: delaySeconds 60 →
    // 72 s), wakeupFor accounts for that.
    let wakeupAt = 0;              // ms time of the scheduled continuation (0 = none)
    let wakeupPrompt = "";         // text the woken turn begins with
    let wakeupReason = "";         // the agent's reason (shown to the user)
    // FOURTH reason: CronCreate. The same promise as ScheduleWakeup ("I will report at X"), only with a cron
    // expression — and with one decisive difference: in `-p --input-format stream-json` operation the CLI fires the
    // cron job ITSELF (command_lifecycle → system/init → answer), provided stdin is open. So nothing may be injected
    // here, otherwise the turn would exist twice. What remains: keep open until then — and report it. Without that
    // `holdMs()` saw no reason, stdin closed and the job died with the process (it lives only in this CLI session).
    const crons = new Map();       // tool_use-Id -> { jobId, expr, prompt, recurring, nextAt, holdUntil }
    let bgIdleUntil = 0;           // deadline while ONLY background Bash is still open
    // The next automatic wake call. For the user wakeup and cron job are the same promise, hence they share chip and
    // info card (the client only knows `wakeupAt`).
    const nextCron = () => {
      let best = null;
      for (const j of crons.values()) if (j.nextAt && (!best || j.nextAt < best.nextAt)) best = j;
      return best;
    };
    const cronReason = (job) => (job.recurring
      ? T`Schedule ${job.expr} (recurring)`
      : T`Schedule ${job.expr} (one-shot)`);
    // The native subagents in the shape web and iOS read. Rebuilt on EVERY report, not frozen at the start: tokens,
    // tool count and status grow in the event stream.
    // From the OWNER, not from this turn's core: a background agent of an earlier turn lives on in that core, and an
    // event without it would make it appear as "without result" in bar and sheet.
    const nativeAgentRows = () => (agentController ? liveRows(chat.id) : []);
    const waitingState = () => {
      const job = nextCron();
      const cron = job && (!wakeupAt || job.nextAt < wakeupAt);
      // The scheduled continuation of THIS run (provider's own wakeup or schedule, blocked) — and the CHAT's wakeup
      // (runs/wakeup.js), which survives this turn: the earlier one is reported. The clients know only ONE wakeup.
      let wakeup = { at: cron ? job.nextAt : wakeupAt, reason: cron ? cronReason(job) : wakeupReason, prompt: cron ? job.prompt : wakeupPrompt };
      const chatWakeup = wakeupOf(chat.id);
      if (chatWakeup && (!wakeup.at || chatWakeup.at < wakeup.at)) wakeup = chatWakeup;
      return {
        // The CLI's native monitors (blocked) and the CHAT's monitors (runs/monitors.js) — the latter survive this
        // turn, they are reported here like the agents from their owner.
        monitors: [...monitors.values(), ...liveMonitors(chat.id)],
        agents: nativeAgentRows(),
        tasks: [...bgTasks.values()],
        wakeupAt: wakeup.at,
        // Purpose and text of the scheduled continuation go to the clients too: the display above the input field
        // names only the time, the info window next to it shows both.
        wakeupReason: wakeup.reason,
        wakeupPrompt: String(wakeup.prompt || "").slice(0, 600),
      };
    };
    // Report background work to the clients — mid-turn too. The client shows "N agents working" from it; without this
    // event it learns of background agents only when the main agent enters the waiting phase (or never, if it simply
    // keeps working).
    const publishBackground = () => {
      const st = waitingState();
      runBackground.set(chat.id, st);
      sse(chat.id, { type: "harness", subtype: "background", ...st });
    };
    // Tick for the LIVE numbers of a native subagent. Without it the server reports only at sign-of-life points
    // (start, end) — the display would show the start number until the end, and a rate (tokens/minute) cannot be
    // computed from a single measuring point. It runs ONLY while a native subagent lives and sends only on a real
    // change: two equal measuring points are worthless for a rate and would smooth it artificially.
    const AGENT_TICK_MS = Number(process.env.CBASE_AGENT_TICK_MS) || 2_000;
    let agentTickMarker = "";
    const armAgentTick = () => {
      if (agentTickTimer || !agentController?.liveCount()) return;
      agentTickTimer = setInterval(() => {
        if (!agentController?.liveCount()) return clearAgentTick();
        const marker = tickMarker(nativeAgentRows());
        if (marker === agentTickMarker) return;
        agentTickMarker = marker;
        publishBackground();
      }, AGENT_TICK_MS);
      agentTickTimer.unref?.();
    };
    const setWaiting = (w) => {
      const what = runWaiting.has(chat.id);
      if (w === what) {
        if (w) runWaiting.set(chat.id, waitingState()); // keep the list current
        return;
      }
      if (w) runWaiting.set(chat.id, waitingState());
      else { runWaiting.delete(chat.id); clearDrain(); } // the deadline only applies while idle
      sse(chat.id, { type: "harness", subtype: w ? "run_waiting" : "run_busy", ...waitingState() });
    };
    const monitorRow = (event, m, status) => {
      const row = { event, taskId: m.taskId, description: m.description || "", ...(status ? { status } : {}) };
      store.addMessage(chat.id, "monitor", JSON.stringify(row));
      sse(chat.id, { type: "harness", subtype: "monitor", ...row });
    };
    // The monitors' events (cbase_monitor) are delivered by their owner per CHAT via the wake path (runs/monitors.js)
    // — this turn does not inject them itself and does not stay open for them.
    let yielded = false; // this process accepts no new turn any more (waitPhaseYield, below)

    // Reports of finished SUBAGENTS (cbase_agent) that no waiting call picked up: a background agent or one whose
    // foreground waiting time expired. The report is injected into the running process as a new turn — the provider
    // knows nothing of these subagents, so the server ALWAYS delivers them.
    const injectPendingAgents = () => {
      if (!agentController?.reportsOpen() || yielded) return false;
      const child = runChildren.get(chat.id);
      if (typeof child?.cbaseInject !== "function") return false;
      const batch = agentController.takeReports();
      if (!child.cbaseInject(agentController.reportText(batch))) {
        agentController.createBack(batch);
        return false;
      }
      turnBegins(chat.id, [{ cause: "agent" }]); // a new turn, without human input
      setWaiting(false);
      return true;
    };

    // ── Deliver the scheduled continuation (ScheduleWakeup) ───────────────────────
    // The Claude CLI OFFERS the tool in every chat but wakes itself only in `/loop` operation. In a normal chat the
    // agent would set a wakeup, cbase would hold stdin open until the wake time — and then NOTHING would happen until
    // the deadline expired and the run ended silently. Hence the server delivers the continuation itself for native
    // CLIs (the same injection as for subagent reports). The loop engine brings its own wakeup (providers/engine.js) —
    // NOT again there, otherwise two turns.
    // The NATIVE wakeup (cbase_wakeup) does not go through this run: it belongs to the CHAT (runs/wakeup.js) and wakes
    // it via the wake path as a new turn — this run only reports it (waitingState) and holds nothing open for it.
    // What stays here is the provider's own wakeup (blocked).
    const wakeupSelf = ownsLoop;
    // Buffer so that a provider that does wake on its own goes first: its `system/init` sets wakeupAt to 0, and then
    // this path finds nothing. (Can be shortened for tests, like BG_TASK_IDLE_MS.)
    const WAKEUP_SELF_DELAY_MS = Number(process.env.CBASE_WAKEUP_SELF_DELAY_MS) || 3_000;
    const wakeupRelease = () => { wakeupAt = 0; wakeupPrompt = ""; wakeupReason = ""; clearWakeupTimer(); };
    const injectWakeup = () => {
      if (!wakeupAt || yielded) return false;
      const child = runChildren.get(chat.id);
      if (typeof child?.cbaseInject !== "function") return false;
      const text = wakeupPrompt.trim()
        ? `[Scheduled continuation]\n${wakeupPrompt.trim()}`
        : "[Scheduled continuation — the deadline you set has passed. Carry on.]";
      // The chat stands elsewhere — the continuation becomes the next turn THERE, not a new one in this process.
      if (turnInstanceDifferent(chat.id)) { wakeupRelease(); publishBackground(); return inNewInstance(text); }
      if (!child.cbaseInject(text)) return false;
      turnBegins(chat.id, [{ cause: "wakeup" }]); // a new turn, without human input
      wakeupRelease();
      bgIdleUntil = 0;
      publishBackground();
      setWaiting(false);
      return true;
    };
    // Is the wake time reached while the agent still works? Then no injection is needed — it is awake. The wakeup is
    // redeemed only at the turn end.
    const wakeupDue = () => Boolean(wakeupAt) && wakeupAt <= Date.now() + 1_000;
    const armWakeup = () => {
      clearWakeupTimer();
      if (!wakeupSelf || !wakeupAt) return;
      const ms = Math.max(0, wakeupAt + WAKEUP_SELF_DELAY_MS - Date.now());
      wakeupTimer = setTimeout(() => {
        wakeupTimer = null;
        // Deliver only in the waiting phase itself: if a turn runs, the result branch decides.
        if (runWaiting.has(chat.id)) injectWakeup();
      }, ms);
      wakeupTimer.unref?.();
    };

    // When the last background agent has finished, the CLI begins its follow-up turn within fractions of a second
    // (measured: ~100 ms to the init). If it fails to appear, the run must not hang forever — then stdin is closed
    // after this deadline after all. It often fails to appear: if the CLI uses the report within the running turn, no
    // further one follows. (Can be shortened for tests, like BG_TASK_IDLE_MS.)
    const AGENT_DRAIN_MS = Number(process.env.CBASE_AGENT_DRAIN_MS) || 30_000;
    // Background Bash without an end (dev server, `tail -f`) must not bind a chat forever. After this idle time
    // WITHOUT a new turn it is closed anyway. The counter restarts with every turn — an agent doing something in
    // between does not lose the deadline.
    const BG_TASK_IDLE_MS = Number(process.env.CBASE_BG_TASK_IDLE_MS) || 10 * 60_000;
    // Buffer on the scheduled wake time (rounding to the full minute + start-up time of the turn).
    const WAKEUP_GRACE_MS = 45_000;
    // Cron: surcharge on the firing time. The CLI jitters on purpose (by its own description: recurring jobs up to
    // 10 % of the period late, at most 15 min; one-shot ones on :00/:30 up to 90 s early). Too early is harmless —
    // too late costs the job.
    const CRON_GRACE_MS = 90_000;
    // How far into the future a cron job may hold the run open. Without a cap "0 9 * * 1" (Mondays) would bind a CLI
    // process for a whole week. Daily jobs fit.
    const CRON_MAX_HOLD_MS = Number(process.env.CBASE_CRON_MAX_HOLD_MS) || 24 * 3600_000;
    // A job counts as fired as soon as a new turn begins and its time (including forward jitter) is reached. One-shot
    // ones then disappear, recurring ones move on.
    const CRON_FIRE_SLACK_MS = 120_000;
    const cronScroll = (now = Date.now()) => {
      let changed = false;
      for (const [key, job] of crons) {
        if (!job.nextAt || job.nextAt > now + CRON_FIRE_SLACK_MS) continue;
        changed = true;
        if (!job.recurring) { crons.delete(key); continue; }
        job.nextAt = nextCronAt(job.expr, now);
        if (!job.nextAt) crons.delete(key);
      }
      return changed;
    };
    const cronHoldUntil = (now = Date.now()) => {
      let until = 0;
      for (const job of crons.values()) {
        if (!job.nextAt || job.nextAt - now > CRON_MAX_HOLD_MS) continue;
        until = Math.max(until, job.nextAt + job.grace);
      }
      return until;
    };
    // Turn bookkeeping, kept SYNCHRONOUSLY. The decision at the result runs as a microtask; if the CLI sends its
    // output in one go (the normal case locally), ALL events are already processed by then. Snapshots of the waiting
    // state lie then — counters do not.
    let resultsSeen = 0;      // completed turns
    let turnActive = true;    // is a turn running right now? (the first begins with the prompt)
    let agentOwedResults = 0; // up to which turn count an agent's report is outstanding
    let agentDrainUntil = 0;  // ABSOLUTE deadline for it (see holdMs) — otherwise it extends endlessly
    // How long stdin must stay open after this turn. Infinity = unlimited (something demonstrably still runs), 0 = no
    // reason left, otherwise the remaining deadline in ms. All deadlines are stored ABSOLUTE (bgIdleUntil, wakeupAt)
    // so recomputing at expiry does not extend endlessly.
    const holdMs = () => {
      if (monitors.size) return Infinity;
      // The native subagents hold only if the run kind says so (runs/hooks.js `hold`).
      if (holdAgents && (agentController?.liveCount() || agentController?.reportsOpen())) return Infinity;
      // The second kind: a running dynamic workflow OF THE STEP holds a holding turn too — asked at the ONE query
      // (runs/background.js), not at the core: the workflow lives outside every turn, and its completion notice
      // arrives in this turn via the wake path (waiting phase). A workflow from an earlier message does not hold
      // (`step` false).
      if (holdAgents && backgroundWork(chat.id).some((h) => h.kind === "dynworkflow" && h.step)) return Infinity;
      let ms = 0;
      // ABSOLUTE, not relative: with "ms = AGENT_DRAIN_MS" every recomputation would extend the deadline by another
      // 30 s (armDrain recomputes at expiry) — the run would NEVER expire. If the CLI uses a background agent's report
      // WITHIN the running turn, no further turn follows, so the debt is never redeemed → the chat would stay
      // "running" forever (composer locked, claude process open).
      if (agentOwedResults > resultsSeen && agentDrainUntil) ms = Math.max(ms, agentDrainUntil - Date.now());
      if (bgTasks.size) {
        if (!bgIdleUntil) bgIdleUntil = Date.now() + BG_TASK_IDLE_MS;
        ms = Math.max(ms, bgIdleUntil - Date.now());
      }
      if (wakeupAt) ms = Math.max(ms, wakeupAt + WAKEUP_GRACE_MS - Date.now());
      const cronUntil = cronHoldUntil();
      if (cronUntil) ms = Math.max(ms, cronUntil - Date.now());
      return ms;
    };
    const clearDrain = () => {
      if (!drainTimer) return;
      clearTimeout(drainTimer);
      drainTimer = null;
    };
    const armDrain = (ms) => {
      clearDrain();
      if (!Number.isFinite(ms)) return; // unlimited — something still runs
      drainTimer = setTimeout(() => {
        drainTimer = null;
        const again = holdMs(); // a new reason by now? (fresh task, new wakeup)
        if (again > 0) return armDrain(again);
        if (agentController?.reportsOpen() && injectPendingAgents()) return;
        agentOwedResults = 0;
        agentDrainUntil = 0;
        const child = runChildren.get(chat.id);
        if (typeof child?.cbaseEndInput === "function") child.cbaseEndInput();
      }, ms);
      drainTimer.unref?.();
    };
    // If the chat stands in ANOTHER instance than this turn (turnInstanceDifferent) and an input waits, the waiting
    // phase ends: stdin closed, the finally starts the queue there. Why, what falls, the boundary (holding):
    // runs/wait-phase-yield.js. Called at the `result`, from queue.js deliverUserPrompt (runWaitPhaseYield) and from
    // `inNewInstance`.
    waitPhaseYield = () => {
      if (yielded) return true;
      if (!(pendingRunInputs.get(chat.id) || []).length || !turnInstanceDifferent(chat.id)) return false;
      if (holdAgents && (agentController?.liveCount() || agentController?.reportsOpen())) return false;
      const child = runChildren.get(chat.id);
      if (typeof child?.cbaseEndInput !== "function") return false;
      yielded = true;
      const text = yieldNotice({ identifier: turnIdentifier(chat.id), wakeup: wakeupAt ? { clock: clockText(wakeupAt), prompt: wakeupPrompt } : null,
        crons: [...crons.values()], monitors: [...monitors.values()], bgTasks: [...bgTasks.values()] });
      if (text) {
        try { store.addMessage(chat.id, "hint", text); } catch (e) { console.error("[instance] yield notice:", e?.message || e); }
        depositHint(chat.id, text, { source: "instance-switch" });
      }
      wakeupRelease(); clearDrain(); publishBackground(); setWaiting(false);
      console.log(`[instance] ${chat.id}: the chat stands in another instance than its turn (${turnIdentifier(chat.id) || "?"}) — the waiting phase ends, the queue runs there`);
      child.cbaseEndInput();
      return true;
    };
    const queueEntry = (prompt) => enqueueRunInput(chat.id, {
      id: randomUUID(), prompt, display: prompt, attachments: [], cause: "event", causeSpecified: "event", silent: true,
    });
    // A continuation this process may no longer begin: into the queue, then the yield. `false` = not injected.
    const inNewInstance = (prompt) => { queueEntry(prompt); waitPhaseYield(); return false; };
    runWaitPhaseYield.set(chat.id, waitPhaseYield);
    // A finished background task (agent, Bash OR monitor) is evaluated by the CLI in a turn of its own. If one runs
    // right now, that is the result AFTER the next; if it is already idle, the next. Until then stdin stays open —
    // otherwise exactly this follow-up turn is cut off.
    const owedFollowUpTurn = () => {
      agentOwedResults = Math.max(agentOwedResults, resultsSeen + (turnActive ? 2 : 1));
      agentDrainUntil = Date.now() + AGENT_DRAIN_MS; // fresh event → fresh deadline
      if (!runWaiting.has(chat.id)) return; // mid-turn — the result decides shortly
      runWaiting.set(chat.id, waitingState());
      sse(chat.id, { type: "harness", subtype: "run_waiting", ...waitingState() });
      armDrain(holdMs());
    };
    // If a dynamic workflow ends without a completion notice (stop), the waiting phase asks anew — like a silently
    // ended last monitor: otherwise holdMs would keep it open forever. With a completion notice the waiting phase is
    // already over (the notice was taken in), then the observer does nothing.
    backgroundUnregister = observeBackground(chat.id, () => {
      if (!runWaiting.has(chat.id)) return;
      const hold = holdMs();
      if (hold > 0) {
        runWaiting.set(chat.id, waitingState());
        armDrain(hold);
      } else {
        const child = runChildren.get(chat.id);
        if (typeof child?.cbaseEndInput === "function") child.cbaseEndInput();
      }
    });
    const dropBackground = (map, taskId) => {
      if (!map.delete(taskId)) return;
      publishBackground(); // mid-turn too: the display must get rid of the agent again
      owedFollowUpTurn();
    };

    providerMonitorStart = async (args, meta = {}) => {
      let inputArgs = args || {};
      // The completion engine has already passed the permission gate. MCP calls from native CLIs are gated here
      // because the started shell watch runs outside the Codex sandbox.
      if (!meta.permissionChecked) {
        if (permissionMode === "plan") throw new Error("Monitor is not allowed in plan mode.");
        if (permissionMode !== "bypassPermissions") {
          const dec = await requestPermission(chat.id, { toolName: "Monitor", input: inputArgs, toolUseId: meta.toolUseId || null });
          if (!dec || dec.behavior !== "allow") throw new Error(dec?.message || "Monitor declined by the user.");
          inputArgs = dec.updatedInput ?? inputArgs;
        }
      }
      // The monitor belongs to the CHAT (runs/monitors.js): it starts with cwd and instance of THIS turn (in the
      // instance's project container), writes into the output location at this turn's location and wakes the chat via
      // the ONE wake path — also after this turn's end.
      const task = startMonitor(chat.id, inputArgs, {
        cwd, env: process.env, instance, meta,
        outputLocation: createOutputLocation(chat.id, runLocation || undefined),
        deliver: (text) => deliverUserPrompt(store.getChat(chat.id) || chat, { prompt: text, display: text, cause: "agent" }),
      });
      return { ...task, task_id: task.taskId, timeout_ms: task.timeoutMs };
    };
    providerMonitorStop = (taskId) => stopMonitor(chat.id, taskId, { through: "agent" });
    providerMonitorController = {
      start: (args, meta) => providerMonitorStart(args, meta),
      stop: (taskId) => providerMonitorStop(taskId),
      // The monitors are not closed with the turn — they live on in the chat.
      close: () => {},
    };
    runMonitorControllers.set(chat.id, providerMonitorController);

    // ── Subagents: the native agent tool (cbase_agent) ─────────────────────────
    // The core (providers/agent-runtime.js) drives EVERY subagent as a run of its own via the provider registry —
    // every model may start any other as a subagent. Owner, spec factory and event sink are in runs/agents.js; the run
    // only passes its context in EXPLICITLY and keeps what only it knows: keeping open, tick, display, delivery and
    // the limit evidence (the addendum to the call block runs through handleRunEvent).
    agentController = openAgents(agentContext({
      chat, cwd, providerId, agentDefsRaw, preparation, addDirs, extraServers, runSkills, runtime: runLocation, instance,
      // Lifetime: does this turn hold its agents? See agentContext.
      hold: holdAgents,
      // The assignment of the consumption rows: from the run's start, as for the main run (usageRun). Booked per agent IMMEDIATELY.
      booking: { chatId: chat.id, ...usageRun },
      // Credit gate: the core asks it before every subagent start; this turn's "start anyway" applies to its subagents
      // — as an argument, not as a marker.
      overruled,
    }), {
      // Since when this turn's work has been running (also across the resume retry) — for the "layout" lock.
      since: turnSince,
      event: (evt) => handleRunEvent(evt),
      background: () => publishBackground(),
      atStart: () => { if (holdAgents) clearDrain(); armAgentTick(); publishBackground(); },
      // Foreground → background: the row loses its `foreground` marker — report immediately.
      atSwitch: () => publishBackground(),
      atEnd: (rec, info, { wasLive }) => {
        // NOT dropBackground: that always owes a follow-up turn. If the caller already got the report inline
        // (foreground agent), none follows — with the debt the run would then stand open for the full 30 s.
        if (wasLive) {
          if (!agentController.liveCount()) clearAgentTick();
          publishBackground();
          // Only if this turn holds its agents does it owe a follow-up turn — otherwise the wake path delivers.
          if (!info.delivered && holdAgents) owedFollowUpTurn();
        }
        if (agentController.reportsOpen() && runWaiting.has(chat.id)) injectPendingAgents();
      },
    });

    // The provider-neutral wakeup (cbase_wakeup) belongs to the CHAT (runs/wakeup.js); the route `POST …/wakeup`
    // sets it there. This turn does not hold its process open for it.

    const inputIds = []; // this run's input rows (see handleRunEvent) — a retry takes them back
    const handleRunSpawn = (child) => {
      runChildren.set(chat.id, child);
      // If the abort came before the spawn (race), end immediately.
      if (abortedRuns.has(chat.id)) { try { child.kill("SIGTERM"); } catch {} }
    };
    // Named instead of inline (and as a function DECLARATION, hence hoisted): the subagent core is created above but
    // mirrors the events of ITS runs through exactly this processing. Persistence, nesting under the call and
    // consumption counting thereby arise in ONE place — the same for main agent and subagents.
    function handleRunEvent(evt) {
      // Subagent events carry the id of their task call (parent). They are persisted with this marker (the app renders
      // them nested) and NOT counted into the CONTEXT display — but into CONSUMPTION, hence the counter sees every event.
      // Wrapped because this line runs first in EVERY event of EVERY chat: an exception here would not lose the count
      // but choke the chat's rendering. The counter is checked against incomplete events — the bracket is the second safeguard.
      try { tally.observe(evt); } catch { /* tracking must never disturb a run */ }
      const parentId = evt.parent_tool_use_id ?? null;
      // The provider compacted the session: the next user turn in THIS process (the queue handover) carries nothing of
      // the session's beginning any more — and for Claude and Codex neither does the next run resuming it (the hint,
      // runs/hints.js). The loop engine only compacts its messages in memory: its next run rebuilds the lookback from
      // the DB, and whether that carries the beginning is said there by `beginningPreserved`. The event itself goes on
      // to the clients.
      if (isProviderCompaction(evt)) { runCompacted.add(chat.id); if (ownsLoop) earmarkCompaction(chat.id); }
      // The wording of a user message as the loop engine sent it out (providers/engine.js): as an input row — model
      // context the next run reproduces byte-identically (providers/transcript.js); the clients do not see it
      // (store/chats.js listMessages) and get no event either. `beginning`: this run's first input, if it carried the
      // preambles from the session's beginning (see `preambleResumed`).
      if (evt.type === "cbase_input") {
        if (!parentId && typeof evt.text === "string") {
          try {
            const row = store.addMessage(chat.id, "input", JSON.stringify({ text: evt.text, beginning: !inputIds.length && !preambleResumed }));
            if (row) inputIds.push(row);
          } catch (e) { console.error("[run] input not stored:", e?.message || e); }
        }
        return;
      }
      if (evt.type === "assistant") {
        const u = evt.message?.usage;
        if (u && !parentId) {
          ctxIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          bumpContext();
        }
        for (const blk of evt.message?.content ?? []) {
          if (blk.type === "text" && blk.text?.trim()) {
            // Text of a SUBAGENT is not this chat's main text — it belongs under its call block, like thinking blocks
            // and tool calls. Without the second row it would stand live in the fold and be gone after a reload. Own
            // role, because an `assistant` row is pure text WITHOUT a parent; older clients skip it.
            if (!parentId) {
              store.addMessage(chat.id, "assistant", blk.text);
              persistedText = true;
              // The block now stands in the history — the buffer would otherwise have it a second time.
              runStreamText.delete(chat.id);
              modelSwitchReport(blk.text);
            }
            else store.addMessage(chat.id, "sub_text", JSON.stringify({ text: String(blk.text).slice(0, 12000), parent: parentId }));
          } else if (blk.type === "thinking" && blk.thinking?.trim()) {
            store.addMessage(chat.id, "thinking", JSON.stringify({ text: String(blk.thinking).slice(0, 12000), parent: parentId }));
          } else if (blk.type === "tool_use") {
            // Native subagents (cbase_agent): their events are rendered nested under THIS call. Claude and the engine
            // name the id themselves at the start (MCP `_meta`); for Codex the open block decides (runs/call-blocks.js).
            if (SUBAGENT_TOOLS.has(blk.name)) subagentUses.add(blk.id);
            if (blk.name === "mcp__cbase__cbase_agent") agentController?.blockOpen(blk.id, blk.input, parentId);
            if (blk.name === "Monitor") monitorUses.add(blk.id);
            else if (blk.name === "Bash" && blk.input?.run_in_background) {
              bashUses.set(blk.id, String(blk.input?.description || blk.input?.command || "").slice(0, 160));
            } else if (blk.name === "ScheduleWakeup") {
              wakeupAt = wakeupFor(blk.input, { round: ownsLoop });
              wakeupPrompt = wakeupAt ? String(blk.input?.prompt || "") : "";
              wakeupReason = wakeupAt ? String(blk.input?.reason || "").slice(0, 300) : "";
              // Report immediately, not only in the waiting phase: "the agent has set a wakeup" belongs above the
              // input field the moment it does so.
              armWakeup();
              publishBackground();
            } else if (blk.name === "CronCreate") {
              const expr = String(blk.input?.cron || "");
              const nextAt = nextCronAt(expr);
              // An expression we do not understand does NOT silently become a reason to hold: then the run ends
              // instead of standing open up to the cap.
              if (nextAt) {
                const recurring = blk.input?.recurring !== false;
                const period = recurring ? cronPeriodMs(expr) : 0;
                crons.set(blk.id, {
                  jobId: "", expr, prompt: String(blk.input?.prompt || ""), recurring, nextAt,
                  grace: CRON_GRACE_MS + Math.min(15 * 60_000, Math.round(period * 0.1)),
                });
                publishBackground();
              } else {
                console.log(`[cron] ${chat.id}: expression "${expr}" not understood — no reason to hold`);
              }
            } else if (blk.name === "CronDelete") {
              const id = String(blk.input?.id || "");
              for (const [key, job] of crons) if (job.jobId && job.jobId === id) crons.delete(key);
              publishBackground();
            }
            store.addMessage(chat.id, "tool", JSON.stringify({ name: blk.name, detail: toolDetail(blk.input), id: blk.id, input: boundToolInput(blk.input), parent: parentId }));
          }
        }
        // Only the MAIN STREAM ends the waiting phase. A background agent keeps sending assistant events of its own
        // during the waiting phase — they must not force the composer back into the queue, for the main agent is
        // responsive (injection via /message).
        if (!parentId) {
          turnActive = true;
          // A due wake time is redeemed with this turn. For the CLI `system/init` does that; the loop engine reports
          // init only ONCE and delivers the continuation itself — without this line the expired wake time would keep
          // the run open.
          if (wakeupAt && wakeupAt <= Date.now()) { wakeupAt = 0; wakeupPrompt = ""; wakeupReason = ""; clearWakeupTimer(); bgIdleUntil = 0; publishBackground(); }
          setWaiting(false); // the model works again
        }
      } else if (evt.type === "user") {
        // tool_result: persist the tool's output, linked by tool_use_id.
        for (const blk of evt.message?.content ?? []) {
          if (blk?.type === "tool_result" && blk.tool_use_id) {
            const result = boundResult(blk.content);
            store.addMessage(chat.id, "tool_result", JSON.stringify({ id: blk.tool_use_id, result, isError: Boolean(blk.is_error) }));
            // A cbase_agent block closes: its result names the agentId (confirmation).
            if (subagentUses.has(blk.tool_use_id)) agentController?.blockTo(blk.tool_use_id, blk.content, parentId);
            // A cron job's job id is only in the result ("Scheduled one-shot task f8667939 (42 19 21 8 *) …") —
            // without it a later CronDelete could not be assigned. The call itself is remembered under its tool_use id.
            const cronJob = crons.get(blk.tool_use_id);
            if (cronJob && !cronJob.jobId) {
              const m = /\btask\s+([\w-]{4,})/.exec(result);
              if (m) cronJob.jobId = m[1];
            }
          }
        }
      } else if (evt.type === "stream_event" && evt.event?.type === "message_start") {
        // New API call of the main stream: bank the output so far, take over the input side.
        if (!parentId) {
          if (!evt.event.onlyContext) runOutBase = runOut; // onlyContext (Codex): only the last call, see usage-tally.js
          const u = evt.event.message?.usage;
          if (u) { ctxIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); bumpContext(); }
          // The provider behind the router (only the loop engine reports it, see upstreamReport) — display only.
          const provider = evt.event.message?.provider;
          if (typeof provider === "string" && provider.trim()) upstreamReport(provider.trim());
        }
      } else if (evt.type === "stream_event" && evt.event?.type === "consumption" && !parentId) {
        const n = Number(evt.event.usage?.output_tokens) || 0; runOut += n; countMainOutput(chat.id, n); // Codex: the turn
      } else if (evt.type === "stream_event" && evt.event?.type === "content_block_delta"
        && evt.event.delta?.type === "text_delta" && !parentId) {
        // Only the MAIN STREAM: a subagent's text belongs under its call block, not in this chat's answer bubble (the
        // same separation as when persisting).
        const soFar = runStreamText.get(chat.id) || "";
        if (soFar.length < RUN_STREAM_MAX) runStreamText.set(chat.id, soFar + String(evt.event.delta.text || ""));
      } else if (evt.type === "stream_event" && evt.event?.type === "message_delta" && evt.event.usage?.output_tokens) {
        if (!parentId) {
          lastOut = evt.event.usage.output_tokens;
          const runOutPrior = runOut;
          if (!evt.event.onlyContext) runOut = runOutBase + evt.event.usage.output_tokens; // cumulative per API call
          // The increase belongs to the running turn — the "+500k" budget reads it next to the workflow agents.
          countMainOutput(chat.id, runOut - runOutPrior);
          bumpContext();
        }
      } else if (evt.type === "system") {
        // Lifecycle of the Claude CLI's background tasks. Which tool_use started the task decides how it is treated:
        // monitor (history rows), background agent, background Bash — all three keep the run open, only for different
        // lengths of time.
        if (evt.subtype === "init" && !parentId) {
          rememberTurnSession(chat.id, { session: evt.session_id, provider: providerId, model: spec.model || "" }); // late booking after a crash
          // New turn: the scheduled continuation is redeemed and the idle clock of the background commands starts over.
          // Every new turn redeems the PROVIDER'S OWN wakeup (if the provider does wake itself, the timer must find
          // nothing afterwards). The native one (cbase_wakeup) stands at the chat (runs/wakeup.js) — so a turn for
          // another reason cannot swallow it.
          const wakeupRedeemed = Boolean(wakeupAt);
          if (wakeupRedeemed) {
            wakeupAt = 0;
            wakeupPrompt = "";
            wakeupReason = "";
            clearWakeupTimer();
          }
          bgIdleUntil = 0;
          // For a due cron job a new turn IS its firing (the CLI starts it on its own). Move on only here, not at the
          // first assistant event: if the agent works when the time is reached, the CLI fires afterwards — and the job
          // must stay a reason to hold for that long.
          const cronMoved = cronScroll();
          if (wakeupRedeemed || cronMoved) publishBackground(); // the wakeup display must disappear
        } else if (evt.subtype === "task_started" && monitorUses.has(evt.tool_use_id)) {
          const m = { taskId: evt.task_id, description: String(evt.description || "") };
          monitors.set(evt.task_id, m);
          monitorRow("started", m);
          publishBackground();
        } else if (evt.subtype === "task_started" && bashUses.has(evt.tool_use_id)) {
          bgTasks.set(evt.task_id, {
            taskId: evt.task_id,
            description: String(evt.description || bashUses.get(evt.tool_use_id) || ""),
          });
          bgIdleUntil = 0; // fresh command → new idle deadline
          clearDrain();
          publishBackground();
        } else if (evt.subtype === "task_updated" && bgTasks.has(evt.task_id)) {
          const st = evt.patch?.status;
          if (st && st !== "running") dropBackground(bgTasks, evt.task_id);
        } else if (evt.subtype === "task_notification" && monitors.has(evt.task_id)) {
          // A persistent monitor fired but keeps running (ended tasks were already removed by task_updated — the
          // "done" row arises there).
          monitorRow("fired", monitors.get(evt.task_id), evt.status);
        } else if (evt.subtype === "task_updated" && monitors.has(evt.task_id)) {
          const st = evt.patch?.status;
          if (st && st !== "running") {
            const m = monitors.get(evt.task_id);
            monitors.delete(evt.task_id);
            monitorRow("done", m, st);
            publishBackground();
            // An ENDING monitor is evaluated by the CLI in a follow-up turn of its own too (task_notification + turn
            // follow even for a silently dying command, exit 1 without output). Without this debt the result closed
            // stdin when the monitor died MID-turn — the delivery was cut off and the user waited in vain for the
            // report.
            owedFollowUpTurn();
          }
        } else if (evt.subtype === "background_tasks_changed" && (monitors.size || bgTasks.size)) {
          // Authoritative actual list: remove vanished monitors. The "done" row arises HERE — this event comes before
          // task_updated (which then no longer finds the task and reports nothing twice). The same holds for
          // background agents.
          const alive = new Set((evt.tasks || []).map((tk) => tk.task_id));
          let monitorsChanged = false;
          for (const id of [...monitors.keys()]) {
            if (alive.has(id)) continue;
            const mdone = monitors.get(id);
            monitors.delete(id);
            monitorRow("done", mdone);
            monitorsChanged = true;
          }
          // `alive` is THE CLI's actual list — a cbase agentId is never in it; the subagents are led by their owner
          // (runs/agents.js), otherwise every background_tasks_changed would clear them away with their running work.
          for (const id of [...bgTasks.keys()]) if (!alive.has(id)) dropBackground(bgTasks, id);
          // Vanished monitors: the same debt as at the task_updated end (see above). That also covers the silent death
          // in the WAITING PHASE — there no timer was set with armDrain(Infinity), nothing recomputed after the
          // vanishing, and the chat would hang on "running" forever. With the debt the agent deadline runs and closes
          // the run in an orderly way.
          if (monitorsChanged) { publishBackground(); owedFollowUpTurn(); }
        }
      } else if (evt.type === "result") {
        resultsSeen += 1;
        turnActive = false;
        // A turn marked as an error: that too can survive the process (the CLI concludes the turn and waits for the
        // next input). Keep the text for the limit check.
        // Three forms of the wording: the loop engine writes `error.message`; the ERROR variant of the Claude CLI
        // (`subtype` begins with `error`: error_during_execution, error_max_turns, …) carries neither `result` nor
        // `error` but `errors: string[]`; only its success variant with `is_error` puts the text in `result`. Whoever
        // does not read `errors` sees a limit under exit 0 as an empty error — and the check at the run end has no
        // evidence for parking. The subtype is the second safeguard in case a build writes one without the other.
        if (evt.is_error || String(evt.subtype || "").startsWith("error")) {
          const errors = Array.isArray(evt.errors) ? evt.errors.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).join("\n") : "";
          const t = String(evt.error?.message || evt.error || errors || evt.result || "").trim();
          if (t) limitEvidence.push(t.slice(0, 2000));
        }
        // The switch wording can stand here too (and not only as answer text) — both are checked, thanks to
        // `modelSwitchReported` it is still reported only once.
        modelSwitchReport(String(evt.result || evt.error?.message || ""));
        // Turn over. The continuation decision runs as a microtask so the result event arrives at the client first
        // and can conclude the old assistant bubble there. Then: explicit user queue → subagent report → waiting
        // phase → end the run. This handover point is ready to receive for Claude, Codex and the completion engine.
        queueMicrotask(() => {
          const child = runChildren.get(chat.id);
          if (typeof child?.cbaseEndInput !== "function") return;
          // If the chat now stands in another instance and an input waits, no turn begins here any more (see there).
          if (waitPhaseYield()) return;
          // A run released via "start anyway" does NOT take the queue into its process: this one turn is released.
          // What waits behind it is started by the finally as a run of its own (takeNextRunInput ⇒ doRun), and that
          // asks the gate itself. Without this line both jobs would run in ONE pid, the second without a gate row and
          // without a waiting row — one click on "costs credit" would silently release everything behind the row.
          if (!runOverruled.has(chat.id) && injectNextRunInput(chat.id)) {
            setWaiting(false);
          } else if (agentController?.reportsOpen() && injectPendingAgents()) {
            // A subagent's report — injectPendingAgents has already sent run_busy.
          } else if (wakeupSelf && wakeupDue() && injectWakeup()) {
            // The wake time passed during the turn — continue right now instead of ending the run (injectWakeup has
            // already sent run_busy).
          } else {
            // Is there still a reason to continue — a running monitor/agent/command, an outstanding completion notice
            // or a scheduled continuation? Then stdin stays open, otherwise the CLI ends itself.
            const hold = holdMs();
            if (hold > 0) { setWaiting(true); armDrain(hold); armWakeup(); }
            else child.cbaseEndInput();
          }
        });
      }
      sse(chat.id, evt);
    }

    const res = await runChat({ providerId, spec, onSpawn: handleRunSpawn, onEvent: handleRunEvent });
    const ctxTokens = ctxIn + lastOut;
    const aborted = abortedRuns.delete(chat.id); // aborted on purpose?
    runAborted = aborted;

    // Consumption tracking (runs/booking.js: engine ⇒ `metered` per part, CLI ⇒ `subscription` from the tally, the
    // cache separately). DELIBERATELY RUNS NEXT TO THE CRITICAL PATH (setImmediate): this is the same point at which
    // the workflow driver decides on the next step. Hooked in synchronously, tracking delayed the transition so far
    // that the round cap occasionally took effect one round too late. The numbers are fixed here anyway; writing them
    // one event loop later changes nothing about them but keeps the run free. The workflow assignment comes from the
    // RUN'S START (usageRun).
    const usageAt = { chatId: chat.id, ...usageRun, secs: Math.max(1, Math.round((Date.now() - runStart) / 1000)) };
    setImmediate(() => bookTurn({ assignment: usageAt, res, tally, providerId, model: spec.model || "", runBegin: activeStartedAt }));

    // The server ends: the gateway sets the marker before stopping the project containers, endServer its own. If the
    // CLI dies NOW without a result, it died from the stop — that is no loss of the session. Reading it as "session
    // gone" would delete the session, restart the turn without memory into the container just stopped, fail at once,
    // clear the active_runs row, and nobody would continue the turn after the container's replacement. Hence: session
    // and row stay, a hint row says so, and resumeInterruptedWork continues the turn in the new process.
    // A false alarm of the foreign marker costs at most the continuation of this turn at the next start.
    if (!aborted && res.code !== 0 && res.resultText === null && serverEnds()) {
      atServerEnd = true;
      store.addMessage(chat.id, "hint", T("The turn was interrupted by a server restart — it will continue after the start."));
      sse(chat.id, { type: "harness", subtype: "run_interrupted_server_end" });
      console.warn(`[run] ${chat.id}: turn interrupted at the server end (exit ${res.code}) — active_runs stays for the restart`);
      return;
    }
    if (!aborted && res.code !== 0 && useResume && res.resultText === null) {
      // Session gone (e.g. after a migration) → retry once without resume.
      store.updateChat(chat.id, { claudeSessionId: null });
      // The failed attempt's input goes out once more — the lookback then has it once, not twice.
      if (inputIds.length) { try { store.deleteInputs(chat.id, inputIds); } catch { /* the lookback then shows it twice */ } }
      sse(chat.id, { type: "harness", subtype: "resume_failed_retrying" });
      // In the project container: the loss is visible, as a hint row in the history — the turn continues.
      if (inContainer) store.addMessage(chat.id, "hint", sessionLostText(chat.claudeSessionId));
      running.delete(chat.id);
      // The recursive call sends its own run-true/false broadcasts and from here owns `running` and `runOverruled`
      // (it enters both itself, the finally here leaves both). It does not ask its gate again (`noResume`): a retry
      // is the same turn.
      handedOff = true;
      // The preamble goes along — unless it was computed for the resumed session, which no longer exists: then the
      // retry computes it anew (without a session, hence with the full ultracode reminder; the counter starts anew anyway).
      return doRun({ ...chat, claudeSessionId: null }, text, { noResume: true, goalDepth, cause, overruled, resumption, inputs, turnPreambleText: preambleResumed ? null : turnPreambleText, turnBegin: turnSince });
    }
    if (aborted) {
      // Aborted on purpose: save the session (as far as known) so a follow-up prompt can continue; not an error but a
      // clean "aborted" signal. Blocks already streamed stay persisted.
      // If this turn carried the summary of the last compaction, it now stands in the saved session — it is brought
      // in as after a clean end. Otherwise it would stay at the chat, and the next start without a session (resume
      // retry, provider switch) would prepend it weeks later as the "conversation so far".
      if (res.sessionId) store.updateChat(chat.id, { claudeSessionId: res.sessionId, forkPending: 0, ...(injectSummary ? { contextSummary: "" } : {}), updatedAt: Date.now() });
      const runMeta = { secs: Math.max(1, Math.round((Date.now() - runStart) / 1000)), inTok: ctxIn, outTok: runOut, aborted: true };
      store.addMessage(chat.id, "meta", JSON.stringify(runMeta));
      sse(chat.id, { type: "harness", subtype: "run_aborted", meta: runMeta });
      // A deliberate abort ends the turn — the parked continuation is moot: fireAutoContinueInner pushed the row six
      // hours back at the start, and without this line it would fire the stopped job again after six hours. Only the
      // run row — a compaction or a verdict keep waiting.
      clearAwayRunRow(chat.id);
      // If the chat drives a workflow, the abort MUST arrive there (hook "afterRunFailed", consumer workflowRunFailed).
      // Without this line the run would stay on "running" with nobody driving it — and the next arbitrary user message
      // would run into workflowGateAfterRun, count as the open step's result and drive the whole rest of the workflow
      // through to "done".
      fireHooks("afterRunFailed", { chat, code: 0, aborted: true });
    } else if (res.code === 0) {
      // Code 0 means "process ended cleanly" — NOT "work done". If a subagent failed at the usage limit, the CLI
      // passes the error on to the main agent as a tool result; it writes a refusal and ends regularly. Without this
      // check the run would count as finished although the work never took place — and the waiting state would even
      // be deleted below. Strict: only an evidenced reset time counts here (requireReset), for unlike a process error
      // the limit is not proven by the failure itself.
      // BEFORE clearing the waiting row — it carries the attempt counter against endless loops.
      const parkedAfterOk = limitEvidence.length
        ? await maybeAutoContinue(chat, {
          providerId, res: { resultText: "", stderr: "" }, events: limitEvidence,
          prompt: text, goalDepth, attachments, requireReset: true,
          payload: cause !== "user" ? { cause } : null, resumption, cause,
        }).catch((e) => { console.error("[limit] check (subagent) failed:", e?.message || e); return false; })
        : false;
      // The run is through → a possible waiting state at the limit (including the attempt counter) is settled.
      // Only the run row: a parked compaction or a parked verdict wait for something else and stay.
      if (!parkedAfterOk) clearAwayRunRow(chat.id);
      store.updateChat(chat.id, { ...(res.sessionId ? { claudeSessionId: res.sessionId } : {}), ...(chat.forkPending ? { forkPending: 0 } : {}), ...(ctxTokens ? { contextTokens: ctxTokens } : {}), ...(injectSummary ? { contextSummary: "" } : {}), updatedAt: Date.now() });
      // The first confirmed turn at the new location — only now does the old copy of the session go.
      sessionConfirmed(sessionTransaction, res.sessionId);
      // Fallback: if no text came via assistant events (untypical), at least save the final result.
      if (!persistedText && res.resultText) store.addMessage(chat.id, "assistant", res.resultText);
      // Persist this run's duration + tokens (role='meta') → survives reload/tab switch and hangs on the answer as a
      // summary; the live display uses the same values (evt.meta).
      const runMeta = { secs: Math.max(1, Math.round((Date.now() - runStart) / 1000)), inTok: ctxIn, outTok: runOut };
      store.addMessage(chat.id, "meta", JSON.stringify(runMeta));
      // Parked means: the answer is incomplete. Then NO "answer ready" — the waiting row is the message, anything
      // else would be a promise the run did not keep.
      answered = !parkedAfterOk;
      runCleanEnded = !parkedAfterOk;
      scheduleParked = parkedAfterOk;
      scheduleResult = res.resultText || "";
      lastResponse = res.resultText || "";
      sse(chat.id, { type: "harness", subtype: "run_done", meta: runMeta });
      // Hook "afterRun": post-run curator, automatic chat title, workflow gate — in this registration order
      // (server.js), downstream, non-blocking. Curator and title WITH this turn's approval: both describe the turn
      // that just ran and start nothing new; a gate striking now (the window filled up during the turn) would
      // otherwise hold back the title of a chat released via "start anyway" forever. The verdicts (workflow gate,
      // target gate) do NOT get the approval — they decide on new model work, and exactly that is to be parked.
      // The gates move the chat on — exactly what a parked run must not do: they would start the next turn at once,
      // which fails at the same limit; after the reset the continuation triggers the same turn. If the chat drives a
      // workflow, its driver moves on (the "workflow-gate" consumer reads `parkedAfterOk`/`workflowRunning`),
      // otherwise the target gate below takes effect.
      // The workflow run's state is read ONCE, BEFORE the firing, and goes to both: if doRun read the state only
      // AFTER the firing, it would see what the synchronous part of workflowGateAfterRun set (waiting/failed) and
      // build the target gate on top.
      const workflowRunning = store.getWorkflowRun(chat.id)?.status === "running";
      fireHooks("afterRun", { chat, text, resultText: res.resultText, runStart, approval: true, parkedAfterOk, workflowRunning });
      if (parkedAfterOk) {
        console.log(`[limit] ${chat.id}: subagent at the limit — run parked despite code 0.`);
      } else if (!workflowRunning) {
        // Target gate (if /goal is set): the judge rules — "open" continues the run automatically (stop-hook
        // semantics of the harness), "reached" clears the target. Non-blocking — and only in the finally, behind the
        // compaction (see the declaration of target).
        target = { text, resultText: res.resultText, goalDepth };
      }
    } else {
      // The provider's usage limit? Then the run has not failed but is only slowed down: park and continue on its own
      // at the reset (see maybeAutoContinue). Only if that does not apply is it a real error.
      const parked = await maybeAutoContinue(chat, {
        providerId, res, prompt: text, goalDepth, attachments,
        payload: cause !== "user" ? { cause } : null, resumption, cause,
      }).catch((e) => { console.error("[limit] check failed:", e?.message || e); return false; });
      scheduleParked = Boolean(parked);
      if (!parked) {
        // Only the run row (see above) — and WITH an event to the clients, as in the code-0 branch: without
        // `limit_wait: null` open clients would keep a strip that no longer exists on the server, and the button in
        // it would run into a 404.
        try { clearAwayRunRow(chat.id); } catch {}
        scheduleError = `Exit ${res.code}: ${String(res.stderr || "").trim().split("\n").filter(Boolean).pop() || "(no stderr)"}`.slice(0, 300);
        sse(chat.id, { type: "harness", subtype: "run_error", code: res.code, stderr: (res.stderr || "").slice(-2000) || "(no stderr)" });
        fireHooks("afterRunFailed", { chat, code: res.code, aborted: false });
      }
    }
  } catch (e) {
    scheduleError = scheduleError || String(e?.message || e).slice(0, 300);
    // A continuation that throws here clears its run row like an error without a limit — otherwise it would stand 6 h
    // ahead (fireAutoContinueInner), the chat would count as parked that long, every message only queued.
    if (resumption && !scheduleParked) { try { clearAwayRunRow(chat.id); } catch {} }
    throw e;
  } finally {
    let queuedFollowup = null;
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    clearAgentTick(); // the agent bar's tick belongs to this run
    backgroundUnregister?.();
    clearWakeupTimer(); // the run is over — a wakeup still set would have no stdin any more
    try { providerMonitorController?.close(); } catch {}
    // Subagents die WITH the run: their events would otherwise have no stream any more, and a process running on
    // would consume tokens nobody sees.
    // If the run kind does NOT hold (runs/hooks.js `hold`), live agents stay in the owner and run to their end —
    // except the FOREGROUND agents of a stopped turn (`/stop`: like Esc in Claude Code).
    if (runAborted && !holdAgents) { try { agentController?.stopForeground(); } catch {} }
    closeAgents(chat.id, agentController, { leaveAlive: !holdAgents });
    // Agents surviving the turn: the clients keep them beyond `run_done` — after a stop or error that emptied their
    // state, they get it back here. Without survivors no event (golden).
    // The same for the chat's monitors: they survive every outcome of the turn — and for its wakeup.
    if (liveRows(chat.id).length || liveMonitors(chat.id).length || wakeupOf(chat.id)) reportBackground(chat.id);
    // On a recursive resume retry the new run may already have entered its controller — only remove the own instance.
    if (runMonitorControllers.get(chat.id) === providerMonitorController) runMonitorControllers.delete(chat.id);
    if (waitPhaseYield && runWaitPhaseYield.get(chat.id) === waitPhaseYield) runWaitPhaseYield.delete(chat.id);
    // On the resume retry `running` and `runOverruled` belong to the recursive call (it has long re-entered them —
    // this finally runs as soon as the call STARTS, not when it ends). An unconditional delete would take the
    // re-entry lock from the retry: it would run without `running`, and a second message would start a second run
    // next to it.
    // The check at the turn's beginning (recreate, runs/instance.js turnCheckOpen) belongs to the turn — it ends only
    // after it (docker calls, at most two caps). Only with an instance; without one there is no promise and no await
    // (golden byte-identical).
    if (!handedOff) { const check = turnCheckOpen(chat.id); if (check) await check; }
    if (!handedOff) {
      running.delete(chat.id);
      releaseTurn(chat.id);
      runOverruled.delete(chat.id);
      turnPast(chat.id);
      runToolset.delete(chat.id);
      runCompacted.delete(chat.id);
      runCause.delete(chat.id);
    }
    // The same for the run maps: the retry runs SYNCHRONOUSLY up to `await runChat` and runChatClaude calls onSpawn
    // synchronously — so its child was already in `runChildren` when this finally deleted it. The microtask at the
    // result then found no child, stdin stayed open, and the turn after a lost resume hung forever. On the retry ITS
    // finally cleans up.
    if (!handedOff) {
      runChildren.delete(chat.id);
      abortedRuns.delete(chat.id);
      runWaiting.delete(chat.id);
      runBackground.delete(chat.id);
      runContext.delete(chat.id);
      runStreamText.delete(chat.id);
    }
    clearChatPermissions(chat.id, "Run ended"); // release open permission requests (decline)
    userBrowser?.approve?.(); // on the resume retry too — the recursive call holds the browser itself
    // On a resume retry do NOT clean up/send — the recursive doRun call keeps owning the run (including its own
    // active_runs row). Otherwise: delete the run marker (release crash persistence) and send the sidebar status.
    if (!handedOff) {
      airlockExpiry(chat.id); // the run token of the Coding MCP airlock (on the retry the recursive call writes a new one)
      hintsConsumed(hintIds); // exactly those carried; on the retry the recursive call carries them
      if (!atServerEnd) { try { store.clearActiveRun(chat.id); } catch {} }
      // Mirror the chat browser's logins back into the workspace stock (the browser ended with the run, so the cookie
      // DB is closed) → future chats inherit the sign-in.
      // Not if the turn worked in the chat browser: there was no Playwright profile; the chat browser mirrors its
      // logins itself at its end (browsers.js).
      if (runLocation && !userBrowser?.cdpEndpoint) saveChatLogins({ root: playwrightProfileRoot(runLocation), stock: loginStockRoot(), chatId: chat.id, workspaceId: chat.workspaceId });
      // Hook "beforeRunBroadcast", consumer: the end of a scheduled run — conclude the row, advance the occurrence,
      // notification — BEFORE the broadcast, so the list already sees the final state on refresh. A parked run (limit)
      // has not ended; it is concluded on continuation — whether scheduled run and whether parked, the consumer checks.
      fireHooks("beforeRunBroadcast", { chat, error: scheduleError, resultText: scheduleResult, parked: scheduleParked, cause, aborted: runAborted, inputs });
      // Parked at the limit (waiting row written while the chat still stood in `running`): the row goes to the clients
      // ONLY NOW — for a running chat autoContinueView is silent, so maybeAutoContinue sent `null` above. Without this
      // repetition the strip would be invisible until the next reload. The same for a compact or judge row that
      // SURVIVED the turn: it was invisible for the turn's duration and must be shown again now.
      const stays = store.getPendingResume(chat.id);
      if (stays) emitAutoContinue(chat.id, stays);
      // The chat is read FRESH: `chat` is from the run's beginning, and a run of over six minutes may long have
      // outdated the notification choice.
      const chatNow = (() => { try { return store.getChat(chat.id); } catch { return null; } })();
      const finishedAllowed = notifications.pushAllowed(
        "finished", chatNow?.notify || {}, notifications.globalDefaults(store.getSetting));
      broadcast({
        type: "run", chatId: chat.id, running: false, answered,
        title: chat.title || T("Answer ready"),
        workspaceId: chat.workspaceId || "", projectId: chat.projectId || "",
        // For the notification: the chat name on top, the kind below, the answer's teaser in the text — whoever
        // switches this kind on wants to know whether it is worth looking.
        category: "finished",
        pushTitle: chat.title || "",
        pushSubtitle: notifications.kindLabel("finished"),
        pushBody: teaser(lastResponse),
        // cbase_ask has already produced a precise notification with the question text. The generic "answer ready"
        // push right after would be the same required attention twice.
        // A scheduled run reports through its own notification (written by the run end); the human's turns in the
        // same chat do not.
        push: !openAskOf(chat.id) && !chat.scheduleRunId && !(chat.jobId && cause === "schedule") && finishedAllowed,
      });
      // The turn completion: an earmarked graph workflow begins NOW — `running` has fallen, the driver starts its
      // first step as a run of its own. The start turn does not count as a step: `workflowRunning` above was false for
      // it (the run only arises here), so the workflow gate did not see it.
      const completion = turnCompletion(chat, { clean: runCleanEnded, aborted: runAborted, parked: scheduleParked });
      // Autocompact, queue, end hook and target gate: the verdict at the end of work (see workEnd). The field
      // `workflowStarted` stands ONLY when it is true — the verdict may be stored (deferVerdict).
      queuedFollowup = workEnd(chat, chatNow, {
        runCleanEnded, lastResponse, error: scheduleError, parked: scheduleParked, runBegin, target,
        ...(completion?.started === true ? { workflowStarted: true } : {}),
      });
    }
    // The same form as at the compaction end and for a discarded waiting row (see there).
    startFollowUpRun(chat.id, queuedFollowup);
  }
}

// ── The verdict at the end of work ──────────────────────────────────────────────────────────────────────────────
// Autocompact: if the context reached the configured threshold, cbase compacts NOW, between two turns — the same for
// every provider, for the summary plus fresh session is the harness's business. The queue stays put meanwhile:
// compactChatContext starts it in its finally itself, and the follow-up turn then sees the summary instead of the
// full history.
// Open background work — ONE question to the ONE query (runs/background.js), asked AFTER closeAgents: if the run kind
// holds the turn (default, special chats, graph chats via the switch "hold"), nothing is ever open here. If
// background work survives the turn (the Coding chat), the turn has ended, the WORK has not: then the two hanging on
// "end of work" do not judge yet — the target gate (it would judge without the report) and the end hook. Compaction
// does not wait (the session afterwards carries the background work as an attachment, runs/after-compaction.js). The
// two run at the end of the turn after which nothing is open any more — usually the one that processed the last
// completion notice.
// The deferred verdict is STORED (deferVerdict): if the background work ends without a later turn (the human stops
// the last agent, orphans after a restart), the owner catches it up — with THIS function (catchUpVerdict), exactly
// once. If a turn begins before that, it lapses (doRun), and that turn's end judges with its own answer.
// `u`: { runCleanEnded, lastResponse, error, parked, runBegin, target: { text, resultText, goalDepth } | null,
// workflowStarted? }. Returns the follow-up run the caller starts (startFollowUpRun), or null.
// `workflowStarted`: the turn completion has just started a graph workflow — then this end does NOT judge:
// compaction, queue, end hooks, verdict deferral and target gate would otherwise run against driveWorkflow (whose
// first step already runs) or judge the start turn. The driver compacts between the nodes itself.
function workEnd(chat, chatNow, u) {
  if (u.workflowStarted) return null;
  const backgroundOpen = backgroundWork(chat.id).length > 0;
  // Compact with open background work too — the session afterwards learns of it from the attachments
  // (runs/after-compaction.js), the completion notice wakes the chat as usual.
  const autoCompact = u.runCleanEnded && autoCompactionDue(chatNow);
  // Normally the queue was emptied at every result within the same run. If the provider ended before that
  // (error/abort/spawn race), rescue the oldest entry as a new run.
  // `controlActive`: the abort came from "steer" — then steering delivers itself, and a rescued entry would run as a
  // second run against it.
  // If a run waiting row stands after this run (it ended parked), "parked is like running" holds: the queue waits
  // behind the continuation, whose finally empties it — an entry started now would only run into the same limit.
  const parkedContinue = store.getPendingResume(chat.id)?.kind === "run";
  // If the graph workflow decides now without a turn (afterRun has just triggered its gate synchronously — state.js
  // workflowDecides), its end starts the queue (auto-continue.js).
  const queuedFollowup = autoCompact || controlActive.has(chat.id) || parkedContinue || workflowDecides.has(chat.id) ? null : takeNextRunInput(chat.id);
  // Event "end" (hook; subscribers channel delivery and outer loop): only real end states. In the middle of a
  // workflow and before a queue follow-up turn starting at once the loop is silent. WHEN "end" is, the run decides,
  // not the subscriber.
  if (!queuedFollowup) {
    const flowNow = store.getWorkflowRun(chat.id);
    if (!store.workflowOpen(flowNow)) {
      // With open background work only what belongs to the TURN: "turnEnd" (the delivery of waiting channel messages
      // to this chat — it is free). What hangs on "end" waits for the turn after which nothing is open any more.
      if (backgroundOpen) fireHooks("turnEnd", { chat });
      else fireHooks("end", { chat, lastResponse: u.lastResponse, error: u.error, parked: u.parked, durationS: Math.max(1, Math.round((Date.now() - u.runBegin) / 1000)) });
    }
    // Deferred: store what the verdict needs — a follow-up turn from the queue judges itself.
    if (backgroundOpen) {
      try { store.deferVerdict(chat.id, u); } catch (e) { console.error("[work-end] verdict not stored:", chat.id, e?.message || e); }
    }
  }
  const targetGate = u.target ? () => goalGateAfterRun(chat, u.target.text, u.target.resultText, u.target.goalDepth) : null;
  if (autoCompact) {
    // The target gate only AFTERWARDS: its continuation should see the fresh session with the summary, not the old
    // one next to the running compaction. A failed compaction does not stop the gate — the target is independent of it.
    compactChatContext(chatNow, { auto: true, percent: autocompactPercent(chatNow) })
      .catch((e) => console.error("[autocompact]", chat.id, e?.message || e))
      .then(() => { if (!backgroundOpen) targetGate?.(); });
  } else if (!backgroundOpen) {
    targetGate?.();
  }
  return queuedFollowup;
}

/**
 * Catch up a chat's deferred verdict — called by the subagents' owner (runs/agents.js, via setWithoutTurn) when the
 * chat's background work becomes empty WITHOUT a turn, and by the restart after the orphans. Only if nothing is open
 * any more, no turn runs or compacts and none is pending: otherwise that one's end judges. The verdict is TAKEN (read
 * and deleted in one go) — a second call finds none.
 * @returns {boolean} whether a verdict was caught up
 */
function catchUpVerdict(chatId) {
  if (running.has(chatId) || compacting.has(chatId) || pendingRunInputs.get(chatId)?.length) return false;
  if (backgroundWork(chatId).length) return false;
  const u = store.takeVerdict(chatId);
  if (!u) return false;
  const chat = store.getChat(chatId);
  if (!chat) return false;
  console.log(`[work-end] ${chatId}: background work ended without a turn — deferred verdict caught up`);
  startFollowUpRun(chatId, workEnd(chat, chat, u));
  return true;
}

// The worktree of a graph workflow this chat is driving — only while the run is open and the folder exists; otherwise
// null. The row is known to store/graph-starts.js (runs/ stays domain-free).
function activeGraphWorktree(chatId) {
  const wt = store.graphWorktreeFor(chatId);
  return wt?.active && fs.existsSync(wt.path) ? wt : null;
}

// A run's additionally accessible directories (provider-neutral, translated to --add-dir per CLI) — ONE computation
// for the turn and the core without a turn (coreWithoutTurn). `instance`: the turn's; without it the location's.
// Project container: the cwd is the project folder, and no workspace root is on the list (it is not mounted there).
// If the run runs in the backend, the attachment and output folders of an OLD location are added while the move of
// the chat files is deferred (runs/runtime-location.js foreignChatFolder).
function runAddDirs(chat, cwd, focusProj, preparation, location = locationForChat(chat), { instance } = {}) {
  const inst = instance === undefined ? instanceOfChat(chat, location) : instance;
  const list = runAddDirsRaw(chat, cwd, focusProj, preparation, location, { oldLocations: !inst });
  if (!projectInContainer(chat, { instance: inst })) return list;
  const ws = chat.workspaceId ? store.getWorkspace(chat.workspaceId)?.path : null;
  return ws ? list.filter((d) => !pathInside(ws, d)) : list;
}
function runAddDirsRaw(chat, cwd, focusProj, preparation, location, { oldLocations }) {
  const addDirs = [];
  // If the project folder lies outside the workspace, make it accessible in addition.
  if (focusProj && !pathInside(focusProj.path, cwd)) addDirs.push(focusProj.path);
  // The worktree of an open graph workflow run in the FOREGROUND: cwd and session stay, it is added. In the child
  // chat it already is the cwd.
  const runWorktree = activeGraphWorktree(chat.id);
  if (runWorktree && !runWorktree.background && !pathInside(runWorktree.path, cwd)) addDirs.push(runWorktree.path);
  // Make the chat's attachments readable (they lie outside the cwd).
  const chatAttachDir = attachmentLocation(chat, location);
  if (fs.existsSync(chatAttachDir)) addDirs.push(chatAttachDir);
  // The chat's output location (runs/outputs.js): ALWAYS and created before the first agent starts — a subagent's
  // completion notice names a file in it, and the agent it goes to must be able to read it.
  addDirs.push(createOutputLocation(chat.id, location));
  if (oldLocations) addDirs.push(...foreignChatFolder(chat, location));
  return addDirs;
}

// The context of the subagent core (runs/agents.js openAgents) — ONE form for the turn and the core without a turn.
function agentContext({ chat, cwd, providerId, agentDefsRaw, preparation, addDirs, extraServers, runSkills, hold, booking, overruled, runtime = null, instance }) {
  const { toolset, builtinTools, permissionMode } = preparation;
  return {
    chat, cwd, provider: providerId, agentDefs: agentDefsRaw, depth: 1,
    profile: { permissionMode, addDirs, builtinTools },
    // Without a cut (`cbase: null`) and without external servers of the run kind.
    tools: { toolset, cbase: null, extraServers, extern: [], mcpAllow: [], skills: runSkills },
    // Limit parking per agent: the agent parks ITSELF, with the same connections as the run.
    limit: { window: limitWindowsFor, autoContinueOn: autoContinueEnabled },
    // Lifetime: does this turn hold its agents? If not, every report not picked up goes as a completion notice over
    // the chat's ONE wake path (cause "agent") — even if this turn is already over then. The path starts a turn only
    // via startRun (safety net).
    hold,
    deliver: (text) => deliverUserPrompt(store.getChat(chat.id) || chat, { prompt: text, display: text, cause: "agent" }),
    booking,
    overruled,
    // The turn's runtime folder — the core remembers it on opening (runs/agents.js); without a turn it computes it
    // itself. Likewise the instance: `undefined` ⇒ the core computes it from its location.
    runtime,
    instance,
  };
}

// A chat's project switch: if files of the chat still lie at another runtime folder, they move to its current one —
// only if no background work of the chat lives any more (it works with the old paths; then the next turn catches up).
// An open core at another location that still knows an agent, even a finished one, counts too
// (agents.js coresElsewhereWithAgents): a continuation would keep writing there. The old absolute paths in the
// history are named by a silent hint. Never throws: half a move is a message, no reason not to drive the turn.
// Which output folders the hint of a deferred move in the container already named (per chat, in memory — after a
// restart it comes at most once twice): otherwise every turn would carry the same lines until the move.
const deferralSaid = new Map();
function runtimeBringAlong(chat, location, { instance = null } = {}) {
  try {
    const r = bringAlongChat(chat, { location, backgroundAlive: () => backgroundWork(chat.id).length > 0 || coresElsewhereWithAgents(chat.id, location) });
    if (!r?.deferred) deferralSaid.delete(chat.id);
    if (!r) return;
    if (r.deferred) {
      console.log(`[runtime-location] ${chat.id}: files still lie under ${r.from.join(", ")} — background work lives, the next turn catches up`);
      // In the project container: the old location is not mounted there — COPY the attachments (they are immutable;
      // the later merge finds equal files), a silent hint names the outputs. In the backend the run reads the old
      // location via --add-dir (runAddDirs, foreignChatFolder).
      if (instance) {
        const k = copyAttachmentsTo(chat, { location });
        for (const f of k.error) console.warn(`[runtime-location] ${chat.id}: attachment not copied — ${f}`);
        const character = k.outputsElsewhere.join("\n");
        if (k.copied.length || deferralSaid.get(chat.id) !== character) {
          const text = deferralHint(k);
          if (text) depositHint(chat.id, text, { source: "project_switch" });
          deferralSaid.set(chat.id, character);
        }
      }
      return;
    }
    for (const f of r.error) console.warn(`[runtime-location] ${chat.id}: not moved — ${f}`);
    const text = relocationHint(r);
    if (text) depositHint(chat.id, text, { source: "project_switch" });
  } catch (e) {
    console.error(`[runtime-location] ${chat.id}: move of the chat files failed:`, e?.message || e);
  }
}

/**
 * A subagent core WITHOUT a turn: the restart picks up a parked agent from the records in it (runs/agents.js
 * reportOrphaned → pickUpParked). The same context as in the turn (agentContext, runAddDirs), computed from the chat
 * row and its run kind; does not hold (there is no turn that could wait) — its report goes as a completion notice
 * over the chat's wake path. Called via setWithoutTurn. null ⇒ the chat does not exist.
 */
function coreWithoutTurn(chatId) {
  const context = agentContextWithoutTurn(chatId);
  if (!context) return null;
  const ctl = openAgents(context, { event: () => {} });
  ctl.releaseFromTurn();
  return ctl;
}

/**
 * The context of a subagent core WITHOUT a turn, computed from the chat row and its run kind — the same as in the
 * turn (agentContext, runAddDirs). For coreWithoutTurn and for the agents of a dynamic workflow (the domain opens its
 * own core with it, `openAgents(…, { own: true })`). null ⇒ the chat does not exist.
 */
function agentContextWithoutTurn(chatId, { identifier } = {}) {
  let chat = store.getChat(chatId);
  if (!chat) return null;
  // The core's instance — the chat's NOW, or (`identifier`: a dynamic workflow pins it at the start) the named one; a
  // named copy that no longer exists throws. `null` as the identifier = no instance.
  const runLocation = locationForChat(chat);
  let instance;
  if (identifier === undefined) instance = instanceOfChat(chat, runLocation);
  else if (identifier === null) instance = null;
  else if (!(instance = instanceFromIdentifier(identifier))) throw new Error(T`The instance ${identifier} of this workflow no longer exists — no start in the main instance`);
  const cwd = resolveCwd(chat, { instance });
  const runKind = runKindFor(chat);
  const preparation = runKind ? runKind.provider(chat, { cause: "agent" }) : runKindDefault(chat);
  chat = preparation.chat;
  const focusProj = focusedProject(chat);
  let agentDefsRaw = [];
  try { agentDefsRaw = store.effectiveAgents(chat.workspaceId, focusProj?.id ?? null); } catch { /* as in the turn: optional */ }
  return agentContext({
    chat, cwd, providerId: providerForChat(chat), agentDefsRaw, preparation,
    addDirs: runAddDirs(chat, cwd, focusProj, preparation, runLocation, { instance }),
    extraServers: store.effectiveMcpServers(chat.workspaceId, focusProj?.id ?? null),
    runSkills: chatSkills(chat), hold: false, booking: { chatId: chat.id }, overruled: false, instance,
  });
}

// Start a run WITHOUT waiting for it — the one form for all places doing that (queue, steering, follow-up run,
// restart, waiting row). `doRun` is a promise, and a rejected promise without a catch ends the PROCESS: a preparation
// that throws would take the whole server down and every OTHER chat's running turn with it.
// The catch turns it into what an exit ≠ 0 is here too: an error row in THIS chat. Without `code` — a preparation
// that throws has no exit code, and all histories render `evt.code ?? "?"`. doRun has already cleaned up (running,
// active_run, broadcast) — in the finally, and for a throw in the gate BEFORE the try its catch; here only the word to
// the user is missing.
function startRun(chat, text, opts = {}) {
  return doRun(chat, text, opts).catch((e) => {
    const reason = String(e?.message || e || "").trim().slice(0, 2000) || "(no message)";
    console.error("[run] run", chat?.id, "failed:", reason);
    try { sse(chat.id, { type: "harness", subtype: "run_error", stderr: reason }); } catch {}
    // Surviving background agents: the finally reported them again BEFORE this error, and `run_error` empties the
    // whole background state in both clients — without the second report HERE live agents would be invisible until
    // their end. The same order as for exit ≠ 0 in the try: first the error, then the survivors.
    try { if (liveRows(chat.id).length) reportBackground(chat.id); } catch {}
    return null;
  });
}

export { agentContextWithoutTurn, doRun, coreWithoutTurn, startRun, catchUpVerdict };
